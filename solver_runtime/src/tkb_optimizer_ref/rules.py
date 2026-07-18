from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


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
        return subject in self.group_items("subject", group_id)

    def subject_groups_for(self, subject: str) -> tuple[str, ...]:
        return tuple(group_id for group_id, items in self.groups.get("subject", {}).items() if subject in items)

    def is_fixed_off(self, kind: str, item_id: str, day: int, session: str, period: int) -> bool:
        return (int(day), str(session), int(period)) in self.fixed_off.get(kind, {}).get(str(item_id), frozenset())

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
        root = self.subject.get(subject, {})
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
