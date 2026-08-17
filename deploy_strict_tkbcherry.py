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

def check_and_sync_all():
    print(f"=== CHECKING REPOSITORY: {REPO_ROOT} ===")
    
    engine_root = REPO_ROOT / "web" / "tkb-fet-engine.js"
    engine_pages = REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    worker_root = REPO_ROOT / "web" / "tkb-fet-worker.js"
    worker_pages = REPO_ROOT / "web" / "pages" / "tkb-fet-worker.js"
    phanmon_path = REPO_ROOT / "web" / "pages" / "phanmon.js"
    sapxep_path = REPO_ROOT / "web" / "pages" / "sapxep.html"
    
    # 1. Sync pages/ with web/
    with open(engine_root, "rb") as f:
        content = f.read()
    with open(engine_pages, "wb") as f:
        f.write(content)
    print("Synced web/tkb-fet-engine.js -> web/pages/tkb-fet-engine.js")
    
    with open(worker_root, "rb") as f:
        w_content = f.read()
    with open(worker_pages, "wb") as f:
        f.write(w_content)
    print("Synced web/tkb-fet-worker.js -> web/pages/tkb-fet-worker.js")
    
    files_to_check = [engine_root, engine_pages, worker_root, worker_pages, phanmon_path, sapxep_path]
    print("\nLocal MD5 in C:\\Users\\Love\\Documents\\Codex\\TKBCherry:")
    for f in files_to_check:
        print(f"  {f.relative_to(REPO_ROOT)}: {md5_file(f)}")
        
    # 2. Deploy all files directly to VPS from TKBCherry
    host, user, password = resolve_vps_connection()
    print(f"\nConnecting to VPS {host} for full deployment...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    sftp = client.open_sftp()
    
    remote_web_dir = "/opt/cherry-scheduler/web"
    for local_file in files_to_check:
        rel = local_file.relative_to(REPO_ROOT / "web").as_posix()
        remote_path = f"{remote_web_dir}/{rel}"
        print(f"Uploading {rel} -> {remote_path}...")
        sftp.put(str(local_file), remote_path)
        print("  -> OK!")
        
    sftp.close()
    
    # 3. Restart and verify on remote VPS
    print("\nRestarting service on VPS...")
    stdin, stdout, stderr = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("Remote Service Status:", stdout.read().decode().strip())
    
    print("\nRemote MD5 checksums on VPS:")
    stdin, stdout, stderr = client.exec_command(f"md5sum {remote_web_dir}/tkb-fet-engine.js {remote_web_dir}/pages/tkb-fet-engine.js {remote_web_dir}/pages/phanmon.js")
    print(stdout.read().decode())
    
    client.close()
    print("=== DEPLOY FROM TKBCherry COMPLETED 100% ===")

if __name__ == "__main__":
    check_and_sync_all()
