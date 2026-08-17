import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

backup_engine = r"C:\Users\Love\Documents\Codex\backup\TKBCherry\web\pages\tkb-fet-engine.js"
current_engine = r"c:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"

with open(backup_engine, "r", encoding="utf-8") as f:
    backup_text = f.read()

with open(current_engine, "r", encoding="utf-8") as f:
    current_text = f.read()

# Let's inspect where tryConsolidateTeacherSingletons starts in backup
pos_backup_start = backup_text.find("tryConsolidateTeacherSingletons(")
pos_backup_end = backup_text.rfind("global.FetTimetableEngine = FetTimetableEngine;")

print("Backup start pos:", pos_backup_start)
print("Backup end pos:", pos_backup_end)

# Let's see what methods exist between start and end in backup
snippet = backup_text[pos_backup_start:pos_backup_end]
print("Snippet length:", len(snippet))
