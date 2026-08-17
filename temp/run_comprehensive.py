import sys
import os
import openpyxl
import json
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from deep_analysis import load_schedule_matrix, analyze_gaps, diff_grids

def comprehensive_analysis():
    dir_smart = r"C:\Users\Love\Documents\SmartScheduler\temp"
    dir_vesion = r"C:\Users\Love\Documents\Codex\temp\vesion"
    
    # 1. Analyze SmartScheduler Sequence
    base_file = os.path.join(dir_smart, "base.xlsx")
    grid_base_gv, _, _ = load_schedule_matrix(base_file, 'TKB_GV_SC')
    grid_base_lop, _, _ = load_schedule_matrix(base_file, 'TKB_LOP_SC')
    
    gaps_base = analyze_gaps(grid_base_gv)
    
    num_files = []
    for f in os.listdir(dir_smart):
        if f.endswith(".xlsx") and f != "base.xlsx":
            name = f.replace(".xlsx", "")
            if name.isdigit():
                num_files.append((int(name), f))
    num_files.sort()
    
    results = {
        'initial_gaps': {},
        'steps': [],
        'vesion_teachers': {}
    }
    
    # Collect initial 2-gaps
    for gv, glist in gaps_base.items():
        g2 = [g for g in glist if g['gap_length'] == 2]
        if g2:
            results['initial_gaps'][gv] = [
                {'day': g['day'], 'sess': g['sess'], 'periods': g['gap_periods'], 'teaching': g['teaching']}
                for g in g2
            ]
            
    prev_grid_gv = grid_base_gv
    prev_grid_lop = grid_base_lop
    prev_name = "base"
    
    for step_num, filename in num_files:
        filepath = os.path.join(dir_smart, filename)
        curr_grid_gv, _, _ = load_schedule_matrix(filepath, 'TKB_GV_SC')
        curr_grid_lop, _, _ = load_schedule_matrix(filepath, 'TKB_LOP_SC')
        
        diffs_lop = diff_grids(prev_grid_lop, curr_grid_lop)
        diffs_gv = diff_grids(prev_grid_gv, curr_grid_gv)
        
        gaps_curr = analyze_gaps(curr_grid_gv)
        prev_gaps = analyze_gaps(prev_grid_gv)
        
        total_2_gaps = sum(len([g for g in glist if g['gap_length'] == 2]) for glist in gaps_curr.values())
        total_1_gaps = sum(len([g for g in glist if g['gap_length'] == 1]) for glist in gaps_curr.values())
        
        # Check which teachers gained or lost gaps
        changed_teachers = set(d['entity'] for d in diffs_gv)
        beneficiaries = []
        for gv in changed_teachers:
            prev_g2 = len([g for g in prev_gaps.get(gv, []) if g['gap_length'] == 2])
            curr_g2 = len([g for g in gaps_curr.get(gv, []) if g['gap_length'] == 2])
            if curr_g2 < prev_g2:
                beneficiaries.append({'gv': gv, 'before': prev_g2, 'after': curr_g2})
                
        # Group changes by class
        lop_changes = defaultdict(list)
        for d in diffs_lop:
            lop_changes[d['entity']].append({
                'day': d['day'],
                'sess': d['session'],
                'period': d['period'],
                'before': d['before'],
                'after': d['after']
            })
            
        step_entry = {
            'step': step_num,
            'file': filename,
            'remaining_2_gaps': total_2_gaps,
            'remaining_1_gaps': total_1_gaps,
            'beneficiaries': beneficiaries,
            'changed_teachers': list(changed_teachers),
            'changed_classes': list(lop_changes.keys()),
            'lop_changes': lop_changes,
            'num_cell_changes_lop': len(diffs_lop),
            'num_cell_changes_gv': len(diffs_gv)
        }
        results['steps'].append(step_entry)
        
        prev_grid_gv = curr_grid_gv
        prev_grid_lop = curr_grid_lop
        prev_name = filename
        
    # Also analyze vesion folder
    for fname in sorted(os.listdir(dir_vesion)):
        if fname == "base.xlsx" or not fname.endswith(".xlsx"):
            continue
        filepath = os.path.join(dir_vesion, fname)
        t_grid_gv, _, _ = load_schedule_matrix(filepath, 'TKB_GV_SC')
        t_grid_lop, _, _ = load_schedule_matrix(filepath, 'TKB_LOP_SC')
        
        diffs_lop = diff_grids(grid_base_lop, t_grid_lop)
        diffs_gv = diff_grids(grid_base_gv, t_grid_gv)
        gaps_curr = analyze_gaps(t_grid_gv)
        
        gv_name = fname.replace(".xlsx", "")
        lop_changes = defaultdict(list)
        for d in diffs_lop:
            lop_changes[d['entity']].append({
                'day': d['day'],
                'sess': d['session'],
                'period': d['period'],
                'before': d['before'],
                'after': d['after']
            })
            
        results['vesion_teachers'][gv_name] = {
            'file': fname,
            'before_gaps_2': len([g for g in gaps_base.get(gv_name, []) if g['gap_length'] == 2]),
            'after_gaps_2': len([g for g in gaps_curr.get(gv_name, []) if g['gap_length'] == 2]),
            'changed_classes': list(lop_changes.keys()),
            'lop_changes': lop_changes,
            'changed_teachers': list(set(d['entity'] for d in diffs_gv))
        }
        
    with open(r"c:\Users\Love\Documents\Codex\temp\analysis_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
        
    print("ANALYSIS FINISHED! Saved to analysis_results.json")

if __name__ == "__main__":
    comprehensive_analysis()
