"""Đóng gói "Cherry trên máy này" thành file zip phát cho trường.

Gói gồm: cherry_local_solver.py + solver_jobs.py + start-cherry-local.bat + HUONG_DAN.txt
+ solver_runtime/ (src, scripts/solve_stdio.py, requirements.txt không có google-auth).
Không chứa dữ liệu trường, khoá hay địa chỉ máy chủ.

    python tools/local-solver/build_package.py [--out <thư mục>]
"""
from __future__ import annotations

import argparse
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNTIME = REPO / "solver_runtime"
PACKAGE_NAME = "cherry-may-nay"
TOOL_FILES = ("cherry_local_solver.py", "solver_jobs.py", "start-cherry-local.bat")
# Thư viện chỉ bản máy chủ cần (gọi Cloud Run) — máy trường không cần.
SERVER_ONLY_REQUIREMENTS = ("google-auth",)


def iter_runtime_files():
    for path in sorted((RUNTIME / "src").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            yield path
    yield RUNTIME / "scripts" / "solve_stdio.py"


def local_requirements() -> str:
    lines = []
    for line in (RUNTIME / "requirements.txt").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.strip().lower().startswith(SERVER_ONLY_REQUIREMENTS):
            lines.append(line.strip())
    return "\n".join(lines) + "\n"


def build(out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f"{PACKAGE_NAME}.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in TOOL_FILES:
            zf.write(HERE / name, f"{PACKAGE_NAME}/{name}")
        zf.write(HERE / "README.md", f"{PACKAGE_NAME}/HUONG_DAN.txt")
        for path in iter_runtime_files():
            zf.write(path, f"{PACKAGE_NAME}/solver_runtime/{path.relative_to(RUNTIME).as_posix()}")
        zf.writestr(f"{PACKAGE_NAME}/solver_runtime/requirements.txt", local_requirements())
    return zip_path


def main(argv: list[str] | None = None) -> int:
    # Cửa sổ cmd tiếng Anh dùng cp1252: in tiếng Việt sẽ lỗi.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(HERE / "dist"), help="thư mục ghi file zip (mặc định tools/local-solver/dist)")
    args = ap.parse_args(argv)
    if not (RUNTIME / "scripts" / "solve_stdio.py").exists():
        print(f"Không thấy {RUNTIME}", file=sys.stderr)
        return 2
    zip_path = build(Path(args.out))
    print(f"Đã tạo {zip_path} ({zip_path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
