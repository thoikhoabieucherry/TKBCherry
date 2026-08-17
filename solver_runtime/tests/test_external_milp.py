from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from tkb_optimizer_ref.external_cp_sat import external_solver_scope  # noqa: E402
from tkb_optimizer_ref.external_milp import (  # noqa: E402
    solve_milp_with_external_runtime,
)
from tkb_optimizer_ref.models import Assignment, ClassInfo, SchoolData  # noqa: E402
from tkb_optimizer_ref.session_milp import solve_session_allocation  # noqa: E402
from tkb_optimizer_ref.template import all_sessions  # noqa: E402


class ExternalMilpTests(unittest.TestCase):
    @staticmethod
    def _problem() -> tuple[np.ndarray, ...]:
        return (
            np.array([1.0]),
            np.array([1]),
            np.array([0.0]),
            np.array([1.0]),
            csr_matrix([[1.0]]),
            np.array([1.0]),
            np.array([1.0]),
        )

    def test_infeasible_status_round_trips_without_a_primal_vector(self) -> None:
        def runtime(_model: bytes, _parameters: bytes) -> bytes:
            return json.dumps(
                {"status": "Infeasible", "objective": None, "values": None}
            ).encode("utf-8")

        with external_solver_scope(runtime):
            result = solve_milp_with_external_runtime(
                *self._problem(),
                time_limit_seconds=5,
            )

        self.assertIsNotNone(result)
        self.assertEqual(result.status, 2)
        self.assertEqual(result.message, "Infeasible")
        self.assertIsNone(result.x)
        self.assertIsNone(result.fun)
        self.assertFalse(result.success)

    def test_optimal_primal_is_still_validated_and_materialized(self) -> None:
        def runtime(_model: bytes, _parameters: bytes) -> bytes:
            return json.dumps(
                {"status": "Optimal", "objective": 1, "values": [1]}
            ).encode("utf-8")

        with external_solver_scope(runtime):
            result = solve_milp_with_external_runtime(
                *self._problem(),
                time_limit_seconds=5,
            )

        self.assertTrue(result.success)
        self.assertEqual(result.status, 0)
        self.assertEqual(result.fun, 1.0)
        np.testing.assert_array_equal(result.x, np.array([1.0]))

    def test_session_milp_no_good_cut_moves_a_forbidden_session_vector(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6A1", grade="6")],
            assignments=[
                Assignment(
                    class_name="6A1",
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
        first, _ = solve_session_allocation(
            data,
            max_teacher_sessions=2,
            minimize_sessions=True,
            time_limit_seconds=5,
            verbose=False,
        )
        self.assertEqual(len(first), 1)
        sessions = all_sessions()
        first_session = sessions.index(first[0].session)

        second, metrics = solve_session_allocation(
            data,
            max_teacher_sessions=2,
            minimize_sessions=True,
            forbidden_session_vectors=[(first_session, {0: 2})],
            time_limit_seconds=5,
            verbose=False,
        )

        self.assertEqual(sum(item.count for item in second), 2)
        self.assertFalse(
            any(item.session == sessions[first_session] and item.count == 2 for item in second)
        )
        self.assertEqual(metrics["forbidden_session_vectors"], 1)


if __name__ == "__main__":
    unittest.main()
