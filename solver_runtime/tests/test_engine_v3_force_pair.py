"""23/08 (chi dao chu du an: "test nut Cherry voi TKB default xem tai sao khong
toi uu duoc 1 tiet/buoi; cai thien thuat cho nut Cherry va cac nut toi uu").

Ba cai tien trong construct.py duoc kiem o day:
  1. San "suc chua" (structural_floors -> _cap_floor): GV ma cac buoi con >= 2
     o hop le khong chua het so tiet thi bat buoc co buoi 1 tiet o cac buoi chi
     con 1 o -> KHONG tinh la no xu ly duoc, duoc bao kem goi y chinh xac.
  2. _enum_quality_moves cho phep GHEP SAT tiet cung mon (mask lien tuc).
  3. Nuoc "ep ghep roi sua" (_force_pair_session) khong bao gio tra ve lich
     vi pham luat / trung gio / thieu tiet.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tkb_engine_v3 import construct  # noqa: E402
from tkb_engine_v3.core import NUM_SESSIONS, NUM_SLOTS, PERIODS  # noqa: E402
from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402

from test_engine_v3_quality_eject import _quality_items, _school, _settings, _tkb_from_lessons, _v3  # noqa: E402


def _fake_problem(
    *,
    load: int,
    one_cell_sessions: list[int],
    multi_sessions: dict[int, int],
    teacher_only_sessions: list[int] = (),
):
    """GV 0 day `load` tiet (moi tiet 1 phan cong). Ranh: moi buoi trong
    one_cell_sessions dung 1 o; moi buoi s trong multi_sessions ranh
    multi_sessions[s] o; con lai nghi het. teacher_only_sessions: GV ranh ca
    buoi nhung KHONG tiet nao duoc phep (vd. lop khong hoc T7) — san cu (theo
    o ranh GV thuan) bo sot chinh ca nay."""

    avail = bytearray(NUM_SLOTS)
    for s in one_cell_sessions:
        avail[s * PERIODS] = 1
    for s, n in multi_sessions.items():
        for p in range(min(n, PERIODS)):
            avail[s * PERIODS + p] = 1
    a_allowed = [bytearray(avail) for _ in range(load)]
    for s in teacher_only_sessions:
        for p in range(PERIODS):
            avail[s * PERIODS + p] = 1
    return SimpleNamespace(
        num_assignments=lambda: load,
        num_teachers=lambda: 1,
        num_classes=lambda: load,
        a_teacher=[0] * load,
        a_teachers=[(0,)] * load,
        a_periods=[1] * load,
        a_allowed=a_allowed,
        teacher_avail=[avail],
        teacher_names=["GV_X"],
        teacher_rules=[None],
        teacher_must=[[]],
    )


class CapacityFloorTests(unittest.TestCase):
    def test_forced_singletons_when_multi_sessions_cannot_hold_the_load(self) -> None:
        # 20 tiet; 4 buoi ranh 5,3,5,5 o (=18) + 2 buoi chi con 1 o + GV ranh
        # ca T7 (10 o) nhung khong lop nao hoc T7 -> bat buoc >= 2 buoi 1 tiet
        # (ca Nhac.Duong, TKB default). San cu tinh theo o ranh GV (30 o) nen
        # khong thay gi.
        P = _fake_problem(
            load=20, one_cell_sessions=[3, 5], multi_sessions={0: 5, 1: 3, 2: 5, 9: 5},
            teacher_only_sessions=[10, 11],
        )
        con = construct.Constructor(P, seed=1)
        singles, gap2s, evidence = con.structural_floors()
        self.assertEqual(singles, set())
        self.assertEqual(gap2s, {})
        self.assertIn(0, con._cap_floor)
        forced, one_cell, multi_cap = con._cap_floor[0]
        self.assertEqual((forced, one_cell, multi_cap), (2, {3, 5}, 18))
        kinds = [e.get("kind") for e in evidence]
        self.assertIn("forced_one_period_capacity", kinds)
        self.assertEqual(con._cap_floor_total(), 2)
        # buoi 1 tiet o hai buoi 1 o duoc mien tru; o buoi khac thi KHONG
        con._floors_cache = (singles, gap2s, evidence)
        ts_cnt = [[0] * NUM_SESSIONS]
        ts_cnt[0][3] = 1
        ts_cnt[0][5] = 1
        ts_cnt[0][0] = 1
        soft = SimpleNamespace(ts_cnt=ts_cnt)
        self.assertTrue(con._single_excused(soft, 0, 3))
        self.assertTrue(con._single_excused(soft, 0, 5))
        self.assertFalse(con._single_excused(soft, 0, 0))

    def test_no_floor_when_multi_sessions_can_hold_everything(self) -> None:
        P = _fake_problem(load=6, one_cell_sessions=[3], multi_sessions={0: 5, 2: 5})
        con = construct.Constructor(P, seed=1)
        con.structural_floors()
        self.assertEqual(con._cap_floor, {})
        self.assertEqual(con._cap_floor_total(), 0)
        con._floors_cache = (set(), {}, [])
        soft = SimpleNamespace(ts_cnt=[[0] * NUM_SESSIONS])
        soft.ts_cnt[0][3] = 1
        self.assertFalse(con._single_excused(soft, 0, 3))

    def test_only_forced_count_is_excused(self) -> None:
        # 3 buoi 1 o nhung chi bat buoc 1 buoi le -> khi GV dang co 2 buoi le o
        # cac buoi 1 o thi KHONG mien tru (con 1 buoi xu ly duoc).
        P = _fake_problem(load=6, one_cell_sessions=[3, 5, 7], multi_sessions={0: 5})
        con = construct.Constructor(P, seed=1)
        con.structural_floors()
        self.assertEqual(con._cap_floor[0][0], 1)
        con._floors_cache = (set(), {}, [])
        ts_cnt = [[0] * NUM_SESSIONS]
        ts_cnt[0][3] = 1
        ts_cnt[0][5] = 1
        self.assertFalse(con._single_excused(SimpleNamespace(ts_cnt=ts_cnt), 0, 3))
        ts_cnt[0][5] = 0
        self.assertTrue(con._single_excused(SimpleNamespace(ts_cnt=ts_cnt), 0, 3))


class MaskHelperTests(unittest.TestCase):
    def test_mask_contiguous(self) -> None:
        self.assertTrue(construct._mask_contiguous(0b00110))
        self.assertTrue(construct._mask_contiguous(0b00001))
        self.assertTrue(construct._mask_contiguous(0b11111))
        self.assertFalse(construct._mask_contiguous(0b00101))
        self.assertFalse(construct._mask_contiguous(0b10001))
        self.assertFalse(construct._mask_contiguous(0))


class ForcePairIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(23, seconds=9))

    def _warm(self) -> dict:
        warm = dict(self.data)
        warm["tkb"] = _tkb_from_lessons(list(self.first.get("lessons") or []))
        warm["tkbSolverResult"] = {"unassignedLessons": []}
        return warm

    def test_force_pair_never_breaks_hard_validity_or_completeness(self) -> None:
        # Nut "Giam 1 tiet/buoi" chay tron ngan sach (ke ca ep ghep + sua xung
        # dot): lich tra ve van du tiet, hop le, khong tang trong >= 2 / so buoi.
        base = tuple(int(x) for x in (_v3(self.first).get("objective") or [0, 0, 0, 0])[:4])
        settings = _settings(29, seconds=10)
        settings["optimization_focus"] = "singletons"
        payload = solve_from_ui_data_v3(self._warm(), settings)
        v3 = _v3(payload)
        metrics = payload.get("metrics") or {}
        self.assertTrue(v3.get("warm_start"), v3)
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(_quality_items(payload), [])
        obj = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        self.assertLessEqual(obj[0], base[0])
        self.assertLessEqual(obj[1], base[1])
        self.assertLessEqual(obj[2], base[2])
        # GV_TIN (1 tiet/tuan) la san cau truc -> van duoc bao kem goi y
        kept = [u for u in (v3.get("quality_unavoidable") or []) if u.get("teacher") == "GV_TIN"]
        self.assertEqual(len(kept), 1, v3.get("quality_unavoidable"))

    def test_force_windows_and_candidates_are_well_formed(self) -> None:
        # Kiem truc tiep bo sinh nuoc ep ghep tren luoi that cua truong tong hop:
        # moi ung vien phai co cua so trong buoi no, o dich khong khoa, tiet
        # duoc phep, va ap thu phai giu luat lop (da kiem trong ham).
        from tkb_engine_v3.core import compile_problem
        from tkb_engine_v3.entry import _context_with_fixed_demand
        from tkb_new.adapter import (
            _extract_fixed_lessons_from_tkb,
            build_school_data_from_ui,
        )

        warm = self._warm()
        ctx = build_school_data_from_ui(warm)
        lessons, _w = _extract_fixed_lessons_from_tkb(warm, ctx)
        pctx = _context_with_fixed_demand(ctx, ctx, [])
        P = compile_problem(pctx, ctx.rules, [])
        cidx = {n: i for i, n in enumerate(P.class_names)}
        tidx = {n: i for i, n in enumerate(P.teacher_names)}
        sidx = {n: i for i, n in enumerate(P.subject_names)}
        amap = {}
        for ai in range(P.num_assignments()):
            amap[(P.a_class[ai], P.a_subject[ai], P.a_teacher[ai])] = ai
        soft = construct.SoftSchedule(P)
        for l in lessons:
            key = (cidx.get(l.class_name), sidx.get(l.subject), tidx.get(l.teacher, -1))
            ai = amap.get(key)
            if ai is None:
                continue
            slot = ((l.day - 2) * 2 + (0 if l.session == "AM" else 1)) * PERIODS + (l.period - 1)
            if soft.grid[key[0]][slot] == -1:
                soft.set_cell(key[0], slot, ai)
        soft.enable_quality_tracking()
        self.assertEqual(soft.overlap, 0)
        con = construct.Constructor(P, seed=3)
        con._floors_cache = con.structural_floors()
        weights = (10**11, 10**8, 10**5, 10)
        debts = con._debt_sessions_of(soft, set(range(P.num_teachers())), set())
        score0 = con._quality_score(soft, weights)
        snap = [row[:] for row in soft.grid]
        checked = 0
        for t, s in debts:
            for cost, oc, changes, W in con._force_pair_candidates(soft, t, s, fresh=True):
                self.assertGreaterEqual(cost, 0)
                self.assertTrue(all(not soft.locked[oc][x] for x in W))
                seen = dict(changes)
                for x in W:
                    self.assertIn(x, seen)
                    self.assertTrue(P.a_allowed[seen[x]][x])
                checked += 1
            # thu ep ghep that: hoac tot hon, hoac luoi y nguyen
            ok = con._force_pair_session(soft, t, s, weights, __import__("time").monotonic() + 1.5, floor_teachers=set())
            if ok:
                self.assertLess(con._quality_score(soft, weights), score0)
                self.assertEqual(soft.penalty(), 0)
                score0 = con._quality_score(soft, weights)
                snap = [row[:] for row in soft.grid]
            else:
                self.assertEqual([row[:] for row in soft.grid], snap)
            self.assertEqual(soft.overlap, 0)
        # luoi cuoi van nap duoc vao State (kiem cung day du)
        self.assertIsNotNone(con._load_state(soft))
        self.assertGreaterEqual(checked, 0)


if __name__ == "__main__":
    unittest.main()
