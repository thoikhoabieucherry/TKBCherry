#!/usr/bin/env python3
"""Inspect VPS auth registry and test login."""
import json
import os
import sqlite3
import sys
import urllib.request
import urllib.error

import paramiko

from vps_credentials import missing_credential_message, resolve_vps_connection


def ssh_run(client, cmd: str) -> str:
    _, stdout, stderr = client.exec_command(cmd, timeout=120)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    if err.strip():
        out += "\nSTDERR: " + err
    return out


def main() -> int:
    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message(), file=sys.stderr)
        return 1

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)

    cmds = [
        "find /opt/cherry-scheduler -name '*.db' -type f 2>/dev/null",
        "systemctl is-active tkb-app",
        "journalctl -u tkb-app -n 20 --no-pager",
    ]
    for cmd in cmds:
        print(f"\n=== {cmd} ===")
        print(ssh_run(client, cmd))

    db_paths = ssh_run(client, "find /opt/cherry-scheduler -name '*.db' -type f 2>/dev/null").strip().splitlines()
    for db_path in db_paths:
        if not db_path.strip():
            continue
        print(f"\n=== sqlite auth_registry in {db_path} ===")
        py = f"""
import sqlite3, json
conn = sqlite3.connect({db_path!r})
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print('tables:', cur.fetchall())
try:
    cur.execute("SELECT k, length(v) FROM kvstore")
    rows = cur.fetchall()
    print('keys:', rows)
    cur.execute("SELECT v FROM kvstore WHERE k='auth_registry'")
    row = cur.fetchone()
    if row:
        data = json.loads(row[0])
        users = data.get('users') or {{}}
        print('user count:', len(users))
        print('user ids:', list(users.keys())[:20])
        if 'suadmin' in users:
            u = users['suadmin']
            print('suadmin role:', u.get('role'))
            print('suadmin has hash:', bool(u.get('passwordHash')))
    else:
        print('no auth_registry key')
except Exception as e:
    print('error:', e)
conn.close()
"""
        sftp = client.open_sftp()
        remote = "/tmp/check_auth_db.py"
        with sftp.file(remote, "w") as f:
            f.write(py)
        sftp.close()
        print(ssh_run(client, f"python3 {remote}"))

    client.close()

    super_password = os.environ.get("TKB_SUPER_PASSWORD", "")
    if super_password:
        print("\n=== remote login test ===")
        pwd = super_password
        body = json.dumps({"loginId": "suadmin", "password": pwd, "clientIp": ""}).encode()
        req = urllib.request.Request(
            "https://tkbcherry.com/api/auth/login",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            resp = urllib.request.urlopen(req)
            print("login", resp.status, resp.read().decode())
        except urllib.error.HTTPError as e:
            print("login", e.code, e.read().decode())

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
