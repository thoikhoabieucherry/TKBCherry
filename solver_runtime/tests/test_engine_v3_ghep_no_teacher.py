"""Cherry engine v3 — tiet DAY GHEP KHONG GIAO VIEN (02/09).

Chu du an: "tiet day ghep dac biet, co the co mon hoc, ghep nhieu lop nhung
khong co giao vien" — vi du sinh hoat hoi truong / tu hoc. App (web/modules/
day-ghep.js) luu dong ``gv: []``, chi chieu Tiet/Gioi han vao pccmTietMatrix /
pccmGioihanMatrix (KHONG co khoa pccmMatrix vi app.js don khoa GV rong).

Hop dong backend:
  1. adapter.build_school_data_from_ui tu them Assignment(teacher="") cho tung
     lop cua dong (so tiet tu pccmTietMatrix, thieu thi lay row.sotiet);
     "" khong nam trong SchoolData.teachers.
  2. Engine v3 xep du tiet do cho lop (chiem o lop, tranh o nghi, gioi han/buoi)
     ma khong chiem giao vien nao: hai lop co the hoc tiet khong GV cung gio,
     tiet khong GV cung gio voi tiet cua bat ky GV nao cung khong phai xung dot.
  3. Ket qua hard_ok, du tiet, teacher_slot_conflicts = 0, lesson.teacher = "".
  4. Ket qua tra ve duoc doc lai (warm-start / validate_candidate_payload) —
     tiet teacher "" khong bi coi la malformed.
"""

from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3.core import compile_problem  # noqa: E402
from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import (  # noqa: E402
    _extract_fixed_lessons_from_tkb,
    _payload_lessons_to_lessons,
    build_school_data_from_ui,
    validate_candidate_payload,
)

CLASSES = [("L%d" % i, "6/%d" % i) for i in range(1, 4)]
# (mon, so tiet, gioi han/buoi, GV)
SUBJECTS = [
    ("Toan", 4, 2, "GV_Toan"),
    ("Van", 4, 2, "GV_Van"),
    ("KHTN", 3, 2, "GV_KHTN"),
    ("Anh", 3, 2, "GV_Anh"),
    ("Su", 2, 1, "GV_Su"),
]
HALL = "Hoi truong"     # dong ghep nhieu lop, khong GV, 1 tiet
SELF = "Tu hoc"         # dong ghep 1 lop (6/1), khong GV, 2 tiet, gioi han 1


def _school() -> dict:
    teachers = sorted({gv for _s, _n, _c, gv in SUBJECTS})
    data: dict = {
        "lop": [{"id": cid, "ten": name, "khoi": "6"} for cid, name in CLASSES],
        "giaovien": [{"magv": t, "ten": t.replace("GV_", "")} for t in teachers],
        "monhoc": [{"ten": s, "ma": s.upper()} for s, _n, _c, _g in SUBJECTS],
        "mon": [{"khoi": "6", "ten": s, "sotiet": n, "gioihan": cap} for s, n, cap, _g in SUBJECTS],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "pccmGioihanMatrix": {},
        "dayGhep": [
            {
                "id": "DG001",
                "lop": [name for _cid, name in CLASSES],
                "mon": ["Anh"],
                "gv": [],
                "sotiet": "1",
                "gioihan": "1",
                "viettat": HALL,
                "ten": HALL,
            },
            {
                "id": "DG002",
                "lop": ["6/1"],
                "mon": ["Toan"],
                "gv": [],
                "sotiet": "2",
                "gioihan": "1",
                "viettat": SELF,
                "ten": SELF,
            },
        ],
        "tkbConstraints": {"fixedOff": {"class": {cid: {} for cid, _name in CLASSES}, "teacher": {}}},
        "tkb": {},
    }
    for cid, _name in CLASSES:
        for s, n, _cap, gv in SUBJECTS:
            data["pccmMatrix"][f"{cid}|{s}"] = gv
            data["pccmTietMatrix"][f"{cid}|{s}"] = n
    # app chieu Tiet/Gioi han cua dong ghep theo TEN lop (day-ghep.js dayGhepKeys)
    for _cid, name in CLASSES:
        data["pccmTietMatrix"][f"{name}|{HALL}"] = "1"
        data["pccmGioihanMatrix"][f"{name}|{HALL}"] = "1"
    data["pccmTietMatrix"][f"6/1|{SELF}"] = "2"
    data["pccmGioihanMatrix"][f"6/1|{SELF}"] = "1"
    return data


def _settings(seed: int, seconds: int = 12) -> dict:
    return {
        "engine": "cherry",
        "overall_time_limit_seconds": seconds,
        "num_workers": 1,
        "random_seed": seed,
        "require_complete_schedule": False,
        "preserve_fixed_lessons_only": True,
    }


def _slot(lesson: dict) -> tuple[int, str, int]:
    return (int(lesson["day"]), str(lesson["session"]), int(lesson["period"]))


class AdapterNoTeacherGhepTests(unittest.TestCase):
    def test_adapter_adds_teacherless_assignments(self) -> None:
        ctx = build_school_data_from_ui(_school())
        hall = [a for a in ctx.school_data.assignments if a.subject == HALL]
        self.assertEqual(sorted(a.class_name for a in hall), sorted(name for _cid, name in CLASSES))
        for a in hall:
            self.assertEqual(a.teacher, "")
            self.assertEqual(a.periods_per_week, 1)
            self.assertEqual(a.max_periods_per_session, 1)
        self_study = [a for a in ctx.school_data.assignments if a.subject == SELF]
        self.assertEqual([(a.class_name, a.teacher, a.periods_per_week, a.max_periods_per_session) for a in self_study], [("6/1", "", 2, 1)])
        self.assertNotIn("", ctx.school_data.teachers, "'' khong phai giao vien cua bai toan")
        expected = sum(a.periods_per_week for a in ctx.school_data.assignments)
        self.assertEqual(expected, 3 * 16 + 3 + 2)

    def test_periods_fall_back_to_row_when_matrix_missing(self) -> None:
        data = _school()
        del data["pccmTietMatrix"][f"6/2|{HALL}"]
        data["dayGhep"][0]["sotiet"] = "2"
        ctx = build_school_data_from_ui(data)
        by_class = {a.class_name: a.periods_per_week for a in ctx.school_data.assignments if a.subject == HALL}
        self.assertEqual(by_class, {"6/1": 1, "6/2": 2, "6/3": 1})

    def test_row_with_teacher_is_not_duplicated(self) -> None:
        data = _school()
        data["dayGhep"][1]["gv"] = ["GV_Su"]
        data["pccmMatrix"][f"6/1|{SELF}"] = "GV_Su"
        ctx = build_school_data_from_ui(data)
        rows = [(a.class_name, a.teacher) for a in ctx.school_data.assignments if a.subject == SELF]
        self.assertEqual(rows, [("6/1", "GV_Su")])

    def test_compile_problem_treats_empty_teacher_as_no_member(self) -> None:
        ctx = build_school_data_from_ui(_school())
        problem = compile_problem(ctx, ctx.rules, [])
        for ai in range(problem.num_assignments()):
            if problem.subject_names[problem.a_subject[ai]] in {HALL, SELF}:
                self.assertEqual(problem.a_teacher[ai], -1)
                self.assertEqual(problem.a_teachers[ai], ())
                self.assertEqual(problem.teacher_label(ai), "")
        self.assertNotIn("", problem.teacher_names)

    def test_payload_parser_keeps_teacherless_lessons(self) -> None:
        lessons = _payload_lessons_to_lessons(
            {"lessons": [{"className": "6/1", "subject": HALL, "teacher": "", "day": 2, "session": "AM", "period": 1}]}
        )
        self.assertEqual([(l.class_name, l.subject, l.teacher) for l in lessons], [("6/1", HALL, "")])


class EngineNoTeacherGhepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(11))

    def _assert_contract(self, payload: dict) -> None:
        metrics = payload.get("metrics") or {}
        self.assertTrue(payload.get("ok"), payload.get("validation"))
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("unassigned_periods") or 0), 0)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(int(metrics.get("teacher_slot_conflicts", -1)), 0)
        lessons = list(payload.get("lessons") or [])
        hall = [l for l in lessons if l["subject"] == HALL]
        self.assertEqual(Counter(l["className"] for l in hall), {name: 1 for _cid, name in CLASSES})
        for lesson in hall:
            self.assertEqual(str(lesson.get("teacher") or ""), "", "tiet khong GV tra ve teacher rong")
        self_study = [l for l in lessons if l["subject"] == SELF]
        self.assertEqual(len(self_study), 2)
        self.assertEqual(len({(l["day"], l["session"]) for l in self_study}), 2, "gioi han 1 tiet/buoi")
        for lesson in self_study:
            self.assertEqual(str(lesson.get("teacher") or ""), "")
        # tiet khong GV cung gio voi bat ky tiet nao cua GV that: khong phai xung dot
        by_slot: dict[tuple[int, str, int], list[dict]] = {}
        for lesson in lessons:
            by_slot.setdefault(_slot(lesson), []).append(lesson)
        for slot_lessons in by_slot.values():
            teachers = [l["teacher"] for l in slot_lessons if l.get("teacher")]
            self.assertEqual(len(teachers), len(set(teachers)), slot_lessons)

    def test_solve_places_teacherless_lessons(self) -> None:
        self._assert_contract(self.first)

    def test_result_revalidates_and_warm_starts(self) -> None:
        # validate_candidate_payload: tiet teacher "" khong phai malformed
        check = validate_candidate_payload(self.data, self.first)
        self.assertEqual(check.get("malformed_lesson_count"), 0, check)
        self.assertTrue(check.get("ok"), check)
        # stored result -> exact fixed lessons (warm-start) giu du tiet khong GV
        data = dict(self.data)
        data["tkbSolverResult"] = {"ok": True, "lessons": list(self.first["lessons"])}
        ctx = build_school_data_from_ui(data)
        fixed, _warnings = _extract_fixed_lessons_from_tkb(data, ctx)
        expected = sum(a.periods_per_week for a in ctx.school_data.assignments)
        self.assertEqual(len(fixed), expected)
        self.assertEqual(sum(1 for l in fixed if l.subject == HALL and l.teacher == ""), 3)

    def test_pinned_joint_cells_without_teacher_are_kept(self) -> None:
        # Planner ghim tam tiet chung (fixed) truoc khi giai: o co dinh khong GV
        # phai duoc giu nguyen o moi lop, khong bi coi la trung GV.
        data = _school()
        for cid, _name in CLASSES:
            data["tkb"][cid] = {
                "thu2": {"sang": [{"mon": HALL, "fixed": True}, "", "", "", ""], "chieu": ["", "", "", "", ""]}
            }
        payload = solve_from_ui_data_v3(data, _settings(12))
        self._assert_contract(payload)
        hall = [l for l in payload["lessons"] if l["subject"] == HALL]
        self.assertEqual({_slot(l) for l in hall}, {(2, "AM", 1)}, "moi lop giu o co dinh thu 2 tiet 1")


if __name__ == "__main__":
    unittest.main()
