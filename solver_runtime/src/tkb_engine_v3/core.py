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
import unicodedata
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Iterable, Mapping

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
    # 05/10: so BUOI TOI THIEU / tuan (maxDaysSessions.minSessions). Cung
    # maxSessions = "dung bang" (THCS An Phu: <=14 tiet 5 buoi, 15-19 = 6,
    # >=20 = 7). Chi kiem khi GV da xep du tiet (lich dang xay thi bo qua).
    min_sessions: int = 0
    max_morning: int = 0
    max_afternoon: int = 0
    session_mode: tuple[str, ...] = ("",) * NUM_DAYS   # "", morning, afternoon, either
    day_period_cap: tuple[int, ...] = (0,) * NUM_DAYS
    session_period_cap: tuple[tuple[int, int], ...] = ((0, 0),) * NUM_DAYS  # (AM cap, PM cap)
    no_m5_a1: tuple[bool, ...] = (False,) * NUM_DAYS
    # (group_id_or_None(=all), subject_set_or_None, per_session, per_day)
    class_period_caps: tuple[tuple[frozenset | None, int, int], ...] = ()
    # 23/08: yeu cau ve DIA DIEM (co so) theo tung buoi, chi so buoi
    # s = day*2 + part (0 = sang, 1 = chieu):
    #   loc_one  - "Chi day 1 dia diem/1 buoi"
    #   loc_gap  - "Co tiet trong giua 2 dia diem": hai tiet KE NHAU (lien tiet)
    #              khong duoc o 2 dia diem khac nhau -> phai co >= 1 tiet trong
    #              de di chuyen (tiet trong do la hop le).
    #   loc_move - "Khong di chuyen 2 lan/1 buoi": trong mot buoi GV chi duoc
    #              doi dia diem toi da 1 lan.
    #   loc_breaks - 03/09: "Doi dia diem o gio ra choi (tiet 2-3 / 3-4)".
    #              Moi buoi la tuple cac TIET (0-based) ma NGAY SAU tiet do la
    #              gio ra choi: moveAtBreak23 -> 1 (het tiet 2), moveAtBreak34
    #              -> 2 (het tiet 3). Doi dia diem giua hai tiet KE NHAU la HOP
    #              LE khi vuot qua ranh gioi nay (GV di chuyen trong gio ra
    #              choi); ranh gioi khac van phai co tiet trong nhu loc_gap.
    loc_one: tuple[bool, ...] = (False,) * NUM_SESSIONS
    loc_gap: tuple[bool, ...] = (False,) * NUM_SESSIONS
    loc_move: tuple[bool, ...] = (False,) * NUM_SESSIONS
    loc_breaks: tuple[tuple[int, ...], ...] = ((),) * NUM_SESSIONS

    def is_default(self) -> bool:
        return (
            self.max_days == 0
            and self.max_sessions == 0
            and self.min_sessions == 0
            and self.max_morning == 0
            and self.max_afternoon == 0
            and not any(self.session_mode)
            and not any(self.day_period_cap)
            and not any(cap for pair in self.session_period_cap for cap in pair)
            and not any(self.no_m5_a1)
            and not self.class_period_caps
            and not self.has_location_rules()
        )

    def has_location_rules(self) -> bool:
        return (
            any(self.loc_one)
            or any(self.loc_gap)
            or any(self.loc_move)
            or any(self.loc_breaks)
        )


def location_rule_debt(
    entries: list[tuple[int, int]],
    one: bool,
    gap: bool,
    move: bool,
    breaks: tuple[int, ...] = (),
) -> int:
    """So vi pham luat dia diem cua MOT buoi giao vien.

    ``entries``: [(tiet, dia_diem)] da sap theo tiet, chi gom o co dia diem
    (dia_diem >= 0). Cung mot cach tinh cho kiem tra cung (State) va diem phat
    mem (SoftSchedule) de hai ben luon dong y: 0 <=> buoi hop le. Ngu nghia
    khop evalTeacherRule trong web/pages/tkb-constraints.js:
      one   : so dia diem khac nhau trong buoi - 1
      gap   : moi cap tiet lien tiet (cach nhau <= 1 tiet) ma khac dia diem
      move  : so lan doi dia diem - 1 (neu doi > 1 lan)
      breaks: 03/09 - cac tiet (0-based) ma ngay sau do la gio ra choi. Co
              breaks thi doi dia diem lien tiet CHI hop le khi tiet truoc nam
              trong breaks; ranh gioi khac tinh vi pham y nhu gap. Bat cung luc
              gap + breaks = "phai co tiet trong, TRU khi doi o gio ra choi".
    """

    if len(entries) < 2:
        return 0
    debt = 0
    if one:
        debt += len({loc for _p, loc in entries}) - 1
    adjacent = gap or bool(breaks)
    if adjacent or move:
        changes = 0
        prev_p, prev_loc = entries[0]
        for p, loc in entries[1:]:
            if loc != prev_loc:
                changes += 1
                if adjacent and p - prev_p <= 1 and prev_p not in breaks:
                    debt += 1
            prev_p, prev_loc = p, loc
        if move and changes > 1:
            debt += changes - 1
    return debt


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
    def _loc_flags(name: str) -> tuple[bool, ...]:
        flags = [False] * NUM_SESSIONS
        for d in range(NUM_DAYS):
            for part, part_key in enumerate(("sang", "chieu")):
                if _truthy(_get_path(rule, f"{name}.{part_key}.{_DAY_KEYS[d]}", False)):
                    flags[d * 2 + part] = True
        return tuple(flags)

    # 03/09: gio ra choi -> tiet (0-based) ma ngay sau no la gio ra choi.
    brk23 = _loc_flags("moveAtBreak23")
    brk34 = _loc_flags("moveAtBreak34")
    loc_breaks = tuple(
        tuple(p for p, on in ((1, brk23[s]), (2, brk34[s])) if on)
        for s in range(NUM_SESSIONS)
    )

    return TeacherRule(
        max_days=_to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0),
        max_sessions=_to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0),
        min_sessions=_to_int(_get_path(rule, "maxDaysSessions.minSessions", 0), 0),
        max_morning=_to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0),
        max_afternoon=_to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0),
        session_mode=session_mode,
        day_period_cap=day_cap,
        session_period_cap=sess_cap,
        no_m5_a1=no51,
        class_period_caps=tuple(caps),
        loc_one=_loc_flags("oneLocationPerSession"),
        loc_gap=_loc_flags("gapBetweenLocations"),
        loc_move=_loc_flags("maxOneMovePerSession"),
        loc_breaks=loc_breaks,
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
    # 23/08: ten GV de XUAT ket qua cho cac phan cong "o co dinh dung chung"
    # (a_teacher = -1 de engine khong dem xung dot/thong ke GV, nhung tiet
    # tra ve van mang dung ma GV nhu phan cong). Rong cho phan cong thuong.
    a_teacher_label: list[str] = field(default_factory=list)
    # 25/08: MOI giao vien cua tung phan cong. Tiet DAY GHEP ("GV1, GV2": mot
    # mon, mot lop, hai GV cung day) -> (i1, i2); phan cong thuong -> (i,);
    # phan cong tong hop (a_teacher = -1) -> (). a_teacher[ai] la GV DAU TIEN
    # (dung cho cac heuristic "tiet cua GV t"); moi kiem tra CUNG (trung gio,
    # o nghi, luat GV, thong ke buoi day) phai xet ca tuple nay.
    a_teachers: list[tuple[int, ...]] = field(default_factory=list)
    # 23/08: dia diem (co so) cua tung phan cong (-1 = khong co), ten dia
    # diem, va co "GV nay co luat dia diem VA day o >= 2 dia diem" — chi khi
    # co moi phai kiem tra/phat (GV day 1 dia diem khong bao gio vi pham).
    a_loc: list[int] = field(default_factory=list)
    loc_names: list[str] = field(default_factory=list)
    teacher_loc_rules: list[bool] = field(default_factory=list)
    # 23/08: o CO DINH theo lop (C x 60). Luat phia lop ma chinh cac o co dinh
    # da vi pham (vd nguoi dung co dinh "Tich Hop" tiet 3-4 chieu trong khi mon
    # do co "tranh cap tiet 3-4") khong duoc chan engine xep phan con lai cua
    # lop — vi pham do van duoc bo kiem dinh bao cho nguoi dung.
    fixed_mask: list[bytearray] = field(default_factory=list)
    # 05/10: o GV BAN CO DINH vi tiet chung nhieu lop (o co dinh dung chung:
    # tiet ghep TANN/KNS chung khoi, chao co...) -> {o: phan cong tong hop}.
    # Phan cong tong hop co a_teachers = () nen truoc day engine KHONG dem cac o
    # nay vao thong ke buoi/buoi 1 tiet/trong va luat GV, trong khi giao dien
    # (validate) co dem: engine toi uu sai muc tieu va cong cua trinh duyet loai
    # ket qua (THCS An Phu kkhg52etp92). SoftSchedule/State/CP-SAT nap san cac
    # o nay nhu cho chiem cua GV.
    teacher_fixed_busy: list[dict[int, int]] = field(default_factory=list)

    def num_classes(self) -> int:
        return len(self.class_names)

    def num_teachers(self) -> int:
        return len(self.teacher_names)

    def num_assignments(self) -> int:
        return len(self.a_class)

    def teacher_label(self, ai: int) -> str:
        """Teacher code to export for assignment ``ai`` ("" when none).

        Tiet day ghep tra ve nhan gop "GV1, GV2" (a_teacher_label) de giao
        dien nhan dung phan cong; phan cong thuong tra ve ma GV.
        """

        if ai < len(self.a_teacher_label) and self.a_teacher_label[ai]:
            return self.a_teacher_label[ai]
        t = self.a_teacher[ai]
        if t >= 0:
            return self.teacher_names[t]
        return ""


def compile_problem(
    ctx: Any,
    rules: Any,
    fixed_lessons: list[Any],
    *,
    shared_teacher_slots: Iterable[tuple[str, int, str, int]] | None = None,
) -> Problem:
    """Compile UiDataContext + TimetableRuleSet (+ locked lessons) into arrays.

    ``shared_teacher_slots``: (teacher, day, session, period) cells that the
    user locked for ONE teacher in several classes at the same time (school-
    wide activity such as "sinh hoat duoi co"). Those fixed lessons become
    separate teacher-less assignments (``a_teacher = -1``, exported with the
    real teacher code via ``a_teacher_label``) so the engine never sees them
    as a teacher conflict, while the teacher is marked unavailable at those
    slots so none of their other lessons can be placed there.
    """

    from tkb_optimizer_ref.models import Session
    from tkb_optimizer_ref.rules import one_session_per_day_mode, teacher_members
    from tkb_optimizer_ref.template import class_available_periods

    data = ctx.school_data
    constraints = rules.constraints if rules else None
    shared_slots = {tuple(item) for item in (shared_teacher_slots or [])}

    class_names = [c.name for c in data.classes]
    class_grades = [c.grade for c in data.classes]
    class_idx = {name: i for i, name in enumerate(class_names)}

    # 25/08: "GV1, GV2" (tiet day ghep) KHONG phai la mot giao vien moi — chi
    # cac thanh vien moi la giao vien cua bai toan.
    teacher_names = sorted({m for a in data.assignments for m in teacher_members(a.teacher)})
    for lesson in fixed_lessons:
        for m in teacher_members(lesson.teacher):
            if m not in teacher_names:
                teacher_names.append(m)
    teacher_idx = {name: i for i, name in enumerate(teacher_names)}

    def _member_ids(teacher_value: Any) -> tuple[int, ...]:
        return tuple(
            teacher_idx[m] for m in teacher_members(teacher_value) if m in teacher_idx
        )

    def _is_shared(lesson: Any) -> bool:
        # 25/08: shared_slots duoc dem theo tung GV thanh vien (adapter
        # shared_fixed_teacher_slots) -> tiet day ghep la o dung chung khi BAT
        # KY thanh vien nao co o dung chung tai gio do.
        if not shared_slots:
            return False
        key = (int(lesson.day), str(lesson.session), int(lesson.period))
        return any((member, *key) in shared_slots for member in teacher_members(lesson.teacher))

    # shared fixed lessons grouped per (class, subject, teacher) -> slots
    shared_fixed: dict[tuple[str, str, str], list[int]] = {}
    for lesson in fixed_lessons:
        if not _is_shared(lesson):
            continue
        d = int(lesson.day) - 2
        part = 0 if lesson.session == "AM" else 1
        p = int(lesson.period) - 1
        if not (0 <= d < NUM_DAYS and 0 <= p < PERIODS):
            continue
        shared_fixed.setdefault(
            (lesson.class_name, lesson.subject, lesson.teacher), []
        ).append(slot_of(d, part, p))

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
    # 13/09 (chu du an: "Gioi han buoi day khi bam Cherry phai tuan thu"): luat GV
    # oneSessionPerDay "chi sang" / "chi chieu" cua mot ngay = GV BAN ca buoi con lai
    # cua ngay do -> dua thang vao mat na ranh GV de moi buoc (xep, sua, tabu,
    # CP-SAT) deu tuan thu tuyet doi thay vi chi phat mem trong teacher_rule_penalty
    # (do tren truong TEST: luat kha thi van con 21 cho vi pham sau Cherry). "Sang
    # hoac chieu" (either) phu thuoc luoi nen van la luat cung kiem o State. O co
    # dinh cua chinh GV trong buoi bi cam duoc giu (luat do nguoi dung tu dat).
    # "Sang hoac chieu" ma GV da co O CO DINH o dung mot buoi cua ngay (vd Chao co
    # tiet 1 sang cua GVCN) thi thuc chat la "chi buoi do" -> cam luon buoi kia
    # (do tren TEST: no loai nay khong go duoc vi o khoa, lich moi khong bao gio sach).
    teacher_fixed_slots: dict[int, set[int]] = {}
    if constraints is not None:
        for lesson in fixed_lessons:
            d = int(lesson.day) - 2
            part = 0 if lesson.session == "AM" else 1
            p = int(lesson.period) - 1
            if not (0 <= d < NUM_DAYS and 0 <= p < PERIODS):
                continue
            for ti in _member_ids(lesson.teacher):
                teacher_fixed_slots.setdefault(ti, set()).add(slot_of(d, part, p))
        for ti, t in enumerate(teacher_names):
            raw_rule = constraints.teacher.get(t) if isinstance(getattr(constraints, "teacher", None), Mapping) else None
            if not isinstance(raw_rule, Mapping) or not raw_rule.get("oneSessionPerDay"):
                continue
            keep = teacher_fixed_slots.get(ti, set())
            for d in range(NUM_DAYS):
                mode = one_session_per_day_mode(_get_path(raw_rule, f"oneSessionPerDay.{_DAY_KEYS[d]}", False))
                banned_part = 1 if mode == "morning" else (0 if mode == "afternoon" else -1)
                if mode == "either" and keep:
                    fixed_am = any(slot_of(d, 0, p) in keep for p in range(PERIODS))
                    fixed_pm = any(slot_of(d, 1, p) in keep for p in range(PERIODS))
                    if fixed_am != fixed_pm:
                        banned_part = 1 if fixed_am else 0
                if banned_part < 0:
                    continue
                for p in range(PERIODS):
                    slot = slot_of(d, banned_part, p)
                    if slot not in keep:
                        teacher_avail[ti][slot] = 0
    # GV dang o o co dinh dung chung (nhieu lop cung gio) -> ban tai gio do cho
    # moi phan cong khac cua GV; chinh cac o do duoc giu boi phan cong tong hop
    # ben duoi (a_teacher = -1) nen khong bi mat na nay chan.
    # 25/08: chan MOI thanh vien cua tung o dung chung (ke ca GV chi xuat hien
    # trong tiet ghep) — phan cong tong hop (a_teacher = -1) khong giu cho GV.
    for lesson in fixed_lessons:
        if not _is_shared(lesson):
            continue
        d = int(lesson.day) - 2
        part = 0 if lesson.session == "AM" else 1
        p = int(lesson.period) - 1
        if not (0 <= d < NUM_DAYS and 0 <= p < PERIODS):
            continue
        for ti in _member_ids(lesson.teacher):
            teacher_avail[ti][slot_of(d, part, p)] = 0

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
    a_teacher_label: list[str] = []
    a_teachers: list[tuple[int, ...]] = []
    group_rule_keys: dict[tuple[int, str], SubjectRule] = {}
    # (class, subject, teacher) -> synthetic assignment index for shared cells
    shared_assignment: dict[tuple[str, str, str], int] = {}
    pending_shared: list[tuple[tuple[str, str, str], int, int, int, str, int, SubjectRule | None, list[int]]] = []

    for a in data.assignments:
        ci = class_idx[a.class_name]
        si = subject_idx[a.subject]
        member_ids = _member_ids(a.teacher)
        ti = member_ids[0] if member_ids else -1
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
        if member_ids:
            # tiet day ghep: chi xep duoc khi MOI giao vien thanh vien ranh
            tmask = bytearray(teacher_avail[member_ids[0]])
            for extra in member_ids[1:]:
                extra_mask = teacher_avail[extra]
                for slot in range(NUM_SLOTS):
                    if not extra_mask[slot]:
                        tmask[slot] = 0
        else:
            tmask = bytearray(b"\x01" * NUM_SLOTS)
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

        shared_key = (a.class_name, a.subject, a.teacher)
        shared_slots_of_a = shared_fixed.get(shared_key)
        periods = int(a.periods_per_week)
        if shared_slots_of_a and shared_key not in shared_assignment:
            # Phan cong thuong chi giu phan tiet KHONG nam o o dung chung; phan
            # o dung chung do phan cong tong hop (them sau vong lap) gom.
            shared_count = min(periods, len(shared_slots_of_a))
            periods -= shared_count
            shared_assignment[shared_key] = -1  # placeholder, set below
            pending_shared.append(
                (shared_key, ci, si, ti, a.room or "", cap, merged_rule, list(shared_slots_of_a)[:shared_count])
            )

        a_class.append(ci)
        a_subject.append(si)
        a_teacher.append(ti)
        a_teachers.append(member_ids)
        a_room.append(a.room or "")
        a_periods.append(periods)
        a_cap.append(cap)
        a_allowed.append(allowed)
        a_rule.append(merged_rule)
        a_teacher_label.append(str(a.teacher or "") if len(member_ids) > 1 else "")

    # phan cong tong hop -> GV thanh vien (de nap o ban co dinh, xem teacher_fixed_busy)
    shared_members: dict[int, tuple[int, ...]] = {}
    for shared_key, ci, si, ti, room, cap, merged_rule, slots in pending_shared:
        allowed = bytearray(NUM_SLOTS)
        for slot in slots:
            allowed[slot] = 1
        shared_members[len(a_class)] = _member_ids(shared_key[2])
        shared_assignment[shared_key] = len(a_class)
        a_class.append(ci)
        a_subject.append(si)
        a_teacher.append(-1)
        a_teachers.append(())
        a_room.append(room)
        a_periods.append(len(slots))
        a_cap.append(cap)
        a_allowed.append(allowed)
        a_rule.append(merged_rule)
        a_teacher_label.append(str(shared_key[2] or "") or (teacher_names[ti] if ti >= 0 else ""))

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
    # 13/09: O CO DINH cua GV nam dung buoi "Gioi han buoi day" cam (nguoi dung tu dat
    # mau thuan, vd GVCN "chi sang" thu 2 ma Chao co co dinh buoi chieu): mat na ranh
    # o tren da cam moi o KHAC cua buoi do, nen bo session_mode ngay do. Neu giu, no
    # do o khoa gay ra khong bao gio go duoc -> lich moi khong bao gio "sach" (bo qua
    # toi uu chat luong), lich warm luon bi tu choi va xay lai tu dau. validate.py
    # van bao mau thuan nay cho nguoi dung.
    for ti, tr in enumerate(teacher_rules):
        keep = teacher_fixed_slots.get(ti)
        if tr is None or not keep or not any(tr.session_mode):
            continue
        modes = list(tr.session_mode)
        for d, mode in enumerate(modes):
            fixed_am = any(slot_of(d, 0, p) in keep for p in range(PERIODS))
            fixed_pm = any(slot_of(d, 1, p) in keep for p in range(PERIODS))
            if (mode == "morning" and fixed_pm) or (mode == "afternoon" and fixed_am) or (
                mode == "either" and fixed_am and fixed_pm
            ):
                modes[d] = ""
        if tuple(modes) != tuple(tr.session_mode):
            teacher_rules[ti] = replace(tr, session_mode=tuple(modes))

    # --- class no-same groups --------------------------------------------
    no_same_session: list[list[frozenset[int]]] = [[] for _ in class_names]
    no_same_day: list[list[frozenset[int]]] = [[] for _ in class_names]
    if constraints is not None:
        rule_subject = getattr(constraints, "rule_subject", None)

        def _no_same_ids(subjects: Any) -> frozenset[int]:
            wanted = set(subjects)
            ids = {subject_idx[s] for s in wanted if s in subject_idx}
            # 31/08: mon day ghep (khoa rieng) tham gia nhom "khong cung buoi/ngay" cua mon goc
            if callable(rule_subject):
                for name, si in subject_idx.items():
                    base = rule_subject(name)
                    if base != name and base in wanted:
                        ids.add(si)
            return frozenset(ids)

        for cname, groups in (constraints.subject_no_same_session or {}).items():
            ci = class_idx.get(cname)
            if ci is None or not isinstance(groups, Mapping):
                continue
            for subjects in groups.values():
                ids = _no_same_ids(subjects)
                if len(ids) >= 2:
                    no_same_session[ci].append(ids)
        for cname, groups in (constraints.subject_no_same_day or {}).items():
            ci = class_idx.get(cname)
            if ci is None or not isinstance(groups, Mapping):
                continue
            for subjects in groups.values():
                ids = _no_same_ids(subjects)
                if len(ids) >= 2:
                    no_same_day[ci].append(ids)

    # --- fixed lessons → locked cells ------------------------------------
    key_to_assignment: dict[tuple[int, int, int], int] = {}
    real_assignment_count = len(a_class) - len(pending_shared)
    for ai in range(real_assignment_count):
        key_to_assignment[(a_class[ai], a_subject[ai], a_teacher[ai])] = ai
    fixed_cells: list[tuple[int, int, int]] = []
    shared_cell_budget: dict[int, int] = {}
    for lesson in fixed_lessons:
        ci = class_idx.get(lesson.class_name)
        si = subject_idx.get(lesson.subject)
        lesson_members = _member_ids(lesson.teacher)
        ti = lesson_members[0] if lesson_members else -1
        if ci is None or si is None:
            continue
        d = int(lesson.day) - 2
        part = 0 if lesson.session == "AM" else 1
        p = int(lesson.period) - 1
        if not (0 <= d < NUM_DAYS and 0 <= p < PERIODS):
            continue
        slot = slot_of(d, part, p)
        ai = None
        if _is_shared(lesson):
            shared_ai = shared_assignment.get((lesson.class_name, lesson.subject, lesson.teacher), -1)
            if shared_ai >= 0 and a_allowed[shared_ai][slot]:
                used = shared_cell_budget.get(shared_ai, 0)
                if used < a_periods[shared_ai]:
                    shared_cell_budget[shared_ai] = used + 1
                    ai = shared_ai
        if ai is None:
            ai = key_to_assignment.get((ci, si, ti))
        if ai is None:
            continue
        fixed_cells.append((ci, slot, ai))

    time_limit_rules: tuple[Mapping[str, Any], ...] = ()
    if constraints is not None:
        from tkb_optimizer_ref.validate import _iter_limit_rules

        time_limit_rules = tuple(_iter_limit_rules(constraints))

    # --- dia diem (co so) ----------------------------------------------------
    # Cung ngu nghia voi roomLocation() cua giao dien: co phong -> phong la
    # dia diem (phong khong co truong dia diem rieng trong app), khong co
    # phong -> dia diem cua lop. Chi GV co luat dia diem va day >= 2 dia diem
    # moi bat kiem tra, nen truong 1 co so / khong bat luat khong doi gi.
    class_location = {c.name: str(getattr(c, "location", "") or "").strip() for c in data.classes}
    loc_idx: dict[str, int] = {}
    loc_names: list[str] = []
    a_loc: list[int] = []
    for ai in range(len(a_class)):
        loc_text = str(a_room[ai] or "").strip() or class_location.get(class_names[a_class[ai]], "")
        # cung cach chuan hoa voi norm() cua giao dien: NFC + gop khoang trang + thuong
        loc_text = " ".join(unicodedata.normalize("NFC", loc_text).split()).casefold()
        if not loc_text:
            a_loc.append(-1)
            continue
        li = loc_idx.get(loc_text)
        if li is None:
            li = len(loc_names)
            loc_idx[loc_text] = li
            loc_names.append(loc_text)
        a_loc.append(li)
    # 05/10: o GV ban co dinh vi tiet chung nhieu lop (phan cong tong hop).
    teacher_fixed_busy: list[dict[int, int]] = [dict() for _ in teacher_names]
    for _c, slot, ai in fixed_cells:
        for ti in shared_members.get(ai, ()):
            teacher_fixed_busy[ti].setdefault(slot, ai)
    teacher_locs: list[set[int]] = [set() for _ in teacher_names]
    for ai in range(len(a_class)):
        if a_loc[ai] >= 0:
            for ti in a_teachers[ai]:
                teacher_locs[ti].add(a_loc[ai])
    for ti, busy in enumerate(teacher_fixed_busy):
        for ai in busy.values():
            if a_loc[ai] >= 0:
                teacher_locs[ti].add(a_loc[ai])
    teacher_loc_rules = [
        bool(tr is not None and tr.has_location_rules() and len(teacher_locs[ti]) >= 2)
        for ti, tr in enumerate(teacher_rules)
    ]
    fixed_mask = [bytearray(NUM_SLOTS) for _ in class_names]
    for c, slot, _ai in fixed_cells:
        fixed_mask[c][slot] = 1

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
        a_teacher_label=a_teacher_label,
        a_teachers=a_teachers,
        a_loc=a_loc,
        loc_names=loc_names,
        teacher_loc_rules=teacher_loc_rules,
        fixed_mask=fixed_mask,
        teacher_fixed_busy=teacher_fixed_busy,
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
