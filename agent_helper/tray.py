"""Windows notification-area controller without third-party native packages.

The packaged Agent must keep its tray control surface even when Windows Smart
App Control prevents the unsigned solver stack from loading.  This module uses
only ``ctypes`` and the Win32 shell API, so creating the icon never imports
Pillow, pystray, or any of their native extensions.
"""

from __future__ import annotations

import os
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any


TrayCommand = Callable[[str], None]
AgentState = Callable[[], bool]


class SystemTrayUnavailable(RuntimeError):
    """Raised when the current desktop cannot provide a notification icon."""


class SystemTray:
    """Run a blocking tray backend outside Tk and expose a small safe API."""

    def __init__(self, backend: Any) -> None:
        self._backend = backend
        self._thread: threading.Thread | None = None
        self._thread_error: BaseException | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return

        self._thread_error = None

        def run() -> None:
            try:
                self._backend.run()
            except BaseException as exc:  # pragma: no cover - final safety net
                self._thread_error = exc

        self._thread = threading.Thread(
            target=run,
            name="TKBCherryAgentTray",
            daemon=True,
        )
        self._thread.start()

        wait_started = getattr(self._backend, "wait_started", None)
        if callable(wait_started) and not wait_started(2.0):
            self.stop()
            raise SystemTrayUnavailable("Windows notification icon timed out")
        startup_error = getattr(self._backend, "startup_error", None)
        if startup_error is not None:
            self.stop()
            raise SystemTrayUnavailable(str(startup_error)) from startup_error
        if self._thread_error is not None:
            raise SystemTrayUnavailable(str(self._thread_error)) from self._thread_error

    def update(self, online: bool, *, state: str | None = None) -> None:
        try:
            self._backend.update(bool(online), state=state)
        except Exception:
            # A stale Explorer window must not disturb the worker. Explorer's
            # TaskbarCreated message will add the icon again when available.
            return

    def stop(self) -> None:
        try:
            self._backend.stop()
        except Exception:
            pass
        thread = self._thread
        if (
            thread is not None
            and thread.is_alive()
            and thread is not threading.current_thread()
        ):
            thread.join(timeout=2.0)


class Win32NotificationAreaBackend:
    """Own one hidden Win32 window and one ``Shell_NotifyIconW`` icon."""

    ID_SHOW = 1001
    ID_ON = 1002
    ID_OFF = 1003
    ID_EXIT = 1004

    WM_NULL = 0x0000
    WM_DESTROY = 0x0002
    WM_CLOSE = 0x0010
    WM_COMMAND = 0x0111
    WM_CONTEXTMENU = 0x007B
    WM_LBUTTONDBLCLK = 0x0203
    WM_RBUTTONUP = 0x0205
    WM_APP = 0x8000
    WM_TRAY_CALLBACK = WM_APP + 41
    WM_TRAY_UPDATE = WM_APP + 42
    WM_TRAY_RETRY = WM_APP + 43

    NIM_ADD = 0x00000000
    NIM_MODIFY = 0x00000001
    NIM_DELETE = 0x00000002
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004
    NIF_SHOWTIP = 0x00000080

    MF_STRING = 0x00000000
    MF_GRAYED = 0x00000001
    MF_SEPARATOR = 0x00000800
    TPM_LEFTALIGN = 0x0000
    TPM_RIGHTBUTTON = 0x0002
    TPM_BOTTOMALIGN = 0x0020
    TPM_NONOTIFY = 0x0080
    TPM_RETURNCMD = 0x0100

    CS_DBLCLKS = 0x0008
    IMAGE_ICON = 1
    LR_LOADFROMFILE = 0x0010
    LR_DEFAULTSIZE = 0x0040
    IDI_APPLICATION = 32512
    IDC_ARROW = 32512
    ICON_ID = 1
    RESTORE_RETRY_LIMIT = 4
    RESTORE_RETRY_SECONDS = 0.75

    def __init__(
        self,
        icon_path: Path,
        command: TrayCommand,
        is_on: AgentState,
    ) -> None:
        self.icon_path = Path(icon_path)
        self.command = command
        self.is_on = is_on
        self._ready = threading.Event()
        self._stop_requested = threading.Event()
        self._state_lock = threading.Lock()
        self._online = False
        self._state = "off"
        self._startup_error: BaseException | None = None
        self._bindings: Any | None = None
        self._hwnd: Any | None = None
        self._hinstance: Any | None = None
        self._hicon: Any | None = None
        self._owns_icon = False
        self._icon_added = False
        self._restore_attempts = 0
        self._restore_retry_pending = False
        self._lost_reported = False
        self._class_name = f"TKBCherryAgentTray_{os.getpid()}_{id(self):x}"
        self._window_proc_ref: Any | None = None
        self._taskbar_created_message = 0

    @property
    def startup_error(self) -> BaseException | None:
        return self._startup_error

    def wait_started(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    def update(self, online: bool, *, state: str | None = None) -> None:
        with self._state_lock:
            self._online = bool(online)
            self._state = state or ("waiting" if online else "off")
        bindings = self._bindings
        hwnd = self._hwnd
        if bindings is not None and hwnd:
            bindings.user32.PostMessageW(hwnd, self.WM_TRAY_UPDATE, 0, 0)

    def stop(self) -> None:
        self._stop_requested.set()
        bindings = self._bindings
        hwnd = self._hwnd
        if bindings is not None and hwnd:
            bindings.user32.PostMessageW(hwnd, self.WM_CLOSE, 0, 0)

    def run(self) -> None:
        registered = False
        startup_complete = False
        try:
            bindings = _load_win32_bindings()
            self._bindings = bindings
            self._hinstance = bindings.kernel32.GetModuleHandleW(None)
            if not self._hinstance:
                raise OSError("GetModuleHandleW failed")

            self._window_proc_ref = bindings.WNDPROC(self._window_proc)
            window_class = bindings.WNDCLASSW()
            window_class.style = self.CS_DBLCLKS
            window_class.lpfnWndProc = self._window_proc_ref
            window_class.hInstance = self._hinstance
            window_class.hCursor = bindings.user32.LoadCursorW(
                None, bindings.ctypes.c_void_p(self.IDC_ARROW)
            )
            window_class.lpszClassName = self._class_name
            if not bindings.user32.RegisterClassW(bindings.ctypes.byref(window_class)):
                self._raise_last_error("RegisterClassW failed")
            registered = True

            hwnd = bindings.user32.CreateWindowExW(
                0,
                self._class_name,
                "TKBCherry Agent notification icon",
                0,
                0,
                0,
                0,
                0,
                None,
                None,
                self._hinstance,
                None,
            )
            if not hwnd:
                self._raise_last_error("CreateWindowExW failed")
            self._hwnd = hwnd
            self._taskbar_created_message = int(
                bindings.user32.RegisterWindowMessageW("TaskbarCreated")
            )
            self._hicon, self._owns_icon = self._load_icon()
            self._add_icon()
            startup_complete = True
            self._ready.set()

            if self._stop_requested.is_set():
                bindings.user32.PostMessageW(hwnd, self.WM_CLOSE, 0, 0)

            message = bindings.MSG()
            while True:
                result = int(
                    bindings.user32.GetMessageW(
                        bindings.ctypes.byref(message), None, 0, 0
                    )
                )
                if result == 0:
                    break
                if result < 0:
                    self._raise_last_error("GetMessageW failed")
                bindings.user32.TranslateMessage(bindings.ctypes.byref(message))
                bindings.user32.DispatchMessageW(bindings.ctypes.byref(message))
        except BaseException as exc:
            self._startup_error = exc
        finally:
            self._ready.set()
            if startup_complete and not self._stop_requested.is_set():
                self._report_tray_lost()
            bindings = self._bindings
            if bindings is not None:
                self._delete_icon()
                hwnd = self._hwnd
                if hwnd and bindings.user32.IsWindow(hwnd):
                    bindings.user32.DestroyWindow(hwnd)
                self._hwnd = None
                if self._owns_icon and self._hicon:
                    bindings.user32.DestroyIcon(self._hicon)
                self._hicon = None
                if registered and self._hinstance:
                    bindings.user32.UnregisterClassW(
                        self._class_name, self._hinstance
                    )

    def _raise_last_error(self, message: str) -> None:
        bindings = self._bindings
        code = bindings.ctypes.get_last_error() if bindings is not None else 0
        if code:
            raise OSError(code, message)
        raise OSError(message)

    def _title(self) -> str:
        with self._state_lock:
            online = self._online
            state = self._state
        if state == "windows_security":
            suffix = "VPS"
        elif state == "working":
            suffix = "Đang xếp"
        elif state == "updating":
            suffix = "Đang cập nhật"
        else:
            suffix = "ON" if online else "OFF"
        return f"TKBCherry Agent · {suffix}"

    def _make_notify_data(self, flags: int) -> Any:
        bindings = self._bindings
        assert bindings is not None
        data = bindings.NOTIFYICONDATAW()
        data.cbSize = bindings.ctypes.sizeof(bindings.NOTIFYICONDATAW)
        data.hWnd = self._hwnd
        data.uID = self.ICON_ID
        data.uFlags = flags
        data.uCallbackMessage = self.WM_TRAY_CALLBACK
        data.hIcon = self._hicon
        data.szTip = self._title()[:127]
        return data

    def _add_icon(self) -> None:
        bindings = self._bindings
        if bindings is None or not self._hwnd or not self._hicon:
            return
        data = self._make_notify_data(
            self.NIF_MESSAGE | self.NIF_ICON | self.NIF_TIP | self.NIF_SHOWTIP
        )
        if not bindings.shell32.Shell_NotifyIconW(
            self.NIM_ADD, bindings.ctypes.byref(data)
        ):
            self._raise_last_error("Shell_NotifyIconW(NIM_ADD) failed")
        self._icon_added = True
        self._restore_attempts = 0
        self._restore_retry_pending = False

    def _modify_icon(self) -> None:
        bindings = self._bindings
        if bindings is None:
            return
        if not self._icon_added:
            self._try_restore_icon()
            return
        data = self._make_notify_data(self.NIF_TIP)
        if not bindings.shell32.Shell_NotifyIconW(
            self.NIM_MODIFY, bindings.ctypes.byref(data)
        ):
            # Explorer can restart between TaskbarCreated and this update.
            # Enter the same bounded restore path instead of staying hidden.
            self._icon_added = False
            self._try_restore_icon()

    def _try_restore_icon(self) -> None:
        if self._icon_added:
            self._restore_attempts = 0
            self._restore_retry_pending = False
            return
        if self._stop_requested.is_set() or self._lost_reported:
            return
        try:
            self._add_icon()
            return
        except Exception:
            self._icon_added = False
            self._restore_attempts += 1
        if self._restore_attempts >= self.RESTORE_RETRY_LIMIT:
            self._report_tray_lost()
        else:
            self._schedule_restore_retry()

    def _schedule_restore_retry(self) -> None:
        if self._restore_retry_pending or self._stop_requested.is_set():
            return
        self._restore_retry_pending = True

        def request_retry() -> None:
            bindings = self._bindings
            hwnd = self._hwnd
            if self._stop_requested.is_set():
                return
            if (
                bindings is not None
                and hwnd
                and bindings.user32.PostMessageW(
                    hwnd, self.WM_TRAY_RETRY, 0, 0
                )
            ):
                return
            self._restore_retry_pending = False
            self._report_tray_lost()

        timer = threading.Timer(self.RESTORE_RETRY_SECONDS, request_retry)
        timer.daemon = True
        timer.start()

    def _report_tray_lost(self) -> None:
        with self._state_lock:
            if self._lost_reported or self._stop_requested.is_set():
                return
            self._lost_reported = True
        try:
            self.command("tray_lost")
        except Exception:
            return

    def _delete_icon(self) -> None:
        bindings = self._bindings
        if bindings is None or not self._icon_added or not self._hwnd:
            return
        data = self._make_notify_data(0)
        bindings.shell32.Shell_NotifyIconW(
            self.NIM_DELETE, bindings.ctypes.byref(data)
        )
        self._icon_added = False

    def _load_icon(self) -> tuple[Any, bool]:
        bindings = self._bindings
        assert bindings is not None
        ctypes = bindings.ctypes

        if self.icon_path.is_file() and self.icon_path.suffix.lower() == ".ico":
            icon = bindings.user32.LoadImageW(
                None,
                str(self.icon_path),
                self.IMAGE_ICON,
                0,
                0,
                self.LR_LOADFROMFILE | self.LR_DEFAULTSIZE,
            )
            if icon:
                return icon, True

        # PyInstaller embeds the Cherry icon in the executable. Extracting it
        # through shell32 keeps the notification icon branded without decoding
        # the bundled PNG through Pillow.
        large = bindings.HICON()
        small = bindings.HICON()
        count = bindings.shell32.ExtractIconExW(
            str(Path(sys.executable).resolve()),
            0,
            ctypes.byref(large),
            ctypes.byref(small),
            1,
        )
        if count:
            chosen = small if small.value else large
            unused = large if small.value else None
            if unused is not None and unused.value and unused.value != chosen.value:
                bindings.user32.DestroyIcon(unused)
            if chosen.value:
                return chosen, True

        icon = bindings.user32.LoadIconW(
            None, ctypes.c_void_p(self.IDI_APPLICATION)
        )
        if not icon:
            self._raise_last_error("LoadIconW failed")
        return icon, False

    def _dispatch_command(self, menu_id: int) -> None:
        command = {
            self.ID_SHOW: "show",
            self.ID_ON: "on",
            self.ID_OFF: "off",
            self.ID_EXIT: "exit",
        }.get(int(menu_id))
        if command is None:
            return
        try:
            self.command(command)
        except Exception:
            return

    def _show_menu(self) -> None:
        bindings = self._bindings
        hwnd = self._hwnd
        if bindings is None or not hwnd:
            return
        menu = bindings.user32.CreatePopupMenu()
        if not menu:
            return
        try:
            try:
                online = bool(self.is_on())
            except Exception:
                online = False
            bindings.user32.AppendMenuW(
                menu, self.MF_STRING, self.ID_SHOW, "Mở TKBCherry Agent"
            )
            bindings.user32.AppendMenuW(menu, self.MF_SEPARATOR, 0, None)
            bindings.user32.AppendMenuW(
                menu,
                self.MF_STRING | (self.MF_GRAYED if online else 0),
                self.ID_ON,
                "Bật Agent",
            )
            bindings.user32.AppendMenuW(
                menu,
                self.MF_STRING | (0 if online else self.MF_GRAYED),
                self.ID_OFF,
                "Tắt Agent",
            )
            bindings.user32.AppendMenuW(menu, self.MF_SEPARATOR, 0, None)
            bindings.user32.AppendMenuW(
                menu, self.MF_STRING, self.ID_EXIT, "Thoát"
            )
            bindings.user32.SetMenuDefaultItem(menu, self.ID_SHOW, False)

            point = bindings.POINT()
            if not bindings.user32.GetCursorPos(bindings.ctypes.byref(point)):
                return
            bindings.user32.SetForegroundWindow(hwnd)
            selected = bindings.user32.TrackPopupMenu(
                menu,
                self.TPM_LEFTALIGN
                | self.TPM_BOTTOMALIGN
                | self.TPM_RIGHTBUTTON
                | self.TPM_NONOTIFY
                | self.TPM_RETURNCMD,
                point.x,
                point.y,
                0,
                hwnd,
                None,
            )
            if selected:
                self._dispatch_command(int(selected))
            bindings.user32.PostMessageW(hwnd, self.WM_NULL, 0, 0)
        finally:
            bindings.user32.DestroyMenu(menu)

    def _window_proc(self, hwnd: Any, message: int, wparam: int, lparam: int) -> int:
        bindings = self._bindings
        if bindings is None:
            return 0
        try:
            if self._taskbar_created_message and message == self._taskbar_created_message:
                self._icon_added = False
                self._restore_attempts = 0
                self._try_restore_icon()
                return 0
            if message == self.WM_TRAY_CALLBACK:
                notification = int(lparam) & 0xFFFF
                if notification == self.WM_LBUTTONDBLCLK:
                    self._dispatch_command(self.ID_SHOW)
                elif notification in {self.WM_RBUTTONUP, self.WM_CONTEXTMENU}:
                    self._show_menu()
                return 0
            if message == self.WM_TRAY_UPDATE:
                self._modify_icon()
                return 0
            if message == self.WM_TRAY_RETRY:
                self._restore_retry_pending = False
                self._try_restore_icon()
                return 0
            if message == self.WM_COMMAND:
                self._dispatch_command(int(wparam) & 0xFFFF)
                return 0
            if message == self.WM_CLOSE:
                bindings.user32.DestroyWindow(hwnd)
                return 0
            if message == self.WM_DESTROY:
                self._delete_icon()
                self._hwnd = None
                bindings.user32.PostQuitMessage(0)
                return 0
        except Exception:
            # Never let an exception cross a ctypes WNDPROC callback boundary.
            return 0
        return int(bindings.user32.DefWindowProcW(hwnd, message, wparam, lparam))


def _load_win32_bindings() -> Any:
    """Define and bind the small Win32 surface used by the tray thread."""

    if os.name != "nt":
        raise SystemTrayUnavailable("Windows notification area is unavailable")

    import ctypes
    from ctypes import wintypes

    lresult = ctypes.c_ssize_t
    uint_ptr = ctypes.c_size_t
    hcursor = wintypes.HANDLE
    wndproc = ctypes.WINFUNCTYPE(
        lresult,
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    )

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", wndproc),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", hcursor),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uTimeoutOrVersion", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
            ("guidItem", GUID),
            ("hBalloonIcon", wintypes.HICON),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)

    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE
    user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
    user32.RegisterClassW.restype = wintypes.WORD
    user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
    user32.UnregisterClassW.restype = wintypes.BOOL
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DefWindowProcW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.DefWindowProcW.restype = lresult
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
    ]
    user32.GetMessageW.restype = ctypes.c_int
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype = lresult
    user32.PostMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterWindowMessageW.restype = wintypes.UINT
    user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
    user32.LoadCursorW.restype = hcursor
    user32.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
    user32.LoadIconW.restype = wintypes.HICON
    user32.LoadImageW.argtypes = [
        wintypes.HINSTANCE,
        wintypes.LPCWSTR,
        wintypes.UINT,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.UINT,
    ]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.DestroyIcon.argtypes = [wintypes.HICON]
    user32.DestroyIcon.restype = wintypes.BOOL
    user32.CreatePopupMenu.restype = wintypes.HMENU
    user32.AppendMenuW.argtypes = [
        wintypes.HMENU,
        wintypes.UINT,
        uint_ptr,
        wintypes.LPCWSTR,
    ]
    user32.AppendMenuW.restype = wintypes.BOOL
    user32.SetMenuDefaultItem.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT]
    user32.SetMenuDefaultItem.restype = wintypes.BOOL
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.TrackPopupMenu.argtypes = [
        wintypes.HMENU,
        wintypes.UINT,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        ctypes.c_void_p,
    ]
    user32.TrackPopupMenu.restype = wintypes.UINT
    user32.DestroyMenu.argtypes = [wintypes.HMENU]
    user32.DestroyMenu.restype = wintypes.BOOL
    shell32.Shell_NotifyIconW.argtypes = [
        wintypes.DWORD,
        ctypes.POINTER(NOTIFYICONDATAW),
    ]
    shell32.Shell_NotifyIconW.restype = wintypes.BOOL
    shell32.ExtractIconExW.argtypes = [
        wintypes.LPCWSTR,
        ctypes.c_int,
        ctypes.POINTER(wintypes.HICON),
        ctypes.POINTER(wintypes.HICON),
        wintypes.UINT,
    ]
    shell32.ExtractIconExW.restype = wintypes.UINT

    return SimpleNamespace(
        ctypes=ctypes,
        kernel32=kernel32,
        user32=user32,
        shell32=shell32,
        WNDPROC=wndproc,
        WNDCLASSW=WNDCLASSW,
        NOTIFYICONDATAW=NOTIFYICONDATAW,
        MSG=wintypes.MSG,
        POINT=wintypes.POINT,
        HICON=wintypes.HICON,
    )


def create_system_tray(
    icon_path: Path,
    command: TrayCommand,
    is_on: AgentState,
    *,
    platform_name: str | None = None,
    backend_factory: Callable[[Path, TrayCommand, AgentState], Any] | None = None,
) -> SystemTray:
    """Create a tray lazily while keeping non-Windows/test runs dependency-free."""

    selected_platform = os.name if platform_name is None else platform_name
    if backend_factory is not None:
        backend = backend_factory(Path(icon_path), command, is_on)
    elif selected_platform == "nt":
        backend = Win32NotificationAreaBackend(Path(icon_path), command, is_on)
    else:
        raise SystemTrayUnavailable(
            "The notification-area GUI is available only on Windows"
        )
    return SystemTray(backend)
