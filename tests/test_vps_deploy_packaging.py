from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY_PATH = ROOT / "tools" / "vps-deploy" / "deploy.py"
UPDATE_SERVER_PATH = ROOT / "tools" / "vps-deploy" / "update-server.sh"
UPDATE_DEPLOY_PATH = ROOT / "tools" / "vps-deploy" / "update-deploy.py"
INSTALL_SERVER_PATH = ROOT / "tools" / "vps-deploy" / "install-server.sh"


def load_deploy_module():
    spec = importlib.util.spec_from_file_location("vps_deploy", DEPLOY_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sensitive_and_build_paths_are_excluded() -> None:
    deploy = load_deploy_module()
    excluded = [
        "mail-server/.env",
        "rust_api/tkb_store.db",
        "rust_api/target/release/tkb_rust_api",
        "rust_api/target-gnu/release/tkb_rust_api.exe",
        "solver_runtime/logs/request.json",
        "solver_runtime/logs (1)/request.json",
        "recovered_from_vps/host-live/web/index.html",
        "archived_logs/old-response.json",
        "latest_logs/response.json",
        "tools/vps-deploy/diagnose.py",
        "tools/vps-deploy/super-admin.conf",
        "tools/vps-deploy/fix-python (1).py",
        "web (1)/index.html",
        "data/giaovien.xlsx",
        "rust_server_e2e.log",
        "start.exe",
        "TKB DEMO AI.rar",
        ".github/workflows/test.yml",
        "agent_helper/api.py",
        "docs/PROJECT_HANDOFF.md",
        "e2e_tests/test_suite.py",
        "mail-server/server.test.js",
        "rust_api/fixtures/sample-data-with-class-off.json",
        "rust_api/prebuilt/README.md",
        "rust_api/solver_pool_test_harness.rs",
        "rust_api/vendor/sqlite3/sqlite3.dll",
        "solver_runtime/tests/test_solver_result_contract.py",
        "tests/test_vps_deploy_packaging.py",
        "upx-5.2.0-win64/upx.exe",
    ]
    assert all(deploy.should_skip(path) for path in excluded)
    assert not deploy.should_skip("rust_api/src/main.rs")
    assert not deploy.should_skip("web/index.html")
    assert not deploy.should_skip("web/downloads/TKBCherryAgent-release.json")
    assert not deploy.should_skip("solver_runtime/src/tkb_new/adapter.py")
    assert not deploy.should_skip("tools/vps-deploy/solver-pool.conf")


def test_staging_profile_keeps_only_the_release_test_sources() -> None:
    deploy = load_deploy_module()

    included = [
        "agent_helper/api.py",
        "agent_helper/tests/test_api.py",
        "rust_api/fixtures/sample-data-with-class-off.json",
        "solver_runtime/tests/test_solver_result_contract.py",
    ]
    excluded = [
        ".github/workflows/test.yml",
        "agent_helper/.build-windows/TKBCherryAgent.exe",
        "agent_helper/dist/TKBCherryAgent.exe",
        "docs/PROJECT_HANDOFF.md",
        "e2e_tests/test_suite.py",
        "tests/test_vps_deploy_packaging.py",
        "upx-5.2.0-win64/upx.exe",
    ]

    assert all(
        not deploy.should_skip(path, deploy.PACKAGE_STAGING) for path in included
    )
    assert all(deploy.should_skip(path, deploy.PACKAGE_STAGING) for path in excluded)


def test_tarball_contains_no_sensitive_or_build_files() -> None:
    deploy = load_deploy_module()
    tarball = deploy.make_tarball()
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = archive.getnames()
        assert "rust_api/src/main.rs" in names
        assert "web/index.html" in names
        assert "web/downloads/TKBCherryAgent-Windows.zip" in names
        assert "web/downloads/TKBCherryAgent-release.json" in names
        assert "solver_runtime/scripts/solve_stdio.py" in names
        assert "solver_runtime/src/tkb_optimizer_ref/base_184_hint.json" in names
        assert "mail-server/server.js" in names
        assert "tools/vps-deploy/solver-pool.conf" in names
        assert {name.split("/", 1)[0] for name in names} == {
            "mail-server",
            "rust_api",
            "solver_runtime",
            "tools",
            "web",
        }
        assert not any(deploy.should_skip(name.rstrip("/")) for name in names)
    finally:
        tarball.unlink(missing_ok=True)


def test_staging_tarball_contains_release_suites_without_local_junk() -> None:
    deploy = load_deploy_module()
    tarball = deploy.make_tarball(deploy.PACKAGE_STAGING)
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = set(archive.getnames())
        assert "agent_helper/api.py" in names
        assert "agent_helper/tests/test_api.py" in names
        assert "solver_runtime/tests/test_solver_result_contract.py" in names
        assert "rust_api/fixtures/sample-data-with-class-off.json" in names
        assert "agent_helper/dist/TKBCherryAgent.exe" not in names
        assert "e2e_tests/test_suite.py" not in names
        assert "tests/test_vps_deploy_packaging.py" not in names
        assert "upx-5.2.0-win64/upx.exe" not in names
    finally:
        tarball.unlink(missing_ok=True)


def test_update_script_hardens_backups_and_avoids_mixed_release() -> None:
    script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")

    assert "umask 077" in script
    assert 'install -d -m 0700 "$BACKUP_DIR"' in script
    assert "-name '*.tar.gz' -exec chmod 0600" in script
    assert 'chmod 0600 "$STATE_BACKUP"' in script
    assert 'chmod 0600 "$RELEASE_BACKUP"' in script

    release_backup_finished = script.index("backup_release\nUPDATE_STARTED=1")
    services_stopped = script.index("systemctl stop tkb-app tkb-mail")
    state_backup_finished = script.index("backup_server_state", services_stopped)
    source_replaced = script.index("rsync -a --delete", services_stopped)
    services_restarted = script.index("systemctl restart tkb-mail tkb-app", source_replaced)
    health_checked = script.index("wait_for_health", services_restarted)
    update_ok = script.index('echo "UPDATE_OK"', health_checked)
    staging_cleaned = script.index("cleanup_deploy_artifacts", update_ok)

    assert release_backup_finished < services_stopped < state_backup_finished < source_replaced
    assert source_replaced < services_restarted < health_checked < update_ok < staging_cleaned


def test_update_script_serializes_deploys_and_drains_solver_jobs() -> None:
    script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")

    assert 'exec 9>"$DEPLOY_LOCK_FILE"' in script
    assert "flock -n 9" in script
    assert "wait_for_solver_idle" in script
    assert '"solverActiveJobs"' in script
    assert '"solverQueuedJobs"' in script
    assert "DRAIN_STABLE_CHECKS" in script
    assert "DRAIN_RESULT_GRACE_SECONDS" in script
    assert "trap 'rollback_on_signal HUP 129' HUP" in script
    assert "trap 'rollback_on_signal INT 130' INT" in script
    assert "trap 'rollback_on_signal TERM 143' TERM" in script
    assert "trap rollback_on_exit EXIT" in script
    assert "trap - EXIT ERR HUP INT TERM" in script

    gate_enabled = script.index("enable_solver_admission_gate\n")
    solver_drained = script.index("wait_for_solver_idle\n", gate_enabled)
    services_stopped = script.index("systemctl stop tkb-app tkb-mail", solver_drained)
    assert gate_enabled < solver_drained < services_stopped


def test_update_reinstalls_python_requirements_and_uses_unique_remote_paths() -> None:
    update_script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")
    update_deploy = UPDATE_DEPLOY_PATH.read_text(encoding="utf-8")
    full_deploy = DEPLOY_PATH.read_text(encoding="utf-8")
    full_install = INSTALL_SERVER_PATH.read_text(encoding="utf-8")

    assert "python3 -m pip install --break-system-packages" in update_script
    assert '"$APP_DIR/solver_runtime/requirements.txt"' in update_script
    assert "cargo build --release --locked" in update_script
    assert "cargo build --release --locked" in full_install
    assert "libsqlite3-dev" in full_install
    assert 'secrets.token_hex(6)' in update_deploy
    assert 'remote_upload = f"/tmp/cherry-upload-{deploy_id}"' in update_deploy
    assert "TKB_DEPLOY_UPLOAD_DIR" in update_deploy
    assert 'secrets.token_hex(6)' in full_deploy
    assert 'remote_upload = f"/tmp/cherry-upload-{deploy_id}"' in full_deploy
    assert "export TKB_DEPLOY_UPLOAD_DIR" in full_deploy
    assert 'UPLOAD_DIR="${TKB_DEPLOY_UPLOAD_DIR:-/tmp/cherry-upload}"' in full_install
    assert '"$UPLOAD_DIR/" "$APP_DIR/"' in full_install
    assert "/tmp/cherry-upload/ \"$APP_DIR/\"" not in full_install
    assert "flock -n 9" in full_deploy
    assert "systemctl is-active --quiet tkb-app" in full_deploy
    assert "use update-deploy.py so solver jobs can drain" in full_deploy


def test_production_and_staging_entrypoints_select_explicit_profiles() -> None:
    deploy = DEPLOY_PATH.read_text(encoding="utf-8")
    update = UPDATE_DEPLOY_PATH.read_text(encoding="utf-8")
    stage = (ROOT / "tools" / "vps-deploy" / "stage-tests.py").read_text(
        encoding="utf-8"
    )

    assert "make_tarball(PACKAGE_PRODUCTION)" in deploy
    assert "make_tarball(PACKAGE_PRODUCTION)" in update
    assert "make_tarball(PACKAGE_STAGING)" in stage


def test_release_backup_avoids_agent_archive_duplication_and_keeps_rollback_pair() -> None:
    script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")

    assert "capture_agent_rollback_files\n" in script
    assert "restore_agent_rollback_files\n" in script
    assert "cleanup_agent_rollback_stage\n" in script
    assert "--exclude='web/downloads/TKBCherryAgent-Windows.zip'" in script
    assert "--exclude='web/downloads/TKBCherryAgent-release.json'" in script
    assert 'source="$AGENT_ROLLBACK_STAGE/$filename"' in script
    assert 'cp -a "$source" "$downloads/$filename"' in script
    assert script.index("restore_agent_rollback_files\n") < script.index(
        "systemctl restart tkb-mail tkb-app", script.index("restore_release()")
    )


def test_runtime_cleanup_preserves_only_the_linux_release_binary() -> None:
    for path in (UPDATE_SERVER_PATH, INSTALL_SERVER_PATH):
        script = path.read_text(encoding="utf-8")
        assert 'rm -rf -- "$APP_DIR/rust_api/target-gnu"' in script
        assert '"$APP_DIR/solver_runtime/logs"' in script
        assert '! -name release -exec rm -rf -- {} +' in script
        assert '! -name tkb_rust_api -exec rm -rf -- {} +' in script
        assert 'runtime_binary="$release_dir/tkb_rust_api"' in script
        assert "prune_runtime_artifacts\n" in script


def test_backup_retention_keeps_limits_manual_archives_and_current_backups() -> None:
    script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")
    heredoc = 'python3 - "$BACKUP_DIR" "$RELEASE_BACKUP" "$STATE_BACKUP" <<\'PY_PRUNE_BACKUPS\'\n'
    prune_start = script.index(heredoc) + len(heredoc)
    prune_end = script.index("\nPY_PRUNE_BACKUPS\n", prune_start)
    pruner = script[prune_start:prune_end]

    with tempfile.TemporaryDirectory() as temp_dir:
        directory = Path(temp_dir)
        releases = []
        states = []
        for index in range(15):
            path = directory / f"app-release-{index:02}.tar.gz"
            path.write_bytes(b"release")
            os.utime(path, (index + 1, index + 1))
            releases.append(path)
        for index in range(40):
            path = directory / f"server-state-{index:02}.tar.gz"
            path.write_bytes(b"state")
            os.utime(path, (index + 1, index + 1))
            states.append(path)
        manual_release = directory / "app-release-manual-archive.tar.gz"
        manual_state = directory / "server-state-manual-archive.tar.gz"
        manual_release.write_bytes(b"manual")
        manual_state.write_bytes(b"manual")

        subprocess.run(
            [
                sys.executable,
                "-c",
                pruner,
                str(directory),
                str(releases[0]),
                str(states[0]),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        remaining_releases = list(directory.glob("app-release-[0-9][0-9].tar.gz"))
        remaining_states = list(directory.glob("server-state-[0-9][0-9].tar.gz"))
        assert len(remaining_releases) == 11
        assert len(remaining_states) == 31
        assert releases[0].exists()
        assert states[0].exists()
        assert manual_release.exists()
        assert manual_state.exists()


def test_nginx_serves_only_the_named_agent_release_files_directly() -> None:
    update_script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")
    install_script = INSTALL_SERVER_PATH.read_text(encoding="utf-8")
    for script in (update_script, install_script):
        assert "location = /downloads/TKBCherryAgent-Windows.zip" in script
        assert "application/zip" in script
        assert 'filename="TKBCherryAgent-Windows.zip"' in script
        assert "location = /downloads/TKBCherryAgent-release.json" in script
        assert "application/json" in script
        assert "Cache-Control 'no-store'" in script
        assert "TKB_AGENT_DOWNLOAD_BEGIN" in script
        assert "location /downloads/" not in script
        assert (
            'chmod 0644 "$APP_DIR/web/downloads/TKBCherryAgent-Windows.zip"'
            in script
        )
        assert 'chmod 0644 "$APP_DIR/web/downloads/TKBCherryAgent-release.json"' in script
        assert "location = /downloads/TKBCherryAgent.exe" not in script
        assert "application/vnd.microsoft.portable-executable" not in script
    assert 'if begin in source:\n    raise SystemExit(0)' not in update_script
    assert 'source = source[:block_start] + source[block_end:]' in update_script
    assert update_script.index("ensure_agent_download_location\n") < update_script.index(
        "enable_solver_admission_gate\n"
    )


def test_update_replaces_the_existing_marked_agent_executable_route() -> None:
    script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")
    heredoc = 'python3 - "$site" "$APP_DIR" <<\'PY\'\n'
    rewrite_start = script.index(heredoc) + len(heredoc)
    rewrite_end = script.index("\nPY\n", rewrite_start)
    rewriter = script[rewrite_start:rewrite_end]
    old_config = '''server {
    # TKB_AGENT_DOWNLOAD_BEGIN
    location = /downloads/TKBCherryAgent.exe {
        alias /opt/cherry-scheduler/web/downloads/TKBCherryAgent.exe;
        default_type application/vnd.microsoft.portable-executable;
        add_header Content-Disposition 'attachment; filename="TKBCherryAgent.exe"' always;
    }
    # TKB_AGENT_DOWNLOAD_END

    location / {
        proxy_pass http://127.0.0.1:1010;
    }
}
'''

    with tempfile.TemporaryDirectory() as temp_dir:
        site = Path(temp_dir) / "tkbcherry"
        site.write_text(old_config, encoding="utf-8")
        subprocess.run(
            [sys.executable, "-c", rewriter, str(site), "/opt/cherry-scheduler"],
            check=True,
            capture_output=True,
            text=True,
        )
        rewritten = site.read_text(encoding="utf-8")

    assert rewritten.count("# TKB_AGENT_DOWNLOAD_BEGIN") == 1
    assert rewritten.count("# TKB_AGENT_DOWNLOAD_END") == 1
    assert "location = /downloads/TKBCherryAgent.exe" not in rewritten
    assert rewritten.count("location = /downloads/TKBCherryAgent-Windows.zip") == 1
    assert rewritten.count("location = /downloads/TKBCherryAgent-release.json") == 1
    assert (
        "alias /opt/cherry-scheduler/web/downloads/TKBCherryAgent-Windows.zip;"
        in rewritten.replace("\\", "/")
    )
    assert "default_type application/zip;" in rewritten
    assert 'filename="TKBCherryAgent-Windows.zip"' in rewritten
    assert "default_type application/json;" in rewritten
    assert "Cache-Control 'no-store'" in rewritten
