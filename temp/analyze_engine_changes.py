import sys
import os
import re

sys.stdout.reconfigure(encoding='utf-8')

def analyze_engine_changes():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    print(f"File size: {len(content)} bytes, lines: {len(content.splitlines())}")
    
    # Check what mode === "optimize_gap2" has in the current engine
    lines = content.splitlines()
    for idx, line in enumerate(lines):
        if 'mode === "optimize_gap2"' in line or "mode === 'optimize_gap2'" in line:
            print(f"\n--- Found optimize_gap2 at line {idx+1} ---")
            for j in range(idx, min(len(lines), idx + 80)):
                print(f"{j+1:4d}: {lines[j]}")
            break

if __name__ == "__main__":
    analyze_engine_changes()
