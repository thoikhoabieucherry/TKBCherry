import sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def main():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    _, out, _ = client.exec_command("curl -s http://127.0.0.1:1010/api/admin/solver-infrastructure -H 'X-TKB-Super-Password: 1091Ngoc'")
    print("Solver infrastructure:\n", out.read().decode())
    
    client.close()

if __name__ == "__main__":
    main()
