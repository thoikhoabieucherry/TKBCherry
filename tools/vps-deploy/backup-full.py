#!/usr/bin/env python3
"""Download a verified full VPS application snapshot without storing secrets."""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
import shlex
import shutil
import sys
import tarfile
from pathlib import Path

import paramiko

from vps_credentials import resolve_vps_connection


def run_remote(client: paramiko.SSHClient, command: str, *, timeout: int = 7200) -> tuple[int, str, str]:
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    return stdout.channel.recv_exit_status(), output, error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--remote-dir", default="/opt/cherry-scheduler")
    args = parser.parse_args()

    destination = args.destination.expanduser().resolve()
    destination_is_empty = False
    if destination.exists():
        destination_is_empty = destination.is_dir() and next(destination.iterdir(), None) is None
        if not destination_is_empty:
            print(f"Refusing to overwrite existing destination: {destination}", file=sys.stderr)
            return 2

    host, user, password = resolve_vps_connection()
    password = password or getpass.getpass("VPS password: ")
    if not password:
        print("VPS password is required.", file=sys.stderr)
        return 2

    destination.parent.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_hex(6)
    staging = destination.with_name(f"{destination.name}.partial-{nonce}")
    local_archive = destination.parent / f".{destination.name}-vps-{nonce}.tar.gz"
    remote_archive = f"/tmp/tkb-full-backup-{nonce}.tar.gz"
    remote_dir = shlex.quote(str(args.remote_dir))
    remote_archive_quoted = shlex.quote(remote_archive)

    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        print(f"Creating live VPS snapshot from {args.remote_dir} ...", flush=True)
        client.connect(
            host,
            username=user,
            password=password,
            timeout=30,
            banner_timeout=30,
        )
        command = "; ".join(
            [
                "set -e",
                f"test -d {remote_dir}",
                f"rm -f -- {remote_archive_quoted}",
                "set +e",
                (
                    f"nice -n 10 tar --dereference --warning=no-file-changed -czpf {remote_archive_quoted} "
                    f"-C {remote_dir} ."
                ),
                "archive_status=$?",
                "set -e",
                '[ "$archive_status" -le 1 ]',
                f"test -s {remote_archive_quoted}",
                f"stat -c '%s' {remote_archive_quoted}",
            ]
        )
        code, output, error = run_remote(client, command)
        if code != 0:
            if error:
                print(error, file=sys.stderr)
            print(f"Could not create remote snapshot (exit {code}).", file=sys.stderr)
            return code or 3
        remote_size = int(output.strip().splitlines()[-1])
        print(f"Remote archive: {remote_size:,} bytes", flush=True)

        last_percent = -10

        def progress(transferred: int, total: int) -> None:
            nonlocal last_percent
            percent = int((transferred * 100) / max(1, total))
            rounded = min(100, (percent // 10) * 10)
            if rounded >= last_percent + 10:
                last_percent = rounded
                print(f"Downloading: {rounded}%", flush=True)

        sftp = client.open_sftp()
        try:
            sftp.get(remote_archive, str(local_archive), callback=progress)
        finally:
            sftp.close()

        if local_archive.stat().st_size != remote_size:
            print("Downloaded archive size does not match the VPS archive.", file=sys.stderr)
            return 4

        staging.mkdir(parents=False)
        with tarfile.open(local_archive, "r:gz") as archive:
            archive.extractall(staging, filter="data")

        file_count = sum(1 for path in staging.rglob("*") if path.is_file())
        byte_count = sum(path.stat().st_size for path in staging.rglob("*") if path.is_file())
        if file_count <= 0:
            print("Snapshot extracted no files.", file=sys.stderr)
            return 5

        if destination_is_empty:
            destination.rmdir()
        try:
            staging.replace(destination)
        except PermissionError:
            # Windows Defender/indexing can briefly hold a freshly extracted
            # child open and make the otherwise atomic directory rename fail
            # with WinError 5. A verified copy fallback still leaves the caller
            # with a complete snapshot and the finally block removes staging.
            shutil.copytree(staging, destination, copy_function=shutil.copy2)
            copied_files = [path for path in destination.rglob("*") if path.is_file()]
            copied_count = len(copied_files)
            copied_bytes = sum(path.stat().st_size for path in copied_files)
            if copied_count != file_count or copied_bytes != byte_count:
                shutil.rmtree(destination, ignore_errors=True)
                raise RuntimeError("Copied snapshot does not match extracted staging data")
        print(
            f"BACKUP_OK destination={destination} files={file_count} bytes={byte_count}",
            flush=True,
        )
        return 0
    finally:
        try:
            if client.get_transport() is not None and client.get_transport().is_active():
                run_remote(client, f"rm -f -- {remote_archive_quoted}", timeout=60)
        except Exception:
            pass
        client.close()
        try:
            local_archive.unlink(missing_ok=True)
        except OSError:
            pass
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
