#!/usr/bin/env python3
r"""Benchmark: CP-SAT voi ngan sach TU TE tren request that (chay tren may chu du an).

Cach dung (PowerShell, tu goc repo):
    python .\scratch\benchmark_cpsat_big_budget.py
    python .\scratch\benchmark_cpsat_big_budget.py --request solver_runtime\logs\solve-py-...-request.json --budget 300

Script se:
  1) Lay request moi nhat (status200) trong solver_runtime/logs (hoac file --request).
  2) Nang ngan sach: session 120s, period 90s, tong the --budget (mac dinh 300s).
  3) Bom qua solver_runtime/scripts/solve_stdio.py (dung stdio protocol nhu server).
  4) In metrics cuoi: du tiet?, buoi 1 tiet, gap2, gap1, tong buoi, thoi gian.
"""
from __future__ import annotations
import argparse, json, subprocess, sys, time, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGS = ROOT / "solver_runtime" / "logs"
SCRIPT = ROOT / "solver_runtime" / "scripts" / "solve_stdio.py"

import re as _re

def newest_request() -> Path:
    cands = list(LOGS.glob("solve-py-*-request.json"))
    if not cands:
        raise SystemExit("Khong tim thay request log trong solver_runtime/logs")
    def keyfn(p: Path):
        m = _re.search(r"-(\d+)of(\d+)-request", p.name)
        expected = int(m.group(2)) if m else 0
        m2 = _re.search(r"solve-py-(\d+)-", p.name)
        stamp = int(m2.group(1)) if m2 else 0
        return (expected, stamp)  # UU TIEN request LON NHAT (truong that), roi moi nhat
    return sorted(cands, key=keyfn)[-1]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--request", type=str, default="")
    ap.add_argument("--budget", type=int, default=300, help="tong tran giay (mac dinh 300)")
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) - 1))
    args = ap.parse_args()

    req_path = Path(args.request) if args.request else newest_request()
    print(f"Request: {req_path.name}")
    request = json.loads(req_path.read_text(encoding="utf-8"))
    st = request.setdefault("settings", {})
    B = max(120, int(args.budget))
    st.update({
        "num_workers": int(args.workers),
        "session_time_limit": max(90, B // 3),
        "period_time_limit": max(60, B // 4),
        "period_retry_time_limit": max(30, B // 8),
        "integrated_time_limit": B,
        "overall_time_limit_seconds": B,
        "optimization_time_limit_seconds": B,
        "backend_deadline_ms": B * 1000,
        "native_global_deadline_ms": B * 1000,
        "reference_watchdog_deadline_ms": B * 1000,
        "ui_allow_short_backend_deadline": False,
        "best_effort_on_timeout": True,
    })
    body = json.dumps(request, ensure_ascii=False).encode("utf-8")
    print(f"Budget: tong {B}s | session {st['session_time_limit']}s | period {st['period_time_limit']}s | workers {st['num_workers']}")
    print("Dang chay solver (co the vai phut)...")
    t0 = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT), "solve"],
        cwd=str(SCRIPT.parent.parent),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out, err = proc.communicate(input=body, timeout=B + 120)
    dt = time.time() - t0
    line = out.decode("utf-8", "replace").strip().splitlines()[-1] if out.strip() else "{}"
    try:
        wrapper = json.loads(line)
    except json.JSONDecodeError:
        print("KHONG DOC DUOC KET QUA. stderr cuoi:")
        print(err.decode("utf-8", "replace")[-2000:])
        return 1
    payload = wrapper.get("payload") or {}
    m = payload.get("metrics") or {}
    print("\n================= KET QUA =================")
    print(f"status           : {wrapper.get('status')}  | thoi gian thuc: {dt:.0f}s")
    print(f"Du tiet          : {m.get('scheduled_periods')}/{m.get('expected_periods')}  (chua xep: {m.get('unassigned_periods')})")
    def num(x):
        if isinstance(x,(int,float)): return x
        if isinstance(x,dict):
            try: return sum(v for v in x.values() if isinstance(v,(int,float)))
            except Exception: return x
        return x
    gd = m.get('gap_distribution') or {}
    def gcount(pred):
        t=0
        for k,v in (gd.items() if isinstance(gd,dict) else []):
            try:
                if pred(int(k)): t+=int(v)
            except Exception: pass
        return t
    print(f"Buoi 1 tiet      : {num(m.get('one_period_teacher_sessions'))}")
    print(f"Gap >= 2 (buoi)  : {gcount(lambda g: g>=2)}")
    print(f"Gap 1 (buoi)     : {gcount(lambda g: g==1)}")
    print(f"Tong buoi day    : {num(m.get('teacher_sessions'))}")
    print(f"Tong tiet trong  : {num(m.get('teacher_gap_periods'))}")
    print(f"hard_ok          : {m.get('hard_ok')}  | vi pham rang buoc app: {m.get('app_constraint_violation_count')}")
    gd = m.get('gap_distribution')
    if gd: print(f"gap_distribution : {gd}")
    print("===========================================")
    print("\nGui nguyen khoi KET QUA nay cho Claude de doi chieu voi FET engine nhe.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
