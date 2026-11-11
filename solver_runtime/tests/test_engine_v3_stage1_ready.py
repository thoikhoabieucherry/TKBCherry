"""Cherry engine v3 — 29/10/2026 (chu du an: "khi xep moi no mat rat lau de dung").

Nut Cherry xep tu dau = vong 1 (6 worker heuristic) roi vong 2 (CP-SAT). Do THCS An Phu
(869 tiet, 120 s qua Cherry.exe): vong 1 an 11-24 s duoi no luat GV / dia diem bang pha 2,
trong khi vong 2 vao toi uu nhanh nhu nhau du nhan luoi cua giay 4 hay giay 12.
-> worker vong 1 (co `stage1_ready_at`) tra luoi ngay khi gan du tiet (tru phan trung gio se
go); CHI luc xay moi — sua lich nguoi dung (warm) giu nguyen.
Vong 2 (lap tiet): go no dia diem nho vung da hong (khong giai lai vung cu tren cung luoi, hong
lien LOCFIX_FAIL_STREAK vung thi nhuong buoc khac); lan giai toan truong dung khi het loi giai moi.
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
from tkb_engine_v3 import construct, cpsat_lns, entry  # noqa: E402
from tkb_engine_v3.construct import Constructor  # noqa: E402
from tkb_engine_v3.core import PERIODS  # noqa: E402


def _two_classes(periods: int = 20):
    # 2 lop, moi lop 1 phan cong `periods` tiet cua GV rieng; hoc buoi 0..5
    return _problem(
        ["A", "B"], ["T0", "T1"], ["M0"],
        [(0, 0, (0,), periods, PERIODS), (1, 0, (1,), periods, PERIODS)],
        {0: list(range(6)), 1: list(range(6))},
    )


def _cells(P, per_class: int):
    out = []
    for c in range(P.num_classes()):
        for x in range(per_class):
            out.append((c, x, c))
    return out


class Stage1ReadyTests(unittest.TestCase):
    def test_not_armed_never_ready(self) -> None:
        P = _two_classes()
        con = Constructor(P, seed=1)
        con.stage1_ready_at = time.monotonic() - 1.0  # dat moc nhung chua "vao xay moi"
        self.assertFalse(con._stage1_ready(_soft(P, _cells(P, 20))))

    def test_armed_waits_for_the_moment(self) -> None:
        P = _two_classes()
        con = Constructor(P, seed=1)
        con._stage1_armed_at = time.monotonic() + 60.0
        self.assertFalse(con._stage1_ready(_soft(P, _cells(P, 20))))
        con._stage1_armed_at = time.monotonic() - 0.01
        self.assertTrue(con._stage1_ready(_soft(P, _cells(P, 20))))

    def test_needs_nearly_full_grid(self) -> None:
        P = _two_classes()
        con = Constructor(P, seed=1)
        con._stage1_armed_at = time.monotonic() - 0.01
        # 40 tiet: thieu 16 van du, thieu 18 thi chua
        self.assertTrue(con._stage1_ready(_soft(P, _cells(P, 12))))
        self.assertFalse(con._stage1_ready(_soft(P, _cells(P, 11))))

    def test_overlaps_count_as_missing(self) -> None:
        # 1 GV day 2 lop: o trung gio se bi go truoc khi tra -> tinh nhu tiet thieu
        P = _problem(
            ["A", "B"], ["T0"], ["M0"],
            [(0, 0, (0,), 10, PERIODS), (1, 0, (0,), 10, PERIODS)],
            {0: list(range(6)), 1: list(range(6))},
        )
        con = Constructor(P, seed=1)
        con._stage1_armed_at = time.monotonic() - 0.01
        clash = [(0, x, 0) for x in range(10)] + [(1, x, 1) for x in range(4)]
        soft = _soft(P, clash)
        self.assertEqual(soft.overlap, 4)
        self.assertTrue(con._stage1_ready(soft))  # 14 tiet - 4 trung = 10 >= 20 - 16
        soft2 = _soft(P, [(0, x, 0) for x in range(3)] + [(1, x, 1) for x in range(3)])
        self.assertEqual(soft2.overlap, 3)
        self.assertFalse(con._stage1_ready(soft2))  # 6 tiet - 3 trung = 3 < 20 - 16

    def test_fresh_solve_disarms_after_construction(self) -> None:
        P = _two_classes(periods=6)
        con = Constructor(P, seed=1)
        con.stage1_ready_at = time.monotonic()
        state, info = con.solve(time.monotonic() + 10.0)
        self.assertEqual(con._stage1_armed_at, 0.0)
        self.assertEqual(state.placed, 12)

    def test_worker_solve_passes_the_moment(self) -> None:
        seen = {}
        real = entry.Constructor

        class Spy(real):
            def solve(self, deadline, **kw):
                seen["ready_at"] = self.stage1_ready_at
                seen["deadline"] = deadline
                return super().solve(deadline, **kw)

        P = _two_classes(periods=6)
        entry.Constructor = Spy
        try:
            entry._worker_solve((P, 1, 8.0, None, None, 0, None, 1, False, False, 4.0))
            self.assertAlmostEqual(seen["deadline"] - seen["ready_at"], 4.0, delta=0.5)
            entry._worker_solve((P, 1, 8.0, None, None, 0, None, 1, False))
            self.assertEqual(seen["ready_at"], 0.0)
        finally:
            entry.Constructor = real


@unittest.skipUnless(cpsat_lns.available(), "ortools khong co")
class LocRepairMemoryTests(unittest.TestCase):
    def test_unfixable_debt_stops_after_streak_without_repeating_regions(self) -> None:
        # GV0 day A (co so 0) tiet 1 va B (co so 1) tiet 2 cung buoi 0; ca hai lop chi hoc buoi 0
        # -> no dia diem khong go duoc bang cach doi buoi.
        P = _two_campus([0])
        cells = [(0, 0, 0)] + [(0, p, 1) for p in range(1, PERIODS)]
        cells += [(1, 1, 2), (1, 0, 3)] + [(1, p, 3) for p in range(2, PERIODS)]
        soft = _soft(P, cells)
        self.assertGreater(soft.penalty(), 0)
        seen = []
        real = cpsat_lns.build_and_solve

        def spy(P_, soft_, classes, lane, **kw):
            seen.append(frozenset(kw.get("sessions") or ()))
            return real(P_, soft_, classes, lane, **kw)

        cpsat_lns.build_and_solve = spy
        try:
            con = Constructor(P, seed=3)
            stats: dict = {}
            con._cpsat_repair_loc_debt(soft, time.monotonic() + 60.0, stats, max_tries=200)
        finally:
            cpsat_lns.build_and_solve = real
        self.assertLessEqual(len(seen), construct.LOCFIX_FAIL_STREAK)
        self.assertEqual(len(seen), len(set(seen)))  # khong giai lai vung da hong
        self.assertGreater(soft.penalty(), 0)

    def test_stall_stop_keeps_solution(self) -> None:
        P = _two_campus([0, 1])
        soft = _soft(P, [])
        cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1], "fill", time_limit=10.0, workers=2, seed=1,
            require_improve=False, fill_quality=False, loc_soft=True, stall_s=0.5,
        )
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["unplaced"], 0, info)
        self.assertEqual(info["loc_viol"], 0, info)


if __name__ == "__main__":
    unittest.main()
