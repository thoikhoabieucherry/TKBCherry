"""Lexicographic optimizer over complete, hard-valid schedules.

Priority (after completeness, which construction guarantees):
    singleton (1-period teacher sessions) -> gap>=2 sessions -> total teacher
    sessions -> gap==1 sessions -> teacher days.

All moves are cell permutations inside classes plus Kempe column swaps and
whole-session swaps, applied atomically through State.apply — hard validity is
invariant. Round-robin stage controller with stagnation escape and a global
best snapshot.
"""

from __future__ import annotations

import random
import time

from .core import NUM_SESSIONS, PERIODS, Problem
from .state import State

Tuple5 = tuple[int, int, int, int, int]


def singleton_floor(problem: Problem) -> int:
    """Teachers whose weekly load is exactly 1 must own one singleton session."""

    load: dict[int, int] = {}
    for ai in range(problem.num_assignments()):
        t = problem.a_teacher[ai]
        if t >= 0:
            load[t] = load.get(t, 0) + problem.a_periods[ai]
    return sum(1 for v in load.values() if v == 1)


class Optimizer:
    def __init__(self, problem: Problem, state: State, seed: int = 0, progress=None):
        self.P = problem
        self.state = state
        self.rng = random.Random(seed ^ 0x5EED)
        self.best_snap = state.snapshot()
        self.best_tuple = state.objective()
        self.progress = progress
        self.floor_singleton = singleton_floor(problem)

    # ------------------------------------------------------------------
    # accept helper
    # ------------------------------------------------------------------

    def _try(self, changes: list[tuple[int, int, int]], *, allow_equal: bool = False) -> bool:
        state = self.state
        before = state.objective()
        journal = state.apply(changes)
        if journal is None:
            return False
        after = state.objective()
        if after < before or (allow_equal and after == before):
            if after < self.best_tuple:
                self.best_tuple = after
                self.best_snap = state.snapshot()
            return True
        state.undo(journal)
        return False

    # ------------------------------------------------------------------
    # shared helpers
    # ------------------------------------------------------------------

    def _run_of(self, c: int, slot: int) -> list[int]:
        """Slots of the same-subject contiguous run containing slot."""

        state = self.state
        P = self.P
        ai = state.grid[c][slot]
        if ai < 0:
            return []
        si = P.a_subject[ai]
        s = slot // PERIODS
        base = s * PERIODS
        p = slot - base
        lo = p
        while lo > 0:
            a2 = state.grid[c][base + lo - 1]
            if a2 >= 0 and P.a_subject[a2] == si:
                lo -= 1
            else:
                break
        hi = p
        while hi < PERIODS - 1:
            a2 = state.grid[c][base + hi + 1]
            if a2 >= 0 and P.a_subject[a2] == si:
                hi += 1
            else:
                break
        return [base + q for q in range(lo, hi + 1)]

    def _swap_runs_changes(self, c: int, run_a: list[int], run_b: list[int]) -> list[tuple[int, int, int]] | None:
        if len(run_a) != len(run_b) or not run_a:
            return None
        state = self.state
        raw: list[tuple[int, int, int]] = []
        for src, dst in zip(run_a, run_b):
            ai = state.grid[c][src]
            bi = state.grid[c][dst]
            raw.append((c, dst, ai))
            raw.append((c, src, bi))
        seen: dict[tuple[int, int], int] = {}
        for cc, slot, ai in raw:
            seen[(cc, slot)] = ai
        return [(cc, slot, ai) for (cc, slot), ai in seen.items()]

    def _locked_in(self, c: int, slots: list[int]) -> bool:
        locked = self.state.locked[c]
        return any(locked[slot] for slot in slots)

    def _teacher_sessions_used(self, t: int) -> list[int]:
        return [s for s in range(NUM_SESSIONS) if self.state.ts_count[t][s] > 0]

    def _teacher_blocks_in_session(self, t: int, s: int) -> list[tuple[int, list[int]]]:
        """[(class, run_slots)] for teacher t in session s."""

        state = self.state
        P = self.P
        base = s * PERIODS
        out: list[tuple[int, list[int]]] = []
        p = 0
        while p < PERIODS:
            ai = state.teacher_slot[t][base + p]
            if ai < 0:
                p += 1
                continue
            c = P.a_class[ai]
            run = self._run_of(c, base + p)
            out.append((c, run))
            p = (run[-1] - base) + 1
        return out

    # ------------------------------------------------------------------
    # block relocation primitives
    # ------------------------------------------------------------------

    def _swap_block_into_session(
        self,
        c: int,
        run: list[int],
        s2: int,
        *,
        prefer_adjacent: tuple[int, int] | None,
        allow_equal: bool = False,
    ) -> bool:
        """Swap run (class c) with an equal-length cell window of class c in
        session s2 (occupied cells swap; free cells become a plain move)."""

        state = self.state
        base2 = s2 * PERIODS
        L = len(run)
        candidate_starts = list(range(0, PERIODS - L + 1))
        if prefer_adjacent is not None:
            t, ss = prefer_adjacent
            first = state.ts_first[t][ss]
            last = state.ts_last[t][ss]

            def adj_key(start: int) -> int:
                if first < 0:
                    return 0
                end = start + L - 1
                if end == first - 1 or start == last + 1:
                    return 0
                return min(abs(start - last), abs(first - end))

            candidate_starts.sort(key=adj_key)
        else:
            self.rng.shuffle(candidate_starts)
        for start in candidate_starts:
            window = [base2 + start + off for off in range(L)]
            if self._locked_in(c, window):
                continue
            occs = [state.grid[c][slot] for slot in window]
            if all(o < 0 for o in occs):
                changes = [(c, slot, -1) for slot in run] + [
                    (c, window[off], state.grid[c][run[off]]) for off in range(L)
                ]
            else:
                if any(o < 0 for o in occs):
                    continue
                changes = self._swap_runs_changes(c, run, window)
            if changes and self._try(changes, allow_equal=allow_equal):
                return True
        return False

    def _cycle3_place(self, c: int, src_slot: int, dst_slot: int, *, allow_equal: bool = False) -> bool:
        """Move grid[c][src] to dst via a 3-cycle: src -> dst -> mid -> src.
        Only single-cell runs participate."""

        state = self.state
        rng = self.rng
        g = state.grid[c]
        a_src = g[src_slot]
        a_dst = g[dst_slot]
        if a_src < 0 or a_dst < 0:
            return False
        if state.locked[c][src_slot] or state.locked[c][dst_slot]:
            return False
        if len(self._run_of(c, src_slot)) != 1 or len(self._run_of(c, dst_slot)) != 1:
            return False
        mids = [m for m in range(len(g)) if m != src_slot and m != dst_slot]
        rng.shuffle(mids)
        tried = 0
        for mid in mids:
            a_mid = g[mid]
            if state.locked[c][mid]:
                continue
            if a_mid >= 0 and len(self._run_of(c, mid)) != 1:
                continue
            tried += 1
            if tried > 40:
                break
            changes = [
                (c, dst_slot, a_src),
                (c, mid, a_dst),
                (c, src_slot, a_mid),
            ]
            if self._try(changes, allow_equal=allow_equal):
                return True
        return False

    def _bring_friend(self, t: int, s: int) -> bool:
        """Move one of t's single-cell blocks from a fat session to sit next to
        t's lessons in session s."""

        state = self.state
        P = self.P
        base = s * PERIODS
        first = state.ts_first[t][s]
        last = state.ts_last[t][s]
        if first < 0:
            return False
        target_periods = [p for p in (first - 1, last + 1) if 0 <= p < PERIODS]
        donor_sessions = [
            s2 for s2 in self._teacher_sessions_used(t) if s2 != s and state.ts_count[t][s2] >= 3
        ]
        donor_sessions.sort(key=lambda s2: -state.ts_count[t][s2])
        for s2 in donor_sessions:
            base2 = s2 * PERIODS
            for edge in (state.ts_first[t][s2], state.ts_last[t][s2]):
                slot2 = base2 + edge
                ai = state.teacher_slot[t][slot2]
                if ai < 0:
                    continue
                c2 = P.a_class[ai]
                run2 = self._run_of(c2, slot2)
                if len(run2) != 1 or self._locked_in(c2, run2):
                    continue
                for p in target_periods:
                    slot_target = base + p
                    occ = state.grid[c2][slot_target]
                    if state.locked[c2][slot_target]:
                        continue
                    if occ >= 0:
                        changes = self._swap_runs_changes(c2, run2, [slot_target])
                    else:
                        changes = [(c2, slot2, -1), (c2, slot_target, ai)]
                    if changes and self._try(changes):
                        return True
        return False

    def _vacate_session(self, t: int, s: int) -> bool:
        """Move every block of t out of session s into t's other sessions.
        Reverts unless the final tuple strictly improves."""

        state = self.state
        blocks = self._teacher_blocks_in_session(t, s)
        if not blocks:
            return False
        for c, run in blocks:
            if self._locked_in(c, run):
                return False
        snap = state.snapshot()
        before = state.objective()
        saved_best = (self.best_tuple, self.best_snap)
        for c, run in blocks:
            ok = False
            for s2 in self._teacher_sessions_used(t):
                if s2 == s or state.ts_count[t][s2] + len(run) > PERIODS:
                    continue
                if self._swap_block_into_session(
                    c, run, s2, prefer_adjacent=(t, s2), allow_equal=True
                ):
                    ok = True
                    break
            if not ok:
                state.restore(snap)
                self.best_tuple, self.best_snap = saved_best
                return False
        after = state.objective()
        if after < before:
            if after < self.best_tuple:
                self.best_tuple = after
                self.best_snap = state.snapshot()
            return True
        state.restore(snap)
        self.best_tuple, self.best_snap = saved_best
        return False

    def _kempe_column_swap(self, seed_class: int, s: int, p1: int, p2: int) -> bool:
        """Swap columns p1<->p2 of session s across the closed class component
        containing seed_class (teacher-conflict closure)."""

        state = self.state
        P = self.P
        if p1 == p2:
            return False
        base = s * PERIODS
        slot1 = base + p1
        slot2 = base + p2
        comp: set[int] = {seed_class}
        queue = [seed_class]
        while queue:
            c = queue.pop()
            if len(comp) > 12:
                return False
            for slot, other in ((slot1, slot2), (slot2, slot1)):
                ai = state.grid[c][slot]
                if ai < 0:
                    continue
                t = P.a_teacher[ai]
                if t < 0:
                    continue
                blocker = state.teacher_slot[t][other]
                if blocker >= 0:
                    c2 = P.a_class[blocker]
                    if c2 not in comp:
                        comp.add(c2)
                        queue.append(c2)
        changes: list[tuple[int, int, int]] = []
        for c in comp:
            a1 = state.grid[c][slot1]
            a2 = state.grid[c][slot2]
            if a1 == a2:
                continue
            for slot, ai in ((slot1, a1), (slot2, a2)):
                if state.locked[c][slot]:
                    return False
                if ai >= 0 and len(self._run_of(c, slot)) != 1:
                    return False
            changes.append((c, slot1, a2))
            changes.append((c, slot2, a1))
        if not changes:
            return False
        return self._try(changes)

    # ------------------------------------------------------------------
    # operators
    # ------------------------------------------------------------------

    def op_singleton(self, deadline: float) -> bool:
        state = self.state
        P = self.P
        improved = False
        targets = [
            (t, s)
            for t in range(P.num_teachers())
            for s in range(NUM_SESSIONS)
            if state.ts_count[t][s] == 1
        ]
        self.rng.shuffle(targets)
        for t, s in targets:
            if time.monotonic() > deadline:
                break
            if state.ts_count[t][s] != 1:
                continue
            if self._fix_singleton(t, s):
                improved = True
        return improved

    def _fix_singleton(self, t: int, s: int) -> bool:
        state = self.state
        P = self.P
        base = s * PERIODS
        p = state.ts_first[t][s]
        if p < 0:
            return False
        slot = base + p
        ai = state.teacher_slot[t][slot]
        if ai < 0:
            return False
        c = P.a_class[ai]
        run = self._run_of(c, slot)
        if not self._locked_in(c, run):
            # A: merge the lone lesson into another session where t teaches
            for s2 in self._teacher_sessions_used(t):
                if s2 == s or state.ts_count[t][s2] >= PERIODS:
                    continue
                if self._swap_block_into_session(c, run, s2, prefer_adjacent=(t, s2)):
                    return True
        # B: bring a friend into s (works for locked lone lessons too)
        if self._bring_friend(t, s):
            return True
        # C: 3-cycles — push the lone lesson next to t's other sessions
        if len(run) == 1 and not self._locked_in(c, run):
            for s2 in self._teacher_sessions_used(t):
                if s2 == s or state.ts_count[t][s2] >= PERIODS:
                    continue
                first = state.ts_first[t][s2]
                last = state.ts_last[t][s2]
                base2 = s2 * PERIODS
                for q in (first - 1, last + 1):
                    if 0 <= q < PERIODS:
                        if self._cycle3_place(c, run[0], base2 + q):
                            return True
        # D: chain — relocate the lone lesson to a different empty session
        # (tuple-neutral), then retry the direct fixes from there
        if len(run) == 1 and not self._locked_in(c, run):
            snap = state.snapshot()
            saved_best = (self.best_tuple, self.best_snap)
            empties = [
                s3 for s3 in range(NUM_SESSIONS) if state.ts_count[t][s3] == 0 and s3 != s
            ]
            self.rng.shuffle(empties)
            for s3 in empties[:4]:
                if self._swap_block_into_session(c, run, s3, prefer_adjacent=None, allow_equal=True):
                    new_first = state.ts_first[t][s3]
                    if new_first >= 0 and state.ts_count[t][s3] == 1:
                        if self._fix_singleton_direct(t, s3):
                            return True
                    state.restore(snap)
                    self.best_tuple, self.best_snap = saved_best
        return False

    def _fix_singleton_direct(self, t: int, s: int) -> bool:
        """Direct (non-chaining) singleton fixes only — used inside chains."""

        state = self.state
        P = self.P
        base = s * PERIODS
        p = state.ts_first[t][s]
        if p < 0:
            return False
        slot = base + p
        ai = state.teacher_slot[t][slot]
        if ai < 0:
            return False
        c = P.a_class[ai]
        run = self._run_of(c, slot)
        if not self._locked_in(c, run):
            for s2 in self._teacher_sessions_used(t):
                if s2 == s or state.ts_count[t][s2] >= PERIODS:
                    continue
                if self._swap_block_into_session(c, run, s2, prefer_adjacent=(t, s2)):
                    return True
        if self._bring_friend(t, s):
            return True
        if len(run) == 1 and not self._locked_in(c, run):
            for s2 in self._teacher_sessions_used(t):
                if s2 == s or state.ts_count[t][s2] >= PERIODS:
                    continue
                first = state.ts_first[t][s2]
                last = state.ts_last[t][s2]
                base2 = s2 * PERIODS
                for q in (first - 1, last + 1):
                    if 0 <= q < PERIODS:
                        if self._cycle3_place(c, run[0], base2 + q):
                            return True
        return False

    def op_gap(self, deadline: float, min_gap: int) -> bool:
        state = self.state
        P = self.P
        improved = False
        targets = []
        for t in range(P.num_teachers()):
            for s in range(NUM_SESSIONS):
                count = state.ts_count[t][s]
                if count <= 0:
                    continue
                gap = state.ts_last[t][s] - state.ts_first[t][s] + 1 - count
                if gap >= min_gap:
                    targets.append((gap, t, s))
        targets.sort(reverse=True)
        for _gap, t, s in targets:
            if time.monotonic() > deadline:
                break
            if self._fix_gap_session(t, s):
                improved = True
        return improved

    def _holes(self, t: int, s: int) -> list[int]:
        state = self.state
        base = s * PERIODS
        first = state.ts_first[t][s]
        last = state.ts_last[t][s]
        if first < 0:
            return []
        return [p for p in range(first + 1, last) if state.teacher_slot[t][base + p] < 0]

    def _hole_run_len(self, t: int, s: int, h: int) -> int:
        state = self.state
        base = s * PERIODS
        n = 0
        p = h
        while p < PERIODS and state.teacher_slot[t][base + p] < 0:
            n += 1
            p += 1
        return n

    def _fix_gap_session(self, t: int, s: int) -> bool:
        state = self.state
        P = self.P
        base = s * PERIODS
        holes = self._holes(t, s)
        if not holes:
            return False
        # 1. border block slides into a hole window (same class swap)
        for edge_period in (state.ts_first[t][s], state.ts_last[t][s]):
            slot_edge = base + edge_period
            ai = state.teacher_slot[t][slot_edge]
            if ai < 0:
                continue
            c = P.a_class[ai]
            run = self._run_of(c, slot_edge)
            if self._locked_in(c, run):
                continue
            L = len(run)
            for h in holes:
                if self._hole_run_len(t, s, h) < L:
                    continue
                window = [base + h + off for off in range(L)]
                if window[-1] >= base + PERIODS:
                    continue
                if any(state.grid[c][x] < 0 or state.locked[c][x] for x in window):
                    continue
                changes = self._swap_runs_changes(c, run, window)
                if changes and self._try(changes):
                    return True
        # 2. pull one of t's blocks from another session into the hole
        for h in holes:
            max_len = self._hole_run_len(t, s, h)
            for s2 in self._teacher_sessions_used(t):
                if s2 == s:
                    continue
                for c2, run2 in self._teacher_blocks_in_session(t, s2):
                    if len(run2) > max_len or self._locked_in(c2, run2):
                        continue
                    window = [base + h + off for off in range(len(run2))]
                    if any(state.grid[c2][x] < 0 or state.locked[c2][x] for x in window):
                        continue
                    changes = self._swap_runs_changes(c2, run2, window)
                    if changes and self._try(changes):
                        return True
        # 3. Kempe column swap: hole column <-> border column
        for h in holes:
            for edge_period in (state.ts_first[t][s], state.ts_last[t][s]):
                slot_edge = base + edge_period
                ai = state.teacher_slot[t][slot_edge]
                if ai < 0:
                    continue
                if self._kempe_column_swap(P.a_class[ai], s, edge_period, h):
                    return True
        # 3b. 3-cycles: border single into a hole / pull a single into a hole
        for edge_period in (state.ts_first[t][s], state.ts_last[t][s]):
            slot_edge = base + edge_period
            ai = state.teacher_slot[t][slot_edge]
            if ai < 0:
                continue
            c = P.a_class[ai]
            if len(self._run_of(c, slot_edge)) != 1:
                continue
            for h in holes:
                if self._cycle3_place(c, slot_edge, base + h):
                    return True
        for h in holes:
            for s2 in self._teacher_sessions_used(t):
                if s2 == s:
                    continue
                for c2, run2 in self._teacher_blocks_in_session(t, s2):
                    if len(run2) != 1:
                        continue
                    if self._cycle3_place(c2, run2[0], base + h):
                        return True
        # 3c. move a border block out to another session (span shrink)
        for edge_period in (state.ts_first[t][s], state.ts_last[t][s]):
            slot_edge = base + edge_period
            ai = state.teacher_slot[t][slot_edge]
            if ai < 0:
                continue
            c = P.a_class[ai]
            run = self._run_of(c, slot_edge)
            if self._locked_in(c, run):
                continue
            for s2 in self._teacher_sessions_used(t):
                if s2 == s or state.ts_count[t][s2] + len(run) > PERIODS:
                    continue
                if self._swap_block_into_session(c, run, s2, prefer_adjacent=(t, s2)):
                    return True
        # 4. dissolve the session entirely
        if self._vacate_session(t, s):
            return True
        return False

    def op_sessions(self, deadline: float) -> bool:
        state = self.state
        P = self.P
        improved = False
        thin = [
            (state.ts_count[t][s], t, s)
            for t in range(P.num_teachers())
            for s in range(NUM_SESSIONS)
            if 0 < state.ts_count[t][s] <= 2
        ]
        thin.sort()
        for _count, t, s in thin:
            if time.monotonic() > deadline:
                break
            if state.ts_count[t][s] == 0:
                continue
            if self._vacate_session(t, s):
                improved = True
        return improved

    def op_class_session_swap(self, deadline: float, tries: int = 200) -> bool:
        state = self.state
        P = self.P
        rng = self.rng
        improved = False
        for _ in range(tries):
            if time.monotonic() > deadline:
                break
            c = rng.randrange(P.num_classes())
            s1 = rng.randrange(NUM_SESSIONS)
            s2 = rng.randrange(NUM_SESSIONS)
            if s1 == s2:
                continue
            base1, base2 = s1 * PERIODS, s2 * PERIODS
            if any(
                state.locked[c][base1 + p] or state.locked[c][base2 + p] for p in range(PERIODS)
            ):
                continue
            cells1 = [state.grid[c][base1 + p] for p in range(PERIODS)]
            cells2 = [state.grid[c][base2 + p] for p in range(PERIODS)]
            if all(a < 0 for a in cells1) and all(a < 0 for a in cells2):
                continue
            changes = []
            for p in range(PERIODS):
                changes.append((c, base1 + p, cells2[p]))
                changes.append((c, base2 + p, cells1[p]))
            if self._try(changes):
                improved = True
        return improved

    # ------------------------------------------------------------------

    def perturb(self, strength: int = 6) -> None:
        state = self.state
        P = self.P
        rng = self.rng
        done = 0
        guard = 0
        while done < strength and guard < strength * 40:
            guard += 1
            c = rng.randrange(P.num_classes())
            slot1 = rng.randrange(NUM_SESSIONS * PERIODS)
            slot2 = rng.randrange(NUM_SESSIONS * PERIODS)
            if slot1 == slot2:
                continue
            if state.locked[c][slot1] or state.locked[c][slot2]:
                continue
            a1 = state.grid[c][slot1]
            a2 = state.grid[c][slot2]
            if a1 < 0 and a2 < 0:
                continue
            if a1 >= 0 and len(self._run_of(c, slot1)) != 1:
                continue
            if a2 >= 0 and len(self._run_of(c, slot2)) != 1:
                continue
            journal = state.apply([(c, slot1, a2), (c, slot2, a1)])
            if journal is not None:
                done += 1

    # ------------------------------------------------------------------

    def run(self, deadline: float) -> None:
        state = self.state
        stagnation = 0
        last_report = 0.0
        while time.monotonic() < deadline:
            round_deadline = min(deadline, time.monotonic() + 6.0)
            improved = False
            if state.n_singleton > self.floor_singleton:
                improved |= self.op_singleton(round_deadline)
            if state.n_gap2 > 0 and time.monotonic() < round_deadline:
                improved |= self.op_gap(round_deadline, 2)
            if time.monotonic() < round_deadline:
                improved |= self.op_sessions(round_deadline)
            if (
                state.n_singleton <= self.floor_singleton
                and state.n_gap2 == 0
                and state.n_gap1 > 0
                and time.monotonic() < round_deadline
            ):
                improved |= self.op_gap(round_deadline, 1)
            if time.monotonic() < round_deadline:
                improved |= self.op_class_session_swap(round_deadline, tries=120)
            cur = state.objective()
            if cur < self.best_tuple:
                self.best_tuple = cur
                self.best_snap = state.snapshot()
            if self.progress is not None:
                now = time.monotonic()
                if now - last_report > 5.0:
                    last_report = now
                    try:
                        self.progress(
                            {
                                "stage": "optimize:round",
                                "message": "Toi uu lich: 1tiet=%d gap2=%d buoi=%d gap1=%d"
                                % (cur[0], cur[1], cur[2], cur[3]),
                            }
                        )
                    except Exception:
                        pass
            # 19/08 THOAT SOM: portfolio nay chay den het deadline nen mot lich
            # da cham day van ngoi cho het gio. Neu 1 tiet/buoi da o day, khong
            # con buoi trong >=2 va khong con trong 1 tiet, thi bo (1,2,4) cua
            # tuple khong the tot hon; chi con tsBuoiDay co the nhich. Cho them
            # vai vong khong cai thien roi dung — tra ket qua som thay vi dot
            # not ngan sach.
            if (
                cur[0] <= self.floor_singleton
                and cur[1] == 0
                and cur[3] == 0
                and stagnation >= 6
            ):
                break
            if not improved:
                stagnation += 1
                if stagnation % 3 == 0:
                    state.restore(self.best_snap)
                    self.perturb(strength=10 + 4 * min(8, stagnation // 3))
                    self.op_class_session_swap(
                        min(deadline, time.monotonic() + 1.0), tries=40
                    )
                else:
                    self.perturb(strength=5)
            else:
                stagnation = 0
        if state.objective() > self.best_tuple:
            state.restore(self.best_snap)
