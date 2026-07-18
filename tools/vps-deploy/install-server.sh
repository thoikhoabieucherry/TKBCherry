#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/cherry-scheduler"
BACKUP_DIR="/opt/cherry-scheduler-backups"
DOMAIN="${TKB_DOMAIN:-tkbcherry.com}"
MAIL_PORT="${TKB_MAIL_PORT:-8787}"
APP_PORT="${TKB_APP_PORT:-1010}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --fix-missing nginx certbot python3-certbot-nginx python3-pip \
  build-essential curl pkg-config libssl-dev ufw rsync ca-certificates gnupg python-is-python3 || true

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

mkdir -p "$APP_DIR"
mkdir -p "$BACKUP_DIR"
if [ -d "$APP_DIR" ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  find "$APP_DIR" -type f \( \
    -name '*.db' -o \
    -name '*.sqlite' -o \
    -name '*.sqlite3' -o \
    -name '.env' \
  \) -print0 | tar --null -czf "$BACKUP_DIR/server-state-${stamp}.tar.gz" --files-from - --ignore-failed-read 2>/dev/null || true
fi
rsync -a --delete \
  --exclude='*.db' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite3' \
  --exclude='.env' \
  --exclude='mail-server/.env' \
  --exclude='solver_runtime/logs/' \
  /tmp/cherry-upload/ "$APP_DIR/"

if [ -f "$APP_DIR/web/downloads/TKBCherryAgent-Windows.zip" ]; then
  chmod 0755 "$APP_DIR" "$APP_DIR/web" "$APP_DIR/web/downloads"
  chmod 0644 "$APP_DIR/web/downloads/TKBCherryAgent-Windows.zip"
fi
if [ -f "$APP_DIR/web/downloads/TKBCherryAgent-release.json" ]; then
  chmod 0644 "$APP_DIR/web/downloads/TKBCherryAgent-release.json"
fi

python3 -m pip install --break-system-packages -r "$APP_DIR/solver_runtime/requirements.txt"

cd "$APP_DIR/rust_api"
cargo build --release

cd "$APP_DIR/mail-server"
npm install --omit=dev

cat > "$APP_DIR/mail-server/.env" <<EOF
GMAIL_USER=${GMAIL_USER}
GMAIL_APP_PASSWORD=${GMAIL_APP_PASSWORD}
FROM_NAME=${FROM_NAME:-Cherry Scheduler}
PORT=${MAIL_PORT}
EOF

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

    # TKB_AGENT_DOWNLOAD_BEGIN
    location = /downloads/TKBCherryAgent-Windows.zip {
        alias ${APP_DIR}/web/downloads/TKBCherryAgent-Windows.zip;
        default_type application/zip;
        add_header Content-Disposition 'attachment; filename="TKBCherryAgent-Windows.zip"' always;
        add_header X-Content-Type-Options nosniff always;
    }

    location = /downloads/TKBCherryAgent-release.json {
        alias ${APP_DIR}/web/downloads/TKBCherryAgent-release.json;
        default_type application/json;
        add_header Cache-Control 'no-store' always;
        add_header X-Content-Type-Options nosniff always;
    }
    # TKB_AGENT_DOWNLOAD_END

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

if getent hosts "${DOMAIN}" >/dev/null 2>&1; then
  certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "${GMAIL_USER}" --redirect || true
fi

echo "DEPLOY_OK"
curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" | head -c 200 || true
echo
curl -fsS "http://127.0.0.1:${MAIL_PORT}/api/health" | head -c 200 || true
echo
