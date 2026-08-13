from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))
sys.path.insert(0, str(RUNTIME_ROOT))

from tkb_new.adapter import solve_from_ui_data  # noqa: E402
from tkb_optimizer_ref.models import Lesson, Session, SessionAllocation  # noqa: E402


def _capacity_partial_fixture() -> dict[str, Any]:
    """One proven capacity excess plus three schedulable residual periods."""

    fixed_off: dict[str, bool] = {}
    only_slot = (2, "AM", 1)
    for day in range(2, 8):
        for session, ui_session in (("AM", "sang"), ("PM", "chieu")):
            for period in range(1, 6):
                if (day, session, period) != only_slot:
                    fixed_off[f"thu{day}|{ui_session}|{period - 1}"] = True
    return {
        "lop": [
            {"id": "L1", "ten": "6/1", "khoi": "6"},
            {"id": "L2", "ten": "6/2", "khoi": "6"},
        ],
        "giaovien": [
            {"magv": "TA", "ten": "TA"},
            {"magv": "TB", "ten": "TB"},
        ],
        "monhoc": [{"ten": "Math", "ma": "M"}],
        "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
        "pccmMatrix": {"L1|Math": "TA", "L2|Math": "TB"},
        "pccmTietMatrix": {"L1|Math": 2, "L2|Math": 2},
        "tkbConstraints": {"fixedOff": {"class": {"L1": fixed_off}}},
    }


class CapacityResidualCompletionContractTests(unittest.TestCase):
    def test_capacity_partial_retries_period_vector_until_residual_is_complete(self) -> None:
        allocations = [
            SessionAllocation(
                class_name="6/1",
                grade="6",
                subject="Math",
                teacher="TA",
                session=Session(day=2, part="AM"),
                count=1,
            ),
            SessionAllocation(
                class_name="6/2",
                grade="6",
                subject="Math",
                teacher="TB",
                session=Session(day=2, part="AM"),
                count=2,
            ),
        ]
        partial_lessons = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "TA"),
            Lesson("6/2", "6", 2, "AM", 1, "Math", "TB"),
        ]
        complete_residual = [
            *partial_lessons,
            Lesson("6/2", "6", 2, "AM", 2, "Math", "TB"),
        ]
        session_calls: list[dict[str, Any]] = []
        period_calls = 0

        def session_solver(_data: Any, **kwargs: Any):
            session_calls.append(dict(kwargs))
            return allocations, {
                "solver": "capacity_residual_test",
                "status_name": "FEASIBLE",
                "teacher_sessions": 2,
                "one_period_teacher_sessions": 0,
                "unassigned_periods": 0,
            }

        def period_solver(_data: Any, _allocations: Any, **_kwargs: Any):
            nonlocal period_calls
            period_calls += 1
            if period_calls == 1:
                return partial_lessons, {
                    "best_effort_failed_sessions": [
                        {
                            "session": {"day": 2, "part": "AM"},
                            "diagnostics": {"reason": "milp_infeasible_or_timeout"},
                        }
                    ]
                }
            return complete_residual, {"best_effort_failed_sessions": []}

        with (
            patch(
                "tkb_new.adapter.solve_session_allocation_cp_sat",
                side_effect=session_solver,
            ),
            patch("tkb_new.adapter.allocate_periods", side_effect=period_solver),
        ):
            result = solve_from_ui_data(
                _capacity_partial_fixture(),
                {
                    "solver_mode": "auto",
                    "auto_sort_mode": "fast",
                    "max_teacher_sessions": 180,
                    "requested_max_teacher_sessions": 180,
                    "strict_teacher_session_cap": False,
                    "best_effort_on_timeout": True,
                    "overall_time_limit_seconds": 30,
                    "session_time_limit": 10,
                    "period_time_limit": 5,
                    "period_retry_time_limit": 3,
                    "num_workers": 1,
                    "minimize_sessions": False,
                    "minimize_one_period_sessions": False,
                    "allow_one_period_gaps": True,
                    "aggressive_fast_mode": False,
                },
            )

        self.assertEqual(period_calls, 2)
        self.assertEqual(len(session_calls), 2)
        self.assertFalse(session_calls[0]["allow_unassigned"])
        self.assertTrue(session_calls[1]["forbidden_session_vectors"])
        self.assertTrue(result["ok"])
        self.assertTrue(result["metrics"]["hard_ok"])
        self.assertEqual(result["metrics"]["expected_periods"], 4)
        self.assertEqual(result["metrics"]["scheduled_periods"], 3)
        self.assertEqual(result["metrics"]["capacity_unassigned_periods"], 1)
        self.assertEqual(result["metrics"]["solver_unassigned_periods"], 0)


if __name__ == "__main__":
    unittest.main()
