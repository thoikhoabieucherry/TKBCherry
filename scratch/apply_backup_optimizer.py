import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

backup_engine = r"C:\Users\Love\Documents\Codex\backup\TKBCherry\web\pages\tkb-fet-engine.js"
current_engine = r"c:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"

with open(backup_engine, "r", encoding="utf-8") as f:
    backup_text = f.read()

with open(current_engine, "r", encoding="utf-8") as f:
    current_text = f.read()

# Marker in backup: from "    tryConsolidateTeacherSingletons(" to the end of FetTimetableEngine class
marker_start = "    tryConsolidateTeacherSingletons("
marker_end = "    }\n  }\n\n  global.FetTimetableEngine = FetTimetableEngine;"

pos_b_start = backup_text.find(marker_start)
pos_b_end = backup_text.rfind(marker_end)

if pos_b_start == -1 or pos_b_end == -1:
    print("Could not find markers in backup! pos_b_start:", pos_b_start, "pos_b_end:", pos_b_end)
    sys.exit(1)

optimizer_code_backup = backup_text[pos_b_start:pos_b_end]

pos_c_start = current_text.find(marker_start)
pos_c_end = current_text.rfind(marker_end)

if pos_c_start == -1 or pos_c_end == -1:
    print("Could not find markers in current! pos_c_start:", pos_c_start, "pos_c_end:", pos_c_end)
    sys.exit(1)

new_current_text = current_text[:pos_c_start] + optimizer_code_backup + current_text[pos_c_end:]

with open(current_engine, "w", encoding="utf-8") as f:
    f.write(new_current_text)

print("Successfully replaced optimizer section in web/pages/tkb-fet-engine.js with backup version!")
