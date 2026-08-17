import sys

sys.stdout.reconfigure(encoding='utf-8')

def inspect_operator_code():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    print("=== INSPECTING tryKempeChainPeriodSwap (Lines 4355 to 4440) ===")
    for i in range(4355, 4440):
        print(f"{i+1:4d}: {lines[i]}", end="")

if __name__ == "__main__":
    inspect_operator_code()
