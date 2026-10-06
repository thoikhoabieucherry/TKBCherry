"""Cherry engine v3 — 06/10/2026 (chu du an: "bam xep ko xep du tiet va toi uu,
co phai thuat toan co van de ko?", THCS An Phu kkhg52etp92).

Do tren truong thu 2 co so (28 lop, 871 tiet, so buoi "dung bang" theo lich dap
an co san):

1. Vong 1 (portfolio heuristic) tra luoi 871/871 con NO LUAT GV (vuot/thieu so
   buoi) vi `_load_state` khong kiem luat khi penalty > 0. rank() chi so tiet nen
   luoi do thang luoi 869 HOP LE cua vong CP-SAT -> payload ok=false.
   -> `rule_debt` cua moi ket qua, luoi hop le luon dung truoc.
2. Lan giai CP-SAT toan truong (vi pham dia diem phat mem) 758 -> 864 con 8 buoi
   vi pham; go khong het thi VUT ca lan giai ve 758. -> chi go tiet gay no.
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_engine_v3_cpsat_lns import _problem, _soft  # noqa: E402
from test_engine_v3_loc_fill_repair import _two_campus  # noqa: E402
from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.construct import Constructor  # noqa: E402
from tkb_engine_v3.core import PERIODS, TeacherRule  # noqa: E402
from tkb_engine_v3.entry import _grid_rule_debt, _rank_key, _result_hits_floor  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


def _grid(P, cells):
    grid = [[-1] * 60 for _ in range(P.num_classes())]
    for c, x, ai in cells:
        grid[c][x] = ai
    return grid


class GridRuleDebtTests(unittest.TestCase):
    def _one_teacher(self, max_sessions: int):
        # 1 lop, GV0 day 2 tiet mon M0; lop hoc buoi 0 va buoi 1
        return _problem(
            ["A"], ["T0"], ["M0"], [(0, 0, (0,), 2, 2)], {0: [0, 1]},
            teacher_rules={0: TeacherRule(max_sessions=max_sessions)},
        )

    def test_counts_max_sessions_excess(self) -> None:
        P = self._one_teacher(1)
        self.assertEqual(_grid_rule_debt(P, _grid(P, [(0, 0, 0), (0, PERIODS, 0)])), 1)
        self.assertEqual(_grid_rule_debt(P, _grid(P, [(0, 0, 0), (0, 1, 0)])), 0)

    def test_location_debt_is_left_to_location_gate(self) -> None:
        P = _two_campus([0])
        cells = [(0, 0, 0)] + [(0, p, 1) for p in range(1, PERIODS)]
        cells += [(1, 1, 2), (1, 0, 3)] + [(1, p, 3) for p in range(2, PERIODS)]
        soft = _soft(P, cells)
        self.assertEqual(soft.location_debt_session_count(), 1)
        self.assertEqual(_grid_rule_debt(P, _grid(P, cells)), 0)


class ValidFirstRankTests(unittest.TestCase):
    def test_valid_partial_beats_complete_with_rule_debt(self) -> None:
        invalid = {"placed": 871, "objective": [36, 8, 345, 57, 217], "rule_debt": 41}
        valid = {"placed": 869, "objective": [3, 0, 270, 1, 193], "rule_debt": 0}
        self.assertLess(_rank_key(valid, None), _rank_key(invalid, None))
        less_debt = dict(invalid, rule_debt=5, placed=860)
        self.assertLess(_rank_key(less_debt, None), _rank_key(invalid, None))

    def test_equal_debt_still_prefers_more_lessons(self) -> None:
        a = {"placed": 871, "objective": [3, 0, 270, 1, 193], "rule_debt": 0}
        b = {"placed": 869, "objective": [0, 0, 260, 0, 190], "rule_debt": 0}
        self.assertLess(_rank_key(a, None), _rank_key(b, None))

    def test_floor_needs_valid_grid(self) -> None:
        res = {"placed": 10, "objective": [0, 0, 5, 0, 3], "rule_debt": 0}
        self.assertTrue(_result_hits_floor(res, 10))
        self.assertFalse(_result_hits_floor(dict(res, rule_debt=2), 10))


@unittest.skipUnless(HAS_ORTOOLS, "ortools khong co")
class WholePassKeepsPartialTests(unittest.TestCase):
    def test_unrepairable_location_debt_sheds_only_its_lesson(self) -> None:
        # GV0 phai day A (co so 0) va B (co so 1) trong CUNG buoi 0 -> lan giai toan
        # truong xep du 10 tiet kem 1 buoi vi pham, go khong duoc (chi 1 buoi).
        P = _two_campus([0])
        soft = _soft(P, [])
        con = Constructor(P, seed=5)
        con.cherry_cpsat = True
        con.cpsat_threads = 2
        stats = con._cpsat_fill_phase(soft, time.monotonic() + 13.0)
        self.assertEqual(stats.get("whole_accept"), 1, stats)
        self.assertIn("whole_loc_shed", stats, stats)
        self.assertEqual(stats["whole_loc_shed"][1], 9, stats)
        self.assertEqual(soft.penalty(), 0)
        self.assertEqual(sum(1 for row in soft.grid for v in row if v >= 0), 9)


if __name__ == "__main__":
    unittest.main()
