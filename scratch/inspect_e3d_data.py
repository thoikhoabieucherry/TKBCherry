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
for k in ['school_e3d7a3b21e1', 'school_e3d7a3b21e2', 'school_e3d7a3b21e3']:
    c.execute('SELECT v FROM kvstore WHERE k = ?', (k,))
    row = c.fetchone()
    if row:
        data = json.loads(row[0])
        print('=== KEY:', k, '===')
        print('lop:', len(data.get('lop', [])), 'gv:', len(data.get('giaovien', [])), 'pccm:', len(data.get('pccmMatrix', {})), 'tkb:', len(data.get('tkb', {})))
" """
stdin, stdout, stderr = client.exec_command(cmd)
print(stdout.read().decode('utf-8'))
print("STDERR:", stderr.read().decode('utf-8'))

client.close()
