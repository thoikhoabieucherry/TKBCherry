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
    
    stdin, stdout, stderr = client.exec_command('python3 -c \'import sqlite3; db = sqlite3.connect("/opt/cherry-scheduler/rust_api/tkb_store.db"); print(db.execute("SELECT v FROM kvstore WHERE k = \\"serverless_infrastructure_v1\\"").fetchone()[0])\'')
    print("serverless_infrastructure_v1 value:\n", stdout.read().decode())
    
    client.close()

if __name__ == "__main__":
    main()
