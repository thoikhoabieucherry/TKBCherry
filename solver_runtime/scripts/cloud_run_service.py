#!/usr/bin/env python3
"""Cloud Run HTTP wrapper around the unchanged TKBCherry stdio solver."""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
from typing import Final


CLOUD_PROTOCOL: Final = "tkb-cloud-solver-v1"
RESULT_PREFIX: Final = "@@TKB_RESULT@@"
PROGRESS_PREFIX: Final = "@@TKB_PROGRESS@@"
HEARTBEAT_PREFIX: Final = "@@TKB_CLOUD_HEARTBEAT@@"
MAX_REQUEST_BYTES: Final = 64 * 1024 * 1024
MAX_STDERR_BYTES: Final = 256 * 1024
DIGEST_RE: Final = re.compile(r"^[0-9a-f]{64}$")
STOP_PROBE_TOKEN_RE: Final = re.compile(r"^[0-9a-f]{64}$")
STOP_PROBE_PATH: Final = "/api/internal/solver-stop-probe"
STOP_PROBE_WAIT_MS: Final = 2_000
STOP_PROBE_HTTP_TIMEOUT_SECONDS: Final = 4.0
CLOUD_RUN_SOLVER_TIMEOUT_CAP_SECONDS: Final = 285


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)).strip())
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "1" if default else "0")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _stop_probe_config(headers) -> dict[str, str] | None:
    job_id = str(headers.get("X-TKB-Stop-Probe-Job", "") or "").strip()
    probe_url = str(headers.get("X-TKB-Stop-Probe-Url", "") or "").strip()
    token = str(headers.get("X-TKB-Stop-Probe-Token", "") or "").strip().lower()
    configured = [bool(job_id), bool(probe_url), bool(token)]
    if not any(configured):
        return None
    if not all(configured):
        raise ValueError("stop_probe_configuration_incomplete")
    if len(job_id) > 512 or any(ord(char) < 32 or ord(char) == 127 for char in job_id):
        raise ValueError("stop_probe_job_invalid")
    if not STOP_PROBE_TOKEN_RE.fullmatch(token):
        raise ValueError("stop_probe_token_invalid")

    parsed = urllib.parse.urlsplit(probe_url)
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("stop_probe_url_invalid") from error
    production_https = (
        parsed.scheme == "https"
        and parsed.hostname == "tkbcherry.com"
        and port in {None, 443}
    )
    local_http = (
        _env_flag("TKB_CLOUD_STOP_PROBE_ALLOW_LOCAL_HTTP")
        and parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    )
    if (
        not (production_https or local_http)
        or parsed.username
        or parsed.password
        or parsed.path.rstrip("/") != STOP_PROBE_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("stop_probe_url_not_allowed")
    return {"jobId": job_id, "url": probe_url, "token": token}


def _signal_solver_stop(stop_file: Path) -> None:
    temporary = stop_file.with_suffix(".tmp")
    temporary.write_text("stop\n", encoding="utf-8")
    os.replace(temporary, stop_file)


def _poll_stop_probe(
    config: dict[str, str], stop_file: Path, finished: threading.Event
) -> None:
    body = json.dumps(
        {
            "jobId": config["jobId"],
            "token": config["token"],
            "waitMs": STOP_PROBE_WAIT_MS,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    while not finished.is_set():
        request = urllib.request.Request(
            config["url"],
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=STOP_PROBE_HTTP_TIMEOUT_SECONDS
            ) as response:
                raw = response.read(16 * 1024 + 1)
            if len(raw) > 16 * 1024:
                return
            payload = json.loads(raw)
        except urllib.error.HTTPError as error:
            if error.code in {401, 403, 404, 410}:
                return
            if finished.wait(0.25):
                return
            continue
        except (OSError, ValueError, json.JSONDecodeError):
            if finished.wait(0.25):
                return
            continue
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            if finished.wait(0.25):
                return
            continue
        if payload.get("stopRequested") is True:
            try:
                _signal_solver_stop(stop_file)
            except OSError:
                pass
            return
        if payload.get("known") is False or payload.get("cancelRequested") is True:
            return


def _solver_script() -> Path:
    configured = os.environ.get("TKB_REFERENCE_SOLVER_SCRIPT", "").strip()
    if configured:
        path = Path(configured)
    else:
        path = Path(__file__).resolve().with_name("solve_stdio.py")
    if not path.is_file():
        raise RuntimeError("solve_stdio.py is missing from the Cloud Run image")
    return path


def _request_timeout_seconds(request: dict) -> float:
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    raw_ms = settings.get("reference_watchdog_deadline_ms") or settings.get(
        "backend_deadline_ms"
    )
    try:
        requested = float(raw_ms) / 1000.0
    except (TypeError, ValueError):
        requested = 180.0
    maximum = _env_int(
        "TKB_CLOUD_RUN_MAX_SOLVE_SECONDS",
        CLOUD_RUN_SOLVER_TIMEOUT_CAP_SECONDS,
        30,
        CLOUD_RUN_SOLVER_TIMEOUT_CAP_SECONDS,
    )
    return min(float(maximum), max(1.0, requested + 15.0))


def _request_workers(request: dict) -> int:
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    maximum = _env_int("TKB_CLOUD_RUN_MAX_WORKERS", 6, 1, 64)
    try:
        requested = int(settings.get("num_workers") or maximum)
    except (TypeError, ValueError):
        requested = maximum
    return min(maximum, max(1, requested))


def _solver_digest() -> str:
    """Return the build-time solver digest advertised by this revision."""
    value = os.environ.get("TKB_CLOUD_RUN_SOLVER_DIGEST", "").strip().lower()
    return value if DIGEST_RE.fullmatch(value) else "unverified"


def _revision() -> str:
    return os.environ.get("K_REVISION", "local").strip()[:200] or "local"


def _decorate_wrapper(wrapper: dict) -> dict:
    """Attach non-solver provenance to every terminal response."""
    payload = wrapper.get("payload")
    if not isinstance(payload, dict):
        payload = {"ok": False, "kind": "cloud_solver_wrapper_invalid"}
        wrapper["payload"] = payload
    solver = payload.get("solver")
    if not isinstance(solver, dict):
        solver = {}
        payload["solver"] = solver
    runtime = solver.get("runtime_settings")
    if not isinstance(runtime, dict):
        runtime = {}
        solver["runtime_settings"] = runtime
    solver["backend"] = "google-cloud-run"
    runtime.update(
        {
            "cloud_protocol": CLOUD_PROTOCOL,
            "cloud_solver_digest": _solver_digest(),
            "cloud_revision": _revision(),
        }
    )
    return wrapper


def _parse_solver_wrapper(stdout: str) -> dict:
    framed: dict | None = None
    legacy: dict | None = None
    for line in stdout.splitlines():
        stripped = line.strip()
        candidate = stripped
        if stripped.startswith(RESULT_PREFIX):
            candidate = stripped[len(RESULT_PREFIX) :].strip()
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict) or "payload" not in value:
            continue
        if stripped.startswith(RESULT_PREFIX):
            framed = value
        else:
            legacy = value
    wrapper = framed or legacy
    if not wrapper:
        raise RuntimeError("reference solver did not emit a terminal wrapper")
    return wrapper


def _error_wrapper(status: int, kind: str, detail: str) -> dict:
    return {
        "status": status,
        "payload": {
            "ok": False,
            "kind": kind,
            "error": kind,
            "detail": detail[-1000:],
            "solver": {
                "backend": "google-cloud-run",
                "runtime_settings": {"phase": kind},
            },
        },
    }


class CloudSolverHandler(BaseHTTPRequestHandler):
    server_version = "TKBCherryCloudSolver/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args) -> None:
        if os.environ.get("TKB_CLOUD_RUN_QUIET", "1").strip() not in {"1", "true"}:
            super().log_message(_format, *_args)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cloud_headers()
        self.end_headers()
        self.wfile.write(body)

    def _cloud_headers(self) -> None:
        self.send_header("X-TKB-Cloud-Protocol", CLOUD_PROTOCOL)
        self.send_header("X-TKB-Solver-Digest", _solver_digest())
        self.send_header("X-TKB-Solver-Revision", _revision())

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract.
        if self.path.rstrip("/") == "/health":
            self._json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "protocol": CLOUD_PROTOCOL,
                    "solver": "python-ortools-reference",
                    "solverDigest": _solver_digest(),
                    "revision": _revision(),
                },
            )
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})

    def _stream_line(self, line: str) -> None:
        self.wfile.write(line.encode("utf-8") + b"\n")
        self.wfile.flush()

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract.
        if self.path.rstrip("/") != "/solve":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        if self.headers.get("X-TKB-Cloud-Protocol", "") != CLOUD_PROTOCOL:
            self._json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "cloud_protocol_mismatch"},
            )
            return
        expected_digest = self.headers.get("X-TKB-Expected-Solver-Digest", "").strip().lower()
        if expected_digest and expected_digest != _solver_digest():
            self._json(
                HTTPStatus.CONFLICT,
                {
                    "ok": False,
                    "error": "cloud_solver_digest_mismatch",
                    "expected": expected_digest,
                    "actual": _solver_digest(),
                },
            )
            return
        try:
            stop_probe = _stop_probe_config(self.headers)
        except ValueError as error:
            self._json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": str(error)},
            )
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self._json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"ok": False, "error": "request_size_invalid"},
            )
            return
        body = self.rfile.read(length)
        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_json"})
            return
        if not isinstance(request, dict) or not isinstance(request.get("data"), dict):
            self._json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "solver_request_invalid"},
            )
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cloud_headers()
        self.end_headers()
        self.close_connection = True

        process: subprocess.Popen[bytes] | None = None
        stop_probe_finished = threading.Event()
        stop_probe_thread: threading.Thread | None = None
        stop_probe_directory = ""
        try:
            script = _solver_script()
            workers = _request_workers(request)
            environment = os.environ.copy()
            environment.update(
                {
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONUNBUFFERED": "1",
                    "TKB_SOLVER_MAX_WORKERS": str(workers),
                    "OMP_NUM_THREADS": "1",
                    "OMP_THREAD_LIMIT": "1",
                    "OPENBLAS_NUM_THREADS": "1",
                    "MKL_NUM_THREADS": "1",
                    "NUMEXPR_NUM_THREADS": "1",
                    "VECLIB_MAXIMUM_THREADS": "1",
                    "BLIS_NUM_THREADS": "1",
                }
            )
            if stop_probe is not None:
                stop_probe_directory = tempfile.mkdtemp(prefix="tkb-cloud-stop-")
                stop_file = Path(stop_probe_directory) / "stop.flag"
                environment["TKB_SOLVER_STOP_FILE"] = str(stop_file)
            process = subprocess.Popen(
                [sys.executable, str(script), "solve"],
                cwd=str(script.parent.parent),
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert process.stdin is not None
            assert process.stdout is not None
            assert process.stderr is not None
            process.stdin.write(body)
            process.stdin.close()

            if stop_probe is not None:
                stop_probe_thread = threading.Thread(
                    target=_poll_stop_probe,
                    args=(stop_probe, stop_file, stop_probe_finished),
                    daemon=True,
                )
                stop_probe_thread.start()

            stderr_queue: queue.Queue[bytes | None] = queue.Queue()
            stdout_parts: list[bytes] = []

            def read_stderr() -> None:
                assert process is not None and process.stderr is not None
                for line in iter(process.stderr.readline, b""):
                    stderr_queue.put(line)
                stderr_queue.put(None)

            def read_stdout() -> None:
                assert process is not None and process.stdout is not None
                stdout_parts.append(process.stdout.read())

            stderr_thread = threading.Thread(target=read_stderr, daemon=True)
            stdout_thread = threading.Thread(target=read_stdout, daemon=True)
            stderr_thread.start()
            stdout_thread.start()

            deadline = time.monotonic() + _request_timeout_seconds(request)
            stderr_noise = bytearray()
            stderr_done = False
            last_heartbeat = 0.0
            while process.poll() is None or not stderr_done:
                if time.monotonic() >= deadline:
                    process.kill()
                    process.wait(timeout=10)
                    wrapper = _error_wrapper(
                        504,
                        "cloud_solver_timeout",
                        "Cloud Run solver exceeded its bounded watchdog.",
                    )
                    wrapper = _decorate_wrapper(wrapper)
                    self._stream_line(
                        RESULT_PREFIX
                        + json.dumps(wrapper, ensure_ascii=False, separators=(",", ":"))
                    )
                    return
                try:
                    line = stderr_queue.get(timeout=0.25)
                except queue.Empty:
                    line = b""
                if line is None:
                    stderr_done = True
                elif line:
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if decoded.startswith(PROGRESS_PREFIX):
                        self._stream_line(decoded)
                    elif len(stderr_noise) < MAX_STDERR_BYTES:
                        stderr_noise.extend(line[: MAX_STDERR_BYTES - len(stderr_noise)])
                now = time.monotonic()
                if now - last_heartbeat >= 1.0:
                    self._stream_line(
                        HEARTBEAT_PREFIX
                        + json.dumps({"elapsedMs": int((now + _request_timeout_seconds(request) - deadline) * 1000)})
                    )
                    last_heartbeat = now

            stderr_thread.join(timeout=2)
            stdout_thread.join(timeout=2)
            stdout = b"".join(stdout_parts).decode("utf-8", errors="replace")
            if process.returncode != 0:
                wrapper = _error_wrapper(
                    500,
                    "cloud_solver_process_failed",
                    stderr_noise.decode("utf-8", errors="replace"),
                )
            else:
                try:
                    wrapper = _parse_solver_wrapper(stdout)
                except Exception as error:  # noqa: BLE001
                    wrapper = _error_wrapper(500, "cloud_solver_wrapper_invalid", str(error))
            wrapper = _decorate_wrapper(wrapper)
            self._stream_line(
                RESULT_PREFIX
                + json.dumps(wrapper, ensure_ascii=False, separators=(",", ":"))
            )
        except (BrokenPipeError, ConnectionResetError):
            if process is not None and process.poll() is None:
                process.kill()
        except Exception as error:  # noqa: BLE001
            if process is not None and process.poll() is None:
                process.kill()
            try:
                wrapper = _error_wrapper(500, "cloud_solver_service_failed", str(error))
                wrapper = _decorate_wrapper(wrapper)
                self._stream_line(
                    RESULT_PREFIX
                    + json.dumps(wrapper, ensure_ascii=False, separators=(",", ":"))
                )
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            stop_probe_finished.set()
            if stop_probe_thread is not None:
                stop_probe_thread.join(timeout=STOP_PROBE_HTTP_TIMEOUT_SECONDS + 0.5)
            if process is not None:
                if process.poll() is None:
                    process.kill()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                for pipe in (process.stdin, process.stdout, process.stderr):
                    if pipe is not None and not pipe.closed:
                        pipe.close()
            if stop_probe_directory and (
                stop_probe_thread is None or not stop_probe_thread.is_alive()
            ):
                shutil.rmtree(stop_probe_directory, ignore_errors=True)


def main() -> int:
    port = _env_int("PORT", 8080, 1, 65535)
    server = ThreadingHTTPServer(("0.0.0.0", port), CloudSolverHandler)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
