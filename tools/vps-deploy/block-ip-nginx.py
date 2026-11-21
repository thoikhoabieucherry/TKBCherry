#!/usr/bin/env python3
"""Block (or unblock) one client IP for the whole site at nginx level.

The app's own block (Super Admin -> Khoá trường -> `blockedIps`) only stops
login and registration; a blocked IP can still load pages and probe other
APIs. This adds `deny <ip>;` to /etc/nginx/conf.d/tkb-blocklist.conf, which
nginx.conf includes in the http block, so every server block returns 403.

usage:
  python tools/vps-deploy/block-ip-nginx.py <ip>             # dry run: show the blocklist
  python tools/vps-deploy/block-ip-nginx.py <ip> --apply     # add, nginx -t, reload
  python tools/vps-deploy/block-ip-nginx.py <ip> --remove    # take it out again

Safety: only that one file is written; the previous copy is kept as
`.bak`; if `nginx -t` fails the old file is restored and nginx is NOT
reloaded. A reload does not restart tkb-app or interrupt solver jobs.
Password: TKB_VPS_PASSWORD or the DPAPI store (see vps_credentials.py).
"""
from __future__ import annotations

import ipaddress
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

CONF = "/etc/nginx/conf.d/tkb-blocklist.conf"
USAGE = "usage: block-ip-nginx.py <ip> [--apply|--remove]"


def run(client, cmd: str) -> tuple[int, str]:
    _, stdout, stderr = client.exec_command(cmd, timeout=60)
    out = stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    try:
        ip = str(ipaddress.ip_address(argv[0]))
    except ValueError:
        print(f"not an IP address: {argv[0]!r}\n{USAGE}")
        return 2
    mode = argv[1] if len(argv) > 1 else "--dry-run"
    if mode not in ("--dry-run", "--apply", "--remove") or len(argv) > 2:
        print(USAGE)
        return 2

    import paramiko  # noqa: E402
    from vps_credentials import (  # noqa: E402
        connect_vps,
        missing_credential_message,
        resolve_vps_connection,
        vps_credentials_ready,
    )

    host, user, _password = resolve_vps_connection()
    if not vps_credentials_ready():
        print(missing_credential_message())
        return 2
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_vps(client, host=host, user=user, timeout=20)
    try:
        _, current = run(client, f"cat {CONF} 2>/dev/null || true")
        print("current blocklist:\n" + (current.strip() or "(empty)"))
        line = f"deny {ip};"
        present = line in current.splitlines()
        if mode == "--dry-run":
            print(f"\nDRY RUN: {ip} is {'blocked' if present else 'not blocked'}. Use --apply or --remove.")
            return 0
        if (mode == "--apply") == present:
            print("nothing to change")
            return 0
        run(client, f"cp -p {CONF} {CONF}.bak 2>/dev/null || rm -f {CONF}.bak")
        if mode == "--apply":
            run(client, f"printf '%s\\n' '# {ip} blocked by owner' '{line}' >> {CONF}")
        else:
            escaped = ip.replace(".", "\\.")
            run(client, f"sed -i '/^# {escaped} blocked/d; /^deny {escaped};$/d' {CONF}")
        code, out = run(client, "nginx -t")
        print(out.strip())
        if code != 0:
            run(client, f"if [ -f {CONF}.bak ]; then mv {CONF}.bak {CONF}; else rm -f {CONF}; fi")
            print("nginx -t FAILED -> restored the old blocklist, nothing reloaded")
            return 1
        _, out = run(client, "systemctl reload nginx && echo RELOAD_OK")
        print(out.strip())
        _, loaded = run(client, f"nginx -T 2>/dev/null | grep -c -F '{line}'")
        print(f"'{line}' lines in loaded config: {loaded.strip()}")
        return 0 if "RELOAD_OK" in out else 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
