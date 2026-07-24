#!/usr/bin/env bash
# Update application code with persistent-data protection and automatic rollback.
set -euo pipefail
umask 077
APP_DIR="/opt/cherry-scheduler"
BACKUP_DIR="/opt/cherry-scheduler-backups"
UPLOAD_DIR="${TKB_DEPLOY_UPLOAD_DIR:-/tmp/cherry-upload}"
ARCHIVE_PATH="${TKB_DEPLOY_ARCHIVE_PATH:-/tmp/cherry-deploy.tar.gz}"
SCRIPT_PATH="${TKB_DEPLOY_SCRIPT_PATH:-/tmp/update-server.sh}"
DEPLOY_LOCK_FILE="${TKB_DEPLOY_LOCK_FILE:-/run/lock/cherry-scheduler-deploy.lock}"
DRAIN_TIMEOUT_SECONDS="${TKB_DEPLOY_DRAIN_TIMEOUT_SECONDS:-900}"
DRAIN_STABLE_CHECKS="${TKB_DEPLOY_DRAIN_STABLE_CHECKS:-3}"
DRAIN_RESULT_GRACE_SECONDS="${TKB_DEPLOY_RESULT_GRACE_SECONDS:-10}"
STAMP="$(date +%Y%m%d-%H%M%S)"
STATE_BACKUP="$BACKUP_DIR/server-state-${STAMP}.tar.gz"
RELEASE_BACKUP="$BACKUP_DIR/app-release-${STAMP}.tar.gz"
BACKUP_STAGE=""
UPDATE_STARTED=0
NGINX_SITE_CONFIG="${TKB_NGINX_SITE_CONFIG:-/etc/nginx/sites-enabled/tkbcherry}"
NGINX_GATE_BACKUP=""
NGINX_GATE_SITE=""
NGINX_GATE_ENABLED=0
AGENT_ROLLBACK_STAGE=""
CANDIDATE_RUST_BINARY=""
CANDIDATE_MAIL_NODE_MODULES=""
MAIL_RUNTIME_ROLLBACK_STAGE=""

for numeric_setting in \
  "$DRAIN_TIMEOUT_SECONDS" \
  "$DRAIN_STABLE_CHECKS" \
  "$DRAIN_RESULT_GRACE_SECONDS"; do
  [[ "$numeric_setting" =~ ^[0-9]+$ ]] || {
    echo "Deploy drain settings must be non-negative integers." >&2
    exit 2
  }
done
[ "$DRAIN_TIMEOUT_SECONDS" -gt 0 ] || {
  echo "TKB_DEPLOY_DRAIN_TIMEOUT_SECONDS must be greater than zero." >&2
  exit 2
}
[ "$DRAIN_STABLE_CHECKS" -gt 0 ] || {
  echo "TKB_DEPLOY_DRAIN_STABLE_CHECKS must be greater than zero." >&2
  exit 2
}

command -v flock >/dev/null 2>&1 || {
  echo "flock is required for serialized deployment." >&2
  exit 1
}
exec 9>"$DEPLOY_LOCK_FILE"
if ! flock -n 9; then
  echo "Another Cherry Scheduler deployment is already running." >&2
  exit 75
fi

ensure_agent_download_location() {
  local site backup
  site="$(readlink -f "$NGINX_SITE_CONFIG")"
  [ -f "$site" ] || {
    echo "Nginx site config not found: $NGINX_SITE_CONFIG" >&2
    return 1
  }
  backup="$(mktemp)"
  cp -p "$site" "$backup"
  python3 - "$site" "$APP_DIR" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
app_dir = Path(sys.argv[2])
source = path.read_text(encoding="utf-8")
begin = "# TKB_AGENT_DOWNLOAD_BEGIN"
end = "# TKB_AGENT_DOWNLOAD_END"
if source.count(begin) != source.count(end):
    raise SystemExit("Agent download location markers are incomplete")
if source.count(begin) > 1:
    raise SystemExit("Agent download location markers are duplicated")
if begin in source:
    block_start = source.rfind("\n", 0, source.index(begin)) + 1
    marker_end = source.find(end, block_start)
    block_end = source.find("\n", marker_end)
    block_end = len(source) if block_end < 0 else block_end + 1
    if source[block_end:block_end + 1] == "\n":
        block_end += 1
    source = source[:block_start] + source[block_end:]
needle = "    location / {"
if needle not in source:
    raise SystemExit("cannot find the primary Nginx proxy location")
download = app_dir / "web" / "downloads" / "TKBCherryAgent-Windows.zip"
manifest = app_dir / "web" / "downloads" / "TKBCherryAgent-release.json"
block = f'''    {begin}
    location = /downloads/TKBCherryAgent-Windows.zip {{
        alias {download};
        default_type application/zip;
        add_header Content-Disposition 'attachment; filename="TKBCherryAgent-Windows.zip"' always;
        add_header X-Content-Type-Options nosniff always;
    }}

    location = /downloads/TKBCherryAgent-release.json {{
        alias {manifest};
        default_type application/json;
        add_header Cache-Control 'no-store' always;
        add_header X-Content-Type-Options nosniff always;
    }}
    {end}

'''
path.write_text(source.replace(needle, block + needle, 1), encoding="utf-8")
PY
  if ! nginx -t; then
    cp -p "$backup" "$site"
    nginx -t || true
    rm -f "$backup"
    return 1
  fi
  systemctl reload nginx
  rm -f "$backup"
}

enable_solver_admission_gate() {
  NGINX_GATE_SITE="$(readlink -f "$NGINX_SITE_CONFIG")"
  [ -f "$NGINX_GATE_SITE" ] || {
    echo "Nginx site config not found: $NGINX_SITE_CONFIG" >&2
    return 1
  }
  NGINX_GATE_BACKUP="$(mktemp)"
  cp -p "$NGINX_GATE_SITE" "$NGINX_GATE_BACKUP"
  NGINX_GATE_ENABLED=1
  python3 - "$NGINX_GATE_SITE" "$NGINX_GATE_BACKUP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
backup = Path(sys.argv[2])
source = path.read_text(encoding="utf-8")
begin = "# TKB_SOLVER_DEPLOY_GATE_BEGIN"
end = "# TKB_SOLVER_DEPLOY_GATE_END"
if (begin in source) != (end in source):
    raise SystemExit("solver deploy gate markers are incomplete")
if begin in source:
    block_start = source.rfind("\n", 0, source.index(begin)) + 1
    marker_end = source.find(end, block_start)
    if marker_end < 0:
        raise SystemExit("solver deploy gate markers are incomplete")
    block_end = source.find("\n", marker_end)
    block_end = len(source) if block_end < 0 else block_end + 1
    if source[block_end:block_end + 1] == "\n":
        block_end += 1
    source = source[:block_start] + source[block_end:]
needle = "    location / {"
if needle not in source:
    raise SystemExit("cannot find the primary Nginx proxy location")
gate = """    # TKB_SOLVER_DEPLOY_GATE_BEGIN
    location = /api/solve-data {
        default_type application/json;
        add_header Retry-After 1 always;
        return 503 '{"ok":false,"kind":"solver_deploy_draining","error":"solver_deploy_draining"}';
    }
    # TKB_SOLVER_DEPLOY_GATE_END

"""
backup.write_text(source, encoding="utf-8")
path.write_text(source.replace(needle, gate + needle, 1), encoding="utf-8")
PY
  if ! nginx -t; then
    cp -p "$NGINX_GATE_BACKUP" "$NGINX_GATE_SITE"
    nginx -t || true
    return 1
  fi
  systemctl reload nginx
}

disable_solver_admission_gate() {
  if [ "$NGINX_GATE_ENABLED" -eq 0 ]; then
    [ -n "$NGINX_GATE_BACKUP" ] && rm -f "$NGINX_GATE_BACKUP"
    return 0
  fi
  cp -p "$NGINX_GATE_BACKUP" "$NGINX_GATE_SITE"
  nginx -t
  systemctl reload nginx
  rm -f "$NGINX_GATE_BACKUP"
  NGINX_GATE_BACKUP=""
  NGINX_GATE_ENABLED=0
}

capture_agent_rollback_files() {
  local filename source
  AGENT_ROLLBACK_STAGE="$(mktemp -d)"
  for filename in TKBCherryAgent-Windows.zip TKBCherryAgent-release.json; do
    source="$APP_DIR/web/downloads/$filename"
    [ ! -f "$source" ] || cp -a "$source" "$AGENT_ROLLBACK_STAGE/$filename"
  done
}

restore_agent_rollback_files() {
  local downloads filename source
  downloads="$APP_DIR/web/downloads"
  install -d -m 0755 "$downloads"
  rm -f -- \
    "$downloads/TKBCherryAgent-Windows.zip" \
    "$downloads/TKBCherryAgent-release.json"
  [ -n "$AGENT_ROLLBACK_STAGE" ] || return 0
  for filename in TKBCherryAgent-Windows.zip TKBCherryAgent-release.json; do
    source="$AGENT_ROLLBACK_STAGE/$filename"
    if [ -f "$source" ]; then
      cp -a "$source" "$downloads/$filename"
      chmod 0644 "$downloads/$filename"
    fi
  done
}

cleanup_agent_rollback_stage() {
  [ -z "$AGENT_ROLLBACK_STAGE" ] || rm -rf -- "$AGENT_ROLLBACK_STAGE"
  AGENT_ROLLBACK_STAGE=""
}

cleanup_mail_runtime_rollback_stage() {
  [ -z "$MAIL_RUNTIME_ROLLBACK_STAGE" ] || \
    rm -rf -- "$MAIL_RUNTIME_ROLLBACK_STAGE"
  MAIL_RUNTIME_ROLLBACK_STAGE=""
}

restore_mail_runtime() {
  local live_modules old_modules
  [ -n "$MAIL_RUNTIME_ROLLBACK_STAGE" ] || return 0
  live_modules="$APP_DIR/mail-server/node_modules"
  old_modules="$MAIL_RUNTIME_ROLLBACK_STAGE/node_modules"
  rm -rf -- "$live_modules"
  if [ -d "$old_modules" ]; then
    mv "$old_modules" "$live_modules"
  fi
}

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
  python3 - "$BACKUP_DIR" "$RELEASE_BACKUP" "$STATE_BACKUP" <<'PY_PRUNE_BACKUPS'
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

backup_server_state() {
  install -d -m 0700 "$BACKUP_DIR"
  if [ -d "$APP_DIR" ]; then
    find "$APP_DIR" -type f \( \
      -name '*.db' -o \
      -name '*.sqlite' -o \
      -name '*.sqlite3' -o \
      -name '.env' \
    \) -print0 | tar --null -czf "$STATE_BACKUP" --files-from - --ignore-failed-read 2>/dev/null || true
    if [ -f "$STATE_BACKUP" ]; then
      chmod 0600 "$STATE_BACKUP"
    fi
  fi
}

backup_release() {
  [ -d "$APP_DIR" ] || return 0
  capture_agent_rollback_files
  BACKUP_STAGE="$(mktemp -d)"
  mkdir -p "$BACKUP_STAGE/app" "$BACKUP_STAGE/systemd"
  rsync -a \
    --exclude='*.db' \
    --exclude='*.sqlite' \
    --exclude='*.sqlite3' \
    --exclude='.env' \
    --exclude='mail-server/.env' \
    --exclude='mail-server/node_modules/' \
    --exclude='rust_api/target/' \
    --exclude='rust_api/target-*/' \
    --exclude='solver_runtime/logs/' \
    --exclude='web/downloads/TKBCherryAgent-Windows.zip' \
    --exclude='web/downloads/TKBCherryAgent-release.json' \
    "$APP_DIR/" "$BACKUP_STAGE/app/"
  if [ -f "$APP_DIR/rust_api/target/release/tkb_rust_api" ]; then
    mkdir -p "$BACKUP_STAGE/app/rust_api/target/release"
    cp -a "$APP_DIR/rust_api/target/release/tkb_rust_api" \
      "$BACKUP_STAGE/app/rust_api/target/release/tkb_rust_api"
  fi
  cp -a /etc/systemd/system/tkb-app.service "$BACKUP_STAGE/systemd/" 2>/dev/null || true
  if [ -d /etc/systemd/system/tkb-app.service.d ]; then
    cp -a /etc/systemd/system/tkb-app.service.d "$BACKUP_STAGE/systemd/"
  fi
  tar -czf "$RELEASE_BACKUP" -C "$BACKUP_STAGE" .
  chmod 0600 "$RELEASE_BACKUP"
  rm -rf "$BACKUP_STAGE"
  BACKUP_STAGE=""
}

restore_release() {
  local restore_dir
  [ -f "$RELEASE_BACKUP" ] || return 1
  restore_dir="$(mktemp -d)"
  tar -xzf "$RELEASE_BACKUP" -C "$restore_dir"
  rsync -a --delete \
    --exclude='*.db' \
    --exclude='*.sqlite' \
    --exclude='*.sqlite3' \
    --exclude='.env' \
    --exclude='mail-server/.env' \
    --exclude='mail-server/node_modules/' \
    --exclude='rust_api/target/' \
    --exclude='rust_api/target-*/' \
    --exclude='solver_runtime/logs/' \
    "$restore_dir/app/" "$APP_DIR/"
  if [ -f "$restore_dir/app/rust_api/target/release/tkb_rust_api" ]; then
    mkdir -p "$APP_DIR/rust_api/target/release"
    cp -a "$restore_dir/app/rust_api/target/release/tkb_rust_api" \
      "$APP_DIR/rust_api/target/release/tkb_rust_api"
  fi
  restore_agent_rollback_files
  restore_mail_runtime
  if [ -f "$restore_dir/systemd/tkb-app.service" ]; then
    cp -a "$restore_dir/systemd/tkb-app.service" /etc/systemd/system/tkb-app.service
  fi
  if [ -d "$restore_dir/systemd/tkb-app.service.d" ]; then
    rm -rf /etc/systemd/system/tkb-app.service.d
    cp -a "$restore_dir/systemd/tkb-app.service.d" /etc/systemd/system/
  fi
  rm -rf "$restore_dir"
  systemctl daemon-reload
  systemctl restart tkb-mail tkb-app
  nginx -t && systemctl reload nginx
}

rollback_on_error() {
  local code=$?
  rollback_and_exit "$code" "Update failed"
}

rollback_on_exit() {
  local code=$?
  [ "$code" -ne 0 ] || code=1
  rollback_and_exit "$code" "Update exited before completion"
}

cleanup_deploy_artifacts() {
  rm -rf -- "$UPLOAD_DIR"
  rm -f -- "$ARCHIVE_PATH" "$SCRIPT_PATH"
}

rollback_and_exit() {
  local code="$1"
  local reason="$2"
  trap - EXIT ERR HUP INT TERM
  set +e
  [ -n "$BACKUP_STAGE" ] && rm -rf "$BACKUP_STAGE"
  if [ "$UPDATE_STARTED" -eq 1 ]; then
    echo "$reason; restoring $RELEASE_BACKUP" >&2
    restore_release || echo "Automatic rollback failed" >&2
  fi
  cleanup_agent_rollback_stage
  cleanup_mail_runtime_rollback_stage
  disable_solver_admission_gate || echo "Failed to remove solver admission gate" >&2
  cleanup_deploy_artifacts
  exit "$code"
}

rollback_on_signal() {
  local signal_name="$1"
  local code="$2"
  rollback_and_exit "$code" "Update interrupted by $signal_name"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 http://127.0.0.1:1010/api/health >/dev/null && \
       curl -fsS --max-time 5 http://127.0.0.1:8787/api/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_solver_idle() {
  local deadline health counts active queued stable_checks=0
  deadline=$((SECONDS + DRAIN_TIMEOUT_SECONDS))
  echo "Draining solver jobs before deployment (timeout=${DRAIN_TIMEOUT_SECONDS}s)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    health="$(curl -fsS --max-time 5 http://127.0.0.1:1010/api/health 2>/dev/null || true)"
    counts="$(python3 -c 'import json,sys; value=json.load(sys.stdin); print(int(value.get("solverActiveJobs", -1)), int(value.get("solverQueuedJobs", -1)))' <<<"$health" 2>/dev/null || true)"
    if read -r active queued <<<"$counts" && \
       [[ "$active" =~ ^[0-9]+$ ]] && [[ "$queued" =~ ^[0-9]+$ ]]; then
      if [ "$active" -eq 0 ] && [ "$queued" -eq 0 ]; then
        stable_checks=$((stable_checks + 1))
        if [ "$stable_checks" -ge "$DRAIN_STABLE_CHECKS" ]; then
          if [ "$DRAIN_RESULT_GRACE_SECONDS" -gt 0 ]; then
            echo "Solver is idle; allowing ${DRAIN_RESULT_GRACE_SECONDS}s for clients to collect results..."
            sleep "$DRAIN_RESULT_GRACE_SECONDS"
          fi
          health="$(curl -fsS --max-time 5 http://127.0.0.1:1010/api/health 2>/dev/null || true)"
          counts="$(python3 -c 'import json,sys; value=json.load(sys.stdin); print(int(value.get("solverActiveJobs", -1)), int(value.get("solverQueuedJobs", -1)))' <<<"$health" 2>/dev/null || true)"
          if read -r active queued <<<"$counts" && \
             [ "$active" = "0" ] && [ "$queued" = "0" ]; then
            echo "Solver drain completed."
            return 0
          fi
          stable_checks=0
        fi
      else
        stable_checks=0
        echo "Waiting for solver jobs (active=$active queued=$queued)..."
      fi
    else
      stable_checks=0
      echo "Waiting for a valid solver health response..." >&2
    fi
    sleep 2
  done
  echo "Timed out draining solver jobs; the running release will remain online." >&2
  return 1
}

prepare_candidate_runtime() {
  if [ ! -f "$UPLOAD_DIR/solver_runtime/requirements.txt" ]; then
    echo "Missing solver_runtime/requirements.txt" >&2
    return 1
  fi
  if [ ! -f "$UPLOAD_DIR/mail-server/package.json" ]; then
    echo "Missing mail-server/package.json in deployment candidate" >&2
    return 1
  fi
  if [ ! -f "$UPLOAD_DIR/rust_api/Cargo.toml" ]; then
    echo "Missing rust_api/Cargo.toml in deployment candidate" >&2
    return 1
  fi
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  export PATH="$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  command -v cargo >/dev/null 2>&1 || {
    echo "cargo is required to build the Rust API" >&2
    return 1
  }

  (cd "$UPLOAD_DIR/mail-server" && npm install --omit=dev)
  CANDIDATE_MAIL_NODE_MODULES="$UPLOAD_DIR/mail-server/node_modules"
  [ -d "$CANDIDATE_MAIL_NODE_MODULES" ] || {
    echo "Candidate mail-server node_modules is missing after install" >&2
    return 1
  }

  (
    cd "$UPLOAD_DIR/rust_api"
    CARGO_TARGET_DIR="$UPLOAD_DIR/rust_api/target" \
      cargo build --release --locked
  )
  CANDIDATE_RUST_BINARY="$UPLOAD_DIR/rust_api/target/release/tkb_rust_api"
  [ -x "$CANDIDATE_RUST_BINARY" ] || {
    echo "Candidate Rust runtime binary is missing after build" >&2
    return 1
  }
}

install_candidate_python_requirements() {
  python3 -m pip install --break-system-packages \
    -r "$UPLOAD_DIR/solver_runtime/requirements.txt"
}

install_candidate_runtime() {
  if [ -n "$CANDIDATE_MAIL_NODE_MODULES" ]; then
    [ -d "$CANDIDATE_MAIL_NODE_MODULES" ] || {
      echo "Candidate mail-server node_modules is missing" >&2
      return 1
    }
    MAIL_RUNTIME_ROLLBACK_STAGE="$(mktemp -d "$(dirname "$APP_DIR")/.cherry-mail-rollback-${STAMP}.XXXXXX")"
    if [ -d "$APP_DIR/mail-server/node_modules" ]; then
      mv "$APP_DIR/mail-server/node_modules" \
        "$MAIL_RUNTIME_ROLLBACK_STAGE/node_modules"
    fi
    install -d -m 0755 "$APP_DIR/mail-server/node_modules"
    rsync -a --delete \
      "$CANDIDATE_MAIL_NODE_MODULES/" \
      "$APP_DIR/mail-server/node_modules/"
  fi

  if [ -n "$CANDIDATE_RUST_BINARY" ]; then
    [ -x "$CANDIDATE_RUST_BINARY" ] || {
      echo "Candidate Rust runtime binary is missing at cutover" >&2
      return 1
    }
    install -d -m 0755 "$APP_DIR/rust_api/target/release"
    install -m 0755 \
      "$CANDIDATE_RUST_BINARY" \
      "$APP_DIR/rust_api/target/release/tkb_rust_api"
  fi
}

trap rollback_on_error ERR
trap rollback_on_exit EXIT
trap 'rollback_on_signal HUP 129' HUP
trap 'rollback_on_signal INT 130' INT
trap 'rollback_on_signal TERM 143' TERM
install -d -m 0700 "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tar.gz' -exec chmod 0600 {} +
prepare_candidate_runtime
ensure_agent_download_location
enable_solver_admission_gate
wait_for_solver_idle
install_candidate_python_requirements
backup_release
UPDATE_STARTED=1
systemctl stop tkb-app tkb-mail
backup_server_state
rsync -a --delete \
  --exclude='*.db' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite3' \
  --exclude='.env' \
  --exclude='mail-server/.env' \
  --exclude='mail-server/node_modules/' \
  --exclude='rust_api/target/' \
  "$UPLOAD_DIR/" "$APP_DIR/"
install_candidate_runtime
if [ -f "$APP_DIR/web/downloads/TKBCherryAgent-Windows.zip" ]; then
  chmod 0755 "$APP_DIR" "$APP_DIR/web" "$APP_DIR/web/downloads"
  chmod 0644 "$APP_DIR/web/downloads/TKBCherryAgent-Windows.zip"
fi
if [ -f "$APP_DIR/web/downloads/TKBCherryAgent-release.json" ]; then
  chmod 0644 "$APP_DIR/web/downloads/TKBCherryAgent-release.json"
fi
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
mkdir -p /etc/systemd/system/tkb-app.service.d
if [ -f "$APP_DIR/tools/vps-deploy/solver-pool.conf" ]; then
  cp "$APP_DIR/tools/vps-deploy/solver-pool.conf" /etc/systemd/system/tkb-app.service.d/solver-pool.conf
fi
if [ -n "${TKB_SUPER_PASSWORD:-}" ]; then
  printf '[Service]\nEnvironment=TKB_SUPER_PASSWORD=%s\n' "$TKB_SUPER_PASSWORD" \
    > /etc/systemd/system/tkb-app.service.d/super-admin.conf
elif [ -f /etc/systemd/system/tkb-app.service.d/super-admin.conf ]; then
  : # keep existing VPS config
fi
systemctl daemon-reload
systemctl restart tkb-mail tkb-app
nginx -t
systemctl reload nginx
wait_for_health
prune_runtime_artifacts
disable_solver_admission_gate
UPDATE_STARTED=0
cleanup_agent_rollback_stage
cleanup_mail_runtime_rollback_stage
prune_old_backups || echo "Warning: could not prune old deployment backups" >&2
trap - EXIT ERR HUP INT TERM
echo "STATE_BACKUP=$STATE_BACKUP"
echo "RELEASE_BACKUP=$RELEASE_BACKUP"
echo "UPDATE_OK"
cleanup_deploy_artifacts || true
