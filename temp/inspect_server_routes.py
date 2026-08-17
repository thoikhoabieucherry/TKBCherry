import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def inspect_server_routes():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    stdin, stdout, stderr = client.exec_command("head -n 50 /opt/cherry-scheduler/web/server.js")
    print("server.js head:")
    print(stdout.read().decode())
    
    stdin, stdout, stderr = client.exec_command("grep -n 'app.get' /opt/cherry-scheduler/web/server.js || grep -n 'app.post' /opt/cherry-scheduler/web/server.js")
    print("server.js routes:")
    print(stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    inspect_server_routes()
