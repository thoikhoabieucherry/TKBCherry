"""Tra loi DUT DIEM: anh Cloud Run dang chay CO chua 2 bo giai moi khong?

Goi that /solve len Cloud Run voi du lieu rong cho tung engine, doc ly do
fallback (neu co). Chay:  python kiem_tra_flash_cherry.py
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

REMOTE = r'''
import json, os, subprocess, sys, time, urllib.request, urllib.error

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

RESULT_PREFIX = "@@TKB_RESULT@@"
PROGRESS_PREFIX = "@@TKB_PROGRESS@@"
HEARTBEAT_PREFIX = "@@TKB_CLOUD_HEARTBEAT@@"

def probe(engine):
    body = json.dumps({"data": {}, "settings": {"engine": engine}}).encode()
    req = urllib.request.Request(
        url + "/solve", data=body, method="POST",
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json",
                 "Accept": "application/x-ndjson, application/json",
                 "X-TKB-Cloud-Protocol": "tkb-cloud-solver-v1"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode("utf-8", "replace"), e.code
    dt = time.time() - t0

    stages, result_obj = [], None
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(HEARTBEAT_PREFIX):
            continue
        payload_txt = line
        for pref in (RESULT_PREFIX, PROGRESS_PREFIX, "TKB_SOLVER_RESULT:"):
            if payload_txt.startswith(pref):
                payload_txt = payload_txt[len(pref):].strip()
                break
        try:
            obj = json.loads(payload_txt)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        if obj.get("stage"):
            stages.append(str(obj.get("stage")) + ("  << " + str(obj.get("message")) if obj.get("message") else ""))
        if "payload" in obj or "solver" in obj or "metrics" in obj or "error" in obj:
            result_obj = obj

    print(f"\n=== ENGINE = {engine.upper()} — HTTP {status} sau {dt:.1f}s ===")
    for s in stages:
        print("   stage:", s[:140])
    inner = result_obj.get("payload") if isinstance(result_obj, dict) and isinstance(result_obj.get("payload"), dict) else result_obj
    runtime = {}
    if isinstance(inner, dict):
        runtime = ((inner.get("solver") or {}).get("runtime_settings") or {})
    reason = runtime.get("cherry_fallback_reason") or runtime.get("flash_fallback_reason")
    blob_all = json.dumps(result_obj, ensure_ascii=False) if result_obj else raw
    if not reason:
        for key in ("cherry_fallback_reason", "flash_fallback_reason"):
            i = blob_all.find(key)
            if i >= 0:
                reason = blob_all[i:i + 300]
                break
    fallback_stage = any("solver:fallback" in s for s in stages)
    if reason:
        print("   >> FALLBACK:", str(reason)[:300])
        if "ModuleNotFound" in str(reason) or "No module named" in str(reason):
            print(f"   >> KET LUAN: anh Cloud Run CHUA CO bo giai {engine} -> nut nay dang chay BO GIAI CU (cham).")
        elif "ortools" in str(reason).lower():
            print("   >> KET LUAN: anh Cloud Run THIEU thu vien ortools.")
        else:
            print("   >> Co module (loi khac, do data rong) -> nut nay CO chay bo giai moi.")
    elif fallback_stage:
        print("   >> Co stage solver:fallback nhung khong doc duoc ly do; xem stage o tren.")
    else:
        keys = sorted(runtime.keys())[:14]
        print("   >> KHONG co fallback -> anh Cloud Run CO bo giai moi. runtime keys:", keys)
    if not result_obj:
        print("   (khong tach duoc ket qua; 400 ky tu cuoi cua luong)")
        print("   ", raw[-400:].replace("\n", " | "))

print("URL:", url)
for eng in ("cherry", "flash"):
    try:
        probe(eng)
    except Exception as e:
        print(f"[{eng}] loi:", repr(e)[:300])
'''


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host} ...")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    sftp = c.open_sftp()
    with sftp.file("/tmp/tkb_probe3.py", "w") as fh:
        fh.write(REMOTE)
    sftp.close()
    _, out, err = c.exec_command("python3 /tmp/tkb_probe3.py", timeout=600)
    print(out.read().decode("utf-8", "replace"))
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("--- stderr ---\n" + tail[:1500])
    c.exec_command("rm -f /tmp/tkb_probe3.py")
    c.close()


if __name__ == "__main__":
    main()
