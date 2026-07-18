from __future__ import annotations

from collections import Counter, defaultdict
import json
import random
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from .models import Lesson, SchoolData
from .period_milp import (
    LessonEvent,
    _day_key,
    _event_matches_limit,
    _event_start_allowed,
    _get_path,
    _iter_limit_rules,
    _limit_for_slot,
    _session_key,
    _to_int,
    _truthy,
)
from .rules import TimetableRuleSet, resolve_rule_set
from .template import all_sessions, class_available_periods, teacher_session_capacity
from .validate import compute_metrics


ProgressFn = Callable[[dict[str, Any]], None]


class Gap0CpSatNoSolution(RuntimeError):
    def __init__(self, metrics: dict[str, Any]):
        self.metrics = metrics
        super().__init__(f"Gap0 CP-SAT did not find a solution: {metrics.get('status_name')}")


def _load_cp_model():
    try:
        from ortools.sat.python import cp_model  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised only when deps are missing.
        raise RuntimeError("OR-Tools is required for gap0 CP-SAT timetable solving.") from exc
    return cp_model


def load_period_hint(path: str | Path, data: SchoolData) -> list[Lesson]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload.get("lessons")
    if rows is None:
        raise ValueError(f"No lessons found in period hint: {path}")
    class_grade = data.class_grade
    lessons: list[Lesson] = []
    for row in rows:
        class_name = str(row.get("className") or row.get("class") or "")
        if not class_name:
            continue
        lessons.append(
            Lesson(
                class_name=class_name,
                grade=str(row.get("grade") or class_grade.get(class_name, "")),
                day=int(row["day"]),
                session=str(row["session"]),
                period=int(row["period"]),
                subject=str(row["subject"]),
                teacher=str(row["teacher"]),
                room=str(row.get("room") or ""),
            )
        )
    return lessons


def _teacher_session_count(lessons: list[Lesson]) -> int:
    return len({(lesson.teacher, lesson.day, lesson.session) for lesson in lessons})


def _load_distribution(lessons: list[Lesson]) -> dict[int, int]:
    grouped: Counter[tuple[str, int, str]] = Counter((x.teacher, x.day, x.session) for x in lessons)
    return dict(sorted(Counter(grouped.values()).items()))


def _hint_patterns(
    data: SchoolData,
    sessions: list[Any],
    hint_lessons: list[Lesson],
) -> tuple[set[tuple[int, int, int, int]], dict[tuple[str, int], tuple[int, ...]]]:
    assignment_by_key = {
        (assignment.class_name, assignment.subject, assignment.teacher): ai
        for ai, assignment in enumerate(data.assignments)
    }
    session_by_key = {(session.day, session.part): si for si, session in enumerate(sessions)}
    grouped: dict[tuple[int, int], list[int]] = defaultdict(list)
    teacher_periods: dict[tuple[str, int], list[int]] = defaultdict(list)
    for lesson in hint_lessons:
        ai = assignment_by_key.get((lesson.class_name, lesson.subject, lesson.teacher))
        si = session_by_key.get((lesson.day, lesson.session))
        if ai is None or si is None:
            continue
        grouped[(ai, si)].append(int(lesson.period))
        teacher_periods[(lesson.teacher, si)].append(int(lesson.period))

    patterns: set[tuple[int, int, int, int]] = set()
    for (ai, si), periods in grouped.items():
        ordered = sorted(periods)
        if ordered and ordered == list(range(ordered[0], ordered[-1] + 1)):
            patterns.add((ai, si, ordered[0], len(ordered)))
    teacher_patterns = {key: tuple(sorted(periods)) for key, periods in teacher_periods.items()}
    return patterns, teacher_patterns


def _gap_total(metrics: Mapping[str, Any]) -> int:
    return sum(int(gap) * int(count) for gap, count in (metrics.get("gap_distribution") or {}).items())


def solve_gap0_cp_sat(
    data: SchoolData,
    *,
    rules: TimetableRuleSet | None = None,
    max_teacher_sessions: int | None = None,
    time_limit_seconds: int = 120,
    num_workers: int = 8,
    hint_lessons: list[Lesson] | None = None,
    fixed_lessons: list[Lesson] | None = None,
    prefer_hint: bool = True,
    random_seed: int | None = None,
    progress: ProgressFn | None = None,
) -> tuple[list[Lesson], dict[str, Any]]:
    """Solve concrete periods with hard teacher no-gap and no one-period sessions."""

    cp_model = _load_cp_model()
    rule_set = resolve_rule_set(rules)
    constraints = rule_set.constraints
    sessions = all_sessions()
    class_grade = data.class_grade
    use_solver_hints = constraints is None

    model = cp_model.CpModel()
    pattern_vars: dict[tuple[int, int, int, int], Any] = {}
    by_assignment: dict[int, list[tuple[Any, int]]] = defaultdict(list)
    by_assignment_session: dict[tuple[int, int], list[Any]] = defaultdict(list)
    by_class_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    by_teacher_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    by_room_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    lesson_block_constraints = 0

    hinted_patterns, hinted_teacher_patterns = _hint_patterns(data, sessions, hint_lessons or [])
    hinted_pattern_vars = []
    hinted_teacher_vars = []
    other_pattern_vars = []
    other_teacher_vars = []

    for ai, assignment in enumerate(data.assignments):
        event = LessonEvent(
            class_name=assignment.class_name,
            teacher=assignment.teacher,
            subject=assignment.subject,
            duration=1,
            room=assignment.room,
        )
        for si, session in enumerate(sessions):
            allowed = class_available_periods(assignment.grade, assignment.class_name, session, constraints)
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
                    block_event = LessonEvent(
                        class_name=event.class_name,
                        teacher=event.teacher,
                        subject=event.subject,
                        duration=length,
                        room=event.room,
                    )
                    if not _event_start_allowed(block_event, session, start, rule_set):
                        continue
                    key = (ai, si, start, length)
                    var = model.NewBoolVar(f"p_{ai}_{si}_{start}_{length}")
                    pattern_vars[key] = var
                    session_patterns.append(var)
                    by_assignment[ai].append((var, length))
                    by_assignment_session[(ai, si)].append(var)
                    if key in hinted_patterns:
                        hinted_pattern_vars.append(var)
                        if use_solver_hints:
                            model.AddHint(var, 1)
                    else:
                        other_pattern_vars.append(var)
                        if use_solver_hints:
                            model.AddHint(var, 0)
                    for period in block:
                        by_class_slot[(assignment.class_name, si, period)].append(var)
                        by_teacher_slot[(assignment.teacher, si, period)].append(var)
                        if assignment.room:
                            by_room_slot[(assignment.room, si, period)].append(var)
            if session_patterns:
                model.Add(sum(session_patterns) <= 1)

    for ai, assignment in enumerate(data.assignments):
        model.Add(sum(var * length for var, length in by_assignment[ai]) == assignment.periods_per_week)

    fixed_lessons = fixed_lessons or []
    fixed_terms = 0
    fixed_teacher_session_periods: dict[tuple[str, int], set[int]] = {}
    if fixed_lessons:
        assignment_by_key = {
            (assignment.class_name, assignment.subject, assignment.teacher): ai
            for ai, assignment in enumerate(data.assignments)
        }
        session_by_key = {(session.day, session.part): si for si, session in enumerate(sessions)}
        for lesson in fixed_lessons:
            ai = assignment_by_key.get((lesson.class_name, lesson.subject, lesson.teacher))
            si = session_by_key.get((lesson.day, lesson.session))
            if ai is None or si is None:
                raise Gap0CpSatNoSolution(
                    {
                        "solver": "ortools_cp_sat_gap0_period",
                        "status_name": "INVALID_FIXED_LESSON",
                        "message": (
                            f"Cannot map fixed lesson {lesson.class_name} "
                            f"{lesson.subject} {lesson.teacher}."
                        ),
                    }
                )
            matches = [
                var
                for (var_ai, var_si, start, length), var in pattern_vars.items()
                if var_ai == ai and var_si == si and start <= int(lesson.period) < start + length
            ]
            if not matches:
                raise Gap0CpSatNoSolution(
                    {
                        "solver": "ortools_cp_sat_gap0_period",
                        "status_name": "INVALID_FIXED_SLOT",
                        "message": (
                            f"No feasible pattern covers fixed lesson {lesson.class_name} "
                            f"{lesson.subject} Thu {lesson.day} {lesson.session} tiet {lesson.period}."
                        ),
                    }
                )
            model.Add(sum(matches) == 1)
            fixed_terms += len(matches)
            fixed_teacher_session_periods.setdefault((lesson.teacher, si), set()).add(int(lesson.period))

    for class_info in data.classes:
        for si, session in enumerate(sessions):
            for period in class_available_periods(class_info.grade, class_info.name, session, constraints):
                model.Add(sum(by_class_slot[(class_info.name, si, period)]) <= 1)

    y_vars: dict[tuple[str, int, tuple[int, ...]], Any] = {}
    z_vars: dict[tuple[str, int], Any] = {}
    for teacher in data.teachers:
        for si, session in enumerate(sessions):
            cap = teacher_session_capacity(session)
            patterns = [()]
            for length in range(2, cap + 1):
                for start in range(1, cap - length + 2):
                    patterns.append(tuple(range(start, start + length)))
            y_list = []
            for pattern in patterns:
                y = model.NewBoolVar(f"y_{teacher}_{si}_{'_'.join(map(str, pattern)) or 'empty'}")
                y_vars[(teacher, si, pattern)] = y
                y_list.append(y)
                if hinted_teacher_patterns.get((teacher, si), ()) == pattern:
                    hinted_teacher_vars.append(y)
                    if use_solver_hints:
                        model.AddHint(y, 1)
                else:
                    other_teacher_vars.append(y)
                    if use_solver_hints:
                        model.AddHint(y, 0)
            model.Add(sum(y_list) == 1)
            z = model.NewBoolVar(f"z_{teacher}_{si}")
            z_vars[(teacher, si)] = z
            model.Add(z == sum(y_vars[(teacher, si, pattern)] for pattern in patterns if pattern))
            if use_solver_hints:
                model.AddHint(z, 1 if hinted_teacher_patterns.get((teacher, si), ()) else 0)
            for period in range(1, cap + 1):
                model.Add(
                    sum(by_teacher_slot.get((teacher, si, period), []))
                    == sum(y_vars[(teacher, si, pattern)] for pattern in patterns if period in pattern)
                )
            if constraints is not None:
                for period in constraints.teacher_must_teach_periods(teacher, session.day, session.part):
                    if int(period) in fixed_teacher_session_periods.get((teacher, si), set()):
                        continue
                    model.Add(sum(by_teacher_slot.get((teacher, si, period), [])) == 1)

    for terms in by_room_slot.values():
        if terms:
            model.Add(sum(terms) <= 1)

    if constraints is not None:
        processed_subject_blocks: set[tuple[str, str]] = set()
        for ai, assignment in enumerate(data.assignments):
            rule_obj = constraints.subject_rule_for(assignment.class_name, assignment.subject)
            if not isinstance(rule_obj, Mapping) or not rule_obj:
                continue
            rule_key = (assignment.class_name, assignment.subject)
            if rule_key in processed_subject_blocks:
                continue
            processed_subject_blocks.add(rule_key)
            lesson_blocks = rule_obj.get("lessonBlocks") if isinstance(rule_obj.get("lessonBlocks"), Mapping) else {}
            if not lesson_blocks:
                continue
            subject_pattern_terms: dict[int, list[Any]] = {length: [] for length in (2, 3, 4, 5)}
            for (bi, _si, _start, duration), var in pattern_vars.items():
                candidate = data.assignments[bi]
                if candidate.class_name != assignment.class_name or candidate.subject != assignment.subject:
                    continue
                for length in (2, 3, 4, 5):
                    if duration >= length:
                        subject_pattern_terms[length].append(var)
            for length, terms in subject_pattern_terms.items():
                conf = lesson_blocks.get(str(length)) or lesson_blocks.get(length)
                if not isinstance(conf, Mapping):
                    continue
                minimum = _to_int(conf.get("min"), 0)
                maximum = _to_int(conf.get("max"), 0)
                if minimum > 0:
                    if terms:
                        model.Add(sum(terms) >= minimum)
                    else:
                        model.AddBoolOr([])
                    lesson_block_constraints += 1
                if maximum > 0:
                    model.Add(sum(terms) <= maximum)
                    lesson_block_constraints += 1

        for class_name, groups in (constraints.subject_no_same_session or {}).items():
            if not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                if len(subjects) < 2:
                    continue
                subject_set = set(subjects)
                for si, _session in enumerate(sessions):
                    terms = [
                        var
                        for (bi, pattern_si, _start, _duration), var in pattern_vars.items()
                        if pattern_si == si
                        and data.assignments[bi].class_name == class_name
                        and data.assignments[bi].subject in subject_set
                    ]
                    if len(terms) > 1:
                        model.Add(sum(terms) <= 1)
        for class_name, groups in (constraints.subject_no_same_day or {}).items():
            if not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                if len(subjects) < 2:
                    continue
                subject_set = set(subjects)
                for day in sorted({s.day for s in sessions}):
                    active_subjects = []
                    for subject in sorted(subject_set):
                        terms = [
                            var
                            for (bi, pattern_si, _start, _duration), var in pattern_vars.items()
                            if sessions[pattern_si].day == day
                            and data.assignments[bi].class_name == class_name
                            and data.assignments[bi].subject == subject
                        ]
                        if not terms:
                            continue
                        active = model.NewBoolVar(f"subject_no_same_day_{class_name}_{group_id}_{subject}_{day}")
                        for term in terms:
                            model.Add(term <= active)
                        model.Add(active <= sum(terms))
                        active_subjects.append(active)
                    if len(active_subjects) > 1:
                        model.Add(sum(active_subjects) <= 1)

        for teacher, rule in constraints.teacher.items():
            if not isinstance(rule, Mapping):
                continue
            teacher_sessions = [
                si
                for si, _session in enumerate(sessions)
                if (teacher, si) in z_vars
            ]
            if not teacher_sessions:
                continue

            max_days = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
            if max_days > 0:
                day_vars = []
                for day in sorted({session.day for session in sessions}):
                    session_indexes = [si for si, session in enumerate(sessions) if session.day == day]
                    d_var = model.NewBoolVar(f"teacher_day_{teacher}_{day}")
                    for si in session_indexes:
                        model.Add(z_vars[(teacher, si)] <= d_var)
                    model.Add(d_var <= sum(z_vars[(teacher, si)] for si in session_indexes))
                    day_vars.append(d_var)
                model.Add(sum(day_vars) <= max_days)

            max_sessions = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
            if max_sessions > 0:
                model.Add(sum(z_vars[(teacher, si)] for si in teacher_sessions) <= max_sessions)

            max_morning = _to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0)
            if max_morning > 0:
                model.Add(
                    sum(z_vars[(teacher, si)] for si, session in enumerate(sessions) if session.part == "AM")
                    <= max_morning
                )

            max_afternoon = _to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0)
            if max_afternoon > 0:
                model.Add(
                    sum(z_vars[(teacher, si)] for si, session in enumerate(sessions) if session.part == "PM")
                    <= max_afternoon
                )

            for day in sorted({session.day for session in sessions}):
                dk = _day_key(day)
                session_indexes = [si for si, session in enumerate(sessions) if session.day == day]
                if _truthy(_get_path(rule, f"oneSessionPerDay.{dk}", False)):
                    model.Add(sum(z_vars[(teacher, si)] for si in session_indexes) <= 1)

                day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{dk}", 0), 0)
                if day_limit > 0:
                    terms = [
                        var
                        for si in session_indexes
                        for period in range(1, teacher_session_capacity(sessions[si]) + 1)
                        for var in by_teacher_slot.get((teacher, si, period), [])
                    ]
                    if terms:
                        model.Add(sum(terms) <= day_limit)

            for si, session in enumerate(sessions):
                limit = _to_int(_get_path(rule, f"maxPeriods.{_session_key(session)}.{_day_key(session.day)}", 0), 0)
                if limit <= 0:
                    continue
                terms = [
                    var
                    for period in range(1, teacher_session_capacity(session) + 1)
                    for var in by_teacher_slot.get((teacher, si, period), [])
                ]
                if terms:
                    model.Add(sum(terms) <= limit)

        for limit_rule in _iter_limit_rules(rule_set):
            limits = [
                _limit_for_slot(limit_rule, "classes", session),
                _limit_for_slot(limit_rule, "teachers", session),
                _limit_for_slot(limit_rule, "rooms", session),
                _limit_for_slot(limit_rule, "subjects", session),
            ]
            active_limits = [limit for limit in limits if limit > 0]
            if not active_limits:
                continue
            for si, session in enumerate(sessions):
                for period in range(1, teacher_session_capacity(session) + 1):
                    coeff = []
                    for (ai, sj, start, length), var in pattern_vars.items():
                        if sj != si or not (start <= period < start + length):
                            continue
                        if _event_matches_limit(
                            LessonEvent(
                                class_name=data.assignments[ai].class_name,
                                teacher=data.assignments[ai].teacher,
                                subject=data.assignments[ai].subject,
                                duration=length,
                                room=data.assignments[ai].room,
                            ),
                            limit_rule,
                            rule_set,
                        ):
                            coeff.append(var)
                    if coeff:
                        for limit in active_limits:
                            model.Add(sum(coeff) <= limit)

    teacher_session_sum = sum(z_vars.values())
    if max_teacher_sessions is not None:
        model.Add(teacher_session_sum <= int(max_teacher_sessions))

    hint_vars = [*hinted_pattern_vars, *hinted_teacher_vars]
    random_terms = []
    random_coefficient_sum = 0
    if random_seed is not None:
        rng = random.Random(int(random_seed))
        random_coefficients = [rng.randint(0, 99) for _key in sorted(pattern_vars)]
        random_coefficient_sum = sum(random_coefficients)
        random_terms = [
            coefficient * var
            for coefficient, (_key, var) in zip(
                random_coefficients,
                sorted(pattern_vars.items()),
                strict=True,
            )
        ]
    if hint_vars and prefer_hint:
        hint_scale = random_coefficient_sum + 1
        teacher_session_scale = len(hint_vars) * hint_scale + random_coefficient_sum + 1
        model.Minimize(
            teacher_session_sum * teacher_session_scale
            - sum(hint_vars) * hint_scale
            + sum(random_terms)
        )
        objective_mode = "minimize_teacher_sessions_then_hint_similarity"
    elif random_terms:
        teacher_session_scale = random_coefficient_sum + 1
        model.Minimize(teacher_session_sum * teacher_session_scale + sum(random_terms))
        objective_mode = "minimize_teacher_sessions_random_tiebreak"
    else:
        hint_scale = 0
        teacher_session_scale = 1
        model.Minimize(teacher_session_sum)
        objective_mode = "minimize_teacher_sessions"

    if progress:
        progress(
            {
                "stage": "gap0_cp_sat:model",
                "message": "Dựng mô hình CP-SAT gap0",
                "pattern_vars": len(pattern_vars),
                "teacher_pattern_vars": len(y_vars),
                "max_teacher_sessions": max_teacher_sessions,
                "fixed_lessons": len(fixed_lessons),
                "lesson_block_constraints": lesson_block_constraints,
            }
        )

    solver = cp_model.CpSolver()
    effective_num_workers = 1 if use_solver_hints else int(num_workers)
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = effective_num_workers
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = 2
    # Keep hints as model hints/objective preferences only. OR-Tools' repair_hint
    # mode has shown native fixed-search assertion failures on this model.
    solver.parameters.repair_hint = False
    if random_seed is not None:
        solver.parameters.random_seed = int(random_seed)
        solver.parameters.randomize_search = True

    started = time.time()
    status = solver.Solve(model)
    elapsed = time.time() - started
    status_name = solver.StatusName(status)
    metrics: dict[str, Any] = {
        "solver": "ortools_cp_sat_gap0_period",
        "status": int(status),
        "status_name": status_name,
        "runtime_seconds": elapsed,
        "wall_time_seconds": float(solver.WallTime()),
        "branches": int(solver.NumBranches()),
        "conflicts": int(solver.NumConflicts()),
        "booleans": int(solver.NumBooleans()),
        "pattern_vars": len(pattern_vars),
        "teacher_pattern_vars": len(y_vars),
        "max_teacher_sessions": max_teacher_sessions,
        "hinted_pattern_vars": len(hinted_pattern_vars),
        "hinted_teacher_vars": len(hinted_teacher_vars),
        "fixed_lessons": len(fixed_lessons),
        "fixed_lesson_terms": fixed_terms,
        "lesson_block_constraints": lesson_block_constraints,
        "prefer_hint": bool(prefer_hint),
        "objective_mode": objective_mode,
        "teacher_session_objective_scale": teacher_session_scale,
        "hint_objective_scale": hint_scale if hint_vars and prefer_hint else 0,
        "random_objective_upper_bound": random_coefficient_sum,
        "random_seed": random_seed,
        "num_workers": effective_num_workers,
        "requested_num_workers": int(num_workers),
    }
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) and hint_vars:
        metrics["objective"] = float(solver.ObjectiveValue())
        metrics["best_bound"] = float(solver.BestObjectiveBound())
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise Gap0CpSatNoSolution(metrics)

    lessons: list[Lesson] = []
    for (ai, si, start, length), var in pattern_vars.items():
        if solver.Value(var) <= 0:
            continue
        assignment = data.assignments[ai]
        session = sessions[si]
        for period in range(start, start + length):
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

    final_metrics = compute_metrics(data, lessons, rules=rule_set)
    metrics.update(
        {
            "teacher_sessions": final_metrics.get("teacher_sessions"),
            "load_distribution": _load_distribution(lessons),
            "one_period_teacher_sessions": final_metrics.get("one_period_teacher_sessions"),
            "gap_distribution": final_metrics.get("gap_distribution"),
            "gap_total": _gap_total(final_metrics),
            "hard_ok": final_metrics.get("hard_ok"),
            "app_constraint_violation_count": final_metrics.get("app_constraint_violation_count"),
        }
    )
    if progress:
        progress(
            {
                "stage": "gap0_cp_sat:done",
                "message": f"Hoàn tất gap0 CP-SAT: {metrics['teacher_sessions']} buổi giáo viên",
                "runtime_seconds": elapsed,
                "teacher_sessions": metrics["teacher_sessions"],
            }
        )
    return lessons, metrics
