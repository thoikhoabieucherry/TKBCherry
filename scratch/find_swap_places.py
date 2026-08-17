import os
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

fpath = r"c:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"

with open(fpath, "r", encoding="utf-8") as f:
    lines = f.readlines()

for idx in range(1850, len(lines)):
    line = lines[idx]
    if "placeActivityDirect" in line or "evaluateMetrics" in line or "isLessonBlockSafe" in line:
        print(f"L{idx+1}: {line.strip()[:100]}")
