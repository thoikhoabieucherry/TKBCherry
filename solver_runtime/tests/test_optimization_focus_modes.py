"""Focused contract tests for the scheduler's quality modes."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ortools.sat.python import cp_model


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_new.adapter import (  # noqa: E402
    SolverDeadline,
    _add_gap2_plus_indicator,
    _attach_automatic_quality_repair_baseline,
    _automatic_quality_repair_baseline,
    _automatic_safe_stage_common,
    _automatic_refinement_phase_seed_sequence,
    _automatic_refinement_schedule_fingerprint,
    _cloud_run_gap2_zero_stop_requested,
    _focused_session_merge_candidate_better,
    _one_period_teacher_session_floor,
    _optimization_focus_goal_status,
    _optimization_metric_payload,
    _polish_complete_incumbent_with_local_lns,
    _settings_for_optimization_focus,
    _session_singleton_floor_proof,
    _singleton_repair_exploration_headroom,
    _singleton_repair_session_headroom,
    _solve_browser_external_cpsat_lns,
    _solve_teacher_session_optimized_from_ui_data,
    _solve_two_stage_concrete_refinement,
    _singleton_structural_lower_bound,
    _teacher_session_opt_quality_gates_clean,
    _two_stage_refinement_candidate_usable,
    _unified_first_click_candidate_acceptable,
    _validated_existing_soft_incumbent_payload,
    _with_one_period_teacher_session_floor,
    solve_from_ui_data,
)
from tkb_optimizer_ref.external_cp_sat import ExternalCpSatUnusableResponse  # noqa: E402
from tkb_optimizer_ref.models import Lesson  # noqa: E402


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
    def test_singleton_floor_requires_exact_global_cpsat_proof(self) -> None:
        payload = _payload(sessions=774, singletons=3, gap1=106, gap2=6)
        payload["solver"] = {
            "session_solver": {
                "status_name": "OPTIMAL",
                "objective_mode": "minimize_one_period_sessions",
                "objective": 3,
                "best_bound": 3,
                "max_teacher_sessions": 1464,
                "allow_unassigned": False,
                "minimize_one_period_sessions": True,
                "one_period_priority_absolute": True,
                "one_period_teacher_sessions": 3,
                "fixed_lessons": 360,
            }
        }

        proven = _session_singleton_floor_proof(
            payload,
            expected_upper_cap=1464,
            problem_fingerprint="a" * 64,
        )
        self.assertIsNotNone(proven)
        self.assertEqual(proven[0], 3)
        self.assertEqual(proven[1]["kind"], "cp_sat_global_singleton_optimum")

        for key, value in (
            ("status_name", "FEASIBLE"),
            ("objective", 4),
            ("best_bound", 2),
            ("objective_mode", "minimize_teacher_sessions"),
        ):
            with self.subTest(key=key):
                candidate = {
                    **payload,
                    "solver": {
                        "session_solver": {
                            **payload["solver"]["session_solver"],
                            key: value,
                        }
                    },
                }
                self.assertIsNone(
                    _session_singleton_floor_proof(
                        candidate,
                        expected_upper_cap=1464,
                        problem_fingerprint="a" * 64,
                    )
                )

    def test_automatic_repair_envelope_does_not_ratchet_across_clicks(self) -> None:
        incumbent = _payload(sessions=654, singletons=3, gap1=167, gap2=2)
        baseline = _automatic_quality_repair_baseline(
            incumbent,
            {},
            singleton_floor=0,
            problem_fingerprint="b" * 64,
        )
        first = _attach_automatic_quality_repair_baseline(incumbent, baseline)
        self.assertEqual(first["metrics"]["automatic_quality_repair_session_cap"], 678)
        second = _payload(sessions=678, singletons=2, gap1=170, gap2=1)
        second = _attach_automatic_quality_repair_baseline(second, baseline)
        carried = _automatic_quality_repair_baseline(
            second,
            {},
            singleton_floor=0,
            problem_fingerprint="b" * 64,
        )
        self.assertTrue(carried["carried"])
        self.assertEqual(carried["session_cap"], 678)
        over = _payload(sessions=702, singletons=1, gap1=170, gap2=0)
        self.assertFalse(_automatic_safe_stage_common(over, second))

    @staticmethod
    def _forced_singleton_data(*, teacher: str = "T1", class_id: str = "L1") -> dict:
        morning_off = {
            f"thu{day}|sang|{period}": True
            for day in range(2, 8)
            for period in range(5)
        }
        return {
            "lop": [{"id": class_id, "ten": f"6/{class_id[-1]}", "khoi": "6"}],
            "giaovien": [{"magv": teacher, "ten": teacher}],
            "monhoc": [{"ten": "History", "ma": "H"}],
            "mon": [
                {
                    "khoi": "6",
                    "ten": "History",
                    "sotiet": 3,
                    "gioihan": 2,
                }
            ],
            "pccmMatrix": {f"{class_id}|History": teacher},
            "pccmTietMatrix": {f"{class_id}|History": 3},
            "tkbConstraints": {
                "fixedOff": {"class": {class_id: morning_off}}
            },
        }

    def test_structural_singleton_floor_proves_three_period_two_plus_one(self) -> None:
        lower_bound, evidence = _singleton_structural_lower_bound(
            self._forced_singleton_data(),
            None,
        )

        self.assertEqual(lower_bound, 1)
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["teacher"], "T1")
        self.assertEqual(evidence[0]["periods_per_week"], 3)
        self.assertEqual(evidence[0]["max_periods_per_session"], 2)
        self.assertEqual(evidence[0]["forced_singletons"], 1)

    def test_structural_singleton_floor_adds_independent_teacher_components(self) -> None:
        first = self._forced_singleton_data(teacher="T1", class_id="L1")
        second = self._forced_singleton_data(teacher="T2", class_id="L2")
        data = {
            "lop": [*first["lop"], *second["lop"]],
            "giaovien": [*first["giaovien"], *second["giaovien"]],
            "monhoc": first["monhoc"],
            "mon": first["mon"],
            "pccmMatrix": {
                **first["pccmMatrix"],
                **second["pccmMatrix"],
            },
            "pccmTietMatrix": {
                **first["pccmTietMatrix"],
                **second["pccmTietMatrix"],
            },
            "tkbConstraints": {
                "fixedOff": {
                    "class": {
                        **first["tkbConstraints"]["fixedOff"]["class"],
                        **second["tkbConstraints"]["fixedOff"]["class"],
                    }
                }
            },
        }

        lower_bound, evidence = _singleton_structural_lower_bound(data, None)

        self.assertEqual(lower_bound, 2)
        self.assertEqual(len(evidence), 2)

    def test_singleton_floor_metadata_marks_proven_one_as_clean(self) -> None:
        evidence = [{"teacher": "T1", "periods_per_week": 3}]
        result = _with_one_period_teacher_session_floor(
            _payload(sessions=2, singletons=1, gap2=0),
            1,
            evidence,
        )
        metrics = result["metrics"]

        self.assertEqual(_one_period_teacher_session_floor(metrics), 1)
        self.assertTrue(metrics["one_period_teacher_sessions_lower_bound_reached"])
        self.assertTrue(_teacher_session_opt_quality_gates_clean(metrics))
        self.assertEqual(
            result["solver"]["one_period_teacher_sessions_quality_status"],
            "lower_bound_reached",
        )

    def test_singleton_without_proof_keeps_zero_target(self) -> None:
        metrics = _payload(sessions=2, singletons=1, gap2=0)["metrics"]

        self.assertEqual(_one_period_teacher_session_floor(metrics), 0)
        self.assertFalse(_teacher_session_opt_quality_gates_clean(metrics))

    def test_gap2_immediate_stop_is_executor_neutral_and_target_scoped(self) -> None:
        gap2 = {
            "optimization_focus": "gaps",
            "optimization_gap_target": "gap2",
        }
        self.assertTrue(_cloud_run_gap2_zero_stop_requested(gap2))
        self.assertFalse(
            _cloud_run_gap2_zero_stop_requested(
                {**gap2, "optimization_gap_target": "gap1"}
            )
        )
        self.assertFalse(
            _cloud_run_gap2_zero_stop_requested(
                {**gap2, "optimization_focus": "automatic"}
            )
        )
        with patch.dict(os.environ, {"K_SERVICE": ""}):
            self.assertTrue(_cloud_run_gap2_zero_stop_requested(gap2))

    def test_gap2_indicator_matches_internal_empty_period_count(self) -> None:
        cases = [
            ((0, 0, 0, 0), 0),
            ((1, 0, 1, 1), 0),
            ((1, 0, 0, 1), 1),
            ((1, 0, 0, 0, 1), 1),
        ]
        for bits, expected in cases:
            with self.subTest(bits=bits):
                model = cp_model.CpModel()
                occupancy = [
                    model.NewBoolVar(f"occ_{index}")
                    for index in range(len(bits))
                ]
                gap2 = _add_gap2_plus_indicator(model, occupancy, "gap2")
                for variable, value in zip(occupancy, bits, strict=True):
                    model.Add(variable == value)
                solver = cp_model.CpSolver()
                status = solver.Solve(model)
                self.assertIn(
                    status,
                    (cp_model.OPTIMAL, cp_model.FEASIBLE),
                )
                self.assertEqual(solver.Value(gap2), expected)

    @staticmethod
    def _revalidated_incumbent_data(*, fixed_pm_lesson: bool = False) -> dict:
        afternoon = ["Math", "Math", "", "", ""]
        if fixed_pm_lesson:
            afternoon[0] = {"mon": "Math", "fixed": True}
        return {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": ["Math", "Math", "", "", ""],
                        "chieu": afternoon,
                    }
                }
            },
            "tkbSolverResult": {
                "ok": True,
                "lessons": [
                    {
                        "className": "6/1",
                        "grade": "6",
                        "day": 2,
                        "session": "AM",
                        "period": period,
                        "subject": "Math",
                        "teacher": "T1",
                        "room": "",
                    }
                    for period in range(1, 5)
                ],
                "unassignedLessons": [],
            },
        }

    def test_revalidated_solver_result_wins_over_stale_materialized_grid(self) -> None:
        result = _validated_existing_soft_incumbent_payload(
            self._revalidated_incumbent_data(),
            {
                "ui_use_existing_complete_incumbent": True,
                "ui_existing_incumbent_revalidated": True,
            },
            rules=None,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["metrics"]["teacher_sessions"], 1)
        runtime = result["solver"]["runtime_settings"]
        self.assertEqual(runtime["incumbent_source"], "revalidated_solver_result")
        self.assertTrue(runtime["solver_result_revalidated"])

    def test_revalidated_solver_result_cannot_drop_a_user_fixed_lesson(self) -> None:
        result = _validated_existing_soft_incumbent_payload(
            self._revalidated_incumbent_data(fixed_pm_lesson=True),
            {
                "ui_use_existing_complete_incumbent": True,
                "ui_existing_incumbent_revalidated": True,
            },
            rules=None,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["metrics"]["teacher_sessions"], 2)
        runtime = result["solver"]["runtime_settings"]
        self.assertEqual(runtime["incumbent_source"], "tkb")
        self.assertFalse(runtime["solver_result_revalidated"])

    def test_two_stage_checkpoint_rejects_better_metrics_when_fixed_cell_moves(self) -> None:
        required = Lesson(
            class_name="6/1",
            grade="6",
            day=2,
            session="AM",
            period=1,
            subject="Math",
            teacher="T1",
            room="",
        )
        candidate = _payload(sessions=3, gap1=0)
        candidate["lessons"] = [
            {
                "className": "6/1",
                "grade": "6",
                "day": 2,
                "session": "AM",
                "period": 2,
                "subject": "Math",
                "teacher": "T1",
                "room": "",
            }
        ]

        self.assertFalse(
            _two_stage_refinement_candidate_usable(
                candidate,
                max_teacher_sessions=4,
                max_one_period_teacher_sessions=0,
                required_lessons=[required],
            )
        )
        candidate["lessons"][0]["period"] = 1
        self.assertTrue(
            _two_stage_refinement_candidate_usable(
                candidate,
                max_teacher_sessions=4,
                max_one_period_teacher_sessions=0,
                required_lessons=[required],
            )
        )

    def test_optional_external_lns_unknown_skips_only_that_pass(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        lesson = object()
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )
        with (
            patch("tkb_new.adapter._payload_lessons_to_lessons", return_value=[lesson]),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._lessons_without_fixed_instances",
                return_value=[lesson],
            ),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1],
            ),
            patch(
                "tkb_new.adapter._refinement_learning_from_payload",
                return_value={"version": 2, "school_signature": 1, "operators": {}},
            ),
            patch(
                "tkb_new.adapter._select_refinement_operator",
                return_value=("gap1", {}),
            ),
            patch(
                "tkb_new.adapter._refinement_operator_seed_classes",
                return_value=[],
            ),
            patch(
                "tkb_new.adapter._repair_one_period_affected_class_cluster",
                side_effect=ExternalCpSatUnusableResponse(0, "UNKNOWN"),
            ) as repair,
            patch("tkb_new.adapter._record_refinement_operator_attempt"),
        ):
            result = _polish_complete_incumbent_with_local_lns(
                {},
                {
                    "optimization_existing_local_quality_lns_passes": 1,
                    "optimization_existing_local_quality_lns_pass_seconds": 4,
                    "optimization_existing_local_quality_lns_stagnant_passes": 1,
                },
                context,
                incumbent,
                rules=None,
                polish_seeds=[1],
                time_limit_seconds=4,
            )

        self.assertIsNone(result)
        repair.assert_called_once()

    def test_browser_external_lns_publishes_only_restored_automatic_frontier(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        exploratory = _payload(sessions=4, gap1=5, gap2=1)
        cleaned = _payload(sessions=4, gap1=3)
        context = SimpleNamespace(school_data=object())

        with (
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=context),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1, 2, 3, 4],
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=[
                    (exploratory, [{"pass": 1, "improved": True}]),
                    (cleaned, [{"pass": 1, "improved": True}]),
                ],
            ) as polish,
        ):
            result = _solve_browser_external_cpsat_lns(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_time_limit_seconds": 30,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(30),
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["metrics"]["teacher_sessions"], 4)
        self.assertEqual(result["metrics"]["gap_distribution"].get(2, 0), 0)
        self.assertEqual(polish.call_count, 2)
        self.assertTrue(
            polish.call_args_list[0].kwargs[
                "focused_sessions_allow_gap2_debt"
            ]
        )
        runtime = result["solver"]["runtime_settings"]
        self.assertTrue(runtime["browser_external_cp_sat_lns"])

    def test_browser_external_automatic_reserves_three_deep_session_waves_and_final_cleanup(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        context = SimpleNamespace(school_data=object())

        with (
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=context),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1, 2, 3, 4],
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ) as polish,
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions",
                return_value=incumbent,
            ) as repack,
        ):
            result = _solve_browser_external_cpsat_lns(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_time_limit_seconds": 180,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
            )

        self.assertEqual(result["metrics"], incumbent["metrics"])
        repack.assert_not_called()
        calls = polish.call_args_list
        self.assertEqual(len(calls), 4)
        self.assertEqual(
            [bool(call.kwargs["focused_sessions"]) for call in calls],
            [True, True, True, False],
        )
        session_settings = [calls[index].args[1] for index in (0, 1, 2)]
        self.assertTrue(
            all(
                settings["optimization_existing_local_quality_lns_pass_seconds"]
                >= 8.0
                for settings in session_settings
            )
        )
        self.assertTrue(
            all(
                settings["optimization_existing_local_quality_lns_max_classes"] == 8
                and settings["optimization_existing_local_quality_lns_max_lessons"] == 340
                for settings in session_settings
            )
        )
        gap_settings = [calls[3].args[1]]
        self.assertTrue(
            all(
                settings["optimization_existing_local_quality_lns_max_classes"] == 10
                and settings["optimization_existing_local_quality_lns_max_lessons"] == 420
                for settings in gap_settings
            )
        )

    def test_browser_external_lns_hides_temporary_automatic_gap2_debt(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        exploratory = _payload(sessions=4, gap1=5, gap2=1)
        context = SimpleNamespace(school_data=object())

        with (
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=context),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1, 2, 3, 4],
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=[
                    (exploratory, [{"pass": 1, "improved": True}]),
                    None,
                ],
            ),
        ):
            result = _solve_browser_external_cpsat_lns(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_time_limit_seconds": 30,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(30),
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["metrics"]["teacher_sessions"], 5)
        self.assertEqual(result["metrics"]["gap_distribution"].get(2, 0), 0)
        attempts = result["solver"]["browser_external_cp_sat_lns"]["attempts"]
        self.assertTrue(attempts[0]["improved"])
        self.assertTrue(attempts[1]["retained_incumbent"])

    def test_browser_external_lns_repacks_gap2_before_local_gap1_cleanup(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        exploratory = _payload(sessions=4, gap1=5, gap2=2)
        repacked = _payload(sessions=4, gap1=3)
        cleaned = _payload(sessions=4, gap1=2)
        context = SimpleNamespace(school_data=object())
        order: list[str] = []
        polish_calls = 0

        def fake_polish(*_args, **kwargs):
            nonlocal polish_calls
            polish_calls += 1
            if polish_calls == 1:
                order.append("sessions")
                return exploratory, [{"pass": 1, "improved": True}]
            order.append("gap1")
            self.assertIs(_args[3], repacked)
            self.assertTrue(kwargs["focused_gap1"])
            self.assertEqual(kwargs["exact_teacher_sessions"], 4)
            return cleaned, [{"pass": 1, "improved": True}]

        def fake_repack(*_args, **kwargs):
            order.append("repack")
            self.assertIs(kwargs["incumbent_payload"], exploratory)
            return repacked

        with (
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=context),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1, 2, 3, 4],
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=fake_polish,
            ),
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions",
                side_effect=fake_repack,
            ),
        ):
            result = _solve_browser_external_cpsat_lns(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_time_limit_seconds": 30,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(30),
            )

        self.assertEqual(order, ["sessions", "repack", "gap1"])
        self.assertEqual(result["metrics"]["teacher_sessions"], 4)
        self.assertEqual(result["metrics"]["gap_distribution"].get(2, 0), 0)
        self.assertEqual(result["metrics"]["gap_distribution"].get(1, 0), 2)
        repack_meta = result["solver"]["browser_external_cp_sat_lns"]["attempts"][1][
            "period_repack"
        ]
        self.assertTrue(repack_meta["usable"])
        self.assertTrue(repack_meta["improved"])

    def test_browser_external_lns_rolls_back_when_repack_keeps_gap2_debt(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        exploratory = _payload(sessions=4, gap1=5, gap2=2)
        dirty_repack = _payload(sessions=4, gap1=1, gap2=1)
        context = SimpleNamespace(school_data=object())

        with (
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=context),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1, 2, 3, 4],
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=[
                    (exploratory, [{"pass": 1, "improved": True}]),
                    None,
                ],
            ),
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions",
                return_value=dirty_repack,
            ),
        ):
            result = _solve_browser_external_cpsat_lns(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_time_limit_seconds": 30,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(30),
            )

        self.assertEqual(result["metrics"], incumbent["metrics"])
        repack_meta = result["solver"]["browser_external_cp_sat_lns"]["attempts"][1][
            "period_repack"
        ]
        self.assertFalse(repack_meta["usable"])
        self.assertFalse(repack_meta["improved"])

    def test_browser_external_lns_retains_incumbent_on_unknown_neighborhood(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        context = SimpleNamespace(school_data=object())
        with (
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=context),
            patch(
                "tkb_new.adapter._school_refinement_seed_sequence",
                return_value=[1],
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=ExternalCpSatUnusableResponse(0, "UNKNOWN"),
            ),
        ):
            result = _solve_browser_external_cpsat_lns(
                {},
                {
                    "optimization_focus": "sessions",
                    "optimization_time_limit_seconds": 8,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(8),
            )

        self.assertEqual(result["metrics"], incumbent["metrics"])
        attempt = result["solver"]["browser_external_cp_sat_lns"]["attempts"][0]
        self.assertTrue(attempt["retained_incumbent"])
        self.assertIn("UNKNOWN", attempt["error"])

    def test_external_browser_complete_request_dispatches_to_lns_before_global_solver(self) -> None:
        expected = _payload(sessions=4, gap1=1)
        with patch(
            "tkb_new.adapter._solve_browser_external_cpsat_lns",
            return_value=expected,
        ) as browser_lns:
            result = solve_from_ui_data(
                {},
                {
                    "browser_wasm_external_cp_sat": True,
                    "ui_use_existing_complete_incumbent": True,
                    "ui_existing_incumbent_revalidated": True,
                    "overall_time_limit_seconds": 30,
                },
            )

        self.assertIs(result, expected)
        browser_lns.assert_called_once()

    def test_desktop_full_reference_refine_bypasses_compact_browser_lns(self) -> None:
        expected = _payload(sessions=3, gap1=1)
        with (
            patch(
                "tkb_new.adapter._solve_browser_external_cpsat_lns",
                side_effect=AssertionError("desktop heavy mode must not use compact LNS"),
            ) as browser_lns,
            patch(
                "tkb_new.adapter._solve_teacher_session_optimized_from_ui_data",
                return_value=expected,
            ) as full_reference,
        ):
            result = solve_from_ui_data(
                {},
                {
                    "browser_wasm_external_cp_sat": True,
                    "browser_wasm_full_reference_refine": True,
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "ui_existing_incumbent_revalidated": True,
                    "auto_sort_mode": "teacher_session_opt",
                    "overall_time_limit_seconds": 180,
                },
            )

        self.assertIs(result, expected)
        browser_lns.assert_not_called()
        full_reference.assert_called_once()

    def test_focused_session_checkpoint_requires_strict_valid_reduction(self) -> None:
        incumbent = _payload(sessions=5, gap1=1)["metrics"]
        gap_debt = _payload(sessions=4, gap1=4, gap2=2)["metrics"]
        self.assertFalse(
            _focused_session_merge_candidate_better(gap_debt, incumbent)
        )
        clean_reduction = _payload(sessions=4, gap1=1)["metrics"]
        self.assertTrue(
            _focused_session_merge_candidate_better(clean_reduction, incumbent)
        )

        regressions = {
            "same_sessions": _payload(sessions=5, gap1=0)["metrics"],
            "singleton": _payload(sessions=4, singletons=1, gap1=0)["metrics"],
            "incomplete": {
                **_payload(sessions=4)["metrics"],
                "scheduled_periods": 3,
            },
            "hard_invalid": {
                **_payload(sessions=4)["metrics"],
                "hard_ok": False,
            },
            "app_violation": {
                **_payload(sessions=4)["metrics"],
                "app_constraint_violation_count": 1,
            },
        }
        for label, candidate in regressions.items():
            with self.subTest(label=label):
                self.assertFalse(
                    _focused_session_merge_candidate_better(
                        candidate,
                        incumbent,
                    )
                )

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
        self.assertFalse(bridge_singletons["optimization_benders_minimize_hint_distance"])

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

        gap2 = _settings_for_optimization_focus(
            {
                "optimization_focus": "gaps",
                "optimization_gap_target": "gap2",
                "target_gap1_sessions": 7,
            }
        )
        self.assertEqual(gap2["optimization_gap_target"], "gap2")
        self.assertEqual(gap2["target_gap2_plus_sessions"], 0)
        self.assertNotIn("target_gap1_sessions", gap2)

        gap1 = _settings_for_optimization_focus(
            {
                "optimization_focus": "gaps",
                "optimization_gap_target": "gap1",
            }
        )
        self.assertEqual(gap1["optimization_gap_target"], "gap1")
        self.assertEqual(gap1["target_gap1_sessions"], 0)
        self.assertNotIn("target_gap2_plus_sessions", gap1)
        self.assertFalse(gap1["optimization_benders_minimize_hint_distance"])

        automatic = _settings_for_optimization_focus(
            {
                "optimization_focus": "automatic",
                "optimization_gap_target": "gap2",
            }
        )
        self.assertEqual(automatic["optimization_focus"], "automatic")
        self.assertNotIn("optimization_gap_target", automatic)

        replayed_automatic = _settings_for_optimization_focus(
            {
                "optimization_focus": "automatic",
                "optimization_focused_objective_only": True,
                "quality_priority_order": "focused_gap1_only",
                "target_gap1_sessions": 0,
                "optimization_benders_minimize_period_gaps": True,
                "optimization_benders_minimize_hint_distance": False,
            }
        )
        self.assertNotIn("optimization_focused_objective_only", replayed_automatic)
        self.assertNotIn("quality_priority_order", replayed_automatic)
        self.assertNotIn("target_gap1_sessions", replayed_automatic)
        self.assertNotIn("optimization_benders_minimize_period_gaps", replayed_automatic)
        self.assertNotIn("optimization_benders_minimize_hint_distance", replayed_automatic)

        authored_automatic = _settings_for_optimization_focus(
            {
                "optimization_focus": "automatic",
                "target_teacher_sessions": 7,
            }
        )
        self.assertEqual(authored_automatic["target_teacher_sessions"], 7)

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
        self.assertEqual(sessions["solveRequestMode"], "optimize_sessions")

        gaps = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 5, 2: 4}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gaps",
        )
        self.assertEqual(gaps["optimizationFocus"], "teacher_gap_sessions")
        self.assertEqual(gaps["solveRequestMode"], "optimize_gaps")
        self.assertEqual(gaps["metricCurrent"], 9)
        self.assertEqual(gaps["metricBaseline"], 9)
        self.assertEqual(gaps["metricPercent"], 0.0)
        self.assertLessEqual(gaps["metricPercent"], 100.0)

        gap2_improved = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 5, 2: 2}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gaps",
        )
        self.assertEqual(gap2_improved["optimizationFocus"], "teacher_gap_sessions")
        self.assertEqual(gap2_improved["metricCurrent"], 7)
        self.assertEqual(gap2_improved["metricPercent"], 22.2)

        gap1 = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 3}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gaps",
        )
        self.assertEqual(gap1["optimizationFocus"], "teacher_gap_sessions")
        self.assertEqual(gap1["metricCurrent"], 3)
        self.assertEqual(gap1["metricBaseline"], 9)
        self.assertEqual(gap1["metricPercent"], 66.7)

        gap1_only = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 3}},
            baseline_metrics={"gap_distribution": {1: 5}},
            metric_kind="gaps",
        )
        self.assertEqual(gap1_only["optimizationFocus"], "teacher_gap_sessions")
        self.assertEqual(gap1_only["metricPercent"], 40.0)

        automatic = _optimization_metric_payload(
            "automatic",
            {"teacher_sessions": 470},
            session_target=432,
            metric_kind="sessions",
        )
        self.assertEqual(automatic["solveRequestMode"], "automatic")

        gap2 = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 5, 2: 2}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gap2",
        )
        self.assertEqual(gap2["solveRequestMode"], "optimize_gap2")
        self.assertEqual(gap2["optimizationFocus"], "teacher_gap2_sessions")
        self.assertEqual(gap2["metricCurrent"], 2)
        self.assertEqual(gap2["metricBaseline"], 4)
        self.assertEqual(gap2["metricPercent"], 50.0)

        gap1 = _optimization_metric_payload(
            "gaps",
            {"gap_distribution": {1: 3, 2: 0}},
            baseline_metrics={"gap_distribution": {1: 5, 2: 4}},
            metric_kind="gap1",
        )
        self.assertEqual(gap1["solveRequestMode"], "optimize_gap1")
        self.assertEqual(gap1["optimizationFocus"], "teacher_gap1_sessions")
        self.assertEqual(gap1["metricCurrent"], 3)
        self.assertEqual(gap1["metricBaseline"], 5)
        self.assertEqual(gap1["metricPercent"], 40.0)

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
        candidate = _payload(sessions=4, gap1=2)
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
        candidate = _payload(sessions=4, gap1=2)
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
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertTrue(
            result["solver"]["session_solver"]["best_effort_stop_applied"]
        )

    def test_sessions_focus_uses_the_incumbent_singleton_cap_directly(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        relaxed = _payload(sessions=4, singletons=1, gap1=2)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
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

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["settings"]["max_one_period_sessions"], 1)
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertFalse(attempts[0]["incumbent_singleton_fallback"]["attempted"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "session_compression",
        )

    def test_sessions_focus_runs_forced_cluster_prepass_before_global_phase(self) -> None:
        incumbent = _payload(sessions=5, gap1=1)
        local = _payload(sessions=4, gap1=1)
        global_candidate = _payload(sessions=3, gap1=1)
        order: list[str] = []
        benders_calls: list[dict] = []
        progress_events: list[dict] = []

        def fake_local(_data, local_settings, _ctx, _incumbent, **kwargs):
            order.append("local")
            self.assertTrue(kwargs["focused_sessions"])
            self.assertEqual(
                local_settings[
                    "optimization_existing_local_quality_lns_passes"
                ],
                8,
            )
            self.assertEqual(
                local_settings[
                    "optimization_existing_local_quality_lns_max_classes"
                ],
                10,
            )
            kwargs["progress"](
                {
                    "stage": "teacher_session_opt:phase_sessions_local_checkpoint",
                    "teacher_sessions": 4,
                    "one_period_teacher_sessions": 0,
                    "gap_distribution": {1: 1, 2: 0},
                }
            )
            return local, [{"pass": 1, "improved": True}]

        def fake_benders(_data, call_settings, **kwargs):
            order.append("global")
            benders_calls.append({"settings": dict(call_settings), **kwargs})
            return global_candidate

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=object(),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=fake_local,
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=progress_events.append,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(order, ["local", "global"])
        self.assertIs(benders_calls[0]["incumbent_payload"], local)
        self.assertEqual(benders_calls[0]["cap"], 4)
        self.assertEqual(metrics["teacher_sessions"], 3)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(reason, "two_stage_session_compression")
        local_meta = attempts[0]["local_session_merge_search"]
        self.assertTrue(local_meta["eligible"])
        self.assertEqual(local_meta["time_limit_seconds"], 38)
        self.assertTrue(local_meta["usable"])
        self.assertTrue(local_meta["improved"])
        self.assertEqual(local_meta["forced_operator"], "session_merge")
        self.assertEqual(local_meta["passes"], [{"pass": 1, "improved": True}])
        checkpoints = [
            item
            for item in progress_events
            if item.get("stage")
            == "teacher_session_opt:phase_sessions_local_checkpoint"
        ]
        self.assertEqual(len(checkpoints), 1)
        self.assertEqual(checkpoints[0]["metricCurrent"], 4)
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "session_compression",
        )

    def test_sessions_focus_keeps_strict_local_result_when_global_fails(self) -> None:
        incumbent = _payload(sessions=5, gap1=1)
        local = _payload(sessions=4, gap1=1)
        calls: list[dict] = []

        def failed_global(_data, _settings, **kwargs):
            calls.append(kwargs)
            raise RuntimeError("global timeout")

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=object(),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(local, [{"pass": 1, "improved": True}]),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=failed_global,
            ),
        ):
            _result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertIs(calls[0]["incumbent_payload"], local)
        self.assertEqual(calls[0]["cap"], 4)
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertTrue(attempts[0]["local_session_merge_search"]["improved"])

    def test_sessions_focus_rejects_regressive_local_result_before_global_phase(self) -> None:
        incumbent = _payload(sessions=5, gap1=1)
        singleton_regression = _payload(sessions=4, singletons=1, gap1=0)
        global_calls: list[dict] = []

        def failed_global(_data, _settings, **kwargs):
            global_calls.append(kwargs)
            raise RuntimeError("global timeout")

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=object(),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(
                    singleton_regression,
                    [{"pass": 1, "improved": True}],
                ),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=failed_global,
            ),
        ):
            _result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {"optimization_focus": "sessions"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertIs(global_calls[0]["incumbent_payload"], incumbent)
        self.assertEqual(global_calls[0]["cap"], 5)
        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(reason, "two_stage_incumbent")
        self.assertFalse(attempts[0]["local_session_merge_search"]["usable"])
        self.assertFalse(attempts[0]["local_session_merge_search"]["improved"])

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

    def test_safe_staged_automatic_hard_fences_then_owns_gap1(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        phase_s = _payload(sessions=4, gap1=4)
        phase_g = _payload(sessions=4, gap1=2)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return phase_s if len(calls) == 1 else phase_g

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(len(calls), 2)
        phase_s_settings = calls[0]["settings"]
        self.assertTrue(phase_s_settings["optimization_benders_minimize_teacher_sessions"])
        self.assertFalse(phase_s_settings["optimization_benders_minimize_period_gaps"])
        self.assertEqual(phase_s_settings["max_one_period_sessions"], 0)
        self.assertEqual(
            phase_s_settings["optimization_benders_max_teacher_gap2_plus_sessions"],
            0,
        )
        self.assertEqual(
            phase_s_settings["optimization_benders_max_teacher_gap1_sessions"],
            4,
        )
        self.assertEqual(phase_s_settings["period_max_teacher_gap"], 1)

        phase_g_settings = calls[1]["settings"]
        self.assertTrue(phase_g_settings["optimization_benders_lock_teacher_sessions"])
        self.assertTrue(phase_g_settings["optimization_benders_minimize_period_gaps"])
        self.assertEqual(
            phase_g_settings["optimization_benders_gap_objective_target"],
            "gap1",
        )
        self.assertEqual(
            phase_g_settings["optimization_benders_max_teacher_gap2_plus_sessions"],
            0,
        )
        self.assertEqual(calls[1]["cap"], 4)
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["mode"], "safe_staged_sessions_then_gap1")
        self.assertEqual(metadata["status"], "improved")
        self.assertTrue(metadata["phase_f_skipped"])
        self.assertEqual(metadata["stage_order"], ["teacher_sessions", "gap1"])
        history_entry = metadata["automatic_refinement_history"]["entries"][-1]
        self.assertEqual(history_entry["round"], 1)
        self.assertEqual(history_entry["phase_seeds"], [101, 202])
        self.assertEqual(history_entry["status"], "improved")

    def test_even_safe_staged_automatic_uses_gap1_only_continuation(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        phase_g = _payload(sessions=5, gap1=2)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return phase_g

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": False,
                    "optimization_refinement_round": 2,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(len(calls), 1)
        gap_settings = calls[0]["settings"]
        self.assertTrue(gap_settings["optimization_benders_lock_teacher_sessions"])
        self.assertTrue(gap_settings["optimization_benders_minimize_period_gaps"])
        self.assertEqual(
            gap_settings["optimization_benders_gap_objective_target"],
            "gap1",
        )
        self.assertEqual(calls[0]["cap"], 5)
        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(attempts[0]["skipped"])
        self.assertEqual(attempts[0]["reason"], "alternating_gap1_continuation")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertTrue(metadata["automatic_gap1_only_round"])
        self.assertEqual(metadata["optimization_refinement_round"], 2)
        self.assertEqual(metadata["final_reserve_seconds"], 8)
        self.assertEqual(metadata["selected_phase"], "gap_cleanup")

    def test_automatic_repairs_singletons_locally_before_global_phase(self) -> None:
        incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=667, singletons=3, gap1=171),
            0,
            [],
        )
        local_candidate = _with_one_period_teacher_session_floor(
            _payload(sessions=667, singletons=0, gap1=171),
            0,
            [],
        )
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(local_candidate, [{"improved": True}]),
            ) as local_repair,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=RuntimeError("global phase plateau"),
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": False,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        local_repair.assert_called_once()
        self.assertTrue(local_repair.call_args.kwargs["focused_singletons"])
        self.assertTrue(local_repair.call_args.kwargs["exploratory_singletons"])
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["teacher_sessions"], 667)
        self.assertEqual(metrics["gap_distribution"][1], 171)
        self.assertEqual(reason, "two_stage_singleton_local_cleanup")
        local_attempt = next(
            item
            for item in attempts
            if item.get("phase") == "automatic_singleton_local_cleanup"
        )
        self.assertTrue(local_attempt["improved"])
        self.assertTrue(local_attempt["reached_floor"])
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["selected_phase"], "singleton_local_cleanup")
        self.assertEqual(metadata["status"], "improved")

    def test_even_round_stays_gap1_only_after_gap1_clean_cycle_gain(self) -> None:
        incumbent = _payload(sessions=655, gap1=156)
        cycle_candidate = _payload(sessions=655, gap1=154)
        phase_g = _payload(sessions=655, gap1=151)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return phase_g

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._clean_quality_cycle_candidate",
                return_value=(
                    cycle_candidate,
                    {
                        "accepted_moves": 1,
                        "stop_reason": "no_candidates",
                        "stopped_on_plateau": True,
                    },
                ),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": True,
                    "optimization_clean_quality_cycles_early_return": False,
                    "optimization_refinement_round": 2,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["settings"]["optimization_benders_lock_teacher_sessions"])
        self.assertTrue(calls[0]["settings"]["optimization_benders_minimize_period_gaps"])
        self.assertEqual(calls[0]["cap"], 655)
        self.assertEqual(metrics["teacher_sessions"], 655)
        self.assertEqual(metrics["gap_distribution"][1], 151)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(attempts[0]["skipped"])
        self.assertEqual(attempts[0]["reason"], "alternating_gap1_continuation")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertTrue(metadata["automatic_gap1_only_round"])
        self.assertEqual(metadata["selected_phase"], "gap_cleanup")

    def test_clean_cycle_plateau_spends_remaining_click_on_gap1(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        cycle_candidate = _payload(sessions=4, gap1=3)
        phase_g = _payload(sessions=4, gap1=2)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return phase_g

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._clean_quality_cycle_candidate",
                return_value=(
                    cycle_candidate,
                    {
                        "accepted_moves": 1,
                        "stop_reason": "no_candidates",
                        "stopped_on_plateau": True,
                    },
                ),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": True,
                    "optimization_clean_quality_cycles_early_return": False,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["settings"]["optimization_benders_lock_teacher_sessions"])
        self.assertEqual(calls[0]["cap"], 4)
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertTrue(attempts[0]["skipped"])
        self.assertEqual(attempts[0]["reason"], "clean_cycle_gap1_continuation")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertTrue(metadata["automatic_gap1_only_round"])
        self.assertTrue(metadata["clean_cycle_gap1_continuation"])
        self.assertTrue(metadata["clean_cycle_reduced_sessions"])
        self.assertTrue(metadata["clean_cycle_stopped_on_plateau"])
        self.assertEqual(metadata["selected_phase"], "gap_cleanup")

    def test_gap1_only_clean_cycle_does_not_skip_session_phase(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        cycle_candidate = _payload(sessions=5, gap1=3)
        phase_s = _payload(sessions=4, gap1=3)
        phase_g = _payload(sessions=4, gap1=2)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return phase_s if len(calls) == 1 else phase_g

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._clean_quality_cycle_candidate",
                return_value=(
                    cycle_candidate,
                    {
                        "accepted_moves": 1,
                        "stop_reason": "no_candidates",
                        "stopped_on_plateau": True,
                    },
                ),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": True,
                    "optimization_clean_quality_cycles_early_return": False,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(60),
                total_limit=60,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(len(calls), 2)
        self.assertFalse(attempts[0].get("skipped", False))
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertFalse(metadata["automatic_gap1_only_round"])
        self.assertFalse(metadata["clean_cycle_gap1_continuation"])
        self.assertFalse(metadata["clean_cycle_reduced_sessions"])
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")

    def test_safe_staged_clean_cycle_survives_later_cp_sat_plateau(self) -> None:
        incumbent = _payload(sessions=5, gap1=3)
        cycle_candidate = _payload(sessions=4, gap1=2)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )
        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._clean_quality_cycle_candidate",
                return_value=(
                    cycle_candidate,
                    {
                        "accepted": True,
                        "accepted_moves": 1,
                        "history": [{"accepted": True}],
                    },
                ),
            ) as clean_cycles,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=RuntimeError("later CP-SAT plateau"),
            ),
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": True,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(30),
                total_limit=30,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        clean_cycles.assert_called_once()
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_clean_quality_cycles")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["selected_phase"], "clean_quality_cycles")
        self.assertEqual(metadata["status"], "improved")
        cycle_details = metadata["clean_quality_cycles"]["details"]
        self.assertEqual(cycle_details["accepted_moves"], 1)
        self.assertNotIn("history", cycle_details)

    def test_safe_staged_automatic_uses_bounded_session_headroom_for_hard_debt(self) -> None:
        incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=654, singletons=1, gap1=167),
            0,
            [],
        )
        singleton_repaired = _payload(sessions=662, singletons=0, gap1=170)
        gap1_polished = _payload(sessions=662, singletons=0, gap1=165)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if call_settings.get("optimization_benders_minimize_period_gaps"):
                return gap1_polished
            if (
                call_settings.get("optimization_benders_max_teacher_gap1_sessions")
                > 167
                and call_settings.get(
                    "optimization_benders_max_teacher_gap2_plus_sessions"
                )
                == 0
                and call_settings.get("max_one_period_sessions") == "off"
                and call_settings.get(
                    "optimization_benders_minimize_one_period_sessions"
                )
            ):
                return singleton_repaired
            raise RuntimeError("strict monotone attempt cannot create the repair")

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 2,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(300),
                total_limit=300,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        # The holistic hard-debt lane can now use its first global phase for the
        # bounded repair directly; the old one-step + retry sequence made four
        # redundant model calls.
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["cap"], 678)
        self.assertEqual(calls[0]["settings"]["max_one_period_sessions"], "off")
        self.assertFalse(
            calls[0]["settings"]["optimization_benders_session_feasibility_only"]
        )
        self.assertTrue(
            calls[0]["settings"]["optimization_benders_minimize_teacher_sessions"]
        )
        self.assertTrue(
            calls[0]["settings"]["optimization_benders_minimize_one_period_sessions"]
        )
        repair_call = calls[0]
        self.assertEqual(repair_call["cap"], 678)
        self.assertEqual(
            repair_call["settings"][
                "optimization_benders_max_teacher_gap1_sessions"
            ],
            184,
        )
        self.assertEqual(
            repair_call["settings"][
                "optimization_benders_max_teacher_gap2_plus_sessions"
            ],
            0,
        )
        self.assertEqual(repair_call["settings"]["max_one_period_sessions"], "off")
        self.assertEqual(calls[1]["cap"], 662)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["teacher_sessions"], 662)
        self.assertEqual(metrics["gap_distribution"][1], 165)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["status"],
            "improved",
        )

    def test_singleton_repair_session_headroom_is_small_and_bounded(self) -> None:
        self.assertEqual(_singleton_repair_session_headroom({}, 100), 8)
        self.assertEqual(_singleton_repair_session_headroom({}, 654), 24)
        self.assertEqual(_singleton_repair_session_headroom({}, 2_000), 24)
        self.assertEqual(
            _singleton_repair_session_headroom(
                {"optimization_singleton_repair_session_headroom": 100},
                654,
            ),
            24,
        )
        self.assertEqual(
            _singleton_repair_exploration_headroom(
                {"optimization_refinement_round": 1},
                654,
            ),
            24,
        )
        self.assertEqual(
            _singleton_repair_exploration_headroom(
                {"optimization_refinement_round": 2},
                654,
            ),
            24,
        )

    def test_safe_stage_rejects_unbounded_lower_priority_debt_for_hard_repair(self) -> None:
        incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=654, singletons=1, gap1=167),
            0,
            [],
        )
        bounded = _payload(sessions=662, singletons=0, gap1=170)
        too_many_sessions = _payload(sessions=679, singletons=0, gap1=170)
        too_many_gaps = _payload(sessions=662, singletons=0, gap1=192)

        self.assertTrue(_automatic_safe_stage_common(bounded["metrics"], incumbent["metrics"]))
        self.assertFalse(
            _automatic_safe_stage_common(too_many_sessions["metrics"], incumbent["metrics"])
        )
        self.assertFalse(
            _automatic_safe_stage_common(too_many_gaps["metrics"], incumbent["metrics"])
        )

    def test_safe_stage_keeps_progressive_singleton_and_gap2_reduction(self) -> None:
        singleton_incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=654, singletons=3, gap1=167),
            0,
            [],
        )
        singleton_step = _payload(sessions=654, singletons=2, gap1=167)
        singleton_bounded_tradeoff = _payload(sessions=656, singletons=2, gap1=168)
        singleton_unbounded_tradeoff = _payload(sessions=679, singletons=2, gap1=168)
        singleton_stall = _payload(sessions=654, singletons=3, gap1=167)
        self.assertTrue(
            _automatic_safe_stage_common(
                singleton_step["metrics"], singleton_incumbent["metrics"]
            )
        )
        self.assertFalse(
            _automatic_safe_stage_common(
                singleton_stall["metrics"], singleton_incumbent["metrics"]
            )
        )
        self.assertTrue(
            _automatic_safe_stage_common(
                singleton_bounded_tradeoff["metrics"], singleton_incumbent["metrics"]
            )
        )
        self.assertFalse(
            _automatic_safe_stage_common(
                singleton_unbounded_tradeoff["metrics"], singleton_incumbent["metrics"]
            )
        )

        gap2_incumbent = _payload(sessions=654, singletons=0, gap1=167, gap2=3)
        gap2_step = _payload(sessions=654, singletons=0, gap1=167, gap2=2)
        gap2_stall = _payload(sessions=654, singletons=0, gap1=167, gap2=3)
        self.assertTrue(
            _automatic_safe_stage_common(
                gap2_step["metrics"], gap2_incumbent["metrics"]
            )
        )
        self.assertFalse(
            _automatic_safe_stage_common(
                gap2_stall["metrics"], gap2_incumbent["metrics"]
            )
        )

    def test_safe_staged_automatic_uses_reachable_progressive_gap2_cap(self) -> None:
        incumbent = _payload(sessions=654, singletons=0, gap1=167, gap2=3)
        partial = _payload(sessions=654, singletons=0, gap1=167, gap2=2)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=[partial, RuntimeError("retry plateau")],
            ) as benders,
        ):
            _result, metrics, _attempts, _reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": False,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202, 303],
            )

        first_settings = benders.call_args_list[0].args[1]
        self.assertEqual(
            first_settings["optimization_benders_max_teacher_gap2_plus_sessions"],
            3,
        )
        self.assertEqual(first_settings["period_max_teacher_gap"], "off")
        self.assertEqual(first_settings["max_one_period_sessions"], "off")
        self.assertFalse(
            first_settings["optimization_benders_session_feasibility_only"]
        )
        self.assertTrue(
            first_settings["optimization_benders_minimize_teacher_sessions"]
        )
        self.assertTrue(
            first_settings["optimization_benders_minimize_one_period_sessions"]
        )
        self.assertEqual(metrics["gap_distribution"][2], 2)

    def test_singleton_local_keeps_best_candidate_with_equal_hard_debt(self) -> None:
        incumbent = _payload(sessions=654, singletons=3, gap1=167)
        first_partial = _payload(sessions=654, singletons=2, gap1=167)
        better_partial = _payload(sessions=653, singletons=2, gap1=167)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=[
                    (first_partial, [{"improved": True}]),
                    (better_partial, [{"improved": True}]),
                    None,
                    None,
                    None,
                ],
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=RuntimeError("global phase plateau"),
            ),
        ):
            result, metrics, attempts, _reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": False,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(metrics["one_period_teacher_sessions"], 2)
        self.assertEqual(metrics["teacher_sessions"], 653)
        local_attempt = next(
            item
            for item in attempts
            if item.get("phase") == "automatic_singleton_local_cleanup"
        )
        self.assertTrue(local_attempt["partial_improvement"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "singleton_local_cleanup",
        )

    def test_hard_debt_retry_never_replaces_a_better_progressive_candidate(self) -> None:
        incumbent = _payload(sessions=654, singletons=0, gap1=167, gap2=3)
        better_partial = _payload(sessions=654, singletons=0, gap1=167, gap2=1)
        worse_retry = _payload(sessions=653, singletons=0, gap1=167, gap2=2)
        context = SimpleNamespace(
            school_data=SimpleNamespace(assignments=[]),
            rules=None,
            warnings=[],
        )

        with (
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=context,
            ),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([], []),
            ),
            patch(
                "tkb_new.adapter._singleton_structural_lower_bound",
                return_value=(0, []),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=[better_partial, worse_retry],
            ),
        ):
            _result, metrics, attempts, _reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_clean_quality_cycles": False,
                    "optimization_refinement_round": 1,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202, 303],
            )

        self.assertEqual(metrics["gap_distribution"][2], 1)
        self.assertEqual(metrics["teacher_sessions"], 654)
        phase_s_attempt = next(
            item
            for item in attempts
            if item.get("phase") == "two_stage_session_compression"
        )
        self.assertTrue(phase_s_attempt["improved"])
        self.assertFalse(phase_s_attempt["hard_debt_retry"]["attempted"])
        self.assertFalse(phase_s_attempt["hard_debt_retry"]["improved"])

    def test_safe_staged_automatic_keeps_bounded_hard_repair_when_gap_phase_fails(self) -> None:
        incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=654, singletons=1, gap1=167),
            0,
            [],
        )
        singleton_repaired = _payload(sessions=662, singletons=0, gap1=170)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                singleton_repaired,
                RuntimeError("no remaining Gap1 refinement time"),
            ],
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 2,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(300),
                total_limit=300,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["teacher_sessions"], 662)
        self.assertEqual(metrics["gap_distribution"][1], 170)
        self.assertEqual(reason, "two_stage_session_compression")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["selected_phase"], "session_compression")
        self.assertEqual(metadata["status"], "improved")

    def test_safe_staged_automatic_keeps_bounded_gap2_repair_when_gap1_phase_fails(self) -> None:
        incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=654, singletons=0, gap1=167, gap2=1),
            0,
            [],
        )
        gap2_repaired = _payload(sessions=662, singletons=0, gap1=170, gap2=0)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                gap2_repaired,
                RuntimeError("no remaining Gap1 refinement time"),
            ],
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 2,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(300),
                total_limit=300,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["teacher_sessions"], 662)
        self.assertEqual(reason, "two_stage_session_compression")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["selected_phase"], "session_compression")
        self.assertEqual(metadata["status"], "improved")

    def test_safe_staged_automatic_rejects_unbounded_hard_repair_at_final_selection(self) -> None:
        incumbent = _with_one_period_teacher_session_floor(
            _payload(sessions=654, singletons=1, gap1=167),
            0,
            [],
        )
        unbounded = _payload(sessions=1_000, singletons=0, gap1=170)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=unbounded,
        ):
            result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 2,
                    "random_seed": 17,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(300),
                total_limit=300,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(metrics, incumbent["metrics"])
        self.assertEqual(reason, "safe_staged_no_improvement")
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "incumbent",
        )

    def test_safe_staged_automatic_retains_incumbent_on_gap1_regression(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)
        regressive_phase_s = _payload(sessions=4, gap1=5)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[regressive_phase_s, RuntimeError("no safe Gap1 candidate")],
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 3,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(180),
                total_limit=180,
                incumbent_payload=incumbent,
                phase_seeds=[303, 404],
            )

        self.assertEqual(metrics, incumbent["metrics"])
        self.assertEqual(reason, "safe_staged_no_improvement")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["selected_phase"], "incumbent")
        self.assertEqual(metadata["status"], "no_improvement")
        self.assertTrue(metadata["phase_f_skipped"])
        self.assertEqual(attempts[-1]["phase"], "safe_staged_no_improvement")
        self.assertTrue(attempts[-1]["retained_incumbent"])
        history_entry = metadata["automatic_refinement_history"]["entries"][-1]
        self.assertEqual(history_entry["status"], "no_improvement")
        self.assertEqual(
            history_entry["input_fingerprint"],
            history_entry["output_fingerprint"],
        )

    def test_safe_staged_exhausted_before_gap_phase_keeps_metadata_defined(self) -> None:
        incumbent = _payload(sessions=5, gap1=4)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=RuntimeError("deadline exhausted"),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_refinement_round": 2,
                },
                rules=None,
                progress=None,
                deadline=SolverDeadline(0.001),
                total_limit=30,
                incumbent_payload=incumbent,
                phase_seeds=[101, 202],
            )

        self.assertEqual(metrics, incumbent["metrics"])
        self.assertEqual(reason, "safe_staged_no_improvement")
        metadata = result["solver"]["two_stage_teacher_optimization"]
        self.assertEqual(metadata["status"], "no_improvement")
        self.assertTrue(metadata["phase_f_skipped"])
        gap_attempt = next(
            attempt for attempt in attempts if attempt["phase"] == "two_stage_gap_cleanup"
        )
        self.assertEqual(gap_attempt["local_gap1_search"]["max_teacher_sessions"], 5)
        self.assertEqual(gap_attempt["local_gap1_search"]["global_tail_reserve_seconds"], 18)

    def test_safe_staged_seed_history_skips_failed_same_incumbent_trajectory(self) -> None:
        school = SimpleNamespace(classes=[], teachers=[], assignments=[])
        incumbent = _payload(sessions=5, gap1=4)
        settings = {
            "optimization_refinement_round": 1,
            "random_seed": 17,
            "quality_variant_seed": 17,
        }
        first = _automatic_refinement_phase_seed_sequence(
            school,
            settings,
            incumbent,
            4,
        )
        fingerprint = _automatic_refinement_schedule_fingerprint(incumbent)
        incumbent["solver"] = {
            "runtime_settings": {
                "automatic_refinement_history": {
                    "version": 1,
                    "entries": [
                        {
                            "round": 1,
                            "request_seed": 17,
                            "phase_seeds": first,
                            "input_fingerprint": fingerprint,
                            "output_fingerprint": fingerprint,
                            "status": "no_improvement",
                            "selected_phase": "incumbent",
                        }
                    ],
                }
            }
        }
        repeated = _automatic_refinement_phase_seed_sequence(
            school,
            settings,
            incumbent,
            4,
        )

        self.assertEqual(len(first), 4)
        self.assertEqual(len(repeated), 4)
        self.assertTrue(set(first).isdisjoint(repeated))

    def test_safe_staged_short_reclick_routes_directly_without_phase_f(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _payload(sessions=5, gap1=4)

        with (
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 3,
                    "start_cap": 4,
                    "upper_cap": 10,
                    "expected_periods": 4,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value=None,
            ),
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch(
                "tkb_new.adapter._automatic_refinement_phase_seed_sequence",
                return_value=[101, 202, 303, 404],
            ),
            patch(
                "tkb_new.adapter._solve_two_stage_concrete_refinement",
                return_value=(
                    incumbent,
                    incumbent["metrics"],
                    [],
                    "two_stage_incumbent",
                ),
            ) as two_stage,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=AssertionError("Phase F/global portfolio must not run"),
            ) as phase_f,
        ):
            result = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_two_stage_teacher_quality": True,
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "optimization_time_limit_seconds": 30,
                    "optimization_adaptive_time_limit_seconds": 30,
                    "optimization_refinement_round": 2,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(result["metrics"]["teacher_sessions"], 5)
        two_stage.assert_called_once()
        self.assertEqual(two_stage.call_args.kwargs["phase_seeds"], [101, 202, 303, 404])
        phase_f.assert_not_called()

    def test_safe_staged_reclick_failure_returns_incumbent_without_phase_f(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _payload(sessions=5, gap1=4)

        with (
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 3,
                    "start_cap": 4,
                    "upper_cap": 10,
                    "expected_periods": 4,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value=None,
            ),
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch(
                "tkb_new.adapter._automatic_refinement_phase_seed_sequence",
                return_value=[101, 202, 303, 404],
            ),
            patch(
                "tkb_new.adapter._solve_two_stage_concrete_refinement",
                side_effect=RuntimeError("safe staged orchestration failed"),
            ) as two_stage,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=AssertionError("Phase F/global portfolio must not run"),
            ) as phase_f,
        ):
            result = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "optimization_focus": "automatic",
                    "optimization_safe_staged_reclick": True,
                    "optimization_two_stage_teacher_quality": True,
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "optimization_time_limit_seconds": 30,
                    "optimization_adaptive_time_limit_seconds": 30,
                    "optimization_refinement_round": 2,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(result["metrics"]["teacher_sessions"], 5)
        self.assertEqual(result["metrics"]["gap_distribution"][1], 4)
        self.assertEqual(
            result["solver"]["runtime_settings"]["optimization_termination_reason"],
            "safe_staged_no_improvement",
        )
        two_stage.assert_called_once()
        phase_f.assert_not_called()

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

    def test_sessions_preserves_the_incumbent_singleton_cap(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        candidate = _payload(sessions=4, singletons=1, gap1=2)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
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
            [1],
        )
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(reason, "two_stage_session_compression")
        self.assertFalse(attempts[0]["incumbent_singleton_fallback"]["attempted"])

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

    def test_gaps_focus_allows_session_reduction_and_runs_only_gap_phase(self) -> None:
        incumbent = _payload(sessions=5, gap1=2)
        candidate = _payload(sessions=4, gap1=1)
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
        self.assertFalse(
            calls[0]["settings"]["optimization_benders_lock_teacher_sessions"]
        )
        self.assertEqual(calls[0]["cap"], 5)
        self.assertEqual([item["phase"] for item in attempts], ["two_stage_gap_cleanup"])
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["gap_distribution"][1], 1)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertEqual(result["solver"]["two_stage_teacher_optimization"]["mode"], "gaps_only")
        self.assertIsNone(attempts[0]["locked_teacher_sessions"])
        self.assertFalse(attempts[0]["same_teacher_sessions"])
        self.assertTrue(attempts[0]["teacher_sessions_not_increased"])

    def test_split_gap_targets_lock_sessions_and_improve_only_the_selected_gap(self) -> None:
        cases = [
            (
                "gap2",
                _payload(sessions=5, gap1=1, gap2=1),
                _payload(sessions=5, gap1=1, gap2=0),
                0,
                1,
            ),
            (
                "gap1",
                _payload(sessions=5, gap1=3, gap2=0),
                _payload(sessions=5, gap1=1, gap2=0),
                0,
                1,
            ),
        ]
        for target, incumbent, candidate, expected_gap2, expected_gap1 in cases:
            calls: list[dict] = []

            def fake_benders(_data, call_settings, **kwargs):
                calls.append({"settings": dict(call_settings), **kwargs})
                return candidate

            with (
                self.subTest(target=target),
                patch(
                    "tkb_new.adapter._solve_teacher_session_benders_candidate",
                    side_effect=fake_benders,
                ),
            ):
                result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                    {},
                    {
                        "optimization_focus": "gaps",
                        "optimization_gap_target": target,
                    },
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(60),
                    total_limit=60,
                    incumbent_payload=incumbent,
                    phase_seeds=[7, 8],
                )

            self.assertEqual(len(calls), 1)
            self.assertTrue(
                calls[0]["settings"]["optimization_benders_lock_teacher_sessions"]
            )
            self.assertEqual(metrics["teacher_sessions"], 5)
            self.assertEqual(metrics["gap_distribution"].get(2, 0), expected_gap2)
            self.assertEqual(metrics["gap_distribution"].get(1, 0), expected_gap1)
            self.assertEqual(reason, "two_stage_gap_cleanup")
            self.assertEqual(
                result["solver"]["two_stage_teacher_optimization"]["mode"],
                f"{target}_only",
            )

    def test_gap1_focus_skips_gap2_repack_and_zero_probe(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=2)
        candidate = _payload(sessions=5, gap1=2, gap2=2)
        calls: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            return candidate

        with (
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions"
            ) as repack,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            _result, metrics, _attempts, reason = (
                _solve_two_stage_concrete_refinement(
                    {},
                    {
                        "optimization_focus": "gaps",
                        "optimization_gap_target": "gap1",
                    },
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(60),
                    total_limit=60,
                    incumbent_payload=incumbent,
                    phase_seeds=[7, 8],
                )
            )

        repack.assert_not_called()
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            calls[0]["settings"]["optimization_benders_gap_objective_target"],
            "gap1",
        )
        self.assertEqual(
            calls[0]["settings"][
                "optimization_benders_max_teacher_gap2_plus_sessions"
            ],
            2,
        )
        self.assertEqual(calls[0]["settings"]["period_max_teacher_gap"], "off")
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(metrics["gap_distribution"][2], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")

    def test_gap2_repack_returns_at_zero_without_a_deep_retry_on_every_executor(self) -> None:
        cases = [
            ("tkb-solver", 0, 0, False),
            ("", 0, 0, False),
            ("tkb-solver", 1, 0, False),
            ("", 1, 0, False),
            ("tkb-solver", 0, 1, True),
            ("", 1, 1, True),
        ]
        for service, singletons, repacked_gap2, should_deep_retry in cases:
            incumbent = _payload(sessions=5, singletons=singletons, gap1=2, gap2=1)
            repacked = _payload(
                sessions=5,
                singletons=singletons,
                gap1=2,
                gap2=repacked_gap2,
            )
            deep_calls: list[dict] = []

            def fake_deep(*_args, **kwargs):
                deep_calls.append(dict(kwargs))
                return repacked

            with (
                self.subTest(
                    service=service or "vps",
                    singletons=singletons,
                    repacked_gap2=repacked_gap2,
                ),
                patch.dict(os.environ, {"K_SERVICE": service}),
                patch(
                    "tkb_new.adapter._repack_periods_for_fixed_sessions",
                    return_value=repacked,
                ),
                patch(
                    "tkb_new.adapter._solve_teacher_session_benders_candidate",
                    side_effect=fake_deep,
                ),
            ):
                _solve_two_stage_concrete_refinement(
                    {"nonempty": True},
                    {
                        "optimization_focus": "gaps",
                        "optimization_gap_target": "gap2",
                    },
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(60),
                    total_limit=60,
                    incumbent_payload=incumbent,
                    phase_seeds=[7, 8],
                )

            if should_deep_retry:
                self.assertGreater(len(deep_calls), 0)
            else:
                self.assertEqual(len(deep_calls), 0)

    def test_split_gap_target_at_zero_returns_before_any_solver_phase(self) -> None:
        for target, incumbent in (
            ("gap2", _payload(sessions=5, gap1=4, gap2=0)),
            ("gap1", _payload(sessions=5, gap1=0, gap2=3)),
        ):
            with (
                self.subTest(target=target),
                patch(
                    "tkb_new.adapter._repack_periods_for_fixed_sessions"
                ) as repack,
                patch(
                    "tkb_new.adapter._solve_teacher_session_benders_candidate"
                ) as benders,
                patch(
                    "tkb_new.adapter._polish_complete_incumbent_with_local_lns"
                ) as local,
            ):
                result, metrics, attempts, reason = (
                    _solve_two_stage_concrete_refinement(
                        {"fixture": True},
                        {
                            "optimization_focus": "gaps",
                            "optimization_gap_target": target,
                        },
                        rules=None,
                        progress=None,
                        deadline=SolverDeadline(60),
                        total_limit=60,
                        incumbent_payload=incumbent,
                        phase_seeds=[7, 8],
                    )
                )

            repack.assert_not_called()
            benders.assert_not_called()
            local.assert_not_called()
            self.assertEqual(metrics, incumbent["metrics"])
            self.assertEqual(reason, f"focused_{target}_already_zero")
            self.assertEqual(attempts[0]["reason"], "target_already_zero")
            self.assertEqual(
                result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
                "incumbent",
            )

    def test_split_gap_targets_reject_incidental_session_reduction(self) -> None:
        for target, incumbent in [
            ("gap2", _payload(sessions=5, gap1=1, gap2=1)),
            ("gap1", _payload(sessions=5, gap1=3, gap2=0)),
        ]:
            candidate = _payload(sessions=4, gap1=0, gap2=0)
            with (
                self.subTest(target=target),
                patch(
                    "tkb_new.adapter._solve_teacher_session_benders_candidate",
                    return_value=candidate,
                ),
            ):
                _result, metrics, _attempts, reason = _solve_two_stage_concrete_refinement(
                    {},
                    {
                        "optimization_focus": "gaps",
                        "optimization_gap_target": target,
                    },
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(60),
                    total_limit=60,
                    incumbent_payload=incumbent,
                    phase_seeds=[7, 8],
                )

            self.assertEqual(metrics["teacher_sessions"], 5)
            self.assertEqual(reason, "two_stage_incumbent")

    def test_gaps_focus_rejects_session_increase_even_with_fewer_gaps(self) -> None:
        incumbent = _payload(sessions=5, gap1=3)
        regressive = _payload(sessions=6, gap1=0)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=regressive,
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

        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][1], 3)
        self.assertEqual(reason, "two_stage_incumbent")
        self.assertFalse(attempts[0]["improved"])
        self.assertFalse(attempts[0]["teacher_sessions_not_increased"])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "incumbent",
        )

    def test_gaps_focus_session_reduction_never_adds_singleton_or_gap2_debt(self) -> None:
        incumbent = _payload(sessions=5, gap1=3)
        hard_invalid = _payload(sessions=4, gap1=0)
        hard_invalid["metrics"]["hard_ok"] = False
        hard_invalid["validation"]["hard_ok"] = False
        incomplete = _payload(sessions=4, gap1=0)
        incomplete["metrics"]["scheduled_periods"] = 3
        regressions = {
            "singleton": _payload(sessions=4, singletons=1, gap1=0),
            "gap2": _payload(sessions=4, gap1=0, gap2=1),
            "hard_invalid": hard_invalid,
            "incomplete": incomplete,
        }

        for label, regressive in regressions.items():
            with (
                self.subTest(label=label),
                patch(
                    "tkb_new.adapter._solve_teacher_session_benders_candidate",
                    return_value=regressive,
                ),
            ):
                result, metrics, attempts, reason = (
                    _solve_two_stage_concrete_refinement(
                        {},
                        {"optimization_focus": "gaps"},
                        rules=None,
                        progress=None,
                        deadline=SolverDeadline(60),
                        total_limit=60,
                        incumbent_payload=incumbent,
                        phase_seeds=[7, 8],
                    )
                )

            self.assertEqual(metrics["teacher_sessions"], 5)
            self.assertEqual(metrics["one_period_teacher_sessions"], 0)
            self.assertEqual(metrics["gap_distribution"][1], 3)
            self.assertEqual(reason, "two_stage_incumbent")
            self.assertFalse(attempts[0]["improved"])
            self.assertEqual(
                result["solver"]["two_stage_teacher_optimization"][
                    "selected_phase"
                ],
                "incumbent",
            )

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

    def test_gaps_focus_polishes_repack_before_global_search(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        repacked = _payload(sessions=5, gap1=2, gap2=0)
        local = _payload(sessions=4, gap1=1, gap2=0)
        global_candidate = _payload(sessions=4, gap1=0, gap2=0)
        order: list[str] = []
        benders_calls: list[dict] = []

        def fake_repack(*_args, **_kwargs):
            order.append("repack")
            return repacked

        def fake_local(*_args, **kwargs):
            order.append("local")
            self.assertTrue(kwargs["focused_gap1"])
            self.assertIsNone(kwargs["exact_teacher_sessions"])
            self.assertEqual(kwargs["gap1_cleanup_cap"], 0)
            self.assertTrue(kwargs["protected_cleanup_budget"])
            return local, [{"pass": 1, "improved": True}]

        def fake_benders(_data, call_settings, **kwargs):
            order.append("global")
            benders_calls.append({"settings": dict(call_settings), **kwargs})
            return global_candidate

        with (
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions",
                side_effect=fake_repack,
            ),
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=object(),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=fake_local,
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertEqual(order, ["repack", "local", "global"])
        self.assertIs(benders_calls[0]["incumbent_payload"], local)
        self.assertEqual(benders_calls[0]["cap"], 4)
        self.assertFalse(
            benders_calls[0]["settings"]["optimization_benders_lock_teacher_sessions"]
        )
        self.assertEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["gap_distribution"][1], 0)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        local_meta = attempts[0]["local_gap1_search"]
        self.assertTrue(local_meta["eligible"])
        self.assertEqual(local_meta["time_limit_seconds"], 30)
        self.assertEqual(local_meta["global_tail_reserve_seconds"], 18)
        self.assertTrue(local_meta["usable"])
        self.assertTrue(local_meta["improved"])
        self.assertIsNone(local_meta["exact_teacher_sessions"])
        self.assertEqual(local_meta["max_teacher_sessions"], 5)
        self.assertEqual(local_meta["passes"], [{"pass": 1, "improved": True}])
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "gap_cleanup",
        )

    def test_gaps_focus_rejects_regressive_local_candidate(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        repacked = _payload(sessions=5, gap1=2, gap2=0)
        regressive = _payload(sessions=5, singletons=1, gap1=0, gap2=1)
        global_incumbents: list[dict] = []

        def failed_global(_data, _settings, **kwargs):
            global_incumbents.append(kwargs["incumbent_payload"])
            raise RuntimeError("global timeout")

        with (
            patch(
                "tkb_new.adapter._repack_periods_for_fixed_sessions",
                return_value=repacked,
            ),
            patch(
                "tkb_new.adapter.build_school_data_from_ui",
                return_value=object(),
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(regressive, [{"pass": 1, "improved": True}]),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=failed_global,
            ),
        ):
            _result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {"fixture": True},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=None,
                deadline=SolverDeadline(90),
                total_limit=90,
                incumbent_payload=incumbent,
                phase_seeds=[7, 8],
            )

        self.assertIs(global_incumbents[0], repacked)
        self.assertEqual(metrics["teacher_sessions"], 5)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"][2], 0)
        self.assertEqual(metrics["gap_distribution"][1], 2)
        self.assertEqual(reason, "two_stage_gap_cleanup")
        self.assertFalse(attempts[0]["local_gap1_search"]["usable"])
        self.assertFalse(attempts[0]["local_gap1_search"]["improved"])

    def test_gaps_focus_optimizes_around_an_unavoidable_gap2(self) -> None:
        incumbent = _payload(sessions=5, gap1=3, gap2=1)
        bounded = _payload(sessions=5, gap1=1, gap2=1)
        calls: list[dict] = []
        events: list[dict] = []

        def fake_benders(_data, call_settings, **kwargs):
            calls.append({"settings": dict(call_settings), **kwargs})
            if len(calls) == 1:
                raise RuntimeError("zero gap2 infeasible")
            kwargs["progress"](
                {
                    "stage": "session_cp_sat:metric",
                    "gap_distribution": {1: 2, 2: 1},
                }
            )
            return bounded

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=fake_benders,
        ):
            result, metrics, attempts, reason = _solve_two_stage_concrete_refinement(
                {},
                {"optimization_focus": "gaps"},
                rules=None,
                progress=events.append,
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
        fallback_events = [
            event
            for event in events
            if event.get("stage")
            in {
                "teacher_session_opt:phase_gaps_bounded_fallback",
                "session_cp_sat:metric",
                "teacher_session_opt:phase_gaps_done",
            }
        ]
        self.assertGreaterEqual(len(fallback_events), 3)
        self.assertTrue(
            all(
                event["optimizationFocus"] == "teacher_gap_sessions"
                for event in fallback_events
            )
        )
        live_gap1 = next(
            event
            for event in fallback_events
            if event.get("stage") == "session_cp_sat:metric"
        )
        self.assertEqual(live_gap1["metricCurrent"], 3)
        self.assertEqual(live_gap1["metricBaseline"], 4)
        self.assertEqual(live_gap1["metricPercent"], 25.0)
        self.assertEqual(
            result["solver"]["two_stage_teacher_optimization"]["selected_phase"],
            "gap_cleanup",
        )

    def test_singleton_focus_emits_standard_progress_fields(self) -> None:
        incumbent = _payload(sessions=5, singletons=1, gap1=2)
        candidate = _payload(sessions=5, singletons=0, gap1=2)
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
        self.assertFalse(
            calls[0]["settings"]["optimization_benders_session_feasibility_only"]
        )
        self.assertTrue(
            calls[0]["settings"]["optimization_benders_minimize_one_period_sessions"]
        )
        self.assertFalse(
            calls[0]["settings"]["optimization_benders_minimize_teacher_sessions"]
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
        session_metrics = _payload(sessions=4, singletons=2, gap1=8, gap2=3)["metrics"]
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
        gap_metrics = _payload(sessions=9, singletons=2, gap1=1, gap2=3)["metrics"]
        self.assertEqual(
            _optimization_focus_goal_status(
                "gaps",
                gap_metrics,
                target_teacher_sessions=None,
                target_gap1_sessions=1,
                accept_teacher_sessions=None,
                accept_gap1_sessions=2,
                gap_target="gap1",
            ),
            (True, True),
        )
        gap2_metrics = _payload(sessions=9, singletons=0, gap1=4, gap2=0)["metrics"]
        self.assertEqual(
            _optimization_focus_goal_status(
                "gaps",
                gap2_metrics,
                target_teacher_sessions=None,
                target_gap1_sessions=None,
                accept_teacher_sessions=None,
                accept_gap1_sessions=None,
                gap_target="gap2",
            ),
            (True, True),
        )
        gap1_metrics = _payload(sessions=9, singletons=0, gap1=0, gap2=0)["metrics"]
        self.assertEqual(
            _optimization_focus_goal_status(
                "gaps",
                gap1_metrics,
                target_teacher_sessions=None,
                target_gap1_sessions=0,
                accept_teacher_sessions=None,
                accept_gap1_sessions=0,
                gap_target="gap1",
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

    def test_focused_orchestration_failure_returns_the_exact_incumbent(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _payload(sessions=5, gap1=2, gap2=1)

        for focus in ("singletons", "sessions", "gaps"):
            with (
                self.subTest(focus=focus),
                patch(
                    "tkb_new.adapter._teacher_session_adaptive_bounds",
                    return_value={
                        "lower_cap": 3,
                        "start_cap": 4,
                        "upper_cap": 10,
                        "expected_periods": 4,
                    },
                ),
                patch(
                    "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                    return_value=None,
                ),
                patch(
                    "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                    return_value=incumbent,
                ),
                patch(
                    "tkb_new.adapter._solve_two_stage_concrete_refinement",
                    side_effect=RuntimeError("focused orchestration failed"),
                ),
                patch(
                    "tkb_new.adapter._incremental_lns_profile"
                ) as legacy_profile,
            ):
                payload = _solve_teacher_session_optimized_from_ui_data(
                    data,
                    {
                        "optimization_focus": focus,
                        "optimization_time_limit_seconds": 90,
                    },
                    rules=None,
                    progress=None,
                    out_dir=None,
                )

            legacy_profile.assert_not_called()
            self.assertEqual(payload["metrics"], incumbent["metrics"])
            optimization = payload["solver"]["teacher_session_optimization"]
            self.assertEqual(
                optimization["termination_reason"],
                f"focused_{focus}_incumbent_after_orchestration_error",
            )
            attempt = next(
                item for item in optimization["attempts"]
                if item.get("phase") == "two_stage_orchestration"
            )
            self.assertEqual(attempt["fallback"], "incumbent_no_improvement")


if __name__ == "__main__":
    unittest.main()
