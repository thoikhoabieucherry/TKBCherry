from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

import start


class FakeProcess:
    def __init__(self, pid: int, returncode: int | None = None) -> None:
        self.pid = pid
        self.returncode = returncode

    def poll(self) -> int | None:
        return self.returncode


def backend_args() -> argparse.Namespace:
    return argparse.Namespace(
        host="127.0.0.1",
        port=1010,
        timeout=1,
        foreground=False,
        no_browser=True,
        no_stop_old=True,
    )


class RustLauncherTests(unittest.TestCase):
    def test_frozen_launcher_uses_external_python_for_solver(self) -> None:
        with (
            patch.object(start.sys, "frozen", True, create=True),
            patch.object(start.shutil, "which", side_effect=lambda name: "C:/Python/python.exe" if name == "python" else None),
            patch.dict(start.os.environ, {}, clear=True),
        ):
            self.assertEqual(start.reference_python_executable(), "C:/Python/python.exe")

    def test_solver_resource_limits_balance_local_cpu(self) -> None:
        self.assertEqual(start.solver_resource_limits({}, cpu_count=4), (1, 4))
        self.assertEqual(start.solver_resource_limits({}, cpu_count=8), (2, 4))
        self.assertEqual(start.solver_resource_limits({}, cpu_count=12), (3, 4))
        self.assertEqual(start.solver_resource_limits({}, cpu_count=22), (4, 5))

    def test_solver_resource_limits_honor_explicit_environment(self) -> None:
        limits = start.solver_resource_limits(
            {
                "TKB_SOLVER_MAX_CONCURRENT": "2",
                "TKB_SOLVER_MAX_WORKERS": "3",
            },
            cpu_count=32,
        )
        self.assertEqual(limits, (2, 3))

    def test_successful_gnu_build_does_not_overwrite_release_before_health(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rust_dir = Path(tmp) / "rust_api"
            release = rust_dir / "target" / "release" / "tkb_rust_api.exe"
            gnu = rust_dir / "target-gnu" / "release" / "tkb_rust_api.exe"
            release.parent.mkdir(parents=True)
            gnu.parent.mkdir(parents=True)
            (rust_dir / "Cargo.toml").write_text("[package]\nname='test'\n", encoding="ascii")
            release.write_bytes(b"known-good-release")
            gnu.write_bytes(b"unverified-gnu")

            with (
                patch.object(start, "RUST_DIR", rust_dir),
                patch.object(start, "RUST_RELEASE_EXE", release),
                patch.object(start, "RUST_CODEX_GNU_DIR", gnu.parents[1]),
                patch.object(start, "RUST_CODEX_GNU_EXE", gnu),
                patch.object(start, "fresh_rust_exe", return_value=None),
                patch.object(start, "rust_exe", return_value=release),
                patch.object(start, "rust_exe_is_stale", return_value=True),
                patch.object(start, "gnu_toolchain", return_value=("cargo", "rustc")),
                patch.object(start, "rust_build_env", return_value={}),
                patch.object(start, "run_build_command", return_value=(0, "")),
            ):
                selected = start.build_rust_release_if_needed()

            self.assertEqual(selected, gnu)
            self.assertEqual(release.read_bytes(), b"known-good-release")

    def test_failed_isolated_gnu_build_is_not_retried_into_release_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rust_dir = Path(tmp) / "rust_api"
            release = rust_dir / "target" / "release" / "tkb_rust_api.exe"
            release.parent.mkdir(parents=True)
            (rust_dir / "Cargo.toml").write_text("[package]\nname='test'\n", encoding="ascii")
            release.write_bytes(b"known-good-release")
            cargo = str(Path(tmp) / "gnu" / "cargo.exe")
            run_build = Mock(return_value=(1, "link failed"))

            with (
                patch.object(start, "RUST_DIR", rust_dir),
                patch.object(start, "RUST_RELEASE_EXE", release),
                patch.object(start, "fresh_rust_exe", return_value=None),
                patch.object(start, "rust_exe", return_value=release),
                patch.object(start, "rust_exe_is_stale", return_value=True),
                patch.object(start, "gnu_toolchain", return_value=(cargo, "rustc")),
                patch.object(start, "cargo_candidates", return_value=[cargo]),
                patch.object(start, "rust_build_env", return_value={}),
                patch.object(start, "run_build_command", run_build),
            ):
                selected = start.build_rust_release_if_needed()

            self.assertEqual(selected, release)
            self.assertEqual(run_build.call_count, 1)
            self.assertIn("--target-dir", run_build.call_args.args[0])
            self.assertEqual(release.read_bytes(), b"known-good-release")

    def test_backend_falls_back_to_stale_release_when_new_gnu_fails_health(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = root / "target" / "release" / "tkb_rust_api.exe"
            gnu = root / "target-gnu" / "release" / "tkb_rust_api.exe"
            prebuilt = root / "prebuilt" / "tkb_rust_api.exe"
            debug = root / "target" / "debug" / "tkb_rust_api.exe"
            release.parent.mkdir(parents=True)
            gnu.parent.mkdir(parents=True)
            release.write_bytes(b"stale-but-good")
            gnu.write_bytes(b"new-but-broken")

            bad_proc = FakeProcess(1001, returncode=23)
            good_proc = FakeProcess(1002)
            start_server = Mock(side_effect=[bad_proc, good_proc])

            with (
                patch.object(start, "RUST_RELEASE_EXE", release),
                patch.object(start, "RUST_CODEX_GNU_EXE", gnu),
                patch.object(start, "RUST_PREBUILT_EXE", prebuilt),
                patch.object(start, "RUST_DEBUG_EXE", debug),
                patch.object(start, "build_rust_release_if_needed", return_value=gnu),
                patch.object(start, "python_solver_deps_status", return_value=(False, "not installed")),
                patch.object(start, "ensure_sqlite_runtime") as ensure_runtime,
                patch.object(start, "start_server", start_server),
                patch.object(start, "wait_until_ready", side_effect=[False, True]),
                patch.object(start, "stop_backend_process") as stop_failed,
                patch.object(start, "solve_endpoint_smoke", return_value=True),
            ):
                proc, url, selected = start.start_backend(backend_args())

            self.assertIs(proc, good_proc)
            self.assertEqual(url, "http://127.0.0.1:1010")
            self.assertEqual(selected, release)
            self.assertEqual([item.args[0] for item in start_server.call_args_list], [gnu, release])
            self.assertEqual(ensure_runtime.call_args_list, [call(gnu), call(release)])
            stop_failed.assert_called_once_with(bad_proc, 1010)

    def test_backend_falls_back_when_primary_cannot_be_spawned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = root / "release.exe"
            gnu = root / "gnu.exe"
            release.write_bytes(b"release")
            gnu.write_bytes(b"gnu")
            good_proc = FakeProcess(2002)
            start_server = Mock(side_effect=[OSError("bad executable"), good_proc])

            with (
                patch.object(start, "RUST_RELEASE_EXE", release),
                patch.object(start, "RUST_CODEX_GNU_EXE", gnu),
                patch.object(start, "RUST_PREBUILT_EXE", root / "missing-prebuilt.exe"),
                patch.object(start, "RUST_DEBUG_EXE", root / "missing-debug.exe"),
                patch.object(start, "build_rust_release_if_needed", return_value=gnu),
                patch.object(start, "python_solver_deps_status", return_value=(False, "not installed")),
                patch.object(start, "ensure_sqlite_runtime"),
                patch.object(start, "start_server", start_server),
                patch.object(start, "wait_until_ready", return_value=True),
                patch.object(start, "solve_endpoint_smoke", return_value=True),
            ):
                proc, _url, selected = start.start_backend(backend_args())

            self.assertIs(proc, good_proc)
            self.assertEqual(selected, release)
            self.assertEqual([item.args[0] for item in start_server.call_args_list], [gnu, release])


if __name__ == "__main__":
    unittest.main()
