from __future__ import annotations

import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agent_helper.solver import SolverRunner
from agent_helper.wsl_solver import (
    WSL_ENVIRONMENT_NAMES,
    WslRuntime,
    WslSolverRunner,
    discover_wsl_runtime,
    parse_wsl_distributions,
)
from agent_helper.wsl_solver import WSL_RUNTIME_VERSION


class WslSolverTests(unittest.TestCase):
    def test_distribution_output_accepts_utf8_and_utf16(self) -> None:
        self.assertEqual(
            parse_wsl_distributions("Ubuntu-24.04\nDebian\n".encode()),
            ["Ubuntu-24.04", "Debian"],
        )
        self.assertEqual(
            parse_wsl_distributions("Ubuntu\r\nDebian\r\n".encode("utf-16")),
            ["Ubuntu", "Debian"],
        )

    def test_discovery_prefers_dedicated_ready_runtime(self) -> None:
        commands: list[list[str]] = []

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            commands.append(command)
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(command, 0, b"Ubuntu\nTKBCherryAgent\n", b"")
            ready = command[command.index("--distribution") + 1] == "TKBCherryAgent"
            return subprocess.CompletedProcess(
                command,
                0 if ready else 1,
                WSL_RUNTIME_VERSION.encode() if ready else b"",
                b"",
            )

        runtime = discover_wsl_runtime(executable="wsl.exe", run=run)

        self.assertIsNotNone(runtime)
        assert runtime is not None
        self.assertEqual(runtime.distribution, "TKBCherryAgent")
        self.assertEqual(commands[1][1:4], ["--distribution", "TKBCherryAgent", "--user"])

    def test_discovery_returns_none_when_runtime_is_not_ready(self) -> None:
        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(command, 0, b"Ubuntu\n", b"")
            return subprocess.CompletedProcess(command, 1, b"", b"missing")

        self.assertIsNone(discover_wsl_runtime(executable="wsl.exe", run=run))

    def test_discovery_accepts_secondary_dedicated_runtime(self) -> None:
        def run(command: list[str], **options: object) -> subprocess.CompletedProcess[bytes]:
            del options
            if command[1:3] == ["--list", "--quiet"]:
                return subprocess.CompletedProcess(
                    command, 0, b"Ubuntu\nTKBCherryAgent-2\n", b""
                )
            selected = command[command.index("--distribution") + 1]
            return subprocess.CompletedProcess(
                command,
                0 if selected == "TKBCherryAgent-2" else 1,
                WSL_RUNTIME_VERSION.encode() if selected == "TKBCherryAgent-2" else b"",
                b"",
            )

        runtime = discover_wsl_runtime(executable="wsl.exe", run=run)

        self.assertIsNotNone(runtime)
        assert runtime is not None
        self.assertEqual(runtime.distribution, "TKBCherryAgent-2")

    def test_runner_passes_only_solver_limits_through_wslenv(self) -> None:
        config = SimpleNamespace(
            heartbeat_seconds=2,
            max_memory_mb=8192,
            solver_timeout_seconds=240,
        )
        runtime = WslRuntime("wsl.exe", "TKBCherryAgent")
        runner = WslSolverRunner(config, runtime)

        command, _cwd = runner._command_and_cwd()
        environment = runner._solver_environment(6, 6144)

        self.assertEqual(command[:5], ["wsl.exe", "--distribution", "TKBCherryAgent", "--user", "tkb-agent"])
        self.assertEqual(environment["TKB_SOLVER_MAX_WORKERS"], "6")
        self.assertEqual(environment["TKB_SOLVER_MAX_MEMORY_MB"], "6144")
        self.assertEqual(set(environment["WSLENV"].split(":")), set(WSL_ENVIRONMENT_NAMES))
        self.assertNotIn("TKB_AGENT_TOKEN", environment)

    def test_terminating_windows_relay_first_cancels_exact_linux_run(self) -> None:
        config = SimpleNamespace(
            heartbeat_seconds=2,
            max_memory_mb=8192,
            solver_timeout_seconds=240,
        )
        runtime = WslRuntime("wsl.exe", "TKBCherryAgent")
        runner = WslSolverRunner(config, runtime)
        runner._run_context.run_id = "a" * 32
        process = SimpleNamespace()
        job = SimpleNamespace()

        with (
            patch("agent_helper.wsl_solver.subprocess.run") as cancel,
            patch.object(SolverRunner, "_terminate_child") as terminate_relay,
        ):
            runner._terminate_child(process, job)  # type: ignore[arg-type]

        command = cancel.call_args.args[0]
        self.assertTrue(any(value.endswith("/wsl_cancel.pyc") for value in command))
        self.assertEqual(command[-1], "a" * 32)
        self.assertNotIn("TKB_AGENT_TOKEN", command)
        terminate_relay.assert_called_once_with(process, job)


if __name__ == "__main__":
    unittest.main()
