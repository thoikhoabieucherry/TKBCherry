#!/usr/bin/env bash
set -euo pipefail
umask 077

INSTALL_ROOT="/opt/tkbcherry-trusted-worker"
CONFIG_ROOT="/etc/tkbcherry"
STATE_ROOT="/var/lib/tkbcherry-trusted-worker"
SERVICE_NAME="tkb-trusted-worker.service"
WORKER_USER="tkb-trusted-worker"
SOURCE_ROOT=""
START_WHEN_READY=1

usage() {
  cat <<'EOF'
Usage: sudo bash tools/trusted-worker/install-linux.sh [options]

Install an operator-controlled, outbound-only TKBCherry trusted worker.

Options:
  --source DIR   Repository root to install (default: inferred from this script)
  --no-start     Install/update files but do not enable or start the service
  -h, --help     Show this help

The raw tkbt_ bearer is never accepted as a command-line argument. Create the
protected credential separately with create-credential.py.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || { echo "--source requires a directory" >&2; exit 2; }
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --no-start)
      START_WHEN_READY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run this installer as root (for example with sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -z "$SOURCE_ROOT" ]; then
  SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
else
  SOURCE_ROOT="$(cd -- "$SOURCE_ROOT" && pwd -P)"
fi

for required in \
  "$SOURCE_ROOT/agent_helper/__main__.py" \
  "$SOURCE_ROOT/solver_runtime/scripts/solve_stdio.py" \
  "$SOURCE_ROOT/solver_runtime/src" \
  "$SOURCE_ROOT/solver_runtime/requirements.txt" \
  "$SCRIPT_DIR/config.example.json" \
  "$SCRIPT_DIR/tkb-trusted-worker.service"; do
  [ -e "$required" ] || { echo "Missing required source: $required" >&2; exit 1; }
done

command -v python3 >/dev/null 2>&1 || {
  echo "Python 3.11 or newer is required." >&2
  exit 1
}
python3 - <<'PY_VERSION'
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Python 3.11 or newer is required")
PY_VERSION

if ! id "$WORKER_USER" >/dev/null 2>&1; then
  useradd \
    --system \
    --home-dir "$STATE_ROOT" \
    --shell /usr/sbin/nologin \
    --user-group \
    "$WORKER_USER"
fi

install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/releases"
install -d -o root -g root -m 0755 "$CONFIG_ROOT"
install -d -o "$WORKER_USER" -g "$WORKER_USER" -m 0700 "$STATE_ROOT"

release_name="$(date -u +%Y%m%dT%H%M%SZ)-$$"
release_dir="$INSTALL_ROOT/releases/$release_name"
pending_link="$INSTALL_ROOT/.current-$release_name"
old_release=""
swapped_release=0
install -d -o root -g root -m 0755 "$release_dir/agent_helper"

cleanup_failed_release() {
  rm -f -- "$pending_link"
  if [ -n "${release_dir:-}" ] && [ -d "$release_dir" ]; then
    rm -rf -- "$release_dir"
  fi
}

abort_install() {
  local status=$?
  [ "$status" -ne 0 ] || status=1
  trap - EXIT HUP INT TERM
  if [ "$swapped_release" -eq 1 ]; then
    rollback_release
  else
    cleanup_failed_release
  fi
  exit "$status"
}
trap abort_install EXIT HUP INT TERM

while IFS= read -r -d '' source_file; do
  install -o root -g root -m 0644 \
    "$source_file" "$release_dir/agent_helper/$(basename -- "$source_file")"
done < <(find "$SOURCE_ROOT/agent_helper" -maxdepth 1 -type f -name '*.py' -print0)

cp -a -- "$SOURCE_ROOT/solver_runtime/scripts" "$release_dir/solver_runtime-scripts"
cp -a -- "$SOURCE_ROOT/solver_runtime/src" "$release_dir/solver_runtime-src"
install -d -o root -g root -m 0755 "$release_dir/solver_runtime"
mv -- "$release_dir/solver_runtime-scripts" "$release_dir/solver_runtime/scripts"
mv -- "$release_dir/solver_runtime-src" "$release_dir/solver_runtime/src"
install -o root -g root -m 0644 \
  "$SOURCE_ROOT/solver_runtime/requirements.txt" \
  "$release_dir/solver_runtime/requirements.txt"

python3 -m venv "$release_dir/venv"
"$release_dir/venv/bin/python" -m pip install \
  --disable-pip-version-check \
  --no-input \
  -r "$release_dir/solver_runtime/requirements.txt"

chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod go-w {} +

if [ ! -f "$CONFIG_ROOT/trusted-worker.json" ]; then
  install -o root -g root -m 0644 \
    "$SCRIPT_DIR/config.example.json" "$CONFIG_ROOT/trusted-worker.json"
fi
[ -f "$CONFIG_ROOT/trusted-worker.json" ] && [ ! -L "$CONFIG_ROOT/trusted-worker.json" ] || {
  echo "Worker config must be a regular file, not a symlink." >&2
  exit 1
}
chown root:root "$CONFIG_ROOT/trusted-worker.json"
chmod 0644 "$CONFIG_ROOT/trusted-worker.json"
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/tkb-trusted-worker.service" \
  "/etc/systemd/system/$SERVICE_NAME"

rollback_release() {
  swapped_release=0
  if [ -n "$old_release" ] && [ -d "$old_release" ]; then
    ln -s -- "$old_release" "$pending_link"
    mv -Tf -- "$pending_link" "$INSTALL_ROOT/current"
    systemctl daemon-reload
    if [ -f "$CONFIG_ROOT/trusted-worker.env" ]; then
      systemctl restart "$SERVICE_NAME" || true
    fi
  else
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f -- "$INSTALL_ROOT/current"
  fi
  cleanup_failed_release
}

if [ -L "$INSTALL_ROOT/current" ]; then
  old_release="$(readlink -f -- "$INSTALL_ROOT/current" || true)"
fi
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
ln -s -- "$release_dir" "$pending_link"
mv -Tf -- "$pending_link" "$INSTALL_ROOT/current"
swapped_release=1
systemctl daemon-reload

credential_is_safe() {
  local credential="$CONFIG_ROOT/trusted-worker.env"
  [ -f "$credential" ] &&
    [ ! -L "$credential" ] &&
    [ "$(stat -c '%u' "$credential")" = "0" ] &&
    [ "$(stat -c '%a' "$credential")" = "600" ] &&
    [ "$(wc -l < "$credential")" -eq 1 ] &&
    grep -Eq '^TKB_AGENT_TOKEN=tkbt_[A-Za-z0-9_-]{64}$' "$credential"
}

if [ -e "$CONFIG_ROOT/trusted-worker.env" ] && ! credential_is_safe; then
  echo "Credential must be a root-owned regular mode-0600 file created by create-credential.py." >&2
  rollback_release
  exit 1
fi

if [ "$START_WHEN_READY" -eq 1 ] && credential_is_safe; then
  if ! systemctl enable --now "$SERVICE_NAME"; then
    echo "New worker failed to start; restoring the prior release." >&2
    rollback_release
    exit 1
  fi
  sleep 2
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "New worker did not remain active; restoring the prior release." >&2
    rollback_release
    exit 1
  fi
  echo "Trusted worker installed and running."
else
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  echo "Trusted worker installed but not started."
  echo "Create $CONFIG_ROOT/trusted-worker.env, configure its digest on the API, then run:"
  echo "  systemctl enable --now $SERVICE_NAME"
fi

trap - EXIT HUP INT TERM
release_dir=""
echo "Release: $release_name"
