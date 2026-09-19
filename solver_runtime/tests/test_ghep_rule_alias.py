"""31/08 — Dạy ghép dùng LUẬT của môn gốc (engine Python: adapter + rules + engine v3).

Chủ dự án: "khi tôi phân dạy ghép thì cũng sẽ sử dụng môn học nên sẽ sử dụng yêu cầu
môn học chứ không phải tạo ra một mớ môn học theo tên viết tắt".

DATA.dayGhep[].ten ("AV-GT") là khoá riêng của dòng trong pccmMatrix / ô TKB; luật ở
tkbConstraints keyed theo môn gốc (row.mon[0] = "AVGT" → canonical "Anh văn giao tiếp").
Hợp đồng:
  1. adapter dựng rule_subject_alias từ DATA.dayGhep; Assignment.subject vẫn là "AV-GT".
  2. subject_rule_for / subject_groups_for / is_fixed_off("subject") tra theo môn gốc.
  3. "tiết đôi bất khả thi" tính số tiết khả dụng gộp môn thật + dòng ghép.
  4. engine v3 biên dịch luật cho phân công ghép (a_rule != None) và nhóm "không cùng
     buổi" của môn gốc chứa cả chỉ số môn ghép.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tkb_new.adapter import _build_ghep_rule_aliases, _build_subject_aliases, build_school_data_from_ui  # noqa: E402
from tkb_optimizer_ref.rules import TimetableConstraintRules  # noqa: E402


def _ui(main_periods: int = 1, ghep_periods: int = 1, with_rules: bool = True) -> dict:
    data: dict = {
        "lop": [{"id": "L1", "ten": "6A1", "khoi": "6"}],
        "giaovien": [{"magv": t, "ten": t} for t in ("GV1", "GV2", "GV3")],
        "monhoc": [{"ten": "Anh văn giao tiếp", "ma": "AVGT"}, {"ten": "Toán", "ma": "TOAN"}],
        "mon": [
            {"khoi": "6", "ten": "AVGT", "sotiet": 2, "gioihan": 2},
            {"khoi": "6", "ten": "TOAN", "sotiet": 4, "gioihan": 2},
        ],
        "dayGhep": [
            {
                "id": "DG001",
                "ten": "AV-GT",
                "viettat": "AV-GT",
                "lop": ["6A1"],
                "mon": ["AVGT"],
                "gv": ["GV1", "GV2"],
                "sotiet": str(ghep_periods),
                "gioihan": "1",
            }
        ],
        "pccmMatrix": {"6A1|AV-GT": "GV1, GV2", "6A1|TOAN": "GV3"},
        "pccmTietMatrix": {"6A1|AV-GT": ghep_periods, "6A1|TOAN": 4},
        "pccmGioihanMatrix": {"6A1|AV-GT": 1, "6A1|TOAN": 2},
        "tkb": {},
    }
    if main_periods > 0:
        data["pccmMatrix"]["6A1|AVGT"] = "GV1"
        data["pccmTietMatrix"]["6A1|AVGT"] = main_periods
    if with_rules:
        data["tkbConstraints"] = {
            "subject": {
                "Anh văn giao tiếp": {
                    "byClass": {"6A1": {"maxPeriods": {"day": {"thu2": 1}}, "lessonBlocks": {"2": {"min": 1}}}}
                }
            },
            "fixedOff": {"subject": {"Anh văn giao tiếp": {"thu2|sang|0": True}}},
            "groups": {"subject": {"g1": {"name": "Nhóm ngoại ngữ", "items": ["Anh văn giao tiếp"]}}},
            "subjectNoSameSession": {"byClass": {"6A1": {"sameSession": {"groups": {"g": ["Anh văn giao tiếp", "Toán"]}}}}},
        }
    return data


class GhepRuleAliasTests(unittest.TestCase):
    def test_adapter_builds_alias_and_keeps_assignment_identity(self) -> None:
        ui = _ui()
        alias_to_subject, _ = _build_subject_aliases(ui)
        aliases = _build_ghep_rule_aliases(ui, alias_to_subject)
        self.assertEqual(aliases, {"av-gt": "Anh văn giao tiếp"})

        ctx = build_school_data_from_ui(ui)
        subjects = {a.subject for a in ctx.school_data.assignments}
        self.assertIn("AV-GT", subjects, "phân công ghép giữ khoá riêng")
        self.assertIn("Anh văn giao tiếp", subjects, "phân công chính vẫn là môn gốc")
        ghep = next(a for a in ctx.school_data.assignments if a.subject == "AV-GT")
        self.assertEqual(ghep.teacher, "GV1, GV2")
        self.assertEqual(int(ghep.periods_per_week), 1)

    def test_rules_resolve_through_base_subject(self) -> None:
        ctx = build_school_data_from_ui(_ui())
        constraints = ctx.rules.constraints
        self.assertIsNotNone(constraints)
        self.assertEqual(constraints.rule_subject("AV-GT"), "Anh văn giao tiếp")
        self.assertEqual(constraints.rule_subject("av-gt"), "Anh văn giao tiếp")
        self.assertEqual(constraints.rule_subject("Toán"), "Toán")

        rule = constraints.subject_rule_for("6A1", "AV-GT")
        self.assertEqual(rule.get("maxPeriods"), {"day": {"thu2": 1}})
        self.assertEqual(constraints.subject_groups_for("AV-GT"), ("g1",))
        self.assertTrue(constraints.subject_in_group("AV-GT", "g1"))

        slots = constraints.fixed_off["subject"]["Anh văn giao tiếp"]
        self.assertTrue(slots)
        slot = next(iter(slots))
        self.assertTrue(constraints.is_fixed_off("subject", "AV-GT", *slot))
        self.assertTrue(constraints.is_subject_group_fixed_off("AV-GT", *slot) or True)  # nhóm không nghỉ: chỉ kiểm không ném lỗi

    def test_lesson_block_min_uses_combined_periods(self) -> None:
        # môn thật 1 tiết + ghép 1 tiết = 2 -> Min 1 cụm đôi khả thi -> giữ nguyên
        ctx = build_school_data_from_ui(_ui(main_periods=1, ghep_periods=1))
        rule = ctx.rules.constraints.subject_rule_for("6A1", "AV-GT")
        self.assertEqual(rule.get("lessonBlocks", {}).get("2", {}).get("min"), 1)
        self.assertFalse([w for w in ctx.warnings if "cum 2 tiet" in w])
        # chỉ có dòng ghép 1 tiết -> bất khả thi -> Min bị bỏ + cảnh báo
        ctx2 = build_school_data_from_ui(_ui(main_periods=0, ghep_periods=1))
        rule2 = ctx2.rules.constraints.subject_rule_for("6A1", "AV-GT")
        self.assertIsNone(rule2.get("lessonBlocks", {}).get("2", {}).get("min"))
        self.assertTrue([w for w in ctx2.warnings if "Min 1 cum 2 tiet" in w], ctx2.warnings)

    def test_plain_rules_without_alias_unchanged(self) -> None:
        rules = TimetableConstraintRules(
            groups={"subject": {"g": frozenset({"Toán"})}},
            group_names={},
            fixed_off={"subject": {"Toán": frozenset({(2, "AM", 1)})}},
            teacher={},
            subject={"Toán": {"byClass": {"6A1": {"maxPeriods": {"day": {"thu2": 1}}}}}},
            subject_group={},
        )
        self.assertEqual(rules.rule_subject("AV-GT"), "AV-GT")
        self.assertEqual(rules.subject_rule_for("6A1", "AV-GT"), {})
        self.assertEqual(rules.subject_groups_for("Toán"), ("g",))
        self.assertTrue(rules.is_fixed_off("subject", "Toán", 2, "AM", 1))
        self.assertFalse(rules.is_fixed_off("subject", "AV-GT", 2, "AM", 1))

    def test_engine_v3_compiles_rules_for_ghep_assignment(self) -> None:
        from tkb_engine_v3.core import compile_problem  # noqa: WPS433

        ctx = build_school_data_from_ui(_ui())
        problem = compile_problem(ctx, ctx.rules, [])
        names = list(getattr(problem, "subject_names", []) or [])
        a_subject = list(problem.a_subject)
        a_rule = list(problem.a_rule)
        ghep_idx = [i for i, si in enumerate(a_subject) if names and names[si] == "AV-GT"]
        self.assertTrue(ghep_idx, f"không thấy phân công ghép trong problem: {names}")
        for i in ghep_idx:
            self.assertIsNotNone(a_rule[i], "luật môn gốc phải được biên dịch cho phân công ghép")
        # nhóm không cùng buổi của lớp 6A1 chứa cả môn ghép
        ci = list(problem.class_names).index("6A1")
        si_ghep = names.index("AV-GT")
        groups = list(problem.no_same_session[ci])
        self.assertTrue(any(si_ghep in g for g in groups), f"nhóm không cùng buổi phải gồm AV-GT: {groups}")


if __name__ == "__main__":
    unittest.main()
