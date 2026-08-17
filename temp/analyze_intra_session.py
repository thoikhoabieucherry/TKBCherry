import sys
import os
import openpyxl
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file, analyze_all_gaps
from analyze_session_loads import analyze_session_loads

def analyze_gap2_in_session(filepath):
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    gaps_1, gaps_2, gaps_3, teacher_gap_details = analyze_all_gaps(teachers, gv_grid, row_to_slot)
    
    print(f"Total 2-Gaps: {len(gaps_2)}")
    for i, g in enumerate(gaps_2, 1):
        teacher = g['teacher']
        day = g['day']
        sess = g['sess']
        print(f"\n--- [{i:2d}] Teacher {teacher} | Thứ {day} ({sess}) | Trống {g['gap_periods']} ---")
        for p, raw in g['teaching']:
            cls = raw.split(" - ")[0].strip()
            # List all periods of this class in this day/sess
            cls_slots = []
            for cp in range(1, 6):
                c_val = lop_grid.get((cls, day, sess, str(cp)))
                c_str = f"P{cp}: {c_val[0]} ({c_val[1]})" if c_val else f"P{cp}: [Trống]"
                cls_slots.append(c_str)
            print(f"   Dạy {raw} tại Tiết {p}. Lớp {cls} ({day}, {sess}): {', '.join(cls_slots)}")

if __name__ == "__main__":
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026.xlsx"
    analyze_gap2_in_session(filepath)
