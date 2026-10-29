"""Cherry trên máy này — bộ giải engine v3 chạy bằng CPU của máy người dùng.

27/10/2026 (chủ dự án: "có 1 nút trạng thái, bật thì luôn máy chủ, tắt thì dùng local"):
trang Sắp xếp trên tkbcherry.com có nút gạt "Máy chủ / Máy này". Ở chế độ "Máy này"
bridge (web/pages/tkb-rust-bridge.js) gửi mọi lượt giải (Cherry, Tối ưu v3) tới
http://127.0.0.1:2211 thay vì máy chủ; dữ liệu trường vẫn lưu trên tkbcherry.com
như cũ — máy này chỉ GIẢI, không giữ kho.

Chỉ có các endpoint của hợp đồng giải mà bridge dùng (solver_jobs.SolverManager mô
phỏng rust_api): /api/health, /api/solve-data, /api/solve-result, /api/solver-state,
/api/solve-cancel, /api/solve-precheck. Chỉ nghe 127.0.0.1, giữ cổng ĐỘC QUYỀN (bản thứ hai tự thoát) và chỉ trả lời
trang có Origin nằm trong danh sách cho phép (mặc định tkbcherry.com + localhost) —
trang lạ mở trong cùng trình duyệt không gửi được lượt giải hay đọc kết quả.

Bộ cài (installer/) chạy file này bằng pythonw.exe kèm --background: không cửa sổ,
tự bật cùng Windows, giao thức cherry-local:// để trang web đánh thức.

Chạy:  python cherry_local_solver.py [--port 2211] [--workers N] [--allow-origin URL ...]
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from solver_jobs import SolverManager  # noqa: E402
from updater import Updater  # noqa: E402

VERSION = "cherry-local-solver-v3"
# 2210 là cổng của Cherry Local (bản chạy cả web trong máy) -> bộ giải dùng 2211 để hai bản cùng sống được.
DEFAULT_PORT = 2211
DEFAULT_ORIGINS = ("https://tkbcherry.com", "https://www.tkbcherry.com")
MAX_BODY_BYTES = 64 * 1024 * 1024
# Bản thử nghiệm (vd trang Netlify) thêm Origin ở đây, mỗi dòng một địa chỉ https://… — không
# cần sửa mã. Dòng trống / bắt đầu bằng # bị bỏ qua.
EXTRA_ORIGINS_FILE = HERE / "allowed_origins.txt"


def find_solver_runtime(explicit: str | None = None) -> Path:
    """Gói phát cho trường: solver_runtime/ nằm cạnh file này; chạy từ repo: ../../solver_runtime."""
    candidates = [Path(explicit)] if explicit else []
    candidates += [HERE / "solver_runtime", HERE.parent.parent / "solver_runtime"]
    for cand in candidates:
        if (cand / "scripts" / "solve_stdio.py").exists() or (cand / "scripts" / "solve_stdio.pyc").exists():
            return cand.resolve()
    return candidates[0] if candidates else HERE / "solver_runtime"


def extra_origins(path: Path = EXTRA_ORIGINS_FILE) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#") and line.lower().startswith("https://"):
            out.append(line)
    return out


def origin_allowed(origin: str, allowed: tuple[str, ...]) -> bool:
    origin = str(origin or "").strip().rstrip("/").lower()
    if not origin:
        # Không có Origin = công cụ dòng lệnh trên chính máy này (curl, test), không phải trang web.
        return True
    if origin in allowed:
        return True
    parts = urlsplit(origin)
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")


class ExclusiveServer(ThreadingHTTPServer):
    """Windows: SO_REUSEADDR (mặc định của HTTPServer) cho HAI tiến trình cùng nghe một cổng
    mà không báo lỗi — bản bật cùng Windows và bản do cherry-local:// đánh thức sẽ chạy song
    song. Giữ cổng độc quyền để bản thứ hai nhận lỗi bind rồi tự thoát."""

    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_handler(manager: SolverManager, allowed: tuple[str, ...], updater: Updater | None = None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CherryLocalSolver/2"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: N802 - im lặng, không ghi dữ liệu trường ra màn hình
            return

        def _origin(self) -> str:
            return str(self.headers.get("Origin") or "").strip()

        def _send(self, status: int, payload: dict | None = None, *, body: bytes | None = None,
                  content_type: str = "application/json; charset=utf-8") -> None:
            if body is None:
                body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            origin = self._origin()
            if origin and origin_allowed(origin, allowed):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def _guard(self) -> bool:
            if origin_allowed(self._origin(), allowed):
                return True
            self._send(403, {"ok": False, "kind": "origin_not_allowed",
                             "error": "Trang này không được phép dùng bộ giải trên máy."})
            return False

        def _body(self) -> bytes | None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length < 0 or length > MAX_BODY_BYTES:
                self._send(413, {"ok": False, "kind": "payload_too_large", "error": "Dữ liệu gửi quá lớn."})
                return None
            return self.rfile.read(length) if length else b""

        def do_OPTIONS(self):  # noqa: N802
            if not self._guard():
                return
            self._send(204)

        def do_GET(self):  # noqa: N802
            if not self._guard():
                return
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            job_id = (query.get("jobId") or query.get("solve_run_id") or [""])[0]
            if parts.path == "/api/health":
                # bridge (probeRustApiBase) chỉ nhận máy giải trả api:"rust".
                payload = {"ok": True, "api": "rust", "localSolver": True, "version": VERSION,
                           "solverAvailable": manager.available(), "workers": manager.workers,
                           "cpuCount": os.cpu_count() or 0}
                if updater is not None:
                    payload.update(updater.info())
                self._send(200, payload)
                if self._origin():
                    # 29/10: trang Sap xep dang mo -> nap san tien trinh bo giai cho cu bam Cherry
                    manager.prewarm()
            elif parts.path == "/api/solver-state":
                self._send(200, manager.state(job_id))
            elif parts.path == "/api/solve-result":
                status, payload = manager.result(job_id)
                self._send(status, payload)
            else:
                self._send(404, {"ok": False, "kind": "not_found", "error": "not_found"})

        def do_POST(self):  # noqa: N802
            # Đọc hết thân yêu cầu TRƯỚC khi từ chối: trả 403 khi còn dữ liệu chưa đọc làm Windows
            # reset kết nối (client thấy ConnectionResetError thay vì 403).
            body = self._body()
            if body is None:
                return
            if not self._guard():
                return
            path = urlsplit(self.path).path
            if path == "/api/solve-data":
                status, payload = manager.start(body)
                self._send(status, payload)
            elif path == "/api/solve-cancel":
                self._send(200, manager.cancel(body))
            elif path == "/api/solve-precheck":
                # Máy chủ Rust kiểm sức chứa trước khi giải; bản local để engine tự báo thiếu chỗ.
                self._send(200, {"ok": True, "blocked": False, "localSolver": True})
            else:
                self._send(404, {"ok": False, "kind": "not_found", "error": "not_found"})

    return Handler


def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as resp:
            return bool(json.loads(resp.read() or b"{}").get("localSolver"))
    except Exception:
        return False


def write_log(log_dir: Path, message: str) -> None:
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(log_dir / "cherry.log", "a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")
    except OSError:
        pass


def app_url() -> str:
    """Trang TKB mà menu khay mở: trang thử nghiệm ghi trong allowed_origins.txt nếu có."""
    extra = extra_origins()
    return (extra[0].rstrip("/") if extra else DEFAULT_ORIGINS[0]) + "/app"


def tray_image():
    from PIL import Image, ImageDraw

    try:
        return Image.open(HERE / "cherry.png").convert("RGBA")
    except Exception:
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse((8, 14, 56, 62), fill=(239, 30, 60, 255))
        return img


def restart_args(argv: list[str]) -> list[str]:
    """Tham số để bật lại sau khi tự cập nhật: bỏ --first-run và --wake <url>."""
    out: list[str] = []
    skip = False
    for a in argv:
        if skip:
            skip = False
            if not a.startswith("--"):
                continue
        if a == "--first-run":
            continue
        if a == "--wake":
            skip = True
            continue
        if a.startswith("--wake="):
            continue
        out.append(a)
    return out


def run_tray(server, manager: SolverManager, port: int, first_run: bool, log_dir: Path,
             updater: Updater | None = None) -> bool:
    """27/10 (chủ dự án: "làm như phần mềm hỗ trợ thu nhỏ vào taskbar"): biểu tượng 🍒 ở khay
    hệ thống cạnh đồng hồ — trạng thái, mở TKB Cherry, Thoát (trang kiểm tra đã bỏ theo yêu cầu). Máy chủ giải chạy
    ở luồng nền; khay giữ luồng chính. Thiếu pystray/Pillow -> trả False (chạy ngầm như cũ)."""

    try:
        import pystray
    except Exception as exc:  # noqa: BLE001
        write_log(log_dir, f"khong co khay he thong: {exc}")
        return False
    import threading
    import webbrowser

    def busy() -> bool:
        try:
            return bool(manager.state().get("busy"))
        except Exception:
            return False

    def status_text(_item=None) -> str:
        return "Đang xếp thời khóa biểu…" if busy() else f"Sẵn sàng — {manager.workers} luồng giải"

    def open_app(_icon=None, _item=None):
        webbrowser.open(app_url())

    stopped = threading.Event()

    def quit_app(icon, _item=None):
        stopped.set()
        icon.visible = False
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(status_text, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Mở TKB Cherry", open_app, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Thoát Cherry", quit_app),
    )
    icon = pystray.Icon("Cherry", tray_image(), "Cherry", menu)
    threading.Thread(target=server.serve_forever, name="cherry-local-http", daemon=True).start()
    if updater is not None:
        def _notify(text: str) -> None:
            icon.notify(text, "Cherry")

        def _restart() -> None:
            stopped.set()
            icon.visible = False
            icon.stop()

        updater.notify = _notify
        updater.on_restart = _restart

    def watch(icon_):
        icon_.visible = True
        if first_run:
            try:
                icon_.notify("Cherry đã chạy ngầm ở đây (🍒). Trang TKB tự nhận và xếp tiếp — không cần bấm lại.", "Cherry")
            except Exception:
                pass
        last = None
        while not stopped.wait(2):
            text = "Cherry — " + status_text()
            if text != last:
                icon_.title = text
                last = text

    try:
        icon.run(setup=watch)
    finally:
        stopped.set()
        server.shutdown()
        server.server_close()
    return True


def main(argv: list[str] | None = None) -> int:
    # Cửa sổ cmd tiếng Anh dùng cp1252: in tiếng Việt sẽ sập ngay lúc khởi động.
    # pythonw.exe (chạy ngầm) không có stdout -> print bỏ qua, reconfigure cũng bỏ qua.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Cherry — bộ giải engine v3 chạy trên máy người dùng.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("CHERRY_LOCAL_PORT", DEFAULT_PORT)))
    ap.add_argument("--workers", type=int, default=int(os.environ.get("CHERRY_LOCAL_WORKERS", 0) or 0),
                    help="số tiến trình/luồng giải (mặc định min(8, số nhân - 1))")
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="thêm Origin được phép (vd https://staging.tkbcherry.com)")
    ap.add_argument("--solver-runtime", default=None, help="đường dẫn thư mục solver_runtime")
    ap.add_argument("--background", action="store_true", help="chạy ngầm (bộ cài dùng): ghi log ra file")
    ap.add_argument("--wake", nargs="?", const="", default=None,
                    help="được gọi qua cherry-local:// — đã chạy rồi thì thoát êm")
    ap.add_argument("--tray", action="store_true", help="hiện biểu tượng 🍒 ở khay hệ thống (bộ cài dùng)")
    ap.add_argument("--first-run", action="store_true", help="vừa cài xong: báo một thông báo ở khay")
    args = ap.parse_args(argv)

    log_dir = HERE / "logs"
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if args.wake is not None and already_running(args.port):
        return 0
    runtime = find_solver_runtime(args.solver_runtime)
    manager = SolverManager(runtime, log_dir, workers=args.workers or None)
    if not manager.available():
        msg = f"Không thấy {manager.script}. Thiếu thư mục solver_runtime."
        print(f"[Cherry] {msg}", file=sys.stderr)
        write_log(log_dir, msg)
        return 2
    allowed = tuple(
        o.strip().rstrip("/").lower()
        for o in (*DEFAULT_ORIGINS, *extra_origins(), *args.allow_origin)
        if o.strip()
    )
    try:
        server = ExclusiveServer(("127.0.0.1", args.port), make_handler(manager, allowed))
    except OSError as exc:
        if already_running(args.port):
            return 0  # bản khác đang chạy: đúng ý, thoát êm
        msg = f"Không mở được cổng {args.port}: {exc}"
        print(f"[Cherry] {msg}", file=sys.stderr)
        write_log(log_dir, msg)
        return 3
    ready = f"Sẵn sàng tại http://127.0.0.1:{args.port} — {manager.workers} luồng giải."
    print(f"[Cherry] {ready}", flush=True)
    print("[Cherry] Trên trang Sắp xếp, bấm Cherry. Ctrl+C để dừng.", flush=True)
    updater = None
    if args.background:
        write_log(log_dir, ready)
        # 28/10: bản cài (Cherry.exe) tự cập nhật phần engine — xem updater.py
        updater = Updater(HERE, lambda: bool(manager.state().get("busy")), lambda m: write_log(log_dir, m),
                          restart_args(raw_argv))
        server.RequestHandlerClass = make_handler(manager, allowed, updater)
        updater.on_restart = lambda: (manager.close(), server.shutdown())
        updater.start()
    if args.tray and run_tray(server, manager, args.port, args.first_run, log_dir, updater):
        manager.close()
        return 0
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        manager.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
