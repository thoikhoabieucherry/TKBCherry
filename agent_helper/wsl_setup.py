"""One-time elevated setup for the isolated WSL solver runtime."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .wsl_solver import (
    WSL_RUNTIME_VERSION,
    _hidden_creation_flags,
    _terminate_probe_tree,
    discover_wsl_runtime,
    list_wsl_distributions,
    wsl_executable,
)


DEFAULT_DISTRIBUTION = "Ubuntu-24.04"
SETUP_OK = 0
SETUP_FAILED = 2
SETUP_RESTART_REQUIRED = 75


class WslSetupError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class WslSetupResult:
    distribution: str
    restart_required: bool = False


RunCommand = Callable[..., subprocess.CompletedProcess[bytes]]


_INSTALL_SCRIPT = r"""
set -euo pipefail
umask 022

SOURCE_WINDOWS="$1"
RUNTIME_VERSION="$2"
INSTALL_ROOT="/opt/tkbcherry-agent"
WORKER_USER="tkb-agent"
SOURCE_ROOT="$(wslpath -u "$SOURCE_WINDOWS")"

for required in \
  "$SOURCE_ROOT/solver_runtime/scripts/solve_stdio.py" \
  "$SOURCE_ROOT/solver_runtime/scripts/wsl_solve.py" \
  "$SOURCE_ROOT/solver_runtime/scripts/wsl_cancel.py" \
  "$SOURCE_ROOT/solver_runtime/src" \
  "$SOURCE_ROOT/solver_runtime/src/tkb_optimizer_ref/base_179_session_hint.json" \
  "$SOURCE_ROOT/solver_runtime/src/tkb_optimizer_ref/base_179_session_hint_gap3.json" \
  "$SOURCE_ROOT/solver_runtime/src/tkb_optimizer_ref/base_180_gap0_period_hint.json" \
  "$SOURCE_ROOT/solver_runtime/src/tkb_optimizer_ref/base_180_session_hint.json" \
  "$SOURCE_ROOT/solver_runtime/src/tkb_optimizer_ref/base_181_session_hint.json" \
  "$SOURCE_ROOT/solver_runtime/src/tkb_optimizer_ref/base_184_hint.json" \
  "$SOURCE_ROOT/solver_runtime/requirements-wsl.txt"; do
  [ -e "$required" ] || { echo "Missing WSL runtime source: $required" >&2; exit 21; }
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates python3 python3-pip python3-venv

if ! id "$WORKER_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/tkbcherry-agent \
    --shell /usr/sbin/nologin "$WORKER_USER"
fi

install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/releases"
release="$INSTALL_ROOT/releases/$RUNTIME_VERSION"
pending="$INSTALL_ROOT/.pending-$RUNTIME_VERSION-$$"
next_link="$INSTALL_ROOT/.current-$RUNTIME_VERSION-$$"
rm -rf -- "$pending"
install -d -o root -g root -m 0755 "$pending/solver_runtime"
trap 'rm -rf -- "$pending" "$next_link"' EXIT HUP INT TERM

cp -a -- "$SOURCE_ROOT/solver_runtime/scripts" "$pending/solver_runtime/scripts"
cp -a -- "$SOURCE_ROOT/solver_runtime/src" "$pending/solver_runtime/src"
install -o root -g root -m 0644 \
  "$SOURCE_ROOT/solver_runtime/requirements-wsl.txt" \
  "$pending/solver_runtime/requirements.txt"

python3 -m venv "$pending/venv"
"$pending/venv/bin/python" -m pip install \
  --disable-pip-version-check --no-input \
  -r "$pending/solver_runtime/requirements.txt"
PYTHONPATH="$pending/solver_runtime/src" \
  "$pending/venv/bin/python" -c \
  'import numpy, scipy, openpyxl, ortools; from ortools.sat.python import cp_model; assert cp_model.CpModel() is not None'

"$pending/venv/bin/python" -m compileall -b -f -q -o 2 \
  "$pending/solver_runtime/scripts" "$pending/solver_runtime/src"
test -f "$pending/solver_runtime/scripts/solve_stdio.pyc"
test -f "$pending/solver_runtime/scripts/wsl_solve.pyc"
test -f "$pending/solver_runtime/scripts/wsl_cancel.pyc"
find "$pending/solver_runtime/scripts" "$pending/solver_runtime/src" \
  -type f -name '*.py' -delete

printf '%s\n' "$RUNTIME_VERSION" > "$pending/READY"
chown -R root:root "$pending"
find "$pending" -type d -exec chmod 0755 {} +
find "$pending" -type f -exec chmod go-w {} +

rm -rf -- "$release"
mv -- "$pending" "$release"
ln -s -- "$release" "$next_link"
mv -Tf -- "$next_link" "$INSTALL_ROOT/current"
trap - EXIT HUP INT TERM
"""


def wsl_source_root() -> Path:
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return bundle_root / "wsl_runtime"
    return Path(__file__).resolve().parents[1]


def _validate_source(source_root: Path) -> Path:
    root = source_root.resolve()
    required = (
        root / "solver_runtime" / "scripts" / "solve_stdio.py",
        root / "solver_runtime" / "scripts" / "wsl_solve.py",
        root / "solver_runtime" / "scripts" / "wsl_cancel.py",
        root / "solver_runtime" / "src",
        root
        / "solver_runtime"
        / "src"
        / "tkb_optimizer_ref"
        / "base_179_session_hint.json",
        root
        / "solver_runtime"
        / "src"
        / "tkb_optimizer_ref"
        / "base_179_session_hint_gap3.json",
        root
        / "solver_runtime"
        / "src"
        / "tkb_optimizer_ref"
        / "base_180_gap0_period_hint.json",
        root
        / "solver_runtime"
        / "src"
        / "tkb_optimizer_ref"
        / "base_180_session_hint.json",
        root
        / "solver_runtime"
        / "src"
        / "tkb_optimizer_ref"
        / "base_181_session_hint.json",
        root
        / "solver_runtime"
        / "src"
        / "tkb_optimizer_ref"
        / "base_184_hint.json",
        root / "solver_runtime" / "requirements-wsl.txt",
    )
    if not all(path.exists() for path in required):
        raise WslSetupError("Bộ cài solver Linux của Agent chưa đầy đủ.")
    return root


def _validate_distribution(name: str) -> str:
    value = name.strip()
    if not value or not re.fullmatch(r"[A-Za-z0-9._+-]{1,80}", value):
        raise WslSetupError("Tên môi trường WSL không hợp lệ.")
    return value


def _run(
    command: Sequence[str],
    *,
    run: RunCommand | None,
    timeout: float,
    input_data: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    if run is None:
        try:
            process = subprocess.Popen(
                list(command),
                stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                creationflags=_hidden_creation_flags(),
            )
        except OSError as exc:
            raise WslSetupError("Không thể khởi động trình cài WSL.") from exc
        try:
            stdout, stderr = process.communicate(input_data, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            _terminate_probe_tree(process)
            raise WslSetupError(
                "Cài bộ xử lý Agent đã quá thời gian cho phép."
            ) from exc
        return subprocess.CompletedProcess(
            list(command), process.returncode, stdout, stderr
        )
    creationflags = _hidden_creation_flags()
    try:
        return run(
            list(command),
            input=input_data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            check=False,
            timeout=timeout,
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired as exc:
        raise WslSetupError("Cài bộ xử lý Agent đã quá thời gian cho phép.") from exc
    except OSError as exc:
        raise WslSetupError("Không thể khởi động trình cài WSL.") from exc


def _select_distribution(installed: Sequence[str], preferred: str) -> str | None:
    lookup = {name.casefold(): name for name in installed}
    for name in (preferred, DEFAULT_DISTRIBUTION, "Ubuntu", "Debian"):
        selected = lookup.get(name.casefold())
        if selected:
            return selected
    return None


def install_wsl_runtime(
    *,
    source_root: Path | None = None,
    version: str = WSL_RUNTIME_VERSION,
    preferred_distribution: str = DEFAULT_DISTRIBUTION,
    executable: str | None = None,
    run: RunCommand | None = None,
) -> WslSetupResult:
    source = _validate_source(source_root or wsl_source_root())
    distribution_name = _validate_distribution(preferred_distribution)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", version):
        raise WslSetupError("Phiên bản bộ xử lý Agent không hợp lệ.")
    wsl = executable or wsl_executable()
    if not wsl:
        raise WslSetupError("Windows Subsystem for Linux chưa có trên máy.")

    installed = list_wsl_distributions(wsl, timeout=10.0, run=run)
    distribution = _select_distribution(installed, distribution_name)
    if distribution is None:
        completed = _run(
            [
                wsl,
                "--install",
                "--distribution",
                distribution_name,
                "--no-launch",
            ],
            run=run,
            timeout=20 * 60,
        )
        if completed.returncode != 0:
            raise WslSetupError(
                "Windows không cài được môi trường Linux cho Agent."
            )
        installed = list_wsl_distributions(wsl, timeout=20.0, run=run)
        distribution = _select_distribution(installed, distribution_name)
        if distribution is None:
            return WslSetupResult(distribution_name, restart_required=True)

    completed = _run(
        [
            wsl,
            "--distribution",
            distribution,
            "--user",
            "root",
            "--exec",
            "bash",
            "-s",
            "--",
            str(source),
            version,
        ],
        run=run,
        timeout=30 * 60,
        input_data=_INSTALL_SCRIPT.encode("utf-8"),
    )
    if completed.returncode != 0:
        raise WslSetupError(
            "Không thể cài bộ giải trong WSL; Agent vẫn để VPS xếp an toàn."
        )
    runtime = discover_wsl_runtime(
        preferred_distribution=distribution,
        timeout=20.0,
        executable=wsl,
        run=run,
    )
    if runtime is None:
        raise WslSetupError("Bộ giải WSL chưa vượt qua bước kiểm tra sau cài đặt.")
    return WslSetupResult(runtime.distribution)


def run_elevated_setup() -> int:
    """Run this executable's setup mode through one UAC prompt and wait."""

    if os.name != "nt":
        raise WslSetupError("Trình cài Agent chỉ hỗ trợ Windows.")
    import ctypes
    from ctypes import wintypes

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", wintypes.ULONG),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", wintypes.LPVOID),
            ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD),
            ("hIconOrMonitor", wintypes.HANDLE),
            ("hProcess", wintypes.HANDLE),
        ]

    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    shell32.ShellExecuteExW.argtypes = [ctypes.POINTER(SHELLEXECUTEINFOW)]
    shell32.ShellExecuteExW.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    parameters = (
        "--wsl-setup"
        if getattr(sys, "frozen", False)
        else "-m agent_helper --wsl-setup"
    )
    information = SHELLEXECUTEINFOW()
    information.cbSize = ctypes.sizeof(SHELLEXECUTEINFOW)
    information.fMask = 0x00000040  # SEE_MASK_NOCLOSEPROCESS
    information.lpVerb = "runas"
    information.lpFile = str(Path(sys.executable).resolve())
    information.lpParameters = parameters
    information.nShow = 0
    if not shell32.ShellExecuteExW(ctypes.byref(information)):
        error = ctypes.get_last_error()
        if error == 1223:
            raise WslSetupError("Bạn đã hủy quyền cài bộ xử lý Agent.")
        raise WslSetupError("Windows không mở được trình cài Agent.")
    try:
        kernel32.WaitForSingleObject(information.hProcess, 0xFFFFFFFF)
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(
            information.hProcess, ctypes.byref(exit_code)
        ):
            raise WslSetupError("Không đọc được kết quả cài bộ xử lý Agent.")
        return int(exit_code.value)
    finally:
        kernel32.CloseHandle(information.hProcess)


def setup_cli() -> int:
    try:
        result = install_wsl_runtime()
    except WslSetupError:
        return SETUP_FAILED
    return SETUP_RESTART_REQUIRED if result.restart_required else SETUP_OK
