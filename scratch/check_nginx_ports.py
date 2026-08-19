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

cmd = "cat /etc/nginx/sites-enabled/* | grep -E 'proxy_pass|listen|root'; ss -tulpn | grep -E '1100571|2234640|8080|3000|5000'"
stdin, stdout, stderr = client.exec_command(cmd)
print("=== NGINX PROXY & LISTENING PORTS ===")
print(stdout.read().decode('utf-8'))

client.close()
