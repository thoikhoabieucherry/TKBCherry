"""Cherry engine v3 — vung lan can "nguyen buoi toan truong" cua CP-SAT LNS (11/09).

``cpsat_lns.build_and_solve(..., sessions=[...])``: chi o thuoc cac buoi da cho la
tu do, moi o khac (ke ca o cua lop trong cluster o buoi khac) la hang so. Kiem:
  * ket qua chi gom o cua cac buoi do va phu DU moi o tu do cua chung;
  * o ngoai cac buoi do khong doi sau apply; so tiet moi phan cong giu nguyen;
  * loi giai qua trong tai State.full_recheck; hop dong lane van dung
    (khong tang buoi 1 tiet / trong >= 2, khong tang buoi day);
  * Constructor: _cpsat_session_turn theo env, _cpsat_pick_sessions tra 2 buoi mo.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.core import NUM_SESSIONS, NUM_SLOTS, PERIODS  # noqa: E402
from test_engine_v3_cpsat_lns import _counts, _hard_ok, _latin, _refresh  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class SessionNeighbourhoodTests(unittest.TestCase):
    def test_only_given_sessions_change(self) -> None:
        P, soft, classes = _latin(n_groups=2, sessions=(0, 2, 4, 6))
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        snap = [row[:] for row in soft.grid]
        q0 = soft.quality()
        counts0 = _counts(P, soft.grid)
        chosen = [0, 4]
        cells, info = cpsat_lns.build_and_solve(
            P, soft, classes, "gap1", time_limit=20.0, workers=2, seed=1, require_improve=False, sessions=chosen
        )
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["sessions"], chosen)
        self.assertIn(info["status"], ("OPTIMAL", "FEASIBLE"))
        expect = {
            (c, x)
            for c in classes
            for x in range(NUM_SLOTS)
            if soft.grid[c][x] >= 0 and not soft.locked[c][x] and (x // PERIODS) in chosen
        }
        self.assertEqual(set(cells.keys()), expect)
        journal = cpsat_lns.apply_cells(soft, cells)
        _refresh(soft)
        for c in classes:
            for x in range(NUM_SLOTS):
                if (x // PERIODS) not in chosen:
                    self.assertEqual(soft.grid[c][x], snap[c][x], (c, x))
        self.assertEqual(_counts(P, soft.grid), counts0)
        self.assertEqual(soft.penalty(), 0)
        q1 = soft.quality()
        self.assertLessEqual(q1[0], q0[0])
        self.assertLessEqual(q1[1], q0[1])
        self.assertLessEqual(q1[2], q0[2])
        self.assertLessEqual(q1[3], q0[3])
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        cpsat_lns.revert(soft, journal)
        _refresh(soft)
        self.assertEqual(soft.grid, snap)

    def test_empty_or_bad_sessions(self) -> None:
        P, soft, classes = _latin()
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=2.0, workers=1, sessions=[99])
        self.assertIsNone(cells)
        self.assertEqual(info["error"], "empty sessions")
        # buoi khong co o nao cua lop -> "no free cells", khong nem loi
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=2.0, workers=1, sessions=[1])
        self.assertIsNone(cells)
        self.assertEqual(info["error"], "no free cells")


class ConstructorSessionTurnTests(unittest.TestCase):
    def _ctor(self):
        from tkb_engine_v3.construct import Constructor

        P, soft, _classes = _latin(n_groups=2, sessions=(0, 2, 4, 6))
        ctor = Constructor(P, seed=3)
        return ctor, soft

    def test_turn_follows_env(self) -> None:
        ctor, _soft = self._ctor()
        old = os.environ.get("TKB_CPSAT_SESSION_EVERY")
        try:
            os.environ["TKB_CPSAT_SESSION_EVERY"] = "3"
            turns = []
            for i in range(6):
                ctor._cpsat_pass_idx = i
                turns.append(ctor._cpsat_session_turn())
            self.assertEqual(turns, [False, False, True, False, False, True])
            os.environ["TKB_CPSAT_SESSION_EVERY"] = "0"
            self.assertFalse(ctor._cpsat_session_turn())
            os.environ["TKB_CPSAT_SESSION_EVERY"] = "xyz"
            ctor._cpsat_pass_idx = 1
            self.assertTrue(ctor._cpsat_session_turn())  # gia tri hong -> mac dinh 2
            ctor._cpsat_pass_idx = 2
            self.assertFalse(ctor._cpsat_session_turn())
        finally:
            if old is None:
                os.environ.pop("TKB_CPSAT_SESSION_EVERY", None)
            else:
                os.environ["TKB_CPSAT_SESSION_EVERY"] = old

    def test_pick_two_open_sessions(self) -> None:
        ctor, soft = self._ctor()
        for lane in ("gap1", "sessions"):
            for _ in range(5):
                picked = ctor._cpsat_pick_sessions(soft, lane)
                self.assertEqual(len(picked), 2)
                self.assertLess(picked[0], picked[1])
                for s in picked:
                    self.assertIn(s, (0, 2, 4, 6))
                    self.assertTrue(0 <= s < NUM_SESSIONS)


if __name__ == "__main__":
    unittest.main()
