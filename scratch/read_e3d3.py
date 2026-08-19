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
c.execute('SELECT v FROM kvstore WHERE k = \\\"school_e3d7a3b21e3\\\"')
row = c.fetchone()
if row:
    print('Content of e3d7a3b21e3:', row[0])
" """
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode('utf-8')
print(out.encode('ascii', errors='replace').decode('ascii'))

client.close()
