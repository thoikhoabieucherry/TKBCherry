"""Current-user Windows startup registration for the packaged GUI Agent."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from typing import Any


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE_NAME = "TKBCherryAgent"

StartupToggle = Callable[[bool], bool]


class StartupRegistrationError(RuntimeError):
    """Raised when a requested startup command would be unsafe."""


def should_manage_startup(
    gui_mode: bool,
    *,
    frozen: bool | None = None,
    platform_name: str | None = None,
) -> bool:
    """Return true only for the normal frozen Windows GUI process."""

    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    platform = os.name if platform_name is None else platform_name
    return bool(gui_mode and is_frozen and platform == "nt")


def _startup_command(executable: str) -> str:
    value = str(executable).strip()
    if (
        not value
        or not value.casefold().endswith(".exe")
        or '"' in value
        or any(ord(character) < 32 for character in value)
    ):
        raise StartupRegistrationError("packaged Agent executable path is invalid")
    # The one fixed switch distinguishes Windows logon from a manual launch so
    # logon can stay in the tray. No user data or credential is accepted here.
    return subprocess.list2cmdline([value, "--startup"])


def set_current_user_startup(
    enabled: bool,
    *,
    executable: str | None = None,
    registry: Any | None = None,
) -> bool:
    """Idempotently add or remove the Agent's HKCU Run value.

    Returns ``True`` only when the registry changed. This deliberately uses
    HKCU, so it never needs elevation and never writes a token or arguments.
    """

    registry_api = registry
    if registry_api is None:
        if os.name != "nt":
            raise StartupRegistrationError("Windows startup is unavailable")
        import winreg

        registry_api = winreg

    access = registry_api.KEY_QUERY_VALUE | registry_api.KEY_SET_VALUE
    if not enabled:
        try:
            key_context = registry_api.OpenKey(
                registry_api.HKEY_CURRENT_USER,
                RUN_KEY,
                0,
                access,
            )
        except FileNotFoundError:
            return False
        with key_context as key:
            try:
                registry_api.DeleteValue(key, RUN_VALUE_NAME)
            except FileNotFoundError:
                return False
        return True

    command = _startup_command(sys.executable if executable is None else executable)
    with registry_api.CreateKeyEx(
        registry_api.HKEY_CURRENT_USER,
        RUN_KEY,
        0,
        access,
    ) as key:
        try:
            current_value, current_type = registry_api.QueryValueEx(
                key, RUN_VALUE_NAME
            )
        except FileNotFoundError:
            current_value, current_type = None, None
        if current_value == command and current_type == registry_api.REG_SZ:
            return False
        registry_api.SetValueEx(
            key,
            RUN_VALUE_NAME,
            0,
            registry_api.REG_SZ,
            command,
        )
    return True


def startup_toggle_for_current_process(
    gui_mode: bool,
    *,
    frozen: bool | None = None,
    platform_name: str | None = None,
    executable: str | None = None,
    registry: Any | None = None,
) -> StartupToggle | None:
    """Build a startup toggle only for an ordinary packaged GUI launch."""

    if not should_manage_startup(
        gui_mode,
        frozen=frozen,
        platform_name=platform_name,
    ):
        return None

    packaged_executable = sys.executable if executable is None else executable

    def toggle(enabled: bool) -> bool:
        return set_current_user_startup(
            enabled,
            executable=packaged_executable,
            registry=registry,
        )

    return toggle
