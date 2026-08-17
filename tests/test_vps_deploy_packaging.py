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
STAGE_TESTS_PATH = ROOT / "tools" / "vps-deploy" / "stage-tests.py"
INSTALL_SERVER_PATH = ROOT / "tools" / "vps-deploy" / "install-server.sh"
SOLVER_POOL_CONFIG_PATH = ROOT / "tools" / "vps-deploy" / "solver-pool.conf"
FIX_PYTHON_PATH = ROOT / "tools" / "vps-deploy" / "fix-python.py"
BACKUP_FULL_PATH = ROOT / "tools" / "vps-deploy" / "backup-full.py"


def load_deploy_module():
    spec = importlib.util.spec_from_file_location("vps_deploy", DEPLOY_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_reference_helper_process_limit_is_consistent_across_install_paths() -> None:
    required = [
        "Environment=TKB_EXTERNAL_CP_SAT_BUILDERS=2",
        "Environment=TKB_REFERENCE_HELPER_PROCESSES=3",
    ]
    for path in (SOLVER_POOL_CONFIG_PATH, INSTALL_SERVER_PATH, FIX_PYTHON_PATH):
        text = path.read_text(encoding="utf-8")
        assert all(line in text for line in required), path


def test_sensitive_and_build_paths_are_excluded() -> None:
    deploy = load_deploy_module()
    excluded = [
        "mail-server/.env",
        "tools/trusted-worker/.env",
        "tools/trusted-worker/.env.production",
        "tools/trusted-worker/trusted-worker.env",
        "tools/trusted-worker/trusted-worker.env.backup",
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
        "web/downloads/TKBCherryAgent-Windows.zip",
        "web/downloads/TKBCherryAgent-release.json",
        "web/pages/tkb-browser-wasm.js",
        "web/pages/tkb-browser-wasm-worker.js",
        "web/pages/tkb_native_solver.wasm",
        "web/vendor/highs/LICENSE",
        "web/vendor/or-tools-wasm/LICENSE",
        "web/vendor/or-tools-wasm/NOTICE.md",
    ]
    assert all(deploy.should_skip(path) for path in excluded)
    assert not deploy.should_skip("rust_api/src/main.rs")
    assert not deploy.should_skip("web/index.html")
    assert not deploy.should_skip("solver_runtime/src/tkb_new/adapter.py")
    assert not deploy.should_skip("tools/vps-deploy/solver-pool.conf")
    assert not deploy.should_skip("tools/cloud-run/tkb-google-cloud-usage.timer")
    assert not deploy.should_skip("tools/cloud-run/tkb-google-cloud-usage.path")


def test_staging_fixture_source_is_explicit_and_fails_closed() -> None:
    script = STAGE_TESTS_PATH.read_text(encoding="utf-8")
    assert 'os.environ.get("TKB_TEST_DATA_DIR"' in script
    assert 'return Path(configured).expanduser().resolve()' in script
    assert 'Staging fixture workbooks are missing' in script
    assert 'return 2' in script


def test_staging_profile_keeps_only_the_release_test_sources() -> None:
    deploy = load_deploy_module()

    included = [
        "rust_api/fixtures/sample-data-with-class-off.json",
        "solver_runtime/contracts/tkb-model-plan-v1.schema.json",
        "solver_runtime/fixtures/model_plan_v1/golden-index.json",
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
        ".github/workflows/build-agent-windows.yml",
        "agent_helper/api.py",
        "tools/agent-release/sign_release.py",
        "tools/trusted-worker/install-linux.sh",
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
        assert "web/downloads/TKBCherryAgent-Windows.zip" not in names
        assert "web/downloads/TKBCherryAgent-release.json" not in names
        assert "web/pages/tkb-browser-wasm.js" not in names
        assert "web/pages/tkb-browser-wasm-worker.js" not in names
        assert "web/pages/tkb_native_solver.wasm" not in names
        assert "web/vendor/highs/LICENSE" not in names
        assert "web/vendor/or-tools-wasm/LICENSE" not in names
        assert "solver_runtime/scripts/solve_stdio.py" in names
        assert "solver_runtime/src/tkb_optimizer_ref/base_184_hint.json" in names
        assert "mail-server/server.js" in names
        assert "tools/vps-deploy/solver-pool.conf" in names
        assert "tools/cloud-run/install-google-cloud-usage-sync.sh" in names
        assert "tools/cloud-run/tkb-google-cloud-usage.service" in names
        assert "tools/cloud-run/tkb-google-cloud-usage.timer" in names
        assert "tools/cloud-run/tkb-google-cloud-usage.path" in names
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
        assert "solver_runtime/contracts/tkb-model-plan-v1.schema.json" in names
        assert "solver_runtime/fixtures/model_plan_v1/golden-index.json" in names
        assert "solver_runtime/fixtures/model_plan_v1/small-cp-sat.bundle.json" in names
        assert "solver_runtime/tests/test_solver_result_contract.py" in names
        assert "rust_api/fixtures/sample-data-with-class-off.json" in names
        assert "agent_helper/api.py" not in names
        assert ".github/workflows/build-agent-windows.yml" not in names
        assert "tools/agent-release/sign_release.py" not in names
        assert "tools/trusted-worker/install-linux.sh" not in names
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

    candidate_prepared = script.index("prepare_candidate_runtime\n")
    gate_enabled = script.index("enable_solver_admission_gate\n", candidate_prepared)
    solver_drained = script.index("wait_for_solver_idle\n", gate_enabled)
    python_prepared = script.index(
        "install_candidate_python_requirements\n", solver_drained
    )
    release_backup_finished = script.index("backup_release\n", python_prepared)
    update_started = script.index("UPDATE_STARTED=1", release_backup_finished)
    services_stopped = script.index("systemctl stop tkb-app tkb-mail", update_started)
    state_backup_finished = script.index("backup_server_state", services_stopped)
    source_replaced = script.index("rsync -a --delete", services_stopped)
    services_restarted = script.index("systemctl restart tkb-mail tkb-app", source_replaced)
    health_checked = script.index("wait_for_health", services_restarted)
    update_ok = script.index('echo "UPDATE_OK"', health_checked)
    staging_cleaned = script.index("cleanup_deploy_artifacts", update_ok)

    assert candidate_prepared < gate_enabled < solver_drained < python_prepared
    assert python_prepared < release_backup_finished < update_started < services_stopped
    assert services_stopped < state_backup_finished < source_replaced
    assert source_replaced < services_restarted < health_checked < update_ok < staging_cleaned

    cutover = script[services_stopped:services_restarted]
    assert "cargo build" not in cutover
    assert "npm install" not in cutover
    assert "pip install" not in cutover
    assert script.index("install_candidate_runtime\n", source_replaced) < services_restarted

    restore_started = script.index("restore_release()")
    mail_runtime_restored = script.index("restore_mail_runtime\n", restore_started)
    rollback_restart = script.index(
        "systemctl restart tkb-mail tkb-app", mail_runtime_restored
    )
    assert restore_started < mail_runtime_restored < rollback_restart
    assert script.count("cleanup_mail_runtime_rollback_stage\n") >= 2


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
    assert '"$UPLOAD_DIR/solver_runtime/requirements.txt"' in update_script
    assert "cargo build --release --locked" in update_script
    assert 'CARGO_TARGET_DIR="$UPLOAD_DIR/rust_api/target"' in update_script
    assert 'CANDIDATE_RUST_BINARY="$UPLOAD_DIR/rust_api/target/release/tkb_rust_api"' in update_script
    assert '"$CANDIDATE_RUST_BINARY"' in update_script
    assert 'CANDIDATE_MAIL_NODE_MODULES="$UPLOAD_DIR/mail-server/node_modules"' in update_script
    assert 'source "$HOME/.cargo/env"' in update_script
    assert 'Missing mail-server/package.json in deployment candidate' in update_script
    assert 'Missing rust_api/Cargo.toml in deployment candidate' in update_script
    assert 'MAIL_RUNTIME_ROLLBACK_STAGE="$(mktemp -d' in update_script
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


def test_full_backup_has_verified_windows_copy_fallback() -> None:
    script = BACKUP_FULL_PATH.read_text(encoding="utf-8")
    assert "except PermissionError:" in script
    assert "shutil.copytree(staging, destination, copy_function=shutil.copy2)" in script
    assert "copied_count != file_count or copied_bytes != byte_count" in script
    assert 'raise RuntimeError("Copied snapshot does not match extracted staging data")' in script


def test_release_backup_has_no_retired_agent_rollback_stage() -> None:
    script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")

    assert "capture_agent_rollback_files" not in script
    assert "restore_agent_rollback_files" not in script
    assert "cleanup_agent_rollback_stage" not in script
    assert "TKBCherryAgent" not in script


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


def test_install_and_update_have_no_retired_agent_download_route() -> None:
    update_script = UPDATE_SERVER_PATH.read_text(encoding="utf-8")
    install_script = INSTALL_SERVER_PATH.read_text(encoding="utf-8")
    for script in (update_script, install_script):
        assert "TKBCherryAgent" not in script
        assert "TKB_AGENT_DOWNLOAD_BEGIN" not in script
        assert "location /downloads/" not in script
        assert "application/vnd.microsoft.portable-executable" not in script
