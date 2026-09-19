#!/usr/bin/env python3
"""Sinh docs/CODE_MAP.md -- muc luc cho cac file nguon khong lo.

59% code cua du an (115.595 / 192.988 dong) nam trong 6 file, moi file 9k-27k
dong. Khong tach nho duoc ngay (xem phan "Vi sao chua tach" trong CODE_MAP.md),
nen it nhat phai co muc luc de biet logic nam o dau ma nhay toi.

    python tools/make-code-map.py           # ghi docs/CODE_MAP.md
    python tools/make-code-map.py --check   # chi bao muc luc co lo thoi khong (CI)

Cach gom cum: khong doan theo ngu nghia, ma gom theo TIEN TO ten ham -- cach dat
ten trong repo nay von da theo chu de (_eject_*, _force_*, solve_*, render*,
tkbRun*...). Cum nao chi co 1 thanh vien thi don vao muc "Le te".
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "CODE_MAP.md"

# (duong dan, mo ta ngan) -- xep theo so dong giam dan
TARGETS = [
    ("solver_runtime/src/tkb_new/adapter.py",
     "Cau noi giua du lieu UI va cac bo giai; chua phan lon logic dieu phoi."),
    ("rust_api/src/main.rs",
     "Toan bo HTTP API cua backend Rust: dinh tuyen, phien, kho SQLite, hang doi giai."),
    ("web/pages/tkb-rust-bridge.js",
     "Cau noi trinh duyet -> backend: nut Cherry / Toi uu v3, ngan sach thoi gian, cong chat luong."),
    ("rust_api/src/native_solver.rs",
     "Bo giai native trong Rust (duong nhanh, khong qua Python)."),
    ("web/pages/phanmon.js",
     "Man hinh Phan cong + Xep TKB: bang, thao tac o, thong ke, xuat file."),
    ("web/pages/tkb-fet-engine.js",
     "Engine FET thuan JS chay trong trinh duyet (nut ▶)."),
]

# Bat ky hieu cap cao nhat theo tung ngon ngu.
PATTERNS = {
    ".py": [
        (re.compile(r"^class\s+([A-Za-z_]\w*)"), "class"),
        (re.compile(r"^(?:async\s+)?def\s+([A-Za-z_]\w*)"), "def"),
    ],
    ".rs": [
        (re.compile(r"^(?:pub\s+)?struct\s+([A-Za-z_]\w*)"), "struct"),
        (re.compile(r"^(?:pub\s+)?enum\s+([A-Za-z_]\w*)"), "enum"),
        (re.compile(r"^impl(?:<[^>]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)"), "impl"),
        (re.compile(r"^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)"), "fn"),
    ],
    ".js": [
        (re.compile(r"^\s{0,4}class\s+([A-Za-z_$][\w$]*)"), "class"),
        (re.compile(r"^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"), "function"),
        (re.compile(r"^\s{0,4}window\.([A-Za-z_$][\w$]*)\s*="), "window"),
        (re.compile(r"^\s{0,4}(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)"), "function"),
        # Phuong thuc trong class: thut le 2-6 dau cach roi `ten(...)  {`.
        # Phai loai tu khoa dieu khien, neu khong `if(`, `for(`... se bi bat nham.
        (re.compile(r"^\s{2,6}(?:async\s+|static\s+|\*)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*$"), "method"),
    ],
}

# Tu khoa dieu khien trong JS -- khong phai ten ham, phai bo.
JS_TU_KHOA = {
    "if", "for", "while", "switch", "catch", "return", "typeof", "do",
    "else", "with", "function", "new", "delete", "void", "await", "yield",
}

# Tach ten thanh cac tu de lay tien to: _force_pair_session -> force
TACH = re.compile(r"[_\s]+|(?<=[a-z0-9])(?=[A-Z])")

BO_QUA_TIEN_TO = {"", "get", "set", "is", "has", "to", "on", "do", "make", "new", "the"}


def tien_to(ten: str) -> str:
    tu = [t.lower() for t in TACH.split(ten.strip("_")) if t]
    for t in tu:
        if t not in BO_QUA_TIEN_TO:
            return t
    return tu[0] if tu else "khac"


def quet(path: Path):
    ext = path.suffix
    pats = PATTERNS.get(ext, [])
    ra = []
    with path.open(encoding="utf-8", errors="replace") as fh:
        for i, dong in enumerate(fh, 1):
            for rx, loai in pats:
                m = rx.match(dong)
                if m:
                    ten = m.group(1)
                    if ext == ".js" and ten in JS_TU_KHOA:
                        break
                    ra.append((i, ten, loai))
                    break
    return ra


def dem_dong(path: Path) -> int:
    with path.open(encoding="utf-8", errors="replace") as fh:
        return sum(1 for _ in fh)


def dung_muc_luc() -> str:
    ra = []
    ra.append("# Mục lục code — 6 file nguồn khổng lồ\n")
    ra.append(
        "> **File này do máy sinh ra.** Đừng sửa tay — chạy `python tools/make-code-map.py`\n"
        "> để cập nhật sau khi đổi code. Kiểm tra lỗi thời: `python tools/make-code-map.py --check`.\n"
    )
    ra.append(
        "\n## Vì sao chưa tách nhỏ 6 file này\n\n"
        "`web/pages/tkb-rust-bridge.js` nằm trọn trong **một IIFE duy nhất**\n"
        "(`(function(){ \"use strict\"; ... })()`) — hàng trăm hàm dùng chung một phạm vi\n"
        "đóng, nên không thể cắt thành nhiều thẻ `<script>`; muốn tách phải chuyển sang\n"
        "ES module hoặc nâng toàn bộ trạng thái lên một namespace. Với số test đang fail\n"
        "sẵn (xem `docs/test-baseline.json`), chưa có lưới an toàn để làm việc đó.\n\n"
        "`web/pages/phanmon.js` thì **không** bọc IIFE — đây là ứng viên tách an toàn nhất\n"
        "khi nào muốn bắt đầu.\n\n"
        "Mục lục dưới đây là giải pháp tạm: không đổi một dòng code nào, nhưng cho biết\n"
        "logic nằm ở đâu để nhảy thẳng tới.\n"
    )

    tong_dong = 0
    bang = []
    than = []

    for rel, mota in TARGETS:
        path = ROOT / rel
        if not path.exists():
            than.append(f"\n## `{rel}`\n\n> **Không tìm thấy file này.**\n")
            continue
        sodong = dem_dong(path)
        tong_dong += sodong
        kyhieu = quet(path)
        bang.append((rel, sodong, len(kyhieu), mota))

        than.append(f"\n---\n\n## `{rel}`\n")
        than.append(f"\n{mota}\n")
        than.append(f"\n**{sodong:,} dòng · {len(kyhieu)} ký hiệu cấp cao nhất**\n")

        cum: "OrderedDict[str, list]" = OrderedDict()
        for ln, ten, loai in kyhieu:
            cum.setdefault(tien_to(ten), []).append((ln, ten, loai))

        nhieu = [(k, v) for k, v in cum.items() if len(v) >= 3]
        nhieu.sort(key=lambda kv: -len(kv[1]))
        letes = [x for k, v in cum.items() if len(v) < 3 for x in v]
        letes.sort()

        if nhieu:
            than.append("\n| Cụm | Số hàm | Vùng dòng | Vài ký hiệu tiêu biểu |\n")
            than.append("|---|---:|---|---|\n")
            for khoa, ds in nhieu:
                ds.sort()
                dau, cuoi = ds[0][0], ds[-1][0]
                vd = ", ".join(f"`{t}`" for _, t, _ in ds[:4])
                if len(ds) > 4:
                    vd += ", …"
                than.append(f"| **{khoa}** | {len(ds)} | {dau:,}–{cuoi:,} | {vd} |\n")

        if letes:
            than.append(f"\n<details><summary>Lẻ tẻ — {len(letes)} ký hiệu không thuộc cụm nào</summary>\n\n")
            for ln, ten, loai in letes:
                than.append(f"- `{ten}` *({loai})* — dòng {ln:,}\n")
            than.append("\n</details>\n")

    dau = [
        "\n## Tổng quan\n\n",
        "| File | Số dòng | Ký hiệu | Nội dung |\n",
        "|---|---:|---:|---|\n",
    ]
    for rel, sodong, sk, mota in bang:
        dau.append(f"| [`{rel}`](#{rel.replace('/', '').replace('.', '').replace('_', '-')}) "
                   f"| {sodong:,} | {sk} | {mota} |\n")
    dau.append(f"| | **{tong_dong:,}** | | |\n")

    return "".join(ra + dau + than)


def main(argv) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--check", action="store_true",
                    help="khong ghi, chi bao muc luc co lo thoi khong (ma thoat 1 = lo thoi)")
    a = ap.parse_args(argv)

    noidung = dung_muc_luc()

    if a.check:
        if not OUT.exists():
            print("Chua co docs/CODE_MAP.md -- chay `python tools/make-code-map.py`.")
            return 1
        if OUT.read_text(encoding="utf-8") != noidung:
            print("docs/CODE_MAP.md DA LO THOI -- chay `python tools/make-code-map.py`.")
            return 1
        print("docs/CODE_MAP.md con dung.")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(noidung, encoding="utf-8")
    print("Da ghi {} ({:,} ky tu)".format(OUT.relative_to(ROOT).as_posix(), len(noidung)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
