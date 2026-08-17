import os
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

fpath = r"C:\Users\Love\Documents\Codex\Cherry fix\rust_api\src\native_solver.rs"

with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
    lines = f.readlines()

print(f"Total lines in native_solver.rs: {len(lines)}")
for idx, line in enumerate(lines):
    if "Singletons" in line or "global_session_repack" in line or "one_period" in line:
        if idx % 50 == 0 or "fn " in line or "match " in line or "solve" in line.lower():
            print(f"L{idx+1}: {line.strip()[:140]}")
