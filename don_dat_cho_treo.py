"""Don cac 'cho dat' (reservation) Cloud Run bi treo tren VPS.

An toan: chi xoa cac dong CU HON 10 phut — Cloud Run co tran 295 giay nen
moi dong gia hon the deu la rac (job da chet, khong con tinh tien).

Chay:  python don_dat_cho_treo.py
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

REMOTE = r'''
import sqlite3, time, json
DB = "/opt/cherry-scheduler/rust_api/tkb_store.db"
now = int(time.time() * 1000)
cutoff = now - 10 * 60 * 1000
conn = sqlite3.connect(DB, timeout=15)
cur = conn.cursor()
cur.execute("SELECT job_id, created_at_ms FROM serverless_reservations ORDER BY created_at_ms")
rows = cur.fetchall()
print("Truoc khi don:", len(rows), "cho dat")
stale = [r for r in rows if int(r[1] or 0) < cutoff]
for job, created in stale:
    print(f"  xoa job={job[:32]} tuoi={(now-int(created or 0))/1000:.0f}s")
if stale:
    cur.executemany("DELETE FROM serverless_reservations WHERE job_id = ?", [(r[0],) for r in stale])
    conn.commit()
cur.execute("SELECT COUNT(*) FROM serverless_reservations")
print("Sau khi don:", cur.fetchone()[0], "cho dat")
conn.close()
'''


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host} ...")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    sftp = c.open_sftp()
    with sftp.file("/tmp/tkb_clean_res.py", "w") as fh:
        fh.write(REMOTE)
    sftp.close()
    _, out, err = c.exec_command("python3 /tmp/tkb_clean_res.py", timeout=120)
    print(out.read().decode("utf-8", "replace"))
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("--- stderr ---\n" + tail[:1500])
    c.exec_command("rm -f /tmp/tkb_clean_res.py")
    c.close()


if __name__ == "__main__":
    main()
