"""CP-SAT "cluster LNS" neighbourhood solver for engine v3 (26/08).

Mot lan goi = mot vung lan can: MOI o KHONG KHOA cua K lop (cluster) duoc xep
lai bang CP-SAT; moi thu khac (lop ngoai cluster, o co dinh/khoa, tiet cua GV
"dong bang") la HANG SO. Loi giai tra ve chi gom o cua cluster, so tiet moi
phan cong giu nguyen (dense: moi o tu do deu duoc gan lai).

Hop dong chat luong (tinh tren tap GV bi cham - "touched"), so voi luoi vao:
  * buoi 1 tiet (SG)  <= hien tai   (moi lane)
  * buoi trong >= 2 (G2) <= hien tai (moi lane)
  * lane "gap1":     so buoi day S <= hien tai, buoi trong 1 G1 <= hien tai - 1
  * lane "sessions": S <= hien tai - 1
(``require_improve=False`` bo dieu kien "-1" nhung van khong xau hon.)
GV khong bi cham co thong ke khong doi, nen "khong xau hon tren touched" ==
"khong xau hon toan truong". Cong hau kiem cua nguoi goi (penalty()==0,
_lock_violated, _load_state/State.full_recheck) van la trong tai cuoi cung.

Rang buoc cung duoc ma hoa 1-1 voi bo kiem tra cua engine:
  checks.check_class_session   (checks.py 14-83)   - suc chua/buoi, lien tiet,
        maxPeriods buoi, linkedDays, tranh cap 2-3 / 3-4 (mien tru o co dinh),
        no_same_session, luat nhom mon (max_subjects_part, session_part_cap)
  checks.check_class_subject_week (checks.py 98-140) - 1 buoi/ngay, tuan sang/
        chieu, tran ngay, so buoi toi da, gian cach ngay, lessonBlocks min/max
  checks.check_class_day       (checks.py 143-160)  - no_same_day
  State._write_cell            (state.py 121-146)   - trung gio, MOI thanh vien
        cua tiet day ghep (P.a_teachers)
  State.apply                  (state.py 448-451)   - P.a_allowed
  State._check_teacher         (state.py 203-306)   - must_teach, oneSessionPerDay
        (session_mode), tran tiet/ngay, tran tiet/buoi, tiet 5 sang + tiet 1
        chieu, max ngay/buoi/sang/chieu, tran tiet theo lop (class_period_caps)
  State._check_time_limits     (state.py 308-397)   - gioi han so lop/GV/phong/
        mon khac nhau tai mot o / mot buoi (timeLimit + globalLimit/groupLimit)
  State._session_contrib       (state.py 88-99)     - thong ke buoi (bang tra 32
        dong tren 5 bit chiem cho)

Khong ma hoa duoc -> KHONG bao gio lieu:
  * Luat DIA DIEM cua GV (P.teacher_loc_rules): GV bi DONG BANG (tiet la hang
    so ca trong cluster) - dem o info["frozen_teachers"].
  * Truong TeacherRule / SubjectRule la (chua biet, khac mac dinh): GV dong
    bang / lop bi loai khoi cluster (info["dropped_classes"]).
  * Hai phan cong cung mon trong mot lop (vd o co dinh dung chung + phan cong
    thuong): dung chung mot "mon" neu cung suc chua + luat va chi mot phan
    cong con o tu do; nguoc lai loai lop.

Gioi han dung som: ``stop_check`` chi duoc hoi trong solution callback (va
truoc khi giai). CP-SAT chay tren luong goi; khi chua co loi giai nao thi
khong co diem hoi -> lan giai keo dai toi ``time_limit``. Ortools chi duoc
import ben trong ham (module nay import duoc khi khong co ortools).
"""

from __future__ import annotations

import collections
import collections.abc
import dataclasses
import os
import time
import traceback
from typing import Any, Callable, Iterable

from .core import NUM_DAYS, NUM_SESSIONS, NUM_SLOTS, PERIODS

# 01/10: "fill" — vung LAP TIET THIEU: o trong (class_avail) cua cum cung la bien,
# tiet con thieu cua phan cong trong cum duoc phep dat vao; muc tieu chinh la
# giam so tiet chua xep (truong 0 o du: THCS Hung Long 1207 tiet / 1207 o).
LANES = ("gap1", "sessions", "fill")

# Truong TeacherRule ma model ma hoa duoc (core.py 184-206). Truong khac co gia
# tri khac mac dinh -> GV dong bang.
_TEACHER_FIELDS_ENCODED = frozenset(
    {
        "max_days",
        "max_sessions",
        "max_morning",
        "max_afternoon",
        "session_mode",
        "day_period_cap",
        "session_period_cap",
        "no_m5_a1",
        "class_period_caps",
        # dia diem: xu ly bang dong bang theo P.teacher_loc_rules (State chi
        # kiem khi co do bat), khong phai theo co luat.
        "loc_one",
        "loc_gap",
        "loc_move",
        "loc_breaks",
    }
)
# Truong SubjectRule ma model ma hoa duoc (core.py 79-94). part_banned da nam
# trong P.a_allowed (core.py 586-587); max_subjects_part chi co y nghia o luat
# nhom (checks.py 61-74).
_SUBJECT_FIELDS_ENCODED = frozenset(
    {
        "part_banned",
        "one_session_per_day",
        "weekly_part_cap",
        "day_cap",
        "session_part_cap",
        "max_sessions_week",
        "spacing_days",
        "avoid23",
        "avoid34",
        "linked_avoided",
        "lesson_blocks",
        "max_subjects_part",
    }
)

_TL_FIELDS: tuple[tuple[str, int], ...] = (("classes", 0), ("teachers", 1), ("rooms", 2), ("subjects", 3))


def available() -> bool:
    """True khi co ortools CP-SAT va bien moi truong TKB_CPSAT_LNS != "0"."""

    if os.environ.get("TKB_CPSAT_LNS", "1") == "0":
        return False
    try:
        from ortools.sat.python import cp_model  # noqa: F401
    except Exception:
        return False
    return True


# ---------------------------------------------------------------------------
# thong ke buoi (state.py State._session_contrib 88-99, thu tu S, SG, G1, G2)
# ---------------------------------------------------------------------------


def _mask_stats(mask: int) -> tuple[int, int, int, int]:
    """(nonempty, singleton, gap1, gap2) cua mot buoi tu 5 bit chiem cho."""

    occ = [(mask >> p) & 1 for p in range(PERIODS)]
    cnt = sum(occ)
    if cnt == 0:
        return (0, 0, 0, 0)
    first = min(p for p in range(PERIODS) if occ[p])
    last = max(p for p in range(PERIODS) if occ[p])
    gap = last - first + 1 - cnt
    return (1, 1 if cnt == 1 else 0, 1 if gap == 1 else 0, 1 if gap >= 2 else 0)


def _session_rows() -> list[tuple[int, ...]]:
    rows = []
    for mask in range(1 << PERIODS):
        occ = tuple((mask >> p) & 1 for p in range(PERIODS))
        rows.append((*occ, *_mask_stats(mask)))
    return rows


_ROWS = _session_rows()


def _unknown_rule_fields(rule: Any, known: frozenset[str]) -> list[str]:
    """Ten truong (ngoai ``known``) co gia tri khac mac dinh cua dataclass rule."""

    try:
        fields = dataclasses.fields(rule)
    except TypeError:
        return []
    out: list[str] = []
    for f in fields:
        if f.name in known:
            continue
        if f.default is not dataclasses.MISSING:
            default = f.default
        elif f.default_factory is not dataclasses.MISSING:  # type: ignore[misc]
            default = f.default_factory()  # type: ignore[misc]
        else:
            default = None
        if getattr(rule, f.name, default) != default:
            out.append(f.name)
    return out


def _a_teachers(P: Any) -> list[tuple[int, ...]]:
    lst = getattr(P, "a_teachers", None)
    if lst:
        return lst
    return [((t,) if t >= 0 else ()) for t in P.a_teacher]


# ---------------------------------------------------------------------------
# timeLimit: khop phan cong voi dich cua luat (state.py _matched_lessons_at
# 339-370 + _in_group 372-380) va tra cuu gioi han (state.py _limit_for_slot
# 383-397, _check_time_limits 308-337)
# ---------------------------------------------------------------------------


def _tl_keys(P: Any, a_teachers: list[tuple[int, ...]], ai: int) -> tuple[str, str, str, str]:
    tnames = tuple(P.teacher_names[t] for t in a_teachers[ai])
    return (
        P.class_names[P.a_class[ai]],
        tnames[0] if tnames else "",
        P.a_room[ai] if ai < len(P.a_room) else "",
        P.subject_names[P.a_subject[ai]],
    )


def _tl_matches(P: Any, a_teachers: list[tuple[int, ...]], rule: Any, ai: int) -> bool:
    target_type = str(rule.get("targetType") or "")
    target_id = str(rule.get("targetId") or "")
    cname, tname, room, sname = _tl_keys(P, a_teachers, ai)
    tnames = tuple(P.teacher_names[t] for t in a_teachers[ai])
    if target_type == "class":
        return cname == target_id
    if target_type == "teacher":
        return target_id in tnames
    if target_type == "subject":
        return sname == target_id
    if target_type == "room":
        return bool(room) and room == target_id
    if target_type in {"subjectGroup", "teacherGroup", "classGroup", "roomGroup"}:
        groups = getattr(P, "_raw_groups", None)
        if groups is None:
            return False
        kind = {"subjectGroup": "subject", "teacherGroup": "teacher", "classGroup": "class", "roomGroup": "room"}[target_type]
        items = groups.get(kind, {}).get(target_id, frozenset())
        value = {"subject": sname, "teacher": tname, "class": cname, "room": room}[kind]
        return value in items
    return False


def _tl_session_limit(rule: Any, field_name: str) -> int:
    from .core import _to_int

    per_session = rule.get("perSession", {})
    if not isinstance(per_session, collections.abc.Mapping):
        return 0
    return _to_int(per_session.get(field_name), 0)


def _tl_slot_limit(rule: Any, field_name: str, d: int, part: int) -> int:
    from .state import State

    return State._limit_for_slot(rule, field_name, d, part)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def build_and_solve(
    P: Any,
    soft: Any,
    classes: Iterable[int],
    lane: str,
    *,
    time_limit: float,
    workers: int,
    seed: int = 0,
    stop_check: Callable[[], bool] | None = None,
    frozen_teachers: Iterable[int] | None = None,
    require_improve: bool = True,
    log: bool = False,
    sessions: Iterable[int] | None = None,
    full_classes: Iterable[int] | None = None,
    fill_quality: bool = True,
) -> tuple[dict[tuple[int, int], int] | None, dict[str, Any]]:
    """Xep lai cac o tu do cua ``classes`` bang CP-SAT theo hop dong ``lane``.

    Tra ve (new_cells, info): new_cells = {(lop, o): phan cong} cho MOI o tu do
    cua cluster, hoac None (khong co loi giai cai thien / du lieu khong ma
    hoa duoc -> info["error"]). Khong bao gio nem loi vi du lieu.

    ``sessions`` (11/09): neu cho, CHI cac o thuoc nhung buoi nay (0..11, buoi =
    o // PERIODS) la tu do; o cua lop trong cluster o buoi khac la hang so.
    Dung cho vung lan can "nguyen buoi toan truong" (classes = moi lop, 2 buoi):
    tiet trong / buoi le cua GV nam rai o nhieu lop trong CUNG mot buoi, vung
    theo cum lop khong voi toi duoc.
    """

    t0 = time.monotonic()
    info: dict[str, Any] = {
        "status": "NOT_RUN",
        "build_s": 0.0,
        "solve_s": 0.0,
        "choice_vars": 0,
        "tables": 0,
        "touched_teachers": 0,
        "classes": 0,
        "free_cells": 0,
        "cur_touched": [0, 0, 0, 0],
        "timeline": [],
        "pruned": {},
        "frozen_teachers": 0,
        "dropped_classes": [],
        "lane": lane,
    }
    if lane not in LANES:
        info["error"] = "unknown lane %r" % (lane,)
        return None, info
    try:
        from ortools.sat.python import cp_model
    except Exception as exc:  # pragma: no cover - moi truong khong co ortools
        info["status"] = "UNAVAILABLE"
        info["error"] = "ortools unavailable: %r" % (exc,)
        return None, info
    try:
        return _build_and_solve(
            cp_model,
            P,
            soft,
            classes,
            lane,
            float(time_limit),
            int(workers),
            int(seed),
            stop_check,
            frozen_teachers,
            bool(require_improve),
            bool(log),
            info,
            t0,
            sessions,
            full_classes,
            fill_quality,
        )
    except Exception as exc:  # du lieu la -> bao loi, khong nem
        info["status"] = "ERROR"
        info["error"] = "%s: %s" % (type(exc).__name__, exc)
        info["traceback"] = traceback.format_exc()[-2000:]
        return None, info


def _build_and_solve(
    cp_model: Any,
    P: Any,
    soft: Any,
    classes: Iterable[int],
    lane: str,
    time_limit: float,
    workers: int,
    seed: int,
    stop_check: Callable[[], bool] | None,
    frozen_teachers: Iterable[int] | None,
    require_improve: bool,
    log: bool,
    info: dict[str, Any],
    t0: float,
    sessions: Iterable[int] | None = None,
    full_classes: Iterable[int] | None = None,
    fill_quality: bool = True,
) -> tuple[dict[tuple[int, int], int] | None, dict[str, Any]]:
    C = P.num_classes()
    # 01/10: lop trong full_classes tu do o MOI buoi ke ca khi co ``sessions``
    # (lap tiet thieu: ca tuan cua lop thieu + buoi nghen cua toan truong).
    full_set: set[int] = {int(c) for c in (full_classes or ())}
    sess_set: set[int] | None = None
    if sessions is not None:
        sess_set = {int(s) for s in sessions if 0 <= int(s) < NUM_SESSIONS}
        info["sessions"] = sorted(sess_set)
        if not sess_set:
            info["error"] = "empty sessions"
            return None, info
    T = P.num_teachers()
    A = P.num_assignments()
    a_teachers = _a_teachers(P)
    grid = soft.grid
    locked = soft.locked
    fixed_mask = getattr(P, "fixed_mask", None) or None
    pruned: collections.Counter = collections.Counter()
    info["pruned"] = pruned

    CL: list[int] = []
    for c in classes:
        c = int(c)
        if 0 <= c < C and c not in CL:
            CL.append(c)
    if not CL:
        info["error"] = "empty cluster"
        return None, info
    cl_set = set(CL)

    # -- GV dong bang -------------------------------------------------------
    frozen: set[int] = set()
    frozen_reasons: dict[int, str] = {}
    for t in frozen_teachers or ():
        t = int(t)
        if 0 <= t < T:
            frozen.add(t)
            frozen_reasons[t] = "caller"
    loc_rules = getattr(P, "teacher_loc_rules", None) or []
    for t in range(T):
        # state.py 243-260: luat dia diem chi kiem khi P.teacher_loc_rules[t]
        if t < len(loc_rules) and loc_rules[t]:
            frozen.add(t)
            frozen_reasons.setdefault(t, "location_rules")
        rule = P.teacher_rules[t]
        if rule is not None:
            unknown = _unknown_rule_fields(rule, _TEACHER_FIELDS_ENCODED)
            if unknown:
                frozen.add(t)
                frozen_reasons.setdefault(t, "teacher_rule_fields:" + ",".join(unknown))

    def _is_const(c: int, x: int, ai: int) -> bool:
        if locked[c][x]:
            return True
        if fixed_mask is not None and fixed_mask[c][x]:
            return True
        for t in a_teachers[ai]:
            if t in frozen:
                return True
        return False

    # -- o tu do + so tiet con lai cua tung phan cong ----------------------
    free_by_class: dict[int, set[int]] = {}
    residual = [0] * A
    for c in CL:
        cells: set[int] = set()
        row = grid[c]
        for x in range(NUM_SLOTS):
            ai = row[x]
            if ai < 0 or _is_const(c, x, ai):
                continue
            if sess_set is not None and (x // PERIODS) not in sess_set and c not in full_set:
                continue
            if P.a_class[ai] != c:
                info["error"] = "cell (%d,%d) holds assignment %d of another class" % (c, x, ai)
                return None, info
            cells.add(x)
            residual[ai] += 1
        free_by_class[c] = cells

    # 01/10 lane "fill": them o TRONG cua lop (class_avail, khong khoa) va so
    # tiet CON THIEU cua tung phan cong trong cum (khong tinh phan cong co GV
    # dong bang — tiet do la hang so, khong dat duoc).
    fill = lane == "fill"
    missing_add = [0] * A
    if fill:
        class_avail = getattr(P, "class_avail", None) or []
        placed_cnt = [0] * A
        for c in range(C):
            for ai in grid[c]:
                if ai >= 0:
                    placed_cnt[ai] += 1
        for c in CL:
            avail = class_avail[c] if c < len(class_avail) else None
            row = grid[c]
            for x in range(NUM_SLOTS):
                if row[x] >= 0 or locked[c][x]:
                    continue
                if avail is not None and not avail[x]:
                    continue
                if fixed_mask is not None and fixed_mask[c][x]:
                    continue
                if sess_set is not None and (x // PERIODS) not in sess_set and c not in full_set:
                    continue
                free_by_class[c].add(x)
        for ai in range(A):
            if P.a_class[ai] not in cl_set:
                continue
            miss = int(P.a_periods[ai]) - placed_cnt[ai]
            if miss <= 0 or any(t in frozen for t in a_teachers[ai]):
                continue
            missing_add[ai] = miss
            residual[ai] += miss

    # -- loai lop khong ma hoa duoc ----------------------------------------
    dropped: dict[int, str] = {}
    by_class_subject: dict[int, dict[int, list[int]]] = {c: {} for c in CL}
    for ai in range(A):
        c = P.a_class[ai]
        if c in cl_set:
            by_class_subject[c].setdefault(P.a_subject[ai], []).append(ai)
    for c in CL:
        for si, lst in by_class_subject[c].items():
            variable = [ai for ai in lst if residual[ai] > 0]
            if not variable:
                continue
            av = variable[0]
            rule = P.a_rule[av]
            if rule is not None:
                unknown = _unknown_rule_fields(rule, _SUBJECT_FIELDS_ENCODED)
                if unknown:
                    dropped[c] = "subject_rule_fields:" + ",".join(unknown)
                    break
            if len(variable) > 1:
                # checks.py 26-32 gop moi phan cong cung mon -> hai khoi bien
                # cung buoi phai lien tiet chung: khong ma hoa
                dropped[c] = "duplicate_subject_variable:%d" % si
                break
            if len(lst) > 1 and any(P.a_cap[o] != P.a_cap[av] or P.a_rule[o] != P.a_rule[av] for o in lst):
                # checks.py 34-36 lay suc chua/luat cua phan cong o tiet cuoi
                dropped[c] = "duplicate_subject_rule_mismatch:%d" % si
                break
    kept = [c for c in CL if c not in dropped]
    info["dropped_classes"] = sorted((c, reason) for c, reason in dropped.items())
    info["classes"] = len(kept)
    if not kept:
        info["error"] = "all classes dropped"
        return None, info
    kept_set = set(kept)
    free: set[tuple[int, int]] = set()
    for c in kept:
        for x in free_by_class[c]:
            free.add((c, x))
    for c in dropped:
        for x in free_by_class[c]:
            if grid[c][x] >= 0:
                residual[grid[c][x]] -= 1
    if fill:
        for ai in range(A):
            if missing_add[ai] and P.a_class[ai] in dropped:
                residual[ai] -= missing_add[ai]
                missing_add[ai] = 0
        info["missing_before"] = sum(missing_add)
    info["free_cells"] = len(free)
    if not free:
        info["error"] = "no free cells"
        return None, info
    ais_var = [ai for ai in range(A) if P.a_class[ai] in kept_set and residual[ai] > 0]
    var_of: dict[tuple[int, int], int] = {(P.a_class[ai], P.a_subject[ai]): ai for ai in ais_var}
    touched: set[int] = set()
    for ai in ais_var:
        touched.update(a_teachers[ai])
    touched -= frozen  # (khong the xay ra: phan cong co GV dong bang la hang so)
    info["touched_teachers"] = len(touched)
    info["frozen_teachers"] = len(frozen)
    info["frozen_reasons"] = {int(t): r for t, r in sorted(frozen_reasons.items())}

    # -- hang so: chiem cho GV, o hang so theo (lop, mon, buoi) --------------
    const_occ: dict[tuple[int, int], int] = {}
    const_periods: dict[tuple[int, int, int], set[int]] = {}
    cur_occ: dict[int, list[int]] = {t: [0] * NUM_SESSIONS for t in touched}
    const_cells_at: list[list[tuple[int, int]]] = [[] for _ in range(NUM_SLOTS)]
    for c in range(C):
        row = grid[c]
        in_cluster = c in kept_set
        for x in range(NUM_SLOTS):
            ai = row[x]
            if ai < 0:
                continue
            s, p = divmod(x, PERIODS)
            for t in a_teachers[ai]:
                if t in touched:
                    cur_occ[t][s] |= 1 << p
            if in_cluster and (c, x) in free:
                continue
            for t in a_teachers[ai]:
                const_occ[(t, x)] = 1
            const_cells_at[x].append((c, ai))
            if in_cluster:
                const_periods.setdefault((c, P.a_subject[ai], s), set()).add(p)
    cur_free: dict[tuple[int, int], list[int]] = {}
    for c, x in free:
        cur_free.setdefault((grid[c][x], x // PERIODS), []).append(x % PERIODS)
    for key in cur_free:
        cur_free[key].sort()

    m = cp_model.CpModel()
    free_cover: dict[tuple[int, int], list[tuple[Any, int]]] = {key: [] for key in free}
    teacher_terms: dict[tuple[int, int], list[Any]] = collections.defaultdict(list)
    # (lop, GV, buoi) -> [(so tiet, bien, mon)] cho class_period_caps
    class_teacher_terms: dict[tuple[int, int, int], list[tuple[int, Any, int]]] = collections.defaultdict(list)
    blocks: dict[tuple[int, int], list[tuple[Any, tuple[int, ...], int, tuple[int, ...]]]] = {}
    unplaced_vars: dict[int, Any] = {}
    block_short: list[Any] = []
    n_choice = 0

    # -- bien chon khoi: (phan cong, buoi, cua so lien tiet) ----------------
    for av in ais_var:
        c = P.a_class[av]
        si = P.a_subject[av]
        cap = P.a_cap[av]
        rule = P.a_rule[av]
        r = residual[av]
        allowed = P.a_allowed[av]
        members = a_teachers[av]
        fmask = fixed_mask[c] if fixed_mask is not None else None
        total_terms = []
        for s in range(NUM_SESSIONS):
            base = s * PERIODS
            part = s % 2
            const = const_periods.get((c, si, s), set())
            cur = tuple(cur_free.get((av, s), ()))
            for n in range(1, min(cap, PERIODS) + 1):
                for p0 in range(0, PERIODS - n + 1):
                    window = range(p0, p0 + n)
                    if not const <= set(window):
                        pruned["const"] += 1
                        continue
                    blk = tuple(q for q in window if q not in const)
                    d = len(blk)
                    if d == 0 or d > r:
                        continue
                    ok = True
                    for q in blk:
                        x = base + q
                        if (c, x) not in free or not allowed[x]:
                            ok = False
                            break
                        for t in members:
                            if const_occ.get((t, x)):
                                ok = False
                                break
                        if not ok:
                            break
                    if not ok:
                        pruned["cell"] += 1
                        continue
                    # checks.py 38-53: suc chua (n <= cap qua vong lap), lien
                    # tiet (cua so), luat mon trong buoi
                    if rule is not None:
                        pc = rule.session_part_cap[part]
                        if pc > 0 and n > pc:
                            pruned["rule"] += 1
                            continue
                        if rule.linked_avoided[s] and n > 1:
                            pruned["rule"] += 1
                            continue
                        pset = set(window)
                        if rule.avoid23[part] and 1 in pset and 2 in pset and not (
                            fmask is not None and fmask[base + 1] and fmask[base + 2]
                        ):
                            pruned["rule"] += 1
                            continue
                        if rule.avoid34[part] and 2 in pset and 3 in pset and not (
                            fmask is not None and fmask[base + 2] and fmask[base + 3]
                        ):
                            pruned["rule"] += 1
                            continue
                    v = m.NewBoolVar("b%d_%d_%d_%d" % (av, s, n, p0))
                    n_choice += 1
                    for q in blk:
                        x = base + q
                        free_cover[(c, x)].append((v, av))
                        for t in members:
                            teacher_terms[(t, x)].append(v)
                    for t in members:
                        class_teacher_terms[(c, t, s)].append((d, v, si))
                    blocks.setdefault((av, s), []).append((v, tuple(window), d, blk))
                    total_terms.append(d * v)
                    m.AddHint(v, 1 if blk == cur else 0)
        if fill:
            # so tiet KHONG xep duoc cua phan cong (muc tieu chinh cua lane)
            u = m.NewIntVar(0, r, "u%d" % av)
            unplaced_vars[av] = u
            if total_terms:
                m.Add(sum(total_terms) + u == r)
            else:
                m.Add(u == r)
            m.AddHint(u, max(0, missing_add[av]))
        else:
            if not total_terms:
                info["error"] = "assignment %d has no candidate block" % av
                return None, info
            m.Add(sum(total_terms) == r)
        for s in range(NUM_SESSIONS):
            lst = blocks.get((av, s))
            if lst and len(lst) > 1:
                m.AddAtMostOne(v for v, _u, _d, _b in lst)
    info["choice_vars"] = n_choice

    for key, lst in free_cover.items():
        if fill:
            # lane fill: o duoc phep de trong (tiet chua xep tinh o unplaced_vars)
            if len(lst) > 1:
                m.AddAtMostOne(v for v, _av in lst)
            continue
        if not lst:
            info["error"] = "free cell %s has no candidate" % (key,)
            return None, info
        m.AddExactlyOne(v for v, _av in lst)

    # -- bieu thuc muc mon (lop, mon, buoi) ---------------------------------
    def pres(c: int, si: int, s: int) -> Any:
        if const_periods.get((c, si, s)):
            return 1
        av = var_of.get((c, si))
        lst = blocks.get((av, s)) if av is not None else None
        return sum(v for v, _u, _d, _b in lst) if lst else 0

    def dur(c: int, si: int, s: int) -> Any:
        const = len(const_periods.get((c, si, s), ()))
        av = var_of.get((c, si))
        lst = blocks.get((av, s)) if av is not None else None
        return const + (sum(d * v for v, _u, d, _b in lst) if lst else 0)

    def is_var(c: int, si: int, s: int) -> bool:
        if const_periods.get((c, si, s)):
            return False
        av = var_of.get((c, si))
        return bool(av is not None and blocks.get((av, s)))

    day_pres_cache: dict[tuple[int, int, int], Any] = {}

    def day_pres(c: int, si: int, d: int) -> Any:
        """1 khi mon co mat trong ngay d (sang hoac chieu) - checks.py 143-160."""

        key = (c, si, d)
        if key in day_pres_cache:
            return day_pres_cache[key]
        s_am, s_pm = 2 * d, 2 * d + 1
        if const_periods.get((c, si, s_am)) or const_periods.get((c, si, s_pm)):
            out: Any = 1
        else:
            exprs = [pres(c, si, s) for s in (s_am, s_pm) if is_var(c, si, s)]
            if not exprs:
                out = 0
            else:
                dv = m.NewBoolVar("dp%d_%d_%d" % (c, si, d))
                for e in exprs:
                    m.Add(dv >= e)
                out = dv
        day_pres_cache[key] = out
        return out

    def _blocks_now(c: int, si: int, length: int) -> int:
        """So buoi lop c dang co >= length tiet cua mon si (luoi vao)."""

        n_blk = 0
        row = grid[c]
        for s_ in range(NUM_SESSIONS):
            b0 = s_ * PERIODS
            cnt = sum(1 for q in range(PERIODS) if row[b0 + q] >= 0 and P.a_subject[row[b0 + q]] == si)
            if cnt >= length:
                n_blk += 1
        return n_blk

    # -- luat tuan cua mon (checks.py check_class_subject_week 98-140) ------
    for av in ais_var:
        rule = P.a_rule[av]
        if rule is None:
            continue
        c = P.a_class[av]
        si = P.a_subject[av]
        if rule.one_session_per_day:  # checks.py 113-116
            for d in range(NUM_DAYS):
                if is_var(c, si, 2 * d) or is_var(c, si, 2 * d + 1):
                    m.Add(pres(c, si, 2 * d) + pres(c, si, 2 * d + 1) <= 1)
        for part in range(2):  # checks.py 117-121
            capw = rule.weekly_part_cap[part]
            if capw > 0:
                m.Add(sum(dur(c, si, s) for s in range(part, NUM_SESSIONS, 2)) <= capw)
        for d in range(NUM_DAYS):  # checks.py 122-126
            capd = rule.day_cap[d]
            if capd > 0 and (is_var(c, si, 2 * d) or is_var(c, si, 2 * d + 1)):
                m.Add(dur(c, si, 2 * d) + dur(c, si, 2 * d + 1) <= capd)
        if rule.max_sessions_week > 0:  # checks.py 127-128
            m.Add(sum(pres(c, si, s) for s in range(NUM_SESSIONS)) <= rule.max_sessions_week)
        if rule.spacing_days > 0:  # checks.py 129-133 (moi cap ngay <=> cap ke nhau)
            for d1 in range(NUM_DAYS):
                for d2 in range(d1 + 1, NUM_DAYS):
                    if d2 - d1 <= rule.spacing_days:
                        m.Add(day_pres(c, si, d1) + day_pres(c, si, d2) <= 1)
        for length, minimum, maximum in rule.lesson_blocks:  # checks.py 134-140
            terms: list[Any] = []
            for s in range(NUM_SESSIONS):
                lst = blocks.get((av, s), [])
                const = const_periods.get((c, si, s), ())
                if lst:
                    long_blocks = [v for v, u, _d, _b in lst if len(u) >= length]
                    if long_blocks:
                        terms.append(sum(long_blocks))
                    if len(const) >= length:
                        terms.append(1 - sum(v for v, _u, _d, _b in lst))
                elif len(const) >= length:
                    terms.append(1)
            if minimum > 0:
                if fill and av in unplaced_vars:
                    # 01/10 lane fill: lich DO DANG duoc hoan "tiet doi toi thieu"
                    # (nhu defer_min cua pha 1/2) CHI khi mon con tiet chua xep, hoac
                    # luoi vao da thieu san -> mon xep du thi luat van cung. Thieu
                    # dong nay mo hinh VO NGHIEM (do truong 61 lop: GDTC 2 tiet chi
                    # chieu, min 1 tiet doi, chua xep tiet nao -> 85/97 lan INFEASIBLE).
                    viol0 = 1 if _blocks_now(c, si, length) < minimum else 0
                    short = m.NewIntVar(0, minimum, "lbs%d_%d" % (av, length))
                    m.Add(sum(terms) + short >= minimum)
                    m.Add(short <= unplaced_vars[av] + viol0 * minimum)
                    # thieu cap bi PHAT ngang mot tiet chua xep: chi con lai khi
                    # khong the tao cap trong vung (khong phai vi solver luoi).
                    block_short.append(short)
                else:
                    m.Add(sum(terms) >= minimum)
            if maximum > 0:
                m.Add(sum(terms) <= maximum)

    # -- luat muc lop (checks.py 54-74, 143-160) -----------------------------
    subject_groups = getattr(P, "subject_groups", None) or {}
    group_rule_keys = getattr(P, "group_rule_keys", None) or {}
    for c in kept:
        subjects_here = set(by_class_subject[c].keys())
        for g in P.no_same_session[c]:  # checks.py 54-60
            members_g = [si for si in subjects_here if si in g]
            for s in range(NUM_SESSIONS):
                if any(is_var(c, si, s) for si in members_g):
                    m.Add(sum(pres(c, si, s) for si in members_g) <= 1)
        for g in P.no_same_day[c]:  # checks.py 143-160
            members_g = [si for si in subjects_here if si in g]
            for d in range(NUM_DAYS):
                if any(is_var(c, si, 2 * d) or is_var(c, si, 2 * d + 1) for si in members_g):
                    m.Add(sum(day_pres(c, si, d) for si in members_g) <= 1)
        if group_rule_keys:  # checks.py 61-74
            by_group: dict[str, list[int]] = {}
            for si in subjects_here:
                for gid in subject_groups.get(si, ()):
                    if (c, gid) in group_rule_keys:
                        by_group.setdefault(gid, []).append(si)
            for gid, members_g in by_group.items():
                grule = group_rule_keys[(c, gid)]
                for s in range(NUM_SESSIONS):
                    if not any(is_var(c, si, s) for si in members_g):
                        continue
                    part = s % 2
                    cap_n = grule.max_subjects_part[part]
                    if cap_n > 0:
                        m.Add(sum(pres(c, si, s) for si in members_g) <= cap_n)
                    cap_p = grule.session_part_cap[part]
                    if cap_p > 0:
                        m.Add(sum(dur(c, si, s) for si in members_g) <= cap_p)

    # -- giao vien: trung gio, thong ke buoi, luat GV -----------------------
    for (t, x), lst in teacher_terms.items():  # state.py 121-146
        if len(lst) > 1:
            m.AddAtMostOne(lst)

    def occ_expr(t: int, x: int) -> Any:
        if const_occ.get((t, x)):
            return 1
        lst = teacher_terms.get((t, x))
        return sum(lst) if lst else 0

    S_terms: list[Any] = []
    SG_terms: list[Any] = []
    G1_terms: list[Any] = []
    G2_terms: list[Any] = []
    cur = [0, 0, 0, 0]
    n_tables = 0
    must_error = None
    for t in sorted(touched):
        ne_list: list[Any] = []
        for s in range(NUM_SESSIONS):
            st = _mask_stats(cur_occ[t][s])
            for i in range(4):
                cur[i] += st[i]
            base = s * PERIODS
            occ: list[Any] = []
            variable = False
            for p in range(PERIODS):
                x = base + p
                if const_occ.get((t, x)):
                    occ.append(1)
                elif teacher_terms.get((t, x)):
                    o = m.NewBoolVar("o%d_%d" % (t, x))
                    m.Add(o == sum(teacher_terms[(t, x)]))
                    occ.append(o)
                    variable = True
                else:
                    occ.append(0)
            if not variable:
                S_terms.append(st[0])
                SG_terms.append(st[1])
                G1_terms.append(st[2])
                G2_terms.append(st[3])
                ne_list.append(st[0])
                continue
            ne = m.NewBoolVar("ne%d_%d" % (t, s))
            sg = m.NewBoolVar("sg%d_%d" % (t, s))
            g1 = m.NewBoolVar("g1_%d_%d" % (t, s))
            g2 = m.NewBoolVar("g2_%d_%d" % (t, s))
            m.AddAllowedAssignments([*occ, ne, sg, g1, g2], _ROWS)
            n_tables += 1
            S_terms.append(ne)
            SG_terms.append(sg)
            G1_terms.append(g1)
            G2_terms.append(g2)
            ne_list.append(ne)
        rule = P.teacher_rules[t]
        if rule is not None:
            # state.py 261-286
            if rule.max_sessions > 0:
                m.Add(sum(ne_list) <= rule.max_sessions)
            if rule.max_morning > 0:
                m.Add(sum(ne_list[s] for s in range(0, NUM_SESSIONS, 2)) <= rule.max_morning)
            if rule.max_afternoon > 0:
                m.Add(sum(ne_list[s] for s in range(1, NUM_SESSIONS, 2)) <= rule.max_afternoon)
            if rule.max_days > 0:
                dvars = []
                for d in range(NUM_DAYS):
                    dv = m.NewBoolVar("day%d_%d" % (t, d))
                    m.Add(ne_list[2 * d] + ne_list[2 * d + 1] <= 2 * dv)
                    dvars.append(dv)
                m.Add(sum(dvars) <= rule.max_days)
            for d in range(NUM_DAYS):
                s_am, s_pm = 2 * d, 2 * d + 1
                # state.py 217-227
                mode = rule.session_mode[d]
                if mode == "morning":
                    m.Add(ne_list[s_pm] == 0)
                elif mode == "afternoon":
                    m.Add(ne_list[s_am] == 0)
                elif mode == "either":
                    m.Add(ne_list[s_am] + ne_list[s_pm] <= 1)
                day_slots = range(s_am * PERIODS, (s_pm + 1) * PERIODS)
                day_var = any(teacher_terms.get((t, x)) for x in day_slots)
                # state.py 228-231
                cap_d = rule.day_period_cap[d]
                if cap_d > 0 and day_var:
                    m.Add(sum(occ_expr(t, x) for x in day_slots) <= cap_d)
                # state.py 232-238
                cap_am, cap_pm = rule.session_period_cap[d]
                if cap_am > 0 and any(teacher_terms.get((t, x)) for x in range(s_am * PERIODS, s_am * PERIODS + PERIODS)):
                    m.Add(sum(occ_expr(t, x) for x in range(s_am * PERIODS, s_am * PERIODS + PERIODS)) <= cap_am)
                if cap_pm > 0 and any(teacher_terms.get((t, x)) for x in range(s_pm * PERIODS, s_pm * PERIODS + PERIODS)):
                    m.Add(sum(occ_expr(t, x) for x in range(s_pm * PERIODS, s_pm * PERIODS + PERIODS)) <= cap_pm)
                # state.py 239-242
                if rule.no_m5_a1[d]:
                    x5 = s_am * PERIODS + PERIODS - 1
                    x1 = s_pm * PERIODS
                    if teacher_terms.get((t, x5)) or teacher_terms.get((t, x1)):
                        m.Add(occ_expr(t, x5) + occ_expr(t, x1) <= 1)
            # state.py 287-306: tran tiet cua GV theo TUNG LOP (chi lop trong
            # cluster co bien; lop khac la hang so da hop le)
            for subject_set, per_session, per_day in rule.class_period_caps:
                for c in kept:
                    day_terms: list[list[Any]] = [[] for _ in range(NUM_DAYS)]
                    for s in range(NUM_SESSIONS):
                        base = s * PERIODS
                        terms: list[Any] = []
                        const_n = 0
                        for p in range(PERIODS):
                            ai = grid[c][base + p]
                            if ai < 0 or (c, base + p) in free or t not in a_teachers[ai]:
                                continue
                            if subject_set is not None and P.subject_names[P.a_subject[ai]] not in subject_set:
                                continue
                            const_n += 1
                        for d_, v, si in class_teacher_terms.get((c, t, s), ()):
                            if subject_set is not None and P.subject_names[si] not in subject_set:
                                continue
                            terms.append(d_ * v)
                        if terms:
                            if per_session > 0:
                                m.Add(const_n + sum(terms) <= per_session)
                            day_terms[s // 2].extend(terms)
                        if const_n:
                            day_terms[s // 2].append(const_n)
                    if per_day > 0:
                        for d in range(NUM_DAYS):
                            if any(not isinstance(e, int) for e in day_terms[d]):
                                m.Add(sum(day_terms[d]) <= per_day)
        # state.py 207-212
        for x in P.teacher_must[t]:
            if const_occ.get((t, x)):
                continue
            if fill:
                # lane fill: o "bat buoc day" la no luat GV (penalty) — nguoi goi
                # chi nhan khi penalty() khong tang, khong ep cung o day.
                continue
            if teacher_terms.get((t, x)):
                m.Add(sum(teacher_terms[(t, x)]) == 1)
            else:
                must_error = "must slot %d of teacher %d unreachable" % (x, t)
    if must_error is not None:
        info["error"] = must_error
        return None, info
    info["tables"] = n_tables
    info["cur_touched"] = list(cur)

    # -- timeLimit (state.py 308-337): so LOP/GV/PHONG/MON khac nhau tai mot o /
    # mot buoi trong cac tiet khop dich cua luat -------------------------------
    n_tl = 0
    for rule in getattr(P, "time_limit_rules", None) or ():
        if not isinstance(rule, collections.abc.Mapping):
            continue
        matched_var = [av for av in ais_var if _tl_matches(P, a_teachers, rule, av)]
        if not matched_var:
            continue  # chi hang so -> da hop le o luoi vao
        matched_set = set(matched_var)
        var_keys = {av: _tl_keys(P, a_teachers, av) for av in matched_var}
        const_match_cache: dict[int, list[tuple[str, str, str, str]]] = {}

        def const_keys_at(x: int) -> list[tuple[str, str, str, str]]:
            if x not in const_match_cache:
                const_match_cache[x] = [
                    _tl_keys(P, a_teachers, ai) for _c, ai in const_cells_at[x] if _tl_matches(P, a_teachers, rule, ai)
                ]
            return const_match_cache[x]

        def var_terms_at(x: int) -> list[tuple[Any, int]]:
            out = []
            for c in kept:
                for v, av in free_cover.get((c, x), ()):
                    if av in matched_set:
                        out.append((v, av))
            return out

        for field_name, key in _TL_FIELDS:
            # tung o
            for x in range(NUM_SLOTS):
                d, part = x // (2 * PERIODS), (x // PERIODS) % 2
                limit = _tl_slot_limit(rule, field_name, d, part)
                if limit <= 0:
                    continue
                vt = var_terms_at(x)
                if not vt:
                    continue
                const_keys = {k[key] for k in const_keys_at(x) if k[key] != ""}
                by_key: dict[str, list[Any]] = {}
                for v, av in vt:
                    k = var_keys[av][key]
                    if k == "" or k in const_keys:
                        continue
                    by_key.setdefault(k, []).append(v)
                if not by_key:
                    continue
                pvars = []
                for k, vs in by_key.items():
                    pv = m.NewBoolVar("tl%d_%s_%d_%d" % (n_tl, field_name, x, len(pvars)))
                    for v in vs:
                        m.Add(pv >= v)
                    pvars.append(pv)
                m.Add(len(const_keys) + sum(pvars) <= limit)
            # tung buoi
            limit = _tl_session_limit(rule, field_name)
            if limit <= 0:
                continue
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                vt_all = [(v, av) for x in range(base, base + PERIODS) for v, av in var_terms_at(x)]
                if not vt_all:
                    continue
                const_keys = {k[key] for x in range(base, base + PERIODS) for k in const_keys_at(x) if k[key] != ""}
                by_key = {}
                for v, av in vt_all:
                    k = var_keys[av][key]
                    if k == "" or k in const_keys:
                        continue
                    by_key.setdefault(k, []).append(v)
                if not by_key:
                    continue
                pvars = []
                for k, vs in by_key.items():
                    pv = m.NewBoolVar("tls%d_%s_%d_%d" % (n_tl, field_name, s, len(pvars)))
                    for v in vs:
                        m.Add(pv >= v)
                    pvars.append(pv)
                m.Add(len(const_keys) + sum(pvars) <= limit)
        n_tl += 1
    info["time_limit_rules"] = n_tl

    # -- hop dong + muc tieu -------------------------------------------------
    S = sum(S_terms)
    SG = sum(SG_terms)
    G1 = sum(G1_terms)
    G2 = sum(G2_terms)
    if fill:
        # lap tiet thieu: khong ep "khong xau hon" (dat them tiet co the buoc
        # tao buoi moi); so tiet chua xep la tren het, chat luong GV la phu.
        U = (sum(unplaced_vars.values()) if unplaced_vars else 0) + (sum(block_short) if block_short else 0)
        if fill_quality or not unplaced_vars:
            m.Minimize(U * 100000 + (SG + G2) * 200 + S * 4 + G1)
        else:
            # chi so tiet: cham 0 la OPTIMAL ngay, khong dot thoi gian vao chat
            # luong (pha 3 + vong chat luong sau do lo).
            m.Minimize(U)
    else:
        m.Add(SG <= cur[1])
        m.Add(G2 <= cur[3])
        m.Add(S <= cur[0])
    if fill:
        pass
    elif lane == "gap1":
        m.Add(G1 <= cur[2] - (1 if require_improve else 0))
        m.Minimize(G1 * 1000 + S)
    else:
        if require_improve:
            m.Add(S <= cur[0] - 1)
        m.Minimize(S * 1000 + G1)
    build_s = time.monotonic() - t0
    info["build_s"] = round(build_s, 2)

    if stop_check is not None and _safe_stop(stop_check):
        info["status"] = "STOPPED"
        info["solve_s"] = 0.0
        info["stopped"] = True
        return None, info

    solver = cp_model.CpSolver()
    solver.parameters.num_workers = max(1, workers)
    solver.parameters.max_time_in_seconds = max(0.01, time_limit)
    solver.parameters.random_seed = seed
    solver.parameters.log_search_progress = log
    timeline: list[tuple[float, int, int]] = []
    info["timeline"] = timeline
    stopped = [False]

    class _Callback(cp_model.CpSolverSolutionCallback):
        def __init__(self) -> None:
            super().__init__()

        def on_solution_callback(self) -> None:
            timeline.append((round(time.monotonic() - t0, 2), int(self.Value(G1)), int(self.Value(S))))
            if stop_check is not None and _safe_stop(stop_check):
                stopped[0] = True
                self.StopSearch()

    status = solver.Solve(m, _Callback())
    info["status"] = solver.StatusName(status)
    info["solve_s"] = round(time.monotonic() - t0 - build_s, 2)
    info["stopped"] = stopped[0]
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, info
    info["new_touched"] = [int(solver.Value(S)), int(solver.Value(SG)), int(solver.Value(G1)), int(solver.Value(G2))]

    # -- trich xuat + tu kiem ---------------------------------------------------
    new_cells: dict[tuple[int, int], int] = {}
    written = [0] * A
    for (av, s), lst in blocks.items():
        base = s * PERIODS
        chosen = [entry for entry in lst if solver.Value(entry[0])]
        if len(chosen) > 1:
            info["error"] = "assignment %d has %d blocks in session %d" % (av, len(chosen), s)
            return None, info
        for _v, _u, _d, blk in chosen:
            for q in blk:
                key = (P.a_class[av], base + q)
                if key not in free or key in new_cells:
                    info["error"] = "extracted cell %s outside free set or duplicated" % (key,)
                    return None, info
                new_cells[key] = av
                written[av] += 1
    if fill:
        for key in free:
            new_cells.setdefault(key, -1)
        info["unplaced"] = int(sum(solver.Value(u) for u in unplaced_vars.values()))
        info["block_short"] = int(sum(solver.Value(b) for b in block_short))
        for av, u in unplaced_vars.items():
            if written[av] + int(solver.Value(u)) != residual[av]:
                info["error"] = "assignment %d residual %d != written %d + unplaced" % (av, residual[av], written[av])
                return None, info
    elif len(new_cells) != len(free):
        info["error"] = "extraction covered %d of %d free cells" % (len(new_cells), len(free))
        return None, info
    for av in ais_var if not fill else ():
        if written[av] != residual[av]:
            info["error"] = "assignment %d residual %d != written %d" % (av, residual[av], written[av])
            return None, info
    occ_check: set[tuple[int, int]] = set()
    for (c, x), av in new_cells.items():
        if av < 0:
            continue
        for t in a_teachers[av]:
            if const_occ.get((t, x)) or (t, x) in occ_check:
                info["error"] = "teacher %d double-booked at slot %d" % (t, x)
                return None, info
            occ_check.add((t, x))
    return new_cells, info


def _safe_stop(stop_check: Callable[[], bool]) -> bool:
    try:
        return bool(stop_check())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# ap dung / hoan tac tren SoftSchedule
# ---------------------------------------------------------------------------


def apply_cells(soft: Any, new_cells: dict[tuple[int, int], int]) -> list[tuple[int, int, int]]:
    """Ghi ``new_cells`` bang soft.set_cell; tra ve nhat ky (lop, o, cu) cua o doi."""

    journal: list[tuple[int, int, int]] = []
    for (c, x), ai in sorted(new_cells.items()):
        old = soft.grid[c][x]
        if old != ai:
            journal.append((c, x, old))
            soft.set_cell(c, x, ai)
    return journal


def revert(soft: Any, journal: list[tuple[int, int, int]]) -> None:
    """Hoan tac theo thu tu nguoc cua nhat ky apply_cells."""

    for c, x, old in reversed(journal):
        soft.set_cell(c, x, old)
