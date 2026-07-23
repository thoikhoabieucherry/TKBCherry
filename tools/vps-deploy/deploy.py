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
PACKAGE_PRODUCTION = "production"
PACKAGE_STAGING = "staging"
PACKAGE_PROFILES = {PACKAGE_PRODUCTION, PACKAGE_STAGING}

# Production is intentionally allowlisted. Adding a new runtime component must
# be accompanied by a packaging test so local tooling cannot silently reach the
# live application directory.
PRODUCTION_SUBTREES = {
    "rust_api/src",
    "solver_runtime/scripts",
    "solver_runtime/src",
}
PRODUCTION_FILES = {
    "mail-server/package-lock.json",
    "mail-server/package.json",
    "mail-server/server.js",
    "rust_api/Cargo.lock",
    "rust_api/Cargo.toml",
    "rust_api/fixtures/sample-data.json",
    "solver_runtime/requirements.txt",
    "tools/vps-deploy/solver-pool.conf",
}
STAGING_SUBTREES = {
    "agent_helper",
    "solver_runtime/tests",
    "tools/trusted-worker",
}
STAGING_FILES = {
    ".github/workflows/build-agent-windows.yml",
    "rust_api/fixtures/sample-data-with-class-off.json",
    "solver_runtime/requirements-wsl.txt",
    "tools/agent-release/sign_release.py",
}
WEB_RUNTIME_EXTENSIONS = {
    ".css",
    ".html",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".png",
    ".svg",
    ".wasm",
    ".webmanifest",
    ".zip",
}
WEB_RUNTIME_FILES = {
    "web/downloads/TKBCherryAgent-release.json",
}
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
    ".pytest_cache",
    ".ruff_cache",
}


def new_ssh_client() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    return client


def _matches_subtree(rel: str, subtree: str) -> bool:
    return rel == subtree or rel.startswith(subtree + "/")


def _is_parent_of(rel: str, candidate: str) -> bool:
    return bool(rel) and candidate.startswith(rel + "/")


def _profile_allows(rel: str, profile: str) -> bool:
    if profile not in PACKAGE_PROFILES:
        raise ValueError(f"Unknown deployment package profile: {profile}")

    if rel == "web" or rel.startswith("web/"):
        if rel == "web" or any(
            _is_parent_of(rel, candidate) for candidate in WEB_RUNTIME_FILES
        ):
            return True
        suffix = Path(rel).suffix.lower()
        return suffix in WEB_RUNTIME_EXTENSIONS or rel in WEB_RUNTIME_FILES

    subtrees = set(PRODUCTION_SUBTREES)
    files = set(PRODUCTION_FILES)
    if profile == PACKAGE_STAGING:
        subtrees.update(STAGING_SUBTREES)
        files.update(STAGING_FILES)

    if any(_matches_subtree(rel, subtree) for subtree in subtrees):
        return True
    if rel in files:
        return True
    return any(_is_parent_of(rel, candidate) for candidate in (*subtrees, *files))


def should_skip(rel: str, profile: str = PACKAGE_PRODUCTION) -> bool:
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
    name = Path(rel).name.lower()
    secret_env_name = (
        name == ".env"
        or name.startswith(".env.")
        or name.endswith(".env")
        or ".env." in name
    )
    if secret_env_name or rel.endswith(
        (".db", ".sqlite", ".sqlite3", ".pyc")
    ):
        return True
    for ex in EXCLUDES:
        if rel == ex or rel.startswith(ex + "/") or rel.startswith(ex + "\\"):
            return True
    if parts[0] == "rust_api" and any(part.startswith("target") for part in parts[1:]):
        return True
    if len(parts) == 1 and Path(rel).suffix.lower() in {".exe", ".rar"}:
        return True
    return not _profile_allows(Path(rel).as_posix(), profile)


def make_tarball(profile: str = PACKAGE_PRODUCTION) -> Path:
    if profile not in PACKAGE_PROFILES:
        raise ValueError(f"Unknown deployment package profile: {profile}")
    nonce = secrets.token_hex(4)
    tmp = Path(tempfile.gettempdir()) / f"cherry-deploy-{int(time.time())}-{nonce}.tar.gz"
    with tarfile.open(tmp, "w:gz") as tar:
        for path in ROOT.rglob("*"):
            rel = path.relative_to(ROOT).as_posix()
            if should_skip(rel, profile):
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
    tarball = make_tarball(PACKAGE_PRODUCTION)
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
        f"export TKB_DEPLOY_UPLOAD_DIR={shlex.quote(remote_upload)}",
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
