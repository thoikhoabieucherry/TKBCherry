"""One-button entry point: UI JSON -> complete optimized timetable payload.

Reuses the proven adapter plumbing for parsing, capacity accounting, fixed
lessons and payload/validation format — only the *scheduling algorithm* is new.
Runs a multi-seed portfolio (multiprocessing when available, sequential
fallback otherwise) of construct + lexicographic optimize.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from tkb_optimizer_ref.rules import teacher_members

from .core import NUM_SLOTS, PERIODS, Problem, compile_problem
from .construct import Constructor
from .optimize import Optimizer
from .state import State

ProgressFn = Callable[[dict], None]

ENGINE_NAME = "tkb-engine-v3"


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _max_solve_seconds() -> int:
    """03/09: tran thoi gian mot luot cua engine (truoc day ghi cung 600 s). Ban chay
    trong may (Cherry Local, o chon thoi luong toi 30 phut) nang bang env
    TKB_V3_MAX_SOLVE_SECONDS; khong dat thi giu 600 s nhu production."""
    cap = _to_int(os.environ.get("TKB_V3_MAX_SOLVE_SECONDS", ""), 0)
    return cap if cap > 0 else 600


def _solve_deadline_seconds(settings: Mapping[str, Any] | None) -> float:
    settings = settings or {}
    candidates = [
        _to_int(settings.get("overall_time_limit_seconds"), 0),
        _to_int(settings.get("optimization_time_limit_seconds"), 0),
        _to_int(settings.get("backend_deadline_ms"), 0) // 1000,
    ]
    positive = [c for c in candidates if c > 0]
    total = min(positive) if positive else 110
    return float(max(10, min(total, _max_solve_seconds())))


def _context_with_fixed_demand(original_ctx, trimmed_ctx, fixed_lessons):
    """Return a context whose assignments = trimmed residual demand + the
    fixed lessons' demand (so the engine hosts fixed cells as locked cells)."""

    from dataclasses import replace as dc_replace
    from collections import Counter

    fixed_counts = Counter(
        (l.class_name, l.subject, l.teacher) for l in fixed_lessons
    )
    by_key = {}
    assignments = []
    for a in trimmed_ctx.school_data.assignments:
        key = (a.class_name, a.subject, a.teacher)
        add = fixed_counts.pop(key, 0)
        assignments.append(dc_replace(a, periods_per_week=a.periods_per_week + add) if add else a)
        by_key[key] = True
    if fixed_counts:
        original_by_key = {
            (a.class_name, a.subject, a.teacher): a
            for a in original_ctx.school_data.assignments
        }
        for key, count in fixed_counts.items():
            base = original_by_key.get(key)
            if base is not None:
                assignments.append(dc_replace(base, periods_per_week=count))
    school_data = dc_replace(trimmed_ctx.school_data, assignments=assignments)
    return dc_replace(trimmed_ctx, school_data=school_data)


def _teacher_matching_trim(problem: Problem, ctx) -> list[dict[str, Any]]:
    """Provably-impossible teacher load is removed BEFORE solving.

    For each teacher, a bipartite matching (lesson-period -> usable slot)
    proves how many periods can physically be placed. The deficit is trimmed
    from the problem and reported as `Chua phan — not_enough_available_slots`,
    so the engine always optimizes a completable schedule instead of burning
    its whole budget on impossible periods.
    """

    from .core import NUM_SLOTS

    fixed_count: dict[int, int] = {}
    fixed_teacher_slots: dict[int, set[int]] = {}
    fixed_class_slots: dict[int, set[int]] = {}
    for c, slot, ai in problem.fixed_cells:
        fixed_count[ai] = fixed_count.get(ai, 0) + 1
        for t in problem.a_teachers[ai]:
            fixed_teacher_slots.setdefault(t, set()).add(slot)
        fixed_class_slots.setdefault(c, set()).add(slot)

    by_teacher: dict[int, list[int]] = {}
    for ai in range(problem.num_assignments()):
        t = problem.a_teacher[ai]
        if t < 0:
            continue
        residual = problem.a_periods[ai] - fixed_count.get(ai, 0)
        if residual > 0:
            by_teacher.setdefault(t, []).extend([ai] * residual)

    out: list[dict[str, Any]] = []
    class_by_name = getattr(ctx, "class_by_name", {}) or {}
    for t, units in by_teacher.items():
        blocked_t = fixed_teacher_slots.get(t, set())
        adj: list[list[int]] = []
        for ai in units:
            c = problem.a_class[ai]
            blocked_c = fixed_class_slots.get(c, set())
            adj.append(
                [
                    x
                    for x in range(NUM_SLOTS)
                    if problem.a_allowed[ai][x]
                    and x not in blocked_t
                    and x not in blocked_c
                ]
            )
        match_slot: dict[int, int] = {}

        def try_kuhn(u: int, seen: set) -> bool:
            for s in adj[u]:
                if s in seen:
                    continue
                seen.add(s)
                if s not in match_slot or try_kuhn(match_slot[s], seen):
                    match_slot[s] = u
                    return True
            return False

        unmatched: list[int] = []
        for u in range(len(units)):
            if not try_kuhn(u, set()):
                unmatched.append(u)
        if not unmatched:
            continue
        drop_per_assignment: dict[int, int] = {}
        for u in unmatched:
            drop_per_assignment[units[u]] = drop_per_assignment.get(units[u], 0) + 1
        for ai, drop in drop_per_assignment.items():
            keep_fixed = fixed_count.get(ai, 0)
            new_periods = max(keep_fixed, problem.a_periods[ai] - drop)
            actually_dropped = problem.a_periods[ai] - new_periods
            if actually_dropped <= 0:
                continue
            problem.a_periods[ai] = new_periods
            # keep lessonBlocks minimums achievable for the reduced load
            rule = problem.a_rule[ai]
            if rule is not None and rule.lesson_blocks:
                from dataclasses import replace as dc_replace

                new_blocks = []
                for length, minimum, maximum in rule.lesson_blocks:
                    achievable = 0 if problem.a_cap[ai] < length else max(0, new_periods // length)
                    new_blocks.append((length, min(minimum, achievable), maximum))
                problem.a_rule[ai] = dc_replace(rule, lesson_blocks=tuple(new_blocks))
            cname = problem.class_names[problem.a_class[ai]]
            class_entry = class_by_name.get(cname)
            out.append(
                {
                    "classId": getattr(class_entry, "id", cname),
                    "className": cname,
                    "grade": problem.class_grades[problem.a_class[ai]],
                    "subject": problem.subject_names[problem.a_subject[ai]],
                    "teacher": problem.teacher_names[t],
                    "room": problem.a_room[ai],
                    "periods": actually_dropped,
                    "reason": "not_enough_available_slots",
                    "message": "Khong du o day cua giao vien sau khi ap dung tiet nghi/rang buoc.",
                }
            )
    return out


def _requested_quality_focus(settings: Mapping[str, Any] | None) -> str | None:
    """Nut menu "Toi uu v3" ma bridge gui (optimization_gap_target /
    optimization_focus) -> gap1 | gap2 | singletons | sessions | None."""

    s = settings or {}
    _gap_target = str(s.get("optimization_gap_target") or "").strip().lower()
    _focus = str(s.get("optimization_focus") or "").strip().lower().replace("-", "_")
    if _gap_target in {"gap1", "gap_1", "teacher_gap1_sessions", "optimize_gap1"}:
        return "gap1"
    if _gap_target in {"gap2", "gap_2", "teacher_gap2_sessions", "optimize_gap2"}:
        return "gap2"
    if _focus in {"singletons", "singleton", "one_period", "optimize_singletons"}:
        return "singletons"
    if _focus in {"sessions", "session", "teacher_sessions", "optimize_sessions"}:
        return "sessions"
    return None


def _focus_rounds(settings: Mapping[str, Any] | None, budget_s: float) -> int:
    """So vong portfolio cho nut mot muc tieu (vong sau warm-start tu luoi tot
    nhat vong truoc). Mac dinh theo ngan sach: >= 90 s -> 3 vong, >= 60 s -> 2,
    con lai 1; chinh bang settings.focus_rounds hoac env TKB_FOCUS_ROUNDS.

    Do 25/08 tren luoi production default (gap1 tu 147, 8 worker / 120 s):
    1 vong 133/137/128/134/129 (TB 132), 2 vong 129/124/135/125 (TB 128),
    3 vong 122/127 (TB 124,5) — cac worker chia se luoi tot nhat giua chung
    tot hon 8 worker chay doc lap tron ngan sach."""

    raw = (settings or {}).get("focus_rounds")
    if raw is None or str(raw).strip() == "":
        raw = os.environ.get("TKB_FOCUS_ROUNDS", "")
    if budget_s >= 90:
        default = 3
    elif budget_s >= 60:
        default = 2
    else:
        default = 1
    rounds = _to_int(raw, default)
    if rounds < 1:
        rounds = 1
    if budget_s < 60:
        rounds = 1
    return min(rounds, 6)


def _cherry_rounds(settings: Mapping[str, Any] | None, budget_s: float) -> int:
    """03/09: nut Cherry (khong focus) mac dinh MOT vong nhu production: moi worker
    thoat "converged" (construct.py, bac 3 idle 25-90 s) roi portfolio tra ket qua,
    phan ngan sach con lai bi bo (do 5 phut tren Thi Tran: xong o 173 s). Ban chay
    trong may (Cherry Local) dat env TKB_V3_CHERRY_ROUNDS=auto (hoac mot so) de luot
    dai chia nhieu vong: vong sau warm-start tu luoi tot nhat vong truoc voi seed
    moi (cung co che rounds cua lane mot muc tieu). Khong dat env -> 1."""
    raw = os.environ.get("TKB_V3_CHERRY_ROUNDS", "").strip().lower()
    if not raw:
        return 1
    if raw == "auto":
        if budget_s < 150:
            return 1
        return max(2, min(6, int(budget_s // 60)))
    return max(1, min(6, _to_int(raw, 1)))


def _cpsat_lane_enabled(settings: Mapping[str, Any] | None, problem: Problem | None = None) -> bool:
    """26/08: toan tu CP-SAT LNS theo cum cho nut gap1/sessions co san va
    khong bi tat (settings.focus_cpsat_lns hoac env TKB_CPSAT_LNS = 0).

    Truong co NHIEU GV mang yeu cau dia diem (mo hinh dong bang cac GV do ->
    cum gan nhu hang so; do tren 8fbda952091: 36/112 GV dong bang, CP-SAT
    1 tien trinh cho 101 trong khi 6 worker quet ep cho 80) thi giu duong cu."""

    raw = (settings or {}).get("focus_cpsat_lns")
    if raw is not None and str(raw).strip().lower() in ("0", "false", "off", "no"):
        return False
    if problem is not None:
        try:
            loc = list(getattr(problem, "teacher_loc_rules", None) or [])
            n_t = max(1, problem.num_teachers())
            if loc and sum(1 for x in loc if x) / n_t > 0.25:
                return False
        except Exception:
            pass
    try:
        from .cpsat_lns import available

        return bool(available())
    except Exception:
        return False


def _portfolio_worker_cap() -> int:
    """03/09: tran so tien trinh portfolio (truoc day ghi cung 8 = Cloud Run
    8 vCPU / VPS 6). Ban chay trong may (Cherry Local, 16 nhan) nang bang env
    TKB_V3_MAX_WORKERS; khong dat thi giu nguyen 8 nhu production."""
    cap = _to_int(os.environ.get("TKB_V3_MAX_WORKERS", ""), 0)
    return cap if cap > 0 else 8


def _num_workers(settings: Mapping[str, Any] | None) -> int:
    requested = _to_int((settings or {}).get("num_workers"), 0)
    cpus = os.cpu_count() or 2
    if requested > 0:
        return max(1, min(requested, cpus, _portfolio_worker_cap()))
    return max(1, min(cpus - 1, 6))


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------


QUALITY_EJECT_REASON = "teacher_quality_unreachable"


_FOCUS_METRIC_KEY = {
    "singletons": "one_period_teacher_sessions",
    "gap2": "teacher_gap2_sessions",
    "sessions": "teacher_sessions",
    "gap1": "teacher_gap1_sessions",
}
_METRIC_INDEX = {
    "one_period_teacher_sessions": 0,
    "teacher_gap2_sessions": 1,
    "teacher_sessions": 2,
    "teacher_gap1_sessions": 3,
}
_METRIC_VI = {
    "one_period_teacher_sessions": "Dạy 1 tiết",
    "teacher_gap2_sessions": "Trống 2 tiết",
    "teacher_sessions": "Buổi dạy",
    "teacher_gap1_sessions": "Trống 1 tiết",
}


class _LiveQuality:
    """22/08 (khuya, chu du an: "nut toi uu phai hien 1 tiet -> 0 tiet"):
    gom khung tien do cua CAC WORKER (bac 3 phat moi ~2s) ve tien trinh chinh,
    lay chat luong tot nhat hien co va phat mot khung co cau truc
    (optimizationFocus/metricCurrent/metricBaseline/metricLabel) de bridge hien
    so lieu truc tiep thay vi chi "Dang xep bang Cherry v3!"."""

    def __init__(self, progress: ProgressFn | None, focus: str | None):
        self.progress = progress
        self.focus = focus
        self.key = _FOCUS_METRIC_KEY.get(focus or "", "one_period_teacher_sessions")
        self.by_seed: dict[int, list[int]] = {}
        self.baseline: list[int] | None = None
        self.last_emit = 0.0
        self.last_best: list[int] | None = None
        # 23/08 (muc A): so lan "ep lap roi sua" da thu theo tung worker (nut
        # gap1) -> nhan co them "· đã thử n lỗ" doi lien tuc giua hai lan giam.
        self.tried_by_seed: dict[int, int] = {}
        self.last_label: str = ""

    @staticmethod
    def _better(a: list[int], b: list[int]) -> bool:
        return tuple(a) < tuple(b)

    def on_event(self, seed: int, evt: Mapping[str, Any]) -> None:
        q = evt.get("quality") if isinstance(evt, Mapping) else None
        if not (isinstance(q, (list, tuple)) and len(q) >= 4):
            return
        q = [int(x) for x in q[:4]]
        if self.baseline is None:
            # khung dau tien = chat luong luoi xuat phat (warm) / vua xay xong
            self.baseline = list(q)
        self.by_seed[int(seed)] = q
        try:
            tried = int(evt.get("sweep_tried") or 0)
        except (TypeError, ValueError):
            tried = 0
        if tried > 0:
            self.tried_by_seed[int(seed)] = max(tried, self.tried_by_seed.get(int(seed), 0))
        self.maybe_emit()

    def maybe_emit(self, force: bool = False) -> None:
        if self.progress is None or not self.by_seed:
            return
        now = time.monotonic()
        idx = _METRIC_INDEX[self.key]
        if self.focus == "gap1":
            best = min(self.by_seed.values(), key=lambda v: (v[0], v[1], v[3], v[2]))
        else:
            best = min(self.by_seed.values(), key=lambda v: (v[0], v[1], v[2], v[3]))
        # 26/08: gia tri tot nhat DOI thi phat ngay (nguoi dung thay so giam
        # trong <1 s); chi han 2 s khi gia tri khong doi (nhip tim).
        if not force and now - self.last_emit < 2.0 and best == self.last_best:
            return
        base = self.baseline or best
        current = int(best[idx])
        baseline = max(int(base[idx]), current)
        if self.focus:
            label = f"{_METRIC_VI[self.key]}: {baseline} ➔ {current}"
            if self.focus == "gap1" and self.tried_by_seed:
                # 23/08 (muc A): cho thay engine dang ep lap lo giua hai lan giam
                label += f" · đã thử {max(self.tried_by_seed.values())} lỗ"
            # 26/08 (chu du an: "toi thay 40 -> 30 roi tu nhien tang"): con so
            # tren man hinh la chi so phu trach CUA LUOI tot nhat theo thu tu
            # tu dien 4 chi so (1 tiet/buoi > trong >=2 > trong 1 > buoi day).
            # Khi mot worker thang o chi so UU TIEN CAO HON, luoi do duoc chon
            # va chi so phu trach co the nhich len — dung, nhung nhin nhu di lui
            # vi nhan chi khoe MOT so. Hien ca ba so con lai de thay no doi lay gi.
            others = [
                f"{_METRIC_VI[name]} {int(best[pos])}"
                for name, pos in _METRIC_INDEX.items()
                if pos != idx
            ]
            if others:
                label += " · " + " · ".join(others)
        else:
            label = (
                f"1 tiết/buổi {max(base[0], best[0])} ➔ {best[0]} · "
                f"Trống 2 tiết {max(base[1], best[1])} ➔ {best[1]} · "
                f"Buổi {best[2]} · Trống 1 {best[3]}"
            )
        if not force and best == self.last_best and label == self.last_label:
            return
        self.last_best = list(best)
        self.last_label = label
        self.last_emit = now
        try:
            self.progress(
                {
                    "stage": "optimize:quality",
                    "message": label,
                    "optimizationFocus": self.key,
                    "metricCurrent": current,
                    "metricBaseline": baseline,
                    "metricTarget": 0,
                    "metricLabel": label,
                    "quality": list(best),
                }
            )
        except Exception:
            pass


def _worker_solve(args) -> dict:
    problem, seed, budget_s, warm_cells = args[:4]
    focus = args[4] if len(args) > 4 else None
    warm_missing_ok = int(args[5]) if len(args) > 5 else 0
    live_sink = args[6] if len(args) > 6 else None
    cpsat_threads = int(args[7]) if len(args) > 7 else 0
    cherry_cpsat = bool(args[8]) if len(args) > 8 else False
    started = time.monotonic()
    deadline = started + budget_s
    expected = sum(problem.a_periods)
    constructor = Constructor(problem, seed=seed)
    if focus:
        constructor.quality_focus = focus
    # 26/08: so luong CP-SAT cua toan tu LNS theo cum (0 = tu chon)
    constructor.cpsat_threads = max(0, cpsat_threads)
    constructor.cherry_cpsat = cherry_cpsat
    if warm_missing_ok > 0:
        # 22/08 (toi): lich vao duoc phep thieu dung nhung tiet Cherry lan
        # truoc da dua ve Chua phan vi chat luong GV -> van warm-start.
        constructor.warm_missing_ok = warm_missing_ok
    worker_progress = None
    if live_sink is not None:
        def worker_progress(evt, _seed=seed, _sink=live_sink):
            try:
                if callable(_sink):
                    _sink(_seed, evt)
                else:
                    _sink.put_nowait((_seed, dict(evt)))
            except Exception:
                pass
    state, info = constructor.solve(deadline, progress=worker_progress, warm_cells=warm_cells)
    result: dict[str, Any] = {
        "seed": seed,
        "expected": expected,
        "min_ok": True,
        "info": info,
    }
    result["placed"] = state.placed
    result["objective"] = state.objective()
    result["grid"] = state.snapshot()
    # 26/08 (chu du an: "khong duoc pha vo cac rang buoc dia diem cua TKB
    # nay"): so buoi vi pham yeu cau DIA DIEM cua nghiem nay — rank() xep no
    # len dau va _location_gate chan ket qua xau hon moc xuat phat.
    try:
        result["location_debt"] = int(state.location_rule_debt_sessions())
    except Exception:
        result["location_debt"] = 0
    # so tiet engine CHU DONG dua ve Chua phan (kem ly do) de GV het buoi 1
    # tiet / trong >= 2 — tinh la "da xu ly" khi so sanh cac seed.
    result["quality_ejected"] = len((info or {}).get("quality_ejected") or [])
    # 13/09 (chu du an: "gioi han buoi day khi bam Cherry phai tuan thu"): so tiet
    # dang VI PHAM "Gioi han buoi day" — trinh duyet se go chung ve Chua phan nen
    # rank() tinh chung la chua xep.
    try:
        result["session_debt"] = _session_debt_lessons(problem, state)
    except Exception:
        result["session_debt"] = 0
    return result


def _session_debt_lessons(problem, state) -> int:
    debt = 0
    for t, rule in enumerate(problem.teacher_rules):
        if rule is None or not any(rule.session_mode):
            continue
        counts = state.ts_count[t]
        for d, mode in enumerate(rule.session_mode):
            am, pm = counts[d * 2], counts[d * 2 + 1]
            if mode == "morning":
                debt += pm
            elif mode == "afternoon":
                debt += am
            elif mode == "either" and am > 0 and pm > 0:
                debt += min(am, pm)
    return debt


def _result_hits_floor(res: dict | None, expected: int) -> bool:
    """Nghiem 'cham day': du 100% tiet, khong buoi nao day 1 tiet, khong con
    buoi trong 2 tiet va khong con trong 1 tiet. Luc do bo ba dau cua tuple
    khong the tot hon nua nen khong can cho not cac seed con lai."""
    if not res:
        return False
    try:
        placed_or_handled = int(res.get("placed", 0)) + int(res.get("quality_ejected") or 0)
        if placed_or_handled < int(expected or 0):
            return False
        obj = tuple(res.get("objective") or ())
        if len(obj) < 4:
            return False
        return int(obj[0]) == 0 and int(obj[1]) == 0 and int(obj[3]) == 0
    except Exception:
        return False


def _grid_to_warm_cells(grid) -> list[tuple[int, int, int]]:
    cells: list[tuple[int, int, int]] = []
    for c, row in enumerate(grid or []):
        for slot, ai in enumerate(row):
            if ai >= 0:
                cells.append((c, slot, int(ai)))
    return cells


def _portfolio_solve(
    problem: Problem,
    deadline_s: float,
    workers: int,
    base_seed: int,
    progress: ProgressFn | None,
    warm_cells=None,
    focus: str | None = None,
    warm_all: bool = False,
    warm_missing_ok: int = 0,
    rounds: int = 1,
    cpsat_threads: int = 0,
    cherry_cpsat: bool = False,
) -> dict:
    """Multi-seed portfolio bounded by ONE hard wall-clock deadline.

    The pool wait, the sequential fallback and the emergency single attempt
    all share the same absolute deadline — the engine can never run past the
    budget the backend granted (the old code could double it).

    25/08: `rounds` > 1 (nut mot muc tieu) chia ngan sach thanh nhieu vong;
    vong sau moi worker warm-start tu luoi TOT NHAT cua vong truoc (giong
    nguoi dung bam nut lan 2 — do duoc tren truong default: bam 2 lan 120 s
    tot hon 1 lan 240 s vi cac worker chia se luoi tot nhat giua chung).
    """

    expected = sum(problem.a_periods)
    started = time.monotonic()
    deadline_abs = started + max(8.0, deadline_s)

    def remaining() -> float:
        return deadline_abs - time.monotonic()

    def report_heartbeat(note: str) -> None:
        if progress is None:
            return
        try:
            progress(
                {
                    "stage": "engine_v3:solving",
                    "message": "Dang toi uu lich (%s, con %ds)"
                    % (note, max(0, int(remaining()))),
                }
            )
        except Exception:
            pass

    live = _LiveQuality(progress, focus)

    def run_pool(
        round_warm,
        round_deadline: float,
        round_seed: int,
        pool_cherry: bool | None = None,
        pool_threads: int | None = None,
    ) -> tuple[list[dict], bool]:
        """Mot vong: moi worker chay den round_deadline. Tra (ket qua, cham day).
        01/10: pool_cherry / pool_threads ghi de co CP-SAT cua nut Cherry cho
        vong portfolio heuristic (vong 1 cua Cherry 2 vong)."""

        p_cherry = cherry_cpsat if pool_cherry is None else bool(pool_cherry)
        p_threads = cpsat_threads if pool_threads is None else int(pool_threads)

        collected: list[dict] = []
        early_cut = False
        ctx = multiprocessing.get_context("spawn" if os.name == "nt" else "fork")
        live_queue = None
        manager = None
        if progress is not None:
            try:
                manager = ctx.Manager()
                live_queue = manager.Queue()
            except Exception:
                live_queue = None
                manager = None

        def drain_live() -> None:
            if live_queue is None:
                return
            for _ in range(512):
                try:
                    seed_i, evt = live_queue.get_nowait()
                except Exception:
                    break
                live.on_event(seed_i, evt)

        pool = ctx.Pool(processes=workers)
        try:
            worker_budget = max(8.0, (round_deadline - time.monotonic()) - 4.0)
            args = [
                (
                    problem,
                    round_seed + 101 * i,
                    worker_budget,
                    # focus (nut toi uu) chi cai thien lich hien tai — moi
                    # worker deu warm-start.
                    # 20/08 (chi dao chu du an): lich DA DU 100% thi nut
                    # Cherry phai TOI UU TIEP tren TKB hien tai, nen moi
                    # worker cung warm-start. Truoc day nua so worker xay
                    # lai tu dau; worker "xay moi" ma thang thi ket qua tra
                    # ve khong con dua tren lich cua nguoi dung nua (do duoc
                    # tren truong that: so buoi day nhay 755 -> 782).
                    # Lich CHUA du thi van giu nua warm nua fresh, vi luc do
                    # phan con thieu can duoc xay chu khong phai tinh chinh.
                    # 25/08: nut mot muc tieu luon nhan warm (ke ca rong) de
                    # Constructor tu quyet "toi uu tai cho" hay "bao khong duoc".
                    round_warm
                    if (
                        round_warm is not None
                        and (focus or (round_warm and (warm_all or i < max(1, workers // 2))))
                    )
                    else None,
                    focus,
                    warm_missing_ok,
                    live_queue,
                    (max(1, p_threads // max(1, workers)) if p_threads > 0 else 1),
                    p_cherry,
                )
                for i in range(workers)
            ]
            # 19/08: truoc day dung map_async().get() nen PHAI cho DU moi
            # seed chay het ngan sach. Gio nhan tung ket qua mot; seed nao
            # cham day truoc thi cat luon cac seed con lai -> ket thuc som
            # ma van dung nghiem tot nhat.
            pending = pool.imap_unordered(_worker_solve, args)
            heartbeat_at = time.monotonic()
            while len(collected) < len(args):
                try:
                    # 26/08: 0.5 s thay vi 2 s de khung so lieu cua worker len
                    # nhan trong <= 0.5 s (truoc day tre toi 21 s khi hang doi day).
                    res = pending.next(timeout=0.5)
                except multiprocessing.TimeoutError:
                    if remaining() < -20:
                        # workers overran their own deadline guard — cut them
                        pool.terminate()
                        break
                    drain_live()
                    if live.by_seed:
                        live.maybe_emit()
                    elif time.monotonic() - heartbeat_at >= 10.0:
                        heartbeat_at = time.monotonic()
                        report_heartbeat("%d luong" % workers)
                    continue
                except StopIteration:
                    break
                drain_live()
                if res:
                    collected.append(res)
                    if _result_hits_floor(res, expected):
                        early_cut = True
                        pool.terminate()
                        break
        finally:
            # close() sau terminate() co the nem ValueError tuy phien ban ->
            # boc ca hai, dung de buoc don dep lam hong ket qua da co.
            try:
                pool.close()
            except Exception:
                pass
            try:
                pool.terminate()
            except Exception:
                pass
            try:
                if manager is not None:
                    manager.shutdown()
            except Exception:
                pass
        return collected, early_cut

    best = None

    def rank(res: dict) -> tuple:
        return _rank_key(res, focus)

    results: list[dict] = []
    used_mp = False
    rounds = max(1, int(rounds or 1))
    if not focus and not os.environ.get("TKB_V3_CHERRY_ROUNDS", "").strip():
        rounds = 1   # production: Cherry mot vong (xem _cherry_rounds)
    round_warm = warm_cells
    rounds_done = 0
    # moc xuat phat THAT (luoi nguoi dung) — vong sau warm-start tu luoi tot
    # nhat vong truoc nen info.warm_* cua no la moc trung gian; phai tra lai
    # moc goc cho cong _focus_gate va payload.
    origin_baseline: dict | None = None
    two_stage = False
    if cherry_cpsat and not focus and workers > 1 and remaining() > 30:
        # 01/10 (chu du an: "lam sao nut Cherry lam duoc nhu ban"): Cherry 2 VONG.
        # Vong 1: portfolio heuristic nhu cu (workers tien trinh, KHONG CP-SAT)
        # ~40% ngan sach — giu do da dang (best-of-N). Vong 2: 1 tien trinh x
        # cpsat_threads luong CP-SAT warm tu luoi tot nhat vong 1: lap tiet thieu
        # (lane "fill") roi toi uu chat luong. CP-SAT 1 luong/tien trinh qua cham
        # (do Hung Long: 4 lan giai/22 s), 1 tien trinh thuan thi mat do da dang
        # (truong 61 lop: 1825 tiet sau heuristic so voi 2050 cua best-of-6).
        two_stage = True
        try:
            stage1_deadline = time.monotonic() + remaining() * 0.4
            collected, early_cut = run_pool(round_warm, stage1_deadline, base_seed, pool_cherry=False, pool_threads=0)
            rounds_done = 1
            results.extend(collected)
            used_mp = bool(collected)
            for res in collected:
                info0 = (res or {}).get("info") or {}
                if info0.get("warm_quality") is not None:
                    origin_baseline = {k: info0.get(k) for k in ("warm_quality", "warm_placed", "warm_grid")}
                    break
            if collected and not early_cut and remaining() > 12:
                stage_best = None
                for res in collected:
                    if res and (stage_best is None or rank(res) < rank(stage_best)):
                        stage_best = res
                warm2 = _grid_to_warm_cells(stage_best.get("grid")) if stage_best else None
                if warm_cells and stage_best and not (stage_best.get("info") or {}).get("warm_start"):
                    # vong 1 khong giu duoc lich nguoi dung (warm bi tu choi, xep lai
                    # tu dau) -> vong 2 di tu CHINH lich nguoi dung: Constructor giu
                    # luoi da sua do + lap tiet (_salvage_warm). Do truong 61 lop:
                    # 2067 tiet so voi 2044 khi di tu luoi xep lai. Ket qua cuoi van
                    # chon tot nhat giua ca hai vong (rank).
                    warm2 = list(warm_cells)
                if warm2:
                    report_heartbeat("1 tien trinh x %d luong CP-SAT tu luoi tot nhat" % cpsat_threads)
                    sink2 = (lambda seed_i, evt: (live.on_event(seed_i, evt), live.maybe_emit())) if progress is not None else None
                    results.append(
                        _worker_solve((
                            problem, base_seed + 7777, max(8.0, remaining() - 2.0), warm2,
                            None, warm_missing_ok, sink2, cpsat_threads, True,
                        ))
                    )
                    rounds_done = 2
        except Exception:
            results = []
    if not two_stage and workers > 1 and remaining() > 15:
        try:
            for r in range(rounds):
                left = remaining()
                if r > 0 and left < 20:
                    break
                round_deadline = deadline_abs if r == rounds - 1 else time.monotonic() + left / (rounds - r)
                if r > 0:
                    report_heartbeat("vong %d/%d tu luoi tot nhat" % (r + 1, rounds))
                collected, early_cut = run_pool(round_warm, round_deadline, base_seed + 1000 * r)
                rounds_done += 1
                if not collected:
                    break
                results.extend(collected)
                used_mp = True
                if origin_baseline is None:
                    for res in collected:
                        info0 = (res or {}).get("info") or {}
                        if info0.get("warm_quality") is not None:
                            origin_baseline = {
                                k: info0.get(k) for k in ("warm_quality", "warm_placed", "warm_grid")
                            }
                            break
                if early_cut:
                    report_heartbeat("da cham day, dung som")
                    break
                if r < rounds - 1:
                    round_best = None
                    for res in collected:
                        if res and (round_best is None or rank(res) < rank(round_best)):
                            round_best = res
                    if round_best is None or (round_best.get("info") or {}).get("focus_aborted"):
                        break
                    round_warm = _grid_to_warm_cells(round_best.get("grid"))
                    if not round_warm:
                        break
        except Exception:
            results = []
    # trong tien trinh (1 worker / du phong): worker goi thang live.on_event
    live_sink = (lambda seed_i, evt: (live.on_event(seed_i, evt), live.maybe_emit())) if progress is not None else None
    if not results and remaining() > 10:
        # sequential fallback shares the REMAINING time only
        share = max(8.0, remaining() - 2.0)
        report_heartbeat("1 luong du phong" if cpsat_threads <= 0 else "1 tien trinh x %d luong CP-SAT" % cpsat_threads)
        results.append(
            _worker_solve((problem, base_seed, share, warm_cells, focus, warm_missing_ok, live_sink, cpsat_threads, cherry_cpsat))
        )
    if not results:
        # emergency: one very short attempt so the caller always gets a grid
        results.append(
            _worker_solve((problem, base_seed, 8.0, warm_cells, focus, warm_missing_ok, live_sink, cpsat_threads, cherry_cpsat))
        )
    live.maybe_emit(force=True)

    for res in results:
        if res and (best is None or rank(res) < rank(best)):
            best = res
    assert best is not None
    if origin_baseline is not None and rounds_done > 1:
        best["info"] = dict(best.get("info") or {}, **origin_baseline)
    best["used_multiprocessing"] = used_mp
    best["worker_count"] = workers if used_mp else 1
    best["rounds"] = max(1, rounds_done)
    best["results_summary"] = [
        {
            "seed": r["seed"],
            "placed": r["placed"],
            "objective": list(r["objective"]),
            "quality_ejected": int(r.get("quality_ejected") or 0),
        }
        for r in results
        if r
    ]
    return best


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------


_FOCUS_INDEX = {"singletons": 0, "gap2": 1, "sessions": 2, "gap1": 3}
_FOCUS_METRIC_VI = ["1 tiết/buổi", "trống 2 tiết", "buổi dạy", "trống 1 tiết"]


def _rank_key(res: dict, focus: str | None) -> tuple:
    """Khoa xep hang cac nghiem cua portfolio (nho hon = tot hon).

    Thu tu: SO TIET truoc, roi NO LUAT DIA DIEM, roi cac chi so chat luong GV.

    26/08: da thu dat no dia diem LEN DAU va do that tren truong 2kkn7c6y7l1
    (38 lop / 2 co so): portfolio chon nghiem 1050 tiet / 29 buoi vi pham thay
    vi 1110 tiet / 35 buoi — danh doi 60 tiet de bot 6 buoi vi pham. DU TIET la
    uu tien tuyet doi, no dia diem chi duoc pha the giua hai nghiem xep duoc
    bang nhau. Truong mot co so / khong bat luat luon co loc_debt = 0 nen thu tu
    giong het truoc khi co no.
    """

    obj = tuple(res["objective"])
    loc_debt = int(res.get("location_debt") or 0)
    if focus == "gap1" and len(obj) >= 4:
        # (singleton, gap2, GAP1, sessions, ...) — gap1 xep truoc so buoi
        obj = (obj[0], obj[1], obj[3], obj[2]) + tuple(obj[4:])
    # 22/08 (toi): tiet da CHU DONG dua ve Chua phan (kem ly do) tinh la
    # da xu ly -> seed dat 0 buoi 1 tiet / 0 trong >= 2 nho dua vai tiet ra
    # thang seed giu du tiet nhung con no; sau do moi uu tien xep NHIEU hon.
    handled = int(res["placed"]) + int(res.get("quality_ejected") or 0)
    # 13/09: tiet vi pham "Gioi han buoi day" bi trinh duyet go ve Chua phan ->
    # khong duoc tinh la da xep khi so cac nghiem.
    session_debt = int(res.get("session_debt") or 0)
    handled -= session_debt
    if focus:
        # 25/08: nut mot muc tieu — worker nao KHONG rot tiet so voi luoi
        # xuat phat (warm_placed) thi so CHI SO PHU TRACH truoc, so tiet
        # sau. Truoc day so tiet dung truoc tuyet doi nen worker xep them
        # duoc vai tiet thieu ma trong 1 = 120 thang worker trong 1 = 112.
        base = int((res.get("info") or {}).get("warm_placed") or 0)
        short = max(0, base - handled)
        lead = obj[2] if (focus in ("gap1", "sessions") and len(obj) > 2) else 0
        return (
            short,
            loc_debt,
            0 if res.get("min_ok", True) else 1,
            obj[:2],
            lead,
            -int(res["placed"]),
            obj[2:],
        )
    return (
        -handled,
        session_debt,
        loc_debt,
        0 if res.get("min_ok", True) else 1,
        obj[:2],
        -int(res["placed"]),
        obj[2:],
    )


def _warm_location_baseline(problem: Problem, warm_cells) -> tuple[int | None, list[list[int]] | None]:
    """26/08: moc "lich NGUOI DUNG dang co" cho cong DIA DIEM, tinh o entry.py
    va KHONG phu thuoc nhanh nao ben trong Constructor.

    Vi sao can: `info["warm_location_debt"]` chi duoc ghi o mot nhanh cua
    `_load_state`. Khi lich vao con no luat (dung truong hop can bao ve nhat!)
    Constructor co the tu choi warm-start va xay lai tu dau — luc do `info`
    khong co moc nao, `_location_gate` tra None va cong bien mat. Do that tren
    truong 2kkn7c6y7l1: engine xay lai ra 55 buoi vi pham (moc 35) va van giao
    ra vi khong con ai chan.
    """

    if not warm_cells:
        return None, None
    try:
        from .construct import SoftSchedule

        soft = SoftSchedule(problem)
        for cell in warm_cells:
            c, slot, ai = int(cell[0]), int(cell[1]), int(cell[2])
            soft.set_cell(c, slot, ai)
        return soft.location_debt_session_count(), [row[:] for row in soft.grid]
    except Exception:
        return None, None


def _location_gate(
    best: dict,
    baseline_debt: int | None = None,
    baseline_grid: list[list[int]] | None = None,
    baseline_placed: int | None = None,
) -> dict | None:
    """26/08 (chu du an: "TKB nay co dia diem, khong duoc pha vo cac rang buoc
    dia diem"): yeu cau DIA DIEM cua GV la rang buoc CUNG (``_check_teacher``,
    state.py). Nhung pha tim kiem chi coi no la PHAT MEM va vai nhanh phong ve
    (``_load_state``, ``_lenient_state``) van tra ve luoi con no luat — do la
    duong khien luot Cherry 26/08 tren truong 2 co so ``2kkn7c6y7l1`` day
    35 -> 45 buoi vi pham ma van duoc giao cho trinh duyet.

    Cong nay chay cho MOI luot (ca Cherry lan nut mot muc tieu, khac
    ``_focus_gate`` chi chay khi co focus): ket qua khong bao gio duoc co nhieu
    buoi vi pham hon luoi xuat phat; neu co thi tra lai DUNG luoi xuat phat kem
    ly do. Truong mot co so / khong bat luat luon co ca hai so = 0 nen cong nay
    khong doi gi.
    """

    info = best.get("info") or {}
    # Moc uu tien lay tu Constructor; thieu thi dung moc tinh o entry.py tu
    # chinh warm_cells (luon co khi nguoi dung dang co lich).
    start = info.get("warm_location_debt")
    if not isinstance(start, int):
        start = baseline_debt
    now = best.get("location_debt")
    if not isinstance(start, int) or not isinstance(now, int):
        return None
    verdict: dict[str, Any] = {"start": start, "result": now, "keep_original": False}
    if now <= start:
        return verdict
    warm_grid = info.get("warm_grid")
    if not (isinstance(warm_grid, list) and warm_grid):
        warm_grid = baseline_grid
    if not (isinstance(warm_grid, list) and warm_grid):
        verdict["restore_failed"] = True
        return verdict
    start_placed = info.get("warm_placed")
    if not isinstance(start_placed, int) or start_placed <= 0:
        start_placed = baseline_placed
    if not isinstance(start_placed, int):
        start_placed = sum(1 for row in warm_grid for ai in row if ai >= 0)
    # 26/08 (bai hoc cung ngay): DU TIET la uu tien tuyet doi. Neu ket qua xep
    # duoc NHIEU tiet hon luoi xuat phat thi khong tu y vut no di chi vi no
    # dia diem cao hon — de cong ben trinh duyet quyet dinh.
    result_handled = int(best.get("placed") or 0) + int(best.get("quality_ejected") or 0)
    gained = result_handled - start_placed
    # 26/08 (do that tren 2kkn7c6y7l1): mien tru nay tung cho qua mot luoi
    # +1 TIET nhung +17 BUOI VI PHAM (27 -> 44). "Du tiet la uu tien tuyet doi"
    # KHONG co nghia mot tiet le mua duoc thiet hai dia diem vo han. Chi mien
    # tru khi so buoi vi pham TANG THEM khong vuot qua so tiet xep them.
    if gained > 0 and (now - start) <= gained:
        verdict["kept_for_more_lessons"] = True
        return verdict
    start_q = info.get("warm_quality")
    obj = [int(x) for x in (best.get("objective") or [])]
    best["grid"] = [list(row) for row in warm_grid]
    best["placed"] = start_placed
    if isinstance(start_q, list) and len(start_q) >= 4:
        best["objective"] = [int(x) for x in start_q[:4]] + list(obj[4:5])
    best["quality_ejected"] = 0
    best["location_debt"] = start
    new_info = dict(info)
    new_info["quality_ejected"] = []
    new_info["location_gate_restored"] = True
    best["info"] = new_info
    verdict["keep_original"] = True
    verdict["message"] = "yêu cầu địa điểm tăng %d ➔ %d buổi vi phạm" % (start, now)
    return verdict


def _focus_gate(focus: str, best: dict) -> dict | None:
    """25/08 (chu du an: "toi uu xong thi so do lai tang la khong hop ly"):
    ket qua cua nut mot muc tieu PHAI thoa (so voi luoi xuat phat, do
    Constructor ghi vao info.warm_quality/warm_placed/warm_grid):
      - khong rot tiet (placed + tiet chu dong dua ra >= tiet luoi xuat phat);
      - chi so uu tien CAO HON khong tang (rieng "buoi day" duoc noi dung bang
        so tiet xep THEM, vi moi tiet moi co the mo them 1 buoi);
      - chi so phu trach GIAM THAT; bang nhau chi chap nhan khi xep them tiet.
    Khong thoa -> tra lai DUNG luoi xuat phat kem ly do (bridge giu nguyen lich
    va noi ro), thay vi giao mot lich xau hon de bridge "ap vi xep nhieu tiet
    hon". Luot warm bi tu choi (focus_aborted) cung di duong nay.
    Sua `best` tai cho; tra ve verdict de ghi vao payload."""

    info = best.get("info") or {}
    start_q = info.get("warm_quality")
    warm_grid = info.get("warm_grid")
    if focus not in _FOCUS_INDEX or not isinstance(start_q, list) or len(start_q) < 4:
        return None
    start_placed = int(info.get("warm_placed") or 0)
    idx = _FOCUS_INDEX[focus]
    obj = [int(x) for x in (best.get("objective") or [])]
    aborted = info.get("focus_aborted")
    reasons: list[str] = []
    if aborted:
        reasons.append(_focus_abort_text(str(aborted), start_placed, info))
    elif len(obj) >= 4:
        placed = int(best.get("placed") or 0)
        handled = placed + int(best.get("quality_ejected") or 0)
        gained = handled - start_placed
        if handled < start_placed:
            reasons.append("rớt %d tiết so với lịch hiện tại" % (start_placed - handled))
        for i in range(idx):
            slack = max(0, gained) if i == 2 else 0
            if i == 2 and focus == "gap1":
                # 26/08: cung gia tri voi Constructor._session_cap (mac dinh 0)
                from .construct import _gap1_session_slack

                slack += _gap1_session_slack()
            if obj[i] > int(start_q[i]) + slack:
                reasons.append("%s tăng %d ➔ %d" % (_FOCUS_METRIC_VI[i], start_q[i], obj[i]))
        if obj[idx] > int(start_q[idx]):
            reasons.append("%s tăng %d ➔ %d" % (_FOCUS_METRIC_VI[idx], start_q[idx], obj[idx]))
        elif obj[idx] == int(start_q[idx]) and gained <= 0:
            reasons.append("%s không giảm được thêm (hiện %d)" % (_FOCUS_METRIC_VI[idx], obj[idx]))
    verdict = {
        "focus": focus,
        "start_quality": [int(x) for x in start_q[:4]],
        "start_placed": start_placed,
        "result_quality": obj[:4],
        "keep_original": bool(reasons),
        "reasons": reasons,
        "aborted": str(aborted) if aborted else None,
    }
    if not reasons:
        return verdict
    # 13/09 (chu du an: "giam tu 59 con 13 nhung tra ket qua lai phuc hoi 59"):
    # ket qua cuoi hong hop dong nhung trong luot da gap mot luoi HOP LE dat hop
    # dong (Constructor._offer_focus_candidate) -> giu luoi do, khong vut ve goc.
    from .construct import focus_candidate_acceptable

    cand = info.get("focus_candidate")
    if (
        isinstance(cand, dict)
        and isinstance(cand.get("grid"), list)
        and cand["grid"]
        and focus_candidate_acceptable(focus, start_q, start_placed, cand.get("quality") or [], cand.get("placed") or 0)
    ):
        cand_q = [int(x) for x in (cand.get("quality") or [])]
        best["grid"] = [list(row) for row in cand["grid"]]
        best["placed"] = int(cand["placed"])
        best["objective"] = cand_q[:4] + (cand_q[4:5] or list(obj[4:5]))
        best["quality_ejected"] = 0
        new_info = dict(info)
        new_info["quality_ejected"] = []
        new_info["focus_aborted"] = None
        new_info["focus_fallback"] = {"reasons": list(reasons), "quality": cand_q[:4]}
        best["info"] = new_info
        verdict.update(
            {
                "result_quality": cand_q[:4],
                "keep_original": False,
                "reasons": [],
                "aborted": None,
                "fallback_from": list(reasons),
                "message": "Giữ lịch hợp lệ tốt nhất tìm được trong lượt (kết quả cuối bị loại: %s)" % "; ".join(reasons),
            }
        )
        return verdict
    verdict["message"] = "; ".join(reasons)
    if isinstance(warm_grid, list) and warm_grid:
        best["grid"] = [list(row) for row in warm_grid]
        best["placed"] = start_placed
        best["objective"] = [int(x) for x in start_q[:4]] + list(obj[4:5])
        best["quality_ejected"] = 0
        # 26/08: tra lai luoi xuat phat thi no dia diem cung phai tra ve moc,
        # neu khong payload se bao so cua luoi da bi vut di.
        start_loc = info.get("warm_location_debt")
        if isinstance(start_loc, int):
            best["location_debt"] = start_loc
        new_info = dict(info)
        new_info["quality_ejected"] = []
        new_info["focus_no_gain"] = verdict["message"]
        best["info"] = new_info
    return verdict


def _focus_abort_text(reason: str, start_placed: int, info: Mapping[str, Any]) -> str:
    """Dien giai ly do warm-start bi tu choi cho nguoi dung."""

    r = reason or ""
    if r.startswith("hard:lesson_blocks_min"):
        return "lịch hiện tại còn môn thiếu cặp 2 tiết (thường do còn tiết Chưa phân) nên không tối ưu tại chỗ được"
    if r.startswith("hard:"):
        return "lịch hiện tại vi phạm ràng buộc cứng (%s) nên không tối ưu tại chỗ được" % r[5:]
    if r.startswith("penalty:") or r.startswith("repair_rules"):
        return "lịch hiện tại còn trùng giờ / nợ luật giáo viên chưa gỡ được nên không tối ưu tại chỗ được"
    if r.startswith("too_sparse:"):
        return "lịch hiện tại mới xếp %s tiết — hãy xếp đủ (Cherry) trước rồi mới tối ưu" % r[len("too_sparse:"):]
    if r.startswith("repair_incomplete") or r.startswith("min_block_retile"):
        return "lịch hiện tại thiếu tiết ở nhiều lớp, không sửa cục bộ được nên không tối ưu tại chỗ được"
    if start_placed <= 0:
        return "chưa có lịch để tối ưu — hãy xếp (Cherry) trước"
    return "không tối ưu tại chỗ được (%s)" % r


def solve_from_ui_data_v3(
    ui_data: dict[str, Any],
    settings: dict[str, Any] | None = None,
    *,
    progress: ProgressFn | None = None,
) -> dict[str, Any]:
    from tkb_new.adapter import (
        _extract_hard_fixed_lessons_from_tkb,
        _release_invalid_fixed_lessons,
        _trim_context_to_available_slots,
        _unassigned_from_shortfall,
        build_payload,
        build_school_data_from_ui,
        shared_fixed_teacher_slots,
    )
    from tkb_optimizer_ref.models import Lesson

    settings = dict(settings or {})
    started = time.monotonic()
    total_budget = _solve_deadline_seconds(settings)
    reserve = 4.0 if total_budget > 30 else 2.0

    def report(stage: str, message: str, **extra: Any) -> None:
        if progress is None:
            return
        try:
            progress({"stage": stage, "message": message, **extra})
        except Exception:
            pass

    report("engine_v3:parse", "Dang doc du lieu va rang buoc")
    original_ctx = build_school_data_from_ui(ui_data)
    rules = original_ctx.rules

    # Contract (same as the legacy pipeline): user-locked cells are hard only
    # when the bridge explicitly asks for it; the default one-button fresh
    # solve reflows every lesson (the schedule is a soft incumbent).
    def _flag(value) -> bool:
        return str(value).strip().casefold() in {"1", "true", "on", "yes"}

    preserve_fixed = _flag(settings.get("preserve_fixed_lessons_only")) or _flag(
        ui_data.get("__tkbRequestFixedScheduleOnly")
    )
    fixed_lessons: list = []
    fixed_warnings: list[str] = []
    # 23/08: o co dinh TRUNG GIAO VIEN giua nhieu lop (TNHN thu 2 tiet 1-2 o
    # 31 lop, 9 GV) giu NGUYEN — truoc day bi "mo khoa" (giu 1 lop/GV), engine
    # xep mon khac vao 44 o do -> giao dien bo 44 tiet va tu choi nghiem.
    shared_slots: set[tuple[str, int, str, int]] = set()
    if preserve_fixed:
        fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, original_ctx)
        if fixed_lessons:
            fixed_lessons, release_warnings = _release_invalid_fixed_lessons(
                original_ctx.school_data,
                fixed_lessons,
                rules,
                release_constraint_violations=False,
                release_teacher_duplicates=False,
            )
            fixed_warnings = [*fixed_warnings, *release_warnings]
            shared_slots = shared_fixed_teacher_slots(fixed_lessons)

    if preserve_fixed and fixed_lessons:
        # Same contract as the legacy pipeline: fixed cells are immovable,
        # their demand leaves the capacity trim (which attributes provably
        # impossible leftovers to `Chua phan`), and they come back into the
        # engine as locked grid cells so quality optimization sees them.
        from tkb_new.adapter import (
            _context_without_fixed_lesson_demand,
            _rule_set_with_fixed_lesson_slots,
        )

        rules_eff = _rule_set_with_fixed_lesson_slots(rules, fixed_lessons)
        solver_ctx = _context_without_fixed_lesson_demand(original_ctx, fixed_lessons)
        ctx, capacity_unassigned = _trim_context_to_available_slots(
            solver_ctx, rules_eff, settings, fixed_lessons=fixed_lessons
        )
        problem_ctx = _context_with_fixed_demand(original_ctx, ctx, fixed_lessons)
        payload_ctx = original_ctx
        payload_original = None
    else:
        fixed_lessons = []
        ctx, capacity_unassigned = _trim_context_to_available_slots(original_ctx, rules, settings)
        problem_ctx = ctx
        payload_ctx = ctx
        payload_original = original_ctx

    report("engine_v3:compile", "Dang bien dich bai toan xep lich")
    problem = compile_problem(
        problem_ctx, rules, fixed_lessons, shared_teacher_slots=shared_slots
    )
    # provably impossible teacher load -> Chua phan (with proof), BEFORE solving
    teacher_capacity_unassigned = _teacher_matching_trim(problem, original_ctx)
    if teacher_capacity_unassigned:
        capacity_unassigned = [*capacity_unassigned, *teacher_capacity_unassigned]
        report(
            "engine_v3:capacity",
            "Co %d tiet vuot nang luc giao vien — chuyen vao Chua phan"
            % sum(int(item.get("periods", 0)) for item in teacher_capacity_unassigned),
        )
    expected = sum(problem.a_periods)

    # Warm start: a complete + valid existing schedule becomes the incumbent —
    # the whole budget then improves it, so a re-click can never end up worse.
    warm_cells = None
    _warm_diag = None
    _focus_requested = _requested_quality_focus(settings) is not None
    try:
        from tkb_new.adapter import (
            _extract_fixed_lessons_from_tkb as _extract_all_lessons,
            _build_subject_aliases,
            _canonical_subject,
            _norm,
        )

        existing_lessons, _warm_warnings = _extract_all_lessons(ui_data, original_ctx)
        # Chap nhan ca lich CHUA DU (vi du CP-SAT dua sang thieu vai tiet):
        # Constructor se sua cuc bo thay vi xep lai tu dau.
        warm_floor = max(1, int(expected * 0.8))
        if existing_lessons and len(existing_lessons) >= warm_floor:
            cidx = {n: i for i, n in enumerate(problem.class_names)}
            tidx = {n: i for i, n in enumerate(problem.teacher_names)}
            sidx = {n: i for i, n in enumerate(problem.subject_names)}
            # The bridge may send raw ids/aliases (classId "L001", cell text
            # "HĐTN 1"); resolve them exactly like the adapter grid path does.
            alias_to_subject, _ = _build_subject_aliases(ui_data)
            for entry_cls in original_ctx.classes:
                for alias in (entry_cls.id, entry_cls.name, *entry_cls.aliases):
                    ci = cidx.get(entry_cls.name)
                    if ci is not None:
                        cidx.setdefault(alias, ci)
                        cidx.setdefault(_norm(alias), ci)
            amap = {}
            amap_cs = {}
            for ai in range(problem.num_assignments()):
                amap[(problem.a_class[ai], problem.a_subject[ai], problem.a_teacher[ai])] = ai
                amap_cs.setdefault((problem.a_class[ai], problem.a_subject[ai]), ai)
            cells = []
            used = set()
            ok_map = True
            skipped_no_assignment = 0
            skipped_unmapped = 0
            for lesson in existing_lessons:
                c = cidx.get(lesson.class_name)
                if c is None:
                    c = cidx.get(_norm(lesson.class_name))
                si = sidx.get(lesson.subject)
                if si is None:
                    si = sidx.get(_canonical_subject(lesson.subject, alias_to_subject))
                # 25/08: tiet day ghep "GV1, GV2" -> khoa theo GV dau tien (cung
                # cach compile_problem gan a_teacher), khong tra ca chuoi.
                _members = teacher_members(lesson.teacher)
                ti = tidx.get(_members[0], -1) if _members else -1
                if c is None or si is None:
                    # 25/08: mot tiet khong nhan dien duoc lop/mon (du lieu
                    # lech) truoc day lam CA lich bi bo qua -> xay lai tu dau.
                    # Gio chi bo qua tiet do (dem vao warm_hint).
                    skipped_unmapped += 1
                    continue
                ai = amap.get((c, si, ti))
                if ai is None:
                    # teacher name missing/aliased: any assignment of this
                    # class+subject is the same lesson for warm purposes.
                    ai = amap_cs.get((c, si))
                if ai is None:
                    # 23/08: phan cong nay da bi cat KHOI bai toan (vuot suc
                    # chua -> Chua phan truoc khi giai). Truoc day MOT tiet nhu
                    # vay lam ca lich hien tai bi bo qua (ok_map=False) -> moi
                    # lan bam Cherry xay lai tu dau. Gio chi bo qua tiet do.
                    skipped_no_assignment += 1
                    continue
                d = int(lesson.day) - 2
                part = 0 if lesson.session == "AM" else 1
                p = int(lesson.period) - 1
                if not (0 <= d < 6 and 0 <= p < 5):
                    skipped_unmapped += 1
                    continue
                slot = (d * 2 + part) * 5 + p
                if (c, slot) in used:
                    skipped_unmapped += 1
                    continue
                used.add((c, slot))
                cells.append((c, slot, ai))
            if ok_map and len(cells) >= warm_floor:
                warm_cells = cells
            else:
                _warm_diag = {"ok_map": ok_map, "cells": len(cells), "expected": expected}
                # 25/08: nut mot muc tieu van nhan lich (du thieu nhieu) de
                # Constructor tu quyet toi uu tai cho / bao khong duoc — khong
                # bao gio am tham thanh luot "xep moi".
                if _focus_requested and cells:
                    warm_cells = cells
                    _warm_diag["below_floor"] = True
            if skipped_no_assignment:
                _warm_diag = dict(_warm_diag or {}, skipped_no_assignment=skipped_no_assignment)
            if skipped_unmapped:
                _warm_diag = dict(_warm_diag or {}, skipped_unmapped=skipped_unmapped)
        else:
            _warm_diag = {"extracted": len(existing_lessons or []), "expected": expected}
    except Exception as exc:  # pragma: no cover - defensive
        warm_cells = None
        _warm_diag = {"error": repr(exc)[:200]}
    if warm_cells:
        _warm_diag = dict(_warm_diag or {}, cells=len(warm_cells))

    workers = _num_workers(settings)
    seed = _to_int(settings.get("random_seed"), 0) or (int(time.time()) & 0xFFFF)
    solve_budget = max(6.0, total_budget - (time.monotonic() - started) - reserve)
    # Nut "Toi uu trong 1 tiet" (bridge: optimization_gap_target=gap1) — chi co
    # nghia khi co lich day du de warm-start; nguoc lai chay như binh thuong.
    # 22/08 (dem): menu "Toi uu v3" — moi nut MOT muc tieu rieng le tren lich
    # dang co (khong xep lai, khong vi pham rang buoc, cac chi so khac bi
    # khoa khong duoc xau di): singletons | gap2 | sessions | gap1.
    # 25/08: truoc day chi dat focus KHI warm_cells khong rong -> lich bi tu
    # choi (thieu tiet / khong map duoc) lam nut am tham thanh luot "xep moi"
    # va ket qua xau hon lich nguoi dung. Gio focus luon duoc dat; khong co
    # lich thi Constructor/cong ben duoi tra lai lich cu kem ly do.
    quality_focus = _requested_quality_focus(settings)
    if quality_focus is not None and warm_cells is None:
        warm_cells = []
    # 22/08 (toi): tiet Cherry lan truoc da dua ve Chua phan vi GV van con
    # buoi 1 tiet / trong >= 2 (reason teacher_quality_unreachable) duoc coi la
    # "da xu ly": lich vao thieu dung chung no van la lich DA DU -> moi worker
    # warm-start, va neu lan nay van khong xep lai duoc thi giu nguyen ly do.
    prior_quality_by_key: dict[tuple[str, str, str], dict] = {}
    prior_quality_periods = 0
    try:
        prior_items = (ui_data.get("tkbSolverResult") or {}).get("unassignedLessons") or []
        for item in prior_items:
            if not isinstance(item, dict) or str(item.get("reason") or "") != QUALITY_EJECT_REASON:
                continue
            periods = max(1, _to_int(item.get("periods"), 1))
            prior_quality_periods += periods
            key = (
                str(item.get("className") or ""),
                str(item.get("subject") or ""),
                str(item.get("teacher") or ""),
            )
            prior_quality_by_key.setdefault(key, dict(item))
    except Exception:
        prior_quality_by_key = {}
        prior_quality_periods = 0
    warm_missing_ok = prior_quality_periods if warm_cells else 0
    # Lich vao da du 100% tiet -> moi worker deu tiep tuc tu chinh no.
    warm_all = bool(warm_cells) and len(warm_cells) + warm_missing_ok >= expected
    report(
        "engine_v3:solve",
        f"Dang xep {expected} tiet ({workers} luong song song%s%s)"
        % (
            (", toi uu tiep tu lich hien tai theo bac: 1 tiet/buoi -> khoa -> trong >=2 -> khoa -> buoi day/trong 1"
             if warm_all
             else (", tiep tuc tu lich hien tai" if warm_cells else "")),
            {
                "gap1": ", chi giam trong 1 tiet",
                "gap2": ", chi giam trong >= 2",
                "singletons": ", chi giam buoi 1 tiet",
                "sessions": ", chi giam so buoi day",
            }.get(quality_focus or "", ""),
        ),
        expected=expected,
        workers=workers,
    )
    rounds = _focus_rounds(settings, solve_budget) if quality_focus else _cherry_rounds(settings, solve_budget)
    # 26/08: nut gap1/sessions co toan tu CP-SAT LNS theo cum -> 1 tien trinh x
    # N luong CP-SAT (do: 6 tien trinh x 1 luong deu hoi tu ~90, 1 x 6 luong
    # dat 51-56 vi cac worker khong chia se luoi trong mot vong) va 1 vong
    # (het cac "khoang lang" 28->45 s / 59->82 s luc doi vong). Tat bang
    # settings.focus_cpsat_lns=0 hoac env TKB_CPSAT_LNS=0; so luong bang
    # settings.cpsat_threads / env TKB_CPSAT_THREADS.
    cpsat_threads = 0
    if quality_focus in ("gap1", "sessions") and _cpsat_lane_enabled(settings, problem):
        raw_threads = settings.get("cpsat_threads")
        if raw_threads is None or str(raw_threads).strip() == "":
            raw_threads = os.environ.get("TKB_CPSAT_THREADS", "")
        cpsat_threads = _to_int(raw_threads, 0) or max(1, min(8, os.cpu_count() or 1))
        cpsat_threads = max(1, min(16, cpsat_threads))
        workers = 1
        rounds = 1
    # 01/10 (chu du an: "lam sao nut Cherry lam duoc nhu ban"): nut Cherry dung
    # CP-SAT de lap tiet thieu (lane "fill") + toi uu chat luong sau tabu. CP-SAT
    # 1 luong/worker qua cham (do Hung Long: 4 lan giai / 22 s, khong du tiet)
    # -> giong nut gap1/sessions: 1 tien trinh x N luong CP-SAT. Tat bang env
    # TKB_CHERRY_CPSAT=0 hoac settings.cherry_cpsat=0 (giu portfolio cu).
    cherry_cpsat = False
    _cc_raw = settings.get("cherry_cpsat")
    if (
        quality_focus is None
        and os.environ.get("TKB_CHERRY_CPSAT", "1") != "0"
        and not (_cc_raw is not None and str(_cc_raw).strip().lower() in ("0", "false", "off", "no"))
        and _cpsat_lane_enabled(settings, problem)
        # GV co luat DIA DIEM bi CP-SAT dong bang -> lap tiet/chat luong yeu
        # (do Tan An Hoi 2 co so: 1764/1766 + 8 buoi vi pham doi co so, ban cu
        # 6 worker 1766/1766) -> truong co luat dia diem giu duong cu.
        and not any(getattr(problem, "teacher_loc_rules", None) or [])
    ):
        cherry_cpsat = True
        raw_threads = settings.get("cpsat_threads")
        if raw_threads is None or str(raw_threads).strip() == "":
            raw_threads = os.environ.get("TKB_CPSAT_THREADS", "")
        cpsat_threads = _to_int(raw_threads, 0) or max(1, min(8, os.cpu_count() or 1))
        cpsat_threads = max(1, min(16, cpsat_threads))
        rounds = 1
        # workers giu nguyen: _portfolio_solve chay 2 vong (portfolio heuristic
        # nhieu tien trinh -> 1 tien trinh x cpsat_threads luong CP-SAT).
    # 26/08: chup MOC dia diem cua lich nguoi dung TRUOC khi giai — doc lap voi
    # moi nhanh ben trong Constructor (xem _warm_location_baseline).
    origin_loc_debt, origin_loc_grid = _warm_location_baseline(problem, warm_cells)
    origin_loc_placed = len(warm_cells) if warm_cells else None

    best = _portfolio_solve(
        problem, solve_budget, workers, seed, progress,
        warm_cells=warm_cells, focus=quality_focus, warm_all=warm_all,
        warm_missing_ok=warm_missing_ok, rounds=rounds, cpsat_threads=cpsat_threads,
        cherry_cpsat=cherry_cpsat,
    )

    # ---- 26/08: cong DIA DIEM chay TRUOC va cho MOI luot (Cherry + mot muc
    # tieu): ket qua khong bao gio duoc co nhieu buoi vi pham yeu cau dia diem
    # hon luoi xuat phat.
    location_verdict = _location_gate(best, origin_loc_debt, origin_loc_grid, origin_loc_placed)
    if location_verdict and location_verdict.get("keep_original"):
        report("engine_v3:location_kept", location_verdict.get("message") or "Giu nguyen lich hien tai")

    # ---- 25/08: cong "khong bao gio xau hon moc xuat phat" cho nut mot muc tieu
    focus_verdict = _focus_gate(quality_focus, best) if quality_focus else None
    if focus_verdict and focus_verdict.get("keep_original"):
        report("engine_v3:focus_kept", focus_verdict.get("message") or "Giu nguyen lich hien tai")

    # ---- rebuild lessons from best grid ---------------------------------
    grid = best["grid"]
    lessons: list[Lesson] = []
    for c in range(problem.num_classes()):
        cname = problem.class_names[c]
        grade = problem.class_grades[c]
        for slot in range(NUM_SLOTS):
            ai = grid[c][slot]
            if ai < 0:
                continue
            s, p = divmod(slot, PERIODS)
            d, part = divmod(s, 2)
            lessons.append(
                Lesson(
                    class_name=cname,
                    grade=grade,
                    day=d + 2,
                    session="AM" if part == 0 else "PM",
                    period=p + 1,
                    subject=problem.subject_names[problem.a_subject[ai]],
                    teacher=problem.teacher_label(ai),
                    room=problem.a_room[ai],
                )
            )

    placed = int(best["placed"])
    complete = placed >= expected
    best_info = best.get("info") or {}
    # 22/08 (toi): tiet engine CHU DONG dua ve Chua phan (bac 4) -> tung tiet
    # mang ly do + goi y rieng (teacher_quality_unreachable).
    class_by_name = getattr(original_ctx, "class_by_name", {}) or {}
    quality_unassigned: list[dict[str, Any]] = []
    for item in list(best_info.get("quality_ejected") or []):
        cname = str(item.get("class") or "")
        class_entry = class_by_name.get(cname)
        quality_unassigned.append(
            {
                "classId": getattr(class_entry, "id", cname),
                "className": cname,
                "grade": item.get("grade"),
                "subject": item.get("subject"),
                "teacher": item.get("teacher") or "",
                "room": item.get("room") or "",
                "periods": 1,
                "reason": QUALITY_EJECT_REASON,
                "message": item.get("message") or "",
                "kind": item.get("kind"),
                "day": item.get("day"),
                "session": item.get("session"),
                "period": item.get("period"),
            }
        )
    solver_unassigned: list[dict[str, Any]] = []
    if not complete:
        from collections import Counter as _Counter

        already: _Counter = _Counter()
        for item in [*quality_unassigned, *teacher_capacity_unassigned]:
            already[(
                str(item.get("className") or ""),
                str(item.get("subject") or ""),
                str(item.get("teacher") or ""),
            )] += max(0, _to_int(item.get("periods"), 0))
        for item in _unassigned_from_shortfall(
            problem_ctx,
            lessons,
            reason="engine_v3_best_effort",
            message=(
                "Engine v3 chua xep duoc mot so tiet trong ngan sach thoi gian; "
                "da tra lich best-effort."
            ),
        ):
            key = (
                str(item.get("className") or ""),
                str(item.get("subject") or ""),
                str(item.get("teacher") or ""),
            )
            remain = _to_int(item.get("periods"), 0) - already.get(key, 0)
            if remain <= 0:
                continue
            item = dict(item, periods=remain)
            if key in prior_quality_by_key:
                # Tiet lan truoc da dua ra vi chat luong GV, lan nay xep lai
                # cung khong co cho "sach" -> giu nguyen ly do/goi y/loai cu.
                prior = prior_quality_by_key[key]
                item["reason"] = QUALITY_EJECT_REASON
                item["message"] = str(prior.get("message") or item.get("message") or "")
                for extra in ("kind", "day", "session", "period"):
                    if prior.get(extra) is not None:
                        item[extra] = prior.get(extra)
            solver_unassigned.append(item)
    quality_unassigned_periods = sum(
        _to_int(item.get("periods"), 0)
        for item in [*quality_unassigned, *solver_unassigned]
        if str(item.get("reason") or "") == QUALITY_EJECT_REASON
    )
    other_missing = max(0, expected - placed - quality_unassigned_periods)
    if quality_unassigned_periods:
        report(
            "engine_v3:quality_eject",
            "Da dua %d tiet ve Chua phan de giao vien khong con buoi 1 tiet / trong >= 2 (kem ly do)"
            % quality_unassigned_periods,
        )

    objective = list(best.get("objective") or [])
    elapsed = time.monotonic() - started
    solver_metrics = {
        "session_solver": {
            "solver": ENGINE_NAME,
            "status_name": "OPTIMAL_LOCAL" if (complete or other_missing == 0) else "PARTIAL",
            "seed": best.get("seed"),
            "portfolio": best.get("results_summary"),
        },
        "period_solver": {
            "solver": ENGINE_NAME,
            "lesson_count": len(lessons),
        },
        "engine_v3": {
            "objective": objective,
            "floors": (best.get("info") or {}).get("floors"),
            "feasibility": {
                "attempts": (best.get("info") or {}).get("feasibility_attempts"),
                "seconds": (best.get("info") or {}).get("feasibility_seconds"),
                # 01/10: pha lap tiet thieu bang CP-SAT (construct._cpsat_fill_phase)
                "cpsat_fill": (best.get("info") or {}).get("cpsat_fill"),
                "cpsat_quality": (best.get("info") or {}).get("cpsat_quality"),
            },
            "one_period_sessions": objective[0] if objective else None,
            "gap2_sessions": objective[1] if len(objective) > 1 else None,
            "teacher_sessions": objective[2] if len(objective) > 2 else None,
            "gap1_sessions": objective[3] if len(objective) > 3 else None,
            "teacher_days": objective[4] if len(objective) > 4 else None,
            # 22/08: nhat ky cac bac toi uu co khoa (1 tiet/buoi -> khoa ->
            # trong >=2 -> khoa -> buoi day/trong 1) cua seed thang.
            "stages": (best.get("info") or {}).get("stages"),
            "locks": (best.get("info") or {}).get("locks"),
            "warm_start": bool((best.get("info") or {}).get("warm_start")),
            # 22/08 (toi): bac 4 — tiet dua ve Chua phan vi chat luong GV
            "quality_ejected": quality_unassigned_periods,
            "quality_ejected_items": quality_unassigned[:60],
            "quality_unavoidable": list(best_info.get("quality_unavoidable") or [])[:60],
            "quality_eject_skipped": best_info.get("quality_eject_skipped") or {},
            "reinserted": int(best_info.get("reinserted") or 0),
            "prior_quality_unassigned": prior_quality_periods,
            # chan doan warm-start: vi sao lich vao bi tu choi / phai sua cuc bo
            "warm_start_rejected": bool(best_info.get("warm_start_rejected")),
            "warm_repaired": bool(best_info.get("warm_repaired")),
            "warm_reject_reason": best_info.get("warm_reject_reason"),
            "warm_repair_failed": best_info.get("warm_repair_failed"),
            # 23/08: lich vao thieu N tiet (khong xep duoc) nhung van duoc toi uu tiep
            "warm_incomplete": best_info.get("warm_incomplete"),
            "warm_hint": _warm_diag,
            # 22/08 (dem): menu "Toi uu v3" — muc tieu rieng le cua luot nay
            "quality_focus": quality_focus,
            # 25/08: moc xuat phat + phan quyet cong "khong xau hon moc"
            "warm_quality": best_info.get("warm_quality"),
            "warm_placed": best_info.get("warm_placed"),
            # 26/08: yeu cau dia diem — moc xuat phat, ket qua va phan quyet cong
            "warm_location_debt": (
                best_info.get("warm_location_debt")
                if isinstance(best_info.get("warm_location_debt"), int)
                else origin_loc_debt
            ),
            "location_debt": best.get("location_debt"),
            "location_gate": location_verdict,
            "focus_gate": focus_verdict,
            "focus_no_gain": best_info.get("focus_no_gain"),
            "focus_aborted": best_info.get("focus_aborted"),
            "focus_rounds": best.get("rounds"),
            "used_multiprocessing": best.get("used_multiprocessing"),
            "worker_count": best.get("worker_count"),
            "elapsed_seconds": round(elapsed, 2),
        },
        "runtime_settings": {
            "engine": ENGINE_NAME,
            "overall_time_limit_seconds": total_budget,
            "num_workers": workers,
            "auto_sort_mode": "engine_v3_unified",
            "schedule_unchanged": bool(focus_verdict and focus_verdict.get("keep_original")),
        },
    }

    # Per-run monitor file: exactly what the engine achieved this run
    try:
        # 28/08: ghi vao solver_runtime/logs/ (cung cho voi solve-py-*.json cua
        # solve_stdio.py, da nam trong .gitignore) thay vi thu muc Cherry/ o goc.
        marker_dir = Path(__file__).resolve().parents[2] / "logs"
        marker_dir.mkdir(parents=True, exist_ok=True)
        marker = {
            "engine": ENGINE_NAME,
            "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "elapsed_seconds": round(time.monotonic() - started, 1),
            "expected": expected,
            "placed": placed,
            "objective_singleton_gap2_sessions_gap1_days": objective,
            "warm_start": bool((best.get("info") or {}).get("warm_start")),
            "warm_hint": _warm_diag,
            "stages": (best.get("info") or {}).get("stages"),
            "locks": (best.get("info") or {}).get("locks"),
            "floors": (best.get("info") or {}).get("floors"),
            "feasibility": {
                "attempts": (best.get("info") or {}).get("feasibility_attempts"),
                "seconds": (best.get("info") or {}).get("feasibility_seconds"),
                # 01/10: pha lap tiet thieu bang CP-SAT (construct._cpsat_fill_phase)
                "cpsat_fill": (best.get("info") or {}).get("cpsat_fill"),
                "cpsat_quality": (best.get("info") or {}).get("cpsat_quality"),
            },
            "workers": best.get("worker_count"),
            "used_multiprocessing": best.get("used_multiprocessing"),
            "portfolio": best.get("results_summary"),
            "capacity_unassigned": sum(int(x.get("periods", 0)) for x in capacity_unassigned),
            "quality_ejected": quality_unassigned_periods,
            "quality_ejected_items": quality_unassigned[:60],
            "quality_unavoidable": list(best_info.get("quality_unavoidable") or [])[:60],
            "quality_eject_skipped": best_info.get("quality_eject_skipped") or {},
        }
        (marker_dir / "cherry-last.json").write_text(
            json.dumps(marker, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    except Exception:
        pass

    report("engine_v3:finalize", "Dang kiem dinh va dong goi ket qua")
    payload = build_payload(
        payload_ctx,
        lessons,
        solver_metrics,
        rules,
        unassigned_lessons=[*capacity_unassigned, *quality_unassigned, *solver_unassigned],
        original_ctx=payload_original,
        best_effort=(not complete) or bool(capacity_unassigned),
        deadline_exhausted=other_missing > 0,
        optimization_skipped_reason=None,
        allow_temporary_teacher_gap_debt=True,
        shared_teacher_slots=shared_slots,
    )
    if shared_slots:
        try:
            payload.setdefault("solver", {}).setdefault("engine_v3", {})["shared_fixed_teacher_slots"] = len(
                shared_slots
            )
        except Exception:
            pass
    if fixed_warnings:
        validation = payload.get("validation")
        if isinstance(validation, dict):
            validation.setdefault("warnings", [])
            validation["warnings"] = [*validation["warnings"], *fixed_warnings]
    payload["ok"] = bool(payload.get("metrics", {}).get("hard_ok")) or bool(payload.get("ok"))
    return payload
