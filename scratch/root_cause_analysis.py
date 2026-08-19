import sys
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

print("================================================================================")
print("PHÂN TÍCH NGUYÊN NHÂN GỐC RỄ & PHƯƠNG ÁN XỬ LÝ CHO TỪNG TIẾT LẺ (1 TIẾT/BUỔI)")
print("================================================================================")

for i, s in enumerate(atf.singletons):
    gv = s['teacher']
    slot = s['slot']
    day = s['day']
    session = s['session']
    period = s['period']
    raw_text = s['text']
    cname = raw_text.split('-')[0].strip()
    subj = raw_text.split('-')[1].strip() if '-' in raw_text else ''
    
    sched = atf.teacher_grid[gv]
    
    # All sessions of teacher
    sess_list = []
    for d in range(6):
        for b in range(2):
            s_start = d * 10 + b * 5
            taught = [(p+1, s_start + p, sched[s_start + p]) for p in range(5) if sched[s_start + p] is not None]
            if taught:
                d_name = atf.slot_info[s_start]['day']
                b_name = atf.slot_info[s_start]['session']
                sess_list.append((d_name, b_name, d, b, s_start, taught))
                
    print(f"\n--- [{i+1}] GV {gv}: Tiết lẻ Thứ {day} {session} Tiết {period} ({raw_text}) ---")
    print(f"    * Tổng số tiết: {sum(len(x[5]) for x in sess_list)} tiết phân bổ qua {len(sess_list)} buổi:")
    for d_name, b_name, d, b, s_start, taught in sess_list:
        is_curr = (d_name == day and b_name == session)
        mk = " <=== [BUỔI LẺ 1 TIẾT]" if is_curr else ""
        print(f"      + Thứ {d_name} {b_name:6}: {len(taught)} tiết -> " + ", ".join([f"T{p}: {t[2]}" for p, s_idx, t in taught]) + mk)
        
    # Check potential sessions to merge into:
    # Look for sessions of the same shift (Sáng/Chiều) or other sessions where teacher has fewer than 5 periods
    print(f"    * Các buổi cùng ca ({session}) mà GV {gv} đang dạy có thể gom vào:")
    same_shift_sess = [x for x in sess_list if x[1] == session and not (x[0] == day and x[1] == session)]
    if same_shift_sess:
        for d_name, b_name, d, b, s_start, taught in same_shift_sess:
            free_periods = [p+1 for p in range(5) if sched[s_start + p] is None]
            print(f"      + Thứ {d_name} {b_name:6} (đang có {len(taught)} tiết): Trống tiết {free_periods}")
            # Check if class cname is learning at those free periods and not off
            for p_free in free_periods:
                s_cand = s_start + p_free - 1
                is_off = s_cand in atf.class_off_slots.get(cname, set())
                cls_curr = atf.class_grid.get(cname, [None]*60)[s_cand]
                curr_txt = cls_curr[2] if cls_curr else "Trống"
                curr_gv = cls_curr[0] if cls_curr else "None"
                print(f"        - Tiết {p_free} (Slot {s_cand}): Lớp {cname} đang có môn '{curr_txt}' (GV {curr_gv}), Nghỉ={is_off}")
    else:
        print(f"      (Không có buổi cùng ca {session} nào khác - GV này chỉ có đúng 1 buổi ca {session} trong tuần!)")
