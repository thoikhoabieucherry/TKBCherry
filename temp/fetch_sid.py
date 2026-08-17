import sys
import json
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def fetch_sid_data():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    # Check data file on VPS (e.g. in /opt/cherry-scheduler/data or mongodb/json)
    stdin, stdout, stderr = client.exec_command("find /opt/cherry-scheduler -name '*95671c41791*' -o -name 'data.json'")
    print("Found files on VPS:")
    print(stdout.read().decode())
    
    # Or query API via curl
    stdin, stdout, stderr = client.exec_command("curl -s 'http://127.0.0.1:3000/api/school?sid=95671c41791'")
    raw_data = stdout.read().decode()
    if raw_data:
        try:
            parsed = json.loads(raw_data)
            with open(r"C:\Users\Love\Documents\Codex\temp\school_95671c41791.json", "w", encoding="utf-8") as f:
                json.dump(parsed, f, ensure_ascii=False, indent=2)
            print("Successfully saved school_95671c41791.json! Size:", len(raw_data))
        except Exception as e:
            print("Failed to parse JSON:", e, raw_data[:200])
            
    client.close()

if __name__ == "__main__":
    fetch_sid_data()
