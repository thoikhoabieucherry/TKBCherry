from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_helper.tray import (
    SystemTray,
    SystemTrayUnavailable,
    Win32NotificationAreaBackend,
    create_system_tray,
)


class FakeBackend:
    def __init__(self) -> None:
        self.ran = threading.Event()
        self.stopped = threading.Event()
        self.updates: list[tuple[bool, str | None]] = []
        self.startup_error: BaseException | None = None

    def run(self) -> None:
        self.ran.set()
        self.stopped.wait(2)

    def wait_started(self, timeout: float) -> bool:
        return self.ran.wait(timeout)

    def update(self, online: bool, *, state: str | None = None) -> None:
        self.updates.append((online, state))

    def stop(self) -> None:
        self.stopped.set()


class TrayTests(unittest.TestCase):
    def test_system_tray_runs_updates_and_stops_backend_off_tk_thread(self) -> None:
        backend = FakeBackend()
        tray = SystemTray(backend)

        tray.start()
        self.assertTrue(backend.ran.is_set())
        tray.update(True, state="working")
        tray.update(False, state="off")
        tray.stop()

        self.assertEqual(
            backend.updates,
            [(True, "working"), (False, "off")],
        )
        self.assertTrue(backend.stopped.is_set())

    def test_startup_error_is_reported_instead_of_leaving_hidden_process(self) -> None:
        backend = FakeBackend()
        backend.startup_error = OSError("notification icon unavailable")
        tray = SystemTray(backend)

        with self.assertRaises(SystemTrayUnavailable):
            tray.start()

        self.assertTrue(backend.stopped.is_set())

    def test_windows_factory_never_imports_pillow_or_pystray(self) -> None:
        backend = FakeBackend()
        icon_path = Path("favicon-cherry.png")
        with (
            patch.dict(sys.modules, {"PIL": None, "pystray": None}),
            patch(
                "agent_helper.tray.Win32NotificationAreaBackend",
                return_value=backend,
            ) as backend_type,
        ):
            tray = create_system_tray(
                icon_path,
                lambda command: None,
                lambda: True,
                platform_name="nt",
            )

        self.assertIs(tray._backend, backend)
        backend_type.assert_called_once()
        self.assertEqual(backend_type.call_args.args[0], icon_path)

    def test_non_windows_desktop_fails_closed_so_gui_can_show_itself(self) -> None:
        with self.assertRaises(SystemTrayUnavailable):
            create_system_tray(
                Path("favicon-cherry.png"),
                lambda command: None,
                lambda: False,
                platform_name="posix",
            )

    def test_win32_double_click_and_menu_commands_use_safe_command_names(self) -> None:
        commands: list[str] = []
        backend = Win32NotificationAreaBackend(
            Path("favicon-cherry.png"), commands.append, lambda: True
        )
        backend._bindings = SimpleNamespace(
            user32=SimpleNamespace(DefWindowProcW=lambda *args: 0)
        )

        backend._window_proc(
            1,
            backend.WM_TRAY_CALLBACK,
            0,
            backend.WM_LBUTTONDBLCLK,
        )
        for menu_id in (
            backend.ID_ON,
            backend.ID_OFF,
            backend.ID_SHOW,
            backend.ID_EXIT,
            9999,
        ):
            backend._dispatch_command(menu_id)

        self.assertEqual(commands, ["show", "on", "off", "show", "exit"])

    def test_explorer_restore_failure_retries_then_reports_visible_fallback(self) -> None:
        commands: list[str] = []
        backend = Win32NotificationAreaBackend(
            Path("favicon-cherry.png"), commands.append, lambda: True
        )
        backend._bindings = SimpleNamespace(
            user32=SimpleNamespace(DefWindowProcW=lambda *args: 0)
        )
        backend._hwnd = 1
        backend._taskbar_created_message = 7001

        with (
            patch.object(backend, "_add_icon", side_effect=OSError("Explorer busy")),
            patch.object(backend, "_schedule_restore_retry") as schedule_retry,
        ):
            backend._window_proc(1, 7001, 0, 0)
            for _ in range(backend.RESTORE_RETRY_LIMIT - 1):
                backend._window_proc(1, backend.WM_TRAY_RETRY, 0, 0)

        self.assertEqual(schedule_retry.call_count, backend.RESTORE_RETRY_LIMIT - 1)
        self.assertEqual(commands, ["tray_lost"])

    def test_delayed_restore_message_does_not_add_duplicate_icon(self) -> None:
        backend = Win32NotificationAreaBackend(
            Path("favicon-cherry.png"), lambda command: None, lambda: True
        )
        backend._icon_added = True

        with patch.object(backend, "_add_icon") as add_icon:
            backend._try_restore_icon()

        add_icon.assert_not_called()

    def test_win32_menu_has_show_on_off_exit_and_disables_current_state(self) -> None:
        commands: list[str] = []
        appended: list[tuple[int, int, str | None]] = []

        class FakeCtypes:
            @staticmethod
            def byref(value: object) -> object:
                return value

        class Point:
            x = 0
            y = 0

        class FakeUser32:
            @staticmethod
            def CreatePopupMenu() -> int:
                return 7

            @staticmethod
            def AppendMenuW(
                menu: int, flags: int, menu_id: int, text: str | None
            ) -> bool:
                del menu
                appended.append((flags, menu_id, text))
                return True

            @staticmethod
            def SetMenuDefaultItem(*args: object) -> bool:
                return True

            @staticmethod
            def GetCursorPos(point: Point) -> bool:
                point.x = 12
                point.y = 34
                return True

            @staticmethod
            def SetForegroundWindow(hwnd: int) -> bool:
                return bool(hwnd)

            @staticmethod
            def TrackPopupMenu(*args: object) -> int:
                return Win32NotificationAreaBackend.ID_OFF

            @staticmethod
            def PostMessageW(*args: object) -> bool:
                return True

            @staticmethod
            def DestroyMenu(menu: int) -> bool:
                return bool(menu)

        backend = Win32NotificationAreaBackend(
            Path("favicon-cherry.png"), commands.append, lambda: True
        )
        backend._bindings = SimpleNamespace(
            ctypes=FakeCtypes,
            POINT=Point,
            user32=FakeUser32,
        )
        backend._hwnd = 11

        backend._show_menu()

        actionable = [item for item in appended if item[2] is not None]
        self.assertEqual(
            [item[2] for item in actionable],
            ["Mở TKBCherry Agent", "Bật Agent", "Tắt Agent", "Thoát"],
        )
        self.assertTrue(actionable[1][0] & backend.MF_GRAYED)
        self.assertFalse(actionable[2][0] & backend.MF_GRAYED)
        self.assertEqual(commands, ["off"])

    def test_tray_title_distinguishes_local_work_vps_and_off(self) -> None:
        backend = Win32NotificationAreaBackend(
            Path("favicon-cherry.png"), lambda command: None, lambda: True
        )

        backend.update(True, state="working")
        self.assertEqual(backend._title(), "TKBCherry Agent · Đang xếp")
        backend.update(True, state="windows_security")
        self.assertEqual(backend._title(), "TKBCherry Agent · VPS")
        backend.update(False, state="off")
        self.assertEqual(backend._title(), "TKBCherry Agent · OFF")


if __name__ == "__main__":
    unittest.main()
