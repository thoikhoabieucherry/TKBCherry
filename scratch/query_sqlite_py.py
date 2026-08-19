import sys, paramiko
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
import sqlite3
conn = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
cur = conn.cursor()
cur.execute('SELECT name FROM sqlite_master WHERE type=\\'table\\'')
print('Tables:', cur.fetchall())
for row in cur.execute('SELECT key, length(value), updated_at FROM kvstore LIMIT 20'):
    print(row)
" """
stdin, stdout, stderr = client.exec_command(cmd)
print("STDOUT:", stdout.read().decode())
print("STDERR:", stderr.read().decode())
client.close()
