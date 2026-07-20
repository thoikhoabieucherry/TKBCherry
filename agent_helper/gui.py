"""Small native ON/OFF window for the Windows Agent."""

from __future__ import annotations

import queue
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any


StatusCallback = Callable[[str], None]
SessionRunner = Callable[[threading.Event, StatusCallback], None]
StartupToggle = Callable[[bool], object]
UpdateChecker = Callable[[], object | None]
UpdateInstaller = Callable[[object], object]
UPDATE_RECHECK_MILLISECONDS = 6 * 60 * 60 * 1000


_STATUS_TEXT = {
    "starting": "Đang khởi động Agent...",
    "pairing": "Đang chờ bạn xác nhận trên trình duyệt...",
    "waiting": "Đã kết nối · đang chờ lượt xếp",
    "working": "Đang hỗ trợ xếp thời khóa biểu",
    "stopping": "Đang dừng Agent...",
    "updating": "Đang cập nhật Agent an toàn...",
    "off": "Agent đang tắt · không sử dụng CPU để xếp",
    "error": "Agent đã dừng do có lỗi kết nối",
}


def agent_icon_path() -> Path:
    """Locate the same TKBCherry logo in source and in a PyInstaller bundle."""

    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        candidates = [bundle_root / "agent_helper" / "assets" / "favicon-cherry.png"]
    else:
        repository_root = Path(__file__).resolve().parents[1]
        candidates = [repository_root / "web" / "assets" / "favicon-cherry.png"]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("TKBCherry Agent icon is missing")


class AgentToggleApp:
    """Own the UI thread while one daemon worker session runs at a time."""

    def __init__(
        self,
        root: Any,
        session_runner: SessionRunner,
        *,
        cpu_workers: int,
        tk_module: Any,
        max_memory_mb: int = 4096,
        startup_toggle: StartupToggle | None = None,
        update_checker: UpdateChecker | None = None,
        update_installer: UpdateInstaller | None = None,
    ) -> None:
        self.root = root
        self.session_runner = session_runner
        self.cpu_workers = max(1, int(cpu_workers))
        self.max_memory_mb = max(512, int(max_memory_mb))
        self.tk = tk_module
        self.startup_toggle = startup_toggle
        self.update_checker = update_checker
        self.update_installer = update_installer
        self.events: queue.SimpleQueue[tuple[int, str]] = queue.SimpleQueue()
        self.update_events: queue.SimpleQueue[tuple[str, object | None]] = queue.SimpleQueue()
        self.commands: queue.SimpleQueue[str] = queue.SimpleQueue()
        self.stop_event: threading.Event | None = None
        self.worker_thread: threading.Thread | None = None
        self.tray: Any | None = None
        self.window_icon: Any | None = None
        self.generation = 0
        self.desired_on = False
        self.closing = False
        self.current_state = "off"
        self.available_update: object | None = None
        self.update_check_thread: threading.Thread | None = None
        self.update_apply_thread: threading.Thread | None = None
        self.update_in_progress = False
        self.update_install_started = False
        self.restart_after_stop = False
        self.dismissed_update_versions: set[str] = set()
        self._build_window()
        self._render("off")
        # Let Tk finish constructing the window, then enter ON immediately on
        # the first event-loop turn. Pairing/network work never blocks paint.
        self.root.after(0, self.turn_on)
        self.root.after(100, self._drain_events)
        if self.update_checker is not None and self.update_installer is not None:
            self.root.after(1500, self._start_update_check)

    def _build_window(self) -> None:
        tk = self.tk
        self.root.title("TKBCherry Agent")
        self.root.configure(bg="#f6f7fb")
        self.root.resizable(False, False)
        self.root.geometry("430x330")
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        try:
            self.window_icon = tk.PhotoImage(file=str(agent_icon_path()))
            self.root.iconphoto(True, self.window_icon)
        except Exception:
            self.window_icon = None

        frame = tk.Frame(self.root, bg="#f6f7fb", padx=28, pady=24)
        frame.pack(fill="both", expand=True)
        tk.Label(
            frame,
            text="TKBCherry Agent",
            bg="#f6f7fb",
            fg="#172033",
            font=("Segoe UI Semibold", 18),
        ).pack(anchor="w")
        tk.Label(
            frame,
            text="Chỉ dùng tài nguyên máy khi bạn bật Agent và có lượt xếp.",
            bg="#f6f7fb",
            fg="#667085",
            font=("Segoe UI", 9),
            wraplength=365,
            justify="left",
        ).pack(anchor="w", pady=(5, 20))

        card = tk.Frame(
            frame,
            bg="#ffffff",
            highlightbackground="#dfe3eb",
            highlightthickness=1,
            padx=20,
            pady=18,
        )
        card.pack(fill="x")
        self.badge = tk.Label(
            card,
            text="OFF",
            width=6,
            bg="#e8eaf0",
            fg="#4b5565",
            font=("Segoe UI Semibold", 11),
            padx=8,
            pady=5,
        )
        self.badge.pack(anchor="w")
        self.status_label = tk.Label(
            card,
            text="",
            bg="#ffffff",
            fg="#344054",
            font=("Segoe UI", 10),
            wraplength=325,
            justify="left",
        )
        self.status_label.pack(anchor="w", pady=(14, 4))
        self.detail_label = tk.Label(
            card,
            text=(
                f"Trần cho phép: {self.cpu_workers} CPU · "
                f"{self.max_memory_mb / 1024:.1f} GB RAM · tự cân theo lượt."
            ),
            bg="#ffffff",
            fg="#8a94a6",
            font=("Segoe UI", 8),
        )
        self.detail_label.pack(anchor="w")

        self.toggle_button = tk.Button(
            frame,
            command=self.toggle,
            relief="flat",
            borderwidth=0,
            cursor="hand2",
            font=("Segoe UI Semibold", 11),
            padx=18,
            pady=11,
        )
        self.toggle_button.pack(fill="x", pady=(18, 0))

        self.root.update_idletasks()
        width = self.root.winfo_width()
        height = self.root.winfo_height()
        x = max(0, (self.root.winfo_screenwidth() - width) // 2)
        y = max(0, (self.root.winfo_screenheight() - height) // 2)
        self.root.geometry(f"{width}x{height}+{x}+{y}")

    def _render(self, state: str) -> None:
        self.current_state = state
        on = self.desired_on and state not in {"off", "stopping", "error"}
        updating = state == "updating"
        self.badge.configure(
            text="UPDATE" if updating else ("ON" if on else "OFF"),
            bg="#fff3cd" if updating else ("#d9fbe7" if on else "#e8eaf0"),
            fg="#8a5b00" if updating else ("#08783e" if on else "#4b5565"),
        )
        self.status_label.configure(text=_STATUS_TEXT.get(state, _STATUS_TEXT["off"]))
        if updating:
            self.toggle_button.configure(
                text="ĐANG CẬP NHẬT...",
                state="disabled",
                bg="#ead9a8",
                fg="#725000",
                activebackground="#ead9a8",
            )
        elif state == "stopping":
            self.toggle_button.configure(
                text="ĐANG TẮT...",
                state="disabled",
                bg="#d7dae2",
                fg="#667085",
                activebackground="#d7dae2",
            )
        elif on:
            self.toggle_button.configure(
                text="TẮT AGENT",
                state="normal",
                bg="#e7e9ef",
                fg="#273142",
                activebackground="#d8dce5",
                activeforeground="#172033",
            )
        else:
            self.toggle_button.configure(
                text="BẬT AGENT",
                state="normal",
                bg="#6c4cff",
                fg="#ffffff",
                activebackground="#593ae8",
                activeforeground="#ffffff",
            )
        if self.tray is not None:
            self.tray.update(on)

    def attach_tray(self, tray: Any) -> None:
        """Attach a notification icon and make the window close button hide."""

        self.tray = tray
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)
        self.tray.start()
        self.tray.update(self.desired_on)

    def request_tray_command(self, command: str) -> None:
        if command in {"show", "on", "off", "exit"}:
            self.commands.put(command)

    def show_window(self) -> None:
        if self.closing:
            return
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()
        except Exception:
            return

    def hide_window(self) -> None:
        if self.closing:
            return
        try:
            self.root.withdraw()
        except Exception:
            self.close()

    def toggle(self) -> None:
        if self.update_in_progress:
            return
        if self.desired_on:
            self.turn_off()
        else:
            self.turn_on()

    def _set_startup_enabled(self, enabled: bool) -> None:
        callback = getattr(self, "startup_toggle", None)
        if callback is None:
            return
        try:
            callback(enabled)
        except Exception:
            # Startup registration is a convenience. A locked-down registry
            # must not prevent the user from running or stopping the Agent.
            return

    def turn_on(self) -> None:
        if self.closing or self.desired_on or self.update_in_progress:
            return
        if self.worker_thread is not None and self.worker_thread.is_alive():
            # OFF is immediate from the user's perspective, while an in-flight
            # socket may need a short grace period to unwind. Remember a quick
            # ON request and start a fresh session as soon as it has stopped.
            self.restart_after_stop = True
            self.desired_on = True
            self._set_startup_enabled(True)
            self._render("starting")
            return
        self._set_startup_enabled(True)
        self.restart_after_stop = False
        self.generation += 1
        generation = self.generation
        self.desired_on = True
        self.stop_event = threading.Event()
        self._render("starting")

        def emit(status: str) -> None:
            self.events.put((generation, status))

        def run() -> None:
            try:
                assert self.stop_event is not None
                self.session_runner(self.stop_event, emit)
            except Exception:
                emit("error")
            finally:
                emit("stopped")

        self.worker_thread = threading.Thread(
            target=run,
            name="TKBCherryAgentWorker",
            daemon=True,
        )
        self.worker_thread.start()

    def turn_off(self) -> None:
        if not self.desired_on or self.update_in_progress:
            return
        self.desired_on = False
        self.restart_after_stop = False
        self._set_startup_enabled(False)
        if self.stop_event is not None:
            self.stop_event.set()
        # Solver cancellation is synchronous and network retry waits observe
        # the same event. Paint OFF immediately instead of making the user wait
        # for a harmless long-poll socket to finish closing.
        self._render("off")

    def _drain_events(self) -> None:
        while True:
            try:
                command = self.commands.get_nowait()
            except queue.Empty:
                break
            if command == "show":
                self.show_window()
            elif command == "on":
                self.turn_on()
            elif command == "off":
                self.turn_off()
            elif command == "exit":
                self.close()
                return
        while True:
            try:
                generation, status = self.events.get_nowait()
            except queue.Empty:
                break
            if generation != self.generation:
                continue
            if status == "stopped":
                restart = self.restart_after_stop and self.desired_on
                self.worker_thread = None
                self.stop_event = None
                if self.update_in_progress:
                    self._start_update_install()
                elif restart:
                    self.restart_after_stop = False
                    self.desired_on = False
                    self.turn_on()
                elif self.desired_on:
                    self.desired_on = False
                    self._render("error")
                else:
                    self._render("off")
            elif self.desired_on:
                self._render(status)
        while True:
            try:
                event, payload = self.update_events.get_nowait()
            except queue.Empty:
                break
            if event == "available":
                self.available_update = payload
            elif event == "check_complete":
                self.update_check_thread = None
                if not self.closing:
                    self.root.after(
                        UPDATE_RECHECK_MILLISECONDS, self._start_update_check
                    )
            elif event == "installed":
                self.close()
                return
            elif event == "install_error":
                self._handle_update_error(payload)
        self._offer_update_if_idle()
        if not self.closing:
            self.root.after(100, self._drain_events)

    @staticmethod
    def _release_version(release: object | None) -> str:
        value = getattr(release, "version", "")
        return value if isinstance(value, str) else ""

    def _start_update_check(self) -> None:
        if (
            self.closing
            or self.update_checker is None
            or self.update_check_thread is not None
        ):
            return

        def run() -> None:
            try:
                release = self.update_checker()
            except Exception:
                # Update-server trouble must never stop an otherwise healthy Agent.
                release = None
            if release is not None:
                self.update_events.put(("available", release))
            self.update_events.put(("check_complete", None))

        self.update_check_thread = threading.Thread(
            target=run,
            name="TKBCherryAgentUpdateCheck",
            daemon=True,
        )
        self.update_check_thread.start()

    def _ask_to_update(self, version: str) -> bool:
        try:
            from tkinter import messagebox

            return bool(
                messagebox.askokcancel(
                    "Cập nhật TKBCherry Agent",
                    (
                        f"Đã có TKBCherry Agent {version}.\n\n"
                        "Bấm OK để Agent tự tải, kiểm tra và cập nhật ngay."
                    ),
                    parent=self.root,
                )
            )
        except Exception:
            return False

    def _show_update_error(self, message: str) -> None:
        try:
            from tkinter import messagebox

            messagebox.showerror(
                "Cập nhật TKBCherry Agent",
                "Không thể cập nhật an toàn. Agent cũ vẫn được giữ nguyên.\n\n"
                + message,
                parent=self.root,
            )
        except Exception:
            return

    def _offer_update_if_idle(self) -> None:
        release = self.available_update
        version = self._release_version(release)
        if (
            release is None
            or not version
            or version in self.dismissed_update_versions
            or self.closing
            or self.update_in_progress
            or not self.desired_on
            or self.current_state != "waiting"
        ):
            return
        self.dismissed_update_versions.add(version)
        if not self._ask_to_update(version):
            return
        self.update_in_progress = True
        self.update_install_started = False
        self.desired_on = False
        if self.stop_event is not None:
            self.stop_event.set()
        self._render("updating")
        if self.worker_thread is None or not self.worker_thread.is_alive():
            self.worker_thread = None
            self.stop_event = None
            self._start_update_install()

    def _start_update_install(self) -> None:
        if (
            self.closing
            or not self.update_in_progress
            or self.update_install_started
            or self.update_installer is None
            or self.available_update is None
        ):
            return
        self.update_install_started = True
        release = self.available_update

        def run() -> None:
            try:
                self.update_installer(release)
            except Exception as exc:
                message = " ".join(str(exc).split())[:500] or "Lỗi không xác định."
                self.update_events.put(("install_error", message))
                return
            self.update_events.put(("installed", None))

        self.update_apply_thread = threading.Thread(
            target=run,
            name="TKBCherryAgentUpdateInstall",
            daemon=True,
        )
        self.update_apply_thread.start()

    def _handle_update_error(self, payload: object | None) -> None:
        message = str(payload or "Lỗi không xác định.")
        self.update_in_progress = False
        self.update_install_started = False
        self.update_apply_thread = None
        self.available_update = None
        self._show_update_error(message)
        self.turn_on()

    def close(self) -> None:
        if self.closing:
            return
        self.closing = True
        self.desired_on = False
        self.restart_after_stop = False
        if self.stop_event is not None:
            self.stop_event.set()
        if self.tray is not None:
            self.tray.stop()
        self.root.destroy()


def run_toggle_window(
    session_runner: SessionRunner,
    *,
    cpu_workers: int,
    max_memory_mb: int,
    startup_toggle: StartupToggle | None = None,
    start_hidden: bool = False,
    update_checker: UpdateChecker | None = None,
    update_installer: UpdateInstaller | None = None,
) -> None:
    """Open the native Agent window. Import Tk only for the normal GUI path."""

    import tkinter as tk

    root = tk.Tk()
    # Every launch behaves like a small tray utility: start ON without showing
    # a window. The user opens the control panel by double-clicking the icon.
    root.withdraw()
    app = AgentToggleApp(
        root,
        session_runner,
        cpu_workers=cpu_workers,
        tk_module=tk,
        max_memory_mb=max_memory_mb,
        startup_toggle=startup_toggle,
        update_checker=update_checker,
        update_installer=update_installer,
    )
    try:
        from .tray import create_system_tray

        app.attach_tray(
            create_system_tray(
                agent_icon_path(),
                app.request_tray_command,
                lambda: app.desired_on,
            )
        )
    except Exception:
        # If the optional tray cannot start, never leave a hidden process the
        # user cannot control. The normal window remains fully functional.
        app.show_window()
    root.mainloop()
