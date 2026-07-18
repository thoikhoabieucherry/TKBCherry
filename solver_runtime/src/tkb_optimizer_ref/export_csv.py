from __future__ import annotations

import csv
from pathlib import Path

from .models import Lesson, SessionAllocation
from .template import class_sort_key


def write_timetable_csv(path: str | Path, lessons: list[Lesson]) -> None:
    path = Path(path)
    rows = sorted(lessons, key=lambda x: (class_sort_key(x.class_name), x.day, 0 if x.session == "AM" else 1, x.period))
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["class", "grade", "day", "session", "period", "subject", "teacher", "room"])
        writer.writeheader()
        for x in rows:
            writer.writerow(
                {
                    "class": x.class_name,
                    "grade": x.grade,
                    "day": x.day,
                    "session": x.session,
                    "period": x.period,
                    "subject": x.subject,
                    "teacher": x.teacher,
                    "room": x.room,
                }
            )


def write_session_plan_csv(path: str | Path, allocations: list[SessionAllocation]) -> None:
    path = Path(path)
    rows = sorted(allocations, key=lambda x: (class_sort_key(x.class_name), x.session.day, 0 if x.session.part == "AM" else 1, x.subject, x.teacher))
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["class", "grade", "day", "session", "subject", "teacher", "room", "count"])
        writer.writeheader()
        for x in rows:
            writer.writerow(
                {
                    "class": x.class_name,
                    "grade": x.grade,
                    "day": x.session.day,
                    "session": x.session.part,
                    "subject": x.subject,
                    "teacher": x.teacher,
                    "room": x.room,
                    "count": x.count,
                }
            )
