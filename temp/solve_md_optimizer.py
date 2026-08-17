import sys
import os
import openpyxl
import copy
from collections import defaultdict, deque

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file, analyze_all_gaps

class TKBOptimizer:
    def __init__(self, filepath):
        self.filepath = filepath
        self.teachers, self.slot_to_row, self.row_to_slot, self.gv_grid, self.lop_grid = parse_tonggv_file(filepath)
        self.days = ["2", "3", "4", "5", "6", "7"]
        self.sessions = ["Sáng", "Chiều"]
        
    def get_teacher_teaching(self, teacher, day, sess):
        teaching = []
        for p in range(1, 6):
            p_str = str(p)
            val = self.gv_grid.get((teacher, day, sess, p_str), "")
            if val != "":
                teaching.append((p, val))
        return teaching
    
    def count_gaps(self):
        gaps_1, gaps_2, gaps_3_plus, teacher_gaps = analyze_all_gaps(self.teachers, self.gv_grid, self.row_to_slot)
        return len(gaps_1), len(gaps_2), len(gaps_3_plus), gaps_2

    def get_gap2_list(self):
        _, gaps_2, _, _ = analyze_all_gaps(self.teachers, self.gv_grid, self.row_to_slot)
        return gaps_2

    def check_validity(self):
        # 1. No teacher teaches 2 classes at same (day, sess, p)
        # 2. No class has 2 teachers at same (day, sess, p)
        for (teacher, day, sess, p), val in self.gv_grid.items():
            if val != "":
                parts = val.split(" - ")
                cls = parts[0].strip()
                # Check class grid
                c_val = self.lop_grid.get((cls, day, sess, p))
                if not c_val or c_val[0] != teacher:
                    return False, f"Mismatch at Teacher {teacher} cls {cls} ({day}, {sess}, {p})"
        return True, "OK"

    def apply_intra_class_swap(self, cls, day, sess, p1, p2):
        # Swap periods p1 and p2 in class cls at (day, sess)
        p1_str, p2_str = str(p1), str(p2)
        v1 = self.lop_grid.get((cls, day, sess, p1_str))
        v2 = self.lop_grid.get((cls, day, sess, p2_str))
        
        gv1 = v1[0] if v1 else None
        gv2 = v2[0] if v2 else None
        raw1 = v1[2] if v1 else ""
        raw2 = v2[2] if v2 else ""
        
        # Check if gv1 is free at (day, sess, p2) (except currently teaching cls at p1)
        if gv1 and p2_str != p1_str:
            cur_at_p2 = self.gv_grid.get((gv1, day, sess, p2_str), "")
            if cur_at_p2 != "":
                return False # GV1 is busy at p2
                
        # Check if gv2 is free at (day, sess, p1)
        if gv2 and p2_str != p1_str:
            cur_at_p1 = self.gv_grid.get((gv2, day, sess, p1_str), "")
            if cur_at_p1 != "":
                return False # GV2 is busy at p1
                
        # Execute swap
        if gv1:
            self.gv_grid[(gv1, day, sess, p1_str)] = ""
            self.gv_grid[(gv1, day, sess, p2_str)] = raw1
        if gv2:
            self.gv_grid[(gv2, day, sess, p2_str)] = ""
            self.gv_grid[(gv2, day, sess, p1_str)] = raw2
            
        if v1:
            self.lop_grid[(cls, day, sess, p2_str)] = v1
        else:
            if (cls, day, sess, p2_str) in self.lop_grid:
                del self.lop_grid[(cls, day, sess, p2_str)]
                
        if v2:
            self.lop_grid[(cls, day, sess, p1_str)] = v2
        else:
            if (cls, day, sess, p1_str) in self.lop_grid:
                del self.lop_grid[(cls, day, sess, p1_str)]
                
        return True

    def apply_intra_class_cycle(self, cls, day, sess, cycle):
        # cycle is list of periods e.g. [p1, p2, p3] meaning p1->p2, p2->p3, p3->p1
        # Check validity first
        saved_gv = copy.deepcopy(self.gv_grid)
        saved_lop = copy.deepcopy(self.lop_grid)
        
        vals = [self.lop_grid.get((cls, day, sess, str(p))) for p in cycle]
        
        # Temp clear
        for p, v in zip(cycle, vals):
            p_str = str(p)
            if v:
                self.gv_grid[(v[0], day, sess, p_str)] = ""
            if (cls, day, sess, p_str) in self.lop_grid:
                del self.lop_grid[(cls, day, sess, p_str)]
                
        # Assign shifted
        n = len(cycle)
        for i in range(n):
            from_idx = i
            to_idx = (i + 1) % n
            to_p_str = str(cycle[to_idx])
            v = vals[from_idx]
            if v:
                gv = v[0]
                raw = v[2]
                if self.gv_grid.get((gv, day, sess, to_p_str), "") != "":
                    # Conflict!
                    self.gv_grid = saved_gv
                    self.lop_grid = saved_lop
                    return False
                self.gv_grid[(gv, day, sess, to_p_str)] = raw
                self.lop_grid[(cls, day, sess, to_p_str)] = v
        return True

    def apply_cross_day_swap(self, cls, day1, sess1, p1, day2, sess2, p2):
        # Swap (day1, sess1, p1) and (day2, sess2, p2) for class cls
        p1_str, p2_str = str(p1), str(p2)
        v1 = self.lop_grid.get((cls, day1, sess1, p1_str))
        v2 = self.lop_grid.get((cls, day2, sess2, p2_str))
        
        gv1 = v1[0] if v1 else None
        gv2 = v2[0] if v2 else None
        raw1 = v1[2] if v1 else ""
        raw2 = v2[2] if v2 else ""
        
        if gv1:
            if self.gv_grid.get((gv1, day2, sess2, p2_str), "") != "":
                return False
        if gv2:
            if self.gv_grid.get((gv2, day1, sess1, p1_str), "") != "":
                return False
                
        # Execute
        if gv1:
            self.gv_grid[(gv1, day1, sess1, p1_str)] = ""
            self.gv_grid[(gv1, day2, sess2, p2_str)] = raw1
        if gv2:
            self.gv_grid[(gv2, day2, sess2, p2_str)] = ""
            self.gv_grid[(gv2, day1, sess1, p1_str)] = raw2
            
        if v1:
            self.lop_grid[(cls, day2, sess2, p2_str)] = v1
        else:
            if (cls, day2, sess2, p2_str) in self.lop_grid:
                del self.lop_grid[(cls, day2, sess2, p2_str)]
                
        if v2:
            self.lop_grid[(cls, day1, sess1, p1_str)] = v2
        else:
            if (cls, day1, sess1, p1_str) in self.lop_grid:
                del self.lop_grid[(cls, day1, sess1, p1_str)]
                
        return True

    def solve(self):
        print("Starting 2-period gap optimization...")
        step = 0
        max_steps = 100
        
        while step < max_steps:
            gaps_1, gaps_2, gaps_3, gap2_list = self.count_gaps()
            print(f"Step {step:2d} -> Remaining 2-Gaps: {gaps_2:2d} | 1-Gaps: {gaps_1:3d} | >=3-Gaps: {gaps_3:2d}")
            if gaps_2 == 0:
                print("\n>>> SUCCESS! All 2-period gaps have been eliminated to 0! <<<")
                return True
                
            improved = False
            for target_gap in gap2_list:
                teacher = target_gap['teacher']
                day = target_gap['day']
                sess = target_gap['sess']
                teaching = target_gap['teaching']
                
                # Try Level 1: Intra-Class 2-Swap
                # Find which class the teacher teaches on this day/session
                for p, raw in teaching:
                    cls = raw.split(" - ")[0].strip()
                    # Try swapping p with every other period in the same session
                    for cand_p in range(1, 6):
                        if cand_p == p:
                            continue
                        # Save state
                        saved_gv = copy.deepcopy(self.gv_grid)
                        saved_lop = copy.deepcopy(self.lop_grid)
                        
                        if self.apply_intra_class_swap(cls, day, sess, p, cand_p):
                            # Evaluate cost
                            _, new_gaps_2, _, _ = self.count_gaps()
                            if new_gaps_2 < gaps_2:
                                print(f"   [Level 1] Swapped {cls} ({day}, {sess}) P{p} <-> P{cand_p} for {teacher} (2-gaps: {gaps_2} -> {new_gaps_2})")
                                improved = True
                                break
                            else:
                                self.gv_grid = saved_gv
                                self.lop_grid = saved_lop
                        else:
                            self.gv_grid = saved_gv
                            self.lop_grid = saved_lop
                    if improved:
                        break
                        
                if improved:
                    break
                    
                # Try Level 2: Intra-Class 3-Cycle Swap
                for p, raw in teaching:
                    cls = raw.split(" - ")[0].strip()
                    # Try 3-cycles involving p
                    for p2 in range(1, 6):
                        if p2 == p: continue
                        for p3 in range(1, 6):
                            if p3 == p or p3 == p2: continue
                            for cycle in [[p, p2, p3], [p, p3, p2]]:
                                saved_gv = copy.deepcopy(self.gv_grid)
                                saved_lop = copy.deepcopy(self.lop_grid)
                                if self.apply_intra_class_cycle(cls, day, sess, cycle):
                                    _, new_gaps_2, _, _ = self.count_gaps()
                                    if new_gaps_2 < gaps_2:
                                        print(f"   [Level 2] 3-Cycle on {cls} ({day}, {sess}) {cycle} for {teacher} (2-gaps: {gaps_2} -> {new_gaps_2})")
                                        improved = True
                                        break
                                    else:
                                        self.gv_grid = saved_gv
                                        self.lop_grid = saved_lop
                                else:
                                    self.gv_grid = saved_gv
                                    self.lop_grid = saved_lop
                            if improved: break
                        if improved: break
                    if improved: break
                if improved:
                    break
                    
                # Try Level 4: Cross-Day Swaps for class cls
                for p, raw in teaching:
                    cls = raw.split(" - ")[0].strip()
                    for d2 in self.days:
                        for s2 in self.sessions:
                            for p2 in range(1, 6):
                                if d2 == day and s2 == sess and p2 == p:
                                    continue
                                saved_gv = copy.deepcopy(self.gv_grid)
                                saved_lop = copy.deepcopy(self.lop_grid)
                                if self.apply_cross_day_swap(cls, day, sess, p, d2, s2, p2):
                                    _, new_gaps_2, _, _ = self.count_gaps()
                                    if new_gaps_2 < gaps_2:
                                        print(f"   [Level 4] Cross-Day on {cls}: ({day},{sess},P{p}) <-> ({d2},{s2},P{p2}) for {teacher} (2-gaps: {gaps_2} -> {new_gaps_2})")
                                        improved = True
                                        break
                                    else:
                                        self.gv_grid = saved_gv
                                        self.lop_grid = saved_lop
                                else:
                                    self.gv_grid = saved_gv
                                    self.lop_grid = saved_lop
                            if improved: break
                        if improved: break
                    if improved: break
                if improved:
                    break
                    
            if not improved:
                print(f"No simple moves improved 2-gaps. Exploring Ejection Chains...")
                # We can implement Ejection Chain here
                break
                
            step += 1
            
        return False

if __name__ == "__main__":
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026.xlsx"
    opt = TKBOptimizer(filepath)
    success = opt.solve()
    print("Optimization finished with success:", success)
