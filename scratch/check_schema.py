import sys
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
sys.path.insert(0, r"c:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
from vps_credentials import resolve_vps_connection
import paramiko

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = """python3 -c '
import sqlite3
conn = sqlite3.connect("/opt/cherry-scheduler/rust_api/tkb_store.db")
c = conn.cursor()
c.execute("SELECT sql FROM sqlite_master WHERE type=\\"table\\"")
for row in c.fetchall():
    print(row[0])
c.execute("SELECT k FROM kvstore WHERE k LIKE \\"%95671c41791%\\"")
rows = c.fetchall()
print("k matches:", rows)
if not rows:
    c.execute("SELECT * FROM kvstore LIMIT 5")
    for r in c.fetchall():
        print("Sample:", r[0], len(str(r[1])))
'
"""
stdin, stdout, stderr = client.exec_command(cmd)
print("Schema & search:\n", stdout.read().decode())
print("Err:\n", stderr.read().decode())
client.close()
