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
    
    stdin, stdout, stderr = client.exec_command("cat /etc/systemd/system/tkb-app.service.d/cloud-run.conf 2>/dev/null || true")
    print("cloud-run.conf:\n", stdout.read().decode())
    
    stdin, stdout, stderr = client.exec_command("systemctl show tkb-app --property=Environment")
    print("tkb-app Environment:\n", stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    main()
