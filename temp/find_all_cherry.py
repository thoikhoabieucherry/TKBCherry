import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

def find_all_cherry_copies():
    base_dir = r"C:\Users\Love\Documents\Codex\TKBCherry"
    found = []
    for root, dirs, files in os.walk(base_dir):
        for f in files:
            if f in ["tkb-fet-engine.js", "tkb-fet-worker.js"]:
                p = os.path.join(root, f)
                found.append((p, os.path.getsize(p)))
                
    print(f"Total copies found in TKBCherry: {len(found)}")
    for p, sz in found:
        print(f"  {p} (size={sz})")

if __name__ == "__main__":
    find_all_cherry_copies()
