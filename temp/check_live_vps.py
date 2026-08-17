import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def verify_live_deployment():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    print(f"=== CHECKING LIVE VPS {host} ===")
    
    # 1. Check md5 on VPS
    stdin, stdout, stderr = client.exec_command("md5sum /opt/cherry-scheduler/web/tkb-fet-engine.js /opt/cherry-scheduler/web/pages/tkb-fet-engine.js")
    print("MD5 sums on VPS:")
    print(stdout.read().decode())
    
    # 2. Check presence of new operators
    cmd = "grep -n 'tryBorrowLessonFromRichSessions' /opt/cherry-scheduler/web/tkb-fet-engine.js"
    stdin, stdout, stderr = client.exec_command(cmd)
    print("Grep tryBorrowLessonFromRichSessions:")
    print(stdout.read().decode())
    
    cmd2 = "grep -n 'tryBlockShiftAndGapResolution' /opt/cherry-scheduler/web/tkb-fet-engine.js"
    stdin, stdout, stderr = client.exec_command(cmd2)
    print("Grep tryBlockShiftAndGapResolution:")
    print(stdout.read().decode())

    cmd3 = "grep -n 'tryInterDayRelocateGapLesson' /opt/cherry-scheduler/web/tkb-fet-engine.js"
    stdin, stdout, stderr = client.exec_command(cmd3)
    print("Grep tryInterDayRelocateGapLesson:")
    print(stdout.read().decode())
    
    # 3. Check service status
    stdin, stdout, stderr = client.exec_command("systemctl is-active tkb-app")
    print("Service status:", stdout.read().decode().strip())
    
    client.close()

if __name__ == "__main__":
    verify_live_deployment()
