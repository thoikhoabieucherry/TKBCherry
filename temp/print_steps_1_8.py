import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

with open(r"c:\Users\Love\Documents\Codex\temp\analysis_results.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for s in data['steps'][:9]:
    step_num = s['step']
    rem_2 = s['remaining_2_gaps']
    rem_1 = s['remaining_1_gaps']
    beneficiaries = s['beneficiaries']
    changed_teachers = s['changed_teachers']
    changed_classes = s['changed_classes']
    lop_changes = s['lop_changes']
    
    b_text = ", ".join([f"{b['gv']} ({b['before']} -> {b['after']})" for b in beneficiaries])
    print(f"\n>>> STEP {step_num} ({s['file']}) | Remaining 2-Gaps: {rem_2} | 1-Gaps: {rem_1}")
    print(f"    Target/Beneficiary: {b_text if b_text else 'None directly identified'}")
    print(f"    Classes affected ({len(changed_classes)}): {list(changed_classes)}")
    print(f"    Teachers involved ({len(changed_teachers)}): {list(changed_teachers)}")
    for cls, moves in lop_changes.items():
        print(f"    [Class {cls}]:")
        for m in moves:
            print(f"       - Day {m['day']} {m['sess']} P{m['period']}: '{m['before']}'  ==>  '{m['after']}'")
