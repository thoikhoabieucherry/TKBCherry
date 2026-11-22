#!/usr/bin/env python3
"""Move VPS root SSH from password logins to the deploy key, then turn passwords off.

usage (no flag = print the remote commands only, no connection):
  python tools/vps-deploy/ssh-key-auth.py audit                      # read-only: sshd, keys, fail2ban
  python tools/vps-deploy/ssh-key-auth.py install-key [--apply]      # append the .pub, test a key login
  python tools/vps-deploy/ssh-key-auth.py install-key --apply --pubkey other.pub  # authorise another machine
  python tools/vps-deploy/ssh-key-auth.py disable-password [--apply] # keys only + verify + auto-rollback
  python tools/vps-deploy/ssh-key-auth.py enable-password [--apply]  # undo disable-password

The key pair comes from ``vps_credentials.py ssh-keygen`` (private key and its
DPAPI passphrase stay in %LOCALAPPDATA%\\TKBCherry\\secrets, outside the repo).

disable-password keeps one key session open the whole time, writes ONE file
(``/etc/ssh/sshd_config.d/00-tkb-keys-only.conf``), checks ``sshd -t`` and the
effective ``sshd -T`` values before reloading, then opens a NEW key login and
asks the server which methods it still offers (``none`` probe: no credential
is sent). If the new login fails or passwords are still offered, the open
session deletes the file and reloads sshd again. Locked out anyway? Log in on
the VPS provider's web console (local tty: root password still works there)
and run ``rm /etc/ssh/sshd_config.d/00-tkb-keys-only.conf && systemctl reload ssh``.
"""
from __future__ import annotations

import shlex
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

KEYS_ONLY_CONF = "/etc/ssh/sshd_config.d/00-tkb-keys-only.conf"
KEYS_ONLY_TEXT = (
    "# TKBCherry 2026-11-21: root logs in with SSH keys only (tools/vps-deploy/ssh-key-auth.py).\n"
    "# Undo: rm this file && systemctl reload ssh   (or: ssh-key-auth.py enable-password --apply)\n"
    "PasswordAuthentication no\n"
    "KbdInteractiveAuthentication no\n"
    "PermitRootLogin prohibit-password\n"
)
# Evaluate sshd as a real root connection would (Match blocks included).
SSHD_EFFECTIVE = (
    "sshd -T -C user=root,host=probe.invalid,addr=203.0.113.1 2>&1 | grep -Ei "
    "'^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|"
    "pubkeyauthentication|authorizedkeysfile|usepam) '"
)
RELOAD_SSHD = "systemctl try-reload-or-restart ssh.service"
AUDIT_COMMANDS = (
    ("os", "lsb_release -ds 2>/dev/null; ssh -V 2>&1"),
    ("effective sshd settings for root", SSHD_EFFECTIVE),
    ("Include line in sshd_config", "grep -nEi '^[[:space:]]*(Include|Match)' /etc/ssh/sshd_config || true"),
    ("sshd_config.d", "ls -la /etc/ssh/sshd_config.d/ 2>&1; grep -HnEi "
     "'^[[:space:]]*(PasswordAuthentication|KbdInteractive|PermitRootLogin|Match)' "
     "/etc/ssh/sshd_config.d/*.conf 2>/dev/null || true"),
    ("ssh units", "systemctl is-active ssh.service ssh.socket 2>&1 | paste -sd ' '"),
    ("authorized_keys", "ls -la /root/.ssh 2>&1; ssh-keygen -lf /root/.ssh/authorized_keys 2>&1 || true"),
    ("fail2ban", "systemctl is-active fail2ban; fail2ban-client status sshd 2>&1 | head -8"),
)


PUBKEY_TYPES = (
    "ssh-ed25519",
    "sk-ssh-ed25519@openssh.com",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
)


def parse_public_key(text: str) -> str:
    """One plain ``<type> <base64> [comment]`` line; no authorized_keys options."""
    import base64
    import binascii
    import re

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("expected exactly one public key line")
    parts = lines[0].split()
    if len(parts) < 2 or parts[0] not in PUBKEY_TYPES:
        raise ValueError(f"not a plain OpenSSH public key (type must be one of {', '.join(PUBKEY_TYPES)})")
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("public key body is not base64") from exc
    if parts[0].encode() not in blob[:64]:
        raise ValueError("public key body does not match its type")
    comment = " ".join(parts[2:])
    if not re.fullmatch(r"[A-Za-z0-9@._+:=-]*( [A-Za-z0-9@._+:=-]+)*", comment):
        raise ValueError("public key comment has unexpected characters")
    return " ".join(parts[:2] + ([comment] if comment else []))


def install_key_command(public_line: str) -> str:
    key = shlex.quote(public_line)
    ak = "/root/.ssh/authorized_keys"
    return "; ".join(
        [
            "set -e",
            "umask 077",
            "install -d -m 700 -o root -g root /root/.ssh",
            f"touch {ak}",
            f"chmod 600 {ak}",
            # keep the new key on its own line even if the file lacks a final newline
            f'if [ -s {ak} ] && [ -n "$(tail -c1 {ak})" ]; then echo >> {ak}; fi',
            f"if grep -qxF {key} {ak}; then echo KEY_ALREADY_PRESENT; "
            f"else printf '%s\\n' {key} >> {ak}; echo KEY_ADDED; fi",
            f"ssh-keygen -lf {ak}",
        ]
    )


def disable_password_command() -> str:
    # No `set -e`: every failure path below must remove the file before exiting,
    # so a later sshd restart can never pick up a half-checked config.
    conf = shlex.quote(KEYS_ONLY_CONF)
    return "; ".join(
        [
            f"printf '%s' {shlex.quote(KEYS_ONLY_TEXT)} > {conf} && chmod 644 {conf} "
            f"|| {{ rm -f {conf}; echo WRITE_FAILED; exit 2; }}",
            f"if ! sshd -t; then rm -f {conf}; echo SSHD_T_FAILED; exit 3; fi",
            # sshd keeps the FIRST value it reads: check ours is the effective one
            f"eff=\"$({SSHD_EFFECTIVE})\"",
            "echo \"$eff\"",
            "if echo \"$eff\" | grep -qx 'passwordauthentication no' "
            "&& echo \"$eff\" | grep -qx 'kbdinteractiveauthentication no' "
            "&& echo \"$eff\" | grep -qxE 'permitrootlogin (without-password|prohibit-password)'; "
            f"then :; else rm -f {conf}; echo EFFECTIVE_CONFIG_MISMATCH; exit 4; fi",
            f"if ! {RELOAD_SSHD}; then rm -f {conf}; {RELOAD_SSHD}; echo RELOAD_FAILED; exit 5; fi",
            "echo RELOAD_OK",
        ]
    )


def enable_password_command() -> str:
    conf = shlex.quote(KEYS_ONLY_CONF)
    return "; ".join(
        [
            f"rm -f {conf}",
            "sshd -t || { echo SSHD_T_FAILED; exit 3; }",
            f"{RELOAD_SSHD} || {{ echo RELOAD_FAILED; exit 5; }}",
            f"{SSHD_EFFECTIVE} || true",
            "echo ROLLBACK_OK",
        ]
    )


def run(client, command: str, timeout: int = 60) -> tuple[int, str]:
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out.strip()


def offered_auth_methods(host: str, user: str, timeout: float = 20) -> list[str]:
    """Ask sshd which methods it offers via the 'none' method; sends no credential."""
    import paramiko

    sock = socket.create_connection((host, 22), timeout=timeout)
    transport = paramiko.Transport(sock)
    try:
        transport.start_client(timeout=timeout)
        try:
            transport.auth_none(user)
        except paramiko.BadAuthenticationType as exc:
            return sorted(exc.allowed_types)
        return ["none"]
    finally:
        transport.close()


def key_auth(base):
    """The resolved credentials, forced to key-only (no password fallback)."""
    from dataclasses import replace

    return replace(base, mode="key", password="")


def new_client():
    import paramiko

    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    return client


def main(argv: list[str]) -> int:
    actions = ("audit", "install-key", "disable-password", "enable-password")
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    action, rest = argv[0], argv[1:]
    apply = False
    extra_pubkey: Path | None = None
    index = 0
    while index < len(rest):
        flag = rest[index]
        if flag == "--apply":
            apply = True
        elif flag == "--pubkey" and action == "install-key" and index + 1 < len(rest):
            extra_pubkey = Path(rest[index + 1])
            index += 1
        else:
            print(__doc__)
            return 2
        index += 1
    if action not in actions:
        print(__doc__)
        return 2

    from vps_credentials import (  # noqa: E402
        CredentialError,
        connect_vps,
        missing_credential_message,
        read_public_key,
        resolve_vps_auth,
    )

    try:
        public_line = read_public_key()
    except CredentialError as exc:
        print(f"{exc}\nCreate it first: python tools/vps-deploy/vps_credentials.py ssh-keygen")
        return 1
    if extra_pubkey is not None:
        try:
            public_line = parse_public_key(extra_pubkey.read_text(encoding="ascii"))
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            print(f"--pubkey {extra_pubkey}: {exc}")
            return 2

    planned = {
        "audit": "\n".join(cmd for _label, cmd in AUDIT_COMMANDS),
        "install-key": install_key_command(public_line),
        "disable-password": disable_password_command(),
        "enable-password": enable_password_command(),
    }[action]
    if action != "audit" and not apply:
        print(f"DRY RUN ({action}); remote command with --apply:\n\n{planned}\n")
        return 0

    base = resolve_vps_auth()
    if not base.ready:
        print(missing_credential_message())
        return 1
    host, user = base.host, base.user

    if action == "audit":
        client = connect_vps(new_client(), auth=base)
        try:
            for label, command in AUDIT_COMMANDS:
                print(f"== {label}\n{run(client, command)[1]}\n")
        finally:
            client.close()
        print("offered auth methods:", ", ".join(offered_auth_methods(host, user)))
        return 0

    if action == "install-key":
        client = connect_vps(new_client(), auth=base)  # password fallback is expected here
        try:
            code, out = run(client, planned)
            print(out)
            if code != 0:
                return 1
        finally:
            client.close()
        if extra_pubkey is not None:
            return 0  # another machine's key: it proves itself from that machine
        probe = connect_vps(new_client(), auth=key_auth(base))
        try:
            print("KEY_LOGIN_OK", run(probe, "whoami")[1])
        finally:
            probe.close()
        return 0

    if action == "enable-password":
        client = connect_vps(new_client(), auth=key_auth(base) if base.key_path else base)
        try:
            code, out = run(client, planned)
            print(out)
        finally:
            client.close()
        print("offered auth methods:", ", ".join(offered_auth_methods(host, user)))
        return 0 if code == 0 else 1

    # disable-password: session A (key) stays open until the new login is proven.
    try:
        anchor = connect_vps(new_client(), auth=key_auth(base))
    except Exception as exc:  # noqa: BLE001 - report and stop before any change
        print(f"Key login does not work yet ({exc}); run install-key --apply first. Nothing changed.")
        return 1
    try:
        code, out = run(anchor, planned)
        print(out)
        if code != 0 or "RELOAD_OK" not in out:
            print("sshd config NOT applied (file removed, sshd not reloaded).")
            return 1
        failure = ""
        try:
            fresh = connect_vps(new_client(), auth=key_auth(base))
            try:
                print("NEW_KEY_LOGIN_OK", run(fresh, "whoami")[1])
            finally:
                fresh.close()
            methods = offered_auth_methods(host, user)
            print("offered auth methods:", ", ".join(methods))
            if "password" in methods or "keyboard-interactive" in methods or "none" in methods:
                failure = f"server still offers {methods}"
        except Exception as exc:  # noqa: BLE001 - any failure means roll back via the anchor
            failure = f"new key login failed: {exc}"
        if failure:
            print(f"ROLLING BACK: {failure}")
            print(run(anchor, enable_password_command())[1])
            print("offered auth methods after rollback:", ", ".join(offered_auth_methods(host, user)))
            return 1
        print(run(anchor, "systemctl is-active fail2ban; fail2ban-client status sshd | head -8")[1])
        print("PASSWORD_LOGIN_DISABLED")
        return 0
    finally:
        anchor.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
