import sys
from pathlib import Path
import json
import sqlite3
import paramiko

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = "sqlite3 /opt/cherry-scheduler/rust_api/tkb_store.db \"SELECT payload FROM schools WHERE sid = '9a339cbc3c1' OR sid LIKE '%9a339cbc3c1%';\""
stdin, stdout, stderr = client.exec_command(cmd)
payload = stdout.read().decode()

if not payload.strip():
    cmd = "sqlite3 /opt/cherry-scheduler/rust_api/tkb_store.db \"SELECT sid FROM schools LIMIT 10;\""
    stdin, stdout, stderr = client.exec_command(cmd)
    print("SIDs in DB:", stdout.read().decode())
else:
    out_file = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\scratch\school_9a3.json")
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(payload)
    print(f"Saved payload to {out_file} (length: {len(payload)})")

client.close()
