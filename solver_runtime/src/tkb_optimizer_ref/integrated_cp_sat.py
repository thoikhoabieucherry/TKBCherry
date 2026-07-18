from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

from .models import Lesson, SchoolData
from .rules import TimetableRuleSet, resolve_rule_set
from .template import all_sessions, class_allowed_periods, teacher_session_capacity


ProgressFn = Callable[[dict[str, Any]], None]


def _load_cp_model():
    try:
        from ortools.sat.python import cp_model  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised only when deps are missing.
        raise RuntimeError(
            "OR-Tools is required for integrated CP-SAT timetable solving. "
            "Install requirements.txt before running solver_mode=integrated."
        ) from exc
    return cp_model


def _constraints_active(rules: TimetableRuleSet) -> bool:
    return rules.constraints is not None and rules.constraints.active


def _base_hint_path() -> Path:
    return Path(__file__).with_name("base_184_hint.json")


def _legacy_solver_hints_enabled() -> bool:
    # Keep the integrated reference solver independent from bundled sample
    # schedules. Future constraints must be solved from the live data only.
    return False


def solve_integrated_timetable(
    data: SchoolData,
    *,
    rules: TimetableRuleSet | None = None,
    max_teacher_sessions: int = 180,
    exact_teacher_sessions: bool = False,
    time_limit_seconds: int = 900,
    num_workers: int = 8,
    allow_legacy_solver_hints: bool = False,
    progress: ProgressFn | None = None,
) -> tuple[list[Lesson], dict[str, Any]]:
    """Solve concrete periods directly with CP-SAT.

    The older two-stage solver first picks half-day counts and then places
    periods. That can reject a cap after the session model has already accepted
    an allocation. This integrated model chooses contiguous concrete period
    blocks directly, so the teacher-session cap is validated against a complete
    timetable.
    """

    rule_set = resolve_rule_set(rules)
    if _constraints_active(rule_set):
        raise NotImplementedError("Integrated CP-SAT mode currently supports the base Excel rules only.")

    cp_model = _load_cp_model()
    sessions = all_sessions()
    model = cp_model.CpModel()

    pattern_vars: dict[tuple[int, int, int, int], Any] = {}
    patterns_by_assignment: dict[int, list[tuple[Any, int]]] = defaultdict(list)
    patterns_by_class_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    patterns_by_teacher_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    patterns_by_teacher_session: dict[tuple[str, int], list[tuple[Any, int]]] = defaultdict(list)

    for ai, assignment in enumerate(data.assignments):
        for si, session in enumerate(sessions):
            allowed = class_allowed_periods(assignment.grade, session)
            if not allowed:
                continue
            allowed_set = set(allowed)
            max_len = min(
                assignment.max_periods_per_session,
                assignment.periods_per_week,
                teacher_session_capacity(session),
                len(allowed),
            )
            session_patterns = []
            for length in range(1, max_len + 1):
                for start in allowed:
                    block = tuple(range(start, start + length))
                    if not all(period in allowed_set for period in block):
                        continue
                    var = model.NewBoolVar(f"p_{ai}_{si}_{start}_{length}")
                    pattern_vars[(ai, si, start, length)] = var
                    session_patterns.append(var)
                    patterns_by_assignment[ai].append((var, length))
                    for period in block:
                        patterns_by_class_slot[(assignment.class_name, si, period)].append(var)
                        patterns_by_teacher_slot[(assignment.teacher, si, period)].append(var)
                    patterns_by_teacher_session[(assignment.teacher, si)].append((var, length))
            if session_patterns:
                model.Add(sum(session_patterns) <= 1)

    if progress:
        progress(
            {
                "stage": "integrated:model",
                "message": "Dựng mô hình CP-SAT tích hợp buổi + tiết",
                "pattern_vars": len(pattern_vars),
                "max_teacher_sessions": max_teacher_sessions,
                "time_limit_seconds": time_limit_seconds,
            }
        )

    for ai, assignment in enumerate(data.assignments):
        model.Add(sum(var * length for var, length in patterns_by_assignment[ai]) == assignment.periods_per_week)

    for class_info in data.classes:
        for si, session in enumerate(sessions):
            for period in class_allowed_periods(class_info.grade, session):
                model.Add(sum(patterns_by_class_slot[(class_info.name, si, period)]) == 1)

    for teacher in data.teachers:
        for si, session in enumerate(sessions):
            for period in range(1, teacher_session_capacity(session) + 1):
                terms = patterns_by_teacher_slot.get((teacher, si, period), [])
                if terms:
                    model.Add(sum(terms) <= 1)

    z_vars: dict[tuple[str, int], Any] = {}
    for teacher in data.teachers:
        for si, session in enumerate(sessions):
            z_var = model.NewBoolVar(f"z_{teacher}_{si}")
            z_vars[(teacher, si)] = z_var
            terms = patterns_by_teacher_session.get((teacher, si), [])
            if terms:
                load = sum(var * length for var, length in terms)
                model.Add(load <= teacher_session_capacity(session) * z_var)
                model.Add(load >= z_var)
            else:
                model.Add(z_var == 0)

    teacher_session_sum = sum(z_vars.values())
    if exact_teacher_sessions:
        model.Add(teacher_session_sum == max_teacher_sessions)
    else:
        model.Add(teacher_session_sum <= max_teacher_sessions)

    requested_num_workers = max(1, int(num_workers))
    effective_num_workers = requested_num_workers
    hint_metrics: dict[str, Any] = {"used": False, "fixed": False}
    if (
        allow_legacy_solver_hints
        and _legacy_solver_hints_enabled()
        and max_teacher_sessions == 184
        and exact_teacher_sessions
        and _base_hint_path().exists()
    ):
        hint_payload = json.loads(_base_hint_path().read_text(encoding="utf-8"))
        session_by_key = {(session.day, session.part): si for si, session in enumerate(sessions)}
        assignment_by_key = {
            (assignment.class_name, assignment.subject, assignment.teacher): ai
            for ai, assignment in enumerate(data.assignments)
        }
        hint_groups: dict[tuple[int, int], list[int]] = defaultdict(list)
        unmapped = 0
        for row in hint_payload.get("lessons", []):
            if not isinstance(row, list) or len(row) < 6:
                unmapped += 1
                continue
            class_name, day, part, period, subject, teacher = row[:6]
            ai = assignment_by_key.get((str(class_name), str(subject), str(teacher)))
            si = session_by_key.get((int(day), str(part)))
            if ai is None or si is None:
                unmapped += 1
                continue
            hint_groups[(ai, si)].append(int(period))

        hinted_patterns: set[tuple[int, int, int, int]] = set()
        hinted_periods = 0
        for (ai, si), periods in hint_groups.items():
            ordered = sorted(periods)
            if not ordered or ordered != list(range(ordered[0], ordered[-1] + 1)):
                unmapped += len(ordered)
                continue
            key = (ai, si, ordered[0], len(ordered))
            if key not in pattern_vars:
                unmapped += len(ordered)
                continue
            hinted_patterns.add(key)
            hinted_periods += len(ordered)

        expected_periods = sum(item.periods_per_week for item in data.assignments)
        hint_complete = hinted_periods == expected_periods and unmapped == 0
        hinted_teacher_sessions = {
            (data.assignments[ai].teacher, si)
            for ai, si, _start, _length in hinted_patterns
        }
        for key, var in pattern_vars.items():
            hinted_value = 1 if key in hinted_patterns else 0
            model.AddHint(var, hinted_value)
            if hint_complete:
                model.Add(var == hinted_value)
        for key, var in z_vars.items():
            hinted_value = 1 if key in hinted_teacher_sessions else 0
            model.AddHint(var, hinted_value)
            if hint_complete:
                model.Add(var == hinted_value)
        if hint_complete:
            effective_num_workers = 1
        hint_metrics = {
            "used": True,
            "fixed": bool(hint_complete),
            "fixed_by_model_constraints": bool(hint_complete),
            "hinted_patterns": len(hinted_patterns),
            "hinted_periods": hinted_periods,
            "unmapped_entries": unmapped,
        }

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = effective_num_workers
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = 2
    solver.parameters.repair_hint = False

    if progress:
        progress(
            {
                "stage": "integrated:solve",
                "message": f"Giải CP-SAT tích hợp với cap {max_teacher_sessions}",
                "max_teacher_sessions": max_teacher_sessions,
                "time_limit_seconds": time_limit_seconds,
            }
        )

    start = time.time()
    status = solver.Solve(model)
    runtime = time.time() - start
    status_name = solver.StatusName(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError(
            "Integrated CP-SAT did not find a complete timetable: "
            f"status={status_name}, cap={max_teacher_sessions}, runtime={runtime:.2f}s"
        )

    lessons: list[Lesson] = []
    teacher_session_load: dict[tuple[str, int], int] = defaultdict(int)
    for (ai, si, start_period, length), var in pattern_vars.items():
        if solver.Value(var) <= 0:
            continue
        assignment = data.assignments[ai]
        session = sessions[si]
        teacher_session_load[(assignment.teacher, si)] += length
        for period in range(start_period, start_period + length):
            lessons.append(
                Lesson(
                    class_name=assignment.class_name,
                    grade=assignment.grade,
                    day=session.day,
                    session=session.part,
                    period=period,
                    subject=assignment.subject,
                    teacher=assignment.teacher,
                    room=assignment.room,
                )
            )

    load_distribution: dict[int, int] = {}
    for load in teacher_session_load.values():
        load_distribution[load] = load_distribution.get(load, 0) + 1

    metrics: dict[str, Any] = {
        "solver": "ortools_cp_sat_integrated",
        "status": int(status),
        "status_name": status_name,
        "runtime_seconds": runtime,
        "wall_time_seconds": float(solver.WallTime()),
        "branches": int(solver.NumBranches()),
        "conflicts": int(solver.NumConflicts()),
        "booleans": int(solver.NumBooleans()),
        "pattern_vars": len(pattern_vars),
        "teacher_session_vars": len(z_vars),
        "hint": hint_metrics,
        "max_teacher_sessions": max_teacher_sessions,
        "exact_teacher_sessions": exact_teacher_sessions,
        "num_workers": effective_num_workers,
        "requested_num_workers": requested_num_workers,
        "teacher_sessions": len(teacher_session_load),
        "load_distribution": dict(sorted(load_distribution.items())),
    }
    if progress:
        progress(
            {
                "stage": "integrated:done",
                "message": f"Hoàn tất CP-SAT: {len(teacher_session_load)} buổi giáo viên",
                "runtime_seconds": runtime,
                "teacher_sessions": len(teacher_session_load),
                "load_distribution": metrics["load_distribution"],
            }
        )
    return lessons, metrics
