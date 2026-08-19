"""Two-phase construction (always returns a hard-valid State).

Phase 1 — per-class tiling: fill each class's available cells with its subject
blocks (randomized DFS, class-side constraints only, teacher availability as a
hard mask). Independent per class, always succeeds fast on real data.

Phase 2 — min-conflicts repair: teacher double-bookings (plus teacher-rule and
mustTeach debts) are melted to zero by swapping same-length run windows inside
classes, guided by an incremental penalty. Classic approach for tightly packed
schools where every class cell is used.

The result loads into State (full hard checks) before being returned.
"""

from __future__ import annotations

import random
import time

from . import checks
from .core import NUM_DAYS, NUM_SESSIONS, NUM_SLOTS, PERIODS, Problem, TeacherRule
from .state import State


def _block_sizes(residual: int, cap: int, need_double: bool, rng: random.Random) -> list[int]:
    sizes: list[int] = []
    r = residual
    while r > 0:
        take = min(cap, r)
        sizes.append(take)
        r -= take
    if need_double and sizes and max(sizes) < 2 and residual >= 2 and cap >= 2:
        sizes.remove(1)
        sizes.remove(1)
        sizes.append(2)
    # occasional alternative split (3 -> 2+1 stays, 4 -> 2+2 instead of cap 3+1 …)
    if rng.random() < 0.35 and cap >= 2:
        alt: list[int] = []
        r = residual
        while r > 0:
            take = min(2, r) if r != 3 or rng.random() < 0.5 else 3
            take = min(take, cap, r)
            alt.append(take)
            r -= take
        if need_double and alt and max(alt) < 2 and residual >= 2:
            alt.remove(1)
            alt.remove(1)
            alt.append(2)
        sizes = alt
    return sorted(sizes, reverse=True)


class SoftSchedule:
    """Grid + teacher occupancy counters allowing conflicts (phase 1/2)."""

    def __init__(self, P: Problem):
        self.P = P
        T = P.num_teachers()
        self.grid: list[list[int]] = [[-1] * NUM_SLOTS for _ in range(P.num_classes())]
        self.locked: list[bytearray] = [bytearray(NUM_SLOTS) for _ in range(P.num_classes())]
        self.tcnt: list[list[int]] = [[0] * NUM_SLOTS for _ in range(T)]
        self.overlap = 0          # sum over (t,slot) of max(0, cnt-1)
        self.conflicts: set[tuple[int, int]] = set()  # (t, slot) with cnt >= 2
        self.rule_pen: list[int] = [0] * T
        self.rule_pen_total = 0
        # teacher-session quality stats (slots with cnt >= 1)
        self.ts_cnt: list[list[int]] = [[0] * NUM_SESSIONS for _ in range(T)]
        self.ts_first: list[list[int]] = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.ts_last: list[list[int]] = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.q_singleton = 0
        self.q_gap2 = 0
        self.q_gap1 = 0
        self.q_sessions = 0
        self.q_days = 0
        self.t_day_sessions: list[list[int]] = [[0] * NUM_DAYS for _ in range(T)]
        self.track_quality = False

    def enable_quality_tracking(self) -> None:
        """Recompute all teacher-session stats and switch on incremental upkeep."""

        T = self.P.num_teachers()
        self.ts_cnt = [[0] * NUM_SESSIONS for _ in range(T)]
        self.ts_first = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.ts_last = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.t_day_sessions = [[0] * NUM_DAYS for _ in range(T)]
        self.q_singleton = self.q_gap2 = self.q_gap1 = self.q_sessions = self.q_days = 0
        self.track_quality = True
        for t in range(T):
            for s in range(NUM_SESSIONS):
                self._refresh_ts(t, s)

    def _ts_contrib(self, t: int, s: int) -> tuple[int, int, int, int]:
        cnt = self.ts_cnt[t][s]
        if cnt == 0:
            return (0, 0, 0, 0)
        gap = self.ts_last[t][s] - self.ts_first[t][s] + 1 - cnt
        return (
            1 if cnt == 1 else 0,
            1 if gap >= 2 else 0,
            1 if gap == 1 else 0,
            1,
        )

    def _refresh_ts(self, t: int, s: int) -> None:
        old = self._ts_contrib(t, s)
        prev_cnt = self.ts_cnt[t][s]
        base = s * PERIODS
        row = self.tcnt[t]
        cnt = 0
        first = -1
        last = -1
        for p in range(PERIODS):
            if row[base + p] > 0:
                cnt += 1
                if first < 0:
                    first = p
                last = p
        self.ts_cnt[t][s] = cnt
        self.ts_first[t][s] = first
        self.ts_last[t][s] = last
        new = self._ts_contrib(t, s)
        self.q_singleton += new[0] - old[0]
        self.q_gap2 += new[1] - old[1]
        self.q_gap1 += new[2] - old[2]
        self.q_sessions += new[3] - old[3]
        d = s // 2
        had = self.t_day_sessions[t][d]
        now = had + ((1 if cnt > 0 else 0) - (1 if prev_cnt > 0 else 0))
        self.t_day_sessions[t][d] = now
        if had == 0 and now > 0:
            self.q_days += 1
        elif had > 0 and now == 0:
            self.q_days -= 1

    # -- primitive cell ops (class-side validity is caller's duty) ---------

    def set_cell(self, c: int, slot: int, ai: int) -> None:
        old = self.grid[c][slot]
        if old == ai:
            return
        P = self.P
        touched: list[int] = []
        if old >= 0:
            t = P.a_teacher[old]
            if t >= 0:
                cnt = self.tcnt[t][slot]
                if cnt > 1:
                    self.overlap -= 1
                self.tcnt[t][slot] = cnt - 1
                if cnt - 1 <= 1:
                    self.conflicts.discard((t, slot))
                touched.append(t)
        if ai >= 0:
            t = P.a_teacher[ai]
            if t >= 0:
                cnt = self.tcnt[t][slot]
                if cnt >= 1:
                    self.overlap += 1
                    self.conflicts.add((t, slot))
                self.tcnt[t][slot] = cnt + 1
                touched.append(t)
        self.grid[c][slot] = ai
        if self.track_quality and touched:
            s = slot // PERIODS
            for t in touched:
                self._refresh_ts(t, s)

    def quality(self) -> tuple[int, int, int, int, int]:
        return (self.q_singleton, self.q_gap2, self.q_sessions, self.q_gap1, self.q_days)

    def teacher_rule_penalty(self, t: int) -> int:
        P = self.P
        rule = P.teacher_rules[t]
        must = P.teacher_must[t]
        pen = 0
        row = self.tcnt[t]
        if must:
            for slot in must:
                if row[slot] <= 0:
                    pen += 1
        if rule is None:
            return pen
        session_counts = [0] * NUM_SESSIONS
        for s in range(NUM_SESSIONS):
            base = s * PERIODS
            session_counts[s] = sum(1 for p in range(PERIODS) if row[base + p] > 0)
        used_days = used_sessions = used_am = used_pm = 0
        for d in range(NUM_DAYS):
            am = session_counts[d * 2]
            pm = session_counts[d * 2 + 1]
            mode = rule.session_mode[d]
            if mode == "morning" and pm > 0:
                pen += pm
            elif mode == "afternoon" and am > 0:
                pen += am
            elif mode == "either" and am > 0 and pm > 0:
                pen += min(am, pm)
            cap = rule.day_period_cap[d]
            if cap > 0 and am + pm > cap:
                pen += am + pm - cap
            cap_am, cap_pm = rule.session_period_cap[d]
            if cap_am > 0 and am > cap_am:
                pen += am - cap_am
            if cap_pm > 0 and pm > cap_pm:
                pen += pm - cap_pm
            if rule.no_m5_a1[d] and row[(d * 2) * PERIODS + 4] > 0 and row[(d * 2 + 1) * PERIODS] > 0:
                pen += 1
            if am > 0:
                used_sessions += 1
                used_am += 1
            if pm > 0:
                used_sessions += 1
                used_pm += 1
            if am > 0 or pm > 0:
                used_days += 1
        if rule.max_days > 0 and used_days > rule.max_days:
            pen += used_days - rule.max_days
        if rule.max_sessions > 0 and used_sessions > rule.max_sessions:
            pen += used_sessions - rule.max_sessions
        if rule.max_morning > 0 and used_am > rule.max_morning:
            pen += used_am - rule.max_morning
        if rule.max_afternoon > 0 and used_pm > rule.max_afternoon:
            pen += used_pm - rule.max_afternoon
        # NOTE: class_period_caps handled by State at load; rare in practice.
        return pen

    def refresh_rule_pen(self, t: int) -> None:
        new = self.teacher_rule_penalty(t)
        self.rule_pen_total += new - self.rule_pen[t]
        self.rule_pen[t] = new

    def penalty(self) -> int:
        return self.overlap + self.rule_pen_total


class Constructor:
    def __init__(self, problem: Problem, seed: int = 0):
        self.P = problem
        self.rng = random.Random(seed)
        # "gap1" = nut Toi uu trong 1 tiet: uu tien giam gap1, khong bao gio
        # cho tong so buoi vuot qua muc luc bat dau (_session_cap).
        self.quality_focus: str | None = None
        self._session_cap: int | None = None
        self._has_rule_teachers = [
            t
            for t in range(problem.num_teachers())
            if problem.teacher_rules[t] is not None or problem.teacher_must[t]
        ]

    # ------------------------------------------------------------------

    def solve(self, deadline: float, *, progress=None, warm_cells=None) -> tuple[State, dict]:
        """Full pipeline: feasibility (phase 1+2) then quality walk (phase 3).

        Returns (state, info). Completeness has absolute priority; the quality
        walk only runs on a complete, conflict-free schedule. When warm_cells
        (a complete, valid existing schedule) is provided, construction is
        skipped and the whole budget goes into improving that incumbent — the
        result can then never be worse than what the user already has.
        """

        P = self.P
        expected = sum(P.a_periods)
        info: dict = {"expected": expected}
        if warm_cells:
            soft = SoftSchedule(P)
            for c, slot, ai in P.fixed_cells:
                if soft.grid[c][slot] == -1:
                    soft.set_cell(c, slot, ai)
                    soft.locked[c][slot] = 1
            for c, slot, ai in warm_cells:
                if soft.grid[c][slot] == -1:
                    soft.set_cell(c, slot, ai)
            placed = sum(1 for row in soft.grid for v in row if v >= 0)
            if placed >= expected and soft.penalty() == 0:
                probe = self._load_state(soft)
                if probe is not None and probe.placed >= expected:
                    info["warm_start"] = True
                    info["feasibility_attempts"] = 0
                    info["feasibility_seconds"] = 0.0
                    if time.monotonic() < deadline - 5:
                        soft.enable_quality_tracking()
                        self.phase3_quality(soft, deadline, progress=progress)
                        self.compact_student_holes(soft)
                    forced_singles, forced_gap2s, evidence = getattr(
                        self, "_floors_cache", None
                    ) or self.structural_floors()
                    info["floors"] = {
                        "one_period_floor": len(forced_singles),
                        "gap2_floor": len(forced_gap2s),
                        "evidence": evidence[:20],
                    }
                    state = self._load_state(soft)
                    if state is not None:
                        return state, info
            info["warm_start_rejected"] = True
            # Warm khong hop le/khong du (vi du lich do CP-SAT dua sang con
            # thieu vai tiet hoac vi pham luat lop): SUA CUC BO thay vi vut di —
            # chi lam lai nhung lop co van de, giu nguyen cau truc con lai.
            repaired = self._repair_partial_warm(soft, expected, deadline)
            if repaired is not None:
                info["warm_start"] = True
                info["warm_repaired"] = True
                info["feasibility_attempts"] = 0
                info["feasibility_seconds"] = 0.0
                if time.monotonic() < deadline - 5:
                    repaired.enable_quality_tracking()
                    self.phase3_quality(repaired, deadline, progress=progress)
                    self.compact_student_holes(repaired)
                forced_singles, forced_gap2s, evidence = getattr(
                    self, "_floors_cache", None
                ) or self.structural_floors()
                info["floors"] = {
                    "one_period_floor": len(forced_singles),
                    "gap2_floor": len(forced_gap2s),
                    "evidence": evidence[:20],
                }
                state = self._load_state(repaired)
                if state is not None:
                    return state, info
        best_soft: SoftSchedule | None = None
        best_pen = 1 << 30
        best_placed = -1
        complete_soft: SoftSchedule | None = None
        attempts = 0
        started = time.monotonic()

        def clone_from_grid(grid: list[list[int]]) -> SoftSchedule:
            fresh = SoftSchedule(P)
            for c, slot, ai in P.fixed_cells:
                if fresh.grid[c][slot] == -1:
                    fresh.set_cell(c, slot, ai)
                    fresh.locked[c][slot] = 1
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    ai = grid[c][slot]
                    if ai >= 0 and fresh.grid[c][slot] == -1:
                        fresh.set_cell(c, slot, ai)
            for t in self._has_rule_teachers:
                fresh.refresh_rule_pen(t)
            return fresh

        # Completeness gets priority, but never the WHOLE budget: an impossible
        # remainder must not steal the quality optimization of everything else.
        feas_deadline = min(deadline, started + max(20.0, (deadline - started) * 0.6))
        while time.monotonic() < feas_deadline:
            attempts += 1
            if attempts % 4 == 0 and best_soft is not None and best_pen <= 8:
                # ILS: retry from the best near-feasible grid with a fresh walk
                soft = clone_from_grid(best_soft.grid)
                self._phase2(soft, min(feas_deadline, time.monotonic() + 12.0))
            else:
                soft, _tiled = self._phase1(feas_deadline)
                self._phase2(soft, min(feas_deadline, time.monotonic() + 8.0))
                if 0 < soft.penalty() <= 6 and time.monotonic() < feas_deadline:
                    # so close — extend this attempt with the heavy hammers
                    self._phase2(soft, min(feas_deadline, time.monotonic() + 10.0))
            placed = sum(1 for row in soft.grid for v in row if v >= 0)
            pen = soft.penalty()
            if placed >= expected and pen == 0:
                complete_soft = soft
                break
            if (placed, -pen) > (best_placed, -best_pen):
                best_placed = placed
                best_pen = pen
                best_soft = soft
        info["feasibility_attempts"] = attempts
        info["feasibility_seconds"] = round(time.monotonic() - started, 1)
        if complete_soft is None and best_soft is not None:
            # best-effort partial: shed overlap losers, then optimize quality
            # of everything that IS placed — a partial schedule must still be
            # a clean schedule (no 1-period sessions, no gap>=2 debts).
            self._shed_overlaps(best_soft)
            info["partial_quality_optimized"] = True
        target_soft = complete_soft or best_soft
        if target_soft is None:
            state = State(P)
            for c, slot, ai in P.fixed_cells:
                if state.grid[c][slot] == -1:
                    state.apply([(c, slot, ai)], check=False)
                state.lock_cell(c, slot)
            return state, info
        if target_soft is not None and target_soft.penalty() == 0 and time.monotonic() < deadline - 5:
            target_soft.enable_quality_tracking()
            self.phase3_quality(target_soft, deadline, progress=progress)
            self.compact_student_holes(target_soft)
        forced_singles, forced_gap2s, evidence = getattr(
            self, "_floors_cache", None
        ) or self.structural_floors()
        info["floors"] = {
            "one_period_floor": len(forced_singles),
            "gap2_floor": len(forced_gap2s),
            "evidence": evidence[:20],
        }
        state = self._load_state(target_soft)
        if state is None:
            # extremely defensive: retry a plain load ignoring quality result
            state = State(P)
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    ai = target_soft.grid[c][slot]
                    if ai >= 0:
                        state.apply([(c, slot, ai)], check=False)
            for c, slot, ai in P.fixed_cells:
                state.lock_cell(c, slot)
        return state, info

    def _shed_overlaps(self, soft: SoftSchedule) -> None:
        """Drop the extra lessons of every teacher double-booking (keep locked
        owners first) so the partial schedule is conflict-free."""

        P = self.P
        for t, slot in list(soft.conflicts):
            owners = [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot] >= 0 and P.a_teacher[soft.grid[c][slot]] == t
            ]
            owners.sort(key=lambda c: 0 if soft.locked[c][slot] else 1)
            for c in owners[1:]:
                if soft.locked[c][slot]:
                    continue
                run = self._run_window(soft, c, slot)
                for x in run:
                    soft.set_cell(c, x, -1)
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)

    def compact_student_holes(self, soft: SoftSchedule) -> None:
        """Push empty class cells to session edges so students have no mid-
        session holes (only matters when the class has slack / unplaced
        periods). Quality score must not get worse."""

        P = self.P
        weights = (10**11, 10**8, 10**5, 10)
        for c in range(P.num_classes()):
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                for _pass in range(4):
                    cells = [
                        p
                        for p in range(PERIODS)
                        if P.class_avail[c][base + p]
                    ]
                    occupied = [p for p in cells if soft.grid[c][base + p] >= 0]
                    if len(occupied) < 2:
                        break
                    holes = [
                        p
                        for p in cells
                        if soft.grid[c][base + p] < 0
                        and occupied[0] < p < occupied[-1]
                        and not soft.locked[c][base + p]
                    ]
                    if not holes:
                        break
                    fixed_any = False
                    for h in holes:
                        # candidates: single-run lessons of this class that can
                        # legally sit at the hole (their teacher free there)
                        score0 = self._quality_score(soft, weights)
                        done = False
                        for src in range(NUM_SLOTS):
                            ai = soft.grid[c][src]
                            if ai < 0 or soft.locked[c][src] or src == base + h:
                                continue
                            run = self._run_window(soft, c, src)
                            if len(run) != 1:
                                continue
                            t = P.a_teacher[ai]
                            if t >= 0 and soft.tcnt[t][base + h] > 0:
                                continue
                            if not P.a_allowed[ai][base + h]:
                                continue
                            # keep the source side hole-free: only take runs at
                            # the edge of their own session span
                            src_s = src // PERIODS
                            src_base = src_s * PERIODS
                            occ_src = [
                                p
                                for p in range(PERIODS)
                                if soft.grid[c][src_base + p] >= 0
                            ]
                            if occ_src and occ_src[0] != src - src_base and occ_src[-1] != src - src_base:
                                continue
                            changes = [(src, -1), (base + h, ai)]
                            backup = {slot2: soft.grid[c][slot2] for slot2, _v in changes}
                            self._apply_changes(soft, c, changes)
                            valid = (
                                checks.check_class_session(P, soft.grid, c, s, True) is None
                                and checks.check_class_session(P, soft.grid, c, src_s, True) is None
                                and checks.check_class_subject_week(
                                    P, soft.grid, c, P.a_subject[ai], ai, False
                                )
                                is None
                                and checks.check_class_day(P, soft.grid, c, s // 2) is None
                                and checks.check_class_day(P, soft.grid, c, src_s // 2) is None
                                and soft.overlap == 0
                                and self._quality_score(soft, weights) <= score0
                            )
                            if valid:
                                done = True
                                fixed_any = True
                                break
                            self._apply_changes(soft, c, list(backup.items()))
                        if done:
                            break
                    if not fixed_any:
                        break

    def build(self, deadline: float) -> State:
        """Best (ideally complete + conflict-free) hard-valid State by deadline."""

        P = self.P
        expected = sum(P.a_periods)
        best_state: State | None = None
        best_key: tuple | None = None
        best_soft_grid: list[list[int]] | None = None
        best_soft_pen = 1 << 30
        attempt = 0
        final_reserve = 25.0
        while time.monotonic() < deadline - final_reserve:
            attempt += 1
            soft, tiled_all = self._phase1(deadline)
            if soft is None:
                continue
            self._phase2(soft, min(deadline, time.monotonic() + 6.0))
            pen = soft.penalty()
            placed = sum(1 for row in soft.grid for v in row if v >= 0)
            if placed >= expected and pen < best_soft_pen:
                best_soft_pen = pen
                best_soft_grid = [row[:] for row in soft.grid]
            if pen == 0 and placed >= expected:
                state = self._load_state(soft)
                if state is not None:
                    return state
            elif placed < expected and best_soft_grid is None:
                state = self._load_state(soft)
                if state is not None:
                    key = (-state.placed, state.objective())
                    if best_key is None or key < best_key:
                        best_key = key
                        best_state = state
        # final push: hammer the best near-feasible grid until the deadline
        if best_soft_grid is not None:
            soft = SoftSchedule(P)
            for c, slot, ai in P.fixed_cells:
                if soft.grid[c][slot] == -1:
                    soft.set_cell(c, slot, ai)
                    soft.locked[c][slot] = 1
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    ai = best_soft_grid[c][slot]
                    if ai >= 0 and soft.grid[c][slot] == -1:
                        soft.set_cell(c, slot, ai)
            self._phase2(soft, deadline)
            state = self._load_state(soft)
            if state is not None:
                key = (-state.placed, state.objective())
                if best_key is None or key < best_key:
                    best_key = key
                    best_state = state
        if best_state is None:
            # degenerate fallback: empty-but-valid state with fixed cells only
            best_state = State(P)
            for c, slot, ai in P.fixed_cells:
                if best_state.grid[c][slot] == -1:
                    best_state.apply([(c, slot, ai)], check=False)
                best_state.lock_cell(c, slot)
        return best_state

    # ------------------------------------------------------------------
    # phase 1: per-class tiling
    # ------------------------------------------------------------------

    def _phase1(self, deadline: float):
        P = self.P
        rng = self.rng
        soft = SoftSchedule(P)
        # fixed cells first
        fixed_per_assignment: dict[int, int] = {}
        for c, slot, ai in P.fixed_cells:
            if soft.grid[c][slot] == -1:
                soft.set_cell(c, slot, ai)
                soft.locked[c][slot] = 1
                fixed_per_assignment[ai] = fixed_per_assignment.get(ai, 0) + 1
        # block plan
        blocks_of: dict[int, list[int]] = {}
        for ai in range(P.num_assignments()):
            residual = P.a_periods[ai] - fixed_per_assignment.get(ai, 0)
            if residual <= 0:
                continue
            rule = P.a_rule[ai]
            need_double = False
            if rule is not None:
                for length, minimum, _mx in rule.lesson_blocks:
                    if length == 2 and minimum > 0:
                        need_double = True
            blocks_of[ai] = _block_sizes(residual, P.a_cap[ai], need_double, rng)
        # tight-teacher pre-matching: teachers whose availability barely covers
        # their load get their blocks matched onto their own free slots first
        prematched: dict[int, list[tuple[int, int]]] = {}  # class -> [(ai, size)] placed
        t_load: dict[int, int] = {}
        for ai, sizes in blocks_of.items():
            t = P.a_teacher[ai]
            if t >= 0:
                t_load[t] = t_load.get(t, 0) + sum(sizes)
        tight_teachers = []
        for t, load in t_load.items():
            avail = sum(P.teacher_avail[t]) - sum(
                1 for row in soft.tcnt[t : t + 1] for v in row if v > 0
            )
            slack = sum(P.teacher_avail[t]) - load
            tight_teachers.append((slack, t))
        tight_teachers.sort()
        for slack, t in tight_teachers:
            if slack > 4:
                break
            self._prematch_teacher(soft, t, blocks_of, prematched)
        # per-class DFS for the remaining blocks
        by_class: dict[int, list[tuple[int, int]]] = {}
        for ai, sizes in blocks_of.items():
            for size in sizes:
                by_class.setdefault(P.a_class[ai], []).append((ai, size))
        tiled_all = True
        classes = sorted(
            set(by_class) | set(prematched),
            key=lambda cc: -sum(sz for _ai, sz in by_class.get(cc, [])),
        )
        for c in classes:
            if time.monotonic() > deadline:
                tiled_all = False
                break
            todo = by_class.get(c, [])
            if not todo:
                continue
            if self._tile_class(soft, c, todo):
                continue
            # fallback: release this class's prematched cells and retile all
            released = prematched.get(c, [])
            if released:
                for slot in range(NUM_SLOTS):
                    ai = soft.grid[c][slot]
                    if ai >= 0 and not soft.locked[c][slot] and (ai, -1) not in ():
                        pass
                # clear every unlocked cell of the class and rebuild from scratch
                retry_blocks = list(todo)
                for slot in range(NUM_SLOTS):
                    ai = soft.grid[c][slot]
                    if ai >= 0 and not soft.locked[c][slot]:
                        run = self._run_window(soft, c, slot)
                        if run[0] == slot and (ai, len(run)) not in retry_blocks:
                            retry_blocks.append((ai, len(run)))
                for slot in range(NUM_SLOTS):
                    if soft.grid[c][slot] >= 0 and not soft.locked[c][slot]:
                        soft.set_cell(c, slot, -1)
                if not self._tile_class(soft, c, retry_blocks):
                    tiled_all = False
            else:
                tiled_all = False
        return soft, tiled_all

    def _prematch_teacher(
        self,
        soft: SoftSchedule,
        t: int,
        blocks_of: dict[int, list[int]],
        prematched: dict[int, list[tuple[int, int]]],
    ) -> None:
        """Greedy matching of a tight teacher's blocks onto their free slots."""

        P = self.P
        rng = self.rng
        items: list[tuple[int, int]] = []  # (ai, size)
        for ai, sizes in blocks_of.items():
            if P.a_teacher[ai] == t:
                for size in sizes:
                    items.append((ai, size))
        if not items:
            return
        items.sort(key=lambda item: (-item[1], rng.random()))
        placed_now: list[tuple[int, int, list[int]]] = []  # (ai, size, slots)
        for ai, size in items:
            c = P.a_class[ai]
            si = P.a_subject[ai]
            allowed = P.a_allowed[ai]
            best: tuple[float, int, list[int]] | None = None
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                if any(
                    soft.grid[c][base + p] >= 0
                    and P.a_subject[soft.grid[c][base + p]] == si
                    for p in range(PERIODS)
                ):
                    continue
                for start in range(0, PERIODS - size + 1):
                    window = [base + start + off for off in range(size)]
                    ok = all(
                        allowed[x] and soft.grid[c][x] == -1 and soft.tcnt[t][x] == 0
                        for x in window
                    )
                    if not ok:
                        continue
                    # keep the teacher's remaining free slots as contiguous as
                    # possible: prefer windows adjacent to teacher's usage
                    score = rng.random()
                    if best is None or score < best[0]:
                        best = (score, s, window)
            if best is None:
                continue
            _score, s, window = best
            for x in window:
                soft.set_cell(c, x, ai)
            # class-side sanity; undo if broken
            if (
                checks.check_class_session(P, soft.grid, c, s, True) is not None
                or checks.check_class_subject_week(P, soft.grid, c, si, ai, True) is not None
                or checks.check_class_day(P, soft.grid, c, s // 2) is not None
            ):
                for x in window:
                    soft.set_cell(c, x, -1)
                continue
            placed_now.append((ai, size, window))
            prematched.setdefault(c, []).append((ai, size))
        # remove placed blocks from the plan
        for ai, size, _window in placed_now:
            sizes = blocks_of.get(ai)
            if sizes and size in sizes:
                sizes.remove(size)
                if not sizes:
                    del blocks_of[ai]

    def _tile_class(self, soft: SoftSchedule, c: int, blocks: list[tuple[int, int]]) -> bool:
        """Randomized DFS placing all blocks of class c (class-side checks)."""

        P = self.P
        rng = self.rng
        for attempt in range(10):
            order = sorted(blocks, key=lambda item: (-item[1], rng.random()))
            placed: list[tuple[int, list[int]]] = []
            if self._dfs_place(soft, c, order, 0, placed, budget=[4000]):
                return True
            # undo any partial placements (defensive; _dfs_place cleans up)
            for ai, slots in placed:
                for slot in slots:
                    soft.set_cell(c, slot, -1)
        return False

    def _dfs_place(
        self,
        soft: SoftSchedule,
        c: int,
        order: list[tuple[int, int]],
        idx: int,
        placed: list[tuple[int, list[int]]],
        budget: list[int],
    ) -> bool:
        if idx >= len(order):
            return True
        if budget[0] <= 0:
            return False
        budget[0] -= 1
        P = self.P
        rng = self.rng
        ai, size = order[idx]
        allowed = P.a_allowed[ai]
        grid_row = soft.grid[c]
        si = P.a_subject[ai]
        candidates: list[tuple[float, int, int]] = []
        for s in range(NUM_SESSIONS):
            base = s * PERIODS
            if any(
                grid_row[base + p] >= 0 and P.a_subject[grid_row[base + p]] == si
                for p in range(PERIODS)
            ):
                continue
            for start in range(0, PERIODS - size + 1):
                ok = True
                free_teacher = 0
                for off in range(size):
                    slot = base + start + off
                    if not allowed[slot] or grid_row[slot] != -1:
                        ok = False
                        break
                    t = P.a_teacher[ai]
                    if t >= 0 and soft.tcnt[t][slot] == 0:
                        free_teacher += 1
                if ok:
                    score = -free_teacher + rng.random()
                    candidates.append((score, s, start))
        candidates.sort()
        for _score, s, start in candidates:
            base = s * PERIODS
            slots = [base + start + off for off in range(size)]
            for slot in slots:
                soft.set_cell(c, slot, ai)
            if (
                checks.check_class_session(P, soft.grid, c, s, True) is None
                and checks.check_class_subject_week(P, soft.grid, c, si, ai, True) is None
                and checks.check_class_day(P, soft.grid, c, s // 2) is None
            ):
                placed.append((ai, slots))
                if self._dfs_place(soft, c, order, idx + 1, placed, budget):
                    return True
                placed.pop()
            for slot in slots:
                soft.set_cell(c, slot, -1)
        return False

    # ------------------------------------------------------------------
    # phase 2: min-conflicts on teacher overlaps (+ teacher-rule debts)
    # ------------------------------------------------------------------

    def _phase2(self, soft: SoftSchedule, deadline: float) -> None:
        P = self.P
        rng = self.rng
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        best_pen = soft.penalty()
        best_grid = [row[:] for row in soft.grid] if best_pen > 0 else None
        self._tabu: dict[tuple[int, int, int], int] = {}
        stall = 0
        iteration = 0
        while soft.penalty() > 0 and time.monotonic() < deadline:
            iteration += 1
            self._iteration = iteration
            target = self._pick_conflict(soft)
            if target is None:
                break
            c, slot = target
            if not self._repair_cell(soft, c, slot):
                stall += 1
            else:
                stall = 0 if soft.penalty() < best_pen else stall + 1
            pen = soft.penalty()
            if pen < best_pen:
                best_pen = pen
                best_grid = [row[:] for row in soft.grid]
                stall = 0
            if stall > 0 and stall % 120 == 0:
                # endgame: relabel cycles + dig chains + augment + Kempe
                for t_conf, slot_conf in list(soft.conflicts):
                    if time.monotonic() > deadline:
                        break
                    if (t_conf, slot_conf) not in soft.conflicts:
                        continue
                    owners_now = [
                        cc
                        for cc in range(P.num_classes())
                        if soft.grid[cc][slot_conf] >= 0
                        and P.a_teacher[soft.grid[cc][slot_conf]] == t_conf
                        and not soft.locked[cc][slot_conf]
                    ]
                    rng.shuffle(owners_now)
                    for cc in owners_now:
                        if self._cycle_dig(soft, cc, slot_conf):
                            break
                for t_conf, slot_conf in list(soft.conflicts):
                    if time.monotonic() > deadline:
                        break
                    if (t_conf, slot_conf) in soft.conflicts:
                        self._dig_conflict(soft, t_conf, slot_conf)
                for t_conf, slot_conf in list(soft.conflicts):
                    if time.monotonic() > deadline:
                        break
                    if (t_conf, slot_conf) in soft.conflicts:
                        self._augment_conflict(soft, t_conf, slot_conf)
                self._kempe_endgame(soft, deadline)
                if soft.conflicts:
                    self._cluster_endgame(soft, deadline)
                pen = soft.penalty()
                if pen < best_pen:
                    best_pen = pen
                    best_grid = [row[:] for row in soft.grid]
                    stall = 0
            if stall > 500:
                # hard escape: rebuild the tilings of the conflicted classes
                self._retile_conflicted_classes(soft)
                for t in self._has_rule_teachers:
                    soft.refresh_rule_pen(t)
                stall = 0
        if soft.penalty() > best_pen and best_grid is not None:
            current = [row[:] for row in soft.grid]
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    if current[c][slot] != best_grid[c][slot]:
                        soft.set_cell(c, slot, best_grid[c][slot])
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)

    def _retile_conflicted_classes(self, soft: SoftSchedule) -> None:
        """Destroy and rebuild the tilings of classes involved in conflicts."""

        P = self.P
        rng = self.rng
        classes: set[int] = set()
        for t, slot in list(soft.conflicts):
            for c in range(P.num_classes()):
                ai = soft.grid[c][slot]
                if ai >= 0 and P.a_teacher[ai] == t and not soft.locked[c][slot]:
                    classes.add(c)
        for c in list(classes)[:6]:
            blocks: list[tuple[int, int]] = []
            for slot in range(NUM_SLOTS):
                if soft.locked[c][slot]:
                    continue
                ai = soft.grid[c][slot]
                if ai < 0:
                    continue
                run = self._run_window(soft, c, slot)
                if run[0] == slot:
                    blocks.append((ai, len(run)))
            # clear after collecting runs
            for slot in range(NUM_SLOTS):
                if not soft.locked[c][slot] and soft.grid[c][slot] >= 0:
                    soft.set_cell(c, slot, -1)
            if not self._tile_class(soft, c, blocks):
                # should not happen (it tiled before); retry a few times
                for _ in range(4):
                    if self._tile_class(soft, c, blocks):
                        break

    def _pick_conflict(self, soft: SoftSchedule):
        P = self.P
        rng = self.rng
        options = list(soft.conflicts)
        if not options and soft.rule_pen_total > 0:
            # pick a lesson of a rule-violating teacher
            bad = [t for t in self._has_rule_teachers if soft.rule_pen[t] > 0]
            if not bad:
                return None
            t = rng.choice(bad)
            slots = [slot for slot in range(NUM_SLOTS) if soft.tcnt[t][slot] > 0]
            if not slots:
                return None
            slot = rng.choice(slots)
            classes = [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot] >= 0
                and P.a_teacher[soft.grid[c][slot]] == t
                and not soft.locked[c][slot]
            ]
            if not classes:
                return None
            return (rng.choice(classes), slot)
        if not options:
            return None
        t, slot = rng.choice(options)
        classes = [
            c
            for c in range(P.num_classes())
            if soft.grid[c][slot] >= 0
            and P.a_teacher[soft.grid[c][slot]] == t
            and not soft.locked[c][slot]
        ]
        if not classes:
            return None
        return (rng.choice(classes), slot)

    def _run_window(self, soft: SoftSchedule, c: int, slot: int) -> list[int]:
        P = self.P
        ai = soft.grid[c][slot]
        if ai < 0:
            return []
        si = P.a_subject[ai]
        s = slot // PERIODS
        base = s * PERIODS
        p = slot - base
        lo = p
        while lo > 0:
            a2 = soft.grid[c][base + lo - 1]
            if a2 >= 0 and P.a_subject[a2] == si:
                lo -= 1
            else:
                break
        hi = p
        while hi < PERIODS - 1:
            a2 = soft.grid[c][base + hi + 1]
            if a2 >= 0 and P.a_subject[a2] == si:
                hi += 1
            else:
                break
        return [base + q for q in range(lo, hi + 1)]

    def _candidate_swaps(
        self, soft: SoftSchedule, c: int, run: list[int]
    ) -> list[tuple[int, list[tuple[int, int]], int]]:
        """All valid moves for a run: [(delta, changes, window_start_slot)]."""

        P = self.P
        rng = self.rng
        L = len(run)
        ai = soft.grid[c][run[0]]
        si = P.a_subject[ai]
        run_session = run[0] // PERIODS
        out: list[tuple[int, list[tuple[int, int]], int]] = []
        starts = [(s, start) for s in range(NUM_SESSIONS) for start in range(0, PERIODS - L + 1)]
        rng.shuffle(starts)
        for s, start in starts:
            base = s * PERIODS
            if base + start == run[0]:
                continue
            window = [base + start + off for off in range(L)]
            if any(soft.locked[c][x] for x in window):
                continue
            occs = [soft.grid[c][x] for x in window]
            distinct = {o for o in occs if o >= 0}
            if len(distinct) > 1:
                continue
            other_ai = distinct.pop() if distinct else -1
            if other_ai >= 0:
                other_run = self._run_window(soft, c, window[0] if occs[0] >= 0 else window[-1])
                if sorted(other_run) != sorted(window):
                    continue
                if P.a_subject[other_ai] == si:
                    continue
                if s != run_session and any(
                    soft.grid[c][run_session * PERIODS + p] >= 0
                    and P.a_subject[soft.grid[c][run_session * PERIODS + p]] == P.a_subject[other_ai]
                    and (run_session * PERIODS + p) not in run
                    for p in range(PERIODS)
                ):
                    continue
                if not all(P.a_allowed[other_ai][x] for x in run):
                    continue
            if s != run_session and any(
                soft.grid[c][s * PERIODS + p] >= 0
                and P.a_subject[soft.grid[c][s * PERIODS + p]] == si
                and (s * PERIODS + p) not in window
                for p in range(PERIODS)
            ):
                continue
            if not all(P.a_allowed[ai][x] for x in window):
                continue
            delta = self._swap_delta(soft, ai, run, other_ai, window)
            if delta is None:
                continue
            if not self._class_side_ok_after(soft, c, ai, run, other_ai, window):
                continue
            changes = [(x, -1) for x in run] + [(window[off], ai) for off in range(L)]
            if other_ai >= 0:
                changes += [(run[off], other_ai) for off in range(L)]
            out.append((delta, changes, base + start))
        # multi-run exchanges (double <-> singles, in- and cross-session)
        for changes, window_start in self._enum_multi_exchanges(soft, c, run, cap=8):
            inverse = self._apply_changes(soft, c, changes)
            delta = 0
            # overlap delta measured directly
            delta = soft.overlap
            self._apply_changes(soft, c, inverse)
            delta = delta - soft.overlap
            out.append((delta, changes, window_start))
        out.sort(key=lambda item: item[0])
        return out

    def _enum_multi_exchanges(self, soft: SoftSchedule, c: int, run: list[int], *, no_overlap: bool = False, cap: int = 12):
        """Exchange `run` with 2..3 whole runs covering an equal-length window
        in another session of the same class (double <-> single+single etc.).
        Yields change lists [(slot, ai), ...]."""

        from itertools import permutations

        P = self.P
        L = len(run)
        if L < 2:
            return
        ai = soft.grid[c][run[0]]
        si = P.a_subject[ai]
        t1 = P.a_teacher[ai]
        run_session = run[0] // PERIODS
        run_set = set(run)
        produced = 0
        grid_row = soft.grid[c]
        for s2 in range(NUM_SESSIONS):
            same_session = s2 == run_session
            base = s2 * PERIODS
            # subject must not already be in target session (unless staying put)
            if not same_session and any(
                grid_row[base + p] >= 0 and P.a_subject[grid_row[base + p]] == si
                for p in range(PERIODS)
            ):
                continue
            for start in range(0, PERIODS - L + 1):
                window = [base + start + off for off in range(L)]
                if same_session and any(x in run_set for x in window):
                    continue
                if any(soft.locked[c][x] for x in window):
                    continue
                occs = [grid_row[x] for x in window]
                if any(o < 0 for o in occs):
                    continue
                # cover check: whole runs only
                victims: list[tuple[int, list[int]]] = []
                okwin = True
                x = 0
                while x < L:
                    vrun = self._run_window(soft, c, window[x])
                    if vrun[0] != window[x] or vrun[-1] > window[-1]:
                        okwin = False
                        break
                    victims.append((grid_row[vrun[0]], vrun))
                    x += len(vrun)
                if not okwin or len(victims) < 2 or len(victims) > 3:
                    continue
                if any(P.a_subject[v] == si for v, _r in victims):
                    continue
                if not all(P.a_allowed[ai][w] for w in window):
                    continue
                if no_overlap and t1 >= 0 and any(
                    soft.tcnt[t1][w] > 0 for w in window
                ):
                    continue
                # victims move into the source cells (any order, contiguous pack)
                vict_sizes = [len(r) for _v, r in victims]
                for perm in list(permutations(range(len(victims))))[:6]:
                    pos = 0
                    changes: list[tuple[int, int]] = [(x, -1) for x in run]
                    ok = True
                    for idx in perm:
                        vai, vrun = victims[idx]
                        size = len(vrun)
                        targets = run[pos : pos + size]
                        pos += size
                        tv = P.a_teacher[vai]
                        for slot_target in targets:
                            if not P.a_allowed[vai][slot_target]:
                                ok = False
                                break
                            if no_overlap and tv >= 0 and soft.tcnt[tv][slot_target] > 0 and slot_target not in run_set:
                                ok = False
                                break
                        if not ok:
                            break
                        # victim's subject must not already sit in source session
                        sv = P.a_subject[vai]
                        if not same_session and any(
                            grid_row[run_session * PERIODS + p] >= 0
                            and P.a_subject[grid_row[run_session * PERIODS + p]] == sv
                            and (run_session * PERIODS + p) not in run_set
                            for p in range(PERIODS)
                        ):
                            ok = False
                            break
                        changes.extend((slot_target, vai) for slot_target in targets)
                    if not ok:
                        continue
                    changes.extend((window[off], ai) for off in range(L))
                    # tentative class-side check
                    backup: dict[int, int] = {}
                    seen: dict[int, int] = {}
                    for slot2, val in changes:
                        seen[slot2] = val
                    for slot2, val in seen.items():
                        backup[slot2] = grid_row[slot2]
                        grid_row[slot2] = val
                    valid = (
                        checks.check_class_session(P, soft.grid, c, run_session, False) is None
                        and checks.check_class_session(P, soft.grid, c, s2, False) is None
                        and checks.check_class_subject_week(P, soft.grid, c, si, ai, False) is None
                        and all(
                            checks.check_class_subject_week(P, soft.grid, c, P.a_subject[v], v, False) is None
                            for v, _r in victims
                        )
                        and checks.check_class_day(P, soft.grid, c, run_session // 2) is None
                        and checks.check_class_day(P, soft.grid, c, s2 // 2) is None
                    )
                    for slot2, val in backup.items():
                        grid_row[slot2] = val
                    if not valid:
                        continue
                    produced += 1
                    yield list(seen.items()), base + start
                    if produced >= cap:
                        return

    def _apply_changes(self, soft: SoftSchedule, c: int, changes: list[tuple[int, int]]):
        """Apply per-class cell changes; returns the inverse change list."""

        P = self.P
        seen: dict[int, int] = {}
        for slot2, val in changes:
            seen[slot2] = val
        inverse: list[tuple[int, int]] = []
        touched: set[int] = set()
        for slot2, val in seen.items():
            old = soft.grid[c][slot2]
            inverse.append((slot2, old))
            if old >= 0 and P.a_teacher[old] >= 0:
                touched.add(P.a_teacher[old])
            if val >= 0 and P.a_teacher[val] >= 0:
                touched.add(P.a_teacher[val])
            soft.set_cell(c, slot2, val)
        for t in touched:
            if P.teacher_rules[t] is not None or P.teacher_must[t]:
                soft.refresh_rule_pen(t)
        return inverse

    def _repair_cell(self, soft: SoftSchedule, c: int, slot: int, *, force_walk: bool = False) -> bool:
        """Tabu min-conflicts step: best allowed move for the run at (c, slot)."""

        rng = self.rng
        run = self._run_window(soft, c, slot)
        if not run or any(soft.locked[c][x] for x in run):
            return False
        ai = soft.grid[c][run[0]]
        iteration = getattr(self, "_iteration", 0)
        tabu = getattr(self, "_tabu", {})
        best = None
        for delta, changes, window_start in self._candidate_swaps(soft, c, run):
            if tabu.get((c, ai, window_start), 0) > iteration and delta >= 0:
                continue
            best = (delta, changes)
            break  # list is delta-sorted
        if best is None:
            return False
        delta, changes = best
        tabu[(c, ai, run[0])] = iteration + 8 + rng.randrange(12)
        self._tabu = tabu
        self._apply_changes(soft, c, changes)
        return True

    # -- generalized two-slot Kempe component swap (endgame) -------------

    def _soft_kempe_pair(
        self, soft: SoftSchedule, c_seed: int, slot1: int, slot2: int, *, weights=None
    ) -> bool:
        """Swap cells slot1<->slot2 across the teacher-linked class component
        containing c_seed; accept iff total overlap decreases (weights=None)
        or the weighted quality score decreases without adding overlaps."""

        P = self.P
        if slot1 == slot2:
            return False
        comp: set[int] = {c_seed}
        queue = [c_seed]
        # teacher -> classes owning that teacher at a slot
        def owners_at(t: int, slot: int) -> list[int]:
            return [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot] >= 0 and P.a_teacher[soft.grid[c][slot]] == t
            ]

        while queue:
            c = queue.pop()
            if len(comp) > 10:
                return False
            for slot_a, slot_b in ((slot1, slot2), (slot2, slot1)):
                ai = soft.grid[c][slot_a]
                if ai < 0:
                    continue
                t = P.a_teacher[ai]
                if t < 0:
                    continue
                for c2 in owners_at(t, slot_b):
                    if c2 not in comp:
                        comp.add(c2)
                        queue.append(c2)
        # validate + build changes
        moves: list[tuple[int, int, int]] = []  # (class, slot, value)
        for c in comp:
            a1 = soft.grid[c][slot1]
            a2 = soft.grid[c][slot2]
            if a1 == a2:
                continue
            if soft.locked[c][slot1] or soft.locked[c][slot2]:
                return False
            for slot, ai in ((slot1, a1), (slot2, a2)):
                if ai >= 0 and len(self._run_window(soft, c, slot)) != 1:
                    return False
            if a1 >= 0 and not P.a_allowed[a1][slot2]:
                return False
            if a2 >= 0 and not P.a_allowed[a2][slot1]:
                return False
            moves.append((c, slot1, a2))
            moves.append((c, slot2, a1))
        if not moves:
            return False
        before = soft.overlap
        before_score = self._quality_score(soft, weights) if weights is not None else 0
        backups: list[tuple[int, int, int]] = []
        touched_classes: set[int] = set()
        for c, slot, val in moves:
            backups.append((c, slot, soft.grid[c][slot]))
            soft.set_cell(c, slot, val)
            touched_classes.add(c)
        if weights is None:
            ok = soft.overlap < before
        else:
            ok = soft.overlap <= before and self._quality_score(soft, weights) < before_score
        if ok:
            s1, s2 = slot1 // PERIODS, slot2 // PERIODS
            for c in touched_classes:
                subj_ids = set()
                for slot in (slot1, slot2):
                    ai = soft.grid[c][slot]
                    if ai >= 0:
                        subj_ids.add((P.a_subject[ai], ai))
                if (
                    checks.check_class_session(P, soft.grid, c, s1, False) is not None
                    or checks.check_class_session(P, soft.grid, c, s2, False) is not None
                    or checks.check_class_day(P, soft.grid, c, s1 // 2) is not None
                    or checks.check_class_day(P, soft.grid, c, s2 // 2) is not None
                    or any(
                        checks.check_class_subject_week(P, soft.grid, c, si, ai, False) is not None
                        for si, ai in subj_ids
                    )
                ):
                    ok = False
                    break
        if not ok:
            for c, slot, val in reversed(backups):
                soft.set_cell(c, slot, val)
            return False
        touched_teachers: set[int] = set()
        for c, slot, val in backups:
            if val >= 0 and P.a_teacher[val] >= 0:
                touched_teachers.add(P.a_teacher[val])
        for c, slot, _ in backups:
            ai = soft.grid[c][slot]
            if ai >= 0 and P.a_teacher[ai] >= 0:
                touched_teachers.add(P.a_teacher[ai])
        for t in touched_teachers:
            if P.teacher_rules[t] is not None or P.teacher_must[t]:
                soft.refresh_rule_pen(t)
        return True

    def _kempe_endgame(self, soft: SoftSchedule, deadline: float) -> None:
        P = self.P
        for t, slot1 in list(soft.conflicts):
            if time.monotonic() > deadline:
                return
            if (t, slot1) not in soft.conflicts:
                continue
            owners = [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot1] >= 0
                and P.a_teacher[soft.grid[c][slot1]] == t
                and not soft.locked[c][slot1]
            ]
            done = False
            for c in owners:
                for slot2 in range(0, 60):
                    if soft.tcnt[t][slot2] == 0 and P.teacher_avail[t][slot2]:
                        if self._soft_kempe_pair(soft, c, slot1, slot2):
                            done = True
                            break
                if done:
                    break

    # ------------------------------------------------------------------
    # phase 3: lexicographic quality tabu-walk (hard-valid moves only)
    # ------------------------------------------------------------------

    def _enum_quality_moves(self, soft: SoftSchedule, c: int, run: list[int], *, windows_in: set[int] | None = None):
        """Valid no-overlap swaps for a run: yields (changes, window_start).
        windows_in restricts target windows to given sessions."""

        P = self.P
        L = len(run)
        ai = soft.grid[c][run[0]]
        si = P.a_subject[ai]
        t1 = P.a_teacher[ai]
        run_session = run[0] // PERIODS
        run_set = set(run)
        sessions = range(NUM_SESSIONS) if windows_in is None else sorted(windows_in)
        for s in sessions:
            base = s * PERIODS
            for start in range(0, PERIODS - L + 1):
                if base + start == run[0]:
                    continue
                window = [base + start + off for off in range(L)]
                if any(soft.locked[c][x] for x in window):
                    continue
                occs = [soft.grid[c][x] for x in window]
                distinct = {o for o in occs if o >= 0}
                if len(distinct) > 1:
                    continue
                other_ai = distinct.pop() if distinct else -1
                if other_ai == ai:
                    continue
                # zero-overlap requirement
                if t1 >= 0 and any(
                    soft.tcnt[t1][x] > 0 and x not in run_set for x in window
                ):
                    if other_ai < 0 or P.a_teacher[other_ai] != t1:
                        continue
                if other_ai >= 0:
                    other_run = self._run_window(soft, c, window[0] if occs[0] >= 0 else window[-1])
                    if sorted(other_run) != sorted(window):
                        continue
                    if P.a_subject[other_ai] == si:
                        continue
                    t2 = P.a_teacher[other_ai]
                    if t2 >= 0 and t2 != t1 and any(soft.tcnt[t2][x] > 0 and x not in set(window) for x in run):
                        continue
                    if s != run_session and any(
                        soft.grid[c][run_session * PERIODS + p] >= 0
                        and P.a_subject[soft.grid[c][run_session * PERIODS + p]] == P.a_subject[other_ai]
                        and (run_session * PERIODS + p) not in run
                        for p in range(PERIODS)
                    ):
                        continue
                    if not all(P.a_allowed[other_ai][x] for x in run):
                        continue
                if s != run_session and any(
                    soft.grid[c][s * PERIODS + p] >= 0
                    and P.a_subject[soft.grid[c][s * PERIODS + p]] == si
                    and (s * PERIODS + p) not in window
                    for p in range(PERIODS)
                ):
                    continue
                if not all(P.a_allowed[ai][x] for x in window):
                    continue
                if not self._class_side_ok_after(soft, c, ai, run, other_ai, window):
                    continue
                changes = [(x, -1) for x in run] + [(window[off], ai) for off in range(L)]
                if other_ai >= 0:
                    changes += [(run[off], other_ai) for off in range(L)]
                yield changes, base + start
        if windows_in is None:
            yield from self._enum_multi_exchanges(soft, c, run, no_overlap=True, cap=8)

    def _quality_score(self, soft: SoftSchedule, weights: tuple[int, int, int, int]) -> int:
        w_single, w_gap2, w_sessions, w_gap1 = weights
        score = (
            soft.q_singleton * w_single
            + soft.q_gap2 * w_gap2
            + soft.q_sessions * w_sessions
            + soft.q_gap1 * w_gap1
            + soft.q_days
            + soft.rule_pen_total * (10**13)
            + soft.overlap * (10**13)
        )
        cap = self._session_cap
        if cap is not None and soft.q_sessions > cap:
            # focus gap1: tang buoi so voi luc bat dau la vi pham hop dong
            # chap nhan cua bridge -> phat rat nang.
            score += (soft.q_sessions - cap) * (10**9)
        return score

    def _singleton_floor_teachers(self) -> set[int]:
        P = self.P
        load: dict[int, int] = {}
        for ai in range(P.num_assignments()):
            t = P.a_teacher[ai]
            if t >= 0:
                load[t] = load.get(t, 0) + P.a_periods[ai]
        return {t for t, v in load.items() if v == 1}

    def structural_floors(self):
        """Provable lower bounds from teacher availability patterns.

        Returns (forced_singleton_pairs, forced_gap2_pairs, evidence).
        A pair (t, s) is a forced singleton when teacher t must use session s
        (capacity elsewhere is insufficient) and s offers exactly one usable
        slot. A forced gap2 arises when t must fill every available slot of s
        and those slots have >= 2 internal holes.
        """

        P = self.P
        load: dict[int, int] = {}
        for ai in range(P.num_assignments()):
            t = P.a_teacher[ai]
            if t >= 0:
                load[t] = load.get(t, 0) + P.a_periods[ai]
        singles: set[tuple[int, int]] = set()
        gap2s: dict[tuple[int, int], int] = {}
        evidence: list[dict] = []
        for t, L in load.items():
            if L <= 0:
                continue
            caps = []
            spans = []
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                slots = [p for p in range(PERIODS) if P.teacher_avail[t][base + p]]
                caps.append(len(slots))
                spans.append((slots[0], slots[-1]) if slots else (0, -1))
            total = sum(caps)
            for s in range(NUM_SESSIONS):
                cap_s = caps[s]
                if cap_s == 0:
                    continue
                min_req = L - (total - cap_s)
                if min_req >= 1 and cap_s == 1:
                    singles.add((t, s))
                    evidence.append({
                        "kind": "forced_one_period_session",
                        "teacher": P.teacher_names[t],
                        "session": s,
                        "reason": "chi con 1 o kha dung trong buoi nay ma tong o rong khong du",
                    })
                if min_req >= cap_s and cap_s >= 2:
                    lo, hi = spans[s]
                    gap = (hi - lo + 1) - cap_s
                    if gap >= 2:
                        gap2s[(t, s)] = gap
                        evidence.append({
                            "kind": "forced_gap2_session",
                            "teacher": P.teacher_names[t],
                            "session": s,
                            "gap": gap,
                            "reason": "phai day het cac o kha dung cua buoi nhung cac o bi ngat quang",
                        })
        # teachers with weekly load 1 always own one singleton session
        for t in self._singleton_floor_teachers():
            if not any(pt == t for pt, _s in singles):
                singles.add((t, -1))
                evidence.append({
                    "kind": "forced_one_period_teacher",
                    "teacher": P.teacher_names[t],
                    "reason": "giao vien chi co 1 tiet/tuan",
                })
        return singles, gap2s, evidence

    def _repair_partial_warm(
        self, soft: SoftSchedule, expected: int, deadline: float
    ) -> SoftSchedule | None:
        """Sua mot lich warm gan dung: xep lai TUNG LOP co van de.

        Dung cho ban hop nhat (CP-SAT dua sang lich thieu vai tiet) va cho moi
        truong hop warm bi tu choi — giu nguyen phan tot, chi lam lai phan hong.
        """

        P = self.P
        if time.monotonic() > deadline - 8:
            return None
        placed_per_ai: dict[int, int] = {}
        for c in range(P.num_classes()):
            row = soft.grid[c]
            for slot in range(NUM_SLOTS):
                ai = row[slot]
                if ai >= 0:
                    placed_per_ai[ai] = placed_per_ai.get(ai, 0) + 1
        dirty: set[int] = set()
        for ai in range(P.num_assignments()):
            if placed_per_ai.get(ai, 0) != P.a_periods[ai]:
                dirty.add(P.a_class[ai])
        for c in range(P.num_classes()):
            if c in dirty:
                continue
            bad = False
            for s in range(NUM_SESSIONS):
                if checks.check_class_session(P, soft.grid, c, s, False) is not None:
                    bad = True
                    break
            if not bad:
                for d in range(6):
                    if checks.check_class_day(P, soft.grid, c, d) is not None:
                        bad = True
                        break
            if bad:
                dirty.add(c)
        # Qua nhieu lop hong thi khong con la "sua cuc bo" nua
        if not dirty or len(dirty) > max(8, (P.num_classes() * 3) // 4):
            return None

        fixed_per_ai: dict[int, int] = {}
        for c, slot, ai in P.fixed_cells:
            fixed_per_ai[ai] = fixed_per_ai.get(ai, 0) + 1
        for c in dirty:
            for slot in range(NUM_SLOTS):
                if soft.grid[c][slot] >= 0 and not soft.locked[c][slot]:
                    soft.set_cell(c, slot, -1)
        for c in sorted(dirty):
            blocks: list[tuple[int, int]] = []
            for ai in range(P.num_assignments()):
                if P.a_class[ai] != c:
                    continue
                residual = P.a_periods[ai] - fixed_per_ai.get(ai, 0)
                if residual <= 0:
                    continue
                rule = P.a_rule[ai]
                need_double = False
                if rule is not None:
                    for length, minimum, _mx in rule.lesson_blocks:
                        if length == 2 and minimum > 0:
                            need_double = True
                for size in _block_sizes(residual, P.a_cap[ai], need_double, self.rng):
                    blocks.append((ai, size))
            if not self._tile_class(soft, c, blocks):
                return None
            if time.monotonic() > deadline - 5:
                return None
        # con trung gio giao vien thi de phase 2 go
        if soft.penalty() > 0:
            self._phase2(soft, min(deadline - 3, time.monotonic() + 20.0))
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        if placed < expected or soft.penalty() != 0:
            return None
        if self._load_state(soft) is None:
            return None
        return soft

    def phase3_quality(self, soft: SoftSchedule, deadline: float, *, progress=None) -> None:
        """Tabu-walk the quality tuple down (singleton -> gap2 -> sessions -> gap1)."""

        P = self.P
        rng = self.rng
        if not hasattr(self, "_floors_cache"):
            self._floors_cache = self.structural_floors()
        forced_singles, forced_gap2s, _evidence = self._floors_cache
        floor_teachers = {t for t, s in forced_singles}
        floor = len(forced_singles)
        weights = (10**11, 10**8, 10**5, 10)
        if self.quality_focus == "gap1":
            # Nut "Toi uu trong 1 tiet": gap1 nang hon so buoi; so buoi bi khoa
            # cung o muc hien tai qua _session_cap trong _quality_score.
            self._session_cap = soft.q_sessions
            weights = (10**11, 10**8, 100, 10**4)
        best_grid = [row[:] for row in soft.grid]
        best_score = self._quality_score(soft, weights)
        tabu: dict[tuple[int, int, int], int] = {}
        iteration = 0
        stall = 0
        last_report = 0.0
        # Tra nhanh khi da hoi tu: neu phan cung (1 tiet/buoi, trong >=2) da cham
        # san va khong con cai thien duoc gi trong mot khoang dai thi dung som,
        # khong dot not ngan sach.
        started_at = time.monotonic()
        stagnation_limit = max(25.0, min(90.0, (deadline - started_at) * 0.25))
        last_improve_at = started_at
        while time.monotonic() < deadline:
            iteration += 1
            stage_a = soft.q_singleton > floor or soft.q_gap2 > 0
            target = self._pick_quality_target(soft, rng, floor_teachers, stage_a)
            if target is None:
                break
            moved = self._quality_step(soft, target, weights, tabu, iteration, floor_teachers)
            score = self._quality_score(soft, weights)
            if score < best_score:
                best_score = score
                best_grid = [row[:] for row in soft.grid]
                stall = 0
                last_improve_at = time.monotonic()
            else:
                stall += 1
            idle = time.monotonic() - last_improve_at
            if idle > (stagnation_limit * 2.0 if stage_a else stagnation_limit):
                # Da on: khong con cai thien duoc gi -> tra ket qua ngay, khong
                # dot not ngan sach (vi du Cloud Run cap 300s van co the xong
                # sau 100s). Stage A duoc kien nhan gap doi vi day la no cung.
                break
            if stall > 0 and stall % (150 if stage_a else 400) == 0:
                self._quality_cycle_pass(
                    soft, weights, floor_teachers, min(deadline, time.monotonic() + 4.0)
                )
                self._quality_kempe_pass(soft, weights, min(deadline, time.monotonic() + 3.0))
                # ejection chains on the stubborn debts (deeper as debts shrink)
                debts = self._debt_sessions_of(
                    soft, set(range(P.num_teachers())), floor_teachers
                )
                if not stage_a:
                    # session-count offensive: thin sessions become chain targets
                    thin = [
                        (t, s)
                        for t in range(P.num_teachers())
                        for s in range(NUM_SESSIONS)
                        if 0 < soft.ts_cnt[t][s] <= 2
                    ]
                    rng.shuffle(thin)
                    debts = debts + thin[:16]
                rng.shuffle(debts)
                deep = len(debts) <= 10
                very_deep = len(debts) <= 6
                for t_d, s_d in debts[:12]:
                    if time.monotonic() > deadline:
                        break
                    self._quality_chain(
                        soft, t_d, s_d, weights, floor_teachers,
                        max_depth=10 if very_deep else (8 if deep else 5),
                        node_budget=30000 if very_deep else (12000 if deep else 2500),
                    )
                if deep and stall >= 1200:
                    # quality-aware cluster re-tile around debt teachers
                    debt_teachers = {t_d for t_d, _s in debts}
                    classes = sorted({
                        c
                        for c in range(P.num_classes())
                        for slot in range(NUM_SLOTS)
                        if soft.grid[c][slot] >= 0
                        and P.a_teacher[soft.grid[c][slot]] in debt_teachers
                    })
                    rng.shuffle(classes)
                    for chunk_start in range(0, min(len(classes), 8), 4):
                        chunk = classes[chunk_start : chunk_start + 4]
                        if time.monotonic() > deadline:
                            break
                        score0 = self._quality_score(soft, weights)
                        grid0 = [row[:] for row in soft.grid]
                        if self._exact_retile_cluster(soft, chunk, resplit=True, restarts=2):
                            if self._quality_score(soft, weights) >= score0:
                                for c in range(P.num_classes()):
                                    for slot in range(NUM_SLOTS):
                                        if soft.grid[c][slot] != grid0[c][slot]:
                                            soft.set_cell(c, slot, grid0[c][slot])
                score = self._quality_score(soft, weights)
                if score < best_score:
                    best_score = score
                    best_grid = [row[:] for row in soft.grid]
                    stall = 0
                    last_improve_at = time.monotonic()
            if stall > 3000:
                # restore best and shake
                current = [row[:] for row in soft.grid]
                for c in range(P.num_classes()):
                    for slot in range(NUM_SLOTS):
                        if current[c][slot] != best_grid[c][slot]:
                            soft.set_cell(c, slot, best_grid[c][slot])
                for t in self._has_rule_teachers:
                    soft.refresh_rule_pen(t)
                tabu.clear()
                if stage_a and self.quality_focus is None:
                    # Con no 1 tiet/buoi hoac trong >=2 ma be tac: THAO bot —
                    # tam ha trong so buoi + trong 1 de mo duong (chu du an:
                    # "khong nhat thiet giu no qua nang ma khong dat muc dich
                    # chung"), roi vong lap chinh voi trong so chuan nen lai.
                    relaxed = (weights[0], weights[1], 50, 3)
                    relax_deadline = min(deadline, time.monotonic() + 6.0)
                    while time.monotonic() < relax_deadline:
                        r_target = self._pick_quality_target(
                            soft, rng, floor_teachers, True
                        )
                        if r_target is None:
                            break
                        self._quality_step(
                            soft, r_target, relaxed, tabu, iteration, floor_teachers
                        )
                        iteration += 1
                    score = self._quality_score(soft, weights)
                    if score < best_score:
                        best_score = score
                        best_grid = [row[:] for row in soft.grid]
                        last_improve_at = time.monotonic()
                else:
                    self._shake_quality(soft, 10)
                stall = 0
            if progress is not None and time.monotonic() - last_report > 5.0:
                last_report = time.monotonic()
                q = soft.quality()
                try:
                    progress({
                        "stage": "optimize:quality",
                        "message": "1tiet=%d trong2=%d buoi=%d trong1=%d" % (q[0], q[1], q[2], q[3]),
                    })
                except Exception:
                    pass
        # end on best grid
        current = [row[:] for row in soft.grid]
        if self._quality_score(soft, weights) > best_score:
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    if current[c][slot] != best_grid[c][slot]:
                        soft.set_cell(c, slot, best_grid[c][slot])
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)

    def _pick_quality_target(self, soft: SoftSchedule, rng, floor_teachers: set[int], stage_a: bool):
        """Choose a (t, s) debt session to work on (structural floors excluded)."""

        forced_singles, forced_gap2s, _e = getattr(
            self, "_floors_cache", (set(), {}, [])
        )
        P = self.P
        singles = []
        gap2s = []
        thin = []
        gap1s = []
        for t in range(P.num_teachers()):
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt == 0:
                    continue
                gap = soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt
                if cnt == 1 and (t, s) not in forced_singles and (t, -1) not in forced_singles:
                    singles.append((t, s))
                if gap >= 2 and (t, s) not in forced_gap2s:
                    gap2s.append((t, s))
                if not stage_a:
                    if cnt <= 2:
                        thin.append((t, s))
                    if gap == 1:
                        gap1s.append((t, s))
        if stage_a:
            pool = singles + gap2s
        elif self.quality_focus == "gap1" and gap1s:
            # Nut "Toi uu trong 1 tiet": don target vao cac buoi dang ho 1 tiet.
            pool = gap1s + gap1s + gap1s + thin + singles + gap2s
        else:
            pool = thin + gap1s + singles + gap2s
        if not pool:
            return None
        return rng.choice(pool)

    def _quality_step(
        self,
        soft: SoftSchedule,
        target: tuple[int, int],
        weights: tuple[int, int, int, int],
        tabu: dict,
        iteration: int,
        floor_teachers: set[int],
    ) -> bool:
        P = self.P
        rng = self.rng
        t, s = target
        base = s * PERIODS
        # movable runs: runs of this session + friend runs from t's other sessions
        # (restricted to windows inside this session)
        moves: list[tuple[int, list[tuple[int, int]], int, int, int]] = []
        score_before = self._quality_score(soft, weights)

        def consider(c: int, run: list[int], windows_in=None):
            cap = 0
            for changes, window_start in self._enum_quality_moves(soft, c, run, windows_in=windows_in):
                if tabu.get((c, run[0], window_start), 0) > iteration:
                    continue
                inverse = self._apply_changes(soft, c, changes)
                delta = self._quality_score(soft, weights) - score_before
                self._apply_changes(soft, c, inverse)
                moves.append((delta, changes, c, window_start, run[0]))
                cap += 1
                if cap >= 24:
                    break
        # runs inside the target session
        p = 0
        row = soft.tcnt[t]
        while p < PERIODS:
            if row[base + p] <= 0:
                p += 1
                continue
            # find owning class
            oc = -1
            for c in range(P.num_classes()):
                a2 = soft.grid[c][base + p]
                if a2 >= 0 and P.a_teacher[a2] == t:
                    oc = c
                    break
            if oc < 0:
                p += 1
                continue
            run = self._run_window(soft, oc, base + p)
            if not any(soft.locked[oc][x] for x in run):
                consider(oc, run)
            p = (run[-1] - base) + 1
        # friend moves: single runs of t elsewhere into this session
        for s2 in range(NUM_SESSIONS):
            if s2 == s or soft.ts_cnt[t][s2] == 0:
                continue
            base2 = s2 * PERIODS
            for p2 in range(PERIODS):
                if soft.tcnt[t][base2 + p2] <= 0:
                    continue
                for c in range(P.num_classes()):
                    a2 = soft.grid[c][base2 + p2]
                    if a2 >= 0 and P.a_teacher[a2] == t:
                        run2 = self._run_window(soft, c, base2 + p2)
                        if run2[0] == base2 + p2 and not any(soft.locked[c][x] for x in run2):
                            consider(c, run2, windows_in={s})
                        break
        if not moves:
            return False
        moves.sort(key=lambda m: m[0])
        delta, changes, c, window_start, run0 = moves[0]
        # forbid the reverse move (run now at window_start going back to run0)
        tabu[(c, window_start, run0)] = iteration + 6 + rng.randrange(10)
        self._apply_changes(soft, c, changes)
        return True

    def _debt_sessions_of(self, soft: SoftSchedule, teachers: set[int], floor_teachers: set[int]):
        forced_singles, forced_gap2s, _e = getattr(
            self, "_floors_cache", (set(), {}, [])
        )
        out = []
        for t in teachers:
            if t < 0:
                continue
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt <= 0:
                    continue
                gap = soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt
                singleton_debt = (
                    cnt == 1
                    and (t, s) not in forced_singles
                    and (t, -1) not in forced_singles
                )
                gap_debt = gap >= 2 and (t, s) not in forced_gap2s
                if singleton_debt or gap_debt:
                    out.append((t, s))
        return out

    def _quality_chain(
        self,
        soft: SoftSchedule,
        t: int,
        s: int,
        weights,
        floor_teachers: set[int],
        *,
        max_depth: int = 5,
        node_budget: int = 2500,
    ) -> bool:
        """Ejection-chain DFS: sequences of run moves, rollback on failure,
        success when the weighted quality score strictly improves."""

        start_score = self._quality_score(soft, weights)
        budget = [node_budget]
        visited: set = set()
        return self._quality_chain_step(
            soft, t, s, weights, floor_teachers, start_score, 0, max_depth, budget, visited
        )

    def _movable_runs_for_session(self, soft: SoftSchedule, t: int, s: int):
        P = self.P
        base = s * PERIODS
        runs = []
        p = 0
        while p < PERIODS:
            if soft.tcnt[t][base + p] <= 0:
                p += 1
                continue
            oc = -1
            for c in range(P.num_classes()):
                a2 = soft.grid[c][base + p]
                if a2 >= 0 and P.a_teacher[a2] == t:
                    oc = c
                    break
            if oc < 0:
                p += 1
                continue
            run = self._run_window(soft, oc, base + p)
            if not any(soft.locked[oc][x] for x in run):
                runs.append((oc, run))
            p = (run[-1] - base) + 1
        # friends: runs of t in other sessions (may move into s)
        friends = []
        for s2 in range(NUM_SESSIONS):
            if s2 == s or soft.ts_cnt[t][s2] == 0:
                continue
            base2 = s2 * PERIODS
            p2 = 0
            while p2 < PERIODS:
                if soft.tcnt[t][base2 + p2] <= 0:
                    p2 += 1
                    continue
                oc = -1
                for c in range(P.num_classes()):
                    a2 = soft.grid[c][base2 + p2]
                    if a2 >= 0 and P.a_teacher[a2] == t:
                        oc = c
                        break
                if oc < 0:
                    p2 += 1
                    continue
                run = self._run_window(soft, oc, base2 + p2)
                if not any(soft.locked[oc][x] for x in run):
                    friends.append((oc, run))
                p2 = (run[-1] - base2) + 1
        return runs, friends

    def _quality_chain_step(
        self,
        soft: SoftSchedule,
        t: int,
        s: int,
        weights,
        floor_teachers: set[int],
        start_score: int,
        depth: int,
        max_depth: int,
        budget: list[int],
        visited: set,
    ) -> bool:
        if budget[0] <= 0:
            return False
        P = self.P
        runs, friends = self._movable_runs_for_session(soft, t, s)
        options: list[tuple[int, int, list[int], list[tuple[int, int]], int]] = []
        score_now = self._quality_score(soft, weights)
        for oc, run in runs:
            cap = 0
            for changes, window_start in self._enum_quality_moves(soft, oc, run):
                key = (oc, run[0], window_start)
                if key in visited:
                    continue
                inverse = self._apply_changes(soft, oc, changes)
                delta = self._quality_score(soft, weights) - score_now
                self._apply_changes(soft, oc, inverse)
                options.append((delta, oc, run, changes, window_start))
                cap += 1
                if cap >= 12:
                    break
        for oc, run in friends:
            cap = 0
            for changes, window_start in self._enum_quality_moves(soft, oc, run, windows_in={s}):
                key = (oc, run[0], window_start)
                if key in visited:
                    continue
                inverse = self._apply_changes(soft, oc, changes)
                delta = self._quality_score(soft, weights) - score_now
                self._apply_changes(soft, oc, inverse)
                options.append((delta, oc, run, changes, window_start))
                cap += 1
                if cap >= 8:
                    break
        options.sort(key=lambda o: o[0])
        for delta, oc, run, changes, window_start in options[:10]:
            budget[0] -= 1
            if budget[0] <= 0:
                return False
            key = (oc, run[0], window_start)
            partner_teachers = {
                P.a_teacher[v] for _x, v in changes if v >= 0
            }
            inverse = self._apply_changes(soft, oc, changes)
            if self._quality_score(soft, weights) < start_score:
                return True
            if depth + 1 < max_depth:
                visited.add(key)
                next_debts = self._debt_sessions_of(soft, partner_teachers | {t}, floor_teachers)
                self.rng.shuffle(next_debts)
                for t2, s2 in next_debts[:3]:
                    if self._quality_chain_step(
                        soft, t2, s2, weights, floor_teachers, start_score,
                        depth + 1, max_depth, budget, visited,
                    ):
                        return True
            self._apply_changes(soft, oc, inverse)
        return False

    def _quality_cycle_pass(self, soft: SoftSchedule, weights, floor_teachers: set[int], deadline: float) -> None:
        """Relabel-cycle relocations aimed at quality debts (overlap stays 0)."""

        P = self.P
        debts = self._debt_sessions_of(soft, set(range(P.num_teachers())), floor_teachers)
        self.rng.shuffle(debts)
        for t, s in debts[:16]:
            if time.monotonic() > deadline:
                return
            base = s * PERIODS
            # lone/border cells of the debt session
            cells_of_t = [base + p for p in range(PERIODS) if soft.tcnt[t][base + p] > 0]
            for slot in cells_of_t:
                oc = -1
                for c in range(P.num_classes()):
                    a2 = soft.grid[c][slot]
                    if a2 >= 0 and P.a_teacher[a2] == t:
                        oc = c
                        break
                if oc < 0 or soft.locked[oc][slot]:
                    continue
                if len(self._run_window(soft, oc, slot)) != 1:
                    continue
                ai = soft.grid[oc][slot]
                # candidate landings: adjacent to t's other sessions
                targets = []
                for s2 in range(NUM_SESSIONS):
                    if s2 == s or soft.ts_cnt[t][s2] == 0:
                        continue
                    first = soft.ts_first[t][s2]
                    last = soft.ts_last[t][s2]
                    for q in (first - 1, last + 1):
                        if 0 <= q < PERIODS:
                            x = s2 * PERIODS + q
                            if P.a_allowed[ai][x] and soft.tcnt[t][x] == 0:
                                targets.append(x)
                # holes inside the same session (gap repair)
                first = soft.ts_first[t][s]
                last = soft.ts_last[t][s]
                for q in range(first + 1, last):
                    x = base + q
                    if soft.tcnt[t][x] == 0 and P.a_allowed[ai][x]:
                        targets.append(x)
                score0 = self._quality_score(soft, weights)
                done = False
                for x in targets[:10]:
                    inverse = self._cycle_relocate(soft, oc, slot, x)
                    if inverse is None:
                        continue
                    if self._quality_score(soft, weights) < score0:
                        done = True
                        break
                    self._apply_changes(soft, oc, inverse)
                if done:
                    break

    def _quality_kempe_pass(self, soft: SoftSchedule, weights, deadline: float) -> None:
        """Kempe two-slot component swaps that lower the quality score."""

        P = self.P
        targets = []
        for t in range(P.num_teachers()):
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt <= 0:
                    continue
                gap = soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt
                if gap >= 1 or cnt == 1:
                    targets.append((t, s))
        self.rng.shuffle(targets)
        for t, s in targets[:40]:
            if time.monotonic() > deadline:
                return
            base = s * PERIODS
            cols = [base + p for p in range(PERIODS)]
            occupied = [x for x in cols if soft.tcnt[t][x] > 0]
            free = [x for x in cols if soft.tcnt[t][x] == 0]
            for slot1 in occupied:
                # find owner class
                seed_c = -1
                for c in range(P.num_classes()):
                    a2 = soft.grid[c][slot1]
                    if a2 >= 0 and P.a_teacher[a2] == t:
                        seed_c = c
                        break
                if seed_c < 0:
                    continue
                for slot2 in free:
                    if self._soft_kempe_pair(soft, seed_c, slot1, slot2, weights=weights):
                        break

    def _shake_quality(self, soft: SoftSchedule, count: int) -> None:
        P = self.P
        rng = self.rng
        done = 0
        guard = 0
        while done < count and guard < count * 50:
            guard += 1
            c = rng.randrange(P.num_classes())
            slot = rng.randrange(NUM_SLOTS)
            if soft.grid[c][slot] < 0 or soft.locked[c][slot]:
                continue
            run = self._run_window(soft, c, slot)
            if any(soft.locked[c][x] for x in run):
                continue
            options = list(self._enum_quality_moves(soft, c, run))
            if not options:
                continue
            changes, _ws = rng.choice(options)
            self._apply_changes(soft, c, changes)
            done += 1

    # -- exact cluster re-tiling (decisive endgame tool) -----------------

    def _exact_retile_cluster(
        self,
        soft: SoftSchedule,
        classes: list[int],
        node_budget: int = 30000,
        *,
        resplit: bool = False,
        restarts: int = 4,
    ) -> bool:
        """Clear the unlocked cells of `classes` and jointly re-tile them with
        a strict no-teacher-conflict DFS. Restores everything on failure."""

        P = self.P
        rng = self.rng
        backup: list[tuple[int, int, int]] = []
        residual: dict[int, int] = {}
        blocks: list[tuple[int, int]] = []  # (ai, size)
        for c in classes:
            for slot in range(NUM_SLOTS):
                ai = soft.grid[c][slot]
                if ai < 0 or soft.locked[c][slot]:
                    continue
                residual[ai] = residual.get(ai, 0) + 1
                run = self._run_window(soft, c, slot)
                if run[0] == slot:
                    blocks.append((ai, len(run)))
        for c in classes:
            for slot in range(NUM_SLOTS):
                if soft.grid[c][slot] >= 0 and not soft.locked[c][slot]:
                    backup.append((c, slot, soft.grid[c][slot]))
                    soft.set_cell(c, slot, -1)

        def candidate_count(ai: int, size: int) -> int:
            c = P.a_class[ai]
            t = P.a_teacher[ai]
            si = P.a_subject[ai]
            grid_row = soft.grid[c]
            n = 0
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                for start in range(0, PERIODS - size + 1):
                    ok = True
                    for off in range(size):
                        slot = base + start + off
                        if (
                            not P.a_allowed[ai][slot]
                            or grid_row[slot] != -1
                            or (t >= 0 and soft.tcnt[t][slot] > 0)
                        ):
                            ok = False
                            break
                    if ok:
                        n += 1
            return n

        for attempt in range(restarts):
            plan = list(blocks)
            if resplit and attempt > 0:
                plan = []
                for ai, count in residual.items():
                    rule = P.a_rule[ai]
                    need_double = False
                    if rule is not None:
                        for length, minimum, _mx in rule.lesson_blocks:
                            if length == 2 and minimum > 0:
                                need_double = True
                    for size in _block_sizes(count, P.a_cap[ai], need_double, rng):
                        plan.append((ai, size))
            order = sorted(
                plan,
                key=lambda item: (candidate_count(*item), -item[1], rng.random()),
            )
            budget = [node_budget]
            if self._strict_dfs(soft, order, 0, budget):
                return True
        # restore
        for c in classes:
            for slot in range(NUM_SLOTS):
                if soft.grid[c][slot] >= 0 and not soft.locked[c][slot]:
                    soft.set_cell(c, slot, -1)
        for c, slot, ai in backup:
            soft.set_cell(c, slot, ai)
        return False

    def _strict_dfs(self, soft: SoftSchedule, order: list[tuple[int, int]], idx: int, budget: list[int]) -> bool:
        if idx >= len(order):
            return True
        if budget[0] <= 0:
            return False
        P = self.P
        rng = self.rng
        ai, size = order[idx]
        c = P.a_class[ai]
        t = P.a_teacher[ai]
        si = P.a_subject[ai]
        allowed = P.a_allowed[ai]
        grid_row = soft.grid[c]
        candidates: list[tuple[float, int, int]] = []
        for s in range(NUM_SESSIONS):
            base = s * PERIODS
            if any(
                grid_row[base + p] >= 0 and P.a_subject[grid_row[base + p]] == si
                for p in range(PERIODS)
            ):
                continue
            for start in range(0, PERIODS - size + 1):
                ok = True
                for off in range(size):
                    slot = base + start + off
                    if (
                        not allowed[slot]
                        or grid_row[slot] != -1
                        or (t >= 0 and soft.tcnt[t][slot] > 0)
                    ):
                        ok = False
                        break
                if ok:
                    candidates.append((rng.random(), s, start))
        candidates.sort()
        for _r, s, start in candidates:
            budget[0] -= 1
            if budget[0] <= 0:
                return False
            base = s * PERIODS
            slots = [base + start + off for off in range(size)]
            for slot in slots:
                soft.set_cell(c, slot, ai)
            if (
                checks.check_class_session(P, soft.grid, c, s, True) is None
                and checks.check_class_subject_week(P, soft.grid, c, si, ai, True) is None
                and checks.check_class_day(P, soft.grid, c, s // 2) is None
            ):
                if self._strict_dfs(soft, order, idx + 1, budget):
                    return True
            for slot in slots:
                soft.set_cell(c, slot, -1)
        return False

    def _conflict_clusters(self, soft: SoftSchedule) -> list[list[int]]:
        """Group conflicted classes by shared conflict teachers."""

        P = self.P
        adj: dict[int, set[int]] = {}
        for t, slot in soft.conflicts:
            owners = [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot] >= 0 and P.a_teacher[soft.grid[c][slot]] == t
            ]
            for c in owners:
                adj.setdefault(c, set()).update(o for o in owners if o != c)
        seen: set[int] = set()
        clusters: list[list[int]] = []
        for c in adj:
            if c in seen:
                continue
            comp = [c]
            seen.add(c)
            queue = [c]
            while queue:
                x = queue.pop()
                for y in adj.get(x, ()):
                    if y not in seen:
                        seen.add(y)
                        comp.append(y)
                        queue.append(y)
            clusters.append(comp)
        return clusters

    def _cluster_endgame(self, soft: SoftSchedule, deadline: float) -> None:
        P = self.P
        rng = self.rng
        for cluster in self._conflict_clusters(soft):
            if time.monotonic() > deadline:
                return
            if self._exact_retile_cluster(soft, cluster):
                continue
            # expand cluster with classes sharing the conflicted teachers
            teachers = {
                P.a_teacher[soft.grid[c][slot]]
                for t, slot in list(soft.conflicts)
                for c in cluster
                if soft.grid[c][slot] >= 0
            }
            extra = [
                c2
                for c2 in range(P.num_classes())
                if c2 not in cluster
                and any(
                    soft.grid[c2][slot] >= 0
                    and P.a_teacher[soft.grid[c2][slot]] in teachers
                    for slot in range(NUM_SLOTS)
                )
            ]
            rng.shuffle(extra)
            for width in (2, 4, 8):
                expanded = cluster + extra[:width]
                if time.monotonic() > deadline:
                    return
                if self._exact_retile_cluster(
                    soft, expanded, node_budget=60000, resplit=True, restarts=3
                ):
                    break

    # -- make-room digging: move blockers of a teacher's free slots -------

    def _dig_conflict(self, soft: SoftSchedule, t: int, slot: int, *, max_depth: int = 10, node_budget: int = 20000) -> bool:
        """Augmenting search along teacher t's slot graph: relocate one owner
        run with a neutral/improving move; the conflict rolls to the landing
        slot; recurse until it lands on a free slot (overlap drops)."""

        budget = [node_budget]
        return self._dig_step(soft, t, slot, soft.overlap, 0, max_depth, budget, {slot})

    def _dig_step(
        self,
        soft: SoftSchedule,
        t: int,
        slot: int,
        base_overlap: int,
        depth: int,
        max_depth: int,
        budget: list[int],
        visited: set,
    ) -> bool:
        if budget[0] <= 0 or depth >= max_depth:
            return False
        P = self.P
        owners = [
            c
            for c in range(P.num_classes())
            if soft.grid[c][slot] >= 0
            and P.a_teacher[soft.grid[c][slot]] == t
            and not soft.locked[c][slot]
        ]
        self.rng.shuffle(owners)
        for c in owners:
            run = self._run_window(soft, c, slot)
            if not run or any(soft.locked[c][x] for x in run):
                continue
            for delta, changes, ws in self._candidate_swaps(soft, c, run):
                if delta > 0:
                    continue
                budget[0] -= 1
                if budget[0] <= 0:
                    return False
                inverse = self._apply_changes(soft, c, changes)
                if soft.overlap < base_overlap:
                    return True
                # conflict rolled somewhere else on t's row — chase it
                next_slots = [
                    ss for (tt, ss) in soft.conflicts if tt == t and ss not in visited
                ]
                for ss in next_slots[:3]:
                    visited.add(ss)
                    if self._dig_step(
                        soft, t, ss, base_overlap, depth + 1, max_depth, budget, visited
                    ):
                        return True
                self._apply_changes(soft, c, inverse)
            # rolling relocation via relabel cycles onto t's own row slots
            if len(run) == 1:
                ai = soft.grid[c][run[0]]
                targets = [
                    x
                    for x in range(NUM_SLOTS)
                    if x != run[0]
                    and x not in visited
                    and P.teacher_avail[t][x]
                    and P.a_allowed[ai][x]
                ]
                self.rng.shuffle(targets)
                for x in targets[:12]:
                    budget[0] -= 1
                    if budget[0] <= 0:
                        return False
                    inverse = self._cycle_relocate(soft, c, run[0], x)
                    if inverse is None:
                        continue
                    if soft.overlap < base_overlap:
                        return True
                    visited.add(x)
                    if (t, x) in soft.conflicts and self._dig_step(
                        soft, t, x, base_overlap, depth + 1, max_depth, budget, visited
                    ):
                        return True
                    self._apply_changes(soft, c, inverse)
        return False

    # -- relabel cycles (cell-level closed push chains inside one class) --

    def _cycle_dig(self, soft: SoftSchedule, c: int, src_slot: int, *, max_depth: int = 7, node_budget: int = 6000) -> bool:
        """Closed push chain inside class c: the lesson at src moves onto an
        occupied cell, whose lesson moves on, ... until one lands back on src
        (cycle) or on an empty cell. Accepts iff total overlap strictly drops
        and class rules stay valid."""

        P = self.P
        ai0 = soft.grid[c][src_slot]
        if ai0 < 0 or soft.locked[c][src_slot]:
            return False
        budget = [node_budget]
        base_overlap = soft.overlap
        cells = [x for x in range(NUM_SLOTS) if P.class_avail[c][x] and not soft.locked[c][x]]
        chain: list[int] = [src_slot]
        lessons: list[int] = [ai0]

        def try_apply(closing_cell: int) -> bool:
            assignment: dict[int, int] = {src_slot: -1}
            for idx in range(1, len(chain)):
                assignment[chain[idx]] = lessons[idx - 1]
            if closing_cell == src_slot:
                assignment[src_slot] = lessons[-1]
            inverse = self._apply_changes(soft, c, list(assignment.items()))
            ok = soft.overlap < base_overlap
            if ok:
                touched_sessions = {x // PERIODS for x in assignment}
                touched_subjects = {(P.a_subject[v], v) for v in assignment.values() if v >= 0}
                ok = (
                    all(checks.check_class_session(P, soft.grid, c, s, False) is None for s in touched_sessions)
                    and all(checks.check_class_subject_week(P, soft.grid, c, si, v, False) is None for si, v in touched_subjects)
                    and all(checks.check_class_day(P, soft.grid, c, s // 2) is None for s in touched_sessions)
                )
            if not ok:
                self._apply_changes(soft, c, inverse)
                return False
            return True

        def dfs(depth: int) -> bool:
            if budget[0] <= 0 or depth > max_depth:
                return False
            moving_ai = lessons[-1]
            t_m = P.a_teacher[moving_ai]
            order = cells[:]
            self.rng.shuffle(order)
            closing: list[int] = []
            empties: list[int] = []
            occupied: list[int] = []
            for x in order:
                if x in chain[1:]:
                    continue
                if not P.a_allowed[moving_ai][x]:
                    continue
                if x == src_slot:
                    if depth >= 2:
                        closing.append(x)
                    continue
                if t_m >= 0 and soft.tcnt[t_m][x] > 0:
                    continue
                if soft.grid[c][x] < 0:
                    empties.append(x)
                else:
                    occupied.append(x)
            for x in closing + empties:
                budget[0] -= 1
                chain.append(x)
                if try_apply(x):
                    return True
                chain.pop()
                if budget[0] <= 0:
                    return False
            for x in occupied:
                budget[0] -= 1
                if budget[0] <= 0:
                    return False
                chain.append(x)
                lessons.append(soft.grid[c][x])
                if dfs(depth + 1):
                    return True
                lessons.pop()
                chain.pop()
            return False

        return dfs(1)

    def _cycle_relocate(self, soft: SoftSchedule, c: int, src_slot: int, dst_slot: int, *, max_depth: int = 6, node_budget: int = 3000):
        """Relocate the (single-cell) lesson at src to dst via a closed relabel
        cycle inside class c. dst may hold a teacher conflict (rolling). All
        intermediate lessons land only on teacher-free cells. Applies and
        returns the inverse change-list on success (overlap not increased),
        else None."""

        P = self.P
        ai0 = soft.grid[c][src_slot]
        if ai0 < 0 or soft.locked[c][src_slot] or soft.locked[c][dst_slot]:
            return None
        if not P.a_allowed[ai0][dst_slot]:
            return None
        if len(self._run_window(soft, c, src_slot)) != 1:
            return None
        base_overlap = soft.overlap
        budget = [node_budget]
        cells = [x for x in range(NUM_SLOTS) if P.class_avail[c][x] and not soft.locked[c][x]]
        chain: list[int] = [src_slot, dst_slot]
        lessons: list[int] = [ai0]
        occupant0 = soft.grid[c][dst_slot]

        def try_apply(closing_cell: int) -> "list | None":
            assignment: dict[int, int] = {src_slot: -1}
            for idx in range(1, len(chain)):
                assignment[chain[idx]] = lessons[idx - 1]
            if closing_cell == src_slot:
                assignment[src_slot] = lessons[-1]
            inverse = self._apply_changes(soft, c, list(assignment.items()))
            ok = soft.overlap <= base_overlap
            if ok:
                touched_sessions = {x // PERIODS for x in assignment}
                touched_subjects = {(P.a_subject[v], v) for v in assignment.values() if v >= 0}
                ok = (
                    all(checks.check_class_session(P, soft.grid, c, s, False) is None for s in touched_sessions)
                    and all(checks.check_class_subject_week(P, soft.grid, c, si, v, False) is None for si, v in touched_subjects)
                    and all(checks.check_class_day(P, soft.grid, c, s // 2) is None for s in touched_sessions)
                )
            if not ok:
                self._apply_changes(soft, c, inverse)
                return None
            return inverse

        if occupant0 < 0:
            return try_apply(dst_slot)
        lessons.append(occupant0)

        def dfs(depth: int):
            if budget[0] <= 0 or depth > max_depth:
                return None
            moving_ai = lessons[-1]
            t_m = P.a_teacher[moving_ai]
            order = cells[:]
            self.rng.shuffle(order)
            closing: list[int] = []
            empties: list[int] = []
            occupied: list[int] = []
            for x in order:
                if x in chain[1:]:
                    continue
                if not P.a_allowed[moving_ai][x]:
                    continue
                if x == src_slot:
                    closing.append(x)
                    continue
                if t_m >= 0 and soft.tcnt[t_m][x] > 0:
                    continue
                if soft.grid[c][x] < 0:
                    empties.append(x)
                else:
                    occupied.append(x)
            for x in closing + empties:
                budget[0] -= 1
                chain.append(x)
                inverse = try_apply(x)
                if inverse is not None:
                    return inverse
                chain.pop()
                if budget[0] <= 0:
                    return None
            for x in occupied[:10]:
                budget[0] -= 1
                if budget[0] <= 0:
                    return None
                chain.append(x)
                lessons.append(soft.grid[c][x])
                result = dfs(depth + 1)
                if result is not None:
                    return result
                lessons.pop()
                chain.pop()
            return None

        return dfs(2)

    # -- augmenting ejection chains (endgame) ---------------------------

    def _augment_conflict(self, soft: SoftSchedule, t: int, slot: int, *, max_depth: int = 6) -> bool:
        P = self.P
        owners = [
            c
            for c in range(P.num_classes())
            if soft.grid[c][slot] >= 0
            and P.a_teacher[soft.grid[c][slot]] == t
            and not soft.locked[c][slot]
        ]
        self.rng.shuffle(owners)
        for c in owners:
            run = self._run_window(soft, c, slot)
            if not run or any(soft.locked[c][x] for x in run):
                continue
            if self._chain_step(
                soft, c, run, soft.overlap, 0, max_depth, [3000], set()
            ):
                return True
        return False

    def _chain_step(
        self,
        soft: SoftSchedule,
        c: int,
        run: list[int],
        target_overlap: int,
        depth: int,
        max_depth: int,
        budget: list[int],
        visited: set,
    ) -> bool:
        if budget[0] <= 0:
            return False
        candidates = self._candidate_swaps(soft, c, run)
        ai = soft.grid[c][run[0]]
        for delta, changes, window_start in candidates[:14]:
            key = (c, ai, run[0], window_start)
            if key in visited:
                continue
            budget[0] -= 1
            if budget[0] <= 0:
                return False
            inverse = self._apply_changes(soft, c, changes)
            if soft.overlap < target_overlap:
                return True
            if depth + 1 < max_depth and soft.overlap <= target_overlap + 1:
                visited.add(key)
                # continue the chain from a conflict created/kept at the window
                next_targets = []
                for slot2, _val in changes:
                    a2 = soft.grid[c][slot2]
                    if a2 < 0:
                        continue
                    t2 = self.P.a_teacher[a2]
                    if t2 >= 0 and soft.tcnt[t2][slot2] > 1:
                        for c2 in range(self.P.num_classes()):
                            a3 = soft.grid[c2][slot2]
                            if (
                                a3 >= 0
                                and self.P.a_teacher[a3] == t2
                                and not soft.locked[c2][slot2]
                            ):
                                next_targets.append((c2, slot2))
                self.rng.shuffle(next_targets)
                found = False
                for c2, slot2 in next_targets[:4]:
                    run2 = self._run_window(soft, c2, slot2)
                    if not run2 or any(soft.locked[c2][x] for x in run2):
                        continue
                    if self._chain_step(
                        soft, c2, run2, target_overlap, depth + 1, max_depth, budget, visited
                    ):
                        found = True
                        break
                if found:
                    return True
            self._apply_changes(soft, c, inverse)
        return False

    def _swap_delta(self, soft: SoftSchedule, ai: int, run: list[int], other_ai: int, window: list[int]):
        """Overlap delta of swapping run<->window (teacher counters only)."""

        P = self.P
        t1 = P.a_teacher[ai]
        t2 = P.a_teacher[other_ai] if other_ai >= 0 else -1
        delta = 0
        for slot in run:
            if t1 >= 0 and soft.tcnt[t1][slot] > 1:
                delta -= 1
            if t2 >= 0:
                extra = soft.tcnt[t2][slot]
                if t1 >= 0 and t1 == t2:
                    extra -= 1
                if extra >= 1:
                    delta += 1
        for slot in window:
            if t2 >= 0 and soft.tcnt[t2][slot] > 1:
                delta -= 1
            if t1 >= 0:
                extra = soft.tcnt[t1][slot]
                if t2 >= 0 and t1 == t2:
                    extra -= 1
                if extra >= 1:
                    delta += 1
        return delta

    def _class_side_ok_after(
        self,
        soft: SoftSchedule,
        c: int,
        ai: int,
        run: list[int],
        other_ai: int,
        window: list[int],
    ) -> bool:
        P = self.P
        grid_row = soft.grid[c]
        backup: dict[int, int] = {}
        for x in run:
            backup[x] = grid_row[x]
            grid_row[x] = -1
        for off, x in enumerate(window):
            backup.setdefault(x, grid_row[x])
            grid_row[x] = ai
        if other_ai >= 0:
            for off, x in enumerate(run):
                grid_row[x] = other_ai
        s1 = run[0] // PERIODS
        s2 = window[0] // PERIODS
        ok = (
            checks.check_class_session(P, soft.grid, c, s1, False) is None
            and checks.check_class_session(P, soft.grid, c, s2, False) is None
            and checks.check_class_subject_week(P, soft.grid, c, P.a_subject[ai], ai, False) is None
            and (
                other_ai < 0
                or checks.check_class_subject_week(P, soft.grid, c, P.a_subject[other_ai], other_ai, False)
                is None
            )
            and checks.check_class_day(P, soft.grid, c, s1 // 2) is None
            and checks.check_class_day(P, soft.grid, c, s2 // 2) is None
        )
        for x, val in backup.items():
            grid_row[x] = val
        return ok

    def _shake(self, soft: SoftSchedule, count: int) -> None:
        P = self.P
        rng = self.rng
        done = 0
        guard = 0
        while done < count and guard < count * 40:
            guard += 1
            c = rng.randrange(P.num_classes())
            slot = rng.randrange(NUM_SLOTS)
            if soft.grid[c][slot] < 0 or soft.locked[c][slot]:
                continue
            if self._repair_cell(soft, c, slot):
                done += 1

    # ------------------------------------------------------------------
    # load into hard State
    # ------------------------------------------------------------------

    def _load_state(self, soft: SoftSchedule) -> State | None:
        P = self.P
        if soft.penalty() > 0:
            # still has overlaps/rule debts: hard state cannot host overlaps —
            # drop overflow lessons (rare path, yields best-effort partial)
            state = State(P, defer_min=True)
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    ai = soft.grid[c][slot]
                    if ai >= 0:
                        state.apply([(c, slot, ai)], check=False) is not None
            # remove overlap losers
            for t in range(P.num_teachers()):
                for slot in range(NUM_SLOTS):
                    owners = [
                        c
                        for c in range(P.num_classes())
                        if state.grid[c][slot] >= 0
                        and P.a_teacher[state.grid[c][slot]] == t
                    ]
                    while len(owners) > 1:
                        c = owners.pop()
                        if state.locked[c][slot]:
                            continue
                        state.apply([(c, slot, -1)], check=False)
            for c, slot, ai in P.fixed_cells:
                state.lock_cell(c, slot)
            state.defer_min = False
            return state
        state = State(P, defer_min=False)
        ok = True
        for c in range(P.num_classes()):
            for slot in range(NUM_SLOTS):
                ai = soft.grid[c][slot]
                if ai >= 0:
                    if state.apply([(c, slot, ai)], check=False) is None:
                        ok = False
        for c, slot, ai in P.fixed_cells:
            state.lock_cell(c, slot)
        if not ok or not state.full_recheck():
            return None
        return state

    # ------------------------------------------------------------------
    # kept for entry.py compatibility: post-optimization min repair
    # ------------------------------------------------------------------

    def repair_min_blocks(self, state: State, deadline: float) -> bool:
        P = self.P
        all_ok = True
        for ai in range(P.num_assignments()):
            rule = P.a_rule[ai]
            if rule is None or not rule.lesson_blocks:
                continue
            for length, minimum, _maximum in rule.lesson_blocks:
                if minimum <= 0:
                    continue
                sessions = checks.class_subject_sessions(P, state.grid, P.a_class[ai], P.a_subject[ai])
                if sum(1 for ps in sessions.values() if len(ps) >= length) < minimum:
                    all_ok = False
        return all_ok
