from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "vps-deploy" / "vps_credentials.py"
CONFIG_PATH = ROOT / "tools" / "vps-deploy" / "vps-config.json"
VPS_TOOLS = ROOT / "tools" / "vps-deploy"


def load_module():
    spec = importlib.util.spec_from_file_location("vps_credentials", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_vps_config_contains_only_non_secret_metadata() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    assert config["hostname"] == "TDC-260709270"
    assert config["host"] == "165.101.47.133"
    assert config["user"] == "root"
    assert not any("password" in key.lower() for key in config)


def test_environment_password_takes_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    monkeypatch.setenv("TKB_VPS_PASSWORD", "unit-test-only")
    monkeypatch.setattr(
        module,
        "load_saved_vps_password",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("store should not be read")),
    )
    assert module.resolve_vps_password() == "unit-test-only"


def test_default_credential_path_is_outside_the_repository(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    module = load_module()
    local_app_data = tmp_path / "LocalAppData"
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    path = module.credential_path()
    assert path == local_app_data / "TKBCherry" / "secrets" / "vps-password.dpapi"
    assert ROOT not in path.parents


def test_all_vps_entrypoints_use_the_shared_credential_resolver() -> None:
    scripts = (
        "stage-tests.py",
        "update-deploy.py",
        "deploy.py",
        "backup-full.py",
        "test-rust.py",
        "check-auth.py",
        "diagnose.py",
        "fix-python.py",
    )
    for name in scripts:
        source = (VPS_TOOLS / name).read_text(encoding="utf-8")
        assert "resolve_vps_connection" in source, name


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI only")
def test_dpapi_round_trip_uses_current_windows_user() -> None:
    module = load_module()
    original = b"unit-test-password-not-a-real-credential"
    encrypted = module.protect_bytes(original)
    assert encrypted != original
    assert module.unprotect_bytes(encrypted) == original
