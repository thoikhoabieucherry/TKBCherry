import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

backup_engine = r"C:\Users\Love\Documents\Codex\backup\TKBCherry\web\pages\tkb-fet-engine.js"

with open(backup_engine, "r", encoding="utf-8", errors="ignore") as f:
    lines = f.readlines()

print(f"Total lines in backup tkb-fet-engine.js: {len(lines)}")

# Find all methods in FetTimetableEngine
for idx, line in enumerate(lines):
    if "optimize(" in line or "evaluateMetrics" in line or "loadExistingSchedule" in line or "tryConsolidate" in line or "tryCrush" in line or "tryReinforce" in line or "obliterate" in line or "async optimize" in line:
        print(f"L{idx+1}: {line.strip()[:100]}")
