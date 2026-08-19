"""Chan doan v2: Cloud Run co dang chay 2 thuat toan moi (Cherry / Flash) khong.

Chay:  python chan_doan_cloudrun2.py
Chi doc + goi thu 2 request rat nho (data rong) len Cloud Run.
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

ROOT = "/opt/cherry-scheduler"
SCRIPTS = ROOT + "/solver_runtime/scripts"
SRC = ROOT + "/solver_runtime/src"

def sh(c, t=60):
    try:
        r = subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t)
        return ((r.stdout or "") + (r.stderr or "")).strip()
    except Exception as e:
        return f"<loi: {e}>"

print("=" * 72)
print("A) TREN VPS: hai bo giai moi da co chua?")
print("=" * 72)
print(sh(f"ls -la {SRC} 2>&1 | head -10"))
print("- tkb_engine_v3:", sh(f"ls {SRC}/tkb_engine_v3 2>&1 | tr '\\n' ' '")[:300])
print("- import thu:", sh(f"cd {SRC} && python3 -c \"import tkb_engine_v3.entry, tkb_engine_v3.cpsat_modes; print('IMPORT OK')\" 2>&1")[:400])
print("- solve_stdio co dinh tuyen engine:", sh(f"grep -c 'tkb_engine_v3' {SCRIPTS}/solve_stdio.py"))

print()
print("=" * 72)
print("B) LAY ID TOKEN BANG DUNG LOGIC CUA CLIENT THAT")
print("=" * 72)
sys.path.insert(0, SCRIPTS)
url = os.environ.get("TKB_CLOUD_RUN_URL", "").strip().rstrip("/")
aud = os.environ.get("TKB_CLOUD_RUN_AUDIENCE", "").strip() or url
if not url:
    # doc tu unit systemd neu tien trinh nay khong thua ke env
    blob = sh("systemctl show tkb-app -p Environment --value")
    for tok in blob.split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            os.environ.setdefault(k, v)
    url = os.environ.get("TKB_CLOUD_RUN_URL", "").strip().rstrip("/")
    aud = os.environ.get("TKB_CLOUD_RUN_AUDIENCE", "").strip() or url
print("URL:", url or "(khong co)")
token = ""
try:
    import cloud_run_client as crc
    token = crc._identity_token(aud)
    print(f"ID token: LAY DUOC ({len(token)} ky tu) — dung ca 2 duong (ADC + IAM generateIdToken)")
except Exception as e:
    print("ID token: THAT BAI ->", repr(e)[:400])

def call(path, body=None, extra=None, timeout=120):
    req_url = url + path
    headers = {"X-TKB-Cloud-Protocol": "tkb-cloud-solver-v1",
               "Accept": "application/x-ndjson, application/json",
               "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if extra:
        headers.update(extra)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(req_url, data=data, headers=headers,
                                 method="POST" if data is not None else "GET")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:
        return 0, f"<khong goi duoc: {e}>", time.time() - t0

print()
print("=" * 72)
print("C) CLOUD RUN CO SONG KHONG? (GET /health)")
print("=" * 72)
if not url:
    print("bo qua (khong co URL)")
else:
    st, body, dt = call("/health", timeout=90)
    print(f"HTTP {st} sau {dt:.1f}s -> {body[:400]}")
    if st == 200:
        try:
            h = json.loads(body)
            print("  revision =", h.get("revision"))
            print("  solverDigest =", str(h.get("solverDigest"))[:16], "...")
            envd = os.environ.get("TKB_CLOUD_RUN_SOLVER_DIGEST", "").strip().lower()
            print("  digest VPS mong doi =", envd[:16], "...",
                  "TRUNG KHOP" if envd == str(h.get("solverDigest")).lower() else "!! LECH !!")
        except Exception:
            pass
    elif st in (401, 403):
        print("  => LOI QUYEN goi Cloud Run (service account thieu quyen Invoker / sai audience).")
    elif st == 0:
        print("  => Khong ket noi duoc (mang chan hoac dich vu chet).")

print()
print("=" * 72)
print("D) CLOUD RUN CO CHUA 2 BO GIAI MOI KHONG? (goi /solve voi data rong)")
print("=" * 72)
if url and token:
    for engine in ("cherry", "flash"):
        st, body, dt = call("/solve", {"data": {}, "settings": {"engine": engine}}, timeout=180)
        reason = ""
        stages = []
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line[len("TKB_SOLVER_RESULT:"):].strip() if line.startswith("TKB_SOLVER_RESULT:") else line)
            except Exception:
                continue
            if isinstance(obj, dict):
                if obj.get("stage"):
                    stages.append(str(obj.get("stage")) + (":" + str(obj.get("message"))[:60] if obj.get("message") else ""))
                blob = json.dumps(obj, ensure_ascii=False)
                for key in ("cherry_fallback_reason", "flash_fallback_reason"):
                    if key in blob:
                        i = blob.find(key)
                        reason = blob[i:i + 260]
        print(f"[{engine}] HTTP {st} sau {dt:.1f}s")
        if stages:
            print("   stages:", " | ".join(stages[:6]))
        if reason:
            print("   FALLBACK ->", reason)
            if "ModuleNotFound" in reason or "No module named" in reason:
                print(f"   => ANH CLOUD RUN CHUA CO tkb_engine_v3 -> nut {engine} dang chay bo giai CU.")
            else:
                print(f"   => Co module (loi do data rong) -> nut {engine} CO chay bo giai moi.")
        else:
            print("   khong thay fallback_reason. Trich 300 ky tu dau:", body[:300].replace("\n", " "))
else:
    print("bo qua (thieu url/token)")

print()
print("=" * 72)
print("E) DAT CHO TREO + CHE DO")
print("=" * 72)
print("TKB_SERVERLESS_MODE =", os.environ.get("TKB_SERVERLESS_MODE", "(khong co)"))
print(sh("curl -s --max-time 10 http://127.0.0.1:1010/api/health | python3 -c \"import sys,json;d=json.load(sys.stdin);print(json.dumps(d['serverless']))\" 2>&1"))
'''


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host} ...\n")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    sftp = c.open_sftp()
    with sftp.file("/tmp/tkb_probe2.py", "w") as fh:
        fh.write(REMOTE)
    sftp.close()
    # chay KEM MOI TRUONG cua dich vu de dung dung credentials
    cmd = (
        "set -a; "
        "eval \"$(systemctl show tkb-app -p Environment --value | tr ' ' '\\n' | sed 's/^/export /')\" >/dev/null 2>&1; "
        "set +a; python3 /tmp/tkb_probe2.py"
    )
    _, out, err = c.exec_command(cmd, timeout=600)
    print(out.read().decode("utf-8", "replace"))
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("--- stderr ---")
        print(tail[:2000])
    c.exec_command("rm -f /tmp/tkb_probe2.py")
    c.close()


if __name__ == "__main__":
    main()
