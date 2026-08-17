#!/usr/bin/env python3
"""Audit or remove retired TKBCherry assets from the production VPS.

The default mode is read-only. ``--apply`` is intentionally narrow: it only
removes the retired browser/Agent solver assets, named test artifacts in
``/tmp``, and old directory-style rollback experiments. Databases, secrets,
runtime binaries, source modules, archive backups and recent rollbacks are not
eligible.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from deploy import run_ssh  # noqa: E402
from vps_credentials import missing_credential_message, resolve_vps_connection  # noqa: E402


REMOTE_SCRIPT = r'''
from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

apply_changes = sys.argv[1] == "apply"
app_root = Path("/opt/cherry-scheduler")
backup_root = Path("/opt/cherry-scheduler-backups")
tmp_root = Path("/tmp")
cutoff = datetime(2026, 8, 8, tzinfo=timezone.utc).timestamp()

keep_old_backup_dirs = {
    "two-click-auto-v1177-20260801-161938",
    "google-cost-max-20260802-021406",
    "planner-optimize-menu-v1180-20260802-090905",
}

retired_live = [
    app_root / "web" / "downloads" / "TKBCherryAgent-Windows.zip",
    app_root / "web" / "downloads" / "TKBCherryAgent-release.json",
    app_root / "web" / "pages" / "tkb-browser-wasm.js",
    app_root / "web" / "pages" / "tkb-browser-wasm-worker.js",
    app_root / "web" / "pages" / "tkb-cpsat-wasm.js",
    app_root / "web" / "pages" / "tkb-highs-wasm.js",
    app_root / "web" / "pages" / "tkb_native_solver.wasm",
    app_root / "web" / "vendor" / "highs",
    app_root / "web" / "vendor" / "or-tools-wasm",
]

tmp_prefixes = (
    "cherry-deploy-",
    "cherry-upload-",
    "tkb-canonical-watchdog-",
    "tkb-capacity-partial-",
    "tkb-fresh-complete-",
    "tkb-isolated-",
    "tkb-rnd-",
    "tkb-serverless-test-",
    "tkb-stage-",
    "tkb-v144-",
    "tkb-v145-",
    "tkb-wasm-build-",
    "tkb-zero-slack-",
)


def path_size(path: Path) -> int:
    try:
        if path.is_symlink() or path.is_file():
            return path.lstat().st_size
    except OSError:
        return 0
    total = 0
    for base, _dirs, files in os.walk(path, followlinks=False):
        for name in files:
            try:
                total += (Path(base) / name).lstat().st_size
            except OSError:
                pass
    return total


def safe_child(path: Path, root: Path) -> bool:
    try:
        resolved = path.resolve(strict=False)
        root_resolved = root.resolve(strict=True)
        return resolved != root_resolved and resolved.is_relative_to(root_resolved)
    except (OSError, RuntimeError):
        return False


def health_snapshot() -> dict:
    with urllib.request.urlopen("http://127.0.0.1:1010/api/health", timeout=8) as response:
        return json.load(response)


health_before = health_snapshot()
if apply_changes:
    if not health_before.get("ok"):
        raise SystemExit("health check is not OK")
    if int(health_before.get("solverActiveJobs", 0)) != 0:
        raise SystemExit("solver has active jobs; cleanup refused")
    if int(health_before.get("solverQueuedJobs", 0)) != 0:
        raise SystemExit("solver has queued jobs; cleanup refused")

candidates: list[tuple[str, Path, Path]] = []
for path in retired_live:
    if path.exists() or path.is_symlink():
        candidates.append(("retired_live", path, app_root))

if backup_root.is_dir():
    for path in backup_root.iterdir():
        try:
            is_directory = path.is_dir() and not path.is_symlink()
            old_experiment = (
                is_directory
                and path.name not in keep_old_backup_dirs
                and path.stat().st_mtime < cutoff
            )
            retired_lane = is_directory and (
                path.name.startswith("rnd-algorithm-")
                or "agent" in path.name.lower()
            )
            stale_sidecar = path.is_file() and path.name.endswith((".db-wal", ".db-shm"))
            if old_experiment or retired_lane or stale_sidecar:
                candidates.append(("old_backup", path, backup_root))
        except OSError:
            continue

if tmp_root.is_dir():
    for path in tmp_root.iterdir():
        if path.name in {"tkb-fmt.out", "tkb-fmt.err"} or path.name.startswith(tmp_prefixes):
            candidates.append(("test_tmp", path, tmp_root))

unique: dict[str, tuple[str, Path, Path]] = {}
for scope, path, root in candidates:
    unique[str(path)] = (scope, path, root)

items = []
for scope, path, root in sorted(unique.values(), key=lambda item: str(item[1])):
    if not safe_child(path, root):
        raise SystemExit(f"unsafe candidate escaped its root: {path}")
    items.append({"scope": scope, "path": str(path), "bytes": path_size(path)})

errors = []
deleted = []
if apply_changes:
    for item in sorted(items, key=lambda entry: len(entry["path"]), reverse=True):
        path = Path(item["path"])
        try:
            if path.is_symlink() or path.is_file():
                path.unlink(missing_ok=True)
            elif path.exists():
                shutil.rmtree(path)
            deleted.append(item)
        except OSError as error:
            errors.append({"path": str(path), "error": str(error)})

health_after = health_snapshot()
result = {
    "mode": "apply" if apply_changes else "audit",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "healthBefore": {
        "ok": health_before.get("ok"),
        "version": health_before.get("version"),
        "active": health_before.get("solverActiveJobs"),
        "queued": health_before.get("solverQueuedJobs"),
        "tokensAvailable": health_before.get("solverWorkerTokensAvailable"),
    },
    "healthAfter": {
        "ok": health_after.get("ok"),
        "version": health_after.get("version"),
        "active": health_after.get("solverActiveJobs"),
        "queued": health_after.get("solverQueuedJobs"),
        "tokensAvailable": health_after.get("solverWorkerTokensAvailable"),
    },
    "candidateCount": len(items),
    "candidateBytes": sum(item["bytes"] for item in items),
    "deletedCount": len(deleted),
    "deletedBytes": sum(item["bytes"] for item in deleted),
    "items": items,
    "errors": errors,
}
print(json.dumps(result, ensure_ascii=True, sort_keys=True))
if errors:
    raise SystemExit(2)
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="delete audited candidates")
    parser.add_argument("--manifest", type=Path, help="write the JSON audit/result here")
    args = parser.parse_args()

    host, user, password = resolve_vps_connection()
    if not password:
        print(missing_credential_message(), file=sys.stderr)
        return 1

    encoded = base64.b64encode(REMOTE_SCRIPT.encode("utf-8")).decode("ascii")
    mode = "apply" if args.apply else "audit"
    remote = (
        "set -eu; "
        "exec 9>/run/lock/cherry-scheduler-deploy.lock; "
        "flock -n 9 || { echo 'Another deployment or cleanup is running.' >&2; exit 75; }; "
        f"python3 -c \"import base64;exec(base64.b64decode('{encoded}'))\" {mode}"
    )
    code, stdout, stderr = run_ssh(host, user, password, remote, timeout=900)
    if stderr:
        print(stderr, file=sys.stderr)
    payload = None
    for line in reversed(stdout.splitlines()):
        try:
            payload = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    if payload is None:
        print(stdout)
        print("Cleanup did not return a JSON result", file=sys.stderr)
        return code or 2

    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    print(
        f"mode={payload['mode']} candidates={payload['candidateCount']} "
        f"candidateBytes={payload['candidateBytes']} deleted={payload['deletedCount']} "
        f"deletedBytes={payload['deletedBytes']} errors={len(payload['errors'])}"
    )
    print(
        "health="
        f"{payload['healthAfter']['ok']} active={payload['healthAfter']['active']} "
        f"queued={payload['healthAfter']['queued']} "
        f"tokens={payload['healthAfter']['tokensAvailable']}"
    )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
