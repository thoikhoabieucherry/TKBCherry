"""Problem compilation + schedule state with incremental hard-constraint checks.

Coordinate system:
  day index d in 0..5  (UI weekday = d + 2)
  part 0 = AM, 1 = PM
  session s = d * 2 + part          (12 sessions)
  period p in 0..4                  (UI period = p + 1)
  slot = s * 5 + p                  (60 slots)
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

NUM_DAYS = 6
NUM_SESSIONS = 12
PERIODS = 5
NUM_SLOTS = NUM_SESSIONS * PERIODS


def slot_of(day: int, part: int, period: int) -> int:
    return (day * 2 + part) * PERIODS + period


def session_of_slot(slot: int) -> int:
    return slot // PERIODS


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _truthy(value: Any) -> bool:
    return value is True or value == 1 or str(value).strip().casefold() in {"1", "true", "on", "yes"}


def _get_path(obj: Mapping[str, Any] | None, path: str, default: Any = None) -> Any:
    cur: Any = obj or {}
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return default
        cur = cur[part]
    return default if cur is None else cur


_DAY_KEYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
_PART_KEYS = ["sang", "chieu"]


def _day_limit(rule: Mapping[str, Any], path: str, day: int) -> int:
    raw = _get_path(rule, path, 0)
    if isinstance(raw, Mapping):
        return _to_int(raw.get(_DAY_KEYS[day]), 0)
    return _to_int(raw, 0)


def _linked_day_avoided(linked: Any, part: int, day: int) -> bool:
    if not isinstance(linked, Mapping):
        return False
    checked = _truthy(_get_path(linked, f"{_PART_KEYS[part]}.{_DAY_KEYS[day]}", False))
    if str(linked.get("mode") or "").lower() == "avoid":
        return checked
    if "enabled" in linked:
        return _truthy(linked.get("enabled")) and not checked
    return checked


# ---------------------------------------------------------------------------
# Compiled per-(class, subject) weekly rule bundle
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SubjectRule:
    """Merged subject + subject-group rules for one (class, subject)."""

    part_banned: tuple[bool, bool] = (False, False)
    one_session_per_day: bool = False
    weekly_part_cap: tuple[int, int] = (0, 0)          # weeklySessionPeriods morning/afternoon
    day_cap: tuple[int, ...] = (0,) * NUM_DAYS         # maxPeriods.day (0 = none)
    session_part_cap: tuple[int, int] = (0, 0)         # maxPeriods.sang / .chieu per single session
    max_sessions_week: int = 0                         # maxSessions.day
    spacing_days: int = 0
    avoid23: tuple[bool, bool] = (False, False)        # per part
    avoid34: tuple[bool, bool] = (False, False)
    linked_avoided: tuple[bool, ...] = (False,) * NUM_SESSIONS  # session -> avoid contiguous (cap 1)
    lesson_blocks: tuple[tuple[int, int, int], ...] = ()  # (length, min, max) sanitized
    max_subjects_part: tuple[int, int] = (0, 0)        # only meaningful on group rules

    def is_default(self) -> bool:
        return (
            self.part_banned == (False, False)
            and not self.one_session_per_day
            and self.weekly_part_cap == (0, 0)
            and not any(self.day_cap)
            and self.session_part_cap == (0, 0)
            and self.max_sessions_week == 0
            and self.spacing_days == 0
            and self.avoid23 == (False, False)
            and self.avoid34 == (False, False)
            and not any(self.linked_avoided)
            and not self.lesson_blocks
            and self.max_subjects_part == (0, 0)
        )


def compile_subject_rule(rule: Mapping[str, Any], periods_per_week: int, cap: int) -> SubjectRule:
    allowed = rule.get("sessionAllowed") if isinstance(rule.get("sessionAllowed"), Mapping) else {}
    part_banned = (
        allowed.get("allowMorning") is False,
        allowed.get("allowAfternoon") is False,
    )
    one_spd = _truthy(allowed.get("oneSessionPerDay")) if allowed else False
    weekly_part_cap = (
        _to_int(_get_path(rule, "weeklySessionPeriods.morning", 0), 0),
        _to_int(_get_path(rule, "weeklySessionPeriods.afternoon", 0), 0),
    )
    day_cap = tuple(_day_limit(rule, "maxPeriods.day", d) for d in range(NUM_DAYS))
    session_part_cap = (
        _to_int(_get_path(rule, "maxPeriods.sang", 0), 0),
        _to_int(_get_path(rule, "maxPeriods.chieu", 0), 0),
    )
    max_sessions_week = _to_int(_get_path(rule, "maxSessions.day", 0), 0)
    spacing_days = _to_int(_get_path(rule, "spacingDays.days", 0), 0)
    legacy = rule.get("avoidBreakPairs") if isinstance(rule.get("avoidBreakPairs"), Mapping) else {}
    a23 = rule.get("avoidBreakPair23") if isinstance(rule.get("avoidBreakPair23"), Mapping) else {}
    a34 = rule.get("avoidBreakPair34") if isinstance(rule.get("avoidBreakPair34"), Mapping) else {}
    avoid23 = tuple(
        _truthy(legacy.get(key)) or _truthy(a23.get(key)) for key in ("morning", "afternoon")
    )
    avoid34 = tuple(
        _truthy(legacy.get(key)) or _truthy(a34.get(key)) for key in ("morning", "afternoon")
    )
    linked = rule.get("linkedDays") if isinstance(rule.get("linkedDays"), Mapping) else None
    linked_avoided = tuple(
        _linked_day_avoided(linked, s % 2, s // 2) for s in range(NUM_SESSIONS)
    )
    blocks: list[tuple[int, int, int]] = []
    lesson_blocks = rule.get("lessonBlocks") if isinstance(rule.get("lessonBlocks"), Mapping) else {}
    for length in (2, 3, 4, 5):
        conf = lesson_blocks.get(str(length)) or lesson_blocks.get(length)
        if not isinstance(conf, Mapping):
            continue
        raw_min = _to_int(conf.get("min"), 0)
        raw_max = _to_int(conf.get("max"), 0)
        # Sanitize impossible minimums: a run of >= L periods needs L periods in
        # one session (cap is an upper bound), and disjoint runs cannot exceed
        # periods_per_week // L.
        achievable = 0 if cap < length else max(0, periods_per_week // length)
        eff_min = min(raw_min, achievable)
        if eff_min > 0 or raw_max > 0:
            blocks.append((length, eff_min, raw_max))
    max_subjects_part = (
        _to_int(_get_path(rule, "maxSubjects.sang", 0), 0),
        _to_int(_get_path(rule, "maxSubjects.chieu", 0), 0),
    )
    return SubjectRule(
        part_banned=part_banned,
        one_session_per_day=one_spd,
        weekly_part_cap=weekly_part_cap,
        day_cap=day_cap,
        session_part_cap=session_part_cap,
        max_sessions_week=max_sessions_week,
        spacing_days=spacing_days,
        avoid23=avoid23,
        avoid34=avoid34,
        linked_avoided=linked_avoided,
        lesson_blocks=tuple(blocks),
        max_subjects_part=max_subjects_part,
    )


# ---------------------------------------------------------------------------
# Compiled teacher rule bundle
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class TeacherRule:
    max_days: int = 0
    max_sessions: int = 0
    max_morning: int = 0
    max_afternoon: int = 0
    session_mode: tuple[str, ...] = ("",) * NUM_DAYS   # "", morning, afternoon, either
    day_period_cap: tuple[int, ...] = (0,) * NUM_DAYS
    session_period_cap: tuple[tuple[int, int], ...] = ((0, 0),) * NUM_DAYS  # (AM cap, PM cap)
    no_m5_a1: tuple[bool, ...] = (False,) * NUM_DAYS
    # (group_id_or_None(=all), subject_set_or_None, per_session, per_day)
    class_period_caps: tuple[tuple[frozenset | None, int, int], ...] = ()

    def is_default(self) -> bool:
        return (
            self.max_days == 0
            and self.max_sessions == 0
            and self.max_morning == 0
            and self.max_afternoon == 0
            and not any(self.session_mode)
            and not any(self.day_period_cap)
            and not any(cap for pair in self.session_period_cap for cap in pair)
            and not any(self.no_m5_a1)
            and not self.class_period_caps
        )


def compile_teacher_rule(rule: Mapping[str, Any], one_session_mode: Callable[[Any], str], constraints: Any) -> TeacherRule:
    session_mode = tuple(
        one_session_mode(_get_path(rule, f"oneSessionPerDay.{_DAY_KEYS[d]}", False))
        for d in range(NUM_DAYS)
    )
    day_cap = tuple(_to_int(_get_path(rule, f"maxPeriods.day.{_DAY_KEYS[d]}", 0), 0) for d in range(NUM_DAYS))
    sess_cap = tuple(
        (
            _to_int(_get_path(rule, f"maxPeriods.sang.{_DAY_KEYS[d]}", 0), 0),
            _to_int(_get_path(rule, f"maxPeriods.chieu.{_DAY_KEYS[d]}", 0), 0),
        )
        for d in range(NUM_DAYS)
    )
    no51 = tuple(
        _truthy(_get_path(rule, f"noMorningP5AfternoonP1.{_DAY_KEYS[d]}", False))
        or _truthy(_get_path(rule, f"noMorningP5AfternoonP1.sang.{_DAY_KEYS[d]}", False))
        for d in range(NUM_DAYS)
    )
    caps: list[tuple[frozenset | None, int, int]] = []
    mpc = rule.get("maxPeriodsClass") if isinstance(rule.get("maxPeriodsClass"), Mapping) else {}
    if isinstance(mpc, Mapping):
        entries: list[tuple[str, Mapping[str, Any]]] = []
        by_group = mpc.get("bySubjectGroup")
        if isinstance(by_group, Mapping):
            entries.extend((str(gid), conf) for gid, conf in by_group.items() if isinstance(conf, Mapping))
        if not entries and (_to_int(mpc.get("perSession"), 0) > 0 or _to_int(mpc.get("perDay"), 0) > 0):
            entries.append((str(mpc.get("subjectGroupId") or "__all__").strip() or "__all__", mpc))
        for gid, conf in entries:
            per_session = _to_int(conf.get("perSession"), 0)
            per_day = _to_int(conf.get("perDay"), 0)
            if per_session <= 0 and per_day <= 0:
                continue
            if gid in {"__all__", "all", ""}:
                subject_set = None
            else:
                subject_set = frozenset(constraints.group_items("subject", gid)) if constraints else frozenset()
            caps.append((subject_set, per_session, per_day))
    return TeacherRule(
        max_days=_to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0),
        max_sessions=_to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0),
        max_morning=_to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0),
        max_afternoon=_to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0),
        session_mode=session_mode,
        day_period_cap=day_cap,
        session_period_cap=sess_cap,
        no_m5_a1=no51,
        class_period_caps=tuple(caps),
    )


# ---------------------------------------------------------------------------
# Problem
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Problem:
    class_names: list[str]
    class_grades: list[str]
    teacher_names: list[str]
    subject_names: list[str]

    class_avail: list[bytearray]           # C x 60 (1 = class may study)
    teacher_avail: list[bytearray]         # T x 60 (1 = teacher may teach)

    a_class: list[int]
    a_subject: list[int]
    a_teacher: list[int]
    a_room: list[str]
    a_periods: list[int]
    a_cap: list[int]                       # max periods per session (upper bound)
    a_allowed: list[bytearray]             # per-assignment allowed slots (A x 60)
    a_rule: list[SubjectRule | None]       # merged subject(+group) rule or None

    teacher_rules: list[TeacherRule | None]
    teacher_must: list[frozenset[int]]     # slots that must contain a lesson

    # class -> list of frozenset(subject ids) that must not share a session/day
    no_same_session: list[list[frozenset[int]]]
    no_same_day: list[list[frozenset[int]]]

    fixed_cells: list[tuple[int, int, int]]  # (class, slot, assignment)

    # generic timeLimit rules kept raw; evaluated in scope checks (rare)
    time_limit_rules: tuple[Mapping[str, Any], ...] = ()
    subject_groups: dict[int, tuple[str, ...]] = field(default_factory=dict)  # subj id -> group ids
    group_rule_keys: dict[tuple[int, str], SubjectRule] = field(default_factory=dict)
    raw_groups: Mapping[str, Mapping[str, Any]] | None = None  # constraint groups (for timeLimit)
    _raw_groups: Mapping[str, Mapping[str, Any]] | None = None  # alias used by State

    def num_classes(self) -> int:
        return len(self.class_names)

    def num_teachers(self) -> int:
        return len(self.teacher_names)

    def num_assignments(self) -> int:
        return len(self.a_class)


def compile_problem(ctx: Any, rules: Any, fixed_lessons: list[Any]) -> Problem:
    """Compile UiDataContext + TimetableRuleSet (+ locked lessons) into arrays."""

    from tkb_optimizer_ref.models import Session
    from tkb_optimizer_ref.rules import one_session_per_day_mode
    from tkb_optimizer_ref.template import class_available_periods

    data = ctx.school_data
    constraints = rules.constraints if rules else None

    class_names = [c.name for c in data.classes]
    class_grades = [c.grade for c in data.classes]
    class_idx = {name: i for i, name in enumerate(class_names)}

    teacher_names = sorted({a.teacher for a in data.assignments if a.teacher})
    for lesson in fixed_lessons:
        if lesson.teacher and lesson.teacher not in teacher_names:
            teacher_names.append(lesson.teacher)
    teacher_idx = {name: i for i, name in enumerate(teacher_names)}

    subject_names = sorted({a.subject for a in data.assignments})
    for lesson in fixed_lessons:
        if lesson.subject and lesson.subject not in subject_names:
            subject_names.append(lesson.subject)
    subject_idx = {name: i for i, name in enumerate(subject_names)}

    # --- availability -----------------------------------------------------
    class_avail: list[bytearray] = []
    for ci, name in enumerate(class_names):
        mask = bytearray(NUM_SLOTS)
        for d in range(NUM_DAYS):
            for part in range(2):
                session = Session(day=d + 2, part="AM" if part == 0 else "PM")
                for period in class_available_periods(class_grades[ci], name, session, constraints):
                    if 1 <= period <= PERIODS:
                        mask[slot_of(d, part, period - 1)] = 1
        class_avail.append(mask)

    def _off(kind: str, item: str, d: int, part: int, p: int) -> bool:
        if constraints is None:
            return False
        return constraints.is_fixed_off(kind, item, d + 2, "AM" if part == 0 else "PM", p + 1)

    teacher_avail: list[bytearray] = []
    for t in teacher_names:
        mask = bytearray(b"\x01" * NUM_SLOTS)
        if constraints is not None:
            for d in range(NUM_DAYS):
                for part in range(2):
                    for p in range(PERIODS):
                        if _off("teacher", t, d, part, p):
                            mask[slot_of(d, part, p)] = 0
        teacher_avail.append(mask)

    # --- subject groups ---------------------------------------------------
    subject_groups: dict[int, tuple[str, ...]] = {}
    if constraints is not None:
        for name, si in subject_idx.items():
            groups = constraints.subject_groups_for(name)
            if groups:
                subject_groups[si] = tuple(groups)

    # --- assignments ------------------------------------------------------
    a_class: list[int] = []
    a_subject: list[int] = []
    a_teacher: list[int] = []
    a_room: list[str] = []
    a_periods: list[int] = []
    a_cap: list[int] = []
    a_allowed: list[bytearray] = []
    a_rule: list[SubjectRule | None] = []
    group_rule_keys: dict[tuple[int, str], SubjectRule] = {}

    for a in data.assignments:
        ci = class_idx[a.class_name]
        si = subject_idx[a.subject]
        ti = teacher_idx.get(a.teacher, -1)
        cap = max(1, int(a.max_periods_per_session))
        merged_rule: SubjectRule | None = None
        if constraints is not None:
            rule_maps = []
            base = constraints.subject_rule_for(a.class_name, a.subject)
            if isinstance(base, Mapping) and base:
                rule_maps.append(base)
            for gid, grule in constraints.subject_group_rules_for(a.class_name, a.subject):
                if isinstance(grule, Mapping) and grule:
                    rule_maps.append(grule)
                    compiled_group = compile_subject_rule(grule, int(a.periods_per_week), cap)
                    if not compiled_group.is_default():
                        group_rule_keys[(ci, gid)] = compiled_group
            if rule_maps:
                combined: dict[str, Any] = {}
                for rm in rule_maps:
                    _deep_merge(combined, rm)
                compiled = compile_subject_rule(combined, int(a.periods_per_week), cap)
                if not compiled.is_default():
                    merged_rule = compiled

        allowed = bytearray(NUM_SLOTS)
        tmask = teacher_avail[ti] if ti >= 0 else bytearray(b"\x01" * NUM_SLOTS)
        cmask = class_avail[ci]
        for slot in range(NUM_SLOTS):
            if not cmask[slot] or not tmask[slot]:
                continue
            d, rem = divmod(slot, 2 * PERIODS)
            part, p = divmod(rem, PERIODS)
            if merged_rule is not None and merged_rule.part_banned[part]:
                continue
            if _off("subject", a.subject, d, part, p):
                continue
            if a.room and _off("room", a.room, d, part, p):
                continue
            if constraints is not None and constraints.is_subject_group_fixed_off(
                a.subject, d + 2, "AM" if part == 0 else "PM", p + 1
            ):
                continue
            allowed[slot] = 1

        a_class.append(ci)
        a_subject.append(si)
        a_teacher.append(ti)
        a_room.append(a.room or "")
        a_periods.append(int(a.periods_per_week))
        a_cap.append(cap)
        a_allowed.append(allowed)
        a_rule.append(merged_rule)

    # --- teacher rules ----------------------------------------------------
    teacher_rules: list[TeacherRule | None] = []
    teacher_must: list[frozenset[int]] = []
    for t in teacher_names:
        tr: TeacherRule | None = None
        if constraints is not None:
            raw = constraints.teacher.get(t)
            if isinstance(raw, Mapping) and raw:
                compiled_t = compile_teacher_rule(raw, one_session_per_day_mode, constraints)
                if not compiled_t.is_default():
                    tr = compiled_t
        teacher_rules.append(tr)
        must: set[int] = set()
        if constraints is not None:
            for day, part_name, period in constraints.teacher_must_teach_slots(t):
                d = int(day) - 2
                part = 0 if str(part_name) == "AM" else 1
                if 0 <= d < NUM_DAYS and 1 <= int(period) <= PERIODS:
                    must.add(slot_of(d, part, int(period) - 1))
        teacher_must.append(frozenset(must))

    # --- class no-same groups --------------------------------------------
    no_same_session: list[list[frozenset[int]]] = [[] for _ in class_names]
    no_same_day: list[list[frozenset[int]]] = [[] for _ in class_names]
    if constraints is not None:
        for cname, groups in (constraints.subject_no_same_session or {}).items():
            ci = class_idx.get(cname)
            if ci is None or not isinstance(groups, Mapping):
                continue
            for subjects in groups.values():
                ids = frozenset(subject_idx[s] for s in subjects if s in subject_idx)
                if len(ids) >= 2:
                    no_same_session[ci].append(ids)
        for cname, groups in (constraints.subject_no_same_day or {}).items():
            ci = class_idx.get(cname)
            if ci is None or not isinstance(groups, Mapping):
                continue
            for subjects in groups.values():
                ids = frozenset(subject_idx[s] for s in subjects if s in subject_idx)
                if len(ids) >= 2:
                    no_same_day[ci].append(ids)

    # --- fixed lessons → locked cells ------------------------------------
    key_to_assignment: dict[tuple[int, int, int], int] = {}
    for ai in range(len(a_class)):
        key_to_assignment[(a_class[ai], a_subject[ai], a_teacher[ai])] = ai
    fixed_cells: list[tuple[int, int, int]] = []
    for lesson in fixed_lessons:
        ci = class_idx.get(lesson.class_name)
        si = subject_idx.get(lesson.subject)
        ti = teacher_idx.get(lesson.teacher, -1)
        if ci is None or si is None:
            continue
        ai = key_to_assignment.get((ci, si, ti))
        if ai is None:
            continue
        d = int(lesson.day) - 2
        part = 0 if lesson.session == "AM" else 1
        p = int(lesson.period) - 1
        if 0 <= d < NUM_DAYS and 0 <= p < PERIODS:
            fixed_cells.append((ci, slot_of(d, part, p), ai))

    time_limit_rules: tuple[Mapping[str, Any], ...] = ()
    if constraints is not None:
        from tkb_optimizer_ref.validate import _iter_limit_rules

        time_limit_rules = tuple(_iter_limit_rules(constraints))

    return Problem(
        class_names=class_names,
        class_grades=class_grades,
        teacher_names=teacher_names,
        subject_names=subject_names,
        class_avail=class_avail,
        teacher_avail=teacher_avail,
        a_class=a_class,
        a_subject=a_subject,
        a_teacher=a_teacher,
        a_room=a_room,
        a_periods=a_periods,
        a_cap=a_cap,
        a_allowed=a_allowed,
        a_rule=a_rule,
        teacher_rules=teacher_rules,
        teacher_must=teacher_must,
        no_same_session=no_same_session,
        no_same_day=no_same_day,
        fixed_cells=fixed_cells,
        time_limit_rules=time_limit_rules,
        subject_groups=subject_groups,
        group_rule_keys=group_rule_keys,
        raw_groups=(constraints.groups if constraints is not None else None),
        _raw_groups=(constraints.groups if constraints is not None else None),
    )


def _deep_merge(dst: dict, src: Mapping) -> None:
    for key, value in src.items():
        if isinstance(value, Mapping):
            node = dst.setdefault(key, {})
            if isinstance(node, dict):
                _deep_merge(node, value)
            else:
                dst[key] = dict(value)
        else:
            # First rule wins on scalar conflicts; caps merge to the tighter one
            if key in dst and isinstance(dst[key], (int, str)) and _to_int(dst[key], 0) > 0 and _to_int(value, 0) > 0:
                dst[key] = min(_to_int(dst[key], 0), _to_int(value, 0))
            else:
                dst.setdefault(key, value)
