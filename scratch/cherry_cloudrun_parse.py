"""Doc lai luong ket qua Cloud Run da luu o /tmp/tkb_school_probe.raw tren VPS
va bao chi so chat luong. Chi doc.
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
sys.stdout.reconfigure(encoding='utf-8')
from vps_credentials import resolve_vps_connection
import paramiko

REMOTE = r'''
import json

raw = open("/tmp/tkb_school_probe.raw", "r").read()
last = None
for line in raw.splitlines():
    line = line.strip()
    if not line or line.startswith("@@TKB_CLOUD_HEARTBEAT@@"):
        continue
    txt = line
    for pref in ("@@TKB_RESULT@@", "@@TKB_PROGRESS@@", "TKB_SOLVER_RESULT:"):
        if txt.startswith(pref):
            txt = txt[len(pref):].strip()
            break
    try:
        obj = json.loads(txt)
    except Exception:
        continue
    if isinstance(obj, dict) and "payload" in obj:
        last = obj

if not last:
    print("khong tim thay dong ket qua")
    raise SystemExit(0)

p = last.get("payload")
print("status      :", last.get("status"))
print("payload keys:", sorted(p.keys()) if isinstance(p, dict) else type(p))
if isinstance(p, dict):
    for k in ("ok", "kind", "error", "detail"):
        if k in p:
            print("   %-10s = %s" % (k, json.dumps(p[k], ensure_ascii=False)[:600]))
    m = p.get("metrics")
    print("metrics keys:", sorted(m.keys())[:40] if isinstance(m, dict) else type(m))
    if isinstance(m, dict):
        for k in ("scheduled_periods", "expected_periods", "one_period_teacher_sessions",
                  "teacher_sessions", "gap_distribution", "teacher_gap2_sessions",
                  "teacher_gap1_sessions", "soBuoiDay1", "soBuoiTrong2"):
            if k in m:
                print("   %-28s = %s" % (k, json.dumps(m[k], ensure_ascii=False)[:200]))
    s = p.get("solver")
    if isinstance(s, dict):
        rs = s.get("runtime_settings") or {}
        for k in sorted(rs.keys()):
            if "engine" in k or "fallback" in k or "time" in k:
                print("   runtime.%-24s = %s" % (k, json.dumps(rs[k], ensure_ascii=False)[:160]))
    v = p.get("validation")
    if isinstance(v, dict):
        print("validation  :", json.dumps({k: v[k] for k in list(v.keys())[:8]}, ensure_ascii=False)[:300])
'''

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30,
               look_for_keys=False, allow_agent=False)
sftp = client.open_sftp()
with sftp.open('/tmp/tkb_school_parse.py', 'w') as f:
    f.write(REMOTE)
sftp.close()
_, out, err = client.exec_command('python3 /tmp/tkb_school_parse.py', timeout=120)
print(out.read().decode('utf-8', 'replace'))
e = err.read().decode('utf-8', 'replace').strip()
if e:
    print('STDERR:', e[:1000])
client.close()
