#!/usr/bin/env python3
"""Upload the Rust API to a temporary VPS directory and run its locked tests."""

from __future__ import annotations

import os
import secrets
import shlex
import sys
import tarfile
import tempfile
from pathlib import Path

from deploy import new_ssh_client, run_ssh
from vps_credentials import missing_credential_message, resolve_vps_connection


ROOT = Path(__file__).resolve().parents[2]


def make_rust_archive() -> Path:
    destination = Path(tempfile.gettempdir()) / f"tkb-rust-test-{secrets.token_hex(6)}.tar.gz"
    source = ROOT / "rust_api"
    with tarfile.open(destination, "w:gz") as archive:
        for path in source.rglob("*"):
            relative = path.relative_to(ROOT)
            if any(part.startswith("target") for part in relative.parts):
                continue
            archive.add(path, arcname=relative.as_posix(), recursive=False)
    return destination


def main() -> int:
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message(), file=sys.stderr)
        return 1

    archive = make_rust_archive()
    nonce = secrets.token_hex(6)
    remote_archive = f"/tmp/tkb-rust-test-{nonce}.tar.gz"
    remote_dir = f"/tmp/tkb-rust-test-{nonce}"
    client = new_ssh_client()
    try:
        client.connect(host, username=user, password=password, timeout=30, banner_timeout=30)
        sftp = client.open_sftp()
        try:
            sftp.put(str(archive), remote_archive)
        finally:
            sftp.close()
    finally:
        client.close()

    cleanup = f"rm -rf -- {shlex.quote(remote_dir)}; rm -f -- {shlex.quote(remote_archive)}"
    command = "; ".join(
        [
            "set -e",
            f"trap {shlex.quote(cleanup)} EXIT HUP INT TERM",
            f"mkdir -m 0700 {shlex.quote(remote_dir)}",
            f"tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(remote_dir)}",
            '[ ! -f "$HOME/.cargo/env" ] || . "$HOME/.cargo/env"',
            f"cd {shlex.quote(remote_dir + '/rust_api')}",
            "cargo test --locked",
        ]
    )
    try:
        code, stdout, stderr = run_ssh(host, user, password, command, timeout=1800)
        print(stdout)
        if stderr:
            print(stderr)
        return code
    finally:
        archive.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
