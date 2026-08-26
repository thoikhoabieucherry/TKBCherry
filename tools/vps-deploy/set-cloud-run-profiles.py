#!/usr/bin/env python3
"""Upsert Cloud Run region profiles into the VPS kvstore (multi-region solver).

usage: python tools/vps-deploy/set-cloud-run-profiles.py <profiles.json> [--apply]
                                                        [--disable-missing]

<profiles.json> is the list printed/written by tools/cloud-run/deploy-regions.ps1
(-ProfilesOut). Each item: id, url, region, projectId, solverDigest, vcpu,
memoryGiB, maxConcurrency, priority, enabled.

Rust reads kvstore key `serverless_infrastructure_v1` on EVERY request, so no
restart is needed. Profiles are matched by url first (so the original
asia-southeast2 profile keeps its id and stays `activeProfileId`), then by id.
`activeProfileId`, `mode` and `fallback` are preserved. With --disable-missing,
existing profiles that are not in the file are set enabled=false (never
deleted, usage rows still reference their ids).

Without --apply it prints the merged config and exits. With --apply it backs
up the SQLite store (+ -wal/-shm) to /root/tkb-backups/profiles-<stamp>/ first.
Password comes from TKB_VPS_PASSWORD or the DPAPI store (vps_credentials.py).
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paramiko  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402

DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


def _validate(profiles: list[dict]) -> list[dict]:
    clean = []
    seen_ids: set[str] = set()
    for item in profiles:
        pid = str(item.get("id", "")).strip()
        url = str(item.get("url", "")).strip().rstrip("/")
        digest = str(item.get("solverDigest", "")).strip().lower()
        if not pid or pid in seen_ids:
            raise SystemExit(f"profile id missing/duplicate: {pid!r}")
        if not url.startswith("https://"):
            raise SystemExit(f"profile {pid}: url must be https: {url!r}")
        if not DIGEST_RE.fullmatch(digest):
            raise SystemExit(f"profile {pid}: solverDigest must be 64 hex")
        seen_ids.add(pid)
        clean.append(
            {
                "id": pid,
                "url": url,
                "audience": url,
                "region": str(item.get("region", "")).strip(),
                "projectId": str(item.get("projectId", "")).strip(),
                "enabled": bool(item.get("enabled", True)),
                "priority": int(item.get("priority", 0)),
                "vcpu": int(item.get("vcpu", 4)),
                "memoryGiB": float(item.get("memoryGiB", 8)),
                "maxConcurrency": int(item.get("maxConcurrency", 1)),
                "solverDigest": digest,
            }
        )
    return clean


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--apply" in sys.argv
    disable_missing = "--disable-missing" in sys.argv
    if len(args) != 1:
        print(__doc__)
        return 2
    incoming = _validate(json.loads(Path(args[0]).read_text(encoding="utf-8-sig")))
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message())
        return 1
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30,
                   auth_timeout=30, look_for_keys=False, allow_agent=False)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bdir = f"/root/tkb-backups/profiles-{stamp}"
    remote_py = f'''
import sqlite3, json, shutil, os
INCOMING = json.loads({json.dumps(json.dumps(incoming))})
APPLY = {apply!r}
DISABLE_MISSING = {disable_missing!r}
db = "/opt/cherry-scheduler/rust_api/tkb_store.db"
if APPLY:
    os.makedirs("{bdir}", exist_ok=True)
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(db + suf):
            shutil.copy2(db + suf, "{bdir}/tkb_store.db" + suf)
con = sqlite3.connect(db, timeout=30)
row = con.execute("select v from kvstore where k='serverless_infrastructure_v1'").fetchone()
if row is None:
    raise SystemExit("kvstore: no serverless_infrastructure_v1 (configure the primary profile in Super Admin first)")
d = json.loads(row[0])
existing = d.get("profiles") or []
by_url = {{str(p.get("url","")).rstrip("/"): p for p in existing}}
by_id = {{str(p.get("id","")): p for p in existing}}
touched = set()
for inc in INCOMING:
    target = by_url.get(inc["url"]) or by_id.get(inc["id"])
    if target is None:
        existing.append(inc); touched.add(inc["id"]); print("ADD ", inc["id"], inc["region"], inc["url"]); continue
    keep_id = target.get("id")
    before = json.dumps(target, sort_keys=True)
    for k, v in inc.items():
        if k == "id":
            continue
        target[k] = v
    touched.add(keep_id)
    print("UPD " if before != json.dumps(target, sort_keys=True) else "SAME", keep_id, target.get("region"), target.get("url"))
if DISABLE_MISSING:
    for p in existing:
        if p.get("id") not in touched and p.get("enabled", True):
            p["enabled"] = False; print("OFF ", p.get("id"), p.get("region"))
d["profiles"] = existing
active = d.get("activeProfileId")
if active and not any(p.get("id") == active and p.get("enabled", True) for p in existing):
    raise SystemExit(f"activeProfileId {{active}} would no longer be an enabled profile; aborting")
digests = sorted(set(p.get("solverDigest") for p in existing if p.get("enabled", True)))
print("enabled profiles:", sum(1 for p in existing if p.get("enabled", True)), "digests:", [x[:12] for x in digests])
print(json.dumps(d, ensure_ascii=False, indent=1))
if APPLY:
    con.execute("update kvstore set v=? where k='serverless_infrastructure_v1'", (json.dumps(d, ensure_ascii=False),))
    con.commit()
    print("kvstore updated; backup at {bdir}")
else:
    print("dry run (no --apply): nothing written")
con.close()
'''
    _, out, err = client.exec_command("python3 - <<'PYEOF'\n" + remote_py + "\nPYEOF\n", timeout=120)
    print(out.read().decode("utf-8", "replace"))
    e = err.read().decode("utf-8", "replace").strip()
    if e:
        print("stderr:", e)
    code = out.channel.recv_exit_status()
    client.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
