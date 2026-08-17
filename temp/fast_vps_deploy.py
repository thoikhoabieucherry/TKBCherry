import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def direct_sftp_web_deploy():
    host, user, password = resolve_vps_connection()
    print(f"Connecting to VPS {host} via SFTP...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    sftp = client.open_sftp()
    
    files_to_sync = [
        (
            r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js",
            "/opt/cherry-scheduler/web/tkb-fet-engine.js"
        ),
        (
            r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-worker.js",
            "/opt/cherry-scheduler/web/tkb-fet-worker.js"
        ),
        (
            r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js",
            "/opt/cherry-scheduler/web/pages/tkb-fet-engine.js"
        ),
        (
            r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-worker.js",
            "/opt/cherry-scheduler/web/pages/tkb-fet-worker.js"
        ),
        (
            r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\phanmon.js",
            "/opt/cherry-scheduler/web/pages/phanmon.js"
        ),
        (
            r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html",
            "/opt/cherry-scheduler/web/pages/sapxep.html"
        ),
    ]
    
    for local_path, remote_path in files_to_sync:
        print(f"Uploading {Path(local_path).name} -> {remote_path}...")
        sftp.put(local_path, remote_path)
        print("  -> OK!")
        
    sftp.close()
    
    # Restart app to clear any cached static files in memory if needed
    print("Restarting tkb-app service on VPS...")
    stdin, stdout, stderr = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    status = stdout.read().decode().strip()
    print("Service status:", status)
    
    client.close()
    print("\nDIRECT SFTP DEPLOY COMPLETED 100% SUCCESSFULLY!")

if __name__ == "__main__":
    direct_sftp_web_deploy()
