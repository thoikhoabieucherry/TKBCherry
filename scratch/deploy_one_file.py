# Deploy DUNG MOT FILE len VPS, co sao luu lan dau + doi chieu MD5.
#   python scratch/deploy_one_file.py <duong-dan-local> <duong-dan-tren-vps>
import sys, hashlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
sys.stdout.reconfigure(encoding='utf-8')
from vps_credentials import resolve_vps_connection
import paramiko

LOCAL = REPO_ROOT / sys.argv[1]
REMOTE = sys.argv[2]
BACKUP = REMOTE + '.bak-truoc-2008'


def md5_local(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run(client, cmd):
    _, out, err = client.exec_command(cmd, timeout=60)
    return out.read().decode().strip(), err.read().decode().strip()


local_hash = md5_local(LOCAL)
print('File :', LOCAL, LOCAL.stat().st_size, 'bytes')
print('MD5  :', local_hash)

host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30,
               look_for_keys=False, allow_agent=False)

before, _ = run(client, f'md5sum {REMOTE} 2>/dev/null || echo CHUA-CO')
print('VPS truoc:', before)
out, err = run(client, f'[ -f {BACKUP} ] && echo DA-CO-SAO-LUU || (cp -f {REMOTE} {BACKUP} && echo DA-SAO-LUU-LAN-DAU)')
print('Sao luu  :', out or err)

sftp = client.open_sftp()
sftp.put(str(LOCAL), REMOTE)
sftp.close()

after, _ = run(client, f'md5sum {REMOTE}')
print('VPS sau  :', after)
ok = bool(after) and after.split()[0] == local_hash
print('KHOP MD5 :', ok)

# don pycache de python khong dung ban bien dich cu
run(client, 'find /opt/cherry-scheduler/solver_runtime -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null; echo done')
svc, _ = run(client, 'systemctl is-active tkb-app')
print('tkb-app  :', svc)
client.close()
print('XONG.' if ok else 'THAT BAI: MD5 khong khop.')
sys.exit(0 if ok else 1)
