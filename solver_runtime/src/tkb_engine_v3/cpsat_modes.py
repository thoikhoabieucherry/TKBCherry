"""Hai che do xep bo sung ben canh engine v3 (mot nut Sap xep).

* ``engine="cpsat"``  — **BE NGUYEN** bo giai Unified CP-SAT cua du an
  TKBCherryAnti (`tkb_optimizer_ref/unified_cpsat_solver.py`). Khong sua thuat
  toan; chi dong goi ket qua qua ``build_payload``/``validate`` de UI hien duoc
  thong ke va bao ro cac rang buoc bi vi pham (neu co).

* ``engine="hybrid"`` — ban **Cherry hop nhat**: van la 2 tang CP-SAT do, nhung
  bo sung dung hai rang buoc ma ban goc bo qua (tiet doi ``lessonBlocks`` va
  tranh tiet 2-3 ``avoidBreakPair23``), sau do giao ket qua cho engine v3 lam
  warm-start de danh bong lan cuoi va kiem dinh day du.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

ProgressFn = Callable[[dict[str, Any]], None]

CPSAT_ENGINE_NAME = "tkb-flash-cpsat"
HYBRID_ENGINE_NAME = "tkb-flash-cpsat"  # giu ten cu cho tuong thich


def _report(progress: ProgressFn | None, stage: str, message: str, **extra: Any) -> None:
    if progress is None:
        return
    try:
        progress({"stage": stage, "message": message, **extra})
    except Exception:
        pass


def _budget(settings: dict[str, Any] | None) -> float:
    settings = settings or {}
    for key in ("overall_time_limit_seconds", "integrated_time_limit", "optimization_time_limit_seconds"):
        try:
            value = float(settings.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return max(20.0, min(1800.0, value))
    return 180.0


def _cherry_subject_rules(ui_data: dict[str, Any]):
    """(cid, mon) -> so cap tiet doi toi thieu; va co tranh tiet 2-3 theo buoi."""

    subject_cfg = ((ui_data.get("tkbConstraints") or {}).get("subject") or {})
    blocks: dict[tuple[str, str], int] = {}
    avoid: dict[tuple[str, str], dict[str, bool]] = {}
    for mon, cfg in subject_cfg.items():
        by_class = ((cfg or {}).get("byClass") or {})
        for cid, rule in by_class.items():
            rule = rule or {}
            lesson_blocks = (rule.get("lessonBlocks") or {}).get("2") or {}
            try:
                minimum = int(lesson_blocks.get("min") or 0)
            except (TypeError, ValueError):
                minimum = 0
            if minimum > 0:
                blocks[(str(cid), str(mon))] = minimum
            pair = rule.get("avoidBreakPair23") or {}
            if pair.get("morning") or pair.get("afternoon"):
                avoid[(str(cid), str(mon))] = {
                    "sang": bool(pair.get("morning")),
                    "chieu": bool(pair.get("afternoon")),
                }
    return blocks, avoid


def _load_base_solver():
    from tkb_optimizer_ref.unified_cpsat_solver import UnifiedCpSatSolver

    return UnifiedCpSatSolver


def build_cherry_solver_class():
    UnifiedCpSatSolver = _load_base_solver()

    class CherryHybridSolver(UnifiedCpSatSolver):
        """CP-SAT 2 tang + tiet doi + tranh tiet 2-3 (phan con thieu cua ban goc)."""

        def _cherry_rules(self):
            cached = getattr(self, "_cherry_rules_cache", None)
            if cached is None:
                cached = _cherry_subject_rules(self.data)
                self._cherry_rules_cache = cached
            return cached

        # --- Tang 1: bat buoc co du so cap tiet doi cho tung (lop, mon) ---
        def _extra_session_constraints(self, model, x_vars):
            blocks, _avoid = self._cherry_rules()
            if not blocks:
                return None
            added = 0
            for aid, act in enumerate(self.assignments):
                need = blocks.get((str(act["classId"]), str(act["mon"])), 0)
                total_periods = int(act.get("totalPeriods", 0))
                # 25/08: min cap doi khong the vuot floor(so tiet / 2) (quick-fill
                # "all" dat min=1 cho ca mon 1 tiet/tuan) -> ha ve muc dat duoc.
                need = min(need, total_periods // 2)
                if need <= 0 or total_periods < 2:
                    continue
                indicators = []
                for (day, buoi) in self.class_sessions.get(act["classId"], []):
                    key = (aid, day, buoi)
                    if key not in x_vars:
                        continue
                    ind = model.NewBoolVar(f"cherry_blk2_{aid}_{day}_{buoi}")
                    model.Add(x_vars[key] >= 2).OnlyEnforceIf(ind)
                    model.Add(x_vars[key] <= 1).OnlyEnforceIf(ind.Not())
                    indicators.append(ind)
                if indicators:
                    model.Add(sum(indicators) >= min(need, len(indicators)))
                    added += 1
            return added

        # --- Tang 2: mot mon khong duoc chiem ca tiet 2 va tiet 3 trong buoi ---
        def _extra_period_constraints(self, model, p_vars, acts, day, buoi):
            _blocks, avoid = self._cherry_rules()
            if not avoid:
                return None
            groups: dict[tuple[str, str], list[int]] = defaultdict(list)
            for idx, act in enumerate(acts):
                groups[(str(act["classId"]), str(act["mon"]))].append(idx)
            for (cid, mon), idxs in groups.items():
                flags = avoid.get((cid, mon))
                if not flags or not flags.get(buoi):
                    continue
                # cac tiet co dinh cung mon da chiem san
                const = 0
                for period in (1, 2):
                    info = self.class_fixed_slots.get((cid, day, buoi, period))
                    if info and str(info.get("mon") or "") == mon:
                        const += 1
                terms = []
                for idx in idxs:
                    duration = int(acts[idx].get("duration", 1) or 1)
                    for start_p in range(0, 5 - duration + 1):
                        var = p_vars.get((idx, start_p))
                        if var is None:
                            continue
                        cover = set(range(start_p, start_p + duration))
                        weight = (1 if 1 in cover else 0) + (1 if 2 in cover else 0)
                        if weight:
                            terms.append(weight * var)
                if terms:
                    model.Add(sum(terms) + const <= 1)
            return True

    return CherryHybridSolver


def _tkb_from_result(result: dict[str, Any]) -> dict[str, Any] | None:
    tkb = result.get("tkb") if isinstance(result, dict) else None
    return tkb if isinstance(tkb, dict) and tkb else None


def _write_marker(name: str, payload: dict[str, Any]) -> None:
    try:
        marker_dir = Path(__file__).resolve().parents[3] / "Flash" / "logs"
        marker_dir.mkdir(parents=True, exist_ok=True)
        (marker_dir / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    except Exception:
        pass


def solve_unified_cpsat(
    ui_data: dict[str, Any],
    settings: dict[str, Any] | None = None,
    *,
    progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """Nut TIA SET: chay dung bo giai cua TKBCherryAnti, khong sua gi."""

    from tkb_new.adapter import (
        build_school_data_from_ui,
        build_payload,
        _extract_fixed_lessons_from_tkb,
        _unassigned_from_shortfall,
    )

    settings = settings or {}
    started = time.monotonic()
    budget = _budget(settings)
    UnifiedCpSatSolver = _load_base_solver()

    _report(progress, "cpsat:start", "Dang chay thuat toan CP-SAT (ban goc)")
    try:
        solver = UnifiedCpSatSolver(
            ui_data,
            settings={**settings, "time_limit_seconds": int(budget)},
        )
        result = solver.solve(progress=progress)
        tkb = _tkb_from_result(result)
    except Exception as exc:
        import traceback as _tb
        _write_marker(
            "flash-last.json",
            {
                "engine": CPSAT_ENGINE_NAME,
                "stage": "FALLBACK_DIRECT",
                "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "error": repr(exc)[:400],
                "traceback": _tb.format_exc()[-2000:],
            },
        )
        result = None
        tkb = None

    if not tkb:
        from tkb_new.adapter import solve_from_ui_data
        _report(progress, "cpsat:direct", "Dang toi uu toan dien bang CP-SAT da luong (6 vCPU)")
        direct = solve_from_ui_data(ui_data, {**settings, "solver_mode": "auto"}, progress=progress)
        if isinstance(direct, dict):
            direct.setdefault("solver", {}).setdefault("runtime_settings", {})[
                "flash_stage"
            ] = "cpsat_empty_then_legacy"
        return direct

    ctx = build_school_data_from_ui(ui_data)
    seeded = dict(ui_data)
    seeded["tkb"] = tkb
    seeded.pop("tkbSolverResult", None)
    seeded.pop("__tkbRequestFixedScheduleOnly", None)
    lessons, warnings = _extract_fixed_lessons_from_tkb(seeded, ctx)
    expected = sum(item.periods_per_week for item in ctx.school_data.assignments)
    complete = len(lessons) >= expected

    elapsed = round(time.monotonic() - started, 2)
    metrics = {
        "session_solver": {"solver": CPSAT_ENGINE_NAME, "status_name": "CP_SAT"},
        "period_solver": {"solver": CPSAT_ENGINE_NAME, "lesson_count": len(lessons)},
        "unified_cpsat": {
            "placed": result.get("placed"),
            "tsBuoiDay": result.get("tsBuoiDay"),
            "soBuoiDay1": result.get("soBuoiDay1"),
            "soBuoiTrong2": result.get("soBuoiTrong2"),
            "soBuoiTrong1": result.get("soBuoiTrong1"),
            "iterations": result.get("iterations"),
            "elapsed_seconds": elapsed,
        },
        "runtime_settings": {
            "engine": CPSAT_ENGINE_NAME,
            "overall_time_limit_seconds": budget,
            "auto_sort_mode": "unified_cpsat_raw",
            "flash_stage": "cpsat_only",
        },
    }
    _write_marker(
        "flash-last.json",
        {
            "engine": CPSAT_ENGINE_NAME,
            "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "elapsed_seconds": elapsed,
            "expected": expected,
            "placed": len(lessons),
            "raw": metrics["unified_cpsat"],
        },
    )
    _report(progress, "cpsat:finalize", "Dang kiem dinh ket qua CP-SAT")
    unassigned = (
        []
        if complete
        else _unassigned_from_shortfall(
            ctx,
            lessons,
            reason="unified_cpsat_best_effort",
            message=(
                "Thuat toan CP-SAT (ban goc) chua xep duoc cac tiet nay trong "
                "ngan sach thoi gian."
            ),
        )
    )
    payload = build_payload(
        ctx,
        lessons,
        metrics,
        ctx.rules,
        unassigned_lessons=unassigned,
        best_effort=not complete,
        deadline_exhausted=not complete,
        allow_temporary_teacher_gap_debt=True,
    )
    if warnings:
        validation = payload.get("validation")
        if isinstance(validation, dict):
            validation.setdefault("warnings", [])
            validation["warnings"] = [*validation["warnings"], *warnings]
    payload["ok"] = bool(payload.get("metrics", {}).get("hard_ok")) or bool(payload.get("ok"))

    payload_metrics = payload.get("metrics") or {}
    violations = int(payload_metrics.get("app_constraint_violation_count") or 0)
    hard_ok = payload_metrics.get("hard_ok")
    if complete and hard_ok is not False and violations == 0:
        return payload

    # 19/08 (chi dao chu du an): NUT FLASH = THUAT TOAN CUA TKBCherryAnti.
    # Ban goc chi co dung mot buoc: UnifiedCpSatSolver(...).solve(). Truoc day
    # o day tu dong giao tiep cho engine v3 khi lich cua CP-SAT vi pham rang
    # buoc rieng cua truong (tiet doi / tranh tiet 2-3) — nghia la nguoi dung
    # bam Flash nhung nhan ket qua cua Cherry ma khong he hay biet.
    # Mac dinh tu gio: TRA VE dung ket qua cua CP-SAT kem canh bao. Ai muon
    # engine v3 don not thi bat settings.flash_repair_with_engine_v3.
    repair_flag = settings.get("flash_repair_with_engine_v3")
    repair_with_v3 = str(repair_flag if repair_flag is not None else "").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not repair_with_v3:
        runtime = payload.setdefault("solver", {}).setdefault("runtime_settings", {})
        runtime["engine"] = CPSAT_ENGINE_NAME
        runtime["auto_sort_mode"] = "unified_cpsat_raw"
        runtime["flash_stage"] = "cpsat_only_best_effort"
        runtime["flash_cpsat_violations"] = violations
        runtime["flash_incomplete"] = not complete
        note = (
            "Thuat toan CP-SAT (ban goc TKBCherryAnti) da chay xong: xep %d/%d tiet"
            % (len(lessons), expected)
        )
        if violations:
            note += ", con %d rang buoc rieng cua truong bi vi pham" % violations
        note += ". Bat 'flash_repair_with_engine_v3' neu muon engine v3 don not."
        validation = payload.get("validation")
        if isinstance(validation, dict):
            validation.setdefault("warnings", [])
            validation["warnings"] = [*validation["warnings"], note]
        _report(progress, "cpsat:done", note)
        return payload

    # Ban goc khong biet luat tiet doi / tranh tiet 2-3 cua truong, nen lich cua
    # no co the vi pham. Khong tra loi cho nguoi dung: giao lai cho engine v3
    # hoan tat mot lich HOP LE, con so goc cua CP-SAT van duoc ghi vao marker
    # va vao payload de doi chieu.
    _report(
        progress,
        "cpsat:repair",
        "CP-SAT goc vi pham %d rang buoc cua truong — engine v3 hoan tat lich hop le"
        % violations,
    )
    from .entry import solve_from_ui_data_v3

    remaining = max(30.0, budget - (time.monotonic() - started) - 5.0)
    fixed_payload = solve_from_ui_data_v3(
        seeded,
        {**settings, "overall_time_limit_seconds": remaining, "integrated_time_limit": remaining},
        progress=progress,
    )
    solver_block = fixed_payload.get("solver")
    if isinstance(solver_block, dict):
        # Nhan nay nam trong runtime_settings nen chac chan di theo ket qua ve
        # trinh duyet: nhin la biet Flash da chay CP-SAT truoc roi moi giao cho
        # engine v3 hoan tat, chu khong phai "Flash chay y het Cherry".
        solver_block.setdefault("runtime_settings", {})["flash_stage"] = "cpsat_then_engine_v3"
        solver_block.setdefault("runtime_settings", {})["flash_cpsat_violations"] = violations
        solver_block["unified_cpsat_raw"] = {
            **metrics["unified_cpsat"],
            "app_constraint_violations": violations,
            "note": "So lieu cua thuat toan CP-SAT nguyen ban truoc khi engine v3 hoan tat",
        }
    validation = fixed_payload.get("validation")
    if isinstance(validation, dict):
        validation.setdefault("warnings", [])
        validation["warnings"] = [
            *validation["warnings"],
            "Thuat toan CP-SAT nguyen ban xep du %d tiet (buoi %s, 1 tiet %s, trong1 %s) nhung vi pham %d rang buoc tiet doi/tranh tiet 2-3; engine v3 da hoan tat mot lich hop le."
            % (
                len(lessons),
                result.get("tsBuoiDay"),
                result.get("soBuoiDay1"),
                result.get("soBuoiTrong1"),
                violations,
            ),
        ]
    return fixed_payload
