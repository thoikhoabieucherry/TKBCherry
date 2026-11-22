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
    """Records connect() calls; rejects the key or the password on request.

    With ``server_key`` it shows that key to the missing-host-key policy before
    looking at credentials, in the same order as paramiko.SSHClient.connect.
    """

    def __init__(
        self, paramiko_module, reject_key: bool = False, reject_password: bool = False, server_key=None
    ):
        self.paramiko = paramiko_module
        self.reject_key = reject_key
        self.reject_password = reject_password
        self.server_key = server_key
        self.policy = None
        self.calls: list[dict] = []
        self.closed = 0

    def set_missing_host_key_policy(self, policy):
        self.policy = policy

    def connect(self, host, **kwargs):
        self.calls.append({"host": host, **kwargs})
        if self.server_key is not None and self.policy is not None:
            self.policy.missing_host_key(self, host, self.server_key)
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
    server_key = module.load_private_key(key_path, passphrase)  # any public key will do
    pin = f"ssh-ed25519 {module.host_key_fingerprint(server_key)}"
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", key_path, passphrase, "auto", (pin,))
    client = FakeClient(paramiko, server_key=server_key)
    warnings: list[str] = []
    assert module.connect_vps(client, auth=auth, warn=warnings.append) is client
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["host"] == "vps.test" and call["username"] == "root"
    assert call["pkey"].get_name() == "ssh-ed25519"
    assert "password" not in call
    assert call["look_for_keys"] is False and call["allow_agent"] is False
    assert isinstance(client.policy, module.PinnedHostKeyPolicy)
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


# --- SSH host key pinning (22/11/2026) ---------------------------------------

PIN_RE = re.compile(r"(?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+ SHA256:[A-Za-z0-9+/]{43}")


def test_vps_config_pins_the_vps_host_key() -> None:
    module = load_module()
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    pins = config["hostKeys"]
    assert pins and all(PIN_RE.fullmatch(pin) for pin in pins), pins
    # The code fallback (unreadable json) must pin the same server.
    assert module.DEFAULT_CONFIG["hostKeys"] == pins
    assert module.load_vps_config()["hostKeys"] == pins
    assert module.parse_host_key_pins(pins)


def test_host_key_pins_come_from_env_or_config_and_bad_pins_fail_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = load_module()
    fingerprint = "SHA256:" + "A" * 43
    monkeypatch.setenv("TKB_VPS_HOST_KEYS", f"ssh-ed25519 {fingerprint}, ssh-rsa {fingerprint}")
    assert module.resolve_host_key_pins() == (f"ssh-ed25519 {fingerprint}", f"ssh-rsa {fingerprint}")
    monkeypatch.delenv("TKB_VPS_HOST_KEYS")

    config = tmp_path / "vps-config.json"
    monkeypatch.setattr(module, "CONFIG_PATH", config)
    config.write_text(json.dumps({"host": "10.0.0.1"}), encoding="utf-8")
    assert module.resolve_host_key_pins() == tuple(module.DEFAULT_CONFIG["hostKeys"])
    config.write_text(json.dumps({"host": "10.0.0.1", "hostKeys": []}), encoding="utf-8")
    assert module.resolve_host_key_pins() == ()  # explicit opt-out

    for bad in ("SHA256:" + "A" * 43, "ssh-rsa MD5:aa:bb", "ssh-rsa SHA256:short", "ssh-rsa"):
        with pytest.raises(module.CredentialError):
            module.parse_host_key_pins([bad])
    # A typo in hostKeys stops the login before any connection, not silently unpinned.
    paramiko = pytest.importorskip("paramiko")
    client = FakeClient(paramiko)
    auth = module.VpsAuth("vps.test", "root", "pw-not-real", None, "", "auto", ("ssh-rsa SHA256:typo",))
    with pytest.raises(module.CredentialError):
        module.connect_vps(client, auth=auth, warn=lambda _m: None)
    assert client.calls == []


def test_host_key_fingerprint_matches_ssh_keygen(key_material) -> None:
    import base64
    import hashlib

    module, key_path, passphrase, public_line = key_material
    blob = base64.b64decode(public_line.split()[1])
    expected = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    key = module.load_private_key(key_path, passphrase)
    assert module.host_key_fingerprint(key) == expected
    assert PIN_RE.fullmatch(f"{key.get_name()} {expected}")


@pytest.fixture()
def ssh_server(key_material, tmp_path: Path):
    """Start in-process SSH servers on 127.0.0.1; each records what clients sent."""
    import socket
    import threading
    from types import SimpleNamespace

    import paramiko

    module, key_path, passphrase, _ = key_material
    servers = []

    class Recorder(paramiko.ServerInterface):
        def __init__(self, events):
            self.events = events

        def get_allowed_auths(self, username):
            return "publickey,password"

        def check_auth_publickey(self, username, key):
            self.events.append(("publickey", username))
            return paramiko.AUTH_SUCCESSFUL

        def check_auth_password(self, username, password):
            self.events.append(("password", username))
            return paramiko.AUTH_SUCCESSFUL

    def start(*host_keys):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)
        listener.settimeout(0.2)
        server = SimpleNamespace(
            port=listener.getsockname()[1], events=[], transports=[], stop=threading.Event(), listener=listener
        )

        def serve():
            while not server.stop.is_set():
                try:
                    conn, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                server.events.append(("connection",))
                transport = paramiko.Transport(conn)
                for host_key in host_keys:
                    transport.add_server_key(host_key)
                server.transports.append(transport)
                try:
                    transport.start_server(server=Recorder(server.events))
                except Exception:  # the client hung up after the key exchange
                    pass

        server.thread = threading.Thread(target=serve, daemon=True)
        server.thread.start()
        servers.append(server)
        return server

    def host_key(name: str):
        path = tmp_path / "host-keys" / name
        module.generate_ssh_key(path, "host-key-pass", comment=name)
        return module.load_private_key(path, "host-key-pass")

    def auth(pins, password="pw-not-real"):
        return module.VpsAuth("127.0.0.1", "root", password, key_path, passphrase, "auto", tuple(pins))

    def pin(key):
        return f"{key.get_name()} {module.host_key_fingerprint(key)}"

    yield SimpleNamespace(module=module, start=start, host_key=host_key, auth=auth, pin=pin)
    for server in servers:
        server.stop.set()
        server.listener.close()
        for transport in server.transports:
            transport.close()
        server.thread.join(timeout=5)


def _client(paramiko, policy, known_hosts: Path | None = None):
    client = paramiko.SSHClient()
    if known_hosts is not None:
        client.load_system_host_keys(str(known_hosts))
    client.set_missing_host_key_policy(policy)
    return client


def test_pinned_host_key_lets_the_key_login_through(ssh_server) -> None:
    import paramiko

    env = ssh_server
    real = env.host_key("real")
    server = env.start(real)
    client = _client(paramiko, paramiko.AutoAddPolicy())  # what most tools/vps-deploy scripts set
    warnings: list[str] = []
    try:
        env.module.connect_vps(client, auth=env.auth([env.pin(real)]), port=server.port, warn=warnings.append)
        assert client.get_transport().get_remote_server_key() == real
    finally:
        client.close()
    assert server.events == [("connection",), ("publickey", "root")]
    assert warnings == []


def test_foreign_host_key_is_refused_before_any_credential(ssh_server) -> None:
    import paramiko

    env = ssh_server
    real, impostor = env.host_key("real"), env.host_key("impostor")
    server = env.start(impostor)
    client = _client(paramiko, paramiko.AutoAddPolicy())
    with pytest.raises(env.module.HostKeyError) as caught:
        env.module.connect_vps(client, auth=env.auth([env.pin(real)]), port=server.port, warn=lambda _m: None)
    assert isinstance(caught.value, env.module.CredentialError)
    message = str(caught.value)
    assert env.module.host_key_fingerprint(impostor) in message and env.pin(real) in message
    # One handshake, then nothing: no SSH key, no password fallback, no second attempt.
    assert server.events == [("connection",)]
    assert client.get_transport() is None


def test_known_hosts_entries_never_override_the_pin(ssh_server, tmp_path: Path) -> None:
    """deploy.py / diagnose.py load known_hosts + RejectPolicy; the pin still decides."""
    import paramiko

    env = ssh_server
    real, impostor = env.host_key("real"), env.host_key("impostor")
    real_server, fake_server = env.start(real), env.start(impostor)

    def known_hosts(port: int, key) -> Path:
        path = tmp_path / f"known_hosts_{port}"
        path.write_text(f"[127.0.0.1]:{port} {key.get_name()} {key.get_base64()}\n", encoding="ascii")
        return path

    # A stale entry for the real server does not block the pinned login ...
    client = _client(paramiko, paramiko.RejectPolicy(), known_hosts(real_server.port, impostor))
    try:
        env.module.connect_vps(client, auth=env.auth([env.pin(real)]), port=real_server.port, warn=lambda _m: None)
    finally:
        client.close()
    assert ("publickey", "root") in real_server.events
    # ... and a planted entry for the impostor does not let it through.
    client = _client(paramiko, paramiko.RejectPolicy(), known_hosts(fake_server.port, impostor))
    with pytest.raises(env.module.HostKeyError):
        env.module.connect_vps(client, auth=env.auth([env.pin(real)]), port=fake_server.port, warn=lambda _m: None)
    assert fake_server.events == [("connection",)]


def test_only_pinned_host_key_types_are_negotiated(ssh_server) -> None:
    """The VPS has only an RSA host key; adding ed25519 later must not break the RSA pin."""
    import paramiko

    env = ssh_server
    rsa = paramiko.RSAKey.generate(2048)
    server = env.start(env.host_key("new-ed25519"), rsa)
    client = _client(paramiko, paramiko.AutoAddPolicy())
    try:
        env.module.connect_vps(client, auth=env.auth([env.pin(rsa)]), port=server.port, warn=lambda _m: None)
        assert client.get_transport().get_remote_server_key().get_name() == "ssh-rsa"
    finally:
        client.close()
    assert ("publickey", "root") in server.events


def test_server_without_the_pinned_key_type_is_refused_clearly(ssh_server) -> None:
    import paramiko

    env = ssh_server
    server = env.start(env.host_key("ed25519-only"))
    client = _client(paramiko, paramiko.AutoAddPolicy())
    pinned_rsa = "ssh-rsa SHA256:" + "A" * 43
    with pytest.raises(env.module.HostKeyError, match="none of the pinned SSH host key types"):
        env.module.connect_vps(client, auth=env.auth([pinned_rsa]), port=server.port, warn=lambda _m: None)
    assert server.events == [("connection",)]


def test_empty_host_keys_keep_the_old_behaviour_with_a_warning(ssh_server) -> None:
    import paramiko

    env = ssh_server
    server = env.start(env.host_key("unpinned"))
    client = _client(paramiko, paramiko.AutoAddPolicy())
    warnings: list[str] = []
    try:
        env.module.connect_vps(client, auth=env.auth([]), port=server.port, warn=warnings.append)
    finally:
        client.close()
    assert server.events == [("connection",), ("publickey", "root")]
    assert any("NOT verified" in warning for warning in warnings), warnings


def test_raw_ssh_transports_in_vps_tools_check_the_pin() -> None:
    for path in _ssh_scripts():
        source = path.read_text(encoding="utf-8")
        if "paramiko.Transport(" in source:
            assert "check_host_key" in source and "host_key_algorithm_filter" in source, path.name


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
