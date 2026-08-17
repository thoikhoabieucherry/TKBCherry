import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

backup_engine = r"C:\Users\Love\Documents\Codex\backup\TKBCherry\web\pages\tkb-fet-engine.js"
current_engine = r"c:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"

with open(backup_engine, "r", encoding="utf-8") as f:
    backup_lines = f.readlines()

with open(current_engine, "r", encoding="utf-8") as f:
    current_lines = f.readlines()

# Find start of tryConsolidateTeacherSingletons in both
b_start = next(i for i, l in enumerate(backup_lines) if "tryConsolidateTeacherSingletons(" in l)
c_start = next(i for i, l in enumerate(current_lines) if "tryConsolidateTeacherSingletons(" in l)

# Find end of class in both
b_end = next(i for i, l in enumerate(backup_lines) if "global.FetTimetableEngine = FetTimetableEngine;" in l)
c_end = next(i for i, l in enumerate(current_lines) if "global.FetTimetableEngine = FetTimetableEngine;" in l)

print(f"Backup optimizer lines: {b_start+1} to {b_end+1} ({b_end - b_start} lines)")
print(f"Current optimizer lines: {c_start+1} to {c_end+1} ({c_end - c_start} lines)")
