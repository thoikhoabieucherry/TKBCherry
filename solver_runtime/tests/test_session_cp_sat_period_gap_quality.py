from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Mapping
from unittest.mock import patch


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from tkb_optimizer_ref.models import (  # noqa: E402
    Assignment,
    ClassInfo,
    Lesson,
    SchoolData,
)
from tkb_optimizer_ref.rules import (  # noqa: E402
    TimetableConstraintRules,
    TimetableRuleSet,
)
from tkb_optimizer_ref.session_cp_sat import (  # noqa: E402
    SessionCpSatNoSolution,
    _teacher_gap_pattern_rows,
    solve_session_allocation_cp_sat,
)
from tkb_optimizer_ref.template import all_sessions  # noqa: E402
from tkb_optimizer_ref.validate import compute_metrics  # noqa: E402


def _gap_signature(occupancy: tuple[int, ...]) -> tuple[int, int, int, int]:
    row = next(
        candidate
        for candidate in _teacher_gap_pattern_rows(len(occupancy))
        if candidate[: len(occupancy)] == occupancy
    )
    return row[-4:]


def _two_lesson_school() -> SchoolData:
    return SchoolData(
        classes=[
            ClassInfo(name="6/1", grade="6"),
            ClassInfo(name="6/2", grade="6"),
        ],
        assignments=[
            Assignment("6/1", "6", "A", "T1", 1, 1),
            Assignment("6/2", "6", "B", "T1", 1, 1),
        ],
        teachers=["T1"],
        subjects=["A", "B"],
        periods_by_grade_subject={("6", "A"): 1, ("6", "B"): 1},
        limits_by_grade_subject={("6", "A"): 1, ("6", "B"): 1},
    )


def _rules_for_subject_periods(
    second_subject_periods: set[int],
) -> TimetableRuleSet:
    all_slots = {
        (day, part, period)
        for day in range(2, 8)
        for part in ("AM", "PM")
        for period in range(1, 6)
    }
    allowed_by_subject = {
        "A": {(2, "AM", 1)},
        "B": {(2, "AM", period) for period in second_subject_periods},
    }
    return TimetableRuleSet(
        constraints=TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={
                "subject": {
                    subject: frozenset(all_slots - allowed)
                    for subject, allowed in allowed_by_subject.items()
                }
            },
            teacher={},
            subject={},
            subject_group={},
        )
    )


def _empty_normalized_rules() -> TimetableRuleSet:
    return TimetableRuleSet(
        constraints=TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={},
            teacher={},
            subject={},
            subject_group={},
        )
    )


def _solve(second_subject_periods: set[int], **kwargs: object):
    return solve_session_allocation_cp_sat(
        _two_lesson_school(),
        rules=_rules_for_subject_periods(second_subject_periods),
        max_teacher_sessions=1,
        max_one_period_sessions=0,
        period_feasibility_session_indexes=set(range(len(all_sessions()))),
        materialize_period_lessons=True,
        time_limit_seconds=5,
        num_workers=1,
        random_seed=101,
        **kwargs,
    )


def _canonical_metrics(
    second_subject_periods: set[int],
    bridge_metrics: Mapping[str, Any],
) -> dict[str, Any]:
    rows = bridge_metrics.get("period_bridge_lessons")
    if not isinstance(rows, list):
        raise AssertionError("Expected complete period-bridge lessons")
    lessons = [
        Lesson(**dict(item))
        for item in rows
        if isinstance(item, Mapping)
    ]
    return compute_metrics(
        _two_lesson_school(),
        lessons,
        rules=_rules_for_subject_periods(second_subject_periods),
    )


class SessionCpSatPeriodGapQualityTests(unittest.TestCase):
    def test_truth_table_uses_full_internal_span_not_only_local_holes(self) -> None:
        cases = {
            (0, 0, 0, 0, 0): (0, 0, 0, 0),
            (1, 1, 0, 0, 0): (0, 0, 0, 0),
            (1, 0, 1, 1, 0): (1, 1, 0, 0),
            (1, 0, 0, 1, 0): (2, 0, 1, 2),
            (1, 0, 0, 0, 1): (3, 0, 1, 3),
            (0, 1, 0, 1, 0): (1, 1, 0, 0),
        }
        for occupancy, expected in cases.items():
            with self.subTest(occupancy=occupancy):
                self.assertEqual(_gap_signature(occupancy), expected)

    def test_gap_caps_require_a_complete_period_bridge(self) -> None:
        with self.assertRaisesRegex(ValueError, "all-session period bridge"):
            solve_session_allocation_cp_sat(
                _two_lesson_school(),
                rules=_rules_for_subject_periods({3}),
                max_teacher_sessions=1,
                period_feasibility_session_indexes={0},
                period_max_teacher_gap1_sessions=1,
                time_limit_seconds=1,
                num_workers=1,
            )

    def test_gap_model_supports_a_school_without_optional_constraints(self) -> None:
        _allocations, metrics = solve_session_allocation_cp_sat(
            _two_lesson_school(),
            rules=_empty_normalized_rules(),
            max_teacher_sessions=1,
            max_one_period_sessions=0,
            period_feasibility_session_indexes=set(range(len(all_sessions()))),
            period_minimize_teacher_gaps=True,
            period_teacher_gap_priority_absolute=True,
            materialize_period_lessons=True,
            time_limit_seconds=5,
            num_workers=1,
            random_seed=101,
        )
        self.assertTrue(metrics["period_gap_model_complete"])
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["period_bridge_teacher_gap_periods"], 0)

    def test_gap_model_supports_the_default_rule_set(self) -> None:
        _allocations, metrics = solve_session_allocation_cp_sat(
            _two_lesson_school(),
            rules=None,
            max_teacher_sessions=1,
            max_one_period_sessions=0,
            period_feasibility_session_indexes=set(range(len(all_sessions()))),
            period_minimize_teacher_gaps=True,
            period_teacher_gap_priority_absolute=True,
            materialize_period_lessons=True,
            time_limit_seconds=5,
            num_workers=1,
            random_seed=101,
        )
        self.assertTrue(metrics["period_gap_model_complete"])
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["period_bridge_teacher_gap_periods"], 0)

    def test_exact_gap1_ceiling_accepts_one_and_rejects_zero(self) -> None:
        _allocations, metrics = _solve(
            {3},
            period_max_teacher_gap1_sessions=1,
            period_max_teacher_gap2_plus_sessions=0,
        )
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["period_bridge_teacher_gap_periods"], 1)
        self.assertEqual(metrics["period_bridge_teacher_gap1_sessions"], 1)
        self.assertEqual(metrics["period_bridge_teacher_gap2_plus_sessions"], 0)
        self.assertEqual(_canonical_metrics({3}, metrics)["gap_distribution"], {1: 1})

        with self.assertRaises(SessionCpSatNoSolution):
            _solve({3}, period_max_teacher_gap1_sessions=0)

    def test_gap2_plus_and_total_gap_ceilings_are_exact(self) -> None:
        _allocations, metrics = _solve(
            {4},
            period_max_teacher_gap_periods=2,
            period_max_teacher_gap2_plus_sessions=1,
        )
        self.assertEqual(metrics["period_bridge_teacher_gap_periods"], 2)
        self.assertEqual(metrics["period_bridge_teacher_severe_gap_periods"], 2)
        self.assertEqual(metrics["period_bridge_teacher_gap1_sessions"], 0)
        self.assertEqual(metrics["period_bridge_teacher_gap2_plus_sessions"], 1)
        self.assertEqual(_canonical_metrics({4}, metrics)["gap_distribution"], {2: 1})

        with self.assertRaises(SessionCpSatNoSolution):
            _solve({4}, period_max_teacher_gap2_plus_sessions=0)
        with self.assertRaises(SessionCpSatNoSolution):
            _solve({4}, period_max_teacher_gap_periods=1)

    def test_cleanup_objective_prefers_gap1_over_gap2_without_more_sessions(self) -> None:
        _allocations, metrics = _solve(
            {3, 4},
            period_minimize_teacher_gaps=True,
            period_teacher_gap_priority_absolute=True,
            early_stop_teacher_sessions=1,
        )
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["period_bridge_teacher_gap2_plus_sessions"], 0)
        self.assertEqual(metrics["period_bridge_teacher_gap1_sessions"], 1)
        self.assertTrue(metrics["period_gap_objective_suppressed_session_early_stop"])
        self.assertFalse(metrics["early_stop_enabled"])
        self.assertIn(
            "teacher_gap2_plus_sessions_then_teacher_severe_gap_periods_then_teacher_gap1_sessions",
            metrics["objective_mode"],
        )
        selected = {
            int(item["period"])
            for item in metrics["period_bridge_lessons"]
            if item["subject"] == "B"
        }
        self.assertEqual(selected, {3})

    def test_quality_progress_emits_best_metrics_without_publishing_a_timetable(self) -> None:
        events: list[dict[str, Any]] = []

        _allocations, metrics = _solve(
            {3, 4},
            period_minimize_teacher_gaps=True,
            period_teacher_gap_priority_absolute=True,
            progress=events.append,
        )

        improvements = [
            event
            for event in events
            if event.get("stage") == "session_cp_sat:metric"
        ]
        self.assertTrue(metrics["progress_callback_enabled"])
        self.assertEqual(
            metrics["progress_improvements_emitted"],
            len(improvements),
        )
        self.assertGreaterEqual(len(improvements), 1)
        self.assertEqual(
            improvements[-1]["teacher_sessions"],
            metrics["teacher_sessions"],
        )
        self.assertEqual(
            improvements[-1]["one_period_teacher_sessions"],
            metrics["one_period_teacher_sessions"],
        )
        self.assertEqual(
            improvements[-1]["gap_distribution"],
            {
                1: metrics["period_bridge_teacher_gap1_sessions"],
                2: metrics["period_bridge_teacher_gap2_plus_sessions"],
            },
        )
        objectives = [
            float(event["objective"])
            for event in improvements
            if event.get("objective") is not None
        ]
        self.assertTrue(
            all(current < previous for previous, current in zip(objectives, objectives[1:]))
        )
        for event in improvements:
            self.assertNotIn("period_bridge_lessons", event)
            self.assertNotIn("lessons", event)
            self.assertNotIn("tkb", event)

    def test_feasibility_only_solve_does_not_install_a_progress_callback(self) -> None:
        events: list[dict[str, Any]] = []

        _allocations, metrics = _solve(
            {3},
            minimize_sessions=False,
            minimize_one_period_sessions=False,
            progress=events.append,
        )

        self.assertFalse(metrics["progress_callback_enabled"])
        self.assertEqual(metrics["progress_improvements_emitted"], 0)
        self.assertFalse(
            any(event.get("stage") == "session_cp_sat:metric" for event in events)
        )

    def test_quality_progress_and_early_stop_share_the_same_callback(self) -> None:
        events: list[dict[str, Any]] = []

        _allocations, metrics = _solve(
            {3},
            early_stop_teacher_sessions=1,
            early_stop_max_one_period_sessions=0,
            progress=events.append,
        )

        self.assertTrue(metrics["progress_callback_enabled"])
        self.assertTrue(metrics["early_stop_enabled"])
        self.assertTrue(metrics["early_stop_hit"])
        self.assertGreaterEqual(metrics["progress_improvements_emitted"], 1)
        self.assertTrue(
            any(event.get("stage") == "session_cp_sat:metric" for event in events)
        )

    def test_stop_file_returns_a_valid_materialized_incumbent(self) -> None:
        events: list[dict[str, Any]] = []

        with tempfile.TemporaryDirectory() as tmp_dir:
            stop_path = Path(tmp_dir) / "retain-best.stop"

            def request_stop_after_first_incumbent(event: dict[str, Any]) -> None:
                events.append(event)
                if (
                    event.get("stage") == "session_cp_sat:metric"
                    and not stop_path.exists()
                ):
                    stop_path.write_text("stop\n", encoding="utf-8")
                    # Keep the incumbent callback alive long enough for the
                    # independent stop watcher to observe the control file.
                    time.sleep(0.2)

            with patch.dict(
                os.environ,
                {"TKB_SOLVER_STOP_FILE": str(stop_path)},
            ):
                allocations, metrics = _solve(
                    {3, 4},
                    period_minimize_teacher_gaps=True,
                    period_teacher_gap_priority_absolute=True,
                    progress=request_stop_after_first_incumbent,
                )

        canonical = _canonical_metrics({3, 4}, metrics)
        self.assertTrue(metrics["best_effort_stop_requested"])
        self.assertTrue(metrics["best_effort_stop_applied"])
        self.assertIsNone(metrics["best_effort_stop_error"])
        self.assertIn(metrics["status_name"], {"FEASIBLE", "OPTIMAL"})
        self.assertEqual(sum(int(item.count) for item in allocations), 2)
        self.assertTrue(metrics["period_bridge_materialization_complete"])
        self.assertEqual(canonical["scheduled_periods"], canonical["expected_periods"])
        self.assertTrue(canonical["hard_ok"])
        self.assertEqual(canonical["app_constraint_violation_count"], 0)
        self.assertTrue(
            any(event.get("stage") == "session_cp_sat:metric" for event in events)
        )


if __name__ == "__main__":
    unittest.main()
