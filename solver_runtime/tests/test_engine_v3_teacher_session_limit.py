"""13/09/2026 (chu du an: "gioi han buoi day khi bam Cherry phai tuan thu chu").

Luat GV "Gioi han buoi day" (tkbConstraints.teacher[GV].oneSessionPerDay[thu]),
giao dien moi luu 2 o moi ngay:
  {morning: true,  afternoon: false} -> chi day buoi sang
  {morning: false, afternoon: true}  -> chi day buoi chieu
  {morning: true,  afternoon: true}  -> sang HOAC chieu (khong ca hai)
  bo ca hai                          -> tu do

Truoc day bo doc luat Python doc "ca hai o" thanh "chi sang", va "chi sang/chi
chieu" chi la phat mem khi dung lich moi -> Cherry con de GV day ca buoi bi cam.
Nay "chi sang/chi chieu" duoc dua thang vao mat na ranh GV (core.compile_problem).
"""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import time  # noqa: E402

from tkb_engine_v3 import construct  # noqa: E402
from tkb_engine_v3.core import PERIODS, compile_problem, slot_of  # noqa: E402
from tkb_engine_v3.entry import _context_with_fixed_demand, solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import build_school_data_from_ui  # noqa: E402

from test_engine_v3_quality_eject import _school, _settings  # noqa: E402

RULE = {
    "thu2": {"morning": True, "afternoon": False},
    "thu3": {"morning": False, "afternoon": True},
    "thu4": {"morning": True, "afternoon": True},
    "thu5": {"morning": False, "afternoon": False},
}


def _data() -> dict:
    data = _school(lone_teacher=False)
    data["tkbConstraints"]["teacher"] = {"GV_Toan": {"oneSessionPerDay": copy.deepcopy(RULE)}}
    return data


class CompileTests(unittest.TestCase):
    def test_morning_or_afternoon_only_bans_the_other_session(self) -> None:
        data = _data()
        ctx = build_school_data_from_ui(data)
        P = compile_problem(_context_with_fixed_demand(ctx, ctx, []), ctx.rules, [])
        t = P.teacher_names.index("GV_Toan")
        avail = P.teacher_avail[t]
        rule = P.teacher_rules[t]
        self.assertIsNotNone(rule)
        self.assertEqual(rule.session_mode[:4], ("morning", "afternoon", "either", ""))
        for p in range(PERIODS):
            self.assertEqual(avail[slot_of(0, 1, p)], 0, "thu2 chi sang -> cam chieu")
            self.assertEqual(avail[slot_of(1, 0, p)], 0, "thu3 chi chieu -> cam sang")
            self.assertEqual(avail[slot_of(2, 0, p)], 1, "thu4 sang hoac chieu -> khong cam truoc")
            self.assertEqual(avail[slot_of(2, 1, p)], 1)
            self.assertEqual(avail[slot_of(3, 0, p)], 1, "thu5 bo ca hai -> tu do")
            self.assertEqual(avail[slot_of(3, 1, p)], 1)
        other = P.teacher_names.index("GV_Van")
        self.assertEqual(sum(P.teacher_avail[other]), sum(1 for _ in P.teacher_avail[other]))


class SolveTests(unittest.TestCase):
    def test_cherry_respects_session_limit(self) -> None:
        for seed in (3, 11):
            with self.subTest(seed=seed):
                result = solve_from_ui_data_v3(_data(), _settings(seed, seconds=10))
                metrics = result.get("metrics") or {}
                self.assertEqual(metrics.get("scheduled_periods"), metrics.get("expected_periods"), metrics)
                sessions: dict[int, set[str]] = {}
                for lesson in result.get("lessons") or []:
                    if "GV_Toan" in str(lesson.get("teacher") or ""):
                        sessions.setdefault(int(lesson["day"]), set()).add(lesson["session"])
                self.assertNotIn("PM", sessions.get(2, set()), sessions)
                self.assertNotIn("AM", sessions.get(3, set()), sessions)
                self.assertLess(len(sessions.get(4, set())), 2, sessions)

    def test_fixed_cell_in_banned_session_is_kept_and_rest_obeys(self) -> None:
        """Nguoi dung tu dat mau thuan: GV_Toan "chi sang" thu 2 nhung co tiet Toan
        CO DINH chieu thu 2 lop L1 -> giu o co dinh, moi tiet khac van chi sang."""

        data = _data()
        blank = ["", "", "", "", ""]
        data["tkb"] = {
            "L1": {"thu2": {"sang": list(blank), "chieu": [{"fixed": True, "mon": "Toan"}, "", "", "", ""]}},
        }
        settings = dict(_settings(5, seconds=10), preserve_fixed_lessons_only=True)
        result = solve_from_ui_data_v3(data, settings)
        metrics = result.get("metrics") or {}
        self.assertEqual(metrics.get("scheduled_periods"), metrics.get("expected_periods"), metrics)
        pm_thu2 = [
            (lesson["className"], int(lesson["period"]))
            for lesson in result.get("lessons") or []
            if "GV_Toan" in str(lesson.get("teacher") or "") and int(lesson["day"]) == 2 and lesson["session"] == "PM"
        ]
        self.assertEqual(pm_thu2, [("6/1", 1)])

        ctx = build_school_data_from_ui(data)
        from tkb_new.adapter import _extract_hard_fixed_lessons_from_tkb

        fixed, _warn = _extract_hard_fixed_lessons_from_tkb(data, ctx)
        self.assertTrue(fixed)
        P = compile_problem(_context_with_fixed_demand(ctx, ctx, fixed), ctx.rules, fixed)
        t = P.teacher_names.index("GV_Toan")
        self.assertEqual(P.teacher_avail[t][slot_of(0, 1, 0)], 1, "o co dinh cua GV duoc giu")
        self.assertEqual(sum(P.teacher_avail[t][slot_of(0, 1, p)] for p in range(1, PERIODS)), 0)
        self.assertEqual(P.teacher_rules[t].session_mode[0], "", "bo luat ngay mau thuan (mat na da cam)")
        self.assertEqual(P.teacher_rules[t].session_mode[1], "afternoon")


class EjectDebtTests(unittest.TestCase):
    def test_unfixed_session_debt_is_ejected_or_resettled_cleanly(self) -> None:
        """Luoi du tiet con no "sang hoac chieu": _eject_session_debt go tiet o buoi
        vi pham, xep lai cho hop le -> het no, qua kiem tra cung; so tiet con o Chua
        phan = gia tri tra ve."""

        free = _school(lone_teacher=False)
        first = solve_from_ui_data_v3(free, _settings(9, seconds=8))
        lessons = list(first.get("lessons") or [])
        both_days = sorted(
            {
                int(l["day"])
                for l in lessons
                if "GV_Toan" in str(l.get("teacher") or "") and l["session"] == "AM"
            }
            & {
                int(l["day"])
                for l in lessons
                if "GV_Toan" in str(l.get("teacher") or "") and l["session"] == "PM"
            }
        )
        if not both_days:
            self.skipTest("lich mau khong co ngay GV_Toan day ca hai buoi")
        data = _school(lone_teacher=False)
        data["tkbConstraints"]["teacher"] = {
            "GV_Toan": {"oneSessionPerDay": {"thu%d" % both_days[0]: {"morning": True, "afternoon": True}}}
        }
        ctx = build_school_data_from_ui(data)
        P = compile_problem(_context_with_fixed_demand(ctx, ctx, []), ctx.rules, [])
        con = construct.Constructor(P, seed=3)
        soft = construct.SoftSchedule(P)
        class_index = {name: i for i, name in enumerate(P.class_names)}
        by_key = {}
        for ai in range(P.num_assignments()):
            by_key.setdefault((P.a_class[ai], P.subject_names[P.a_subject[ai]]), ai)
        for lesson in lessons:
            c = class_index[lesson["className"]]
            slot = ((int(lesson["day"]) - 2) * 2 + (0 if lesson["session"] == "AM" else 1)) * PERIODS + int(lesson["period"]) - 1
            soft.set_cell(c, slot, by_key[(c, lesson["subject"])])
        for t in con._has_rule_teachers:
            soft.refresh_rule_pen(t)
        expected = sum(P.a_periods)
        self.assertEqual(sum(1 for row in soft.grid for v in row if v >= 0), expected)
        self.assertGreater(soft.penalty(), 0)
        con._last_load_fail = ""
        left = con._eject_session_debt(soft, time.monotonic() + 30)
        self.assertEqual(soft.penalty(), 0)
        self.assertIsNotNone(con._load_state(soft), con._last_load_fail)
        self.assertEqual(sum(1 for row in soft.grid for v in row if v >= 0), expected - left)


if __name__ == "__main__":
    unittest.main()
