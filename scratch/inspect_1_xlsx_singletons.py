import openpyxl
import os
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

base_dir = r"C:\Users\Love\Documents\Codex\temp"

from deep_compare_dongkhoi import parse_schedule

res1 = parse_schedule(os.path.join(base_dir, "1.xlsx"))

print("\n--- Teacher singletons in 1.xlsx ---")
for gv, stats in sorted(res1["teacher_stats"].items(), key=lambda x: len(x[1]["singletons"]), reverse=True):
    if len(stats["singletons"]) > 0:
        print(f"Teacher: {gv:<20} | Singletons count: {len(stats['singletons'])}")
        for s in stats["singletons"]:
            print(f"    Day {s[0]}, Sess {s[1]} (P{s[2][0]+1}): Class {s[2][2]}, Mon {s[2][1]}")
