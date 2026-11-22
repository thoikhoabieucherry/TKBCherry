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

Host key: ``hostKeys`` in ``vps-config.json`` pins the VPS's public SSH host
key fingerprints (``"ssh-rsa SHA256:..."``, same text as ``ssh-keygen -lf``).
``connect_vps`` only negotiates the pinned key types and refuses any other
server key during the handshake, BEFORE the SSH key or password is sent;
known_hosts entries and the caller's host-key policy are ignored for that
connection. ``TKB_VPS_HOST_KEYS`` (comma separated) replaces the pins, e.g. for
a freshly installed server whose fingerprint was read on the provider console.
An empty ``hostKeys`` list keeps the old unchecked behaviour with a warning.

CLI: ``python vps_credentials.py status|path|save|delete|ssh-keygen|ssh-pubkey``.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import getpass
import hashlib
import json
import os
import re
import secrets
import sys
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


CONFIG_PATH = Path(__file__).with_name("vps-config.json")
DPAPI_ENTROPY = b"TKBCherry/VPS credential v1"
SSH_KEY_PASSPHRASE_ENTROPY = b"TKBCherry/VPS ssh key passphrase v1"
SSH_KEY_FILENAME = "vps-ssh-ed25519"
SSH_KEY_PASSPHRASE_FILENAME = "vps-ssh-key-passphrase.dpapi"
SSH_KEY_COMMENT = "tkbcherry-deploy"
AUTH_MODES = ("auto", "key", "password")
CRYPTPROTECT_UI_FORBIDDEN = 0x1
HOST_KEYS_ENV = "TKB_VPS_HOST_KEYS"
SSH_PORT = 22
DEFAULT_CONFIG: dict[str, Any] = {
    "hostname": "TDC-260709270",
    "host": "165.101.47.133",
    "user": "root",
    "credentialStore": "windows-dpapi-current-user",
    # Public host key fingerprint of the VPS (not a secret). 22/11/2026: the VPS has
    # only RSA 3072 + DSA host keys (no ed25519/ecdsa); this one matches the
    # ~/.ssh/known_hosts entry recorded on 21/08/2026 and `ssh-keygen -lf` on the VPS.
    "hostKeys": ["ssh-rsa SHA256:4pb4SlSGGzrAAi0UpG9LTj6yetY7pmrNUVI9sZKaqwM"],
}
_HOST_KEY_PIN_RE = re.compile(r"((?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+)\s+(SHA256:[A-Za-z0-9+/]{43})")


class CredentialError(RuntimeError):
    pass


class HostKeyError(CredentialError):
    """The server's SSH host key is not one of the pinned keys (possible man-in-the-middle)."""


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def load_vps_config() -> dict[str, Any]:
    """Strings from ``vps-config.json`` over ``DEFAULT_CONFIG``; ``hostKeys`` is a list."""
    config = {key: list(value) if isinstance(value, list) else value for key, value in DEFAULT_CONFIG.items()}
    try:
        value: Any = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        value = {}
    if isinstance(value, dict):
        for key, default in DEFAULT_CONFIG.items():
            candidate = value.get(key)
            if isinstance(default, list):
                # A present list wins even when empty: that is the explicit opt-out.
                if isinstance(candidate, list):
                    config[key] = [item.strip() for item in candidate if isinstance(item, str) and item.strip()]
            elif isinstance(candidate, str) and candidate.strip():
                config[key] = candidate.strip()
    return config


def resolve_host_key_pins() -> tuple[str, ...]:
    """Pinned host key fingerprints: ``TKB_VPS_HOST_KEYS`` if set, else ``hostKeys``."""
    environment = os.environ.get(HOST_KEYS_ENV, "").strip()
    if environment:
        return tuple(part.strip() for part in re.split(r"[,;\n]", environment) if part.strip())
    return tuple(load_vps_config()["hostKeys"])


def parse_host_key_pins(entries: Iterable[str]) -> frozenset[tuple[str, str]]:
    """``"ssh-rsa SHA256:..."`` -> ``("ssh-rsa", "SHA256:...")``. A malformed pin fails closed."""
    pins = set()
    for entry in entries:
        match = _HOST_KEY_PIN_RE.fullmatch(str(entry).strip())
        if not match:
            raise CredentialError(
                f"Malformed SSH host key pin {entry!r} (hostKeys in {CONFIG_PATH.name} / {HOST_KEYS_ENV}); "
                "expected '<key type> SHA256:<43 base64 chars>', e.g. the type and middle field of "
                "`ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub`."
            )
        pins.add((match.group(1), match.group(2)))
    return frozenset(pins)


def host_key_fingerprint(key: Any) -> str:
    """OpenSSH-style SHA256 fingerprint of a paramiko public key (as ``ssh-keygen -lf``)."""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def check_host_key(
    key: Any, pins: frozenset[tuple[str, str]], hostname: str, *, before_auth: bool = True
) -> None:
    """Raise ``HostKeyError`` unless the server key ``key`` is one of ``pins``."""
    presented = (key.get_name(), host_key_fingerprint(key))
    if presented in pins:
        return
    expected = ", ".join(" ".join(pin) for pin in sorted(pins)) or "(none)"
    stage = "no key or password was sent" if before_auth else "connection closed after login"
    raise HostKeyError(
        f"SSH host key of {hostname} is NOT the pinned one - refusing to log in (possible "
        f"man-in-the-middle; {stage}). Server presented "
        f"'{presented[0]} {presented[1]}', pinned: {expected}. If the VPS was reinstalled or its "
        f"host key changed on purpose, read the new fingerprint on the provider's web console "
        f"(`ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub`) and update hostKeys in {CONFIG_PATH.name}."
    )


def host_key_algorithm_filter(pins: frozenset[tuple[str, str]]) -> dict[str, list[str]] | None:
    """``disabled_algorithms`` that leaves only the pinned host key types to negotiate.

    paramiko otherwise prefers ed25519, so adding an ed25519 host key on the VPS
    later would make every pinned login fail until the pin is updated.
    """
    import paramiko

    allowed: set[str] = set()
    for key_type, _fingerprint in pins:
        allowed.add(key_type)
        if key_type == "ssh-rsa":  # the key is named ssh-rsa; it signs with rsa-sha2-*
            allowed.update(("rsa-sha2-512", "rsa-sha2-256"))
    preferred = tuple(getattr(paramiko.Transport, "_preferred_keys", ()))
    if not any(name in allowed for name in preferred):
        return None  # never disable every algorithm; check_host_key still refuses
    disabled = [name for name in preferred if name not in allowed]
    return {"keys": disabled} if disabled else None


class PinnedHostKeyPolicy:
    """paramiko missing-host-key policy: accept only a pinned key.

    paramiko calls it right after the key exchange and before authentication,
    so a refused key means no credential ever leaves this machine.
    """

    def __init__(self, pins: frozenset[tuple[str, str]]):
        self.pins = pins

    def missing_host_key(self, client: Any, hostname: str, key: Any) -> None:
        check_host_key(key, self.pins, hostname)


def _forget_known_host(client: Any, host_label: str) -> None:
    """Drop in-memory known_hosts entries for the VPS so the pin policy always runs."""
    stores = [getattr(client, "_system_host_keys", None)]
    get_host_keys = getattr(client, "get_host_keys", None)
    if callable(get_host_keys):
        stores.append(get_host_keys())
    for store in stores:
        if store is None:
            continue
        for _ in range(1000):  # HostKeys.__delitem__ removes one matching line per call
            try:
                del store[host_label]
            except KeyError:
                break


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
    host_keys: tuple[str, ...] = ()

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
        host_keys=resolve_host_key_pins(),
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
    port: int = SSH_PORT,
    timeout: float = 30,
    banner_timeout: float = 30,
    auth_timeout: float = 30,
    auth: VpsAuth | None = None,
    host_keys: Iterable[str] | None = None,
    warn: Callable[[str], None] = _warn,
) -> Any:
    """Connect ``client`` (a ``paramiko.SSHClient``) to the VPS and return it.

    Tries the SSH key first; falls back to the password only in ``auto`` mode.
    ``password`` overrides the stored password (e.g. ``deploy.py --password``).

    Host key: with pins (``host_keys``, else ``auth.host_keys`` = ``hostKeys`` /
    ``TKB_VPS_HOST_KEYS``) the pin alone decides. The caller's missing-host-key
    policy (AutoAddPolicy or RejectPolicy) and known_hosts entries for this host
    are replaced for this connection, only the pinned key types are offered, and
    a foreign key raises ``HostKeyError`` during the handshake, before the SSH key
    or password is sent; there is no password fallback after it. Without pins the
    caller's policy is kept (a new client gets AutoAddPolicy) and ``warn`` is told.
    """
    import paramiko

    auth = auth or resolve_vps_auth()
    host = host or auth.host
    user = user or auth.user
    password = password or auth.password
    pins = parse_host_key_pins(auth.host_keys if host_keys is None else host_keys)
    if client is None:
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    host_label = host if port == SSH_PORT else f"[{host}]:{port}"
    common: dict[str, Any] = {
        "port": port,
        "username": user,
        "timeout": timeout,
        "banner_timeout": banner_timeout,
        "auth_timeout": auth_timeout,
        "look_for_keys": False,
        "allow_agent": False,
    }
    if pins:
        _forget_known_host(client, host_label)
        client.set_missing_host_key_policy(PinnedHostKeyPolicy(pins))
        disabled = host_key_algorithm_filter(pins)
        if disabled:
            common["disabled_algorithms"] = disabled
    else:
        warn(
            f"[vps] No SSH host key pinned (hostKeys in {CONFIG_PATH.name} is empty): the server "
            f"key of {host_label} is NOT verified, a man-in-the-middle would not be noticed."
        )

    incompatible_peer = getattr(paramiko.ssh_exception, "IncompatiblePeer", ())

    def attempt(**credential: Any) -> None:
        try:
            client.connect(host, **credential, **common)
            get_transport = getattr(client, "get_transport", None)
            transport = get_transport() if pins and callable(get_transport) else None
            if transport is not None:  # belt and braces: the policy already ran pre-auth
                check_host_key(transport.get_remote_server_key(), pins, host_label, before_auth=False)
        except HostKeyError:
            client.close()
            raise
        except incompatible_peer as exc:
            if not pins or "host key" not in str(exc):
                raise
            client.close()
            types = ", ".join(sorted({key_type for key_type, _ in pins}))
            raise HostKeyError(
                f"{host_label} offers none of the pinned SSH host key types ({types}) - refusing to "
                f"log in, no key or password was sent ({exc}). If its host keys changed on purpose, "
                f"read the new fingerprint on the provider's web console and update hostKeys in "
                f"{CONFIG_PATH.name}."
            ) from exc

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
                attempt(pkey=pkey)
                return client
            except HostKeyError:
                raise  # never fall back to the password on a foreign host key
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
    attempt(password=password)
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
        print(f"  pinned host keys: {', '.join(auth.host_keys) or 'NONE (host key not verified)'}")
        return 0 if auth.ready else 1
    if args.action == "delete":
        path.unlink(missing_ok=True)
        print(f"VPS_CREDENTIAL_DELETED path={path}")
        return 0
    if args.action == "ssh-keygen":
        key = ssh_key_path()
        if os.name != "nt":
            print(
                "ssh-keygen here stores the passphrase with Windows DPAPI. On macOS/Linux run "
                "`ssh-keygen -t ed25519 -f ~/.ssh/tkbcherry_vps` and set TKB_VPS_KEY_FILE "
                "(+ TKB_VPS_KEY_PASSPHRASE, e.g. from the keychain); authorise its .pub from the "
                "Windows machine with `ssh-key-auth.py install-key --apply --pubkey <file.pub>`.",
                file=sys.stderr,
            )
            return 2
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
