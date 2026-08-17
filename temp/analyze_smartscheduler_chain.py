import sys
import os
import openpyxl
import json
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from deep_analysis import load_schedule_matrix, analyze_gaps, diff_grids

def analyze_smart_scheduler_folder(dir_path):
    print(f"=== ANALYZING SMARTSCHEDULER FOLDER: {dir_path} ===")
    
    base_file = os.path.join(dir_path, "base.xlsx")
    grid_base_gv, _, _ = load_schedule_matrix(base_file, 'TKB_GV_SC')
    grid_base_lop, _, _ = load_schedule_matrix(base_file, 'TKB_LOP_SC')
    
    # Check all numbered files
    num_files = []
    for f in os.listdir(dir_path):
        if f.endswith(".xlsx") and f != "base.xlsx":
            name = f.replace(".xlsx", "")
            if name.isdigit():
                num_files.append((int(name), f))
    num_files.sort()
    
    print(f"Found {len(num_files)} sequential step files: {[f[1] for f in num_files]}")
    
    prev_grid_gv = grid_base_gv
    prev_grid_lop = grid_base_lop
    prev_name = "base"
    
    step_history = []
    
    for step_num, filename in num_files:
        filepath = os.path.join(dir_path, filename)
        curr_grid_gv, _, _ = load_schedule_matrix(filepath, 'TKB_GV_SC')
        curr_grid_lop, _, _ = load_schedule_matrix(filepath, 'TKB_LOP_SC')
        
        diffs_from_prev_gv = diff_grids(prev_grid_gv, curr_grid_gv)
        diffs_from_prev_lop = diff_grids(prev_grid_lop, curr_grid_lop)
        
        diffs_from_base_gv = diff_grids(grid_base_gv, curr_grid_gv)
        diffs_from_base_lop = diff_grids(grid_base_lop, curr_grid_lop)
        
        gaps_curr = analyze_gaps(curr_grid_gv)
        total_2_gaps = sum(len([g for g in glist if g['gap_length'] == 2]) for glist in gaps_curr.values())
        total_1_gaps = sum(len([g for g in glist if g['gap_length'] == 1]) for glist in gaps_curr.values())
        total_3_gaps = sum(len([g for g in glist if g['gap_length'] >= 3]) for glist in gaps_curr.values())
        
        # Identify which teachers changed in this step
        changed_teachers = set(d['entity'] for d in diffs_from_prev_gv)
        changed_classes = set(d['entity'] for d in diffs_from_prev_lop)
        
        # Identify the primary beneficiary teacher (whose gap-2 was reduced)
        prev_gaps = analyze_gaps(prev_grid_gv)
        beneficiaries = []
        for gv in changed_teachers:
            prev_g2 = len([g for g in prev_gaps.get(gv, []) if g['gap_length'] == 2])
            curr_g2 = len([g for g in gaps_curr.get(gv, []) if g['gap_length'] == 2])
            if curr_g2 < prev_g2:
                beneficiaries.append((gv, prev_g2, curr_g2))
                
        step_info = {
            'step': step_num,
            'file': filename,
            'prev': prev_name,
            'total_2_gaps': total_2_gaps,
            'total_1_gaps': total_1_gaps,
            'beneficiaries': beneficiaries,
            'changed_teachers': list(changed_teachers),
            'changed_classes': list(changed_classes),
            'num_gv_diffs': len(diffs_from_prev_gv),
            'num_lop_diffs': len(diffs_from_prev_lop),
            'lop_diffs': diffs_from_prev_lop,
            'gv_diffs': diffs_from_prev_gv
        }
        step_history.append(step_info)
        
        prev_grid_gv = curr_grid_gv
        prev_grid_lop = curr_grid_lop
        prev_name = filename
        
    return step_history

if __name__ == "__main__":
    dir_smart = r"C:\Users\Love\Documents\SmartScheduler\temp"
    history = analyze_smart_scheduler_folder(dir_smart)
    
    print("\n" + "="*80)
    print("STEP-BY-STEP TRANSITION SUMMARY")
    print("="*80)
    for s in history:
        b_str = ", ".join([f"{b[0]} (2-gaps: {b[1]}->{b[2]})" for b in s['beneficiaries']])
        print(f"Step {s['step']:2d} ({s['file']}): Remaining 2-Gaps = {s['total_2_gaps']:2d} | 1-Gaps = {s['total_1_gaps']:3d} | Beneficiary: {b_str}")
        print(f"   Classes affected ({len(s['changed_classes'])}): {s['changed_classes']}")
        print(f"   Teachers involved ({len(s['changed_teachers'])}): {s['changed_teachers']}")
        print(f"   Class cell moves ({s['num_lop_diffs']}):")
        for d in s['lop_diffs']:
            print(f"      [{d['entity']}] Day {d['day']} {d['session']} P{d['period']}: '{d['before']}' -> '{d['after']}'")
        print("-" * 60)
