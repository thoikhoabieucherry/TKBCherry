"""Apply the Agent memory ceiling before entering the normal stdio solver."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path


def _memory_limit_bytes() -> int:
    try:
        memory_mb = int(os.environ.get("TKB_SOLVER_MAX_MEMORY_MB", "0"))
    except (TypeError, ValueError, OverflowError):
        return 0
    if memory_mb < 512:
        return 0
    return memory_mb * 1024 * 1024


def _apply_memory_limit() -> None:
    limit = _memory_limit_bytes()
    if not limit:
        return
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def main() -> None:
    _apply_memory_limit()
    run_id = os.environ.get("TKB_AGENT_SOLVER_RUN_ID", "")
    if len(run_id) != 32 or any(character not in "0123456789abcdef" for character in run_id):
        raise SystemExit("WSL solver run id is invalid")
    try:
        timeout = max(1, int(os.environ.get("TKB_SOLVER_HARD_TIMEOUT_SECONDS", "1")))
    except (TypeError, ValueError, OverflowError):
        timeout = 1
    solver = Path(__file__).with_name("solve_stdio.pyc")
    if not solver.is_file():
        solver = solver.with_suffix(".py")
    if not solver.is_file():
        raise SystemExit("WSL solver entry point is missing")
    try:
        os.setsid()
    except PermissionError:
        # A direct ``wsl --exec`` child can already be its own session leader.
        if os.getpgrp() != os.getpid():
            raise
    pid_file = Path("/tmp") / f"tkb-agent-solver-{run_id}.pid"
    pid_file.write_text(str(os.getpid()), encoding="ascii")
    pid_file.chmod(0o600)
    process: subprocess.Popen[bytes] | None = None

    def stop_child(_signum: int, _frame: object) -> None:
        if process is not None and process.poll() is None:
            process.terminate()

    signal.signal(signal.SIGTERM, stop_child)
    signal.signal(signal.SIGINT, stop_child)
    try:
        process = subprocess.Popen(
            [sys.executable, str(solver), *sys.argv[1:]],
            stdin=sys.stdin.buffer,
            stdout=sys.stdout.buffer,
            stderr=sys.stderr.buffer,
            close_fds=True,
        )
        try:
            return_code = process.wait(timeout=timeout + 5)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            return_code = 124
        raise SystemExit(return_code)
    finally:
        try:
            pid_file.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
