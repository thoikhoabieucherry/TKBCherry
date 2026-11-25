"""06/10/2026 (truong 0adf9782364): nguoi dung CO DINH 2 tiet Tin hoc Quoc te lien
nhau trong mot buoi o 6/5 va 7/5, trong khi gioi han mon la 1 tiet/buoi. Moi ket
qua Cherry deu bi tinh vi pham cung (engine khong duoc doi o co dinh) -> may chu
tra ok=false, trinh duyet giu lich cu du luot giai da toi uu tot hon han.

Phan vuot gioi han nam tron trong o co dinh la canh bao
(``fixed_subject_session_limit_overrides``), khong lam hong ``hard_ok``; engine
xep THEM tiet vuot gioi han thi van la vi pham.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_optimizer_ref.models import Assignment, ClassInfo, Lesson, SchoolData  # noqa: E402
from tkb_optimizer_ref.validate import compute_metrics  # noqa: E402


def _data(periods: int) -> SchoolData:
    return SchoolData(
        classes=[ClassInfo(name="6/5", grade="Khối 6")],
        assignments=[
            Assignment(
                class_name="6/5",
                grade="Khối 6",
                subject="Tin học Quốc tế",
                teacher="GV1",
                periods_per_week=periods,
                max_periods_per_session=1,
            )
        ],
        teachers=["GV1"],
        subjects=["Tin học Quốc tế"],
        periods_by_grade_subject={("Khối 6", "Tin học Quốc tế"): periods},
        limits_by_grade_subject={("Khối 6", "Tin học Quốc tế"): 1},
    )


def _lesson(period: int) -> Lesson:
    return Lesson(
        class_name="6/5", grade="Khối 6", day=2, session="AM", period=period,
        subject="Tin học Quốc tế", teacher="GV1",
    )


class FixedCellLimitOverrideTests(unittest.TestCase):
    def test_without_fixed_info_two_periods_violate_limit(self) -> None:
        lessons = [_lesson(1), _lesson(2)]
        m = compute_metrics(_data(2), lessons)
        self.assertEqual(len(m["subject_session_limit_violations"]), 1)
        self.assertFalse(m["hard_ok"])

    def test_user_fixed_pair_is_warning_not_violation(self) -> None:
        lessons = [_lesson(1), _lesson(2)]
        m = compute_metrics(_data(2), lessons, fixed_lessons=lessons)
        self.assertEqual(m["subject_session_limit_violations"], [])
        self.assertEqual(len(m["fixed_subject_session_limit_overrides"]), 1)
        self.assertTrue(m["core_hard_ok"])
        self.assertTrue(m["hard_ok"])

    def test_engine_adding_beyond_fixed_cells_still_violates(self) -> None:
        lessons = [_lesson(1), _lesson(2), _lesson(3)]
        m = compute_metrics(_data(3), lessons, fixed_lessons=lessons[:2])
        self.assertEqual(len(m["subject_session_limit_violations"]), 1)
        self.assertFalse(m["hard_ok"])

    def test_one_fixed_cell_does_not_excuse_the_pair(self) -> None:
        lessons = [_lesson(1), _lesson(2)]
        m = compute_metrics(_data(2), lessons, fixed_lessons=lessons[:1])
        self.assertEqual(len(m["subject_session_limit_violations"]), 1)
        self.assertFalse(m["hard_ok"])


if __name__ == "__main__":
    unittest.main()
