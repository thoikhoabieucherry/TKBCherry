#!/usr/bin/env python3
"""Create a reproducible, sanitized TKBCherry production source package."""
from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOTS = ("mail-server", "rust_api", "solver_runtime", "web")
SUPPLEMENTAL_FILES = (
    ".env.example",
    "AGENTS.md",
    "README.md",
    "docs/CLOUD_COST_SYNC.md",
    "docs/MODEL_PLAN_CONTRACT.md",
    "docs/REGRESSION_CHECKLIST.md",
)
RETIRED_PREFIXES = (
    "web/downloads/TKBCherryAgent",
    "web/pages/tkb-browser-wasm",
    "web/pages/tkb-cpsat-wasm",
    "web/pages/tkb-highs-wasm",
    "web/pages/tkb_native_solver.wasm",
    "web/vendor/highs",
    "web/vendor/or-tools-wasm",
)
SKIP_PARTS = {
    ".git",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
    "target",
}
SKIP_SUFFIXES = {
    ".db",
    ".db-shm",
    ".db-wal",
    ".log",
    ".pyc",
    ".sqlite",
    ".sqlite3",
}


def should_skip(relative: str) -> bool:
    normalized = Path(relative).as_posix()
    parts = Path(normalized).parts
    if any(part in SKIP_PARTS or part.startswith("target-") for part in parts):
        return True
    if any(normalized.startswith(prefix) for prefix in RETIRED_PREFIXES):
        return True
    name = Path(normalized).name.lower()
    if name == ".env" or name.startswith(".env.") or name.endswith(".env"):
        return not name.endswith(".example")
    if any(name.endswith(suffix) for suffix in SKIP_SUFFIXES):
        return True
    if Path(normalized).suffix.lower() in {".exe", ".p12", ".pem", ".pfx", ".key"}:
        return True
    if normalized.startswith("data/") or "/logs/" in f"/{normalized}/":
        return True
    return False


def iter_files(source: Path):
    # Runtime source comes from the verified post-clean VPS snapshot. Deployment
    # tooling and documentation come from the current cleaned repository.
    for root_name in RUNTIME_ROOTS:
        root = source / root_name
        if not root.is_dir():
            raise FileNotFoundError(f"missing runtime root: {root}")
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(source).as_posix()
            if not should_skip(relative):
                yield relative, path

    tools_root = REPO_ROOT / "tools"
    for path in sorted(tools_root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(REPO_ROOT).as_posix()
        if not should_skip(relative):
            yield relative, path

    for relative in SUPPLEMENTAL_FILES:
        path = REPO_ROOT / relative
        if path.is_file() and not should_skip(relative):
            yield relative, path


def package_readme(label: str) -> bytes:
    return (
        "# TKBCherry production source package\n\n"
        f"Package label: `{label}`.\n\n"
        "This archive contains the active production source after VPS cleanup, "
        "plus the current deployment tools and operational documentation. It "
        "deliberately excludes school databases/workbooks, credentials, `.env` "
        "files, logs, dependency caches, compiled binaries, retired Agent EXE "
        "artifacts and retired browser solver WASM.\n\n"
        "To restore a new server, provide secrets through environment variables "
        "or protected `.env` files and use `tools/vps-deploy/install-server.sh`. "
        "Never copy credentials from an old snapshot into source control.\n"
    ).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--label", default=datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()

    source = args.source.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / f"TKBCherry-production-complete-{args.label}.zip"
    manifest_path = output_dir / f"TKBCherry-production-complete-{args.label}.manifest.json"
    checksum_path = output_dir / f"TKBCherry-production-complete-{args.label}.sha256"

    payload: dict[str, tuple[Path | None, bytes | None]] = {}
    for relative, path in iter_files(source):
        payload[relative] = (path, None)
    payload["PACKAGE_README.md"] = (None, package_readme(args.label))

    entries = []
    for relative, (path, content) in sorted(payload.items()):
        data = content if content is not None else path.read_bytes()  # type: ignore[union-attr]
        entries.append(
            {
                "path": relative,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )

    manifest = {
        "format": "tkbcherry-production-source-v1",
        "label": args.label,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "verified-post-clean-vps-snapshot",
        "fileCount": len(entries),
        "payloadBytes": sum(item["bytes"] for item in entries),
        "files": entries,
        "excluded": [
            "credentials and .env files",
            "school databases and workbooks",
            "logs, caches, dependencies and compiled binaries",
            "retired Agent EXE and browser solver WASM",
        ],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    fixed_timestamp = (2026, 8, 10, 0, 0, 0)
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, (path, content) in sorted(payload.items()):
            data = content if content is not None else path.read_bytes()  # type: ignore[union-attr]
            info = zipfile.ZipInfo(relative, fixed_timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        info = zipfile.ZipInfo("PACKAGE-MANIFEST.json", fixed_timestamp)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, manifest_bytes, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

    manifest_path.write_bytes(manifest_bytes)
    archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest().upper()
    checksum_path.write_text(f"{archive_hash} *{archive_path.name}\n", encoding="ascii")
    print(
        f"PACKAGE_OK path={archive_path} bytes={archive_path.stat().st_size} "
        f"files={len(entries) + 1} sha256={archive_hash}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
