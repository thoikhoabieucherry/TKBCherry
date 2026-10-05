"""Cherry engine v3 — 05/10/2026 (THCS An Phu kkhg52etp92, chu du an: "nut Cherry
phai xep du va toi uu", "tang thoi gian chay va ke thua ket qua chay thu").

1. CP-SAT lane fill ``loc_soft``: vi pham luat DIA DIEM la bien phat (dem o
   info["loc_viol"]) de lan giai toan truong di qua luoi du tiet con no.
2. ``require_full``: vung go no giu MOI tiet dang xep — bai toan kha thi thuan,
   vung khong go duoc bi bac bo (INFEASIBLE) thay vi bo tiet.
3. Cong dia diem chon nghiem qua cong tot nhat thay vi tra lich cu
   (``_location_gate_fails``) va moc lay tu lich nguoi dung.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_engine_v3_cpsat_lns import _problem, _soft  # noqa: E402
from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.core import PERIODS, TeacherRule  # noqa: E402
from tkb_engine_v3.entry import _location_gate, _location_gate_fails  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


def _two_campus(b_sessions: list[int]):
    """Lop A (co so 0, buoi 0) va lop B (co so 1): GV0 day 1 tiet mon M0 o moi
    lop, luat 1 dia diem/buoi; mon F (khong GV) lap cho con lai."""

    assignments = [
        (0, 0, (0,), 1, 1),   # ai 0: A - M0 - GV0
        (0, 1, (), 4, 4),     # ai 1: A - F
        (1, 0, (0,), 1, 1),   # ai 2: B - M0 - GV0
        (1, 1, (), 4, 4),     # ai 3: B - F
    ]
    P = _problem(["A", "B"], ["T0"], ["M0", "F"], assignments, {0: [0], 1: list(b_sessions)})
    P.a_loc = [0, 0, 1, 1]
    P.loc_names = ["co so 0", "co so 1"]
    P.teacher_rules[0] = TeacherRule(loc_one=(True,) * 12)
    P.teacher_loc_rules[0] = True
    return P


@unittest.skipUnless(HAS_ORTOOLS, "ortools khong co")
class LocSoftFillTests(unittest.TestCase):
    def test_hard_location_leaves_lesson_unplaced(self) -> None:
        P = _two_campus([0])
        soft = _soft(P, [])
        cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1], "fill", time_limit=10.0, workers=1,
            require_improve=False, fill_quality=False,
        )
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["unplaced"], 1, info)

    def test_soft_location_places_all_and_counts_violation(self) -> None:
        P = _two_campus([0])
        soft = _soft(P, [])
        cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1], "fill", time_limit=10.0, workers=1,
            require_improve=False, fill_quality=False, loc_soft=True,
        )
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["unplaced"], 0, info)
        self.assertEqual(info["loc_viol"], 1, info)
        cpsat_lns.apply_cells(soft, cells)
        soft.refresh_rule_pen(0)
        self.assertEqual(soft.location_debt_session_count(), 1)


@unittest.skipUnless(HAS_ORTOOLS, "ortools khong co")
class RequireFullRepairTests(unittest.TestCase):
    def _violating(self, b_sessions: list[int]):
        P = _two_campus(b_sessions)
        # GV0: A tiet 1 (co so 0) + B tiet 2 (co so 1) cung buoi 0 -> vi pham
        cells = [(0, 0, 0)] + [(0, p, 1) for p in range(1, PERIODS)]
        cells += [(1, 1, 2), (1, 0, 3)] + [(1, p, 3) for p in range(2, PERIODS)]
        soft = _soft(P, cells)
        self.assertEqual(soft.location_debt_session_count(), 1)
        return P, soft

    def test_unrepairable_neighbourhood_is_infeasible_not_dropped(self) -> None:
        P, soft = self._violating([0])
        cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1], "fill", time_limit=10.0, workers=1, require_improve=False,
            fill_quality=False, sessions=[0], require_full=True,
        )
        self.assertIsNone(cells, info)
        self.assertEqual(info["status"], "INFEASIBLE", info)

    def test_repair_moves_lesson_to_other_session_keeping_all(self) -> None:
        P, soft = self._violating([0, 2])
        cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1], "fill", time_limit=10.0, workers=1, require_improve=False,
            fill_quality=False, sessions=[0, 2], require_full=True,
        )
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["unplaced"], 0, info)
        cpsat_lns.apply_cells(soft, cells)
        soft.refresh_rule_pen(0)
        self.assertEqual(soft.location_debt_session_count(), 0)
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        self.assertEqual(placed, 10)


class LocationGateSelectionTests(unittest.TestCase):
    def test_gate_fails_only_when_debt_grows_more_than_lessons_gained(self) -> None:
        # lich cu 868 tiet / 0 buoi vi pham
        self.assertTrue(_location_gate_fails({"placed": 869, "location_debt": 7}, 0, 868))
        self.assertFalse(_location_gate_fails({"placed": 869, "location_debt": 1}, 0, 868))
        self.assertFalse(_location_gate_fails({"placed": 868, "location_debt": 0}, 0, 868))
        # khong co lich nguoi dung -> khong co cong
        self.assertFalse(_location_gate_fails({"placed": 10, "location_debt": 9}, None, None))

    def test_gate_baseline_prefers_user_grid_over_intermediate_info(self) -> None:
        # vong 2 di tu luoi xep moi con 9 buoi no: info.warm_location_debt = 9
        # la moc trung gian; moc that (lich nguoi dung) = 0
        best = {
            "placed": 869,
            "location_debt": 5,
            "objective": [3, 0, 320, 20, 200],
            "grid": [[1, -1]],
            "info": {"warm_location_debt": 9, "warm_grid": [[0, -1]], "warm_placed": 868,
                     "warm_quality": [1, 0, 317, 22]},
        }
        verdict = _location_gate(best, 0, [[0, -1]], 868)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertEqual(verdict["start"], 0)
        self.assertEqual(best["grid"], [[0, -1]])


if __name__ == "__main__":
    unittest.main()
