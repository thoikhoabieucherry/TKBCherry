"""Create the signed public manifest for one packaged Agent release."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

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
from release_key import load_key  # noqa: E402


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
    key = load_key()
    public = key.public_key().public_numbers()
    modulus = public.n.to_bytes((public.n.bit_length() + 7) // 8, "big")
    encoded_modulus = base64.urlsafe_b64encode(modulus).decode("ascii").rstrip("=")
    if public.e != RELEASE_PUBLIC_EXPONENT or encoded_modulus != RELEASE_PUBLIC_MODULUS_B64URL:
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
    signature = key.sign(
        canonical_release_payload(payload),
        padding.PKCS1v15(),
        hashes.SHA256(),
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
