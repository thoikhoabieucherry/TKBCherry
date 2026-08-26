# Deploy DUNG MOT FILE: web/pages/tkb-fet-engine.js (ban sua nut "2 tiet trong" 20/08)
# Khong dung toi cac file khac dang sua do trong web/ va solver_runtime/.
import sys, hashlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
from vps_credentials import resolve_vps_connection
import paramiko

LOCAL = REPO_ROOT / 'web' / 'pages' / 'tkb-fet-engine.js'
REMOTE = '/opt/cherry-scheduler/web/pages/tkb-fet-engine.js'
BACKUP = '/opt/cherry-scheduler/web/pages/tkb-fet-engine.js.bak-truoc-gap2-2008'


def md5_local(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run(client, cmd):
    _, out, err = client.exec_command(cmd, timeout=60)
    return out.read().decode().strip(), err.read().decode().strip()


def main():
    local_hash = md5_local(LOCAL)
    print('File:', LOCAL, LOCAL.stat().st_size, 'bytes')
    print('MD5 may nay:', local_hash)

    host, user, password = resolve_vps_connection()
    print('Ket noi VPS', host, '...')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30,
                   look_for_keys=False, allow_agent=False)

    before, _ = run(client, f'md5sum {REMOTE} 2>/dev/null || echo CHUA-CO')
    print('MD5 tren VPS truoc khi day:', before)

    # Chi sao luu LAN DAU: lan deploy thu hai ma van cp -f thi ban sao luu bi
    # de len bang chinh ban vua deploy -> mat ban goc truoc khi sua.
    out, err = run(client, f'[ -f {BACKUP} ] && echo DA-CO-SAO-LUU-TU-TRUOC || (cp -f {REMOTE} {BACKUP} && echo DA-SAO-LUU-LAN-DAU)')
    print('Sao luu:', out or err)

    sftp = client.open_sftp()
    sftp.put(str(LOCAL), REMOTE)
    sftp.close()

    after, _ = run(client, f'md5sum {REMOTE}')
    print('MD5 tren VPS sau khi day:', after)

    ok = after.split()[0] == local_hash if after else False
    print('KHOP MD5:', ok)

    # kiem tra ban moi that su co mat
    probe, _ = run(client, f"grep -c 'tryGap2EjectWithCompanion' {REMOTE}")
    print("So lan xuat hien 'tryGap2EjectWithCompanion' tren VPS:", probe)

    svc, _ = run(client, 'systemctl is-active tkb-app')
    print('Dich vu tkb-app:', svc)

    client.close()
    print('\nXONG.' if ok else '\nTHAT BAI: MD5 khong khop, hay chay lai.')
    print('Neu can quay lai ban cu: cp -f ' + BACKUP + ' ' + REMOTE)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
