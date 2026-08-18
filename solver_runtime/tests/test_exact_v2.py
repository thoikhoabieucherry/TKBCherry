from __future__ import annotations

import unittest
import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))
sys.path.insert(0, str(RUNTIME_ROOT))

from tkb_exact_v2 import ExactV2NoSolution, solve_exact_v2_from_ui_data


def _empty_constraints() -> dict:
    return {
        "fixedOff": {
            "class": {},
            "teacher": {},
            "subject": {},
            "room": {},
            "subjectGroup": {},
        },
        "groups": {},
        "teacher": {},
        "subject": {},
        "subjectGroup": {},
        "timeLimit": [],
    }


def _request(
    *,
    classes: tuple[str, ...] = ("A",),
    periods: int = 2,
    limit: int = 2,
    teacher: str = "T",
) -> dict:
    return {
        "lop": [{"id": name, "ten": name, "khoi": "6"} for name in classes],
        "monhoc": [{"id": "M", "ten": "M"}],
        "mon": [{"khoi": "6", "ten": "M", "sotiet": periods, "gioihan": limit}],
        "pccmMatrix": {f"{name}|M": teacher for name in classes},
        "pccmTietMatrix": {f"{name}|M": periods for name in classes},
        "pccmGioihanMatrix": {f"{name}|M": limit for name in classes},
        "pccmRoomMatrix": {},
        "tkb": {},
        "tkbUserOff": {},
        "tkbConstraints": _empty_constraints(),
    }


def _off_all_except(allowed: set[tuple[int, str, int]]) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for day in range(2, 8):
        for part in ("sang", "chieu"):
            for zero_period in range(5):
                if (day, part, zero_period + 1) not in allowed:
                    result[f"thu{day}|{part}|{zero_period}"] = True
    return result


class ExactV2Tests(unittest.TestCase):
    def test_complete_two_period_assignment_has_zero_singleton_and_gap2(self) -> None:
        payload = solve_exact_v2_from_ui_data(
            _request(),
            {"exact_v2_time_limit_seconds": 10, "exact_v2_workers": 2},
        )
        self.assertTrue(payload["ok"])
        metrics = payload["metrics"]
        self.assertEqual(metrics["scheduled_periods"], 2)
        self.assertEqual(metrics["teacher_sessions"], 1)
        self.assertEqual(metrics["one_period_teacher_sessions"], 0)
        self.assertEqual(metrics["gap_distribution"], {0: 1})
        self.assertEqual(payload["solver"]["certificate"]["sessions"]["status"], "OPTIMAL")
        self.assertEqual(payload["solver"]["certificate"]["gap1"]["status"], "OPTIMAL")

    def test_max_limit_is_an_upper_bound_not_a_required_exact_count(self) -> None:
        payload = solve_exact_v2_from_ui_data(
            _request(periods=4, limit=3),
            {"exact_v2_time_limit_seconds": 10, "exact_v2_workers": 2},
        )
        metrics = payload["metrics"]
        self.assertTrue(payload["ok"])
        self.assertEqual(metrics["teacher_sessions"], 2)
        self.assertEqual(metrics["app_constraint_violation_count"], 0)
        self.assertTrue(all(int(load) <= 3 for load in metrics["teacher_session_load_distribution"]))

    def test_gap1_is_minimized_after_session_optimum(self) -> None:
        request = _request(classes=("A", "B"), periods=1, limit=1)
        request["tkbConstraints"]["fixedOff"]["class"] = {
            "A": _off_all_except({(2, "sang", 1)}),
            "B": _off_all_except({(2, "sang", 3)}),
        }
        payload = solve_exact_v2_from_ui_data(
            request,
            {"exact_v2_time_limit_seconds": 10, "exact_v2_workers": 2},
        )
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["metrics"]["teacher_sessions"], 1)
        self.assertEqual(payload["metrics"]["one_period_teacher_sessions"], 0)
        self.assertEqual(payload["metrics"]["gap_distribution"], {1: 1})
        self.assertEqual(payload["solver"]["certificate"]["gap1"]["value"], 1)

    def test_single_total_period_is_rejected_instead_of_publishing_singleton(self) -> None:
        with self.assertRaises(ExactV2NoSolution) as raised:
            solve_exact_v2_from_ui_data(
                _request(periods=1, limit=1),
                {"exact_v2_time_limit_seconds": 10, "exact_v2_workers": 2},
            )
        self.assertEqual(raised.exception.detail["code"], "sessions_optimum_infeasible")

    def test_fixed_lessons_exceeding_max_are_reported_as_upper_bound_conflict(self) -> None:
        request = _request(periods=2, limit=1)
        request["tkb"] = {
            "A": {
                "thu2": {"sang": [{"mon": "M", "fixed": True}, {"mon": "M", "fixed": True}, "", "", ""]}
            }
        }
        with self.assertRaises(ExactV2NoSolution) as raised:
            solve_exact_v2_from_ui_data(
                request,
                {"exact_v2_time_limit_seconds": 10, "exact_v2_workers": 2},
            )
        self.assertEqual(raised.exception.detail["code"], "fixed_lessons_exceed_upper_bound")


if __name__ == "__main__":
    unittest.main()
