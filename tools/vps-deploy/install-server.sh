#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_DIR="/opt/cherry-scheduler"
BACKUP_DIR="/opt/cherry-scheduler-backups"
UPLOAD_DIR="${TKB_DEPLOY_UPLOAD_DIR:-/tmp/cherry-upload}"
DOMAIN="${TKB_DOMAIN:-tkbcherry.com}"
MAIL_PORT="${TKB_MAIL_PORT:-8787}"
APP_PORT="${TKB_APP_PORT:-1010}"
STATE_BACKUP=""

prune_runtime_artifacts() {
  local target_dir="$APP_DIR/rust_api/target"
  local release_dir="$target_dir/release"
  local runtime_binary="$release_dir/tkb_rust_api"
  [ -x "$runtime_binary" ] || {
    echo "Rust runtime binary is missing after build: $runtime_binary" >&2
    return 1
  }
  rm -rf -- "$APP_DIR/rust_api/target-gnu" "$APP_DIR/solver_runtime/logs"
  find "$target_dir" -mindepth 1 -maxdepth 1 ! -name release -exec rm -rf -- {} +
  find "$release_dir" -mindepth 1 -maxdepth 1 ! -name tkb_rust_api -exec rm -rf -- {} +
}

prune_old_backups() {
  python3 - "$BACKUP_DIR" "" "$STATE_BACKUP" <<'PY_PRUNE_BACKUPS'
from pathlib import Path
import sys

directory = Path(sys.argv[1])
current_release = Path(sys.argv[2]).resolve() if sys.argv[2] else None
current_state = Path(sys.argv[3]).resolve() if sys.argv[3] else None


def prune(pattern: str, keep: int, current: Path | None) -> None:
    candidates = [
        path
        for path in directory.glob(pattern)
        if path.is_file() and "manual" not in path.name.lower()
    ]
    candidates.sort(
        key=lambda path: (path.stat().st_mtime_ns, path.name),
        reverse=True,
    )
    protected = {path.resolve() for path in candidates[:keep]}
    if current is not None:
        protected.add(current)
    for path in candidates:
        if path.resolve() not in protected:
            path.unlink()


prune("app-release-*.tar.gz", 10, current_release)
prune("server-state-*.tar.gz", 30, current_state)
PY_PRUNE_BACKUPS
}

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --fix-missing nginx certbot python3-certbot-nginx python3-pip \
  build-essential curl pkg-config libssl-dev libsqlite3-dev ufw rsync ca-certificates gnupg python-is-python3 || true

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env" || true
export PATH="$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

install -d -m 0755 "$APP_DIR"
install -d -m 0700 "$BACKUP_DIR"
if [ -d "$APP_DIR" ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  STATE_BACKUP="$BACKUP_DIR/server-state-${stamp}.tar.gz"
  find "$APP_DIR" -type f \( \
    -name '*.db' -o \
    -name '*.sqlite' -o \
    -name '*.sqlite3' -o \
    -name '.env' \
  \) -print0 | tar --null -czf "$STATE_BACKUP" --files-from - --ignore-failed-read 2>/dev/null || true
  [ ! -f "$STATE_BACKUP" ] || chmod 0600 "$STATE_BACKUP"
fi
rsync -a --delete \
  --exclude='*.db' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite3' \
  --exclude='.env' \
  --exclude='mail-server/.env' \
  "$UPLOAD_DIR/" "$APP_DIR/"

python3 -m pip install --break-system-packages -r "$APP_DIR/solver_runtime/requirements.txt"

cd "$APP_DIR/rust_api"
cargo build --release --locked
prune_runtime_artifacts

cd "$APP_DIR/mail-server"
npm install --omit=dev

cat > "$APP_DIR/mail-server/.env" <<EOF
GMAIL_USER=${GMAIL_USER}
GMAIL_APP_PASSWORD=${GMAIL_APP_PASSWORD}
FROM_NAME=${FROM_NAME:-Cherry Scheduler}
PORT=${MAIL_PORT}
EOF
chmod 0600 "$APP_DIR/mail-server/.env"

cat > /etc/systemd/system/tkb-mail.service <<EOF
[Unit]
Description=Cherry Scheduler Mail OTP
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/mail-server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/tkb-app.service <<EOF
[Unit]
Description=Cherry Scheduler Rust API
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/rust_api
Environment=TKB_APP_ROOT=${APP_DIR}
Environment=TKB_RUST_HOST=127.0.0.1
Environment=TKB_RUST_PORT=${APP_PORT}
Environment=TKB_REFERENCE_PYTHON=/usr/bin/python3
Environment=TKB_SOLVER_MAX_CONCURRENT=3
Environment=TKB_SOLVER_CPU_TOKENS=6
Environment=TKB_SOLVER_MIN_WORKERS=2
Environment=TKB_SOLVER_MAX_WORKERS=6
Environment=TKB_EXTERNAL_CP_SAT_BUILDERS=2
Environment=TKB_REFERENCE_HELPER_PROCESSES=3
Environment=TKB_SOLVER_REQUIRE_AUTH=1
Environment=TKB_SESSION_CP_SAT_LINEARIZATION_LEVEL=1
Environment=OMP_NUM_THREADS=1
Environment=OMP_THREAD_LIMIT=1
Environment=OPENBLAS_NUM_THREADS=1
Environment=MKL_NUM_THREADS=1
Environment=NUMEXPR_NUM_THREADS=1
Environment=VECLIB_MAXIMUM_THREADS=1
Environment=BLIS_NUM_THREADS=1
Environment=TKB_NO_LOGS=1
Environment=TKB_RUST_QUIET=1
ExecStart=${APP_DIR}/rust_api/target/release/tkb_rust_api
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/sites-available/tkbcherry <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    client_max_body_size 32m;

    location = /api/send-otp {
        proxy_pass http://127.0.0.1:${MAIL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/tkbcherry /etc/nginx/sites-enabled/tkbcherry
rm -f /etc/nginx/sites-enabled/default

ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

systemctl daemon-reload
systemctl enable tkb-mail tkb-app nginx
systemctl restart tkb-mail
systemctl restart tkb-app
nginx -t
systemctl reload nginx
prune_old_backups || echo "Warning: could not prune old deployment backups" >&2

if getent hosts "${DOMAIN}" >/dev/null 2>&1; then
  certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "${GMAIL_USER}" --redirect || true
fi

echo "DEPLOY_OK"
curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" | head -c 200 || true
echo
curl -fsS "http://127.0.0.1:${MAIL_PORT}/api/health" | head -c 200 || true
echo
