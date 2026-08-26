#!/usr/bin/env python3
"""Rebuild the Rust API on the VPS from /opt/cherry-scheduler/rust_api and swap the binary.

usage: python tools/vps-deploy/build-rust.py [--apply]

Use after `deploy-files.py deploy <backup> rust_api/src/<file>...` (which only
copies sources). Builds with a separate CARGO_TARGET_DIR (/tmp/tkb-rust-release)
so the running binary is untouched until the build succeeds, backs up the old
binary to /root/tkb-backups/rust-bin-<stamp>/, installs the new one, restarts
tkb-app and checks /api/health. Without --apply it only builds (dry run).
Password comes from TKB_VPS_PASSWORD or the DPAPI store (vps_credentials.py).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paramiko  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402


def main() -> int:
    apply = "--apply" in sys.argv
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message())
        return 1
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30,
                   auth_timeout=30, look_for_keys=False, allow_agent=False)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log = f"/tmp/tkb-rust-build-{stamp}.log"
    build = (
        "set -e; [ ! -f $HOME/.cargo/env ] || . $HOME/.cargo/env; export PATH=$HOME/.cargo/bin:$PATH; "
        "cd /opt/cherry-scheduler/rust_api && CARGO_TARGET_DIR=/tmp/tkb-rust-release cargo build --release --locked"
    )
    print("building on VPS (release, ~3-6 min)...")
    _, out, err = client.exec_command(f"({build}) > {log} 2>&1; echo BUILD_EXIT=$?", timeout=1800)
    marker = out.read().decode("utf-8", "replace").strip()
    _, tail, _ = client.exec_command(f"tail -n 8 {log}", timeout=30)
    print(tail.read().decode("utf-8", "replace"))
    if "BUILD_EXIT=0" not in marker:
        print("BUILD FAILED; log at", log)
        client.close()
        return 3
    if not apply:
        print("dry run: binary built at /tmp/tkb-rust-release/release/tkb_rust_api, not installed")
        client.close()
        return 0
    # Do not restart while a solve is running: wait (up to ~10 min) for the
    # coordinator to report no active/queued jobs, like update-server.sh does.
    idle_wait = """python3 - <<'PY'
import json, time, urllib.request
for _ in range(120):
    try:
        with urllib.request.urlopen("http://127.0.0.1:1010/api/health", timeout=5) as r:
            v = json.load(r)
        active, queued = int(v.get("solverActiveJobs", -1)), int(v.get("solverQueuedJobs", -1))
    except Exception as e:  # noqa: BLE001
        active, queued = -1, -1
    if active == 0 and queued == 0:
        print("IDLE"); break
    print(f"busy active={active} queued={queued}", flush=True)
    time.sleep(5)
PY
"""
    _, out, _ = client.exec_command(idle_wait, timeout=700)
    idle_log = out.read().decode("utf-8", "replace").strip().splitlines()
    print("\n".join(idle_log[-3:]))
    if not idle_log or idle_log[-1] != "IDLE":
        print("solver still busy after waiting; binary built but NOT installed (re-run with --apply later)")
        client.close()
        return 4
    # Re-check idleness in the same remote command right before the restart:
    # 25/08 a solve started in the 8 s between the idle poll and the restart.
    swap = (
        f"set -e; mkdir -p /root/tkb-backups/rust-bin-{stamp}; "
        f"cp -p /opt/cherry-scheduler/rust_api/target/release/tkb_rust_api /root/tkb-backups/rust-bin-{stamp}/; "
        "install -m 0755 /tmp/tkb-rust-release/release/tkb_rust_api /opt/cherry-scheduler/rust_api/target/release/tkb_rust_api; "
        "h=$(curl -fsS --max-time 5 http://127.0.0.1:1010/api/health); "
        "case \"$h\" in *'\"solverActiveJobs\":0'*) ;; *) echo BUSY_AT_RESTART; exit 6;; esac; "
        "systemctl restart tkb-app; sleep 4; systemctl is-active tkb-app; "
        "curl -fsS --max-time 5 http://127.0.0.1:1010/api/health | head -c 300; echo"
    )
    _, out, err = client.exec_command(swap, timeout=120)
    swap_out = out.read().decode("utf-8", "replace")
    print(swap_out)
    e = err.read().decode("utf-8", "replace").strip()
    if e:
        print("stderr:", e)
    print(f"old binary backed up to /root/tkb-backups/rust-bin-{stamp}/tkb_rust_api")
    if "BUSY_AT_RESTART" in swap_out:
        print("a solve started right before the restart: new binary is on disk but the OLD process still runs; "
              "re-run `build-rust.py --apply` (build is cached) to restart when idle")
        client.close()
        return 4
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
