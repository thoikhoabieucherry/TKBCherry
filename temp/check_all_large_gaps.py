import sys
import os
import openpyxl

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file, analyze_all_gaps

def check_all_large_gaps():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
    g1, g2, g3, teacher_gap_details = analyze_all_gaps(teachers, gv_grid, row_to_slot)
    
    print(f"--- ALL GAPS >= 2 PERIODS ---")
    all_target_gaps = g2 + g3
    print(f"Total gaps >= 2: {len(all_target_gaps)}")
    for i, g in enumerate(all_target_gaps, 1):
        print(f"[{i}] Teacher: {g['teacher']:<15} | Thứ {g['day']} ({g['sess']}) | Gap len: {g['gap_length']} | Trống tiết: {g['gap_periods']} | Đang dạy: {g['teaching']}")

if __name__ == "__main__":
    check_all_large_gaps()
