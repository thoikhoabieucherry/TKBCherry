from __future__ import annotations

import time
import unittest
from unittest.mock import patch

from tkb_optimizer_ref.clean_quality_cycles import (
    _apply_cycle,
    _blocks,
    _candidate_cycles,
    _cycle_quality,
    _quality_is_monotone_improvement,
    optimize_clean_quality_cycles,
)
from tkb_optimizer_ref.models import Lesson


class CleanQualityCycleTests(unittest.TestCase):
    def _lessons(self) -> list[Lesson]:
        return [
            Lesson("6/1", "Khối 6", 2, "AM", 1, "Toán", "T1", ""),
            Lesson("6/1", "Khối 6", 2, "AM", 2, "Toán", "T1", ""),
            Lesson("6/1", "Khối 6", 2, "AM", 4, "Văn", "T2", ""),
            Lesson("6/1", "Khối 6", 2, "AM", 5, "Văn", "T2", ""),
        ]

    def test_quality_gate_is_componentwise_and_strict(self) -> None:
        self.assertTrue(_quality_is_monotone_improvement((9, 0, 2, 0, 2), (10, 0, 2, 0, 2)))
        self.assertTrue(_quality_is_monotone_improvement((10, 0, 1, 0, 1), (10, 0, 2, 0, 2)))
        self.assertFalse(_quality_is_monotone_improvement((9, 0, 3, 0, 3), (10, 0, 2, 0, 2)))
        self.assertFalse(_quality_is_monotone_improvement((9, 1, 1, 0, 1), (10, 0, 2, 0, 2)))

    def test_fixed_block_is_not_movable(self) -> None:
        lessons = self._lessons()
        blocks = _blocks(lessons, {("6/1", 2, "AM", 1)})
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].teacher, "T2")

    def test_cycle_quality_and_apply_preserve_class_slots(self) -> None:
        lessons = self._lessons()
        blocks = _blocks(lessons, set())
        self.assertEqual(len(blocks), 2)
        teacher_slots = {"T1": {(2, "AM", 1), (2, "AM", 2)}, "T2": {(2, "AM", 4), (2, "AM", 5)}}
        teacher_metrics = {teacher: (1, 0, 0, 0, 0) for teacher in teacher_slots}
        quality = _cycle_quality(
            (blocks[0], blocks[1]),
            teacher_slots=teacher_slots,
            teacher_metrics=teacher_metrics,
            baseline=(2, 0, 0, 0, 0),
        )
        self.assertIsNotNone(quality)
        candidate = _apply_cycle(lessons, (blocks[0], blocks[1]))
        self.assertEqual([(item.day, item.session, item.period) for item in candidate], [(item.day, item.session, item.period) for item in lessons])
        self.assertEqual([item.teacher for item in candidate], ["T2", "T2", "T1", "T1"])

    def test_candidate_enumeration_obeys_expired_deadline(self) -> None:
        self.assertEqual(
            _candidate_cycles(
                self._lessons(),
                set(),
                deadline=time.monotonic() - 1.0,
            ),
            [],
        )

    def test_result_history_is_bounded_for_large_rejected_candidate_sets(self) -> None:
        lessons = self._lessons()
        blocks = _blocks(lessons, set())
        candidates = [
            ((1, 0, 0, 0, 0), (blocks[0], blocks[1]), "test_cycle")
            for _ in range(20)
        ]
        baseline = {
            "hard_ok": True,
            "scheduled_periods": 4,
            "expected_periods": 4,
            "teacher_sessions": 2,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 2},
            "app_constraint_violation_count": 0,
        }
        rejected = dict(baseline, hard_ok=False, teacher_sessions=1)
        accepted = dict(baseline, teacher_sessions=1)

        with (
            patch(
                "tkb_optimizer_ref.clean_quality_cycles._candidate_cycles",
                side_effect=[candidates, []],
            ),
            patch(
                "tkb_optimizer_ref.clean_quality_cycles.compute_metrics",
                side_effect=[baseline, *([rejected] * 19), accepted],
            ),
        ):
            result = optimize_clean_quality_cycles(
                object(),  # type: ignore[arg-type]
                lessons,
                rules=object(),  # type: ignore[arg-type]
                max_seconds=5,
            )

        self.assertIsNotNone(result)
        self.assertEqual(result.metadata["candidate_checks"], 20)  # type: ignore[union-attr]
        self.assertEqual(len(result.metadata["history"]), 12)  # type: ignore[union-attr]
        self.assertEqual(result.metadata["stop_reason"], "no_candidates")  # type: ignore[union-attr]
        self.assertTrue(result.metadata["stopped_on_plateau"])  # type: ignore[union-attr]

    def test_round_limit_is_not_reported_as_plateau(self) -> None:
        lessons = self._lessons()
        blocks = _blocks(lessons, set())
        candidate = [((1, 0, 0, 0, 0), (blocks[0], blocks[1]), "test_cycle")]
        baseline = {
            "hard_ok": True,
            "scheduled_periods": 4,
            "expected_periods": 4,
            "teacher_sessions": 2,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 2},
            "app_constraint_violation_count": 0,
        }
        accepted = dict(baseline, teacher_sessions=1)

        with (
            patch(
                "tkb_optimizer_ref.clean_quality_cycles._candidate_cycles",
                return_value=candidate,
            ),
            patch(
                "tkb_optimizer_ref.clean_quality_cycles.compute_metrics",
                side_effect=[baseline, accepted],
            ),
        ):
            result = optimize_clean_quality_cycles(
                object(),  # type: ignore[arg-type]
                lessons,
                rules=object(),  # type: ignore[arg-type]
                max_seconds=5,
                max_rounds=1,
            )

        self.assertIsNotNone(result)
        self.assertEqual(result.metadata["stop_reason"], "max_rounds")  # type: ignore[union-attr]
        self.assertFalse(result.metadata["stopped_on_plateau"])  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()
