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

import collections
import os
import random
import sys
import time

from . import checks
from .core import NUM_DAYS, NUM_SESSIONS, NUM_SLOTS, PERIODS, Problem, TeacherRule, location_rule_debt
from .state import State


def _gap1_session_slack() -> int:
    """So buoi day nut "1 tiet trong" duoc phep TANG them (mac dinh 0)."""

    try:
        return max(0, int(os.environ.get("TKB_GAP1_SESSION_SLACK", "0") or 0))
    except ValueError:
        return 0


FOCUS_METRIC_INDEX = {"singletons": 0, "gap2": 1, "sessions": 2, "gap1": 3}


def focus_candidate_acceptable(focus, start_q, start_placed, quality, placed) -> bool:
    """13/09 (chu du an: "toi quan sat thay giam tu 59 con 13 nhung khi tra ket
    qua lai phuc hoi 59, toi muon giu ket qua tot nhat"): mot luoi cua nut MOT
    MUC TIEU duoc giu lam ket qua khi dat dung hop dong cua entry._focus_gate so
    voi luoi xuat phat — khong rot tiet, chi so uu tien cao hon khong tang (buoi
    day noi dung so tiet xep them, nut gap1 cong them TKB_GAP1_SESSION_SLACK),
    chi so phu trach GIAM THAT."""

    idx = FOCUS_METRIC_INDEX.get(str(focus or ""))
    if idx is None or not isinstance(start_q, (list, tuple)) or len(start_q) < 4:
        return False
    if not isinstance(quality, (list, tuple)) or len(quality) < 4:
        return False
    placed = int(placed)
    start_placed = int(start_placed or 0)
    if placed < start_placed:
        return False
    gained = placed - start_placed
    for i in range(idx):
        slack = gained if i == 2 else 0
        if i == 2 and focus == "gap1":
            slack += _gap1_session_slack()
        if int(quality[i]) > int(start_q[i]) + slack:
            return False
    return int(quality[idx]) < int(start_q[idx])


def _focus_candidate_key(focus, quality) -> tuple:
    q = [int(x) for x in quality[:4]]
    if focus == "gap1":
        return (q[0], q[1], q[3], q[2])
    return (q[0], q[1], q[2], q[3])


# ---------------------------------------------------------------------------
# Bang tra mat na buoi day (PERIODS bit).  Trang thai mot (giao vien, buoi) chi
# co 2**PERIODS kha nang -> tien tinh san cnt/first/last va 4 thanh phan chat
# luong, doi vong quet PERIODS o + 2 tuple moi lan doi o thanh vai phep tra bang.
# ---------------------------------------------------------------------------


def _build_mask_tables(periods: int):
    n = 1 << periods
    cnt = [0] * n
    first = [-1] * n
    last = [-1] * n
    single = [0] * n
    gap2 = [0] * n
    gap1 = [0] * n
    occ = [0] * n
    for m in range(n):
        c = 0
        f = -1
        l = -1
        for p in range(periods):
            if (m >> p) & 1:
                c += 1
                if f < 0:
                    f = p
                l = p
        cnt[m] = c
        first[m] = f
        last[m] = l
        if c:
            gap = l - f + 1 - c
            single[m] = 1 if c == 1 else 0
            gap2[m] = 1 if gap >= 2 else 0
            gap1[m] = 1 if gap == 1 else 0
            occ[m] = 1
    return cnt, first, last, single, gap2, gap1, occ


(
    _MC_CNT,
    _MC_FIRST,
    _MC_LAST,
    _MC_SINGLE,
    _MC_GAP2,
    _MC_GAP1,
    _MC_OCC,
) = _build_mask_tables(PERIODS)
_MC_BIT = [1 << p for p in range(PERIODS)]


def _mask_contiguous(m: int) -> bool:
    """True khi cac bit 1 cua m tao thanh MOT doan lien tuc (m != 0)."""

    if m <= 0:
        return False
    lsb = m & -m
    return ((m + lsb) & m) == 0


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


def _ensure_a_teachers(P: Any) -> None:
    """25/08: Problem gia (test/SimpleNamespace) chi co a_teacher -> suy ra
    a_teachers = (t,) / () de moi duong kiem tra dung chung mot ban."""

    if getattr(P, "a_teachers", None):
        return
    try:
        P.a_teachers = [((t,) if t >= 0 else ()) for t in P.a_teacher]
    except Exception:
        pass


class SoftSchedule:
    """Grid + teacher occupancy counters allowing conflicts (phase 1/2)."""

    def __init__(self, P: Problem):
        self.P = P
        _ensure_a_teachers(P)
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
        self.ts_mask: list[list[int]] = [[0] * NUM_SESSIONS for _ in range(T)]
        self.q_singleton = 0
        self.q_gap2 = 0
        self.q_gap1 = 0
        self.q_sessions = 0
        self.q_days = 0
        self.t_day_sessions: list[list[int]] = [[0] * NUM_DAYS for _ in range(T)]
        self.track_quality = False
        # 23/08: dia diem cua cac tiet GV dang day tai moi o (da-tap, vi pha 1/2
        # cho phep trung gio). Chi cap phat cho GV co luat dia diem va day >= 2
        # co so (P.teacher_loc_rules); GV khac = None -> khong ton chi phi.
        loc_rules = P.teacher_loc_rules
        self.tloc: list[list[list[int]] | None] = [
            ([[] for _ in range(NUM_SLOTS)] if (loc_rules and loc_rules[t]) else None)
            for t in range(T)
        ]
        # 26/08: GV co luat dia diem ma lich vua doi -> rule_pen[t] dang CU.
        # set_cell chi ghi vao day cho GV co tloc (tuc co luat + day >= 2 co so),
        # nen truong mot co so khong ton them mot phep tinh nao.
        self._loc_dirty: set[int] = set()
        # 27/08 (chu du an: "phai gom cac buoi ve 1 co so truoc, roi moi xet
        # doi co so"): so BUOI co HAI co so cua tung GV. Buoi mot co so thi luat
        # dia diem tu thoa — ne duoc nhu cau di chuyen con hon la chua cho cho no.
        # KHONG duoc cong vao rule_pen: luoi nguoi dung thuong co san vai chuc
        # buoi hai co so HOP LE, cong vao thi penalty() != 0 -> warm-start bi tu
        # choi -> engine xay lai ca truong (dung cai bay da sua hom qua).
        self.loc_mixed: list[int] = [0] * T
        self.loc_mixed_total = 0
        # 05/10: o GV ban co dinh vi tiet chung nhieu lop (P.teacher_fixed_busy)
        # la cho chiem THAT cua GV: dem vao tcnt (=> thong ke buoi, luat GV, trung
        # gio neu co tiet khac chen vao) va dia diem. Cac o nay khong bao gio doi
        # (o co dinh) va GV da bi cam o do (teacher_avail = 0).
        a_loc = getattr(P, "a_loc", None) or []
        for t, busy in enumerate(getattr(P, "teacher_fixed_busy", None) or ()):
            if t >= T or not busy:
                continue
            row = self.tcnt[t]
            tl = self.tloc[t]
            for slot, ai in busy.items():
                row[slot] += 1
                if tl is not None and ai < len(a_loc) and a_loc[ai] >= 0:
                    tl[slot].append(a_loc[ai])
            if tl is not None:
                self._loc_dirty.add(t)

    def enable_quality_tracking(self) -> None:
        """Recompute all teacher-session stats and switch on incremental upkeep."""

        T = self.P.num_teachers()
        self.ts_cnt = [[0] * NUM_SESSIONS for _ in range(T)]
        self.ts_first = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.ts_last = [[-1] * NUM_SESSIONS for _ in range(T)]
        self.ts_mask = [[0] * NUM_SESSIONS for _ in range(T)]
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

    def _set_mask(self, t: int, s: int, m: int) -> None:
        """Dat mat na buoi (t, s) va cap nhat moi bo dem chat luong theo bang tra."""

        row = self.ts_mask[t]
        old = row[s]
        if old == m:
            return
        row[s] = m
        self.q_singleton += _MC_SINGLE[m] - _MC_SINGLE[old]
        self.q_gap2 += _MC_GAP2[m] - _MC_GAP2[old]
        self.q_gap1 += _MC_GAP1[m] - _MC_GAP1[old]
        self.q_sessions += _MC_OCC[m] - _MC_OCC[old]
        self.ts_cnt[t][s] = _MC_CNT[m]
        self.ts_first[t][s] = _MC_FIRST[m]
        self.ts_last[t][s] = _MC_LAST[m]
        if (old == 0) != (m == 0):
            d = s // 2
            drow = self.t_day_sessions[t]
            had = drow[d]
            now = had + (1 if m else -1)
            drow[d] = now
            if had == 0 and now > 0:
                self.q_days += 1
            elif had > 0 and now == 0:
                self.q_days -= 1

    def _refresh_ts(self, t: int, s: int) -> None:
        """Dung lai mat na tu tcnt (dung khi bat lai theo doi chat luong)."""

        base = s * PERIODS
        row = self.tcnt[t]
        m = 0
        for p in range(PERIODS):
            if row[base + p] > 0:
                m |= _MC_BIT[p]
        self._set_mask(t, s, m)

    # -- primitive cell ops (class-side validity is caller's duty) ---------

    def set_cell(self, c: int, slot: int, ai: int) -> None:
        old = self.grid[c][slot]
        if old == ai:
            return
        P = self.P
        track = self.track_quality
        # Mat na chi doi khi so tiet cua giao vien tai o nay vuot nguong 0<->1,
        # nen duong nong khong con quet lai ca buoi nhu truoc.
        s = slot // PERIODS
        bit = _MC_BIT[slot - s * PERIODS]
        # 25/08: tiet day ghep ("GV1, GV2") chiem cho / tao buoi day cho MOI
        # giao vien thanh vien (P.a_teachers), khong chi GV dau tien.
        if old >= 0:
            for t in P.a_teachers[old]:
                row = self.tcnt[t]
                cnt = row[slot]
                if cnt > 1:
                    self.overlap -= 1
                row[slot] = cnt - 1
                if cnt - 1 <= 1:
                    self.conflicts.discard((t, slot))
                if track and cnt == 1:
                    self._set_mask(t, s, self.ts_mask[t][s] & ~bit)
                tl = self.tloc[t]
                if tl is not None:
                    # 26/08: GV nay co luat DIA DIEM -> no luat cua GV vua doi,
                    # danh dau ban de _quality_score/penalty cham diem bang so
                    # MOI (xem sync_location_pen).
                    self._loc_dirty.add(t)
                    loc = P.a_loc[old]
                    if loc >= 0:
                        try:
                            tl[slot].remove(loc)
                        except ValueError:
                            pass
        if ai >= 0:
            for t in P.a_teachers[ai]:
                row = self.tcnt[t]
                cnt = row[slot]
                if cnt >= 1:
                    self.overlap += 1
                    self.conflicts.add((t, slot))
                row[slot] = cnt + 1
                if track and cnt == 0:
                    self._set_mask(t, s, self.ts_mask[t][s] | bit)
                tl = self.tloc[t]
                if tl is not None:
                    self._loc_dirty.add(t)
                    loc = P.a_loc[ai]
                    if loc >= 0:
                        tl[slot].append(loc)
        self.grid[c][slot] = ai

    def busy(self, ai: int, slot: int) -> int:
        """So tiet dang chiem o `slot` cua CAC giao vien cua phan cong ai.

        25/08: dung thay cho `tcnt[P.a_teacher[ai]][slot]` de tiet day ghep
        chi duoc dat khi MOI giao vien thanh vien deu ranh.
        """

        total = 0
        tcnt = self.tcnt
        for t in self.P.a_teachers[ai]:
            total += tcnt[t][slot]
        return total

    def quality(self) -> tuple[int, int, int, int, int]:
        return (self.q_singleton, self.q_gap2, self.q_sessions, self.q_gap1, self.q_days)

    def teacher_complete(self, t: int) -> bool:
        """05/10: GV t da xep du tiet (so o chiem >= tong tiet phan cong + o ban
        co dinh). Dung cho luat so buoi toi thieu."""

        P = self.P
        exp = getattr(self, "_t_expected", None)
        if exp is None:
            T = P.num_teachers()
            exp = [0] * T
            for ai, members in enumerate(P.a_teachers):
                for tt in members:
                    if 0 <= tt < T:
                        exp[tt] += int(P.a_periods[ai])
            for tt, busy in enumerate(getattr(P, "teacher_fixed_busy", None) or ()):
                if tt < T:
                    exp[tt] += len(busy)
            self._t_expected = exp
        return sum(self.tcnt[t]) >= exp[t]

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
        # 05/10: so buoi toi thieu ("dung bang") — chi tinh khi GV da du tiet
        # (lich dang xay thieu tiet thi chua the doi du buoi).
        if rule.min_sessions > 0 and used_sessions < rule.min_sessions and self.teacher_complete(t):
            pen += rule.min_sessions - used_sessions
        if rule.max_morning > 0 and used_am > rule.max_morning:
            pen += used_am - rule.max_morning
        if rule.max_afternoon > 0 and used_pm > rule.max_afternoon:
            pen += used_pm - rule.max_afternoon
        # NOTE: class_period_caps handled by State at load; rare in practice.
        if self.tloc[t] is not None:
            pen += self.location_debt(t)
        return pen

    def location_session_debt(self, t: int, s: int) -> int:
        """No luat dia diem cua buoi s (0 = hop le). Cung cach tinh voi State."""

        rule = self.P.teacher_rules[t]
        tl = self.tloc[t]
        if rule is None or tl is None:
            return 0
        one = rule.loc_one[s]
        gap = rule.loc_gap[s]
        move = rule.loc_move[s]
        breaks = rule.loc_breaks[s]
        if not (one or gap or move or breaks):
            return 0
        base = s * PERIODS
        entries: list[tuple[int, int]] = []
        for p in range(PERIODS):
            locs = tl[base + p]
            if locs:
                # trung gio (>= 2 tiet, co the khac dia diem) da bi phat rieng
                # (overlap); lay dia diem dau tien lam dai dien.
                entries.append((p, locs[0]))
        if len(entries) < 2:
            return 0
        return location_rule_debt(entries, one, gap, move, breaks)

    def location_debt(self, t: int) -> int:
        if self.tloc[t] is None:
            return 0
        return sum(self.location_session_debt(t, s) for s in range(NUM_SESSIONS))

    def location_debt_sessions(self, t: int) -> list[int]:
        """Cac buoi dang vi pham luat dia diem cua GV t (de pha 2 nham dung cho)."""

        if self.tloc[t] is None:
            return []
        return [s for s in range(NUM_SESSIONS) if self.location_session_debt(t, s) > 0]

    def location_blocks(self, ai: int, slot: int) -> bool:
        """26/08: dat `ai` vao `slot` co lam GV cua no VI PHAM luat DIA DIEM ngay
        khong?

        Dung lam BO LOC MIEN luc dat tiet, thay vi chi phat mem roi go sau. Lich
        mau cua phan mem khac tren cung truong (TEMP/test.xlsx, THCS Binh Hoa)
        cho thay dung cach nay dat 1111 tiet / 0 vi pham: ho khong ne day 2 co so
        trong mot buoi (19.5% so buoi), nhung MOI lan doi co so deu chua dung 1
        tiet trong — 39/39 lan. Engine cu tao ra 45 cho doi lien ke roi moi di
        go, va go khong xue.

        Chi GV co `tloc` (co luat + day >= 2 co so) moi ton phep tinh; truong mot
        co so tra False ngay.
        """

        P = self.P
        loc = P.a_loc[ai]
        if loc < 0:
            return False
        s, p = divmod(slot, PERIODS)
        base = s * PERIODS
        for t in P.a_teachers[ai]:
            tl = self.tloc[t]
            if tl is None:
                continue
            rule = P.teacher_rules[t]
            if rule is None:
                continue
            one = rule.loc_one[s]
            gap = rule.loc_gap[s]
            move = rule.loc_move[s]
            breaks = rule.loc_breaks[s]
            if not (one or gap or move or breaks):
                continue
            entries: list[tuple[int, int]] = []
            for q in range(PERIODS):
                if q == p:
                    entries.append((q, loc))
                    continue
                locs = tl[base + q]
                if locs:
                    entries.append((q, locs[0]))
            if len(entries) >= 2 and location_rule_debt(entries, one, gap, move, breaks) > 0:
                return True
        return False

    def location_mix_cost(self, ai: int, slot: int) -> int:
        """26/08 (chu du an: "gom cac tiet co the chung 1 co so voi nhau, lop
        khac co so thi dem ra rieng 1 buoi"): dat `ai` vao `slot` co bien mot
        buoi DANG MOT CO SO thanh HAI CO SO khong?

        Tra ve so GV bi anh huong (0 = khong lam buoi nao "pha the"). Dung lam
        LUC DAY MEM khi chon o, duoi muc `_LOC_AVOID` (vi pham that su) — vi
        buoi hai co so KHONG sai neu co tiet trong de di chuyen, chi la kem gon.

        Lich mau THCS Binh Hoa: 80.5% buoi cua GV 2 co so la MOT co so duy nhat
        (ta 75.4%), va 100% buoi hai co so cua ho deu co tiet trong.
        """

        P = self.P
        loc = P.a_loc[ai]
        if loc < 0:
            return 0
        s = slot // PERIODS
        base = s * PERIODS
        cost = 0
        for t in P.a_teachers[ai]:
            tl = self.tloc[t]
            if tl is None:
                continue
            seen = set()
            for q in range(PERIODS):
                if base + q == slot:
                    continue
                locs = tl[base + q]
                if locs:
                    seen.add(locs[0])
            # buoi dang trong / dang dung dung co so nay -> khong pha the
            if seen and loc not in seen:
                cost += 1
        return cost

    def _count_mixed_sessions(self, t: int) -> int:
        """So buoi ma GV t day o >= 2 co so trong cung mot buoi."""

        tl = self.tloc[t]
        if tl is None:
            return 0
        n = 0
        for s in range(NUM_SESSIONS):
            base = s * PERIODS
            seen = None
            mixed = False
            for p in range(PERIODS):
                locs = tl[base + p]
                if not locs:
                    continue
                v = locs[0]
                if seen is None:
                    seen = v
                elif v != seen:
                    mixed = True
                    break
            if mixed:
                n += 1
        return n

    def refresh_loc_mixed(self, t: int) -> None:
        new = self._count_mixed_sessions(t)
        self.loc_mixed_total += new - self.loc_mixed[t]
        self.loc_mixed[t] = new

    def location_debt_session_count(self) -> int:
        """26/08: tong so BUOI (GV, buoi) vi pham luat dia diem tren ca luoi —
        cung don vi voi ``State.location_rule_debt_sessions()`` va voi
        ``TKBConstraints.teacherLocationRuleDebt().sessions`` cua giao dien.
        Dung de ghi MOC XUAT PHAT (``info["warm_location_debt"]``)."""

        total = 0
        for t in range(len(self.tloc)):
            if self.tloc[t] is None:
                continue
            total += len(self.location_debt_sessions(t))
        return total

    def edge_pair_debt_slots(self, t: int) -> list[int]:
        """Cac o dang gay vi pham "tiet 5 sang + tiet 1 chieu" cua GV t.

        No luat nay nam o DUNG hai o cua moi ngay vi pham, khac han cac luat
        theo buoi/ngay. Tra ve chinh hai o do de pha 2 boc trung cho hong;
        boc ngau nhien mot tiet bat ky trong tuan cua GV thi xac suat cham
        dung cho chi khoang 1/20 va no luat gan nhu khong bao gio tra het.
        """

        rule = self.P.teacher_rules[t]
        if rule is None or not any(rule.no_m5_a1):
            return []
        row = self.tcnt[t]
        out: list[int] = []
        for d in range(NUM_DAYS):
            if not rule.no_m5_a1[d]:
                continue
            am5 = (d * 2) * PERIODS + 4
            pm1 = (d * 2 + 1) * PERIODS
            if row[am5] > 0 and row[pm1] > 0:
                out.append(am5)
                out.append(pm1)
        return out

    def refresh_rule_pen(self, t: int) -> None:
        new = self.teacher_rule_penalty(t)
        self.rule_pen_total += new - self.rule_pen[t]
        self.rule_pen[t] = new
        if self.tloc[t] is not None:
            self.refresh_loc_mixed(t)
        self._loc_dirty.discard(t)

    def sync_location_pen(self) -> None:
        """26/08: cap nhat lai no luat cho cac GV co luat DIA DIEM ma lich vua
        doi.

        `set_cell` van giu `tloc` dung tung nuoc di, nhung con so `rule_pen[t]`
        thi chi doi khi co ai goi `refresh_rule_pen`. Truoc day co ~25 cho cham
        diem bang `_quality_score` (co so hang `rule_pen_total * 10**13`) ma chi
        ~12 cho refresh -> cac pha toi uu chat luong cham diem bang no dia diem
        CU, tuc mu. Do that tren truong 2kkn7c6y7l1: 35 -> 55 buoi vi pham.

        Truong mot co so / khong bat luat: `_loc_dirty` luon rong -> ham nay chi
        ton mot phep kiem tra tap rong.
        """

        dirty = self._loc_dirty
        if not dirty:
            return
        # copy roi xoa truoc: teacher_rule_penalty khong sua lich nen khong the
        # them phan tu moi, nhung giu the nay thi an toan voi moi thay doi sau.
        self._loc_dirty = set()
        total = self.rule_pen_total
        rule_pen = self.rule_pen
        for t in dirty:
            new = self.teacher_rule_penalty(t)
            total += new - rule_pen[t]
            rule_pen[t] = new
            self.refresh_loc_mixed(t)
        self.rule_pen_total = total

    def penalty(self) -> int:
        if self._loc_dirty:
            self.sync_location_pen()
        return self.overlap + self.rule_pen_total

    def penalty_key(self) -> tuple[int, int]:
        """26/08: khoa so sanh TU DIEN — TRUNG GIO truoc, no luat GV sau.

        `penalty()` gop hai thu vao MOT so nen pha 2 san sang danh doi: nhan mot
        nuoc bo 1 trung gio de doi lay 2 no luat, hoac nguoc lai. Do that tren
        truong 2kkn7c6y7l1: pha 2 go no luat 57 -> 43 nhung de lai trung gio,
        khien `_repair_partial_warm` phai vut ca luoi warm (overlap > 0) va
        engine xay lai tu dau, mat ~60 tiet. Trung gio GV la vi pham CUNG, khong
        bao gio duoc doi lay bat cu gi."""

        if self._loc_dirty:
            self.sync_location_pen()
        return (self.overlap, self.rule_pen_total)


# 22/08: muc phat cho nuoc di lam VUOT mot chi so da KHOA (buoi 1 tiet / buoi
# trong >= 2). Nho hon phat cung (10**13: trung gio / luat GV) nhung lon hon
# moi cai thien chat luong co the (10**11 x so buoi), nen thu tu uu tien la:
# hop le > khoa > chat luong.
_LOCK_PENALTY = 10**12

# 26/08: muc "day xuong cuoi hang" cho o lam vo luat DIA DIEM khi xep tiet.
# Lon hon moi diem ngau nhien/uu tien lien tiet, nhung KHONG phai cam.
_LOC_AVOID = 1000.0

# 26/08: luc day GOM THEO CO SO — buoi hai co so khong SAI (neu co tiet trong)
# nhung kem gon, nen phat nhe hon _LOC_AVOID rat nhieu.
_LOC_MIX = 0.4

# 27/08: gia cua mot BUOI HAI CO SO trong _quality_score. Dat GIUA "trong 1
# tiet" (10) va "so buoi day" (10**5): du de engine chu dong gom buoi ve mot
# co so, nhung khong bao gio danh doi mot buoi day hay mot tiet de lam viec do.
_LOC_MIXED_W = 10**3

# Nhan ngay/buoi cho thong diep goi y (hien cho nguoi dung, co dau).
_DAY_LABEL = ("Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7")
_PART_LABEL = ("sáng", "chiều")
_REMOVE_FAIL_LABEL = {
    "fixed": "ô cố định",
    "must_teach": "ô GV bắt buộc dạy",
    "student_hole": "gỡ ra sẽ tạo lỗ trống giữa buổi cho học sinh",
    "class_session": "vi phạm luật buổi của lớp",
    "class_day": "vi phạm luật ngày của lớp",
    "other_subject_week": "vi phạm luật tuần của môn kế bên",
    "penalty": "vi phạm luật GV",
    "no_plan": "không có cách gỡ ở rìa buổi",
    "empty": "không tìm thấy tiết",
}


# 29/10: _cpsat_repair_loc_debt — so vung lien tiep khong go duoc no (luoi khong doi) thi dung.
LOCFIX_FAIL_STREAK = 16
# 29/10: lan giai TOAN TRUONG cua pha lap tiet dung khi 2 s khong co loi giai moi (xem
# cpsat_lns.build_and_solve stall_s) — no dia diem con lai buoc go no theo vung xu ly.
WHOLE_FILL_STALL_S = 2.0


class Constructor:
    def __init__(self, problem: Problem, seed: int = 0):
        self.P = problem
        _ensure_a_teachers(problem)
        self.rng = random.Random(seed)
        # "gap1" = nut Toi uu trong 1 tiet: uu tien giam gap1, khong bao gio
        # cho tong so buoi vuot qua muc luc bat dau (_session_cap).
        self.quality_focus: str | None = None
        self._session_cap: int | None = None
        # 13/09: moc xuat phat + luoi HOP LE tot nhat da gap cua nut mot muc tieu
        # (_offer_focus_candidate) — ket qua cuoi hong kiem tra thi tra luoi nay
        # thay vi luoi goc.
        self._focus_start: tuple[list[int], int] | None = None
        self._focus_candidate: dict | None = None
        self._focus_candidate_checked_at = 0.0
        self._focus_info: dict | None = None
        # 23/08 (chu du an: "nut Dung bam vao khong dung duoc"): Cloud Run bao
        # dung/huy bang file TKB_SOLVER_STOP_FILE (nhu CP-SAT); engine v3 truoc
        # day khong doc -> chay het ngan sach, chiem instance duy nhat, luot ke
        # tiep bi day sang revision cu. Kiem tra toi da 2 lan/giay.
        self._stop_file = str(os.environ.get("TKB_SOLVER_STOP_FILE") or "").strip()
        self._stop_checked_at = 0.0
        self._stop_seen = False
        # 22/08 (chi dao chu du an): toi uu giao vien theo BAC co KHOA —
        # 1 tiet/buoi ve thap nhat -> KHOA (khong duoc tang) -> trong >= 2 ve
        # thap nhat -> KHOA -> giam buoi day / trong 1. None = chua khoa.
        self._lock_singleton: int | None = None
        self._lock_gap2: int | None = None
        self._stage_log: list[dict] = []
        # 22/08 (toi, chi dao chu du an): sau bac 3, tiet nao VAN lam GV con
        # buoi 1 tiet / trong >= 2 ma khong sua duoc thi "rot ve Chua phan"
        # kem ly do + goi y; lich warm-start duoc phep thieu dung nhung tiet
        # do (warm_missing_ok) ma van coi la lich DA DU (moi worker warm-start).
        self.warm_missing_ok: int = 0
        self._quality_ejected: list[dict] = []
        self._quality_unavoidable: list[dict] = []
        self._quality_eject_skipped: dict = {}
        self._eject_tried: set[tuple[int, int]] = set()
        self._last_remove_fail: str = ""
        self._amask: dict[int, list[int]] = {}
        # 23/08: san "suc chua" theo o hop le cua tung tiet (xem
        # structural_floors) va bo nho "ep ghep da thu ma that bai" theo buoi.
        self._cap_floor: dict[int, tuple[int, set[int], int]] = {}
        self._force_fail_at: dict[tuple[int, int], int] = {}
        # 26/08: toan tu CP-SAT LNS theo cum (cpsat_lns.py) cho nut gap1 /
        # sessions. cpsat_threads = 0 -> tu chon (1 tien trinh: het CPU; nhieu
        # worker: entry chia). _cpsat_memo: cum lop da chung minh INFEASIBLE
        # (khong thu lai) / UNKNOWN (thu lai 1 lan voi +50% thoi gian).
        self.cpsat_threads: int = 0
        # 01/10: nut Cherry dung CP-SAT de LAP TIET THIEU + toi uu chat luong
        # (entry bat khi _cpsat_lane_enabled: ortools co, <= 25 % GV luat dia diem).
        self.cherry_cpsat: bool = False
        # 05/10: luoi warm la luoi TRUNG GIAN (vong 2 Cherry xep tu dau), khong
        # phai lich nguoi dung -> no luat duoc go ca khi phai bot tiet (_maybe_fill_warm)
        self.prefer_valid: bool = False
        # 29/10: worker vong 1 cua Cherry 2 vong — tu moc nay, luoi het trung gio va gan du tiet
        # la tra ve ngay (xem _stage1_ready). 0 = tat.
        self.stage1_ready_at: float = 0.0
        self._stage1_armed_at: float = 0.0
        self._cpsat_stats: collections.Counter = collections.Counter()
        self._cpsat_memo: dict[frozenset, tuple[str, int]] = {}
        self._cpsat_pass_idx: int = 0
        self._cpsat_session_idx: int = 0
        self._fpe_last_debts: int = -1
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
        self._construct_progress = progress
        self._construct_report_at = 0.0
        # 25/08: nut mot muc tieu luon di duong warm (ke ca lich rong) de ghi
        # moc xuat phat va "bao khong toi uu duoc" thay vi xay lai tu dau.
        if warm_cells or (warm_cells is not None and self.quality_focus is not None):
            soft = SoftSchedule(P)
            for c, slot, ai in P.fixed_cells:
                if soft.grid[c][slot] == -1:
                    soft.set_cell(c, slot, ai)
                    soft.locked[c][slot] = 1
            # 23/08: lich hien tai co the chua NHIEU tiet hon bai toan (phan
            # cong da bi cat bot vi vuot suc chua -> Chua phan truoc khi giai).
            # Chi nhan toi da a_periods tiet moi phan cong (o co dinh da vao
            # truoc), neu khong lop do bi coi la "hong" va xep lai tu dau.
            warm_used: dict[int, int] = {}
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    ai0 = soft.grid[c][slot]
                    if ai0 >= 0:
                        warm_used[ai0] = warm_used.get(ai0, 0) + 1
            for c, slot, ai in warm_cells:
                if soft.grid[c][slot] == -1 and warm_used.get(ai, 0) < P.a_periods[ai]:
                    soft.set_cell(c, slot, ai)
                    warm_used[ai] = warm_used.get(ai, 0) + 1
            # 22/08 (toi): phai tinh lai no luat GV (must-teach, gioi han
            # buoi/ngay) cho luoi warm — truoc day rule_pen = 0 mac dinh nen
            # penalty() bao "sach" gia, roi _load_state tu choi ma khong ro ly do.
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)
            placed = sum(1 for row in soft.grid for v in row if v >= 0)
            # 25/08 (chu du an: "toi uu xong thi so do lai tang la khong hop
            # ly"): ghi MOC XUAT PHAT = dung luoi nguoi dung dang co, TRUOC moi
            # buoc sua chua/xay lai. entry.py so ket qua cuoi voi moc nay va
            # nut mot muc tieu khong bao gio duoc tra ve lich xau hon moc.
            warm_grid0 = [row[:] for row in soft.grid]
            soft.enable_quality_tracking()
            info["warm_placed"] = placed
            info["warm_quality"] = [int(x) for x in soft.quality()[:4]]
            info["warm_grid"] = warm_grid0
            if self.quality_focus is not None:
                self._focus_start = (list(info["warm_quality"]), placed)
                self._focus_candidate = None
                self._focus_info = info
            # 26/08: moc so BUOI vi pham yeu cau DIA DIEM cua luoi nguoi dung
            # dang co — entry.py khong bao gio duoc tra ve lich nhieu hon moc nay.
            info["warm_location_debt"] = soft.location_debt_session_count()
            if self.quality_focus is not None and placed * 2 < expected:
                # lich moi co duoi nua so tiet: khong co gi de "toi uu tai cho"
                info["warm_start_rejected"] = True
                info["focus_aborted"] = "too_sparse:%d/%d" % (placed, expected)
                return self._lenient_state(warm_grid0), info
            # 22/08 (toi): lich vao duoc phep thieu dung so tiet ma Cherry lan
            # truoc da dua ve Chua phan vi chat luong GV -> van la "da du".
            missing_ok = max(0, int(self.warm_missing_ok or 0))
            self._last_load_fail = ""
            # 23/08: lich vao THIEU tiet (vi du ~20 tiet khong co cho vi tiet
            # nghi/rang buoc, lan truoc da bao Chua phan) nhung hop le van duoc
            # warm-start: tiet thieu duoc thu xep lai, roi toi uu tiep tren chinh
            # lich do. Truoc day "incomplete" -> xay lai CA TRUONG moi lan bam,
            # nen nhung truong co tiet bat kha xep khong bao gio tien len duoc.
            # Luong xay moi (nua so worker khi lich chua du) van giu vai tro tim
            # lich xep duoc NHIEU tiet hon; bang so tiet thi chat luong quyet dinh.
            if soft.penalty() != 0:
                info["warm_reject_reason"] = "penalty:%d" % soft.penalty()
            if soft.penalty() == 0:
                probe = self._load_state(soft)
                if probe is None:
                    info["warm_reject_reason"] = "hard:" + (self._last_load_fail or "unknown")
                if probe is not None:
                    info["warm_start"] = True
                    if probe.placed + missing_ok < expected:
                        info["warm_incomplete"] = expected - probe.placed - missing_ok
                    info["feasibility_attempts"] = 0
                    info["feasibility_seconds"] = 0.0
                    if placed < expected:
                        info["warm_missing"] = expected - placed
                    if time.monotonic() < deadline - 5:
                        soft.enable_quality_tracking()
                        if placed < expected:
                            # thu xep lai tiet con thieu truoc khi toi uu: uu
                            # tien o khong lam GV xau them; khong co thi xep
                            # vao o it hai nhat (tru GV chi 1 tiet/tuan) de
                            # bac 1/2 co co hoi sua, cuoi cung khong sua duoc
                            # thi bac 4 dua ra lai kem ly do.
                            added = self._insert_missing_quality_neutral(soft)
                            if self.quality_focus is None:
                                # chi nut Cherry (co bac 4 don dep) moi duoc xep
                                # lai "co no"; nut mot muc tieu khong duoc tao
                                # buoi le moi ma khong ai sua.
                                added += self._insert_missing_quality_neutral(soft, allow_debt=True)
                            if added:
                                info["reinserted"] = added
                        self._maybe_fill_warm(soft, deadline, info)
                        self._run_quality(soft, deadline, progress=progress, info=info)
                        self._finish_quality(soft, info)
                    forced_singles, forced_gap2s, evidence = getattr(
                        self, "_floors_cache", None
                    ) or self.structural_floors()
                    info["floors"] = {
                        "one_period_floor": len(forced_singles) + self._cap_floor_total(),
                        "gap2_floor": len(forced_gap2s),
                        "evidence": evidence[:20],
                    }
                    self._offer_focus_candidate(soft.grid, soft.quality(), force=True)
                    state = self._load_state(soft)
                    if state is not None:
                        return state, info
                    fallback = self._focus_fallback_state(soft, info)
                    if fallback is not None:
                        return fallback, info
            info["warm_start_rejected"] = True
            # Warm khong hop le/khong du (vi du lich do CP-SAT dua sang con
            # thieu vai tiet hoac vi pham luat lop): SUA CUC BO thay vi vut di —
            # chi lam lai nhung lop co van de, giu nguyen cau truc con lai.
            skip_local_repair = (
                self.prefer_valid
                and self.cherry_cpsat
                and self.quality_focus is None
                and soft.overlap == 0
                and self._cpsat_available()
            )
            repaired = None if skip_local_repair else self._repair_partial_warm(soft, expected, deadline)
            if repaired is None:
                info["warm_repair_failed"] = self._last_load_fail or info.get("warm_reject_reason") or "unknown"
                if (
                    self.quality_focus is None
                    and self.cherry_cpsat
                    and self._cpsat_available()
                    and time.monotonic() < deadline - 6.0
                ):
                    # 01/10: nut Cherry voi CP-SAT — KHONG vut lich nguoi dung de
                    # xay lai tu dau (1 tien trinh: do truong 61 lop 2051 -> 1983
                    # tiet). Giu luoi da sua do: lop con vi pham luat lop thi go
                    # tiet cua lop do, bo trung gio, roi pha lap tiet CP-SAT xep lai.
                    salvaged = self._salvage_warm(soft, deadline)
                    if salvaged is not None:
                        repaired = salvaged
                        info["warm_salvaged"] = True
                        info["cpsat_fill"] = getattr(self, "_salvage_stats", None)
            if repaired is not None:
                info["warm_start"] = True
                info["warm_repaired"] = True
                info["feasibility_attempts"] = 0
                info["feasibility_seconds"] = 0.0
                repaired_placed = sum(1 for row in repaired.grid for v in row if v >= 0)
                if repaired_placed + max(0, int(self.warm_missing_ok or 0)) < expected:
                    info["warm_incomplete"] = expected - repaired_placed - max(0, int(self.warm_missing_ok or 0))
                if time.monotonic() < deadline - 5:
                    repaired.enable_quality_tracking()
                    if not info.get("warm_salvaged"):
                        self._maybe_fill_warm(repaired, deadline, info)
                    self._run_quality(repaired, deadline, progress=progress, info=info)
                    self._finish_quality(repaired, info)
                forced_singles, forced_gap2s, evidence = getattr(
                    self, "_floors_cache", None
                ) or self.structural_floors()
                info["floors"] = {
                    "one_period_floor": len(forced_singles) + self._cap_floor_total(),
                    "gap2_floor": len(forced_gap2s),
                    "evidence": evidence[:20],
                }
                state = self._load_state(repaired)
                if state is not None:
                    return state, info
                if info.get("warm_salvaged") or (self.quality_focus is None and repaired.overlap == 0):
                    # 01/10: luoi giu lai con THIEU tiet (mon thieu chua du cap
                    # doi -> full_recheck tu choi) — tra ban do dang nhu duong
                    # xay moi, khong roi ve xay lai tu dau khi da het gio.
                    # 06/10: ca luoi _repair_partial_warm sua duoc (khong qua
                    # salvage). An Phu that: vong 2 Cherry sua + toi uu xong 863
                    # tiet [5,0,317,25], _load_state tu choi (lesson_blocks_min_2 vi
                    # con thieu tiet) -> roi xuong xay lai tu dau voi ~1 s -> 283 /
                    # 167 tiet.
                    info["warm_final_lenient"] = self._last_load_fail or "hard_check"
                    return self._lenient_state(repaired.grid), info
            if self.quality_focus is not None:
                fallback = self._focus_fallback_state(soft, info)
                if fallback is not None:
                    return fallback, info
                # 25/08: nut MOT MUC TIEU (menu Toi uu v3) chi co nghia tren
                # lich dang co. Truoc day warm bi tu choi (vi du lich con tiet
                # Chua phan o mon co cap 2 tiet -> hard:lesson_blocks_min_2) thi
                # am tham XAY LAI CA TRUONG tu dau, roi ket qua "xep du hon"
                # duoc bridge ap ngay du chi so phu trach TANG (do duoc: trong 1
                # 147 -> 180). Gio: tra lai dung lich cua nguoi dung kem ly do;
                # bridge bao "khong toi uu tai cho duoc" thay vi doi lich.
                info["focus_aborted"] = (
                    info.get("warm_repair_failed")
                    or info.get("warm_reject_reason")
                    or "warm_rejected"
                )
                return self._lenient_state(warm_grid0), info
            if time.monotonic() > deadline - 12.0:
                # 06/10: nut Cherry khong bao gio XAY LAI TU DAU khi gan het gio
                # (vai giay chi lat duoc vai tram tiet) — tra lich nguoi dung.
                info["warm_fresh_skipped"] = "no_time"
                return self._lenient_state(warm_grid0), info
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
        if self.cherry_cpsat and self.quality_focus is None and self._cpsat_available():
            # 01/10: co pha lap tiet bang CP-SAT phia sau (_cpsat_fill_phase) ->
            # pha 1+2 chi can 1 luoi sach trung gio + sach no dia diem, phan con
            # lai danh cho lap tiet + chat luong.
            feas_deadline = min(deadline, started + max(12.0, (deadline - started) * 0.38))
        cherry_one_attempt = self.cherry_cpsat and self.quality_focus is None and self._cpsat_available()
        has_min_sess = any(r is not None and r.min_sessions > 0 for r in P.teacher_rules)
        # chi luc XAY MOI (khong dung luc sua lich nguoi dung) — go o cuoi khoi duoi no ben duoi
        self._stage1_armed_at = self.stage1_ready_at
        while time.monotonic() < feas_deadline and not self._stop_requested():
            if (
                (cherry_one_attempt or has_min_sess or (not self.cherry_cpsat and self.quality_focus is None and self._cpsat_available()))
                and attempts >= 1
                and best_soft is not None
                and (
                    (best_soft.overlap == 0 and best_placed >= expected - 16)
                    or self._stage1_ready(best_soft)
                )
            ):
                # Da co luoi sach trung gio -> sang CP-SAT lap tiet + toi uu.
                break
            attempts += 1
            if attempts % 4 == 0 and best_soft is not None and best_pen <= 8:
                # ILS: retry from the best near-feasible grid with a fresh walk
                soft = clone_from_grid(best_soft.grid)
                self._phase2(soft, min(feas_deadline, time.monotonic() + 6.0))
            else:
                soft, _tiled = self._phase1(feas_deadline)
                self._phase2(soft, min(feas_deadline, time.monotonic() + 8.0))
                if 0 < soft.penalty() <= 6 and time.monotonic() < feas_deadline:
                    # so close — extend this attempt with the heavy hammers
                    self._phase2(soft, min(feas_deadline, time.monotonic() + 4.0))
            placed = sum(1 for row in soft.grid for v in row if v >= 0)
            pen = soft.penalty()
            if placed >= expected and pen == 0:
                complete_soft = soft
                break
            if (placed, -pen) > (best_placed, -best_pen):
                best_placed = placed
                best_pen = pen
                best_soft = soft
        if (
            complete_soft is None
            and best_soft is not None
            and best_placed >= expected
            and best_soft.overlap == 0
            and best_pen > 0
            and not cherry_one_attempt
        ):
            # 13/09 (chu du an: "gioi han buoi day khi bam Cherry phai tuan thu"):
            # du tiet, het trung gio, chi con NO LUAT GV (thuong la "sang HOAC
            # chieu") khi het cua so kha thi. Truoc day tra luon luoi con no ma
            # KHONG toi uu chat luong -> ~40% thoi gian bo phi. Nay sua tiep no
            # tu luoi tot nhat (giu lai mot phan de toi uu chat luong neu sach).
            extend_deadline = deadline - max(5.0, (deadline - time.monotonic()) * 0.35)
            extend_rounds = 0
            idle_rounds = 0
            is_stage1_worker = not self.cherry_cpsat and self.quality_focus is None and self._cpsat_available()
            max_idle_rounds = 1 if is_stage1_worker else 2
            round_step_s = 2.0 if is_stage1_worker else 6.0
            while (
                time.monotonic() < extend_deadline
                and not self._stop_requested()
                and best_soft.penalty() > 0
                and idle_rounds < max_idle_rounds
                and not self._stage1_ready(best_soft)
            ):
                extend_rounds += 1
                soft = clone_from_grid(best_soft.grid)
                round_started = time.monotonic()
                self._phase2(soft, min(extend_deadline, time.monotonic() + round_step_s))
                placed = sum(1 for row in soft.grid for v in row if v >= 0)
                pen = soft.penalty()
                # pha 2 khong giam duoc penalty -> tang idle_rounds de dung som
                idle_rounds = idle_rounds + 1 if pen >= best_pen else 0
                if placed >= expected and pen == 0:
                    complete_soft = soft
                    break
                if placed >= expected and soft.overlap == 0 and pen < best_pen:
                    best_pen = pen
                    best_soft = soft
            info["rule_debt_extend_rounds"] = extend_rounds
            if self._stage1_armed_at and self._stage1_ready(best_soft):
                info["stage1_ready"] = True
            info["rule_debt_extend_solved"] = complete_soft is not None
            if (
                complete_soft is None
                and best_soft.overlap == 0
                and best_soft.penalty() > 0
                and not is_stage1_worker
            ):
                # van con no: dua DUNG cac tiet vi pham ve Chua phan (chu du an:
                # "co mau thuan rang buoc thi thong bao de toi xu ly") thay vi
                # tra lich vi pham va bo qua toi uu chat luong.
                ejected = self._eject_session_debt(best_soft, deadline)
                if ejected:
                    info["rule_debt_ejected"] = ejected
        self._stage1_armed_at = 0.0
        if (
            complete_soft is None
            and best_soft is not None
            and self.cherry_cpsat
            and self._cpsat_available()
            and time.monotonic() < deadline - 8.0
            and not self._stop_requested()
        ):
            # 01/10 (chu du an: "lam sao nut Cherry lam duoc nhu ban"): truong
            # 0 o du (THCS Hung Long 1207 tiet / 1207 o) — pha 1+2 dung o
            # ~1192 sau 3 lan thu. Lap tiet thieu bang CP-SAT LNS theo cum lop
            # (cpsat_lns lane "fill"): o trong + tiet thieu cua 3-6 lop duoc giai
            # lai, chi nhan khi xep THEM duoc tiet ma khong them no luat.
            self._shed_overlaps(best_soft)
            fill_deadline = deadline - max(6.0, (deadline - time.monotonic()) * 0.2)
            info["cpsat_fill"] = self._cpsat_fill_phase(best_soft, fill_deadline)
            best_placed = sum(1 for row in best_soft.grid for v in row if v >= 0)
            best_pen = best_soft.penalty()
            if best_placed >= expected and best_pen == 0:
                complete_soft = best_soft
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
        if (
            target_soft is not None
            and target_soft.penalty() == 0
            and time.monotonic() < deadline - 5
            and (self.cherry_cpsat or self.quality_focus is not None)
        ):
            target_soft.enable_quality_tracking()
            self._run_quality(target_soft, deadline, progress=progress, info=info)
            self._finish_quality(target_soft, info)
        forced_singles, forced_gap2s, evidence = getattr(
            self, "_floors_cache", None
        ) or self.structural_floors()
        info["floors"] = {
            "one_period_floor": len(forced_singles) + self._cap_floor_total(),
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

    def _eject_session_debt(self, soft: SoftSchedule, deadline: float) -> int:
        """13/09: lich du tiet, het trung gio nhung con no "Gioi han buoi day"
        ma pha 2 khong go duoc: go cac tiet (khong khoa) o buoi vi pham — "chi
        sang" -> tiet chieu, "chi chieu" -> tiet sang, "sang hoac chieu" -> buoi
        khong co o khoa / buoi it tiet hon — roi thu xep lai tiet vua go vao cho
        hop le (_settle_warm). Chi giu khi het sach no va qua kiem tra cung; neu
        khong tra lai nguyen luoi. Tra so tiet con nam o Chua phan."""

        P = self.P
        grid_before = [row[:] for row in soft.grid]
        placed_before = sum(1 for row in grid_before for v in row if v >= 0)
        removed = 0
        for t in self._has_rule_teachers:
            rule = P.teacher_rules[t]
            if rule is None or soft.rule_pen[t] <= 0:
                continue
            for d in range(NUM_DAYS):
                mode = rule.session_mode[d]
                if not mode:
                    continue
                owners: list[list[tuple[int, int]]] = []
                for s in (d * 2, d * 2 + 1):
                    cells = []
                    for slot in range(s * PERIODS, (s + 1) * PERIODS):
                        if soft.tcnt[t][slot] <= 0:
                            continue
                        for c in range(P.num_classes()):
                            ai = soft.grid[c][slot]
                            if ai >= 0 and t in P.a_teachers[ai]:
                                cells.append((c, slot))
                    owners.append(cells)
                am, pm = owners
                target: list[tuple[int, int]] = []
                if mode == "morning":
                    target = pm
                elif mode == "afternoon":
                    target = am
                elif am and pm:
                    lock_am = any(soft.locked[c][x] for c, x in am)
                    lock_pm = any(soft.locked[c][x] for c, x in pm)
                    if lock_am and lock_pm:
                        target = []
                    elif lock_am or lock_pm:
                        target = pm if lock_am else am
                    else:
                        target = am if len(am) <= len(pm) else pm
                for c, slot in target:
                    if soft.locked[c][slot] or soft.grid[c][slot] < 0:
                        continue
                    soft.set_cell(c, slot, -1)
                    removed += 1
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)

        def revert() -> int:
            self._restore_grid(soft, grid_before)
            for tt in self._has_rule_teachers:
                soft.refresh_rule_pen(tt)
            return 0

        if removed == 0 or soft.penalty() > 0 or time.monotonic() > deadline - 6:
            return revert()
        try:
            settled = self._settle_warm(soft, deadline, removed)
        except Exception:  # noqa: BLE001 - duong du phong, khong duoc lam hong luot
            settled = None
        if settled is None or soft.penalty() > 0:
            return revert()
        return max(0, placed_before - sum(1 for row in soft.grid for v in row if v >= 0))

    def _shed_overlaps(self, soft: SoftSchedule) -> None:
        """Drop the extra lessons of every teacher double-booking (keep locked
        owners first) so the partial schedule is conflict-free."""

        P = self.P
        for t, slot in list(soft.conflicts):
            owners = [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot] >= 0 and t in P.a_teachers[soft.grid[c][slot]]
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
                            if soft.busy(ai, base + h) > 0:
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
            for t in P.a_teachers[ai]:
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
            if t in P.a_teachers[ai]:
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
                        allowed[x] and soft.grid[c][x] == -1 and soft.busy(ai, x) == 0
                        for x in window
                    )
                    if not ok:
                        continue
                    # keep the teacher's remaining free slots as contiguous as
                    # possible: prefer windows adjacent to teacher's usage
                    # 26/08: o lam vo luat DIA DIEM bi day xuong cuoi hang chu
                    # KHONG bi cam — cam cung lam mat 85 tiet (do 26/08).
                    score = rng.random()
                    loc_bad_win = any(soft.location_blocks(ai, x) for x in window)
                    if loc_bad_win:
                        score += _LOC_AVOID
                    mix = soft.location_mix_cost(ai, window[0])
                    if mix:
                        score += _LOC_MIX * mix
                    if not loc_bad_win and mix == 0:
                        for tm in P.a_teachers[ai]:
                            rt = P.teacher_rules[tm]
                            if rt is None:
                                continue
                            in_s = any(soft.tcnt[tm][base + p] > 0 for p in range(PERIODS))
                            if rt.min_sessions > 0 and in_s:
                                score += 0.25
                            if rt.max_sessions > 0 and not in_s:
                                used_s = sum(
                                    1 for ss in range(NUM_SESSIONS)
                                    if any(soft.tcnt[tm][ss * PERIODS + pp] > 0 for pp in range(PERIODS))
                                )
                                if used_s >= rt.max_sessions:
                                    score += 0.35
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
                loc_bad = 0
                for off in range(size):
                    slot = base + start + off
                    if not allowed[slot] or grid_row[slot] != -1:
                        ok = False
                        break
                    if soft.location_blocks(ai, slot):
                        loc_bad += 1
                    if P.a_teachers[ai] and soft.busy(ai, slot) == 0:
                        free_teacher += 1
                if ok:
                    # 26/08: uu tien manh cac o KHONG pha luat dia diem
                    mix_cost = soft.location_mix_cost(ai, base + start)
                    score = (-free_teacher + rng.random()
                             + (_LOC_AVOID if loc_bad else 0)
                             + _LOC_MIX * mix_cost)
                    if not loc_bad and mix_cost == 0 and free_teacher == size:
                        for tm in P.a_teachers[ai]:
                            rt = P.teacher_rules[tm]
                            if rt is None:
                                continue
                            in_s = any(soft.tcnt[tm][base + p] > 0 for p in range(PERIODS))
                            if rt.min_sessions > 0 and in_s:
                                score += 0.25
                            if rt.max_sessions > 0 and not in_s:
                                used_s = sum(
                                    1 for ss in range(NUM_SESSIONS)
                                    if any(soft.tcnt[tm][ss * PERIODS + pp] > 0 for pp in range(PERIODS))
                                )
                                if used_s >= rt.max_sessions:
                                    score += 0.35
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

    def _report_construct(self, soft: SoftSchedule, force: bool = False) -> None:
        """28/10 (chu du an: "xep moi cham"): phat {stage: construct, placed, expected, conflicts}
        toi da ~1 lan/giay trong luc dung lich; entry._LiveQuality bien thanh nhan cho trang."""
        fn = getattr(self, "_construct_progress", None)
        if fn is None:
            return
        now = time.monotonic()
        if not force and now - getattr(self, "_construct_report_at", 0.0) < 1.0:
            return
        self._construct_report_at = now
        try:
            placed = sum(1 for row in soft.grid for v in row if v >= 0)
            fn({
                "stage": "construct",
                "placed": int(placed),
                "expected": int(sum(self.P.a_periods)),
                "conflicts": int(soft.penalty()),
            })
        except Exception:
            pass

    def _stage1_ready(self, soft: SoftSchedule) -> bool:
        """29/10 (chu du an: "xep moi mat rat lau de dung"): worker vong 1 chi can giao cho vong 2
        MOT luoi gan du tiet: trung gio con lai worker go bot tiet truoc khi tra (_shed_overlaps),
        no luat GV / dia diem vong 2 CP-SAT go nhanh hon pha 2. Do An Phu (869 tiet, 120 s): vong 1
        an 11-24 s de duoi no ma vong 2 vao toi uu nhanh nhu nhau du nhan luoi cua giay 4 hay 12."""

        at = self._stage1_armed_at
        if at <= 0 or time.monotonic() < at:
            return False
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        return placed - soft.overlap >= sum(self.P.a_periods) - 16

    def _phase2(self, soft: SoftSchedule, deadline: float) -> None:
        P = self.P
        rng = self.rng
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        best_pen = soft.penalty_key()
        best_grid = [row[:] for row in soft.grid] if best_pen > (0, 0) else None
        self._tabu: dict[tuple[int, int, int], int] = {}
        stall = 0
        iteration = 0
        while soft.penalty() > 0 and time.monotonic() < deadline:
            if self._stage1_ready(soft):
                break
            iteration += 1
            self._iteration = iteration
            self._report_construct(soft)
            target = self._pick_conflict(soft)
            if target is None:
                break
            c, slot = target
            if not self._repair_cell(soft, c, slot):
                stall += 1
            else:
                stall = 0 if soft.penalty_key() < best_pen else stall + 1
            pen = soft.penalty_key()
            if pen < best_pen:
                best_pen = pen
                best_grid = [row[:] for row in soft.grid]
                stall = 0
            if not soft.conflicts and stall >= 3200:
                break
            if stall > 0 and stall % 120 == 0 and soft.conflicts:
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
                        and t_conf in P.a_teachers[soft.grid[cc][slot_conf]]
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
                pen = soft.penalty_key()
                if pen < best_pen:
                    best_pen = pen
                    best_grid = [row[:] for row in soft.grid]
                    stall = 0
            if stall > 500 and soft.conflicts:
                # hard escape: rebuild the tilings of the conflicted classes
                self._retile_conflicted_classes(soft)
                for t in self._has_rule_teachers:
                    soft.refresh_rule_pen(t)
                stall = 0
        if soft.penalty_key() > best_pen and best_grid is not None:
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
                if ai >= 0 and t in P.a_teachers[ai] and not soft.locked[c][slot]:
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
        if soft._loc_dirty:
            # 26/08: quyet dinh "con no luat de sua khong" phai doc so MOI
            soft.sync_location_pen()
        if not options and soft.rule_pen_total > 0:
            # pick a lesson of a rule-violating teacher
            bad = [t for t in self._has_rule_teachers if soft.rule_pen[t] > 0]
            if not bad:
                return None
            t = rng.choice(bad)
            slots = [slot for slot in range(NUM_SLOTS) if soft.tcnt[t][slot] > 0]
            if not slots:
                return None
            # 23/08: no luat dia diem nam o BUOI cu the -> chon tiet trong buoi
            # do (thay vi tiet bat ky cua GV) de pha 2 sua dung cho.
            # 24/08: luat "tiet 5 sang + tiet 1 chieu" con hep hon, no nam o
            # dung hai o cua ngay vi pham -> gop ca hai kieu no vao mot tap.
            debt_slots = set(soft.edge_pair_debt_slots(t))
            # 13/09 (chu du an: "Gioi han buoi day khi bam Cherry phai tuan thu"):
            # no "sang HOAC chieu" nam o buoi IT tiet hon cua ngay GV day ca hai
            # buoi -> chon tiet trong buoi do (chon tiet bat ky cua GV thi pha 2
            # thuong khong cham toi ngay vi pham va het gio van con no).
            # Buoi co o KHOA cua GV khong the doi di -> nham buoi con lai.
            rule_t = P.teacher_rules[t]
            if rule_t is not None and "either" in rule_t.session_mode:
                def _has_lock(slot_list):
                    return any(
                        soft.locked[cc][x] and soft.grid[cc][x] >= 0 and t in P.a_teachers[soft.grid[cc][x]]
                        for x in slot_list
                        for cc in range(P.num_classes())
                    )

                for d in range(NUM_DAYS):
                    if rule_t.session_mode[d] != "either":
                        continue
                    am = [x for x in slots if x // PERIODS == d * 2]
                    pm = [x for x in slots if x // PERIODS == d * 2 + 1]
                    if not (am and pm):
                        continue
                    lock_am, lock_pm = _has_lock(am), _has_lock(pm)
                    if lock_am and lock_pm:
                        continue
                    if lock_am or lock_pm:
                        debt_slots.update(pm if lock_am else am)
                    else:
                        debt_slots.update(am if len(am) <= len(pm) else pm)
            if rule_t is not None and (rule_t.min_sessions > 0 or rule_t.max_sessions > 0):
                by_s = {s: [x for x in slots if x // PERIODS == s] for s in range(NUM_SESSIONS)}
                used_s = [s for s, lst in by_s.items() if lst]
                if rule_t.min_sessions > 0 and len(used_s) < rule_t.min_sessions:
                    multi_s = []
                    for s in used_s:
                        cls_in_s = {
                            cc for x in by_s[s] for cc in range(P.num_classes())
                            if soft.grid[cc][x] >= 0 and t in P.a_teachers[soft.grid[cc][x]]
                        }
                        if len(cls_in_s) >= 2 or len(by_s[s]) >= 2:
                            multi_s.extend(by_s[s])
                    if multi_s:
                        debt_slots.update(multi_s)
                if rule_t.max_sessions > 0 and len(used_s) > rule_t.max_sessions:
                    min_len = min(len(by_s[s]) for s in used_s)
                    for s in used_s:
                        if len(by_s[s]) <= min_len + 1:
                            debt_slots.update(by_s[s])
            loc_sessions = soft.location_debt_sessions(t)
            if loc_sessions:
                debt_slots.update(
                    slot for slot in slots if (slot // PERIODS) in loc_sessions
                )
            if debt_slots:
                focused = [slot for slot in slots if slot in debt_slots]
                if focused:
                    slots = focused
            slot = rng.choice(slots)
            classes = [
                c
                for c in range(P.num_classes())
                if soft.grid[c][slot] >= 0
                and t in P.a_teachers[soft.grid[c][slot]]
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
            and t in P.a_teachers[soft.grid[c][slot]]
            and not soft.locked[c][slot]
        ]
        if not classes:
            return None
        return (rng.choice(classes), slot)

    def _teacher_has_rules(self, t: int) -> bool:
        P = self.P
        return t >= 0 and (P.teacher_rules[t] is not None or bool(P.teacher_must[t]))

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
        rule_aware = any(self._teacher_has_rules(t_run) for t_run in P.a_teachers[ai])
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
            if rule_aware or (
                other_ai >= 0 and any(self._teacher_has_rules(t_o) for t_o in P.a_teachers[other_ai])
            ):
                # 23/08: GV co luat (dia diem, gioi han buoi/ngay...) -> delta
                # phai gom ca no luat, neu khong pha 2 chi di ngau nhien giua
                # cac nuoc "khong doi trung gio" va kho ve 0.
                pen0 = soft.rule_pen_total
                inverse = self._apply_changes(soft, c, changes)
                delta += soft.rule_pen_total - pen0
                self._apply_changes(soft, c, inverse)
            out.append((delta, changes, base + start))
        # multi-run exchanges (double <-> singles, in- and cross-session)
        for changes, window_start in self._enum_multi_exchanges(soft, c, run, cap=8):
            inverse = self._apply_changes(soft, c, changes)
            delta = 0
            # overlap (+ rule debt, 23/08) delta measured directly
            delta = soft.overlap + soft.rule_pen_total
            self._apply_changes(soft, c, inverse)
            delta = delta - soft.overlap - soft.rule_pen_total
            out.append((delta, changes, window_start))
        out.sort(key=lambda item: item[0])
        return out

    def _enum_multi_exchanges(
        self,
        soft: SoftSchedule,
        c: int,
        run: list[int],
        *,
        no_overlap: bool = False,
        cap: int = 12,
        sessions: set[int] | None = None,
    ):
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
        run_session = run[0] // PERIODS
        run_set = set(run)
        produced = 0
        grid_row = soft.grid[c]
        for s2 in range(NUM_SESSIONS):
            if sessions is not None and s2 not in sessions:
                continue
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
                if no_overlap and any(soft.busy(ai, w) > 0 for w in window):
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
                        for slot_target in targets:
                            if not P.a_allowed[vai][slot_target]:
                                ok = False
                                break
                            if no_overlap and soft.busy(vai, slot_target) > 0 and slot_target not in run_set:
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
            if old >= 0:
                touched.update(P.a_teachers[old])
            if val >= 0:
                touched.update(P.a_teachers[val])
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
                if soft.grid[c][slot] >= 0 and t in P.a_teachers[soft.grid[c][slot]]
            ]

        while queue:
            c = queue.pop()
            if len(comp) > 10:
                return False
            for slot_a, slot_b in ((slot1, slot2), (slot2, slot1)):
                ai = soft.grid[c][slot_a]
                if ai < 0:
                    continue
                for t in P.a_teachers[ai]:
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
            if val >= 0:
                touched_teachers.update(P.a_teachers[val])
        for c, slot, _ in backups:
            ai = soft.grid[c][slot]
            if ai >= 0:
                touched_teachers.update(P.a_teachers[ai])
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
                and t in P.a_teachers[soft.grid[c][slot1]]
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

    def _allow_mask(self, ai: int) -> list[int]:
        """Mat na tiet duoc phep cua mot phan cong, theo tung buoi (tinh 1 lan)."""

        cache = self._amask
        masks = cache.get(ai)
        if masks is None:
            allowed = self.P.a_allowed[ai]
            masks = []
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                v = 0
                for p in range(PERIODS):
                    if allowed[base + p]:
                        v |= _MC_BIT[p]
                masks.append(v)
            cache[ai] = masks
        return masks

    def _enum_quality_moves(self, soft: SoftSchedule, c: int, run: list[int], *, windows_in: set[int] | None = None):
        """Valid no-overlap swaps for a run: yields (changes, window_start).
        windows_in restricts target windows to given sessions.

        Cung ngu nghia voi ban cu, nhung moi phep kiem tra "co o nao ... khong"
        deu la mot phep AND tren mat na PERIODS bit, va khong cap phat list/set
        nao trong vong lap trong cung — chi dung cua so nao qua duoc het cac
        bo loc re moi dung list that.
        """

        P = self.P
        L = len(run)
        grow = soft.grid[c]
        lrow = soft.locked[c]
        a_subject = P.a_subject
        a_teachers = P.a_teachers
        ai = grow[run[0]]
        si = a_subject[ai]
        # 25/08: tiet day ghep -> mat na ban la HOP cua moi giao vien thanh vien
        t_members = a_teachers[ai]
        run_session = run[0] // PERIODS
        run_base = run_session * PERIODS
        run_set = set(run)
        run_mask = 0
        for x in run:
            run_mask |= _MC_BIT[x - run_base]
        allow_ai = self._allow_mask(ai)
        track = soft.track_quality

        def busy_mask(members, s_idx: int, exclude_mask: int = 0, exclude_members=()) -> int:
            base_s = s_idx * PERIODS
            m = 0
            for tm in members:
                if track:
                    mm = soft.ts_mask[tm][s_idx]
                else:
                    row = soft.tcnt[tm]
                    mm = 0
                    for p in range(PERIODS):
                        if row[base_s + p] > 0:
                            mm |= _MC_BIT[p]
                if exclude_mask and tm in exclude_members:
                    mm &= ~exclude_mask
                m |= mm
            return m

        # Mon dang co trong buoi goc, khong ke cac o cua chinh run nay.
        subj_out_run = set()
        for p in range(PERIODS):
            x = run_base + p
            if x in run_set:
                continue
            o = grow[x]
            if o >= 0:
                subj_out_run.add(a_subject[o])

        starts = range(0, PERIODS - L + 1)
        win_masks = []
        for start in starts:
            v = 0
            for off in range(L):
                v |= _MC_BIT[start + off]
            win_masks.append(v)

        run_slot0 = run[0]
        sessions = range(NUM_SESSIONS) if windows_in is None else sorted(windows_in)
        for s in sessions:
            base = s * PERIODS
            same_session = s == run_session
            lock_mask = 0
            si_mask = 0
            for p in range(PERIODS):
                x = base + p
                if lrow[x]:
                    lock_mask |= _MC_BIT[p]
                o = grow[x]
                if o >= 0 and a_subject[o] == si:
                    si_mask |= _MC_BIT[p]
            if t_members:
                busy1 = busy_mask(t_members, s)
                blocked1 = busy1 & ~run_mask if same_session else busy1
            else:
                blocked1 = 0
            allow_s = allow_ai[s]
            for start in starts:
                w0 = base + start
                if w0 == run_slot0:
                    continue
                wm = win_masks[start]
                if lock_mask & wm:
                    continue
                if allow_s & wm != wm:
                    continue
                if not same_session and (si_mask & ~wm):
                    # 23/08: cho phep GHEP SAT tiet cung mon trong buoi dich
                    # (KHTN t3 + KHTN t4 thanh cap doi) — truoc day loai ngay
                    # nen engine khong bao gio thu nuoc ghep cap cho buoi 1
                    # tiet; _class_side_ok_after van kiem cap/lien tiep/luat.
                    if not _mask_contiguous((si_mask & ~wm) | wm):
                        continue
                other_ai = -1
                mixed = False
                for off in range(L):
                    o = grow[w0 + off]
                    if o >= 0:
                        if other_ai < 0:
                            other_ai = o
                        elif o != other_ai:
                            mixed = True
                            break
                if mixed or other_ai == ai:
                    continue
                if blocked1 & wm:
                    # cua so dang bi chinh GV cua run chiem: chi hop le khi do la
                    # tiet other_ai (hoan doi) va other_ai gom DU moi GV cua run
                    if other_ai < 0 or not all(tm in a_teachers[other_ai] for tm in t_members):
                        continue
                if other_ai >= 0:
                    if a_subject[other_ai] == si:
                        continue
                    other_run = self._run_window(
                        soft, c, w0 if grow[w0] >= 0 else w0 + L - 1
                    )
                    if len(other_run) != L or other_run[0] != w0:
                        continue
                    members2 = a_teachers[other_ai]
                    if members2 and members2 != t_members:
                        # GV chung voi run: o cua run dang la chinh tiet ai -> bo qua
                        busy2 = busy_mask(members2, run_session, run_mask, t_members)
                        blocked2 = busy2 & ~wm if same_session else busy2
                        if blocked2 & run_mask:
                            continue
                    if not same_session and a_subject[other_ai] in subj_out_run:
                        so = a_subject[other_ai]
                        om = 0
                        for p in range(PERIODS):
                            x = run_base + p
                            if x not in run_set:
                                o2 = grow[x]
                                if o2 >= 0 and a_subject[o2] == so:
                                    om |= _MC_BIT[p]
                        if not _mask_contiguous(om | run_mask):
                            continue
                    if self._allow_mask(other_ai)[run_session] & run_mask != run_mask:
                        continue
                window = [w0 + off for off in range(L)]
                if not self._class_side_ok_after(soft, c, ai, run, other_ai, window):
                    continue
                changes = [(x, -1) for x in run] + [(window[off], ai) for off in range(L)]
                if other_ai >= 0:
                    changes += [(run[off], other_ai) for off in range(L)]
                yield changes, w0
        # 23/08: khoi doi <-> 2 tiet le cung duoc liet ke cho "tiet ban" tu buoi
        # khac (windows_in) — truoc day chi khi xet cac run ngay trong buoi dich,
        # nen GV toan khoi doi (GDTC) khong bao gio keo duoc khoi vao sat tiet
        # le cua minh.
        yield from self._enum_multi_exchanges(
            soft, c, run, no_overlap=True, cap=8, sessions=windows_in
        )


    def _quality_score(self, soft: SoftSchedule, weights: tuple[int, int, int, int]) -> int:
        # 26/08: so hang `rule_pen_total * 10**13` ben duoi chi co y nghia khi
        # no luat cua cac GV vua bi dong den da duoc cap nhat. Khong co dong nay
        # thi moi toan tu toi uu chat luong (Kempe, shake, retile, LNS cum...)
        # deu cham diem bang no DIA DIEM CU -> tu do day GV qua lai giua 2 co so.
        if soft._loc_dirty:
            soft.sync_location_pen()
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
        lock_s = self._lock_singleton
        if lock_s is not None and soft.q_singleton > lock_s:
            score += (soft.q_singleton - lock_s) * _LOCK_PENALTY
        lock_g = self._lock_gap2
        if lock_g is not None and soft.q_gap2 > lock_g:
            score += (soft.q_gap2 - lock_g) * _LOCK_PENALTY
        return score

    def _lock_violated(self, soft: SoftSchedule) -> bool:
        """True khi trang thai hien tai vuot mot chi so da khoa."""

        lock_s = self._lock_singleton
        if lock_s is not None and soft.q_singleton > lock_s:
            return True
        lock_g = self._lock_gap2
        return lock_g is not None and soft.q_gap2 > lock_g

    def _stage_info(self, info: dict) -> None:
        info["stages"] = list(self._stage_log)
        info["locks"] = {"one_period": self._lock_singleton, "gap2": self._lock_gap2}
        if self._cpsat_stats:
            info["cpsat_lns"] = dict(self._cpsat_stats)
        info["quality_ejected"] = list(self._quality_ejected)
        info["quality_unavoidable"] = list(self._quality_unavoidable)
        info["quality_eject_skipped"] = dict(self._quality_eject_skipped)

    def _singleton_floor_teachers(self) -> set[int]:
        P = self.P
        load: dict[int, int] = {}
        for ai in range(P.num_assignments()):
            for t in P.a_teachers[ai]:
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
            for t in P.a_teachers[ai]:
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
        # 23/08 (ca Nhac.Duong, TKB default): san "SUC CHUA" tinh theo o ma MOT
        # tiet nao do cua GV duoc phep (a_allowed = ranh GV & luat mon & lich
        # lop) chu khong theo o ranh GV thuan: GV ranh T7 nhung khong lop nao
        # hoc T7; T3 chieu/T4 chieu moi buoi chi con 1 o; cac buoi con >= 2 o
        # chi chua toi da 18/20 tiet -> bat buoc >= 2 buoi 1 tiet. Khong co
        # thuat toan nao go duoc, nen KHONG tinh la no (va bao nguoi dung).
        cap_floor: dict[int, tuple[int, set[int], int]] = {}
        per_t_assign: dict[int, list[int]] = {}
        for ai in range(P.num_assignments()):
            for t in P.a_teachers[ai]:
                per_t_assign.setdefault(t, []).append(ai)
        for t, L in load.items():
            if L <= 1:
                continue
            ais = per_t_assign.get(t) or []
            # 19/09: OR san a_allowed mot lan / GV thay vi any(...) moi o —
            # cung ket qua, it nhay Python hon tren truong 75 lop.
            usable_mask = [False] * NUM_SLOTS
            for ai in ais:
                allowed = P.a_allowed[ai]
                for slot in range(NUM_SLOTS):
                    if allowed[slot]:
                        usable_mask[slot] = True
            one_cell: set[int] = set()
            multi_cap = 0
            for s in range(NUM_SESSIONS):
                base = s * PERIODS
                usable = 0
                for p in range(PERIODS):
                    slot = base + p
                    if P.teacher_avail[t][slot] and usable_mask[slot]:
                        usable += 1
                if usable == 1:
                    one_cell.add(s)
                elif usable >= 2:
                    multi_cap += usable
            forced = L - multi_cap
            if forced >= 1 and one_cell:
                forced = min(forced, len(one_cell))
                cap_floor[t] = (forced, one_cell, multi_cap)
                evidence.append({
                    "kind": "forced_one_period_capacity",
                    "teacher": P.teacher_names[t],
                    "sessions": sorted(one_cell),
                    "forced": forced,
                    "reason": (
                        "cac buoi con >= 2 o hop le chi chua duoc %d/%d tiet; %d buoi chi con 1 o"
                        % (multi_cap, L, len(one_cell))
                    ),
                })
        self._cap_floor = cap_floor
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

        25/08: lich con tiet Chua phan o mon co "toi thieu 1 cap 2 tiet" truoc
        day bi coi la LOP HONG (hard:lesson_blocks_min_2) -> xep lai ca lop, roi
        re-tile de lai no luat -> vut ca luoi warm -> xay lai ca truong (do tren
        truong default: chi 60 tiet thieu la mat warm-start, ket qua xau hon
        lich nguoi dung o 3/4 chi so). Gio: mon con thieu tiet duoc TAM CHAP
        NHAN thieu cap, tiet thieu duoc chen theo CAP, cap doi con vo thi ghep
        bang hoan doi trong lop, bat dac di moi xep lai lop do.
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
        missing_total = 0
        missing_cs: set[tuple[int, int]] = set()
        for ai in range(P.num_assignments()):
            gap = P.a_periods[ai] - placed_per_ai.get(ai, 0)
            if gap > 0:
                # 23/08: lop thieu tiet KHONG xep lai ca lop nua (mat lich cua
                # nguoi dung); tiet thieu duoc thu xep vao o trong sau khi sua,
                # khong duoc thi van la Chua phan (best-effort) nhu lan truoc.
                missing_total += gap
                missing_cs.add((P.a_class[ai], P.a_subject[ai]))
            elif gap < 0:
                dirty.add(P.a_class[ai])
        for c in range(P.num_classes()):
            if c in dirty:
                continue
            if self._class_rule_break(soft, c, tolerate_min_for=missing_cs) is not None:
                dirty.add(c)
        # Qua nhieu lop hong thi khong con la "sua cuc bo" nua
        if len(dirty) > max(8, (P.num_classes() * 3) // 4):
            return None
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        # No luat cua chinh lich nguoi dung dang dung — moc de so "co tot hon
        # khong" o ca hai nhanh ben duoi.
        warm_pen0 = soft.penalty()
        if not dirty:
            if soft.penalty() <= 0:
                if missing_total <= 0 and not self._min_block_breaks(soft):
                    return None
                # chi thieu tiet (khong no luat): thu xep lai roi tra ve
                # (bat theo doi chat luong de chon o "trung tinh" dung)
                return self._settle_warm(soft, deadline, missing_total)
            # 23/08: lich vao moi lop hop le, chi con no luat GV (trung gio,
            # yeu cau dia diem vua bat, gioi han buoi...). Truoc day tra None
            # -> xay lai CA TRUONG tu dau va mat lich cua nguoi dung; gio giu
            # nguyen luoi, chi dung pha 2 (doi cho trong lop) go cac no do.
            pen_before = warm_pen0
            self._phase2(soft, min(deadline - 3, time.monotonic() + self._warm_repair_phase2_budget(max(20.0, (deadline - time.monotonic()) * 0.4))))
            if soft.penalty() != 0:
                # 24/08 (chi dao chu du an: "lam duoc thi linh dong sap xep
                # chu, sao lai bao sai"): truoc day day la tat-hoac-khong — go
                # SACH no luat thi giu, con lai vut CA luoi warm va xep lai tu
                # dau ca truong. Lich that cua truong `default` co san 21 no
                # kieu "tiet 5 sang + tiet 1 chieu"; pha 2 go duoc hon mot nua
                # nhung khong bao gio ve 0, nen moi lan bam Cherry deu xay lai
                # tu dau, ra lich xau hon han (54 buoi 1 tiet so voi 4) roi bi
                # cong chat luong tu choi -> nguoi dung bam bao nhieu lan cung
                # thay y nguyen loi cu. Gio: khong con TRUNG GIO va no luat
                # GIAM THAT thi giu luoi da sua; lan bam sau giam tiep.
                if soft.overlap > 0 or soft.penalty() >= pen_before:
                    placed = sum(1 for row in soft.grid for v in row if v >= 0)
                    self._last_load_fail = "repair_rules_incomplete:%d:penalty:%d" % (
                        expected - placed,
                        soft.penalty(),
                    )
                    return None
                self._last_load_fail = "repair_rules_partial:%d->%d" % (pen_before, soft.penalty())
            return self._settle_warm(soft, deadline, missing_total)

        if not self._retile_classes(soft, dirty, deadline):
            return None
        # con trung gio giao vien / no luat GV thi de phase 2 go
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        if soft.penalty() > 0:
            self._phase2(soft, min(deadline - 3, time.monotonic() + self._warm_repair_phase2_budget(20.0)))
        if soft.penalty() != 0:
            # 24/08: cung hop dong voi nhanh "chi no luat" o tren — lich cua
            # nguoi dung thuong da co san no luat GV, doi go SACH moi giu la
            # tat-hoac-khong va lam ca truong bi xep lai tu dau moi lan bam.
            if soft.overlap > 0 or soft.penalty() >= warm_pen0:
                placed = sum(1 for row in soft.grid for v in row if v >= 0)
                self._last_load_fail = "repair_incomplete:%d:penalty:%d" % (expected - placed, soft.penalty())
                return None
            self._last_load_fail = "repair_partial:%d->%d" % (warm_pen0, soft.penalty())
        return self._settle_warm(soft, deadline, missing_total)

    def _class_rule_break(
        self, soft: SoftSchedule, c: int, *, tolerate_min_for: set[tuple[int, int]] | None = None
    ) -> str | None:
        """Ly do dau tien lop c vi pham luat lop (buoi / tuan cua mon / ngay),
        hoac None. `tolerate_min_for`: cac (lop, mon) con THIEU tiet — thieu cap
        doi (lesson_blocks_min) cua chung khong tinh la hong vi tiet thieu se
        duoc chen thanh cap."""

        P = self.P
        for s in range(NUM_SESSIONS):
            why = checks.check_class_session(P, soft.grid, c, s, False)
            if why is not None:
                return why
        for d in range(6):
            why = checks.check_class_day(P, soft.grid, c, d)
            if why is not None:
                return why
        # 22/08 (toi): luat TUAN cua mon (min cap tiet doi, gioi han
        # ngay/tuan, gian cach...) truoc day khong duoc xem la "lop
        # hong" -> _load_state van tu choi -> xay lai TU DAU ca truong.
        subjects = {P.a_subject[ai] for ai in soft.grid[c] if ai >= 0}
        for si in subjects:
            why = checks.check_class_subject_week(P, soft.grid, c, si, -1, False)
            if why is None:
                continue
            if (
                tolerate_min_for
                and why.startswith("lesson_blocks_min")
                and (c, si) in tolerate_min_for
            ):
                continue
            return why
        return None

    def _retile_classes(self, soft: SoftSchedule, classes: set[int], deadline: float) -> bool:
        """Xoa moi o KHONG co dinh cua cac lop roi xep lai tung lop (chi kiem
        luat phia lop; trung gio GV de pha 2 go sau)."""

        P = self.P
        fixed_per_ai: dict[int, int] = {}
        for c, slot, ai in P.fixed_cells:
            fixed_per_ai[ai] = fixed_per_ai.get(ai, 0) + 1
        for c in classes:
            for slot in range(NUM_SLOTS):
                if soft.grid[c][slot] >= 0 and not soft.locked[c][slot]:
                    soft.set_cell(c, slot, -1)
        for c in sorted(classes):
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
                return False
            if time.monotonic() > deadline - 5:
                return False
        return True

    def _min_block_breaks(self, soft: SoftSchedule) -> list[tuple[int, int]]:
        """Cac (lop, mon) dang thieu cap tiet doi theo luat lesson_blocks (min)."""

        P = self.P
        out: list[tuple[int, int]] = []
        for c in range(P.num_classes()):
            subjects = {P.a_subject[ai] for ai in soft.grid[c] if ai >= 0}
            for si in sorted(subjects):
                why = checks.check_class_subject_week(P, soft.grid, c, si, -1, False)
                if why is not None and why.startswith("lesson_blocks_min"):
                    out.append((c, si))
        return out

    def _settle_warm(self, soft: SoftSchedule, deadline: float, missing_total: int) -> SoftSchedule | None:
        """Buoc cuoi cua sua warm: chen tiet thieu (theo cap khi mon can cap
        doi), ghep cap doi con vo bang hoan doi trong lop, bat dac di xep lai
        lop con vo; roi kiem tra cung."""

        soft.enable_quality_tracking()
        if missing_total > 0:
            self._insert_missing_quality_neutral(soft)
        broken = self._min_block_breaks(soft)
        for c, si in broken:
            self._fix_min_block(soft, c, si)
        still = {c for c, _si in self._min_block_breaks(soft)}
        if still and time.monotonic() < deadline - 6:
            pen_before = soft.penalty()
            grid_before = [row[:] for row in soft.grid]
            ok = self._retile_classes(soft, still, deadline)
            if ok:
                for t in self._has_rule_teachers:
                    soft.refresh_rule_pen(t)
                if soft.penalty() > pen_before:
                    self._phase2(soft, min(deadline - 3, time.monotonic() + 10.0))
                ok = soft.penalty() <= pen_before
            if not ok:
                self._restore_grid(soft, grid_before)
            else:
                self._insert_missing_quality_neutral(soft)
            self._last_load_fail = "min_block_retile:%d:%s" % (len(still), "kept" if ok else "reverted")
        if self._load_state(soft) is None:
            return None
        return soft

    def _needs_double(self, soft: SoftSchedule, ai: int) -> bool:
        """Mon (lop, phan cong ai) con thieu cap 2 tiet theo luat lesson_blocks."""

        P = self.P
        rule = P.a_rule[ai]
        if rule is None or not rule.lesson_blocks:
            return False
        need = 0
        for length, minimum, _mx in rule.lesson_blocks:
            if length == 2 and minimum > 0:
                need = max(need, minimum)
        if need <= 0:
            return False
        sessions = checks.class_subject_sessions(P, soft.grid, P.a_class[ai], P.a_subject[ai])
        blocks = sum(1 for ps in sessions.values() if len(ps) >= 2)
        return blocks < need

    def _insert_pair_neutral(self, soft: SoftSchedule, ai: int, *, allow_debt: bool = False) -> bool:
        """Chen 2 tiet LIEN TIEP cua phan cong ai vao mot buoi (cung hop dong voi
        _insert_one_neutral). Can cho mon co luat "toi thieu 1 cap 2 tiet": chen
        tung tiet le khong bao gio qua duoc kiem tra lesson_blocks_min."""

        P = self.P
        c = P.a_class[ai]
        si = P.a_subject[ai]
        if P.a_cap[ai] < 2:
            return False
        q0 = (soft.q_singleton, soft.q_gap2)
        pen0 = soft.penalty()
        weights = (10**11, 10**8, 10**5, 10)
        best: tuple[int, int] | None = None
        for s in range(NUM_SESSIONS):
            base = s * PERIODS
            for p in range(PERIODS - 1):
                a, b = base + p, base + p + 1
                if soft.grid[c][a] >= 0 or soft.grid[c][b] >= 0:
                    continue
                if soft.locked[c][a] or soft.locked[c][b]:
                    continue
                if not (P.a_allowed[ai][a] and P.a_allowed[ai][b]):
                    continue
                if soft.busy(ai, a) > 0 or soft.busy(ai, b) > 0:
                    continue
                holes0 = self._class_interior_holes(soft, c, s)
                inverse = self._apply_changes(soft, c, [(a, ai), (b, ai)])
                ok = (
                    soft.penalty() <= pen0
                    and (allow_debt or (soft.q_singleton <= q0[0] and soft.q_gap2 <= q0[1]))
                    and checks.check_class_session(P, soft.grid, c, s, False) is None
                    and checks.check_class_subject_week(P, soft.grid, c, si, ai, False) is None
                    and checks.check_class_day(P, soft.grid, c, s // 2) is None
                    and self._class_interior_holes(soft, c, s) <= holes0
                    and not self._lock_violated(soft)
                )
                if ok:
                    score = self._quality_score(soft, weights)
                    if best is None or score < best[0]:
                        best = (score, a)
                self._apply_changes(soft, c, inverse)
        if best is None:
            return False
        self._apply_changes(soft, c, [(best[1], ai), (best[1] + 1, ai)])
        return True

    def _fix_min_block(self, soft: SoftSchedule, c: int, si: int) -> bool:
        """Mon (c, si) co >= 2 tiet le ma thieu cap doi: dua mot tiet le sang o
        SAT mot tiet le khac (hoan doi voi tiet dang o do, hoac vao o trong),
        khong pha luat lop, khong tang no GV, khong tao lo cho hoc sinh."""

        P = self.P
        sessions = checks.class_subject_sessions(P, soft.grid, c, si)
        singles = [(s, ps[0]) for s, ps in sessions.items() if len(ps) == 1]
        if len(singles) < 2:
            return False
        pen0 = soft.penalty()
        q0 = (soft.q_singleton, soft.q_gap2)
        for s1, p1 in singles:
            base1 = s1 * PERIODS
            slot1 = base1 + p1
            ai1 = soft.grid[c][slot1]
            if ai1 < 0 or P.a_cap[ai1] < 2:
                continue
            for adj_p in (p1 - 1, p1 + 1):
                if not (0 <= adj_p < PERIODS):
                    continue
                adj = base1 + adj_p
                if soft.locked[c][adj] or not P.class_avail[c][adj] or not P.a_allowed[ai1][adj]:
                    continue
                if soft.busy(ai1, adj) > 0:
                    continue
                occupant = soft.grid[c][adj]
                if occupant >= 0 and P.a_subject[occupant] == si:
                    continue
                for s2, p2 in singles:
                    if s2 == s1:
                        continue
                    slot2 = s2 * PERIODS + p2
                    if soft.locked[c][slot2]:
                        continue
                    ai2 = soft.grid[c][slot2]
                    if ai2 < 0:
                        continue
                    if occupant >= 0:
                        if not P.a_allowed[occupant][slot2]:
                            continue
                        if soft.busy(occupant, slot2) > 0:
                            continue
                        changes = [(adj, ai2), (slot2, occupant)]
                    else:
                        changes = [(adj, ai2), (slot2, -1)]
                    holes2 = self._class_interior_holes(soft, c, s2)
                    holes1 = self._class_interior_holes(soft, c, s1)
                    inverse = self._apply_changes(soft, c, changes)
                    ok = (
                        soft.penalty() <= pen0
                        and soft.q_singleton <= q0[0]
                        and soft.q_gap2 <= q0[1]
                        and checks.check_class_session(P, soft.grid, c, s1, False) is None
                        and checks.check_class_session(P, soft.grid, c, s2, False) is None
                        and checks.check_class_day(P, soft.grid, c, s1 // 2) is None
                        and checks.check_class_day(P, soft.grid, c, s2 // 2) is None
                        and checks.check_class_subject_week(P, soft.grid, c, si, ai2, False) is None
                        and (
                            occupant < 0
                            or checks.check_class_subject_week(
                                P, soft.grid, c, P.a_subject[occupant], occupant, False
                            ) is None
                        )
                        and self._class_interior_holes(soft, c, s1) <= holes1
                        and self._class_interior_holes(soft, c, s2) <= holes2
                        and not self._lock_violated(soft)
                    )
                    if ok:
                        return True
                    self._apply_changes(soft, c, inverse)
        return False

    def phase3_quality(self, soft: SoftSchedule, deadline: float, *, progress=None) -> None:
        """Tabu-walk the quality tuple down (singleton -> gap2 -> sessions -> gap1)."""

        P = self.P
        rng = self.rng
        # 19/09: structural_floors doi sau emit_quality dau (xem ben duoi) de
        # UI thay so lieu ngay; floor_teachers chi can truoc vong tabu.
        # 22/08 (toi): dieu kien "da cham san" cua bac 1/2 dua tren so no CON
        # XU LY DUOC (tru cac buoi san cau truc mien tru), khong phai so sanh
        # tong so buoi 1 tiet voi tong so san: truoc day 3 buoi san o GV khac
        # + 3 buoi le sua duoc van bi coi la "floor" va bac 1 ket thuc som.
        act0 = self._actionable_debts(soft)
        weights = (10**11, 10**8, 10**5, 10)
        # 22/08 (chi dao chu du an): toi uu GIAO VIEN theo BAC co KHOA.
        #   Bac 1: giam "buoi 1 tiet" ve thap nhat      -> KHOA (khong duoc tang)
        #   Bac 2: giam "buoi trong >= 2" ve thap nhat -> KHOA
        #   Bac 3: giam tong buoi day + trong 1 tiet (chi so da khoa khong bao
        #          gio xau di: nuoc di vuot khoa bi loai ngay tu khi liet ke,
        #          ke ca khi lac/thoat ket).
        # Lich warm-start DA DU: bac nao da o san thi khoa ngay o muc hien tai,
        # nen ket qua khong bao gio xau hon lich nguoi dung dang co.
        self._lock_singleton = None
        self._lock_gap2 = None
        self._stage_log = []
        self._force_fail_at = {}
        started_at = time.monotonic()
        budget = max(1.0, deadline - started_at)
        # 22/08 (dem): menu "Toi uu v3" — MOT muc tieu rieng le, cac chi so
        # con lai bi KHOA o muc hien tai (khong duoc xau di), khong vi pham
        # rang buoc (moi nuoc di van qua kiem tra cung nhu thuong).
        focus = self.quality_focus
        stage_only: int | None = None
        # 23/08 (trua, chu du an: "toi uu 1 tiet trong v3 con yeu qua, gan nhu
        # khong toi uu duoc"): do tren truong default (185 trong 1) — lane gap1
        # thoat "converged" sau 25s idle ma chat luong Y NGUYEN xuat phat, vi
        # (a) bac 3 bo cuoc som theo stagnation_limit, (b) moi toan tu manh
        # (chuoi, ep-roi-sua, re-tile) chi nham vao no buoi 1 tiet / trong >= 2
        # hoac buoi mong, KHONG BAO GIO nham vao lo 1 tiet. Nay lane mot muc
        # tieu bac 3 (gap1/sessions) chay TRON ngan sach, va voi gap1 cac toan
        # tu sau nham thang vao cac buoi ho 1 tiet (_gap1_sessions_of).
        focus_stage3 = focus in ("gap1", "sessions")
        if focus == "gap1":
            # Nut "Toi uu trong 1 tiet": gap1 nang hon so buoi; so buoi bi khoa
            # cung o muc hien tai qua _session_cap trong _quality_score. Hai chi
            # so dau khoa ngay (lich da dat, chi tinh chinh trong 1).
            # 26/08: TKB_GAP1_SESSION_SLACK (mac dinh 0 = giu hop dong "khong
            # tang buoi"; cong ngoai entry._focus_gate noi cung gia tri) — thi
            # nghiem hai muc tieu danh nhau: tren luoi 625/159, ep lap lo tim
            # duoc 148 nhung phai +5 buoi nen bi tran buoi loai het.
            self._session_cap = soft.q_sessions + _gap1_session_slack()
            weights = (10**11, 10**8, 100, 10**4)
            self._lock_singleton = soft.q_singleton
            self._lock_gap2 = soft.q_gap2
            stage = 3
        elif focus == "sessions":
            # Nut "Buoi day": chi giam tong buoi day (trong 1 la thu yeu); buoi
            # 1 tiet / trong >= 2 khoa ngay o muc hien tai.
            self._lock_singleton = soft.q_singleton
            self._lock_gap2 = soft.q_gap2
            stage = 3
        elif focus == "singletons":
            # Nut "1 tiet/buoi": chi bac 1; trong >= 2 va so buoi khong duoc tang.
            self._lock_gap2 = soft.q_gap2
            self._session_cap = soft.q_sessions
            stage = 1
            stage_only = 1
        elif focus == "gap2":
            # Nut "2 tiet trong": chi bac 2; buoi 1 tiet va so buoi khong duoc tang.
            self._lock_singleton = soft.q_singleton
            self._session_cap = soft.q_sessions
            stage = 2
            stage_only = 2
        elif act0[0] > 0:
            stage = 1
        elif act0[1] > 0:
            stage = 2
            self._lock_singleton = soft.q_singleton
        else:
            stage = 3
            self._lock_singleton = soft.q_singleton
            self._lock_gap2 = soft.q_gap2
        best_grid = [row[:] for row in soft.grid]
        # 19/09: PHAT khung quality TRUOC structural_floors — floors quet
        # a_allowed theo GV/tiet (truong 75 lop co the mat vai giay). Nguoi dung
        # thay so lieu X ➔ X ngay khi vao bac 3 thay vi cho den khi floors xong.
        best_q = soft.quality()
        best_act = act0
        tabu: dict[tuple[int, int, int], int] = {}
        iteration = 0
        stall = 0
        last_report = 0.0

        def emit_quality(force: bool = False) -> None:
            # 22/08 (khuya): khung so lieu co cau truc cho bridge ("Day 1 tiet:
            # 43 -> 4"); phat ngay khi vao bac va khi ket thuc, giua chung moi 2s.
            nonlocal last_report
            if progress is None:
                return
            now = time.monotonic()
            if not force and now - last_report <= 2.0:
                return
            last_report = now
            # 25/08 (chu du an: "dang giam lai thay tang"): phat chat luong cua
            # luoi TOT NHAT da dat (best_q), khong phai luoi DANG THU — tabu co
            # y nhan nuoc di xau de thoat ket nen so "dang thu" nhay len xuong,
            # lam nguoi dung tuong ket qua xau di. Ket qua ap luon la best.
            q = best_q
            q_trial = soft.quality()
            self._offer_focus_candidate(best_grid, best_q)
            try:
                progress({
                    "stage": "optimize:quality",
                    "message": "Bac %d/3: 1tiet=%d trong2=%d buoi=%d trong1=%d"
                    % (stage, q[0], q[1], q[2], q[3]),
                    "phase_stage": stage,
                    "quality": [int(q[0]), int(q[1]), int(q[2]), int(q[3])],
                    "quality_trial": [int(q_trial[0]), int(q_trial[1]), int(q_trial[2]), int(q_trial[3])],
                    # 23/08: so lan "ep lap roi sua" da thu (nut gap1) de nhan
                    # tien do cho thay engine dang lam viec giua hai lan giam.
                    "sweep_tried": int(getattr(self, "_sweep_tried", 0)),
                })
            except Exception:
                pass

        emit_quality(force=True)

        if not hasattr(self, "_floors_cache"):
            self._floors_cache = self.structural_floors()
        forced_singles, forced_gap2s, _evidence = self._floors_cache
        floor_teachers = {t for t, s in forced_singles}
        best_score = self._quality_score(soft, weights)
        # Tra nhanh khi da hoi tu: neu khong con cai thien duoc gi trong mot
        # khoang dai thi dung som, khong dot not ngan sach.
        stagnation_limit = max(25.0, min(90.0, budget * 0.25))
        # Kien nhan tung bac (idle = khong cai thien) + tran thoi gian cua bac
        # 1/2 de bac sau luon con ngan sach.
        # 22/08 (toi, chi dao chu du an: "tap trung toi uu them 1 tiet/buoi va
        # 2 tiet trong"): bac 1/2 duoc uu tien ngan sach — kien nhan dai hon va
        # tran cao hon; bac 3 (buoi day / trong 1) chi nhan phan con lai.
        if self.cherry_cpsat and self.quality_focus is None:
            stagnation_limit = 1.2
            stage_patience = {
                1: 1.5,
                2: 1.0,
                3: 1.2,
            }
            stage_cap = {
                1: started_at + budget * 0.80,
                2: started_at + budget * 0.90,
                3: deadline,
            }
        else:
            stage_patience = {
                1: max(30.0, budget * 0.40),
                2: max(20.0, budget * 0.30),
                3: stagnation_limit,
            }
            stage_cap = {
                1: started_at + budget * 0.75,
                2: started_at + budget * 0.92,
                3: deadline,
            }
        if stage_only is not None:
            # Nut mot muc tieu (chu du an 22/08 khuya: "rang khu toi da ve 0"):
            # bac do duoc dung TRON ngan sach — khong chuyen bac, khong bo cuoc
            # som vi "idle"; chi dung khi het no xu ly duoc hoac het gio.
            stage_patience[stage_only] = budget + 1.0
            stage_cap[stage_only] = deadline
        stage_started = started_at
        last_improve_at = started_at
        # 23/08 (trua): nut "1 tiet trong" — tabu 2-hoan-doi gan nhu bat luc
        # (do: 0 cai thien sau 25s), con "ep lap roi sua" thanh cong ~1/4 so
        # buoi thu (60 luot -> -22 trong 1). Vi vay lane gap1 quet ep dinh ky
        # theo THOI GIAN (moi ~2s, moi dot toi da 6s) thay vi chi moi 600 buoc.
        # 26/08: dot quet dau tien ngay tu vong lap 1 (khong doi 2 s tabu):
        # tren luoi warm sach, toan tu quet/CP-SAT la cai sinh ra cai thien.
        last_sweep = started_at - 2.0
        self._sweep_tried = 0

        def restore_best() -> None:
            current = [row[:] for row in soft.grid]
            for c in range(P.num_classes()):
                for slot in range(NUM_SLOTS):
                    if current[c][slot] != best_grid[c][slot]:
                        soft.set_cell(c, slot, best_grid[c][slot])
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)

        def enter_stage(next_stage: int, reason: str) -> None:
            nonlocal stage, stage_started, stall, last_improve_at
            # KHOA tren luoi TOT NHAT cua bac vua xong.
            restore_best()
            now = time.monotonic()
            self._stage_log.append(
                {
                    "stage": stage,
                    "exit": reason,
                    "seconds": round(now - stage_started, 1),
                    "quality": list(soft.quality()[:4]),
                }
            )
            if stage <= 1 or self._lock_singleton is None:
                self._lock_singleton = soft.q_singleton
            if next_stage >= 3:
                self._lock_gap2 = soft.q_gap2
            stage = next_stage
            stage_started = now
            stall = 0
            last_improve_at = now
            tabu.clear()

        stopped = False
        while time.monotonic() < deadline:
            if self._stop_requested():
                stopped = True
                break
            iteration += 1
            now = time.monotonic()
            if stage == 1 and (
                best_act[0] == 0
                or now - last_improve_at > stage_patience[1]
                or now > stage_cap[1]
            ):
                reason = "floor" if best_act[0] == 0 else (
                    "idle" if now - last_improve_at > stage_patience[1] else "cap"
                )
                if stage_only == 1:
                    restore_best()
                    self._stage_log.append({"stage": 1, "exit": reason, "seconds": round(now - stage_started, 1), "quality": list(soft.quality()[:4])})
                    stage_started = now
                    break
                enter_stage(2 if best_act[1] > 0 else 3, reason)
                continue
            if stage == 2 and (
                best_act[1] == 0
                or now - last_improve_at > stage_patience[2]
                or now > stage_cap[2]
            ):
                reason = "zero" if best_act[1] == 0 else (
                    "idle" if now - last_improve_at > stage_patience[2] else "cap"
                )
                if stage_only == 2:
                    restore_best()
                    self._stage_log.append({"stage": 2, "exit": reason, "seconds": round(now - stage_started, 1), "quality": list(soft.quality()[:4])})
                    stage_started = now
                    break
                enter_stage(3, reason)
                continue
            target = self._pick_quality_target(soft, rng, floor_teachers, stage)
            if target is None:
                if stage_only is not None:
                    restore_best()
                    self._stage_log.append({"stage": stage, "exit": "no-target", "seconds": round(time.monotonic() - stage_started, 1), "quality": list(soft.quality()[:4])})
                    stage_started = time.monotonic()
                    break
                if stage < 3:
                    enter_stage(2 if (stage == 1 and best_act[1] > 0) else 3, "no-target")
                    continue
                break
            moved = self._quality_step(soft, target, weights, tabu, iteration, floor_teachers)
            score = self._quality_score(soft, weights)
            if score < best_score:
                best_score = score
                best_grid = [row[:] for row in soft.grid]
                best_q = soft.quality()
                best_act = self._actionable_debts(soft)
                stall = 0
                last_improve_at = time.monotonic()
            else:
                stall += 1
            # 25/08: nut "Buoi day" cung quet dinh ky (don buoi mong roi sua)
            # — tabu 2-hoan-doi khong bao gio go noi mot buoi 2-3 tiet.
            # 26/08: co CP-SAT thi quet LIEN TUC (tabu giua hai dot chi la
            # nhieu), khong co thi moi 2 s nhu cu.
            sweep_gap = 0.0 if (focus_stage3 and self._cpsat_available()) else 2.0
            if focus in ("gap1", "sessions") and time.monotonic() - last_sweep >= sweep_gap and time.monotonic() < deadline - 1.0:
                if soft.penalty() > 0 or soft.quality()[2] > best_q[2]:
                    # quet ep chi co nghia tren trang thai SACH va KHONG vuot
                    # tran buoi: tabu hay de lai trang thai nhieu buoi hon best
                    # (gap1: 629 khi tran 625) -> moi nuoc ep tren do deu bi
                    # tran buoi (10^9) loai; don buoi tren do chi la "go lai".
                    restore_best()
                    tabu.clear()
                # 23/08 (chu du an, muc A): chia dot quet thanh cac lat ~2s va
                # phat khung so lieu sau moi lat, de nhan "Trong 1 tiet: X -> Y
                # · da thu n lo" chay lien tuc thay vi dung im 6-8s moi dot.
                # 26/08: toan tu manh nhat di TRUOC — CP-SAT LNS theo cum (giai
                # lai ca cum lop mot luc, khoa/tran la rang buoc trong mo hinh):
                # pass ngan 3 s trong 10 s dau de nguoi dung thay so giam ngay,
                # sau do 8 s. Ep-ghep/don-buoi chay tiep phan con lai cua dot.
                cp_improved = False
                cp_ran = False
                if self._cpsat_available():
                    loop_elapsed = time.monotonic() - started_at
                    cp_limit = 3.0 if loop_elapsed < 10.0 else 8.0
                    cp_ran = True
                    if self._cpsat_cluster_pass(
                        soft, weights, floor_teachers, deadline, iteration, pass_limit=cp_limit
                    ):
                        score = self._quality_score(soft, weights)
                        if score < best_score:
                            best_score = score
                            best_grid = [row[:] for row in soft.grid]
                            best_q = soft.quality()
                            best_act = self._actionable_debts(soft)
                            stall = 0
                            last_improve_at = time.monotonic()
                            cp_improved = True
                            emit_quality(force=True)
                # co CP-SAT: ep-ghep/don-buoi chi danh bong 1 s roi quay lai
                # CP-SAT ngay; khong co: dot quet 6 s nhu cu.
                sweep_end = min(deadline, time.monotonic() + (1.0 if cp_ran else 6.0))
                while time.monotonic() < sweep_end and not self._stop_requested():
                    chunk_end = min(sweep_end, time.monotonic() + 1.0)
                    if self._force_pair_endgame(soft, weights, floor_teachers, chunk_end, stage, iteration):
                        score = self._quality_score(soft, weights)
                        if os.environ.get("TKB_EVAC_DEBUG"):
                            sys.stderr.write(f"[sweep] score={score} best={best_score} q={soft.quality()[:4]} best_q={best_q[:4]} pen={soft.penalty()}\n")
                        if score < best_score:
                            best_score = score
                            best_grid = [row[:] for row in soft.grid]
                            best_q = soft.quality()
                            best_act = self._actionable_debts(soft)
                            stall = 0
                            last_improve_at = time.monotonic()
                            emit_quality(force=True)
                    elif self._fpe_last_debts == 0:
                        break
                    emit_quality()
                last_sweep = time.monotonic()
            idle = time.monotonic() - last_improve_at
            if stage >= 3 and idle > stagnation_limit and not focus_stage3:
                # Da on: khong con cai thien duoc gi -> tra ket qua ngay, khong
                # dot not ngan sach (vi du Cloud Run cap 300s van co the xong
                # sau 100s). Bac 1/2 co kien nhan rieng o tren. Nut mot muc
                # tieu (gap1/sessions) thi chay tron ngan sach (23/08 trua).
                break
            # 26/08: nut mot muc tieu — khoi toan tu nang (cycle/kempe/chuoi/
            # retile/ep 4-8 s) chi chay sau khi dot quet re da co co hoi
            # (>= min(10 s, 25% ngan sach)); truoc do no ngon 36% vong lap ma
            # 0 cai thien vi chay tren trang thai vuot tran.
            heavy_ok = (not focus_stage3) or (
                not self._cpsat_available()
                and time.monotonic() - started_at >= min(10.0, 0.25 * budget)
            )
            if heavy_ok and stall > 0 and stall % (150 if (stage < 3 or focus_stage3) else 400) == 0:
                self._quality_cycle_pass(
                    soft, weights, floor_teachers, min(deadline, time.monotonic() + 4.0)
                )
                self._quality_kempe_pass(soft, weights, min(deadline, time.monotonic() + 3.0))
                # ejection chains on the stubborn debts (deeper as debts shrink)
                debts = self._debt_sessions_of(
                    soft, set(range(P.num_teachers())), floor_teachers
                )
                if stage == 1:
                    debts = [(t_d, s_d) for t_d, s_d in debts if soft.ts_cnt[t_d][s_d] == 1]
                elif stage == 2:
                    debts = [(t_d, s_d) for t_d, s_d in debts if soft.ts_cnt[t_d][s_d] != 1]
                if stage >= 3 and focus == "gap1":
                    # 23/08 (trua): nut "1 tiet trong" — chuoi/ep-roi-sua nham
                    # thang vao cac buoi ho 1 tiet, khong phai buoi mong.
                    debts = self._gap1_sessions_of(soft, set(range(P.num_teachers())))
                elif stage >= 3:
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
                retile_every = 150 if stage_only is not None else 450
                if deep and (stall >= 1200 or (stage < 3 and stall % retile_every == 0)):
                    # quality-aware cluster re-tile around debt teachers
                    # (22/08 toi: o bac 1/2 chay som hon, moi 450 buoc be tac,
                    # vi day la cong cu manh nhat de go buoi le / trong >= 2;
                    # nut mot muc tieu: moi 150 buoc)
                    debt_teachers = {t_d for t_d, _s in debts}
                    classes = sorted({
                        c
                        for c in range(P.num_classes())
                        for slot in range(NUM_SLOTS)
                        if soft.grid[c][slot] >= 0
                        and any(tt in debt_teachers for tt in P.a_teachers[soft.grid[c][slot]])
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
                if (stage < 3 or focus in ("gap1", "sessions")) and (deep or stall % 600 == 0):
                    # 23/08: "ep ghep roi sua xung dot" cho cac buoi le / trong
                    # >= 2 cung dau (xem _force_pair_session) — cong cu quyet
                    # dinh khi tabu 2-hoan-doi da bat luc. 23/08 trua: ca lo
                    # 1 tiet cua nut gap1 (lap lo / dich khoi / day tiet ria).
                    # 26/08: chay tren trang thai SACH va khong vuot tran buoi
                    # (do: 243/245 lan goi o day tren trang thai 629-632 > 625,
                    # 0 cai thien).
                    if soft.penalty() > 0 or (
                        self._session_cap is not None and soft.quality()[2] > self._session_cap
                    ):
                        restore_best()
                        tabu.clear()
                    self._force_pair_endgame(
                        soft, weights, floor_teachers,
                        min(deadline, time.monotonic() + (8.0 if deep else 4.0)),
                        stage, iteration,
                    )
                score = self._quality_score(soft, weights)
                if score < best_score:
                    best_score = score
                    best_grid = [row[:] for row in soft.grid]
                    best_q = soft.quality()
                    best_act = self._actionable_debts(soft)
                    stall = 0
                    last_improve_at = time.monotonic()
                elif soft.penalty() > 0:
                    # 23/08 (trua): cac pass tren co the de lai trang thai ban
                    # (trung gio / luat GV) — khong bao gio la best, va lam
                    # moi toan tu sau vo hieu -> quay ve luoi tot nhat ngay.
                    restore_best()
                    tabu.clear()
            if stall > 3000:
                # restore best and shake
                restore_best()
                tabu.clear()
                if stage < 3 and self.quality_focus in (None, "singletons", "gap2"):
                    # Con no 1 tiet/buoi hoac trong >=2 ma be tac: THAO bot —
                    # tam ha trong so buoi + trong 1 de mo duong (chu du an:
                    # "khong nhat thiet giu no qua nang ma khong dat muc dich
                    # chung"), roi vong lap chinh voi trong so chuan nen lai.
                    # Cac khoa van giu nguyen trong luc thao.
                    relaxed = (weights[0], weights[1], 50, 3)
                    relax_deadline = min(deadline, time.monotonic() + 6.0)
                    while time.monotonic() < relax_deadline:
                        r_target = self._pick_quality_target(
                            soft, rng, floor_teachers, stage
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
                        best_q = soft.quality()
                        best_act = self._actionable_debts(soft)
                        last_improve_at = time.monotonic()
                else:
                    self._shake_quality(soft, 10)
                stall = 0
            emit_quality()
        # end on best grid
        if self._quality_score(soft, weights) > best_score:
            restore_best()
        self._offer_focus_candidate(soft.grid, soft.quality(), force=True)
        emit_quality(force=True)
        already_logged = bool(self._stage_log) and self._stage_log[-1].get("stage") == stage and stage_only is not None
        if not already_logged:
            self._stage_log.append(
                {
                    "stage": stage,
                    "exit": "stopped" if stopped else ("deadline" if time.monotonic() >= deadline else "converged"),
                    "seconds": round(time.monotonic() - stage_started, 1),
                    "quality": list(soft.quality()[:4]),
                }
            )

    # ------------------------------------------------------------------
    # 22/08 (toi, chi dao chu du an): "dam bao giai 2 yeu to (1 tiet/buoi,
    # trong >= 2) ve thap nhat; truong hop khong thuc hien duoc thi rot ve
    # Chua phan va goi y cach thay doi".
    # ------------------------------------------------------------------

    def _actionable_debts(self, soft: SoftSchedule) -> tuple[int, int]:
        """(buoi GV 1 tiet, buoi trong >= 2) KHONG duoc san cau truc mien tru."""

        forced_singles, forced_gap2s, _e = getattr(
            self, "_floors_cache", (set(), {}, [])
        )
        P = self.P
        n_single = 0
        n_gap2 = 0
        for t in range(P.num_teachers()):
            cnt_row = soft.ts_cnt[t]
            first_row = soft.ts_first[t]
            last_row = soft.ts_last[t]
            excused_all = (t, -1) in forced_singles
            for s in range(NUM_SESSIONS):
                cnt = cnt_row[s]
                if cnt <= 0:
                    continue
                if cnt == 1:
                    if not excused_all and not self._single_excused(soft, t, s):
                        n_single += 1
                elif last_row[s] - first_row[s] + 1 - cnt >= 2 and (t, s) not in forced_gap2s:
                    n_gap2 += 1
        return n_single, n_gap2

    def _finish_quality(self, soft: SoftSchedule, info: dict) -> None:
        """Sau bac 3: xep lai tiet con thieu (chi khi khong lam GV xau them), roi
        dua cac tiet VAN gay buoi 1 tiet / trong >= 2 ve Chua phan kem ly do."""

        expected = sum(self.P.a_periods)
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        # 25/08: hau xu ly sau restore_best() truoc day khong khoa buoi day /
        # trong 1 (chi khoa 1 tiet/buoi + trong >= 2) va compact_student_holes
        # cham diem bang trong so cung bat ke lane -> co the lam chi so phu
        # trach xau di SAU khi da chon luoi tot nhat. Nut mot muc tieu: moi
        # buoc hau xu ly lam xau chi so phu trach / chi so uu tien cao hon thi
        # hoan tac buoc do.
        guard = self._focus_guard_indices()

        def worse_than(q_before) -> bool:
            if guard is None:
                return False
            q_now = soft.quality()
            return any(int(q_now[i]) > int(q_before[i]) for i in guard)

        if placed < expected:
            grid_before = [row[:] for row in soft.grid] if guard is not None else None
            q_before = soft.quality()
            added = self._insert_missing_quality_neutral(soft)
            if added and grid_before is not None and worse_than(q_before):
                # xep them tiet lam chi so phu trach tang -> bo buoc chen
                self._restore_grid(soft, grid_before)
                added = 0
            if added:
                info["reinserted"] = int(info.get("reinserted", 0)) + added
        # don lo trong hoc sinh TRUOC khi bao cao de vi tri (thu/buoi) trong
        # quality_unavoidable khop voi luoi cuoi cung
        grid_before = [row[:] for row in soft.grid] if guard is not None else None
        q_before = soft.quality()
        self.compact_student_holes(soft)
        if grid_before is not None and worse_than(q_before):
            self._restore_grid(soft, grid_before)
            info["compact_reverted"] = True
        self._eject_quality_debts(soft)
        self._stage_info(info)

    def _focus_guard_indices(self) -> list[int] | None:
        """Chi so (theo bo [1tiet, trong2, buoi, trong1]) KHONG duoc tang trong
        luot mot muc tieu: chi so phu trach + moi chi so uu tien cao hon."""

        focus = self.quality_focus
        if focus == "singletons":
            return [0]
        if focus == "gap2":
            return [0, 1]
        if focus == "sessions":
            return [0, 1, 2]
        if focus == "gap1":
            return [0, 1, 2, 3]
        return None

    def _restore_grid(self, soft: SoftSchedule, grid: list[list[int]]) -> None:
        P = self.P
        for c in range(P.num_classes()):
            row = soft.grid[c]
            for slot in range(NUM_SLOTS):
                if row[slot] != grid[c][slot]:
                    soft.set_cell(c, slot, grid[c][slot])
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)

    def _owner_class(self, soft: SoftSchedule, t: int, slot: int) -> int:
        P = self.P
        for c in range(P.num_classes()):
            ai = soft.grid[c][slot]
            if ai >= 0 and t in P.a_teachers[ai]:
                return c
        return -1

    def _class_interior_holes(self, soft: SoftSchedule, c: int, s: int) -> int:
        """So o (lop duoc hoc) con trong nam GIUA cac tiet da xep cua lop trong buoi."""

        P = self.P
        base = s * PERIODS
        row = soft.grid[c]
        avail = P.class_avail[c]
        occ = [p for p in range(PERIODS) if row[base + p] >= 0]
        if len(occ) < 2:
            return 0
        return sum(
            1 for p in range(occ[0] + 1, occ[-1]) if row[base + p] < 0 and avail[base + p]
        )

    def _try_remove_lesson(self, soft: SoftSchedule, c: int, slot: int):
        """Dua tiet (c, slot) ra khoi luoi: khong dung o co dinh / o GV bat buoc
        day, khong pha luat lop (ke ca min cap tiet doi), khong tao lo trong
        giua buoi cho hoc sinh, khong phat sinh no moi cho GV khac.

        Tra ve [(class, inverse_changes)] de hoan tac, hoac None (ly do o
        self._last_remove_fail).
        """

        P = self.P
        ai = soft.grid[c][slot]
        if ai < 0:
            self._last_remove_fail = "empty"
            return None
        if soft.locked[c][slot]:
            self._last_remove_fail = "fixed"
            return None
        if any(slot in P.teacher_must[t] for t in P.a_teachers[ai]):
            self._last_remove_fail = "must_teach"
            return None
        s = slot // PERIODS
        si = P.a_subject[ai]
        holes_before = self._class_interior_holes(soft, c, s)
        pen_before = soft.penalty()

        def class_ok_after() -> str | None:
            if checks.check_class_session(P, soft.grid, c, s, False) is not None:
                return "class_session"
            reason = checks.check_class_subject_week(P, soft.grid, c, si, ai, False)
            if reason is not None:
                return reason
            if checks.check_class_day(P, soft.grid, c, s // 2) is not None:
                return "class_day"
            if self._class_interior_holes(soft, c, s) > holes_before:
                return "student_hole"
            return None

        # 1) go truc tiep
        inverse = self._apply_changes(soft, c, [(slot, -1)])
        q_ideal = (soft.q_singleton, soft.q_gap2)
        why = class_ok_after()
        if why is None and soft.penalty() <= pen_before:
            return [(c, inverse)]
        self._apply_changes(soft, c, inverse)
        if why != "student_hole":
            self._last_remove_fail = why or "penalty"
            return None
        # 2) tiet nam giua buoi cua lop: doi cho voi tiet o RIA buoi (run 1 o,
        #    GV cua no ranh tai `slot`) roi go tiet ria -> hoc sinh khong bi lo.
        base = s * PERIODS
        occ = [p for p in range(PERIODS) if soft.grid[c][base + p] >= 0]
        for edge_p in (occ[0], occ[-1]):
            edge = base + edge_p
            if edge == slot or soft.locked[c][edge]:
                continue
            other = soft.grid[c][edge]
            if other < 0 or other == ai or len(self._run_window(soft, c, edge)) != 1:
                continue
            if not P.a_allowed[other][slot]:
                continue
            if soft.busy(other, slot) > 0 or any(edge in P.teacher_must[t2] for t2 in P.a_teachers[other]):
                continue
            inverse = self._apply_changes(soft, c, [(slot, other), (edge, -1)])
            why2 = class_ok_after()
            if why2 is None and checks.check_class_subject_week(
                P, soft.grid, c, P.a_subject[other], other, False
            ) is not None:
                why2 = "other_subject_week"
            if (
                why2 is None
                and soft.penalty() <= pen_before
                and soft.q_singleton <= q_ideal[0]
                and soft.q_gap2 <= q_ideal[1]
            ):
                return [(c, inverse)]
            self._apply_changes(soft, c, inverse)
        self._last_remove_fail = "student_hole"
        return None

    def _gap2_removal_plans(self, soft: SoftSchedule, t: int, s: int):
        """Cac phuong an go IT tiet nhat o RIA buoi (t, s) de buoi het trong >= 2
        (va khong de lai buoi 1 tiet). Moi phuong an = [(class, slot, ai)]."""

        base = s * PERIODS
        occ = [p for p in range(PERIODS) if soft.tcnt[t][base + p] > 0]
        if len(occ) < 2:
            return []
        blocks: list[list[int]] = []
        for p in occ:
            if blocks and blocks[-1][-1] == p - 1:
                blocks[-1].append(p)
            else:
                blocks.append([p])
        if len(blocks) < 2:
            return []

        def build(from_left: bool) -> list[int]:
            remaining = [list(b) for b in blocks]
            removed: list[int] = []
            while len(remaining) >= 2:
                span = remaining[-1][-1] - remaining[0][0] + 1
                if span - sum(len(b) for b in remaining) < 2:
                    break
                removed.extend(remaining.pop(0) if from_left else remaining.pop())
            if len(remaining) == 1 and len(remaining[0]) == 1:
                removed.extend(remaining.pop())
            return removed

        plans = []
        for periods in sorted((build(True), build(False)), key=len):
            cells = []
            for p in periods:
                slot = base + p
                c = self._owner_class(soft, t, slot)
                if c < 0:
                    cells = []
                    break
                cells.append((c, slot, soft.grid[c][slot]))
            if cells:
                plans.append(cells)
        return plans

    def _eject_quality_debts(self, soft: SoftSchedule) -> None:
        """22/08 (khuya, chi dao chu du an): "cac nut toi uu — ke ca nut Cherry —
        khi da xep du thi HOAN DOI cac tiet chu KHONG lam rot tiet ra Chua phan".

        Ham nay KHONG con dua tiet nao ra nua; no chi BAO CAO cac buoi GV 1
        tiet / trong >= 2 con lai sau bac 1-3 kem goi y cu the (vao
        `quality_unavoidable`, `why="kept"`) de nguoi dung tu xu ly ("co mau
        thuan rang buoc thi bao toi"). Cac ham _eject_singletons/_eject_gap2/
        _try_remove_lesson ben duoi duoc giu lai nhung KHONG duoc goi.
        """

        P = self.P
        self._quality_ejected = []
        self._quality_unavoidable = []
        self._quality_eject_skipped = {"disabled": "swap_only"}
        self._eject_tried = set()
        if self.quality_focus is not None:
            self._quality_eject_skipped["focus"] = self.quality_focus
        self._last_remove_fail = "kept"
        count = 0
        for t in range(P.num_teachers()):
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt <= 0:
                    continue
                gap = soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt
                if cnt == 1:
                    kind, g = "one_period", 0
                elif gap >= 2:
                    kind, g = "gap2", gap
                else:
                    continue
                if count >= 80:
                    return
                slot = s * PERIODS + soft.ts_first[t][s]
                c = self._owner_class(soft, t, slot)
                ai = soft.grid[c][slot] if c >= 0 else -1
                d, part = divmod(s, 2)
                self._quality_unavoidable.append(
                    {
                        "teacher": P.teacher_names[t],
                        "class": P.class_names[c] if c >= 0 else "",
                        "subject": P.subject_names[P.a_subject[ai]] if ai >= 0 else "",
                        "day": d + 2,
                        "session": "AM" if part == 0 else "PM",
                        "kind": kind,
                        "gap": g,
                        "why": "kept",
                        "why_label": (
                            self._eject_message(soft, t, c, ai, s, kind, g)
                            if c >= 0 and ai >= 0
                            else "không tối ưu thêm được trong lượt này"
                        ),
                    }
                )
                count += 1

    def _eject_singletons(self, soft: SoftSchedule, cap: int) -> bool:
        P = self.P
        changed = False
        for t in range(P.num_teachers()):
            for s in range(NUM_SESSIONS):
                if soft.ts_cnt[t][s] != 1 or (t, s) in self._eject_tried:
                    continue
                if len(self._quality_ejected) >= cap:
                    self._quality_eject_skipped["cap"] = cap
                    return changed
                self._eject_tried.add((t, s))
                slot = s * PERIODS + soft.ts_first[t][s]
                c = self._owner_class(soft, t, slot)
                if c < 0:
                    continue
                ai = soft.grid[c][slot]
                if self._try_remove_lesson(soft, c, slot) is None:
                    self._record_unavoidable(t, s, c, ai, "one_period", 0)
                    continue
                self._record_ejected(soft, t, s, c, slot, ai, "one_period", 0)
                changed = True
        return changed

    def _eject_gap2(self, soft: SoftSchedule, cap: int) -> bool:
        P = self.P
        changed = False
        for t in range(P.num_teachers()):
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt < 2 or (t, s) in self._eject_tried:
                    continue
                gap = soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt
                if gap < 2:
                    continue
                self._eject_tried.add((t, s))
                plans = self._gap2_removal_plans(soft, t, s)
                if not plans:
                    self._last_remove_fail = "no_plan"
                    self._record_unavoidable(t, s, -1, -1, "gap2", gap)
                    continue
                done = False
                for plan in plans:
                    if len(self._quality_ejected) + len(plan) > cap:
                        self._quality_eject_skipped["cap"] = cap
                        continue
                    inverses: list = []
                    ok = True
                    for c, slot, _ai in plan:
                        inv = self._try_remove_lesson(soft, c, slot)
                        if inv is None:
                            ok = False
                            break
                        inverses.extend(inv)
                    if not ok:
                        for c, inverse in reversed(inverses):
                            self._apply_changes(soft, c, inverse)
                        continue
                    for c, slot, ai in plan:
                        self._record_ejected(soft, t, s, c, slot, ai, "gap2", gap)
                    done = True
                    changed = True
                    break
                if not done:
                    c0, _slot0, ai0 = plans[0][0]
                    self._record_unavoidable(t, s, c0, ai0, "gap2", gap)
        return changed

    def _record_ejected(self, soft, t, s, c, slot, ai, kind, gap) -> None:
        P = self.P
        d, part = divmod(s, 2)
        self._quality_ejected.append(
            {
                "class": P.class_names[c],
                "grade": P.class_grades[c],
                "subject": P.subject_names[P.a_subject[ai]],
                # 25/08: nhan PHAN CONG ("GV1, GV2" cho tiet ghep) de entry.py
                # doi chieu voi Chua phan theo (lop, mon, GV) khong bi dem doi.
                "teacher": P.teacher_label(ai) if ai >= 0 else (P.teacher_names[t] if t >= 0 else ""),
                "room": P.a_room[ai],
                "day": d + 2,
                "session": "AM" if part == 0 else "PM",
                "period": slot - s * PERIODS + 1,
                "kind": kind,
                "gap": gap,
                "message": self._eject_message(soft, t, c, ai, s, kind, gap),
            }
        )

    def _record_unavoidable(self, t, s, c, ai, kind, gap) -> None:
        P = self.P
        d, part = divmod(s, 2)
        why = str(self._last_remove_fail or "")
        label = _REMOVE_FAIL_LABEL.get(why)
        if label is None:
            label = "phải giữ cặp tiết đôi (min)" if why.startswith("lesson_blocks_min") else why
        self._quality_unavoidable.append(
            {
                "teacher": P.teacher_label(ai) if ai >= 0 else (P.teacher_names[t] if t >= 0 else ""),
                "class": P.class_names[c] if c >= 0 else "",
                "subject": P.subject_names[P.a_subject[ai]] if ai >= 0 else "",
                "day": d + 2,
                "session": "AM" if part == 0 else "PM",
                "kind": kind,
                "gap": gap,
                "why": why,
                "why_label": label,
            }
        )

    def _eject_message(self, soft, t, c, ai, s, kind, gap) -> str:
        """Goi y cu the (tieng Viet co dau) vi sao tiet nay bi dua ra va nguoi
        dung nen doi gi de lan sau xep duoc."""

        P = self.P
        tname = P.teacher_names[t] if t >= 0 else "?"
        cname = P.class_names[c]
        sname = P.subject_names[P.a_subject[ai]]
        d, part = divmod(s, 2)
        when = f"{_DAY_LABEL[d]} {_PART_LABEL[part]}"
        if kind == "one_period":
            head = f"GV {tname} chỉ dạy 1 tiết ({sname} {cname}) trong buổi {when}"
        else:
            head = (
                f"Buổi {when} của GV {tname} trống {gap} tiết ở giữa; "
                f"tiết {sname} {cname} nằm ở rìa buổi"
            )
        load = 0
        if t >= 0:
            load = sum(P.a_periods[x] for x in range(P.num_assignments()) if t in P.a_teachers[x])
        if load == 1:
            return (
                head
                + ". GV chỉ có 1 tiết/tuần nên buổi nào cũng là buổi 1 tiết. "
                "Gợi ý: giao thêm tiết cho GV này hoặc chuyển tiết này cho GV khác."
            )
        entry = self._cap_floor.get(t) if t >= 0 else None
        if kind == "one_period" and entry is not None and s in entry[1]:
            forced, one_cell, multi_cap = entry
            names = ", ".join(
                f"{_DAY_LABEL[s2 // 2]} {_PART_LABEL[s2 % 2]}" for s2 in sorted(one_cell)
            )
            return (
                head
                + f". Buổi {when} chỉ còn đúng 1 ô mà GV vừa rảnh vừa được phép dạy; "
                f"các buổi có từ 2 ô hợp lệ trở lên chỉ chứa tối đa {multi_cap}/{load} tiết "
                f"của GV, nên bắt buộc có ít nhất {forced} buổi 1 tiết "
                f"(các buổi chỉ còn 1 ô: {names}). "
                f"Gợi ý: bỏ bớt ô nghỉ của GV {tname} trong buổi {when} (mở thêm ≥1 ô "
                "liền kề), hoặc chuyển bớt lớp cho GV khác."
            )
        tips: list[str] = []
        if t >= 0:
            # 23/08 (ca TD.Qui): moi tiet khac cua GV deu bi nguoi dung Co dinh
            # -> chi tiet nay di chuyen duoc, khong con gi de ghep.
            cells_t = 0
            locked_t = 0
            for c2 in range(P.num_classes()):
                row2 = soft.grid[c2]
                lrow2 = soft.locked[c2]
                for slot2 in range(NUM_SLOTS):
                    a2 = row2[slot2]
                    if a2 >= 0 and t in P.a_teachers[a2]:
                        cells_t += 1
                        if lrow2[slot2]:
                            locked_t += 1
            if cells_t > 1 and locked_t >= cells_t - 1:
                tips.append(
                    f"mọi tiết khác của GV {tname} đều đang Cố định ({locked_t}/{cells_t} ô) nên "
                    "chỉ tiết này di chuyển được — mở khóa bớt một khối để ghép"
                )
            off_t = NUM_SLOTS - sum(P.teacher_avail[t])
            if off_t >= 12:
                tips.append(f"bớt tiết nghỉ của GV {tname} (đang nghỉ {off_t} ô)")
            full = [
                s2 for s2 in range(NUM_SESSIONS)
                if s2 != s and soft.ts_cnt[t][s2] > 0 and soft.ts_cnt[t][s2] >= PERIODS
            ]
            used = [s2 for s2 in range(NUM_SESSIONS) if s2 != s and soft.ts_cnt[t][s2] > 0]
            if used and len(full) == len(used):
                tips.append(f"các buổi khác của GV {tname} đã kín 5 tiết")
        rule = P.a_rule[ai]
        if rule is not None:
            if any(rule.part_banned):
                tips.append(f"cho phép môn {sname} học cả sáng lẫn chiều")
            if (
                rule.one_session_per_day
                or rule.max_sessions_week
                or any(rule.day_cap)
                or rule.spacing_days
                or any(rule.weekly_part_cap)
            ):
                tips.append(f"nới giới hạn buổi/ngày của môn {sname} lớp {cname}")
            if any(rule.linked_avoided) or any(rule.avoid23) or any(rule.avoid34):
                tips.append(f"nới luật tiết liền / tránh tiết 2-3 của môn {sname}")
        if t >= 0 and P.teacher_rules[t] is not None:
            tips.append(f"nới giới hạn buổi/ngày dạy hoặc số tiết/buổi của GV {tname}")
        periods = int(P.a_periods[ai])
        cap = int(P.a_cap[ai])
        if kind == "one_period" and 0 < cap < periods and periods % cap != 0:
            # vd. 5 tiet/tuan, toi da 2 tiet/buoi -> luon co 1 buoi le 1 tiet
            # cua mon nay; GV chi het buoi 1 tiet khi ghep duoc voi lop khac.
            tips.append(
                f"môn {sname} lớp {cname} có {periods} tiết/tuần, tối đa {cap} tiết/buổi "
                f"nên luôn dư {periods % cap} tiết lẻ — nới giới hạn tiết/buổi hoặc đổi số tiết"
            )
        allowed = sum(P.a_allowed[ai])
        if allowed <= 20:
            tips.append(f"tiết này chỉ còn {allowed} ô hợp lệ trong tuần")
        if not tips:
            tips.append(
                f"kéo tiết này vào cạnh một buổi đã có tiết của GV {tname} rồi Cố định ô, "
                "hoặc đổi GV cho lớp này"
            )
        return head + ". Gợi ý: " + "; ".join(tips[:3]) + "."

    def _insert_missing_quality_neutral(self, soft: SoftSchedule, *, allow_debt: bool = False) -> int:
        """Xep lai cac tiet con thieu vao o khong pha luat, khong tao lo trong
        cho hoc sinh. Mac dinh chi nhan o KHONG lam tang buoi 1 tiet / trong
        >= 2 cua GV; allow_debt=True cho phep tao no moi (chon o it hai nhat)
        de bac 1/2 co co hoi sua — tru GV chi co 1 tiet/tuan (san cau truc)."""

        P = self.P
        placed_per = [0] * P.num_assignments()
        for c in range(P.num_classes()):
            for slot in range(NUM_SLOTS):
                ai = soft.grid[c][slot]
                if ai >= 0:
                    placed_per[ai] += 1
        added = 0
        for ai in range(P.num_assignments()):
            missing = P.a_periods[ai] - placed_per[ai]
            if missing <= 0:
                continue
            # 22/08 (khuya): khong con "rot tiet" nen KHONG bo qua GV 1 tiet/tuan
            # nua — tiet thieu phai duoc xep lai (co the thanh buoi 1 tiet cau
            # truc, se duoc BAO kem goi y).
            # 25/08: mon can "toi thieu 1 cap 2 tiet" ma chua co cap nao thi
            # chen TUNG tiet le khong bao gio qua kiem tra lesson_blocks_min ->
            # chen theo CAP truoc, con du moi chen le.
            while (
                missing >= 2
                and self._needs_double(soft, ai)
                and self._insert_pair_neutral(soft, ai, allow_debt=allow_debt)
            ):
                missing -= 2
                added += 2
            while missing > 0 and self._insert_one_neutral(soft, ai, allow_debt=allow_debt):
                missing -= 1
                added += 1
        return added

    def _insert_one_neutral(self, soft: SoftSchedule, ai: int, *, allow_debt: bool = False) -> bool:
        P = self.P
        c = P.a_class[ai]
        si = P.a_subject[ai]
        q0 = (soft.q_singleton, soft.q_gap2)
        pen0 = soft.penalty()
        weights = (10**11, 10**8, 10**5, 10)
        best: tuple[int, int] | None = None
        for slot in range(NUM_SLOTS):
            if soft.grid[c][slot] >= 0 or soft.locked[c][slot] or not P.a_allowed[ai][slot]:
                continue
            if soft.busy(ai, slot) > 0:
                continue
            s = slot // PERIODS
            holes0 = self._class_interior_holes(soft, c, s)
            inverse = self._apply_changes(soft, c, [(slot, ai)])
            ok = (
                soft.penalty() <= pen0
                and (allow_debt or (soft.q_singleton <= q0[0] and soft.q_gap2 <= q0[1]))
                and checks.check_class_session(P, soft.grid, c, s, False) is None
                and checks.check_class_subject_week(P, soft.grid, c, si, ai, False) is None
                and checks.check_class_day(P, soft.grid, c, s // 2) is None
                and self._class_interior_holes(soft, c, s) <= holes0
                and not self._lock_violated(soft)
            )
            if ok:
                score = self._quality_score(soft, weights)
                if best is None or score < best[0]:
                    best = (score, slot)
            self._apply_changes(soft, c, inverse)
        if best is None:
            return False
        self._apply_changes(soft, c, [(best[1], ai)])
        return True

    def _pick_quality_target(self, soft: SoftSchedule, rng, floor_teachers: set[int], stage: int):
        """Choose a (t, s) debt session to work on (structural floors excluded).

        stage 1 = chi buoi GV 1 tiet; stage 2 = chi buoi trong >= 2;
        stage 3 = buoi mong / trong 1 (cac no con lai xep cuoi hang doi).
        """

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
                if cnt == 1 and not self._single_excused(soft, t, s):
                    singles.append((t, s))
                if gap >= 2 and (t, s) not in forced_gap2s:
                    gap2s.append((t, s))
                if stage >= 3:
                    if cnt <= 2:
                        thin.append((t, s))
                    if gap == 1:
                        gap1s.append((t, s))
        if stage == 1:
            pool = singles
        elif stage == 2:
            pool = gap2s
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
        pen_before = soft.penalty()

        def consider(c: int, run: list[int], windows_in=None):
            cap = 0
            for changes, window_start in self._enum_quality_moves(soft, c, run, windows_in=windows_in):
                if tabu.get((c, run[0], window_start), 0) > iteration:
                    continue
                inverse = self._apply_changes(soft, c, changes)
                delta = self._quality_score(soft, weights) - score_before
                # 22/08: nuoc di lam vuot chi so da KHOA bi loai ngay tu khi
                # liet ke (tabu van co the chon nuoc xau hon, nhung khong bao
                # gio chon nuoc pha khoa).
                over_lock = self._lock_violated(soft)
                # 23/08 (trua): nuoc di lam TANG penalty (vi pham luat GV /
                # trung gio) cung bi loai ngay. Truoc day tabu van ap
                # moves[0] du no bi phat 10**13 (do tren truong default: sau
                # 1,4s trang thai "ban" va giu nguyen ca luot -> moi toan tu
                # sau do vo hieu, cuoi luot restore_best tra ve luoi xuat
                # phat => "nut 1 tiet trong gan nhu khong toi uu duoc").
                dirty = soft.penalty() > pen_before
                self._apply_changes(soft, c, inverse)
                if over_lock or dirty:
                    continue
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
                if a2 >= 0 and t in P.a_teachers[a2]:
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
                    if a2 >= 0 and t in P.a_teachers[a2]:
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
                singleton_debt = cnt == 1 and not self._single_excused(soft, t, s)
                gap_debt = gap >= 2 and (t, s) not in forced_gap2s
                if singleton_debt or gap_debt:
                    out.append((t, s))
        return out

    def _stop_requested(self) -> bool:
        """True khi Cloud Run/VPS da dat file dung (soft stop / huy). Ket qua
        tot nhat hien co duoc tra ve ngay (khong dot het ngan sach)."""

        if self._stop_seen:
            return True
        if not self._stop_file:
            return False
        now = time.monotonic()
        if now - self._stop_checked_at < 0.5:
            return False
        self._stop_checked_at = now
        try:
            self._stop_seen = os.path.exists(self._stop_file)
        except OSError:
            self._stop_seen = False
        return self._stop_seen

    def _gap1_sessions_of(self, soft: SoftSchedule, teachers: set[int]):
        """23/08 (trua): cac buoi (t, s) co >= 2 tiet va dung 1 o trong giua —
        muc tieu cua nut "1 tiet trong"."""

        out = []
        for t in teachers:
            if t < 0:
                continue
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt < 2:
                    continue
                if soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt == 1:
                    out.append((t, s))
        return out

    def _chain_debts_of(self, soft: SoftSchedule, teachers: set[int], floor_teachers: set[int]):
        """No cua cac GV lien quan de noi tiep chuoi/ep-roi-sua: buoi 1 tiet /
        trong >= 2 nhu cu, va (nut gap1) them cac buoi ho 1 tiet."""

        out = self._debt_sessions_of(soft, teachers, floor_teachers)
        if self.quality_focus == "gap1":
            seen = set(out)
            out = out + [x for x in self._gap1_sessions_of(soft, teachers) if x not in seen]
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
                if a2 >= 0 and t in P.a_teachers[a2]:
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
                    if a2 >= 0 and t in P.a_teachers[a2]:
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
                over_lock = self._lock_violated(soft)
                self._apply_changes(soft, oc, inverse)
                if over_lock:
                    continue
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
                over_lock = self._lock_violated(soft)
                self._apply_changes(soft, oc, inverse)
                if over_lock:
                    continue
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
                tt for _x, v in changes if v >= 0 for tt in P.a_teachers[v]
            }
            inverse = self._apply_changes(soft, oc, changes)
            if self._quality_score(soft, weights) < start_score:
                return True
            if depth + 1 < max_depth:
                visited.add(key)
                next_debts = self._chain_debts_of(soft, partner_teachers | {t}, floor_teachers)
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
                    if a2 >= 0 and t in P.a_teachers[a2]:
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
                    if a2 >= 0 and t in P.a_teachers[a2]:
                        seed_c = c
                        break
                if seed_c < 0:
                    continue
                for slot2 in free:
                    if self._soft_kempe_pair(soft, seed_c, slot1, slot2, weights=weights):
                        break

    # ------------------------------------------------------------------
    # 23/08 (chi dao chu du an: "test nut Cherry voi TKB default xem tai sao
    # khong toi uu duoc 1 tiet/buoi"): cac buoi le cuoi cung thuong chi go
    # duoc bang mot nuoc "ep ghep" (keo tiet ban vao sat tiet le, hoac keo
    # tiet le vao sat khoi da co cua GV) ma o dich dang bi tiet cua GV khac
    # chiem va GV do lai ban o o nguon -> tabu 2-hoan-doi khong bao gio thay.
    # O day: EP nuoc ghep (hop le phia lop, cho phep trung gio tam thoi), KHOA
    # cac o vua ghep, roi dung bo sua xung dot cua pha 2 (min-conflicts +
    # dig/augment/Kempe, co uu tien chat luong) de go trung gio; chi nhan khi
    # sach trung gio, khong pha luat, khong pha khoa va diem chat luong TOT
    # HON; khong thi tra lai y nguyen. Khong bao gio rot tiet.
    # ------------------------------------------------------------------

    def _cap_floor_total(self) -> int:
        return sum(v[0] for v in self._cap_floor.values())

    def _single_excused(self, soft: SoftSchedule, t: int, s: int) -> bool:
        """Buoi 1 tiet (t, s) co duoc MIEN TRU (san cau truc) khong."""

        forced_singles = getattr(self, "_floors_cache", (set(), {}, []))[0]
        if (t, s) in forced_singles or (t, -1) in forced_singles:
            return True
        entry = self._cap_floor.get(t)
        if entry is None or s not in entry[1]:
            return False
        forced, one_cell, _cap = entry
        k = sum(1 for s2 in one_cell if soft.ts_cnt[t][s2] == 1)
        return k <= forced

    def _changes_class_valid(self, soft: SoftSchedule, c: int, changes, lesson_ids, sessions) -> bool:
        """Kiem luat phia lop cua mot danh sach doi o (tam ap len hang luoi,
        khong dong bo dem GV) — dung cho nuoc 'ep ghep'."""

        P = self.P
        grid_row = soft.grid[c]
        seen: dict[int, int] = {}
        for slot, val in changes:
            seen[slot] = val
        backup = {slot: grid_row[slot] for slot in seen}
        for slot, val in seen.items():
            grid_row[slot] = val
        ok = all(checks.check_class_session(P, soft.grid, c, s, False) is None for s in sessions)
        if ok:
            ok = all(
                checks.check_class_subject_week(P, soft.grid, c, P.a_subject[v], v, False) is None
                for v in lesson_ids
            )
        if ok:
            ok = all(checks.check_class_day(P, soft.grid, c, d) is None for d in {s // 2 for s in sessions})
        for slot, val in backup.items():
            grid_row[slot] = val
        return ok

    def _force_windows(self, soft: SoftSchedule, t: int, s: int, L: int, *, holes_only: bool):
        """Cac cua so L o trong buoi s ke sat khoi da co cua GV t (ria khoi
        hoac trong lo giua buoi) ma GV t ranh va duoc day."""

        P = self.P
        base = s * PERIODS
        m = soft.ts_mask[t][s]
        if m == 0:
            return []
        first = soft.ts_first[t][s]
        last = soft.ts_last[t][s]
        out: list[list[int]] = []
        if not holes_only:
            if first - L >= 0:
                out.append([base + q for q in range(first - L, first)])
            if last + L <= PERIODS - 1:
                out.append([base + q for q in range(last + 1, last + L + 1)])
        q = first + 1
        while q < last:
            if m & _MC_BIT[q]:
                q += 1
                continue
            a = q
            while q < last and not (m & _MC_BIT[q]):
                q += 1
            b = q - 1
            if b - a + 1 >= L:
                out.append([base + x for x in range(a, a + L)])
                if b - L + 1 != a:
                    out.append([base + x for x in range(b - L + 1, b + 1)])
        avail = P.teacher_avail[t]
        row = soft.tcnt[t]
        return [w for w in out if all(avail[x] and row[x] == 0 for x in w)]

    def _runs_of_teacher(self, soft: SoftSchedule, t: int, sessions):
        """Cac run (khoi) KHONG khoa cua GV t trong cac buoi da cho."""

        out: list[tuple[int, list[int]]] = []
        for s2 in sessions:
            if soft.ts_cnt[t][s2] == 0:
                continue
            base2 = s2 * PERIODS
            p2 = 0
            while p2 < PERIODS:
                if soft.tcnt[t][base2 + p2] <= 0:
                    p2 += 1
                    continue
                oc = self._owner_class(soft, t, base2 + p2)
                if oc < 0:
                    p2 += 1
                    continue
                run = self._run_window(soft, oc, base2 + p2)
                p2 = run[-1] - base2 + 1
                if not any(soft.locked[oc][x] for x in run):
                    out.append((oc, run))
        return out

    def _force_pair_candidates(self, soft: SoftSchedule, t: int, s: int, *, fresh: bool = False):
        """Cac nuoc 'ep ghep' cho buoi no (t, s): [(so o trung gio tao ra,
        lop, changes, cua so dich)], sap theo (so trung gio, loai nuoc) tang
        dan. fresh=True: them nuoc "doi buoi" (tiet le sang mot buoi GV chua
        day, o do co tiet ban co the ghep sat) — nuoc trung gian, chi co ich
        khi tang sau keo duoc tiet ban vao."""

        from itertools import permutations

        P = self.P
        cnt = soft.ts_cnt[t][s]
        if cnt <= 0:
            return []
        others = [s2 for s2 in range(NUM_SESSIONS) if s2 != s and soft.ts_cnt[t][s2] > 0]
        pairs: list[tuple[int, int, list[int], list[int]]] = []  # (kind, oc, run, W)
        if cnt == 1:
            partners = self._runs_of_teacher(soft, t, others)
            # B) tiet ban tu buoi khac -> ke sat tiet le
            for oc, run in partners:
                for W in self._force_windows(soft, t, s, len(run), holes_only=False):
                    pairs.append((0, oc, run, W))
            lone_runs = self._runs_of_teacher(soft, t, [s])
            # A) tiet le -> ke sat khoi cua GV o buoi khac
            for oc, run in lone_runs:
                for s2 in others:
                    for W in self._force_windows(soft, t, s2, len(run), holes_only=False):
                        pairs.append((0, oc, run, W))
            if fresh:
                # C) tiet le -> buoi GV chua day, o mot o ma it nhat mot tiet
                # ban co the ghep sat (buoc 1 cua chuoi 2 buoc)
                avail = P.teacher_avail[t]
                trow = soft.tcnt[t]
                for oc, run in lone_runs:
                    ai = soft.grid[oc][run[0]]
                    for s3 in range(NUM_SESSIONS):
                        if soft.ts_cnt[t][s3] > 0:
                            continue
                        base3 = s3 * PERIODS
                        for p in range(PERIODS):
                            x = base3 + p
                            if not P.a_allowed[ai][x] or trow[x] > 0:
                                continue
                            anchored = False
                            for oc2, run2 in partners:
                                ai2 = soft.grid[oc2][run2[0]]
                                L2 = len(run2)
                                wins = []
                                if p - L2 >= 0:
                                    wins.append([base3 + q for q in range(p - L2, p)])
                                if p + L2 <= PERIODS - 1:
                                    wins.append([base3 + q for q in range(p + 1, p + L2 + 1)])
                                for w in wins:
                                    if all(P.a_allowed[ai2][y] and avail[y] and trow[y] == 0 for y in w):
                                        anchored = True
                                        break
                                if anchored:
                                    break
                            if anchored:
                                pairs.append((1, oc, run, [x]))
        else:
            # trong >= 2: lap lo giua buoi bang tiet ban (buoi khac) hoac khoi
            # o ria cua chinh buoi nay
            for oc, run in self._runs_of_teacher(soft, t, others + [s]):
                run_set = set(run)
                for W in self._force_windows(soft, t, s, len(run), holes_only=True):
                    if run_set & set(W):
                        continue
                    pairs.append((0, oc, run, W))
        shift_cands: list[tuple[int, int, int, float, list[tuple[int, int]], list[int]]] = []
        gap_here = soft.ts_last[t][s] - soft.ts_first[t][s] + 1 - cnt
        if cnt >= 2 and gap_here == 1:
            # 23/08 (trua, nut "1 tiet trong"): lo dung 1 o tai h.
            #  (ii) DICH khoi >= 2 tiet ke lo sang 1 o (lo bi lap, tiet dang o
            #       h bi day ra o ria vua trong) — nuoc xoay 3 o ma
            #       _enum_quality_moves khong liet ke (cua so chong len run).
            #  (iii) day khoi o RIA (phia ben kia lo) sang buoi khac, ke sat
            #       mot khoi da co cua GV (lo bien mat, so buoi khong tang).
            base = s * PERIODS
            m = soft.ts_mask[t][s]
            first = soft.ts_first[t][s]
            last = soft.ts_last[t][s]
            h = -1
            for q in range(first + 1, last):
                if not (m & _MC_BIT[q]):
                    h = base + q
                    break
            runs_here = self._runs_of_teacher(soft, t, [s])
            if h >= 0:
                for oc, run in runs_here:
                    L = len(run)
                    if L < 2:
                        continue
                    if run[0] == h + 1:
                        W = [h + i for i in range(L)]
                        vacated = run[-1]
                    elif run[-1] == h - 1:
                        W = [h - L + 1 + i for i in range(L)]
                        vacated = run[0]
                    else:
                        continue
                    ai = soft.grid[oc][run[0]]
                    victim = soft.grid[oc][h]
                    if victim < 0 or victim == ai or t in P.a_teachers[victim]:
                        continue
                    if soft.locked[oc][h] or any(soft.locked[oc][x] for x in run):
                        continue
                    if self._run_window(soft, oc, h) != [h]:
                        continue
                    if not P.a_allowed[ai][h] or not P.a_allowed[victim][vacated]:
                        continue
                    cost = 1 if soft.busy(victim, vacated) > 0 else 0
                    changes = [(x, -1) for x in run] + [(w, ai) for w in W] + [(vacated, victim)]
                    if not self._changes_class_valid(soft, oc, changes, [ai, victim], {s}):
                        continue
                    shift_cands.append((cost, 0, self.rng.random(), oc, changes, W))
                # (iii) khoi o ria phia ben kia lo -> buoi khac ke sat khoi cua GV
                for oc, run in runs_here:
                    edge_after = run[0] == h + 1 and run[-1] == base + last
                    edge_before = run[-1] == h - 1 and run[0] == base + first
                    if not (edge_after or edge_before):
                        continue
                    for s2 in others:
                        for W in self._force_windows(soft, t, s2, len(run), holes_only=False):
                            pairs.append((0, oc, run, W))
        cands: list[tuple[int, int, int, float, list[tuple[int, int]], list[int]]] = list(shift_cands)
        cands.extend(self._pair_change_candidates(soft, t, pairs))
        if self.quality_focus == "gap1" and cnt >= 2 and gap_here == 1:
            # 26/08 (nut "1 tiet trong"): lap lo bang khoi cua GV tu buoi khac
            # (hoac khoi o ria buoi nay) ma cac tiet cua lop dang chiem lo duoc
            # DOI TOI BAT KY o trong hop le nao cua lop do (buoi GV cua chung
            # da day) — khong chi hoan doi vao o vua trong nhu
            # _pair_change_candidates. Cung bo sinh nuoc voi toan tu don buoi.
            seen_keys = {(oc0, tuple(changes0)) for _c, _k, _r, oc0, changes0, _W in cands}
            for oc, run in self._runs_of_teacher(soft, t, others + [s]):
                run_set = set(run)
                holes = [
                    W for W in self._force_windows(soft, t, s, len(run), holes_only=True)
                    if not (run_set & set(W))
                ]
                if not holes:
                    continue
                for item in self._evacuate_relocate_candidates(
                    soft, t, run[0] // PERIODS, oc, run, {s: [(0, W) for W in holes]}
                ):
                    key = (item[3], tuple(item[4]))
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    cands.append(item)
        cands.sort(key=lambda item: (item[0], item[1], item[2]))
        return [(cost, oc, changes, W) for cost, _k, _r, oc, changes, W in cands]

    def _pair_change_candidates(self, soft: SoftSchedule, t: int, pairs):
        """Bien cac cap (kind, lop, run, cua so dich) thanh nuoc di hoan chinh
        [(so o trung gio tao ra, kind, ngau nhien, lop, changes, W)]: khoi cua
        GV t chuyen vao W, cac khoi dang chiem W (GV khac) doi sang cho cu
        (thu toi da 6 hoan vi), luat lop duoc kiem. Dung chung cho ep ghep
        (gap1 / buoi 1 tiet) va don buoi (nut Buoi day)."""

        from itertools import permutations

        P = self.P
        cands: list[tuple[int, int, int, float, list[tuple[int, int]], list[int]]] = []
        for kind, oc, run, W in pairs:
            ai = soft.grid[oc][run[0]]
            L = len(run)
            if any(soft.locked[oc][x] for x in W):
                continue
            allowed = P.a_allowed[ai]
            if not all(allowed[x] for x in W):
                continue
            victims: list[tuple[int, list[int]]] = []
            x = 0
            ok = True
            while x < L:
                o = soft.grid[oc][W[x]]
                if o < 0 or o == ai or t in P.a_teachers[o]:
                    ok = False
                    break
                vrun = self._run_window(soft, oc, W[x])
                if vrun[0] != W[x] or vrun[-1] > W[-1]:
                    ok = False
                    break
                victims.append((o, vrun))
                x += len(vrun)
            if not ok:
                continue
            s_run = run[0] // PERIODS
            s_w = W[0] // PERIODS
            lesson_ids = [ai] + [v for v, _r in victims]
            for perm in list(permutations(range(len(victims))))[:6]:
                pos = 0
                changes: list[tuple[int, int]] = [(x, -1) for x in run]
                okp = True
                cost = 0
                for idx in perm:
                    vai, vrun = victims[idx]
                    size = len(vrun)
                    targets = run[pos : pos + size]
                    pos += size
                    vallowed = P.a_allowed[vai]
                    for st in targets:
                        if not vallowed[st]:
                            okp = False
                            break
                        if soft.busy(vai, st) > 0:
                            cost += 1
                    if not okp:
                        break
                    changes.extend((st, vai) for st in targets)
                if not okp:
                    continue
                changes.extend((w, ai) for w in W)
                if not self._changes_class_valid(soft, oc, changes, lesson_ids, {s_run, s_w}):
                    continue
                cands.append((cost, kind, self.rng.random(), oc, changes, W))
                break
        return cands

    def _force_pair_session(
        self,
        soft: SoftSchedule,
        t: int,
        s: int,
        weights,
        deadline: float,
        *,
        max_tries: int = 12,
        target_score: int | None = None,
        depth: int = 0,
        floor_teachers: set[int] | None = None,
    ) -> bool:
        """Thu lan luot cac nuoc ep ghep cho buoi (t, s); nhan nuoc dau tien
        lam diem chat luong TOT HON target_score ma sach trung gio / luat /
        khoa. Nuoc trung hoa (vd. GV bi day ra lai thanh buoi 1 tiet) duoc
        noi tiep toi da 2 tang: cac buoi no MOI cua GV lien quan lai duoc ep
        ghep tiep (cac o da ghep o tang tren bi KHOA)."""

        P = self.P
        if target_score is None:
            target_score = self._quality_score(soft, weights)
        if floor_teachers is None:
            floor_teachers = set()
        # 26/08: nut gap1 cho buoi trong so 100 (<< trong 1 = 10^4) nen bo sua
        # trung gio sau nuoc ep thoai mai MO BUOI MOI, roi tran buoi (10^9)
        # loai ca nuoc: 1700/2000 nuoc ep tren luoi 625/159 chet vi the. Khi
        # dang ep, bo sua phai thay "buoi" nang hon "trong 1".
        repair_weights = weights
        if self._session_cap is not None and weights[2] < weights[3]:
            repair_weights = (weights[0], weights[1], max(weights[2], weights[3] * 100), weights[3])
        cands = self._force_pair_candidates(soft, t, s, fresh=(depth == 0))
        fp = self.__dict__.setdefault("_fp_stats", collections.Counter())
        if depth == 0:
            fp["calls"] += 1
            fp["cands"] += len(cands)
            if not cands:
                fp["no_cands"] += 1
        if not cands and soft.ts_cnt[t][s] != 1:
            return False
        snap = [row[:] for row in soft.grid]

        def restore() -> None:
            for c in range(P.num_classes()):
                row = soft.grid[c]
                srow = snap[c]
                for slot in range(NUM_SLOTS):
                    if row[slot] != srow[slot]:
                        soft.set_cell(c, slot, srow[slot])
            for t2 in self._has_rule_teachers:
                soft.refresh_rule_pen(t2)

        tries = 0
        for cost, oc, changes, W in cands:
            if tries >= max_tries or time.monotonic() > deadline:
                break
            tries += 1
            partner_teachers = {
                tt for _x, v in changes if v >= 0 for tt in P.a_teachers[v]
            }
            sessions_at_try = soft.quality()[2]
            self._apply_changes(soft, oc, changes)
            for x in W:
                soft.locked[oc][x] = 1
            try:
                ok = soft.penalty() == 0
                if not ok:
                    budget = min(deadline, time.monotonic() + (0.35 if cost <= 1 else 0.6))
                    ok = self._repair_penalty_local(soft, budget, repair_weights)
                if ok and soft.penalty() == 0:
                    if (
                        self._quality_score(soft, weights) < target_score
                        and not self._lock_violated(soft)
                    ):
                        return True
                    if depth == 0:
                        cap = self._session_cap
                        grew = soft.quality()[2] > sessions_at_try
                        fp["try_adds_session" if (cap is not None and grew) else ("try_lock" if self._lock_violated(soft) else "try_not_better")] += 1
                elif depth == 0:
                    fp["try_penalty"] += 1
                    if depth < 2 and time.monotonic() < deadline:
                        nxt = self._chain_debts_of(soft, partner_teachers | {t}, floor_teachers)
                        self.rng.shuffle(nxt)
                        for t2, s2 in nxt[:4]:
                            if time.monotonic() > deadline:
                                break
                            if self._force_pair_session(
                                soft, t2, s2, weights, deadline,
                                max_tries=6, target_score=target_score,
                                depth=depth + 1, floor_teachers=floor_teachers,
                            ):
                                return True
            finally:
                for x in W:
                    soft.locked[oc][x] = 0
            restore()
        # Bien the "chu trinh doi nhan" (ca TD.Qui, TKB default: moi tiet khac
        # cua GV deu bi nguoi dung KHOA, chi con tiet le di chuyen duoc; o dich
        # ke sat khoi da khoa bi tiet GV khac chiem ma tiet do khong ve duoc o
        # cu): tiet don chuyen toi o dich, tiet bi chiem duoc day tiep theo mot
        # chu trinh TRONG LOP (moi tiet chi dap xuong o GV minh ranh, luat lop
        # duoc kiem), chon chu trinh it hai chat luong nhat trong vai lan thu;
        # no moi phat sinh lai duoc ep ghep tiep o tang duoi.
        if soft.ts_cnt[t][s] == 1 and time.monotonic() < deadline:
            triples = self._force_cycle_triples(soft, t, s)
            for oc, src, dst in triples[:8]:
                if time.monotonic() > deadline:
                    break
                best_fwd = None
                best_sc = None
                for _attempt in range(5):
                    inverse = self._cycle_relocate(soft, oc, src, dst, max_depth=8, node_budget=6000)
                    if inverse is None:
                        continue
                    sc = self._quality_score(soft, weights)
                    fwd = [(slot, soft.grid[oc][slot]) for slot, _old in inverse]
                    self._apply_changes(soft, oc, inverse)
                    if best_sc is None or sc < best_sc:
                        best_sc = sc
                        best_fwd = fwd
                if best_fwd is None:
                    continue
                touched = {
                    tt for _slot, v in best_fwd if v >= 0 for tt in P.a_teachers[v]
                }
                self._apply_changes(soft, oc, best_fwd)
                soft.locked[oc][dst] = 1
                try:
                    if soft.penalty() == 0:
                        if (
                            self._quality_score(soft, weights) < target_score
                            and not self._lock_violated(soft)
                        ):
                            return True
                        if depth < 2 and time.monotonic() < deadline:
                            nxt = self._chain_debts_of(soft, touched | {t}, floor_teachers)
                            self.rng.shuffle(nxt)
                            for t2, s2 in nxt[:4]:
                                if time.monotonic() > deadline:
                                    break
                                if self._force_pair_session(
                                    soft, t2, s2, weights, deadline,
                                    max_tries=6, target_score=target_score,
                                    depth=depth + 1, floor_teachers=floor_teachers,
                                ):
                                    return True
                finally:
                    soft.locked[oc][dst] = 0
                restore()
        return False

    def _force_cycle_triples(self, soft: SoftSchedule, t: int, s: int):
        """(lop, o nguon, o dich) cho bien the chu trinh: tiet le -> ke sat khoi
        khac cua GV; tiet ban 1 o (buoi khac) -> ke sat tiet le."""

        P = self.P
        out: list[tuple[int, int, int]] = []
        others = [s2 for s2 in range(NUM_SESSIONS) if s2 != s and soft.ts_cnt[t][s2] > 0]
        for oc, run in self._runs_of_teacher(soft, t, [s]):
            if len(run) != 1:
                continue
            ai = soft.grid[oc][run[0]]
            for s2 in others:
                for W in self._force_windows(soft, t, s2, 1, holes_only=False):
                    dst = W[0]
                    if P.a_allowed[ai][dst] and not soft.locked[oc][dst]:
                        out.append((oc, run[0], dst))
        lone_windows = self._force_windows(soft, t, s, 1, holes_only=False)
        for oc, run in self._runs_of_teacher(soft, t, others):
            if len(run) != 1:
                continue
            ai = soft.grid[oc][run[0]]
            for W in lone_windows:
                dst = W[0]
                if P.a_allowed[ai][dst] and not soft.locked[oc][dst]:
                    out.append((oc, run[0], dst))
        self.rng.shuffle(out)
        return out

    # Nut "Buoi day": buoi cua GV co toi da bay nhieu tiet moi duoc thu don.
    _EVACUATE_MAX_CNT = 3

    def _thin_sessions_of(self, soft: SoftSchedule, teachers, max_cnt: int | None = None):
        """Cac buoi (t, s) co 1..max_cnt tiet, KHONG co o khoa — ung vien de
        don sang buoi khac cua GV (nut "Buoi day"). Xep buoi it tiet truoc."""

        P = self.P
        if max_cnt is None:
            max_cnt = self._EVACUATE_MAX_CNT
        out: list[tuple[int, int, int]] = []
        for t in teachers:
            if t < 0:
                continue
            for s in range(NUM_SESSIONS):
                cnt = soft.ts_cnt[t][s]
                if cnt <= 0 or cnt > max_cnt:
                    continue
                if cnt == 1 and self._single_excused(soft, t, s):
                    continue
                base = s * PERIODS
                locked = False
                for p in range(PERIODS):
                    x = base + p
                    if soft.tcnt[t][x] <= 0:
                        continue
                    oc = self._owner_class(soft, t, x)
                    if oc < 0 or soft.locked[oc][x]:
                        locked = True
                        break
                if locked:
                    continue
                out.append((cnt, self.rng.random(), t, s))
        # it tiet truoc; trong cung so tiet thi ngau nhien de cac dot quet /
        # cac worker khong cung dam vao mot nhom buoi dau danh sach
        out.sort()
        return [(t, s) for _cnt, _r, t, s in out]

    def _force_evacuate_session(
        self,
        soft: SoftSchedule,
        t: int,
        s: int,
        weights,
        deadline: float,
        *,
        max_tries: int = 6,
        floor_teachers: set[int] | None = None,
    ) -> bool:
        """25/08 (nut "Buoi day"): DON buoi mong (t, s) — ep TUNG khoi tiet cua
        GV t trong buoi nay sang mot cua so ke sat khoi GV dang day o buoi
        khac (hoac lap lo giua buoi do), sua trung gio / luat GV bang bo sua
        cuc bo sau moi khoi, cac o vua don bi KHOA cho toi khi xong. Chi nhan
        khi buoi trong hoan toan, sach trung gio, khong pha khoa, va diem
        chat luong TOT HON (trong so buoi 10^5 >> trong 1 nen so buoi giam
        la du). That bai o bat ky khoi nao -> hoan nguyen toan bo.

        Day la phien ban "buoi" cua _force_pair_session: tabu 2-hoan-doi hau
        nhu khong bao gio go duoc mot buoi 2-3 tiet vi phai di chuyen ca khoi
        qua vung dang ban cua GV khac."""

        P = self.P
        stats = self.__dict__.setdefault("_evac_stats", collections.Counter())
        stats["calls"] += 1
        cnt = soft.ts_cnt[t][s]
        if cnt <= 0 or cnt > self._EVACUATE_MAX_CNT:
            stats["skip_cnt"] += 1
            return False
        if floor_teachers is None:
            floor_teachers = set()
        target_score = self._quality_score(soft, weights)
        sessions0 = soft.quality()[2]
        runs = self._runs_of_teacher(soft, t, [s])
        if not runs or sum(len(r) for _oc, r in runs) != cnt:
            stats["skip_runs"] += 1
            return False
        runs.sort(key=lambda item: -len(item[1]))
        snap = [row[:] for row in soft.grid]

        def restore_to(grid_snap) -> None:
            for c in range(P.num_classes()):
                row = soft.grid[c]
                srow = grid_snap[c]
                for slot in range(NUM_SLOTS):
                    if row[slot] != srow[slot]:
                        soft.set_cell(c, slot, srow[slot])
            for t2 in self._has_rule_teachers:
                soft.refresh_rule_pen(t2)

        locked_cells: list[tuple[int, int]] = []

        def unlock_all() -> None:
            for oc2, x in locked_cells:
                soft.locked[oc2][x] = 0
            locked_cells.clear()

        for oc, run in runs:
            if time.monotonic() > deadline or self._stop_requested():
                restore_to(snap)
                unlock_all()
                return False
            if soft.grid[oc][run[0]] < 0 or t not in P.a_teachers[soft.grid[oc][run[0]]]:
                # khoi da bi bo sua cuc bo cua buoc truoc doi cho
                restore_to(snap)
                unlock_all()
                return False
            others = [s2 for s2 in range(NUM_SESSIONS) if s2 != s and soft.ts_cnt[t][s2] > 0]
            windows = self._evacuate_windows(soft, t, others, len(run))
            pairs = [(kind, oc, run, W) for s2 in others for kind, W in windows.get(s2, ())]
            cands = self._pair_change_candidates(soft, t, pairs)
            cands.extend(self._evacuate_relocate_candidates(soft, t, s, oc, run, windows))
            if not cands:
                stats["run_no_cands"] += 1
                restore_to(snap)
                unlock_all()
                return False
            run_set = set(run)

            def new_session_cost(changes) -> int:
                # Khoi bi day sang cac o vua trong (cung buoi s cua lop nay):
                # GV cua khoi do chua day buoi s thi mo them mot buoi moi ->
                # so buoi khong giam. Uu tien nuoc khong mo buoi moi.
                extra = 0
                for slot, v in changes:
                    if v < 0 or slot not in run_set:
                        continue
                    for tt in P.a_teachers[v]:
                        if tt != t and soft.ts_cnt[tt][s] == 0:
                            extra += 1
                return extra

            cands.sort(key=lambda item: (new_session_cost(item[4]), item[0], item[1], item[2]))
            run_snap = [row[:] for row in soft.grid]
            sessions_before = soft.quality()[2]
            cnt_before = soft.ts_cnt[t][s]
            moved = False
            tries = 0
            for cost, _kind, _r, oc2, changes, W in cands:
                if tries >= max_tries or time.monotonic() > deadline:
                    break
                tries += 1
                self._apply_changes(soft, oc2, changes)
                for x in W:
                    soft.locked[oc2][x] = 1
                ok = soft.penalty() == 0
                if not ok:
                    budget = min(deadline, time.monotonic() + (0.5 if cost <= 1 else 0.9))
                    ok = self._repair_penalty_local(soft, budget, weights)
                # Khoa (buoi 1 tiet / trong >= 2) chi kiem o CUOI: sau khi don
                # khoi dau tien, tiet con lai cua buoi tam thoi la buoi 1 tiet.
                # Nhung moi buoc phai "trung hoa ve buoi": buoi nguon voi dung
                # so tiet vua don, va tong so buoi khong tang (bo sua xung dot
                # khong duoc mo buoi moi cho GV khac / keo tiet cua t quay lai).
                # buoc lam trong hoan toan buoi nguon thi tong so buoi phai GIAM.
                expected_max = sessions_before - (1 if cnt_before - len(run) == 0 else 0)
                if (
                    ok
                    and soft.penalty() == 0
                    and soft.ts_cnt[t][s] == cnt_before - len(run)
                    and soft.quality()[2] <= expected_max
                ):
                    locked_cells.extend((oc2, x) for x in W)
                    moved = True
                    break
                stats["try_fail_penalty" if not ok or soft.penalty() > 0 else "try_fail_sessions"] += 1
                for x in W:
                    soft.locked[oc2][x] = 0
                restore_to(run_snap)
            if not moved:
                stats["run_fail"] += 1
                restore_to(snap)
                unlock_all()
                return False
            stats["run_moved"] += 1
        emptied = soft.ts_cnt[t][s] == 0
        # "Tot hon" phai la GIAM SO BUOI that (khong phai chi trong 1 giam
        # trong khi khoi bi day ra mo them buoi cho GV khac -> hoa).
        better = (
            self._quality_score(soft, weights) < target_score
            and soft.quality()[2] < sessions0
        )
        ok = emptied and soft.penalty() == 0 and better and not self._lock_violated(soft)
        unlock_all()
        if not ok:
            stats["final_not_emptied" if not emptied else ("final_not_better" if not better else "final_other")] += 1
            restore_to(snap)
            return False
        stats["success"] += 1
        if os.environ.get("TKB_EVAC_DEBUG"):
            sys.stderr.write(
                f"[evac-ok] t={t} s={s} cnt={cnt} sessions {sessions0}->{soft.quality()[2]} q={soft.quality()[:4]} "
                f"score {target_score}->{self._quality_score(soft, weights)}\n"
            )
        return True

    def _evacuate_windows(self, soft: SoftSchedule, t: int, sessions, L: int):
        """Cua so dich (theo buoi) cho mot khoi L tiet cua GV t khi don buoi:
        kind 0 = ke sat khoi / lap lo cua GV (giu trong), kind 3 = bat ky day
        L o lien tiep nao GV ranh trong buoi GV da day (co the sinh trong 1 —
        hop dong nut Buoi day cho phep, trong >= 2 bi khoa se tu loai)."""

        P = self.P
        avail = P.teacher_avail[t]
        trow = soft.tcnt[t]
        out: dict[int, list[tuple[int, list[int]]]] = {}
        for s2 in sessions:
            wins: list[tuple[int, list[int]]] = []
            seen: set[tuple[int, ...]] = set()
            for W in self._force_windows(soft, t, s2, L, holes_only=False):
                key = tuple(W)
                if key not in seen:
                    seen.add(key)
                    wins.append((0, W))
            base = s2 * PERIODS
            for p in range(PERIODS - L + 1):
                W = [base + p + i for i in range(L)]
                key = tuple(W)
                if key in seen:
                    continue
                if all(avail[x] and trow[x] == 0 for x in W):
                    seen.add(key)
                    wins.append((3, W))
            if wins:
                out[s2] = wins
        return out

    def _evacuate_relocate_candidates(self, soft: SoftSchedule, t: int, s: int, oc: int, run: list[int], windows):
        """25/08 (don buoi): khoi `run` (lop oc, GV t, buoi s) -> cua so W ke
        khoi cua t o buoi khac; cac khoi cua lop oc dang chiem W duoc DOI TOI
        BAT KY o trong nao cua lop oc ke khoi cua GV chung (buoi GV do da
        day), khong chi vao cac o vua trong. Mo rong dang ke so nuoc di so
        voi _pair_change_candidates (3/4 so buoi mong khong co nuoc nao)."""

        P = self.P
        ai = soft.grid[oc][run[0]]
        if ai < 0:
            return []
        L = len(run)
        run_set = set(run)
        out: list[tuple[int, int, float, int, list[tuple[int, int]], list[int]]] = []
        row = soft.grid[oc]
        st = self.__dict__.setdefault("_evac_stats", collections.Counter())
        for s2, wins in windows.items():
            for kind, W in wins:
                st["w_total"] += 1
                if any(soft.locked[oc][x] for x in W) or not all(P.a_allowed[ai][x] for x in W):
                    st["w_locked_or_disallowed"] += 1
                    continue
                # Cac khoi cua lop oc dang chiem W: doi TRON khoi (ke ca phan
                # thoa ra ngoai W — cac o do thanh o trong), moi khoi mot lan.
                victims: list[tuple[int, list[int]]] = []
                seen_runs: set[int] = set()
                ok = True
                for w in W:
                    o = row[w]
                    if o < 0 or w in seen_runs:
                        continue
                    if o == ai or t in P.a_teachers[o]:
                        ok = False
                        break
                    vrun = self._run_window(soft, oc, w)
                    if any(soft.locked[oc][y] for y in vrun):
                        ok = False
                        break
                    victims.append((o, vrun))
                    seen_runs.update(vrun)
                if not ok or not victims:
                    # cua so trong hoan toan da duoc _pair_change_candidates xu ly
                    st["w_victim_misaligned" if not ok else "w_empty"] += 1
                    continue
                vacated = run_set | seen_runs
                changes: list[tuple[int, int]] = [(y, -1) for y in run]
                changes.extend((y, -1) for y in seen_runs if y not in run_set)
                changes.extend((w, ai) for w in W)
                used = set(W)
                touched = {s, s2}
                okp = True
                for v, vrun in victims:
                    Lv = len(vrun)
                    members = P.a_teachers[v]
                    if not members:
                        okp = False
                        break
                    anchor = members[0]

                    def cell_free(y: int) -> bool:
                        if y in used or soft.locked[oc][y] or not P.a_allowed[v][y]:
                            return False
                        if row[y] >= 0 and y not in vacated:
                            return False
                        # o hien tai cua chinh khoi nay: GV cua no dang "ban" o do
                        # vi chinh tiet nay (moi thanh vien 1) -> van la o trong.
                        if y in vrun:
                            return soft.busy(v, y) <= len(members)
                        return soft.busy(v, y) == 0

                    dest: list[int] | None = None
                    # (1) ke sat khoi cua GV o buoi GV da day (giu trong/khong tao lo)
                    for s3 in range(NUM_SESSIONS):
                        if soft.ts_cnt[anchor][s3] <= 0:
                            continue
                        for D in self._force_windows(soft, anchor, s3, Lv, holes_only=False):
                            if all(cell_free(y) for y in D):
                                dest = D
                                break
                        if dest is not None:
                            break
                    if dest is None:
                        # (2) du phong: bat ky day o trong lien tiep nao cua lop
                        # oc trong mot buoi GV da day (co the tao trong 1 — diem
                        # chat luong se phan xu, buoi van la uu tien tuyet doi).
                        for s3 in range(NUM_SESSIONS):
                            if soft.ts_cnt[anchor][s3] <= 0:
                                continue
                            base3 = s3 * PERIODS
                            for p in range(PERIODS - Lv + 1):
                                D = [base3 + p + i for i in range(Lv)]
                                if all(cell_free(y) for y in D):
                                    dest = D
                                    break
                            if dest is not None:
                                break
                    if dest is None:
                        okp = False
                        break
                    changes.extend((y, v) for y in dest)
                    used.update(dest)
                    touched.add(dest[0] // PERIODS)
                if not okp:
                    st["w_victim_no_dest"] += 1
                    continue
                lesson_ids = [ai] + [v for v, _r in victims]
                if not self._changes_class_valid(soft, oc, changes, lesson_ids, touched):
                    st["w_class_invalid"] += 1
                    continue
                st["w_ok"] += 1
                out.append((0, kind, self.rng.random(), oc, changes, W))
        return out

    # ------------------------------------------------------------------
    # 26/08: CP-SAT LNS theo cum (nut "1 tiet trong" / "Buoi day")
    # ------------------------------------------------------------------
    def _cpsat_available(self) -> bool:
        if getattr(self, "_cpsat_checked", None) is not None:
            return bool(self._cpsat_checked)
        ok = False
        try:
            from . import cpsat_lns

            ok = bool(cpsat_lns.available())
        except Exception:
            ok = False
        self._cpsat_checked = ok
        return ok

    def _cpsat_threads_effective(self) -> int:
        n = int(self.cpsat_threads or 0)
        if n <= 0:
            n = max(1, min(8, os.cpu_count() or 1))
        return max(1, min(16, n))

    def _cpsat_pick_cluster(self, soft: SoftSchedule, lane: str, max_classes: int) -> list[int]:
        """Cum lop cho mot pass: xep GV theo so buoi NO (gap1: buoi ho 1 tiet;
        sessions: buoi 1..3 tiet) giam dan, xoay diem bat dau theo pass, gom
        cac lop dang chua tiet cua nhung buoi no do cho toi max_classes."""

        P = self.P
        T = P.num_teachers()
        if lane == "gap1":
            debts = self._gap1_sessions_of(soft, set(range(T)))
        else:
            debts = self._thin_sessions_of(soft, range(T))
        if not debts:
            return []
        per_t: dict[int, list[int]] = collections.defaultdict(list)
        for t, s in debts:
            per_t[t].append(s)
        order = sorted(per_t, key=lambda t: (-len(per_t[t]), t))
        off = self._cpsat_pass_idx % len(order)
        order = order[off:] + order[:off]
        classes: list[int] = []
        seen: set[int] = set()
        for t in order:
            for s in per_t[t]:
                base = s * PERIODS
                for p in range(PERIODS):
                    x = base + p
                    if soft.tcnt[t][x] <= 0:
                        continue
                    oc = self._owner_class(soft, t, x)
                    if oc >= 0 and oc not in seen:
                        seen.add(oc)
                        classes.append(oc)
                        if len(classes) >= max_classes:
                            return classes
        return classes

    def _run_quality(self, soft: SoftSchedule, deadline: float, *, progress=None, info: dict | None = None) -> None:
        """Toi uu chat luong GV: pha 3 (tabu nhanh lam nong luoi) + CP-SAT LNS
        (_cpsat_quality_phase) chiem ~88% thoi gian con lai. env TKB_CPSAT_QUALITY=0 tat."""

        use_cpsat = (
            self.quality_focus is None
            and self.cherry_cpsat
            and os.environ.get("TKB_CPSAT_QUALITY", "1") != "0"
            and self._cpsat_available()
        )
        remaining = deadline - time.monotonic()
        if not use_cpsat or remaining < 4.5:
            self.phase3_quality(soft, deadline, progress=progress)
            return
        warmup = (
            min(14.0, max(7.5, remaining * 0.45))
            if soft.q_singleton > 10
            else min(3.2, max(1.5, remaining * 0.15))
        )
        self.phase3_quality(soft, time.monotonic() + warmup, progress=progress)
        if self._stop_requested() or soft.penalty() != 0:
            return
        stats = self._cpsat_quality_phase(soft, deadline - 0.4, progress=progress)
        if info is not None:
            info["cpsat_quality"] = stats

    def _cpsat_debt_cluster(
        self,
        soft: SoftSchedule,
        debts: list[tuple[int, int]],
        k: int,
        debt_tries: dict[tuple[int, int], int] | None = None,
    ) -> list[int]:
        """Cum lop ket noi theo GV va doi tac hoan doi cho cac buoi no (GV, buoi):
        (1) lop dang giu tiet cua GV trong buoi no s0,
        (2) cac lop khac cua cung GV (uu tien buoi mong 1-2 tiet cua GV do),
        (3) cac lop chan doi tac hoan doi (GV khac day cung lop c0 tai cac buoi GV
            dang co mat), roi moi bo sung lop con lai cho du k."""

        P = self.P
        rng = self.rng
        order = list(debts)
        if debt_tries:
            order.sort(key=lambda item: (debt_tries.get(item, 0), rng.random()))
        else:
            rng.shuffle(order)
        classes: list[int] = []
        seen: set[int] = set()

        def add(c: int) -> None:
            if c >= 0 and c not in seen and len(classes) < k:
                seen.add(c)
                classes.append(c)

        for idx, (t, s) in enumerate(order):
            if len(classes) >= k:
                break
            if debt_tries is not None and idx == 0:
                debt_tries[(t, s)] = debt_tries.get((t, s), 0) + 1
            base = s * PERIODS
            owner_here: list[int] = []
            for p in range(PERIODS):
                x = base + p
                if soft.tcnt[t][x] <= 0:
                    continue
                oc = self._owner_class(soft, t, x)
                if oc >= 0:
                    owner_here.append(oc)
                    add(oc)
            if idx < 2:
                # Cac lop khac ma GV t day (uu tien buoi mong <= 2 tiet cua t)
                thin_classes: list[int] = []
                other_classes: list[int] = []
                for s2 in range(NUM_SESSIONS):
                    if s2 == s or soft.ts_cnt[t][s2] <= 0:
                        continue
                    is_thin = soft.ts_cnt[t][s2] <= 2
                    b2 = s2 * PERIODS
                    for p2 in range(PERIODS):
                        x2 = b2 + p2
                        if soft.tcnt[t][x2] <= 0:
                            continue
                        oc2 = self._owner_class(soft, t, x2)
                        if oc2 >= 0 and oc2 not in seen:
                            (thin_classes if is_thin else other_classes).append(oc2)
                rng.shuffle(thin_classes)
                rng.shuffle(other_classes)
                for oc2 in thin_classes + other_classes[:3]:
                    add(oc2)
                # Lop chan cua cac GV khac day cung lop owner_here tai buoi s
                for c0 in owner_here:
                    swap_teachers: set[int] = set()
                    for s2 in range(NUM_SESSIONS):
                        if s2 == s or soft.ts_cnt[t][s2] <= 0:
                            continue
                        b2 = s2 * PERIODS
                        for p2 in range(PERIODS):
                            ai2 = soft.grid[c0][b2 + p2]
                            if ai2 >= 0:
                                swap_teachers.update(P.a_teachers[ai2])
                    swap_teachers.discard(t)
                    blocker_classes: list[int] = []
                    for t2 in swap_teachers:
                        for p in range(PERIODS):
                            x = base + p
                            if soft.tcnt[t2][x] > 0:
                                bc = self._owner_class(soft, t2, x)
                                if bc >= 0 and bc not in seen:
                                    blocker_classes.append(bc)
                    rng.shuffle(blocker_classes)
                    for bc in blocker_classes[:2]:
                        add(bc)
        C = P.num_classes()
        guard = 0
        while len(classes) < min(k, C) and guard < 10 * C:
            guard += 1
            add(rng.randrange(C))
        return classes[: max(k, 1)]

    def _cpsat_debt_sessions(
        self,
        soft: SoftSchedule,
        debts: list[tuple[int, int]],
        debt_tries: dict[tuple[int, int], int],
    ) -> list[int]:
        """Chon 2 buoi toan truong nham thang vao mot buoi no (1 tiet/buoi hoac
        trong >= 2) cua GV t0 va mot buoi khac ma GV t0 cung day (uu tien buoi
        mong 1-3 tiet cua t0) de gop/chuyen tiet giua 2 buoi."""

        if not debts:
            return []
        rng = self.rng
        order = sorted(debts, key=lambda item: (debt_tries.get(item, 0), rng.random()))
        t0, s0 = order[0]
        debt_tries[(t0, s0)] = debt_tries.get((t0, s0), 0) + 1
        own_thin = [
            s for s in range(NUM_SESSIONS)
            if s != s0 and 0 < soft.ts_cnt[t0][s] <= 3
        ]
        own_any = [
            s for s in range(NUM_SESSIONS)
            if s != s0 and soft.ts_cnt[t0][s] > 0
        ]
        cands = own_thin or own_any
        if not cands:
            open_s = [
                s for s in range(NUM_SESSIONS)
                if s != s0 and any(self.P.class_avail[c][s * PERIODS + p] for c in range(self.P.num_classes()) for p in range(PERIODS))
            ]
            if not open_s:
                return []
            cands = open_s
        s1 = cands[rng.randrange(len(cands))]
        return sorted((s0, s1))

    def _cpsat_quality_phase(self, soft: SoftSchedule, deadline: float, *, progress=None) -> dict:
        """01/10: vong CP-SAT LNS chat luong cho nut Cherry tren luoi DU tiet,
        sach no (lane "fill", fill_quality=True, require_full=True). Vung: cum lop
        ket noi theo GV quanh buoi no (1 tiet / trong >= 2 truoc, roi buoi mong /
        buoi trong 1) xen ke vung "nguyen buoi toan truong". Chi nhan khi
        _quality_score (thu tu bac) GIAM, penalty() == 0, khong vuot khoa, so tiet
        khong doi, _load_state hop le."""

        from . import cpsat_lns

        P = self.P
        T = P.num_teachers()
        weights = (10**11, 10**8, 10**5, 10)
        stats: dict = {"pass": 0, "accept": 0, "session_pass": 0, "rejected": 0, "none": 0, "error": 0}
        started = time.monotonic()
        threads = self._cpsat_threads_effective()
        sub_limit = float(max(1, self._cpsat_env_int("TKB_CPSAT_QUALITY_LIMIT", 2)))
        k_default = 8 if threads >= 4 else 6
        k_max = max(4, self._cpsat_env_int("TKB_CPSAT_QUALITY_K", k_default))
        stats["start"] = [int(x) for x in soft.quality()[:4]]
        floor_teachers = self._singleton_floor_teachers()
        start_valid = self._load_state(soft) is not None
        stats["start_valid"] = start_valid
        expected = sum(P.a_periods)
        tried_keys: set = set()
        debt_tries: dict[tuple[int, int], int] = {}
        last_sg_g2 = (soft.q_singleton, soft.q_gap2)
        while not self._stop_requested():
            now = time.monotonic()
            rem = deadline - now - 0.2
            if rem < 0.6:
                break
            cur_sg_g2 = (soft.q_singleton, soft.q_gap2)
            if cur_sg_g2 < last_sg_g2:
                debt_tries.clear()
                last_sg_g2 = cur_sg_g2
            placed0 = sum(1 for row in soft.grid for v in row if v >= 0)
            score0 = self._quality_score(soft, weights)
            act_debts = self._debt_sessions_of(soft, set(range(T)), floor_teachers)
            unexhausted_debts = [d for d in act_debts if debt_tries.get(d, 0) < 3]
            sessions: list[int] | None = None
            classes: list[int] = []
            limit = min(sub_limit, rem)
            turn = stats["pass"] % 3
            if turn == 1:
                if unexhausted_debts and self.rng.random() < 0.7:
                    sessions = self._cpsat_debt_sessions(soft, unexhausted_debts, debt_tries) or None
                else:
                    lane = "sessions" if self.rng.random() < 0.55 else "gap1"
                    sessions = self._cpsat_pick_sessions(soft, lane) or None
                if sessions:
                    classes = list(range(P.num_classes()))
                    limit = min(max(sub_limit * 1.6, 3.2), rem)
            if not sessions:
                sessions = None
                k = self.rng.randint(max(4, k_max - 3), k_max)
                if unexhausted_debts and self.rng.random() < 0.75:
                    target_debts = act_debts
                elif act_debts and self.rng.random() < 0.30:
                    target_debts = act_debts
                elif self.rng.random() < 0.55:
                    target_debts = list(self._thin_sessions_of(soft, range(T)))
                else:
                    target_debts = list(self._gap1_sessions_of(soft, set(range(T))))
                if not target_debts:
                    target_debts = list(self._thin_sessions_of(soft, range(T))) or list(self._gap1_sessions_of(soft, set(range(T))))
                classes = self._cpsat_debt_cluster(soft, target_debts, k, debt_tries) if target_debts else []
                if not classes:
                    break
            key = ("S", tuple(sessions)) if sessions is not None else ("C", frozenset(classes))
            if key in tried_keys and len(tried_keys) < 40:
                self._cpsat_pass_idx += 1
                continue
            tried_keys.add(key)
            if sessions is not None:
                stats["session_pass"] += 1
            stats["pass"] += 1
            self._cpsat_pass_idx += 1
            try:
                new_cells, cinfo = cpsat_lns.build_and_solve(
                    P, soft, classes, "fill",
                    time_limit=limit, workers=threads, seed=self._cpsat_pass_idx,
                    stop_check=self._stop_requested, require_improve=False,
                    sessions=sessions, fill_quality=True,
                    require_full=(placed0 >= expected),
                )
            except Exception as exc:  # noqa: BLE001 - toan tu phu
                stats["error"] += 1
                if os.environ.get("TKB_EVAC_DEBUG"):
                    sys.stderr.write(f"[cq] error {exc!r}\n")
                continue
            if new_cells is None:
                stats["none"] += 1
                continue
            journal = cpsat_lns.apply_cells(soft, new_cells)
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)
            placed1 = sum(1 for row in soft.grid for v in row if v >= 0)
            ok = (
                placed1 == placed0
                and soft.penalty() == 0
                and not self._lock_violated(soft)
                and self._quality_score(soft, weights) < score0
            )
            if ok and start_valid:
                ok = self._load_state(soft) is not None
            if not ok:
                cpsat_lns.revert(soft, journal)
                for t in self._has_rule_teachers:
                    soft.refresh_rule_pen(t)
                stats["rejected"] += 1
                continue
            stats["accept"] += 1
            tried_keys.clear()
            if self._lock_singleton is not None and soft.q_singleton < self._lock_singleton:
                self._lock_singleton = soft.q_singleton
            if self._lock_gap2 is not None and soft.q_gap2 < self._lock_gap2:
                self._lock_gap2 = soft.q_gap2
            q = soft.quality()
            if os.environ.get("TKB_EVAC_DEBUG"):
                sys.stderr.write(
                    f"[cq] accept q={list(q[:4])} sessions={sessions} n={len(classes)} "
                    f"t={time.monotonic() - started:.1f}s status={(cinfo or {}).get('status')}\n"
                )
            self._offer_focus_candidate(soft.grid, q)
            if progress is not None:
                try:
                    progress({
                        "stage": "optimize:quality",
                        "message": "CP-SAT: 1tiet=%d trong2=%d buoi=%d trong1=%d" % tuple(int(v) for v in q[:4]),
                        "phase_stage": 3,
                        "quality": [int(q[0]), int(q[1]), int(q[2]), int(q[3])],
                        "quality_trial": [int(q[0]), int(q[1]), int(q[2]), int(q[3])],
                    })
                except Exception:
                    pass
        stats["end"] = [int(x) for x in soft.quality()[:4]]
        stats["seconds"] = round(time.monotonic() - started, 1)
        self._stage_log.append({
            "stage": 3, "exit": "cpsat", "seconds": stats["seconds"], "quality": stats["end"],
        })
        return stats

    def _cpsat_fill_cluster(self, soft: SoftSchedule, missing: list[int], k: int) -> list[int]:
        """Cum lop cho mot lan lap tiet thieu: lop cua mot phan cong con thieu
        + cac lop dang GIU GV cua no o nhung o trong cua lop do (nguoi chan) +
        lop khac cua cung GV + (doi khi) mot lop thieu khac + ngau nhien."""

        P = self.P
        rng = self.rng
        ai = missing[rng.randrange(len(missing))]
        c0 = P.a_class[ai]
        classes: list[int] = [c0]
        seen = {c0}

        def add(c: int) -> None:
            if c >= 0 and c not in seen and len(classes) < k:
                seen.add(c)
                classes.append(c)

        members = tuple(P.a_teachers[ai])
        empties = [
            x for x in range(NUM_SLOTS)
            if soft.grid[c0][x] < 0 and P.class_avail[c0][x] and P.a_allowed[ai][x]
        ]
        rng.shuffle(empties)
        blockers: list[int] = []
        for x in empties:
            for t in members:
                if soft.tcnt[t][x] > 0:
                    blockers.append(self._owner_class(soft, t, x))
        if len(missing) > 1 and rng.random() < 0.4:
            others = [P.a_class[a] for a in missing if P.a_class[a] != c0]
            if others:
                add(others[rng.randrange(len(others))])
        for c in blockers:
            add(c)
        mset = set(members)
        same_teacher = [
            P.a_class[a] for a in range(P.num_assignments())
            if mset.intersection(P.a_teachers[a]) and P.a_class[a] != c0
        ]
        rng.shuffle(same_teacher)
        for c in same_teacher:
            if rng.random() < 0.5:
                add(c)
        C = P.num_classes()
        guard = 0
        while len(classes) < min(k, C) and guard < 10 * C:
            guard += 1
            add(rng.randrange(C))
        return classes

    def _cpsat_fill_sessions(self, soft: SoftSchedule, missing: list[int]) -> tuple[list[int], list[int]]:
        """Vung lap theo buoi: (buoi, lop tu do ca tuan). Buoi = buoi chua o
        TRONG cua lop co tiet thieu + mot buoi tiet thieu duoc phep hoc; lop
        thieu duoc mo CA TUAN (vd 7A2 trong tiet 1 sang T3 ma mon thieu chi hoc
        chieu: phai doi mot tiet khac vao sang T3 roi dat mon thieu vao chieu)."""

        P = self.P
        rng = self.rng
        ai = missing[rng.randrange(len(missing))]
        c0 = P.a_class[ai]
        empty_sessions = sorted({
            x // PERIODS for x in range(NUM_SLOTS)
            if soft.grid[c0][x] < 0 and P.class_avail[c0][x] and not soft.locked[c0][x]
        })
        allowed_sessions = sorted({x // PERIODS for x in range(NUM_SLOTS) if P.a_allowed[ai][x]})
        if not empty_sessions or not allowed_sessions:
            return [], []
        first = empty_sessions[rng.randrange(len(empty_sessions))]
        full = [c0]
        if len(missing) > 1 and rng.random() < 0.5:
            other = P.a_class[missing[rng.randrange(len(missing))]]
            if other != c0:
                full.append(other)
        if rng.random() < 0.5:
            return [first], full
        rest = [s for s in allowed_sessions if s != first]
        if not rest:
            return [first], full
        return sorted((first, rest[rng.randrange(len(rest))])), full

    def _warm_repair_phase2_budget(self, default: float) -> float:
        """01/10: nut Cherry co CP-SAT — pha 2 khi sua luoi warm chi can ~8 s:
        phan con lai _salvage_warm + lap tiet CP-SAT lam tot hon (do truong 61
        lop: pha 2 an 20 s roi het gio cho buoc giu luoi -> xay lai, 2029 tiet)."""

        if self.cherry_cpsat and self.quality_focus is None:
            return min(default, 8.0)
        return default

    def _maybe_fill_warm(self, soft: SoftSchedule, deadline: float, info: dict) -> None:
        """01/10: luoi warm (lich nguoi dung / vong 1 cua Cherry 2 vong) con THIEU
        tiet -> lap bang CP-SAT truoc khi toi uu chat luong (chi nut Cherry)."""

        if not (self.cherry_cpsat and self.quality_focus is None and self._cpsat_available()):
            return
        expected = sum(self.P.a_periods)
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        # 05/10: luoi DU tiet nhung con no luat (vong 2 Cherry di tu luoi xep moi
        # 869/869 con 9 buoi vi pham dia diem; pha 2 chi go con 6) cung lap lai:
        # pha lap tiet go no roi CP-SAT xep lai. Truoc day bo qua -> tra luoi vi
        # pham, khong toi uu chat luong, het luot som (43/105 s). CHI khi luoi la
        # luoi trung gian (prefer_valid): lich nguoi dung co no san thi giu du tiet.
        if placed >= expected and (soft.penalty() <= 0 or not self.prefer_valid):
            return
        if soft.overlap:
            self._shed_overlaps(soft)
        now = time.monotonic()
        fill_deadline = deadline - max(6.0, (deadline - now) * 0.35)
        if fill_deadline - now < 3.0:
            return
        info["cpsat_fill"] = self._cpsat_fill_phase(soft, fill_deadline)
        soft.enable_quality_tracking()

    def _salvage_warm(self, soft: SoftSchedule, deadline: float) -> SoftSchedule | None:
        """01/10: luoi warm sua khong sach -> lam sach rong cua no roi lap tiet:
        lop vi pham luat lop (sau khi da tha "thieu cap" cho mon con thieu tiet)
        va lop thua tiet bi go het o khong khoa; trung gio bi go phan thua; no
        luat GV do _cpsat_fill_phase go tiep. Tra None khi khong con gi de giu."""

        P = self.P
        count: dict[int, int] = {}
        for row in soft.grid:
            for ai in row:
                if ai >= 0:
                    count[ai] = count.get(ai, 0) + 1
        missing_cs = {
            (P.a_class[ai], P.a_subject[ai])
            for ai in range(P.num_assignments())
            if count.get(ai, 0) < P.a_periods[ai]
        }
        over = {P.a_class[ai] for ai, n in count.items() if n > P.a_periods[ai]}
        cleared = 0
        for c in range(P.num_classes()):
            if c in over or self._class_rule_break(soft, c, tolerate_min_for=missing_cs) is not None:
                for x in range(NUM_SLOTS):
                    if soft.grid[c][x] >= 0 and not soft.locked[c][x]:
                        soft.set_cell(c, x, -1)
                cleared += 1
        self._shed_overlaps(soft)
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        placed = sum(1 for row in soft.grid for v in row if v >= 0)
        if placed * 2 < sum(P.a_periods):
            return None
        fill_deadline = deadline - max(6.0, (deadline - time.monotonic()) * 0.35)
        stats = self._cpsat_fill_phase(soft, fill_deadline)
        stats["salvage_cleared_classes"] = cleared
        self._salvage_stats = stats
        if soft.overlap != 0 or soft.penalty() != 0:
            return None
        soft.enable_quality_tracking()
        return soft

    def _shed_rule_debt(self, soft: SoftSchedule) -> int:
        """01/10: luoi DO DANG con no luat GV (gioi han buoi/ngay, tran tiet...)
        lam moi mo hinh CP-SAT cham GV do VO NGHIEM (phan hang so da vi pham).
        Go tham lam tung tiet (khong khoa) cua GV dang no, moi lan chon tiet
        lam GIAM no nhieu nhat, toi khi het no hoac go khong giup (vd o bat buoc
        day). Tiet go ra thanh tiet thieu -> pha lap xep lai cho hop le.
        Tra so tiet da go."""

        P = self.P
        removed = 0
        for t in list(self._has_rule_teachers):
            guard = 0
            while soft.rule_pen[t] > 0 and guard < 64:
                guard += 1
                best = None
                for slot in range(NUM_SLOTS):
                    if soft.tcnt[t][slot] <= 0:
                        continue
                    for c in range(P.num_classes()):
                        ai = soft.grid[c][slot]
                        if ai < 0 or t not in P.a_teachers[ai] or soft.locked[c][slot]:
                            continue
                        members = P.a_teachers[ai]
                        pen0 = sum(soft.rule_pen[m] for m in members)
                        soft.set_cell(c, slot, -1)
                        for m in members:
                            soft.refresh_rule_pen(m)
                        gain = pen0 - sum(soft.rule_pen[m] for m in members)
                        soft.set_cell(c, slot, ai)
                        for m in members:
                            soft.refresh_rule_pen(m)
                        if gain > 0 and (best is None or gain > best[0]):
                            best = (gain, c, slot, members)
                if best is None:
                    # 05/10: go tung tiet khong giam no (vd VUOT so buoi toi da ma
                    # moi buoi >= 2 tiet: An Phu GDTC.Loc 7/6 buoi) -> go NGUYEN buoi
                    # it tiet nhat cua GV (moi o khong khoa), neu giam duoc no.
                    got = self._shed_teacher_session(soft, t)
                    if not got:
                        break
                    removed += got
                    continue
                _gain, c, slot, members = best
                soft.set_cell(c, slot, -1)
                for m in members:
                    soft.refresh_rule_pen(m)
                removed += 1
        return removed

    def _shed_teacher_session(self, soft: SoftSchedule, t: int) -> int:
        """Go moi tiet (khong khoa) cua GV t trong MOT buoi — buoi it tiet nhat
        lam giam no luat cua cac GV lien quan. Tra so tiet da go (0 = khong co)."""

        P = self.P
        best = None
        for s in range(NUM_SESSIONS):
            cells = []
            ok = True
            for p in range(PERIODS):
                x = s * PERIODS + p
                if soft.tcnt[t][x] <= 0:
                    continue
                found = False
                for c in range(P.num_classes()):
                    ai = soft.grid[c][x]
                    if ai >= 0 and t in P.a_teachers[ai]:
                        if soft.locked[c][x]:
                            ok = False
                        cells.append((c, x, ai))
                        found = True
                if not found:
                    ok = False  # o ban co dinh dung chung (khong go duoc)
            if not ok or not cells or (best is not None and len(cells) >= len(best[1])):
                continue
            members = sorted({m for _c, _x, ai in cells for m in P.a_teachers[ai]})
            pen0 = sum(soft.rule_pen[m] for m in members)
            for c, x, _ai in cells:
                soft.set_cell(c, x, -1)
            for m in members:
                soft.refresh_rule_pen(m)
            gain = pen0 - sum(soft.rule_pen[m] for m in members)
            for c, x, ai in cells:
                soft.set_cell(c, x, ai)
            for m in members:
                soft.refresh_rule_pen(m)
            if gain > 0:
                best = (gain, cells, members)
        if best is None:
            return 0
        _gain, cells, members = best
        for c, x, _ai in cells:
            soft.set_cell(c, x, -1)
        for m in members:
            soft.refresh_rule_pen(m)
        return len(cells)

    def _cpsat_repair_loc_debt(
        self, soft: SoftSchedule, deadline: float, stats: dict, *, target: int = 0, max_tries: int = 40
    ) -> None:
        """05/10: go no luat DIA DIEM ma KHONG bot tiet: moi lan giai lai 2-4 buoi
        (luon co mot buoi dang vi pham) tren MOI lop bang CP-SAT lane "fill" voi
        require_full (moi tiet dang xep phai xep lai, luat dia diem cung) — bai
        toan kha thi thuan: vung khong go duoc bi bac bo trong 0.03-4 s, vung go
        duoc giai trong 0.3-1.5 s (ban phat mem chay het 6-10 s moi lan). Nhan khi
        so tiet khong giam va no luat giam; dung khi no <= target. GV con no luat
        KHAC dia diem bi dong bang (phan hang so cua ho da vi pham).

        Do An Phu (lich 868/869 hop le, tiet cuoi la Mi thuat co Thi day 1 tiet o
        ca 28 lop / 2 co so): lan giai toan truong (vi pham dia diem phat mem) dat
        869 con 1 buoi vi pham; vet can moi vung 4 buoi chua buoi no: 28/165 go
        duoc, deu chua buoi cung co so "thieu so" con cho trong."""

        from . import cpsat_lns

        P = self.P
        T = P.num_teachers()
        threads = self._cpsat_threads_effective()
        tries = accepted = 0
        # 29/10 (chu du an: "khi xep moi no mat rat lau de dung"): do An Phu con 1 buoi no dia diem ->
        # 45 lan thu lien INFEASIBLE (~10 s), nhieu vung 4 buoi boc trung 3-4 lan tren CUNG luoi.
        # Nho vung da hong cho toi khi luoi doi; hong lien LOCFIX_FAIL_STREAK vung -> nhuong cho
        # buoc go tiet gay no + lap lai (vong do xep xong tiet con lai trong ~1.5 s).
        failed: set[tuple[frozenset[int], int]] = set()
        streak = 0
        redraws = 0
        while not self._stop_requested() and soft.overlap == 0 and soft.penalty() > target:
            self._report_construct(soft)
            now = time.monotonic()
            if deadline - now < 2.0 or tries >= max_tries or streak >= LOCFIX_FAIL_STREAK or redraws > 60:
                break
            debt_pairs = [
                (t, s) for t in range(T) if soft.tloc[t] is not None
                for s in soft.location_debt_sessions(t)
            ]
            t_unfreeze = -1
            if debt_pairs:
                tries += 1
                t0, s0 = debt_pairs[self.rng.randrange(len(debt_pairs))]
                sess = {s0}
                # do An Phu (vet can moi to hop chua buoi no): 1-2 buoi 0/11, 3 buoi
                # 2/55, 4 buoi 16/165 to hop go duoc -> uu tien vung 4 buoi
                r = self.rng.random()
                k = 4 if r < 0.55 else (3 if r < 0.85 else 2)
                # buoi khac cua CHINH GV dang no (doi tiet giua cac buoi cua GV do de
                # moi buoi con mot co so), them ngau nhien
                own = [
                    s for s in range(NUM_SESSIONS)
                    if s != s0 and any(soft.tcnt[t0][s * PERIODS + p] > 0 for p in range(PERIODS))
                ]
                def _locs_at(s: int) -> list[int]:
                    out: list[int] = []
                    for p in range(PERIODS):
                        x = s * PERIODS + p
                        if soft.tcnt[t0][x] > 0 and soft.tloc[t0][x]:
                            out.append(soft.tloc[t0][x][0])
                    return out

                here = _locs_at(s0)
                counts = collections.Counter(here)
                if len(counts) >= 2:
                    minority = min(counts, key=lambda L: (counts[L], self.rng.random()))
                    host = [
                        s for s in own
                        if _locs_at(s) and all(L == minority for L in _locs_at(s))
                    ]
                    spare = [s for s in host if len(_locs_at(s)) < PERIODS]
                    pick_from = spare or host
                    if pick_from and self.rng.random() < 0.8:
                        sess.add(pick_from[self.rng.randrange(len(pick_from))])
                guard = 0
                while len(sess) < k and guard < 20:
                    guard += 1
                    if own and self.rng.random() < 0.6:
                        sess.add(own[self.rng.randrange(len(own))])
                    else:
                        sess.add(self.rng.randrange(NUM_SESSIONS))
            else:
                rule_bad = [t for t in self._has_rule_teachers if soft.rule_pen[t] > 0]
                if not rule_bad:
                    break
                tries += 1
                t0 = rule_bad[self.rng.randrange(len(rule_bad))]
                t_unfreeze = t0
                rt0 = P.teacher_rules[t0]
                used_s = [
                    s for s in range(NUM_SESSIONS)
                    if any(soft.tcnt[t0][s * PERIODS + p] > 0 for p in range(PERIODS))
                ]
                empty_avail_s = [
                    s for s in range(NUM_SESSIONS)
                    if s not in used_s and any(P.teacher_avail[t0][s * PERIODS + p] for p in range(PERIODS))
                ]
                sess = set()
                if rt0 is not None and rt0.min_sessions > 0 and len(used_s) < rt0.min_sessions and empty_avail_s:
                    heavy_s = [
                        s for s in used_s
                        if sum(1 for p in range(PERIODS) if soft.tcnt[t0][s * PERIODS + p] > 0) >= 2
                    ] or used_s
                    sess.add(heavy_s[self.rng.randrange(len(heavy_s))])
                    sess.add(empty_avail_s[self.rng.randrange(len(empty_avail_s))])
                    while len(sess) < 4:
                        pool_s = (used_s + empty_avail_s) if self.rng.random() < 0.8 else list(range(NUM_SESSIONS))
                        sess.add(pool_s[self.rng.randrange(len(pool_s))])
                elif rt0 is not None and rt0.max_sessions > 0 and len(used_s) > rt0.max_sessions:
                    light_s = sorted(
                        used_s,
                        key=lambda s: (sum(1 for p in range(PERIODS) if soft.tcnt[t0][s * PERIODS + p] > 0), self.rng.random()),
                    )
                    for s in light_s[: min(4, len(light_s))]:
                        sess.add(s)
                    while len(sess) < 4:
                        sess.add(self.rng.randrange(NUM_SESSIONS))
                else:
                    for s in used_s[:2]:
                        sess.add(s)
                    while len(sess) < 4:
                        sess.add(self.rng.randrange(NUM_SESSIONS))
            key = (frozenset(sess), t_unfreeze)
            if key in failed:
                tries -= 1
                redraws += 1
                continue
            frozen = [
                t for t in self._has_rule_teachers
                if t != t_unfreeze and soft.rule_pen[t] > (soft.location_debt(t) if soft.tloc[t] is not None else 0)
            ]
            before = sum(1 for row in soft.grid for v in row if v >= 0)
            pen0 = soft.penalty()
            self._cpsat_pass_idx += 1
            try:
                new_cells, cinfo = cpsat_lns.build_and_solve(
                    P, soft, list(range(P.num_classes())), "fill",
                    time_limit=min(1.4, deadline - now - 0.25), workers=threads,
                    seed=self._cpsat_pass_idx, stop_check=self._stop_requested,
                    require_improve=False, sessions=sorted(sess), full_classes=[],
                    fill_quality=False, frozen_teachers=frozen, require_full=True,
                )
            except Exception:  # noqa: BLE001 - toan tu phu
                new_cells, cinfo = None, {}
            if new_cells is None:
                failed.add(key)
                streak += 1
                continue
            journal = cpsat_lns.apply_cells(soft, new_cells)
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)
            after = sum(1 for row in soft.grid for v in row if v >= 0)
            if soft.overlap == 0 and after >= before and soft.penalty() < pen0:
                accepted += 1
                failed.clear()
                streak = 0
                if os.environ.get("TKB_EVAC_DEBUG"):
                    sys.stderr.write(
                        f"[locfix] sessions={sorted(sess)} pen {pen0}->{soft.penalty()} placed {before}->{after} "
                        f"try={tries}\n"
                    )
                continue
            cpsat_lns.revert(soft, journal)
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)
            failed.add(key)
            streak += 1
        stats["loc_repair_streak_stop"] = int(stats.get("loc_repair_streak_stop", 0)) + int(streak >= LOCFIX_FAIL_STREAK)
        stats["loc_repair"] = [
            int(stats.get("loc_repair", [0, 0, 0])[0]) + tries,
            int(stats.get("loc_repair", [0, 0, 0])[1]) + accepted,
            int(soft.penalty()),
        ]

    def _cpsat_fill_phase(self, soft: SoftSchedule, deadline: float) -> dict:
        self._report_construct(soft, force=True)
        return self._cpsat_fill_phase_inner(soft, deadline)

    def _cpsat_fill_phase_inner(self, soft: SoftSchedule, deadline: float) -> dict:
        """01/10: lap tiet CHUA XEP bang CP-SAT LNS (cpsat_lns lane "fill") tren
        luoi khong trung gio. Moi vong giai lai 3-6 lop (o trong + tiet thieu),
        nhan khi so tiet da xep TANG ma no luat GV khong tang (hoac bang tiet ma
        no luat giam). Tra thong ke cho info["cpsat_fill"]."""

        from . import cpsat_lns

        P = self.P
        stats: dict = {"pass": 0, "accept": 0, "gained": 0, "unknown": 0, "infeasible": 0, "rejected": 0, "error": 0}
        started = time.monotonic()
        threads = self._cpsat_threads_effective()
        sub_limit = float(max(1, self._cpsat_env_int("TKB_CPSAT_FILL_LIMIT", 4)))
        k_max = max(2, self._cpsat_env_int("TKB_CPSAT_FILL_K", 6))
        A = P.num_assignments()
        if soft.penalty() > 0 and soft.overlap == 0:
            # 05/10: no DIA DIEM sua bang cach xep lai NGUYEN BUOI toan truong (giu
            # du tiet) TRUOC khi go tiet. Do An Phu (luoi 869/869, 9 buoi vi pham):
            # go tham lam lay ra 21 tiet roi lap lai chi duoc 867.
            self._cpsat_repair_loc_debt(soft, started + (deadline - started) * 0.65, stats, max_tries=60)
        if soft.penalty() > 0:
            stats["debt_shed"] = self._shed_rule_debt(soft)
            stats["pen_after_shed"] = int(soft.penalty())
        placed0 = sum(1 for row in soft.grid for v in row if v >= 0)
        stats["placed_start"] = placed0
        # 05/10 (chu du an: "tai sao chay bang Claude lai duoc con bam Cherry ko"):
        # truong co rang buoc CHEO nhieu lop (so buoi "dung bang", luat dia diem 2
        # co so) thi sua theo cum 3-6 lop bi ket (An Phu 28 lop: 845 -> 867 tiet,
        # con 2 vi pham). Truong vua phai -> MOT lan giai TOAN TRUONG (moi o la
        # bien, khong dong bang GV) truoc, giong cach giai ngoai app.
        whole_max = self._cpsat_env_int("TKB_CPSAT_WHOLE_MAX_CLASSES", 40)
        cnt0 = [0] * A
        for row in soft.grid:
            for v in row:
                if v >= 0:
                    cnt0[v] += 1
        need_fix = (sum(P.a_periods) - placed0 > 5) or soft.penalty() > 0
        left0 = deadline - time.monotonic()
        if whole_max > 0 and P.num_classes() <= whole_max and need_fix and left0 > 4.0:
            stats["whole_pass"] = 0
            # 05/10: truong co luat DIA DIEM -> vi pham dia diem la PHAT trong lan
            # giai toan truong (tiet chua xep tren het), roi go no bang vung nguyen
            # buoi. Rang buoc cung thi CP-SAT khong qua duoc luoi trung gian: An Phu
            # 868/869 hop le, 173 s van 868; mem: 869 con 1 buoi trong 10-20 s ->
            # vung 4 buoi go het. Mot lan giai mem co the khong cham du tiet (do:
            # 22 s con thieu 1) -> thu lai voi hat khac khi con thoi gian.
            loc_soft = bool(
                any(getattr(P, "teacher_loc_rules", None) or [])
                and os.environ.get("TKB_CPSAT_LOC", "1") != "0"
                and os.environ.get("TKB_CPSAT_LOC_SOFT", "1") != "0"
            )
            while not self._stop_requested():
                self._report_construct(soft)
                cnt_now = [0] * A
                for row in soft.grid:
                    for v in row:
                        if v >= 0:
                            cnt_now[v] += 1
                miss_classes = sorted({P.a_class[ai] for ai in range(A) if cnt_now[ai] < P.a_periods[ai]})
                left = deadline - time.monotonic()
                whole_limit = min(float(self._cpsat_env_int("TKB_CPSAT_WHOLE_LIMIT", 75)), left * 0.6)
                scope = list(range(P.num_classes()))
                keep_all = False
                if loc_soft:
                    whole_limit = min(whole_limit, max(9.0, min(20.0, left * 0.45)))
                    # Do An Phu (868/869): toan truong giu tiet (require_full=True)
                    # cham du tiet 4/4 lan trong 6-15 s, ban tu do 0/2.
                    keep_all = (stats["whole_pass"] % 2 == 0)
                else:
                    # truong khong co luat dia diem: vong cum lop lap tiet trong vai
                    # giay (GDTX: 3.8 s) — lan toan truong 20 s an mat thoi gian toi
                    # uu chat luong (248 so voi 236 buoi)
                    whole_limit = min(whole_limit, max(8.0, left * 0.25))
                stats["whole_pass"] += 1
                try:
                    new_cells, cinfo = cpsat_lns.build_and_solve(
                        P, soft, scope, "fill",
                        time_limit=whole_limit, workers=threads,
                        seed=self._cpsat_pass_idx + 7 + 13 * stats["whole_pass"],
                        stop_check=self._stop_requested, require_improve=False,
                        fill_quality=False, frozen_teachers=[], loc_soft=loc_soft,
                        require_full=keep_all, stall_s=WHOLE_FILL_STALL_S if loc_soft else 0.0,
                    )
                except Exception as exc:  # noqa: BLE001 - toan tu phu
                    new_cells, cinfo = None, {"status": "ERROR", "error": repr(exc)}
                stats["whole_status"] = str((cinfo or {}).get("status") or "")
                if os.environ.get("TKB_EVAC_DEBUG"):
                    sys.stderr.write(
                        f"[whole] status={stats['whole_status']} limit={whole_limit:.1f}s build={(cinfo or {}).get('build_s')} "
                        f"solve={(cinfo or {}).get('solve_s')} unplaced={(cinfo or {}).get('unplaced')} "
                        f"short={(cinfo or {}).get('block_short')} mss={(cinfo or {}).get('min_sessions_short')} "
                        f"dropped={(cinfo or {}).get('dropped_classes')} lv={(cinfo or {}).get('loc_viol')} "
                        f"err={(cinfo or {}).get('error')}\n"
                    )
                ok = False
                if new_cells is not None:
                    before = placed0
                    pen0 = soft.penalty()
                    grid_before = [row[:] for row in soft.grid]
                    cpsat_lns.apply_cells(soft, new_cells)
                    for t in self._has_rule_teachers:
                        soft.refresh_rule_pen(t)
                    after = sum(1 for row in soft.grid for v in row if v >= 0)
                    pen1 = soft.penalty()
                    ok = soft.overlap == 0 and (
                        (after > before and pen1 <= pen0) or (after == before and pen1 < pen0)
                        or (after >= before and pen1 == 0 and pen0 > 0)
                    )
                    if (
                        not ok and loc_soft and soft.overlap == 0 and after > before and pen1 > pen0
                        and time.monotonic() < deadline - 0.5
                    ):
                        # xep THEM duoc tiet nhung con no dia diem -> go bang vung
                        # nguyen buoi toan truong (giu du tiet), chi nhan khi het no
                        # moi. Lap theo cum sau do khong xep duoc tiet nay (An Phu:
                        # 69 lan deu bo 1 tiet) -> phan lon thoi gian con lai.
                        left_r = deadline - time.monotonic()
                        # 06/10: go theo vung 2-4 buoi thuong chi nhan 1/60-100 lan khi
                        # con nhieu buoi no -> gioi han ~30% thoi gian con lai; phan con
                        # lai danh cho go tiet gay no + giai lai toan truong (ben duoi).
                        rep_end = time.monotonic() + min(left_r - 1.0, max(8.0, left_r * 0.3))
                        self._cpsat_repair_loc_debt(soft, rep_end, stats, target=pen0, max_tries=200)
                        after = sum(1 for row in soft.grid for v in row if v >= 0)
                        pen1 = soft.penalty()
                        ok = soft.overlap == 0 and after > before and pen1 <= pen0
                        stats["whole_loc_repair"] = [int(ok), int(pen1)]
                        if not ok and soft.overlap == 0 and pen1 > pen0:
                            # 06/10: go KHONG HET no dia diem -> chi go dung cac tiet
                            # gay no (tiet le co so trong buoi vi pham), GIU phan con
                            # lai. Truoc day vut ca lan giai: do truong 2 co so 28 lop
                            # (so buoi "dung bang") 758 -> 864 con 8 buoi vi pham bi
                            # tra ve 758, het gio lap cum chi lai duoc 864 - thieu 7.
                            shed = self._shed_rule_debt(soft)
                            after = sum(1 for row in soft.grid for v in row if v >= 0)
                            pen1 = soft.penalty()
                            ok = soft.overlap == 0 and after > before and pen1 <= pen0
                            stats["whole_loc_shed"] = [int(shed), int(after), int(pen1)]
                    if ok:
                        stats["whole_accept"] = 1
                        stats["gained"] += after - before
                        placed0 = after
                    else:
                        self._restore_grid(soft, grid_before)
                        stats["whole_reject"] = [before, after, int(pen0), int(pen1)]
                    if os.environ.get("TKB_EVAC_DEBUG"):
                        sys.stderr.write(f"[whole] before={before} after={after} pen {pen0}->{pen1} ok={ok}\n")
                # khong phai truong luat dia diem: mot lan nhu cu. Truong dia diem:
                # lap lai (hat khac / tu luoi vua nhan) toi khi du tiet + sach no —
                # do An Phu xep tu dau: lan 1 nhan 851 -> 863 (con thieu), cum lop
                # sau do chi them 3 tiet.
                done = ok and placed0 >= sum(P.a_periods) and soft.penalty() == 0
                # 06/10: nguong 25 -> 15 s: sau khi go tiet gay no, them mot lan giai
                # toan truong (giu moi tiet) lap du tiet hon hang chuc vong cum lop.
                if done or not loc_soft or stats["whole_pass"] >= 8 or deadline - time.monotonic() < 8.0:
                    break
        consec_reject = 0
        loc_soft_flag = bool(
            any(getattr(P, "teacher_loc_rules", None) or [])
            and os.environ.get("TKB_CPSAT_LOC", "1") != "0"
            and os.environ.get("TKB_CPSAT_LOC_SOFT", "1") != "0"
        )
        while not self._stop_requested():
            self._report_construct(soft)
            now = time.monotonic()
            limit = min(sub_limit, deadline - now - 0.3)
            if limit < 0.8:
                break
            cnt = [0] * A
            for row in soft.grid:
                for v in row:
                    if v >= 0:
                        cnt[v] += 1
            missing = [ai for ai in range(A) if cnt[ai] < P.a_periods[ai]]
            if not missing:
                break
            if (
                (consec_reject >= 3 or deadline - now <= 6.5)
                and whole_max > 0
                and P.num_classes() <= whole_max
                and loc_soft_flag
                and stats.get("whole_pass", 0) == 0
                and deadline - now > 3.2
            ):
                stats["whole_pass"] = 1
                left_w = deadline - now
                whole_limit = min(7.0, max(2.2, left_w * 0.45))
                try:
                    new_cells, cinfo = cpsat_lns.build_and_solve(
                        P, soft, list(range(P.num_classes())), "fill",
                        time_limit=whole_limit, workers=threads,
                        seed=self._cpsat_pass_idx + 20,
                        stop_check=self._stop_requested, require_improve=False,
                        fill_quality=False, frozen_teachers=[], loc_soft=True,
                        require_full=True, stall_s=WHOLE_FILL_STALL_S,
                    )
                except Exception as exc:
                    new_cells, cinfo = None, {"status": "ERROR", "error": repr(exc)}
                stats["whole_status"] = str((cinfo or {}).get("status") or "")
                if new_cells is not None:
                    before_w = sum(cnt)
                    pen0_w = soft.penalty()
                    grid_before_w = [row[:] for row in soft.grid]
                    cpsat_lns.apply_cells(soft, new_cells)
                    for t in self._has_rule_teachers:
                        soft.refresh_rule_pen(t)
                    after_w = sum(1 for row in soft.grid for v in row if v >= 0)
                    pen1_w = soft.penalty()
                    ok_w = soft.overlap == 0 and after_w > before_w and pen1_w <= pen0_w
                    if not ok_w and soft.overlap == 0 and after_w > before_w and pen1_w > pen0_w and time.monotonic() < deadline - 0.5:
                        rep_end = min(deadline - 0.3, time.monotonic() + max(3.5, (deadline - time.monotonic()) * 0.65))
                        self._cpsat_repair_loc_debt(soft, rep_end, stats, target=pen0_w, max_tries=60)
                        after_w = sum(1 for row in soft.grid for v in row if v >= 0)
                        pen1_w = soft.penalty()
                        ok_w = soft.overlap == 0 and after_w > before_w and pen1_w <= pen0_w
                        stats["whole_loc_repair"] = [int(ok_w), int(pen1_w)]
                    if ok_w:
                        stats["whole_accept"] = 1
                        stats["gained"] += after_w - before_w
                        consec_reject = 0
                        continue
                    self._restore_grid(soft, grid_before_w)
                    stats["whole_reject"] = [before_w, after_w, int(pen0_w), int(pen1_w)]
                break
            sessions: list[int] | None = None
            full: list[int] | None = None
            if stats["pass"] % 2 == 1:
                # xen ke vung "NGUYEN BUOI toan truong": tiet thieu cuoi cung
                # thuong ket o mot buoi vua khit GV (Hung Long: sang thu 3 140 o /
                # 140 cho GV) — chi xep lai CA buoi do tren moi lop moi go duoc.
                sessions, full = self._cpsat_fill_sessions(soft, missing)
            if sessions:
                classes = list(range(P.num_classes()))
                limit = min(max(limit, 2.0 * sub_limit), deadline - now - 0.3)
                stats["session_pass"] = stats.get("session_pass", 0) + 1
            else:
                sessions = None
                full = None
                k = self.rng.randint(3, max(3, k_max))
                classes = self._cpsat_fill_cluster(soft, missing, k)
            stats["pass"] += 1
            self._cpsat_pass_idx += 1
            # GV con no luat (khong go duoc) -> dong bang: phan hang so cua ho da
            # vi pham nen moi mo hinh cham toi ho deu vo nghiem.
            debt_t = [t for t in self._has_rule_teachers if soft.rule_pen[t] > 0]
            try:
                new_cells, cinfo = cpsat_lns.build_and_solve(
                    P, soft, classes, "fill",
                    time_limit=limit, workers=threads, seed=self._cpsat_pass_idx,
                    stop_check=self._stop_requested, require_improve=False,
                    sessions=sessions, full_classes=full, fill_quality=False,
                    frozen_teachers=debt_t,
                )
            except Exception as exc:  # noqa: BLE001 - toan tu phu
                stats["error"] += 1
                if os.environ.get("TKB_EVAC_DEBUG"):
                    sys.stderr.write(f"[fill] error {exc!r}\n")
                continue
            if new_cells is None:
                status = str((cinfo or {}).get("status") or "")
                stats["infeasible" if status == "INFEASIBLE" else "unknown"] += 1
                consec_reject += 1
                if os.environ.get("TKB_EVAC_DEBUG"):
                    sys.stderr.write(f"[fill] {status} classes={classes} err={(cinfo or {}).get('error')}\n")
                continue
            before = sum(cnt)
            pen0 = soft.penalty()
            journal = cpsat_lns.apply_cells(soft, new_cells)
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)
            after = sum(1 for row in soft.grid for v in row if v >= 0)
            pen1 = soft.penalty()
            ok = soft.overlap == 0 and (
                (after > before and pen1 <= pen0) or (after == before and pen1 < pen0)
            )
            if not ok:
                if os.environ.get("TKB_EVAC_DEBUG"):
                    sys.stderr.write(
                        f"[fill] reject before={before} after={after} pen {pen0}->{pen1} overlap={soft.overlap} "
                        f"status={(cinfo or {}).get('status')} missing={(cinfo or {}).get('missing_before')} "
                        f"unplaced={(cinfo or {}).get('unplaced')} classes={classes}\n"
                    )
                cpsat_lns.revert(soft, journal)
                for t in self._has_rule_teachers:
                    soft.refresh_rule_pen(t)
                stats["rejected"] += 1
                consec_reject += 1
                continue
            stats["accept"] += 1
            stats["gained"] += after - before
            consec_reject = 0
            if os.environ.get("TKB_EVAC_DEBUG"):
                sys.stderr.write(
                    f"[fill] +{after - before} -> {after} pen={pen1} classes={classes} "
                    f"t={time.monotonic() - started:.1f}s status={(cinfo or {}).get('status')}\n"
                )
        if soft.overlap == 0 and soft.penalty() > 0:
            # 05/10: con no luat GV (vd so buoi "dung bang" thieu khi GV vua du
            # tiet) -> go tiet gay no de tra luoi HOP LE thieu vai tiet. Truoc day
            # tra luoi con no: _salvage_warm vut no (An Phu: lap duoc 867/869 con
            # no 4 -> xay lai tu dau chi 850) va pha chat luong CP-SAT bo qua.
            stats["end_shed"] = self._shed_rule_debt(soft)
            stats["pen_end"] = int(soft.penalty())
        stats["placed_end"] = sum(1 for row in soft.grid for v in row if v >= 0)
        stats["seconds"] = round(time.monotonic() - started, 1)
        return stats

    @staticmethod
    def _cpsat_env_int(name: str, default: int) -> int:
        try:
            return int(str(os.environ.get(name, "") or "").strip() or default)
        except ValueError:
            return default

    def _cpsat_session_turn(self) -> bool:
        """11/09: xen ke vung "NGUYEN BUOI toan truong" (moi lop, chi o thuoc 2
        buoi duoc mo, moi thu khac hang so) vao cac pass CP-SAT theo cum lop.
        Do tren THCS Tan Phu Trung (74 lop): vung cum 5-12 lop ket o 622 buoi /
        116 trong, vung theo buoi keo trong 1 xuong 80 voi cung bo luat — vi
        tiet trong cua GV la chuyen sap xep TRONG buoi, rai o nhieu lop.
        env TKB_CPSAT_SESSION_EVERY=0 tat; mac dinh cu 2 pass thi 1 pass theo buoi (do 11/09: pass theo buoi duoc nhan nhieu hon pass cum)."""

        every = self._cpsat_env_int("TKB_CPSAT_SESSION_EVERY", 2)
        if every <= 0:
            return False
        return (self._cpsat_pass_idx % every) == every - 1

    def _cpsat_session_limit(self) -> float:
        """Thoi gian toi da mot pass theo buoi (giay); mo hinh 74 lop x 2 buoi
        thuong dat OPTIMAL trong 10-30 s."""

        return float(max(5, self._cpsat_env_int("TKB_CPSAT_SESSION_LIMIT", 25)))

    def _cpsat_pick_sessions(self, soft: SoftSchedule, lane: str) -> list[int]:
        """Hai buoi cho mot pass theo buoi: buoi thu nhat xoay trong 4 buoi
        nhieu "no" nhat (gap1: buoi ho 1 tiet; sessions: buoi mong), buoi thu
        hai ngau nhien trong cac buoi con lai co lop mo — de cac tiet doi duoc
        buoi cho nhau (giam buoi day) chu khong chi xep lai trong mot buoi."""

        P = self.P
        T = P.num_teachers()
        if lane == "gap1":
            debts = self._gap1_sessions_of(soft, set(range(T)))
        else:
            debts = self._thin_sessions_of(soft, range(T))
        cnt: collections.Counter = collections.Counter(s for _t, s in debts)
        open_sessions = [
            s for s in range(NUM_SESSIONS)
            if any(P.class_avail[c][s * PERIODS + p] for c in range(P.num_classes()) for p in range(PERIODS))
        ]
        if len(open_sessions) < 2:
            return []
        order = sorted(open_sessions, key=lambda s: (-cnt.get(s, 0), s))
        k = self._cpsat_session_idx
        self._cpsat_session_idx += 1
        first = order[k % min(len(order), 4)]
        rest = [s for s in open_sessions if s != first]
        second = rest[self.rng.randrange(len(rest))]
        return sorted((first, second))

    def _cpsat_cluster_pass(
        self,
        soft: SoftSchedule,
        weights,
        floor_teachers: set[int],
        deadline: float,
        iteration: int,
        *,
        pass_limit: float = 8.0,
    ) -> bool:
        """Mot pass CP-SAT LNS: giai lai toan bo o KHONG khoa cua mot cum lop
        (moi thu khac la hang so) voi rang buoc cung "khong xau hon" tren cac
        GV lien quan va "chi so phu trach <= hien tai - 1"; nhan qua DUNG cac
        cong cua engine (penalty()==0, khoa, _quality_score < diem hien tai,
        _load_state/full_recheck). Tra True khi luoi da doi va tot hon."""

        lane = self.quality_focus
        if lane not in ("gap1", "sessions") or not self._cpsat_available():
            return False
        stats = self._cpsat_stats
        # 26/08: tu tat CP-SAT cho phan con lai cua luot khi no khong hop
        # (>= 4 pass ma <= 1 lan nhan) -> dot quet ep/don buoi + khoi toan tu
        # nang chay nhu cu (truong nhieu GV bi dong bang boi luat dia diem).
        # 11/09: truoc day ">= 4 pass ma <= 1 lan nhan" — voi truong kho (74 lop,
        # cum 12 lop 2 000 bien) 3-8 s dau toan UNKNOWN nen CP-SAT bi tat ngay
        # truoc khi pass theo buoi kip chay. Gio: >= 8 pass ma 0 lan nhan.
        if stats["pass"] >= 8 and stats["accept"] == 0:
            self._cpsat_checked = False
            stats["auto_disabled"] += 1
            return False
        now = time.monotonic()
        limit = min(float(pass_limit), deadline - now - 1.0)
        if limit < 1.0:
            return False
        from . import cpsat_lns
        threads = self._cpsat_threads_effective()
        max_classes = 12 if threads >= 4 else 8
        sessions: list[int] | None = None
        classes: list[int] = []
        if self._cpsat_session_turn():
            sessions = self._cpsat_pick_sessions(soft, lane) or None
            if sessions:
                classes = list(range(self.P.num_classes()))
                limit = min(max(limit, self._cpsat_session_limit()), deadline - now - 1.0)
        if not classes:
            sessions = None
            classes = self._cpsat_pick_cluster(soft, lane, max_classes)
        if not classes:
            stats["no_debts"] += 1
            return False
        key = frozenset(classes) if sessions is None else frozenset(("S", s) for s in sessions)
        memo = self._cpsat_memo.get(key)
        if memo is not None:
            status, tries = memo
            if status == "INFEASIBLE" or tries >= 2:
                stats["memo_skip"] += 1
                self._cpsat_pass_idx += 1
                return False
            limit = min(limit * 1.5, deadline - now - 1.0)
        self._cpsat_pass_idx += 1
        stats["pass"] += 1
        if sessions is not None:
            stats["session_pass"] += 1
        target_score = self._quality_score(soft, weights)
        sessions0 = soft.quality()[2]
        gap1_0 = soft.quality()[3]
        try:
            # 11/09: KHONG ep "chi so phu trach <= hien tai - 1" trong mo hinh
            # (ca cum lan theo buoi): rang buoc do lam goi y xuat phat vo nghiem
            # -> CP-SAT mat moc, 3-8 s toan UNKNOWN (do tren 74 lop). Bo no thi
            # goi y kha thi ngay, solver chi con viec cai thien; cong ben duoi
            # (q[3]/q[2] giam that) van quyet dinh nhan hay khong.
            new_cells, info = cpsat_lns.build_and_solve(
                self.P, soft, classes, lane,
                time_limit=limit, workers=threads, seed=self._cpsat_pass_idx,
                stop_check=self._stop_requested,
                require_improve=False, sessions=sessions,
            )
        except Exception as exc:  # noqa: BLE001 - toan tu phu, khong duoc lam hong luot
            stats["error"] += 1
            self._cpsat_memo[key] = ("ERROR", 9)
            if os.environ.get("TKB_EVAC_DEBUG"):
                sys.stderr.write(f"[cpsat] error {exc!r}\n")
            return False
        status = str((info or {}).get("status") or "")
        if new_cells is None:
            stats["infeasible" if status == "INFEASIBLE" else "unknown"] += 1
            prev = self._cpsat_memo.get(key)
            self._cpsat_memo[key] = (status or "UNKNOWN", (prev[1] + 1) if prev else 1)
            if os.environ.get("TKB_EVAC_DEBUG"):
                sys.stderr.write(f"[cpsat] {status} sessions={sessions} classes={sorted(classes)} info={ {k: v for k, v in (info or {}).items() if k != 'timeline'} }\n")
            return False
        journal = cpsat_lns.apply_cells(soft, new_cells)
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        q = soft.quality()
        ok = (
            soft.penalty() == 0
            and not self._lock_violated(soft)
            and self._quality_score(soft, weights) < target_score
            and (q[3] < gap1_0 if lane == "gap1" else q[2] < sessions0)
            and (lane != "gap1" or q[2] <= sessions0)
        )
        if ok:
            st = self._load_state(soft)
            if st is None:
                ok = False
                stats["rejected_by_state"] += 1
        if not ok:
            cpsat_lns.revert(soft, journal)
            for t in self._has_rule_teachers:
                soft.refresh_rule_pen(t)
            stats["rejected"] += 1
            if sessions is None:
                self._cpsat_memo[key] = ("REJECTED", 9)
            if os.environ.get("TKB_EVAC_DEBUG"):
                sys.stderr.write(
                    f"[cpsat] reject sessions={sessions} n={len(classes)} q={q[:4]} target=({gap1_0},{sessions0}) "
                    f"new_touched={(info or {}).get('new_touched')} cur_touched={(info or {}).get('cur_touched')} "
                    f"status={status} solve={(info or {}).get('solve_s')}s changed={len(journal)}\n"
                )
            return False
        stats["accept"] += 1
        stats["cells_changed"] += len(journal)
        if sessions is not None:
            stats["session_accept"] += 1
        if os.environ.get("TKB_EVAC_DEBUG"):
            sys.stderr.write(
                f"[cpsat] accept sessions={sessions} classes={sorted(classes)} q={q[:4]} changed={len(journal)} "
                f"solve={(info or {}).get('solve_s')}s status={status} threads={threads}\n"
            )
        return True

    def _force_pair_endgame(
        self, soft: SoftSchedule, weights, floor_teachers: set[int], deadline: float, stage: int, iteration: int
    ) -> bool:
        P = self.P
        debts = self._debt_sessions_of(soft, set(range(P.num_teachers())), floor_teachers)
        if stage == 1:
            debts = [(t, s) for t, s in debts if soft.ts_cnt[t][s] == 1]
        elif stage == 2:
            debts = [(t, s) for t, s in debts if soft.ts_cnt[t][s] != 1]
        elif self.quality_focus == "gap1":
            # 23/08 (trua): nut "1 tiet trong" ep lap cac lo 1 o.
            debts = self._gap1_sessions_of(soft, set(range(P.num_teachers())))
        sessions_sweep = self.quality_focus == "sessions" and stage >= 3
        if sessions_sweep:
            # 25/08 (nut "Buoi day"): quet cac buoi mong 1..3 tiet, it tiet
            # truoc; buoi 1 tiet dung ep ghep (nuoc A/B/C), buoi 2-3 tiet dung
            # don buoi (_force_evacuate_session).
            debts = self._thin_sessions_of(soft, range(P.num_teachers()))
        memo = self._force_fail_at
        gap1_sweep = self.quality_focus == "gap1" and stage >= 3
        sweep = gap1_sweep or sessions_sweep
        debts = [(t, s) for t, s in debts if iteration - memo.get((t, s), -(10**9)) >= (150 if sweep else 400)]
        # 26/08: dot quet dung som khi khong con buoi nao de thu (truoc day
        # vong quet 6 s goi ham nay ~79k lan voi debts=0, phat 79k khung).
        self._fpe_last_debts = len(debts)
        if not sessions_sweep:
            self.rng.shuffle(debts)
        improved = False
        # 23/08 (trua): nut gap1 quet HET cac buoi ho 1 tiet trong han gio cua
        # dot (moi buoi <= 1.5s) thay vi chi 8 buoi.
        limit = len(debts) if sweep else 8
        per_session = 2.5 if sessions_sweep else (1.5 if sweep else 2.5)
        for t, s in debts[:limit]:
            now = time.monotonic()
            if now > deadline or self._stop_requested():
                break
            if sweep:
                self._sweep_tried = int(getattr(self, "_sweep_tried", 0)) + 1
            if sessions_sweep and soft.ts_cnt[t][s] >= 2:
                ok = self._force_evacuate_session(
                    soft, t, s, weights, min(deadline, now + per_session),
                    max_tries=8, floor_teachers=floor_teachers,
                )
            else:
                ok = self._force_pair_session(
                    soft, t, s, weights, min(deadline, now + per_session), floor_teachers=floor_teachers
                )
            if ok:
                improved = True
                if gap1_sweep:
                    self.__dict__.setdefault("_fp_stats", collections.Counter())["success"] += 1
            else:
                memo[(t, s)] = iteration
        if sweep and os.environ.get("TKB_EVAC_DEBUG"):
            stats = self.__dict__.get("_evac_stats") or {}
            fp = self.__dict__.get("_fp_stats") or {}
            sys.stderr.write(
                f"[{'evac' if sessions_sweep else 'gap1'}] debts={len(debts)} tried={min(len(debts), limit)} "
                f"q={soft.quality()[:4]} fp={dict(fp)} evac={dict(stats)}\n"
            )
            sys.stderr.flush()
        return improved

    def _repair_penalty_local(self, soft: SoftSchedule, deadline: float, weights) -> bool:
        """Go trung gio / luat GV (sau mot nuoc ep) bang bo cong cu pha 2, uu
        tien nuoc giu chat luong GV; True khi penalty ve 0."""

        self._tabu = {}
        iteration = 0
        stall = 0
        while soft.penalty() > 0 and time.monotonic() < deadline:
            iteration += 1
            self._iteration = iteration
            target = self._pick_conflict(soft)
            if target is None:
                break
            c, slot = target
            pen0 = soft.penalty()
            self._repair_cell_quality(soft, c, slot, weights)
            if soft.penalty() < pen0:
                stall = 0
            else:
                stall += 1
            if stall and stall % 30 == 0:
                for t_conf, slot_conf in list(soft.conflicts):
                    if time.monotonic() > deadline:
                        break
                    if (t_conf, slot_conf) in soft.conflicts:
                        self._dig_conflict(soft, t_conf, slot_conf, max_depth=8, node_budget=4000)
                for t_conf, slot_conf in list(soft.conflicts):
                    if time.monotonic() > deadline:
                        break
                    if (t_conf, slot_conf) in soft.conflicts:
                        self._augment_conflict(soft, t_conf, slot_conf)
                self._kempe_endgame(soft, deadline)
            if stall > 240:
                break
        return soft.penalty() == 0

    def _repair_cell_quality(self, soft: SoftSchedule, c: int, slot: int, weights) -> bool:
        """Nhu _repair_cell nhung trong cac nuoc cung muc giam trung gio, chon
        nuoc co diem chat luong GV thap nhat."""

        rng = self.rng
        run = self._run_window(soft, c, slot)
        if not run or any(soft.locked[c][x] for x in run):
            return False
        ai = soft.grid[c][run[0]]
        iteration = self._iteration
        tabu = self._tabu
        best = None
        for delta, changes, window_start in self._candidate_swaps(soft, c, run):
            if tabu.get((c, ai, window_start), 0) > iteration and delta >= 0:
                continue
            if best is not None and delta > best[0]:
                break
            inverse = self._apply_changes(soft, c, changes)
            sc = self._quality_score(soft, weights)
            self._apply_changes(soft, c, inverse)
            if best is None or sc < best[1]:
                best = (delta, sc, changes)
        if best is None:
            return False
        tabu[(c, ai, run[0])] = iteration + 8 + rng.randrange(12)
        self._apply_changes(soft, c, best[2])
        return True

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
            inverse = self._apply_changes(soft, c, changes)
            if self._lock_violated(soft):
                # 22/08: lac ngau nhien cung khong duoc pha chi so da khoa.
                self._apply_changes(soft, c, inverse)
                continue
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
                            or soft.busy(ai, slot) > 0
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
                        or soft.busy(ai, slot) > 0
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
                if soft.grid[c][slot] >= 0 and t in P.a_teachers[soft.grid[c][slot]]
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
                tt
                for t, slot in list(soft.conflicts)
                for c in cluster
                if soft.grid[c][slot] >= 0
                for tt in P.a_teachers[soft.grid[c][slot]]
            }
            extra = [
                c2
                for c2 in range(P.num_classes())
                if c2 not in cluster
                and any(
                    soft.grid[c2][slot] >= 0
                    and any(tt in teachers for tt in P.a_teachers[soft.grid[c2][slot]])
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
            and t in P.a_teachers[soft.grid[c][slot]]
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
                if soft.busy(moving_ai, x) > 0:
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
                if soft.busy(moving_ai, x) > 0:
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
            and t in P.a_teachers[soft.grid[c][slot]]
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
                    for t2 in self.P.a_teachers[a2]:
                        if soft.tcnt[t2][slot2] <= 1:
                            continue
                        for c2 in range(self.P.num_classes()):
                            a3 = soft.grid[c2][slot2]
                            if (
                                a3 >= 0
                                and t2 in self.P.a_teachers[a3]
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
        m1 = P.a_teachers[ai]
        m2 = P.a_teachers[other_ai] if other_ai >= 0 else ()
        delta = 0
        for slot in run:
            for t1 in m1:
                if soft.tcnt[t1][slot] > 1:
                    delta -= 1
            for t2 in m2:
                extra = soft.tcnt[t2][slot]
                if t2 in m1:
                    extra -= 1
                if extra >= 1:
                    delta += 1
        for slot in window:
            for t2 in m2:
                if soft.tcnt[t2][slot] > 1:
                    delta -= 1
            for t1 in m1:
                extra = soft.tcnt[t1][slot]
                if t1 in m2:
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

    def _grid_hard_ok(self, grid: list[list[int]]) -> bool:
        """Luoi qua DUNG kiem tra cung cua _load_state (trung gio, luat lop/mon/GV,
        gioi han thoi gian) — khong can SoftSchedule."""

        P = self.P
        state = State(P, defer_min=False)
        for c in range(P.num_classes()):
            row = grid[c]
            for slot in range(NUM_SLOTS):
                ai = row[slot]
                if ai >= 0 and state.apply([(c, slot, ai)], check=False) is None:
                    return False
        for c, slot, ai in P.fixed_cells:
            if state.grid[c][slot] != ai:
                return False
        return bool(state.full_recheck())

    def _offer_focus_candidate(self, grid, quality, *, force: bool = False) -> None:
        """13/09: ghi nhan luoi (thuong la luoi tot nhat cua bac 3) lam ung vien
        ket qua cua nut mot muc tieu neu dat hop dong so voi moc xuat phat va qua
        kiem tra cung. Kiem tra gioi han ~1 lan/giay (tru force)."""

        focus = self.quality_focus
        start = self._focus_start
        if focus is None or start is None or grid is None or quality is None:
            return
        try:
            placed = sum(1 for row in grid for v in row if v >= 0)
            if not focus_candidate_acceptable(focus, start[0], start[1], quality, placed):
                return
            key = _focus_candidate_key(focus, quality)
            current = self._focus_candidate
            if current is not None and key >= current["key"]:
                return
            now = time.monotonic()
            if not force and now - self._focus_candidate_checked_at < 1.0:
                return
            self._focus_candidate_checked_at = now
            if not self._grid_hard_ok(grid):
                return
            self._focus_candidate = {
                "grid": [list(row) for row in grid],
                "quality": [int(x) for x in quality[:5]],
                "placed": int(placed),
                "key": key,
            }
            if isinstance(self._focus_info, dict):
                self._focus_info["focus_candidate"] = {
                    k: self._focus_candidate[k] for k in ("grid", "quality", "placed")
                }
        except Exception:  # noqa: BLE001 - ung vien la luoi an toan phu, khong duoc lam hong luot
            return

    def _focus_fallback_state(self, soft: SoftSchedule, info: dict) -> State | None:
        """Luoi toi uu cuoi khong nap duoc (kiem tra cung / sua cuc bo hong): tra
        luoi ung vien hop le tot nhat thay vi vut ca luot ve luoi goc."""

        cand = self._focus_candidate
        if self.quality_focus is None or cand is None:
            return None
        reason = getattr(self, "_last_load_fail", "") or info.get("warm_repair_failed") or info.get("warm_reject_reason") or "final_state_rejected"
        self._restore_grid(soft, cand["grid"])
        for t in self._has_rule_teachers:
            soft.refresh_rule_pen(t)
        state = self._load_state(soft)
        if state is None:
            return None
        info["focus_fallback"] = {"reason": str(reason), "quality": list(cand["quality"][:4])}
        info.pop("warm_start_rejected", None)
        return state

    def _lenient_state(self, grid: list[list[int]]) -> State:
        """25/08: dung State tu mot luoi CO THE con loi (lich nguoi dung dang co)
        de tra ve NGUYEN VEN — chi bo tiet trung gio GV (khong the chua trong
        State), moi luat khac khong kiem. Dung cho duong "khong toi uu duoc,
        giu nguyen lich"."""

        P = self.P
        state = State(P, defer_min=True)
        for c in range(P.num_classes()):
            for slot in range(NUM_SLOTS):
                ai = grid[c][slot]
                if ai >= 0:
                    state.apply([(c, slot, ai)], check=False)
        for t in range(P.num_teachers()):
            for slot in range(NUM_SLOTS):
                owners = [
                    c
                    for c in range(P.num_classes())
                    if state.grid[c][slot] >= 0 and t in P.a_teachers[state.grid[c][slot]]
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
                        and t in P.a_teachers[state.grid[c][slot]]
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
                        self._last_load_fail = state.check_fail_reason or "teacher_conflict"
        for c, slot, ai in P.fixed_cells:
            state.lock_cell(c, slot)
        if not ok:
            return None
        if not state.full_recheck():
            # ghi ly do de payload/marker bao duoc vi sao lich warm bi tu choi
            self._last_load_fail = state.check_fail_reason or "hard_check"
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
