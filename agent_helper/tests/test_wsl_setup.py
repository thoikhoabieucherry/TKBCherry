from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from agent_helper.wsl_setup import (
    DEFAULT_DISTRIBUTION,
    WslSetupError,
    install_wsl_runtime,
)
from agent_helper.wsl_solver import WSL_RUNTIME_VERSION


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
    def test_missing_source_is_rejected_before_wsl_is_called(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(WslSetupError):
                install_wsl_runtime(
                    source_root=Path(temporary), executable="wsl.exe"
                )

    def test_installed_distribution_receives_script_over_stdin(self) -> None:
        calls: list[tuple[list[str], bytes | None]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            data = options.get("input")
            calls.append((command, data if isinstance(data, bytes) else None))
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(command, 0, b"Ubuntu-24.04\n", b"")
            if "cat" in command:
                return subprocess.CompletedProcess(
                    command, 0, WSL_RUNTIME_VERSION.encode(), b""
                )
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            make_source(source)
            result = install_wsl_runtime(
                source_root=source, executable="wsl.exe", run=run
            )

        self.assertEqual(result.distribution, DEFAULT_DISTRIBUTION)
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
                source_root=source, executable="wsl.exe", run=run
            )

        self.assertEqual(list_count, 2)
        self.assertTrue(result.restart_required)

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
                source_root=source, executable="wsl.exe", run=run
            )

        self.assertTrue(result.restart_required)
        self.assertTrue(any("--install" in command for command in commands))
        self.assertFalse(any("bash" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
