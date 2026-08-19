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


def _solve_deadline_seconds(settings: Mapping[str, Any] | None) -> float:
    settings = settings or {}
    candidates = [
        _to_int(settings.get("overall_time_limit_seconds"), 0),
        _to_int(settings.get("optimization_time_limit_seconds"), 0),
        _to_int(settings.get("backend_deadline_ms"), 0) // 1000,
    ]
    positive = [c for c in candidates if c > 0]
    total = min(positive) if positive else 110
    return float(max(10, min(total, 600)))


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
        t = problem.a_teacher[ai]
        if t >= 0:
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


def _num_workers(settings: Mapping[str, Any] | None) -> int:
    requested = _to_int((settings or {}).get("num_workers"), 0)
    cpus = os.cpu_count() or 2
    if requested > 0:
        return max(1, min(requested, cpus, 8))
    return max(1, min(cpus - 1, 6))


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------


def _worker_solve(args) -> dict:
    if len(args) == 5:
        problem, seed, budget_s, warm_cells, focus = args
    else:
        problem, seed, budget_s, warm_cells = args
        focus = None
    started = time.monotonic()
    deadline = started + budget_s
    expected = sum(problem.a_periods)
    constructor = Constructor(problem, seed=seed)
    if focus:
        constructor.quality_focus = focus
    state, info = constructor.solve(deadline, warm_cells=warm_cells)
    result: dict[str, Any] = {
        "seed": seed,
        "expected": expected,
        "min_ok": True,
        "info": info,
    }
    result["placed"] = state.placed
    result["objective"] = state.objective()
    result["grid"] = state.snapshot()
    return result


def _portfolio_solve(
    problem: Problem,
    deadline_s: float,
    workers: int,
    base_seed: int,
    progress: ProgressFn | None,
    warm_cells=None,
    focus: str | None = None,
) -> dict:
    """Multi-seed portfolio bounded by ONE hard wall-clock deadline.

    The pool wait, the sequential fallback and the emergency single attempt
    all share the same absolute deadline — the engine can never run past the
    budget the backend granted (the old code could double it).
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

    results: list[dict] = []
    used_mp = False
    if workers > 1 and remaining() > 15:
        try:
            ctx = multiprocessing.get_context("spawn" if os.name == "nt" else "fork")
            pool = ctx.Pool(processes=workers)
            try:
                worker_budget = max(8.0, remaining() - 4.0)
                args = [
                    (
                        problem,
                        base_seed + 101 * i,
                        worker_budget,
                        # focus (nut toi uu) chi cai thien lich hien tai — moi
                        # worker deu warm-start; mac dinh: nua warm nua fresh.
                        warm_cells
                        if (warm_cells and (focus or i < max(1, workers // 2)))
                        else None,
                        focus,
                    )
                    for i in range(workers)
                ]
                async_result = pool.map_async(_worker_solve, args)
                while True:
                    try:
                        results = async_result.get(timeout=10)
                        used_mp = True
                        break
                    except multiprocessing.TimeoutError:
                        if remaining() < -20:
                            # workers overran their own deadline guard — cut them
                            pool.terminate()
                            results = []
                            break
                        report_heartbeat("%d luong" % workers)
            finally:
                pool.close()
                try:
                    pool.terminate()
                except Exception:
                    pass
        except Exception:
            results = []
    if not results and remaining() > 10:
        # sequential fallback shares the REMAINING time only
        share = max(8.0, remaining() - 2.0)
        report_heartbeat("1 luong du phong")
        results.append(_worker_solve((problem, base_seed, share, warm_cells, focus)))
    if not results:
        # emergency: one very short attempt so the caller always gets a grid
        results.append(_worker_solve((problem, base_seed, 8.0, warm_cells, focus)))

    best = None

    def rank(res: dict) -> tuple:
        obj = tuple(res["objective"])
        if focus == "gap1" and len(obj) >= 4:
            # (singleton, gap2, GAP1, sessions, ...) — gap1 xep truoc so buoi
            obj = (obj[0], obj[1], obj[3], obj[2]) + tuple(obj[4:])
        return (-res["placed"], 0 if res.get("min_ok", True) else 1, obj)

    for res in results:
        if res and (best is None or rank(res) < rank(best)):
            best = res
    assert best is not None
    best["used_multiprocessing"] = used_mp
    best["worker_count"] = workers if used_mp else 1
    best["results_summary"] = [
        {"seed": r["seed"], "placed": r["placed"], "objective": list(r["objective"])}
        for r in results
        if r
    ]
    return best


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------


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
    if preserve_fixed:
        fixed_lessons, fixed_warnings = _extract_hard_fixed_lessons_from_tkb(ui_data, original_ctx)
        if fixed_lessons:
            fixed_lessons, release_warnings = _release_invalid_fixed_lessons(
                original_ctx.school_data,
                fixed_lessons,
                rules,
                release_constraint_violations=False,
            )
            fixed_warnings = [*fixed_warnings, *release_warnings]

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
    problem = compile_problem(problem_ctx, rules, fixed_lessons)
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
            for lesson in existing_lessons:
                c = cidx.get(lesson.class_name)
                if c is None:
                    c = cidx.get(_norm(lesson.class_name))
                si = sidx.get(lesson.subject)
                if si is None:
                    si = sidx.get(_canonical_subject(lesson.subject, alias_to_subject))
                ti = tidx.get(lesson.teacher, -1)
                if c is None or si is None:
                    ok_map = False
                    break
                ai = amap.get((c, si, ti))
                if ai is None:
                    # teacher name missing/aliased: any assignment of this
                    # class+subject is the same lesson for warm purposes.
                    ai = amap_cs.get((c, si))
                if ai is None:
                    ok_map = False
                    break
                d = int(lesson.day) - 2
                part = 0 if lesson.session == "AM" else 1
                p = int(lesson.period) - 1
                if not (0 <= d < 6 and 0 <= p < 5):
                    ok_map = False
                    break
                slot = (d * 2 + part) * 5 + p
                if (c, slot) in used:
                    ok_map = False
                    break
                used.add((c, slot))
                cells.append((c, slot, ai))
            if ok_map and len(cells) >= warm_floor:
                warm_cells = cells
            else:
                _warm_diag = {"ok_map": ok_map, "cells": len(cells), "expected": expected}
        else:
            _warm_diag = {"extracted": len(existing_lessons or []), "expected": expected}
    except Exception as exc:  # pragma: no cover - defensive
        warm_cells = None
        _warm_diag = {"error": repr(exc)[:200]}
    if warm_cells:
        _warm_diag = {"cells": len(warm_cells)}

    workers = _num_workers(settings)
    seed = _to_int(settings.get("random_seed"), 0) or (int(time.time()) & 0xFFFF)
    solve_budget = max(6.0, total_budget - (time.monotonic() - started) - reserve)
    # Nut "Toi uu trong 1 tiet" (bridge: optimization_gap_target=gap1) — chi co
    # nghia khi co lich day du de warm-start; nguoc lai chay như binh thuong.
    quality_focus = None
    _gap_target = str(settings.get("optimization_gap_target") or "").strip().lower()
    if _gap_target in {"gap1", "gap_1", "teacher_gap1_sessions", "optimize_gap1"} and warm_cells:
        quality_focus = "gap1"
    report(
        "engine_v3:solve",
        f"Dang xep {expected} tiet ({workers} luong song song%s%s)"
        % (
            ", tiep tuc tu lich hien tai" if warm_cells else "",
            ", uu tien giam trong 1 tiet" if quality_focus == "gap1" else "",
        ),
        expected=expected,
        workers=workers,
    )
    best = _portfolio_solve(
        problem, solve_budget, workers, seed, progress,
        warm_cells=warm_cells, focus=quality_focus,
    )

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
                    teacher=(
                        problem.teacher_names[problem.a_teacher[ai]]
                        if problem.a_teacher[ai] >= 0
                        else ""
                    ),
                    room=problem.a_room[ai],
                )
            )

    placed = int(best["placed"])
    complete = placed >= expected
    solver_unassigned: list[dict[str, Any]] = []
    if not complete:
        solver_unassigned = _unassigned_from_shortfall(
            problem_ctx,
            lessons,
            reason="engine_v3_best_effort",
            message=(
                "Engine v3 chua xep duoc mot so tiet trong ngan sach thoi gian; "
                "da tra lich best-effort."
            ),
        )

    objective = list(best.get("objective") or [])
    elapsed = time.monotonic() - started
    solver_metrics = {
        "session_solver": {
            "solver": ENGINE_NAME,
            "status_name": "OPTIMAL_LOCAL" if complete else "PARTIAL",
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
            },
            "one_period_sessions": objective[0] if objective else None,
            "gap2_sessions": objective[1] if len(objective) > 1 else None,
            "teacher_sessions": objective[2] if len(objective) > 2 else None,
            "gap1_sessions": objective[3] if len(objective) > 3 else None,
            "teacher_days": objective[4] if len(objective) > 4 else None,
            "used_multiprocessing": best.get("used_multiprocessing"),
            "worker_count": best.get("worker_count"),
            "elapsed_seconds": round(elapsed, 2),
        },
        "runtime_settings": {
            "engine": ENGINE_NAME,
            "overall_time_limit_seconds": total_budget,
            "num_workers": workers,
            "auto_sort_mode": "engine_v3_unified",
        },
    }

    # Per-run monitor file: exactly what the engine achieved this run
    try:
        repo_root = Path(__file__).resolve().parents[3]
        marker_dir = repo_root / "Cherry" / "logs"
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
            "floors": (best.get("info") or {}).get("floors"),
            "feasibility": {
                "attempts": (best.get("info") or {}).get("feasibility_attempts"),
                "seconds": (best.get("info") or {}).get("feasibility_seconds"),
            },
            "workers": best.get("worker_count"),
            "used_multiprocessing": best.get("used_multiprocessing"),
            "portfolio": best.get("results_summary"),
            "capacity_unassigned": sum(int(x.get("periods", 0)) for x in capacity_unassigned),
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
        unassigned_lessons=[*capacity_unassigned, *solver_unassigned],
        original_ctx=payload_original,
        best_effort=(not complete) or bool(capacity_unassigned),
        deadline_exhausted=not complete,
        optimization_skipped_reason=None,
        allow_temporary_teacher_gap_debt=True,
    )
    if fixed_warnings:
        validation = payload.get("validation")
        if isinstance(validation, dict):
            validation.setdefault("warnings", [])
            validation["warnings"] = [*validation["warnings"], *fixed_warnings]
    payload["ok"] = bool(payload.get("metrics", {}).get("hard_ok")) or bool(payload.get("ok"))
    return payload
