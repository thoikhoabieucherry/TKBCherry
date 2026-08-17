import sys

sys.stdout.reconfigure(encoding='utf-8')

def inspect_methods_detail():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    # Search for definitions of these methods
    method_names = [
        "tryGapRelabelCycles",
        "tryCrushTeacherGaps",
        "tryEjectPlaceIntoGap",
        "tryKempeChainPeriodSwap",
        "tryMergeSessionIntoGaps"
    ]
    
    lines = content.splitlines()
    for mname in method_names:
        print("\n" + "="*80)
        print(f"=== METHOD: {mname} ===")
        print("="*80)
        start_line = -1
        for idx, line in enumerate(lines):
            if f"{mname}(" in line and ("async " in line or "{" in line or "function" in line or line.strip().startswith(mname)):
                start_line = idx
                break
        if start_line != -1:
            # print 40 lines
            for i in range(start_line, min(len(lines), start_line + 45)):
                print(f"{i+1:4d}: {lines[i]}")
        else:
            print("NOT FOUND!")

if __name__ == "__main__":
    inspect_methods_detail()
