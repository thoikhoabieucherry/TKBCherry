import sys
from parse_md_schedule import parse_tonggv_file

sys.stdout.reconfigure(encoding='utf-8')

def find_all_span_gaps_ge2():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    
    days = ["2", "3", "4", "5", "6", "7"]
    sessions = ["Sáng", "Chiều"]
    
    gap_sessions = []
    for t in teachers.values():
        for d in days:
            for s in sessions:
                teaching = []
                for p in range(1, 6):
                    v = gv_grid.get((t, d, s, str(p)), "")
                    if v != "":
                        teaching.append((p, v))
                if len(teaching) >= 2:
                    ps = [item[0] for item in teaching]
                    holes = (ps[-1] - ps[0] + 1) - len(ps)
                    if holes >= 2:
                        gap_sessions.append({
                            'teacher': t,
                            'day': d,
                            'sess': s,
                            'holes': holes,
                            'teaching': teaching,
                            'teaching_ps': ps
                        })
                        
    print(f"Total sessions with holes >= 2: {len(gap_sessions)}")
    for i, item in enumerate(gap_sessions, 1):
        print(f"{i}. Teacher: {item['teacher']:<15} | Thứ {item['day']} ({item['sess']}) | Số lỗ: {item['holes']} | Tiết dạy: {item['teaching_ps']} -> {item['teaching']}")

if __name__ == "__main__":
    find_all_span_gaps_ge2()
