"""Command-line entry point for the Windows Agent Helper."""

from __future__ import annotations

import argparse
import io
import logging
import os
import runpy
import signal
import sys
import threading
from pathlib import Path
from typing import Callable, Sequence

from . import VERSION
from .api import ApiClient, ApiError
from .config import AgentConfig, ConfigError
from .models import AgentIdentity, Lease, LeaseLimits, ProtocolError
from .pairing import PairingClient, PairingError
from .solver import SolverInfrastructureError, SolverRunner
from .state import (
    SingleInstanceLock,
    StateError,
    load_agent_token,
    load_or_create_agent_id,
    platform_tag,
    save_agent_token,
)
from .worker import AgentWorker


def _restore_solver_child_stdio() -> bool:
    """Bind redirected Windows handles for a PyInstaller ``--windowed`` child."""

    if os.name != "nt" or all(
        getattr(sys, name, None) is not None for name in ("stdin", "stdout", "stderr")
    ):
        return True
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetStdHandle.argtypes = [wintypes.DWORD]
        kernel32.GetStdHandle.restype = wintypes.HANDLE
        invalid = ctypes.c_void_p(-1).value
        bindings = (
            ("stdin", -10, os.O_RDONLY | os.O_BINARY, "rb"),
            ("stdout", -11, os.O_WRONLY | os.O_BINARY, "wb"),
            ("stderr", -12, os.O_WRONLY | os.O_BINARY, "wb"),
        )
        for name, identifier, flags, mode in bindings:
            if getattr(sys, name, None) is not None:
                continue
            handle = kernel32.GetStdHandle(identifier & 0xFFFFFFFF)
            handle_value = int(handle) if handle else 0
            if not handle_value or handle_value == invalid:
                return False
            descriptor = msvcrt.open_osfhandle(handle_value, flags)
            raw = os.fdopen(descriptor, mode, buffering=0)
            text = io.TextIOWrapper(
                raw,
                encoding="utf-8",
                errors="strict",
                newline="\n",
                write_through=name != "stdin",
            )
            setattr(sys, name, text)
        return True
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def _solver_child_main() -> int:
    if not _restore_solver_child_stdio():
        return 70
    runtime_root = (
        SolverRunner.bundled_runtime_root()
        if getattr(sys, "frozen", False)
        else SolverRunner.source_runtime_root()
    )
    script = runtime_root / "scripts" / "solve_stdio.py"
    if getattr(sys, "frozen", False) and not script.is_file():
        script = script.with_suffix(".pyc")
    if not script.is_file():
        return 70
    os.chdir(runtime_root)
    sys.argv = [str(script), "solve"]
    try:
        runpy.run_path(str(script), run_name="__main__")
    except SystemExit as exc:
        return int(exc.code or 0) if isinstance(exc.code, (int, type(None))) else 1
    return 0


def _gui_smoke_main() -> int:
    """Create a real hidden Tk window to validate the packaged GUI runtime."""

    try:
        import tkinter as tk

        root = tk.Tk()
        try:
            root.withdraw()
            root.update_idletasks()
        finally:
            root.destroy()
        print(f"TKBCherryAgent GUI smoke OK {VERSION}")
        return 0
    except Exception as exc:
        print(f"TKBCherryAgent GUI smoke failed: {exc}", file=sys.stderr)
        return 71


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="TKBCherryAgent",
        description="Outbound-only helper that runs TKBCherry solver jobs.",
    )
    parser.add_argument(
        "--config", type=Path, help="Path to a non-secret JSON config file"
    )
    parser.add_argument(
        "--once", action="store_true", help="Poll at most one job, then exit"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate config, credential and the actual solver import/protocol, then exit",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable additional non-sensitive diagnostics",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument("--solver-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--gui-smoke", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--startup", action="store_true", help=argparse.SUPPRESS)
    return parser


def _install_signal_handlers(stop_event: threading.Event) -> None:
    def request_shutdown(signum: int, frame: object) -> None:
        del signum, frame
        stop_event.set()

    for signal_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        signal_value = getattr(signal, signal_name, None)
        if signal_value is not None:
            try:
                signal.signal(signal_value, request_shutdown)
            except (OSError, ValueError):
                pass


def _probe_solver(solver: SolverRunner, config: AgentConfig) -> int:
    probe = Lease(
        job_id="agent-check",
        lease_id="agent-check",
        attempt=1,
        lease_expires_at=None,
        payload={"data": {}, "settings": {}},
        limits=LeaseLimits(
            cpu_workers=max(1, min(config.cpu_workers, 2)),
            timeout_seconds=min(config.solver_timeout_seconds, 30),
        ),
    )
    result = solver.run(
        probe,
        heartbeat=lambda elapsed, remaining: False,
        stop_event=threading.Event(),
    )
    return result.status


def _load_or_pair_token(
    config: AgentConfig,
    identity: AgentIdentity,
    stop_event: threading.Event,
    status_callback: Callable[[str], None] | None = None,
    *,
    allow_pair: bool = True,
) -> str:
    report = status_callback or (lambda status: None)
    if os.environ.get(config.token_env, "").strip():
        return config.load_token()
    token = load_agent_token()
    if token:
        return token
    if not allow_pair:
        raise ConfigError("Agent is not paired; open TKBCherryAgent.exe normally first")
    report("pairing")
    token = PairingClient(config, identity).pair(stop_event)
    save_agent_token(token)
    logging.getLogger("agent_helper").info(
        "Agent paired successfully; the limited credential is protected for this Windows user."
    )
    return token


def _run_worker_session(
    config: AgentConfig,
    identity: AgentIdentity,
    solver: SolverRunner,
    stop_event: threading.Event,
    status_callback: Callable[[str], None],
) -> None:
    status_callback("starting")
    token = _load_or_pair_token(config, identity, stop_event, status_callback)
    if stop_event.is_set():
        return
    api = ApiClient(config, identity, token=token, stop_event=stop_event)
    worker = AgentWorker(
        api,
        solver,
        stop_event=stop_event,
        status_callback=status_callback,
    )
    worker.run_forever()


def _show_gui_error(message: str) -> None:
    try:
        from tkinter import messagebox

        messagebox.showerror("TKBCherry Agent", message)
    except Exception:
        pass


def main(argv: Sequence[str] | None = None) -> int:
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    headless_flags = {
        "--check",
        "--once",
        "--solver-child",
        "--gui-smoke",
        "--version",
    }
    if any(argument in headless_flags for argument in raw_arguments):
        if not _restore_solver_child_stdio():
            return 70
    arguments = _parser().parse_args(raw_arguments)
    if arguments.solver_child:
        return _solver_child_main()
    if arguments.gui_smoke:
        return _gui_smoke_main()

    gui_mode = not arguments.once and not arguments.check
    if gui_mode:
        logging.basicConfig(
            level=logging.DEBUG if arguments.verbose else logging.INFO,
            handlers=[logging.NullHandler()],
        )
    else:
        logging.basicConfig(
            level=logging.DEBUG if arguments.verbose else logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
    try:
        config = AgentConfig.load(arguments.config)
        agent_id = load_or_create_agent_id()
        identity = AgentIdentity(
            agent_id=agent_id, version=VERSION, platform=platform_tag()
        )
        solver = SolverRunner(config)
        command, cwd = solver._command_and_cwd()
        if not command or not cwd.is_dir():
            raise ConfigError("solver runtime is missing")

        with SingleInstanceLock(agent_id):
            if gui_mode:
                from .gui import run_toggle_window
                from .startup import (
                    StartupRegistrationError,
                    startup_toggle_for_current_process,
                )

                updater = None
                if os.name == "nt" and getattr(sys, "frozen", False):
                    try:
                        from .updater import AgentUpdater, running_from_staged_update

                        updater = AgentUpdater.for_api_base(
                            config.api_base,
                            current_version=VERSION,
                            allow_local_http=config.allow_local_http,
                            timeout_seconds=config.request_timeout_seconds,
                        )
                        updater.cleanup_stale_updates(
                            keep=running_from_staged_update()
                        )
                    except Exception:
                        # Updating is optional. A local cleanup or URL problem
                        # must not prevent the solver Agent from starting.
                        updater = None

                raw_startup_toggle = startup_toggle_for_current_process(gui_mode=True)
                startup_toggle = None
                if raw_startup_toggle is not None:
                    startup_enabled: bool | None = None

                    def update_startup(enabled: bool) -> bool:
                        nonlocal startup_enabled
                        if startup_enabled is enabled:
                            return False
                        try:
                            changed = raw_startup_toggle(enabled)
                        except (OSError, StartupRegistrationError):
                            return False
                        startup_enabled = enabled
                        return changed

                    startup_toggle = update_startup
                    startup_toggle(True)

                run_toggle_window(
                    lambda stop_event, status_callback: _run_worker_session(
                        config,
                        identity,
                        solver,
                        stop_event,
                        status_callback,
                    ),
                    cpu_workers=config.cpu_workers,
                    max_memory_mb=config.max_memory_mb,
                    startup_toggle=startup_toggle,
                    start_hidden=arguments.startup,
                    update_checker=updater.check if updater is not None else None,
                    update_installer=(
                        updater.prepare_and_launch if updater is not None else None
                    ),
                )
                return 0

            stop_event = threading.Event()
            _install_signal_handlers(stop_event)
            token = _load_or_pair_token(
                config,
                identity,
                stop_event,
                allow_pair=not arguments.check,
            )
            if arguments.check:
                probe_status = _probe_solver(solver, config)
                logging.getLogger("agent_helper").info(
                    "Configuration, credential and solver probe are valid (%s CPU workers, probe status %s).",
                    config.cpu_workers,
                    probe_status,
                )
                return 0

            api = ApiClient(config, identity, token=token)
            worker = AgentWorker(api, solver, stop_event=stop_event)
            if arguments.once:
                worker.run_once()
            else:
                worker.run_forever()
            return 0
    except (
        ApiError,
        ConfigError,
        PairingError,
        SolverInfrastructureError,
        StateError,
        ProtocolError,
    ) as exc:
        logging.getLogger("agent_helper").error("Agent Helper could not start: %s", exc)
        if gui_mode:
            _show_gui_error(f"Không thể mở Agent.\n\n{exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
