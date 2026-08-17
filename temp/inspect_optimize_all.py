import sys

sys.stdout.reconfigure(encoding='utf-8')

def inspect_optimize_all():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    print("=== INSPECTING optimizeAll (Lines 5680 to 5900) ===")
    for i in range(5680, min(len(lines), 5900)):
        if "STAGES" in lines[i] or "GUARDED_OPERATORS" in lines[i] or "optimizeAll" in lines[i]:
            print(f"\n--- Around line {i+1} ---")
            for j in range(max(0, i - 2), min(len(lines), i + 40)):
                print(f"{j+1:4d}: {lines[j]}", end="")

if __name__ == "__main__":
    inspect_optimize_all()
