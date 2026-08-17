import openpyxl
import os
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

base_dir = r"C:\Users\Love\Documents\Codex\temp"
from deep_compare_dongkhoi import parse_schedule

r_base = parse_schedule(os.path.join(base_dir, "xepmoi.xlsx"))
r_1 = parse_schedule(os.path.join(base_dir, "1.xlsx"))
r_2 = parse_schedule(os.path.join(base_dir, "2.xlsx"))
r_3 = parse_schedule(os.path.join(base_dir, "3.xlsx"))

def compare_diff(r_from, r_to, name):
    print(f"\n=======================================================")
    print(f"Diff Analysis: {r_from['file']} -> {name}")
    print(f"=======================================================")
    
    # Check changed cells count
    changed_cells = 0
    total_cells = len(r_from["all_cells"])
    
    moves_by_teacher = defaultdict(int)
    moves_by_class = defaultdict(int)
    
    for i in range(total_cells):
        c1 = r_from["all_cells"][i]
        c2 = r_to["all_cells"][i]
        if c1["raw"] != c2["raw"]:
            changed_cells += 1
            moves_by_class[c1["class"]] += 1
            if c1["gv"]: moves_by_teacher[c1["gv"]] += 1
            if c2["gv"]: moves_by_teacher[c2["gv"]] += 1
            
    print(f"Total cells: {total_cells}, Changed cells: {changed_cells} ({changed_cells*100/total_cells:.1f}%)")
    print(f"Classes with changes: {len(moves_by_class)} / {r_from['classes_count']}")
    
    # Check singletons reduction
    s_before = r_from["singletons"]
    s_after = r_to["singletons"]
    print(f"Singletons: {s_before} -> {s_after} (reduced by {s_before - s_after})")
    print(f"Total sessions: {r_from['total_sessions']} -> {r_to['total_sessions']} (reduced by {r_from['total_sessions'] - r_to['total_sessions']})")
    print(f"Total teaching days: {r_from['total_days']} -> {r_to['total_days']} (reduced by {r_from['total_days'] - r_to['total_days']})")

compare_diff(r_base, r_1, "1.xlsx")
compare_diff(r_base, r_2, "2.xlsx")
compare_diff(r_base, r_3, "3.xlsx")

# Check difference between 1, 2, 3
print("\n--- Difference between 1, 2, 3 ---")
diff_1_2 = sum(1 for i in range(len(r_1["all_cells"])) if r_1["all_cells"][i]["raw"] != r_2["all_cells"][i]["raw"])
diff_1_3 = sum(1 for i in range(len(r_1["all_cells"])) if r_1["all_cells"][i]["raw"] != r_3["all_cells"][i]["raw"])
diff_2_3 = sum(1 for i in range(len(r_2["all_cells"])) if r_2["all_cells"][i]["raw"] != r_3["all_cells"][i]["raw"])

print(f"Diff 1 vs 2: {diff_1_2} cells changed")
print(f"Diff 1 vs 3: {diff_1_3} cells changed")
print(f"Diff 2 vs 3: {diff_2_3} cells changed")
