"""Small local state for the Agent ID, instance lock, and paired credential."""

from __future__ import annotations

import os
import platform
import uuid
import ctypes
from pathlib import Path
from typing import Any


class StateError(RuntimeError):
    """Raised when the Agent ID cannot be loaded or created safely."""


_CREDENTIAL_FILE = "agent-credential"
_DPAPI_PREFIX = b"TKB-DPAPI-V1\0"
_PLAIN_PREFIX = b"TKB-PLAIN-V1\0"
_STATE_DIR_ENV = "TKB_AGENT_STATE_DIR"


def default_state_dir() -> Path:
    configured = os.environ.get(_STATE_DIR_ENV, "").strip()
    if configured:
        path = Path(configured).expanduser()
        if not path.is_absolute():
            raise StateError(f"{_STATE_DIR_ENV} must be an absolute path")
        return path
    local_app_data = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" or local_app_data:
        base = (
            Path(local_app_data)
            if local_app_data
            else Path.home() / "AppData" / "Local"
        )
        return base / "TKBCherry" / "AgentHelper"
    xdg_state_home = os.environ.get("XDG_STATE_HOME", "").strip()
    base = (
        Path(xdg_state_home).expanduser()
        if xdg_state_home
        else Path.home() / ".local" / "state"
    )
    return base / "tkbcherry-agent"


def _parse_agent_id(raw: str) -> str:
    try:
        value = uuid.UUID(raw.strip())
    except (ValueError, AttributeError) as exc:
        raise StateError("the persisted Agent ID is invalid") from exc
    return str(value)


def load_or_create_agent_id(state_dir: Path | None = None) -> str:
    directory = state_dir or default_state_dir()
    path = directory / "agent-id"
    try:
        existing = path.read_text(encoding="ascii")
    except FileNotFoundError:
        existing = None
    except OSError as exc:
        raise StateError("cannot read the persisted Agent ID") from exc
    if existing is not None:
        return _parse_agent_id(existing)

    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise StateError("cannot create the Agent Helper state directory") from exc

    generated = str(uuid.uuid4())
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        try:
            return _parse_agent_id(path.read_text(encoding="ascii"))
        except OSError as exc:
            raise StateError("cannot read the concurrently-created Agent ID") from exc
    except OSError as exc:
        raise StateError("cannot persist the Agent ID") from exc
    try:
        with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as handle:
            handle.write(generated + "\n")
    except OSError as exc:
        raise StateError("cannot persist the Agent ID") from exc
    return generated


def _validate_agent_token(value: str) -> str:
    token = str(value or "").strip()
    if (
        not token.startswith("tkba_")
        or len(token) > 512
        or any(ord(character) < 33 or ord(character) > 126 for character in token)
    ):
        raise StateError("the paired Agent credential is invalid")
    return token


def _windows_dpapi(data: bytes, *, decrypt: bool) -> bytes:
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.restype = wintypes.BOOL
    source_buffer = ctypes.create_string_buffer(data)
    source = DataBlob(
        len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_byte))
    )
    destination = DataBlob()
    if decrypt:
        ok = function(
            ctypes.byref(source), None, None, None, None, 0x1, ctypes.byref(destination)
        )
    else:
        ok = function(
            ctypes.byref(source),
            "TKBCherry Agent",
            None,
            None,
            None,
            0x1,
            ctypes.byref(destination),
        )
    if not ok:
        raise StateError("Windows could not protect the Agent credential")
    try:
        return ctypes.string_at(destination.data, destination.size)
    finally:
        kernel32.LocalFree(ctypes.cast(destination.data, ctypes.c_void_p))


def save_agent_token(token: str, state_dir: Path | None = None) -> None:
    """Persist a limited Agent-only token, protected by the current Windows user."""

    token = _validate_agent_token(token)
    directory = state_dir or default_state_dir()
    path = directory / _CREDENTIAL_FILE
    temporary = directory / f"{_CREDENTIAL_FILE}.tmp-{uuid.uuid4().hex}"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        raw = token.encode("ascii")
        payload = (
            _DPAPI_PREFIX + _windows_dpapi(raw, decrypt=False)
            if os.name == "nt"
            else _PLAIN_PREFIX + raw
        )
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except (OSError, UnicodeEncodeError) as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise StateError("cannot persist the paired Agent credential") from exc


def load_agent_token(state_dir: Path | None = None) -> str | None:
    path = (state_dir or default_state_dir()) / _CREDENTIAL_FILE
    try:
        payload = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise StateError("cannot read the paired Agent credential") from exc
    if len(payload) > 8192:
        raise StateError("the paired Agent credential is invalid")
    try:
        if payload.startswith(_DPAPI_PREFIX) and os.name == "nt":
            raw = _windows_dpapi(payload[len(_DPAPI_PREFIX) :], decrypt=True)
        elif payload.startswith(_PLAIN_PREFIX) and os.name != "nt":
            raw = payload[len(_PLAIN_PREFIX) :]
        else:
            raise StateError("the paired Agent credential cannot be opened here")
        return _validate_agent_token(raw.decode("ascii"))
    except (UnicodeDecodeError, OSError) as exc:
        raise StateError("the paired Agent credential is invalid") from exc


def clear_agent_token(state_dir: Path | None = None) -> None:
    try:
        ((state_dir or default_state_dir()) / _CREDENTIAL_FILE).unlink(missing_ok=True)
    except OSError as exc:
        raise StateError("cannot remove the paired Agent credential") from exc


class SingleInstanceLock:
    """Kernel/file lock preventing two helpers from rotating one worker session."""

    def __init__(self, agent_id: str, state_dir: Path | None = None) -> None:
        self._windows_handle: int | None = None
        self._file: Any = None
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateMutexW.argtypes = [
                ctypes.c_void_p,
                wintypes.BOOL,
                wintypes.LPCWSTR,
            ]
            kernel32.CreateMutexW.restype = wintypes.HANDLE
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            handle = kernel32.CreateMutexW(
                None,
                False,
                f"Local\\TKBCherry.AgentHelper.{agent_id}",
            )
            if not handle:
                raise StateError("cannot create the Agent Helper single-instance lock")
            if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                kernel32.CloseHandle(handle)
                raise StateError("Agent Helper is already running for this Agent ID")
            self._windows_handle = int(handle)
            self._close_handle = kernel32.CloseHandle
            self._wintypes = wintypes
            return

        import fcntl

        path = (state_dir or default_state_dir()) / "agent-id"
        handle = None
        try:
            handle = path.open("rb")
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if handle is not None:
                handle.close()
            raise StateError(
                "Agent Helper is already running for this Agent ID"
            ) from exc
        self._file = handle

    def close(self) -> None:
        if self._windows_handle is not None:
            handle = self._windows_handle
            self._windows_handle = None
            self._close_handle(self._wintypes.HANDLE(handle))
        if self._file is not None:
            handle, self._file = self._file, None
            try:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()

    def __enter__(self) -> "SingleInstanceLock":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


def platform_tag() -> str:
    system = platform.system().casefold() or "unknown"
    machine = platform.machine().casefold()
    architecture = {
        "amd64": "amd64",
        "x86_64": "amd64",
        "arm64": "arm64",
        "aarch64": "arm64",
        "x86": "386",
        "i386": "386",
        "i686": "386",
    }.get(machine, machine or "unknown")
    return f"{system}-{architecture}"
