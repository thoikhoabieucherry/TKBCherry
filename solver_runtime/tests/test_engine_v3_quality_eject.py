"""Cherry engine v3 — "KHONG rot tiet ra Chua phan" (22/08 khuya, chi dao chu
du an: "nut Cherry khi xep cung khong duoc rot tiet ra Chua phan; cac nut toi
uu khi da xep du thi hoan doi").

Hop dong:
  1. Lich du thi van du sau moi luot (khong co tiet nao bi dua ra vi chat
     luong GV); `quality_ejected` = 0, khong item `teacher_quality_unreachable`.
  2. Buoi 1 tiet / trong >= 2 KHONG go duoc duoc BAO trong
     `solver.engine_v3.quality_unavoidable` (why="kept") kem goi y co dau.
  3. Bam lai (warm-start, ke ca khi du lieu cu con tiet "da dua ra" trong
     tkbSolverResult) -> khong xau hon, van du tiet.
  4. O co dinh khong bao gio bi dong.

Truong tong hop nho, thuan Python, khong can OR-Tools.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3.entry import QUALITY_EJECT_REASON, solve_from_ui_data_v3  # noqa: E402

SUBJECTS = [
    ("Toan", 4, 2),
    ("Van", 4, 2),
    ("Anh", 3, 2),
    ("Su", 2, 1),
    ("Dia", 2, 1),
    ("GDCD", 1, 1),
]
CLASSES = [("L%d" % i, "6/%d" % i) for i in range(1, 7)]


def _school(*, lone_teacher: bool = True) -> dict:
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
    }
    for cid, _name in CLASSES:
        for s, n, _cap in SUBJECTS:
            data["pccmMatrix"][f"{cid}|{s}"] = "GV_" + s
            data["pccmTietMatrix"][f"{cid}|{s}"] = n
    if lone_teacher:
        # GV_TIN chi day 1 tiet/tuan (Tin hoc lop L1) -> chac chan co 1 buoi
        # 1 tiet (san cau truc) -> phai duoc BAO kem goi y, khong bi dua ra.
        data["giaovien"].append({"magv": "GV_TIN", "ten": "GV Tin"})
        data["monhoc"].append({"ten": "Tin", "ma": "TI"})
        data["mon"].append({"khoi": "6", "ten": "Tin", "sotiet": 1, "gioihan": 1})
        data["pccmMatrix"]["L1|Tin"] = "GV_TIN"
        data["pccmTietMatrix"]["L1|Tin"] = 1
    return data


def _settings(seed: int, seconds: int = 14) -> dict:
    return {
        "engine": "cherry",
        "overall_time_limit_seconds": seconds,
        "num_workers": 1,
        "random_seed": seed,
        "require_complete_schedule": False,
    }


def _v3(payload: dict) -> dict:
    return (payload.get("solver") or {}).get("engine_v3") or {}


def _quality_items(payload: dict) -> list[dict]:
    return [
        item for item in (payload.get("unassignedLessons") or [])
        if str(item.get("reason") or "") == QUALITY_EJECT_REASON
    ]


def _tkb_from_lessons(lessons: list[dict]) -> dict:
    """Luoi `tkb` dung dang UI (bridge luon gui kem cho luot Cherry)."""

    tkb: dict = {}
    for lesson in lessons:
        cid = str(lesson["classId"])
        day = f"thu{int(lesson['day'])}"
        part = "sang" if lesson["session"] == "AM" else "chieu"
        grid = tkb.setdefault(cid, {})
        row = grid.setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
        row[part][int(lesson["period"]) - 1] = lesson["subject"]
    return tkb


class EngineV3SwapOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(7))

    def test_complete_schedule_stays_complete_and_reports_structural_singleton(self) -> None:
        payload = self.first
        metrics = payload.get("metrics") or {}
        v3 = _v3(payload)
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertTrue(payload.get("ok"), payload.get("validation"))
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(int(metrics.get("unassigned_periods") or 0), 0)
        self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)
        self.assertEqual(_quality_items(payload), [])
        self.assertEqual(int(v3.get("quality_ejected") or 0), 0)
        self.assertEqual((v3.get("quality_eject_skipped") or {}).get("disabled"), "swap_only")
        # GV_TIN (1 tiet/tuan) -> van nam tren luoi, duoc BAO kem goi y
        self.assertEqual(int((v3.get("objective") or [0])[0]), 1)
        self.assertEqual(int(v3.get("one_period_sessions") or 0), 1)
        self.assertEqual(int(metrics.get("one_period_teacher_sessions") or 0), 1)
        kept = [u for u in (v3.get("quality_unavoidable") or []) if u.get("teacher") == "GV_TIN"]
        self.assertEqual(len(kept), 1, v3.get("quality_unavoidable"))
        self.assertEqual(kept[0].get("why"), "kept")
        self.assertEqual(kept[0].get("kind"), "one_period")
        self.assertIn("1 tiết/tuần", str(kept[0].get("why_label") or ""))
        self.assertIn("Gợi ý", str(kept[0].get("why_label") or ""))
        tin = [l for l in payload.get("lessons") or [] if l.get("teacher") == "GV_TIN"]
        self.assertEqual(len(tin), 1)
        # vi tri bao cao khop voi luoi cuoi cung
        self.assertEqual((kept[0].get("day"), kept[0].get("session")), (tin[0]["day"], tin[0]["session"]))

    def test_second_click_never_gets_worse_and_stays_complete(self) -> None:
        first = self.first
        warm = dict(self.data)
        warm["tkb"] = _tkb_from_lessons(list(first.get("lessons") or []))
        warm["tkbSolverResult"] = {"metrics": dict(first.get("metrics") or {}), "unassignedLessons": []}
        second = solve_from_ui_data_v3(warm, _settings(11, seconds=12))
        v3 = _v3(second)
        self.assertTrue(v3.get("warm_start"), v3)
        metrics = second.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(_quality_items(second), [])
        obj_first = tuple(int(x) for x in (_v3(first).get("objective") or [0, 0, 0, 0])[:4])
        obj_second = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        self.assertLessEqual(obj_second[:2], obj_first[:2])
        self.assertLessEqual(obj_second, obj_first)

    def test_legacy_ejected_lesson_in_store_gets_placed_back(self) -> None:
        # Du lieu cu (truoc 22/08 khuya) co the con 1 tiet trong Chua phan voi
        # ma ly do teacher_quality_unreachable: luot moi phai xep lai, khong
        # bao gio giu no ngoai luoi.
        first = self.first
        lessons = [l for l in (first.get("lessons") or []) if l.get("teacher") != "GV_TIN"]
        warm = dict(self.data)
        warm["tkb"] = _tkb_from_lessons(lessons)
        warm["tkbSolverResult"] = {
            "unassignedLessons": [{
                "classId": "L1", "className": "6/1", "subject": "Tin", "teacher": "GV_TIN",
                "periods": 1, "reason": QUALITY_EJECT_REASON, "message": "cu", "kind": "one_period",
            }],
        }
        payload = solve_from_ui_data_v3(warm, _settings(13, seconds=12))
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(_quality_items(payload), [])
        self.assertEqual(int(_v3(payload).get("quality_ejected") or 0), 0)

    def test_fixed_cell_is_never_moved(self) -> None:
        data = _school()
        data["tkb"] = {"L1": {"thu2": {"sang": [{"mon": "Tin", "fixed": True}, "", "", "", ""], "chieu": ["", "", "", "", ""]}}}
        payload = solve_from_ui_data_v3(
            data, dict(_settings(5), preserve_fixed_lessons_only=True)
        )
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(_quality_items(payload), [])
        fixed = [l for l in payload.get("lessons") or [] if l.get("teacher") == "GV_TIN"]
        self.assertEqual(len(fixed), 1)
        self.assertEqual((fixed[0]["day"], fixed[0]["session"], fixed[0]["period"]), (2, "AM", 1))

    def test_school_without_debt_reports_nothing(self) -> None:
        payload = solve_from_ui_data_v3(_school(lone_teacher=False), _settings(3))
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(_quality_items(payload), [])
        v3 = _v3(payload)
        self.assertEqual(int(v3.get("quality_ejected") or 0), 0)
        if int(v3.get("one_period_teacher_sessions") or 0) == 0 and int(v3.get("gap2_sessions") or 0) == 0:
            self.assertEqual(list(v3.get("quality_unavoidable") or []), [])


if __name__ == "__main__":
    unittest.main()
