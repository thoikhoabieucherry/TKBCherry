import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def find_app_entry():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    stdin, stdout, stderr = client.exec_command("systemctl cat tkb-app")
    print("systemctl cat tkb-app:")
    print(stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    find_app_entry()
