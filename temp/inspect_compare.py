import sys

sys.stdout.reconfigure(encoding='utf-8')

def inspect_gap2_compare():
    engine_path = r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    for idx, line in enumerate(lines):
        if 'mode === "optimize_gap2"' in line or 'compareMetrics' in line:
            print(f"\n--- Found at line {idx+1}: {line.strip()} ---")
            for j in range(max(0, idx - 5), min(len(lines), idx + 35)):
                print(f"{j+1:4d}: {lines[j]}", end="")

if __name__ == "__main__":
    inspect_gap2_compare()
