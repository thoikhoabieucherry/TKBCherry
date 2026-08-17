import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

root_dir = r"c:\Users\Love\Documents\Codex\TKBCherry"

def get_dir_size(path):
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                try:
                    total += os.path.getsize(fp)
                except:
                    pass
    return total

def format_size(size):
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024.0:
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} TB"

print(f"Total project size: {format_size(get_dir_size(root_dir))}\n")
print("Top-level directory sizes:")
for item in os.listdir(root_dir):
    item_path = os.path.join(root_dir, item)
    if os.path.isdir(item_path):
        size = get_dir_size(item_path)
        print(f"  {item}/: {format_size(size)}")
    else:
        size = os.path.getsize(item_path)
        print(f"  {item}: {format_size(size)}")

print("\nScanning for largest directories and files across the project:")
large_items = []
for dirpath, dirnames, filenames in os.walk(root_dir):
    for f in filenames:
        fp = os.path.join(dirpath, f)
        try:
            sz = os.path.getsize(fp)
            if sz > 5 * 1024 * 1024: # > 5MB
                rel = os.path.relpath(fp, root_dir)
                large_items.append((sz, rel))
        except:
            pass

large_items.sort(reverse=True)
for sz, rel in large_items[:25]:
    print(f"  {format_size(sz)} - {rel}")
