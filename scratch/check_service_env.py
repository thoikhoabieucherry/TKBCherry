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

cmd = "cat /etc/systemd/system/cherry* /etc/systemd/system/tkb* 2>/dev/null; cat /proc/2234640/environ | tr '\\0' '\\n' | grep -E 'DB|PATH|PORT|DIR'"
stdin, stdout, stderr = client.exec_command(cmd)
print("=== SERVICE ENV & SYSTEMD ===")
print(stdout.read().decode('utf-8'))

client.close()
