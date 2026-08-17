import sys
import os
import glob
import json

sys.stdout.reconfigure(encoding='utf-8')

def find_files_with_text():
    base_dir = r"C:\Users\Love\Documents\Codex"
    print("Searching for recent JSON or excel files in Codex...")
    
    recent_files = []
    for root, dirs, files in os.walk(base_dir):
        # Skip node_modules or large git dirs
        if "node_modules" in root or ".git" in root or "TKBCherry-backups" in root:
            continue
        for f in files:
            if f.endswith(".json") or f.endswith(".xlsx") or f.endswith(".txt"):
                p = os.path.join(root, f)
                try:
                    mtime = os.path.getmtime(p)
                    recent_files.append((mtime, p))
                except:
                    pass
                    
    recent_files.sort(reverse=True)
    print("15 most recent data files in Codex:")
    for mtime, p in recent_files[:15]:
        print(f"  {p}")

if __name__ == "__main__":
    find_files_with_text()
