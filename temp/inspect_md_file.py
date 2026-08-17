import sys
import os
import openpyxl
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from deep_analysis import load_schedule_matrix, analyze_gaps

def inspect_md_file():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026.xlsx"
    wb = openpyxl.load_workbook(filepath, data_only=True)
    print("Sheets in file:", wb.sheetnames)
    
    grid_gv, row_info, col_info = load_schedule_matrix(filepath, 'TKB_GV_SC')
    grid_lop, _, _ = load_schedule_matrix(filepath, 'TKB_LOP_SC')
    
    gaps_gv = analyze_gaps(grid_gv)
    
    total_2 = 0
    total_1 = 0
    total_3 = 0
    
    teachers_with_2_gaps = {}
    
    for gv, glist in gaps_gv.items():
        g2 = [g for g in glist if g['gap_length'] == 2]
        g1 = [g for g in glist if g['gap_length'] == 1]
        g3 = [g for g in glist if g['gap_length'] >= 3]
        if g2:
            teachers_with_2_gaps[gv] = g2
            print(f"Teacher {gv}: {len(g2)} gap-2, {len(g1)} gap-1, {len(g3)} gap-3")
            for g in g2:
                print(f"   -> Day {g['day']} ({g['sess']}) Gaps: {g['gap_periods']}, Teaching: {g['teaching']}")
        total_2 += len(g2)
        total_1 += len(g1)
        total_3 += len(g3)
        
    print("\n" + "="*60)
    print(f"TOTAL SUMMARY FOR tonggv0417082026.xlsx:")
    print(f"Teachers with 2-Gaps: {len(teachers_with_2_gaps)}")
    print(f"Total 2-Period Gaps: {total_2}")
    print(f"Total 1-Period Gaps: {total_1}")
    print(f"Total >=3-Period Gaps: {total_3}")
    print("="*60)

if __name__ == "__main__":
    inspect_md_file()
