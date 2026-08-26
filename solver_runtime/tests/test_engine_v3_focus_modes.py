"""Menu "Toi uu v3" (22/08 dem, chi dao chu du an): moi nut MOT muc tieu rieng
le tren lich dang co, "tap trung vao giai quyet toi uu rieng le", khong vi pham
rang buoc, cac chi so khac khong duoc xau di, va (22/08 khuya) "khi da xep du
roi thi HOAN DOI cac tiet chu KHONG lam rot tiet ra Chua phan".

  optimization_focus=singletons  -> chi bac 1 (buoi 1 tiet); trong >= 2 va so buoi
                                    bi khoa; KHONG dua tiet ra.
  optimization_gap_target=gap2   -> chi bac 2; buoi 1 tiet / so buoi bi khoa.
  optimization_focus=sessions    -> chi bac 3 (so buoi day).
  optimization_gap_target=gap1   -> nut "trong 1" cu.
Khong focus nao dua tiet ra Chua phan (bac 4 chi danh cho nut Cherry).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tkb_engine_v3.entry import QUALITY_EJECT_REASON, solve_from_ui_data_v3  # noqa: E402

from test_engine_v3_quality_eject import (  # noqa: E402
    _quality_items,
    _school,
    _settings,
    _tkb_from_lessons,
    _v3,
)


def _focus_settings(seed: int, **extra) -> dict:
    base = _settings(seed, seconds=10)
    base.update(extra)
    return base


def _place_extra_lesson(tkb: dict, class_id: str, subject: str) -> None:
    """Dat them 1 tiet `subject` cho lop vao o trong NGAY SAU cac tiet da co
    trong mot buoi (khong tao lo trong cho hoc sinh)."""

    grid = tkb.setdefault(class_id, {})
    for day in ("thu2", "thu3", "thu4", "thu5", "thu6", "thu7"):
        row = grid.setdefault(day, {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]})
        for part in ("sang", "chieu"):
            cells = row[part]
            occupied = [i for i, v in enumerate(cells) if v]
            if occupied and occupied[-1] + 1 < len(cells) and occupied == list(range(0, len(occupied))):
                cells[occupied[-1] + 1] = subject
                return
    raise AssertionError("khong tim duoc o trong sat tiet da co")


class EngineV3FocusModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Lich nen: truong co GV_TIN chi 1 tiet/tuan (buoi 1 tiet cau truc).
        # Luot Cherry day du se dua tiet do ra; de moi nut mot muc tieu co
        # viec ma lam, dat tiet Tin tro lai luoi (nhu nguoi dung keo tay) ->
        # lich DU 97/97 voi dung 1 buoi 1 tiet cau truc.
        cls.data = _school()
        first = solve_from_ui_data_v3(cls.data, _settings(21, seconds=9))
        tkb = _tkb_from_lessons(list(first.get("lessons") or []))
        missing = [u for u in (first.get("unassignedLessons") or []) if u.get("teacher") == "GV_TIN"]
        if missing:
            _place_extra_lesson(tkb, "L1", "Tin")
        cls.base_tkb = tkb
        base_obj = tuple(int(x) for x in (_v3(first).get("objective") or [0, 0, 0, 0])[:4])
        # tiet Tin dat tay -> them dung 1 buoi 1 tiet, 1 buoi day
        cls.base_obj = (base_obj[0] + (1 if missing else 0), base_obj[1], base_obj[2] + (1 if missing else 0), base_obj[3])

    def _warm(self) -> dict:
        warm = dict(self.data)
        warm["tkb"] = {cid: {d: {p: list(cells) for p, cells in parts.items()} for d, parts in grid.items()} for cid, grid in self.base_tkb.items()}
        warm["tkbSolverResult"] = {"unassignedLessons": []}
        return warm

    def test_singletons_focus_only_touches_one_period_debt(self) -> None:
        payload = solve_from_ui_data_v3(self._warm(), _focus_settings(31, optimization_focus="singletons"))
        v3 = _v3(payload)
        self.assertEqual(v3.get("quality_focus"), "singletons")
        self.assertTrue(v3.get("warm_start"), v3)
        stages = [int(s["stage"]) for s in (v3.get("stages") or [])]
        self.assertTrue(stages and all(s == 1 for s in stages), stages)
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)
        obj = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        # buoi 1 tiet khong tang; trong >= 2 va so buoi bi khoa (khong tang)
        self.assertLessEqual(obj[0], self.base_obj[0])
        self.assertLessEqual(obj[1], self.base_obj[1])
        self.assertLessEqual(obj[2], self.base_obj[2])
        # lich da du: chi HOAN DOI, khong dua tiet nao ra (ke ca buoi le cau
        # truc cua GV_TIN) — du tiet 97/97
        self.assertEqual(_quality_items(payload), [])
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(int(metrics.get("unassigned_periods") or 0), 0)
        self.assertEqual(obj[0], self.base_obj[0])  # buoi le cau truc van con, khong tang
        skipped = v3.get("quality_eject_skipped") or {}
        self.assertEqual(skipped.get("focus"), "singletons")
        self.assertEqual(int(v3.get("quality_ejected") or 0), 0)

    def test_gap2_focus_keeps_singletons_and_sessions(self) -> None:
        payload = solve_from_ui_data_v3(self._warm(), _focus_settings(41, optimization_gap_target="gap2"))
        v3 = _v3(payload)
        self.assertEqual(v3.get("quality_focus"), "gap2")
        stages = [int(s["stage"]) for s in (v3.get("stages") or [])]
        self.assertTrue(stages and all(s == 2 for s in stages), stages)
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        obj = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        self.assertLessEqual(obj[0], self.base_obj[0])
        self.assertLessEqual(obj[1], self.base_obj[1])
        self.assertLessEqual(obj[2], self.base_obj[2])
        # buoi 1 tiet cua GV_TIN KHONG bi dua ra (khong phai viec cua nut nay)
        for item in _quality_items(payload):
            self.assertEqual(item.get("kind"), "gap2", item)
        self.assertEqual(obj[0], self.base_obj[0])
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual((v3.get("quality_eject_skipped") or {}).get("focus"), "gap2")

    def test_sessions_focus_never_ejects_and_never_worsens_locked_metrics(self) -> None:
        payload = solve_from_ui_data_v3(self._warm(), _focus_settings(51, optimization_focus="sessions"))
        v3 = _v3(payload)
        self.assertEqual(v3.get("quality_focus"), "sessions")
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        self.assertEqual(_quality_items(payload), [])
        self.assertEqual((v3.get("quality_eject_skipped") or {}).get("focus"), "sessions")
        obj = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        self.assertLessEqual(obj[0], self.base_obj[0])
        self.assertLessEqual(obj[1], self.base_obj[1])
        self.assertLessEqual(obj[2], self.base_obj[2])

    def test_live_quality_frames_carry_metric_label(self) -> None:
        # 22/08 (khuya, chu du an: "nut toi uu phai hien 1 tiet -> 0 tiet"):
        # moi luot phat khung tien do co cau truc de bridge hien so lieu.
        frames: list[dict] = []
        payload = solve_from_ui_data_v3(
            self._warm(), _focus_settings(71, optimization_focus="singletons"),
            progress=lambda evt: frames.append(dict(evt)),
        )
        live = [f for f in frames if f.get("stage") == "optimize:quality" and f.get("metricLabel")]
        self.assertTrue(live, [f.get("stage") for f in frames])
        first = live[0]
        self.assertEqual(first.get("optimizationFocus"), "one_period_teacher_sessions")
        self.assertTrue(str(first.get("metricLabel")).startswith("Dạy 1 tiết: "), first)
        self.assertIn("➔", str(first.get("metricLabel")))
        self.assertEqual(int(first.get("metricTarget")), 0)
        self.assertGreaterEqual(int(first.get("metricBaseline")), int(first.get("metricCurrent")))
        self.assertEqual(len(first.get("quality") or []), 4)
        self.assertTrue(payload.get("ok"))

    def test_stop_file_ends_focus_lane_early_with_valid_schedule(self) -> None:
        # 23/08 (chu du an: "nut Dung bam vao khong dung duoc"): engine v3 phai
        # doc TKB_SOLVER_STOP_FILE (Cloud Run dat khi dung/huy) va tra ve ngay
        # ket qua tot nhat hien co, van hop le va du tiet.
        import os
        import tempfile
        import threading
        import time as _time

        with tempfile.TemporaryDirectory() as directory:
            stop_path = Path(directory) / "stop.flag"
            previous = os.environ.get("TKB_SOLVER_STOP_FILE")
            os.environ["TKB_SOLVER_STOP_FILE"] = str(stop_path)
            try:
                def arm() -> None:
                    _time.sleep(2.0)
                    stop_path.write_text("stop\n", encoding="utf-8")

                threading.Thread(target=arm, daemon=True).start()
                settings = _focus_settings(81, optimization_gap_target="gap1")
                settings["overall_time_limit_seconds"] = 20
                settings["backend_deadline_ms"] = 20_000
                settings["num_workers"] = 1
                started = _time.monotonic()
                payload = solve_from_ui_data_v3(self._warm(), settings)
                elapsed = _time.monotonic() - started
            finally:
                if previous is None:
                    os.environ.pop("TKB_SOLVER_STOP_FILE", None)
                else:
                    os.environ["TKB_SOLVER_STOP_FILE"] = previous
        v3 = _v3(payload)
        metrics = payload.get("metrics") or {}
        self.assertLess(elapsed, 12.0, elapsed)
        stages = v3.get("stages") or []
        self.assertTrue(stages and stages[-1].get("exit") == "stopped", stages)
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        obj = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        self.assertLessEqual(obj[0], self.base_obj[0])
        self.assertLessEqual(obj[1], self.base_obj[1])

    def test_gap1_focus_unchanged_contract(self) -> None:
        frames: list[dict] = []
        payload = solve_from_ui_data_v3(
            self._warm(), _focus_settings(61, optimization_gap_target="gap1"),
            progress=lambda evt: frames.append(dict(evt)),
        )
        v3 = _v3(payload)
        # 23/08 (muc A): nhan so lieu cua nut gap1 la "Trống 1 tiết: X ➔ Y" (co the
        # kem "· đã thử n lỗ"), khung co optimizationFocus=teacher_gap1_sessions.
        live = [f for f in frames if f.get("stage") == "optimize:quality" and f.get("metricLabel")]
        self.assertTrue(live, [f.get("stage") for f in frames])
        self.assertTrue(all(str(f.get("metricLabel")).startswith("Trống 1 tiết: ") for f in live), live[:3])
        self.assertEqual(live[0].get("optimizationFocus"), "teacher_gap1_sessions")
        self.assertEqual(v3.get("quality_focus"), "gap1")
        self.assertEqual(_quality_items(payload), [])
        obj = tuple(int(x) for x in (v3.get("objective") or [0, 0, 0, 0])[:4])
        self.assertLessEqual(obj[0], self.base_obj[0])
        self.assertLessEqual(obj[1], self.base_obj[1])
        self.assertLessEqual(obj[2], self.base_obj[2])
        # 23/08 (trua): lane gap1 khong bao gio tra ve lich TE hon ve trong 1
        # (truoc day trang thai "ban" lam restore_best tra ve luoi xuat phat;
        # nay nuoc lam tang penalty bi loai ngay trong _quality_step).
        self.assertLessEqual(obj[3], self.base_obj[3])
        metrics = payload.get("metrics") or {}
        self.assertTrue(metrics.get("hard_ok"), metrics)
        self.assertEqual(int(metrics.get("app_constraint_violation_count") or 0), 0)
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        stages = [int(s["stage"]) for s in (v3.get("stages") or [])]
        self.assertTrue(stages and all(s == 3 for s in stages), stages)
        self.assertEqual(QUALITY_EJECT_REASON, "teacher_quality_unreachable")


if __name__ == "__main__":
    unittest.main()
