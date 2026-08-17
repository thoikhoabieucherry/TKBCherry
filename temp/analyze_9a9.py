import sys
import os
import openpyxl
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file

def analyze_class_9a9(xlsx_path):
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(xlsx_path)
    
    # 1. Find all lessons placed for 9A9
    placed_lessons = []
    days = ["2", "3", "4", "5", "6", "7"]
    sessions = ["Sáng", "Chiều"]
    
    occupied_slots = {}
    for d in days:
        for s in sessions:
            for p in range(1, 6):
                p_str = str(p)
                val = lop_grid.get(("9A9", d, s, p_str))
                if val:
                    occupied_slots[(d, s, p)] = val
                    placed_lessons.append((d, s, p, val[0], val[1], val[2]))
                    
    print(f"=== CLASS 9A9 IN {os.path.basename(xlsx_path)} ===")
    print(f"Total placed lessons: {len(placed_lessons)} / 30 slots (Sáng: 30 slots)")
    
    # Group by session
    for d in days:
        row_str = []
        for p in range(1, 6):
            v = occupied_slots.get((d, "Sáng", p))
            if v:
                row_str.append(f"P{p}: {v[0]} ({v[1]})")
            else:
                row_str.append(f"P{p}: [TRỐNG]")
        print(f"  Thứ {d} Sáng: { ' | '.join(row_str) }")
        
    print("\n--- ALL TEACHERS TEACHING 9A9 ---")
    teachers_9a9 = defaultdict(int)
    for l in placed_lessons:
        teachers_9a9[(l[3], l[4])] += 1
    for (t, subj), count in teachers_9a9.items():
        print(f"  GV: {t:<15} | Môn: {subj:<10} | Đã xếp: {count} tiết")

if __name__ == "__main__":
    xlsx_file = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    analyze_class_9a9(xlsx_file)
