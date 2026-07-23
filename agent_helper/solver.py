"""Bounded, cancellable subprocess runner for ``solver_runtime``."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from . import SOLVER_PROTOCOL
from .api import canonical_json_bytes
from .config import AgentConfig
from .models import Lease


HeartbeatCallback = Callable[[float, float], bool]


def _positive_int_value(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return parsed if parsed > 0 else 0


def _expected_period_count(request: Mapping[str, Any]) -> int:
    settings = request.get("settings")
    if isinstance(settings, Mapping):
        expected = _positive_int_value(settings.get("expected_scheduled_periods"))
        if expected:
            return expected
    data = request.get("data")
    if isinstance(data, Mapping):
        result = data.get("tkbSolverResult")
        if isinstance(result, Mapping):
            metrics = result.get("metrics")
            if isinstance(metrics, Mapping):
                return _positive_int_value(metrics.get("expected_periods"))
    return 0


def _recommended_cpu_workers(request: Mapping[str, Any]) -> int:
    expected = _expected_period_count(request)
    settings = request.get("settings")
    solve_kind = ""
    if isinstance(settings, Mapping):
        solve_kind = str(settings.get("ui_unified_solve_kind") or "").strip().casefold()
    if expected and expected <= 600:
        return 2
    if solve_kind == "refine_complete":
        # Complete refinement is the expensive quality lane.  It is the
        # Agent's exclusive executor, so reserve the same six-worker search
        # width used by the VPS for production-sized timetables instead of
        # spending the whole watchdog on a three-worker slice.
        return 6
    if not expected or expected <= 2_400:
        return 4
    return 6


def _effective_cpu_workers(request: Mapping[str, Any], permitted: int) -> int:
    ceiling = max(1, int(permitted))
    settings = request.get("settings")
    requested = 0
    if isinstance(settings, Mapping):
        requested = _positive_int_value(settings.get("num_workers"))
    if requested <= 0:
        requested = ceiling
    return max(1, min(ceiling, requested, _recommended_cpu_workers(request)))


def _effective_memory_limit_mb(request: Mapping[str, Any], permitted_mb: int) -> int:
    expected = _expected_period_count(request)
    if expected and expected <= 600:
        recommended_mb = 4 * 1024
    elif not expected or expected <= 2_400:
        recommended_mb = 8 * 1024
    else:
        recommended_mb = 16 * 1024
    return max(512, min(max(512, int(permitted_mb)), recommended_mb))


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


class SolverInfrastructureError(RuntimeError):
    """The solver process or its stdio protocol failed."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class SolverCancelled(SolverInfrastructureError):
    def __init__(self, message: str = "Solver was cancelled") -> None:
        super().__init__("solver_cancelled", message)


class SolverTimedOut(SolverInfrastructureError):
    def __init__(self, message: str = "Solver exceeded its allowed runtime") -> None:
        super().__init__("solver_timeout", message)


@dataclass(frozen=True, slots=True)
class SolverResult:
    protocol: str
    status: int
    payload: dict[str, Any]


def _sha256_stream(stream: Any) -> str:
    digest = hashlib.sha256()
    stream.flush()
    stream.seek(0)
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


class _AnonymousFiles:
    """Delete-on-close disk buffers; OS cleanup also applies after a hard crash."""

    def __init__(self, request: bytes) -> None:
        self.input = tempfile.TemporaryFile(mode="w+b")
        self.output = tempfile.TemporaryFile(mode="w+b")
        self.error = tempfile.TemporaryFile(mode="w+b")
        self.input.write(request)
        self.input.flush()
        self.input.seek(0)

    def close(self) -> None:
        for name in ("input", "output", "error"):
            handle = getattr(self, name, None)
            if handle is None:
                continue
            try:
                handle.close()
            except OSError:
                pass

    def __del__(self) -> None:
        self.close()


class _BoundedStreamDrainer:
    """Drain a child pipe continuously while writing at most ``limit`` bytes."""

    def __init__(self, stream: Any, sink: Any, limit: int) -> None:
        self.stream = stream
        self.sink = sink
        self.limit = limit
        self.exceeded = threading.Event()
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._drain, daemon=True)

    def _drain(self) -> None:
        written = 0
        try:
            while True:
                chunk = self.stream.read(64 * 1024)
                if not chunk:
                    break
                remaining = max(0, self.limit - written)
                if len(chunk) > remaining:
                    self.exceeded.set()
                if remaining:
                    kept = chunk[:remaining]
                    self.sink.write(kept)
                    written += len(kept)
            self.sink.flush()
        except BaseException as exc:  # Keep failure for the controlling thread.
            self.error = exc
        finally:
            try:
                self.stream.close()
            except OSError:
                pass

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: float = 5.0) -> None:
        self._thread.join(timeout)
        if self._thread.is_alive():
            try:
                self.stream.close()
            except OSError:
                pass
            self._thread.join(1.0)
        if self._thread.is_alive():
            raise SolverInfrastructureError(
                "solver_pipe_stuck", "A solver output pipe did not close"
            )
        if self.error is not None:
            raise SolverInfrastructureError(
                "solver_pipe_failed", "A solver output pipe could not be drained"
            ) from self.error


class _WindowsJob:
    """Assign a suspended Windows child before it can spawn descendants."""

    def __init__(
        self, process: subprocess.Popen[bytes], memory_limit_bytes: int
    ) -> None:
        self._handle: int | None = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = ctypes.c_long

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise SolverInfrastructureError(
                "windows_job_failed", "Could not create the Windows solver job"
            )
        information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        information.BasicLimitInformation.LimitFlags = (
            0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | 0x00000200  # JOB_OBJECT_LIMIT_JOB_MEMORY
        )
        information.JobMemoryLimit = memory_limit_bytes
        if not kernel32.SetInformationJobObject(
            job,
            9,  # JobObjectExtendedLimitInformation
            ctypes.byref(information),
            ctypes.sizeof(information),
        ):
            kernel32.CloseHandle(job)
            raise SolverInfrastructureError(
                "windows_job_failed", "Could not secure the Windows solver job"
            )
        process_handle = wintypes.HANDLE(int(process._handle))  # type: ignore[attr-defined]
        if not kernel32.AssignProcessToJobObject(job, process_handle):
            kernel32.CloseHandle(job)
            raise SolverInfrastructureError(
                "windows_job_failed", "Could not contain the Windows solver process"
            )
        self._handle = int(job)
        self._close_handle = kernel32.CloseHandle
        self._resume_process = ntdll.NtResumeProcess
        self._wintypes = wintypes
        self._process_handle = process_handle

    @property
    def assigned(self) -> bool:
        return self._handle is not None

    def resume(self) -> None:
        if os.name != "nt":
            return
        if self._handle is None or self._resume_process(self._process_handle) < 0:
            self.close()
            raise SolverInfrastructureError(
                "windows_job_failed", "Could not resume the contained solver process"
            )

    def close(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        self._close_handle(self._wintypes.HANDLE(handle))


def _terminate_process_tree(process: subprocess.Popen[bytes], job: _WindowsJob) -> None:
    if process.poll() is not None:
        job.close()
        return
    if os.name == "nt":
        # Nested Windows jobs can allow a solver grandchild to outlive the
        # immediate process even though the parent was assigned successfully.
        # Kill the visible tree while the parent PID still exists, then close
        # the Job Object as the containment backstop.
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        if job.assigned:
            job.close()
        try:
            if process.poll() is None:
                process.terminate()
        except OSError:
            pass
    elif job.assigned:
        job.close()
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                process.terminate()
            except OSError:
                pass
    try:
        process.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass


class SolverRunner:
    def __init__(
        self,
        config: AgentConfig,
        *,
        command: Sequence[str] | None = None,
        cwd: str | os.PathLike[str] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self._command_override = list(command) if command is not None else None
        self._cwd_override = Path(cwd).resolve() if cwd is not None else None
        self._monotonic = monotonic
        self.heartbeat_seconds = float(config.heartbeat_seconds)

    @staticmethod
    def source_runtime_root() -> Path:
        return Path(__file__).resolve().parents[1] / "solver_runtime"

    @staticmethod
    def bundled_runtime_root() -> Path:
        bundle_root = Path(
            getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent)
        )
        return bundle_root / "solver_runtime"

    def _command_and_cwd(self) -> tuple[list[str], Path]:
        if self._command_override is not None:
            return list(self._command_override), self._cwd_override or Path.cwd()
        if getattr(sys, "frozen", False):
            return [sys.executable, "--solver-child"], self.bundled_runtime_root()
        runtime_root = self.source_runtime_root()
        script = runtime_root / "scripts" / "solve_stdio.py"
        if not script.is_file():
            raise SolverInfrastructureError(
                "solver_missing", "Bundled solver entry point is missing"
            )
        return [sys.executable, str(script), "solve"], runtime_root

    @staticmethod
    def _normalized_request(lease: Lease) -> dict[str, Any]:
        try:
            request = json.loads(
                json.dumps(
                    lease.payload,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            )
        except (TypeError, ValueError) as exc:
            raise SolverInfrastructureError(
                "invalid_solver_request", "Solver request is not valid JSON"
            ) from exc
        if not isinstance(request, dict) or not isinstance(request.get("data"), dict):
            raise SolverInfrastructureError(
                "invalid_solver_request", "Solver request.data must be an object"
            )
        settings = request.setdefault("settings", {})
        if not isinstance(settings, dict):
            raise SolverInfrastructureError(
                "invalid_solver_request", "Solver request.settings must be an object"
            )
        settings["num_workers"] = _effective_cpu_workers(
            request, lease.limits.cpu_workers
        )
        return request

    @staticmethod
    def _effective_timeout(request: Mapping[str, Any], lease: Lease) -> float:
        hard_seconds = float(lease.limits.timeout_seconds)
        settings = request.get("settings")
        if isinstance(settings, Mapping):
            watchdog_ms = settings.get("reference_watchdog_deadline_ms")
            if (
                isinstance(watchdog_ms, (int, float))
                and not isinstance(watchdog_ms, bool)
                and watchdog_ms > 0
            ):
                hard_seconds = min(hard_seconds, float(watchdog_ms) / 1000.0)
        return max(0.1, hard_seconds)

    def _solver_environment(
        self,
        cpu_workers: int,
        memory_limit_mb: int | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, str]:
        allowed = {
            "APPDATA",
            "COMSPEC",
            "DYLD_LIBRARY_PATH",
            "HOME",
            "HOMEDRIVE",
            "HOMEPATH",
            "LANG",
            "LC_ALL",
            "LD_LIBRARY_PATH",
            "LOCALAPPDATA",
            "NUMBER_OF_PROCESSORS",
            "PATH",
            "PATHEXT",
            "PROCESSOR_ARCHITECTURE",
            "PROGRAMDATA",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "TMPDIR",
            "TKB_SESSION_CP_SAT_LINEARIZATION_LEVEL",
            "USERPROFILE",
            "WINDIR",
        }
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper() in allowed or key.upper().startswith("_PYI_")
        }
        environment.update(
            {
                "PYTHONIOENCODING": "utf-8",
                "TKB_SOLVER_MAX_WORKERS": str(cpu_workers),
                "TKB_SOLVER_MAX_MEMORY_MB": str(
                    max(512, int(memory_limit_mb or self.config.max_memory_mb))
                ),
                "TKB_SOLVER_HARD_TIMEOUT_SECONDS": str(
                    max(1, int(timeout_seconds or self.config.solver_timeout_seconds))
                ),
                "OMP_NUM_THREADS": "1",
                "OMP_THREAD_LIMIT": "1",
                "OPENBLAS_NUM_THREADS": "1",
                "MKL_NUM_THREADS": "1",
                "NUMEXPR_NUM_THREADS": "1",
                "VECLIB_MAXIMUM_THREADS": "1",
                "BLIS_NUM_THREADS": "1",
                "TKB_NO_LOGS": "1",
                "TKB_SAVE_SOLVE_ARTIFACTS": "0",
            }
        )
        return environment

    def _terminate_child(
        self, process: subprocess.Popen[bytes], job: _WindowsJob
    ) -> None:
        _terminate_process_tree(process, job)

    def run(
        self,
        lease: Lease,
        *,
        heartbeat: HeartbeatCallback,
        stop_event: threading.Event,
    ) -> SolverResult:
        if stop_event.is_set():
            raise SolverCancelled(
                "Agent shutdown was requested before the solver started"
            )
        request = self._normalized_request(lease)
        settings = request.get("settings")
        effective_cpu_workers = (
            int(settings["num_workers"]) if isinstance(settings, Mapping) else 1
        )
        effective_memory_mb = _effective_memory_limit_mb(
            request, self.config.max_memory_mb
        )
        encoded_request = canonical_json_bytes(request)
        if len(encoded_request) > self.config.max_request_bytes:
            raise SolverInfrastructureError(
                "solver_request_too_large", "Solver request exceeded the size limit"
            )
        hard_timeout = self._effective_timeout(request, lease)
        command, cwd = self._command_and_cwd()
        if not cwd.is_dir():
            raise SolverInfrastructureError(
                "solver_missing", "Solver working directory is missing"
            )

        with tempfile.TemporaryDirectory(prefix="tkb-agent-") as temporary:
            del (
                temporary
            )  # Directory remains empty; sensitive buffers are delete-on-close files.
            files = _AnonymousFiles(encoded_request)
            creationflags = 0
            if os.name == "nt":
                creationflags = (
                    getattr(subprocess, "CREATE_NO_WINDOW", 0) | 0x00000004
                )  # CREATE_SUSPENDED
            process: subprocess.Popen[bytes] | None = None
            job: _WindowsJob | None = None
            output_drainer: _BoundedStreamDrainer | None = None
            error_drainer: _BoundedStreamDrainer | None = None
            try:
                with contextlib.nullcontext(files.input) as input_handle:
                    process = subprocess.Popen(
                        command,
                        stdin=input_handle,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        cwd=cwd,
                        env=self._solver_environment(
                            effective_cpu_workers,
                            effective_memory_mb,
                            hard_timeout,
                        ),
                        shell=False,
                        close_fds=True,
                        creationflags=creationflags,
                        start_new_session=os.name != "nt",
                    )
                    job = _WindowsJob(process, effective_memory_mb * 1024 * 1024)
                    if process.stdout is None or process.stderr is None:
                        raise SolverInfrastructureError(
                            "solver_pipe_failed", "Solver output pipes are unavailable"
                        )
                    output_drainer = _BoundedStreamDrainer(
                        process.stdout,
                        files.output,
                        self.config.max_result_bytes,
                    )
                    error_drainer = _BoundedStreamDrainer(
                        process.stderr,
                        files.error,
                        self.config.max_stderr_bytes,
                    )
                    output_drainer.start()
                    error_drainer.start()
                    job.resume()
                    started = self._monotonic()
                    deadline = started + hard_timeout
                    next_heartbeat = started + self.heartbeat_seconds
                    heartbeat_timeout = min(
                        float(self.config.request_timeout_seconds),
                        max(1.0, self.heartbeat_seconds),
                    )

                    def begin_heartbeat(now: float) -> dict[str, Any]:
                        state: dict[str, Any] = {
                            "done": threading.Event(),
                            "error": None,
                            "cancelled": False,
                            "started": now,
                        }

                        def invoke() -> None:
                            try:
                                state["cancelled"] = bool(
                                    heartbeat(
                                        max(0.0, now - started),
                                        max(0.0, deadline - now),
                                    )
                                )
                            except BaseException as exc:
                                state["error"] = exc
                            finally:
                                state["done"].set()

                        threading.Thread(target=invoke, daemon=True).start()
                        return state

                    active_heartbeat: dict[str, Any] | None = begin_heartbeat(started)
                    process_finished_at: float | None = None
                    try:
                        while True:
                            now = self._monotonic()
                            if (
                                process_finished_at is None
                                and process.poll() is not None
                            ):
                                if now > deadline:
                                    raise SolverTimedOut()
                                process_finished_at = now
                            if stop_event.is_set():
                                raise SolverCancelled("Agent shutdown was requested")
                            if output_drainer.exceeded.is_set():
                                raise SolverInfrastructureError(
                                    "solver_result_too_large",
                                    "Solver result exceeded the size limit",
                                )
                            if error_drainer.exceeded.is_set():
                                raise SolverInfrastructureError(
                                    "solver_stderr_too_large",
                                    "Solver diagnostics exceeded the size limit",
                                )
                            if (
                                output_drainer.error is not None
                                or error_drainer.error is not None
                            ):
                                raise SolverInfrastructureError(
                                    "solver_pipe_failed",
                                    "A solver output pipe could not be drained",
                                )
                            if process_finished_at is None and now >= deadline:
                                raise SolverTimedOut()
                            if active_heartbeat is not None:
                                done = active_heartbeat["done"]
                                if done.is_set():
                                    heartbeat_error = active_heartbeat["error"]
                                    if heartbeat_error is not None:
                                        raise SolverInfrastructureError(
                                            "lease_heartbeat_failed",
                                            "The job lease could not be renewed",
                                        ) from heartbeat_error
                                    if active_heartbeat["cancelled"]:
                                        raise SolverCancelled(
                                            "The server cancelled this solver job"
                                        )
                                    active_heartbeat = None
                                    next_heartbeat = now + self.heartbeat_seconds
                                elif (
                                    now - float(active_heartbeat["started"])
                                    >= heartbeat_timeout
                                ):
                                    raise SolverInfrastructureError(
                                        "lease_heartbeat_failed",
                                        "The job lease heartbeat exceeded its deadline",
                                    )
                            if (
                                process_finished_at is not None
                                and active_heartbeat is None
                            ):
                                break
                            if (
                                process_finished_at is None
                                and active_heartbeat is None
                                and now >= next_heartbeat
                            ):
                                active_heartbeat = begin_heartbeat(now)
                            stop_event.wait(0.05)
                        process.wait(timeout=1)
                    except BaseException:
                        self._terminate_child(process, job)
                        raise
                    finally:
                        if process.poll() is None:
                            self._terminate_child(process, job)
                        else:
                            job.close()
                        output_drainer.join()
                        error_drainer.join()
            except SolverInfrastructureError:
                if process is not None and process.poll() is None:
                    if job is not None:
                        self._terminate_child(process, job)
                    else:
                        process.kill()
                        process.wait(timeout=3)
                if output_drainer is not None:
                    output_drainer.join()
                if error_drainer is not None:
                    error_drainer.join()
                raise
            except OSError as exc:
                if process is not None and process.poll() is None:
                    if job is not None:
                        self._terminate_child(process, job)
                    else:
                        process.kill()
                        process.wait(timeout=3)
                if output_drainer is not None:
                    output_drainer.join()
                if error_drainer is not None:
                    error_drainer.join()
                raise SolverInfrastructureError(
                    "solver_start_failed", "The solver process could not be started"
                ) from exc

            assert output_drainer is not None and error_drainer is not None
            if output_drainer.exceeded.is_set():
                raise SolverInfrastructureError(
                    "solver_result_too_large", "Solver result exceeded the size limit"
                )
            if error_drainer.exceeded.is_set():
                raise SolverInfrastructureError(
                    "solver_stderr_too_large",
                    "Solver diagnostics exceeded the size limit",
                )

            files.output.flush()
            files.output.seek(0, os.SEEK_END)
            output_size = files.output.tell()
            if output_size > self.config.max_result_bytes:
                raise SolverInfrastructureError(
                    "solver_result_too_large", "Solver result exceeded the size limit"
                )
            files.output.seek(0)
            output = files.output.read()
            if output.count(b"\n") != 1 or not output.endswith(b"\n"):
                files.error.flush()
                files.error.seek(0, os.SEEK_END)
                stderr_size = files.error.tell()
                stderr_digest = _sha256_stream(files.error) if stderr_size else "none"
                raise SolverInfrastructureError(
                    "solver_protocol_error",
                    f"Solver returned an invalid frame (stderr bytes={stderr_size}, sha256={stderr_digest})",
                )
            line = output[:-1]
            if line.endswith(b"\r"):
                line = line[:-1]
            try:
                wrapper = json.loads(
                    line.decode("utf-8"),
                    parse_constant=_reject_json_constant,
                )
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                raise SolverInfrastructureError(
                    "solver_protocol_error", "Solver returned invalid UTF-8 JSON"
                ) from exc
            if not isinstance(wrapper, dict):
                raise SolverInfrastructureError(
                    "solver_protocol_error", "Solver result wrapper must be an object"
                )
            if wrapper.get("protocol") != SOLVER_PROTOCOL:
                raise SolverInfrastructureError(
                    "solver_protocol_error", "Solver returned an unsupported protocol"
                )
            status = wrapper.get("status")
            if (
                isinstance(status, bool)
                or not isinstance(status, int)
                or status < 100
                or status > 599
            ):
                raise SolverInfrastructureError(
                    "solver_protocol_error", "Solver status must be between 100 and 599"
                )
            payload = wrapper.get("payload")
            if not isinstance(payload, dict):
                raise SolverInfrastructureError(
                    "solver_protocol_error", "Solver payload must be an object"
                )
            try:
                canonical_json_bytes(payload)
            except Exception as exc:
                raise SolverInfrastructureError(
                    "solver_protocol_error",
                    "Solver payload contains invalid JSON values",
                ) from exc
            if process is None or process.returncode != 0:
                raise SolverInfrastructureError(
                    "solver_exit_failed",
                    "Solver exited unsuccessfully despite returning a frame",
                )
            files.close()
            return SolverResult(
                protocol=SOLVER_PROTOCOL, status=status, payload=payload
            )
