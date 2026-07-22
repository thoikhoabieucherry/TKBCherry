from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from tkb_optimizer_ref.gap0_cp_sat import solve_gap0_cp_sat  # noqa: E402
from tkb_optimizer_ref.models import (  # noqa: E402
    Assignment,
    ClassInfo,
    Lesson,
    SchoolData,
)
from tkb_optimizer_ref.rules import (  # noqa: E402
    TimetableConstraintRules,
    TimetableRuleSet,
    one_session_per_day_mode,
)
from tkb_optimizer_ref.session_cp_sat import solve_session_allocation_cp_sat  # noqa: E402
from tkb_optimizer_ref.session_milp import solve_session_allocation  # noqa: E402
from tkb_optimizer_ref.validate import validate_app_constraints  # noqa: E402


_CP_SAT_AVAILABLE = os.name != "nt"
_CP_SAT_SKIP_REASON = "Native CP-SAT tests run on the Linux/VPS staging runtime"


def _school_data() -> SchoolData:
    return SchoolData(
        classes=[ClassInfo(name="6/1", grade="6")],
        assignments=[
            Assignment(
                class_name="6/1",
                grade="6",
                subject="Math",
                teacher="T1",
                periods_per_week=2,
                max_periods_per_session=2,
            )
        ],
        teachers=["T1"],
        subjects=["Math"],
        periods_by_grade_subject={("6", "Math"): 2},
        limits_by_grade_subject={("6", "Math"): 2},
    )


def _rules(mode: object, *, restrict_to_monday: bool = False) -> TimetableRuleSet:
    fixed_off: dict[str, dict[str, frozenset[tuple[int, str, int]]]] = {}
    if restrict_to_monday:
        all_slots = {
            (day, part, period)
            for day in range(2, 8)
            for part in ("AM", "PM")
            for period in range(1, 6)
        }
        allowed = {
            (2, part, period)
            for part in ("AM", "PM")
            for period in (1, 2)
        }
        unavailable = frozenset(all_slots - allowed)
        fixed_off = {
            "class": {"6/1": unavailable},
            "teacher": {"T1": unavailable},
        }
    teacher_rule = (
        {"T1": {"oneSessionPerDay": {"thu2": mode}}}
        if mode is not None
        else {}
    )
    return TimetableRuleSet(
        constraints=TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off=fixed_off,
            teacher=teacher_rule,
            subject={},
            subject_group={},
        )
    )


def _lesson(part: str, period: int = 1) -> Lesson:
    return Lesson("6/1", "6", 2, part, period, "Math", "T1")


class TeacherDaySessionModeTests(unittest.TestCase):
    def test_mode_parser_supports_current_legacy_and_empty_values(self) -> None:
        cases = (
            (None, ""),
            (False, ""),
            ({}, ""),
            ({"morning": False, "afternoon": False, "either": False}, ""),
            ({"morning": True}, "morning"),
            ({"afternoon": True}, "afternoon"),
            ({"either": True}, "either"),
            (True, "either"),
            ("morning", "morning"),
            ("sang", "morning"),
            ("chieu", "afternoon"),
            ("both", "either"),
            ({"mode": "afternoon"}, "afternoon"),
            ({"sang": True}, "morning"),
            ({"chieu": True}, "afternoon"),
            ({"both": True}, "either"),
        )
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(one_session_per_day_mode(raw), expected)

    def test_malformed_multiple_flags_use_deterministic_ui_order(self) -> None:
        self.assertEqual(
            one_session_per_day_mode(
                {
                    "morning": True,
                    "afternoon": True,
                    "either": True,
                    "mode": "afternoon",
                }
            ),
            "morning",
        )

    def test_validator_applies_all_teacher_day_modes(self) -> None:
        data = _school_data()
        cases = (
            (None, [_lesson("AM"), _lesson("PM")], False),
            ({"morning": True}, [_lesson("AM")], False),
            ({"morning": True}, [_lesson("PM")], True),
            ({"afternoon": True}, [_lesson("PM")], False),
            ({"afternoon": True}, [_lesson("AM")], True),
            ({"either": True}, [_lesson("AM")], False),
            ({"either": True}, [_lesson("AM"), _lesson("PM")], True),
            (True, [_lesson("AM"), _lesson("PM")], True),
        )
        for mode, lessons, should_violate in cases:
            with self.subTest(mode=mode, lessons=[item.session for item in lessons]):
                result = validate_app_constraints(data, lessons, _rules(mode))
                violations = [
                    item
                    for item in result["violations"]
                    if item["kind"] == "teacher.oneSessionPerDay"
                ]
                self.assertEqual(bool(violations), should_violate)

    def test_session_milp_obeys_morning_and_afternoon_modes(self) -> None:
        for mode, expected_part in (
            ({"morning": True}, "AM"),
            ({"afternoon": True}, "PM"),
        ):
            with self.subTest(mode=mode):
                allocations, _metrics = solve_session_allocation(
                    _school_data(),
                    rules=_rules(mode, restrict_to_monday=True),
                    max_teacher_sessions=1,
                    minimize_sessions=True,
                    time_limit_seconds=5,
                    verbose=False,
                )
                self.assertEqual(sum(item.count for item in allocations), 2)
                self.assertEqual(
                    {(item.session.day, item.session.part) for item in allocations},
                    {(2, expected_part)},
                )

    @unittest.skipUnless(_CP_SAT_AVAILABLE, _CP_SAT_SKIP_REASON)
    def test_session_cp_sat_obeys_morning_and_afternoon_modes(self) -> None:
        for mode, expected_part in (
            ({"morning": True}, "AM"),
            ({"afternoon": True}, "PM"),
        ):
            with self.subTest(mode=mode):
                allocations, _metrics = solve_session_allocation_cp_sat(
                    _school_data(),
                    rules=_rules(mode, restrict_to_monday=True),
                    max_teacher_sessions=1,
                    max_one_period_sessions=0,
                    time_limit_seconds=5,
                    num_workers=1,
                )
                self.assertEqual(sum(item.count for item in allocations), 2)
                self.assertEqual(
                    {(item.session.day, item.session.part) for item in allocations},
                    {(2, expected_part)},
                )

    @unittest.skipUnless(_CP_SAT_AVAILABLE, _CP_SAT_SKIP_REASON)
    def test_gap0_cp_sat_obeys_morning_and_afternoon_modes(self) -> None:
        for mode, expected_part in (
            ({"morning": True}, "AM"),
            ({"afternoon": True}, "PM"),
        ):
            with self.subTest(mode=mode):
                lessons, _metrics = solve_gap0_cp_sat(
                    _school_data(),
                    rules=_rules(mode, restrict_to_monday=True),
                    max_teacher_sessions=1,
                    time_limit_seconds=5,
                    num_workers=1,
                    prefer_hint=False,
                )
                self.assertEqual(len(lessons), 2)
                self.assertEqual(
                    {(item.day, item.session) for item in lessons},
                    {(2, expected_part)},
                )


if __name__ == "__main__":
    unittest.main()
