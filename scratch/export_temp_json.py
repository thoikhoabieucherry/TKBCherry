import json, sys
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

data = {
    'teachers': list(atf.teacher_grid.keys()),
    'classes': list(atf.class_grid.keys()),
    'teacher_grid': atf.teacher_grid,
    'class_grid': atf.class_grid,
    'class_off_slots': {k: list(v) for k, v in atf.class_off_slots.items()},
    'slot_info': atf.slot_info,
    'singletons': atf.singletons
}

with open('temp_data.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("Saved temp_data.json successfully!")
