import sys, copy, json
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

teacher_grid = copy.deepcopy(atf.teacher_grid)
class_grid = copy.deepcopy(atf.class_grid)
class_off_slots = atf.class_off_slots
slot_info = atf.slot_info
teachers = list(teacher_grid.keys())
classes = list(class_grid.keys())

def get_singletons(t_grid):
    sing = []
    for tname, sched in t_grid.items():
        for d in range(6):
            for b in range(2):
                s_start = d * 10 + b * 5
                taught = [(p, s_start + p, sched[s_start + p]) for p in range(5) if sched[s_start + p] is not None]
                if len(taught) == 1:
                    p, s_idx, text = taught[0]
                    info = slot_info[s_idx]
                    sing.append({
                        'teacher': tname,
                        'day': info['day'],
                        'session': info['session'],
                        'period': info['period'],
                        'slot': s_idx,
                        'text': text
                    })
    return sing

exempted = {'TN.Sương', 'A.Khánh'}
all_s = get_singletons(teacher_grid)
non_exempt_s = [s for s in all_s if s['teacher'] not in exempted]

print(f"Tổng số tiết lẻ ban đầu: {len(all_s)}")
print(f"Số tiết lẻ trừ cô Sương & thầy Khánh: {len(non_exempt_s)}")

for s in non_exempt_s:
    print(f"- GV {s['teacher']}: Thứ {s['day']} {s['session']} Tiết {s['period']} ({s['text']})")
