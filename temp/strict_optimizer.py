import sys
import os
import openpyxl
import copy
from collections import defaultdict, deque

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file, analyze_all_gaps
from analyze_session_loads import analyze_session_loads

class StrictIntraSessionOptimizer:
    def __init__(self, filepath):
        self.filepath = filepath
        self.teachers, self.slot_to_row, self.row_to_slot, self.gv_grid, self.lop_grid = parse_tonggv_file(filepath)
        self.days = ["2", "3", "4", "5", "6", "7"]
        self.sessions = ["Sáng", "Chiều"]
        
    def get_teacher_gaps(self, teacher):
        g1, g2, g3 = 0, 0, 0
        gap2_list = []
        for day in self.days:
            for sess in self.sessions:
                teaching = []
                for p in range(1, 6):
                    p_str = str(p)
                    val = self.gv_grid.get((teacher, day, sess, p_str), "")
                    if val != "":
                        teaching.append((p, val))
                if len(teaching) >= 2:
                    p_indices = [t[0] for t in teaching]
                    min_p = min(p_indices)
                    max_p = max(p_indices)
                    
                    cur_gap = 0
                    cur_start = 0
                    for p in range(min_p, max_p + 1):
                        val = self.gv_grid.get((teacher, day, sess, str(p)), "")
                        if val == "":
                            if cur_gap == 0:
                                cur_start = p
                            cur_gap += 1
                        else:
                            if cur_gap > 0:
                                if cur_gap == 1: g1 += 1
                                elif cur_gap == 2:
                                    g2 += 1
                                    gap2_list.append({
                                        'teacher': teacher,
                                        'day': day,
                                        'sess': sess,
                                        'gap_periods': list(range(cur_start, cur_start + cur_gap)),
                                        'teaching': teaching
                                    })
                                else: g3 += 1
                                cur_gap = 0
                    if cur_gap > 0:
                        if cur_gap == 1: g1 += 1
                        elif cur_gap == 2:
                            g2 += 1
                            gap2_list.append({
                                'teacher': teacher,
                                'day': day,
                                'sess': sess,
                                'gap_periods': list(range(cur_start, cur_start + cur_gap)),
                                'teaching': teaching
                            })
                        else: g3 += 1
        return g1, g2, g3, gap2_list

    def get_all_gaps_summary(self):
        total_g1, total_g2, total_g3 = 0, 0, 0
        all_gap2 = []
        for t in self.teachers.values():
            g1, g2, g3, g2_list = self.get_teacher_gaps(t)
            total_g1 += g1
            total_g2 += g2
            total_g3 += g3
            all_gap2.extend(g2_list)
        return total_g1, total_g2, total_g3, all_gap2

    def try_moves_and_eval(self, moves):
        # moves is list of ((cls, day, sess, p), val)
        # STRICT CONSTRAINT: All moves in this batch MUST be in the same (day, sess)!
        # This guarantees 0 change to the number of periods per session for any teacher.
        affected_teachers = set()
        for (cls, day, sess, p), val in moves:
            old_val = self.lop_grid.get((cls, day, sess, str(p)))
            if old_val:
                affected_teachers.add(old_val[0])
            if val:
                affected_teachers.add(val[0])
                
        old_g2 = sum(self.get_teacher_gaps(t)[1] for t in affected_teachers)
        
        saved_lop = {}
        saved_gv = {}
        
        # Remove old
        for (cls, day, sess, p), _ in moves:
            p_str = str(p)
            saved_lop[(cls, day, sess, p_str)] = self.lop_grid.get((cls, day, sess, p_str))
            old_val = self.lop_grid.get((cls, day, sess, p_str))
            if old_val:
                t = old_val[0]
                saved_gv[(t, day, sess, p_str)] = self.gv_grid.get((t, day, sess, p_str), "")
                self.gv_grid[(t, day, sess, p_str)] = ""
                del self.lop_grid[(cls, day, sess, p_str)]
                
        # Insert new
        collision = False
        for (cls, day, sess, p), val in moves:
            p_str = str(p)
            if val:
                t, subj, raw = val
                if (t, day, sess, p_str) not in saved_gv:
                    saved_gv[(t, day, sess, p_str)] = self.gv_grid.get((t, day, sess, p_str), "")
                if self.gv_grid.get((t, day, sess, p_str), "") != "":
                    collision = True
                    break
                self.gv_grid[(t, day, sess, p_str)] = raw
                self.lop_grid[(cls, day, sess, p_str)] = val
                
        if collision:
            for k, v in saved_lop.items():
                if v: self.lop_grid[k] = v
                elif k in self.lop_grid: del self.lop_grid[k]
            for k, v in saved_gv.items():
                self.gv_grid[k] = v
            return False, 0
            
        new_g2 = sum(self.get_teacher_gaps(t)[1] for t in affected_teachers)
        
        if new_g2 < old_g2:
            return True, (old_g2 - new_g2)
        else:
            # Revert
            for k, v in saved_lop.items():
                if v: self.lop_grid[k] = v
                elif k in self.lop_grid: del self.lop_grid[k]
            for k, v in saved_gv.items():
                self.gv_grid[k] = v
            return False, 0

    def optimize_strict_intra_session(self):
        print("=== STARTING STRICT INTRA-SESSION OPTIMIZATION ===")
        print("Constraint: ONLY moves within the same session allowed (0 change to periods/session).")
        
        step = 0
        max_steps = 100
        
        while step < max_steps:
            g1, g2, g3, gap2_list = self.get_all_gaps_summary()
            print(f"Iteration {step:2d} | Remaining 2-Gaps: {g2:2d} | 1-Gaps: {g1:3d} | >=3-Gaps: {g3:2d}")
            if g2 == 0:
                print("\n>>> SUCCESS! All 2-period gaps eliminated to 0 with STRICT intra-session moves! <<<")
                return True
                
            improved = False
            for gap_item in gap2_list:
                target_gv = gap_item['teacher']
                day = gap_item['day']
                sess = gap_item['sess']
                teaching = gap_item['teaching']
                
                # --- STRATEGY 1: Intra-class 2-Swap ---
                for p_from, raw in teaching:
                    cls = raw.split(" - ")[0].strip()
                    val_from = self.lop_grid.get((cls, day, sess, str(p_from)))
                    for p_to in range(1, 6):
                        if p_to == p_from: continue
                        val_to = self.lop_grid.get((cls, day, sess, str(p_to)))
                        moves = [
                            ((cls, day, sess, p_from), val_to),
                            ((cls, day, sess, p_to), val_from)
                        ]
                        success, delta = self.try_moves_and_eval(moves)
                        if success:
                            print(f"  [Step {step+1}] [Intra-Class 2-Swap] {target_gv} in {cls} ({day}, {sess}): P{p_from} <-> P{p_to} (Delta: -{delta})")
                            improved = True
                            break
                    if improved: break
                if improved: break
                
                # --- STRATEGY 2: Intra-class 3-Cycle ---
                for p1, raw in teaching:
                    cls = raw.split(" - ")[0].strip()
                    v1 = self.lop_grid.get((cls, day, sess, str(p1)))
                    for p2 in range(1, 6):
                        if p2 == p1: continue
                        v2 = self.lop_grid.get((cls, day, sess, str(p2)))
                        for p3 in range(1, 6):
                            if p3 == p1 or p3 == p2: continue
                            v3 = self.lop_grid.get((cls, day, sess, str(p3)))
                            # cycle 1: p1->p2, p2->p3, p3->p1
                            moves1 = [
                                ((cls, day, sess, p2), v1),
                                ((cls, day, sess, p3), v2),
                                ((cls, day, sess, p1), v3)
                            ]
                            success, delta = self.try_moves_and_eval(moves1)
                            if success:
                                print(f"  [Step {step+1}] [Intra-Class 3-Cycle] {target_gv} in {cls} ({day}, {sess}): [{p1}->{p2}->{p3}] (Delta: -{delta})")
                                improved = True
                                break
                            # cycle 2: p1->p3, p3->p2, p2->p1
                            moves2 = [
                                ((cls, day, sess, p3), v1),
                                ((cls, day, sess, p2), v3),
                                ((cls, day, sess, p1), v2)
                            ]
                            success, delta = self.try_moves_and_eval(moves2)
                            if success:
                                print(f"  [Step {step+1}] [Intra-Class 3-Cycle] {target_gv} in {cls} ({day}, {sess}): [{p1}->{p3}->{p2}] (Delta: -{delta})")
                                improved = True
                                break
                        if improved: break
                    if improved: break
                if improved: break
                
                # --- STRATEGY 3: Intra-Session Cross-Class Ejection Chain (Same day, same sess) ---
                for p1, raw in teaching:
                    cls1 = raw.split(" - ")[0].strip()
                    v1 = self.lop_grid.get((cls1, day, sess, str(p1)))
                    for p2 in range(1, 6):
                        if p2 == p1: continue
                        v2 = self.lop_grid.get((cls1, day, sess, str(p2)))
                        if not v2: continue
                        gv2 = v2[0]
                        # Find another class cls2 that gv2 teaches IN THIS SAME (day, sess)
                        for other_cls in set(c[0] for c in self.lop_grid.keys() if c[1]==day and c[2]==sess):
                            if other_cls == cls1: continue
                            for p3 in range(1, 6):
                                v3 = self.lop_grid.get((other_cls, day, sess, str(p3)))
                                if v3 and v3[0] == gv2:
                                    for p4 in range(1, 6):
                                        if p4 == p3: continue
                                        v4 = self.lop_grid.get((other_cls, day, sess, str(p4)))
                                        # Chain in same session:
                                        moves_chain = [
                                            ((cls1, day, sess, p2), v1),
                                            ((cls1, day, sess, p1), v4),
                                            ((other_cls, day, sess, p4), v3),
                                            ((other_cls, day, sess, p3), v2)
                                        ]
                                        success, delta = self.try_moves_and_eval(moves_chain)
                                        if success:
                                            print(f"  [Step {step+1}] [Intra-Session Chain] {target_gv} ({cls1}) & {gv2} ({other_cls}) in ({day}, {sess}) (Delta: -{delta})")
                                            improved = True
                                            break
                                    if improved: break
                            if improved: break
                        if improved: break
                    if improved: break
                if improved: break
                
            if not improved:
                print(f"No further strict intra-session move found at step {step}.")
                break
            step += 1
            
        g1, g2, g3, _ = self.get_all_gaps_summary()
        return g2 == 0

    def export_and_verify(self, out_filepath):
        wb = openpyxl.load_workbook(self.filepath)
        ws = wb['Sheet1']
        
        for r, (day, sess, p_str) in self.row_to_slot.items():
            for c, teacher in self.teachers.items():
                val = self.gv_grid.get((teacher, day, sess, p_str), "")
                ws.cell(r, c).value = val if val != "" else None
                
        wb.save(out_filepath)
        print(f"\nSaved strict-optimized schedule to: {out_filepath}")
        
        # Verify
        single_count, counts_by_teacher, single_list = analyze_session_loads(self.teachers, self.gv_grid)
        g1, g2, g3, _ = self.get_all_gaps_summary()
        
        print("\n" + "="*70)
        print("VERIFICATION OF STRICT CONSTRAINTS")
        print("="*70)
        print(f"1. Remaining 2-Period Gaps (Tiết trống 2):     {g2} (TARGET: 0)")
        print(f"2. Single-period sessions (1 tiết/buổi):        {single_count} (BASE: 4, TARGET: <= 4)")
        print(f"3. Total 1-Period Gaps (Tiết trống 1):         {g1}")
        print(f"4. Total >=3-Period Gaps:                      {g3}")
        
        if g2 == 0 and single_count <= 4:
            print("\n>>> PERFECT SUCCESS! 2-GAPS = 0 AND 1-TIẾT/BUỔI KHÔNG HỀ TĂNG (ĐẠT CHÍNH XÁC = 4)! <<<")

if __name__ == "__main__":
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026.xlsx"
    out_filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026_TOI_UU_2_TIET_TRONG.xlsx"
    
    optimizer = StrictIntraSessionOptimizer(filepath)
    success = optimizer.optimize_strict_intra_session()
    optimizer.export_and_verify(out_filepath)
