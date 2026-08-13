from __future__ import annotations

import json
import math
import unittest
from collections import Counter
from pathlib import Path
from typing import Any


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = (
    RUNTIME_ROOT
    / "fixtures"
    / "performance"
    / "automatic_solver_observations_v1.json"
)

EXPECTED_TOP_LEVEL_FIELDS = {
    "protocol",
    "schemaVersion",
    "provenance",
    "definitions",
    "guardrails",
    "observedSummary",
    "rows",
}

EXPECTED_ROW_FIELDS = {
    "run_id",
    "cohort",
    "status_name",
    "objective_mode",
    "allow_unassigned",
    "one_period_priority_absolute",
    "wall_time_seconds",
    "objective",
    "best_bound",
    "branches",
    "assignment_session_vars",
    "teacher_session_vars",
    "period_block_vars",
    "total_requested_periods",
    "fixed_lessons",
    "workers",
    "scheduled_periods",
    "expected_periods",
    "best_effort",
    "deadline_exhausted",
    "capacity_unassigned_periods",
    "solver_unassigned_periods",
    "classes",
    "teachers",
}

INTEGER_ROW_FIELDS = EXPECTED_ROW_FIELDS - {
    "run_id",
    "cohort",
    "status_name",
    "objective_mode",
    "allow_unassigned",
    "one_period_priority_absolute",
    "wall_time_seconds",
    "objective",
    "best_bound",
    "best_effort",
    "deadline_exhausted",
}


def _load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _raw_objective_gap_ratio(row: dict[str, Any]) -> float:
    objective = float(row["objective"])
    best_bound = float(row["best_bound"])
    if best_bound == 0.0:
        if objective == 0.0:
            return 0.0
        return math.inf
    return (objective - best_bound) / abs(best_bound)


def _completion_ratio(row: dict[str, Any]) -> float:
    return float(row["scheduled_periods"]) / float(row["expected_periods"])


class SolverPerformanceRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture()
        cls.rows = cls.fixture["rows"]

    def test_fixture_contract_and_provenance_are_explicit(self) -> None:
        self.assertEqual(set(self.fixture), EXPECTED_TOP_LEVEL_FIELDS)
        self.assertEqual(
            self.fixture["protocol"],
            "tkb-auto-arrange-observations-v1",
        )
        self.assertEqual(self.fixture["schemaVersion"], 1)

        provenance = self.fixture["provenance"]
        self.assertFalse(provenance["containsDirectIdentifiers"])
        self.assertEqual(
            provenance["sourceDocument"],
            "tracking/SOLVER_PERFORMANCE_DIAGNOSIS.md",
        )
        self.assertIn("not a benchmark", provenance["observationSemantics"])
        self.assertGreaterEqual(len(provenance["removedData"]), 3)

    def test_rows_have_a_stable_sanitized_schema_and_exact_accounting(self) -> None:
        self.assertEqual(len(self.rows), 14)
        self.assertEqual(
            [row["run_id"] for row in self.rows],
            [f"run-{index:02d}" for index in range(1, 15)],
        )

        for row in self.rows:
            with self.subTest(run_id=row["run_id"]):
                self.assertEqual(set(row), EXPECTED_ROW_FIELDS)
                self.assertIn(row["cohort"], {"large-school", "smoke"})
                self.assertIn(row["status_name"], {"OPTIMAL", "FEASIBLE"})
                self.assertTrue(row["objective_mode"])

                for field in INTEGER_ROW_FIELDS:
                    self.assertIs(type(row[field]), int, field)
                    self.assertGreaterEqual(row[field], 0, field)
                for field in (
                    "allow_unassigned",
                    "one_period_priority_absolute",
                    "best_effort",
                    "deadline_exhausted",
                ):
                    self.assertIs(type(row[field]), bool, field)
                for field in ("wall_time_seconds", "objective", "best_bound"):
                    self.assertIsInstance(row[field], (int, float), field)
                    self.assertTrue(math.isfinite(float(row[field])), field)

                self.assertGreater(row["wall_time_seconds"], 0)
                self.assertGreater(row["expected_periods"], 0)
                self.assertLessEqual(row["best_bound"], row["objective"])
                self.assertEqual(
                    row["scheduled_periods"]
                    + row["capacity_unassigned_periods"]
                    + row["solver_unassigned_periods"],
                    row["expected_periods"],
                )
                self.assertEqual(
                    row["total_requested_periods"]
                    + row["fixed_lessons"]
                    + row["capacity_unassigned_periods"],
                    row["expected_periods"],
                )

    def test_observed_summary_is_recomputed_from_all_cohorts(self) -> None:
        summary = self.fixture["observedSummary"]
        gap_ratios = [_raw_objective_gap_ratio(row) for row in self.rows]
        completion_ratios = [_completion_ratio(row) for row in self.rows]

        self.assertEqual(summary["observationCount"], len(self.rows))
        self.assertEqual(
            summary["cohortCounts"],
            dict(Counter(row["cohort"] for row in self.rows)),
        )
        self.assertEqual(summary["cohortCounts"], {"large-school": 13, "smoke": 1})
        self.assertEqual(
            summary["statusCounts"],
            dict(Counter(row["status_name"] for row in self.rows)),
        )
        self.assertEqual(summary["statusCounts"], {"OPTIMAL": 8, "FEASIBLE": 6})
        self.assertEqual(
            summary["bestEffortCount"],
            sum(bool(row["best_effort"]) for row in self.rows),
        )
        self.assertEqual(
            summary["deadlineExhaustedCount"],
            sum(bool(row["deadline_exhausted"]) for row in self.rows),
        )
        self.assertEqual(
            summary["maxAssignmentSessionVars"],
            max(row["assignment_session_vars"] for row in self.rows),
        )
        self.assertEqual(
            summary["maxTeacherSessionVars"],
            max(row["teacher_session_vars"] for row in self.rows),
        )
        self.assertEqual(
            summary["maxPeriodBlockVars"],
            max(row["period_block_vars"] for row in self.rows),
        )
        self.assertAlmostEqual(
            summary["maxRawObjectiveGapRatio"],
            max(gap_ratios),
            places=12,
        )
        self.assertAlmostEqual(
            summary["minCompletionRatio"],
            min(completion_ratios),
            places=12,
        )

    def test_historical_observations_stay_inside_documented_guardrails(self) -> None:
        guardrails = self.fixture["guardrails"]
        self.assertEqual(
            set(guardrails),
            {"maximumRawObjectiveGapRatio", "minimumCompletionRatio"},
        )
        self.assertLessEqual(
            max(_raw_objective_gap_ratio(row) for row in self.rows),
            guardrails["maximumRawObjectiveGapRatio"],
        )
        self.assertGreaterEqual(
            min(_completion_ratio(row) for row in self.rows),
            guardrails["minimumCompletionRatio"],
        )

        # Archived wall time depends on the old code, machine, and load. Keep it
        # visible as evidence, but do not pretend it measures this checkout.
        self.assertNotIn("maximumWallTimeSeconds", guardrails)
        self.assertIn("no guardrail", self.fixture["definitions"]["wallTimeLimit"])


if __name__ == "__main__":
    unittest.main()
