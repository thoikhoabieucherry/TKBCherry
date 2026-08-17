import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

def find_worker_refs():
    web_dir = r"C:\Users\Love\Documents\Codex\TKBCherry\web"
    for root, dirs, files in os.walk(web_dir):
        for f in files:
            if f.endswith(".js") or f.endswith(".html"):
                fpath = os.path.join(root, f)
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                    code = fp.read()
                if "tkb-fet-worker" in code or "tkb-fet-engine" in code:
                    print(f"Found in: {os.path.relpath(fpath, web_dir)}")
                    lines = code.splitlines()
                    for idx, line in enumerate(lines):
                        if "tkb-fet-worker" in line or "tkb-fet-engine" in line:
                            print(f"   Line {idx+1}: {line.strip()[:100]}")

if __name__ == "__main__":
    find_worker_refs()
