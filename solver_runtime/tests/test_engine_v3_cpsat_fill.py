"""Cherry engine v3 — CP-SAT lane "fill" + pha lap tiet / chat luong cua nut Cherry (01/10).

Truong 0 o du (THCS Hung Long 1207 tiet / 1207 o): pha 1+2 dung o ~1192, tiet
thieu chi xep duoc khi doi cho tiet khac (chuoi). Kiem tra:
  * lane fill dat duoc tiet thieu bang cach doi cho tiet khac, luoi hop le;
  * khong xep duoc thi bao unplaced, khong bao gio trung gio / vuot so tiet;
  * full_classes: lop thieu duoc mo ca tuan khi chi mo mot buoi cho truong;
  * Constructor._cpsat_fill_phase lap du tiet, _cpsat_quality_phase chi nhan khi tot hon.
Moi loi giai deu qua State.full_recheck (trong tai).
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.construct import Constructor  # noqa: E402
from tkb_engine_v3.core import PERIODS  # noqa: E402
from test_engine_v3_cpsat_lns import _counts, _hard_ok, _latin, _problem, _soft  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


def _chain_fixture():
    """1 lop, buoi 0 + buoi 2 mo (10 o). M0 (T0) 5 tiet, M1 (T1) 5 tiet.
    Luoi vao: M0 x5 o buoi 0, M1 x4 o buoi 2 tiet 1-4, o buoi 2 tiet 5 TRONG.
    M1 KHONG duoc hoc tiet 5 buoi 2 -> tiet M1 con thieu chi vao duoc buoi 0
    neu mot tiet M0 doi sang o trong (chuoi 2 buoc)."""

    allowed_m1 = [p for p in range(PERIODS)] + [2 * PERIODS + p for p in range(PERIODS - 1)]
    P = _problem(
        ["L0"], ["T0", "T1"], ["M0", "M1"],
        [(0, 0, (0,), 5, 5), (0, 1, (1,), 5, 5)],
        {0: [0, 2]},
        allowed_override={1: allowed_m1},
    )
    cells = [(0, p, 0) for p in range(PERIODS)] + [(0, 2 * PERIODS + p, 1) for p in range(PERIODS - 1)]
    return P, _soft(P, cells)


def _blocked_fixture():
    """2 lop chi hoc buoi 0. T0 day M0: L0 5 tiet (kin buoi), L1 1 tiet.
    L1 con M1 (T1) 4 tiet. Tiet M0 cua L1 khong bao gio xep duoc (T0 ban ca buoi)."""

    P = _problem(
        ["L0", "L1"], ["T0", "T1"], ["M0", "M1"],
        [(0, 0, (0,), 5, 5), (1, 0, (0,), 1, 1), (1, 1, (1,), 4, 4)],
        {0: [0], 1: [0]},
    )
    cells = [(0, p, 0) for p in range(PERIODS)] + [(1, p, 2) for p in range(4)]
    return P, _soft(P, cells)


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class FillLaneTests(unittest.TestCase):
    def test_fill_places_missing_lesson_through_a_chain(self) -> None:
        P, soft = _chain_fixture()
        self.assertEqual(_counts(P, soft.grid), [5, 4])
        cells, info = cpsat_lns.build_and_solve(P, soft, [0], "fill", time_limit=10.0, workers=2, seed=1,
                                                fill_quality=False)
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["missing_before"], 1)
        self.assertEqual(info["unplaced"], 0)
        journal = cpsat_lns.apply_cells(soft, cells)
        self.assertTrue(journal)
        self.assertEqual(_counts(P, soft.grid), [5, 5])
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        self.assertEqual(soft.overlap, 0)

    def test_fill_reports_unplaced_and_never_double_books(self) -> None:
        P, soft = _blocked_fixture()
        cells, info = cpsat_lns.build_and_solve(P, soft, [0, 1], "fill", time_limit=10.0, workers=2, seed=1)
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["missing_before"], 1)
        self.assertEqual(info["unplaced"], 1)
        cpsat_lns.apply_cells(soft, cells)
        counts = _counts(P, soft.grid)
        self.assertEqual(counts, [5, 0, 4])
        self.assertEqual(soft.overlap, 0)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)

    def test_dense_lanes_still_reject_empty_cells(self) -> None:
        # lane gap1/sessions giu hop dong "dense": o trong khong phai bien
        P, soft, classes = _latin()
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=10.0, workers=2, seed=3)
        if cells is not None:
            self.assertTrue(all(ai >= 0 for ai in cells.values()))
        self.assertNotIn("missing_before", info)

    def test_full_classes_open_whole_week_of_one_class(self) -> None:
        # chi mo buoi 2 cho moi lop -> tiet M1 thieu khong vao duoc (M1 cam o trong);
        # mo them ca tuan cua L0 -> chuoi buoi 0 <-> buoi 2 lam duoc
        P, soft = _chain_fixture()
        cells, info = cpsat_lns.build_and_solve(P, soft, [0], "fill", time_limit=10.0, workers=2, seed=1,
                                                sessions=[2], fill_quality=False)
        self.assertTrue(cells is None or info.get("unplaced") == 1, info)
        cells, info = cpsat_lns.build_and_solve(P, soft, [0], "fill", time_limit=10.0, workers=2, seed=1,
                                                sessions=[2], full_classes=[0], fill_quality=False)
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["unplaced"], 0)


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class CherryPhaseTests(unittest.TestCase):
    def test_fill_phase_completes_chain(self) -> None:
        P, soft = _chain_fixture()
        con = Constructor(P, seed=5)
        con.cherry_cpsat = True
        con.cpsat_threads = 2
        stats = con._cpsat_fill_phase(soft, time.monotonic() + 15.0)
        self.assertEqual(stats["placed_start"], 9)
        self.assertEqual(stats["placed_end"], 10)
        self.assertGreaterEqual(stats["accept"], 1)
        self.assertEqual(_counts(P, soft.grid), [5, 5])
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)

    def test_fill_phase_gives_up_cleanly_when_impossible(self) -> None:
        P, soft = _blocked_fixture()
        snap = [row[:] for row in soft.grid]
        con = Constructor(P, seed=5)
        con.cherry_cpsat = True
        con.cpsat_threads = 2
        stats = con._cpsat_fill_phase(soft, time.monotonic() + 4.0)
        self.assertEqual(stats["placed_end"], 9)
        self.assertEqual(stats["accept"], 0)
        self.assertEqual(soft.grid, snap)

    def test_quality_phase_only_accepts_improvements(self) -> None:
        P, soft, _classes = _latin()
        con = Constructor(P, seed=7)
        con.cherry_cpsat = True
        con.cpsat_threads = 2
        weights = (10**11, 10**8, 10**5, 10)
        score0 = con._quality_score(soft, weights)
        counts0 = _counts(P, soft.grid)
        stats = con._cpsat_quality_phase(soft, time.monotonic() + 8.0)
        self.assertLessEqual(con._quality_score(soft, weights), score0)
        if stats["accept"]:
            self.assertLess(con._quality_score(soft, weights), score0)
        self.assertEqual(_counts(P, soft.grid), counts0)
        self.assertEqual(soft.penalty(), 0)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)

    def test_cherry_cpsat_flag_off_keeps_old_path(self) -> None:
        P, soft = _chain_fixture()
        con = Constructor(P, seed=5)
        self.assertFalse(con.cherry_cpsat)


if __name__ == "__main__":
    unittest.main()
