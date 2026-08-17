import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

def find_sid_handling():
    web_dir = r"C:\Users\Love\Documents\Codex\TKBCherry\web"
    for root, dirs, files in os.walk(web_dir):
        for f in files:
            if f.endswith(".js") or f.endswith(".html"):
                fpath = os.path.join(root, f)
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                    code = fp.read()
                if "sid" in code.lower() and ("getparams" in code.lower() or "urlsearchparams" in code.lower() or "location.search" in code.lower() or "sid" in code):
                    lines = code.splitlines()
                    for idx, line in enumerate(lines):
                        if "sid" in line and ("searchparams" in line.lower() or "sid" in line.lower() and "fetch" in line.lower() or "api" in line.lower() or "load" in line.lower()):
                            print(f"{os.path.relpath(fpath, web_dir)}:{idx+1} -> {line.strip()[:100]}")

if __name__ == "__main__":
    find_sid_handling()
