import sys
sys.stdout.reconfigure(encoding='utf-8')
import analyze_temp_files as atf

print(f"=== TOTAL SINGLETONS (1 TIẾT/BUỔI): {len(atf.singletons)} ===")
for i, s in enumerate(atf.singletons):
    print(f"{i+1:2d}. GV {s['teacher']:15} | Thứ {s['day']} {s['session']:6} Tiết {s['period']} | {s['text']}")

print(f"\n=== TOTAL CLASS OFF-PERIOD VIOLATIONS: {len(atf.violations)} ===")
for i, v in enumerate(atf.violations):
    print(f"{i+1:2d}. Lớp {v['class']:6} | Thứ {v['day']} {v['session']:6} Tiết {v['period']} | GV {v['teacher']} - {v['subject']}")
