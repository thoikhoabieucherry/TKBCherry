from __future__ import annotations

import sys
import unittest
from pathlib import Path


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from tkb_optimizer_ref.models import Assignment, Session  # noqa: E402
from tkb_optimizer_ref.rules import TimetableConstraintRules  # noqa: E402
from tkb_optimizer_ref.session_milp import (  # noqa: E402
    AssignmentSessionDomainMemo,
    _assignment_available_periods,
    _assignment_block_allowed,
    _assignment_period_capacity,
    _assignment_session_allowed,
    _assignment_session_cap,
)


def _constraints() -> TimetableConstraintRules:
    return TimetableConstraintRules(
        groups={"subject": {"core": frozenset({"Math"})}},
        group_names={"subject": {"core": "Core"}},
        fixed_off={
            "class": {"6/1": frozenset({(2, "AM", 5)})},
            "teacher": {"T1": frozenset({(2, "AM", 4)})},
            "subject": {"Math": frozenset({(2, "AM", 3)})},
            "room": {"R1": frozenset({(2, "PM", 5)})},
            "subjectGroup": {"core": frozenset({(2, "PM", 4)})},
        },
        teacher={},
        subject={
            "Math": {
                "byClass": {
                    "6/1": {
                        "sessionAllowed": {
                            "allowMorning": True,
                            "allowAfternoon": False,
                        },
                        "maxPeriods": {"sang": 2},
                        "avoidBreakPair23": {"morning": True},
                    }
                }
            }
        },
        subject_group={},
    )


class AssignmentSessionDomainMemoTests(unittest.TestCase):
    def test_memo_preserves_every_domain_answer_and_reuses_entries(self) -> None:
        constraints = _constraints()
        assignment = Assignment("6/1", "6", "Math", "T1", 4, 3, "R1")
        sessions = (Session(2, "AM"), Session(2, "PM"))
        memo = AssignmentSessionDomainMemo(constraints)

        for session in sessions:
            expected_periods = _assignment_available_periods(
                assignment,
                session,
                constraints,
            )
            expected_allowed = _assignment_session_allowed(
                assignment,
                session,
                constraints,
            )
            expected_capacity = _assignment_period_capacity(
                assignment,
                session,
                constraints,
            )
            expected_cap = _assignment_session_cap(
                assignment,
                session,
                3,
                constraints,
            )

            for _ in range(2):
                self.assertEqual(
                    _assignment_available_periods(
                        assignment,
                        session,
                        constraints,
                        memo=memo,
                    ),
                    expected_periods,
                )
                self.assertEqual(
                    _assignment_session_allowed(
                        assignment,
                        session,
                        constraints,
                        memo=memo,
                    ),
                    expected_allowed,
                )
                self.assertEqual(
                    _assignment_period_capacity(
                        assignment,
                        session,
                        constraints,
                        memo=memo,
                    ),
                    expected_capacity,
                )
                self.assertEqual(
                    _assignment_session_cap(
                        assignment,
                        session,
                        3,
                        constraints,
                        memo=memo,
                    ),
                    expected_cap,
                )
                for start in range(1, 6):
                    for duration in range(1, 4):
                        self.assertEqual(
                            _assignment_block_allowed(
                                assignment,
                                session,
                                start,
                                duration,
                                constraints,
                                memo=memo,
                            ),
                            _assignment_block_allowed(
                                assignment,
                                session,
                                start,
                                duration,
                                constraints,
                            ),
                        )

        stats = memo.stats()
        for name in (
            "available_periods",
            "block_allowed",
            "period_capacity",
            "session_allowed",
            "session_cap",
        ):
            self.assertGreater(stats["hits"][name], 0)
            self.assertEqual(stats["entries"][name], stats["misses"][name])

        self.assertEqual(stats["entries"]["available_periods"], len(sessions))
        self.assertEqual(stats["entries"]["session_allowed"], len(sessions))
        self.assertEqual(stats["entries"]["period_capacity"], len(sessions))
        self.assertEqual(stats["entries"]["session_cap"], len(sessions))
        self.assertEqual(stats["entries"]["block_allowed"], len(sessions) * 5 * 3)


if __name__ == "__main__":
    unittest.main()
