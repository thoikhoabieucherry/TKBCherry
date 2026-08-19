import sys
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

print("=== TẤT CẢ 15 GIÁO VIÊN CÓ TIẾT LẺ VÀ LỊCH ĐẦY ĐỦ CỦA HỌ ===")

for i, s in enumerate(atf.singletons):
    gv = s['teacher']
    slot = s['slot']
    sched = atf.teacher_grid[gv]
    print(f"\n[{i+1}] GV: {gv} (Tổng {sum(1 for x in sched if x is not None)} tiết)")
    for d in range(6):
        for b in range(2):
            s_start = d * 10 + b * 5
            slots = [sched[s_start + p] for p in range(5)]
            taught = [(p+1, slots[p]) for p in range(5) if slots[p] is not None]
            if taught:
                d_name = atf.slot_info[s_start]['day']
                b_name = atf.slot_info[s_start]['session']
                t_str = ", ".join([f"T{p}: {txt}" for p, txt in taught])
                is_sing = (len(taught) == 1)
                sing_mark = " <=== [1 TIẾT/BUỔI]" if is_sing else ""
                print(f"    Thứ {d_name} {b_name:6} ({len(taught)} tiết): {t_str}{sing_mark}")
