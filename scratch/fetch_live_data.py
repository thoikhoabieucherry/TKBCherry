import sys, json, paramiko
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
cur.execute('SELECT value FROM kvstore WHERE key = ?', ('school_default',))
row = cur.fetchone()
if row:
    print(row[0])
else:
    # try other keys
    cur.execute('SELECT key FROM kvstore')
    print('Available keys:', [r[0] for r in cur.fetchall()])
" """

stdin, stdout, stderr = client.exec_command(cmd)
res = stdout.read().decode('utf-8')
client.close()

if res.startswith('{'):
    with open('scratch/live_default.json', 'w', encoding='utf-8') as f:
        f.write(res)
    print('Saved scratch/live_default.json (len:', len(res), ')')
else:
    print(res[:500])
