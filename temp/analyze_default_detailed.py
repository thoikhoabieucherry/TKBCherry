import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

def parse_teacher_list(raw):
    if not raw: return []
    if isinstance(raw, list): return [str(t).strip().lower() for t in raw if t]
    return [t.strip().lower() for t in str(raw).replace('\n', ',').replace(';', ',').replace('+', ',').split(',') if t.strip()]

def analyze_default_detailed():
    with open(r"C:\Users\Love\Documents\Codex\temp\school_default.json", "r", encoding="utf-8") as f:
        data = json.load(f)
        
    pccm = data.get("pccmMatrix", {})
    tkb = data.get("tkb", {})
    lop_list = data.get("lop", [])
    
    # Class map (id -> ten and ten -> id)
    class_map = {}
    for l in lop_list:
        cid = str(l.get("id") or "").strip()
        ten = str(l.get("ten") or "").strip()
        if cid: class_map[cid.lower()] = cid
        if ten: class_map[ten.lower()] = cid
        
    days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
    sessions = ["sang", "chieu"]
    
    # Grid: teacher -> (day, session) -> list of (period, classId, mon)
    teacher_grid = {}
    
    for cid, cdays in tkb.items():
        for d in days:
            for s in sessions:
                cells = cdays.get(d, {}).get(s, [])
                for p_idx, cell in enumerate(cells):
                    if not cell: continue
                    mon = ""
                    gv = ""
                    if isinstance(cell, dict):
                        mon = str(cell.get("mon") or "").strip()
                        gv = str(cell.get("gv") or "").strip()
                    elif isinstance(cell, str):
                        mon = cell.strip()
                        
                    if not gv and mon:
                        # Lookup in pccmMatrix
                        pccm_key = f"{cid}|{mon}"
                        gv = str(pccm.get(pccm_key) or "").strip()
                        if not gv:
                            # Try canon class
                            for l in lop_list:
                                if str(l.get("id")) == cid or str(l.get("ten")) == cid:
                                    ten = str(l.get("ten") or l.get("id"))
                                    gv = str(pccm.get(f"{ten}|{mon}") or "").strip()
                                    break
                                    
                    for t in parse_teacher_list(gv):
                        if t not in teacher_grid:
                            teacher_grid[t] = {}
                        key = (d, s)
                        if key not in teacher_grid[t]:
                            teacher_grid[t][key] = []
                        teacher_grid[t][key].append((p_idx + 1, cid, mon))
                        
    print("=== TEACHER GAP-2 ANALYSIS IN SCHOOL_DEFAULT ===")
    gap2_sessions = []
    for t, sess_map in sorted(teacher_grid.items()):
        for (d, s), lessons in sess_map.items():
            periods = sorted(list(set([l[0] for l in lessons])))
            if len(periods) >= 2:
                span = periods[-1] - periods[0] + 1
                gaps = span - len(periods)
                if gaps >= 2:
                    holes = [p for p in range(periods[0], periods[-1]+1) if p not in periods]
                    gap2_sessions.append((t, d, s, periods, holes, gaps, [(l[1], l[2], l[0]) for l in lessons]))
                    print(f"GV: {t:<15} | {d.upper():<5} {s:<6} | Periods: {periods} | Holes: {holes} (gap={gaps}) | Lessons: {lessons}")
                    
    print(f"\nTotal Gap-2 Sessions Found: {len(gap2_sessions)}")

if __name__ == "__main__":
    analyze_default_detailed()
