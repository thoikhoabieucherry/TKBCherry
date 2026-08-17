import os
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

backup_engine = r"C:\Users\Love\Documents\Codex\backup\TKBCherry\web\pages\tkb-fet-engine.js"
current_engine = r"c:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"

with open(backup_engine, "r", encoding="utf-8") as f:
    backup_lines = f.readlines()

with open(current_engine, "r", encoding="utf-8") as f:
    current_lines = f.readlines()

def find_def(lines, pattern):
    for i, l in enumerate(lines):
        if re.match(pattern, l.strip()):
            return i
    return -1

print("Backup tryConsolidate def:", find_def(backup_lines, r"^tryConsolidateTeacherSingletons\(") + 1)
print("Current tryConsolidate def:", find_def(current_lines, r"^tryConsolidateTeacherSingletons\(") + 1)

print("Backup obliterate def:", find_def(backup_lines, r"^obliterateAllTeacherSingletons\(") + 1)
print("Current obliterate def:", find_def(current_lines, r"^obliterateAllTeacherSingletons\(") + 1)

print("Backup tryCrushTeacherGaps def:", find_def(backup_lines, r"^tryCrushTeacherGaps\(") + 1)
print("Current tryCrushTeacherGaps def:", find_def(current_lines, r"^tryCrushTeacherGaps\(") + 1)

print("Backup async optimize def:", find_def(backup_lines, r"^async optimize\(") + 1)
print("Current async optimize def:", find_def(current_lines, r"^async optimize\(") + 1)
