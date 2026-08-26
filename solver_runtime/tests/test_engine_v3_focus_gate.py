"""25/08/2026 (chu du an: "toi uu xong thi so do lai tang la khong hop ly").

Hop dong cua nut MOT MUC TIEU (menu Toi uu v3) so voi LICH XUAT PHAT:
  1. Khong bao gio xay lai tu dau: lich vao bi tu choi warm-start (thieu tiet o
     mon co cap 2 tiet, lich rong...) -> sua cuc bo, hoac tra lai DUNG lich
     cu kem ly do (focus_aborted), feasibility.attempts luon = 0.
  2. Ket qua cuoi khong xau hon moc: khong rot tiet, chi so uu tien cao hon
     khong tang, chi so phu trach giam that (hoac bang khi xep them tiet);
     nguoc lai tra lai lich cu (focus_gate.keep_original).
  3. So lieu tien do phat ra la luoi TOT NHAT (khong nhay len).
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tkb_engine_v3 import construct  # noqa: E402
from tkb_engine_v3.core import compile_problem  # noqa: E402
from tkb_engine_v3.entry import _context_with_fixed_demand, _focus_gate, solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import build_school_data_from_ui  # noqa: E402

from test_engine_v3_quality_eject import _school, _settings, _tkb_from_lessons, _v3  # noqa: E402


def _gap1_settings(seed: int, seconds: int = 10) -> dict:
    base = _settings(seed, seconds=seconds)
    base["optimization_gap_target"] = "gap1"
    return base


def _warm(data: dict, tkb: dict) -> dict:
    warm = dict(data)
    warm["tkb"] = {cid: {d: {p: list(cells) for p, cells in parts.items()} for d, parts in grid.items()} for cid, grid in tkb.items()}
    warm["tkbSolverResult"] = {"unassignedLessons": []}
    return warm


def _count(tkb: dict) -> int:
    return sum(
        1
        for grid in tkb.values()
        for parts in grid.values()
        for cells in parts.values()
        for v in cells
        if v
    )


def _break_doubles(tkb: dict, subject: str, classes: int) -> int:
    """Voi `classes` lop dau tien: xoa MOT tiet cua moi cap `subject` (cap 2
    tiet lien tiep trong mot buoi) -> lop mat het cap doi ma van con tiet le
    -> warm-start truoc day bi tu choi hard:lesson_blocks_min_2."""

    removed = 0
    done = 0
    for cid in sorted(tkb):
        if done >= classes:
            break
        hit = False
        for day in tkb[cid].values():
            for cells in day.values():
                for i in range(len(cells) - 1):
                    if cells[i] == subject and cells[i + 1] == subject:
                        cells[i + 1] = ""
                        removed += 1
                        hit = True
        if hit:
            done += 1
    return removed


class FocusGateUnitTests(unittest.TestCase):
    def _best(self, start_q, start_placed, obj, placed, ejected=0, aborted=None):
        info = {
            "warm_quality": list(start_q),
            "warm_placed": start_placed,
            "warm_grid": [[0, -1], [-1, 1]],
        }
        if aborted:
            info["focus_aborted"] = aborted
        return {
            "info": info,
            "objective": list(obj),
            "placed": placed,
            "quality_ejected": ejected,
            "grid": [[7, 7], [7, 7]],
        }

    def test_focus_metric_rising_keeps_original_grid(self) -> None:
        best = self._best([1, 0, 20, 5], 97, [1, 0, 20, 7], 97)
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertIn("trống 1 tiết tăng 5 ➔ 7", verdict["message"])
        self.assertEqual(best["grid"], [[0, -1], [-1, 1]])
        self.assertEqual(best["objective"][:4], [1, 0, 20, 5])
        self.assertEqual(best["placed"], 97)
        self.assertEqual(best["info"]["focus_no_gain"], verdict["message"])

    def test_equal_focus_metric_without_new_lessons_is_no_gain(self) -> None:
        best = self._best([1, 0, 20, 5], 97, [1, 0, 20, 5], 97)
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertIn("không giảm được thêm", verdict["message"])

    def test_dropping_lessons_is_rejected_even_if_focus_improves(self) -> None:
        best = self._best([1, 0, 20, 5], 97, [1, 0, 20, 2], 90)
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertIn("rớt 7 tiết", verdict["message"])

    def test_locked_metric_rising_is_rejected(self) -> None:
        best = self._best([1, 0, 20, 5], 97, [2, 0, 20, 3], 97)
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertIn("1 tiết/buổi tăng 1 ➔ 2", verdict["message"])

    def test_real_improvement_passes_untouched(self) -> None:
        best = self._best([1, 0, 20, 5], 97, [1, 0, 20, 3], 97)
        verdict = _focus_gate("gap1", best)
        self.assertFalse(verdict["keep_original"], verdict)
        self.assertEqual(best["grid"], [[7, 7], [7, 7]])

    def test_new_lessons_may_open_sessions_and_equal_focus_is_accepted(self) -> None:
        # xep them 2 tiet -> buoi day duoc noi 2, trong 1 bang nhau van nhan
        best = self._best([1, 0, 20, 5], 95, [1, 0, 22, 5], 97)
        verdict = _focus_gate("gap1", best)
        self.assertFalse(verdict["keep_original"], verdict)
        best = self._best([1, 0, 20, 5], 95, [1, 0, 23, 5], 97)
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"], verdict)

    def test_sessions_focus_locks_only_higher_metrics(self) -> None:
        # nut "Buoi day": trong 1 duoc phep tang (thu yeu), buoi phai giam
        best = self._best([1, 0, 20, 5], 97, [1, 0, 18, 9], 97)
        self.assertFalse(_focus_gate("sessions", best)["keep_original"])
        best = self._best([1, 0, 20, 5], 97, [1, 0, 20, 3], 97)
        self.assertTrue(_focus_gate("sessions", best)["keep_original"])

    def test_aborted_run_returns_original_with_reason(self) -> None:
        best = self._best([1, 0, 20, 5], 97, [4, 3, 30, 9], 99, aborted="hard:lesson_blocks_min_2")
        verdict = _focus_gate("gap1", best)
        self.assertTrue(verdict["keep_original"])
        self.assertEqual(verdict["aborted"], "hard:lesson_blocks_min_2")
        self.assertIn("thiếu cặp 2 tiết", verdict["message"])
        self.assertEqual(best["grid"], [[0, -1], [-1, 1]])

    def test_no_focus_or_no_baseline_is_ignored(self) -> None:
        self.assertIsNone(_focus_gate("gap1", {"info": {}, "objective": [0, 0, 0, 0]}))
        self.assertIsNone(_focus_gate("", self._best([1, 0, 20, 5], 97, [1, 0, 20, 9], 97)))


class FocusRunNeverRebuildsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school(lone_teacher=False)
        first = solve_from_ui_data_v3(cls.data, _settings(31, seconds=12))
        metrics = first.get("metrics") or {}
        assert int(metrics.get("scheduled_periods") or 0) == int(metrics.get("expected_periods") or -1), metrics
        cls.tkb = _tkb_from_lessons(list(first.get("lessons") or []))
        cls.first = first

    def test_missing_periods_in_double_block_subject_do_not_trigger_a_fresh_build(self) -> None:
        tkb = {cid: {d: {p: list(cells) for p, cells in parts.items()} for d, parts in grid.items()} for cid, grid in self.tkb.items()}
        removed = _break_doubles(tkb, "Toan", 3)
        self.assertGreaterEqual(removed, 3, "fixture phai co cap Toan de pha")
        start_count = _count(tkb)
        payload = solve_from_ui_data_v3(_warm(self.data, tkb), _gap1_settings(33, seconds=12))
        v3 = _v3(payload)
        metrics = payload.get("metrics") or {}
        # 1) KHONG xay lai tu dau
        self.assertEqual(int((v3.get("feasibility") or {}).get("attempts") or 0), 0, v3)
        self.assertEqual(v3.get("quality_focus"), "gap1")
        self.assertIsNotNone(v3.get("warm_quality"), v3)
        self.assertEqual(int(v3.get("warm_placed") or 0), start_count)
        # 2) khong rot tiet so voi lich xuat phat
        self.assertGreaterEqual(int(metrics.get("scheduled_periods") or 0), start_count, metrics)
        # 3) khong xau hon moc o moi chi so uu tien cao hon + chi so phu trach
        start_q = [int(x) for x in v3["warm_quality"]]
        obj = [int(x) for x in (v3.get("objective") or [])[:4]]
        gained = int(metrics.get("scheduled_periods") or 0) - start_count
        self.assertLessEqual(obj[0], start_q[0], (obj, start_q))
        self.assertLessEqual(obj[1], start_q[1], (obj, start_q))
        self.assertLessEqual(obj[2], start_q[2] + max(0, gained), (obj, start_q))
        self.assertLessEqual(obj[3], start_q[3], (obj, start_q))
        gate = v3.get("focus_gate") or {}
        if gate.get("keep_original"):
            # tra lai dung lich cu: so tiet va vi tri y nguyen
            self.assertEqual(int(metrics.get("scheduled_periods") or 0), start_count)
            self.assertTrue((payload.get("solver") or {}).get("runtime_settings", {}).get("schedule_unchanged"))
        else:
            # sua cuc bo thanh cong: lich du + hop le
            self.assertTrue(v3.get("warm_start"), v3)
            self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)

    def test_empty_schedule_is_refused_instead_of_being_built(self) -> None:
        payload = solve_from_ui_data_v3(_warm(self.data, {}), _gap1_settings(35, seconds=10))
        v3 = _v3(payload)
        self.assertEqual(int((v3.get("feasibility") or {}).get("attempts") or 0), 0, v3)
        self.assertTrue(str(v3.get("focus_aborted") or "").startswith("too_sparse"), v3.get("focus_aborted"))
        gate = v3.get("focus_gate") or {}
        self.assertTrue(gate.get("keep_original"), gate)
        self.assertIn("hãy xếp đủ", str(gate.get("message") or ""))
        self.assertEqual(list(payload.get("lessons") or []), [])

    def test_progress_frames_never_go_up(self) -> None:
        frames: list[list[int]] = []

        def progress(evt):
            q = evt.get("quality") if isinstance(evt, dict) else None
            if evt.get("stage") == "optimize:quality" and isinstance(q, list):
                frames.append([int(x) for x in q[:4]])

        solve_from_ui_data_v3(_warm(self.data, self.tkb), _gap1_settings(37, seconds=10), progress=progress)
        self.assertGreaterEqual(len(frames), 1)
        # gap1 lane: bo (1tiet, trong2, trong1) cua khung sau khong duoc xau hon khung truoc
        for before, after in zip(frames, frames[1:]):
            self.assertLessEqual((after[0], after[1], after[3]), (before[0], before[1], before[3]), frames)


class PairInsertTests(unittest.TestCase):
    def test_missing_double_is_inserted_as_a_pair(self) -> None:
        data = _school(lone_teacher=False)
        ctx = build_school_data_from_ui(data)
        problem = compile_problem(_context_with_fixed_demand(ctx, ctx, []), ctx.rules, [])
        con = construct.Constructor(problem, seed=3)
        soft = construct.SoftSchedule(problem)
        soft.enable_quality_tracking()
        toan = [ai for ai in range(problem.num_assignments()) if problem.subject_names[problem.a_subject[ai]] == "Toan"]
        self.assertTrue(toan)
        ai = toan[0]
        self.assertTrue(con._needs_double(soft, ai))
        added = con._insert_missing_quality_neutral(soft)
        self.assertGreaterEqual(added, 2)
        c = problem.a_class[ai]
        from tkb_engine_v3 import checks

        sessions = checks.class_subject_sessions(problem, soft.grid, c, problem.a_subject[ai])
        self.assertTrue(any(len(ps) >= 2 for ps in sessions.values()), sessions)
        self.assertIsNone(checks.check_class_subject_week(problem, soft.grid, c, problem.a_subject[ai], ai, False))

    def test_fix_min_block_joins_two_singles(self) -> None:
        data = _school(lone_teacher=False)
        ctx = build_school_data_from_ui(data)
        problem = compile_problem(_context_with_fixed_demand(ctx, ctx, []), ctx.rules, [])
        con = construct.Constructor(problem, seed=3)
        soft = construct.SoftSchedule(problem)
        soft.enable_quality_tracking()
        ai = next(a for a in range(problem.num_assignments()) if problem.subject_names[problem.a_subject[a]] == "Toan")
        c = problem.a_class[ai]
        si = problem.a_subject[ai]
        # hai tiet le o hai buoi khac nhau (thu 2 sang tiet 1, thu 3 sang tiet 1)
        soft.set_cell(c, 0 * 5 + 0, ai)
        soft.set_cell(c, 2 * 5 + 0, ai)
        from tkb_engine_v3 import checks

        self.assertEqual(checks.check_class_subject_week(problem, soft.grid, c, si, ai, False), "lesson_blocks_min_2")
        self.assertTrue(con._fix_min_block(soft, c, si))
        self.assertIsNone(checks.check_class_subject_week(problem, soft.grid, c, si, ai, False))
        self.assertEqual(sum(1 for v in soft.grid[c] if v == ai), 2)


if __name__ == "__main__":
    unittest.main()
