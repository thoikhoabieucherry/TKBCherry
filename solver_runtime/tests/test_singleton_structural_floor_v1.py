"""Regression contracts for structural singleton floors.

These tests intentionally exercise only the conservative proof and the
first-click acceptance envelope.  They do not invoke CP-SAT, touch a remote
executor, or write a timetable.  A positive singleton count is acceptable
only when it is no lower than a verified structural floor; an ordinary
candidate must still make a strict improvement over the incumbent.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_new.adapter import (  # noqa: E402
    SolverDeadline,
    _automatic_first_click_candidate_better,
    _singleton_structural_lower_bound,
    _solve_unified_first_click_feasibility_then_quality,
    _unified_first_click_candidate_acceptable,
    build_school_data_from_ui,
)


def _base_assignment(*, class_id: str, class_name: str, teacher: str, subject: str = "History") -> dict:
    return {
        "lop": [{"id": class_id, "ten": class_name, "khoi": "6"}],
        "giaovien": [{"magv": teacher, "ten": teacher}],
        "monhoc": [{"ten": subject, "ma": subject[:2].upper()}],
        "mon": [{"khoi": "6", "ten": subject, "sotiet": 3, "gioihan": 2}],
        "pccmMatrix": {f"{class_id}|{subject}": teacher},
        "pccmTietMatrix": {f"{class_id}|{subject}": 3},
        "tkbConstraints": {"fixedOff": {"class": {class_id: {}}}},
    }


def _pm_only_assignment(*, class_id: str, class_name: str, teacher: str, subject: str = "History") -> dict:
    """Make all AM slots unavailable while retaining all PM slots."""

    result = _base_assignment(
        class_id=class_id,
        class_name=class_name,
        teacher=teacher,
        subject=subject,
    )
    result["tkbConstraints"] = {
        "fixedOff": {
            "class": {
                class_id: {
                    f"thu{day}|sang|{period}": True
                    for day in range(2, 8)
                    for period in range(5)
                }
            }
        }
    }
    return result


def _merge_school_data(*rows: dict) -> dict:
    first = rows[0]
    merged: dict = {
        "lop": [],
        "giaovien": [],
        "monhoc": [],
        "mon": [],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "tkbConstraints": {"fixedOff": {"class": {}}},
    }
    for row in rows:
        merged["lop"].extend(row["lop"])
        merged["giaovien"].extend(row["giaovien"])
        merged["monhoc"].extend(row["monhoc"])
        merged["mon"].extend(row["mon"])
        merged["pccmMatrix"].update(row["pccmMatrix"])
        merged["pccmTietMatrix"].update(row["pccmTietMatrix"])
        merged["tkbConstraints"]["fixedOff"]["class"].update(
            row.get("tkbConstraints", {}).get("fixedOff", {}).get("class", {})
        )
    # Preserve any optional fields a caller adds to the first fixture.
    for key, value in first.items():
        merged.setdefault(key, value)
    return merged


def _payload(*, singleton: int, sessions: int = 2, gap1: int = 0, gap2: int = 0) -> dict:
    return {
        "ok": True,
        "metrics": {
            "hard_ok": True,
            "scheduled_periods": 4,
            "expected_periods": 4,
            "unassigned_periods": 0,
            "app_constraint_violation_count": 0,
            "teacher_sessions": sessions,
            "one_period_teacher_sessions": singleton,
            "gap_distribution": {0: max(0, sessions - gap1 - gap2), 1: gap1, 2: gap2},
        },
        "validation": {"hard_ok": True},
        "lessons": [],
    }


class SingletonStructuralFloorV1Tests(unittest.TestCase):
    def test_pm_only_three_periods_with_max_two_proves_floor_one(self) -> None:
        lower_bound, evidence = _singleton_structural_lower_bound(
            _pm_only_assignment(class_id="L1", class_name="6/1", teacher="T1"),
            None,
        )

        self.assertEqual(lower_bound, 1)
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["teacher"], "T1")
        self.assertEqual(evidence[0]["part"], "PM")
        self.assertEqual(evidence[0]["forced_singletons"], 1)

    def test_compatible_assignment_removes_singleton_proof(self) -> None:
        first = _pm_only_assignment(class_id="L1", class_name="6/1", teacher="T1")
        second = _pm_only_assignment(
            class_id="L2",
            class_name="6/2",
            teacher="T1",
            subject="Geography",
        )

        lower_bound, evidence = _singleton_structural_lower_bound(
            _merge_school_data(first, second),
            None,
        )

        self.assertEqual(lower_bound, 0)
        self.assertEqual(evidence, [])

    def test_two_independent_teacher_shift_components_add_to_floor_two(self) -> None:
        first = _pm_only_assignment(class_id="L1", class_name="6/1", teacher="T1")
        second = _pm_only_assignment(class_id="L2", class_name="6/2", teacher="T2")

        lower_bound, evidence = _singleton_structural_lower_bound(
            _merge_school_data(first, second),
            None,
        )

        self.assertEqual(lower_bound, 2)
        self.assertEqual(len(evidence), 2)

    def test_first_click_candidate_two_to_one_is_accepted_at_floor_one(self) -> None:
        incumbent = _payload(singleton=2)
        candidate = _payload(singleton=1)

        self.assertTrue(
            _unified_first_click_candidate_acceptable(
                candidate,
                [],
                one_period_lower_bound=1,
            )
        )
        self.assertTrue(
            _automatic_first_click_candidate_better(
                candidate,
                incumbent,
                [],
                one_period_lower_bound=1,
            )
        )

    def test_candidate_unchanged_at_floor_is_not_an_improvement(self) -> None:
        incumbent = _payload(singleton=1)
        candidate = _payload(singleton=1)

        # It is a valid floor-reaching result, but an unchanged result must
        # not create a new first-click publication/history entry.
        self.assertTrue(
            _unified_first_click_candidate_acceptable(
                candidate,
                [],
                one_period_lower_bound=1,
            )
        )
        self.assertFalse(
            _automatic_first_click_candidate_better(
                candidate,
                incumbent,
                [],
                one_period_lower_bound=1,
            )
        )

    def test_fresh_phase_q_uses_floor_one_and_retains_raw_incumbent_on_failure(
        self,
    ) -> None:
        data = _pm_only_assignment(
            class_id="L1",
            class_name="6/1",
            teacher="T1",
        )
        ctx = build_school_data_from_ui(data)
        raw_incumbent = _payload(singleton=330, sessions=700, gap1=200, gap2=10)
        raw_incumbent["metrics"].update(
            {
                "scheduled_periods": 2103,
                "expected_periods": 2103,
                "teacher_gap2_sessions": 10,
                "gap_distribution": {0: 490, 1: 200, 2: 10},
            }
        )
        calls: list[dict] = []

        def fake_benders(_data: dict, call_settings: dict, **kwargs: object) -> dict:
            calls.append({"settings": dict(call_settings), **kwargs})
            if len(calls) == 1:
                return raw_incumbent
            raise RuntimeError("phase q failed after receiving its quality target")

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    {
                        "target_teacher_sessions": 466,
                        "optimization_accept_teacher_sessions": 466,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "optimization_first_click_target_probe_enabled": False,
                        "overall_time_limit_seconds": 180,
                        "ui_bounded_fresh_accept_quality_debt": True,
                        "ui_stop_after_first_complete_schedule": True,
                        "optimization_first_click_skip_global_quality": True,
                        "ui_unified_first_click_quality": True,
                        "ui_unified_solve_kind": "fresh_complete_first",
                        "cloud_run_quality_lexicographic_v1": False,
                        "num_workers": 1,
                    },
                    bound_ctx=ctx,
                    bounds={
                        "lower_cap": 346,
                        "start_cap": 461,
                        "upper_cap": 1116,
                        "expected_periods": 2103,
                    },
                    profile={"expected": 2103, "class_count": 1},
                    rules=ctx.rules,
                    progress=None,
                    deadline=SolverDeadline(180),
                    polish_seeds=[1],
                    requested_random_seed=101,
                )
            )

        self.assertEqual(len(calls), 2)
        phase_q_settings = calls[1]["settings"]
        self.assertEqual(phase_q_settings["max_one_period_sessions"], 1)
        self.assertEqual(
            phase_q_settings["session_early_stop_max_one_period_sessions"],
            1,
        )
        self.assertEqual(
            phase_q_settings[
                "_verified_one_period_teacher_sessions_lower_bound"
            ],
            1,
        )
        self.assertEqual(metrics["one_period_teacher_sessions"], 330)
        self.assertEqual(
            metrics["one_period_teacher_sessions_lower_bound"],
            1,
        )
        self.assertEqual(
            termination,
            "first_click_feasibility_retained_after_quality_error",
        )
        phase_q_attempt = next(
            item for item in attempts if item.get("attempt_key") == "fresh:phase_q"
        )
        self.assertTrue(phase_q_attempt["incumbent_retained"])
        self.assertIn("phase q failed", phase_q_attempt["error"])
        self.assertEqual(result["metrics"], metrics)


if __name__ == "__main__":
    unittest.main()
