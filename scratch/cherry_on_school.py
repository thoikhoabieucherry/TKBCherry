# Chay Cherry v3 tren du lieu truong that -> bao chi so chat luong.
#   python scratch/cherry_on_school.py scratch/school_e3d7a3b21e1.json 240
import json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'solver_runtime' / 'src'))
sys.stdout.reconfigure(encoding='utf-8')
from tkb_engine_v3.entry import solve_from_ui_data_v3

src = sys.argv[1] if len(sys.argv) > 1 else 'scratch/school_e3d7a3b21e1.json'
secs = int(sys.argv[2]) if len(sys.argv) > 2 else 240

data = json.loads(Path(src).read_text(encoding='utf-8'))
t0 = time.time()
res = solve_from_ui_data_v3(data, settings={'time_limit_seconds': secs})
took = time.time() - t0

m = res.get('metrics') or {}
dist = m.get('gap_distribution') or {}
gap2 = sum(int(v) for k, v in dist.items() if str(k).isdigit() and int(k) >= 2)
print('thoi gian      : %.0fs' % took)
print('tiet xep       : %s/%s' % (m.get('scheduled_periods'), m.get('expected_periods')))
print('1 tiet/buoi    :', m.get('one_period_teacher_sessions'))
print('2 tiet trong   :', gap2)
print('buoi day       :', m.get('teacher_sessions'))
print('1 tiet trong   :', dist.get('1'))
print('gap_distribution:', json.dumps(dist, ensure_ascii=False))

out = Path(src).with_name(Path(src).stem + '_cherry_result.json')
out.write_text(json.dumps(res, ensure_ascii=False), encoding='utf-8')
print('da luu ket qua ->', out)
