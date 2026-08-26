#!/usr/bin/env python3
"""Targeted, data-safe deploy of individual repo files to the VPS.

usage:
  python tools/vps-deploy/deploy-files.py preflight <rel-file> [<rel-file> ...]
  python tools/vps-deploy/deploy-files.py deploy <backup-name> <rel-file> [...]
  python tools/vps-deploy/deploy-files.py rollback <backup-name> <rel-file> [...]

deploy: for each file, `cp -p` the remote copy into /root/tkb-backups/<backup-name>/,
upload to <file>.uploading, compare sha256 with the local file, `mv` into place;
then `systemctl restart tkb-app` and print is-active. Never touches
tkb_store.db / -wal / -shm. Password: TKB_VPS_PASSWORD or the DPAPI store.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paramiko  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REMOTE_ROOT = "/opt/cherry-scheduler"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    # --no-restart: upload only (e.g. Rust sources that need build-rust.py, which
    # restarts once the solver is idle). 25/08: an unconditional restart here
    # killed a running Cloud Run solve and left its reservation orphaned.
    no_restart = "--no-restart" in sys.argv
    argv = [a for a in sys.argv[1:] if a != "--no-restart"]
    action = argv[0]
    if action == "preflight":
        backup_name, files = "", argv[1:]
    else:
        backup_name, files = argv[1], argv[2:]
    if not files:
        print(__doc__)
        return 2
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message())
        return 1
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30,
                   auth_timeout=30, look_for_keys=False, allow_agent=False)

    def run(cmd: str, timeout: int = 180) -> tuple[int, str]:
        _, out, _err = client.exec_command(cmd, timeout=timeout)
        o = out.read().decode("utf-8", "replace")
        return out.channel.recv_exit_status(), o.strip()

    def sha_local(rel: str) -> str:
        return hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()

    rc = 0
    if action == "preflight":
        for rel in files:
            _, o = run(f"test -f {REMOTE_ROOT}/{rel} && sha256sum {REMOTE_ROOT}/{rel} | cut -d' ' -f1 "
                       f"&& stat -c %s {REMOTE_ROOT}/{rel} || echo MISSING")
            print(rel, "| remote:", o.replace("\n", " "), "| local:", sha_local(rel)[:16], (ROOT / rel).stat().st_size)
        print("service:", run("systemctl is-active tkb-app")[1])
    elif action == "deploy":
        bdir = f"/root/tkb-backups/{backup_name}"
        run(f"mkdir -p {bdir}")
        sftp = client.open_sftp()
        for rel in files:
            remote = f"{REMOTE_ROOT}/{rel}"
            run(f"mkdir -p {remote.rsplit('/', 1)[0]}")
            _, status = run(f"test -f {remote} && cp -p {remote} {bdir}/{rel.replace('/', '__')} && echo BACKED || echo NEW")
            sftp.put(str(ROOT / rel), remote + ".uploading")
            _, remote_sha = run(f"sha256sum {remote}.uploading | cut -d' ' -f1")
            if remote_sha != sha_local(rel):
                print("SHA MISMATCH", rel, remote_sha, sha_local(rel))
                run(f"rm -f {remote}.uploading")
                rc = 3
                break
            run(f"mv -f {remote}.uploading {remote}")
            print("deployed", rel, f"({status})", remote_sha[:16])
        sftp.close()
        print("backup dir:", bdir)
        if no_restart:
            print("restart: skipped (--no-restart)")
        else:
            print("restart:", run("systemctl restart tkb-app && sleep 3 && systemctl is-active tkb-app")[1])
    elif action == "rollback":
        bdir = f"/root/tkb-backups/{backup_name}"
        for rel in files:
            src = f"{bdir}/{rel.replace('/', '__')}"
            print(run(f"test -f {src} && cp -p {src} {REMOTE_ROOT}/{rel} && echo RESTORED {rel} || echo NO_BACKUP {rel}")[1])
        print("restart:", run("systemctl restart tkb-app && sleep 3 && systemctl is-active tkb-app")[1])
    else:
        print(__doc__)
        rc = 2
    client.close()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
