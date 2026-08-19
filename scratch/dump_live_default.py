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
import sqlite3
conn = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
cur = conn.cursor()
cur.execute('SELECT v FROM kvstore WHERE k = ?', ('school_default',))
row = cur.fetchone()
if row:
    print(row[0])
" """
stdin, stdout, stderr = client.exec_command(cmd)
content = stdout.read().decode('utf-8')
client.close()

if content.strip().startswith('{'):
    with open('scratch/live_default.json', 'w', encoding='utf-8') as f:
        f.write(content.strip())
    print('SUCCESS: Saved live school_default to scratch/live_default.json (bytes:', len(content), ')')
else:
    print('Error:', content[:500])
