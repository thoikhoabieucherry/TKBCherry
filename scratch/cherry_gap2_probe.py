# Chay engine Cherry v3 tren mot bo du lieu DA XEP DU 100% -> xem no xu ly gap2 toi dau.
#   python scratch/cherry_gap2_probe.py scratch/live_default.json 120
import json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'solver_runtime' / 'src'))
sys.stdout.reconfigure(encoding='utf-8')

from tkb_engine_v3.entry import solve_from_ui_data_v3

DAYS = ['thu2', 'thu3', 'thu4', 'thu5', 'thu6', 'thu7']
SESS = ['sang', 'chieu']


def metrics_from_tkb(ui_data, tkb):
    """Do lai dung cong thuc cua UI: voi moi GV x moi buoi."""
    grid = {}   # teacher -> {(day,sess): set(period)}
    for cls_id, cls_tkb in (tkb or {}).items():
        if not isinstance(cls_tkb, dict):
            continue
        for key, cell in cls_tkb.items():
            if not isinstance(cell, dict):
                continue
            gv = cell.get('gv') or cell.get('teacher')
            if not gv:
                continue
            parts = str(key).split('-')
            if len(parts) < 3:
                continue
            day, sess, per = parts[0], parts[1], parts[2]
            try:
                p = int(per) - 1
            except ValueError:
                continue
            for one in str(gv).replace('+', ',').split(','):
                one = one.strip()
                if not one:
                    continue
                grid.setdefault(one, {}).setdefault((day, sess), set()).add(p)

    s1 = g1 = g2 = buoi = 0
    for gv, sessions in grid.items():
        for _, ps in sessions.items():
            k = len(ps)
            if k == 0:
                continue
            buoi += 1
            if k == 1:
                s1 += 1
            span = max(ps) - min(ps) + 1
            gaps = span - k
            if gaps == 1:
                g1 += 1
            elif gaps >= 2:
                g2 += 1
    return {'s1': s1, 'gap2': g2, 'buoi': buoi, 'gap1': g1}


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'scratch/live_default.json'
    secs = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    data = json.loads(Path(src).read_text(encoding='utf-8'))

    before = metrics_from_tkb(data, data.get('tkb'))
    print('TRUOC (lich hien co):', before)

    t0 = time.time()
    res = solve_from_ui_data_v3(data, settings={'time_limit_seconds': secs})
    took = time.time() - t0

    tkb = res.get('tkb') if isinstance(res, dict) else None
    if not tkb:
        print('Khong co tkb trong ket qua. Cac khoa:', list(res.keys())[:30] if isinstance(res, dict) else type(res))
        return
    after = metrics_from_tkb(data, tkb)
    print('SAU   (Cherry v3)   :', after, f'| {took:.0f}s')
    m = res.get('metrics') or {}
    keep = {k: v for k, v in m.items() if any(x in k for x in ('gap', 'one_period', 'session', 'placed', 'expected'))}
    print('metrics engine bao  :', json.dumps(keep, ensure_ascii=False)[:400])


if __name__ == '__main__':
    main()
