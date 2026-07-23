"""Relocate the packaged one-file Agent to a stable Windows path."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Callable, Sequence


INSTALL_EXE_NAME = "TKBCherryAgent.exe"
INSTALL_DIR_NAME = "TKBCherryAgent"
FALLBACK_DIR_PARTS = ("TKBCherry", "Agent")
HEADLESS_FLAGS = frozenset(
    {
        "--check",
        "--once",
        "--solver-child",
        "--gui-smoke",
        "--wsl-setup",
        "--version",
    }
)

CopyExecutable = Callable[[str, str], object]
SpawnProcess = Callable[..., object]
StopExecutable = Callable[[Path], bool]


def default_install_dir(*, environ: dict[str, str] | None = None) -> Path:
    """Return the preferred per-machine-looking directory on the system drive."""

    env = os.environ if environ is None else environ
    drive = str(env.get("SystemDrive") or "C:").strip()
    if len(drive) == 2 and drive[1] == ":":
        return Path(f"{drive}\\{INSTALL_DIR_NAME}")
    return Path(rf"C:\{INSTALL_DIR_NAME}")


def default_fallback_dir(*, environ: dict[str, str] | None = None) -> Path:
    """Return a writable current-user directory when the root drive is locked."""

    env = os.environ if environ is None else environ
    local_app_data = str(env.get("LOCALAPPDATA") or "").strip()
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base.joinpath(*FALLBACK_DIR_PARTS)


def _same_path(left: Path, right: Path) -> bool:
    try:
        return os.path.normcase(str(left.resolve(strict=False))) == os.path.normcase(
            str(right.resolve(strict=False))
        )
    except OSError:
        return os.path.normcase(str(left.absolute())) == os.path.normcase(
            str(right.absolute())
        )


def _copy_atomically(source: Path, destination: Path, copy_executable: CopyExecutable) -> None:
    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        copy_executable(str(source), str(temporary))
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _same_file_content(left: Path, right: Path) -> bool:
    try:
        if left.stat().st_size != right.stat().st_size:
            return False
        chunk_size = 1024 * 1024
        with left.open("rb") as left_stream, right.open("rb") as right_stream:
            while True:
                left_chunk = left_stream.read(chunk_size)
                right_chunk = right_stream.read(chunk_size)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
    except OSError:
        return False


def _windows_process_ids_for_executable(executable: Path) -> list[int]:
    """Return process ids whose image path exactly matches ``executable``."""

    if os.name != "nt":
        return []
    try:
        import ctypes
        from ctypes import wintypes

        class ProcessEntry32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
        kernel32.Process32FirstW.restype = wintypes.BOOL
        kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
        kernel32.Process32NextW.restype = wintypes.BOOL
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
        invalid_handle = ctypes.c_void_p(-1).value
        if not snapshot or int(snapshot) == invalid_handle:
            return []
        matches: list[int] = []
        try:
            entry = ProcessEntry32W()
            entry.dwSize = ctypes.sizeof(ProcessEntry32W)
            available = bool(kernel32.Process32FirstW(snapshot, ctypes.byref(entry)))
            while available:
                process_id = int(entry.th32ProcessID)
                if process_id > 0 and process_id != os.getpid():
                    process = kernel32.OpenProcess(0x1000, False, process_id)
                    if process:
                        try:
                            length = wintypes.DWORD(32768)
                            buffer = ctypes.create_unicode_buffer(length.value)
                            if kernel32.QueryFullProcessImageNameW(
                                process, 0, buffer, ctypes.byref(length)
                            ) and _same_path(Path(buffer.value), executable):
                                matches.append(process_id)
                        finally:
                            kernel32.CloseHandle(process)
                available = bool(kernel32.Process32NextW(snapshot, ctypes.byref(entry)))
        finally:
            kernel32.CloseHandle(snapshot)
        return matches
    except (AttributeError, OSError, TypeError, ValueError):
        return []


def stop_running_windows_executable(executable: Path) -> bool:
    """Stop only the running process tree installed at the exact target path."""

    process_ids = _windows_process_ids_for_executable(executable)
    if not process_ids:
        return True
    creation_flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for process_id in process_ids:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process_id), "/T", "/F"],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags,
            )
        except OSError:
            return False
    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        if not _windows_process_ids_for_executable(executable):
            return True
        time.sleep(0.1)
    return not _windows_process_ids_for_executable(executable)


def _spawn_installed(
    executable: Path,
    arguments: Sequence[str],
    spawn_process: SpawnProcess,
) -> None:
    creation_flags = 0
    if os.name == "nt":
        creation_flags = int(getattr(subprocess, "DETACHED_PROCESS", 0)) | int(
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    kwargs: dict[str, object] = {
        "cwd": str(executable.parent),
        "close_fds": True,
    }
    if creation_flags:
        kwargs["creationflags"] = creation_flags
    spawn_process([str(executable), *arguments], **kwargs)


def maybe_relaunch_from_install_dir(
    arguments: Sequence[str] | None = None,
    *,
    executable: Path | str | None = None,
    frozen: bool | None = None,
    platform_name: str | None = None,
    environ: dict[str, str] | None = None,
    install_dir: Path | str | None = None,
    fallback_dir: Path | str | None = None,
    copy_executable: CopyExecutable | None = None,
    spawn_process: SpawnProcess | None = None,
    stop_running_executable: StopExecutable | None = None,
) -> bool:
    """Copy and relaunch a packaged GUI Agent once, returning whether to continue.

    The function is deliberately a no-op for source runs, non-Windows builds,
    and headless diagnostic commands. If the preferred root directory cannot be
    written, it tries the current-user fallback and continues from there.
    When both locations fail, the original executable continues so installation
    trouble cannot hide the Agent's normal error dialog.
    """

    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else bool(frozen)
    platform = os.name if platform_name is None else platform_name
    args = tuple(str(value) for value in (sys.argv[1:] if arguments is None else arguments))
    if not is_frozen or platform != "nt" or HEADLESS_FLAGS.intersection(args):
        return True

    source = Path(sys.executable if executable is None else executable)
    preferred_dir = Path(install_dir) if install_dir is not None else default_install_dir(environ=environ)
    user_dir = Path(fallback_dir) if fallback_dir is not None else default_fallback_dir(environ=environ)
    preferred = preferred_dir / INSTALL_EXE_NAME
    fallback = user_dir / INSTALL_EXE_NAME
    if _same_path(source, preferred) or _same_path(source, fallback):
        return True

    copy_fn = shutil.copy2 if copy_executable is None else copy_executable
    spawn_fn = subprocess.Popen if spawn_process is None else spawn_process
    stop_fn = (
        stop_running_windows_executable
        if stop_running_executable is None
        else stop_running_executable
    )
    for destination in (preferred, fallback):
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_file() and _same_file_content(source, destination):
                _spawn_installed(destination, args, spawn_fn)
                return False
            if destination.is_file() and not stop_fn(destination):
                raise PermissionError(f"could not stop the installed Agent at {destination}")
            _copy_atomically(source, destination, copy_fn)
            _spawn_installed(destination, args, spawn_fn)
            return False
        except (OSError, PermissionError):
            continue
    return True
