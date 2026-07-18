"""Windows notification-area controller for the packaged Agent GUI."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


TrayCommand = Callable[[str], None]
AgentState = Callable[[], bool]


class DoubleClickActivation:
    """Ignore a single tray activation and open only on a quick second click."""

    def __init__(
        self,
        action: Callable[[], None],
        *,
        interval_seconds: float = 0.55,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.action = action
        self.interval_seconds = max(0.1, float(interval_seconds))
        self.clock = clock
        self._last_click = 0.0
        self._lock = threading.Lock()

    def __call__(self, _icon: Any, _item: Any) -> None:
        now = self.clock()
        should_open = False
        with self._lock:
            if self._last_click > 0 and now - self._last_click <= self.interval_seconds:
                self._last_click = 0.0
                should_open = True
            else:
                self._last_click = now
        if should_open:
            self.action()


class SystemTray:
    """Run pystray outside Tk and forward every action through a safe queue."""

    def __init__(self, icon: Any) -> None:
        self._icon = icon
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._icon.run,
            name="TKBCherryAgentTray",
            daemon=True,
        )
        self._thread.start()

    def update(self, online: bool) -> None:
        try:
            self._icon.title = "TKBCherry Agent · ON" if online else "TKBCherry Agent · OFF"
            self._icon.update_menu()
        except Exception:
            return

    def stop(self) -> None:
        try:
            self._icon.stop()
        except Exception:
            pass


def create_system_tray(
    icon_path: Path,
    command: TrayCommand,
    is_on: AgentState,
    *,
    pystray_module: Any | None = None,
    image_module: Any | None = None,
) -> SystemTray:
    """Create the tray icon lazily so headless/source commands stay dependency-free."""

    if pystray_module is None:
        import pystray as pystray_module
    if image_module is None:
        from PIL import Image as image_module

    image = image_module.open(icon_path).convert("RGBA")
    double_click = DoubleClickActivation(lambda: command("show"))
    menu = pystray_module.Menu(
        # pystray invokes the default item for a left-click activation. Keep
        # that item out of the context menu and gate it on two quick clicks.
        pystray_module.MenuItem(
            "Mở TKBCherry Agent",
            double_click,
            default=True,
            visible=False,
        ),
        pystray_module.MenuItem(
            "Mở TKBCherry Agent",
            lambda _icon, _item: command("show"),
        ),
        pystray_module.Menu.SEPARATOR,
        pystray_module.MenuItem(
            "Bật Agent",
            lambda _icon, _item: command("on"),
            enabled=lambda _item: not is_on(),
        ),
        pystray_module.MenuItem(
            "Tắt Agent",
            lambda _icon, _item: command("off"),
            enabled=lambda _item: is_on(),
        ),
        pystray_module.Menu.SEPARATOR,
        pystray_module.MenuItem(
            "Thoát",
            lambda _icon, _item: command("exit"),
        ),
    )
    return SystemTray(
        pystray_module.Icon(
            "TKBCherryAgent",
            image,
            "TKBCherry Agent",
            menu,
        )
    )
