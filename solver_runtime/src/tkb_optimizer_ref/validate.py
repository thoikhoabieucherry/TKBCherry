from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Mapping

from .models import Lesson, SchoolData
from .rules import TimetableRuleSet, one_session_per_day_mode, resolve_rule_set
from .template import all_sessions, class_available_periods, class_sort_key


def _is_contiguous(periods: list[int]) -> bool:
    if len(periods) < 2:
        return True
    ordered = sorted(periods)
    return ordered == list(range(ordered[0], ordered[0] + len(ordered)))


def _day_key(day: int) -> str:
    return f"thu{int(day)}"


def _session_key(part: str) -> str:
    return "sang" if part == "AM" else "chieu"


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


def _limit_for_slot(rule: Mapping[str, Any], field: str, day: int, part: str) -> int:
    by_session = rule.get("perSlotBySession", {}) if isinstance(rule.get("perSlotBySession"), Mapping) else {}
    session_key = _session_key(part)
    day_key = _day_key(day)
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


def _linked_day_avoided(linked: Mapping[str, Any] | None, session_key: str, day_key: str) -> bool:
    if not isinstance(linked, Mapping):
        return False
    checked = _truthy(_get_path(linked, f"{session_key}.{day_key}", False))
    if str(linked.get("mode") or "").lower() == "avoid":
        return checked
    if "enabled" in linked:
        return _truthy(linked.get("enabled")) and not checked
    return checked


def _violation(kind: str, message: str, **payload: Any) -> dict[str, Any]:
    return {"kind": kind, "message": message, **payload}


def _lesson_matches_limit(lesson: Lesson, rule: Mapping[str, Any], constraints: Any) -> bool:
    target_type = str(rule.get("targetType") or "")
    target_id = str(rule.get("targetId") or "")
    if target_type == "class":
        return lesson.class_name == target_id
    if target_type == "teacher":
        return lesson.teacher == target_id
    if target_type == "subject":
        return lesson.subject == target_id
    if target_type == "room":
        return bool(lesson.room) and lesson.room == target_id
    if target_type == "subjectGroup":
        return constraints.subject_in_group(lesson.subject, target_id)
    if target_type == "teacherGroup":
        return lesson.teacher in constraints.group_items("teacher", target_id)
    if target_type == "classGroup":
        return lesson.class_name in constraints.group_items("class", target_id)
    if target_type == "roomGroup":
        return bool(lesson.room) and lesson.room in constraints.group_items("room", target_id)
    return False


def _iter_limit_rules(constraints: Any) -> list[Mapping[str, Any]]:
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


def _count_blocks(periods: list[int], length: int) -> int:
    ordered = sorted(set(periods))
    period_set = set(ordered)
    return sum(
        1
        for period in ordered
        if period - 1 not in period_set and all(period + offset in period_set for offset in range(length))
    )


def _iter_teacher_class_period_configs(rule: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    mpc = rule.get("maxPeriodsClass") if isinstance(rule.get("maxPeriodsClass"), Mapping) else {}
    if not isinstance(mpc, Mapping):
        return []
    out: list[tuple[str, Mapping[str, Any]]] = []
    by_group = mpc.get("bySubjectGroup")
    if isinstance(by_group, Mapping):
        out.extend((str(group_id), conf) for group_id, conf in by_group.items() if isinstance(conf, Mapping))
    if not out and (_to_int(mpc.get("perSession"), 0) > 0 or _to_int(mpc.get("perDay"), 0) > 0):
        group_id = str(mpc.get("subjectGroupId") or "__all__").strip() or "__all__"
        out.append((group_id, mpc))
    return out


def validate_app_constraints(data: SchoolData, lessons: list[Lesson], rules: TimetableRuleSet | None = None) -> dict[str, Any]:
    """Validate constraints imported from the original browser UI.

    MILP enforces the common hard cases directly. This validator remains the
    source of truth for API reporting and catches aggregate rules that are not
    cheap to encode as model constraints.
    """

    rule_set = resolve_rule_set(rules)
    constraints = rule_set.constraints
    if constraints is None or not constraints.active:
        return {"hard_ok": True, "violations": [], "warnings": [], "unsupported": []}

    violations: list[dict[str, Any]] = []
    warnings: list[str] = []
    unsupported: set[str] = set()
    by_teacher_session: dict[tuple[str, int, str], list[Lesson]] = defaultdict(list)
    by_teacher_day: dict[tuple[str, int], list[Lesson]] = defaultdict(list)
    by_class_subject: dict[tuple[str, str], list[Lesson]] = defaultdict(list)
    by_class_group: dict[tuple[str, str], list[Lesson]] = defaultdict(list)
    by_slot: dict[tuple[int, str, int], list[Lesson]] = defaultdict(list)

    for lesson in lessons:
        by_teacher_session[(lesson.teacher, lesson.day, lesson.session)].append(lesson)
        by_teacher_day[(lesson.teacher, lesson.day)].append(lesson)
        by_class_subject[(lesson.class_name, lesson.subject)].append(lesson)
        by_slot[(lesson.day, lesson.session, lesson.period)].append(lesson)
        for group_id in constraints.subject_groups_for(lesson.subject):
            by_class_group[(lesson.class_name, group_id)].append(lesson)

        fixed_checks = [
            ("class", lesson.class_name),
            ("teacher", lesson.teacher),
            ("subject", lesson.subject),
        ]
        if lesson.room:
            fixed_checks.append(("room", lesson.room))
        for kind, item_id in fixed_checks:
            if constraints.is_fixed_off(kind, item_id, lesson.day, lesson.session, lesson.period):
                violations.append(
                    _violation(
                        f"fixedOff.{kind}",
                        f"{kind} {item_id} nghỉ cố định tại Thứ {lesson.day} {lesson.session} tiết {lesson.period}.",
                        class_name=lesson.class_name,
                        subject=lesson.subject,
                        teacher=lesson.teacher,
                        room=lesson.room,
                        day=lesson.day,
                        session=lesson.session,
                        period=lesson.period,
                    )
                )
        if constraints.is_subject_group_fixed_off(lesson.subject, lesson.day, lesson.session, lesson.period):
            violations.append(
                _violation(
                    "fixedOff.subjectGroup",
                    f"Nhóm môn của {lesson.subject} nghỉ cố định tại Thứ {lesson.day} {lesson.session} tiết {lesson.period}.",
                    class_name=lesson.class_name,
                    subject=lesson.subject,
                    day=lesson.day,
                    session=lesson.session,
                    period=lesson.period,
                )
            )

    for teacher, rule in constraints.teacher.items():
        if not isinstance(rule, Mapping):
            continue
        sessions = {(day, part) for (gv, day, part), items in by_teacher_session.items() if gv == teacher and items}
        max_days = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
        if max_days > 0 and len({day for day, _part in sessions}) > max_days:
            violations.append(_violation("teacher.maxDays", f"{teacher}: vượt số ngày dạy/tuần.", teacher=teacher))
        max_sessions = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
        if max_sessions > 0 and len(sessions) > max_sessions:
            violations.append(_violation("teacher.maxSessions", f"{teacher}: vượt số buổi dạy/tuần.", teacher=teacher))
        max_morning = _to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0)
        if max_morning > 0 and len({day for day, part in sessions if part == "AM"}) > max_morning:
            violations.append(_violation("teacher.maxMorning", f"{teacher}: vượt số buổi sáng.", teacher=teacher))
        max_afternoon = _to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0)
        if max_afternoon > 0 and len({day for day, part in sessions if part == "PM"}) > max_afternoon:
            violations.append(_violation("teacher.maxAfternoon", f"{teacher}: vượt số buổi chiều.", teacher=teacher))

        for day in range(2, 8):
            day_items = by_teacher_day.get((teacher, day), [])
            dk = _day_key(day)
            session_mode = one_session_per_day_mode(
                _get_path(rule, f"oneSessionPerDay.{dk}", False)
            )
            taught_sessions = {item.session for item in day_items}
            if session_mode == "morning" and "PM" in taught_sessions:
                violations.append(
                    _violation(
                        "teacher.oneSessionPerDay",
                        f"{teacher}: Thứ {day} chỉ được dạy buổi sáng.",
                        teacher=teacher,
                        day=day,
                        mode=session_mode,
                    )
                )
            elif session_mode == "afternoon" and "AM" in taught_sessions:
                violations.append(
                    _violation(
                        "teacher.oneSessionPerDay",
                        f"{teacher}: Thứ {day} chỉ được dạy buổi chiều.",
                        teacher=teacher,
                        day=day,
                        mode=session_mode,
                    )
                )
            elif session_mode == "either" and {"AM", "PM"}.issubset(taught_sessions):
                violations.append(
                    _violation(
                        "teacher.oneSessionPerDay",
                        f"{teacher}: Thứ {day} có cả sáng và chiều.",
                        teacher=teacher,
                        day=day,
                        mode=session_mode,
                    )
                )
            day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{dk}", 0), 0)
            if day_limit > 0 and len(day_items) > day_limit:
                violations.append(_violation("teacher.maxPeriods.day", f"{teacher}: Thứ {day} vượt số tiết/ngày.", teacher=teacher, day=day))
            if _truthy(_get_path(rule, f"noMorningP5AfternoonP1.{dk}", False)) or _truthy(_get_path(rule, f"noMorningP5AfternoonP1.sang.{dk}", False)):
                if any(x.session == "AM" and x.period == 5 for x in day_items) and any(x.session == "PM" and x.period == 1 for x in day_items):
                    violations.append(_violation("teacher.noMorningP5AfternoonP1", f"{teacher}: Thứ {day} có tiết 5 sáng và tiết 1 chiều.", teacher=teacher, day=day))

        for (gv, day, part), items in by_teacher_session.items():
            if gv != teacher:
                continue
            sk = _session_key(part)
            dk = _day_key(day)
            session_limit = _to_int(_get_path(rule, f"maxPeriods.{sk}.{dk}", 0), 0)
            if session_limit > 0 and len(items) > session_limit:
                violations.append(_violation("teacher.maxPeriods.session", f"{teacher}: Thứ {day} {part} vượt số tiết/buổi.", teacher=teacher, day=day, session=part))
            for move_rule in ("oneLocationPerSession", "gapBetweenLocations", "maxOneMovePerSession"):
                if not _truthy(_get_path(rule, f"{move_rule}.{sk}.{dk}", False)):
                    continue
                with_room = sorted(items, key=lambda item: item.period)
                rooms = [x.room or "__UNKNOWN_ROOM__" for x in with_room]
                compact_rooms = [room for index, room in enumerate(rooms) if index == 0 or room != rooms[index - 1]]
                if move_rule == "oneLocationPerSession" and len(set(rooms)) > 1:
                    violations.append(_violation("teacher.oneLocationPerSession", f"{teacher}: Thứ {day} {part} có nhiều địa điểm.", teacher=teacher, day=day, session=part))
                if move_rule == "maxOneMovePerSession" and len(compact_rooms) > 2:
                    violations.append(_violation("teacher.maxOneMovePerSession", f"{teacher}: Thứ {day} {part} di chuyển quá 1 lần.", teacher=teacher, day=day, session=part))
                if move_rule == "gapBetweenLocations":
                    for prev, cur in zip(with_room, with_room[1:]):
                        if prev.room != cur.room and cur.period - prev.period <= 1:
                            violations.append(_violation("teacher.gapBetweenLocations", f"{teacher}: Thứ {day} {part} đổi địa điểm không có tiết trống.", teacher=teacher, day=day, session=part))
                            break

        for group_id, conf in _iter_teacher_class_period_configs(rule):
            per_session = _to_int(conf.get("perSession"), 0)
            per_day = _to_int(conf.get("perDay"), 0)
            if per_session <= 0 and per_day <= 0:
                continue

            def subject_allowed(subject: str) -> bool:
                return group_id in {"__all__", "all", ""} or constraints.subject_in_group(subject, group_id)

            class_names = sorted({lesson.class_name for lesson in lessons if lesson.teacher == teacher and subject_allowed(lesson.subject)})
            for class_name in class_names:
                if per_session > 0:
                    for (gv, day, part), items in by_teacher_session.items():
                        if gv != teacher:
                            continue
                        matched = [item for item in items if item.class_name == class_name and subject_allowed(item.subject)]
                        if len(matched) > per_session:
                            violations.append(
                                _violation(
                                    "teacher.maxPeriodsClass.session",
                                    f"{teacher}: lớp {class_name} Thứ {day} {part} vượt số tiết dạy/1 lớp/1 buổi.",
                                    teacher=teacher,
                                    class_name=class_name,
                                    day=day,
                                    session=part,
                                    group_id=group_id,
                                )
                            )
                if per_day > 0:
                    for (gv, day), items in by_teacher_day.items():
                        if gv != teacher:
                            continue
                        matched = [item for item in items if item.class_name == class_name and subject_allowed(item.subject)]
                        if len(matched) > per_day:
                            violations.append(
                                _violation(
                                    "teacher.maxPeriodsClass.day",
                                    f"{teacher}: lớp {class_name} Thứ {day} vượt số tiết dạy/1 lớp/1 ngày.",
                                    teacher=teacher,
                                    class_name=class_name,
                                    day=day,
                                    group_id=group_id,
                                )
                            )

    for teacher, slots in (constraints.teacher_must_teach or {}).items():
        for day, part, period in sorted(slots):
            items = by_teacher_session.get((teacher, day, part), [])
            if not any(item.period == period for item in items):
                violations.append(
                    _violation(
                        "teacher.mustTeach",
                        f"{teacher}: Thứ {day} {part} tiết {period} phải có tiết dạy.",
                        teacher=teacher,
                        day=day,
                        session=part,
                        period=period,
                    )
                )

    def check_subject_like(kind: str, label: str, items: list[Lesson], rule: Mapping[str, Any]) -> None:
        if not items:
            return
        allowed = rule.get("sessionAllowed") if isinstance(rule.get("sessionAllowed"), Mapping) else {}
        if allowed:
            if allowed.get("allowMorning") is False and any(x.session == "AM" for x in items):
                violations.append(_violation(f"{kind}.sessionAllowed", f"{label}: không được học buổi sáng."))
            if allowed.get("allowAfternoon") is False and any(x.session == "PM" for x in items):
                violations.append(_violation(f"{kind}.sessionAllowed", f"{label}: không được học buổi chiều."))
            if _truthy(allowed.get("oneSessionPerDay")):
                for day in sorted({x.day for x in items}):
                    if {"AM", "PM"}.issubset({x.session for x in items if x.day == day}):
                        violations.append(_violation(f"{kind}.oneSessionPerDay", f"{label}: Thứ {day} có cả sáng và chiều."))
        for path, session_name in (("weeklySessionPeriods.morning", "AM"), ("weeklySessionPeriods.afternoon", "PM")):
            limit = _to_int(_get_path(rule, path, 0), 0)
            if limit > 0 and sum(1 for x in items if x.session == session_name) > limit:
                violations.append(_violation(f"{kind}.{path}", f"{label}: vượt {path}."))
        for day in sorted({x.day for x in items}):
            day_items = [x for x in items if x.day == day]
            day_limit = _day_limit_from_rule(rule, "maxPeriods.day", day)
            if day_limit > 0 and len(day_items) > day_limit:
                violations.append(_violation(f"{kind}.maxPeriods.day", f"{label}: Thứ {day} vượt số tiết/ngày."))
            for part in ("AM", "PM"):
                session_items = [x for x in day_items if x.session == part]
                limit = _to_int(_get_path(rule, f"maxPeriods.{_session_key(part)}", 0), 0)
                if limit > 0 and len(session_items) > limit:
                    violations.append(_violation(f"{kind}.maxPeriods.session", f"{label}: Thứ {day} {part} vượt số tiết/buổi."))
                max_subjects = _to_int(_get_path(rule, f"maxSubjects.{_session_key(part)}", 0), 0)
                if max_subjects > 0 and len({x.subject for x in session_items}) > max_subjects:
                    violations.append(_violation(f"{kind}.maxSubjects.session", f"{label}: Thứ {day} {part} vượt số môn/buổi."))
                periods = sorted(x.period for x in session_items)
                period_key = "morning" if part == "AM" else "afternoon"
                legacy = rule.get("avoidBreakPairs") if isinstance(rule.get("avoidBreakPairs"), Mapping) else {}
                avoid_23 = rule.get("avoidBreakPair23") if isinstance(rule.get("avoidBreakPair23"), Mapping) else {}
                avoid_34 = rule.get("avoidBreakPair34") if isinstance(rule.get("avoidBreakPair34"), Mapping) else {}
                if (_truthy(legacy.get(period_key)) or _truthy(avoid_23.get(period_key))) and {2, 3}.issubset(periods):
                    violations.append(_violation(f"{kind}.avoidBreakPair23", f"{label}: Thứ {day} {part} có cặp tiết 2-3 bị tránh."))
                if (_truthy(legacy.get(period_key)) or _truthy(avoid_34.get(period_key))) and {3, 4}.issubset(periods):
                    violations.append(_violation(f"{kind}.avoidBreakPair34", f"{label}: Thứ {day} {part} có cặp tiết 3-4 bị tránh."))
                linked = rule.get("linkedDays") if isinstance(rule.get("linkedDays"), Mapping) else {}
                if len(periods) > 1 and _is_contiguous(periods) and _linked_day_avoided(linked, _session_key(part), _day_key(day)):
                    violations.append(_violation(f"{kind}.linkedDays", f"{label}: Thứ {day} {part} tránh xếp tiết liền."))
        max_sessions = _to_int(_get_path(rule, "maxSessions.day", 0), 0)
        if max_sessions > 0 and len({(x.day, x.session) for x in items}) > max_sessions:
            violations.append(_violation(f"{kind}.maxSessions", f"{label}: vượt số buổi học/tuần."))
        spacing = _to_int(_get_path(rule, "spacingDays.days", 0), 0)
        if spacing > 0:
            used_days = sorted({x.day for x in items})
            for left, right in zip(used_days, used_days[1:]):
                if right - left <= spacing:
                    violations.append(_violation(f"{kind}.spacingDays", f"{label}: học quá gần ngày nhau."))
                    break
        lesson_blocks = rule.get("lessonBlocks") if isinstance(rule.get("lessonBlocks"), Mapping) else {}
        for length in (2, 3, 4, 5):
            conf = lesson_blocks.get(str(length)) or lesson_blocks.get(length)
            if not isinstance(conf, Mapping):
                continue
            blocks = sum(
                _count_blocks([x.period for x in items if x.day == day and x.session == part], length)
                for day in sorted({x.day for x in items})
                for part in ("AM", "PM")
            )
            minimum = _to_int(conf.get("min"), 0)
            maximum = _to_int(conf.get("max"), 0)
            if minimum > 0 and blocks < minimum:
                violations.append(_violation(f"{kind}.lessonBlocks.min", f"{label}: chưa đạt Min cụm {length} tiết liền."))
            if maximum > 0 and blocks > maximum:
                violations.append(_violation(f"{kind}.lessonBlocks.max", f"{label}: vượt Max cụm {length} tiết liền."))

    for (class_name, subject), items in by_class_subject.items():
        rule = constraints.subject_rule_for(class_name, subject)
        if isinstance(rule, Mapping) and rule:
            check_subject_like("subject", f"{class_name} - {subject}", items, rule)
    for (class_name, group_id), items in by_class_group.items():
        root = constraints.subject_group.get(group_id, {})
        by_class = root.get("byClass", {}) if isinstance(root, Mapping) else {}
        rule = by_class.get(class_name, {}) if isinstance(by_class, Mapping) else {}
        if isinstance(rule, Mapping) and rule:
            check_subject_like("subjectGroup", f"{class_name} - nhóm {constraints.group_name('subject', group_id)}", items, rule)

    for class_name, groups in (constraints.subject_no_same_session or {}).items():
        if not isinstance(groups, Mapping):
            continue
        for group_id, subjects in groups.items():
            if len(subjects) < 2:
                continue
            subject_set = set(subjects)
            for day in sorted({lesson.day for lesson in lessons if lesson.class_name == class_name}):
                for part in ("AM", "PM"):
                    matched_subjects = sorted({
                        lesson.subject
                        for lesson in lessons
                        if lesson.class_name == class_name
                        and lesson.day == day
                        and lesson.session == part
                        and lesson.subject in subject_set
                    })
                    if len(matched_subjects) > 1:
                        violations.append(
                            _violation(
                                "subject.noSameSession",
                                f"{class_name}: Thứ {day} {part} có các môn không được học cùng buổi.",
                                class_name=class_name,
                                day=day,
                                session=part,
                                group_id=group_id,
                                subjects=matched_subjects,
                            )
                        )
    for class_name, groups in (constraints.subject_no_same_day or {}).items():
        if not isinstance(groups, Mapping):
            continue
        for group_id, subjects in groups.items():
            if len(subjects) < 2:
                continue
            subject_set = set(subjects)
            for day in sorted({lesson.day for lesson in lessons if lesson.class_name == class_name}):
                matched_subjects = sorted({
                    lesson.subject
                    for lesson in lessons
                    if lesson.class_name == class_name
                    and lesson.day == day
                    and lesson.subject in subject_set
                })
                if len(matched_subjects) > 1:
                    violations.append(
                        _violation(
                            "subject.noSameDay",
                            f"{class_name}: Thứ {day} có các môn không được học cùng ngày.",
                            class_name=class_name,
                            day=day,
                            group_id=group_id,
                            subjects=matched_subjects,
                        )
                    )

    for rule in _iter_limit_rules(constraints):
        if not isinstance(rule, Mapping):
            continue
        name = str(rule.get("name") or "Giới hạn số tiết/1 thời điểm")
        per_session = rule.get("perSession", {}) if isinstance(rule.get("perSession"), Mapping) else {}
        for (day, part, period), slot_lessons in by_slot.items():
            matched = [x for x in slot_lessons if _lesson_matches_limit(x, rule, constraints)]
            if not matched:
                continue
            for field, getter in (("classes", lambda x: x.class_name), ("teachers", lambda x: x.teacher), ("rooms", lambda x: x.room), ("subjects", lambda x: x.subject)):
                limit = _limit_for_slot(rule, field, day, part)
                if limit > 0 and len({getter(x) for x in matched if getter(x)}) > limit:
                    violations.append(_violation("timeLimit.perSlot", f"{name}: Thứ {day} {part} tiết {period} vượt {field}/1 tiết."))
        for day in sorted({x.day for x in lessons}):
            for part in ("AM", "PM"):
                matched = [x for x in lessons if x.day == day and x.session == part and _lesson_matches_limit(x, rule, constraints)]
                if not matched:
                    continue
                for field, getter in (("classes", lambda x: x.class_name), ("teachers", lambda x: x.teacher), ("rooms", lambda x: x.room), ("subjects", lambda x: x.subject)):
                    limit = _to_int(per_session.get(field), 0)
                    if limit > 0 and len({getter(x) for x in matched if getter(x)}) > limit:
                        violations.append(_violation("timeLimit.perSession", f"{name}: Thứ {day} {part} vượt {field}/1 buổi."))

    if unsupported:
        warnings.extend(sorted(unsupported))
    return {"hard_ok": not violations, "violations": violations, "warnings": warnings, "unsupported": sorted(unsupported)}


def compute_metrics(data: SchoolData, lessons: list[Lesson], *, rules: TimetableRuleSet | None = None) -> dict[str, Any]:
    rules = resolve_rule_set(rules)
    constraints = rules.constraints
    class_grade = data.class_grade
    total_expected = sum(a.periods_per_week for a in data.assignments)
    session_by_key = {(session.day, session.part): session for session in all_sessions()}
    invalid_lesson_slots: list[dict[str, Any]] = []
    for lesson in lessons:
        session = session_by_key.get((lesson.day, lesson.session))
        grade = class_grade.get(lesson.class_name)
        reason = ""
        if grade is None:
            reason = "unknown_class"
        elif session is None:
            reason = "invalid_day_or_session"
        elif lesson.period not in class_available_periods(
            grade,
            lesson.class_name,
            session,
            rules.constraints,
        ):
            reason = "period_not_available_for_class"
        if reason:
            invalid_lesson_slots.append(
                {
                    "class": lesson.class_name,
                    "day": lesson.day,
                    "session": lesson.session,
                    "period": lesson.period,
                    "reason": reason,
                }
            )

    by_class_slot = Counter((x.class_name, x.day, x.session, x.period) for x in lessons)
    by_teacher_slot = Counter((x.teacher, x.day, x.session, x.period) for x in lessons)
    by_room_slot = Counter((x.room, x.day, x.session, x.period) for x in lessons if x.room)
    by_teacher_session: dict[tuple[str, int, str], list[Lesson]] = defaultdict(list)
    for lesson in lessons:
        by_teacher_session[(lesson.teacher, lesson.day, lesson.session)].append(lesson)

    assignment_expected = Counter((a.class_name, a.subject, a.teacher) for a in data.assignments for _ in range(a.periods_per_week))
    assignment_actual = Counter((x.class_name, x.subject, x.teacher) for x in lessons)

    assignment_mismatches = []
    for key in set(assignment_expected) | set(assignment_actual):
        if assignment_expected[key] != assignment_actual[key]:
            assignment_mismatches.append({"key": key, "expected": assignment_expected[key], "actual": assignment_actual[key]})

    class_session_violations = []
    by_class_session = Counter((x.class_name, x.day, x.session) for x in lessons)
    by_class_session_periods: dict[tuple[str, int, str], list[int]] = defaultdict(list)
    for lesson in lessons:
        by_class_session_periods[(lesson.class_name, lesson.day, lesson.session)].append(lesson.period)
    for class_info in data.classes:
        for session in all_sessions():
            capacity = len(class_available_periods(class_info.grade, class_info.name, session, constraints))
            actual = by_class_session[(class_info.name, session.day, session.part)]
            periods = sorted(by_class_session_periods[(class_info.name, session.day, session.part)])
            if actual > capacity:
                class_session_violations.append(
                    {
                        "class": class_info.name,
                        "day": session.day,
                        "session": session.part,
                        "capacity": capacity,
                        "actual": actual,
                        "periods": periods,
                        "reason": "student_session_capacity",
                    }
                )

    subject_session_violations = []
    by_class_subject_session = Counter((x.class_name, x.subject, x.day, x.session) for x in lessons)
    assignment_session_limits: dict[tuple[str, str], int] = {}
    for assignment in data.assignments:
        key = (assignment.class_name, assignment.subject)
        configured = max(1, int(assignment.max_periods_per_session))
        assignment_session_limits[key] = max(
            configured,
            int(assignment_session_limits.get(key, 0)),
        )
    for (class_name, subject, day, part), actual in by_class_subject_session.items():
        grade = class_grade.get(class_name)
        if grade is None:
            continue
        # Once PCCM has its own per-class/session limit, that value is the
        # authoritative scheduling contract. Falling back to the standard
        # grade/subject table here made validation reject a valid result after
        # the user intentionally changed PCCM from 2 to 3 periods/session.
        limit = assignment_session_limits.get(
            (class_name, subject),
            data.limits_by_grade_subject.get((grade, subject), 99),
        )
        if actual > limit:
            subject_session_violations.append(
                {"class": class_name, "grade": grade, "subject": subject, "day": day, "session": part, "actual": actual, "limit": limit}
            )

    contiguous_block_violations = []
    if rules.contiguous_multi_period_assignments:
        by_assignment_session: dict[tuple[str, str, str, int, str], list[int]] = defaultdict(list)
        for lesson in lessons:
            by_assignment_session[(lesson.class_name, lesson.subject, lesson.teacher, lesson.day, lesson.session)].append(lesson.period)
        for (class_name, subject, teacher, day, part), periods in by_assignment_session.items():
            if len(periods) > 1 and not _is_contiguous(periods):
                contiguous_block_violations.append(
                    {
                        "class": class_name,
                        "subject": subject,
                        "teacher": teacher,
                        "day": day,
                        "session": part,
                        "periods": sorted(periods),
                    }
                )

    load_dist: Counter[int] = Counter()
    gap_stats: Counter[int] = Counter()
    assignment_teachers = sorted({a.teacher for a in data.assignments if a.teacher})
    teacher_gap_periods: Counter[str] = Counter()
    teacher_gap1_sessions: Counter[str] = Counter()
    one_period_sessions = 0
    two_period_sessions = 0
    gap_sessions = []
    for (teacher, day, part), items in by_teacher_session.items():
        periods = sorted(x.period for x in items)
        load_dist[len(items)] += 1
        if len(items) == 1:
            one_period_sessions += 1
        if len(items) == 2:
            two_period_sessions += 1
        gap = max(periods) - min(periods) + 1 - len(periods)
        gap_stats[gap] += 1
        if gap > 0:
            teacher_gap_periods[teacher] += gap
            if gap == 1:
                teacher_gap1_sessions[teacher] += 1
            gap_sessions.append({"teacher": teacher, "day": day, "session": part, "periods": periods, "gap": gap})

    app_constraints = validate_app_constraints(data, lessons, rules)
    gap_period_values = [int(teacher_gap_periods.get(teacher, 0)) for teacher in assignment_teachers]
    gap1_session_values = [int(teacher_gap1_sessions.get(teacher, 0)) for teacher in assignment_teachers]
    teacher_gap_imbalance = (max(gap_period_values) - min(gap_period_values)) if gap_period_values else 0
    teacher_gap1_session_imbalance = (max(gap1_session_values) - min(gap1_session_values)) if gap1_session_values else 0

    metrics: dict[str, Any] = {
        "scheduled_periods": len(lessons),
        "expected_periods": total_expected,
        "classes": len(data.classes),
        "teachers": len({a.teacher for a in data.assignments}),
        "teacher_sessions": len(by_teacher_session),
        "teacher_session_load_distribution": dict(sorted(load_dist.items())),
        "one_period_teacher_sessions": one_period_sessions,
        "two_period_teacher_sessions": two_period_sessions,
        "gap_distribution": dict(sorted(gap_stats.items())),
        "gap_sessions": gap_sessions,
        "teacher_gap_periods": dict(sorted((teacher, int(teacher_gap_periods.get(teacher, 0))) for teacher in assignment_teachers if teacher_gap_periods.get(teacher, 0))),
        "teacher_gap1_sessions": dict(sorted((teacher, int(teacher_gap1_sessions.get(teacher, 0))) for teacher in assignment_teachers if teacher_gap1_sessions.get(teacher, 0))),
        "teacher_gap_imbalance": teacher_gap_imbalance,
        "teacher_gap1_session_imbalance": teacher_gap1_session_imbalance,
        "teacher_gap_period_max": max(gap_period_values) if gap_period_values else 0,
        "teacher_gap1_session_max": max(gap1_session_values) if gap1_session_values else 0,
        "class_slot_conflicts": sum(1 for v in by_class_slot.values() if v != 1),
        "teacher_slot_conflicts": sum(1 for v in by_teacher_slot.values() if v > 1),
        "room_slot_conflicts": sum(1 for v in by_room_slot.values() if v > 1),
        "assignment_mismatches": assignment_mismatches,
        "class_session_violations": class_session_violations,
        "subject_session_limit_violations": subject_session_violations,
        "contiguous_block_violations": contiguous_block_violations,
        "contiguous_block_violation_count": len(contiguous_block_violations),
        "invalid_lesson_slots": invalid_lesson_slots,
        "invalid_lesson_slot_count": len(invalid_lesson_slots),
        "app_constraint_violations": app_constraints["violations"],
        "app_constraint_violation_count": len(app_constraints["violations"]),
        "app_constraint_warnings": app_constraints["warnings"],
        "app_constraint_unsupported": app_constraints["unsupported"],
    }
    metrics["core_hard_ok"] = (
        metrics["scheduled_periods"] == metrics["expected_periods"]
        and metrics["class_slot_conflicts"] == 0
        and metrics["teacher_slot_conflicts"] == 0
        and metrics["room_slot_conflicts"] == 0
        and not assignment_mismatches
        and not class_session_violations
        and not subject_session_violations
        and not contiguous_block_violations
        and not invalid_lesson_slots
    )
    metrics["hard_ok"] = metrics["core_hard_ok"] and app_constraints["hard_ok"]
    return metrics


def assert_acceptance(
    data: SchoolData,
    lessons: list[Lesson],
    *,
    rules: TimetableRuleSet | None = None,
    max_teacher_sessions: int = 200,
    max_one_period_teacher_sessions: int | None = None,
) -> dict[str, Any]:
    metrics = compute_metrics(data, lessons, rules=rules)
    failures = []
    if not metrics["core_hard_ok"]:
        failures.append("hard constraints failed")
    if not metrics["hard_ok"]:
        count = int(metrics.get("app_constraint_violation_count") or 0)
        if count > 0:
            kinds = sorted(
                {
                    str(item.get("kind") or "")
                    for item in metrics.get("app_constraint_violations", [])
                    if isinstance(item, Mapping)
                }
            )
            suffix = f": {', '.join(kind for kind in kinds if kind)}" if kinds else ""
            failures.append(f"app constraints failed ({count}){suffix}")
    if metrics["teacher_sessions"] > max_teacher_sessions:
        failures.append(f"teacher_sessions={metrics['teacher_sessions']} > {max_teacher_sessions}")
    if (
        max_one_period_teacher_sessions is not None
        and metrics["one_period_teacher_sessions"] > max_one_period_teacher_sessions
    ):
        failures.append(
            "one_period_teacher_sessions="
            f"{metrics['one_period_teacher_sessions']} > {max_one_period_teacher_sessions}"
        )
    if failures:
        raise AssertionError("; ".join(failures))
    return metrics
