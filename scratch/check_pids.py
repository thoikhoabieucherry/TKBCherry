import sys
from pathlib import Path
REPO_ROOT = Path(r'C:\Users\Love\Documents\Codex\TKBCherry')
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
from vps_credentials import resolve_vps_connection
import paramiko

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = "ls -l /proc/1100571/cwd /proc/2234640/cwd; lsof -p 1100571,2234640 | grep -E 'db|sqlite|REG'"
stdin, stdout, stderr = client.exec_command(cmd)
print("=== OPEN FILES OF PROCESSES ===")
print(stdout.read().decode('utf-8'))

client.close()
