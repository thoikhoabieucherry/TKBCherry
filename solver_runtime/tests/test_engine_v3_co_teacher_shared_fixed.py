"""Cherry engine v3 — tiet DAY GHEP + o co dinh DUNG CHUNG (25/08, sau review).

Hop dong 23/08 (o co dinh trung GV giua nhieu lop duoc giu nguyen) phai ton
tai khi mot trong cac o do la tiet day ghep:
  * "GV_TNT, GV_HTV" o lop 6/1 va "GV_TNT" o lop 6/2, 6/3 cung khoa thu 5 tiet 1-2
    -> o dung chung cua GV_TNT (dem theo TUNG thanh vien), moi o co dinh deu
    giu, GV_TNT (va GV_HTV) khong co tiet khac vao gio do, hard_ok.
  * Warm-start: tiet ghep KHONG co dinh cua 6/1 phai duoc giu nguyen cho
    (truoc day bi anh xa nham vao phan cong tong hop a_teacher=-1 va bi bo).
"""

from __future__ import annotations

import sys
import unittest
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import shared_fixed_teacher_slots  # noqa: E402
from tkb_optimizer_ref.models import Lesson  # noqa: E402
from tkb_optimizer_ref.rules import teacher_members  # noqa: E402

from test_engine_v3_co_teacher_lessons import CLASSES, CO_TEACHER, _school, _settings, _slot  # noqa: E402

LOCK_DAY, LOCK_KEY = 5, "thu5"   # thu 5 sang tiet 1-2 (khong trung o nghi cua ai)


def _school_shared() -> dict:
    data = _school()
    # 6/2, 6/3: TNHN do MOT minh GV_TNT day; 6/1 van la tiet ghep.
    for cid in ("L2", "L3"):
        data["pccmMatrix"][f"{cid}|TNHN"] = "GV_TNT"
        data["pccmTietMatrix"][f"{cid}|TNHN"] = 2
    data["pccmTietMatrix"]["L1|TNHN"] = 3   # 2 co dinh + 1 tu do
    for cid in ("L1", "L2", "L3"):
        data["tkb"][cid] = {
            LOCK_KEY: {
                "sang": [{"mon": "TNHN", "fixed": True}, {"mon": "TNHN", "fixed": True}, "", "", ""],
                "chieu": ["", "", "", "", ""],
            }
        }
    return data


def _tkb_from(lessons: list[dict], fixed: set[tuple[str, int, str, int]]) -> dict:
    tkb: dict = {}
    for lesson in lessons:
        cid = str(lesson["classId"])
        day = f"thu{int(lesson['day'])}"
        part = "sang" if lesson["session"] == "AM" else "chieu"
        row = tkb.setdefault(cid, {}).setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
        key = (cid, int(lesson["day"]), str(lesson["session"]), int(lesson["period"]))
        row[part][int(lesson["period"]) - 1] = {"mon": lesson["subject"], "fixed": True} if key in fixed else lesson["subject"]
    return tkb


class SharedSlotDetectionTests(unittest.TestCase):
    def test_counts_per_member(self) -> None:
        mk = lambda cls, t: Lesson(class_name=cls, grade="6", day=5, session="AM", period=1, subject="TNHN", teacher=t)
        shared = shared_fixed_teacher_slots([mk("6/1", "GV_TNT, GV_HTV"), mk("6/2", "GV_TNT")])
        self.assertEqual(shared, {("GV_TNT", 5, "AM", 1)})
        self.assertEqual(shared_fixed_teacher_slots([mk("6/1", "GV_TNT, GV_HTV")]), set())


class CoTeacherSharedFixedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school_shared()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(3, seconds=12))

    def _assert_contract(self, payload: dict) -> None:
        metrics = payload.get("metrics") or {}
        self.assertTrue(payload.get("ok"), payload.get("validation"))
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("unassigned_periods") or 0), 0, payload.get("unassignedLessons"))
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        lessons = list(payload.get("lessons") or [])
        # moi o co dinh deu giu nguyen
        for cid in ("L1", "L2", "L3"):
            at = sorted((l["period"], l["subject"]) for l in lessons if l["classId"] == cid and l["day"] == LOCK_DAY and l["session"] == "AM" and l["period"] in (1, 2))
            self.assertEqual(at, [(1, "TNHN"), (2, "TNHN")], f"{cid}: {at}")
        co = [l for l in lessons if l["classId"] == "L1" and l["subject"] == "TNHN"]
        self.assertEqual(len(co), 3)
        self.assertEqual({l["teacher"] for l in co}, {CO_TEACHER})
        # GV_TNT / GV_HTV khong co tiet nao KHAC tai gio dung chung; ngoai gio do
        # khong thanh vien nao bi trung.
        by_member: dict[tuple[str, int, str, int], list[dict]] = defaultdict(list)
        for lesson in lessons:
            for member in teacher_members(lesson["teacher"]):
                by_member[(member, *_slot(lesson))].append(lesson)
        for (member, day, session, period), items in by_member.items():
            if len(items) <= 1:
                continue
            self.assertEqual((day, session), (LOCK_DAY, "AM"), (member, day, session, period, items))
            self.assertIn(period, (1, 2))
            self.assertTrue(all(l["subject"] == "TNHN" for l in items), items)
        return lessons

    def test_shared_lock_with_co_taught_cell_is_kept(self) -> None:
        self._assert_contract(self.first)

    def test_warm_start_keeps_free_co_taught_lesson_in_place(self) -> None:
        lessons = self._assert_contract(self.first)
        free_before = [l for l in lessons if l["classId"] == "L1" and l["subject"] == "TNHN" and not (l["day"] == LOCK_DAY and l["session"] == "AM")]
        self.assertEqual(len(free_before), 1, free_before)
        fixed = {(cid, LOCK_DAY, "AM", p) for cid in ("L1", "L2", "L3") for p in (1, 2)}
        warm = dict(self.data)
        warm["tkb"] = _tkb_from(lessons, fixed)
        warm["tkbSolverResult"] = {"metrics": dict(self.first.get("metrics") or {}), "unassignedLessons": []}
        second = solve_from_ui_data_v3(warm, _settings(9, seconds=10))
        after = self._assert_contract(second)
        v3 = (second.get("solver") or {}).get("engine_v3") or {}
        self.assertTrue(v3.get("warm_start"), v3)
        self.assertFalse(v3.get("warm_incomplete"), v3)
        free_after = [l for l in after if l["classId"] == "L1" and l["subject"] == "TNHN" and not (l["day"] == LOCK_DAY and l["session"] == "AM")]
        self.assertEqual(_slot(free_after[0]), _slot(free_before[0]), (free_before, free_after))


if __name__ == "__main__":
    unittest.main()
