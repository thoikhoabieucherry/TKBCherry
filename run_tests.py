#!/usr/bin/env python3
"""Chay TOAN BO test cua du an bang MOT lenh.

Truoc 27/08/2026 test nam rai rac o 4 thu muc, moi thu muc mot cach chay khac
nhau, va khong co lenh nao chay het. Ban phai nho: solver_runtime can
PYTHONPATH=solver_runtime/src, e2e can `node --test`, 3 file e2e can backend
dang chay. Script nay nho ho.

    python run_tests.py                  # chay het (tru nhom can backend)
    python run_tests.py --list           # xem co nhung nhom nao
    python run_tests.py --group js-guard # chi mot nhom
    python run_tests.py --with-backend   # chay ca 3 test can server dang chay
    python run_tests.py --rust           # chay them cargo check + cargo test (cham)
    python run_tests.py --save-baseline  # ghi ket qua hien tai lam moc chuan
    python run_tests.py -v               # in log cua test moi hong

Sau moi lan chay, script doi chieu voi moc chuan trong docs/test-baseline.json
va chi ro:  [MOI HONG] truoc pass gio fail  |  [DA SUA] truoc fail gio pass.
Ma thoat = 1 CHI KHI co [MOI HONG]; cac test hong san khong lam do bang.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASELINE = ROOT / "docs" / "test-baseline.json"

# 3 file nay goi vao backend qua HTTP; khong co server thi fail la dung.
# Chay bang --with-backend sau khi mo `python start.py`.
CAN_BACKEND = (
    "app_assignment_subject_visibility",
    "app_data_integrity",
    "tkb_rust_bridge",
)


def find_node():
    """Tim node.exe: PATH truoc, roi den cac kho runtime cuc bo."""
    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        return found
    for base in (Path(os.environ.get("LOCALAPPDATA", "")), Path.home() / ".cache"):
        if not str(base) or not base.is_dir():
            continue
        for mau in ("**/node/bin/node.exe", "**/cua_node/*/bin/node.exe"):
            for cand in base.glob(mau):
                return str(cand)
    return None


NODE = find_node()


def node_cases(paths, dung_test_runner):
    if not NODE:
        return []
    co = ["--test"] if dung_test_runner else []
    return [(p.name, [NODE] + co + [str(p)], {}) for p in sorted(paths)]


HAS_PYTEST = (
    subprocess.call(
        [sys.executable, "-c", "import pytest"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    == 0
)


def py_cases(modules, pypath, root_dir):
    """Sinh lenh cho tung module test Python.

    Mot so file trong tests/ viet theo kieu pytest (ham `def test_*` roi, khong
    co lop TestCase) -- `python -m unittest` se bao "NO TESTS RAN" va tra ma
    thoat khac 0, trong khi thuc te chung khong hong. Nen file nao co dau vet
    pytest thi chay bang pytest; neu may chua cai pytest thi danh dau BO QUA.
    """
    env = {"PYTHONPATH": pypath} if pypath else {}
    ra = []
    for m in sorted(modules):
        ten = m.split(".")[-1]
        duong_dan = root_dir / (ten + ".py")
        kieu_pytest = False
        try:
            src = duong_dan.read_text(encoding="utf-8", errors="replace")
            kieu_pytest = "import pytest" in src or "\ndef test_" in src
            if "unittest.TestCase" in src:
                kieu_pytest = False
        except OSError:
            pass
        if kieu_pytest and not HAS_PYTEST:
            ra.append((ten, None, {"__bo_qua__": "chua cai pytest"}))
        elif kieu_pytest:
            ra.append((ten, [sys.executable, "-m", "pytest", "-q", str(duong_dan)], env))
        else:
            ra.append((ten, [sys.executable, "-m", "unittest", m], env))
    return ra


def build_groups(with_backend, with_rust):
    groups = {}

    # 1. Test canh hop dong -- KHONG co trong CI, chi chay o may
    groups["js-guard"] = {
        "mota": "Canh hop dong nut Cherry / FET / v3 (tools/tests)",
        "cases": node_cases(list((ROOT / "tools" / "tests").glob("*.js")), False),
    }

    # 2. Test e2e node
    e2e = sorted((ROOT / "e2e_tests").glob("*_node.test.js"))
    can_be = [p for p in e2e if any(k in p.name for k in CAN_BACKEND)]
    thuong = [p for p in e2e if p not in can_be]
    groups["js-e2e"] = {
        "mota": "Test e2e chay bang node --test (e2e_tests)",
        "cases": node_cases(thuong, True),
    }
    if with_backend:
        groups["js-e2e-backend"] = {
            "mota": "Test e2e CAN backend dang chay (chay python start.py truoc)",
            "cases": node_cases(can_be, True),
        }

    # 3. Test Python cua solver -- CAN PYTHONPATH=solver_runtime/src
    mods = [
        "solver_runtime.tests." + p.stem
        for p in (ROOT / "solver_runtime" / "tests").glob("test_*.py")
    ]
    groups["py-solver"] = {
        "mota": "Thuat toan solver (solver_runtime/tests)",
        "cases": py_cases(mods, str(ROOT / "solver_runtime" / "src"),
                          ROOT / "solver_runtime" / "tests"),
    }

    # 4. Test Python ha tang -- KHONG co trong CI
    mods = ["tests." + p.stem for p in (ROOT / "tests").glob("test_*.py")]
    groups["py-infra"] = {
        "mota": "Launcher / thong tin dang nhap VPS / dong goi (tests)",
        "cases": py_cases(mods, None, ROOT / "tests"),
    }

    # 5. Kiem tra cu phap cac bundle web
    if NODE:
        bundles = sorted(
            list((ROOT / "web" / "pages").glob("*.js"))
            + list((ROOT / "web" / "shared").glob("*.js"))
            + list((ROOT / "web").glob("*.js"))
        )
        groups["js-syntax"] = {
            "mota": "node --check tren cac bundle web",
            # Khoa theo duong dan tuong doi: web/ va web/pages/ co file trung ten
            # (tkb-fet-engine.js, tkb-fet-worker.js...), dung p.name se ghi de nhau.
            "cases": [(p.relative_to(ROOT).as_posix(), [NODE, "--check", str(p)], {})
                      for p in bundles],
        }

    if with_rust:
        manifest = str(ROOT / "rust_api" / "Cargo.toml")
        groups["rust"] = {
            "mota": "cargo check + cargo test (cham, vai phut)",
            "cases": [
                ("cargo check", ["cargo", "check", "--locked", "--manifest-path", manifest], {}),
                ("cargo test", ["cargo", "test", "--locked", "--manifest-path", manifest], {}),
            ],
        }

    return groups


def run_case(cmd, extra_env, timeout):
    if cmd is None:
        return None, extra_env.get("__bo_qua__", "bo qua")
    env = dict(os.environ)
    env.update(extra_env)
    try:
        proc = subprocess.run(
            cmd, cwd=str(ROOT), env=env, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
    except subprocess.TimeoutExpired:
        return False, "qua {}s".format(timeout)
    except FileNotFoundError as exc:
        return False, "khong chay duoc: {}".format(exc)
    out = (proc.stdout or b"").decode("utf-8", "replace")
    return proc.returncode == 0, out


def main(argv):
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--group", action="append", default=[])
    ap.add_argument("--with-backend", action="store_true")
    ap.add_argument("--rust", action="store_true")
    ap.add_argument("--save-baseline", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("-h", "--help", action="store_true")
    a = ap.parse_args(argv)

    if a.help:
        print(__doc__.strip())
        return 0

    groups = build_groups(a.with_backend, a.rust)

    if a.list:
        print("Cac nhom test:\n")
        for ten in groups:
            g = groups[ten]
            print("  {}  {:>3} test  - {}".format(ten.ljust(16), len(g["cases"]), g["mota"]))
        print("\nNode: {}".format(NODE or "KHONG TIM THAY -> bo qua moi nhom JS"))
        print("Moc chuan: {}".format(
            BASELINE.relative_to(ROOT).as_posix() if BASELINE.exists() else "(chua co)"))
        return 0

    if a.group:
        groups = dict((k, v) for k, v in groups.items() if k in a.group)
        if not groups:
            print("Khong co nhom nao khop. Dung --list de xem.", file=sys.stderr)
            return 2

    if not NODE:
        print("[!] Khong tim thay node.exe -> bo qua cac nhom JS.\n")

    ketqua = {}
    loi = {}
    batdau = time.time()

    for ten in groups:
        g = groups[ten]
        if not g["cases"]:
            continue
        print("\n== {}  ({} test)  {}".format(ten, len(g["cases"]), g["mota"]))
        pas = fai = bqua = 0
        for nhan, cmd, env in g["cases"]:
            ok, out = run_case(cmd, env, a.timeout)
            khoa = "{}/{}".format(ten, nhan)
            if ok is None:
                bqua += 1
                print("   BO QUA  {}  ({})".format(nhan, out))
                continue
            ketqua[khoa] = ok
            if ok:
                pas += 1
            else:
                fai += 1
                loi[khoa] = out
                print("   FAIL  {}".format(nhan))
        duoi = "   -> {} pass / {} fail".format(pas, fai)
        if bqua:
            duoi += " / {} bo qua".format(bqua)
        print(duoi)

    tong = len(ketqua)
    pas = sum(1 for v in ketqua.values() if v)
    print("\n" + "=" * 62)
    print("TONG: {} pass / {} fail / {} test  ({:.0f}s)".format(
        pas, tong - pas, tong, time.time() - batdau))

    if a.save_baseline:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(ketqua, indent=1, sort_keys=True), encoding="utf-8")
        print("Da ghi moc chuan: {} ({} test)".format(
            BASELINE.relative_to(ROOT).as_posix(), tong))
        return 0

    if not BASELINE.exists():
        print("\nChua co moc chuan. Chay `python run_tests.py --save-baseline` de ghi lai.")
        return 0

    goc = json.loads(BASELINE.read_text(encoding="utf-8"))
    moihong = sorted(k for k, v in ketqua.items() if not v and goc.get(k) is True)
    dasua = sorted(k for k, v in ketqua.items() if v and goc.get(k) is False)
    moico = sorted(k for k in ketqua if k not in goc)

    if dasua:
        print("\n[DA SUA] {} test truoc fail gio pass:".format(len(dasua)))
        for k in dasua:
            print("   + " + k)
    if moico:
        print("\n[MOI THEM] {} test chua co trong moc chuan:".format(len(moico)))
        for k in moico:
            print("   ? {}  ({})".format(k, "pass" if ketqua[k] else "FAIL"))
    if moihong:
        print("\n[MOI HONG] {} test truoc pass gio FAIL:".format(len(moihong)))
        for k in moihong:
            print("   - " + k)
            if a.verbose:
                for dong in loi.get(k, "").splitlines()[-12:]:
                    print("       " + dong)
        return 1

    print("\nKhong co test nao moi hong so voi moc chuan.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
