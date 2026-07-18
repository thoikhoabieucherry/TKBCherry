#!/usr/bin/env python3
"""Deploy Cherry Scheduler to Ubuntu VPS via SSH/SFTP."""
from __future__ import annotations

import argparse
import os
import re
import secrets
import shlex
import stat
import sys
import tarfile
import tempfile
import time
from pathlib import Path

import paramiko

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import missing_credential_message, resolve_vps_connection

ROOT = Path(__file__).resolve().parents[2]
EXCLUDES = {
    ".git",
    ".agents",
    ".playwright-cli",
    "data",
    "node_modules",
    "mail-server/node_modules",
    "rust_api/target",
    "agent_helper/.build-windows",
    "agent_helper/dist",
    "solver_runtime/logs",
    "archived_logs",
    "latest_logs",
    "recovered_from_vps",
    "tools/home-deploy/bin",
    "tools/vps-deploy/diagnose.py",
    "tools/vps-deploy/super-admin.conf",
    "rust_server_e2e.log",
    "__pycache__",
    ".cursor",
    ".codex_tmp",
    ".ruff_cache",
}


def new_ssh_client() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    return client


def should_skip(rel: str) -> bool:
    parts = Path(rel).parts
    if not parts:
        return False
    if any(part in {".git", "__pycache__", "node_modules"} for part in parts):
        return True
    # Explorer/browser recovery commonly leaves numbered copies such as
    # ``web (1)`` or ``fix-python (1).py``.  They are never canonical release
    # inputs and may contain stale credentials, so keep them out defensively.
    if any(re.search(r" \(\d+\)(?:\.[^.]*)?$", part) for part in parts):
        return True
    if Path(rel).name == ".env" or rel.endswith((".db", ".sqlite", ".sqlite3", ".pyc")):
        return True
    for ex in EXCLUDES:
        if rel == ex or rel.startswith(ex + "/") or rel.startswith(ex + "\\"):
            return True
    if parts[0] == "rust_api" and any(part.startswith("target") for part in parts[1:]):
        return True
    if len(parts) == 1 and Path(rel).suffix.lower() in {".exe", ".rar"}:
        return True
    return False


def make_tarball() -> Path:
    nonce = secrets.token_hex(4)
    tmp = Path(tempfile.gettempdir()) / f"cherry-deploy-{int(time.time())}-{nonce}.tar.gz"
    with tarfile.open(tmp, "w:gz") as tar:
        for path in ROOT.rglob("*"):
            rel = path.relative_to(ROOT).as_posix()
            if should_skip(rel):
                continue
            # ROOT.rglob already walks descendants. recursive=False keeps a parent
            # directory from silently re-including files that should_skip rejected.
            tar.add(path, arcname=rel, recursive=False)
    return tmp


def run_ssh(host: str, user: str, password: str, command: str, timeout: int = 1800) -> tuple[int, str, str]:
    client = new_ssh_client()
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30)
    try:
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=True)
        del stdin
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return code, out, err
    finally:
        client.close()


def upload_files(
    host: str,
    user: str,
    password: str,
    tarball: Path,
    install_script: Path,
    remote_archive: str,
    remote_script: str,
) -> None:
    client = new_ssh_client()
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30)
    try:
        sftp = client.open_sftp()
        sftp.put(str(tarball), remote_archive)
        sftp.put(str(install_script), remote_script)
        sftp.chmod(remote_script, stat.S_IRWXU | stat.S_IRGRP | stat.S_IROTH)
        sftp.close()
    finally:
        client.close()


def main() -> int:
    default_host, default_user, saved_password = resolve_vps_connection()
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=default_host)
    parser.add_argument("--user", default=default_user)
    parser.add_argument("--password", default=saved_password)
    parser.add_argument("--domain", default="tkbcherry.com")
    args = parser.parse_args()
    if not args.password:
        print(missing_credential_message(), file=sys.stderr)
        return 1

    print("Creating deployment package...")
    tarball = make_tarball()
    install_script = Path(__file__).with_name("install-server.sh")
    deploy_id = secrets.token_hex(6)
    remote_archive = f"/tmp/cherry-deploy-{deploy_id}.tar.gz"
    remote_script = f"/tmp/install-server-{deploy_id}.sh"
    remote_upload = f"/tmp/cherry-upload-{deploy_id}"
    print(f"Package: {tarball} ({tarball.stat().st_size // 1024} KB)")

    print("Uploading to VPS...")
    upload_files(
        args.host,
        args.user,
        args.password,
        tarball,
        install_script,
        remote_archive,
        remote_script,
    )

    gmail_user = os.environ.get("GMAIL_USER", "")
    gmail_pass = os.environ.get("GMAIL_APP_PASSWORD", "")
    from_name = os.environ.get("FROM_NAME", "Cherry Scheduler")
    cleanup_command = f"rm -rf -- {shlex.quote(remote_upload)}; " \
        f"rm -f -- {shlex.quote(remote_archive)} {shlex.quote(remote_script)}"
    remote_parts = [
        "set -e",
        f"trap {shlex.quote(cleanup_command)} EXIT HUP INT TERM",
        "exec 9>/run/lock/cherry-scheduler-deploy.lock",
        "flock -n 9 || { echo 'Another Cherry Scheduler deployment is already running.' >&2; exit 75; }",
        "if systemctl is-active --quiet tkb-app; then echo 'tkb-app is already running; use update-deploy.py so solver jobs can drain.' >&2; exit 64; fi",
        f"mkdir -m 0700 {shlex.quote(remote_upload)}",
        f"tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(remote_upload)}",
        f"export TKB_DOMAIN={shlex.quote(args.domain)}",
        f"export GMAIL_USER={shlex.quote(gmail_user)}",
        f"export GMAIL_APP_PASSWORD={shlex.quote(gmail_pass)}",
        f"export FROM_NAME={shlex.quote(from_name)}",
        f"bash {shlex.quote(remote_script)}",
    ]
    remote_cmd = "; ".join(remote_parts)

    print("Running install on VPS (may take 10-20 minutes for Rust build)...")
    code, out, err = run_ssh(args.host, args.user, args.password, remote_cmd, timeout=3600)
    print(out.encode("utf-8", errors="replace").decode("utf-8", errors="replace"))
    if err:
        print(err, file=sys.stderr)
    try:
        tarball.unlink(missing_ok=True)
    except OSError:
        pass
    if code != 0:
        print(f"Install failed with exit code {code}", file=sys.stderr)
        return code
    if "DEPLOY_OK" not in out:
        print("Install finished but DEPLOY_OK marker missing", file=sys.stderr)
        return 2
    print("Deploy completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
