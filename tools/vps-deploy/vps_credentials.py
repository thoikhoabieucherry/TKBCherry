#!/usr/bin/env python3
"""Resolve non-secret VPS config and the SSH credentials used to log in.

Login order (``connect_vps``):

1. An ed25519 private key kept OUTSIDE the repository, next to the DPAPI store
   (``%LOCALAPPDATA%\\TKBCherry\\secrets\\vps-ssh-ed25519``). Its passphrase is
   random and saved with Windows DPAPI for the current user, like the password.
2. The root password (``TKB_VPS_PASSWORD`` or the DPAPI store) -- only as a
   fallback while the key is being rolled out. Once the VPS runs with
   ``PasswordAuthentication no`` this fallback is simply refused by sshd.

``TKB_VPS_AUTH`` = ``auto`` (default: key, then password), ``key`` (key only)
or ``password`` (password only).

CLI: ``python vps_credentials.py status|path|save|delete|ssh-keygen|ssh-pubkey``.
"""

from __future__ import annotations

import argparse
import ctypes
import getpass
import json
import os
import secrets
import sys
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


CONFIG_PATH = Path(__file__).with_name("vps-config.json")
DPAPI_ENTROPY = b"TKBCherry/VPS credential v1"
SSH_KEY_PASSPHRASE_ENTROPY = b"TKBCherry/VPS ssh key passphrase v1"
SSH_KEY_FILENAME = "vps-ssh-ed25519"
SSH_KEY_PASSPHRASE_FILENAME = "vps-ssh-key-passphrase.dpapi"
SSH_KEY_COMMENT = "tkbcherry-deploy"
AUTH_MODES = ("auto", "key", "password")
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


def secrets_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "TKBCherry" / "secrets"


def credential_path() -> Path:
    return secrets_dir() / "vps-password.dpapi"


def ssh_key_path() -> Path:
    override = os.environ.get("TKB_VPS_KEY_FILE", "").strip()
    return Path(override).expanduser() if override else secrets_dir() / SSH_KEY_FILENAME


def ssh_key_passphrase_path() -> Path:
    return secrets_dir() / SSH_KEY_PASSPHRASE_FILENAME


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


def protect_bytes(value: bytes, entropy_bytes: bytes = DPAPI_ENTROPY) -> bytes:
    if not value:
        raise CredentialError("Refusing to store an empty VPS secret.")
    crypt32, kernel32 = _windows_crypto()
    source, source_buffer = _blob(value)
    entropy, entropy_buffer = _blob(entropy_bytes)
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


def unprotect_bytes(value: bytes, entropy_bytes: bytes = DPAPI_ENTROPY) -> bytes:
    if not value:
        raise CredentialError("The saved VPS credential is empty.")
    crypt32, kernel32 = _windows_crypto()
    source, source_buffer = _blob(value)
    entropy, entropy_buffer = _blob(entropy_bytes)
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


def _write_atomic(destination: Path, data: bytes) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, destination)
    return destination


def _load_dpapi_text(source: Path, entropy_bytes: bytes, label: str) -> str:
    try:
        encrypted = source.read_bytes()
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise CredentialError(f"Could not read the {label} store: {exc}") from exc
    try:
        return unprotect_bytes(encrypted, entropy_bytes).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CredentialError(f"The saved {label} is not valid UTF-8.") from exc


def save_vps_password(password: str, path: Path | None = None) -> Path:
    destination = path or credential_path()
    return _write_atomic(destination, protect_bytes(password.encode("utf-8")))


def load_saved_vps_password(path: Path | None = None) -> str:
    return _load_dpapi_text(path or credential_path(), DPAPI_ENTROPY, "VPS credential")


def resolve_vps_password() -> str:
    environment = os.environ.get("TKB_VPS_PASSWORD", "")
    if environment:
        return environment
    try:
        return load_saved_vps_password()
    except CredentialError:
        return ""


def save_ssh_key_passphrase(passphrase: str, path: Path | None = None) -> Path:
    destination = path or ssh_key_passphrase_path()
    encrypted = protect_bytes(passphrase.encode("utf-8"), SSH_KEY_PASSPHRASE_ENTROPY)
    return _write_atomic(destination, encrypted)


def load_saved_ssh_key_passphrase(path: Path | None = None) -> str:
    return _load_dpapi_text(
        path or ssh_key_passphrase_path(), SSH_KEY_PASSPHRASE_ENTROPY, "SSH key passphrase"
    )


def resolve_ssh_key_passphrase() -> str:
    environment = os.environ.get("TKB_VPS_KEY_PASSPHRASE", "")
    if environment:
        return environment
    try:
        return load_saved_ssh_key_passphrase()
    except CredentialError:
        return ""


def resolve_auth_mode() -> str:
    mode = os.environ.get("TKB_VPS_AUTH", "").strip().lower()
    return mode if mode in AUTH_MODES else "auto"


@dataclass(frozen=True)
class VpsAuth:
    host: str
    user: str
    password: str
    key_path: Path | None
    key_passphrase: str
    mode: str = "auto"

    @property
    def ready(self) -> bool:
        has_key = self.key_path is not None
        if self.mode == "key":
            return has_key
        if self.mode == "password":
            return bool(self.password)
        return has_key or bool(self.password)


def resolve_vps_auth() -> VpsAuth:
    host, user, password = resolve_vps_connection()
    key = ssh_key_path()
    has_key = key.is_file()
    return VpsAuth(
        host=host,
        user=user,
        password=password,
        key_path=key if has_key else None,
        key_passphrase=resolve_ssh_key_passphrase() if has_key else "",
        mode=resolve_auth_mode(),
    )


def resolve_vps_connection() -> tuple[str, str, str]:
    """Return ``(host, user, password)``; the password may be empty once keys are used."""
    config = load_vps_config()
    host = os.environ.get("TKB_VPS_HOST", "").strip() or config["host"]
    user = os.environ.get("TKB_VPS_USER", "").strip() or config["user"]
    return host, user, resolve_vps_password()


def vps_credentials_ready() -> bool:
    return resolve_vps_auth().ready


def missing_credential_message() -> str:
    here = Path(__file__).resolve()
    saver = here.with_name("save-vps-credential.ps1")
    return (
        "No VPS SSH key or password is configured. Create the SSH key with "
        f"`python \"{here}\" ssh-keygen` (then install the printed public key on the VPS), "
        f"or save the root password: powershell -ExecutionPolicy Bypass -File \"{saver}\""
    )


def load_private_key(path: Path, passphrase: str) -> Any:
    import paramiko

    try:
        return paramiko.Ed25519Key.from_private_key_file(str(path), password=passphrase or None)
    except paramiko.PasswordRequiredException as exc:
        raise CredentialError(
            f"SSH key {path} is encrypted but no passphrase is saved "
            f"({ssh_key_passphrase_path()} / TKB_VPS_KEY_PASSPHRASE)."
        ) from exc
    except (paramiko.SSHException, OSError, ValueError) as exc:
        raise CredentialError(f"Could not load SSH key {path}: {exc}") from exc


def _warn(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def connect_vps(
    client: Any = None,
    *,
    host: str | None = None,
    user: str | None = None,
    password: str | None = None,
    timeout: float = 30,
    banner_timeout: float = 30,
    auth_timeout: float = 30,
    auth: VpsAuth | None = None,
    warn: Callable[[str], None] = _warn,
) -> Any:
    """Connect ``client`` (a ``paramiko.SSHClient``) to the VPS and return it.

    Tries the SSH key first; falls back to the password only in ``auto`` mode.
    ``password`` overrides the stored password (e.g. ``deploy.py --password``).
    The caller keeps its own host-key policy; a new client gets AutoAddPolicy.
    """
    import paramiko

    auth = auth or resolve_vps_auth()
    host = host or auth.host
    user = user or auth.user
    password = password or auth.password
    if client is None:
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    common = {
        "username": user,
        "timeout": timeout,
        "banner_timeout": banner_timeout,
        "auth_timeout": auth_timeout,
        "look_for_keys": False,
        "allow_agent": False,
    }

    if auth.mode != "password":
        if auth.key_path is None:
            if auth.mode == "key":
                raise CredentialError(
                    f"TKB_VPS_AUTH=key but no SSH key at {ssh_key_path()}. " + missing_credential_message()
                )
        else:
            failure: Exception
            try:
                pkey = load_private_key(auth.key_path, auth.key_passphrase)
                client.connect(host, pkey=pkey, **common)
                return client
            except paramiko.AuthenticationException as exc:
                failure = exc
                client.close()
            except CredentialError as exc:
                failure = exc
            if auth.mode == "key" or not password:
                raise CredentialError(f"SSH key login to {user}@{host} failed: {failure}") from failure
            warn(f"[vps] SSH key login failed ({failure}); falling back to the password.")

    if not password:
        raise CredentialError(missing_credential_message())
    client.connect(host, password=password, **common)
    if auth.mode == "auto":
        warn(
            "[vps] Logged in with the root PASSWORD. Install the SSH key "
            "(vps_credentials.py ssh-pubkey) before password logins are disabled."
        )
    return client


def generate_ssh_key(path: Path, passphrase: str, comment: str = SSH_KEY_COMMENT) -> str:
    """Write a new encrypted OpenSSH ed25519 key to ``path`` (+ ``.pub``); return the public line."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    if not passphrase:
        raise CredentialError("Refusing to write an SSH key without a passphrase.")
    public_path = path.with_name(path.name + ".pub")
    if path.exists() or public_path.exists():
        raise CredentialError(f"SSH key already exists: {path} (refusing to overwrite).")
    key = Ed25519PrivateKey.generate()
    private_bytes = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH,
        serialization.BestAvailableEncryption(passphrase.encode("utf-8")),
    )
    public_line = (
        key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode("ascii")
        + f" {comment}"
    )
    _write_atomic(path, private_bytes)
    _write_atomic(public_path, (public_line + "\n").encode("ascii"))
    return public_line


def read_public_key(path: Path | None = None) -> str:
    private_path = path or ssh_key_path()
    public_path = private_path.with_name(private_path.name + ".pub")
    try:
        return public_path.read_text(encoding="ascii").strip()
    except OSError as exc:
        raise CredentialError(f"No public key at {public_path}: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "action", choices=("save", "status", "delete", "path", "ssh-keygen", "ssh-pubkey")
    )
    args = parser.parse_args()
    path = credential_path()

    if args.action == "path":
        print(path)
        print(ssh_key_path())
        return 0
    if args.action == "status":
        auth = resolve_vps_auth()
        key_state = "present" if auth.key_path else "missing"
        passphrase_state = "present" if auth.key_passphrase else "missing"
        password_state = "present" if auth.password else "missing"
        state = "READY" if auth.ready else "MISSING"
        print(
            f"VPS_CREDENTIAL_{state} mode={auth.mode} key={key_state} "
            f"key_passphrase={passphrase_state} password={password_state}"
        )
        print(f"  key: {ssh_key_path()}")
        print(f"  password store: {path}")
        return 0 if auth.ready else 1
    if args.action == "delete":
        path.unlink(missing_ok=True)
        print(f"VPS_CREDENTIAL_DELETED path={path}")
        return 0
    if args.action == "ssh-keygen":
        key = ssh_key_path()
        passphrase = secrets.token_urlsafe(32)
        try:
            public_line = generate_ssh_key(key, passphrase)
        except CredentialError as exc:
            print(exc, file=sys.stderr)
            return 2
        save_ssh_key_passphrase(passphrase)
        if load_saved_ssh_key_passphrase() != passphrase:
            print("Passphrase store did not round-trip; delete the new key and retry.", file=sys.stderr)
            return 3
        print(f"VPS_SSH_KEY_CREATED path={key}")
        print(public_line)
        return 0
    if args.action == "ssh-pubkey":
        try:
            print(read_public_key())
        except CredentialError as exc:
            print(exc, file=sys.stderr)
            return 1
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
