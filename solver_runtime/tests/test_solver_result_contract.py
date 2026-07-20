from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))
sys.path.insert(0, str(RUNTIME_ROOT))

from scripts.solve_stdio import _finalize_solve_status  # noqa: E402
from tkb_new.adapter import (  # noqa: E402
    ClassEntry,
    SolverDeadline,
    UiDataContext,
    _add_at_most_one_internal_gap_constraints,
    _bounded_soft_incumbent_residual_completion,
    _complete_first_teacher_session_cap,
    _cut_for_one_period_teacher_sessions,
    _extract_hard_fixed_lessons_from_tkb,
    _fast_benders_tight_fixed_off_profile,
    _fast_quality_warmup_direct_settings,
    _first_click_request_portfolio_seed,
    _incremental_lns_profile,
    _incremental_refinement_candidate_better,
    _legacy_solver_hints_enabled,
    _merge_refinement_learning,
    _refinement_learning_from_payload,
    _refinement_gap_priority_attempts,
    _refinement_request_seed,
    _release_invalid_fixed_lessons,
    _relaxed_teacher_session_cap,
    _repair_one_period_affected_class_cluster,
    _session_cp_sat_linearization_level,
    _solve_fast_tight_fixed_off_benders,
    _solve_unified_first_click_feasibility_then_quality,
    _new_cuts_for_period_metrics,
    _polish_complete_incumbent_with_local_lns,
    _school_refinement_seed_sequence,
    _select_refinement_operator,
    _solve_teacher_session_benders_candidate,
    _solve_teacher_session_optimized_from_ui_data,
    _teacher_session_opt_gap1,
    _teacher_session_opt_attempt_settings,
    _teacher_session_opt_fast_quality_settings,
    _teacher_session_opt_gap_priority_attempts,
    _teacher_session_opt_frontier_better,
    _teacher_session_opt_goal_aware_better,
    _teacher_session_opt_quality,
    _teacher_session_opt_seed_caps,
    _teacher_session_opt_should_prioritize_gap_portfolio,
    _teacher_session_opt_should_stop,
    _teacher_session_opt_within_balanced_envelope,
    _teacher_quality_gap1_first,
    _validated_existing_soft_incumbent_payload,
    build_payload,
    build_school_data_from_ui,
    solve_from_ui_data,
    validate_candidate_payload,
    _load_cp_model,
)
from tkb_new.fixture import build_ui_fixture_from_workbooks  # noqa: E402
from tkb_optimizer_ref.models import (  # noqa: E402
    Assignment,
    ClassInfo,
    Lesson,
    SchoolData,
    Session,
    SessionAllocation,
)
from tkb_optimizer_ref.period_milp import allocate_periods  # noqa: E402
from tkb_optimizer_ref.rules import TimetableConstraintRules, TimetableRuleSet  # noqa: E402
from tkb_optimizer_ref.session_cp_sat import SessionCpSatNoSolution, solve_session_allocation_cp_sat  # noqa: E402
from tkb_optimizer_ref.session_milp import solve_session_allocation  # noqa: E402
from tkb_optimizer_ref.validate import compute_metrics, validate_app_constraints  # noqa: E402


def _context() -> UiDataContext:
    data = SchoolData(
        classes=[ClassInfo(name="6/1", grade="Khối 6")],
        assignments=[
            Assignment(
                class_name="6/1",
                grade="Khối 6",
                subject="Toán",
                teacher="GV1",
                periods_per_week=2,
                max_periods_per_session=1,
            )
        ],
        teachers=["GV1"],
        subjects=["Toán"],
        periods_by_grade_subject={("Khối 6", "Toán"): 2},
        limits_by_grade_subject={("Khối 6", "Toán"): 1},
    )
    entry = ClassEntry(id="L001", name="6/1", grade="Khối 6", aliases=("L001", "6/1"))
    return UiDataContext(
        school_data=data,
        classes=[entry],
        class_by_name={entry.name: entry},
        rules=TimetableRuleSet(),
        warnings=[],
    )


def _first_click_payload(
    *,
    teacher_sessions: int,
    gap1: int,
    scheduled_periods: int = 1566,
    one_period_sessions: int = 0,
    include_fixed_lesson: bool = True,
) -> dict:
    lessons = []
    if include_fixed_lesson:
        lessons.append(
            {
                "className": "6/1",
                "grade": "6",
                "day": 2,
                "session": "AM",
                "period": 1,
                "subject": "Math",
                "teacher": "T1",
                "room": "",
            }
        )
    return {
        "ok": True,
        "metrics": {
            "hard_ok": True,
            "scheduled_periods": scheduled_periods,
            "expected_periods": 1566,
            "unassigned_periods": max(0, 1566 - scheduled_periods),
            "app_constraint_violation_count": 0,
            "teacher_sessions": teacher_sessions,
            "one_period_teacher_sessions": one_period_sessions,
            "gap_distribution": {0: max(0, teacher_sessions - gap1), 1: gap1},
        },
        "validation": {"hard_ok": True},
        "solver": {},
        "lessons": lessons,
    }


class SolverResultContractTests(unittest.TestCase):
    def test_legacy_static_hints_are_disabled_even_when_requested(self) -> None:
        self.assertFalse(_legacy_solver_hints_enabled())
        self.assertFalse(
            _legacy_solver_hints_enabled(
                {
                    "allow_legacy_solver_hints": True,
                    "disable_solver_hints": False,
                }
            )
        )

    def test_assignment_session_limit_and_subject_day_limit_are_independent(self) -> None:
        base = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        lessons = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 2, "AM", 2, "Math", "T1"),
            Lesson("6/1", "6", 2, "PM", 1, "Math", "T1"),
            Lesson("6/1", "6", 2, "PM", 2, "Math", "T1"),
        ]

        without_day_limit = build_school_data_from_ui(base)
        assignment = without_day_limit.school_data.assignments[0]
        self.assertEqual(assignment.max_periods_per_session, 2)
        self.assertTrue(
            validate_app_constraints(
                without_day_limit.school_data,
                lessons,
                without_day_limit.rules,
            )["hard_ok"]
        )

        with_day_limit_data = json.loads(json.dumps(base))
        with_day_limit_data["tkbConstraints"] = {
            "subject": {
                "M": {
                    "byClass": {
                        "L1": {"maxPeriods": {"day": {"thu2": 3}}}
                    }
                }
            }
        }
        with_day_limit = build_school_data_from_ui(with_day_limit_data)
        report = validate_app_constraints(
            with_day_limit.school_data,
            lessons,
            with_day_limit.rules,
        )
        self.assertFalse(report["hard_ok"])
        self.assertTrue(
            any(item.get("kind") == "subject.maxPeriods.day" for item in report["violations"])
        )

    def test_unified_priority_keeps_gap_zero_as_search_signal_only(self) -> None:
        self.assertTrue(_teacher_quality_gap1_first({}, 0))
        self.assertFalse(
            _teacher_quality_gap1_first(
                {"quality_priority_order": "one_period_gap2_teacher_sessions_gap1"},
                0,
            )
        )

    def test_soft_incumbent_does_not_turn_non_fixed_cells_into_hard_locks(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math", "fixed": True},
                            {"mon": "Math"},
                            "",
                            "",
                            "",
                        ]
                    }
                }
            },
            "tkbSolverResult": {
                "lessons": [
                    {"classId": "L1", "className": "6/1", "grade": "6", "day": 2, "session": "AM", "period": 1, "subject": "Math", "teacher": "STALE"},
                    {"classId": "L1", "className": "6/1", "grade": "6", "day": 2, "session": "AM", "period": 2, "subject": "Math", "teacher": "STALE"},
                ]
            },
        }
        ctx = build_school_data_from_ui(data)
        learning_signature = _refinement_learning_from_payload(
            None,
            ctx.school_data,
        )["school_signature"]
        data["tkbRefinementLearning"] = {
            "version": 2,
            "school_signature": learning_signature,
            "total_attempts": 1,
            "operators": {
                "session_merge": {
                    "attempts": 1,
                    "improvements": 0,
                    "reward": 0.0,
                    "seconds": 1.0,
                    "last_round": 1,
                }
            },
        }

        hard_lessons, _warnings = _extract_hard_fixed_lessons_from_tkb(data, ctx)
        incumbent = _validated_existing_soft_incumbent_payload(
            data,
            {"ui_use_existing_complete_incumbent": True},
            rules=None,
        )

        self.assertEqual(len(hard_lessons), 1)
        self.assertIsNotNone(incumbent)
        self.assertEqual(len(incumbent["lessons"]), 2)  # type: ignore[index]
        self.assertEqual({item["teacher"] for item in incumbent["lessons"]}, {"T1"})  # type: ignore[index]
        self.assertEqual(
            incumbent["solver"]["runtime_settings"]["refinement_learning"]["total_attempts"],  # type: ignore[index]
            1,
        )

    def test_fixed_lesson_is_counted_in_quality_while_fixed_off_remains_a_blocker(self) -> None:
        open_slots = {(2, "sang", 0), (2, "sang", 1)}
        fixed_off = [
            f"thu{day}|{session}|{period}"
            for day in range(2, 8)
            for session in ("sang", "chieu")
            for period in range(5)
            if (day, session, period) not in open_slots
        ]
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbUserOff": {"L1": fixed_off},
            "tkbConstraints": {},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math", "fixed": True},
                            "",
                            "",
                            "",
                            "",
                        ]
                    }
                }
            },
        }

        ctx = build_school_data_from_ui(data)
        constraints = ctx.rules.constraints
        hard_lessons, warnings = _extract_hard_fixed_lessons_from_tkb(data, ctx)
        self.assertIsNotNone(constraints)
        self.assertTrue(constraints.is_fixed_off("class", "6/1", 2, "AM", 3))  # type: ignore[union-attr]
        self.assertFalse(constraints.is_fixed_off("class", "6/1", 2, "AM", 2))  # type: ignore[union-attr]
        self.assertEqual(warnings, [])
        self.assertEqual(
            [(lesson.day, lesson.session, lesson.period, lesson.subject) for lesson in hard_lessons],
            [(2, "AM", 1, "Math")],
        )

        payload = solve_from_ui_data(
            data,
            {
                "solver_mode": "session_cp_sat",
                "auto_sort_strategy": "fresh",
                "preserve_fixed_lessons_only": True,
                "max_teacher_sessions": 1,
                "max_one_period_sessions": 0,
                "strict_one_period_sessions_cap": True,
                "session_time_limit": 5,
                "period_time_limit": 5,
                "period_fast_time_limit": 5,
                "period_retry_time_limit": 5,
                "overall_time_limit_seconds": 15,
                "best_effort_on_timeout": False,
                "minimize_sessions": True,
                "minimize_one_period_sessions": True,
                "allow_one_period_gaps": True,
                "num_workers": 1,
            },
        )

        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["scheduled_periods"], 2)
        self.assertEqual(payload["metrics"]["teacher_sessions"], 1)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        self.assertEqual(
            [(lesson["day"], lesson["session"], lesson["period"]) for lesson in payload["lessons"]],
            [(2, "AM", 1), (2, "AM", 2)],
        )
        self.assertEqual(payload["solver"]["session_solver"]["fixed_lessons"], 1)
        self.assertEqual(payload["solver"]["session_solver"]["fixed_teacher_sessions"], 1)
        self.assertEqual(payload["solver"]["residual_validation"]["one_period_teacher_sessions"], 1)

    def test_subject_pair_min_and_avoid_23_can_be_scheduled_together(self) -> None:
        open_slots = {(2, "sang", 0), (2, "sang", 1)}
        fixed_off = [
            f"thu{day}|{session}|{period}"
            for day in range(2, 8)
            for session in ("sang", "chieu")
            for period in range(5)
            if (day, session, period) not in open_slots
        ]
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbUserOff": {"L1": fixed_off},
            "tkbConstraints": {
                "subject": {
                    "Math": {
                        "byClass": {
                            "L1": {
                                "lessonBlocks": {"2": {"min": 1}},
                                "avoidBreakPair23": {
                                    "morning": True,
                                    "afternoon": True,
                                },
                            }
                        }
                    }
                }
            },
        }

        payload = solve_from_ui_data(
            data,
            {
                "solver_mode": "session_cp_sat",
                "auto_sort_strategy": "fresh",
                "max_teacher_sessions": 1,
                "max_one_period_sessions": 0,
                "strict_one_period_sessions_cap": True,
                "session_time_limit": 5,
                "period_time_limit": 5,
                "period_fast_time_limit": 5,
                "period_retry_time_limit": 5,
                "overall_time_limit_seconds": 15,
                "best_effort_on_timeout": False,
                "num_workers": 1,
            },
        )

        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["scheduled_periods"], 2)
        self.assertEqual(payload["metrics"]["app_constraint_violation_count"], 0)
        self.assertEqual(
            [(lesson["day"], lesson["session"], lesson["period"]) for lesson in payload["lessons"]],
            [(2, "AM", 1), (2, "AM", 2)],
        )

    def test_session_milp_counts_fixed_morning_against_teacher_limit(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[
                Assignment(
                    class_name="6/1",
                    grade="6",
                    subject="Science",
                    teacher="T1",
                    periods_per_week=1,
                    max_periods_per_session=1,
                )
            ],
            teachers=["T1"],
            subjects=["Science"],
            periods_by_grade_subject={("6", "Science"): 1},
            limits_by_grade_subject={("6", "Science"): 1},
        )
        fixed = Lesson(
            class_name="6/1",
            grade="6",
            day=2,
            session="AM",
            period=1,
            subject="Math",
            teacher="T1",
        )
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={},
                teacher={"T1": {"maxMorningAfternoon": {"morning": 1}}},
                subject={},
                subject_group={},
            )
        )

        allocations, metrics = solve_session_allocation(
            data,
            rules=rules,
            fixed_lessons=[fixed],
            max_teacher_sessions=2,
            minimize_sessions=True,
            time_limit_seconds=5,
            verbose=False,
        )

        self.assertEqual(len(allocations), 1)
        self.assertEqual(allocations[0].session.part, "PM")
        self.assertEqual(metrics["teacher_sessions"], 2)
        self.assertEqual(metrics["fixed_teacher_sessions"], 1)

    def test_external_candidate_is_revalidated_against_teacher_max_days(self) -> None:
        data = {
            "lop": [
                {"id": "L1", "ten": "6/1", "khoi": "6"},
                {"id": "L2", "ten": "6/2", "khoi": "6"},
            ],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {"L1|Math": "T1", "L2|Math": "T1"},
            "tkbConstraints": {
                "teacher": {"T1": {"maxDaysSessions": {"maxDays": 1}}}
            },
        }
        candidate = {
            "ok": True,
            "lessons": [
                {
                    "className": "6/1",
                    "grade": "6",
                    "subject": "Math",
                    "teacher": "T1",
                    "day": 2,
                    "session": "AM",
                    "period": 1,
                },
                {
                    "className": "6/2",
                    "grade": "6",
                    "subject": "Math",
                    "teacher": "T1",
                    "day": 3,
                    "session": "AM",
                    "period": 1,
                },
            ],
            "unassignedLessons": [],
        }

        invalid = validate_candidate_payload(data, candidate)
        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["app_constraint_violation_count"], 1)
        self.assertIn("teacher.maxDays", invalid["violation_kinds"])

        candidate["lessons"][1]["day"] = 2
        candidate["lessons"][1]["period"] = 2
        valid = validate_candidate_payload(data, candidate)
        self.assertTrue(valid["ok"])
        self.assertTrue(valid["hard_ok"])

    def test_constraint_repair_releases_only_the_smallest_excess_teacher_day(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={},
            limits_by_grade_subject={},
        )
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={},
                teacher={"T1": {"maxDaysSessions": {"maxDays": 3}}},
                subject={},
                subject_group={},
            )
        )

        def day_lessons(day: int, count: int) -> list[Lesson]:
            return [
                Lesson(
                    class_name="6/1",
                    grade="6",
                    day=day,
                    session="AM",
                    period=period,
                    subject="Math",
                    teacher="T1",
                )
                for period in range(1, count + 1)
            ]

        incumbent = [
            *day_lessons(2, 4),
            *day_lessons(3, 1),
            *day_lessons(4, 3),
            *day_lessons(5, 2),
        ]
        kept, warnings = _release_invalid_fixed_lessons(data, incumbent, rules)

        self.assertEqual(len(incumbent) - len(kept), 1)
        self.assertEqual({lesson.day for lesson in kept}, {2, 4, 5})
        self.assertFalse(validate_app_constraints(data, kept, rules)["violations"])
        self.assertTrue(any("1 tiet" in warning for warning in warnings))

    def test_constraint_repair_never_releases_a_hard_fixed_teacher_day(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={},
            limits_by_grade_subject={},
        )
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={},
                teacher={"T1": {"maxDaysSessions": {"maxDays": 3}}},
                subject={},
                subject_group={},
            )
        )
        protected = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
        ]
        flexible = [
            Lesson("6/1", "6", 3, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 3, "AM", 2, "Math", "T1"),
            Lesson("6/1", "6", 4, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 4, "AM", 2, "Math", "T1"),
            Lesson("6/1", "6", 5, "AM", 1, "Math", "T1"),
        ]

        kept, _warnings = _release_invalid_fixed_lessons(
            data,
            flexible,
            rules,
            protected_lessons=protected,
        )

        self.assertEqual({lesson.day for lesson in kept}, {3, 4})
        self.assertEqual(protected[0].day, 2)
        self.assertFalse(validate_app_constraints(data, [*protected, *kept], rules)["violations"])

    def test_hard_fixed_lessons_are_not_released_for_a_new_teacher_limit(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={},
            limits_by_grade_subject={},
        )
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={},
                teacher={"T1": {"maxDaysSessions": {"maxDays": 1}}},
                subject={},
                subject_group={},
            )
        )
        fixed = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 3, "AM", 1, "Math", "T1"),
        ]

        kept, warnings = _release_invalid_fixed_lessons(
            data,
            fixed,
            rules,
            release_constraint_violations=False,
        )

        self.assertEqual(kept, fixed)
        self.assertTrue(any("tiet co dinh" in warning for warning in warnings))

    def test_session_milp_does_not_double_subtract_fixed_slot_capacity(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[
                Assignment(
                    class_name="6/1",
                    grade="6",
                    subject="Science",
                    teacher="T1",
                    periods_per_week=4,
                    max_periods_per_session=4,
                )
            ],
            teachers=["T1"],
            subjects=["Science"],
            periods_by_grade_subject={("6", "Science"): 4},
            limits_by_grade_subject={("6", "Science"): 4},
        )
        fixed = Lesson(
            class_name="6/1",
            grade="6",
            day=2,
            session="AM",
            period=1,
            subject="Math",
            teacher="T1",
        )
        all_slots = {
            (day, part, period)
            for day in range(2, 8)
            for part, count in (("AM", 5), ("PM", 5))
            for period in range(1, count + 1)
        }
        available_residual = {(2, "AM", period) for period in range(2, 6)}
        fixed_off = frozenset(all_slots - available_residual)
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={
                    "class": {"6/1": fixed_off},
                    "teacher": {"T1": fixed_off},
                },
                teacher={},
                subject={},
                subject_group={},
            )
        )

        allocations, metrics = solve_session_allocation(
            data,
            rules=rules,
            fixed_lessons=[fixed],
            max_teacher_sessions=1,
            minimize_sessions=True,
            time_limit_seconds=5,
            verbose=False,
        )

        self.assertEqual(sum(item.count for item in allocations), 4)
        self.assertEqual({(item.session.day, item.session.part) for item in allocations}, {(2, "AM")})
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["fixed_lessons"], 1)

    def test_conflicting_fixed_teacher_lock_is_released_before_residual_solve(self) -> None:
        data = {
            "lop": [
                {"id": "L1", "ten": "6/1", "khoi": "6"},
                {"id": "L2", "ten": "6/2", "khoi": "6"},
            ],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {"L1|Math": "T1", "L2|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {"thu2": {"sang": [{"mon": "Math", "fixed": True}, "", "", "", ""]}},
                "L2": {"thu2": {"sang": [{"mon": "Math", "fixed": True}, "", "", "", ""]}},
            },
        }

        payload = solve_from_ui_data(
            data,
            {
                "solver_mode": "session_cp_sat",
                "auto_sort_strategy": "fresh",
                "preserve_fixed_lessons_only": True,
                "max_teacher_sessions": 2,
                "max_one_period_sessions": "off",
                "strict_one_period_sessions_cap": False,
                "enforce_max_one_period_sessions": False,
                "session_time_limit": 5,
                "period_time_limit": 5,
                "period_fast_time_limit": 5,
                "period_retry_time_limit": 5,
                "overall_time_limit_seconds": 15,
                "best_effort_on_timeout": False,
                "minimize_sessions": True,
                "minimize_one_period_sessions": True,
                "allow_one_period_gaps": True,
                "num_workers": 1,
            },
        )

        metrics = payload["metrics"]
        self.assertTrue(metrics["hard_ok"], json.dumps(payload, ensure_ascii=False, default=str))
        self.assertEqual(metrics["scheduled_periods"], 2)
        self.assertEqual(metrics["expected_periods"], 2)
        fixed_slot_lessons = [
            lesson
            for lesson in payload["lessons"]
            if lesson["day"] == 2 and lesson["session"] == "AM" and lesson["period"] == 1
        ]
        self.assertEqual(len(fixed_slot_lessons), 1)
        self.assertTrue(any("trung" in str(warning) for warning in payload.get("warnings", [])))

    def test_stale_complete_metrics_are_rejected_after_pccm_conflict(self) -> None:
        data = {
            "lop": [
                {"id": "L1", "ten": "6/1", "khoi": "6"},
                {"id": "L2", "ten": "6/2", "khoi": "6"},
            ],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {"L1|Math": "T1", "L2|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {"thu2": {"sang": [{"mon": "Math"}, "", "", "", ""]}},
                "L2": {"thu2": {"sang": [{"mon": "Math"}, "", "", "", ""]}},
            },
            "tkbSolverResult": {
                "metrics": {"scheduled_periods": 2, "expected_periods": 2, "unassigned_periods": 0, "hard_ok": True},
                "lessons": [],
            },
        }

        incumbent = _validated_existing_soft_incumbent_payload(
            data,
            {"ui_use_existing_complete_incumbent": True},
            rules=None,
        )

        self.assertIsNone(incumbent)

    def test_bounded_residual_completion_preserves_soft_incumbent_quality(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "6")],
            assignments=[
                Assignment("6/1", "6", "Math", "T1", 2, 2),
                Assignment("6/1", "6", "Science", "T2", 2, 2),
            ],
            teachers=["T1", "T2"],
            subjects=["Math", "Science"],
            periods_by_grade_subject={("6", "Math"): 2, ("6", "Science"): 2},
            limits_by_grade_subject={("6", "Math"): 2, ("6", "Science"): 2},
        )
        class_off = frozenset(
            (day, part, period)
            for day in range(2, 8)
            for part, count in (("AM", 5), ("PM", 4))
            for period in range(1, count + 1)
            if (day, part, period) not in {
                (2, "AM", 1),
                (2, "AM", 2),
                (2, "AM", 3),
                (2, "AM", 4),
            }
        )
        constraints = TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={
                "class": {"6/1": class_off},
                "teacher": {},
                "subject": {},
                "room": {},
                "subjectGroup": {},
            },
            teacher={},
            subject={},
            subject_group={},
        )
        rules = TimetableRuleSet(constraints=constraints)
        incumbent = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 2, "AM", 3, "Science", "T2"),
            Lesson("6/1", "6", 2, "AM", 4, "Science", "T2"),
        ]

        result = _bounded_soft_incumbent_residual_completion(
            data,
            incumbent,
            rules,
            max_missing=2,
            time_limit_seconds=1,
        )

        self.assertIsNotNone(result)
        lessons, metrics, meta = result  # type: ignore[misc]
        self.assertTrue(metrics["hard_ok"])
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"], {0: 2})
        self.assertEqual(len(lessons), 4)
        self.assertEqual(meta["preserved_hint_periods"], 3)
        self.assertEqual(meta["changed_hint_periods"], 0)
        self.assertIn(Lesson("6/1", "6", 2, "AM", 2, "Math", "T1"), lessons)

    def test_bounded_residual_completion_can_close_a_temporary_gap_two(self) -> None:
        data = SchoolData(
            classes=[
                ClassInfo("6/1", "6"),
                ClassInfo("6/2", "6"),
                ClassInfo("6/3", "6"),
            ],
            assignments=[
                Assignment("6/1", "6", "Math", "T1", 1, 1),
                Assignment("6/2", "6", "Math", "T1", 1, 1),
                Assignment("6/3", "6", "Math", "T1", 1, 1),
            ],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={("6", "Math"): 1},
            limits_by_grade_subject={("6", "Math"): 1},
        )
        all_slots = {
            (day, part, period)
            for day in range(2, 8)
            for part, count in (("AM", 5), ("PM", 4))
            for period in range(1, count + 1)
        }
        constraints = TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={
                "class": {
                    "6/1": frozenset(all_slots - {(2, "AM", 1)}),
                    "6/2": frozenset(all_slots - {(2, "AM", 2)}),
                    "6/3": frozenset(all_slots - {(2, "AM", 4)}),
                },
                "teacher": {},
                "subject": {},
                "room": {},
                "subjectGroup": {},
            },
            teacher={},
            subject={},
            subject_group={},
        )
        rules = TimetableRuleSet(constraints=constraints)
        incumbent = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
            Lesson("6/3", "6", 2, "AM", 4, "Math", "T1"),
        ]

        result = _bounded_soft_incumbent_residual_completion(
            data,
            incumbent,
            rules,
            max_missing=2,
            time_limit_seconds=1,
        )

        self.assertIsNotNone(result)
        lessons, metrics, meta = result  # type: ignore[misc]
        self.assertTrue(metrics["hard_ok"])
        self.assertEqual(metrics["scheduled_periods"], 3)
        self.assertEqual(metrics["gap_distribution"], {1: 1})
        self.assertEqual(meta["preserved_hint_periods"], 2)
        self.assertEqual(meta["changed_hint_periods"], 0)
        self.assertIn(Lesson("6/2", "6", 2, "AM", 2, "Math", "T1"), lessons)

    def test_unified_bounded_repair_skips_residual_only_one_period_probes(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math", "fixed": True},
                            "",
                            "",
                            "",
                            "",
                        ]
                    }
                }
            },
        }
        settings = {
            "solver_mode": "auto",
            "auto_sort_mode": "fast",
            "auto_sort_strategy": "preserve_existing",
            "preserve_existing_tkb": True,
            "preserve_fixed_lessons_only": True,
            "force_preserve_partial_existing": True,
            "partial_existing_rebuild": True,
            "repair_fill_first": True,
            "repair_partial_existing": True,
            "repair_fill_first_max_missing": 2,
            "ui_unified_partial_repair": True,
            "allow_quality_debt": True,
            "max_one_period_sessions": "off",
            "strict_one_period_sessions_cap": False,
            "enforce_max_one_period_sessions": False,
            "session_time_limit": 5,
            "period_time_limit": 5,
            "period_fast_time_limit": 5,
            "period_retry_time_limit": 5,
            "overall_time_limit_seconds": 10,
            "best_effort_on_timeout": False,
            "minimize_sessions": True,
            "minimize_one_period_sessions": True,
            "allow_one_period_gaps": True,
            "num_workers": 1,
        }

        with (
            patch(
                "tkb_new.adapter.solve_session_allocation_cp_sat",
                side_effect=AssertionError("bounded repair must not run residual-only session probe"),
            ),
            patch(
                "tkb_new.adapter.solve_gap0_cp_sat",
                side_effect=AssertionError("bounded repair must not run residual-only gap probe"),
            ),
        ):
            payload = solve_from_ui_data(data, settings)

        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["scheduled_periods"], 2)
        self.assertEqual(payload["metrics"]["expected_periods"], 2)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        self.assertEqual(
            payload["solver"]["session_solver"]["solver"],
            "bounded_soft_incumbent_residual_repair",
        )

    def test_constraint_change_residual_lns_repacks_blocked_teacher_neighborhood(self) -> None:
        def fixed_off_except(allowed: set[tuple[int, str, int]]) -> dict[str, bool]:
            out: dict[str, bool] = {}
            for day in range(2, 8):
                for part, count in (("sang", 5), ("chieu", 5)):
                    session = "AM" if part == "sang" else "PM"
                    for index in range(count):
                        if (day, session, index + 1) not in allowed:
                            out[f"thu{day}|{part}|{index}"] = True
            return out

        data = {
            "lop": [
                {"id": "L1", "ten": "6/1", "khoi": "6"},
                {"id": "L2", "ten": "6/2", "khoi": "6"},
            ],
            "giaovien": [
                {"magv": "T1", "ten": "T1"},
                {"magv": "T2", "ten": "T2"},
            ],
            "monhoc": [
                {"ten": "Math", "ma": "M"},
                {"ten": "Science", "ma": "S"},
                {"ten": "Art", "ma": "A"},
            ],
            "mon": [
                {"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2},
                {"khoi": "6", "ten": "Science", "sotiet": 1, "gioihan": 1},
                {"khoi": "6", "ten": "Art", "sotiet": 1, "gioihan": 1},
            ],
            "pccmMatrix": {
                "L1|Math": "T1",
                "L1|Science": "T2",
                "L2|Art": "T2",
            },
            "pccmTietMatrix": {
                "L1|Math": 2,
                "L1|Science": 1,
                "L2|Art": 1,
            },
            "tkbConstraints": {
                "fixedOff": {
                    "class": {
                        "L1": fixed_off_except(
                            {(2, "AM", 1), (2, "AM", 2), (2, "AM", 3)}
                        ),
                        "L2": fixed_off_except({(2, "AM", 3)}),
                    }
                }
            },
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math"},
                            {"mon": "Math"},
                            "",
                            "",
                            "",
                        ]
                    }
                },
                "L2": {
                    "thu2": {
                        "sang": [
                            "",
                            "",
                            {"mon": "Art", "fixed": True},
                            "",
                            "",
                        ]
                    }
                },
            },
        }
        settings = {
            "solver_mode": "auto",
            "auto_sort_mode": "fast",
            "auto_sort_strategy": "preserve_existing",
            "preserve_existing_tkb": True,
            "preserve_fixed_lessons_only": True,
            "force_preserve_partial_existing": True,
            "partial_existing_rebuild": True,
            "repair_fill_first": True,
            "repair_partial_existing": True,
            "repair_fill_first_max_missing": 4,
            "repair_residual_lns_time_limit_seconds": 1,
            "ui_constraint_change_repair": True,
            "allow_quality_debt": True,
            "max_one_period_sessions": "off",
            "strict_one_period_sessions_cap": False,
            "enforce_max_one_period_sessions": False,
            "session_time_limit": 5,
            "period_time_limit": 5,
            "overall_time_limit_seconds": 10,
            "best_effort_on_timeout": False,
            "minimize_sessions": True,
            "minimize_one_period_sessions": True,
            "allow_one_period_gaps": True,
            "num_workers": 1,
        }

        payload = solve_from_ui_data(data, settings)

        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["scheduled_periods"], 4)
        self.assertEqual(payload["metrics"]["expected_periods"], 4)
        hint = payload["solver"]["session_solver"]["hint"]
        self.assertEqual(
            hint["repair_kind"],
            "bounded_residual_class_lns",
            json.dumps(payload, ensure_ascii=False, default=str),
        )
        self.assertEqual(hint["one_period_cluster_classes"], ["6/1"])
        self.assertGreater(hint["changed_hint_periods"], 0)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        self.assertFalse(
            any("Con 1 buoi" in str(warning) for warning in payload.get("warnings", [])),
            json.dumps(payload, ensure_ascii=False, default=str),
        )

    def test_partial_incumbent_is_a_soft_session_hint_when_direct_fill_is_disabled(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {"L1": {"thu2": {"sang": [{"mon": "Math"}, "", "", "", ""]}}},
        }

        payload = solve_from_ui_data(
            data,
            {
                "solver_mode": "session_cp_sat",
                "preserve_existing_tkb": True,
                "force_preserve_partial_existing": True,
                "auto_sort_strategy": "preserve_existing",
                "repair_fill_first_max_missing": 0,
                "max_teacher_sessions": 1,
                "session_time_limit": 5,
                "period_time_limit": 5,
                "period_fast_time_limit": 5,
                "period_retry_time_limit": 5,
                "overall_time_limit_seconds": 20,
                "best_effort_on_timeout": False,
                "minimize_sessions": True,
                "minimize_one_period_sessions": True,
                "max_one_period_sessions": 0,
                "strict_one_period_sessions_cap": True,
                "allow_one_period_gaps": True,
                "num_workers": 1,
            },
        )

        hint = payload["solver"]["session_solver"]["hint"]
        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertTrue(hint["used"])
        self.assertFalse(hint["fixed"])
        self.assertTrue(hint["repair"])
        self.assertTrue(hint["minimize_distance"])
        self.assertEqual(hint["hinted_assignment_sessions"], 1)

    def test_hard_and_soft_incumbent_does_not_emit_missing_assignment_warning_for_hard_cell(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [
                {"magv": "T0", "ten": "T0"},
                {"magv": "T1", "ten": "T1"},
            ],
            "monhoc": [
                {"ten": "Flag", "ma": "F"},
                {"ten": "Math", "ma": "M"},
            ],
            "mon": [
                {"khoi": "6", "ten": "Flag", "sotiet": 1, "gioihan": 1},
                {"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2},
            ],
            "pccmMatrix": {"L1|Flag": "T0", "L1|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Flag", "fixed": True},
                            {"mon": "Math"},
                            "",
                            "",
                            "",
                        ]
                    }
                }
            },
        }

        payload = solve_from_ui_data(
            data,
            {
                "solver_mode": "auto",
                "auto_sort_strategy": "preserve_existing",
                "preserve_existing_tkb": True,
                "preserve_fixed_lessons_only": True,
                "force_preserve_partial_existing": True,
                "repair_fill_first": True,
                "repair_partial_existing": True,
                "ui_unified_partial_repair": True,
                "repair_fill_first_max_missing": 3,
                "allow_quality_debt": True,
                "max_one_period_sessions": "off",
                "strict_one_period_sessions_cap": False,
                "allow_one_period_gaps": True,
                "period_max_teacher_gap": 1,
                "overall_time_limit_seconds": 10,
                "session_time_limit": 5,
                "period_time_limit": 5,
                "period_fast_time_limit": 5,
                "period_retry_time_limit": 5,
                "best_effort_on_timeout": True,
                "minimize_sessions": True,
                "minimize_one_period_sessions": True,
                "num_workers": 1,
            },
        )

        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["scheduled_periods"], 3)
        self.assertEqual(payload["solver"]["runtime_settings"]["fixed_existing_lessons"], 1)
        self.assertEqual(payload["solver"]["runtime_settings"]["soft_existing_hint_lessons"], 1)
        self.assertFalse(
            any(
                "khong co phan cong" in str(warning).casefold()
                for warning in payload.get("warnings", [])
            )
        )

    def test_max_dispatch_strips_old_schedule_but_keeps_user_fixed_cells(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math", "fixed": True},
                            {"mon": "Math"},
                            "",
                            "",
                            "",
                        ]
                    }
                }
            },
            "tkbSolverResult": {"lessons": [{"subject": "stale"}]},
        }
        captured: dict[str, object] = {}

        def fake_max(next_data, *_args, **_kwargs):
            captured.update(next_data)
            return {"ok": True}

        with patch(
            "tkb_new.adapter._solve_teacher_session_optimized_from_ui_data",
            side_effect=fake_max,
        ):
            solve_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "fresh_teacher_session_opt",
                    "preserve_fixed_lessons_only": True,
                },
            )

        self.assertTrue(captured["__tkbBackendStrippedSchedule"])
        self.assertNotIn("tkbSolverResult", captured)
        kept = captured["tkb"]["L1"]["thu2"]["sang"]  # type: ignore[index]
        self.assertEqual(kept[0], {"mon": "Math", "fixed": True})
        self.assertEqual(kept[1], "")

    def test_complete_first_cap_scales_from_school_shape(self) -> None:
        bounds = {
            "expected_periods": 1566,
            "lower_cap": 346,
            "start_cap": 461,
            "upper_cap": 1116,
        }
        cap = _complete_first_teacher_session_cap(bounds, {"class_count": 54})

        self.assertEqual(cap, 522)
        self.assertGreater(cap, bounds["start_cap"])
        self.assertLessEqual(cap, bounds["upper_cap"])

    def test_one_period_quality_cut_targets_the_affected_session_vector(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[Assignment("6/1", "6", "Math", "T1", 2, 2)],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={("6", "Math"): 2},
            limits_by_grade_subject={("6", "Math"): 2},
        )
        allocations = [
            SessionAllocation(
                class_name="6/1",
                grade="6",
                subject="Math",
                teacher="T1",
                session=Session(day=2, part="AM"),
                count=1,
            )
        ]
        singleton = [Lesson("6/1", "6", 2, "AM", 1, "Math", "T1")]

        self.assertEqual(
            _cut_for_one_period_teacher_sessions(data, allocations, singleton),
            [(0, {0: 1})],
        )
        self.assertEqual(
            _cut_for_one_period_teacher_sessions(
                data,
                allocations,
                [*singleton, Lesson("6/1", "6", 2, "AM", 2, "Math", "T1")],
            ),
            [],
        )

    def test_session_cp_sat_stops_after_reaching_quality_threshold(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "Khá»‘i 6"), ClassInfo("6/2", "Khá»‘i 6")],
            assignments=[
                Assignment("6/1", "Khá»‘i 6", "ToÃ¡n", "GV1", 4, 2),
                Assignment("6/2", "Khá»‘i 6", "ToÃ¡n", "GV1", 4, 2),
            ],
            teachers=["GV1"],
            subjects=["ToÃ¡n"],
            periods_by_grade_subject={("Khá»‘i 6", "ToÃ¡n"): 4},
            limits_by_grade_subject={("Khá»‘i 6", "ToÃ¡n"): 2},
        )

        allocations, metrics = solve_session_allocation_cp_sat(
            data,
            max_teacher_sessions=4,
            max_one_period_sessions=0,
            time_limit_seconds=10,
            early_stop_teacher_sessions=4,
            early_stop_max_one_period_sessions=0,
            num_workers=1,
        )

        self.assertEqual(sum(item.count for item in allocations), 8)
        self.assertTrue(metrics["early_stop_enabled"])
        self.assertTrue(metrics["early_stop_hit"])
        self.assertLessEqual(metrics["teacher_sessions"], 4)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertGreaterEqual(metrics["solutions_seen"], 1)
        self.assertEqual(metrics["linearization_level"], 1)

    def test_session_cp_sat_period_bridge_enforces_teacher_edge_period_pair(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "6"), ClassInfo("6/2", "6")],
            assignments=[
                Assignment("6/1", "6", "Math", "T1", 1, 1),
                Assignment("6/2", "6", "Science", "T1", 1, 1),
            ],
            teachers=["T1"],
            subjects=["Math", "Science"],
            periods_by_grade_subject={("6", "Math"): 1, ("6", "Science"): 1},
            limits_by_grade_subject={("6", "Math"): 1, ("6", "Science"): 1},
        )
        all_slots = {
            (day, part, period)
            for day in range(2, 8)
            for part, count in (("AM", 5), ("PM", 5))
            for period in range(1, count + 1)
        }
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={
                    "class": {
                        "6/1": frozenset(all_slots - {(2, "AM", 5)}),
                        "6/2": frozenset(all_slots - {(2, "PM", 1)}),
                    }
                },
                teacher={
                    "T1": {
                        "noMorningP5AfternoonP1": {
                            "sang": {"thu2": True}
                        }
                    }
                },
                subject={},
                subject_group={},
            )
        )

        with self.assertRaises(SessionCpSatNoSolution):
            solve_session_allocation_cp_sat(
                data,
                rules=rules,
                max_teacher_sessions=2,
                max_one_period_sessions=None,
                period_feasibility_session_indexes={0, 6},
                time_limit_seconds=5,
                num_workers=1,
            )

    def test_session_cp_sat_materializes_a_zero_single_gap1_period_solution(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "6"), ClassInfo("6/2", "6")],
            assignments=[
                Assignment("6/1", "6", "Math", "T1", 1, 1),
                Assignment("6/2", "6", "Science", "T1", 1, 1),
            ],
            teachers=["T1"],
            subjects=["Math", "Science"],
            periods_by_grade_subject={("6", "Math"): 1, ("6", "Science"): 1},
            limits_by_grade_subject={("6", "Math"): 1, ("6", "Science"): 1},
        )
        all_slots = {
            (day, part, period)
            for day in range(2, 8)
            for part in ("AM", "PM")
            for period in range(1, 6)
        }
        rules = TimetableRuleSet(
            constraints=TimetableConstraintRules(
                groups={},
                group_names={},
                fixed_off={
                    "class": {
                        "6/1": frozenset(all_slots - {(2, "AM", 1)}),
                        "6/2": frozenset(all_slots - {(2, "AM", 3), (2, "AM", 4)}),
                    }
                },
                teacher={},
                subject={},
                subject_group={},
            )
        )

        allocations, metrics = solve_session_allocation_cp_sat(
            data,
            rules=rules,
            max_teacher_sessions=1,
            max_one_period_sessions=0,
            minimize_sessions=False,
            minimize_one_period_sessions=False,
            period_feasibility_session_indexes=set(range(12)),
            period_max_teacher_gap=1,
            materialize_period_lessons=True,
            linearization_level=0,
            time_limit_seconds=5,
            num_workers=1,
        )

        self.assertEqual(sum(item.count for item in allocations), 2)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertTrue(metrics["period_bridge_materialization_complete"])
        self.assertGreater(metrics["teacher_period_gap_constraints"], 0)
        rows = metrics["period_bridge_lessons"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(sorted(int(item["period"]) for item in rows), [1, 3])

    def test_session_cp_sat_linearization_profile_is_clamped_and_overridable(self) -> None:
        self.assertEqual(_session_cp_sat_linearization_level({}), 1)
        self.assertEqual(_session_cp_sat_linearization_level({"session_cp_sat_linearization_level": 2}), 2)
        self.assertEqual(_session_cp_sat_linearization_level({"session_cp_sat_linearization_level": 99}), 2)
        self.assertEqual(_session_cp_sat_linearization_level({"session_cp_sat_linearization_level": -1}), 0)

    def test_session_cp_sat_keeps_searching_when_quality_threshold_is_unreachable(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "Khá»‘i 6"), ClassInfo("6/2", "Khá»‘i 6")],
            assignments=[
                Assignment("6/1", "Khá»‘i 6", "ToÃ¡n", "GV1", 4, 2),
                Assignment("6/2", "Khá»‘i 6", "ToÃ¡n", "GV1", 4, 2),
            ],
            teachers=["GV1"],
            subjects=["ToÃ¡n"],
            periods_by_grade_subject={("Khá»‘i 6", "ToÃ¡n"): 4},
            limits_by_grade_subject={("Khá»‘i 6", "ToÃ¡n"): 2},
        )

        allocations, metrics = solve_session_allocation_cp_sat(
            data,
            max_teacher_sessions=4,
            max_one_period_sessions=0,
            time_limit_seconds=10,
            early_stop_teacher_sessions=1,
            early_stop_max_one_period_sessions=0,
            num_workers=1,
        )

        self.assertEqual(sum(item.count for item in allocations), 8)
        self.assertTrue(metrics["early_stop_enabled"])
        self.assertFalse(metrics["early_stop_hit"])
        self.assertGreater(metrics["teacher_sessions"], 1)

    def test_session_cp_sat_uses_incumbent_distance_only_after_quality(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "6")],
            assignments=[Assignment("6/1", "6", "Math", "T1", 2, 2)],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={("6", "Math"): 2},
            limits_by_grade_subject={("6", "Math"): 2},
        )
        hint = [
            SessionAllocation("6/1", "6", "Math", "T1", Session(2, "AM"), 2),
        ]

        allocations, metrics = solve_session_allocation_cp_sat(
            data,
            max_teacher_sessions=2,
            max_one_period_sessions=0,
            minimize_sessions=True,
            minimize_one_period_sessions=True,
            hint_allocations=hint,
            repair_hint=True,
            minimize_hint_distance=True,
            time_limit_seconds=5,
            num_workers=1,
        )

        self.assertEqual(sum(item.count for item in allocations), 2)
        self.assertTrue(metrics["objective_mode"].endswith("_then_hint_distance"))
        self.assertGreater(metrics["hint_distance_quality_scale"], 1)
        self.assertGreater(
            metrics["hint_distance_quality_scale"],
            metrics["hint_distance_upper_bound"],
        )

    def test_period_limit_counts_distinct_subjects_not_lesson_events(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("6/1", "Khối 6"), ClassInfo("6/2", "Khối 6")],
            assignments=[
                Assignment("6/1", "Khối 6", "Toán", "GV1", 1, 1),
                Assignment("6/2", "Khối 6", "Toán", "GV2", 1, 1),
            ],
            teachers=["GV1", "GV2"],
            subjects=["Toán"],
            periods_by_grade_subject={("Khối 6", "Toán"): 1},
            limits_by_grade_subject={("Khối 6", "Toán"): 1},
        )
        off = frozenset((2, "AM", period) for period in (2, 3, 4, 5))
        constraints = TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={
                "class": {"6/1": off, "6/2": off},
                "teacher": {},
                "subject": {},
                "room": {},
                "subjectGroup": {},
            },
            teacher={},
            subject={},
            subject_group={},
            time_limit=(
                {
                    "name": "Một môn tại một thời điểm",
                    "targetType": "subject",
                    "targetId": "Toán",
                    "perSlot": {"subjects": 1},
                },
            ),
        )
        rules = TimetableRuleSet(constraints=constraints)
        session = Session(2, "AM")
        allocations = [
            SessionAllocation("6/1", "Khối 6", "Toán", "GV1", session, 1),
            SessionAllocation("6/2", "Khối 6", "Toán", "GV2", session, 1),
        ]

        lessons, _metrics = allocate_periods(
            data,
            allocations,
            rules=rules,
            time_limit_seconds_per_session=5,
            verbose=False,
        )
        self.assertEqual(len(lessons), 2)
        self.assertEqual({lesson.period for lesson in lessons}, {1})
        self.assertTrue(compute_metrics(data, lessons, rules=rules)["hard_ok"])

    def test_validator_rejects_out_of_domain_lesson_slot(self) -> None:
        ctx = _context()
        invalid = Lesson(
            class_name="6/1",
            grade="Khối 6",
            day=9,
            session="AM",
            period=99,
            subject="Toán",
            teacher="GV1",
        )

        metrics = compute_metrics(ctx.school_data, [invalid])
        self.assertFalse(metrics["core_hard_ok"])
        self.assertFalse(metrics["hard_ok"])
        self.assertEqual(metrics["invalid_lesson_slot_count"], 1)
        self.assertEqual(
            metrics["invalid_lesson_slots"][0]["reason"],
            "invalid_day_or_session",
        )

    def test_validator_applies_teacher_day_rules_on_saturday(self) -> None:
        ctx = _context()
        constraints = TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={"class": {}, "teacher": {}, "subject": {}, "room": {}, "subjectGroup": {}},
            teacher={"GV1": {"oneSessionPerDay": {"thu7": True}}},
            subject={},
            subject_group={},
        )
        rules = TimetableRuleSet(constraints=constraints)
        lessons = [
            Lesson("6/1", "Khối 6", 7, "AM", 1, "Toán", "GV1"),
            Lesson("6/1", "Khối 6", 7, "PM", 1, "Toán", "GV1"),
        ]

        result = validate_app_constraints(ctx.school_data, lessons, rules)
        self.assertFalse(result["hard_ok"])
        self.assertIn(
            "teacher.oneSessionPerDay",
            {item["kind"] for item in result["violations"]},
        )

    def test_max_mode_short_budget_is_not_silently_expanded_or_starved(self) -> None:
        settings = {
            "overall_time_limit_seconds": 30,
            "optimization_time_limit_seconds": 30,
            "period_time_limit": 90,
            "optimization_period_retry_time_limit": 45,
            "target_teacher_sessions": 14,
            "session_early_stop_teacher_sessions": 14,
            "session_early_stop_enabled": True,
        }
        bounds = {
            "lower_cap": 10,
            "start_cap": 12,
            "upper_cap": 20,
            "expected_periods": 40,
        }

        warmup = _teacher_session_opt_fast_quality_settings(settings, bounds)
        self.assertEqual(warmup["overall_time_limit_seconds"], 30)
        self.assertLessEqual(warmup["period_retry_time_limit"] + 4, 14)
        self.assertGreaterEqual(warmup["session_time_limit"], 4)
        self.assertEqual(warmup["session_early_stop_teacher_sessions"], 14)

        attempt = _teacher_session_opt_attempt_settings(
            settings,
            cap=12,
            target_teacher_sessions=None,
            target_gap1_sessions=None,
            time_limit_seconds=30,
            lower_cap=10,
        )
        reserve = max(12, attempt["period_retry_time_limit"] + 4)
        self.assertEqual(attempt["overall_time_limit_seconds"], 30)
        self.assertGreaterEqual(attempt["session_time_limit"], 4)
        self.assertLessEqual(attempt["session_time_limit"] + reserve + 2, 30)
        self.assertEqual(attempt["session_early_stop_teacher_sessions"], 12)

    def test_large_fresh_warmup_gives_feasibility_search_a_safe_60s_share(self) -> None:
        warmup = _teacher_session_opt_fast_quality_settings(
            {
                "overall_time_limit_seconds": 60,
                "optimization_time_limit_seconds": 60,
                "session_time_limit": 60,
                "period_time_limit": 60,
                "target_teacher_sessions": 482,
                "optimization_accept_teacher_sessions": 482,
            },
            {
                "lower_cap": 450,
                "start_cap": 466,
                "upper_cap": 650,
                "expected_periods": 1566,
            },
        )

        self.assertEqual(warmup["overall_time_limit_seconds"], 60)
        self.assertEqual(warmup["session_time_limit"], 41)
        self.assertEqual(warmup["period_time_limit"], 15)
        self.assertEqual(warmup["period_retry_time_limit"], 15)
        reserve = max(12, warmup["period_retry_time_limit"] + 4)
        self.assertLessEqual(warmup["session_time_limit"] + reserve, 60)

    def test_missing_gap1_bucket_is_zero_when_distribution_exists(self) -> None:
        metrics = {
            "teacher_sessions": 12,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 12},
        }

        self.assertEqual(_teacher_session_opt_gap1(metrics), 0)
        self.assertEqual(_teacher_session_opt_quality(metrics)[3], 0)
        self.assertEqual(_teacher_session_opt_gap1({"teacher_sessions": 12}), 10**9)

    def test_max_ranking_requires_a_pareto_teacher_quality_improvement(self) -> None:
        incumbent = {
            "teacher_sessions": 465,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 425, 1: 40},
        }
        candidate = {
            "teacher_sessions": 472,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 437, 1: 35},
        }

        self.assertFalse(
            _teacher_session_opt_goal_aware_better(
                candidate,
                incumbent,
                target_teacher_sessions=346,
                target_gap1_sessions=0,
                accept_teacher_sessions=482,
                accept_gap1_sessions=53,
            )
        )
        pareto_candidate = dict(candidate, teacher_sessions=465)
        self.assertTrue(
            _teacher_session_opt_goal_aware_better(
                pareto_candidate,
                incumbent,
                target_teacher_sessions=346,
                target_gap1_sessions=0,
                accept_teacher_sessions=482,
                accept_gap1_sessions=53,
            )
        )
        self.assertEqual(
            _teacher_session_opt_quality(candidate, gap1_first=True)[:4],
            (0, 35, 0, 472),
        )

    def test_max_warmup_early_stop_prefers_target_over_accept(self) -> None:
        settings = {
            "target_teacher_sessions": 10,
            "optimization_accept_teacher_sessions": 20,
            "session_early_stop_teacher_sessions": 18,
            "overall_time_limit_seconds": 30,
            "optimization_time_limit_seconds": 30,
        }
        bounds = {
            "lower_cap": 10,
            "start_cap": 15,
            "upper_cap": 30,
            "expected_periods": 50,
        }

        warmup = _teacher_session_opt_fast_quality_settings(settings, bounds)
        self.assertEqual(warmup["session_early_stop_teacher_sessions"], 10)

        attempt = _teacher_session_opt_attempt_settings(
            settings,
            cap=20,
            target_teacher_sessions=10,
            target_gap1_sessions=None,
            time_limit_seconds=30,
            lower_cap=10,
        )
        self.assertEqual(attempt["session_early_stop_teacher_sessions"], 10)

    def test_accept_threshold_does_not_stop_before_target(self) -> None:
        accepted_fallback = {
            "hard_ok": True,
            "scheduled_periods": 24,
            "expected_periods": 24,
            "unassigned_periods": 0,
            "app_constraint_violation_count": 0,
            "teacher_sessions": 12,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 12},
        }
        target = dict(accepted_fallback, teacher_sessions=10)

        self.assertFalse(
            _teacher_session_opt_should_stop(
                accepted_fallback,
                target_teacher_sessions=10,
                target_gap1_sessions=None,
                accept_teacher_sessions=12,
                accept_gap1_sessions=0,
            )
        )
        self.assertTrue(
            _teacher_session_opt_should_stop(
                target,
                target_teacher_sessions=10,
                target_gap1_sessions=None,
                accept_teacher_sessions=12,
                accept_gap1_sessions=0,
            )
        )

    def test_quality_target_never_hides_gap2_or_hard_debt(self) -> None:
        clean = {
            "hard_ok": True,
            "scheduled_periods": 24,
            "expected_periods": 24,
            "unassigned_periods": 0,
            "app_constraint_violation_count": 0,
            "teacher_sessions": 10,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 10},
        }
        settings = {
            "target_teacher_sessions": 10,
            "target_gap1_sessions": 0,
            "accept_teacher_sessions": 12,
            "accept_gap1_sessions": 0,
        }

        def should_stop(metrics: dict[str, object]) -> bool:
            return _teacher_session_opt_should_stop(
                metrics,
                target_teacher_sessions=settings["target_teacher_sessions"],
                target_gap1_sessions=settings["target_gap1_sessions"],
                accept_teacher_sessions=settings["accept_teacher_sessions"],
                accept_gap1_sessions=settings["accept_gap1_sessions"],
            )

        self.assertTrue(should_stop(clean))
        self.assertFalse(should_stop({**clean, "gap_distribution": {0: 9, 2: 1}}))
        self.assertFalse(should_stop({**clean, "one_period_teacher_sessions": 1}))
        self.assertFalse(should_stop({**clean, "hard_ok": False}))
        self.assertFalse(should_stop({**clean, "scheduled_periods": 23}))
        self.assertFalse(should_stop({**clean, "unassigned_periods": 1}))
        self.assertFalse(should_stop({**clean, "app_constraint_violation_count": 1}))

    def test_balanced_quality_envelope_rejects_visible_regressions(self) -> None:
        incumbent = {
            "teacher_sessions": 464,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 419, 1: 45},
        }
        base = {
            "target_teacher_sessions": None,
            "target_gap1_sessions": None,
            "accept_teacher_sessions": 482,
            "accept_gap1_sessions": 53,
            "enforce_balanced_envelope": True,
        }
        self.assertFalse(
            _teacher_session_opt_goal_aware_better(
                {**incumbent, "one_period_teacher_sessions": 1},
                incumbent,
                **base,
            )
        )
        self.assertFalse(
            _teacher_session_opt_goal_aware_better(
                {**incumbent, "gap_distribution": {0: 419, 2: 1}},
                incumbent,
                **base,
            )
        )
        self.assertFalse(
            _teacher_session_opt_goal_aware_better(
                {**incumbent, "teacher_sessions": 465},
                incumbent,
                **base,
            )
        )
        self.assertTrue(
            _teacher_session_opt_goal_aware_better(
                {**incumbent, "teacher_sessions": 463},
                incumbent,
                **base,
            )
        )
        dirty_incumbent = {
            **incumbent,
            "one_period_teacher_sessions": 1,
        }
        self.assertFalse(
            _teacher_session_opt_goal_aware_better(
                {
                    **dirty_incumbent,
                    "teacher_sessions": 469,
                    "one_period_teacher_sessions": 0,
                },
                dirty_incumbent,
                **base,
            )
        )
        self.assertTrue(
            _teacher_session_opt_goal_aware_better(
                {
                    **dirty_incumbent,
                    "one_period_teacher_sessions": 0,
                },
                dirty_incumbent,
                **base,
            )
        )
        self.assertFalse(
            _teacher_session_opt_goal_aware_better(
                {
                    **incumbent,
                    "teacher_sessions": 463,
                    "gap_distribution": {0: 410, 1: 53},
                },
                incumbent,
                **base,
            )
        )
        self.assertTrue(
            _teacher_session_opt_goal_aware_better(
                {
                    **incumbent,
                    "teacher_sessions": 463,
                },
                incumbent,
                **base,
            )
        )
        self.assertFalse(
            _teacher_session_opt_within_balanced_envelope(
                {
                    **incumbent,
                    "teacher_sessions": 463,
                    "gap_distribution": {0: 408, 1: 55},
                },
                incumbent,
            )
        )
        self.assertTrue(
            _teacher_session_opt_within_balanced_envelope(
                {
                    **incumbent,
                    "teacher_sessions": 463,
                    "gap_distribution": {0: 420, 1: 43},
                    "teacher_gap1_session_imbalance": 3,
                },
                {
                    **incumbent,
                    "teacher_gap1_session_imbalance": 2,
                },
            )
        )

    def test_incremental_best_so_far_rejects_every_visible_regression(self) -> None:
        incumbent = {
            "teacher_sessions": 10,
            "one_period_teacher_sessions": 2,
            "gap_distribution": {0: 8, 1: 2},
        }
        self.assertFalse(
            _incremental_refinement_candidate_better(
                {
                    **incumbent,
                    "one_period_teacher_sessions": 1,
                    "gap_distribution": {0: 2, 1: 8},
                },
                incumbent,
            )
        )
        self.assertFalse(
            _incremental_refinement_candidate_better(
                {
                    **incumbent,
                    "one_period_teacher_sessions": 1,
                    "gap_distribution": {0: 0, 1: 11},
                },
                incumbent,
            )
        )

        clean_incumbent = {
            "teacher_sessions": 468,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 428, 1: 40},
        }
        self.assertFalse(
            _incremental_refinement_candidate_better(
                {
                    **clean_incumbent,
                    "teacher_sessions": 467,
                    "gap_distribution": {0: 423, 1: 44},
                },
                clean_incumbent,
            )
        )
        self.assertTrue(
            _incremental_refinement_candidate_better(
                {
                    **clean_incumbent,
                    "teacher_sessions": 467,
                },
                clean_incumbent,
            )
        )
        self.assertFalse(
            _incremental_refinement_candidate_better(
                {
                    **clean_incumbent,
                    "teacher_sessions": 467,
                    "gap_distribution": {0: 422, 1: 45},
                },
                clean_incumbent,
            )
        )
        self.assertFalse(
            _incremental_refinement_candidate_better(
                {
                    **incumbent,
                    "one_period_teacher_sessions": 2,
                    "gap_distribution": {0: 7, 1: 3},
                },
                incumbent,
            )
        )

    def test_local_gap_encoding_rejects_two_internal_holes(self) -> None:
        cp_model = _load_cp_model()

        bad_model = cp_model.CpModel()
        bad_occupancy = [bad_model.NewBoolVar(f"bad_{index}") for index in range(5)]
        for var, value in zip(bad_occupancy, [1, 1, 0, 0, 1], strict=True):
            bad_model.Add(var == value)
        _add_at_most_one_internal_gap_constraints(bad_model, bad_occupancy)
        bad_status = cp_model.CpSolver().Solve(bad_model)
        self.assertEqual(bad_status, cp_model.INFEASIBLE)

        good_model = cp_model.CpModel()
        good_occupancy = [good_model.NewBoolVar(f"good_{index}") for index in range(5)]
        for var, value in zip(good_occupancy, [1, 1, 0, 1, 1], strict=True):
            good_model.Add(var == value)
        _add_at_most_one_internal_gap_constraints(good_model, good_occupancy)
        good_status = cp_model.CpSolver().Solve(good_model)
        self.assertIn(good_status, (cp_model.OPTIMAL, cp_model.FEASIBLE))

    def test_large_refinement_round_uses_a_new_bounded_seed_portfolio(self) -> None:
        data = _context().school_data

        first = _school_refinement_seed_sequence(data, 1, 4)
        repeated = _school_refinement_seed_sequence(data, 1, 4)
        large_round = _school_refinement_seed_sequence(data, 1_000_033, 4)
        request_seed_a = _school_refinement_seed_sequence(data, 1, 4, 17)
        request_seed_a_repeated = _school_refinement_seed_sequence(data, 1, 4, 17)
        request_seed_b = _school_refinement_seed_sequence(data, 1, 4, 18)

        self.assertEqual(first, repeated)
        self.assertEqual(len(large_round), 4)
        self.assertEqual(len(set(large_round)), 4)
        self.assertNotEqual(first, large_round)
        self.assertEqual(request_seed_a, request_seed_a_repeated)
        self.assertNotEqual(request_seed_a, request_seed_b)
        self.assertEqual(_refinement_request_seed({"random_seed": 17, "quality_variant_seed": 17}), 17)
        self.assertNotEqual(
            _refinement_request_seed({"random_seed": 17, "quality_variant_seed": 18}),
            17,
        )

    def test_request_seed_changes_local_refinement_pass_but_remains_repeatable(self) -> None:
        ctx = _context()
        assignment = ctx.school_data.assignments[0]
        lessons = [
            Lesson(
                assignment.class_name,
                assignment.grade,
                day,
                "AM",
                1,
                assignment.subject,
                assignment.teacher,
            )
            for day in (2, 3)
        ]
        incumbent = build_payload(ctx, lessons, {}, ctx.rules)

        def pass_seeds(request_seed: int) -> tuple[int | None, ...]:
            seen: list[int | None] = []

            def no_change(*_args, random_seed=None, **_kwargs):
                seen.append(random_seed)
                return None

            with patch(
                "tkb_new.adapter._repair_one_period_affected_class_cluster",
                side_effect=no_change,
            ):
                result = _polish_complete_incumbent_with_local_lns(
                    {},
                    {
                        "optimization_refinement_round": 1,
                        "random_seed": request_seed,
                        "quality_variant_seed": request_seed,
                        "optimization_existing_local_quality_lns_passes": 1,
                        "optimization_existing_local_quality_lns_pass_seconds": 1,
                        "optimization_existing_local_quality_lns_stagnant_passes": 1,
                        "num_workers": 1,
                    },
                    ctx,
                    incumbent,
                    rules=None,
                    polish_seeds=[],
                    time_limit_seconds=1.5,
                )
            self.assertIsNone(result)
            return tuple(seen)

        first = pass_seeds(17)
        repeated = pass_seeds(17)
        different = pass_seeds(18)
        self.assertEqual(len(first), 1)
        self.assertEqual(first, repeated)
        self.assertNotEqual(first, different)

    def test_durable_refinement_learning_merges_cumulative_snapshots(self) -> None:
        data = _context().school_data
        signature = _refinement_learning_from_payload(None, data)["school_signature"]
        older = {
            "version": 2,
            "school_signature": signature,
            "total_attempts": 2,
            "operators": {
                "session_merge": {
                    "attempts": 2,
                    "improvements": 1,
                    "reward": 4.2,
                    "seconds": 3.5,
                    "last_round": 1,
                }
            },
        }
        newer = {
            "solver": {
                "runtime_settings": {
                    "refinement_learning": {
                        "version": 2,
                        "school_signature": signature,
                        "total_attempts": 4,
                        "operators": {
                            "session_merge": {
                                "attempts": 3,
                                "improvements": 2,
                                "reward": 8.4,
                                "seconds": 6.5,
                                "last_round": 2,
                            },
                            "gap1": {
                                "attempts": 1,
                                "improvements": 0,
                                "reward": 0.0,
                                "seconds": 2.0,
                                "last_round": 2,
                            },
                        },
                    }
                }
            }
        }

        parsed_direct = _refinement_learning_from_payload(older, data)
        merged = _merge_refinement_learning(data, newer, older)

        self.assertEqual(parsed_direct["total_attempts"], 2)
        self.assertEqual(merged["total_attempts"], 4)
        self.assertEqual(merged["operators"]["session_merge"]["attempts"], 3)
        self.assertEqual(merged["operators"]["session_merge"]["last_round"], 2)
        self.assertEqual(merged["operators"]["gap1"]["attempts"], 1)

    def test_1566_period_incremental_profile_widens_but_stays_under_one_minute(self) -> None:
        first = _incremental_lns_profile({}, 1, 1566)
        second = _incremental_lns_profile({}, 2, 1566)
        third = _incremental_lns_profile({}, 3, 1566)

        self.assertEqual(
            [first["max_classes"], second["max_classes"], third["max_classes"]],
            [8, 10, 12],
        )
        self.assertEqual(
            [first["max_lessons"], second["max_lessons"], third["max_lessons"]],
            [300, 360, 420],
        )
        self.assertEqual([first["passes"], second["passes"], third["passes"]], [4, 5, 6])
        self.assertEqual(
            [first["budget_seconds"], second["budget_seconds"], third["budget_seconds"]],
            [28.0, 34.0, 40.0],
        )
        self.assertTrue(all(profile["budget_seconds"] < 60 for profile in (first, second, third)))
        capped = _incremental_lns_profile(
            {"optimization_existing_local_quality_lns_time_limit_seconds": 500},
            99,
            1566,
        )
        self.assertEqual(capped["budget_seconds"], 50.0)

    def test_incremental_operator_policy_starts_with_one_period_debt(self) -> None:
        learning = {
            "total_attempts": 4,
            "operators": {
                "session_merge": {
                    "attempts": 4,
                    "improvements": 4,
                    "reward": 100.0,
                    "seconds": 1.0,
                }
            },
        }
        selected, detail = _select_refinement_operator(
            learning,
            {
                "one_period_teacher_sessions": 3,
                "teacher_sessions": 20,
                "gap_distribution": {0: 17, 1: 3},
            },
            refinement_round=3,
            pass_index=0,
            random_seed=17,
        )
        self.assertEqual(selected, "one_period")
        self.assertEqual(detail["priority"], 4.0)

        selected_after_primary, exploration_detail = _select_refinement_operator(
            learning,
            {
                "one_period_teacher_sessions": 0,
                "teacher_sessions": 20,
                "gap_distribution": {0: 20},
            },
            refinement_round=3,
            pass_index=1,
            random_seed=17,
        )
        self.assertEqual(selected_after_primary, "mixed")
        self.assertEqual(exploration_detail["exploration"], 8.0)

    def test_incremental_alns_records_operator_cost_across_stagnant_passes(self) -> None:
        ctx = _context()
        assignment = ctx.school_data.assignments[0]
        lessons = [
            Lesson(
                assignment.class_name,
                assignment.grade,
                2,
                "AM",
                1,
                assignment.subject,
                assignment.teacher,
            ),
            Lesson(
                assignment.class_name,
                assignment.grade,
                3,
                "AM",
                1,
                assignment.subject,
                assignment.teacher,
            ),
        ]
        metrics = compute_metrics(ctx.school_data, lessons, rules=ctx.rules)
        incumbent = build_payload(
            ctx,
            lessons,
            {"validation": metrics, "period_solver": {}},
            ctx.rules,
        )
        learning: dict = {}

        with (
            patch("tkb_new.adapter._extract_hard_fixed_lessons_from_tkb", return_value=([], [])),
            patch("tkb_new.adapter._repair_one_period_affected_class_cluster", return_value=None) as repair,
        ):
            result = _polish_complete_incumbent_with_local_lns(
                {},
                {
                    "optimization_refinement_round": 2,
                    "optimization_existing_local_quality_lns_passes": 3,
                    "optimization_existing_local_quality_lns_stagnant_passes": 3,
                    "optimization_existing_local_quality_lns_pass_seconds": 1,
                },
                ctx,
                incumbent,
                rules=ctx.rules,
                polish_seeds=[],
                time_limit_seconds=5,
                operator_learning=learning,
            )

        self.assertIsNone(result)
        self.assertEqual(repair.call_count, 3)
        self.assertEqual(learning["total_attempts"], 3)
        self.assertGreaterEqual(learning["operators"]["one_period"]["attempts"], 1)
        self.assertTrue(all(item["seconds"] >= 0 for item in learning["operators"].values()))

    def test_frontier_cleanup_forces_gap_operator_and_visible_gap_cap(self) -> None:
        ctx = _context()
        lessons = [
            Lesson("6/1", "Khá»‘i 6", 2, "AM", period, "ToÃ¡n", "GV1")
            for period in (1, 3)
        ]
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 1,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {1: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        learning: dict = {}

        with (
            patch("tkb_new.adapter._extract_hard_fixed_lessons_from_tkb", return_value=([], [])),
            patch("tkb_new.adapter._payload_lessons_to_lessons", return_value=lessons),
            patch("tkb_new.adapter._repair_one_period_affected_class_cluster", return_value=None) as repair,
        ):
            result = _polish_complete_incumbent_with_local_lns(
                {},
                {
                    "optimization_existing_local_quality_lns_passes": 2,
                    "optimization_existing_local_quality_lns_stagnant_passes": 2,
                    "optimization_existing_local_quality_lns_pass_seconds": 1,
                },
                ctx,
                incumbent,
                rules=ctx.rules,
                polish_seeds=[],
                time_limit_seconds=3,
                operator_learning=learning,
                gap1_cleanup_cap=0,
            )

        self.assertIsNone(result)
        self.assertEqual(repair.call_count, 2)
        self.assertTrue(all(call.kwargs["max_gap1_sessions"] == 0 for call in repair.call_args_list))
        self.assertTrue(all(call.kwargs["seed_classes"] == ["6/1"] for call in repair.call_args_list))
        self.assertEqual(learning["operators"]["gap1"]["attempts"], 2)

    def test_frontier_cleanup_uses_reserved_budget_past_generic_stagnation(self) -> None:
        ctx = _context()
        lessons = [Lesson("6/1", "6", 2, "AM", 1, "Math", "T1")]
        frontier = _first_click_payload(teacher_sessions=472, gap1=48)
        visible = _first_click_payload(teacher_sessions=482, gap1=42)
        gap46 = _first_click_payload(teacher_sessions=472, gap1=46)
        gap44 = _first_click_payload(teacher_sessions=472, gap1=44)
        cleaned = _first_click_payload(teacher_sessions=472, gap1=42)
        repair_results = [
            None,
            None,
            (lessons, gap46["metrics"], {"repair_kind": "gap_cleanup_48_to_46"}),
            (lessons, gap44["metrics"], {"repair_kind": "gap_cleanup_46_to_44"}),
            (lessons, cleaned["metrics"], {"repair_kind": "gap_cleanup_44_to_42"}),
        ]

        with (
            patch("tkb_new.adapter._extract_hard_fixed_lessons_from_tkb", return_value=([], [])),
            patch("tkb_new.adapter._payload_lessons_to_lessons", return_value=lessons),
            patch(
                "tkb_new.adapter._repair_one_period_affected_class_cluster",
                side_effect=repair_results,
            ) as repair,
            patch("tkb_new.adapter.build_payload", return_value=cleaned),
        ):
            result = _polish_complete_incumbent_with_local_lns(
                {},
                {
                    "optimization_existing_local_quality_lns_passes": 2,
                    "optimization_existing_local_quality_lns_stagnant_passes": 2,
                    "optimization_existing_local_quality_lns_pass_seconds": 1,
                },
                ctx,
                frontier,
                rules=ctx.rules,
                polish_seeds=[],
                time_limit_seconds=5,
                gap1_cleanup_cap=42,
                protected_cleanup_budget=True,
            )

        self.assertIsNotNone(result)
        candidate, passes = result
        self.assertEqual(repair.call_count, 5)
        self.assertEqual(
            [call.kwargs["max_gap1_sessions"] for call in repair.call_args_list],
            [46, 46, 46, 44, 42],
        )
        self.assertEqual(candidate["metrics"]["teacher_sessions"], 472)
        self.assertEqual(_teacher_session_opt_gap1(candidate["metrics"]), 42)
        self.assertEqual(len(passes), 5)
        self.assertFalse(
            _incremental_refinement_candidate_better(gap46["metrics"], visible["metrics"])
        )
        self.assertFalse(
            _incremental_refinement_candidate_better(gap44["metrics"], visible["metrics"])
        )
        self.assertTrue(
            _incremental_refinement_candidate_better(cleaned["metrics"], visible["metrics"])
        )

    def test_incremental_lns_keeps_hard_fixed_lessons_immutable(self) -> None:
        ctx = _context()
        fixed = Lesson("6/1", "Khá»‘i 6", 2, "AM", 1, "ToÃ¡n", "GV1")
        incumbent_lessons = [
            fixed,
            Lesson("6/1", "Khá»‘i 6", 3, "AM", 1, "ToÃ¡n", "GV1"),
        ]
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 2,
                "one_period_teacher_sessions": 2,
                "gap_distribution": {0: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }

        with (
            patch("tkb_new.adapter._extract_hard_fixed_lessons_from_tkb", return_value=([fixed], [])),
            patch("tkb_new.adapter._release_invalid_fixed_lessons") as release_fixed,
            patch("tkb_new.adapter._payload_lessons_to_lessons", return_value=incumbent_lessons),
            patch("tkb_new.adapter._repair_one_period_affected_class_cluster", return_value=None) as repair,
        ):
            result = _polish_complete_incumbent_with_local_lns(
                {},
                {
                    "optimization_refinement_round": 77,
                    "optimization_existing_local_quality_lns_passes": 6,
                    "optimization_existing_local_quality_lns_pass_seconds": 1,
                },
                ctx,
                incumbent,
                rules=ctx.rules,
                polish_seeds=[],
                time_limit_seconds=10,
            )

        self.assertIsNone(result)
        release_fixed.assert_not_called()
        self.assertEqual(repair.call_count, 2)
        self.assertEqual(repair.call_args.kwargs["fixed_lessons"], [fixed])
        self.assertEqual(repair.call_args.kwargs["max_gap1_sessions"], 0)
        self.assertTrue(repair.call_args.kwargs["stop_after_quality_gain"])
        self.assertIs(repair.call_args.kwargs["known_current_metrics"], incumbent["metrics"])

    def test_incremental_lns_rebuilds_validation_core_from_polished_lessons(self) -> None:
        school = SchoolData(
            classes=[ClassInfo("6/1", "6")],
            assignments=[Assignment("6/1", "6", "Math", "T1", 2, 2)],
            teachers=["T1"],
            subjects=["Math"],
            periods_by_grade_subject={("6", "Math"): 2},
            limits_by_grade_subject={("6", "Math"): 2},
        )
        entry = ClassEntry("L1", "6/1", "6", ("L1", "6/1"))
        ctx = UiDataContext(
            school_data=school,
            classes=[entry],
            class_by_name={"6/1": entry},
            rules=TimetableRuleSet(),
            warnings=[],
        )
        incumbent_lessons = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 3, "AM", 1, "Math", "T1"),
        ]
        polished_lessons = [
            Lesson("6/1", "6", 2, "AM", 1, "Math", "T1"),
            Lesson("6/1", "6", 2, "AM", 2, "Math", "T1"),
        ]
        incumbent_metrics = compute_metrics(school, incumbent_lessons, rules=ctx.rules)
        polished_metrics = compute_metrics(school, polished_lessons, rules=ctx.rules)
        incumbent = build_payload(
            ctx,
            incumbent_lessons,
            {"validation": incumbent_metrics, "period_solver": {}},
            ctx.rules,
        )

        with (
            patch("tkb_new.adapter._extract_hard_fixed_lessons_from_tkb", return_value=([], [])),
            patch(
                "tkb_new.adapter._repair_one_period_affected_class_cluster",
                return_value=(polished_lessons, polished_metrics, {"mock_polish": True}),
            ),
        ):
            result = _polish_complete_incumbent_with_local_lns(
                {},
                {
                    "optimization_refinement_round": 2,
                    "optimization_existing_local_quality_lns_passes": 1,
                    "optimization_existing_local_quality_lns_pass_seconds": 1,
                },
                ctx,
                incumbent,
                rules=ctx.rules,
                polish_seeds=[],
                time_limit_seconds=1,
            )

        self.assertIsNotNone(result)
        candidate, _passes = result  # type: ignore[misc]
        metrics = candidate["metrics"]
        core = candidate["validation"]["core"]
        for key in (
            "hard_ok",
            "scheduled_periods",
            "expected_periods",
            "teacher_sessions",
            "one_period_teacher_sessions",
            "gap_distribution",
            "app_constraint_violation_count",
        ):
            self.assertEqual(core.get(key), metrics.get(key), key)
        self.assertEqual(candidate["solver"]["validation"], core)
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(core["teacher_sessions"], 1)

    def test_fixed_singleton_focus_can_join_a_movable_lesson_without_moving_fixed(self) -> None:
        classes = [ClassInfo(name, "6") for name in ("A", "B", "C", "D", "E")]
        report_assignments = [
            Assignment("A", "6", "S", "T", 1, 1),
            Assignment("B", "6", "S", "T", 1, 1),
            Assignment("C", "6", "S", "T", 1, 1),
            Assignment("D", "6", "S", "T", 1, 1),
            Assignment("E", "6", "S", "U", 1, 1),
        ]
        local_data = SchoolData(
            classes=classes,
            assignments=report_assignments[1:],
            teachers=["T", "U"],
            subjects=["S"],
            periods_by_grade_subject={("6", "S"): 1},
            limits_by_grade_subject={("6", "S"): 1},
        )
        report_data = SchoolData(
            classes=classes,
            assignments=report_assignments,
            teachers=["T", "U"],
            subjects=["S"],
            periods_by_grade_subject={("6", "S"): 1},
            limits_by_grade_subject={("6", "S"): 1},
        )
        fixed = Lesson("A", "6", 2, "AM", 1, "S", "T")
        movable = [
            Lesson("B", "6", 3, "AM", 1, "S", "T"),
            Lesson("C", "6", 3, "AM", 2, "S", "T"),
            Lesson("D", "6", 3, "AM", 3, "S", "T"),
            Lesson("E", "6", 2, "PM", 1, "S", "U"),
        ]
        rules = TimetableRuleSet()
        before = compute_metrics(report_data, [*movable, fixed], rules=rules)
        self.assertEqual(before["one_period_teacher_sessions"], 2)

        result = _repair_one_period_affected_class_cluster(
            local_data,
            movable,
            rules,
            allow_gap1=True,
            time_limit_seconds=3,
            max_classes=1,
            max_lessons=20,
            num_workers=1,
            optimize_teacher_quality=True,
            fixed_lessons=[fixed],
            report_data=report_data,
            report_rules=rules,
            random_seed=17,
            preserve_teacher_quality=True,
            max_gap1_sessions=8,
            stop_after_quality_gain=True,
        )

        self.assertIsNotNone(result)
        candidate, metrics, meta = result  # type: ignore[misc]
        self.assertIn(fixed, candidate)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        teacher_t_sessions: dict[tuple[int, str], int] = {}
        for lesson in candidate:
            if lesson.teacher == "T":
                key = (lesson.day, lesson.session)
                teacher_t_sessions[key] = teacher_t_sessions.get(key, 0) + 1
        self.assertTrue(teacher_t_sessions)
        self.assertNotIn(1, teacher_t_sessions.values())
        self.assertIn("T", meta["fixed_singleton_focus_teachers"])
        self.assertTrue(meta["teacher_quality_cluster_early_stop_enabled"])
        self.assertTrue(meta["teacher_quality_cluster_early_stop_hit"])

    def test_fixed_gap_focus_can_pull_a_movable_lesson_into_fixed_endpoints(self) -> None:
        names = ("A", "F", "B", "C", "D", "E")
        classes = [ClassInfo(name, "6") for name in names]
        report_assignments = [
            Assignment("A", "6", "S", "T", 1, 1),
            Assignment("F", "6", "S", "T", 1, 1),
            Assignment("B", "6", "S", "T", 1, 1),
            Assignment("C", "6", "S", "T", 1, 1),
            Assignment("D", "6", "S", "T", 1, 1),
            Assignment("E", "6", "S", "U", 1, 1),
        ]
        local_data = SchoolData(
            classes=classes,
            assignments=report_assignments[2:],
            teachers=["T", "U"],
            subjects=["S"],
            periods_by_grade_subject={("6", "S"): 1},
            limits_by_grade_subject={("6", "S"): 1},
        )
        report_data = SchoolData(
            classes=classes,
            assignments=report_assignments,
            teachers=["T", "U"],
            subjects=["S"],
            periods_by_grade_subject={("6", "S"): 1},
            limits_by_grade_subject={("6", "S"): 1},
        )
        fixed = [
            Lesson("A", "6", 2, "AM", 1, "S", "T"),
            Lesson("F", "6", 2, "AM", 3, "S", "T"),
        ]
        movable = [
            Lesson("B", "6", 3, "AM", 1, "S", "T"),
            Lesson("C", "6", 3, "AM", 2, "S", "T"),
            Lesson("D", "6", 3, "AM", 3, "S", "T"),
            Lesson("E", "6", 2, "PM", 1, "S", "U"),
        ]
        rules = TimetableRuleSet()
        before = compute_metrics(report_data, [*movable, *fixed], rules=rules)
        self.assertEqual(_teacher_session_opt_gap1(before), 1)

        result = _repair_one_period_affected_class_cluster(
            local_data,
            movable,
            rules,
            allow_gap1=True,
            time_limit_seconds=3,
            max_classes=2,
            max_lessons=20,
            num_workers=1,
            optimize_teacher_quality=True,
            fixed_lessons=fixed,
            report_data=report_data,
            report_rules=rules,
            random_seed=23,
            preserve_teacher_quality=True,
            max_gap1_sessions=8,
        )

        self.assertIsNotNone(result)
        candidate, metrics, meta = result  # type: ignore[misc]
        for lesson in fixed:
            self.assertIn(lesson, candidate)
        self.assertEqual(_teacher_session_opt_gap1(metrics), 0)
        fixed_session_periods = {
            lesson.period
            for lesson in candidate
            if lesson.teacher == "T" and lesson.day == 2 and lesson.session == "AM"
        }
        self.assertEqual(fixed_session_periods, {1, 2, 3})
        self.assertIn("T", meta["fixed_gap_focus_teachers"])

    def test_cluster_repair_subtracts_fixed_demand_inside_seed_class(self) -> None:
        data = SchoolData(
            classes=[ClassInfo("A", "6")],
            assignments=[
                Assignment("A", "6", "Math", "T1", 2, 2),
                Assignment("A", "6", "Science", "T2", 2, 2),
            ],
            teachers=["T1", "T2"],
            subjects=["Math", "Science"],
            periods_by_grade_subject={("6", "Math"): 2, ("6", "Science"): 2},
            limits_by_grade_subject={("6", "Math"): 2, ("6", "Science"): 2},
        )
        fixed = Lesson("A", "6", 2, "AM", 1, "Math", "T1")
        movable = [
            Lesson("A", "6", 2, "AM", 2, "Math", "T1"),
            Lesson("A", "6", 2, "AM", 3, "Science", "T2"),
            Lesson("A", "6", 2, "AM", 4, "Science", "T2"),
        ]
        rules = TimetableRuleSet()

        result = _repair_one_period_affected_class_cluster(
            data,
            movable,
            rules,
            seed_classes=["A"],
            allow_gap1=True,
            time_limit_seconds=3,
            max_classes=1,
            max_lessons=10,
            num_workers=1,
            optimize_teacher_quality=True,
            fixed_lessons=[fixed],
            report_data=data,
            report_rules=rules,
            require_quality_improvement=False,
        )

        self.assertIsNotNone(result)
        candidate, metrics, meta = result  # type: ignore[misc]
        self.assertIn(fixed, candidate)
        self.assertEqual(metrics["scheduled_periods"], 4)
        self.assertEqual(metrics["expected_periods"], 4)
        self.assertEqual(metrics["assignment_mismatches"], [])
        self.assertEqual(meta["one_period_cluster_periods"], 3)

    def test_goal_aware_ranking_prefers_progress_toward_target_over_accept(self) -> None:
        incumbent = {
            "teacher_sessions": 12,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 12},
        }
        candidate = {
            "teacher_sessions": 11,
            "one_period_teacher_sessions": 0,
            "gap_distribution": {0: 10, 1: 1},
        }

        self.assertTrue(
            _teacher_session_opt_goal_aware_better(
                candidate,
                incumbent,
                target_teacher_sessions=10,
                target_gap1_sessions=None,
                accept_teacher_sessions=12,
                accept_gap1_sessions=0,
            )
        )

    def test_adaptive_seed_caps_start_near_accept_not_lower_bound(self) -> None:
        settings = {
            "optimization_accept_teacher_sessions": 12,
            "optimization_start_teacher_sessions": 13,
        }
        bounds = {
            "lower_cap": 5,
            "start_cap": 13,
            "upper_cap": 30,
        }

        adaptive_caps = _teacher_session_opt_seed_caps(
            settings,
            bounds,
            5,
            adaptive=True,
        )
        explicit_caps = _teacher_session_opt_seed_caps(
            settings,
            bounds,
            5,
            adaptive=False,
        )

        self.assertEqual(adaptive_caps[:2], [12, 13])
        self.assertNotIn(5, adaptive_caps)
        self.assertEqual(explicit_caps[0], 5)

        tight_caps = _teacher_session_opt_seed_caps(
            {
                **settings,
                "tight_class_fixed_off_profile": {"expected": 100, "slack": 0},
            },
            bounds,
            5,
            adaptive=True,
        )
        self.assertEqual(tight_caps[0], 18)

    def test_gap_target_adaptive_max_polishes_before_tightening(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        solve_settings: list[dict[str, object]] = []

        def fake_inner_solve(_data, settings, **_kwargs):
            solve_settings.append(dict(settings))
            return json.loads(json.dumps(incumbent))

        with patch("tkb_new.adapter.solve_from_ui_data", side_effect=fake_inner_solve):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 3,
                    "optimization_accept_gap1_sessions": 2,
                    "optimization_time_limit_seconds": 60,
                    "optimization_adaptive_time_limit_seconds": 60,
                    "optimization_adaptive_stagnant_attempts": 3,
                    "optimization_use_benders": False,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertIsNone(optimization["target_teacher_sessions"])
        self.assertEqual(optimization["target_gap1_sessions"], 0)
        self.assertEqual(optimization["termination_reason"], "accept_fallback_after_stagnation")
        self.assertEqual(
            [int(settings["max_teacher_sessions"]) for settings in solve_settings[1:]],
            [3, 3, 4],
        )
        self.assertTrue(all("random_seed" in settings for settings in solve_settings[1:]))

    def test_clean_unified_incumbent_returns_improved_local_lns_without_global_probe(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        improved = json.loads(json.dumps(incumbent))
        improved["metrics"]["gap_distribution"] = {"0": 2, "1": 1}

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(improved, [{"pass": 1, "improved": True}]),
            ) as local_lns,
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=AssertionError("global probe must not run")),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 300,
                    "optimization_adaptive_time_limit_seconds": 300,
                    "optimization_continue_quality_search": True,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_called_once()
        self.assertEqual(payload["metrics"]["gap_distribution"], {"0": 2, "1": 1})
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["termination_reason"], "existing_local_quality_lns_improved")

    def test_unified_refinement_stops_immediately_at_a_good_incumbent(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 2, 1: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=AssertionError("local LNS must not run"),
            ) as local_lns,
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=AssertionError("global probe must not run")),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_stop_refinement_when_good_enough": True,
                    "optimization_accept_teacher_sessions": 3,
                    "optimization_accept_gap1_sessions": 1,
                    "optimization_time_limit_seconds": 180,
                    "optimization_adaptive_time_limit_seconds": 180,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_not_called()
        self.assertEqual(payload["metrics"]["teacher_sessions"], 3)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["termination_reason"], "existing_good_enough_early_stop")
        self.assertEqual(
            optimization["refinement_strategy"]["outcome"],
            "good_enough_incumbent",
        )

    def test_complete_incumbent_continuation_uses_saturation_not_fixed_threshold(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 2, 1: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ) as local_lns,
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=AssertionError("global probe must not run")),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "ui_stop_refinement_when_good_enough": True,
                    "optimization_continue_quality_search": False,
                    "optimization_stop_on_stagnation": True,
                    "optimization_benders_accept_stagnant_iterations": 2,
                    "optimization_accept_teacher_sessions": 3,
                    "optimization_accept_gap1_sessions": 1,
                    "optimization_time_limit_seconds": 30,
                    "optimization_adaptive_time_limit_seconds": 30,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_called_once()
        normalized_settings = local_lns.call_args.args[1]
        self.assertTrue(normalized_settings["optimization_continue_quality_search"])
        self.assertFalse(normalized_settings["ui_stop_refinement_when_good_enough"])
        self.assertTrue(normalized_settings["optimization_stop_on_stagnation"])
        self.assertGreaterEqual(
            normalized_settings["optimization_benders_accept_stagnant_iterations"],
            2,
        )
        self.assertTrue(normalized_settings["optimization_refine_try_lower_session_cap"])
        self.assertTrue(normalized_settings["optimization_benders_lean_refinement_periods"])
        self.assertGreaterEqual(normalized_settings["optimization_existing_incumbent_gap_attempts"], 4)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertNotEqual(optimization["termination_reason"], "existing_good_enough_early_stop")

    def test_complete_refinement_requires_two_stagnant_attempts_before_saturation(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch("tkb_new.adapter._polish_complete_incumbent_with_local_lns", return_value=None),
            patch(
                "tkb_new.adapter.solve_from_ui_data",
                return_value=json.loads(json.dumps(incumbent)),
            ) as inner_solve,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "optimization_continue_quality_search": True,
                    "optimization_stop_on_stagnation": True,
                    "optimization_adaptive_stagnant_attempts": 1,
                    "optimization_adaptive_stagnant_seconds": 10,
                    "optimization_use_benders": False,
                    "optimization_time_limit_seconds": 60,
                    "optimization_adaptive_time_limit_seconds": 60,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(inner_solve.call_count, 2)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["termination_reason"], "refinement_search_saturated")
        self.assertTrue(
            any(
                attempt.get("reason") == "refinement_search_saturated"
                for attempt in optimization["attempts"]
            )
        )

    def test_balanced_refinement_restores_gap_portfolio_and_keeps_pareto_incumbent(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _first_click_payload(teacher_sessions=521, gap1=113)
        same_sessions_better_gap = _first_click_payload(teacher_sessions=521, gap1=90)
        lower_sessions_worse_gap = _first_click_payload(teacher_sessions=500, gap1=120)
        improved = _first_click_payload(teacher_sessions=500, gap1=78)
        clock = [1_000.0]
        attempted_caps: list[int] = []
        hint_sessions: list[int | None] = []

        def fake_benders(_data, _settings, **kwargs):
            attempted_caps.append(int(kwargs["cap"]))
            hint = kwargs.get("incumbent_payload")
            hint_metrics = hint.get("metrics") if isinstance(hint, dict) else None
            hint_sessions.append(
                int(hint_metrics.get("teacher_sessions"))
                if isinstance(hint_metrics, dict) and hint_metrics.get("teacher_sessions") is not None
                else None
            )
            if len(attempted_caps) == 1:
                clock[0] += 36.0
                return json.loads(json.dumps(same_sessions_better_gap))
            if len(attempted_caps) == 2:
                clock[0] += 36.0
                return json.loads(json.dumps(lower_sessions_worse_gap))
            if len(attempted_caps) == 3:
                clock[0] += 108.0
                return json.loads(json.dumps(improved))
            clock[0] += 120.0
            raise RuntimeError("portfolio exhausted")

        bounds = {
            "lower_cap": 346,
            "start_cap": 466,
            "upper_cap": 1116,
            "expected_periods": 1566,
        }
        tight_profile = {
            "expected": 1566,
            "class_count": 54,
            "available_slots": 1566,
            "fixed_slots": 1566,
            "slack": 0,
        }
        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: clock[0]),
            patch("tkb_new.adapter._teacher_session_adaptive_bounds", return_value=bounds),
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=tight_profile),
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ) as local_lns,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ) as cap_probe,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "optimization_accept_teacher_sessions": 482,
                    "optimization_accept_gap1_sessions": 53,
                    "optimization_time_limit_seconds": 180,
                    "optimization_adaptive_time_limit_seconds": 180,
                    "optimization_stop_on_stagnation": True,
                    "optimization_adaptive_stagnant_attempts": 2,
                    "optimization_adaptive_stagnant_seconds": 20,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_use_benders": True,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_not_called()
        self.assertGreaterEqual(cap_probe.call_count, 3)
        # The first lower-session candidate is retained as an internal
        # frontier, so the next probe starts from its cap instead of discarding
        # the useful 500-session neighborhood.
        self.assertEqual(attempted_caps[:3], [521, 501, 500])
        self.assertEqual(hint_sessions[:3], [521, 521, 500])
        self.assertEqual(payload["metrics"]["teacher_sessions"], 500)
        self.assertEqual(_teacher_session_opt_gap1(payload["metrics"]), 78)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["target_gap1_sessions"], 0)
        bridge_attempt = next(
            attempt
            for attempt in optimization["attempts"]
            if attempt.get("teacher_sessions") == 500
            and (attempt.get("gap_distribution") or {}).get("1") == 120
        )
        self.assertIsNot(bridge_attempt.get("new_best"), True)

    def test_refinement_frontier_allows_temporary_gap_debt_but_visible_guard_stays_pareto(self) -> None:
        incumbent = _first_click_payload(teacher_sessions=478, gap1=40)["metrics"]
        bridge = _first_click_payload(teacher_sessions=470, gap1=60)["metrics"]
        better = _first_click_payload(teacher_sessions=469, gap1=39)["metrics"]

        self.assertTrue(_teacher_session_opt_frontier_better(bridge, incumbent))
        self.assertTrue(_teacher_session_opt_frontier_better(better, bridge))
        self.assertFalse(_incremental_refinement_candidate_better(bridge, incumbent))
        self.assertTrue(_incremental_refinement_candidate_better(better, incumbent))

        worse_sessions = _first_click_payload(teacher_sessions=479, gap1=39)["metrics"]
        worse_sessions["one_period_teacher_sessions"] = 0
        incumbent_with_singleton = dict(incumbent)
        incumbent_with_singleton["one_period_teacher_sessions"] = 1
        self.assertFalse(
            _teacher_session_opt_frontier_better(worse_sessions, incumbent_with_singleton)
        )

    def test_refinement_frontier_falls_back_to_exact_visible_incumbent(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _first_click_payload(teacher_sessions=478, gap1=40)
        bridge = _first_click_payload(teacher_sessions=470, gap1=60)
        clock = [1_000.0]
        hints: list[int | None] = []

        def fake_benders(_data, _settings, **kwargs):
            hint = kwargs.get("incumbent_payload")
            hint_metrics = hint.get("metrics") if isinstance(hint, dict) else None
            hints.append(
                int(hint_metrics.get("teacher_sessions"))
                if isinstance(hint_metrics, dict) and hint_metrics.get("teacher_sessions") is not None
                else None
            )
            if len(hints) == 1:
                clock[0] += 45.0
                return json.loads(json.dumps(bridge))
            clock[0] += 150.0
            raise RuntimeError("no safe follow-up")

        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: clock[0]),
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 346,
                    "start_cap": 466,
                    "upper_cap": 1116,
                    "expected_periods": 1566,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value={
                    "expected": 1566,
                    "class_count": 54,
                    "available_slots": 1566,
                    "fixed_slots": 1566,
                    "slack": 0,
                },
            ),
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch("tkb_new.adapter._polish_complete_incumbent_with_local_lns", return_value=None),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "optimization_accept_teacher_sessions": 470,
                    "optimization_accept_gap1_sessions": 53,
                    "optimization_time_limit_seconds": 180,
                    "optimization_adaptive_time_limit_seconds": 180,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_use_benders": True,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(hints[:2], [478, 470])
        self.assertEqual(payload["metrics"]["teacher_sessions"], 478)
        self.assertEqual(_teacher_session_opt_gap1(payload["metrics"]), 40)
        frontier = payload["solver"]["teacher_session_optimization"]["exploration_frontier"]
        self.assertTrue(frontier["returned_visible_incumbent"])

    def test_refinement_reserves_thirty_seconds_for_frontier_gap_cleanup(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _first_click_payload(teacher_sessions=466, gap1=40)
        frontier = _first_click_payload(teacher_sessions=463, gap1=45)
        cleaned = _first_click_payload(teacher_sessions=463, gap1=38)
        clock = [1_000.0]
        attempt_limits: list[int] = []

        def fake_benders(_data, _settings, **kwargs):
            attempt_limits.append(int(kwargs["time_limit_seconds"]))
            clock[0] += 40.0 if len(attempt_limits) == 1 else attempt_limits[-1]
            return json.loads(json.dumps(frontier))

        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: clock[0]),
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 346,
                    "start_cap": 466,
                    "upper_cap": 1116,
                    "expected_periods": 1566,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value={
                    "expected": 1566,
                    "class_count": 54,
                    "available_slots": 1566,
                    "fixed_slots": 1566,
                    "slack": 0,
                },
            ),
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter._school_seed_sequence", return_value=[11, 22, 33, 44]),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(json.loads(json.dumps(cleaned)), [{"operator": "gap1"}]),
            ) as local_lns,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 466,
                    "optimization_accept_gap1_sessions": 53,
                    "optimization_time_limit_seconds": 120,
                    "optimization_adaptive_time_limit_seconds": 120,
                    "optimization_first_cap_time_limit_seconds": 60,
                    "optimization_retry_cap_time_limit_seconds": 60,
                    "optimization_frontier_cleanup_reserve_seconds": 30,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_use_benders": True,
                    "num_workers": 6,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_called_once()
        self.assertEqual(attempt_limits, [60, 48])
        self.assertEqual(local_lns.call_args.kwargs["time_limit_seconds"], 30.0)
        self.assertEqual(local_lns.call_args.kwargs["gap1_cleanup_cap"], 40)
        self.assertTrue(local_lns.call_args.kwargs["protected_cleanup_budget"])
        self.assertEqual(payload["metrics"]["teacher_sessions"], 463)
        self.assertEqual(_teacher_session_opt_gap1(payload["metrics"]), 38)
        attempts = payload["solver"]["teacher_session_optimization"]["attempts"]
        self.assertTrue(
            any(attempt.get("reason") == "frontier_gap_cleanup_reserved" for attempt in attempts)
        )

    def test_refinement_first_noop_then_nearby_cap_improves_pareto(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _first_click_payload(teacher_sessions=466, gap1=44)
        improved = _first_click_payload(teacher_sessions=463, gap1=38)
        clock = [1_000.0]
        attempted_caps: list[int] = []
        attempted_seeds: list[int | None] = []
        attempt_limits: list[int] = []
        hinted_sessions: list[int | None] = []

        def fake_benders(_data, _settings, **kwargs):
            attempted_caps.append(int(kwargs["cap"]))
            attempted_seeds.append(kwargs.get("random_seed"))
            attempt_limits.append(int(kwargs["time_limit_seconds"]))
            hint = kwargs.get("incumbent_payload")
            hint_metrics = hint.get("metrics") if isinstance(hint, dict) else None
            hinted_sessions.append(
                int(hint_metrics.get("teacher_sessions"))
                if isinstance(hint_metrics, dict)
                and hint_metrics.get("teacher_sessions") is not None
                else None
            )
            clock[0] += 58.0
            if len(attempted_caps) == 1:
                return json.loads(json.dumps(incumbent))
            return json.loads(json.dumps(improved))

        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: clock[0]),
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 346,
                    "start_cap": 466,
                    "upper_cap": 1116,
                    "expected_periods": 1566,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value={
                    "expected": 1566,
                    "class_count": 54,
                    "available_slots": 1566,
                    "fixed_slots": 1566,
                    "slack": 0,
                },
            ),
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter._school_seed_sequence", return_value=[11, 22, 33, 44]),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ) as local_lns,
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 466,
                    "optimization_accept_gap1_sessions": 53,
                    "optimization_time_limit_seconds": 120,
                    "optimization_adaptive_time_limit_seconds": 120,
                    "optimization_first_cap_time_limit_seconds": 60,
                    "optimization_retry_cap_time_limit_seconds": 60,
                    "optimization_polish_cap_time_limit_seconds": 60,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_use_benders": True,
                    "num_workers": 6,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_not_called()
        self.assertEqual(attempted_caps, [466, 463])
        self.assertEqual(attempted_seeds, [11, 22])
        self.assertEqual(attempt_limits, [60, 60])
        self.assertEqual(hinted_sessions, [466, 466])
        self.assertEqual(payload["metrics"]["teacher_sessions"], 463)
        self.assertEqual(_teacher_session_opt_gap1(payload["metrics"]), 38)

    def test_refinement_strong_cap_failure_runs_nearby_fallback_before_saturation(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _first_click_payload(teacher_sessions=466, gap1=44)
        nearby_improved = _first_click_payload(teacher_sessions=465, gap1=40)
        clock = [1_000.0]
        attempted_caps: list[int] = []
        attempted_seeds: list[int | None] = []

        def fake_benders(_data, _settings, **kwargs):
            attempted_caps.append(int(kwargs["cap"]))
            attempted_seeds.append(kwargs.get("random_seed"))
            if len(attempted_caps) == 1:
                clock[0] += 30.0
                return json.loads(json.dumps(incumbent))
            if len(attempted_caps) == 2:
                clock[0] += 30.0
                raise RuntimeError("aggressive cap is infeasible for this school")
            clock[0] += 60.0
            return json.loads(json.dumps(nearby_improved))

        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: clock[0]),
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 346,
                    "start_cap": 466,
                    "upper_cap": 1116,
                    "expected_periods": 1566,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value={
                    "expected": 1566,
                    "class_count": 54,
                    "available_slots": 1566,
                    "fixed_slots": 1566,
                    "slack": 0,
                },
            ),
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter._school_seed_sequence", return_value=[11, 22, 33, 44]),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 466,
                    "optimization_accept_gap1_sessions": 53,
                    "optimization_time_limit_seconds": 120,
                    "optimization_adaptive_time_limit_seconds": 120,
                    "optimization_first_cap_time_limit_seconds": 60,
                    "optimization_retry_cap_time_limit_seconds": 60,
                    "optimization_stop_on_stagnation": True,
                    "optimization_adaptive_stagnant_attempts": 2,
                    "optimization_adaptive_stagnant_seconds": 35,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_use_benders": True,
                    "num_workers": 6,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(attempted_caps, [466, 463, 465])
        self.assertEqual(attempted_seeds, [11, 22, 33])
        self.assertEqual(payload["metrics"]["teacher_sessions"], 465)
        self.assertEqual(_teacher_session_opt_gap1(payload["metrics"]), 40)

    def test_refinement_rebuild_skips_consumed_seeds_after_cap_progress(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = _first_click_payload(teacher_sessions=466, gap1=44)
        same_cap_progress = _first_click_payload(teacher_sessions=466, gap1=42)
        nearby_progress = _first_click_payload(teacher_sessions=463, gap1=38)
        clock = [1_000.0]
        attempted_caps: list[int] = []
        attempted_seeds: list[int | None] = []

        def fake_benders(_data, _settings, **kwargs):
            attempted_caps.append(int(kwargs["cap"]))
            attempted_seeds.append(kwargs.get("random_seed"))
            if len(attempted_caps) == 1:
                clock[0] += 55.0
                return json.loads(json.dumps(same_cap_progress))
            if len(attempted_caps) == 2:
                clock[0] += 55.0
                return json.loads(json.dumps(nearby_progress))
            clock[0] += 70.0
            raise RuntimeError("final nearby cap exhausted")

        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: clock[0]),
            patch(
                "tkb_new.adapter._teacher_session_adaptive_bounds",
                return_value={
                    "lower_cap": 346,
                    "start_cap": 466,
                    "upper_cap": 1116,
                    "expected_periods": 1566,
                },
            ),
            patch(
                "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                return_value={
                    "expected": 1566,
                    "class_count": 54,
                    "available_slots": 1566,
                    "fixed_slots": 1566,
                    "slack": 0,
                },
            ),
            patch(
                "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                return_value=incumbent,
            ),
            patch("tkb_new.adapter._school_seed_sequence", return_value=[11, 22, 33, 44]),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=fake_benders,
            ),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "ui_use_existing_complete_incumbent": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 466,
                    "optimization_accept_gap1_sessions": 53,
                    "optimization_time_limit_seconds": 180,
                    "optimization_adaptive_time_limit_seconds": 180,
                    "optimization_first_cap_time_limit_seconds": 60,
                    "optimization_retry_cap_time_limit_seconds": 60,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_use_benders": True,
                    "num_workers": 6,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(attempted_caps[:3], [466, 463, 461])
        self.assertEqual(attempted_seeds[:3], [11, 22, 33])
        self.assertEqual(len(set(attempted_seeds[:3])), 3)
        self.assertEqual(payload["metrics"]["teacher_sessions"], 463)
        self.assertEqual(_teacher_session_opt_gap1(payload["metrics"]), 38)

    def test_request_seed_reaches_global_refinement_queued_cap(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        tight_profile = {
            "expected": 1000,
            "available_slots": 1000,
            "fixed_slots": 1000,
            "slack": 0,
        }

        def queued_seed(request_seed: int) -> int | None:
            with (
                patch(
                    "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
                    return_value=tight_profile,
                ),
                patch(
                    "tkb_new.adapter._validated_existing_soft_incumbent_payload",
                    return_value=incumbent,
                ),
                patch(
                    "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                    return_value=None,
                ),
                patch(
                    "tkb_new.adapter._solve_teacher_session_benders_candidate",
                    return_value=incumbent,
                ) as cap_probe,
            ):
                _solve_teacher_session_optimized_from_ui_data(
                    data,
                    {
                        "auto_sort_mode": "teacher_session_opt",
                        "auto_sort_strategy": "continue_teacher_quality_from_incumbent",
                        "ui_unified_auto_sort": True,
                        "ui_unified_solve_kind": "refine_complete",
                        "ui_use_existing_complete_incumbent": True,
                        "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                        "optimization_time_limit_seconds": 60,
                        "optimization_adaptive_time_limit_seconds": 60,
                        "optimization_continue_quality_search": True,
                        "optimization_stop_on_stagnation": True,
                        "optimization_adaptive_stagnant_attempts": 1,
                        "optimization_refine_try_lower_session_cap": True,
                        "random_seed": request_seed,
                        "quality_variant_seed": request_seed,
                        "num_workers": 1,
                    },
                    rules=None,
                    progress=None,
                    out_dir=None,
                )
            self.assertGreaterEqual(cap_probe.call_count, 2)
            return cap_probe.call_args_list[0].kwargs["random_seed"]

        first = queued_seed(17)
        repeated = queued_seed(17)
        different = queued_seed(18)
        self.assertEqual(first, repeated)
        self.assertNotEqual(first, different)

    def test_unified_incremental_caller_keeps_best_so_far_when_gap1_worsens(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        lower_session_but_worse_gap1 = json.loads(json.dumps(incumbent))
        lower_session_but_worse_gap1["metrics"].update(
            {
                "teacher_sessions": 2,
                "gap_distribution": {"1": 3},
            }
        )

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(
                    lower_session_but_worse_gap1,
                    [{"pass": 1, "improved": True}],
                ),
            ) as local_lns,
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=AssertionError("global probe must not run")),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 60,
                    "optimization_adaptive_time_limit_seconds": 60,
                    "optimization_continue_quality_search": True,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_called_once()
        self.assertEqual(payload["metrics"]["teacher_sessions"], 3)
        self.assertEqual(payload["metrics"]["gap_distribution"], {0: 1, 1: 2})
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["termination_reason"], "existing_local_quality_lns_stagnant")
        self.assertTrue(optimization["attempts"][-1]["retained_incumbent"])

    def test_unified_clean_refine_reserves_budget_for_global_gap_portfolio(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        tightened = json.loads(json.dumps(incumbent))
        tightened["metrics"].update(
            {
                "teacher_sessions": 2,
                "gap_distribution": {"0": 2},
            }
        )

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ) as local_lns,
            patch(
                "tkb_new.adapter.solve_from_ui_data",
                return_value=tightened,
            ) as cap_probe,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 120,
                    "optimization_adaptive_time_limit_seconds": 120,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_continue_quality_search": False,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_not_called()
        cap_probe.assert_called_once()
        self.assertEqual(cap_probe.call_args.args[1]["max_teacher_sessions"], 3)
        self.assertEqual(payload["metrics"]["teacher_sessions"], 2)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["termination_reason"], "target_reached")
        self.assertTrue(optimization["refinement_strategy"]["global_cap_search_started"])
        self.assertTrue(
            optimization["refinement_strategy"]["clean_global_gap_portfolio_reserved"]
        )

    def test_unified_refine_uses_global_cleanup_for_quality_debt(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 1,
                "gap_distribution": {0: 3},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        cleaned = json.loads(json.dumps(incumbent))
        cleaned["metrics"].update(
            {
                "teacher_sessions": 2,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {"0": 2},
            }
        )

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch("tkb_new.adapter._polish_complete_incumbent_with_local_lns", return_value=None),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                return_value=cleaned,
            ) as cap_probe,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 2,
                    "optimization_time_limit_seconds": 120,
                    "optimization_adaptive_time_limit_seconds": 120,
                    "optimization_refine_try_lower_session_cap": True,
                    "optimization_continue_quality_search": False,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        cap_probe.assert_called_once()
        self.assertEqual(cap_probe.call_args.kwargs["cap"], 2)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        self.assertEqual(payload["metrics"]["teacher_sessions"], 2)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertTrue(optimization["refinement_strategy"]["global_cap_search_started"])

    def test_dirty_complete_incumbent_survives_failed_quality_probes(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 1,
                "gap_distribution": {0: 3},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        learning = {
            "version": 1,
            "school_signature": 123,
            "total_attempts": 2,
            "operators": {
                "one_period": {
                    "attempts": 2,
                    "improvements": 0,
                    "reward": 0.0,
                    "seconds": 1.0,
                    "last_round": 1,
                }
            },
        }

        def stagnant_local_lns(*_args, operator_learning=None, **_kwargs):
            self.assertIs(operator_learning, learning)
            operator_learning["total_attempts"] = 3
            operator_learning["operators"]["one_period"]["attempts"] = 3
            return None

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch("tkb_new.adapter._merge_refinement_learning", return_value=learning),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=stagnant_local_lns,
            ) as local_lns,
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=AssertionError("global probe must not run")),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 30,
                    "optimization_adaptive_time_limit_seconds": 30,
                    "optimization_continue_quality_search": True,
                    "optimization_use_benders": False,
                    "optimization_refinement_round": 1_000_033,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_called_once()
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 1)
        self.assertEqual(payload["metrics"]["scheduled_periods"], 4)
        self.assertFalse(payload["solver"]["teacher_session_optimization"]["target_met"])
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(optimization["termination_reason"], "existing_local_quality_lns_stagnant")
        strategy = optimization["refinement_strategy"]
        self.assertEqual(strategy["round"], 1_000_033)
        self.assertEqual(len(strategy["seed_portfolio"]), 5)
        self.assertEqual(strategy["outcome"], "stagnant")
        self.assertEqual(optimization["refinement_learning"]["total_attempts"], 3)
        self.assertEqual(
            payload["solver"]["runtime_settings"]["refinement_learning"]["total_attempts"],
            3,
        )

    def test_incremental_lns_error_retains_incumbent_without_global_probe(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 2, 2: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }

        with (
            patch("tkb_new.adapter._validated_existing_soft_incumbent_payload", return_value=incumbent),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=RuntimeError("local timeout"),
            ) as local_lns,
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=AssertionError("global probe must not run")),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "refine_complete",
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 30,
                    "optimization_adaptive_time_limit_seconds": 30,
                    "optimization_continue_quality_search": True,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        local_lns.assert_called_once()
        self.assertEqual(payload["metrics"]["gap_distribution"], {0: 2, 2: 1})
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(
            optimization["termination_reason"],
            "existing_local_quality_lns_error_retained",
        )
        self.assertEqual(optimization["refinement_strategy"]["outcome"], "error_retained")

    def test_fresh_complete_first_retains_warmup_without_starting_global_retry(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        tight_profile = {
            "expected": 1000,
            "class_count": 1,
            "available_slots": 1000,
            "fixed_slots": 1000,
            "slack": 0,
        }

        with (
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=tight_profile),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=[json.loads(json.dumps(incumbent)), AssertionError("global retry must not run")],
            ) as inner_solve,
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=None,
            ) as local_lns,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "fresh_complete_first",
                    "ui_unified_first_click_quality": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_teacher_sessions": 2,
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 2,
                    "optimization_accept_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 60,
                    "optimization_first_click_local_lns_time_limit_seconds": 5,
                    "ui_unified_reference_watchdog_reserve_ms": 5000,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
                deadline=SolverDeadline(20),
            )

        self.assertEqual(inner_solve.call_count, 1)
        local_lns.assert_called_once()
        self.assertGreaterEqual(local_lns.call_args.kwargs["time_limit_seconds"], 0.5)
        self.assertLessEqual(local_lns.call_args.kwargs["time_limit_seconds"], 5.0)
        self.assertEqual(payload["metrics"]["scheduled_periods"], 4)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(
            optimization["termination_reason"],
            "first_click_feasibility_retained",
        )
        self.assertTrue(optimization["attempts"][-1]["incumbent_retained"])

    def test_fresh_complete_first_survives_local_lns_error_without_retry(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        tight_profile = {
            "expected": 1000,
            "class_count": 1,
            "available_slots": 1000,
            "fixed_slots": 1000,
            "slack": 0,
        }

        with (
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=tight_profile),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=[json.loads(json.dumps(incumbent)), AssertionError("global retry must not run")],
            ) as inner_solve,
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                side_effect=RuntimeError("local timeout"),
            ) as local_lns,
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "ui_unified_auto_sort": True,
                    "ui_unified_solve_kind": "fresh_complete_first",
                    "ui_unified_first_click_quality": True,
                    "quality_priority_order": "one_period_gap2_teacher_sessions_gap1",
                    "target_teacher_sessions": 2,
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 2,
                    "optimization_accept_gap1_sessions": 0,
                    "optimization_time_limit_seconds": 60,
                    "ui_unified_reference_watchdog_reserve_ms": 5000,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(inner_solve.call_count, 2)
        local_lns.assert_called_once()
        self.assertEqual(payload["metrics"]["scheduled_periods"], 4)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(
            optimization["termination_reason"],
            "first_click_feasibility_retained_after_quality_error",
        )
        self.assertIn("local timeout", optimization["attempts"][-1]["error"])

    def test_first_click_quality_uses_feasible_result_as_soft_hint_with_headroom(self) -> None:
        fixed_lesson = Lesson(
            class_name="6/1",
            grade="6",
            day=2,
            session="AM",
            period=1,
            subject="Math",
            teacher="T1",
        )
        feasibility = _first_click_payload(teacher_sessions=520, gap1=84)
        quality = _first_click_payload(teacher_sessions=498, gap1=58)
        exact_target = _first_click_payload(teacher_sessions=482, gap1=60)
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_benders_disable_session_early_stop": True,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "num_workers": 6,
        }
        bounds = {
            "lower_cap": 450,
            "start_cap": 466,
            "upper_cap": 650,
            "expected_periods": 1566,
        }
        profile = {"expected": 1566, "class_count": 54}

        with (
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([fixed_lesson], []),
            ),
            patch(
                "tkb_new.adapter._release_invalid_fixed_lessons",
                return_value=([fixed_lesson], []),
            ),
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                side_effect=[feasibility, quality, exact_target],
            ) as solve_candidate,
        ):
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds=bounds,
                    profile=profile,
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(90),
                    polish_seeds=[1],
                    requested_random_seed=77,
                )
            )

        self.assertIs(result, exact_target)
        self.assertIs(metrics, exact_target["metrics"])
        self.assertEqual(termination, "first_click_tighter_cap_improved")
        self.assertEqual(solve_candidate.call_count, 3)
        feasibility_call, quality_call, target_call = solve_candidate.call_args_list
        self.assertEqual(feasibility_call.kwargs["cap"], 522)
        self.assertEqual(feasibility_call.kwargs["random_seed"], 77)
        self.assertFalse(
            feasibility_call.args[1]["optimization_benders_disable_session_early_stop"]
        )
        self.assertEqual(feasibility_call.args[1]["max_one_period_sessions"], 0)
        self.assertFalse(
            feasibility_call.args[1]["optimization_benders_period_feasibility_all_sessions"]
        )
        self.assertEqual(feasibility_call.args[1]["optimization_benders_iterations"], 5)
        self.assertEqual(feasibility_call.args[1]["num_workers"], 6)
        self.assertEqual(quality_call.kwargs["cap"], 500)
        # A normal large fresh keeps the caller's seed in Phase Q.  This is
        # important for independent clicks/devices: a hidden stable seed made
        # every run converge to the same hint-like timetable.
        self.assertEqual(quality_call.kwargs["random_seed"], 77)
        self.assertIs(quality_call.kwargs["incumbent_payload"], feasibility)
        self.assertFalse(quality_call.args[1]["optimization_benders_disable_session_early_stop"])
        self.assertTrue(
            quality_call.args[1]["optimization_benders_period_feasibility_all_sessions"]
        )
        self.assertEqual(quality_call.args[1]["optimization_benders_session_time_limit"], 31)
        self.assertEqual(quality_call.args[1]["optimization_benders_iterations"], 3)
        self.assertEqual(quality_call.args[1]["period_time_limit"], 15)
        self.assertEqual(quality_call.args[1]["num_workers"], 6)
        self.assertEqual(quality_call.args[1]["max_teacher_sessions"], 500)
        self.assertEqual(quality_call.args[1]["target_teacher_sessions"], 482)
        self.assertEqual(quality_call.args[1]["max_one_period_sessions"], 0)
        self.assertEqual(attempts[1]["quality_cap"], 500)
        self.assertTrue(attempts[1]["soft_hint_used"])
        self.assertFalse(attempts[1]["stable_large_quality_seed"])
        self.assertEqual(attempts[1]["random_seed"], 77)
        self.assertEqual(target_call.kwargs["cap"], 484)
        self.assertIs(target_call.kwargs["incumbent_payload"], quality)
        self.assertEqual(target_call.args[1]["max_teacher_sessions"], 484)
        self.assertEqual(attempts[2]["phase"], "fresh_complete_first_tighter_cap_probe")
        self.assertTrue(attempts[2]["new_best"])

    def test_small_first_click_keeps_requested_quality_seed(self) -> None:
        feasibility = _first_click_payload(
            teacher_sessions=30,
            gap1=8,
            scheduled_periods=100,
        )
        quality = _first_click_payload(
            teacher_sessions=24,
            gap1=4,
            scheduled_periods=100,
        )
        for payload in (feasibility, quality):
            payload["metrics"]["expected_periods"] = 100
            payload["metrics"]["unassigned_periods"] = 0
        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[feasibility, quality],
        ) as solve_candidate:
            result, _metrics, attempts, _termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    {
                        "target_teacher_sessions": 24,
                        "optimization_accept_teacher_sessions": 24,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                    },
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 20,
                        "start_cap": 24,
                        "upper_cap": 40,
                        "expected_periods": 100,
                    },
                    profile={"expected": 100, "class_count": 8},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(60),
                    polish_seeds=[1],
                    requested_random_seed=77,
                )
            )

        self.assertIs(result, quality)
        self.assertEqual(solve_candidate.call_args_list[0].kwargs["random_seed"], 77)
        self.assertEqual(solve_candidate.call_args_list[1].kwargs["random_seed"], 77)
        self.assertFalse(attempts[1]["stable_large_quality_seed"])

    def test_large_first_click_keeps_requested_quality_seed_by_default(self) -> None:
        """Independent fresh clicks must not silently fall back to seed 1."""
        feasibility = _first_click_payload(teacher_sessions=520, gap1=84)
        quality = _first_click_payload(teacher_sessions=498, gap1=58)
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "optimization_first_click_target_probe_enabled": False,
            "num_workers": 6,
        }
        bounds = {
            "lower_cap": 450,
            "start_cap": 466,
            "upper_cap": 650,
            "expected_periods": 1566,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[feasibility, quality],
        ) as solve_candidate:
            _result, _metrics, attempts, _termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds=bounds,
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(90),
                    polish_seeds=[1],
                    requested_random_seed=77,
                )
            )

        self.assertEqual(solve_candidate.call_count, 2)
        self.assertEqual(solve_candidate.call_args_list[1].kwargs["random_seed"], 77)
        self.assertFalse(attempts[1]["stable_large_quality_seed"])

    def test_large_lean_first_click_preserves_fast_primary_and_arms_rescue(self) -> None:
        feasibility = _first_click_payload(teacher_sessions=522, gap1=123)
        quality = _first_click_payload(teacher_sessions=482, gap1=68)
        settings = {
            "target_teacher_sessions": 466,
            "optimization_accept_teacher_sessions": 466,
            "optimization_first_click_quality_cap_headroom": 16,
            "optimization_first_click_lean_global_quality": True,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "optimization_first_click_target_probe_enabled": False,
            "num_workers": 6,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[feasibility, quality],
        ) as solve_candidate:
            result, _metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(90),
                    polish_seeds=[202],
                    requested_random_seed=202,
                )
            )

        self.assertIs(result, quality)
        self.assertEqual(termination, "first_click_strict_quality_improved")
        self.assertEqual(solve_candidate.call_count, 2)
        quality_call = solve_candidate.call_args_list[1]
        quality_settings = quality_call.args[1]
        self.assertEqual(quality_call.kwargs["cap"], 482)
        self.assertEqual(quality_call.kwargs["random_seed"], 202)
        self.assertIs(quality_call.kwargs["incumbent_payload"], feasibility)
        self.assertFalse(quality_settings["optimization_benders_period_feasibility_all_sessions"])
        self.assertTrue(quality_settings["optimization_benders_lean_refinement_periods"])
        self.assertFalse(quality_settings["optimization_benders_session_feasibility_only"])
        self.assertEqual(quality_settings["optimization_benders_iterations"], 1)
        self.assertEqual(quality_settings["session_cp_sat_linearization_level"], 1)
        self.assertLessEqual(quality_settings["optimization_benders_session_time_limit"], 20)
        self.assertTrue(quality_settings["_fixed_only_empty_fallback_attempted"])
        self.assertTrue(attempts[1]["period_safe_quality_rescue_armed"])
        self.assertFalse(attempts[1]["period_safe_quality_rescue"])
        self.assertFalse(attempts[1]["concrete_periods_materialized"])
        self.assertTrue(attempts[1]["soft_hint_used"])
        self.assertEqual(attempts[1]["request_random_seed"], 202)

    def test_lean_quality_error_uses_tight_period_safe_request_seed_rescue(self) -> None:
        feasibility = _first_click_payload(teacher_sessions=522, gap1=123)
        rescued = _first_click_payload(teacher_sessions=482, gap1=68)
        settings = {
            "target_teacher_sessions": 466,
            "optimization_accept_teacher_sessions": 466,
            "optimization_first_click_quality_cap_headroom": 16,
            "optimization_first_click_lean_global_quality": True,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "optimization_first_click_target_probe_enabled": False,
            "num_workers": 6,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[feasibility, RuntimeError("lean period vector failed"), rescued],
        ) as solve_candidate:
            result, _metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(90),
                    polish_seeds=[202],
                    requested_random_seed=202,
                )
            )

        self.assertIs(result, rescued)
        self.assertEqual(termination, "first_click_period_safe_quality_rescue_improved")
        self.assertEqual(solve_candidate.call_count, 3)
        rescue_call = solve_candidate.call_args_list[2]
        rescue_settings = rescue_call.args[1]
        self.assertEqual(rescue_call.kwargs["cap"], 482)
        self.assertEqual(
            rescue_call.kwargs["random_seed"],
            _first_click_request_portfolio_seed(202, 1),
        )
        self.assertIsNone(rescue_call.kwargs["incumbent_payload"])
        self.assertTrue(rescue_settings["optimization_benders_period_feasibility_all_sessions"])
        self.assertFalse(rescue_settings["optimization_benders_lean_refinement_periods"])
        self.assertTrue(rescue_settings["optimization_benders_session_feasibility_only"])
        self.assertEqual(rescue_settings["optimization_benders_iterations"], 1)
        self.assertLessEqual(rescue_settings["optimization_benders_session_time_limit"], 20)
        self.assertEqual(attempts[2]["attempt_key"], "fresh:phase_q:period_safe")
        self.assertTrue(attempts[2]["concrete_periods_materialized"])
        self.assertFalse(attempts[2]["soft_hint_used"])
        self.assertTrue(attempts[2]["new_best"])

    def test_period_safe_unknown_can_use_one_looser_cap_without_hint(self) -> None:
        feasibility = _first_click_payload(teacher_sessions=522, gap1=123)
        relaxed = _first_click_payload(teacher_sessions=500, gap1=91)
        settings = {
            "target_teacher_sessions": 466,
            "optimization_accept_teacher_sessions": 466,
            "optimization_first_click_quality_cap_headroom": 16,
            "optimization_first_click_lean_global_quality": True,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "optimization_first_click_target_probe_enabled": False,
            "num_workers": 6,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                feasibility,
                RuntimeError("lean period vector failed"),
                RuntimeError("tight integrated unknown"),
                relaxed,
            ],
        ) as solve_candidate:
            result, _metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(90),
                    polish_seeds=[202],
                    requested_random_seed=202,
                )
            )

        self.assertIs(result, relaxed)
        self.assertEqual(termination, "first_click_period_safe_relaxed_cap_improved")
        self.assertEqual(solve_candidate.call_count, 4)
        rescue_call = solve_candidate.call_args_list[3]
        rescue_settings = rescue_call.args[1]
        self.assertEqual(rescue_call.kwargs["cap"], 500)
        self.assertEqual(
            rescue_call.kwargs["random_seed"],
            _first_click_request_portfolio_seed(202, 2),
        )
        self.assertIsNone(rescue_call.kwargs["incumbent_payload"])
        self.assertTrue(rescue_settings["optimization_benders_period_feasibility_all_sessions"])
        self.assertFalse(rescue_settings["optimization_benders_lean_refinement_periods"])
        self.assertTrue(rescue_settings["optimization_benders_session_feasibility_only"])
        self.assertEqual(attempts[3]["attempt_key"], "fresh:phase_q:period_safe_relaxed_cap")
        self.assertTrue(attempts[3]["new_best"])

    def test_unbounded_first_click_deep_search_cannot_displace_safe_quality_incumbent(self) -> None:
        feasibility = _first_click_payload(teacher_sessions=520, gap1=84)
        quality = _first_click_payload(teacher_sessions=498, gap1=58)
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_unbounded_quality_search": True,
            "optimization_first_click_target_probe_enabled": True,
            "optimization_first_click_target_probe_time_limit_seconds": 220,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "num_workers": 6,
        }
        bounds = {
            "lower_cap": 450,
            "start_cap": 466,
            "upper_cap": 650,
            "expected_periods": 1566,
        }
        profile = {"expected": 1566, "class_count": 54}

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[feasibility, quality, RuntimeError("deep probe timeout")],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds=bounds,
                    profile=profile,
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(300),
                    polish_seeds=[1],
                    requested_random_seed=77,
                )
            )

        self.assertIs(result, quality)
        self.assertIs(metrics, quality["metrics"])
        self.assertEqual(termination, "first_click_strict_quality_improved")
        self.assertEqual(solve_candidate.call_count, 3)
        safe_call = solve_candidate.call_args_list[1]
        deep_call = solve_candidate.call_args_list[2]
        self.assertFalse(safe_call.args[1]["optimization_continue_quality_search"])
        self.assertEqual(safe_call.args[1]["optimization_benders_iterations"], 3)
        self.assertIs(deep_call.kwargs["incumbent_payload"], quality)
        self.assertTrue(deep_call.args[1]["optimization_continue_quality_search"])
        self.assertTrue(deep_call.args[1]["optimization_stop_on_stagnation"])
        self.assertEqual(
            deep_call.args[1]["optimization_benders_accept_stagnant_iterations"],
            2,
        )
        self.assertEqual(deep_call.kwargs["time_limit_seconds"], 120)
        self.assertLessEqual(
            deep_call.args[1]["optimization_benders_session_time_limit"],
            60,
        )
        self.assertGreater(deep_call.args[1]["optimization_benders_iterations"], 6)
        self.assertIn("deep probe timeout", attempts[2]["error"])
        self.assertTrue(attempts[2]["incumbent_retained"])

    def test_deep_benders_stops_after_two_no_candidate_slices_with_safe_incumbent(self) -> None:
        ctx = _context()
        incumbent = _first_click_payload(teacher_sessions=498, gap1=58)
        no_solution = SessionCpSatNoSolution(
            "tighter cap has no candidate",
            {"status_name": "UNKNOWN", "elapsed_seconds": 1.0},
        )

        with (
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=ctx),
            patch(
                "tkb_new.adapter._trim_context_to_available_slots",
                return_value=(ctx, []),
            ),
            patch(
                "tkb_new.adapter.solve_session_allocation_cp_sat",
                side_effect=no_solution,
            ) as solve_sessions,
        ):
            with self.assertRaisesRegex(RuntimeError, "accept_stagnation_stop"):
                _solve_teacher_session_benders_candidate(
                    {},
                    {
                        "optimization_benders_complete_first": True,
                        "optimization_benders_iterations": 20,
                        "optimization_benders_session_time_limit": 10,
                        "optimization_continue_quality_search": True,
                        "optimization_stop_on_stagnation": True,
                        "optimization_benders_accept_stagnant_iterations": 2,
                        "target_teacher_sessions": 482,
                        "max_one_period_sessions": 0,
                        "strict_one_period_sessions_cap": True,
                        "num_workers": 1,
                    },
                    cap=496,
                    time_limit_seconds=60,
                    rules=None,
                    progress=None,
                    incumbent_payload=incumbent,
                    deadline=SolverDeadline(60),
                )

        self.assertEqual(solve_sessions.call_count, 2)

    def test_complete_first_escalates_period_bridge_after_a_rejected_vector(self) -> None:
        ctx = _context()
        allocation = SessionAllocation(
            class_name="6/1",
            grade="Khoi 6",
            subject="Math",
            teacher="T1",
            session=Session(day=2, part="AM"),
            count=2,
        )
        lessons = [
            Lesson(
                class_name="6/1",
                grade="Khoi 6",
                day=2,
                session="AM",
                period=period,
                subject="Math",
                teacher="T1",
            )
            for period in (1, 2)
        ]
        payload = _first_click_payload(teacher_sessions=1, gap1=0)

        with (
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=ctx),
            patch(
                "tkb_new.adapter._trim_context_to_available_slots",
                return_value=(ctx, []),
            ),
            patch(
                "tkb_new.adapter.solve_session_allocation_cp_sat",
                return_value=([allocation], {"teacher_sessions": 1}),
            ) as solve_sessions,
            patch(
                "tkb_new.adapter.allocate_periods",
                side_effect=[
                    RuntimeError("first period vector rejected"),
                    RuntimeError("second period vector rejected"),
                    (lessons, {}),
                ],
            ) as allocate_periods_mock,
            patch(
                "tkb_new.adapter._cut_for_period_error_sparse",
                side_effect=[[(0, {0: 2})], [(1, {0: 1})]],
            ),
            patch("tkb_new.adapter.build_payload", return_value=payload),
        ):
            result = _solve_teacher_session_benders_candidate(
                {},
                {
                    "optimization_benders_complete_first": True,
                    "optimization_benders_iterations": 3,
                    "optimization_benders_skip_relaxed_period_probe": True,
                    "optimization_benders_period_feasibility_all_sessions": False,
                    "period_max_teacher_gap": "off",
                    "target_teacher_sessions": 1,
                    "max_one_period_sessions": 0,
                    "strict_one_period_sessions_cap": True,
                    "num_workers": 1,
                },
                cap=2,
                time_limit_seconds=30,
                rules=None,
                progress=None,
                deadline=SolverDeadline(30),
            )

        self.assertIs(result, payload)
        self.assertEqual(solve_sessions.call_count, 3)
        self.assertTrue(
            all(
                call.kwargs["early_stop_teacher_sessions"] == 1
                for call in solve_sessions.call_args_list
            )
        )
        self.assertIsNone(
            solve_sessions.call_args_list[0].kwargs["period_feasibility_session_indexes"]
        )
        self.assertEqual(
            solve_sessions.call_args_list[2].kwargs["period_feasibility_session_indexes"],
            set(range(12)),
        )
        self.assertTrue(
            all(
                call.kwargs["max_teacher_gap"] is None
                and call.kwargs["minimize_teacher_gaps"] is True
                for call in allocate_periods_mock.call_args_list
            )
        )

    def test_lean_refinement_expands_fixed_period_bridge_only_in_empty_fallback(self) -> None:
        ctx = _context()
        assignment = ctx.school_data.assignments[0]
        fixed_lesson = Lesson(
            class_name=assignment.class_name,
            grade=assignment.grade,
            day=2,
            session="AM",
            period=1,
            subject=assignment.subject,
            teacher=assignment.teacher,
        )
        no_solution = SessionCpSatNoSolution(
            "probe complete",
            {"status_name": "UNKNOWN", "elapsed_seconds": 0.01},
        )

        for lean_refinement, expected_indexes in (
            (False, set(range(12))),
            (True, None),
        ):
            with self.subTest(lean_refinement=lean_refinement):
                settings = {
                    "preserve_fixed_lessons_only": True,
                    "optimization_benders_iterations": 1,
                    "optimization_benders_session_time_limit": 10,
                    "max_one_period_sessions": 0,
                    "strict_one_period_sessions_cap": True,
                    "num_workers": 1,
                }
                if lean_refinement:
                    settings["optimization_benders_lean_refinement_periods"] = True
                with (
                    patch("tkb_new.adapter.build_school_data_from_ui", return_value=ctx),
                    patch(
                        "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                        return_value=([fixed_lesson], []),
                    ),
                    patch(
                        "tkb_new.adapter._release_invalid_fixed_lessons",
                        return_value=([fixed_lesson], []),
                    ),
                    patch(
                        "tkb_new.adapter._trim_context_to_available_slots",
                        return_value=(ctx, []),
                    ),
                    patch(
                        "tkb_new.adapter.solve_session_allocation_cp_sat",
                        side_effect=no_solution,
                    ) as solve_sessions,
                ):
                    with self.assertRaisesRegex(RuntimeError, "Benders teacher-session cap search failed"):
                        _solve_teacher_session_benders_candidate(
                            {},
                            settings,
                            cap=2,
                            time_limit_seconds=30,
                            rules=ctx.rules,
                            progress=None,
                            deadline=SolverDeadline(30),
                        )

                self.assertEqual(solve_sessions.call_count, 2)
                self.assertEqual(
                    solve_sessions.call_args_list[0].kwargs["period_feasibility_session_indexes"],
                    expected_indexes,
                )
                self.assertEqual(
                    solve_sessions.call_args_list[1].kwargs["period_feasibility_session_indexes"],
                    set(range(12)),
                )

    def test_fixed_only_lean_failure_retries_empty_flexible_with_hard_anchors(self) -> None:
        """A sparse fixed-only request gets one no-hint full-period retry."""
        ctx = _context()
        assignment = ctx.school_data.assignments[0]
        fixed_lesson = Lesson(
            class_name=assignment.class_name,
            grade=assignment.grade,
            day=2,
            session="AM",
            period=1,
            subject=assignment.subject,
            teacher=assignment.teacher,
        )
        residual_allocation = SessionAllocation(
            class_name=assignment.class_name,
            grade=assignment.grade,
            subject=assignment.subject,
            teacher=assignment.teacher,
            session=Session(day=3, part="AM"),
            count=1,
        )
        residual_lesson = Lesson(
            class_name=assignment.class_name,
            grade=assignment.grade,
            day=3,
            session="AM",
            period=1,
            subject=assignment.subject,
            teacher=assignment.teacher,
        )
        no_solution = SessionCpSatNoSolution(
            "lean anchor-preserving vector rejected",
            {"status_name": "UNKNOWN", "elapsed_seconds": 0.01},
        )
        settings = {
            "preserve_fixed_lessons_only": True,
            "optimization_benders_iterations": 1,
            "optimization_benders_session_time_limit": 10,
            "optimization_benders_lean_refinement_periods": True,
            "optimization_benders_period_feasibility_all_sessions": False,
            "max_one_period_sessions": "off",
            "strict_one_period_sessions_cap": False,
            "num_workers": 1,
        }

        with (
            patch("tkb_new.adapter.build_school_data_from_ui", return_value=ctx),
            patch(
                "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                return_value=([fixed_lesson], []),
            ),
            patch(
                "tkb_new.adapter._release_invalid_fixed_lessons",
                return_value=([fixed_lesson], []),
            ),
            patch(
                "tkb_new.adapter._trim_context_to_available_slots",
                return_value=(ctx, []),
            ),
            patch(
                "tkb_new.adapter.solve_session_allocation_cp_sat",
                side_effect=[
                    no_solution,
                    ([residual_allocation], {"teacher_sessions": 1, "status_name": "FEASIBLE"}),
                ],
            ) as solve_sessions,
            patch(
                "tkb_new.adapter.allocate_periods",
                return_value=([residual_lesson], {"solver": "test-period"}),
            ) as allocate_periods_mock,
        ):
            result = _solve_teacher_session_benders_candidate(
                {},
                settings,
                cap=2,
                time_limit_seconds=30,
                rules=ctx.rules,
                progress=None,
                incumbent_payload=None,
                deadline=SolverDeadline(30),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["metrics"]["scheduled_periods"], 2)
        self.assertEqual(result["metrics"]["expected_periods"], 2)
        self.assertTrue(result["metrics"]["hard_ok"])
        self.assertEqual(solve_sessions.call_count, 2)
        self.assertIsNone(
            solve_sessions.call_args_list[0].kwargs["period_feasibility_session_indexes"]
        )
        self.assertEqual(
            solve_sessions.call_args_list[1].kwargs["period_feasibility_session_indexes"],
            set(range(12)),
        )
        self.assertIsNone(solve_sessions.call_args_list[1].kwargs["hint_allocations"])
        self.assertFalse(solve_sessions.call_args_list[1].kwargs["repair_hint"])
        self.assertEqual(solve_sessions.call_args_list[1].kwargs["fixed_lessons"], [fixed_lesson])
        self.assertEqual(allocate_periods_mock.call_count, 1)
        runtime = result["solver"]["runtime_settings"]
        self.assertTrue(runtime["fixed_only_empty_fallback"])
        self.assertTrue(runtime["fixed_only_empty_fallback_no_hint"])

    def test_first_click_rejects_bad_quality_and_retains_exact_feasible_result(self) -> None:
        fixed_lesson = Lesson(
            class_name="6/1",
            grade="6",
            day=2,
            session="AM",
            period=1,
            subject="Math",
            teacher="T1",
        )
        feasibility = _first_click_payload(teacher_sessions=490, gap1=60)
        gap2_quality = _first_click_payload(teacher_sessions=480, gap1=49)
        gap2_quality["metrics"]["gap_distribution"] = {"0": 479, "2": 1}
        outcomes = {
            "quality_exception": RuntimeError("quality timeout"),
            "incomplete": _first_click_payload(
                teacher_sessions=480,
                gap1=50,
                scheduled_periods=1565,
            ),
            "fixed_lesson_lost": _first_click_payload(
                teacher_sessions=480,
                gap1=50,
                include_fixed_lesson=False,
            ),
            "one_period_session": _first_click_payload(
                teacher_sessions=480,
                gap1=50,
                one_period_sessions=1,
            ),
            "gap2_session": gap2_quality,
            "not_better": _first_click_payload(teacher_sessions=495, gap1=55),
            "over_quality_cap": _first_click_payload(teacher_sessions=501, gap1=40),
        }
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "num_workers": 6,
        }
        bounds = {
            "lower_cap": 450,
            "start_cap": 466,
            "upper_cap": 650,
            "expected_periods": 1566,
        }
        profile = {"expected": 1566, "class_count": 54}

        for label, outcome in outcomes.items():
            with self.subTest(label=label):
                with (
                    patch(
                        "tkb_new.adapter._extract_hard_fixed_lessons_from_tkb",
                        return_value=([fixed_lesson], []),
                    ),
                    patch(
                        "tkb_new.adapter._release_invalid_fixed_lessons",
                        return_value=([fixed_lesson], []),
                    ),
                    patch(
                        "tkb_new.adapter._solve_teacher_session_benders_candidate",
                        side_effect=[feasibility, outcome],
                    ) as solve_candidate,
                ):
                    result, metrics, attempts, termination = (
                        _solve_unified_first_click_feasibility_then_quality(
                            {},
                            settings,
                            bound_ctx=_context(),
                            bounds=bounds,
                            profile=profile,
                            rules=None,
                            progress=None,
                            deadline=SolverDeadline(90),
                            polish_seeds=[1],
                            requested_random_seed=1,
                        )
                    )

                self.assertIs(result, feasibility)
                self.assertIs(metrics, feasibility["metrics"])
                self.assertEqual(solve_candidate.call_count, 2)
                self.assertIn("retained_after_quality", termination)
                self.assertTrue(attempts[1]["incumbent_retained"])

    def test_first_click_skips_quality_when_return_reserve_would_be_consumed(self) -> None:
        feasibility = _first_click_payload(teacher_sessions=520, gap1=84)
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "num_workers": 6,
        }
        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=feasibility,
        ) as solve_candidate:
            result, _metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(24),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, feasibility)
        self.assertEqual(solve_candidate.call_count, 1)
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertTrue(attempts[1]["skipped"])
        self.assertEqual(attempts[1]["reason"], "watchdog_return_reserve")

    def test_constraint_change_first_click_accepts_hard_valid_quality_debt(self) -> None:
        feasibility = _first_click_payload(
            teacher_sessions=520,
            gap1=84,
            one_period_sessions=1,
        )
        feasibility["metrics"]["gap_distribution"] = {"0": 518, "2": 1}
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "ui_constraint_change_fresh_retry": True,
            "ui_constraint_change_rebuild_from_empty": True,
            "max_one_period_sessions": 0,
            "strict_one_period_sessions_cap": True,
            "enforce_max_one_period_sessions": True,
            "period_max_teacher_gap": 1,
            "num_workers": 6,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=feasibility,
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(24),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, feasibility)
        self.assertIs(metrics, feasibility["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 2)
        strict_settings = solve_candidate.call_args_list[0].args[1]
        self.assertEqual(strict_settings["max_one_period_sessions"], 0)
        self.assertTrue(strict_settings["strict_one_period_sessions_cap"])
        self.assertEqual(strict_settings["period_max_teacher_gap"], 1)
        self.assertTrue(attempts[0]["strict_quality_gate_first"])
        self.assertFalse(attempts[0]["accepted"])
        feasibility_settings = solve_candidate.call_args_list[1].args[1]
        self.assertEqual(
            feasibility_settings["auto_sort_strategy"],
            "constraint_change_quality_debt_fallback",
        )
        self.assertEqual(feasibility_settings["max_one_period_sessions"], "off")
        self.assertFalse(feasibility_settings["strict_one_period_sessions_cap"])
        self.assertFalse(feasibility_settings["enforce_max_one_period_sessions"])
        self.assertTrue(feasibility_settings["allow_quality_debt"])
        self.assertTrue(feasibility_settings["optimization_benders_allow_one_period_debt"])
        self.assertTrue(feasibility_settings["optimization_benders_session_feasibility_only"])
        self.assertTrue(
            feasibility_settings["optimization_benders_period_feasibility_all_sessions"]
        )
        self.assertEqual(feasibility_settings["period_max_teacher_gap"], "off")
        self.assertTrue(attempts[1]["constraint_change_feasibility_first"])
        self.assertTrue(attempts[1]["quality_debt_allowed"])
        self.assertTrue(attempts[1]["accepted"])

    def test_bounded_fresh_first_click_accepts_hard_valid_quality_debt(self) -> None:
        feasibility = _first_click_payload(
            teacher_sessions=520,
            gap1=84,
            one_period_sessions=1,
        )
        feasibility["metrics"]["gap_distribution"] = {"0": 518, "2": 1}
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "ui_bounded_fresh_accept_quality_debt": True,
            "num_workers": 6,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=feasibility,
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(24),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, feasibility)
        self.assertIs(metrics, feasibility["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 2)
        strict_settings = solve_candidate.call_args_list[0].args[1]
        self.assertEqual(strict_settings["max_one_period_sessions"], 0)
        self.assertTrue(strict_settings["strict_one_period_sessions_cap"])
        self.assertEqual(strict_settings["period_max_teacher_gap"], 1)
        feasibility_settings = solve_candidate.call_args_list[1].args[1]
        self.assertEqual(
            feasibility_settings["auto_sort_strategy"],
            "fresh_complete_quality_debt_fallback",
        )
        self.assertEqual(feasibility_settings["max_one_period_sessions"], "off")
        self.assertFalse(feasibility_settings["strict_one_period_sessions_cap"])
        self.assertFalse(feasibility_settings["enforce_max_one_period_sessions"])
        self.assertTrue(feasibility_settings["allow_quality_debt"])
        self.assertTrue(feasibility_settings["optimization_benders_allow_one_period_debt"])
        self.assertFalse(feasibility_settings["optimization_benders_session_feasibility_only"])
        self.assertEqual(feasibility_settings["period_max_teacher_gap"], "off")
        self.assertEqual(solve_candidate.call_args_list[1].kwargs["cap"], 522)
        self.assertEqual(feasibility_settings["max_teacher_sessions"], 522)
        self.assertFalse(attempts[0]["constraint_change_feasibility_first"])
        self.assertTrue(attempts[0]["bounded_fresh_quality_debt"])
        self.assertFalse(attempts[0]["quality_debt_allowed"])
        self.assertFalse(attempts[0]["accepted"])
        self.assertTrue(attempts[1]["quality_debt_allowed"])
        self.assertTrue(attempts[1]["accepted"])

    def test_partial_payload_can_treat_teacher_gap_as_quality_debt(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [
                {"ten": "Math", "ma": "M"},
                {"ten": "Art", "ma": "A"},
            ],
            "mon": [
                {"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1},
                {"khoi": "6", "ten": "Art", "sotiet": 1, "gioihan": 1},
            ],
            "pccmMatrix": {
                "L1|Math": "T1",
                "L1|Art": "T1",
            },
            "pccmTietMatrix": {
                "L1|Math": 1,
                "L1|Art": 1,
            },
        }
        ctx = build_school_data_from_ui(data)
        grade = ctx.school_data.assignments[0].grade
        lessons = [
            Lesson(
                class_name="6/1",
                grade=grade,
                day=2,
                session="AM",
                period=1,
                subject="Math",
                teacher="T1",
            ),
            Lesson(
                class_name="6/1",
                grade=grade,
                day=2,
                session="AM",
                period=4,
                subject="Art",
                teacher="T1",
            ),
        ]

        strict = build_payload(ctx, lessons, {}, original_ctx=ctx)
        relaxed = build_payload(
            ctx,
            lessons,
            {},
            original_ctx=ctx,
            allow_temporary_teacher_gap_debt=True,
        )

        self.assertEqual(strict["metrics"]["gap_distribution"], {2: 1})
        self.assertFalse(strict["metrics"]["hard_ok"])
        self.assertTrue(relaxed["metrics"]["core_hard_ok"])
        self.assertTrue(relaxed["metrics"]["hard_ok"])
        self.assertEqual(relaxed["metrics"]["scheduled_periods"], 2)
        self.assertEqual(relaxed["metrics"]["expected_periods"], 2)
        self.assertEqual(relaxed["metrics"]["app_constraint_violation_count"], 0)

    def test_manual_fresh_retry_expands_feasibility_and_session_slice(self) -> None:
        feasibility = _first_click_payload(
            teacher_sessions=520,
            gap1=84,
            one_period_sessions=1,
        )
        feasibility["metrics"]["gap_distribution"] = {"0": 518, "2": 1}
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_feasibility_time_limit_seconds": 70,
            "optimization_first_click_local_lns_time_limit_seconds": 0,
            "overall_time_limit_seconds": 85,
            "ui_manual_fresh_retry_seconds": 85,
            "ui_manual_fresh_retry_failures": 5,
            "ui_bounded_fresh_accept_quality_debt": True,
            "num_workers": 6,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=feasibility,
        ) as solve_candidate:
            result, _metrics, _attempts, _termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(85),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, feasibility)
        self.assertEqual(solve_candidate.call_count, 3)
        feasibility_call = solve_candidate.call_args_list[0]
        fallback_call = solve_candidate.call_args_list[1]
        self.assertGreaterEqual(feasibility_call.kwargs["time_limit_seconds"], 39)
        self.assertLessEqual(feasibility_call.kwargs["time_limit_seconds"], 40)
        self.assertGreaterEqual(fallback_call.kwargs["time_limit_seconds"], 79)
        self.assertLessEqual(fallback_call.kwargs["time_limit_seconds"], 80)
        self.assertEqual(
            feasibility_call.args[1]["optimization_benders_session_time_limit"],
            36,
        )

    def test_first_click_with_tight_teacher_days_uses_session_model_without_period_bridge(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {
                "teacher": {
                    "T1": {"maxDaysSessions": {"maxDays": 3}},
                }
            },
        }
        ctx = build_school_data_from_ui(data)
        feasibility = _first_click_payload(teacher_sessions=1, gap1=0)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=feasibility,
        ) as solve_candidate:
            result, _metrics, attempts, _termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    {
                        "target_teacher_sessions": 1,
                        "optimization_accept_teacher_sessions": 1,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "num_workers": 1,
                    },
                    bound_ctx=ctx,
                    bounds={
                        "lower_cap": 1,
                        "start_cap": 1,
                        "upper_cap": 1,
                        "expected_periods": 1,
                    },
                    profile={"expected": 1, "class_count": 1},
                    rules=ctx.rules,
                    progress=None,
                    deadline=SolverDeadline(24),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, feasibility)
        feasibility_settings = solve_candidate.call_args.args[1]
        self.assertFalse(
            feasibility_settings["optimization_benders_period_feasibility_all_sessions"]
        )
        self.assertTrue(feasibility_settings["optimization_benders_lean_refinement_periods"])
        self.assertFalse(attempts[0]["constraint_change_feasibility_first"])
        self.assertFalse(attempts[0]["period_feasibility_bridge_required"])
        self.assertFalse(attempts[0]["period_feasibility_all_sessions"])
        self.assertFalse(attempts[0]["safe_period_feasibility_first"])

    def test_first_60_second_teacher_day_rule_stays_on_lean_session_model(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {
                "teacher": {
                    "T1": {"maxDaysSessions": {"maxDays": 3}},
                }
            },
        }
        ctx = build_school_data_from_ui(data)
        feasibility = _first_click_payload(teacher_sessions=1, gap1=0)

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=feasibility,
        ) as solve_candidate:
            _solve_unified_first_click_feasibility_then_quality(
                data,
                {
                    "target_teacher_sessions": 1,
                    "optimization_accept_teacher_sessions": 1,
                    "optimization_first_click_feasibility_time_limit_seconds": 60,
                    "optimization_first_click_local_lns_time_limit_seconds": 0,
                    "overall_time_limit_seconds": 60,
                    "ui_bounded_fresh_accept_quality_debt": True,
                    "num_workers": 6,
                },
                bound_ctx=ctx,
                bounds={
                    "lower_cap": 1,
                    "start_cap": 1,
                    "upper_cap": 1,
                    "expected_periods": 1,
                },
                profile={"expected": 1, "class_count": 1},
                rules=ctx.rules,
                progress=None,
                deadline=SolverDeadline(60),
                polish_seeds=[1],
                requested_random_seed=1,
            )

        self.assertEqual(solve_candidate.call_count, 1)
        feasibility_call = solve_candidate.call_args
        self.assertGreaterEqual(feasibility_call.kwargs["time_limit_seconds"], 26)
        self.assertLessEqual(feasibility_call.kwargs["time_limit_seconds"], 27)
        self.assertEqual(
            feasibility_call.args[1]["optimization_benders_session_time_limit"],
            24,
        )
        self.assertFalse(
            feasibility_call.args[1]["optimization_benders_period_feasibility_all_sessions"]
        )
        self.assertTrue(feasibility_call.args[1]["optimization_benders_lean_refinement_periods"])
        self.assertEqual(feasibility_call.args[1]["max_one_period_sessions"], 0)
        self.assertTrue(feasibility_call.args[1]["strict_one_period_sessions_cap"])

    def test_period_bridge_bounded_click_prioritizes_the_strict_quality_gate(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {
                "fixedOff": {
                    "class": {
                        "L1": {"thu2|sang|0": True},
                    },
                }
            },
        }
        ctx = build_school_data_from_ui(data)
        hard_valid = _first_click_payload(
            teacher_sessions=2,
            gap1=0,
            one_period_sessions=0,
        )
        hard_valid["metrics"]["gap_distribution"] = {"0": 2}

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            return_value=hard_valid,
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    {
                        "target_teacher_sessions": 2,
                        "optimization_accept_teacher_sessions": 2,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "optimization_first_click_quality_cap_headroom": 1,
                        "overall_time_limit_seconds": 60,
                        "ui_bounded_fresh_accept_quality_debt": True,
                        "num_workers": 6,
                    },
                    bound_ctx=ctx,
                    bounds={
                        "lower_cap": 2,
                        "start_cap": 2,
                        "upper_cap": 4,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 1},
                    rules=ctx.rules,
                    progress=None,
                    deadline=SolverDeadline(60),
                    polish_seeds=[1],
                    requested_random_seed=2054740674,
                )
            )

        self.assertIs(result, hard_valid)
        self.assertIs(metrics, hard_valid["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 1)
        phase_f_settings = solve_candidate.call_args.args[1]
        # The first-result gate stays wide at the data-sized completion cap,
        # but one-period sessions and gap>=2 remain forbidden.
        self.assertEqual(solve_candidate.call_args.kwargs["cap"], 4)
        self.assertEqual(phase_f_settings["max_teacher_sessions"], 4)
        self.assertEqual(
            phase_f_settings["auto_sort_strategy"],
            "fresh_complete_first_feasibility",
        )
        self.assertEqual(phase_f_settings["max_one_period_sessions"], 0)
        self.assertEqual(phase_f_settings["period_max_teacher_gap"], 1)
        self.assertTrue(phase_f_settings["optimization_benders_session_feasibility_only"])
        self.assertFalse(attempts[0]["safe_period_feasibility_first"])
        self.assertTrue(attempts[0]["strict_quality_gate_first"])
        self.assertFalse(attempts[0]["quality_debt_allowed"])
        self.assertTrue(attempts[0]["accepted"])
        self.assertFalse(
            any(
                item.get("attempt_key") == "fresh:phase_f:quality_debt_fallback"
                for item in attempts
            )
        )

    def test_subject_period_requirements_keep_complete_incumbent_then_run_wide_strict_cleanup(self) -> None:
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
                            "L1": {
                                "lessonBlocks": {"2": {"min": 1}},
                                "avoidBreakPair23": {
                                    "morning": True,
                                    "afternoon": True,
                                },
                            }
                        }
                    }
                }
            },
        }
        ctx = build_school_data_from_ui(data)
        hard_valid = _first_click_payload(
            teacher_sessions=522,
            gap1=75,
            one_period_sessions=28,
        )
        hard_valid["metrics"]["gap_distribution"] = {"0": 442, "1": 75, "2": 5}
        strict_clean = _first_click_payload(
            teacher_sessions=507,
            gap1=99,
            one_period_sessions=0,
        )

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[hard_valid, strict_clean],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    {
                        "target_teacher_sessions": 466,
                        "optimization_accept_teacher_sessions": 466,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "optimization_first_click_strict_quality_gate": True,
                        "overall_time_limit_seconds": 180,
                        "ui_bounded_fresh_accept_quality_debt": True,
                        "ui_stop_after_first_complete_schedule": True,
                        "optimization_first_click_skip_global_quality": True,
                        "num_workers": 6,
                    },
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

        self.assertIs(result, strict_clean)
        self.assertIs(metrics, strict_clean["metrics"])
        self.assertEqual(termination, "first_click_strict_quality_improved")
        self.assertEqual(solve_candidate.call_count, 2)
        phase_f_settings = solve_candidate.call_args_list[0].args[1]
        self.assertEqual(
            phase_f_settings["auto_sort_strategy"],
            "fresh_complete_period_safe_feasibility",
        )
        self.assertEqual(phase_f_settings["max_one_period_sessions"], "off")
        self.assertEqual(phase_f_settings["period_max_teacher_gap"], "off")
        self.assertTrue(phase_f_settings["allow_quality_debt"])
        self.assertTrue(attempts[0]["subject_period_requirements_completion_first"])
        self.assertTrue(attempts[0]["safe_period_feasibility_first"])
        self.assertFalse(attempts[0]["strict_quality_gate_first"])
        self.assertTrue(attempts[0]["quality_debt_allowed"])
        self.assertTrue(attempts[0]["accepted"])
        cleanup_settings = solve_candidate.call_args_list[1].args[1]
        self.assertEqual(cleanup_settings["max_teacher_sessions"], 522)
        self.assertEqual(cleanup_settings["optimization_accept_teacher_sessions"], 522)
        self.assertEqual(cleanup_settings["max_one_period_sessions"], 0)
        self.assertEqual(cleanup_settings["period_max_teacher_gap"], 1)
        self.assertTrue(cleanup_settings["optimization_benders_period_feasibility_all_sessions"])
        self.assertFalse(cleanup_settings["optimization_benders_lean_refinement_periods"])
        self.assertTrue(cleanup_settings["subject_period_strict_quality_cleanup"])
        self.assertTrue(attempts[1]["subject_period_strict_quality_cleanup"])
        self.assertTrue(attempts[1]["accepted"])

    def test_subject_period_strict_cleanup_failure_keeps_complete_hard_valid_incumbent(self) -> None:
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
        hard_valid = _first_click_payload(
            teacher_sessions=522,
            gap1=75,
            one_period_sessions=28,
        )
        hard_valid["metrics"]["gap_distribution"] = {"0": 442, "1": 75, "2": 5}

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[hard_valid, RuntimeError("strict cleanup timeout")],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    {
                        "target_teacher_sessions": 466,
                        "optimization_accept_teacher_sessions": 466,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "overall_time_limit_seconds": 180,
                        "ui_bounded_fresh_accept_quality_debt": True,
                        "ui_stop_after_first_complete_schedule": True,
                        "optimization_first_click_skip_global_quality": True,
                        "num_workers": 6,
                    },
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

        self.assertIs(result, hard_valid)
        self.assertIs(metrics, hard_valid["metrics"])
        self.assertEqual(
            termination,
            "first_click_feasibility_retained_after_quality_error",
        )
        self.assertEqual(solve_candidate.call_count, 2)
        self.assertIn("strict cleanup timeout", attempts[1]["error"])
        self.assertTrue(attempts[1]["incumbent_retained"])

    def test_plain_large_fresh_first_click_runs_cleanup_without_subject_period_rows(self) -> None:
        """The default school has no lessonBlocks, but still needs teacher cleanup."""
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        ctx = build_school_data_from_ui(data)
        hard_valid = _first_click_payload(
            teacher_sessions=522,
            gap1=75,
            one_period_sessions=28,
        )
        hard_valid["metrics"]["gap_distribution"] = {"0": 442, "1": 75, "2": 5}
        strict_clean = _first_click_payload(
            teacher_sessions=522,
            gap1=104,
            one_period_sessions=0,
        )
        strict_clean["metrics"]["gap_distribution"] = {"0": 418, "1": 104}

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[hard_valid, strict_clean],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    data,
                    {
                        "target_teacher_sessions": 466,
                        "optimization_accept_teacher_sessions": 466,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "optimization_first_click_quality_time_limit_seconds": 120,
                        "overall_time_limit_seconds": 180,
                        "ui_bounded_fresh_accept_quality_debt": True,
                        "ui_unified_first_click_quality": True,
                        "ui_unified_solve_kind": "fresh_complete_first",
                        "ui_stop_after_first_complete_schedule": True,
                        "optimization_first_click_skip_global_quality": True,
                        "num_workers": 6,
                    },
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

        self.assertIs(result, strict_clean)
        self.assertIs(metrics, strict_clean["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 2)
        self.assertFalse(attempts[0]["safe_period_feasibility_first"])
        self.assertTrue(attempts[0]["strict_quality_gate_first"])
        self.assertFalse(attempts[0]["accepted"])
        self.assertEqual(
            attempts[1]["attempt_key"],
            "fresh:phase_f:strict_quality_retry",
        )
        self.assertTrue(attempts[1]["accepted"])
        cleanup_settings = solve_candidate.call_args_list[1].args[1]
        self.assertEqual(cleanup_settings["max_teacher_sessions"], 522)
        self.assertEqual(cleanup_settings["optimization_accept_teacher_sessions"], 522)
        self.assertEqual(cleanup_settings["max_one_period_sessions"], 0)
        self.assertEqual(cleanup_settings["period_max_teacher_gap"], 1)
        self.assertTrue(cleanup_settings["optimization_benders_period_feasibility_all_sessions"])
        self.assertFalse(cleanup_settings["optimization_benders_lean_refinement_periods"])

    def test_strict_quality_gate_unknown_retries_a_distinct_seed(self) -> None:
        complete = _first_click_payload(teacher_sessions=520, gap1=90)
        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[RuntimeError("tight cap unknown"), complete],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    {
                        "target_teacher_sessions": 482,
                        "optimization_accept_teacher_sessions": 482,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "overall_time_limit_seconds": 60,
                        "ui_constraint_change_fresh_retry": True,
                        "ui_stop_after_first_complete_schedule": True,
                        "num_workers": 6,
                    },
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(60),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, complete)
        self.assertIs(metrics, complete["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 2)
        self.assertEqual(solve_candidate.call_args_list[0].kwargs["cap"], 522)
        self.assertEqual(solve_candidate.call_args_list[1].kwargs["cap"], 522)
        self.assertEqual(
            solve_candidate.call_args_list[1].kwargs["random_seed"],
            _first_click_request_portfolio_seed(1, 1),
        )
        self.assertFalse(attempts[0]["accepted"])
        self.assertTrue(attempts[1]["accepted"])
        self.assertFalse(attempts[1]["quality_debt_allowed"])
        self.assertEqual(attempts[1]["attempt_key"], "fresh:phase_f:strict_quality_retry")

    def test_strict_quality_gate_keeps_a_reserved_complete_debt_fallback(self) -> None:
        complete = _first_click_payload(
            teacher_sessions=610,
            gap1=90,
            one_period_sessions=12,
        )
        complete["metrics"]["gap_distribution"] = {"0": 580, "2": 30}
        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                RuntimeError("primary strict unknown"),
                RuntimeError("alternate strict unknown"),
                complete,
            ],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    {
                        "target_teacher_sessions": 482,
                        "optimization_accept_teacher_sessions": 482,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "overall_time_limit_seconds": 110,
                        "ui_constraint_change_fresh_retry": True,
                        "ui_stop_after_first_complete_schedule": True,
                        "num_workers": 6,
                    },
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(110),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, complete)
        self.assertIs(metrics, complete["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 3)
        fallback_call = solve_candidate.call_args_list[2]
        self.assertEqual(fallback_call.kwargs["cap"], 650)
        self.assertGreaterEqual(fallback_call.kwargs["time_limit_seconds"], 45)
        fallback_settings = fallback_call.args[1]
        self.assertEqual(fallback_settings["max_one_period_sessions"], "off")
        self.assertEqual(fallback_settings["period_max_teacher_gap"], "off")
        self.assertTrue(fallback_settings["optimization_benders_session_feasibility_only"])
        self.assertFalse(attempts[0]["accepted"])
        self.assertFalse(attempts[1]["accepted"])
        self.assertTrue(attempts[2]["accepted"])
        self.assertTrue(attempts[2]["quality_debt_allowed"])

    def test_strict_quality_gate_retains_a_complete_debt_safety_candidate(self) -> None:
        complete_with_debt = _first_click_payload(
            teacher_sessions=610,
            gap1=90,
            one_period_sessions=12,
        )
        complete_with_debt["metrics"]["gap_distribution"] = {"0": 580, "2": 30}
        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[
                complete_with_debt,
                RuntimeError("alternate strict unknown"),
                RuntimeError("completion fallback unknown"),
            ],
        ) as solve_candidate:
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    {
                        "target_teacher_sessions": 482,
                        "optimization_accept_teacher_sessions": 482,
                        "optimization_first_click_local_lns_time_limit_seconds": 0,
                        "overall_time_limit_seconds": 110,
                        "ui_constraint_change_fresh_retry": True,
                        "ui_stop_after_first_complete_schedule": True,
                        "num_workers": 6,
                    },
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(110),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        self.assertIs(result, complete_with_debt)
        self.assertIs(metrics, complete_with_debt["metrics"])
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertEqual(solve_candidate.call_count, 3)
        self.assertTrue(attempts[0]["quality_debt_safety_retained"])
        safety_attempt = next(
            item
            for item in attempts
            if item.get("attempt_key") == "fresh:phase_f:quality_debt_safety"
        )
        self.assertTrue(safety_attempt["quality_debt_allowed"])

    def test_fixed_and_residual_teacher_max_days_stays_on_the_session_model(self) -> None:
        classes = [
            {"id": "L1", "ten": "6/1", "khoi": "6"},
            {"id": "L2", "ten": "6/2", "khoi": "6"},
            {"id": "L3", "ten": "6/3", "khoi": "6"},
        ]
        data = {
            "lop": classes,
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {f"{item['id']}|Math": "T1" for item in classes},
            "pccmTietMatrix": {f"{item['id']}|Math": 1 for item in classes},
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math", "fixed": True},
                            "",
                            "",
                            "",
                            "",
                        ]
                    }
                }
            },
            "tkbConstraints": {
                "teacher": {
                    "T1": {
                        "maxDaysSessions": {"maxDays": 1, "maxSessions": 1},
                    }
                }
            },
        }
        ctx = build_school_data_from_ui(data)
        result, metrics, attempts, termination = (
            _solve_unified_first_click_feasibility_then_quality(
                data,
                {
                    "target_teacher_sessions": 1,
                    "optimization_accept_teacher_sessions": 1,
                    "optimization_first_click_feasibility_time_limit_seconds": 12,
                    "optimization_first_click_local_lns_time_limit_seconds": 0,
                    "overall_time_limit_seconds": 12,
                    "ui_bounded_fresh_accept_quality_debt": True,
                    "ui_stop_after_first_complete_schedule": True,
                    "num_workers": 1,
                },
                bound_ctx=ctx,
                bounds={
                    "lower_cap": 1,
                    "start_cap": 1,
                    "upper_cap": 12,
                    "expected_periods": 3,
                },
                profile={"expected": 3, "class_count": 3},
                rules=ctx.rules,
                progress=None,
                deadline=SolverDeadline(15),
                polish_seeds=[1],
                requested_random_seed=1,
            )
        )

        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertTrue(metrics["hard_ok"], json.dumps(result, ensure_ascii=False))
        self.assertEqual(metrics["scheduled_periods"], 3)
        self.assertEqual(metrics["unassigned_periods"], 0)
        teacher_lessons = [item for item in result["lessons"] if item.get("teacher") == "T1"]
        self.assertEqual(len(teacher_lessons), 3)
        self.assertEqual({item["day"] for item in teacher_lessons}, {2})
        self.assertEqual({item["session"] for item in teacher_lessons}, {"AM"})
        self.assertTrue(
            any(
                item["day"] == 2
                and item["session"] == "AM"
                and item["period"] == 1
                and item.get("className") == "6/1"
                for item in teacher_lessons
            )
        )
        self.assertFalse(attempts[0]["period_feasibility_bridge_required"])
        self.assertFalse(attempts[0]["period_feasibility_all_sessions"])
        self.assertFalse(attempts[0]["safe_period_feasibility_first"])

    def test_constraint_change_feasibility_places_unavoidable_single_period_teacher(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {
                "teacher": {
                    "T1": {"maxDaysSessions": {"maxDays": 4}},
                }
            },
        }
        ctx = build_school_data_from_ui(data)

        result, metrics, attempts, termination = (
            _solve_unified_first_click_feasibility_then_quality(
                data,
                {
                    "target_teacher_sessions": 1,
                    "optimization_accept_teacher_sessions": 1,
                    "optimization_first_click_feasibility_time_limit_seconds": 10,
                    "optimization_first_click_local_lns_time_limit_seconds": 0,
                    "ui_constraint_change_fresh_retry": True,
                    "max_one_period_sessions": 0,
                    "strict_one_period_sessions_cap": True,
                    "enforce_max_one_period_sessions": True,
                    "period_max_teacher_gap": 1,
                    "num_workers": 1,
                },
                bound_ctx=ctx,
                bounds={
                    "lower_cap": 1,
                    "start_cap": 1,
                    "upper_cap": 1,
                    "expected_periods": 1,
                },
                profile={"expected": 1, "class_count": 1},
                rules=ctx.rules,
                progress=None,
                deadline=SolverDeadline(20),
                polish_seeds=[1],
                requested_random_seed=1,
            )
        )

        self.assertTrue(metrics["hard_ok"], json.dumps(result, ensure_ascii=False))
        self.assertEqual(metrics["scheduled_periods"], 1)
        self.assertEqual(metrics["expected_periods"], 1)
        self.assertEqual(metrics["unassigned_periods"], 0)
        self.assertEqual(metrics["one_period_teacher_sessions"], 1)
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertFalse(
            any(
                item.get("attempt_key") == "fresh:phase_f:quality_debt_fallback"
                for item in attempts
            )
        )
        self.assertTrue(attempts[0]["safe_period_feasibility_first"])
        self.assertTrue(attempts[0]["quality_debt_allowed"])
        self.assertTrue(attempts[0]["accepted"])

    def test_fresh_feasibility_keeps_unavoidable_singleton_and_gap_two(self) -> None:
        def fixed_off_except(allowed: set[tuple[int, str, int]]) -> dict[str, bool]:
            blocked: dict[str, bool] = {}
            for day in range(2, 8):
                for part, count in (("sang", 5), ("chieu", 4)):
                    session = "AM" if part == "sang" else "PM"
                    for index in range(count):
                        if (day, session, index + 1) not in allowed:
                            blocked[f"thu{day}|{part}|{index}"] = True
            return blocked

        data = {
            "lop": [
                {"id": "L1", "ten": "6/1", "khoi": "6"},
                {"id": "L2", "ten": "6/2", "khoi": "6"},
                {"id": "L3", "ten": "6/3", "khoi": "6"},
            ],
            "giaovien": [
                {"magv": "T1", "ten": "T1"},
                {"magv": "T2", "ten": "T2"},
            ],
            "monhoc": [
                {"ten": "Math", "ma": "M"},
                {"ten": "Art", "ma": "A"},
            ],
            "mon": [
                {"khoi": "6", "ten": "Math", "sotiet": 1, "gioihan": 1},
                {"khoi": "6", "ten": "Art", "sotiet": 1, "gioihan": 1},
            ],
            "pccmMatrix": {
                "L1|Math": "T1",
                "L2|Math": "T1",
                "L3|Art": "T2",
            },
            "pccmTietMatrix": {
                "L1|Math": 1,
                "L2|Math": 1,
                "L3|Art": 1,
            },
            "tkb": {
                "L1": {
                    "thu2": {
                        "sang": [
                            {"mon": "Math", "fixed": True},
                            "",
                            "",
                            "",
                            "",
                        ]
                    }
                },
                "L2": {
                    "thu2": {
                        "sang": [
                            "",
                            "",
                            "",
                            {"mon": "Math", "fixed": True},
                            "",
                        ]
                    }
                },
            },
            "tkbConstraints": {
                "fixedOff": {
                    "class": {
                        "L1": fixed_off_except({(2, "AM", 1)}),
                        "L2": fixed_off_except({(2, "AM", 4)}),
                        "L3": fixed_off_except({(3, "AM", 1)}),
                    }
                }
            },
        }
        ctx = build_school_data_from_ui(data)

        result, metrics, attempts, termination = (
            _solve_unified_first_click_feasibility_then_quality(
                data,
                {
                    "target_teacher_sessions": 2,
                    "optimization_accept_teacher_sessions": 2,
                    "optimization_first_click_feasibility_time_limit_seconds": 30,
                    "optimization_first_click_local_lns_time_limit_seconds": 0,
                    "overall_time_limit_seconds": 30,
                    "ui_bounded_fresh_accept_quality_debt": True,
                    "ui_stop_after_first_complete_schedule": True,
                    "max_one_period_sessions": 0,
                    "strict_one_period_sessions_cap": True,
                    "enforce_max_one_period_sessions": True,
                    "period_max_teacher_gap": 1,
                    "num_workers": 1,
                },
                bound_ctx=ctx,
                bounds={
                    "lower_cap": 2,
                    "start_cap": 2,
                    "upper_cap": 3,
                    "expected_periods": 3,
                },
                profile={"expected": 3, "class_count": 3},
                rules=ctx.rules,
                progress=None,
                deadline=SolverDeadline(30),
                polish_seeds=[1],
                requested_random_seed=1,
            )
        )

        self.assertTrue(metrics["hard_ok"], json.dumps(result, ensure_ascii=False))
        self.assertEqual(metrics["scheduled_periods"], 3)
        self.assertEqual(metrics["expected_periods"], 3)
        self.assertEqual(metrics["unassigned_periods"], 0)
        self.assertGreater(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(int(metrics["gap_distribution"].get(2, 0)), 1)
        self.assertEqual(termination, "first_click_feasibility_retained")
        self.assertFalse(
            any(
                item.get("attempt_key") == "fresh:phase_f:quality_debt_fallback"
                for item in attempts
            )
        )
        self.assertTrue(attempts[0]["safe_period_feasibility_first"])
        self.assertTrue(attempts[0]["quality_debt_allowed"])
        self.assertTrue(attempts[0]["accepted"])

    def test_constraint_change_local_polish_keeps_partial_quality_improvement(self) -> None:
        feasibility = _first_click_payload(
            teacher_sessions=520,
            gap1=84,
            one_period_sessions=2,
        )
        feasibility["metrics"]["gap_distribution"] = {"0": 517, "2": 1}
        polished = _first_click_payload(
            teacher_sessions=519,
            gap1=82,
            one_period_sessions=1,
        )
        polished["metrics"]["gap_distribution"] = {"0": 518, "1": 1}
        settings = {
            "target_teacher_sessions": 482,
            "optimization_accept_teacher_sessions": 482,
            "optimization_first_click_local_lns_time_limit_seconds": 5,
            "ui_constraint_change_fresh_retry": True,
            "num_workers": 6,
        }

        with (
            patch(
                "tkb_new.adapter._solve_teacher_session_benders_candidate",
                return_value=feasibility,
            ),
            patch(
                "tkb_new.adapter._polish_complete_incumbent_with_local_lns",
                return_value=(polished, [{"improved": True}]),
            ) as local_lns,
        ):
            result, metrics, attempts, termination = (
                _solve_unified_first_click_feasibility_then_quality(
                    {},
                    settings,
                    bound_ctx=_context(),
                    bounds={
                        "lower_cap": 450,
                        "start_cap": 466,
                        "upper_cap": 650,
                        "expected_periods": 1566,
                    },
                    profile={"expected": 1566, "class_count": 54},
                    rules=None,
                    progress=None,
                    deadline=SolverDeadline(24),
                    polish_seeds=[1],
                    requested_random_seed=1,
                )
            )

        local_lns.assert_called_once()
        self.assertIs(result, polished)
        self.assertIs(metrics, polished["metrics"])
        self.assertEqual(termination, "first_click_local_lns_improved")
        self.assertTrue(attempts[-1]["improved"])
        self.assertFalse(attempts[-1]["incumbent_retained"])

    def test_tight_gap_fast_incumbent_is_complete_first_and_seeds_gap_portfolio(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        solve_settings: list[dict[str, object]] = []

        def fake_inner_solve(_data, settings, **_kwargs):
            solve_settings.append(dict(settings))
            return json.loads(json.dumps(incumbent))

        def fake_feasibility_solve(_data, settings, **_kwargs):
            solve_settings.append(dict(settings))
            return json.loads(json.dumps(incumbent))

        tight_profile = {
            "expected": 1000,
            "available_slots": 1000,
            "fixed_slots": 1000,
            "slack": 0,
        }
        with (
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=tight_profile),
            patch(
                "tkb_new.adapter._solve_fast_tight_fixed_off_benders",
                side_effect=fake_feasibility_solve,
            ),
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=fake_inner_solve),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 3,
                    "optimization_accept_gap1_sessions": 2,
                    "optimization_time_limit_seconds": 60,
                    "optimization_adaptive_time_limit_seconds": 60,
                    "optimization_adaptive_stagnant_attempts": 3,
                    "optimization_use_benders": False,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(payload["metrics"]["scheduled_periods"], 4)
        self.assertTrue(solve_settings[0]["fast_quality_warmup_direct"])
        self.assertFalse(solve_settings[0]["fast_benders_require_zero_one_period_sessions"])
        self.assertEqual(solve_settings[0]["fast_benders_relaxed_reserve_seconds"], 30)
        self.assertEqual(solve_settings[0]["ui_solver_preset"], "fast")
        self.assertFalse(solve_settings[0]["optimization_continue_quality_search"])
        self.assertEqual(solve_settings[0]["fast_local_quality_polish_time_limit_seconds"], 0)
        self.assertEqual(
            [int(settings["max_teacher_sessions"]) for settings in solve_settings[1:]],
            [3, 3, 4],
        )
        self.assertTrue(all("random_seed" in settings for settings in solve_settings[1:]))

    def test_tight_gap_target_cap_keeps_polishing_after_reaching_accept_quality(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        target_candidate = json.loads(json.dumps(incumbent))
        target_candidate["metrics"]["teacher_sessions"] = 2
        target_candidate["metrics"]["gap_distribution"] = {"0": 1, "1": 1}
        solve_settings: list[dict[str, object]] = []
        def fake_inner_solve(_data, settings, **_kwargs):
            solve_settings.append(dict(settings))
            return json.loads(json.dumps(target_candidate))

        def fake_feasibility_solve(_data, settings, **_kwargs):
            solve_settings.append(dict(settings))
            return json.loads(json.dumps(incumbent))

        tight_profile = {
            "expected": 1000,
            "available_slots": 1000,
            "fixed_slots": 1000,
            "slack": 0,
        }
        with (
            patch("tkb_new.adapter._fast_benders_tight_fixed_off_profile", return_value=tight_profile),
            patch(
                "tkb_new.adapter._solve_fast_tight_fixed_off_benders",
                side_effect=fake_feasibility_solve,
            ),
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=fake_inner_solve),
        ):
            payload = _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 2,
                    "optimization_accept_gap1_sessions": 1,
                    "optimization_time_limit_seconds": 60,
                    "optimization_adaptive_time_limit_seconds": 60,
                    "optimization_use_benders": False,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertEqual(len(solve_settings), 5)
        self.assertEqual(
            [int(settings["max_teacher_sessions"]) for settings in solve_settings[1:]],
            [3, 2, 2, 3],
        )
        self.assertEqual(solve_settings[1]["max_teacher_sessions"], 3)
        self.assertEqual(solve_settings[2]["max_teacher_sessions"], 2)
        self.assertEqual(optimization["termination_reason"], "accept_fallback_after_stagnation")
        self.assertTrue(optimization["good_enough_met"])

    def test_gap_priority_attempts_use_same_then_relaxed_cap(self) -> None:
        attempts = _teacher_session_opt_gap_priority_attempts(
            {
                "teacher_sessions": 190,
                "gap_distribution": {0: 172, 1: 18},
            },
            target_gap1_sessions=0,
            lower_cap=144,
            upper_cap=504,
            polish_seeds=[11, 22, 33, 44],
        )

        self.assertEqual(
            attempts,
            [
                (190, 11, "seed:11"),
                (190, 22, "seed:22"),
                (191, 33, "seed:33"),
            ],
        )
        self.assertEqual(
            _teacher_session_opt_gap_priority_attempts(
                {"teacher_sessions": 190, "gap_distribution": {0: 190}},
                target_gap1_sessions=0,
                lower_cap=144,
                upper_cap=504,
                polish_seeds=[11, 22, 33],
            ),
            [],
        )

    def test_gap_priority_attempts_take_a_bounded_step_when_incumbent_is_rough(self) -> None:
        attempts = _teacher_session_opt_gap_priority_attempts(
            {
                "teacher_sessions": 513,
                "gap_distribution": {0: 437, 1: 76},
            },
            target_gap1_sessions=0,
            preferred_cap=482,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
        )

        self.assertEqual(
            attempts,
            [
                (513, 11, "seed:11"),
                (503, 22, "tighten:22"),
                (513, 33, "seed:33"),
                (514, 44, "seed:44"),
            ],
        )

        near_attempts = _teacher_session_opt_gap_priority_attempts(
            {
                "teacher_sessions": 489,
                "gap_distribution": {0: 442, 1: 47},
            },
            target_gap1_sessions=0,
            preferred_cap=482,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
        )
        self.assertEqual(near_attempts[1], (484, 22, "tighten:22"))

        very_rough_attempts = _teacher_session_opt_gap_priority_attempts(
            {
                "teacher_sessions": 521,
                "gap_distribution": {0: 404, 1: 117},
            },
            target_gap1_sessions=0,
            preferred_cap=482,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
        )
        self.assertEqual(very_rough_attempts[1], (501, 22, "tighten:22"))

    def test_refinement_prioritizes_teacher_cap_after_gap_is_practical(self) -> None:
        compact = _refinement_gap_priority_attempts(
            {"teacher_sessions": 482, "gap_distribution": {0: 441, 1: 41}},
            target_gap1_sessions=0,
            preferred_cap=466,
            accept_gap1_sessions=53,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
            session_first=True,
        )
        rough = _refinement_gap_priority_attempts(
            {"teacher_sessions": 521, "gap_distribution": {0: 408, 1: 113}},
            target_gap1_sessions=0,
            preferred_cap=466,
            accept_gap1_sessions=53,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
            session_first=True,
        )
        at_practical_target = _refinement_gap_priority_attempts(
            {"teacher_sessions": 466, "gap_distribution": {0: 422, 1: 44}},
            target_gap1_sessions=0,
            preferred_cap=466,
            accept_gap1_sessions=53,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
            session_first=True,
        )

        self.assertEqual(compact[0], (466, 11, "target:11"))
        self.assertEqual(rough[0], (521, 11, "seed:11"))
        self.assertEqual(
            at_practical_target,
            [
                (466, 11, "seed:11"),
                (463, 22, "tighten:22"),
                (465, 33, "nearby:33"),
                (462, 44, "tighten:44"),
            ],
        )

        forced_after_gap_progress = _refinement_gap_priority_attempts(
            {"teacher_sessions": 521, "gap_distribution": {0: 431, 1: 90}},
            target_gap1_sessions=0,
            preferred_cap=466,
            accept_gap1_sessions=53,
            lower_cap=346,
            upper_cap=1116,
            polish_seeds=[11, 22, 33, 44],
            session_first=True,
            force_lower_session_first=True,
        )
        self.assertEqual(forced_after_gap_progress[0], (501, 22, "tighten:22"))

    def test_gap_portfolio_precedes_session_squeezing_while_gap_target_is_unmet(self) -> None:
        self.assertTrue(
            _teacher_session_opt_should_prioritize_gap_portfolio(
                {"teacher_sessions": 483, "gap_distribution": {"0": 422, "1": 61}},
                target_gap1_sessions=0,
            )
        )
        self.assertTrue(
            _teacher_session_opt_should_prioritize_gap_portfolio(
                {"teacher_sessions": 476, "gap_distribution": {"0": 429, "1": 47}},
                target_gap1_sessions=0,
            )
        )
        self.assertFalse(
            _teacher_session_opt_should_prioritize_gap_portfolio(
                {"teacher_sessions": 476, "gap_distribution": {"0": 476}},
                target_gap1_sessions=0,
            )
        )

    def test_tight_gap_target_starts_at_known_acceptable_cap(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        incumbent = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 4,
                "expected_periods": 4,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 3,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1, 1: 2},
            },
            "validation": {"hard_ok": True},
            "solver": {},
            "lessons": [],
        }
        attempted_caps: list[int] = []

        def fake_inner_solve(_data, settings, **_kwargs):
            attempted_caps.append(int(settings["max_teacher_sessions"]))
            return json.loads(json.dumps(incumbent))

        with patch(
            "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
            return_value={"expected": 4, "slack": 0},
        ), patch("tkb_new.adapter.solve_from_ui_data", side_effect=fake_inner_solve):
            _solve_teacher_session_optimized_from_ui_data(
                data,
                {
                    "auto_sort_mode": "teacher_session_opt",
                    "target_gap1_sessions": 0,
                    "optimization_accept_teacher_sessions": 3,
                    "optimization_accept_gap1_sessions": 2,
                    "optimization_time_limit_seconds": 60,
                    "optimization_adaptive_time_limit_seconds": 60,
                    "optimization_adaptive_stagnant_attempts": 3,
                    "optimization_use_benders": False,
                    "num_workers": 1,
                },
                rules=None,
                progress=None,
                out_dir=None,
            )

        self.assertEqual(attempted_caps, [3, 3, 3, 4])

    def test_gap_quality_cut_targets_the_affected_teacher_session(self) -> None:
        data = SchoolData(
            classes=[ClassInfo(name="6/1", grade="6")],
            assignments=[
                Assignment(
                    class_name="6/1",
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
        allocations = [
            SessionAllocation(
                class_name="6/1",
                grade="6",
                subject="Math",
                teacher="T1",
                session=Session(day=2, part="AM"),
                count=2,
            )
        ]

        cuts = _new_cuts_for_period_metrics(
            data,
            allocations,
            {
                "gap_sessions": [
                    {"teacher": "T1", "day": 2, "session": "AM", "gap": 1}
                ]
            },
            cut_scope="teacher",
        )

        self.assertEqual(cuts, [(0, {0: 2})])

    def test_adaptive_max_reports_lower_bound_optimality_metrics(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        payload = solve_from_ui_data(
            data,
            {
                "auto_sort_mode": "teacher_session_opt",
                "optimization_time_limit_seconds": 300,
                "overall_time_limit_seconds": 300,
                "optimization_first_cap_time_limit_seconds": 300,
                "optimization_session_time_limit": 18,
                "period_time_limit": 10,
                "optimization_period_retry_time_limit": 5,
                "num_workers": 1,
                "max_one_period_sessions": 0,
                "minimize_one_period_sessions": True,
                "one_period_priority_absolute": True,
            },
        )

        metrics = payload["metrics"]
        optimization = payload["solver"]["teacher_session_optimization"]
        runtime = payload["solver"]["runtime_settings"]
        self.assertEqual(metrics["teacher_session_lower_bound"], 1)
        self.assertEqual(metrics["teacher_session_excess"], 0)
        self.assertTrue(metrics["teacher_session_optimal"])
        self.assertEqual(metrics["teacher_session_termination_reason"], "lower_bound_reached")
        self.assertTrue(optimization["adaptive"])
        self.assertEqual(optimization["time_limit_seconds"], 120)
        self.assertLessEqual(runtime["overall_time_limit_seconds"], 45)
        self.assertLessEqual(optimization["first_cap_time_limit_seconds"], 35)
        self.assertLessEqual(optimization["retry_cap_time_limit_seconds"], 25)
        self.assertLessEqual(optimization["polish_cap_time_limit_seconds"], 20)
        self.assertEqual(optimization["target_teacher_sessions"], 1)
        self.assertEqual(optimization["lower_bound"], 1)
        self.assertEqual(optimization["excess"], 0)
        self.assertTrue(optimization["optimal"])
        self.assertEqual(optimization["termination_reason"], "lower_bound_reached")

    def test_explicit_max_target_keeps_requested_budget(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 4, "gioihan": 4}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        payload = solve_from_ui_data(
            data,
            {
                "auto_sort_mode": "teacher_session_opt",
                "target_teacher_sessions": 1,
                "optimization_time_limit_seconds": 300,
                "overall_time_limit_seconds": 300,
                "num_workers": 1,
                "max_one_period_sessions": 0,
            },
        )

        optimization = payload["solver"]["teacher_session_optimization"]
        self.assertFalse(optimization["adaptive"])
        self.assertEqual(optimization["time_limit_seconds"], 300)

    def test_fixture_resolves_current_workspace_data_layout(self) -> None:
        fixture = build_ui_fixture_from_workbooks(
            RUNTIME_ROOT / "web",
            include_fixed_off_excel=True,
        )

        self.assertEqual(len(fixture["lop"]), 22)
        self.assertEqual(len(fixture["giaovien"]), 43)
        self.assertEqual(len(fixture["monhoc"]), 20)
        self.assertEqual(len(fixture["mon"]), 80)
        self.assertEqual(len(fixture["pccmMatrix"]), 364)
        self.assertTrue(all(item.get("khoi") for item in fixture["lop"]))
        self.assertEqual(fixture["sampleMeta"]["fixedOffClassCount"], 22)
        self.assertEqual(fixture["sampleMeta"]["fixedOffSlotCount"], 693)
        context = build_school_data_from_ui(fixture)
        self.assertEqual(len(context.school_data.assignments), 364)
        self.assertEqual(
            sum(item.periods_per_week for item in context.school_data.assignments),
            627,
        )

    def test_fast_direct_profile_promotes_to_bounded_quality_warmup(self) -> None:
        fixture = build_ui_fixture_from_workbooks(
            RUNTIME_ROOT / "web",
            include_fixed_off_excel=True,
        )
        promoted, bounds = _fast_quality_warmup_direct_settings(
            fixture,
            {
                "auto_sort_mode": "fast",
                "ui_solver_preset": "fast",
                "overall_time_limit_seconds": 105,
                "integrated_time_limit": 105,
                "session_time_limit": 18,
                "period_time_limit": 22,
                "target_teacher_sessions": 203,
                "optimization_accept_teacher_sessions": 203,
                "session_early_stop_enabled": False,
            },
        )

        self.assertEqual(bounds["expected_periods"], 627)
        self.assertTrue(promoted["_teacher_session_opt_inner"])
        self.assertTrue(promoted["_teacher_session_opt_fast_quality_warmup"])
        self.assertTrue(promoted["session_early_stop_enabled"])
        self.assertEqual(promoted["max_teacher_sessions"], 203)
        self.assertEqual(promoted["session_early_stop_teacher_sessions"], 203)
        self.assertEqual(promoted["max_one_period_sessions"], 0)
        self.assertLessEqual(promoted["overall_time_limit_seconds"], 105)

    def test_relaxed_teacher_session_cap_always_moves_forward(self) -> None:
        self.assertEqual(_relaxed_teacher_session_cap(190, 627), 260)
        self.assertEqual(_relaxed_teacher_session_cap(466, 1566), 627)
        self.assertGreater(_relaxed_teacher_session_cap(482, 1566), 482)

    def test_large_fast_profile_uses_speed_cap_but_stops_at_target(self) -> None:
        promoted = _teacher_session_opt_fast_quality_settings(
            {
                "fast_quality_teacher_cap": 514,
                "target_teacher_sessions": 482,
                "optimization_accept_teacher_sessions": 482,
                "session_early_stop_teacher_sessions": 482,
                "session_time_limit": 18,
                "period_time_limit": 22,
                "overall_time_limit_seconds": 210,
                "optimization_time_limit_seconds": 210,
            },
            {
                "lower_cap": 450,
                "start_cap": 466,
                "upper_cap": 650,
                "expected_periods": 1566,
            },
        )

        self.assertEqual(promoted["max_teacher_sessions"], 514)
        self.assertEqual(promoted["session_early_stop_teacher_sessions"], 482)

    def test_fast_benders_profile_requires_large_tight_all_class_fixed_off(self) -> None:
        classes = [
            {"id": f"L{index:02d}", "ten": f"6/{index + 1}", "khoi": "6"}
            for index in range(20)
        ]
        off_slots = {
            f"thu{day}|sang|{period}": True
            for day in range(2, 5)
            for period in range(5)
        }
        data = {
            "lop": classes,
            "giaovien": [
                {"magv": f"T{index:02d}", "ten": f"T{index:02d}"}
                for index in range(20)
            ],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 45, "gioihan": 5}],
            "pccmMatrix": {
                f"L{index:02d}|Math": f"T{index:02d}"
                for index in range(20)
            },
            "tkbConstraints": {
                "fixedOff": {
                    "class": {
                        f"L{index:02d}": dict(off_slots)
                        for index in range(20)
                    }
                }
            },
        }

        profile = _fast_benders_tight_fixed_off_profile(
            data,
            {
                "tight_class_fixed_off_profile": {
                    "expected": 900,
                    "availableSlots": 900,
                    "slack": 0,
                }
            },
            bounds={"expected_periods": 900},
        )

        self.assertIsNotNone(profile)
        self.assertEqual(profile["slack"], 0)
        self.assertEqual(profile["fixed_slots"], 300)
        self.assertEqual(profile["supplied_profile_matches"], 1)
        self.assertIsNone(
            _fast_benders_tight_fixed_off_profile(
                data,
                {},
                bounds={"expected_periods": 899},
            )
        )

    def test_fast_benders_lane_relaxes_cap_and_marks_complete_first_metadata(self) -> None:
        first_error = RuntimeError(
            "Benders teacher-session cap search failed: "
            + json.dumps(
                {
                    "cap": 514,
                    "cuts": 2,
                    "history": [
                        {"iteration": 1, "status": "period_failed_added_cuts"},
                        {"iteration": 2, "status": "session_no_solution"},
                    ],
                }
            )
        )
        payload = {
            "ok": True,
            "metrics": {
                "scheduled_periods": 1566,
                "expected_periods": 1566,
                "teacher_sessions": 520,
                "one_period_teacher_sessions": 4,
            },
            "solver": {
                "session_solver": {},
                "runtime_settings": {},
                "teacher_session_benders": {"iterations": 3, "cuts": 2},
            },
        }
        settings = {
            "auto_sort_mode": "fast",
            "fast_quality_teacher_cap": 514,
            "target_teacher_sessions": 482,
            "target_gap1_sessions": 53,
            "optimization_accept_teacher_sessions": 482,
            "overall_time_limit_seconds": 180,
            "fast_benders_time_limit_seconds": 115,
            "period_time_limit": 22,
            "num_workers": 2,
        }
        bounds = {
            "lower_cap": 450,
            "start_cap": 466,
            "upper_cap": 650,
            "expected_periods": 1566,
        }
        profile = {
            "expected": 1566,
            "class_count": 54,
            "fixed_slots": 1674,
            "available_slots": 1566,
            "slack": 0,
        }

        with patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate",
            side_effect=[first_error, payload],
        ) as solve_candidate:
            result = _solve_fast_tight_fixed_off_benders(
                {},
                settings,
                bounds=bounds,
                profile=profile,
                rules=None,
                progress=None,
            )

        self.assertEqual(solve_candidate.call_count, 2)
        self.assertEqual(solve_candidate.call_args_list[0].kwargs["cap"], 514)
        self.assertEqual(solve_candidate.call_args_list[1].kwargs["cap"], 627)
        first_settings = solve_candidate.call_args_list[0].args[1]
        self.assertNotIn("target_teacher_sessions", first_settings)
        self.assertNotIn("target_gap1_sessions", first_settings)
        self.assertEqual(first_settings["max_one_period_sessions"], "off")
        self.assertTrue(first_settings["optimization_benders_complete_first"])
        self.assertTrue(first_settings["optimization_benders_skip_relaxed_period_probe"])
        self.assertLessEqual(first_settings["period_time_limit"], 18)
        fast_meta = result["solver"]["fast_benders_feasibility"]
        self.assertEqual(result["solver"]["fast_profile"], "tight_fixed_off_benders_complete_first")
        self.assertEqual(fast_meta["selected_cap"], 627)
        self.assertEqual(fast_meta["iterations"], 3)
        self.assertEqual(fast_meta["cuts"], 2)
        self.assertEqual(len(fast_meta["attempts"]), 2)
        self.assertEqual(result["metrics"]["auto_sort_mode"], "fast")

    def test_fast_preset_tries_generic_lane_before_benders(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        payload = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 1,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {"runtime_settings": {}},
            "lessons": [],
        }
        settings = {
            "auto_sort_mode": "fast",
            "ui_solver_preset": "fast",
            "target_teacher_sessions": 1,
            "fast_quality_teacher_cap": 2,
            "optimization_continue_quality_search": True,
            "fast_local_quality_polish_time_limit_seconds": 0,
            "fast_anytime_polish_time_limit_seconds": 12,
            "overall_time_limit_seconds": 60,
            "period_time_limit": 20,
            "num_workers": 1,
        }
        bounds = {
            "lower_cap": 1,
            "start_cap": 1,
            "upper_cap": 12,
            "expected_periods": 2,
        }
        profile = {
            "expected": 900,
            "class_count": 1,
            "fixed_slots": 2,
            "available_slots": 2,
            "slack": 0,
        }

        with patch("tkb_new.adapter.solve_from_ui_data", return_value=payload) as generic_solve, patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate", return_value=payload
        ) as benders_solve:
            result = _solve_fast_tight_fixed_off_benders(
                data,
                settings,
                bounds=bounds,
                profile=profile,
                rules=None,
                progress=None,
            )

        self.assertEqual(generic_solve.call_count, 1)
        self.assertEqual(benders_solve.call_count, 1)
        generic_settings = generic_solve.call_args.args[1]
        self.assertEqual(generic_settings["auto_sort_strategy"], "fresh_fast_quality_generic_first")
        self.assertEqual(generic_settings["overall_time_limit_seconds"], 52)
        self.assertFalse(generic_settings["fast_quality_warmup_direct"])
        self.assertTrue(generic_settings["session_early_stop_enabled"])
        self.assertEqual(generic_settings["session_early_stop_teacher_sessions"], 6)
        self.assertIsNone(generic_settings["session_early_stop_max_one_period_sessions"])
        self.assertEqual(generic_settings["max_one_period_sessions"], "off")
        self.assertFalse(generic_settings["strict_one_period_sessions_cap"])
        self.assertTrue(generic_settings["allow_quality_debt"])
        polish_settings = benders_solve.call_args.args[1]
        self.assertTrue(polish_settings["optimization_continue_quality_search"])
        self.assertTrue(polish_settings["optimization_benders_disable_session_early_stop"])
        self.assertEqual(polish_settings["optimization_benders_iterations"], 2)
        self.assertEqual(result["solver"]["fast_profile"], "quality_warmup_direct_generic_first")
        self.assertTrue(result["solver"]["fast_benders_feasibility"]["generic_first"])
        self.assertTrue(result["solver"]["fast_benders_feasibility"]["complete_first_then_polish"])

    def test_nested_solver_deadline_keeps_the_earliest_absolute_end(self) -> None:
        now = [100.0]
        with patch("tkb_new.adapter.time.monotonic", side_effect=lambda: now[0]):
            root = SolverDeadline(55)
            now[0] = 120.0
            child = root.bounded(45)

            self.assertEqual(root.ends_at, 155.0)
            self.assertEqual(child.ends_at, 155.0)
            self.assertEqual(child.remaining(), 35.0)

    def test_fast_nested_solver_reuses_the_absolute_deadline(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        payload = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 1,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {"runtime_settings": {}},
            "lessons": [],
        }
        seen_deadlines: list[SolverDeadline | None] = []

        def fake_nested_solve(_data, _settings, **kwargs):
            seen_deadlines.append(kwargs.get("_deadline"))
            return json.loads(json.dumps(payload))

        now = [100.0]
        with (
            patch("tkb_new.adapter.time.monotonic", side_effect=lambda: now[0]),
            patch("tkb_new.adapter.solve_from_ui_data", side_effect=fake_nested_solve),
            patch("tkb_new.adapter._solve_teacher_session_benders_candidate") as benders_solve,
        ):
            root = SolverDeadline(55)
            result = _solve_fast_tight_fixed_off_benders(
                data,
                {
                    "auto_sort_mode": "fast",
                    "ui_solver_preset": "fast",
                    "overall_time_limit_seconds": 55,
                    "optimization_time_limit_seconds": 55,
                    "fast_quality_teacher_cap": 2,
                    "num_workers": 1,
                },
                bounds={"lower_cap": 1, "start_cap": 1, "upper_cap": 12, "expected_periods": 2},
                profile={"expected": 900, "class_count": 1, "fixed_slots": 2, "available_slots": 2, "slack": 0},
                rules=None,
                progress=None,
                deadline=root,
            )

        self.assertEqual(result["metrics"]["scheduled_periods"], 2)
        self.assertEqual(len(seen_deadlines), 1)
        self.assertIsNotNone(seen_deadlines[0])
        self.assertEqual(seen_deadlines[0].ends_at, root.ends_at)
        self.assertFalse(benders_solve.called)

    def test_fast_preset_retries_generic_lane_with_relaxed_cap(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        payload = {
            "ok": True,
            "metrics": {
                "hard_ok": True,
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "teacher_sessions": 1,
                "one_period_teacher_sessions": 0,
                "gap_distribution": {0: 1},
            },
            "validation": {"hard_ok": True},
            "solver": {"runtime_settings": {}},
            "lessons": [],
        }
        settings = {
            "auto_sort_mode": "fast",
            "ui_solver_preset": "fast",
            "fast_quality_teacher_cap": 2,
            "optimization_continue_quality_search": True,
            "overall_time_limit_seconds": 60,
            "period_time_limit": 20,
            "random_seed": 7,
            "num_workers": 1,
        }
        bounds = {
            "lower_cap": 1,
            "start_cap": 2,
            "upper_cap": 12,
            "expected_periods": 2,
        }
        profile = {
            "expected": 900,
            "class_count": 1,
            "fixed_slots": 2,
            "available_slots": 2,
            "slack": 0,
        }

        with patch(
            "tkb_new.adapter.solve_from_ui_data",
            side_effect=[RuntimeError("first period vector failed"), payload],
        ) as generic_solve, patch(
            "tkb_new.adapter._solve_teacher_session_benders_candidate"
        ) as benders_solve:
            result = _solve_fast_tight_fixed_off_benders(
                data,
                settings,
                bounds=bounds,
                profile=profile,
                rules=None,
                progress=None,
            )

        self.assertEqual(generic_solve.call_count, 2)
        retry_settings = generic_solve.call_args_list[1].args[1]
        self.assertEqual(retry_settings["auto_sort_strategy"], "fresh_fast_quality_generic_retry")
        self.assertEqual(retry_settings["max_teacher_sessions"], 2)
        self.assertEqual(retry_settings["max_one_period_sessions"], "off")
        self.assertFalse(retry_settings["strict_one_period_sessions_cap"])
        self.assertNotEqual(retry_settings["random_seed"], settings["random_seed"])
        self.assertFalse(benders_solve.called)
        self.assertEqual(result["solver"]["fast_profile"], "quality_warmup_generic_retry")
        self.assertTrue(result["solver"]["fast_benders_feasibility"]["generic_retry"])

    def test_fast_benders_exhaustion_uses_generic_fallback(self) -> None:
        data = {
            "lop": [{"id": "L1", "ten": "6/1", "khoi": "6"}],
            "giaovien": [{"magv": "T1", "ten": "T1"}],
            "monhoc": [{"ten": "Math", "ma": "M"}],
            "mon": [{"khoi": "6", "ten": "Math", "sotiet": 2, "gioihan": 2}],
            "pccmMatrix": {"L1|Math": "T1"},
            "tkbConstraints": {},
        }
        failure = RuntimeError("bounded fast benders exhausted")
        failure.fast_benders_detail = {  # type: ignore[attr-defined]
            "initial_cap": 2,
            "relaxed_cap": 260,
            "time_limit_seconds": 20,
            "attempts": [{"phase": "speed_cap", "ok": False}],
        }

        with patch(
            "tkb_new.adapter._fast_benders_tight_fixed_off_profile",
            return_value={"expected": 2, "slack": 0},
        ), patch(
            "tkb_new.adapter._solve_fast_tight_fixed_off_benders",
            side_effect=failure,
        ):
            result = solve_from_ui_data(
                data,
                {
                    "auto_sort_mode": "fast",
                    "ui_solver_preset": "fast",
                    "fast_quality_warmup_direct": True,
                    "fast_quality_teacher_cap": 2,
                    "target_teacher_sessions": 2,
                    "overall_time_limit_seconds": 30,
                    "optimization_time_limit_seconds": 30,
                    "session_time_limit": 8,
                    "period_time_limit": 8,
                    "num_workers": 1,
                },
            )

        self.assertEqual(result["metrics"]["scheduled_periods"], 2)
        self.assertEqual(result["metrics"]["unassigned_periods"], 0)
        self.assertEqual(result["solver"]["fast_profile"], "quality_warmup_direct_after_benders")
        self.assertTrue(result["solver"]["fast_benders_feasibility"]["fallback_used"])
        self.assertTrue(any("Benders" in item for item in result["warnings"]))

    def test_solver_shortfall_is_not_hard_ok_and_requires_422(self) -> None:
        ctx = _context()
        payload = build_payload(
            ctx,
            [],
            {"validation": {}},
            unassigned_lessons=[
                {
                    "className": "6/1",
                    "subject": "Toán",
                    "teacher": "GV1",
                    "periods": 2,
                    "reason": "session_constraints_best_effort",
                }
            ],
            original_ctx=ctx,
            best_effort=True,
            deadline_exhausted=True,
        )

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["solver_unassigned_periods"], 2)
        self.assertEqual(payload["metrics"]["capacity_unassigned_periods"], 0)
        self.assertEqual(
            _finalize_solve_status(payload, {"require_complete_schedule": True}),
            422,
        )
        self.assertEqual(payload["kind"], "no_complete_schedule_before_deadline")

    def test_capacity_shortfall_remains_separate_from_solver_failure(self) -> None:
        ctx = _context()
        lesson = Lesson(
            class_name="6/1",
            grade="Khối 6",
            day=2,
            session="AM",
            period=1,
            subject="Toán",
            teacher="GV1",
        )
        payload = build_payload(
            ctx,
            [lesson],
            {"validation": {}},
            unassigned_lessons=[
                {
                    "className": "6/1",
                    "subject": "Toán",
                    "teacher": "GV1",
                    "periods": 1,
                    "reason": "not_enough_available_slots",
                }
            ],
            original_ctx=ctx,
        )

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["metrics"]["hard_ok"])
        self.assertEqual(payload["metrics"]["capacity_unassigned_periods"], 1)
        self.assertEqual(payload["metrics"]["solver_unassigned_periods"], 0)
        self.assertEqual(
            _finalize_solve_status(payload, {"require_complete_schedule": True}),
            200,
        )

    def test_zero_schedule_is_422_even_when_partial_results_are_allowed(self) -> None:
        payload = {
            "ok": True,
            "metrics": {
                "scheduled_periods": 0,
                "expected_periods": 2,
                "hard_ok": True,
                "core_hard_ok": True,
                "solver_unassigned_periods": 0,
            },
        }

        self.assertEqual(
            _finalize_solve_status(payload, {"require_complete_schedule": False}),
            422,
        )
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["metrics"]["hard_ok"])

    def test_missing_shortfall_metric_is_inferred_but_capacity_is_not(self) -> None:
        incomplete = {
            "ok": True,
            "metrics": {
                "scheduled_periods": 1,
                "expected_periods": 2,
                "hard_ok": True,
                "core_hard_ok": True,
            },
        }
        self.assertEqual(
            _finalize_solve_status(incomplete, {"require_complete_schedule": True}),
            422,
        )
        self.assertEqual(incomplete["metrics"]["solver_unassigned_periods"], 1)
        self.assertFalse(incomplete["ok"])

        capacity_only = {
            "ok": True,
            "metrics": {
                "scheduled_periods": 1,
                "expected_periods": 2,
                "capacity_unassigned_periods": 1,
                "hard_ok": True,
                "core_hard_ok": True,
            },
        }
        self.assertEqual(
            _finalize_solve_status(capacity_only, {"require_complete_schedule": True}),
            200,
        )
        self.assertTrue(capacity_only["ok"])


if __name__ == "__main__":
    unittest.main()
