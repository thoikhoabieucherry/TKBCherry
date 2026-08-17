import sys

sys.stdout.reconfigure(encoding='utf-8')

def check_js_syntax():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    print("Checking where tryIntraSessionCrossClassChain is defined and called...")
    
    lines = content.splitlines()
    for idx, line in enumerate(lines):
        if "tryIntraSessionCrossClassChain" in line:
            print(f"Line {idx+1}: {line}")

if __name__ == "__main__":
    check_js_syntax()
