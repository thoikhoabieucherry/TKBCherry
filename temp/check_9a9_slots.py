import sys
import os
import openpyxl

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file

def check_9a9_conflicts():
    # Check tonggv05 or base files to see 9A9 slots
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
    # Check 9A9 and 9/9
    print("Checking available empty slots for 9A9...")
    days = ["2", "3", "4", "5", "6", "7"]
    empty_slots = []
    for d in days:
        for p in range(1, 6):
            v = lop_grid.get(("9A9", d, "Sáng", str(p)))
            if not v:
                empty_slots.append((d, p))
                print(f"  Empty slot at: Thứ {d} Sáng Tiết {p}")
                
    print(f"Total empty slots for 9A9: {len(empty_slots)}")

if __name__ == "__main__":
    check_9a9_conflicts()
