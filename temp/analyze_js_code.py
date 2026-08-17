import sys
import os
import re

sys.stdout.reconfigure(encoding='utf-8')

def analyze_js_files():
    dir_path = r"C:\Users\Love\Documents\Codex\MD"
    engine_path = os.path.join(dir_path, "tkb-fet-engine.js")
    worker_path = os.path.join(dir_path, "tkb-fet-worker.js")
    
    print("=== ANALYZING tkb-fet-worker.js ===")
    with open(worker_path, "r", encoding="utf-8", errors="ignore") as f:
        worker_code = f.read()
    print(worker_code[:1500])
    
    print("\n" + "="*80)
    print("=== ANALYZING tkb-fet-engine.js ===")
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        engine_code = f.read()
        
    print(f"Total characters in engine: {len(engine_code)}, total lines: {len(engine_code.splitlines())}")
    
    # Search for keywords
    keywords = [
        "gap", "tiet_trong", "tietTrong", "tiet_1", "tiet1", "single", "buoi", "optimize", 
        "toi_uu", "kempe", "chain", "cycle", "swap", "ejection", "trong_2", "gap2", "twoPeriod"
    ]
    
    lines = engine_code.splitlines()
    print("\n--- FUNCTION DEFINITIONS & KEYWORD MATCHES ---")
    func_regex = re.compile(r'(function\s+([a-zA-Z0-9_$]+)|([a-zA-Z0-9_$]+)\s*:\s*function|class\s+([a-zA-Z0-9_$]+))')
    
    functions_found = []
    for i, line in enumerate(lines):
        for m in func_regex.finditer(line):
            name = m.group(2) or m.group(3) or m.group(4)
            if name:
                functions_found.append((i+1, name, line.strip()[:100]))
                
    print(f"Total function definitions found: {len(functions_found)}")
    for lnum, fname, line_preview in functions_found:
        lower_f = fname.lower()
        if any(k.lower() in lower_f for k in ["opt", "gap", "trong", "swap", "repair", "tiet", "score", "eval", "cost", "fet", "solve", "step", "chain"]):
            print(f"Line {lnum:4d}: {fname} -> {line_preview}")

if __name__ == "__main__":
    analyze_js_files()
