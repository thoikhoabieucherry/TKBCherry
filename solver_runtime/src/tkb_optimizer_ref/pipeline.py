from __future__ import annotations

from pathlib import Path
import json
from typing import Any, Callable

from .export_csv import write_session_plan_csv, write_timetable_csv
from .io_excel import load_school_data
from .period_milp import allocate_periods, save_period_solution
from .rules import TimetableRuleSet
from .session_milp import save_session_solution, solve_session_allocation, solve_session_allocation_with_cap_search
from .validate import assert_acceptance, compute_metrics


def run_pipeline(
    data_dir: str | Path,
    out_dir: str | Path,
    *,
    max_teacher_sessions: int = 200,
    session_time_limit_seconds: int = 60,
    period_time_limit_seconds: int = 10,
    minimize_sessions: bool = False,
    search_teacher_sessions: bool = True,
    rules: TimetableRuleSet | None = None,
    verbose: bool = True,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    data_dir = Path(data_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def emit(event: dict[str, Any]) -> None:
        if progress:
            progress(event)

    emit({"stage": "input:load", "message": "Đọc 5 file Excel và dựng dữ liệu trường"})
    data = load_school_data(data_dir)
    expected_periods = sum(item.periods_per_week for item in data.assignments)
    emit(
        {
            "stage": "input:loaded",
            "message": f"Đã đọc {len(data.classes)} lớp, {len(data.teachers)} giáo viên, {expected_periods} tiết cần xếp",
            "classes": len(data.classes),
            "teachers": len(data.teachers),
            "subjects": len(data.subjects),
            "assignments": len(data.assignments),
            "expected_periods": expected_periods,
        }
    )
    if search_teacher_sessions and not minimize_sessions:
        emit({"stage": "session:start", "message": "Bắt đầu xếp cấp buổi bằng cap search"})
        allocations, session_metrics = solve_session_allocation_with_cap_search(
            data,
            rules=rules,
            max_teacher_sessions=max_teacher_sessions,
            time_limit_seconds_per_cap=session_time_limit_seconds,
            verbose=verbose,
            progress=progress,
        )
    else:
        emit({"stage": "session:start", "message": "Bắt đầu xếp cấp buổi"})
        allocations, session_metrics = solve_session_allocation(
            data,
            rules=rules,
            max_teacher_sessions=max_teacher_sessions,
            minimize_sessions=minimize_sessions,
            time_limit_seconds=session_time_limit_seconds,
            verbose=verbose,
            progress=progress,
        )
    emit({"stage": "session:write", "message": "Ghi kết quả cấp buổi"})
    save_session_solution(out_dir / "session_solution.json", allocations, session_metrics)
    write_session_plan_csv(out_dir / "tkb_session_plan.csv", allocations)

    emit({"stage": "period:start", "message": "Bắt đầu xếp tiết cụ thể trong từng buổi"})
    lessons, period_metrics = allocate_periods(
        data,
        allocations,
        rules=rules,
        time_limit_seconds_per_session=period_time_limit_seconds,
        verbose=verbose,
        progress=progress,
    )
    emit({"stage": "period:write", "message": f"Ghi thời khóa biểu đầy đủ với {len(lessons)} tiết"})
    save_period_solution(out_dir / "period_solution.json", lessons, period_metrics)
    write_timetable_csv(out_dir / "tkb_full_timetable.csv", lessons)

    emit({"stage": "validate:start", "message": "Chạy validator hard rules và rule vận hành"})
    validation_metrics = assert_acceptance(data, lessons, rules=rules, max_teacher_sessions=max_teacher_sessions)
    emit(
        {
            "stage": "validate:done",
            "message": "Validator hoàn tất",
            "scheduled_periods": validation_metrics["scheduled_periods"],
            "expected_periods": validation_metrics["expected_periods"],
            "teacher_sessions": validation_metrics["teacher_sessions"],
            "contiguous_block_violation_count": validation_metrics["contiguous_block_violation_count"],
            "hard_ok": validation_metrics["hard_ok"],
        }
    )
    metrics = {
        "session_solver": session_metrics,
        "period_solver": period_metrics,
        "validation": validation_metrics,
    }
    emit({"stage": "output:write", "message": "Ghi metrics và hoàn tất lần chạy"})
    (out_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(json.dumps(validation_metrics, ensure_ascii=False, indent=2), flush=True)
    return metrics
