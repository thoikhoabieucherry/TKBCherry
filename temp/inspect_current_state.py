import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file, analyze_all_gaps
from analyze_session_loads import analyze_session_loads

def inspect_current():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
    g1, g2, g3, _ = analyze_all_gaps(teachers, gv_grid, row_to_slot)
    singles, _, _ = analyze_session_loads(teachers, gv_grid)
    
    print(f"File: {filepath}")
    print(f"Total 2-Period Gaps: {len(g2)}")
    print(f"Total 1-Period Gaps: {len(g1)}")
    print(f"Total >=3-Period Gaps: {len(g3)}")
    print(f"Single session count (1 tiết/buổi): {singles}")
    
    print("\n--- 2-PERIOD GAPS LIST ---")
    for i, g in enumerate(g2 + g3, 1):
        print(f"{i}. Teacher: {g['teacher']:<15} | Thứ {g['day']} ({g['sess']}) | Gaps: {g['gap_periods']} | Teaching: {g['teaching']}")

if __name__ == "__main__":
    inspect_current()
