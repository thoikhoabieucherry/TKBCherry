from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, replace
import itertools
import time
from typing import Any, Iterable, Mapping

from .models import Lesson, SchoolData
from .rules import TimetableRuleSet
from .validate import compute_metrics


Slot = tuple[int, str, int]
FixedSlot = tuple[str, int, str, int]
Quality = tuple[int, int, int, int, int]

# The cycle metadata is carried inside the solver result and can be copied
# into the refinement summary as well.  Keep only a small diagnostic tail so
# repeated optimize clicks do not inflate the timetable payload with dozens
# of near-identical rejected candidates.  The counters above the history
# remain the authoritative aggregate telemetry.
_CLEAN_QUALITY_HISTORY_LIMIT = 12


@dataclass(frozen=True, slots=True)
class _Block:
    class_name: str
    indices: tuple[int, ...]
    slots: frozenset[Slot]
    length: int
    subject: str
    teacher: str


@dataclass(frozen=True, slots=True)
class CleanQualityCycleResult:
    lessons: list[Lesson]
    metrics: dict[str, Any]
    metadata: dict[str, Any]


def _slot(lesson: Lesson) -> Slot:
    return (int(lesson.day), str(lesson.session), int(lesson.period))


def _teacher_slots(lessons: Iterable[Lesson]) -> dict[str, set[Slot]]:
    result: dict[str, set[Slot]] = defaultdict(set)
    for lesson in lessons:
        teacher = str(lesson.teacher or "")
        if teacher:
            result[teacher].add(_slot(lesson))
    return result


def _teacher_metric(slots: Iterable[Slot]) -> Quality:
    grouped: dict[tuple[int, str], list[int]] = defaultdict(list)
    for day, session, period in slots:
        grouped[(int(day), str(session))].append(int(period))
    result = [len(grouped), 0, 0, 0, 0]
    for periods in grouped.values():
        unique = sorted(set(periods))
        gap = max(unique) - min(unique) + 1 - len(unique) if len(unique) > 1 else 0
        result[1] += int(len(unique) == 1)
        result[2] += int(gap == 1)
        result[3] += int(gap >= 2)
        result[4] += max(0, int(gap))
    return tuple(result)  # type: ignore[return-value]


def _fast_quality(lessons: list[Lesson]) -> Quality:
    metrics = [_teacher_metric(slots) for slots in _teacher_slots(lessons).values()]
    return tuple(  # type: ignore[return-value]
        sum(metric[index] for metric in metrics) for index in range(5)
    )


def _gap_metrics(metrics: Mapping[str, Any]) -> tuple[int, int, int]:
    distribution = metrics.get("gap_distribution")
    gaps = distribution if isinstance(distribution, Mapping) else {}
    gap1 = 0
    gap2 = 0
    total = 0
    for raw_key, raw_value in gaps.items():
        try:
            key = int(raw_key)
            value = int(raw_value or 0)
        except (TypeError, ValueError):
            continue
        if key == 1:
            gap1 += value
        elif key >= 2:
            gap2 += value
        total += max(0, key) * value
    return gap1, gap2, total


def _canonical_quality(metrics: Mapping[str, Any]) -> Quality:
    gap1, gap2, total = _gap_metrics(metrics)
    return (
        int(metrics.get("teacher_sessions") or 0),
        int(metrics.get("one_period_teacher_sessions") or 0),
        gap1,
        gap2,
        total,
    )


def _quality_is_monotone_improvement(candidate: Quality, incumbent: Quality) -> bool:
    compared = tuple(zip(candidate, incumbent))
    return all(next_value <= old_value for next_value, old_value in compared) and any(
        next_value < old_value for next_value, old_value in compared
    )


def _blocks(lessons: list[Lesson], fixed_slots: set[FixedSlot]) -> list[_Block]:
    grouped: dict[tuple[str, int, str], list[int]] = defaultdict(list)
    for index, lesson in enumerate(lessons):
        grouped[(lesson.class_name, int(lesson.day), str(lesson.session))].append(index)

    blocks: list[_Block] = []
    for (class_name, day, session), indices in sorted(grouped.items()):
        indices.sort(key=lambda index: int(lessons[index].period))
        if not indices:
            continue
        runs: list[list[int]] = []
        current = [indices[0]]
        for index in indices[1:]:
            previous = lessons[current[-1]]
            lesson = lessons[index]
            if (
                int(lesson.period) == int(previous.period) + 1
                and lesson.subject == previous.subject
                and lesson.teacher == previous.teacher
            ):
                current.append(index)
            else:
                runs.append(current)
                current = [index]
        runs.append(current)

        for run in runs:
            slots = frozenset(_slot(lessons[index]) for index in run)
            if any(
                (class_name, day, session, period) in fixed_slots
                for _, _, period in slots
            ):
                continue
            first = lessons[run[0]]
            if not str(first.teacher or ""):
                continue
            blocks.append(
                _Block(
                    class_name=class_name,
                    indices=tuple(run),
                    slots=slots,
                    length=len(run),
                    subject=first.subject,
                    teacher=first.teacher,
                )
            )
    return blocks


def _cycle_quality(
    cycle: tuple[_Block, ...],
    *,
    teacher_slots: Mapping[str, set[Slot]],
    teacher_metrics: Mapping[str, Quality],
    baseline: Quality,
) -> Quality | None:
    removed: dict[str, set[Slot]] = defaultdict(set)
    added: dict[str, set[Slot]] = defaultdict(set)
    for position, source in enumerate(cycle):
        target = cycle[(position + 1) % len(cycle)]
        removed[source.teacher].update(source.slots)
        added[source.teacher].update(target.slots)

    quality = list(baseline)
    for teacher in set(removed) | set(added):
        untouched = set(teacher_slots.get(teacher, set())) - removed[teacher]
        if untouched & added[teacher]:
            return None
        old_metric = teacher_metrics.get(teacher, (0, 0, 0, 0, 0))
        new_metric = _teacher_metric(untouched | added[teacher])
        for index in range(5):
            quality[index] += new_metric[index] - old_metric[index]
    return tuple(quality)  # type: ignore[return-value]


def _candidate_cycles(
    lessons: list[Lesson],
    fixed_slots: set[FixedSlot],
    *,
    deadline: float | None = None,
) -> list[tuple[Quality, tuple[_Block, ...], str]]:
    teacher_slots = _teacher_slots(lessons)
    teacher_metrics = {
        teacher: _teacher_metric(slots) for teacher, slots in teacher_slots.items()
    }
    baseline = tuple(
        sum(metric[index] for metric in teacher_metrics.values()) for index in range(5)
    )
    grouped: dict[tuple[str, int], list[_Block]] = defaultdict(list)
    for block in _blocks(lessons, fixed_slots):
        grouped[(block.class_name, block.length)].append(block)

    result: list[tuple[Quality, tuple[_Block, ...], str]] = []
    for group in grouped.values():
        if deadline is not None and time.monotonic() >= deadline:
            break
        for pair in itertools.combinations(group, 2):
            if deadline is not None and time.monotonic() >= deadline:
                break
            if len({block.teacher for block in pair}) != 2:
                continue
            quality = _cycle_quality(
                pair,
                teacher_slots=teacher_slots,
                teacher_metrics=teacher_metrics,
                baseline=baseline,
            )
            if quality is not None and _quality_is_monotone_improvement(quality, baseline):
                result.append((quality, pair, "equal_block_swap"))

        for triple in itertools.combinations(group, 3):
            if deadline is not None and time.monotonic() >= deadline:
                break
            if len({block.teacher for block in triple}) != 3:
                continue
            for cycle in (triple, (triple[0], triple[2], triple[1])):
                quality = _cycle_quality(
                    cycle,
                    teacher_slots=teacher_slots,
                    teacher_metrics=teacher_metrics,
                    baseline=baseline,
                )
                if quality is not None and _quality_is_monotone_improvement(
                    quality,
                    baseline,
                ):
                    result.append((quality, cycle, "three_block_ejection"))

    result.sort(
        key=lambda item: (
            item[0],
            len(item[1]),
            item[1][0].class_name,
            tuple(block.indices for block in item[1]),
        )
    )
    return result


def _apply_cycle(lessons: list[Lesson], cycle: tuple[_Block, ...]) -> list[Lesson]:
    candidate = list(lessons)
    for position, source in enumerate(cycle):
        target = cycle[(position + 1) % len(cycle)]
        source_indices = sorted(source.indices, key=lambda index: lessons[index].period)
        target_indices = sorted(target.indices, key=lambda index: lessons[index].period)
        for source_index, target_index in zip(source_indices, target_indices):
            source_lesson = lessons[source_index]
            candidate[target_index] = replace(
                lessons[target_index],
                subject=source_lesson.subject,
                teacher=source_lesson.teacher,
                room=source_lesson.room,
            )
    return candidate


def optimize_clean_quality_cycles(
    school_data: SchoolData,
    incumbent_lessons: list[Lesson],
    *,
    rules: TimetableRuleSet,
    fixed_slots: set[FixedSlot] | None = None,
    max_seconds: float = 12.0,
    max_rounds: int = 30,
) -> CleanQualityCycleResult | None:
    """Improve clean complete incumbents with deterministic block cycles.

    The routine is deliberately fail-closed. It returns ``None`` unless at
    least one canonically valid, component-wise monotone move was accepted.
    """

    started = time.monotonic()
    deadline = started + max(0.0, min(20.0, float(max_seconds)))
    lessons = list(incumbent_lessons)
    incumbent_metrics = compute_metrics(school_data, lessons, rules=rules)
    baseline_quality = _canonical_quality(incumbent_metrics)
    expected = int(incumbent_metrics.get("expected_periods") or 0)
    scheduled = int(incumbent_metrics.get("scheduled_periods") or 0)
    if (
        not bool(incumbent_metrics.get("hard_ok"))
        or expected <= 0
        or scheduled != expected
        or baseline_quality[1] != 0
        or baseline_quality[3] != 0
        or int(incumbent_metrics.get("app_constraint_violation_count") or 0) != 0
    ):
        return None

    frozen = set(fixed_slots or set())
    accepted = 0
    checked = 0
    rejected = 0
    rounds = 0
    history: list[dict[str, Any]] = []
    current_metrics = incumbent_metrics
    current_quality = baseline_quality
    stop_reason: str | None = None
    round_limit = max(1, min(50, int(max_rounds)))

    while rounds < round_limit and time.monotonic() < deadline:
        rounds += 1
        candidates = _candidate_cycles(
            lessons,
            frozen,
            deadline=deadline,
        )
        if not candidates:
            stop_reason = (
                "deadline"
                if time.monotonic() >= deadline
                else "no_candidates"
            )
            break
        accepted_this_round = False
        for fast_quality, cycle, operator in candidates:
            if time.monotonic() >= deadline:
                break
            checked += 1
            candidate_lessons = _apply_cycle(lessons, cycle)
            metrics = compute_metrics(school_data, candidate_lessons, rules=rules)
            quality = _canonical_quality(metrics)
            safe = bool(
                metrics.get("hard_ok")
                and int(metrics.get("scheduled_periods") or 0) == expected
                and int(metrics.get("expected_periods") or 0) == expected
                and int(metrics.get("app_constraint_violation_count") or 0) == 0
                and _quality_is_monotone_improvement(quality, current_quality)
            )
            if len(history) < _CLEAN_QUALITY_HISTORY_LIMIT:
                history.append(
                    {
                        "round": rounds,
                        "operator": operator,
                        "class_name": cycle[0].class_name,
                        "fast_quality": list(fast_quality),
                        "canonical_quality": list(quality),
                        "accepted": safe,
                    }
                )
            if not safe:
                rejected += 1
                continue
            lessons = candidate_lessons
            current_metrics = dict(metrics)
            current_quality = quality
            accepted += 1
            accepted_this_round = True
            break
        if not accepted_this_round:
            stop_reason = (
                "deadline"
                if time.monotonic() >= deadline
                else "no_accepted_candidate"
            )
            break

    if stop_reason is None:
        stop_reason = (
            "deadline"
            if time.monotonic() >= deadline
            else "max_rounds"
        )

    if accepted <= 0:
        return None
    elapsed = time.monotonic() - started
    return CleanQualityCycleResult(
        lessons=lessons,
        metrics=dict(current_metrics),
        metadata={
            "solver": "clean_quality_block_cycles_v1",
            "elapsed_seconds": round(elapsed, 3),
            "rounds": rounds,
            "accepted_moves": accepted,
            "candidate_checks": checked,
            "rejected_candidates": rejected,
            "fixed_slot_count": len(frozen),
            "input_quality": list(baseline_quality),
            "output_quality": list(current_quality),
            "stop_reason": stop_reason,
            "stopped_on_plateau": stop_reason
            in {"no_candidates", "no_accepted_candidate"},
            "history": history,
        },
    )
