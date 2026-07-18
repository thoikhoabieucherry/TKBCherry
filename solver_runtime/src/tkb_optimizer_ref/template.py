from __future__ import annotations

import re
from typing import Any

from .models import ClassInfo, Session

LOWER_GRADES = {"Khối 6", "Khối 7"}


def all_sessions() -> list[Session]:
    """Student timetable frame exposed by the UI.

    Every visible period is available unless the user explicitly marks it off.
    """

    return [Session(day=d, part="AM") for d in range(2, 8)] + [
        Session(day=d, part="PM") for d in range(2, 8)
    ]


def class_allowed_periods(grade: str, session: Session) -> list[int]:
    return [1, 2, 3, 4, 5]


def class_session_capacity(grade: str, session: Session) -> int:
    return len(class_allowed_periods(grade, session))


def class_available_periods(grade: str, class_name: str, session: Session, constraints: Any | None = None) -> list[int]:
    periods = set(class_allowed_periods(grade, session))
    if constraints is not None:
        extra_slots = getattr(constraints, "class_extra_slots", {}) or {}
        for day, part, period in extra_slots.get(str(class_name), frozenset()):
            if int(day) == session.day and str(part) == session.part:
                periods.add(int(period))
    if constraints is None:
        return sorted(periods)
    return [
        period
        for period in sorted(periods)
        if not constraints.is_fixed_off("class", class_name, session.day, session.part, period)
    ]


def class_prefix_periods(grade: str, class_name: str, session: Session, constraints: Any | None = None) -> list[int]:
    available = set(class_available_periods(grade, class_name, session, constraints))
    prefix: list[int] = []
    for period in range(1, teacher_session_capacity(session) + 1):
        if period not in available:
            break
        prefix.append(period)
    return prefix


def class_session_capacity_for_constraints(
    grade: str,
    class_name: str,
    session: Session,
    constraints: Any | None = None,
) -> int:
    return len(class_available_periods(grade, class_name, session, constraints))


def teacher_session_capacity(session: Session) -> int:
    return 5


def class_sort_key(name: str) -> tuple[int, int, str]:
    numbers = re.findall(r"\d+", str(name))
    if not numbers:
        return 999, 999, str(name)
    grade = int(numbers[0])
    index = int(numbers[1]) if len(numbers) > 1 else 0
    return grade, index, str(name)


def session_sort_key(session: Session) -> tuple[int, int]:
    return session.day, 0 if session.part == "AM" else 1
