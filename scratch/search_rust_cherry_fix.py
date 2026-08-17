import os
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

rust_api_dir = r"C:\Users\Love\Documents\Codex\Cherry fix\rust_api\src"

def search_rust_solver():
    print(f"Searching in {rust_api_dir}:")
    for f in os.listdir(rust_api_dir):
        if f.endswith(".rs"):
            fpath = os.path.join(rust_api_dir, f)
            with open(fpath, "r", encoding="utf-8", errors="ignore") as file:
                content = file.read()
            if "optimize_singletons" in content or "one_period" in content or "soBuoiDay1" in content or "singletons" in content:
                print(f"\nFound matches in {f}:")
                matches = [m.start() for m in re.finditer(r"(optimize_singletons|one_period|soBuoiDay1|min_hours|teacher_sessions)", content, re.IGNORECASE)]
                for idx in matches[:5]:
                    start = max(0, idx - 150)
                    end = min(len(content), idx + 250)
                    print("-" * 50)
                    print(content[start:end])

search_rust_solver()
