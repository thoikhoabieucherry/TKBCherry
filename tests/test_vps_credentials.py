from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "vps-deploy" / "vps_credentials.py"
CONFIG_PATH = ROOT / "tools" / "vps-deploy" / "vps-config.json"
VPS_TOOLS = ROOT / "tools" / "vps-deploy"
CLOUD_RUN_TOOLS = ROOT / "tools" / "cloud-run"


def load_module():
    spec = importlib.util.spec_from_file_location("vps_credentials", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolve string annotations through sys.modules[cls.__module__].
    sys.modules[spec.name] = module
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
        # 27/08/2026: chuyen tu goc repo (deploy_web_quick.py) vao day.
        "deploy-web-quick.py",
        "backup-full.py",
        "test-rust.py",
        "check-auth.py",
        "diagnose.py",
        "fix-python.py",
    )
    for name in scripts:
        source = (VPS_TOOLS / name).read_text(encoding="utf-8")
        assert "resolve_vps_connection" in source, name


def _ssh_scripts() -> list[Path]:
    """Every tracked tool that opens an SSH session to the VPS."""
    candidates = sorted(VPS_TOOLS.glob("*.py")) + sorted(CLOUD_RUN_TOOLS.glob("*.py"))
    return [
        path
        for path in candidates
        if path.name != "vps_credentials.py"
        and re.search(r"\bparamiko\b|\brun_ssh\b", path.read_text(encoding="utf-8"))
    ]


def test_no_ssh_script_logs_in_with_a_raw_password() -> None:
    """21/11/2026: SSH moves to keys; only connect_vps may pass password= to paramiko."""
    scripts = _ssh_scripts()
    assert len(scripts) >= 15, [path.name for path in scripts]
    for path in scripts:
        source = path.read_text(encoding="utf-8")
        calls = re.findall(r"\.connect\((?:[^()]|\([^()]*\))*\)", source)
        ssh_calls = [call for call in calls if "username=" in call or "password=" in call]
        assert not ssh_calls, (path.name, ssh_calls)
        if "paramiko" in source:
            assert "connect_vps" in source, path.name


def test_ssh_readiness_checks_accept_a_key_without_password() -> None:
    """A missing password must not stop a script once the SSH key is installed."""
    for path in _ssh_scripts():
        source = path.read_text(encoding="utf-8")
        bare = re.search(r"if not (?:password|PASSWORD|args\.password):", source)
        if bare is None:
            continue  # no gate at all: connect_vps raises CredentialError itself
        # A password check may only follow the readiness check (e.g. the
        # interactive prompt in backup-full.py), never replace it.
        ready = source.find("vps_credentials_ready()")
        assert 0 <= ready < bare.start(), path.name


def test_default_ssh_key_lives_next_to_the_dpapi_store(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = load_module()
    local_app_data = tmp_path / "LocalAppData"
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    monkeypatch.delenv("TKB_VPS_KEY_FILE", raising=False)
    secrets_dir = local_app_data / "TKBCherry" / "secrets"
    assert module.ssh_key_path() == secrets_dir / "vps-ssh-ed25519"
    assert module.ssh_key_passphrase_path() == secrets_dir / "vps-ssh-key-passphrase.dpapi"
    assert ROOT not in module.ssh_key_path().parents
    override = tmp_path / "custom" / "id_ed25519"
    monkeypatch.setenv("TKB_VPS_KEY_FILE", str(override))
    assert module.ssh_key_path() == override


def test_auth_mode_defaults_to_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    monkeypatch.delenv("TKB_VPS_AUTH", raising=False)
    assert module.resolve_auth_mode() == "auto"
    monkeypatch.setenv("TKB_VPS_AUTH", "KEY")
    assert module.resolve_auth_mode() == "key"
    monkeypatch.setenv("TKB_VPS_AUTH", "telnet")
    assert module.resolve_auth_mode() == "auto"


def test_readiness_by_mode() -> None:
    module = load_module()
    key = Path("k")

    def auth(mode: str, key_path, password: str):
        return module.VpsAuth("h", "u", password, key_path, "", mode)

    assert auth("auto", key, "").ready
    assert auth("auto", None, "pw").ready
    assert not auth("auto", None, "").ready
    assert auth("key", key, "").ready
    assert not auth("key", None, "pw").ready
    assert auth("password", None, "pw").ready
    assert not auth("password", key, "").ready


class FakeClient:
    """Records connect() calls; rejects the key or the password on request."""

    def __init__(self, paramiko_module, reject_key: bool = False, reject_password: bool = False):
        self.paramiko = paramiko_module
        self.reject_key = reject_key
        self.reject_password = reject_password
        self.calls: list[dict] = []
        self.closed = 0

    def connect(self, host, **kwargs):
        self.calls.append({"host": host, **kwargs})
        if "pkey" in kwargs and self.reject_key:
            raise self.paramiko.AuthenticationException("key rejected")
        if "password" in kwargs and self.reject_password:
            raise self.paramiko.BadAuthenticationType("password disabled", ["publickey"])

    def close(self):
        self.closed += 1


@pytest.fixture()
def key_material(tmp_path: Path):
    pytest.importorskip("paramiko")
    pytest.importorskip("cryptography")
    module = load_module()
    key_path = tmp_path / "secrets" / "vps-ssh-ed25519"
    passphrase = "unit-test-passphrase-not-real"
    public_line = module.generate_ssh_key(key_path, passphrase, comment="unit-test")
    return module, key_path, passphrase, public_line


def test_generated_key_is_encrypted_ed25519_and_never_overwritten(key_material) -> None:
    import paramiko

    module, key_path, passphrase, public_line = key_material
    assert public_line.startswith("ssh-ed25519 ") and public_line.endswith(" unit-test")
    assert key_path.read_text(encoding="ascii").startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    assert module.read_public_key(key_path) == public_line
    with pytest.raises(paramiko.PasswordRequiredException):
        paramiko.Ed25519Key.from_private_key_file(str(key_path))
    loaded = module.load_private_key(key_path, passphrase)
    assert loaded.get_name() == "ssh-ed25519"
    assert loaded.get_base64() == public_line.split()[1]
    with pytest.raises(module.CredentialError):
        module.load_private_key(key_path, "")
    with pytest.raises(module.CredentialError):
        module.load_private_key(key_path, "wrong-passphrase")
    with pytest.raises(module.CredentialError):
        module.generate_ssh_key(key_path, passphrase)
    with pytest.raises(module.CredentialError):
        module.generate_ssh_key(key_path.with_name("other"), "")


def test_connect_uses_the_key_first_and_never_sends_the_password(key_material) -> None:
    import paramiko

    module, key_path, passphrase, _ = key_material
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", key_path, passphrase, "auto")
    client = FakeClient(paramiko)
    warnings: list[str] = []
    assert module.connect_vps(client, auth=auth, warn=warnings.append) is client
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["host"] == "vps.test" and call["username"] == "root"
    assert call["pkey"].get_name() == "ssh-ed25519"
    assert "password" not in call
    assert call["look_for_keys"] is False and call["allow_agent"] is False
    assert warnings == []


def test_connect_falls_back_to_password_in_auto_mode(key_material) -> None:
    import paramiko

    module, key_path, passphrase, _ = key_material
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", key_path, passphrase, "auto")
    client = FakeClient(paramiko, reject_key=True)
    warnings: list[str] = []
    module.connect_vps(client, auth=auth, warn=warnings.append)
    assert [("pkey" in c, c.get("password")) for c in client.calls] == [
        (True, None),
        (False, "pw-not-real"),
    ]
    assert client.closed == 1
    assert any("falling back" in w for w in warnings)
    assert any("PASSWORD" in w for w in warnings)


def test_key_mode_never_falls_back_to_password(key_material) -> None:
    import paramiko

    module, key_path, passphrase, _ = key_material
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", key_path, passphrase, "key")
    client = FakeClient(paramiko, reject_key=True)
    with pytest.raises(module.CredentialError):
        module.connect_vps(client, auth=auth, warn=lambda _m: None)
    assert all("password" not in c for c in client.calls)


def test_unreadable_key_falls_back_without_touching_the_server(key_material) -> None:
    import paramiko

    module, key_path, _passphrase, _ = key_material
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", key_path, "wrong", "auto")
    client = FakeClient(paramiko)
    warnings: list[str] = []
    module.connect_vps(client, auth=auth, warn=warnings.append)
    assert [c.get("password") for c in client.calls] == ["pw-not-real"]
    assert any("falling back" in w for w in warnings)


def test_password_mode_and_missing_credentials() -> None:
    paramiko = pytest.importorskip("paramiko")
    module = load_module()
    client = FakeClient(paramiko)
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", Path("ignored"), "", "password")
    module.connect_vps(client, auth=auth, warn=lambda _m: None)
    assert [c.get("password") for c in client.calls] == ["pw-not-real"]
    assert "pkey" not in client.calls[0]

    empty = module.VpsAuth("vps.test", "root", "", None, "", "auto")
    with pytest.raises(module.CredentialError):
        module.connect_vps(FakeClient(paramiko), auth=empty, warn=lambda _m: None)
    # An explicit password (deploy.py --password) still works without a store.
    explicit = FakeClient(paramiko)
    module.connect_vps(explicit, auth=empty, password="typed-not-real", warn=lambda _m: None)
    assert explicit.calls[0]["password"] == "typed-not-real"


def test_server_refusing_passwords_surfaces_as_auth_error(key_material) -> None:
    """After PasswordAuthentication no, a broken key must fail loudly, not hang."""
    import paramiko

    module, key_path, passphrase, _ = key_material
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", key_path, passphrase, "auto")
    client = FakeClient(paramiko, reject_key=True, reject_password=True)
    with pytest.raises(paramiko.AuthenticationException):
        module.connect_vps(client, auth=auth, warn=lambda _m: None)


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI only")
def test_dpapi_round_trip_uses_current_windows_user() -> None:
    module = load_module()
    original = b"unit-test-password-not-a-real-credential"
    encrypted = module.protect_bytes(original)
    assert encrypted != original
    assert module.unprotect_bytes(encrypted) == original


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI only")
def test_key_passphrase_store_is_separate_from_the_password_store(tmp_path: Path) -> None:
    module = load_module()
    store = tmp_path / "vps-ssh-key-passphrase.dpapi"
    module.save_ssh_key_passphrase("unit-test-passphrase-not-real", store)
    assert b"unit-test" not in store.read_bytes()
    assert module.load_saved_ssh_key_passphrase(store) == "unit-test-passphrase-not-real"
    # Different DPAPI entropy: the password loader cannot read the passphrase blob.
    with pytest.raises(module.CredentialError):
        module.load_saved_vps_password(store)
    assert module.load_saved_ssh_key_passphrase(tmp_path / "missing.dpapi") == ""
