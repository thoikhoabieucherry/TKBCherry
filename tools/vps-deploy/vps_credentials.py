#!/usr/bin/env python3
"""Resolve non-secret VPS config and a Windows DPAPI-protected password."""

from __future__ import annotations

import argparse
import ctypes
import getpass
import json
import os
from ctypes import wintypes
from pathlib import Path
from typing import Any


CONFIG_PATH = Path(__file__).with_name("vps-config.json")
DPAPI_ENTROPY = b"TKBCherry/VPS credential v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x1
DEFAULT_CONFIG = {
    "hostname": "TDC-260709270",
    "host": "165.101.47.133",
    "user": "root",
    "credentialStore": "windows-dpapi-current-user",
}


class CredentialError(RuntimeError):
    pass


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def load_vps_config() -> dict[str, str]:
    config = dict(DEFAULT_CONFIG)
    try:
        value: Any = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        value = {}
    if isinstance(value, dict):
        for key in DEFAULT_CONFIG:
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                config[key] = candidate.strip()
    return config


def credential_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "TKBCherry" / "secrets" / "vps-password.dpapi"


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array[ctypes.c_char]]:
    buffer = ctypes.create_string_buffer(data, max(1, len(data)))
    pointer = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
    return _DataBlob(len(data), pointer), buffer


def _windows_crypto() -> tuple[Any, Any]:
    if os.name != "nt":
        raise CredentialError("Windows DPAPI is available only on Windows.")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob),
        wintypes.LPCWSTR,
        ctypes.POINTER(_DataBlob),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(_DataBlob),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    return crypt32, kernel32


def protect_bytes(value: bytes) -> bytes:
    if not value:
        raise CredentialError("Refusing to store an empty VPS password.")
    crypt32, kernel32 = _windows_crypto()
    source, source_buffer = _blob(value)
    entropy, entropy_buffer = _blob(DPAPI_ENTROPY)
    output = _DataBlob()
    ok = crypt32.CryptProtectData(
        ctypes.byref(source),
        "TKBCherry VPS credential",
        ctypes.byref(entropy),
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output),
    )
    # Keep the ctypes buffers alive until DPAPI has finished reading them.
    _ = source_buffer, entropy_buffer
    if not ok:
        raise CredentialError(f"CryptProtectData failed: {ctypes.get_last_error()}")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(output.pbData, wintypes.HLOCAL))


def unprotect_bytes(value: bytes) -> bytes:
    if not value:
        raise CredentialError("The saved VPS credential is empty.")
    crypt32, kernel32 = _windows_crypto()
    source, source_buffer = _blob(value)
    entropy, entropy_buffer = _blob(DPAPI_ENTROPY)
    output = _DataBlob()
    description = wintypes.LPWSTR()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source),
        ctypes.byref(description),
        ctypes.byref(entropy),
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output),
    )
    # Keep the ctypes buffers alive until DPAPI has finished reading them.
    _ = source_buffer, entropy_buffer
    if not ok:
        raise CredentialError(f"CryptUnprotectData failed: {ctypes.get_last_error()}")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        if output.pbData:
            kernel32.LocalFree(ctypes.cast(output.pbData, wintypes.HLOCAL))
        if description:
            kernel32.LocalFree(ctypes.cast(description, wintypes.HLOCAL))


def save_vps_password(password: str, path: Path | None = None) -> Path:
    destination = path or credential_path()
    encrypted = protect_bytes(password.encode("utf-8"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(encrypted)
    os.replace(temporary, destination)
    return destination


def load_saved_vps_password(path: Path | None = None) -> str:
    source = path or credential_path()
    try:
        encrypted = source.read_bytes()
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise CredentialError(f"Could not read the VPS credential store: {exc}") from exc
    try:
        return unprotect_bytes(encrypted).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CredentialError("The saved VPS credential is not valid UTF-8.") from exc


def resolve_vps_password() -> str:
    environment = os.environ.get("TKB_VPS_PASSWORD", "")
    if environment:
        return environment
    try:
        return load_saved_vps_password()
    except CredentialError:
        return ""


def resolve_vps_connection() -> tuple[str, str, str]:
    config = load_vps_config()
    host = os.environ.get("TKB_VPS_HOST", "").strip() or config["host"]
    user = os.environ.get("TKB_VPS_USER", "").strip() or config["user"]
    return host, user, resolve_vps_password()


def missing_credential_message() -> str:
    saver = Path(__file__).with_name("save-vps-credential.ps1")
    return (
        "VPS password is not configured. Run: "
        f"powershell -ExecutionPolicy Bypass -File \"{saver}\""
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("save", "status", "delete", "path"))
    args = parser.parse_args()
    path = credential_path()

    if args.action == "path":
        print(path)
        return 0
    if args.action == "status":
        if resolve_vps_password():
            print(f"VPS_CREDENTIAL_READY path={path}")
            return 0
        print(f"VPS_CREDENTIAL_MISSING path={path}")
        return 1
    if args.action == "delete":
        path.unlink(missing_ok=True)
        print(f"VPS_CREDENTIAL_DELETED path={path}")
        return 0

    first = getpass.getpass("VPS password: ")
    second = getpass.getpass("Confirm VPS password: ")
    if not first or first != second:
        print("Passwords are empty or do not match.")
        return 2
    save_vps_password(first, path)
    print(f"VPS_CREDENTIAL_SAVED path={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
