"""Cancel exactly one WSL solver process group by its unguessable run id."""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path


def main(arguments: list[str]) -> int:
    if len(arguments) != 1:
        return 2
    run_id = arguments[0]
    if len(run_id) != 32 or any(character not in "0123456789abcdef" for character in run_id):
        return 2
    pid_file = Path("/tmp") / f"tkb-agent-solver-{run_id}.pid"
    try:
        pid = int(pid_file.read_text(encoding="ascii").strip())
    except (FileNotFoundError, OSError, TypeError, ValueError):
        return 0
    if pid <= 1:
        return 2
    try:
        environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except (FileNotFoundError, OSError):
        return 0
    expected = f"TKB_AGENT_SOLVER_RUN_ID={run_id}".encode("ascii")
    if expected not in environment:
        return 3
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return 0
    except (OSError, PermissionError):
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
