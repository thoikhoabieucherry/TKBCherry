"""19/09: phase3 emits optimize:quality BEFORE structural_floors completes."""

from __future__ import annotations

import time
import unittest
from unittest import mock

from tkb_engine_v3.construct import Constructor, SoftSchedule
from tkb_engine_v3.core import Problem, compile_problem


def _tiny_problem() -> Problem:
    # Minimal UI: 1 class, 1 teacher, 2 periods — enough to enter phase3.
    ui = {
        "lop": [{"id": "L1", "ten": "6A1", "ten2": "6A1", "khoi": "Khối 6"}],
        "giaovien": [{"magv": "GV1", "hodem": "A", "ten": "1"}],
        "monhoc": [{"ma": "TOAN", "ten": "Toán"}],
        "mon": [{"khoi": "Khối 6", "ten": "TOAN", "sotiet": "2"}],
        "pccmMatrix": {"6A1|TOAN": "GV1"},
        "pccmTietMatrix": {"6A1|TOAN": "2"},
        "pccmGioihanMatrix": {"6A1|TOAN": "2"},
        "tkb": {
            "L1": {
                "thu2": {"sang": ["TOAN", "TOAN", "", "", ""], "chieu": ["", "", "", "", ""]},
                "thu3": {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]},
                "thu4": {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]},
                "thu5": {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]},
                "thu6": {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]},
                "thu7": {"sang": ["", "", "", "", ""], "chieu": ["", "", "", "", ""]},
            }
        },
        "tkbConstraints": {},
    }
    from tkb_new.adapter import build_school_data_from_ui

    ctx = build_school_data_from_ui(ui)
    return compile_problem(ctx, ctx.rules, [])


class EmitBeforeFloorsTests(unittest.TestCase):
    def test_quality_progress_emitted_before_floors_return(self):
        problem = _tiny_problem()
        ctor = Constructor(problem, seed=1)
        ctor.quality_focus = "gap1"
        soft = SoftSchedule(problem)
        # Place the two TOAN lessons into warm grid.
        ai = 0
        soft.set_cell(0, 0, ai)
        soft.set_cell(0, 1, ai)
        soft.enable_quality_tracking()

        events: list[str] = []
        floors_started = {"at": None}

        real_floors = ctor.structural_floors

        def slow_floors():
            floors_started["at"] = time.monotonic()
            time.sleep(0.05)
            return real_floors()

        def progress(evt):
            events.append(str(evt.get("stage") or ""))
            if evt.get("stage") == "optimize:quality" and floors_started["at"] is None:
                events.append("quality_before_floors")

        with mock.patch.object(ctor, "structural_floors", side_effect=slow_floors):
            ctor.phase3_quality(soft, time.monotonic() + 0.2, progress=progress)

        self.assertIn("optimize:quality", events)
        self.assertIn(
            "quality_before_floors",
            events,
            "first optimize:quality must fire before structural_floors starts",
        )


if __name__ == "__main__":
    unittest.main()
