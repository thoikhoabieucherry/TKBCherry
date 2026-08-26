"""Cherry engine v3 — o co dinh TRUNG GIAO VIEN giua nhieu lop (23/08).

Truong that (sid v2mjxf2tbt1): 31 lop deu co TNHN co dinh thu 2 tiet 1-2,
nhung phan cong chi co 9 GV TNHN -> cung mot GV "day" 2..12 lop cung luc
(sinh hoat duoi co / hoat dong toan truong). Giao dien (nut ▶, bo kiem tra
rang buoc) chap nhan dieu nay. Engine truoc day "mo khoa" cac o trung GV
(giu 1 lop/GV), xep mon khac vao 44 o con lai -> khi ap vao giao dien 44 tiet
bi bo (o co dinh mon khac) -> "862/906" va nghiem bi tu choi.

Hop dong moi:
  1. MOI o co dinh deu giu nguyen (ke ca khi trung GV voi lop khac).
  2. GV do KHONG duoc xep tiet nao khac vao cung gio.
  3. Ket qua van hard_ok/ok (xung dot GV nam tron trong o co dinh cua nguoi
     dung khong tinh la loi), du tiet, khong rot tiet.
  4. Bam lai (warm-start) van giu nguyen.
"""

from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402

SUBJECTS = [
    ("Toan", 4, 2),
    ("Van", 4, 2),
    ("Anh", 3, 2),
    ("Su", 2, 1),
    ("Dia", 2, 1),
    ("GDCD", 1, 1),
    ("SH", 2, 2),
]
CLASSES = [("L%d" % i, "6/%d" % i) for i in range(1, 7)]
SHARED_TEACHER = "GV_SH"


def _school() -> dict:
    data: dict = {
        "lop": [{"id": cid, "ten": name, "khoi": "6"} for cid, name in CLASSES],
        "giaovien": [{"magv": "GV_" + s, "ten": "GV " + s} for s, _n, _cap in SUBJECTS],
        "monhoc": [{"ten": s, "ma": s[:2].upper()} for s, _n, _cap in SUBJECTS],
        "mon": [{"khoi": "6", "ten": s, "sotiet": n, "gioihan": cap} for s, n, cap in SUBJECTS],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "tkbConstraints": {
            "fixedOff": {"class": {cid: {} for cid, _name in CLASSES}},
            "subject": {
                s: {"byClass": {cid: {"lessonBlocks": {"2": {"min": 1, "max": 0}}} for cid, _n in CLASSES}}
                for s in ("Toan", "Van")
            },
        },
        "tkb": {},
    }
    for cid, _name in CLASSES:
        for s, n, _cap in SUBJECTS:
            data["pccmMatrix"][f"{cid}|{s}"] = "GV_" + s
            data["pccmTietMatrix"][f"{cid}|{s}"] = n
        # SH (sinh hoat) co dinh thu 2 tiet 1-2 o MOI lop, cung mot GV.
        data["tkb"][cid] = {
            "thu2": {
                "sang": [{"mon": "SH", "fixed": True}, {"mon": "SH", "fixed": True}, "", "", ""],
                "chieu": ["", "", "", "", ""],
            }
        }
    return data


def _settings(seed: int, seconds: int = 14) -> dict:
    return {
        "engine": "cherry",
        "overall_time_limit_seconds": seconds,
        "num_workers": 1,
        "random_seed": seed,
        "require_complete_schedule": False,
        "preserve_fixed_lessons_only": True,
    }


def _tkb_from_lessons(lessons: list[dict], fixed_cells: set[tuple[str, int, str, int]]) -> dict:
    tkb: dict = {}
    for lesson in lessons:
        cid = str(lesson["classId"])
        day = f"thu{int(lesson['day'])}"
        part = "sang" if lesson["session"] == "AM" else "chieu"
        grid = tkb.setdefault(cid, {})
        row = grid.setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
        key = (cid, int(lesson["day"]), str(lesson["session"]), int(lesson["period"]))
        if key in fixed_cells:
            row[part][int(lesson["period"]) - 1] = {"mon": lesson["subject"], "fixed": True}
        else:
            row[part][int(lesson["period"]) - 1] = lesson["subject"]
    return tkb


class SharedFixedTeacherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(7))

    def _assert_contract(self, payload: dict) -> None:
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertTrue(metrics.get("core_hard_ok"), metrics)
        self.assertTrue(payload.get("ok"), payload.get("validation"))
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(int(metrics.get("unassigned_periods") or 0), 0)
        self.assertEqual(int(metrics.get("teacher_slot_conflicts", -1)), 0)
        lessons = list(payload.get("lessons") or [])
        # 1. moi o co dinh deu giu nguyen: SH thu 2 tiet 1-2 o ca 6 lop
        for cid, name in CLASSES:
            at_fixed = sorted(
                (l["period"], l["subject"], l["teacher"])
                for l in lessons
                if l["classId"] == cid and l["day"] == 2 and l["session"] == "AM" and l["period"] in (1, 2)
            )
            self.assertEqual(
                at_fixed,
                [(1, "SH", SHARED_TEACHER), (2, "SH", SHARED_TEACHER)],
                f"{name}: {at_fixed}",
            )
        # 2. GV_SH khong co tiet nao khac vao thu 2 tiet 1-2 (chi cac o co dinh)
        shared = [l for l in lessons if l["teacher"] == SHARED_TEACHER]
        by_slot = Counter((l["day"], l["session"], l["period"]) for l in shared)
        self.assertEqual(by_slot[(2, "AM", 1)], len(CLASSES))
        self.assertEqual(by_slot[(2, "AM", 2)], len(CLASSES))
        # SH chi co 2 tiet/tuan/lop = dung 2 o co dinh -> khong con tiet nao khac
        self.assertEqual(len(shared), 2 * len(CLASSES))
        # khong GV nao khac bi xep trung gio voi chinh minh
        others = Counter((l["teacher"], l["day"], l["session"], l["period"]) for l in lessons if l["teacher"] != SHARED_TEACHER)
        self.assertEqual([k for k, v in others.items() if v > 1], [])

    def test_all_shared_fixed_cells_are_kept(self) -> None:
        self._assert_contract(self.first)

    def test_warm_start_keeps_shared_fixed_cells(self) -> None:
        fixed_cells = {(cid, 2, "AM", p) for cid, _n in CLASSES for p in (1, 2)}
        warm = dict(self.data)
        warm["tkb"] = _tkb_from_lessons(list(self.first.get("lessons") or []), fixed_cells)
        warm["tkbSolverResult"] = {"metrics": dict(self.first.get("metrics") or {}), "unassignedLessons": []}
        second = solve_from_ui_data_v3(warm, _settings(11, seconds=12))
        self._assert_contract(second)
        v3 = (second.get("solver") or {}).get("engine_v3") or {}
        self.assertTrue(v3.get("warm_start"), v3)


if __name__ == "__main__":
    unittest.main()
