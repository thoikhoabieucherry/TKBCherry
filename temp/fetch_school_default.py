import json
import sqlite3
import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def fetch_school_default():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    remote_script = """
import sqlite3, json
conn = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
cur = conn.cursor()
cur.execute("SELECT v FROM kvstore WHERE k='school_default'")
row = cur.fetchone()
if row:
    with open('/tmp/school_default.json', 'w', encoding='utf-8') as f:
        f.write(row[0])
    print("SAVED_DEFAULT_OK")
else:
    print("NO_DEFAULT_FOUND")
conn.close()
"""
    sftp = client.open_sftp()
    with sftp.file("/tmp/dump_default.py", "w") as f:
        f.write(remote_script)
    sftp.close()
    
    stdin, stdout, stderr = client.exec_command("python3 /tmp/dump_default.py")
    res = stdout.read().decode()
    print("Dump result:", res)
    
    if "SAVED_DEFAULT_OK" in res:
        sftp = client.open_sftp()
        local_target = r"C:\Users\Love\Documents\Codex\temp\school_default.json"
        sftp.get("/tmp/school_default.json", local_target)
        sftp.close()
        print(f"Downloaded school_default.json to {local_target}")
        
    client.close()

if __name__ == "__main__":
    fetch_school_default()
