import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def verify_deployed_files():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    cmd = "md5sum /opt/cherry-scheduler/web/tkb-fet-engine.js /opt/cherry-scheduler/web/pages/tkb-fet-engine.js"
    stdin, stdout, stderr = client.exec_command(cmd)
    print("=== MD5 OF ENGINE ON VPS ===")
    print(stdout.read().decode())
    
    cmd_grep = "grep -n 'tryIntraSessionCrossClassChain' /opt/cherry-scheduler/web/tkb-fet-engine.js"
    stdin, stdout, stderr = client.exec_command(cmd_grep)
    print("=== GREP OPERATOR ON VPS ===")
    print(stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    verify_deployed_files()
