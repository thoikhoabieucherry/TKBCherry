"""Remote shell built by tools/vps-deploy/ssh-key-auth.py, run against stub sshd/systemctl."""
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "vps-deploy" / "ssh-key-auth.py"
GOOD_EFFECTIVE = (
    "passwordauthentication no\n"
    "kbdinteractiveauthentication no\n"
    "permitrootlogin without-password\n"
    "pubkeyauthentication yes\n"
)
STILL_PASSWORD = GOOD_EFFECTIVE.replace("passwordauthentication no", "passwordauthentication yes")


def load_module():
    spec = importlib.util.spec_from_file_location("ssh_key_auth", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def find_bash() -> str | None:
    for candidate in (
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        shutil.which("bash"),
    ):
        if candidate and Path(candidate).is_file():
            try:
                ok = subprocess.run([candidate, "-c", "echo ok"], capture_output=True, text=True, timeout=20)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if ok.stdout.strip() == "ok":
                return candidate
    return None


BASH = find_bash()
pytestmark = pytest.mark.skipif(BASH is None, reason="bash not available")


def run_remote(tmp_path: Path, command: str, *, effective: str, sshd_t: int = 0, reload: int = 0):
    (tmp_path / "effective.txt").write_text(effective, encoding="utf-8", newline="\n")
    stubs = (
        f'sshd() {{ if [ "$1" = "-t" ]; then return {sshd_t}; fi; cat effective.txt; }}\n'
        f"systemctl() {{ echo \"systemctl $*\" >> calls.log; return {reload}; }}\n"
    )
    proc = subprocess.run(
        [BASH, "-c", stubs + command],
        cwd=str(tmp_path),
        capture_output=True,
        text=True,
        timeout=60,
    )
    calls = (tmp_path / "calls.log").read_text() if (tmp_path / "calls.log").exists() else ""
    return proc.returncode, proc.stdout + proc.stderr, calls


@pytest.fixture()
def module(monkeypatch: pytest.MonkeyPatch):
    mod = load_module()
    monkeypatch.setattr(mod, "KEYS_ONLY_CONF", "00-tkb-keys-only.conf")
    return mod


def test_conf_sorts_before_cloud_init_and_sets_keys_only(module) -> None:
    assert Path(load_module().KEYS_ONLY_CONF).name < "50-cloud-init.conf"
    text = module.KEYS_ONLY_TEXT
    for line in (
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PermitRootLogin prohibit-password",
    ):
        assert line in text.splitlines()


def test_disable_success_writes_file_and_reloads(module, tmp_path: Path) -> None:
    code, out, calls = run_remote(tmp_path, module.disable_password_command(), effective=GOOD_EFFECTIVE)
    assert code == 0, out
    assert "RELOAD_OK" in out
    assert (tmp_path / "00-tkb-keys-only.conf").read_text() == module.KEYS_ONLY_TEXT
    assert calls.strip() == "systemctl try-reload-or-restart ssh.service"


@pytest.mark.parametrize(
    "kwargs, marker, exit_code",
    [
        ({"effective": GOOD_EFFECTIVE, "sshd_t": 1}, "SSHD_T_FAILED", 3),
        ({"effective": STILL_PASSWORD}, "EFFECTIVE_CONFIG_MISMATCH", 4),
        ({"effective": ""}, "EFFECTIVE_CONFIG_MISMATCH", 4),
        ({"effective": GOOD_EFFECTIVE, "reload": 1}, "RELOAD_FAILED", 5),
    ],
)
def test_every_disable_failure_removes_the_file(module, tmp_path: Path, kwargs, marker, exit_code) -> None:
    code, out, calls = run_remote(tmp_path, module.disable_password_command(), **kwargs)
    assert code == exit_code, out
    assert marker in out
    assert "RELOAD_OK" not in out
    assert not (tmp_path / "00-tkb-keys-only.conf").exists()
    if marker != "RELOAD_FAILED":
        assert calls == ""  # sshd never reloaded with an unchecked config


def test_enable_password_removes_the_file_and_reloads(module, tmp_path: Path) -> None:
    (tmp_path / "00-tkb-keys-only.conf").write_text(module.KEYS_ONLY_TEXT)
    code, out, calls = run_remote(tmp_path, module.enable_password_command(), effective=STILL_PASSWORD)
    assert code == 0, out
    assert "ROLLBACK_OK" in out
    assert not (tmp_path / "00-tkb-keys-only.conf").exists()
    assert "try-reload-or-restart ssh.service" in calls


def test_install_key_is_idempotent_and_keeps_lines_separate(module, tmp_path: Path) -> None:
    public_line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUnitTestOnlyNotARealKeyxxxxxxxxxxxxxxxxxx unit-test"
    command = module.install_key_command(public_line).replace("/root/.ssh", "dotssh")
    command = command.replace("install -d -m 700 -o root -g root dotssh", "mkdir -p dotssh")
    command = command.replace("ssh-keygen -lf dotssh/authorized_keys", "cat dotssh/authorized_keys")
    (tmp_path / "dotssh").mkdir()
    (tmp_path / "dotssh" / "authorized_keys").write_text("ssh-ed25519 AAAAexisting other", newline="\n")
    code, out, _ = run_remote(tmp_path, command, effective="")
    assert code == 0, out
    assert "KEY_ADDED" in out
    code, out, _ = run_remote(tmp_path, command, effective="")
    assert "KEY_ALREADY_PRESENT" in out
    lines = (tmp_path / "dotssh" / "authorized_keys").read_text().splitlines()
    assert lines == ["ssh-ed25519 AAAAexisting other", public_line]


def test_cli_refuses_unknown_flags_without_connecting(module, capsys) -> None:
    assert module.main([]) == 2
    assert module.main(["disable-password", "--force"]) == 2
    assert module.main(["reboot"]) == 2


def test_extra_public_keys_must_be_one_plain_line(module, tmp_path: Path) -> None:
    pytest.importorskip("cryptography")
    spec = importlib.util.spec_from_file_location(
        "vps_credentials", ROOT / "tools" / "vps-deploy" / "vps_credentials.py"
    )
    creds = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = creds
    spec.loader.exec_module(creds)
    line = creds.generate_ssh_key(tmp_path / "k", "unit-test-passphrase", comment="mac-mini@home")
    assert module.parse_public_key(line + "\n") == line
    body = line.split()[1]
    for bad in (
        "",
        line + "\n" + line,
        f'command="rm -rf /" ssh-ed25519 {body} x',
        f'from="1.2.3.4" ssh-ed25519 {body}',
        f"ssh-ed25519 {body} evil'quote",
        "ssh-ed25519 not-base64!!",
        f"ssh-rsa {body}",  # body says ed25519
    ):
        with pytest.raises(ValueError):
            module.parse_public_key(bad)
    assert module.main(["install-key", "--pubkey"]) == 2
    assert module.main(["audit", "--pubkey", str(tmp_path / "k.pub")]) == 2
