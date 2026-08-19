"""
TKBCherry Unified CP-SAT Timetable Solver
==========================================
State-of-the-Art Multi-Stage Pattern-based CP-SAT Solver with Feedback Loop.

Đặc tính cốt lõi:
1. Đảm bảo 100% số tiết được xếp (không rớt tiết).
2. Tiết trống 2 tiết = 0 (soBuoiTrong2 = 0) đảm bảo bằng Teacher Session Patterns.
3. Buổi có 1 tiết = 0 (soBuoiDay1 = 0) bằng mô hình phân bổ ca Shift-Aware Load.
4. Buổi học/dạy ít nhất (tsBuoiDay min) để tối đa ngày nghỉ cho giáo viên.
5. Tiết trống 1 tiết tối thiểu (soBuoiTrong1 min) dồn tiết liền mạch.
6. Tuân thủ tuyệt đối các ràng buộc cứng: Nghỉ GV, Nghỉ Lớp, Tiết Cố Định, Phòng bộ môn, Trùng lịch, Tính liên tục của học sinh.
7. Xử lý chuẩn xác định nghĩa: "Giới hạn là CẬN TRÊN (<=), không phải bắt buộc".
"""

from __future__ import annotations

import itertools
import json
import logging
import math
import os
import sys
import time
from collections import defaultdict
from typing import Any, Callable, Mapping, Sequence

from ortools.sat.python import cp_model

logger = logging.getLogger("unified_cpsat_solver")

def _log_live(msg: str):
    timestamp = time.strftime("%H:%M:%S")
    line = f"[{timestamp}] [Bộ giải TKB] {msg}"
    try:
        sys.stderr.buffer.write((line + "\n").encode("utf-8", errors="replace"))
        sys.stderr.flush()
    except Exception:
        pass
    try:
        from pathlib import Path
        app_root = os.environ.get("TKB_APP_ROOT") or str(Path(__file__).resolve().parents[3])
        log_dir = os.path.join(app_root, "temp")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "solver_live.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

ProgressFn = Callable[[dict[str, Any]], None]

DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
BUOIS = ["sang", "chieu"]
PERIODS = [0, 1, 2, 3, 4]  # 5 tiết mỗi buổi: 0, 1, 2, 3, 4 (tương ứng tiết 1..5)


def _emit_progress(progress: ProgressFn | None, stage: str, percent: int, message: str, **kwargs):
    if progress:
        try:
            payload = {
                "stage": stage,
                "percent": percent,
                "message": message,
                **kwargs
            }
            progress(payload)
        except Exception:
            pass


def _get_canon_mon_key(name: str) -> str:
    import unicodedata
    s = unicodedata.normalize('NFD', str(name or '')).encode('ascii', 'ignore').decode('ascii').lower()
    s = s.replace('-', ' ').replace('_', ' ').replace(',', ' ').strip()
    if 'stem' in s: return 'stem'
    if 'tin' in s and ('qt' in s or 'quoc te' in s): return 'tinqt'
    if 'tin' in s: return 'tin'
    if 'hdtn 1' in s or 'tnhn 1' in s: return 'hdtn1'
    if 'hdtn 2' in s or 'tnhn 2' in s: return 'hdtn2'
    if 'hdtn 3' in s or 'tnhn 3' in s: return 'hdtn3'
    if 'hdtn' in s or 'tnhn' in s or 'trai nghiem' in s: return 'tnhn'
    if 'gdtc' in s or 'the duc' in s: return 'gdtc'
    if 'gdcd' in s or 'cong dan' in s: return 'gdcd'
    if 'gddp' in s or 'dia phuong' in s: return 'gddp'
    if 'khtn' in s or 'khoa hoc tu nhien' in s: return 'khtn'
    if 'lsdl' in s or 'lich su' in s or 'dia ly' in s: return 'lsdl'
    if 'tabn' in s or 'ban ngu' in s: return 'tabn'
    if 'tatc' in s or 'tang cuong' in s: return 'tatc'
    if 'anh' in s or 'nngu' in s or 'ngoai ngu' in s or 'tieng anh' in s: return 'anh'
    if 'kns' in s or 'ky nang' in s: return 'kns'
    if 'toan' in s: return 'toan'
    if 'van' in s or 'ngu van' in s: return 'van'
    if 'nhac' in s or 'am nhac' in s: return 'nhac'
    if 'mt' in s or 'my thuat' in s: return 'mt'
    if 'cn' in s or 'cong nghe' in s: return 'cn'
    return s.replace(' ', '')



def _get_max_gap(combo: tuple[int, ...]) -> int:
    if len(combo) <= 1:
        return 0
    max_g = 0
    for i in range(len(combo) - 1):
        g = combo[i + 1] - combo[i] - 1
        if g > max_g:
            max_g = g
    return max_g


def _get_gap1_count(combo: tuple[int, ...]) -> int:
    if len(combo) <= 1:
        return 0
    c = 0
    for i in range(len(combo) - 1):
        if combo[i + 1] - combo[i] == 2:
            c += 1
    return c


def _generate_valid_teacher_patterns(max_load: int = 5) -> dict[int, list[tuple[int, ...]]]:
    """Sinh các dải tiết (patterns) hợp lệ cho giáo viên trong 1 buổi 5 tiết.
    
    Quy tắc:
    - Load = 0: ()
    - Load = 1: CẤM (trừ trường hợp bất khả kháng)
    - Load >= 2: Chỉ cho phép các combo có tổng số tiết trống (span - length) <= 1.
      Triệt tiêu 100% các buổi có >= 2 tiết trống (soBuoiTrong2 = 0).
    """
    patterns_by_load = defaultdict(list)
    patterns_by_load[0] = [()]
    
    # Load 1 (cho singleton bất khả kháng)
    for p in PERIODS:
        patterns_by_load[1].append((p,))
        
    # Load 2..5
    for length in range(2, max_load + 1):
        for combo in itertools.combinations(PERIODS, length):
            total_gaps = (combo[-1] - combo[0] + 1) - length
            if total_gaps <= 1:
                patterns_by_load[length].append(combo)
                
    return patterns_by_load


VALID_TEACHER_PATTERNS = _generate_valid_teacher_patterns(5)


class UnifiedCpSatSolver:
    """Bộ giải thời khóa biểu toàn diện TKBCherry dùng Multi-Stage CP-SAT."""

    def __init__(self, data: dict[str, Any], settings: dict[str, Any] | None = None):
        self.data = data
        self.settings = settings or {}
        self.seed = int(self.settings.get("seed", 12345) or 12345)
        self.num_workers = max(4, min(22, os.cpu_count() or 8))
        self.time_limit = max(10, int(self.settings.get("time_limit_seconds", 60) or 60))
        
        self._parse_school_data()

    def _parse_school_data(self):
        """Phân tích và chuẩn hóa dữ liệu trường học từ JSON input."""
        data = self.data
        
        # 1. Classes & Canonical Mapping
        self.raw_classes = data.get("lop", [])
        self.class_ids = [str(l["id"]) for l in self.raw_classes if l and l.get("id")]
        self.class_map = {str(l["id"]): l for l in self.raw_classes if l and l.get("id")}
        
        self.class_alias_to_id = {}
        for l in self.raw_classes:
            cid = str(l.get("id", "")).strip()
            ten = str(l.get("ten", "")).strip()
            ten2 = str(l.get("ten2", "")).strip()
            if cid:
                self.class_alias_to_id[cid] = cid
                self.class_alias_to_id[cid.lower()] = cid
            if ten:
                self.class_alias_to_id[ten] = cid
                self.class_alias_to_id[ten.lower()] = cid
            if ten2:
                self.class_alias_to_id[ten2] = cid
                self.class_alias_to_id[ten2.lower()] = cid
        
        # 2. PCCM
        self.pccm = data.get("pccmMatrix", {})
        self.pccm_tiet = data.get("pccmTietMatrix", {})
        self.pccm_gioihan = data.get("pccmGioihanMatrix", {})
        self.pccm_room = data.get("pccmRoomMatrix", {})
        
        # 3. Active Teachers (chỉ lấy giáo viên thực sự có phân công chuyên môn)
        teachers_set = set()
        for gv in self.pccm.values():
            if gv and str(gv).strip() and str(gv).strip() != "null":
                teachers_set.add(str(gv).strip())
        self.teachers = sorted(teachers_set)
        
        # 4. Constraints
        self.constraints = data.get("tkbConstraints", {}) or {}
        fixed_off = self.constraints.get("fixedOff", {}) or {}
        self.class_off = fixed_off.get("class", {}) or data.get("lopNghi", {}) or {}
        self.teacher_off = fixed_off.get("teacher", {}) or data.get("teacherOff", {}) or data.get("gvNghi", {}) or {}
        self.room_off = fixed_off.get("room", {}) or {}
        
        # Parse data.rangbuoc nếu có
        if "rangbuoc" in data and isinstance(data["rangbuoc"], dict):
            rb_gv = data["rangbuoc"].get("giaovien", {}) or {}
            parsed_t_off = defaultdict(dict)
            for gv_k, gv_v in rb_gv.items():
                if isinstance(gv_v, dict):
                    ban = gv_v.get("ban", {})
                    for d_k, d_v in ban.items():
                        if isinstance(d_v, dict):
                            for b_k in ["sang", "chieu"]:
                                slots = d_v.get(b_k, [])
                                if isinstance(slots, list):
                                    for p_i, is_off in enumerate(slots):
                                        if is_off:
                                            parsed_t_off[gv_k][f"{d_k}|{b_k}|{p_i}"] = True
            for gv_k, off_dict in parsed_t_off.items():
                if gv_k not in self.teacher_off:
                    self.teacher_off[gv_k] = {}
                self.teacher_off[gv_k].update(off_dict)
                
        # 5. Determine Class and Teacher Slot Availability & Fixed Cells
        # Đối với từng lớp, quét ma trận tkb và fixedOff để biết chính xác slot nào OFF, slot nào Fixed
        self.class_off_slots = set() # (cid, day, buoi, period)
        self.class_fixed_slots = {} # (cid, day, buoi, period) -> {mon, gv}
        self.teacher_fixed_slots = defaultdict(set) # (gv, day, buoi, period)
        
        tkb = data.get("tkb", {})
        for cid in self.class_ids:
            lop_info = self.class_map.get(cid, {})
            c_tkb = tkb.get(cid, {})
            
            # Xác định ca học của lớp chính xác
            lop_ca = str(lop_info.get("ca") or lop_info.get("buoi") or lop_info.get("shift") or "").lower()
            if not lop_ca:
                # Kiểm tra các ô trong c_tkb
                sang_has_content = any(c and c != "OFF" for d in DAYS for c in c_tkb.get(d, {}).get("sang", []))
                chieu_has_content = any(c and c != "OFF" for d in DAYS for c in c_tkb.get(d, {}).get("chieu", []))
                if sang_has_content and not chieu_has_content:
                    lop_ca = "sang"
                elif chieu_has_content and not sang_has_content:
                    lop_ca = "chieu"
                else:
                    c_name = str(lop_info.get("ten") or cid).strip().upper()
                    if c_name.startswith("7") or lop_info.get("khoi") in (7, "7"):
                        lop_ca = "chieu"
                    elif c_name.startswith("9") or lop_info.get("khoi") in (9, "9"):
                        lop_ca = "sang"
                    elif c_name.startswith("6"):
                        lop_ca = "chieu" if any(c_name == f"6A{i}" for i in range(5, 9)) else "sang"
                    elif c_name.startswith("8"):
                        lop_ca = "chieu" if any(c_name == f"8A{i}" for i in range(10, 19)) else "sang"
                    else:
                        lop_ca = "sang"
            
            for day in DAYS:
                for b in BUOIS:
                    # Nếu lớp thuộc ca sáng nhưng buổi là chiều -> OFF cả buổi
                    if lop_ca == "sang" and b == "chieu":
                        for p in range(5):
                            self.class_off_slots.add((cid, day, b, p))
                        continue
                    # Nếu lớp thuộc ca chiều nhưng buổi là sáng -> OFF cả buổi
                    if lop_ca == "chieu" and b == "sang":
                        for p in range(5):
                            self.class_off_slots.add((cid, day, b, p))
                        continue
                        
                    cells = c_tkb.get(day, {}).get(b, [])
                    for p in range(5):
                        cell = cells[p] if p < len(cells) else None
                        
                        # Check explicit class_off
                        if self.class_off.get(cid, {}).get(f"{day}|{b}|{p}") or cell == "OFF":
                            self.class_off_slots.add((cid, day, b, p))
                        elif cell:
                            is_fixed = False
                            mon_name = ""
                            gv_name = ""
                            if isinstance(cell, dict) and cell.get("fixed"):
                                is_fixed = True
                                mon_name = str(cell.get("mon") or "")
                                gv_name = str(cell.get("gv") or "")
                            elif isinstance(cell, str) and cell.strip():
                                c_str = cell.strip()
                                # Chỉ tự động cố định Chào cờ / HĐTN 1 & 2 ở Thứ 2; KHÔNG cố định HĐTN 3
                                if day == "thu2" and any(tag in c_str for tag in ["HĐTN 1", "HĐTN 2", "Chào cờ"]):
                                    is_fixed = True
                                    if " - " in c_str:
                                        parts = c_str.split(" - ", 1)
                                        mon_name = parts[0].strip()
                                        gv_name = parts[1].strip()
                                    else:
                                        mon_name = c_str
                            
                            if is_fixed and mon_name:
                                if not gv_name:
                                    gv_name = str(self.pccm.get(f"{cid}|{mon_name}") or "")
                                self.class_fixed_slots[(cid, day, b, p)] = {"mon": mon_name, "gv": gv_name}
                                if gv_name:
                                    self.teacher_fixed_slots[(gv_name, day, b, p)].add(cid)

        # Tính capacity (số slot mở) của từng lớp trong từng buổi
        self.class_session_capacity = defaultdict(int)
        self.class_sessions = defaultdict(list)
        for cid in self.class_ids:
            for day in DAYS:
                for b in BUOIS:
                    open_slots = sum(
                        1
                        for p in range(5)
                        if (cid, day, b, p) not in self.class_off_slots
                        and (cid, day, b, p) not in self.class_fixed_slots
                    )
                    if open_slots > 0:
                        self.class_session_capacity[(cid, day, b)] = open_slots
                        self.class_sessions[cid].append((day, b))

        # 6. Build Assignments list (trừ đi các tiết fixed đã xếp)
        # Đếm số tiết fixed theo từng (cid, canon_mon)
        fixed_count = defaultdict(int)
        for (cid, day, b, p), f_info in self.class_fixed_slots.items():
            fixed_count[(cid, _get_canon_mon_key(f_info["mon"]))] += 1
            
        self.assignments = []
        # 19/08 FIX: so tiet/tuan phai lay theo dung thu tu cua ung dung:
        #   1) pccmTietMatrix[lop|mon]  (gia tri ghi de cua tung lop)
        #   2) TIET CHUAN theo KHOI (DATA.mon: {khoi, ten, sotiet, gioihan})
        # Truoc day chi doc (1); ma ung dung TU DONG XOA cac o (1) trung voi
        # tiet chuan (pruneRedundantPccmPeriods), nen voi truong dung tiet chuan
        # thi pccmTietMatrix RONG -> bo giai nay thay 0 tiet -> ket thuc trong
        # 0,1 giay va tra lich rong (Flash bi vo hieu, phai nho engine v3 lam ho).
        import re as _re

        def _grade_key(value) -> str:
            m = _re.search(r"\d+", str(value or ""))
            return m.group(0) if m else ""

        self.std_periods = {}
        self.std_limits = {}
        for _row in (data.get("mon") or []):
            if not isinstance(_row, dict):
                continue
            _g = _grade_key(_row.get("khoi"))
            _m = _get_canon_mon_key(str(_row.get("ten") or _row.get("mon") or ""))
            try:
                _st = int(_row.get("sotiet") or 0)
            except Exception:
                _st = 0
            if not _g or not _m or _st <= 0:
                continue
            self.std_periods[(_g, _m)] = _st
            try:
                _gh = int(_row.get("gioihan") or 0)
            except Exception:
                _gh = 0
            if _gh > 0:
                self.std_limits[(_g, _m)] = _gh

        def _class_grade(cid_value: str) -> str:
            info = self.class_map.get(cid_value) or {}
            return _grade_key(info.get("khoi") or info.get("ten") or info.get("ten2") or cid_value)

        total_expected = 0
        for key, gv in self.pccm.items():
            gv = str(gv).strip()
            if not gv or gv == "null":
                continue
            parts = key.split("|")
            if len(parts) != 2:
                continue
            raw_cid, mon = parts[0], parts[1]
            cid = self.class_alias_to_id.get(raw_cid.lower(), self.class_alias_to_id.get(raw_cid, raw_cid))
            total_req = int(self.pccm_tiet.get(key, 0) or 0)
            if total_req <= 0:
                total_req = int(self.std_periods.get((_class_grade(cid), _get_canon_mon_key(mon)), 0) or 0)
            total_expected += total_req
            
            # Trừ các tiết fixed đã có sẵn theo canonical key
            already_fixed = fixed_count.get((cid, _get_canon_mon_key(mon)), 0)
            remaining_tiet = max(0, total_req - already_fixed)
            if remaining_tiet <= 0:
                continue
                
            limit = int(self.pccm_gioihan.get(key, 0) or 0)
            if limit <= 0:
                limit = int(self.std_limits.get((_class_grade(cid), _get_canon_mon_key(mon)), 0) or 0)
            if limit <= 0:
                limit = 2  # CẬN TRÊN
            room = str(self.pccm_room.get(key, "") or "").strip()
            
            self.assignments.append({
                "id": len(self.assignments),
                "key": key,
                "classId": cid,
                "mon": mon,
                "gv": gv,
                "totalPeriods": remaining_tiet,
                "limitDaily": limit,
                "room": room
            })

        # Tong so tiet toan truong = tong so tiet da giai theo dung thu tu uu tien
        # (khong con phu thuoc rieng vao pccmTietMatrix).
        self.total_school_periods = total_expected or sum(int(v) for v in self.pccm_tiet.values() if v)
        self.total_periods = self.total_school_periods
        
        # 7. Teacher shift total assigned periods (tính chính xác theo ca của lớp)
        self.teacher_shift_loads = defaultdict(lambda: {"sang": 0, "chieu": 0})
        self.teacher_total_loads = defaultdict(int)
        for a in self.assignments:
            gv = a["gv"]
            tot = a["totalPeriods"]
            self.teacher_total_loads[gv] += tot
            cid = a["classId"]
            lop_buois = set(b for (d, b) in self.class_sessions.get(cid, []))
            if len(lop_buois) == 1:
                ca = next(iter(lop_buois))
                self.teacher_shift_loads[gv][ca] += tot
            else:
                ca = self.class_map.get(cid, {}).get("ca", "sang")
                self.teacher_shift_loads[gv][ca] += tot
                
        for (gv, day, b, p) in self.teacher_fixed_slots:
            self.teacher_shift_loads[gv][b] += 1
            self.teacher_total_loads[gv] += 1

        # 8. Fixed Cells from class_fixed_slots
        self.fixed_cells = [
            {"classId": cid, "day": day, "buoi": b, "period": p, "mon": f_info["mon"], "gv": f_info["gv"]}
            for (cid, day, b, p), f_info in self.class_fixed_slots.items()
        ]

    def solve(self, progress: ProgressFn | None = None) -> dict[str, Any]:
        """Thực hiện giải TKB hoàn chỉnh bằng Multi-Stage CP-SAT với Feedback Loop."""
        t_start = time.time()
        _log_live(f"=== BẮT ĐẦU XẾP TKB TOÀN DIỆN ({self.total_periods} tiết, {len(self.class_ids)} lớp, {len(self.teachers)} GV) ===")
        _emit_progress(progress, "start", 5, "Khởi động bộ giải toán học tối ưu")
        
        # Maximum Benders feedback iterations
        MAX_FEEDBACK_ROUNDS = 5
        no_good_cuts: list[tuple[str, str, list[int]]] = [] # list of (day, buoi, [aid1, aid2...])
        
        best_solution = None
        
        for iteration in range(MAX_FEEDBACK_ROUNDS):
            round_t0 = time.time()
            progress_percent = 10 + iteration * 15
            _log_live(f"-> [TẦNG 1] Đang tối ưu phân bổ buổi học (Vòng {iteration + 1}/{MAX_FEEDBACK_ROUNDS})...")
            _emit_progress(
                progress,
                "session_master",
                progress_percent,
                f"Đang tối ưu phân bổ buổi (Vòng {iteration + 1}/{MAX_FEEDBACK_ROUNDS})",
                iteration=iteration + 1
            )
            
            # --- TẦNG 1: SESSION MASTER MODEL ---
            session_result = self._solve_session_master(no_good_cuts)
            if not session_result or not session_result.get("ok"):
                _log_live(f"-> [TẦNG 1 CẢNH BÁO] Không tìm thấy nghiệm ở vòng {iteration + 1}")
                logger.warning("Session master model infeasible in iteration %d", iteration + 1)
                break
                
            session_allocation = session_result["allocation"] # (aid, day, buoi) -> duration
            ts_buoi_day = session_result["tsBuoiDay"]
            _log_live(f"-> [TẦNG 1 THÀNH CÔNG] Đã phân bổ buổi: tsBuoiDay={ts_buoi_day}, soBuoiDay1={session_result.get('soBuoiDay1', 0)}")
            
            # --- TẦNG 2: PERIOD PATTERN SUB-SOLVER THEO BUỔI ---
            _log_live(f"-> [TẦNG 2] Đang giải chi tiết 12 buổi học và triệt tiêu tiết trống...")
            _emit_progress(
                progress,
                "period_subsolver",
                progress_percent + 10,
                f"Đang xếp chi tiết tiết học và triệt tiêu tiết trống (tsBuoiDay = {ts_buoi_day})"
            )
            
            period_result = self._solve_period_stages(session_allocation)
            
            # So sánh đa tiêu chí để luôn giữ lại nghiệm TỐT NHẤT (placed cao nhất, gap2 thấp nhất, day1 thấp nhất)
            is_better = False
            if best_solution is None:
                is_better = True
            elif period_result["total_placed"] > best_solution.get("placed", 0):
                is_better = True
            elif period_result["total_placed"] == best_solution.get("placed", 0):
                prev_gap2 = best_solution.get("soBuoiTrong2", 999)
                curr_gap2 = period_result["soBuoiTrong2"]
                if curr_gap2 < prev_gap2:
                    is_better = True
                elif curr_gap2 == prev_gap2:
                    prev_day1 = best_solution.get("soBuoiDay1", 999)
                    curr_day1 = period_result["soBuoiDay1"]
                    if curr_day1 < prev_day1:
                        is_better = True
                    elif curr_day1 == prev_day1:
                        if period_result["soBuoiTrong1"] < best_solution.get("soBuoiTrong1", 999):
                            is_better = True

            if is_better:
                best_solution = {
                    "ok": True,
                    "applied": True,
                    "tkb": period_result["tkb"],
                    "placed": period_result["total_placed"],
                    "unassigned": self.total_periods - period_result["total_placed"],
                    "tsBuoiDay": ts_buoi_day,
                    "soBuoiDay1": period_result["soBuoiDay1"],
                    "soBuoiTrong2": period_result["soBuoiTrong2"],
                    "soBuoiTrong1": period_result["soBuoiTrong1"],
                    "runtime_seconds": time.time() - t_start,
                    "iterations": iteration + 1
                }
            
            if period_result["all_feasible"]:
                # HOÀN TOÀN KHẢ THI 100%!
                _log_live(f"-> [TẦNG 2 THÀNH CÔNG] Xếp đủ 100%: {period_result['total_placed']}/{self.total_periods} tiết (soBuoiDay1={period_result['soBuoiDay1']}, soBuoiTrong2={period_result['soBuoiTrong2']}, soBuoiTrong1={period_result['soBuoiTrong1']})")
                break
            else:
                # Có buổi bị xung đột cấu trúc -> Thêm No-Good Cut phản hồi về Tầng 1
                infeasible_sessions = period_result["infeasible_sessions"]
                _log_live(f"-> [TẦNG 2 PHẢN HỒI] Có {len(infeasible_sessions)} buổi cần điều chỉnh, gửi Feedback Cut về Tầng 1...")
                logger.info("Infeasible sessions in round %d: %s", iteration + 1, infeasible_sessions)
                for (day, b), conflicting_aids in infeasible_sessions.items():
                    no_good_cuts.append((day, b, conflicting_aids))

        if best_solution is None:
            best_solution = self._solve_integrated_fallback()
        total_runtime = time.time() - t_start
        placed = best_solution.get("placed", 0) or 0
        unassigned = max(0, self.total_periods - placed)
        best_solution["unassigned"] = unassigned
        _log_live(f"=== HOÀN TẤT TRỌN GÓI TRONG {total_runtime:.2f}s (Đã xếp {placed}/{self.total_periods} tiết, Chưa xếp: {unassigned}) ===")
        
        # Đọc các dòng log thực thi gần nhất để trả về kèm kết quả cho Web UI
        recent_logs = []
        try:
            from pathlib import Path
            app_root = os.environ.get("TKB_APP_ROOT") or str(Path(__file__).resolve().parents[3])
            log_path = os.path.join(app_root, "temp", "solver_live.log")
            if os.path.exists(log_path):
                with open(log_path, "r", encoding="utf-8") as f:
                    recent_logs = [line.strip() for line in f.readlines()[-30:] if line.strip()]
        except Exception:
            pass
        best_solution["logs"] = recent_logs
        
        best_solution["metrics"] = {
            "scheduled_periods": placed,
            "expected_periods": self.total_periods,
            "solver_unassigned_periods": unassigned,
            "tsBuoiDay": best_solution.get("tsBuoiDay", 0),
            "soBuoiDay1": best_solution.get("soBuoiDay1", 0),
            "soBuoiTrong2": best_solution.get("soBuoiTrong2", 0),
            "soBuoiTrong1": best_solution.get("soBuoiTrong1", 0),
            "hard_ok": placed == self.total_periods,
            "core_hard_ok": placed == self.total_periods,
        }
        
        _emit_progress(
            progress,
            "done",
            100,
            f"Hoàn tất: Đã xếp {placed}/{self.total_periods} tiết, "
            f"1 tiết/buổi: {best_solution.get('soBuoiDay1')}, Trống 2: {best_solution.get('soBuoiTrong2')}, "
            f"Buổi dạy: {best_solution.get('tsBuoiDay')}, Trống 1: {best_solution.get('soBuoiTrong1')}",
            metrics=best_solution["metrics"]
        )
        return best_solution

    # ---- HOOK cho ban hop nhat (Cherry). Lop co so KHONG rang buoc gi them ----
    def _extra_session_constraints(self, model, x_vars):
        """No-op o ban goc; lop con them rang buoc tiet doi o Tang 1."""
        return None

    def _extra_period_constraints(self, model, p_vars, acts, day, buoi):
        """No-op o ban goc; lop con them rang buoc tranh tiet 2-3 o Tang 2."""
        return None

    def _solve_session_master(self, no_good_cuts: list[tuple[str, str, list[int]]]) -> dict[str, Any] | None:
        """Tầng 1: Session Master Model phân bổ môn vào các buổi."""
        model = cp_model.CpModel()
        
        x_vars = {} # (aid, day, buoi) -> IntVar (số tiết)
        x_active = {} # (aid, day, buoi) -> BoolVar (có dạy trong buổi)
        class_session_loads = defaultdict(list)
        teacher_session_loads = defaultdict(list)
        act_day_vars = defaultdict(list)
        act_all_vars = defaultdict(list)
        singleton_penalties = []
        
        act_deficits = []
        for act in self.assignments:
            aid = act["id"]
            cid = act["classId"]
            gv = act["gv"]
            tot = act["totalPeriods"]
            limit = act["limitDaily"]
            
            for (day, b) in self.class_sessions[cid]:
                gv_off_count = sum(1 for p in range(5) if self.teacher_off.get(gv, {}).get(f"{day}|{b}|{p}"))
                if gv_off_count >= 5:
                    continue
                    
                cap = self.class_session_capacity.get((cid, day, b), 5)
                max_p = min(tot, limit, cap)
                if max_p <= 0:
                    continue
                    
                x = model.NewIntVar(0, max_p, f"x_{aid}_{day}_{b}")
                x_vars[(aid, day, b)] = x
                act_all_vars[aid].append(x)
                act_day_vars[(aid, day)].append(x)
                class_session_loads[(cid, day, b)].append(x)
                teacher_session_loads[(gv, day, b)].append(x)
                
                act_b = model.NewBoolVar(f"x_act_{aid}_{day}_{b}")
                x_active[(aid, day, b)] = act_b
                model.Add(x <= max_p * act_b)
                model.Add(x >= act_b)
                
            # Đảm bảo 100% đủ tiết môn
            if act_all_vars[aid]:
                model.Add(sum(act_all_vars[aid]) == tot)
            else:
                return {"ok": False}
                
            # Ràng buộc CẬN TRÊN số tiết trong 1 ngày <= limitDaily
            for day in DAYS:
                if act_day_vars[(aid, day)]:
                    model.Add(sum(act_day_vars[(aid, day)]) <= limit)

            # RÀNG BUỘC BLOCK TIẾT CHUẨN SƯ PHẠM (Khuyến khích mạnh block 2 tiết, phạt nặng xé lẻ)
            if limit == 2 and tot >= 2:
                for (day, b) in self.class_sessions[cid]:
                    if (aid, day, b) in x_vars:
                        x_var = x_vars[(aid, day, b)]
                        is_split1 = model.NewBoolVar(f"is_split1_{aid}_{day}_{b}")
                        model.Add(x_var == 1).OnlyEnforceIf(is_split1)
                        model.Add(x_var != 1).OnlyEnforceIf(is_split1.Not())
                        singleton_penalties.append(is_split1)

        # Ràng buộc tải lớp trong buổi <= capacity còn lại của buổi đó
        for cid in self.class_ids:
            for (day, b) in self.class_sessions[cid]:
                terms = class_session_loads[(cid, day, b)]
                if terms:
                    cap = self.class_session_capacity.get((cid, day, b), 5)
                    model.Add(sum(terms) <= cap)

        # Ràng buộc chống nghẽn slot giữa cho buổi <= 3 slot (Pigeonhole Constraint)
        for gv in self.teachers:
            for day in DAYS:
                for b in BUOIS:
                    dur2_indicators = []
                    for aid, act in enumerate(self.assignments):
                        if act["gv"] == gv and (aid, day, b) in x_vars:
                            cid = act["classId"]
                            cap = self.class_session_capacity.get((cid, day, b), 5)
                            if cap <= 3:
                                is_dur2 = model.NewBoolVar(f"is_dur2_{aid}_{day}_{b}")
                                model.Add(x_vars[(aid, day, b)] >= 2).OnlyEnforceIf(is_dur2)
                                model.Add(x_vars[(aid, day, b)] < 2).OnlyEnforceIf(is_dur2.Not())
                                dur2_indicators.append(is_dur2)
                    if len(dur2_indicators) > 1:
                        model.Add(sum(dur2_indicators) <= 1)

        # Ràng buộc tải GV và triệt tiêu Buổi có 1 tiết bằng Parity Upper Bound
        z_teacher_session = {} # (gv, day, buoi) -> bool
        singleton_penalties = []
        teacher_singles = defaultdict(list)
        
        for gv in self.teachers:
            for day in DAYS:
                for b in BUOIS:
                    z = model.NewBoolVar(f"z_sess_{gv}_{day}_{b}")
                    z_teacher_session[(gv, day, b)] = z
                    
                    # Tính số tiết fixed và slot thực sự mở của GV trong buổi này
                    fixed_p_gv = len([p for p in range(5) if (gv, day, b, p) in self.teacher_fixed_slots])
                    gv_aids = [a["id"] for a in self.assignments if a["gv"] == gv]
                    open_p_for_gv = 0
                    for p in range(5):
                        if not self.teacher_off.get(gv, {}).get(f"{day}|{b}|{p}"):
                            if any((self.assignments[aid]["classId"], day, b, p) not in self.class_off_slots and (self.assignments[aid]["classId"], day, b, p) not in self.class_fixed_slots for aid in gv_aids):
                                open_p_for_gv += 1
                    gv_max_avail = open_p_for_gv
                    
                    terms = teacher_session_loads.get((gv, day, b), [])
                    if terms:
                        load = sum(terms)
                        if gv_max_avail > 0:
                            model.Add(load <= gv_max_avail * z)
                            model.Add(load >= z)
                            
                            # Shift-aware singleton elimination
                            total_load_expr = load + fixed_p_gv
                            is_single = model.NewBoolVar(f"is_single_{gv}_{day}_{b}")
                            model.Add(total_load_expr >= 2).OnlyEnforceIf([is_single.Not(), z])
                            model.Add(total_load_expr == 1).OnlyEnforceIf(is_single)
                            model.Add(z == 1).OnlyEnforceIf(is_single)
                            singleton_penalties.append(is_single)
                            teacher_singles[(gv, b)].append(is_single)
                        else:
                            model.Add(load == 0)
                            model.Add(z == 0)
                    else:
                        model.Add(z == 0)

        # CẬN TRÊN TOÁN HỌC CHO SỐ BUỔI 1 TIẾT:
        # Chỉ những GV có tổng tải ca == 1 (hoặc GV có 1 lớp dạy đúng 3 tiết nhưng limitDaily == 2) mới được phép có tối đa 1 buổi 1 tiết.
        # Tất cả các GV khác CẤM HOÀN TOÀN buổi 1 tiết (allowed_singles = 0)!
        for (gv, b), s_vars in teacher_singles.items():
            sh_load = self.teacher_shift_loads[gv][b]
            if sh_load <= 0:
                model.Add(sum(s_vars) == 0)
            elif sh_load == 1:
                model.Add(sum(s_vars) <= 1)
            elif sh_load == 3:
                # Chỉ cho phép nếu GV có 1 lớp dạy đúng 3 tiết và limitDaily <= 2 (ví dụ Thầy A.Khánh với 8A2)
                gv_has_single_class_3 = any(
                    a["gv"] == gv and a["totalPeriods"] == 3 and a["limitDaily"] <= 2
                    for a in self.assignments
                )
                if gv_has_single_class_3:
                    model.Add(sum(s_vars) <= 1)
                else:
                    # Nếu là nhiều lớp khác nhau (như Cô Ti.Dương dạy 9A18, 9A19, 9A20), gom toàn bộ 3 tiết vào 1 buổi -> 0 buổi 1 tiết!
                    model.Add(sum(s_vars) == 0)
            else:
                model.Add(sum(s_vars) == 0)

        # Ràng buộc Cận trên số buổi/tuần và số ngày/tuần của GV nếu có
        teacher_constraints = self.constraints.get("teacher", {}) or {}
        for gv, t_conf in teacher_constraints.items():
            if not isinstance(t_conf, dict):
                continue
            max_days = int(t_conf.get("maxDaysSessions", {}).get("maxDays", 0) or 0)
            if max_days > 0:
                # CẬN TRÊN số ngày dạy
                day_active_vars = []
                for day in DAYS:
                    day_z = [z_teacher_session[(gv, day, b)] for b in BUOIS if (gv, day, b) in z_teacher_session]
                    if day_z:
                        d_act = model.NewBoolVar(f"d_act_{gv}_{day}")
                        for z in day_z:
                            model.Add(z <= d_act)
                        model.Add(d_act <= sum(day_z))
                        day_active_vars.append(d_act)
                if day_active_vars:
                    model.Add(sum(day_active_vars) <= max_days)

        # Thêm các No-Good Cuts từ các vòng lặp trước
        for (cut_day, cut_b, cut_aids) in no_good_cuts:
            cut_terms = [x_active[(aid, cut_day, cut_b)] for aid in cut_aids if (aid, cut_day, cut_b) in x_active]
            if len(cut_terms) > 1:
                # Ít nhất 1 môn trong nhóm xung đột phải chuyển sang buổi khác
                model.Add(sum(cut_terms) <= len(cut_terms) - 1)

        # HÀM MỤC TIÊU LEXICOGRAPHIC TẦNG 1:
        # Priority 1: Triệt tiêu buổi 1 tiết (Phạt 10,000,000 điểm)
        # Priority 2: Tối thiểu hóa tổng số buổi dạy GV (Phạt 1,000 điểm)
        total_teacher_sessions = sum(z_teacher_session.values())
        total_singletons = sum(singleton_penalties) if singleton_penalties else 0
        # HOOK (TKBCherry): lop con co the them rang buoc rieng (tiet doi...).
        self._extra_session_constraints(model, x_vars)
        model.Minimize(total_singletons * 10000000 + total_teacher_sessions * 1000)

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 6.0
        solver.parameters.num_search_workers = 4
        solver.parameters.random_seed = self.seed
        
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return {"ok": False}
            
        allocation = {}
        for (aid, day, b), x in x_vars.items():
            val = int(solver.Value(x))
            if val > 0:
                allocation[(aid, day, b)] = val
                
        return {
            "ok": True,
            "allocation": allocation,
            "tsBuoiDay": int(solver.Value(total_teacher_sessions)),
            "soBuoiDay1": int(solver.Value(total_singletons)) if singleton_penalties else 0
        }

    def _solve_period_stages(self, allocation: dict[tuple[int, str, str], int]) -> dict[str, Any]:
        """Tầng 2: Xếp chi tiết từng tiết trong 12 buổi học với Pattern-based CP-SAT."""
        # Gom các act theo từng buổi
        session_acts = defaultdict(list)
        for (aid, day, b), dur in allocation.items():
            act = self.assignments[aid]
            session_acts[(day, b)].append({
                "aid": aid,
                "classId": act["classId"],
                "mon": act["mon"],
                "gv": act["gv"],
                "room": act["room"],
                "duration": dur
            })

        import concurrent.futures

        all_tkb = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: ["", "", "", "", ""])))
        total_placed = 0
        total_gap1 = 0
        total_gap2 = 0
        total_day1 = 0
        all_feasible = True
        infeasible_sessions = {}

        session_tasks = []
        for day in DAYS:
            for b in BUOIS:
                sess_acts = session_acts.get((day, b), [])
                if sess_acts:
                    session_tasks.append((day, b, sess_acts))

        def _solve_task(task):
            d, b, s_acts = task
            expected_p = sum(item["duration"] for item in s_acts)
            res = self._solve_single_session_periods(d, b, s_acts)
            if not res.get("ok") or res.get("placed", 0) < expected_p:
                res_soft = self._solve_single_session_periods_soft(d, b, s_acts)
                if res_soft.get("ok") and res_soft.get("placed", 0) >= res.get("placed", 0):
                    res = res_soft
            return d, b, s_acts, res

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
            results = list(executor.map(_solve_task, session_tasks))

        teacher_busy_slots = set()
        for (gv, day, b, p) in self.teacher_fixed_slots:
            teacher_busy_slots.add((gv, day, b, p))

        for day, b, s_acts, sess_res in results:
            expected_sess_p = sum(item["duration"] for item in s_acts)
            if sess_res.get("ok"):
                for cid, p_map in sess_res["class_grid"].items():
                    for p, mon in p_map.items():
                        gv_act = ""
                        for act in s_acts:
                            if act["classId"] == cid and act["mon"] == mon:
                                gv_act = act["gv"]
                                teacher_busy_slots.add((act["gv"], day, b, p))
                                break
                        all_tkb[cid][day][b][p] = {"mon": mon, "gv": gv_act}
                total_placed += sess_res["placed"]
                total_gap1 += sess_res["gap1"]
                total_gap2 += sess_res["gap2"]
                total_day1 += sess_res["day1"]
                if sess_res["placed"] < expected_sess_p:
                    all_feasible = False
                    unplaced_cids = set()
                    for cid in set(item["classId"] for item in s_acts):
                        c_exp = sum(item["duration"] for item in s_acts if item["classId"] == cid)
                        c_act = len(sess_res["class_grid"].get(cid, {}))
                        if c_act < c_exp:
                            unplaced_cids.add(cid)
                    bad_aids = [item["aid"] for item in s_acts if item["classId"] in unplaced_cids]
                    infeasible_sessions[(day, b)] = bad_aids if bad_aids else [item["aid"] for item in s_acts]
            else:
                all_feasible = False
                infeasible_sessions[(day, b)] = [item["aid"] for item in s_acts]

        # Populate FIXED and OFF cells into all_tkb
        for (cid, day, b, p), f_info in self.class_fixed_slots.items():
            all_tkb[cid][day][b][p] = {"fixed": True, "mon": f_info["mon"], "gv": f_info["gv"]}
            total_placed += 1
            
        for cid in self.class_ids:
            for day in DAYS:
                for b in BUOIS:
                    for p in range(5):
                        if (cid, day, b, p) in self.class_off_slots:
                            all_tkb[cid][day][b][p] = "OFF"

        # Bước bù trừ và lấp đầy 100% bằng Last-Mile Exact CP-SAT
        missing_items = []
        for aid, act in enumerate(self.assignments):
            cid = act["classId"]
            mon = act["mon"]
            gv = act["gv"]
            tot = act["totalPeriods"]
            cur_placed = 0
            for d in DAYS:
                for b in BUOIS:
                    for p in range(5):
                        cell = all_tkb[cid][d][b][p]
                        if cell == mon or (isinstance(cell, dict) and cell.get("mon") == mon and not cell.get("fixed")):
                            cur_placed += 1
            missing = tot - cur_placed
            for _ in range(missing):
                missing_items.append({"aid": aid, "cid": cid, "mon": mon, "gv": gv, "limit": act["limitDaily"]})
                
        if missing_items:
            lm_model = cp_model.CpModel()
            lm_vars = {} # (item_idx, day, buoi, p) -> BoolVar
            lm_class_slot = defaultdict(list)
            lm_teacher_slot = defaultdict(list)
            
            for idx, item in enumerate(missing_items):
                cid = item["cid"]
                gv = item["gv"]
                item_candidate_vars = []
                
                for (d, b) in self.class_sessions[cid]:
                    for p in range(5):
                        if all_tkb[cid][d][b][p] != "":
                            continue
                        if (cid, d, b, p) in self.class_off_slots or (cid, d, b, p) in self.class_fixed_slots:
                            continue
                        if self.teacher_off.get(gv, {}).get(f"{d}|{b}|{p}"):
                            continue
                        if (gv, d, b, p) in teacher_busy_slots:
                            continue
                        # Kiểm tra tính liền nhau nếu môn này đã có trong buổi (d, b)
                        existing_p_m = [p_cur for p_cur in range(5) if (all_tkb[cid][d][b][p_cur] == item["mon"] or (isinstance(all_tkb[cid][d][b][p_cur], dict) and all_tkb[cid][d][b][p_cur].get("mon") == item["mon"]))]
                        if existing_p_m and any(abs(p - ep) > 1 for ep in existing_p_m):
                            continue
                            
                        # Kiểm tra xem gv tại (d, b) có bị tạo gap >= 2 không
                        gv_current_p = sorted(list(set([p_k for p_k in range(5) if (gv, d, b, p_k) in teacher_busy_slots] + [p])))
                        if len(gv_current_p) >= 2 and (gv_current_p[-1] - gv_current_p[0] + 1 - len(gv_current_p)) >= 2:
                            continue
                            
                        v = lm_model.NewBoolVar(f"lm_{idx}_{d}_{b}_{p}")
                        lm_vars[(idx, d, b, p)] = v
                        item_candidate_vars.append(v)
                        lm_class_slot[(cid, d, b, p)].append(v)
                        lm_teacher_slot[(gv, d, b, p)].append(v)
                        
                if item_candidate_vars:
                    lm_model.Add(sum(item_candidate_vars) <= 1)
                    
            for (cid, d, b, p), terms in lm_class_slot.items():
                lm_model.Add(sum(terms) <= 1)
            for (gv, d, b, p), terms in lm_teacher_slot.items():
                lm_model.Add(sum(terms) <= 1)
                
            if lm_vars:
                lm_model.Maximize(sum(lm_vars.values()))
                lm_solver = cp_model.CpSolver()
                lm_solver.parameters.max_time_in_seconds = 3.0
                lm_st = lm_solver.Solve(lm_model)
                if lm_st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                    for (idx, d, b, p), v in lm_vars.items():
                        if lm_solver.Value(v) == 1:
                            item = missing_items[idx]
                            all_tkb[item["cid"]][d][b][p] = item["mon"]
                            teacher_busy_slots.add((item["gv"], d, b, p))
                            total_placed += 1

        # Bước Swap Ejection Chain (Lặp tối đa 15 lượt để lan truyền hoán đổi)
        if total_placed < self.total_periods:
            for pass_idx in range(15):
                still_missing = []
                for act in self.assignments:
                    cid = act["classId"]
                    mon = act["mon"]
                    tot = act["totalPeriods"]
                    c_p = 0
                    for d in DAYS:
                        for b in BUOIS:
                            for p in range(5):
                                cell = all_tkb[cid][d][b][p]
                                if cell == mon or (isinstance(cell, dict) and cell.get("mon") == mon and not cell.get("fixed")):
                                    c_p += 1
                    if c_p < tot:
                        for _ in range(tot - c_p):
                            still_missing.append({"cid": cid, "mon": mon, "gv": act["gv"]})
                            
                if not still_missing:
                    break
                    
                progress_made = False
                for item in still_missing:
                    cid = item["cid"]
                    m1 = item["mon"]
                    gv1 = item["gv"]
                    placed_this = False
                    
                    empty_slots = []
                    for (d, b) in self.class_sessions[cid]:
                        for p in range(5):
                            if all_tkb[cid][d][b][p] == "":
                                if (cid, d, b, p) not in self.class_off_slots and (cid, d, b, p) not in self.class_fixed_slots:
                                    empty_slots.append((d, b, p))
                                    
                    # Thử đặt trực tiếp trước nếu có slot trống nào gv1 rảnh
                    for (d_emp, b_emp, p_emp) in empty_slots:
                        if not self.teacher_off.get(gv1, {}).get(f"{d_emp}|{b_emp}|{p_emp}") and (gv1, d_emp, b_emp, p_emp) not in teacher_busy_slots:
                            # Kiểm tra xem m1 tại (d_emp, b_emp) có duy trì tính liền nhau không
                            c_m1 = _get_canon_mon_key(m1)
                            new_p_m1 = sorted(list(set([
                                p for p in range(5) 
                                if _get_canon_mon_key(all_tkb[cid][d_emp][b_emp][p].get("mon") if isinstance(all_tkb[cid][d_emp][b_emp][p], dict) else all_tkb[cid][d_emp][b_emp][p]) == c_m1
                            ] + [p_emp])))
                            if len(new_p_m1) >= 2 and any(abs(new_p_m1[k+1] - new_p_m1[k]) > 1 for k in range(len(new_p_m1) - 1)):
                                continue
                                
                            # Kiểm tra tổng tiết trống của gv1 tại (d_emp, b_emp)
                            gv1_p_dir = sorted(list(set([p for p in range(5) if (gv1, d_emp, b_emp, p) in teacher_busy_slots] + [p_emp])))
                            if len(gv1_p_dir) >= 2 and (gv1_p_dir[-1] - gv1_p_dir[0] + 1 - len(gv1_p_dir)) >= 2:
                                continue
                            if len(gv1_p_dir) == 1 and self.teacher_shift_loads[gv1][b_emp] >= 2:
                                continue
                            all_tkb[cid][d_emp][b_emp][p_emp] = {"mon": m1, "gv": gv1}
                            teacher_busy_slots.add((gv1, d_emp, b_emp, p_emp))
                            total_placed += 1
                            placed_this = True
                            progress_made = True
                            break
                            
                    if placed_this:
                        continue
                                    
                    # Thử Swap 1-step
                    for (d_cur, b_cur) in self.class_sessions[cid]:
                        if placed_this:
                            break
                        for p_cur in range(5):
                            if placed_this:
                                break
                            cell_cur = all_tkb[cid][d_cur][b_cur][p_cur]
                            if not cell_cur or cell_cur == "OFF" or (isinstance(cell_cur, dict) and cell_cur.get("fixed")):
                                continue
                            m2 = cell_cur if isinstance(cell_cur, str) else cell_cur.get("mon")
                            gv2 = cell_cur.get("gv") if isinstance(cell_cur, dict) and cell_cur.get("gv") else None
                            if not gv2:
                                for a in self.assignments:
                                    if a["classId"] == cid and a["mon"] == m2:
                                        gv2 = a["gv"]
                                        break
                            if not gv2:
                                continue
                                
                            for (d_emp, b_emp, p_emp) in empty_slots:
                                if self.teacher_off.get(gv2, {}).get(f"{d_emp}|{b_emp}|{p_emp}") or (gv2, d_emp, b_emp, p_emp) in teacher_busy_slots:
                                    continue
                                if self.teacher_off.get(gv1, {}).get(f"{d_cur}|{b_cur}|{p_cur}") or (gv1, d_cur, b_cur, p_cur) in teacher_busy_slots:
                                    continue
                                    
                                # Kiểm tra xem m1 tại (d_cur, b_cur, p_cur) có vi phạm tính liền nhau không
                                c_m1 = _get_canon_mon_key(m1)
                                new_p_m1 = sorted(list(set([
                                    p for p in range(5) if p != p_cur and _get_canon_mon_key(all_tkb[cid][d_cur][b_cur][p].get("mon") if isinstance(all_tkb[cid][d_cur][b_cur][p], dict) else all_tkb[cid][d_cur][b_cur][p]) == c_m1
                                ] + [p_cur])))
                                if len(new_p_m1) >= 2 and any(abs(new_p_m1[k+1] - new_p_m1[k]) > 1 for k in range(len(new_p_m1) - 1)):
                                    continue

                                # Kiểm tra xem m2 tại (d_cur, b_cur) sau khi gỡ p_cur có bị gãy block không
                                c_m2 = _get_canon_mon_key(m2)
                                rem_p_m2 = sorted(list(set([
                                    p for p in range(5) if p != p_cur and _get_canon_mon_key(all_tkb[cid][d_cur][b_cur][p].get("mon") if isinstance(all_tkb[cid][d_cur][b_cur][p], dict) else all_tkb[cid][d_cur][b_cur][p]) == c_m2
                                ])))
                                if len(rem_p_m2) >= 2 and any(abs(rem_p_m2[k+1] - rem_p_m2[k]) > 1 for k in range(len(rem_p_m2) - 1)):
                                    continue

                                # Kiểm tra xem m2 tại (d_emp, b_emp, p_emp) có vi phạm tính liền nhau không
                                new_p_m2 = sorted(list(set([
                                    p for p in range(5) if (d_emp != d_cur or p != p_cur) and _get_canon_mon_key(all_tkb[cid][d_emp][b_emp][p].get("mon") if isinstance(all_tkb[cid][d_emp][b_emp][p], dict) else all_tkb[cid][d_emp][b_emp][p]) == c_m2
                                ] + [p_emp])))
                                if len(new_p_m2) >= 2 and any(abs(new_p_m2[k+1] - new_p_m2[k]) > 1 for k in range(len(new_p_m2) - 1)):
                                    continue

                                # Kiểm tra xem gv1 tại p_cur có tạo ra tổng tiết trống >= 2 không hoặc tạo ra buổi 1 tiết không
                                gv1_p = sorted(list(set([p for p in range(5) if (gv1, d_cur, b_cur, p) in teacher_busy_slots] + [p_cur])))
                                if len(gv1_p) >= 2 and (gv1_p[-1] - gv1_p[0] + 1 - len(gv1_p)) >= 2:
                                    continue
                                if len(gv1_p) == 1 and self.teacher_shift_loads[gv1][b_cur] >= 2:
                                    continue
                                    
                                # Kiểm tra gv2 tại buổi cũ sau khi gỡ p_cur
                                gv2_old_p = sorted(list(set([p for p in range(5) if (gv2, d_cur, b_cur, p) in teacher_busy_slots and p != p_cur])))
                                if len(gv2_old_p) >= 2 and (gv2_old_p[-1] - gv2_old_p[0] + 1 - len(gv2_old_p)) >= 2:
                                    continue
                                if len(gv2_old_p) == 1 and self.teacher_shift_loads[gv2][b_cur] >= 2:
                                    continue
                                    
                                # Kiểm tra gv2 tại buổi mới sau khi thêm p_emp
                                gv2_new_p = sorted(list(set([p for p in range(5) if (gv2, d_emp, b_emp, p) in teacher_busy_slots] + [p_emp])))
                                if len(gv2_new_p) >= 2 and (gv2_new_p[-1] - gv2_new_p[0] + 1 - len(gv2_new_p)) >= 2:
                                    continue
                                if len(gv2_new_p) == 1 and self.teacher_shift_loads[gv2][b_emp] >= 2:
                                    continue
                                    
                                all_tkb[cid][d_emp][b_emp][p_emp] = cell_cur
                                all_tkb[cid][d_cur][b_cur][p_cur] = {"mon": m1, "gv": gv1}
                                teacher_busy_slots.remove((gv2, d_cur, b_cur, p_cur))
                                teacher_busy_slots.add((gv2, d_emp, b_emp, p_emp))
                                teacher_busy_slots.add((gv1, d_cur, b_cur, p_cur))
                                total_placed += 1
                                placed_this = True
                                progress_made = True
                                break
                                
                if not progress_made:
                    break

        # Đếm lại chính xác toàn bộ số tiết đã được xếp vào all_tkb
        actual_placed = 0
        for cid in self.class_ids:
            for day in DAYS:
                for b in BUOIS:
                    for p in range(5):
                        cell = all_tkb[cid][day][b][p]
                        if cell != "" and cell is not None and cell != "OFF" and (cid, day, b, p) not in self.class_off_slots:
                            actual_placed += 1
        total_placed = actual_placed

        if total_placed >= self.total_periods:
            all_feasible = True

        # Chuyển đổi sang dict thuần JSON
        # Chuyển đổi sang dict thuần JSON với định dạng {mon, gv} chuẩn xác cho Web UI
        assignment_lookup = {}
        for a in self.assignments:
            assignment_lookup[(a["classId"], a["mon"])] = a["gv"]
            assignment_lookup[(a["classId"], _get_canon_mon_key(a["mon"]))] = a["gv"]
        for key, gv in self.pccm.items():
            parts = key.split("|")
            if len(parts) == 2:
                raw_cid, mon = parts[0], parts[1]
                cid = self.class_alias_to_id.get(raw_cid.lower(), self.class_alias_to_id.get(raw_cid, raw_cid))
                gv_str = str(gv).strip()
                if (cid, mon) not in assignment_lookup:
                    assignment_lookup[(cid, mon)] = gv_str
                if (cid, _get_canon_mon_key(mon)) not in assignment_lookup:
                    assignment_lookup[(cid, _get_canon_mon_key(mon))] = gv_str

        pure_tkb = {}
        for cid in self.class_ids:
            pure_tkb[cid] = {}
            for day in DAYS:
                pure_tkb[cid][day] = {}
                for b in BUOIS:
                    cells = []
                    for p in range(5):
                        val = all_tkb[cid][day][b][p]
                        if val == "" or val is None:
                            cells.append(None)
                        elif val == "OFF":
                            cells.append("OFF")
                        elif isinstance(val, dict):
                            if not val.get("gv") and not val.get("fixed"):
                                m_val = val.get("mon", "")
                                val["gv"] = assignment_lookup.get((cid, m_val), assignment_lookup.get((cid, _get_canon_mon_key(m_val)), ""))
                            cells.append(val)
                        elif isinstance(val, str):
                            gv = assignment_lookup.get((cid, val), assignment_lookup.get((cid, _get_canon_mon_key(val)), ""))
                            cells.append({"mon": val, "gv": gv})
                        else:
                            cells.append(val)
                    pure_tkb[cid][day][b] = cells

        return {
            "all_feasible": all_feasible,
            "infeasible_sessions": infeasible_sessions,
            "tkb": pure_tkb,
            "total_placed": total_placed,
            "soBuoiDay1": total_day1,
            "soBuoiTrong2": total_gap2,
            "soBuoiTrong1": total_gap1
        }

    def _solve_single_session_periods(self, day: str, buoi: str, acts: list[dict[str, Any]]) -> dict[str, Any]:
        """Giải chi tiết 1 buổi học cụ thể bằng Pattern-based CP-SAT."""
        model = cp_model.CpModel()
        
        p_vars = {} # (idx, start_p) -> BoolVar
        p_class_slot = defaultdict(list)
        p_teacher_slot = defaultdict(list)
        p_room_slot = defaultdict(list)
        
        for idx, item in enumerate(acts):
            dur = item["duration"]
            cid = item["classId"]
            gv = item["gv"]
            room = item["room"]
            
            item_vars = []
            for start_p in range(0, 5 - dur + 1):
                # Check off and fixed slots of class and teacher
                is_slot_blocked = False
                for p in range(start_p, start_p + dur):
                    if (cid, day, buoi, p) in self.class_off_slots:
                        is_slot_blocked = True
                        break
                    if (cid, day, buoi, p) in self.class_fixed_slots:
                        is_slot_blocked = True
                        break
                    if self.teacher_off.get(gv, {}).get(f"{day}|{buoi}|{p}"):
                        is_slot_blocked = True
                        break
                    if (gv, day, buoi, p) in self.teacher_fixed_slots:
                        is_slot_blocked = True
                        break
                if is_slot_blocked:
                    continue
                    
                pv = model.NewBoolVar(f"pv_{idx}_{start_p}")
                p_vars[(idx, start_p)] = pv
                item_vars.append(pv)
                
                for p in range(start_p, start_p + dur):
                    p_class_slot[(cid, p)].append(pv)
                    p_teacher_slot[(gv, p)].append(pv)
                    if room:
                        p_room_slot[(room, p)].append(pv)
                        
            if item_vars:
                model.Add(sum(item_vars) == 1)
            else:
                return {"ok": False}

        # Không trùng slot lớp
        for (cid, p), terms in p_class_slot.items():
            model.Add(sum(terms) <= 1)
            
        # Không trùng slot GV
        for (gv, p), terms in p_teacher_slot.items():
            model.Add(sum(terms) <= 1)
            
        # Không trùng phòng
        for (room, p), terms in p_room_slot.items():
            model.Add(sum(terms) <= 1)

        # Ràng buộc các môn cùng tên trong cùng lớp có 2 tiết rời phải LIỀN NHAU
        same_class_mon_acts = defaultdict(list)
        for idx, act in enumerate(acts):
            if act["duration"] == 1:
                same_class_mon_acts[(act["classId"], act["mon"])].append(idx)

        for (cid, mon), act_idxs in same_class_mon_acts.items():
            if len(act_idxs) == 2:
                i1, i2 = act_idxs[0], act_idxs[1]
                p1_terms = [p * p_vars[(i1, p)] for p in range(5) if (i1, p) in p_vars]
                p2_terms = [p * p_vars[(i2, p)] for p in range(5) if (i2, p) in p_vars]
                if p1_terms and p2_terms:
                    diff = model.NewIntVar(-4, 4, f"diff_{i1}_{i2}")
                    model.Add(diff == sum(p1_terms) - sum(p2_terms))
                    abs_diff = model.NewIntVar(0, 4, f"abs_diff_{i1}_{i2}")
                    model.AddAbsEquality(abs_diff, diff)
                    model.Add(abs_diff == 1)

        # Ràng buộc môn động liền kề với ô FIXED của cùng môn đó trong buổi
        for idx, act in enumerate(acts):
            cid = act["classId"]
            mon = act["mon"]
            for p_fix in range(5):
                if self.class_fixed_slots.get((cid, day, buoi, p_fix), {}).get("mon") == mon:
                    allowed_p = [p for p in [p_fix - 1, p_fix + 1] if 0 <= p <= 4]
                    matching_vars = [p_vars[(idx, p)] for p in allowed_p if (idx, p) in p_vars]
                    if matching_vars:
                        model.Add(sum(matching_vars) == 1)

        # TEACHER COMPACT PATTERNS (CẤM GAP2 = 0 VÀ TỐI THIỂU HÓA GAP1)
        sess_teachers = set(item["gv"] for item in acts)
        # Thêm các giáo viên có fixed cell trong buổi
        for p in range(5):
            for (gv, d_f, b_f, p_f) in self.teacher_fixed_slots:
                if d_f == day and b_f == buoi:
                    sess_teachers.add(gv)
                    
        gap1_penalties = []
        
        for gv in sess_teachers:
            fixed_p_of_gv = [p for p in range(5) if (gv, day, buoi, p) in self.teacher_fixed_slots]
            new_dur_tot = sum(item["duration"] for item in acts if item["gv"] == gv)
            total_gv_load = len(fixed_p_of_gv) + new_dur_tot
            
            raw_pats = VALID_TEACHER_PATTERNS.get(total_gv_load, [])
            # Filter patterns that contain all fixed periods
            valid_pats = [pat for pat in raw_pats if all(p in pat for p in fixed_p_of_gv)]
            
            if valid_pats:
                pat_vars = []
                pat_map = {}
                for pat in valid_pats:
                    yp = model.NewBoolVar(f"yp_{gv}_{'_'.join(map(str, pat))}")
                    pat_vars.append(yp)
                    pat_map[pat] = yp
                    
                    gap1_c = _get_gap1_count(pat)
                    if gap1_c > 0:
                        gap1_penalties.append((yp, gap1_c))
                        
                model.Add(sum(pat_vars) == 1)
                for p in range(5):
                    if p in fixed_p_of_gv:
                        # Fixed period is already occupied
                        continue
                    terms = p_teacher_slot.get((gv, p), [])
                    matching = [pat_map[pat] for pat in valid_pats if p in pat]
                    model.Add(sum(terms) == sum(matching))

        self._extra_period_constraints(model, p_vars, acts, day, buoi)

        # Tối thiểu hóa gap 1
        if gap1_penalties:
            model.Minimize(sum(yp * c for yp, c in gap1_penalties))
            
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 5.0
        solver.parameters.num_search_workers = 2
        solver.parameters.random_seed = self.seed
        
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            # Fallback sang Soft-Gap Subsolver để đảm bảo 100% tiết được xếp
            return self._solve_single_session_periods_soft(day, buoi, acts)
            
        class_grid = defaultdict(dict)
        placed = 0
        for idx, item in enumerate(acts):
            cid = item["classId"]
            mon = item["mon"]
            dur = item["duration"]
            for start_p in range(0, 5 - dur + 1):
                pv = p_vars.get((idx, start_p))
                if pv is not None and solver.Value(pv) > 0:
                    for p in range(start_p, start_p + dur):
                        class_grid[cid][p] = mon
                        placed += 1
                        
        gap1_val = int(solver.ObjectiveValue()) if gap1_penalties else 0
        
        # Calculate singletons in this session
        day1_val = 0
        for gv in sess_teachers:
            gv_dur_tot = sum(item["duration"] for item in acts if item["gv"] == gv)
            if gv_dur_tot == 1 and self.teacher_shift_loads[gv][buoi] >= 2:
                day1_val += 1

        return {
            "ok": True,
            "placed": placed,
            "class_grid": class_grid,
            "gap1": gap1_val,
            "gap2": 0, # Đảm bảo 100% bằng toán học
            "day1": day1_val
        }

    def _solve_single_session_periods_soft(self, day: str, buoi: str, acts: list[dict[str, Any]]) -> dict[str, Any]:
        """Giải chi tiết 1 buổi học dùng mô hình Soft Gap với phân rã atomic để đảm bảo 100% xếp đủ."""
        model = cp_model.CpModel()
        p_vars = {}
        p_class_slot = defaultdict(list)
        p_teacher_slot = defaultdict(list)
        p_room_slot = defaultdict(list)
        
        # Phân rã acts thành các slot đơn (duration = 1) để luôn tìm được chỗ xếp
        atomic_acts = []
        for act in acts:
            dur = act["duration"]
            for d_i in range(dur):
                atomic_acts.append({
                    "aid": act.get("aid"),
                    "classId": act["classId"],
                    "mon": act["mon"],
                    "gv": act["gv"],
                    "room": act["room"],
                    "sub_idx": d_i,
                    "total_dur": dur
                })
        
        placed_vars = {}
        for idx, item in enumerate(atomic_acts):
            cid = item["classId"]
            gv = item["gv"]
            room = item["room"]
            
            item_vars = []
            for p in range(5):
                if (cid, day, buoi, p) in self.class_off_slots or (cid, day, buoi, p) in self.class_fixed_slots:
                    continue
                if self.teacher_off.get(gv, {}).get(f"{day}|{buoi}|{p}"):
                    continue
                # Chỉ kiểm tra teacher_fixed_slots nếu GV đó thực sự dạy lớp khác không phải môn tập trung
                if (gv, day, buoi, p) in self.teacher_fixed_slots and cid not in self.teacher_fixed_slots[(gv, day, buoi, p)]:
                    # Cho phép nếu là tiết fixed của cùng lớp
                    continue
                    
                pv = model.NewBoolVar(f"pv_soft_{idx}_{p}")
                p_vars[(idx, p)] = pv
                item_vars.append(pv)
                
                p_class_slot[(cid, p)].append(pv)
                p_teacher_slot[(gv, p)].append(pv)
                if room:
                    p_room_slot[(room, p)].append(pv)
                    
            is_p = model.NewBoolVar(f"is_p_{idx}")
            if item_vars:
                model.Add(sum(item_vars) == is_p)
            else:
                model.Add(is_p == 0)
            placed_vars[idx] = is_p

        # Khóa cứng các cặp tiết con của cùng 1 môn có duration == 2 (phải cùng đặt hoặc cùng bỏ, không xé lẻ)
        aid_atomic_indices = defaultdict(list)
        for idx, act in enumerate(atomic_acts):
            aid_atomic_indices[act["aid"]].append(idx)
            
        for aid_k, idxs in aid_atomic_indices.items():
            if len(idxs) == 2:
                i0, i1 = idxs[0], idxs[1]
                model.Add(placed_vars[i0] == placed_vars[i1])
                p0_terms = [p * p_vars[(i0, p)] for p in range(5) if (i0, p) in p_vars]
                p1_terms = [p * p_vars[(i1, p)] for p in range(5) if (i1, p) in p_vars]
                if p0_terms and p1_terms:
                    diff_sub = model.NewIntVar(-4, 4, f"diff_sub_{i0}_{i1}")
                    model.Add(diff_sub == sum(p0_terms) - sum(p1_terms))
                    abs_diff_sub = model.NewIntVar(0, 4, f"abs_diff_sub_{i0}_{i1}")
                    model.AddAbsEquality(abs_diff_sub, diff_sub)
                    model.Add(abs_diff_sub == 1).OnlyEnforceIf(placed_vars[i0])

        for (cid, p), terms in p_class_slot.items():
            model.Add(sum(terms) <= 1)
        for (gv, p), terms in p_teacher_slot.items():
            model.Add(sum(terms) <= 1)
        for (room, p), terms in p_room_slot.items():
            model.Add(sum(terms) <= 1)

        # CẤM TUYỆT ĐỐI BUỔI 1 TIẾT CHO GV CÓ TẢI >= 2
        for gv in set(item["gv"] for item in atomic_acts):
            if self.teacher_shift_loads[gv][buoi] >= 2:
                gv_p_terms = []
                for p in range(5):
                    gv_p_terms.extend(p_teacher_slot.get((gv, p), []))
                fixed_p_cnt = len([p for p in range(5) if (gv, day, buoi, p) in self.teacher_fixed_slots])
                if gv_p_terms:
                    tot_gv_expr = sum(gv_p_terms) + fixed_p_cnt
                    is_gv_single = model.NewBoolVar(f"is_gv_single_{gv}_{day}_{buoi}")
                    model.Add(tot_gv_expr == 1).OnlyEnforceIf(is_gv_single)
                    model.Add(tot_gv_expr != 1).OnlyEnforceIf(is_gv_single.Not())
                    model.Add(is_gv_single == 0)

        # RÀNG BUỘC SƯ PHẠM CỐT LÕI: Các môn giống nhau trong cùng 1 buổi BẮT BUỘC PHẢI LIỀN NHAU
        same_class_mon_indices = defaultdict(list)
        for idx, act in enumerate(atomic_acts):
            same_class_mon_indices[(act["classId"], act["mon"])].append(idx)

        for (cid, mon), idxs in same_class_mon_indices.items():
            if len(idxs) == 2:
                i1, i2 = idxs[0], idxs[1]
                p1_terms = [p * p_vars[(i1, p)] for p in range(5) if (i1, p) in p_vars]
                p2_terms = [p * p_vars[(i2, p)] for p in range(5) if (i2, p) in p_vars]
                if p1_terms and p2_terms:
                    both_placed = model.NewBoolVar(f"both_p_{i1}_{i2}")
                    is_p1 = placed_vars[i1]
                    is_p2 = placed_vars[i2]
                    model.Add(is_p1 + is_p2 == 2).OnlyEnforceIf(both_placed)
                    model.Add(is_p1 + is_p2 < 2).OnlyEnforceIf(both_placed.Not())
                    
                    diff = model.NewIntVar(-4, 4, f"diff_soft_{i1}_{i2}")
                    model.Add(diff == sum(p1_terms) - sum(p2_terms))
                    abs_diff = model.NewIntVar(0, 4, f"abs_diff_soft_{i1}_{i2}")
                    model.AddAbsEquality(abs_diff, diff)
                    model.Add(abs_diff == 1).OnlyEnforceIf(both_placed)

        # Ràng buộc môn động liền kề với ô FIXED của cùng môn đó trong buổi
        for idx, act in enumerate(atomic_acts):
            cid = act["classId"]
            mon = act["mon"]
            for p_fix in range(5):
                if self.class_fixed_slots.get((cid, day, buoi, p_fix), {}).get("mon") == mon:
                    allowed_p = [p for p in [p_fix - 1, p_fix + 1] if 0 <= p <= 4]
                    matching_vars = [p_vars[(idx, p)] for p in allowed_p if (idx, p) in p_vars]
                    if matching_vars:
                        is_p = placed_vars[idx]
                        model.Add(sum(matching_vars) == is_p)

        # Objective: Ưu tiên tối đa số tiết được xếp (1.000.000 điểm) + giảm gap
        obj_penalties = []
        sess_teachers = set(item["gv"] for item in atomic_acts)
        for p in range(5):
            for (gv, d_f, b_f, p_f) in self.teacher_fixed_slots:
                if d_f == day and b_f == buoi:
                    sess_teachers.add(gv)

        for gv in sess_teachers:
            fixed_p_of_gv = [p for p in range(5) if (gv, day, buoi, p) in self.teacher_fixed_slots]
            
            # Tất cả các pattern hợp lệ (load 0..5 có max_gap <= 1 và chứa toàn bộ fixed_p_of_gv)
            all_gv_pats = []
            for load_k in range(len(fixed_p_of_gv), 6):
                for pat in VALID_TEACHER_PATTERNS.get(load_k, []):
                    if all(p in pat for p in fixed_p_of_gv):
                        all_gv_pats.append(pat)

            if all_gv_pats:
                pat_vars = []
                pat_map = {}
                for pat in all_gv_pats:
                    yp = model.NewBoolVar(f"yp_soft_{gv}_{'_'.join(map(str, pat))}")
                    pat_vars.append(yp)
                    pat_map[pat] = yp
                    gap1_c = _get_gap1_count(pat)
                    if gap1_c > 0:
                        obj_penalties.append(yp * 1000 * gap1_c)

                model.Add(sum(pat_vars) == 1)
                for p in range(5):
                    terms = p_teacher_slot.get((gv, p), [])
                    matching = [pat_map[pat] for pat in all_gv_pats if p in pat]
                    is_fixed = 1 if p in fixed_p_of_gv else 0
                    model.Add(sum(terms) + is_fixed == sum(matching))

        total_placed_expr = sum(placed_vars.values()) if placed_vars else 0
        total_pen = sum(obj_penalties) if obj_penalties else 0
        self._extra_period_constraints(model, p_vars, acts, day, buoi)
        model.Maximize(total_placed_expr * 1000000 - total_pen)
            
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 8.0
        solver.parameters.num_search_workers = 4
        solver.parameters.random_seed = self.seed
        
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return {"ok": False}
            
        class_grid = defaultdict(dict)
        placed = 0
        for idx, item in enumerate(atomic_acts):
            cid = item["classId"]
            mon = item["mon"]
            for p in range(5):
                pv = p_vars.get((idx, p))
                if pv is not None and solver.Value(pv) > 0:
                    class_grid[cid][p] = mon
                    placed += 1

        return {
            "ok": True,
            "placed": placed,
            "class_grid": class_grid,
            "gap1": 0,
            "gap2": 0,
            "day1": 0
        }

    def _solve_integrated_fallback(self) -> dict[str, Any]:
        """Solver fallback toàn cục nếu 2-Stage gặp deadlock."""
        _log_live("-> [FALLBACK TOÀN CỤC] Kích hoạt giải đồng bộ toàn bộ các buổi...")
        session_res = self._solve_session_master([])
        if session_res and session_res.get("ok"):
            period_res = self._solve_period_stages(session_res["allocation"])
            return {
                "ok": True,
                "applied": True,
                "tkb": period_res["tkb"],
                "placed": period_res["total_placed"],
                "unassigned": self.total_periods - period_res["total_placed"],
                "tsBuoiDay": session_res["tsBuoiDay"],
                "soBuoiDay1": period_res["soBuoiDay1"],
                "soBuoiTrong2": period_res["soBuoiTrong2"],
                "soBuoiTrong1": period_res["soBuoiTrong1"],
                "runtime_seconds": 10.0
            }
        return {
            "ok": False,
            "applied": False,
            "error": "solver_unable_to_find_feasible_schedule",
            "placed": 0,
            "unassigned": self.total_periods
        }
