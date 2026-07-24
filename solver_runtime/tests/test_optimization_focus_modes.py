"""Focused contract tests for the scheduler's quality modes."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_new.adapter import (  # noqa: E402
    SolverDeadline,
    _optimization_focus_goal_status,
    _optimization_metric_payload,
    _settings_for_optimization_focus,
    _solve_teacher_session_optimized_from_ui_data,
    _solve_two_stage_concrete_refinement,
    _unified_first_click_candidate_acceptable,
)


def _payload(
    *,
    sessions: int,
    singletons: int = 0,
    gap1: int = 0,
    gap2: int = 0,
) -> dict:
    return {
        "ok": True,
        "metrics": {
            "hard_ok": True,
            "scheduled_periods": 4,
            "expected_periods": 4,
            "unassigned_periods": 0,
            "app_constraint_violation_count": 0,
            "teacher_sessions": sessions,
            "one_period_teacher_sessions": singletons,
            "gap_distribution": {
                0: max(0, sessions - gap1 - gap2),
                1: gap1,
                2: gap2,
            },
        },
        "validation": {"hard_ok": True},
        "solver": {},
        "lessons": [],
    }


class OptimizationFocusModeTests(unittest.TestCase):
    def test_focus_settings_are_explicit_and_do_not_use_unknown_modes(self) -> None:
        quick = _settings_for_optimization_focus(
            {
                "optimization_focus": "quick",
                "target_teacher_sessions": 4,
                "target_gap1_sessions": 0,
                "max_one_period_sessions": 0,
                "strict_one_period_sessions_cap": True,
                "minimize_one_period_sessions": True,
                "minimize_teacher_gaps": True,
                "period_max_teacher_gap": 1,
            }
        )
        self.assertEqual(quick["optimization_focus"], "quick_complete")
        self.assertEqual(quick["ui_unified_solve_kind"], "fresh_complete_first")
        self.assertFalse(quick["optimization_two_stage_teacher_quality"])
        self.assertTrue(quick["optimization_benders_session_feasibility_only"])
        self.assertFalse(quick["minimize_one_period_sessions"])
        self.assertFalse(quick["minimize_sessions"])
        self.assertEqual(quick["max_one_period_sessions"], "off")
        self.assertFalse(quick["strict_one_period_sessions_cap"])
        self.assertFalse(quick["minimize_teacher_gaps"])
        self.assertEqual(quick["period_max_teacher_gap"], "off")
        self.assertTrue(quick["native_skip_teacher_optimization"])
        self.assertNotIn("target_teacher_sessions", quick)
        self.assertNotIn("target_gap1_sessions", quick)

        gaps = _settings_for_optimization_focus({"optimization_focus": "teacher-gaps"})
        self.assertEqual(gaps["optimization_focus"], "gaps")
        self.assertEqual(gaps["ui_unified_solve_kind"], "refine_complete")
        self.assertTrue(gaps["ui_use_existing_complete_incumbent"])

        bridge_singletons = _settings_for_optimization_focus(
            {
                "optimization_focus": "one_period_teacher_sessions",
                "optimization_two_stage_teacher_quality": False,
            }
        )
        self.assertEqual(bridge_singletons["optimization_focus"], "singletons")
        self.assertTrue(bridge_singletons["optimization_two_stage_teacher_quality"])

        sessions = _settings_for_optimization_focus(
            {
                "optimization_focus": "teacher_sessions",
                "target_gap1_sessions": 0,
                "optimization_accept_gap1_sessions": 12,
            }
        )
        self.assertNotIn("target_gap1_sessions", sessions)
        self.assertNotIn("optimization_accept_gap1_sessions", sessions)

        gaps = _settings_for_optimization_focus(
            {
                "optimization_focus": "teacher_gaps",
                "target_teacher_sessions": 10,
                "optimization_accept_teacher_sessions": 12,
            }
        )
        self.assertNotIn("target_teacher_sessions", gaps)
        self.assertNotIn("optimization_accept_teacher_sessions", gaps)

        singletons = _settings_for_optimization_focus(
            {
                "optimization_focus": "one_period_teacher_sessions",
                "target_teacher_sessions": 10,
                "target_gap1_sessions": 0,
            }
        )
        self.assertNotIn("target_teacher_sessions", singletons)
        self.assertNotIn("target_gap1_sessions", singletons)
        self.assertEqual(singletons["target_one_period_teacher_sessions"], 0)

    def test_progress_metrics_are_goal_based_and_clamped(self) -> None:
        sessions = _optimization_metric_payload(
            "sessions",
            {"teacher_sessions": 470},
            session_target=432,
            metric_kind="sessions",
        )
        self.assertEqual(sessions["metricCurrent"], 470)
        self.assertEqual(sessions["metricTarget"], 432)
        self.assertEqual(sessions["metricPercent"], 91.9)

        gaps = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 5, 2: 4}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gaps",
        )
        self.assertEqual(gaps["optimizationFocus"], "teacher_gap2_sessions")
        self.assertEqual(gaps["metricCurrent"], 4)
        self.assertEqual(gaps["metricPercent"], 0.0)
        self.assertLessEqual(gaps["metricPercent"], 100.0)

        gap2_improved = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 5, 2: 2}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gaps",
        )
        self.assertEqual(gap2_improved["optimizationFocus"], "teacher_gap2_sessions")
        self.assertEqual(gap2_improved["metricCurrent"], 2)
        self.assertEqual(gap2_improved["metricPercent"], 25.0)

        gap1 = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 3}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gaps",
        )
        self.assertEqual(gap1["optimizationFocus"], "teacher_gap1_sessions")
        self.assertEqual(gap1["metricCurrent"], 3)
        self.assertEqual(gap1["metricBaseline"], 5)
        self.assertEqual(gap1["metricPercent"], 70.0)

        gap1_only = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 3}},
            baseline_metrics={"gap_distribution": {1: 5}},
            metric_kind="gaps",
        )
        self.assertEqual(gap1_only["optimizationFocus"], "teacher_gap1_sessions")
        self.assertEqual(gap1_only["metricPercent"], 40.0)

    def test_quick_complete_accepts_all_quality_debt_after_hard_completion(self) -> None:
        gap_debt = _payload(sessions=5, singletons=0, gap1=2, gap2=3)
        singleton_debt = _payload(sessions=5, singletons=1, gap1=2, gap2=0)
        authored_constraint_violation = _payload(
            sessions=5,
            singletons=1,
            gap1=2,
            gap2=3,
        )
        authored_constraint_violation["metrics"]["app_constraint_violation_count"] = 1

        self.assertFalse(
            _unified_first_click_candidate_acceptable(gap_debt, [])
        )
        self.assertTrue(
            _unified_first_click_candidate_acceptable(
                gap_debt,
                [],
                allow_gap2_debt=True,
            )
        )
        self.assertFalse(
            _unified_first_click_candidate_acceptable(
                singleton_debt,
                [],
                allow_gap2_debt=True,
            )
        )
        self.assertTrue(
            _unified_first_click_candidate_acceptable(
                singleton_debt,
                [],
                allow_quality_debt=True,
            )
        )
        self.assertFalse(
            _unified_first_click_candidate_acceptable(
                authored_constraint_violation,
                [],
                allow_quality_debt=True,
            )
        )

    def test_sessions_focus_runs_only_session_phase(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        candidate = _payload(sessions=4, gap1=3)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return candidate

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
                session_target=3,
            )

        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0]["settings"]["optimization_benders_minimize_period_gaps"])
        self.assertEqual([item["phase"] for item in attempts], ["two_stage_session_compression"])
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertEqual(result["solver"]["two_stage_teacher_optimization"]["mode"], "sessions_only")

    def test_sessions_focus_keeps_a_soft_stopped_improved_candidate(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        candidate = _payload(sessions=4, gap1=3, gap2=1)
        candidate["solver"]["session_solver"] = {
            "best_effort_stop_requested": True,
            "best_effort_stop_applied": True,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=candidate,
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7],
            )

        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertTrue(
            result["solver"]["session_solver"]["best_effort_stop_applied"]
        )

    def test_sessions_focus_retries_with_the_incumbent_singleton_cap(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        relaxed = _payload(sessions=4, singletons=1, gap1=3)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if len(calls) == 1:
                raise RuntimeError("zero singleton infeasible")
            return relaxed

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["settings"]["max_one_period_sessions"], 0)
        self.assertEqual(calls[1]["settings"]["max_one_period_sessions"], 1)
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertTrue(attempts[0]["incumbent_singleton_fallback"]["selected"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "session_compression",
        )

    def test_automatic_requires_coordinated_gap_cleanup(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        phase_s = _payload(sessions=4, gap1=1, gap2=1)
        phase_g = _payload(sessions=4, gap1=2, gap2=0)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[phase_s, phase_g],
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "gap_cleanup",
        )

    def test_automatic_reserves_more_solver_time_for_gap_cleanup(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        phase_s = _payload(sessions=4, gap1=1, gap2=1)
        phase_g = _payload(sessions=4, gap1=2, gap2=0)
        calls: list[tuple[int, int]] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append(
                (
                    int(call_settings["optimization_benders_session_time_limit"]),
                    int(kwargs["time_limit_seconds"]),
                )
            )
            return phase_s if len(calls) == 1 else phase_g

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(calls[0], (86, 98))
        self.assertGreaterEqual(calls[1][0], 8)
        self.assertLessEqual(calls[1][0], 55)
        self.assertEqual(calls[1][1], calls[1][0] + 12)

    def test_automatic_discards_phase_s_gap_debt_when_phase_g_fails(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        phase_s = _payload(sessions=4, gap1=1, gap2=1)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[phase_s, RuntimeError("gap cleanup timeout")],
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(reason, "two_stage_incumbent")
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "incumbent",
        )

    def test_automatic_keeps_session_gain_with_unavoidable_baseline_gap2(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        phase_s = _payload(sessions=4, gap1=2, gap2=1)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                phase_s,
                RuntimeError("zero gap2 infeasible"),
                RuntimeError("bounded gap cleanup timed out"),
            ],
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertTrue(attempts[-1]["automatic_phase_s_fallback_acceptable"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "session_compression",
        )

    def test_automatic_keeps_session_gain_when_authored_rules_force_gap2(self) -> None:
        incumbent = _payload(sessions=5, gap1=4, gap2=1)
        phase_s = _payload(sessions=4, gap1=4, gap2=1)
        bounded_gap = _payload(sessions=4, gap1=2, gap2=1)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if len(calls) == 1:
                return phase_s
            if call_settings["period_max_teacher_gap"] == 1:
                raise RuntimeError("authored rule requires one gap-2 session")
            return bounded_gap

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1]["settings"]["period_max_teacher_gap"], 1)
        self.assertEqual(
            calls[1]["settings"]["optimization_benders_max_teacher_gap2_plus_sessions"],
            0,
        )
        self.assertEqual(calls[2]["settings"]["period_max_teacher_gap"], "off")
        self.assertEqual(
            calls[2]["settings"]["optimization_benders_max_teacher_gap2_plus_sessions"],
            1,
        )
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(attempts[-1]["bounded_gap2_fallback"]["attempted"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "gap_cleanup",
        )

    def test_automatic_retains_safe_phase_s_when_forced_gap2_cannot_improve(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        phase_s = _payload(sessions=4, gap1=3, gap2=1)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                phase_s,
                RuntimeError("zero gap-2 is infeasible"),
                RuntimeError("no bounded gap improvement exists"),
            ],
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "session_compression",
        )

    def test_gap_focus_relaxes_zero_gap_target_without_changing_sessions(self) -> None:
        incumbent = _payload(sessions=5, gap1=4, gap2=1)
        bounded_gap = _payload(sessions=5, gap1=2, gap2=1)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if call_settings["period_max_teacher_gap"] == 1:
                raise RuntimeError("authored rule requires one gap-2 session")
            return bounded_gap

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            _result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["settings"]["period_max_teacher_gap"], 1)
        self.assertEqual(calls[1]["settings"]["period_max_teacher_gap"], "off")
        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")

    def test_sessions_falls_back_to_incumbent_singleton_cap(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        candidate = _payload(sessions=4, singletons=1, gap1=3)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if call_settings["max_one_period_sessions"] == 0:
                raise RuntimeError("one singleton is forced by authored rules")
            return candidate

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            _result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
                session_target=3,
            )

        self.assertEqual(
            [call["settings"]["max_one_period_sessions"] for call in calls],
            [0, 1],
        )
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertTrue(attempts[0]["incumbent_singleton_fallback"]["selected"])

    def test_sessions_singleton_fallback_never_increases_incumbent_debt(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        regressive = _payload(sessions=4, singletons=2, gap1=1)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                RuntimeError("zero singleton is infeasible"),
                regressive,
            ],
        ):
            _result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
                session_target=3,
            )

        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(reason, "two_stage_incumbent")

    def test_automatic_carries_unavoidable_singleton_cap_into_gap_phase(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=3)
        phase_s = _payload(sessions=4, singletons=1, gap1=3)
        phase_g = _payload(sessions=4, singletons=1, gap1=2)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if len(calls) == 1:
                raise RuntimeError("one singleton is forced by authored rules")
            return phase_s if len(calls) == 2 else phase_g

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            _result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(
            [call["settings"]["max_one_period_sessions"] for call in calls],
            [0, 1, 1],
        )
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")

    def test_automatic_accepts_phase_g_confirmation_without_artificial_gap_gain(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        phase_s = _payload(sessions=4, gap1=2, gap2=0)
        phase_g = _payload(sessions=4, gap1=2, gap2=0)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[phase_s, phase_g],
        ):
            _result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "automatic"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(reason, "two_stage_gap_cleanup")

    def test_gaps_focus_locks_session_count_and_runs_only_gap_phase(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        candidate = _payload(sessions=5, gap1=1)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return candidate

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["settings"]["optimization_benders_minimize_period_gaps"])
        self.assertEqual([item["phase"] for item in attempts], ["two_stage_gap_cleanup"])
        self.assertEqual(metrics["gap_distribution"][1], 1)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertEqual(result["solver"]["two_stage_teacher_optimization"]["mode"], "gaps_only")

    def test_gaps_focus_keeps_a_soft_stopped_improved_candidate(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        candidate = _payload(sessions=5, gap1=1, gap2=0)
        candidate["solver"]["session_solver"] = {
            "best_effort_stop_requested": True,
            "best_effort_stop_applied": True,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=candidate,
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7],
            )

        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["gap_distribution"][1], 1)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(
            result["solver"]["session_solver"]["best_effort_stop_applied"]
        )

    def test_gaps_focus_keeps_fast_repack_when_global_search_times_out(self) -> None:
        incumbent = _payload(sessions=5, gap1=2, gap2=1)
        repacked = _payload(sessions=5, gap1=1, gap2=0)

        with (
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions",
                return_value=repacked,
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=RuntimeError("global gap search timed out"),
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["gap_distribution"][1], 1)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(attempts[0]["period_repack"]["improved"])
        self.assertIn("global gap search timed out", attempts[0]["error"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "gap_cleanup",
        )

    def test_gaps_focus_optimizes_around_an_unavoidable_gap2(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        bounded = _payload(sessions=5, gap1=1, gap2=1)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if len(calls) == 1:
                raise RuntimeError("zero gap2 infeasible")
            return bounded

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["settings"]["period_max_teacher_gap"], 1)
        self.assertEqual(calls[1]["settings"]["period_max_teacher_gap"], "off")
        self.assertEqual(
            calls[1]["settings"]["optimization_benders_max_teacher_gap2_plus_sessions"],
            1,
        )
        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(metrics["gap_distribution"][1], 1)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(attempts[0]["bounded_gap2_fallback"]["attempted"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "gap_cleanup",
        )

    def test_singleton_focus_emits_standard_progress_fields(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        candidate = _payload(sessions=5, singletons=0, gap1=3)
        calls: list[dict] = []
        events: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return candidate

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            _result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "singletons"},
                rules=None,
                progress=events.append,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7],
            )

        self.assertEqual(len(calls), 1)
        self.assertTrue(
            calls[0]["settings"]["optimization_benders_session_feasibility_only"]
        )
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(reason, "two_stage_singleton_cleanup")
        self.assertGreaterEqual(len(events), 2)
        for event in events:
            self.assertEqual(event["optimizationFocus"], "one_period_teacher_sessions")
            self.assertIn("metricCurrent", event)
            self.assertIn("metricTarget", event)
            self.assertGreaterEqual(event["metricPercent"], 0.0)
            self.assertLessEqual(event["metricPercent"], 100.0)

    def test_phase_progress_keeps_fresher_event_metrics(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        candidate = _payload(sessions=4, gap1=3)
        events: list[dict] = []

        def fake_benders(_data, _settings, **kwargs):
            nested_progress = kwargs["progress"]
            nested_progress({"stage": "session_cp_sat:done", "teacher_sessions": 4})
            nested_progress({"stage": "teacher_session_opt:benders_period"})
            nested_progress({"stage": "session_cp_sat:metric", "metricCurrent": 3})
            nested_progress({"stage": "teacher_session_opt:after_metric"})
            return candidate

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=events.append,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[7],
                session_target=3,
            )

        done = next(item for item in events if item["stage"] == "session_cp_sat:done")
        period = next(
            item for item in events if item["stage"] == "teacher_session_opt:benders_period"
        )
        self.assertEqual(done["metricCurrent"], 4)
        self.assertEqual(period["metricCurrent"], 4)
        after_metric = next(
            item for item in events if item["stage"] == "teacher_session_opt:after_metric"
        )
        self.assertEqual(after_metric["metricCurrent"], 3)

    def test_focus_goal_status_ignores_unowned_quality_dimensions(self) -> None:
        session_metrics = _payload(sessions=4, gap1=8, gap2=3)["metrics"]
        self.assertEqual(
            _optimization_focus_goal_status(
                "sessions",
                session_metrics,
                target_teacher_sessions=4,
                target_gap1_sessions=None,
                accept_teacher_sessions=5,
                accept_gap1_sessions=None,
            ),
            (True, True),
        )
        gap_metrics = _payload(sessions=9, singletons=2, gap1=1, gap2=0)["metrics"]
        self.assertEqual(
            _optimization_focus_goal_status(
                "gaps",
                gap_metrics,
                target_teacher_sessions=None,
                target_gap1_sessions=1,
                accept_teacher_sessions=None,
                accept_gap1_sessions=2,
            ),
            (True, True),
        )

    def test_quick_complete_goal_ignores_all_teacher_quality_metrics(self) -> None:
        clean_complete = _payload(sessions=5, singletons=0, gap1=2, gap2=3)["metrics"]
        singleton_debt = _payload(sessions=5, singletons=1, gap2=0)["metrics"]
        incomplete = dict(clean_complete, unassigned_periods=1)
        hard_invalid = dict(clean_complete, hard_ok=False)

        goal_args = {
            "target_teacher_sessions": 1,
            "target_gap1_sessions": 0,
            "accept_teacher_sessions": 1,
            "accept_gap1_sessions": 0,
        }
        self.assertEqual(
            _optimization_focus_goal_status(
                "quick_complete",
                clean_complete,
                **goal_args,
            ),
            (True, True),
        )
        self.assertEqual(
            _optimization_focus_goal_status(
                "quick_complete",
                singleton_debt,
                **goal_args,
            ),
            (True, True),
        )
        for metrics in (incomplete, hard_invalid):
            self.assertEqual(
                _optimization_focus_goal_status(
                    "quick_complete",
                    metrics,
                    **goal_args,
                ),
                (False, False),
            )

    def test_sessions_runtime_drops_gap_targets_and_deduplicates_warning(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _payload(sessions=5, gap1=2)
        candidate = _payload(sessions=4, gap1=3, gap2=1)

        with (
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={"lower_cap": 3, "start_cap": 4, "upper_cap": 10, "expected_periods": 4},
            ),
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=None),
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._solve_two_stage_concrete_refinement",
                return_value=(
                    candidate,
                    candidate["metrics"],
                    [{"phase": "two_stage_session_compression", "ok": True}],
                    "two_stage_session_compression",
                ),
            ),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "optimization_focus": "teacher_sessions",
                    "target_gap1_sessions": 0,
                    "optimization_accept_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 3,
                    "optimization_time_limit_seconds": 90,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertIsNone(optimization["target_gap1_sessions"])
        self.assertIsNone(optimization["accept_gap1_sessions"])
        self.assertFalse(optimization["target_met"])
        self.assertEqual(len(payload["warnings"]), 1)
        self.assertEqual(len(payload["validation"]["warnings"]), 1)
        self.assertEqual(payload["warnings"][0], payload["validation"]["warnings"][0])
        self.assertNotIn("gap=", payload["warnings"][0])

    def test_gaps_orchestration_failure_keeps_the_exact_incumbent_session_count(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _payload(sessions=5, gap1=2, gap2=1)

        with (
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={"lower_cap": 3, "start_cap": 4, "upper_cap": 10, "expected_periods": 4},
            ),
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=None),
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._solve_two_stage_concrete_refinement",
                side_effect=RuntimeError("focused gap orchestration failed"),
            ),
            patch("tkb_new.adapter._incremental_lns_profile") as legacy_profile,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "optimization_focus": "gaps",
                    "optimization_time_limit_seconds": 90,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        legacy_profile.assert_not_called()
        self.assertEqual(payload["metrics"]["teacher_sessions"], 5)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(
            optimization["termination_reason"],
            "focused_gaps_incumbent_after_orchestration_error",
        )
        attempt = next(
            item for item in optimization["attempts"]
            if item.get("phase") == "two_stage_orchestration"
        )
        self.assertEqual(attempt["fallback"], "incumbent_exact_session_lock")


if __name__ == "__main__":
    unittest.main()
