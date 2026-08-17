import sys
import os
import openpyxl
import copy
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file
from analyze_session_loads import analyze_session_loads

def solve_5_stuck_cases():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
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
        # Check collisions
        affected_t = set()
        for (cls, d, s, p), val in moves:
            old = lop_grid.get((cls, d, s, str(p)))
            if old: affected_t.add(old[0])
            if val: affected_t.add(val[0])
            
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
            
        # Check single period sessions
        singles, _, _ = analyze_session_loads(teachers, gv_grid)
        if singles > 2: # base is 2
            # Revert
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
    print(f"INITIAL HOLES >= 2: {h_start}")
    for item in stuck_start:
        print(f"   {item[0]} | Thứ {item[1]} ({item[2]}) | Holes: {item[3]} | Teaching: {item[4]}")

    # Let's search for moves for each stuck teacher
    step = 1
    for t_target, d_target, s_target, holes_target, teaching_target in stuck_start:
        print(f"\nSearching move for Teacher {t_target} in ({d_target}, {s_target})...")
        found = False
        
        # 1. Try 2-swap in any class of this session
        session_classes = set(k[0] for k in lop_grid.keys() if k[1]==d_target and k[2]==s_target)
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
                            print(f"Found Level 1 Swap on {cls} P{p1}<->P{p2}! Holes: {h_start} -> {new_h}")
                            h_start = new_h
                            found = True
                            break
                        else:
                            revert(s_lop, s_gv)
                if found: break
            if found: break
            
        if found: continue
        
        # 2. Try 3-cycle in any class of this session
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
                                print(f"Found Level 2 3-Cycle on {cls} [{p1}->{p2}->{p3}]! Holes: {h_start} -> {new_h}")
                                h_start = new_h
                                found = True
                                break
                            else:
                                revert(s_lop, s_gv)
                    if found: break
                if found: break
            if found: break
            
        if found: continue
        
        # 3. Try Ejection Chain between 2 classes in this session
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
                                        print(f"Found Level 3 Chain between {cls1} (P{p1},P{p2}) & {cls2} (P{p3},P{p4})! Holes: {h_start} -> {new_h}")
                                        h_start = new_h
                                        found = True
                                        break
                                    else:
                                        revert(s_lop, s_gv)
                                if found: break
                            if found: break
                        if found: break
                    if found: break
                if found: break
            if found: break
            
    final_h, stuck_end = count_span_holes()
    print(f"\nFINAL HOLES >= 2: {final_h}")
    for item in stuck_end:
        print(f"   {item[0]} | Thứ {item[1]} ({item[2]}) | Holes: {item[3]} | Teaching: {item[4]}")

if __name__ == "__main__":
    solve_5_stuck_cases()
