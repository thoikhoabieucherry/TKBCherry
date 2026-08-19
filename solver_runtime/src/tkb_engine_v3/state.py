"""Schedule state with incremental hard checks and lexicographic objective.

Objective tuple (smaller is better), maintained incrementally:
    (one_period_sessions, gap2_sessions, teacher_sessions, gap1_sessions, teacher_days)
Hard validity is an invariant: `apply` refuses (and rolls back) any change set
that would violate a hard/app constraint, so every reachable state is valid.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from . import checks
from .core import (
    NUM_DAYS,
    NUM_SESSIONS,
    NUM_SLOTS,
    PERIODS,
    Problem,
    SubjectRule,
    _to_int,
)


class HardCheckError(Exception):
    pass


class State:
    __slots__ = (
        "P",
        "grid",
        "locked",
        "teacher_slot",
        "ts_count",
        "ts_first",
        "ts_last",
        "t_day_sessions",
        "n_singleton",
        "n_gap2",
        "n_sessions",
        "n_gap1",
        "n_days",
        "placed",
        "a_placed",
        "check_fail_reason",
        "defer_min",
    )

    def __init__(self, problem: Problem, defer_min: bool = False):
        self.P = problem
        C = problem.num_classes()
        T = problem.num_teachers()
        self.grid = [[-1] * NUM_SLOTS for _ in range(C)]
        self.locked = [bytearray(NUM_SLOTS) for _ in range(C)]
        self.teacher_slot = [[-1] * NUM_SLOTS for _ in range(T)]
        self.ts_count = [[0] * NUM_SESSIONS for _ in range(T)]
        self.ts_first = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.ts_last = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.t_day_sessions = [[0] * NUM_DAYS for _ in range(T)]
        self.n_singleton = 0
        self.n_gap2 = 0
        self.n_sessions = 0
        self.n_gap1 = 0
        self.n_days = 0
        self.placed = 0
        self.a_placed = [0] * problem.num_assignments()
        self.check_fail_reason = ""
        self.defer_min = defer_min

    # ------------------------------------------------------------------
    # objective
    # ------------------------------------------------------------------

    def objective(self) -> tuple[int, int, int, int, int]:
        return (self.n_singleton, self.n_gap2, self.n_sessions, self.n_gap1, self.n_days)

    def _session_contrib(self, t: int, s: int) -> tuple[int, int, int, int]:
        count = self.ts_count[t][s]
        if count == 0:
            return (0, 0, 0, 0)
        gap = self.ts_last[t][s] - self.ts_first[t][s] + 1 - count
        return (
            1 if count == 1 else 0,
            1 if gap >= 2 else 0,
            1,
            1 if gap == 1 else 0,
        )

    def _refresh_ts(self, t: int, s: int) -> None:
        """Recompute cached stats + aggregate contributions for (teacher, session)."""

        old = self._session_contrib(t, s)
        base = s * PERIODS
        row = self.teacher_slot[t]
        count = 0
        first = -1
        last = -1
        for p in range(PERIODS):
            if row[base + p] >= 0:
                count += 1
                if first < 0:
                    first = p
                last = p
        prev_count = self.ts_count[t][s]
        self.ts_count[t][s] = count
        self.ts_first[t][s] = first
        self.ts_last[t][s] = last
        new = self._session_contrib(t, s)
        self.n_singleton += new[0] - old[0]
        self.n_gap2 += new[1] - old[1]
        self.n_sessions += new[2] - old[2]
        self.n_gap1 += new[3] - old[3]
        d = s // 2
        had = self.t_day_sessions[t][d]
        now = had + ((1 if count > 0 else 0) - (1 if prev_count > 0 else 0))
        self.t_day_sessions[t][d] = now
        if had == 0 and now > 0:
            self.n_days += 1
        elif had > 0 and now == 0:
            self.n_days -= 1

    # ------------------------------------------------------------------
    # low-level cell edit
    # ------------------------------------------------------------------

    def _write_cell(self, c: int, slot: int, ai: int, journal: list) -> bool:
        old = self.grid[c][slot]
        if old == ai:
            return True
        P = self.P
        if old >= 0:
            t = P.a_teacher[old]
            if t >= 0:
                self.teacher_slot[t][slot] = -1
            self.a_placed[old] -= 1
            self.placed -= 1
        if ai >= 0:
            t = P.a_teacher[ai]
            if t >= 0:
                if self.teacher_slot[t][slot] >= 0:
                    # teacher conflict: rollback this cell write and fail
                    if old >= 0:
                        told = P.a_teacher[old]
                        if told >= 0:
                            self.teacher_slot[told][slot] = old
                        self.a_placed[old] += 1
                        self.placed += 1
                    self.check_fail_reason = "teacher_conflict"
                    return False
                self.teacher_slot[t][slot] = ai
            self.a_placed[ai] += 1
            self.placed += 1
        self.grid[c][slot] = ai
        journal.append((c, slot, old, ai))
        return True

    def _rollback(self, journal: list) -> None:
        P = self.P
        for c, slot, old, new in reversed(journal):
            if new >= 0:
                t = P.a_teacher[new]
                if t >= 0:
                    self.teacher_slot[t][slot] = -1
                self.a_placed[new] -= 1
                self.placed -= 1
            if old >= 0:
                t = P.a_teacher[old]
                if t >= 0:
                    self.teacher_slot[t][slot] = old
                self.a_placed[old] += 1
                self.placed += 1
            self.grid[c][slot] = old

    # ------------------------------------------------------------------
    # scope checks (hard + app constraints)
    # ------------------------------------------------------------------

    def _check_class_session(self, c: int, s: int) -> bool:
        reason = checks.check_class_session(self.P, self.grid, c, s, self.defer_min)
        if reason is not None:
            self.check_fail_reason = reason
            return False
        return True

    def _check_class_subject_week(self, c: int, si: int, ai_hint: int = -1) -> bool:
        reason = checks.check_class_subject_week(self.P, self.grid, c, si, ai_hint, self.defer_min)
        if reason is not None:
            self.check_fail_reason = reason
            return False
        return True

    def _check_class_day(self, c: int, d: int) -> bool:
        reason = checks.check_class_day(self.P, self.grid, c, d)
        if reason is not None:
            self.check_fail_reason = reason
            return False
        return True

    def _check_teacher(self, t: int, days: Iterable[int]) -> bool:
        P = self.P
        rule = P.teacher_rules[t]
        must = P.teacher_must[t]
        if must and not self.defer_min:
            for slot in must:
                if self.teacher_slot[t][slot] < 0:
                    self.check_fail_reason = "must_teach"
                    return False
        if rule is None:
            return True
        counts = self.ts_count[t]
        for d in days:
            am = counts[d * 2]
            pm = counts[d * 2 + 1]
            mode = rule.session_mode[d]
            if mode == "morning" and pm > 0:
                self.check_fail_reason = "teacher_one_session"
                return False
            if mode == "afternoon" and am > 0:
                self.check_fail_reason = "teacher_one_session"
                return False
            if mode == "either" and am > 0 and pm > 0:
                self.check_fail_reason = "teacher_one_session"
                return False
            cap = rule.day_period_cap[d]
            if cap > 0 and am + pm > cap:
                self.check_fail_reason = "teacher_day_cap"
                return False
            cap_am, cap_pm = rule.session_period_cap[d]
            if cap_am > 0 and am > cap_am:
                self.check_fail_reason = "teacher_session_cap"
                return False
            if cap_pm > 0 and pm > cap_pm:
                self.check_fail_reason = "teacher_session_cap"
                return False
            if rule.no_m5_a1[d]:
                if self.teacher_slot[t][(d * 2) * PERIODS + 4] >= 0 and self.teacher_slot[t][(d * 2 + 1) * PERIODS] >= 0:
                    self.check_fail_reason = "no_m5_a1"
                    return False
        if rule.max_days > 0 or rule.max_sessions > 0 or rule.max_morning > 0 or rule.max_afternoon > 0:
            used_days = 0
            used_sessions = 0
            used_am = 0
            used_pm = 0
            for d in range(NUM_DAYS):
                am = counts[d * 2]
                pm = counts[d * 2 + 1]
                if am > 0:
                    used_sessions += 1
                    used_am += 1
                if pm > 0:
                    used_sessions += 1
                    used_pm += 1
                if am > 0 or pm > 0:
                    used_days += 1
            if rule.max_days > 0 and used_days > rule.max_days:
                self.check_fail_reason = "teacher_max_days"
                return False
            if rule.max_sessions > 0 and used_sessions > rule.max_sessions:
                self.check_fail_reason = "teacher_max_sessions"
                return False
            if rule.max_morning > 0 and used_am > rule.max_morning:
                self.check_fail_reason = "teacher_max_morning"
                return False
            if rule.max_afternoon > 0 and used_pm > rule.max_afternoon:
                self.check_fail_reason = "teacher_max_afternoon"
                return False
        if rule.class_period_caps:
            row = self.teacher_slot[t]
            for subject_set, per_session, per_day in rule.class_period_caps:
                for d in days:
                    per_class_day: dict[int, int] = {}
                    for s in (d * 2, d * 2 + 1):
                        per_class_sess: dict[int, int] = {}
                        base = s * PERIODS
                        for p in range(PERIODS):
                            ai = row[base + p]
                            if ai < 0:
                                continue
                            if subject_set is not None and P.subject_names[P.a_subject[ai]] not in subject_set:
                                continue
                            ci = P.a_class[ai]
                            per_class_sess[ci] = per_class_sess.get(ci, 0) + 1
                            per_class_day[ci] = per_class_day.get(ci, 0) + 1
                        if per_session > 0 and per_class_sess and max(per_class_sess.values()) > per_session:
                            self.check_fail_reason = "teacher_class_session_cap"
                            return False
                    if per_day > 0 and per_class_day and max(per_class_day.values()) > per_day:
                        self.check_fail_reason = "teacher_class_day_cap"
                        return False
        return True

    def _check_time_limits(self, slots: Iterable[int]) -> bool:
        P = self.P
        if not P.time_limit_rules:
            return True
        # Rare in practice; evaluate matched-field cardinalities on the touched
        # slots and their sessions.
        sessions = sorted({s // PERIODS for s in slots})
        touched_slots = sorted(set(slots))
        for rule in P.time_limit_rules:
            per_session = rule.get("perSession", {}) if isinstance(rule.get("perSession"), Mapping) else {}
            for slot in touched_slots:
                matched = self._matched_lessons_at(rule, [slot])
                if not matched:
                    continue
                d = slot // (2 * PERIODS)
                part = (slot // PERIODS) % 2
                for field_name, key in (("classes", 0), ("teachers", 1), ("rooms", 2), ("subjects", 3)):
                    limit = self._limit_for_slot(rule, field_name, d, part)
                    if limit > 0 and len({m[key] for m in matched if m[key] != ""}) > limit:
                        self.check_fail_reason = "time_limit_slot"
                        return False
            for s in sessions:
                base = s * PERIODS
                matched = self._matched_lessons_at(rule, range(base, base + PERIODS))
                if not matched:
                    continue
                for field_name, key in (("classes", 0), ("teachers", 1), ("rooms", 2), ("subjects", 3)):
                    limit = _to_int(per_session.get(field_name), 0)
                    if limit > 0 and len({m[key] for m in matched if m[key] != ""}) > limit:
                        self.check_fail_reason = "time_limit_session"
                        return False
        return True

    def _matched_lessons_at(self, rule: Mapping[str, Any], slots: Iterable[int]) -> list[tuple[str, str, str, str]]:
        P = self.P
        target_type = str(rule.get("targetType") or "")
        target_id = str(rule.get("targetId") or "")
        out: list[tuple[str, str, str, str]] = []
        for slot in slots:
            for c in range(P.num_classes()):
                ai = self.grid[c][slot]
                if ai < 0:
                    continue
                cname = P.class_names[c]
                tname = P.teacher_names[P.a_teacher[ai]] if P.a_teacher[ai] >= 0 else ""
                sname = P.subject_names[P.a_subject[ai]]
                room = P.a_room[ai]
                ok = False
                if target_type == "class":
                    ok = cname == target_id
                elif target_type == "teacher":
                    ok = tname == target_id
                elif target_type == "subject":
                    ok = sname == target_id
                elif target_type == "room":
                    ok = bool(room) and room == target_id
                elif target_type in {"subjectGroup", "teacherGroup", "classGroup", "roomGroup"}:
                    ok = self._in_group(target_type, target_id, cname, tname, sname, room)
                if ok:
                    out.append((cname, tname, room, sname))
        return out

    def _in_group(self, target_type: str, target_id: str, cname: str, tname: str, sname: str, room: str) -> bool:
        # group membership resolved through raw constraint groups kept on rules
        groups = getattr(self.P, "_raw_groups", None)
        if groups is None:
            return False
        kind = {"subjectGroup": "subject", "teacherGroup": "teacher", "classGroup": "class", "roomGroup": "room"}[target_type]
        items = groups.get(kind, {}).get(target_id, frozenset())
        value = {"subject": sname, "teacher": tname, "class": cname, "room": room}[kind]
        return value in items

    @staticmethod
    def _limit_for_slot(rule: Mapping[str, Any], field_name: str, d: int, part: int) -> int:
        by_session = rule.get("perSlotBySession", {}) if isinstance(rule.get("perSlotBySession"), Mapping) else {}
        value = None
        field_map = by_session.get(field_name) if isinstance(by_session, Mapping) else None
        path = f"{_PART_KEYS_LOCAL[part]}.{_DAY_KEYS_LOCAL[d]}"
        if isinstance(field_map, Mapping):
            value = _get_path_local(field_map, path)
        if value is None and isinstance(by_session, Mapping):
            value = _get_path_local(by_session, path)
        limit = _to_int(value, 0)
        if limit > 0:
            return limit
        per_slot = rule.get("perSlot", {}) if isinstance(rule.get("perSlot"), Mapping) else {}
        return _to_int(per_slot.get(field_name), 0)

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def lock_cell(self, c: int, slot: int) -> None:
        self.locked[c][slot] = 1

    def apply(self, changes: list[tuple[int, int, int]], *, check: bool = True):
        """Apply cell changes atomically.

        Returns an undo journal on success, None on hard violation (state
        untouched). ``changes`` = [(class, slot, assignment_or_-1)].
        """

        P = self.P
        journal: list = []
        for c, slot, ai in changes:
            if self.locked[c][slot] and self.grid[c][slot] != ai:
                self.check_fail_reason = "locked"
                self._rollback(journal)
                return None
            if ai >= 0:
                if P.a_class[ai] != c or not P.a_allowed[ai][slot]:
                    self.check_fail_reason = "not_allowed"
                    self._rollback(journal)
                    return None
            if not self._write_cell(c, slot, ai, journal):
                self._rollback(journal)
                return None
        if not journal:
            return journal
        if check and not self._check_scopes(journal):
            self._rollback(journal)
            return None
        # refresh teacher-session stats for touched (t, s)
        touched_ts: set[tuple[int, int]] = set()
        for c, slot, old, new in journal:
            s = slot // PERIODS
            if old >= 0 and P.a_teacher[old] >= 0:
                touched_ts.add((P.a_teacher[old], s))
            if new >= 0 and P.a_teacher[new] >= 0:
                touched_ts.add((P.a_teacher[new], s))
        for t, s in touched_ts:
            self._refresh_ts(t, s)
        return journal

    def undo(self, journal: list) -> None:
        P = self.P
        self._rollback(journal)
        touched_ts: set[tuple[int, int]] = set()
        for c, slot, old, new in journal:
            s = slot // PERIODS
            if old >= 0 and P.a_teacher[old] >= 0:
                touched_ts.add((P.a_teacher[old], s))
            if new >= 0 and P.a_teacher[new] >= 0:
                touched_ts.add((P.a_teacher[new], s))
        for t, s in touched_ts:
            self._refresh_ts(t, s)

    def _check_scopes(self, journal: list) -> bool:
        P = self.P
        class_sessions: set[tuple[int, int]] = set()
        class_subjects: set[tuple[int, int, int]] = set()
        class_days: set[tuple[int, int]] = set()
        teacher_days: dict[int, set[int]] = {}
        slots: set[int] = set()
        for c, slot, old, new in journal:
            s = slot // PERIODS
            d = s // 2
            class_sessions.add((c, s))
            class_days.add((c, d))
            slots.add(slot)
            for ai in (old, new):
                if ai >= 0:
                    class_subjects.add((c, P.a_subject[ai], ai))
                    t = P.a_teacher[ai]
                    if t >= 0:
                        teacher_days.setdefault(t, set()).add(d)
        for c, s in class_sessions:
            if not self._check_class_session(c, s):
                return False
        for c, si, ai in class_subjects:
            if not self._check_class_subject_week(c, si, ai):
                return False
        for c, d in class_days:
            if not self._check_class_day(c, d):
                return False
        for t, days in teacher_days.items():
            if not self._check_teacher(t, days):
                return False
        if not self._check_time_limits(slots):
            return False
        return True

    # ------------------------------------------------------------------
    # export / import
    # ------------------------------------------------------------------

    def snapshot(self) -> list[list[int]]:
        return [row[:] for row in self.grid]

    def restore(self, snap: list[list[int]]) -> None:
        P = self.P
        defer = self.defer_min
        # full rebuild (used rarely: restarts / best-restore)
        self.__init__(P, defer)
        for c in range(P.num_classes()):
            for slot in range(NUM_SLOTS):
                ai = snap[c][slot]
                if ai >= 0:
                    ok = self.apply([(c, slot, ai)], check=False)
                    if ok is None:
                        raise HardCheckError("restore produced conflict")
        for c, slot, ai in P.fixed_cells:
            self.lock_cell(c, slot)

    def full_recheck(self) -> bool:
        """Validate every scope from scratch (used as an internal gate)."""

        P = self.P
        for c in range(P.num_classes()):
            for s in range(NUM_SESSIONS):
                if not self._check_class_session(c, s):
                    return False
            subjects = {P.a_subject[ai] for ai in self.grid[c] if ai >= 0}
            for si in subjects:
                if not self._check_class_subject_week(c, si):
                    return False
            for d in range(NUM_DAYS):
                if not self._check_class_day(c, d):
                    return False
        for t in range(P.num_teachers()):
            if not self._check_teacher(t, range(NUM_DAYS)):
                return False
        if not self._check_time_limits(range(NUM_SLOTS)):
            return False
        return True


_DAY_KEYS_LOCAL = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
_PART_KEYS_LOCAL = ["sang", "chieu"]


def _get_path_local(obj: Mapping[str, Any] | None, path: str, default: Any = None) -> Any:
    cur: Any = obj or {}
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return default
        cur = cur[part]
    return default if cur is None else cur
