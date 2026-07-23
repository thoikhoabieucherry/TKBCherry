"""One-time elevated setup for the isolated WSL solver runtime."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .wsl_solver import (
    WSL_RUNTIME_VERSION,
    _decode_wsl_output,
    _hidden_creation_flags,
    _terminate_probe_tree,
    discover_wsl_runtime,
    parse_wsl_distributions,
    wsl_executable,
)


DEFAULT_DISTRIBUTION = "Ubuntu-24.04"
SETUP_OK = 0
SETUP_FAILED = 2
SETUP_RESTART_REQUIRED = 75
SETUP_RESULT_SCHEMA = 1
SETUP_RESULT_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
ELEVATED_SETUP_TIMEOUT_MS = 60 * 60 * 1000
_RESTART_EXIT_CODES = frozenset({3010, 1641})
_WINDOWS_FEATURES = (
    (
        "Microsoft-Windows-Subsystem-Linux",
        "Windows Subsystem for Linux",
    ),
    (
        "VirtualMachinePlatform",
        "Virtual Machine Platform",
    ),
)


class WslSetupError(RuntimeError):
    """A safe, user-displayable setup failure.

    ``diagnostic`` is deliberately limited to command status/output and never
    contains command arguments, environment variables, or credentials.
    """

    def __init__(self, message: str, diagnostic: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.diagnostic = diagnostic.strip()

    def __str__(self) -> str:
        if not self.diagnostic:
            return self.message
        return f"{self.message}\n\nChi tiết: {self.diagnostic}"


@dataclass(frozen=True, slots=True)
class WslSetupResult:
    distribution: str
    restart_required: bool = False


@dataclass(frozen=True, slots=True)
class SetupReport:
    """Result written by the elevated child for the non-elevated GUI."""

    code: int
    message: str
    diagnostic: str = ""
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


def _safe_diagnostic_text(value: str, *, limit: int = 600) -> str:
    """Redact user paths and Agent tokens from a diagnostic fragment."""

    text = value.replace("\x00", " ")
    text = " ".join(text.split())
    for private_path in (
        os.environ.get("USERPROFILE", ""),
        os.environ.get("LOCALAPPDATA", ""),
        os.environ.get("TEMP", ""),
        os.environ.get("TMP", ""),
    ):
        if private_path:
            text = re.sub(
                re.escape(private_path),
                "<user-path>",
                text,
                flags=re.IGNORECASE,
            )
    text = re.sub(
        r"tkb(?:a|t)?_[A-Za-z0-9_-]{12,}",
        "<redacted-token>",
        text,
    )
    return text[-limit:]


def _safe_command_diagnostic(
    completed: subprocess.CompletedProcess[bytes],
    *,
    label: str,
) -> str:
    """Return bounded, non-secret command diagnostics for the UI/log file."""

    raw = completed.stderr or completed.stdout or b""
    text = _safe_diagnostic_text(_decode_wsl_output(raw))
    status = f"{label} trả mã {completed.returncode}."
    return f"{status} {text}".strip()


def _run(
    command: Sequence[str],
    *,
    run: RunCommand | None,
    timeout: float,
    input_data: bytes | None = None,
    action: str = "Cài bộ xử lý Agent",
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
            raise WslSetupError(
                f"Không thể khởi động bước {action.lower()}.",
                _safe_diagnostic_text(f"{type(exc).__name__}: {exc}", limit=240),
            ) from exc
        try:
            stdout, stderr = process.communicate(input_data, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            _terminate_probe_tree(process)
            raise WslSetupError(
                f"{action} đã quá thời gian cho phép.",
                f"Đã dừng sau {int(timeout)} giây để tránh treo Agent.",
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
        raise WslSetupError(
            f"{action} đã quá thời gian cho phép.",
            f"Đã dừng sau {int(timeout)} giây để tránh treo Agent.",
        ) from exc
    except OSError as exc:
        raise WslSetupError(
            f"Không thể khởi động bước {action.lower()}.",
            _safe_diagnostic_text(f"{type(exc).__name__}: {exc}", limit=240),
        ) from exc


def _select_distribution(installed: Sequence[str], preferred: str) -> str | None:
    lookup = {name.casefold(): name for name in installed}
    for name in (preferred, DEFAULT_DISTRIBUTION, "Ubuntu", "Debian"):
        selected = lookup.get(name.casefold())
        if selected:
            return selected
    return None


def _dism_executable() -> str:
    """Locate the signed Windows servicing tool without relying on PATH."""

    if os.name == "nt":
        candidate = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "dism.exe"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("dism.exe") or shutil.which("dism") or "dism.exe"


def _feature_state(
    feature: str,
    *,
    dism: str,
    run: RunCommand | None,
) -> str:
    """Read a feature state using DISM's locale-independent English output."""

    completed = _run(
        [
            dism,
            "/Online",
            "/English",
            "/Get-FeatureInfo",
            f"/FeatureName:{feature}",
        ],
        run=run,
        timeout=120.0,
        action=f"Kiểm tra thành phần Windows {feature}",
    )
    if completed.returncode != 0:
        raise WslSetupError(
            f"Không đọc được trạng thái thành phần Windows {feature}.",
            _safe_command_diagnostic(completed, label="DISM"),
        )
    output = _decode_wsl_output(completed.stdout + b"\n" + completed.stderr)
    match = re.search(r"^\s*State\s*:\s*(.+?)\s*$", output, flags=re.IGNORECASE | re.MULTILINE)
    if not match:
        raise WslSetupError(
            f"Windows không trả về trạng thái thành phần {feature}.",
            "DISM không có dòng State; chưa gọi WSL để tránh treo.",
        )
    state = re.sub(r"[^a-z]", "", match.group(1).casefold())
    if state == "enabled":
        return "enabled"
    if state in {"enablepending", "disablepending"}:
        return "pending"
    if state in {"disabled", "disabledwithpayloadremoved"}:
        return "disabled"
    raise WslSetupError(
        f"Trạng thái thành phần Windows {feature} chưa được hỗ trợ.",
        f"DISM trả về State: {match.group(1).strip()[:120]}.",
    )


def _ensure_windows_features(
    *,
    dism: str | None = None,
    run: RunCommand | None = None,
) -> bool:
    """Enable WSL prerequisites and report whether Windows must reboot.

    We intentionally return before touching ``wsl.exe`` after an enablement
    operation.  Calling WSL while the optional feature is still pending is the
    source of the long ``wsl --list`` hangs seen on fresh machines.
    """

    servicing_tool = dism or _dism_executable()
    states = [
        (feature, label, _feature_state(feature, dism=servicing_tool, run=run))
        for feature, label in _WINDOWS_FEATURES
    ]
    restart_pending = any(state == "pending" for _feature, _label, state in states)
    changed: list[str] = []
    for feature, label, state in states:
        if state != "disabled":
            continue
        completed = _run(
            [
                servicing_tool,
                "/Online",
                "/English",
                "/Enable-Feature",
                f"/FeatureName:{feature}",
                "/All",
                "/NoRestart",
            ],
            run=run,
            timeout=300.0,
            action=f"Bật thành phần Windows {label}",
        )
        if completed.returncode not in ({0} | _RESTART_EXIT_CODES):
            raise WslSetupError(
                f"Không thể bật thành phần Windows {label}.",
                _safe_command_diagnostic(completed, label="DISM"),
            )
        changed.append(label)
    return restart_pending or bool(changed)


def _setup_distributions(
    executable: str,
    *,
    run: RunCommand | None,
) -> list[str]:
    """List distributions with a setup-specific error instead of swallowing it."""

    completed = _run(
        [executable, "--list", "--quiet"],
        run=run,
        timeout=15.0,
        action="Kiểm tra môi trường WSL",
    )
    if completed.returncode != 0:
        raise WslSetupError(
            "WSL chưa sẵn sàng sau khi bật các thành phần Windows.",
            _safe_command_diagnostic(completed, label="wsl --list"),
        )
    return parse_wsl_distributions(completed.stdout)


def install_wsl_runtime(
    *,
    source_root: Path | None = None,
    version: str = WSL_RUNTIME_VERSION,
    preferred_distribution: str = DEFAULT_DISTRIBUTION,
    executable: str | None = None,
    run: RunCommand | None = None,
    platform_name: str | None = None,
    dism_executable: str | None = None,
) -> WslSetupResult:
    source = _validate_source(source_root or wsl_source_root())
    distribution_name = _validate_distribution(preferred_distribution)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", version):
        raise WslSetupError("Phiên bản bộ xử lý Agent không hợp lệ.")
    platform = os.name if platform_name is None else platform_name
    if platform == "nt" and _ensure_windows_features(
        dism=dism_executable,
        run=run,
    ):
        return WslSetupResult(distribution_name, restart_required=True)

    wsl = executable or wsl_executable()
    if not wsl:
        raise WslSetupError(
            "Windows Subsystem for Linux chưa có trên máy.",
            "Hai thành phần Windows đã bật nhưng không tìm thấy wsl.exe.",
        )

    installed = _setup_distributions(wsl, run=run)
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
            action=f"Cài môi trường Linux {distribution_name}",
        )
        if completed.returncode in _RESTART_EXIT_CODES:
            return WslSetupResult(distribution_name, restart_required=True)
        if completed.returncode != 0:
            raise WslSetupError(
                f"Windows không cài được môi trường Linux {distribution_name} cho Agent.",
                _safe_command_diagnostic(completed, label="wsl --install"),
            )
        installed = _setup_distributions(wsl, run=run)
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
        action="Cài thư viện tối ưu trong WSL",
    )
    if completed.returncode != 0:
        raise WslSetupError(
            "Không thể cài bộ giải trong WSL; Agent vẫn để VPS xếp an toàn.",
            _safe_command_diagnostic(completed, label="Bộ cài Linux"),
        )
    runtime = discover_wsl_runtime(
        preferred_distribution=distribution,
        timeout=20.0,
        executable=wsl,
        run=run,
    )
    if runtime is None:
        raise WslSetupError(
            "Bộ giải WSL chưa vượt qua bước kiểm tra sau cài đặt.",
            "Không đọc được READY đúng phiên bản sau khi cài.",
        )
    return WslSetupResult(runtime.distribution)


def _setup_result_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    base = Path(local_app_data) if local_app_data else Path(tempfile.gettempdir())
    return base / "TKBCherry" / "Agent" / "setup-results"


def _setup_result_path(result_id: str) -> Path:
    normalized = result_id.strip().casefold()
    if not SETUP_RESULT_ID_PATTERN.fullmatch(normalized):
        raise WslSetupError("Mã phiên cài bộ xử lý Agent không hợp lệ.")
    return _setup_result_root() / f"setup-{normalized}.json"


def _write_setup_report(result_id: str, report: SetupReport) -> None:
    path = _setup_result_path(result_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    payload = {
        "schema": SETUP_RESULT_SCHEMA,
        "code": int(report.code),
        "message": report.message[:600],
        "diagnostic": report.diagnostic[:1200],
        "restartRequired": bool(report.restart_required),
    }
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _read_setup_report(result_id: str) -> SetupReport | None:
    path = _setup_result_path(result_id)
    try:
        if path.stat().st_size > 4096:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or payload.get("schema") != SETUP_RESULT_SCHEMA:
        return None
    code = payload.get("code")
    message = payload.get("message")
    diagnostic = payload.get("diagnostic", "")
    if code not in {SETUP_OK, SETUP_FAILED, SETUP_RESTART_REQUIRED}:
        return None
    if not isinstance(message, str) or not isinstance(diagnostic, str):
        return None
    return SetupReport(
        code=code,
        message=message[:600],
        diagnostic=diagnostic[:1200],
        restart_required=bool(payload.get("restartRequired", False)),
    )


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
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    result_id = uuid.uuid4().hex
    result_path = _setup_result_path(result_id)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    arguments = (
        ["--wsl-setup", "--wsl-setup-result", result_id]
        if getattr(sys, "frozen", False)
        else ["-m", "agent_helper", "--wsl-setup", "--wsl-setup-result", result_id]
    )
    parameters = subprocess.list2cmdline(arguments)
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
        wait_result = int(
            kernel32.WaitForSingleObject(
                information.hProcess,
                ELEVATED_SETUP_TIMEOUT_MS,
            )
        )
        if wait_result == 0x00000102:  # WAIT_TIMEOUT
            kernel32.TerminateProcess(information.hProcess, SETUP_FAILED)
            raise WslSetupError(
                "Trình cài bộ xử lý Agent không phản hồi và đã được dừng.",
                "Đã chờ tối đa 60 phút; lượt xếp vẫn dùng VPS.",
            )
        if wait_result != 0x00000000:  # WAIT_OBJECT_0
            raise WslSetupError(
                "Windows không theo dõi được tiến trình cài bộ xử lý Agent.",
                f"WaitForSingleObject trả mã {wait_result}.",
            )
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(
            information.hProcess, ctypes.byref(exit_code)
        ):
            raise WslSetupError("Không đọc được kết quả cài bộ xử lý Agent.")
        code = int(exit_code.value)
        report = _read_setup_report(result_id)
        if report is None:
            if code in {SETUP_OK, SETUP_RESTART_REQUIRED}:
                return code
            raise WslSetupError(
                "Trình cài bộ xử lý Agent đã dừng nhưng không trả về chẩn đoán.",
                f"Tiến trình Administrator trả mã {code}.",
            )
        if report.code != code:
            raise WslSetupError(
                "Kết quả cài bộ xử lý Agent không nhất quán.",
                f"Tiến trình trả mã {code}, báo cáo trả mã {report.code}.",
            )
        if code == SETUP_FAILED:
            raise WslSetupError(report.message, report.diagnostic)
        return code
    finally:
        kernel32.CloseHandle(information.hProcess)
        try:
            result_path.unlink(missing_ok=True)
        except OSError:
            pass


def setup_cli(result_id: str | None = None) -> int:
    try:
        result = install_wsl_runtime()
    except WslSetupError as exc:
        report = SetupReport(
            code=SETUP_FAILED,
            message=exc.message,
            diagnostic=exc.diagnostic,
        )
    except Exception as exc:
        report = SetupReport(
            code=SETUP_FAILED,
            message="Bộ cài Agent gặp lỗi ngoài dự kiến; lượt xếp vẫn dùng VPS.",
            diagnostic=f"Loại lỗi: {type(exc).__name__}.",
        )
    else:
        if result.restart_required:
            report = SetupReport(
                code=SETUP_RESTART_REQUIRED,
                message=(
                    "Windows đã chuẩn bị thành phần Linux cho Agent và cần "
                    "khởi động lại máy một lần."
                ),
                restart_required=True,
            )
        else:
            report = SetupReport(
                code=SETUP_OK,
                message="Bộ xử lý Agent đã được cài và kiểm tra thành công.",
            )
    if result_id is not None:
        try:
            _write_setup_report(result_id, report)
        except (OSError, WslSetupError):
            # The process exit code remains authoritative if the medium-integrity
            # parent cannot read the optional diagnostics file.
            pass
    return report.code
