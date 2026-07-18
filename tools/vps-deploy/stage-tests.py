#!/usr/bin/env python3
"""Run the release test suites on an isolated VPS source snapshot."""

from __future__ import annotations

import os
import secrets
import shlex
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy import make_tarball, new_ssh_client, run_ssh  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402


def main() -> int:
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message(), file=sys.stderr)
        return 1

    archive = make_tarball()
    nonce = secrets.token_hex(6)
    remote_archive = f"/tmp/tkb-stage-{nonce}.tar.gz"
    remote_dir = f"/tmp/tkb-stage-{nonce}"
    client = new_ssh_client()
    try:
        client.connect(host, username=user, password=password, timeout=30, banner_timeout=30)
        sftp = client.open_sftp()
        try:
            sftp.put(str(archive), remote_archive)
            sftp.chmod(remote_archive, stat.S_IRUSR | stat.S_IWUSR)
            # Production archives intentionally exclude school data. The
            # scheduler fixture tests need only these non-secret demo workbooks,
            # so stage them separately under the isolated temporary directory.
            sftp.mkdir(remote_dir, mode=0o700)
            sftp.mkdir(f"{remote_dir}/data", mode=0o700)
            for workbook in sorted((ROOT / "data").glob("*.xlsx")):
                sftp.put(str(workbook), f"{remote_dir}/data/{workbook.name}")
        finally:
            sftp.close()
    finally:
        client.close()

    cleanup = f"rm -rf -- {shlex.quote(remote_dir)}; rm -f -- {shlex.quote(remote_archive)}"
    command = "; ".join(
        [
            "set -e",
            f"trap {shlex.quote(cleanup)} EXIT HUP INT TERM",
            f"mkdir -p -m 0700 {shlex.quote(remote_dir)}",
            f"tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(remote_dir)}",
            '[ ! -f "$HOME/.cargo/env" ] || . "$HOME/.cargo/env"',
            f"cd {shlex.quote(remote_dir)}",
            "python3 -m unittest discover -s solver_runtime/tests -p 'test_*.py'",
            "python3 -m unittest discover -s agent_helper/tests -p 'test_*.py'",
            "cd rust_api",
            "cargo test --locked",
            "echo STAGING_TESTS_OK",
        ]
    )
    try:
        code, stdout, stderr = run_ssh(host, user, password, command, timeout=3600)
        print(stdout)
        if stderr:
            print(stderr, file=sys.stderr)
        if code != 0:
            return code
        return 0 if "STAGING_TESTS_OK" in stdout else 2
    finally:
        archive.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
