import sys

sys.stdout.reconfigure(encoding='utf-8')

def inspect_compare_metrics():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    print("=== INSPECTING compareMetrics (Lines 4445 to 4495) ===")
    for i in range(4445, 4495):
        print(f"{i+1:4d}: {lines[i]}", end="")

if __name__ == "__main__":
    inspect_compare_metrics()
