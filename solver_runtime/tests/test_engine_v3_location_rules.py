"""Cherry engine v3 — yeu cau giao vien ve DIA DIEM (co so) giua cac lop (23/08).

Trang app cho moi lop mot "Dia diem"; giao vien day 2 lop o 2 dia diem khac
nhau la day 2 co so. Hai yeu cau trong phan "Yeu cau giao vien":
  * gapBetweenLocations  — "Co tiet trong giua 2 dia diem": hai tiet LIEN
    NHAU cua GV khong duoc o 2 dia diem khac nhau, phai co >= 1 tiet trong de
    di chuyen (tiet trong do la hop le).
  * maxOneMovePerSession — "Khong di chuyen 2 lan/1 buoi": trong mot buoi GV
    chi duoc doi dia diem toi da 1 lan.
(Va oneLocationPerSession — "Chi day 1 dia diem/1 buoi".)

03/09: them cap luat moveAtBreak23 / moveAtBreak34 — "Doi dia diem o gio ra
choi" — la TAP MIEN TRU cua chinh phep kiem "doi dia diem lien tiet" o tren.
Chung duoc kiem rieng trong test_engine_v3_location_break_rules.py; file nay
giu nguyen 3 luat cu (goi location_rule_debt() khong truyen tham so `breaks`,
mac dinh () = khong co gio ra choi nao duoc mien).

Engine v3 (nut Cherry + menu Toi uu v3) phai tuan thu cac yeu cau nay nhu
rang buoc CUNG: ket qua tra ve khong co buoi nao vi pham, ke ca khi lich vao
(warm-start) dang vi pham. Cac test chay engine that, thuan Python, 1 luong.
"""

from __future__ import annotations

import sys
import unittest
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3.core import TeacherRule, compile_teacher_rule, location_rule_debt  # noqa: E402
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


def _school(*, rules: tuple[str, ...] = ("gapBetweenLocations", "maxOneMovePerSession")) -> dict:
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


def _location_violations(data: dict, lessons: list[dict]) -> dict[str, int]:
    """Dem buoi vi pham theo dung ngu nghia evalTeacherRule cua giao dien."""

    loc_of = {}
    for row in data["lop"]:
        for key in (row.get("id"), row.get("ten")):
            loc_of[str(key)] = str(row.get("diadiem") or "").strip()
    teacher_rules = data["tkbConstraints"].get("teacher") or {}
    cells: dict[tuple[str, int, str], list[tuple[int, str]]] = defaultdict(list)
    for lesson in lessons:
        teacher = str(lesson.get("teacher") or "")
        if not teacher:
            continue
        cls = str(lesson.get("classId") or lesson.get("className") or "")
        loc = str(lesson.get("room") or "").strip() or loc_of.get(cls, "")
        cells[(teacher, int(lesson["day"]), str(lesson["session"]))].append((int(lesson["period"]), loc))
    counts = {"gap": 0, "move": 0, "one": 0, "two_location_sessions": 0}
    for (teacher, day, session), items in cells.items():
        rule = teacher_rules.get(teacher) or {}
        part = "sang" if session == "AM" else "chieu"
        day_key = DAY_KEYS[day - 2]
        items = sorted(x for x in items if x[1])
        if len(items) < 2:
            continue
        if len({loc for _p, loc in items}) > 1:
            counts["two_location_sessions"] += 1

        def on(name: str) -> bool:
            return bool(((rule.get(name) or {}).get(part) or {}).get(day_key))

        if on("gapBetweenLocations") and any(
            items[i][1] != items[i - 1][1] and items[i][0] - items[i - 1][0] <= 1 for i in range(1, len(items))
        ):
            counts["gap"] += 1
        if on("maxOneMovePerSession"):
            seq: list[str] = []
            for _p, loc in items:
                if not seq or seq[-1] != loc:
                    seq.append(loc)
            if len(seq) > 2:
                counts["move"] += 1
        if on("oneLocationPerSession") and len({loc for _p, loc in items}) > 1:
            counts["one"] += 1
    return counts


class LocationRuleDebtTests(unittest.TestCase):
    def test_gap_rule_counts_adjacent_location_changes_only(self) -> None:
        # A A | B B (tiet 1-2 dia diem 0, tiet 3-4 dia diem 1): doi dia diem lien tiet
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (2, 1), (3, 1)], False, True, False), 1)
        # A A _ B B: co tiet trong de di chuyen -> hop le
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (3, 1), (4, 1)], False, True, False), 0)
        # cung dia diem thi lien tiet thoai mai
        self.assertEqual(location_rule_debt([(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)], True, True, True), 0)

    def test_move_rule_allows_one_change_per_session(self) -> None:
        # A _ B: 1 lan doi -> hop le
        self.assertEqual(location_rule_debt([(0, 0), (2, 1)], False, False, True), 0)
        # A _ B _ A: 2 lan doi -> vi pham (1 don vi)
        self.assertEqual(location_rule_debt([(0, 0), (2, 1), (4, 0)], False, False, True), 1)
        # ... ma khong vi pham luat tiet trong (deu co tiet trong giua)
        self.assertEqual(location_rule_debt([(0, 0), (2, 1), (4, 0)], False, True, False), 0)

    def test_one_location_rule(self) -> None:
        self.assertEqual(location_rule_debt([(0, 0), (3, 1)], True, False, False), 1)
        self.assertEqual(location_rule_debt([(0, 0), (3, 0)], True, False, False), 0)

    def test_compile_teacher_rule_reads_session_flags(self) -> None:
        raw = {
            "gapBetweenLocations": {"sang": {"thu2": True, "thu5": 1}},
            "maxOneMovePerSession": {"chieu": {"thu3": "true"}},
        }
        rule = compile_teacher_rule(raw, lambda _v: "", None)
        self.assertIsInstance(rule, TeacherRule)
        self.assertTrue(rule.has_location_rules())
        self.assertFalse(rule.is_default())
        self.assertTrue(rule.loc_gap[0 * 2 + 0])   # thu2 sang
        self.assertTrue(rule.loc_gap[3 * 2 + 0])   # thu5 sang
        self.assertFalse(rule.loc_gap[0 * 2 + 1])  # thu2 chieu
        self.assertTrue(rule.loc_move[1 * 2 + 1])  # thu3 chieu
        self.assertFalse(any(rule.loc_one))


class EngineV3LocationRulesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = _school()
        cls.first = solve_from_ui_data_v3(cls.data, _settings(7))

    def test_fresh_solve_respects_location_rules(self) -> None:
        payload = self.first
        metrics = payload.get("metrics") or {}
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        counts = _location_violations(self.data, payload.get("lessons") or [])
        self.assertEqual(counts["gap"], 0, counts)
        self.assertEqual(counts["move"], 0, counts)

    def test_without_location_rules_engine_would_violate(self) -> None:
        # Doi chung: cung truong nhung KHONG bat yeu cau -> engine tu do xep
        # lien tiet qua 2 dia diem (neu khong, test o tren khong chung minh gi).
        data = _school(rules=())
        payload = solve_from_ui_data_v3(data, _settings(7))
        check_data = _school()  # dem theo luat nhu the da bat
        counts = _location_violations(check_data, payload.get("lessons") or [])
        self.assertGreater(counts["gap"] + counts["move"], 0, counts)

    def test_warm_start_from_violating_schedule_is_repaired(self) -> None:
        # Lich hien tai (xep khi chua bat yeu cau) dang vi pham -> bam Cherry
        # phai tra ve lich DU tiet va het vi pham, khong xay lai tu dau.
        free = solve_from_ui_data_v3(_school(rules=()), _settings(3))
        base_counts = _location_violations(self.data, free.get("lessons") or [])
        self.assertGreater(base_counts["gap"] + base_counts["move"], 0, base_counts)
        warm = dict(self.data)
        warm["tkbSolverResult"] = {"lessons": list(free.get("lessons") or [])}
        payload = solve_from_ui_data_v3(warm, _settings(11, seconds=15))
        metrics = payload.get("metrics") or {}
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), int(metrics.get("expected_periods") or -1))
        counts = _location_violations(self.data, payload.get("lessons") or [])
        self.assertEqual(counts["gap"], 0, counts)
        self.assertEqual(counts["move"], 0, counts)
        v3 = (payload.get("solver") or {}).get("engine_v3") or {}
        self.assertTrue(v3.get("warm_start"), v3)

    def test_warm_start_on_valid_schedule_keeps_rules_and_never_gets_worse(self) -> None:
        warm = dict(self.data)
        warm["tkbSolverResult"] = {"lessons": list(self.first.get("lessons") or [])}
        payload = solve_from_ui_data_v3(warm, _settings(5))
        v3 = (payload.get("solver") or {}).get("engine_v3") or {}
        self.assertTrue(v3.get("warm_start"), v3)
        counts = _location_violations(self.data, payload.get("lessons") or [])
        self.assertEqual(counts["gap"] + counts["move"], 0, counts)
        before = list(((self.first.get("solver") or {}).get("engine_v3") or {}).get("objective") or [])[:4]
        after = list(v3.get("objective") or [])[:4]
        self.assertLessEqual(after, before)

    def test_one_location_per_session_rule(self) -> None:
        data = _school(rules=("oneLocationPerSession",))
        payload = solve_from_ui_data_v3(data, _settings(9))
        counts = _location_violations(data, payload.get("lessons") or [])
        self.assertEqual(counts["one"], 0, counts)
        self.assertEqual(counts["two_location_sessions"], 0, counts)


class LocationDebtMetricTests(unittest.TestCase):
    """26/08: backend phai BAO SO buoi vi pham dia diem ra `metrics`.

    Truoc day `validate.py` chi doc `Lesson.room` — truong khong dung phong hoc
    (mac dinh) thi moi tiet co room="" nen ba luat im lang khong bao gio bao, va
    `metrics` khong he co `teacher_location_rule_debt`. Cong "khong bao gio xau
    hon" o trinh duyet vi vay phai tu cham diem, va roi vao NaN thi bo qua.
    """

    def _metrics(self, cells: list[tuple[str, int]]) -> dict:
        from tkb_optimizer_ref.models import Assignment, ClassInfo, Lesson, SchoolData
        from tkb_optimizer_ref.rules import TimetableConstraintRules, TimetableRuleSet
        from tkb_optimizer_ref.validate import compute_metrics

        classes = [ClassInfo(name="A1", grade="6", location="Địa điểm 1"), ClassInfo(name="B1", grade="6", location="Địa điểm 2")]
        lessons = [
            Lesson(class_name=cls, grade="6", day=2, session="AM", period=period, subject="Toan", teacher="GV1", room="")
            for cls, period in cells
        ]
        assignments = [
            Assignment(
                class_name=cls,
                grade="6",
                subject="Toan",
                teacher="GV1",
                periods_per_week=sum(1 for c, _p in cells if c == cls),
                max_periods_per_session=5,
            )
            for cls in ("A1", "B1")
        ]
        constraints = TimetableConstraintRules(
            groups={},
            group_names={},
            fixed_off={},
            teacher={"GV1": {rule: _all_sessions() for rule in ("gapBetweenLocations", "maxOneMovePerSession")}},
            subject={},
            subject_group={},
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

    def test_debt_uses_class_location_when_no_room(self) -> None:
        # tiet 1 o "Dia diem 1", tiet 2 o "Dia diem 2": doi cho lien tiet, khong
        # co tiet trong de di chuyen -> 1 buoi vi pham.
        metrics = self._metrics([("A1", 1), ("B1", 2)])
        self.assertEqual(metrics.get("teacher_location_rule_debt"), 1, metrics.get("app_constraint_violations"))
        self.assertFalse(metrics["hard_ok"])

    def test_gap_between_locations_is_accepted(self) -> None:
        # tiet 1 o co so 1, tiet 3 o co so 2: co tiet 2 de di chuyen -> hop le.
        metrics = self._metrics([("A1", 1), ("B1", 3)])
        self.assertEqual(metrics.get("teacher_location_rule_debt"), 0)

    def test_same_location_never_counts(self) -> None:
        metrics = self._metrics([("A1", 1), ("A1", 2), ("A1", 3)])
        self.assertEqual(metrics.get("teacher_location_rule_debt"), 0)


class StaleRulePenTests(unittest.TestCase):
    """26/08 — hoi quy: `rule_pen_total` phai tuoi sau moi nuoc di.

    `set_cell` van cap nhat `tloc` (dia diem tung o) dung tung nuoc di, nhung
    con so `rule_pen[t]` truoc day chi doi khi co ai goi `refresh_rule_pen`.
    `_quality_score` co so hang `rule_pen_total * 10**13` — voi so CU thi so hang
    do vo nghia, nen cac pha toi uu chat luong tu do day GV qua lai giua 2 co so.
    Do that tren truong 2kkn7c6y7l1: 35 -> 55 buoi vi pham.
    """

    def _soft_two_campus(self):
        import tkb_engine_v3.construct as construct
        from tkb_engine_v3.core import PERIODS, compile_problem
        from tkb_new.adapter import build_school_data_from_ui

        data = _school()
        ctx = build_school_data_from_ui(data)
        problem = compile_problem(ctx, ctx.rules, [])
        self.assertTrue(any(problem.teacher_loc_rules), "fixture phai co GV day 2 co so")
        soft = construct.SoftSchedule(problem)
        return construct, problem, soft, PERIODS

    def test_set_cell_marks_location_teachers_dirty(self) -> None:
        _construct, problem, soft, _P = self._soft_two_campus()
        t = next(i for i, on in enumerate(problem.teacher_loc_rules) if on)
        ai = next(
            a for a in range(problem.num_assignments())
            if t in problem.a_teachers[a] and problem.a_loc[a] >= 0
        )
        self.assertEqual(soft._loc_dirty, set())
        soft.set_cell(problem.a_class[ai], 0, ai)
        self.assertIn(t, soft._loc_dirty)

    def test_penalty_sees_a_fresh_number_without_explicit_refresh(self) -> None:
        _construct, problem, soft, periods = self._soft_two_campus()
        t = next(i for i, on in enumerate(problem.teacher_loc_rules) if on)
        mine = [
            a for a in range(problem.num_assignments())
            if t in problem.a_teachers[a] and problem.a_loc[a] >= 0
        ]
        locs = {problem.a_loc[a] for a in mine}
        self.assertGreaterEqual(len(locs), 2, "GV nay phai day o >= 2 dia diem")
        first = next(a for a in mine if problem.a_loc[a] == min(locs))
        other = next(a for a in mine if problem.a_loc[a] == max(locs))
        # hai tiet KE NHAU o hai co so khac nhau = vi pham "co tiet trong giua
        # 2 dia diem"; KHONG goi refresh_rule_pen o day.
        soft.set_cell(problem.a_class[first], 0, first)
        soft.set_cell(problem.a_class[other], 1, other)
        self.assertGreater(soft.penalty(), 0, "penalty() phai tu dong cap nhat no dia diem")
        self.assertEqual(soft._loc_dirty, set(), "sync xong phai xoa co ban")

    def test_no_location_rules_costs_nothing(self) -> None:
        import tkb_engine_v3.construct as construct
        from tkb_engine_v3.core import compile_problem
        from tkb_new.adapter import build_school_data_from_ui

        data = _school(rules=())
        ctx = build_school_data_from_ui(data)
        problem = compile_problem(ctx, ctx.rules, [])
        soft = construct.SoftSchedule(problem)
        for ai in range(min(8, problem.num_assignments())):
            soft.set_cell(problem.a_class[ai], ai % 10, ai)
        # khong GV nao co tloc -> khong bao gio co GV ban -> khong ton phep tinh
        self.assertEqual(soft._loc_dirty, set())


class PenaltyKeyTests(unittest.TestCase):
    """26/08 — TRUNG GIO GV khong bao gio duoc doi lay no luat.

    `penalty()` gop overlap + rule_pen vao MOT so, nen pha 2 nhan ca nhung nuoc
    bo 1 trung gio de doi 2 no luat (va nguoc lai). Do that tren truong
    2kkn7c6y7l1: pha 2 go no luat 57 -> 43 nhung de lai trung gio ->
    `_repair_partial_warm` vut ca luoi warm -> engine xay lai tu dau, mat ~60
    tiet. Sau khi doi sang khoa TU DIEN: warm_start=True, giu du 1110 tiet, no
    dia diem 35 -> 26.
    """

    def _soft(self, overlap: int, rule_pen: int):
        import tkb_engine_v3.construct as construct
        from tkb_engine_v3.core import compile_problem
        from tkb_new.adapter import build_school_data_from_ui

        ctx = build_school_data_from_ui(_school())
        soft = construct.SoftSchedule(compile_problem(ctx, ctx.rules, []))
        soft.overlap = overlap
        soft.rule_pen_total = rule_pen
        return soft

    def test_overlap_dominates_rule_debt(self) -> None:
        it_hon = self._soft(0, 50)     # sach trung gio, no luat nhieu
        te_hon = self._soft(1, 0)      # con 1 trung gio, khong no luat
        self.assertLess(it_hon.penalty_key(), te_hon.penalty_key())
        # con `penalty()` cu thi ket luan NGUOC — day dung la lo hong da sua
        self.assertGreater(it_hon.penalty(), te_hon.penalty())

    def test_rule_debt_breaks_ties_at_equal_overlap(self) -> None:
        a = self._soft(2, 3)
        b = self._soft(2, 9)
        self.assertLess(a.penalty_key(), b.penalty_key())

    def test_zero_zero_is_the_floor(self) -> None:
        self.assertEqual(self._soft(0, 0).penalty_key(), (0, 0))


class RankKeyTests(unittest.TestCase):
    """26/08 — hoi quy: no luat dia diem KHONG duoc dung tren so tiet.

    Lan dau vá, `loc_debt` bi dat len dau tuple xep hang. Do that tren truong
    2kkn7c6y7l1 (38 lop / 2 co so): portfolio chon nghiem 1050 tiet / 29 buoi
    vi pham thay vi 1110 tiet / 35 buoi — mat 60 tiet chi de bot 6 buoi.
    """

    @staticmethod
    def _res(placed: int, loc_debt: int, *, warm_placed: int = 1110, quality_ejected: int = 0) -> dict:
        return {
            "placed": placed,
            "location_debt": loc_debt,
            "quality_ejected": quality_ejected,
            "objective": [1, 0, 500, 100, 250],
            "info": {"warm_placed": warm_placed},
        }

    def test_more_lessons_beats_fewer_location_violations(self) -> None:
        from tkb_engine_v3.entry import _rank_key

        full = self._res(1110, 35)
        short = self._res(1050, 29)
        self.assertLess(_rank_key(full, None), _rank_key(short, None))
        self.assertLess(_rank_key(full, "gap1"), _rank_key(short, "gap1"))

    def test_location_debt_breaks_ties_at_equal_lessons(self) -> None:
        from tkb_engine_v3.entry import _rank_key

        clean = self._res(1110, 0)
        dirty = self._res(1110, 35)
        self.assertLess(_rank_key(clean, None), _rank_key(dirty, None))
        self.assertLess(_rank_key(clean, "singletons"), _rank_key(dirty, "singletons"))

    def test_quality_ejected_still_counts_as_handled(self) -> None:
        from tkb_engine_v3.entry import _rank_key

        ejected = self._res(1100, 35, quality_ejected=10)
        short = self._res(1100, 0, quality_ejected=0)
        self.assertLess(_rank_key(ejected, None), _rank_key(short, None))

    def test_no_location_rules_keeps_the_old_order(self) -> None:
        from tkb_engine_v3.entry import _rank_key

        a = self._res(1110, 0)
        b = self._res(1100, 0)
        self.assertLess(_rank_key(a, None), _rank_key(b, None))
        # loc_debt = 0 o moi nghiem -> phan tu do khong bao gio pha the
        self.assertEqual(_rank_key(a, None)[1], 0)


class LocationGateTests(unittest.TestCase):
    """26/08: cong DIA DIEM cua entry.py — chay cho MOI luot (Cherry + mot muc
    tieu). Ket qua khong bao gio duoc nhieu buoi vi pham hon luoi xuat phat.
    Do that tren truong 2kkn7c6y7l1: mot luot Cherry day 35 -> 45 buoi."""

    @staticmethod
    def _best(now: int, start: int = 35) -> dict:
        return {
            "grid": [[3, 3], [3, 3]],
            # xep duoc 1 tiet + 1 tiet chu dong dua ve Chua phan = 2 "da xu ly",
            # bang dung moc warm_placed -> cong dia diem duoc quyen can thiep.
            "placed": 1,
            "objective": [1, 0, 5, 2, 9],
            "quality_ejected": 1,
            "location_debt": now,
            "info": {
                "warm_location_debt": start,
                "warm_placed": 2,
                "warm_quality": [2, 1, 6, 4],
                "warm_grid": [[1, -1], [-1, 2]],
                "quality_ejected": [{"class": "A1"}],
            },
        }

    def test_worse_result_is_replaced_by_warm_grid(self) -> None:
        from tkb_engine_v3.entry import _location_gate

        best = self._best(45)
        verdict = _location_gate(best)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertIn("35", verdict["message"])
        self.assertEqual(best["grid"], [[1, -1], [-1, 2]])
        self.assertEqual(best["placed"], 2)
        self.assertEqual(best["location_debt"], 35)
        self.assertEqual(best["objective"], [2, 1, 6, 4, 9])
        self.assertEqual(best["quality_ejected"], 0)
        self.assertTrue(best["info"]["location_gate_restored"])

    def test_equal_or_better_result_passes_through(self) -> None:
        from tkb_engine_v3.entry import _location_gate

        for now in (35, 12, 0):
            best = self._best(now)
            verdict = _location_gate(best)
            self.assertFalse(verdict["keep_original"], (now, verdict))
            self.assertEqual(best["grid"], [[3, 3], [3, 3]])
            self.assertEqual(best["location_debt"], now)

    def test_no_baseline_at_all_means_no_gate(self) -> None:
        from tkb_engine_v3.entry import _location_gate

        best = self._best(45)
        best["info"].pop("warm_location_debt")
        self.assertIsNone(_location_gate(best))
        self.assertEqual(best["grid"], [[3, 3], [3, 3]])

    def test_entry_baseline_saves_the_gate_when_constructor_wrote_none(self) -> None:
        """26/08 — hoi quy: Constructor tu choi warm-start (vi lich vao con no
        luat) thi `info` khong co moc nao, truoc day cong bien mat va lich 55
        buoi vi pham van duoc giao. Nay entry.py tu chup moc tu warm_cells."""

        from tkb_engine_v3.entry import _location_gate

        best = self._best(55)
        best["info"].pop("warm_location_debt")
        best["info"].pop("warm_grid")
        best["info"].pop("warm_quality")
        best["info"].pop("warm_placed")
        best["placed"] = 1100
        verdict = _location_gate(best, 35, [[1, -1], [-1, 2]], 1110)
        self.assertTrue(verdict["keep_original"], verdict)
        self.assertEqual(best["grid"], [[1, -1], [-1, 2]])
        self.assertEqual(best["placed"], 1110)
        self.assertEqual(best["location_debt"], 35)

    def test_more_lessons_is_never_thrown_away_by_this_gate(self) -> None:
        """DU TIET la uu tien tuyet doi: ung vien xep NHIEU tiet hon thi cong
        nay khong duoc tu y vut di, du no dia diem cao hon — de cong ben trinh
        duyet quyet dinh."""

        from tkb_engine_v3.entry import _location_gate

        best = self._best(55)
        best["placed"] = 1150
        best["quality_ejected"] = 0
        verdict = _location_gate(best, 35, [[1, -1], [-1, 2]], 1110)
        self.assertFalse(verdict["keep_original"], verdict)
        self.assertTrue(verdict.get("kept_for_more_lessons"))
        self.assertEqual(best["grid"], [[3, 3], [3, 3]])


if __name__ == "__main__":
    unittest.main()
