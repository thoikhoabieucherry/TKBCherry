import sys
import json
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def inspect_teacher_keys():
    # Check how teacher keys are handled in tkb-fet-engine.js
    engine_file = REPO_ROOT / "web" / "tkb-fet-engine.js"
    with open(engine_file, "r", encoding="utf-8") as f:
        code = f.read()

    # Search for parseTeacherList, teacherGrid, normalizeTeacher
    lines = code.split("\n")
    for i, line in enumerate(lines[:300]):
        if "teacher" in line.lower() or "parseteacher" in line.lower() or "teachergrid" in line.lower():
            print(f"Line {i+1}: {line}")

if __name__ == "__main__":
    inspect_teacher_keys()
