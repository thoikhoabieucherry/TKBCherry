"""Run the production solver inside WSL when Windows blocks native modules."""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .config import AgentConfig
from .models import Lease
from .solver import HeartbeatCallback, SolverResult, SolverRunner, _WindowsJob


WSL_RUNTIME_ROOT = "/opt/tkbcherry-agent/current"
WSL_RUNTIME_VERSION = "20260724.1"
WSL_RUNTIME_USER = "tkb-agent"
WSL_MANAGED_DISTRIBUTIONS = ("TKBCherryAgent", "TKBCherryAgent-2")
WSL_READY_MARKER = f"{WSL_RUNTIME_ROOT}/READY"
WSL_PYTHON = f"{WSL_RUNTIME_ROOT}/venv/bin/python"
WSL_SOLVER_SCRIPT = f"{WSL_RUNTIME_ROOT}/solver_runtime/scripts/wsl_solve.pyc"
WSL_CANCEL_SCRIPT = f"{WSL_RUNTIME_ROOT}/solver_runtime/scripts/wsl_cancel.pyc"
WSL_ENVIRONMENT_NAMES = (
    "PYTHONIOENCODING",
    "TKB_SOLVER_MAX_WORKERS",
    "TKB_SOLVER_MAX_MEMORY_MB",
    "TKB_SOLVER_HARD_TIMEOUT_SECONDS",
    "TKB_AGENT_SOLVER_RUN_ID",
    "OMP_NUM_THREADS",
    "OMP_THREAD_LIMIT",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "BLIS_NUM_THREADS",
    "TKB_NO_LOGS",
    "TKB_SAVE_SOLVE_ARTIFACTS",
)


RunCommand = Callable[..., subprocess.CompletedProcess[bytes]]


@dataclass(frozen=True, slots=True)
class WslRuntime:
    executable: str
    distribution: str
    user: str = WSL_RUNTIME_USER
    python: str = WSL_PYTHON
    solver_script: str = WSL_SOLVER_SCRIPT

    def command(self) -> list[str]:
        return [
            self.executable,
            "--distribution",
            self.distribution,
            "--user",
            self.user,
            "--exec",
            self.python,
            self.solver_script,
            "solve",
        ]


def _hidden_creation_flags() -> int:
    if os.name != "nt":
        return 0
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _decode_wsl_output(raw: bytes) -> str:
    if not raw:
        return ""
    # Windows PowerShell and older WSL releases can expose UTF-16LE here,
    # while current Store releases normally emit UTF-8.
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in raw:
        try:
            return raw.decode("utf-16")
        except UnicodeError:
            return raw.decode("utf-16-le", errors="replace")
    return raw.decode("utf-8", errors="replace")


def parse_wsl_distributions(raw: bytes) -> list[str]:
    names: list[str] = []
    for line in _decode_wsl_output(raw).replace("\x00", "").splitlines():
        name = line.strip().lstrip("*").strip()
        if name and name not in names:
            names.append(name)
    return names


def wsl_executable() -> str | None:
    discovered = shutil.which("wsl.exe") or shutil.which("wsl")
    if discovered:
        return discovered
    if os.name == "nt":
        candidate = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "wsl.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def _run_probe(
    command: Sequence[str],
    *,
    timeout: float,
    run: RunCommand | None,
) -> subprocess.CompletedProcess[bytes] | None:
    if run is None:
        try:
            process = subprocess.Popen(
                list(command),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                creationflags=_hidden_creation_flags(),
            )
        except OSError:
            return None
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_probe_tree(process)
            return None
        return subprocess.CompletedProcess(
            list(command), process.returncode, stdout, stderr
        )
    try:
        return run(
            list(command),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            check=False,
            timeout=timeout,
            creationflags=_hidden_creation_flags(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _terminate_probe_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=3,
                creationflags=_hidden_creation_flags(),
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        pass


def list_wsl_distributions(
    executable: str,
    *,
    timeout: float = 3.0,
    run: RunCommand | None = None,
) -> list[str]:
    completed = _run_probe(
        [executable, "--list", "--quiet"], timeout=timeout, run=run
    )
    if completed is None or completed.returncode != 0:
        return []
    return parse_wsl_distributions(completed.stdout)


def _distribution_candidates(
    installed: Sequence[str], preferred: str | None
) -> list[str]:
    lookup = {name.casefold(): name for name in installed}
    requested = (preferred or os.environ.get("TKB_AGENT_WSL_DISTRO", "")).strip()
    ordered: list[str] = []
    if requested and requested.casefold() in lookup:
        ordered.append(lookup[requested.casefold()])
    for name in (*WSL_MANAGED_DISTRIBUTIONS, "Ubuntu-24.04", "Ubuntu", "Debian"):
        actual = lookup.get(name.casefold())
        if actual and actual not in ordered:
            ordered.append(actual)
    return ordered


def discover_wsl_runtime(
    *,
    preferred_distribution: str | None = None,
    timeout: float = 3.0,
    executable: str | None = None,
    expected_version: str = WSL_RUNTIME_VERSION,
    run: RunCommand | None = None,
) -> WslRuntime | None:
    wsl = executable or wsl_executable()
    if not wsl:
        return None
    installed = list_wsl_distributions(wsl, timeout=timeout, run=run)
    for distribution in _distribution_candidates(installed, preferred_distribution):
        runtime = WslRuntime(wsl, distribution)
        completed = _run_probe(
            [
                wsl,
                "--distribution",
                distribution,
                "--user",
                runtime.user,
                "--exec",
                "cat",
                WSL_READY_MARKER,
            ],
            timeout=timeout,
            run=run,
        )
        if (
            completed is not None
            and completed.returncode == 0
            and _decode_wsl_output(completed.stdout).strip() == expected_version
        ):
            return runtime
    return None


class WslSolverRunner(SolverRunner):
    """Use the existing bounded solver protocol through a WSL child process."""

    def __init__(self, config: AgentConfig, runtime: WslRuntime) -> None:
        self.runtime = runtime
        self._run_context = threading.local()
        # The Linux command uses absolute paths. The Windows cwd only needs to
        # be a stable existing directory for subprocess.Popen.
        windows_cwd = Path(sys.executable).resolve().parent
        super().__init__(config, command=runtime.command(), cwd=windows_cwd)

    def _solver_environment(
        self,
        cpu_workers: int,
        memory_limit_mb: int | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, str]:
        environment = super()._solver_environment(
            cpu_workers, memory_limit_mb, timeout_seconds
        )
        run_id = getattr(self._run_context, "run_id", "")
        if run_id:
            environment["TKB_AGENT_SOLVER_RUN_ID"] = run_id
        inherited = [
            item
            for item in environment.get("WSLENV", "").split(":")
            if item and item.split("/", 1)[0] not in WSL_ENVIRONMENT_NAMES
        ]
        environment["WSLENV"] = ":".join([*inherited, *WSL_ENVIRONMENT_NAMES])
        return environment

    def run(
        self,
        lease: Lease,
        *,
        heartbeat: HeartbeatCallback,
        stop_event: threading.Event,
    ) -> SolverResult:
        self._run_context.run_id = secrets.token_hex(16)
        try:
            return super().run(
                lease, heartbeat=heartbeat, stop_event=stop_event
            )
        finally:
            self._run_context.run_id = ""

    def _terminate_child(
        self, process: subprocess.Popen[bytes], job: _WindowsJob
    ) -> None:
        run_id = getattr(self._run_context, "run_id", "")
        if run_id:
            command = [
                self.runtime.executable,
                "--distribution",
                self.runtime.distribution,
                "--user",
                self.runtime.user,
                "--exec",
                self.runtime.python,
                WSL_CANCEL_SCRIPT,
                run_id,
            ]
            try:
                subprocess.run(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    shell=False,
                    check=False,
                    timeout=3,
                    creationflags=_hidden_creation_flags(),
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        super()._terminate_child(process, job)
