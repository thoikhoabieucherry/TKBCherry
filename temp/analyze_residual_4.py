import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

def analyze_residual_4():
    with open(r"C:\Users\Love\Documents\Codex\temp\school_default_gap7.json", "r", encoding="utf-8") as f:
        data = json.load(f)
        
    pccm = data.get("pccmMatrix", {})
    tkb = data.get("tkb", {})
    lop_list = data.get("lop", [])
    
    target_gvs = ["t.phương", "t.phát", "tn.nữ", "ti.hào"]
    
    # Check slots for these 4 teachers
    for gv_target in target_gvs:
        print(f"\n==================== GV: {gv_target} ====================")
        days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
        sessions = ["sang", "chieu"]
        
        for d in days:
            for s in sessions:
                lessons = []
                for cid, cdays in tkb.items():
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
                            pccm_key = f"{cid}|{mon}"
                            gv = str(pccm.get(pccm_key) or "").strip()
                        if gv_target in [t.strip().lower() for t in gv.replace(';', ',').replace('+', ',').split(',')]:
                            lessons.append((p_idx + 1, cid, mon))
                if lessons:
                    periods = sorted([l[0] for l in lessons])
                    span = periods[-1] - periods[0] + 1
                    gaps = span - len(periods)
                    print(f"  {d.upper()} {s:<6}: Periods {periods} (gap={gaps}) | Details: {lessons}")

if __name__ == "__main__":
    analyze_residual_4()
