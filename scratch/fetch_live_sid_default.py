import sys, json, urllib.request, paramiko
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = """python3 -c "
import sqlite3, json

conn = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
cur = conn.cursor()
cur.execute('SELECT key, length(value), updated_at FROM kvstore')
for row in cur.fetchall():
    print(row[0], row[1], row[2])
" """

stdin, stdout, stderr = client.exec_command(cmd)
print(stdout.read().decode())
client.close()
