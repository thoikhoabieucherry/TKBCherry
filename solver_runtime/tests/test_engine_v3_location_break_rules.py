"""Cherry engine v3 — DOI DIA DIEM O GIO RA CHOI (03/09/2026).

Yeu cau cua chu du an (truong THCS Binh Hoa, 2 co so, hoc 2 tiet roi ra choi):
GV duoc doi co so NGAY TAI GIO RA CHOI ma khong phai chua mot tiet trong. Hai
yeu cau moi trong *Yeu cau giao vien*:

  * moveAtBreak23 — "Doi dia diem o gio ra choi (tiet 2-3)"
  * moveAtBreak34 — "Doi dia diem o gio ra choi (tiet 3-4)"

Ngu nghia: doi dia diem giua hai tiet KE NHAU chi hop le khi vuot qua dung ranh
gioi gio ra choi da bat; ranh gioi khac van phai co tiet trong de di chuyen
(y het gapBetweenLocations). Doi co tiet trong o giua thi luon hop le.

Day la rang buoc CUNG cua engine v3 (nut Cherry va moi muc Toi uu v3), giong ba
yeu cau dia diem cu — xem test_engine_v3_location_rules.py.
"""

from __future__ import annotations

import sys
import unittest
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3.core import compile_teacher_rule, location_rule_debt  # noqa: E402
from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402

DAY_KEYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
SUBJECTS = [
    ("Toan", 4, 2),
    ("Van", 4, 2),
    ("Anh", 3, 2),
    ("Su", 2, 1),
    ("Dia", 2, 1),
    ("GDCD", 1, 1),
]
# 6 lop: 3 lop o "Dia diem 1", 3 lop o "Dia diem 2" -> moi GV (1 GV/mon) day 2 co so
CLASSES = [("L%d" % i, "6/%d" % i, "Địa điểm 1" if i <= 3 else "Địa điểm 2") for i in range(1, 7)]


def _all_sessions(flag: bool = True) -> dict:
    return {part: {day: flag for day in DAY_KEYS} for part in ("sang", "chieu")}


def _school(*, rules: tuple[str, ...]) -> dict:
    data: dict = {
        "lop": [{"id": cid, "ten": name, "khoi": "6", "diadiem": loc} for cid, name, loc in CLASSES],
        "giaovien": [{"magv": "GV_" + s, "ten": "GV " + s} for s, _n, _cap in SUBJECTS],
        "monhoc": [{"ten": s, "ma": s[:2].upper()} for s, _n, _cap in SUBJECTS],
        "mon": [{"khoi": "6", "ten": s, "sotiet": n, "gioihan": cap} for s, n, cap in SUBJECTS],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "tkbConstraints": {
            "fixedOff": {"class": {cid: {} for cid, _name, _loc in CLASSES}},
            "teacher": {"GV_" + s: {rule: _all_sessions() for rule in rules} for s, _n, _cap in SUBJECTS},
        },
    }
    for cid, _name, _loc in CLASSES:
        for s, n, _cap in SUBJECTS:
            data["pccmMatrix"][f"{cid}|{s}"] = "GV_" + s
            data["pccmTietMatrix"][f"{cid}|{s}"] = n
    return data


def _settings(seed: int, seconds: int = 12) -> dict:
    return {
        "engine": "cherry",
        "overall_time_limit_seconds": seconds,
        "num_workers": 1,
        "random_seed": seed,
        "require_complete_schedule": False,
    }


def _adjacent_changes(data: dict, lessons: list[dict]) -> dict[str, int]:
    """Dem cac lan doi dia diem giua hai tiet KE NHAU, tach theo ranh gioi.

    Tra ve {"tai_2_3": n, "ngoai_2_3": m, "co_tiet_trong": k}. `tai_2_3` la so
    lan doi ngay tai gio ra choi (tiet 2 -> tiet 3, so tiet 1-based).
    """

    loc_of: dict[str, str] = {}
    for row in data["lop"]:
        for key in (row.get("id"), row.get("ten")):
            loc_of[str(key)] = str(row.get("diadiem") or "").strip()

    cells: dict[tuple[str, int, str], list[tuple[int, str]]] = defaultdict(list)
    for lesson in lessons:
        teacher = str(lesson.get("teacher") or "")
        if not teacher:
            continue
        cls = str(lesson.get("classId") or lesson.get("className") or "")
        loc = str(lesson.get("room") or "").strip() or loc_of.get(cls, "")
        cells[(teacher, int(lesson["day"]), str(lesson["session"]))].append((int(lesson["period"]), loc))

    counts = {"tai_2_3": 0, "ngoai_2_3": 0, "co_tiet_trong": 0}
    for items in cells.values():
        seq = sorted(x for x in items if x[1])
        for (prev_p, prev_loc), (cur_p, cur_loc) in zip(seq, seq[1:]):
            if prev_loc == cur_loc:
                continue
            if cur_p - prev_p > 1:
                counts["co_tiet_trong"] += 1
            elif prev_p == 2:
                counts["tai_2_3"] += 1
            else:
                counts["ngoai_2_3"] += 1
    return counts


class BreakRuleDebtTests(unittest.TestCase):
    """Ham chung location_rule_debt() — cung phep tinh cho State, SoftSchedule,
    giao dien va bo kiem dinh."""

    def test_change_at_break_is_free(self) -> None:
        # A A | B B  (tiet 1-2 co so 0, tiet 3-4 co so 1), ra choi sau tiet 2.
        entries = [(0, 0), (1, 0), (2, 1), (3, 1)]
        # gapBetweenLocations doi hoi tiet trong -> vi pham
        self.assertEqual(location_rule_debt(entries, False, True, False), 1)
        # moveAtBreak23 (breaks = tiet 0-based 1) -> HOP LE
        self.assertEqual(location_rule_debt(entries, False, False, False, (1,)), 0)
        # bat ca hai cung khong doi: ra choi van la loi ra
        self.assertEqual(location_rule_debt(entries, False, True, False, (1,)), 0)

    def test_change_outside_break_still_needs_a_gap(self) -> None:
        # doi o ranh gioi 1-2 (khong phai gio ra choi) -> vi pham
        self.assertEqual(location_rule_debt([(0, 0), (1, 1)], False, False, False, (1,)), 1)
        # doi o ranh gioi 3-4 -> vi pham khi chi bat ra choi 2-3
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (2, 0), (3, 1)], False, False, False, (1,)), 1)
        # ... nhung hop le khi bat ra choi 3-4 (breaks = tiet 0-based 2)
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (2, 0), (3, 1)], False, False, False, (2,)), 0)

    def test_gap_is_always_allowed(self) -> None:
        # A A _ B: co tiet trong de di chuyen -> luon hop le
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (3, 1)], False, True, False, (1,)), 0)
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (3, 1)], False, False, False, (1,)), 0)

    def test_break_rule_composes_with_max_one_move(self) -> None:
        # A | B | A : doi 2 lan. Lan doi tiet 1->2 khong phai gio ra choi (+1),
        # lan doi tiet 2->3 dung gio ra choi (mien phi), nhung doi 2 lan/buoi
        # van pham maxOneMovePerSession (+1) -> tong 2.
        entries = [(0, 0), (1, 1), (2, 0)]
        self.assertEqual(location_rule_debt(entries, False, False, True, (1,)), 2)
        # doi dung 1 lan tai gio ra choi + maxOneMovePerSession -> hop le
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (2, 1), (3, 1)], False, False, True, (1,)), 0)

    def test_one_location_per_session_unaffected_by_break(self) -> None:
        # "Chi day 1 dia diem/1 buoi" khong quan tam ra choi
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (2, 1)], True, False, False, (1,)), 1)

    def test_compile_teacher_rule_reads_break_flags(self) -> None:
        raw = {
            "moveAtBreak23": {"sang": {"thu2": True, "thu5": 1}},
            "moveAtBreak34": {"chieu": {"thu3": "true"}},
        }
        rule = compile_teacher_rule(raw, lambda _v: "", None)
        self.assertTrue(rule.has_location_rules())
        self.assertFalse(rule.is_default())
        self.assertEqual(rule.loc_breaks[0 * 2 + 0], (1,))   # thu2 sang -> ra choi sau tiet 2
        self.assertEqual(rule.loc_breaks[3 * 2 + 0], (1,))   # thu5 sang
        self.assertEqual(rule.loc_breaks[0 * 2 + 1], ())     # thu2 chieu: khong bat
        self.assertEqual(rule.loc_breaks[1 * 2 + 1], (2,))   # thu3 chieu -> ra choi sau tiet 3
        self.assertFalse(any(rule.loc_gap))


class EngineV3BreakRuleTests(unittest.TestCase):
    """Engine that phai coi moveAtBreak* la rang buoc CUNG."""

    def test_engine_only_changes_campus_at_the_break(self) -> None:
        data = _school(rules=("moveAtBreak23",))
        payload = solve_from_ui_data_v3(data, _settings(7))
        metrics = payload.get("metrics") or {}
        self.assertEqual(
            int(metrics.get("scheduled_periods") or 0),
            int(metrics.get("expected_periods") or -1),
            metrics,
        )
        counts = _adjacent_changes(data, payload.get("lessons") or [])
        # doi lien tiet ngoai gio ra choi = vi pham -> phai bang 0
        self.assertEqual(counts["ngoai_2_3"], 0, counts)

    def test_without_the_rule_engine_would_change_campus_anywhere(self) -> None:
        # Doi chung: khong bat luat nao -> engine tu do doi co so lien tiet o
        # moi ranh gioi (neu khong, test o tren khong chung minh dieu gi).
        data = _school(rules=())
        payload = solve_from_ui_data_v3(data, _settings(7))
        counts = _adjacent_changes(data, payload.get("lessons") or [])
        self.assertGreater(counts["ngoai_2_3"], 0, counts)


class BreakRuleMetricTests(unittest.TestCase):
    """Bo kiem dinh (validate.py) phai dem cung mot cach voi engine."""

    def _metrics(self, cells: list[tuple[str, int]], rules: tuple[str, ...]) -> dict:
        from tkb_optimizer_ref.models import Assignment, ClassInfo, Lesson, SchoolData
        from tkb_optimizer_ref.rules import TimetableConstraintRules, TimetableRuleSet
        from tkb_optimizer_ref.validate import compute_metrics

        classes = [
            ClassInfo(name="A1", grade="6", location="Địa điểm 1"),
            ClassInfo(name="B1", grade="6", location="Địa điểm 2"),
        ]
        lessons = [
            Lesson(class_name=cls, grade="6", day=2, session="AM", period=period,
                   subject="Toan", teacher="GV1", room="")
            for cls, period in cells
        ]
        assignments = [
            Assignment(class_name=cls, grade="6", subject="Toan", teacher="GV1",
                       periods_per_week=sum(1 for c, _p in cells if c == cls),
                       max_periods_per_session=5)
            for cls in ("A1", "B1")
        ]
        constraints = TimetableConstraintRules(
            groups={}, group_names={}, fixed_off={},
            teacher={"GV1": {rule: _all_sessions() for rule in rules}},
            subject={}, subject_group={},
        )
        data = SchoolData(
            classes=classes,
            assignments=assignments,
            teachers=["GV1"],
            subjects=["Toan"],
            periods_by_grade_subject={("6", "Toan"): 4},
            limits_by_grade_subject={("6", "Toan"): 5},
        )
        return compute_metrics(data, lessons, rules=TimetableRuleSet(constraints=constraints))

    def test_change_at_break_is_accepted(self) -> None:
        # tiet 1-2 co so 1, tiet 3-4 co so 2 -> doi dung gio ra choi
        cells = [("A1", 1), ("A1", 2), ("B1", 3), ("B1", 4)]
        self.assertEqual(self._metrics(cells, ("moveAtBreak23",))["teacher_location_rule_debt"], 0)
        # cung lich do ma bat gapBetweenLocations thi vi pham
        self.assertEqual(self._metrics(cells, ("gapBetweenLocations",))["teacher_location_rule_debt"], 1)

    def test_change_outside_break_is_rejected(self) -> None:
        # doi o ranh gioi 3-4
        cells = [("A1", 1), ("A1", 2), ("A1", 3), ("B1", 4)]
        self.assertEqual(self._metrics(cells, ("moveAtBreak23",))["teacher_location_rule_debt"], 1)
        self.assertEqual(self._metrics(cells, ("moveAtBreak34",))["teacher_location_rule_debt"], 0)

    def test_no_double_count_when_both_rules_on(self) -> None:
        # Bat ca gap lan break: mot cap tiet chi duoc bao MOT lan.
        cells = [("A1", 1), ("B1", 2)]
        metrics = self._metrics(cells, ("gapBetweenLocations", "moveAtBreak23"))
        self.assertEqual(metrics["teacher_location_rule_debt"], 1)
        loc_violations = [
            v for v in (metrics.get("app_constraint_violations") or [])
            if "gapBetweenLocations" in str(v.get("kind")) or "moveAtBreak" in str(v.get("kind"))
        ]
        self.assertEqual(len(loc_violations), 1, loc_violations)
        # thong bao phai noi theo ngon ngu "gio ra choi" khi luat ra choi dang bat
        self.assertIn("giờ ra chơi", loc_violations[0]["message"])


if __name__ == "__main__":
    unittest.main()
