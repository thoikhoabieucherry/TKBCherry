"""Cherry engine v3 — 07/10/2026: tiet chung nhieu lop THA TU DO.

Chu du an (THCS An Phu kkhg52etp92): "toi muon ban fix ko co dinh nhu vay nua khi
xep, cu bam cherry la 2 tiet do lai co dinh". Trinh duyet ghim TAM tiet chung
(KNS/STEM 6A2-4) vao o dau tien ca nhom cung trong (sang T2 tiet 3-4), engine coi
la o co dinh -> co Vy (chi ranh sang T2 + chieu T3) mat 2-3 tiet Van 6A2.

1. CP-SAT (cpsat_lns) buoc ca nhom (P.joint_sync) cung o: doi tiet chung de xep
   tiet chi co mot cho duy nhat.
2. compile_problem(joint_groups=): lop dau giu GV, lop khac khong GV, o hop le
   chung cua ca nhom.
3. solve_from_ui_data_v3 voi settings.cherry_joint_movable: tiet chung doi cho,
   ca nhom cung o, xep du tiet; payload bao solver.engine_v3.joint_free. Khong co
   khoa thi giu cach cu (o ghim la o co dinh).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_engine_v3_cpsat_lns import _problem, _soft  # noqa: E402
from tkb_engine_v3 import cpsat_lns  # noqa: E402
from tkb_engine_v3.core import NUM_SLOTS, compile_problem  # noqa: E402
from tkb_engine_v3.entry import solve_from_ui_data_v3  # noqa: E402
from tkb_engine_v3.joint import joint_groups_from_fixed, movable_joint_keys  # noqa: E402
from tkb_optimizer_ref.models import Lesson  # noqa: E402

HAS_ORTOOLS = cpsat_lns.available()


@unittest.skipUnless(HAS_ORTOOLS, "ortools khong co")
class CpsatJointSyncTests(unittest.TestCase):
    def _problem(self):
        # 3 lop, buoi 0 (5 tiet). Tiet chung J (1 tiet): lop 0 mang GV0, lop 1-2
        # khong GV. Lop 0: V (GV1, CHI duoc o 0) + M (GV2, 3 tiet). Lop 1/2: N
        # (GV3/GV4, 4 tiet). Xuat phat: J o o 0 ca 3 lop -> V khong co cho.
        assignments = [
            (0, 0, (0,), 1, 1),   # ai0 J lop 0 (dau nhom, GV0)
            (1, 0, (), 1, 1),     # ai1 J lop 1
            (2, 0, (), 1, 1),     # ai2 J lop 2
            (0, 1, (1,), 1, 1),   # ai3 V lop 0, chi o 0
            (0, 2, (2,), 3, 3),   # ai4 M lop 0
            (1, 3, (3,), 4, 4),   # ai5 N lop 1
            (2, 3, (4,), 4, 4),   # ai6 N lop 2
        ]
        P = _problem(["A", "B", "C"], ["G0", "G1", "G2", "G3", "G4"], ["J", "V", "M", "N"], assignments,
                     {0: [0], 1: [0], 2: [0]}, allowed_override={3: [0]})
        P.joint_sync = [(0, 1, 2)]
        cells = [(0, 0, 0), (1, 0, 1), (2, 0, 2), (0, 1, 4), (0, 2, 4), (0, 3, 4),
                 (1, 1, 5), (1, 2, 5), (1, 3, 5), (1, 4, 5), (2, 1, 6), (2, 2, 6), (2, 3, 6), (2, 4, 6)]
        return P, _soft(P, cells)

    def test_group_moves_together_to_place_only_slot_lesson(self) -> None:
        P, soft = self._problem()
        new_cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1, 2], "fill", time_limit=10, workers=2, require_improve=False, fill_quality=True,
        )
        self.assertIsNotNone(new_cells, info)
        self.assertGreater(info.get("joint_sync", 0), 0)
        self.assertEqual(info.get("unplaced"), 0, info)
        cpsat_lns.apply_cells(soft, new_cells)
        self.assertEqual(soft.grid[0][0], 3)   # V vao o duy nhat
        pos = [tuple(x for x in range(NUM_SLOTS) if soft.grid[c][x] == ai) for c, ai in ((0, 0), (1, 1), (2, 2))]
        self.assertEqual(len(set(pos)), 1, pos)
        self.assertNotEqual(pos[0], (0,))
        self.assertEqual(soft.overlap, 0)

    def test_without_sync_followers_may_split(self) -> None:
        # doi chung: khong co joint_sync thi lop 1/2 khong bi buoc theo lop 0
        P, soft = self._problem()
        P.joint_sync = []
        new_cells, info = cpsat_lns.build_and_solve(
            P, soft, [0, 1, 2], "fill", time_limit=10, workers=2, require_improve=False, fill_quality=True,
        )
        self.assertIsNotNone(new_cells, info)
        self.assertEqual(info.get("joint_sync"), 0)

    def test_out_of_sync_constant_rejected(self) -> None:
        # lop 0 (dau nhom) va lop 2 ngoai cum: J o o 0 va o 4 -> mau thuan hang so
        P, soft = self._problem()
        soft.set_cell(2, 0, 6)
        soft.set_cell(2, 4, 2)
        new_cells, info = cpsat_lns.build_and_solve(
            P, soft, [1], "fill", time_limit=5, workers=1, require_improve=False, fill_quality=True,
        )
        self.assertIsNone(new_cells)
        self.assertIn("out of sync", str(info.get("error")))

    def test_free_member_tied_to_constant_members(self) -> None:
        # chi lop 1 trong cum: J cua lop 1 bi buoc o dung o cua lop 0/2 (hang so)
        P, soft = self._problem()
        new_cells, info = cpsat_lns.build_and_solve(
            P, soft, [1], "fill", time_limit=5, workers=1, require_improve=False, fill_quality=True,
        )
        self.assertIsNotNone(new_cells, info)
        cpsat_lns.apply_cells(soft, new_cells)
        self.assertEqual(soft.grid[1][0], 1)
        # lop 0 dang mau thuan voi lop 1 (J o 4) ma lop 0 la bien -> vo nghiem, khong tra luoi lech
        P2, soft2 = self._problem()
        soft2.set_cell(1, 0, 5)
        soft2.set_cell(1, 4, 1)
        new2, info2 = cpsat_lns.build_and_solve(
            P2, soft2, [0], "fill", time_limit=5, workers=1, require_improve=False, fill_quality=True,
        )
        self.assertIsNone(new2)
        self.assertEqual(info2.get("status"), "INFEASIBLE", info2)


class JointGroupingTests(unittest.TestCase):
    def test_groups_by_subject_and_slot_set(self) -> None:
        mk = lambda cls, subj, day, sess, p: Lesson(class_name=cls, grade="6", day=day, session=sess, period=p, subject=subj, teacher="T")
        fixed = [
            mk("6A2", "KNS (ghép)", 2, "AM", 3), mk("6A3", "KNS (ghép)", 2, "AM", 3), mk("6A4", "KNS (ghép)", 2, "AM", 3),
            # 2 dong cung khoa "TANN (ghép)" o 2 o khac nhau
            mk("6A1", "TANN (ghép)", 2, "PM", 1), mk("6A2", "TANN (ghép)", 2, "PM", 1),
            mk("7B1", "TANN (ghép)", 2, "AM", 3), mk("7B2", "TANN (ghép)", 2, "AM", 3),
            # dong mot lop (nguoi dung co dinh) khong phai nhom
            mk("6B1", "TANN (ghép)", 4, "PM", 1),
            mk("6A2", "HĐTN", 2, "AM", 1),
        ]
        groups = joint_groups_from_fixed(fixed, ["KNS (ghép)", "TANN (ghép)"])
        self.assertEqual(
            [(s, cls) for s, cls, _slots in groups],
            [("KNS (ghép)", ["6A2", "6A3", "6A4"]), ("TANN (ghép)", ["7B1", "7B2"]), ("TANN (ghép)", ["6A1", "6A2"])],
        )

    def test_movable_keys(self) -> None:
        self.assertEqual(movable_joint_keys({"cherry_joint_movable": [" KNS (ghép) ", "KNS (ghép)", "", "STEM"]}), ["KNS (ghép)", "STEM"])
        self.assertEqual(movable_joint_keys({}), [])


# --- truong thu: 3 lop, KNS (ghép) 1 tiet ca 3 lop, co Vy chi ranh thu 2 sang tiet 1 ---
CLASSES = [("L1", "6/1"), ("L2", "6/2"), ("L3", "6/3")]
JOINT = "KNS (ghép)"


def _school(*, pinned: bool = True) -> dict:
    data: dict = {
        "lop": [{"id": cid, "ten": name, "khoi": "6"} for cid, name in CLASSES],
        "giaovien": [],
        "monhoc": [{"ten": s, "ma": s.upper()} for s in ("Toan", "Anh", "Van", "KNS")],
        "mon": [
            {"khoi": "6", "ten": "Toan", "sotiet": 4, "gioihan": 2},
            {"khoi": "6", "ten": "Anh", "sotiet": 3, "gioihan": 2},
            {"khoi": "6", "ten": "Van", "sotiet": 1, "gioihan": 1},
        ],
        "dayGhep": [{"id": "DG1", "lop": [n for _c, n in CLASSES], "mon": ["KNS"], "gv": ["GV_KNS"],
                     "sotiet": "1", "gioihan": "1", "viettat": "KNS", "ten": JOINT}],
        "pccmMatrix": {},
        "pccmTietMatrix": {},
        "pccmGioihanMatrix": {},
        "tkbConstraints": {"fixedOff": {"class": {cid: {} for cid, _n in CLASSES}, "teacher": {}}},
        "tkb": {},
    }
    teachers = {"GV_KNS", "GV_VY"}
    for i, (cid, _name) in enumerate(CLASSES, start=1):
        for subj, n, cap, gv in (("Toan", 4, 2, f"GV_T{i}"), ("Anh", 3, 2, f"GV_A{i}"), ("Van", 1, 1, "GV_VY" if i == 1 else f"GV_V{i}")):
            data["pccmMatrix"][f"{cid}|{subj}"] = gv
            data["pccmTietMatrix"][f"{cid}|{subj}"] = n
            data["pccmGioihanMatrix"][f"{cid}|{subj}"] = cap
            teachers.add(gv)
        data["pccmMatrix"][f"{cid}|{JOINT}"] = "GV_KNS"
        data["pccmTietMatrix"][f"{cid}|{JOINT}"] = 1
        data["pccmGioihanMatrix"][f"{cid}|{JOINT}"] = 1
    data["giaovien"] = [{"magv": t, "ten": t} for t in sorted(teachers)]
    # co Vy chi ranh thu 2 sang tiet 1
    data["tkbConstraints"]["fixedOff"]["teacher"]["GV_VY"] = {
        f"thu{d}|{b}|{p}": True for d in range(2, 8) for b in ("sang", "chieu") for p in range(5)
        if not (d == 2 and b == "sang" and p == 0)
    }
    joint = {"mon": JOINT, "fixed": True, "jointPin": True} if pinned else JOINT
    for cid, _name in CLASSES:
        data["tkb"][cid] = {
            "thu2": {"sang": [dict(joint) if isinstance(joint, dict) else joint, "Toan", "Toan", "Anh", "Anh"], "chieu": ["", "", "", "", ""]},
            "thu3": {"sang": ["Toan", "Toan", "Anh", "" if cid == "L1" else "Van", ""], "chieu": ["", "", "", "", ""]},
        }
    return data


def _settings(seconds: int, **extra) -> dict:
    out = {
        "engine": "cherry",
        "overall_time_limit_seconds": seconds,
        "num_workers": 1,
        "random_seed": 5,
        "require_complete_schedule": False,
        "preserve_fixed_lessons_only": True,
        "cpsat_threads": 2,
    }
    out.update(extra)
    return out


def _joint_slots(payload: dict) -> dict[str, set]:
    out: dict[str, set] = {}
    for lesson in payload.get("lessons") or []:
        if lesson.get("subject") == JOINT:
            out.setdefault(lesson["classId"], set()).add((lesson["day"], lesson["session"], lesson["period"]))
    return out


@unittest.skipUnless(HAS_ORTOOLS, "ortools khong co")
class JointFreeEndToEndTests(unittest.TestCase):
    def test_compile_joint_groups_leader_keeps_teacher(self) -> None:
        from tkb_new.adapter import build_school_data_from_ui

        ctx = build_school_data_from_ui(_school(pinned=False))
        P = compile_problem(ctx, ctx.rules, [], joint_groups=[(JOINT, [n for _c, n in CLASSES])])
        self.assertEqual(len(P.joint_sync), 1)
        lead, *followers = P.joint_sync[0]
        self.assertEqual(P.teacher_names[P.a_teacher[lead]], "GV_KNS")
        for ai in followers:
            self.assertEqual(P.a_teachers[ai], ())
            self.assertEqual(P.a_teacher_label[ai], "GV_KNS")
        self.assertEqual(bytes(P.a_allowed[lead]), bytes(P.a_allowed[followers[0]]))

    def test_pinned_joint_moves_so_only_slot_lesson_fits(self) -> None:
        payload = solve_from_ui_data_v3(_school(), _settings(30, cherry_joint_movable=[JOINT]))
        jf = ((payload.get("solver") or {}).get("engine_v3") or {}).get("joint_free") or {}
        self.assertEqual(jf.get("status"), "accepted", jf)
        self.assertTrue(jf.get("moved"), jf)
        metrics = payload.get("metrics") or {}
        self.assertEqual(int(metrics.get("scheduled_periods") or 0), 27, payload.get("unassignedLessons"))
        self.assertTrue(metrics.get("hard_ok"), metrics)
        slots = _joint_slots(payload)
        self.assertEqual(set(slots), {"L1", "L2", "L3"})
        self.assertEqual(len({frozenset(v) for v in slots.values()}), 1, slots)
        self.assertNotIn((2, "AM", 1), slots["L1"])
        van = [l for l in payload["lessons"] if l["classId"] == "L1" and l["subject"] == "Van"]
        self.assertEqual([(l["day"], l["session"], l["period"]) for l in van], [(2, "AM", 1)])
        # GV tiet chung xuat dung o moi lop
        self.assertEqual({l["teacher"] for l in payload["lessons"] if l["subject"] == JOINT}, {"GV_KNS"})

    def test_without_keys_pin_stays_fixed(self) -> None:
        payload = solve_from_ui_data_v3(_school(), _settings(12))
        self.assertNotIn("joint_free", (payload.get("solver") or {}).get("engine_v3") or {})
        slots = _joint_slots(payload)
        self.assertEqual({frozenset(v) for v in slots.values()}, {frozenset({(2, "AM", 1)})})
        self.assertLess(int((payload.get("metrics") or {}).get("scheduled_periods") or 0), 27)


if __name__ == "__main__":
    unittest.main()
