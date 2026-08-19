import sys
import json
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

NEW_DIGEST = "86f8a55b0c16390881e269e617e46feeddb8976b37741050443e0d4fb447b69c"
URL = "https://tkb-solver-tys7xrhbca-et.a.run.app"
PROJECT_ID = "project-61ee7855-507e-40a3-879"
REGION = "asia-southeast2"

def main():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    # Update SQLite database directly
    py_code = f"""
import sqlite3, json

db = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
raw = db.execute('SELECT v FROM kvstore WHERE k = "serverless_infrastructure_v1"').fetchone()
if raw:
    cfg = json.loads(raw[0])
else:
    cfg = {{"version": 1, "mode": "serverless_only", "fallback": "vps", "activeProfileId": "cloud-run-{PROJECT_ID}", "profiles": []}}

profile_obj = {{
    "id": "cloud-run-{PROJECT_ID}",
    "url": "{URL}",
    "audience": "{URL}",
    "region": "{REGION}",
    "projectId": "{PROJECT_ID}",
    "enabled": True,
    "priority": 100,
    "vcpu": 6,
    "memoryGib": 8.0,
    "maxConcurrency": 1,
    "solverDigest": "{NEW_DIGEST}"
}}

cfg["activeProfileId"] = "cloud-run-{PROJECT_ID}"
cfg["profiles"] = [profile_obj]

db.execute('INSERT OR REPLACE INTO kvstore (k, v) VALUES ("serverless_infrastructure_v1", ?)', (json.dumps(cfg),))
db.commit()
print("Updated kvstore serverless_infrastructure_v1 successfully!")
"""
    sftp = client.open_sftp()
    with sftp.file("/tmp/update_infra.py", "w") as f:
        f.write(py_code)
    sftp.close()
    
    _, out, err = client.exec_command("python3 /tmp/update_infra.py && rm /tmp/update_infra.py")
    print(out.read().decode())
    
    _, out, _ = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("tkb-app status:", out.read().decode().strip())
    
    client.close()

if __name__ == "__main__":
    main()
