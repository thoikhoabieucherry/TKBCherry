import sys
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

print(f"=== TOTAL SINGLETONS (1 TIẾT/BUỔI): {len(atf.singletons)} ===")
for s in atf.singletons:
    print(f"GV {s['teacher']:15} | Thứ {s['day']} {s['session']} Tiết {s['period']} | {s['text']}")

print(f"\n=== TOTAL CLASS OFF-PERIOD VIOLATIONS: {len(atf.violations)} ===")
for v in atf.violations:
    print(f"Lớp {v['class']:6} | Thứ {v['day']} {v['session']} Tiết {v['period']} | GV {v['teacher']} - {v['subject']}")

print(f"\n=== TOTAL GAPS (BUỔI LỦNG/TIẾT TRỐNG): {len(atf.gaps)} ===")
for g in atf.gaps:
    print(f"GV {g['teacher']:15} | Thứ {g['day']} {g['session']} | Tiết: {g['periods']}")
