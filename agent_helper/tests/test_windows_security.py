from __future__ import annotations

import io
import json
import threading
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import call, patch

from agent_helper.__main__ import (
    _run_wsl_or_windows_security_session,
    _solver_child_main,
    main,
)
from agent_helper.gui import run_toggle_window
from agent_helper.windows_security import (
    WINDOWS_CODE_INTEGRITY_KIND,
    solver_blocked_by_windows_code_integrity,
)
from agent_helper.wsl_setup import WSL_SETUP_GENERATION


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

    def test_blocked_gui_never_constructs_solver_and_keeps_stdlib_tray(self) -> None:
        captured: dict[str, object] = {}
        startup_states: list[bool] = []

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
            patch(
                "agent_helper.__main__.wsl_setup_restart_state",
                return_value=SimpleNamespace(
                    pending=False,
                    same_boot=False,
                    same_setup_generation=True,
                ),
            ) as restart_state,
            patch("agent_helper.__main__.set_wsl_setup_restart_pending") as set_restart,
            patch("agent_helper.__main__.SolverRunner") as solver_runner,
            patch(
                "agent_helper.wsl_solver.discover_wsl_runtime",
                side_effect=[None, SimpleNamespace(distribution="Ubuntu-24.04")],
            ),
            patch(
                "agent_helper.wsl_setup.run_elevated_setup", return_value=0
            ) as elevated_setup,
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=lambda enabled: startup_states.append(enabled) or True,
            ),
        ):
            self.assertEqual(main([]), 0)
            self.assertTrue(callable(captured["solver_setup"]))
            self.assertEqual(captured["solver_setup"](), 0)  # type: ignore[operator]

        solver_runner.assert_not_called()
        restart_state.assert_called_once_with(
            current_setup_generation=WSL_SETUP_GENERATION
        )
        self.assertTrue(callable(captured["session_runner"]))
        elevated_setup.assert_called_once_with()
        self.assertEqual(
            set_restart.call_args_list,
            [call(True, setup_generation=WSL_SETUP_GENERATION), call(False)],
        )
        self.assertIs(captured["allow_system_tray"], True)
        self.assertEqual(captured["cpu_workers"], 4)
        self.assertEqual(captured["max_memory_mb"], 8192)
        self.assertEqual(startup_states, [True])
        self.assertTrue(callable(captured["startup_toggle"]))
        captured["startup_toggle"](True)  # type: ignore[operator]
        self.assertEqual(startup_states, [True])
        self.assertNotIn("start_hidden", captured)
        self.assertNotIn("show_setup_on_start", captured)

    def test_os_startup_keeps_unprepared_agent_background_setup_available(self) -> None:
        captured: dict[str, object] = {}

        def run_window(session_runner: object, **options: object) -> None:
            del session_runner
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
            patch("agent_helper.wsl_solver.discover_wsl_runtime", return_value=None),
            patch(
                "agent_helper.__main__.wsl_setup_restart_state",
                return_value=SimpleNamespace(
                    pending=False,
                    same_boot=False,
                    same_setup_generation=True,
                ),
            ),
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=None,
            ),
        ):
            self.assertEqual(main(["--startup"]), 0)

        self.assertTrue(callable(captured["solver_setup"]))
        self.assertNotIn("start_hidden", captured)
        self.assertNotIn("show_setup_on_start", captured)

    def test_os_startup_resumes_setup_after_restart_marker_without_panel(self) -> None:
        captured: dict[str, object] = {}

        def run_window(session_runner: object, **options: object) -> None:
            del session_runner
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
            patch("agent_helper.wsl_solver.discover_wsl_runtime", return_value=None),
            patch(
                "agent_helper.__main__.wsl_setup_restart_state",
                return_value=SimpleNamespace(
                    pending=True,
                    same_boot=False,
                    same_setup_generation=True,
                ),
            ),
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=None,
            ),
        ):
            self.assertEqual(main(["--startup"]), 0)

        self.assertTrue(callable(captured["solver_setup"]))
        self.assertNotIn("start_hidden", captured)
        self.assertNotIn("show_setup_on_start", captured)

    def test_same_boot_restart_marker_suppresses_automatic_setup_retry(self) -> None:
        captured: dict[str, object] = {}

        def run_window(session_runner: object, **options: object) -> None:
            del session_runner
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
            patch("agent_helper.wsl_solver.discover_wsl_runtime", return_value=None),
            patch(
                "agent_helper.__main__.wsl_setup_restart_state",
                return_value=SimpleNamespace(
                    pending=True,
                    same_boot=True,
                    same_setup_generation=True,
                ),
            ),
            patch("agent_helper.wsl_setup.run_elevated_setup") as elevated_setup,
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=None,
            ),
        ):
            self.assertEqual(main(["--startup"]), 0)

        self.assertIsNone(captured["solver_setup"])
        elevated_setup.assert_not_called()

    def test_same_boot_older_generation_allows_one_automatic_setup_retry(self) -> None:
        captured: dict[str, object] = {}

        def run_window(session_runner: object, **options: object) -> None:
            del session_runner
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
            patch("agent_helper.wsl_solver.discover_wsl_runtime", return_value=None),
            patch(
                "agent_helper.__main__.wsl_setup_restart_state",
                return_value=SimpleNamespace(
                    pending=True,
                    same_boot=True,
                    same_setup_generation=False,
                ),
            ),
            patch("agent_helper.__main__.set_wsl_setup_restart_pending") as set_restart,
            patch("agent_helper.wsl_setup.run_elevated_setup", return_value=75) as setup,
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=None,
            ),
        ):
            self.assertEqual(main(["--startup"]), 0)
            retry = captured["solver_setup"]
            self.assertTrue(callable(retry))
            self.assertEqual(retry(), 75)  # type: ignore[operator]

        setup.assert_called_once_with()
        set_restart.assert_called_once_with(
            True, setup_generation=WSL_SETUP_GENERATION
        )

    def test_failed_post_reboot_setup_keeps_gate_for_current_boot(self) -> None:
        captured: dict[str, object] = {}

        def run_window(session_runner: object, **options: object) -> None:
            del session_runner
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
            patch("agent_helper.wsl_solver.discover_wsl_runtime", return_value=None),
            patch(
                "agent_helper.__main__.wsl_setup_restart_state",
                return_value=SimpleNamespace(
                    pending=True,
                    same_boot=False,
                    same_setup_generation=True,
                ),
            ),
            patch("agent_helper.__main__.set_wsl_setup_restart_pending") as set_restart,
            patch(
                "agent_helper.wsl_setup.run_elevated_setup",
                side_effect=RuntimeError("repair failed"),
            ),
            patch("agent_helper.gui.run_toggle_window", side_effect=run_window),
            patch(
                "agent_helper.startup.startup_toggle_for_current_process",
                return_value=None,
            ),
        ):
            self.assertEqual(main(["--startup"]), 0)
            setup = captured["solver_setup"]
            self.assertTrue(callable(setup))
            with self.assertRaisesRegex(RuntimeError, "repair failed"):
                setup()  # type: ignore[operator]

        set_restart.assert_called_once_with(
            True, setup_generation=WSL_SETUP_GENERATION
        )

    def test_fallback_window_uses_dependency_free_notification_tray(self) -> None:
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

            def request_tray_command(self, command: str) -> None:
                del command

            desired_on = True

            def attach_tray(self, tray: object) -> None:
                del tray
                events.append("attach")

            def show_window(self) -> None:
                events.append("show")

        tkinter = SimpleNamespace(Tk=lambda: events.append("tk") or Root())
        dependency_free_tray = SimpleNamespace(
            create_system_tray=lambda *args, **kwargs: events.append("tray")
            or object()
        )
        with (
            patch.dict(
                "sys.modules",
                {
                    "tkinter": tkinter,
                    "agent_helper.tray": dependency_free_tray,
                    "PIL": None,
                    "pystray": None,
                },
            ),
            patch("agent_helper.gui.AgentToggleApp", App),
            patch("agent_helper.gui.agent_icon_path"),
        ):
            run_toggle_window(
                lambda stop_event, report: None,
                cpu_workers=2,
                max_memory_mb=4096,
                allow_system_tray=True,
            )

        self.assertEqual(
            events,
            ["tk", "withdraw", "app", "tray", "attach", "mainloop"],
        )

    def test_unprepared_wsl_session_never_registers_and_waits_for_stop(self) -> None:
        stop_event = threading.Event()
        ready = threading.Event()
        statuses: list[str] = []

        def report(status: str) -> None:
            statuses.append(status)
            ready.set()

        with patch(
            "agent_helper.wsl_solver.discover_wsl_runtime", return_value=None
        ):
            thread = threading.Thread(
                target=_run_wsl_or_windows_security_session,
                args=(SimpleNamespace(), SimpleNamespace(), stop_event, report),
                kwargs={"refresh_event": threading.Event()},
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

    def test_ready_wsl_runtime_transitions_into_normal_owner_worker(self) -> None:
        stop_event = threading.Event()
        statuses: list[str] = []
        config = SimpleNamespace()
        identity = SimpleNamespace()
        runtime = SimpleNamespace(distribution="TKBCherryAgent")
        runner = object()

        with (
            patch(
                "agent_helper.wsl_solver.discover_wsl_runtime",
                return_value=runtime,
            ),
            patch("agent_helper.wsl_solver.WslSolverRunner", return_value=runner),
            patch("agent_helper.__main__._run_worker_session") as run_worker,
        ):
            _run_wsl_or_windows_security_session(
                config,
                identity,
                stop_event,
                statuses.append,
                threading.Event(),
            )

        self.assertEqual(statuses, ["windows_security", "starting"])
        run_worker.assert_called_once_with(
            config,
            identity,
            runner,
            stop_event,
            statuses.append,
        )


if __name__ == "__main__":
    unittest.main()
