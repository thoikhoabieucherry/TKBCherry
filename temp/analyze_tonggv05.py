import sys
import os
import openpyxl
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file, analyze_all_gaps
from analyze_session_loads import analyze_session_loads

def analyze_new_file():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
    g1, g2, g3, teacher_gap_details = analyze_all_gaps(teachers, gv_grid, row_to_slot)
    single_count, counts_by_teacher, single_list = analyze_session_loads(teachers, gv_grid)
    
    print(f"File: {filepath}")
    print(f"Total teachers: {len(teachers)}")
    print(f"Total 2-Period Gaps (Tiết trống 2): {len(g2)}")
    print(f"Total 1-Period Gaps (Tiết trống 1): {len(g1)}")
    print(f"Total >=3-Period Gaps:             {len(g3)}")
    print(f"Total 1-period sessions (1 tiết/buổi): {single_count}")
    
    print("\n" + "="*70)
    print("CHI TIẾT 5 BUỔI TRỐNG 2 TIẾT BỊ KẸT")
    print("="*70)
    for i, g in enumerate(g2, 1):
        teacher = g['teacher']
        day = g['day']
        sess = g['sess']
        print(f"\n[{i}] Teacher: {teacher:<15} | Thứ {day} ({sess}) | Trống: {g['gap_periods']}")
        print(f"    Đang dạy: {g['teaching']}")
        for p, raw in g['teaching']:
            cls = raw.split(" - ")[0].strip()
            cls_slots = []
            for cp in range(1, 6):
                c_val = lop_grid.get((cls, day, sess, str(cp)))
                c_str = f"P{cp}: {c_val[0]} ({c_val[1]})" if c_val else f"P{cp}: [Trống]"
                cls_slots.append(c_str)
            print(f"    Lớp {cls} ({day}, {sess}): {', '.join(cls_slots)}")

if __name__ == "__main__":
    analyze_new_file()
