import sys
import os
import openpyxl
import json

sys.stdout.reconfigure(encoding='utf-8')

from parse_md_schedule import parse_tonggv_file

def export_to_cherry_data(xlsx_path, json_out_path):
    teachers, slot_to_row, row_to_slot, gv_grid, lop_grid = parse_tonggv_file(xlsx_path)
    
    # Classes list
    classes_set = set(k[0] for k in lop_grid.keys())
    lop_list = [{"id": cls, "ten": cls} for cls in sorted(list(classes_set))]
    
    # Teachers list & pccm
    pccm_matrix = {}
    
    # TKB structure: tkb[classId][thu][buoi][periodIdx] = cell object { mon, gv, room }
    days_map = {"2": "thu2", "3": "thu3", "4": "thu4", "5": "thu5", "6": "thu6", "7": "thu7"}
    sess_map = {"Sáng": "sang", "Chiều": "chieu"}
    
    tkb = {}
    for cls in classes_set:
        tkb[cls] = {}
        for d in ["2", "3", "4", "5", "6", "7"]:
            thu_key = days_map[d]
            tkb[cls][thu_key] = {
                "sang": [None] * 5,
                "chieu": [None] * 5
            }
            
    for (cls, day, sess, p_str), (teacher, subj, raw) in lop_grid.items():
        thu_key = days_map[day]
        buoi_key = sess_map[sess]
        p_idx = int(p_str) - 1
        cell = {
            "mon": subj,
            "gv": teacher,
            "room": ""
        }
        tkb[cls][thu_key][buoi_key][p_idx] = cell
        
        pccm_key = f"{cls}|{subj}"
        pccm_matrix[pccm_key] = teacher
        
    data = {
        "lop": lop_list,
        "pccmMatrix": pccm_matrix,
        "tkb": tkb,
        "tkbConstraints": {}
    }
    
    with open(json_out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        
    print(f"Exported {len(lop_list)} classes, {len(pccm_matrix)} pccm assignments to {json_out_path}")

if __name__ == "__main__":
    xlsx_file = r"C:\Users\Love\Documents\Codex\MD\tonggv0517082026.xlsx"
    json_file = r"C:\Users\Love\Documents\Codex\temp\data_tonggv05.json"
    export_to_cherry_data(xlsx_file, json_file)
