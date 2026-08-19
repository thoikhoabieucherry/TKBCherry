import os
import sys
import tarfile
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
import paramiko

ROOT = Path(__file__).resolve().parent
TOOLS_DIR = ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection


def create_tarball() -> Path:
    temp_tar = Path(tempfile.gettempdir()) / "tkb_web_quick_deploy.tar.gz"
    if temp_tar.exists():
        temp_tar.unlink()
    
    with tarfile.open(temp_tar, "w:gz") as tar:
        # Add web directory
        web_dir = ROOT / "web"
        for p in web_dir.rglob("*"):
            if p.is_file():
                rel = p.relative_to(ROOT).as_posix()
                tar.add(p, arcname=rel)
        
        # Add solver_runtime/src and scripts
        solver_src = ROOT / "solver_runtime" / "src"
        for p in solver_src.rglob("*"):
            if p.is_file() and "__pycache__" not in p.parts:
                rel = p.relative_to(ROOT).as_posix()
                tar.add(p, arcname=rel)
                
        for script_name in ["solve_stdio.py", "cloud_run_client.py", "cloud_run_service.py"]:
            sp = ROOT / "solver_runtime" / "scripts" / script_name
            if sp.exists():
                rel = sp.relative_to(ROOT).as_posix()
                tar.add(sp, arcname=rel)

    return temp_tar


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host}...")
    
    tarball = create_tarball()
    print(f"Goi bundle {tarball.name} ({tarball.stat().st_size // 1024} KB)...")
    
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    import time
    for attempt in range(1, 4):
        try:
            print(f"Thu ket noi (lan {attempt})...")
            client.connect(
                host,
                username=user,
                password=password,
                timeout=30,
                banner_timeout=30,
                auth_timeout=30,
                look_for_keys=False,
                allow_agent=False
            )
            break
        except Exception as e:
            if attempt == 3:
                raise
            print(f"Ket noi that bai ({e}), thu lai sau 2s...")
            time.sleep(2)
    
    remote_tar = "/tmp/tkb_web_quick_deploy.tar.gz"
    sftp = client.open_sftp()
    print(f"Tai bundle len VPS -> {remote_tar}...")
    sftp.put(str(tarball), remote_tar)
    sftp.close()
    
    print("Giai nen va cap nhat file tren VPS...")
    cmd = (
        "tar -xzf /tmp/tkb_web_quick_deploy.tar.gz -C /opt/cherry-scheduler/ && "
        "rm -f /tmp/tkb_web_quick_deploy.tar.gz && "
        "systemctl restart tkb-app && sleep 2 && systemctl is-active tkb-app"
    )
    _, out, err = client.exec_command(cmd, timeout=120)
    status = out.read().decode().strip()
    err_out = err.read().decode().strip()
    
    print("Trang thai:", status)
    if err_out:
        print("Log:", err_out)
        
    client.close()
    try:
        tarball.unlink()
    except Exception:
        pass
        
    print("\nDEPLOY XONG! Mo tkbcherry.com va nhan Ctrl+F5.")



if __name__ == "__main__":
    main()

