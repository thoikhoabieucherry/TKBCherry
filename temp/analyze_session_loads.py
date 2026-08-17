import sys
import os
import openpyxl
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file

def analyze_session_loads(teachers, gv_grid):
    days = ["2", "3", "4", "5", "6", "7"]
    sessions = ["Sáng", "Chiều"]
    
    # Count sessions with 1 period, 2 periods, 3 periods, etc.
    single_period_sessions = 0 # K = 1
    session_counts_by_teacher = defaultdict(lambda: defaultdict(int)) # teacher -> {1: count, 2: count, ...}
    
    single_list = []
    
    for teacher in teachers.values():
        for day in days:
            for sess in sessions:
                periods_taught = []
                for p in range(1, 6):
                    v = gv_grid.get((teacher, day, sess, str(p)), "")
                    if v != "":
                        periods_taught.append((p, v))
                k = len(periods_taught)
                if k > 0:
                    session_counts_by_teacher[teacher][k] += 1
                    if k == 1:
                        single_period_sessions += 1
                        single_list.append((teacher, day, sess, periods_taught[0]))
                        
    return single_period_sessions, session_counts_by_teacher, single_list

if __name__ == "__main__":
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
    single_count, counts_by_teacher, single_list = analyze_session_loads(teachers, gv_grid)
    
    print("=== SESSION LOAD ANALYSIS (Số tiết / buổi) IN BASE FILE ===")
    print(f"Total sessions with exactly 1 period (1 tiết/buổi): {single_count}")
    print(f"\nSample 1-period sessions (first 10):")
    for s in single_list[:10]:
        print(f"  Teacher {s[0]:<15} | Thứ {s[1]} ({s[2]}) | Tiết {s[3][0]}: {s[3][1]}")
