import sys
from pathlib import Path
import paramiko

sys.stdout.reconfigure(encoding='utf-8')
TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=10)

cmd = 'sqlite3 /opt/cherry-scheduler/rust_api/tkb_store.db "SELECT value FROM kv_store WHERE key=\'school_default\';"'
stdin, stdout, stderr = client.exec_command(cmd)
val = stdout.read().decode('utf-8')
if val and len(val) > 10:
    with open('scratch/school_default.json', 'w', encoding='utf-8') as f:
        f.write(val)
    print('Saved scratch/school_default.json, len =', len(val))
else:
    print('school_default not found, listing all keys...')
    stdin, stdout, stderr = client.exec_command('sqlite3 /opt/cherry-scheduler/rust_api/tkb_store.db "SELECT key FROM kv_store;"')
    print(stdout.read().decode('utf-8'))

client.close()
