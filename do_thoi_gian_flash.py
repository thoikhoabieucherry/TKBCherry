"""Do THAT: chay Flash (hoac Cherry) tren DU LIEU THAT qua Cloud Run.

Khong dung UI, khong ghi de lich cua ban — chi doc du lieu tu DB roi goi
Cloud Run va bao cao: bao lau, co du tiet khong, chat luong ra sao.

Chay:  python do_thoi_gian_flash.py            (mac dinh: flash)
       python do_thoi_gian_flash.py cherry
       python do_thoi_gian_flash.py flash 120  (dat ngan sach 120 giay)
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

ENGINE = (sys.argv[1] if len(sys.argv) > 1 else "flash").strip().lower()
BUDGET = int(sys.argv[2]) if len(sys.argv) > 2 else 200

REMOTE_TMPL = r'''
import json, os, sqlite3, subprocess, sys, time, urllib.request, urllib.error

ENGINE = "__ENGINE__"
BUDGET = __BUDGET__
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

conn = sqlite3.connect("file:/opt/cherry-scheduler/rust_api/tkb_store.db?mode=ro", uri=True, timeout=15)
cur = conn.cursor()
cur.execute("SELECT v FROM kvstore WHERE k='school_default'")
row = cur.fetchone()
conn.close()
if not row:
    print("Khong tim thay du lieu truong 'default' trong DB."); raise SystemExit(1)
data = json.loads(row[0])
n_lop = len(data.get("lop") or [])
n_pccm = len(data.get("pccmMatrix") or {})
print(f"Du lieu that: {n_lop} lop, {n_pccm} o phan cong. Engine={ENGINE}, ngan sach={BUDGET}s")

settings = {
    "engine": ENGINE,
    "solver_mode": "auto",
    "overall_time_limit_seconds": BUDGET,
    "integrated_time_limit": BUDGET,
    "optimization_time_limit_seconds": BUDGET,
    "progress_estimate_seconds": BUDGET,
    "backend_deadline_ms": BUDGET * 1000,
    "native_global_deadline_ms": BUDGET * 1000,
    "best_effort_on_timeout": True,
    "require_complete_schedule": False,
    "num_workers": 6,
}
body = json.dumps({"data": data, "settings": settings}).encode()
print(f"Kich thuoc request: {len(body)/1024:.0f} KB — dang goi Cloud Run ...")

RESULT_PREFIX = "@@TKB_RESULT@@"
PROGRESS_PREFIX = "@@TKB_PROGRESS@@"
HEARTBEAT_PREFIX = "@@TKB_CLOUD_HEARTBEAT@@"

req = urllib.request.Request(url + "/solve", data=body, method="POST",
    headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
             "Accept": "application/x-ndjson, application/json",
             "X-TKB-Cloud-Protocol": "tkb-cloud-solver-v1"})
t0 = time.time()
stages, result_obj, status = [], None, 0
try:
    with urllib.request.urlopen(req, timeout=BUDGET + 120) as r:
        status = r.status
        for raw_line in r:
            line = raw_line.decode("utf-8", "replace").strip()
            if not line or line.startswith(HEARTBEAT_PREFIX):
                continue
            txt = line
            for pref in (RESULT_PREFIX, PROGRESS_PREFIX, "TKB_SOLVER_RESULT:"):
                if txt.startswith(pref):
                    txt = txt[len(pref):].strip(); break
            try:
                obj = json.loads(txt)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            if obj.get("stage"):
                el = time.time() - t0
                msg = str(obj.get("message") or "")[:110]
                stages.append(f"{el:6.1f}s  {obj.get('stage')}  {msg}")
            if "payload" in obj or "metrics" in obj or "solver" in obj or "error" in obj:
                result_obj = obj
except urllib.error.HTTPError as e:
    status = e.code
    print("HTTPError", e.code, e.read(600).decode("utf-8", "replace")[:600])
except Exception as e:
    print("Loi goi:", repr(e)[:300])
dt = time.time() - t0

print(f"\n--- TIEN TRINH ({len(stages)} moc) ---")
for s in stages:
    print("  " + s)

inner = result_obj.get("payload") if isinstance(result_obj, dict) and isinstance(result_obj.get("payload"), dict) else result_obj
print(f"\n--- KET QUA: HTTP {status} sau {dt:.1f} GIAY ---")
if isinstance(inner, dict):
    m = inner.get("metrics") or {}
    runtime = ((inner.get("solver") or {}).get("runtime_settings") or {})
    print("  ok =", inner.get("ok"), "| kind =", inner.get("kind"))
    for k in ("expected_periods", "scheduled_periods", "unassigned_periods",
              "teacher_single_period_sessions", "teacher_gap2_sessions",
              "teacher_sessions", "teacher_gap1_sessions", "app_constraint_violation_count"):
        if k in m:
            print(f"  {k} = {m[k]}")
    for k in ("cherry_fallback_reason", "flash_fallback_reason", "engine", "elapsed_seconds"):
        if k in runtime:
            print(f"  runtime.{k} = {str(runtime[k])[:220]}")
    if inner.get("error"):
        print("  error =", str(inner.get("error"))[:300])
else:
    print("  (khong tach duoc ket qua)")
'''


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host} ...")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    sftp = c.open_sftp()
    with sftp.file("/tmp/tkb_time_probe.py", "w") as fh:
        fh.write(REMOTE_TMPL.replace("__ENGINE__", ENGINE).replace("__BUDGET__", str(BUDGET)))
    sftp.close()
    _, out, err = c.exec_command("python3 /tmp/tkb_time_probe.py", timeout=BUDGET + 300)
    print(out.read().decode("utf-8", "replace"))
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("--- stderr ---\n" + tail[:2000])
    c.exec_command("rm -f /tmp/tkb_time_probe.py")
    c.close()


if __name__ == "__main__":
    main()
