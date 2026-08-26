"""Cherry engine v3 — CP-SAT cluster LNS (tkb_engine_v3.cpsat_lns) (26/08).

Fixture xay Problem truc tiep (khong qua adapter) de kiem tra tung hop dong:
  * lane gap1 / sessions giam that, khong tang buoi 1 tiet / trong >= 2,
    so tiet moi phan cong giu nguyen, o co dinh khong doi, revert tra lai luoi;
  * tiet day ghep chiem cho CA HAI giao vien (model ngay tho se trung gio);
  * GV dong bang khong doi o; stop_check dung nhanh; khong cai thien -> None;
  * luat lop (no_same_session/day, nhom mon), timeLimit, tran tiet theo lop.
Moi loi giai deu qua State.full_recheck (checks.py + state.py) — trong tai.
"""

from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.construct import SoftSchedule  # noqa: E402
from tkb_engine_v3.core import NUM_SLOTS, PERIODS, Problem, SubjectRule, TeacherRule  # noqa: E402
from tkb_engine_v3.state import State  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


def _problem(
    class_names: list[str],
    teacher_names: list[str],
    subject_names: list[str],
    assignments: list[tuple[int, int, tuple[int, ...], int, int]],
    class_sessions: dict[int, list[int]],
    *,
    a_rules: dict[int, SubjectRule] | None = None,
    teacher_rules: dict[int, TeacherRule] | None = None,
    allowed_override: dict[int, list[int]] | None = None,
    no_same_session: dict[int, list[frozenset[int]]] | None = None,
    no_same_day: dict[int, list[frozenset[int]]] | None = None,
    fixed_cells: list[tuple[int, int, int]] | None = None,
    subject_groups: dict[int, tuple[str, ...]] | None = None,
    group_rule_keys: dict[tuple[int, str], SubjectRule] | None = None,
    time_limit_rules: tuple = (),
    raw_groups: dict | None = None,
) -> Problem:
    """assignments: (lop, mon, (gv...), so tiet, suc chua/buoi)."""

    C, T = len(class_names), len(teacher_names)
    class_avail = []
    for c in range(C):
        mask = bytearray(NUM_SLOTS)
        for s in class_sessions.get(c, []):
            for p in range(PERIODS):
                mask[s * PERIODS + p] = 1
        class_avail.append(mask)
    teacher_avail = [bytearray(b"\x01" * NUM_SLOTS) for _ in range(T)]
    a_class, a_subject, a_teacher, a_teachers, a_periods, a_cap, a_allowed = [], [], [], [], [], [], []
    for ai, (c, si, members, periods, cap) in enumerate(assignments):
        a_class.append(c)
        a_subject.append(si)
        a_teacher.append(members[0] if members else -1)
        a_teachers.append(tuple(members))
        a_periods.append(periods)
        a_cap.append(cap)
        allowed = bytearray(class_avail[c])
        if allowed_override and ai in allowed_override:
            keep = set(allowed_override[ai])
            for x in range(NUM_SLOTS):
                if x not in keep:
                    allowed[x] = 0
        a_allowed.append(allowed)
    A = len(assignments)
    fixed = list(fixed_cells or [])
    fixed_mask = [bytearray(NUM_SLOTS) for _ in range(C)]
    for c, x, _ai in fixed:
        fixed_mask[c][x] = 1
    return Problem(
        class_names=list(class_names),
        class_grades=["6"] * C,
        teacher_names=list(teacher_names),
        subject_names=list(subject_names),
        class_avail=class_avail,
        teacher_avail=teacher_avail,
        a_class=a_class,
        a_subject=a_subject,
        a_teacher=a_teacher,
        a_room=[""] * A,
        a_periods=a_periods,
        a_cap=a_cap,
        a_allowed=a_allowed,
        a_rule=[(a_rules or {}).get(ai) for ai in range(A)],
        teacher_rules=[(teacher_rules or {}).get(t) for t in range(T)],
        teacher_must=[frozenset() for _ in range(T)],
        no_same_session=[list((no_same_session or {}).get(c, [])) for c in range(C)],
        no_same_day=[list((no_same_day or {}).get(c, [])) for c in range(C)],
        fixed_cells=fixed,
        time_limit_rules=tuple(time_limit_rules),
        subject_groups=dict(subject_groups or {}),
        group_rule_keys=dict(group_rule_keys or {}),
        raw_groups=raw_groups,
        _raw_groups=raw_groups,
        a_teacher_label=[""] * A,
        a_teachers=a_teachers,
        a_loc=[-1] * A,
        loc_names=[],
        teacher_loc_rules=[False] * T,
        fixed_mask=fixed_mask,
    )


def _soft(P: Problem, cells: list[tuple[int, int, int]]) -> SoftSchedule:
    soft = SoftSchedule(P)
    for c, x, ai in P.fixed_cells:
        soft.set_cell(c, x, ai)
        soft.locked[c][x] = 1
    for c, x, ai in cells:
        if soft.grid[c][x] == -1:
            soft.set_cell(c, x, ai)
    for t in range(P.num_teachers()):
        soft.refresh_rule_pen(t)
    soft.enable_quality_tracking()
    return soft


def _hard_ok(P: Problem, grid: list[list[int]]) -> tuple[bool, str]:
    """Trong tai: State (state.py) + full_recheck (checks.py)."""

    st = State(P)
    for c in range(P.num_classes()):
        for x in range(NUM_SLOTS):
            ai = grid[c][x]
            if ai >= 0 and st.apply([(c, x, ai)], check=False) is None:
                return False, st.check_fail_reason
    for c, x, _ai in P.fixed_cells:
        st.lock_cell(c, x)
    ok = st.full_recheck()
    return ok, st.check_fail_reason


def _counts(P: Problem, grid: list[list[int]]) -> list[int]:
    out = [0] * P.num_assignments()
    for row in grid:
        for ai in row:
            if ai >= 0:
                out[ai] += 1
    return out


def _refresh(soft: SoftSchedule) -> None:
    for t in range(soft.P.num_teachers()):
        soft.refresh_rule_pen(t)


def _latin(
    n_groups: int = 1,
    sessions: tuple[int, ...] = (0, 2, 4),
    *,
    with_rules: bool = True,
    fixed: bool = True,
) -> tuple[Problem, SoftSchedule, list[int]]:
    """Moi nhom: 3 lop x 5 mon (1 GV/mon), moi mon 1 tiet/buoi o ``sessions``.

    GV tai (lop c, buoi k, tiet p) = (p + 2c + k) % 5 -> khong trung gio, moi
    buoi cua GV co 3 tiet dang {k, k+1, k+3} (trong 1) hoac {0, 2, 4} (trong
    2): nhieu no "trong 1" de lane gap1 co viec lam.
    """

    n_sub = 5
    n_cls = 3
    class_names, teacher_names, subject_names = [], [], []
    assignments = []
    class_sessions = {}
    for g in range(n_groups):
        for si in range(n_sub):
            teacher_names.append("T%d_%d" % (g, si))
        for cc in range(n_cls):
            c = g * n_cls + cc
            class_names.append("L%d" % c)
            class_sessions[c] = list(sessions)
    for si in range(n_sub):
        subject_names.append("M%d" % si)
    for g in range(n_groups):
        for cc in range(n_cls):
            c = g * n_cls + cc
            for si in range(n_sub):
                assignments.append((c, si, (g * n_sub + si,), len(sessions), 2))
    a_rules = {}
    teacher_rules = {}
    if with_rules:
        # mon 0 lop 0: tranh cap 2-3 sang, toi da 1 khoi doi, 1 buoi/ngay
        a_rules[0] = SubjectRule(one_session_per_day=True, avoid23=(True, False), lesson_blocks=((2, 0, 1),))
        # GV 0: chi sang, <= 3 tiet/ngay, <= 3 tiet/buoi sang, khong tiet 5 sang + 1 chieu
        teacher_rules[0] = TeacherRule(
            max_sessions=len(sessions),
            session_mode=tuple("morning" if 2 * d in sessions else "" for d in range(6)),
            day_period_cap=tuple(3 if 2 * d in sessions else 0 for d in range(6)),
            session_period_cap=tuple((3 if 2 * d in sessions else 0, 0) for d in range(6)),
            no_m5_a1=(True,) * 6,
        )
    cells = []
    for g in range(n_groups):
        for cc in range(n_cls):
            c = g * n_cls + cc
            for k, s in enumerate(sessions):
                for p in range(PERIODS):
                    si = (p + 2 * cc + k) % n_sub
                    ai = (c * n_sub) + si
                    cells.append((c, s * PERIODS + p, ai))
    fixed_cells = [cells[0]] if fixed else []
    P = _problem(
        class_names,
        teacher_names,
        subject_names,
        assignments,
        class_sessions,
        a_rules=a_rules,
        teacher_rules=teacher_rules,
        fixed_cells=fixed_cells,
    )
    soft = _soft(P, cells)
    return P, soft, list(range(len(class_names)))


class AvailableTests(unittest.TestCase):
    def test_env_switch_disables(self) -> None:
        old = os.environ.get("TKB_CPSAT_LNS")
        try:
            os.environ["TKB_CPSAT_LNS"] = "0"
            self.assertFalse(cpsat_lns.available())
        finally:
            if old is None:
                os.environ.pop("TKB_CPSAT_LNS", None)
            else:
                os.environ["TKB_CPSAT_LNS"] = old

    def test_unknown_lane_never_raises(self) -> None:
        P, soft, classes = _latin()
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, "bogus", time_limit=1.0, workers=1)
        self.assertIsNone(cells)
        self.assertIn("error", info)


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class LaneContractTests(unittest.TestCase):
    def _run_lane(self, lane: str) -> None:
        P, soft, classes = _latin()
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        self.assertEqual(soft.penalty(), 0)
        snap = [row[:] for row in soft.grid]
        q0 = soft.quality()
        counts0 = _counts(P, soft.grid)
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, lane, time_limit=15.0, workers=2, seed=3)
        self.assertIsNotNone(cells, info)
        self.assertIn(info["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(info["frozen_teachers"], 0)
        self.assertEqual(info["dropped_classes"], [])
        # dense: moi o tu do co gia tri, o co dinh khong nam trong ket qua
        free = {(c, x) for c in classes for x in range(NUM_SLOTS) if soft.grid[c][x] >= 0 and not soft.locked[c][x]}
        self.assertEqual(set(cells.keys()), free)
        journal = cpsat_lns.apply_cells(soft, cells)
        _refresh(soft)
        self.assertGreater(len(journal), 0)
        q1 = soft.quality()
        self.assertEqual(soft.penalty(), 0)
        if lane == "gap1":
            self.assertLess(q1[3], q0[3], (q0, q1))
            self.assertLessEqual(q1[2], q0[2], (q0, q1))
        else:
            self.assertLess(q1[2], q0[2], (q0, q1))
        self.assertLessEqual(q1[0], q0[0], (q0, q1))
        self.assertLessEqual(q1[1], q0[1], (q0, q1))
        self.assertEqual(_counts(P, soft.grid), counts0)
        for c, x, ai in P.fixed_cells:
            self.assertEqual(soft.grid[c][x], ai)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        # new_touched khop thong ke that (GV bi cham = tat ca GV o fixture nay)
        self.assertEqual(info["new_touched"], [q1[2], q1[0], q1[3], q1[1]])
        cpsat_lns.revert(soft, journal)
        _refresh(soft)
        self.assertEqual(soft.grid, snap)
        self.assertEqual(soft.quality(), q0)
        self.assertEqual(soft.penalty(), 0)

    def test_gap1_lane_improves_and_reverts(self) -> None:
        self._run_lane("gap1")

    def test_sessions_lane_improves_and_reverts(self) -> None:
        self._run_lane("sessions")

    def test_cannot_improve_returns_none(self) -> None:
        # 1 lop, moi GV 1 tiet/buoi -> khong buoi trong 1 nao -> gap1 -1 bat kha thi
        P = _problem(
            ["L0"],
            ["T%d" % i for i in range(5)],
            ["M%d" % i for i in range(5)],
            [(0, si, (si,), 3, 2) for si in range(5)],
            {0: [0, 2, 4]},
        )
        cells = [(0, s * PERIODS + p, p) for s in (0, 2, 4) for p in range(PERIODS)]
        soft = _soft(P, cells)
        self.assertEqual(soft.quality()[3], 0)
        out, info = cpsat_lns.build_and_solve(P, soft, [0], "gap1", time_limit=5.0, workers=1)
        self.assertIsNone(out)
        self.assertEqual(info["status"], "INFEASIBLE", info)
        self.assertEqual(info["cur_touched"][2], 0)

    def test_frozen_teacher_cells_unchanged(self) -> None:
        P, soft, classes = _latin()
        before = {(c, x): soft.grid[c][x] for c in classes for x in range(NUM_SLOTS)}
        cells, info = cpsat_lns.build_and_solve(
            P, soft, classes, "gap1", time_limit=15.0, workers=2, frozen_teachers={0}
        )
        self.assertIsNotNone(cells, info)
        self.assertEqual(info["frozen_teachers"], 1)
        self.assertEqual(info["frozen_reasons"], {0: "caller"})
        for (c, x), ai in before.items():
            if ai >= 0 and 0 in P.a_teachers[ai]:
                self.assertNotIn((c, x), cells)
        q0 = soft.quality()
        journal = cpsat_lns.apply_cells(soft, cells)
        _refresh(soft)
        for (c, x), ai in before.items():
            if ai >= 0 and 0 in P.a_teachers[ai]:
                self.assertEqual(soft.grid[c][x], ai)
        self.assertEqual(soft.penalty(), 0)
        self.assertLess(soft.quality()[3], q0[3])
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        cpsat_lns.revert(soft, journal)

    def test_location_rule_teacher_is_frozen_automatically(self) -> None:
        P, soft, classes = _latin()
        P.teacher_rules[2] = TeacherRule(loc_gap=(True,) * 12)
        P.teacher_loc_rules[2] = True
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=15.0, workers=2)
        self.assertEqual(info["frozen_teachers"], 1)
        self.assertEqual(info["frozen_reasons"], {2: "location_rules"})
        if cells is not None:
            for (c, x), ai in cells.items():
                self.assertNotIn(2, P.a_teachers[ai])
                self.assertNotIn(2, P.a_teachers[soft.grid[c][x]])

    def test_stop_check_stops_quickly(self) -> None:
        P, soft, classes = _latin(n_groups=2, sessions=(0, 2, 4, 6, 8, 10))
        calls = [0]

        def stop_check() -> bool:
            # lan hoi dau tien (truoc khi giai) -> tiep tuc; tu loi giai dau -> dung
            calls[0] += 1
            return calls[0] > 1

        t0 = time.monotonic()
        cells, info = cpsat_lns.build_and_solve(
            P, soft, classes, "gap1", time_limit=30.0, workers=2, stop_check=stop_check, require_improve=False
        )
        elapsed = time.monotonic() - t0
        self.assertLess(elapsed, 2.0, info)
        self.assertTrue(info.get("stopped"), info)
        self.assertEqual(info["status"], "FEASIBLE", info)
        self.assertIsNotNone(cells, info)
        self.assertGreaterEqual(calls[0], 2)

    def test_stop_check_before_solve(self) -> None:
        P, soft, classes = _latin()
        cells, info = cpsat_lns.build_and_solve(
            P, soft, classes, "gap1", time_limit=30.0, workers=1, stop_check=lambda: True
        )
        self.assertIsNone(cells)
        self.assertEqual(info["status"], "STOPPED")

    def test_determinism_same_seed_same_cells(self) -> None:
        P, soft, classes = _latin()
        a, _ = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=15.0, workers=1, seed=5)
        b, _ = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=15.0, workers=1, seed=5)
        self.assertIsNotNone(a)
        self.assertEqual(a, b)


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class CoTeacherTests(unittest.TestCase):
    """Tiet ghep X = (T1, T2) o lop 0; Y cua T2 la hang so (lop 1 ngoai cluster)
    tai sang thu 3 tiet 1-2. Cach DUY NHAT giam buoi cua T1 la dua X vao dung
    gio Y (X chi duoc phep sang T2 hoac sang T3 tiet 1-2; E cua T1 o lop 2 chi
    hoc sang T3) -> model dung phai bao INFEASIBLE; model ngay tho (X chi cua
    T1) se "cai thien" bang cach xep T2 trung gio.

    Luoi vao:  lop0 s0: X A A A A | s2: B B B C C
               lop1 s0: U V V V V | s2: Y Y W W W   (ngoai cluster)
               lop2 s2: G E F F F
    Nuoc ngay tho: X -> s2 tiet 1, B -> s2 tiet 2-3 + s0 tiet 1 (T4 da co s0)."""

    S0, S2 = 0, 2

    def _build(self, naive: bool) -> tuple[Problem, SoftSchedule]:
        S0, S2 = self.S0, self.S2
        members_x = (0,) if naive else (0, 1)
        assignments = [
            (0, 0, members_x, 1, 1),   # ai0 X  lop0 (T1,T2)
            (0, 1, (2,), 4, 4),        # ai1 A  lop0 T3
            (0, 2, (3,), 3, 3),        # ai2 B  lop0 T4
            (0, 3, (4,), 2, 2),        # ai3 C  lop0 T5
            (1, 4, (1,), 2, 2),        # ai4 Y  lop1 T2
            (1, 5, (6,), 3, 3),        # ai5 W  lop1 T7
            (2, 6, (0,), 1, 1),        # ai6 E  lop2 T1
            (2, 7, (5,), 3, 3),        # ai7 F  lop2 T6
            (1, 8, (3,), 4, 4),        # ai8 V  lop1 T4
            (1, 9, (7,), 1, 1),        # ai9 U  lop1 T8
            (2, 10, (8,), 1, 1),       # ai10 G lop2 T9
        ]
        x_allowed = [S0 * PERIODS + p for p in range(PERIODS)] + [S2 * PERIODS, S2 * PERIODS + 1]
        P = _problem(
            ["L0", "L1", "L2"],
            ["T%d" % i for i in range(1, 10)],
            ["X", "A", "B", "C", "Y", "W", "E", "F", "V", "U", "G"],
            assignments,
            {0: [S0, S2], 1: [S0, S2], 2: [S2]},
            allowed_override={0: x_allowed},
        )
        b0, b2 = S0 * PERIODS, S2 * PERIODS
        cells = [(0, b0, 0)] + [(0, b0 + p, 1) for p in range(1, 5)]
        cells += [(0, b2 + p, 2) for p in range(3)] + [(0, b2 + p, 3) for p in range(3, 5)]
        cells += [(1, b0, 9)] + [(1, b0 + p, 8) for p in range(1, 5)]
        cells += [(1, b2 + p, 4) for p in range(2)] + [(1, b2 + p, 5) for p in range(2, 5)]
        cells += [(2, b2, 10), (2, b2 + 1, 6)] + [(2, b2 + p, 7) for p in range(2, 5)]
        soft = _soft(P, cells)
        return P, soft

    @staticmethod
    def _true_conflicts(P_true: Problem, grid: list[list[int]]) -> int:
        seen: dict[tuple[int, int], int] = {}
        for c in range(P_true.num_classes()):
            for x in range(NUM_SLOTS):
                ai = grid[c][x]
                if ai < 0:
                    continue
                for t in P_true.a_teachers[ai]:
                    seen[(t, x)] = seen.get((t, x), 0) + 1
        return sum(v - 1 for v in seen.values() if v > 1)

    def test_co_teacher_occupies_both_rows(self) -> None:
        P, soft = self._build(naive=False)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        cells, info = cpsat_lns.build_and_solve(P, soft, [0, 2], "sessions", time_limit=10.0, workers=1)
        self.assertIsNone(cells, info)
        self.assertEqual(info["status"], "INFEASIBLE", info)
        # khong ep cai thien: loi giai bat ky cung khong duoc trung gio T2
        cells, info = cpsat_lns.build_and_solve(P, soft, [0, 2], "sessions", time_limit=10.0, workers=1, require_improve=False)
        self.assertIsNotNone(cells, info)
        journal = cpsat_lns.apply_cells(soft, cells)
        self.assertEqual(self._true_conflicts(P, soft.grid), 0)
        self.assertEqual(soft.penalty(), 0)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        cpsat_lns.revert(soft, journal)

    def test_naive_single_teacher_model_would_double_book(self) -> None:
        # chung minh fixture co y nghia: bo T2 khoi X thi model tim ra "cai
        # thien" ma theo thanh vien that la trung gio T2.
        P_true, _ = self._build(naive=False)
        P_naive, soft = self._build(naive=True)
        cells, info = cpsat_lns.build_and_solve(P_naive, soft, [0, 2], "sessions", time_limit=10.0, workers=1)
        self.assertIsNotNone(cells, info)
        cpsat_lns.apply_cells(soft, cells)
        self.assertGreater(self._true_conflicts(P_true, soft.grid), 0)


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class ClassRuleTests(unittest.TestCase):
    """Lop hoc 4 buoi (T2 sang/chieu, T3 sang/chieu), 4 mon x 5 tiet, moi mon
    tron 1 buoi. Luat: A,B khong cung ngay; C,D khong cung buoi (+ luat nhom
    tuong duong); GV_A tran 5 tiet/lop/buoi; timeLimit: <= 1 mon nhom g tai
    moi o (nhom = {C, D}) va <= 2 lop tai moi o cho mon A."""

    SESS = (0, 1, 2, 3)

    def _build(self) -> tuple[Problem, SoftSchedule]:
        # lop 0: A(T2s) C(T2c) B(T3s) D(T3c); lop 1: C A D B
        assignments = []
        for c in range(2):
            for si in range(4):
                assignments.append((c, si, (si,), 5, 5))
        grule = SubjectRule(max_subjects_part=(1, 1), session_part_cap=(5, 5))
        tl_rule = {
            "targetType": "subjectGroup",
            "targetId": "g",
            "perSlot": {"subjects": 1},
        }
        tl_rule2 = {"targetType": "subject", "targetId": "A", "perSlot": {"classes": 2}, "perSession": {"classes": 2}}
        P = _problem(
            ["L0", "L1"],
            ["TA", "TB", "TC", "TD"],
            ["A", "B", "C", "D"],
            assignments,
            {0: list(self.SESS), 1: list(self.SESS)},
            teacher_rules={0: TeacherRule(class_period_caps=((None, 5, 5),))},
            no_same_day={0: [frozenset({0, 1})], 1: [frozenset({0, 1})]},
            no_same_session={0: [frozenset({2, 3})], 1: [frozenset({2, 3})]},
            subject_groups={2: ("g",), 3: ("g",)},
            group_rule_keys={(0, "g"): grule, (1, "g"): grule},
            time_limit_rules=(tl_rule, tl_rule2),
            raw_groups={"subject": {"g": frozenset({"C", "D"})}},
        )
        layout = {0: [0, 2, 1, 3], 1: [2, 0, 3, 1]}
        cells = []
        for c, order in layout.items():
            for k, s in enumerate(self.SESS):
                si = order[k]
                for p in range(PERIODS):
                    cells.append((c, s * PERIODS + p, c * 4 + si))
        soft = _soft(P, cells)
        return P, soft

    def test_solution_respects_class_rules_and_time_limits(self) -> None:
        P, soft = self._build()
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        found = 0
        for seed in range(4):
            cells, info = cpsat_lns.build_and_solve(
                P, soft, [0, 1], "sessions", time_limit=10.0, workers=1, seed=seed, require_improve=False
            )
            self.assertIsNotNone(cells, info)
            self.assertEqual(info["time_limit_rules"], 2)
            journal = cpsat_lns.apply_cells(soft, cells)
            _refresh(soft)
            found += len(journal)
            self.assertEqual(soft.penalty(), 0)
            ok, reason = _hard_ok(P, soft.grid)
            self.assertTrue(ok, reason)
            cpsat_lns.revert(soft, journal)
            _refresh(soft)
        self.assertGreaterEqual(found, 0)

    def test_time_limit_blocks_forbidden_overlap(self) -> None:
        # Bo luat lop, chi giu timeLimit "mon A: <= 1 lop moi o": lop 0 va 1
        # khong duoc hoc A cung gio -> moi loi giai deu tach A cua hai lop.
        assignments = [(c, si, (si,), 5, 5) for c in range(2) for si in range(2)]
        P = _problem(
            ["L0", "L1"],
            ["TA", "TB"],
            ["A", "B"],
            assignments,
            {0: [0, 2], 1: [0, 2]},
            time_limit_rules=({"targetType": "subject", "targetId": "A", "perSlot": {"classes": 1}},),
        )
        # lop 0: A(T2 sang) B(T3 sang); lop 1: B A
        cells = [(0, p, 0) for p in range(5)] + [(0, 10 + p, 1) for p in range(5)]
        cells += [(1, p, 3) for p in range(5)] + [(1, 10 + p, 2) for p in range(5)]
        soft = _soft(P, cells)
        ok, reason = _hard_ok(P, soft.grid)
        self.assertTrue(ok, reason)
        for seed in range(3):
            out, info = cpsat_lns.build_and_solve(
                P, soft, [0, 1], "gap1", time_limit=5.0, workers=1, seed=seed, require_improve=False
            )
            self.assertIsNotNone(out, info)
            for x in range(NUM_SLOTS):
                a0 = out.get((0, x), -1)
                a1 = out.get((1, x), -1)
                self.assertFalse(a0 == 0 and a1 == 2, (x, out))


@unittest.skipUnless(HAS_ORTOOLS, "ortools CP-SAT khong co san")
class DropAndErrorTests(unittest.TestCase):
    def test_duplicate_subject_with_two_variable_assignments_drops_class(self) -> None:
        P, soft, classes = _latin()
        # them phan cong thu 2 cung mon 0 cho lop 0 (GV khac) va dat 1 o
        P.a_class.append(0)
        P.a_subject.append(0)
        P.a_teacher.append(1)
        P.a_teachers.append((1,))
        P.a_room.append("")
        P.a_periods.append(1)
        P.a_cap.append(2)
        P.a_allowed.append(bytearray(P.class_avail[0]))
        P.a_rule.append(P.a_rule[0])
        P.a_teacher_label.append("")
        P.a_loc.append(-1)
        soft2 = SoftSchedule(P)
        for c in range(P.num_classes()):
            for x in range(NUM_SLOTS):
                if soft.grid[c][x] >= 0:
                    soft2.set_cell(c, x, soft.grid[c][x])
        soft2.locked[0][0] = 1
        # doi mot o mon 1 (lop 0, buoi 2) thanh phan cong moi -> 2 phan cong mon 0 co o tu do
        x = 2 * PERIODS + 1
        soft2.set_cell(0, x, -1)
        soft2.set_cell(0, x, P.num_assignments() - 1)
        soft2.enable_quality_tracking()
        cells, info = cpsat_lns.build_and_solve(P, soft2, classes, "gap1", time_limit=5.0, workers=1, require_improve=False)
        self.assertEqual([c for c, _r in info["dropped_classes"]], [0])
        self.assertTrue(info["dropped_classes"][0][1].startswith("duplicate_subject_variable"))
        self.assertEqual(info["classes"], 2)
        if cells is not None:
            self.assertFalse(any(c == 0 for c, _x in cells))

    def test_unencodable_cell_returns_error_not_exception(self) -> None:
        P, soft, classes = _latin()
        # phan cong 3 (lop 0, mon 3) chi duoc phep o dung cac o dang giu -> van co
        # ung vien; cam het -> khong ung vien -> error, khong nem
        P.a_allowed[3] = bytearray(NUM_SLOTS)
        cells, info = cpsat_lns.build_and_solve(P, soft, classes, "gap1", time_limit=5.0, workers=1)
        self.assertIsNone(cells)
        self.assertIn("no candidate", info["error"])


if __name__ == "__main__":
    unittest.main()
