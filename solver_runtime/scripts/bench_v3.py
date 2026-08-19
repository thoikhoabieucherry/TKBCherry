"""Benchmark tkb_engine_v3 on real request fixtures.

Usage: python bench_v3.py <request.json> [seconds] [workers]
Prints the lexicographic quality tuple + authoritative validate.py metrics.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def main() -> int:
    request_path = Path(sys.argv[1])
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    request = json.loads(request_path.read_text(encoding="utf-8"))
    ui_data = request.get("data") or request
    settings = dict(request.get("settings") or {})
    settings["overall_time_limit_seconds"] = seconds
    settings["optimization_time_limit_seconds"] = seconds
    settings["backend_deadline_ms"] = seconds * 1000
    if workers:
        settings["workers_override"] = workers
        settings["num_workers"] = workers

    from tkb_engine_v3.entry import solve_from_ui_data_v3

    def progress(event: dict) -> None:
        stage = event.get("stage", "")
        message = event.get("message", "")
        print(f"  [{time.strftime('%H:%M:%S')}] {stage}: {message}", flush=True)

    started = time.monotonic()
    payload = solve_from_ui_data_v3(ui_data, settings, progress=progress)
    elapsed = time.monotonic() - started

    metrics = payload.get("metrics", {})
    gap_dist = metrics.get("gap_distribution", {})
    gap2_sessions = sum(v for k, v in gap_dist.items() if int(k) >= 2)
    gap1_sessions = gap_dist.get(1, gap_dist.get("1", 0))
    print("=" * 70)
    print(f"elapsed             : {elapsed:.1f}s")
    print(f"scheduled/expected  : {metrics.get('scheduled_periods')}/{metrics.get('expected_periods')}")
    print(f"hard_ok             : {metrics.get('hard_ok')}  core={metrics.get('core_hard_ok')}")
    print(f"app violations      : {metrics.get('app_constraint_violation_count')}")
    print(f"one-period sessions : {metrics.get('one_period_teacher_sessions')}")
    print(f"gap>=2 sessions     : {gap2_sessions}")
    print(f"gap==1 sessions     : {gap1_sessions}")
    print(f"teacher sessions    : {metrics.get('teacher_sessions')}")
    print(f"unassigned          : {metrics.get('unassigned_periods', 0)}")
    print(f"engine details      : {payload.get('solver', {}).get('engine_v3')}")
    viols = metrics.get("app_constraint_violations") or []
    if viols:
        print("--- first violations ---")
        for v in viols[:10]:
            print("   ", v.get("kind"), "-", v.get("message"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
