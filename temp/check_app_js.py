import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

def check_worker_init():
    app_js_path = r"C:\Users\Love\Documents\Codex\TKBCherry\web\app.js"
    with open(app_js_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    print("=== WORKER INITIALIZATION IN app.js ===")
    lines = content.splitlines()
    for idx, line in enumerate(lines):
        if "tkb-fet-worker.js" in line or "tkb-fet-engine.js" in line:
            print(f"Line {idx+1}: {line.strip()[:100]}")

if __name__ == "__main__":
    check_worker_init()
