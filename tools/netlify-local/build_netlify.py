"""Dựng bản web KHÔNG ĐĂNG NHẬP để đăng lên Netlify (project "tkbcherry").

27/10/2026 (chủ dự án: "up trực tiếp lên tkbcherry, ko cần login vào thẳng trang app"):
lấy web/ hiện hành + lớp vỏ overlay/ (shared/auth-local.js: người dùng giả, kho dữ liệu
trường trong trình duyệt; modules/local-schools.js: danh sách trường; pages/local-planner.js:
ô thời lượng ⏱; local.css), sửa app.html / sapxep.html / storage.js cho dùng lớp vỏ đó.
Giải: nút gạt "Máy này" -> bộ giải tools/local-solver (CherrySetup.exe) ở 127.0.0.1:2211.
KHÔNG đăng kèm dữ liệu trường nào (bản V4 từng đăng web/data/<mã>.json công khai).

    python tools/netlify-local/build_netlify.py --out <thư mục> [--web <thư mục web>]
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OVERLAY = HERE / "overlay"
STAMP = "20261028-noserver-v7"

REDIRECTS = """/               /app                 302!
/index.html     /app                 302!
/login          /app                 302!
/school-portal  /app                 302!
/super-admin    /app                 302!
/app            /app.html            200
/pages/sapxep   /pages/sapxep.html   200
/pages/phanmon  /pages/phanmon.html  200
"""

HEADERS = """/*
  X-Robots-Tag: noindex, nofollow
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/download/*
  Content-Type: application/octet-stream
  Content-Disposition: attachment
  Cache-Control: no-cache
"""

APP_INIT_LOCAL = """    (async function(){
      // Bản không đăng nhập: shared/auth-local.js dựng người dùng giả + kho trong trình duyệt,
      // modules/local-schools.js quản lý danh sách trường.
      try{
        if(window.TKBRuntime && window.TKBRuntime.guardProtectedPage){
          await window.TKBRuntime.guardProtectedPage();
        }
      }catch(_){ }
    })();"""

STORAGE_HOST_BRANCH = """    if(window.__cherryHostStore && window.__cherryHostStore.isRemoteHost && typeof window.__cherryHostStore.readSchoolSync === "function"){
      // Bản không đăng nhập: kho trường nằm trong trình duyệt (shared/auth-local.js).
      try{
        const data = window.__cherryHostStore.readSchoolSync(schoolId);
        noteRemoteLoad(schoolId, data);
        return data;
      }catch(_){ }
    }
"""


def sub_once(text: str, pattern: str, repl: str, name: str, flags: int = 0) -> str:
    new, n = re.subn(pattern, lambda m: m.expand(repl), text, count=1, flags=flags)
    if n != 1:
        raise SystemExit(f"{name}: không thấy mẫu {pattern[:70]!r}")
    return new


def patch_file(path: Path, steps: list[tuple[str, str, int]], name: str) -> None:
    raw = path.read_bytes().decode("utf-8")
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n")
    for pattern, repl, flags in steps:
        text = sub_once(text, pattern, repl, name, flags)
    path.write_bytes((text.replace("\n", "\r\n") if crlf else text).encode("utf-8"))


def build(web: Path, out: Path, installer: Path | None = None) -> Path:
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} không trống — chọn thư mục mới.")
    shutil.copytree(web, out, dirs_exist_ok=True)
    for src in OVERLAY.rglob("*"):
        if src.is_file():
            dst = out / src.relative_to(OVERLAY)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    auth3 = r'<script src="{p}shared/auth-api\.js[^"]*"></script>\s*<script src="{p}shared/auth\.js[^"]*"></script>\s*<script src="{p}shared/runtime\.js[^"]*"></script>'
    patch_file(out / "app.html", [
        (auth3.format(p=""), f'<script src="shared/auth-local.js?v={STAMP}"></script>', 0),
        (r'(<link rel="stylesheet" href="runtime\.css[^"]*" />)', rf'\1\n  <link rel="stylesheet" href="local.css?v={STAMP}" />', 0),
        (r'shared/storage\.js\?v=[^"]*', f"shared/storage.js?v={STAMP}", 0),
        (r'(<script defer src="modules/cherry-file\.js[^"]*"></script>)', rf'\1\n  <script defer src="modules/local-schools.js?v={STAMP}"></script>', 0),
        (r'onclick="showSchoolSwitcher\(\)"', 'onclick="localSchoolsOpen()"', 0),
        (r'\s*<button type="button" class="btn btn-portal" id="btnUserPortal" hidden>Quản lý</button>', "", 0),
        (r'\s*<button type="button" class="btn btn-logout" id="btnLogout" title="Đăng xuất">Thoát</button>', "", 0),
        (r'    \(async function\(\)\{\n      const roles = \["school_admin".*?\n    \}\)\(\);', APP_INIT_LOCAL, re.S),
    ], "app.html")
    patch_file(out / "pages" / "sapxep.html", [
        (auth3.format(p=r"\.\./"), f'<script src="../shared/auth-local.js?v={STAMP}"></script>', 0),
        (r'(<link rel="stylesheet" href="\.\./tokens\.css[^"]*">)', rf'\1\n<link rel="stylesheet" href="../local.css?v={STAMP}">', 0),
        (r'\.\./shared/storage\.js\?v=[^"]*', f"../shared/storage.js?v={STAMP}", 0),
        (r'(<script src="tkb-rust-bridge\.js[^"]*"></script>)', rf'\1\n<script src="local-planner.js?v={STAMP}"></script>', 0),
    ], "sapxep.html")
    patch_file(out / "shared" / "storage.js", [
        (r'(  function loadRemoteSchoolDataSync\(schoolId\)\{\n    if\(remoteAuthRequired\)\{ noteRemoteLoad\(schoolId, null\); return null; \}\n)',
         r"\1" + STORAGE_HOST_BRANCH.replace("\\", "\\\\"), 0),
    ], "storage.js")

    if installer is not None:
        # Nút Cherry mời tải bộ cài ngay trên trang: /download/CherrySetup.exe (bridge
        # LOCAL_SOLVER_DOWNLOAD_URL_DEFAULT). Gói chỉ mang bytecode engine, không mã nguồn.
        (out / "download").mkdir(exist_ok=True)
        shutil.copy2(installer, out / "download" / "CherrySetup.exe")
    (out / "_redirects").write_text(REDIRECTS, encoding="utf-8")
    (out / "_headers").write_text(HEADERS, encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    for leftover in ("sitemap.xml",):
        (out / leftover).unlink(missing_ok=True)

    # Không bao giờ đăng dữ liệu trường.
    bad = [p for p in out.rglob("*") if p.is_file() and (
        p.suffix.lower() in (".cherry", ".db", ".sqlite") or "data" in p.relative_to(out).parts[:1]
    )]
    if bad:
        raise SystemExit(f"Có file dữ liệu trong bản dựng: {bad[:5]}")
    return out


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--web", default=str(REPO / "web"))
    ap.add_argument("--installer", default=None, help="CherrySetup.exe để đặt ở /download/ (build_installer.py)")
    args = ap.parse_args(argv)
    out = build(Path(args.web), Path(args.out), Path(args.installer) if args.installer else None)
    print(f"Đã dựng {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
