from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SessionPart = Literal["AM", "PM"]


@dataclass(frozen=True, slots=True)
class ClassInfo:
    name: str
    grade: str


@dataclass(frozen=True, slots=True)
class Assignment:
    """One class-subject-teacher weekly workload."""

    class_name: str
    grade: str
    subject: str
    teacher: str
    periods_per_week: int
    max_periods_per_session: int
    room: str = ""


@dataclass(frozen=True, slots=True)
class Session:
    """A half-day session. day uses Vietnamese weekday numbers: 2..6."""

    day: int
    part: SessionPart

    @property
    def key(self) -> tuple[int, int]:
        return (self.day - 2, 0 if self.part == "AM" else 1)

    @staticmethod
    def from_key(key: tuple[int, int]) -> "Session":
        day0, part0 = key
        return Session(day=day0 + 2, part="AM" if part0 == 0 else "PM")


@dataclass(frozen=True, slots=True)
class SessionAllocation:
    class_name: str
    grade: str
    subject: str
    teacher: str
    session: Session
    count: int
    room: str = ""


@dataclass(frozen=True, slots=True)
class Lesson:
    class_name: str
    grade: str
    day: int
    session: SessionPart
    period: int
    subject: str
    teacher: str
    room: str = ""


@dataclass(slots=True)
class SchoolData:
    classes: list[ClassInfo]
    assignments: list[Assignment]
    teachers: list[str]
    subjects: list[str]
    periods_by_grade_subject: dict[tuple[str, str], int]
    limits_by_grade_subject: dict[tuple[str, str], int]

    @property
    def class_grade(self) -> dict[str, str]:
        return {c.name: c.grade for c in self.classes}
