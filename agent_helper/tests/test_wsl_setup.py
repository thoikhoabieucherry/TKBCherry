from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agent_helper.wsl_setup import (
    DEFAULT_DISTRIBUTION,
    SETUP_FAILED,
    SETUP_RESTART_REQUIRED,
    SetupReport,
    WslSetupError,
    WslSetupResult,
    _read_setup_report,
    _preferred_wsl_version,
    _winget_executable,
    _write_setup_report,
    install_wsl_runtime,
    setup_cli,
)
from agent_helper.wsl_solver import WSL_RUNTIME_VERSION
from agent_helper.wsl_solver import WSL_MANAGED_DISTRIBUTIONS


def make_source(root: Path) -> None:
    (root / "solver_runtime" / "scripts").mkdir(parents=True)
    (root / "solver_runtime" / "src").mkdir(parents=True)
    (root / "solver_runtime" / "scripts" / "solve_stdio.py").write_text("pass\n")
    (root / "solver_runtime" / "scripts" / "wsl_solve.py").write_text("pass\n")
    (root / "solver_runtime" / "scripts" / "wsl_cancel.py").write_text("pass\n")
    (root / "solver_runtime" / "requirements-wsl.txt").write_text("ortools==9.15.6755\n")
    hints = root / "solver_runtime" / "src" / "tkb_optimizer_ref"
    hints.mkdir(parents=True)
    for name in (
        "base_179_session_hint.json",
        "base_179_session_hint_gap3.json",
        "base_180_gap0_period_hint.json",
        "base_180_session_hint.json",
        "base_181_session_hint.json",
        "base_184_hint.json",
    ):
        (hints / name).write_text("{}\n")


class WslSetupTests(unittest.TestCase):
    def test_missing_firmware_virtualization_selects_wsl1(self) -> None:
        kernel32 = MagicMock()
        kernel32.IsProcessorFeaturePresent.return_value = False
        with patch(
            "agent_helper.wsl_setup.ctypes.WinDLL",
            return_value=kernel32,
            create=True,
        ):
            self.assertEqual(_preferred_wsl_version(platform_name="nt"), 1)

    def test_firmware_virtualization_selects_wsl2(self) -> None:
        kernel32 = MagicMock()
        kernel32.IsProcessorFeaturePresent.side_effect = lambda feature: feature in {20, 21}
        with patch(
            "agent_helper.wsl_setup.ctypes.WinDLL",
            return_value=kernel32,
            create=True,
        ):
            self.assertEqual(_preferred_wsl_version(platform_name="nt"), 2)

    def test_non_windows_defaults_to_wsl2(self) -> None:
        self.assertEqual(_preferred_wsl_version(platform_name="posix"), 2)

    def test_winget_uses_registered_windows_apps_alias_from_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            local_app_data = Path(temporary)
            alias = local_app_data / "Microsoft" / "WindowsApps" / "winget.exe"
            alias.parent.mkdir(parents=True)
            alias.touch()
            with (
                patch.dict(
                    "agent_helper.wsl_setup.os.environ",
                    {"LOCALAPPDATA": str(local_app_data)},
                    clear=True,
                ),
                patch(
                    "agent_helper.wsl_setup.shutil.which",
                    return_value=str(alias),
                ) as which,
            ):
                located = _winget_executable(platform_name="nt")

        self.assertEqual(located, str(alias))
        which.assert_called_once_with("winget.exe")

    def test_missing_source_is_rejected_before_wsl_is_called(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(WslSetupError):
                install_wsl_runtime(
                    source_root=Path(temporary),
                    executable="wsl.exe",
                    platform_name="posix",
                )

    def test_installed_distribution_receives_script_over_stdin(self) -> None:
        calls: list[tuple[list[str], bytes | None]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            data = options.get("input")
            calls.append((command, data if isinstance(data, bytes) else None))
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(command, 0, b"TKBCherryAgent\n", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[0])
        install_calls = [call for call in calls if "bash" in call[0]]
        self.assertEqual(len(install_calls), 1)
        command, script = install_calls[0]
        self.assertIn("root", command)
        self.assertNotIn("TKB_AGENT_TOKEN", command)
        self.assertIsNotNone(script)
        assert script is not None
        self.assertIn(b"python3 -m venv", script)

    def test_new_distribution_can_request_restart_without_running_installer(self) -> None:
        list_count = 0

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal list_count
            del options
            if command[1:3] == ["--list", "--quiet"]:
                list_count += 1
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if command[1:3] == ["--install", "--distribution"]:
                return subprocess.CompletedProcess(command, 0, b"restart", b"")
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        self.assertEqual(list_count, 2)
        self.assertTrue(result.restart_required)
        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[0])

    def test_new_distribution_uses_private_name_and_direct_download(self) -> None:
        commands: list[list[str]] = []
        list_count = 0

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal list_count
            del options
            commands.append(command)
            if command[1:3] == ["--list", "--quiet"]:
                list_count += 1
                output = b"" if list_count == 1 else b"TKBCherryAgent\n"
                return subprocess.CompletedProcess(command, 0, output, b"")
            if command[1:3] == ["--install", "--distribution"]:
                return subprocess.CompletedProcess(command, 0, b"installed", b"")
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        install_command = next(command for command in commands if "--install" in command)
        self.assertEqual(
            install_command[install_command.index("--name") + 1],
            WSL_MANAGED_DISTRIBUTIONS[0],
        )
        self.assertIn("--web-download", install_command)
        self.assertIn("--no-launch", install_command)
        self.assertEqual(
            install_command[install_command.index("--version") + 1], "2"
        )
        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[0])

    def test_unrelated_docker_distribution_is_never_modified(self) -> None:
        commands: list[list[str]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            commands.append(command)
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(command, 0, b"docker-desktop\n", b"")
            if command[1:3] == ["--install", "--distribution"]:
                return subprocess.CompletedProcess(command, 0, b"restart", b"")
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        self.assertTrue(result.restart_required)
        self.assertTrue(any("--install" in command for command in commands))
        self.assertFalse(any("bash" in command for command in commands))

    def test_personal_ubuntu_and_docker_are_not_modified(self) -> None:
        commands: list[list[str]] = []
        list_count = 0

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal list_count
            del options
            commands.append(command)
            if command[1:3] == ["--list", "--quiet"]:
                list_count += 1
                output = (
                    b"Ubuntu\ndocker-desktop\n"
                    if list_count == 1
                    else b"Ubuntu\ndocker-desktop\nTKBCherryAgent\n"
                )
                return subprocess.CompletedProcess(command, 0, output, b"")
            if command[1:3] == ["--install", "--distribution"]:
                return subprocess.CompletedProcess(command, 0, b"installed", b"")
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        bash_command = next(command for command in commands if "bash" in command)
        self.assertEqual(
            bash_command[bash_command.index("--distribution") + 1],
            WSL_MANAGED_DISTRIBUTIONS[0],
        )
        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[0])
        self.assertFalse(
            any(
                "bash" in command
                and command[command.index("--distribution") + 1]
                in {"Ubuntu", "docker-desktop"}
                for command in commands
            )
        )

    def test_hidden_name_collision_retries_secondary_private_name(self) -> None:
        commands: list[list[str]] = []
        list_count = 0
        install_count = 0

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal install_count, list_count
            del options
            commands.append(command)
            if command[1:3] == ["--list", "--quiet"]:
                list_count += 1
                output = (
                    b"TKBCherryAgent-2\n"
                    if install_count >= 2
                    else b""
                )
                return subprocess.CompletedProcess(command, 0, output, b"")
            if command[1:3] == ["--install", "--distribution"]:
                install_count += 1
                if install_count == 1:
                    return subprocess.CompletedProcess(
                        command,
                        0xFFFFFFFF,
                        (
                            "A distribution with the supplied name already exists. "
                            "Error code: Wsl/InstallDistro/ERROR_ALREADY_EXISTS"
                        ).encode("utf-16-le"),
                        b"",
                    )
                return subprocess.CompletedProcess(command, 0, b"installed", b"")
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        installs = [command for command in commands if "--install" in command]
        self.assertEqual(len(installs), 2)
        self.assertEqual(
            [command[command.index("--name") + 1] for command in installs],
            list(WSL_MANAGED_DISTRIBUTIONS),
        )
        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[1])

    def test_missing_source_falls_back_to_other_official_distribution(self) -> None:
        commands: list[list[str]] = []
        active_distribution = ""

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal active_distribution
            del options
            commands.append(command)
            if command[1:3] == ["--list", "--quiet"]:
                output = b"TKBCherryAgent\n" if active_distribution else b""
                return subprocess.CompletedProcess(command, 0, output, b"")
            if command[1:3] == ["--install", "--distribution"]:
                source_name = command[command.index("--distribution") + 1]
                if source_name == DEFAULT_DISTRIBUTION:
                    return subprocess.CompletedProcess(
                        command,
                        0xFFFFFFFF,
                        "Error code: Wsl/InstallDistro/WSL_E_DISTRO_NOT_FOUND".encode(
                            "utf-16-le"
                        ),
                        b"",
                    )
                active_distribution = source_name
                return subprocess.CompletedProcess(command, 0, b"installed", b"")
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="posix",
            )

        installs = [command for command in commands if "--install" in command]
        self.assertEqual(
            [command[command.index("--distribution") + 1] for command in installs],
            [DEFAULT_DISTRIBUTION, "Ubuntu"],
        )
        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[0])

    def test_disabled_wsl_feature_is_enabled_before_any_wsl_probe(self) -> None:
        commands: list[list[str]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            commands.append(command)
            if "/Get-FeatureInfo" in command:
                state = (
                    "Disabled"
                    if "/FeatureName:Microsoft-Windows-Subsystem-Linux" in command
                    else "Enabled"
                )
                return subprocess.CompletedProcess(
                    command, 0, f"State : {state}\r\n".encode(), b""
                )
            if "/Enable-Feature" in command:
                return subprocess.CompletedProcess(command, 0, b"ok", b"")
            self.fail(f"WSL must not run before restart: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="nt",
                dism_executable="dism.exe",
            )

        self.assertTrue(result.restart_required)
        self.assertEqual(
            sum("/Enable-Feature" in command for command in commands),
            1,
        )
        self.assertFalse(any(command[0] == "wsl.exe" for command in commands))

    def test_pending_feature_requests_restart_without_enable_or_wsl(self) -> None:
        commands: list[list[str]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            commands.append(command)
            if "/Get-FeatureInfo" in command:
                state = (
                    "Enable Pending"
                    if "/FeatureName:Microsoft-Windows-Subsystem-Linux" in command
                    else "Enabled"
                )
                return subprocess.CompletedProcess(
                    command, 0, f"State : {state}\r\n".encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source,
                executable="wsl.exe",
                run=run,
                platform_name="nt",
                dism_executable="dism.exe",
            )

        self.assertTrue(result.restart_required)
        self.assertFalse(any("/Enable-Feature" in command for command in commands))
        self.assertFalse(any(command[0] == "wsl.exe" for command in commands))

    def test_feature_failure_exposes_bounded_redacted_diagnostic(self) -> None:
        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            return subprocess.CompletedProcess(
                command,
                5,
                b"",
                b"Access denied for tkba_1234567890abcdef at C:\\Users\\Example",
            )

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with patch.dict("os.environ", {"USERPROFILE": r"C:\Users\Example"}):
                with self.assertRaises(WslSetupError) as raised:
                    install_wsl_runtime(
                        source_root=source,
                        executable="wsl.exe",
                        run=run,
                        platform_name="nt",
                        dism_executable="dism.exe",
                    )

        rendered = str(raised.exception)
        self.assertIn("trả mã 5", rendered)
        self.assertIn("<redacted-token>", rendered)
        self.assertIn("<user-path>", rendered)
        self.assertNotIn("tkba_1234567890abcdef", rendered)
        self.assertNotIn(r"C:\Users\Example", rendered)

    def test_wsl_list_timeout_is_specific_and_bounded(self) -> None:
        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            raise subprocess.TimeoutExpired(command, options.get("timeout", 0))

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with self.assertRaises(WslSetupError) as raised:
                install_wsl_runtime(
                    source_root=source,
                    executable="wsl.exe",
                    run=run,
                    platform_name="posix",
                )

        self.assertIn("Kiểm tra môi trường WSL", str(raised.exception))
        self.assertIn("15 giây", str(raised.exception))

    def test_healthy_wsl_probe_never_repairs_store_package(self) -> None:
        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            if "/Get-FeatureInfo" in command:
                return subprocess.CompletedProcess(
                    command, 0, b"State : Enabled\r\n", b""
                )
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(
                    command, 0, b"TKBCherryAgent\n", b""
                )
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with patch(
                "agent_helper.wsl_setup._repair_wsl_store_package"
            ) as repair:
                result = install_wsl_runtime(
                    source_root=source,
                    executable="wsl.exe",
                    run=run,
                    platform_name="nt",
                    dism_executable="dism.exe",
                )

        self.assertEqual(result.distribution, "TKBCherryAgent")
        repair.assert_not_called()

    def test_wsl_timeout_repairs_official_package_once_then_resumes_setup(self) -> None:
        commands: list[tuple[list[str], float]] = []
        list_count = 0

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal list_count
            commands.append((command, float(options.get("timeout", 0))))
            if "/Get-FeatureInfo" in command:
                return subprocess.CompletedProcess(
                    command, 0, b"State : Enabled\r\n", b""
                )
            if command[0] == "wsl.exe" and command[1:3] == ["--list", "--quiet"]:
                list_count += 1
                if list_count == 1:
                    raise subprocess.TimeoutExpired(command, options.get("timeout", 0))
                return subprocess.CompletedProcess(command, 0, b"TKBCherryAgent\n", b"")
            if command[0] == "winget.exe":
                return subprocess.CompletedProcess(command, 0, b"repaired", b"")
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with patch(
                "agent_helper.wsl_setup._winget_executable",
                return_value="winget.exe",
            ):
                result = install_wsl_runtime(
                    source_root=source,
                    executable="wsl.exe",
                    run=run,
                    platform_name="nt",
                    dism_executable="dism.exe",
                )

        self.assertEqual(result.distribution, "TKBCherryAgent")
        repair_calls = [entry for entry in commands if entry[0][0] == "winget.exe"]
        self.assertEqual(len(repair_calls), 1)
        repair_command, repair_timeout = repair_calls[0]
        self.assertEqual(repair_command[1], "install")
        self.assertIn("Microsoft.WSL", repair_command)
        self.assertIn("--exact", repair_command)
        self.assertEqual(
            repair_command[repair_command.index("--source") + 1], "winget"
        )
        self.assertIn("--silent", repair_command)
        self.assertIn("--disable-interactivity", repair_command)
        self.assertIn("--accept-package-agreements", repair_command)
        self.assertIn("--accept-source-agreements", repair_command)
        self.assertIn("--force", repair_command)
        self.assertEqual(repair_timeout, 15 * 60)

    def test_old_responsive_wsl_is_updated_before_private_install(self) -> None:
        commands: list[list[str]] = []
        help_count = 0
        installed = False

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            nonlocal help_count, installed
            del options
            commands.append(command)
            if "/Get-FeatureInfo" in command:
                return subprocess.CompletedProcess(
                    command, 0, b"State : Enabled\r\n", b""
                )
            if command[0] == "wsl.exe" and command[1:3] == ["--list", "--quiet"]:
                output = b"TKBCherryAgent\n" if installed else b""
                return subprocess.CompletedProcess(command, 0, output, b"")
            if command[0] == "wsl.exe" and command[1:] == ["--help"]:
                help_count += 1
                help_text = (
                    "--install --distribution --name --web-download"
                    if help_count >= 2
                    else "--install --distribution"
                )
                return subprocess.CompletedProcess(
                    command, 0, help_text.encode("utf-16-le"), b""
                )
            if command[0] == "winget.exe":
                return subprocess.CompletedProcess(command, 0, b"updated", b"")
            if command[1:3] == ["--install", "--distribution"]:
                installed = True
                return subprocess.CompletedProcess(command, 0, b"installed", b"")
            if "bash" in command:
                return subprocess.CompletedProcess(command, 0, b"", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with (
                patch(
                    "agent_helper.wsl_setup._winget_executable",
                    return_value="winget.exe",
                ),
                patch(
                    "agent_helper.wsl_setup._preferred_wsl_version",
                    return_value=1,
                ),
            ):
                result = install_wsl_runtime(
                    source_root=source,
                    executable="wsl.exe",
                    run=run,
                    platform_name="nt",
                    dism_executable="dism.exe",
                )

        repair_index = next(
            index for index, command in enumerate(commands) if command[0] == "winget.exe"
        )
        install_index = next(
            index for index, command in enumerate(commands) if "--install" in command
        )
        self.assertLess(repair_index, install_index)
        self.assertEqual(help_count, 2)
        self.assertEqual(result.distribution, WSL_MANAGED_DISTRIBUTIONS[0])

    def test_wsl_probe_and_official_package_repair_failure_are_diagnostic(self) -> None:
        commands: list[list[str]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            commands.append(command)
            if "/Get-FeatureInfo" in command:
                return subprocess.CompletedProcess(
                    command,
                    0,
                    b"State : Enabled\r\n",
                    b"",
                )
            if command[0] == "wsl.exe":
                return subprocess.CompletedProcess(
                    command,
                    2,
                    b"",
                    b"WSL service is not ready",
                )
            if command[0] == "winget.exe":
                return subprocess.CompletedProcess(
                    command,
                    1603,
                    b"",
                    b"Microsoft.WSL repair failed",
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with (
                patch(
                    "agent_helper.wsl_setup._winget_executable",
                    return_value="winget.exe",
                ),
                self.assertRaises(WslSetupError) as raised,
            ):
                install_wsl_runtime(
                    source_root=source,
                    executable="wsl.exe",
                    run=run,
                    platform_name="nt",
                    dism_executable="dism.exe",
                )

        rendered = str(raised.exception)
        self.assertIn("không thể tự sửa gói WSL", rendered)
        self.assertIn("wsl --list trả mã 2", rendered)
        self.assertIn("WSL service is not ready", rendered)
        self.assertIn("winget Microsoft.WSL trả mã 1603", rendered)
        self.assertIn("Microsoft.WSL repair failed", rendered)
        self.assertEqual(sum(command[0] == "winget.exe" for command in commands), 1)

    def test_broken_wsl_without_winget_has_clear_failure(self) -> None:
        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            if "/Get-FeatureInfo" in command:
                return subprocess.CompletedProcess(
                    command, 0, b"State : Enabled\r\n", b""
                )
            if command[0] == "wsl.exe":
                return subprocess.CompletedProcess(
                    command, 2, b"", b"WSL service is not ready"
                )
            self.fail(f"unexpected command: {command}")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            with (
                patch(
                    "agent_helper.wsl_setup._winget_executable",
                    return_value=None,
                ),
                self.assertRaises(WslSetupError) as raised,
            ):
                install_wsl_runtime(
                    source_root=source,
                    executable="wsl.exe",
                    run=run,
                    platform_name="nt",
                    dism_executable="dism.exe",
                )

        rendered = str(raised.exception)
        self.assertIn("không thể tự sửa gói WSL", rendered)
        self.assertIn("Không tìm thấy winget.exe", rendered)
        self.assertIn("WSL service is not ready", rendered)

    def test_setup_report_round_trip_is_bounded(self) -> None:
        result_id = "a" * 32
        with tempfile.TemporaryDirectory() as temporary:
            with patch(
                "agent_helper.wsl_setup._setup_result_root",
                return_value=Path(temporary),
            ):
                _write_setup_report(
                    result_id,
                    SetupReport(
                        SETUP_FAILED,
                        "Không cài được.",
                        "D" * 5000,
                    ),
                )
                report = _read_setup_report(result_id)

        self.assertIsNotNone(report)
        assert report is not None
        self.assertEqual(report.code, SETUP_FAILED)
        self.assertEqual(report.message, "Không cài được.")
        self.assertEqual(len(report.diagnostic), 1200)

    def test_setup_cli_persists_restart_result_for_parent_gui(self) -> None:
        result_id = "b" * 32
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch(
                    "agent_helper.wsl_setup._setup_result_root",
                    return_value=Path(temporary),
                ),
                patch(
                    "agent_helper.wsl_setup.install_wsl_runtime",
                    return_value=WslSetupResult(
                        DEFAULT_DISTRIBUTION,
                        restart_required=True,
                    ),
                ),
            ):
                code = setup_cli(result_id)
                report = _read_setup_report(result_id)

        self.assertEqual(code, SETUP_RESTART_REQUIRED)
        self.assertIsNotNone(report)
        assert report is not None
        self.assertTrue(report.restart_required)
        self.assertIn("khởi động lại", report.message)

    def test_elevated_cli_forwards_opaque_result_id(self) -> None:
        from agent_helper.__main__ import main

        result_id = "c" * 32
        with patch(
            "agent_helper.wsl_setup.setup_cli",
            return_value=SETUP_RESTART_REQUIRED,
        ) as setup:
            code = main(
                [
                    "--wsl-setup",
                    "--wsl-setup-result",
                    result_id,
                ]
            )

        self.assertEqual(code, SETUP_RESTART_REQUIRED)
        setup.assert_called_once_with(result_id)


if __name__ == "__main__":
    unittest.main()
