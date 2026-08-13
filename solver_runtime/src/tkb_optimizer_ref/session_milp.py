from __future__ import annotations

from collections import Counter
from dataclasses import asdict
from pathlib import Path
import json
import time
import warnings
from typing import Any, Callable, Mapping

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix

from .external_milp import solve_milp_with_external_runtime
from .models import Lesson, SchoolData, Session, SessionAllocation
from .rules import (
    TimetableConstraintRules,
    TimetableRuleSet,
    one_session_per_day_mode,
    resolve_rule_set,
)
from .template import (
    LOWER_GRADES,
    all_sessions,
    class_available_periods,
    class_session_capacity_for_constraints,
    teacher_session_capacity,
)


def _suppress_highs_threads_option_warning() -> None:
    warnings.filterwarnings(
        "ignore",
        message=(
            r"Unrecognized options detected: \{'threads'\}\. "
            r"These will be passed to HiGHS verbatim\."
        ),
        category=RuntimeWarning,
    )


_suppress_highs_threads_option_warning()


def _add_sparse_row(
    rows: list[int],
    cols: list[int],
    vals: list[float],
    lower: list[float],
    upper: list[float],
    coeffs: dict[int, float],
    lo: float,
    hi: float,
) -> None:
    r = len(lower)
    for c, v in coeffs.items():
        if abs(v) > 1e-12:
            rows.append(r)
            cols.append(c)
            vals.append(float(v))
    lower.append(float(lo))
    upper.append(float(hi))


def _day_key(day: int) -> str:
    return f"thu{int(day)}"


def _session_key(session: Session) -> str:
    return "sang" if session.part == "AM" else "chieu"


class AssignmentSessionDomainMemo:
    """Memoize immutable assignment/session rule-domain queries for one solve."""

    __slots__ = (
        "constraints",
        "_available_periods",
        "_available_period_sets",
        "_block_allowed",
        "_period_capacity",
        "_session_allowed",
        "_session_cap",
        "_subject_rules",
        "_subject_group_rules",
        "_hits",
        "_misses",
    )

    def __init__(self, constraints: TimetableConstraintRules | None) -> None:
        self.constraints = constraints
        self._available_periods: dict[tuple[Any, Session], list[int]] = {}
        self._available_period_sets: dict[tuple[Any, Session], frozenset[int]] = {}
        self._block_allowed: dict[tuple[Any, Session, int, int], bool] = {}
        self._period_capacity: dict[tuple[Any, Session], int] = {}
        self._session_allowed: dict[tuple[Any, Session], bool] = {}
        self._session_cap: dict[tuple[Any, Session, int], int] = {}
        self._subject_rules: dict[tuple[str, str], Mapping[str, Any]] = {}
        self._subject_group_rules: dict[
            tuple[str, str],
            tuple[tuple[str, Mapping[str, Any]], ...],
        ] = {}
        self._hits: Counter[str] = Counter()
        self._misses: Counter[str] = Counter()

    def _get(self, name: str, cache: dict[Any, Any], key: Any, factory: Callable[[], Any]) -> Any:
        if key in cache:
            self._hits[name] += 1
            return cache[key]
        self._misses[name] += 1
        value = factory()
        cache[key] = value
        return value

    def available_periods(self, assignment: Any, session: Session) -> list[int]:
        key = (assignment, session)
        return self._get(
            "available_periods",
            self._available_periods,
            key,
            lambda: _assignment_available_periods_impl(
                assignment,
                session,
                self.constraints,
            ),
        )

    def block_allowed(
        self,
        assignment: Any,
        session: Session,
        start: int,
        duration: int,
    ) -> bool:
        key = (assignment, session, int(start), int(duration))
        return self._get(
            "block_allowed",
            self._block_allowed,
            key,
            lambda: _assignment_block_allowed_impl(
                assignment,
                session,
                int(start),
                int(duration),
                self.constraints,
                memo=self,
            ),
        )

    def available_period_set(
        self,
        assignment: Any,
        session: Session,
    ) -> frozenset[int]:
        key = (assignment, session)
        return self._get(
            "available_period_sets",
            self._available_period_sets,
            key,
            lambda: frozenset(self.available_periods(assignment, session)),
        )

    def period_capacity(self, assignment: Any, session: Session) -> int:
        key = (assignment, session)
        return self._get(
            "period_capacity",
            self._period_capacity,
            key,
            lambda: _assignment_period_capacity_impl(
                assignment,
                session,
                self.constraints,
                memo=self,
            ),
        )

    def session_allowed(self, assignment: Any, session: Session) -> bool:
        key = (assignment, session)
        return self._get(
            "session_allowed",
            self._session_allowed,
            key,
            lambda: _assignment_session_allowed_impl(
                assignment,
                session,
                self.constraints,
                memo=self,
            ),
        )

    def session_cap(self, assignment: Any, session: Session, base_cap: int) -> int:
        key = (assignment, session, int(base_cap))
        return self._get(
            "session_cap",
            self._session_cap,
            key,
            lambda: _assignment_session_cap_impl(
                assignment,
                session,
                int(base_cap),
                self.constraints,
                memo=self,
            ),
        )

    def subject_rule(self, assignment: Any) -> Mapping[str, Any]:
        key = (str(assignment.class_name), str(assignment.subject))
        return self._get(
            "subject_rules",
            self._subject_rules,
            key,
            lambda: (
                self.constraints.subject_rule_for(*key)
                if self.constraints is not None
                else {}
            ),
        )

    def subject_group_rules(
        self,
        assignment: Any,
    ) -> tuple[tuple[str, Mapping[str, Any]], ...]:
        key = (str(assignment.class_name), str(assignment.subject))
        return self._get(
            "subject_group_rules",
            self._subject_group_rules,
            key,
            lambda: (
                self.constraints.subject_group_rules_for(*key)
                if self.constraints is not None
                else ()
            ),
        )

    def stats(self) -> dict[str, Any]:
        names = (
            "available_periods",
            "available_period_sets",
            "block_allowed",
            "period_capacity",
            "session_allowed",
            "session_cap",
            "subject_rules",
            "subject_group_rules",
        )
        return {
            "hits": {name: int(self._hits[name]) for name in names},
            "misses": {name: int(self._misses[name]) for name in names},
            "entries": {
                "available_periods": len(self._available_periods),
                "available_period_sets": len(self._available_period_sets),
                "block_allowed": len(self._block_allowed),
                "period_capacity": len(self._period_capacity),
                "session_allowed": len(self._session_allowed),
                "session_cap": len(self._session_cap),
                "subject_rules": len(self._subject_rules),
                "subject_group_rules": len(self._subject_group_rules),
            },
        }


def _truthy(value: Any) -> bool:
    return value is True or value in {1, "1", "true", "True", "on", "yes", "YES"}


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def _get_path(obj: Mapping[str, Any] | None, path: str, default: Any = None) -> Any:
    cur: Any = obj or {}
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return default
        cur = cur[part]
    return default if cur is None else cur


def _day_limit_from_rule(rule: Mapping[str, Any], path: str, day: int) -> int:
    raw = _get_path(rule, path, 0)
    if isinstance(raw, Mapping):
        return _to_int(raw.get(_day_key(day)), 0)
    return _to_int(raw, 0)


def _linked_day_avoided(linked: Mapping[str, Any] | None, session_key: str, day_key: str) -> bool:
    if not isinstance(linked, Mapping):
        return False
    checked = _truthy(_get_path(linked, f"{session_key}.{day_key}", False))
    if str(linked.get("mode") or "").lower() == "avoid":
        return checked
    if "enabled" in linked:
        return _truthy(linked.get("enabled")) and not checked
    return checked


def _longest_contiguous_run(periods: list[int]) -> int:
    ordered = sorted(set(periods))
    if not ordered:
        return 0
    best = cur = 1
    for prev, value in zip(ordered, ordered[1:]):
        if value == prev + 1:
            cur += 1
        else:
            best = max(best, cur)
            cur = 1
    return max(best, cur)


def _assignment_available_periods(
    assignment: Any,
    session: Session,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None = None,
) -> list[int]:
    if memo is not None:
        return memo.available_periods(assignment, session)
    return _assignment_available_periods_impl(assignment, session, constraints)


def _assignment_available_periods_impl(
    assignment: Any,
    session: Session,
    constraints: TimetableConstraintRules | None,
) -> list[int]:
    periods = class_available_periods(assignment.grade, assignment.class_name, session, constraints)
    if constraints is None:
        return periods
    return [
        period
        for period in periods
        if not constraints.is_fixed_off("teacher", assignment.teacher, session.day, session.part, period)
        and not constraints.is_fixed_off("subject", assignment.subject, session.day, session.part, period)
        and not constraints.is_subject_group_fixed_off(assignment.subject, session.day, session.part, period)
        and not (assignment.room and constraints.is_fixed_off("room", assignment.room, session.day, session.part, period))
    ]


def _subject_like_block_allowed(
    rule_obj: Mapping[str, Any],
    session: Session,
    start: int,
    duration: int,
) -> bool:
    if duration <= 1 or not rule_obj:
        return True
    session_key = _session_key(session)
    period_key = "morning" if session_key == "sang" else "afternoon"
    covered = set(range(start, start + duration))
    legacy = rule_obj.get("avoidBreakPairs") if isinstance(rule_obj.get("avoidBreakPairs"), Mapping) else {}
    avoid_23 = rule_obj.get("avoidBreakPair23") if isinstance(rule_obj.get("avoidBreakPair23"), Mapping) else {}
    avoid_34 = rule_obj.get("avoidBreakPair34") if isinstance(rule_obj.get("avoidBreakPair34"), Mapping) else {}
    if (_truthy(legacy.get(period_key)) or _truthy(avoid_23.get(period_key))) and {2, 3}.issubset(covered):
        return False
    if (_truthy(legacy.get(period_key)) or _truthy(avoid_34.get(period_key))) and {3, 4}.issubset(covered):
        return False
    linked = rule_obj.get("linkedDays") if isinstance(rule_obj.get("linkedDays"), Mapping) else {}
    if _linked_day_avoided(linked, session_key, _day_key(session.day)):
        return False
    return True


def _assignment_block_allowed(
    assignment: Any,
    session: Session,
    start: int,
    duration: int,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None = None,
) -> bool:
    if memo is not None:
        return memo.block_allowed(assignment, session, start, duration)
    return _assignment_block_allowed_impl(
        assignment,
        session,
        start,
        duration,
        constraints,
        memo=None,
    )


def _assignment_block_allowed_impl(
    assignment: Any,
    session: Session,
    start: int,
    duration: int,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None,
) -> bool:
    if duration <= 0:
        return False
    allowed = (
        memo.available_period_set(assignment, session)
        if memo is not None
        else set(_assignment_available_periods(assignment, session, constraints))
    )
    if not all(period in allowed for period in range(start, start + duration)):
        return False
    if constraints is None:
        return True
    subject_rule = (
        memo.subject_rule(assignment)
        if memo is not None
        else constraints.subject_rule_for(assignment.class_name, assignment.subject)
    )
    if isinstance(subject_rule, Mapping) and not _subject_like_block_allowed(subject_rule, session, start, duration):
        return False
    group_rules = (
        memo.subject_group_rules(assignment)
        if memo is not None
        else constraints.subject_group_rules_for(
            assignment.class_name,
            assignment.subject,
        )
    )
    for _group_id, group_rule in group_rules:
        if isinstance(group_rule, Mapping) and not _subject_like_block_allowed(group_rule, session, start, duration):
            return False
    return True


def _assignment_period_capacity(
    assignment: Any,
    session: Session,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None = None,
) -> int:
    if memo is not None:
        return memo.period_capacity(assignment, session)
    return _assignment_period_capacity_impl(
        assignment,
        session,
        constraints,
        memo=None,
    )


def _assignment_period_capacity_impl(
    assignment: Any,
    session: Session,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None,
) -> int:
    allowed = _assignment_available_periods(
        assignment,
        session,
        constraints,
        memo=memo,
    )
    if not allowed:
        return 0
    best = 0
    max_period = max(allowed)
    for start in allowed:
        for duration in range(1, max_period - start + 2):
            if _assignment_block_allowed(
                assignment,
                session,
                start,
                duration,
                constraints,
                memo=memo,
            ):
                best = max(best, duration)
    return best


def _teacher_session_period_capacity(
    data: SchoolData,
    teacher: str,
    session: Session,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None = None,
) -> int:
    periods: set[int] = set()
    for assignment in data.assignments:
        if assignment.teacher != teacher:
            continue
        if not _assignment_session_allowed(
            assignment,
            session,
            constraints,
            memo=memo,
        ):
            continue
        periods.update(
            _assignment_available_periods(
                assignment,
                session,
                constraints,
                memo=memo,
            )
        )
    if not periods:
        return 0
    return min(teacher_session_capacity(session), len(periods))


def _assignment_session_allowed(
    assignment: Any,
    session: Session,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None = None,
) -> bool:
    if memo is not None:
        return memo.session_allowed(assignment, session)
    return _assignment_session_allowed_impl(
        assignment,
        session,
        constraints,
        memo=None,
    )


def _assignment_session_allowed_impl(
    assignment: Any,
    session: Session,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None,
) -> bool:
    if constraints is None:
        return True
    session_key = _session_key(session)
    subject_rule = (
        memo.subject_rule(assignment)
        if memo is not None
        else constraints.subject_rule_for(assignment.class_name, assignment.subject)
    )
    allowed = subject_rule.get("sessionAllowed") if isinstance(subject_rule, Mapping) else None
    if isinstance(allowed, Mapping):
        if session_key == "sang" and allowed.get("allowMorning") is False:
            return False
        if session_key == "chieu" and allowed.get("allowAfternoon") is False:
            return False
    group_rules = (
        memo.subject_group_rules(assignment)
        if memo is not None
        else constraints.subject_group_rules_for(
            assignment.class_name,
            assignment.subject,
        )
    )
    for _group_id, group_rule in group_rules:
        allowed = group_rule.get("sessionAllowed") if isinstance(group_rule, Mapping) else None
        if not isinstance(allowed, Mapping):
            continue
        if session_key == "sang" and allowed.get("allowMorning") is False:
            return False
        if session_key == "chieu" and allowed.get("allowAfternoon") is False:
            return False
    return True


def _assignment_session_cap(
    assignment: Any,
    session: Session,
    base_cap: int,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None = None,
) -> int:
    if memo is not None:
        return memo.session_cap(assignment, session, base_cap)
    return _assignment_session_cap_impl(
        assignment,
        session,
        base_cap,
        constraints,
        memo=None,
    )


def _assignment_session_cap_impl(
    assignment: Any,
    session: Session,
    base_cap: int,
    constraints: TimetableConstraintRules | None,
    *,
    memo: AssignmentSessionDomainMemo | None,
) -> int:
    if constraints is None:
        return base_cap
    session_key = _session_key(session)
    cap = min(
        base_cap,
        _assignment_period_capacity(
            assignment,
            session,
            constraints,
            memo=memo,
        ),
    )
    subject_rule = (
        memo.subject_rule(assignment)
        if memo is not None
        else constraints.subject_rule_for(assignment.class_name, assignment.subject)
    )
    subject_cap = _to_int(_get_path(subject_rule, f"maxPeriods.{session_key}", 0), 0)
    if subject_cap > 0:
        cap = min(cap, subject_cap)
    group_rules = (
        memo.subject_group_rules(assignment)
        if memo is not None
        else constraints.subject_group_rules_for(
            assignment.class_name,
            assignment.subject,
        )
    )
    for _group_id, group_rule in group_rules:
        group_cap = _to_int(_get_path(group_rule, f"maxPeriods.{session_key}", 0), 0)
        if group_cap > 0:
            cap = min(cap, group_cap)
    teacher_rule = constraints.teacher.get(assignment.teacher, {})
    mpc = teacher_rule.get("maxPeriodsClass", {}) if isinstance(teacher_rule, Mapping) else {}
    if isinstance(mpc, Mapping):
        rules_to_check: list[Mapping[str, Any]] = []
        by_group = mpc.get("bySubjectGroup")
        if isinstance(by_group, Mapping):
            for group_id, conf in by_group.items():
                if not isinstance(conf, Mapping):
                    continue
                if str(group_id) in {"__all__", "all"} or constraints.subject_in_group(assignment.subject, str(group_id)):
                    rules_to_check.append(conf)
        if not rules_to_check:
            rules_to_check.append(mpc)
        for conf in rules_to_check:
            per_session = _to_int(conf.get("perSession"), 0)
            if per_session > 0:
                cap = min(cap, per_session)
    return max(0, cap)


def solve_session_allocation(
    data: SchoolData,
    *,
    rules: TimetableRuleSet | None = None,
    fixed_lessons: list[Lesson] | None = None,
    max_teacher_sessions: int | None = 200,
    minimize_sessions: bool = False,
    forbidden_session_vectors: list[tuple[int, dict[int, int]]] | None = None,
    time_limit_seconds: int = 60,
    verbose: bool = True,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[list[SessionAllocation], dict[str, Any]]:
    """Solve the half-day compaction model.

    Variables:
    - n[a, s] integer: number of periods of assignment a in session s.
    - z[t, s] binary: teacher t is present in session s.
    - q[a] binary helper for Wednesday PM period-3 feasibility for grades 8/9.

    Hard constraints:
    - Every class-subject-teacher assignment gets exactly its weekly period count.
    - Every class session is completely filled according to the fixed student frame.
    - Teacher load is at most 4 in AM and 3 in PM.
    - One-period teacher sessions are allowed when unavoidable and reported by metrics.
    - Grade+subject max-periods-per-session from tietchuan.xlsx is respected.
    - Wednesday PM bridge constraints ensure period 3 is usable only by upper grades.

    For the supplied dataset, cap search starts from 200 and keeps lowering the
    cap while feasible, then the period allocator places concrete periods with
    contiguous multi-period blocks.
    """

    rule_set = resolve_rule_set(rules)
    constraints = rule_set.constraints
    constraints_active = constraints is not None and constraints.active
    sessions = all_sessions()
    session_keys = [s.key for s in sessions]
    session_by_key = {(session.day, session.part): si for si, session in enumerate(sessions)}
    fixed_lessons = list(fixed_lessons or [])
    fixed_teacher_session_load: Counter[tuple[str, int]] = Counter()
    fixed_teacher_day_load: Counter[tuple[str, int]] = Counter()
    fixed_class_session_load: Counter[tuple[str, int]] = Counter()
    fixed_assignment_session_load: Counter[tuple[str, str, str, int]] = Counter()
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
        fixed_teacher_class_session_load[(lesson.teacher, lesson.class_name, si)] += 1
        fixed_teacher_class_day_load[(lesson.teacher, lesson.class_name, int(lesson.day))] += 1
        fixed_teacher_session_periods.setdefault((lesson.teacher, si), set()).add(int(lesson.period))

    n_vars: dict[tuple[int, int], int] = {}
    n_index: list[tuple[int, int]] = []
    n_caps: dict[tuple[int, int], int] = {}
    for ai, assignment in enumerate(data.assignments):
        for si, session in enumerate(sessions):
            class_cap = class_session_capacity_for_constraints(assignment.grade, assignment.class_name, session, constraints)
            fixed_assignment_load = int(
                fixed_assignment_session_load.get(
                    (assignment.class_name, assignment.subject, assignment.teacher, si),
                    0,
                )
            )
            base_cap = min(
                assignment.periods_per_week,
                max(0, int(assignment.max_periods_per_session) - fixed_assignment_load),
                class_cap,
                _teacher_session_period_capacity(data, assignment.teacher, session, constraints),
            )
            cap = _assignment_session_cap(assignment, session, base_cap, constraints)
            if cap > 0 and _assignment_session_allowed(assignment, session, constraints):
                n_vars[(ai, si)] = len(n_index)
                n_index.append((ai, si))
                n_caps[(ai, si)] = cap

    z_start = len(n_index)
    z_vars: dict[tuple[str, int], int] = {}
    for teacher in data.teachers:
        for si, _session in enumerate(sessions):
            z_vars[(teacher, si)] = z_start + len(z_vars)

    c_start = z_start + len(z_vars)
    c_vars: dict[tuple[str, int], int] = {}
    for class_info in data.classes:
        for si, _session in enumerate(sessions):
            c_vars[(class_info.name, si)] = c_start + len(c_vars)

    d_start = c_start + len(c_vars)
    d_vars: dict[tuple[str, int], int] = {}
    if constraints_active:
        for teacher in data.teachers:
            for day in sorted({s.day for s in sessions}):
                d_vars[(teacher, day)] = d_start + len(d_vars)

    u_start = d_start + len(d_vars)
    u_vars: dict[tuple[int, int], int] = {}
    if constraints_active:
        for key in n_vars:
            u_vars[key] = u_start + len(u_vars)

    # Wednesday PM period-3 bridge variables. day=4 -> zero-based key (2, 1).
    wpm_si = next(i for i, s in enumerate(sessions) if s.day == 4 and s.part == "PM")
    wpm_session = sessions[wpm_si]
    q_start = u_start + len(u_vars)
    q_vars: dict[int, int] = {}
    for ai, assignment in enumerate(data.assignments):
        if assignment.grade not in LOWER_GRADES and (ai, wpm_si) in n_vars:
            q_vars[ai] = q_start + len(q_vars)

    same_day_subject_start = q_start + len(q_vars)
    same_day_subject_vars: dict[tuple[str, str, str, int], int] = {}
    if constraints_active and constraints is not None:
        assignment_subjects = {
            (assignment.class_name, assignment.subject)
            for assignment in data.assignments
        }
        for class_name, groups in (constraints.subject_no_same_day or {}).items():
            if not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                if len(subjects) < 2:
                    continue
                for subject in sorted(set(subjects)):
                    if (class_name, subject) not in assignment_subjects:
                        continue
                    for day in sorted({s.day for s in sessions}):
                        same_day_subject_vars[(class_name, str(group_id), subject, day)] = (
                            same_day_subject_start + len(same_day_subject_vars)
                        )

    forbidden_session_vectors = list(forbidden_session_vectors or [])
    cut_direction_start = same_day_subject_start + len(same_day_subject_vars)
    cut_direction_vars: list[tuple[int, int, int, int, int]] = []
    cut_direction_groups: list[list[tuple[int, int]]] = []
    for si, counts_by_assignment in forbidden_session_vectors:
        group: list[tuple[int, int]] = []
        redundant = False
        for ai, value in sorted(counts_by_assignment.items()):
            key = (int(ai), int(si))
            if key not in n_vars:
                if int(value) != 0:
                    redundant = True
                    break
                continue
            cap = int(n_caps[key])
            target = int(value)
            if target < 0 or target > cap:
                redundant = True
                break
            less_var = cut_direction_start + len(cut_direction_vars) * 2
            greater_var = less_var + 1
            cut_direction_vars.append((n_vars[key], target, cap, less_var, greater_var))
            group.append((less_var, greater_var))
        if redundant:
            # The forbidden vector is already outside this MILP's domain.
            for _ in range(len(group)):
                cut_direction_vars.pop()
            continue
        if group:
            cut_direction_groups.append(group)

    n_total = cut_direction_start + len(cut_direction_vars) * 2
    rows: list[int] = []
    cols: list[int] = []
    vals: list[float] = []
    lb: list[float] = []
    ub: list[float] = []

    def add(coeffs: dict[int, float], lo: float, hi: float) -> None:
        _add_sparse_row(rows, cols, vals, lb, ub, coeffs, lo, hi)

    cut_var_index = 0
    for group in cut_direction_groups:
        for less_var, greater_var in group:
            n_var, target, cap, expected_less, expected_greater = cut_direction_vars[cut_var_index]
            cut_var_index += 1
            if (less_var, greater_var) != (expected_less, expected_greater):
                raise RuntimeError("Forbidden session vector variable mapping is inconsistent")
            big_m = cap + 1
            # less=1 forces n <= target-1; greater=1 forces n >= target+1.
            add({n_var: 1, less_var: big_m}, -np.inf, target - 1 + big_m)
            add({n_var: 1, greater_var: -big_m}, target + 1 - big_m, np.inf)
            add({less_var: 1, greater_var: 1}, 0, 1)
        add(
            {
                direction_var: 1
                for pair in group
                for direction_var in pair
            },
            1,
            np.inf,
        )

    # Assignment exact weekly periods.
    for ai, assignment in enumerate(data.assignments):
        add({n_vars[(ai, si)]: 1 for si in range(len(sessions)) if (ai, si) in n_vars}, assignment.periods_per_week, assignment.periods_per_week)

    # Class sessions may be empty. If occupied, use any period that remains
    # available after fixed-off cells; capacity-short timetables may need a
    # single placed period in a session.
    for class_info in data.classes:
        for si, session in enumerate(sessions):
            cap = class_session_capacity_for_constraints(class_info.grade, class_info.name, session, constraints)
            if cap <= 0:
                continue
            cv = c_vars[(class_info.name, si)]
            coeff: dict[int, float] = {}
            for ai, assignment in enumerate(data.assignments):
                if assignment.class_name == class_info.name and (ai, si) in n_vars:
                    coeff[n_vars[(ai, si)]] = 1
            fixed_load = int(fixed_class_session_load.get((class_info.name, si), 0))
            if not coeff:
                add({cv: 1}, 1 if fixed_load > 0 else 0, 1 if fixed_load > 0 else 0)
                continue
            # ``cap`` already excludes every fixed/off period, including the
            # hard lesson slots added by the adapter.  The variables represent
            # residual demand, so adding ``fixed_load`` to this capacity row
            # would subtract the same lesson twice on a zero-slack timetable.
            add({**coeff, cv: -cap}, -np.inf, 0)
            if fixed_load > 0:
                add({cv: 1}, 1, 1)
            add({**coeff, cv: -1}, -fixed_load, np.inf)

    # Teacher load <= cap*z. One-period teacher sessions are allowed when
    # unavoidable and are reported by validation metrics.
    for teacher in data.teachers:
        for si, session in enumerate(sessions):
            session_cap = _teacher_session_period_capacity(data, teacher, session, constraints)
            coeff_upper = {z_vars[(teacher, si)]: -session_cap}
            coeff_lower = {z_vars[(teacher, si)]: -1}
            has_assignment = False
            for ai, assignment in enumerate(data.assignments):
                if assignment.teacher == teacher and (ai, si) in n_vars:
                    idx = n_vars[(ai, si)]
                    coeff_upper[idx] = coeff_upper.get(idx, 0) + 1
                    coeff_lower[idx] = coeff_lower.get(idx, 0) + 1
                    has_assignment = True
            fixed_load = int(fixed_teacher_session_load.get((teacher, si), 0))
            # As with class capacity, ``session_cap`` is residual capacity after
            # fixed/off slots.  Fixed lessons still force z=1 and participate in
            # day/session-count limits, but must not reduce residual capacity a
            # second time.
            add(coeff_upper, -np.inf, 0)
            if fixed_load > 0:
                add({z_vars[(teacher, si)]: 1}, 1, 1)
            if has_assignment or fixed_load > 0:
                add(coeff_lower, -fixed_load, np.inf)
            else:
                add({z_vars[(teacher, si)]: 1}, 0, 0)

    if constraints_active and constraints is not None:
        # Link assignment/session occupancy helpers and teacher/day helpers.
        for (ai, si), uv in u_vars.items():
            assignment = data.assignments[ai]
            session = sessions[si]
            cap = n_caps[(ai, si)]
            nv = n_vars[(ai, si)]
            add({nv: 1, uv: -cap}, -np.inf, 0)
            add({nv: 1, uv: -1}, 0, np.inf)

        for teacher in data.teachers:
            for si, session in enumerate(sessions):
                add({z_vars[(teacher, si)]: 1, d_vars[(teacher, session.day)]: -1}, -np.inf, 0)

        # Teacher-level limits from the original constraint UI.
        for teacher in data.teachers:
            rule = constraints.teacher.get(teacher, {})
            if not isinstance(rule, Mapping):
                rule = {}
            max_days = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
            if max_days > 0:
                add({d_vars[(teacher, day)]: 1 for day in sorted({s.day for s in sessions})}, 0, max_days)
            max_sessions = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
            if max_sessions > 0:
                add({z_vars[(teacher, si)]: 1 for si in range(len(sessions))}, 0, max_sessions)
            max_morning = _to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0)
            if max_morning > 0:
                add({z_vars[(teacher, si)]: 1 for si, s in enumerate(sessions) if s.part == "AM"}, 0, max_morning)
            max_afternoon = _to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0)
            if max_afternoon > 0:
                add({z_vars[(teacher, si)]: 1 for si, s in enumerate(sessions) if s.part == "PM"}, 0, max_afternoon)

            for si, session in enumerate(sessions):
                required_periods = constraints.teacher_must_teach_periods(teacher, session.day, session.part)
                if not required_periods:
                    continue
                coeff = {
                    n_vars[(ai, si)]: 1
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.teacher == teacher and (ai, si) in n_vars
                }
                fixed_required = sum(
                    1
                    for period in required_periods
                    if int(period) in fixed_teacher_session_periods.get((teacher, si), set())
                )
                remaining_required = max(0, len(required_periods) - fixed_required)
                if remaining_required > 0:
                    add(coeff, remaining_required, np.inf)

            for day in sorted({s.day for s in sessions}):
                dk = _day_key(day)
                sis = [si for si, s in enumerate(sessions) if s.day == day]
                session_mode = one_session_per_day_mode(
                    _get_path(rule, f"oneSessionPerDay.{dk}", False)
                )
                if session_mode == "morning":
                    add(
                        {
                            z_vars[(teacher, si)]: 1
                            for si in sis
                            if sessions[si].part == "PM"
                        },
                        0,
                        0,
                    )
                elif session_mode == "afternoon":
                    add(
                        {
                            z_vars[(teacher, si)]: 1
                            for si in sis
                            if sessions[si].part == "AM"
                        },
                        0,
                        0,
                    )
                elif session_mode == "either":
                    add({z_vars[(teacher, si)]: 1 for si in sis}, 0, 1)

                day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{dk}", 0), 0)
                if day_limit > 0:
                    coeff: dict[int, float] = {}
                    for ai, assignment in enumerate(data.assignments):
                        if assignment.teacher != teacher:
                            continue
                        for si in sis:
                            if (ai, si) in n_vars:
                                coeff[n_vars[(ai, si)]] = 1
                    fixed_load = int(fixed_teacher_day_load.get((teacher, day), 0))
                    add(coeff, 0, day_limit - fixed_load)

            for si, session in enumerate(sessions):
                sk = _session_key(session)
                dk = _day_key(session.day)
                limit = _to_int(_get_path(rule, f"maxPeriods.{sk}.{dk}", 0), 0)
                if limit <= 0:
                    continue
                coeff = {
                    n_vars[(ai, si)]: 1
                    for ai, assignment in enumerate(data.assignments)
                    if assignment.teacher == teacher and (ai, si) in n_vars
                }
                fixed_load = int(fixed_teacher_session_load.get((teacher, si), 0))
                add(coeff, 0, limit - fixed_load)

        # Teacher/class/subject-group aggregate limits.
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
                    def matches(a: Any) -> bool:
                        return (
                            a.teacher == teacher
                            and a.class_name == class_info.name
                            and (group_id in {"__all__", "all"} or constraints.subject_in_group(a.subject, group_id))
                        )

                    for si, session in enumerate(sessions):
                        if per_session > 0:
                            coeff = {
                                n_vars[(ai, si)]: 1
                                for ai, assignment in enumerate(data.assignments)
                                if matches(assignment) and (ai, si) in n_vars
                            }
                            fixed_load = int(
                                fixed_teacher_class_session_load.get(
                                    (teacher, class_info.name, si),
                                    0,
                                )
                            )
                            add(coeff, 0, per_session - fixed_load)
                    if per_day > 0:
                        for day in sorted({s.day for s in sessions}):
                            sis = [si for si, s in enumerate(sessions) if s.day == day]
                            coeff = {
                                n_vars[(ai, si)]: 1
                                for ai, assignment in enumerate(data.assignments)
                                if matches(assignment)
                                for si in sis
                                if (ai, si) in n_vars
                            }
                            fixed_load = int(
                                fixed_teacher_class_day_load.get(
                                    (teacher, class_info.name, day),
                                    0,
                                )
                            )
                            add(coeff, 0, per_day - fixed_load)

        # Subject and subject-group limits by class.
        for ai, assignment in enumerate(data.assignments):
            subject_rule = constraints.subject_rule_for(assignment.class_name, assignment.subject)
            rule_sets: list[tuple[str, Mapping[str, Any], Callable[[Any], bool]]] = [
                ("subject", subject_rule, lambda a, assignment=assignment: a.class_name == assignment.class_name and a.subject == assignment.subject)
            ]
            for group_id, group_rule in constraints.subject_group_rules_for(assignment.class_name, assignment.subject):
                rule_sets.append(
                    (
                        f"subjectGroup:{group_id}",
                        group_rule,
                        lambda a, group_id=group_id, assignment=assignment: a.class_name == assignment.class_name
                        and constraints.subject_in_group(a.subject, group_id),
                    )
                )

            for _scope, rule_obj, matcher in rule_sets:
                if not isinstance(rule_obj, Mapping) or not rule_obj:
                    continue
                morning_week = _to_int(_get_path(rule_obj, "weeklySessionPeriods.morning", 0), 0)
                if morning_week > 0:
                    coeff = {
                        n_vars[(bi, si)]: 1
                        for bi, candidate in enumerate(data.assignments)
                        if matcher(candidate)
                        for si, s in enumerate(sessions)
                        if s.part == "AM" and (bi, si) in n_vars
                    }
                    add(coeff, 0, morning_week)
                afternoon_week = _to_int(_get_path(rule_obj, "weeklySessionPeriods.afternoon", 0), 0)
                if afternoon_week > 0:
                    coeff = {
                        n_vars[(bi, si)]: 1
                        for bi, candidate in enumerate(data.assignments)
                        if matcher(candidate)
                        for si, s in enumerate(sessions)
                        if s.part == "PM" and (bi, si) in n_vars
                    }
                    add(coeff, 0, afternoon_week)
                max_morning_sessions = _to_int(_get_path(rule_obj, "maxSessions.morning", 0), 0)
                if max_morning_sessions > 0:
                    coeff = {
                        u_vars[(bi, si)]: 1
                        for bi, candidate in enumerate(data.assignments)
                        if matcher(candidate)
                        for si, s in enumerate(sessions)
                        if s.part == "AM" and (bi, si) in u_vars
                    }
                    add(coeff, 0, max_morning_sessions)
                max_afternoon_sessions = _to_int(_get_path(rule_obj, "maxSessions.afternoon", 0), 0)
                if max_afternoon_sessions > 0:
                    coeff = {
                        u_vars[(bi, si)]: 1
                        for bi, candidate in enumerate(data.assignments)
                        if matcher(candidate)
                        for si, s in enumerate(sessions)
                        if s.part == "PM" and (bi, si) in u_vars
                    }
                    add(coeff, 0, max_afternoon_sessions)
                max_all_sessions = _to_int(_get_path(rule_obj, "maxSessions.day", 0), 0)
                if max_all_sessions > 0:
                    coeff = {
                        u_vars[(bi, si)]: 1
                        for bi, candidate in enumerate(data.assignments)
                        if matcher(candidate)
                        for si in range(len(sessions))
                        if (bi, si) in u_vars
                    }
                    add(coeff, 0, max_all_sessions)

                if _truthy(_get_path(rule_obj, "sessionAllowed.oneSessionPerDay", False)):
                    for day in sorted({s.day for s in sessions}):
                        sis = [si for si, s in enumerate(sessions) if s.day == day]
                        coeff = {
                            u_vars[(bi, si)]: 1
                            for bi, candidate in enumerate(data.assignments)
                            if matcher(candidate)
                            for si in sis
                            if (bi, si) in u_vars
                        }
                        add(coeff, 0, 1)

                spacing = _to_int(_get_path(rule_obj, "spacingDays.days", 0), 0)
                if spacing > 0 and _scope == "subject":
                    day_values = sorted({s.day for s in sessions})
                    for i, left_day in enumerate(day_values):
                        for right_day in day_values[i + 1 :]:
                            if right_day - left_day > spacing:
                                continue
                            coeff = {
                                u_vars[(bi, si)]: 1
                                for bi, candidate in enumerate(data.assignments)
                                if matcher(candidate)
                                for si, s in enumerate(sessions)
                                if s.day in {left_day, right_day} and (bi, si) in u_vars
                            }
                            add(coeff, 0, 1)

                for day in sorted({s.day for s in sessions}):
                    dk_sis = [si for si, s in enumerate(sessions) if s.day == day]
                    day_limit = _day_limit_from_rule(rule_obj, "maxPeriods.day", day)
                    if day_limit > 0:
                        coeff = {
                            n_vars[(bi, si)]: 1
                            for bi, candidate in enumerate(data.assignments)
                            if matcher(candidate)
                            for si in dk_sis
                            if (bi, si) in n_vars
                        }
                        add(coeff, 0, day_limit)

        for class_name, groups in (constraints.subject_no_same_session or {}).items():
            if not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                if len(subjects) < 2:
                    continue
                subject_set = set(subjects)
                for si, _session in enumerate(sessions):
                    coeff = {
                        u_vars[(ai, si)]: 1
                        for ai, assignment in enumerate(data.assignments)
                        if assignment.class_name == class_name
                        and assignment.subject in subject_set
                        and (ai, si) in u_vars
                    }
                    add(coeff, 0, 1)

        for (class_name, group_id, subject, day), active_var in same_day_subject_vars.items():
            terms = {
                u_vars[(ai, si)]: 1
                for ai, assignment in enumerate(data.assignments)
                if assignment.class_name == class_name
                and assignment.subject == subject
                for si, session in enumerate(sessions)
                if session.day == day and (ai, si) in u_vars
            }
            for term in terms:
                add({term: 1, active_var: -1}, -np.inf, 0)
            add({active_var: 1, **{term: -1 for term in terms}}, -np.inf, 0)

        for class_name, groups in (constraints.subject_no_same_day or {}).items():
            if not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                if len(subjects) < 2:
                    continue
                for day in sorted({s.day for s in sessions}):
                    coeff = {
                        same_day_subject_vars[(class_name, str(group_id), subject, day)]: 1
                        for subject in sorted(set(subjects))
                        if (class_name, str(group_id), subject, day) in same_day_subject_vars
                    }
                    add(coeff, 0, 1)

    # Wednesday PM bridge constraints.
    for ai, qv in q_vars.items():
        add({qv: 1, n_vars[(ai, wpm_si)]: -1}, -np.inf, 0)

    for class_info in data.classes:
        if class_info.grade in LOWER_GRADES:
            continue
        if 3 not in class_available_periods(class_info.grade, class_info.name, wpm_session, constraints):
            continue
        coeff: dict[int, float] = {}
        for ai, assignment in enumerate(data.assignments):
            if assignment.class_name == class_info.name and ai in q_vars:
                coeff[q_vars[ai]] = 1
        add(coeff, 1, 1)

    for teacher in data.teachers:
        coeff = {q_vars[ai]: 1 for ai, assignment in enumerate(data.assignments) if assignment.teacher == teacher and ai in q_vars}
        if coeff:
            add(coeff, 0, 1)

    for teacher in data.teachers:
        coeff: dict[int, float] = {}
        for ai, assignment in enumerate(data.assignments):
            if assignment.teacher == teacher and (ai, wpm_si) in n_vars:
                coeff[n_vars[(ai, wpm_si)]] = coeff.get(n_vars[(ai, wpm_si)], 0) + 1
            if assignment.teacher == teacher and ai in q_vars:
                coeff[q_vars[ai]] = coeff.get(q_vars[ai], 0) - 1
        if coeff:
            add(coeff, 0, 2)

    if max_teacher_sessions is not None:
        add({v: 1 for v in z_vars.values()}, 0, max_teacher_sessions)

    lower_bounds = np.zeros(n_total)
    upper_bounds = np.ones(n_total)
    for vid, (ai, si) in enumerate(n_index):
        assignment = data.assignments[ai]
        session = sessions[si]
        upper_bounds[vid] = n_caps[(ai, si)]

    A = coo_matrix((vals, (rows, cols)), shape=(len(lb), n_total)).tocsr()
    c = np.zeros(n_total)
    if minimize_sessions:
        for v in z_vars.values():
            c[v] = 1.0

    if verbose:
        print(
            "session MILP:",
            f"vars={n_total}",
            f"n={len(n_index)}",
            f"z={len(z_vars)}",
            f"d={len(d_vars)}",
            f"u={len(u_vars)}",
            f"q={len(q_vars)}",
            f"cuts={len(cut_direction_groups)}",
            f"rows={len(lb)}",
            f"nnz={len(vals)}",
            f"max_teacher_sessions={max_teacher_sessions}",
            f"minimize={minimize_sessions}",
            flush=True,
        )
    if progress:
        progress(
            {
                "stage": "session:model",
                "message": "Dựng mô hình MILP cấp buổi",
                "vars": n_total,
                "assignment_vars": len(n_index),
                "teacher_session_vars": len(z_vars),
                "teacher_day_vars": len(d_vars),
                "assignment_session_vars": len(u_vars),
                "bridge_vars": len(q_vars),
                "forbidden_session_vectors": len(cut_direction_groups),
                "rows": len(lb),
                "non_zero": len(vals),
                "max_teacher_sessions": max_teacher_sessions,
                "time_limit_seconds": time_limit_seconds,
            }
        )

    start = time.time()
    if progress:
        progress(
            {
                "stage": "session:solve",
                "message": f"Giải MILP cấp buổi với cap {max_teacher_sessions}",
                "time_limit_seconds": time_limit_seconds,
                "minimize_sessions": minimize_sessions,
            }
        )
    _suppress_highs_threads_option_warning()
    integrality = np.ones(n_total, dtype=int)
    constraint_lower = np.array(lb)
    constraint_upper = np.array(ub)
    result = solve_milp_with_external_runtime(
        c,
        integrality,
        lower_bounds,
        upper_bounds,
        A,
        constraint_lower,
        constraint_upper,
        time_limit_seconds=time_limit_seconds,
        threads=1,
        mip_rel_gap=0.0,
    )
    if result is None:
        result = milp(
            c,
            integrality=integrality,
            bounds=Bounds(lower_bounds, upper_bounds),
            constraints=LinearConstraint(A, constraint_lower, constraint_upper),
            options={
                "time_limit": time_limit_seconds,
                "mip_rel_gap": 0.0,
                "disp": verbose,
                "threads": 1,
            },
        )

    if result.x is None:
        if progress:
            progress(
                {
                    "stage": "session:error",
                    "message": "Không tìm được nghiệm cấp buổi",
                    "status": int(result.status),
                    "solver_message": str(result.message),
                }
            )
        raise RuntimeError(f"No session solution found: status={result.status}, message={result.message}")

    x = result.x
    fractional_count = sum(1 for value in x if abs(float(value) - round(float(value))) > 1e-5)
    if fractional_count:
        if progress:
            progress(
                {
                    "stage": "session:error",
                    "message": "Nghiệm MILP cấp buổi chưa nguyên nên không dùng để xếp tiết.",
                    "status": int(result.status),
                    "solver_message": str(result.message),
                    "fractional_vars": fractional_count,
                }
            )
        raise RuntimeError(
            "No complete integral session solution found: "
            f"status={result.status}, message={result.message}, fractional_vars={fractional_count}"
        )

    allocations: list[SessionAllocation] = []
    for vid, (ai, si) in enumerate(n_index):
        count = int(round(float(x[vid])))
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

    expected_by_assignment = {
        (item.class_name, item.subject, item.teacher): int(item.periods_per_week)
        for item in data.assignments
    }
    actual_by_assignment: dict[tuple[str, str, str], int] = {}
    for item in allocations:
        key = (item.class_name, item.subject, item.teacher)
        actual_by_assignment[key] = actual_by_assignment.get(key, 0) + int(item.count)
    incomplete = [
        {
            "class": key[0],
            "subject": key[1],
            "teacher": key[2],
            "expected": expected,
            "actual": actual_by_assignment.get(key, 0),
        }
        for key, expected in expected_by_assignment.items()
        if actual_by_assignment.get(key, 0) != expected
    ]
    expected_periods = sum(expected_by_assignment.values())
    allocated_periods = sum(int(item.count) for item in allocations)
    if incomplete or allocated_periods != expected_periods:
        if progress:
            progress(
                {
                    "stage": "session:error",
                    "message": "Nghiệm MILP cấp buổi chưa phân đủ số tiết nên không dùng để xếp tiết.",
                    "status": int(result.status),
                    "solver_message": str(result.message),
                    "allocated_periods": allocated_periods,
                    "expected_periods": expected_periods,
                    "incomplete_assignments": len(incomplete),
                }
            )
        sample = incomplete[:5]
        raise RuntimeError(
            "No complete session solution found: "
            f"status={result.status}, message={result.message}, "
            f"allocated_periods={allocated_periods}, expected_periods={expected_periods}, "
            f"incomplete_assignments={len(incomplete)}, sample={sample}"
        )

    teacher_session_load: dict[tuple[str, int], int] = dict(fixed_teacher_session_load)
    for item in allocations:
        si = sessions.index(item.session)
        key = (item.teacher, si)
        teacher_session_load[key] = teacher_session_load.get(key, 0) + item.count

    load_dist: dict[int, int] = {}
    for load in teacher_session_load.values():
        load_dist[load] = load_dist.get(load, 0) + 1

    metrics: dict[str, Any] = {
        "status": int(result.status),
        "message": str(result.message),
        "objective": None if result.fun is None else float(result.fun),
        "runtime_seconds": time.time() - start,
        "teacher_sessions": len(teacher_session_load),
        "load_distribution": dict(sorted(load_dist.items())),
        "solver_z_count": sum(1 for v in z_vars.values() if x[v] > 0.5),
        "fixed_lessons": len(fixed_lessons),
        "fixed_teacher_sessions": len(fixed_teacher_session_load),
        "session_keys": session_keys,
        "forbidden_session_vectors": len(cut_direction_groups),
    }
    if progress:
        progress(
            {
                "stage": "session:done",
                "message": f"Hoàn tất cấp buổi: {len(teacher_session_load)} buổi giáo viên",
                "runtime_seconds": metrics["runtime_seconds"],
                "teacher_sessions": metrics["teacher_sessions"],
                "load_distribution": metrics["load_distribution"],
            }
        )
    return allocations, metrics


def solve_session_allocation_with_cap_search(
    data: SchoolData,
    *,
    rules: TimetableRuleSet | None = None,
    max_teacher_sessions: int = 200,
    min_teacher_sessions: int | None = None,
    time_limit_seconds_per_cap: int = 60,
    remaining_time_seconds: Callable[[], float | None] | None = None,
    reserve_seconds: float = 15.0,
    verbose: bool = True,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[list[SessionAllocation], dict[str, Any]]:
    """Find a compact feasible session allocation by lowering the cap.

    The objective-based MILP can spend a long time proving optimality. Cap
    search keeps feasibility solves fast and produces the lowest cap found
    within the configured per-cap time limit.
    """

    best_allocations: list[SessionAllocation] | None = None
    best_metrics: dict[str, Any] | None = None
    attempts: list[dict[str, Any]] = []
    cap = max_teacher_sessions
    expanded_from_infeasible_cap = False

    while min_teacher_sessions is None or cap >= min_teacher_sessions:
        attempt_time_limit = max(1, int(time_limit_seconds_per_cap or 1))
        if remaining_time_seconds is not None:
            remaining = remaining_time_seconds()
            if remaining is not None:
                usable = int(remaining - reserve_seconds)
                if usable <= 0:
                    attempts.append(
                        {
                            "cap": cap,
                            "ok": False,
                            "stopped": "deadline_reserve",
                            "remaining_seconds": round(float(remaining), 3),
                            "reserve_seconds": reserve_seconds,
                        }
                    )
                    if best_allocations is not None:
                        break
                    usable = 1
                attempt_time_limit = max(1, min(attempt_time_limit, usable))
        if verbose:
            print(f"session cap search: trying max_teacher_sessions={cap}", flush=True)
        if progress:
            progress(
                {
                    "stage": "session:cap_attempt",
                    "message": f"Thử nghiệm cấp buổi với cap {cap}",
                    "cap": cap,
                    "time_limit_seconds": attempt_time_limit,
                }
            )
        try:
            allocations, metrics = solve_session_allocation(
                data,
                rules=rules,
                max_teacher_sessions=cap,
                minimize_sessions=False,
                time_limit_seconds=attempt_time_limit,
                verbose=verbose,
                progress=progress,
            )
        except RuntimeError as exc:
            attempts.append({"cap": cap, "ok": False, "error": str(exc)})
            if progress:
                progress(
                    {
                        "stage": "session:cap_failed",
                        "message": f"Cap {cap} không tìm được nghiệm trong giới hạn",
                        "cap": cap,
                        "error": str(exc),
                    }
                )
            if best_allocations is None and max_teacher_sessions is not None and not expanded_from_infeasible_cap:
                expanded_from_infeasible_cap = True
                if progress:
                    progress(
                        {
                            "stage": "session:cap_expand",
                            "message": (
                                f"Cap {max_teacher_sessions} khÃ´ng kháº£ thi; thá»­ má»Ÿ rá»™ng Ä‘á»ƒ tÃ¬m má»©c buá»•i GV tháº¥p nháº¥t kháº£ thi"
                            ),
                            "requested_max_teacher_sessions": max_teacher_sessions,
                            "time_limit_seconds": attempt_time_limit,
                        }
                    )
                try:
                    allocations, metrics = solve_session_allocation(
                        data,
                        rules=rules,
                        max_teacher_sessions=None,
                        minimize_sessions=True,
                        time_limit_seconds=attempt_time_limit,
                        verbose=verbose,
                        progress=progress,
                    )
                except RuntimeError as expand_exc:
                    attempts.append({"cap": None, "ok": False, "expanded_from": cap, "error": str(expand_exc)})
                    break

                actual = int(metrics["teacher_sessions"])
                attempts.append({"cap": None, "ok": True, "expanded_from": cap, "teacher_sessions": actual})
                if progress:
                    progress(
                        {
                            "stage": "session:cap_expand_ok",
                            "message": f"TÃ¬m tháº¥y nghiá»‡m kháº£ thi vá»›i {actual} buá»•i GV; tiáº¿p tá»¥c háº¡ cap",
                            "teacher_sessions": actual,
                        }
                    )
                best_allocations = allocations
                best_metrics = metrics
                cap = actual - 1
                continue
            break

        actual = int(metrics["teacher_sessions"])
        attempts.append({"cap": cap, "ok": True, "teacher_sessions": actual})
        if progress:
            progress(
                {
                    "stage": "session:cap_ok",
                    "message": f"Cap {cap} khả thi, thực tế dùng {actual} buổi giáo viên",
                    "cap": cap,
                    "teacher_sessions": actual,
                }
            )
        best_allocations = allocations
        best_metrics = metrics

        next_cap = actual - 1
        if next_cap >= cap:
            next_cap = cap - 1
        cap = next_cap

    if best_allocations is None or best_metrics is None:
        raise RuntimeError(f"No session solution found during cap search: attempts={attempts}")

    best_metrics = dict(best_metrics)
    best_metrics["cap_search"] = {
        "enabled": True,
        "max_teacher_sessions": max_teacher_sessions,
        "min_teacher_sessions": min_teacher_sessions,
        "time_limit_seconds_per_cap": time_limit_seconds_per_cap,
        "reserve_seconds": reserve_seconds,
        "attempts": attempts,
        "best_teacher_sessions": best_metrics["teacher_sessions"],
        "stopped_at_cap": cap,
        "expanded_from_infeasible_cap": expanded_from_infeasible_cap,
    }
    if expanded_from_infeasible_cap and max_teacher_sessions is not None:
        best_metrics["requested_max_teacher_sessions"] = max_teacher_sessions
        best_metrics["effective_max_teacher_sessions"] = max(int(best_metrics["teacher_sessions"]), max_teacher_sessions)
    return best_allocations, best_metrics


def save_session_solution(path: str | Path, allocations: list[SessionAllocation], metrics: dict[str, Any]) -> None:
    path = Path(path)
    payload = {
        "metrics": metrics,
        "solution": [
            {
                "class": a.class_name,
                "grade": a.grade,
                "subject": a.subject,
                "teacher": a.teacher,
                "room": a.room,
                "day": a.session.day,
                "session": a.session.part,
                "count": a.count,
            }
            for a in allocations
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
