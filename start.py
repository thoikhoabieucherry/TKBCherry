from __future__ import annotations

import argparse
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
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = app_root()
WEB_ROOT = ROOT / "web"
RUST_DIR = ROOT / "rust_api"
RUST_RELEASE_EXE = RUST_DIR / "target" / "release" / "tkb_rust_api.exe"
RUST_DEBUG_EXE = RUST_DIR / "target" / "debug" / "tkb_rust_api.exe"
RUST_CODEX_GNU_DIR = RUST_DIR / "target-gnu"
RUST_CODEX_GNU_EXE = RUST_CODEX_GNU_DIR / "release" / "tkb_rust_api.exe"
RUST_PREBUILT_EXE = RUST_DIR / "prebuilt" / "tkb_rust_api.exe"
RUST_SQLITE_VENDOR_DIR = RUST_DIR / "vendor" / "sqlite3"
RUST_SQLITE_IMPORT_LIB = RUST_SQLITE_VENDOR_DIR / "sqlite3.lib"
RUST_SQLITE_RUNTIME_DLL = RUST_SQLITE_VENDOR_DIR / "sqlite3.dll"


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


def ensure_standard_streams() -> None:
    if sys.stdout is None:
        sys.stdout = _NullWriter()  # type: ignore[assignment]
    if sys.stderr is None:
        sys.stderr = _NullWriter()  # type: ignore[assignment]


ensure_standard_streams()


StatusCallback = Callable[[str], None]
_CHILD_JOB_HANDLES: list[Any] = []


def emit_status(callback: StatusCallback | None, message: str) -> None:
    print(message, flush=True)
    if callback:
        try:
            callback(message)
        except Exception:
            pass


def rust_exe_candidates(prefer_release: bool = True) -> tuple[Path, ...]:
    release = (RUST_RELEASE_EXE, RUST_CODEX_GNU_EXE, RUST_PREBUILT_EXE, RUST_DEBUG_EXE)
    debug = (RUST_DEBUG_EXE, RUST_RELEASE_EXE, RUST_CODEX_GNU_EXE, RUST_PREBUILT_EXE)
    return release if prefer_release else debug


def startup_rust_exe_candidates(primary: Path | None) -> tuple[Path, ...]:
    """Return launch candidates without discarding an older known-good build."""
    ordered = ((primary,) if primary is not None else ()) + rust_exe_candidates(prefer_release=True)
    candidates: list[Path] = []
    seen: set[str] = set()
    for path in ordered:
        key = os.path.normcase(os.path.abspath(str(path)))
        if key in seen or not path.exists():
            continue
        seen.add(key)
        candidates.append(path)
    return tuple(candidates)


def rust_source_paths() -> list[Path]:
    paths = list((RUST_DIR / "src").glob("**/*.rs"))
    for name in ("Cargo.toml", "Cargo.lock"):
        path = RUST_DIR / name
        if path.exists():
            paths.append(path)
    return paths


def rust_exe(prefer_release: bool = True) -> Path | None:
    return next((path for path in rust_exe_candidates(prefer_release) if path.exists()), None)


def rust_exe_is_stale(path: Path | None) -> bool:
    if path is None or not path.exists():
        return True
    try:
        exe_mtime = path.stat().st_mtime
    except OSError:
        return True
    for src in rust_source_paths():
        try:
            if src.stat().st_mtime > exe_mtime + 0.5:
                return True
        except OSError:
            continue
    return False


def fresh_rust_exe(prefer_release: bool = True) -> Path | None:
    return next(
        (
            path
            for path in rust_exe_candidates(prefer_release)
            if path.exists() and not rust_exe_is_stale(path)
        ),
        None,
    )


def build_timeout_seconds() -> int:
    raw = os.environ.get("TKB_RUST_BUILD_TIMEOUT") or os.environ.get("TKB_BUILD_TIMEOUT") or "300"
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        value = 300
    return max(30, min(1800, value))


def solver_resource_limits(
    env: dict[str, str] | None = None,
    cpu_count: int | None = None,
) -> tuple[int, int]:
    """Return a balanced local solver pool size and per-job worker cap."""
    source = os.environ if env is None else env
    cpus = max(1, int(cpu_count or os.cpu_count() or 1))

    try:
        configured_concurrent = int(str(source.get("TKB_SOLVER_MAX_CONCURRENT", "")).strip())
    except (TypeError, ValueError):
        configured_concurrent = 0
    max_concurrent = configured_concurrent if configured_concurrent > 0 else max(1, min(4, (cpus + 3) // 4))

    try:
        configured_workers = int(str(source.get("TKB_SOLVER_MAX_WORKERS", "")).strip())
    except (TypeError, ValueError):
        configured_workers = 0
    max_workers = configured_workers if configured_workers > 0 else max(1, min(8, cpus // max_concurrent))
    return max_concurrent, max_workers


def cargo_candidates() -> list[str]:
    home = Path.home()
    raw = [
        os.environ.get("CARGO", ""),
        str(home / ".cache" / "codex-rust" / "rustup" / "toolchains" / "stable-x86_64-pc-windows-msvc" / "bin" / "cargo.exe"),
        str(home / ".cache" / "codex-rust" / "rustup" / "toolchains" / "stable-x86_64-pc-windows-gnu" / "bin" / "cargo.exe"),
        str(home / ".cache" / "codex-rust" / "cargo" / "bin" / "cargo.exe"),
        "cargo",
    ]
    out: list[str] = []
    for item in raw:
        if not item or item in out:
            continue
        if item.endswith(".exe") and not Path(item).exists():
            continue
        out.append(item)
    return out


def resolved_command_path(command: str) -> str:
    resolved = shutil.which(command) or command
    return os.path.normcase(os.path.abspath(resolved))


def gnu_toolchain() -> tuple[str, str] | None:
    toolchain = Path.home() / ".cache" / "codex-rust" / "rustup" / "toolchains" / "stable-x86_64-pc-windows-gnu" / "bin"
    cargo = toolchain / "cargo.exe"
    rustc = toolchain / "rustc.exe"
    if cargo.exists() and rustc.exists():
        return str(cargo), str(rustc)
    return None


def rust_build_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Return a build environment that can link SQLite on MSVC and GNU toolchains."""
    env = (base or os.environ).copy()
    if os.name == "nt" and RUST_SQLITE_IMPORT_LIB.exists():
        vendor_dir = str(RUST_SQLITE_VENDOR_DIR)
        env["SQLITE3_LIB_DIR"] = vendor_dir
        env["SQLITE3_DYNAMIC"] = "1"
        existing_lib = env.get("LIB", "")
        if vendor_dir not in existing_lib:
            env["LIB"] = f"{existing_lib};{vendor_dir}" if existing_lib else vendor_dir
        existing_rustflags = env.get("RUSTFLAGS", "")
        flag = f"-L native={vendor_dir}"
        if flag not in existing_rustflags:
            env["RUSTFLAGS"] = f"{existing_rustflags} {flag}".strip()
    return env


def ensure_sqlite_runtime(exe: Path) -> None:
    """Place the SQLite runtime beside a dynamically linked Windows backend."""
    if os.name != "nt" or not exe.exists():
        return
    candidates = [RUST_SQLITE_RUNTIME_DLL]
    for base in (Path(sys.base_prefix), Path(sys.executable).resolve().parent):
        candidates.append(base / "DLLs" / "sqlite3.dll")
    python_cmd = shutil.which("python")
    if python_cmd:
        candidates.append(Path(python_cmd).resolve().parent / "DLLs" / "sqlite3.dll")
    source = next((path for path in candidates if path.exists()), None)
    if source is None:
        return
    destination = exe.parent / "sqlite3.dll"
    try:
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
    except OSError as exc:
        print(f"Khong copy duoc SQLite runtime ({exc}): {destination}", flush=True)


def kill_process_tree(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    try:
        os.kill(pid, 15)
    except OSError:
        pass


def attach_child_to_launcher_job(proc: subprocess.Popen[Any]) -> None:
    """Ask Windows to kill the backend automatically when this launcher exits."""
    if os.name != "nt" or proc is None:
        return
    try:
        import ctypes
        from ctypes import wintypes

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            return
        proc_handle = getattr(proc, "_handle", None)
        if not proc_handle:
            return
        if kernel32.AssignProcessToJobObject(job, proc_handle):
            _CHILD_JOB_HANDLES.append(job)
    except Exception:
        # The normal close handler still kills the backend; this is only a stronger fallback.
        return


def run_build_command(args: list[str], cwd: Path, env: dict[str, str] | None) -> tuple[int, str]:
    timeout = build_timeout_seconds()
    proc = subprocess.Popen(
        args,
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        stdout, _ = proc.communicate(timeout=timeout)
        return int(proc.returncode or 0), stdout or ""
    except subprocess.TimeoutExpired as exc:
        kill_process_tree(proc.pid)
        try:
            stdout, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            stdout = ""
        partial = exc.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="replace")
        text = (partial or "") + (stdout or "")
        return 124, f"timeout sau {timeout} giay\n{text}"


def path_under(child: str | os.PathLike[str], parent: str | os.PathLike[str]) -> bool:
    try:
        child_path = os.path.normcase(os.path.abspath(str(child)))
        parent_path = os.path.normcase(os.path.abspath(str(parent)))
        return os.path.commonpath([child_path, parent_path]) == parent_path
    except (OSError, ValueError):
        return False


def current_app_rust_api_pids() -> set[int]:
    if os.name != "nt":
        return set()
    script = (
        "$ErrorActionPreference='SilentlyContinue'; "
        "Get-CimInstance Win32_Process -Filter \"Name='tkb_rust_api.exe'\" | "
        "Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return set()
    text = result.stdout.strip()
    if not text:
        return set()
    try:
        payload = json.loads(text)
    except ValueError:
        return set()
    items = payload if isinstance(payload, list) else [payload]
    pids: set[int] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        exe_path = str(item.get("ExecutablePath") or "")
        if not exe_path or not path_under(exe_path, RUST_DIR):
            continue
        try:
            pid = int(item.get("ProcessId") or 0)
        except (TypeError, ValueError):
            continue
        if pid > 0 and pid != os.getpid():
            pids.add(pid)
    return pids


def stop_current_app_rust_api_processes() -> None:
    pids = current_app_rust_api_pids()
    if not pids:
        return
    print("Dung Rust API cu thuoc dung app hien tai de tranh khoa file exe...", flush=True)
    stop_pids(pids)
    time.sleep(0.5)


def built_gnu_exe() -> Path | None:
    """Use the isolated GNU build in place; it is not trusted until health passes."""
    if not RUST_CODEX_GNU_EXE.exists():
        return None
    return RUST_CODEX_GNU_EXE


def build_rust_release_if_needed() -> Path | None:
    fresh = fresh_rust_exe(prefer_release=True)
    if fresh is not None:
        return fresh
    exe = rust_exe(prefer_release=True)
    had_stale_exe = rust_exe_is_stale(exe)
    if not had_stale_exe:
        return exe
    manifest = RUST_DIR / "Cargo.toml"
    if not manifest.exists():
        return exe

    errors: list[str] = []
    gnu = gnu_toolchain()
    isolated_gnu_cargo: str | None = None
    if gnu:
        cargo, rustc = gnu
        isolated_gnu_cargo = resolved_command_path(cargo)
        print(f"Rust API exe is missing or stale; building GNU target-dir with {cargo}...", flush=True)
        env = rust_build_env()
        env["RUSTC"] = rustc
        try:
            returncode, output = run_build_command(
                [cargo, "build", "--release", "--manifest-path", str(manifest), "--target-dir", str(RUST_CODEX_GNU_DIR)],
                RUST_DIR,
                env,
            )
        except OSError as exc:
            errors.append(f"{cargo} GNU: {exc}")
        else:
            if returncode == 0:
                built = built_gnu_exe()
                if built is not None:
                    return built
            errors.append(f"{cargo} GNU: exit {returncode}\n{output[-2000:]}")

    for cargo in cargo_candidates():
        if isolated_gnu_cargo is not None and resolved_command_path(cargo) == isolated_gnu_cargo:
            continue
        print(f"Rust API exe is missing or stale; building with {cargo}...", flush=True)
        try:
            returncode, output = run_build_command(
                [cargo, "build", "--release", "--manifest-path", str(manifest)],
                RUST_DIR,
                rust_build_env(),
            )
        except OSError as exc:
            errors.append(f"{cargo}: {exc}")
            continue
        if returncode == 0:
            return fresh_rust_exe(prefer_release=True) or rust_exe(prefer_release=True)
        errors.append(f"{cargo}: exit {returncode}\n{output[-2000:]}")

    print("Could not build Rust API release exe.", flush=True)
    for line in errors[-3:]:
        print(f"  {line}", flush=True)
    fallback = rust_exe(prefer_release=True)
    if fallback is not None:
        print(f"Fallback: dung Rust API exe hien co {fallback}", flush=True)
    return fallback


def listener_pids(port: int) -> set[int]:
    if os.name != "nt":
        return set()
    try:
        result = subprocess.run(["netstat", "-ano", "-p", "tcp"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return set()
    pids: set[int] = set()
    port_suffix = f":{port}"
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        local, state, pid_text = parts[1], parts[3].upper(), parts[-1]
        if state != "LISTENING" or not local.endswith(port_suffix):
            continue
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid > 0 and pid != os.getpid():
            pids.add(pid)
    return pids


def stop_pids(pids: set[int]) -> None:
    for pid in sorted(pids):
        print(f"Stopping old listener PID {pid}...", flush=True)
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    return os.path.normcase(os.path.abspath(str(left))).rstrip("\\/") == os.path.normcase(os.path.abspath(str(right))).rstrip("\\/")


def server_is_ready(url: str) -> bool:
    payload = health_payload(url)
    if not payload or payload.get("api") != "rust":
        return False
    web_root = str(payload.get("webRoot") or "")
    return bool(web_root) and same_path(web_root, WEB_ROOT)


def reference_python_executable() -> str:
    configured = os.environ.get("TKB_REFERENCE_PYTHON") or os.environ.get("TKB_RUST_PYTHON")
    if configured:
        return configured
    if not getattr(sys, "frozen", False):
        return sys.executable
    return shutil.which("python") or shutil.which("python3") or ""


def python_solver_deps_status() -> tuple[bool, str]:
    """Return (ok, message) for hybrid Python solver dependencies."""
    solver_script = ROOT / "solver_runtime" / "scripts" / "solve_stdio.py"
    if not solver_script.exists():
        return False, "Khong tim thay solver_runtime/scripts/solve_stdio.py"
    python = reference_python_executable()
    if not python:
        return False, "Khong tim thay Python ngoai de chay hybrid solver"
    try:
        result = subprocess.run(
            [python, "-c", "import ortools; import numpy; import scipy; import openpyxl"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=20,
            check=False,
        )
    except OSError as exc:
        return False, f"Khong chay duoc Python ({exc})"
    if result.returncode == 0:
        return True, "Python solver deps OK (ortools, numpy, scipy, openpyxl)"
    detail = (result.stdout or "").strip().splitlines()
    tail = detail[-1] if detail else f"exit {result.returncode}"
    return False, f"Thieu Python deps cho hybrid solver: {tail}"


def solve_endpoint_smoke_with_settings(url: str, settings: dict[str, Any], timeout: int = 12) -> bool:
    body = json.dumps({"settings": settings, "data": {}}).encode("utf-8")
    request = Request(
        f"{url}/api/solve-data",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
        if not isinstance(payload, dict):
            return False
        if payload.get("ok") is True and isinstance(payload.get("solver"), dict):
            backend = str(payload["solver"].get("backend") or "")
            if backend in {"rust", "hybrid", "python", "reference"}:
                return True
            return backend == "rust"
        return payload.get("kind") in {
            "invalid_solve_request",
            "simple_solver_no_result",
            "incomplete_schedule",
            "no_complete_schedule_before_deadline",
        }
    except HTTPError as exc:
        if exc.code not in {400, 409, 422}:
            return False
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace"))
        except (OSError, ValueError):
            return False
        if not isinstance(payload, dict):
            return False
        if exc.code == 400 and str(payload.get("error") or "").strip():
            return True
        return payload.get("kind") in {
            "invalid_solve_request",
            "simple_solver_no_result",
            "incomplete_schedule",
            "no_complete_schedule_before_deadline",
        }
    except (OSError, URLError):
        return False


def solve_endpoint_smoke(url: str) -> bool:
    return solve_endpoint_smoke_with_settings(
        url,
        {
            "native_force_rust_solver": True,
            "disable_reference_solver": True,
            "disable_hybrid_reference_solver": True,
            "solver_mode": "native",
        },
    )


def solve_endpoint_smoke_auto(url: str) -> bool:
    return solve_endpoint_smoke_with_settings(
        url,
        {
            "solver_mode": "auto",
            "auto_sort_mode": "fast",
        },
        timeout=20,
    )


def wait_until_ready(url: str, proc: subprocess.Popen[Any], timeout_seconds: int) -> bool:
    deadline = time.monotonic() + max(1, timeout_seconds)
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            print(f"Rust API exited early with code {proc.returncode}.", flush=True)
            return False
        if server_is_ready(url):
            return True
        time.sleep(1)
    return False


def start_server(
    exe: Path,
    env: dict[str, str],
    foreground: bool,
    kill_with_parent: bool = False,
) -> subprocess.Popen[Any]:
    creationflags = 0
    stdout = None
    stderr = None
    if os.name == "nt" and not foreground:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        stdout = subprocess.DEVNULL
        stderr = subprocess.DEVNULL
    elif not foreground:
        stdout = subprocess.DEVNULL
        stderr = subprocess.DEVNULL
    proc = subprocess.Popen([str(exe)], cwd=str(RUST_DIR), env=env, creationflags=creationflags, stdout=stdout, stderr=stderr)
    if kill_with_parent:
        attach_child_to_launcher_job(proc)
    return proc


def open_software_window(url: str) -> subprocess.Popen[Any] | None:
    webbrowser.open(url)
    return None


def stop_software_window(proc: subprocess.Popen[Any] | None) -> None:
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                kill_process_tree(proc.pid)
            except Exception:
                pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start the local TKB Rust API/UI server without using .bat files.")
    parser.add_argument("--host", default=os.environ.get("TKB_NEW_HOST") or os.environ.get("TKB_RUST_HOST") or "127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("TKB_RUST_PORT", "1010")))
    parser.add_argument("--timeout", type=int, default=45, help="Seconds to wait for /api/health.")
    parser.add_argument("--foreground", action="store_true", help="Run the Rust API in this console instead of opening a new one.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser after startup.")
    parser.add_argument("--no-launcher", action="store_true", help="Start in the old background mode and exit after startup.")
    parser.add_argument("--no-stop-old", action="store_true", help="Do not stop the existing listener on this port first.")
    return parser.parse_args(argv)


def start_backend(args: argparse.Namespace, status: StatusCallback | None = None) -> tuple[subprocess.Popen[Any], str, Path]:
    url = f"http://{args.host}:{args.port}"

    if not args.no_stop_old:
        emit_status(status, f"Kiem tra port {args.port}...")
        old_pids = listener_pids(args.port)
        if old_pids:
            emit_status(status, f"Giai phong port {args.port}...")
            stop_pids(old_pids)
            time.sleep(0.5)
        stop_current_app_rust_api_processes()

    emit_status(status, "Kiem tra Python solver...")
    py_ok, py_msg = python_solver_deps_status()
    if py_ok:
        print(py_msg, flush=True)
    else:
        print(f"Canh bao: {py_msg}", flush=True)
        print("  Hybrid solver co the khong chay. Cai: pip install -r solver_runtime/requirements.txt", flush=True)

    emit_status(status, "Kiem tra backend Rust...")
    primary_exe = build_rust_release_if_needed()
    candidates = startup_rust_exe_candidates(primary_exe)
    if not candidates:
        raise RuntimeError(f"Khong tim thay Rust API exe. Expected: {RUST_RELEASE_EXE}")

    max_concurrent, max_workers = solver_resource_limits(os.environ)
    env = os.environ.copy()
    env.update(
        {
            "TKB_APP_ROOT": str(ROOT),
            "TKB_RUST_HOST": str(args.host),
            "TKB_RUST_PORT": str(args.port),
            "TKB_SOLVER_MAX_CONCURRENT": str(max_concurrent),
            "TKB_SOLVER_MAX_WORKERS": str(max_workers),
            "TKB_NO_LOGS": "1",
            "TKB_RUST_QUIET": "1",
            "TKB_SAVE_SOLVE_ARTIFACTS": "0",
            "TKB_SAVE_RUST_SOLVE_ARTIFACTS": "0",
        }
    )
    reference_python = reference_python_executable()
    if reference_python:
        env["TKB_REFERENCE_PYTHON"] = reference_python

    emit_status(status, "Dang khoi dong backend...")
    print("Starting TKB Rust API local server...", flush=True)
    print(f"App root: {ROOT}", flush=True)
    print("Solver: hybrid Python CP-SAT/MILP + Rust native fallback", flush=True)
    print(f"Open: {url}/", flush=True)

    proc: subprocess.Popen[Any] | None = None
    exe: Path | None = None
    failures: list[str] = []
    for index, candidate in enumerate(candidates, start=1):
        print(f"Rust API [{index}/{len(candidates)}]: {candidate}", flush=True)
        ensure_sqlite_runtime(candidate)
        try:
            candidate_proc = start_server(
                candidate,
                env,
                foreground=args.foreground,
                kill_with_parent=bool(getattr(args, "kill_backend_with_launcher", False)),
            )
        except OSError as exc:
            failures.append(f"{candidate}: khong khoi dong duoc ({exc})")
            print(f"Khong chay duoc Rust API candidate ({exc}); thu ban tiep theo...", flush=True)
            continue

        emit_status(status, "Dang doi backend san sang...")
        if wait_until_ready(url, candidate_proc, args.timeout):
            proc = candidate_proc
            exe = candidate
            break

        exit_code = candidate_proc.poll()
        detail = f"exit {exit_code}" if exit_code is not None else "health timeout"
        failures.append(f"{candidate}: {detail}")
        print(f"Rust API candidate khong san sang ({detail}); thu ban tiep theo...", flush=True)
        stop_backend_process(candidate_proc, args.port)

    if proc is None or exe is None:
        detail = "; ".join(failures[-4:])
        suffix = f" Chi tiet: {detail}" if detail else ""
        raise RuntimeError(f"Khong co Rust API exe nao vuot qua health check.{suffix}")

    emit_status(status, "Dang kiem tra solver...")
    if not solve_endpoint_smoke(url):
        kill_process_tree(proc.pid)
        raise RuntimeError("Server dung source nhung solver Rust chua san sang.")

    if py_ok and not solve_endpoint_smoke_auto(url):
        print("Canh bao: smoke test hybrid (solver_mode=auto) that bai; Rust-only van co the chay.", flush=True)

    emit_status(status, "Server san sang.")
    if not args.no_browser:
        webbrowser.open(f"{url}/")
    return proc, url, exe


def stop_backend_process(proc: subprocess.Popen[Any] | None, port: int) -> None:
    if proc is not None and proc.poll() is None:
        kill_process_tree(proc.pid)
        time.sleep(0.3)
    pids = set(listener_pids(port))
    pids.update(current_app_rust_api_pids())
    if pids:
        stop_pids(pids)


def run_launcher_window(args: argparse.Namespace) -> int:
    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception as exc:
        print(f"Khong mo duoc cua so dieu khien ({exc}); chay che do nen.", file=sys.stderr)
        proc, _url, _exe = start_backend(args)
        return 0 if proc.poll() is None else int(proc.returncode or 1)

    root = tk.Tk()
    root.title("TKB - dang chay")
    root.geometry("430x270")
    root.resizable(False, False)
    try:
        root.lift()
        root.attributes("-topmost", True)
        root.after(1200, lambda: root.attributes("-topmost", False))
    except Exception:
        pass

    status_var = tk.StringVar(value="Dang khoi dong...")
    url_var = tk.StringVar(value=f"http://{args.host}:{args.port}/")
    py_ok, py_msg = python_solver_deps_status()
    deps_var = tk.StringVar(
        value=(py_msg if py_ok else f"Canh bao: {py_msg}\nCai: pip install -r solver_runtime/requirements.txt")
    )
    exit_code = {"value": 0}
    state: dict[str, Any] = {
        "proc": None,
        "url": f"http://{args.host}:{args.port}/",
        "ready": False,
        "closing": False,
        "app_proc": None,
        "app_started_at": 0.0,
    }
    events: queue.Queue[tuple[str, Any]] = queue.Queue()

    frame = tk.Frame(root, padx=18, pady=16)
    frame.pack(fill="both", expand=True)

    tk.Label(frame, text="Phan mem xep thoi khoa bieu", font=("Segoe UI", 13, "bold")).pack(anchor="w")
    tk.Label(frame, textvariable=status_var, font=("Segoe UI", 10), fg="#135200", wraplength=380, justify="left").pack(anchor="w", pady=(10, 4))
    tk.Label(frame, textvariable=url_var, font=("Segoe UI", 9), fg="#444", wraplength=380, justify="left").pack(anchor="w")
    tk.Label(
        frame,
        textvariable=deps_var,
        font=("Segoe UI", 8),
        fg="#92400e" if not py_ok else "#166534",
        wraplength=380,
        justify="left",
    ).pack(anchor="w", pady=(6, 0))

    button_row = tk.Frame(frame)
    button_row.pack(fill="x", pady=(18, 0))

    open_button = tk.Button(button_row, text="Mo phan mem", width=16, state="disabled", command=lambda: webbrowser.open(state["url"]))
    open_button.pack(side="left")

    stop_button = tk.Button(button_row, text="Tat backend", width=16)
    stop_button.pack(side="left", padx=(10, 0))

    hint = tk.Label(
        frame,
        text="Dong cua so nay se tat backend va giai phong port.",
        font=("Segoe UI", 9),
        fg="#666",
        wraplength=380,
        justify="left",
    )
    hint.pack(anchor="w", pady=(16, 0))

    def set_status(message: str) -> None:
        events.put(("status", message))

    def close_window() -> None:
        if state["closing"]:
            return
        state["closing"] = True
        status_var.set("Dang tat backend...")
        open_button.configure(state="disabled")
        stop_button.configure(state="disabled")

        def stopper() -> None:
            try:
                stop_software_window(state.get("app_proc"))
                stop_backend_process(state.get("proc"), args.port)
            finally:
                events.put(("destroy", None))

        threading.Thread(target=stopper, daemon=True).start()

    stop_button.configure(command=close_window)
    root.protocol("WM_DELETE_WINDOW", close_window)

    def worker() -> None:
        try:
            backend_args = argparse.Namespace(**vars(args))
            backend_args.no_browser = True
            backend_args.kill_backend_with_launcher = True
            proc, url, _exe = start_backend(backend_args, set_status)
            state["proc"] = proc
            state["url"] = f"{url}/"
            events.put(("ready", (proc, url)))
            code = proc.wait()
            if not state["closing"]:
                exit_code["value"] = int(code or 0)
                events.put(("exited", code))
        except Exception as exc:
            exit_code["value"] = 1
            events.put(("error", str(exc)))

    threading.Thread(target=worker, daemon=True).start()

    def poll_events() -> None:
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == "status":
                    status_var.set(str(payload))
                elif kind == "ready":
                    _proc, url = payload
                    state["ready"] = True
                    url_var.set(f"{url}/")
                    status_var.set("Dang chay. Dong cua so nay de tat backend.")
                    open_button.configure(state="normal")
                    if not args.no_browser:
                        app_proc = open_software_window(f"{url}/")
                        state["app_proc"] = app_proc
                        state["app_started_at"] = time.monotonic()
                elif kind == "exited":
                    status_var.set("Backend da dung.")
                    open_button.configure(state="disabled")
                elif kind == "error":
                    status_var.set("Khoi dong that bai.")
                    messagebox.showerror("TKB", str(payload))
                    root.destroy()
                    return
                elif kind == "destroy":
                    root.destroy()
                    return
        except queue.Empty:
            pass
        app_proc = state.get("app_proc")
        if (
            state.get("ready")
            and app_proc is not None
            and not state.get("closing")
            and time.monotonic() - float(state.get("app_started_at") or 0) > 3
            and app_proc.poll() is not None
        ):
            status_var.set("Cua so phan mem da dong. Dang tat backend...")
            close_window()
            return
        root.after(100, poll_events)

    root.after(100, poll_events)
    root.mainloop()
    return int(exit_code["value"])


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    if not args.foreground and not args.no_launcher:
        return run_launcher_window(args)

    try:
        proc, _url, _exe = start_backend(args)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if args.foreground:
        try:
            return int(proc.wait())
        except KeyboardInterrupt:
            stop_backend_process(proc, args.port)
            return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
