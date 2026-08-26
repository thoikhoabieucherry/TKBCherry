"""Cherry engine v3 — toi uu giao vien theo BAC co KHOA (22/08).

Hop dong (chi dao chu du an):
  1. "Buoi GV 1 tiet" duoc giam ve thap nhat TRUOC, roi KHOA (khong duoc tang);
  2. "Buoi GV trong >= 2" giam ve thap nhat, roi KHOA;
  3. Phan con lai (tong buoi day, trong 1 tiet) giam tiep ma khong pha khoa.
  4. Lich DA DU dua vao (warm-start) -> ket qua khong bao gio xau hon lich do
     theo thu tu (1 tiet/buoi, trong >=2, buoi day, trong 1).

Cac test nay chay engine that (thuan Python, 1 luong, ngan sach ngan) tren
mot truong nho tong hop; khong can OR-Tools, khong cham mang.
"""

from __future__ import annotations

import sys
import unittest
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
]
CLASSES = [("L%d" % i, "6/%d" % i) for i in range(1, 7)]


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
            # moi lop: Toan va Van phai co it nhat 1 cap tiet doi (2 tiet lien)
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
    return data


def _settings(seed: int) -> dict:
    return {
        "engine": "cherry",
        "overall_time_limit_seconds": 12,
        "num_workers": 1,
        "random_seed": seed,
        "require_complete_schedule": False,
    }


def _objective(payload: dict) -> tuple[int, int, int, int]:
    obj = list((payload.get("solver") or {}).get("engine_v3", {}).get("objective") or [])
    return tuple(int(x) for x in obj[:4])


class EngineV3StagedLocksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(7))

    def test_fresh_solve_is_complete_and_reports_stages_and_locks(self) -> None:
        payload = self.first
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)
        v3 = (payload.get("solver") or {}).get("engine_v3") or {}
        stages = v3.get("stages")
        self.assertIsInstance(stages, list)
        self.assertGreaterEqual(len(stages), 1)
        for entry in stages:
            self.assertIn(entry["stage"], (1, 2, 3))
            self.assertIn("exit", entry)
            self.assertEqual(len(entry["quality"]), 4)
        # Bac chi di len (1 -> 2 -> 3), khong bao gio quay lai.
        order = [entry["stage"] for entry in stages]
        self.assertEqual(order, sorted(order))
        # Chi so da khoa khong tang qua cac bac.
        singles = [entry["quality"][0] for entry in stages]
        self.assertEqual(singles, sorted(singles, reverse=True))
        locks = v3.get("locks") or {}
        objective = _objective(payload)
        if locks.get("one_period") is not None:
            self.assertLessEqual(objective[0], int(locks["one_period"]))
        if locks.get("gap2") is not None:
            self.assertLessEqual(objective[1], int(locks["gap2"]))

    def test_warm_start_on_complete_schedule_never_gets_worse(self) -> None:
        before = _objective(self.first)
        warm = dict(self.data)
        # Bridge gui lai lich dang co qua tkbSolverResult.lessons (dung so tiet)
        warm["tkbSolverResult"] = {"lessons": list(self.first.get("lessons") or [])}
        second = solve_from_ui_data_v3(warm, _settings(11))
        v3 = (second.get("solver") or {}).get("engine_v3") or {}
        self.assertTrue(v3.get("warm_start"), v3)
        after = _objective(second)
        self.assertLessEqual(after[:2], before[:2])
        self.assertLessEqual(after, before)
        locks = v3.get("locks") or {}
        # Lich da o san (0 buoi 1 tiet / 0 trong >=2) thi khoa ngay o muc do.
        self.assertIsNotNone(locks.get("one_period"))
        self.assertLessEqual(int(locks["one_period"]), before[0])
        metrics = second.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)


if __name__ == "__main__":
    unittest.main()
