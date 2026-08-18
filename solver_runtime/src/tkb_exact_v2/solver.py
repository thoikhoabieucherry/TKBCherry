from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import combinations
import math
import time
from typing import Any, Callable, Mapping

from tkb_new.adapter import (
    UiDataContext,
    _extract_fixed_lessons_from_tkb,
    _extract_hard_fixed_lessons_from_tkb,
    build_payload,
    build_school_data_from_ui,
)
from tkb_optimizer_ref.models import Lesson, SchoolData, Session
from tkb_optimizer_ref.period_milp import (
    LessonEvent,
    _day_key,
    _event_matches_limit,
    _event_start_allowed,
    _get_path,
    _iter_limit_rules,
    _limit_for_slot,
    _session_key,
    _to_int,
    _truthy,
)
from tkb_optimizer_ref.rules import TimetableRuleSet, one_session_per_day_mode, resolve_rule_set
from tkb_optimizer_ref.template import all_sessions, class_available_periods, teacher_session_capacity
from tkb_optimizer_ref.validate import compute_metrics


ProgressFn = Callable[[dict[str, Any]], None]


class ExactV2NoSolution(RuntimeError):
    """A strict solve failed; no candidate is safe to apply."""

    def __init__(self, detail: Mapping[str, Any]):
        self.detail = dict(detail)
        super().__init__(str(self.detail.get("message") or "Solver V2 không tìm thấy nghiệm."))


def _load_cp_model():
    try:
        from ortools.sat.python import cp_model  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("OR-Tools là bắt buộc cho Solver V2.") from exc
    return cp_model


def _day_sessions(sessions: list[Session], day: int) -> list[int]:
    return [i for i, session in enumerate(sessions) if int(session.day) == int(day)]


def _periods_for_pattern(mask: int, capacity: int) -> tuple[int, ...]:
    return tuple(period for period in range(1, capacity + 1) if mask & (1 << (period - 1)))


def _teacher_masks(capacity: int) -> list[tuple[int, tuple[int, ...], int]]:
    """All teacher occupancy patterns with load 0 or >=2 and gap <=1."""

    out: list[tuple[int, tuple[int, ...], int]] = []
    for mask in range(1 << capacity):
        periods = _periods_for_pattern(mask, capacity)
        if not periods:
            out.append((mask, periods, 0))
            continue
        if len(periods) < 2:
            continue
        gap = periods[-1] - periods[0] + 1 - len(periods)
        if gap <= 1:
            out.append((mask, periods, gap))
    return out


def _all_teacher_masks(capacity: int) -> list[tuple[int, tuple[int, ...], int]]:
    out: list[tuple[int, tuple[int, ...], int]] = []
    for mask in range(1 << capacity):
        periods = _periods_for_pattern(mask, capacity)
        gap = 0 if not periods else periods[-1] - periods[0] + 1 - len(periods)
        out.append((mask, periods, gap))
    return out


def _no_singleton_teacher_masks(capacity: int) -> list[tuple[int, tuple[int, ...], int]]:
    return [
        (mask, periods, gap)
        for mask, periods, gap in _all_teacher_masks(capacity)
        if not periods or len(periods) >= 2
    ]


def _subject_rule_items(
    data: SchoolData,
    rules: TimetableRuleSet,
    class_name: str,
    subject: str,
) -> list[tuple[str, Mapping[str, Any]]]:
    constraints = rules.constraints
    if constraints is None:
        return []
    out: list[tuple[str, Mapping[str, Any]]] = []
    subject_rule = constraints.subject_rule_for(class_name, subject)
    if isinstance(subject_rule, Mapping) and subject_rule:
        out.append((f"subject:{class_name}:{subject}", subject_rule))
    for group_id, rule in constraints.subject_group_rules_for(class_name, subject):
        if isinstance(rule, Mapping) and rule:
            out.append((f"subjectGroup:{class_name}:{group_id}", rule))
    return out


def _rule_allows_session(rule: Mapping[str, Any], part: str) -> bool:
    allowed = rule.get("sessionAllowed")
    if not isinstance(allowed, Mapping):
        return True
    if part == "AM" and allowed.get("allowMorning") is False:
        return False
    if part == "PM" and allowed.get("allowAfternoon") is False:
        return False
    return True


def _class_holes(data: SchoolData, lessons: list[Lesson], rules: TimetableRuleSet) -> int:
    """Count empty available class slots before the final lesson in a session."""

    by_class_session: dict[tuple[str, int, str], set[int]] = defaultdict(set)
    for lesson in lessons:
        by_class_session[(lesson.class_name, int(lesson.day), str(lesson.session))].add(int(lesson.period))
    total = 0
    for info in data.classes:
        for session in all_sessions():
            available = class_available_periods(info.grade, info.name, session, rules.constraints)
            occupied = by_class_session.get((info.name, session.day, session.part), set())
            if not occupied:
                continue
            ordered = [period for period in available if period <= max(occupied)]
            total += sum(1 for period in ordered if period not in occupied)
    return total


@dataclass
class _BuiltModel:
    cp_model: Any
    pattern_vars: dict[tuple[int, int, int, int], Any]
    z_vars: dict[tuple[str, int], Any]
    gap1_vars: dict[tuple[str, int], Any]
    teacher_total: Any
    gap1_total: Any
    sessions: list[Session]
    fixed_lessons: list[Lesson]
    stats: dict[str, Any]


def _class_prefix_hint(data: SchoolData, rules: TimetableRuleSet) -> set[tuple[str, int, int]]:
    """Find a cheap class-only packing to break the large session symmetry."""

    cp_model = _load_cp_model()
    model = cp_model.CpModel()
    vars_by_class: dict[str, list[tuple[Any, int, int]]] = defaultdict(list)
    for info in data.classes:
        demand = sum(int(a.periods_per_week) for a in data.assignments if a.class_name == info.name)
        terms = []
        for si, session in enumerate(all_sessions()):
            available = class_available_periods(info.grade, info.name, session, rules.constraints)
            for k in range(len(available) + 1):
                var = model.NewBoolVar(f"hint_class_{info.name}_{si}_{k}")
                vars_by_class[info.name].append((var, si, k))
                terms.append(var * k)
        model.Add(sum(var for var, _si, _k in vars_by_class[info.name]) == len(all_sessions()))
        model.Add(sum(terms) == demand)
    # Prefer compact class schedules, but this is only a warm-start hint and
    # never a quality certificate for the integrated model.
    model.Minimize(sum(var for values in vars_by_class.values() for var, _si, k in values for _ in [0] if k > 0))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 5.0
    solver.parameters.num_search_workers = 1
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return set()
    return {
        (class_name, si, k)
        for class_name, values in vars_by_class.items()
        for var, si, k in values
        if solver.Value(var) > 0
    }


def _session_allocation_warm_start(
    data: SchoolData,
    rules: TimetableRuleSet,
    fixed_lessons: list[Lesson],
    *,
    workers: int,
    seconds: float,
) -> tuple[dict[tuple[int, int], int], int | None]:
    """Solve the small assignment/session master used to seed period CP-SAT."""

    cp_model = _load_cp_model()
    model = cp_model.CpModel()
    sessions = all_sessions()
    load_vars: dict[tuple[int, int], Any] = {}
    active_vars: dict[tuple[str, int], Any] = {}
    for ai, assignment in enumerate(data.assignments):
        allowed_sessions: list[int] = []
        for si, session in enumerate(sessions):
            allowed = class_available_periods(assignment.grade, assignment.class_name, session, rules.constraints)
            if not allowed or _rule_allows_session(
                rules.constraints.subject_rule_for(assignment.class_name, assignment.subject)
                if rules.constraints is not None
                else {},
                session.part,
            ):
                if allowed:
                    allowed_sessions.append(si)
            upper = min(int(assignment.max_periods_per_session), len(allowed), teacher_session_capacity(session))
            var = model.NewIntVar(0, max(0, upper), f"alloc_{ai}_{si}")
            load_vars[(ai, si)] = var
        model.Add(sum(load_vars[(ai, si)] for si in range(len(sessions))) == int(assignment.periods_per_week))
        for si in range(len(sessions)):
            if si not in allowed_sessions:
                model.Add(load_vars[(ai, si)] == 0)

    for info in data.classes:
        for si, session in enumerate(sessions):
            capacity = len(class_available_periods(info.grade, info.name, session, rules.constraints))
            model.Add(sum(load_vars[(ai, si)] for ai, a in enumerate(data.assignments) if a.class_name == info.name) <= capacity)
    for teacher in data.teachers:
        for si, session in enumerate(sessions):
            load = sum(load_vars[(ai, si)] for ai, a in enumerate(data.assignments) if a.teacher == teacher)
            active = model.NewBoolVar(f"alloc_teacher_{teacher}_{si}")
            active_vars[(teacher, si)] = active
            model.Add(load <= teacher_session_capacity(session) * active)
            model.Add(load >= 2 * active)
    fixed_counts = Counter()
    assignment_by_key = {(a.class_name, a.subject, a.teacher): ai for ai, a in enumerate(data.assignments)}
    session_by_key = {(s.day, s.part): si for si, s in enumerate(sessions)}
    for lesson in fixed_lessons:
        ai = assignment_by_key.get((lesson.class_name, lesson.subject, lesson.teacher))
        si = session_by_key.get((int(lesson.day), str(lesson.session)))
        if ai is not None and si is not None:
            fixed_counts[(ai, si)] += 1
    for key, count in fixed_counts.items():
        model.Add(load_vars[key] >= int(count))
    teacher_total = sum(active_vars.values())
    model.Minimize(teacher_total)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(1.0, float(seconds))
    solver.parameters.num_search_workers = max(1, int(workers))
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = 2
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {}, None
    allocation = {
        key: int(solver.Value(var))
        for key, var in load_vars.items()
        if int(solver.Value(var)) > 0
    }
    optimum = int(round(float(solver.ObjectiveValue()))) if status == cp_model.OPTIMAL else None
    return allocation, optimum


class _ModelBuilder:
    def __init__(
        self,
        data: SchoolData,
        rules: TimetableRuleSet,
        fixed_lessons: list[Lesson],
        progress: ProgressFn | None,
        *,
        enforce_class_prefix: bool = True,
        enforce_teacher_quality: bool = True,
        enforce_gap2: bool = True,
        hint_lessons: list[Lesson] | None = None,
        allocation_hints: Mapping[tuple[int, int], int] | None = None,
    ) -> None:
        self.data = data
        self.rules = resolve_rule_set(rules)
        self.constraints = self.rules.constraints
        self.fixed_lessons = list(fixed_lessons)
        self.hint_lessons = list(hint_lessons or [])
        self.allocation_hints = dict(allocation_hints or {})
        self.progress = progress
        self.cp_model = _load_cp_model()
        self.model = self.cp_model.CpModel()
        self.sessions = all_sessions()
        self.pattern_vars: dict[tuple[int, int, int, int], Any] = {}
        self.by_assignment: dict[int, list[tuple[Any, int]]] = defaultdict(list)
        self.by_assignment_session: dict[tuple[int, int], list[Any]] = defaultdict(list)
        self.by_class_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
        self.by_teacher_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
        self.by_room_slot: dict[tuple[str, int, int], list[Any]] = defaultdict(list)
        self.entity_assignment_indexes: dict[str, set[int]] = defaultdict(set)
        self.z_vars: dict[tuple[str, int], Any] = {}
        self.gap1_vars: dict[tuple[str, int], Any] = {}
        self.teacher_choice_vars: dict[tuple[str, int, tuple[int, ...]], Any] = {}
        self.class_prefix_vars: dict[tuple[str, int, int], Any] = {}
        self.pattern_stats = {"patterns": 0, "assignment_session_domains": 0}
        # Keep the no-student-hole rule behind an explicit model switch while
        # the first real-school fixture is diagnosed.  It remains enabled for
        # normal Solver V2 requests; the local diagnostic toggle is useful for
        # separating a class-shape conflict from a teacher gap conflict.
        self.enforce_class_prefix = bool(enforce_class_prefix)
        self.enforce_teacher_quality = bool(enforce_teacher_quality)
        self.enforce_gap2 = bool(enforce_gap2)

    def _emit(self, event: dict[str, Any]) -> None:
        if self.progress:
            self.progress(event)

    def _build_assignment_patterns(self) -> None:
        for ai, assignment in enumerate(self.data.assignments):
            for si, session in enumerate(self.sessions):
                if not _rule_allows_session(
                    self.constraints.subject_rule_for(assignment.class_name, assignment.subject)
                    if self.constraints is not None
                    else {},
                    session.part,
                ):
                    continue
                allowed = class_available_periods(
                    assignment.grade,
                    assignment.class_name,
                    session,
                    self.constraints,
                )
                allowed_set = set(allowed)
                max_len = min(
                    int(assignment.max_periods_per_session),
                    int(assignment.periods_per_week),
                    teacher_session_capacity(session),
                    len(allowed),
                )
                if max_len <= 0:
                    continue
                domain_count = 0
                for length in range(1, max_len + 1):
                    for start in allowed:
                        block = tuple(range(start, start + length))
                        if not all(period in allowed_set for period in block):
                            continue
                        event = LessonEvent(
                            class_name=assignment.class_name,
                            teacher=assignment.teacher,
                            subject=assignment.subject,
                            duration=length,
                            room=assignment.room,
                        )
                        if not _event_start_allowed(event, session, start, self.rules):
                            continue
                        key = (ai, si, start, length)
                        var = self.model.NewBoolVar(f"x_{ai}_{si}_{start}_{length}")
                        self.pattern_vars[key] = var
                        self.by_assignment[ai].append((var, length))
                        self.by_assignment_session[(ai, si)].append(var)
                        for period in block:
                            self.by_class_slot[(assignment.class_name, si, period)].append(var)
                            self.by_teacher_slot[(assignment.teacher, si, period)].append(var)
                            if assignment.room:
                                self.by_room_slot[(assignment.room, si, period)].append(var)
                        domain_count += 1
                if domain_count:
                    self.model.Add(sum(self.by_assignment_session[(ai, si)]) <= 1)
                    self.pattern_stats["assignment_session_domains"] += 1
        for ai, assignment in enumerate(self.data.assignments):
            terms = self.by_assignment.get(ai, [])
            self.model.Add(sum(var * length for var, length in terms) == int(assignment.periods_per_week))
        self.pattern_stats["patterns"] = len(self.pattern_vars)
        # Allocation master values are warm-start hints only.  They are not
        # hard equalities because a master that ignores concrete teacher gaps
        # can choose a session split that period-level CP-SAT must repair.
        for (ai, si), load in self.allocation_hints.items():
            if load <= 0:
                continue
            candidates = sorted(
                (
                    (start, length, var)
                    for (pai, psi, start, length), var in self.pattern_vars.items()
                    if pai == ai and psi == si and length == int(load)
                ),
                key=lambda item: item[0],
            )
            if candidates:
                self.model.AddHint(candidates[0][2], 1)

    def _hint_pattern_keys(self) -> set[tuple[int, int, int, int]]:
        assignment_by_key = {
            (a.class_name, a.subject, a.teacher): ai
            for ai, a in enumerate(self.data.assignments)
        }
        session_by_key = {(s.day, s.part): si for si, s in enumerate(self.sessions)}
        grouped: dict[tuple[int, int], list[int]] = defaultdict(list)
        for lesson in self.hint_lessons:
            ai = assignment_by_key.get((lesson.class_name, lesson.subject, lesson.teacher))
            si = session_by_key.get((int(lesson.day), str(lesson.session)))
            if ai is None or si is None:
                continue
            grouped[(ai, si)].append(int(lesson.period))
        out: set[tuple[int, int, int, int]] = set()
        for (ai, si), periods in grouped.items():
            ordered = sorted(set(periods))
            if not ordered or ordered != list(range(ordered[0], ordered[-1] + 1)):
                continue
            key = (ai, si, ordered[0], len(ordered))
            if key in self.pattern_vars:
                out.add(key)
        return out

    def _add_resource_constraints(self) -> None:
        for class_info in self.data.classes:
            for si, session in enumerate(self.sessions):
                for period in class_available_periods(
                    class_info.grade,
                    class_info.name,
                    session,
                    self.constraints,
                ):
                    self.model.Add(sum(self.by_class_slot.get((class_info.name, si, period), [])) <= 1)
                # Student timetables must not contain a blank slot before the
                # final lesson in a half-day.  OFF slots are removed from the
                # available sequence and therefore do not count as holes.
                available = class_available_periods(
                    class_info.grade,
                    class_info.name,
                    session,
                    self.constraints,
                )
                if self.enforce_class_prefix:
                    prefix_vars = [self.model.NewBoolVar(f"class_prefix_{class_info.name}_{si}_{k}") for k in range(len(available) + 1)]
                    for k, var in enumerate(prefix_vars):
                        self.class_prefix_vars[(class_info.name, si, k)] = var
                    self.model.Add(sum(prefix_vars) == 1)
                    for index, period in enumerate(available):
                        occupancy = sum(self.by_class_slot.get((class_info.name, si, period), []))
                        self.model.Add(occupancy == sum(prefix_vars[k] for k in range(index + 1, len(prefix_vars))))
        for terms in self.by_teacher_slot.values():
            self.model.Add(sum(terms) <= 1)
        for terms in self.by_room_slot.values():
            self.model.Add(sum(terms) <= 1)

    def _add_teacher_patterns(self) -> None:
        if self.enforce_teacher_quality and self.enforce_gap2:
            masks = _teacher_masks(teacher_session_capacity(self.sessions[0]))
        elif self.enforce_teacher_quality:
            masks = _no_singleton_teacher_masks(teacher_session_capacity(self.sessions[0]))
        else:
            masks = _all_teacher_masks(teacher_session_capacity(self.sessions[0]))
        for teacher in self.data.teachers:
            for si, session in enumerate(self.sessions):
                choices: list[Any] = []
                gap1_choices: list[Any] = []
                for mask, periods, gap in masks:
                    var = self.model.NewBoolVar(
                        f"t_{teacher}_{si}_{'_'.join(map(str, periods)) or 'empty'}"
                    )
                    choices.append(var)
                    self.teacher_choice_vars[(teacher, si, periods)] = var
                    if gap == 1:
                        gap1_choices.append(var)
                self.model.Add(sum(choices) == 1)
                z = self.model.NewBoolVar(f"teacher_session_{teacher}_{si}")
                self.z_vars[(teacher, si)] = z
                empty = choices[0]
                self.model.Add(z + empty == 1)
                gap1 = self.model.NewBoolVar(f"teacher_gap1_{teacher}_{si}")
                self.gap1_vars[(teacher, si)] = gap1
                self.model.Add(gap1 == sum(gap1_choices))
                for period in range(1, teacher_session_capacity(session) + 1):
                    occupancy = sum(self.by_teacher_slot.get((teacher, si, period), []))
                    allowed = [var for var, (_mask, periods, _gap) in zip(choices, masks) if period in periods]
                    self.model.Add(occupancy == sum(allowed))
                if self.constraints is not None:
                    for period in self.constraints.teacher_must_teach_periods(teacher, session.day, session.part):
                        self.model.Add(sum(self.by_teacher_slot.get((teacher, si, int(period)), [])) == 1)
        if self.class_prefix_vars:
            for class_name, si, k in _class_prefix_hint(self.data, self.rules):
                hint = self.class_prefix_vars.get((class_name, si, k))
                if hint is not None:
                    self.model.AddHint(hint, 1)
        # Do not stack two different per-assignment hints.  CP-SAT treats a
        # contradictory hint set as MODEL_INVALID; allocation master hints
        # take precedence over the raw incumbent when both exist.
        hint_patterns = set() if self.allocation_hints else self._hint_pattern_keys()
        assignment_by_key = {
            (a.class_name, a.subject, a.teacher): ai
            for ai, a in enumerate(self.data.assignments)
        }
        hinted_by_teacher_session: dict[tuple[str, int], set[int]] = defaultdict(set)
        for ai, si, start, length in hint_patterns:
            assignment = self.data.assignments[ai]
            hinted_by_teacher_session[(assignment.teacher, si)].update(range(start, start + length))
            self.model.AddHint(self.pattern_vars[(ai, si, start, length)], 1)
        for (teacher, si), periods in hinted_by_teacher_session.items():
            key = (teacher, si, tuple(sorted(periods)))
            if key in self.teacher_choice_vars:
                self.model.AddHint(self.teacher_choice_vars[key], 1)
        if hint_patterns:
            self.pattern_stats["hinted_patterns"] = len(hint_patterns)

    def _entity_terms(self, assignment_indexes: set[int], si: int) -> list[Any]:
        return [
            var
            for (ai, pattern_si, _start, _length), var in self.pattern_vars.items()
            if pattern_si == si and ai in assignment_indexes
        ]

    def _entity_occupancy(self, assignment_indexes: set[int], si: int, period: int) -> Any:
        terms = [
            var
            for (ai, pattern_si, start, length), var in self.pattern_vars.items()
            if pattern_si == si and ai in assignment_indexes and start <= period < start + length
        ]
        value = self.model.NewBoolVar(f"entity_occ_{si}_{period}_{len(terms)}")
        if not terms:
            self.model.Add(value == 0)
        else:
            for term in terms:
                self.model.Add(term <= value)
            self.model.Add(value <= sum(terms))
        return value

    def _add_subject_like_rule(self, entity_id: str, indexes: set[int], rule: Mapping[str, Any]) -> None:
        if not indexes:
            return
        active_by_session: dict[int, Any] = {}
        occupancy: dict[tuple[int, int], Any] = {}
        for si, session in enumerate(self.sessions):
            terms = self._entity_terms(indexes, si)
            active = self.model.NewBoolVar(f"entity_active_{entity_id}_{si}")
            active_by_session[si] = active
            if terms:
                for term in terms:
                    self.model.Add(term <= active)
                self.model.Add(active <= sum(terms))
            else:
                self.model.Add(active == 0)
            for period in range(1, teacher_session_capacity(session) + 1):
                occupancy[(si, period)] = self._entity_occupancy(indexes, si, period)

            if not _rule_allows_session(rule, session.part):
                self.model.Add(active == 0)

        max_sessions = _to_int(_get_path(rule, "maxSessions.day", 0), 0)
        if max_sessions > 0:
            self.model.Add(sum(active_by_session.values()) <= max_sessions)
        if _truthy(_get_path(rule, "sessionAllowed.oneSessionPerDay", False)):
            for day in sorted({session.day for session in self.sessions}):
                self.model.Add(sum(active_by_session[si] for si in _day_sessions(self.sessions, day)) <= 1)
        for day in sorted({session.day for session in self.sessions}):
            day_indexes = _day_sessions(self.sessions, day)
            day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{_day_key(day)}", 0), 0)
            if day_limit > 0:
                self.model.Add(
                    sum(occupancy[(si, p)] for si in day_indexes for p in range(1, 6)) <= day_limit
                )
            for part in ("AM", "PM"):
                matching = [si for si in day_indexes if self.sessions[si].part == part]
                session_limit = _to_int(_get_path(rule, f"maxPeriods.{_session_key(part)}", 0), 0)
                if session_limit > 0:
                    self.model.Add(sum(occupancy[(si, p)] for si in matching for p in range(1, 6)) <= session_limit)
                period_key = "morning" if part == "AM" else "afternoon"
                avoid = rule.get("avoidBreakPairs") if isinstance(rule.get("avoidBreakPairs"), Mapping) else {}
                avoid23 = rule.get("avoidBreakPair23") if isinstance(rule.get("avoidBreakPair23"), Mapping) else {}
                avoid34 = rule.get("avoidBreakPair34") if isinstance(rule.get("avoidBreakPair34"), Mapping) else {}
                if _truthy(avoid.get(period_key)) or _truthy(avoid23.get(period_key)):
                    for si in matching:
                        self.model.Add(occupancy[(si, 2)] + occupancy[(si, 3)] <= 1)
                if _truthy(avoid.get(period_key)) or _truthy(avoid34.get(period_key)):
                    for si in matching:
                        self.model.Add(occupancy[(si, 3)] + occupancy[(si, 4)] <= 1)
                linked = rule.get("linkedDays") if isinstance(rule.get("linkedDays"), Mapping) else {}
                if linked and any(
                    _truthy(_get_path(linked, f"{_session_key(part)}.{_day_key(day)}", False))
                    for _ in (0,)
                ):
                    for si in matching:
                        for start in range(1, 5):
                            self.model.Add(
                                sum(occupancy[(si, start + offset)] for offset in (0, 1)) <= 1
                            )
        morning_limit = _to_int(_get_path(rule, "weeklySessionPeriods.morning", 0), 0)
        if morning_limit > 0:
            self.model.Add(sum(occupancy[(si, p)] for si, s in enumerate(self.sessions) if s.part == "AM" for p in range(1, 6)) <= morning_limit)
        afternoon_limit = _to_int(_get_path(rule, "weeklySessionPeriods.afternoon", 0), 0)
        if afternoon_limit > 0:
            self.model.Add(sum(occupancy[(si, p)] for si, s in enumerate(self.sessions) if s.part == "PM" for p in range(1, 6)) <= afternoon_limit)
        spacing = _to_int(_get_path(rule, "spacingDays.days", 0), 0)
        if spacing > 0:
            day_active: dict[int, Any] = {}
            for day in sorted({session.day for session in self.sessions}):
                day_active[day] = self.model.NewBoolVar(f"entity_day_{entity_id}_{day}")
                terms = [active_by_session[si] for si in _day_sessions(self.sessions, day)]
                for term in terms:
                    self.model.Add(term <= day_active[day])
                self.model.Add(day_active[day] <= sum(terms))
            for left, right in combinations(sorted(day_active), 2):
                if right - left <= spacing:
                    self.model.Add(day_active[left] + day_active[right] <= 1)

        blocks = rule.get("lessonBlocks") if isinstance(rule.get("lessonBlocks"), Mapping) else {}
        for length in (2, 3, 4, 5):
            conf = blocks.get(str(length)) or blocks.get(length)
            if not isinstance(conf, Mapping):
                continue
            starts: list[Any] = []
            for si, session in enumerate(self.sessions):
                for start in range(1, teacher_session_capacity(session) - length + 2):
                    block = [occupancy[(si, start + offset)] for offset in range(length)]
                    previous = occupancy[(si, start - 1)] if start > 1 else None
                    indicator = self.model.NewBoolVar(f"block_{entity_id}_{si}_{start}_{length}")
                    starts.append(indicator)
                    for term in block:
                        self.model.Add(indicator <= term)
                    if previous is not None:
                        self.model.Add(indicator + previous <= 1)
                    lower = sum(block) - (length - 1) - (previous or 0)
                    self.model.Add(indicator >= lower)
            minimum = _to_int(conf.get("min"), 0)
            maximum = _to_int(conf.get("max"), 0)
            if minimum > 0:
                self.model.Add(sum(starts) >= minimum)
            if maximum > 0:
                self.model.Add(sum(starts) <= maximum)

    def _add_subject_rules(self) -> None:
        if self.constraints is None:
            return
        by_entity: dict[str, set[int]] = defaultdict(set)
        by_rule: dict[str, Mapping[str, Any]] = {}
        for ai, assignment in enumerate(self.data.assignments):
            for entity_id, rule in _subject_rule_items(self.data, self.rules, assignment.class_name, assignment.subject):
                by_entity[entity_id].add(ai)
                by_rule[entity_id] = rule
        for entity_id, indexes in by_entity.items():
            self._add_subject_like_rule(entity_id, indexes, by_rule[entity_id])
        for class_name, groups in (self.constraints.subject_no_same_session or {}).items():
            for group_id, subjects in groups.items():
                indexes = {ai for ai, a in enumerate(self.data.assignments) if a.class_name == class_name and a.subject in subjects}
                if len(indexes) < 2:
                    continue
                for si in range(len(self.sessions)):
                    terms = self._entity_terms(indexes, si)
                    active_by_subject = []
                    for subject in subjects:
                        subject_indexes = {ai for ai in indexes if self.data.assignments[ai].subject == subject}
                        terms_for_subject = self._entity_terms(subject_indexes, si)
                        if not terms_for_subject:
                            continue
                        active = self.model.NewBoolVar(f"no_same_session_{class_name}_{group_id}_{subject}_{si}")
                        for term in terms_for_subject:
                            self.model.Add(term <= active)
                        self.model.Add(active <= sum(terms_for_subject))
                        active_by_subject.append(active)
                    if len(active_by_subject) > 1:
                        self.model.Add(sum(active_by_subject) <= 1)
        for class_name, groups in (self.constraints.subject_no_same_day or {}).items():
            for group_id, subjects in groups.items():
                for day in sorted({session.day for session in self.sessions}):
                    active_by_subject = []
                    for subject in subjects:
                        indexes = {ai for ai, a in enumerate(self.data.assignments) if a.class_name == class_name and a.subject == subject}
                        terms = [self._entity_terms(indexes, si) for si in _day_sessions(self.sessions, day)]
                        flat = [term for sub in terms for term in sub]
                        if not flat:
                            continue
                        active = self.model.NewBoolVar(f"no_same_day_{class_name}_{group_id}_{subject}_{day}")
                        for term in flat:
                            self.model.Add(term <= active)
                        self.model.Add(active <= sum(flat))
                        active_by_subject.append(active)
                    if len(active_by_subject) > 1:
                        self.model.Add(sum(active_by_subject) <= 1)

    def _add_teacher_rules(self) -> None:
        if self.constraints is None:
            return
        for teacher, rule in self.constraints.teacher.items():
            if not isinstance(rule, Mapping) or teacher not in self.data.teachers:
                continue
            teacher_sessions = [self.z_vars[(teacher, si)] for si in range(len(self.sessions))]
            max_days = _to_int(_get_path(rule, "maxDaysSessions.maxDays", 0), 0)
            if max_days > 0:
                day_vars = []
                for day in sorted({session.day for session in self.sessions}):
                    terms = [self.z_vars[(teacher, si)] for si in _day_sessions(self.sessions, day)]
                    active = self.model.NewBoolVar(f"teacher_day_{teacher}_{day}")
                    for term in terms:
                        self.model.Add(term <= active)
                    self.model.Add(active <= sum(terms))
                    day_vars.append(active)
                self.model.Add(sum(day_vars) <= max_days)
            max_sessions = _to_int(_get_path(rule, "maxDaysSessions.maxSessions", 0), 0)
            if max_sessions > 0:
                self.model.Add(sum(teacher_sessions) <= max_sessions)
            for part, path in (("AM", "morning"), ("PM", "afternoon")):
                limit = _to_int(_get_path(rule, f"maxMorningAfternoon.{path}", 0), 0)
                if limit > 0:
                    self.model.Add(sum(self.z_vars[(teacher, si)] for si, session in enumerate(self.sessions) if session.part == part) <= limit)
            for day in sorted({session.day for session in self.sessions}):
                indexes = _day_sessions(self.sessions, day)
                mode = one_session_per_day_mode(_get_path(rule, f"oneSessionPerDay.{_day_key(day)}", False))
                am = [self.z_vars[(teacher, si)] for si in indexes if self.sessions[si].part == "AM"]
                pm = [self.z_vars[(teacher, si)] for si in indexes if self.sessions[si].part == "PM"]
                if mode == "morning":
                    self.model.Add(sum(pm) == 0)
                elif mode == "afternoon":
                    self.model.Add(sum(am) == 0)
                elif mode == "either":
                    self.model.Add(sum(am) + sum(pm) <= 1)
                day_limit = _to_int(_get_path(rule, f"maxPeriods.day.{_day_key(day)}", 0), 0)
                if day_limit > 0:
                    self.model.Add(sum(var for si in indexes for period in range(1, 6) for var in self.by_teacher_slot.get((teacher, si, period), [])) <= day_limit)
                if _truthy(_get_path(rule, f"noMorningP5AfternoonP1.{_day_key(day)}", False)) or _truthy(_get_path(rule, f"noMorningP5AfternoonP1.sang.{_day_key(day)}", False)):
                    morning5 = sum(var for si in indexes if self.sessions[si].part == "AM" for var in self.by_teacher_slot.get((teacher, si, 5), []))
                    afternoon1 = sum(var for si in indexes if self.sessions[si].part == "PM" for var in self.by_teacher_slot.get((teacher, si, 1), []))
                    self.model.Add(morning5 + afternoon1 <= 1)
            for si, session in enumerate(self.sessions):
                session_limit = _to_int(_get_path(rule, f"maxPeriods.{_session_key(session)}.{_day_key(session.day)}", 0), 0)
                if session_limit > 0:
                    self.model.Add(sum(var for period in range(1, 6) for var in self.by_teacher_slot.get((teacher, si, period), [])) <= session_limit)
                active_rooms: dict[str, Any] = {}
                for assignment in self.data.assignments:
                    if assignment.teacher != teacher or not assignment.room:
                        continue
                    terms = [var for (ai, sj, _start, _length), var in self.pattern_vars.items() if sj == si and self.data.assignments[ai].teacher == teacher and self.data.assignments[ai].room == assignment.room]
                    if terms and assignment.room not in active_rooms:
                        active = self.model.NewBoolVar(f"teacher_room_{teacher}_{si}_{assignment.room}")
                        for term in terms:
                            self.model.Add(term <= active)
                        self.model.Add(active <= sum(terms))
                        active_rooms[assignment.room] = active
                if _truthy(_get_path(rule, f"oneLocationPerSession.{_session_key(session)}.{_day_key(session.day)}", False)) and active_rooms:
                    self.model.Add(sum(active_rooms.values()) <= 1)
                if _truthy(_get_path(rule, f"gapBetweenLocations.{_session_key(session)}.{_day_key(session.day)}", False)):
                    for left in range(1, 5):
                        for right in range(left + 1, 6):
                            if right != left + 1:
                                continue
                            rooms = sorted(active_rooms)
                            for room_a, room_b in combinations(rooms, 2):
                                a_left = sum(var for (ai, sj, start, length), var in self.pattern_vars.items() if sj == si and self.data.assignments[ai].teacher == teacher and self.data.assignments[ai].room == room_a and start <= left < start + length)
                                b_right = sum(var for (ai, sj, start, length), var in self.pattern_vars.items() if sj == si and self.data.assignments[ai].teacher == teacher and self.data.assignments[ai].room == room_b and start <= right < start + length)
                                self.model.Add(a_left + b_right <= 1)

            for group_id, conf in self._teacher_class_configs(rule):
                per_session = _to_int(conf.get("perSession"), 0)
                per_day = _to_int(conf.get("perDay"), 0)
                if per_session <= 0 and per_day <= 0:
                    continue
                subject_ok = lambda subject: group_id in {"", "all", "__all__"} or self.constraints.subject_in_group(subject, group_id)
                class_names = {a.class_name for a in self.data.assignments if a.teacher == teacher and subject_ok(a.subject)}
                for class_name in class_names:
                    if per_session > 0:
                        for si in range(len(self.sessions)):
                            self.model.Add(sum(var * length for (ai, sj, _start, length), var in self.pattern_vars.items() if sj == si and self.data.assignments[ai].teacher == teacher and self.data.assignments[ai].class_name == class_name and subject_ok(self.data.assignments[ai].subject)) <= per_session)
                    if per_day > 0:
                        for day in sorted({s.day for s in self.sessions}):
                            self.model.Add(sum(var * length for (ai, sj, _start, length), var in self.pattern_vars.items() if self.sessions[sj].day == day and self.data.assignments[ai].teacher == teacher and self.data.assignments[ai].class_name == class_name and subject_ok(self.data.assignments[ai].subject)) <= per_day)

    def _teacher_class_configs(self, rule: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
        root = rule.get("maxPeriodsClass") if isinstance(rule.get("maxPeriodsClass"), Mapping) else {}
        if not isinstance(root, Mapping):
            return []
        by_group = root.get("bySubjectGroup")
        if isinstance(by_group, Mapping):
            return [(str(group), conf) for group, conf in by_group.items() if isinstance(conf, Mapping)]
        if _to_int(root.get("perSession"), 0) > 0 or _to_int(root.get("perDay"), 0) > 0:
            return [(str(root.get("subjectGroupId") or "__all__"), root)]
        return []

    def _add_time_limits(self) -> None:
        if self.constraints is None:
            return
        for rule in _iter_limit_rules(self.rules):
            if not isinstance(rule, Mapping):
                continue
            for si, session in enumerate(self.sessions):
                for period in range(1, 6):
                    matching = [
                        (ai, var)
                        for (ai, sj, start, length), var in self.pattern_vars.items()
                        if sj == si and start <= period < start + length and _event_matches_limit(
                            LessonEvent(
                                class_name=self.data.assignments[ai].class_name,
                                teacher=self.data.assignments[ai].teacher,
                                subject=self.data.assignments[ai].subject,
                                duration=length,
                                room=self.data.assignments[ai].room,
                            ),
                            rule,
                            self.rules,
                        )
                    ]
                    self._add_distinct_limit(matching, rule, session, period)
                per_session = rule.get("perSession") if isinstance(rule.get("perSession"), Mapping) else {}
                if per_session:
                    matching = [
                        (ai, var)
                        for (ai, sj, _start, _length), var in self.pattern_vars.items()
                        if sj == si and _event_matches_limit(
                            LessonEvent(
                                class_name=self.data.assignments[ai].class_name,
                                teacher=self.data.assignments[ai].teacher,
                                subject=self.data.assignments[ai].subject,
                                duration=1,
                                room=self.data.assignments[ai].room,
                            ),
                            rule,
                            self.rules,
                        )
                    ]
                    self._add_distinct_limit(matching, rule, session, None)

    def _add_distinct_limit(self, matching: list[tuple[int, Any]], rule: Mapping[str, Any], session: Session, period: int | None) -> None:
        fields = {
            "classes": lambda a: a.class_name,
            "teachers": lambda a: a.teacher,
            "rooms": lambda a: a.room,
            "subjects": lambda a: a.subject,
        }
        for field, getter in fields.items():
            limit = _limit_for_slot(rule, field, session)
            if period is None:
                per_session = rule.get("perSession") if isinstance(rule.get("perSession"), Mapping) else {}
                limit = _to_int(per_session.get(field), 0)
            if limit <= 0:
                continue
            values = sorted({getter(self.data.assignments[ai]) for ai, _ in matching if getter(self.data.assignments[ai])})
            active_values = []
            for value in values:
                terms = []
                for ai, var in matching:
                    if getter(self.data.assignments[ai]) != value:
                        continue
                    if period is None:
                        terms.append(var)
                    else:
                        terms.extend(
                            pvar
                            for (pai, psi, start, length), pvar in self.pattern_vars.items()
                            if pai == ai and psi == self.sessions.index(session) and start <= period < start + length
                        )
                if not terms:
                    continue
                active = self.model.NewBoolVar(f"limit_{field}_{value}_{session.day}_{session.part}_{period or 'session'}")
                for term in terms:
                    self.model.Add(term <= active)
                self.model.Add(active <= sum(terms))
                active_values.append(active)
            if active_values:
                self.model.Add(sum(active_values) <= limit)

    def _add_fixed_lessons(self) -> None:
        if not self.fixed_lessons:
            return
        assignment_by_key = {
            (a.class_name, a.subject, a.teacher): ai
            for ai, a in enumerate(self.data.assignments)
        }
        session_by_key = {(s.day, s.part): si for si, s in enumerate(self.sessions)}
        for lesson in self.fixed_lessons:
            ai = assignment_by_key.get((lesson.class_name, lesson.subject, lesson.teacher))
            si = session_by_key.get((int(lesson.day), str(lesson.session)))
            if ai is None or si is None:
                raise ExactV2NoSolution({"code": "fixed_lesson_unknown_assignment", "message": f"Tiết cố định không khớp phân công: {lesson.class_name} - {lesson.subject} - {lesson.teacher}."})
            matches = [
                var
                for (pai, psi, start, length), var in self.pattern_vars.items()
                if pai == ai and psi == si and start <= int(lesson.period) < start + length
            ]
            if not matches:
                raise ExactV2NoSolution({"code": "fixed_lesson_no_domain", "message": f"Tiết cố định không có miền hợp lệ: {lesson.class_name} Thứ {lesson.day} {lesson.session} tiết {lesson.period}."})
            self.model.Add(sum(matches) == 1)

    def build(self) -> _BuiltModel:
        self._emit({"stage": "exact_v2:model", "message": "Đang dựng mô hình CP-SAT tích hợp Solver V2"})
        self._build_assignment_patterns()
        self._add_resource_constraints()
        self._add_teacher_patterns()
        self._add_subject_rules()
        self._add_teacher_rules()
        self._add_time_limits()
        self._add_fixed_lessons()
        teacher_total = sum(self.z_vars.values())
        gap1_total = sum(self.gap1_vars.values())
        self.model.Minimize(teacher_total)
        self._emit({"stage": "exact_v2:model_ready", "message": "Mô hình đã dựng xong", "pattern_vars": len(self.pattern_vars), "teacher_session_vars": len(self.z_vars)})
        return _BuiltModel(
            cp_model=self.model,
            pattern_vars=self.pattern_vars,
            z_vars=self.z_vars,
            gap1_vars=self.gap1_vars,
            teacher_total=teacher_total,
            gap1_total=gap1_total,
            sessions=self.sessions,
            fixed_lessons=self.fixed_lessons,
            stats=dict(self.pattern_stats),
        )


def _solve_model(
    built: _BuiltModel,
    *,
    objective: Any,
    time_limit: float,
    workers: int,
    progress: ProgressFn | None,
    stage: str,
) -> tuple[Any, dict[str, Any]]:
    cp_model = _load_cp_model()
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(1.0, float(time_limit))
    solver.parameters.num_search_workers = max(1, int(workers))
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = 2
    solver.parameters.symmetry_level = 2
    built.cp_model.Minimize(objective)
    started = time.monotonic()
    status = solver.Solve(built.cp_model)
    elapsed = time.monotonic() - started
    status_name = solver.StatusName(status)
    objective_value = None
    bound = None
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        objective_value = float(solver.ObjectiveValue())
        bound = float(solver.BestObjectiveBound())
    meta = {
        "stage": stage,
        "status": int(status),
        "status_name": status_name,
        "runtime_seconds": round(elapsed, 3),
        "wall_time_seconds": float(solver.WallTime()),
        "branches": int(solver.NumBranches()),
        "conflicts": int(solver.NumConflicts()),
        "booleans": int(solver.NumBooleans()),
        "objective": objective_value,
        "best_bound": bound,
        "proven_optimal": bool(status == cp_model.OPTIMAL or (objective_value is not None and bound is not None and math.isclose(objective_value, bound, abs_tol=1e-6))),
    }
    if progress:
        progress({"stage": f"exact_v2:{stage}", "message": f"{stage}: {status_name}", **{k: v for k, v in meta.items() if k not in {"stage"}}})
    if status == cp_model.INFEASIBLE:
        raise ExactV2NoSolution({"code": f"{stage}_infeasible", "message": f"Không có lịch thỏa toàn bộ rule cứng ở pha {stage}.", "solver": meta})
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE) or not meta["proven_optimal"]:
        raise ExactV2NoSolution({"code": f"{stage}_not_proven", "message": f"Pha {stage} chưa chứng minh được nghiệm tối ưu trong thời gian cho phép; không áp lịch gần đúng.", "solver": meta})
    return solver, meta


def _materialize(built: _BuiltModel, solver: Any, data: SchoolData) -> list[Lesson]:
    lessons: list[Lesson] = []
    for (ai, si, start, length), var in built.pattern_vars.items():
        if solver.Value(var) <= 0:
            continue
        assignment = data.assignments[ai]
        session = built.sessions[si]
        for period in range(start, start + length):
            lessons.append(
                Lesson(
                    class_name=assignment.class_name,
                    grade=assignment.grade,
                    day=session.day,
                    session=session.part,
                    period=period,
                    subject=assignment.subject,
                    teacher=assignment.teacher,
                    room=assignment.room,
                )
            )
    return lessons


def _relaxed_warm_start(
    data: SchoolData,
    rules: TimetableRuleSet,
    hint_lessons: list[Lesson],
    *,
    workers: int,
    seconds: float,
) -> list[Lesson]:
    """Build a complete placement-only incumbent for the strict model.

    This is an accelerator, never a published result.  It deliberately leaves
    teacher singleton/Gap2 and student-hole quality unconstrained so CP-SAT can
    quickly discover a full assignment and then repair it in the strict model.
    """

    relaxed = _ModelBuilder(
        data,
        rules,
        [],
        None,
        enforce_class_prefix=False,
        enforce_teacher_quality=False,
        hint_lessons=hint_lessons,
    ).build()
    cp_model = _load_cp_model()
    relaxed.cp_model.Minimize(0)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(1.0, float(seconds))
    solver.parameters.num_search_workers = max(1, int(workers))
    solver.parameters.cp_model_presolve = True
    solver.parameters.linearization_level = 2
    status = solver.Solve(relaxed.cp_model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return []
    return _materialize(relaxed, solver, data)


def solve_exact_v2_from_ui_data(
    ui_data: dict[str, Any],
    settings: Mapping[str, Any] | None = None,
    *,
    progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """Solve one complete timetable with a certified lexicographic optimum."""

    settings = dict(settings or {})
    ctx: UiDataContext = build_school_data_from_ui(ui_data, strict_constraints=True)
    fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, ctx)
    try:
        hint_lessons, _hint_warnings = _extract_fixed_lessons_from_tkb(ui_data, ctx)
    except Exception:
        hint_lessons = []
    if fixed_warnings:
        ctx.warnings.extend(fixed_warnings)
    data = ctx.school_data
    rules = ctx.rules
    expected = sum(int(a.periods_per_week) for a in data.assignments)
    if expected <= 0:
        raise ExactV2NoSolution({"code": "empty_demand", "message": "Không có tiết cần xếp."})
    # "Giới hạn" is an upper bound.  A locked timetable cell cannot override
    # it or turn it into an exact target.  Report the contradiction before the
    # generic CP-SAT infeasible status so the user knows which value to edit.
    assignment_by_key = {
        (a.class_name, a.subject, a.teacher): a for a in data.assignments
    }
    fixed_by_assignment_session = Counter(
        (
            lesson.class_name,
            lesson.subject,
            lesson.teacher,
            int(lesson.day),
            str(lesson.session),
        )
        for lesson in fixed_lessons
    )
    upper_bound_conflicts = []
    for key, count in fixed_by_assignment_session.items():
        assignment = assignment_by_key.get(key[:3])
        if assignment is None or count <= int(assignment.max_periods_per_session):
            continue
        upper_bound_conflicts.append(
            {
                "class": key[0],
                "subject": key[1],
                "teacher": key[2],
                "day": key[3],
                "session": key[4],
                "fixedPeriods": int(count),
                "upperBound": int(assignment.max_periods_per_session),
            }
        )
    if upper_bound_conflicts:
        raise ExactV2NoSolution(
            {
                "code": "fixed_lessons_exceed_upper_bound",
                "message": (
                    "Tiết cố định đang vượt Giới hạn (cận trên) của phân công; "
                    "không thể vừa giữ ô cố định vừa tuân thủ giới hạn."
                ),
                "conflicts": upper_bound_conflicts[:50],
                "conflictCount": len(upper_bound_conflicts),
            }
        )
    requested = _to_int(settings.get("exact_v2_time_limit_seconds"), 0)
    if requested <= 0:
        requested = _to_int(settings.get("overall_time_limit_seconds"), 0) or 900
    workers = max(1, min(16, _to_int(settings.get("exact_v2_workers"), 0) or 8))
    build_started = time.monotonic()
    warm_start = []
    allocation_hints: dict[tuple[int, int], int] = {}
    allocation_upper_bound: int | None = None
    if expected >= 500 and str(settings.get("exact_v2_allocation_master", "1")).casefold() not in {"0", "false", "off", "no"}:
        allocation_hints, allocation_upper_bound = _session_allocation_warm_start(
            data,
            rules,
            fixed_lessons,
            workers=min(workers, 8),
            seconds=min(20.0, max(5.0, requested * 0.12)),
        )
        if progress:
            progress({"stage": "exact_v2:allocation_master", "message": "Đã giải master phân bổ buổi để giảm đối xứng", "allocation_entries": len(allocation_hints), "upper_bound": allocation_upper_bound})
    if expected >= 500 and str(settings.get("exact_v2_relaxed_warm_start", "1")).casefold() not in {"0", "false", "off", "no"}:
        warm_start = _relaxed_warm_start(
            data,
            rules,
            hint_lessons,
            workers=min(workers, 8),
            seconds=min(20.0, max(5.0, requested * 0.12)),
        )
        if warm_start:
            hint_lessons = warm_start
            if progress:
                progress({"stage": "exact_v2:warm_start", "message": "Đã có lịch đầy đủ làm điểm khởi đầu cho pha chứng minh", "hinted_lessons": len(warm_start)})
    built = _ModelBuilder(
        data,
        rules,
        fixed_lessons,
        progress,
        enforce_class_prefix=str(settings.get("exact_v2_enforce_class_prefix", "1")).casefold()
        not in {"0", "false", "off", "no"},
        enforce_teacher_quality=str(settings.get("exact_v2_enforce_teacher_quality", "1")).casefold()
        not in {"0", "false", "off", "no"},
        enforce_gap2=str(settings.get("exact_v2_enforce_gap2", "1")).casefold()
        not in {"0", "false", "off", "no"},
        hint_lessons=hint_lessons,
        allocation_hints=allocation_hints,
    ).build()
    build_seconds = time.monotonic() - build_started
    # Reserve a small but explicit slice for the second proof.  If the first
    # proof consumes it, fail closed instead of silently publishing FEASIBLE.
    stage1_budget = max(1.0, requested * 0.72)
    stage2_budget = max(1.0, requested - stage1_budget)
    solver1, stage1 = _solve_model(
        built,
        objective=built.teacher_total,
        time_limit=stage1_budget,
        workers=workers,
        progress=progress,
        stage="sessions_optimum",
    )
    teacher_opt = int(round(float(stage1["objective"])))
    built.cp_model.Add(built.teacher_total == teacher_opt)
    solver2, stage2 = _solve_model(
        built,
        objective=built.gap1_total,
        time_limit=stage2_budget,
        workers=workers,
        progress=progress,
        stage="gap1_optimum",
    )
    lessons = _materialize(built, solver2, data)
    metrics = compute_metrics(data, lessons, rules=rules)
    holes = _class_holes(data, lessons, rules)
    metrics["student_holes"] = holes
    metrics["one_period_teacher_sessions"] = int(metrics.get("one_period_teacher_sessions") or 0)
    gaps = metrics.get("gap_distribution") or {}
    gap2 = sum(int(count) for gap, count in gaps.items() if int(gap) >= 2)
    gap1 = int(gaps.get(1, 0))
    if (
        int(metrics.get("scheduled_periods") or 0) != expected
        or not metrics.get("hard_ok")
        or int(metrics.get("app_constraint_violation_count") or 0) != 0
        or metrics["one_period_teacher_sessions"] != 0
        or gap2 != 0
        or holes != 0
        or int(metrics.get("teacher_sessions") or -1) != teacher_opt
        or gap1 != int(round(float(stage2["objective"])))
    ):
        raise ExactV2NoSolution({
            "code": "post_validation_failed",
            "message": "Nghiệm CP-SAT đã chứng minh nhưng không qua validator độc lập; không áp lịch.",
            "metrics": metrics,
            "certificate": {"sessions": stage1, "gap1": stage2},
        })
    solver_meta = {
        "algorithm": "tkb_exact_v2_integrated_pattern_cp_sat",
        "version": "20260818-exact-v2-v1",
        "certificate": {
            "sessions": {"value": teacher_opt, "status": stage1["status_name"], "best_bound": stage1["best_bound"]},
            "gap1": {"value": gap1, "status": stage2["status_name"], "best_bound": stage2["best_bound"]},
            "singleton_sessions": 0,
            "gap2_plus_sessions": 0,
            "student_holes": 0,
        },
        "model": {**built.stats, "build_seconds": round(build_seconds, 3)},
        "stages": {"sessions_optimum": stage1, "gap1_optimum": stage2},
        "runtime_settings": {"exact_v2_time_limit_seconds": requested, "exact_v2_workers": workers},
        "fixed_lessons": len(fixed_lessons),
    }
    payload = build_payload(
        ctx,
        lessons,
        solver_meta,
        rules,
        original_ctx=ctx,
        best_effort=False,
        deadline_exhausted=False,
    )
    payload_metrics = payload.setdefault("metrics", {})
    payload_metrics["student_holes"] = holes
    payload_metrics["teacher_gap2_sessions"] = gap2
    payload_metrics["exact_v2_quality_contract_ok"] = True
    return payload
