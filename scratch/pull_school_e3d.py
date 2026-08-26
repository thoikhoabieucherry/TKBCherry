# Keo du lieu mot truong tu kvstore tren VPS ve scratch/school_<sid>.json
# Dung: python scratch/pull_school_e3d.py e3d7a3b21e1
import sys, json, base64, zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
from vps_credentials import resolve_vps_connection
import paramiko

SID = sys.argv[1] if len(sys.argv) > 1 else 'e3d7a3b21e1'

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30)

cmd = (
    "python3 -c \"import sqlite3,base64,zlib;"
    "conn=sqlite3.connect('/opt/cherry-scheduler/rust_api/tkb_store.db');"
    "c=conn.cursor();"
    "c.execute('SELECT v FROM kvstore WHERE k = ?', ('school_" + SID + "',));"
    "row=c.fetchone();"
    "raw=row[0] if row else '';"
    "print(base64.b64encode(zlib.compress(raw.encode('utf-8'))).decode('ascii'))\""
)
stdin, stdout, stderr = client.exec_command(cmd)
out = stdout.read().decode('utf-8').strip()
err = stderr.read().decode('utf-8').strip()
client.close()

if err:
    print('STDERR:', err[:500])
if not out:
    print('EMPTY - khong tim thay school_' + SID)
    sys.exit(1)

raw = zlib.decompress(base64.b64decode(out)).decode('utf-8')
dst = REPO_ROOT / 'scratch' / ('school_' + SID + '.json')
dst.write_text(raw, encoding='utf-8')
d = json.loads(raw)
print('Da luu', dst, len(raw), 'bytes')
print('lop =', len(d.get('lop', [])), '| gv =', len(d.get('giaovien', d.get('gv', []))), '| tkb =', len(d.get('tkb', {})))
