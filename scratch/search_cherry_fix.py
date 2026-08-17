import os
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

base_dir = r"C:\Users\Love\Documents\Codex\Cherry fix"

def search_files(dir_path, patterns):
    print(f"Searching in {dir_path} for patterns: {patterns}")
    for root, dirs, files in os.walk(dir_path):
        if "node_modules" in root or ".git" in root: continue
        for f in files:
            if f.endswith(".js") or f.endswith(".rs") or f.endswith(".py") or f.endswith(".md"):
                fpath = os.path.join(root, f)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as file:
                        lines = file.readlines()
                    for idx, line in enumerate(lines):
                        for p in patterns:
                            if re.search(p, line, re.IGNORECASE):
                                rel = os.path.relpath(fpath, base_dir)
                                print(f"{rel}:{idx+1}: {line.strip()[:150]}")
                                break
                except Exception as e:
                    pass

search_files(base_dir, [r"soBuoiDay1", r"optimize_singletons", r"dạy 1 tiết", r"single_period", r"buoiDay1", r"tiet_1", r"1_tiet"])
