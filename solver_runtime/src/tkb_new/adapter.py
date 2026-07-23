from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, replace
import json
import hashlib
import math
import os
import random
import re
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from tkb_optimizer_ref.export_csv import write_session_plan_csv, write_timetable_csv
from tkb_optimizer_ref.gap0_cp_sat import Gap0CpSatNoSolution, _load_cp_model, load_period_hint, solve_gap0_cp_sat
from tkb_optimizer_ref.integrated_cp_sat import solve_integrated_timetable
from tkb_optimizer_ref.models import Assignment, ClassInfo, Lesson, SchoolData, Session, SessionAllocation
from tkb_optimizer_ref.period_milp import (
    LessonEvent,
    PeriodAllocationError,
    _event_matches_limit,
    _event_start_allowed,
    _iter_limit_rules,
    _limit_for_slot,
    allocate_periods,
    save_period_solution,
)
from tkb_optimizer_ref.random_seed import normalize_cp_sat_seed
from tkb_optimizer_ref.rules import (
    TimetableConstraintRules,
    TimetableRuleSet,
    one_session_per_day_mode,
)
from tkb_optimizer_ref.session_milp import (
    _assignment_available_periods,
    _assignment_session_allowed,
    _assignment_session_cap,
    save_session_solution,
    solve_session_allocation,
    solve_session_allocation_with_cap_search,
)
from tkb_optimizer_ref.session_cp_sat import SessionCpSatNoSolution, solve_session_allocation_cp_sat
from tkb_optimizer_ref.template import (
    all_sessions,
    class_allowed_periods,
    class_available_periods,
    class_sort_key,
    class_session_capacity_for_constraints,
    teacher_session_capacity,
)
from tkb_optimizer_ref.validate import assert_acceptance, compute_metrics, validate_app_constraints


ProgressFn = Callable[[dict[str, Any]], None]


def _setting_truthy(value: Any) -> bool:
    return str(value if value is not None else "").strip().casefold() in {
        "1",
        "true",
        "on",
        "yes",
    }


def _legacy_solver_hints_enabled(settings: Mapping[str, Any] | None = None) -> bool:
    # Production scheduling must be general: never seed from bundled legacy
    # benchmark timetables, even if an old env/request flag is still present.
    return False


@dataclass(frozen=True, slots=True)
class ClassEntry:
    id: str
    name: str
    grade: str
    aliases: tuple[str, ...]


@dataclass(slots=True)
class UiDataContext:
    school_data: SchoolData
    classes: list[ClassEntry]
    class_by_name: dict[str, ClassEntry]
    rules: TimetableRuleSet
    warnings: list[str]


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _cell_subject_text(value: Any) -> str:
    if isinstance(value, Mapping):
        for key in ("mon", "subject", "ten", "text", "name"):
            text = _text(value.get(key))
            if text:
                return text
        return ""
    return _text(value)


def _norm(value: Any) -> str:
    return re.sub(r"\s+", " ", _text(value)).casefold()


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def _to_float(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _get_path(obj: Mapping[str, Any] | None, path: str, default: Any = None) -> Any:
    cur: Any = obj or {}
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return default
        cur = cur[part]
    return default if cur is None else cur


def _truthy(value: Any) -> bool:
    return value is True or value in {1, "1", "true", "True", "on", "yes", "YES"}


def _linked_day_avoided(linked: Mapping[str, Any] | None, session_key: str, day_key: str) -> bool:
    if not isinstance(linked, Mapping):
        return False
    checked = _truthy(_get_path(linked, f"{session_key}.{day_key}", False))
    if str(linked.get("mode") or "").lower() == "avoid":
        return checked
    if "enabled" in linked:
        return _truthy(linked.get("enabled")) and not checked
    return checked


def _day_key(day: int) -> str:
    return f"thu{int(day)}"


def _session_key(session: Session) -> str:
    return "sang" if session.part == "AM" else "chieu"


def _canonical_grade(value: Any) -> str:
    raw = _text(value)
    match = re.search(r"\d+", raw)
    return f"Khối {int(match.group(0))}" if match else raw


def _app_class_alias(value: Any) -> str:
    raw = _text(value)
    if not raw:
        return ""
    if re.match(r"^\d+A\d+$", raw, re.I):
        return raw.upper()
    match = re.match(r"^(\d+)[.\-_/ ]+(\d+)$", raw)
    if match:
        return f"{match.group(1)}A{int(match.group(2))}".upper()
    match = re.match(r"^(\d+)A0?(\d+)$", raw, re.I)
    if match:
        return f"{match.group(1)}A{int(match.group(2))}".upper()
    return raw.upper()


def _compact_class_alias(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", _text(value).upper())


def _unique(values: list[str]) -> tuple[str, ...]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = _text(value)
        if not value:
            continue
        key = _norm(value)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return tuple(out)


def _resolve_teacher_map(ui_data: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for row in ui_data.get("giaovien") or []:
        if not isinstance(row, dict):
            continue
        code = _text(row.get("magv") or row.get("ma") or row.get("code") or row.get("id") or row.get("ten"))
        if not code:
            continue
        full_name = f"{_text(row.get('hodem'))} {_text(row.get('ten'))}".strip()
        for alias in [code, row.get("magv"), row.get("ma"), row.get("ten"), full_name]:
            alias_text = _text(alias)
            if alias_text:
                lookup[_norm(alias_text)] = code
    return lookup


def _build_subject_aliases(ui_data: dict[str, Any]) -> tuple[dict[str, str], dict[str, set[str]]]:
    alias_to_subject: dict[str, str] = {}
    aliases_by_subject: dict[str, set[str]] = defaultdict(set)

    def add(subject: str, aliases: list[Any]) -> None:
        subject = _text(subject)
        if not subject:
            return
        aliases_by_subject[subject].add(subject)
        for alias in aliases:
            alias_text = _text(alias)
            if not alias_text:
                continue
            alias_to_subject[_norm(alias_text)] = subject
            aliases_by_subject[subject].add(alias_text)

    for row in ui_data.get("monhoc") or []:
        if not isinstance(row, dict):
            continue
        subject = _text(row.get("ten") or row.get("ma") or row.get("ma2") or row.get("id"))
        add(subject, [row.get("ten"), row.get("ma"), row.get("ma2"), row.get("id")])

    for row in ui_data.get("mon") or []:
        if not isinstance(row, dict):
            continue
        raw = _text(row.get("ten") or row.get("mon") or row.get("ma") or row.get("mamon") or row.get("id"))
        subject = alias_to_subject.get(_norm(raw), raw)
        add(subject, [raw])

    return alias_to_subject, aliases_by_subject


def _canonical_subject(raw: Any, alias_to_subject: dict[str, str]) -> str:
    value = _text(raw)
    return alias_to_subject.get(_norm(value), value)


def _subject_aliases(raw: Any, subject: str, aliases_by_subject: dict[str, set[str]]) -> tuple[str, ...]:
    aliases = set(aliases_by_subject.get(subject, set()))
    raw_text = _text(raw)
    if raw_text:
        aliases.add(raw_text)
    aliases.add(subject)
    return _unique(list(aliases))


def _build_classes(ui_data: dict[str, Any]) -> tuple[list[ClassEntry], dict[str, ClassEntry]]:
    classes: list[ClassEntry] = []
    by_alias: dict[str, ClassEntry] = {}
    for index, row in enumerate(ui_data.get("lop") or []):
        if not isinstance(row, dict):
            continue
        class_id = _text(row.get("id") or row.get("ten") or row.get("ten2") or f"lop_{index + 1}")
        name = _text(row.get("ten") or row.get("ten2") or class_id)
        grade = _canonical_grade(row.get("khoi") or name)
        aliases = _unique(
            [
                class_id,
                row.get("ten"),
                row.get("ten2"),
                _app_class_alias(row.get("ten")),
                _app_class_alias(row.get("ten2")),
                _compact_class_alias(row.get("ten")),
                _compact_class_alias(row.get("ten2")),
                _compact_class_alias(class_id),
            ]
        )
        entry = ClassEntry(id=class_id, name=name, grade=grade, aliases=aliases)
        classes.append(entry)
        for alias in aliases:
            by_alias.setdefault(_norm(alias), entry)
    return classes, by_alias


def _lookup_matrix_number(
    matrix: dict[str, Any],
    class_entry: ClassEntry,
    subject_key: str,
    subject: str,
    aliases_by_subject: dict[str, set[str]],
) -> int:
    if not matrix:
        return 0
    for class_alias in class_entry.aliases:
        for subject_alias in _subject_aliases(subject_key, subject, aliases_by_subject):
            value = matrix.get(f"{class_alias}|{subject_alias}")
            number = _to_int(value, 0)
            if number > 0:
                return number
    return 0


def _lookup_matrix_text(
    matrix: dict[str, Any],
    class_entry: ClassEntry,
    subject_key: str,
    subject: str,
    aliases_by_subject: dict[str, set[str]],
) -> str:
    if not matrix:
        return ""
    for class_alias in class_entry.aliases:
        for subject_alias in _subject_aliases(subject_key, subject, aliases_by_subject):
            value = _text(matrix.get(f"{class_alias}|{subject_alias}"))
            if value:
                return value
    return ""


def _slot_from_ui_key(raw: Any) -> tuple[int, str, int] | None:
    parts = _text(raw).split("|")
    if len(parts) != 3:
        return None
    match = re.search(r"\d+", parts[0])
    if not match:
        return None
    day = int(match.group(0))
    session = "AM" if parts[1] == "sang" else "PM" if parts[1] == "chieu" else ""
    if not session:
        return None
    return day, session, _to_int(parts[2], 0) + 1


def _clone_jsonable(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value, ensure_ascii=False))
    except TypeError:
        return {}


def _map_rule_by_class_keys(value: Any, class_by_alias: dict[str, ClassEntry]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    out = _clone_jsonable(value)
    by_class = out.get("byClass")
    if isinstance(by_class, dict):
        mapped: dict[str, Any] = {}
        for raw_class, rule in by_class.items():
            entry = class_by_alias.get(_norm(raw_class))
            mapped[entry.name if entry else _text(raw_class)] = rule
        out["byClass"] = mapped
    return out


def _strip_removed_ui_rules(rule: Any) -> dict[str, Any]:
    """Ignore stale constraint keys that are no longer exposed by the UI."""
    if not isinstance(rule, Mapping):
        return {}
    out = _clone_jsonable(rule)
    if isinstance(out, dict):
        out.pop("lessonPlans", None)
    return out


def _normalize_constraints(
    ui_data: dict[str, Any],
    classes: list[ClassEntry],
    class_by_alias: dict[str, ClassEntry],
    alias_to_subject: dict[str, str],
    teacher_lookup: dict[str, str],
) -> TimetableRuleSet:
    raw_source = ui_data.get("tkbConstraints") or {}
    raw = _clone_jsonable(raw_source) if isinstance(raw_source, Mapping) else {}

    raw_fixed = raw.setdefault("fixedOff", {})
    if not isinstance(raw_fixed, dict):
        raw_fixed = {}
        raw["fixedOff"] = raw_fixed
    raw_class_fixed = raw_fixed.setdefault("class", {})
    if not isinstance(raw_class_fixed, dict):
        raw_class_fixed = {}
        raw_fixed["class"] = raw_class_fixed

    raw_user_off = ui_data.get("tkbUserOff") if isinstance(ui_data.get("tkbUserOff"), Mapping) else {}
    for class_id, slots in raw_user_off.items():
        if isinstance(slots, list):
            keys = [key for key in slots if _slot_from_ui_key(key) is not None]
        elif isinstance(slots, Mapping):
            keys = [key for key, enabled in slots.items() if enabled and _slot_from_ui_key(key) is not None]
        else:
            keys = []
        if keys:
            class_slots = raw_class_fixed.setdefault(_text(class_id), {})
            if isinstance(class_slots, dict):
                for key in keys:
                    class_slots[_text(key)] = True

    class_name_by_id: dict[str, str] = {}
    for entry in classes:
        for alias in (entry.id, entry.name, *entry.aliases):
            class_name_by_id[_norm(alias)] = entry.name

    def map_class(value: Any) -> str:
        text = _text(value)
        return class_name_by_id.get(_norm(text), text)

    def map_teacher(value: Any) -> str:
        text = _text(value)
        return teacher_lookup.get(_norm(text), text)

    def map_subject(value: Any) -> str:
        text = _text(value)
        return alias_to_subject.get(_norm(text), text)

    def map_item(kind: str, value: Any) -> str:
        if kind == "class":
            return map_class(value)
        if kind == "teacher":
            return map_teacher(value)
        if kind in {"subject", "subjectGroup"}:
            return map_subject(value)
        return _text(value)

    groups: dict[str, dict[str, frozenset[str]]] = {"class": {}, "teacher": {}, "subject": {}, "room": {}}
    group_names: dict[str, dict[str, str]] = {"class": {}, "teacher": {}, "subject": {}, "room": {}}
    raw_groups = raw.get("groups") if isinstance(raw.get("groups"), Mapping) else {}
    for kind in groups:
        raw_kind = raw_groups.get(kind, {}) if isinstance(raw_groups, Mapping) else {}
        if not isinstance(raw_kind, Mapping):
            continue
        for group_id, group in raw_kind.items():
            if not isinstance(group, Mapping):
                continue
            items = frozenset(map_item(kind, item) for item in group.get("items", []) if _text(item))
            groups[kind][_text(group_id)] = items
            group_names[kind][_text(group_id)] = _text(group.get("name") or group_id)

    fixed_off: dict[str, dict[str, frozenset[tuple[int, str, int]]]] = {
        "class": {},
        "teacher": {},
        "subject": {},
        "room": {},
        "subjectGroup": {},
    }
    raw_fixed = raw.get("fixedOff") if isinstance(raw.get("fixedOff"), Mapping) else {}
    for kind in fixed_off:
        raw_kind = raw_fixed.get(kind, {}) if isinstance(raw_fixed, Mapping) else {}
        if not isinstance(raw_kind, Mapping):
            continue
        for item_id, slots in raw_kind.items():
            mapped_id = map_item(kind, item_id)
            if not isinstance(slots, Mapping):
                continue
            parsed = frozenset(slot for key, enabled in slots.items() if enabled and (slot := _slot_from_ui_key(key)) is not None)
            if parsed:
                fixed_off[kind][mapped_id] = parsed

    class_extra_slots: dict[str, frozenset[tuple[int, str, int]]] = {}
    class_entry_by_name = {entry.name: entry for entry in classes}
    raw_tkb = ui_data.get("tkb") if isinstance(ui_data.get("tkb"), Mapping) else {}
    for raw_class_id, raw_class_tkb in raw_tkb.items():
        class_name = map_class(raw_class_id)
        class_entry = class_entry_by_name.get(class_name)
        if class_entry is None or not isinstance(raw_class_tkb, Mapping):
            continue
        if class_name not in fixed_off["class"]:
            continue
        extras: set[tuple[int, str, int]] = set()
        for raw_day, raw_day_data in raw_class_tkb.items():
            match = re.search(r"\d+", _text(raw_day))
            if not match or not isinstance(raw_day_data, Mapping):
                continue
            day = int(match.group(0))
            for raw_session_key, raw_slots in raw_day_data.items():
                session_part = "AM" if raw_session_key == "sang" else "PM" if raw_session_key == "chieu" else ""
                if not session_part or not isinstance(raw_slots, list):
                    continue
                session = Session(day=day, part=session_part)
                default_periods = set(class_allowed_periods(class_entry.grade, session))
                max_period = teacher_session_capacity(session)
                for idx, value in enumerate(raw_slots):
                    period = idx + 1
                    if period > max_period or period in default_periods:
                        continue
                    if value == "OFF":
                        continue
                    extras.add((day, session_part, period))
        if extras:
            class_extra_slots[class_name] = frozenset(extras)

    teacher_rules: dict[str, Mapping[str, Any]] = {}
    teacher_must_teach: dict[str, frozenset[tuple[int, str, int]]] = {}
    raw_teacher = raw.get("teacher") if isinstance(raw.get("teacher"), Mapping) else {}
    for teacher_id, rule in raw_teacher.items():
        if isinstance(rule, Mapping):
            mapped_teacher = map_teacher(teacher_id)
            teacher_rules[mapped_teacher] = _strip_removed_ui_rules(rule)
            slots = rule.get("mustTeach") if isinstance(rule.get("mustTeach"), Mapping) else {}
            parsed = frozenset(slot for key, enabled in slots.items() if enabled and (slot := _slot_from_ui_key(key)) is not None)
            if parsed:
                teacher_must_teach[mapped_teacher] = parsed

    subject_rules: dict[str, Mapping[str, Any]] = {}
    raw_subject = raw.get("subject") if isinstance(raw.get("subject"), Mapping) else {}
    for subject_id, rule in raw_subject.items():
        mapped = map_subject(subject_id)
        subject_rules[mapped] = _map_rule_by_class_keys(rule, class_by_alias)

    subject_group_rules: dict[str, Mapping[str, Any]] = {}
    raw_subject_group = raw.get("subjectGroup") if isinstance(raw.get("subjectGroup"), Mapping) else {}
    for group_id, rule in raw_subject_group.items():
        if isinstance(rule, Mapping):
            subject_group_rules[_text(group_id)] = _map_rule_by_class_keys(rule, class_by_alias)

    def parse_no_same_groups(value: Any) -> dict[str, frozenset[str]]:
        raw_groups = value.get("groups") if isinstance(value, Mapping) and isinstance(value.get("groups"), Mapping) else value
        if not isinstance(raw_groups, Mapping):
            return {}
        out: dict[str, frozenset[str]] = {}
        for group_id, group in raw_groups.items():
            if isinstance(group, Mapping):
                raw_items = group.get("items") or group.get("subjects") or []
            elif isinstance(group, list):
                raw_items = group
            else:
                raw_items = []
            items = frozenset(map_subject(item) for item in raw_items if _text(item))
            if len(items) >= 2:
                out[_text(group_id)] = items
        return out

    subject_no_same_session: dict[str, dict[str, frozenset[str]]] = {}
    subject_no_same_day: dict[str, dict[str, frozenset[str]]] = {}
    raw_no_same = raw.get("subjectNoSameSession") if isinstance(raw.get("subjectNoSameSession"), Mapping) else {}
    raw_no_same_by_class = raw_no_same.get("byClass") if isinstance(raw_no_same.get("byClass"), Mapping) else {}
    if raw_no_same_by_class:
        for raw_class, row in raw_no_same_by_class.items():
            if not isinstance(row, Mapping):
                continue
            class_name = map_class(raw_class)
            same_session = parse_no_same_groups(row.get("sameSession") or row.get("session") or {})
            same_day = parse_no_same_groups(row.get("sameDay") or row.get("day") or {})
            if same_session:
                subject_no_same_session[class_name] = same_session
            if same_day:
                subject_no_same_day[class_name] = same_day
    legacy_same_session = parse_no_same_groups(raw_no_same)
    if legacy_same_session:
        for class_entry in classes:
            subject_no_same_session.setdefault(class_entry.name, legacy_same_session)

    raw_no_same_day = raw.get("subjectNoSameDay") if isinstance(raw.get("subjectNoSameDay"), Mapping) else {}
    legacy_same_day = parse_no_same_groups(raw_no_same_day)
    if legacy_same_day:
        for class_entry in classes:
            subject_no_same_day.setdefault(class_entry.name, legacy_same_day)

    time_limit: list[Mapping[str, Any]] = []
    for item in raw.get("timeLimit") or []:
        if not isinstance(item, Mapping):
            continue
        mapped = _clone_jsonable(item)
        target_type = mapped.get("targetType")
        if target_type == "class":
            mapped["targetId"] = map_class(mapped.get("targetId"))
        elif target_type == "teacher":
            mapped["targetId"] = map_teacher(mapped.get("targetId"))
        elif target_type == "subject":
            mapped["targetId"] = map_subject(mapped.get("targetId"))
        elif target_type == "room":
            mapped["targetId"] = _text(mapped.get("targetId"))
        elif target_type == "teacherGroup":
            mapped["targetType"] = "teacherGroup"
        elif target_type == "classGroup":
            mapped["targetType"] = "classGroup"
        elif target_type == "roomGroup":
            mapped["targetType"] = "roomGroup"
        time_limit.append(mapped)

    constraints = TimetableConstraintRules(
        groups=groups,
        group_names=group_names,
        fixed_off=fixed_off,
        teacher=teacher_rules,
        subject=subject_rules,
        subject_group=subject_group_rules,
        time_limit=tuple(time_limit),
        subject_no_same_session=subject_no_same_session,
        subject_no_same_day=subject_no_same_day,
        class_extra_slots=class_extra_slots,
        teacher_must_teach=teacher_must_teach,
    )
    return TimetableRuleSet(constraints=constraints if constraints.active else None)


def _lesson_block_min_required_length(rule: Any) -> int:
    if not isinstance(rule, Mapping):
        return 0
    blocks = rule.get("lessonBlocks")
    if not isinstance(blocks, Mapping):
        return 0
    required = 0
    for raw_length, conf in blocks.items():
        if not isinstance(conf, Mapping) or _to_int(conf.get("min"), 0) <= 0:
            continue
        required = max(required, _to_int(raw_length, 0))
    return required


def _assignment_lesson_block_min_required_length(
    constraints: TimetableConstraintRules | None,
    assignment: Assignment,
) -> int:
    if constraints is None or not constraints.active:
        return 0
    required = _lesson_block_min_required_length(
        constraints.subject_rule_for(assignment.class_name, assignment.subject)
    )
    for _group_id, group_rule in constraints.subject_group_rules_for(assignment.class_name, assignment.subject):
        required = max(required, _lesson_block_min_required_length(group_rule))
    return required


def _school_data_with_lesson_block_caps(data: SchoolData, rule_set: TimetableRuleSet) -> SchoolData:
    constraints = rule_set.constraints
    if constraints is None or not constraints.active:
        return data

    changed = False
    assignments: list[Assignment] = []
    limits_by_grade_subject = dict(data.limits_by_grade_subject)
    for assignment in data.assignments:
        required = _assignment_lesson_block_min_required_length(constraints, assignment)
        if required > 1 and assignment.periods_per_week >= required:
            if assignment.max_periods_per_session < required:
                assignment = replace(assignment, max_periods_per_session=required)
                changed = True
            key = (assignment.grade, assignment.subject)
            if limits_by_grade_subject.get(key, 0) < required:
                limits_by_grade_subject[key] = required
                changed = True
        assignments.append(assignment)

    if not changed:
        return data
    return replace(
        data,
        assignments=assignments,
        limits_by_grade_subject=limits_by_grade_subject,
    )


def build_school_data_from_ui(ui_data: dict[str, Any]) -> UiDataContext:
    if not isinstance(ui_data, dict):
        raise ValueError("Payload DATA không hợp lệ.")

    warnings: list[str] = []
    classes, class_by_alias = _build_classes(ui_data)
    if not classes:
        raise ValueError("Chưa có dữ liệu lớp học.")

    alias_to_subject, aliases_by_subject = _build_subject_aliases(ui_data)
    teacher_lookup = _resolve_teacher_map(ui_data)

    periods_by_grade_subject: dict[tuple[str, str], int] = {}
    limits_by_grade_subject: dict[tuple[str, str], int] = {}
    for row in ui_data.get("mon") or []:
        if not isinstance(row, dict):
            continue
        grade = _canonical_grade(row.get("khoi"))
        subject = _canonical_subject(row.get("ten") or row.get("mon"), alias_to_subject)
        periods = _to_int(row.get("sotiet"), 0)
        if not grade or not subject or periods <= 0:
            continue
        limit = _to_int(row.get("gioihan"), 99)
        periods_by_grade_subject[(grade, subject)] = periods
        limits_by_grade_subject[(grade, subject)] = limit if limit > 0 else 99
        aliases_by_subject[subject].add(subject)

    pccm = ui_data.get("pccmMatrix") or {}
    if not isinstance(pccm, dict):
        raise ValueError("Dữ liệu phân công không hợp lệ.")
    pccm_tiet = ui_data.get("pccmTietMatrix") or {}
    pccm_limit = ui_data.get("pccmGioihanMatrix") or {}
    pccm_room = ui_data.get("pccmRoomMatrix") or {}
    if not isinstance(pccm_tiet, dict):
        pccm_tiet = {}
    if not isinstance(pccm_limit, dict):
        pccm_limit = {}
    if not isinstance(pccm_room, dict):
        pccm_room = {}

    assignments: list[Assignment] = []
    assignment_keys: set[tuple[str, str, str]] = set()
    skipped_unknown_class = 0
    skipped_no_period = 0
    for raw_key, raw_teacher in pccm.items():
        teacher_value = _text(raw_teacher)
        if not teacher_value or "|" not in _text(raw_key):
            continue
        class_key, subject_key = _text(raw_key).split("|", 1)
        class_entry = class_by_alias.get(_norm(class_key))
        if not class_entry:
            skipped_unknown_class += 1
            continue
        subject = _canonical_subject(subject_key, alias_to_subject)
        if not subject:
            continue
        teacher = teacher_lookup.get(_norm(teacher_value), teacher_value)
        periods = _lookup_matrix_number(pccm_tiet, class_entry, subject_key, subject, aliases_by_subject)
        if periods <= 0:
            periods = periods_by_grade_subject.get((class_entry.grade, subject), 0)
        if periods <= 0:
            skipped_no_period += 1
            continue
        limit = _lookup_matrix_number(pccm_limit, class_entry, subject_key, subject, aliases_by_subject)
        if limit <= 0:
            limit = limits_by_grade_subject.get((class_entry.grade, subject), 99)
        limit = limit if limit > 0 else 99
        room = _lookup_matrix_text(pccm_room, class_entry, subject_key, subject, aliases_by_subject)
        key = (class_entry.name, subject, teacher)
        if key in assignment_keys:
            continue
        assignment_keys.add(key)
        assignments.append(
            Assignment(
                class_name=class_entry.name,
                grade=class_entry.grade,
                subject=subject,
                teacher=teacher,
                periods_per_week=periods,
                max_periods_per_session=limit,
                room=room,
            )
        )
        periods_by_grade_subject.setdefault((class_entry.grade, subject), periods)
        limits_by_grade_subject.setdefault((class_entry.grade, subject), limit)

    if skipped_unknown_class:
        warnings.append(f"Bỏ qua {skipped_unknown_class} ô phân công vì không khớp lớp.")
    if skipped_no_period:
        warnings.append(f"Bỏ qua {skipped_no_period} ô phân công vì chưa có số tiết chuẩn.")
    if not assignments:
        raise ValueError("Chưa có phân công hợp lệ để xếp thời khóa biểu.")

    teachers = sorted({assignment.teacher for assignment in assignments})
    subjects = sorted({assignment.subject for assignment in assignments})
    school_data = SchoolData(
        classes=[ClassInfo(name=item.name, grade=item.grade) for item in classes],
        assignments=assignments,
        teachers=teachers,
        subjects=subjects,
        periods_by_grade_subject=periods_by_grade_subject,
        limits_by_grade_subject=limits_by_grade_subject,
    )
    rules = _normalize_constraints(ui_data, classes, class_by_alias, alias_to_subject, teacher_lookup)
    school_data = _school_data_with_lesson_block_caps(school_data, rules)
    return UiDataContext(
        school_data=school_data,
        classes=classes,
        class_by_name={item.name: item for item in classes},
        rules=rules,
        warnings=warnings,
    )


def _teacher_sessions(lessons: list[Lesson]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, int, str], list[int]] = defaultdict(list)
    for lesson in lessons:
        grouped[(lesson.teacher, lesson.day, lesson.session)].append(lesson.period)
    rows: list[dict[str, Any]] = []
    for (teacher, day, session), periods in grouped.items():
        ordered = sorted(periods)
        rows.append(
            {
                "teacher": teacher,
                "day": day,
                "session": session,
                "periods": ordered,
                "load": len(ordered),
                "gap": max(ordered) - min(ordered) + 1 - len(ordered) if ordered else 0,
            }
        )
    return sorted(rows, key=lambda x: (x["teacher"], x["day"], 0 if x["session"] == "AM" else 1))


def _allocations_from_lessons(lessons: list[Lesson]) -> list[SessionAllocation]:
    grouped: Counter[tuple[str, str, str, str, int, str, str]] = Counter()
    for lesson in lessons:
        grouped[
            (
                lesson.class_name,
                lesson.grade,
                lesson.subject,
                lesson.teacher,
                lesson.day,
                lesson.session,
                lesson.room,
            )
        ] += 1
    return [
        SessionAllocation(
            class_name=class_name,
            grade=grade,
            subject=subject,
            teacher=teacher,
            session=Session(day=day, part=part),
            count=count,
            room=room,
        )
        for (class_name, grade, subject, teacher, day, part, room), count in sorted(grouped.items())
    ]


def _teacher_session_count_for_allocations(allocations: list[SessionAllocation]) -> int:
    return len({(item.teacher, item.session.day, item.session.part) for item in allocations if item.count > 0})


def _teacher_session_count_for_lessons(lessons: list[Lesson]) -> int:
    return len({(item.teacher, item.day, item.session) for item in lessons})


class SolverDeadline:
    def __init__(self, seconds: float | None) -> None:
        self.seconds = seconds if seconds and seconds > 0 else None
        self.started_at = time.monotonic()
        self.ends_at = self.started_at + self.seconds if self.seconds else None

    def bounded(self, seconds: float | None) -> "SolverDeadline":
        """Create a phase clock that can never outlive this deadline."""
        child = SolverDeadline(seconds)
        if self.ends_at is not None:
            child.ends_at = (
                self.ends_at
                if child.ends_at is None
                else min(self.ends_at, child.ends_at)
            )
        return child

    def elapsed(self) -> float:
        return max(0.0, time.monotonic() - self.started_at)

    def remaining(self) -> float | None:
        if self.ends_at is None:
            return None
        return max(0.0, self.ends_at - time.monotonic())

    def exhausted(self, reserve_seconds: float = 0.0) -> bool:
        remaining = self.remaining()
        return remaining is not None and remaining <= reserve_seconds

    def phase_limit(self, requested: int, *, default: int = 1, reserve_seconds: float = 2.0) -> int:
        requested = max(1, int(requested or default))
        remaining = self.remaining()
        if remaining is None:
            return requested
        usable = max(1, int(remaining - reserve_seconds))
        return max(1, min(requested, usable))


def _forbidden_session_vector_from_period_error(
    data: SchoolData,
    allocations: list[SessionAllocation],
    error: Exception,
) -> list[tuple[int, dict[int, int]]]:
    if isinstance(error, PeriodAllocationError):
        day = error.session.day
        part = error.session.part
    else:
        match = re.search(r"Session\(day=(\d+), part='(AM|PM)'\)", str(error))
        if not match:
            return []
        day = int(match.group(1))
        part = match.group(2)
    session_index = next(
        (index for index, session in enumerate(all_sessions()) if session.day == day and session.part == part),
        None,
    )
    if session_index is None:
        return []
    assignment_by_key = {
        (item.class_name, item.subject, item.teacher): index
        for index, item in enumerate(data.assignments)
    }
    counts = {index: 0 for index, _item in enumerate(data.assignments)}
    for allocation in allocations:
        if allocation.session.day != day or allocation.session.part != part:
            continue
        index = assignment_by_key.get((allocation.class_name, allocation.subject, allocation.teacher))
        if index is not None:
            counts[index] = counts.get(index, 0) + int(allocation.count)
    return [(session_index, counts)]


def _assignment_index_for_cuts(data: SchoolData) -> dict[tuple[str, str, str], int]:
    return {
        (assignment.class_name, assignment.subject, assignment.teacher): index
        for index, assignment in enumerate(data.assignments)
    }


def _session_index_for_cuts() -> dict[tuple[int, str], int]:
    return {(session.day, session.part): index for index, session in enumerate(all_sessions())}


def _session_vectors_for_cuts(
    data: SchoolData,
    allocations: list[SessionAllocation],
) -> dict[int, dict[int, int]]:
    assignment_by_key = _assignment_index_for_cuts(data)
    session_by_key = _session_index_for_cuts()
    vectors: dict[int, Counter[int]] = {index: Counter() for index in range(len(all_sessions()))}
    for allocation in allocations:
        assignment_index = assignment_by_key.get((allocation.class_name, allocation.subject, allocation.teacher))
        session_index = session_by_key.get((allocation.session.day, allocation.session.part))
        if assignment_index is None or session_index is None:
            continue
        count = int(allocation.count)
        if count > 0:
            vectors[session_index][assignment_index] += count
    return {session_index: dict(counter) for session_index, counter in vectors.items()}


def _cut_for_session_indexes(
    data: SchoolData,
    allocations: list[SessionAllocation],
    session_indexes: set[int],
) -> list[tuple[int, dict[int, int]]]:
    vectors = _session_vectors_for_cuts(data, allocations)
    return [(session_index, vectors[session_index]) for session_index in sorted(session_indexes) if vectors.get(session_index)]


def _cut_for_period_error_sparse(
    data: SchoolData,
    allocations: list[SessionAllocation],
    error: Exception,
) -> list[tuple[int, dict[int, int]]]:
    if isinstance(error, PeriodAllocationError):
        day = error.session.day
        part = error.session.part
    else:
        match = re.search(r"Session\(day=(\d+), part='(AM|PM)'\)", str(error))
        if not match:
            return []
        day = int(match.group(1))
        part = match.group(2)
    session_index = _session_index_for_cuts().get((day, part))
    if session_index is None:
        return []
    return _cut_for_session_indexes(data, allocations, {session_index})


def _cut_for_gap_sessions(
    data: SchoolData,
    allocations: list[SessionAllocation],
    metrics: Mapping[str, Any],
) -> list[tuple[int, dict[int, int]]]:
    vectors = _session_vectors_for_cuts(data, allocations)
    session_by_key = _session_index_for_cuts()
    cuts: list[tuple[int, dict[int, int]]] = []
    seen: set[int] = set()
    gap_sessions = metrics.get("gap_sessions") if isinstance(metrics, Mapping) else None
    if not isinstance(gap_sessions, list):
        return []
    for item in gap_sessions:
        if not isinstance(item, Mapping):
            continue
        session_index = session_by_key.get((_to_int(item.get("day"), 0), str(item.get("session") or "")))
        if session_index is None or session_index in seen:
            continue
        seen.add(session_index)
        vector = vectors.get(session_index)
        if vector:
            cuts.append((session_index, vector))
    return cuts


def _cut_for_one_period_teacher_sessions(
    data: SchoolData,
    allocations: list[SessionAllocation],
    lessons: list[Lesson],
) -> list[tuple[int, dict[int, int]]]:
    session_by_key = _session_index_for_cuts()
    teacher_session_load = Counter(
        (lesson.teacher, int(lesson.day), str(lesson.session))
        for lesson in lessons
        if lesson.teacher
    )
    affected_sessions = {
        session_by_key[(day, part)]
        for (_teacher, day, part), load in teacher_session_load.items()
        if int(load) == 1 and (day, part) in session_by_key
    }
    return _cut_for_session_indexes(data, allocations, affected_sessions)


def _cut_for_gap_teacher_sessions(
    data: SchoolData,
    allocations: list[SessionAllocation],
    metrics: Mapping[str, Any],
) -> list[tuple[int, dict[int, int]]]:
    assignment_by_key = _assignment_index_for_cuts(data)
    session_by_key = _session_index_for_cuts()
    cuts: list[tuple[int, dict[int, int]]] = []
    seen: set[tuple[str, int]] = set()
    gap_sessions = metrics.get("gap_sessions") if isinstance(metrics, Mapping) else None
    if not isinstance(gap_sessions, list):
        return []
    for item in gap_sessions:
        if not isinstance(item, Mapping):
            continue
        teacher = str(item.get("teacher") or "")
        session_index = session_by_key.get((_to_int(item.get("day"), 0), str(item.get("session") or "")))
        if not teacher or session_index is None:
            continue
        key = (teacher, session_index)
        if key in seen:
            continue
        seen.add(key)
        vector: Counter[int] = Counter()
        for allocation in allocations:
            if allocation.teacher != teacher:
                continue
            if session_by_key.get((allocation.session.day, allocation.session.part)) != session_index:
                continue
            assignment_index = assignment_by_key.get((allocation.class_name, allocation.subject, allocation.teacher))
            if assignment_index is not None and int(allocation.count) > 0:
                vector[assignment_index] += int(allocation.count)
        if vector:
            cuts.append((session_index, dict(vector)))
    return cuts


def _cut_for_near_full_teachers_in_gap_sessions(
    data: SchoolData,
    allocations: list[SessionAllocation],
    metrics: Mapping[str, Any],
) -> list[tuple[int, dict[int, int]]]:
    assignment_by_key = _assignment_index_for_cuts(data)
    session_by_key = _session_index_for_cuts()
    sessions = all_sessions()
    gap_sessions = metrics.get("gap_sessions") if isinstance(metrics, Mapping) else None
    if not isinstance(gap_sessions, list):
        return []
    gap_session_indexes = {
        session_by_key[(day, part)]
        for item in gap_sessions
        if isinstance(item, Mapping)
        for day, part in [(_to_int(item.get("day"), 0), str(item.get("session") or ""))]
        if (day, part) in session_by_key
    }
    cuts: list[tuple[int, dict[int, int]]] = []
    for session_index in sorted(gap_session_indexes):
        session = sessions[session_index]
        capacity = teacher_session_capacity(session)
        teacher_load: Counter[str] = Counter()
        for allocation in allocations:
            if session_by_key.get((allocation.session.day, allocation.session.part)) == session_index:
                teacher_load[allocation.teacher] += int(allocation.count)
        near_full_teachers = {teacher for teacher, load in teacher_load.items() if int(load) >= max(1, capacity - 1)}
        vector: Counter[int] = Counter()
        for allocation in allocations:
            if allocation.teacher not in near_full_teachers:
                continue
            if session_by_key.get((allocation.session.day, allocation.session.part)) != session_index:
                continue
            assignment_index = assignment_by_key.get((allocation.class_name, allocation.subject, allocation.teacher))
            if assignment_index is not None and int(allocation.count) > 0:
                vector[assignment_index] += int(allocation.count)
        if vector:
            cuts.append((session_index, dict(vector)))
    return cuts


def _new_cuts_for_period_metrics(
    data: SchoolData,
    allocations: list[SessionAllocation],
    metrics: Mapping[str, Any],
    *,
    cut_scope: str,
) -> list[tuple[int, dict[int, int]]]:
    normalized = str(cut_scope or "combined").strip().casefold()
    if normalized == "session":
        return _cut_for_gap_sessions(data, allocations, metrics)
    if normalized == "near_full_session":
        return _cut_for_near_full_teachers_in_gap_sessions(data, allocations, metrics)
    if normalized == "teacher":
        return _cut_for_gap_teacher_sessions(data, allocations, metrics)
    if normalized == "aggressive":
        return [
            *_cut_for_gap_teacher_sessions(data, allocations, metrics),
            *_cut_for_near_full_teachers_in_gap_sessions(data, allocations, metrics),
            *_cut_for_gap_sessions(data, allocations, metrics),
        ]
    return [
        *_cut_for_gap_teacher_sessions(data, allocations, metrics),
        *_cut_for_near_full_teachers_in_gap_sessions(data, allocations, metrics),
    ]


def _append_unique_session_cuts(
    cuts: list[tuple[int, dict[int, int]]],
    cut_keys: set[str],
    new_cuts: list[tuple[int, dict[int, int]]],
) -> int:
    added = 0
    for session_index, vector in new_cuts:
        cleaned = {int(key): int(value) for key, value in (vector or {}).items() if int(value) > 0}
        if not cleaned:
            continue
        key = json.dumps([int(session_index), sorted(cleaned.items())], separators=(",", ":"))
        if key in cut_keys:
            continue
        cut_keys.add(key)
        cuts.append((int(session_index), cleaned))
        added += 1
    return added


def _period_retry_error_from_best_effort(
    lessons: list[Lesson],
    period_metrics: Mapping[str, Any],
) -> PeriodAllocationError | None:
    failures = period_metrics.get("best_effort_failed_sessions") if isinstance(period_metrics, Mapping) else None
    if not isinstance(failures, list) or not failures:
        return None
    first = failures[0] if isinstance(failures[0], Mapping) else {}
    diagnostics = first.get("diagnostics") if isinstance(first.get("diagnostics"), Mapping) else {}
    if diagnostics.get("reason") == "deadline_exhausted":
        return None
    session_payload = first.get("session") if isinstance(first.get("session"), Mapping) else {}
    day = _to_int(session_payload.get("day"), 0)
    part = str(session_payload.get("part") or "")
    if day <= 0 or part not in {"AM", "PM"}:
        return None
    return PeriodAllocationError(
        "Can retry structured period best-effort failure with a different session vector.",
        session=Session(day=day, part=part),
        partial_lessons=lessons,
        diagnostics={
            "reason": "period_best_effort_failed_session",
            "failure": first,
        },
    )


def _merge_existing_lessons_with_hint(
    data: SchoolData,
    existing_lessons: list[Lesson],
    period_hint: list[Lesson] | None,
) -> list[Lesson]:
    if not existing_lessons:
        return list(period_hint or [])
    if not period_hint:
        return list(existing_lessons)

    required = {
        (item.class_name, item.subject, item.teacher): int(item.periods_per_week)
        for item in data.assignments
    }
    counts: Counter[tuple[str, str, str]] = Counter(
        (item.class_name, item.subject, item.teacher) for item in existing_lessons
    )
    seen_slots = {
        (item.class_name, item.subject, item.teacher, item.day, item.session, item.period)
        for item in existing_lessons
    }
    merged = list(existing_lessons)
    for lesson in period_hint:
        assign_key = (lesson.class_name, lesson.subject, lesson.teacher)
        slot_key = (*assign_key, lesson.day, lesson.session, lesson.period)
        if slot_key in seen_slots:
            continue
        if counts[assign_key] >= required.get(assign_key, 0):
            continue
        merged.append(lesson)
        counts[assign_key] += 1
        seen_slots.add(slot_key)
    return merged


def _gap_total(metrics: Mapping[str, Any]) -> int:
    return sum(int(gap) * int(count) for gap, count in (metrics.get("gap_distribution") or {}).items())


def _max_gap_size(metrics: Mapping[str, Any]) -> int:
    gap_distribution = metrics.get("gap_distribution") or {}
    return max((int(gap) for gap in gap_distribution), default=0)


def _metric_int(metrics: Mapping[str, Any], key: str, default: int = 0) -> int:
    value = metrics.get(key)
    if value is None or value == "":
        return int(default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _gap0_metrics_clean(metrics: Mapping[str, Any]) -> bool:
    return (
        bool(metrics.get("hard_ok"))
        and int(metrics.get("scheduled_periods") or 0) == int(metrics.get("expected_periods") or -1)
        and int(metrics.get("one_period_teacher_sessions") or 0) == 0
        and _gap_total(metrics) == 0
        and int(metrics.get("app_constraint_violation_count") or 0) == 0
    )


def _gap1_metrics_clean(metrics: Mapping[str, Any]) -> bool:
    gap_distribution = metrics.get("gap_distribution") or {}
    max_gap = max((int(gap) for gap in gap_distribution), default=0)
    return (
        bool(metrics.get("hard_ok"))
        and int(metrics.get("scheduled_periods") or 0) == int(metrics.get("expected_periods") or -1)
        and int(metrics.get("one_period_teacher_sessions") or 0) == 0
        and max_gap <= 1
        and int(metrics.get("app_constraint_violation_count") or 0) == 0
    )


def _session_priority_metrics_acceptable(metrics: Mapping[str, Any]) -> bool:
    return (
        _session_priority_metrics_structurally_acceptable(metrics)
        and int(metrics.get("one_period_teacher_sessions") or 0) == 0
    )


def _session_priority_metrics_structurally_acceptable(metrics: Mapping[str, Any]) -> bool:
    gap_distribution = metrics.get("gap_distribution") or {}
    max_gap = max((int(gap) for gap in gap_distribution), default=0)
    return (
        bool(metrics.get("hard_ok"))
        and int(metrics.get("scheduled_periods") or 0) == int(metrics.get("expected_periods") or -1)
        and max_gap <= 1
        and int(metrics.get("app_constraint_violation_count") or 0) == 0
    )


def _complete_schedule_metrics_acceptable(metrics: Mapping[str, Any]) -> bool:
    return (
        bool(metrics.get("hard_ok"))
        and int(metrics.get("scheduled_periods") or 0) == int(metrics.get("expected_periods") or -1)
        and int(metrics.get("app_constraint_violation_count") or 0) == 0
    )


def _session_priority_quality(metrics: Mapping[str, Any]) -> tuple[int, int, int, int, int, int]:
    return (
        _metric_int(metrics, "one_period_teacher_sessions", 10**9),
        _metric_int(metrics, "teacher_sessions", 10**9),
        _gap_total(metrics),
        _metric_int(metrics, "teacher_gap1_session_max", 10**9),
        _metric_int(metrics, "teacher_gap1_session_imbalance", 10**9),
        _metric_int(metrics, "teacher_gap_imbalance", 10**9),
    )


def _session_priority_better(candidate: Mapping[str, Any], incumbent: Mapping[str, Any]) -> bool:
    """Prefer clean teacher sessions, then fewer gaps, then a fairer gap spread."""

    return _session_priority_quality(candidate) < _session_priority_quality(incumbent)


def _teacher_session_opt_quality(
    metrics: Mapping[str, Any],
    *,
    gap1_first: bool = False,
) -> tuple[int, int, int, int, int, int, int]:
    gap_distribution = metrics.get("gap_distribution") or {}
    gap1_sessions = _teacher_session_opt_gap1(metrics)
    gap2_plus_sessions = sum(
        int(count)
        for gap, count in gap_distribution.items()
        if int(gap) > 1
    )
    teacher_sessions = _metric_int(metrics, "teacher_sessions", 10**9)
    total_gap = _gap_total(metrics)
    one_period_sessions = _metric_int(metrics, "one_period_teacher_sessions", 10**9)
    gap1_imbalance = _metric_int(metrics, "teacher_gap1_session_imbalance", 10**9)
    gap_imbalance = _metric_int(metrics, "teacher_gap_imbalance", 10**9)
    if gap1_first:
        return (
            one_period_sessions,
            gap1_sessions,
            gap2_plus_sessions,
            teacher_sessions,
            total_gap,
            gap1_imbalance,
            gap_imbalance,
        )
    return (
        one_period_sessions,
        gap2_plus_sessions,
        teacher_sessions,
        gap1_sessions,
        total_gap,
        gap1_imbalance,
        gap_imbalance,
    )


def _teacher_quality_gap1_first(
    settings: Mapping[str, Any],
    target_gap1_sessions: int | None,
) -> bool:
    if _teacher_quality_uses_balanced_envelope(settings):
        return False
    return target_gap1_sessions is not None


def _teacher_quality_uses_balanced_envelope(settings: Mapping[str, Any]) -> bool:
    priority = str(settings.get("quality_priority_order") or "").strip().casefold()
    return priority == "one_period_gap2_teacher_sessions_gap1"


def _teacher_session_opt_better(candidate: Mapping[str, Any], incumbent: Mapping[str, Any]) -> bool:
    return _teacher_session_opt_quality(candidate) < _teacher_session_opt_quality(incumbent)


def _teacher_session_opt_frontier_better(
    candidate: Mapping[str, Any],
    incumbent: Mapping[str, Any],
) -> bool:
    """Rank an internal refinement frontier without accepting hard-quality debt."""

    if _metric_int(candidate, "one_period_teacher_sessions", 10**9) > _metric_int(
        incumbent,
        "one_period_teacher_sessions",
        10**9,
    ):
        return False
    if _teacher_session_opt_gap2_plus(candidate) > _teacher_session_opt_gap2_plus(incumbent):
        return False
    if _metric_int(candidate, "teacher_sessions", 10**9) > _metric_int(
        incumbent,
        "teacher_sessions",
        10**9,
    ):
        return False
    return _teacher_session_opt_quality(candidate, gap1_first=False) < _teacher_session_opt_quality(
        incumbent,
        gap1_first=False,
    )


def _complete_payload_metrics_acceptable(payload: Mapping[str, Any]) -> bool:
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), Mapping) else {}
    validation = payload.get("validation") if isinstance(payload.get("validation"), Mapping) else {}
    if not _complete_schedule_metrics_acceptable(metrics):
        return False
    if int(metrics.get("unassigned_periods") or 0) != 0:
        return False
    if payload.get("bestEffort") is True or bool(metrics.get("best_effort")):
        return False
    if validation.get("hard_ok") is False:
        return False
    return True


def _teacher_session_opt_gap1(metrics: Mapping[str, Any]) -> int:
    gap_distribution = metrics.get("gap_distribution")
    if not isinstance(gap_distribution, Mapping):
        return 10**9
    return _metric_int(gap_distribution, 1, _metric_int(gap_distribution, "1", 0))


def _teacher_session_opt_gap2_plus(metrics: Mapping[str, Any]) -> int:
    gap_distribution = metrics.get("gap_distribution")
    if not isinstance(gap_distribution, Mapping):
        return 10**9
    return sum(
        max(0, _to_int(count, 0))
        for gap, count in gap_distribution.items()
        if _to_int(gap, 0) > 1
    )


def _teacher_session_opt_quality_gates_clean(metrics: Mapping[str, Any]) -> bool:
    return (
        _complete_schedule_metrics_acceptable(metrics)
        and _metric_int(metrics, "unassigned_periods", 0) == 0
        and _metric_int(metrics, "one_period_teacher_sessions", 10**9) == 0
        and _teacher_session_opt_gap2_plus(metrics) == 0
    )


def _positive_setting(settings: Mapping[str, Any], key: str) -> int | None:
    if key not in settings:
        return None
    value = _to_int(settings.get(key), 0)
    return value if value > 0 else None


def _nonnegative_setting(settings: Mapping[str, Any], key: str) -> int | None:
    if key not in settings:
        return None
    value = _to_int(settings.get(key), -1)
    return value if value >= 0 else None


def _teacher_session_opt_target_met(
    metrics: Mapping[str, Any],
    *,
    target_teacher_sessions: int | None,
    target_gap1_sessions: int | None,
) -> bool:
    if target_teacher_sessions is None and target_gap1_sessions is None:
        return False
    if not _teacher_session_opt_quality_gates_clean(metrics):
        return False
    if target_teacher_sessions is not None and _metric_int(metrics, "teacher_sessions", 10**9) > target_teacher_sessions:
        return False
    if target_gap1_sessions is not None and _teacher_session_opt_gap1(metrics) > target_gap1_sessions:
        return False
    return True


def _teacher_session_opt_good_enough(
    metrics: Mapping[str, Any],
    *,
    accept_teacher_sessions: int | None,
    accept_gap1_sessions: int | None,
) -> bool:
    if accept_teacher_sessions is None and accept_gap1_sessions is None:
        return False
    if not _teacher_session_opt_quality_gates_clean(metrics):
        return False
    if accept_teacher_sessions is not None and _metric_int(metrics, "teacher_sessions", 10**9) > accept_teacher_sessions:
        return False
    if accept_gap1_sessions is not None and _teacher_session_opt_gap1(metrics) > accept_gap1_sessions:
        return False
    return True


def _teacher_session_opt_goal_satisfied(
    metrics: Mapping[str, Any],
    *,
    target_teacher_sessions: int | None,
    target_gap1_sessions: int | None,
    accept_teacher_sessions: int | None,
    accept_gap1_sessions: int | None,
) -> bool:
    return _teacher_session_opt_target_met(
        metrics,
        target_teacher_sessions=target_teacher_sessions,
        target_gap1_sessions=target_gap1_sessions,
    ) or _teacher_session_opt_good_enough(
        metrics,
        accept_teacher_sessions=accept_teacher_sessions,
        accept_gap1_sessions=accept_gap1_sessions,
    )


def _teacher_session_opt_should_stop(
    metrics: Mapping[str, Any],
    *,
    target_teacher_sessions: int | None,
    target_gap1_sessions: int | None,
    accept_teacher_sessions: int | None,
    accept_gap1_sessions: int | None,
) -> bool:
    """Use accept thresholds only when no optimization target exists."""

    if target_teacher_sessions is not None or target_gap1_sessions is not None:
        return _teacher_session_opt_target_met(
            metrics,
            target_teacher_sessions=target_teacher_sessions,
            target_gap1_sessions=target_gap1_sessions,
        )
    return _teacher_session_opt_good_enough(
        metrics,
        accept_teacher_sessions=accept_teacher_sessions,
        accept_gap1_sessions=accept_gap1_sessions,
    )


def _teacher_session_opt_goal_aware_better(
    candidate: Mapping[str, Any],
    incumbent: Mapping[str, Any],
    *,
    target_teacher_sessions: int | None,
    target_gap1_sessions: int | None,
    accept_teacher_sessions: int | None,
    accept_gap1_sessions: int | None,
    enforce_balanced_envelope: bool = False,
) -> bool:
    if enforce_balanced_envelope and not _teacher_session_opt_within_balanced_envelope(candidate, incumbent):
        return False

    if target_gap1_sessions is not None:
        candidate_one_period = _metric_int(candidate, "one_period_teacher_sessions", 10**9)
        incumbent_one_period = _metric_int(incumbent, "one_period_teacher_sessions", 10**9)
        candidate_sessions = _metric_int(candidate, "teacher_sessions", 10**9)
        incumbent_sessions = _metric_int(incumbent, "teacher_sessions", 10**9)
        candidate_gap1 = _teacher_session_opt_gap1(candidate)
        incumbent_gap1 = _teacher_session_opt_gap1(incumbent)
        if candidate_sessions > incumbent_sessions:
            return False
        if candidate_one_period >= incumbent_one_period and candidate_gap1 > incumbent_gap1:
            return False

    has_target = target_teacher_sessions is not None or target_gap1_sessions is not None
    if has_target:
        candidate_target = _teacher_session_opt_target_met(
            candidate,
            target_teacher_sessions=target_teacher_sessions,
            target_gap1_sessions=target_gap1_sessions,
        )
        incumbent_target = _teacher_session_opt_target_met(
            incumbent,
            target_teacher_sessions=target_teacher_sessions,
            target_gap1_sessions=target_gap1_sessions,
        )
        if candidate_target != incumbent_target:
            return candidate_target
        return _teacher_session_opt_quality(
            candidate,
            gap1_first=target_gap1_sessions is not None,
        ) < _teacher_session_opt_quality(
            incumbent,
            gap1_first=target_gap1_sessions is not None,
        )

    candidate_accept = _teacher_session_opt_good_enough(
        candidate,
        accept_teacher_sessions=accept_teacher_sessions,
        accept_gap1_sessions=accept_gap1_sessions,
    )
    incumbent_accept = _teacher_session_opt_good_enough(
        incumbent,
        accept_teacher_sessions=accept_teacher_sessions,
        accept_gap1_sessions=accept_gap1_sessions,
    )
    if candidate_accept != incumbent_accept:
        candidate_quality = _teacher_session_opt_quality(candidate)
        incumbent_quality = _teacher_session_opt_quality(incumbent)
        return (
            candidate_accept
            and candidate_quality[0] <= incumbent_quality[0]
            and candidate_quality[1] <= incumbent_quality[1]
            and candidate_quality[2] <= incumbent_quality[2]
        )
    return _teacher_session_opt_better(candidate, incumbent)


def _teacher_session_opt_within_balanced_envelope(
    candidate: Mapping[str, Any],
    incumbent: Mapping[str, Any],
) -> bool:
    """Keep the lexicographic quality envelope monotone during refinement.

    A longer optimization budget may explore more candidates, but it must never
    replace the incumbent by trading a higher-priority statistic for a lower one.
    The product order is one-period sessions, gap-2-plus sessions, teacher
    sessions, then gap-1 sessions. Consequently a candidate that turns a gap-2
    into a gap-1 may temporarily increase the visible gap-1 count; that is an
    allowed transition because the wider hard-quality debt has disappeared.
    Once gap-2 debt is tied, gap-1 must remain monotone while singleton and
    session counts are compacted.
    Hidden per-teacher imbalance values remain final tie-breakers in the quality
    tuple and never veto a primary improvement.
    """

    candidate_one = _metric_int(candidate, "one_period_teacher_sessions", 10**9)
    incumbent_one = _metric_int(incumbent, "one_period_teacher_sessions", 10**9)
    if candidate_one > incumbent_one:
        return False
    candidate_gap2 = _teacher_session_opt_gap2_plus(candidate)
    incumbent_gap2 = _teacher_session_opt_gap2_plus(incumbent)
    if candidate_gap2 > incumbent_gap2:
        return False
    if _metric_int(candidate, "teacher_sessions", 10**9) > _metric_int(
        incumbent,
        "teacher_sessions",
        10**9,
    ):
        return False
    # A gap-2 becoming a gap-1 is the canonical cleanup transition and must be
    # admissible. Merely reducing singleton count does not justify creating a
    # large number of new gap-1 sessions, so it keeps the ordinary monotone
    # gap guard below.
    primary_gate_improved = candidate_gap2 < incumbent_gap2
    incumbent_gap1 = _teacher_session_opt_gap1(incumbent)
    candidate_gap1 = _teacher_session_opt_gap1(candidate)
    if candidate_gap1 > incumbent_gap1 and not primary_gate_improved:
        return False
    if _gap_total(candidate) > _gap_total(incumbent) and not primary_gate_improved:
        return False
    return True


def _incremental_refinement_gap1_cap(metrics: Mapping[str, Any]) -> int:
    return _teacher_session_opt_gap1(metrics)


def _incremental_refinement_candidate_better(
    candidate: Mapping[str, Any],
    incumbent: Mapping[str, Any],
) -> bool:
    """Accept only a strict, no-regression improvement over best-so-far."""

    candidate_one = _metric_int(candidate, "one_period_teacher_sessions", 10**9)
    incumbent_one = _metric_int(incumbent, "one_period_teacher_sessions", 10**9)
    if candidate_one > incumbent_one:
        return False
    if _teacher_session_opt_gap2_plus(candidate) > _teacher_session_opt_gap2_plus(incumbent):
        return False
    if not _teacher_session_opt_within_balanced_envelope(candidate, incumbent):
        return False

    return _teacher_session_opt_quality(candidate, gap1_first=False) < _teacher_session_opt_quality(
        incumbent,
        gap1_first=False,
    )


def _probe_reduces_one_period(
    candidate: Mapping[str, Any],
    incumbent: Mapping[str, Any],
    *,
    allow_gap1: bool,
) -> bool:
    """A one-period probe result worth adopting even if it does not reach zero.

    The zero-probes are constrained to chase exactly zero one-period teacher
    sessions, but they often surface a partial improvement (e.g. 2 -> 1) when the
    full elimination is out of reach in the time budget. Such a result is still
    strictly better and breaks no hard constraint, so we keep it instead of
    discarding it and falling back to the worse incumbent.
    """

    if not bool(candidate.get("hard_ok")):
        return False
    if int(candidate.get("scheduled_periods") or 0) != int(candidate.get("expected_periods") or -1):
        return False
    if int(candidate.get("app_constraint_violation_count") or 0) != 0:
        return False
    gap_distribution = candidate.get("gap_distribution") or {}
    max_gap = max((int(gap) for gap in gap_distribution), default=0)
    if allow_gap1:
        if max_gap > 1:
            return False
    elif _gap_total(candidate) != 0:
        return False
    return _session_priority_better(candidate, incumbent)


def _should_attempt_session_priority_rescue(
    *,
    solver_mode: str,
    minimize_sessions: bool,
    constraints_active: bool,
    fixed_existing_lessons: bool,
    tight_capacity_hint_mode: bool,
    skip_session_priority_rescue: bool,
    minimize_one_period_sessions: bool,
    current_metrics: Mapping[str, Any],
    deadline_has_budget: bool,
    current_solver_name: str,
    current_cp_sat_status: str,
) -> bool:
    current_one_period = int(current_metrics.get("one_period_teacher_sessions") or 0)
    current_sessions = int(current_metrics.get("teacher_sessions") or 0)
    current_cp_sat_proven = (
        current_solver_name == "ortools_cp_sat_session"
        and (current_cp_sat_status == "OPTIMAL" or current_one_period == 0)
    )
    return (
        solver_mode == "auto"
        and minimize_sessions
        and constraints_active
        and not fixed_existing_lessons
        and (
            not tight_capacity_hint_mode
            or (minimize_one_period_sessions and current_one_period > 0)
        )
        and (
            not skip_session_priority_rescue
            or (minimize_one_period_sessions and current_one_period > 0)
        )
        and deadline_has_budget
        and not current_cp_sat_proven
        and current_sessions > 0
    )


def _local_one_period_cleanup(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    allow_gap1: bool,
    time_limit_seconds: float = 3.0,
    max_evaluated: int = 2500,
    target_one_period_sessions: int = 0,
) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
    """Small repair pass for cases a human can fix by rotating a few lessons."""

    if not lessons:
        return None
    current_metrics = compute_metrics(data, lessons, rules=rules)
    if int(current_metrics.get("one_period_teacher_sessions") or 0) <= 0:
        return None

    constraints = rules.constraints
    class_grade = data.class_grade
    started = time.monotonic()
    evaluated = 0
    best_lessons: list[Lesson] | None = None
    best_metrics: dict[str, Any] | None = None
    best_move: dict[str, Any] | None = None
    done = False

    by_teacher_session: dict[tuple[str, int, str], list[int]] = defaultdict(list)
    class_slots: dict[tuple[str, int, str, int], set[int]] = defaultdict(set)
    teacher_slots: dict[tuple[str, int, str, int], set[int]] = defaultdict(set)
    room_slots: dict[tuple[str, int, str, int], set[int]] = defaultdict(set)
    for index, lesson in enumerate(lessons):
        by_teacher_session[(lesson.teacher, lesson.day, lesson.session)].append(index)
        class_slots[(lesson.class_name, lesson.day, lesson.session, lesson.period)].add(index)
        teacher_slots[(lesson.teacher, lesson.day, lesson.session, lesson.period)].add(index)
        if lesson.room:
            room_slots[(lesson.room, lesson.day, lesson.session, lesson.period)].add(index)

    singleton_indexes = [
        indexes[0]
        for indexes in by_teacher_session.values()
        if len(indexes) == 1
    ]
    if not singleton_indexes:
        return None

    def timed_out() -> bool:
        return done or time.monotonic() - started >= max(0.1, float(time_limit_seconds))

    def lesson_at(lesson: Lesson, day: int, session: str, period: int) -> Lesson:
        return Lesson(
            class_name=lesson.class_name,
            grade=lesson.grade,
            day=day,
            session=session,
            period=period,
            subject=lesson.subject,
            teacher=lesson.teacher,
            room=lesson.room,
        )

    def slot_allowed(lesson: Lesson, day: int, session: str, period: int, skip: set[int]) -> bool:
        grade = class_grade.get(lesson.class_name, lesson.grade)
        if period not in class_available_periods(grade, lesson.class_name, Session(day=day, part=session), constraints):
            return False
        if class_slots.get((lesson.class_name, day, session, period), set()) - skip:
            return False
        if teacher_slots.get((lesson.teacher, day, session, period), set()) - skip:
            return False
        if lesson.room and (room_slots.get((lesson.room, day, session, period), set()) - skip):
            return False
        if constraints is not None:
            if constraints.is_fixed_off("teacher", lesson.teacher, day, session, period):
                return False
            if constraints.is_fixed_off("subject", lesson.subject, day, session, period):
                return False
            if lesson.room and constraints.is_fixed_off("room", lesson.room, day, session, period):
                return False
            if constraints.is_subject_group_fixed_off(lesson.subject, day, session, period):
                return False
        return True

    def acceptable(metrics: Mapping[str, Any]) -> bool:
        return _gap0_metrics_clean(metrics) or (
            allow_gap1 and _session_priority_metrics_acceptable(metrics)
        )

    def remember(candidate: list[Lesson], move: dict[str, Any]) -> None:
        nonlocal evaluated, best_lessons, best_metrics, best_move, done
        if evaluated >= max_evaluated or timed_out():
            return
        evaluated += 1
        metrics = compute_metrics(data, candidate, rules=rules)
        incumbent = best_metrics or current_metrics
        if acceptable(metrics) and _session_priority_better(metrics, incumbent):
            best_lessons = candidate
            best_metrics = dict(metrics)
            best_move = move
            if _metric_int(metrics, "one_period_teacher_sessions", 10**9) <= max(0, int(target_one_period_sessions)):
                done = True

    def move_summary(index: int, before: Lesson, after: Lesson) -> dict[str, Any]:
        return {
            "index": index,
            "teacher": before.teacher,
            "class": before.class_name,
            "subject": before.subject,
            "from": {"day": before.day, "session": before.session, "period": before.period},
            "to": {"day": after.day, "session": after.session, "period": after.period},
        }

    def sort_for_singleton(anchor: Lesson, index: int) -> tuple[int, int, int, int, int]:
        item = lessons[index]
        return (
            0 if item.class_name == anchor.class_name else 1,
            0 if item.teacher == anchor.teacher else 1,
            0 if (item.day, item.session) == (anchor.day, anchor.session) else 1,
            abs(item.day - anchor.day),
            abs(item.period - anchor.period),
        )

    for single_index in singleton_indexes:
        if evaluated >= max_evaluated or timed_out():
            break
        single = lessons[single_index]

        for (teacher, day, session), indexes in sorted(by_teacher_session.items()):
            if teacher != single.teacher or (day, session) == (single.day, single.session) or not indexes:
                continue
            for period in range(1, teacher_session_capacity(Session(day=day, part=session)) + 1):
                if evaluated >= max_evaluated or timed_out():
                    break
                if not slot_allowed(single, day, session, period, {single_index}):
                    continue
                moved = lesson_at(single, day, session, period)
                candidate = list(lessons)
                candidate[single_index] = moved
                remember(
                    candidate,
                    {
                        "kind": "single_move",
                        "moves": [move_summary(single_index, single, moved)],
                    },
                )

        ordered = sorted(
            [index for index in range(len(lessons)) if index != single_index],
            key=lambda index: sort_for_singleton(single, index),
        )
        for other_index in ordered[:240]:
            if evaluated >= max_evaluated or timed_out():
                break
            other = lessons[other_index]
            skip = {single_index, other_index}
            if slot_allowed(single, other.day, other.session, other.period, skip) and slot_allowed(
                other,
                single.day,
                single.session,
                single.period,
                skip,
            ):
                moved_single = lesson_at(single, other.day, other.session, other.period)
                moved_other = lesson_at(other, single.day, single.session, single.period)
                candidate = list(lessons)
                candidate[single_index] = moved_single
                candidate[other_index] = moved_other
                remember(
                    candidate,
                    {
                        "kind": "two_swap",
                        "moves": [
                            move_summary(single_index, single, moved_single),
                            move_summary(other_index, other, moved_other),
                        ],
                    },
                )

            if not slot_allowed(single, other.day, other.session, other.period, skip):
                continue
            moved_single = lesson_at(single, other.day, other.session, other.period)
            cycle_tail = sorted(
                [
                    index
                    for index in range(len(lessons))
                    if index not in {single_index, other_index}
                ],
                key=lambda index: sort_for_singleton(single, index),
            )
            for third_index in cycle_tail[:260]:
                if evaluated >= max_evaluated or timed_out():
                    break
                third = lessons[third_index]
                cycle_skip = {single_index, other_index, third_index}
                if not slot_allowed(single, other.day, other.session, other.period, cycle_skip):
                    continue
                if not slot_allowed(other, third.day, third.session, third.period, cycle_skip):
                    continue
                if not slot_allowed(third, single.day, single.session, single.period, cycle_skip):
                    continue
                moved_other = lesson_at(other, third.day, third.session, third.period)
                moved_third = lesson_at(third, single.day, single.session, single.period)
                candidate = list(lessons)
                candidate[single_index] = moved_single
                candidate[other_index] = moved_other
                candidate[third_index] = moved_third
                remember(
                    candidate,
                    {
                        "kind": "three_cycle",
                        "moves": [
                            move_summary(single_index, single, moved_single),
                            move_summary(other_index, other, moved_other),
                            move_summary(third_index, third, moved_third),
                        ],
                    },
                )

    if best_lessons is None or best_metrics is None:
        return None
    meta = {
        "one_period_local_cleanup": True,
        "one_period_local_cleanup_kind": (best_move or {}).get("kind"),
        "one_period_local_cleanup_moves": (best_move or {}).get("moves", []),
        "one_period_local_cleanup_evaluated": evaluated,
        "previous_teacher_sessions": current_metrics.get("teacher_sessions"),
        "previous_one_period_teacher_sessions": current_metrics.get("one_period_teacher_sessions"),
        "previous_gap_distribution": current_metrics.get("gap_distribution"),
        "teacher_sessions": best_metrics.get("teacher_sessions"),
        "one_period_teacher_sessions": best_metrics.get("one_period_teacher_sessions"),
        "gap_distribution": best_metrics.get("gap_distribution"),
    }
    return best_lessons, best_metrics, meta


def _add_at_most_one_internal_gap_constraints(model: Any, occupancy: list[Any]) -> None:
    """Allow at most one empty slot between any two occupied endpoints."""

    for left in range(len(occupancy)):
        for right in range(left + 3, len(occupancy)):
            interior = occupancy[left + 1 : right]
            model.Add(sum(interior) >= len(interior) - 1).OnlyEnforceIf(
                [occupancy[left], occupancy[right]]
            )


def _repair_one_period_affected_class_cluster(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    seed_classes: list[str] | None = None,
    allow_gap1: bool,
    time_limit_seconds: float = 3.0,
    max_classes: int = 4,
    max_lessons: int = 120,
    num_workers: int = 8,
    optimize_teacher_quality: bool = False,
    fixed_lessons: list[Lesson] | None = None,
    report_data: SchoolData | None = None,
    report_rules: TimetableRuleSet | None = None,
    random_seed: int | None = None,
    gap1_first: bool = False,
    preserve_teacher_quality: bool = False,
    require_quality_improvement: bool = True,
    max_gap1_sessions: int | None = None,
    stop_after_quality_gain: bool = False,
    known_current_metrics: Mapping[str, Any] | None = None,
) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
    """Repack a small class cluster while the rest of the timetable stays fixed."""
    random_seed = normalize_cp_sat_seed(random_seed)

    wall_started = time.monotonic()
    wall_deadline = wall_started + max(0.0, float(time_limit_seconds))
    if not lessons or time_limit_seconds <= 0:
        return None
    immutable_lessons = list(fixed_lessons or [])
    immutable_assignment_counts: Counter[tuple[str, str, str]] = Counter(
        (lesson.class_name, lesson.subject, lesson.teacher)
        for lesson in immutable_lessons
    )
    metric_data = report_data or data
    metric_rules = report_rules or rules
    full_lessons = [*lessons, *immutable_lessons]
    current_metrics = (
        dict(known_current_metrics)
        if isinstance(known_current_metrics, Mapping)
        else compute_metrics(metric_data, full_lessons, rules=metric_rules)
    )
    if (
        _metric_int(current_metrics, "one_period_teacher_sessions", 0) <= 0
        and not optimize_teacher_quality
    ):
        return None

    by_teacher_session: dict[tuple[str, int, str], list[Lesson]] = defaultdict(list)
    movable_by_teacher_session: dict[tuple[str, int, str], list[Lesson]] = defaultdict(list)
    for lesson in full_lessons:
        by_teacher_session[(lesson.teacher, lesson.day, lesson.session)].append(lesson)
    for lesson in lessons:
        movable_by_teacher_session[(lesson.teacher, lesson.day, lesson.session)].append(lesson)
    singleton_lessons = [
        movable_by_teacher_session[key][0]
        for key, items in by_teacher_session.items()
        if len(items) == 1 and len(movable_by_teacher_session.get(key, [])) == 1
    ]
    fixed_singleton_teacher_sessions = [
        key
        for key, items in by_teacher_session.items()
        if len(items) == 1 and not movable_by_teacher_session.get(key)
    ]
    rng = (
        random.Random(random_seed)
        if random_seed is not None and preserve_teacher_quality
        else None
    )
    if rng is not None:
        rng.shuffle(singleton_lessons)
        rng.shuffle(fixed_singleton_teacher_sessions)
    if not singleton_lessons and not fixed_singleton_teacher_sessions and not optimize_teacher_quality:
        return None

    cluster_classes: list[str] = []
    seen_classes: set[str] = set()

    def add_class(class_name: str) -> None:
        if class_name and class_name not in seen_classes and len(cluster_classes) < max(1, int(max_classes)):
            seen_classes.add(class_name)
            cluster_classes.append(class_name)

    for class_name in seed_classes or []:
        add_class(str(class_name))

    touched_teachers = {
        lesson.teacher
        for lesson in lessons
        if lesson.class_name in seen_classes
    }
    fixed_singleton_focus_teachers: set[str] = set()
    fixed_gap_focus_teacher_order: list[str] = []
    fixed_gap_focus_teachers: set[str] = set()
    focus_lessons = list(singleton_lessons)
    if optimize_teacher_quality:
        focus_keys: list[tuple[str, int, str]] = []
        for item in current_metrics.get("gap_sessions") or []:
            if not isinstance(item, Mapping):
                continue
            key = (
                str(item.get("teacher") or ""),
                _to_int(item.get("day"), 0),
                str(item.get("session") or ""),
            )
            if key[0] and key[1] > 0 and key[2] in {"AM", "PM"} and key not in focus_keys:
                focus_keys.append(key)
        if rng is not None:
            focus_keys.sort(key=lambda key: (key[0], key[1], key[2]))
            rng.shuffle(focus_keys)
        for key in focus_keys:
            teacher = key[0]
            if (
                teacher
                and not movable_by_teacher_session.get(key)
                and teacher not in fixed_gap_focus_teacher_order
            ):
                fixed_gap_focus_teacher_order.append(teacher)
        low_load_keys = [key for key, items in by_teacher_session.items() if items and movable_by_teacher_session.get(key)]
        if rng is not None:
            rng.shuffle(low_load_keys)
            low_load_keys.sort(key=lambda key: len(by_teacher_session[key]))
        else:
            low_load_keys.sort(
                key=lambda key: (len(by_teacher_session[key]), key[0], key[1], key[2])
            )
        for key in [*focus_keys, *low_load_keys]:
            key_lessons = list(movable_by_teacher_session.get(key, []))
            if rng is not None:
                rng.shuffle(key_lessons)
            for lesson in key_lessons:
                if lesson not in focus_lessons:
                    focus_lessons.append(lesson)

    if not cluster_classes and fixed_singleton_teacher_sessions:
        focus_limit = max(1, int(max_classes)) if rng is not None else len(fixed_singleton_teacher_sessions)
        fixed_singleton_focus_teachers.update(
            key[0]
            for key in fixed_singleton_teacher_sessions[:focus_limit]
            if key[0]
        )
        touched_teachers.update(fixed_singleton_focus_teachers)

    if not cluster_classes and fixed_gap_focus_teacher_order:
        focus_limit = max(1, int(max_classes))
        remaining_focus = max(0, focus_limit - len(fixed_singleton_focus_teachers))
        fixed_gap_focus_teachers.update(
            fixed_gap_focus_teacher_order[:remaining_focus]
        )
        touched_teachers.update(fixed_gap_focus_teachers)

    if not cluster_classes and not touched_teachers:
        if rng is not None and focus_lessons:
            touched_teachers.add(focus_lessons[0].teacher)
        else:
            touched_teachers.update(lesson.teacher for lesson in focus_lessons)

    for lesson in focus_lessons:
        if not touched_teachers or lesson.teacher in touched_teachers or lesson.class_name in seen_classes:
            add_class(lesson.class_name)
            touched_teachers.add(lesson.teacher)
        if len(cluster_classes) >= max(1, int(max_classes)):
            break

    if len(cluster_classes) < max(1, int(max_classes)) and touched_teachers:
        expansion_lessons = list(lessons)
        if rng is not None:
            rng.shuffle(expansion_lessons)
        for lesson in expansion_lessons:
            if lesson.teacher in touched_teachers:
                add_class(lesson.class_name)
            if len(cluster_classes) >= max(1, int(max_classes)):
                break

    if not cluster_classes:
        return None

    cluster_assignments = [assignment for assignment in data.assignments if assignment.class_name in seen_classes]
    remaining_periods_by_assignment: dict[int, int] = {}
    for assignment_index, assignment in enumerate(cluster_assignments):
        immutable_count = int(
            immutable_assignment_counts.get(
                (assignment.class_name, assignment.subject, assignment.teacher),
                0,
            )
        )
        remaining_periods = int(assignment.periods_per_week) - immutable_count
        if remaining_periods < 0:
            return None
        remaining_periods_by_assignment[assignment_index] = remaining_periods
    cluster_periods = sum(remaining_periods_by_assignment.values())
    if not cluster_assignments or cluster_periods <= 0 or cluster_periods > max(1, int(max_lessons)):
        return None

    cp_model = _load_cp_model()
    constraints = rules.constraints
    sessions = all_sessions()
    session_index = {(session.day, session.part): index for index, session in enumerate(sessions)}
    class_grade = data.class_grade
    outside_movable_lessons = [lesson for lesson in lessons if lesson.class_name not in seen_classes]
    outside_lessons = [*outside_movable_lessons, *immutable_lessons]

    fixed_class_slot: Counter[tuple[str, int, int]] = Counter()
    fixed_teacher_slot: Counter[tuple[str, int, int]] = Counter()
    fixed_room_slot: Counter[tuple[str, int, int]] = Counter()
    outside_subjects_by_class_session: dict[tuple[str, int], set[str]] = defaultdict(set)
    outside_subjects_by_class_day: dict[tuple[str, int], set[str]] = defaultdict(set)
    for lesson in outside_lessons:
        si = session_index.get((lesson.day, lesson.session))
        if si is None:
            continue
        fixed_class_slot[(lesson.class_name, si, lesson.period)] += 1
        fixed_teacher_slot[(lesson.teacher, si, lesson.period)] += 1
        if lesson.room:
            fixed_room_slot[(lesson.room, si, lesson.period)] += 1
        if lesson.subject:
            outside_subjects_by_class_session[(lesson.class_name, si)].add(lesson.subject)
            outside_subjects_by_class_day[(lesson.class_name, int(lesson.day))].add(lesson.subject)

    hinted_patterns: set[tuple[int, int, int, int]] = set()
    assignment_index = {
        (assignment.class_name, assignment.subject, assignment.teacher): index
        for index, assignment in enumerate(cluster_assignments)
    }
    hinted_by_assignment_session: dict[tuple[int, int], list[int]] = defaultdict(list)
    for lesson in lessons:
        if lesson.class_name not in seen_classes:
            continue
        ai = assignment_index.get((lesson.class_name, lesson.subject, lesson.teacher))
        si = session_index.get((lesson.day, lesson.session))
        if ai is not None and si is not None:
            hinted_by_assignment_session[(ai, si)].append(int(lesson.period))
    for (ai, si), periods in hinted_by_assignment_session.items():
        ordered = sorted(periods)
        if ordered and ordered == list(range(ordered[0], ordered[-1] + 1)):
            hinted_patterns.add((ai, si, ordered[0], len(ordered)))

    model = cp_model.CpModel()
    pattern_vars: dict[tuple[int, int, int, int], Any] = {}
    pattern_events: dict[tuple[int, int, int, int], LessonEvent] = {}
    by_assignment: dict[int, list[tuple[Any, int]]] = defaultdict(list)
    by_assignment_session: dict[tuple[int, int], list[Any]] = defaultdict(list)
    by_class_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    by_teacher_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    by_room_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
    hinted_vars: list[Any] = []

    for ai, assignment in enumerate(cluster_assignments):
        remaining_periods = remaining_periods_by_assignment.get(ai, 0)
        if remaining_periods <= 0:
            continue
        for si, session in enumerate(sessions):
            allowed = class_available_periods(
                assignment.grade,
                assignment.class_name,
                session,
                constraints,
            )
            if not allowed:
                continue
            allowed_set = set(allowed)
            max_len = min(
                assignment.max_periods_per_session,
                remaining_periods,
                teacher_session_capacity(session),
                len(allowed),
            )
            session_vars: list[Any] = []
            for length in range(1, max_len + 1):
                for start in allowed:
                    block = tuple(range(start, start + length))
                    if not all(period in allowed_set for period in block):
                        continue
                    event = LessonEvent(
                        class_name=assignment.class_name,
                        teacher=assignment.teacher,
                        subject=assignment.subject,
                        duration=length,
                        room=assignment.room,
                    )
                    if not _event_start_allowed(event, session, start, rules):
                        continue
                    if any(fixed_class_slot[(assignment.class_name, si, period)] for period in block):
                        continue
                    if any(fixed_teacher_slot[(assignment.teacher, si, period)] for period in block):
                        continue
                    if assignment.room and any(fixed_room_slot[(assignment.room, si, period)] for period in block):
                        continue
                    key = (ai, si, start, length)
                    var = model.NewBoolVar(f"cluster_p_{ai}_{si}_{start}_{length}")
                    pattern_vars[key] = var
                    pattern_events[key] = event
                    by_assignment[ai].append((var, length))
                    by_assignment_session[(ai, si)].append(var)
                    session_vars.append(var)
                    if key in hinted_patterns:
                        hinted_vars.append(var)
                        model.AddHint(var, 1)
                    else:
                        model.AddHint(var, 0)
                    for period in block:
                        by_class_slot[(assignment.class_name, si, period)].append(var)
                        by_teacher_slot[(assignment.teacher, si, period)].append(var)
                        if assignment.room:
                            by_room_slot[(assignment.room, si, period)].append(var)
            if session_vars:
                model.Add(sum(session_vars) <= 1)

    for ai, assignment in enumerate(cluster_assignments):
        required_periods = remaining_periods_by_assignment.get(ai, 0)
        terms = by_assignment.get(ai, [])
        if required_periods <= 0:
            if terms:
                model.Add(sum(var * length for var, length in terms) == 0)
            continue
        if not terms:
            return None
        model.Add(sum(var * length for var, length in terms) == required_periods)

    for class_name in cluster_classes:
        grade = class_grade.get(class_name, "")
        for si, session in enumerate(sessions):
            for period in class_available_periods(grade, class_name, session, constraints):
                terms = by_class_slot.get((class_name, si, period), [])
                if terms:
                    model.Add(sum(terms) <= 1)
    for terms in by_teacher_slot.values():
        if terms:
            model.Add(sum(terms) <= 1)
    for terms in by_room_slot.values():
        if terms:
            model.Add(sum(terms) <= 1)

    if constraints is not None:
        for teacher, required_slots in (constraints.teacher_must_teach or {}).items():
            for day, session_part, period in required_slots:
                si = session_index.get((int(day), str(session_part)))
                if si is None or fixed_teacher_slot[(str(teacher), si, int(period))]:
                    continue
                terms = by_teacher_slot.get((str(teacher), si, int(period)), [])
                if not terms:
                    return None
                model.Add(sum(terms) >= 1)

        for class_name, groups in (constraints.subject_no_same_session or {}).items():
            if class_name not in seen_classes or not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                subject_set = {str(subject) for subject in subjects if str(subject)}
                if len(subject_set) < 2:
                    continue
                for si, _session in enumerate(sessions):
                    outside_subjects = (
                        outside_subjects_by_class_session.get((class_name, si), set()) & subject_set
                    )
                    if len(outside_subjects) > 1:
                        return None
                    allowed_subject = next(iter(outside_subjects), None)
                    terms = [
                        var
                        for ai, assignment in enumerate(cluster_assignments)
                        if assignment.class_name == class_name
                        and assignment.subject in subject_set
                        and (allowed_subject is None or assignment.subject != allowed_subject)
                        for var in by_assignment_session.get((ai, si), [])
                    ]
                    if terms:
                        model.Add(sum(terms) <= (0 if allowed_subject is not None else 1))

        for class_name, groups in (constraints.subject_no_same_day or {}).items():
            if class_name not in seen_classes or not isinstance(groups, Mapping):
                continue
            for group_id, subjects in groups.items():
                subject_set = {str(subject) for subject in subjects if str(subject)}
                if len(subject_set) < 2:
                    continue
                for day in sorted({session.day for session in sessions}):
                    outside_subjects = (
                        outside_subjects_by_class_day.get((class_name, int(day)), set()) & subject_set
                    )
                    if len(outside_subjects) > 1:
                        return None
                    allowed_subject = next(iter(outside_subjects), None)
                    active_subjects: list[Any] = []
                    for subject in sorted(subject_set):
                        terms = [
                            var
                            for ai, assignment in enumerate(cluster_assignments)
                            if assignment.class_name == class_name and assignment.subject == subject
                            for si, session in enumerate(sessions)
                            if session.day == day
                            for var in by_assignment_session.get((ai, si), [])
                        ]
                        if not terms:
                            continue
                        if allowed_subject is not None:
                            if subject != allowed_subject:
                                model.Add(sum(terms) == 0)
                            continue
                        active = model.NewBoolVar(
                            f"cluster_subject_no_same_day_{class_name}_{group_id}_{subject}_{day}"
                        )
                        for term in terms:
                            model.Add(term <= active)
                        model.Add(active <= sum(terms))
                        active_subjects.append(active)
                    if len(active_subjects) > 1:
                        model.Add(sum(active_subjects) <= 1)

    limit_rules = _iter_limit_rules(rules)
    if constraints is not None and limit_rules:
        for limit_rule in limit_rules:
            if not isinstance(limit_rule, Mapping):
                continue
            per_session = limit_rule.get("perSession", {}) if isinstance(limit_rule.get("perSession"), Mapping) else {}
            for si, session in enumerate(sessions):
                cap = teacher_session_capacity(session)
                for period in range(1, cap + 1):
                    slot_outside = [
                        lesson
                        for lesson in outside_lessons
                        if lesson.day == session.day
                        and lesson.session == session.part
                        and lesson.period == period
                        and _event_matches_limit(
                            LessonEvent(lesson.class_name, lesson.teacher, lesson.subject, 1, lesson.room),
                            limit_rule,
                            rules,
                        )
                    ]
                    for field, getter in (
                        ("classes", lambda item: item.class_name),
                        ("teachers", lambda item: item.teacher),
                        ("rooms", lambda item: item.room),
                        ("subjects", lambda item: item.subject),
                    ):
                        limit = _limit_for_slot(limit_rule, field, session)
                        if limit <= 0:
                            continue
                        outside_count = len({getter(item) for item in slot_outside if getter(item)})
                        coeff = [
                            var
                            for (ai, sj, start, length), var in pattern_vars.items()
                            if sj == si
                            and start <= period < start + length
                            and _event_matches_limit(pattern_events[(ai, sj, start, length)], limit_rule, rules)
                        ]
                        if coeff or outside_count:
                            model.Add(sum(coeff) + outside_count <= limit)
                for field, getter in (
                    ("classes", lambda item: item.class_name),
                    ("teachers", lambda item: item.teacher),
                    ("rooms", lambda item: item.room),
                    ("subjects", lambda item: item.subject),
                ):
                    limit = _to_int(per_session.get(field), 0)
                    if limit <= 0:
                        continue
                    session_outside = [
                        lesson
                        for lesson in outside_lessons
                        if lesson.day == session.day
                        and lesson.session == session.part
                        and _event_matches_limit(
                            LessonEvent(lesson.class_name, lesson.teacher, lesson.subject, 1, lesson.room),
                            limit_rule,
                            rules,
                        )
                    ]
                    outside_count = len({getter(item) for item in session_outside if getter(item)})
                    coeff = [
                        var
                        for (ai, sj, start, length), var in pattern_vars.items()
                        if sj == si and _event_matches_limit(pattern_events[(ai, sj, start, length)], limit_rule, rules)
                    ]
                    if coeff or outside_count:
                        model.Add(sum(coeff) + outside_count <= limit)

    movable_teachers = {assignment.teacher for assignment in cluster_assignments if assignment.teacher}
    teacher_set = set(data.teachers)
    teacher_set.update(lesson.teacher for lesson in lessons)
    teacher_active_vars: dict[tuple[str, int], Any] = {}
    teacher_load_vars: dict[tuple[str, int], Any] = {}
    session_vars: list[Any] = []
    one_period_vars: list[Any] = []
    gap1_vars: list[Any] = []
    for teacher in sorted(teacher_set):
        if not teacher:
            continue
        for si, session in enumerate(sessions):
            cap = teacher_session_capacity(session)
            occ: list[Any] = []
            for period in range(1, cap + 1):
                terms = by_teacher_slot.get((teacher, si, period), [])
                if fixed_teacher_slot[(teacher, si, period)]:
                    occ.append(model.NewConstant(1))
                elif terms:
                    slot_var = model.NewBoolVar(f"cluster_occ_{teacher}_{si}_{period}")
                    model.Add(slot_var == sum(terms))
                    occ.append(slot_var)
                else:
                    occ.append(model.NewConstant(0))
            load = model.NewIntVar(0, cap, f"cluster_load_{teacher}_{si}")
            model.Add(load == sum(occ))
            active = model.NewBoolVar(f"cluster_active_{teacher}_{si}")
            model.Add(load >= 1).OnlyEnforceIf(active)
            model.Add(load == 0).OnlyEnforceIf(active.Not())
            teacher_active_vars[(teacher, si)] = active
            teacher_load_vars[(teacher, si)] = load
            one = model.NewBoolVar(f"cluster_one_{teacher}_{si}")
            model.Add(load == 1).OnlyEnforceIf(one)
            model.Add(load != 1).OnlyEnforceIf(one.Not())
            session_vars.append(active)
            one_period_vars.append(one)

            local_gap1_vars: list[Any] = []
            if teacher in movable_teachers:
                _add_at_most_one_internal_gap_constraints(model, occ)
            for left in range(cap - 2):
                gap = model.NewBoolVar(f"cluster_gap1_{teacher}_{si}_{left}")
                model.Add(gap <= occ[left])
                model.Add(gap <= occ[left + 2])
                model.Add(gap <= 1 - occ[left + 1])
                model.Add(gap >= occ[left] + occ[left + 2] - occ[left + 1] - 1)
                gap1_vars.append(gap)
                local_gap1_vars.append(gap)
            if local_gap1_vars and not allow_gap1:
                model.Add(sum(local_gap1_vars) == 0)

    if constraints is not None:
        for teacher, rule in constraints.teacher.items():
            if not isinstance(rule, Mapping):
                continue
            teacher_sessions = [
                si
                for si, _session in enumerate(sessions)
                if (teacher, si) in teacher_active_vars
            ]
            if not teacher_sessions:
                continue

            max_days = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
            if max_days > 0:
                day_vars = []
                for day in sorted({session.day for session in sessions}):
                    session_indexes = [si for si, session in enumerate(sessions) if session.day == day and si in teacher_sessions]
                    if not session_indexes:
                        continue
                    d_var = model.NewBoolVar(f"cluster_teacher_day_{teacher}_{day}")
                    for si in session_indexes:
                        model.Add(teacher_active_vars[(teacher, si)] <= d_var)
                    model.Add(d_var <= sum(teacher_active_vars[(teacher, si)] for si in session_indexes))
                    day_vars.append(d_var)
                if day_vars:
                    model.Add(sum(day_vars) <= max_days)

            max_sessions = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
            if max_sessions > 0:
                model.Add(sum(teacher_active_vars[(teacher, si)] for si in teacher_sessions) <= max_sessions)

            max_morning = _to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0)
            if max_morning > 0:
                model.Add(
                    sum(
                        teacher_active_vars[(teacher, si)]
                        for si in teacher_sessions
                        if sessions[si].part == "AM"
                    )
                    <= max_morning
                )

            max_afternoon = _to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0)
            if max_afternoon > 0:
                model.Add(
                    sum(
                        teacher_active_vars[(teacher, si)]
                        for si in teacher_sessions
                        if sessions[si].part == "PM"
                    )
                    <= max_afternoon
                )

            for day in sorted({session.day for session in sessions}):
                dk = _day_key(day)
                session_indexes = [si for si, session in enumerate(sessions) if session.day == day and si in teacher_sessions]
                if not session_indexes:
                    continue
                session_mode = one_session_per_day_mode(
                    _get_path(rule, f"oneSessionPerDay.{dk}", False)
                )
                if session_mode == "morning":
                    model.Add(
                        sum(
                            teacher_active_vars[(teacher, si)]
                            for si in session_indexes
                            if sessions[si].part == "PM"
                        )
                        == 0
                    )
                elif session_mode == "afternoon":
                    model.Add(
                        sum(
                            teacher_active_vars[(teacher, si)]
                            for si in session_indexes
                            if sessions[si].part == "AM"
                        )
                        == 0
                    )
                elif session_mode == "either":
                    model.Add(sum(teacher_active_vars[(teacher, si)] for si in session_indexes) <= 1)
                day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{dk}", 0), 0)
                if day_limit > 0:
                    model.Add(sum(teacher_load_vars[(teacher, si)] for si in session_indexes) <= day_limit)

            for si in teacher_sessions:
                session = sessions[si]
                limit = _to_int(_get_path(rule, f"maxPeriods.{_session_key(session)}.{_day_key(session.day)}", 0), 0)
                if limit > 0:
                    model.Add(teacher_load_vars[(teacher, si)] <= limit)

    if preserve_teacher_quality:
        model.Add(
            sum(session_vars)
            <= _metric_int(current_metrics, "teacher_sessions", len(session_vars))
        )
        model.Add(
            sum(one_period_vars)
            <= _metric_int(current_metrics, "one_period_teacher_sessions", len(one_period_vars))
        )
        gap1_cap = (
            _teacher_session_opt_gap1(current_metrics)
            if max_gap1_sessions is None
            else max(0, int(max_gap1_sessions))
        )
        model.Add(sum(gap1_vars) <= gap1_cap)

    if gap1_first:
        session_weight = 1
        gap_weight = len(session_vars) + 1
        one_period_weight = len(gap1_vars) * gap_weight + len(session_vars) + 1
    else:
        gap_weight = 1
        session_weight = len(gap1_vars) + 1
        one_period_weight = len(session_vars) * session_weight + len(gap1_vars) + 1
    quality_objective = (
        sum(one_period_vars) * one_period_weight
        + sum(session_vars) * session_weight
        + sum(gap1_vars) * gap_weight
    )
    stability_scale = len(hinted_vars) + 1
    objective = quality_objective * stability_scale
    if hinted_vars:
        objective -= sum(hinted_vars)
    model.Minimize(objective)

    remaining_search_seconds = wall_deadline - time.monotonic()
    if remaining_search_seconds <= 0.05:
        return None
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.05, remaining_search_seconds)
    solver.parameters.num_search_workers = max(1, int(num_workers))
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = 2
    solver.parameters.repair_hint = False
    if random_seed is not None:
        solver.parameters.random_seed = int(random_seed)
        solver.parameters.randomize_search = True

    quality_early_stop = None
    if stop_after_quality_gain and preserve_teacher_quality:
        current_one = _metric_int(
            current_metrics,
            "one_period_teacher_sessions",
            len(one_period_vars),
        )
        current_sessions = _metric_int(
            current_metrics,
            "teacher_sessions",
            len(session_vars),
        )
        current_gap1 = _teacher_session_opt_gap1(current_metrics)
        one_drop = max(1, min(3, _ceil_div(current_one, 8))) if current_one > 0 else 0
        gap1_drop = 2 if current_gap1 >= 20 else 1
        target_one = max(0, current_one - one_drop)
        target_sessions = max(0, current_sessions - 1)
        target_gap1 = max(0, current_gap1 - gap1_drop)
        callback_session_expr = sum(session_vars)
        callback_one_period_expr = sum(one_period_vars)
        callback_gap1_expr = sum(gap1_vars)

        class LocalQualityGainStop(cp_model.CpSolverSolutionCallback):
            def __init__(self) -> None:
                super().__init__()
                self.solution_count = 0
                self.hit = False
                self.hit_seconds: float | None = None
                self.hit_quality: tuple[int, int, int] | None = None

            def on_solution_callback(self) -> None:
                self.solution_count += 1
                one = int(self.value(callback_one_period_expr))
                sessions_count = int(self.value(callback_session_expr))
                gap1 = int(self.value(callback_gap1_expr))
                meaningful_gain = (
                    (current_one > 0 and one <= target_one)
                    or (
                        one <= current_one
                        and sessions_count <= target_sessions
                        and gap1 <= current_gap1
                    )
                    or (
                        one <= current_one
                        and sessions_count <= current_sessions
                        and current_gap1 > 0
                        and gap1 <= target_gap1
                    )
                )
                if meaningful_gain:
                    self.hit = True
                    self.hit_seconds = float(self.wall_time)
                    self.hit_quality = (one, sessions_count, gap1)
                    self.stop_search()

        quality_early_stop = LocalQualityGainStop()

    started = time.monotonic()
    status = solver.Solve(model, quality_early_stop)
    elapsed = time.monotonic() - started
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    cluster_lessons: list[Lesson] = []
    for (ai, si, start, length), var in pattern_vars.items():
        if solver.Value(var) <= 0:
            continue
        assignment = cluster_assignments[ai]
        session = sessions[si]
        for period in range(start, start + length):
            cluster_lessons.append(
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
    candidate = [*outside_movable_lessons, *cluster_lessons, *immutable_lessons]
    candidate_metrics = compute_metrics(metric_data, candidate, rules=metric_rules)
    if preserve_teacher_quality:
        gap1_cap = (
            _teacher_session_opt_gap1(current_metrics)
            if max_gap1_sessions is None
            else max(0, int(max_gap1_sessions))
        )
        if (
            not _complete_schedule_metrics_acceptable(candidate_metrics)
            or _teacher_session_opt_gap1(candidate_metrics) > gap1_cap
            or not _incremental_refinement_candidate_better(candidate_metrics, current_metrics)
        ):
            return None
    elif not (
        _gap0_metrics_clean(candidate_metrics)
        or (allow_gap1 and _session_priority_metrics_structurally_acceptable(candidate_metrics))
    ):
        return None
    if require_quality_improvement and not (
        _teacher_session_opt_quality(candidate_metrics, gap1_first=gap1_first)
        < _teacher_session_opt_quality(current_metrics, gap1_first=gap1_first)
    ):
        return None

    meta = {
        "one_period_cluster_repair": True,
        "one_period_cluster_classes": cluster_classes,
        "one_period_cluster_periods": cluster_periods,
        "one_period_cluster_status": solver.StatusName(status),
        "one_period_cluster_runtime_seconds": round(elapsed, 3),
        "one_period_cluster_wall_runtime_seconds": round(time.monotonic() - wall_started, 3),
        "one_period_cluster_pattern_vars": len(pattern_vars),
        "fixed_singleton_focus_teachers": sorted(fixed_singleton_focus_teachers),
        "fixed_gap_focus_teachers": sorted(fixed_gap_focus_teachers),
        "teacher_quality_cluster_polish": bool(optimize_teacher_quality),
        "teacher_quality_cluster_random_seed": random_seed,
        "teacher_quality_cluster_gap1_first": bool(gap1_first),
        "teacher_quality_cluster_pareto_guard": bool(preserve_teacher_quality),
        "teacher_quality_cluster_max_gap1_sessions": max_gap1_sessions,
        "teacher_quality_cluster_stability_scale": stability_scale,
        "teacher_quality_cluster_early_stop_enabled": quality_early_stop is not None,
        "teacher_quality_cluster_early_stop_hit": bool(
            quality_early_stop is not None and quality_early_stop.hit
        ),
        "teacher_quality_cluster_early_stop_seconds": (
            round(quality_early_stop.hit_seconds, 3)
            if quality_early_stop is not None and quality_early_stop.hit_seconds is not None
            else None
        ),
        "teacher_quality_cluster_early_stop_quality": (
            list(quality_early_stop.hit_quality)
            if quality_early_stop is not None and quality_early_stop.hit_quality is not None
            else None
        ),
        "teacher_quality_cluster_solution_count": (
            quality_early_stop.solution_count if quality_early_stop is not None else None
        ),
        "previous_teacher_sessions": current_metrics.get("teacher_sessions"),
        "previous_one_period_teacher_sessions": current_metrics.get("one_period_teacher_sessions"),
        "previous_gap_distribution": current_metrics.get("gap_distribution"),
        "teacher_sessions": candidate_metrics.get("teacher_sessions"),
        "one_period_teacher_sessions": candidate_metrics.get("one_period_teacher_sessions"),
        "gap_distribution": candidate_metrics.get("gap_distribution"),
    }
    return candidate, candidate_metrics, meta


def _truthy_setting(value: Any) -> bool:
    return str(value).strip().casefold() in {"1", "true", "yes", "on"}


def _solver_worker_count(settings: Mapping[str, Any] | None = None) -> int:
    settings = settings or {}
    cpu_count = max(1, int(os.cpu_count() or 1))
    env_cap_raw = os.environ.get("TKB_SOLVER_MAX_WORKERS")
    env_cap = _to_int(env_cap_raw, 0) if env_cap_raw not in (None, "") else 0
    worker_cap = max(1, min(64, env_cap if env_cap > 0 else cpu_count))
    raw = (
        settings.get("num_workers")
        if settings.get("num_workers") not in (None, "")
        else settings.get("solver_workers", settings.get("workers"))
    )
    if raw is not None and str(raw).strip().casefold() not in {"", "auto", "default"}:
        requested = _to_int(raw, 0)
        if requested > 0:
            return max(1, min(worker_cap, requested))
    return worker_cap


def _session_cp_sat_linearization_level(settings: Mapping[str, Any] | None = None) -> int:
    settings = settings or {}
    raw = settings.get("session_cp_sat_linearization_level")
    if raw in (None, ""):
        raw = os.environ.get("TKB_SESSION_CP_SAT_LINEARIZATION_LEVEL", "1")
    return max(0, min(2, _to_int(raw, 1)))


def _relaxed_teacher_session_cap(current_cap: int, expected_periods: int) -> int:
    current = max(1, int(current_cap))
    expected = max(0, int(expected_periods))
    growth = max(12, (expected + 19) // 20)
    density_cap = (expected * 2 + 4) // 5
    relaxed = max(260, current + growth, density_cap)
    return min(expected, relaxed) if expected > 0 else relaxed


def _one_period_zero_probe_proved_infeasible(solver_metrics: Mapping[str, Any]) -> bool:
    session_meta = solver_metrics.get("session_solver", {}) if isinstance(solver_metrics, Mapping) else {}
    probe = session_meta.get("one_period_zero_probe") if isinstance(session_meta, Mapping) else None
    return isinstance(probe, Mapping) and str(probe.get("status_name") or "") == "INFEASIBLE"


def _extract_fixed_lessons_from_tkb(ui_data: dict[str, Any], ctx: UiDataContext) -> tuple[list[Lesson], list[str]]:
    stored_result = ui_data.get("tkbSolverResult")
    stored_lessons = stored_result.get("lessons") if isinstance(stored_result, Mapping) else None
    if isinstance(stored_lessons, list):
        exact_lessons: list[Lesson] = []
        for item in stored_lessons:
            if not isinstance(item, Mapping):
                continue
            class_name = _text(item.get("className") or item.get("class_name") or item.get("classId") or item.get("class_id"))
            subject = _text(item.get("subject"))
            teacher = _text(item.get("teacher"))
            if not class_name or not subject or not teacher:
                continue
            exact_lessons.append(
                Lesson(
                    class_name=class_name,
                    grade=_text(item.get("grade")),
                    day=_to_int(item.get("day"), 0),
                    session=_text(item.get("session")),
                    period=_to_int(item.get("period"), 0),
                    subject=subject,
                    teacher=teacher,
                    room=_text(item.get("room")),
                )
            )
        expected = sum(item.periods_per_week for item in ctx.school_data.assignments)
        if len(exact_lessons) == expected:
            return exact_lessons, []

    raw_tkb = ui_data.get("tkb") if isinstance(ui_data.get("tkb"), Mapping) else {}
    if not raw_tkb:
        return [], []

    alias_to_subject, _aliases_by_subject = _build_subject_aliases(ui_data)
    class_by_alias: dict[str, ClassEntry] = {}
    for entry in ctx.classes:
        for alias in (entry.id, entry.name, *entry.aliases):
            class_by_alias.setdefault(_norm(alias), entry)

    assignments_by_class_subject: dict[tuple[str, str], list[Assignment]] = defaultdict(list)
    for assignment in ctx.school_data.assignments:
        assignments_by_class_subject[(assignment.class_name, assignment.subject)].append(assignment)

    lessons: list[Lesson] = []
    warnings: list[str] = []
    seen: set[tuple[str, int, str, int]] = set()

    for raw_class_id, tkb in raw_tkb.items():
        if not isinstance(tkb, Mapping):
            continue
        class_entry = class_by_alias.get(_norm(raw_class_id))
        if class_entry is None:
            warnings.append(f"Bo qua tiet da xep cua lop khong khop: {raw_class_id}.")
            continue
        for thu, day_obj in tkb.items():
            if not isinstance(day_obj, Mapping):
                continue
            day_match = re.search(r"\d+", _text(thu))
            if not day_match:
                continue
            day = int(day_match.group(0))
            for buoi, session in (("sang", "AM"), ("chieu", "PM")):
                values = day_obj.get(buoi)
                if not isinstance(values, list):
                    continue
                for ti, value in enumerate(values):
                    subject_text = _cell_subject_text(value)
                    if not subject_text or subject_text == "OFF":
                        continue
                    period = ti + 1
                    slot_key = (class_entry.name, day, session, period)
                    if slot_key in seen:
                        continue
                    seen.add(slot_key)
                    subject = _canonical_subject(subject_text, alias_to_subject)
                    candidates = assignments_by_class_subject.get((class_entry.name, subject), [])
                    if not candidates:
                        warnings.append(
                            f"Bo qua tiet da xep khong co phan cong: {class_entry.name} {subject_text}."
                        )
                        continue
                    assignment = candidates[0]
                    lessons.append(
                        Lesson(
                            class_name=class_entry.name,
                            grade=class_entry.grade,
                            day=day,
                            session=session,
                            period=period,
                            subject=assignment.subject,
                            teacher=assignment.teacher,
                            room=assignment.room,
                        )
                    )

    return lessons, warnings


def _fixed_only_tkb(ui_data: dict[str, Any]) -> dict[str, Any]:
    raw_tkb = ui_data.get("tkb") if isinstance(ui_data.get("tkb"), Mapping) else {}
    if not raw_tkb:
        return {}
    fixed_tkb: dict[str, Any] = {}
    for class_id, class_tkb in raw_tkb.items():
        if not isinstance(class_tkb, Mapping):
            continue
        class_out: dict[str, Any] = {}
        for thu, day_obj in class_tkb.items():
            if not isinstance(day_obj, Mapping):
                continue
            day_out: dict[str, Any] = {}
            for buoi, values in day_obj.items():
                if not isinstance(values, list):
                    continue
                next_values: list[Any] = ["" for _ in values]
                has_fixed = False
                for index, value in enumerate(values):
                    if not (isinstance(value, Mapping) and _truthy(value.get("fixed"))):
                        continue
                    subject = _cell_subject_text(value)
                    if not subject or subject == "OFF":
                        continue
                    next_values[index] = {"mon": subject, "fixed": True}
                    has_fixed = True
                if has_fixed:
                    day_out[str(buoi)] = next_values
            if day_out:
                class_out[str(thu)] = day_out
        if class_out:
            fixed_tkb[str(class_id)] = class_out
    return fixed_tkb


def _extract_hard_fixed_lessons_from_tkb(
    ui_data: dict[str, Any],
    ctx: UiDataContext,
) -> tuple[list[Lesson], list[str]]:
    """Extract only cells explicitly locked by the user, never a soft incumbent."""

    fixed_tkb = _fixed_only_tkb(ui_data)
    if not fixed_tkb:
        return [], []
    fixed_source = dict(ui_data)
    fixed_source.pop("tkbSolverResult", None)
    fixed_source.pop("tkbRustSolverResult", None)
    fixed_source["tkb"] = fixed_tkb
    return _extract_fixed_lessons_from_tkb(fixed_source, ctx)


def _strip_schedule_artifacts_for_fresh_solve(
    ui_data: dict[str, Any],
    *,
    preserve_fixed_lessons_only: bool = False,
) -> dict[str, Any]:
    artifact_keys = ("tkb", "tkbLessonTeachers", "tkbLessonRooms", "tkbSolverResult")
    if not any(key in ui_data for key in artifact_keys):
        return ui_data
    stripped = dict(ui_data)
    fixed_tkb = _fixed_only_tkb(ui_data) if preserve_fixed_lessons_only else {}
    for key in artifact_keys:
        stripped.pop(key, None)
    if fixed_tkb:
        stripped["tkb"] = fixed_tkb
        stripped["__tkbRequestFixedScheduleOnly"] = True
    stripped["__tkbBackendStrippedSchedule"] = True
    return stripped


def _rule_set_with_fixed_lesson_slots(
    rule_set: TimetableRuleSet,
    fixed_lessons: list[Lesson],
) -> TimetableRuleSet:
    if not fixed_lessons:
        return rule_set
    constraints = rule_set.constraints or TimetableConstraintRules(
        groups={},
        group_names={},
        fixed_off={"class": {}, "teacher": {}, "subject": {}, "room": {}, "subjectGroup": {}},
        teacher={},
        subject={},
        subject_group={},
    )
    fixed_off: dict[str, dict[str, frozenset[tuple[int, str, int]]]] = {
        kind: {str(item_id): frozenset(slots) for item_id, slots in (constraints.fixed_off.get(kind, {}) or {}).items()}
        for kind in ("class", "teacher", "subject", "room", "subjectGroup")
    }

    def add(kind: str, item_id: str, slot: tuple[int, str, int]) -> None:
        if not item_id:
            return
        current = set(fixed_off.setdefault(kind, {}).get(str(item_id), frozenset()))
        current.add(slot)
        fixed_off[kind][str(item_id)] = frozenset(current)

    for lesson in fixed_lessons:
        slot = (int(lesson.day), str(lesson.session), int(lesson.period))
        add("class", lesson.class_name, slot)
        add("teacher", lesson.teacher, slot)
        add("room", lesson.room, slot)

    return replace(rule_set, constraints=replace(constraints, fixed_off=fixed_off))


def _anchor_teacher_must_teach_lessons(
    ctx: UiDataContext,
    rule_set: TimetableRuleSet,
    fixed_lessons: list[Lesson],
) -> tuple[list[Lesson], list[str]]:
    constraints = rule_set.constraints
    if constraints is None or not constraints.teacher_must_teach:
        return [], []

    data = ctx.school_data
    assignment_by_key = {
        (assignment.class_name, assignment.subject, assignment.teacher): assignment
        for assignment in data.assignments
    }
    fixed_counts: Counter[tuple[str, str, str]] = Counter()
    assignment_session_load: Counter[tuple[str, str, str, int, str]] = Counter()
    class_subject_session_load: Counter[tuple[str, str, int, str]] = Counter()
    class_slots: set[tuple[str, int, str, int]] = set()
    teacher_slots: set[tuple[str, int, str, int]] = set()
    teacher_slot_lessons: dict[tuple[str, int, str, int], Lesson] = {}
    room_slots: set[tuple[str, int, str, int]] = set()
    covered_must_teach: set[tuple[str, int, str, int]] = set()

    def add_existing(lesson: Lesson) -> None:
        key = (lesson.class_name, lesson.subject, lesson.teacher)
        fixed_counts[key] += 1
        assignment_session_load[(lesson.class_name, lesson.subject, lesson.teacher, int(lesson.day), str(lesson.session))] += 1
        class_subject_session_load[(lesson.class_name, lesson.subject, int(lesson.day), str(lesson.session))] += 1
        class_slots.add((lesson.class_name, int(lesson.day), str(lesson.session), int(lesson.period)))
        teacher_slots.add((lesson.teacher, int(lesson.day), str(lesson.session), int(lesson.period)))
        teacher_slot_lessons[(lesson.teacher, int(lesson.day), str(lesson.session), int(lesson.period))] = lesson
        if lesson.room:
            room_slots.add((lesson.room, int(lesson.day), str(lesson.session), int(lesson.period)))
        covered_must_teach.add((lesson.teacher, int(lesson.day), str(lesson.session), int(lesson.period)))

    for lesson in fixed_lessons:
        add_existing(lesson)

    anchors: list[Lesson] = []
    warnings: list[str] = []

    def candidate_score(assignment: Assignment, day: int, session_part: str, period: int) -> tuple[int, int, int, int, tuple[int, int, str]]:
        key = (assignment.class_name, assignment.subject, assignment.teacher)
        prev_lesson = teacher_slot_lessons.get((assignment.teacher, day, session_part, period - 1))
        next_lesson = teacher_slot_lessons.get((assignment.teacher, day, session_part, period + 1))
        adjacent_same_assignment = 0
        for neighbor in (prev_lesson, next_lesson):
            if not neighbor:
                continue
            if (
                neighbor.class_name == assignment.class_name
                and neighbor.subject == assignment.subject
                and neighbor.teacher == assignment.teacher
            ):
                adjacent_same_assignment = 1
                break
        remaining = max(0, int(assignment.periods_per_week) - int(fixed_counts.get(key, 0)))
        same_session = int(assignment_session_load.get((*key, day, session_part), 0))
        subject_limit = data.limits_by_grade_subject.get((assignment.grade, assignment.subject), assignment.max_periods_per_session)
        subject_used = int(class_subject_session_load.get((assignment.class_name, assignment.subject, day, session_part), 0))
        subject_room_left = max(0, int(subject_limit) - subject_used)
        return (
            -adjacent_same_assignment,
            -remaining,
            same_session,
            -subject_room_left,
            class_sort_key(assignment.class_name),
        )

    for teacher, slots in sorted((constraints.teacher_must_teach or {}).items()):
        teacher_assignments = [
            assignment
            for assignment in data.assignments
            if assignment.teacher == teacher
        ]
        if not teacher_assignments:
            warnings.append(f"Khong tao duoc tiet neo mustTeach cho {teacher}: giao vien chua co phan cong.")
            continue
        for day, session_part, period in sorted(slots):
            day = int(day)
            session_part = str(session_part)
            period = int(period)
            if (teacher, day, session_part, period) in covered_must_teach:
                continue
            if (teacher, day, session_part, period) in teacher_slots:
                continue
            session = Session(day=day, part=session_part)
            candidates: list[Assignment] = []
            for assignment in teacher_assignments:
                key = (assignment.class_name, assignment.subject, assignment.teacher)
                if fixed_counts.get(key, 0) >= int(assignment.periods_per_week):
                    continue
                if period not in class_available_periods(assignment.grade, assignment.class_name, session, constraints):
                    continue
                if (assignment.class_name, day, session_part, period) in class_slots:
                    continue
                if assignment.room and (assignment.room, day, session_part, period) in room_slots:
                    continue
                if constraints.is_fixed_off("teacher", assignment.teacher, day, session_part, period):
                    continue
                if constraints.is_fixed_off("subject", assignment.subject, day, session_part, period):
                    continue
                if assignment.room and constraints.is_fixed_off("room", assignment.room, day, session_part, period):
                    continue
                if constraints.is_subject_group_fixed_off(assignment.subject, day, session_part, period):
                    continue
                same_assignment_session = int(assignment_session_load.get((*key, day, session_part), 0))
                if same_assignment_session >= int(assignment.max_periods_per_session):
                    continue
                subject_limit = data.limits_by_grade_subject.get((assignment.grade, assignment.subject), assignment.max_periods_per_session)
                subject_used = int(class_subject_session_load.get((assignment.class_name, assignment.subject, day, session_part), 0))
                if subject_used >= int(subject_limit):
                    continue
                candidates.append(assignment)

            if not candidates:
                warnings.append(
                    f"Khong tao duoc tiet neo mustTeach cho {teacher} Thu {day} {session_part} tiet {period}: "
                    "khong co lop/mon phu hop con tiet va khong vi pham rang buoc."
                )
                continue

            assignment = sorted(candidates, key=lambda item: candidate_score(item, day, session_part, period))[0]
            lesson = Lesson(
                class_name=assignment.class_name,
                grade=assignment.grade,
                day=day,
                session=session_part,
                period=period,
                subject=assignment.subject,
                teacher=assignment.teacher,
                room=assignment.room,
            )
            anchors.append(lesson)
            add_existing(lesson)

    if anchors:
        warnings.append(f"Da neo truoc {len(anchors)} tiet theo rang buoc giao vien phai co tiet day.")
    return anchors, warnings


def _rule_set_for_residual_fixed_lesson_validation(
    rule_set: TimetableRuleSet,
    fixed_lessons: list[Lesson],
) -> TimetableRuleSet:
    constraints = rule_set.constraints
    if constraints is None or not fixed_lessons or not constraints.teacher_must_teach:
        return rule_set

    fixed_teacher_slots: dict[str, set[tuple[int, str, int]]] = defaultdict(set)
    for lesson in fixed_lessons:
        fixed_teacher_slots[str(lesson.teacher)].add((int(lesson.day), str(lesson.session), int(lesson.period)))

    changed = False
    residual_must_teach: dict[str, frozenset[tuple[int, str, int]]] = {}
    for teacher, slots in constraints.teacher_must_teach.items():
        covered = fixed_teacher_slots.get(str(teacher), set())
        remaining = frozenset(
            (int(day), str(session), int(period))
            for day, session, period in slots
            if (int(day), str(session), int(period)) not in covered
        )
        if len(remaining) != len(slots):
            changed = True
        if remaining:
            residual_must_teach[str(teacher)] = remaining

    if not changed:
        return rule_set
    return replace(rule_set, constraints=replace(constraints, teacher_must_teach=residual_must_teach))


def _context_without_fixed_lesson_demand(
    ctx: UiDataContext,
    fixed_lessons: list[Lesson],
) -> UiDataContext:
    if not fixed_lessons:
        return ctx
    fixed_counts: Counter[tuple[str, str, str]] = Counter(
        (lesson.class_name, lesson.subject, lesson.teacher) for lesson in fixed_lessons
    )
    assignments: list[Assignment] = []
    warnings = ctx.warnings
    for assignment in ctx.school_data.assignments:
        key = (assignment.class_name, assignment.subject, assignment.teacher)
        fixed_count = int(fixed_counts.get(key, 0))
        if fixed_count <= 0:
            assignments.append(assignment)
            continue
        remaining = int(assignment.periods_per_week) - fixed_count
        if remaining < 0:
            warnings.append(
                f"So tiet co dinh vuot phan cong: {assignment.class_name} {assignment.subject} "
                f"{fixed_count}/{assignment.periods_per_week}; chi giu trong gioi han phan cong."
            )
            remaining = 0
        if remaining <= 0:
            continue
        assignments.append(
            replace(
                assignment,
                periods_per_week=remaining,
                # Keep the original per-session ceiling.  ``periods_per_week``
                # is residual demand, while this limit still applies to the
                # fixed and residual lessons together in each session.
                max_periods_per_session=int(assignment.max_periods_per_session),
            )
        )

    school_data = SchoolData(
        classes=ctx.school_data.classes,
        assignments=assignments,
        teachers=sorted({assignment.teacher for assignment in assignments} | {lesson.teacher for lesson in fixed_lessons}),
        subjects=sorted({assignment.subject for assignment in assignments} | {lesson.subject for lesson in fixed_lessons}),
        periods_by_grade_subject=dict(ctx.school_data.periods_by_grade_subject),
        limits_by_grade_subject=dict(ctx.school_data.limits_by_grade_subject),
    )
    return UiDataContext(
        school_data=school_data,
        classes=ctx.classes,
        class_by_name=ctx.class_by_name,
        rules=ctx.rules,
        warnings=warnings,
    )


def _merge_fixed_lessons_into_solution(
    lessons: list[Lesson],
    fixed_lessons: list[Lesson],
) -> list[Lesson]:
    if not fixed_lessons:
        return lessons
    fixed_slots = {
        (lesson.class_name, int(lesson.day), str(lesson.session), int(lesson.period))
        for lesson in fixed_lessons
    }
    merged = [
        lesson
        for lesson in lessons
        if (lesson.class_name, int(lesson.day), str(lesson.session), int(lesson.period)) not in fixed_slots
    ]
    merged.extend(fixed_lessons)
    return sorted(
        merged,
        key=lambda item: (
            class_sort_key(item.class_name),
            int(item.day),
            0 if item.session == "AM" else 1,
            int(item.period),
            item.subject,
            item.teacher,
        ),
    )


def _lesson_resource_conflict_details(
    lessons: list[Lesson],
    *,
    fixed_lessons: list[Lesson] | None = None,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """Return compact resource-slot diagnostics for an invalid candidate."""

    fixed_ids = {id(lesson) for lesson in (fixed_lessons or [])}
    grouped: dict[tuple[str, str, int, str, int], list[Lesson]] = defaultdict(list)
    for lesson in lessons:
        day = int(lesson.day)
        session = str(lesson.session)
        period = int(lesson.period)
        grouped[("class", str(lesson.class_name), day, session, period)].append(lesson)
        if lesson.teacher:
            grouped[("teacher", str(lesson.teacher), day, session, period)].append(lesson)
        if lesson.room:
            grouped[("room", str(lesson.room), day, session, period)].append(lesson)

    details: list[dict[str, Any]] = []
    for (kind, resource, day, session, period), items in sorted(grouped.items()):
        if len(items) <= 1:
            continue
        details.append(
            {
                "kind": kind,
                "resource": resource,
                "day": day,
                "session": session,
                "period": period,
                "lessons": [
                    {
                        "class": item.class_name,
                        "subject": item.subject,
                        "teacher": item.teacher,
                        "room": item.room,
                        "fixed": id(item) in fixed_ids,
                    }
                    for item in items
                ],
            }
        )
        if len(details) >= max(1, int(limit)):
            break
    return details


def _lesson_matches_violation(lesson: Lesson, violation: Mapping[str, Any]) -> bool:
    kind = str(violation.get("kind") or "")
    teacher = _text(violation.get("teacher"))
    class_name = _text(violation.get("class_name") or violation.get("className"))
    subject = _text(violation.get("subject"))
    room = _text(violation.get("room"))
    day = _to_int(violation.get("day"), 0)
    session = _text(violation.get("session"))
    period = _to_int(violation.get("period"), 0)

    if class_name and lesson.class_name != class_name:
        return False
    if teacher and lesson.teacher != teacher:
        return False
    if subject and lesson.subject != subject:
        return False
    if room and lesson.room != room:
        return False
    if day and lesson.day != day:
        return False
    if session and lesson.session != session:
        return False
    if period and lesson.period != period:
        return False

    if any((class_name, teacher, subject, room, day, session, period)):
        return True

    return kind.startswith(("timeLimit.", "subject.", "subjectGroup."))


def _aggregate_teacher_release_indexes(
    lessons: list[Lesson],
    protected_lessons: list[Lesson],
    violation: Mapping[str, Any],
    constraints: TimetableConstraintRules,
) -> tuple[bool, set[int]]:
    """Select only the smallest flexible groups needed by aggregate teacher caps."""

    kind = str(violation.get("kind") or "")
    teacher = _text(violation.get("teacher"))
    rule = constraints.teacher.get(teacher, {}) if teacher else {}
    if not isinstance(rule, Mapping):
        return False, set()

    session_filter: str | None = None
    if kind == "teacher.maxDays":
        limit = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
        group_key = lambda item: int(item.day)
    elif kind == "teacher.maxSessions":
        limit = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
        group_key = lambda item: (int(item.day), str(item.session))
    elif kind == "teacher.maxMorning":
        limit = _to_int(_get_path(rule, "maxMorningAfternoon.morning", 0), 0)
        session_filter = "AM"
        group_key = lambda item: int(item.day)
    elif kind == "teacher.maxAfternoon":
        limit = _to_int(_get_path(rule, "maxMorningAfternoon.afternoon", 0), 0)
        session_filter = "PM"
        group_key = lambda item: int(item.day)
    else:
        return False, set()

    if limit <= 0:
        return True, set()

    candidate_groups: dict[Any, list[int]] = defaultdict(list)
    protected_groups: set[Any] = set()
    for lesson in protected_lessons:
        if lesson.teacher != teacher or (session_filter and lesson.session != session_filter):
            continue
        protected_groups.add(group_key(lesson))
    for index, lesson in enumerate(lessons):
        if lesson.teacher != teacher or (session_filter and lesson.session != session_filter):
            continue
        candidate_groups[group_key(lesson)].append(index)

    active_groups = protected_groups | set(candidate_groups)
    excess = max(0, len(active_groups) - limit)
    if excess <= 0:
        return True, set()
    if len(protected_groups) > limit:
        return True, set()

    releasable = [
        (len(indexes), str(group), group, indexes)
        for group, indexes in candidate_groups.items()
        if group not in protected_groups and indexes
    ]
    releasable.sort(key=lambda item: (item[0], item[1]))
    if len(releasable) < excess:
        return True, set()

    selected: set[int] = set()
    for _size, _sort_key, _group, indexes in releasable[:excess]:
        selected.update(indexes)
    return True, selected


def _release_invalid_fixed_lessons(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    protected_lessons: list[Lesson] | None = None,
    release_constraint_violations: bool = True,
) -> tuple[list[Lesson], list[str]]:
    constraints = rules.constraints
    if not lessons:
        return lessons, []

    kept = list(lessons)
    protected = list(protected_lessons or [])
    warnings: list[str] = []

    # A user can lock two cells that use the same teacher (or room) at the
    # same time.  Constraint validation does not report this core resource
    # collision, but retaining both lessons would make every downstream model
    # infeasible.  Keep the first deterministic lock and release the later
    # lock back into the residual demand so the normal solver can place it.
    resource_groups: dict[tuple[str, str, int, str, int], list[int]] = defaultdict(list)
    for index, lesson in enumerate(kept):
        slot = (int(lesson.day), str(lesson.session), int(lesson.period))
        resource_groups[("class", str(lesson.class_name), *slot)].append(index)
        if lesson.teacher:
            resource_groups[("teacher", str(lesson.teacher), *slot)].append(index)
        if lesson.room:
            resource_groups[("room", str(lesson.room), *slot)].append(index)
    duplicate_indexes: set[int] = set()
    for (kind, resource, day, session, period), indexes in sorted(resource_groups.items()):
        if len(indexes) <= 1:
            continue
        duplicate_indexes.update(indexes[1:])
        warnings.append(
            f"Da mo khoa {len(indexes) - 1} tiet co dinh trung {kind} {resource} "
            f"Thu {day} {session} tiet {period} de xep lai."
        )
    if duplicate_indexes:
        kept = [lesson for index, lesson in enumerate(kept) if index not in duplicate_indexes]
        warnings.append(
            f"Da mo khoa {len(duplicate_indexes)} tiet co dinh trung tai nguyen de tranh vo nghiem."
        )

    if constraints is None or not constraints.active or not kept:
        return kept, warnings

    if not release_constraint_violations:
        fixed_check = validate_app_constraints(data, kept, rules)
        fixed_violations = fixed_check.get("violations") or []
        if fixed_violations:
            warnings.append(
                f"Co {len(fixed_violations)} vi pham lien quan den tiet co dinh; "
                "giu nguyen tiet co dinh va de bo giai bao cao neu rang buoc vo nghiem."
            )
        return kept, warnings

    released_total = len(duplicate_indexes)
    for _attempt in range(8):
        check = validate_app_constraints(data, [*protected, *kept], rules)
        violations = check.get("violations") or []
        if not violations:
            break
        remove_indexes: set[int] = set()
        actionable_violation = False
        for violation in violations:
            if not isinstance(violation, Mapping):
                continue
            if str(violation.get("kind") or "") == "teacher.mustTeach":
                continue
            actionable_violation = True
            aggregate_handled, aggregate_indexes = _aggregate_teacher_release_indexes(
                kept,
                protected,
                violation,
                constraints,
            )
            if aggregate_handled:
                remove_indexes.update(aggregate_indexes)
                continue
            for index, lesson in enumerate(kept):
                if _lesson_matches_violation(lesson, violation):
                    remove_indexes.add(index)
        if not actionable_violation:
            break
        if not remove_indexes:
            warnings.append(
                "Khong tu mo khoa hang loat khi khong xac dinh duoc nhom linh hoat toi thieu; "
                "chuyen sang bo giai day du."
            )
            break
        kept = [lesson for index, lesson in enumerate(kept) if index not in remove_indexes]
        released_total += len(remove_indexes)

    if released_total:
        warnings.append(f"Da mo khoa {released_total} tiet da xep dang vi pham rang buoc de xep lai.")
    return kept, warnings


def _load_base_period_hint(data: SchoolData, settings: Mapping[str, Any] | None = None) -> list[Lesson] | None:
    if not _legacy_solver_hints_enabled(settings):
        return None
    base_dir = Path(__file__).resolve().parents[1] / "tkb_optimizer_ref"
    path = base_dir / "base_180_gap0_period_hint.json"
    if not path.exists():
        return None
    lessons = load_period_hint(path, data)
    expected = sum(item.periods_per_week for item in data.assignments)
    if len(lessons) != expected:
        return None
    return lessons


def _period_hint_variant(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    random_seed: int | None = None,
    attempts: int = 48,
    allow_gap1: bool = False,
) -> tuple[list[Lesson], dict[str, Any]] | None:
    """Create a validated non-identical variant from a clean period hint."""

    if not lessons:
        return None
    rng = random.Random(random_seed if random_seed is not None else time.time_ns())
    original_sig = sorted(
        (item.class_name, item.subject, item.teacher, item.day, item.session, item.period, item.room)
        for item in lessons
    )

    def mapped_period(item: Lesson, reverse: bool) -> int:
        if not reverse:
            return item.period
        return (5 - item.period) if item.session == "AM" else (4 - item.period)

    for attempt in range(max(1, attempts)):
        am_days = [2, 3, 4, 5, 6]
        rng.shuffle(am_days)
        if am_days == [2, 3, 4, 5, 6] and attempt == 0:
            am_days = [6, 5, 4, 3, 2]
        pm_days = [2, 3]
        rng.shuffle(pm_days)
        reverse_by_session = {(day, "AM"): bool(rng.getrandbits(1)) for day in [2, 3, 4, 5, 6]}
        reverse_by_session.update({
            (2, "PM"): bool(rng.getrandbits(1)),
            (3, "PM"): bool(rng.getrandbits(1)),
            (4, "PM"): bool(rng.getrandbits(1)),
        })

        candidate: list[Lesson] = []
        for item in lessons:
            if item.session == "AM":
                new_day = am_days[item.day - 2]
            elif item.day in (2, 3):
                new_day = pm_days[item.day - 2]
            else:
                new_day = item.day
            candidate.append(
                Lesson(
                    class_name=item.class_name,
                    grade=item.grade,
                    day=new_day,
                    session=item.session,
                    period=mapped_period(item, reverse_by_session.get((item.day, item.session), False)),
                    subject=item.subject,
                    teacher=item.teacher,
                    room=item.room,
                )
            )

        candidate_sig = sorted(
            (item.class_name, item.subject, item.teacher, item.day, item.session, item.period, item.room)
            for item in candidate
        )
        if candidate_sig == original_sig:
            continue
        metrics = compute_metrics(data, candidate, rules=rules)
        clean = _session_priority_metrics_acceptable(metrics) if allow_gap1 else _gap0_metrics_clean(metrics)
        if clean:
            return candidate, {
                "variant": "session_day_period_permutation",
                "attempt": attempt + 1,
                "random_seed": random_seed,
                "teacher_sessions": metrics.get("teacher_sessions"),
                "gap_distribution": metrics.get("gap_distribution"),
            }
    return None


def _repair_period_hint_for_class_fixed_off(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    allow_gap1: bool = False,
    max_moves: int = 24,
) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
    """Move base-hint lessons off newly fixed rest slots, then validate."""

    constraints = rules.constraints
    if (
        constraints is None
        or not any((constraints.fixed_off or {}).get(kind) for kind in ("class", "teacher", "subject", "room", "subjectGroup"))
        or not lessons
    ):
        return None

    target_periods = sum(item.periods_per_week for item in data.assignments)
    required_drop_count = len(lessons) - target_periods
    if required_drop_count < 0:
        return None

    invalid_indexes: list[int] = []
    for index, lesson in enumerate(lessons):
        allowed = class_available_periods(
            lesson.grade,
            lesson.class_name,
            Session(day=lesson.day, part=lesson.session),
            constraints,
        )
        if (
            lesson.period not in allowed
            or constraints.is_fixed_off("teacher", lesson.teacher, lesson.day, lesson.session, lesson.period)
            or constraints.is_fixed_off("subject", lesson.subject, lesson.day, lesson.session, lesson.period)
            or (lesson.room and constraints.is_fixed_off("room", lesson.room, lesson.day, lesson.session, lesson.period))
            or constraints.is_subject_group_fixed_off(lesson.subject, lesson.day, lesson.session, lesson.period)
        ):
            invalid_indexes.append(index)

    if (
        not invalid_indexes
        or len(invalid_indexes) > max(1, max_moves)
        or required_drop_count > len(invalid_indexes)
    ):
        return None

    invalid_set = set(invalid_indexes)
    kept_lessons = [lesson for index, lesson in enumerate(lessons) if index not in invalid_set]
    by_class_slot = {
        (lesson.class_name, lesson.day, lesson.session, lesson.period)
        for lesson in kept_lessons
    }
    by_teacher_slot = {
        (lesson.teacher, lesson.day, lesson.session, lesson.period)
        for lesson in kept_lessons
    }
    by_room_slot = {
        (lesson.room, lesson.day, lesson.session, lesson.period)
        for lesson in kept_lessons
        if lesson.room
    }
    teacher_session_load: Counter[tuple[str, int, str]] = Counter(
        (lesson.teacher, lesson.day, lesson.session) for lesson in kept_lessons
    )
    class_grade = data.class_grade

    def slot_allowed_for_lesson(lesson: Lesson, day: int, session: str, period: int) -> bool:
        if (lesson.class_name, day, session, period) in by_class_slot:
            return False
        if (lesson.teacher, day, session, period) in by_teacher_slot:
            return False
        if lesson.room and (lesson.room, day, session, period) in by_room_slot:
            return False
        if constraints.is_fixed_off("teacher", lesson.teacher, day, session, period):
            return False
        if constraints.is_fixed_off("subject", lesson.subject, day, session, period):
            return False
        if lesson.room and constraints.is_fixed_off("room", lesson.room, day, session, period):
            return False
        if constraints.is_subject_group_fixed_off(lesson.subject, day, session, period):
            return False
        return True

    def candidate_slots(lesson: Lesson) -> list[tuple[int, str, int]]:
        out: list[tuple[tuple[int, int, int, int], tuple[int, str, int]]] = []
        grade = class_grade.get(lesson.class_name, lesson.grade)
        for session in all_sessions():
            for period in class_available_periods(grade, lesson.class_name, session, constraints):
                if not slot_allowed_for_lesson(lesson, session.day, session.part, period):
                    continue
                teacher_session_exists = teacher_session_load[(lesson.teacher, session.day, session.part)] > 0
                score = (
                    0 if teacher_session_exists else 1,
                    0 if session.part == lesson.session else 1,
                    abs(session.day - lesson.day),
                    abs(period - lesson.period),
                )
                out.append((score, (session.day, session.part, period)))
        out.sort(key=lambda item: item[0])
        return [slot for _score, slot in out]

    invalid_lessons = [lessons[index] for index in invalid_indexes]
    candidates_by_lesson = [(lesson, candidate_slots(lesson)) for lesson in invalid_lessons]
    candidates_by_lesson.sort(key=lambda item: len(item[1]))

    def accept(candidate: list[Lesson]) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
        metrics = compute_metrics(data, candidate, rules=rules)
        if not (
            _gap0_metrics_clean(metrics)
            or (allow_gap1 and _session_priority_metrics_structurally_acceptable(metrics))
        ):
            return None
        meta = {
            "repair": "class_fixed_off_period_hint",
            "repair_moves": len(assigned),
            "dropped_periods": required_drop_count,
            "invalid_periods": len(invalid_lessons),
            "repaired_classes": sorted({lesson.class_name for lesson in invalid_lessons}, key=class_sort_key),
            "teacher_sessions": metrics.get("teacher_sessions"),
            "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
            "gap_distribution": metrics.get("gap_distribution"),
        }
        return candidate, metrics, meta

    assigned: list[Lesson] = []
    best_repair: tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None = None
    best_repair_key: tuple[int, ...] | None = None
    evaluated_repairs = 0
    repair_search_limit = 1500

    def remember_repair(repair: tuple[list[Lesson], dict[str, Any], dict[str, Any]]) -> None:
        nonlocal best_repair, best_repair_key
        _candidate, metrics, meta = repair
        key = (
            *_session_priority_quality(metrics),
            int(meta.get("repair_moves") or 0),
        )
        if best_repair_key is None or key < best_repair_key:
            best_repair = repair
            best_repair_key = key

    def place(index: int, dropped: int) -> None:
        nonlocal evaluated_repairs
        if evaluated_repairs >= repair_search_limit:
            return
        if index >= len(candidates_by_lesson):
            if dropped != required_drop_count:
                return
            repaired = accept([*kept_lessons, *assigned])
            evaluated_repairs += 1
            if repaired is not None:
                remember_repair(repaired)
            return

        lesson, candidates = candidates_by_lesson[index]
        remaining_after_this = len(candidates_by_lesson) - index - 1
        if dropped < required_drop_count and dropped + 1 + remaining_after_this >= required_drop_count:
            place(index + 1, dropped + 1)
        for day, session, period in candidates:
            if evaluated_repairs >= repair_search_limit:
                break
            if not slot_allowed_for_lesson(lesson, day, session, period):
                continue
            moved = Lesson(
                class_name=lesson.class_name,
                grade=lesson.grade,
                day=day,
                session=session,
                period=period,
                subject=lesson.subject,
                teacher=lesson.teacher,
                room=lesson.room,
            )
            by_class_slot.add((moved.class_name, moved.day, moved.session, moved.period))
            by_teacher_slot.add((moved.teacher, moved.day, moved.session, moved.period))
            if moved.room:
                by_room_slot.add((moved.room, moved.day, moved.session, moved.period))
            teacher_session_load[(moved.teacher, moved.day, moved.session)] += 1
            assigned.append(moved)
            place(index + 1, dropped)
            assigned.pop()
            teacher_session_load[(moved.teacher, moved.day, moved.session)] -= 1
            if teacher_session_load[(moved.teacher, moved.day, moved.session)] <= 0:
                del teacher_session_load[(moved.teacher, moved.day, moved.session)]
            if moved.room:
                by_room_slot.remove((moved.room, moved.day, moved.session, moved.period))
            by_teacher_slot.remove((moved.teacher, moved.day, moved.session, moved.period))
            by_class_slot.remove((moved.class_name, moved.day, moved.session, moved.period))

    place(0, 0)
    if best_repair is not None:
        best_repair[2]["repair_candidates_evaluated"] = evaluated_repairs
        return best_repair
    return _repair_period_hint_fixed_off_with_swaps(
        data,
        lessons,
        rules,
        allow_gap1=allow_gap1,
        max_moves=max_moves,
    )


def _repair_period_hint_for_teacher_max_periods(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    allow_gap1: bool,
    max_swaps: int = 6,
    max_candidates_per_lesson: int = 260,
    allow_structural_result: bool = False,
) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
    constraints = rules.constraints
    if constraints is None or not constraints.teacher or not lessons:
        return None
    if not any(
        isinstance(rule, Mapping) and (rule.get("maxPeriods") or rule.get("maxPeriodsClass"))
        for rule in constraints.teacher.values()
    ):
        return None

    class_grade = data.class_grade

    def build_occupancy(
        current: list[Lesson],
        skip: set[int] | None = None,
    ) -> tuple[
        set[tuple[str, int, str, int]],
        set[tuple[str, int, str, int]],
        set[tuple[str, int, str, int]],
    ]:
        skip = skip or set()
        class_slots: set[tuple[str, int, str, int]] = set()
        teacher_slots: set[tuple[str, int, str, int]] = set()
        room_slots: set[tuple[str, int, str, int]] = set()
        for index, lesson in enumerate(current):
            if index in skip:
                continue
            class_slots.add((lesson.class_name, lesson.day, lesson.session, lesson.period))
            teacher_slots.add((lesson.teacher, lesson.day, lesson.session, lesson.period))
            if lesson.room:
                room_slots.add((lesson.room, lesson.day, lesson.session, lesson.period))
        return class_slots, teacher_slots, room_slots

    def slot_allowed(
        lesson: Lesson,
        day: int,
        session: str,
        period: int,
        occupancy: tuple[
            set[tuple[str, int, str, int]],
            set[tuple[str, int, str, int]],
            set[tuple[str, int, str, int]],
        ],
    ) -> bool:
        class_slots, teacher_slots, room_slots = occupancy
        grade = class_grade.get(lesson.class_name, lesson.grade)
        if period not in class_available_periods(grade, lesson.class_name, Session(day=day, part=session), constraints):
            return False
        if (lesson.class_name, day, session, period) in class_slots:
            return False
        if (lesson.teacher, day, session, period) in teacher_slots:
            return False
        if lesson.room and (lesson.room, day, session, period) in room_slots:
            return False
        if constraints.is_fixed_off("teacher", lesson.teacher, day, session, period):
            return False
        if constraints.is_fixed_off("subject", lesson.subject, day, session, period):
            return False
        if lesson.room and constraints.is_fixed_off("room", lesson.room, day, session, period):
            return False
        if constraints.is_subject_group_fixed_off(lesson.subject, day, session, period):
            return False
        return True

    def repairable_violations(current: list[Lesson]) -> list[Mapping[str, Any]]:
        check = validate_app_constraints(data, current, rules)
        items = [
            item
            for item in check.get("violations", [])
            if isinstance(item, Mapping)
            and (
                str(item.get("kind") or "")
                in {
                    "teacher.maxPeriods.session",
                    "teacher.maxPeriods.day",
                    "teacher.maxPeriodsClass.session",
                    "teacher.maxPeriodsClass.day",
                }
                or str(item.get("kind") or "").startswith("fixedOff.")
            )
        ]
        items.sort(key=lambda item: 0 if str(item.get("kind") or "").startswith("fixedOff.") else 1)
        return items

    def acceptable(metrics: Mapping[str, Any]) -> bool:
        return _gap0_metrics_clean(metrics) or (
            allow_gap1 and _session_priority_metrics_acceptable(metrics)
        )

    def structurally_returnable(metrics: Mapping[str, Any]) -> bool:
        return bool(allow_structural_result) and (
            _gap0_metrics_clean(metrics)
            or (allow_gap1 and _session_priority_metrics_structurally_acceptable(metrics))
        )

    evaluated = 0
    swaps: list[dict[str, Any]] = []

    def make_meta(metrics: Mapping[str, Any], *, structural: bool = False) -> dict[str, Any]:
        return {
            "repair": "teacher_max_periods_period_hint",
            "repair_moves": len(swaps),
            "swaps": swaps,
            "teacher_sessions": metrics.get("teacher_sessions"),
            "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
            "gap_distribution": metrics.get("gap_distribution"),
            "repair_candidates_evaluated": evaluated,
            **({"structural_result_requires_one_period_cleanup": True} if structural else {}),
        }

    current = list(lessons)
    start_metrics = compute_metrics(data, current, rules=rules)
    if acceptable(start_metrics):
        return current, start_metrics, {
            "repair": "teacher_max_periods_period_hint",
            "repair_moves": 0,
            "teacher_sessions": start_metrics.get("teacher_sessions"),
            "one_period_teacher_sessions": start_metrics.get("one_period_teacher_sessions"),
            "gap_distribution": start_metrics.get("gap_distribution"),
        }
    if structurally_returnable(start_metrics) and not repairable_violations(current):
        return current, start_metrics, make_meta(start_metrics, structural=True)
    if not repairable_violations(current):
        return None

    for _step in range(max(1, max_swaps)):
        current_metrics = compute_metrics(data, current, rules=rules)
        if acceptable(current_metrics):
            return current, current_metrics, {
                "repair": "teacher_max_periods_period_hint",
                "repair_moves": len(swaps),
                "swaps": swaps,
                "teacher_sessions": current_metrics.get("teacher_sessions"),
                "one_period_teacher_sessions": current_metrics.get("one_period_teacher_sessions"),
                "gap_distribution": current_metrics.get("gap_distribution"),
                "repair_candidates_evaluated": evaluated,
            }

        violations = repairable_violations(current)
        if not violations:
            if structurally_returnable(current_metrics):
                return current, current_metrics, make_meta(current_metrics, structural=True)
            return None
        violation = violations[0]
        kind = str(violation.get("kind") or "")

        if kind.startswith("fixedOff."):
            bad_indexes = [
                index
                for index, lesson in enumerate(current)
                if _lesson_matches_violation(lesson, violation)
            ]
            best_move: tuple[tuple[int, int, int, int], list[Lesson], dict[str, Any], dict[str, Any]] | None = None
            for bad_index in bad_indexes:
                bad = current[bad_index]
                occupancy = build_occupancy(current, {bad_index})
                candidate_slots: list[tuple[tuple[int, int, int], tuple[int, str, int]]] = []
                for session_obj in all_sessions():
                    for period in class_available_periods(
                        class_grade.get(bad.class_name, bad.grade),
                        bad.class_name,
                        session_obj,
                        constraints,
                    ):
                        if (session_obj.day, session_obj.part, period) == (bad.day, bad.session, bad.period):
                            continue
                        if not slot_allowed(bad, session_obj.day, session_obj.part, period, occupancy):
                            continue
                        candidate_slots.append(
                            (
                                (
                                    0 if session_obj.part == bad.session else 1,
                                    abs(session_obj.day - bad.day),
                                    abs(period - bad.period),
                                ),
                                (session_obj.day, session_obj.part, period),
                            )
                        )
                candidate_slots.sort(key=lambda item: item[0])
                for _score, (day2, session2, period2) in candidate_slots[:max(1, max_candidates_per_lesson)]:
                    moved = list(current)
                    moved[bad_index] = Lesson(
                        class_name=bad.class_name,
                        grade=bad.grade,
                        day=day2,
                        session=session2,
                        period=period2,
                        subject=bad.subject,
                        teacher=bad.teacher,
                        room=bad.room,
                    )
                    metrics = compute_metrics(data, moved, rules=rules)
                    evaluated += 1
                    if acceptable(metrics):
                        current = moved
                        swaps.append(
                            {
                                "kind": kind,
                                "teacher": bad.teacher,
                                "class": bad.class_name,
                                "from": [bad.day, bad.session, bad.period],
                                "to": [day2, session2, period2],
                                "move": "empty_slot",
                            }
                        )
                        return current, metrics, {
                            "repair": "teacher_max_periods_period_hint",
                            "repair_moves": len(swaps),
                            "swaps": swaps,
                            "teacher_sessions": metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": metrics.get("gap_distribution"),
                            "repair_candidates_evaluated": evaluated,
                        }
                    remaining = len(repairable_violations(moved))
                    key = (
                        remaining,
                        _metric_int(metrics, "app_constraint_violation_count", 10**9),
                        *_session_priority_quality(metrics),
                    )
                    if best_move is None or key < best_move[0]:
                        best_move = (
                            key,
                            moved,
                            metrics,
                            {
                                "kind": kind,
                                "teacher": bad.teacher,
                                "class": bad.class_name,
                                "from": [bad.day, bad.session, bad.period],
                                "to": [day2, session2, period2],
                                "move": "empty_slot",
                            },
                        )
            if best_move is None or best_move[0][0] >= len(violations):
                return None
            current = best_move[1]
            swaps.append(best_move[3])
            continue

        teacher = str(violation.get("teacher") or "")
        day = _to_int(violation.get("day"), 0)
        session = str(violation.get("session") or "")
        class_name = str(violation.get("class_name") or violation.get("class") or "")
        group_id = str(violation.get("group_id") or "")

        def subject_allowed(subject: str) -> bool:
            return not group_id or group_id in {"__all__", "all"} or constraints.subject_in_group(subject, group_id)

        overloaded = [
            index
            for index, lesson in enumerate(current)
            if lesson.teacher == teacher
            and (not day or lesson.day == day)
            and (not session or lesson.session == session)
            and (not class_name or lesson.class_name == class_name)
            and subject_allowed(lesson.subject)
        ]
        if not overloaded:
            return None

        best_candidate: tuple[tuple[int, int, int, int], list[Lesson], dict[str, Any], dict[str, Any]] | None = None
        for bad_index in overloaded:
            bad = current[bad_index]
            candidates = [
                index
                for index, other in enumerate(current)
                if index != bad_index
                and other.teacher != bad.teacher
                and other.class_name == bad.class_name
                and (other.day, other.session) != (bad.day, bad.session)
            ]
            candidates.sort(
                key=lambda index: (
                    0 if current[index].session == bad.session else 1,
                    abs(current[index].day - bad.day),
                    abs(current[index].period - bad.period),
                )
            )
            for other_index in candidates[:max(1, max_candidates_per_lesson)]:
                other = current[other_index]
                occupancy = build_occupancy(current, {bad_index, other_index})
                if not slot_allowed(bad, other.day, other.session, other.period, occupancy):
                    continue
                if not slot_allowed(other, bad.day, bad.session, bad.period, occupancy):
                    continue
                swapped = list(current)
                swapped[bad_index] = Lesson(
                    class_name=bad.class_name,
                    grade=bad.grade,
                    day=other.day,
                    session=other.session,
                    period=other.period,
                    subject=bad.subject,
                    teacher=bad.teacher,
                    room=bad.room,
                )
                swapped[other_index] = Lesson(
                    class_name=other.class_name,
                    grade=other.grade,
                    day=bad.day,
                    session=bad.session,
                    period=bad.period,
                    subject=other.subject,
                    teacher=other.teacher,
                    room=other.room,
                )
                metrics = compute_metrics(data, swapped, rules=rules)
                evaluated += 1
                if acceptable(metrics):
                    current = swapped
                    swaps.append(
                        {
                            "teacher": teacher,
                            "class": bad.class_name,
                            "from": [bad.day, bad.session, bad.period],
                            "to": [other.day, other.session, other.period],
                            "with_subject": other.subject,
                        }
                    )
                    return current, metrics, {
                        "repair": "teacher_max_periods_period_hint",
                        "repair_moves": len(swaps),
                        "swaps": swaps,
                        "teacher_sessions": metrics.get("teacher_sessions"),
                        "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
                        "gap_distribution": metrics.get("gap_distribution"),
                        "repair_candidates_evaluated": evaluated,
                    }
                remaining = len(repairable_violations(swapped))
                key = (
                    remaining,
                    _metric_int(metrics, "app_constraint_violation_count", 10**9),
                    *_session_priority_quality(metrics),
                )
                if best_candidate is None or key < best_candidate[0]:
                    best_candidate = (
                        key,
                        swapped,
                        metrics,
                        {
                            "teacher": teacher,
                            "class": bad.class_name,
                            "from": [bad.day, bad.session, bad.period],
                            "to": [other.day, other.session, other.period],
                            "with_subject": other.subject,
                        },
                    )
        if best_candidate is None:
            return None
        previous_violations = len(violations)
        if best_candidate[0][0] >= previous_violations:
            return None
        current = best_candidate[1]
        swaps.append(best_candidate[3])
    final_metrics = compute_metrics(data, current, rules=rules)
    if acceptable(final_metrics):
        return current, final_metrics, make_meta(final_metrics)
    if structurally_returnable(final_metrics):
        return current, final_metrics, make_meta(final_metrics, structural=True)
    return None


def _repair_period_hint_fixed_off_with_swaps(
    data: SchoolData,
    lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    allow_gap1: bool,
    max_moves: int,
) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
    """Repair exact-capacity fixed-off changes by moving class-off lessons, then swapping."""

    constraints = rules.constraints
    if constraints is None or not lessons:
        return None

    target_periods = sum(item.periods_per_week for item in data.assignments)
    required_drop_count = len(lessons) - target_periods
    if required_drop_count < 0:
        return None

    class_grade = data.class_grade

    def fixed_off_reasons(lesson: Lesson) -> set[str]:
        reasons: set[str] = set()
        allowed = class_available_periods(
            class_grade.get(lesson.class_name, lesson.grade),
            lesson.class_name,
            Session(day=lesson.day, part=lesson.session),
            constraints,
        )
        if lesson.period not in allowed:
            reasons.add("class")
        if constraints.is_fixed_off("teacher", lesson.teacher, lesson.day, lesson.session, lesson.period):
            reasons.add("teacher")
        if constraints.is_fixed_off("subject", lesson.subject, lesson.day, lesson.session, lesson.period):
            reasons.add("subject")
        if lesson.room and constraints.is_fixed_off("room", lesson.room, lesson.day, lesson.session, lesson.period):
            reasons.add("room")
        if constraints.is_subject_group_fixed_off(lesson.subject, lesson.day, lesson.session, lesson.period):
            reasons.add("subjectGroup")
        return reasons

    initial_invalid = [index for index, lesson in enumerate(lessons) if fixed_off_reasons(lesson)]
    if not initial_invalid or len(initial_invalid) > max(1, max_moves):
        return None

    def build_occupancy(current: list[Lesson], skip: set[int] | None = None) -> tuple[set[tuple[str, int, str, int]], set[tuple[str, int, str, int]], set[tuple[str, int, str, int]]]:
        skip = skip or set()
        class_slots: set[tuple[str, int, str, int]] = set()
        teacher_slots: set[tuple[str, int, str, int]] = set()
        room_slots: set[tuple[str, int, str, int]] = set()
        for index, lesson in enumerate(current):
            if index in skip:
                continue
            class_slots.add((lesson.class_name, lesson.day, lesson.session, lesson.period))
            teacher_slots.add((lesson.teacher, lesson.day, lesson.session, lesson.period))
            if lesson.room:
                room_slots.add((lesson.room, lesson.day, lesson.session, lesson.period))
        return class_slots, teacher_slots, room_slots

    def slot_allowed(
        lesson: Lesson,
        day: int,
        session: str,
        period: int,
        occupancy: tuple[set[tuple[str, int, str, int]], set[tuple[str, int, str, int]], set[tuple[str, int, str, int]]],
    ) -> bool:
        class_slots, teacher_slots, room_slots = occupancy
        grade = class_grade.get(lesson.class_name, lesson.grade)
        if period not in class_available_periods(grade, lesson.class_name, Session(day=day, part=session), constraints):
            return False
        if (lesson.class_name, day, session, period) in class_slots:
            return False
        if (lesson.teacher, day, session, period) in teacher_slots:
            return False
        if lesson.room and (lesson.room, day, session, period) in room_slots:
            return False
        if constraints.is_fixed_off("teacher", lesson.teacher, day, session, period):
            return False
        if constraints.is_fixed_off("subject", lesson.subject, day, session, period):
            return False
        if lesson.room and constraints.is_fixed_off("room", lesson.room, day, session, period):
            return False
        if constraints.is_subject_group_fixed_off(lesson.subject, day, session, period):
            return False
        return True

    def final_accept(current: list[Lesson], class_moves: int, swap_moves: int) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
        metrics = compute_metrics(data, current, rules=rules)
        if not (
            _gap0_metrics_clean(metrics)
            or (allow_gap1 and _session_priority_metrics_structurally_acceptable(metrics))
        ):
            return None
        meta = {
            "repair": "class_fixed_off_period_hint",
            "repair_moves": class_moves + swap_moves,
            "class_repair_moves": class_moves,
            "swap_repair_moves": swap_moves,
            "dropped_periods": required_drop_count,
            "invalid_periods": len(initial_invalid),
            "repaired_classes": sorted(
                {lessons[index].class_name for index in initial_invalid},
                key=class_sort_key,
            ),
            "teacher_sessions": metrics.get("teacher_sessions"),
            "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
            "gap_distribution": metrics.get("gap_distribution"),
        }
        return current, metrics, meta

    def repair_class_fixed_off(current: list[Lesson]) -> tuple[list[Lesson], int] | None:
        class_invalid = [index for index, lesson in enumerate(current) if "class" in fixed_off_reasons(lesson)]
        if not class_invalid:
            return (current, 0) if required_drop_count == 0 else None
        if required_drop_count > len(class_invalid):
            return None

        invalid_set = set(class_invalid)
        kept = [lesson for index, lesson in enumerate(current) if index not in invalid_set]
        assigned: list[Lesson] = []
        class_slots, teacher_slots, room_slots = build_occupancy(kept)

        def occupancy() -> tuple[set[tuple[str, int, str, int]], set[tuple[str, int, str, int]], set[tuple[str, int, str, int]]]:
            return class_slots, teacher_slots, room_slots

        def add_lesson(item: Lesson) -> None:
            class_slots.add((item.class_name, item.day, item.session, item.period))
            teacher_slots.add((item.teacher, item.day, item.session, item.period))
            if item.room:
                room_slots.add((item.room, item.day, item.session, item.period))

        def remove_lesson(item: Lesson) -> None:
            class_slots.remove((item.class_name, item.day, item.session, item.period))
            teacher_slots.remove((item.teacher, item.day, item.session, item.period))
            if item.room:
                room_slots.remove((item.room, item.day, item.session, item.period))

        def candidate_slots(lesson: Lesson) -> list[tuple[int, str, int]]:
            out: list[tuple[tuple[int, int, int], tuple[int, str, int]]] = []
            for session in all_sessions():
                for period in class_available_periods(
                    class_grade.get(lesson.class_name, lesson.grade),
                    lesson.class_name,
                    session,
                    constraints,
                ):
                    if not slot_allowed(lesson, session.day, session.part, period, occupancy()):
                        continue
                    out.append(((0 if session.part == lesson.session else 1, abs(session.day - lesson.day), abs(period - lesson.period)), (session.day, session.part, period)))
            out.sort(key=lambda item: item[0])
            return [slot for _score, slot in out]

        targets = [(current[index], candidate_slots(current[index])) for index in class_invalid]
        targets.sort(key=lambda item: len(item[1]))

        def place(index: int, dropped: int) -> list[Lesson] | None:
            if index >= len(targets):
                if dropped != required_drop_count:
                    return None
                return [*kept, *assigned]
            lesson, candidates = targets[index]
            remaining = len(targets) - index - 1
            if dropped < required_drop_count and dropped + 1 + remaining >= required_drop_count:
                result = place(index + 1, dropped + 1)
                if result is not None:
                    return result
            for day, session, period in candidates:
                moved = Lesson(
                    class_name=lesson.class_name,
                    grade=lesson.grade,
                    day=day,
                    session=session,
                    period=period,
                    subject=lesson.subject,
                    teacher=lesson.teacher,
                    room=lesson.room,
                )
                add_lesson(moved)
                assigned.append(moved)
                result = place(index + 1, dropped)
                if result is not None:
                    return result
                assigned.pop()
                remove_lesson(moved)
            return None

        repaired = place(0, 0)
        if repaired is None:
            return None
        return repaired, len(assigned)

    class_repaired = repair_class_fixed_off(list(lessons))
    if class_repaired is None:
        return None
    current, class_moves = class_repaired

    accepted = final_accept(current, class_moves, 0)
    if accepted is not None:
        return accepted

    seen_states: set[tuple[tuple[str, str, int, str, int], ...]] = set()

    def state_signature(current_lessons: list[Lesson]) -> tuple[tuple[str, str, int, str, int], ...]:
        invalid = [
            (lesson.class_name, lesson.teacher, lesson.day, lesson.session, lesson.period)
            for lesson in current_lessons
            if fixed_off_reasons(lesson)
        ]
        return tuple(sorted(invalid))

    def swap_search(current_lessons: list[Lesson], depth: int) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
        accepted_now = final_accept(current_lessons, class_moves, depth)
        if accepted_now is not None:
            return accepted_now
        if depth >= max(1, max_moves):
            return None
        sig = state_signature(current_lessons)
        if sig in seen_states:
            return None
        seen_states.add(sig)

        invalid_index = next(
            (index for index, lesson in enumerate(current_lessons) if fixed_off_reasons(lesson)),
            None,
        )
        if invalid_index is None:
            return None
        lesson = current_lessons[invalid_index]
        candidates = [
            index
            for index, other in enumerate(current_lessons)
            if index != invalid_index and not fixed_off_reasons(other)
        ]
        candidates.sort(
            key=lambda index: (
                0 if current_lessons[index].class_name == lesson.class_name else 1,
                0 if current_lessons[index].session == lesson.session else 1,
                abs(current_lessons[index].day - lesson.day),
                abs(current_lessons[index].period - lesson.period),
            )
        )
        same_class_candidates = [index for index in candidates if current_lessons[index].class_name == lesson.class_name]
        ordered_candidates = same_class_candidates or candidates[:120]

        for other_index in ordered_candidates:
            other = current_lessons[other_index]
            occ = build_occupancy(current_lessons, {invalid_index, other_index})
            if not slot_allowed(lesson, other.day, other.session, other.period, occ):
                continue
            if not slot_allowed(other, lesson.day, lesson.session, lesson.period, occ):
                continue
            swapped = list(current_lessons)
            swapped[invalid_index] = Lesson(
                class_name=lesson.class_name,
                grade=lesson.grade,
                day=other.day,
                session=other.session,
                period=other.period,
                subject=lesson.subject,
                teacher=lesson.teacher,
                room=lesson.room,
            )
            swapped[other_index] = Lesson(
                class_name=other.class_name,
                grade=other.grade,
                day=lesson.day,
                session=lesson.session,
                period=lesson.period,
                subject=other.subject,
                teacher=other.teacher,
                room=other.room,
            )
            result = swap_search(swapped, depth + 1)
            if result is not None:
                return result
        return None

    return swap_search(current, 0)


def _load_base_session_hint(
    data: SchoolData,
    *,
    prefer_gap3: bool = True,
    settings: Mapping[str, Any] | None = None,
) -> list[SessionAllocation] | None:
    if not _legacy_solver_hints_enabled(settings):
        return None
    base_dir = Path(__file__).resolve().parents[1] / "tkb_optimizer_ref"
    candidates = [
        base_dir / "base_179_session_hint.json",
        base_dir / "base_180_session_hint.json",
        base_dir / "base_181_session_hint.json",
    ]
    if prefer_gap3:
        candidates.insert(0, base_dir / "base_179_session_hint_gap3.json")
    path = next(
        (
            candidate
            for candidate in candidates
            if candidate.exists()
        ),
        None,
    )
    if path is None:
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    assignments = {
        (item.class_name, item.subject, item.teacher): item
        for item in data.assignments
    }
    rows = payload.get("solution", [])
    allocations: list[SessionAllocation] = []
    expected_by_assignment = Counter(
        (item.class_name, item.subject, item.teacher)
        for item in data.assignments
        for _ in range(item.periods_per_week)
    )
    hinted_by_assignment: Counter[tuple[str, str, str]] = Counter()
    for row in rows:
        key = (str(row["class"]), str(row["subject"]), str(row["teacher"]))
        assignment = assignments.get(key)
        if assignment is None:
            return None
        count = int(row["count"])
        allocation = SessionAllocation(
            class_name=assignment.class_name,
            grade=assignment.grade,
            subject=assignment.subject,
            teacher=assignment.teacher,
            room=str(row.get("room", "")),
            session=Session(day=int(row["day"]), part=row["session"]),
            count=count,
        )
        allocations.append(allocation)
        hinted_by_assignment[key] += count

    if hinted_by_assignment != expected_by_assignment:
        return None
    expected_periods = sum(item.periods_per_week for item in data.assignments)
    if sum(item.count for item in allocations) != expected_periods:
        return None
    if _teacher_session_count_for_allocations(allocations) > 181:
        return None
    return allocations


def _allowed_slots(ctx: UiDataContext, rules: TimetableRuleSet | None = None) -> dict[str, list[dict[str, Any]]]:
    rule_set = rules or ctx.rules
    constraints = rule_set.constraints
    out: dict[str, list[dict[str, Any]]] = {}
    for class_entry in ctx.classes:
        slots: list[dict[str, Any]] = []
        for session in all_sessions():
            for period in class_available_periods(class_entry.grade, class_entry.name, session, constraints):
                slots.append({"day": session.day, "session": session.part, "period": period})
        out[class_entry.id] = slots
    return out


def _available_slot_count(class_entry: ClassEntry, rules: TimetableRuleSet) -> int:
    constraints = rules.constraints
    return sum(
        len(class_available_periods(class_entry.grade, class_entry.name, session, constraints))
        for session in all_sessions()
    )


def _trim_context_to_available_slots(
    ctx: UiDataContext,
    rules: TimetableRuleSet,
    settings: Mapping[str, Any] | None = None,
) -> tuple[UiDataContext, list[dict[str, Any]]]:
    """Leave overflow lessons unassigned when fixed-off slots reduce capacity."""

    constraints = rules.constraints
    if constraints is None:
        return ctx, []

    class_by_name = {item.name: item for item in ctx.classes}
    reductions = [0 for _ in ctx.school_data.assignments]

    for idx, assignment in enumerate(ctx.school_data.assignments):
        total_cap = 0
        for session in all_sessions():
            if not _assignment_session_allowed(assignment, session, constraints):
                continue
            base_cap = min(
                assignment.max_periods_per_session,
                assignment.periods_per_week,
                class_session_capacity_for_constraints(assignment.grade, assignment.class_name, session, constraints),
                teacher_session_capacity(session),
            )
            total_cap += _assignment_session_cap(assignment, session, base_cap, constraints)
        if total_cap < assignment.periods_per_week:
            reductions[idx] = assignment.periods_per_week - total_cap

    expected_by_class: Counter[str] = Counter()
    for idx, assignment in enumerate(ctx.school_data.assignments):
        expected_by_class[assignment.class_name] += max(0, assignment.periods_per_week - reductions[idx])

    overflow_by_class: dict[str, int] = {}
    for class_entry in ctx.classes:
        overflow = expected_by_class[class_entry.name] - _available_slot_count(class_entry, rules)
        if overflow > 0:
            overflow_by_class[class_entry.name] = overflow

    assignment_index: dict[tuple[str, str, str, str], int] = {
        (item.class_name, item.subject, item.teacher, item.room): idx
        for idx, item in enumerate(ctx.school_data.assignments)
    }
    base_hint = _load_base_period_hint(ctx.school_data, settings)
    if base_hint:
        for lesson in base_hint:
            overflow = overflow_by_class.get(lesson.class_name, 0)
            if overflow <= 0:
                continue
            if lesson.period in class_available_periods(
                lesson.grade,
                lesson.class_name,
                Session(day=lesson.day, part=lesson.session),
                constraints,
            ):
                continue
            idx = assignment_index.get((lesson.class_name, lesson.subject, lesson.teacher, lesson.room))
            if idx is None:
                continue
            assignment = ctx.school_data.assignments[idx]
            can_drop = assignment.periods_per_week - reductions[idx]
            if can_drop <= 0:
                continue
            reductions[idx] += 1
            overflow_by_class[lesson.class_name] = overflow - 1

    for idx in range(len(ctx.school_data.assignments) - 1, -1, -1):
        assignment = ctx.school_data.assignments[idx]
        overflow = overflow_by_class.get(assignment.class_name, 0)
        if overflow <= 0:
            continue
        drop = min(assignment.periods_per_week - reductions[idx], overflow)
        if drop <= 0:
            continue
        reductions[idx] += drop
        overflow_by_class[assignment.class_name] = overflow - drop

    def teacher_capacity_after_reductions(teacher: str) -> int:
        total = 0
        for session in all_sessions():
            periods: set[int] = set()
            for idx, assignment in enumerate(ctx.school_data.assignments):
                if assignment.teacher != teacher:
                    continue
                if assignment.periods_per_week - reductions[idx] <= 0:
                    continue
                if not _assignment_session_allowed(assignment, session, constraints):
                    continue
                periods.update(_assignment_available_periods(assignment, session, constraints))
            if periods:
                total += min(teacher_session_capacity(session), len(periods))
        return total

    expected_by_teacher: Counter[str] = Counter()
    for idx, assignment in enumerate(ctx.school_data.assignments):
        kept = max(0, assignment.periods_per_week - reductions[idx])
        if kept:
            expected_by_teacher[assignment.teacher] += kept

    overflow_by_teacher: dict[str, int] = {}
    for teacher, expected in expected_by_teacher.items():
        overflow = expected - teacher_capacity_after_reductions(teacher)
        if overflow > 0:
            overflow_by_teacher[teacher] = overflow

    if base_hint and overflow_by_teacher:
        for lesson in base_hint:
            overflow = overflow_by_teacher.get(lesson.teacher, 0)
            if overflow <= 0:
                continue
            session = Session(day=lesson.day, part=lesson.session)
            idx = assignment_index.get((lesson.class_name, lesson.subject, lesson.teacher, lesson.room))
            if idx is None:
                continue
            assignment = ctx.school_data.assignments[idx]
            can_drop = assignment.periods_per_week - reductions[idx]
            if can_drop <= 0:
                continue
            if lesson.period in _assignment_available_periods(assignment, session, constraints):
                continue
            reductions[idx] += 1
            overflow_by_teacher[lesson.teacher] = overflow - 1

    for teacher in sorted(overflow_by_teacher):
        overflow = overflow_by_teacher.get(teacher, 0)
        if overflow <= 0:
            continue
        candidates = [
            idx
            for idx, assignment in enumerate(ctx.school_data.assignments)
            if assignment.teacher == teacher and assignment.periods_per_week - reductions[idx] > 0
        ]
        candidates.sort(
            key=lambda idx: (
                ctx.school_data.assignments[idx].periods_per_week - reductions[idx] == 1,
                ctx.school_data.assignments[idx].max_periods_per_session <= 1,
                idx,
            ),
            reverse=True,
        )
        for idx in candidates:
            if overflow <= 0:
                break
            assignment = ctx.school_data.assignments[idx]
            drop = min(assignment.periods_per_week - reductions[idx], overflow)
            if drop <= 0:
                continue
            reductions[idx] += drop
            overflow -= drop
        overflow_by_teacher[teacher] = overflow

    if not any(reductions):
        return ctx, []

    adjusted_assignments: list[Assignment] = []
    unassigned: list[dict[str, Any]] = []
    for assignment, drop in zip(ctx.school_data.assignments, reductions):
        class_entry = class_by_name.get(assignment.class_name)
        if drop > 0:
            teacher_limited = assignment.teacher in overflow_by_teacher
            unassigned.append(
                {
                    "classId": class_entry.id if class_entry else assignment.class_name,
                    "className": assignment.class_name,
                    "grade": assignment.grade,
                    "subject": assignment.subject,
                    "teacher": assignment.teacher,
                    "room": assignment.room,
                    "periods": drop,
                    "reason": "not_enough_available_slots",
                    "message": (
                        "Khong du o day cua giao vien sau khi ap dung tiet nghi/rang buoc."
                        if teacher_limited
                        else "Khong du o hoc sau khi ap dung tiet nghi/rang buoc cua lop."
                    ),
                }
            )
        kept = assignment.periods_per_week - drop
        if kept <= 0:
            continue
        adjusted_assignments.append(
            Assignment(
                class_name=assignment.class_name,
                grade=assignment.grade,
                subject=assignment.subject,
                teacher=assignment.teacher,
                periods_per_week=kept,
                max_periods_per_session=assignment.max_periods_per_session,
                room=assignment.room,
            )
        )

    adjusted_data = SchoolData(
        classes=ctx.school_data.classes,
        assignments=adjusted_assignments,
        teachers=ctx.school_data.teachers,
        subjects=ctx.school_data.subjects,
        periods_by_grade_subject=ctx.school_data.periods_by_grade_subject,
        limits_by_grade_subject=ctx.school_data.limits_by_grade_subject,
    )
    warnings = [
        *ctx.warnings,
        f"Con {sum(item['periods'] for item in unassigned)} tiet chua phan vi tiet nghi lam thieu o hoc.",
    ]
    return (
        UiDataContext(
            school_data=adjusted_data,
            classes=ctx.classes,
            class_by_name=ctx.class_by_name,
            rules=rules,
            warnings=warnings,
        ),
        unassigned,
    )


def _adjust_base_hint_for_class_fixed_off(
    ctx: UiDataContext,
    rules: TimetableRuleSet,
    settings: Mapping[str, Any] | None = None,
) -> tuple[UiDataContext, list[SessionAllocation], list[dict[str, Any]], dict[str, Any]] | None:
    constraints = rules.constraints
    if constraints is None or not (constraints.fixed_off or {}).get("class"):
        return None
    base_hint = _load_base_session_hint(ctx.school_data, prefer_gap3=False, settings=settings)
    if not base_hint:
        return None

    allocations = list(base_hint)
    class_by_name = {item.name: item for item in ctx.classes}
    load_by_class_session: Counter[tuple[str, int, str]] = Counter()
    teacher_load: Counter[tuple[str, int, str]] = Counter()
    for item in allocations:
        key = (item.class_name, item.session.day, item.session.part)
        load_by_class_session[key] += item.count
        teacher_load[(item.teacher, item.session.day, item.session.part)] += item.count

    reductions: Counter[int] = Counter()
    unassigned: list[dict[str, Any]] = []
    for class_entry in ctx.classes:
        for session in all_sessions():
            key = (class_entry.name, session.day, session.part)
            available = len(class_available_periods(class_entry.grade, class_entry.name, session, constraints))
            overflow = load_by_class_session[key] - available
            while overflow > 0:
                candidates = [
                    idx
                    for idx, item in enumerate(allocations)
                    if item.class_name == class_entry.name
                    and item.session == session
                    and item.count - reductions[idx] > 0
                ]
                if not candidates:
                    return None
                candidates.sort(
                    key=lambda idx: (
                        teacher_load[(allocations[idx].teacher, session.day, session.part)] > 2,
                        allocations[idx].count - reductions[idx] > 1,
                        allocations[idx].count - reductions[idx],
                    ),
                    reverse=True,
                )
                idx = candidates[0]
                item = allocations[idx]
                reductions[idx] += 1
                teacher_load[(item.teacher, session.day, session.part)] -= 1
                overflow -= 1
                unassigned.append(
                    {
                        "classId": class_by_name.get(item.class_name).id if class_by_name.get(item.class_name) else item.class_name,
                        "className": item.class_name,
                        "grade": item.grade,
                        "subject": item.subject,
                        "teacher": item.teacher,
                        "room": item.room,
                        "periods": 1,
                        "reason": "not_enough_class_slots",
                        "message": "Khong du o hoc sau khi ap dung tiet nghi cua lop.",
                    }
                )

    if not reductions:
        return None

    adjusted_allocations: list[SessionAllocation] = []
    drop_by_assignment: Counter[tuple[str, str, str, str]] = Counter()
    for idx, item in enumerate(allocations):
        kept = item.count - reductions[idx]
        if reductions[idx] > 0:
            drop_by_assignment[(item.class_name, item.subject, item.teacher, item.room)] += reductions[idx]
        if kept <= 0:
            continue
        adjusted_allocations.append(
            SessionAllocation(
                class_name=item.class_name,
                grade=item.grade,
                subject=item.subject,
                teacher=item.teacher,
                session=item.session,
                count=kept,
                room=item.room,
            )
        )

    adjusted_assignments: list[Assignment] = []
    for assignment in ctx.school_data.assignments:
        key = (assignment.class_name, assignment.subject, assignment.teacher, assignment.room)
        kept = assignment.periods_per_week - drop_by_assignment[key]
        if kept <= 0:
            continue
        adjusted_assignments.append(
            Assignment(
                class_name=assignment.class_name,
                grade=assignment.grade,
                subject=assignment.subject,
                teacher=assignment.teacher,
                periods_per_week=kept,
                max_periods_per_session=assignment.max_periods_per_session,
                room=assignment.room,
            )
        )

    adjusted_ctx = UiDataContext(
        school_data=SchoolData(
            classes=ctx.school_data.classes,
            assignments=adjusted_assignments,
            teachers=ctx.school_data.teachers,
            subjects=ctx.school_data.subjects,
            periods_by_grade_subject=ctx.school_data.periods_by_grade_subject,
            limits_by_grade_subject=ctx.school_data.limits_by_grade_subject,
        ),
        classes=ctx.classes,
        class_by_name=ctx.class_by_name,
        rules=rules,
        warnings=[
            *ctx.warnings,
            f"Con {sum(item['periods'] for item in unassigned)} tiet chua phan vi tiet nghi lop lam thieu o hoc.",
        ],
    )
    load_dist: Counter[int] = Counter()
    grouped: Counter[tuple[str, int, str]] = Counter()
    for item in adjusted_allocations:
        grouped[(item.teacher, item.session.day, item.session.part)] += item.count
    for load in grouped.values():
        load_dist[load] += 1
    session_metrics = {
        "solver": "base_session_hint_adjusted_for_class_fixed_off",
        "status_name": "FIXED_HINT",
        "teacher_sessions": len(grouped),
        "load_distribution": dict(sorted(load_dist.items())),
        "fallback_reason": "class_fixed_off_reduced_capacity",
        "dropped_periods": sum(item["periods"] for item in unassigned),
        "hint": {
            "used": True,
            "fixed": True,
            "adjusted": True,
            "hinted_assignment_sessions": len(adjusted_allocations),
            "hinted_teacher_sessions": len(grouped),
        },
    }
    return adjusted_ctx, adjusted_allocations, unassigned, session_metrics


def _placement_hard_ok_for_partial(
    metrics: Mapping[str, Any],
    *,
    allow_temporary_teacher_gap_debt: bool = False,
) -> bool:
    gap_distribution = metrics.get("gap_distribution") or {}
    max_gap = max((int(gap) for gap in gap_distribution), default=0)
    assignment_mismatches = metrics.get("assignment_mismatches") or []
    no_over_scheduled = all(
        int(item.get("actual") or 0) <= int(item.get("expected") or 0)
        for item in assignment_mismatches
        if isinstance(item, Mapping)
    )
    return (
        int(metrics.get("class_slot_conflicts") or 0) == 0
        and int(metrics.get("teacher_slot_conflicts") or 0) == 0
        and int(metrics.get("room_slot_conflicts") or 0) == 0
        and no_over_scheduled
        and not (metrics.get("class_session_violations") or [])
        and not (metrics.get("subject_session_limit_violations") or [])
        and not (metrics.get("contiguous_block_violations") or [])
        and int(metrics.get("app_constraint_violation_count") or 0) == 0
        and (allow_temporary_teacher_gap_debt or max_gap <= 1)
    )


def _unassigned_from_shortfall(
    ctx: UiDataContext,
    lessons: list[Lesson],
    *,
    reason: str,
    message: str,
) -> list[dict[str, Any]]:
    actual: Counter[tuple[str, str, str]] = Counter(
        (item.class_name, item.subject, item.teacher) for item in lessons
    )
    out: list[dict[str, Any]] = []
    for assignment in ctx.school_data.assignments:
        key = (assignment.class_name, assignment.subject, assignment.teacher)
        missing = int(assignment.periods_per_week) - int(actual.get(key, 0))
        if missing <= 0:
            continue
        class_entry = ctx.class_by_name.get(assignment.class_name)
        out.append(
            {
                "classId": class_entry.id if class_entry else assignment.class_name,
                "className": assignment.class_name,
                "grade": assignment.grade,
                "subject": assignment.subject,
                "teacher": assignment.teacher,
                "room": assignment.room,
                "periods": missing,
                "reason": reason,
                "message": message,
            }
        )
    return out


def build_payload(
    ctx: UiDataContext,
    lessons: list[Lesson],
    solver_metrics: dict[str, Any],
    rules: TimetableRuleSet | None = None,
    *,
    unassigned_lessons: list[dict[str, Any]] | None = None,
    original_ctx: UiDataContext | None = None,
    best_effort: bool = False,
    deadline_exhausted: bool = False,
    optimization_skipped_reason: str | None = None,
    allow_temporary_teacher_gap_debt: bool = False,
) -> dict[str, Any]:
    metrics = compute_metrics(ctx.school_data, lessons, rules=rules or ctx.rules)
    report_ctx = original_ctx or ctx
    unassigned_lessons = unassigned_lessons or []
    unassigned_periods = sum(_to_int(item.get("periods"), 0) for item in unassigned_lessons)
    capacity_unassigned_periods = sum(
        _to_int(item.get("periods"), 0)
        for item in unassigned_lessons
        if str(item.get("reason") or "") == "not_enough_available_slots"
    )
    solver_unassigned_periods = max(0, unassigned_periods - capacity_unassigned_periods)
    metrics.setdefault("unassigned_periods", unassigned_periods)
    if best_effort:
        metrics["best_effort"] = True
    if deadline_exhausted:
        metrics["deadline_exhausted"] = True
    if optimization_skipped_reason:
        metrics["optimization_skipped_reason"] = optimization_skipped_reason
    if original_ctx is not None or unassigned_periods:
        placement_ok = _placement_hard_ok_for_partial(
            metrics,
            allow_temporary_teacher_gap_debt=allow_temporary_teacher_gap_debt,
        )
        metrics["placement_core_hard_ok"] = placement_ok
        metrics["placement_hard_ok"] = placement_ok
        metrics["expected_periods"] = sum(item.periods_per_week for item in report_ctx.school_data.assignments)
        metrics["unassigned_periods"] = unassigned_periods
        metrics["capacity_unassigned_periods"] = capacity_unassigned_periods
        metrics["solver_unassigned_periods"] = solver_unassigned_periods
        accounted_periods = int(metrics.get("scheduled_periods") or 0) + unassigned_periods
        metrics["accounted_periods"] = accounted_periods
        metrics["capacity_limited"] = capacity_unassigned_periods > 0
        metrics["complete_schedule"] = (
            int(metrics.get("scheduled_periods") or 0) == int(metrics["expected_periods"])
        )
        metrics["accounting_ok"] = accounted_periods == int(metrics["expected_periods"])

        # Capacity shortfall and solver shortfall are different contracts.  A
        # timetable can still be placement-valid when user-selected rest slots
        # physically leave too few cells, but periods dropped by the solver are
        # never a hard-valid schedule.  In particular, the CP-SAT best-effort
        # model may surface its trivial all-unassigned incumbent near a deadline;
        # that must not become ``ok=true`` merely because scheduled+unassigned
        # happens to equal the requested workload.
        has_usable_schedule = (
            int(metrics["expected_periods"]) == 0
            or int(metrics.get("scheduled_periods") or 0) > 0
        )
        partial_hard_ok = (
            placement_ok
            and bool(metrics["accounting_ok"])
            and solver_unassigned_periods == 0
            and has_usable_schedule
        )
        metrics["core_hard_ok"] = partial_hard_ok
        metrics["hard_ok"] = partial_hard_ok
    expected_by_class: Counter[str] = Counter()
    scheduled_by_class: Counter[str] = Counter()
    unassigned_by_class: Counter[str] = Counter()
    for assignment in report_ctx.school_data.assignments:
        expected_by_class[assignment.class_name] += assignment.periods_per_week
    for lesson in lessons:
        scheduled_by_class[lesson.class_name] += 1
    for item in unassigned_lessons:
        unassigned_by_class[str(item.get("className") or "")] += _to_int(item.get("periods"), 0)

    unassigned_warnings = [
        {
            "kind": "unassigned.capacity",
            "message": f"Còn {unassigned_periods} tiết chưa phân do thiếu ô học sau khi áp dụng tiết nghỉ.",
            "periods": unassigned_periods,
        }
    ] if unassigned_periods else []
    if unassigned_periods:
        unassigned_warnings = []
        if capacity_unassigned_periods:
            unassigned_warnings.append(
                {
                    "kind": "unassigned.capacity",
                    "message": f"Con {capacity_unassigned_periods} tiet chua phan do thieu o hoc sau khi ap dung tiet nghi.",
                    "periods": capacity_unassigned_periods,
                }
            )
        if solver_unassigned_periods:
            unassigned_warnings.append(
                {
                    "kind": "unassigned.best_effort",
                    "message": f"Con {solver_unassigned_periods} tiet chua xep trong ngan sach thoi gian; da tra best-effort.",
                    "periods": solver_unassigned_periods,
                }
            )

    validation = {
        "hard_ok": bool(metrics.get("hard_ok")),
        "violations": [*metrics.get("app_constraint_violations", [])],
        "warnings": [
            *([f"Con {capacity_unassigned_periods} tiet chua phan do thieu o kha dung sau khi ap dung tiet nghi/rang buoc."] if capacity_unassigned_periods else []),
            *([f"Con {solver_unassigned_periods} tiet chua xep trong ngan sach thoi gian; da tra best-effort."] if solver_unassigned_periods else []),
            *([f"Best-effort: {optimization_skipped_reason or 'da tra ket qua hop le nhat trong ngan sach thoi gian.'}"] if best_effort else []),
            *ctx.warnings,
            *metrics.get("app_constraint_warnings", []),
        ],
        "unsupported": metrics.get("app_constraint_unsupported", []),
        "core": solver_metrics.get("validation", {}),
    }

    return {
        "ok": bool(metrics.get("hard_ok")),
        "source": "tkb-original-ui",
        "inputs": {
            "classes": len(report_ctx.school_data.classes),
            "teachers": len(report_ctx.school_data.teachers),
            "subjects": len(report_ctx.school_data.subjects),
            "assignments": len(report_ctx.school_data.assignments),
            "expectedPeriods": sum(item.periods_per_week for item in report_ctx.school_data.assignments),
            "solverAssignments": len(ctx.school_data.assignments),
            "solverExpectedPeriods": sum(item.periods_per_week for item in ctx.school_data.assignments),
        },
        "classes": [
            {
                "id": item.id,
                "name": item.name,
                "grade": item.grade,
                "expectedPeriods": expected_by_class[item.name],
                "scheduledPeriods": scheduled_by_class[item.name],
                "unassignedPeriods": unassigned_by_class[item.name],
            }
            for item in report_ctx.classes
        ],
        "teachers": ctx.school_data.teachers,
        "lessons": [
            {
                "classId": ctx.class_by_name[lesson.class_name].id,
                "className": lesson.class_name,
                "grade": lesson.grade,
                "day": lesson.day,
                "session": lesson.session,
                "period": lesson.period,
                "subject": lesson.subject,
                "teacher": lesson.teacher,
                "room": lesson.room,
            }
            for lesson in lessons
        ],
        "teacherSessions": _teacher_sessions(lessons),
        "allowedSlots": _allowed_slots(ctx, rules or ctx.rules),
        "unassignedLessons": unassigned_lessons,
        "metrics": metrics,
        "validation": validation,
        "solver": solver_metrics,
        "bestEffort": bool(best_effort),
        "deadlineExhausted": bool(deadline_exhausted),
        "warnings": validation["warnings"],
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def _constraints_allow_session_cp_sat_fast_path(rule_set: TimetableRuleSet) -> bool:
    """Allow CP-SAT session reuse for rules covered by CP-SAT or period placement."""

    constraints = rule_set.constraints
    if constraints is None or not constraints.active:
        return True

    def has_positive_limit(value: Any) -> bool:
        if not isinstance(value, Mapping):
            return False
        return any(_to_int(value.get(field), 0) > 0 for field in ("classes", "teachers", "rooms", "subjects"))

    def is_period_only_limit_rule(value: Any) -> bool:
        if not isinstance(value, Mapping):
            return True
        return not has_positive_limit(value.get("perSession"))

    def constraint_payload_active(value: Any) -> bool:
        if value in (None, "", False, 0):
            return False
        if isinstance(value, Mapping):
            return any(constraint_payload_active(item) for item in value.values())
        if isinstance(value, (list, tuple, set, frozenset)):
            return any(constraint_payload_active(item) for item in value)
        return True

    def is_cp_sat_subject_row(value: Any, *, is_group: bool) -> bool:
        if not isinstance(value, Mapping):
            return not constraint_payload_active(value)
        allowed_keys = {
            "sessionAllowed",
            "weeklySessionPeriods",
            "maxPeriods",
            "maxSessions",
        }
        if is_group:
            allowed_keys.add("maxSubjects")
        else:
            allowed_keys.update({"lessonBlocks", "avoidBreakPairs", "avoidBreakPair23", "avoidBreakPair34", "linkedDays", "spacingDays"})
        for key, item in value.items():
            if key in allowed_keys:
                continue
            if constraint_payload_active(item):
                return False
        return True

    def is_cp_sat_subject_root(value: Any, *, is_group: bool) -> bool:
        if not isinstance(value, Mapping):
            return False
        allowed_keys = {"globalLimit", "groupLimit", "byClass"}
        if any(key not in allowed_keys for key in value):
            return False
        for key in ("globalLimit", "groupLimit"):
            item = value.get(key)
            if item in (None, ""):
                continue
            if not isinstance(item, Mapping):
                return False
            if item and not is_period_only_limit_rule(item):
                return False
        by_class = value.get("byClass")
        if by_class in (None, ""):
            return True
        if not isinstance(by_class, Mapping):
            return not constraint_payload_active(by_class)
        if not all(is_cp_sat_subject_row(row, is_group=is_group) for row in by_class.values()):
            return False
        return True

    def is_cp_sat_teacher_rule(value: Any) -> bool:
        if not isinstance(value, Mapping):
            return not constraint_payload_active(value)
        cp_sat_keys = {
            "maxDaysSessions",
            "maxMorningAfternoon",
            "oneSessionPerDay",
            "maxPeriods",
            "maxPeriodsClass",
            "mustTeach",
            "noMorningP5AfternoonP1",
        }
        for key, item in value.items():
            if key in cp_sat_keys:
                continue
            if constraint_payload_active(item):
                return False
        return True

    fixed_off = constraints.fixed_off or {}
    has_period_fixed_off = any(
        fixed_off.get(kind)
        for kind in ("class", "teacher", "subject", "room", "subjectGroup")
    )
    has_time_limit = any(isinstance(item, Mapping) for item in constraints.time_limit)
    time_limits_are_period_only = all(is_period_only_limit_rule(item) for item in constraints.time_limit)
    teacher_rules_are_cp_sat = all(is_cp_sat_teacher_rule(rule) for rule in constraints.teacher.values())
    subject_rules_are_cp_sat = all(is_cp_sat_subject_root(item, is_group=False) for item in constraints.subject.values())
    subject_group_rules_are_cp_sat = all(is_cp_sat_subject_root(item, is_group=True) for item in constraints.subject_group.values())
    return (
        (
            has_period_fixed_off
            or has_time_limit
            or bool(constraints.teacher)
            or bool(getattr(constraints, "teacher_must_teach", {}))
            or bool(constraints.subject)
            or bool(constraints.subject_group)
            or bool(getattr(constraints, "subject_no_same_session", {}))
            or bool(getattr(constraints, "subject_no_same_day", {}))
            or bool(getattr(constraints, "class_extra_slots", {}))
        )
        and teacher_rules_are_cp_sat
        and subject_rules_are_cp_sat
        and subject_group_rules_are_cp_sat
        and time_limits_are_period_only
    )


def _constraints_need_lesson_block_feasibility_ceiling(rule_set: TimetableRuleSet) -> bool:
    constraints = rule_set.constraints
    if constraints is None or not constraints.active:
        return False

    def has_positive_lesson_block_min(rule: Any) -> bool:
        if not isinstance(rule, Mapping):
            return False
        candidates: list[Mapping[str, Any]] = [rule]
        by_class = rule.get("byClass")
        if isinstance(by_class, Mapping):
            candidates.extend(item for item in by_class.values() if isinstance(item, Mapping))
        for item in candidates:
            blocks = item.get("lessonBlocks")
            if not isinstance(blocks, Mapping):
                continue
            for block_rule in blocks.values():
                if isinstance(block_rule, Mapping) and _to_int(block_rule.get("min"), 0) > 0:
                    return True
        return False

    for rule_map in (constraints.subject, constraints.subject_group):
        if any(has_positive_lesson_block_min(rule) for rule in (rule_map or {}).values()):
            return True
    return False


def _subject_like_rule_needs_period_bridge(row: Any) -> bool:
    if not isinstance(row, Mapping):
        return False
    lesson_blocks = row.get("lessonBlocks")
    if isinstance(lesson_blocks, Mapping):
        for conf in lesson_blocks.values():
            if isinstance(conf, Mapping) and (
                _to_int(conf.get("min"), 0) > 0 or _to_int(conf.get("max"), 0) > 0
            ):
                return True
    for key in ("avoidBreakPairs", "avoidBreakPair23", "avoidBreakPair34"):
        value = row.get(key)
        if isinstance(value, Mapping) and any(_truthy_setting(item) for item in value.values()):
            return True
    linked = row.get("linkedDays")
    if isinstance(linked, Mapping):
        for session_key in ("sang", "chieu"):
            for day in range(2, 8):
                if _linked_day_avoided(linked, session_key, _day_key(day)):
                    return True
    return False


def _constraints_have_subject_period_requirements(rule_set: TimetableRuleSet) -> bool:
    constraints = rule_set.constraints
    if constraints is None or not constraints.active:
        return False
    for rule_map in (constraints.subject, constraints.subject_group):
        for root in (rule_map or {}).values():
            by_class = root.get("byClass", {}) if isinstance(root, Mapping) else {}
            if isinstance(by_class, Mapping) and any(
                _subject_like_rule_needs_period_bridge(row)
                for row in by_class.values()
            ):
                return True
    return False


def _constraints_need_period_feasibility_bridge(rule_set: TimetableRuleSet) -> bool:
    constraints = rule_set.constraints
    if constraints is None or not constraints.active:
        return False

    # Class fixed-off can make a half-day exact-capacity. The session-level
    # solver must then reason about concrete period collisions up front, not
    # only per-class/per-teacher capacities.
    fixed_off = constraints.fixed_off or {}
    if fixed_off.get("class"):
        return True

    def teacher_rule_needs_period_bridge(rule: Any) -> bool:
        if not isinstance(rule, Mapping):
            return False
        # Day/session counts are represented directly by d_vars/z_vars in the
        # session CP-SAT model, including fixed lessons. They do not need the
        # much larger concrete-period bridge. Only rules that name actual
        # periods or cross the AM/PM period boundary belong below.
        must_teach = rule.get("mustTeach")
        if isinstance(must_teach, Mapping) and any(_truthy_setting(item) for item in must_teach.values()):
            return True
        forbidden_edge_pair = rule.get("noMorningP5AfternoonP1")
        if isinstance(forbidden_edge_pair, Mapping) and any(
            _truthy_setting(item)
            for value in forbidden_edge_pair.values()
            for item in (value.values() if isinstance(value, Mapping) else (value,))
        ):
            return True
        return False

    if any(teacher_rule_needs_period_bridge(rule) for rule in (constraints.teacher or {}).values()):
        return True
    return _constraints_have_subject_period_requirements(rule_set)


def _normalized_auto_sort_mode(settings: Mapping[str, Any] | None) -> str:
    return str((settings or {}).get("auto_sort_mode") or "fast").strip().casefold().replace("-", "_")


def _is_teacher_session_opt_mode(settings: Mapping[str, Any] | None) -> bool:
    return _normalized_auto_sort_mode(settings) in {
        "teacher_session_opt",
        "teacher_sessions_opt",
        "teacher_session_optimized",
        "optimize_teacher_sessions",
    }


def _ceil_div(value: int, divisor: int) -> int:
    return (max(0, int(value)) + max(1, int(divisor)) - 1) // max(1, int(divisor))


def _school_seed_sequence(data: SchoolData, count: int) -> list[int]:
    seed_payload = {
        "classes": [(item.name, item.grade) for item in data.classes],
        "teachers": sorted(data.teachers),
        "assignments": [
            (
                item.class_name,
                item.grade,
                item.subject,
                item.teacher,
                item.room,
                int(item.periods_per_week),
                int(item.max_periods_per_session),
            )
            for item in data.assignments
        ],
    }
    raw = json.dumps(seed_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).digest()
    rng = random.Random(int.from_bytes(digest[:8], "big", signed=False))
    seeds: list[int] = []
    while len(seeds) < max(0, int(count)):
        value = rng.randrange(1, 2_147_483_647)
        if value not in seeds:
            seeds.append(value)
    return seeds


def _school_refinement_seed_sequence(
    data: SchoolData,
    refinement_round: int,
    count: int,
    request_seed: int | None = None,
) -> list[int]:
    """Derive a deterministic portfolio scoped to the school, round, and click."""

    base_seed = (_school_seed_sequence(data, 1) or [1])[0]
    round_number = max(1, int(refinement_round))
    seed_material = f"{base_seed}:{round_number}"
    if request_seed is not None:
        seed_material += f":{max(1, int(request_seed))}"
    digest = hashlib.sha256(seed_material.encode("ascii")).digest()
    rng = random.Random(int.from_bytes(digest[:8], "big", signed=False))
    seeds: list[int] = []
    while len(seeds) < max(0, int(count)):
        value = rng.randrange(1, 2_147_483_647)
        if value not in seeds:
            seeds.append(value)
    return seeds


def _refinement_request_seed(settings: Mapping[str, Any]) -> int | None:
    """Return the browser-selected trajectory seed, mixing distinct seed fields."""

    random_seed = _positive_setting(settings, "random_seed")
    variant_seed = _positive_setting(settings, "quality_variant_seed")
    if random_seed is None:
        return variant_seed
    if variant_seed is None or variant_seed == random_seed:
        return random_seed
    digest = hashlib.sha256(f"{random_seed}:{variant_seed}".encode("ascii")).digest()
    return (int.from_bytes(digest[:8], "big", signed=False) % 2_147_483_646) + 1


_REFINEMENT_OPERATOR_NAMES = (
    "one_period",
    "gap2",
    "session_merge",
    "gap1",
    "mixed",
    "diversify",
)


def _incremental_lns_profile(
    settings: Mapping[str, Any],
    refinement_round: int,
    expected_periods: int,
) -> dict[str, Any]:
    """Bound reclick work while widening neighborhoods after stagnant rounds."""

    round_number = max(1, int(refinement_round))
    tier = min(2, round_number - 1)
    large_school = max(0, int(expected_periods)) >= 900
    default_classes = (8, 10, 12) if large_school else (6, 8, 10)
    default_lessons = (300, 360, 420) if large_school else (180, 240, 320)
    default_passes = (4, 5, 6) if large_school else (3, 4, 5)
    default_pass_seconds = (5.0, 6.0, 7.0) if large_school else (4.0, 5.0, 6.0)
    default_budget = (28.0, 34.0, 40.0) if large_school else (16.0, 24.0, 32.0)

    def configured_int(key: str, default: int, minimum: int, maximum: int) -> int:
        if key not in settings:
            return int(default)
        return max(minimum, min(maximum, _to_int(settings.get(key), default)))

    def configured_float(key: str, default: float, minimum: float, maximum: float) -> float:
        if key not in settings:
            return float(default)
        return max(minimum, min(maximum, _to_float(settings.get(key), default)))

    return {
        "kind": "round_adaptive_alns",
        "round": round_number,
        "tier": tier,
        "max_classes": configured_int(
            "optimization_existing_local_quality_lns_max_classes",
            default_classes[tier],
            2,
            16,
        ),
        "max_lessons": configured_int(
            "optimization_existing_local_quality_lns_max_lessons",
            default_lessons[tier],
            60,
            420,
        ),
        "passes": configured_int(
            "optimization_existing_local_quality_lns_passes",
            default_passes[tier],
            1,
            16,
        ),
        "pass_seconds": configured_float(
            "optimization_existing_local_quality_lns_pass_seconds",
            default_pass_seconds[tier],
            1.0,
            10.0,
        ),
        "budget_seconds": configured_float(
            "optimization_existing_local_quality_lns_time_limit_seconds",
            default_budget[tier],
            0.5,
            50.0,
        ),
        "stagnant_passes": configured_int(
            "optimization_existing_local_quality_lns_stagnant_passes",
            2,
            1,
            5,
        ),
    }


def _refinement_school_signature(data: SchoolData) -> int:
    canonical = {
        "classes": sorted((str(item.name), str(item.grade)) for item in data.classes),
        "teachers": sorted(str(item) for item in data.teachers),
        "subjects": sorted(str(item) for item in data.subjects),
        "assignments": sorted(
            (
                str(item.class_name),
                str(item.grade),
                str(item.subject),
                str(item.teacher),
                str(item.room or ""),
                int(item.periods_per_week),
                int(item.max_periods_per_session),
            )
            for item in data.assignments
        ),
    }
    raw = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    # Keep the signature exactly representable when the payload crosses JavaScript.
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big", signed=False) & ((1 << 53) - 1)


def _empty_refinement_learning(data: SchoolData) -> dict[str, Any]:
    return {
        "version": 2,
        "school_signature": _refinement_school_signature(data),
        "total_attempts": 0,
        "operators": {},
    }


def _refinement_learning_from_payload(
    payload: Mapping[str, Any] | None,
    data: SchoolData,
) -> dict[str, Any]:
    """Load only small, bounded ALNS statistics tied to this school shape."""

    clean = _empty_refinement_learning(data)
    if not isinstance(payload, Mapping):
        return clean
    if "school_signature" in payload and "operators" in payload:
        raw = payload
    else:
        solver = payload.get("solver") if isinstance(payload.get("solver"), Mapping) else {}
        optimization = (
            solver.get("teacher_session_optimization")
            if isinstance(solver.get("teacher_session_optimization"), Mapping)
            else {}
        )
        runtime = (
            solver.get("runtime_settings")
            if isinstance(solver.get("runtime_settings"), Mapping)
            else {}
        )
        raw = optimization.get("refinement_learning") or runtime.get("refinement_learning")
    if not isinstance(raw, Mapping):
        return clean
    if _to_int(raw.get("school_signature"), 0) != clean["school_signature"]:
        return clean

    operators = raw.get("operators") if isinstance(raw.get("operators"), Mapping) else {}
    clean_operators: dict[str, Any] = {}
    for name in _REFINEMENT_OPERATOR_NAMES:
        item = operators.get(name)
        if not isinstance(item, Mapping):
            continue
        attempts = max(0, min(10_000, _to_int(item.get("attempts"), 0)))
        if attempts <= 0:
            continue
        clean_operators[name] = {
            "attempts": attempts,
            "improvements": max(0, min(attempts, _to_int(item.get("improvements"), 0))),
            "reward": round(max(0.0, min(1_000_000.0, _to_float(item.get("reward"), 0.0))), 6),
            "seconds": round(max(0.0, min(1_000_000.0, _to_float(item.get("seconds"), 0.0))), 6),
            "last_round": max(0, _to_int(item.get("last_round"), 0)),
        }
    clean["operators"] = clean_operators
    clean["total_attempts"] = sum(int(item["attempts"]) for item in clean_operators.values())
    return clean


def _merge_refinement_learning(
    data: SchoolData,
    *sources: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Merge cumulative learning snapshots without counting the same attempt twice."""

    merged = _empty_refinement_learning(data)
    merged_operators: dict[str, Any] = merged["operators"]
    for source in sources:
        clean = _refinement_learning_from_payload(source, data)
        operators = clean.get("operators") if isinstance(clean.get("operators"), Mapping) else {}
        for name in _REFINEMENT_OPERATOR_NAMES:
            incoming = operators.get(name)
            if not isinstance(incoming, Mapping):
                continue
            current = merged_operators.get(name)
            incoming_attempts = max(0, _to_int(incoming.get("attempts"), 0))
            current_attempts = (
                max(0, _to_int(current.get("attempts"), 0))
                if isinstance(current, Mapping)
                else 0
            )
            if incoming_attempts > current_attempts or current is None:
                merged_operators[name] = dict(incoming)
                continue
            if incoming_attempts != current_attempts:
                continue
            # Equal attempt counts are normally the same cumulative snapshot.
            # Maxima make the merge robust to two browser views receiving the
            # same canonical result at slightly different persistence points.
            merged_operators[name] = {
                "attempts": current_attempts,
                "improvements": min(
                    current_attempts,
                    max(
                        _to_int(current.get("improvements"), 0),
                        _to_int(incoming.get("improvements"), 0),
                    ),
                ),
                "reward": round(
                    max(
                        _to_float(current.get("reward"), 0.0),
                        _to_float(incoming.get("reward"), 0.0),
                    ),
                    6,
                ),
                "seconds": round(
                    max(
                        _to_float(current.get("seconds"), 0.0),
                        _to_float(incoming.get("seconds"), 0.0),
                    ),
                    6,
                ),
                "last_round": max(
                    _to_int(current.get("last_round"), 0),
                    _to_int(incoming.get("last_round"), 0),
                ),
            }
    merged["total_attempts"] = sum(
        max(0, _to_int(item.get("attempts"), 0))
        for item in merged_operators.values()
        if isinstance(item, Mapping)
    )
    return merged


def _attach_refinement_learning(
    payload: dict[str, Any],
    learning: Mapping[str, Any],
) -> None:
    solver = payload.setdefault("solver", {})
    if not isinstance(solver, dict):
        solver = {}
        payload["solver"] = solver
    runtime = solver.setdefault("runtime_settings", {})
    if not isinstance(runtime, dict):
        runtime = {}
        solver["runtime_settings"] = runtime
    runtime["refinement_learning"] = dict(learning)


def _refinement_operator_priorities(metrics: Mapping[str, Any]) -> dict[str, float]:
    clean_quality_gates = (
        _metric_int(metrics, "one_period_teacher_sessions", 0) == 0
        and _teacher_session_opt_gap2_plus(metrics) == 0
    )
    return {
        "one_period": 4.0 if _metric_int(metrics, "one_period_teacher_sessions", 0) > 0 else 0.2,
        "gap2": 3.0 if _teacher_session_opt_gap2_plus(metrics) > 0 else 0.2,
        "session_merge": 4.0 if clean_quality_gates else 2.0,
        "gap1": 1.5 if _teacher_session_opt_gap1(metrics) > 0 else 0.1,
        "mixed": 1.0,
        "diversify": 0.4,
    }


def _select_refinement_operator(
    learning: Mapping[str, Any],
    metrics: Mapping[str, Any],
    *,
    refinement_round: int,
    pass_index: int,
    random_seed: int | None,
) -> tuple[str, dict[str, float]]:
    """Use a tiny UCB policy; quality acceptance remains fully deterministic."""

    priorities = _refinement_operator_priorities(metrics)
    if pass_index == 0 and priorities["one_period"] >= 4.0:
        return "one_period", {"score": priorities["one_period"], "priority": priorities["one_period"]}
    if pass_index == 0 and priorities["gap2"] >= 3.0:
        return "gap2", {"score": priorities["gap2"], "priority": priorities["gap2"]}

    operators = learning.get("operators") if isinstance(learning.get("operators"), Mapping) else {}
    total_attempts = max(1, _to_int(learning.get("total_attempts"), 0))
    untried = [
        name
        for name in _REFINEMENT_OPERATOR_NAMES
        if max(
            0,
            _to_int(
                operators.get(name, {}).get("attempts")
                if isinstance(operators.get(name), Mapping)
                else 0,
                0,
            ),
        )
        == 0
    ]
    if untried:
        selected = max(
            untried,
            key=lambda name: (
                priorities.get(name, 0.0),
                int.from_bytes(
                    hashlib.sha256(
                        f"{random_seed or 0}:{refinement_round}:{pass_index}:{name}".encode("utf-8")
                    ).digest()[:4],
                    "big",
                ),
            ),
        )
        priority = priorities.get(selected, 0.0)
        return selected, {
            "score": round(priority + 8.0, 6),
            "priority": round(priority, 6),
            "mean_reward_per_second": 0.0,
            "exploration": 8.0,
        }

    scored: list[tuple[float, int, str, dict[str, float]]] = []
    for name in _REFINEMENT_OPERATOR_NAMES:
        item = operators.get(name) if isinstance(operators.get(name), Mapping) else {}
        attempts = max(0, _to_int(item.get("attempts"), 0))
        seconds = max(0.0, _to_float(item.get("seconds"), 0.0))
        reward = max(0.0, _to_float(item.get("reward"), 0.0))
        mean_reward_per_second = min(4.0, reward / max(0.25, seconds))
        exploration = math.sqrt(2.0 * math.log(total_attempts + 2.0) / float(attempts + 1))
        priority = priorities.get(name, 0.0)
        score = mean_reward_per_second + exploration + priority * 0.2
        jitter_source = f"{random_seed or 0}:{refinement_round}:{pass_index}:{name}".encode("utf-8")
        jitter = int.from_bytes(hashlib.sha256(jitter_source).digest()[:4], "big")
        scored.append(
            (
                score,
                jitter,
                name,
                {
                    "score": round(score, 6),
                    "priority": round(priority, 6),
                    "mean_reward_per_second": round(mean_reward_per_second, 6),
                    "exploration": round(exploration, 6),
                },
            )
        )
    _score, _jitter, selected, detail = max(scored, key=lambda item: (item[0], item[1]))
    return selected, detail


def _refinement_operator_seed_classes(
    lessons: list[Lesson],
    movable_lessons: list[Lesson],
    operator: str,
    *,
    random_seed: int | None,
    max_classes: int,
) -> list[str] | None:
    movable_classes = {lesson.class_name for lesson in movable_lessons}
    by_teacher_session: dict[tuple[str, int, str], list[Lesson]] = defaultdict(list)
    for lesson in lessons:
        by_teacher_session[(lesson.teacher, lesson.day, lesson.session)].append(lesson)

    one_classes: list[str] = []
    gap2_classes: list[str] = []
    gap1_classes: list[str] = []
    low_load_classes: list[str] = []
    for session_lessons in by_teacher_session.values():
        movable_session_classes = [
            lesson.class_name for lesson in session_lessons if lesson.class_name in movable_classes
        ]
        if not movable_session_classes:
            continue
        periods = sorted({int(lesson.period) for lesson in session_lessons})
        gap = (max(periods) - min(periods) + 1 - len(periods)) if periods else 0
        if len(session_lessons) == 1:
            one_classes.extend(movable_session_classes)
        if len(session_lessons) <= 2:
            low_load_classes.extend(movable_session_classes)
        if gap >= 2:
            gap2_classes.extend(movable_session_classes)
        elif gap == 1:
            gap1_classes.extend(movable_session_classes)

    if operator == "one_period":
        candidates = one_classes
    elif operator == "gap2":
        candidates = gap2_classes
    elif operator == "session_merge":
        candidates = low_load_classes
    elif operator == "gap1":
        candidates = gap1_classes
    elif operator == "mixed":
        candidates = [*one_classes, *gap2_classes, *low_load_classes, *gap1_classes]
    else:
        candidates = sorted(movable_classes)

    ordered = list(dict.fromkeys(str(item) for item in candidates if item))
    if not ordered:
        return None
    rng = random.Random((random_seed or 1) ^ int.from_bytes(hashlib.sha256(operator.encode()).digest()[:4], "big"))
    rng.shuffle(ordered)
    return ordered[: max(1, int(max_classes))]


def _refinement_quality_reward(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
) -> float:
    before_quality = _teacher_session_opt_quality(before, gap1_first=False)
    after_quality = _teacher_session_opt_quality(after, gap1_first=False)
    for index, (old, new) in enumerate(zip(before_quality, after_quality, strict=True)):
        if new < old:
            return float(len(before_quality) - index) + min(0.999, float(old - new) / 1000.0)
        if new > old:
            return 0.0
    return 0.0


def _record_refinement_operator_attempt(
    learning: dict[str, Any],
    operator: str,
    *,
    refinement_round: int,
    elapsed_seconds: float,
    reward: float,
) -> None:
    operators = learning.setdefault("operators", {})
    item = operators.setdefault(
        operator,
        {"attempts": 0, "improvements": 0, "reward": 0.0, "seconds": 0.0, "last_round": 0},
    )
    item["attempts"] = min(10_000, max(0, _to_int(item.get("attempts"), 0)) + 1)
    if reward > 0:
        item["improvements"] = min(
            item["attempts"],
            max(0, _to_int(item.get("improvements"), 0)) + 1,
        )
    item["reward"] = round(max(0.0, _to_float(item.get("reward"), 0.0)) + max(0.0, reward), 6)
    item["seconds"] = round(
        max(0.0, _to_float(item.get("seconds"), 0.0)) + max(0.0, float(elapsed_seconds)),
        6,
    )
    item["last_round"] = max(1, int(refinement_round))
    learning["total_attempts"] = sum(
        max(0, _to_int(value.get("attempts"), 0))
        for value in operators.values()
        if isinstance(value, Mapping)
    )


def _teacher_session_adaptive_bounds(data: SchoolData) -> dict[str, int]:
    sessions = all_sessions()
    session_count = max(1, len(sessions))
    max_session_capacity = max((teacher_session_capacity(session) for session in sessions), default=5)
    expected_periods = sum(max(0, int(item.periods_per_week)) for item in data.assignments)
    teacher_periods: Counter[str] = Counter()
    for assignment in data.assignments:
        teacher_periods[assignment.teacher] += max(0, int(assignment.periods_per_week))
    load_lower = sum(_ceil_div(periods, max_session_capacity) for periods in teacher_periods.values())
    lower_cap = max(1, load_lower)
    upper_cap = max(lower_cap, min(max(1, expected_periods), max(1, len(data.teachers)) * session_count))
    # A good timetable usually averages around 3-4 teaching periods per teacher half-day.
    # Use that only as a starting point; later attempts expand or tighten from real candidates.
    density_start = _ceil_div(expected_periods * 10, 34)
    start_cap = max(lower_cap, density_start)
    start_cap = min(start_cap, upper_cap)
    return {
        "expected_periods": expected_periods,
        "teachers": len(data.teachers),
        "session_count": session_count,
        "max_session_capacity": max_session_capacity,
        "lower_cap": lower_cap,
        "start_cap": start_cap,
        "upper_cap": upper_cap,
    }


def _complete_first_teacher_session_cap(
    bounds: Mapping[str, int],
    profile: Mapping[str, int] | None = None,
) -> int:
    """Return a data-sized feasibility ceiling for the first complete timetable.

    Zero-slack class grids need more room than the 3.4 periods/session quality
    starting point.  This is only a feasibility ceiling: the session model still
    minimizes the actual number of teacher sessions below it.
    """

    lower_cap = max(1, int(bounds.get("lower_cap") or 1))
    start_cap = max(lower_cap, int(bounds.get("start_cap") or lower_cap))
    upper_cap = max(start_cap, int(bounds.get("upper_cap") or start_cap))
    expected_periods = max(0, int(bounds.get("expected_periods") or 0))
    class_count = max(0, int((profile or {}).get("class_count") or 0))
    three_period_density_cap = _ceil_div(expected_periods, 3) if expected_periods else start_cap
    class_headroom_cap = start_cap + max(5, class_count)
    return max(
        lower_cap,
        min(upper_cap, max(start_cap, three_period_density_cap, class_headroom_cap)),
    )


def _teacher_session_opt_seed_caps(
    settings: Mapping[str, Any],
    bounds: Mapping[str, int],
    target_teacher_sessions: int | None,
    *,
    adaptive: bool = False,
) -> list[int]:
    lower_cap = max(1, int(bounds.get("lower_cap") or 1))
    start_cap = max(lower_cap, int(bounds.get("start_cap") or lower_cap))
    upper_cap = max(start_cap, int(bounds.get("upper_cap") or start_cap))
    requested_max = _positive_setting(settings, "max_teacher_sessions")
    explicit_start = _positive_setting(settings, "optimization_start_teacher_sessions")
    accept_teacher_sessions = _positive_setting(settings, "optimization_accept_teacher_sessions")
    tight_profile = settings.get("tight_class_fixed_off_profile")
    tight_capacity_mode = (
        isinstance(tight_profile, Mapping)
        and _to_int(tight_profile.get("expected"), 0) > 0
        and _to_int(tight_profile.get("slack"), 999999) <= max(0, _to_int(settings.get("optimization_tight_slack_threshold"), 0))
    )
    if tight_capacity_mode and adaptive:
        if explicit_start is not None:
            explicit_start = max(explicit_start, start_cap)
        if requested_max is not None:
            requested_max = max(requested_max, start_cap)
    raw_caps: list[int] = []
    if target_teacher_sessions is not None and not adaptive:
        raw_caps.append(target_teacher_sessions)
        raw_caps.extend(range(target_teacher_sessions + 1, min(upper_cap, target_teacher_sessions + 6) + 1))
    if adaptive and tight_capacity_mode:
        # Zero-slack class grids usually need a little session headroom before
        # the period model becomes feasible. Try that proven neighborhood first.
        raw_caps.append(start_cap + 5)
    try_below_start_in_tight_capacity = _truthy_setting(
        settings.get("optimization_try_below_start_tight_capacity", "1")
    )
    elif_below_start_allowed = (not tight_capacity_mode) or try_below_start_in_tight_capacity
    if not adaptive and target_teacher_sessions is None and start_cap > lower_cap and elif_below_start_allowed:
        raw_caps.append(start_cap - 1)
    leading_caps = (
        (accept_teacher_sessions, explicit_start, requested_max, start_cap)
        if adaptive
        else (explicit_start, requested_max, start_cap)
    )
    for cap in leading_caps:
        if cap is not None:
            raw_caps.append(cap)
    for step in (5, 10, 20, 40, 80):
        raw_caps.append(start_cap + step)
    raw_caps.append(upper_cap)
    caps: list[int] = []
    for cap in raw_caps:
        cap = max(lower_cap, min(upper_cap, int(cap)))
        if cap <= 0 or cap in caps:
            continue
        caps.append(cap)
    return caps


def _teacher_session_opt_gap_priority_attempts(
    metrics: Mapping[str, Any],
    *,
    target_gap1_sessions: int | None,
    preferred_cap: int | None = None,
    lower_cap: int,
    upper_cap: int,
    polish_seeds: list[int],
) -> list[tuple[int, int, str]]:
    if target_gap1_sessions is None or _teacher_session_opt_gap1(metrics) <= target_gap1_sessions:
        return []

    best_sessions = max(
        int(lower_cap),
        min(int(upper_cap), _metric_int(metrics, "teacher_sessions", int(upper_cap))),
    )
    seeds = [int(seed) for seed in polish_seeds[:4]]
    attempts: list[tuple[int, int, str]] = []
    seed_index = 0
    if seeds:
        seed = seeds[seed_index]
        attempts.append((best_sessions, seed, f"seed:{seed}"))
        seed_index += 1
    if preferred_cap is not None and len(seeds) > seed_index:
        preferred = max(int(lower_cap), min(int(upper_cap), int(preferred_cap)))
        if preferred < best_sessions:
            distance = best_sessions - preferred
            if distance >= 24:
                step = 20 if _teacher_session_opt_gap1(metrics) >= 90 else 10
                staircase_cap = max(preferred, best_sessions - step)
            elif distance >= 6:
                staircase_cap = max(preferred, best_sessions - 5)
            else:
                staircase_cap = best_sessions - 1
            seed = seeds[seed_index]
            attempts.append((staircase_cap, seed, f"tighten:{seed}"))
            seed_index += 1
    if len(seeds) > seed_index:
        seed = seeds[seed_index]
        attempts.append((best_sessions, seed, f"seed:{seed}"))
        seed_index += 1
    if len(seeds) > seed_index and best_sessions < int(upper_cap):
        relaxed_cap = min(int(upper_cap), best_sessions + 1)
        relaxed_seed = seeds[seed_index]
        attempts.append((relaxed_cap, relaxed_seed, f"seed:{relaxed_seed}"))
    return attempts


def _refinement_gap_priority_attempts(
    metrics: Mapping[str, Any],
    *,
    target_gap1_sessions: int | None,
    preferred_cap: int | None,
    accept_gap1_sessions: int | None,
    lower_cap: int,
    upper_cap: int,
    polish_seeds: list[int],
    session_first: bool,
    force_lower_session_first: bool = False,
) -> list[tuple[int, int, str]]:
    """Build an interleaved gap/session portfolio for complete refinement.

    A complete refinement with an acceptable gap should spend its next slice
    proving a tighter teacher-session cap. The caller can also force that
    bounded lower-cap step after a same-session gap improvement. Without this
    alternation, rebuilding the queue after every gap improvement repeatedly
    puts the same-cap probe first and can starve session reduction for the
    entire click.
    """

    attempts = _teacher_session_opt_gap_priority_attempts(
        metrics,
        target_gap1_sessions=target_gap1_sessions,
        preferred_cap=preferred_cap,
        lower_cap=lower_cap,
        upper_cap=upper_cap,
        polish_seeds=polish_seeds,
    )
    if not session_first or preferred_cap is None or not polish_seeds:
        return attempts
    gap_is_practical = (
        accept_gap1_sessions is not None
        and _teacher_session_opt_gap1(metrics) <= accept_gap1_sessions
    )
    if not force_lower_session_first and not gap_is_practical:
        return attempts
    current = max(
        int(lower_cap),
        min(int(upper_cap), _metric_int(metrics, "teacher_sessions", int(upper_cap))),
    )
    preferred = max(int(lower_cap), min(int(upper_cap), int(preferred_cap)))
    if preferred == current:
        # At (or just below) the practical target, same-cap Benders waves are
        # discovery searches rather than no-ops: their inner objective can
        # still reduce both sessions and gaps. Probe a useful reduction first,
        # then a conservative one-cap reduction before tightening further. A
        # school whose -3 cap is infeasible therefore still gets a feasible
        # fallback in the same click instead of spending every slice too low.
        same_cap_attempts = [
            item for item in attempts if int(item[0]) == current
        ][:1]
        continuation_floor = max(int(lower_cap), preferred - 5)
        lower_attempts: list[tuple[int, int, str]] = []
        seen_caps: set[int] = set()
        for drop, raw_seed_index in ((3, 1), (1, 2), (4, 3)):
            continuation_cap = max(continuation_floor, current - drop)
            if continuation_cap >= current or continuation_cap in seen_caps:
                continue
            seen_caps.add(continuation_cap)
            seed_index = min(raw_seed_index, len(polish_seeds) - 1)
            seed = int(polish_seeds[seed_index])
            attempt_kind = "nearby" if drop == 1 else "tighten"
            lower_attempts.append((continuation_cap, seed, f"{attempt_kind}:{seed}"))
        if not lower_attempts:
            return same_cap_attempts or attempts
        if force_lower_session_first:
            return [*lower_attempts, *same_cap_attempts]
        return [*same_cap_attempts, *lower_attempts]
    if preferred > current:
        same_cap_attempts = [item for item in attempts if int(item[0]) == current]
        continuation_floor = max(int(lower_cap), preferred - 5)
        continuation_cap = max(continuation_floor, current - 2)
        lower_attempt: tuple[int, int, str] | None = None
        if continuation_cap < current:
            seed_index = min(2, len(polish_seeds) - 1)
            seed = int(polish_seeds[seed_index])
            lower_attempt = (continuation_cap, seed, f"tighten:{seed}")
        if lower_attempt is None:
            return same_cap_attempts or attempts
        if force_lower_session_first:
            return [lower_attempt, *same_cap_attempts]
        return [*same_cap_attempts, lower_attempt]
    if not force_lower_session_first:
        # Once the gap is already practical, the proven direct target-cap
        # probe is faster than walking down a staircase one cap at a time.
        target = (preferred, int(polish_seeds[0]), f"target:{polish_seeds[0]}")
        return [target, *[item for item in attempts if int(item[0]) != preferred]]
    lower_attempt = next((item for item in attempts if int(item[0]) < current), None)
    if lower_attempt is None:
        return attempts
    return [lower_attempt, *[item for item in attempts if item is not lower_attempt]]


def _teacher_session_opt_should_prioritize_gap_portfolio(
    metrics: Mapping[str, Any],
    *,
    target_gap1_sessions: int | None,
) -> bool:
    """Restore the proven same-cap gap portfolio before blind cap squeezing."""

    if target_gap1_sessions is None:
        return False
    return _teacher_session_opt_gap1(metrics) > int(target_gap1_sessions)


def _teacher_session_opt_attempt_settings(
    settings: Mapping[str, Any],
    *,
    cap: int,
    target_teacher_sessions: int | None,
    target_gap1_sessions: int | None,
    time_limit_seconds: int,
    lower_cap: int,
    random_seed: int | None = None,
) -> dict[str, Any]:
    continue_quality_search = _truthy_setting(settings.get("optimization_continue_quality_search"))
    attempt_budget = max(1, int(time_limit_seconds))
    default_session_limit = max(120, min(150, int(time_limit_seconds) - 90))
    session_limit = max(default_session_limit, _to_int(settings.get("optimization_session_time_limit"), 0))
    period_limit = max(60, _to_int(settings.get("period_time_limit"), 90))
    period_retry_limit = max(30, min(period_limit, _to_int(settings.get("optimization_period_retry_time_limit"), 45)))
    if attempt_budget < 120:
        # Keep a real session-search window on short attempts.  Previously a
        # 30-90s portfolio attempt still reserved 49-64s for period placement,
        # so SolverDeadline reduced CP-SAT session search to one second.
        period_limit = min(period_limit, max(4, attempt_budget // 3))
        period_retry_limit = min(period_retry_limit, period_limit)
        period_reserve = max(12, period_retry_limit + 4)
        session_limit = min(session_limit, max(4, attempt_budget - period_reserve - 2))
    requested_cap = int(target_teacher_sessions or cap)
    next_settings = dict(settings)
    next_settings.update(
        {
            "auto_sort_mode": "fast",
            "_teacher_session_opt_inner": True,
            "strict_teacher_session_cap": True,
            "max_teacher_sessions": int(cap),
            "requested_max_teacher_sessions": requested_cap,
            "adaptive_teacher_session_lower_cap": int(lower_cap),
            "solver_mode": "auto",
            "exact_teacher_sessions": False,
            "search_teacher_sessions": True,
            "minimize_sessions": True,
            "allow_one_period_gaps": True,
            "minimize_one_period_sessions": True,
            "max_one_period_sessions": 0,
            "one_period_priority_absolute": True,
            "minimize_teacher_gaps": True,
            "period_max_teacher_gap": 1,
            "best_effort_on_timeout": False,
            "relax_period_teacher_gap_on_failure": False,
            "aggressive_fast_mode": False,
            "deep_session_rescue": True,
            "preserve_existing_tkb": False,
            "auto_sort_strategy": "fresh_teacher_session_opt",
            "fresh_randomize": False,
            "randomize_search": False,
            "session_time_limit": session_limit,
            "session_early_stop_teacher_sessions": int(target_teacher_sessions or cap),
            "session_early_stop_max_one_period_sessions": 0,
            "period_time_limit": period_limit,
            "period_fast_time_limit": period_limit,
            "period_retry_time_limit": period_retry_limit,
            "integrated_time_limit": max(1, int(time_limit_seconds)),
            "overall_time_limit_seconds": max(1, int(time_limit_seconds)),
            "fast_repair_period_hint": False,
            "fast_validated_period_hint": False,
            "disable_period_feasibility_bridge": False,
            "legacy_wednesday_pm_bridge": False,
            "session_priority_target_teacher_sessions": int(target_teacher_sessions or lower_cap),
            "one_period_zero_probe_time_limit": max(45, min(180, session_limit)),
            "one_period_gap0_probe_time_limit": max(45, min(120, period_limit)),
            "local_one_period_cleanup_time_limit": max(8, min(30, period_limit // 3)),
            "progress_estimate_seconds": max(1, int(time_limit_seconds)),
        }
    )
    if continue_quality_search:
        next_settings["session_early_stop_enabled"] = False
        next_settings.pop("session_early_stop_teacher_sessions", None)
        next_settings.pop("session_early_stop_max_one_period_sessions", None)
    if target_teacher_sessions is not None:
        next_settings["target_teacher_sessions"] = int(target_teacher_sessions)
    else:
        next_settings.pop("target_teacher_sessions", None)
    if target_gap1_sessions is not None:
        next_settings["target_gap1_sessions"] = int(target_gap1_sessions)
    else:
        next_settings.pop("target_gap1_sessions", None)
    if random_seed is None:
        next_settings.pop("random_seed", None)
    else:
        next_settings["random_seed"] = int(random_seed)
        next_settings["randomize_search"] = True
    return next_settings


def _teacher_session_opt_fast_quality_settings(
    settings: Mapping[str, Any],
    bounds: Mapping[str, int],
) -> dict[str, Any]:
    lower_cap = max(1, int(bounds.get("lower_cap") or 1))
    start_cap = max(lower_cap, int(bounds.get("start_cap") or lower_cap))
    expected_periods = max(0, int(bounds.get("expected_periods") or 0))
    target_threshold = _positive_setting(settings, "target_teacher_sessions")
    explicit_early_stop = _positive_setting(settings, "session_early_stop_teacher_sessions")
    fast_quality_threshold = _positive_setting(settings, "fast_quality_teacher_cap")
    accept_threshold = _positive_setting(settings, "optimization_accept_teacher_sessions")
    quality_cap = max(
        (
            value
            for value in (
                fast_quality_threshold,
                explicit_early_stop,
                target_threshold,
                accept_threshold,
            )
            if value is not None
        ),
        default=0,
    )
    fast_cap = max(
        start_cap,
        ((expected_periods * 10 + 33) // 34) + 5 if expected_periods > 0 else start_cap,
        quality_cap,
    )
    session_ceiling = 45 if expected_periods >= 350 else 30
    session_default = 45 if expected_periods >= 350 else 18
    session_limit = max(18, min(session_ceiling, _to_int(settings.get("session_time_limit"), session_default)))
    period_limit = max(45, min(60, _to_int(settings.get("period_time_limit"), 45)))
    integrated_limit = max(90, min(150, _to_int(settings.get("integrated_time_limit"), 90)))
    overall_limit = max(90, min(150, _to_int(settings.get("overall_time_limit_seconds"), 90)))
    outer_budget = _to_int(settings.get("optimization_time_limit_seconds"), 0)
    if outer_budget <= 0:
        outer_budget = _to_int(settings.get("overall_time_limit_seconds"), 0)
    if outer_budget > 0:
        overall_limit = min(overall_limit, max(1, outer_budget))
        integrated_limit = min(integrated_limit, overall_limit)
    if overall_limit < 90:
        # Large tight schools spend most of a short first-click budget finding
        # a feasible session vector.  Keep one quarter for period placement;
        # the old one-third split left only 34s of a 60s run for a model whose
        # first feasible session solution commonly appears around 33s.
        period_limit = min(period_limit, max(4, overall_limit // 4))
        period_reserve = max(12, period_limit + 4)
        session_limit = min(session_limit, max(4, overall_limit - period_reserve))
    early_stop_teacher_sessions = next(
        (
            value
            for value in (
                target_threshold,
                explicit_early_stop,
                fast_quality_threshold,
                accept_threshold,
            )
            if value is not None
        ),
        fast_cap,
    )
    early_stop_teacher_sessions = min(fast_cap, early_stop_teacher_sessions)
    next_settings = dict(settings)
    for key in list(next_settings):
        if key.startswith("optimization_"):
            next_settings.pop(key, None)
    next_settings.update(
        {
            "auto_sort_mode": "fast",
            "_teacher_session_opt_inner": True,
            "_teacher_session_opt_fast_quality_warmup": True,
            "strict_teacher_session_cap": False,
            "max_teacher_sessions": fast_cap,
            "requested_max_teacher_sessions": fast_cap,
            "solver_mode": "auto",
            "exact_teacher_sessions": False,
            "search_teacher_sessions": True,
            "minimize_sessions": True,
            "allow_one_period_gaps": True,
            "minimize_one_period_sessions": True,
            "max_one_period_sessions": 0,
            "one_period_priority_absolute": True,
            "minimize_teacher_gaps": True,
            "period_max_teacher_gap": 1,
            "best_effort_on_timeout": False,
            "relax_period_teacher_gap_on_failure": False,
            "aggressive_fast_mode": True,
            "deep_session_rescue": False,
            "preserve_existing_tkb": False,
            "auto_sort_strategy": "fresh_fast_quality",
            "fresh_randomize": False,
            "randomize_search": False,
            "session_time_limit": session_limit,
            "session_early_stop_enabled": True,
            "session_early_stop_teacher_sessions": early_stop_teacher_sessions,
            "session_early_stop_max_one_period_sessions": 0,
            "period_time_limit": period_limit,
            "period_fast_time_limit": min(30, period_limit),
            "period_retry_time_limit": period_limit,
            "integrated_time_limit": integrated_limit,
            "overall_time_limit_seconds": overall_limit,
            "fast_repair_period_hint": False,
            "fast_validated_period_hint": False,
            "disable_period_feasibility_bridge": False,
            "progress_estimate_seconds": min(90, overall_limit),
        }
    )
    next_settings.pop("target_teacher_sessions", None)
    next_settings.pop("target_gap1_sessions", None)
    next_settings.pop("random_seed", None)
    return next_settings


def _fast_quality_warmup_direct_settings(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, int]]:
    bound_ctx = build_school_data_from_ui(ui_data)
    bounds = _teacher_session_adaptive_bounds(bound_ctx.school_data)
    next_settings = _teacher_session_opt_fast_quality_settings(settings, bounds)
    next_settings.update(
        {
            "fast_quality_warmup_direct": True,
            "session_early_stop_enabled": True,
            "ui_solver_preset": "fast",
        }
    )
    return next_settings, bounds


def _teacher_session_opt_summarize_attempt(
    *,
    cap: int,
    elapsed_seconds: float,
    payload: Mapping[str, Any] | None = None,
    error: Exception | None = None,
) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "cap": int(cap),
        "elapsed_seconds": round(float(elapsed_seconds), 3),
        "ok": False,
    }
    if payload is not None:
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), Mapping) else {}
        summary.update(
            {
                "ok": _complete_payload_metrics_acceptable(payload),
                "scheduled_periods": metrics.get("scheduled_periods"),
                "expected_periods": metrics.get("expected_periods"),
                "unassigned_periods": metrics.get("unassigned_periods"),
                "hard_ok": metrics.get("hard_ok"),
                "teacher_sessions": metrics.get("teacher_sessions"),
                "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
                "gap_distribution": metrics.get("gap_distribution"),
                "quality": list(_teacher_session_opt_quality(metrics)),
                "best_effort": payload.get("bestEffort") is True or bool(metrics.get("best_effort")),
            }
        )
    if error is not None:
        summary["error"] = str(error)
    return summary


def _lesson_identity(lesson: Lesson) -> tuple[str, str, int, str, int, str, str, str]:
    return (
        lesson.class_name,
        lesson.grade,
        lesson.day,
        lesson.session,
        lesson.period,
        lesson.subject,
        lesson.teacher,
        lesson.room,
    )


def _payload_lessons_to_lessons(payload: Mapping[str, Any] | None) -> list[Lesson]:
    if not isinstance(payload, Mapping):
        return []
    lesson_rows = payload.get("lessons")
    if not isinstance(lesson_rows, list):
        return []
    lessons: list[Lesson] = []
    for row in lesson_rows:
        if not isinstance(row, Mapping):
            continue
        day = _to_int(row.get("day"), 0)
        period = _to_int(row.get("period"), 0)
        session = str(row.get("session") or "")
        class_name = _text(row.get("className") or row.get("class_name") or row.get("class"))
        grade = _text(row.get("grade"))
        subject = _text(row.get("subject"))
        teacher = _text(row.get("teacher"))
        if not class_name or not subject or not teacher or day <= 0 or period <= 0 or session not in {"AM", "PM"}:
            continue
        lessons.append(
            Lesson(
                class_name=class_name,
                grade=grade,
                day=day,
                session=session,
                period=period,
                subject=subject,
                teacher=teacher,
                room=_text(row.get("room")),
            )
        )
    return lessons


def validate_candidate_payload(
    ui_data: dict[str, Any],
    candidate: Mapping[str, Any],
) -> dict[str, Any]:
    """Revalidate an external candidate with the canonical Python contract.

    The Rust gate checks exact demand, fixed lessons, and resource identity
    before calling this helper.  This second gate deliberately recomputes every
    core/app constraint from request data instead of trusting Agent metrics.
    """

    ctx = build_school_data_from_ui(ui_data)
    raw_lessons = candidate.get("lessons")
    lessons = _payload_lessons_to_lessons(candidate)
    raw_lesson_count = len(raw_lessons) if isinstance(raw_lessons, list) else 0
    malformed_lesson_count = max(0, raw_lesson_count - len(lessons))
    metrics = compute_metrics(ctx.school_data, lessons, rules=ctx.rules)
    reported_unassigned = candidate.get("unassignedLessons")
    unassigned_count = len(reported_unassigned) if isinstance(reported_unassigned, list) else -1
    expected = _metric_int(metrics, "expected_periods", 0)
    scheduled = _metric_int(metrics, "scheduled_periods", 0)
    hard_ok = bool(metrics.get("hard_ok"))
    ok = (
        candidate.get("ok") is True
        and raw_lesson_count > 0
        and malformed_lesson_count == 0
        and unassigned_count == 0
        and expected > 0
        and scheduled == expected
        and hard_ok
    )
    violations = metrics.get("app_constraint_violations")
    if not isinstance(violations, list):
        violations = []
    return {
        "ok": ok,
        "hard_ok": hard_ok,
        "scheduled_periods": scheduled,
        "expected_periods": expected,
        "malformed_lesson_count": malformed_lesson_count,
        "unassigned_lesson_count": unassigned_count,
        "app_constraint_violation_count": _metric_int(
            metrics,
            "app_constraint_violation_count",
            len(violations),
        ),
        "violation_kinds": sorted(
            {
                str(item.get("kind") or "")
                for item in violations
                if isinstance(item, Mapping) and item.get("kind")
            }
        )[:16],
    }


def _lessons_without_fixed_instances(
    lessons: list[Lesson],
    fixed_lessons: list[Lesson],
) -> list[Lesson]:
    fixed_counts = Counter(_lesson_identity(lesson) for lesson in fixed_lessons)
    movable: list[Lesson] = []
    for lesson in lessons:
        key = _lesson_identity(lesson)
        if fixed_counts[key] > 0:
            fixed_counts[key] -= 1
        else:
            movable.append(lesson)
    return movable


def _payload_lessons_to_allocations(payload: Mapping[str, Any] | None) -> list[SessionAllocation] | None:
    lessons = _payload_lessons_to_lessons(payload)
    return _allocations_from_lessons(lessons) if lessons else None


def _period_max_teacher_gap_setting(
    settings: Mapping[str, Any],
    *,
    default: int | None,
) -> int | None:
    raw = settings.get("period_max_teacher_gap", "__default__")
    if raw == "__default__":
        return default
    if raw is None or str(raw).strip().casefold() in {
        "",
        "none",
        "null",
        "off",
        "false",
        "no",
    }:
        return None
    fallback = 0 if default is None else int(default)
    return max(0, _to_int(raw, fallback))


def _solve_teacher_session_benders_candidate(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    *,
    cap: int,
    time_limit_seconds: int,
    rules: TimetableRuleSet | None,
    progress: ProgressFn | None,
    incumbent_payload: Mapping[str, Any] | None = None,
    random_seed: int | None = None,
    deadline: SolverDeadline | None = None,
) -> dict[str, Any]:
    original_ctx = build_school_data_from_ui(ui_data)
    effective_rules = rules or original_ctx.rules
    report_rules = effective_rules
    fixed_existing_lessons: list[Lesson] = []
    if (
        _truthy_setting(settings.get("preserve_fixed_lessons_only"))
        or _truthy_setting(ui_data.get("__tkbRequestFixedScheduleOnly"))
    ):
        fixed_existing_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, original_ctx)
        original_ctx.warnings.extend(fixed_warnings)
        fixed_existing_lessons, released_warnings = _release_invalid_fixed_lessons(
            original_ctx.school_data,
            fixed_existing_lessons,
            effective_rules,
            release_constraint_violations=False,
        )
        original_ctx.warnings.extend(released_warnings)
        if fixed_existing_lessons:
            effective_rules = _rule_set_with_fixed_lesson_slots(effective_rules, fixed_existing_lessons)

    fixed_existing_lessons_are_hard = bool(fixed_existing_lessons)
    solver_source_ctx = (
        _context_without_fixed_lesson_demand(original_ctx, fixed_existing_lessons)
        if fixed_existing_lessons_are_hard
        else original_ctx
    )
    session_fixed_lessons = fixed_existing_lessons if fixed_existing_lessons_are_hard else []
    ctx, unassigned_lessons = _trim_context_to_available_slots(solver_source_ctx, effective_rules, settings)
    deadline = (deadline or SolverDeadline(None)).bounded(max(8, int(time_limit_seconds)))
    solver_workers = _solver_worker_count(settings)
    session_linearization_level = _session_cp_sat_linearization_level(settings)
    complete_first = _truthy_setting(settings.get("optimization_benders_complete_first"))
    adaptive_target = _truthy_setting(settings.get("optimization_adaptive_target"))
    continue_quality_search = _truthy_setting(settings.get("optimization_continue_quality_search"))
    stop_on_first_quality_gate_clean = _truthy_setting(
        settings.get("optimization_benders_stop_on_first_quality_gate_clean")
    )
    disable_session_early_stop = _truthy_setting(
        settings.get("optimization_benders_disable_session_early_stop")
    ) or continue_quality_search
    allow_complete_first_one_period_debt = complete_first and _truthy_setting(
        settings.get("optimization_benders_allow_one_period_debt")
    )
    skip_relaxed_period_probe = _truthy_setting(settings.get("optimization_benders_skip_relaxed_period_probe"))
    lean_refinement_periods = _truthy_setting(
        settings.get("optimization_benders_lean_refinement_periods")
    )
    bridge_all_period_sessions = _truthy_setting(
        settings.get("optimization_benders_period_feasibility_all_sessions")
    ) or bool(
        fixed_existing_lessons_are_hard
        and effective_rules.contiguous_multi_period_assignments
        and not lean_refinement_periods
    )
    bridge_promotion_cut_count = max(
        1,
        min(
            8,
            _to_int(
                settings.get("optimization_benders_period_bridge_promotion_cut_count"),
                2,
            ),
        ),
    )
    session_feasibility_only = _truthy_setting(
        settings.get("optimization_benders_session_feasibility_only")
    )
    session_minimize_one_period_sessions = _truthy_setting(
        settings.get(
            "optimization_benders_minimize_one_period_sessions",
            not session_feasibility_only,
        )
    )
    max_iterations = max(1, _to_int(settings.get("optimization_benders_iterations"), 8))
    session_slice = max(10, _to_int(settings.get("optimization_benders_session_time_limit"), 30))
    minimum_period_limit = 12 if complete_first else 20
    period_limit = max(minimum_period_limit, min(90, _to_int(settings.get("period_time_limit"), 60)))
    period_retry_limit = max(
        minimum_period_limit,
        min(period_limit, _to_int(settings.get("optimization_period_retry_time_limit"), 45)),
    )
    period_max_teacher_gap = _period_max_teacher_gap_setting(settings, default=1)
    period_minimize_teacher_gaps = _truthy_setting(settings.get("minimize_teacher_gaps", "1"))
    cut_scope = str(settings.get("optimization_benders_cut_scope") or "aggressive")
    raw_max_one_period_sessions = settings.get(
        "max_one_period_sessions",
        settings.get("max_one_period_teacher_sessions"),
    )
    if raw_max_one_period_sessions is None or raw_max_one_period_sessions == "":
        max_one_period_sessions = 0
    elif str(raw_max_one_period_sessions).strip().casefold() in {"none", "null", "off", "false", "no"}:
        max_one_period_sessions = None
    else:
        max_one_period_sessions = max(0, _to_int(raw_max_one_period_sessions, 0))
    strict_one_period_sessions_cap = _truthy_setting(
        settings.get(
            "strict_one_period_sessions_cap",
            settings.get("enforce_max_one_period_sessions", max_one_period_sessions is not None),
        )
    )
    target_teacher_sessions = _positive_setting(settings, "target_teacher_sessions")
    target_gap1_sessions = _nonnegative_setting(settings, "target_gap1_sessions")
    quality_gap1_first = _teacher_quality_gap1_first(settings, target_gap1_sessions)
    balanced_quality_envelope = _teacher_quality_uses_balanced_envelope(settings)
    accept_teacher_sessions = _positive_setting(settings, "optimization_accept_teacher_sessions")
    accept_gap1_sessions = _nonnegative_setting(settings, "optimization_accept_gap1_sessions")
    if accept_teacher_sessions is None and target_teacher_sessions is not None:
        accept_teacher_sessions = target_teacher_sessions
    if accept_gap1_sessions is None and target_gap1_sessions is not None:
        accept_gap1_sessions = target_gap1_sessions
    has_quality_goal = (
        target_teacher_sessions is not None
        or target_gap1_sessions is not None
        or accept_teacher_sessions is not None
        or accept_gap1_sessions is not None
    )
    stop_on_stagnation = _truthy_setting(settings.get("optimization_stop_on_stagnation", "1"))
    accept_stagnant_limit = (
        max(
            0,
            min(
                4,
                _to_int(
                    settings.get("optimization_benders_accept_stagnant_iterations"),
                    2 if continue_quality_search else 0,
                ),
            ),
        )
        if stop_on_stagnation
        else 0
    )
    accept_stagnant_iterations = 0

    cuts: list[tuple[int, dict[int, int]]] = []
    cut_keys: set[str] = set()
    history: list[dict[str, Any]] = []
    best_payload: dict[str, Any] | None = None
    best_metrics: Mapping[str, Any] | None = None
    incumbent_metrics = (
        incumbent_payload.get("metrics")
        if isinstance(incumbent_payload, Mapping)
        and isinstance(incumbent_payload.get("metrics"), Mapping)
        else None
    )
    incumbent_is_safe_stagnation_fallback = bool(
        isinstance(incumbent_payload, Mapping)
        and isinstance(incumbent_metrics, Mapping)
        and _complete_payload_metrics_acceptable(incumbent_payload)
        and _teacher_session_opt_quality_gates_clean(incumbent_metrics)
    )

    def record_stagnation(
        entry: dict[str, Any],
        *,
        improved: bool = False,
    ) -> bool:
        nonlocal accept_stagnant_iterations
        fallback_metrics = best_metrics if isinstance(best_metrics, Mapping) else incumbent_metrics
        fallback_is_safe = bool(
            isinstance(fallback_metrics, Mapping)
            and _teacher_session_opt_quality_gates_clean(fallback_metrics)
            and (best_metrics is not None or incumbent_is_safe_stagnation_fallback)
        )
        if accept_stagnant_limit <= 0 or not fallback_is_safe:
            return False
        accept_stagnant_iterations = 0 if improved else accept_stagnant_iterations + 1
        entry["accept_stagnant_iterations"] = accept_stagnant_iterations
        entry["accept_stagnant_limit"] = accept_stagnant_limit
        entry["incumbent_fallback_available"] = incumbent_is_safe_stagnation_fallback
        if accept_stagnant_iterations < accept_stagnant_limit:
            return False
        entry["accept_stagnation_stop"] = True
        return True
    residual_assignment_keys = {
        (assignment.class_name, assignment.subject, assignment.teacher)
        for assignment in ctx.school_data.assignments
    }

    def residual_allocations(allocations: list[SessionAllocation] | None) -> list[SessionAllocation] | None:
        if not allocations or not residual_assignment_keys:
            return allocations
        kept = [
            allocation
            for allocation in allocations
            if (allocation.class_name, allocation.subject, allocation.teacher) in residual_assignment_keys
        ]
        return kept or None

    incumbent_hint_lessons = _payload_lessons_to_lessons(incumbent_payload)
    if fixed_existing_lessons_are_hard and incumbent_hint_lessons:
        # The residual school context has already removed every hard-fixed
        # lesson from assignment demand. Feeding the full incumbent back as a
        # CP-SAT hint over-counts those assignments (54 periods on default), so
        # the hint cannot satisfy the residual equalities and OR-Tools starts
        # essentially from scratch. Keep only movable instances in the warm
        # start; fixed lessons are supplied separately through ``fixed_lessons``
        # and remain hard constraints in both session and period models.
        incumbent_hint_lessons = _lessons_without_fixed_instances(
            incumbent_hint_lessons,
            fixed_existing_lessons,
        )
    current_hint = residual_allocations(
        _allocations_from_lessons(incumbent_hint_lessons)
        if incumbent_hint_lessons
        else None
    )
    current_period_hint_lessons = list(incumbent_hint_lessons or []) or None
    seed_sequence: list[int | None] = []
    raw_seed_sequence: list[int | None] = []
    if random_seed is not None:
        raw_seed_sequence.append(int(random_seed))
    raw_seed_sequence.extend(_school_seed_sequence(ctx.school_data, max_iterations + 2))
    raw_seed_sequence.append(None)
    # A caller may pass one of the school-derived seeds explicitly.  Preserve
    # portfolio order while avoiding a retry that is byte-for-byte identical.
    seen_seeds: set[int | None] = set()
    for seed_value in raw_seed_sequence:
        if seed_value in seen_seeds:
            continue
        seen_seeds.add(seed_value)
        seed_sequence.append(seed_value)

    for iteration in range(1, max_iterations + 1):
        if deadline.exhausted(8):
            history.append({"iteration": iteration, "status": "budget_exhausted", "cuts": len(cuts)})
            break
        seed = seed_sequence[(iteration - 1) % len(seed_sequence)] if seed_sequence else None
        # Once the lean allocator has rejected enough distinct period vectors,
        # promote the next attempt before calculating the legacy period-MILP
        # reserve.  The promoted CP-SAT call materializes and validates periods
        # itself; reserving another allocator slice would starve it at the exact
        # point where it is meant to recover an unlucky quality seed.
        effective_bridge_all_period_sessions = bridge_all_period_sessions or (
            complete_first and len(cuts) >= bridge_promotion_cut_count
        )
        # The all-session bridge materializes and validates final periods inside
        # the CP-SAT call.  Reserving another period-allocation slice here only
        # shortens the model that is actually doing the work (on the default
        # grid it reduced a 41-second slice to about 24 seconds).  Keep the
        # reserve for the legacy two-stage path, where a separate allocator is
        # still required after the session model returns.
        phase_reserve = (
            0.0
            if effective_bridge_all_period_sessions
            else min(20.0, float(period_limit // 2 + 4))
        )
        session_limit = deadline.phase_limit(session_slice, reserve_seconds=phase_reserve)
        if progress:
            progress(
                {
                    "stage": "teacher_session_opt:benders_session",
                    "message": f"Thu cap {cap} bang Benders iteration {iteration}",
                    "cap": cap,
                    "iteration": iteration,
                    "cuts": len(cuts),
                    "random_seed": seed,
                    "time_limit_seconds": session_limit,
                }
            )
        try:
            allocations, session_metrics = solve_session_allocation_cp_sat(
                ctx.school_data,
                rules=effective_rules,
                max_teacher_sessions=int(cap),
                max_one_period_sessions=max_one_period_sessions,
                minimize_sessions=not session_feasibility_only,
                minimize_one_period_sessions=session_minimize_one_period_sessions,
                one_period_priority_absolute=not allow_complete_first_one_period_debt,
                time_limit_seconds=session_limit,
                early_stop_teacher_sessions=(
                    int(cap)
                    if stop_on_first_quality_gate_clean and not session_feasibility_only
                    else (
                        None
                        if disable_session_early_stop or session_feasibility_only
                        else int(target_teacher_sessions or cap)
                    )
                ),
                early_stop_max_one_period_sessions=(
                    0
                    if stop_on_first_quality_gate_clean and not allow_complete_first_one_period_debt
                    else (
                        None
                        if disable_session_early_stop or allow_complete_first_one_period_debt
                        else 0
                    )
                ),
                linearization_level=session_linearization_level,
                num_workers=solver_workers,
                random_seed=seed,
                hint_allocations=current_hint,
                hint_lessons=current_period_hint_lessons,
                fixed_lessons=session_fixed_lessons,
                repair_hint=current_hint is not None,
                forbidden_session_vectors=cuts,
                period_feasibility_session_indexes=(
                    ({session_index for session_index, _vector in cuts})
                    | (
                        set(range(len(all_sessions())))
                        if effective_bridge_all_period_sessions
                        else set()
                    )
                )
                or None,
                period_max_teacher_gap=period_max_teacher_gap,
                materialize_period_lessons=True,
                # Keep a known period-feasible incumbent close when quality is
                # tied.  Session/one-period quality remains the primary
                # objective inside the CP-SAT model.
                minimize_hint_distance=(
                    current_hint is not None
                    and not session_feasibility_only
                    and _truthy_setting(
                        settings.get("optimization_benders_minimize_hint_distance", True)
                    )
                ),
                legacy_wednesday_pm_bridge=False,
                progress=progress,
            )
            raw_period_bridge_lessons = session_metrics.pop("period_bridge_lessons", None)
            materialized_period_lessons = (
                [Lesson(**dict(item)) for item in raw_period_bridge_lessons]
                if isinstance(raw_period_bridge_lessons, list)
                and all(isinstance(item, Mapping) for item in raw_period_bridge_lessons)
                else []
            )
        except SessionCpSatNoSolution as exc:
            history.append(
                {
                    "iteration": iteration,
                    "status": "session_no_solution",
                    "cap": cap,
                    "cuts": len(cuts),
                    "random_seed": seed,
                    "solver_status": exc.metrics.get("status_name"),
                    "elapsed_seconds": exc.metrics.get("elapsed_seconds"),
                }
            )
            if record_stagnation(history[-1]):
                break
            continue

        try:
            if progress:
                progress(
                    {
                        "stage": "teacher_session_opt:benders_period",
                        "message": f"Kiem tra xep tiet cho cap {cap}",
                        "cap": cap,
                        "iteration": iteration,
                        "cuts": len(cuts),
                    }
                )
            use_materialized_periods = False
            bridge_validation: Mapping[str, Any] = {}
            if materialized_period_lessons:
                full_bridge_lessons = _merge_fixed_lessons_into_solution(
                    materialized_period_lessons,
                    fixed_existing_lessons,
                )
                bridge_validation = compute_metrics(
                    original_ctx.school_data,
                    full_bridge_lessons,
                    rules=report_rules,
                )
                bridge_expected = _metric_int(bridge_validation, "expected_periods", 0)
                bridge_scheduled = _metric_int(bridge_validation, "scheduled_periods", 0)
                bridge_one_period = _metric_int(
                    bridge_validation,
                    "one_period_teacher_sessions",
                    10**9,
                )
                use_materialized_periods = (
                    bridge_expected > 0
                    and bridge_scheduled == bridge_expected
                    and bool(bridge_validation.get("hard_ok"))
                    and _metric_int(bridge_validation, "app_constraint_violation_count", 0) == 0
                    and (
                        max_one_period_sessions is None
                        or bridge_one_period <= int(max_one_period_sessions)
                    )
                    and (
                        period_max_teacher_gap is None
                        or _max_gap_size(bridge_validation) <= int(period_max_teacher_gap)
                    )
                )
            if use_materialized_periods:
                lessons = materialized_period_lessons
                period_metrics = {
                    "solver": "ortools_cp_sat_materialized_period_bridge",
                    "materialized_periods": len(materialized_period_lessons),
                    "full_periods": _metric_int(bridge_validation, "scheduled_periods", 0),
                    "validated_hard_ok": bool(bridge_validation.get("hard_ok")),
                    "app_constraint_violation_count": _metric_int(
                        bridge_validation,
                        "app_constraint_violation_count",
                        0,
                    ),
                    "one_period_teacher_sessions": _metric_int(
                        bridge_validation,
                        "one_period_teacher_sessions",
                        0,
                    ),
                    "gap_distribution": bridge_validation.get("gap_distribution"),
                    "max_teacher_gap": period_max_teacher_gap,
                }
                if (
                    not complete_first
                    and period_minimize_teacher_gaps
                    and not deadline.exhausted(8)
                ):
                    try:
                        polished_lessons, polished_period_metrics = allocate_periods(
                            ctx.school_data,
                            allocations,
                            rules=effective_rules,
                            fixed_lessons=session_fixed_lessons,
                            time_limit_seconds_per_session=period_limit,
                            retry_time_limit_seconds_per_session=period_retry_limit,
                            remaining_time_seconds=deadline.remaining,
                            max_teacher_gap=period_max_teacher_gap,
                            minimize_teacher_gaps=True,
                            best_effort=False,
                            verbose=False,
                            progress=progress,
                            max_workers=solver_workers,
                        )
                        polished_validation = compute_metrics(
                            original_ctx.school_data,
                            _merge_fixed_lessons_into_solution(
                                polished_lessons,
                                fixed_existing_lessons,
                            ),
                            rules=report_rules,
                        )
                        polished_acceptable = (
                            _metric_int(polished_validation, "scheduled_periods", 0)
                            == _metric_int(polished_validation, "expected_periods", -1)
                            and bool(polished_validation.get("hard_ok"))
                            and _metric_int(
                                polished_validation,
                                "app_constraint_violation_count",
                                0,
                            )
                            == 0
                            and (
                                max_one_period_sessions is None
                                or _metric_int(
                                    polished_validation,
                                    "one_period_teacher_sessions",
                                    10**9,
                                )
                                <= int(max_one_period_sessions)
                            )
                            and (
                                period_max_teacher_gap is None
                                or _max_gap_size(polished_validation)
                                <= int(period_max_teacher_gap)
                            )
                        )
                        if (
                            polished_acceptable
                            and _teacher_session_opt_quality(polished_validation)
                            < _teacher_session_opt_quality(bridge_validation)
                        ):
                            lessons = polished_lessons
                            period_metrics = {
                                **dict(polished_period_metrics),
                                "solver": "period_milp_after_materialized_bridge",
                                "materialized_bridge_fallback_available": True,
                                "materialized_bridge_gap_distribution": bridge_validation.get(
                                    "gap_distribution"
                                ),
                                "gap_distribution": polished_validation.get(
                                    "gap_distribution"
                                ),
                            }
                    except Exception as polish_error:  # Keep the validated bridge result.
                        period_metrics["period_polish_error"] = str(polish_error)[:500]
            else:
                lessons, period_metrics = allocate_periods(
                    ctx.school_data,
                    allocations,
                    rules=effective_rules,
                    fixed_lessons=session_fixed_lessons,
                    time_limit_seconds_per_session=period_limit,
                    retry_time_limit_seconds_per_session=period_retry_limit,
                    remaining_time_seconds=deadline.remaining,
                    max_teacher_gap=period_max_teacher_gap,
                    minimize_teacher_gaps=period_minimize_teacher_gaps,
                    best_effort=False,
                    verbose=False,
                    progress=progress,
                    max_workers=solver_workers,
                )
            solver_metrics = {
                "session_solver": {
                    **dict(session_metrics),
                    "fallback_reason": "teacher_session_opt_benders",
                    "requested_max_teacher_sessions": int(cap),
                    "effective_max_teacher_sessions": int(cap),
                    "benders_iterations": iteration,
                    "benders_cuts": len(cuts),
                },
                "period_solver": {
                    **dict(period_metrics),
                    "solver": str(period_metrics.get("solver") or "period_milp_benders"),
                    "benders_iterations": iteration,
                    "benders_cuts": len(cuts),
                },
                "runtime_settings": {
                        "auto_sort_mode": "teacher_session_opt",
                        "benders_teacher_session_opt": True,
                        "benders_complete_first": complete_first,
                        "benders_allow_one_period_debt": allow_complete_first_one_period_debt,
                        "benders_skip_relaxed_period_probe": skip_relaxed_period_probe,
                        "benders_period_feasibility_all_sessions": bridge_all_period_sessions,
                        "benders_lean_refinement_periods": lean_refinement_periods,
                        "benders_session_feasibility_only": session_feasibility_only,
                        "benders_disable_session_early_stop": disable_session_early_stop,
                        "continue_quality_search": continue_quality_search,
                        "period_max_teacher_gap": period_max_teacher_gap,
                        "minimize_teacher_gaps": period_minimize_teacher_gaps,
                        "max_teacher_sessions": int(cap),
                        "requested_max_teacher_sessions": int(cap),
                        "elapsed_seconds": round(deadline.elapsed(), 3),
                        "overall_time_limit_seconds": int(time_limit_seconds),
                        "random_seed": seed,
                        "fixed_existing_lessons": len(fixed_existing_lessons),
                        "preserve_fixed_lessons_only": bool(fixed_existing_lessons_are_hard),
                        "hard_fixed_existing_lessons": bool(fixed_existing_lessons_are_hard),
                    },
                "teacher_session_benders": {
                    "cap": int(cap),
                    "iterations": iteration,
                    "cuts": len(cuts),
                    "history": history,
                },
            }
            if fixed_existing_lessons_are_hard:
                solver_metrics["residual_validation"] = compute_metrics(
                    ctx.school_data,
                    lessons,
                    rules=effective_rules,
                )
                lessons = _merge_fixed_lessons_into_solution(lessons, fixed_existing_lessons)
            payload = build_payload(
                original_ctx if fixed_existing_lessons_are_hard else ctx,
                lessons,
                solver_metrics,
                report_rules,
                unassigned_lessons=list(unassigned_lessons),
                original_ctx=None if fixed_existing_lessons_are_hard else original_ctx,
                best_effort=False,
                allow_temporary_teacher_gap_debt=allow_complete_first_one_period_debt,
            )
            metrics = payload.get("metrics") if isinstance(payload.get("metrics"), Mapping) else {}
            new_best_this_iteration = False
            candidate_acceptable = _complete_payload_metrics_acceptable(payload)
            history_entry: dict[str, Any] = {
                "iteration": iteration,
                "status": "period_ok" if candidate_acceptable else "period_candidate_rejected",
                "cap": cap,
                "teacher_sessions": metrics.get("teacher_sessions"),
                "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
                "gap_distribution": metrics.get("gap_distribution"),
                "cuts": len(cuts),
                "accepted": bool(candidate_acceptable),
                "hard_ok": metrics.get("hard_ok"),
                "core_hard_ok": metrics.get("core_hard_ok"),
                "teacher_slot_conflicts": metrics.get("teacher_slot_conflicts"),
                "class_slot_conflicts": metrics.get("class_slot_conflicts"),
                "room_slot_conflicts": metrics.get("room_slot_conflicts"),
                "scheduled_periods": metrics.get("scheduled_periods"),
                "expected_periods": metrics.get("expected_periods"),
                "unassigned_periods": metrics.get("unassigned_periods"),
                "validation_hard_ok": (
                    payload.get("validation", {}).get("hard_ok")
                    if isinstance(payload.get("validation"), Mapping)
                    else None
                ),
                "best_effort": payload.get("bestEffort"),
                "app_constraint_violation_count": metrics.get("app_constraint_violation_count"),
                "invalid_lesson_slot_count": metrics.get("invalid_lesson_slot_count"),
                "assignment_mismatch_count": len(metrics.get("assignment_mismatches") or []),
                "class_session_violation_count": len(metrics.get("class_session_violations") or []),
                "subject_session_limit_violation_count": len(
                    metrics.get("subject_session_limit_violations") or []
                ),
                "contiguous_block_violation_count": _metric_int(
                    metrics, "contiguous_block_violation_count", 0
                ),
            }
            residual_validation = solver_metrics.get("residual_validation")
            if isinstance(residual_validation, Mapping):
                history_entry["residual_validation"] = {
                    key: residual_validation.get(key)
                    for key in (
                        "hard_ok",
                        "core_hard_ok",
                        "teacher_slot_conflicts",
                        "class_slot_conflicts",
                        "room_slot_conflicts",
                        "app_constraint_violation_count",
                        "invalid_lesson_slot_count",
                    )
                }
            if not candidate_acceptable:
                history_entry["conflicts"] = _lesson_resource_conflict_details(
                    lessons,
                    fixed_lessons=fixed_existing_lessons if fixed_existing_lessons_are_hard else None,
                )
            history.append(history_entry)
            candidate_within_cap = (
                candidate_acceptable
                and _metric_int(metrics, "teacher_sessions", 10**9) <= cap
            )
            if candidate_within_cap:
                one_period_cap_met = (
                    max_one_period_sessions is None
                    or _metric_int(metrics, "one_period_teacher_sessions", 10**9)
                    <= int(max_one_period_sessions)
                )
                if strict_one_period_sessions_cap and not one_period_cap_met:
                    quality_cuts = _cut_for_one_period_teacher_sessions(
                        ctx.school_data,
                        allocations,
                        lessons,
                    )
                    quality_added = _append_unique_session_cuts(
                        cuts,
                        cut_keys,
                        quality_cuts,
                    )
                    history[-1].update(
                        {
                            "status": "period_ok_one_period_cap_miss",
                            "one_period_cap": int(max_one_period_sessions or 0),
                            "one_period_cuts_added": quality_added,
                            "cuts_total": len(cuts),
                        }
                    )
                    current_hint = allocations if quality_added > 0 else None
                    if record_stagnation(history[-1]):
                        break
                    continue
                frontier_search = _truthy_setting(
                    settings.get("optimization_refinement_frontier_search")
                )
                if frontier_search:
                    candidate_better = (
                        best_metrics is None
                        or _teacher_session_opt_frontier_better(metrics, best_metrics)
                    )
                else:
                    candidate_better = (
                        best_metrics is None
                        or _teacher_session_opt_goal_aware_better(
                            metrics,
                            best_metrics,
                            target_teacher_sessions=target_teacher_sessions,
                            target_gap1_sessions=(
                                target_gap1_sessions if quality_gap1_first else None
                            ),
                            accept_teacher_sessions=accept_teacher_sessions,
                            accept_gap1_sessions=accept_gap1_sessions,
                            enforce_balanced_envelope=balanced_quality_envelope,
                        )
                    )
                if candidate_better:
                    best_payload = payload
                    best_metrics = metrics
                    new_best_this_iteration = True
                    history[-1]["new_best"] = True
                if (
                    stop_on_first_quality_gate_clean
                    and _teacher_session_opt_quality_gates_clean(metrics)
                ):
                    history[-1]["first_quality_gate_stop"] = True
                    return best_payload or payload
                goal_satisfied = _teacher_session_opt_should_stop(
                    metrics,
                    target_teacher_sessions=target_teacher_sessions,
                    target_gap1_sessions=target_gap1_sessions,
                    accept_teacher_sessions=accept_teacher_sessions,
                    accept_gap1_sessions=accept_gap1_sessions,
                )
                if complete_first or (adaptive_target and target_gap1_sessions is None):
                    goal_satisfied = True
                if continue_quality_search:
                    goal_satisfied = False
                if record_stagnation(
                    history[-1],
                    improved=new_best_this_iteration,
                ):
                    goal_satisfied = True
                history[-1]["goal_satisfied"] = goal_satisfied
                if history[-1].get("accept_stagnation_stop"):
                    return best_payload or payload
                if not continue_quality_search and (goal_satisfied or not has_quality_goal):
                    return best_payload or payload
                if target_gap1_sessions is not None and _teacher_session_opt_gap1(metrics) > target_gap1_sessions:
                    quality_cut_scope = str(
                        settings.get("optimization_benders_quality_cut_scope") or "session"
                    )
                    quality_cut_limit = max(
                        1,
                        min(12, _to_int(settings.get("optimization_benders_quality_cut_limit"), 1)),
                    )
                    quality_cuts = _new_cuts_for_period_metrics(
                        ctx.school_data,
                        allocations,
                        metrics,
                        cut_scope=quality_cut_scope,
                    )[:quality_cut_limit]
                    quality_added = _append_unique_session_cuts(cuts, cut_keys, quality_cuts)
                    history[-1]["quality_cut_scope"] = quality_cut_scope
                    history[-1]["quality_cuts_added"] = quality_added
                    history[-1]["cuts_total"] = len(cuts)
                current_hint = allocations
                continue
            if record_stagnation(history[-1]):
                break
        except Exception as exc:  # noqa: BLE001 - convert the failed period vector into Benders cuts.
            strict_cuts = _cut_for_period_error_sparse(ctx.school_data, allocations, exc)
            relaxed_metrics: Mapping[str, Any] = {}
            relaxed_error = None
            # A structural cut already tells the next session solve exactly
            # which aggregate vector to avoid. Re-solving the same vector with
            # relaxed teacher-gap bounds cannot improve that cut and consumed
            # a full period wave on large schools. Keep the relaxed diagnostic
            # only when the strict failure could not produce a usable cut.
            if not skip_relaxed_period_probe and not strict_cuts:
                try:
                    relaxed_lessons, _relaxed_period_metrics = allocate_periods(
                        ctx.school_data,
                        allocations,
                        rules=effective_rules,
                        fixed_lessons=session_fixed_lessons,
                        time_limit_seconds_per_session=max(20, min(60, period_limit)),
                        retry_time_limit_seconds_per_session=max(20, min(60, period_retry_limit)),
                        remaining_time_seconds=deadline.remaining,
                        max_teacher_gap=None,
                        minimize_teacher_gaps=True,
                        best_effort=False,
                        verbose=False,
                        progress=progress,
                        max_workers=solver_workers,
                    )
                    relaxed_metrics = compute_metrics(ctx.school_data, relaxed_lessons, rules=effective_rules)
                except Exception as relaxed_exc:  # noqa: BLE001 - the strict failed session vector is still useful.
                    relaxed_error = relaxed_exc
            candidate_cuts = [
                *strict_cuts,
                *_new_cuts_for_period_metrics(
                    ctx.school_data,
                    allocations,
                    relaxed_metrics,
                    cut_scope=cut_scope,
                ),
            ]
            added = _append_unique_session_cuts(cuts, cut_keys, candidate_cuts)
            history.append(
                {
                    "iteration": iteration,
                    "status": "period_failed_added_cuts" if added else "period_failed_no_new_cuts",
                    "cap": cap,
                    "error": str(exc),
                    "error_detail": exc.to_dict() if isinstance(exc, PeriodAllocationError) else None,
                    "relaxed_error": str(relaxed_error) if relaxed_error is not None else None,
                    "relaxed_error_detail": relaxed_error.to_dict() if isinstance(relaxed_error, PeriodAllocationError) else None,
                    "relaxed_gap_distribution": relaxed_metrics.get("gap_distribution") if isinstance(relaxed_metrics, Mapping) else None,
                    "relaxed_gap_sessions": len(relaxed_metrics.get("gap_sessions") or []) if isinstance(relaxed_metrics, Mapping) else 0,
                    "relaxed_period_probe_skipped": skip_relaxed_period_probe,
                    "cuts_added": added,
                    "cuts_total": len(cuts),
                    "random_seed": seed,
                }
            )
            if record_stagnation(history[-1]):
                break
            if added <= 0:
                break
            current_hint = allocations
            # A failed period vector has no concrete period assignment to use
            # as a subsequent CP-SAT period hint. Keep the aggregate allocation
            # warm start, but do not feed stale concrete blocks into the next
            # Benders cut model.
            current_period_hint_lessons = None

    # A fixed-only request is a special recovery shape: the visible request
    # contains the hard anchors (usually the 54 fixed periods) but no flexible
    # incumbent at all.  The lean Benders lane can reject every session vector
    # because it was shaped around the old anchor-preserving trajectory.  Do
    # one bounded retry from an empty flexible timetable while retaining the
    # hard lessons and the complete application rule set.  This is deliberately
    # inside the same deadline and guarded so a failed retry cannot recurse.
    fixed_only_fallback_detail: dict[str, Any] | None = None
    expected_fixed_only_periods = sum(
        max(0, int(item.periods_per_week)) for item in original_ctx.school_data.assignments
    )
    fixed_only_fallback_eligible = (
        fixed_existing_lessons_are_hard
        and 0 < len(fixed_existing_lessons) < expected_fixed_only_periods
        and incumbent_payload is None
        and not _truthy_setting(settings.get("preserve_existing_tkb"))
        and not _truthy_setting(settings.get("_fixed_only_empty_fallback_attempted"))
    )
    if best_payload is None and fixed_only_fallback_eligible:
        remaining = deadline.remaining()
        fallback_budget = (
            max(0, int(float(remaining) - 1.0))
            if remaining is not None
            else max(0, int(time_limit_seconds))
        )
        fixed_only_fallback_detail = {
            "eligible": True,
            "fixed_lessons": len(fixed_existing_lessons),
            "expected_periods": expected_fixed_only_periods,
            "remaining_seconds": round(float(remaining), 3) if remaining is not None else None,
            "attempted": False,
        }
        if fallback_budget >= 8:
            fallback_settings = dict(settings)
            fallback_settings.update(
                {
                    "_fixed_only_empty_fallback_attempted": True,
                    "auto_sort_strategy": "fixed_only_empty_fresh_fallback",
                    "preserve_existing_tkb": False,
                    "preserve_fixed_lessons_only": True,
                    "force_preserve_partial_existing": False,
                    "partial_existing_rebuild": False,
                    "repair_fill_first": False,
                    "repair_partial_existing": False,
                    "existing_fill_missing_schedule": False,
                    "allow_solver_warm_start": False,
                    "allow_backend_cache": False,
                    "allow_legacy_solver_hints": False,
                    "disable_native_hint_solver": True,
                    "disable_solver_hints": True,
                    "native_disable_cached_hint_candidate": True,
                    "native_disable_static_hint_candidate": True,
                    "native_hint_bank_max_entries": 0,
                    "native_hint_bank_time_limit_ms": 0,
                    "fast_repair_period_hint": False,
                    "fast_validated_period_hint": False,
                    "fresh_randomize": True,
                    "randomize_search": True,
                    "fresh_randomize_strategy": "solver_random",
                    "optimization_benders_period_feasibility_all_sessions": True,
                    "optimization_benders_lean_refinement_periods": False,
                    "optimization_benders_session_feasibility_only": False,
                    "optimization_benders_complete_first": True,
                    "optimization_benders_allow_one_period_debt": True,
                    "max_one_period_sessions": "off",
                    "strict_one_period_sessions_cap": False,
                    "enforce_max_one_period_sessions": False,
                    "one_period_priority_absolute": False,
                    "allow_quality_debt": True,
                    "period_max_teacher_gap": "off",
                    "relax_period_teacher_gap_on_failure": True,
                    "best_effort_on_timeout": False,
                    "require_complete_schedule": True,
                    "overall_time_limit_seconds": fallback_budget,
                    "integrated_time_limit": fallback_budget,
                    "optimization_time_limit_seconds": fallback_budget,
                    "optimization_benders_session_time_limit": max(
                        10, min(30, fallback_budget - 2)
                    ),
                    "period_time_limit": max(12, min(30, fallback_budget - 2)),
                    "optimization_period_retry_time_limit": max(12, min(30, fallback_budget - 2)),
                }
            )
            fallback_seeds = [value for value in seed_sequence if value is not None]
            fallback_seed = (
                fallback_seeds[-1]
                if fallback_seeds and fallback_seeds[-1] != seed
                else (fallback_seeds[0] if fallback_seeds else 17)
            )
            fallback_settings["random_seed"] = fallback_seed
            if progress:
                progress(
                    {
                        "stage": "teacher_session_opt:fixed_only_empty_fallback",
                        "message": "Thu xep lai tu cac tiet co dinh, bo qua lich tam",
                        "fixed_lessons": len(fixed_existing_lessons),
                        "expected_periods": expected_fixed_only_periods,
                        "time_limit_seconds": fallback_budget,
                        "random_seed": fallback_seed,
                    }
                )
            fallback_started = time.monotonic()
            fallback_error: Exception | None = None
            fallback_payload: dict[str, Any] | None = None
            try:
                fallback_payload = _solve_teacher_session_benders_candidate(
                    ui_data,
                    fallback_settings,
                    cap=max(cap, _relaxed_teacher_session_cap(cap, expected_fixed_only_periods)),
                    time_limit_seconds=fallback_budget,
                    rules=rules,
                    progress=progress,
                    incumbent_payload=None,
                    random_seed=fallback_seed,
                    deadline=deadline,
                )
            except Exception as fallback_exc:  # noqa: BLE001 - preserve original failure diagnostics.
                fallback_error = fallback_exc
            fallback_ok = bool(
                isinstance(fallback_payload, Mapping)
                and _complete_payload_metrics_acceptable(fallback_payload)
                and _payload_preserves_required_lessons(fallback_payload, fixed_existing_lessons)
            )
            fixed_only_fallback_detail.update(
                {
                    "attempted": True,
                    "accepted": fallback_ok,
                    "elapsed_seconds": round(time.monotonic() - fallback_started, 3),
                    "time_limit_seconds": fallback_budget,
                    "random_seed": fallback_seed,
                    "error": str(fallback_error)[:500] if fallback_error is not None else None,
                }
            )
            if fallback_ok:
                fallback_solver = fallback_payload.get("solver")
                if not isinstance(fallback_solver, dict):
                    fallback_solver = {}
                    fallback_payload["solver"] = fallback_solver
                fallback_runtime = fallback_solver.get("runtime_settings")
                if not isinstance(fallback_runtime, dict):
                    fallback_runtime = {}
                    fallback_solver["runtime_settings"] = fallback_runtime
                fallback_runtime.update(
                    {
                        "fixed_only_empty_fallback": True,
                        "fixed_only_empty_fallback_fixed_lessons": len(fixed_existing_lessons),
                        "fixed_only_empty_fallback_elapsed_seconds": fixed_only_fallback_detail["elapsed_seconds"],
                        "fixed_only_empty_fallback_random_seed": fallback_seed,
                        "fixed_only_empty_fallback_no_hint": True,
                    }
                )
                return fallback_payload

    if best_payload is not None:
        solver_meta = best_payload.get("solver") if isinstance(best_payload.get("solver"), Mapping) else None
        benders_meta = (
            solver_meta.get("teacher_session_benders")
            if isinstance(solver_meta, Mapping) and isinstance(solver_meta.get("teacher_session_benders"), Mapping)
            else None
        )
        if isinstance(benders_meta, dict):
            benders_meta["iterations"] = max(
                (_to_int(item.get("iteration"), 0) for item in history if isinstance(item, Mapping)),
                default=0,
            )
            benders_meta["cuts"] = len(cuts)
            benders_meta["history"] = list(history)
        return best_payload
    detail = {"cap": int(cap), "history": history, "cuts": len(cuts)}
    if fixed_only_fallback_detail is not None:
        detail["fixed_only_empty_fallback"] = fixed_only_fallback_detail
    raise RuntimeError("Benders teacher-session cap search failed: " + json.dumps(detail, ensure_ascii=False, default=str))


def _fast_benders_tight_fixed_off_profile(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    *,
    rules: TimetableRuleSet | None = None,
    bounds: Mapping[str, int] | None = None,
) -> dict[str, int] | None:
    ctx = build_school_data_from_ui(ui_data)
    effective_rules = rules or ctx.rules
    if not _constraints_allow_session_cp_sat_fast_path(effective_rules):
        return None
    constraints = effective_rules.constraints
    fixed_by_class = constraints.fixed_off.get("class", {}) if constraints is not None else {}
    classes = [item.name for item in ctx.school_data.classes]
    expected = int((bounds or {}).get("expected_periods") or 0)
    if expected <= 0:
        expected = sum(max(0, int(item.periods_per_week)) for item in ctx.school_data.assignments)
    if expected < 900 or not classes or len(fixed_by_class) < len(classes):
        return None

    slots_per_class = sum(teacher_session_capacity(session) for session in all_sessions())
    demand_by_class: Counter[str] = Counter()
    for assignment in ctx.school_data.assignments:
        demand_by_class[assignment.class_name] += max(0, int(assignment.periods_per_week))

    fixed_slots = 0
    class_slacks: list[int] = []
    for class_name in classes:
        off_slots = fixed_by_class.get(class_name, frozenset())
        fixed_slots += len(off_slots)
        class_slacks.append(slots_per_class - len(off_slots) - int(demand_by_class.get(class_name, 0)))
    if not class_slacks or min(class_slacks) < 0:
        return None

    class_count = len(classes)
    total_slots = class_count * slots_per_class
    available_slots = total_slots - fixed_slots
    slack = available_slots - expected
    slack_limit = max(6, _ceil_div(class_count * 5, 4))
    if slack < 0 or slack > slack_limit or max(class_slacks) > 5:
        return None

    supplied = settings.get("tight_class_fixed_off_profile")
    supplied_matches = isinstance(supplied, Mapping) and (
        _to_int(supplied.get("expected"), 0) == expected
        and _to_int(supplied.get("availableSlots"), -1) == available_slots
        and _to_int(supplied.get("slack"), -1) == slack
    )
    return {
        "expected": expected,
        "class_count": class_count,
        "slots_per_class": slots_per_class,
        "fixed_slots": fixed_slots,
        "available_slots": available_slots,
        "slack": slack,
        "slack_limit": slack_limit,
        "min_class_slack": min(class_slacks),
        "max_class_slack": max(class_slacks),
        "supplied_profile_matches": int(supplied_matches),
    }


def _fast_benders_failure_summary(error: Exception, *, cap: int, budget: int, phase: str) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "phase": phase,
        "cap": int(cap),
        "time_limit_seconds": int(budget),
        "ok": False,
        "error_type": type(error).__name__,
    }
    message = str(error)
    marker = "Benders teacher-session cap search failed: "
    if marker not in message:
        summary["error"] = message[:500]
        return summary
    try:
        detail = json.loads(message.split(marker, 1)[1])
    except (TypeError, ValueError, json.JSONDecodeError):
        summary["error"] = message[:500]
        return summary
    history = detail.get("history") if isinstance(detail, Mapping) else None
    summary["cuts"] = _to_int(detail.get("cuts"), 0) if isinstance(detail, Mapping) else 0
    if isinstance(history, list):
        summary["iterations"] = max(
            (_to_int(item.get("iteration"), 0) for item in history if isinstance(item, Mapping)),
            default=0,
        )
        summary["statuses"] = [
            str(item.get("status") or "")
            for item in history
            if isinstance(item, Mapping) and item.get("status")
        ]
    return summary


def _solve_fast_tight_fixed_off_benders(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    *,
    bounds: Mapping[str, int],
    profile: Mapping[str, int],
    rules: TimetableRuleSet | None,
    progress: ProgressFn | None,
    deadline: SolverDeadline | None = None,
) -> dict[str, Any]:
    expected = max(1, int(bounds.get("expected_periods") or profile.get("expected") or 1))
    fast_settings = _teacher_session_opt_fast_quality_settings(settings, bounds)
    initial_cap = max(1, _to_int(fast_settings.get("max_teacher_sessions"), int(bounds.get("start_cap") or 1)))
    continue_quality_search = _truthy_setting(settings.get("optimization_continue_quality_search"))
    requested_random_seed = _positive_setting(settings, "random_seed")
    solver_workers = _solver_worker_count(settings)
    relaxed_cap = _relaxed_teacher_session_cap(initial_cap, expected)

    requested_budget = _to_int(
        settings.get("overall_time_limit_seconds"),
        _to_int(settings.get("optimization_time_limit_seconds"), 115),
    )
    minimum_budget = 30 if 0 < requested_budget <= 60 else 45
    configured_budget = max(
        minimum_budget,
        _to_int(settings.get("fast_benders_time_limit_seconds"), 115),
    )
    total_budget = max(
        minimum_budget,
        min(configured_budget, requested_budget if requested_budget > 0 else configured_budget),
    )
    deadline = (deadline or SolverDeadline(None)).bounded(total_budget)
    if total_budget >= 75 and relaxed_cap > initial_cap:
        fallback_reserve = max(
            15,
            min(30, _to_int(settings.get("fast_benders_relaxed_reserve_seconds"), 20)),
        )
        first_budget = max(45, total_budget - fallback_reserve)
    else:
        first_budget = total_budget

    candidate_settings = dict(settings)
    require_zero_one_period = _truthy_setting(
        settings.get("fast_benders_require_zero_one_period_sessions")
    )
    for key in (
        "target_teacher_sessions",
        "target_gap1_sessions",
        "optimization_accept_teacher_sessions",
        "optimization_accept_gap1_sessions",
        "optimization_default_accept_gap1_sessions",
        "session_early_stop_teacher_sessions",
        "session_early_stop_max_one_period_sessions",
    ):
        candidate_settings.pop(key, None)
    period_limit = max(12, min(18, _to_int(settings.get("period_time_limit"), 18)))
    candidate_settings.update(
        {
            "fast_quality_warmup_direct": False,
            "max_one_period_sessions": 0 if require_zero_one_period else "off",
            "strict_one_period_sessions_cap": require_zero_one_period,
            "enforce_max_one_period_sessions": require_zero_one_period,
            "one_period_priority_absolute": True,
            "allow_quality_debt": True,
            "optimization_benders_complete_first": True,
            "optimization_benders_allow_one_period_debt": not require_zero_one_period,
            "optimization_benders_skip_relaxed_period_probe": True,
            "optimization_benders_iterations": max(
                6,
                _to_int(settings.get("fast_benders_iterations"), 8),
            ),
            "optimization_benders_session_time_limit": max(
                10,
                min(14, _to_int(settings.get("fast_benders_session_time_limit"), 10)),
            ),
            "period_time_limit": period_limit,
            "optimization_period_retry_time_limit": period_limit,
            "best_effort_on_timeout": False,
            "require_complete_schedule": True,
        }
    )

    profile_started = time.monotonic()
    attempts: list[dict[str, Any]] = []
    generic_first = str(settings.get("ui_solver_preset") or "").strip().casefold() == "fast"
    if generic_first and requested_budget >= 45:
        generic_fallback_reserve = max(
            8,
            min(
                20,
                _to_int(settings.get("fast_generic_fallback_reserve_seconds"), 8),
            ),
        )
        generic_budget = max(
            30,
            min(
                60,
                max(30, requested_budget - generic_fallback_reserve),
                _to_int(settings.get("fast_generic_first_time_limit_seconds"), 60),
            ),
        )
        remaining = deadline.remaining()
        if remaining is not None:
            generic_budget = min(generic_budget, max(0, int(remaining)))
        if generic_budget < 8:
            generic_first = False
    if generic_first and requested_budget >= 45:
        generic_period_limit = max(12, min(30, generic_budget // 3))
        generic_session_limit = max(18, min(30, generic_budget // 3))
        generic_ctx = build_school_data_from_ui(ui_data)
        generic_seeds = _school_seed_sequence(generic_ctx.school_data, 2)
        generic_settings = dict(fast_settings)
        generic_settings.update(
            {
                "fast_quality_warmup_direct": False,
                "auto_sort_strategy": "fresh_fast_quality_generic_first",
                "overall_time_limit_seconds": generic_budget,
                "integrated_time_limit": generic_budget,
                "optimization_time_limit_seconds": generic_budget,
                "session_time_limit": generic_session_limit,
                "period_time_limit": generic_period_limit,
                "period_fast_time_limit": generic_period_limit,
                "period_retry_time_limit": generic_period_limit,
                "session_early_stop_enabled": True,
                "session_early_stop_teacher_sessions": initial_cap,
                "session_early_stop_max_one_period_sessions": 0 if require_zero_one_period else None,
                "max_one_period_sessions": 0 if require_zero_one_period else "off",
                "strict_one_period_sessions_cap": require_zero_one_period,
                "enforce_max_one_period_sessions": require_zero_one_period,
                "allow_quality_debt": not require_zero_one_period,
                "optimization_benders_allow_one_period_debt": not require_zero_one_period,
                "aggressive_fast_mode": False,
                "deep_session_rescue": True,
                "fresh_randomize": True,
                "randomize_search": True,
                "random_seed": requested_random_seed or (generic_seeds[-1] if generic_seeds else 17),
                "best_effort_on_timeout": False,
                "require_complete_schedule": True,
            }
        )
        generic_started = time.monotonic()
        try:
            generic_payload = solve_from_ui_data(
                ui_data,
                generic_settings,
                rules=rules,
                progress=progress,
                out_dir=None,
                _deadline=deadline,
            )
            generic_summary = _teacher_session_opt_summarize_attempt(
                cap=initial_cap,
                elapsed_seconds=time.monotonic() - generic_started,
                payload=generic_payload,
            )
            generic_summary["phase"] = "generic_first"
            attempts.append(generic_summary)
            if _complete_payload_metrics_acceptable(generic_payload):
                selected_payload = generic_payload
                selected_profile = "quality_warmup_direct_generic_first"
                if continue_quality_search:
                    local_started = time.monotonic()
                    local_budget = min(
                        max(0.0, _to_float(settings.get("fast_local_quality_polish_time_limit_seconds"), 8.0)),
                        max(0.0, total_budget - (time.monotonic() - profile_started)),
                    )
                    deadline_remaining = deadline.remaining()
                    if deadline_remaining is not None:
                        local_budget = min(local_budget, max(0.0, deadline_remaining - 1.0))
                    if local_budget >= 0.5:
                        report_rules = rules or generic_ctx.rules
                        fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, generic_ctx)
                        generic_ctx.warnings.extend(fixed_warnings)
                        fixed_lessons, released_warnings = _release_invalid_fixed_lessons(
                            generic_ctx.school_data,
                            fixed_lessons,
                            report_rules,
                            release_constraint_violations=False,
                        )
                        generic_ctx.warnings.extend(released_warnings)
                        local_rules = (
                            _rule_set_with_fixed_lesson_slots(report_rules, fixed_lessons)
                            if fixed_lessons
                            else report_rules
                        )
                        local_ctx = (
                            _context_without_fixed_lesson_demand(generic_ctx, fixed_lessons)
                            if fixed_lessons
                            else generic_ctx
                        )
                        generic_lessons = _payload_lessons_to_lessons(generic_payload)
                        movable_lessons = _lessons_without_fixed_instances(generic_lessons, fixed_lessons)
                        local_polish = _repair_one_period_affected_class_cluster(
                            local_ctx.school_data,
                            movable_lessons,
                            local_rules,
                            allow_gap1=True,
                            time_limit_seconds=local_budget,
                            max_classes=max(2, _to_int(settings.get("fast_local_quality_polish_max_classes"), 4)),
                            max_lessons=max(60, _to_int(settings.get("fast_local_quality_polish_max_lessons"), 140)),
                            num_workers=solver_workers,
                            optimize_teacher_quality=True,
                            fixed_lessons=fixed_lessons,
                            report_data=generic_ctx.school_data,
                            report_rules=report_rules,
                            random_seed=requested_random_seed,
                        )
                        local_summary: dict[str, Any] = {
                            "phase": "local_teacher_quality_lns",
                            "elapsed_seconds": round(time.monotonic() - local_started, 3),
                            "ok": local_polish is not None,
                        }
                        if local_polish is not None:
                            local_lessons, local_metrics, local_meta = local_polish
                            generic_metrics = (
                                generic_payload.get("metrics")
                                if isinstance(generic_payload.get("metrics"), Mapping)
                                else {}
                            )
                            local_summary.update(local_meta)
                            if _teacher_session_opt_quality(local_metrics) < _teacher_session_opt_quality(generic_metrics):
                                local_solver = dict(generic_payload.get("solver") or {})
                                local_period_solver = dict(local_solver.get("period_solver") or {})
                                local_period_solver.update(local_meta)
                                local_solver["period_solver"] = local_period_solver
                                local_payload = build_payload(
                                    generic_ctx,
                                    local_lessons,
                                    local_solver,
                                    report_rules,
                                )
                                if _complete_payload_metrics_acceptable(local_payload):
                                    local_summary["selected"] = True
                                    selected_payload = local_payload
                                    selected_profile = "generic_first_with_local_quality_lns"
                        attempts.append(local_summary)

                    remaining_fast_budget = max(0, int(total_budget - (time.monotonic() - profile_started)))
                    deadline_remaining = deadline.remaining()
                    if deadline_remaining is not None:
                        remaining_fast_budget = min(
                            remaining_fast_budget,
                            max(0, int(deadline_remaining)),
                        )
                    configured_polish_budget = max(
                        0,
                        _to_int(settings.get("fast_anytime_polish_time_limit_seconds"), 0),
                    )
                    polish_budget = min(configured_polish_budget, remaining_fast_budget)
                    if polish_budget >= 12:
                        polish_settings = dict(candidate_settings)
                        polish_settings.update(
                            {
                                "optimization_continue_quality_search": True,
                                "optimization_benders_disable_session_early_stop": True,
                                "optimization_benders_iterations": 2,
                                "optimization_benders_session_time_limit": 10,
                                "optimization_benders_skip_relaxed_period_probe": True,
                                "optimization_period_retry_time_limit": max(12, min(16, polish_budget // 2)),
                                "period_time_limit": max(12, min(16, polish_budget // 2)),
                                "max_one_period_sessions": 0,
                                "strict_one_period_sessions_cap": True,
                                "enforce_max_one_period_sessions": True,
                                "allow_quality_debt": False,
                            }
                        )
                        generic_metrics = (
                            generic_payload.get("metrics")
                            if isinstance(generic_payload.get("metrics"), Mapping)
                            else {}
                        )
                        polish_cap = min(
                            initial_cap,
                            max(1, _metric_int(generic_metrics, "teacher_sessions", initial_cap)),
                        )
                        polish_started = time.monotonic()
                        try:
                            polish_payload = _solve_teacher_session_benders_candidate(
                                ui_data,
                                polish_settings,
                                cap=polish_cap,
                                time_limit_seconds=polish_budget,
                                rules=rules,
                                progress=progress,
                                incumbent_payload=generic_payload,
                                random_seed=(
                                    ((requested_random_seed + 1) % 2_147_483_647)
                                    if requested_random_seed is not None
                                    else None
                                ),
                                deadline=deadline,
                            )
                            polish_summary = _teacher_session_opt_summarize_attempt(
                                cap=polish_cap,
                                elapsed_seconds=time.monotonic() - polish_started,
                                payload=polish_payload,
                            )
                            polish_summary["phase"] = "bounded_anytime_polish"
                            polish_metrics = (
                                polish_payload.get("metrics")
                                if isinstance(polish_payload.get("metrics"), Mapping)
                                else {}
                            )
                            if (
                                _complete_payload_metrics_acceptable(polish_payload)
                                and _teacher_session_opt_quality(polish_metrics)
                                < _teacher_session_opt_quality(generic_metrics)
                            ):
                                polish_summary["selected"] = True
                                selected_payload = polish_payload
                                selected_profile = "generic_first_with_bounded_polish"
                            attempts.append(polish_summary)
                        except Exception as exc:  # noqa: BLE001 - the complete incumbent remains valid.
                            polish_summary = _teacher_session_opt_summarize_attempt(
                                cap=polish_cap,
                                elapsed_seconds=time.monotonic() - polish_started,
                                error=exc,
                            )
                            polish_summary["phase"] = "bounded_anytime_polish"
                            polish_summary["incumbent_retained"] = True
                            attempts.append(polish_summary)

                solver = selected_payload.setdefault("solver", {})
                runtime = solver.setdefault("runtime_settings", {})
                elapsed = round(time.monotonic() - profile_started, 3)
                solver["fast_profile"] = selected_profile
                solver["fast_profile_bounds"] = dict(bounds)
                solver["fast_benders_feasibility"] = {
                    "profile": dict(profile),
                    "initial_cap": initial_cap,
                    "relaxed_cap": relaxed_cap,
                    "selected_cap": initial_cap,
                    "time_limit_seconds": requested_budget,
                    "elapsed_seconds": elapsed,
                        "generic_first": True,
                        "generic_first_time_limit_seconds": generic_budget,
                        "complete_first_then_polish": continue_quality_search,
                        "attempts": attempts,
                }
                runtime.update(
                    {
                        "auto_sort_mode": "fast",
                        "fast_profile": selected_profile,
                        "fast_generic_first_elapsed_seconds": elapsed,
                    }
                )
                selected_payload.setdefault("metrics", {})["auto_sort_mode"] = "fast"
                return selected_payload
        except Exception as exc:  # noqa: BLE001 - Benders remains the bounded fallback.
            generic_summary = _teacher_session_opt_summarize_attempt(
                cap=initial_cap,
                elapsed_seconds=time.monotonic() - generic_started,
                error=exc,
            )
            generic_summary["phase"] = "generic_first"
            attempts.append(generic_summary)

            retry_remaining = int(total_budget - (time.monotonic() - profile_started))
            deadline_remaining = deadline.remaining()
            if deadline_remaining is not None:
                retry_remaining = min(retry_remaining, max(0, int(deadline_remaining)))
            retry_budget = min(35, max(0, retry_remaining - 20))
            if retry_budget >= 20:
                retry_settings = dict(generic_settings)
                retry_seed = (
                    ((requested_random_seed + 104_729) % 2_147_483_647)
                    if requested_random_seed is not None
                    else (generic_seeds[0] if generic_seeds else 104_729)
                )
                retry_period_limit = max(10, min(16, retry_budget // 2))
                retry_settings.update(
                    {
                        "auto_sort_strategy": "fresh_fast_quality_generic_retry",
                        "max_teacher_sessions": relaxed_cap,
                        "requested_max_teacher_sessions": relaxed_cap,
                        "overall_time_limit_seconds": retry_budget,
                        "integrated_time_limit": retry_budget,
                        "optimization_time_limit_seconds": retry_budget,
                        "session_time_limit": max(12, min(18, retry_budget // 2)),
                        "period_time_limit": retry_period_limit,
                        "period_fast_time_limit": retry_period_limit,
                        "period_retry_time_limit": retry_period_limit,
                        "session_early_stop_enabled": True,
                        "session_early_stop_teacher_sessions": initial_cap,
                        "session_early_stop_max_one_period_sessions": 0 if require_zero_one_period else None,
                        "random_seed": retry_seed,
                    }
                )
                retry_started = time.monotonic()
                try:
                    retry_payload = solve_from_ui_data(
                        ui_data,
                        retry_settings,
                        rules=rules,
                        progress=progress,
                        out_dir=None,
                        _deadline=deadline,
                    )
                    retry_summary = _teacher_session_opt_summarize_attempt(
                        cap=relaxed_cap,
                        elapsed_seconds=time.monotonic() - retry_started,
                        payload=retry_payload,
                    )
                    retry_summary["phase"] = "generic_retry"
                    attempts.append(retry_summary)
                    if _complete_payload_metrics_acceptable(retry_payload):
                        solver = retry_payload.setdefault("solver", {})
                        runtime = solver.setdefault("runtime_settings", {})
                        elapsed = round(time.monotonic() - profile_started, 3)
                        solver["fast_profile"] = "quality_warmup_generic_retry"
                        solver["fast_profile_bounds"] = dict(bounds)
                        solver["fast_benders_feasibility"] = {
                            "profile": dict(profile),
                            "initial_cap": initial_cap,
                            "relaxed_cap": relaxed_cap,
                            "selected_cap": relaxed_cap,
                            "time_limit_seconds": total_budget,
                            "elapsed_seconds": elapsed,
                            "generic_first": True,
                            "generic_retry": True,
                            "attempts": attempts,
                        }
                        runtime.update(
                            {
                                "auto_sort_mode": "fast",
                                "fast_profile": "quality_warmup_generic_retry",
                                "fast_generic_first_elapsed_seconds": elapsed,
                            }
                        )
                        retry_payload.setdefault("metrics", {})["auto_sort_mode"] = "fast"
                        return retry_payload
                except Exception as retry_exc:  # noqa: BLE001 - use the remaining Benders budget.
                    retry_summary = _teacher_session_opt_summarize_attempt(
                        cap=relaxed_cap,
                        elapsed_seconds=time.monotonic() - retry_started,
                        error=retry_exc,
                    )
                    retry_summary["phase"] = "generic_retry"
                    attempts.append(retry_summary)

    started = time.monotonic()
    remaining_benders_budget = max(0, int(total_budget - (started - profile_started)))
    deadline_remaining = deadline.remaining()
    if deadline_remaining is not None:
        remaining_benders_budget = min(remaining_benders_budget, max(0, int(deadline_remaining)))
    bounded_first_budget = min(first_budget, remaining_benders_budget)
    selected_cap = initial_cap
    payload: dict[str, Any] | None = None
    last_error: Exception | None = None

    for phase, cap, budget in (
        ("speed_cap", initial_cap, bounded_first_budget),
        ("relaxed_cap", relaxed_cap, max(0, remaining_benders_budget - bounded_first_budget)),
    ):
        if phase == "relaxed_cap":
            budget = min(
                budget,
                max(0, int(total_budget - (time.monotonic() - profile_started))),
            )
        if budget < 8 or (phase == "relaxed_cap" and cap <= initial_cap):
            continue
        attempt_settings = dict(candidate_settings)
        attempt_settings["max_teacher_sessions"] = int(cap)
        attempt_settings["requested_max_teacher_sessions"] = int(cap)
        if progress:
            progress(
                {
                    "stage": f"fast_benders:{phase}",
                    "message": "Dang tim lich day du co kiem tra xep tiet",
                    "cap": int(cap),
                    "time_limit_seconds": int(budget),
                }
            )
        attempt_started = time.monotonic()
        try:
            payload = _solve_teacher_session_benders_candidate(
                ui_data,
                attempt_settings,
                cap=int(cap),
                time_limit_seconds=int(budget),
                rules=rules,
                progress=progress,
                incumbent_payload=None,
                random_seed=None,
                deadline=deadline,
            )
        except Exception as exc:  # noqa: BLE001 - the relaxed cap is the bounded recovery lane.
            last_error = exc
            summary = _fast_benders_failure_summary(exc, cap=int(cap), budget=int(budget), phase=phase)
            summary["elapsed_seconds"] = round(time.monotonic() - attempt_started, 3)
            attempts.append(summary)
            continue
        selected_cap = int(cap)
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), Mapping) else {}
        benders = payload.get("solver", {}).get("teacher_session_benders", {})
        attempts.append(
            {
                "phase": phase,
                "cap": int(cap),
                "time_limit_seconds": int(budget),
                "elapsed_seconds": round(time.monotonic() - attempt_started, 3),
                "ok": True,
                "iterations": _to_int(benders.get("iterations"), 0) if isinstance(benders, Mapping) else 0,
                "cuts": _to_int(benders.get("cuts"), 0) if isinstance(benders, Mapping) else 0,
                "teacher_sessions": metrics.get("teacher_sessions"),
                "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
            }
        )
        break

    if payload is None:
        detail = {
            "profile": dict(profile),
            "initial_cap": initial_cap,
            "relaxed_cap": relaxed_cap,
            "time_limit_seconds": total_budget,
            "attempts": attempts,
            "last_error": str(last_error)[:500] if last_error is not None else None,
        }
        failure = RuntimeError(
            "No CP-SAT session solution found before Fast Benders deadline: "
            + json.dumps(detail, ensure_ascii=False, default=str)
        )
        failure.fast_benders_detail = detail  # type: ignore[attr-defined]
        raise failure

    solver = payload.setdefault("solver", {})
    runtime = solver.setdefault("runtime_settings", {})
    benders = solver.get("teacher_session_benders") if isinstance(solver.get("teacher_session_benders"), Mapping) else {}
    elapsed = round(time.monotonic() - profile_started, 3)
    solver["fast_profile"] = "tight_fixed_off_benders_complete_first"
    solver["fast_profile_bounds"] = dict(bounds)
    solver["fast_benders_feasibility"] = {
        "profile": dict(profile),
        "initial_cap": initial_cap,
        "relaxed_cap": relaxed_cap,
        "selected_cap": selected_cap,
        "time_limit_seconds": total_budget,
        "elapsed_seconds": elapsed,
        "iterations": _to_int(benders.get("iterations"), 0),
        "cuts": _to_int(benders.get("cuts"), 0),
        "complete_first": True,
        "generic_first": generic_first,
        "relaxed_period_probe_skipped": True,
        "attempts": attempts,
    }
    session_solver = solver.get("session_solver")
    if isinstance(session_solver, dict):
        session_solver["fallback_reason"] = "fast_tight_fixed_off_benders"
    runtime.update(
        {
            "auto_sort_mode": "fast",
            "fast_profile": "tight_fixed_off_benders_complete_first",
            "fast_benders_selected_cap": selected_cap,
            "fast_benders_elapsed_seconds": elapsed,
        }
    )
    payload.setdefault("metrics", {})["auto_sort_mode"] = "fast"
    return payload


def _validated_existing_soft_incumbent_payload(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    *,
    rules: TimetableRuleSet | None,
) -> dict[str, Any] | None:
    if not (
        _truthy_setting(settings.get("ui_use_existing_complete_incumbent"))
        or _truthy_setting(settings.get("optimization_use_existing_incumbent"))
    ):
        return None

    ctx = build_school_data_from_ui(ui_data)
    effective_rules = rules or ctx.rules
    current_source = dict(ui_data)
    current_source.pop("tkbSolverResult", None)
    current_source.pop("tkbRustSolverResult", None)
    lessons, warnings = _extract_fixed_lessons_from_tkb(current_source, ctx)
    ctx.warnings.extend(warnings)
    expected = sum(item.periods_per_week for item in ctx.school_data.assignments)
    if expected <= 0 or len(lessons) != expected:
        return None

    metrics = compute_metrics(ctx.school_data, lessons, rules=effective_rules)
    if not _complete_schedule_metrics_acceptable(metrics):
        return None

    prior_payload = (
        ui_data.get("tkbSolverResult")
        if isinstance(ui_data.get("tkbSolverResult"), Mapping)
        else ui_data.get("tkbRustSolverResult")
    )
    durable_learning = (
        ui_data.get("tkbRefinementLearning")
        if isinstance(ui_data.get("tkbRefinementLearning"), Mapping)
        else None
    )
    refinement_learning = _merge_refinement_learning(
        ctx.school_data,
        prior_payload,
        durable_learning,
    )

    solver_metrics = {
        "session_solver": {
            "solver": "ui_existing_soft_incumbent",
            "status_name": "VALIDATED_INCUMBENT",
            "teacher_sessions": metrics.get("teacher_sessions"),
            "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
            "gap_distribution": metrics.get("gap_distribution"),
            "fixed": False,
        },
        "period_solver": {
            "solver": "ui_existing_soft_incumbent",
            "already_placed": True,
            "lesson_count": len(lessons),
        },
        "validation": metrics,
        "runtime_settings": {
            "phase": "validated_existing_soft_incumbent",
            "soft_incumbent": True,
            "hard_fixed": False,
            "refinement_learning": refinement_learning,
        },
    }
    return build_payload(ctx, lessons, solver_metrics, effective_rules)


def _bounded_soft_incumbent_residual_completion(
    data: SchoolData,
    incumbent_lessons: list[Lesson],
    rules: TimetableRuleSet,
    *,
    max_missing: int,
    max_nodes: int = 50_000,
    time_limit_seconds: float = 2.0,
) -> tuple[list[Lesson], dict[str, Any], dict[str, Any]] | None:
    """Fill a small residual without turning the incumbent into hard locks.

    The common edit-assignment case has only a handful of empty class cells.
    Enumerating those cells is dramatically cheaper and more stable than
    rebuilding every session.  If direct completion needs wider swaps, this
    bounded search returns ``None`` and the soft-hinted CP-SAT path takes over.
    """

    max_missing = max(0, int(max_missing))
    if not incumbent_lessons or max_missing <= 0:
        return None

    assignment_by_key: dict[tuple[str, str, str], tuple[int, Assignment]] = {
        (item.class_name, item.subject, item.teacher): (index, item)
        for index, item in enumerate(data.assignments)
    }
    actual_counts: Counter[tuple[str, str, str]] = Counter(
        (item.class_name, item.subject, item.teacher) for item in incumbent_lessons
    )
    remaining: Counter[int] = Counter()
    missing_total = 0
    for key, (assignment_index, assignment) in assignment_by_key.items():
        actual = int(actual_counts.get(key, 0))
        expected = int(assignment.periods_per_week)
        if actual > expected:
            return None
        missing = expected - actual
        if missing:
            remaining[assignment_index] = missing
            missing_total += missing
    if missing_total <= 0 or missing_total > max_missing:
        return None
    if sum(actual_counts.values()) + missing_total != sum(
        int(item.periods_per_week) for item in data.assignments
    ):
        return None

    partial_metrics = compute_metrics(data, incumbent_lessons, rules=rules)
    if not _placement_hard_ok_for_partial(
        partial_metrics,
        allow_temporary_teacher_gap_debt=True,
    ):
        return None

    constraints = rules.constraints
    class_slots: set[tuple[str, int, str, int]] = set()
    teacher_slots: set[tuple[str, int, str, int]] = set()
    room_slots: set[tuple[str, int, str, int]] = set()
    assignment_session_load: Counter[tuple[int, int, str]] = Counter()
    class_subject_session_load: Counter[tuple[str, str, int, str]] = Counter()
    class_session_load: Counter[tuple[str, int, str]] = Counter()
    teacher_session_load: Counter[tuple[str, int, str]] = Counter()
    teacher_session_periods: dict[tuple[str, int, str], set[int]] = defaultdict(set)
    lesson_by_class_slot: dict[tuple[str, int, str, int], Lesson] = {}

    for lesson in incumbent_lessons:
        day = int(lesson.day)
        part = str(lesson.session)
        period = int(lesson.period)
        assignment_entry = assignment_by_key.get((lesson.class_name, lesson.subject, lesson.teacher))
        if assignment_entry is None:
            return None
        assignment_index, _assignment = assignment_entry
        class_slot = (lesson.class_name, day, part, period)
        teacher_slot = (lesson.teacher, day, part, period)
        class_slots.add(class_slot)
        teacher_slots.add(teacher_slot)
        lesson_by_class_slot[class_slot] = lesson
        if lesson.room:
            room_slots.add((lesson.room, day, part, period))
        assignment_session_load[(assignment_index, day, part)] += 1
        class_subject_session_load[(lesson.class_name, lesson.subject, day, part)] += 1
        class_session_load[(lesson.class_name, day, part)] += 1
        teacher_session_load[(lesson.teacher, day, part)] += 1
        teacher_session_periods[(lesson.teacher, day, part)].add(period)

    session_by_key = {(item.day, item.part): item for item in all_sessions()}
    candidate_cache: dict[int, tuple[tuple[int, str, int], ...]] = {}
    for assignment_index in remaining:
        assignment = data.assignments[assignment_index]
        slots: list[tuple[int, str, int]] = []
        for session in all_sessions():
            if not _assignment_session_allowed(assignment, session, constraints):
                continue
            for period in _assignment_available_periods(assignment, session, constraints):
                slots.append((int(session.day), str(session.part), int(period)))
        candidate_cache[assignment_index] = tuple(sorted(set(slots)))

    added: list[Lesson] = []
    selected_slots: dict[int, list[tuple[int, str, int]]] = defaultdict(list)
    best_lessons: list[Lesson] | None = None
    best_metrics: dict[str, Any] | None = None
    best_quality: tuple[int, ...] | None = None
    nodes = 0
    solutions = 0
    started = time.monotonic()
    deadline = started + max(0.05, float(time_limit_seconds))

    def slot_candidates(assignment_index: int) -> list[tuple[int, str, int]]:
        assignment = data.assignments[assignment_index]
        last_slot = selected_slots[assignment_index][-1] if selected_slots[assignment_index] else None
        out: list[tuple[tuple[int, int, int, int, int, int, str], tuple[int, str, int]]] = []
        for day, part, period in candidate_cache.get(assignment_index, ()):
            slot = (day, part, period)
            if last_slot is not None and slot <= last_slot:
                continue
            class_slot = (assignment.class_name, day, part, period)
            teacher_slot = (assignment.teacher, day, part, period)
            if class_slot in class_slots or teacher_slot in teacher_slots:
                continue
            if assignment.room and (assignment.room, day, part, period) in room_slots:
                continue
            session = session_by_key.get((day, part))
            if session is None:
                continue
            class_cap = class_session_capacity_for_constraints(
                assignment.grade,
                assignment.class_name,
                session,
                constraints,
            )
            if class_session_load[(assignment.class_name, day, part)] >= class_cap:
                continue
            base_assignment_cap = min(
                int(assignment.max_periods_per_session),
                int(assignment.periods_per_week),
                class_cap,
                teacher_session_capacity(session),
            )
            assignment_cap = _assignment_session_cap(
                assignment,
                session,
                base_assignment_cap,
                constraints,
            )
            if assignment_session_load[(assignment_index, day, part)] >= assignment_cap:
                continue
            subject_cap = int(
                data.limits_by_grade_subject.get(
                    (assignment.grade, assignment.subject),
                    assignment.max_periods_per_session,
                )
            )
            if class_subject_session_load[(assignment.class_name, assignment.subject, day, part)] >= subject_cap:
                continue
            old_teacher_load = int(teacher_session_load[(assignment.teacher, day, part)])
            if old_teacher_load >= teacher_session_capacity(session):
                continue
            periods = set(teacher_session_periods.get((assignment.teacher, day, part), set()))
            periods.add(period)
            gap = max(periods) - min(periods) + 1 - len(periods)
            one_period_delta = -1 if old_teacher_load == 1 else (1 if old_teacher_load == 0 else 0)
            adjacent_same_assignment = any(
                (
                    (neighbor := lesson_by_class_slot.get((assignment.class_name, day, part, period + offset)))
                    is not None
                    and neighbor.subject == assignment.subject
                    and neighbor.teacher == assignment.teacher
                )
                for offset in (-1, 1)
            )
            score = (
                one_period_delta,
                1 if gap >= 2 else 0,
                1 if old_teacher_load == 0 else 0,
                gap,
                0 if adjacent_same_assignment else 1,
                day,
                part,
            )
            out.append((score, slot))
        out.sort(key=lambda item: (item[0], item[1]))
        return [slot for _score, slot in out]

    def apply_lesson(assignment_index: int, slot: tuple[int, str, int]) -> Lesson:
        assignment = data.assignments[assignment_index]
        day, part, period = slot
        lesson = Lesson(
            class_name=assignment.class_name,
            grade=assignment.grade,
            day=day,
            session=part,
            period=period,
            subject=assignment.subject,
            teacher=assignment.teacher,
            room=assignment.room,
        )
        class_slot = (assignment.class_name, day, part, period)
        class_slots.add(class_slot)
        teacher_slots.add((assignment.teacher, day, part, period))
        lesson_by_class_slot[class_slot] = lesson
        if assignment.room:
            room_slots.add((assignment.room, day, part, period))
        assignment_session_load[(assignment_index, day, part)] += 1
        class_subject_session_load[(assignment.class_name, assignment.subject, day, part)] += 1
        class_session_load[(assignment.class_name, day, part)] += 1
        teacher_session_load[(assignment.teacher, day, part)] += 1
        teacher_session_periods[(assignment.teacher, day, part)].add(period)
        selected_slots[assignment_index].append(slot)
        added.append(lesson)
        return lesson

    def undo_lesson(assignment_index: int, lesson: Lesson) -> None:
        day = int(lesson.day)
        part = str(lesson.session)
        period = int(lesson.period)
        class_slot = (lesson.class_name, day, part, period)
        class_slots.remove(class_slot)
        teacher_slots.remove((lesson.teacher, day, part, period))
        lesson_by_class_slot.pop(class_slot, None)
        if lesson.room:
            room_slots.remove((lesson.room, day, part, period))
        assignment_session_load[(assignment_index, day, part)] -= 1
        class_subject_session_load[(lesson.class_name, lesson.subject, day, part)] -= 1
        class_session_load[(lesson.class_name, day, part)] -= 1
        teacher_session_load[(lesson.teacher, day, part)] -= 1
        teacher_session_periods[(lesson.teacher, day, part)].remove(period)
        if not teacher_session_periods[(lesson.teacher, day, part)]:
            teacher_session_periods.pop((lesson.teacher, day, part), None)
        selected_slots[assignment_index].pop()
        added.pop()

    def search() -> None:
        nonlocal nodes, solutions, best_lessons, best_metrics, best_quality
        if nodes >= max(1, int(max_nodes)) or time.monotonic() >= deadline:
            return
        nodes += 1
        pending = [index for index, count in remaining.items() if count > 0]
        if not pending:
            candidate = [*incumbent_lessons, *added]
            metrics = compute_metrics(data, candidate, rules=rules)
            if not _complete_schedule_metrics_acceptable(metrics):
                return
            solutions += 1
            quality = _teacher_session_opt_quality(metrics, gap1_first=False)
            if best_quality is None or quality < best_quality:
                best_quality = quality
                best_lessons = list(candidate)
                best_metrics = metrics
            return

        candidate_rows: list[tuple[int, int, list[tuple[int, str, int]]]] = []
        for assignment_index in pending:
            slots = slot_candidates(assignment_index)
            if not slots:
                return
            candidate_rows.append((len(slots), assignment_index, slots))
        _count, assignment_index, slots = min(candidate_rows, key=lambda item: (item[0], item[1]))
        remaining[assignment_index] -= 1
        for slot in slots:
            lesson = apply_lesson(assignment_index, slot)
            search()
            undo_lesson(assignment_index, lesson)
            if nodes >= max(1, int(max_nodes)) or time.monotonic() >= deadline:
                break
        remaining[assignment_index] += 1

    search()
    if best_lessons is None or best_metrics is None:
        return None
    preserved = len(incumbent_lessons)
    meta = {
        "repair_kind": "bounded_soft_incumbent_residual_completion",
        "missing_periods": missing_total,
        "hinted_periods": len(incumbent_lessons),
        "preserved_hint_periods": preserved,
        "changed_hint_periods": 0,
        "search_nodes": nodes,
        "candidate_solutions": solutions,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "soft_hint": True,
        "hard_fixed": False,
    }
    return best_lessons, best_metrics, meta


def _polish_complete_incumbent_with_local_lns(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    bound_ctx: Any,
    incumbent_payload: Mapping[str, Any],
    *,
    rules: TimetableRuleSet | None,
    polish_seeds: list[int],
    time_limit_seconds: float,
    operator_learning: dict[str, Any] | None = None,
    gap1_cleanup_cap: int | None = None,
    protected_cleanup_budget: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    """Improve an incumbent with a bounded, round-adaptive ALNS portfolio."""

    budget = min(50.0, max(0.0, float(time_limit_seconds)))
    incumbent_metrics = (
        incumbent_payload.get("metrics")
        if isinstance(incumbent_payload.get("metrics"), Mapping)
        else {}
    )
    if budget < 0.5 or not _complete_payload_metrics_acceptable(incumbent_payload):
        return None

    report_rules = rules or bound_ctx.rules
    fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, bound_ctx)
    bound_ctx.warnings.extend(fixed_warnings)
    local_rules = (
        _rule_set_with_fixed_lesson_slots(report_rules, fixed_lessons)
        if fixed_lessons
        else report_rules
    )
    local_ctx = (
        _context_without_fixed_lesson_demand(bound_ctx, fixed_lessons)
        if fixed_lessons
        else bound_ctx
    )
    polished_lessons = _payload_lessons_to_lessons(incumbent_payload)
    if not polished_lessons:
        return None
    current_polished_metrics: Mapping[str, Any] = incumbent_metrics

    refinement_round = max(
        1,
        _to_int(settings.get("optimization_refinement_round"), 1),
    )
    expected_periods = sum(
        max(0, int(item.periods_per_week)) for item in bound_ctx.school_data.assignments
    )
    profile = _incremental_lns_profile(settings, refinement_round, expected_periods)
    max_passes = int(profile["passes"])
    pass_limit = float(profile["pass_seconds"])
    max_classes = int(profile["max_classes"])
    max_lessons = int(profile["max_lessons"])
    stop_after_quality_gain = _truthy_setting(
        settings.get("optimization_existing_local_quality_lns_early_accept", True)
    )
    stagnant_pass_limit = int(profile["stagnant_passes"])
    if protected_cleanup_budget:
        # The outer frontier search reserved this whole slice specifically for
        # gap repair. Do not let the generic two-miss ALNS plateau rule return
        # after only a few seconds; cheap failed neighborhoods should buy more
        # independent seeds, while the wall-clock budget remains authoritative.
        max_passes = max(max_passes, min(32, max(1, int(math.ceil(budget)))))
        stagnant_pass_limit = max_passes
    seeds = _school_refinement_seed_sequence(
        bound_ctx.school_data,
        refinement_round,
        max_passes,
        _refinement_request_seed(settings),
    )
    if not seeds:
        seeds = polish_seeds or _school_seed_sequence(bound_ctx.school_data, max_passes)
    learning = operator_learning
    if learning is None:
        learning = _refinement_learning_from_payload(incumbent_payload, bound_ctx.school_data)
    elif _to_int(learning.get("school_signature"), 0) != _refinement_school_signature(
        bound_ctx.school_data
    ):
        learning.clear()
        learning.update(_empty_refinement_learning(bound_ctx.school_data))
    started = time.monotonic()
    pass_meta: list[dict[str, Any]] = []
    improved = False
    consecutive_stagnant_passes = 0
    for pass_index in range(max_passes):
        remaining = budget - (time.monotonic() - started)
        if remaining < 0.5:
            break
        movable_lessons = _lessons_without_fixed_instances(polished_lessons, fixed_lessons)
        pass_started = time.monotonic()
        pass_seed = seeds[pass_index % len(seeds)] if seeds else None
        cleanup_gap1_needed = (
            gap1_cleanup_cap is not None
            and _teacher_session_opt_gap1(current_polished_metrics) > int(gap1_cleanup_cap)
        )
        cleanup_pass_gap1_cap: int | None = None
        if gap1_cleanup_cap is not None:
            visible_gap1_cap = max(0, int(gap1_cleanup_cap))
            current_gap1 = _teacher_session_opt_gap1(current_polished_metrics)
            # A small class cluster often cannot erase all frontier debt in one
            # solve. Accept two-gap internal steps; the outer Pareto guard still
            # withholds the frontier until it reaches the visible incumbent.
            cleanup_pass_gap1_cap = max(visible_gap1_cap, current_gap1 - 2)
        if cleanup_gap1_needed:
            operator = "gap1"
            operator_selection = {
                "score": 10.0,
                "priority": 10.0,
                "forced_frontier_gap_cleanup": True,
            }
        else:
            operator, operator_selection = _select_refinement_operator(
                learning,
                current_polished_metrics,
                refinement_round=refinement_round,
                pass_index=pass_index,
                random_seed=pass_seed,
            )
        targeted_operator = operator in {"one_period", "gap2", "gap1"}
        operator_max_classes = max(2, max_classes - 2) if targeted_operator else max_classes
        operator_max_lessons = (
            max(60, max_lessons - 80) if targeted_operator else max_lessons
        )
        seed_classes = _refinement_operator_seed_classes(
            polished_lessons,
            movable_lessons,
            operator,
            random_seed=pass_seed,
            max_classes=operator_max_classes,
        )
        before_pass_metrics = current_polished_metrics
        local_polish = _repair_one_period_affected_class_cluster(
            local_ctx.school_data,
            movable_lessons,
            local_rules,
            seed_classes=seed_classes,
            allow_gap1=True,
            time_limit_seconds=min(pass_limit, remaining),
            max_classes=operator_max_classes,
            max_lessons=operator_max_lessons,
            num_workers=_solver_worker_count(settings),
            optimize_teacher_quality=True,
            fixed_lessons=fixed_lessons,
            report_data=bound_ctx.school_data,
            report_rules=report_rules,
            random_seed=pass_seed,
            gap1_first=False,
            preserve_teacher_quality=True,
            max_gap1_sessions=(
                cleanup_pass_gap1_cap
                if gap1_cleanup_cap is not None
                else _incremental_refinement_gap1_cap(current_polished_metrics)
            ),
            stop_after_quality_gain=stop_after_quality_gain,
            known_current_metrics=current_polished_metrics,
        )
        pass_elapsed = time.monotonic() - pass_started
        reward = 0.0
        if local_polish is not None:
            reward = _refinement_quality_reward(before_pass_metrics, local_polish[1])
        _record_refinement_operator_attempt(
            learning,
            operator,
            refinement_round=refinement_round,
            elapsed_seconds=pass_elapsed,
            reward=reward,
        )
        item: dict[str, Any] = {
            "pass": pass_index + 1,
            "refinement_round": refinement_round,
            "random_seed": pass_seed,
            "neighborhood_strategy": "round_adaptive_alns",
            "alns_operator": operator,
            "operator_selection": operator_selection,
            "operator_reward": round(reward, 6),
            "seed_classes": seed_classes or [],
            "max_classes": operator_max_classes,
            "max_lessons": operator_max_lessons,
            "profile_tier": profile["tier"],
            "elapsed_seconds": round(pass_elapsed, 3),
            "improved": local_polish is not None,
        }
        if local_polish is not None:
            polished_lessons, _polished_metrics, polish_meta = local_polish
            current_polished_metrics = _polished_metrics
            item.update(polish_meta)
            improved = True
            consecutive_stagnant_passes = 0
        else:
            consecutive_stagnant_passes += 1
            item["consecutive_stagnant_passes"] = consecutive_stagnant_passes
            if consecutive_stagnant_passes >= stagnant_pass_limit:
                item["adaptive_stagnation_stop"] = True
        pass_meta.append(item)
        if consecutive_stagnant_passes >= stagnant_pass_limit:
            break

    if not improved:
        return None

    polished_solver = dict(incumbent_payload.get("solver") or {})
    polished_period_solver = dict(polished_solver.get("period_solver") or {})
    polished_period_solver["existing_teacher_quality_lns"] = pass_meta
    polished_solver["period_solver"] = polished_period_solver
    polished_runtime = dict(polished_solver.get("runtime_settings") or {})
    polished_runtime["refinement_learning"] = learning
    polished_runtime["incremental_lns_profile"] = profile
    polished_solver["runtime_settings"] = polished_runtime
    polished_solver["validation"] = compute_metrics(
        bound_ctx.school_data,
        polished_lessons,
        rules=report_rules,
    )
    polished_candidate = build_payload(
        bound_ctx,
        polished_lessons,
        polished_solver,
        report_rules,
    )
    polished_metrics = (
        polished_candidate.get("metrics")
        if isinstance(polished_candidate.get("metrics"), Mapping)
        else {}
    )
    if not _complete_payload_metrics_acceptable(polished_candidate):
        return None
    if not _incremental_refinement_candidate_better(polished_metrics, incumbent_metrics):
        return None
    return polished_candidate, pass_meta


def _payload_preserves_required_lessons(
    payload: Mapping[str, Any],
    required_lessons: list[Lesson],
) -> bool:
    """Return whether every explicitly fixed lesson survived in the payload."""

    if not required_lessons:
        return True
    candidate_counts = Counter(
        _lesson_identity(lesson) for lesson in _payload_lessons_to_lessons(payload)
    )
    required_counts = Counter(_lesson_identity(lesson) for lesson in required_lessons)
    return all(candidate_counts[key] >= count for key, count in required_counts.items())


def _unified_first_click_candidate_acceptable(
    payload: Mapping[str, Any],
    required_lessons: list[Lesson],
    *,
    allow_quality_debt: bool = False,
) -> bool:
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), Mapping) else {}
    return (
        _complete_payload_metrics_acceptable(payload)
        and (
            allow_quality_debt
            or (
                _metric_int(metrics, "one_period_teacher_sessions", 10**9) == 0
                and _teacher_session_opt_gap2_plus(metrics) == 0
            )
        )
        and _payload_preserves_required_lessons(payload, required_lessons)
    )


def _first_click_request_portfolio_seed(primary_seed: int | None, lane: int = 1) -> int:
    """Derive a distinct CP-SAT trajectory from this click's random seed."""

    normalized = normalize_cp_sat_seed(primary_seed) or 1
    rng = random.Random(normalized)
    candidate = normalized
    for _ in range(max(1, int(lane))):
        candidate = rng.randint(1, 2_147_483_646)
    if candidate == normalized:
        candidate = (candidate % 2_147_483_646) + 1
    return candidate


def _solve_unified_first_click_feasibility_then_quality(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    *,
    bound_ctx: UiDataContext,
    bounds: Mapping[str, int],
    profile: Mapping[str, Any],
    rules: TimetableRuleSet | None,
    progress: ProgressFn | None,
    deadline: SolverDeadline,
    polish_seeds: list[int],
    requested_random_seed: int | None,
) -> tuple[dict[str, Any], Mapping[str, Any], list[dict[str, Any]], str]:
    """Build a mandatory feasible incumbent, then spend leftover time on quality."""

    attempts: list[dict[str, Any]] = []
    lower_cap = max(1, int(bounds.get("lower_cap") or 1))
    upper_cap = max(lower_cap, int(bounds.get("upper_cap") or lower_cap))
    feasibility_cap = max(
        lower_cap,
        min(upper_cap, _complete_first_teacher_session_cap(bounds, profile)),
    )
    requested_quality_cap = (
        _positive_setting(settings, "target_teacher_sessions")
        or _positive_setting(settings, "optimization_accept_teacher_sessions")
    )
    large_first_click = _to_int(profile.get("expected"), 0) >= 900
    # Keep independent fresh clicks genuinely independent.  Earlier releases
    # defaulted this switch on for large schools and replaced the browser's
    # request seed with ``default_random_seed`` during Phase Q.  That made
    # every device converge to the same quality trajectory (the familiar
    # 521-session result), effectively behaving like a hidden hint.  A caller
    # may still opt into a reproducible diagnostic/retry explicitly.
    stabilize_large_quality_seed = (
        large_first_click
        and _truthy_setting(
            settings.get("optimization_first_click_stable_quality_seed", "0")
        )
    )
    first_click_quality_seed = normalize_cp_sat_seed(requested_random_seed) or 1
    if stabilize_large_quality_seed:
        # Browser fresh clicks intentionally carry a random seed so later
        # searches can explore different schedules.  On a large empty rebuild,
        # however, an unlucky first quality seed can yield a compact session
        # vector that the period allocator rejects after consuming almost the
        # whole 60-second click.  Retaining the 522-session feasibility draft
        # then looks like a successful but very poor first result.  Use one
        # stable, request-overridable seed only for Phase Q; feasibility and
        # local/refinement portfolios remain diverse.
        first_click_quality_seed = max(
            1,
            _to_int(
                settings.get("optimization_first_click_quality_random_seed"),
                _to_int(settings.get("default_random_seed"), 1),
            ),
        )
    # A blank/long automatic click may spend the remaining watchdog budget on
    # quality. Older releases silently capped this phase at three Benders
    # rounds, so a nominal 1,800-second click often returned after only a few
    # minutes. Explicit short repairs keep their existing bounded behavior.
    unbounded_quality_search = _truthy_setting(
        settings.get("optimization_unbounded_quality_search")
    )
    plain_first_click_lean_quality = _truthy_setting(
        settings.get("ui_plain_first_click_lean_quality")
    )
    continue_local_after_complete = (
        _truthy_setting(settings.get("optimization_first_click_continue_local_after_complete"))
        or plain_first_click_lean_quality
    )
    skip_global_quality = (
        _truthy_setting(settings.get("optimization_first_click_skip_global_quality"))
        and not plain_first_click_lean_quality
    )
    lean_global_quality = _truthy_setting(
        settings.get("optimization_first_click_lean_global_quality")
    )
    stop_after_first_complete = (
        _truthy_setting(settings.get("ui_stop_after_first_complete_schedule"))
        and not plain_first_click_lean_quality
        and not unbounded_quality_search
        and not continue_local_after_complete
    )
    if requested_quality_cap is not None:
        requested_quality_cap = max(lower_cap, min(upper_cap, requested_quality_cap))

    return_reserve = max(
        5.0,
        _to_float(settings.get("optimization_first_click_return_reserve_seconds"), 5.0),
        _to_float(settings.get("ui_unified_reference_watchdog_reserve_ms"), 0.0) / 1000.0,
    )
    report_rules = rules or bound_ctx.rules
    required_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, bound_ctx)
    bound_ctx.warnings.extend(fixed_warnings)
    required_lessons, released_warnings = _release_invalid_fixed_lessons(
        bound_ctx.school_data,
        required_lessons,
        report_rules,
        release_constraint_violations=False,
    )
    bound_ctx.warnings.extend(released_warnings)

    remaining = deadline.remaining()
    available_for_feasibility = max(
        0.0,
        (float(remaining) if remaining is not None else 60.0) - return_reserve,
    )
    requested_click_budget = max(
        _to_int(settings.get("overall_time_limit_seconds"), 0),
        _to_int(settings.get("ui_manual_fresh_retry_seconds"), 0),
        _to_int(settings.get("ui_custom_solve_duration_seconds"), 0),
    )
    configured_feasibility_budget = max(
        8,
        min(
            180,
            max(
                _to_int(settings.get("optimization_first_click_feasibility_time_limit_seconds"), 60),
                requested_click_budget,
            ),
        ),
    )
    feasibility_budget = min(float(configured_feasibility_budget), available_for_feasibility)
    if feasibility_budget < 8:
        raise RuntimeError("Global solver deadline exhausted before first-click feasibility phase")

    constraint_change_feasibility_first = any(
        _truthy_setting(settings.get(key))
        for key in (
            "ui_constraint_change_fresh_retry",
            "ui_constraint_change_rebuild_from_empty",
        )
    )
    bounded_fresh_quality_debt = _truthy_setting(
        settings.get("ui_bounded_fresh_accept_quality_debt")
    )
    # Zero singleton sessions and a maximum teacher gap of one period are
    # product quality goals, not user-authored hard constraints. Try them as a
    # strict first lane, but retain enough time for a complete hard-valid
    # fallback when fixed slots or another user requirement makes either goal
    # impossible. The fallback never relaxes application constraints.
    quality_debt_fallback_enabled = (
        constraint_change_feasibility_first or bounded_fresh_quality_debt
    )
    feasibility_quality_debt_allowed = False
    period_feasibility_bridge_required = (
        _constraints_need_period_feasibility_bridge(report_rules)
        and not _truthy_setting(settings.get("disable_period_feasibility_bridge"))
    )
    period_feasibility_all_sessions = (
        constraint_change_feasibility_first
        or period_feasibility_bridge_required
        or _truthy_setting(settings.get("optimization_benders_period_feasibility_all_sessions"))
        # The automatic large fresh contract needs one concrete, period-safe
        # incumbent before quality work begins even when the school has no
        # subject-period rows. This is also the atomic fallback if Phase Q is
        # inconclusive, so a failed quality vector can never blank the result.
        or (
            large_first_click
            and quality_debt_fallback_enabled
            and _truthy_setting(settings.get("ui_unified_first_click_quality"))
            and str(settings.get("ui_unified_solve_kind") or "").strip().casefold()
            == "fresh_complete_first"
        )
    )
    subject_period_requirements_completion_first = (
        _constraints_have_subject_period_requirements(report_rules)
    )
    # A subject block/period rule is authored by the user and therefore outranks
    # cosmetic teacher-quality goals. Build one complete hard-valid timetable
    # before trying to remove singleton sessions or wide teacher gaps.
    # Large period-sensitive schools need a first-result quality gate: no
    # avoidable one-period teacher session and no teacher gap of two or more.
    # Try that wider cap before compacting sessions.  If the first attempt
    # fails early, a second request-derived seed can use the remaining budget
    # without replaying one hidden template. A separately reserved
    # debt-allowed lane still guarantees that user rules which make the quality
    # gate impossible can return a complete timetable.
    strict_quality_gate_first = (
        large_first_click
        and period_feasibility_all_sessions
        and quality_debt_fallback_enabled
        # Subject-period rules remain hard, but combining their exact period
        # bridge with the zero-singleton/gap<=1 objective before any incumbent
        # exists is too expensive on production-size schools. It spent most of
        # the 180-second click proving UNKNOWN, then forced the completion
        # rescue to open a very wide session cap. Build the normal period-safe
        # complete incumbent first and let Phase Q use it as a soft warm start.
        and not subject_period_requirements_completion_first
        and not constraint_change_feasibility_first
        and (
            not plain_first_click_lean_quality
            and _truthy_setting(settings.get("optimization_first_click_strict_quality_gate", "0"))
        )
    )
    safe_period_feasibility_first = (
        period_feasibility_all_sessions
        and quality_debt_fallback_enabled
        and not strict_quality_gate_first
    )
    # On a large fixed-anchor school, use the all-session bridge first only to
    # obtain a complete incumbent.  The quality pass is much more effective
    # when it starts from that concrete timetable than when it spends the
    # whole click proving a tight 522-session cap from an empty model.
    wide_period_safe_first = (
        safe_period_feasibility_first
        and large_first_click
        and subject_period_requirements_completion_first
        and not constraint_change_feasibility_first
    )
    # The all-session period bridge is a substantially larger CP-SAT model.
    # Giving it the lean model's 24-second slice repeatedly returned UNKNOWN on
    # the six-worker VPS even though the same vector was feasible. The bridge
    # now materializes final periods itself, so the first click can spend 41
    # seconds finding that single usable vector instead of reserving time for a
    # duplicate period-allocation pass.
    quality_debt_fallback_reserve = 0.0
    if strict_quality_gate_first:
        configured_strict_gate_budget = _to_float(
            settings.get("optimization_first_click_strict_quality_gate_seconds"),
            105.0,
        )
        if requested_click_budget >= 150:
            # The bridge's historical 55-second value was tuned for the old
            # lightweight session model.  The current exact period bridge
            # needs about 90-95s to emit its first clean incumbent on default.
            # This is an internal phase split, not the user's duration input.
            configured_strict_gate_budget = max(105.0, configured_strict_gate_budget)
        quality_gate_completion_reserve = min(
            75.0,
            max(55.0, available_for_feasibility * 0.40),
        )
        primary_gate_budget = max(
            12.0,
            min(
                115.0,
                configured_strict_gate_budget,
                max(12.0, available_for_feasibility - quality_gate_completion_reserve),
            ),
        )
        quality_debt_fallback_reserve = max(
            0.0,
            available_for_feasibility - primary_gate_budget,
        )
    elif (
        quality_debt_fallback_enabled
        and not safe_period_feasibility_first
        and available_for_feasibility >= 20.0
    ):
        # A strict all-session period model can consume its whole slice on an
        # unlucky seed.  The old 10-20 second reserve then forced the relaxed
        # safety lane to rebuild the same 1,566-period model with too little
        # time, so an otherwise feasible first click returned no timetable.
        # Reserve enough time for one real hard-valid completion while keeping
        # a useful strict zero-singleton/gap<=1 probe first.
        quality_debt_fallback_reserve = min(
            45.0,
            max(28.0, available_for_feasibility * 0.50),
            max(0.0, available_for_feasibility - 8.0),
        )
    elif (
        wide_period_safe_first
        and available_for_feasibility >= 40.0
    ):
        # A wide objective-free incumbent normally appears in 15-25 seconds on
        # the default school. Reserve the rest of this bounded lane for the
        # same-click quality cleanup; if the wide solve is unlucky, that
        # reserve is still available to the existing completion fallback.
        first_complete_budget = min(
            50.0,
            max(35.0, available_for_feasibility * 0.30),
        )
        quality_debt_fallback_reserve = max(
            0.0,
            available_for_feasibility - first_complete_budget,
        )
    elif (
        quality_debt_fallback_enabled
        and safe_period_feasibility_first
        and large_first_click
        and available_for_feasibility >= 40.0
    ):
        # The period-safe lane is the completion guard for large schools with
        # authored subject-period rules. It used to consume the entire
        # watchdog, so a CP-SAT UNKNOWN left no time for a second, relaxed
        # completion attempt and the browser received HTTP 422 despite a
        # feasible timetable. Keep a real rescue slice for that case. The
        # first lane still gets enough time to find the normal cap-522 result;
        # the reserve is only spent when that lane fails.
        quality_debt_fallback_reserve = min(
            70.0,
            max(35.0, available_for_feasibility * 0.40),
            max(0.0, available_for_feasibility - 8.0),
        )
    strict_feasibility_budget = max(
        8.0,
        available_for_feasibility - quality_debt_fallback_reserve,
    )
    base_session_slice = 41 if period_feasibility_all_sessions else 24
    if strict_quality_gate_first:
        # Give the strict CP-SAT lane one uninterrupted search window.  The
        # previous 60s/72s/38s portfolio repeatedly restarted the same hard
        # model before it could emit its first zero-singleton incumbent.
        feasibility_session_slice = max(20, min(170, int(strict_feasibility_budget) - 4))
    else:
        feasibility_session_slice = max(
            10,
            min(
                60,
                base_session_slice + max(0, int(feasibility_budget) - 55) // 2,
                max(10, int(feasibility_budget) - 12),
            ),
        )
    feasibility_settings = dict(settings)
    for key in (
        "target_teacher_sessions",
        "target_gap1_sessions",
        "optimization_accept_teacher_sessions",
        "optimization_accept_gap1_sessions",
        "optimization_default_accept_gap1_sessions",
        "session_early_stop_teacher_sessions",
        "session_early_stop_max_one_period_sessions",
    ):
        feasibility_settings.pop(key, None)
    feasibility_settings.update(
        {
            "auto_sort_mode": "teacher_session_opt",
            "auto_sort_strategy": (
                "constraint_change_fresh_feasibility"
                if constraint_change_feasibility_first
                else "fresh_complete_first_feasibility"
            ),
            "max_teacher_sessions": feasibility_cap,
            "requested_max_teacher_sessions": feasibility_cap,
            "target_teacher_sessions": feasibility_cap,
            "optimization_accept_teacher_sessions": feasibility_cap,
            "max_one_period_sessions": 0,
            "strict_one_period_sessions_cap": True,
            "enforce_max_one_period_sessions": True,
            "one_period_priority_absolute": True,
            "allow_quality_debt": False,
            "optimization_continue_quality_search": False,
            "optimization_benders_complete_first": True,
            "optimization_benders_disable_session_early_stop": False,
            # The mandatory first phase needs one hard-valid timetable, not an
            # optimized proof.  Removing the objective lets CP-SAT return its
            # first feasible vector and leaves teacher quality to Phase Q/LNS.
            "optimization_benders_session_feasibility_only": not strict_quality_gate_first,
            "session_cp_sat_linearization_level": 1 if strict_quality_gate_first else 0,
            "optimization_benders_allow_one_period_debt": False,
            "optimization_benders_skip_relaxed_period_probe": True,
            # A constraint-change rebuild has no trustworthy flexible-period
            # incumbent. Period-sensitive hard rules need the same protection
            # on a first sort or after an earlier failed rebuild left only fixed
            # lessons. Model feasibility from the first session vector instead
            # of discovering one infeasible half-day per retry.
            "optimization_benders_period_feasibility_all_sessions": period_feasibility_all_sessions,
            "optimization_benders_lean_refinement_periods": (
                not period_feasibility_all_sessions
            ),
            "period_max_teacher_gap": 1,
            "relax_period_teacher_gap_on_failure": False,
            # A session allocation can satisfy every session-level constraint
            # and still make one period MILP infeasible.  Keep one bounded cut
            # retries in the mandatory feasibility lane so a random seed cannot
            # turn that recoverable case into a blank first-click result.
            "optimization_benders_iterations": 1 if strict_quality_gate_first else 5,
            "optimization_benders_session_time_limit": feasibility_session_slice,
            "period_time_limit": 15,
            "optimization_period_retry_time_limit": 15,
            "best_effort_on_timeout": False,
            "require_complete_schedule": True,
            "preserve_fixed_lessons_only": bool(required_lessons),
        }
    )
    phase_f_cap = feasibility_cap
    if safe_period_feasibility_first:
        # Keep the data-sized completion ceiling for this mandatory lane.  A
        # UI quality target plus its normal headroom can still be too tight for
        # an unlucky CP-SAT seed: on the 1,566-period default school, cap 501
        # completed for two seeds but timed out for a third, while the computed
        # feasibility ceiling 522 completed for all three.  Phase Q owns the
        # tighter quality target after this incumbent has been retained.
        phase_f_cap = feasibility_cap
        feasibility_settings.update(
            {
                "auto_sort_strategy": "fresh_complete_period_safe_feasibility",
                "max_teacher_sessions": phase_f_cap,
                "requested_max_teacher_sessions": phase_f_cap,
                "target_teacher_sessions": phase_f_cap,
                "optimization_accept_teacher_sessions": phase_f_cap,
                "max_one_period_sessions": "off",
                "strict_one_period_sessions_cap": False,
                "enforce_max_one_period_sessions": False,
                "one_period_priority_absolute": False,
                "allow_quality_debt": True,
                "optimization_benders_allow_one_period_debt": True,
                "optimization_benders_session_feasibility_only": True,
                "period_max_teacher_gap": "off",
                "relax_period_teacher_gap_on_failure": True,
            }
        )
    if wide_period_safe_first:
        # Do not spend the first-result lane on the compact cap.  A wide,
        # hard-valid schedule is only an incumbent; Phase Q below owns the
        # singleton/gap-2 gates and teacher-session compaction.
        phase_f_cap = upper_cap
        feasibility_settings.update(
            {
                "auto_sort_strategy": "fresh_complete_wide_period_safe",
                "max_teacher_sessions": phase_f_cap,
                "requested_max_teacher_sessions": phase_f_cap,
                "target_teacher_sessions": phase_f_cap,
                "optimization_accept_teacher_sessions": phase_f_cap,
                "max_one_period_sessions": "off",
                "strict_one_period_sessions_cap": False,
                "enforce_max_one_period_sessions": False,
                "one_period_priority_absolute": False,
                "allow_quality_debt": True,
                "optimization_benders_allow_one_period_debt": True,
                "optimization_benders_session_feasibility_only": True,
                "optimization_benders_iterations": 5,
                "optimization_benders_session_time_limit": max(
                    25,
                    min(45, int(strict_feasibility_budget) - 5),
                ),
                "period_max_teacher_gap": "off",
                "relax_period_teacher_gap_on_failure": True,
                "session_cp_sat_linearization_level": 0,
            }
        )
    if progress:
        progress(
            {
                "stage": "teacher_session_opt:first_click_feasibility",
                "message": "Dang tao lich day du va hop le",
                "cap": phase_f_cap,
                "time_limit_seconds": round(strict_feasibility_budget, 3),
                "quality_debt_allowed": safe_period_feasibility_first,
            }
        )
    phase_started = time.monotonic()
    feasibility_payload: dict[str, Any] = {}
    strict_error: Exception | None = None
    # A fresh click must keep the caller's trajectory. A global rescue seed
    # made independent devices converge to the same timetable even though no
    # lesson hint was present. Diagnostics can still request an explicit seed
    # through optimization_first_click_strict_quality_random_seed.
    default_first_click_seed = int(requested_random_seed or 1)
    feasibility_seed = max(
        1,
        _to_int(
            settings.get("optimization_first_click_feasibility_random_seed"),
            _to_int(
                settings.get("optimization_first_click_strict_quality_random_seed"),
                default_first_click_seed,
            ),
        ),
    )
    try:
        feasibility_payload = _solve_teacher_session_benders_candidate(
            ui_data,
            feasibility_settings,
            cap=phase_f_cap,
            time_limit_seconds=max(8, int(strict_feasibility_budget)),
            rules=rules,
            progress=progress,
            incumbent_payload=None,
            random_seed=feasibility_seed,
            deadline=deadline,
        )
    except Exception as exc:  # noqa: BLE001 - a hard-valid fallback still has to run.
        strict_error = exc
    feasibility_summary = _teacher_session_opt_summarize_attempt(
        cap=phase_f_cap,
        elapsed_seconds=time.monotonic() - phase_started,
        payload=feasibility_payload or None,
        error=strict_error,
    )
    feasibility_summary.update(
        {
            "phase": "fresh_complete_first_feasibility",
            "attempt_key": (
                "fresh:phase_f:period_safe_complete"
                if safe_period_feasibility_first
                else "fresh:phase_f:strict_quality"
            ),
            "mandatory_fallback": True,
            "fixed_lessons_required": len(required_lessons),
            "constraint_change_feasibility_first": constraint_change_feasibility_first,
            "bounded_fresh_quality_debt": bounded_fresh_quality_debt,
            "period_feasibility_bridge_required": period_feasibility_bridge_required,
            "period_feasibility_all_sessions": period_feasibility_all_sessions,
            "subject_period_requirements_completion_first": (
                subject_period_requirements_completion_first
            ),
            "quality_debt_allowed": safe_period_feasibility_first,
            "safe_period_feasibility_first": safe_period_feasibility_first,
            "strict_quality_gate_first": strict_quality_gate_first,
        }
    )
    strict_candidate_accepted = _unified_first_click_candidate_acceptable(
        feasibility_payload,
        required_lessons,
        allow_quality_debt=safe_period_feasibility_first,
    )
    quality_debt_safety_payload: dict[str, Any] = {}
    if (
        not strict_candidate_accepted
        and _unified_first_click_candidate_acceptable(
            feasibility_payload,
            required_lessons,
            allow_quality_debt=True,
        )
    ):
        quality_debt_safety_payload = feasibility_payload
        feasibility_summary["quality_debt_safety_retained"] = True
    feasibility_summary.update(
        {"accepted": strict_candidate_accepted, "new_best": strict_candidate_accepted}
    )
    attempts.append(feasibility_summary)
    if strict_candidate_accepted and safe_period_feasibility_first:
        feasibility_quality_debt_allowed = True

    if (
        not strict_candidate_accepted
        and strict_quality_gate_first
        # A short server watchdog cannot afford two full all-session CP-SAT
        # builds before its objective-free completion rescue. Subject-period
        # rules are hard, so reserve the remaining budget for one wide,
        # debt-allowed schedule instead of gambling it on a second cosmetic
        # zero-singleton/gap trajectory. Longer clicks keep the diverse retry.
        and not (
            subject_period_requirements_completion_first
            and available_for_feasibility < 100.0
        )
        # A long strict lane has already had enough time to converge. Restarting
        # the same exact model for another short seed only steals the completion
        # reserve; go directly to the wide debt-allowed safety solve instead.
        and strict_feasibility_budget < 90.0
    ):
        remaining = deadline.remaining()
        retry_available = max(
            0.0,
            (float(remaining) if remaining is not None else 0.0) - return_reserve,
        )
        # Preserve a real completion slice after an early alternate strict
        # seed. Production measurements put the objective-free completion lane
        # near 42 seconds, so the automatic 110-second contract keeps 45
        # seconds untouched. A late strict failure can legitimately skip this
        # retry when its reserved slice would be too short.
        retry_completion_reserve = min(
            45.0,
            max(20.0, available_for_feasibility * 0.43),
        )
        retry_budget = min(25.0, max(0.0, retry_available - retry_completion_reserve))
        if retry_budget >= 12.0:
            retry_seed = _first_click_request_portfolio_seed(feasibility_seed, 1)
            if progress:
                progress(
                    {
                        "stage": "teacher_session_opt:first_click_quality_gate_retry",
                        "message": "Dang thu quy dao sach thu hai",
                        "cap": phase_f_cap,
                        "time_limit_seconds": round(retry_budget, 3),
                        "random_seed": retry_seed,
                    }
                )
            retry_started = time.monotonic()
            retry_payload: dict[str, Any] = {}
            retry_error: Exception | None = None
            try:
                retry_payload = _solve_teacher_session_benders_candidate(
                    ui_data,
                    feasibility_settings,
                    cap=phase_f_cap,
                    time_limit_seconds=max(12, int(retry_budget)),
                    rules=rules,
                    progress=progress,
                    incumbent_payload=None,
                    random_seed=retry_seed,
                    deadline=deadline,
                )
            except Exception as exc:  # noqa: BLE001 - the debt-allowed lane remains reserved.
                retry_error = exc
            retry_accepted = _unified_first_click_candidate_acceptable(
                retry_payload,
                required_lessons,
                allow_quality_debt=False,
            )
            retry_summary = _teacher_session_opt_summarize_attempt(
                cap=phase_f_cap,
                elapsed_seconds=time.monotonic() - retry_started,
                payload=retry_payload or None,
                error=retry_error,
            )
            retry_summary.update(
                {
                    "phase": "fresh_complete_first_strict_quality_retry",
                    "attempt_key": "fresh:phase_f:strict_quality_retry",
                    "mandatory_fallback": True,
                    "fixed_lessons_required": len(required_lessons),
                    "constraint_change_feasibility_first": constraint_change_feasibility_first,
                    "bounded_fresh_quality_debt": bounded_fresh_quality_debt,
                    "period_feasibility_bridge_required": period_feasibility_bridge_required,
                    "period_feasibility_all_sessions": period_feasibility_all_sessions,
                    "quality_debt_allowed": False,
                    "safe_period_feasibility_first": False,
                    "strict_quality_gate_first": True,
                    "random_seed": retry_seed,
                    "accepted": retry_accepted,
                    "new_best": retry_accepted,
                }
            )
            attempts.append(retry_summary)
            if retry_accepted:
                feasibility_payload = retry_payload
                strict_candidate_accepted = True
            elif _unified_first_click_candidate_acceptable(
                retry_payload,
                required_lessons,
                allow_quality_debt=True,
            ):
                safety_metrics = (
                    quality_debt_safety_payload.get("metrics")
                    if isinstance(quality_debt_safety_payload.get("metrics"), Mapping)
                    else {}
                )
                retry_metrics = (
                    retry_payload.get("metrics")
                    if isinstance(retry_payload.get("metrics"), Mapping)
                    else {}
                )
                if not quality_debt_safety_payload or _incremental_refinement_candidate_better(
                    retry_metrics,
                    safety_metrics,
                ):
                    quality_debt_safety_payload = retry_payload
                retry_summary["quality_debt_safety_retained"] = True

    if not strict_candidate_accepted and quality_debt_fallback_enabled:
        remaining = deadline.remaining()
        fallback_budget = max(
            0.0,
            (float(remaining) if remaining is not None else 0.0) - return_reserve,
        )
        if fallback_budget >= 8.0:
            fallback_settings = dict(feasibility_settings)
            # Keep the same data-sized feasibility ceiling on the normal
            # multi-worker path. Raising straight to the theoretical upper
            # bound makes a rescue timetable needlessly ugly. A one/two-worker
            # machine has too little time to prove that tighter cap after the
            # strict probe, so its safety lane favors completion explicitly.
            fallback_cap = (
                upper_cap
                if (
                    (large_first_click and period_feasibility_all_sessions)
                    or safe_period_feasibility_first
                    or _solver_worker_count(fallback_settings) <= 2
                )
                else feasibility_cap
            )
            fallback_settings.update(
                {
                    "auto_sort_strategy": (
                        "constraint_change_quality_debt_fallback"
                        if constraint_change_feasibility_first
                        else "fresh_complete_quality_debt_fallback"
                    ),
                    "max_one_period_sessions": "off",
                    "strict_one_period_sessions_cap": False,
                    "enforce_max_one_period_sessions": False,
                    "one_period_priority_absolute": False,
                    "allow_quality_debt": True,
                    "optimization_benders_allow_one_period_debt": True,
                    # A normal strict-first retry can spend its remaining time
                    # on a cleaner relaxed result. If the safe period lane
                    # itself failed, keep the retry objective-free as well so
                    # completion remains the only priority.
                    "optimization_benders_session_feasibility_only": (
                        safe_period_feasibility_first or strict_quality_gate_first
                    ),
                    # The rescue has no optimization objective. Linearization
                    # level zero materially reduces presolve/model overhead on
                    # the 1,566-period default school and leaves more of a
                    # short VPS watchdog for primal discovery.
                    "session_cp_sat_linearization_level": (
                        0
                        if safe_period_feasibility_first or strict_quality_gate_first
                        else feasibility_settings.get(
                            "session_cp_sat_linearization_level",
                            1,
                        )
                    ),
                    "period_max_teacher_gap": "off",
                    "relax_period_teacher_gap_on_failure": True,
                    # Teacher-session count is also a quality objective.  The
                    # mandatory safety lane must not reject a complete schedule
                    # merely because it needs more sessions than the preferred
                    # first-click cap under tight user constraints.
                    "max_teacher_sessions": fallback_cap,
                    "requested_max_teacher_sessions": fallback_cap,
                    "target_teacher_sessions": fallback_cap,
                    "optimization_accept_teacher_sessions": fallback_cap,
                    "optimization_benders_session_time_limit": max(
                        10,
                        min(41, int(fallback_budget) - 4),
                    ),
                }
            )
            if progress:
                progress(
                    {
                        "stage": "teacher_session_opt:first_click_quality_debt_fallback",
                        "message": "Dang giu dung yeu cau va hoan tat lich",
                        "cap": fallback_cap,
                        "time_limit_seconds": round(fallback_budget, 3),
                    }
                )
            fallback_started = time.monotonic()
            fallback_payload: dict[str, Any] = {}
            fallback_error: Exception | None = None
            try:
                fallback_payload = _solve_teacher_session_benders_candidate(
                    ui_data,
                    fallback_settings,
                    cap=fallback_cap,
                    time_limit_seconds=max(8, int(fallback_budget)),
                    rules=rules,
                    progress=progress,
                    incumbent_payload=None,
                    random_seed=_first_click_request_portfolio_seed(feasibility_seed, 2),
                    deadline=deadline,
                )
            except Exception as exc:  # noqa: BLE001 - normalized into the final solve error below.
                fallback_error = exc
            fallback_accepted = _unified_first_click_candidate_acceptable(
                fallback_payload,
                required_lessons,
                allow_quality_debt=True,
            )
            fallback_summary = _teacher_session_opt_summarize_attempt(
                cap=fallback_cap,
                elapsed_seconds=time.monotonic() - fallback_started,
                payload=fallback_payload or None,
                error=fallback_error,
            )
            fallback_summary.update(
                {
                    "phase": "fresh_complete_first_quality_debt_fallback",
                    "attempt_key": "fresh:phase_f:quality_debt_fallback",
                    "mandatory_fallback": True,
                    "fixed_lessons_required": len(required_lessons),
                    "constraint_change_feasibility_first": constraint_change_feasibility_first,
                    "bounded_fresh_quality_debt": bounded_fresh_quality_debt,
                    "period_feasibility_bridge_required": period_feasibility_bridge_required,
                    "period_feasibility_all_sessions": period_feasibility_all_sessions,
                    "quality_debt_allowed": True,
                    "accepted": fallback_accepted,
                    "new_best": fallback_accepted,
                }
            )
            attempts.append(fallback_summary)
            if fallback_accepted:
                feasibility_payload = fallback_payload
                feasibility_settings = fallback_settings
                feasibility_quality_debt_allowed = True

    if (
        not strict_candidate_accepted
        and not feasibility_quality_debt_allowed
        and quality_debt_safety_payload
    ):
        feasibility_payload = quality_debt_safety_payload
        feasibility_quality_debt_allowed = True
        attempts.append(
            {
                "ok": True,
                "phase": "fresh_complete_first_quality_debt_safety",
                "attempt_key": "fresh:phase_f:quality_debt_safety",
                "accepted": True,
                "new_best": False,
                "quality_debt_allowed": True,
                "incumbent_retained": True,
                "reason": "complete_hard_valid_candidate_survived_failed_cleanup",
            }
        )

    if not _unified_first_click_candidate_acceptable(
        feasibility_payload,
        required_lessons,
        allow_quality_debt=feasibility_quality_debt_allowed,
    ):
        error = RuntimeError(
            "Constraint-change feasibility phase did not produce a complete hard-valid timetable before deadline"
            if constraint_change_feasibility_first
            else "First-click feasibility phase did not produce a complete hard-valid timetable before deadline"
        )
        error.attempts = attempts
        raise error

    best_payload = feasibility_payload
    best_metrics = (
        feasibility_payload.get("metrics")
        if isinstance(feasibility_payload.get("metrics"), Mapping)
        else {}
    )
    durable_learning = (
        ui_data.get("tkbRefinementLearning")
        if isinstance(ui_data.get("tkbRefinementLearning"), Mapping)
        else None
    )
    refinement_learning = _merge_refinement_learning(
        bound_ctx.school_data,
        durable_learning,
        feasibility_payload,
    )
    termination_reason = "first_click_feasibility_retained"
    requested_local_budget = max(
        0.0,
        _to_float(
            settings.get("optimization_first_click_local_lns_time_limit_seconds"),
            16.0,
        ),
    )

    quality_minimum = max(
        12,
        min(
            35,
            _to_int(settings.get("optimization_first_click_quality_minimum_seconds"), 30),
        ),
    )
    remaining = deadline.remaining()
    feasibility_sessions = _metric_int(best_metrics, "teacher_sessions", 10**9)
    quality_cleanup_required = (
        (
            subject_period_requirements_completion_first
            or (
                large_first_click
                and _truthy_setting(settings.get("ui_unified_first_click_quality"))
                and str(settings.get("ui_unified_solve_kind") or "").strip().casefold()
                == "fresh_complete_first"
            )
        )
        and (
            _metric_int(best_metrics, "one_period_teacher_sessions", 0) > 0
            or _teacher_session_opt_gap2_plus(best_metrics) > 0
        )
    )
    strict_period_quality_cleanup = (
        subject_period_requirements_completion_first
        or _truthy_setting(settings.get("ui_quality_debt_fresh_rebuild"))
    )
    # The real automatic first click on a large school must validate concrete
    # periods while it removes singleton/gap-2 debt. Keep lean Phase Q only for
    # explicit or diagnostic callers that do not carry this UI contract.
    automatic_large_fresh_quality = (
        large_first_click
        and _truthy_setting(settings.get("ui_unified_first_click_quality"))
        and str(settings.get("ui_unified_solve_kind") or "").strip().casefold()
        == "fresh_complete_first"
    )
    quality_period_bridge_required = (
        strict_period_quality_cleanup
        or not lean_global_quality
        or automatic_large_fresh_quality
    )
    short_subject_period_completion_rescue = (
        subject_period_requirements_completion_first
        and available_for_feasibility < 100.0
        and feasibility_quality_debt_allowed
        and not strict_candidate_accepted
    )
    local_tail_eligible = (
        requested_local_budget >= 0.5
        and _complete_payload_metrics_acceptable(best_payload)
        and not short_subject_period_completion_rescue
        and (
            _teacher_session_opt_quality_gates_clean(best_metrics)
            or quality_cleanup_required
        )
    )
    # Phase Q is exact but may legitimately finish UNKNOWN.  Once a complete
    # incumbent exists, protect a small final slice for the independent local
    # portfolio instead of allowing one CP-SAT call to consume the entire
    # watchdog.  This reserve never reduces the mandatory Phase-F completion
    # budget and never extends the caller's deadline.
    protected_local_tail = (
        min(
            16.0,
            requested_local_budget,
            max(
                0.0,
                float(remaining or 0.0) - return_reserve - float(quality_minimum),
            ),
        )
        if local_tail_eligible
        else 0.0
    )
    can_start_quality = (
        # Once the short-watchdog completion rescue has produced a hard-valid
        # timetable, return it while the VPS still has serialization margin.
        # Starting another exact all-session cleanup here used to cross the
        # server watchdog and discard the already-complete incumbent. A later
        # explicit click owns the quality pass.
        not short_subject_period_completion_rescue
        and (quality_cleanup_required or not stop_after_first_complete)
        and (quality_cleanup_required or not skip_global_quality)
        and (quality_cleanup_required or requested_quality_cap is not None)
        and (
            quality_cleanup_required
            or (
                requested_quality_cap < feasibility_cap
                and requested_quality_cap < feasibility_sessions
            )
        )
        and remaining is not None
        and remaining >= quality_minimum + return_reserve + protected_local_tail
    )
    if can_start_quality:
        quality_headroom = max(
            0,
            min(
                64,
                _to_int(settings.get("optimization_first_click_quality_cap_headroom"), 18),
            ),
        )
        if quality_cleanup_required:
            # First remove singleton and gap-2 debt without also demanding a
            # large session-count reduction.  A relaxed completion rescue may
            # legitimately need more sessions than ``feasibility_cap``; using
            # that tighter cap here made the cleanup model solve both problems
            # at once and frequently return UNKNOWN.  The next explicit click
            # owns deeper session/gap-1 compaction.
            quality_cap = max(1, min(feasibility_sessions, upper_cap))
            available_quality_budget = max(
                0,
                int(float(remaining) - return_reserve - protected_local_tail),
            )
            deep_quality_rebuild = (
                strict_period_quality_cleanup
                or unbounded_quality_search
            )
            # Subject-period rules make the all-session model materially
            # harder, but the complete incumbent is already retained. Spend
            # the remaining first-click budget driving singleton and gap-2
            # debt to zero instead of returning a known rough timetable after
            # a 35-second probe. Plain fresh sorts keep the bounded cleanup;
            # deliberate quality rebuilds also own the full remaining budget.
            quality_budget = (
                available_quality_budget
                if deep_quality_rebuild
                else min(
                    available_quality_budget,
                    max(
                        quality_minimum,
                        _to_int(
                            settings.get(
                                "optimization_first_click_quality_time_limit_seconds"
                            ),
                            45,
                        ),
                    ),
                )
            )
        else:
            quality_cap = max(
                int(requested_quality_cap),
                min(
                    upper_cap,
                    int(requested_quality_cap) + quality_headroom,
                    feasibility_cap - 1,
                    feasibility_sessions - 1,
                ),
            )
            quality_budget = min(
                max(
                    quality_minimum,
                    _to_int(settings.get("optimization_first_click_quality_time_limit_seconds"), 45),
                ),
                max(
                    0,
                    int(float(remaining) - return_reserve - protected_local_tail),
                ),
            )
        # Preserve the fast lean trajectory for seeds that already produce a
        # period-feasible compact timetable. On a large rebuild, stop that lean
        # lane after its first failed vector so it cannot consume the whole
        # quality budget; the exception path below can then run one independent
        # all-period CP-SAT rescue. This remains one server job/click.
        period_safe_quality_rescue_armed = (
            large_first_click
            and lean_global_quality
            and not quality_period_bridge_required
            and _truthy_setting(
                settings.get("optimization_first_click_period_safe_quality_rescue", "1")
            )
        )
        quality_random_seed = (
            _first_click_request_portfolio_seed(first_click_quality_seed, 1)
            if quality_cleanup_required
            else first_click_quality_seed
        )
        quality_settings = dict(feasibility_settings)
        # Keep the first strict-quality attempt deliberately conservative: it
        # is the handoff point from the mandatory complete incumbent. The
        # long/unbounded search is applied only to the subsequent tighter-cap
        # probe, where a timeout cannot displace that incumbent.
        quality_benders_iterations = (
            4
            if quality_cleanup_required
            else (1 if period_safe_quality_rescue_armed else 3)
        )
        if quality_cleanup_required:
            quality_session_limit = max(
                10,
                min(
                    160,
                    # The all-session bridge materializes concrete periods in
                    # this CP-SAT call, so it does not need the old 18-second
                    # external allocator reserve.  Leave only serialization
                    # margin and give the warm-start cleanup a real slice.
                    max(10, int(quality_budget) - 5),
                    _to_int(
                        settings.get(
                            "optimization_first_click_subject_period_quality_session_time_limit_seconds"
                        ),
                        min(72, max(10, int(quality_budget) - 5)),
                    ),
                ),
            )
            quality_period_limit = 20
            quality_retry_limit = 20
        else:
            quality_session_limit = max(
                10,
                min(
                    20 if period_safe_quality_rescue_armed else 40,
                    int(quality_budget) - 14,
                    _to_int(
                        settings.get("optimization_first_click_quality_session_time_limit_seconds"),
                        40,
                    ),
                ),
            )
            quality_period_limit = 15
            quality_retry_limit = 15
        quality_solver_target = (
            int(requested_quality_cap or quality_cap)
            if (
            quality_cleanup_required
                or _truthy_setting(settings.get("optimization_first_click_quality_stop_at_cap"))
            )
            else int(requested_quality_cap)
        )
        quality_gap1_target = _nonnegative_setting(settings, "target_gap1_sessions")
        quality_gap1_accept = _nonnegative_setting(
            settings,
            "optimization_accept_gap1_sessions",
        )
        if quality_gap1_accept is None:
            quality_gap1_accept = quality_gap1_target
        # The automatic large fresh contract must validate concrete periods in
        # the same CP-SAT model that removes singleton and gap-2 debt.  A lean
        # session-only Phase Q can find an attractive vector (for example 461
        # sessions on default) that the later period allocator rejects, leaving
        # the user with the wide Phase-F draft despite a long quality slice.
        # Keep lean Phase Q for explicit/diagnostic callers, but restore the
        # period-safe path for the real first-click request on a large school.
        quality_settings.update(
            {
                "auto_sort_strategy": "fresh_complete_first_strict_quality",
                "max_teacher_sessions": quality_cap,
                "requested_max_teacher_sessions": quality_cap,
                "target_teacher_sessions": int(quality_solver_target),
                "optimization_accept_teacher_sessions": int(
                    requested_quality_cap or quality_cap
                ),
                "optimization_benders_iterations": quality_benders_iterations,
                # Phase F already owns the complete hard-valid fallback. Once
                # Phase Q has a concrete incumbent, keep optimizing beyond the
                # first zero-singleton/gap<=1 vector instead of returning with
                # most of the 180-second click unused. The incumbent remains
                # the atomic fallback if this bounded quality search times out.
                "optimization_benders_complete_first": not quality_cleanup_required,
                "optimization_benders_disable_session_early_stop": quality_cleanup_required,
                "optimization_benders_stop_on_first_quality_gate_clean": bool(
                    stop_after_first_complete
                    and _truthy_setting(
                        settings.get(
                            "optimization_first_click_stop_on_first_quality_gate_clean",
                            "1",
                        )
                    )
                ),
                "optimization_benders_session_feasibility_only": False,
                # The hard zero-singleton cap below has a direct load >= 2*z
                # formulation. Do not also create one Boolean objective var
                # per teacher/session for a value already fixed to zero.
                "optimization_benders_minimize_one_period_sessions": False,
                "session_cp_sat_linearization_level": (
                    0 if quality_cleanup_required else 1
                ),
                "optimization_benders_period_feasibility_all_sessions": (
                    quality_period_bridge_required
                ),
                "optimization_benders_lean_refinement_periods": (
                    lean_global_quality and not quality_period_bridge_required
                ),
                # Use the complete schedule produced earlier in this same
                # click as a repair hint, but never add a distance objective.
                # It is not a bundled/template hint and no cell is fixed; it
                # merely gives CP-SAT a hard-valid neighborhood from which to
                # eliminate singleton and gap-2 debt quickly.
                "optimization_benders_minimize_hint_distance": (
                    False if quality_cleanup_required else True
                ),
                "optimization_benders_period_bridge_promotion_cut_count": (
                    1 if lean_global_quality else 2
                ),
                "_fixed_only_empty_fallback_attempted": period_safe_quality_rescue_armed,
                "max_one_period_sessions": 0,
                "strict_one_period_sessions_cap": True,
                "enforce_max_one_period_sessions": True,
                "one_period_priority_absolute": True,
                "allow_quality_debt": False,
                "optimization_benders_allow_one_period_debt": False,
                "optimization_continue_quality_search": quality_cleanup_required,
                "period_max_teacher_gap": 1,
                "relax_period_teacher_gap_on_failure": False,
                "optimization_benders_session_time_limit": quality_session_limit,
                "period_time_limit": quality_period_limit,
                "optimization_period_retry_time_limit": quality_retry_limit,
                "optimization_unbounded_quality_search": unbounded_quality_search,
                "optimization_stop_on_stagnation": True,
                "subject_period_strict_quality_cleanup": quality_cleanup_required,
                "quality_cleanup_required": quality_cleanup_required,
            }
        )
        if quality_cleanup_required and quality_gap1_target is not None:
            quality_settings["target_gap1_sessions"] = int(quality_gap1_target)
        if quality_cleanup_required and quality_gap1_accept is not None:
            quality_settings["optimization_accept_gap1_sessions"] = int(
                quality_gap1_accept
            )
        if progress:
            progress(
                {
                    "stage": "teacher_session_opt:first_click_quality",
                    "message": "Da co lich day du, dang ep chat luong buoi giao vien",
                    "cap": quality_cap,
                    "target": requested_quality_cap,
                    "time_limit_seconds": quality_budget,
                    "period_safe_rescue_armed": period_safe_quality_rescue_armed,
                    "subject_period_strict_quality_cleanup": quality_cleanup_required,
                    "quality_cleanup_required": quality_cleanup_required,
                }
            )
        quality_started = time.monotonic()
        try:
            quality_payload = _solve_teacher_session_benders_candidate(
                ui_data,
                quality_settings,
                cap=quality_cap,
                time_limit_seconds=max(8, int(quality_budget)),
                rules=rules,
                progress=progress,
                # The same-click complete incumbent is a soft repair hint. Its
                # distance objective is disabled above, so quality search can
                # move freely while avoiding a cold rebuild of every authored
                # subject-period constraint.
                incumbent_payload=best_payload,
                random_seed=quality_random_seed,
                deadline=deadline,
            )
            quality_summary = _teacher_session_opt_summarize_attempt(
                cap=quality_cap,
                elapsed_seconds=time.monotonic() - quality_started,
                payload=quality_payload,
            )
            quality_metrics = (
                quality_payload.get("metrics")
                if isinstance(quality_payload.get("metrics"), Mapping)
                else {}
            )
            quality_valid = (
                _unified_first_click_candidate_acceptable(quality_payload, required_lessons)
                and _metric_int(quality_metrics, "teacher_sessions", 10**9)
                <= quality_cap
            )
            quality_better = quality_valid and _session_priority_better(quality_metrics, best_metrics)
            quality_summary.update(
                {
                    "phase": "fresh_complete_first_strict_quality",
                    "attempt_key": "fresh:phase_q",
                    "quality_cap": quality_cap,
                    "quality_target": int(requested_quality_cap or quality_cap),
                    "fixed_lessons_required": len(required_lessons),
                    "soft_hint_used": True,
                    "single_attempt": True,
                    "random_seed": quality_random_seed,
                    "request_random_seed": first_click_quality_seed,
                    "period_safe_quality_rescue_armed": period_safe_quality_rescue_armed,
                    "subject_period_strict_quality_cleanup": quality_cleanup_required,
                    "quality_cleanup_required": quality_cleanup_required,
                    "period_safe_quality_rescue": False,
                    "concrete_periods_materialized": bool(
                        quality_period_bridge_required
                    ),
                    "stable_large_quality_seed": stabilize_large_quality_seed,
                    "incumbent_retained": not quality_better,
                }
            )
            if quality_better:
                best_payload = quality_payload
                best_metrics = quality_metrics
                quality_summary.update({"accepted": True, "new_best": True})
                termination_reason = "first_click_strict_quality_improved"
            else:
                quality_summary["accepted"] = False
                quality_summary["reject_reason"] = (
                    "not_better_than_feasibility"
                    if quality_valid
                    else "incomplete_hard_invalid_fixed_loss_cap_or_one_period"
                )
                termination_reason = "first_click_feasibility_retained_after_quality_reject"
            attempts.append(quality_summary)
        except Exception as exc:  # noqa: BLE001 - phase F is the mandatory result.
            quality_summary = _teacher_session_opt_summarize_attempt(
                cap=quality_cap,
                elapsed_seconds=time.monotonic() - quality_started,
                error=exc,
            )
            quality_summary.update(
                {
                    "phase": "fresh_complete_first_strict_quality",
                    "attempt_key": "fresh:phase_q",
                    "quality_cap": quality_cap,
                    "quality_target": int(requested_quality_cap or quality_cap),
                    "single_attempt": True,
                    "random_seed": quality_random_seed,
                    "request_random_seed": first_click_quality_seed,
                    "period_safe_quality_rescue_armed": period_safe_quality_rescue_armed,
                    "subject_period_strict_quality_cleanup": quality_cleanup_required,
                    "period_safe_quality_rescue": False,
                    "concrete_periods_materialized": bool(
                        quality_period_bridge_required
                    ),
                    "stable_large_quality_seed": stabilize_large_quality_seed,
                    "incumbent_retained": True,
                    "fixed_lessons_required": len(required_lessons),
                    "soft_hint_used": True,
                }
            )
            attempts.append(quality_summary)
            termination_reason = "first_click_feasibility_retained_after_quality_error"

            tight_rescue_succeeded = False
            integrated_remaining = deadline.remaining()
            integrated_available = max(
                0,
                int(float(integrated_remaining or 0.0) - return_reserve),
            )
            if period_safe_quality_rescue_armed and integrated_available >= 18:
                integrated_budget = min(26, integrated_available)
                integrated_seed = _first_click_request_portfolio_seed(
                    first_click_quality_seed,
                    1,
                )
                integrated_settings = dict(quality_settings)
                integrated_settings.update(
                    {
                        "auto_sort_strategy": "fresh_complete_first_period_safe_quality_rescue",
                        "optimization_benders_iterations": 1,
                        "optimization_benders_session_feasibility_only": True,
                        "session_cp_sat_linearization_level": 0,
                        "optimization_benders_period_feasibility_all_sessions": True,
                        "optimization_benders_lean_refinement_periods": False,
                        "optimization_benders_period_bridge_promotion_cut_count": 1,
                        "_fixed_only_empty_fallback_attempted": True,
                        "optimization_benders_session_time_limit": max(
                            10,
                            min(20, int(integrated_budget) - 5),
                        ),
                    }
                )
                if progress:
                    progress(
                        {
                            "stage": "teacher_session_opt:first_click_period_safe_rescue",
                            "message": "Dang thu quy dao xep tiet tich hop",
                            "cap": int(quality_cap),
                            "time_limit_seconds": int(integrated_budget),
                        }
                    )
                integrated_started = time.monotonic()
                try:
                    integrated_payload = _solve_teacher_session_benders_candidate(
                        ui_data,
                        integrated_settings,
                        cap=int(quality_cap),
                        time_limit_seconds=max(8, int(integrated_budget)),
                        rules=rules,
                        progress=progress,
                        incumbent_payload=None,
                        random_seed=integrated_seed,
                        deadline=deadline,
                    )
                    integrated_metrics = (
                        integrated_payload.get("metrics")
                        if isinstance(integrated_payload.get("metrics"), Mapping)
                        else {}
                    )
                    integrated_valid = (
                        _unified_first_click_candidate_acceptable(
                            integrated_payload,
                            required_lessons,
                        )
                        and _metric_int(integrated_metrics, "teacher_sessions", 10**9)
                        <= int(quality_cap)
                    )
                    integrated_better = integrated_valid and _session_priority_better(
                        integrated_metrics,
                        best_metrics,
                    )
                    integrated_summary = _teacher_session_opt_summarize_attempt(
                        cap=int(quality_cap),
                        elapsed_seconds=time.monotonic() - integrated_started,
                        payload=integrated_payload,
                    )
                    integrated_summary.update(
                        {
                            "phase": "fresh_complete_first_period_safe_quality_rescue",
                            "attempt_key": "fresh:phase_q:period_safe",
                            "quality_cap": int(quality_cap),
                            "quality_target": int(requested_quality_cap or quality_cap),
                            "random_seed": integrated_seed,
                            "request_random_seed": first_click_quality_seed,
                            "soft_hint_used": False,
                            "period_safe_quality_rescue": True,
                            "concrete_periods_materialized": True,
                            "accepted": bool(integrated_better),
                            "incumbent_retained": not integrated_better,
                        }
                    )
                    if integrated_better:
                        best_payload = integrated_payload
                        best_metrics = integrated_metrics
                        integrated_summary["new_best"] = True
                        tight_rescue_succeeded = True
                        termination_reason = "first_click_period_safe_quality_rescue_improved"
                    else:
                        integrated_summary["reject_reason"] = (
                            "not_better_than_feasibility"
                            if integrated_valid
                            else "incomplete_hard_invalid_fixed_loss_cap_or_one_period"
                        )
                    attempts.append(integrated_summary)
                except Exception as integrated_exc:  # noqa: BLE001 - Phase F remains valid.
                    integrated_summary = _teacher_session_opt_summarize_attempt(
                        cap=int(quality_cap),
                        elapsed_seconds=time.monotonic() - integrated_started,
                        error=integrated_exc,
                    )
                    integrated_summary.update(
                        {
                            "phase": "fresh_complete_first_period_safe_quality_rescue",
                            "attempt_key": "fresh:phase_q:period_safe",
                            "quality_cap": int(quality_cap),
                            "quality_target": int(requested_quality_cap or quality_cap),
                            "random_seed": integrated_seed,
                            "request_random_seed": first_click_quality_seed,
                            "soft_hint_used": False,
                            "period_safe_quality_rescue": True,
                            "concrete_periods_materialized": True,
                            "incumbent_retained": True,
                        }
                    )
                    attempts.append(integrated_summary)

            # If the tight integrated rescue returns UNKNOWN early enough, use
            # the watchdog remainder for one looser but still meaningful cap.
            rescue_remaining = deadline.remaining()
            rescue_available = max(
                0,
                int(float(rescue_remaining or 0.0) - return_reserve),
            )
            rescue_cap_step = max(
                1,
                min(
                    64,
                    _to_int(
                        settings.get("optimization_first_click_period_safe_rescue_cap_step"),
                        18,
                    ),
                ),
            )
            relaxed_rescue_cap = min(
                feasibility_sessions - 1,
                upper_cap,
                quality_cap + rescue_cap_step,
            )
            can_run_relaxed_rescue = (
                period_safe_quality_rescue_armed
                and not tight_rescue_succeeded
                and rescue_available >= 12
                and relaxed_rescue_cap > quality_cap
                and relaxed_rescue_cap < feasibility_sessions
            )
            if can_run_relaxed_rescue:
                relaxed_rescue_budget = min(20, rescue_available)
                relaxed_rescue_seed = _first_click_request_portfolio_seed(
                    first_click_quality_seed,
                    2,
                )
                relaxed_rescue_settings = dict(quality_settings)
                relaxed_rescue_settings.update(
                    {
                        "auto_sort_strategy": "fresh_complete_first_period_safe_relaxed_cap_rescue",
                        "max_teacher_sessions": int(relaxed_rescue_cap),
                        "requested_max_teacher_sessions": int(relaxed_rescue_cap),
                        "target_teacher_sessions": int(relaxed_rescue_cap),
                        "optimization_benders_iterations": 1,
                        "optimization_benders_session_feasibility_only": True,
                        "session_cp_sat_linearization_level": 0,
                        "optimization_benders_period_feasibility_all_sessions": True,
                        "optimization_benders_lean_refinement_periods": False,
                        "_fixed_only_empty_fallback_attempted": True,
                        "optimization_benders_session_time_limit": max(
                            10,
                            min(15, int(relaxed_rescue_budget) - 4),
                        ),
                    }
                )
                if progress:
                    progress(
                        {
                            "stage": "teacher_session_opt:first_click_period_safe_rescue",
                            "message": "Dang thu quy dao xep tiet du phong",
                            "cap": int(relaxed_rescue_cap),
                            "time_limit_seconds": int(relaxed_rescue_budget),
                        }
                    )
                relaxed_started = time.monotonic()
                try:
                    relaxed_payload = _solve_teacher_session_benders_candidate(
                        ui_data,
                        relaxed_rescue_settings,
                        cap=int(relaxed_rescue_cap),
                        time_limit_seconds=max(8, int(relaxed_rescue_budget)),
                        rules=rules,
                        progress=progress,
                        incumbent_payload=None,
                        random_seed=relaxed_rescue_seed,
                        deadline=deadline,
                    )
                    relaxed_metrics = (
                        relaxed_payload.get("metrics")
                        if isinstance(relaxed_payload.get("metrics"), Mapping)
                        else {}
                    )
                    relaxed_valid = (
                        _unified_first_click_candidate_acceptable(
                            relaxed_payload,
                            required_lessons,
                        )
                        and _metric_int(relaxed_metrics, "teacher_sessions", 10**9)
                        <= int(relaxed_rescue_cap)
                    )
                    relaxed_better = relaxed_valid and _session_priority_better(
                        relaxed_metrics,
                        best_metrics,
                    )
                    relaxed_summary = _teacher_session_opt_summarize_attempt(
                        cap=int(relaxed_rescue_cap),
                        elapsed_seconds=time.monotonic() - relaxed_started,
                        payload=relaxed_payload,
                    )
                    relaxed_summary.update(
                        {
                            "phase": "fresh_complete_first_period_safe_relaxed_cap_rescue",
                            "attempt_key": "fresh:phase_q:period_safe_relaxed_cap",
                            "quality_cap": int(relaxed_rescue_cap),
                            "quality_target": int(requested_quality_cap or quality_cap),
                            "random_seed": relaxed_rescue_seed,
                            "request_random_seed": first_click_quality_seed,
                            "soft_hint_used": False,
                            "concrete_periods_materialized": True,
                            "accepted": bool(relaxed_better),
                            "incumbent_retained": not relaxed_better,
                        }
                    )
                    if relaxed_better:
                        best_payload = relaxed_payload
                        best_metrics = relaxed_metrics
                        relaxed_summary["new_best"] = True
                        termination_reason = "first_click_period_safe_relaxed_cap_improved"
                    else:
                        relaxed_summary["reject_reason"] = (
                            "not_better_than_feasibility"
                            if relaxed_valid
                            else "incomplete_hard_invalid_fixed_loss_cap_or_one_period"
                        )
                    attempts.append(relaxed_summary)
                except Exception as rescue_exc:  # noqa: BLE001 - Phase F remains valid.
                    relaxed_summary = _teacher_session_opt_summarize_attempt(
                        cap=int(relaxed_rescue_cap),
                        elapsed_seconds=time.monotonic() - relaxed_started,
                        error=rescue_exc,
                    )
                    relaxed_summary.update(
                        {
                            "phase": "fresh_complete_first_period_safe_relaxed_cap_rescue",
                            "attempt_key": "fresh:phase_q:period_safe_relaxed_cap",
                            "quality_cap": int(relaxed_rescue_cap),
                            "quality_target": int(requested_quality_cap or quality_cap),
                            "random_seed": relaxed_rescue_seed,
                            "request_random_seed": first_click_quality_seed,
                            "soft_hint_used": False,
                            "concrete_periods_materialized": True,
                            "incumbent_retained": True,
                        }
                    )
                    attempts.append(relaxed_summary)

        best_sessions_after_quality = _metric_int(best_metrics, "teacher_sessions", 10**9)
        target_probe_local_reserve = max(
            0.0,
            _to_float(settings.get("optimization_first_click_local_lns_time_limit_seconds"), 15.0),
        )
        remaining = deadline.remaining()
        target_probe_available = max(
            0,
            int(float(remaining or 0.0) - return_reserve - target_probe_local_reserve),
        )
        target_probe_configured = max(
            30,
            _to_int(settings.get("optimization_first_click_target_probe_time_limit_seconds"), 60),
        )
        target_probe_convergence_ceiling = max(
            30,
            min(
                300,
                _to_int(
                    settings.get(
                        "optimization_first_click_target_probe_convergence_ceiling_seconds"
                    ),
                    120,
                ),
            ),
        )
        target_probe_budget = min(
            target_probe_available,
            (
                target_probe_convergence_ceiling
                if unbounded_quality_search
                else target_probe_configured
            ),
        )
        target_probe_step = max(
            1,
            min(
                64,
                _to_int(settings.get("optimization_first_click_target_probe_step"), 16),
            ),
        )
        if unbounded_quality_search:
            # Continue from the incumbent actually found, not from the looser
            # phase-Q ceiling. This lets a long run test the next meaningful
            # cap (for example 481 -> 479) instead of spending its whole budget
            # proving the already-nearby 480 cap.
            target_probe_cap = max(
                int(requested_quality_cap or 1),
                best_sessions_after_quality - target_probe_step,
            )
        else:
            target_probe_cap = max(
                int(requested_quality_cap or 1),
                quality_cap - target_probe_step,
                best_sessions_after_quality - target_probe_step,
            )
        can_probe_tighter_cap = (
            not quality_cleanup_required
            and _truthy_setting(
                settings.get("optimization_first_click_target_probe_enabled", "1")
            )
            and termination_reason == "first_click_strict_quality_improved"
            and requested_quality_cap is not None
            and target_probe_cap < best_sessions_after_quality
            and best_sessions_after_quality < feasibility_sessions
            and target_probe_budget >= 30
        )
        if can_probe_tighter_cap:
            target_probe_settings = dict(quality_settings)
            if unbounded_quality_search:
                target_probe_iterations = max(
                    32,
                    min(1024, int(math.ceil(float(target_probe_budget) * 2.0))),
                )
                target_probe_session_limit = max(
                    30,
                    min(60, int(max(30.0, float(target_probe_budget) / 3.0))),
                )
                target_probe_period_limit = max(
                    15,
                    min(45, int(max(15.0, float(target_probe_budget) / 6.0))),
                )
                target_probe_retry_limit = max(
                    15,
                    min(30, target_probe_period_limit),
                )
            else:
                target_probe_iterations = max(
                    3,
                    min(6, int(target_probe_budget // 45)),
                )
                target_probe_session_limit = quality_settings.get(
                    "optimization_benders_session_time_limit",
                    40,
                )
                target_probe_period_limit = quality_settings.get("period_time_limit", 15)
                target_probe_retry_limit = quality_settings.get(
                    "optimization_period_retry_time_limit",
                    15,
                )
            target_probe_settings.update(
                {
                    "auto_sort_strategy": "fresh_complete_first_tighter_cap_probe",
                    "max_teacher_sessions": int(target_probe_cap),
                    "requested_max_teacher_sessions": int(target_probe_cap),
                    "target_teacher_sessions": int(requested_quality_cap),
                    "optimization_accept_teacher_sessions": int(requested_quality_cap),
                    # The incumbent remains the only accepted fallback when
                    # the tighter cap is infeasible. Long automatic runs use
                    # the whole remaining budget here as well.
                    "optimization_benders_iterations": target_probe_iterations,
                    "optimization_benders_session_time_limit": target_probe_session_limit,
                    "period_time_limit": target_probe_period_limit,
                    "optimization_period_retry_time_limit": target_probe_retry_limit,
                    "optimization_benders_disable_session_early_stop": unbounded_quality_search,
                    "optimization_continue_quality_search": unbounded_quality_search,
                    "optimization_unbounded_quality_search": unbounded_quality_search,
                    # Long searches may use the full budget while improving,
                    # but two consecutive non-improving Benders attempts are
                    # a convergence signal. The valid incumbent is retained.
                    "optimization_stop_on_stagnation": True,
                    "optimization_benders_accept_stagnant_iterations": 2,
                }
            )
            if progress:
                progress(
                    {
                        "stage": "teacher_session_opt:first_click_tighter_cap_probe",
                        "message": "Da co lich tot, dang thu giam them buoi giao vien",
                        "cap": int(target_probe_cap),
                        "target": int(requested_quality_cap),
                        "time_limit_seconds": int(target_probe_budget),
                    }
                )
            target_probe_started = time.monotonic()
            try:
                target_probe_payload = _solve_teacher_session_benders_candidate(
                    ui_data,
                    target_probe_settings,
                    cap=int(target_probe_cap),
                    time_limit_seconds=max(8, int(target_probe_budget)),
                    rules=rules,
                    progress=progress,
                    incumbent_payload=best_payload,
                    # Reuse the seed that already proved feasible at the
                    # adjacent quality cap.  Switching to an unrelated seed
                    # here made the tight probe spend its whole budget before
                    # finding a first session vector.
                    random_seed=first_click_quality_seed,
                    deadline=deadline,
                )
                target_probe_summary = _teacher_session_opt_summarize_attempt(
                    cap=int(target_probe_cap),
                    elapsed_seconds=time.monotonic() - target_probe_started,
                    payload=target_probe_payload,
                )
                target_probe_metrics = (
                    target_probe_payload.get("metrics")
                    if isinstance(target_probe_payload.get("metrics"), Mapping)
                    else {}
                )
                target_probe_valid = (
                    _unified_first_click_candidate_acceptable(target_probe_payload, required_lessons)
                    and _metric_int(target_probe_metrics, "teacher_sessions", 10**9)
                    <= int(target_probe_cap)
                )
                target_probe_better = target_probe_valid and _session_priority_better(
                    target_probe_metrics,
                    best_metrics,
                )
                target_probe_summary.update(
                    {
                        "phase": "fresh_complete_first_tighter_cap_probe",
                        "attempt_key": "fresh:phase_q_target",
                        "quality_cap": int(target_probe_cap),
                        "quality_target": int(requested_quality_cap or quality_cap),
                        "fixed_lessons_required": len(required_lessons),
                        "soft_hint_used": True,
                        "incumbent_retained": not target_probe_better,
                        "accepted": bool(target_probe_better),
                    }
                )
                if target_probe_better:
                    best_payload = target_probe_payload
                    best_metrics = target_probe_metrics
                    target_probe_summary["new_best"] = True
                    termination_reason = "first_click_tighter_cap_improved"
                else:
                    target_probe_summary["reject_reason"] = (
                        "not_better_than_quality_incumbent"
                        if target_probe_valid
                        else "incomplete_hard_invalid_fixed_loss_cap_or_quality_gate"
                    )
                attempts.append(target_probe_summary)
            except Exception as exc:  # noqa: BLE001 - retain the proven phase-Q result.
                target_probe_summary = _teacher_session_opt_summarize_attempt(
                    cap=int(target_probe_cap),
                    elapsed_seconds=time.monotonic() - target_probe_started,
                    error=exc,
                )
                target_probe_summary.update(
                    {
                        "phase": "fresh_complete_first_tighter_cap_probe",
                        "attempt_key": "fresh:phase_q_target",
                        "quality_cap": int(target_probe_cap),
                        "quality_target": int(requested_quality_cap or quality_cap),
                        "fixed_lessons_required": len(required_lessons),
                        "soft_hint_used": True,
                        "incumbent_retained": True,
                    }
                )
                attempts.append(target_probe_summary)
    else:
        attempts.append(
            {
                "ok": True,
                "phase": "fresh_complete_first_strict_quality",
                "attempt_key": "fresh:phase_q",
                "skipped": True,
                "single_attempt": True,
                "incumbent_retained": True,
                "reason": (
                    "short_watchdog_completion_rescue_returned"
                    if short_subject_period_completion_rescue
                    else (
                        "bounded_local_polish_preferred"
                        if skip_global_quality
                        else (
                            "no_stricter_requested_cap"
                            if requested_quality_cap is None or requested_quality_cap >= feasibility_cap
                            else (
                                "feasibility_already_at_target"
                                if requested_quality_cap >= feasibility_sessions
                                else "watchdog_return_reserve"
                            )
                        )
                    )
                ),
                "remaining_seconds": round(float(remaining or 0.0), 3),
                "minimum_start_seconds": quality_minimum,
                "return_reserve_seconds": round(return_reserve, 3),
            }
        )

    clean_frontier_polish = (
        stop_after_first_complete
        and requested_local_budget >= 0.5
        and _truthy_setting(
            settings.get("optimization_first_click_clean_frontier_polish", "1")
        )
        and _teacher_session_opt_quality_gates_clean(best_metrics)
    )
    quality_debt_tail_polish = (
        stop_after_first_complete
        and requested_local_budget >= 0.5
        and _complete_payload_metrics_acceptable(best_payload)
        and (
            _metric_int(best_metrics, "one_period_teacher_sessions", 0) > 0
            or _teacher_session_opt_gap2_plus(best_metrics) > 0
        )
    )
    # ``ui_stop_after_first_complete_schedule`` protects the first usable
    # timetable, but it must not discard an explicitly reserved polish slice
    # after the incumbent is already complete and clean.  The local portfolio
    # is bounded by the same deadline and its acceptance guard below is
    # Pareto-safe, so a failed or worse neighborhood simply returns the exact
    # incumbent immediately.
    configured_local_budget = (
        0.0
        if (
            stop_after_first_complete
            and not clean_frontier_polish
            and not quality_debt_tail_polish
        )
        else min(
            180.0 if unbounded_quality_search else 50.0,
            requested_local_budget,
        )
    )
    remaining = deadline.remaining()
    local_budget = min(
        configured_local_budget,
        max(0.0, float(remaining or 0.0) - return_reserve),
    )
    local_started = time.monotonic()
    local_result = None
    local_error: Exception | None = None
    if local_budget >= 0.5:
        if progress:
            progress(
                {
                    "stage": "teacher_session_opt:first_complete_local_lns",
                    "message": "Dang toi uu nhanh tren lich day du tot nhat",
                    "time_limit_seconds": round(local_budget, 3),
                    "return_reserve_seconds": round(return_reserve, 3),
                }
            )
        try:
            local_result = _polish_complete_incumbent_with_local_lns(
                ui_data,
                settings,
                bound_ctx,
                best_payload,
                rules=rules,
                polish_seeds=polish_seeds,
                time_limit_seconds=local_budget,
                operator_learning=refinement_learning,
                gap1_cleanup_cap=_teacher_session_opt_gap1(best_metrics),
                protected_cleanup_budget=(
                    protected_local_tail >= 0.5
                    or clean_frontier_polish
                    or quality_debt_tail_polish
                ),
            )
        except Exception as exc:  # noqa: BLE001 - retain the global incumbent.
            local_error = exc

    local_summary: dict[str, Any] = {
        "ok": local_error is None,
        "phase": "fresh_complete_first_local_lns",
        "attempt_key": "fresh:first_complete_local_lns",
        "elapsed_seconds": round(time.monotonic() - local_started, 3),
        "time_limit_seconds": round(local_budget, 3),
        "return_reserve_seconds": round(return_reserve, 3),
        "incumbent_retained": True,
    }
    if local_result is not None:
        local_payload, local_passes = local_result
        local_metrics = (
            local_payload.get("metrics")
            if isinstance(local_payload.get("metrics"), Mapping)
            else {}
        )
        local_better = (
            _unified_first_click_candidate_acceptable(
                local_payload,
                required_lessons,
                allow_quality_debt=feasibility_quality_debt_allowed,
            )
            and _incremental_refinement_candidate_better(local_metrics, best_metrics)
        )
        if local_better:
            best_payload = local_payload
            best_metrics = local_metrics
            local_summary.update(
                {
                    "improved": True,
                    "incumbent_retained": False,
                    "teacher_quality_lns": local_passes,
                }
            )
            termination_reason = "first_click_local_lns_improved"
        else:
            local_summary.update(
                {
                    "improved": False,
                    "candidate_rejected_by_quality_envelope": True,
                }
            )
    elif local_error is not None:
        local_summary.update({"improved": False, "error": str(local_error)})
    elif local_budget < 0.5:
        local_summary.update(
            {
                "improved": False,
                "skipped": True,
                "reason": "watchdog_return_reserve",
            }
        )
    else:
        local_summary["improved"] = False
    _attach_refinement_learning(best_payload, refinement_learning)
    local_summary["clean_frontier_polish"] = clean_frontier_polish
    local_summary["quality_debt_tail_polish"] = quality_debt_tail_polish
    local_summary["protected_local_tail_seconds"] = round(protected_local_tail, 3)
    local_summary["refinement_learning_attempts"] = _to_int(
        refinement_learning.get("total_attempts"),
        0,
    )
    attempts.append(local_summary)
    return best_payload, best_metrics, attempts, termination_reason


def _solve_teacher_session_optimized_from_ui_data(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any],
    *,
    rules: TimetableRuleSet | None,
    progress: ProgressFn | None,
    out_dir: str | Path | None,
    deadline: SolverDeadline | None = None,
) -> dict[str, Any]:
    # A complete-incumbent continuation is an explicit quality-search click.
    # Its deadline is a ceiling: keep the Pareto-best candidate and stop after
    # bounded search saturation rather than waiting for a numeric threshold.
    settings = dict(settings)
    refinement_request = (
        _truthy_setting(settings.get("ui_use_existing_complete_incumbent"))
        and (
            str(settings.get("ui_unified_solve_kind") or "").strip().casefold()
            == "refine_complete"
            or str(settings.get("auto_sort_strategy") or "").strip().casefold()
            == "continue_teacher_quality_from_incumbent"
        )
    )
    if refinement_request:
        if "optimization_benders_lean_refinement_periods" not in settings:
            # Preserve the fast legacy default for plain/older clients, while
            # an explicit integrated-period request defaults to the exact
            # bridge. An explicit caller value always remains authoritative.
            settings["optimization_benders_lean_refinement_periods"] = not _truthy_setting(
                settings.get("optimization_refine_strict_integrated_period_bridge")
            )
        settings.update(
            {
                "optimization_continue_quality_search": True,
                "ui_stop_refinement_when_good_enough": False,
                "optimization_stop_on_stagnation": True,
                "optimization_benders_accept_stagnant_iterations": max(
                    2,
                    _to_int(settings.get("optimization_benders_accept_stagnant_iterations"), 0),
                ),
                # The incumbent is only a soft starting point.  Always enter
                # the global lower-cap portfolio as well; older clients sent
                # only the local-LNS flags and therefore stopped after a
                # superficially successful polish pass.
                "optimization_refine_try_lower_session_cap": True,
                # Keep the caller's period-bridge choice. Subject-period
                # requirements explicitly disable the lean session-only lane;
                # forcing it back on here creates attractive aggregate session
                # vectors that cannot be materialized into concrete periods.
                "optimization_existing_incumbent_gap_attempts": max(
                    4,
                    _to_int(settings.get("optimization_existing_incumbent_gap_attempts"), 0),
                ),
            }
        )
    bound_ctx = build_school_data_from_ui(ui_data)
    bounds = _teacher_session_adaptive_bounds(bound_ctx.school_data)
    tight_fixed_off_benders_profile = _fast_benders_tight_fixed_off_profile(
        ui_data,
        settings,
        rules=rules,
        bounds=bounds,
    )
    lower_cap = max(1, int(bounds.get("lower_cap") or 1))
    upper_cap = max(lower_cap, int(bounds.get("upper_cap") or lower_cap))
    target_teacher_sessions = _positive_setting(settings, "target_teacher_sessions")
    adaptive_teacher_session_opt = target_teacher_sessions is None
    target_gap1_sessions = _nonnegative_setting(settings, "target_gap1_sessions")
    balanced_quality_envelope = _teacher_quality_uses_balanced_envelope(settings)
    if refinement_request and balanced_quality_envelope and target_gap1_sessions is None:
        # Some complete-refinement clients omitted the zero-gap target after
        # selecting the balanced quality order. Restore it as a search signal
        # for the gap portfolio; the balanced marker still keeps session count
        # ahead of gap-1 in candidate ranking and the Pareto guard is unchanged.
        target_gap1_sessions = 0
        settings["target_gap1_sessions"] = 0
    if refinement_request and balanced_quality_envelope:
        settings["optimization_refinement_frontier_search"] = True
    quality_gap1_first = _teacher_quality_gap1_first(settings, target_gap1_sessions)
    continue_quality_search = _truthy_setting(settings.get("optimization_continue_quality_search"))
    accept_teacher_sessions = _positive_setting(settings, "optimization_accept_teacher_sessions")
    accept_gap1_sessions = _nonnegative_setting(settings, "optimization_accept_gap1_sessions")
    explicit_quality_goal = any(
        key in settings
        for key in (
            "target_teacher_sessions",
            "target_gap1_sessions",
            "optimization_accept_teacher_sessions",
            "optimization_accept_gap1_sessions",
        )
    )
    auto_sort_strategy = str(settings.get("auto_sort_strategy", "")).strip().casefold()
    requested_total_limit = _to_int(
        settings.get("optimization_time_limit_seconds"),
        _to_int(settings.get("overall_time_limit_seconds"), 300),
    )
    total_limit = max(30, requested_total_limit or 300)
    adaptive_total_ceiling = max(
        30,
        _to_int(settings.get("optimization_adaptive_time_limit_seconds"), 120),
    )
    if adaptive_teacher_session_opt:
        total_limit = min(total_limit, adaptive_total_ceiling)
    deadline = (deadline or SolverDeadline(None)).bounded(total_limit)
    legacy_targetless_opt = (
        not explicit_quality_goal
        and not adaptive_teacher_session_opt
        and target_teacher_sessions is None
        and target_gap1_sessions is None
        and 0 < total_limit <= 180
        and auto_sort_strategy not in {"fresh_teacher_session_opt", "teacher_session_opt"}
    )
    if accept_teacher_sessions is None and target_teacher_sessions is not None:
        accept_teacher_sessions = target_teacher_sessions
    if accept_gap1_sessions is None and target_gap1_sessions is not None:
        accept_gap1_sessions = target_gap1_sessions
    adaptive_accept_teacher_sessions = max(
        lower_cap,
        int(bounds.get("start_cap") or lower_cap) - 1,
    )
    if adaptive_teacher_session_opt and accept_teacher_sessions is None and adaptive_accept_teacher_sessions > 0:
        accept_teacher_sessions = adaptive_accept_teacher_sessions
    adaptive_gap_target_only = adaptive_teacher_session_opt and target_gap1_sessions is not None
    if adaptive_teacher_session_opt and not adaptive_gap_target_only:
        target_teacher_sessions = lower_cap
    if (
        target_gap1_sessions is None
        and (accept_gap1_sessions is None or accept_gap1_sessions <= 0)
    ):
        accept_gap1_sessions = max(0, _to_int(settings.get("optimization_default_accept_gap1_sessions"), 10))
    if (
        accept_teacher_sessions is None
        and target_teacher_sessions is None
        and 0 < total_limit <= 180
    ):
        accept_teacher_sessions = lower_cap
    if (
        accept_gap1_sessions is None
        and target_gap1_sessions is None
        and 0 < total_limit <= 180
    ):
        accept_gap1_sessions = 0
    if adaptive_teacher_session_opt:
        first_cap_limit = max(
            8,
            min(
                35,
                total_limit,
                _to_int(settings.get("optimization_first_cap_time_limit_seconds"), 35),
            ),
        )
        retry_cap_limit = max(
            8,
            min(25, _to_int(settings.get("optimization_retry_cap_time_limit_seconds"), 25)),
        )
        polish_cap_limit = max(
            8,
            min(20, _to_int(settings.get("optimization_polish_cap_time_limit_seconds"), 20)),
        )
    else:
        first_cap_limit = max(
            45,
            min(
                total_limit,
                _to_int(settings.get("optimization_first_cap_time_limit_seconds"), min(240, total_limit)),
            ),
        )
        retry_cap_limit = max(20, _to_int(settings.get("optimization_retry_cap_time_limit_seconds"), 60))
        polish_cap_limit = max(20, _to_int(settings.get("optimization_polish_cap_time_limit_seconds"), 45))
    frontier_cleanup_reserve = max(
        20,
        min(
            35,
            _to_int(settings.get("optimization_frontier_cleanup_reserve_seconds"), 30),
        ),
    )
    frontier_cleanup_tail = float(frontier_cleanup_reserve) + 2.0
    tight_gap_benders_portfolio = (
        adaptive_gap_target_only
        and isinstance(tight_fixed_off_benders_profile, Mapping)
        and _to_int(tight_fixed_off_benders_profile.get("expected"), 0) >= 900
    )
    if tight_gap_benders_portfolio:
        portfolio_reserve = max(
            8,
            min(20, _to_int(settings.get("optimization_tight_gap_followup_reserve_seconds"), 12)),
        )
        portfolio_limit = max(
            30,
            min(
                max(30, total_limit - portfolio_reserve),
                _to_int(settings.get("optimization_tight_gap_benders_time_limit_seconds"), 60),
            ),
        )
        first_cap_limit = max(first_cap_limit, portfolio_limit)
        retry_cap_limit = max(
            retry_cap_limit,
            min(total_limit, _to_int(settings.get("optimization_tight_gap_retry_time_limit_seconds"), 60)),
        )
    caps_queue = _teacher_session_opt_seed_caps(
        settings,
        bounds,
        target_teacher_sessions,
        adaptive=adaptive_teacher_session_opt,
    )
    if adaptive_gap_target_only and accept_teacher_sessions is not None:
        preferred_cap = max(lower_cap, min(upper_cap, int(accept_teacher_sessions)))
        caps_queue = [preferred_cap, *[cap for cap in caps_queue if int(cap) != preferred_cap]]
    polish_seeds = _school_seed_sequence(bound_ctx.school_data, 4)
    requested_random_seed = _positive_setting(settings, "random_seed")
    if refinement_request:
        requested_random_seed = _refinement_request_seed(settings) or requested_random_seed
    if requested_random_seed is not None:
        seed_rng = random.Random(requested_random_seed)
        polish_seeds = [requested_random_seed, *[seed_rng.randint(1, 2_147_483_647) for _ in range(3)]]
    polish_index = 0
    refinement_global_seed_index = 0
    consumed_refinement_seeds: set[int] = set()
    same_cap_polish_queue: list[tuple[int, int | None, str]] = []
    gap_priority_queue: list[tuple[int, int, str]] = []
    initial_gap_retry_queue: list[tuple[int, int, str]] = []
    relaxed_polish_offsets = [1, 2, 4]
    relaxed_polish_index = 0
    lower_cap_failed = False
    started = time.monotonic()
    last_improvement_at = started
    stagnant_attempts = 0
    adaptive_stagnant_default = 3 if target_gap1_sessions is not None else 2
    adaptive_stagnant_attempt_limit = max(
        1,
        min(4, _to_int(settings.get("optimization_adaptive_stagnant_attempts"), adaptive_stagnant_default)),
    )
    adaptive_stagnant_seconds = max(
        10,
        min(45, _to_int(settings.get("optimization_adaptive_stagnant_seconds"), 35)),
    )
    attempts: list[dict[str, Any]] = []
    best_payload: dict[str, Any] | None = None
    best_metrics: Mapping[str, Any] | None = None
    visible_best_payload: dict[str, Any] | None = None
    visible_best_metrics: Mapping[str, Any] | None = None
    refinement_frontier_enabled = refinement_request and balanced_quality_envelope
    feasibility_hint_payload: dict[str, Any] | None = None
    tried_attempts: set[tuple[int, str]] = set()
    portfolio_done = False
    termination_reason: str | None = None
    search_end_reason: str | None = None
    refinement_strategy_meta: dict[str, Any] | None = None
    strict_existing_quality_cleanup_pending = False
    strict_existing_quality_cleanup_seed_index = 0
    # A complete, revalidated timetable is already concrete-period feasible.
    # Refining it through the all-period CP-SAT bridge adds roughly 25k period
    # variables and can consume the whole 180-second click before reducing a
    # single teacher session.  Keep the proven hybrid refinement lane whenever
    # the browser explicitly selected lean refinement: CP-SAT compacts the
    # session vector, the period allocator materializes it, and the final hard
    # validator rejects any candidate that violates an authored period rule.
    # Fresh and constraint-change solves do not set the lean flag and continue
    # to use the integrated bridge for first-result reliability.
    strict_existing_quality_cleanup_requires_period_bridge = (
        _truthy_setting(settings.get("optimization_refine_strict_integrated_period_bridge"))
        and not _truthy_setting(settings.get("optimization_benders_lean_refinement_periods"))
    )

    existing_incumbent = _validated_existing_soft_incumbent_payload(
        ui_data,
        settings,
        rules=rules,
    )
    if existing_incumbent is not None:
        existing_metrics = (
            existing_incumbent.get("metrics")
            if isinstance(existing_incumbent.get("metrics"), Mapping)
            else {}
        )
        existing_sessions = _metric_int(existing_metrics, "teacher_sessions", upper_cap)
        feasibility_hint_payload = existing_incumbent
        existing_summary = _teacher_session_opt_summarize_attempt(
            cap=existing_sessions,
            elapsed_seconds=0.0,
            payload=existing_incumbent,
        )
        existing_summary.update(
            {
                "phase": "validated_existing_soft_incumbent",
                "attempt_key": "existing:validated",
                "soft_incumbent": True,
            }
        )
        if _complete_payload_metrics_acceptable(existing_incumbent):
            best_payload = existing_incumbent
            best_metrics = existing_metrics
            visible_best_payload = existing_incumbent
            visible_best_metrics = existing_metrics
            existing_summary["accepted"] = True
            existing_summary["new_best"] = True
            existing_summary["quality_debt_fallback"] = not _session_priority_metrics_acceptable(
                existing_metrics
            )
            last_improvement_at = time.monotonic()
            # A complete incumbent can already have the two hard quality gates
            # clean (zero singleton sessions and no gap >= 2) while still being
            # visibly loose: too many teacher sessions or too many one-period
            # gaps.  The ordinary refinement portfolio starts by probing a
            # tight cap and often spends the whole click proving that cap, then
            # returns this same incumbent.  Reserve one wide, all-period
            # Benders pass whenever the incumbent is above either practical
            # acceptance threshold.  The pass is Pareto-guarded below, so an
            # incumbent already at its thresholds is left alone.
            existing_needs_wide_quality_cleanup = (
                (
                    accept_teacher_sessions is not None
                    and existing_sessions > int(accept_teacher_sessions)
                )
                or (
                    accept_gap1_sessions is not None
                    and _teacher_session_opt_gap1(existing_metrics)
                    > int(accept_gap1_sessions)
                )
            )
            strict_existing_quality_cleanup_pending = (
                refinement_request
                and _to_int(bounds.get("expected_periods"), 0) >= 900
                and total_limit >= 90
                and existing_needs_wide_quality_cleanup
                and _truthy_setting(
                    settings.get("optimization_refine_strict_wide_cleanup", "1")
                )
            )
            existing_summary["strict_wide_cleanup_pending"] = bool(
                strict_existing_quality_cleanup_pending
            )
            if _session_priority_metrics_acceptable(existing_metrics):
                gap_priority_queue = _refinement_gap_priority_attempts(
                    existing_metrics,
                    target_gap1_sessions=target_gap1_sessions if adaptive_gap_target_only else None,
                    preferred_cap=accept_teacher_sessions if adaptive_gap_target_only else None,
                    accept_gap1_sessions=accept_gap1_sessions,
                    lower_cap=lower_cap,
                    upper_cap=upper_cap,
                    polish_seeds=polish_seeds,
                    session_first=refinement_frontier_enabled,
                )
                existing_gap_attempts = max(
                    1,
                    min(4, _to_int(settings.get("optimization_existing_incumbent_gap_attempts"), 3)),
                )
                gap_priority_queue = gap_priority_queue[:existing_gap_attempts]
                next_tight_cap = existing_sessions - 1
                caps_queue = [
                    *([next_tight_cap] if next_tight_cap >= lower_cap else []),
                    *[
                        cap
                        for cap in caps_queue
                        if int(cap) < existing_sessions and int(cap) != next_tight_cap
                    ],
                ]
            else:
                existing_summary["quality_cleanup_required"] = True
                # A large complete incumbent with singleton/gap-2 debt, or a
                # clean incumbent that still misses the practical session/gap1
                # thresholds, uses the same strict wide-cap pass before any
                # aggressive session cap.
        else:
            existing_summary["accepted"] = False
            existing_summary["hint_only"] = True
            existing_summary["reject_reason"] = "teacher_quality_requires_cleanup"
        attempts.append(existing_summary)

        unified_complete_refine = (
            _truthy_setting(settings.get("ui_unified_auto_sort"))
            and str(settings.get("ui_unified_solve_kind") or "").strip().casefold() == "refine_complete"
            and best_payload is not None
            and best_metrics is not None
            and _complete_payload_metrics_acceptable(best_payload)
        )
        stop_at_good_incumbent = (
            unified_complete_refine
            and not refinement_request
            and _truthy_setting(settings.get("ui_stop_refinement_when_good_enough"))
            and _teacher_session_opt_good_enough(
                best_metrics,
                accept_teacher_sessions=accept_teacher_sessions,
                accept_gap1_sessions=accept_gap1_sessions,
            )
        )
        if stop_at_good_incumbent:
            refinement_round = max(
                1,
                _to_int(settings.get("optimization_refinement_round"), 1),
            )
            durable_learning = (
                ui_data.get("tkbRefinementLearning")
                if isinstance(ui_data.get("tkbRefinementLearning"), Mapping)
                else None
            )
            refinement_learning = _merge_refinement_learning(
                bound_ctx.school_data,
                existing_incumbent,
                durable_learning,
            )
            refinement_strategy_meta = {
                "kind": "round_adaptive_alns",
                "round": refinement_round,
                "outcome": "good_enough_incumbent",
                "refinement_learning": refinement_learning,
                "terminal_for_refine_request": True,
            }
            attempts.append(
                {
                    "ok": True,
                    "phase": "existing_good_enough_early_stop",
                    "attempt_key": "existing:good_enough",
                    "skipped": True,
                    "retained_incumbent": True,
                    "refinement_round": refinement_round,
                    "accept_teacher_sessions": accept_teacher_sessions,
                    "accept_gap1_sessions": accept_gap1_sessions,
                }
            )
            termination_reason = "existing_good_enough_early_stop"
            search_end_reason = termination_reason
            portfolio_done = True
        if unified_complete_refine and not portfolio_done:
            refinement_round = max(
                1,
                _to_int(settings.get("optimization_refinement_round"), 1),
            )
            expected_periods = sum(
                max(0, int(item.periods_per_week))
                for item in bound_ctx.school_data.assignments
            )
            local_profile = _incremental_lns_profile(
                settings,
                refinement_round,
                expected_periods,
            )
            reserve_clean_global_gap_portfolio = (
                _truthy_setting(settings.get("optimization_refine_try_lower_session_cap"))
                and _teacher_session_opt_quality_gates_clean(best_metrics)
                and target_gap1_sessions is not None
                and _teacher_session_opt_gap1(best_metrics) > int(target_gap1_sessions)
            )
            reserve_strict_global_quality_cleanup = bool(
                strict_existing_quality_cleanup_pending
            )
            # A clean incumbent is already eligible for the proven same-cap
            # Benders gap portfolio. Spending 10-20 seconds on local LNS first
            # shortened the third global attempt and made the old 483 -> 468
            # refinement path unreliable. Dirty incumbents still use local LNS
            # to clear singleton/gap2 debt before entering the global search.
            configured_local_budget = (
                0.0
                if (
                    reserve_clean_global_gap_portfolio
                    or reserve_strict_global_quality_cleanup
                )
                else float(local_profile["budget_seconds"])
            )
            remaining_local_budget = max(
                0.0,
                min(50.0, float(total_limit) - (time.monotonic() - started) - 5.0),
            )
            deadline_remaining = deadline.remaining()
            if deadline_remaining is not None:
                remaining_local_budget = min(
                    remaining_local_budget,
                    max(0.0, deadline_remaining - 5.0),
                )
            local_budget = min(configured_local_budget, remaining_local_budget)
            local_pass_count = int(local_profile["passes"])
            local_seed_portfolio = _school_refinement_seed_sequence(
                bound_ctx.school_data,
                refinement_round,
                local_pass_count,
                requested_random_seed,
            )
            durable_learning = (
                ui_data.get("tkbRefinementLearning")
                if isinstance(ui_data.get("tkbRefinementLearning"), Mapping)
                else None
            )
            refinement_learning = _merge_refinement_learning(
                bound_ctx.school_data,
                existing_incumbent,
                durable_learning,
            )
            refinement_strategy_meta = {
                "kind": "round_adaptive_alns",
                "round": refinement_round,
                "seed_portfolio": local_seed_portfolio,
                "profile": local_profile,
                "refinement_learning": refinement_learning,
                "terminal_for_refine_request": True,
            }
            if local_budget >= 0.5:
                if progress:
                    progress(
                        {
                            "stage": "teacher_session_opt:existing_local_lns",
                            "message": "Dang toi uu nhanh cac cum lop con buoi va tiet trong",
                            "time_limit_seconds": round(local_budget, 3),
                            "refinement_round": refinement_round,
                        }
                    )
                local_started = time.monotonic()
                local_error: Exception | None = None
                try:
                    local_result = _polish_complete_incumbent_with_local_lns(
                        ui_data,
                        settings,
                        bound_ctx,
                        best_payload,
                        rules=rules,
                        polish_seeds=polish_seeds,
                        time_limit_seconds=local_budget,
                        operator_learning=refinement_learning,
                    )
                except Exception as exc:  # noqa: BLE001 - the valid incumbent is the required fallback.
                    local_result = None
                    local_error = exc
                local_elapsed = time.monotonic() - local_started
                if local_result is not None:
                    local_candidate, local_passes = local_result
                    local_metrics = (
                        local_candidate.get("metrics")
                        if isinstance(local_candidate.get("metrics"), Mapping)
                        else {}
                    )
                    local_candidate_is_better = (
                        _complete_payload_metrics_acceptable(local_candidate)
                        and _incremental_refinement_candidate_better(local_metrics, best_metrics)
                    )
                    if local_candidate_is_better:
                        best_payload = local_candidate
                        best_metrics = local_metrics
                        visible_best_payload = local_candidate
                        visible_best_metrics = local_metrics
                        feasibility_hint_payload = local_candidate
                        last_improvement_at = time.monotonic()
                        stagnant_attempts = 0
                        local_summary = _teacher_session_opt_summarize_attempt(
                            cap=_metric_int(local_metrics, "teacher_sessions", upper_cap),
                            elapsed_seconds=local_elapsed,
                            payload=local_candidate,
                        )
                        local_summary.update(
                            {
                                "phase": "existing_local_quality_lns",
                                "attempt_key": "existing:local_lns",
                                "accepted": True,
                                "new_best": True,
                                "refinement_round": refinement_round,
                                "seed_portfolio": local_seed_portfolio,
                                "teacher_quality_lns": local_passes,
                            }
                        )
                        attempts.append(local_summary)
                        termination_reason = "existing_local_quality_lns_improved"
                        refinement_strategy_meta["outcome"] = "improved"
                    else:
                        attempts.append(
                            {
                                "ok": True,
                                "phase": "existing_local_quality_lns",
                                "attempt_key": "existing:local_lns",
                                "elapsed_seconds": round(local_elapsed, 3),
                                "improved": False,
                                "candidate_rejected_by_quality_envelope": True,
                                "retained_incumbent": True,
                                "refinement_round": refinement_round,
                                "seed_portfolio": local_seed_portfolio,
                                "teacher_quality_lns": local_passes,
                            }
                        )
                        termination_reason = "existing_local_quality_lns_stagnant"
                        refinement_strategy_meta["outcome"] = "stagnant"
                else:
                    attempts.append(
                        {
                            "ok": local_error is None,
                            "phase": "existing_local_quality_lns",
                            "attempt_key": "existing:local_lns",
                            "elapsed_seconds": round(local_elapsed, 3),
                            "improved": False,
                            "retained_incumbent": True,
                            "refinement_round": refinement_round,
                            "seed_portfolio": local_seed_portfolio,
                            **({"error": str(local_error)} if local_error is not None else {}),
                        }
                    )
                    termination_reason = (
                        "existing_local_quality_lns_error_retained"
                        if local_error is not None
                        else "existing_local_quality_lns_stagnant"
                    )
                    refinement_strategy_meta["outcome"] = (
                        "error_retained" if local_error is not None else "stagnant"
                    )
            else:
                attempts.append(
                    {
                        "ok": True,
                        "phase": "existing_local_quality_lns",
                        "attempt_key": "existing:local_lns",
                        "skipped": True,
                        "reason": (
                            "strict_wide_quality_cleanup_reserved"
                            if reserve_strict_global_quality_cleanup
                            else (
                                "clean_incumbent_global_gap_portfolio_reserved"
                                if reserve_clean_global_gap_portfolio
                                else "local_budget_unavailable"
                            )
                        ),
                        "retained_incumbent": True,
                        "refinement_round": refinement_round,
                        "seed_portfolio": local_seed_portfolio,
                    }
                )
                termination_reason = "existing_local_quality_lns_budget_retained"
                refinement_strategy_meta["outcome"] = (
                    "strict_wide_quality_cleanup_reserved"
                    if reserve_strict_global_quality_cleanup
                    else (
                        "global_gap_portfolio_reserved"
                        if reserve_clean_global_gap_portfolio
                        else "budget_retained"
                    )
                )
            refinement_strategy_meta["clean_global_gap_portfolio_reserved"] = bool(
                reserve_clean_global_gap_portfolio
            )
            refinement_strategy_meta["strict_wide_quality_cleanup_reserved"] = bool(
                reserve_strict_global_quality_cleanup
            )
            refinement_strategy_meta["refinement_learning"] = refinement_learning
            remaining_cap_budget = max(0.0, float(total_limit) - (time.monotonic() - started))
            deadline_remaining = deadline.remaining()
            if deadline_remaining is not None:
                remaining_cap_budget = min(remaining_cap_budget, max(0.0, deadline_remaining))
            continue_with_tighter_cap = (
                _truthy_setting(settings.get("optimization_refine_try_lower_session_cap"))
                and best_metrics is not None
                # A complete incumbent with one-period or gap debt needs the
                # global cap portfolio most. The previous clean-only gate made
                # every later click stop after the short local LNS pass, so a
                # 521-session/27-singleton timetable could improve only one or
                # two cells per click and never reach the strict model again.
                # The incumbent remains the fallback and the balanced quality
                # envelope still rejects every regressing candidate.
                and _complete_payload_metrics_acceptable(best_payload)
                and _metric_int(best_metrics, "teacher_sessions", lower_cap) > lower_cap
                and remaining_cap_budget >= 30.0
            )
            refinement_strategy_meta["terminal_for_refine_request"] = not continue_with_tighter_cap
            refinement_strategy_meta["global_cap_search_remaining_seconds"] = round(
                remaining_cap_budget,
                3,
            )
            portfolio_done = not continue_with_tighter_cap
            if portfolio_done:
                search_end_reason = termination_reason
            else:
                refinement_strategy_meta["global_cap_search_started"] = True

    if progress and not portfolio_done:
        progress(
            {
                "stage": "teacher_session_opt:start",
                "message": "Dang sap xep TKB va giam buoi day",
                "adaptive": adaptive_teacher_session_opt,
                "target_teacher_sessions": target_teacher_sessions,
                "target_gap1_sessions": target_gap1_sessions,
                "time_limit_seconds": total_limit,
                "bounds": dict(bounds),
                "caps": caps_queue,
            }
        )

    direct_first_enabled = _truthy_setting(settings.get("optimization_direct_first", "0"))
    if direct_first_enabled and not portfolio_done:
        direct_cap = target_teacher_sessions or _positive_setting(settings, "optimization_start_teacher_sessions")
        if direct_cap is None:
            direct_cap = int(bounds.get("start_cap") or lower_cap)
        direct_cap = max(lower_cap, min(upper_cap, int(direct_cap)))
        if adaptive_teacher_session_opt:
            direct_limit = max(
                8,
                min(
                    35,
                    total_limit,
                    _to_int(settings.get("optimization_direct_first_time_limit_seconds"), first_cap_limit),
                ),
            )
        else:
            direct_limit = max(
                45,
                min(
                    total_limit,
                    _to_int(settings.get("optimization_direct_first_time_limit_seconds"), first_cap_limit),
                ),
            )
        direct_settings = _teacher_session_opt_attempt_settings(
            settings,
            cap=direct_cap,
            target_teacher_sessions=target_teacher_sessions,
            target_gap1_sessions=target_gap1_sessions,
            time_limit_seconds=direct_limit,
            lower_cap=lower_cap,
            random_seed=None,
        )
        direct_settings.update(
            {
                "disable_period_feasibility_bridge": True,
                "legacy_wednesday_pm_bridge": True,
                "optimization_direct_first": True,
                "integrated_time_limit": direct_limit,
                "period_retry_time_limit": max(
                    _to_int(direct_settings.get("period_retry_time_limit"), 0),
                    _to_int(direct_settings.get("period_time_limit"), 0),
                ),
            }
        )
        if progress:
            progress(
                {
                    "stage": "teacher_session_opt:direct_first",
                    "message": f"Thu nhanh duong cap {direct_cap} giong ban cu truoc khi fallback",
                    "cap": direct_cap,
                    "time_limit_seconds": direct_limit,
                }
            )
        direct_started = time.monotonic()
        try:
            direct_candidate = solve_from_ui_data(
                ui_data,
                direct_settings,
                rules=rules,
                progress=progress,
                out_dir=None,
                _deadline=deadline,
            )
            direct_summary = _teacher_session_opt_summarize_attempt(
                cap=direct_cap,
                elapsed_seconds=time.monotonic() - direct_started,
                payload=direct_candidate,
            )
            direct_summary["phase"] = "direct_first_legacy_bridge"
            direct_summary["attempt_key"] = "direct:first"
            direct_summary["legacy_wednesday_pm_bridge"] = True
            direct_summary["period_feasibility_bridge_disabled"] = True
            direct_metrics = (
                direct_candidate.get("metrics")
                if isinstance(direct_candidate.get("metrics"), Mapping)
                else {}
            )
            if (
                _complete_payload_metrics_acceptable(direct_candidate)
                and _metric_int(direct_metrics, "teacher_sessions", 10**9) <= direct_cap
            ):
                direct_summary["accepted"] = True
                best_payload = direct_candidate
                best_metrics = direct_metrics
                gap_priority_queue = _teacher_session_opt_gap_priority_attempts(
                    direct_metrics,
                    target_gap1_sessions=target_gap1_sessions if adaptive_gap_target_only else None,
                    preferred_cap=accept_teacher_sessions if adaptive_gap_target_only else None,
                    lower_cap=lower_cap,
                    upper_cap=upper_cap,
                    polish_seeds=polish_seeds,
                )
                last_improvement_at = time.monotonic()
                stagnant_attempts = 0
                direct_summary["new_best"] = True
                tried_attempts.add((direct_cap, "default"))
                best_sessions = _metric_int(direct_metrics, "teacher_sessions", upper_cap)
                next_tight_cap = best_sessions - 1
                if next_tight_cap >= lower_cap and (next_tight_cap, "default") not in tried_attempts:
                    caps_queue = [next_tight_cap, *[item for item in caps_queue if int(item) != next_tight_cap]]
                if accept_teacher_sessions is not None and not _teacher_session_opt_goal_satisfied(
                    direct_metrics,
                    target_teacher_sessions=target_teacher_sessions,
                    target_gap1_sessions=target_gap1_sessions,
                    accept_teacher_sessions=accept_teacher_sessions,
                    accept_gap1_sessions=accept_gap1_sessions,
                ):
                    keep_ceiling = max(best_sessions, accept_teacher_sessions)
                    caps_queue = [item for item in caps_queue if int(item) <= keep_ceiling]
                    if (accept_teacher_sessions, "default") not in tried_attempts:
                        caps_queue.append(accept_teacher_sessions)
                if not continue_quality_search and _teacher_session_opt_should_stop(
                    direct_metrics,
                    target_teacher_sessions=target_teacher_sessions,
                    target_gap1_sessions=target_gap1_sessions,
                    accept_teacher_sessions=accept_teacher_sessions,
                    accept_gap1_sessions=accept_gap1_sessions,
                ):
                    direct_summary["good_enough"] = True
                    attempts.append(direct_summary)
                    attempts.append(
                        {
                            "ok": True,
                            "skipped": True,
                            "reason": "direct_first_candidate_accepted",
                            "teacher_sessions": direct_metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": direct_metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": direct_metrics.get("gap_distribution"),
                            "accept_teacher_sessions": accept_teacher_sessions,
                            "accept_gap1_sessions": accept_gap1_sessions,
                        }
                    )
                    portfolio_done = True
                    termination_reason = (
                        "lower_bound_reached"
                        if _metric_int(direct_metrics, "teacher_sessions", upper_cap) <= lower_cap
                        else "target_reached"
                    )
                else:
                    attempts.append(direct_summary)
            else:
                direct_summary["accepted"] = False
                direct_summary["reject_reason"] = (
                    "teacher_sessions_above_attempt_cap"
                    if _complete_payload_metrics_acceptable(direct_candidate)
                    else "incomplete_or_best_effort"
                )
                attempts.append(direct_summary)
        except Exception as exc:  # noqa: BLE001 - fall back to the broader portfolio search.
            direct_summary = _teacher_session_opt_summarize_attempt(
                cap=direct_cap,
                elapsed_seconds=time.monotonic() - direct_started,
                error=exc,
            )
            direct_summary["phase"] = "direct_first_legacy_bridge"
            direct_summary["attempt_key"] = "direct:first"
            direct_summary["legacy_wednesday_pm_bridge"] = True
            direct_summary["period_feasibility_bridge_disabled"] = True
            attempts.append(direct_summary)

    skip_fast_quality_warmup = adaptive_teacher_session_opt and tight_fixed_off_benders_profile is not None
    unified_fresh_complete_request = (
        _truthy_setting(settings.get("ui_unified_first_click_quality"))
        and str(settings.get("ui_unified_solve_kind") or "").strip().casefold() == "fresh_complete_first"
    )
    unified_first_click_complete = (
        unified_fresh_complete_request
        and tight_fixed_off_benders_profile is not None
    )
    if unified_first_click_complete and best_payload is None and not portfolio_done:
        (
            best_payload,
            best_metrics,
            first_click_attempts,
            first_click_termination,
        ) = _solve_unified_first_click_feasibility_then_quality(
            ui_data,
            settings,
            bound_ctx=bound_ctx,
            bounds=bounds,
            profile=tight_fixed_off_benders_profile,
            rules=rules,
            progress=progress,
            deadline=deadline,
            polish_seeds=polish_seeds,
            requested_random_seed=requested_random_seed,
        )
        attempts.extend(first_click_attempts)
        feasibility_hint_payload = best_payload
        portfolio_done = True
        termination_reason = first_click_termination
        search_end_reason = first_click_termination
    if (
        best_payload is None
        and not portfolio_done
        and tight_gap_benders_portfolio
        and tight_fixed_off_benders_profile is not None
    ):
        direct_quality_incumbent = _truthy_setting(
            settings.get("optimization_direct_quality_benders_incumbent")
        )
        feasibility_cap = (
            int(accept_teacher_sessions or bounds.get("start_cap") or lower_cap)
            if direct_quality_incumbent
            else max(
                int(bounds.get("start_cap") or lower_cap) + 5,
                int(accept_teacher_sessions or lower_cap) + 32,
                _positive_setting(settings, "fast_quality_teacher_cap") or 0,
                _complete_first_teacher_session_cap(bounds, tight_fixed_off_benders_profile),
            )
        )
        feasibility_cap = max(lower_cap, min(upper_cap, feasibility_cap))
        minimum_feasibility_budget = 30 if total_limit <= 60 else 45
        feasibility_budget = max(
            minimum_feasibility_budget,
            min(
                total_limit,
                _to_int(
                    settings.get("optimization_tight_gap_feasibility_time_limit_seconds"),
                    (
                        30
                        if total_limit <= 60
                        else (135 if direct_quality_incumbent else 120)
                    ),
                ),
            ),
        )
        deadline_remaining = deadline.remaining()
        if deadline_remaining is not None:
            feasibility_budget = min(feasibility_budget, max(0, int(deadline_remaining)))
        feasibility_settings = dict(settings)
        feasibility_settings.update(
            {
                "auto_sort_mode": "fast",
                "auto_sort_strategy": "fresh_fast_quality",
                "ui_solver_preset": "fast",
                "fast_quality_warmup_direct": True,
                "fast_quality_teacher_cap": feasibility_cap,
                "max_teacher_sessions": feasibility_cap,
                "requested_max_teacher_sessions": feasibility_cap,
                "target_teacher_sessions": int(accept_teacher_sessions or feasibility_cap),
                "target_gap1_sessions": int(
                    target_gap1_sessions
                    if target_gap1_sessions is not None
                    else (accept_gap1_sessions or 0)
                ),
                "overall_time_limit_seconds": feasibility_budget,
                "integrated_time_limit": feasibility_budget,
                "optimization_time_limit_seconds": feasibility_budget,
                "fast_benders_time_limit_seconds": feasibility_budget,
                "fast_benders_relaxed_reserve_seconds": 30,
                "fast_benders_require_zero_one_period_sessions": _truthy_setting(
                    settings.get("optimization_first_click_require_zero_one_period")
                ),
                # This stage only has to establish a complete incumbent.  The
                # outer Max portfolio owns all remaining quality search.
                "optimization_continue_quality_search": False,
                "fast_local_quality_polish_time_limit_seconds": 0,
                "progress_estimate_seconds": feasibility_budget,
                "best_effort_on_timeout": False,
                "require_complete_schedule": True,
            }
        )
        if direct_quality_incumbent:
            for key in (
                "target_teacher_sessions",
                "target_gap1_sessions",
                "optimization_accept_teacher_sessions",
                "optimization_accept_gap1_sessions",
                "optimization_default_accept_gap1_sessions",
                "session_early_stop_teacher_sessions",
                "session_early_stop_max_one_period_sessions",
            ):
                feasibility_settings.pop(key, None)
            feasibility_settings.update(
                {
                    "auto_sort_mode": "fast",
                    "auto_sort_strategy": "fresh_teacher_session_opt_direct_benders_incumbent",
                    "optimization_continue_quality_search": False,
                    "optimization_benders_disable_session_early_stop": True,
                    "optimization_benders_iterations": 4,
                    "optimization_benders_session_time_limit": 30,
                    "optimization_benders_complete_first": False,
                    "max_one_period_sessions": 0,
                    "strict_one_period_sessions_cap": True,
                    "enforce_max_one_period_sessions": True,
                    "one_period_priority_absolute": True,
                    "allow_quality_debt": False,
                }
            )
        feasibility_started = time.monotonic()
        try:
            if feasibility_budget < 8:
                raise RuntimeError("Global solver deadline exhausted before feasibility phase")
            feasibility_candidate = (
                _solve_teacher_session_benders_candidate(
                    ui_data,
                    feasibility_settings,
                    cap=feasibility_cap,
                    time_limit_seconds=feasibility_budget,
                    rules=rules,
                    progress=progress,
                    incumbent_payload=None,
                    random_seed=requested_random_seed,
                    deadline=deadline,
                )
                if direct_quality_incumbent
                else _solve_fast_tight_fixed_off_benders(
                    ui_data,
                    feasibility_settings,
                    bounds=bounds,
                    profile=tight_fixed_off_benders_profile,
                    rules=rules,
                    progress=progress,
                    deadline=deadline,
                )
            )
            feasibility_metrics = (
                feasibility_candidate.get("metrics")
                if isinstance(feasibility_candidate.get("metrics"), Mapping)
                else {}
            )
            local_lns_meta: list[dict[str, Any]] = []
            if continue_quality_search and _complete_payload_metrics_acceptable(feasibility_candidate):
                configured_lns_budget = max(
                    0.0,
                    _to_float(settings.get("optimization_local_quality_lns_time_limit_seconds"), 16.0),
                )
                adaptive_lns_floor = min(24.0, max(12.0, float(total_limit) * 0.09))
                local_lns_budget = min(
                    max(configured_lns_budget, adaptive_lns_floor),
                    max(0.0, total_limit - (time.monotonic() - started) - 8.0),
                )
                deadline_remaining = deadline.remaining()
                if deadline_remaining is not None:
                    local_lns_budget = min(
                        local_lns_budget,
                        max(0.0, deadline_remaining - 2.0),
                    )
                if local_lns_budget >= 0.5:
                    report_rules = rules or bound_ctx.rules
                    fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, bound_ctx)
                    bound_ctx.warnings.extend(fixed_warnings)
                    fixed_lessons, released_warnings = _release_invalid_fixed_lessons(
                        bound_ctx.school_data,
                        fixed_lessons,
                        report_rules,
                        release_constraint_violations=False,
                    )
                    bound_ctx.warnings.extend(released_warnings)
                    local_rules = (
                        _rule_set_with_fixed_lesson_slots(report_rules, fixed_lessons)
                        if fixed_lessons
                        else report_rules
                    )
                    local_ctx = (
                        _context_without_fixed_lesson_demand(bound_ctx, fixed_lessons)
                        if fixed_lessons
                        else bound_ctx
                    )
                    polished_lessons = _payload_lessons_to_lessons(feasibility_candidate)
                    initial_lns_metrics = feasibility_metrics
                    lns_started = time.monotonic()
                    local_lns_passes = max(2, min(4, (int(local_lns_budget) + 3) // 4))
                    for lns_pass in range(local_lns_passes):
                        lns_remaining = local_lns_budget - (time.monotonic() - lns_started)
                        deadline_remaining = deadline.remaining()
                        if deadline_remaining is not None:
                            lns_remaining = min(lns_remaining, max(0.0, deadline_remaining - 1.0))
                        if lns_remaining < 0.5:
                            break
                        movable_lessons = _lessons_without_fixed_instances(polished_lessons, fixed_lessons)
                        pass_started = time.monotonic()
                        local_polish = _repair_one_period_affected_class_cluster(
                            local_ctx.school_data,
                            movable_lessons,
                            local_rules,
                            allow_gap1=True,
                            time_limit_seconds=min(4.0, lns_remaining),
                            max_classes=max(2, _to_int(settings.get("optimization_local_quality_lns_max_classes"), 4)),
                            max_lessons=max(60, _to_int(settings.get("optimization_local_quality_lns_max_lessons"), 140)),
                            num_workers=_solver_worker_count(settings),
                            optimize_teacher_quality=True,
                            fixed_lessons=fixed_lessons,
                            report_data=bound_ctx.school_data,
                            report_rules=report_rules,
                            random_seed=polish_seeds[lns_pass % len(polish_seeds)] if polish_seeds else None,
                            gap1_first=quality_gap1_first,
                            preserve_teacher_quality=True,
                        )
                        pass_meta: dict[str, Any] = {
                            "pass": lns_pass + 1,
                            "elapsed_seconds": round(time.monotonic() - pass_started, 3),
                            "improved": local_polish is not None,
                        }
                        if local_polish is None:
                            local_lns_meta.append(pass_meta)
                            continue
                        polished_lessons, polished_metrics, polish_meta = local_polish
                        pass_meta.update(polish_meta)
                        local_lns_meta.append(pass_meta)

                    if polished_lessons and local_lns_meta and any(
                        bool(item.get("improved")) for item in local_lns_meta
                    ):
                        polished_solver = dict(feasibility_candidate.get("solver") or {})
                        polished_period_solver = dict(polished_solver.get("period_solver") or {})
                        polished_period_solver["teacher_quality_lns"] = local_lns_meta
                        polished_solver["period_solver"] = polished_period_solver
                        polished_candidate = build_payload(
                            bound_ctx,
                            polished_lessons,
                            polished_solver,
                            report_rules,
                        )
                        polished_candidate_metrics = (
                            polished_candidate.get("metrics")
                            if isinstance(polished_candidate.get("metrics"), Mapping)
                            else {}
                        )
                        if (
                            _complete_payload_metrics_acceptable(polished_candidate)
                            and _teacher_session_opt_quality(
                                polished_candidate_metrics,
                                gap1_first=quality_gap1_first,
                            )
                            < _teacher_session_opt_quality(
                                initial_lns_metrics,
                                gap1_first=quality_gap1_first,
                            )
                        ):
                            feasibility_candidate = polished_candidate
                            feasibility_metrics = polished_candidate_metrics
            feasibility_summary = _teacher_session_opt_summarize_attempt(
                cap=feasibility_cap,
                elapsed_seconds=time.monotonic() - feasibility_started,
                payload=feasibility_candidate,
            )
            feasibility_summary["phase"] = "tight_gap_fast_incumbent"
            feasibility_summary["attempt_key"] = "tight_gap:fast_incumbent"
            feasibility_summary["direct_quality_benders"] = direct_quality_incumbent
            if local_lns_meta:
                feasibility_summary["teacher_quality_lns"] = local_lns_meta
            if _complete_payload_metrics_acceptable(feasibility_candidate):
                feasibility_hint_payload = feasibility_candidate
                feasibility_summary["warm_start_available"] = True
                feasibility_one_period = _metric_int(
                    feasibility_metrics,
                    "one_period_teacher_sessions",
                    10**9,
                )
                feasibility_summary["accepted"] = True
                feasibility_summary["new_best"] = True
                feasibility_summary["quality_debt_fallback"] = feasibility_one_period > 0
                best_payload = feasibility_candidate
                best_metrics = feasibility_metrics
                best_sessions = _metric_int(feasibility_metrics, "teacher_sessions", upper_cap)
                next_tight_cap = best_sessions - 1
                caps_queue = [next_tight_cap] if next_tight_cap >= lower_cap else []
                if feasibility_one_period == 0:
                    gap_priority_queue = _teacher_session_opt_gap_priority_attempts(
                        feasibility_metrics,
                        target_gap1_sessions=target_gap1_sessions,
                        preferred_cap=accept_teacher_sessions,
                        lower_cap=lower_cap,
                        upper_cap=upper_cap,
                        polish_seeds=polish_seeds,
                    )
                    last_improvement_at = time.monotonic()
                    stagnant_attempts = 0
                else:
                    feasibility_summary["quality_debt_incumbent"] = True
                    last_improvement_at = time.monotonic()
                    stagnant_attempts = 0
            else:
                feasibility_summary["accepted"] = False
                feasibility_summary["reject_reason"] = "incomplete_fast_incumbent"
            attempts.append(feasibility_summary)
        except Exception as exc:  # noqa: BLE001 - the target-cap portfolio still has the remaining budget.
            feasibility_summary = _teacher_session_opt_summarize_attempt(
                cap=feasibility_cap,
                elapsed_seconds=time.monotonic() - feasibility_started,
                error=exc,
            )
            feasibility_summary["phase"] = "tight_gap_fast_incumbent"
            feasibility_summary["attempt_key"] = "tight_gap:fast_incumbent"
            attempts.append(feasibility_summary)
    if skip_fast_quality_warmup:
        attempts.append(
            {
                "ok": False,
                "skipped": True,
                "phase": "fast_quality_incumbent",
                "reason": "tight_fixed_off_uses_benders_incumbent_directly",
            }
        )

    if best_payload is None and not portfolio_done and not skip_fast_quality_warmup:
        fast_quality_source_settings = dict(settings)
        warmup_quality_target = (
            target_teacher_sessions
            or accept_teacher_sessions
            or int(bounds.get("start_cap") or lower_cap)
        )
        if unified_fresh_complete_request:
            complete_first_cap = _complete_first_teacher_session_cap(
                bounds,
                tight_fixed_off_benders_profile,
            )
            class_count = max(
                0,
                _to_int(
                    tight_fixed_off_benders_profile.get("class_count"),
                    0,
                )
                if isinstance(tight_fixed_off_benders_profile, Mapping)
                else 0,
            )
            quality_headroom = max(5, _ceil_div(class_count, 3))
            warmup_feasibility_cap = (
                min(
                    complete_first_cap,
                    int(warmup_quality_target) + quality_headroom,
                )
                if tight_fixed_off_benders_profile is not None
                else complete_first_cap
            )
            # The hard cap provides a complete incumbent while the separate
            # early-stop target keeps improving it. Parallel period placement
            # leaves enough budget to finish either incumbent safely.
            fast_quality_source_settings["fast_quality_teacher_cap"] = int(warmup_feasibility_cap)
        fast_quality_source_settings["target_teacher_sessions"] = int(warmup_quality_target)
        if target_gap1_sessions is not None:
            fast_quality_source_settings["target_gap1_sessions"] = int(target_gap1_sessions)
        fast_quality_settings = _teacher_session_opt_fast_quality_settings(fast_quality_source_settings, bounds)
        if adaptive_teacher_session_opt:
            adaptive_warmup_limit = max(
                20,
                min(
                    45,
                    total_limit,
                    _to_int(settings.get("optimization_adaptive_warmup_time_limit_seconds"), 45),
                ),
            )
            adaptive_period_limit = max(
                6,
                min(
                    _to_int(fast_quality_settings.get("period_time_limit"), 12),
                    max(6, adaptive_warmup_limit // 4),
                ),
            )
            adaptive_period_reserve = max(12, adaptive_period_limit + 4)
            adaptive_session_limit = max(
                4,
                min(
                    _to_int(fast_quality_settings.get("session_time_limit"), 28),
                    max(4, adaptive_warmup_limit - adaptive_period_reserve - 2),
                ),
            )
            fast_quality_settings.update(
                {
                    "session_time_limit": adaptive_session_limit,
                    "period_time_limit": adaptive_period_limit,
                    "period_fast_time_limit": adaptive_period_limit,
                    "period_retry_time_limit": adaptive_period_limit,
                    "integrated_time_limit": adaptive_warmup_limit,
                    "overall_time_limit_seconds": adaptive_warmup_limit,
                    "progress_estimate_seconds": adaptive_warmup_limit,
                    "optimization_adaptive_warmup": True,
                }
            )
        if legacy_targetless_opt:
            legacy_cap = min(upper_cap, max(int(bounds.get("start_cap") or lower_cap) + 15, 200))
            fast_quality_settings.update(
                {
                    "max_teacher_sessions": legacy_cap,
                    "requested_max_teacher_sessions": legacy_cap,
                    "session_time_limit": 18,
                    "period_time_limit": 45,
                    "period_fast_time_limit": 30,
                    "period_retry_time_limit": 45,
                    "integrated_time_limit": min(90, total_limit),
                    "overall_time_limit_seconds": min(90, total_limit),
                    "progress_estimate_seconds": min(60, total_limit),
                }
            )
        fast_quality_cap = _to_int(fast_quality_settings.get("max_teacher_sessions"), int(bounds.get("start_cap") or lower_cap))
        if progress:
            progress(
                {
                    "stage": "teacher_session_opt:fast_quality",
                    "message": "Dang lay nghiem nhanh lam moc toi uu buoi GV",
                    "cap": fast_quality_cap,
                    "time_limit_seconds": fast_quality_settings.get("overall_time_limit_seconds"),
                }
            )
        fast_started = time.monotonic()
        try:
            fast_candidate = solve_from_ui_data(
                ui_data,
                fast_quality_settings,
                rules=rules,
                progress=progress,
                out_dir=None,
                _deadline=deadline,
            )
            fast_summary = _teacher_session_opt_summarize_attempt(
                cap=fast_quality_cap,
                elapsed_seconds=time.monotonic() - fast_started,
                payload=fast_candidate,
            )
            fast_summary["phase"] = "fast_quality_incumbent"
            fast_summary["attempt_key"] = "fresh_fast_quality"
            fast_metrics = fast_candidate.get("metrics") if isinstance(fast_candidate.get("metrics"), Mapping) else {}
            if _complete_payload_metrics_acceptable(fast_candidate):
                fast_summary["accepted"] = True
                best_payload = fast_candidate
                best_metrics = fast_metrics
                gap_priority_queue = _teacher_session_opt_gap_priority_attempts(
                    fast_metrics,
                    target_gap1_sessions=target_gap1_sessions if adaptive_gap_target_only else None,
                    preferred_cap=accept_teacher_sessions if adaptive_gap_target_only else None,
                    lower_cap=lower_cap,
                    upper_cap=upper_cap,
                    polish_seeds=polish_seeds,
                )
                last_improvement_at = time.monotonic()
                stagnant_attempts = 0
                fast_summary["new_best"] = True
                if _metric_int(fast_metrics, "teacher_sessions", 10**9) > fast_quality_cap:
                    fast_summary["over_soft_cap"] = True
                    fast_summary["soft_cap"] = fast_quality_cap
                best_sessions = _metric_int(fast_metrics, "teacher_sessions", upper_cap)
                caps_queue = [item for item in caps_queue if int(item) < best_sessions]
                next_tight_cap = best_sessions - 1
                if next_tight_cap >= lower_cap and (next_tight_cap, "default") not in tried_attempts:
                    caps_queue = [next_tight_cap, *[item for item in caps_queue if int(item) != next_tight_cap]]
                fresh_first_click_incumbent = (
                    unified_first_click_complete
                    and _metric_int(fast_metrics, "one_period_teacher_sessions", 10**9) == 0
                )
                if fresh_first_click_incumbent:
                    # The first click must return the complete timetable already
                    # found by the feasibility lane. A fresh global model can
                    # consume the watchdog reserve without producing a replacement,
                    # while local ALNS can improve this incumbent at any time.
                    fast_summary["terminal_first_complete"] = True
                    attempts.append(fast_summary)
                    return_reserve = max(
                        5.0,
                        _to_float(
                            settings.get("optimization_first_click_return_reserve_seconds"),
                            5.0,
                        ),
                        _to_float(
                            settings.get("ui_unified_reference_watchdog_reserve_ms"),
                            0.0,
                        )
                        / 1000.0,
                    )
                    configured_local_budget = max(
                        0.0,
                        min(
                            50.0,
                            _to_float(
                                settings.get("optimization_first_click_local_lns_time_limit_seconds"),
                                16.0,
                            ),
                        ),
                    )
                    available_local_budget = max(
                        0.0,
                        float(total_limit) - (time.monotonic() - started) - return_reserve,
                    )
                    deadline_remaining = deadline.remaining()
                    if deadline_remaining is not None:
                        available_local_budget = min(
                            available_local_budget,
                            max(0.0, deadline_remaining - return_reserve),
                        )
                    local_budget = min(configured_local_budget, available_local_budget)
                    local_started = time.monotonic()
                    local_result = None
                    local_error: Exception | None = None
                    if local_budget >= 0.5:
                        if progress:
                            progress(
                                {
                                    "stage": "teacher_session_opt:first_complete_local_lns",
                                    "message": "Da co lich day du, dang toi uu nhanh tren nghiem hien tai",
                                    "time_limit_seconds": round(local_budget, 3),
                                    "return_reserve_seconds": round(return_reserve, 3),
                                }
                            )
                        try:
                            local_result = _polish_complete_incumbent_with_local_lns(
                                ui_data,
                                settings,
                                bound_ctx,
                                best_payload,
                                rules=rules,
                                polish_seeds=polish_seeds,
                                time_limit_seconds=local_budget,
                            )
                        except Exception as exc:  # noqa: BLE001 - the complete incumbent is mandatory.
                            local_error = exc

                    local_summary: dict[str, Any] = {
                        "ok": local_error is None,
                        "phase": "fresh_complete_first_local_lns",
                        "attempt_key": "fresh:first_complete_local_lns",
                        "elapsed_seconds": round(time.monotonic() - local_started, 3),
                        "time_limit_seconds": round(local_budget, 3),
                        "return_reserve_seconds": round(return_reserve, 3),
                        "incumbent_retained": True,
                    }
                    if local_result is not None:
                        local_candidate, local_passes = local_result
                        local_metrics = (
                            local_candidate.get("metrics")
                            if isinstance(local_candidate.get("metrics"), Mapping)
                            else {}
                        )
                        if (
                            _complete_payload_metrics_acceptable(local_candidate)
                            and _incremental_refinement_candidate_better(local_metrics, best_metrics)
                        ):
                            best_payload = local_candidate
                            best_metrics = local_metrics
                            feasibility_hint_payload = local_candidate
                            last_improvement_at = time.monotonic()
                            local_summary.update(
                                {
                                    "improved": True,
                                    "incumbent_retained": False,
                                    "teacher_quality_lns": local_passes,
                                    "teacher_sessions": local_metrics.get("teacher_sessions"),
                                    "one_period_teacher_sessions": local_metrics.get(
                                        "one_period_teacher_sessions"
                                    ),
                                    "gap_distribution": local_metrics.get("gap_distribution"),
                                }
                            )
                            termination_reason = "first_complete_local_lns_improved"
                        else:
                            local_summary["improved"] = False
                            local_summary["candidate_rejected_by_quality_envelope"] = True
                            termination_reason = "first_complete_local_lns_stagnant_retained"
                    elif local_error is not None:
                        local_summary["improved"] = False
                        local_summary["error"] = str(local_error)
                        termination_reason = "first_complete_local_lns_error_retained"
                    elif local_budget < 0.5:
                        local_summary.update(
                            {
                                "improved": False,
                                "skipped": True,
                                "reason": "watchdog_return_reserve",
                            }
                        )
                        termination_reason = "first_complete_watchdog_reserve_retained"
                    else:
                        local_summary["improved"] = False
                        termination_reason = "first_complete_local_lns_stagnant_retained"
                    attempts.append(local_summary)
                    feasibility_hint_payload = best_payload
                    portfolio_done = True
                    search_end_reason = termination_reason
                elif not continue_quality_search and _teacher_session_opt_should_stop(
                    fast_metrics,
                    target_teacher_sessions=target_teacher_sessions,
                    target_gap1_sessions=target_gap1_sessions,
                    accept_teacher_sessions=accept_teacher_sessions,
                    accept_gap1_sessions=accept_gap1_sessions,
                ):
                    fast_summary["good_enough"] = True
                    attempts.append(fast_summary)
                    attempts.append(
                        {
                            "ok": True,
                            "skipped": True,
                            "reason": "fast_quality_candidate_accepted",
                            "teacher_sessions": fast_metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": fast_metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": fast_metrics.get("gap_distribution"),
                            "accept_teacher_sessions": accept_teacher_sessions,
                            "accept_gap1_sessions": accept_gap1_sessions,
                        }
                    )
                    portfolio_done = True
                    termination_reason = (
                        "lower_bound_reached"
                        if _metric_int(fast_metrics, "teacher_sessions", upper_cap) <= lower_cap
                        else "target_reached"
                    )
                elif legacy_targetless_opt and target_teacher_sessions is None and target_gap1_sessions is None:
                    attempts.append(fast_summary)
                    attempts.append(
                        {
                            "ok": True,
                            "skipped": True,
                            "reason": "legacy_targetless_teacher_opt_fast_candidate_returned",
                            "teacher_sessions": fast_metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": fast_metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": fast_metrics.get("gap_distribution"),
                        }
                    )
                    portfolio_done = True
                else:
                    attempts.append(fast_summary)
            else:
                fast_summary["accepted"] = False
                fast_summary["reject_reason"] = "incomplete_or_best_effort"
                attempts.append(fast_summary)
        except Exception as exc:  # noqa: BLE001 - keep portfolio search available when the warm start fails.
            fast_summary = _teacher_session_opt_summarize_attempt(
                cap=fast_quality_cap,
                elapsed_seconds=time.monotonic() - fast_started,
                error=exc,
            )
            fast_summary["phase"] = "fast_quality_incumbent"
            fast_summary["attempt_key"] = "fresh_fast_quality"
            attempts.append(fast_summary)

    while not portfolio_done:
        elapsed = time.monotonic() - started
        remaining = total_limit - elapsed
        deadline_remaining = deadline.remaining()
        if deadline_remaining is not None:
            remaining = min(remaining, deadline_remaining)
        if remaining < 8:
            attempts.append({"ok": False, "skipped": True, "reason": "optimization_time_budget_exhausted"})
            search_end_reason = "time_budget_exhausted"
            break
        if tight_gap_benders_portfolio and best_metrics is not None and remaining < 12:
            attempts.append(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "tight_gap_portfolio_reserved_short_retry_skipped",
                    "remaining_seconds": round(remaining, 3),
                }
            )
            search_end_reason = "time_budget_exhausted"
            break
        frontier_gap_target_pending = (
            refinement_frontier_enabled
            and strict_existing_quality_cleanup_requires_period_bridge
            and total_limit >= 150
            and best_metrics is not None
            and _teacher_session_opt_quality_gates_clean(best_metrics)
            and target_gap1_sessions is not None
            and _teacher_session_opt_gap1(best_metrics) > int(target_gap1_sessions)
        )
        frontier_cleanup_pending = (
            refinement_frontier_enabled
            and best_payload is not None
            and visible_best_payload is not None
            and (
                best_payload is not visible_best_payload
                or frontier_gap_target_pending
            )
        )
        if (
            frontier_cleanup_pending
            and remaining < frontier_cleanup_tail + 8.0
        ):
            # Keep a short tail for repairing gap debt on a lower-session
            # frontier candidate. Without this reserve the last tight Benders
            # slice consumes the whole watchdog and leaves an otherwise useful
            # 465/42 candidate stranded behind a 482/41 incumbent.
            attempts.append(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "frontier_gap_cleanup_reserved",
                    "remaining_seconds": round(remaining, 3),
                }
            )
            search_end_reason = "frontier_gap_cleanup_reserved"
            break
        if (
            refinement_request
            and _truthy_setting(settings.get("optimization_stop_on_stagnation", "1"))
            and adaptive_teacher_session_opt
            and best_metrics is not None
            and _teacher_session_opt_quality_gates_clean(best_metrics)
            and not strict_existing_quality_cleanup_pending
            and not any(
                str(item[2]).startswith("nearby:")
                for item in gap_priority_queue
            )
            and (
                stagnant_attempts >= max(2, adaptive_stagnant_attempt_limit)
                or (
                    stagnant_attempts >= 2
                    and time.monotonic() - last_improvement_at >= adaptive_stagnant_seconds
                )
            )
        ):
            attempts.append(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "refinement_search_saturated",
                    "stagnant_attempts": stagnant_attempts,
                    "stagnant_seconds": round(time.monotonic() - last_improvement_at, 3),
                }
            )
            termination_reason = "refinement_search_saturated"
            search_end_reason = termination_reason
            break
        if (
            not refinement_request
            and _truthy_setting(settings.get("optimization_stop_on_stagnation", "1"))
            and
            adaptive_teacher_session_opt
            and best_metrics is not None
            and _teacher_session_opt_quality_gates_clean(best_metrics)
            and _teacher_session_opt_good_enough(
                best_metrics,
                accept_teacher_sessions=accept_teacher_sessions,
                accept_gap1_sessions=accept_gap1_sessions,
            )
            and (
                stagnant_attempts >= adaptive_stagnant_attempt_limit
                or (
                    stagnant_attempts >= 2
                    and time.monotonic() - last_improvement_at >= adaptive_stagnant_seconds
                )
            )
        ):
            attempts.append(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "accept_fallback_after_stagnation",
                    "stagnant_attempts": stagnant_attempts,
                    "stagnant_seconds": round(time.monotonic() - last_improvement_at, 3),
                }
            )
            termination_reason = "accept_fallback_after_stagnation"
            search_end_reason = termination_reason
            break

        phase = "search"
        cap: int | None = None
        random_seed: int | None = None
        if best_metrics is None:
            while initial_gap_retry_queue:
                retry_cap, retry_seed, retry_key = initial_gap_retry_queue.pop(0)
                retry_cap = max(lower_cap, min(upper_cap, int(retry_cap)))
                if (retry_cap, retry_key) not in tried_attempts:
                    cap = retry_cap
                    random_seed = retry_seed
                    phase = "initial_gap_retry"
                    break
        if (
            cap is None
            and strict_existing_quality_cleanup_pending
            and best_metrics is not None
        ):
            cap = max(
                lower_cap,
                min(
                    upper_cap,
                    _metric_int(best_metrics, "teacher_sessions", upper_cap),
                ),
            )
            if polish_seeds:
                random_seed = int(
                    polish_seeds[
                        strict_existing_quality_cleanup_seed_index % len(polish_seeds)
                    ]
                )
                strict_existing_quality_cleanup_seed_index += 1
            else:
                random_seed = requested_random_seed
            phase = "existing_strict_wide_quality_cleanup"
            strict_existing_quality_cleanup_pending = False
        prioritize_gap_portfolio = (
            cap is None
            and best_metrics is not None
            and adaptive_gap_target_only
            and _teacher_session_opt_should_prioritize_gap_portfolio(
                best_metrics,
                target_gap1_sessions=target_gap1_sessions,
            )
        )
        if prioritize_gap_portfolio:
            best_sessions = _metric_int(best_metrics, "teacher_sessions", upper_cap)
            while gap_priority_queue:
                portfolio_cap, portfolio_seed, portfolio_key = gap_priority_queue.pop(0)
                portfolio_cap = max(lower_cap, min(upper_cap, int(portfolio_cap)))
                if int(portfolio_seed) in consumed_refinement_seeds:
                    continue
                if (portfolio_cap, portfolio_key) not in tried_attempts:
                    cap = portfolio_cap
                    random_seed = portfolio_seed
                    if str(portfolio_key).startswith("target:"):
                        phase = "target_cap_gap_opt"
                    elif portfolio_cap < best_sessions:
                        phase = "tighten"
                    else:
                        phase = (
                            "relaxed_cap_gap_polish"
                            if portfolio_cap > best_sessions
                            else "same_cap_gap_polish"
                        )
                    break
        if cap is None and best_metrics is not None and balanced_quality_envelope:
            best_sessions = _metric_int(best_metrics, "teacher_sessions", upper_cap)
            while caps_queue:
                next_cap = max(lower_cap, min(upper_cap, int(caps_queue.pop(0))))
                if next_cap < best_sessions and (next_cap, "default") not in tried_attempts:
                    cap = next_cap
                    phase = "queued_cap"
                    break
        if (
            cap is None
            and
            best_metrics is not None
            and adaptive_gap_target_only
            and not prioritize_gap_portfolio
            and _teacher_session_opt_gap1(best_metrics) > int(target_gap1_sessions)
        ):
            best_sessions = _metric_int(best_metrics, "teacher_sessions", upper_cap)
            while gap_priority_queue:
                portfolio_cap, portfolio_seed, portfolio_key = gap_priority_queue.pop(0)
                portfolio_cap = max(lower_cap, min(upper_cap, int(portfolio_cap)))
                if int(portfolio_seed) in consumed_refinement_seeds:
                    continue
                if (portfolio_cap, portfolio_key) not in tried_attempts:
                    cap = portfolio_cap
                    random_seed = portfolio_seed
                    if str(portfolio_key).startswith("target:"):
                        phase = "target_cap_gap_opt"
                    elif portfolio_cap < best_sessions:
                        phase = "tighten"
                    else:
                        phase = (
                            "relaxed_cap_gap_polish"
                            if portfolio_cap > best_sessions
                            else "same_cap_gap_polish"
                        )
                    break
        if (
            cap is None
            and best_metrics is not None
            and lower_cap_failed
            and target_gap1_sessions is not None
            and _teacher_session_opt_gap1(best_metrics) > target_gap1_sessions
        ):
            while same_cap_polish_queue:
                portfolio_cap, portfolio_seed, portfolio_key = same_cap_polish_queue.pop(0)
                portfolio_cap = max(lower_cap, min(upper_cap, int(portfolio_cap)))
                if (
                    portfolio_seed is not None
                    and int(portfolio_seed) in consumed_refinement_seeds
                ):
                    continue
                if (portfolio_cap, portfolio_key) not in tried_attempts:
                    cap = portfolio_cap
                    random_seed = portfolio_seed
                    phase = "same_cap_gap_polish"
                    break

        if cap is None and best_metrics is not None:
            best_sessions = _metric_int(best_metrics, "teacher_sessions", upper_cap)
            tight_cap = best_sessions - 1
            must_tighten_teacher_sessions = (
                (target_teacher_sessions is not None and best_sessions > target_teacher_sessions)
                or (target_teacher_sessions is None and accept_teacher_sessions is not None and best_sessions > accept_teacher_sessions)
            )
            if not must_tighten_teacher_sessions:
                while same_cap_polish_queue and remaining >= 25:
                    portfolio_cap, portfolio_seed, portfolio_key = same_cap_polish_queue.pop(0)
                    portfolio_cap = max(lower_cap, min(upper_cap, int(portfolio_cap)))
                    if (
                        portfolio_seed is not None
                        and int(portfolio_seed) in consumed_refinement_seeds
                    ):
                        continue
                    if (portfolio_cap, portfolio_key) not in tried_attempts:
                        cap = portfolio_cap
                        random_seed = portfolio_seed
                        phase = "same_cap_portfolio"
                        break
                if cap is not None:
                    pass

        while cap is None and caps_queue:
            next_cap = max(lower_cap, min(upper_cap, int(caps_queue.pop(0))))
            if (next_cap, "default") not in tried_attempts:
                cap = next_cap
                phase = "queued_cap"
                break

        if cap is None and best_metrics is not None:
            best_sessions = _metric_int(best_metrics, "teacher_sessions", upper_cap)
            tight_cap = best_sessions - 1
            if tight_cap >= lower_cap and (tight_cap, "default") not in tried_attempts:
                cap = tight_cap
                phase = "tighten"
            elif lower_cap_failed and relaxed_polish_index < len(relaxed_polish_offsets):
                relaxed_cap = min(upper_cap, best_sessions + relaxed_polish_offsets[relaxed_polish_index])
                relaxed_polish_index += 1
                relaxed_seed = polish_seeds[(relaxed_polish_index - 1) % len(polish_seeds)]
                if relaxed_cap > best_sessions and (relaxed_cap, f"seed:{relaxed_seed}") not in tried_attempts:
                    cap = relaxed_cap
                    random_seed = relaxed_seed
                    phase = "relaxed_polish"
                else:
                    continue
            elif polish_index < len(polish_seeds) and remaining >= 20:
                cap = best_sessions
                random_seed = polish_seeds[polish_index]
                polish_index += 1
                phase = "polish"
                if (cap, f"seed:{random_seed}") in tried_attempts:
                    continue

        if (
            refinement_request
            and cap is not None
            and random_seed is None
            and phase in {"queued_cap", "tighten"}
            and polish_seeds
        ):
            for _unused_seed_probe in range(len(polish_seeds)):
                candidate_seed = int(
                    polish_seeds[refinement_global_seed_index % len(polish_seeds)]
                )
                refinement_global_seed_index += 1
                if candidate_seed not in consumed_refinement_seeds:
                    random_seed = candidate_seed
                    break
            if random_seed is None:
                random_seed = int(
                    polish_seeds[refinement_global_seed_index % len(polish_seeds)]
                )
                refinement_global_seed_index += 1

        if cap is None:
            search_end_reason = "search_exhausted"
            break

        attempt_key = (cap, f"seed:{random_seed}" if random_seed is not None else "default")
        if phase in {"same_cap_portfolio", "same_cap_gap_polish", "relaxed_cap_gap_polish"} and random_seed is None:
            repeat_index = 1
            while (cap, f"repeat:{repeat_index}") in tried_attempts:
                repeat_index += 1
            attempt_key = (cap, f"repeat:{repeat_index}")
        if attempt_key in tried_attempts:
            continue
        tried_attempts.add(attempt_key)
        if refinement_request and random_seed is not None:
            consumed_refinement_seeds.add(int(random_seed))

        cap_limit = min(
            remaining,
            first_cap_limit
            if best_payload is None
            or phase
            in {
                "tighten",
                "queued_cap",
                "existing_strict_wide_quality_cleanup",
            }
            else (polish_cap_limit if phase == "polish" else retry_cap_limit),
        )
        if phase == "existing_strict_wide_quality_cleanup":
            if strict_existing_quality_cleanup_requires_period_bridge:
                # Subject-period rules need one uninterrupted integrated model.
                # Splitting this into 60-75 second restarts repeatedly returned
                # UNKNOWN before the first useful incumbent; the proven 180s
                # replay reached 484 sessions with both hard quality gates clean.
                cap_limit = max(8.0, remaining - 2.0)
            else:
                # Plain schools do not need the 25k-variable all-period bridge.
                # Keep the proven staircase portfolio: roughly 60 seconds per
                # independent session vector, followed by another cap/seed
                # while budget remains. This is what produced the former
                # 465-session/38-gap default result instead of spending the
                # entire click on one unlucky integrated trajectory.
                cap_limit = min(
                    cap_limit,
                    max(45.0, min(75.0, remaining - 5.0)),
                )
        if frontier_cleanup_pending and remaining > frontier_cleanup_tail:
            # Spend the time before the cleanup reserve on another useful
            # global probe instead of returning with most of that slice idle.
            cap_limit = min(
                cap_limit,
                max(8.0, remaining - frontier_cleanup_tail),
            )
        if phase == "target_cap_gap_opt":
            target_cap_limit = max(
                60,
                min(240, _to_int(settings.get("optimization_tight_gap_target_cap_time_limit_seconds"), 210)),
            )
            target_cap_reserve = max(
                20,
                min(45, _to_int(settings.get("optimization_tight_gap_final_reserve_seconds"), 30)),
            )
            target_cap_available = (
                max(8, remaining - target_cap_reserve)
                if remaining > target_cap_reserve + 8
                else remaining
            )
            cap_limit = min(cap_limit, target_cap_limit, target_cap_available)
        if best_payload is None and cap >= upper_cap:
            cap_limit = remaining
        cap_limit_int = max(8, int(cap_limit))
        candidate_settings = _teacher_session_opt_attempt_settings(
            settings,
            cap=cap,
            target_teacher_sessions=target_teacher_sessions,
            target_gap1_sessions=target_gap1_sessions,
            time_limit_seconds=cap_limit_int,
            lower_cap=lower_cap,
            random_seed=random_seed,
        )
        candidate_settings["optimization_adaptive_target"] = adaptive_teacher_session_opt
        if phase == "existing_strict_wide_quality_cleanup":
            strict_quality_settings = {
                "auto_sort_strategy": "continue_strict_wide_quality_from_incumbent",
                "optimization_benders_complete_first": True,
                "optimization_benders_iterations": max(
                    4,
                    _to_int(
                        settings.get("optimization_benders_iterations"),
                        0,
                    ),
                ),
                "optimization_benders_session_feasibility_only": False,
                "optimization_benders_disable_session_early_stop": True,
                "optimization_continue_quality_search": True,
                # Zero-singleton is a hard cap in this cleanup. Keep the model
                # lean and retain the incumbent only as a CP-SAT hint, without
                # either redundant singleton or hint-distance objective vars.
                "optimization_benders_minimize_one_period_sessions": False,
                "optimization_benders_minimize_hint_distance": False,
                "max_one_period_sessions": 0,
                "strict_one_period_sessions_cap": True,
                "enforce_max_one_period_sessions": True,
                "one_period_priority_absolute": True,
                "period_max_teacher_gap": 1,
                "relax_period_teacher_gap_on_failure": False,
            }
            if strict_existing_quality_cleanup_requires_period_bridge:
                strict_quality_settings.update(
                    {
                        "optimization_benders_period_feasibility_all_sessions": True,
                        "optimization_benders_lean_refinement_periods": False,
                        "optimization_continue_quality_search": True,
                        "optimization_benders_disable_session_early_stop": True,
                        "optimization_benders_session_time_limit": max(
                            30,
                            min(170, cap_limit_int - 4),
                        ),
                        "minimize_one_period_sessions": False,
                        "session_cp_sat_linearization_level": 0,
                    }
                )
            else:
                # Leave the legacy two-stage period allocator active. Its
                # attempt-budget adapter supplies a 30s session slice plus a
                # bounded period slice, allowing several independent seeds in
                # one 180s refinement click.  This request already owns a
                # complete hard-valid incumbent, so it must not use the
                # complete-first cut promotion: after two failed half-days that
                # promotion expands the next retry to every session and spends
                # the rest of the click rebuilding the 25k-variable period
                # bridge.  Sparse Benders cuts grow only around the sessions
                # that actually failed, while the incumbent remains the atomic
                # fallback outside this candidate search.
                strict_quality_settings.update(
                    {
                        "optimization_benders_complete_first": False,
                        "optimization_benders_period_feasibility_all_sessions": False,
                        "optimization_benders_lean_refinement_periods": True,
                    }
                )
            candidate_settings.update(strict_quality_settings)
        if phase == "target_cap_gap_opt":
            candidate_settings["optimization_benders_accept_stagnant_iterations"] = (
                0
                if continue_quality_search
                else max(
                    1,
                    min(
                        4,
                        _to_int(settings.get("optimization_tight_gap_accept_stagnant_iterations"), 2),
                    ),
                )
            )
            candidate_settings["optimization_benders_disable_session_early_stop"] = True
        if progress:
            progress(
                {
                    "stage": "teacher_session_opt:attempt",
                    "message": f"Dang sap xep ung vien voi cap {cap}",
                    "phase": phase,
                    "cap": cap,
                    "random_seed": random_seed,
                    "time_limit_seconds": cap_limit_int,
                    "best_teacher_sessions": (
                        best_metrics.get("teacher_sessions") if isinstance(best_metrics, Mapping) else None
                    ),
                }
            )
        attempt_started = time.monotonic()
        use_benders = False
        try:
            best_sessions_for_benders = (
                _metric_int(best_metrics, "teacher_sessions", upper_cap)
                if isinstance(best_metrics, Mapping)
                else upper_cap
            )
            benders_teacher_goal_cap = (
                max(
                    int(accept_teacher_sessions or lower_cap),
                    int(best_sessions_for_benders),
                )
                if adaptive_teacher_session_opt
                else (
                    target_teacher_sessions
                    if target_teacher_sessions is not None
                    else accept_teacher_sessions
                )
            )
            use_benders = (
                _truthy_setting(settings.get("optimization_use_benders", "1"))
                and phase in {
                    "initial_gap_retry",
                    "queued_cap",
                    "tighten",
                    "same_cap_portfolio",
                    "same_cap_gap_polish",
                    "relaxed_cap_gap_polish",
                    "target_cap_gap_opt",
                    "existing_strict_wide_quality_cleanup",
                }
                and (
                    phase in {
                        "initial_gap_retry",
                        "same_cap_portfolio",
                        "same_cap_gap_polish",
                        "relaxed_cap_gap_polish",
                        "target_cap_gap_opt",
                        "existing_strict_wide_quality_cleanup",
                    }
                    or cap <= best_sessions_for_benders
                )
                and (
                    phase == "existing_strict_wide_quality_cleanup"
                    or benders_teacher_goal_cap is None
                    or cap <= int(benders_teacher_goal_cap)
                )
                and cap_limit_int >= 30
            )
            independent_gap_portfolio = (
                tight_gap_benders_portfolio
                and phase in {
                    "initial_gap_retry",
                    "relaxed_cap_gap_polish",
                }
            )
            if use_benders:
                    candidate = _solve_teacher_session_benders_candidate(
                        ui_data,
                        candidate_settings,
                        cap=cap,
                        time_limit_seconds=cap_limit_int,
                        rules=rules,
                        progress=progress,
                        # A clean concrete-period incumbent is also the safest
                        # warm start for the integrated bridge. It gives CP-SAT
                        # an immediately feasible 1,566-period solution and
                        # leaves the remaining budget for session/gap quality.
                        # Dirty incumbents still explore freely. The hint is
                        # never fixed and the outer Pareto guard rejects any
                        # regression.
                        incumbent_payload=(
                            None
                            if independent_gap_portfolio
                            or (
                                phase == "existing_strict_wide_quality_cleanup"
                                and (
                                    not strict_existing_quality_cleanup_requires_period_bridge
                                    or not (
                                        isinstance(best_metrics, Mapping)
                                        and _teacher_session_opt_quality_gates_clean(best_metrics)
                                    )
                                )
                            )
                            else (best_payload or feasibility_hint_payload)
                        ),
                    random_seed=random_seed,
                    deadline=deadline,
                )
            else:
                candidate = solve_from_ui_data(
                    ui_data,
                    candidate_settings,
                    rules=rules,
                    progress=progress,
                    out_dir=None,
                    _deadline=deadline,
                )
        except Exception as exc:  # noqa: BLE001 - portfolio mode records failures and tries the next cap.
            summary = _teacher_session_opt_summarize_attempt(
                cap=cap,
                elapsed_seconds=time.monotonic() - attempt_started,
                error=exc,
            )
            summary["phase"] = phase
            summary["random_seed"] = random_seed
            summary["attempt_key"] = attempt_key[1]
            summary["benders"] = bool(use_benders)
            if (
                phase == "existing_strict_wide_quality_cleanup"
                and strict_existing_quality_cleanup_requires_period_bridge
                and strict_existing_quality_cleanup_seed_index < len(polish_seeds)
            ):
                retry_remaining = deadline.remaining()
                if retry_remaining is None:
                    retry_remaining = total_limit - (time.monotonic() - started)
                if retry_remaining >= 45:
                    strict_existing_quality_cleanup_pending = True
                    summary["strict_wide_retry_pending"] = True
            attempts.append(summary)
            if (
                tight_gap_benders_portfolio
                and best_metrics is None
                and accept_teacher_sessions is not None
                and cap == int(accept_teacher_sessions)
                and phase != "initial_gap_retry"
                and polish_seeds
            ):
                retry_seed = int(polish_seeds[0])
                initial_gap_retry_queue = [
                    (cap, retry_seed, f"initial-retry:{retry_seed}")
                ]
            if best_metrics is not None and cap < _metric_int(best_metrics, "teacher_sessions", upper_cap):
                lower_cap_failed = True
            if (
                adaptive_teacher_session_opt
                and best_metrics is not None
            ):
                stagnant_attempts += 1
            continue

        summary = _teacher_session_opt_summarize_attempt(
            cap=cap,
            elapsed_seconds=time.monotonic() - attempt_started,
            payload=candidate,
        )
        summary["phase"] = phase
        summary["random_seed"] = random_seed
        summary["attempt_key"] = attempt_key[1]
        summary["benders"] = bool(use_benders)
        metrics = candidate.get("metrics") if isinstance(candidate.get("metrics"), Mapping) else {}
        candidate_improved = False
        visible_candidate_improved = False
        previous_search_sessions = (
            _metric_int(best_metrics, "teacher_sessions", upper_cap)
            if best_metrics is not None
            else None
        )
        candidate_complete = (
            _complete_payload_metrics_acceptable(candidate)
            and _metric_int(metrics, "teacher_sessions", 10**9) <= cap
        )
        if candidate_complete:
            summary["accepted"] = True
            if refinement_frontier_enabled and (
                visible_best_metrics is None
                or _incremental_refinement_candidate_better(metrics, visible_best_metrics)
            ):
                visible_best_payload = candidate
                visible_best_metrics = metrics
                visible_candidate_improved = True
                summary["new_visible_best"] = True
            if refinement_frontier_enabled:
                search_candidate_better = (
                    best_metrics is None
                    or _teacher_session_opt_frontier_better(metrics, best_metrics)
                )
            else:
                search_candidate_better = (
                    best_metrics is None
                    or _teacher_session_opt_goal_aware_better(
                        metrics,
                        best_metrics,
                        target_teacher_sessions=target_teacher_sessions,
                        target_gap1_sessions=(target_gap1_sessions if quality_gap1_first else None),
                        accept_teacher_sessions=accept_teacher_sessions,
                        accept_gap1_sessions=accept_gap1_sessions,
                        enforce_balanced_envelope=balanced_quality_envelope,
                    )
                )
            if search_candidate_better:
                best_payload = candidate
                best_metrics = metrics
                candidate_improved = True
                last_improvement_at = time.monotonic()
                stagnant_attempts = 0
                summary["new_best"] = visible_candidate_improved or not refinement_frontier_enabled
                if refinement_frontier_enabled and not visible_candidate_improved:
                    summary["new_search_frontier"] = True
                lower_cap_failed = False
                relaxed_polish_index = 0
                polish_index = 0
                best_sessions = _metric_int(metrics, "teacher_sessions", upper_cap)
                gap_priority_queue = [
                    item
                    for item in _refinement_gap_priority_attempts(
                        metrics,
                        target_gap1_sessions=(
                            target_gap1_sessions if adaptive_gap_target_only else None
                        ),
                        preferred_cap=(
                            accept_teacher_sessions if adaptive_gap_target_only else None
                        ),
                        accept_gap1_sessions=accept_gap1_sessions,
                        lower_cap=lower_cap,
                        upper_cap=upper_cap,
                        polish_seeds=polish_seeds,
                        session_first=refinement_frontier_enabled,
                        force_lower_session_first=(
                            refinement_frontier_enabled
                            and previous_search_sessions is not None
                            and best_sessions >= previous_search_sessions
                        ),
                    )
                    if int(item[1]) not in consumed_refinement_seeds
                ]
                if adaptive_gap_target_only:
                    same_cap_polish_queue = []
                else:
                    repeat_candidates = [
                        (cap, None, "repeat:1"),
                        (cap, None, "repeat:2"),
                    ]
                    seeded_candidates = [(cap, seed, f"seed:{seed}") for seed in polish_seeds[:2]]
                    same_cap_polish_queue = (
                        [*seeded_candidates, *repeat_candidates]
                        if adaptive_teacher_session_opt
                        else [*repeat_candidates, *seeded_candidates]
                    )
                next_tight_cap = best_sessions - 1
                if next_tight_cap >= lower_cap and (next_tight_cap, "default") not in tried_attempts:
                    caps_queue = [next_tight_cap]
                if progress:
                    progress(
                        {
                            "stage": "teacher_session_opt:best",
                            "message": "Da co ung vien sap xep tot hon",
                            "phase": phase,
                            "cap": cap,
                            "teacher_sessions": metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": metrics.get("gap_distribution"),
                        }
                    )
                if (
                    phase == "existing_strict_wide_quality_cleanup"
                    and strict_existing_quality_cleanup_requires_period_bridge
                    and strict_existing_quality_cleanup_seed_index < len(polish_seeds)
                    and not _teacher_session_opt_good_enough(
                        metrics,
                        accept_teacher_sessions=accept_teacher_sessions,
                        accept_gap1_sessions=accept_gap1_sessions,
                    )
                ):
                    followup_remaining = deadline.remaining()
                    if followup_remaining is None:
                        followup_remaining = total_limit - (time.monotonic() - started)
                    if followup_remaining >= 45:
                        strict_existing_quality_cleanup_pending = True
                        summary["strict_wide_followup_pending"] = True
        else:
            summary["accepted"] = False
            if _complete_payload_metrics_acceptable(candidate):
                summary["reject_reason"] = "teacher_sessions_above_attempt_cap"
            else:
                summary["reject_reason"] = "incomplete_or_best_effort"
            if best_metrics is not None and cap < _metric_int(best_metrics, "teacher_sessions", upper_cap):
                lower_cap_failed = True
        attempts.append(summary)
        if visible_candidate_improved and not candidate_improved:
            last_improvement_at = time.monotonic()
            stagnant_attempts = 0
        if (
            adaptive_teacher_session_opt
            and not candidate_improved
            and not visible_candidate_improved
            and best_metrics is not None
        ):
            stagnant_attempts += 1

        if not continue_quality_search and best_metrics is not None and _teacher_session_opt_target_met(
            best_metrics,
            target_teacher_sessions=target_teacher_sessions,
            target_gap1_sessions=target_gap1_sessions,
        ):
            termination_reason = (
                "lower_bound_reached"
                if _metric_int(best_metrics, "teacher_sessions", upper_cap) <= lower_cap
                else "target_reached"
            )
            break
        if (
            not continue_quality_search
            and
            best_metrics is not None
            and target_teacher_sessions is None
            and target_gap1_sessions is None
            and _teacher_session_opt_good_enough(
                best_metrics,
                accept_teacher_sessions=accept_teacher_sessions,
                accept_gap1_sessions=accept_gap1_sessions,
            )
        ):
            attempts.append(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "good_enough_candidate_accepted",
                    "teacher_sessions": best_metrics.get("teacher_sessions"),
                    "one_period_teacher_sessions": best_metrics.get("one_period_teacher_sessions"),
                    "gap_distribution": best_metrics.get("gap_distribution"),
                    "accept_teacher_sessions": accept_teacher_sessions,
                    "accept_gap1_sessions": accept_gap1_sessions,
                }
            )
            termination_reason = "accept_threshold_reached"
            break
        if (
            best_metrics is not None
            and _metric_int(best_metrics, "teacher_sessions", upper_cap) <= lower_cap
            and _metric_int(best_metrics, "one_period_teacher_sessions", 10**9) == 0
            and _teacher_session_opt_gap1(best_metrics) == 0
        ):
            termination_reason = "lower_bound_reached"
            break

    if best_payload is None or best_metrics is None:
        detail = {
            "target_teacher_sessions": target_teacher_sessions,
            "target_gap1_sessions": target_gap1_sessions,
            "adaptive_bounds": dict(bounds),
            "attempts": attempts,
        }
        raise RuntimeError(
            "Teacher session optimization did not find a complete timetable: "
            + json.dumps(detail, ensure_ascii=False, default=str)
        )

    final_gap_target_cleanup = (
        refinement_frontier_enabled
        and strict_existing_quality_cleanup_requires_period_bridge
        and total_limit >= 150
        and best_metrics is not None
        and _teacher_session_opt_quality_gates_clean(best_metrics)
        and target_gap1_sessions is not None
        and _teacher_session_opt_gap1(best_metrics) > int(target_gap1_sessions)
    )
    if (
        refinement_frontier_enabled
        and best_payload is not None
        and visible_best_payload is not None
        and (
            best_payload is not visible_best_payload
            or final_gap_target_cleanup
        )
    ):
        cleanup_remaining = deadline.remaining()
        cleanup_budget = min(
            float(frontier_cleanup_reserve),
            max(0.0, float(cleanup_remaining or 0.0) - 2.0),
        )
        if cleanup_budget >= 1.0:
            cleanup_started = time.monotonic()
            cleanup_error: Exception | None = None
            cleanup_result: tuple[dict[str, Any], list[dict[str, Any]]] | None = None
            try:
                cleanup_result = _polish_complete_incumbent_with_local_lns(
                    ui_data,
                    settings,
                    bound_ctx,
                    best_payload,
                    rules=rules,
                    polish_seeds=polish_seeds,
                    time_limit_seconds=cleanup_budget,
                    operator_learning=(
                        refinement_strategy_meta.get("refinement_learning")
                        if isinstance(refinement_strategy_meta, Mapping)
                        else None
                    ),
                    gap1_cleanup_cap=(
                        _teacher_session_opt_gap1(visible_best_metrics)
                        if visible_best_metrics is not None
                        else None
                    ),
                    protected_cleanup_budget=True,
                )
            except Exception as exc:  # noqa: BLE001 - visible incumbent is retained below.
                cleanup_error = exc
            cleanup_elapsed = time.monotonic() - cleanup_started
            cleanup_summary: dict[str, Any] = {
                "ok": cleanup_error is None,
                "phase": "existing_frontier_gap_cleanup",
                "attempt_key": "existing:frontier_gap_cleanup",
                "elapsed_seconds": round(cleanup_elapsed, 3),
                "time_limit_seconds": round(cleanup_budget, 3),
            }
            if cleanup_result is not None:
                cleanup_candidate, cleanup_passes = cleanup_result
                cleanup_metrics = (
                    cleanup_candidate.get("metrics")
                    if isinstance(cleanup_candidate.get("metrics"), Mapping)
                    else {}
                )
                cleanup_summary.update(
                    {
                        "teacher_quality_lns": cleanup_passes,
                        "teacher_sessions": cleanup_metrics.get("teacher_sessions"),
                        "gap_distribution": cleanup_metrics.get("gap_distribution"),
                    }
                )
                if _teacher_session_opt_frontier_better(cleanup_metrics, best_metrics):
                    best_payload = cleanup_candidate
                    best_metrics = cleanup_metrics
                    cleanup_summary["new_search_frontier"] = True
                    if (
                        visible_best_metrics is None
                        or _incremental_refinement_candidate_better(
                            cleanup_metrics,
                            visible_best_metrics,
                        )
                    ):
                        visible_best_payload = cleanup_candidate
                        visible_best_metrics = cleanup_metrics
                        cleanup_summary["new_visible_best"] = True
                else:
                    cleanup_summary["improved"] = False
            elif cleanup_error is not None:
                cleanup_summary["error"] = str(cleanup_error)
            else:
                cleanup_summary["skipped"] = True
                cleanup_summary["reason"] = "frontier_cleanup_no_pareto_improvement"
                cleanup_summary["budget_exhausted"] = cleanup_elapsed >= max(
                    0.0,
                    cleanup_budget - 0.25,
                )
            attempts.append(cleanup_summary)

    exploration_frontier: dict[str, Any] | None = None
    if (
        refinement_frontier_enabled
        and visible_best_payload is not None
        and visible_best_metrics is not None
    ):
        exploration_frontier = {
            "teacher_sessions": _metric_int(best_metrics, "teacher_sessions", 10**9),
            "gap1_sessions": _teacher_session_opt_gap1(best_metrics),
            "one_period_teacher_sessions": _metric_int(
                best_metrics,
                "one_period_teacher_sessions",
                10**9,
            ),
            "gap2_plus_sessions": _teacher_session_opt_gap2_plus(best_metrics),
            "returned_visible_incumbent": best_payload is not visible_best_payload,
        }
        best_payload = visible_best_payload
        best_metrics = visible_best_metrics

    best_teacher_sessions = _metric_int(best_metrics, "teacher_sessions", upper_cap)
    teacher_session_excess = max(0, best_teacher_sessions - lower_cap)
    teacher_session_optimal = best_teacher_sessions <= lower_cap
    target_met = _teacher_session_opt_target_met(
        best_metrics,
        target_teacher_sessions=target_teacher_sessions,
        target_gap1_sessions=target_gap1_sessions,
    )
    good_enough_met = _teacher_session_opt_good_enough(
        best_metrics,
        accept_teacher_sessions=accept_teacher_sessions,
        accept_gap1_sessions=accept_gap1_sessions,
    )
    # A short incumbent polish can set an initial descriptive reason before
    # the global portfolio starts.  Once that portfolio actually runs, expose
    # its terminal state instead of reporting the stale local-LNS reason; this
    # makes a full-budget continuation distinguishable from an early plateau.
    if search_end_reason in {
        "time_budget_exhausted",
        "search_exhausted",
        "accept_fallback_after_stagnation",
        "existing_good_enough_early_stop",
        "frontier_gap_cleanup_reserved",
    }:
        termination_reason = search_end_reason
    elif termination_reason is None:
        if target_met:
            termination_reason = "lower_bound_reached" if teacher_session_optimal else "target_reached"
        elif search_end_reason == "time_budget_exhausted":
            termination_reason = (
                "accept_fallback_after_time_budget" if good_enough_met else "time_budget_exhausted"
            )
        elif good_enough_met:
            termination_reason = "accept_fallback_after_search"
        else:
            termination_reason = search_end_reason or "best_available_after_search"

    solver = best_payload.setdefault("solver", {})
    runtime = solver.setdefault("runtime_settings", {})
    runtime["auto_sort_mode"] = "teacher_session_opt"
    runtime["adaptive_teacher_session_opt"] = adaptive_teacher_session_opt
    quality_priority_order = str(settings.get("quality_priority_order") or "").strip().casefold()
    if quality_priority_order:
        runtime["quality_priority_order"] = quality_priority_order
    if target_teacher_sessions is not None:
        runtime["target_teacher_sessions"] = target_teacher_sessions
    else:
        runtime.pop("target_teacher_sessions", None)
    if target_gap1_sessions is not None:
        runtime["target_gap1_sessions"] = target_gap1_sessions
    else:
        runtime.pop("target_gap1_sessions", None)
    runtime["adaptive_teacher_session_bounds"] = dict(bounds)
    runtime["optimization_time_limit_seconds"] = total_limit
    runtime["optimization_elapsed_seconds"] = round(time.monotonic() - started, 3)
    runtime["optimization_termination_reason"] = termination_reason
    runtime["optimization_refinement_round"] = max(
        0,
        _to_int(settings.get("optimization_refinement_round"), 0),
    )
    solver["teacher_session_optimization"] = {
        "mode": "teacher_session_opt",
        "adaptive": adaptive_teacher_session_opt,
        "quality_priority_order": quality_priority_order or None,
        "target_teacher_sessions": target_teacher_sessions,
        "target_gap1_sessions": target_gap1_sessions,
        "time_limit_seconds": total_limit,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "bounds": dict(bounds),
        "attempts": attempts,
        "best_quality": list(
            _teacher_session_opt_quality(
                best_metrics,
                gap1_first=quality_gap1_first,
            )
        ),
        "target_met": target_met,
        "good_enough_met": good_enough_met,
        "accept_teacher_sessions": accept_teacher_sessions,
        "accept_gap1_sessions": accept_gap1_sessions,
        "lower_bound": lower_cap,
        "excess": teacher_session_excess,
        "optimal": teacher_session_optimal,
        "termination_reason": termination_reason,
        "search_end_reason": search_end_reason,
        "stagnant_attempts": stagnant_attempts,
        "adaptive_time_limit_seconds": adaptive_total_ceiling if adaptive_teacher_session_opt else None,
        "first_cap_time_limit_seconds": first_cap_limit,
        "retry_cap_time_limit_seconds": retry_cap_limit,
        "polish_cap_time_limit_seconds": polish_cap_limit,
        "exploration_frontier": exploration_frontier,
    }
    if refinement_strategy_meta is not None:
        solver["teacher_session_optimization"]["refinement_strategy"] = dict(
            refinement_strategy_meta
        )
        refinement_learning = refinement_strategy_meta.get("refinement_learning")
        if isinstance(refinement_learning, Mapping):
            solver["teacher_session_optimization"]["refinement_learning"] = dict(
                refinement_learning
            )
            runtime["refinement_learning"] = dict(refinement_learning)
    payload_metrics = best_payload.setdefault("metrics", {})
    payload_metrics.update(
        {
            "auto_sort_mode": "teacher_session_opt",
            "quality_priority_order": quality_priority_order or None,
            "teacher_session_lower_bound": lower_cap,
            "teacher_session_excess": teacher_session_excess,
            "teacher_session_optimal": teacher_session_optimal,
            "teacher_session_termination_reason": termination_reason,
            "optimization_refinement_round": runtime["optimization_refinement_round"],
        }
    )
    warnings = best_payload.setdefault("warnings", [])
    validation = best_payload.setdefault("validation", {})
    validation_warnings = validation.setdefault("warnings", [])
    if (target_teacher_sessions is not None or target_gap1_sessions is not None) and not target_met:
        message = (
            f"Toi uu buoi GV da tra lich day du tot nhat trong {total_limit}s: "
            f"{best_metrics.get('teacher_sessions')} buoi GV, "
            f"{best_metrics.get('one_period_teacher_sessions')} buoi 1 tiet, "
            f"gap={best_metrics.get('gap_distribution')}."
        )
        warnings.append(message)
        validation_warnings.append(message)
    if progress:
        progress(
            {
                "stage": "teacher_session_opt:done",
                "message": "Hoan tat sap xep TKB",
                "teacher_sessions": best_metrics.get("teacher_sessions"),
                "one_period_teacher_sessions": best_metrics.get("one_period_teacher_sessions"),
                "gap_distribution": best_metrics.get("gap_distribution"),
            }
        )
    return best_payload


def solve_from_ui_data(
    ui_data: dict[str, Any],
    settings: dict[str, Any] | None = None,
    *,
    rules: TimetableRuleSet | None = None,
    progress: ProgressFn | None = None,
    out_dir: str | Path | None = None,
    _deadline: SolverDeadline | None = None,
) -> dict[str, Any]:
    settings = settings or {}
    normalized_request_seed = normalize_cp_sat_seed(settings.get("random_seed"))
    if normalized_request_seed is not None:
        settings["random_seed"] = normalized_request_seed
    else:
        settings.pop("random_seed", None)
    normalized_variant_seed = normalize_cp_sat_seed(settings.get("quality_variant_seed"))
    if normalized_variant_seed is not None:
        settings["quality_variant_seed"] = normalized_variant_seed
    else:
        settings.pop("quality_variant_seed", None)
    if _deadline is None:
        requested_deadlines = [
            value
            for value in (
                _to_int(settings.get("overall_time_limit_seconds"), 0),
                _to_int(settings.get("optimization_time_limit_seconds"), 0),
            )
            if value > 0
        ]
        _deadline = SolverDeadline(min(requested_deadlines) if requested_deadlines else None)
    early_auto_sort_mode = _normalized_auto_sort_mode(settings)
    early_auto_sort_strategy = str(settings.get("auto_sort_strategy", "")).strip().casefold()
    early_preserve_existing = (
        _truthy_setting(settings.get("preserve_existing_tkb"))
        or early_auto_sort_strategy in {"preserve_existing", "preserve-existing", "preserve"}
    )
    early_preserve_fixed_only = (
        _truthy_setting(settings.get("preserve_fixed_lessons_only"))
        or _truthy_setting(ui_data.get("__tkbRequestFixedScheduleOnly"))
    )
    early_fresh_rebuild = (
        not early_preserve_existing
        and (
            early_auto_sort_strategy.startswith("fresh")
            or early_auto_sort_mode in {"fast", "teacher_session_opt"}
            or _truthy_setting(settings.get("partial_existing_rebuild"))
        )
    )
    if early_fresh_rebuild:
        ui_data = _strip_schedule_artifacts_for_fresh_solve(
            ui_data,
            preserve_fixed_lessons_only=early_preserve_fixed_only,
        )
    fast_quality_warmup_direct = _truthy_setting(settings.get("fast_quality_warmup_direct"))
    if (
        fast_quality_warmup_direct
        and not _truthy_setting(settings.get("_teacher_session_opt_inner"))
        and _normalized_auto_sort_mode(settings) == "fast"
    ):
        fast_settings, bounds = _fast_quality_warmup_direct_settings(ui_data, settings)
        tight_fixed_off_profile = _fast_benders_tight_fixed_off_profile(
            ui_data,
            settings,
            rules=rules,
            bounds=bounds,
        )
        if tight_fixed_off_profile is not None:
            benders_started = time.monotonic()
            try:
                return _solve_fast_tight_fixed_off_benders(
                    ui_data,
                    settings,
                    bounds=bounds,
                    profile=tight_fixed_off_profile,
                    rules=rules,
                    progress=progress,
                    deadline=_deadline,
                )
            except RuntimeError as benders_error:
                benders_detail = getattr(benders_error, "fast_benders_detail", None)
                if not isinstance(benders_detail, Mapping):
                    raise
                requested_total = _to_int(settings.get("overall_time_limit_seconds"), 0)
                if requested_total <= 0:
                    requested_total = max(45, _to_int(benders_detail.get("time_limit_seconds"), 115))
                benders_elapsed = time.monotonic() - benders_started
                remaining = int(requested_total - benders_elapsed)
                deadline_remaining = _deadline.remaining()
                if deadline_remaining is not None:
                    remaining = min(remaining, max(0, int(deadline_remaining)))
                if remaining < 8:
                    raise
                fallback_settings = dict(fast_settings)
                fallback_cap = max(1, _to_int(fallback_settings.get("max_teacher_sessions"), 1))
                fallback_period_limit = max(12, min(30, remaining // 3))
                fallback_session_limit = max(18, min(30, remaining // 3))
                fallback_ctx = build_school_data_from_ui(ui_data)
                fallback_seeds = _school_seed_sequence(fallback_ctx.school_data, 2)
                fallback_settings.update(
                    {
                        "fast_quality_warmup_direct": False,
                        "auto_sort_strategy": "fresh_fast_quality_after_benders",
                        "overall_time_limit_seconds": remaining,
                        "integrated_time_limit": remaining,
                        "optimization_time_limit_seconds": remaining,
                        "session_time_limit": fallback_session_limit,
                        "period_time_limit": fallback_period_limit,
                        "period_fast_time_limit": fallback_period_limit,
                        "period_retry_time_limit": fallback_period_limit,
                        "session_early_stop_enabled": True,
                        "session_early_stop_teacher_sessions": fallback_cap,
                        "session_early_stop_max_one_period_sessions": 0,
                        "aggressive_fast_mode": False,
                        "deep_session_rescue": True,
                        "fresh_randomize": True,
                        "randomize_search": True,
                        "random_seed": fallback_seeds[-1] if fallback_seeds else 17,
                    }
                )
                if progress:
                    progress(
                        {
                            "stage": "fast_benders:generic_fallback",
                            "message": "Benders da het ngan sach; dang thu duong Fast tuong thich cuoi",
                            "time_limit_seconds": remaining,
                            "cap": fallback_cap,
                        }
                    )
                payload = solve_from_ui_data(
                    ui_data,
                    fallback_settings,
                    rules=rules,
                    progress=progress,
                    out_dir=out_dir,
                    _deadline=_deadline,
                )
                if not _complete_payload_metrics_acceptable(payload):
                    raise benders_error
                solver_meta = payload.setdefault("solver", {})
                fallback_meta = dict(benders_detail)
                fallback_meta.update(
                    {
                        "fallback_used": True,
                        "fallback_profile": "quality_warmup_direct",
                        "fallback_cap": fallback_cap,
                        "fallback_time_limit_seconds": remaining,
                        "fallback_elapsed_seconds": round(time.monotonic() - benders_started - benders_elapsed, 3),
                    }
                )
                solver_meta["fast_profile"] = "quality_warmup_direct_after_benders"
                solver_meta["fast_profile_bounds"] = dict(bounds)
                solver_meta["fast_benders_feasibility"] = fallback_meta
                runtime_meta = solver_meta.setdefault("runtime_settings", {})
                runtime_meta["fast_profile"] = "quality_warmup_direct_after_benders"
                payload.setdefault("warnings", []).append(
                    "Fast Benders het ngan sach; da tra lich day du bang duong Fast tuong thich trong phan deadline con lai."
                )
                return payload
        payload = solve_from_ui_data(
            ui_data,
            fast_settings,
            rules=rules,
            progress=progress,
            out_dir=out_dir,
            _deadline=_deadline,
        )
        solver_meta = payload.get("solver")
        if isinstance(solver_meta, dict):
            solver_meta["fast_profile"] = "quality_warmup_direct"
            solver_meta["fast_profile_bounds"] = dict(bounds)
        return payload
    if _is_teacher_session_opt_mode(settings) and not _truthy_setting(settings.get("_teacher_session_opt_inner")):
        return _solve_teacher_session_optimized_from_ui_data(
            ui_data,
            settings,
            rules=rules,
            progress=progress,
            out_dir=out_dir,
            deadline=_deadline,
        )
    auto_sort_mode = _normalized_auto_sort_mode(settings)
    strict_teacher_session_cap = _truthy_setting(settings.get("strict_teacher_session_cap")) or (
        _truthy_setting(settings.get("_teacher_session_opt_inner"))
        and not _truthy_setting(settings.get("_teacher_session_opt_fast_quality_warmup"))
    )
    max_teacher_sessions = _to_int(settings.get("max_teacher_sessions"), 180)
    requested_max_teacher_sessions = _to_int(settings.get("requested_max_teacher_sessions"), max_teacher_sessions)
    session_time_limit = _to_int(settings.get("session_time_limit"), 120)
    requested_period_time_limit = _to_int(settings.get("period_time_limit"), 120)
    overall_time_limit_seconds = _to_int(settings.get("overall_time_limit_seconds"), 0)
    deadline = _deadline.bounded(overall_time_limit_seconds)
    best_effort_on_timeout = str(settings.get("best_effort_on_timeout", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    require_complete_schedule = str(settings.get("require_complete_schedule", "1")).strip().casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    period_fast_time_limit = _to_int(settings.get("period_fast_time_limit"), 4)
    period_retry_time_limit = _to_int(settings.get("period_retry_time_limit"), 10)
    period_time_limit = max(1, min(requested_period_time_limit, period_fast_time_limit or requested_period_time_limit))
    period_phase_reserve_seconds = max(12.0, float(period_retry_time_limit + 4))
    integrated_time_limit = _to_int(settings.get("integrated_time_limit"), max(240, session_time_limit))
    random_seed = normalize_cp_sat_seed(settings.get("random_seed"))
    solver_mode = str(settings.get("solver_mode", "auto")).casefold()
    auto_sort_strategy = str(settings.get("auto_sort_strategy", "")).strip().casefold()
    fresh_randomize = _truthy_setting(settings.get("fresh_randomize")) or auto_sort_strategy in {
        "random",
        "randomize",
        "fresh_randomize",
        "fresh-randomize",
    }
    fresh_randomize_strategy = str(settings.get("fresh_randomize_strategy", "")).strip().casefold().replace("-", "_")
    prefer_hint_variant_randomize = fresh_randomize and fresh_randomize_strategy in {
        "hint_variant",
        "validated_hint",
        "validated_period_hint",
        "period_hint_variant",
    }
    preserve_existing_tkb = (
        _truthy_setting(settings.get("preserve_existing_tkb"))
        or auto_sort_strategy in {"preserve_existing", "preserve-existing", "preserve"}
    )
    preserve_fixed_lessons_only = (
        _truthy_setting(settings.get("preserve_fixed_lessons_only"))
        or _truthy_setting(ui_data.get("__tkbRequestFixedScheduleOnly"))
    )
    fresh_rebuild_request = (
        not preserve_existing_tkb
        and (
            auto_sort_strategy.startswith("fresh")
            or auto_sort_mode in {"fast", "teacher_session_opt"}
            or _truthy_setting(settings.get("partial_existing_rebuild"))
        )
    )
    if fresh_rebuild_request and not _truthy_setting(ui_data.get("__tkbBackendStrippedSchedule")):
        ui_data = _strip_schedule_artifacts_for_fresh_solve(
            ui_data,
            preserve_fixed_lessons_only=preserve_fixed_lessons_only,
        )
    if (
        random_seed is None
        and solver_mode == "auto"
        and not fresh_randomize
        and _truthy_setting(settings.get("deterministic_auto_seed", "1"))
    ):
        random_seed = normalize_cp_sat_seed(settings.get("default_random_seed")) or 1
    exact_teacher_sessions = str(settings.get("exact_teacher_sessions", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    minimize_sessions = str(settings.get("minimize_sessions", "")).casefold() in {"1", "true", "on", "yes"}
    allow_one_period_gaps = str(settings.get("allow_one_period_gaps", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    search_teacher_sessions = str(settings.get("search_teacher_sessions", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    solver_workers = _solver_worker_count(settings)
    session_linearization_level = _session_cp_sat_linearization_level(settings)
    minimize_one_period_sessions = str(settings.get("minimize_one_period_sessions", "1")).casefold() in {
        "1",
        "true",
        "on",
        "yes",
    }
    one_period_priority_absolute = str(settings.get("one_period_priority_absolute", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    raw_max_one_period_sessions = settings.get(
        "max_one_period_sessions",
        settings.get("max_one_period_teacher_sessions"),
    )
    if raw_max_one_period_sessions is None or raw_max_one_period_sessions == "":
        max_one_period_sessions = 0 if minimize_one_period_sessions else None
    elif str(raw_max_one_period_sessions).strip().casefold() in {"none", "null", "off", "false", "no"}:
        max_one_period_sessions = None
    else:
        max_one_period_sessions = max(0, _to_int(raw_max_one_period_sessions, 0))
    strict_one_period_sessions_cap = _truthy_setting(
        settings.get(
            "strict_one_period_sessions_cap",
            settings.get("enforce_max_one_period_sessions", max_one_period_sessions is not None),
        )
    )
    session_early_stop_teacher_sessions = _positive_setting(
        settings,
        "session_early_stop_teacher_sessions",
    )
    if (
        session_early_stop_teacher_sessions is None
        and auto_sort_mode == "fast"
        and str(settings.get("ui_solver_preset") or "").strip().casefold() == "fast"
    ):
        session_early_stop_teacher_sessions = _positive_setting(settings, "target_teacher_sessions")
    session_early_stop_max_one_period_sessions = _nonnegative_setting(
        settings,
        "session_early_stop_max_one_period_sessions",
    )
    if not _truthy_setting(settings.get("session_early_stop_enabled", "1")):
        session_early_stop_teacher_sessions = None
        session_early_stop_max_one_period_sessions = None
    if session_early_stop_teacher_sessions is not None and session_early_stop_max_one_period_sessions is None:
        session_early_stop_max_one_period_sessions = max_one_period_sessions
    period_max_teacher_gap = _period_max_teacher_gap_setting(
        settings,
        default=1 if allow_one_period_gaps else 0,
    )
    relax_period_teacher_gap_on_failure = _truthy_setting(settings.get("relax_period_teacher_gap_on_failure", "0"))
    period_minimize_teacher_gaps = str(settings.get("minimize_teacher_gaps", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    aggressive_fast_mode = str(settings.get("aggressive_fast_mode", "1")).casefold() not in {
        "0",
        "false",
        "off",
        "no",
    }
    original_ctx = build_school_data_from_ui(ui_data)
    effective_rules = rules or original_ctx.rules
    report_rules = effective_rules
    fixed_existing_lessons: list[Lesson] = []
    hard_fixed_lessons: list[Lesson] = []
    must_teach_anchor_lessons: list[Lesson] = []
    ignored_partial_existing_lessons = 0
    preserve_existing_min_ratio = max(0.0, min(1.0, _to_float(settings.get("preserve_existing_min_ratio"), 0.85)))
    if preserve_fixed_lessons_only:
        hard_fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, original_ctx)
        original_ctx.warnings.extend(fixed_warnings)
        hard_fixed_lessons, released_warnings = _release_invalid_fixed_lessons(
            original_ctx.school_data,
            hard_fixed_lessons,
            effective_rules,
            release_constraint_violations=False,
        )
        original_ctx.warnings.extend(released_warnings)
    if not preserve_existing_tkb:
        must_teach_anchor_lessons, must_teach_anchor_warnings = _anchor_teacher_must_teach_lessons(
            original_ctx,
            effective_rules,
            hard_fixed_lessons,
        )
        original_ctx.warnings.extend(must_teach_anchor_warnings)
        if must_teach_anchor_lessons:
            hard_fixed_lessons = [*hard_fixed_lessons, *must_teach_anchor_lessons]
            preserve_fixed_lessons_only = True
    fixed_existing_lessons = list(hard_fixed_lessons)
    if hard_fixed_lessons and preserve_fixed_lessons_only:
        effective_rules = _rule_set_with_fixed_lesson_slots(effective_rules, hard_fixed_lessons)
    solver_source_ctx = (
        _context_without_fixed_lesson_demand(original_ctx, hard_fixed_lessons)
        if preserve_fixed_lessons_only and hard_fixed_lessons
        else original_ctx
    )
    has_class_extra_slots = bool(
        effective_rules.constraints is not None
        and getattr(effective_rules.constraints, "class_extra_slots", {})
    )
    ctx, unassigned_lessons = _trim_context_to_available_slots(solver_source_ctx, effective_rules, settings)
    capacity_excluded_lessons = list(unassigned_lessons)
    capacity_excluded_periods = sum(int(item.get("periods") or 0) for item in capacity_excluded_lessons)
    capacity_limited_fast_lane = False
    original_expected_periods = sum(item.periods_per_week for item in original_ctx.school_data.assignments)
    raw_capacity_fast_lane = settings.get("capacity_limited_fast_lane", "auto")
    explicit_capacity_fast_lane = str(raw_capacity_fast_lane).strip().casefold() not in {"", "auto", "default"}
    capacity_fast_lane_threshold = max(8, int(max(1, original_expected_periods) * 0.015))
    use_capacity_fast_lane = (
        _truthy_setting(raw_capacity_fast_lane)
        if explicit_capacity_fast_lane
        else capacity_excluded_periods >= capacity_fast_lane_threshold
    )
    if capacity_excluded_periods and use_capacity_fast_lane:
        capacity_limited_fast_lane = True
        solver_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
        capacity_session_limit = max(
            8,
            _to_int(settings.get("capacity_limited_session_time_limit"), 24 if solver_periods >= 600 else 12),
        )
        capacity_period_limit = max(
            8,
            _to_int(settings.get("capacity_limited_period_time_limit"), 30 if solver_periods >= 600 else 14),
        )
        capacity_overall_limit = max(
            25,
            _to_int(settings.get("capacity_limited_overall_time_limit_seconds"), 45 if solver_periods >= 600 else 30),
        )
        capacity_retry_limit = max(
            4,
            _to_int(settings.get("capacity_limited_period_retry_time_limit"), min(capacity_period_limit, 12)),
        )
        session_time_limit = max(4, min(session_time_limit or capacity_session_limit, capacity_session_limit))
        requested_period_time_limit = max(4, min(requested_period_time_limit or capacity_period_limit, capacity_period_limit))
        period_time_limit = max(4, min(period_time_limit or capacity_period_limit, capacity_period_limit))
        period_retry_time_limit = max(2, min(period_retry_time_limit or capacity_retry_limit, capacity_retry_limit))
        period_phase_reserve_seconds = max(8.0, float(period_retry_time_limit + 4))
        integrated_time_limit = max(10, min(integrated_time_limit or capacity_overall_limit, capacity_overall_limit))
        overall_time_limit_seconds = max(10, min(overall_time_limit_seconds or capacity_overall_limit, capacity_overall_limit))
        deadline = deadline.bounded(overall_time_limit_seconds)
        ctx.warnings.append(
            f"Da dua {capacity_excluded_periods} tiet du do thieu o vao Tiet chua phan; "
            "xem phan con lai la bai toan day du de xep nhanh hon."
        )
    elif capacity_excluded_periods:
        ctx.warnings.append(
            f"Da dua {capacity_excluded_periods} tiet du do thieu o vao Tiet chua phan; "
            "tiep tuc xep phan con lai voi ngan sach thoi gian binh thuong."
        )
    if preserve_existing_tkb:
        full_existing_lessons, fixed_warnings = _extract_fixed_lessons_from_tkb(ui_data, original_ctx)
        ctx.warnings.extend(fixed_warnings)
        fixed_existing_lessons = _lessons_without_fixed_instances(
            full_existing_lessons,
            hard_fixed_lessons,
        )
        fixed_existing_lessons, released_warnings = _release_invalid_fixed_lessons(
            ctx.school_data,
            fixed_existing_lessons,
            effective_rules,
            protected_lessons=hard_fixed_lessons,
        )
        ctx.warnings.extend(released_warnings)
        expected_existing_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
        if (
            fixed_existing_lessons
            and expected_existing_periods > 0
            and len(fixed_existing_lessons) < expected_existing_periods
            and len(fixed_existing_lessons) / expected_existing_periods < preserve_existing_min_ratio
            and not _truthy_setting(settings.get("force_preserve_partial_existing"))
        ):
            ignored_partial_existing_lessons = len(fixed_existing_lessons)
            ctx.warnings.append(
                f"Da xem {ignored_partial_existing_lessons} tiet cu la lich tam qua it; "
                f"xep moi de dat toi da {expected_existing_periods} tiet truoc khi toi uu."
            )
            fixed_existing_lessons = []
            preserve_existing_tkb = False
            auto_sort_strategy = "fresh_from_sparse_existing"
    fixed_existing_lessons_are_hard = bool(preserve_fixed_lessons_only and hard_fixed_lessons)
    session_fixed_lessons = hard_fixed_lessons if fixed_existing_lessons_are_hard else []
    soft_existing_incumbent_lessons = (
        list(fixed_existing_lessons)
        if fixed_existing_lessons
        else []
    )
    full_existing_incumbent_lessons = _merge_fixed_lessons_into_solution(
        soft_existing_incumbent_lessons,
        hard_fixed_lessons,
    )
    residual_validation_rules = (
        _rule_set_for_residual_fixed_lesson_validation(effective_rules, hard_fixed_lessons)
        if fixed_existing_lessons_are_hard
        else effective_rules
    )

    def compute_solution_metrics(residual_lessons: list[Lesson]) -> dict[str, Any]:
        """Measure quality on the real timetable, including hard lessons."""

        if not fixed_existing_lessons_are_hard:
            return compute_metrics(ctx.school_data, residual_lessons, rules=effective_rules)
        full_lessons = _merge_fixed_lessons_into_solution(residual_lessons, hard_fixed_lessons)
        return compute_metrics(original_ctx.school_data, full_lessons, rules=report_rules)

    prefer_session_priority_search = (
        solver_mode == "auto"
        and minimize_sessions
        and search_teacher_sessions
        and allow_one_period_gaps
        and not preserve_existing_tkb
        and not prefer_hint_variant_randomize
    )
    class_fixed_base_hint: tuple[list[SessionAllocation], dict[str, Any]] | None = None
    use_class_fixed_base_hint = False
    if use_class_fixed_base_hint and solver_mode == "auto" and not fixed_existing_lessons and not fresh_randomize and not capacity_excluded_lessons and not has_class_extra_slots:
        adjusted = _adjust_base_hint_for_class_fixed_off(original_ctx, effective_rules, settings)
        if adjusted is not None:
            ctx, adjusted_allocations, unassigned_lessons, adjusted_session_metrics = adjusted
            class_fixed_base_hint = (adjusted_allocations, adjusted_session_metrics)
    if progress:
        progress(
            {
                "stage": "input:loaded",
                "message": "Đã chuyển DATA của UI gốc sang dữ liệu optimizer",
                "classes": len(original_ctx.school_data.classes),
                "teachers": len(original_ctx.school_data.teachers),
                "assignments": len(original_ctx.school_data.assignments),
                "expected_periods": sum(item.periods_per_week for item in original_ctx.school_data.assignments),
                "unassigned_periods": sum(item["periods"] for item in unassigned_lessons),
                "capacity_excluded_periods": capacity_excluded_periods,
                "capacity_limited_fast_lane": capacity_limited_fast_lane,
                "fixed_existing_lessons": len(fixed_existing_lessons),
                "auto_sort_mode": auto_sort_mode,
                "auto_sort_strategy": auto_sort_strategy,
                "solver_workers": solver_workers,
                "period_max_teacher_gap": period_max_teacher_gap,
                "period_minimize_teacher_gaps": period_minimize_teacher_gaps,
                "overall_time_limit_seconds": overall_time_limit_seconds,
                "best_effort_on_timeout": best_effort_on_timeout,
            }
        )

    constraints_active = effective_rules.constraints is not None and effective_rules.constraints.active

    def try_relaxed_period_gap_repair(
        allocations: list[SessionAllocation],
        failed_period_metrics: Mapping[str, Any],
        reason: str,
    ) -> tuple[list[Lesson], dict[str, Any]] | None:
        failures = (
            failed_period_metrics.get("best_effort_failed_sessions", [])
            if isinstance(failed_period_metrics, Mapping)
            else []
        )
        if not relax_period_teacher_gap_on_failure or not failures:
            return None
        if period_max_teacher_gap is None and not period_minimize_teacher_gaps:
            return None
        if deadline.exhausted(3):
            return None
        if progress:
            progress(
                {
                    "stage": "period:relaxed_gap_repair",
                    "message": "Thu lai xep tiet, uu tien xep du truoc khi toi uu khoang trong giao vien.",
                    "reason": reason,
                    "failed_sessions": len(failures),
                }
            )
        repair_time_limit = max(period_time_limit, min(max(requested_period_time_limit, period_retry_time_limit), 60))
        repair_retry_limit = max(period_retry_time_limit, repair_time_limit)
        try:
            repaired_lessons, repaired_period_metrics = allocate_periods(
                ctx.school_data,
                allocations,
                rules=effective_rules,
                fixed_lessons=session_fixed_lessons,
                time_limit_seconds_per_session=repair_time_limit,
                retry_time_limit_seconds_per_session=repair_retry_limit,
                remaining_time_seconds=deadline.remaining,
                max_teacher_gap=None,
                minimize_teacher_gaps=False,
                best_effort=True,
                verbose=False,
                progress=progress,
                max_workers=solver_workers,
            )
        except Exception as exc:  # noqa: BLE001 - keep original solver path if repair cannot run.
            ctx.warnings.append(f"Thu lai period relaxed gap khong thanh cong: {exc}")
            return None
        repaired_metrics = compute_metrics(ctx.school_data, repaired_lessons, rules=effective_rules)
        if not _complete_schedule_metrics_acceptable(repaired_metrics):
            return None
        if period_max_teacher_gap is not None and _max_gap_size(repaired_metrics) > int(period_max_teacher_gap):
            ctx.warnings.append(
                "Bo qua phuong an relaxed vi con buoi giao vien trong 2 tiet tro len; "
                "giu muc toi uu khoang trong de xep lai hoac dua tiet kho ve Chua phan."
            )
            return None
        repaired_period_metrics = dict(repaired_period_metrics)
        repaired_period_metrics["fallback_reason"] = f"{reason}_relaxed_period_teacher_gap"
        repaired_period_metrics["relaxed_period_teacher_gap"] = True
        repaired_period_metrics["previous_best_effort_failed_session_count"] = len(failures)
        repaired_period_metrics["previous_best_effort_failed_sessions"] = list(failures[:3])
        repaired_period_metrics["relaxed_metrics"] = {
            "scheduled_periods": repaired_metrics.get("scheduled_periods"),
            "expected_periods": repaired_metrics.get("expected_periods"),
            "teacher_sessions": repaired_metrics.get("teacher_sessions"),
            "one_period_teacher_sessions": repaired_metrics.get("one_period_teacher_sessions"),
            "gap_distribution": repaired_metrics.get("gap_distribution"),
        }
        ctx.warnings.append(
            "Da noi tieu chi khoang trong giao vien trong buoi de giu lich day du; "
            "cac khoang trong se hien trong thong ke."
        )
        return repaired_lessons, repaired_period_metrics

    session_cp_sat_compatible = _constraints_allow_session_cp_sat_fast_path(effective_rules)
    period_feasibility_all_sessions = (
        set(range(len(all_sessions())))
        if _constraints_need_period_feasibility_bridge(effective_rules)
        and not _truthy_setting(settings.get("disable_period_feasibility_bridge"))
        else set()
    )
    legacy_wednesday_pm_bridge = _truthy_setting(settings.get("legacy_wednesday_pm_bridge"))
    adaptive_teacher_session_bounds = _teacher_session_adaptive_bounds(ctx.school_data)
    adaptive_feasibility_cap = max(
        max_teacher_sessions,
        int(adaptive_teacher_session_bounds.get("start_cap") or max_teacher_sessions),
    )
    class_fixed_tight_capacity_bridge = False
    if (
        solver_mode == "auto"
        and effective_rules.constraints is not None
        and (effective_rules.constraints.fixed_off or {}).get("class")
    ):
        bridge_expected_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
        bridge_available_periods = sum(_available_slot_count(class_entry, effective_rules) for class_entry in ctx.classes)
        bridge_slack = bridge_available_periods - bridge_expected_periods
        bridge_slack_limit = _to_int(
            settings.get("class_fixed_tight_capacity_slack"),
            max(6, len(ctx.classes)),
        )
        class_fixed_tight_capacity_bridge = (
            bridge_expected_periods > 0
            and bridge_available_periods >= bridge_expected_periods
            and bridge_slack <= bridge_slack_limit
        )
        if (
            class_fixed_tight_capacity_bridge
            and max_teacher_sessions < adaptive_feasibility_cap
            and not strict_teacher_session_cap
        ):
            ctx.warnings.append(
                f"class fixed-off leaves only {bridge_slack} spare slots; "
                f"using adaptive max_teacher_sessions={adaptive_feasibility_cap} so period-feasible session search can find a full timetable."
            )
            max_teacher_sessions = adaptive_feasibility_cap
    force_integrated = solver_mode in {"integrated", "cp_sat", "cpsat", "ortools"}
    force_session_cp_sat = solver_mode in {"session_cp_sat", "session-cp-sat", "cp_sat_session", "cpsat_session"}
    if force_session_cp_sat and constraints_active and not session_cp_sat_compatible:
        raise ValueError("solver_mode=session_cp_sat chi ho tro workbook base hoac rang buoc nghi theo tiet.")
    use_session_cp_sat = force_session_cp_sat or (
        solver_mode == "auto" and (not constraints_active or session_cp_sat_compatible)
    )
    use_integrated = force_integrated
    if (
        solver_mode == "auto"
        and constraints_active
        and max_teacher_sessions < adaptive_feasibility_cap
        and _constraints_need_lesson_block_feasibility_ceiling(effective_rules)
    ):
        ctx.warnings.append(
            f"lessonBlocks.min can tao tran kha thi rong hon {max_teacher_sessions}; "
            f"giu muc yeu cau de bao cao nhung dung tran {adaptive_feasibility_cap} de tranh ket o cap qua chat."
        )
        max_teacher_sessions = adaptive_feasibility_cap
    validation_max_teacher_sessions = max_teacher_sessions
    gap0_fast_path: tuple[list[Lesson], dict[str, Any]] | None = None
    bounded_residual_repair_used = False
    tight_capacity_hint_mode = False
    skip_session_priority_rescue = False

    residual_fill_limit = _to_int(settings.get("repair_fill_first_max_missing"), 0)
    use_bounded_residual_fill = (
        solver_mode == "auto"
        and bool(full_existing_incumbent_lessons)
        and not capacity_excluded_lessons
        and residual_fill_limit > 0
        and (
            _truthy_setting(settings.get("repair_fill_first"))
            or _truthy_setting(settings.get("repair_partial_existing"))
            or _truthy_setting(settings.get("ui_unified_partial_repair"))
        )
    )
    if use_bounded_residual_fill:
        residual_fill = _bounded_soft_incumbent_residual_completion(
            original_ctx.school_data,
            full_existing_incumbent_lessons,
            report_rules,
            max_missing=residual_fill_limit,
            max_nodes=max(100, _to_int(settings.get("repair_fill_first_max_nodes"), 50_000)),
            time_limit_seconds=max(
                0.05,
                _to_float(settings.get("repair_fill_first_time_limit_seconds"), 2.0),
            ),
        )
        if residual_fill is None and (
            _truthy_setting(settings.get("ui_unified_partial_repair"))
            or _truthy_setting(settings.get("ui_constraint_change_repair"))
        ):
            actual_counts: Counter[tuple[str, str, str]] = Counter(
                (lesson.class_name, lesson.subject, lesson.teacher)
                for lesson in full_existing_incumbent_lessons
            )
            missing_classes: set[str] = set()
            missing_periods = 0
            overscheduled = False
            for assignment in original_ctx.school_data.assignments:
                key = (assignment.class_name, assignment.subject, assignment.teacher)
                actual = int(actual_counts.get(key, 0))
                expected = int(assignment.periods_per_week)
                if actual > expected:
                    overscheduled = True
                    break
                if actual < expected:
                    missing_classes.add(assignment.class_name)
                    missing_periods += expected - actual

            ordered_missing_classes = sorted(missing_classes, key=class_sort_key)
            neighborhood_periods = sum(
                int(assignment.periods_per_week)
                for assignment in ctx.school_data.assignments
                if assignment.class_name in missing_classes
            )
            residual_lns_eligible = (
                not overscheduled
                and 0 < missing_periods <= min(32, residual_fill_limit)
                and 0 < len(ordered_missing_classes) <= 4
                and 0 < neighborhood_periods <= 120
                and not deadline.exhausted(1.0)
            )
            if residual_lns_eligible:
                constraint_change_repair = _truthy_setting(
                    settings.get("ui_constraint_change_repair")
                )
                requested_lns_seconds = _to_float(
                    settings.get("repair_residual_lns_time_limit_seconds"),
                    7.0 if constraint_change_repair else 1.5,
                )
                residual_lns = _repair_one_period_affected_class_cluster(
                    ctx.school_data,
                    soft_existing_incumbent_lessons,
                    effective_rules,
                    seed_classes=ordered_missing_classes,
                    allow_gap1=allow_one_period_gaps,
                    time_limit_seconds=max(
                        1.0,
                        min(7.0 if constraint_change_repair else 2.0, requested_lns_seconds),
                    ),
                    max_classes=len(ordered_missing_classes),
                    max_lessons=120,
                    num_workers=min(2, solver_workers),
                    optimize_teacher_quality=True,
                    fixed_lessons=hard_fixed_lessons,
                    report_data=original_ctx.school_data,
                    report_rules=report_rules,
                    random_seed=random_seed,
                    gap1_first=False,
                    preserve_teacher_quality=False,
                    require_quality_improvement=False,
                )
                if residual_lns is not None:
                    lns_lessons, lns_metrics, lns_meta = residual_lns
                    incumbent_counts = Counter(
                        _lesson_identity(lesson) for lesson in full_existing_incumbent_lessons
                    )
                    candidate_counts = Counter(_lesson_identity(lesson) for lesson in lns_lessons)
                    preserved_hint_periods = sum(
                        min(count, int(candidate_counts.get(key, 0)))
                        for key, count in incumbent_counts.items()
                    )
                    residual_fill = (
                        lns_lessons,
                        lns_metrics,
                        {
                            **lns_meta,
                            "repair_kind": "bounded_residual_class_lns",
                            "missing_periods": missing_periods,
                            "hinted_periods": len(full_existing_incumbent_lessons),
                            "preserved_hint_periods": preserved_hint_periods,
                            "changed_hint_periods": max(
                                0,
                                len(full_existing_incumbent_lessons) - preserved_hint_periods,
                            ),
                            "soft_hint": True,
                            "hard_fixed": False,
                        },
                    )
        if residual_fill is not None:
            repaired_lessons, repaired_metrics, repair_meta = residual_fill
            repaired_residual_lessons = _lessons_without_fixed_instances(
                repaired_lessons,
                hard_fixed_lessons,
            )
            repaired_one_period = int(repaired_metrics.get("one_period_teacher_sessions") or 0)
            repaired_max_gap = _max_gap_size(repaired_metrics)
            residual_quality_debt_allowed = _truthy_setting(settings.get("allow_quality_debt")) and _truthy_setting(
                settings.get("ui_unified_partial_repair")
            )
            one_period_ok = (
                residual_quality_debt_allowed
                or max_one_period_sessions is None
                or repaired_one_period <= max_one_period_sessions
            )
            teacher_gap_ok = (
                residual_quality_debt_allowed
                or period_max_teacher_gap is None
                or repaired_max_gap <= period_max_teacher_gap
            )
            if one_period_ok and teacher_gap_ok:
                repaired_sessions = int(repaired_metrics.get("teacher_sessions") or 0)
                validation_max_teacher_sessions = max(validation_max_teacher_sessions, repaired_sessions)
                gap0_fast_path = (
                    repaired_residual_lessons,
                    {
                        "session_solver": {
                            "solver": "bounded_soft_incumbent_residual_repair",
                            "status_name": "FEASIBLE",
                            "teacher_sessions": repaired_sessions,
                            "one_period_teacher_sessions": repaired_one_period,
                            "gap_distribution": repaired_metrics.get("gap_distribution"),
                            "requested_max_teacher_sessions": requested_max_teacher_sessions,
                            "effective_max_teacher_sessions": validation_max_teacher_sessions,
                            "fixed_lessons": len(hard_fixed_lessons),
                            "hint": {
                                "used": True,
                                "fixed": False,
                                "repair": True,
                                "minimize_distance": True,
                                "hard_fixed_periods": len(hard_fixed_lessons),
                                **repair_meta,
                            },
                        },
                        "period_solver": {
                            "solver": "bounded_soft_incumbent_residual_repair",
                            "already_placed": True,
                            "lesson_count": len(repaired_residual_lessons),
                            "fixed_lessons": len(hard_fixed_lessons),
                            **repair_meta,
                        },
                        "runtime_settings": {
                            "phase": "bounded_soft_incumbent_residual_repair",
                            "soft_incumbent": True,
                            "hard_fixed": bool(hard_fixed_lessons),
                            "hard_fixed_periods": len(hard_fixed_lessons),
                            **repair_meta,
                        },
                    },
                )
                bounded_residual_repair_used = True

    if solver_mode == "auto" and class_fixed_base_hint is None and (not unassigned_lessons or capacity_excluded_lessons):
        expected_existing_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
        if fixed_existing_lessons and len(fixed_existing_lessons) == expected_existing_periods:
            existing_metrics = compute_metrics(ctx.school_data, fixed_existing_lessons, rules=effective_rules)
            # Preserve path: the UI handed us a complete existing schedule to keep.
            # Keep it only when it satisfies the configured one-period-session cap.
            if (
                (
                    _gap0_metrics_clean(existing_metrics)
                    or (
                        allow_one_period_gaps
                        and (
                            _session_priority_metrics_acceptable(existing_metrics)
                            or (
                                max_one_period_sessions is None
                                and _session_priority_metrics_structurally_acceptable(existing_metrics)
                            )
                        )
                    )
                )
                and int(existing_metrics.get("teacher_sessions") or 10**9) <= max(max_teacher_sessions, int(existing_metrics.get("teacher_sessions") or 0))
            ):
                existing_sessions = int(existing_metrics.get("teacher_sessions") or 0)
                validation_max_teacher_sessions = max(validation_max_teacher_sessions, existing_sessions)
                gap0_fast_path = (
                    fixed_existing_lessons,
                    {
                        "session_solver": {
                            "solver": "ui_existing_fixed_lessons",
                            "status_name": "FIXED_UI",
                            "teacher_sessions": existing_metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": existing_metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": existing_metrics.get("gap_distribution"),
                            "fixed_lessons": len(fixed_existing_lessons),
                            "requested_max_teacher_sessions": max_teacher_sessions,
                            "effective_max_teacher_sessions": max(max_teacher_sessions, existing_sessions),
                        },
                        "period_solver": {
                            "solver": "ui_existing_fixed_lessons",
                            "already_placed": True,
                            "lesson_count": len(fixed_existing_lessons),
                            "fixed_lessons": len(fixed_existing_lessons),
                        },
                    },
                        )
        use_legacy_hint = not (
            fresh_randomize
            and not fixed_existing_lessons
            and not prefer_hint_variant_randomize
        )
        period_hint = _load_base_period_hint(ctx.school_data, settings) if use_legacy_hint else None
        if (
            gap0_fast_path is None
            and allow_one_period_gaps
            and not fixed_existing_lessons
            and not capacity_excluded_lessons
            and not has_class_extra_slots
            and use_legacy_hint
            and max_teacher_sessions >= 179
            and not prefer_hint_variant_randomize
        ):
            compact_allocations = _load_base_session_hint(ctx.school_data, prefer_gap3=True, settings=settings)
            if compact_allocations is not None:
                try:
                    compact_lessons, compact_period_metrics = allocate_periods(
                        ctx.school_data,
                        compact_allocations,
                        rules=effective_rules,
                        fixed_lessons=session_fixed_lessons,
                        time_limit_seconds_per_session=period_time_limit,
                        retry_time_limit_seconds_per_session=period_retry_time_limit,
                        remaining_time_seconds=deadline.remaining,
                        max_teacher_gap=period_max_teacher_gap,
                        minimize_teacher_gaps=period_minimize_teacher_gaps,
                        best_effort=best_effort_on_timeout,
                        verbose=False,
                        progress=progress,
                        max_workers=solver_workers,
                    )
                    compact_metrics = compute_metrics(ctx.school_data, compact_lessons, rules=effective_rules)
                    compact_variant_meta = None
                    if fresh_randomize:
                        compact_variant = _period_hint_variant(
                            ctx.school_data,
                            compact_lessons,
                            effective_rules,
                            random_seed=random_seed,
                            allow_gap1=True,
                        )
                        if compact_variant is not None:
                            compact_lessons, compact_variant_meta = compact_variant
                            compact_metrics = compute_metrics(ctx.school_data, compact_lessons, rules=effective_rules)
                    compact_sessions = int(compact_metrics.get("teacher_sessions") or 0)
                    if (
                        compact_sessions <= max_teacher_sessions
                        and compact_sessions < _teacher_session_count_for_lessons(period_hint or [])
                        and _session_priority_metrics_acceptable(compact_metrics)
                    ):
                        gap0_fast_path = (
                            compact_lessons,
                            {
                                "session_solver": {
                                    "solver": "base_179_gap1_session_hint",
                                    "status_name": "FIXED_HINT",
                                    "teacher_sessions": compact_metrics.get("teacher_sessions"),
                                    "one_period_teacher_sessions": compact_metrics.get("one_period_teacher_sessions"),
                                    "gap_distribution": compact_metrics.get("gap_distribution"),
                                    "fallback_reason": "minimized_teacher_sessions_allow_gap1",
                                    "requested_max_teacher_sessions": max_teacher_sessions,
                                    "effective_max_teacher_sessions": max_teacher_sessions,
                                    "fresh_randomize": bool(fresh_randomize),
                                    "random_seed": random_seed,
                                    "hint": {
                                        "used": True,
                                        "fixed": True,
                                        "variant": compact_variant_meta,
                                        "hinted_assignment_sessions": len(compact_allocations),
                                        "hinted_teacher_sessions": _teacher_session_count_for_allocations(compact_allocations),
                                    },
                                },
                                "period_solver": {
                                    **compact_period_metrics,
                                    "solver": "period_milp_from_base_179_gap1_session_hint",
                                    "already_placed": False,
                                    "lesson_count": len(compact_lessons),
                                },
                            },
                        )
                except Exception as exc:  # noqa: BLE001 - compact hint is an optimization, not a hard dependency.
                    ctx.warnings.append(f"Khong dung duoc nghiem 179 buoi gap1: {exc}")
        if gap0_fast_path is None and period_hint is None and capacity_excluded_lessons and not has_class_extra_slots:
            original_period_hint = _load_base_period_hint(original_ctx.school_data, settings)
            constraints = effective_rules.constraints
            if original_period_hint is not None and constraints is not None:
                repaired_hint = _repair_period_hint_for_class_fixed_off(
                    ctx.school_data,
                    original_period_hint,
                    effective_rules,
                    allow_gap1=allow_one_period_gaps,
                    max_moves=_to_int(settings.get("fast_repair_period_hint_max_moves"), 24),
                )
                if repaired_hint is not None:
                    repaired_lessons, repaired_metrics, repair_meta = repaired_hint
                    repaired_sessions = int(repaired_metrics.get("teacher_sessions") or 0)
                    effective_gap0_cap = max(max_teacher_sessions, repaired_sessions)
                    validation_max_teacher_sessions = max(validation_max_teacher_sessions, effective_gap0_cap)
                    skip_session_priority_rescue = True
                    gap0_fast_path = (
                        repaired_lessons,
                        {
                            "session_solver": {
                                "solver": "base_180_gap0_period_hint_repaired_for_class_fixed_off",
                                "status_name": "FIXED_HINT_REPAIRED",
                                "teacher_sessions": repaired_metrics.get("teacher_sessions"),
                                "one_period_teacher_sessions": repaired_metrics.get("one_period_teacher_sessions"),
                                "gap_distribution": repaired_metrics.get("gap_distribution"),
                                "fallback_reason": "repaired_period_hint_after_reduced_class_capacity",
                                "capacity_excluded_periods": sum(item["periods"] for item in capacity_excluded_lessons),
                                "requested_max_teacher_sessions": max_teacher_sessions,
                                "effective_max_teacher_sessions": effective_gap0_cap,
                                "hint": {
                                    "used": True,
                                    "fixed": True,
                                    "repaired": True,
                                    "hinted_periods": len(repaired_lessons),
                                    "hinted_teacher_sessions": _teacher_session_count_for_lessons(repaired_lessons),
                                    **repair_meta,
                                },
                            },
                            "period_solver": {
                                "solver": "base_180_gap0_period_hint_repaired_for_class_fixed_off",
                                "already_placed": True,
                                "lesson_count": len(repaired_lessons),
                                **repair_meta,
                            },
                        },
                    )
                if gap0_fast_path is None:
                    cleaned_hint = [
                        lesson
                        for lesson in original_period_hint
                        if lesson.period
                        in class_available_periods(
                            lesson.grade,
                            lesson.class_name,
                            Session(day=lesson.day, part=lesson.session),
                            constraints,
                        )
                    ]
                    expected_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
                    if len(cleaned_hint) == expected_periods:
                        cleaned_metrics = compute_metrics(ctx.school_data, cleaned_hint, rules=effective_rules)
                        cleaned_sessions = _teacher_session_count_for_lessons(cleaned_hint)
                        effective_gap0_cap = max(max_teacher_sessions, cleaned_sessions)
                        if _session_priority_metrics_acceptable(cleaned_metrics) and cleaned_sessions <= effective_gap0_cap:
                            validation_max_teacher_sessions = max(validation_max_teacher_sessions, effective_gap0_cap)
                            gap0_fast_path = (
                                cleaned_hint,
                                {
                                    "session_solver": {
                                        "solver": "base_gap0_period_hint_adjusted_for_fixed_off",
                                        "status_name": "FIXED_HINT",
                                        "teacher_sessions": cleaned_metrics.get("teacher_sessions"),
                                        "one_period_teacher_sessions": cleaned_metrics.get("one_period_teacher_sessions"),
                                        "gap_distribution": cleaned_metrics.get("gap_distribution"),
                                        "fallback_reason": "removed_lessons_on_class_fixed_off_slots",
                                        "capacity_excluded_periods": sum(item["periods"] for item in capacity_excluded_lessons),
                                        "requested_max_teacher_sessions": max_teacher_sessions,
                                        "effective_max_teacher_sessions": effective_gap0_cap,
                                        "hint": {
                                            "used": True,
                                            "fixed": True,
                                            "adjusted": True,
                                            "hinted_periods": len(cleaned_hint),
                                            "hinted_teacher_sessions": cleaned_sessions,
                                        },
                                    },
                                    "period_solver": {
                                        "solver": "base_gap0_period_hint_adjusted_for_fixed_off",
                                        "already_placed": True,
                                        "lesson_count": len(cleaned_hint),
                                    },
                                },
                            )
        solver_expected_periods_for_hint = sum(item.periods_per_week for item in ctx.school_data.assignments)
        available_periods_total_for_hint = sum(_available_slot_count(class_entry, effective_rules) for class_entry in ctx.classes)
        tight_capacity_hint_mode = (
            prefer_session_priority_search
            and available_periods_total_for_hint >= solver_expected_periods_for_hint
            and available_periods_total_for_hint - solver_expected_periods_for_hint <= _to_int(settings.get("fast_hint_capacity_slack"), 5)
        )
        has_fixed_off_for_hint_repair = bool(
            effective_rules.constraints is not None
            and any(
                (effective_rules.constraints.fixed_off or {}).get(kind)
                for kind in ("class", "teacher", "subject", "room", "subjectGroup")
            )
        )
        has_teacher_max_periods_for_hint_repair = bool(
            effective_rules.constraints is not None
            and any(
                isinstance(rule, Mapping) and (bool(rule.get("maxPeriods")) or bool(rule.get("maxPeriodsClass")))
                for rule in (effective_rules.constraints.teacher or {}).values()
            )
        )
        if (
            gap0_fast_path is None
            and period_hint is not None
            and constraints_active
            and has_fixed_off_for_hint_repair
            and not fixed_existing_lessons
            and not capacity_excluded_lessons
            and not fresh_randomize
            and not has_class_extra_slots
            and _truthy_setting(settings.get("fast_repair_period_hint", "1"))
        ):
            fast_hint_sessions = _teacher_session_count_for_lessons(period_hint)
            fast_hint_cap = max(max_teacher_sessions, fast_hint_sessions)
            fast_hint_metrics = compute_metrics(ctx.school_data, period_hint, rules=effective_rules)
            fast_hint_clean = (
                (
                    _gap0_metrics_clean(fast_hint_metrics)
                    or (allow_one_period_gaps and _session_priority_metrics_acceptable(fast_hint_metrics))
                )
                and int(fast_hint_metrics.get("teacher_sessions") or 10**9) <= fast_hint_cap
            )
            if not fast_hint_clean:
                repaired_hint = _repair_period_hint_for_class_fixed_off(
                    ctx.school_data,
                    period_hint,
                    effective_rules,
                    allow_gap1=allow_one_period_gaps,
                    max_moves=_to_int(settings.get("fast_repair_period_hint_max_moves"), 24),
                )
                if repaired_hint is None:
                    repaired_hint = _repair_period_hint_for_teacher_max_periods(
                        ctx.school_data,
                        period_hint,
                        effective_rules,
                        allow_gap1=allow_one_period_gaps,
                        max_swaps=_to_int(settings.get("fast_repair_teacher_max_period_swaps"), 6),
                    )
                if repaired_hint is not None:
                    repaired_lessons, repaired_metrics, repair_meta = repaired_hint
                    repair_kind = str(repair_meta.get("repair") or "")
                    repair_solver_name = (
                        "base_180_gap0_period_hint_repaired_for_teacher_max_periods"
                        if repair_kind == "teacher_max_periods_period_hint"
                        else "base_180_gap0_period_hint_repaired_for_class_fixed_off"
                    )
                    repair_reason = (
                        "repaired_period_hint_after_teacher_max_periods"
                        if repair_kind == "teacher_max_periods_period_hint"
                        else "repaired_period_hint_after_fixed_off"
                    )
                    repaired_sessions = int(repaired_metrics.get("teacher_sessions") or 10**9)
                    repaired_cap = max(fast_hint_cap, repaired_sessions)
                    if repaired_sessions <= repaired_cap and repaired_sessions <= max(adaptive_feasibility_cap, max_teacher_sessions):
                        validation_max_teacher_sessions = max(validation_max_teacher_sessions, repaired_cap)
                        skip_session_priority_rescue = True
                        gap0_fast_path = (
                            repaired_lessons,
                            {
                                "session_solver": {
                                    "solver": repair_solver_name,
                                    "status_name": "FIXED_HINT_REPAIRED",
                                    "teacher_sessions": repaired_metrics.get("teacher_sessions"),
                                    "one_period_teacher_sessions": repaired_metrics.get("one_period_teacher_sessions"),
                                    "gap_distribution": repaired_metrics.get("gap_distribution"),
                                    "fallback_reason": repair_reason,
                                    "requested_max_teacher_sessions": max_teacher_sessions,
                                    "effective_max_teacher_sessions": repaired_cap,
                                    "fresh_randomize": bool(fresh_randomize),
                                    "random_seed": random_seed,
                                    "hint": {
                                        "used": True,
                                        "fixed": True,
                                        "repaired": True,
                                        "hinted_periods": len(repaired_lessons),
                                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(repaired_lessons),
                                        **repair_meta,
                                    },
                                },
                                "period_solver": {
                                    "solver": repair_solver_name,
                                    "already_placed": True,
                                    "lesson_count": len(repaired_lessons),
                                    **repair_meta,
                                },
                            },
                        )
        validated_period_hint_fast_mode = False
        if (
            gap0_fast_path is None
            and period_hint is not None
            and constraints_active
            and prefer_session_priority_search
            and not tight_capacity_hint_mode
            and not fixed_existing_lessons
            and not capacity_excluded_lessons
            and not fresh_randomize
            and not has_class_extra_slots
            and not _truthy_setting(settings.get("deep_session_rescue"))
            and _truthy_setting(settings.get("fast_validated_period_hint", "1"))
        ):
            fast_hint_sessions = _teacher_session_count_for_lessons(period_hint)
            fast_hint_cap = max(max_teacher_sessions, fast_hint_sessions)
            fast_hint_metrics = compute_metrics(ctx.school_data, period_hint, rules=effective_rules)
            validated_period_hint_fast_mode = (
                (
                    _gap0_metrics_clean(fast_hint_metrics)
                    or (allow_one_period_gaps and _session_priority_metrics_acceptable(fast_hint_metrics))
                )
                and int(fast_hint_metrics.get("teacher_sessions") or 10**9) <= fast_hint_cap
            )
        if (
            gap0_fast_path is None
            and period_hint is not None
            and (
                not prefer_session_priority_search
                or tight_capacity_hint_mode
                or validated_period_hint_fast_mode
                or has_teacher_max_periods_for_hint_repair
            )
        ):
            base_gap0_sessions = _teacher_session_count_for_lessons(period_hint)
            gap0_floor = base_gap0_sessions
            effective_gap0_cap = max(max_teacher_sessions, gap0_floor)
            if effective_gap0_cap != max_teacher_sessions:
                validation_max_teacher_sessions = effective_gap0_cap
                ctx.warnings.append(
                    f"max_teacher_sessions={max_teacher_sessions} thap hon nghiem da kiem chung {effective_gap0_cap}; "
                    f"da dung {effective_gap0_cap} de giu lich hop le; gap1/1-tiet la toi uu phu."
                )
            hint_metrics = compute_metrics(ctx.school_data, period_hint, rules=effective_rules)
            hint_is_clean = (
                (
                    _gap0_metrics_clean(hint_metrics)
                    or (allow_one_period_gaps and _session_priority_metrics_acceptable(hint_metrics))
                )
                and int(hint_metrics.get("teacher_sessions") or 10**9) <= effective_gap0_cap
            )
            if (
                gap0_fast_path is None
                and not hint_is_clean
                and constraints_active
                and not fixed_existing_lessons
                and not capacity_excluded_lessons
                and not has_class_extra_slots
                and _truthy_setting(settings.get("fast_repair_period_hint", "1"))
            ):
                repaired_hint = _repair_period_hint_for_class_fixed_off(
                    ctx.school_data,
                    period_hint,
                    effective_rules,
                    allow_gap1=allow_one_period_gaps,
                    max_moves=_to_int(settings.get("fast_repair_period_hint_max_moves"), 24),
                )
                if repaired_hint is None:
                    repaired_hint = _repair_period_hint_for_teacher_max_periods(
                        ctx.school_data,
                        period_hint,
                        effective_rules,
                        allow_gap1=allow_one_period_gaps,
                        max_swaps=_to_int(settings.get("fast_repair_teacher_max_period_swaps"), 6),
                    )
                if repaired_hint is not None:
                    repaired_lessons, repaired_metrics, repair_meta = repaired_hint
                    repair_kind = str(repair_meta.get("repair") or "")
                    repair_solver_name = (
                        "base_180_gap0_period_hint_repaired_for_teacher_max_periods"
                        if repair_kind == "teacher_max_periods_period_hint"
                        else "base_180_gap0_period_hint_repaired_for_class_fixed_off"
                    )
                    repair_reason = (
                        "repaired_period_hint_after_teacher_max_periods"
                        if repair_kind == "teacher_max_periods_period_hint"
                        else "repaired_period_hint_after_class_fixed_off_excel"
                    )
                    repaired_sessions = int(repaired_metrics.get("teacher_sessions") or 10**9)
                    repaired_cap = max(effective_gap0_cap, repaired_sessions)
                    if repaired_sessions <= repaired_cap and repaired_sessions <= max(adaptive_feasibility_cap, max_teacher_sessions):
                        validation_max_teacher_sessions = max(validation_max_teacher_sessions, repaired_cap)
                        skip_session_priority_rescue = True
                        gap0_fast_path = (
                            repaired_lessons,
                            {
                                "session_solver": {
                                    "solver": repair_solver_name,
                                    "status_name": "FIXED_HINT_REPAIRED",
                                    "teacher_sessions": repaired_metrics.get("teacher_sessions"),
                                    "one_period_teacher_sessions": repaired_metrics.get("one_period_teacher_sessions"),
                                    "gap_distribution": repaired_metrics.get("gap_distribution"),
                                    "fallback_reason": repair_reason,
                                    "requested_max_teacher_sessions": max_teacher_sessions,
                                    "effective_max_teacher_sessions": repaired_cap,
                                    "fresh_randomize": bool(fresh_randomize),
                                    "random_seed": random_seed,
                                    "hint": {
                                        "used": True,
                                        "fixed": True,
                                        "repaired": True,
                                        "hinted_periods": len(repaired_lessons),
                                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(repaired_lessons),
                                        **repair_meta,
                                    },
                                },
                                "period_solver": {
                                    "solver": repair_solver_name,
                                    "already_placed": True,
                                    "lesson_count": len(repaired_lessons),
                                    **repair_meta,
                                },
                            },
                        )
            expected_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
            if fixed_existing_lessons and len(fixed_existing_lessons) == expected_periods:
                existing_metrics = compute_metrics(ctx.school_data, fixed_existing_lessons, rules=effective_rules)
                if (
                    (
                        _gap0_metrics_clean(existing_metrics)
                        or (allow_one_period_gaps and _session_priority_metrics_acceptable(existing_metrics))
                    )
                    and int(existing_metrics.get("teacher_sessions") or 10**9) <= effective_gap0_cap
                ):
                    gap0_fast_path = (
                        fixed_existing_lessons,
                        {
                            "session_solver": {
                                "solver": "ui_existing_fixed_lessons",
                                "status_name": "FIXED_UI",
                                "teacher_sessions": existing_metrics.get("teacher_sessions"),
                                "one_period_teacher_sessions": existing_metrics.get("one_period_teacher_sessions"),
                                "gap_distribution": existing_metrics.get("gap_distribution"),
                                "fixed_lessons": len(fixed_existing_lessons),
                                "requested_max_teacher_sessions": max_teacher_sessions,
                                "effective_max_teacher_sessions": effective_gap0_cap,
                            },
                            "period_solver": {
                                "solver": "ui_existing_fixed_lessons",
                                "already_placed": True,
                                "lesson_count": len(fixed_existing_lessons),
                                "fixed_lessons": len(fixed_existing_lessons),
                            },
                        },
                    )
            if (
                gap0_fast_path is None
                and hint_is_clean
                and (not fresh_randomize or not fixed_existing_lessons or constraints_active)
                and not fixed_existing_lessons
            ):
                chosen_hint = period_hint
                chosen_metrics = hint_metrics
                variant_meta: dict[str, Any] | None = None
                if fresh_randomize and not fixed_existing_lessons:
                    variant = _period_hint_variant(
                        ctx.school_data,
                        period_hint,
                        effective_rules,
                        random_seed=random_seed,
                        allow_gap1=allow_one_period_gaps,
                    )
                    if variant is not None:
                        chosen_hint, variant_meta = variant
                        chosen_metrics = compute_metrics(ctx.school_data, chosen_hint, rules=effective_rules)
                gap0_metrics = {
                    "solver": "validated_gap0_period_hint_variant" if variant_meta else "base_180_gap0_period_hint",
                    "status_name": "FIXED_HINT",
                    "teacher_sessions": chosen_metrics.get("teacher_sessions"),
                    "one_period_teacher_sessions": chosen_metrics.get("one_period_teacher_sessions"),
                    "gap_distribution": chosen_metrics.get("gap_distribution"),
                    "fallback_reason": (
                        "validated_gap0_period_hint_variant"
                        if variant_meta
                        else (
                            "validated_period_hint_fast_path_skipped_session_priority_search"
                            if validated_period_hint_fast_mode
                            else "validated_gap0_period_hint"
                        )
                    ),
                    "requested_max_teacher_sessions": max_teacher_sessions,
                    "effective_max_teacher_sessions": effective_gap0_cap,
                    "fresh_randomize": bool(fresh_randomize),
                    "random_seed": random_seed,
                    "hint": {
                        "used": True,
                        "fixed": True,
                        "variant": variant_meta,
                        "hinted_periods": len(chosen_hint),
                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(chosen_hint),
                    },
                }
                gap0_fast_path = (
                    chosen_hint,
                    {
                        "session_solver": gap0_metrics,
                        "period_solver": {
                            "solver": "validated_gap0_period_hint_variant" if variant_meta else "base_180_gap0_period_hint",
                            "already_placed": True,
                            "lesson_count": len(chosen_hint),
                        },
                    },
                )
                if validated_period_hint_fast_mode:
                    skip_session_priority_rescue = True
            elif gap0_fast_path is None:
                search_gap0_cap = effective_gap0_cap
                if fresh_randomize and hint_is_clean:
                    search_gap0_cap = min(
                        effective_gap0_cap,
                        int(hint_metrics.get("teacher_sessions") or effective_gap0_cap),
                    )

                def clean_period_hint_fast_path(reason: str) -> tuple[list[Lesson], dict[str, Any]]:
                    return (
                        period_hint,
                        {
                            "session_solver": {
                                "solver": "base_180_gap0_period_hint",
                                "status_name": "FIXED_HINT",
                                "teacher_sessions": hint_metrics.get("teacher_sessions"),
                                "one_period_teacher_sessions": hint_metrics.get("one_period_teacher_sessions"),
                                "gap_distribution": hint_metrics.get("gap_distribution"),
                                "fallback_reason": reason,
                                "requested_max_teacher_sessions": max_teacher_sessions,
                                "effective_max_teacher_sessions": effective_gap0_cap,
                                "fresh_randomize": bool(fresh_randomize),
                                "random_seed": random_seed,
                                "hint": {
                                    "used": True,
                                    "fixed": True,
                                    "hinted_periods": len(period_hint),
                                    "hinted_teacher_sessions": base_gap0_sessions,
                                },
                            },
                            "period_solver": {
                                "solver": "base_180_gap0_period_hint",
                                "already_placed": True,
                                "lesson_count": len(period_hint),
                            },
                        },
                    )

                def repaired_period_hint_fast_path(reason: str) -> tuple[list[Lesson], dict[str, Any]] | None:
                    nonlocal validation_max_teacher_sessions, skip_session_priority_rescue
                    repaired_hint = _repair_period_hint_for_class_fixed_off(
                        ctx.school_data,
                        period_hint,
                        effective_rules,
                        allow_gap1=allow_one_period_gaps,
                        max_moves=_to_int(settings.get("fast_repair_period_hint_max_moves"), 24),
                    )
                    if repaired_hint is None:
                        repaired_hint = _repair_period_hint_for_teacher_max_periods(
                            ctx.school_data,
                            period_hint,
                            effective_rules,
                            allow_gap1=allow_one_period_gaps,
                            max_swaps=_to_int(settings.get("fast_repair_teacher_max_period_swaps"), 6),
                            allow_structural_result=True,
                        )
                    if repaired_hint is None:
                        return None
                    repaired_lessons, repaired_metrics, repair_meta = repaired_hint
                    if (
                        allow_one_period_gaps
                        and int(repaired_metrics.get("one_period_teacher_sessions") or 0) > 0
                        and _session_priority_metrics_structurally_acceptable(repaired_metrics)
                    ):
                        cleanup = _local_one_period_cleanup(
                            ctx.school_data,
                            repaired_lessons,
                            effective_rules,
                            allow_gap1=True,
                            time_limit_seconds=max(0.25, _to_float(settings.get("one_period_local_cleanup_time_limit"), 1.0)),
                            target_one_period_sessions=0,
                            max_evaluated=max(1000, _to_int(settings.get("one_period_local_cleanup_max_evaluated"), 5000)),
                        )
                        if cleanup is None:
                            cleanup = _repair_one_period_affected_class_cluster(
                                ctx.school_data,
                                repaired_lessons,
                                effective_rules,
                                seed_classes=[
                                    str(class_name)
                                    for class_name in repair_meta.get("repaired_classes", [])
                                ],
                                allow_gap1=True,
                                time_limit_seconds=max(0.5, _to_float(settings.get("one_period_cluster_repair_time_limit"), 3.0)),
                                max_classes=max(1, _to_int(settings.get("one_period_cluster_repair_max_classes"), 4)),
                                max_lessons=max(20, _to_int(settings.get("one_period_cluster_repair_max_lessons"), 120)),
                                num_workers=solver_workers,
                            )
                        if cleanup is not None:
                            cleanup_lessons, cleanup_metrics, cleanup_meta = cleanup
                            if _session_priority_metrics_acceptable(cleanup_metrics):
                                repaired_lessons = cleanup_lessons
                                repaired_metrics = cleanup_metrics
                                repair_meta = {
                                    **repair_meta,
                                    "one_period_cleanup_after_period_hint_repair": True,
                                    **cleanup_meta,
                                }
                    if not (
                        _gap0_metrics_clean(repaired_metrics)
                        or (allow_one_period_gaps and _session_priority_metrics_acceptable(repaired_metrics))
                    ):
                        return None
                    repair_kind = str(repair_meta.get("repair") or "")
                    repair_solver_name = (
                        "base_180_gap0_period_hint_repaired_for_teacher_max_periods"
                        if repair_kind == "teacher_max_periods_period_hint"
                        else "base_180_gap0_period_hint_repaired_for_class_fixed_off"
                    )
                    repaired_sessions = int(repaired_metrics.get("teacher_sessions") or 0)
                    repaired_cap = max(effective_gap0_cap, search_gap0_cap, repaired_sessions)
                    validation_max_teacher_sessions = max(validation_max_teacher_sessions, repaired_cap)
                    skip_session_priority_rescue = True
                    return (
                        repaired_lessons,
                        {
                            "session_solver": {
                                "solver": repair_solver_name,
                                "status_name": "FIXED_HINT_REPAIRED",
                                "teacher_sessions": repaired_metrics.get("teacher_sessions"),
                                "one_period_teacher_sessions": repaired_metrics.get("one_period_teacher_sessions"),
                                "gap_distribution": repaired_metrics.get("gap_distribution"),
                                "fallback_reason": reason,
                                "requested_max_teacher_sessions": max_teacher_sessions,
                                "effective_max_teacher_sessions": repaired_cap,
                                "fresh_randomize": bool(fresh_randomize),
                                "random_seed": random_seed,
                                "hint": {
                                    "used": True,
                                    "fixed": True,
                                    "repaired": True,
                                    "hinted_periods": len(repaired_lessons),
                                    "hinted_teacher_sessions": _teacher_session_count_for_lessons(repaired_lessons),
                                    **repair_meta,
                                },
                            },
                            "period_solver": {
                                "solver": repair_solver_name,
                                "already_placed": True,
                                "lesson_count": len(repaired_lessons),
                                **repair_meta,
                            },
                        },
                    )

                def solve_gap0_without_fixed_lessons(reason: str) -> tuple[list[Lesson], dict[str, Any]] | None:
                    default_gap0_probe_limit = 8 if has_teacher_max_periods_for_hint_repair else 30
                    quick_gap0_limit = (
                        _to_int(settings.get("one_period_gap0_probe_time_limit"), default_gap0_probe_limit)
                        if minimize_one_period_sessions
                        else period_time_limit
                    )
                    quick_time_limit = max(
                        8,
                        min(integrated_time_limit, quick_gap0_limit, 45)
                        if minimize_one_period_sessions
                        else min(integrated_time_limit, period_time_limit, max(session_time_limit, 8), 45),
                    )
                    try:
                        lessons, solver_metrics = solve_gap0_cp_sat(
                            ctx.school_data,
                            rules=effective_rules,
                            max_teacher_sessions=search_gap0_cap,
                            time_limit_seconds=deadline.phase_limit(quick_time_limit),
                            num_workers=solver_workers,
                            hint_lessons=period_hint,
                            fixed_lessons=[],
                            prefer_hint=not fresh_randomize,
                            random_seed=random_seed,
                            progress=progress,
                        )
                    except Exception as retry_exc:  # noqa: BLE001 - fall through to broader solver path.
                        ctx.warnings.append(f"Khong the xep nhanh sau khi mo khoa tiet cu: {retry_exc}.")
                        return None
                    metrics = compute_metrics(ctx.school_data, lessons, rules=effective_rules)
                    if not (
                        _gap0_metrics_clean(metrics)
                        or (allow_one_period_gaps and _session_priority_metrics_acceptable(metrics))
                    ):
                        ctx.warnings.append("Phuong an xep nhanh sau khi mo khoa tiet cu chua du sach, tiep tuc solver tong quat.")
                        return None
                    return (
                        lessons,
                        {
                            "session_solver": {
                                "solver": "ortools_cp_sat_gap0_period",
                                "teacher_sessions": metrics.get("teacher_sessions"),
                                "one_period_teacher_sessions": metrics.get("one_period_teacher_sessions"),
                                "gap_distribution": metrics.get("gap_distribution"),
                                "requested_max_teacher_sessions": max_teacher_sessions,
                                "effective_max_teacher_sessions": search_gap0_cap,
                                "fixed_lessons": 0,
                                "released_fixed_lessons_reason": reason,
                                "fresh_randomize": bool(fresh_randomize),
                                "random_seed": random_seed,
                            },
                            "period_solver": {
                                **solver_metrics,
                                "already_placed": True,
                                "lesson_count": len(lessons),
                                "fixed_lessons": 0,
                            },
                        },
                    )
                use_existing_as_soft_hint = bool(fixed_existing_lessons) and not fixed_existing_lessons_are_hard
                gap0_hint_lessons = (
                    _merge_existing_lessons_with_hint(ctx.school_data, fixed_existing_lessons, period_hint)
                    if use_existing_as_soft_hint
                    else period_hint
                )
                gap0_fixed_lessons = [] if (use_existing_as_soft_hint or fixed_existing_lessons_are_hard) else fixed_existing_lessons
                try:
                    default_gap0_probe_limit = 8 if has_teacher_max_periods_for_hint_repair else 30
                    quick_gap0_limit = (
                        _to_int(settings.get("one_period_gap0_probe_time_limit"), default_gap0_probe_limit)
                        if minimize_one_period_sessions
                        else period_time_limit
                    )
                    quick_time_limit = max(
                        8,
                        min(integrated_time_limit, quick_gap0_limit, 45)
                        if minimize_one_period_sessions
                        else min(integrated_time_limit, period_time_limit, max(session_time_limit, 8), 45),
                    )
                    gap0_lessons, gap0_solver_metrics = solve_gap0_cp_sat(
                        ctx.school_data,
                        rules=effective_rules,
                        max_teacher_sessions=search_gap0_cap,
                        time_limit_seconds=deadline.phase_limit(quick_time_limit),
                        num_workers=solver_workers,
                        hint_lessons=gap0_hint_lessons,
                        fixed_lessons=gap0_fixed_lessons,
                        prefer_hint=bool(gap0_hint_lessons) and not fresh_randomize,
                        random_seed=random_seed,
                        progress=progress,
                    )
                    repaired_metrics = compute_metrics(ctx.school_data, gap0_lessons, rules=effective_rules)
                    if _gap0_metrics_clean(repaired_metrics) or (
                        allow_one_period_gaps and _session_priority_metrics_acceptable(repaired_metrics)
                    ):
                        preserved_existing_count = 0
                        if use_existing_as_soft_hint:
                            solved_slots = {
                                (item.class_name, item.subject, item.teacher, item.day, item.session, item.period)
                                for item in gap0_lessons
                            }
                            preserved_existing_count = sum(
                                1
                                for item in fixed_existing_lessons
                                if (item.class_name, item.subject, item.teacher, item.day, item.session, item.period)
                                in solved_slots
                            )
                        gap0_fast_path = (
                            gap0_lessons,
                            {
                                "session_solver": {
                                    "solver": "ortools_cp_sat_gap0_period",
                                    "teacher_sessions": repaired_metrics.get("teacher_sessions"),
                                    "one_period_teacher_sessions": repaired_metrics.get("one_period_teacher_sessions"),
                                    "gap_distribution": repaired_metrics.get("gap_distribution"),
                                    "requested_max_teacher_sessions": max_teacher_sessions,
                                    "effective_max_teacher_sessions": search_gap0_cap,
                                    "fixed_lessons": len(gap0_fixed_lessons),
                                    "existing_hint_lessons": len(fixed_existing_lessons) if use_existing_as_soft_hint else 0,
                                    "preserved_existing_hint_lessons": preserved_existing_count,
                                    "fresh_randomize": bool(fresh_randomize),
                                    "random_seed": random_seed,
                                },
                                "period_solver": {
                                    **gap0_solver_metrics,
                                    "already_placed": True,
                                    "lesson_count": len(gap0_lessons),
                                },
                            },
                        )
                    elif fixed_existing_lessons and not fixed_existing_lessons_are_hard:
                        ctx.warnings.append(
                            "Da mo khoa them tiet cu vi giu nguyen chung khong dat duoc rang buoc/toi uu."
                        )
                        fixed_existing_lessons = []
                        gap0_fast_path = solve_gap0_without_fixed_lessons("fixed_existing_not_clean")
                        if gap0_fast_path is None:
                            gap0_fast_path = repaired_period_hint_fast_path("fixed_existing_not_clean_used_repaired_base_hint")
                    elif has_teacher_max_periods_for_hint_repair:
                        gap0_fast_path = repaired_period_hint_fast_path(
                            "gap0_randomized_search_not_clean_used_repaired_teacher_max_period_hint"
                        )
                    elif hint_is_clean:
                        gap0_fast_path = clean_period_hint_fast_path("gap0_randomized_search_not_clean_used_validated_hint")
                except Gap0CpSatNoSolution as exc:
                    if fixed_existing_lessons and not fixed_existing_lessons_are_hard:
                        ctx.warnings.append(
                            "Da mo khoa them tiet cu vi lich cu lam bai toan khong kha thi voi rang buoc moi."
                        )
                        fixed_existing_lessons = []
                        gap0_fast_path = solve_gap0_without_fixed_lessons(
                            f"fixed_existing_no_solution:{exc.metrics.get('status_name')}"
                        )
                        if gap0_fast_path is None:
                            gap0_fast_path = repaired_period_hint_fast_path(
                                f"fixed_existing_no_solution_used_repaired_base_hint:{exc.metrics.get('status_name')}"
                            )
                    if gap0_fast_path is None and hint_is_clean:
                        gap0_fast_path = clean_period_hint_fast_path(
                            f"gap0_randomized_search_no_solution_used_validated_hint:{exc.metrics.get('status_name')}"
                        )
                    ctx.warnings.append(f"Gap0 CP-SAT chưa tìm được nghiệm sạch: {exc.metrics.get('status_name')}.")
                    if gap0_fast_path is None and has_teacher_max_periods_for_hint_repair:
                        gap0_fast_path = repaired_period_hint_fast_path(
                            f"gap0_randomized_search_no_solution_used_repaired_teacher_max_period_hint:{exc.metrics.get('status_name')}"
                        )
                except Exception as exc:
                    if fixed_existing_lessons:
                        raise
                    if has_teacher_max_periods_for_hint_repair:
                        gap0_fast_path = repaired_period_hint_fast_path(
                            "gap0_search_error_used_repaired_teacher_max_period_hint"
                        )
                    variant = None
                    if gap0_fast_path is None and fresh_randomize and period_hint is not None:
                        variant = _period_hint_variant(
                            ctx.school_data,
                            period_hint,
                            effective_rules,
                            random_seed=random_seed,
                            allow_gap1=allow_one_period_gaps,
                        )
                    if gap0_fast_path is None and variant is not None:
                        variant_lessons, variant_meta = variant
                        variant_metrics = compute_metrics(ctx.school_data, variant_lessons, rules=effective_rules)
                        gap0_fast_path = (
                            variant_lessons,
                            {
                                "session_solver": {
                                    "solver": "validated_gap0_period_hint_variant",
                                    "status_name": "FIXED_HINT",
                                    "teacher_sessions": variant_metrics.get("teacher_sessions"),
                                    "one_period_teacher_sessions": variant_metrics.get("one_period_teacher_sessions"),
                                    "gap_distribution": variant_metrics.get("gap_distribution"),
                                    "fallback_reason": "gap0_search_error_used_validated_hint_variant",
                                    "search_error": str(exc),
                                    "requested_max_teacher_sessions": max_teacher_sessions,
                                    "effective_max_teacher_sessions": effective_gap0_cap,
                                    "fresh_randomize": bool(fresh_randomize),
                                    "random_seed": random_seed,
                                    "hint": {
                                        "used": True,
                                        "fixed": True,
                                        "variant": variant_meta,
                                        "hinted_periods": len(variant_lessons),
                                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(variant_lessons),
                                    },
                                },
                                "period_solver": {
                                    "solver": "validated_gap0_period_hint_variant",
                                    "already_placed": True,
                                    "lesson_count": len(variant_lessons),
                                },
                            },
                        )
                    elif gap0_fast_path is None and hint_is_clean:
                        gap0_fast_path = clean_period_hint_fast_path("gap0_search_error_used_validated_hint")
                    elif gap0_fast_path is None:
                        raise

    if gap0_fast_path is not None:
        lessons, solver_metrics = gap0_fast_path
    elif class_fixed_base_hint is not None:
        allocations, session_metrics = class_fixed_base_hint
        try:
            lessons, period_metrics = allocate_periods(
                ctx.school_data,
                allocations,
                rules=effective_rules,
                fixed_lessons=session_fixed_lessons,
                time_limit_seconds_per_session=period_time_limit,
                retry_time_limit_seconds_per_session=period_retry_time_limit,
                remaining_time_seconds=deadline.remaining,
                max_teacher_gap=period_max_teacher_gap,
                minimize_teacher_gaps=period_minimize_teacher_gaps,
                best_effort=best_effort_on_timeout,
                verbose=False,
                progress=progress,
                max_workers=solver_workers,
            )
            relaxed_period_repair = try_relaxed_period_gap_repair(
                allocations,
                period_metrics,
                "initial_period_best_effort",
            )
            if relaxed_period_repair is not None:
                lessons, period_metrics = relaxed_period_repair
            if (
                best_effort_on_timeout
                and not capacity_excluded_lessons
                and not deadline.exhausted(period_phase_reserve_seconds)
            ):
                retry_error = _period_retry_error_from_best_effort(lessons, period_metrics)
                if retry_error is not None:
                    raise retry_error
            solver_metrics = {
                "session_solver": session_metrics,
                "period_solver": period_metrics,
            }
        except Exception as exc:
            rescue_hint = _load_base_period_hint(ctx.school_data, settings)
            rescue: tuple[list[Lesson], dict[str, Any]] | None = None
            if (
                solver_mode == "auto"
                and rescue_hint is not None
                and constraints_active
                and not fixed_existing_lessons
            ):
                if fresh_randomize:
                    rescue = _period_hint_variant(
                        ctx.school_data,
                        rescue_hint,
                        effective_rules,
                        random_seed=random_seed,
                        allow_gap1=allow_one_period_gaps,
                    )
                if rescue is None:
                    rescue_metrics = compute_metrics(ctx.school_data, rescue_hint, rules=effective_rules)
                    if _gap0_metrics_clean(rescue_metrics):
                        rescue = (rescue_hint, {})
            if rescue is None:
                raise
            lessons, rescue_meta = rescue
            allocations = _allocations_from_lessons(lessons)
            rescued_metrics = compute_metrics(ctx.school_data, lessons, rules=effective_rules)
            rescue_solver = "validated_gap0_period_hint_variant" if rescue_meta else "base_180_gap0_period_hint"
            validation_max_teacher_sessions = max(
                validation_max_teacher_sessions,
                int(rescued_metrics.get("teacher_sessions") or 0),
            )
            solver_metrics = {
                "session_solver": {
                    "solver": rescue_solver,
                    "status_name": "FIXED_HINT",
                    "teacher_sessions": rescued_metrics.get("teacher_sessions"),
                    "one_period_teacher_sessions": rescued_metrics.get("one_period_teacher_sessions"),
                    "gap_distribution": rescued_metrics.get("gap_distribution"),
                    "fallback_reason": "period_allocation_failed_used_validated_gap0_hint",
                    "period_allocation_error": str(exc),
                    "previous_solver": session_metrics,
                    "requested_max_teacher_sessions": requested_max_teacher_sessions,
                    "effective_max_teacher_sessions": validation_max_teacher_sessions,
                    "fresh_randomize": bool(fresh_randomize),
                    "random_seed": random_seed,
                    "hint": {
                        "used": True,
                        "fixed": True,
                        "variant": rescue_meta or None,
                        "hinted_periods": len(lessons),
                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(lessons),
                    },
                },
                "period_solver": {
                    "solver": rescue_solver,
                    "already_placed": True,
                    "lesson_count": len(lessons),
                },
            }
    elif use_integrated:
        lessons, integrated_metrics = solve_integrated_timetable(
            ctx.school_data,
            rules=effective_rules,
            max_teacher_sessions=max_teacher_sessions,
            exact_teacher_sessions=exact_teacher_sessions,
            time_limit_seconds=deadline.phase_limit(integrated_time_limit),
            num_workers=solver_workers,
            allow_legacy_solver_hints=_legacy_solver_hints_enabled(settings),
            progress=progress,
        )
        allocations = _allocations_from_lessons(lessons)
        session_metrics = {
            "solver": "integrated_cp_sat",
            "teacher_sessions": integrated_metrics.get("teacher_sessions"),
            "load_distribution": integrated_metrics.get("load_distribution", {}),
        }
        period_metrics = {
            "solver": "integrated_cp_sat",
            "already_placed": True,
            "lesson_count": len(lessons),
        }
        solver_metrics = {
            "integrated_solver": integrated_metrics,
            "session_solver": session_metrics,
            "period_solver": period_metrics,
        }
    elif use_session_cp_sat:
        use_legacy_session_hint = not (fresh_randomize and not fixed_existing_lessons and not constraints_active)
        legacy_base_hint = (
            _load_base_session_hint(ctx.school_data, prefer_gap3=not constraints_active, settings=settings)
            if use_legacy_session_hint and session_cp_sat_compatible and not has_class_extra_slots
            else None
        )
        soft_incumbent_base_hint = (
            _allocations_from_lessons(soft_existing_incumbent_lessons)
            if soft_existing_incumbent_lessons
            else None
        )
        base_hint = soft_incumbent_base_hint or legacy_base_hint
        base_hint_sessions = _teacher_session_count_for_allocations(base_hint) if base_hint else 0
        base_hint_periods = sum(max(0, int(item.count)) for item in base_hint or [])
        expected_hint_periods = sum(max(0, int(item.periods_per_week)) for item in ctx.school_data.assignments)
        base_hint_complete = bool(base_hint) and base_hint_periods == expected_hint_periods
        effective_max_teacher_sessions = max_teacher_sessions
        if soft_incumbent_base_hint and base_hint_sessions > effective_max_teacher_sessions:
            effective_max_teacher_sessions = base_hint_sessions
            validation_max_teacher_sessions = max(validation_max_teacher_sessions, effective_max_teacher_sessions)
        if (
            solver_mode == "auto"
            and base_hint
            and not soft_incumbent_base_hint
            and not constraints_active
            and base_hint_sessions > 0
            and max_teacher_sessions < base_hint_sessions
        ):
            effective_max_teacher_sessions = base_hint_sessions
            validation_max_teacher_sessions = effective_max_teacher_sessions
            ctx.warnings.append(
                f"max_teacher_sessions={max_teacher_sessions} thấp hơn nghiệm chuẩn {base_hint_sessions}; "
                f"đã dùng {base_hint_sessions} để tránh bài toán vô nghiệm."
            )

        def fixed_base_hint(reason: str, extra: dict[str, Any] | None = None) -> tuple[list[SessionAllocation], dict[str, Any]]:
            if not base_hint or not base_hint_complete:
                raise RuntimeError("Missing complete base session hint for fallback.")
            hinted_allocations = list(base_hint)
            load_dist: dict[int, int] = {}
            grouped: dict[tuple[str, int, str], int] = {}
            for item in hinted_allocations:
                key = (item.teacher, item.session.day, item.session.part)
                grouped[key] = grouped.get(key, 0) + item.count
            for load in grouped.values():
                load_dist[load] = load_dist.get(load, 0) + 1
            hinted_metrics = {
                "solver": f"base_{base_hint_sessions}_session_hint",
                "status_name": "FIXED_HINT",
                "teacher_sessions": base_hint_sessions,
                "one_period_teacher_sessions": int(load_dist.get(1, 0)),
                "load_distribution": dict(sorted(load_dist.items())),
                "fallback_reason": reason,
                "requested_max_teacher_sessions": requested_max_teacher_sessions,
                "effective_max_teacher_sessions": effective_max_teacher_sessions,
                "hint": {
                    "used": True,
                    "fixed": True,
                    "hinted_assignment_sessions": len(hinted_allocations),
                    "hinted_teacher_sessions": base_hint_sessions,
                },
            }
            if extra:
                hinted_metrics["fallback_context"] = extra
            return hinted_allocations, hinted_metrics

        def session_status_unknown(metrics: Mapping[str, Any] | None) -> bool:
            return str((metrics or {}).get("status_name") or "").strip().upper() == "UNKNOWN"

        def session_fallback_phase_limit(requested: int, minimum: int = 6) -> int:
            requested = max(minimum, int(requested or minimum))
            remaining = deadline.remaining()
            if remaining is None:
                return requested
            if remaining <= 2:
                return 1
            return max(1, min(requested, int(remaining - 1)))

        def try_milp_full_session_fallback(
            reason: str,
            failed_metrics: Mapping[str, Any],
            *,
            cap: int | None,
            time_limit_seconds: int,
            extra: Mapping[str, Any] | None = None,
        ) -> tuple[list[SessionAllocation], dict[str, Any]] | None:
            if deadline.exhausted(1):
                return None
            try:
                milp_allocations, milp_metrics = solve_session_allocation(
                    ctx.school_data,
                    rules=effective_rules,
                    fixed_lessons=session_fixed_lessons,
                    max_teacher_sessions=cap,
                    minimize_sessions=minimize_sessions,
                    time_limit_seconds=session_fallback_phase_limit(time_limit_seconds),
                    verbose=False,
                    progress=progress,
                )
            except Exception as milp_exc:  # noqa: BLE001 - keep the CP-SAT path available.
                ctx.warnings.append(f"Thu fallback MILP cap buoi khong thanh cong: {milp_exc}")
                return None
            expected_periods = sum(item.periods_per_week for item in ctx.school_data.assignments)
            allocated_periods = sum(item.count for item in milp_allocations)
            if allocated_periods < expected_periods:
                ctx.warnings.append(
                    f"Bo qua fallback MILP cap buoi vi moi xep {allocated_periods}/{expected_periods} tiet."
                )
                return None
            milp_metrics = dict(milp_metrics)
            milp_metrics["solver"] = "scipy_milp_session_fallback"
            milp_metrics["fallback_reason"] = reason
            milp_metrics["previous_solver"] = dict(failed_metrics)
            if extra:
                milp_metrics["fallback_context"] = dict(extra)
            milp_metrics["requested_max_teacher_sessions"] = requested_max_teacher_sessions
            milp_metrics["effective_max_teacher_sessions"] = cap
            milp_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
            milp_metrics.setdefault("random_seed", random_seed)
            return milp_allocations, milp_metrics

        def session_best_effort(
            reason: str,
            failed_metrics: Mapping[str, Any],
            *,
            cap: int | None,
            time_limit_seconds: int,
            extra: Mapping[str, Any] | None = None,
        ) -> tuple[list[SessionAllocation], dict[str, Any]]:
            if not best_effort_on_timeout:
                raise SessionCpSatNoSolution(
                    "No CP-SAT session solution found and best-effort is disabled.",
                    dict(failed_metrics),
                )
            if progress:
                progress(
                    {
                        "stage": "session_cp_sat:best_effort",
                        "message": "Rang buoc cap buoi vo nghiem; thu xep toi da va dua tiet con lai vao chua phan.",
                        "reason": reason,
                        "max_teacher_sessions": cap,
                        "time_limit_seconds": time_limit_seconds,
                    }
                )
            try:
                partial_allocations, partial_metrics = solve_session_allocation_cp_sat(
                    ctx.school_data,
                    rules=effective_rules,
                    max_teacher_sessions=cap,
                    max_one_period_sessions=max_one_period_sessions,
                    allow_unassigned=True,
                    minimize_sessions=True,
                    minimize_one_period_sessions=minimize_one_period_sessions,
                    one_period_priority_absolute=one_period_priority_absolute,
                    time_limit_seconds=session_fallback_phase_limit(time_limit_seconds),
                    linearization_level=session_linearization_level,
                    num_workers=solver_workers,
                    random_seed=random_seed,
                    hint_allocations=base_hint,
                    fixed_lessons=session_fixed_lessons,
                    repair_hint=base_hint is not None,
                    minimize_hint_distance=soft_incumbent_base_hint is not None,
                    period_feasibility_session_indexes=period_feasibility_all_sessions or None,
                    legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                    progress=progress,
                )
            except SessionCpSatNoSolution as cp_sat_exc:
                # UNKNOWN on the VPS usually means the CP-SAT portfolio ran out of
                # time, not that the timetable is truly infeasible. Try the older
                # deterministic MILP session model before surfacing an error.
                try:
                    partial_allocations, partial_metrics = solve_session_allocation(
                        ctx.school_data,
                        rules=effective_rules,
                        fixed_lessons=session_fixed_lessons,
                        max_teacher_sessions=cap,
                        minimize_sessions=minimize_sessions,
                        time_limit_seconds=session_fallback_phase_limit(max(time_limit_seconds, session_time_limit, 20)),
                        verbose=False,
                        progress=progress,
                    )
                    partial_metrics = dict(partial_metrics)
                    partial_metrics["solver"] = "scipy_milp_session_best_effort_fallback"
                    partial_metrics["cp_sat_best_effort_error"] = dict(cp_sat_exc.metrics)
                except Exception as milp_exc:  # noqa: BLE001 - preserve the CP-SAT diagnostics.
                    merged_metrics = dict(cp_sat_exc.metrics)
                    merged_metrics["milp_best_effort_fallback_error"] = str(milp_exc)
                    raise SessionCpSatNoSolution(
                        "No CP-SAT session solution found during best-effort fallback.",
                        merged_metrics,
                    ) from milp_exc
            partial_metrics = dict(partial_metrics)
            dropped = int(partial_metrics.get("unassigned_periods") or 0)
            if dropped > 0:
                milp_full = try_milp_full_session_fallback(
                    "cp_sat_best_effort_partial_used_milp_full_fallback",
                    partial_metrics,
                    cap=cap,
                    time_limit_seconds=max(time_limit_seconds, session_time_limit, 20),
                )
                if milp_full is not None:
                    partial_allocations, partial_metrics = milp_full
                    dropped = 0
            partial_metrics["fallback_reason"] = reason
            partial_metrics["initial_session_error"] = dict(failed_metrics)
            if extra:
                partial_metrics["fallback_context"] = dict(extra)
            partial_metrics["requested_max_teacher_sessions"] = requested_max_teacher_sessions
            partial_metrics["effective_max_teacher_sessions"] = cap
            partial_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
            partial_metrics.setdefault("random_seed", random_seed)
            partial_metrics["best_effort"] = True
            scheduled = sum(max(0, int(item.count)) for item in partial_allocations)
            expected = sum(max(0, int(item.periods_per_week)) for item in ctx.school_data.assignments)
            partial_metrics["scheduled_periods"] = scheduled
            partial_metrics["unassigned_periods"] = max(0, expected - scheduled)
            if expected > 0 and scheduled <= 0:
                partial_metrics["all_unassigned_incumbent_rejected"] = True
                raise SessionCpSatNoSolution(
                    "No CP-SAT session solution found before deadline: "
                    f"best-effort scheduled 0/{expected} periods.",
                    partial_metrics,
                )
            if dropped > 0:
                ctx.warnings.append(
                    f"Con {dropped} tiet chua phan vi rang buoc cap buoi khong the xep du 100%."
                )
            return partial_allocations, partial_metrics

        def solve_full_with_relaxed_one_period_cap(
            reason: str,
            failed_metrics: Mapping[str, Any],
            *,
            cap: int | None,
            time_limit_seconds: int,
            extra: Mapping[str, Any] | None = None,
        ) -> tuple[list[SessionAllocation], dict[str, Any]] | None:
            nonlocal validation_max_teacher_sessions
            if max_one_period_sessions is None:
                return None
            try:
                relaxed_allocations, relaxed_metrics = solve_session_allocation_cp_sat(
                    ctx.school_data,
                    rules=effective_rules,
                    max_teacher_sessions=cap,
                    max_one_period_sessions=None,
                    minimize_sessions=True,
                    minimize_one_period_sessions=minimize_one_period_sessions,
                    one_period_priority_absolute=one_period_priority_absolute,
                    time_limit_seconds=deadline.phase_limit(time_limit_seconds, reserve_seconds=period_phase_reserve_seconds),
                    early_stop_teacher_sessions=(
                        cap if fast_quality_warmup_direct else None
                    ),
                    early_stop_max_one_period_sessions=None,
                    linearization_level=session_linearization_level,
                    num_workers=solver_workers,
                    random_seed=random_seed,
                    hint_allocations=base_hint,
                    fixed_lessons=session_fixed_lessons,
                    repair_hint=base_hint is not None,
                    minimize_hint_distance=soft_incumbent_base_hint is not None,
                    period_feasibility_session_indexes=period_feasibility_all_sessions or None,
                    legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                    progress=progress,
                )
            except SessionCpSatNoSolution as relaxed_one_period_exc:
                ctx.warnings.append(
                    "Khong tim duoc phuong an day du sau khi noi cap buoi GV 1 tiet: "
                    f"{relaxed_one_period_exc.metrics.get('status_name')}."
                )
                return None
            relaxed_metrics = dict(relaxed_metrics)
            actual_sessions = int(relaxed_metrics.get("teacher_sessions") or 0)
            validation_max_teacher_sessions = max(validation_max_teacher_sessions, actual_sessions)
            relaxed_metrics["fallback_reason"] = reason
            relaxed_metrics["one_period_cap_relaxed"] = True
            relaxed_metrics["target_one_period_teacher_sessions"] = max_one_period_sessions
            relaxed_metrics["initial_session_error"] = dict(failed_metrics)
            if extra:
                relaxed_metrics["fallback_context"] = dict(extra)
            relaxed_metrics["requested_max_teacher_sessions"] = requested_max_teacher_sessions
            relaxed_metrics["effective_max_teacher_sessions"] = max(
                validation_max_teacher_sessions,
                cap or 0,
                actual_sessions,
            )
            relaxed_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
            relaxed_metrics.setdefault("random_seed", random_seed)
            ctx.warnings.append(
                "Da noi cap buoi GV 1 tiet de giu lich day du; "
                "chi tieu nay se duoc bao nhu best-effort neu van con."
            )
            return relaxed_allocations, relaxed_metrics

        if effective_max_teacher_sessions != max_teacher_sessions and base_hint_complete:
            allocations, session_metrics = fixed_base_hint("requested_cap_below_validated_base_hint")
        else:
            try:
                allocations, session_metrics = solve_session_allocation_cp_sat(
                    ctx.school_data,
                    rules=effective_rules,
                    max_teacher_sessions=effective_max_teacher_sessions,
                    max_one_period_sessions=max_one_period_sessions,
                    minimize_sessions=True,
                    minimize_one_period_sessions=minimize_one_period_sessions,
                    one_period_priority_absolute=one_period_priority_absolute,
                    time_limit_seconds=deadline.phase_limit(session_time_limit, reserve_seconds=period_phase_reserve_seconds),
                    early_stop_teacher_sessions=session_early_stop_teacher_sessions,
                    early_stop_max_one_period_sessions=session_early_stop_max_one_period_sessions,
                    linearization_level=session_linearization_level,
                    num_workers=solver_workers,
                    random_seed=random_seed,
                    hint_allocations=base_hint,
                    fixed_lessons=session_fixed_lessons,
                    repair_hint=base_hint is not None,
                    minimize_hint_distance=soft_incumbent_base_hint is not None,
                    period_feasibility_session_indexes=period_feasibility_all_sessions or None,
                    legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                    progress=progress,
                )
            except SessionCpSatNoSolution as exc:
                milp_fallback = (
                    try_milp_full_session_fallback(
                        "cp_sat_unknown_used_milp_session_fallback",
                        exc.metrics,
                        cap=effective_max_teacher_sessions,
                        time_limit_seconds=max(session_time_limit, 20),
                    )
                    if (
                        session_status_unknown(exc.metrics)
                        and not best_effort_on_timeout
                        and not fast_quality_warmup_direct
                    )
                    else None
                )
                if milp_fallback is not None:
                    allocations, session_metrics = milp_fallback
                elif (
                    base_hint_complete
                    and not constraints_active
                    and base_hint_sessions <= effective_max_teacher_sessions
                ):
                    allocations, session_metrics = fixed_base_hint("session_search_no_solution", {"search_error": exc.metrics})
                elif (
                    solver_mode == "auto"
                    and search_teacher_sessions
                    and max_teacher_sessions is not None
                    and not strict_teacher_session_cap
                ):
                    relaxed_cap = _relaxed_teacher_session_cap(
                        effective_max_teacher_sessions,
                        original_expected_periods,
                    )
                    relaxed_time_limit = max(session_time_limit, 30)
                    if progress:
                        progress(
                            {
                                "stage": "session_cp_sat:cap_relax",
                                "message": (
                                    f"Cap {effective_max_teacher_sessions} chua kha thi; "
                                    f"thu relax len {relaxed_cap} nhung van toi uu so buoi GV"
                                ),
                                "requested_max_teacher_sessions": requested_max_teacher_sessions,
                                "failed_cap": effective_max_teacher_sessions,
                                "relaxed_cap": relaxed_cap,
                                "time_limit_seconds": relaxed_time_limit,
                            }
                        )
                    try:
                        allocations, session_metrics = solve_session_allocation_cp_sat(
                            ctx.school_data,
                            rules=effective_rules,
                            max_teacher_sessions=relaxed_cap,
                            max_one_period_sessions=max_one_period_sessions,
                            minimize_sessions=True,
                            minimize_one_period_sessions=minimize_one_period_sessions,
                            one_period_priority_absolute=one_period_priority_absolute,
                            time_limit_seconds=deadline.phase_limit(relaxed_time_limit, reserve_seconds=period_phase_reserve_seconds),
                            early_stop_teacher_sessions=(
                                relaxed_cap if fast_quality_warmup_direct else None
                            ),
                            early_stop_max_one_period_sessions=(
                                max_one_period_sessions if fast_quality_warmup_direct else None
                            ),
                            linearization_level=session_linearization_level,
                            num_workers=solver_workers,
                            random_seed=random_seed,
                            hint_allocations=base_hint,
                            fixed_lessons=session_fixed_lessons,
                            repair_hint=base_hint is not None,
                            minimize_hint_distance=soft_incumbent_base_hint is not None,
                            period_feasibility_session_indexes=period_feasibility_all_sessions or None,
                            legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                            progress=progress,
                        )
                    except SessionCpSatNoSolution as relaxed_exc:
                        milp_fallback = (
                            try_milp_full_session_fallback(
                                "relaxed_cp_sat_unknown_used_milp_session_fallback",
                                relaxed_exc.metrics,
                                cap=relaxed_cap,
                                time_limit_seconds=relaxed_time_limit,
                                extra={"initial_cap_error": exc.metrics},
                            )
                            if (
                                session_status_unknown(relaxed_exc.metrics)
                                and not best_effort_on_timeout
                                and not fast_quality_warmup_direct
                            )
                            else None
                        )
                        if milp_fallback is not None:
                            allocations, session_metrics = milp_fallback
                        else:
                            relaxed_one_period = solve_full_with_relaxed_one_period_cap(
                                "relaxed_one_period_cap_after_relaxed_teacher_cap_no_solution",
                                relaxed_exc.metrics,
                                cap=relaxed_cap,
                                time_limit_seconds=relaxed_time_limit,
                                extra={"initial_cap_error": exc.metrics},
                            )
                            if relaxed_one_period is not None:
                                allocations, session_metrics = relaxed_one_period
                            else:
                                allocations, session_metrics = session_best_effort(
                                    "session_constraints_best_effort_after_relaxed_cap_no_solution",
                                    relaxed_exc.metrics,
                                    cap=relaxed_cap,
                                    time_limit_seconds=relaxed_time_limit,
                                    extra={"initial_cap_error": exc.metrics},
                                )
                    else:
                        session_metrics = dict(session_metrics)
                        actual_sessions = int(session_metrics.get("teacher_sessions") or relaxed_cap)
                        validation_max_teacher_sessions = max(validation_max_teacher_sessions, actual_sessions)
                        session_metrics["fallback_reason"] = "relaxed_after_requested_cap_no_solution"
                        session_metrics["initial_cap_error"] = exc.metrics
                        session_metrics["requested_max_teacher_sessions"] = requested_max_teacher_sessions
                        session_metrics["effective_max_teacher_sessions"] = max(actual_sessions, requested_max_teacher_sessions)
                        session_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
                        session_metrics.setdefault("random_seed", random_seed)
                        if actual_sessions > requested_max_teacher_sessions:
                            ctx.warnings.append(
                                f"max_teacher_sessions={requested_max_teacher_sessions} khong kha thi voi rang buoc hien tai; "
                                f"da relax va tim duoc {actual_sessions} buoi GV."
                            )
                else:
                    relaxed_one_period = solve_full_with_relaxed_one_period_cap(
                        "relaxed_one_period_cap_after_session_no_solution",
                        exc.metrics,
                        cap=effective_max_teacher_sessions,
                        time_limit_seconds=max(session_time_limit, 30),
                    )
                    if relaxed_one_period is not None:
                        allocations, session_metrics = relaxed_one_period
                    else:
                        allocations, session_metrics = session_best_effort(
                            "session_constraints_best_effort_no_full_solution",
                            exc.metrics,
                            cap=effective_max_teacher_sessions,
                            time_limit_seconds=max(session_time_limit, 30),
                        )
            else:
                session_metrics = dict(session_metrics)
                session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                session_metrics.setdefault("effective_max_teacher_sessions", effective_max_teacher_sessions)
                session_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
                session_metrics.setdefault("random_seed", random_seed)
                if (
                    base_hint_complete
                    and not constraints_active
                    and base_hint_sessions <= effective_max_teacher_sessions
                    and int(session_metrics.get("teacher_sessions") or 10**9) > base_hint_sessions
                ):
                    allocations, session_metrics = fixed_base_hint("session_search_worse_than_base_hint", {"search_result": session_metrics})
        period_best_effort_candidate: tuple[
            list[Lesson],
            list[SessionAllocation],
            dict[str, Any],
            dict[str, Any],
            PeriodAllocationError,
        ] | None = None
        try:
            lessons, period_metrics = allocate_periods(
                ctx.school_data,
                allocations,
                rules=effective_rules,
                fixed_lessons=session_fixed_lessons,
                time_limit_seconds_per_session=period_time_limit,
                retry_time_limit_seconds_per_session=period_retry_time_limit,
                remaining_time_seconds=deadline.remaining,
                max_teacher_gap=period_max_teacher_gap,
                minimize_teacher_gaps=period_minimize_teacher_gaps,
                best_effort=best_effort_on_timeout,
                verbose=False,
                progress=progress,
                max_workers=solver_workers,
            )
            relaxed_period_repair = try_relaxed_period_gap_repair(
                allocations,
                period_metrics,
                "initial_period_best_effort",
            )
            if relaxed_period_repair is not None:
                lessons, period_metrics = relaxed_period_repair
            if (
                best_effort_on_timeout
                and not capacity_excluded_lessons
                and not deadline.exhausted(period_phase_reserve_seconds)
            ):
                retry_error = _period_retry_error_from_best_effort(lessons, period_metrics)
                if retry_error is not None:
                    period_best_effort_candidate = (
                        list(lessons),
                        list(allocations),
                        dict(session_metrics),
                        dict(period_metrics),
                        retry_error,
                    )
                    raise retry_error
            solver_metrics = {
                "session_solver": session_metrics,
                "period_solver": period_metrics,
            }
        except Exception as exc:
            retry_solution: tuple[list[Lesson], list[SessionAllocation], dict[str, Any], dict[str, Any]] | None = None
            if solver_mode == "auto" and constraints_active and not fixed_existing_lessons:
                retry_errors: list[str] = []
                forbidden_vectors = _forbidden_session_vector_from_period_error(ctx.school_data, allocations, exc)
                retry_primary_seed = random_seed if random_seed is not None else 1
                retry_seeds: list[int | None] = [retry_primary_seed, 1, 17]
                if _truthy_setting(settings.get("deep_session_rescue")):
                    retry_seeds.extend([29, None])
                seen_retry_seeds: set[int | None] = set()
                retry_best_metrics: dict[str, Any] | None = None
                for retry_index, retry_seed in enumerate(retry_seeds, start=1):
                    if retry_seed in seen_retry_seeds:
                        continue
                    seen_retry_seeds.add(retry_seed)
                    try:
                        retry_session_limit = max(18, session_time_limit)
                        if _truthy_setting(settings.get("deep_session_rescue")):
                            retry_session_limit = max(30, retry_session_limit)
                        retry_allocations, retry_session_metrics = solve_session_allocation_cp_sat(
                            ctx.school_data,
                            rules=effective_rules,
                            max_teacher_sessions=effective_max_teacher_sessions,
                            max_one_period_sessions=max_one_period_sessions,
                            minimize_sessions=True,
                            minimize_one_period_sessions=minimize_one_period_sessions,
                            one_period_priority_absolute=one_period_priority_absolute,
                            time_limit_seconds=deadline.phase_limit(
                                min(retry_session_limit, 45),
                                reserve_seconds=period_phase_reserve_seconds,
                            ),
                            linearization_level=session_linearization_level,
                            num_workers=solver_workers,
                            random_seed=retry_seed,
                            hint_allocations=base_hint,
                            fixed_lessons=session_fixed_lessons,
                            repair_hint=base_hint is not None,
                            forbidden_session_vectors=forbidden_vectors,
                            period_feasibility_session_indexes=(
                                period_feasibility_all_sessions | {si for si, _counts in forbidden_vectors}
                            ) or None,
                            legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                            minimize_hint_distance=soft_incumbent_base_hint is not None,
                            progress=progress,
                        )
                        retry_lessons, retry_period_metrics = allocate_periods(
                            ctx.school_data,
                            retry_allocations,
                            rules=effective_rules,
                            fixed_lessons=session_fixed_lessons,
                            time_limit_seconds_per_session=period_time_limit,
                            retry_time_limit_seconds_per_session=period_retry_time_limit,
                            remaining_time_seconds=deadline.remaining,
                            max_teacher_gap=period_max_teacher_gap,
                            minimize_teacher_gaps=period_minimize_teacher_gaps,
                            best_effort=best_effort_on_timeout,
                            verbose=False,
                            progress=progress,
                            max_workers=solver_workers,
                        )
                        relaxed_retry_repair = try_relaxed_period_gap_repair(
                            retry_allocations,
                            retry_period_metrics,
                            f"retry_{retry_index}_period_best_effort",
                        )
                        if relaxed_retry_repair is not None:
                            retry_lessons, retry_period_metrics = relaxed_retry_repair
                        retry_metrics = compute_metrics(ctx.school_data, retry_lessons, rules=effective_rules)
                        retry_sessions = int(retry_metrics.get("teacher_sessions") or 10**9)
                        previous_sessions = int(session_metrics.get("teacher_sessions") or retry_sessions)
                        retry_clean = _gap0_metrics_clean(retry_metrics) or (
                            allow_one_period_gaps and _session_priority_metrics_acceptable(retry_metrics)
                        ) or (
                            bool(retry_period_metrics.get("relaxed_period_teacher_gap"))
                            and _complete_schedule_metrics_acceptable(retry_metrics)
                        )
                        if retry_clean and retry_sessions <= max(previous_sessions + 2, max_teacher_sessions):
                            if retry_best_metrics is None or _session_priority_better(retry_metrics, retry_best_metrics):
                                retry_session_metrics = dict(retry_session_metrics)
                                retry_session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                                retry_session_metrics.setdefault("effective_max_teacher_sessions", effective_max_teacher_sessions)
                                retry_session_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
                                retry_session_metrics.setdefault("random_seed", retry_seed)
                                retry_session_metrics["fallback_reason"] = "period_allocation_retry_replaced_infeasible_session_vector"
                                retry_session_metrics["period_allocation_error"] = str(exc)
                                retry_session_metrics["period_retry_attempt"] = retry_index
                                retry_session_metrics["previous_solver"] = session_metrics
                                retry_best_metrics = dict(retry_metrics)
                                retry_solution = (
                                    retry_lessons,
                                    retry_allocations,
                                    retry_session_metrics,
                                    retry_period_metrics,
                                )
                            if retry_sessions <= previous_sessions:
                                break
                            continue
                        retry_errors.append(f"seed={retry_seed}: unclean_or_worse sessions={retry_sessions}")
                    except Exception as retry_exc:  # noqa: BLE001 - fall back to the validated hint rescue below.
                        retry_errors.append(f"seed={retry_seed}: {retry_exc}")
                if retry_errors:
                    ctx.warnings.append("Thu lai CP-SAT sau loi xep tiet: " + " | ".join(retry_errors[:3]))
            if retry_solution is not None:
                lessons, allocations, session_metrics, period_metrics = retry_solution
                solver_metrics = {
                    "session_solver": session_metrics,
                    "period_solver": period_metrics,
                }
            else:
                rescue_hint = _load_base_period_hint(ctx.school_data, settings)
                rescue = None
                rescue_error: Exception | None = None
                skip_gap0_rescue_for_best_effort = (
                    period_best_effort_candidate is not None
                    and best_effort_on_timeout
                    and deadline.exhausted(period_phase_reserve_seconds)
                )
                if (
                    solver_mode == "auto"
                    and rescue_hint is not None
                    and constraints_active
                    and not skip_gap0_rescue_for_best_effort
                ):
                    try:
                        rescue_lessons, rescue_period_metrics = solve_gap0_cp_sat(
                            ctx.school_data,
                            rules=effective_rules,
                            max_teacher_sessions=max(validation_max_teacher_sessions, max_teacher_sessions),
                            time_limit_seconds=deadline.phase_limit(max(30, min(integrated_time_limit, period_time_limit, 120))),
                            num_workers=solver_workers,
                            hint_lessons=_merge_existing_lessons_with_hint(
                                ctx.school_data,
                                fixed_existing_lessons,
                                rescue_hint,
                            ),
                            fixed_lessons=[],
                            prefer_hint=True,
                            random_seed=random_seed,
                            progress=progress,
                        )
                        rescue_metrics = compute_metrics(ctx.school_data, rescue_lessons, rules=effective_rules)
                        if _gap0_metrics_clean(rescue_metrics) or (
                            allow_one_period_gaps and _session_priority_metrics_acceptable(rescue_metrics)
                        ):
                            rescue = (rescue_lessons, {"gap0_cp_sat": rescue_period_metrics})
                    except Exception as gap_exc:  # noqa: BLE001 - keep the original period allocation failure if rescue also fails.
                        rescue_error = gap_exc
                if (
                    solver_mode == "auto"
                    and rescue_hint is not None
                    and constraints_active
                    and not fixed_existing_lessons
                    and rescue is None
                ):
                    if fresh_randomize:
                        rescue = _period_hint_variant(
                            ctx.school_data,
                            rescue_hint,
                            effective_rules,
                            random_seed=random_seed,
                            allow_gap1=allow_one_period_gaps,
                        )
                    if rescue is None:
                        rescue_metrics = compute_metrics(ctx.school_data, rescue_hint, rules=effective_rules)
                        if _gap0_metrics_clean(rescue_metrics):
                            rescue = (rescue_hint, {})
                if rescue is None:
                    if rescue_error is not None:
                        ctx.warnings.append(f"Khong cuu duoc bang CP-SAT tong the sau khi period allocation loi: {rescue_error}")
                    if period_best_effort_candidate is None or not best_effort_on_timeout:
                        raise
                    (
                        lessons,
                        allocations,
                        saved_session_metrics,
                        saved_period_metrics,
                        saved_retry_error,
                    ) = period_best_effort_candidate
                    session_metrics = dict(saved_session_metrics)
                    session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                    session_metrics.setdefault("effective_max_teacher_sessions", effective_max_teacher_sessions)
                    session_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
                    session_metrics.setdefault("random_seed", random_seed)
                    session_metrics["fallback_reason"] = "period_allocation_retry_failed_returned_best_effort"
                    session_metrics["period_allocation_error"] = str(exc)
                    session_metrics["best_effort_retry_error"] = saved_retry_error.to_dict()
                    session_metrics["gap0_rescue_error"] = str(rescue_error) if rescue_error is not None else None
                    solver_metrics = {
                        "session_solver": session_metrics,
                        "period_solver": saved_period_metrics,
                    }
                    ctx.warnings.append(
                        "Da tra lich best-effort sau khi thu lai session vector nhung van con buoi khong xep duoc."
                    )
                else:
                    lessons, rescue_meta = rescue
                    allocations = _allocations_from_lessons(lessons)
                    rescued_metrics = compute_metrics(ctx.school_data, lessons, rules=effective_rules)
                    rescue_solver = "validated_gap0_period_hint_variant" if rescue_meta else "base_180_gap0_period_hint"
                    validation_max_teacher_sessions = max(
                        validation_max_teacher_sessions,
                        int(rescued_metrics.get("teacher_sessions") or 0),
                    )
                    solver_metrics = {
                        "session_solver": {
                            "solver": rescue_solver,
                            "status_name": "FIXED_HINT",
                            "teacher_sessions": rescued_metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": rescued_metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": rescued_metrics.get("gap_distribution"),
                            "fallback_reason": "session_period_allocation_failed_used_validated_gap0_hint",
                            "period_allocation_error": str(exc),
                            "gap0_rescue_error": str(rescue_error) if rescue_error is not None else None,
                            "previous_solver": session_metrics,
                            "requested_max_teacher_sessions": requested_max_teacher_sessions,
                            "effective_max_teacher_sessions": validation_max_teacher_sessions,
                            "fresh_randomize": bool(fresh_randomize),
                            "random_seed": random_seed,
                            "hint": {
                                "used": True,
                                "fixed": True,
                                "variant": rescue_meta or None,
                                "hinted_periods": len(lessons),
                                "hinted_teacher_sessions": _teacher_session_count_for_lessons(lessons),
                            },
                        },
                        "period_solver": {
                            "solver": rescue_solver,
                            "already_placed": True,
                            "lesson_count": len(lessons),
                        },
                    }
    elif search_teacher_sessions and not minimize_sessions:
        allocations, session_metrics = solve_session_allocation_with_cap_search(
            ctx.school_data,
            rules=effective_rules,
            max_teacher_sessions=max_teacher_sessions,
            time_limit_seconds_per_cap=deadline.phase_limit(session_time_limit, reserve_seconds=period_phase_reserve_seconds),
            remaining_time_seconds=deadline.remaining,
            reserve_seconds=max(
                12.0,
                float(period_retry_time_limit + 4),
                float(_to_int(settings.get("one_period_gap0_probe_time_limit"), 30))
                if minimize_one_period_sessions
                else 0.0,
            ),
            verbose=False,
            progress=progress,
        )
        effective_cap = _to_int(session_metrics.get("effective_max_teacher_sessions"), 0)
        if effective_cap > validation_max_teacher_sessions:
            validation_max_teacher_sessions = effective_cap
            ctx.warnings.append(
                f"max_teacher_sessions={requested_max_teacher_sessions} khÃ´ng kháº£ thi vá»›i rÃ ng buá»™c hiá»‡n táº¡i; "
                f"Ä‘Ã£ tá»± má»Ÿ rá»™ng Ä‘áº¿n {effective_cap} Ä‘á»ƒ giá»¯ lá»‹ch há»£p lá»‡."
            )
        actual_sessions = _to_int(session_metrics.get("teacher_sessions"), 0)
        if requested_max_teacher_sessions < actual_sessions <= validation_max_teacher_sessions:
            ctx.warnings.append(
                f"RÃ ng buá»™c hiá»‡n táº¡i cáº§n {actual_sessions} buá»•i GV, cao hÆ¡n má»©c yÃªu cáº§u {requested_max_teacher_sessions}; "
                "Ä‘Ã£ giá»¯ nghiá»‡m kháº£ thi tháº¥p nháº¥t tÃ¬m Ä‘Æ°á»£c."
            )
        try:
            lessons, period_metrics = allocate_periods(
                ctx.school_data,
                allocations,
                rules=effective_rules,
                fixed_lessons=session_fixed_lessons,
                time_limit_seconds_per_session=period_time_limit,
                retry_time_limit_seconds_per_session=period_retry_time_limit,
                remaining_time_seconds=deadline.remaining,
                max_teacher_gap=period_max_teacher_gap,
                minimize_teacher_gaps=period_minimize_teacher_gaps,
                best_effort=best_effort_on_timeout,
                verbose=False,
                progress=progress,
                max_workers=solver_workers,
            )
            solver_metrics = {
                "session_solver": session_metrics,
                "period_solver": period_metrics,
            }
        except Exception as exc:
            rescue_hint = _load_base_period_hint(ctx.school_data, settings)
            rescue = None
            if (
                solver_mode == "auto"
                and rescue_hint is not None
                and constraints_active
                and not fixed_existing_lessons
            ):
                if fresh_randomize:
                    rescue = _period_hint_variant(
                        ctx.school_data,
                        rescue_hint,
                        effective_rules,
                        random_seed=random_seed,
                        allow_gap1=allow_one_period_gaps,
                    )
                if rescue is None:
                    rescue_metrics = compute_metrics(ctx.school_data, rescue_hint, rules=effective_rules)
                    if _gap0_metrics_clean(rescue_metrics):
                        rescue = (rescue_hint, {})
            if rescue is None:
                raise
            lessons, rescue_meta = rescue
            allocations = _allocations_from_lessons(lessons)
            rescued_metrics = compute_metrics(ctx.school_data, lessons, rules=effective_rules)
            rescue_solver = "validated_gap0_period_hint_variant" if rescue_meta else "base_180_gap0_period_hint"
            validation_max_teacher_sessions = max(
                validation_max_teacher_sessions,
                int(rescued_metrics.get("teacher_sessions") or 0),
            )
            solver_metrics = {
                "session_solver": {
                    "solver": rescue_solver,
                    "status_name": "FIXED_HINT",
                    "teacher_sessions": rescued_metrics.get("teacher_sessions"),
                    "one_period_teacher_sessions": rescued_metrics.get("one_period_teacher_sessions"),
                    "gap_distribution": rescued_metrics.get("gap_distribution"),
                    "fallback_reason": "cap_search_period_allocation_failed_used_validated_gap0_hint",
                    "period_allocation_error": str(exc),
                    "previous_solver": session_metrics,
                    "requested_max_teacher_sessions": requested_max_teacher_sessions,
                    "effective_max_teacher_sessions": validation_max_teacher_sessions,
                    "fresh_randomize": bool(fresh_randomize),
                    "random_seed": random_seed,
                    "hint": {
                        "used": True,
                        "fixed": True,
                        "variant": rescue_meta or None,
                        "hinted_periods": len(lessons),
                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(lessons),
                    },
                },
                "period_solver": {
                    "solver": rescue_solver,
                    "already_placed": True,
                    "lesson_count": len(lessons),
                },
            }
    else:
        allocations, session_metrics = solve_session_allocation(
            ctx.school_data,
            rules=effective_rules,
            fixed_lessons=session_fixed_lessons,
            max_teacher_sessions=max_teacher_sessions,
            minimize_sessions=minimize_sessions,
            time_limit_seconds=deadline.phase_limit(session_time_limit, reserve_seconds=period_phase_reserve_seconds),
            verbose=False,
            progress=progress,
        )
        try:
            lessons, period_metrics = allocate_periods(
                ctx.school_data,
                allocations,
                rules=effective_rules,
                fixed_lessons=session_fixed_lessons,
                time_limit_seconds_per_session=period_time_limit,
                retry_time_limit_seconds_per_session=period_retry_time_limit,
                remaining_time_seconds=deadline.remaining,
                max_teacher_gap=period_max_teacher_gap,
                minimize_teacher_gaps=period_minimize_teacher_gaps,
                best_effort=best_effort_on_timeout and bool(capacity_excluded_lessons),
                verbose=False,
                progress=progress,
                max_workers=solver_workers,
            )
            solver_metrics = {
                "session_solver": session_metrics,
                "period_solver": period_metrics,
            }
        except Exception as exc:
            retry_solution: tuple[list[Lesson], list[SessionAllocation], dict[str, Any], dict[str, Any]] | None = None
            if solver_mode == "auto" and constraints_active and not fixed_existing_lessons and not deadline.exhausted(4):
                retry_errors: list[str] = []
                retry_base_hint = _load_base_session_hint(ctx.school_data, prefer_gap3=False, settings=settings)
                forbidden_vectors = _forbidden_session_vector_from_period_error(ctx.school_data, allocations, exc)
                retry_seed = random_seed if random_seed is not None else 1
                try:
                    retry_allocations, retry_session_metrics = solve_session_allocation_cp_sat(
                        ctx.school_data,
                        rules=effective_rules,
                        max_teacher_sessions=max_teacher_sessions,
                        max_one_period_sessions=max_one_period_sessions,
                        minimize_sessions=True,
                        minimize_one_period_sessions=minimize_one_period_sessions,
                        one_period_priority_absolute=one_period_priority_absolute,
                        time_limit_seconds=deadline.phase_limit(max(18, session_time_limit), reserve_seconds=period_phase_reserve_seconds),
                        linearization_level=session_linearization_level,
                        num_workers=solver_workers,
                        random_seed=retry_seed,
                        hint_allocations=retry_base_hint,
                        repair_hint=retry_base_hint is not None,
                        forbidden_session_vectors=forbidden_vectors,
                        period_feasibility_session_indexes=(
                            period_feasibility_all_sessions | {si for si, _counts in forbidden_vectors}
                        ) or None,
                        legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                        minimize_hint_distance=retry_base_hint is not None,
                        progress=progress,
                    )
                    retry_lessons, retry_period_metrics = allocate_periods(
                        ctx.school_data,
                        retry_allocations,
                        rules=effective_rules,
                        fixed_lessons=session_fixed_lessons,
                        time_limit_seconds_per_session=period_time_limit,
                        retry_time_limit_seconds_per_session=period_retry_time_limit,
                        remaining_time_seconds=deadline.remaining,
                        max_teacher_gap=period_max_teacher_gap,
                        minimize_teacher_gaps=period_minimize_teacher_gaps,
                        best_effort=best_effort_on_timeout,
                        verbose=False,
                        progress=progress,
                        max_workers=solver_workers,
                    )
                    retry_metrics = compute_metrics(ctx.school_data, retry_lessons, rules=effective_rules)
                    if int(retry_metrics.get("scheduled_periods") or 0) == int(retry_metrics.get("expected_periods") or -1):
                        retry_session_metrics = dict(retry_session_metrics)
                        retry_session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                        retry_session_metrics.setdefault("effective_max_teacher_sessions", max_teacher_sessions)
                        retry_session_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
                        retry_session_metrics.setdefault("random_seed", retry_seed)
                        retry_session_metrics["fallback_reason"] = "milp_session_vector_period_failed_retried_cp_sat"
                        retry_session_metrics["period_allocation_error"] = str(exc)
                        retry_session_metrics["previous_solver"] = session_metrics
                        retry_solution = (
                            retry_lessons,
                            retry_allocations,
                            retry_session_metrics,
                            retry_period_metrics,
                        )
                    else:
                        retry_errors.append(
                            f"cp_sat_retry_incomplete scheduled={retry_metrics.get('scheduled_periods')}/"
                            f"{retry_metrics.get('expected_periods')}"
                        )
                except Exception as retry_exc:  # noqa: BLE001 - fall back below.
                    retry_errors.append(str(retry_exc))
                if retry_errors:
                    ctx.warnings.append("Thu lai CP-SAT sau loi session MILP: " + " | ".join(retry_errors[:3]))
            if retry_solution is not None:
                lessons, allocations, session_metrics, period_metrics = retry_solution
                solver_metrics = {
                    "session_solver": session_metrics,
                    "period_solver": period_metrics,
                }
            else:
                if not best_effort_on_timeout:
                    raise
                lessons, period_metrics = allocate_periods(
                    ctx.school_data,
                    allocations,
                    rules=effective_rules,
                    fixed_lessons=session_fixed_lessons,
                    time_limit_seconds_per_session=period_time_limit,
                    retry_time_limit_seconds_per_session=period_retry_time_limit,
                    remaining_time_seconds=deadline.remaining,
                    max_teacher_gap=period_max_teacher_gap,
                    minimize_teacher_gaps=period_minimize_teacher_gaps,
                    best_effort=True,
                    verbose=False,
                    progress=progress,
                    max_workers=solver_workers,
                )
                session_metrics = dict(session_metrics)
                session_metrics["fallback_reason"] = "milp_session_vector_period_failed_returned_best_effort"
                session_metrics["period_allocation_error"] = str(exc)
                solver_metrics = {
                    "session_solver": session_metrics,
                    "period_solver": period_metrics,
                }

    current_metrics = compute_solution_metrics(lessons)
    if (
        solver_mode == "auto"
        and minimize_one_period_sessions
        and allow_one_period_gaps
        and not fixed_existing_lessons
        and constraints_active
        and int(current_metrics.get("one_period_teacher_sessions") or 0) > 0
        and not deadline.exhausted(2)
    ):
        try:
            period_solver_meta = solver_metrics.get("period_solver", {}) if isinstance(solver_metrics, Mapping) else {}
            session_solver_meta = solver_metrics.get("session_solver", {}) if isinstance(solver_metrics, Mapping) else {}
            hint_meta = session_solver_meta.get("hint", {}) if isinstance(session_solver_meta, Mapping) else {}
            seed_classes_raw = (
                period_solver_meta.get("repaired_classes")
                if isinstance(period_solver_meta, Mapping)
                else None
            ) or (
                hint_meta.get("repaired_classes")
                if isinstance(hint_meta, Mapping)
                else None
            )
            seed_classes = [str(item) for item in seed_classes_raw] if isinstance(seed_classes_raw, list) else None
            cluster_time_limit = min(
                max(0.25, _to_float(settings.get("one_period_cluster_repair_time_limit"), 3.0)),
                max(0.25, float((deadline.remaining() or 4.0) - 1.0)),
            )
            cluster_repair = _repair_one_period_affected_class_cluster(
                ctx.school_data,
                lessons,
                effective_rules,
                seed_classes=seed_classes,
                allow_gap1=allow_one_period_gaps,
                time_limit_seconds=cluster_time_limit,
                max_classes=max(1, _to_int(settings.get("one_period_cluster_repair_max_classes"), 4)),
                max_lessons=max(20, _to_int(settings.get("one_period_cluster_repair_max_lessons"), 120)),
                num_workers=solver_workers,
            )
            if cluster_repair is not None:
                cluster_lessons, cluster_metrics, cluster_meta = cluster_repair
                previous_session_solver = dict(solver_metrics.get("session_solver", {}) or {})
                lessons = cluster_lessons
                allocations = _allocations_from_lessons(lessons)
                current_metrics = cluster_metrics
                validation_max_teacher_sessions = max(
                    validation_max_teacher_sessions,
                    int(cluster_metrics.get("teacher_sessions") or 0),
                )
                cluster_session_metrics = dict(previous_session_solver)
                cluster_session_metrics["fallback_reason"] = "one_period_cluster_repair_reduced_single_period_sessions"
                cluster_session_metrics["previous_solver"] = previous_session_solver
                cluster_session_metrics.update(cluster_meta)
                cluster_session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                cluster_session_metrics["effective_max_teacher_sessions"] = max(
                    validation_max_teacher_sessions,
                    int(cluster_metrics.get("teacher_sessions") or 0),
                )
                cluster_period_metrics = dict(solver_metrics.get("period_solver", {}) or {})
                cluster_period_metrics.update(cluster_meta)
                solver_metrics = {
                    "session_solver": cluster_session_metrics,
                    "period_solver": cluster_period_metrics,
                }
        except Exception as exc:  # noqa: BLE001 - keep the valid timetable if bounded repair cannot run.
            ctx.warnings.append(f"Cluster repair buoi 1 tiet chua ap dung duoc: {exc}")

    current_session_solver_metrics = solver_metrics.get("session_solver") or {}
    current_solver_name = str(current_session_solver_metrics.get("solver") or "")
    current_cp_sat_status = str(current_session_solver_metrics.get("status_name") or "")
    if _should_attempt_session_priority_rescue(
        solver_mode=solver_mode,
        minimize_sessions=minimize_sessions,
        constraints_active=constraints_active,
        fixed_existing_lessons=bool(fixed_existing_lessons),
        tight_capacity_hint_mode=tight_capacity_hint_mode,
        skip_session_priority_rescue=skip_session_priority_rescue,
        minimize_one_period_sessions=minimize_one_period_sessions,
        current_metrics=current_metrics,
        deadline_has_budget=not deadline.exhausted(12),
        current_solver_name=current_solver_name,
        current_cp_sat_status=current_cp_sat_status,
    ):
        try:
            current_sessions = int(current_metrics.get("teacher_sessions") or 10**9)
            current_one_period_sessions = int(current_metrics.get("one_period_teacher_sessions") or 0)
            rescue_target_sessions = _to_int(settings.get("session_priority_target_teacher_sessions"), 150)
            if current_sessions <= rescue_target_sessions and current_one_period_sessions == 0:
                raise RuntimeError("current_session_count_already_within_fast_target")
            rescue_time_limit = max(session_time_limit, 25 if aggressive_fast_mode else session_time_limit)
            if skip_session_priority_rescue and current_one_period_sessions > 0:
                rescue_time_limit = max(3, min(rescue_time_limit, _to_int(settings.get("one_period_cleanup_time_limit"), 6)))
            primary_seed = random_seed if random_seed is not None else 1
            candidate_attempts: list[tuple[int | None, int]] = [(primary_seed, rescue_time_limit)]
            if _truthy_setting(settings.get("deep_session_rescue")):
                candidate_attempts.extend([(17, rescue_time_limit), (None, rescue_time_limit)])
            best_candidate: tuple[
                list[Lesson],
                list[SessionAllocation],
                dict[str, Any],
                dict[str, Any],
                dict[str, Any],
            ] | None = None
            best_sessions = current_sessions
            best_metrics = current_metrics
            candidate_errors: list[str] = []
            seen_candidate_attempts: set[tuple[int | None, int]] = set()
            cleanup_candidates_evaluated = 0
            cleanup_best_seen_metrics: dict[str, Any] | None = None
            for candidate_seed, candidate_time_limit in candidate_attempts:
                attempt_key = (candidate_seed, candidate_time_limit)
                if attempt_key in seen_candidate_attempts:
                    continue
                seen_candidate_attempts.add(attempt_key)
                try:
                    candidate_allocations, candidate_session_metrics = solve_session_allocation_cp_sat(
                        ctx.school_data,
                        rules=effective_rules,
                        max_teacher_sessions=max_teacher_sessions,
                        max_one_period_sessions=max_one_period_sessions,
                        minimize_sessions=True,
                        minimize_one_period_sessions=minimize_one_period_sessions,
                        one_period_priority_absolute=one_period_priority_absolute,
                        time_limit_seconds=deadline.phase_limit(candidate_time_limit, reserve_seconds=period_phase_reserve_seconds),
                        linearization_level=session_linearization_level,
                        num_workers=solver_workers,
                        random_seed=candidate_seed,
                        fixed_lessons=session_fixed_lessons,
                        period_feasibility_session_indexes=period_feasibility_all_sessions or None,
                        legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                        progress=progress,
                    )
                    try:
                        candidate_lessons, candidate_period_metrics = allocate_periods(
                            ctx.school_data,
                            candidate_allocations,
                            rules=effective_rules,
                            fixed_lessons=session_fixed_lessons,
                            time_limit_seconds_per_session=period_time_limit,
                            retry_time_limit_seconds_per_session=period_retry_time_limit,
                            remaining_time_seconds=deadline.remaining,
                            max_teacher_gap=period_max_teacher_gap,
                            minimize_teacher_gaps=period_minimize_teacher_gaps,
                            best_effort=best_effort_on_timeout,
                            verbose=False,
                            progress=progress,
                            max_workers=solver_workers,
                        )
                    except Exception as tight_period_exc:
                        if not (allow_one_period_gaps and period_minimize_teacher_gaps):
                            raise
                        candidate_lessons, candidate_period_metrics = allocate_periods(
                            ctx.school_data,
                            candidate_allocations,
                            rules=effective_rules,
                            fixed_lessons=session_fixed_lessons,
                            time_limit_seconds_per_session=period_time_limit,
                            retry_time_limit_seconds_per_session=period_retry_time_limit,
                            remaining_time_seconds=deadline.remaining,
                            max_teacher_gap=period_max_teacher_gap,
                            minimize_teacher_gaps=False,
                            best_effort=best_effort_on_timeout,
                            verbose=False,
                            progress=progress,
                            max_workers=solver_workers,
                        )
                        candidate_period_metrics = dict(candidate_period_metrics)
                        candidate_period_metrics["tight_gap_retry_error"] = str(tight_period_exc)
                        candidate_period_metrics["minimize_teacher_gaps"] = False
                    candidate_metrics = compute_solution_metrics(candidate_lessons)
                    cleanup_candidates_evaluated += 1
                    candidate_sessions = int(candidate_metrics.get("teacher_sessions") or 10**9)
                    candidate_clean = _gap0_metrics_clean(candidate_metrics) or (
                        allow_one_period_gaps and _session_priority_metrics_acceptable(candidate_metrics)
                    )
                    if candidate_clean and (
                        cleanup_best_seen_metrics is None
                        or _session_priority_better(candidate_metrics, cleanup_best_seen_metrics)
                    ):
                        cleanup_best_seen_metrics = dict(candidate_metrics)
                    if candidate_clean and _session_priority_better(candidate_metrics, best_metrics):
                        best_candidate = (
                            candidate_lessons,
                            candidate_allocations,
                            dict(candidate_session_metrics),
                            dict(candidate_period_metrics),
                            candidate_metrics,
                        )
                        best_sessions = candidate_sessions
                        best_metrics = candidate_metrics
                        if (
                            best_sessions <= rescue_target_sessions
                            and int(candidate_metrics.get("one_period_teacher_sessions") or 0) == 0
                        ):
                            break
                except Exception as candidate_exc:  # noqa: BLE001 - try the next portfolio item before giving up.
                    candidate_errors.append(f"seed={candidate_seed},limit={candidate_time_limit}: {candidate_exc}")
            if best_candidate is not None:
                candidate_lessons, candidate_allocations, candidate_session_metrics, candidate_period_metrics, candidate_metrics = best_candidate
                previous_session_solver = solver_metrics.get("session_solver", {})
                previous_metrics = current_metrics
                lessons = candidate_lessons
                allocations = candidate_allocations
                current_metrics = candidate_metrics
                validation_max_teacher_sessions = max(validation_max_teacher_sessions, best_sessions)
                candidate_session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                candidate_session_metrics.setdefault("effective_max_teacher_sessions", max_teacher_sessions)
                candidate_session_metrics.setdefault("fresh_randomize", bool(fresh_randomize))
                candidate_session_metrics.setdefault("random_seed", primary_seed)
                candidate_session_metrics["session_priority_target_teacher_sessions"] = rescue_target_sessions
                candidate_session_metrics["one_period_cleanup_attempted"] = True
                candidate_session_metrics["one_period_cleanup_replaced"] = True
                candidate_session_metrics["one_period_cleanup_candidates_evaluated"] = cleanup_candidates_evaluated
                candidate_session_metrics["fallback_reason"] = (
                    "session_priority_candidate_replaced_higher_session_solution"
                    if best_sessions < current_sessions
                    else "one_period_candidate_replaced_same_session_solution"
                )
                candidate_session_metrics["previous_solver"] = previous_session_solver
                candidate_session_metrics["previous_teacher_sessions"] = current_sessions
                candidate_session_metrics["previous_one_period_teacher_sessions"] = int(
                    (previous_session_solver or {}).get("one_period_teacher_sessions")
                    or previous_metrics.get("one_period_teacher_sessions")
                    or 0
                )
                solver_metrics = {
                    "session_solver": candidate_session_metrics,
                    "period_solver": candidate_period_metrics,
                }
            else:
                current_session_meta = solver_metrics.get("session_solver")
                if isinstance(current_session_meta, dict):
                    current_session_meta["one_period_cleanup_attempted"] = cleanup_candidates_evaluated > 0
                    current_session_meta["one_period_cleanup_replaced"] = False
                    current_session_meta["one_period_cleanup_candidates_evaluated"] = cleanup_candidates_evaluated
                    if cleanup_best_seen_metrics is not None:
                        current_session_meta["one_period_cleanup_best_seen"] = {
                            "teacher_sessions": cleanup_best_seen_metrics.get("teacher_sessions"),
                            "one_period_teacher_sessions": cleanup_best_seen_metrics.get("one_period_teacher_sessions"),
                            "gap_distribution": cleanup_best_seen_metrics.get("gap_distribution"),
                        }
                if candidate_errors:
                    ctx.warnings.append("Session-priority CP-SAT rescue chua tim duoc nghiem tot hon: " + " | ".join(candidate_errors[:3]))
        except Exception:  # noqa: BLE001 - keep the validated solution when the faster candidate is not usable.
            pass

    if (
        solver_mode == "auto"
        and minimize_one_period_sessions
        and allow_one_period_gaps
        and not fixed_existing_lessons
        and int(current_metrics.get("one_period_teacher_sessions") or 0) > 0
        and not deadline.exhausted(2)
    ):
        cleanup_limit = min(
            max(0.5, _to_float(settings.get("local_one_period_cleanup_time_limit"), 6.0)),
            max(0.5, float((deadline.remaining() or 4.0) - 1.0)),
        )
        cleanup_target = _to_int(settings.get("local_one_period_cleanup_target"), 0)
        cleanup_until = time.monotonic() + cleanup_limit
        cleanup_passes = 0
        cleanup_total_evaluated = 0
        cleanup_all_moves: list[dict[str, Any]] = []
        cleanup_last_meta: dict[str, Any] | None = None
        previous_session_solver = dict(solver_metrics.get("session_solver", {}) or {})
        while (
            int(current_metrics.get("one_period_teacher_sessions") or 0) > max(0, cleanup_target)
            and time.monotonic() < cleanup_until
            and not deadline.exhausted(1)
        ):
            remaining_cleanup = max(0.25, cleanup_until - time.monotonic())
            cleanup = _local_one_period_cleanup(
                ctx.school_data,
                lessons,
                effective_rules,
                allow_gap1=allow_one_period_gaps,
                time_limit_seconds=remaining_cleanup,
                max_evaluated=max(100, _to_int(settings.get("local_one_period_cleanup_max_evaluated"), 5000)),
                target_one_period_sessions=cleanup_target,
            )
            if cleanup is None:
                break
            cleanup_lessons, cleanup_metrics, cleanup_meta = cleanup
            if not _session_priority_better(cleanup_metrics, current_metrics):
                break
            cleanup_passes += 1
            cleanup_total_evaluated += int(cleanup_meta.get("one_period_local_cleanup_evaluated") or 0)
            cleanup_all_moves.extend(cleanup_meta.get("one_period_local_cleanup_moves") or [])
            cleanup_last_meta = cleanup_meta
            lessons = cleanup_lessons
            allocations = _allocations_from_lessons(lessons)
            current_metrics = cleanup_metrics
            validation_max_teacher_sessions = max(
                validation_max_teacher_sessions,
                int(cleanup_metrics.get("teacher_sessions") or 0),
            )

        if cleanup_passes > 0 and cleanup_last_meta is not None:
                lessons = cleanup_lessons
                allocations = _allocations_from_lessons(lessons)
                cleanup_session_metrics = dict(previous_session_solver)
                cleanup_session_metrics["fallback_reason"] = "local_one_period_cleanup_reduced_single_period_sessions"
                cleanup_session_metrics["previous_solver"] = previous_session_solver
                cleanup_session_metrics.update(cleanup_last_meta)
                cleanup_session_metrics["one_period_local_cleanup_passes"] = cleanup_passes
                cleanup_session_metrics["one_period_local_cleanup_evaluated"] = cleanup_total_evaluated
                cleanup_session_metrics["one_period_local_cleanup_moves"] = cleanup_all_moves
                cleanup_session_metrics["one_period_local_cleanup_target"] = cleanup_target
                cleanup_session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                cleanup_session_metrics.setdefault("effective_max_teacher_sessions", validation_max_teacher_sessions)
                cleanup_period_metrics = dict(solver_metrics.get("period_solver", {}) or {})
                cleanup_period_metrics.update(
                    {
                        "one_period_local_cleanup": True,
                        "one_period_local_cleanup_kind": cleanup_last_meta.get("one_period_local_cleanup_kind"),
                        "one_period_local_cleanup_moves": cleanup_all_moves,
                        "one_period_local_cleanup_evaluated": cleanup_total_evaluated,
                        "one_period_local_cleanup_passes": cleanup_passes,
                        "one_period_local_cleanup_target": cleanup_target,
                    }
                )
                solver_metrics = {
                    "session_solver": cleanup_session_metrics,
                    "period_solver": cleanup_period_metrics,
                }
    if (
        solver_mode == "auto"
        and not fixed_existing_lessons
        and constraints_active
        and not ((solver_metrics.get("period_solver", {}) or {}).get("best_effort_failed_sessions"))
        and not _gap0_metrics_clean(current_metrics)
        and not (allow_one_period_gaps and _session_priority_metrics_acceptable(current_metrics))
    ):
        rescue_hint = _load_base_period_hint(ctx.school_data, settings)
        rescue_lessons: list[Lesson] | None = None
        rescue_meta: dict[str, Any] | None = None
        if rescue_hint is not None:
            if fresh_randomize:
                variant = _period_hint_variant(
                    ctx.school_data,
                    rescue_hint,
                    effective_rules,
                    random_seed=random_seed,
                    allow_gap1=allow_one_period_gaps,
                )
                if variant is not None:
                    rescue_lessons, rescue_meta = variant
            if rescue_lessons is None:
                rescue_metrics = compute_metrics(ctx.school_data, rescue_hint, rules=effective_rules)
                if _gap0_metrics_clean(rescue_metrics):
                    rescue_lessons = rescue_hint
        if rescue_lessons is not None:
            lessons = rescue_lessons
            allocations = _allocations_from_lessons(lessons)
            rescued_metrics = compute_metrics(ctx.school_data, lessons, rules=effective_rules)
            rescue_solver = "validated_gap0_period_hint_variant" if rescue_meta else "base_180_gap0_period_hint"
            solver_metrics = {
                "session_solver": {
                    "solver": rescue_solver,
                    "status_name": "FIXED_HINT",
                    "teacher_sessions": rescued_metrics.get("teacher_sessions"),
                    "one_period_teacher_sessions": rescued_metrics.get("one_period_teacher_sessions"),
                    "gap_distribution": rescued_metrics.get("gap_distribution"),
                    "fallback_reason": "rescued_unclean_auto_solution_with_validated_gap0_hint",
                    "previous_solver": solver_metrics.get("session_solver", {}),
                    "requested_max_teacher_sessions": requested_max_teacher_sessions,
                    "effective_max_teacher_sessions": max(
                        validation_max_teacher_sessions,
                        int(rescued_metrics.get("teacher_sessions") or 0),
                    ),
                    "fresh_randomize": bool(fresh_randomize),
                    "random_seed": random_seed,
                    "hint": {
                        "used": True,
                        "fixed": True,
                        "variant": rescue_meta,
                        "hinted_periods": len(lessons),
                        "hinted_teacher_sessions": _teacher_session_count_for_lessons(lessons),
                    },
                },
                "period_solver": {
                    "solver": rescue_solver,
                    "already_placed": True,
                    "lesson_count": len(lessons),
                },
            }
            validation_max_teacher_sessions = max(
                validation_max_teacher_sessions,
                int(rescued_metrics.get("teacher_sessions") or 0),
            )
    current_metrics = compute_solution_metrics(lessons)
    if (
        not bounded_residual_repair_used
        and
        minimize_one_period_sessions
        and int(current_metrics.get("one_period_teacher_sessions") or 0) > 0
        and int(current_metrics.get("scheduled_periods") or 0) == int(current_metrics.get("expected_periods") or -1)
    ):
        session_solver_meta = solver_metrics.get("session_solver", {}) if isinstance(solver_metrics, Mapping) else {}
        probe_time_limit = max(3, _to_int(settings.get("one_period_zero_probe_time_limit"), min(max(session_time_limit, 20), 45)))
        probe_meta: dict[str, Any] = {
            "attempted": True,
            "target_one_period_teacher_sessions": 0,
            "previous_one_period_teacher_sessions": current_metrics.get("one_period_teacher_sessions"),
            "previous_teacher_sessions": current_metrics.get("teacher_sessions"),
        }
        try:
            probe_allocations, probe_session_metrics = solve_session_allocation_cp_sat(
                ctx.school_data,
                rules=effective_rules,
                max_teacher_sessions=max(validation_max_teacher_sessions, max_teacher_sessions),
                max_one_period_sessions=0,
                minimize_sessions=True,
                minimize_one_period_sessions=True,
                one_period_priority_absolute=True,
                time_limit_seconds=deadline.phase_limit(probe_time_limit, reserve_seconds=period_phase_reserve_seconds),
                linearization_level=session_linearization_level,
                num_workers=solver_workers,
                random_seed=random_seed,
                hint_allocations=_allocations_from_lessons(lessons),
                fixed_lessons=session_fixed_lessons,
                repair_hint=True,
                period_feasibility_session_indexes=period_feasibility_all_sessions or None,
                legacy_wednesday_pm_bridge=legacy_wednesday_pm_bridge,
                progress=progress,
            )
            probe_lessons, probe_period_metrics = allocate_periods(
                ctx.school_data,
                probe_allocations,
                rules=effective_rules,
                fixed_lessons=session_fixed_lessons,
                time_limit_seconds_per_session=period_time_limit,
                retry_time_limit_seconds_per_session=period_retry_time_limit,
                remaining_time_seconds=deadline.remaining,
                max_teacher_gap=period_max_teacher_gap,
                minimize_teacher_gaps=period_minimize_teacher_gaps,
                best_effort=best_effort_on_timeout,
                verbose=False,
                progress=progress,
                max_workers=solver_workers,
            )
            probe_metrics = compute_solution_metrics(probe_lessons)
            if (
                _gap0_metrics_clean(probe_metrics)
                or (allow_one_period_gaps and _session_priority_metrics_acceptable(probe_metrics))
                or _probe_reduces_one_period(probe_metrics, current_metrics, allow_gap1=allow_one_period_gaps)
            ):
                previous_session_solver = dict(session_solver_meta) if isinstance(session_solver_meta, Mapping) else {}
                lessons = probe_lessons
                allocations = probe_allocations
                current_metrics = probe_metrics
                validation_max_teacher_sessions = max(
                    validation_max_teacher_sessions,
                    int(probe_metrics.get("teacher_sessions") or 0),
                )
                probe_session_metrics = dict(probe_session_metrics)
                probe_session_metrics.setdefault("requested_max_teacher_sessions", requested_max_teacher_sessions)
                probe_session_metrics["effective_max_teacher_sessions"] = validation_max_teacher_sessions
                probe_session_metrics["fallback_reason"] = "one_period_zero_probe_replaced_solution"
                probe_session_metrics["previous_solver"] = previous_session_solver
                probe_session_metrics["one_period_zero_probe_replaced"] = True
                probe_session_metrics["one_period_zero_probe"] = {
                    **probe_meta,
                    "status_name": probe_session_metrics.get("status_name"),
                    "teacher_sessions": probe_metrics.get("teacher_sessions"),
                    "one_period_teacher_sessions": probe_metrics.get("one_period_teacher_sessions"),
                    "gap_distribution": probe_metrics.get("gap_distribution"),
                }
                solver_metrics = {
                    "session_solver": probe_session_metrics,
                    "period_solver": {
                        **dict(probe_period_metrics),
                        "solver": str(probe_period_metrics.get("solver") or "period_milp_after_one_period_zero_probe"),
                        "one_period_zero_probe": True,
                    },
                }
                session_metrics = probe_session_metrics
                period_metrics = dict(solver_metrics["period_solver"])
            else:
                if isinstance(session_solver_meta, dict):
                    session_solver_meta["one_period_zero_probe"] = {
                        **probe_meta,
                        "status_name": probe_session_metrics.get("status_name"),
                        "teacher_sessions": probe_metrics.get("teacher_sessions"),
                        "one_period_teacher_sessions": probe_metrics.get("one_period_teacher_sessions"),
                        "gap_distribution": probe_metrics.get("gap_distribution"),
                        "usable": False,
                    }
        except SessionCpSatNoSolution as exc:
            if isinstance(session_solver_meta, dict):
                session_solver_meta["one_period_zero_probe"] = {
                    **probe_meta,
                    **exc.metrics,
                    "proved_infeasible": str(exc.metrics.get("status_name") or "") == "INFEASIBLE",
                }
            if str(exc.metrics.get("status_name") or "") == "INFEASIBLE":
                ctx.warnings.append(
                    "Khong the loai bo toan bo buoi GV 1 tiet trong mo hinh cap buoi voi rang buoc hien tai; "
                    "giu lai nhu ngoai le bat kha khang."
                )
        except Exception as exc:  # noqa: BLE001 - final validation below will reject unproven one-period leftovers.
            if isinstance(session_solver_meta, dict):
                session_solver_meta["one_period_zero_probe"] = {
                    **probe_meta,
                    "status_name": "ERROR",
                    "error": str(exc),
                    "proved_infeasible": False,
                }
    current_metrics = compute_solution_metrics(lessons)
    if (
        not bounded_residual_repair_used
        and
        minimize_one_period_sessions
        and int(current_metrics.get("one_period_teacher_sessions") or 0) > 0
        and int(current_metrics.get("scheduled_periods") or 0) == int(current_metrics.get("expected_periods") or -1)
        and not _one_period_zero_probe_proved_infeasible(solver_metrics)
        and not deadline.exhausted(4)
    ):
        session_solver_meta = solver_metrics.get("session_solver", {}) if isinstance(solver_metrics, Mapping) else {}
        gap0_probe_time_limit = max(
            5,
            _to_int(settings.get("one_period_gap0_probe_time_limit"), min(max(session_time_limit, 20), 45)),
        )
        gap0_probe_meta = {
            "attempted": True,
            "target_one_period_teacher_sessions": 0,
            "previous_one_period_teacher_sessions": current_metrics.get("one_period_teacher_sessions"),
            "previous_teacher_sessions": current_metrics.get("teacher_sessions"),
        }
        try:
            gap0_lessons, gap0_solver_metrics = solve_gap0_cp_sat(
                ctx.school_data,
                rules=effective_rules,
                max_teacher_sessions=max(validation_max_teacher_sessions, max_teacher_sessions),
                time_limit_seconds=deadline.phase_limit(gap0_probe_time_limit, reserve_seconds=2.0),
                num_workers=solver_workers,
                hint_lessons=lessons,
                fixed_lessons=[],
                prefer_hint=True,
                random_seed=random_seed,
                progress=progress,
            )
            gap0_metrics = compute_solution_metrics(gap0_lessons)
            if (
                _gap0_metrics_clean(gap0_metrics)
                or (allow_one_period_gaps and _session_priority_metrics_acceptable(gap0_metrics))
                or _probe_reduces_one_period(gap0_metrics, current_metrics, allow_gap1=allow_one_period_gaps)
            ):
                previous_session_solver = dict(session_solver_meta) if isinstance(session_solver_meta, Mapping) else {}
                lessons = gap0_lessons
                allocations = _allocations_from_lessons(lessons)
                current_metrics = gap0_metrics
                validation_max_teacher_sessions = max(
                    validation_max_teacher_sessions,
                    int(gap0_metrics.get("teacher_sessions") or 0),
                )
                gap0_session_metrics = {
                    **dict(gap0_solver_metrics),
                    "solver": "ortools_cp_sat_gap0_period",
                    "fallback_reason": "one_period_gap0_probe_replaced_solution",
                    "previous_solver": previous_session_solver,
                    "requested_max_teacher_sessions": requested_max_teacher_sessions,
                    "effective_max_teacher_sessions": validation_max_teacher_sessions,
                    "one_period_gap0_probe_replaced": True,
                    "one_period_gap0_probe": {
                        **gap0_probe_meta,
                        "status_name": gap0_solver_metrics.get("status_name"),
                        "teacher_sessions": gap0_metrics.get("teacher_sessions"),
                        "one_period_teacher_sessions": gap0_metrics.get("one_period_teacher_sessions"),
                        "gap_distribution": gap0_metrics.get("gap_distribution"),
                    },
                }
                gap0_period_metrics = {
                    **dict(gap0_solver_metrics),
                    "already_placed": True,
                    "lesson_count": len(lessons),
                    "one_period_gap0_probe": True,
                }
                solver_metrics = {
                    "session_solver": gap0_session_metrics,
                    "period_solver": gap0_period_metrics,
                }
                session_metrics = gap0_session_metrics
                period_metrics = gap0_period_metrics
            else:
                if isinstance(session_solver_meta, dict):
                    session_solver_meta["one_period_gap0_probe"] = {
                        **gap0_probe_meta,
                        "status_name": gap0_solver_metrics.get("status_name"),
                        "teacher_sessions": gap0_metrics.get("teacher_sessions"),
                        "one_period_teacher_sessions": gap0_metrics.get("one_period_teacher_sessions"),
                        "gap_distribution": gap0_metrics.get("gap_distribution"),
                        "usable": False,
                    }
        except Gap0CpSatNoSolution as exc:
            if isinstance(session_solver_meta, dict):
                session_solver_meta["one_period_gap0_probe"] = {
                    **gap0_probe_meta,
                    **exc.metrics,
                    "proved_infeasible": str(exc.metrics.get("status_name") or "") == "INFEASIBLE",
                }
            if str(exc.metrics.get("status_name") or "") == "INFEASIBLE":
                ctx.warnings.append(
                    "Khong the loai bo toan bo buoi GV 1 tiet trong mo hinh gap0 voi rang buoc hien tai; "
                    "giu lai nhu ngoai le bat kha khang."
                )
        except Exception as exc:  # noqa: BLE001 - final validation below rejects unproven one-period leftovers.
            if isinstance(session_solver_meta, dict):
                session_solver_meta["one_period_gap0_probe"] = {
                    **gap0_probe_meta,
                    "status_name": "ERROR",
                    "error": str(exc),
                    "proved_infeasible": False,
                }
    period_solver_metrics = solver_metrics.get("period_solver", {}) if isinstance(solver_metrics, Mapping) else {}
    best_effort_failures = (
        period_solver_metrics.get("best_effort_failed_sessions", [])
        if isinstance(period_solver_metrics, Mapping)
        else []
    )
    additional_unassigned: list[dict[str, Any]] = []
    best_effort_used = bool(best_effort_failures)
    optimization_skipped_reason = None
    if best_effort_on_timeout:
        session_solver_metrics = solver_metrics.get("session_solver", {}) if isinstance(solver_metrics, Mapping) else {}
        session_fallback_reason = (
            str(session_solver_metrics.get("fallback_reason") or "")
            if isinstance(session_solver_metrics, Mapping)
            else ""
        )
        session_shortfall_best_effort = session_fallback_reason.startswith("session_constraints_best_effort")
        shortfall_reason = (
            "session_constraints_best_effort"
            if session_shortfall_best_effort
            else "period_allocation_best_effort"
        )
        shortfall_message = (
            "Rang buoc cap buoi qua chat; da xep toi da phan kha thi va dua phan con lai vao tiet chua phan."
            if session_shortfall_best_effort
            else "Chua xep duoc trong ngan sach thoi gian hoac do vector buoi khong kha thi; da tra lich best-effort."
        )
        additional_unassigned = _unassigned_from_shortfall(
            ctx,
            lessons,
            reason=shortfall_reason,
            message=shortfall_message,
        )
        if additional_unassigned:
            best_effort_used = True
            optimization_skipped_reason = (
                "mot so tiet khong kha thi voi rang buoc cap buoi hien tai"
                if session_shortfall_best_effort
                else f"mot so buoi khong xep duoc o muc tiet cu the trong ngan sach {overall_time_limit_seconds} giay"
            )
        elif deadline.exhausted(3):
            optimization_skipped_reason = "bo qua toi uu phu vi gan het ngan sach thoi gian"
    if additional_unassigned:
        unassigned_lessons = [*unassigned_lessons, *additional_unassigned]

    one_period_best_effort = False
    if (
        not best_effort_used
        and best_effort_on_timeout
        and strict_one_period_sessions_cap
        and max_one_period_sessions is not None
        and int(current_metrics.get("one_period_teacher_sessions") or 0) > max_one_period_sessions
    ):
        one_period_best_effort = True
        best_effort_used = True
        leftover_one_period = int(current_metrics.get("one_period_teacher_sessions") or 0)
        optimization_skipped_reason = (
            optimization_skipped_reason
            or f"con {leftover_one_period} buoi giao vien chi co 1 tiet sau cac buoc toi uu"
        )
        ctx.warnings.append(
            f"Con {leftover_one_period} buoi giao vien chi co 1 tiet; "
            "da tra lich hop le tot nhat thay vi huy ket qua sap xep."
        )
        session_solver_meta = solver_metrics.get("session_solver") if isinstance(solver_metrics, Mapping) else None
        if isinstance(session_solver_meta, dict):
            session_solver_meta["one_period_best_effort"] = {
                "enabled": True,
                "target_one_period_teacher_sessions": max_one_period_sessions,
                "one_period_teacher_sessions": leftover_one_period,
                "reason": optimization_skipped_reason,
            }

    if fixed_existing_lessons_are_hard:
        # The residual timetable is validated against synthetic blockers made
        # from hard lessons, but teacher-session quality can only be judged
        # after those real lessons are merged back in.  Weekly rules such as
        # lessonBlocks.min intentionally span fixed and residual periods; an
        # isolated residual half cannot satisfy that rule by itself.  Keep the
        # diagnostic metrics, then make the authoritative acceptance decision
        # on the merged full timetable below.
        residual_validation = compute_metrics(
            ctx.school_data,
            lessons,
            rules=residual_validation_rules,
        )
        residual_validation["fixed_lessons_merged_for_acceptance"] = len(hard_fixed_lessons)
        solver_metrics["residual_validation"] = residual_validation
        lessons = _merge_fixed_lessons_into_solution(lessons, hard_fixed_lessons)
        if best_effort_used and not one_period_best_effort:
            validation_metrics = compute_metrics(original_ctx.school_data, lessons, rules=report_rules)
        else:
            validation_metrics = assert_acceptance(
                original_ctx.school_data,
                lessons,
                rules=report_rules,
                max_teacher_sessions=validation_max_teacher_sessions,
                max_one_period_teacher_sessions=(
                    max_one_period_sessions
                    if strict_one_period_sessions_cap and not one_period_best_effort
                    else None
                ),
            )
    elif best_effort_used and not one_period_best_effort:
        validation_metrics = compute_metrics(ctx.school_data, lessons, rules=residual_validation_rules)
    else:
        # Hard constraints, the teacher-session cap, and the configured cap for
        # one-period teacher sessions must still hold before returning a timetable.
        validation_metrics = assert_acceptance(
            ctx.school_data,
            lessons,
            rules=residual_validation_rules,
            max_teacher_sessions=validation_max_teacher_sessions,
            max_one_period_teacher_sessions=(
                max_one_period_sessions
                if strict_one_period_sessions_cap and not one_period_best_effort
                else None
            ),
        )
    leftover_one_period = int(validation_metrics.get("one_period_teacher_sessions") or 0)
    if (
        not bounded_residual_repair_used
        and minimize_one_period_sessions
        and leftover_one_period > 0
        and max_one_period_sessions is None
    ):
        ctx.warnings.append(
            f"Con {leftover_one_period} buoi giao vien chi co 1 tiet khong the loai bo "
            "voi rang buoc hien tai; giu lai nhu ngoai le bat kha khang."
        )
    solver_metrics["validation"] = validation_metrics
    solver_metrics["runtime_settings"] = {
        "solver_workers": solver_workers,
        "minimize_one_period_sessions": minimize_one_period_sessions,
        "one_period_priority_absolute": one_period_priority_absolute,
        "max_one_period_sessions": max_one_period_sessions,
        "strict_one_period_sessions_cap": strict_one_period_sessions_cap,
        "period_max_teacher_gap": period_max_teacher_gap,
        "period_minimize_teacher_gaps": period_minimize_teacher_gaps,
        "session_time_limit": session_time_limit,
        "period_time_limit": period_time_limit,
        "requested_period_time_limit": requested_period_time_limit,
        "overall_time_limit_seconds": overall_time_limit_seconds,
        "elapsed_seconds": round(deadline.elapsed(), 3),
        "auto_sort_mode": auto_sort_mode,
        "strict_teacher_session_cap": strict_teacher_session_cap,
        "best_effort_on_timeout": best_effort_on_timeout,
        "require_complete_schedule": require_complete_schedule,
        "capacity_limited_fast_lane": capacity_limited_fast_lane,
        "capacity_excluded_periods": capacity_excluded_periods,
        "preserve_existing_min_ratio": preserve_existing_min_ratio,
        "preserve_fixed_lessons_only": preserve_fixed_lessons_only,
        "fixed_existing_lessons": len(hard_fixed_lessons),
        "soft_existing_hint_lessons": len(soft_existing_incumbent_lessons),
        "must_teach_anchor_lessons": len(must_teach_anchor_lessons),
        "hard_fixed_existing_lessons": bool(fixed_existing_lessons_are_hard),
        "ignored_partial_existing_lessons": ignored_partial_existing_lessons,
        "fresh_randomize_strategy": fresh_randomize_strategy if fresh_randomize else "",
    }

    if out_dir is not None:
        path = Path(out_dir)
        path.mkdir(parents=True, exist_ok=True)
        final_allocations = _allocations_from_lessons(lessons)
        final_session_metrics = dict(solver_metrics.get("session_solver") or {})
        final_period_metrics = dict(solver_metrics.get("period_solver") or {})
        save_session_solution(path / "session_solution.json", final_allocations, final_session_metrics)
        write_session_plan_csv(path / "tkb_session_plan.csv", final_allocations)
        save_period_solution(path / "period_solution.json", lessons, final_period_metrics)
        write_timetable_csv(path / "tkb_full_timetable.csv", lessons)
        (path / "metrics.json").write_text(
            json.dumps(solver_metrics, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    payload_ctx = original_ctx if fixed_existing_lessons_are_hard else ctx
    payload_original_ctx = None if fixed_existing_lessons_are_hard else original_ctx
    return build_payload(
        payload_ctx,
        lessons,
        solver_metrics,
        report_rules,
        unassigned_lessons=unassigned_lessons,
        original_ctx=payload_original_ctx,
        best_effort=best_effort_used,
        deadline_exhausted=deadline.exhausted(),
        optimization_skipped_reason=optimization_skipped_reason,
    )
