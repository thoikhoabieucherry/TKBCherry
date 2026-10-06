"""07/10: tha tu do tiet chung nhieu lop truoc luot Cherry.

Chu du an (THCS An Phu kkhg52etp92): "toi muon ban fix ko co dinh nhu vay nua
khi xep, cu bam cherry la 2 tiet do lai co dinh". Trinh duyet (phanmon.js
``tkbJointPinForSolve``) ghim TAM moi dong Day ghep >= 2 lop vao cung o o moi
lop vi engine xep tung lop rieng; dong thieu tiet thi lay o chung DAU TIEN (thu
2, sang, tiet nho) — engine coi la o co dinh nen khong bao gio doi duoc (An Phu:
KNS/STEM 6A2-4 ket o sang T2 tiet 3-4, chan co Vy chi ranh sang T2 + chieu T3).

Bridge gui ``settings.cherry_joint_movable`` = cac khoa dong ghep dang ghim TAM
(khong gom o nguoi dung tu co dinh). Buoc nay:

1. bien dich bai toan voi cac nhom do TU DO (``core.compile_problem(joint_groups=)``:
   lop dau mang GV, cac lop con lai khong GV, ``Problem.joint_sync``);
2. dung luoi tu lich hien tai (o co dinh khac van khoa) va giai CP-SAT lane
   ``fill`` (tiet chua xep tren het, roi chat luong GV) cho ca truong, buoc ca
   nhom cung o (``cpsat_lns``);
3. ket qua chi duoc nhan khi khong trung gio, khong them no luat GV, khong bot
   tiet va (xep them tiet hoac chat luong tot hon) — roi VIET LAI lich dau vao:
   tiet chung o vi tri moi (van ghim cho phan con lai cua luot), cac tiet khac
   theo luoi CP-SAT. Luot Cherry binh thuong chay tiep tren lich do.

Tat: env ``TKB_JOINT_FREE=0`` hoac ``settings.cherry_joint_free=0``.
"""

from __future__ import annotations

import copy
import os
import time
from typing import Any, Callable, Iterable, Mapping

from .core import NUM_SLOTS, PERIODS, compile_problem

_DAY_KEYS = ("thu2", "thu3", "thu4", "thu5", "thu6", "thu7")


def movable_joint_keys(settings: Mapping[str, Any] | None) -> list[str]:
    """Khoa dong ghep bridge cho phep dời (settings.cherry_joint_movable)."""

    settings = settings or {}
    raw = settings.get("cherry_joint_movable")
    if isinstance(raw, str):
        raw = [part for part in raw.split("|")]
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[str] = []
    for item in raw:
        key = str(item or "").strip()
        if key and key not in out:
            out.append(key)
    return out


def joint_free_enabled(settings: Mapping[str, Any] | None) -> bool:
    if os.environ.get("TKB_JOINT_FREE", "1") == "0":
        return False
    raw = (settings or {}).get("cherry_joint_free")
    if raw is not None and str(raw).strip().lower() in ("0", "false", "off", "no"):
        return False
    return True


def joint_groups_from_fixed(
    fixed_lessons: Iterable[Any], keys: Iterable[str]
) -> list[tuple[str, list[str], tuple[tuple[int, str, int], ...]]]:
    """Nhom o ghim cua cac dong ghep ``keys``: (mon, [lop], (ngay, buoi, tiet)...).

    Nhom = cac lop co CUNG mon va CUNG tap o ghim (ghim cua trinh duyet luon dong
    bo). Nhieu dong ghep co the chung mot khoa (An Phu: 4 dong "TANN (ghép)" —
    6A1-4, 7B, 8B, 9B — moi dong mot o rieng) -> moi tap o la mot nhom. Chi nhan
    nhom >= 2 lop.
    """

    wanted = {str(k).strip().casefold() for k in keys if str(k).strip()}
    by_subject: dict[str, dict[str, set[tuple[int, str, int]]]] = {}
    for lesson in fixed_lessons or ():
        subject = str(getattr(lesson, "subject", "") or "")
        if subject.strip().casefold() not in wanted:
            continue
        slot = (int(lesson.day), str(lesson.session), int(lesson.period))
        by_subject.setdefault(subject, {}).setdefault(str(lesson.class_name), set()).add(slot)
    groups: list[tuple[str, list[str], tuple[tuple[int, str, int], ...]]] = []
    for subject, per_class in by_subject.items():
        by_slots: dict[frozenset, list[str]] = {}
        for cname, slots in per_class.items():
            by_slots.setdefault(frozenset(slots), []).append(cname)
        for slots, classes in by_slots.items():
            if len(classes) >= 2:
                groups.append((subject, sorted(classes), tuple(sorted(slots))))
    groups.sort(key=lambda g: (g[0], g[2], g[1]))
    return groups


def _slot_of(day: int, session: str, period: int) -> int:
    part = 0 if str(session) == "AM" else 1
    return ((int(day) - 2) * 2 + part) * PERIODS + (int(period) - 1)


def _lex_better(a: tuple, b: tuple) -> bool:
    return tuple(a) < tuple(b)


def relocate_joint_lessons(
    *,
    ui_data: Mapping[str, Any],
    settings: Mapping[str, Any],
    problem_ctx: Any,
    original_ctx: Any,
    rules: Any,
    fixed_lessons: list[Any],
    problem: Any,
    warm_cells: list[tuple[int, int, int]] | None,
    time_limit: float,
    threads: int,
    seed: int = 0,
    stop_check: Callable[[], bool] | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Giai lai ca truong voi tiet chung tu do. Tra (ui_data_moi | None, info)."""

    from tkb_new.adapter import shared_fixed_teacher_slots

    from . import cpsat_lns
    from .construct import SoftSchedule

    t0 = time.monotonic()
    keys = movable_joint_keys(settings)
    info: dict[str, Any] = {"keys": keys, "moved": [], "status": "skipped"}
    if not keys:
        info["reason"] = "no_keys"
        return None, info
    groups = joint_groups_from_fixed(fixed_lessons, keys)
    info["groups"] = [
        {"subject": s, "classes": cls, "slots": [list(x) for x in slots]} for s, cls, slots in groups
    ]
    if not groups:
        info["reason"] = "no_pinned_groups"
        return None, info
    if not warm_cells:
        info["reason"] = "no_schedule"
        return None, info
    if not cpsat_lns.available():
        info["reason"] = "cpsat_unavailable"
        return None, info

    # chi o ghim CUA NHOM duoc tha (o nguoi dung co dinh cung khoa — vd dong ghep
    # mot lop "TANN (ghép)" 6B1 — van khoa)
    grouped: set[tuple[str, str, tuple[int, str, int]]] = {
        (cname, subject, slot) for subject, cls, slots in groups for cname in cls for slot in slots
    }
    fixed_free = [
        l for l in fixed_lessons
        if (str(l.class_name), str(l.subject), (int(l.day), str(l.session), int(l.period))) not in grouped
    ]
    shared_free = shared_fixed_teacher_slots(fixed_free)
    # Cat suc chua LAI khi tiet chung khong con ghim: o ghim tam lam tiet khac
    # "khong con o" va bi dua ve Chua phan TRUOC khi giai (An Phu: 2 tiet Van 6A2
    # co Vy — sang T2 cua 6A2 kin HDTN 1/2 + KNS + STEM) -> CP-SAT phai thay cac
    # tiet do thi moi co ly do doi tiet chung.
    free_ctx = problem_ctx
    try:
        from tkb_new.adapter import (
            _context_without_fixed_lesson_demand,
            _rule_set_with_fixed_lesson_slots,
            _trim_context_to_available_slots,
        )

        from .entry import _context_with_fixed_demand

        if fixed_free:
            rules_eff = _rule_set_with_fixed_lesson_slots(rules, fixed_free)
            solver_ctx = _context_without_fixed_lesson_demand(original_ctx, fixed_free)
            trimmed, _cap = _trim_context_to_available_slots(solver_ctx, rules_eff, dict(settings), fixed_lessons=fixed_free)
            free_ctx = _context_with_fixed_demand(original_ctx, trimmed, fixed_free)
        else:
            free_ctx, _cap = _trim_context_to_available_slots(original_ctx, rules, dict(settings))
    except Exception as exc:  # noqa: BLE001 - giu ngu canh cu
        info["ctx_error"] = repr(exc)[:200]
    P = compile_problem(
        free_ctx,
        rules,
        fixed_free,
        shared_teacher_slots=shared_free,
        joint_groups=[(s, cls) for s, cls, _slots in groups],
    )
    if not P.joint_sync:
        info["reason"] = "no_sync_groups"
        return None, info
    info["sync_groups"] = len(P.joint_sync)

    # -- luoi xuat phat: o co dinh khac (khoa) + lich hien tai ----------------
    sidx = {n: i for i, n in enumerate(P.subject_names)}
    cs_map: dict[tuple[int, int], int] = {}
    for ai in range(P.num_assignments()):
        cs_map.setdefault((P.a_class[ai], P.a_subject[ai]), ai)
    soft = SoftSchedule(P)
    for c, slot, ai in P.fixed_cells:
        if soft.grid[c][slot] == -1:
            soft.set_cell(c, slot, ai)
            soft.locked[c][slot] = 1
    used = [0] * P.num_assignments()
    for row in soft.grid:
        for v in row:
            if v >= 0:
                used[v] += 1
    # tiet chung dat DUNG o dang ghim (lich nguoi dung vua keo) truoc lich warm —
    # warm co the la ket qua luot truoc (tkbSolverResult) voi tiet chung o cho cu.
    cidx0 = {n: i for i, n in enumerate(P.class_names)}
    for subject, cls, slots in groups:
        si = sidx.get(subject)
        for cname in cls:
            c = cidx0.get(cname)
            ai = cs_map.get((c, si)) if (c is not None and si is not None) else None
            if ai is None:
                continue
            for slot_t in slots:
                x = _slot_of(*slot_t)
                if 0 <= x < NUM_SLOTS and soft.grid[c][x] == -1 and used[ai] < P.a_periods[ai]:
                    soft.set_cell(c, x, ai)
                    used[ai] += 1
    for c, slot, ai0 in warm_cells:
        if not (0 <= c < P.num_classes()) or soft.grid[c][slot] != -1:
            continue
        si = sidx.get(problem.subject_names[problem.a_subject[ai0]])
        ai = cs_map.get((c, si)) if si is not None else None
        if ai is None or used[ai] >= P.a_periods[ai]:
            continue
        soft.set_cell(c, slot, ai)
        used[ai] += 1
    # nhom phai dong bo ngay tu luoi xuat phat (CP-SAT bac khi lech hang so)
    for group in P.joint_sync:
        pos = [frozenset(x for x in range(NUM_SLOTS) if soft.grid[P.a_class[ai]][x] == ai) for ai in group]
        if len(set(pos)) != 1:
            info["reason"] = "start_out_of_sync"
            return None, info
    soft.enable_quality_tracking()
    for t in range(P.num_teachers()):
        soft.refresh_rule_pen(t)

    def _placed() -> int:
        return sum(1 for row in soft.grid for v in row if v >= 0)

    placed0, pen0, overlap0, q0 = _placed(), int(soft.penalty()), int(soft.overlap), soft.quality()
    info["start"] = {"placed": placed0, "penalty": pen0, "overlap": overlap0, "quality": list(q0)}
    if overlap0 > 0:
        info["reason"] = "start_overlap"
        return None, info

    whole_max = max(1, int(os.environ.get("TKB_CPSAT_WHOLE_MAX_CLASSES", "40") or 40))
    scope = list(range(P.num_classes()))
    if len(scope) > whole_max:
        # truong lon: lop cua nhom + lop cung GV voi nhom (cap whole_max)
        member_classes = {P.a_class[ai] for g in P.joint_sync for ai in g}
        teachers = {t for g in P.joint_sync for ai in g for t in P.a_teachers[ai]}
        near = sorted(
            {P.a_class[ai] for ai in range(P.num_assignments()) if set(P.a_teachers[ai]) & teachers}
            - member_classes
        )
        scope = sorted(member_classes) + near[: max(0, whole_max - len(member_classes))]
    info["scope_classes"] = len(scope)
    # Mac dinh: GIU moi tiet dang xep (require_full) va chi toi thieu tiet thieu
    # — giong lan giai toan truong cua _cpsat_fill_phase: do An Phu 28 lop, ban
    # gop chat luong 45-150 s dao dong 867-868, khong gian tim qua rong.
    keep_all = os.environ.get("TKB_JOINT_FREE_KEEP", "1") != "0"
    fill_quality = os.environ.get("TKB_JOINT_FREE_QUALITY", "0") == "1"
    info["mode"] = {"keep_all": keep_all, "fill_quality": fill_quality}

    new_cells, cinfo = cpsat_lns.build_and_solve(
        P,
        soft,
        scope,
        "fill",
        time_limit=max(1.0, float(time_limit)),
        workers=max(1, int(threads)),
        seed=int(seed),
        stop_check=stop_check,
        require_improve=False,
        fill_quality=fill_quality,
        frozen_teachers=[],
        loc_soft=False,
        require_full=keep_all,
    )
    info["cpsat"] = {
        k: cinfo.get(k)
        for k in ("status", "build_s", "solve_s", "unplaced", "joint_sync", "dropped_classes", "error")
        if k in cinfo
    }
    if new_cells is None:
        info["status"] = "no_solution"
        info["seconds"] = round(time.monotonic() - t0, 2)
        return None, info
    cpsat_lns.apply_cells(soft, new_cells)
    for t in range(P.num_teachers()):
        soft.refresh_rule_pen(t)
    placed1, pen1, overlap1, q1 = _placed(), int(soft.penalty()), int(soft.overlap), soft.quality()
    info["result"] = {"placed": placed1, "penalty": pen1, "overlap": overlap1, "quality": list(q1)}
    synced = True
    for group in P.joint_sync:
        pos = [tuple(x for x in range(NUM_SLOTS) if soft.grid[P.a_class[ai]][x] == ai) for ai in group]
        if len(set(pos)) != 1:
            synced = False
            break
    better = placed1 > placed0 or (placed1 == placed0 and _lex_better(q1[:4], q0[:4]))
    accept = synced and overlap1 == 0 and pen1 <= pen0 and placed1 >= placed0 and better
    info["seconds"] = round(time.monotonic() - t0, 2)
    if not accept:
        info["status"] = "rejected"
        info["reason"] = (
            "out_of_sync" if not synced
            else "overlap" if overlap1
            else "rule_debt" if pen1 > pen0
            else "fewer_lessons" if placed1 < placed0
            else "not_better"
        )
        return None, info

    # vi tri moi THEO TUNG NHOM (nhieu nhom co the chung khoa, vd 4 dong "TANN (ghép)")
    for subject, cls, slots in groups:
        old = tuple(sorted(_slot_of(*x) for x in slots))
        c = cidx0.get(cls[0])
        si = sidx.get(subject)
        ai = cs_map.get((c, si)) if (c is not None and si is not None) else None
        if ai is None:
            continue
        new = tuple(x for x in range(NUM_SLOTS) if soft.grid[c][x] == ai)
        if new != old:
            info["moved"].append({"subject": subject, "classes": list(cls), "from": list(old), "to": list(new)})
    info["status"] = "accepted"

    # -- viet lai lich dau vao ---------------------------------------------
    sync_ais = {ai for g in P.joint_sync for ai in g}
    grouped_cells = {
        (cname, _slot_of(*slot)) for subject, cls, slots in groups for cname in cls for slot in slots
    }
    new_ui = copy.deepcopy(dict(ui_data))
    raw_tkb = new_ui.get("tkb") if isinstance(new_ui.get("tkb"), dict) else {}
    cidx = {n: i for i, n in enumerate(P.class_names)}
    name_of_raw: dict[str, int] = {}
    try:
        from tkb_new.adapter import _norm

        for entry in original_ctx.classes:
            ci = cidx.get(entry.name)
            if ci is None:
                continue
            for alias in (entry.id, entry.name, *entry.aliases):
                name_of_raw.setdefault(_norm(alias), ci)
    except Exception:  # pragma: no cover - adapter thieu ham
        _norm = lambda v: str(v).strip().casefold()  # noqa: E731
    session_len = {"sang": 0, "chieu": 0}
    for tkb in raw_tkb.values():
        if not isinstance(tkb, dict):
            continue
        for dk in _DAY_KEYS:
            day_obj = tkb.get(dk)
            if isinstance(day_obj, dict):
                for b in ("sang", "chieu"):
                    arr = day_obj.get(b)
                    if isinstance(arr, list):
                        session_len[b] = max(session_len[b], len(arr))
    for raw_id, tkb in raw_tkb.items():
        if not isinstance(tkb, dict):
            continue
        c = name_of_raw.get(_norm(raw_id))
        if c is None:
            continue
        for d, dk in enumerate(_DAY_KEYS):
            day_obj = tkb.get(dk)
            for part, b in enumerate(("sang", "chieu")):
                arr = day_obj.get(b) if isinstance(day_obj, dict) else None
                if not isinstance(arr, list):
                    continue
                for p in range(len(arr)):
                    v = arr[p]
                    if v == "OFF":
                        continue
                    x = (d * 2 + part) * PERIODS + p
                    if isinstance(v, dict) and v.get("fixed") and (P.class_names[c], x) not in grouped_cells:
                        continue  # o nguoi dung co dinh: giu nguyen
                    arr[p] = ""
                    if p >= PERIODS:
                        continue
                    ai = soft.grid[c][x]
                    if ai < 0:
                        continue
                    subject = P.subject_names[P.a_subject[ai]]
                    if ai in sync_ais:
                        arr[p] = {"mon": subject, "fixed": True, "jointPin": True}
                    else:
                        arr[p] = subject
    stored = new_ui.get("tkbSolverResult")
    if isinstance(stored, dict) and "lessons" in stored:
        # lich luu cua luot truoc khong con khop lich vua viet lai
        new_ui["tkbSolverResult"] = {k: v for k, v in stored.items() if k != "lessons"}
    return new_ui, info
