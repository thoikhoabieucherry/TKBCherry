#!/usr/bin/env python3
"""Pin a NEW Cloud Run solver digest on the VPS in all 3 places, then restart.

usage: python tools/vps-deploy/pin-cloud-run-digest.py <digest-hex64> [--apply]

Without --apply it only prints what would change. With --apply it:
  1. backs up the two systemd drop-ins and the SQLite store (+ -wal/-shm) to
     /root/tkb-backups/digest-pin-<stamp>/,
  2. rewrites every 64-hex digest in
     /etc/systemd/system/tkb-app.service.d/cloud-run.conf (TKB_CLOUD_RUN_SOLVER_DIGEST
     and solverDigest inside TKB_CLOUD_PROFILE) and cloudrun.conf,
  3. updates kvstore key serverless_infrastructure_v1 -> profiles[*].solverDigest
     (Rust reads THIS one first — forgetting it means "Cloud Run khong nhan luot giai"),
  4. systemctl daemon-reload + restart tkb-app and checks the new digest is in the
     service environment.
Password comes from TKB_VPS_PASSWORD or the DPAPI store (vps_credentials.py).
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paramiko  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402


def main() -> int:
    digest = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    apply = "--apply" in sys.argv
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        print("usage: pin-cloud-run-digest.py <digest-hex64> [--apply]")
        return 2
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message())
        return 1
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30,
                   auth_timeout=30, look_for_keys=False, allow_agent=False)

    def run(cmd: str, timeout: int = 180) -> tuple[int, str, str]:
        _, out, err = client.exec_command(cmd, timeout=timeout)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        return out.channel.recv_exit_status(), o.strip(), e.strip()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bdir = f"/root/tkb-backups/digest-pin-{stamp}"
    remote_py = f'''
import sqlite3, json, re, shutil, os
NEW = "{digest}"
APPLY = {apply!r}
files = ["/etc/systemd/system/tkb-app.service.d/cloud-run.conf",
         "/etc/systemd/system/tkb-app.service.d/cloudrun.conf"]
os.makedirs("{bdir}", exist_ok=True)
for f in files:
    if not os.path.exists(f):
        print(f, "MISSING"); continue
    s = open(f, encoding="utf-8").read()
    print(f, "old digests:", sorted(set(re.findall(r"[0-9a-f]{{64}}", s))))
    ns = re.sub(r"[0-9a-f]{{64}}", NEW, s)
    if APPLY and ns != s:
        shutil.copy2(f, "{bdir}/" + os.path.basename(f))
        open(f, "w", encoding="utf-8").write(ns)
        print("  written")
db = "/opt/cherry-scheduler/rust_api/tkb_store.db"
if APPLY:
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(db + suf):
            shutil.copy2(db + suf, "{bdir}/tkb_store.db" + suf)
con = sqlite3.connect(db, timeout=30)
row = con.execute("select v from kvstore where k='serverless_infrastructure_v1'").fetchone()
if row is None:
    print("kvstore: no serverless_infrastructure_v1")
else:
    d = json.loads(row[0])
    changed = 0
    for p in d.get("profiles") or []:
        print("profile", p.get("id"), "old solverDigest", p.get("solverDigest"))
        if p.get("solverDigest") != NEW:
            p["solverDigest"] = NEW
            changed += 1
    if APPLY and changed:
        con.execute("update kvstore set v=? where k='serverless_infrastructure_v1'",
                    (json.dumps(d, ensure_ascii=False),))
        con.commit()
        print("kvstore updated profiles:", changed)
con.close()
'''
    code, o, e = run("python3 - <<'PYEOF'\n" + remote_py + "\nPYEOF\n")
    print(o)
    if e:
        print("stderr:", e)
    if apply:
        code, o, e = run(
            "systemctl daemon-reload && systemctl restart tkb-app && sleep 3 && systemctl is-active tkb-app"
            " && systemctl show tkb-app -p Environment | tr ' ' '\\n' | grep -c " + digest
        )
        print("restart:", o, e)
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
