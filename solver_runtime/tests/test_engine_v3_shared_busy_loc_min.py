"""Cherry engine v3 — 05/10/2026 (THCS An Phu kkhg52etp92: "bam Cherry xong TKB khong doi").

1. O GV ban co dinh vi tiet chung nhieu lop (P.teacher_fixed_busy, phan cong tong
   hop a_teachers = ()) duoc tinh vao thong ke buoi / buoi 1 tiet / trong va
   luat GV o ca SoftSchedule, State va CP-SAT (truoc day bi bo qua -> engine
   thay lich hien tai co 5 buoi 1 tiet trong khi giao dien thay 0).
2. CP-SAT ma hoa luat DIA DIEM (1 dia diem/buoi, tiet trong khi doi dia diem tru
   gio ra choi, toi da 1 lan doi/buoi) thay vi dong bang GV; TKB_CPSAT_LOC=0
   giu cach cu.
3. Luat so buoi toi thieu (maxDaysSessions.minSessions, "dung bang").
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_engine_v3_cpsat_lns import _hard_ok, _latin, _problem, _soft  # noqa: E402
from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.core import PERIODS, TeacherRule  # noqa: E402
from tkb_engine_v3.state import State  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


def _shared_problem():
    """2 lop, GV0 day mon 0 o ca hai lop + mot tiet chung nhieu lop (o co dinh
    dung chung) o buoi 0 tiet 1 (phan cong tong hop 2, a_teachers = ())."""

    assignments = [
        (0, 0, (0,), 2, 2),   # ai 0: lop 0 mon 0 GV0, 2 tiet
        (1, 0, (0,), 2, 2),   # ai 1: lop 1 mon 0 GV0, 2 tiet
        (0, 1, (), 1, 1),     # ai 2: tiet chung (tong hop) lop 0
    ]
    P = _problem(["A", "B"], ["T0"], ["M0", "CHUNG"], assignments, {0: [0, 2], 1: [0, 2]},
                 fixed_cells=[(0, 0, 2)])
    P.teacher_avail[0][0] = 0
    P.teacher_fixed_busy = [{0: 2}]
    return P


class SharedFixedBusyTests(unittest.TestCase):
    def test_state_counts_shared_fixed_slot_as_teaching(self) -> None:
        P = _shared_problem()
        st = State(P)
        # chi co o chung: GV0 co 1 buoi (buoi 0) voi 1 tiet
        self.assertEqual(st.objective()[:3], (1, 0, 1))
        # xep 2 tiet cua lop 1 ngay sau o chung (buoi 0, tiet 2-3) -> buoi 0 co 3 tiet
        self.assertIsNotNone(st.apply([(1, 1, 1), (1, 2, 1)]))
        self.assertEqual(st.objective()[:4], (0, 0, 1, 0))
        # GV0 khong duoc xep tiet khac vao o chung
        self.assertIsNone(st.apply([(1, 0, 1)]))

    def test_soft_schedule_counts_shared_fixed_slot(self) -> None:
        P = _shared_problem()
        soft = _soft(P, [(1, 1, 1), (1, 2, 1), (0, 10, 0), (0, 11, 0)])
        q = soft.quality()
        # buoi 0: o chung + 2 tiet lop 1 (3 tiet, khong trong); buoi 2: 2 tiet lop 0
        self.assertEqual(q[:4], (0, 0, 2, 0))
        self.assertEqual(soft.tcnt[0][0], 1)
        self.assertEqual(soft.penalty(), 0)

    def test_rule_counts_shared_fixed_slot(self) -> None:
        P = _shared_problem()
        P.teacher_rules[0] = TeacherRule(max_sessions=1)
        soft = _soft(P, [(0, 10, 0), (0, 11, 0), (1, 12, 1), (1, 13, 1)])
        # buoi 0 (o chung) + buoi 2 = 2 buoi > 1
        self.assertGreater(soft.rule_pen[0], 0)


@unittest.skipUnless(HAS_ORTOOLS, "ortools khong co")
class LocationInModelTests(unittest.TestCase):
    def _loc_latin(self):
        P, soft, classes = _latin(with_rules=False, fixed=False)
        P.a_loc = [1 if P.a_class[ai] == 1 else 0 for ai in range(P.num_assignments())]
        P.loc_names = ["co so 1", "co so 2"]
        P.teacher_rules[2] = TeacherRule(loc_gap=(True,) * 12, loc_move=(True,) * 12)
        P.teacher_loc_rules[2] = True
        return P, soft, classes

    def test_location_teacher_is_modelled_not_frozen(self) -> None:
        P, soft, classes = self._loc_latin()
        self.assertTrue(_hard_ok(P, soft.grid)[0])
        cells, info = cpsat_lns.build_and_solve(
            P, soft, classes, "gap1", time_limit=15.0, workers=2, require_improve=False
        )
        self.assertEqual(info["frozen_teachers"], 0, info)
        self.assertGreater(info.get("loc_constraints", 0), 0, info)
        self.assertIsNotNone(cells, info)
        journal = cpsat_lns.apply_cells(soft, cells)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        st = State(P)
        for c in range(P.num_classes()):
            for x in range(len(soft.grid[c])):
                if soft.grid[c][x] >= 0:
                    st.apply([(c, x, soft.grid[c][x])], check=False)
        self.assertEqual(st.location_rule_debt_sessions(), 0)
        cpsat_lns.revert(soft, journal)

    def test_env_switch_keeps_legacy_freeze(self) -> None:
        P, soft, classes = self._loc_latin()
        with mock.patch.dict(os.environ, {"TKB_CPSAT_LOC": "0"}):
            _cells, info = cpsat_lns.build_and_solve(
                P, soft, classes, "gap1", time_limit=5.0, workers=1, require_improve=False
            )
        self.assertEqual(info["frozen_teachers"], 1, info)
        self.assertEqual(info["frozen_reasons"], {2: "location_rules"})


class MinSessionsTests(unittest.TestCase):
    def _two_session_problem(self, min_sessions: int):
        # 1 lop, GV0 day 4 tiet mon 0 (suc chua 2/buoi) o buoi 0 va 2
        P = _problem(["A"], ["T0"], ["M0", "M1"], [(0, 0, (0,), 4, 4), (0, 1, (), 6, 5)], {0: [0, 2]})
        P.teacher_rules[0] = TeacherRule(min_sessions=min_sessions)
        return P

    def test_state_rejects_fewer_sessions_than_minimum(self) -> None:
        P = self._two_session_problem(2)
        st = State(P)
        # 4 tiet mon 0 + 6 tiet mon 1 lap day 2 buoi (10 o)
        changes = [(0, 0, 0), (0, 1, 0), (0, 10, 0), (0, 11, 0)]
        changes += [(0, x, 1) for x in (2, 3, 4, 12, 13, 14)]
        self.assertIsNotNone(st.apply(changes))
        # don ca 4 tiet mon 0 vao buoi 0 -> GV0 con 1 buoi < 2 -> bi chan
        swap = [(0, 2, 0), (0, 3, 0), (0, 10, 1), (0, 11, 1)]
        self.assertIsNone(st.apply(swap))
        self.assertEqual(st.check_fail_reason, "teacher_min_sessions")

    def test_minimum_not_enforced_while_teacher_incomplete(self) -> None:
        P = self._two_session_problem(2)
        st = State(P)
        self.assertIsNotNone(st.apply([(0, 0, 0)]))  # GV0 moi xep 1/4 tiet

    def test_soft_penalty_only_when_complete(self) -> None:
        P = self._two_session_problem(2)
        soft = _soft(P, [(0, 0, 0), (0, 1, 0)])
        self.assertEqual(soft.rule_pen[0], 0)  # chua du tiet
        soft2 = _soft(P, [(0, 0, 0), (0, 1, 0), (0, 2, 0), (0, 3, 0)])
        self.assertEqual(soft2.rule_pen[0], 1)  # du tiet, 1 buoi < 2


if __name__ == "__main__":
    unittest.main()
