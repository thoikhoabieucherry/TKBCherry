from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any, Callable
from urllib.error import URLError
from urllib.request import urlopen


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = app_root()
WEB_ROOT = ROOT / "web"
RUST_DIR = ROOT / "rust_api"
RUST_RELEASE_EXE = RUST_DIR / "target" / "release" / "tkb_rust_api.exe"
RUST_DEBUG_EXE = RUST_DIR / "target" / "debug" / "tkb_rust_api.exe"
RUST_PREBUILT_DIR = RUST_DIR / "prebuilt" / "windows-x64"
RUST_PREBUILT_EXE = RUST_PREBUILT_DIR / "tkb_rust_api.exe"
RUST_PREBUILT_MANIFEST = RUST_PREBUILT_DIR / "manifest.json"
RUST_SQLITE_VENDOR_DIR = RUST_DIR / "vendor" / "sqlite3"
RUST_SQLITE_IMPORT_LIB = RUST_SQLITE_VENDOR_DIR / "sqlite3.lib"
RUST_SQLITE_RUNTIME_DLL = RUST_SQLITE_VENDOR_DIR / "sqlite3.dll"
PREBUILT_MANIFEST_SCHEMA = 1


def load_dotenv_file() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


load_dotenv_file()


class _NullWriter:
    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        return None


if sys.stdout is None:
    sys.stdout = _NullWriter()  # type: ignore[assignment]
if sys.stderr is None:
    sys.stderr = _NullWriter()  # type: ignore[assignment]
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(errors="replace")
    except (AttributeError, OSError):
        pass


StatusCallback = Callable[[str], None]


def emit_status(callback: StatusCallback | None, message: str) -> None:
    print(message, flush=True)
    if callback:
        try:
            callback(message)
        except Exception:
            pass


def rust_source_paths() -> list[Path]:
    paths = list((RUST_DIR / "src").glob("**/*.rs"))
    for name in ("Cargo.toml", "Cargo.lock"):
        path = RUST_DIR / name
        if path.exists():
            paths.append(path)
    return paths


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rust_source_digest() -> str:
    digest = hashlib.sha256()
    paths = sorted(
        rust_source_paths(),
        key=lambda path: path.relative_to(RUST_DIR).as_posix(),
    )
    for path in paths:
        relative = path.relative_to(RUST_DIR).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
        digest.update(b"\0")
    return digest.hexdigest()


def prebuilt_backend_manifest_is_valid() -> bool:
    if not RUST_PREBUILT_EXE.is_file():
        return False
    try:
        manifest = json.loads(RUST_PREBUILT_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(manifest, dict):
        return False
    try:
        source_digest = rust_source_digest()
        binary_digest = file_sha256(RUST_PREBUILT_EXE)
    except OSError:
        return False
    return bool(
        manifest.get("schema") == PREBUILT_MANIFEST_SCHEMA
        and manifest.get("target") == "x86_64-pc-windows-gnu"
        and manifest.get("sourceSha256") == source_digest
        and manifest.get("binarySha256") == binary_digest
    )


def prebuilt_backend_is_valid() -> bool:
    return os.name == "nt" and prebuilt_backend_manifest_is_valid()


def executable_is_stale(path: Path | None) -> bool:
    if path is None or not path.exists():
        return True
    try:
        if path.resolve() == RUST_PREBUILT_EXE.resolve():
            return not prebuilt_backend_is_valid()
    except OSError:
        return True
    try:
        built_at = path.stat().st_mtime
    except OSError:
        return True
    return any(source.stat().st_mtime > built_at + 0.5 for source in rust_source_paths())


def executable_candidates() -> tuple[Path, ...]:
    local_builds = (RUST_RELEASE_EXE, RUST_DEBUG_EXE)
    if os.name == "nt":
        return local_builds + (RUST_PREBUILT_EXE,)
    return local_builds


def cargo_candidates() -> list[str]:
    home = Path.home()
    raw = [
        os.environ.get("CARGO", ""),
        str(home / ".cargo" / "bin" / "cargo.exe"),
        str(home / ".cache" / "codex-rust" / "cargo" / "bin" / "cargo.exe"),
        "cargo",
    ]
    found: list[str] = []
    for candidate in raw:
        if not candidate or candidate in found:
            continue
        if candidate != "cargo" and not Path(candidate).exists():
            continue
        if candidate == "cargo" and shutil.which(candidate) is None:
            continue
        found.append(candidate)
    return found


def build_timeout_seconds() -> int:
    raw = os.environ.get("TKB_RUST_BUILD_TIMEOUT", "600")
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        value = 600
    return max(30, min(1800, value))


def rust_build_env() -> dict[str, str]:
    env = os.environ.copy()
    if os.name == "nt" and RUST_SQLITE_IMPORT_LIB.exists():
        vendor_dir = str(RUST_SQLITE_VENDOR_DIR)
        env["SQLITE3_LIB_DIR"] = vendor_dir
        env["SQLITE3_DYNAMIC"] = "1"
        current_flags = env.get("RUSTFLAGS", "").strip()
        native_flag = f"-L native={vendor_dir}"
        if native_flag not in current_flags:
            env["RUSTFLAGS"] = f"{current_flags} {native_flag}".strip()
    return env


def build_backend_if_needed() -> Path:
    fresh = next((path for path in executable_candidates() if path.exists() and not executable_is_stale(path)), None)
    if fresh is not None:
        return fresh

    manifest = RUST_DIR / "Cargo.toml"
    failures: list[str] = []
    for cargo in cargo_candidates():
        emit_status(None, f"Backend web cần build lại; đang dùng {cargo}...")
        try:
            result = subprocess.run(
                [cargo, "build", "--release", "--locked", "--manifest-path", str(manifest)],
                cwd=str(ROOT),
                env=rust_build_env(),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=build_timeout_seconds(),
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(f"{cargo}: {error}")
            continue
        if result.returncode == 0 and RUST_RELEASE_EXE.exists():
            return RUST_RELEASE_EXE
        failures.append(f"{cargo}: exit {result.returncode}\n{(result.stdout or '')[-2000:]}")

    stale = next((path for path in executable_candidates() if path.exists()), None)
    if stale is not None:
        details = "\n".join(failures[-2:])
        raise RuntimeError(
            "Bản máy chủ web hiện có không khớp mã nguồn. Hãy tải lại bộ ứng dụng "
            "đầy đủ; nhà phát triển có thể cài Cargo để build lại.\n" + details
        )
    raise RuntimeError(
        "Thiếu bản chạy Windows đi kèm. Hãy tải lại đầy đủ thư mục rust_api/prebuilt. "
        "Nếu đang phát triển mã Rust, hãy cài Cargo để build lại."
    )


def add_sqlite_runtime_to_env(env: dict[str, str]) -> None:
    if os.name != "nt":
        return
    if not RUST_SQLITE_RUNTIME_DLL.is_file():
        raise RuntimeError("Thiếu SQLite runtime đi kèm: rust_api/vendor/sqlite3/sqlite3.dll")
    vendor_dir = str(RUST_SQLITE_VENDOR_DIR)
    current_path = env.get("PATH", "")
    path_parts = [part for part in current_path.split(os.pathsep) if part]
    if not any(os.path.normcase(part) == os.path.normcase(vendor_dir) for part in path_parts):
        env["PATH"] = vendor_dir + (os.pathsep + current_path if current_path else "")


def listener_pids(port: int) -> set[int]:
    if os.name != "nt":
        return set()
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return set()
    suffix = f":{port}"
    pids: set[int] = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        if parts[3].upper() != "LISTENING" or not parts[1].endswith(suffix):
            continue
        try:
            pid = int(parts[-1])
        except ValueError:
            continue
        if pid > 0 and pid != os.getpid():
            pids.add(pid)
    return pids


def stop_pids(pids: set[int]) -> None:
    for pid in sorted(pids):
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            try:
                os.kill(pid, 15)
            except OSError:
                pass


def health_payload(url: str) -> dict[str, Any] | None:
    try:
        with urlopen(f"{url}/api/health", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError, URLError):
        return None


def same_path(left: str | os.PathLike[str], right: str | os.PathLike[str]) -> bool:
    return os.path.normcase(os.path.abspath(str(left))).rstrip("\\/") == os.path.normcase(
        os.path.abspath(str(right))
    ).rstrip("\\/")


def server_is_ready(url: str) -> bool:
    payload = health_payload(url)
    return bool(
        payload
        and payload.get("api") == "rust"
        and payload.get("engine") == "fet-web-worker"
        and same_path(str(payload.get("webRoot") or ""), WEB_ROOT)
    )


def wait_until_ready(url: str, process: subprocess.Popen[Any], timeout_seconds: int) -> bool:
    deadline = time.monotonic() + max(1, timeout_seconds)
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if server_is_ready(url):
            return True
        time.sleep(0.5)
    return False


def start_process(executable: Path, env: dict[str, str], foreground: bool) -> subprocess.Popen[Any]:
    creationflags = 0
    stdout = None
    stderr = None
    if not foreground:
        stdout = subprocess.DEVNULL
        stderr = subprocess.DEVNULL
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(
        [str(executable)],
        cwd=str(RUST_DIR),
        env=env,
        stdout=stdout,
        stderr=stderr,
        creationflags=creationflags,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chạy TKBCherry web FET trên cổng 1010.")
    parser.add_argument("--host", default=os.environ.get("TKB_RUST_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TKB_RUST_PORT", "1010")))
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--foreground", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-launcher", action="store_true")
    parser.add_argument("--no-stop-old", action="store_true")
    return parser.parse_args(argv)


def start_backend(
    args: argparse.Namespace,
    status: StatusCallback | None = None,
) -> tuple[subprocess.Popen[Any], str, Path]:
    url = f"http://{args.host}:{args.port}"
    if not args.no_stop_old:
        emit_status(status, f"Kiểm tra cổng {args.port}...")
        pids = listener_pids(args.port)
        if pids:
            stop_pids(pids)
            time.sleep(0.4)

    emit_status(status, "Chuẩn bị máy chủ web...")
    executable = build_backend_if_needed()
    env = os.environ.copy()
    env.update(
        {
            "TKB_APP_ROOT": str(ROOT),
            "TKB_RUST_HOST": str(args.host),
            "TKB_RUST_PORT": str(args.port),
            "TKB_NO_LOGS": "1",
        }
    )
    add_sqlite_runtime_to_env(env)
    emit_status(status, "Khởi động TKBCherry web FET...")
    process = start_process(executable, env, args.foreground)
    if not wait_until_ready(url, process, args.timeout):
        stop_backend_process(process, args.port)
        raise RuntimeError("Backend không vượt qua kiểm tra /api/health.")
    emit_status(status, f"Sẵn sàng tại {url}/")
    if not args.no_browser:
        webbrowser.open(f"{url}/")
    return process, url, executable


def stop_backend_process(process: subprocess.Popen[Any] | None, port: int) -> None:
    if process is not None and process.poll() is None:
        if os.name == "nt":
            stop_pids({process.pid})
        else:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
    remaining = listener_pids(port)
    if remaining:
        stop_pids(remaining)


def run_launcher_window(args: argparse.Namespace) -> int:
    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception:
        process, _, _ = start_backend(args)
        return 0 if process.poll() is None else int(process.returncode or 1)

    root = tk.Tk()
    root.title("TKBCherry web FET")
    root.geometry("430x235")
    root.resizable(False, False)
    status_var = tk.StringVar(value="Đang khởi động...")
    url_var = tk.StringVar(value=f"http://{args.host}:{args.port}/")
    events: queue.Queue[tuple[str, Any]] = queue.Queue()
    state: dict[str, Any] = {"process": None, "url": url_var.get(), "closing": False}
    exit_code = {"value": 0}

    frame = tk.Frame(root, padx=18, pady=16)
    frame.pack(fill="both", expand=True)
    tk.Label(frame, text="TKBCherry — Web FET", font=("Segoe UI", 13, "bold")).pack(anchor="w")
    tk.Label(frame, text="Bộ xếp lịch chạy trong trình duyệt.", font=("Segoe UI", 9), fg="#555").pack(anchor="w", pady=(5, 0))
    tk.Label(frame, textvariable=status_var, font=("Segoe UI", 10), fg="#135200", wraplength=390, justify="left").pack(anchor="w", pady=(12, 4))
    tk.Label(frame, textvariable=url_var, font=("Segoe UI", 9), fg="#444").pack(anchor="w")

    buttons = tk.Frame(frame)
    buttons.pack(fill="x", pady=(18, 0))
    open_button = tk.Button(buttons, text="Mở phần mềm", width=16, state="disabled")
    open_button.pack(side="left")
    stop_button = tk.Button(buttons, text="Tắt", width=16)
    stop_button.pack(side="left", padx=(10, 0))

    def close_window() -> None:
        if state["closing"]:
            return
        state["closing"] = True
        status_var.set("Đang tắt...")
        open_button.configure(state="disabled")
        stop_button.configure(state="disabled")

        def stop() -> None:
            stop_backend_process(state.get("process"), args.port)
            events.put(("destroy", None))

        threading.Thread(target=stop, daemon=True).start()

    open_button.configure(command=lambda: webbrowser.open(state["url"]))
    stop_button.configure(command=close_window)
    root.protocol("WM_DELETE_WINDOW", close_window)

    def worker() -> None:
        try:
            child_args = argparse.Namespace(**vars(args))
            child_args.no_browser = True
            process, url, _ = start_backend(child_args, lambda message: events.put(("status", message)))
            state["process"] = process
            state["url"] = f"{url}/"
            events.put(("ready", state["url"]))
            code = process.wait()
            if not state["closing"]:
                exit_code["value"] = int(code or 0)
                events.put(("exited", code))
        except Exception as error:
            exit_code["value"] = 1
            events.put(("error", str(error)))

    threading.Thread(target=worker, daemon=True).start()

    def poll_events() -> None:
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == "status":
                    status_var.set(str(payload))
                elif kind == "ready":
                    url_var.set(str(payload))
                    status_var.set("Đang chạy. Đóng cửa sổ này để dừng.")
                    open_button.configure(state="normal")
                    if not args.no_browser:
                        webbrowser.open(str(payload))
                elif kind == "exited":
                    status_var.set("Backend đã dừng.")
                    open_button.configure(state="disabled")
                elif kind == "error":
                    messagebox.showerror("TKBCherry", str(payload))
                    root.destroy()
                    return
                elif kind == "destroy":
                    root.destroy()
                    return
        except queue.Empty:
            pass
        root.after(100, poll_events)

    root.after(100, poll_events)
    root.mainloop()
    return int(exit_code["value"])


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.foreground and not args.no_launcher:
        return run_launcher_window(args)
    try:
        process, _, _ = start_backend(args)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.foreground:
        try:
            return int(process.wait())
        except KeyboardInterrupt:
            stop_backend_process(process, args.port)
            return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
