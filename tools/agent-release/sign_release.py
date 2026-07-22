"""Create the signed public manifest for one packaged Agent release."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIR.parents[1]
for candidate in (REPOSITORY_ROOT, SCRIPT_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from agent_helper.updater import (  # noqa: E402
    RELEASE_ARCHIVE_PATH,
    RELEASE_PROTOCOL,
    RELEASE_PUBLIC_EXPONENT,
    RELEASE_PUBLIC_MODULUS_B64URL,
    SIGNATURE_ALGORITHM,
    canonical_release_payload,
    parse_release_manifest,
)
from agent_helper.state import _windows_dpapi  # noqa: E402


KEY_PREFIX = b"TKB-RELEASE-KEY-DPAPI-V1\0"
RSA_ENCRYPTION_ALGORITHM_DER = bytes.fromhex(
    "300d06092a864886f70d0101010500"
)
SHA256_DIGEST_INFO_PREFIX = bytes.fromhex(
    "3031300d060960864801650304020105000420"
)


def _default_key_path() -> Path:
    configured = os.environ.get("TKB_AGENT_RELEASE_SIGNING_KEY", "").strip()
    if configured:
        return Path(configured).expanduser()
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "TKBCherry" / "ReleaseSigning" / "agent-release-key.dpapi"


def _der_length(data: bytes, offset: int) -> tuple[int, int]:
    if offset >= len(data):
        raise ValueError("truncated DER length")
    first = data[offset]
    offset += 1
    if first < 0x80:
        return first, offset
    count = first & 0x7F
    if count == 0 or count > 4 or offset + count > len(data):
        raise ValueError("invalid DER length")
    encoded = data[offset : offset + count]
    if encoded[0] == 0:
        raise ValueError("non-minimal DER length")
    length = int.from_bytes(encoded, "big")
    if length < 0x80:
        raise ValueError("non-minimal DER length")
    return length, offset + count


def _der_value(
    data: bytes, offset: int, expected_tag: int
) -> tuple[bytes, int]:
    if offset >= len(data) or data[offset] != expected_tag:
        raise ValueError("unexpected DER tag")
    length, content_start = _der_length(data, offset + 1)
    content_end = content_start + length
    if content_end > len(data):
        raise ValueError("truncated DER value")
    return data[content_start:content_end], content_end


def _der_integer(data: bytes, offset: int) -> tuple[int, int]:
    encoded, next_offset = _der_value(data, offset, 0x02)
    if not encoded or encoded[0] & 0x80:
        raise ValueError("invalid positive DER integer")
    if len(encoded) > 1 and encoded[0] == 0 and encoded[1] < 0x80:
        raise ValueError("non-minimal DER integer")
    return int.from_bytes(encoded, "big"), next_offset


def _parse_pkcs8_rsa_private_key(raw: bytes) -> tuple[int, int, int]:
    private_info, outer_end = _der_value(raw, 0, 0x30)
    if outer_end != len(raw):
        raise ValueError("trailing PKCS8 data")
    offset = 0
    version, offset = _der_integer(private_info, offset)
    algorithm, offset = _der_value(private_info, offset, 0x30)
    private_key, offset = _der_value(private_info, offset, 0x04)
    if offset != len(private_info) or version != 0:
        raise ValueError("unsupported PKCS8 key")
    if b"\x30" + bytes([len(algorithm)]) + algorithm != RSA_ENCRYPTION_ALGORITHM_DER:
        raise ValueError("release key is not RSA")

    rsa_key, rsa_outer_end = _der_value(private_key, 0, 0x30)
    if rsa_outer_end != len(private_key):
        raise ValueError("trailing RSA key data")
    offset = 0
    rsa_version, offset = _der_integer(rsa_key, offset)
    values: list[int] = []
    for _ in range(8):
        value, offset = _der_integer(rsa_key, offset)
        values.append(value)
    if offset != len(rsa_key) or rsa_version != 0:
        raise ValueError("unsupported RSA private key")
    modulus, exponent, private_exponent, prime_p, prime_q, exponent_p, exponent_q, coefficient = values
    if (
        prime_p * prime_q != modulus
        or exponent_p != private_exponent % (prime_p - 1)
        or exponent_q != private_exponent % (prime_q - 1)
        or (coefficient * prime_q) % prime_p != 1
        or (private_exponent * exponent) % math.lcm(prime_p - 1, prime_q - 1) != 1
    ):
        raise ValueError("RSA private key consistency check failed")
    return modulus, exponent, private_exponent


def _load_private_numbers() -> tuple[int, int, int]:
    source = _default_key_path()
    payload = source.read_bytes()
    if os.name != "nt" or not payload.startswith(KEY_PREFIX):
        raise RuntimeError("release key is not a Windows DPAPI key")
    raw = bytearray(_windows_dpapi(payload[len(KEY_PREFIX) :], decrypt=True))
    try:
        modulus, exponent, private_exponent = _parse_pkcs8_rsa_private_key(bytes(raw))
    finally:
        raw[:] = b"\0" * len(raw)
    if modulus.bit_length() != 3072:
        raise RuntimeError("release key must be a 3072-bit RSA key")
    return modulus, exponent, private_exponent


def _rsa_pkcs1_sha256_sign(payload: bytes, modulus: int, private_exponent: int) -> bytes:
    key_bytes = (modulus.bit_length() + 7) // 8
    digest_info = SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(payload).digest()
    padding_length = key_bytes - len(digest_info) - 3
    if padding_length < 8:
        raise ValueError("RSA key is too small for SHA-256")
    encoded = b"\x00\x01" + (b"\xff" * padding_length) + b"\x00" + digest_info
    signature = pow(int.from_bytes(encoded, "big"), private_exponent, modulus)
    return signature.to_bytes(key_bytes, "big")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    modulus, public_exponent, private_exponent = _load_private_numbers()
    modulus_bytes = modulus.to_bytes((modulus.bit_length() + 7) // 8, "big")
    encoded_modulus = base64.urlsafe_b64encode(modulus_bytes).decode("ascii").rstrip("=")
    if (
        public_exponent != RELEASE_PUBLIC_EXPONENT
        or encoded_modulus != RELEASE_PUBLIC_MODULUS_B64URL
    ):
        raise SystemExit("release key does not match the public key embedded in the Agent")

    archive = arguments.archive.resolve(strict=True)
    executable = arguments.executable.resolve(strict=True)
    published_at = datetime.now(timezone.utc).replace(microsecond=0).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    payload: dict[str, object] = {
        "archiveSha256": _sha256(archive),
        "archiveSize": archive.stat().st_size,
        "archiveUrl": f"{RELEASE_ARCHIVE_PATH}?v={arguments.version}",
        "executableSha256": _sha256(executable),
        "executableSize": executable.stat().st_size,
        "protocol": RELEASE_PROTOCOL,
        "publishedAt": published_at,
        "signatureAlgorithm": SIGNATURE_ALGORITHM,
        "version": arguments.version,
    }
    signature = _rsa_pkcs1_sha256_sign(
        canonical_release_payload(payload),
        modulus,
        private_exponent,
    )
    manifest = dict(payload)
    manifest["signature"] = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
    encoded = (json.dumps(manifest, ensure_ascii=True, sort_keys=True, indent=2) + "\n").encode(
        "utf-8"
    )
    parse_release_manifest(encoded)

    destination = arguments.output.resolve(strict=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(encoded)
    temporary.replace(destination)
    print(f"Signed Agent release manifest created at: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
