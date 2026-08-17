import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

def analyze_default_gaps():
    with open(r"C:\Users\Love\Documents\Codex\temp\school_default.json", "r", encoding="utf-8") as f:
        data = json.load(f)
        
    days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
    sessions = ["sang", "chieu"]
    
    # Map teacher -> slot -> list of (classId, mon)
    teacher_slots = {}
    tkb = data.get("tkb", {})
    
    for cid, cdays in tkb.items():
        for d_idx, d in enumerate(days):
            for s_idx, s in enumerate(sessions):
                cells = cdays.get(d, {}).get(s, [])
                for p_idx, cell in enumerate(cells):
                    if not cell or not isinstance(cell, dict):
                        continue
                    gv = str(cell.get("gv") or "").strip().lower()
                    mon = str(cell.get("mon") or "").strip()
                    if not gv:
                        continue
                    if gv not in teacher_slots:
                        teacher_slots[gv] = {}
                    slot_key = (d, s)
                    if slot_key not in teacher_slots[gv]:
                        teacher_slots[gv][slot_key] = []
                    teacher_slots[gv][slot_key].append((p_idx + 1, cid, mon))
                    
    print("=== TEACHER GAP-2 BREAKDOWN IN SCHOOL_DEFAULT ===")
    gap2_count = 0
    gap1_count = 0
    for gv, session_dict in sorted(teacher_slots.items()):
        for (d, s), lessons in session_dict.items():
            periods = sorted([l[0] for l in lessons])
            if len(periods) >= 2:
                span = periods[-1] - periods[0] + 1
                gaps = span - len(periods)
                if gaps >= 2:
                    gap2_count += 1
                    holes = [p for p in range(periods[0], periods[-1]+1) if p not in periods]
                    print(f"GV: {gv:<15} | {d.upper():<5} {s:<6} | Periods: {periods} | Holes: {holes} (gap={gaps}) | Lessons: {[(l[1], l[2]) for l in lessons]}")
                elif gaps == 1:
                    gap1_count += 1
                    
    print(f"\nTotal Gap-2 Sessions: {gap2_count}")
    print(f"Total Gap-1 Sessions: {gap1_count}")

if __name__ == "__main__":
    analyze_default_gaps()
