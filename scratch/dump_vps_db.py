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
client.connect(host, username=user, password=password, timeout=30)

cmd = "sqlite3 /opt/cherry-scheduler/rust_api/tkb_store.db \".tables\""
stdin, stdout, stderr = client.exec_command(cmd)
print("Tables in /opt/cherry-scheduler/rust_api/tkb_store.db:", stdout.read().decode())

cmd = "find /opt/cherry-scheduler/ -name '*.json' -o -name '*.db' 2>/dev/null"
stdin, stdout, stderr = client.exec_command(cmd)
print("Files:", stdout.read().decode())

client.close()

