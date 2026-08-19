"""Chan doan Cloud Run + bo giai tren VPS (chi doc, khong sua gi).

Chay:  python chan_doan_cloudrun.py
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

REMOTE_PROBE = r'''
import json, os, re, subprocess, sqlite3, urllib.request, urllib.error, time

def sh(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"<loi: {e}>"

print("=" * 70)
print("1) DICH VU + API")
print("=" * 70)
print(sh("systemctl is-active tkb-app; systemctl show tkb-app -p ActiveEnterTimestamp -p NRestarts"))
print(sh("curl -s --max-time 10 http://127.0.0.1:1010/api/health")[:1500])

print()
print("=" * 70)
print("2) BIEN MOI TRUONG CLOUD RUN CUA DICH VU (che gia tri nhay cam)")
print("=" * 70)
env_blob = sh("systemctl show tkb-app -p Environment --value")
env_files = sh("systemctl show tkb-app -p EnvironmentFiles --value").strip()
print("EnvironmentFiles:", env_files or "(khong co)")
pairs = {}
for token in env_blob.split():
    if "=" in token:
        k, v = token.split("=", 1)
        pairs[k] = v
for path in re.findall(r"(/\S+?)(?:\s|$)", env_files):
    path = path.split(";")[0]
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                pairs[k.replace("export ", "").strip()] = v.strip().strip('"').strip("'")
    except Exception as e:
        print(f"  (khong doc duoc {path}: {e})")
interesting = {k: v for k, v in pairs.items() if k.startswith(("TKB_CLOUD", "TKB_SERVERLESS", "GOOGLE_"))}
if not interesting:
    print("  !! KHONG co bien TKB_CLOUD_RUN_* nao trong unit -> Rust se tu doc tu DB/registry")
for k, v in sorted(interesting.items()):
    show = v if ("URL" in k or "REGION" in k or "PROJECT" in k or "AUDIENCE" in k or "ACCOUNT" in k) else f"<da dat, {len(v)} ky tu>"
    print(f"  {k} = {show}")

print()
print("=" * 70)
print("3) CAU HINH SERVERLESS TRONG DB + DAT CHO (reservation) DANG TREO")
print("=" * 70)
db_path = "/opt/cherry-scheduler/rust_api/tkb_store.db"
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print("bang:", ", ".join(t for t in tables if "serverless" in t or t == "kvstore") or "(khong thay)")
    try:
        cur.execute("SELECT v FROM kvstore WHERE k LIKE '%serverless%'")
        for (v,) in cur.fetchall():
            try:
                obj = json.loads(v)
                for key in ("mode", "fallback", "profiles", "selectedProfileId", "maxConcurrency"):
                    if key in obj:
                        val = obj[key]
                        if key == "profiles" and isinstance(val, list):
                            for p in val:
                                print(f"  profile: id={p.get('id')} url={p.get('url')} region={p.get('region')} digest={str(p.get('solverDigest'))[:12]}...")
                        else:
                            print(f"  {key} = {val}")
            except Exception:
                print("  (config raw)", str(v)[:300])
    except Exception as e:
        print("  kvstore:", e)
    if "serverless_reservations" in tables:
        now = int(time.time() * 1000)
        cur.execute("SELECT job_id, profile_id, estimated_usd, created_at_ms, expires_at_ms FROM serverless_reservations ORDER BY created_at_ms DESC LIMIT 10")
        rows = cur.fetchall()
        print(f"  so dat cho dang giu: {len(rows)}")
        for job, prof, usd, created, expires in rows:
            age = (now - int(created or 0)) / 1000.0
            left = (int(expires or 0) - now) / 1000.0
            print(f"   - job={job[:28]} profile={prof} ~${usd} tuoi={age:.0f}s con_han={left:.0f}s")
    conn.close()
except Exception as e:
    print("  khong doc duoc DB:", e)

print()
print("=" * 70)
print("4) NHAT KY 3 GIO GAN NHAT (loc theo cloud run / serverless)")
print("=" * 70)
log = sh("journalctl -u tkb-app --since '3 hours ago' --no-pager | grep -iE 'cloud.?run|serverless|reservation|dispatch|solver_stderr|helper' | tail -60", timeout=90)
print(log.strip() or "(khong co dong nao)")

print()
print("=" * 70)
print("5) KIEM TRA THUC TE: LAY ID TOKEN + GOI THANG CLOUD RUN")
print("=" * 70)
url = pairs.get("TKB_CLOUD_RUN_URL", "").strip().rstrip("/")
aud = pairs.get("TKB_CLOUD_RUN_AUDIENCE", "").strip() or url
if not url:
    print("  Bo qua: unit khong co TKB_CLOUD_RUN_URL (cau hinh nam trong DB).")
    print("  -> Lay url tu muc 3 roi chay lai voi bien moi truong neu can.")
else:
    print("  URL:", url)
    token = ""
    try:
        os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", pairs.get("GOOGLE_APPLICATION_CREDENTIALS", ""))
        from google.auth.transport.requests import Request
        from google.oauth2 import id_token
        token = id_token.fetch_id_token(Request(), aud)
        print(f"  ID token: LAY DUOC ({len(token)} ky tu)")
    except Exception as e:
        print("  ID token: THAT BAI ->", str(e)[:300])
    if token:
        req = urllib.request.Request(url, data=b"{}", method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = resp.read(400).decode("utf-8", "replace")
                print(f"  HTTP {resp.status} sau {time.time()-t0:.1f}s -> {body[:200]}")
                print("  => CLOUD RUN SONG (dich vu tra loi).")
        except urllib.error.HTTPError as e:
            body = e.read(400).decode("utf-8", "replace")
            print(f"  HTTP {e.code} sau {time.time()-t0:.1f}s -> {body[:200]}")
            if e.code in (400, 422):
                print("  => CLOUD RUN SONG (tu choi body rong la dung, nghia la vao duoc va da xac thuc).")
            elif e.code in (401, 403):
                print("  => LOI QUYEN: service account chua duoc cap 'Cloud Run Invoker' hoac audience sai.")
            elif e.code == 404:
                print("  => SAI URL dich vu.")
            else:
                print("  => Dich vu tra loi loi, xem noi dung o tren.")
        except Exception as e:
            print(f"  KHONG GOI DUOC sau {time.time()-t0:.1f}s ->", str(e)[:300])
            print("  => Nghi ngo: mang VPS chan ra ngoai, hoac dich vu dang khoi dong lanh (cold start) qua lau.")

print()
print("=" * 70)
print("6) SCRIPT CLIENT + PYTHON")
print("=" * 70)
print(sh("ls -la /opt/cherry-scheduler/solver_runtime/scripts/cloud_run_client.py /opt/cherry-scheduler/solver_runtime/scripts/solve_stdio.py 2>&1"))
print(sh("python3 -c \"import google.auth, ortools; print('google-auth + ortools: OK')\" 2>&1"))
'''


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host} ...\n")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    sftp = client.open_sftp()
    with sftp.file("/tmp/tkb_probe_cloudrun.py", "w") as fh:
        fh.write(REMOTE_PROBE)
    sftp.close()
    _, out, err = client.exec_command("python3 /tmp/tkb_probe_cloudrun.py", timeout=300)
    print(out.read().decode("utf-8", "replace"))
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("--- stderr ---")
        print(tail[:2000])
    client.exec_command("rm -f /tmp/tkb_probe_cloudrun.py")
    client.close()


if __name__ == "__main__":
    main()
