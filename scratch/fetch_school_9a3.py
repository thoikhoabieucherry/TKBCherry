import sys
from pathlib import Path
import json
import paramiko

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

# Check school files on VPS
stdin, stdout, stderr = client.exec_command("find /opt/cherry-scheduler -name '*9a339cbc3c1*' -o -name '*school*'")
print("Files found:", stdout.read().decode())

# Check storage on VPS
stdin, stdout, stderr = client.exec_command("ls -la /opt/cherry-scheduler/data /opt/cherry-scheduler/storage /opt/cherry-scheduler/schools 2>/dev/null")
print("Storage content:", stdout.read().decode())

client.close()

