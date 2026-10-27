"""Dựng CherrySetup.exe — bộ cài "Cherry máy này" một lần, sau đó chạy ngầm.

Không cần Python trên máy trường: gói mang Python nhúng (python.org embeddable, cùng bản
với máy dựng) + ortools/numpy/scipy/openpyxl cài sẵn bằng pip --target. IExpress (có sẵn
trong Windows) bọc payload.zip + installer/install.ps1 thành một file exe; install.ps1
chép vào %LOCALAPPDATA%\\CherryMayNay, tạo lối tắt Startup, giao thức cherry-local://,
mục gỡ trong Settings > Apps, rồi bật bộ giải và mở trang kiểm tra 127.0.0.1:2211.

    python tools/local-solver/build_installer.py [--out <thư mục>] [--cache <thư mục tải>]

Cần mạng (tải Python nhúng + wheel), chạy trên Windows x64 với Python 3.12.
"""
from __future__ import annotations

import argparse
import compileall
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNTIME = REPO / "solver_runtime"
APP_FILES = ("cherry_local_solver.py", "solver_jobs.py", "status_page.html")
SERVER_ONLY_REQUIREMENTS = ("google-auth",)
# Biểu tượng 🍒 ở khay hệ thống (chỉ bản cài trên máy trường).
TRAY_REQUIREMENTS = ["pystray==0.19.5", "pillow"]
CHERRY_PNG = REPO / "web" / "assets" / "favicon-cherry.png"
IEXPRESS = Path(r"C:\Windows\System32\iexpress.exe")


def local_requirements() -> list[str]:
    out = []
    for line in (RUNTIME / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.lower().startswith(SERVER_ONLY_REQUIREMENTS):
            out.append(line)
    return out


def embed_python(stage: Path, cache: Path) -> Path:
    version = platform.python_version()
    name = f"python-{version}-embed-amd64.zip"
    cached = cache / name
    if not cached.exists():
        cache.mkdir(parents=True, exist_ok=True)
        url = f"https://www.python.org/ftp/python/{version}/{name}"
        print(f"Tải {url}")
        urllib.request.urlretrieve(url, cached)
    py_dir = stage / "python"
    with zipfile.ZipFile(cached) as zf:
        zf.extractall(py_dir)
    major_minor = "".join(version.split(".")[:2])
    pth = py_dir / f"python{major_minor}._pth"
    # Bật site-packages; cherry_local_solver.py và solve_stdio.py tự thêm đường dẫn mã của mình.
    pth.write_text(f"python{major_minor}.zip\n.\nLib\\site-packages\nimport site\n", encoding="ascii")
    site = py_dir / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    print("Cài thư viện bộ giải vào Python nhúng…")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
         "--target", str(site), "--only-binary=:all:", "--platform", "win_amd64",
         "--python-version", version.rsplit(".", 1)[0], "--implementation", "cp",
         *local_requirements(), *TRAY_REQUIREMENTS],
        check=True,
    )
    for junk in site.rglob("__pycache__"):
        shutil.rmtree(junk, ignore_errors=True)
    return py_dir


def copy_app(stage: Path, extra_origins: list[str]) -> None:
    app = stage / "app"
    app.mkdir(parents=True, exist_ok=True)
    for name in APP_FILES:
        shutil.copy2(HERE / name, app / name)
    if extra_origins:
        # Bản thử nghiệm: trang ngoài tkbcherry.com (vd Netlify) được gọi bộ giải.
        (app / "allowed_origins.txt").write_text("\n".join(extra_origins) + "\n", encoding="utf-8")
    shutil.copy2(CHERRY_PNG, app / "cherry.png")
    from PIL import Image  # máy dựng có Pillow; .ico cho lối tắt + mục gỡ cài đặt
    Image.open(CHERRY_PNG).save(app / "cherry.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128)])
    rt = app / "solver_runtime"
    shutil.copytree(RUNTIME / "src", rt / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (rt / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy2(RUNTIME / "scripts" / "solve_stdio.py", rt / "scripts" / "solve_stdio.py")
    (rt / "requirements.txt").write_text("\n".join(local_requirements()) + "\n", encoding="utf-8")
    strip_engine_sources(rt)


def strip_engine_sources(rt: Path) -> None:
    """Gói cài được tải công khai -> KHÔNG kèm mã nguồn engine: biên dịch sang bytecode -OO
    (bỏ chú thích + docstring) đặt đúng chỗ file .py (legacy layout, Python nạp được khi
    không có .py), rồi xoá .py. Bytecode vẫn dịch ngược được — chỉ làm khó, không bảo mật."""
    if not compileall.compile_dir(str(rt), quiet=1, legacy=True, optimize=2):
        raise SystemExit("Biên dịch bytecode engine thất bại")
    for py in rt.rglob("*.py"):
        if py.with_suffix(".pyc").exists():
            py.unlink()
    leftovers = list(rt.rglob("*.py"))
    if leftovers:
        raise SystemExit(f"Còn mã nguồn trong gói: {leftovers[:3]}")


def write_windows_text(src: Path, dst: Path, bom: bool) -> None:
    """PowerShell 5.1 đọc .ps1 không BOM theo ANSI -> chữ tiếng Việt hỏng; cmd cần CRLF."""
    text = src.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\n", "\r\n")
    dst.write_bytes(text.encode("utf-8-sig" if bom else "utf-8"))


def make_payload(stage: Path, out_zip: Path) -> None:
    write_windows_text(HERE / "installer" / "uninstall.ps1", stage / "uninstall.ps1", bom=True)
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(stage.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(stage).as_posix())


SED = """[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=Cai dat Cherry may nay (bo giai thoi khoa bieu chay tren may nay)?
DisplayLicense=
FinishMessage=Da cai xong Cherry may nay. Bo giai tu chay ngam moi khi bat may. Tren trang Sap xep, gat nut sang 'May nay' de dung.
TargetName={target}
FriendlyName=Cherry may nay
AppLaunched=cmd.exe /c install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=cmd.exe /c install.cmd
UserQuietInstCmd=cmd.exe /c install.cmd
FILE0="payload.zip"
FILE1="install.ps1"
FILE2="install.cmd"
[SourceFiles]
SourceFiles0={src}\\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"""


def build(out_dir: Path, cache: Path, extra_origins: list[str] | None = None) -> Path:
    if not IEXPRESS.exists():
        raise SystemExit("Không thấy iexpress.exe (chỉ dựng được trên Windows).")
    work = out_dir / "build"
    if work.exists():
        shutil.rmtree(work)
    stage = work / "stage"
    files = work / "files"
    stage.mkdir(parents=True)
    files.mkdir(parents=True)
    embed_python(stage, cache)
    copy_app(stage, list(extra_origins or []))
    print("Nén payload.zip…")
    make_payload(stage, files / "payload.zip")
    write_windows_text(HERE / "installer" / "install.ps1", files / "install.ps1", bom=True)
    write_windows_text(HERE / "installer" / "install.cmd", files / "install.cmd", bom=False)
    target = out_dir / "CherrySetup.exe"
    if target.exists():
        target.unlink()
    sed = work / "CherrySetup.sed"
    sed.write_text(SED.format(target=str(target), src=str(files)), encoding="mbcs")
    print("Đóng gói bằng IExpress…")
    subprocess.run([str(IEXPRESS), "/N", "/Q", str(sed)], check=True)
    if not target.exists():
        raise SystemExit("IExpress không tạo được CherrySetup.exe")
    return target


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(HERE / "dist"))
    ap.add_argument("--cache", default=str(HERE / "dist" / "cache"))
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="thêm trang được gọi bộ giải (bản thử nghiệm, vd https://ten.netlify.app)")
    args = ap.parse_args(argv)
    bad = [o for o in args.allow_origin if not o.lower().startswith("https://")]
    if bad:
        raise SystemExit(f"Chỉ nhận https://…: {bad}")
    target = build(Path(args.out), Path(args.cache), args.allow_origin)
    print(f"Đã tạo {target} ({target.stat().st_size // (1024 * 1024)} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
