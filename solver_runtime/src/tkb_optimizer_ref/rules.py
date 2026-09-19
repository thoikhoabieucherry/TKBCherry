from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping


_TEACHER_MEMBER_SPLIT = re.compile(r"[,;+\r\n]+")


def teacher_members(value: Any) -> tuple[str, ...]:
    """Ma GV thanh vien cua mot gia tri phan cong (giu thu tu, bo trung).

    25/08: tiet DAY GHEP (1 mon, 1 lop, >= 2 giao vien) duoc giao dien luu la
    "GV1, GV2" (pccmTeacherListFromValue tach theo phay / cham phay / dau
    cong / xuong dong). Backend phai coi do la HAI giao vien: tiet nam tren
    TKB cua ca hai, ca hai deu ban tai gio do va o nghi co dinh cua tung
    nguoi deu phai duoc ton trong. Gia tri mot GV -> tuple 1 phan tu.
    """

    text = "" if value is None else str(value)
    out: list[str] = []
    seen: set[str] = set()
    for part in _TEACHER_MEMBER_SPLIT.split(text):
        item = " ".join(part.split())
        if not item:
            continue
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return tuple(out)


def _rule_alias_key(value: Any) -> str:
    return " ".join(("" if value is None else str(value)).split()).casefold()


_ONE_SESSION_PER_DAY_ALIASES = {
    "morning": "morning",
    "sang": "morning",
    "afternoon": "afternoon",
    "chieu": "afternoon",
    "either": "either",
    "both": "either",
    "ca2": "either",
}


def _constraint_flag_enabled(value: Any) -> bool:
    if value is True or value == 1:
        return True
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "on", "yes"}
    return False


def one_session_per_day_mode(value: Any) -> str:
    """Return the normalized teacher/day session mode.

    The current UI stores one mutually exclusive flag in an object. Legacy
    boolean ``true`` retains its original meaning: teach in at most one of the
    two sessions. Direct mode strings are accepted for wire compatibility.
    Malformed objects with multiple selected flags are normalized by the UI
    order so every solver applies the same deterministic interpretation.
    """

    if isinstance(value, Mapping):
        # 13/09 "Gioi han buoi day": giao dien moi co 2 o Sang / Chieu moi ngay.
        # Co khoa morning/afternoon (giao dien ghi ca hai) thi theo hai o: tick
        # CA HAI = sang HOAC chieu (either), tick mot = chi buoi do, bo ca hai =
        # tu do (ke ca con co "either" cu). Cung nghia voi teacherOneSessionDayMode
        # (web/pages/tkb-constraints.js).
        if any(key in value for key in ("morning", "sang", "afternoon", "chieu")):
            morning = any(_constraint_flag_enabled(value.get(key)) for key in ("morning", "sang"))
            afternoon = any(_constraint_flag_enabled(value.get(key)) for key in ("afternoon", "chieu"))
            if morning and afternoon:
                return "either"
            if morning:
                return "morning"
            if afternoon:
                return "afternoon"
            return ""
        if any(_constraint_flag_enabled(value.get(key)) for key in ("either", "both")):
            return "either"
        explicit_mode = str(value.get("mode") or "").strip().casefold()
        return _ONE_SESSION_PER_DAY_ALIASES.get(explicit_mode, "")

    direct_mode = str(value or "").strip().casefold()
    if direct_mode in _ONE_SESSION_PER_DAY_ALIASES:
        return _ONE_SESSION_PER_DAY_ALIASES[direct_mode]
    return "either" if _constraint_flag_enabled(value) else ""


@dataclass(frozen=True, slots=True)
class TimetableConstraintRules:
    """Normalized app-level constraints carried from the original UI.

    Slot tuples use the solver coordinate system: (weekday number, "AM"/"PM",
    one-based period index). Nested rule objects intentionally keep the UI rule
    shape so the adapter can migrate UI data without losing unsupported fields.
    """

    groups: Mapping[str, Mapping[str, frozenset[str]]]
    group_names: Mapping[str, Mapping[str, str]]
    fixed_off: Mapping[str, Mapping[str, frozenset[tuple[int, str, int]]]]
    teacher: Mapping[str, Mapping[str, Any]]
    subject: Mapping[str, Mapping[str, Any]]
    subject_group: Mapping[str, Mapping[str, Any]]
    time_limit: tuple[Mapping[str, Any], ...] = ()
    subject_no_same_session: Mapping[str, Mapping[str, frozenset[str]]] = field(default_factory=dict)
    subject_no_same_day: Mapping[str, Mapping[str, frozenset[str]]] = field(default_factory=dict)
    class_extra_slots: Mapping[str, frozenset[tuple[int, str, int]]] = field(default_factory=dict)
    teacher_must_teach: Mapping[str, frozenset[tuple[int, str, int]]] = field(default_factory=dict)
    # 31/08: khoa dong DAY GHEP (DATA.dayGhep[].ten, da casefold) -> mon goc (row.mon[0], canonical).
    # Chi dung de TRA LUAT mon: Assignment/Lesson.subject van la khoa ghep (ban sac, GV, so tiet,
    # chuoi o TKB). Chu du an: "yeu cau mon hoc chi can cho mon goc, khong tao ra list mon moi".
    rule_subject_alias: Mapping[str, str] = field(default_factory=dict)

    def rule_subject(self, subject: Any) -> str:
        text = "" if subject is None else str(subject)
        if not self.rule_subject_alias:
            return text
        return self.rule_subject_alias.get(_rule_alias_key(text), text)

    @property
    def active(self) -> bool:
        return any(
            [
                any(self.fixed_off.get(kind, {}) for kind in ("class", "teacher", "subject", "room", "subjectGroup")),
                bool(self.teacher),
                bool(self.teacher_must_teach),
                bool(self.subject),
                bool(self.subject_group),
                bool(self.subject_no_same_session),
                bool(self.subject_no_same_day),
                bool(self.time_limit),
                bool(self.class_extra_slots),
            ]
        )

    def group_items(self, kind: str, group_id: str) -> frozenset[str]:
        return self.groups.get(kind, {}).get(group_id, frozenset())

    def group_name(self, kind: str, group_id: str) -> str:
        return self.group_names.get(kind, {}).get(group_id, group_id)

    def subject_in_group(self, subject: str, group_id: str) -> bool:
        items = self.group_items("subject", group_id)
        return subject in items or self.rule_subject(subject) in items

    def subject_groups_for(self, subject: str) -> tuple[str, ...]:
        base = self.rule_subject(subject)
        return tuple(
            group_id
            for group_id, items in self.groups.get("subject", {}).items()
            if subject in items or base in items
        )

    def is_fixed_off(self, kind: str, item_id: str, day: int, session: str, period: int) -> bool:
        slot = (int(day), str(session), int(period))
        kind_map = self.fixed_off.get(kind, {})
        if slot in kind_map.get(str(item_id), frozenset()):
            return True
        if kind == "subject":
            base = self.rule_subject(item_id)
            if base != str(item_id) and slot in kind_map.get(base, frozenset()):
                return True
        if kind == "teacher":
            # 25/08: tiet day ghep "GV1, GV2" nghi khi BAT KY giao vien nao nghi.
            members = teacher_members(item_id)
            if len(members) > 1:
                return any(slot in kind_map.get(member, frozenset()) for member in members)
        return False

    def is_subject_group_fixed_off(self, subject: str, day: int, session: str, period: int) -> bool:
        return any(self.is_fixed_off("subjectGroup", group_id, day, session, period) for group_id in self.subject_groups_for(subject))

    def teacher_must_teach_slots(self, teacher: str) -> frozenset[tuple[int, str, int]]:
        return self.teacher_must_teach.get(str(teacher), frozenset())

    def teacher_must_teach_periods(self, teacher: str, day: int, session: str) -> frozenset[int]:
        return frozenset(
            period
            for slot_day, slot_session, period in self.teacher_must_teach_slots(teacher)
            if int(slot_day) == int(day) and str(slot_session) == str(session)
        )

    def subject_rule_for(self, class_name: str, subject: str) -> Mapping[str, Any]:
        root = self.subject.get(subject) or self.subject.get(self.rule_subject(subject), {})
        by_class = root.get("byClass", {}) if isinstance(root, Mapping) else {}
        rule = by_class.get(class_name, {}) if isinstance(by_class, Mapping) else {}
        return rule if isinstance(rule, Mapping) else {}

    def subject_group_rules_for(self, class_name: str, subject: str) -> tuple[tuple[str, Mapping[str, Any]], ...]:
        out: list[tuple[str, Mapping[str, Any]]] = []
        for group_id in self.subject_groups_for(subject):
            root = self.subject_group.get(group_id, {})
            by_class = root.get("byClass", {}) if isinstance(root, Mapping) else {}
            rule = by_class.get(class_name, {}) if isinstance(by_class, Mapping) else {}
            if isinstance(rule, Mapping) and rule:
                out.append((group_id, rule))
        return tuple(out)


@dataclass(frozen=True, slots=True)
class TimetableRuleSet:
    """Configurable timetable rules that can later be backed by database rows."""

    contiguous_multi_period_assignments: bool = True
    constraints: TimetableConstraintRules | None = None


def default_rule_set() -> TimetableRuleSet:
    return TimetableRuleSet()


def resolve_rule_set(rules: TimetableRuleSet | None) -> TimetableRuleSet:
    return rules if rules is not None else default_rule_set()
