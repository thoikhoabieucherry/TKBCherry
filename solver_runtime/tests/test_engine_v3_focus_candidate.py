"""13/09/2026 (chu du an: "toi toi uu trong 1 tiet, quan sat thay giam tu 59 con 13
nhung khi tra ket qua lai phuc hoi 59 — toi muon giu ket qua tot nhat").

Nut MOT MUC TIEU truoc day co ba duong vut CA luot ve luoi goc: luoi toi uu cuoi
khong nap duoc (kiem tra cung / sua cuc bo hong -> focus_aborted), rot tiet, hoac
chi so uu tien cao hon tang. Nay Constructor ghi lai luoi HOP LE tot nhat da gap
(dat hop dong so voi moc xuat phat) va ca Constructor lan entry._focus_gate tra
luoi do thay vi luoi goc.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tkb_engine_v3 import construct  # noqa: E402
from tkb_engine_v3.core import NUM_SLOTS, compile_problem  # noqa: E402
from tkb_engine_v3.entry import _context_with_fixed_demand, _focus_gate, solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import build_school_data_from_ui  # noqa: E402

from test_engine_v3_quality_eject import _school, _settings  # noqa: E402


class AcceptableTests(unittest.TestCase):
    def test_contract_matches_focus_gate(self) -> None:
        ok = construct.focus_candidate_acceptable
        start = [5, 0, 260, 59]
        self.assertTrue(ok("gap1", start, 810, [5, 0, 260, 13], 810))
        self.assertTrue(ok("gap1", start, 810, [5, 0, 242, 4], 810))
        self.assertFalse(ok("gap1", start, 810, [5, 0, 261, 13], 810), "buoi day tang")
        self.assertFalse(ok("gap1", start, 810, [6, 0, 250, 13], 810), "1 tiet/buoi tang")
        self.assertFalse(ok("gap1", start, 810, [5, 1, 250, 13], 810), "trong 2 tang")
        self.assertFalse(ok("gap1", start, 810, [5, 0, 250, 13], 809), "rot tiet")
        self.assertFalse(ok("gap1", start, 810, [5, 0, 250, 59], 810), "trong 1 khong giam")
        self.assertTrue(ok("gap1", start, 808, [5, 0, 262, 20], 810), "xep them 2 tiet -> buoi noi 2")
        self.assertTrue(ok("sessions", start, 810, [5, 0, 250, 70], 810), "lane buoi: trong 1 duoc tang")
        self.assertFalse(ok("sessions", start, 810, [5, 0, 260, 10], 810))
        self.assertFalse(ok("", start, 810, [5, 0, 250, 13], 810))


class FocusGateCandidateTests(unittest.TestCase):
    def _best(self, obj, placed, candidate, aborted=None):
        info = {"warm_quality": [5, 0, 260, 59], "warm_placed": 810, "warm_grid": [[0, -1], [-1, 1]]}
        if aborted:
            info["focus_aborted"] = aborted
        if candidate is not None:
            info["focus_candidate"] = candidate
        return {"info": info, "objective": list(obj), "placed": placed, "quality_ejected": 0, "grid": [[7, 7], [7, 7]]}

    def test_rejected_final_result_keeps_best_valid_candidate(self) -> None:
        cand = {"grid": [[3, 3], [3, -1]], "quality": [5, 0, 255, 13, 30], "placed": 810}
        best = self._best([6, 0, 250, 9, 30], 810, cand)
        verdict = _focus_gate("gap1", best)
        self.assertFalse(verdict["keep_original"], verdict)
        self.assertEqual(verdict["result_quality"], [5, 0, 255, 13])
        self.assertIn("1 tiết/buổi tăng 5 ➔ 6", " ".join(verdict["fallback_from"]))
        self.assertEqual(best["grid"], [[3, 3], [3, -1]])
        self.assertEqual(best["objective"], [5, 0, 255, 13, 30])
        self.assertEqual(best["info"]["focus_fallback"]["quality"], [5, 0, 255, 13])

    def test_aborted_run_keeps_candidate(self) -> None:
        cand = {"grid": [[3, 3], [3, -1]], "quality": [5, 0, 258, 20, 30], "placed": 810}
        best = self._best([4, 3, 30, 9], 812, cand, aborted="hard:lesson_blocks_min_2")
        verdict = _focus_gate("gap1", best)
        self.assertFalse(verdict["keep_original"], verdict)
        self.assertIsNone(best["info"]["focus_aborted"])
        self.assertEqual(best["grid"], [[3, 3], [3, -1]])

    def test_candidate_outside_contract_is_ignored(self) -> None:
        cand = {"grid": [[3, 3], [3, -1]], "quality": [5, 0, 262, 13, 30], "placed": 810}
        best = self._best([6, 0, 250, 9], 810, cand)
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertEqual(best["grid"], [[0, -1], [-1, 1]])

    def test_no_candidate_still_returns_original(self) -> None:
        best = self._best([6, 0, 250, 9], 810, None)
        self.assertTrue(_focus_gate("gap1", best)["keep_original"])
        self.assertEqual(best["grid"], [[0, -1], [-1, 1]])


class ConstructorCandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school(lone_teacher=False)
        first = solve_from_ui_data_v3(cls.data, _settings(31, seconds=8))
        metrics = first.get("metrics") or {}
        assert int(metrics.get("scheduled_periods") or 0) == int(metrics.get("expected_periods") or -1), metrics
        ctx = build_school_data_from_ui(cls.data)
        cls.problem = compile_problem(_context_with_fixed_demand(ctx, ctx, []), ctx.rules, [])
        cls.lessons = list(first.get("lessons") or [])

    def _constructor_and_soft(self):
        P = self.problem
        con = construct.Constructor(P, seed=5)
        con.quality_focus = "gap1"
        soft = construct.SoftSchedule(P)
        class_index = {name: i for i, name in enumerate(P.class_names)}
        by_key = {}
        for ai in range(P.num_assignments()):
            by_key.setdefault((P.a_class[ai], P.subject_names[P.a_subject[ai]]), ai)
        for c, slot, ai in P.fixed_cells:
            soft.set_cell(c, slot, ai)
            soft.locked[c][slot] = 1
        for lesson in self.lessons:
            c = class_index.get(lesson["className"])
            if c is None:
                continue
            slot = ((int(lesson["day"]) - 2) * 2 + (0 if lesson["session"] == "AM" else 1)) * 5 + int(lesson["period"]) - 1
            ai = by_key.get((c, lesson["subject"]))
            if ai is not None and soft.grid[c][slot] == -1:
                soft.set_cell(c, slot, ai)
        soft.enable_quality_tracking()
        con._last_load_fail = ""
        self.assertIsNotNone(con._load_state(soft), con._last_load_fail)
        return con, soft

    def _break_a_double(self, soft) -> bool:
        """Pha HET cap Toan cua lop dau tien co cap (luat lessonBlocks["2"].min=1)
        -> luoi vi pham luat cung, _load_state tu choi."""

        P = self.problem
        for c in range(P.num_classes()):
            broke = False
            for slot in range(NUM_SLOTS - 1):
                ai = soft.grid[c][slot]
                if ai < 0 or slot % 5 == 4 or soft.locked[c][slot] or soft.locked[c][slot + 1]:
                    continue
                if P.subject_names[P.a_subject[ai]] == "Toan" and soft.grid[c][slot + 1] == ai:
                    soft.set_cell(c, slot + 1, -1)
                    broke = True
            if broke:
                return True
        return False

    def test_offer_validates_and_fallback_restores_best_valid_grid(self) -> None:
        con, soft = self._constructor_and_soft()
        q = list(soft.quality())
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        info: dict = {}
        # moc xuat phat gia dinh xau hon luoi hien tai 3 lo trong 1 tiet
        con._focus_start = ([q[0], q[1], q[2], q[3] + 3], placed)
        con._focus_info = info
        good_grid = [row[:] for row in soft.grid]
        con._offer_focus_candidate(soft.grid, q, force=True)
        self.assertIsNotNone(con._focus_candidate)
        self.assertEqual(info["focus_candidate"]["quality"][:4], q[:4])

        # luoi cuoi bi hong (mat cap Toan -> hard:lesson_blocks_min) -> khong nap duoc
        self.assertTrue(self._break_a_double(soft), "fixture phai co cap Toan")
        self.assertIsNone(con._load_state(soft))
        state = con._focus_fallback_state(soft, info)
        self.assertIsNotNone(state)
        self.assertEqual([row[:] for row in soft.grid], good_grid)
        self.assertIn("focus_fallback", info)

    def test_invalid_or_worse_grid_is_not_offered(self) -> None:
        con, soft = self._constructor_and_soft()
        q = list(soft.quality())
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        con._focus_info = {}
        self.assertTrue(self._break_a_double(soft))
        self.assertIsNone(con._load_state(soft))
        broken_q = list(soft.quality())
        broken_placed = sum(1 for row in soft.grid for v in row if v >= 0)
        # moc dat so tiet = luoi hong va trong 1 xau hon -> chi con kiem tra cung chan duoc
        con._focus_start = ([broken_q[0], broken_q[1], broken_q[2], broken_q[3] + 3], broken_placed)
        self.assertTrue(construct.focus_candidate_acceptable("gap1", con._focus_start[0], broken_placed, broken_q, broken_placed))
        con._offer_focus_candidate(soft.grid, broken_q, force=True)
        self.assertIsNone(con._focus_candidate, "luoi vi pham luat cung khong duoc lam ung vien")

        con2, soft2 = self._constructor_and_soft()
        q2 = list(soft2.quality())
        placed2 = sum(1 for row in soft2.grid for v in row if v >= 0)
        # buoi day cua luoi hien tai > moc -> khong dat hop dong
        con2._focus_start = ([q2[0], q2[1], q2[2] - 1, q2[3] + 3], placed2)
        con2._focus_info = {}
        con2._offer_focus_candidate(soft2.grid, q2, force=True)
        self.assertIsNone(con2._focus_candidate)
        self.assertIsNone(con2._focus_fallback_state(soft2, {}))

    def test_better_candidates_replace_worse_ones_only(self) -> None:
        con, soft = self._constructor_and_soft()
        q = list(soft.quality())
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        con._focus_start = ([q[0], q[1], q[2], q[3] + 5], placed)
        con._focus_info = {}
        worse_q = [q[0], q[1], q[2], q[3] + 2] + q[4:]
        con._offer_focus_candidate(soft.grid, worse_q, force=True)
        self.assertEqual(con._focus_candidate["quality"][3], q[3] + 2)
        con._offer_focus_candidate(soft.grid, q, force=True)
        self.assertEqual(con._focus_candidate["quality"][3], q[3])
        con._offer_focus_candidate(soft.grid, worse_q, force=True)
        self.assertEqual(con._focus_candidate["quality"][3], q[3], "ung vien kem hon khong duoc de len")


if __name__ == "__main__":
    unittest.main()
