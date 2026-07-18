"""Local DPAPI storage for the Agent release-signing key."""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from agent_helper.state import _windows_dpapi


KEY_PREFIX = b"TKB-RELEASE-KEY-DPAPI-V1\0"


def default_key_path() -> Path:
    configured = os.environ.get("TKB_AGENT_RELEASE_SIGNING_KEY", "").strip()
    if configured:
        return Path(configured).expanduser()
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "TKBCherry" / "ReleaseSigning" / "agent-release-key.dpapi"


def create_key(path: Path | None = None) -> rsa.RSAPrivateKey:
    destination = path or default_key_path()
    if destination.exists():
        raise FileExistsError(f"release key already exists: {destination}")
    if os.name != "nt":
        raise RuntimeError("release signing keys must be created in Windows DPAPI")
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    raw = key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + f".tmp-{os.getpid()}")
    try:
        with temporary.open("xb") as handle:
            handle.write(KEY_PREFIX + _windows_dpapi(raw, decrypt=False))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return key


def load_key(path: Path | None = None) -> rsa.RSAPrivateKey:
    source = path or default_key_path()
    payload = source.read_bytes()
    if not payload.startswith(KEY_PREFIX) or os.name != "nt":
        raise RuntimeError("release key is not a Windows DPAPI key")
    raw = _windows_dpapi(payload[len(KEY_PREFIX) :], decrypt=True)
    key = serialization.load_der_private_key(raw, password=None)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
        raise RuntimeError("release key must be a 3072-bit RSA key")
    return key
