"""Windows code-integrity checks used before the bundled solver can load."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable


SMART_APP_CONTROL_POLICY_KEY = r"SYSTEM\CurrentControlSet\Control\CI\Policy"
SMART_APP_CONTROL_POLICY_VALUE = "VerifiedAndReputablePolicyState"
WINDOWS_CODE_INTEGRITY_KIND = "windows_code_integrity_blocked"


def smart_app_control_enforced() -> bool:
    """Return whether Windows' verified-and-reputable policy is enforcing."""

    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            SMART_APP_CONTROL_POLICY_KEY,
            0,
            winreg.KEY_READ,
        ) as key:
            value, _value_type = winreg.QueryValueEx(
                key, SMART_APP_CONTROL_POLICY_VALUE
            )
        return int(value) == 1
    except (ImportError, OSError, TypeError, ValueError):
        return False


def executable_has_trusted_authenticode(executable: Path | str | None = None) -> bool:
    """Verify an executable with the native Authenticode trust provider."""

    if os.name != "nt":
        return False
    path = Path(sys.executable if executable is None else executable)
    if not path.is_file():
        return False
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        class WINTRUST_FILE_INFO(ctypes.Structure):
            _fields_ = [
                ("cbStruct", wintypes.DWORD),
                ("pcwszFilePath", wintypes.LPCWSTR),
                ("hFile", wintypes.HANDLE),
                ("pgKnownSubject", ctypes.POINTER(GUID)),
            ]

        class WINTRUST_DATA(ctypes.Structure):
            _fields_ = [
                ("cbStruct", wintypes.DWORD),
                ("pPolicyCallbackData", ctypes.c_void_p),
                ("pSIPClientData", ctypes.c_void_p),
                ("dwUIChoice", wintypes.DWORD),
                ("fdwRevocationChecks", wintypes.DWORD),
                ("dwUnionChoice", wintypes.DWORD),
                ("pFile", ctypes.POINTER(WINTRUST_FILE_INFO)),
                ("dwStateAction", wintypes.DWORD),
                ("hWVTStateData", wintypes.HANDLE),
                ("pwszURLReference", wintypes.LPCWSTR),
                ("dwProvFlags", wintypes.DWORD),
                ("dwUIContext", wintypes.DWORD),
            ]

        action = GUID(
            0x00AAC56B,
            0xCD44,
            0x11D0,
            (ctypes.c_ubyte * 8)(
                0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE
            ),
        )
        file_info = WINTRUST_FILE_INFO()
        file_info.cbStruct = ctypes.sizeof(WINTRUST_FILE_INFO)
        file_info.pcwszFilePath = str(path.resolve())

        trust_data = WINTRUST_DATA()
        trust_data.cbStruct = ctypes.sizeof(WINTRUST_DATA)
        trust_data.dwUIChoice = 2  # WTD_UI_NONE
        trust_data.fdwRevocationChecks = 0  # WTD_REVOKE_NONE
        trust_data.dwUnionChoice = 1  # WTD_CHOICE_FILE
        trust_data.pFile = ctypes.pointer(file_info)
        trust_data.dwStateAction = 1  # WTD_STATEACTION_VERIFY
        trust_data.dwProvFlags = 0x1000  # WTD_CACHE_ONLY_URL_RETRIEVAL

        wintrust = ctypes.WinDLL("wintrust", use_last_error=True)
        verify = wintrust.WinVerifyTrust
        verify.argtypes = [wintypes.HWND, ctypes.POINTER(GUID), ctypes.c_void_p]
        verify.restype = wintypes.LONG
        window = wintypes.HWND(ctypes.c_void_p(-1).value)
        status = int(verify(window, ctypes.byref(action), ctypes.byref(trust_data)))
        trust_data.dwStateAction = 2  # WTD_STATEACTION_CLOSE
        verify(window, ctypes.byref(action), ctypes.byref(trust_data))
        return status == 0
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def solver_blocked_by_windows_code_integrity(
    *,
    frozen: bool | None = None,
    platform_name: str | None = None,
    executable: Path | str | None = None,
    policy_check: Callable[[], bool] = smart_app_control_enforced,
    trust_check: Callable[[Path | str | None], bool] = executable_has_trusted_authenticode,
) -> bool:
    """Gate the native solver when an unsigned frozen build would be blocked."""

    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else bool(frozen)
    platform = os.name if platform_name is None else platform_name
    if platform != "nt" or not is_frozen:
        return False
    return bool(policy_check()) and not bool(trust_check(executable))


__all__ = [
    "SMART_APP_CONTROL_POLICY_KEY",
    "SMART_APP_CONTROL_POLICY_VALUE",
    "WINDOWS_CODE_INTEGRITY_KIND",
    "executable_has_trusted_authenticode",
    "smart_app_control_enforced",
    "solver_blocked_by_windows_code_integrity",
]
