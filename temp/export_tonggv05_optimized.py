import sys
import os
import openpyxl
import copy
from parse_md_schedule import parse_tonggv_file, analyze_all_gaps
from analyze_session_loads import analyze_session_loads
from solve_stuck_cases import solve_5_stuck_cases

sys.stdout.reconfigure(encoding='utf-8')

def run_tonggv05_full_optimization():
    src_file = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    out_file = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026_TOI_UU_2_TIET_TRONG.xlsx"
    
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(src_file)
    days = ["2", "3", "4", "5", "6", "7"]
    sessions = ["Sáng", "Chiều"]
    
    def count_span_holes():
        total_holes_ge2 = 0
        stuck_list = []
        for t in teachers.values():
            for d in days:
                for s in sessions:
                    teaching = []
                    for p in range(1, 6):
                        v = gv_grid.get((t, d, s, str(p)), "")
                        if v != "": teaching.append((p, v))
                    if len(teaching) >= 2:
                        ps = [item[0] for item in teaching]
                        holes = (ps[-1] - ps[0] + 1) - len(ps)
                        if holes >= 2:
                            total_holes_ge2 += 1
                            stuck_list.append((t, d, s, holes, teaching))
        return total_holes_ge2, stuck_list

    def try_moves(moves):
        saved_lop = {}
        saved_gv = {}
        for (cls, d, s, p), _ in moves:
            p_str = str(p)
            saved_lop[(cls, d, s, p_str)] = lop_grid.get((cls, d, s, p_str))
            old = lop_grid.get((cls, d, s, p_str))
            if old:
                t = old[0]
                saved_gv[(t, d, s, p_str)] = gv_grid.get((t, d, s, p_str), "")
                gv_grid[(t, d, s, p_str)] = ""
                del lop_grid[(cls, d, s, p_str)]
                
        collision = False
        for (cls, d, s, p), val in moves:
            p_str = str(p)
            if val:
                t, subj, raw = val
                if (t, d, s, p_str) not in saved_gv:
                    saved_gv[(t, d, s, p_str)] = gv_grid.get((t, d, s, p_str), "")
                if gv_grid.get((t, d, s, p_str), "") != "":
                    collision = True
                    break
                gv_grid[(t, d, s, p_str)] = raw
                lop_grid[(cls, d, s, p_str)] = val
                
        if collision:
            for k, v in saved_lop.items():
                if v: lop_grid[k] = v
                elif k in lop_grid: del lop_grid[k]
            for k, v in saved_gv.items(): gv_grid[k] = v
            return False, None
            
        singles, _, _ = analyze_session_loads(teachers, gv_grid)
        if singles > 2: # base is 2
            for k, v in saved_lop.items():
                if v: lop_grid[k] = v
                elif k in lop_grid: del lop_grid[k]
            for k, v in saved_gv.items(): gv_grid[k] = v
            return False, None
            
        h_ge2, _ = count_span_holes()
        return True, (h_ge2, singles, saved_lop, saved_gv)

    def revert(saved_lop, saved_gv):
        for k, v in saved_lop.items():
            if v: lop_grid[k] = v
            elif k in lop_grid: del lop_grid[k]
        for k, v in saved_gv.items(): gv_grid[k] = v

    h_start, stuck_start = count_span_holes()
    print(f"BẮT ĐẦU: SỐ BUỔI TRỐNG >= 2 TIẾT = {h_start}")

    for t_target, d_target, s_target, holes_target, teaching_target in stuck_start:
        session_classes = list(set(k[0] for k in lop_grid.keys() if k[1]==d_target and k[2]==s_target))
        found = False
        
        # 1. Intra-class 2-swap
        for cls in session_classes:
            for p1 in range(1, 6):
                v1 = lop_grid.get((cls, d_target, s_target, str(p1)))
                for p2 in range(p1 + 1, 6):
                    v2 = lop_grid.get((cls, d_target, s_target, str(p2)))
                    moves = [
                        ((cls, d_target, s_target, p1), v2),
                        ((cls, d_target, s_target, p2), v1)
                    ]
                    ok, res = try_moves(moves)
                    if ok:
                        new_h, new_s, s_lop, s_gv = res
                        if new_h < h_start:
                            print(f"  -> [2-Swap] {cls} P{p1}<->P{p2}: Holes {h_start} -> {new_h}")
                            h_start = new_h
                            found = True
                            break
                        else: revert(s_lop, s_gv)
                if found: break
            if found: break
        if found: continue
        
        # 2. Intra-class 3-Cycle
        for cls in session_classes:
            for p1 in range(1, 6):
                v1 = lop_grid.get((cls, d_target, s_target, str(p1)))
                for p2 in range(1, 6):
                    if p2 == p1: continue
                    v2 = lop_grid.get((cls, d_target, s_target, str(p2)))
                    for p3 in range(1, 6):
                        if p3 == p1 or p3 == p2: continue
                        v3 = lop_grid.get((cls, d_target, s_target, str(p3)))
                        moves = [
                            ((cls, d_target, s_target, p2), v1),
                            ((cls, d_target, s_target, p3), v2),
                            ((cls, d_target, s_target, p1), v3)
                        ]
                        ok, res = try_moves(moves)
                        if ok:
                            new_h, new_s, s_lop, s_gv = res
                            if new_h < h_start:
                                print(f"  -> [3-Cycle] {cls} [{p1}->{p2}->{p3}]: Holes {h_start} -> {new_h}")
                                h_start = new_h
                                found = True
                                break
                            else: revert(s_lop, s_gv)
                    if found: break
                if found: break
            if found: break
        if found: continue
        
        # 3. Intra-session 2-Class Chain
        for cls1 in session_classes:
            for cls2 in session_classes:
                if cls1 == cls2: continue
                for p1 in range(1, 6):
                    v1 = lop_grid.get((cls1, d_target, s_target, str(p1)))
                    for p2 in range(1, 6):
                        if p2 == p1: continue
                        v2 = lop_grid.get((cls1, d_target, s_target, str(p2)))
                        for p3 in range(1, 6):
                            v3 = lop_grid.get((cls2, d_target, s_target, str(p3)))
                            for p4 in range(1, 6):
                                if p4 == p3: continue
                                v4 = lop_grid.get((cls2, d_target, s_target, str(p4)))
                                moves = [
                                    ((cls1, d_target, s_target, p2), v1),
                                    ((cls1, d_target, s_target, p1), v4),
                                    ((cls2, d_target, s_target, p4), v3),
                                    ((cls2, d_target, s_target, p3), v2)
                                ]
                                ok, res = try_moves(moves)
                                if ok:
                                    new_h, new_s, s_lop, s_gv = res
                                    if new_h < h_start:
                                        print(f"  -> [2-Class Chain] {cls1} (P{p1},P{p2}) & {cls2} (P{p3},P{p4}): Holes {h_start} -> {new_h}")
                                        h_start = new_h
                                        found = True
                                        break
                                    else: revert(s_lop, s_gv)
                                if found: break
                            if found: break
                        if found: break
                    if found: break
                if found: break
            if found: break

    # Save to Excel
    wb = openpyxl.load_workbook(src_file)
    ws = wb['Sheet1']
    for r, (day, sess, p_str) in row_to_slot.items():
        for c, teacher in teachers.items():
            val = gv_grid.get((teacher, day, sess, p_str), "")
            ws.cell(r, c).value = val if val != "" else None
            
    wb.save(out_file)
    print(f"\nĐÃ LƯU FILE KẾT QUẢ TẠI: {out_file}")
    
    # Verification
    final_h, stuck_end = count_span_holes()
    singles_final, _, _ = analyze_session_loads(teachers, gv_grid)
    
    print("\n" + "="*70)
    print("KẾT QUẢ KIỂM TRA TOÀN DIỆN FILE TỐI ƯU")
    print("="*70)
    print(f"1. Số buổi trống >= 2 tiết:   {final_h} (MỤC TIÊU: 0)")
    print(f"2. Số buổi dạy 1 tiết:        {singles_final} (GỐC: 2, KHÔNG TĂNG)")
    print("="*70)

if __name__ == "__main__":
    run_tonggv05_full_optimization()
