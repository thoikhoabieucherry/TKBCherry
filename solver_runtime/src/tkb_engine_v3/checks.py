"""Class-side constraint checks shared by State (hard) and SoftState (phase 1/2).

All functions operate on a plain grid (list of 60-slot rows per class) so they
can be used both with and without teacher-conflict enforcement. They return a
failure reason string, or None when the scope is valid.
"""

from __future__ import annotations

from .core import NUM_DAYS, NUM_SESSIONS, PERIODS, Problem


def check_class_session(P: Problem, grid: list[list[int]], c: int, s: int, defer_min: bool) -> str | None:
    base = s * PERIODS
    row = grid[c]
    part = s % 2
    subj_periods: dict[int, list[int]] = {}
    subj_assign: dict[int, int] = {}
    for p in range(PERIODS):
        ai = row[base + p]
        if ai < 0:
            continue
        si = P.a_subject[ai]
        subj_periods.setdefault(si, []).append(p)
        subj_assign[si] = ai
    if not subj_periods:
        return None
    for si, periods in subj_periods.items():
        ai = subj_assign[si]
        n = len(periods)
        if n > P.a_cap[ai]:
            return "subject_session_cap"
        if n > 1 and (periods[-1] - periods[0] + 1) != n:
            return "contiguity"
        rule = P.a_rule[ai]
        if rule is not None:
            cap = rule.session_part_cap[part]
            if cap > 0 and n > cap:
                return "rule_session_part_cap"
            if rule.linked_avoided[s] and n > 1:
                return "linked_days"
            pset = set(periods)
            if rule.avoid23[part] and 1 in pset and 2 in pset:
                return "avoid23"
            if rule.avoid34[part] and 2 in pset and 3 in pset:
                return "avoid34"
    for group in P.no_same_session[c]:
        hits = 0
        for si in subj_periods:
            if si in group:
                hits += 1
                if hits > 1:
                    return "no_same_session"
    if P.group_rule_keys:
        by_group: dict[str, list[int]] = {}
        for si in subj_periods:
            for gid in P.subject_groups.get(si, ()):
                if (c, gid) in P.group_rule_keys:
                    by_group.setdefault(gid, []).append(si)
        for gid, members in by_group.items():
            grule = P.group_rule_keys[(c, gid)]
            cap = grule.max_subjects_part[part]
            if cap > 0 and len(members) > cap:
                return "group_max_subjects"
            cap2 = grule.session_part_cap[part]
            if cap2 > 0 and sum(len(subj_periods[si]) for si in members) > cap2:
                return "group_session_cap"
    return None


def class_subject_sessions(P: Problem, grid: list[list[int]], c: int, si: int) -> dict[int, list[int]]:
    out: dict[int, list[int]] = {}
    row = grid[c]
    for s in range(NUM_SESSIONS):
        base = s * PERIODS
        periods = [p for p in range(PERIODS) if row[base + p] >= 0 and P.a_subject[row[base + p]] == si]
        if periods:
            out[s] = periods
    return out


def check_class_subject_week(
    P: Problem,
    grid: list[list[int]],
    c: int,
    si: int,
    ai_hint: int,
    defer_min: bool,
) -> str | None:
    ai = ai_hint
    if ai < 0:
        for cand in range(P.num_assignments()):
            if P.a_class[cand] == c and P.a_subject[cand] == si:
                ai = cand
                break
    rule = P.a_rule[ai] if ai >= 0 else None
    if rule is None:
        return None
    sessions = class_subject_sessions(P, grid, c, si)
    if not sessions:
        return None
    if rule.one_session_per_day:
        days = [s // 2 for s in sessions]
        if len(days) != len(set(days)):
            return "subject_one_session_per_day"
    for part in range(2):
        cap = rule.weekly_part_cap[part]
        if cap > 0:
            total = sum(len(ps) for s, ps in sessions.items() if s % 2 == part)
            if total > cap:
                return "weekly_part_cap"
    for d in range(NUM_DAYS):
        cap = rule.day_cap[d]
        if cap > 0:
            total = sum(len(ps) for s, ps in sessions.items() if s // 2 == d)
            if total > cap:
                return "subject_day_cap"
    if rule.max_sessions_week > 0 and len(sessions) > rule.max_sessions_week:
        return "subject_max_sessions"
    if rule.spacing_days > 0:
        days_sorted = sorted({s // 2 for s in sessions})
        for left, right in zip(days_sorted, days_sorted[1:]):
            if right - left <= rule.spacing_days:
                return "spacing_days"
    if rule.lesson_blocks:
        for length, minimum, maximum in rule.lesson_blocks:
            blocks = sum(1 for ps in sessions.values() if len(ps) >= length)
            if minimum > 0 and blocks < minimum and not defer_min:
                return f"lesson_blocks_min_{length}"
            if maximum > 0 and blocks > maximum:
                return f"lesson_blocks_max_{length}"
    return None


def check_class_day(P: Problem, grid: list[list[int]], c: int, d: int) -> str | None:
    if not P.no_same_day[c]:
        return None
    row = grid[c]
    subjects: set[int] = set()
    for s in (d * 2, d * 2 + 1):
        base = s * PERIODS
        for p in range(PERIODS):
            ai = row[base + p]
            if ai >= 0:
                subjects.add(P.a_subject[ai])
    for group in P.no_same_day[c]:
        if len(subjects & group) > 1:
            return "no_same_day"
    return None
