#!/usr/bin/env python3
"""Serve /media/*.mp4 (tutorial videos) on tkbcherry.com straight from nginx.

Why nginx: the Rust static handler (`rust_api/src/main.rs::is_public_static_file`)
does not serve .mp4 and reads the whole file per request without HTTP Range, so
phones (iOS Safari needs Range) could not play or seek a video served by it.
nginx handles Range itself. Same pattern as install-public-seo-nginx.py.

usage:
  python tools/vps-deploy/install-public-media-nginx.py                      # dry run: print the config diff
  python tools/vps-deploy/install-public-media-nginx.py --apply <file.mp4>…  # upload files, backup, write, nginx -t, reload
  python tools/vps-deploy/install-public-media-nginx.py --apply              # config only (no upload)
  python tools/vps-deploy/install-public-media-nginx.py --remove --apply     # take the block out (files stay)

Files: /opt/cherry-scheduler is mode 0700, so nginx cannot read inside it. Videos
are uploaded to MEDIA_ROOT below (dir 0755, files 0644) under their own file
name; the page references them as /media/<name>. They are NOT kept in git
(tens of MB each) - keep the source under scratch/ and re-run this tool to
replace one. `web/huong-dan/index.html` uses /media/huong-dan-xep-tkb.mp4.

Safety: the current config is copied to /root/tkb-backups/nginx-public-media-<stamp>/
first; if `nginx -t` fails the backup is restored and nginx is NOT reloaded.
Idempotent (block delimited by TKB_PUBLIC_MEDIA_BEGIN/END markers). Only .mp4
is served from the directory. Login: SSH key via vps_credentials.connect_vps
when this checkout has it, else TKB_VPS_PASSWORD / the DPAPI store.
"""
from __future__ import annotations

import difflib
import hashlib
import sys
import time
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent))

SITE_CONFIG = "/etc/nginx/sites-enabled/tkbcherry"
PUBLIC_ROOT = "/var/www/tkbcherry-public"
MEDIA_ROOT = f"{PUBLIC_ROOT}/media"
BEGIN = "    # TKB_PUBLIC_MEDIA_BEGIN"
END = "    # TKB_PUBLIC_MEDIA_END"
ANCHOR = "    location / {"

BLOCK = f"""{BEGIN}
    # Tutorial videos for the public website (the Rust static handler does not
    # serve .mp4 and has no Range support). Managed by
    # tools/vps-deploy/install-public-media-nginx.py (uploads into {MEDIA_ROOT}).
    location ^~ /media/ {{
        root {PUBLIC_ROOT};
        types {{ video/mp4 mp4; }}
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=86400" always;
        add_header X-Content-Type-Options nosniff always;
        try_files $uri =404;
    }}
{END}
"""


def strip_block(text: str) -> str:
    start = text.find(BEGIN)
    if start < 0:
        return text
    end = text.find(END, start)
    if end < 0:
        raise SystemExit("found TKB_PUBLIC_MEDIA_BEGIN without END - fix the config by hand")
    end = text.find("\n", end)
    end = len(text) if end < 0 else end + 1
    if text[end:end + 1] == "\n":
        end += 1
    return text[:start] + text[end:]


def with_block(text: str) -> str:
    base = strip_block(text)
    idx = base.find(ANCHOR)
    if idx < 0:
        raise SystemExit(f"anchor {ANCHOR.strip()!r} not found in {SITE_CONFIG}")
    return base[:idx] + BLOCK + "\n" + base[idx:]


def open_client():
    import paramiko  # noqa: E402
    import vps_credentials as creds  # noqa: E402

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    host, user, password = creds.resolve_vps_connection()
    if hasattr(creds, "connect_vps"):
        creds.connect_vps(client, host=host, user=user, timeout=30)
        return client
    if not password:
        raise SystemExit(creds.missing_credential_message())
    client.connect(host, username=user, password=password, timeout=30, banner_timeout=30,
                   auth_timeout=30, look_for_keys=False, allow_agent=False)
    return client


def main() -> int:
    args = sys.argv[1:]
    known = {"--apply", "--remove"}
    unknown = [a for a in args if a.startswith("-") and a not in known]
    if unknown or "-h" in args or "--help" in args:
        print(__doc__)
        return 0 if not [a for a in unknown if a not in {"-h", "--help"}] else 2
    apply = "--apply" in args
    remove = "--remove" in args
    uploads = [Path(a).resolve() for a in args if not a.startswith("-")]
    for path in uploads:
        if not path.is_file() or path.suffix.lower() != ".mp4":
            print("not an .mp4 file:", path)
            return 2

    client = open_client()

    def run(cmd: str, timeout: int = 120) -> tuple[int, str]:
        _, out, err = client.exec_command(cmd, timeout=timeout)
        text = out.read().decode("utf-8", "replace") + err.read().decode("utf-8", "replace")
        return out.channel.recv_exit_status(), text.strip()

    try:
        _, real_path = run(f"readlink -f {SITE_CONFIG}")
        real_path = real_path.splitlines()[0].strip()
        sftp = client.open_sftp()
        try:
            if apply and not remove and uploads:
                run(f"mkdir -p {MEDIA_ROOT} && chmod 755 {PUBLIC_ROOT} {MEDIA_ROOT}")
                for path in uploads:
                    tmp = f"{MEDIA_ROOT}/.{path.name}.tkbnew"
                    sftp.put(str(path), tmp)
                    local_sha = hashlib.sha256(path.read_bytes()).hexdigest()
                    _, remote_sha = run(f"sha256sum {tmp} | cut -d' ' -f1")
                    if remote_sha != local_sha:
                        run(f"rm -f {tmp}")
                        print("SHA MISMATCH", path.name, remote_sha, local_sha)
                        return 3
                    rc, out = run(f"chmod 644 {tmp} && mv -f {tmp} {MEDIA_ROOT}/{path.name}")
                    if rc != 0:
                        print(f"upload {path.name} failed: {out}")
                        return 1
                    print(f"synced {MEDIA_ROOT}/{path.name} ({path.stat().st_size} bytes, sha {local_sha[:16]})")
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
            bdir = f"/root/tkb-backups/nginx-public-media-{stamp}"
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
