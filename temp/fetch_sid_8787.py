import sys
import json
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def fetch_sid_95671c41791():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    # Try fetching from port 8787 or finding where KV/data is stored
    stdin, stdout, stderr = client.exec_command("curl -s 'http://127.0.0.1:8787/api/data?sid=95671c41791' || curl -s 'http://127.0.0.1:8787/api/school?sid=95671c41791'")
    raw_data = stdout.read().decode()
    
    if raw_data and len(raw_data) > 100:
        try:
            parsed = json.loads(raw_data)
            with open(r"C:\Users\Love\Documents\Codex\temp\school_95671c41791.json", "w", encoding="utf-8") as f:
                json.dump(parsed, f, ensure_ascii=False, indent=2)
            print("Successfully saved school_95671c41791.json! Size:", len(raw_data))
        except Exception as e:
            print("Failed JSON parse:", e, raw_data[:300])
    else:
        # Check files in /opt/cherry-scheduler/web
        stdin, stdout, stderr = client.exec_command("find /opt/cherry-scheduler -name '*.json' -o -name '*.sqlite*'")
        print("Found data files:")
        print(stdout.read().decode())
        
    client.close()

if __name__ == "__main__":
    fetch_sid_95671c41791()
