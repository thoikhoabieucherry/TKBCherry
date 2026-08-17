import sys

sys.stdout.reconfigure(encoding='utf-8')

def check_teacher_specific():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    # Check if optimize accepts teacherKey or options.targetTeacher
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if "targetTeacher" in line or "teacherKey" in line or "singleTeacher" in line:
            print(f"Line {i+1:4d}: {line.strip()[:110]}")

if __name__ == "__main__":
    check_teacher_specific()
