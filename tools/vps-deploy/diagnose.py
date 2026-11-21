import os
import sys

import paramiko

from vps_credentials import (
    connect_vps,
    missing_credential_message,
    resolve_vps_connection,
    vps_credentials_ready,
)

HOST, USER, _PASSWORD = resolve_vps_connection()
if not vps_credentials_ready():
    print(missing_credential_message(), file=sys.stderr)
    raise SystemExit(1)

c = paramiko.SSHClient()
c.load_system_host_keys()
c.set_missing_host_key_policy(paramiko.RejectPolicy())
connect_vps(c, host=HOST, user=USER, timeout=30)
cmds = [
    "curl -fsS http://127.0.0.1:1010/api/health",
    "curl -fsS http://127.0.0.1:1010/api/solver-state",
    "python3 -c 'import ortools, numpy, scipy, openpyxl; print(\"py deps ok\")'",
    "which python3",
    "python3 --version",
    "ls -la /opt/cherry-scheduler/solver_runtime/scripts/solve_stdio.py",
    "journalctl -u tkb-app -n 50 --no-pager",
]
for cmd in cmds:
    print("===", cmd)
    _, o, e = c.exec_command(cmd, timeout=120)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    print(out)
    if err:
        print("ERR:", err[:800])
c.close()
