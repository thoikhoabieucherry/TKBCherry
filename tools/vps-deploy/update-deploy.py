#!/usr/bin/env python3
"""Quick update deploy: upload package and run update-server.sh."""
from __future__ import annotations

import os
import secrets
import shlex
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy import PACKAGE_PRODUCTION, make_tarball, new_ssh_client, run_ssh  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402


def upload_update(
    host: str,
    user: str,
    password: str,
    tarball: Path,
    update_script: Path,
    remote_archive: str,
    remote_script: str,
) -> None:
    client = new_ssh_client()
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30)
    try:
        sftp = client.open_sftp()
        sftp.put(str(tarball), remote_archive)
        sftp.put(str(update_script), remote_script)
        sftp.chmod(remote_script, stat.S_IRWXU | stat.S_IRGRP | stat.S_IROTH)
        sftp.close()
    finally:
        client.close()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(errors="replace")

    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message(), file=sys.stderr)
        return 1

    print("Creating update package...")
    tarball = make_tarball(PACKAGE_PRODUCTION)
    update_script = Path(__file__).with_name("update-server.sh")
    deploy_id = secrets.token_hex(6)
    remote_archive = f"/tmp/cherry-deploy-{deploy_id}.tar.gz"
    remote_script = f"/tmp/update-server-{deploy_id}.sh"
    remote_upload = f"/tmp/cherry-upload-{deploy_id}"
    print(f"Package: {tarball} ({tarball.stat().st_size // 1024} KB)")

    print(f"Uploading to {host}...")
    upload_update(
        host,
        user,
        password,
        tarball,
        update_script,
        remote_archive,
        remote_script,
    )

    super_password = os.environ.get("TKB_SUPER_PASSWORD", "")
    remote_parts = ["set -e"]
    if super_password:
        remote_parts.append(f"export TKB_SUPER_PASSWORD={shlex.quote(super_password)}")
    remote_parts.extend(
        [
            f"export TKB_DEPLOY_UPLOAD_DIR={shlex.quote(remote_upload)}",
            f"export TKB_DEPLOY_ARCHIVE_PATH={shlex.quote(remote_archive)}",
            f"export TKB_DEPLOY_SCRIPT_PATH={shlex.quote(remote_script)}",
        ]
    )
    cleanup_command = f"rm -rf -- {shlex.quote(remote_upload)}; " \
        f"rm -f -- {shlex.quote(remote_archive)} {shlex.quote(remote_script)}"
    remote_parts.extend(
        [
            f"trap {shlex.quote(cleanup_command)} EXIT HUP INT TERM",
            f"mkdir -m 0700 {shlex.quote(remote_upload)}",
            f"tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(remote_upload)}",
            f"bash {shlex.quote(remote_script)}",
        ]
    )
    remote_cmd = "; ".join(remote_parts)
    print("Running update on VPS (Rust rebuild may take a few minutes)...")
    code, out, err = run_ssh(host, user, password, remote_cmd, timeout=3600)
    print(out)
    if err:
        print(err, file=sys.stderr)
    try:
        tarball.unlink(missing_ok=True)
    except OSError:
        pass
    if code != 0:
        print(f"Update failed: exit {code}", file=sys.stderr)
        return code
    if "UPDATE_OK" not in out:
        print("Update finished but UPDATE_OK marker missing", file=sys.stderr)
        return 2
    print("Update completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
