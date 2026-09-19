#!/usr/bin/env python3
"""Diem vao DUY NHAT cho moi viec deploy.

Truoc 27/08/2026 co 3 file deploy_*.py nam rai rac o goc repo; mot trong so do
(deploy_web_to_vps.py) hardcode duong dan may cu nen da hong tu lau. Nay gom lai
mot cho, script that su nam trong tools/.

    python deploy.py cloudrun [tham so...]   # deploy Cloud Run tron goi
    python deploy.py web [tham so...]        # day nhanh web + solver len VPS
    python deploy.py files <file>...         # day tung file len VPS (an toan du lieu)
    python deploy.py --help

Moi tham so phia sau ten lenh duoc chuyen thang cho script goc, vi du:

    python deploy.py cloudrun --max-instances 3 --no-vps
    python deploy.py files web/pages/phanmon.js
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

COMMANDS = {
    "cloudrun": (
        ROOT / "tools" / "cloud-run" / "deploy-all.py",
        "Deploy Cloud Run tron goi: don revision cu, build, canary, chuyen traffic, "
        "cap nhat VPS. Tham so: --max-instances N, --no-vps, --clean-only, --profile-only",
    ),
    "web": (
        ROOT / "tools" / "vps-deploy" / "deploy-web-quick.py",
        "Day nhanh toan bo web/ + solver_runtime/src len VPS roi restart dich vu.",
    ),
    "files": (
        ROOT / "tools" / "vps-deploy" / "deploy-files.py",
        "Day tung file cu the len VPS, co backup va doi chieu sha256. "
        "KHONG bao gio dong vao tkb_store.db / -wal / -shm.",
    ),
}


def usage(code: int = 0) -> int:
    print(__doc__.strip())
    print("\nCac lenh co san:\n")
    width = max(len(name) for name in COMMANDS)
    for name, (script, mota) in COMMANDS.items():
        con = "" if script.exists() else "   [!] THIEU FILE"
        print(f"  {name.ljust(width)}  {mota}{con}")
        print(f"  {' ' * width}  -> {script.relative_to(ROOT).as_posix()}\n")
    return code


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help", "help"}:
        return usage(0)

    name, rest = argv[0], argv[1:]
    if name not in COMMANDS:
        print(f"Khong co lenh '{name}'.\n", file=sys.stderr)
        return usage(2)

    script, _ = COMMANDS[name]
    if not script.exists():
        print(f"Thieu file: {script}", file=sys.stderr)
        return 1

    return subprocess.call([sys.executable, str(script), *rest], cwd=str(ROOT))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
