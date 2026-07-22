from __future__ import annotations

import io
import json
import threading
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

from agent_helper.gui import run_toggle_window
from agent_helper.__main__ import (
    _run_windows_security_fallback_session,
    _solver_child_main,
    main,
)
from agent_helper.windows_security import (
    WINDOWS_CODE_INTEGRITY_KIND,
    solver_blocked_by_windows_code_integrity,
)


class WindowsSecurityTests(unittest.TestCase):
    def test_solver_gate_requires_frozen_windows_enforcement_and_untrusted_exe(
        self,
    ) -> None:
        enforced = lambda: True
        not_enforced = lambda: False
        untrusted = lambda _path: False
        trusted = lambda _path: True

        self.assertFalse(
            solver_blocked_by_windows_code_integrity(
                frozen=False,
                platform_name="nt",
                policy_check=enforced,
                trust_check=untrusted,
            )
        )
        self.assertFalse(
            solver_blocked_by_windows_code_integrity(
                frozen=True,
                platform_name="posix",
                policy_check=enforced,
                trust_check=untrusted,
            )
        )
        self.assertFalse(
            solver_blocked_by_windows_code_integrity(
                frozen=True,
                platform_name="nt",
                policy_check=not_enforced,
                trust_check=untrusted,
            )
        )
        self.assertFalse(
            solver_blocked_by_windows_code_integrity(
                frozen=True,
                platform_name="nt",
                policy_check=enforced,
                trust_check=trusted,
            )
        )
        self.assertTrue(
            solver_blocked_by_windows_code_integrity(
                frozen=True,
                platform_name="nt",
                policy_check=enforced,
                trust_check=untrusted,
            )
        )

    def test_blocked_solver_child_returns_one_structured_503_frame(self) -> None:
        stdin = io.StringIO('{"data":{},"settings":{}}')
        stdout = io.StringIO()
        with (
            patch("agent_helper.__main__._restore_solver_child_stdio", return_value=True),
            patch(
                "agent_helper.__main__.solver_blocked_by_windows_code_integrity",
                return_value=True,
            ),
            patch("sys.stdin", stdin),
            patch("sys.stdout", stdout),
            patch("agent_helper.__main__.runpy.run_path") as run_solver,
            patch(
                "agent_helper.__main__.SolverRunner.bundled_runtime_root"
            ) as locate_solver,
        ):
            self.assertEqual(_solver_child_main(), 0)

        run_solver.assert_not_called()
        locate_solver.assert_not_called()
        self.assertEqual(stdout.getvalue().count("\n"), 1)
        frame = json.loads(stdout.getvalue())
        self.assertEqual(frame["protocol"], "tkb-reference-solver-stdio-v1")
        self.assertEqual(frame["status"], 503)
        self.assertFalse(frame["payload"]["ok"])
        self.assertEqual(frame["payload"]["kind"], WINDOWS_CODE_INTEGRITY_KIND)

    def test_blocked_gui_never_constructs_solver_and_disables_native_tray(self) -> None:
        captured: dict[str, object] = {}

        def run_window(session_runner: object, **options: object) -> None:
            captured["session_runner"] = session_runner
            captured.update(options)

        config = SimpleNamespace(cpu_workers=4, max_memory_mb=8192)
        with (
            patch(
                "agent_helper.__main__.solver_blocked_by_windows_code_integrity",
                return_value=True,
            ),
            patch("agent_helper.__main__.AgentConfig.load", return_value=config),
            patch("agent_helper.__main__.load_or_create_agent_id", return_value="agent-1"),
            patch("agent_helper.__main__.platform_tag", return_value="windows-amd64"),
            patch("agent_helper.__main__.SingleInstanceLock", return_value=nullcontext()),
            patch("agent_helper.__main__.SolverRunner") as solver_runner,
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=None,
            ),
        ):
            self.assertEqual(main([]), 0)

        solver_runner.assert_not_called()
        self.assertIs(
            captured["session_runner"], _run_windows_security_fallback_session
        )
        self.assertIs(captured["allow_system_tray"], False)
        self.assertEqual(captured["cpu_workers"], 4)
        self.assertEqual(captured["max_memory_mb"], 8192)

    def test_fallback_window_does_not_import_pillow_tray_path(self) -> None:
        events: list[str] = []

        class Root:
            def withdraw(self) -> None:
                events.append("withdraw")

            def mainloop(self) -> None:
                events.append("mainloop")

        class App:
            def __init__(self, root: object, session_runner: object, **options: object):
                del root, session_runner, options
                events.append("app")

            def minimize_window(self) -> None:
                events.append("minimize")

        tkinter = SimpleNamespace(Tk=lambda: events.append("tk") or Root())
        blocked_tray = SimpleNamespace(
            create_system_tray=lambda *args, **kwargs: self.fail(
                f"native tray path was used: {args!r} {kwargs!r}"
            )
        )
        with (
            patch.dict(
                "sys.modules",
                {"tkinter": tkinter, "agent_helper.tray": blocked_tray},
            ),
            patch("agent_helper.gui.AgentToggleApp", App),
        ):
            run_toggle_window(
                lambda stop_event, report: None,
                cpu_workers=2,
                max_memory_mb=4096,
                allow_system_tray=False,
            )

        self.assertEqual(
            events,
            ["tk", "withdraw", "app", "minimize", "mainloop"],
        )

    def test_fallback_session_never_registers_and_waits_for_stop(self) -> None:
        stop_event = threading.Event()
        ready = threading.Event()
        statuses: list[str] = []

        def report(status: str) -> None:
            statuses.append(status)
            ready.set()

        thread = threading.Thread(
            target=_run_windows_security_fallback_session,
            args=(stop_event, report),
        )
        thread.start()
        try:
            self.assertTrue(ready.wait(1))
            self.assertEqual(statuses, ["windows_security"])
            self.assertTrue(thread.is_alive())
        finally:
            stop_event.set()
            thread.join(1)
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
