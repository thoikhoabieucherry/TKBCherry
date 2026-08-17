from __future__ import annotations

from pathlib import Path
from typing import Any

import openpyxl

from .models import Assignment, ClassInfo, SchoolData


def _read_values(path: Path) -> list[list[Any]]:
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.active
    return [list(row) for row in ws.iter_rows(values_only=True)]


def _to_int(value: Any, default: int | None = None) -> int:
    if value is None or value == "":
        if default is None:
            raise ValueError("Expected integer value, got blank")
        return default
    return int(value)


def load_school_data(data_dir: str | Path) -> SchoolData:
    """Load lop.xlsx, pccm.xlsx, tietchuan.xlsx from the school Excel schema.

    Only three files are needed by the optimizer:
    - lop.xlsx: class list and grade
    - tietchuan.xlsx: weekly periods and max periods/session per grade+subject
    - pccm.xlsx: class-subject-teacher assignment matrix

    gv.xlsx and mon.xlsx are useful for app validation/UI, but the solver can infer
    active teachers and subjects from pccm.xlsx.
    """

    data_dir = Path(data_dir)
    lop = _read_values(data_dir / "lop.xlsx")
    tiet = _read_values(data_dir / "tietchuan.xlsx")
    pccm = _read_values(data_dir / "pccm.xlsx")

    classes: list[ClassInfo] = []
    for row in lop[1:]:
        if len(row) >= 4 and row[1]:
            classes.append(ClassInfo(name=str(row[1]).strip(), grade=str(row[3]).strip()))
    class_grade = {c.name: c.grade for c in classes}

    periods_by_grade_subject: dict[tuple[str, str], int] = {}
    limits_by_grade_subject: dict[tuple[str, str], int] = {}
    for row in tiet[1:]:
        if len(row) >= 5 and row[1] and row[2] and row[3] is not None:
            grade = str(row[1]).strip()
            subject = str(row[2]).strip()
            periods_by_grade_subject[(grade, subject)] = _to_int(row[3])
            limits_by_grade_subject[(grade, subject)] = _to_int(row[4], default=99)

    if not pccm or len(pccm[0]) < 2:
        raise ValueError("pccm.xlsx has no assignment matrix header")

    subjects = [str(x).strip() for x in pccm[0][1:] if x]
    assignments: list[Assignment] = []
    teachers: set[str] = set()

    for row in pccm[1:]:
        if not row or not row[0]:
            continue
        class_name = str(row[0]).strip()
        if class_name not in class_grade:
            raise ValueError(f"Class {class_name!r} exists in pccm.xlsx but not lop.xlsx")
        grade = class_grade[class_name]
        for subject, teacher_value in zip(subjects, row[1:]):
            if not teacher_value:
                continue
            key = (grade, subject)
            periods = periods_by_grade_subject.get(key)
            if periods is None or periods <= 0:
                continue
            teacher = str(teacher_value).strip()
            assignments.append(
                Assignment(
                    class_name=class_name,
                    grade=grade,
                    subject=subject,
                    teacher=teacher,
                    periods_per_week=periods,
                    max_periods_per_session=limits_by_grade_subject[key],
                )
            )
            teachers.add(teacher)

    return SchoolData(
        classes=classes,
        assignments=assignments,
        teachers=sorted(teachers),
        subjects=subjects,
        periods_by_grade_subject=periods_by_grade_subject,
        limits_by_grade_subject=limits_by_grade_subject,
    )
