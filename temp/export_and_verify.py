import sys
import os
import openpyxl
from parse_md_schedule import parse_tonggv_file, analyze_all_gaps
from solve_md_optimizer import TKBOptimizer

sys.stdout.reconfigure(encoding='utf-8')

def run_and_export():
    src_file = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026.xlsx"
    out_file = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026_TOI_UU_2_TIET_TRONG.xlsx"
    
    opt = TKBOptimizer(src_file)
    success = opt.solve()
    
    if not success:
        print("Failed to optimize to 0!")
        return
        
    # Open original workbook to preserve styles, widths, formats
    wb = openpyxl.load_workbook(src_file)
    ws = wb['Sheet1']
    
    # Update cells
    for r, (day, sess, p_str) in opt.row_to_slot.items():
        for c, teacher in opt.teachers.items():
            val = opt.gv_grid.get((teacher, day, sess, p_str), "")
            ws.cell(r, c).value = val if val != "" else None
            
    wb.save(out_file)
    print(f"\nSuccessfully saved optimized file to: {out_file}")
    
    # -------------------------------------------------------------
    # VERIFY THE EXPORTED FILE
    # -------------------------------------------------------------
    print("\n" + "="*70)
    print("VERIFYING EXPORTED FILE INTEGRITY & HARD CONSTRAINTS")
    print("="*70)
    
    v_teachers, v_slot_to_row, v_row_to_slot, v_gv_grid, v_lop_grid = parse_tonggv_file(out_file)
    
    # 1. Check Hard Constraints: Teacher Collisions
    teacher_collisions = []
    # 2. Check Hard Constraints: Class Collisions
    class_collisions = []
    
    seen_teacher_slot = {} # (teacher, day, sess, p) -> cls
    seen_class_slot = {}   # (cls, day, sess, p) -> (teacher, subj)
    
    for (teacher, day, sess, p), val in v_gv_grid.items():
        if val != "":
            parts = val.split(" - ")
            cls = parts[0].strip()
            subj = parts[1].strip() if len(parts) > 1 else ""
            
            t_key = (teacher, day, sess, p)
            if t_key in seen_teacher_slot:
                teacher_collisions.append((t_key, seen_teacher_slot[t_key], cls))
            seen_teacher_slot[t_key] = cls
            
            c_key = (cls, day, sess, p)
            if c_key in seen_class_slot:
                class_collisions.append((c_key, seen_class_slot[c_key], (teacher, subj)))
            seen_class_slot[c_key] = (teacher, subj)
            
    # 3. Check gaps in exported file
    g1, g2, g3, _ = analyze_all_gaps(v_teachers, v_gv_grid, v_row_to_slot)
    
    print(f"1. Teacher Collisions (Trùng giáo viên): {len(teacher_collisions)} violations")
    print(f"2. Class Collisions (Trùng lớp):         {len(class_collisions)} violations")
    print(f"3. Total 2-Period Gaps (Tiết trống 2):   {len(g2)} (TARGET: 0)")
    print(f"4. Total 1-Period Gaps (Tiết trống 1):   {len(g1)}")
    print(f"5. Total >=3-Period Gaps (Tiết trống >=3): {len(g3)}")
    
    if len(teacher_collisions) == 0 and len(class_collisions) == 0 and len(g2) == 0:
        print("\n>>> ALL VALIDATION CHECKS PASSED PERFECTLY! 100% RELIABLE! <<<")

if __name__ == "__main__":
    run_and_export()
