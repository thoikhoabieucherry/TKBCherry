"""Cherry engine v3 — "Khong day tiet 5 sang & tiet 1 chieu" (24/08).

Luat nay (noMorningP5AfternoonP1) tinh theo GIAO VIEN tren TOAN TRUONG: cung
mot ngay, GV khong duoc vua co tiet 5 buoi sang vua co tiet 1 buoi chieu — hai
tiet do thuong nam o HAI LOP khac nhau nen mo rieng tung lop khong thay gi.

Hai dieu duoc khoa o day:
  1. No luat nam o DUNG hai o (sang tiet 5, chieu tiet 1) cua ngay vi pham ->
     pha 2 phai boc trung hai o do, khong boc ngau nhien mot tiet bat ky trong
     tuan cua GV (xac suat cham ~1/20 -> gan nhu khong bao gio tra het no).
  2. Lich warm cua nguoi dung thuong DA co san no luat. Sua duoc mot phan thi
     phai GIU luoi da sua; truoc day la tat-hoac-khong nen ca truong bi xep lai
     tu dau, ket qua xau hon han va bi cong chat luong tu choi -> nguoi dung
     bam bao nhieu lan cung thay y nguyen loi cu.
"""

from __future__ import annotations

import sys
import time
import unittest
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3 import construct  # noqa: E402
from tkb_engine_v3.core import NUM_SLOTS, PERIODS, compile_problem, slot_of  # noqa: E402
from tkb_engine_v3.entry import _context_with_fixed_demand, solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import build_school_data_from_ui  # noqa: E402

DAY_KEYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
# Chieu chi mo thu 2 va thu 4 -> lich chat, GV de dinh ca tiet 5 sang lan tiet
# 1 chieu trong cung mot ngay.
PM_OFF_DAYS = ["thu3", "thu5", "thu6", "thu7"]
SUBJECTS = [("Toan", 6, 2), ("Van", 6, 2), ("Anh", 5, 2), ("Su", 4, 1), ("Dia", 4, 1), ("GDCD", 3, 1)]
CLASSES = [("L%d" % i, "6/%d" % i) for i in range(1, 5)]
AM5_THU2 = slot_of(0, 0, 4)
PM1_THU2 = slot_of(0, 1, 0)


def _all_sessions(flag: bool = True) -> dict:
    return {part: {day: flag for day in DAY_KEYS} for part in ("sang", "chieu")}


def _school(*, with_rule: bool = True) -> dict:
    pm_off = {"%s|chieu|%d" % (day, p): True for day in PM_OFF_DAYS for p in range(PERIODS)}
    data: dict = {
        "lop": [{"id": cid, "ten": name, "khoi": "6"} for cid, name in CLASSES],
        "giaovien": [{"magv": "GV_" + s, "ten": "GV " + s} for s, _n, _cap in SUBJECTS],
        "monhoc": [{"ten": s, "ma": s[:3].upper()} for s, _n, _cap in SUBJECTS],
        "mon": [{"khoi": "6", "ten": s, "sotiet": n, "gioihan": cap} for s, n, cap in SUBJECTS],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "tkbConstraints": {
            "fixedOff": {"class": {cid: dict(pm_off) for cid, _name in CLASSES}},
            "teacher": (
                {"GV_" + s: {"noMorningP5AfternoonP1": _all_sessions()} for s, _n, _cap in SUBJECTS}
                if with_rule
                else {}
            ),
        },
    }
    for cid, _name in CLASSES:
        for s, n, _cap in SUBJECTS:
            data["pccmMatrix"]["%s|%s" % (cid, s)] = "GV_" + s
            data["pccmTietMatrix"]["%s|%s" % (cid, s)] = n
    return data


def _settings(seed: int, seconds: int = 15) -> dict:
    return {
        "engine": "cherry",
        "overall_time_limit_seconds": seconds,
        "num_workers": 1,
        "random_seed": seed,
        "require_complete_schedule": False,
    }


def _violations(lessons: list[dict]) -> int:
    """Dem (GV x ngay) vi pham, dung ngu nghia evalTeacherRule cua giao dien."""

    p5: dict[tuple[str, int], int] = defaultdict(int)
    p1: dict[tuple[str, int], int] = defaultdict(int)
    for lesson in lessons:
        teacher = str(lesson.get("teacher") or "")
        if not teacher:
            continue
        key = (teacher, int(lesson["day"]))
        if lesson["session"] == "AM" and int(lesson["period"]) == PERIODS:
            p5[key] += 1
        if lesson["session"] == "PM" and int(lesson["period"]) == 1:
            p1[key] += 1
    return len(set(p5) & set(p1))


def _problem(data: dict):
    ctx = build_school_data_from_ui(data)
    return compile_problem(_context_with_fixed_demand(ctx, ctx, []), ctx.rules, [])


def _load_soft(problem, lessons: list[dict]) -> construct.SoftSchedule:
    cidx = {n: i for i, n in enumerate(problem.class_names)}
    sidx = {n: i for i, n in enumerate(problem.subject_names)}
    tidx = {n: i for i, n in enumerate(problem.teacher_names)}
    amap = {}
    for ai in range(problem.num_assignments()):
        amap[(problem.a_class[ai], problem.a_subject[ai], problem.a_teacher[ai])] = ai
    soft = construct.SoftSchedule(problem)
    for lesson in lessons:
        key = (
            cidx.get(lesson["className"]),
            sidx.get(lesson["subject"]),
            tidx.get(lesson["teacher"], -1),
        )
        ai = amap.get(key)
        if ai is None:
            continue
        slot = slot_of(
            int(lesson["day"]) - 2,
            0 if lesson["session"] == "AM" else 1,
            int(lesson["period"]) - 1,
        )
        if soft.grid[key[0]][slot] == -1:
            soft.set_cell(key[0], slot, ai)
    for t in range(problem.num_teachers()):
        soft.refresh_rule_pen(t)
    return soft


class EdgePairDebtSlotTests(unittest.TestCase):
    """No luat phai chi dung hai o gay ra no, khong phai ca tuan cua GV."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.problem = _problem(_school())

    def _soft_with_one_violation(self):
        P = self.problem
        t = P.teacher_names.index("GV_Toan")
        soft = construct.SoftSchedule(P)
        placed = []
        for ai in range(P.num_assignments()):
            if P.a_teacher[ai] != t:
                continue
            placed.append(ai)
            if len(placed) == 2:
                break
        soft.set_cell(P.a_class[placed[0]], AM5_THU2, placed[0])
        soft.set_cell(P.a_class[placed[1]], PM1_THU2, placed[1])
        soft.refresh_rule_pen(t)
        return soft, t, placed

    def test_debt_slots_are_exactly_the_two_offending_cells(self) -> None:
        soft, t, _placed = self._soft_with_one_violation()
        self.assertEqual(sorted(soft.edge_pair_debt_slots(t)), sorted([AM5_THU2, PM1_THU2]))
        self.assertEqual(soft.rule_pen[t], 1)

    def test_no_debt_when_only_one_of_the_pair_is_used(self) -> None:
        soft, t, placed = self._soft_with_one_violation()
        soft.set_cell(self.problem.a_class[placed[1]], PM1_THU2, -1)
        soft.refresh_rule_pen(t)
        self.assertEqual(soft.edge_pair_debt_slots(t), [])
        self.assertEqual(soft.rule_pen[t], 0)

    def test_teacher_without_the_rule_reports_no_debt(self) -> None:
        problem = _problem(_school(with_rule=False))
        t = problem.teacher_names.index("GV_Toan")
        soft = construct.SoftSchedule(problem)
        self.assertEqual(soft.edge_pair_debt_slots(t), [])

    def test_phase2_picks_a_cell_inside_the_offending_pair(self) -> None:
        soft, _t, _placed = self._soft_with_one_violation()
        con = construct.Constructor(self.problem, seed=7)
        picked = {con._pick_conflict(soft)[1] for _ in range(20)}
        self.assertTrue(picked <= {AM5_THU2, PM1_THU2}, picked)


class WarmRepairKeepsProgressTests(unittest.TestCase):
    """Sua duoc mot phan no luat thi giu luoi, khong vut di xep lai tu dau."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.free = solve_from_ui_data_v3(_school(with_rule=False), _settings(3))

    def _partially_repairable_soft(self):
        problem = _problem(self.data)
        return problem, _load_soft(problem, list(self.free.get("lessons") or []))

    def test_fixture_warm_schedule_really_violates_the_rule(self) -> None:
        self.assertGreaterEqual(_violations(list(self.free.get("lessons") or [])), 1)

    def test_grid_is_kept_when_phase2_only_removes_part_of_the_debt(self) -> None:
        problem, soft = self._partially_repairable_soft()
        start_debt = soft.rule_pen_total
        self.assertGreaterEqual(start_debt, 2, "can it nhat 2 no de con du sau khi go 1")
        con = construct.Constructor(problem, seed=5)

        def offending_am5_slots(target):
            """(GV, o tiet 5 sang) cua moi ngay dang vi pham.

            Tu tinh lay thay vi goi edge_pair_debt_slots() de test nay do DUNG
            hop dong "giu luoi da sua mot phan", khong phu thuoc helper moi.
            """

            out = []
            for t in range(problem.num_teachers()):
                for d in range(len(DAY_KEYS)):
                    am5 = slot_of(d, 0, PERIODS - 1)
                    pm1 = slot_of(d, 1, 0)
                    if target.tcnt[t][am5] > 0 and target.tcnt[t][pm1] > 0:
                        out.append((t, am5))
            return out

        def phase2_removes_one(target, _deadline):
            """Go dung MOT no roi dung — mo phong het ngan sach thoi gian."""
            for t, slot in offending_am5_slots(target):
                for c in range(problem.num_classes()):
                    ai = target.grid[c][slot]
                    if ai < 0 or problem.a_teacher[ai] != t or target.locked[c][slot]:
                        continue
                    # Do vao mot tiet GIUA buoi (khong phai tiet 5 sang, khong
                    # phai tiet 1 chieu) va GV cung dang ranh o do — no khong
                    # chay sang ngay khac, cung khong sinh trung gio.
                    free_slot = next(
                        (
                            s
                            for s in range(NUM_SLOTS)
                            if target.grid[c][s] == -1
                            and problem.class_avail[c][s]
                            and target.tcnt[t][s] == 0
                            and 0 < s % PERIODS < PERIODS - 1
                        ),
                        None,
                    )
                    if free_slot is None:
                        continue
                    target.set_cell(c, slot, -1)
                    target.set_cell(c, free_slot, ai)
                    for ti in range(problem.num_teachers()):
                        target.refresh_rule_pen(ti)
                    return
            return

        con._phase2 = phase2_removes_one
        expected = sum(problem.a_periods)
        out = con._repair_partial_warm(soft, expected, time.monotonic() + 60.0)
        self.assertIsNotNone(out, con._last_load_fail)
        self.assertLess(out.penalty(), start_debt)
        self.assertEqual(out.overlap, 0)
        placed = sum(1 for row in out.grid for v in row if v >= 0)
        self.assertEqual(placed, expected)

    def test_grid_is_dropped_when_phase2_makes_no_progress(self) -> None:
        problem, soft = self._partially_repairable_soft()
        con = construct.Constructor(problem, seed=5)
        con._phase2 = lambda _soft, _deadline: None
        out = con._repair_partial_warm(soft, sum(problem.a_periods), time.monotonic() + 60.0)
        self.assertIsNone(out)

    def test_warm_start_from_violating_schedule_clears_the_rule(self) -> None:
        warm = dict(self.data)
        warm["tkbSolverResult"] = {"lessons": list(self.free.get("lessons") or [])}
        payload = solve_from_ui_data_v3(warm, _settings(11, seconds=20))
        metrics = payload.get("metrics") or {}
        self.assertEqual(
            int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1)
        )
        self.assertEqual(_violations(list(payload.get("lessons") or [])), 0)
        v3 = (payload.get("solver") or {}).get("engine_v3") or {}
        self.assertTrue(v3.get("warm_start"), v3)


if __name__ == "__main__":
    unittest.main()
