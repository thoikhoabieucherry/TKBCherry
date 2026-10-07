#!/usr/bin/env python3
"""Serve /robots.txt and /sitemap.xml on tkbcherry.com straight from nginx.

Why nginx: the Rust static handler (`rust_api/src/main.rs::is_public_static_file`)
only serves html/js/css/images, so .txt/.xml would 404. Adding two exact-match
`location` blocks (same pattern as the TKB_AGENT_DOWNLOAD block) avoids touching
or rebuilding the backend. The public pages /about, /privacy and /terms need
nothing here: they are `web/<page>/index.html` and the Rust handler already
serves a directory's index.html.

usage:
  python tools/vps-deploy/install-public-seo-nginx.py            # dry run: print the new block / diff
  python tools/vps-deploy/install-public-seo-nginx.py --apply    # backup, write, nginx -t, reload
  python tools/vps-deploy/install-public-seo-nginx.py --remove --apply   # take the block out again

Safety: the current config is copied to /root/tkb-backups/nginx-public-seo-<stamp>/
first; if `nginx -t` fails the backup is restored and nginx is NOT reloaded.
Idempotent (block delimited by TKB_PUBLIC_SEO_BEGIN/END markers).
Password: TKB_VPS_PASSWORD or the DPAPI store (see vps_credentials.py).

Files: /opt/cherry-scheduler is mode 0700 (it holds the SQLite DB), so the
nginx worker (www-data) cannot read anything aliased inside it (403). `--apply`
therefore uploads the LOCAL web/robots.txt and web/sitemap.xml into the
world-readable PUBLIC_ROOT below (dir 0755, files 0644) every time it runs -
re-run it after editing either file. Do NOT loosen /opt/cherry-scheduler.
"""
from __future__ import annotations

import difflib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE_CONFIG = "/etc/nginx/sites-enabled/tkbcherry"
PUBLIC_ROOT = "/var/www/tkbcherry-public"
PUBLIC_FILES = ("robots.txt", "sitemap.xml")
BEGIN = "    # TKB_PUBLIC_SEO_BEGIN"
END = "    # TKB_PUBLIC_SEO_END"
ANCHOR = "    location / {"

BLOCK = f"""{BEGIN}
    # robots.txt / sitemap.xml for the public website (the Rust static
    # handler does not serve .txt/.xml). Managed by
    # tools/vps-deploy/install-public-seo-nginx.py (copies web/robots.txt and
    # web/sitemap.xml into {PUBLIC_ROOT}; the app dir is 0700).
    location = /robots.txt {{
        alias {PUBLIC_ROOT}/robots.txt;
        default_type text/plain;
        charset utf-8;
        add_header X-Content-Type-Options nosniff always;
    }}

    location = /sitemap.xml {{
        alias {PUBLIC_ROOT}/sitemap.xml;
        default_type application/xml;
        charset utf-8;
        add_header X-Content-Type-Options nosniff always;
    }}
{END}
"""


def strip_block(text: str) -> str:
    start = text.find(BEGIN)
    if start < 0:
        return text
    end = text.find(END, start)
    if end < 0:
        raise SystemExit("found TKB_PUBLIC_SEO_BEGIN without END - fix the config by hand")
    end = text.find("\n", end)
    end = len(text) if end < 0 else end + 1
    # Also drop one blank line left behind after the block.
    if text[end:end + 1] == "\n":
        end += 1
    return text[:start] + text[end:]


def with_block(text: str) -> str:
    base = strip_block(text)
    idx = base.find(ANCHOR)
    if idx < 0:
        raise SystemExit(f"anchor {ANCHOR.strip()!r} not found in {SITE_CONFIG}")
    return base[:idx] + BLOCK + "\n" + base[idx:]


def main() -> int:
    apply = "--apply" in sys.argv
    remove = "--remove" in sys.argv

    import paramiko  # noqa: E402
    from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402

    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message())
        return 1
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30,
                   auth_timeout=30, look_for_keys=False, allow_agent=False)

    def run(cmd: str, timeout: int = 60) -> tuple[int, str]:
        _, out, err = client.exec_command(cmd, timeout=timeout)
        text = out.read().decode("utf-8", "replace") + err.read().decode("utf-8", "replace")
        return out.channel.recv_exit_status(), text.strip()

    try:
        _, real_path = run(f"readlink -f {SITE_CONFIG}")
        real_path = real_path.splitlines()[0].strip()
        sftp = client.open_sftp()
        try:
            if apply and not remove:
                run(f"mkdir -p {PUBLIC_ROOT} && chmod 755 {PUBLIC_ROOT}")
                for name in PUBLIC_FILES:
                    local = REPO_ROOT / "web" / name
                    data = local.read_bytes()
                    tmp = f"{PUBLIC_ROOT}/.{name}.tkbnew"
                    with sftp.open(tmp, "w") as fh:
                        fh.write(data)
                    rc, out = run(f"chmod 644 {tmp} && mv -f {tmp} {PUBLIC_ROOT}/{name}")
                    if rc != 0:
                        print(f"upload {name} failed: {out}")
                        return 1
                    print(f"synced {PUBLIC_ROOT}/{name} ({len(data)} bytes)")
            with sftp.open(real_path, "r") as fh:
                current = fh.read().decode("utf-8")
            new = strip_block(current) if remove else with_block(current)
            if new == current:
                print("config already up to date:", real_path)
                return 0
            sys.stdout.write("".join(difflib.unified_diff(
                current.splitlines(True), new.splitlines(True), real_path, real_path + " (new)")))
            if not apply:
                print("\n(dry run - pass --apply to write, test and reload nginx)")
                return 0
            stamp = time.strftime("%Y%m%d-%H%M%S")
            bdir = f"/root/tkb-backups/nginx-public-seo-{stamp}"
            backup = f"{bdir}/{Path(real_path).name}"
            run(f"mkdir -p {bdir} && cp -p {real_path} {backup}")
            print("backup:", backup)
            with sftp.open(real_path + ".tkbnew", "w") as fh:
                fh.write(new.encode("utf-8"))
            run(f"chmod --reference={real_path} {real_path}.tkbnew && mv -f {real_path}.tkbnew {real_path}")
        finally:
            sftp.close()

        rc, out = run("nginx -t")
        print(out)
        if rc != 0:
            run(f"cp -p {backup} {real_path}")
            print("nginx -t FAILED - restored backup, nginx not reloaded")
            return 2
        rc, out = run("systemctl reload nginx && systemctl is-active nginx")
        print("reload:", out)
        return 0 if rc == 0 else 3
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
