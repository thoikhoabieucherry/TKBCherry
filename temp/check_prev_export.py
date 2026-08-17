import sys
from parse_md_schedule import parse_tonggv_file
from analyze_session_loads import analyze_session_loads

sys.stdout.reconfigure(encoding='utf-8')

def check_previous_export():
    filepath = r"C:\Users\Love\Documents\Codex\MD\tonggv0417082026_TOI_UU_2_TIET_TRONG.xlsx"
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(filepath)
    single_count, counts_by_teacher, single_list = analyze_session_loads(teachers, gv_grid)
    
    print(f"Total 1-period sessions in previous export: {single_count}")
    for s in single_list:
        print(f"  Teacher {s[0]:<15} | Thứ {s[1]} ({s[2]}) | Tiết {s[3][0]}: {s[3][1]}")

if __name__ == "__main__":
    check_previous_export()
