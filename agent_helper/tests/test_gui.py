from __future__ import annotations

import queue
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agent_helper.gui import AgentToggleApp


class FakeRoot:
    def __init__(self) -> None:
        self.callbacks: list[tuple[int, object]] = []
        self.destroyed = False
        self.withdrawn = False
        self.protocols: dict[str, object] = {}

    def after(self, delay: int, callback: object) -> None:
        self.callbacks.append((delay, callback))

    def destroy(self) -> None:
        self.destroyed = True

    def protocol(self, name: str, callback: object) -> None:
        self.protocols[name] = callback

    def withdraw(self) -> None:
        self.withdrawn = True

    def deiconify(self) -> None:
        self.withdrawn = False

    def lift(self) -> None:
        pass

    def focus_force(self) -> None:
        pass


def bare_app(runner: object) -> tuple[AgentToggleApp, list[str]]:
    app = AgentToggleApp.__new__(AgentToggleApp)
    app.root = FakeRoot()
    app.session_runner = runner
    app.cpu_workers = 2
    app.startup_toggle = None
    app.update_checker = None
    app.update_installer = None
    app.events = queue.SimpleQueue()
    app.update_events = queue.SimpleQueue()
    app.commands = queue.SimpleQueue()
    app.stop_event = None
    app.worker_thread = None
    app.tray = None
    app.window_icon = None
    app.generation = 0
    app.desired_on = False
    app.closing = False
    app.current_state = "off"
    app.available_update = None
    app.update_check_thread = None
    app.update_apply_thread = None
    app.update_in_progress = False
    app.update_install_started = False
    app.restart_after_stop = False
    app.dismissed_update_versions = set()
    rendered: list[str] = []
    app._render = rendered.append  # type: ignore[method-assign]
    return app, rendered


class ToggleLifecycleTests(unittest.TestCase):
    def test_tray_close_hides_window_and_exit_command_stops_tray(self) -> None:
        class FakeTray:
            def __init__(self) -> None:
                self.started = False
                self.stopped = False
                self.states: list[bool] = []

            def start(self) -> None:
                self.started = True

            def update(self, online: bool) -> None:
                self.states.append(online)

            def stop(self) -> None:
                self.stopped = True

        app, _ = bare_app(lambda stop_event, report: None)
        tray = FakeTray()
        app.attach_tray(tray)
        self.assertTrue(tray.started)
        close_button = app.root.protocols["WM_DELETE_WINDOW"]
        close_button()  # type: ignore[operator]
        self.assertTrue(app.root.withdrawn)
        self.assertFalse(app.root.destroyed)

        app.request_tray_command("show")
        app._drain_events()
        self.assertFalse(app.root.withdrawn)
        app.request_tray_command("exit")
        app._drain_events()
        self.assertTrue(tray.stopped)
        self.assertTrue(app.root.destroyed)

    def test_window_schedules_auto_on_for_the_first_event_loop_turn(self) -> None:
        started = threading.Event()
        stopped = threading.Event()
        startup_states: list[bool] = []
        rendered: list[str] = []

        def runner(stop_event: threading.Event, report: object) -> None:
            del report
            started.set()
            stop_event.wait(2)
            stopped.set()

        root = FakeRoot()
        with (
            patch.object(AgentToggleApp, "_build_window"),
            patch.object(AgentToggleApp, "_render", side_effect=rendered.append),
        ):
            app = AgentToggleApp(
                root,
                runner,
                cpu_workers=2,
                tk_module=object(),
                startup_toggle=lambda enabled: startup_states.append(enabled),
            )
        app._render = rendered.append  # type: ignore[method-assign]

        self.assertEqual([delay for delay, _ in root.callbacks[:2]], [0, 100])
        self.assertFalse(app.desired_on)
        auto_on = root.callbacks[0][1]
        self.assertTrue(callable(auto_on))
        auto_on()  # type: ignore[operator]
        self.assertTrue(started.wait(1))
        self.assertTrue(app.desired_on)
        self.assertEqual(startup_states, [True])
        self.assertEqual(rendered[:2], ["off", "starting"])

        app.close()
        self.assertTrue(stopped.wait(1))
        self.assertTrue(root.destroyed)
        self.assertEqual(
            startup_states,
            [True],
            "closing stops this session but keeps next-logon startup enabled",
        )

    def test_closing_before_scheduled_auto_on_never_starts_a_session(self) -> None:
        started = threading.Event()
        startup_states: list[bool] = []

        def runner(stop_event: threading.Event, report: object) -> None:
            del stop_event, report
            started.set()

        root = FakeRoot()
        with (
            patch.object(AgentToggleApp, "_build_window"),
            patch.object(AgentToggleApp, "_render"),
        ):
            app = AgentToggleApp(
                root,
                runner,
                cpu_workers=2,
                tk_module=object(),
                startup_toggle=lambda enabled: startup_states.append(enabled),
            )
        auto_on = root.callbacks[0][1]
        app.close()
        auto_on()  # type: ignore[operator]
        self.assertFalse(started.is_set())
        self.assertEqual(startup_states, [])

    def test_off_stops_active_session(self) -> None:
        started = threading.Event()
        stopped = threading.Event()

        def runner(stop_event: threading.Event, report: object) -> None:
            del report
            started.set()
            stop_event.wait(2)
            stopped.set()

        app, rendered = bare_app(runner)
        startup_states: list[bool] = []
        app.startup_toggle = lambda enabled: startup_states.append(enabled)
        app.turn_on()
        self.assertTrue(started.wait(1))
        self.assertTrue(app.desired_on)
        app.turn_off()
        self.assertTrue(stopped.wait(1))
        self.assertFalse(app.desired_on)
        self.assertTrue(app.stop_event is None or app.stop_event.is_set())
        self.assertIn("starting", rendered)
        self.assertEqual(rendered[-1], "off")
        self.assertEqual(startup_states, [True, False])

    def test_turning_back_on_while_network_drains_restarts_after_stop(self) -> None:
        first_started = threading.Event()
        allow_first_to_stop = threading.Event()
        second_started = threading.Event()
        sessions = 0

        def runner(stop_event: threading.Event, report: object) -> None:
            nonlocal sessions
            del report
            sessions += 1
            if sessions == 1:
                first_started.set()
                stop_event.wait(2)
                allow_first_to_stop.wait(2)
            else:
                second_started.set()
                stop_event.wait(2)

        app, rendered = bare_app(runner)
        app.turn_on()
        self.assertTrue(first_started.wait(1))
        app.turn_off()
        app.turn_on()

        self.assertTrue(app.restart_after_stop)
        self.assertTrue(app.desired_on)
        self.assertEqual(rendered[-1], "starting")
        allow_first_to_stop.set()
        deadline = time.monotonic() + 1
        while not second_started.is_set():
            app._drain_events()
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        self.assertEqual(sessions, 2)
        app.close()

    def test_startup_registry_failure_does_not_block_on_or_off(self) -> None:
        started = threading.Event()
        stopped = threading.Event()

        def runner(stop_event: threading.Event, report: object) -> None:
            del report
            started.set()
            stop_event.wait(2)
            stopped.set()

        def unavailable(enabled: bool) -> None:
            del enabled
            raise OSError("registry policy")

        app, _ = bare_app(runner)
        app.startup_toggle = unavailable
        app.turn_on()
        self.assertTrue(started.wait(1))
        app.turn_off()
        self.assertTrue(stopped.wait(1))
        self.assertFalse(app.desired_on)

    def test_close_requests_stop_and_destroys_window(self) -> None:
        running = threading.Event()

        def runner(stop_event: threading.Event, report: object) -> None:
            del report
            running.set()
            stop_event.wait(2)

        app, _ = bare_app(runner)
        app.turn_on()
        self.assertTrue(running.wait(1))
        app.close()
        self.assertTrue(app.closing)
        self.assertTrue(app.stop_event is not None and app.stop_event.is_set())
        self.assertTrue(app.root.destroyed)

    def test_session_error_returns_to_off_state(self) -> None:
        def runner(stop_event: threading.Event, report: object) -> None:
            del stop_event, report
            raise RuntimeError("test error")

        app, rendered = bare_app(runner)
        app.turn_on()
        deadline = time.monotonic() + 1
        while app.worker_thread is not None and app.worker_thread.is_alive():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)
        app._drain_events()
        self.assertFalse(app.desired_on)
        self.assertEqual(rendered[-1], "error")

    def test_update_is_deferred_until_the_worker_is_idle(self) -> None:
        release = SimpleNamespace(version="1.7.0")
        app, _ = bare_app(lambda stop_event, report: None)
        app.desired_on = True
        app.current_state = "working"
        app.available_update = release
        prompts: list[str] = []
        app._ask_to_update = lambda version: prompts.append(version) or False  # type: ignore[method-assign]

        app._offer_update_if_idle()
        self.assertEqual(prompts, [])
        self.assertFalse(app.update_in_progress)

        app.current_state = "waiting"
        app._offer_update_if_idle()
        self.assertEqual(prompts, ["1.7.0"])
        self.assertFalse(app.update_in_progress)

    def test_confirmed_update_stops_worker_before_installing(self) -> None:
        release = SimpleNamespace(version="1.7.0")
        worker_started = threading.Event()
        worker_stopped = threading.Event()
        installed = threading.Event()

        def runner(stop_event: threading.Event, report: object) -> None:
            del report
            worker_started.set()
            stop_event.wait(2)
            worker_stopped.set()

        app, rendered = bare_app(runner)
        app.update_installer = lambda candidate: installed.set()
        app.available_update = release
        app._ask_to_update = lambda version: True  # type: ignore[method-assign]
        app.turn_on()
        self.assertTrue(worker_started.wait(1))
        app.current_state = "waiting"
        app._offer_update_if_idle()

        self.assertTrue(app.update_in_progress)
        self.assertFalse(app.desired_on)
        self.assertIn("updating", rendered)
        self.assertTrue(worker_stopped.wait(1))
        self.assertFalse(installed.is_set(), "installer started before worker shutdown was observed")

        app._drain_events()
        self.assertTrue(installed.wait(1))
        app._drain_events()
        self.assertTrue(app.root.destroyed)

    def test_update_failure_keeps_old_app_and_turns_worker_back_on(self) -> None:
        app, _ = bare_app(lambda stop_event, report: None)
        app.update_in_progress = True
        app.update_install_started = True
        app.available_update = SimpleNamespace(version="1.7.0")
        messages: list[str] = []
        restarted: list[bool] = []
        app._show_update_error = messages.append  # type: ignore[method-assign]
        app.turn_on = lambda: restarted.append(True)  # type: ignore[method-assign]

        app._handle_update_error("hash mismatch")

        self.assertEqual(messages, ["hash mismatch"])
        self.assertEqual(restarted, [True])
        self.assertFalse(app.update_in_progress)
        self.assertIsNone(app.available_update)


if __name__ == "__main__":
    unittest.main()
