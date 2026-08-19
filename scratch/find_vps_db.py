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

cmd = "find /opt/cherry-scheduler -name '*.db' -o -name '*.sqlite*'; find /var -name '*cherry*' -o -name '*school*' 2>/dev/null"
stdin, stdout, stderr = client.exec_command(cmd)
print("=== DB FILES ===")
print(stdout.read().decode('utf-8'))

client.close()
