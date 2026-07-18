from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Any, Callable, Mapping
import json
import warnings

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix

from .models import Lesson, SchoolData, Session, SessionAllocation
from .rules import TimetableRuleSet, resolve_rule_set
from .template import all_sessions, class_available_periods, class_sort_key, teacher_session_capacity


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


@dataclass(frozen=True, slots=True)
class LessonEvent:
    """A schedulable lesson block inside one half-day session."""

    class_name: str
    teacher: str
    subject: str
    duration: int
    room: str = ""


class PeriodAllocationError(RuntimeError):
    """Structured period placement failure with partial lessons kept."""

    def __init__(
        self,
        message: str,
        *,
        session: Session,
        partial_lessons: list[Lesson] | None = None,
        diagnostics: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.session = session
        self.partial_lessons = list(partial_lessons or [])
        self.diagnostics = dict(diagnostics or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "message": str(self),
            "session": {"day": self.session.day, "part": self.session.part},
            "partial_lessons": len(self.partial_lessons),
            "diagnostics": self.diagnostics,
        }


def _gap_penalty(periods: tuple[int, ...]) -> int:
    periods = tuple(sorted(periods))
    gaps = max(periods) - min(periods) + 1 - len(periods)
    return (100 if gaps >= 2 else 0) + gaps


def _gap_size(periods: tuple[int, ...]) -> int:
    periods = tuple(sorted(periods))
    return max(periods) - min(periods) + 1 - len(periods)


def _periods_are_contiguous(periods: set[int]) -> bool:
    if not periods:
        return True
    return max(periods) - min(periods) + 1 == len(periods)


def _add_row(rows: list[int], cols: list[int], vals: list[float], lb: list[float], ub: list[float], coeffs: dict[int, float], lo: float, hi: float) -> None:
    r = len(lb)
    for c, v in coeffs.items():
        if abs(v) > 1e-12:
            rows.append(r)
            cols.append(c)
            vals.append(float(v))
    lb.append(float(lo))
    ub.append(float(hi))


def _lesson_events_for_session(allocations: list[SessionAllocation], session: Session, rules: TimetableRuleSet) -> list[LessonEvent]:
    events: list[LessonEvent] = []
    for allocation in allocations:
        if allocation.session != session:
            continue
        if rules.contiguous_multi_period_assignments and allocation.count > 1:
            events.append(
                LessonEvent(
                    class_name=allocation.class_name,
                    teacher=allocation.teacher,
                    subject=allocation.subject,
                    duration=allocation.count,
                    room=allocation.room,
                )
            )
            continue
        for _ in range(allocation.count):
            events.append(
                LessonEvent(
                    class_name=allocation.class_name,
                    teacher=allocation.teacher,
                    subject=allocation.subject,
                    duration=1,
                    room=allocation.room,
                )
            )
    return events


def _start_candidates(grade: str, class_name: str, session: Session, duration: int, rules: TimetableRuleSet) -> list[int]:
    constraints = rules.constraints
    allowed = class_available_periods(grade, class_name, session, constraints)
    allowed_set = set(allowed)
    return [start for start in allowed if all(period in allowed_set for period in range(start, start + duration))]


def _day_key(day: int) -> str:
    return f"thu{int(day)}"


def _session_key(session: Session) -> str:
    return "sang" if session.part == "AM" else "chieu"


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


def _linked_day_avoided(linked: Mapping[str, Any] | None, session_key: str, day_key: str) -> bool:
    if not isinstance(linked, Mapping):
        return False
    checked = _truthy(_get_path(linked, f"{session_key}.{day_key}", False))
    if str(linked.get("mode") or "").lower() == "avoid":
        return checked
    if "enabled" in linked:
        return _truthy(linked.get("enabled")) and not checked
    return checked


def _event_period_allowed(event: LessonEvent, session: Session, period: int, rules: TimetableRuleSet) -> bool:
    constraints = rules.constraints
    if constraints is None:
        return True
    if constraints.is_fixed_off("class", event.class_name, session.day, session.part, period):
        return False
    if constraints.is_fixed_off("teacher", event.teacher, session.day, session.part, period):
        return False
    if constraints.is_fixed_off("subject", event.subject, session.day, session.part, period):
        return False
    if constraints.is_subject_group_fixed_off(event.subject, session.day, session.part, period):
        return False
    if event.room and constraints.is_fixed_off("room", event.room, session.day, session.part, period):
        return False
    return True


def _event_start_allowed(event: LessonEvent, session: Session, start: int, rules: TimetableRuleSet) -> bool:
    if not all(_event_period_allowed(event, session, period, rules) for period in range(start, start + event.duration)):
        return False
    constraints = rules.constraints
    if constraints is None:
        return True
    subject_rule = constraints.subject_rule_for(event.class_name, event.subject)
    group_rules = [rule for _gid, rule in constraints.subject_group_rules_for(event.class_name, event.subject)]
    for rule_obj in [subject_rule, *group_rules]:
        if not isinstance(rule_obj, Mapping) or not rule_obj:
            continue
        if event.duration > 1:
            session_key = _session_key(session)
            period_key = "morning" if session_key == "sang" else "afternoon"
            covered = set(range(start, start + event.duration))
            legacy = rule_obj.get("avoidBreakPairs") if isinstance(rule_obj.get("avoidBreakPairs"), Mapping) else {}
            avoid_23 = rule_obj.get("avoidBreakPair23") if isinstance(rule_obj.get("avoidBreakPair23"), Mapping) else {}
            avoid_34 = rule_obj.get("avoidBreakPair34") if isinstance(rule_obj.get("avoidBreakPair34"), Mapping) else {}
            if (_truthy(legacy.get(period_key)) or _truthy(avoid_23.get(period_key))) and {2, 3}.issubset(covered):
                return False
            if (_truthy(legacy.get(period_key)) or _truthy(avoid_34.get(period_key))) and {3, 4}.issubset(covered):
                return False
        if event.duration > 1 and isinstance(rule_obj.get("linkedDays"), Mapping):
            linked = rule_obj["linkedDays"]
            if _linked_day_avoided(linked, _session_key(session), _day_key(session.day)):
                return False
    return True


def _event_matches_limit(event: LessonEvent, rule: Mapping[str, Any], rules: TimetableRuleSet) -> bool:
    constraints = rules.constraints
    if constraints is None:
        return False
    target_type = str(rule.get("targetType") or "")
    target_id = str(rule.get("targetId") or "")
    if target_type == "class":
        return event.class_name == target_id
    if target_type == "teacher":
        return event.teacher == target_id
    if target_type == "subject":
        return event.subject == target_id
    if target_type == "room":
        return bool(event.room) and event.room == target_id
    if target_type == "subjectGroup":
        return constraints.subject_in_group(event.subject, target_id)
    if target_type == "teacherGroup":
        return event.teacher in constraints.group_items("teacher", target_id)
    if target_type == "classGroup":
        return event.class_name in constraints.group_items("class", target_id)
    if target_type == "roomGroup":
        return bool(event.room) and event.room in constraints.group_items("room", target_id)
    return False


def _limit_for_slot(rule: Mapping[str, Any], field: str, session: Session) -> int:
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


def _iter_limit_rules(rules: TimetableRuleSet) -> list[Mapping[str, Any]]:
    constraints = rules.constraints
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


def _allocate_periods_sequential(
    data: SchoolData,
    allocations: list[SessionAllocation],
    *,
    rules: TimetableRuleSet | None = None,
    fixed_lessons: list[Lesson] | None = None,
    time_limit_seconds_per_session: int = 10,
    retry_time_limit_seconds_per_session: int | None = None,
    verbose: bool = True,
    require_teacher_contiguous: bool = False,
    max_teacher_gap: int | None = None,
    minimize_teacher_gaps: bool = True,
    best_effort: bool = False,
    remaining_time_seconds: Callable[[], float | None] | None = None,
    reserve_seconds: float = 2.0,
    progress: Callable[[dict[str, Any]], None] | None = None,
    _sessions: list[Session] | None = None,
    _initial_teacher_gap_period_totals: Mapping[str, int] | None = None,
    _initial_teacher_gap1_session_totals: Mapping[str, int] | None = None,
    _initial_partial_lessons: list[Lesson] | None = None,
) -> tuple[list[Lesson], dict[str, Any]]:
    """Place session-level counts into concrete periods.

    This decomposes the problem by half-day session. Every session-level
    allocation becomes one schedulable event when rules require its periods to
    be contiguous; otherwise it remains split into single-period events. The
    model assigns event start periods, covers every class-period exactly once,
    and links teacher occupancy to compact period patterns to reduce 2-gap
    first, then 1-gap.
    """

    rules = resolve_rule_set(rules)
    fixed_lessons = list(fixed_lessons or [])
    class_grade = data.class_grade
    classes = sorted(class_grade.keys(), key=class_sort_key)
    lessons: list[Lesson] = []
    session_objectives: dict[str, float] = {}
    session_event_counts: dict[str, dict[str, int]] = {}
    session_retries: dict[str, dict[str, Any]] = {}
    session_failures: list[dict[str, Any]] = []
    teacher_gap_period_totals: dict[str, int] = {}
    teacher_gap1_session_totals: dict[str, int] = {}
    fairness_gap_period_totals = dict(_initial_teacher_gap_period_totals or {})
    fairness_gap1_session_totals = dict(_initial_teacher_gap1_session_totals or {})
    initial_partial_lessons = list(_initial_partial_lessons or [])

    for session in (_sessions if _sessions is not None else all_sessions()):
        events = _lesson_events_for_session(allocations, session, rules)
        if not events:
            continue
        session_fixed_lessons = [
            lesson
            for lesson in fixed_lessons
            if int(lesson.day) == int(session.day) and str(lesson.session) == str(session.part)
        ]
        fixed_teacher_periods: dict[str, set[int]] = {}
        fixed_assignment_periods: dict[tuple[str, str, str], set[int]] = {}
        for lesson in session_fixed_lessons:
            fixed_teacher_periods.setdefault(lesson.teacher, set()).add(int(lesson.period))
            fixed_assignment_periods.setdefault(
                (lesson.class_name, lesson.subject, lesson.teacher), set()
            ).add(int(lesson.period))

        def fail_session(message: str, diagnostics: Mapping[str, Any] | None = None) -> bool:
            error = PeriodAllocationError(
                message,
                session=session,
                partial_lessons=[*initial_partial_lessons, *lessons],
                diagnostics=diagnostics or {},
            )
            if not best_effort:
                raise error
            session_failures.append(error.to_dict())
            if progress:
                progress(
                    {
                        "stage": "period:best_effort_skip",
                        "message": f"Bo qua buoi Thu {session.day} {session.part} de tra ket qua best-effort.",
                        "day": session.day,
                        "session": session.part,
                        "error": str(error),
                    }
            )
            return True

        def budgeted_time_limit(requested: int | None) -> int | None:
            limit = max(1, int(requested or 1))
            if remaining_time_seconds is None:
                return limit
            remaining = remaining_time_seconds()
            if remaining is not None:
                usable = int(remaining - float(reserve_seconds))
                if usable <= 0:
                    return None
                limit = max(1, min(limit, usable))
            return limit

        session_time_limit = budgeted_time_limit(time_limit_seconds_per_session)
        if session_time_limit is None:
            if fail_session(
                "Da het ngan sach thoi gian; tra lich best-effort.",
                {
                    "reason": "deadline_exhausted",
                    "remaining_seconds": round(float(remaining_time_seconds() or 0), 3)
                    if remaining_time_seconds is not None
                    else 0,
                    "reserve_seconds": reserve_seconds,
                },
            ):
                continue

        cap = teacher_session_capacity(session)
        contiguous_blocks = sum(1 for event in events if event.duration > 1)
        total_periods = sum(event.duration for event in events)
        if progress:
            progress(
                {
                    "stage": "period:session_start",
                    "message": f"Xếp tiết cụ thể cho Thứ {session.day} {'sáng' if session.part == 'AM' else 'chiều'}",
                    "day": session.day,
                    "session": session.part,
                    "events": len(events),
                    "contiguous_blocks": contiguous_blocks,
                    "periods": total_periods,
                    "time_limit_seconds": session_time_limit,
                }
            )
        block_vars: dict[tuple[int, int], int] = {}
        event_starts: dict[int, list[int]] = {}
        var_count = 0
        skip_session = False
        for ei, event in enumerate(events):
            starts = [
                start
                for start in _start_candidates(class_grade[event.class_name], event.class_name, session, event.duration, rules)
                if _event_start_allowed(event, session, start, rules)
            ]
            fixed_periods = fixed_assignment_periods.get(
                (event.class_name, event.subject, event.teacher), set()
            )
            if rules.contiguous_multi_period_assignments and fixed_periods:
                starts = [
                    start
                    for start in starts
                    if _periods_are_contiguous(
                        set(fixed_periods)
                        | set(range(start, start + event.duration))
                    )
                ]
            if not starts:
                skip_session = fail_session(
                    "No period block fits "
                    f"{event.class_name} {event.subject} {event.teacher} "
                    f"duration={event.duration} in {session.day}-{session.part}; "
                    "check fixed-off/session-linked constraints",
                    {
                        "reason": "no_event_start",
                        "event": {
                            "class": event.class_name,
                            "subject": event.subject,
                            "teacher": event.teacher,
                            "room": event.room,
                            "duration": event.duration,
                        },
                        "available_periods": class_available_periods(
                            class_grade[event.class_name],
                            event.class_name,
                            session,
                            rules.constraints,
                        ),
                    },
                )
                break
            event_starts[ei] = starts
            for start in starts:
                block_vars[(ei, start)] = var_count
                var_count += 1
        if skip_session:
            continue

        teacher_events: dict[str, list[int]] = {}
        for ei, event in enumerate(events):
            teacher_events.setdefault(event.teacher, []).append(ei)

        if rules.constraints is not None:
            for teacher, required_slots in (rules.constraints.teacher_must_teach or {}).items():
                fixed_periods = fixed_teacher_periods.get(teacher, set())
                required_periods = [
                    period
                    for day, part, period in required_slots
                    if int(day) == int(session.day) and str(part) == str(session.part)
                    and int(period) not in fixed_periods
                ]
                if required_periods and teacher not in teacher_events:
                    if fail_session(
                        f"Teacher {teacher} has required periods but no allocated lesson "
                        f"in {session.day}-{session.part}",
                        {
                            "reason": "teacher_must_teach_without_session_load",
                            "teacher": teacher,
                            "required_periods": sorted(required_periods),
                        },
                    ):
                        skip_session = True
                        break
        if skip_session:
            continue

        y_vars: dict[tuple[str, tuple[int, ...]], int] = {}
        patterns: dict[str, list[tuple[int, ...]]] = {}
        for teacher, event_ids in teacher_events.items():
            fixed_periods = fixed_teacher_periods.get(teacher, set())
            load = sum(events[ei].duration for ei in event_ids) + len(fixed_periods)
            if load > cap:
                if fail_session(
                    f"Teacher {teacher} has load={load} > cap={cap} in {session.day}-{session.part}",
                    {
                        "reason": "teacher_load_over_capacity",
                        "teacher": teacher,
                        "load": load,
                        "fixed_periods": sorted(fixed_periods),
                        "capacity": cap,
                    },
                ):
                    skip_session = True
                    break
            if require_teacher_contiguous:
                patterns[teacher] = [
                    tuple(range(start, start + load))
                    for start in range(1, cap - load + 2)
                ]
            else:
                patterns[teacher] = list(combinations(range(1, cap + 1), load))
            if fixed_periods:
                patterns[teacher] = [
                    pattern for pattern in patterns[teacher] if fixed_periods.issubset(pattern)
                ]
            if max_teacher_gap is not None:
                patterns[teacher] = [
                    pattern for pattern in patterns[teacher] if _gap_size(pattern) <= int(max_teacher_gap)
                ]
                if not patterns[teacher]:
                    if fail_session(
                        f"Teacher {teacher} has no pattern with gap<={max_teacher_gap} "
                        f"in {session.day}-{session.part}",
                        {
                            "reason": "teacher_gap_pattern_infeasible",
                            "teacher": teacher,
                            "load": load,
                            "fixed_periods": sorted(fixed_periods),
                            "max_teacher_gap": max_teacher_gap,
                            "capacity": cap,
                        },
                    ):
                        skip_session = True
                        break
            for pattern in patterns[teacher]:
                y_vars[(teacher, pattern)] = var_count
                var_count += 1
        if skip_session:
            continue

        # Materialize distinct-resource activity variables before the sparse
        # matrix shape is fixed.  UI per-slot limits are defined as numbers of
        # distinct classes/teachers/rooms/subjects, not numbers of lesson
        # events.  The old implementation used one event sum for every field,
        # which incorrectly rejected two classes studying the same subject in
        # the same period.
        distinct_limit_groups: list[tuple[int, list[tuple[int, tuple[int, ...]]]]] = []
        if rules.constraints is not None:
            field_getters = {
                "classes": lambda item: item.class_name,
                "teachers": lambda item: item.teacher,
                "rooms": lambda item: item.room,
                "subjects": lambda item: item.subject,
            }
            for limit_rule in _iter_limit_rules(rules):
                if not isinstance(limit_rule, Mapping):
                    continue
                matched_event_ids = [
                    ei
                    for ei, event in enumerate(events)
                    if _event_matches_limit(event, limit_rule, rules)
                ]
                matched_fixed_events = [
                    (
                        lesson,
                        LessonEvent(
                            class_name=lesson.class_name,
                            teacher=lesson.teacher,
                            subject=lesson.subject,
                            duration=1,
                            room=lesson.room,
                        ),
                    )
                    for lesson in session_fixed_lessons
                ]
                matched_fixed_events = [
                    (lesson, event)
                    for lesson, event in matched_fixed_events
                    if _event_matches_limit(event, limit_rule, rules)
                ]
                if not matched_event_ids and not matched_fixed_events:
                    continue
                for period in range(1, cap + 1):
                    for field, getter in field_getters.items():
                        limit = _limit_for_slot(limit_rule, field, session)
                        if limit <= 0:
                            continue
                        fixed_values = {
                            str(getter(event))
                            for lesson, event in matched_fixed_events
                            if int(lesson.period) == period and getter(event)
                        }
                        remaining_limit = int(limit) - len(fixed_values)
                        if remaining_limit < 0:
                            skip_session = fail_session(
                                f"Per-slot distinct {field} limit already exceeded by fixed lessons "
                                f"in {session.day}-{session.part} period {period}",
                                {
                                    "reason": "fixed_lessons_exceed_distinct_slot_limit",
                                    "field": field,
                                    "limit": int(limit),
                                    "fixed_values": sorted(fixed_values),
                                    "period": period,
                                },
                            )
                            break
                        occupied_by_value: dict[str, set[int]] = {}
                        for ei in matched_event_ids:
                            event = events[ei]
                            value = str(getter(event) or "")
                            if not value or value in fixed_values:
                                continue
                            for start in event_starts[ei]:
                                if start <= period < start + event.duration:
                                    occupied_by_value.setdefault(value, set()).add(block_vars[(ei, start)])
                        activities: list[tuple[int, tuple[int, ...]]] = []
                        for occupied_vars in occupied_by_value.values():
                            activity_var = var_count
                            var_count += 1
                            activities.append((activity_var, tuple(sorted(occupied_vars))))
                        if activities:
                            distinct_limit_groups.append((remaining_limit, activities))
                    if skip_session:
                        break
                if skip_session:
                    break
        if skip_session:
            continue

        rows: list[int] = []
        cols: list[int] = []
        vals: list[float] = []
        lb: list[float] = []
        ub: list[float] = []

        def add(coeffs: dict[int, float], lo: float, hi: float) -> None:
            _add_row(rows, cols, vals, lb, ub, coeffs, lo, hi)

        # Every event chooses exactly one start period.
        for ei, starts in event_starts.items():
            add({block_vars[(ei, start)]: 1 for start in starts}, 1, 1)

        for limit, activities in distinct_limit_groups:
            for activity_var, occupied_vars in activities:
                for occupied_var in occupied_vars:
                    add({occupied_var: 1, activity_var: -1}, -np.inf, 0)
            add({activity_var: 1 for activity_var, _occupied in activities}, 0, limit)

        # Student sessions may use any visible period that is not explicitly
        # locked off. Do not recreate the old hidden frame by forcing every
        # class to start at period 1 and stay contiguous.
        class_load: dict[str, int] = {}
        for event in events:
            class_load[event.class_name] = class_load.get(event.class_name, 0) + event.duration
        for class_name in classes:
            load = class_load.get(class_name, 0)
            if load <= 0:
                continue
            available = class_available_periods(class_grade[class_name], class_name, session, rules.constraints)
            if load > len(available):
                if fail_session(
                    f"Class {class_name} has load={load} > available capacity={len(available)} "
                    f"in {session.day}-{session.part}",
                    {
                        "reason": "class_load_over_available_periods",
                        "class": class_name,
                        "load": load,
                        "available_periods": available,
                    },
                ):
                    skip_session = True
                    break
            for period in available:
                coeff: dict[int, float] = {}
                for ei, event in enumerate(events):
                    if event.class_name != class_name:
                        continue
                    for start in event_starts[ei]:
                        if start <= period < start + event.duration:
                            coeff[block_vars[(ei, start)]] = 1
                if coeff:
                    add(coeff, 0, 1)
        if skip_session:
            continue

        # Each teacher chooses exactly one compact pattern for this session.
        for teacher, pats in patterns.items():
            add({y_vars[(teacher, pat)]: 1 for pat in pats}, 1, 1)

        # Link teacher-period load to the selected pattern.
        for teacher, event_ids in teacher_events.items():
            fixed_periods = fixed_teacher_periods.get(teacher, set())
            for period in range(1, cap + 1):
                coeff: dict[int, float] = {}
                for ei in event_ids:
                    event = events[ei]
                    for start in event_starts[ei]:
                        if start <= period < start + event.duration:
                            coeff[block_vars[(ei, start)]] = coeff.get(block_vars[(ei, start)], 0) + 1
                for pattern in patterns[teacher]:
                    if period in pattern:
                        coeff[y_vars[(teacher, pattern)]] = coeff.get(y_vars[(teacher, pattern)], 0) - 1
                fixed_present = 1 if period in fixed_periods else 0
                add(coeff, -fixed_present, -fixed_present)

        # Teacher must-teach slots require an actual lesson at the exact period.
        if rules.constraints is not None:
            for teacher, event_ids in teacher_events.items():
                fixed_periods = fixed_teacher_periods.get(teacher, set())
                for period in rules.constraints.teacher_must_teach_periods(teacher, session.day, session.part):
                    if int(period) in fixed_periods:
                        continue
                    coeff: dict[int, float] = {}
                    for ei in event_ids:
                        event = events[ei]
                        for start in event_starts[ei]:
                            if start <= period < start + event.duration:
                                coeff[block_vars[(ei, start)]] = coeff.get(block_vars[(ei, start)], 0) + 1
                    if not coeff:
                        if fail_session(
                            f"Teacher {teacher} cannot cover required period {period} "
                            f"in {session.day}-{session.part}",
                            {
                                "reason": "teacher_must_teach_period_uncovered",
                                "teacher": teacher,
                                "period": period,
                            },
                        ):
                            skip_session = True
                            break
                    else:
                        add(coeff, 1, 1)
                if skip_session:
                    break
        if skip_session:
            continue

        # Room conflicts are hard constraints when room data exists.
        room_events: dict[str, list[int]] = {}
        for ei, event in enumerate(events):
            if event.room:
                room_events.setdefault(event.room, []).append(ei)
        for room, event_ids in room_events.items():
            for period in range(1, cap + 1):
                coeff: dict[int, float] = {}
                for ei in event_ids:
                    event = events[ei]
                    for start in event_starts[ei]:
                        if start <= period < start + event.duration:
                            coeff[block_vars[(ei, start)]] = coeff.get(block_vars[(ei, start)], 0) + 1
                if coeff:
                    add(coeff, 0, 1)

        A = coo_matrix((vals, (rows, cols)), shape=(len(lb), var_count)).tocsr()
        c = np.zeros(var_count)
        if minimize_teacher_gaps:
            for (teacher, pattern), vid in y_vars.items():
                gap_size = _gap_size(pattern)
                fairness_penalty = 0
                if gap_size > 0:
                    fairness_penalty = (
                        int(fairness_gap_period_totals.get(teacher, 0))
                        + 3 * int(fairness_gap1_session_totals.get(teacher, 0))
                    )
                c[vid] = (_gap_penalty(pattern) * 1000) + fairness_penalty

        def solve_session_milp(limit_seconds: int):
            return milp(
                c,
                integrality=np.ones(var_count, dtype=int),
                bounds=Bounds(np.zeros(var_count), np.ones(var_count)),
                constraints=LinearConstraint(A, np.array(lb), np.array(ub)),
                options={
                    "time_limit": limit_seconds,
                    "disp": False,
                    "mip_rel_gap": 0.0,
                    # Period sessions may run concurrently. Keep each HiGHS
                    # instance single-threaded so one school never exceeds its
                    # worker-token grant.
                    "threads": 1,
                },
            )

        # Model construction above can take several seconds on large schools;
        # refresh the phase budget immediately before entering HiGHS.
        session_time_limit = budgeted_time_limit(session_time_limit)
        if session_time_limit is None:
            if fail_session(
                "Da het ngan sach thoi gian truoc khi bat dau MILP xep tiet.",
                {
                    "reason": "deadline_exhausted_after_model_build",
                    "reserve_seconds": reserve_seconds,
                },
            ):
                continue
        result = solve_session_milp(session_time_limit)
        retry_limit = budgeted_time_limit(retry_time_limit_seconds_per_session)
        if result.x is None and retry_limit is not None and retry_limit > session_time_limit:
            if progress:
                progress(
                    {
                        "stage": "period:session_retry",
                        "message": f"Thu lai buoi Thu {session.day} {session.part} voi ngan sach {retry_limit}s.",
                        "day": session.day,
                        "session": session.part,
                        "time_limit_seconds": retry_limit,
                        "previous_status": int(result.status),
                        "previous_message": str(result.message),
                    }
                )
            retry_result = solve_session_milp(retry_limit)
            session_retries[f"{session.day}-{session.part}"] = {
                "fast_limit_seconds": session_time_limit,
                "retry_limit_seconds": retry_limit,
                "fast_status": int(result.status),
                "retry_status": int(retry_result.status),
            }
            if retry_result.x is not None:
                result = retry_result
        if result.x is None:
            if progress:
                progress(
                    {
                        "stage": "period:error",
                        "message": f"Không xếp được tiết cho Thứ {session.day} {session.part}",
                        "day": session.day,
                        "session": session.part,
                        "status": int(result.status),
                        "solver_message": str(result.message),
                    }
                )
            if fail_session(
                f"Khong xep duoc tiet cho Thu {session.day} {session.part}; da tra chan doan cau truc.",
                {
                    "reason": "milp_infeasible_or_timeout",
                    "status": int(result.status),
                    "solver_message": str(result.message),
                    "events": len(events),
                    "periods": total_periods,
                    "contiguous_blocks": contiguous_blocks,
                    "teacher_loads": {
                        teacher: sum(events[ei].duration for ei in event_ids)
                        for teacher, event_ids in teacher_events.items()
                    },
                    "class_loads": class_load,
                },
            ):
                continue

        session_objectives[f"{session.day}-{session.part}"] = float(result.fun or 0)
        session_event_counts[f"{session.day}-{session.part}"] = {
            "events": len(events),
            "contiguous_blocks": contiguous_blocks,
            "periods": total_periods,
        }
        for (teacher, pattern), vid in y_vars.items():
            if result.x[vid] <= 0.5:
                continue
            gap_size = _gap_size(pattern)
            if gap_size <= 0:
                continue
            teacher_gap_period_totals[teacher] = int(teacher_gap_period_totals.get(teacher, 0)) + gap_size
            fairness_gap_period_totals[teacher] = int(fairness_gap_period_totals.get(teacher, 0)) + gap_size
            if gap_size == 1:
                teacher_gap1_session_totals[teacher] = int(teacher_gap1_session_totals.get(teacher, 0)) + 1
                fairness_gap1_session_totals[teacher] = int(fairness_gap1_session_totals.get(teacher, 0)) + 1
        assigned = 0
        for (ei, start), vid in block_vars.items():
            if result.x[vid] > 0.5:
                event = events[ei]
                for period in range(start, start + event.duration):
                    lessons.append(
                        Lesson(
                            class_name=event.class_name,
                            grade=class_grade[event.class_name],
                            day=session.day,
                            session=session.part,
                            period=period,
                            subject=event.subject,
                            teacher=event.teacher,
                            room=event.room,
                        )
                    )
                    assigned += 1

        if verbose:
            print(f"period MILP {session.day}-{session.part}: assigned={assigned}, gap_obj={result.fun}", flush=True)
        if progress:
            progress(
                {
                    "stage": "period:session_done",
                    "message": f"Đã xếp {assigned} tiết cho Thứ {session.day} {session.part}",
                    "day": session.day,
                    "session": session.part,
                    "assigned_periods": assigned,
                    "gap_objective": float(result.fun or 0),
                }
            )

    metrics = {
        "session_gap_objectives": session_objectives,
        "session_event_counts": session_event_counts,
        "session_retries": session_retries,
        "max_teacher_gap": max_teacher_gap,
        "minimize_teacher_gaps": bool(minimize_teacher_gaps),
        "fixed_lessons": len(fixed_lessons),
        "teacher_gap_period_totals": dict(sorted((teacher, count) for teacher, count in teacher_gap_period_totals.items() if count)),
        "teacher_gap1_session_totals": dict(sorted((teacher, count) for teacher, count in teacher_gap1_session_totals.items() if count)),
    }
    if session_failures:
        metrics["best_effort_failed_sessions"] = session_failures
        metrics["best_effort_failed_session_count"] = len(session_failures)
    return lessons, metrics


def allocate_periods(
    data: SchoolData,
    allocations: list[SessionAllocation],
    *,
    rules: TimetableRuleSet | None = None,
    fixed_lessons: list[Lesson] | None = None,
    time_limit_seconds_per_session: int = 10,
    retry_time_limit_seconds_per_session: int | None = None,
    verbose: bool = True,
    require_teacher_contiguous: bool = False,
    max_teacher_gap: int | None = None,
    minimize_teacher_gaps: bool = True,
    best_effort: bool = False,
    remaining_time_seconds: Callable[[], float | None] | None = None,
    reserve_seconds: float = 2.0,
    progress: Callable[[dict[str, Any]], None] | None = None,
    max_workers: int = 1,
) -> tuple[list[Lesson], dict[str, Any]]:
    """Place periods sequentially or in deterministic, fairness-aware waves."""

    # Test runners and embedding applications may install warning filters after
    # module import. Refresh this exact filter once, before any worker starts.
    _suppress_highs_threads_option_warning()
    worker_limit = max(1, int(max_workers or 1))
    if worker_limit <= 1:
        return _allocate_periods_sequential(
            data,
            allocations,
            rules=rules,
            fixed_lessons=fixed_lessons,
            time_limit_seconds_per_session=time_limit_seconds_per_session,
            retry_time_limit_seconds_per_session=retry_time_limit_seconds_per_session,
            verbose=verbose,
            require_teacher_contiguous=require_teacher_contiguous,
            max_teacher_gap=max_teacher_gap,
            minimize_teacher_gaps=minimize_teacher_gaps,
            best_effort=best_effort,
            remaining_time_seconds=remaining_time_seconds,
            reserve_seconds=reserve_seconds,
            progress=progress,
        )

    resolved_rules = resolve_rule_set(rules)
    fixed_lessons = list(fixed_lessons or [])
    sessions = [
        session
        for session in all_sessions()
        if _lesson_events_for_session(allocations, session, resolved_rules)
    ]
    if len(sessions) <= 1:
        return _allocate_periods_sequential(
            data,
            allocations,
            rules=resolved_rules,
            fixed_lessons=fixed_lessons,
            time_limit_seconds_per_session=time_limit_seconds_per_session,
            retry_time_limit_seconds_per_session=retry_time_limit_seconds_per_session,
            verbose=verbose,
            require_teacher_contiguous=require_teacher_contiguous,
            max_teacher_gap=max_teacher_gap,
            minimize_teacher_gaps=minimize_teacher_gaps,
            best_effort=best_effort,
            remaining_time_seconds=remaining_time_seconds,
            reserve_seconds=reserve_seconds,
            progress=progress,
        )

    worker_count = min(worker_limit, len(sessions))
    lessons: list[Lesson] = []
    session_objectives: dict[str, float] = {}
    session_event_counts: dict[str, dict[str, int]] = {}
    session_retries: dict[str, dict[str, Any]] = {}
    session_failures: list[dict[str, Any]] = []
    teacher_gap_period_totals: dict[str, int] = {}
    teacher_gap1_session_totals: dict[str, int] = {}
    waves_started = 0

    def deadline_exhausted() -> bool:
        if remaining_time_seconds is None:
            return False
        remaining = remaining_time_seconds()
        return remaining is not None and int(float(remaining) - float(reserve_seconds)) <= 0

    def merge_metrics(metrics: Mapping[str, Any]) -> None:
        session_objectives.update(metrics.get("session_gap_objectives") or {})
        session_event_counts.update(metrics.get("session_event_counts") or {})
        session_retries.update(metrics.get("session_retries") or {})
        for teacher, count in (metrics.get("teacher_gap_period_totals") or {}).items():
            teacher_gap_period_totals[str(teacher)] = (
                int(teacher_gap_period_totals.get(str(teacher), 0)) + int(count)
            )
        for teacher, count in (metrics.get("teacher_gap1_session_totals") or {}).items():
            teacher_gap1_session_totals[str(teacher)] = (
                int(teacher_gap1_session_totals.get(str(teacher), 0)) + int(count)
            )
        session_failures.extend(metrics.get("best_effort_failed_sessions") or [])

    for wave_start in range(0, len(sessions), worker_count):
        wave = sessions[wave_start : wave_start + worker_count]
        if deadline_exhausted():
            remaining_sessions = sessions[wave_start:]
            first = remaining_sessions[0]
            diagnostics = {
                "reason": "deadline_exhausted_before_parallel_wave",
                "remaining_seconds": round(float(remaining_time_seconds() or 0), 3)
                if remaining_time_seconds is not None
                else 0,
                "reserve_seconds": reserve_seconds,
                "parallel_wave": waves_started + 1,
            }
            if not best_effort:
                raise PeriodAllocationError(
                    "Da het ngan sach thoi gian truoc khi bat dau wave xep tiet.",
                    session=first,
                    partial_lessons=list(lessons),
                    diagnostics=diagnostics,
                )
            for session in remaining_sessions:
                error = PeriodAllocationError(
                    "Da het ngan sach thoi gian truoc khi bat dau wave xep tiet.",
                    session=session,
                    partial_lessons=list(lessons),
                    diagnostics=diagnostics,
                )
                session_failures.append(error.to_dict())
                if progress:
                    progress(
                        {
                            "stage": "period:best_effort_skip",
                            "message": f"Bo qua buoi Thu {session.day} {session.part} de tra ket qua best-effort.",
                            "day": session.day,
                            "session": session.part,
                            "error": str(error),
                        }
                    )
            break

        waves_started += 1
        fairness_gap_snapshot = dict(teacher_gap_period_totals)
        fairness_gap1_snapshot = dict(teacher_gap1_session_totals)
        partial_snapshot = list(lessons)
        progress_buffers: list[list[dict[str, Any]]] = [[] for _session in wave]

        def solve_one(index: int, session: Session) -> tuple[list[Lesson], dict[str, Any]]:
            buffered_progress = progress_buffers[index].append if progress is not None else None
            return _allocate_periods_sequential(
                data,
                allocations,
                rules=resolved_rules,
                fixed_lessons=fixed_lessons,
                time_limit_seconds_per_session=time_limit_seconds_per_session,
                retry_time_limit_seconds_per_session=retry_time_limit_seconds_per_session,
                verbose=False,
                require_teacher_contiguous=require_teacher_contiguous,
                max_teacher_gap=max_teacher_gap,
                minimize_teacher_gaps=minimize_teacher_gaps,
                best_effort=best_effort,
                remaining_time_seconds=remaining_time_seconds,
                reserve_seconds=reserve_seconds,
                progress=buffered_progress,
                _sessions=[session],
                _initial_teacher_gap_period_totals=fairness_gap_snapshot,
                _initial_teacher_gap1_session_totals=fairness_gap1_snapshot,
                _initial_partial_lessons=partial_snapshot,
            )

        outcomes: list[tuple[list[Lesson], dict[str, Any]] | BaseException] = []
        with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="tkb-period-wave") as executor:
            futures = [executor.submit(solve_one, index, session) for index, session in enumerate(wave)]
            for future in futures:
                try:
                    outcomes.append(future.result())
                except BaseException as exc:  # Re-raised below in canonical session order.
                    outcomes.append(exc)

        for index, (session, outcome) in enumerate(zip(wave, outcomes, strict=True)):
            if progress:
                for event in progress_buffers[index]:
                    progress(event)
            if isinstance(outcome, BaseException):
                if isinstance(outcome, PeriodAllocationError):
                    raise PeriodAllocationError(
                        str(outcome),
                        session=session,
                        partial_lessons=list(lessons),
                        diagnostics=outcome.diagnostics,
                    ) from outcome
                raise outcome
            session_lessons, metrics = outcome
            lessons.extend(session_lessons)
            merge_metrics(metrics)
            if verbose:
                key = f"{session.day}-{session.part}"
                print(
                    f"period MILP {key}: assigned={len(session_lessons)}, "
                    f"gap_obj={session_objectives.get(key, 0.0)}",
                    flush=True,
                )

    metrics = {
        "session_gap_objectives": session_objectives,
        "session_event_counts": session_event_counts,
        "session_retries": session_retries,
        "max_teacher_gap": max_teacher_gap,
        "minimize_teacher_gaps": bool(minimize_teacher_gaps),
        "fixed_lessons": len(fixed_lessons),
        "teacher_gap_period_totals": dict(
            sorted((teacher, count) for teacher, count in teacher_gap_period_totals.items() if count)
        ),
        "teacher_gap1_session_totals": dict(
            sorted((teacher, count) for teacher, count in teacher_gap1_session_totals.items() if count)
        ),
        "parallel_period_sessions": True,
        "parallel_period_workers": worker_count,
        "parallel_period_waves": waves_started,
    }
    if session_failures:
        metrics["best_effort_failed_sessions"] = session_failures
        metrics["best_effort_failed_session_count"] = len(session_failures)
    return lessons, metrics


def save_period_solution(path: str | Path, lessons: list[Lesson], metrics: dict[str, Any]) -> None:
    path = Path(path)
    payload = {
        "metrics": metrics,
        "schedule": [
            {
                "class": x.class_name,
                "grade": x.grade,
                "day": x.day,
                "session": x.session,
                "period": x.period,
                "subject": x.subject,
                "teacher": x.teacher,
                "room": x.room,
            }
            for x in lessons
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
