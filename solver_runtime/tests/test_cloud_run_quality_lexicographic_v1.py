"""Focused contracts for the Cloud Run strict/soft quality portfolio."""

from __future__ import annotations

import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_new.adapter import (  # noqa: E402
    SolverDeadline,
    _solve_unified_first_click_feasibility_then_quality,
    _cloud_run_quality_lexicographic_v1_enabled,
    build_school_data_from_ui,
    _solve_cloud_run_quality_lexicographic_tail_v1,
)
from tkb_optimizer_ref.models import (  # noqa: E402
    Assignment,
    ClassInfo,
    Lesson,
    SchoolData,
)
from tkb_optimizer_ref.rules import TimetableConstraintRules, TimetableRuleSet  # noqa: E402
from tkb_optimizer_ref.session_cp_sat import solve_session_allocation_cp_sat  # noqa: E402
from tkb_optimizer_ref.template import all_sessions  # noqa: E402


def _payload(
    *,
    sessions: int,
    singletons: int,
    gap1: int,
    gap2: int,
    complete: bool = True,
    hard: bool = True,
    lessons: list[dict] | None = None,
) -> dict:
    expected = 10
    scheduled = expected if complete else expected - 1
    return {
        "ok": True,
        "lessons": list(lessons or []),
        "unassignedLessons": [],
        "metrics": {
            "hard_ok": hard,
            "core_hard_ok": hard,
            "scheduled_periods": scheduled,
            "expected_periods": expected,
            "unassigned_periods": expected - scheduled,
            "app_constraint_violation_count": 0,
            "app_constraint_violations": [],
            "teacher_sessions": sessions,
            "one_period_teacher_sessions": singletons,
            "gap_distribution": {
                0: max(0, sessions - gap1 - gap2),
                1: gap1,
                2: gap2,
            },
        },
        "validation": {
            "hard_ok": hard,
            "violations": [] if hard else ["hard"],
        },
        "solver": {},
    }


class CloudRunQualityLexicographicV1Tests(unittest.TestCase):
    def test_gate_is_cloud_run_only_and_can_be_disabled(self) -> None:
        with patch.dict(os.environ, {"K_SERVICE": ""}, clear=False):
            self.assertFalse(_cloud_run_quality_lexicographic_v1_enabled({}))
        with patch.dict(os.environ, {"K_SERVICE": "tkb-solver"}, clear=False):
            self.assertTrue(_cloud_run_quality_lexicographic_v1_enabled({}))
            self.assertFalse(
                _cloud_run_quality_lexicographic_v1_enabled(
                    {"cloud_run_quality_lexicographic_v1": False}
                )
            )

    def _run_tail(
        self,
        incumbent: dict,
        candidate: dict,
        *,
        required_lessons: list[Lesson] | None = None,
    ) -> tuple[dict | None, dict, dict]:
        captured: dict = {}

        def fake_benders(_ui_data, candidate_settings, **kwargs):
            captured.update(dict(candidate_settings))
            captured["cap"] = kwargs["cap"]
            captured["time_limit_seconds"] = kwargs["time_limit_seconds"]
            captured["incumbent_payload"] = kwargs["incumbent_payload"]
            return candidate

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, summary = _solve_cloud_run_quality_lexicographic_tail_v1(
                {"fixture": True},
                {"cloud_run_quality_lexicographic_tail_seconds": 60},
                quality_settings={"preserve_fixed_lessons_only": True},
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                incumbent_payload=incumbent,
                required_lessons=list(required_lessons or []),
                feasibility_sessions=10,
                first_click_quality_seed=8421,
                return_reserve=5,
                protected_local_tail=0,
            )
        return result, summary, captured

    def test_soft_tail_keeps_gap2_hard_and_orders_singleton_sessions_gap1(self) -> None:
        incumbent = _payload(sessions=10, singletons=5, gap1=1, gap2=2)
        candidate = _payload(sessions=9, singletons=3, gap1=8, gap2=0)

        result, summary, settings = self._run_tail(incumbent, candidate)

        self.assertIsNotNone(result)
        self.assertTrue(summary["accepted"])
        self.assertEqual(summary["mode"], "soft_singleton_gap2_zero")
        self.assertEqual(settings["max_one_period_sessions"], "off")
        self.assertFalse(settings["strict_one_period_sessions_cap"])
        self.assertFalse(settings["enforce_max_one_period_sessions"])
        self.assertTrue(settings["optimization_benders_minimize_one_period_sessions"])
        self.assertTrue(settings["optimization_benders_minimize_period_gaps"])
        self.assertFalse(settings["optimization_benders_period_gap_priority_absolute"])
        self.assertEqual(
            settings["optimization_benders_max_teacher_gap2_plus_sessions"],
            0,
        )
        self.assertEqual(settings["period_max_teacher_gap"], "off")
        self.assertFalse(settings["relax_period_teacher_gap_on_failure"])
        self.assertFalse(settings["optimization_benders_lock_teacher_sessions"])
        self.assertEqual(
            settings["quality_priority_order"],
            "one_period_gap2_teacher_sessions_gap1",
        )
        self.assertEqual(settings["cap"], 10)
        self.assertEqual(settings["time_limit_seconds"], 60)
        self.assertIs(settings["incumbent_payload"], incumbent)

    def test_clean_incumbent_keeps_both_zero_targets_hard_while_polishing(self) -> None:
        incumbent = _payload(sessions=10, singletons=0, gap1=5, gap2=0)
        candidate = _payload(sessions=9, singletons=0, gap1=4, gap2=0)

        result, summary, settings = self._run_tail(incumbent, candidate)

        self.assertIsNotNone(result)
        self.assertTrue(summary["accepted"])
        self.assertEqual(summary["mode"], "hard_zero_polish")
        self.assertEqual(settings["max_one_period_sessions"], 0)
        self.assertTrue(settings["strict_one_period_sessions_cap"])
        self.assertTrue(settings["enforce_max_one_period_sessions"])
        self.assertFalse(settings["optimization_benders_minimize_one_period_sessions"])
        self.assertFalse(settings["allow_quality_debt"])

    def test_tail_rejects_gap2_incomplete_hard_invalid_and_fixed_loss(self) -> None:
        fixed = Lesson(
            class_name="6/1",
            grade="6",
            day=2,
            session="AM",
            period=1,
            subject="Math",
            teacher="T1",
        )
        fixed_row = {
            "className": "6/1",
            "grade": "6",
            "day": 2,
            "session": "AM",
            "period": 1,
            "subject": "Math",
            "teacher": "T1",
        }
        incumbent = _payload(
            sessions=10,
            singletons=5,
            gap1=2,
            gap2=2,
            lessons=[fixed_row],
        )
        rejected = (
            (
                _payload(sessions=9, singletons=3, gap1=1, gap2=1),
                [],
                "gap2_not_zero",
            ),
            (
                _payload(
                    sessions=9,
                    singletons=3,
                    gap1=1,
                    gap2=0,
                    complete=False,
                ),
                [],
                "incomplete_hard_invalid_or_fixed_loss",
            ),
            (
                _payload(
                    sessions=9,
                    singletons=3,
                    gap1=1,
                    gap2=0,
                    hard=False,
                ),
                [],
                "incomplete_hard_invalid_or_fixed_loss",
            ),
            (
                _payload(sessions=9, singletons=3, gap1=1, gap2=0),
                [fixed],
                "incomplete_hard_invalid_or_fixed_loss",
            ),
        )
        for candidate, required, reason in rejected:
            with self.subTest(reason=reason):
                result, summary, _settings = self._run_tail(
                    incumbent,
                    candidate,
                    required_lessons=required,
                )
                self.assertIsNone(result)
                self.assertFalse(summary["accepted"])
                self.assertEqual(summary["reject_reason"], reason)

    def test_tail_keeps_incumbent_when_solver_errors_or_budget_is_gone(self) -> None:
        incumbent = _payload(sessions=10, singletons=5, gap1=2, gap2=2)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=RuntimeError("strict soft-tail model failed"),
        ):
            result, summary = _solve_cloud_run_quality_lexicographic_tail_v1(
                {},
                {"cloud_run_quality_lexicographic_tail_seconds": 60},
                quality_settings={},
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                incumbent_payload=incumbent,
                required_lessons=[],
                feasibility_sessions=10,
                first_click_quality_seed=8421,
                return_reserve=5,
                protected_local_tail=0,
            )
        self.assertIsNone(result)
        self.assertTrue(summary["incumbent_retained"])
        self.assertIn("failed", summary["error"])

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate"
        ) as solver:
            result, summary = _solve_cloud_run_quality_lexicographic_tail_v1(
                {},
                {},
                quality_settings={},
                rules=None,
                progress=None,
                deadline=SolverDeadline(1),
                incumbent_payload=incumbent,
                required_lessons=[],
                feasibility_sessions=10,
                first_click_quality_seed=8421,
                return_reserve=5,
                protected_local_tail=0,
            )
        solver.assert_not_called()
        self.assertIsNone(result)
        self.assertTrue(summary["skipped"])
        self.assertEqual(summary["reason"], "insufficient_cloud_quality_tail_budget")

    def test_unified_cloud_path_uses_strict_probe_then_soft_tail(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {
                "subject": {
                    "Math": {
                        "byClass": {
                            "L1": {"lessonBlocks": {"2": {"min": 1}}}
                        }
                    }
                }
            },
        }
        ctx = build_school_data_from_ui(data)
        phase_f = _payload(sessions=522, singletons=28, gap1=75, gap2=5)
        soft_tail = _payload(sessions=500, singletons=8, gap1=100, gap2=0)
        calls: list[tuple[dict, dict]] = []

        def fake_benders(_data, candidate_settings, **kwargs):
            calls.append((dict(candidate_settings), dict(kwargs)))
            if len(calls) == 1:
                return phase_f
            if len(calls) == 2:
                raise RuntimeError("strict singleton zero infeasible")
            if len(calls) == 3:
                return soft_tail
            raise AssertionError(f"unexpected solver call {len(calls)}")

        settings = {
            "target_teacher_sessions": 466,
            "target_gap1_sessions": 53,
            "optimization_accept_teacher_sessions": 466,
            "optimization_accept_gap1_sessions": 53,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "optimization_first_click_quality_time_limit_seconds": 120,
            "optimization_first_click_strict_quality_gate": True,
            "overall_time_limit_seconds": 180,
            "ui_bounded_fresh_accept_quality_debt": True,
            "ui_stop_after_first_complete_schedule": True,
            "optimization_first_click_skip_global_quality": True,
            "ui_unified_first_click_quality": True,
            "ui_unified_solve_kind": "fresh_complete_first",
            "num_workers": 6,
        }
        with (
            patch.dict(os.environ, {"K_SERVICE": "tkb-solver"}, clear=False),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ),
        ):
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    settings,
                    bound_ctx=ctx,
                    bounds={
                        "lower_cap": 346,
                        "start_cap": 461,
                        "upper_cap": 1116,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=ctx.rules,
                    progress=None,
                    deadline=SolverDeadline(180),
                    polish_seeds=[1],
                    requested_random_seed=101,
                )
            )

        self.assertEqual(len(calls), 3)
        self.assertEqual(termination, "first_click_cloud_quality_lexicographic_improved")
        self.assertEqual(result["lessons"], soft_tail["lessons"])
        self.assertEqual(metrics, soft_tail["metrics"])
        self.assertEqual(metrics["one_period_teacher_sessions"], 8)
        self.assertEqual(metrics["gap_distribution"].get(2), 0)
        strict_settings, strict_kwargs = calls[1]
        self.assertEqual(strict_kwargs["time_limit_seconds"], 30)
        self.assertEqual(strict_settings["max_one_period_sessions"], 0)
        self.assertEqual(
            strict_settings["optimization_benders_max_teacher_gap2_plus_sessions"],
            0,
        )
        soft_settings, soft_kwargs = calls[2]
        self.assertEqual(soft_kwargs["time_limit_seconds"], 110)
        self.assertEqual(soft_settings["max_one_period_sessions"], "off")
        self.assertTrue(soft_settings["optimization_benders_minimize_one_period_sessions"])
        self.assertTrue(soft_settings["optimization_benders_minimize_period_gaps"])
        self.assertFalse(soft_settings["optimization_benders_period_gap_priority_absolute"])
        self.assertEqual(soft_settings["period_max_teacher_gap"], "off")
        self.assertEqual(
            [item.get("attempt_key") for item in attempts[:3]],
            [
                "fresh:phase_f:period_safe_complete",
                "fresh:phase_q",
                "fresh:phase_q:cloud_quality_lexicographic_v1",
            ],
        )

    def test_cp_sat_objective_is_singleton_then_sessions_then_gap1(self) -> None:
        school = SchoolData(
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
        empty_rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={},
                teacher={},
                subject={},
                subject_group={},
            )
        )

        _allocations, metrics = solve_session_allocation_cp_sat(
            school,
            rules=empty_rules,
            max_teacher_sessions=2,
            max_one_period_sessions=None,
            minimize_sessions=True,
            minimize_one_period_sessions=True,
            one_period_priority_absolute=True,
            period_feasibility_session_indexes=set(range(len(all_sessions()))),
            period_max_teacher_gap=None,
            period_max_teacher_gap2_plus_sessions=0,
            period_minimize_teacher_gaps=True,
            period_teacher_gap_priority_absolute=False,
            materialize_period_lessons=True,
            time_limit_seconds=5,
            num_workers=1,
            random_seed=101,
        )

        objective = metrics["objective_mode"]
        self.assertTrue(
            objective.startswith(
                "minimize_one_period_teacher_sessions_then_teacher_sessions"
            ),
            objective,
        )
        self.assertLess(
            objective.index("teacher_sessions"),
            objective.index("teacher_gap1_sessions"),
        )
        self.assertEqual(metrics["period_max_teacher_gap2_plus_sessions"], 0)
        self.assertIsNone(metrics["period_max_teacher_gap"])


if __name__ == "__main__":
    unittest.main()
