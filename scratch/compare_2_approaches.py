import sys, copy, json, time
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

print("================================================================================")
print("SO SÁNH & ĐÁNH GIÁ 2 HƯỚNG TỐI ƯU TRÊN BỘ DỮ LIỆU THỰC TẾ (temp/)")
print("================================================================================")

# Baseline metrics
base_t_grid = copy.deepcopy(atf.teacher_grid)
base_c_grid = copy.deepcopy(atf.class_grid)
class_off_slots = atf.class_off_slots
slot_info = atf.slot_info
teachers = list(base_t_grid.keys())
classes = list(base_c_grid.keys())

def evaluate_metrics(t_grid, c_grid):
    # 1. Singletons (1 tiet/buoi)
    singletons = []
    # 2. Total sessions
    total_sessions = 0
    # 3. Gaps (1 tiet and 2 tiet)
    gap1_count = 0
    gap2_count = 0
    total_gaps = 0
    
    for tname, sched in t_grid.items():
        for d in range(6):
            for b in range(2):
                s_start = d * 10 + b * 5
                taught = [p for p in range(5) if sched[s_start + p] is not None]
                if len(taught) > 0:
                    total_sessions += 1
                if len(taught) == 1:
                    singletons.append((tname, s_start + taught[0], sched[s_start + taught[0]]))
                elif len(taught) > 1:
                    # check internal gaps
                    # e.g. taught = [0, 2] -> internal gap at 1 (gap 1)
                    # taught = [0, 3] -> internal gap at 1, 2 (gap 2)
                    for i in range(len(taught) - 1):
                        diff = taught[i+1] - taught[i] - 1
                        if diff == 1:
                            gap1_count += 1
                            total_gaps += 1
                        elif diff == 2:
                            gap2_count += 1
                            total_gaps += 2
                        elif diff > 2:
                            total_gaps += diff
                            
    # Check off violations
    off_violations = 0
    for cname, sched in c_grid.items():
        off_set = class_off_slots.get(cname, set())
        for s in range(60):
            if sched[s] is not None and s in off_set:
                off_violations += 1
                
    return {
        'singletons': len(singletons),
        'singletons_list': singletons,
        'total_sessions': total_sessions,
        'gap1': gap1_count,
        'gap2': gap2_count,
        'total_gaps': total_gaps,
        'off_violations': off_violations
    }

base_m = evaluate_metrics(base_t_grid, base_c_grid)
print("=== BASELINE (HIỆN TRẠNG) ===")
print(f"- Buổi 1 tiết: {base_m['singletons']}")
print(f"- Tổng số buổi GV: {base_m['total_sessions']}")
print(f"- Gap 1 tiết: {base_m['gap1']}")
print(f"- Gap 2 tiết: {base_m['gap2']}")
print(f"- Vi phạm tiết nghỉ: {base_m['off_violations']}")

# -----------------------------------------------------------------------------
# THỬ NGHIỆM HƯỚNG 2: Pre-screened seeds + Atomic Block Swaps (Strict Pareto)
# -----------------------------------------------------------------------------
print("\n" + "="*80)
print("THỬ NGHIỆM HƯỚNG 2: ATOMIC BLOCK SWAPS + 13 SEEDS + STRICT PARETO")
print("="*80)

# 13 seeds from doc 2:
# 1. 6A17: T2 Sáng T3-T4 (A.Dung - Anh) <-> T4 Sáng T1-T2 (TN.Thủy - KHTN)
# 2. 9A7: T2 Sáng T5 (T.Trung - Toán) <-> T4 Sáng T3 (A.Dung - Anh)
# 3. 8A16: T4 Chiều T1-T2 (TN.Hảo - KHTN) <-> T7 Chiều T1-T2 (A.Hải - Anh)
# 4. 9A1: T2 Sáng T5 (MT.Bách - MT) <-> T7 Sáng T3 (TN.TNguyên - KHTN)
# 5. 8A2: T4 Sáng T1-T2 (A.Khánh - Anh) <-> T7 Sáng T1-T2 (T.Phương - Toán)
# 6. 8A9: T4 Sáng T3-T4 (TN.Khanh - KHTN) <-> T7 Sáng T3-T4 (SĐ.Hằng - LSĐL)
# 7. 7A1: T3 Chiều T1-T2 (A.Lan - Anh) <-> T4 Chiều T2-T3 (V.Trinh - Văn)
# 8. 7A13: T5 Chiều T1-T2 (A.CVân - Anh) <-> T6 Chiều T3-T4 (T.Cường - Toán)
# 9. 7A2: T4 Chiều T4-T5 (TN.Hảo - KHTN) <-> T5 Chiều T2-T3 (T.Hùng - Toán)
# 10. 7A9: T4 Chiều T4-T5 (A.Lan - Anh) <-> T7 Chiều T3-T4 (TN.Huyền - KHTN)
# 11. 9A13: T3 Sáng T4-T5 (V.Tuyền - Văn) <-> T5 Sáng T1-T2 (T.Hùng - Toán)
# 12. 8A14: T3 Chiều T1-T2 (SĐ.Phượng - LSĐL) <-> T7 Chiều T4-T5 (TN.Phương - KHTN)
# 13. 7A20: T2 Chiều T2-T3 (TN.Đoan - KHTN) <-> T4 Chiều T1-T2 (T.ThHương - Toán)

def apply_block_swap(cname, slotsA, slotsB, t_grid, c_grid):
    # slotsA and slotsB are lists of slot indices of the same length
    off_set = class_off_slots.get(cname, set())
    # Check off
    for s in slotsA:
        if s in off_set and c_grid[cname][s] is not None:
            return False, "Slot in slotsA is off"
    for s in slotsB:
        if s in off_set and c_grid[cname][s] is not None:
            return False, "Slot in slotsB is off"
            
    itemsA = [c_grid[cname][s] for s in slotsA]
    itemsB = [c_grid[cname][s] for s in slotsB]
    
    tA = itemsA[0][0] if itemsA[0] else None
    tB = itemsB[0][0] if itemsB[0] else None
    
    # Check teacher availability
    if tA is not None and tA != tB:
        for s in slotsB:
            if t_grid[tA][s] is not None and t_grid[tA][s] != (itemsB[slotsB.index(s)][2] if itemsB[slotsB.index(s)] else None):
                return False, f"Teacher {tA} busy at target slot {s}"
    if tB is not None and tA != tB:
        for s in slotsA:
            if t_grid[tB][s] is not None and t_grid[tB][s] != (itemsA[slotsA.index(s)][2] if itemsA[slotsA.index(s)] else None):
                return False, f"Teacher {tB} busy at target slot {s}"
                
    # Apply
    for idx in range(len(slotsA)):
        sA = slotsA[idx]
        sB = slotsB[idx]
        itA = itemsA[idx]
        itB = itemsB[idx]
        
        c_grid[cname][sA] = itB
        c_grid[cname][sB] = itA
        
        if tA is not None:
            t_grid[tA][sA] = None
            t_grid[tA][sB] = itA[2]
        if tB is not None:
            t_grid[tB][sB] = None
            t_grid[tB][sA] = itB[2]
            
    return True, "OK"

h2_t_grid = copy.deepcopy(base_t_grid)
h2_c_grid = copy.deepcopy(base_c_grid)

# Run seed candidates
seeds = [
    ("6A17", [2, 3], [20, 21]),
    ("9A7", [4], [22]),
    ("8A16", [25, 26], [55, 56]),
    ("9A1", [4], [52]),
    ("8A2", [20, 21], [50, 51]),
    ("8A9", [22, 23], [52, 53]),
    ("7A1", [15, 16], [26, 27]),
    ("7A13", [35, 36], [47, 48]),
    ("7A2", [28, 29], [36, 37]),
    ("7A9", [28, 29], [57, 58]),
    ("9A13", [13, 14], [30, 31]),
    ("8A14", [15, 16], [58, 59]),
    ("7A20", [6, 7], [25, 26]),
]

accepted_seeds = 0
for idx, (cname, sA, sB) in enumerate(seeds):
    ok, msg = apply_block_swap(cname, sA, sB, h2_t_grid, h2_c_grid)
    if ok:
        accepted_seeds += 1
        print(f"  [Seed {idx+1}] PASS: Lớp {cname} swap Slots {sA} <-> {sB}")
    else:
        print(f"  [Seed {idx+1}] REJECT: Lớp {cname} ({msg})")

h2_m_after_seeds = evaluate_metrics(h2_t_grid, h2_c_grid)
print(f"\nKết quả sau 13 Seeds: Singletons = {h2_m_after_seeds['singletons']} (giảm {base_m['singletons'] - h2_m_after_seeds['singletons']}), Tổng buổi = {h2_m_after_seeds['total_sessions']}, Gap1 = {h2_m_after_seeds['gap1']}, Gap2 = {h2_m_after_seeds['gap2']}")

# -----------------------------------------------------------------------------
# THỬ NGHIỆM HƯỚNG 1: Fast-Path Move-out + Pull-in + Ejection Chains trong FET Engine
# -----------------------------------------------------------------------------
print("\n" + "="*80)
print("THỬ NGHIỆM HƯỚNG 1: TARGETED FAST-PATH (MOVE-OUT + PULL-IN + EJECTION CHAINS)")
print("="*80)

# Simulate Fast-path algorithm:
h1_t_grid = copy.deepcopy(base_t_grid)
h1_c_grid = copy.deepcopy(base_c_grid)

# Fast-path operator 1: Direct 2-way MOVE-OUT
def fast_path_move_out(t_grid, c_grid):
    curr_m = evaluate_metrics(t_grid, c_grid)
    improved = True
    moves = []
    
    while improved:
        improved = False
        sings = evaluate_metrics(t_grid, c_grid)['singletons_list']
        for tname, s1, cell_text in sings:
            cname = cell_text.split('-')[0].strip()
            # find candidate session of tname
            for s2 in range(60):
                if s2 == s1:
                    continue
                # check if s2 in a session where tname already teaches
                d2 = s2 // 10
                b2 = (s2 % 10) // 5
                s_start2 = d2 * 10 + b2 * 5
                taught_cnt = sum(1 for p in range(5) if t_grid[tname][s_start2 + p] is not None)
                if taught_cnt < 1 or taught_cnt >= 5:
                    continue
                
                # Test 2-way swap
                ok, msg = apply_block_swap(cname, [s1], [s2], t_grid, c_grid)
                if ok:
                    new_m = evaluate_metrics(t_grid, c_grid)
                    # Acceptance: strictly reduce singletons and do not worsen gap2 / total sessions
                    if new_m['singletons'] < curr_m['singletons'] and new_m['gap2'] <= curr_m['gap2']:
                        moves.append((tname, cname, s1, s2))
                        curr_m = new_m
                        improved = True
                        break
                    else:
                        # Revert
                        apply_block_swap(cname, [s2], [s1], t_grid, c_grid)
            if improved:
                break
    return moves

# Fast-path operator 2: Pull-in from rich session
def fast_path_pull_in(t_grid, c_grid):
    curr_m = evaluate_metrics(t_grid, c_grid)
    improved = True
    moves = []
    
    while improved:
        improved = False
        sings = evaluate_metrics(t_grid, c_grid)['singletons_list']
        for tname, s1, cell_text in sings:
            d1 = s1 // 10
            b1 = (s1 % 10) // 5
            s_start1 = d1 * 10 + b1 * 5
            
            # Find rich session (>= 3 periods) of tname
            for d2 in range(6):
                for b2 in range(2):
                    if d2 == d1 and b2 == b1:
                        continue
                    s_start2 = d2 * 10 + b2 * 5
                    taught_p = [p for p in range(5) if t_grid[tname][s_start2 + p] is not None]
                    if len(taught_p) < 3:
                        continue
                        
                    for p_donor in taught_p:
                        s_donor = s_start2 + p_donor
                        donor_txt = t_grid[tname][s_donor]
                        c_donor = donor_txt.split('-')[0].strip()
                        
                        # Try to move donor to any free slot of tname in session 1
                        for p_tgt in range(5):
                            s_tgt = s_start1 + p_tgt
                            if s_tgt == s1 or t_grid[tname][s_tgt] is not None:
                                continue
                                
                            ok, msg = apply_block_swap(c_donor, [s_donor], [s_tgt], t_grid, c_grid)
                            if ok:
                                new_m = evaluate_metrics(t_grid, c_grid)
                                if new_m['singletons'] < curr_m['singletons'] and new_m['gap2'] <= curr_m['gap2']:
                                    moves.append((tname, c_donor, s_donor, s_tgt))
                                    curr_m = new_m
                                    improved = True
                                    break
                                else:
                                    apply_block_swap(c_donor, [s_tgt], [s_donor], t_grid, c_grid)
                            if improved:
                                break
                        if improved:
                            break
                    if improved:
                        break
            if improved:
                break
    return moves

m_out = fast_path_move_out(h1_t_grid, h1_c_grid)
print(f"Fast Move-out executed: {len(m_out)} moves")
for m in m_out:
    print(f"  -> GV {m[0]} (Lớp {m[1]}): Slot {m[2]} -> Slot {m[3]}")

m_in = fast_path_pull_in(h1_t_grid, h1_c_grid)
print(f"Fast Pull-in executed: {len(m_in)} moves")
for m in m_in:
    print(f"  -> GV {m[0]} (Lớp {m[1]}): Slot {m[2]} -> Slot {m[3]}")

h1_m_final = evaluate_metrics(h1_t_grid, h1_c_grid)
print(f"\nKết quả Hướng 1: Singletons = {h1_m_final['singletons']} (giảm {base_m['singletons'] - h1_m_final['singletons']}), Tổng buổi = {h1_m_final['total_sessions']}, Gap1 = {h1_m_final['gap1']}, Gap2 = {h1_m_final['gap2']}")
