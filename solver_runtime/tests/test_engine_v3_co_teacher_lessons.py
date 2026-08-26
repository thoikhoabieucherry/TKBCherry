"""Cherry engine v3 — tiet DAY GHEP (1 mon, 1 lop, 2 giao vien) (25/08).

Truong that (sid obo2ow4q6d1): mon ghep cua lop duoc phan cong "TN.Tram,
HT.Van"; engine coi ca chuoi la MOT giao vien moi nen:
  * TN.Tram bi xep KHTN dung gio tiet ghep (thu 6 tiet 1 sang) — trung tiet;
  * o nghi co dinh cua tung nguoi khong duoc ton trong khi xep tiet ghep.

Hop dong moi:
  1. Tiet ghep nam tren TKB cua CA HAI giao vien: khong ai trong hai nguoi
     duoc xep tiet khac cung gio (ca khi xep moi lan warm-start).
  2. Tiet ghep khong roi vao o nghi co dinh cua BAT KY giao vien thanh vien.
  3. Ket qua van du tiet, hard_ok, teacher_slot_conflicts = 0, va nhan GV cua
     tiet ghep tra ve dung "MA1, MA2" nhu phan cong.
"""

from __future__ import annotations

import sys
import unittest
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402
from tkb_new.adapter import _canonical_teacher_value, build_school_data_from_ui  # noqa: E402
from tkb_optimizer_ref.rules import TimetableConstraintRules, teacher_members  # noqa: E402

CLASSES = [("L%d" % i, "6/%d" % i) for i in range(1, 5)]
CO_TEACHER = "GV_TNT, GV_HTV"
# (mon, so tiet, gioi han/buoi, GV)
SUBJECTS = [
    ("Toan", 4, 2, "GV_Toan"),
    ("Van", 4, 2, "GV_HTV"),
    ("KHTN", 3, 2, "GV_TNT"),
    ("Anh", 3, 2, "GV_Anh"),
    ("Su", 2, 1, "GV_Su"),
]


def _school() -> dict:
    teachers = sorted({gv for _s, _n, _c, gv in SUBJECTS} | {"GV_TNT", "GV_HTV"})
    data: dict = {
        "lop": [{"id": cid, "ten": name, "khoi": "6"} for cid, name in CLASSES],
        "giaovien": [{"magv": t, "ten": t.replace("GV_", "")} for t in teachers],
        "monhoc": [{"ten": s, "ma": s.upper()} for s, _n, _c, _g in SUBJECTS] + [{"ten": "TNHN", "ma": "TNHN"}],
        "mon": [{"khoi": "6", "ten": s, "sotiet": n, "gioihan": cap} for s, n, cap, _g in SUBJECTS]
        + [{"khoi": "6", "ten": "TNHN", "sotiet": 2, "gioihan": 2}],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "tkbConstraints": {
            "fixedOff": {
                "class": {cid: {} for cid, _name in CLASSES},
                "teacher": {
                    # HT.Van nghi ca sang thu 2, TN.Tram nghi ca chieu thu 3
                    "GV_HTV": {f"thu2|sang|{p}": True for p in range(5)},
                    "GV_TNT": {f"thu3|chieu|{p}": True for p in range(5)},
                },
            },
        },
        "tkb": {},
    }
    for cid, _name in CLASSES:
        for s, n, _cap, gv in SUBJECTS:
            data["pccmMatrix"][f"{cid}|{s}"] = gv
            data["pccmTietMatrix"][f"{cid}|{s}"] = n
    # Mon ghep chi o lop 6/1: hai GV cung day 2 tiet/tuan.
    data["pccmMatrix"]["L1|TNHN"] = CO_TEACHER
    data["pccmTietMatrix"]["L1|TNHN"] = 2
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


class TeacherMembersTests(unittest.TestCase):
    def test_split_formats(self) -> None:
        self.assertEqual(teacher_members("GV1, GV2"), ("GV1", "GV2"))
        self.assertEqual(teacher_members("GV1;GV2+GV3\nGV1"), ("GV1", "GV2", "GV3"))
        self.assertEqual(teacher_members("GV1"), ("GV1",))
        self.assertEqual(teacher_members(""), ())
        self.assertEqual(teacher_members(None), ())

    def test_fixed_off_applies_to_any_member(self) -> None:
        rules = TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={"teacher": {"GV2": frozenset({(2, "AM", 1)})}, "class": {}, "subject": {}, "room": {}, "subjectGroup": {}},
            teacher={},
            subject={},
            subject_group={},
        )
        self.assertTrue(rules.is_fixed_off("teacher", "GV2", 2, "AM", 1))
        self.assertTrue(rules.is_fixed_off("teacher", "GV1, GV2", 2, "AM", 1))
        self.assertFalse(rules.is_fixed_off("teacher", "GV1, GV2", 2, "AM", 2))
        self.assertFalse(rules.is_fixed_off("teacher", "GV1", 2, "AM", 1))

    def test_canonical_value_maps_each_member(self) -> None:
        lookup = {"tram": "TN.Tram", "tn.tram": "TN.Tram", "van": "HT.Van", "ht.van": "HT.Van"}
        self.assertEqual(_canonical_teacher_value("Tram, Van", lookup), "TN.Tram, HT.Van")
        self.assertEqual(_canonical_teacher_value("TN.Tram", lookup), "TN.Tram")
        self.assertEqual(_canonical_teacher_value("", lookup), "")

    def test_adapter_keeps_co_teacher_assignment(self) -> None:
        ctx = build_school_data_from_ui(_school())
        co = [a for a in ctx.school_data.assignments if a.subject == "TNHN"]
        self.assertEqual(len(co), 1)
        self.assertEqual(co[0].teacher, CO_TEACHER)
        self.assertEqual(co[0].periods_per_week, 2)


class CoTeacherLessonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(7))

    def _assert_contract(self, payload: dict) -> None:
        metrics = payload.get("metrics") or {}
        self.assertTrue(payload.get("ok"), payload.get("validation"))
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("unassigned_periods") or 0), 0)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(int(metrics.get("teacher_slot_conflicts", -1)), 0)
        lessons = list(payload.get("lessons") or [])
        co = [l for l in lessons if l["subject"] == "TNHN"]
        # 3. nhan GV cua tiet ghep giu nguyen "MA1, MA2"
        self.assertEqual(len(co), 2, co)
        self.assertEqual({l["teacher"] for l in co}, {CO_TEACHER})
        # 1. khong GV thanh vien nao co tiet khac cung gio tiet ghep
        by_member_slot: dict[tuple[str, int, str, int], list[dict]] = defaultdict(list)
        for lesson in lessons:
            for member in teacher_members(lesson["teacher"]):
                by_member_slot[(member, *_slot(lesson))].append(lesson)
        clashes = {key: v for key, v in by_member_slot.items() if len(v) > 1}
        self.assertEqual(clashes, {}, clashes)
        # 2. tiet ghep tranh o nghi cua CA HAI giao vien
        for lesson in co:
            day, session, _period = _slot(lesson)
            self.assertFalse(day == 2 and session == "AM", f"HT.Van nghi sang thu 2: {lesson}")
            self.assertFalse(day == 3 and session == "PM", f"TN.Tram nghi chieu thu 3: {lesson}")
        # o nghi cua tung GV van dung cho tiet rieng cua ho
        for lesson in lessons:
            members = teacher_members(lesson["teacher"])
            day, session, _period = _slot(lesson)
            if "GV_HTV" in members:
                self.assertFalse(day == 2 and session == "AM", lesson)
            if "GV_TNT" in members:
                self.assertFalse(day == 3 and session == "PM", lesson)

    def test_fresh_solve_respects_both_teachers(self) -> None:
        self._assert_contract(self.first)

    def test_warm_start_keeps_contract(self) -> None:
        warm = dict(self.data)
        tkb: dict = {}
        for lesson in self.first.get("lessons") or []:
            cid = str(lesson["classId"])
            day = f"thu{int(lesson['day'])}"
            part = "sang" if lesson["session"] == "AM" else "chieu"
            grid = tkb.setdefault(cid, {})
            row = grid.setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
            row[part][int(lesson["period"]) - 1] = lesson["subject"]
        warm["tkb"] = tkb
        warm["tkbSolverResult"] = {"metrics": dict(self.first.get("metrics") or {}), "unassignedLessons": []}
        second = solve_from_ui_data_v3(warm, _settings(11, seconds=10))
        self._assert_contract(second)

    def test_existing_clash_is_repaired_not_kept(self) -> None:
        """Lich cu co KHTN cua TN.Tram trung gio tiet ghep (loi truong that):
        engine phai sua, khong duoc giu nguyen va bao hard_ok."""

        data = _school()
        tkb: dict = {}
        for lesson in self.first.get("lessons") or []:
            cid = str(lesson["classId"])
            day = f"thu{int(lesson['day'])}"
            part = "sang" if lesson["session"] == "AM" else "chieu"
            grid = tkb.setdefault(cid, {})
            row = grid.setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
            row[part][int(lesson["period"]) - 1] = lesson["subject"]
        # ep mot xung dot: dat KHTN cua lop 6/2 vao dung o tiet ghep dau tien
        co = sorted((l for l in self.first["lessons"] if l["subject"] == "TNHN"), key=_slot)[0]
        day = f"thu{int(co['day'])}"
        part = "sang" if co["session"] == "AM" else "chieu"
        p = int(co["period"]) - 1
        l2 = tkb["L2"]
        # bo mot KHTN o cho khac cua 6/2 roi dat vao o trung gio
        moved = False
        for d, sessions in l2.items():
            for s, cells in sessions.items():
                for i, v in enumerate(cells):
                    if v == "KHTN" and not moved and not (d == day and s == part and i == p):
                        cells[i] = ""
                        moved = True
        self.assertTrue(moved)
        l2.setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
        l2[day][part][p] = "KHTN"
        data["tkb"] = tkb
        result = solve_from_ui_data_v3(data, _settings(5, seconds=10))
        self._assert_contract(result)
        counted = Counter(l["subject"] for l in result["lessons"] if l["classId"] == "L2")
        self.assertEqual(counted["KHTN"], 3)


if __name__ == "__main__":
    unittest.main()
