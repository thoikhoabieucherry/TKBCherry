"""Small local state for the Agent ID, instance lock, and paired credential."""

from __future__ import annotations

import ctypes
import json
import os
import platform
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class StateError(RuntimeError):
    """Raised when the Agent ID cannot be loaded or created safely."""


_CREDENTIAL_FILE = "agent-credential"
_WSL_SETUP_RESTART_FILE = "wsl-setup-restart-pending"
_WSL_SETUP_RESTART_SCHEMA = 2
_WSL_SETUP_RESTART_LEGACY_SCHEMA = 1
_WINDOWS_BOOT_ID_KEY = (
    r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management"
    r"\PrefetchParameters"
)
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


@dataclass(frozen=True, slots=True)
class WslSetupRestartState:
    """Durable setup gate tied to the Windows boot that created it."""

    pending: bool
    same_boot: bool = False
    boot_id: int | None = None
    same_setup_generation: bool = True
    setup_generation: str | None = None


def _current_windows_boot_id() -> int | None:
    """Read Windows' monotonic boot sequence without spawning a helper."""

    if os.name != "nt":
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            _WINDOWS_BOOT_ID_KEY,
            0,
            winreg.KEY_QUERY_VALUE,
        ) as key:
            value, kind = winreg.QueryValueEx(key, "BootId")
        if kind not in {winreg.REG_DWORD, winreg.REG_QWORD}:
            return None
        parsed = int(value)
        return parsed if parsed >= 0 else None
    except (OSError, TypeError, ValueError):
        return None


def _current_windows_boot_started_ns() -> int | None:
    """Best-effort fallback for old markers on systems without ``BootId``."""

    if os.name != "nt":
        return None
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetTickCount64.argtypes = []
        kernel32.GetTickCount64.restype = ctypes.c_ulonglong
        uptime_ms = int(kernel32.GetTickCount64())
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    return time.time_ns() - (uptime_ms * 1_000_000)


def wsl_setup_restart_state(
    state_dir: Path | None = None,
    *,
    current_boot_id: int | None = None,
    boot_started_ns: int | None = None,
    current_setup_generation: str | None = None,
) -> WslSetupRestartState:
    """Return whether setup may resume or must wait for a real Windows reboot.

    A marker created by the same setup generation during the current boot
    suppresses automatic setup.  A newer Agent generation may retry once in
    that boot, while a Windows boot change still permits the normal resume.
    The timestamp fallback keeps the plain ``1`` marker written by Agent 1.6.26
    compatible across its first upgrade.
    """

    path = (state_dir or default_state_dir()) / _WSL_SETUP_RESTART_FILE
    try:
        raw = path.read_text(encoding="ascii").strip()
        modified_ns = path.stat().st_mtime_ns
    except FileNotFoundError:
        return WslSetupRestartState(False)
    except OSError as exc:
        raise StateError("cannot read the WSL setup restart state") from exc
    except UnicodeError:
        # A damaged marker must never trigger repeated setup/UAC attempts.
        return WslSetupRestartState(True, same_boot=True)

    stored_boot_id: int | None = None
    stored_setup_generation: str | None = None
    created_ns = modified_ns
    if raw != "1":
        try:
            payload = json.loads(raw)
            if (
                not isinstance(payload, dict)
                or payload.get("schema")
                not in {
                    _WSL_SETUP_RESTART_LEGACY_SCHEMA,
                    _WSL_SETUP_RESTART_SCHEMA,
                }
            ):
                raise ValueError("unsupported marker")
            raw_boot_id = payload.get("bootId")
            if raw_boot_id is not None:
                stored_boot_id = int(raw_boot_id)
                if stored_boot_id < 0:
                    raise ValueError("invalid boot id")
            raw_created_ns = payload.get("createdNs")
            if raw_created_ns is not None:
                created_ns = int(raw_created_ns)
                if created_ns <= 0:
                    raise ValueError("invalid creation time")
            raw_setup_generation = payload.get("setupGeneration")
            if raw_setup_generation is not None:
                stored_setup_generation = str(raw_setup_generation).strip()
                if (
                    not stored_setup_generation
                    or len(stored_setup_generation) > 64
                    or any(
                        ord(character) < 32 or ord(character) > 126
                        for character in stored_setup_generation
                    )
                ):
                    raise ValueError("invalid setup generation")
        except (TypeError, ValueError, json.JSONDecodeError):
            return WslSetupRestartState(True, same_boot=True)

    requested_setup_generation = (
        str(current_setup_generation).strip()
        if current_setup_generation is not None
        else None
    )
    same_setup_generation = (
        True
        if requested_setup_generation is None
        else stored_setup_generation == requested_setup_generation
    )

    observed_boot_id = (
        _current_windows_boot_id()
        if current_boot_id is None
        else current_boot_id
    )
    if stored_boot_id is not None and observed_boot_id is not None:
        return WslSetupRestartState(
            True,
            same_boot=stored_boot_id == observed_boot_id,
            boot_id=stored_boot_id,
            same_setup_generation=same_setup_generation,
            setup_generation=stored_setup_generation,
        )

    observed_boot_started_ns = (
        _current_windows_boot_started_ns()
        if boot_started_ns is None
        else boot_started_ns
    )
    if observed_boot_started_ns is None:
        return WslSetupRestartState(
            True,
            same_boot=True,
            boot_id=stored_boot_id,
            same_setup_generation=same_setup_generation,
            setup_generation=stored_setup_generation,
        )
    return WslSetupRestartState(
        True,
        same_boot=created_ns >= observed_boot_started_ns,
        boot_id=stored_boot_id,
        same_setup_generation=same_setup_generation,
        setup_generation=stored_setup_generation,
    )


def wsl_setup_restart_pending(state_dir: Path | None = None) -> bool:
    """Return whether a durable WSL setup gate exists."""

    return wsl_setup_restart_state(state_dir).pending


def set_wsl_setup_restart_pending(
    pending: bool,
    state_dir: Path | None = None,
    *,
    setup_generation: str | None = None,
) -> None:
    """Persist only the small non-secret flag needed across a Windows restart."""

    directory = state_dir or default_state_dir()
    path = directory / _WSL_SETUP_RESTART_FILE
    try:
        if not pending:
            path.unlink(missing_ok=True)
            return
        directory.mkdir(parents=True, exist_ok=True)
        temporary = (
            directory / f"{_WSL_SETUP_RESTART_FILE}.tmp-{uuid.uuid4().hex}"
        )
        normalized_setup_generation = (
            str(setup_generation).strip() if setup_generation is not None else None
        )
        if normalized_setup_generation is not None and (
            not normalized_setup_generation
            or len(normalized_setup_generation) > 64
            or any(
                ord(character) < 32 or ord(character) > 126
                for character in normalized_setup_generation
            )
        ):
            raise StateError("invalid WSL setup generation")
        marker = {
            "schema": _WSL_SETUP_RESTART_SCHEMA,
            "bootId": _current_windows_boot_id(),
            "createdNs": time.time_ns(),
        }
        if normalized_setup_generation is not None:
            marker["setupGeneration"] = normalized_setup_generation
        payload = json.dumps(
            marker,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as handle:
                handle.write(payload + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError as exc:
        raise StateError("cannot persist the WSL setup restart state") from exc


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
