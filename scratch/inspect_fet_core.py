import os
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

fet_dir = r"C:\Users\Love\Documents\Codex\FET\src\engine"

def search_in_file(fname, patterns):
    fpath = os.path.join(fet_dir, fname)
    if not os.path.exists(fpath): return
    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    
    print(f"\n=== Searching in {fname} ===")
    for pat in patterns:
        matches = [m.start() for m in re.finditer(pat, content, re.IGNORECASE)]
        print(f"Pattern '{pat}': found {len(matches)} occurrences")
        for idx in matches[:3]:
            start = max(0, idx - 200)
            end = min(len(content), idx + 400)
            print("-" * 50)
            print(content[start:end])

search_in_file("timeconstraint.h", ["MinHoursDaily", "MinDays", "MaxDays", "MinGaps", "MaxGaps"])
search_in_file("generate.cpp", ["min_hours", "min_days", "recursiv", "randomSwap", "placeActivity"])
