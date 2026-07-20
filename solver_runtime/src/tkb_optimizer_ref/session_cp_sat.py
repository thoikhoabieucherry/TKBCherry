from __future__ import annotations

import time
from typing import Any, Callable, Mapping

from collections import Counter

from .models import Lesson, SchoolData, SessionAllocation
from .random_seed import normalize_cp_sat_seed
from .rules import TimetableRuleSet, resolve_rule_set
from .session_milp import (
    _assignment_block_allowed,
    _assignment_available_periods,
    _assignment_session_allowed,
    _assignment_session_cap,
    _day_key,
    _get_path,
    _session_key,
    _subject_like_block_allowed,
    _teacher_session_period_capacity,
    _truthy,
)
from .template import LOWER_GRADES, all_sessions, class_available_periods, class_session_capacity_for_constraints, teacher_session_capacity

ProgressFn = Callable[[dict[str, Any]], None]


class SessionCpSatNoSolution(RuntimeError):
    def __init__(self, message: str, metrics: dict[str, Any]):
        super().__init__(message)
        self.metrics = metrics


def _load_cp_model():
    try:
        from ortools.sat.python import cp_model  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised only when deps are missing.
        raise RuntimeError(
            "OR-Tools is required for CP-SAT session solving. "
            "Install requirements.txt before running solver_mode=auto."
        ) from exc
    return cp_model


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def _count_contiguous_blocks(periods: set[int] | list[int] | tuple[int, ...], length: int) -> int:
    ordered = sorted({int(period) for period in periods})
    period_set = set(ordered)
    return sum(
        1
        for period in ordered
        if period - 1 not in period_set
        and all(period + offset in period_set for offset in range(max(1, int(length))))
    )


def _day_limit_from_rule(rule: Mapping[str, Any], path: str, day: int) -> int:
    raw = _get_path(rule, path, 0)
    if isinstance(raw, Mapping):
        return _to_int(raw.get(_day_key(day)), 0)
    return _to_int(raw, 0)


def _limit_for_slot(rule: Mapping[str, Any], field: str, session: Any) -> int:
    by_session = rule.get("perSlotBySession", {}) if isinstance(rule.get("perSlotBySession"), Mapping) else {}
    session_key = _session_key(session)
    day_key = _day_key(session.day)
    value: Any = None
    field_map = by_session.get(field) if isinstance(by_session, Mapping) else None
    if isinstance(field_map, Mapping):
        value = _get_path(field_map, f"{session_key}.{day_key}", None)
    if value is None and isinstance(by_session, Mapping):
        value = _get_path(by_session, f"{session_key}.{day_key}", None)
    limit = _to_int(value, 0)
    if limit > 0:
        return limit
    per_slot = rule.get("perSlot", {}) if isinstance(rule.get("perSlot"), Mapping) else {}
    return _to_int(per_slot.get(field), 0)


def _iter_limit_rules(constraints: Any | None) -> list[Mapping[str, Any]]:
    if constraints is None:
        return []
    out: list[Mapping[str, Any]] = [rule for rule in constraints.time_limit if isinstance(rule, Mapping)]
    for subject, root in constraints.subject.items():
        if not isinstance(root, Mapping):
            continue
        for base in ("globalLimit", "groupLimit"):
            conf = root.get(base)
            if isinstance(conf, Mapping) and conf:
                item = dict(conf)
                item.setdefault("name", f"{subject} {base}")
                item["targetType"] = "subject"
                item["targetId"] = subject
                out.append(item)
    for group_id, root in constraints.subject_group.items():
        if not isinstance(root, Mapping):
            continue
        for base in ("globalLimit", "groupLimit"):
            conf = root.get(base)
            if isinstance(conf, Mapping) and conf:
                item = dict(conf)
                item.setdefault("name", f"{constraints.group_name('subject', group_id)} {base}")
                item["targetType"] = "subjectGroup"
                item["targetId"] = group_id
                out.append(item)
    return out


def _assignment_matches_limit(assignment: Any, rule: Mapping[str, Any], constraints: Any | None) -> bool:
    if constraints is None:
        return False
    target_type = str(rule.get("targetType") or "")
    target_id = str(rule.get("targetId") or "")
    if target_type == "subject":
        return assignment.subject == target_id
    if target_type == "subjectGroup":
        return constraints.subject_in_group(assignment.subject, target_id)
    if target_type == "teacherGroup":
        return assignment.teacher in constraints.group_items("teacher", target_id)
    if target_type == "classGroup":
        return assignment.class_name in constraints.group_items("class", target_id)
    if target_type == "roomGroup":
        return bool(assignment.room) and assignment.room in constraints.group_items("room", target_id)
    return False


def solve_session_allocation_cp_sat(
    data: SchoolData,
    *,
    rules: TimetableRuleSet | None = None,
    max_teacher_sessions: int | None = 180,
    min_teacher_sessions: int | None = None,
    max_one_period_sessions: int | None = None,
    allow_unassigned: bool = False,
    minimize_sessions: bool = True,
    minimize_one_period_sessions: bool = True,
    one_period_priority_absolute: bool = True,
    time_limit_seconds: int = 60,
    early_stop_teacher_sessions: int | None = None,
    early_stop_max_one_period_sessions: int | None = None,
    linearization_level: int = 1,
    num_workers: int = 8,
    random_seed: int | None = None,
    hint_allocations: list[SessionAllocation] | None = None,
    hint_lessons: list[Lesson] | None = None,
    fixed_lessons: list[Lesson] | None = None,
    fix_hint: bool = False,
    repair_hint: bool = False,
    forbidden_session_vectors: list[tuple[int, dict[int, int]]] | None = None,
    period_feasibility_session_indexes: set[int] | None = None,
    period_max_teacher_gap: int | None = None,
    materialize_period_lessons: bool = False,
    legacy_wednesday_pm_bridge: bool = False,
    minimize_hint_distance: bool = False,
    progress: ProgressFn | None = None,
) -> tuple[list[SessionAllocation], dict[str, Any]]:
    """Solve the half-day compaction model with OR-Tools CP-SAT.

    This mirrors the base session MILP constraints but gives much better primal
    discovery on the bundled workbook. Concrete periods are still placed by
    ``allocate_periods`` and validated afterward.
    """
    random_seed = normalize_cp_sat_seed(random_seed)

    rule_set = resolve_rule_set(rules)
    constraints = rule_set.constraints
    cp_model = _load_cp_model()
    sessions = all_sessions()
    session_by_key = {(session.day, session.part): si for si, session in enumerate(sessions)}
    fixed_lessons = fixed_lessons or []
    hint_lessons = hint_lessons or []
    fixed_teacher_session_load: Counter[tuple[str, int]] = Counter()
    fixed_teacher_day_load: Counter[tuple[str, int]] = Counter()
    fixed_class_session_load: Counter[tuple[str, int]] = Counter()
    fixed_assignment_session_load: Counter[tuple[str, str, str, int]] = Counter()
    fixed_assignment_session_periods: dict[
        tuple[str, str, str, int], set[int]
    ] = {}
    fixed_teacher_class_session_load: Counter[tuple[str, str, int]] = Counter()
    fixed_teacher_class_day_load: Counter[tuple[str, str, int]] = Counter()
    fixed_teacher_session_periods: dict[tuple[str, int], set[int]] = {}
    for lesson in fixed_lessons:
        si = session_by_key.get((int(lesson.day), str(lesson.session)))
        if si is None:
            continue
        fixed_teacher_session_load[(lesson.teacher, si)] += 1
        fixed_teacher_day_load[(lesson.teacher, int(lesson.day))] += 1
        fixed_class_session_load[(lesson.class_name, si)] += 1
        fixed_assignment_session_load[(lesson.class_name, lesson.subject, lesson.teacher, si)] += 1
        fixed_assignment_session_periods.setdefault(
            (lesson.class_name, lesson.subject, lesson.teacher, si), set()
        ).add(int(lesson.period))
        fixed_teacher_class_session_load[(lesson.teacher, lesson.class_name, si)] += 1
        fixed_teacher_class_day_load[(lesson.teacher, lesson.class_name, int(lesson.day))] += 1
        fixed_teacher_session_periods.setdefault((lesson.teacher, si), set()).add(int(lesson.period))
    model = cp_model.CpModel()
    requested_num_workers = max(1, int(num_workers))
    effective_num_workers = requested_num_workers
    if hint_allocations and fix_hint:
        # Keep fixed hints deterministic; repaired hints are left as soft hints
        # because OR-Tools can hit native fixed-search assertions with repair_hint.
        effective_num_workers = 1

    n_vars: dict[tuple[int, int], Any] = {}
    n_caps: dict[tuple[int, int], int] = {}
    for ai, assignment in enumerate(data.assignments):
        for si, session in enumerate(sessions):
            class_cap = class_session_capacity_for_constraints(
                assignment.grade,
                assignment.class_name,
                session,
                constraints,
            )
            if class_cap <= 0:
                continue
            if not _assignment_session_allowed(assignment, session, constraints):
                continue
            fixed_assignment_load = int(
                fixed_assignment_session_load.get(
                    (assignment.class_name, assignment.subject, assignment.teacher, si),
                    0,
                )
            )
            # Weekly demand has already had fixed lessons removed by the
            # adapter.  Only the original per-session ceiling needs its fixed
            # load removed here; subtracting from the minimum also subtracts
            # the same lesson from residual weekly demand a second time.
            base_cap = min(
                assignment.periods_per_week,
                max(0, int(assignment.max_periods_per_session) - fixed_assignment_load),
                class_cap,
                teacher_session_capacity(session),
            )
            cap = _assignment_session_cap(assignment, session, base_cap, constraints)
            if cap > 0:
                n_vars[(ai, si)] = model.NewIntVar(0, cap, f"n_{ai}_{si}")
                n_caps[(ai, si)] = cap

    z_vars: dict[tuple[str, int], Any] = {
        (teacher, si): model.NewBoolVar(f"z_{teacher}_{si}")
        for teacher in data.teachers
        for si, _session in enumerate(sessions)
    }
    c_vars: dict[tuple[str, int], Any] = {
        (class_info.name, si): model.NewBoolVar(f"c_{class_info.name}_{si}")
        for class_info in data.classes
        for si, _session in enumerate(sessions)
    }
    u_vars: dict[tuple[int, int], Any] = {
        key: model.NewBoolVar(f"u_{key[0]}_{key[1]}")
        for key in n_vars
    }
    d_vars: dict[tuple[str, int], Any] = {
        (teacher, day): model.NewBoolVar(f"d_{teacher}_{day}")
        for teacher in data.teachers
        for day in sorted({session.day for session in sessions})
    }

    for key, var in n_vars.items():
        u_var = u_vars[key]
        model.Add(var <= n_caps[key] * u_var)
        model.Add(var >= u_var)

    period_block_vars = 0
    lesson_block_impossible_constraints = 0
    lesson_block_deferred_constraints = 0
    teacher_cross_session_period_constraints = 0
    teacher_period_gap_constraints = 0
    period_block_choices: dict[tuple[int, int], list[tuple[int, int, Any, tuple[int, ...]]]] = {}
    hinted_periods_by_assignment_session: dict[tuple[int, int], set[int]] = {}
    if hint_lessons:
        assignment_index_by_key = {
            (assignment.class_name, assignment.subject, assignment.teacher): ai
            for ai, assignment in enumerate(data.assignments)
        }
        for lesson in hint_lessons:
            ai = assignment_index_by_key.get(
                (lesson.class_name, lesson.subject, lesson.teacher)
            )
            si = session_by_key.get((int(lesson.day), str(lesson.session)))
            if ai is None or si is None:
                continue
            hinted_periods_by_assignment_session.setdefault((ai, si), set()).add(
                int(lesson.period)
            )
    period_feasibility_session_indexes = set(period_feasibility_session_indexes or set())
    if constraints is not None and constraints.active and period_feasibility_session_indexes:
        class_period_terms: dict[tuple[str, int, int], list[Any]] = {}
        teacher_period_terms: dict[tuple[str, int, int], list[Any]] = {}
        room_period_terms: dict[tuple[str, int, int], list[Any]] = {}
        for (ai, si), n_var in n_vars.items():
            if si not in period_feasibility_session_indexes:
                continue
            assignment = data.assignments[ai]
            session = sessions[si]
            allowed = set(_assignment_available_periods(assignment, session, constraints))
            choices: list[tuple[int, Any, tuple[int, ...]]] = []
            for duration in range(1, int(n_caps[(ai, si)]) + 1):
                for start in sorted(allowed):
                    block = tuple(range(start, start + duration))
                    if not _assignment_block_allowed(assignment, session, start, duration, constraints):
                        continue
                    fixed_periods = fixed_assignment_session_periods.get(
                        (
                            assignment.class_name,
                            assignment.subject,
                            assignment.teacher,
                            si,
                        ),
                        set(),
                    )
                    combined_periods = set(block) | set(fixed_periods)
                    if (
                        rule_set.contiguous_multi_period_assignments
                        and fixed_periods
                        and max(combined_periods) - min(combined_periods) + 1
                        != len(combined_periods)
                    ):
                        continue
                    combined_block_allowed = True
                    if (
                        fixed_periods
                        and max(combined_periods) - min(combined_periods) + 1
                        == len(combined_periods)
                    ):
                        combined_start = min(combined_periods)
                        combined_duration = len(combined_periods)
                        subject_rule = constraints.subject_rule_for(
                            assignment.class_name,
                            assignment.subject,
                        )
                        if isinstance(subject_rule, Mapping):
                            combined_block_allowed = _subject_like_block_allowed(
                                subject_rule,
                                session,
                                combined_start,
                                combined_duration,
                            )
                        if combined_block_allowed:
                            combined_block_allowed = all(
                                not isinstance(group_rule, Mapping)
                                or _subject_like_block_allowed(
                                    group_rule,
                                    session,
                                    combined_start,
                                    combined_duration,
                                )
                                for _group_id, group_rule in constraints.subject_group_rules_for(
                                    assignment.class_name,
                                    assignment.subject,
                                )
                            )
                    if not combined_block_allowed:
                        # A residual one-period choice can complete a block
                        # across a fixed anchor. Apply break-pair and linked-day
                        # rules to that merged block, not just the residual.
                        continue
                    choice = model.NewBoolVar(f"period_block_{ai}_{si}_{duration}_{start}")
                    period_block_vars += 1
                    choices.append((duration, choice, block))
                    period_block_choices.setdefault((ai, si), []).append(
                        (duration, start, choice, block)
                    )
                    for period in block:
                        class_period_terms.setdefault((assignment.class_name, si, period), []).append(choice)
                        teacher_period_terms.setdefault((assignment.teacher, si, period), []).append(choice)
                        if assignment.room:
                            room_period_terms.setdefault((assignment.room, si, period), []).append(choice)
            if choices:
                model.Add(sum(choice for _duration, choice, _block in choices) <= 1)
                model.Add(n_var == sum(duration * choice for duration, choice, _block in choices))
                hinted_periods = hinted_periods_by_assignment_session.get((ai, si), set())
                hinted_block = tuple(sorted(hinted_periods))
                matching_hint = bool(hinted_block) and any(
                    tuple(block) == hinted_block
                    for _duration, _choice, block in choices
                )
                if not hinted_block or matching_hint:
                    for _duration, choice, block in choices:
                        model.AddHint(
                            choice,
                            1 if matching_hint and tuple(block) == hinted_block else 0,
                        )
            else:
                model.Add(n_var == 0)

        for terms in class_period_terms.values():
            if len(terms) > 1:
                model.Add(sum(terms) <= 1)
        for terms in teacher_period_terms.values():
            if len(terms) > 1:
                model.Add(sum(terms) <= 1)
        for terms in room_period_terms.values():
            if len(terms) > 1:
                model.Add(sum(terms) <= 1)

        # The teacher UI can forbid the combination of morning period 5 and
        # afternoon period 1 on the same day.  This is not a half-day load
        # limit: both sessions may be used as long as those two edge periods are
        # not used together.  Model it whenever both sessions participate in
        # the concrete-period bridge so the session solver cannot hand an
        # inherently invalid vector to the period allocator.
        session_index_by_key = {
            (int(session.day), str(session.part)): si
            for si, session in enumerate(sessions)
        }
        for teacher in data.teachers:
            rule = constraints.teacher.get(teacher, {})
            if not isinstance(rule, Mapping):
                continue
            for day in sorted({session.day for session in sessions}):
                dk = _day_key(day)
                forbidden_pair = _truthy(_get_path(rule, f"noMorningP5AfternoonP1.{dk}", False)) or _truthy(
                    _get_path(rule, f"noMorningP5AfternoonP1.sang.{dk}", False)
                )
                if not forbidden_pair:
                    continue
                morning_si = session_index_by_key.get((int(day), "AM"))
                afternoon_si = session_index_by_key.get((int(day), "PM"))
                if (
                    morning_si is None
                    or afternoon_si is None
                    or morning_si not in period_feasibility_session_indexes
                    or afternoon_si not in period_feasibility_session_indexes
                ):
                    continue
                terms = [
                    *teacher_period_terms.get((teacher, morning_si, 5), []),
                    *teacher_period_terms.get((teacher, afternoon_si, 1), []),
                ]
                fixed_count = sum(
                    1
                    for lesson in fixed_lessons
                    if lesson.teacher == teacher
                    and int(lesson.day) == int(day)
                    and (
                        (str(lesson.session) == "AM" and int(lesson.period) == 5)
                        or (str(lesson.session) == "PM" and int(lesson.period) == 1)
                    )
                )
                model.Add(sum(terms) + fixed_count <= 1)
                teacher_cross_session_period_constraints += 1

        if period_max_teacher_gap is not None:
            max_gap = max(0, int(period_max_teacher_gap))
            for teacher in data.teachers:
                for si, session in enumerate(sessions):
                    if si not in period_feasibility_session_indexes:
                        continue
                    cap = teacher_session_capacity(session)
                    fixed_periods = fixed_teacher_session_periods.get((teacher, si), set())
                    occupied = {
                        period: (
                            sum(teacher_period_terms.get((teacher, si, period), []))
                            + (1 if period in fixed_periods else 0)
                        )
                        for period in range(1, cap + 1)
                    }
                    possible_periods = {
                        period
                        for period in range(1, cap + 1)
                        if teacher_period_terms.get((teacher, si, period))
                        or period in fixed_periods
                    }
                    for first in sorted(possible_periods):
                        for last in sorted(period for period in possible_periods if period > first):
                            required_inside = (last - first - 1) - max_gap
                            if required_inside <= 0:
                                continue
                            model.Add(
                                sum(occupied[period] for period in range(first + 1, last))
                                >= required_inside * (occupied[first] + occupied[last] - 1)
                            )
                            teacher_period_gap_constraints += 1

    shortfall_vars: dict[int, Any] = {}
    total_requested_periods = sum(max(0, int(item.periods_per_week)) for item in data.assignments)
    for ai, assignment in enumerate(data.assignments):
        terms = [n_vars[(ai, si)] for si in range(len(sessions)) if (ai, si) in n_vars]
        if allow_unassigned:
            shortfall = model.NewIntVar(0, max(0, int(assignment.periods_per_week)), f"shortfall_{ai}")
            shortfall_vars[ai] = shortfall
            model.Add(sum(terms) + shortfall == assignment.periods_per_week)
        else:
            model.Add(sum(terms) == assignment.periods_per_week)

    for class_info in data.classes:
        for si, session in enumerate(sessions):
            cap = class_session_capacity_for_constraints(
                class_info.grade,
                class_info.name,
                session,
                constraints,
            )
            if cap <= 0:
                continue
            terms = [
                n_vars[(ai, si)]
                for ai, assignment in enumerate(data.assignments)
                if assignment.class_name == class_info.name and (ai, si) in n_vars
            ]
            fixed_load = int(fixed_class_session_load.get((class_info.name, si), 0))
            load = sum(terms)
            c_var = c_vars[(class_info.name, si)]
            if not terms:
                model.Add(c_var == (1 if fixed_load > 0 else 0))
                continue
            model.Add(load <= cap * c_var)
            if fixed_load > 0:
                model.Add(c_var == 1)
            else:
                model.Add(load >= c_var)

    if constraints is not None:
        for limit_rule in _iter_limit_rules(constraints):
            for si, session in enumerate(sessions):
                for field in ("classes", "teachers", "rooms", "subjects"):
                    limit = _limit_for_slot(limit_rule, field, session)
                    if limit <= 0:
                        continue
                    terms = [
                        n_vars[(ai, si)]
                        for ai, assignment in enumerate(data.assignments)
                        if (ai, si) in n_vars and _assignment_matches_limit(assignment, limit_rule, constraints)
                    ]
                    if terms:
                        model.Add(sum(terms) <= teacher_session_capacity(session) * limit)

        processed_subject_like: set[tuple[str, str, str]] = set()
        for ai, assignment in enumerate(data.assignments):
            subject_rule = constraints.subject_rule_for(assignment.class_name, assignment.subject)
            rule_sets: list[tuple[str, str, Mapping[str, Any], Any]] = [
                (
                    "subject",
                    assignment.subject,
                    subject_rule,
                    lambda candidate, assignment=assignment: (
                        candidate.class_name == assignment.class_name
                        and candidate.subject == assignment.subject
                    ),
                )
            ]
            for group_id, group_rule in constraints.subject_group_rules_for(assignment.class_name, assignment.subject):
                rule_sets.append(
                    (
                        "subjectGroup",
                        str(group_id),
                        group_rule,
                        lambda candidate, group_id=group_id, assignment=assignment: (
                            candidate.class_name == assignment.class_name
                            and constraints.subject_in_group(candidate.subject, str(group_id))
                        ),
                    )
                )

            for scope, target_id, rule_obj, matcher in rule_sets:
                if not isinstance(rule_obj, Mapping) or not rule_obj:
                    continue
                rule_key = (scope, assignment.class_name, target_id)
                if rule_key in processed_subject_like:
                    continue
                processed_subject_like.add(rule_key)

                def matching_terms_for_sessions(session_indexes: list[int], *, use_u: bool = False) -> list[Any]:
                    var_map = u_vars if use_u else n_vars
                    return [
                        var_map[(bi, si)]
                        for bi, candidate in enumerate(data.assignments)
                        if matcher(candidate)
                        for si in session_indexes
                        if (bi, si) in var_map
                    ]

                morning_week = _to_int(_get_path(rule_obj, "weeklySessionPeriods.morning", 0), 0)
                if morning_week > 0:
                    terms = matching_terms_for_sessions([si for si, s in enumerate(sessions) if s.part == "AM"])
                    if terms:
                        model.Add(sum(terms) <= morning_week)
                afternoon_week = _to_int(_get_path(rule_obj, "weeklySessionPeriods.afternoon", 0), 0)
                if afternoon_week > 0:
                    terms = matching_terms_for_sessions([si for si, s in enumerate(sessions) if s.part == "PM"])
                    if terms:
                        model.Add(sum(terms) <= afternoon_week)

                max_morning_sessions = _to_int(_get_path(rule_obj, "maxSessions.morning", 0), 0)
                if max_morning_sessions > 0:
                    terms = matching_terms_for_sessions([si for si, s in enumerate(sessions) if s.part == "AM"], use_u=True)
                    if terms:
                        model.Add(sum(terms) <= max_morning_sessions)
                max_afternoon_sessions = _to_int(_get_path(rule_obj, "maxSessions.afternoon", 0), 0)
                if max_afternoon_sessions > 0:
                    terms = matching_terms_for_sessions([si for si, s in enumerate(sessions) if s.part == "PM"], use_u=True)
                    if terms:
                        model.Add(sum(terms) <= max_afternoon_sessions)
                max_all_sessions = _to_int(_get_path(rule_obj, "maxSessions.day", 0), 0)
                if max_all_sessions > 0:
                    terms = matching_terms_for_sessions(list(range(len(sessions))), use_u=True)
                    if terms:
                        model.Add(sum(terms) <= max_all_sessions)

                if _truthy(_get_path(rule_obj, "sessionAllowed.oneSessionPerDay", False)):
                    for day in sorted({s.day for s in sessions}):
                        terms = matching_terms_for_sessions(
                            [si for si, s in enumerate(sessions) if s.day == day],
                            use_u=True,
                        )
                        if terms:
                            model.Add(sum(terms) <= 1)

                spacing = _to_int(_get_path(rule_obj, "spacingDays.days", 0), 0)
                if spacing > 0 and scope == "subject":
                    day_values = sorted({s.day for s in sessions})
                    for left_index, left_day in enumerate(day_values):
                        for right_day in day_values[left_index + 1 :]:
                            if right_day - left_day > spacing:
                                continue
                            terms = matching_terms_for_sessions(
                                [si for si, s in enumerate(sessions) if s.day in {left_day, right_day}],
                                use_u=True,
                            )
                            if terms:
                                model.Add(sum(terms) <= 1)

                for day in sorted({s.day for s in sessions}):
                    day_indexes = [si for si, s in enumerate(sessions) if s.day == day]
                    day_limit = _day_limit_from_rule(rule_obj, "maxPeriods.day", day)
                    if day_limit > 0:
                        terms = matching_terms_for_sessions(day_indexes)
                        if terms:
                            model.Add(sum(terms) <= day_limit)
                for si, session in enumerate(sessions):
                    session_limit = _to_int(_get_path(rule_obj, f"maxPeriods.{_session_key(session)}", 0), 0)
                    if session_limit > 0:
                        terms = matching_terms_for_sessions([si])
                        if terms:
                            model.Add(sum(terms) <= session_limit)

                if scope == "subjectGroup":
                    for si, session in enumerate(sessions):
                        subject_limit = _to_int(_get_path(rule_obj, f"maxSubjects.{_session_key(session)}", 0), 0)
                        if subject_limit > 0:
                            terms = matching_terms_for_sessions([si], use_u=True)
                            if terms:
                                model.Add(sum(terms) <= subject_limit)
                    day_subject_limit = _to_int(_get_path(rule_obj, "maxSubjects.day", 0), 0)
                    if day_subject_limit > 0:
                        for day in sorted({s.day for s in sessions}):
                            terms = matching_terms_for_sessions(
                                [si for si, s in enumerate(sessions) if s.day == day],
                                use_u=True,
                            )
                            if terms:
                                model.Add(sum(terms) <= day_subject_limit)

                lesson_blocks = rule_obj.get("lessonBlocks") if isinstance(rule_obj.get("lessonBlocks"), Mapping) else {}
                if scope == "subject" and lesson_blocks:
                    block_terms_by_length: dict[int, list[Any]] = {length: [] for length in (2, 3, 4, 5)}
                    fixed_blocks_by_length: dict[int, int] = {length: 0 for length in (2, 3, 4, 5)}
                    unmodeled_fixed_residual_by_length: dict[int, bool] = {
                        length: False for length in (2, 3, 4, 5)
                    }
                    scheduled_terms_for_rule = matching_terms_for_sessions(list(range(len(sessions))))
                    scheduled_expr_for_rule = sum(scheduled_terms_for_rule)
                    fixed_scheduled_for_rule = 0
                    for bi, candidate in enumerate(data.assignments):
                        if not matcher(candidate):
                            continue
                        for si, _session in enumerate(sessions):
                            fixed_periods = fixed_assignment_session_periods.get(
                                (
                                    candidate.class_name,
                                    candidate.subject,
                                    candidate.teacher,
                                    si,
                                ),
                                set(),
                            )
                            fixed_scheduled_for_rule += len(fixed_periods)
                            key = (bi, si)
                            for length in (2, 3, 4, 5):
                                conf = lesson_blocks.get(str(length)) or lesson_blocks.get(length)
                                if not isinstance(conf, Mapping):
                                    continue
                                fixed_blocks = _count_contiguous_blocks(fixed_periods, length)
                                fixed_blocks_by_length[length] += fixed_blocks
                                if key not in n_vars:
                                    continue
                                choices = period_block_choices.get(key, [])
                                if choices:
                                    # The concrete-period bridge can count a
                                    # pair formed by one hard-fixed lesson and
                                    # one residual lesson. Counting n_var alone
                                    # misses that valid Min=1 case because fixed
                                    # demand was already removed upstream.
                                    for _duration, _start, choice, block in choices:
                                        combined_blocks = _count_contiguous_blocks(
                                            set(fixed_periods) | set(block),
                                            length,
                                        )
                                        block_delta = combined_blocks - fixed_blocks
                                        if block_delta:
                                            block_terms_by_length[length].append(
                                                block_delta * choice
                                            )
                                    continue
                                # Subject-period requirements normally enable
                                # the concrete-period bridge. If a legacy lane
                                # omits it, do not guess how residual periods
                                # interact with fixed periods. Defer the whole
                                # bound for this length to merged validation;
                                # adding an "impossible" contradiction here
                                # would reject a valid fixed+flexible pair.
                                if fixed_periods:
                                    unmodeled_fixed_residual_by_length[length] = True
                                    continue
                                n_var = n_vars[key]
                                cap = int(n_caps.get(key, 0))
                                if cap < length:
                                    continue
                                block_var = model.NewBoolVar(f"subject_block_{scope}_{bi}_{si}_{length}")
                                model.Add(n_var >= length).OnlyEnforceIf(block_var)
                                model.Add(n_var <= length - 1).OnlyEnforceIf(block_var.Not())
                                block_terms_by_length[length].append(block_var)
                    for length, block_terms in block_terms_by_length.items():
                        conf = lesson_blocks.get(str(length)) or lesson_blocks.get(length)
                        if not isinstance(conf, Mapping):
                            continue
                        if unmodeled_fixed_residual_by_length.get(length):
                            lesson_block_deferred_constraints += 1
                            continue
                        minimum = _to_int(conf.get("min"), 0)
                        maximum = _to_int(conf.get("max"), 0)
                        fixed_blocks = int(fixed_blocks_by_length.get(length, 0))
                        block_expr = sum(block_terms) + fixed_blocks
                        if minimum > 0:
                            if allow_unassigned and fixed_scheduled_for_rule <= 0:
                                target_active = model.NewBoolVar(
                                    f"subject_block_active_{scope}_{assignment.class_name}_{target_id}_{length}"
                                )
                                model.Add(scheduled_expr_for_rule >= 1).OnlyEnforceIf(target_active)
                                model.Add(scheduled_expr_for_rule == 0).OnlyEnforceIf(target_active.Not())
                                model.Add(block_expr >= minimum).OnlyEnforceIf(target_active)
                            elif block_terms or fixed_blocks > 0:
                                model.Add(block_expr >= minimum)
                            else:
                                impossible = model.NewBoolVar(f"impossible_subject_block_{scope}_{target_id}_{length}")
                                model.Add(impossible == 0)
                                model.Add(impossible == 1)
                                lesson_block_impossible_constraints += 1
                        if maximum > 0:
                            model.Add(block_expr <= maximum)

        for class_name, groups in (constraints.subject_no_same_session or {}).items():
            if not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                if len(subjects) < 2:
                    continue
                subject_set = set(subjects)
                for si, _session in enumerate(sessions):
                    terms = [
                        u_vars[(ai, si)]
                        for ai, assignment in enumerate(data.assignments)
                        if assignment.class_name == class_name
                        and assignment.subject in subject_set
                        and (ai, si) in u_vars
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
                            u_vars[(ai, si)]
                            for ai, assignment in enumerate(data.assignments)
                            if assignment.class_name == class_name
                            and assignment.subject == subject
                            for si, session in enumerate(sessions)
                            if session.day == day and (ai, si) in u_vars
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

        for teacher in data.teachers:
            rule = constraints.teacher.get(teacher, {})
            if not isinstance(rule, Mapping):
                rule = {}
            teacher_sessions = [si for si, _session in enumerate(sessions)]
            teacher_days = sorted({session.day for session in sessions})
            for si, session in enumerate(sessions):
                model.Add(z_vars[(teacher, si)] <= d_vars[(teacher, session.day)])
                required_periods = constraints.teacher_must_teach_periods(teacher, session.day, session.part)
                if required_periods:
                    fixed_required = sum(
                        1
                        for period in required_periods
                        if int(period) in fixed_teacher_session_periods.get((teacher, si), set())
                    )
                    remaining_required = max(0, len(required_periods) - fixed_required)
                    terms = [
                        n_vars[(ai, si)]
                        for ai, assignment in enumerate(data.assignments)
                        if assignment.teacher == teacher and (ai, si) in n_vars
                    ]
                    if remaining_required > 0:
                        model.Add(sum(terms) >= remaining_required)

            max_days = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
            if max_days > 0:
                model.Add(sum(d_vars[(teacher, day)] for day in teacher_days) <= max_days)
            max_sessions = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
            if max_sessions > 0:
                model.Add(sum(z_vars[(teacher, si)] for si in teacher_sessions) <= max_sessions)
            max_morning = _to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0)
            if max_morning > 0:
                model.Add(sum(z_vars[(teacher, si)] for si, session in enumerate(sessions) if session.part == "AM") <= max_morning)
            max_afternoon = _to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0)
            if max_afternoon > 0:
                model.Add(sum(z_vars[(teacher, si)] for si, session in enumerate(sessions) if session.part == "PM") <= max_afternoon)

            for day in teacher_days:
                dk = _day_key(day)
                session_indexes = [si for si, session in enumerate(sessions) if session.day == day]
                if _truthy(_get_path(rule, f"oneSessionPerDay.{dk}", False)):
                    model.Add(sum(z_vars[(teacher, si)] for si in session_indexes) <= 1)

            day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{dk}", 0), 0)
            if day_limit > 0:
                terms = [
                    n_vars[(ai, si)]
                    for ai, assignment in enumerate(data.assignments)
                        if assignment.teacher == teacher
                    for si in session_indexes
                    if (ai, si) in n_vars
                ]
                fixed_load = int(fixed_teacher_day_load.get((teacher, day), 0))
                if terms or fixed_load > 0:
                    model.Add(sum(terms) + fixed_load <= day_limit)

            for si, session in enumerate(sessions):
                sk = _session_key(session)
                dk = _day_key(session.day)
                limit = _to_int(_get_path(rule, f"maxPeriods.{sk}.{dk}", 0), 0)
                if limit <= 0:
                    continue
                terms = [
                    n_vars[(ai, si)]
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.teacher == teacher and (ai, si) in n_vars
                ]
                fixed_load = int(fixed_teacher_session_load.get((teacher, si), 0))
                if terms or fixed_load > 0:
                    model.Add(sum(terms) + fixed_load <= limit)

        for teacher in data.teachers:
            rule = constraints.teacher.get(teacher, {})
            mpc = rule.get("maxPeriodsClass", {}) if isinstance(rule, Mapping) else {}
            if not isinstance(mpc, Mapping):
                continue
            configs: list[tuple[str, Mapping[str, Any]]] = []
            by_group = mpc.get("bySubjectGroup")
            if isinstance(by_group, Mapping):
                configs.extend((str(group_id), conf) for group_id, conf in by_group.items() if isinstance(conf, Mapping))
            else:
                configs.append(("__all__", mpc))
            for group_id, conf in configs:
                per_session = _to_int(conf.get("perSession"), 0)
                per_day = _to_int(conf.get("perDay"), 0)
                if per_session <= 0 and per_day <= 0:
                    continue
                for class_info in data.classes:
                    def matches(assignment: Any) -> bool:
                        return (
                            assignment.teacher == teacher
                            and assignment.class_name == class_info.name
                            and (group_id in {"__all__", "all"} or constraints.subject_in_group(assignment.subject, group_id))
                        )

                    if per_session > 0:
                        for si, _session in enumerate(sessions):
                            terms = [
                                n_vars[(ai, si)]
                                for ai, assignment in enumerate(data.assignments)
                                if matches(assignment) and (ai, si) in n_vars
                            ]
                            fixed_load = int(fixed_teacher_class_session_load.get((teacher, class_info.name, si), 0))
                            if terms or fixed_load > 0:
                                model.Add(sum(terms) + fixed_load <= per_session)
                    if per_day > 0:
                        for day in sorted({session.day for session in sessions}):
                            session_indexes = [si for si, session in enumerate(sessions) if session.day == day]
                            terms = [
                                n_vars[(ai, si)]
                                for ai, assignment in enumerate(data.assignments)
                                if matches(assignment)
                                for si in session_indexes
                                if (ai, si) in n_vars
                            ]
                            fixed_load = int(fixed_teacher_class_day_load.get((teacher, class_info.name, day), 0))
                            if terms or fixed_load > 0:
                                model.Add(sum(terms) + fixed_load <= per_day)

    direct_zero_single_cap = (
        max_one_period_sessions is not None
        and int(max_one_period_sessions) == 0
        and not minimize_one_period_sessions
    )
    for teacher in data.teachers:
        for si, session in enumerate(sessions):
            terms = [
                n_vars[(ai, si)]
                for ai, assignment in enumerate(data.assignments)
                if assignment.teacher == teacher and (ai, si) in n_vars
            ]
            z_var = z_vars[(teacher, si)]
            fixed_load = int(fixed_teacher_session_load.get((teacher, si), 0))
            if not terms:
                model.Add(z_var == (1 if fixed_load > 0 else 0))
                if direct_zero_single_cap:
                    model.Add(fixed_load >= 2 * z_var)
                continue
            load = sum(terms)
            total_load = load + fixed_load
            session_cap = _teacher_session_period_capacity(data, teacher, session, constraints)
            model.Add(load <= session_cap * z_var)
            if fixed_load > 0:
                model.Add(z_var == 1)
            else:
                model.Add(load >= z_var)
            if direct_zero_single_cap:
                model.Add(total_load >= 2 * z_var)

    rooms = sorted({assignment.room for assignment in data.assignments if assignment.room})
    for room in rooms:
        for si, session in enumerate(sessions):
            terms = [
                n_vars[(ai, si)]
                for ai, assignment in enumerate(data.assignments)
                if assignment.room == room and (ai, si) in n_vars
            ]
            if terms:
                model.Add(sum(terms) <= teacher_session_capacity(session))

    teacher_single_vars: list[Any] = []
    need_teacher_single_vars = (
        not direct_zero_single_cap
        and (
            max_one_period_sessions is not None
            or early_stop_max_one_period_sessions is not None
            or (minimize_one_period_sessions and (minimize_sessions or minimize_hint_distance))
        )
    )
    if need_teacher_single_vars:
        for teacher in data.teachers:
            for si, session in enumerate(sessions):
                terms = [
                    n_vars[(ai, si)]
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.teacher == teacher and (ai, si) in n_vars
                ]
                fixed_load = int(fixed_teacher_session_load.get((teacher, si), 0))
                if not terms and fixed_load <= 0:
                    continue
                z_var = z_vars[(teacher, si)]
                single = model.NewBoolVar(f"teacher_single_{teacher}_{si}")
                load = sum(terms) + fixed_load
                cap = _teacher_session_period_capacity(data, teacher, session, constraints) + fixed_load
                model.Add(single <= z_var)
                # Allow one-period teacher sessions, but make every such occurrence
                # visible to the objective so avoidable cases are pushed out.
                model.Add(load >= 2 * z_var - single)
                model.Add(load <= 1 + cap * (1 - single))
                teacher_single_vars.append(single)

    q_vars: dict[int, Any] = {}
    if legacy_wednesday_pm_bridge:
        wpm_si = next((i for i, session in enumerate(sessions) if session.day == 4 and session.part == "PM"), None)
        if wpm_si is not None:
            wpm_session = sessions[wpm_si]
            for ai, assignment in enumerate(data.assignments):
                if assignment.grade not in LOWER_GRADES and (ai, wpm_si) in n_vars:
                    q_vars[ai] = model.NewBoolVar(f"wpm_bridge_q_{ai}")
                    model.Add(q_vars[ai] <= n_vars[(ai, wpm_si)])

            for class_info in data.classes:
                if class_info.grade in LOWER_GRADES:
                    continue
                if 3 not in class_available_periods(class_info.grade, class_info.name, wpm_session, constraints):
                    continue
                terms = [
                    q_vars[ai]
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.class_name == class_info.name and ai in q_vars
                ]
                if terms:
                    model.Add(sum(terms) == 1)

            for teacher in data.teachers:
                q_terms = [
                    q_vars[ai]
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.teacher == teacher and ai in q_vars
                ]
                if q_terms:
                    model.Add(sum(q_terms) <= 1)
                wpm_terms = [
                    n_vars[(ai, wpm_si)]
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.teacher == teacher and (ai, wpm_si) in n_vars
                ]
                if wpm_terms or q_terms:
                    model.Add(sum(wpm_terms) - sum(q_terms) >= 0)
                    model.Add(sum(wpm_terms) - sum(q_terms) <= 2)

    teacher_session_sum = sum(z_vars.values())
    if max_teacher_sessions is not None:
        model.Add(teacher_session_sum <= max_teacher_sessions)
    if min_teacher_sessions is not None:
        model.Add(teacher_session_sum >= min_teacher_sessions)

    forbidden_session_vectors = forbidden_session_vectors or []
    forbidden_eq_vars = 0
    for cut_index, (si, counts_by_assignment) in enumerate(forbidden_session_vectors):
        eq_terms = []
        for ai, value in counts_by_assignment.items():
            key = (int(ai), int(si))
            if key not in n_vars:
                continue
            var = n_vars[key]
            eq = model.NewBoolVar(f"forbid_{cut_index}_{ai}_{si}")
            model.Add(var == int(value)).OnlyEnforceIf(eq)
            model.Add(var != int(value)).OnlyEnforceIf(eq.Not())
            eq_terms.append(eq)
        if eq_terms:
            model.Add(sum(eq_terms) <= len(eq_terms) - 1)
            forbidden_eq_vars += len(eq_terms)

    hint_metrics: dict[str, Any] = {"used": False, "fixed": False, "repair": False}
    hint_distance_terms: list[Any] = []
    hint_distance_upper_bound = 0
    if hint_allocations:
        assignment_by_key = {
            (assignment.class_name, assignment.subject, assignment.teacher): ai
            for ai, assignment in enumerate(data.assignments)
        }
        session_by_key = {(session.day, session.part): si for si, session in enumerate(sessions)}
        hinted_counts: dict[tuple[int, int], int] = {}
        unmapped = 0
        for allocation in hint_allocations:
            ai = assignment_by_key.get((allocation.class_name, allocation.subject, allocation.teacher))
            si = session_by_key.get((allocation.session.day, allocation.session.part))
            if ai is None or si is None or (ai, si) not in n_vars:
                unmapped += 1
                continue
            hinted_counts[(ai, si)] = hinted_counts.get((ai, si), 0) + int(allocation.count)

        hinted_teacher_sessions = {
            (data.assignments[ai].teacher, si)
            for (ai, si), count in hinted_counts.items()
            if count > 0
        }
        for key, var in n_vars.items():
            hinted_value = int(hinted_counts.get(key, 0))
            model.AddHint(var, hinted_value)
            if minimize_hint_distance:
                diff_cap = max(teacher_session_capacity(sessions[key[1]]), hinted_value)
                diff = model.NewIntVar(0, diff_cap, f"hint_diff_{key[0]}_{key[1]}")
                model.AddAbsEquality(diff, var - hinted_value)
                hint_distance_terms.append(diff)
                hint_distance_upper_bound += diff_cap
        for key, var in z_vars.items():
            model.AddHint(var, 1 if key in hinted_teacher_sessions else 0)
        hinted_class_sessions = {
            (data.assignments[ai].class_name, si)
            for (ai, si), count in hinted_counts.items()
            if count > 0
        }
        hinted_teacher_days = {
            (teacher, sessions[si].day)
            for teacher, si in hinted_teacher_sessions
        }
        for key, var in u_vars.items():
            model.AddHint(var, 1 if hinted_counts.get(key, 0) > 0 else 0)
        for key, var in c_vars.items():
            model.AddHint(var, 1 if key in hinted_class_sessions else 0)
        for key, var in d_vars.items():
            model.AddHint(var, 1 if key in hinted_teacher_days else 0)
        solver_hint_session_count = len(hinted_teacher_sessions)
        hint_metrics = {
            "used": True,
            "fixed": bool(fix_hint),
            "repair": bool(repair_hint),
            "unmapped_allocations": unmapped,
            "hinted_assignment_sessions": len(hinted_counts),
            "hinted_teacher_sessions": solver_hint_session_count,
            "hinted_period_lessons": len(hint_lessons),
            "hinted_period_assignment_sessions": len(
                hinted_periods_by_assignment_session
            ),
            "minimize_distance": bool(minimize_hint_distance),
        }

    teacher_single_penalty = sum(teacher_single_vars)
    shortfall_penalty = sum(shortfall_vars.values()) if shortfall_vars else 0
    if max_one_period_sessions is not None:
        model.Add(teacher_single_penalty <= int(max_one_period_sessions))
    teacher_session_objective_weight = len(teacher_single_vars) + 1
    one_period_objective_weight = len(z_vars) + sum(int(cap) for cap in n_caps.values()) + 1
    hint_distance_objective_weight = len(teacher_single_vars) + 1
    shortfall_objective_weight = max(
        1_000_000,
        (len(z_vars) + len(n_vars) + len(teacher_single_vars) + sum(int(cap) for cap in n_caps.values()) + 1) ** 3,
    )
    objective_mode = "none"
    objective_expr: Any | None = None
    if minimize_sessions:
        if minimize_one_period_sessions:
            if one_period_priority_absolute:
                objective_mode = "minimize_one_period_sessions_then_teacher_sessions"
                objective_expr = teacher_single_penalty * one_period_objective_weight + teacher_session_sum
            else:
                objective_mode = "minimize_teacher_sessions_then_one_period_sessions"
                objective_expr = teacher_session_sum * teacher_session_objective_weight + teacher_single_penalty
        else:
            objective_mode = "minimize_teacher_sessions"
            objective_expr = teacher_session_sum
    elif minimize_hint_distance and hint_distance_terms:
        if minimize_one_period_sessions:
            if one_period_priority_absolute:
                objective_mode = "minimize_one_period_sessions_then_hint_distance"
                objective_expr = teacher_single_penalty * one_period_objective_weight + sum(hint_distance_terms)
            else:
                objective_mode = "minimize_hint_distance_then_one_period_sessions"
                objective_expr = sum(hint_distance_terms) * hint_distance_objective_weight + teacher_single_penalty
        else:
            objective_mode = "minimize_hint_distance"
            objective_expr = sum(hint_distance_terms)
    if (
        objective_expr is not None
        and minimize_sessions
        and minimize_hint_distance
        and hint_distance_terms
        and not allow_unassigned
    ):
        # Warm starts must never outweigh one fewer teacher session (or one
        # fewer single-period session).  Scale the full quality objective above
        # the maximum possible hint distance, then use distance only to break
        # equal-quality ties.
        hint_scale = max(1, int(hint_distance_upper_bound) + 1)
        objective_expr = objective_expr * hint_scale + sum(hint_distance_terms)
        objective_mode = f"{objective_mode}_then_hint_distance"
    else:
        hint_scale = 1
    if allow_unassigned:
        if objective_expr is None:
            objective_mode = "minimize_unassigned_periods"
            objective_expr = shortfall_penalty * shortfall_objective_weight
        else:
            objective_mode = f"minimize_unassigned_periods_then_{objective_mode}"
            objective_expr = shortfall_penalty * shortfall_objective_weight + objective_expr
    if objective_expr is not None:
        model.Minimize(objective_expr)

    early_stop_teacher_threshold = (
        max(1, int(early_stop_teacher_sessions))
        if early_stop_teacher_sessions is not None and int(early_stop_teacher_sessions) > 0
        else None
    )
    if early_stop_teacher_threshold is not None and max_teacher_sessions is not None:
        early_stop_teacher_threshold = min(early_stop_teacher_threshold, int(max_teacher_sessions))
    early_stop_one_period_threshold = (
        max(0, int(early_stop_max_one_period_sessions))
        if early_stop_max_one_period_sessions is not None
        else (int(max_one_period_sessions) if max_one_period_sessions is not None else None)
    )
    effective_linearization_level = max(0, min(2, int(linearization_level)))

    if progress:
        progress(
            {
                "stage": "session_cp_sat:model",
                "message": "Dựng mô hình CP-SAT cấp buổi",
                "assignment_session_vars": len(n_vars),
                "teacher_session_vars": len(z_vars),
                "teacher_single_vars": len(teacher_single_vars),
                "period_block_vars": period_block_vars,
                "lesson_block_impossible_constraints": lesson_block_impossible_constraints,
                "lesson_block_deferred_constraints": lesson_block_deferred_constraints,
                "period_feasibility_session_indexes": sorted(period_feasibility_session_indexes),
                "legacy_wednesday_pm_bridge": bool(legacy_wednesday_pm_bridge),
                "objective_mode": objective_mode,
                "teacher_session_objective_weight": teacher_session_objective_weight,
                "one_period_objective_weight": one_period_objective_weight,
                "bridge_vars": len(q_vars),
                "forbidden_session_vectors": len(forbidden_session_vectors),
                "max_teacher_sessions": max_teacher_sessions,
                "max_one_period_sessions": max_one_period_sessions,
                "time_limit_seconds": time_limit_seconds,
                "num_workers": effective_num_workers,
                "requested_num_workers": requested_num_workers,
                "linearization_level": effective_linearization_level,
                "minimize_one_period_sessions": bool(minimize_one_period_sessions),
                "early_stop_teacher_sessions": early_stop_teacher_threshold,
                "early_stop_max_one_period_sessions": early_stop_one_period_threshold,
            }
        )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_seconds)
    solver.parameters.num_search_workers = effective_num_workers
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = effective_linearization_level
    if random_seed is not None:
        solver.parameters.random_seed = int(random_seed)
        solver.parameters.randomize_search = True
    if hint_allocations:
        solver.parameters.fix_variables_to_their_hinted_value = bool(fix_hint)
        solver.parameters.repair_hint = False

    early_stop_callback = None
    if early_stop_teacher_threshold is not None:
        teacher_session_vars = tuple(z_vars.values())
        one_period_vars = tuple(teacher_single_vars)
        unassigned_vars = tuple(shortfall_vars.values())

        class SessionQualityEarlyStop(cp_model.CpSolverSolutionCallback):
            def __init__(self) -> None:
                super().__init__()
                self.solution_count = 0
                self.hit = False
                self.first_solution_seconds: float | None = None
                self.first_teacher_sessions: int | None = None
                self.first_one_period_sessions: int | None = None
                self.hit_seconds: float | None = None
                self.hit_teacher_sessions: int | None = None
                self.hit_one_period_sessions: int | None = None

            def on_solution_callback(self) -> None:
                self.solution_count += 1
                teacher_sessions = sum(int(self.value(var)) for var in teacher_session_vars)
                one_period_sessions = sum(int(self.value(var)) for var in one_period_vars)
                unassigned_periods = sum(int(self.value(var)) for var in unassigned_vars)
                if self.first_solution_seconds is None:
                    self.first_solution_seconds = float(self.wall_time)
                    self.first_teacher_sessions = teacher_sessions
                    self.first_one_period_sessions = one_period_sessions
                one_period_ok = (
                    early_stop_one_period_threshold is None
                    or one_period_sessions <= early_stop_one_period_threshold
                )
                if (
                    unassigned_periods == 0
                    and one_period_ok
                    and teacher_sessions <= early_stop_teacher_threshold
                ):
                    self.hit = True
                    self.hit_seconds = float(self.wall_time)
                    self.hit_teacher_sessions = teacher_sessions
                    self.hit_one_period_sessions = one_period_sessions
                    self.stop_search()

        early_stop_callback = SessionQualityEarlyStop()

    started = time.time()
    status = solver.Solve(model, early_stop_callback)
    elapsed = time.time() - started
    status_name = solver.StatusName(status)
    metrics: dict[str, Any] = {
        "solver": "ortools_cp_sat_session",
        "status": int(status),
        "status_name": status_name,
        "objective": None,
        "best_bound": None,
        "wall_time_seconds": float(solver.WallTime()),
        "elapsed_seconds": elapsed,
        "branches": int(solver.NumBranches()),
        "conflicts": int(solver.NumConflicts()),
        "max_teacher_sessions": max_teacher_sessions,
        "min_teacher_sessions": min_teacher_sessions,
        "max_one_period_sessions": max_one_period_sessions,
        "allow_unassigned": bool(allow_unassigned),
        "total_requested_periods": total_requested_periods,
        "minimize_sessions": minimize_sessions,
        "random_seed": random_seed,
        "hint": hint_metrics,
        "assignment_session_vars": len(n_vars),
        "teacher_session_vars": len(z_vars),
        "teacher_single_vars": len(teacher_single_vars),
        "period_block_vars": period_block_vars,
        "teacher_cross_session_period_constraints": teacher_cross_session_period_constraints,
        "teacher_period_gap_constraints": teacher_period_gap_constraints,
        "period_max_teacher_gap": period_max_teacher_gap,
        "lesson_block_impossible_constraints": lesson_block_impossible_constraints,
        "lesson_block_deferred_constraints": lesson_block_deferred_constraints,
        "period_feasibility_session_indexes": sorted(period_feasibility_session_indexes),
        "legacy_wednesday_pm_bridge": bool(legacy_wednesday_pm_bridge),
        "objective_mode": objective_mode,
        "teacher_session_objective_weight": teacher_session_objective_weight,
        "one_period_objective_weight": one_period_objective_weight,
        "hint_distance_objective_weight": hint_distance_objective_weight,
        "hint_distance_upper_bound": hint_distance_upper_bound,
        "hint_distance_quality_scale": hint_scale,
        "shortfall_objective_weight": shortfall_objective_weight if allow_unassigned else None,
        "secondary_objective": "one_period_teacher_sessions" if minimize_one_period_sessions else None,
        "minimize_one_period_sessions": bool(minimize_one_period_sessions),
        "one_period_priority_absolute": bool(one_period_priority_absolute),
        "num_workers": effective_num_workers,
        "requested_num_workers": requested_num_workers,
        "linearization_level": effective_linearization_level,
        "bridge_vars": len(q_vars),
        "forbidden_session_vectors": len(forbidden_session_vectors),
        "forbidden_eq_vars": forbidden_eq_vars,
        "minimize_hint_distance": bool(minimize_hint_distance),
        "early_stop_enabled": early_stop_callback is not None,
        "early_stop_hit": bool(early_stop_callback and early_stop_callback.hit),
        "early_stop_teacher_threshold": early_stop_teacher_threshold,
        "early_stop_one_period_threshold": early_stop_one_period_threshold,
        "early_stop_teacher_sessions": (
            early_stop_callback.hit_teacher_sessions if early_stop_callback else None
        ),
        "early_stop_one_period_sessions": (
            early_stop_callback.hit_one_period_sessions if early_stop_callback else None
        ),
        "early_stop_wall_time_seconds": early_stop_callback.hit_seconds if early_stop_callback else None,
        "first_solution_wall_time_seconds": (
            early_stop_callback.first_solution_seconds if early_stop_callback else None
        ),
        "first_solution_teacher_sessions": (
            early_stop_callback.first_teacher_sessions if early_stop_callback else None
        ),
        "first_solution_one_period_sessions": (
            early_stop_callback.first_one_period_sessions if early_stop_callback else None
        ),
        "solutions_seen": early_stop_callback.solution_count if early_stop_callback else None,
    }
    if minimize_sessions and status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        metrics["objective"] = float(solver.ObjectiveValue())
        metrics["best_bound"] = float(solver.BestObjectiveBound())

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise SessionCpSatNoSolution(f"No CP-SAT session solution found: status={status_name}", metrics)

    allocations: list[SessionAllocation] = []
    for (ai, si), var in n_vars.items():
        count = int(solver.Value(var))
        if count <= 0:
            continue
        assignment = data.assignments[ai]
        allocations.append(
            SessionAllocation(
                class_name=assignment.class_name,
                grade=assignment.grade,
                subject=assignment.subject,
                teacher=assignment.teacher,
                session=sessions[si],
                count=count,
                room=assignment.room,
            )
        )

    materialized_period_lessons: list[dict[str, Any]] = []
    materialized_periods_complete = bool(materialize_period_lessons) and set(
        range(len(sessions))
    ).issubset(period_feasibility_session_indexes)
    if materialized_periods_complete:
        for (ai, si), var in n_vars.items():
            count = int(solver.Value(var))
            if count <= 0:
                continue
            selected = [
                (duration, start, block)
                for duration, start, choice, block in period_block_choices.get((ai, si), [])
                if int(solver.Value(choice)) > 0
            ]
            if len(selected) != 1 or int(selected[0][0]) != count:
                materialized_periods_complete = False
                materialized_period_lessons = []
                break
            _duration, _start, block = selected[0]
            assignment = data.assignments[ai]
            session = sessions[si]
            materialized_period_lessons.extend(
                {
                    "class_name": assignment.class_name,
                    "grade": assignment.grade,
                    "day": int(session.day),
                    "session": str(session.part),
                    "period": int(period),
                    "subject": assignment.subject,
                    "teacher": assignment.teacher,
                    "room": assignment.room,
                }
                for period in block
            )
    metrics["period_bridge_materialized_periods"] = len(materialized_period_lessons)
    metrics["period_bridge_materialization_complete"] = materialized_periods_complete
    if materialized_periods_complete:
        metrics["period_bridge_lessons"] = materialized_period_lessons

    if allow_unassigned:
        unassigned_by_assignment: list[dict[str, Any]] = []
        total_unassigned = 0
        for ai, var in shortfall_vars.items():
            missing = int(solver.Value(var))
            if missing <= 0:
                continue
            assignment = data.assignments[ai]
            total_unassigned += missing
            unassigned_by_assignment.append(
                {
                    "class": assignment.class_name,
                    "grade": assignment.grade,
                    "subject": assignment.subject,
                    "teacher": assignment.teacher,
                    "room": assignment.room,
                    "periods": missing,
                }
            )
        metrics["scheduled_periods"] = sum(item.count for item in allocations)
        metrics["unassigned_periods"] = total_unassigned
        metrics["unassigned_by_assignment"] = unassigned_by_assignment

    teacher_session_load: dict[tuple[str, int], int] = {}
    for allocation in allocations:
        si = sessions.index(allocation.session)
        key = (allocation.teacher, si)
        teacher_session_load[key] = teacher_session_load.get(key, 0) + allocation.count
    for key, fixed_load in fixed_teacher_session_load.items():
        teacher_session_load[key] = teacher_session_load.get(key, 0) + int(fixed_load)
    load_dist: dict[int, int] = {}
    for load in teacher_session_load.values():
        load_dist[load] = load_dist.get(load, 0) + 1
    metrics["teacher_sessions"] = len(teacher_session_load)
    metrics["load_distribution"] = dict(sorted(load_dist.items()))
    metrics["one_period_teacher_sessions"] = int(load_dist.get(1, 0))
    metrics["fixed_lessons"] = len(fixed_lessons)
    metrics["fixed_teacher_sessions"] = len(fixed_teacher_session_load)

    if progress:
        progress(
            {
                "stage": "session_cp_sat:done",
                "message": f"Hoàn tất CP-SAT cấp buổi: {len(teacher_session_load)} buổi giáo viên",
                "teacher_sessions": len(teacher_session_load),
                "load_distribution": metrics["load_distribution"],
            }
        )
    return allocations, metrics
