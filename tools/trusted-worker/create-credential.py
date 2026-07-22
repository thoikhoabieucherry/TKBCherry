#!/usr/bin/env python3
"""Create a protected trusted-worker bearer and print only its server digest."""

from __future__ import annotations

import argparse
import hashlib
import os
import secrets
import stat
import sys
from pathlib import Path


TOKEN_PREFIX = "tkbt_"
DIGEST_DOMAIN = b"tkb-trusted-agent-token-v1\0"
DEFAULT_OUTPUT = Path("/etc/tkbcherry/trusted-worker.env")


def trusted_token_digest(token: str) -> str:
    normalized = token.strip()
    if (
        not normalized.startswith(TOKEN_PREFIX)
        or len(normalized) < len(TOKEN_PREFIX) + 32
        or len(normalized) > 512
        or any(ord(character) < 33 or ord(character) > 126 for character in normalized)
    ):
        raise ValueError("invalid trusted-worker token")
    return hashlib.sha256(DIGEST_DOMAIN + normalized.encode("ascii")).hexdigest()


def create_credential(path: Path, *, token: str | None = None) -> str:
    """Atomically create a mode-0600 environment file and return its digest."""

    value = token or f"{TOKEN_PREFIX}{secrets.token_urlsafe(48)}"
    digest = trusted_token_digest(value)
    path = path.expanduser()
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as handle:
            handle.write(f"TKB_AGENT_TOKEN={value}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except BaseException:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return digest


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Create a trusted-worker credential without printing the raw bearer. "
            "The output file must not already exist."
        )
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    try:
        digest = create_credential(args.output)
    except FileExistsError:
        print(
            f"Credential already exists: {args.output}; remove it explicitly only when rotating.",
            file=sys.stderr,
        )
        return 2
    except (OSError, ValueError) as exc:
        print(f"Could not create trusted-worker credential: {exc}", file=sys.stderr)
        return 2
    print(f"TKB_TRUSTED_AGENT_TOKEN_SHA256={digest}")
    print(f"Credential written with mode 0600: {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
