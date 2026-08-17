import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

for root, dirs, files in os.walk("web/pages"):
    for f in files:
        if f.endswith(".js"):
            p = os.path.join(root, f)
            with open(p, "r", encoding="utf-8", errors="ignore") as file:
                lines = file.readlines()
                for i, line in enumerate(lines):
                    if "validateAll" in line or "lessonBlocks.min" in line:
                        print(f"{p}:{i+1}: {line.strip()[:120]}")
