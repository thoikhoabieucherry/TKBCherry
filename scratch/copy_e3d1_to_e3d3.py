import sys, json
from pathlib import Path
REPO_ROOT = Path(r'C:\Users\Love\Documents\Codex\TKBCherry')
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
from vps_credentials import resolve_vps_connection
import paramiko

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = """python3 -c "
import sqlite3, json, time

conn = sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db')
c = conn.cursor()

# 1. Read source
c.execute('SELECT v FROM kvstore WHERE k = \\\"school_e3d7a3b21e1\\\"')
row = c.fetchone()
if not row:
    print('ERROR: school_e3d7a3b21e1 not found!')
    exit(1)

src_data = json.loads(row[0])
print('Source 1 data loaded: lop =', len(src_data.get('lop', [])), 'gv =', len(src_data.get('giaovien', [])), 'pccm =', len(src_data.get('pccmMatrix', {})), 'tkb =', len(src_data.get('tkb', {})))

# Update timestamps
src_data['_lastModified'] = int(time.time() * 1000)
src_data['_updatedAt'] = int(time.time() * 1000)
new_val_str = json.dumps(src_data, ensure_ascii=False)

# 2. Write to target school_e3d7a3b21e3
c.execute('INSERT INTO kvstore (k, v) VALUES (\\\"school_e3d7a3b21e3\\\", ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', (new_val_str,))

# Update revision counter
rev_key = 'school_revision_e3d7a3b21e3'
c.execute('SELECT v FROM kvstore WHERE k = ?', (rev_key,))
rev_row = c.fetchone()
new_rev = 1
if rev_row:
    try:
        new_rev = int(rev_row[0]) + 1
    except:
        new_rev = 1
c.execute('INSERT INTO kvstore (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', (rev_key, str(new_rev)))

conn.commit()
print('Successfully copied school_e3d7a3b21e1 -> school_e3d7a3b21e3! Revision is now:', new_rev)

# 3. Verify
c.execute('SELECT length(v) FROM kvstore WHERE k = \\\"school_e3d7a3b21e3\\\"')
print('Verified school_e3d7a3b21e3 length in DB:', c.fetchone()[0])
" """
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode('utf-8')
print(out)
err = stderr.read().decode('utf-8')
if err:
    print("STDERR:", err)

client.close()
