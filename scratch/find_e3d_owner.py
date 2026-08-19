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
c.execute('SELECT v FROM kvstore WHERE k = \\\"auth_registry\\\"')
row = c.fetchone()
if row:
    reg = json.loads(row[0])
    users = reg.get('users', {})
    if isinstance(users, dict):
        for uid, u in users.items():
            schs = u.get('schools', [])
            print('User:', uid, u.get('username'), u.get('email'), 'Schools:', schs)
    elif isinstance(users, list):
        for u in users:
            print('User:', u.get('username'), 'Schools:', u.get('schools'))
" """
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode('utf-8')
print(out.encode('ascii', errors='replace').decode('ascii'))

client.close()
