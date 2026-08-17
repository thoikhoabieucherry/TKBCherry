import sys

sys.stdout.reconfigure(encoding='utf-8')

def inspect_sweep():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    print("=== INSPECTING SWEEP SECTION in optimizeAll (Lines 5980 to 6120) ===")
    for i in range(5980, min(len(lines), 6120)):
        print(f"{i+1:4d}: {lines[i]}", end="")

if __name__ == "__main__":
    inspect_sweep()
