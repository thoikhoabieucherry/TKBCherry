import sys

sys.stdout.reconfigure(encoding='utf-8')

def check_remote_load():
    app_js_path = r"C:\Users\Love\Documents\Codex\TKBCherry\web\app.js"
    with open(app_js_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
        
    for idx, line in enumerate(lines):
        if "loadRemoteSchoolData" in line or "loadRemoteSchool" in line:
            print(f"Line {idx+1}: {line}")
            for j in range(max(0, idx - 10), min(len(lines), idx + 30)):
                print(f"{j+1:4d}: {lines[j]}", end="")
            break

if __name__ == "__main__":
    check_remote_load()
