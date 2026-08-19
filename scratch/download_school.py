import sys
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
sys.path.insert(0, r"c:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
from vps_credentials import resolve_vps_connection
import paramiko

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = """python3 -c '
import sqlite3
conn = sqlite3.connect("/opt/cherry-scheduler/rust_api/tkb_store.db")
c = conn.cursor()
c.execute("SELECT v FROM kvstore WHERE k = ?", ("school_95671c41791",))
row = c.fetchone()
if row:
    with open("/tmp/school_95671c41791.json", "w", encoding="utf-8") as f:
        f.write(row[0])
    print("Found and saved, len:", len(row[0]))
'
"""
stdin, stdout, stderr = client.exec_command(cmd)
print("Saved on VPS:", stdout.read().decode())

sftp = client.open_sftp()
sftp.get('/tmp/school_95671c41791.json', r'c:\Users\Love\Documents\Codex\TKBCherry\scratch\school_95671c41791.json')
sftp.close()
client.close()
print("Success! Downloaded to scratch/school_95671c41791.json")
