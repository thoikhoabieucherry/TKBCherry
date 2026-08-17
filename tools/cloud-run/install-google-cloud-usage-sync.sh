#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TKB_APP_ROOT:-/opt/cherry-scheduler}"
ENV_FILE="${TKB_GOOGLE_CLOUD_USAGE_ENV_FILE:-/etc/tkb-google-cloud-usage.env}"
SCRIPT="$APP_DIR/solver_runtime/scripts/google_cloud_usage_sync.py"
SERVICE_SOURCE="$APP_DIR/tools/cloud-run/tkb-google-cloud-usage.service"
TIMER_SOURCE="$APP_DIR/tools/cloud-run/tkb-google-cloud-usage.timer"
PATH_SOURCE="$APP_DIR/tools/cloud-run/tkb-google-cloud-usage.path"
EXAMPLE_SOURCE="$APP_DIR/tools/cloud-run/google-cloud-usage.env.example"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
[ -f "$SCRIPT" ]
[ -f "$SERVICE_SOURCE" ]
[ -f "$TIMER_SOURCE" ]
[ -f "$PATH_SOURCE" ]
[ -f "$EXAMPLE_SOURCE" ]

python3 -m py_compile "$SCRIPT"
install -d -m 0700 "$APP_DIR/data"
install -m 0644 "$SERVICE_SOURCE" /etc/systemd/system/tkb-google-cloud-usage.service
install -m 0644 "$TIMER_SOURCE" /etc/systemd/system/tkb-google-cloud-usage.timer
install -m 0644 "$PATH_SOURCE" /etc/systemd/system/tkb-google-cloud-usage.path
if [ ! -e "$ENV_FILE" ]; then
  install -m 0600 "$EXAMPLE_SOURCE" "$ENV_FILE"
  echo "Created $ENV_FILE. Review its public project/table identifiers before enabling sync."
fi

systemctl daemon-reload
systemctl enable --now tkb-google-cloud-usage.timer
systemctl enable --now tkb-google-cloud-usage.path
systemctl start tkb-google-cloud-usage.service
systemctl --no-pager --full status tkb-google-cloud-usage.service || true
echo "GOOGLE_CLOUD_USAGE_SYNC_INSTALLED"
