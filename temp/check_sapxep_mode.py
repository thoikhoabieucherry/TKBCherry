import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

def check_sapxep_chedo():
    phanmon_path = r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\phanmon.js"
    with open(phanmon_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    for idx, line in enumerate(lines):
        if "sapXepTheoCheDo" in line or "btnOptimizeMenu" in line or "optimize_gap2" in line:
            print(f"Line {idx+1}: {line.strip()[:100]}")
            for j in range(max(0, idx - 2), min(len(lines), idx + 35)):
                print(f"{j+1:4d}: {lines[j]}", end="")
            print("\n" + "="*50 + "\n")

if __name__ == "__main__":
    check_sapxep_chedo()
