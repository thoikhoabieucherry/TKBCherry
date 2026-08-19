import sys, json
from pathlib import Path
REPO_ROOT = Path(r'C:\Users\Love\Documents\Codex\TKBCherry')
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
from vps_credentials import resolve_vps_connection
import paramiko

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = """python3 -c "
import sqlite3, json
conn = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
c = conn.cursor()
c.execute('SELECT k, v FROM kvstore WHERE k = \\\"auth_registry\\\"')
row = c.fetchone()
if row:
    reg = json.loads(row[1])
    print(json.dumps(reg, indent=2, ensure_ascii=False))
" """
stdin, stdout, stderr = client.exec_command(cmd)
print(stdout.read().decode('utf-8'))

client.close()
