import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

with open(r"c:\Users\Love\Documents\Codex\temp\analysis_results.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print("=== INITIAL 2-GAPS IN BASE ===")
initial_gaps = data['initial_gaps']
print(f"Total teachers with 2-gaps: {len(initial_gaps)}")
total_g2_count = sum(len(v) for v in initial_gaps.values())
print(f"Total 2-gap occurrences: {total_g2_count}")
for gv, glist in initial_gaps.items():
    print(f"  Teacher: {gv} ({len(glist)} gap(s))")
    for g in glist:
        print(f"    - Day {g['day']}, Sess {g['sess']}, Periods {g['periods']}, Teaching: {g['teaching']}")

print("\n" + "="*80)
print("=== SEQUENTIAL STEPS IN SMARTSCHEDULER (1 to 20) ===")
print("="*80)

for s in data['steps']:
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
    print(f"    Cell moves count: {s['num_cell_changes_lop']}")
    for cls, moves in lop_changes.items():
        print(f"    [Class {cls}]:")
        for m in moves:
            print(f"       - Day {m['day']} {m['sess']} P{m['period']}: '{m['before']}'  ==>  '{m['after']}'")

print("\n" + "="*80)
print("=== VESION DIRECT OPTIMIZATIONS (base -> Teacher) ===")
print("="*80)
for gv, vinfo in data['vesion_teachers'].items():
    print(f"\n>>> Teacher: {gv} (2-Gaps: {vinfo['before_gaps_2']} -> {vinfo['after_gaps_2']})")
    print(f"    Classes affected: {vinfo['changed_classes']}")
    print(f"    Teachers involved: {vinfo['changed_teachers']}")
    for cls, moves in vinfo['lop_changes'].items():
        print(f"    [Class {cls}]:")
        for m in moves:
            print(f"       - Day {m['day']} {m['sess']} P{m['period']}: '{m['before']}'  ==>  '{m['after']}'")
