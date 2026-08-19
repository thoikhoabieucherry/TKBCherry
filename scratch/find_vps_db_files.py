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
    
    stdin, stdout, stderr = client.exec_command('find /opt/cherry-scheduler -name "*.db" -o -name "*.sqlite*"')
    print("DB files on VPS:\n", stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    main()
