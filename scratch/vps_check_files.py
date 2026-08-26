# So sanh file web tren VPS voi ban tren may nay (chi doc, khong ghi gi).
import sys, hashlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'vps-deploy'))
sys.stdout.reconfigure(encoding='utf-8')
from vps_credentials import resolve_vps_connection
import paramiko

FILES = [
    ('web/pages/tkb-rust-bridge.js', '/opt/cherry-scheduler/web/pages/tkb-rust-bridge.js'),
    ('web/pages/phanmon.js', '/opt/cherry-scheduler/web/pages/phanmon.js'),
    ('web/pages/sapxep.html', '/opt/cherry-scheduler/web/pages/sapxep.html'),
    ('web/pages/tkb-fet-engine.js', '/opt/cherry-scheduler/web/pages/tkb-fet-engine.js'),
    ('web/pages/tkb-fet-worker.js', '/opt/cherry-scheduler/web/pages/tkb-fet-worker.js'),
    ('solver_runtime/src/tkb_engine_v3/construct.py', '/opt/cherry-scheduler/solver_runtime/src/tkb_engine_v3/construct.py'),
    ('solver_runtime/src/tkb_engine_v3/entry.py', '/opt/cherry-scheduler/solver_runtime/src/tkb_engine_v3/entry.py'),
    ('solver_runtime/src/tkb_engine_v3/optimize.py', '/opt/cherry-scheduler/solver_runtime/src/tkb_engine_v3/optimize.py'),
]

GREPS = [
    ('/opt/cherry-scheduler/web/pages/tkb-rust-bridge.js', 'isCherryEngineRun(candidate, settings)) return true'),
    ('/opt/cherry-scheduler/web/pages/tkb-fet-engine.js', 'tryGap2EjectWithCompanion'),
]


def md5_local(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


host, user, password = resolve_vps_connection()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=password, timeout=30, look_for_keys=False, allow_agent=False)


def run(cmd):
    _, out, err = client.exec_command(cmd, timeout=60)
    return out.read().decode().strip(), err.read().decode().strip()


print('%-52s %-8s %s' % ('FILE', 'TRANG THAI', 'ghi chu'))
for rel, remote in FILES:
    lp = REPO_ROOT / rel
    if not lp.exists():
        print('%-52s %-8s' % (rel, 'THIEU-MAY'))
        continue
    lh = md5_local(lp)
    out, _ = run('md5sum %s 2>/dev/null || echo THIEU' % remote)
    rh = out.split()[0] if out and out != 'THIEU' else 'THIEU'
    same = 'KHOP' if rh == lh else 'KHAC'
    print('%-52s %-8s may=%s vps=%s' % (rel, same, lh[:10], rh[:10]))

print()
for remote, needle in GREPS:
    out, _ = run("grep -c '%s' %s 2>/dev/null || echo 0" % (needle.replace("'", "'\\''"), remote))
    print('VPS co "%s": %s lan' % (needle[:48], out))

client.close()
