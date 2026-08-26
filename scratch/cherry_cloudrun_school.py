"""Goi THAT Cloud Run bang du lieu THAT cua truong, engine = cherry.
Tra loi: bo giai dang chay tren web cho ra 2-tiet-trong bang bao nhieu.

Chay:  python scratch/cherry_cloudrun_school.py scratch/school_e3d7a3b21e1.json [giay]
Chi doc; khong ghi gi vao du lieu truong.
"""
import sys, json, base64, zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
sys.stdout.reconfigure(encoding='utf-8')
from vps_credentials import resolve_vps_connection
import paramiko

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else 'scratch/school_e3d7a3b21e1.json')
SECS = int(sys.argv[2]) if len(sys.argv) > 2 else 240

REMOTE_SCRIPT = r'''
import json, os, subprocess, sys, time, urllib.request, urllib.error, zlib, base64

SCRIPTS = "/opt/cherry-scheduler/solver_runtime/scripts"
sys.path.insert(0, SCRIPTS)

blob = subprocess.run("systemctl show tkb-app -p Environment --value", shell=True,
                      capture_output=True, text=True).stdout
for tok in blob.split():
    if "=" in tok:
        k, v = tok.split("=", 1)
        os.environ.setdefault(k, v)

url = os.environ.get("TKB_CLOUD_RUN_URL", "").strip().rstrip("/")
aud = os.environ.get("TKB_CLOUD_RUN_AUDIENCE", "").strip() or url
import cloud_run_client as crc
token = crc._identity_token(aud)

with open("/tmp/tkb_school_probe.b64", "r") as f:
    data = json.loads(zlib.decompress(base64.b64decode(f.read())).decode("utf-8"))

SECS = __SECS__
body = json.dumps({"data": data, "settings": {
    "engine": "cherry",
    "time_limit_seconds": SECS,
    "optimization_time_limit_seconds": SECS,
    "overall_time_limit_seconds": SECS,
    # Dung y nhu bridge gui (tkb-rust-bridge.js:10382-10388), neu thieu thi
    # watchdog cua Cloud Run mac dinh 180s va chem giua chung.
    "backend_deadline_ms": SECS * 1000,
    "native_global_deadline_ms": SECS * 1000,
    "reference_watchdog_deadline_ms": SECS * 1000,
    "native_deadline_reserve_ms": 500,
    "progress_estimate_seconds": SECS,
}}).encode()

req = urllib.request.Request(
    url + "/solve", data=body, method="POST",
    headers={"Authorization": "Bearer " + token,
             "Content-Type": "application/json",
             "Accept": "application/x-ndjson, application/json",
             "X-TKB-Cloud-Protocol": "tkb-cloud-solver-v1"})
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=SECS + 180) as r:
        raw = r.read().decode("utf-8", "replace")
        status = r.status
except urllib.error.HTTPError as e:
    raw, status = e.read().decode("utf-8", "replace"), e.code
dt = time.time() - t0

with open("/tmp/tkb_school_probe.raw", "w") as f:
    f.write(raw)

def rich(obj):
    if not isinstance(obj, dict):
        return None
    for cand in (obj, obj.get("payload") if isinstance(obj.get("payload"), dict) else None):
        if not isinstance(cand, dict):
            continue
        met = cand.get("metrics")
        if isinstance(met, dict) and ("expected_periods" in met or "scheduled_periods" in met):
            return cand
    return None

result_obj = None
seen_keys = []
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
    if isinstance(obj, dict):
        seen_keys.append(",".join(sorted(obj.keys()))[:110])
    r = rich(obj)
    if r is not None:
        result_obj = r
print("so dong doc duoc:", len(seen_keys))
for k in seen_keys[-4:]:
    print("   khoa:", k)

print("HTTP", status, "sau %.0fs" % dt)
inner = result_obj
m = (inner or {}).get("metrics") or {}
runtime = ((inner or {}).get("solver") or {}).get("runtime_settings") or {}
dist = m.get("gap_distribution") or {}
gap2 = sum(int(v) for k, v in dist.items() if str(k).isdigit() and int(k) >= 2)
print("engine_requested :", runtime.get("engine_requested") or runtime.get("engine"))
print("fallback_reason  :", runtime.get("cherry_fallback_reason"))
print("tiet xep         :", m.get("scheduled_periods"), "/", m.get("expected_periods"))
print("1 tiet/buoi      :", m.get("one_period_teacher_sessions"))
print("2 tiet trong     :", gap2)
print("buoi day         :", m.get("teacher_sessions"))
print("1 tiet trong     :", dist.get("1"))
print("gap_distribution :", json.dumps(dist, ensure_ascii=False))
'''


def main():
    raw = SRC.read_text(encoding='utf-8')
    packed = base64.b64encode(zlib.compress(raw.encode('utf-8'))).decode('ascii')
    print('Du lieu:', SRC.name, len(raw), 'bytes ->', len(packed), 'bytes nen')

    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30,
                   look_for_keys=False, allow_agent=False)

    sftp = client.open_sftp()
    with sftp.open('/tmp/tkb_school_probe.b64', 'w') as f:
        f.write(packed)
    script = REMOTE_SCRIPT.replace('__SECS__', str(SECS))
    with sftp.open('/tmp/tkb_school_probe.py', 'w') as f:
        f.write(script)
    sftp.close()

    _, out, err = client.exec_command('python3 /tmp/tkb_school_probe.py', timeout=SECS + 300)
    print(out.read().decode('utf-8', 'replace'))
    e = err.read().decode('utf-8', 'replace').strip()
    if e:
        print('STDERR:', e[:1500])
    client.exec_command('rm -f /tmp/tkb_school_probe.b64')
    client.close()


if __name__ == '__main__':
    main()
