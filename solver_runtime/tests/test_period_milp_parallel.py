from __future__ import annotations

import ast
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from tkb_optimizer_ref.models import (  # noqa: E402
    ClassInfo,
    Lesson,
    SchoolData,
    Session,
    SessionAllocation,
)
from tkb_optimizer_ref.period_milp import (  # noqa: E402
    PeriodAllocationError,
    _allocate_periods_sequential,
    allocate_periods,
)


def _school() -> SchoolData:
    return SchoolData(
        classes=[ClassInfo("6/1", "Khoi 6")],
        assignments=[],
        teachers=["GV"],
        subjects=["Mon"],
        periods_by_grade_subject={},
        limits_by_grade_subject={},
    )


def _allocations(days: list[int]) -> list[SessionAllocation]:
    return [
        SessionAllocation(
            class_name="6/1",
            grade="Khoi 6",
            subject=f"Mon {day}",
            teacher="GV",
            session=Session(day, "AM"),
            count=1,
        )
        for day in days
    ]


def _lesson(session: Session) -> Lesson:
    return Lesson(
        class_name="6/1",
        grade="Khoi 6",
        day=session.day,
        session=session.part,
        period=1,
        subject=f"Mon {session.day}",
        teacher="GV",
    )


def _metrics(session: Session, *, gap_delta: int = 0) -> dict:
    key = f"{session.day}-{session.part}"
    return {
        "session_gap_objectives": {key: float(session.day)},
        "session_event_counts": {key: {"events": 1, "contiguous_blocks": 0, "periods": 1}},
        "session_retries": {},
        "max_teacher_gap": 1,
        "minimize_teacher_gaps": True,
        "fixed_lessons": 0,
        "teacher_gap_period_totals": {"GV": gap_delta} if gap_delta else {},
        "teacher_gap1_session_totals": {"GV": 1} if gap_delta == 1 else {},
    }


class ParallelPeriodMilpTests(unittest.TestCase):
    def test_max_workers_one_is_the_legacy_sequential_path(self) -> None:
        data = _school()
        allocations = _allocations([2, 3])

        actual = allocate_periods(
            data,
            allocations,
            time_limit_seconds_per_session=2,
            retry_time_limit_seconds_per_session=2,
            minimize_teacher_gaps=False,
            verbose=False,
            max_workers=1,
        )
        expected = _allocate_periods_sequential(
            data,
            allocations,
            time_limit_seconds_per_session=2,
            retry_time_limit_seconds_per_session=2,
            minimize_teacher_gaps=False,
            verbose=False,
        )

        self.assertEqual(actual, expected)
        self.assertNotIn("parallel_period_sessions", actual[1])

    def test_reversed_completion_order_merges_in_canonical_session_order(self) -> None:
        data = _school()
        allocations = _allocations([2, 3, 4])

        def fake_sequential(_data, _allocations, **kwargs):
            session = kwargs["_sessions"][0]
            time.sleep({2: 0.06, 3: 0.03, 4: 0.0}[session.day])
            return [_lesson(session)], _metrics(session)

        with patch("tkb_optimizer_ref.period_milp._allocate_periods_sequential", side_effect=fake_sequential):
            lessons, metrics = allocate_periods(data, allocations, verbose=False, max_workers=3)

        self.assertEqual([item.day for item in lessons], [2, 3, 4])
        self.assertEqual(list(metrics["session_gap_objectives"]), ["2-AM", "3-AM", "4-AM"])
        self.assertEqual(metrics["parallel_period_workers"], 3)

    def test_real_parallel_highs_sessions_complete(self) -> None:
        data = _school()
        allocations = _allocations([2, 3, 4, 5, 6, 7])

        lessons, metrics = allocate_periods(
            data,
            allocations,
            time_limit_seconds_per_session=2,
            retry_time_limit_seconds_per_session=2,
            minimize_teacher_gaps=False,
            verbose=False,
            max_workers=6,
        )

        self.assertEqual([item.day for item in lessons], [2, 3, 4, 5, 6, 7])
        self.assertEqual(metrics["parallel_period_workers"], 6)
        self.assertEqual(metrics["parallel_period_waves"], 1)

    def test_strict_failure_has_only_canonical_prior_partial_lessons(self) -> None:
        data = _school()
        allocations = _allocations([2, 3, 4])

        def fake_sequential(_data, _allocations, **kwargs):
            session = kwargs["_sessions"][0]
            if session.day == 3:
                raise PeriodAllocationError(
                    "middle failed",
                    session=session,
                    partial_lessons=kwargs["_initial_partial_lessons"],
                    diagnostics={"reason": "test"},
                )
            time.sleep(0.01 if session.day == 2 else 0.0)
            return [_lesson(session)], _metrics(session)

        with patch("tkb_optimizer_ref.period_milp._allocate_periods_sequential", side_effect=fake_sequential):
            with self.assertRaises(PeriodAllocationError) as raised:
                allocate_periods(data, allocations, verbose=False, max_workers=3)

        self.assertEqual(raised.exception.session, Session(3, "AM"))
        self.assertEqual([item.day for item in raised.exception.partial_lessons], [2])
        self.assertEqual(raised.exception.diagnostics["reason"], "test")

    def test_best_effort_merges_successes_and_failures_deterministically(self) -> None:
        data = _school()
        allocations = _allocations([2, 3, 4])

        def fake_sequential(_data, _allocations, **kwargs):
            session = kwargs["_sessions"][0]
            metrics = _metrics(session)
            if session.day == 3:
                error = PeriodAllocationError(
                    "middle failed",
                    session=session,
                    partial_lessons=kwargs["_initial_partial_lessons"],
                    diagnostics={"reason": "test"},
                )
                metrics["best_effort_failed_sessions"] = [error.to_dict()]
                metrics["best_effort_failed_session_count"] = 1
                return [], metrics
            return [_lesson(session)], metrics

        with patch("tkb_optimizer_ref.period_milp._allocate_periods_sequential", side_effect=fake_sequential):
            lessons, metrics = allocate_periods(
                data,
                allocations,
                verbose=False,
                best_effort=True,
                max_workers=3,
            )

        self.assertEqual([item.day for item in lessons], [2, 4])
        self.assertEqual(metrics["best_effort_failed_session_count"], 1)
        self.assertEqual(metrics["best_effort_failed_sessions"][0]["session"], {"day": 3, "part": "AM"})

    def test_deadline_exhaustion_starts_no_new_wave(self) -> None:
        data = _school()
        allocations = _allocations([2, 3, 4, 5])
        solved_days: list[int] = []
        deadline_checks = 0

        def remaining() -> float:
            nonlocal deadline_checks
            deadline_checks += 1
            return 100.0 if deadline_checks == 1 else 0.0

        def fake_sequential(_data, _allocations, **kwargs):
            session = kwargs["_sessions"][0]
            solved_days.append(session.day)
            return [_lesson(session)], _metrics(session)

        with patch("tkb_optimizer_ref.period_milp._allocate_periods_sequential", side_effect=fake_sequential):
            lessons, metrics = allocate_periods(
                data,
                allocations,
                verbose=False,
                best_effort=True,
                remaining_time_seconds=remaining,
                max_workers=2,
            )

        self.assertEqual(sorted(solved_days), [2, 3])
        self.assertEqual([item.day for item in lessons], [2, 3])
        self.assertEqual(metrics["parallel_period_waves"], 1)
        self.assertEqual(metrics["best_effort_failed_session_count"], 2)

    def test_each_wave_uses_one_fairness_snapshot(self) -> None:
        data = _school()
        allocations = _allocations([2, 3, 4, 5])
        observed: dict[int, int] = {}

        def fake_sequential(_data, _allocations, **kwargs):
            session = kwargs["_sessions"][0]
            observed[session.day] = int(kwargs["_initial_teacher_gap_period_totals"].get("GV", 0))
            time.sleep(0.01 if session.day % 2 == 0 else 0.0)
            return [_lesson(session)], _metrics(session, gap_delta=1)

        with patch("tkb_optimizer_ref.period_milp._allocate_periods_sequential", side_effect=fake_sequential):
            first_lessons, first_metrics = allocate_periods(data, allocations, verbose=False, max_workers=2)
        first_observed = dict(observed)
        observed.clear()
        with patch("tkb_optimizer_ref.period_milp._allocate_periods_sequential", side_effect=fake_sequential):
            second_lessons, second_metrics = allocate_periods(data, allocations, verbose=False, max_workers=2)

        self.assertEqual(first_observed, {2: 0, 3: 0, 4: 2, 5: 2})
        self.assertEqual(observed, first_observed)
        self.assertEqual(first_lessons, second_lessons)
        self.assertEqual(first_metrics, second_metrics)
        self.assertEqual(first_metrics["teacher_gap_period_totals"], {"GV": 4})

    def test_every_scipy_milp_call_pins_highs_to_one_thread(self) -> None:
        source_root = RUNTIME_ROOT / "src" / "tkb_optimizer_ref"
        calls = []
        for name in ("period_milp.py", "session_milp.py"):
            tree = ast.parse((source_root / name).read_text(encoding="utf-8"), filename=name)
            calls.extend(
                (name, node)
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "milp"
            )

        self.assertEqual([name for name, _node in calls], ["period_milp.py", "session_milp.py"])
        for name, call in calls:
            options = next(
                (keyword.value for keyword in call.keywords if keyword.arg == "options"),
                None,
            )
            self.assertIsInstance(options, ast.Dict, name)
            option_values = {
                key.value: value.value
                for key, value in zip(options.keys, options.values, strict=True)
                if isinstance(key, ast.Constant) and isinstance(value, ast.Constant)
            }
            self.assertEqual(option_values.get("threads"), 1, name)


if __name__ == "__main__":
    unittest.main()
