import sys
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

teacher_grid = atf.teacher_grid
class_grid = atf.class_grid
class_off_slots = atf.class_off_slots
slot_info = atf.slot_info
singletons = atf.singletons

print("================================================================================")
print("CHI TIẾT 15 TIẾT LẺ (1 TIẾT/BUỔI) CẦN XỬ LÝ TRONG THỜI KHÓA BIỂU")
print("================================================================================")

for i, s in enumerate(singletons):
    gv = s['teacher']
    slot = s['slot']
    day = s['day']
    session = s['session']
    period = s['period']
    raw_text = s['text']
    cname = raw_text.split('-')[0].strip()
    subj = raw_text.split('-')[1].strip() if '-' in raw_text else ''
    
    # Analyze teacher's whole week
    sched = teacher_grid[gv]
    teacher_sessions = []
    for d in range(6):
        for b in range(2):
            s_start = d * 10 + b * 5
            slots = [sched[s_start + p] for p in range(5)]
            taught = [(p+1, s_start + p, slots[p]) for p in range(5) if slots[p] is not None]
            if taught:
                d_name = slot_info[s_start]['day']
                b_name = slot_info[s_start]['session']
                teacher_sessions.append((d_name, b_name, d, b, s_start, taught))
    
    print(f"\n[{i+1}/15] GV: {gv} | Tiết lẻ: Thứ {day} {session} Tiết {period} (Lớp {cname}, Môn {subj})")
    print(f"  -> Tổng số buổi dạy trong tuần: {len(teacher_sessions)} buổi (Tổng {sum(len(ts[5]) for ts in teacher_sessions)} tiết)")
    print("  -> Chi tiết các buổi dạy của giáo viên:")
    for d_name, b_name, d, b, s_start, taught in teacher_sessions:
        is_current = (d_name == day and b_name == session)
        marker = " <=== [TIẾT LẺ CẦN GOM / CHUYỂN]" if is_current else ""
        tiet_str = ", ".join([f"Tiết {p} ({txt})" for p, s_idx, txt in taught])
        print(f"     * Thứ {d_name} {b_name:6} ({len(taught)} tiết): {tiet_str}{marker}")
    
    # Analyze the target class
    cls_sched = class_grid.get(cname, [None]*60)
    cls_sessions = []
    for d in range(6):
        for b in range(2):
            s_start = d * 10 + b * 5
            slots = [cls_sched[s_start + p] for p in range(5)]
            taught = [(p+1, s_start + p, slots[p]) for p in range(5) if slots[p] is not None]
            if taught:
                d_name = slot_info[s_start]['day']
                b_name = slot_info[s_start]['session']
                cls_sessions.append((d_name, b_name, d, b, s_start, taught))
    
    print(f"  -> Lớp {cname} học vào các buổi:")
    for d_name, b_name, d, b, s_start, taught in cls_sessions:
        tiet_str = ", ".join([f"T{p}:{txt[0]}" for p, s_idx, txt in taught])
        print(f"     * Thứ {d_name} {b_name:6} ({len(taught)} tiết): {tiet_str}")

