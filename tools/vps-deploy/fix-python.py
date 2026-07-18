import sys
import paramiko

from vps_credentials import missing_credential_message, resolve_vps_connection

HOST, USER, PASSWORD = resolve_vps_connection()
if not PASSWORD:
    print(missing_credential_message(), file=sys.stderr)
    raise SystemExit(1)

PATCH = """
set -e
apt-get install -y python-is-python3 || true
mkdir -p /etc/systemd/system/tkb-app.service.d
cat > /etc/systemd/system/tkb-app.service.d/python.conf <<'EOF'
[Service]
Environment=TKB_REFERENCE_PYTHON=/usr/bin/python3
EOF
cat > /etc/systemd/system/tkb-app.service.d/solver-pool.conf <<'EOF'
[Service]
Environment=TKB_SOLVER_MAX_CONCURRENT=3
Environment=TKB_SOLVER_CPU_TOKENS=6
Environment=TKB_SOLVER_MIN_WORKERS=2
Environment=TKB_SOLVER_MAX_WORKERS=6
Environment=TKB_SOLVER_REQUIRE_AUTH=1
Environment=TKB_SESSION_CP_SAT_LINEARIZATION_LEVEL=1
Environment=OMP_NUM_THREADS=1
Environment=OMP_THREAD_LIMIT=1
Environment=OPENBLAS_NUM_THREADS=1
Environment=MKL_NUM_THREADS=1
Environment=NUMEXPR_NUM_THREADS=1
Environment=VECLIB_MAXIMUM_THREADS=1
Environment=BLIS_NUM_THREADS=1
EOF
systemctl daemon-reload
systemctl restart tkb-app
sleep 2
command -v python || echo NO_PYTHON
command -v python3
curl -fsS http://127.0.0.1:1010/api/health | head -c 120
echo
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=30)
_, o, e = c.exec_command(PATCH, timeout=120)
print(o.read().decode("utf-8", "replace"))
err = e.read().decode("utf-8", "replace")
if err:
    print(err)
print("exit", o.channel.recv_exit_status())
c.close()
