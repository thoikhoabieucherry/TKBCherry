"""Create the operator-only Agent release key or print its public half."""

from __future__ import annotations

import base64
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIR.parents[1]
for candidate in (REPOSITORY_ROOT, SCRIPT_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from release_key import create_key, default_key_path, load_key  # noqa: E402


def main() -> int:
    path = default_key_path()
    key = load_key(path) if path.exists() else create_key(path)
    numbers = key.public_key().public_numbers()
    modulus = numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")
    encoded = base64.urlsafe_b64encode(modulus).decode("ascii").rstrip("=")
    print(f"Release key: {path}")
    print(f"RELEASE_PUBLIC_EXPONENT = {numbers.e}")
    print(f'RELEASE_PUBLIC_MODULUS_B64URL = "{encoded}"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
