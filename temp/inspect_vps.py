import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def inspect_vps_server():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    stdin, stdout, stderr = client.exec_command("ps aux | grep -E 'node|app|tkb|python'")
    print("Processes on VPS:")
    print(stdout.read().decode())
    
    stdin, stdout, stderr = client.exec_command("ss -tulpn | grep LISTEN")
    print("Listening ports:")
    print(stdout.read().decode())

    stdin, stdout, stderr = client.exec_command("ls -la /opt/cherry-scheduler")
    print("Directory /opt/cherry-scheduler:")
    print(stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    inspect_vps_server()
