import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

fet_dir = r"C:\Users\Love\Documents\Codex\FET\src\engine"

print(f"Checking engine files in {fet_dir}:")
if os.path.exists(fet_dir):
    files = os.listdir(fet_dir)
    print(f"Found {len(files)} files in engine:")
    for f in sorted(files):
        if f.endswith('.cpp') or f.endswith('.h'):
            print(" ", f)
else:
    print(f"Directory {fet_dir} does not exist. Searching src:")
    src_dir = r"C:\Users\Love\Documents\Codex\FET\src"
    for root, dirs, files in os.walk(src_dir):
        for f in files:
            if "min" in f.lower() or "hour" in f.lower() or "generate" in f.lower() or "time" in f.lower():
                print(os.path.join(root, f))
