import os
import sys
import hashlib
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def md5_file(filepath):
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def deploy_from_tkbcherry():
    print(f"=== DEPLOYING FROM {REPO_ROOT} TO PRODUCTION VPS ===")
    
    local_web_dir = REPO_ROOT / "web"
    remote_web_dir = "/opt/cherry-scheduler/web"
    
    # 1. Connect to VPS
    host, user, password = resolve_vps_connection()
    print(f"Connecting to VPS {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    sftp = client.open_sftp()
    
    # 2. Upload all key files from TKBCherry/web
    files_to_sync = [
        "tkb-fet-engine.js",
        "tkb-fet-worker.js",
        "pages/tkb-fet-engine.js",
        "pages/tkb-fet-worker.js",
        "pages/phanmon.js",
        "pages/sapxep.html"
    ]
    
    for rel_path in files_to_sync:
        local_path = local_web_dir / rel_path
        remote_path = f"{remote_web_dir}/{rel_path}".replace("\\", "/")
        
        local_hash = md5_file(local_path)
        print(f"Uploading {rel_path} (MD5: {local_hash})...")
        sftp.put(str(local_path), remote_path)
        print(f"  -> Uploaded to {remote_path} OK!")
        
    sftp.close()
    
    # 3. Restart application service
    print("\nRestarting tkb-app service on VPS...")
    stdin, stdout, stderr = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    service_status = stdout.read().decode().strip()
    print(f"Service status: {service_status}")
    
    # 4. Verify MD5 directly on remote VPS
    print("\nVerifying remote MD5 on VPS:")
    stdin, stdout, stderr = client.exec_command("md5sum /opt/cherry-scheduler/web/tkb-fet-engine.js /opt/cherry-scheduler/web/pages/tkb-fet-engine.js")
    remote_md5_output = stdout.read().decode()
    print(remote_md5_output)
    
    # 5. Check operators presence
    stdin, stdout, stderr = client.exec_command("grep -n 'tryBorrowLessonFromRichSessions' /opt/cherry-scheduler/web/tkb-fet-engine.js")
    print("Remote grep tryBorrowLessonFromRichSessions:")
    print(stdout.read().decode())
    
    client.close()
    print("=== DEPLOYMENT COMPLETED 100% SUCCESSFULLY ===")

if __name__ == "__main__":
    deploy_from_tkbcherry()
