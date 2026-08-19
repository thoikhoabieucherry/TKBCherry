"""Xem lượt xếp GẦN NHẤT thực sự chạy bằng thuật toán nào.

Sau khi bấm nút (Sắp xếp / Flash / Cherry) tren web, chay:
    python xem_luot_xep_gan_nhat.py
No doc telemetry + job tren VPS va bao cao: engine nao, chay o dau
(Cloud Run / VPS / trinh duyet), bao lau, ket qua ra sao.
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
import paramiko

TOOLS = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS))
from vps_credentials import resolve_vps_connection

REMOTE = r'''
import json, sqlite3, subprocess, time

DB = "/opt/cherry-scheduler/rust_api/tkb_store.db"
conn = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=15)
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print("Bang trong DB:", ", ".join(tables))

interesting = [t for t in tables if any(k in t.lower() for k in ("telemetry", "job", "solver", "serverless"))]
for t in interesting:
    try:
        cur.execute("PRAGMA table_info(%s)" % t)
        cols = [c[1] for c in cur.fetchall()]
        order = None
        for cand in ("created_at_ms", "started_at_ms", "updated_at_ms", "finished_at_ms", "id", "rowid"):
            if cand in cols or cand == "rowid":
                order = cand
                break
        cur.execute("SELECT COUNT(*) FROM %s" % t)
        n = cur.fetchone()[0]
        print("\n=== %s (%d dong) cot: %s" % (t, n, ", ".join(cols)[:200]))
        if n:
            cur.execute("SELECT * FROM %s ORDER BY %s DESC LIMIT 3" % (t, order))
            for row in cur.fetchall():
                rec = dict(zip(cols, row))
                # rut gon: chi in cac truong huu ich
                slim = {}
                for k, v in rec.items():
                    sv = str(v)
                    if len(sv) > 400:
                        # thu tim engine trong payload lon
                        for needle in ('"engine"', "cherry", "flash", "tkb-engine-v3", "google-cloud-run", "cloud_solver"):
                            i = sv.find(needle)
                            if i >= 0:
                                slim[k + "~"] = sv[max(0, i - 60): i + 160]
                                break
                        else:
                            slim[k] = sv[:120] + "..."
                    else:
                        slim[k] = sv
                print("  ", json.dumps(slim, ensure_ascii=False)[:1000])
    except Exception as e:
        print("  (loi doc %s: %s)" % (t, e))
conn.close()

print("\n=== NHAT KY 30 PHUT GAN NHAT (loc engine/cloud) ===")
out = subprocess.run(
    "journalctl -u tkb-app --since '30 min ago' --no-pager "
    "| grep -iE 'engine|cherry|flash|cloud|fallback|solve' | tail -40",
    shell=True, capture_output=True, text=True, timeout=90).stdout.strip()
print(out or "(khong co dong nao)")
'''


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host} ...")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=password, timeout=30)
    sftp = c.open_sftp()
    with sftp.file("/tmp/tkb_last_run.py", "w") as fh:
        fh.write(REMOTE)
    sftp.close()
    _, out, err = c.exec_command("python3 /tmp/tkb_last_run.py", timeout=300)
    print(out.read().decode("utf-8", "replace"))
    tail = err.read().decode("utf-8", "replace").strip()
    if tail:
        print("--- stderr ---\n" + tail[:1500])
    c.exec_command("rm -f /tmp/tkb_last_run.py")
    c.close()


if __name__ == "__main__":
    main()
