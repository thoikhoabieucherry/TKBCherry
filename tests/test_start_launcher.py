from __future__ import annotations

import argparse
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import start


class FakeProcess:
    def __init__(self, pid: int = 1001, returncode: int | None = None) -> None:
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
        no_launcher=True,
        no_stop_old=True,
    )


class WebLauncherTests(unittest.TestCase):
    def test_default_address_is_local_port_1010(self) -> None:
        with patch.dict(start.os.environ, {}, clear=True):
            args = start.parse_args([])
        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.port, 1010)

    def test_executable_candidates_contain_only_local_builds(self) -> None:
        self.assertEqual(
            start.executable_candidates(),
            (start.RUST_RELEASE_EXE, start.RUST_DEBUG_EXE),
        )

    def test_fresh_release_is_reused_without_invoking_cargo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rust_dir = Path(tmp) / "rust_api"
            release = rust_dir / "target" / "release" / "tkb_rust_api.exe"
            release.parent.mkdir(parents=True)
            release.write_bytes(b"web-server")
            with (
                patch.object(start, "RUST_DIR", rust_dir),
                patch.object(start, "RUST_RELEASE_EXE", release),
                patch.object(start, "RUST_DEBUG_EXE", rust_dir / "missing.exe"),
                patch.object(start, "executable_is_stale", return_value=False),
                patch.object(start, "cargo_candidates") as cargo_candidates,
            ):
                selected = start.build_backend_if_needed()
            self.assertEqual(selected, release)
            cargo_candidates.assert_not_called()

    def test_backend_build_uses_locked_release_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rust_dir = Path(tmp) / "rust_api"
            release = rust_dir / "target" / "release" / "tkb_rust_api.exe"
            debug = rust_dir / "target" / "debug" / "tkb_rust_api.exe"
            rust_dir.mkdir(parents=True)
            (rust_dir / "Cargo.toml").write_text("[package]\nname='test'\n", encoding="ascii")

            def run_build(command, **_kwargs):
                release.parent.mkdir(parents=True)
                release.write_bytes(b"built")
                self.assertIn("--release", command)
                self.assertIn("--locked", command)
                return subprocess.CompletedProcess(command, 0, stdout="")

            with (
                patch.object(start, "RUST_DIR", rust_dir),
                patch.object(start, "RUST_RELEASE_EXE", release),
                patch.object(start, "RUST_DEBUG_EXE", debug),
                patch.object(start, "cargo_candidates", return_value=["cargo"]),
                patch.object(start.subprocess, "run", side_effect=run_build),
            ):
                selected = start.build_backend_if_needed()
            self.assertEqual(selected, release)

    def test_health_identity_requires_browser_fet_and_matching_web_root(self) -> None:
        payload = {
            "ok": True,
            "api": "rust",
            "engine": "fet-web-worker",
            "webRoot": str(start.WEB_ROOT),
        }
        with patch.object(start, "health_payload", return_value=payload):
            self.assertTrue(start.server_is_ready("http://127.0.0.1:1010"))
        payload["engine"] = "unexpected"
        with patch.object(start, "health_payload", return_value=payload):
            self.assertFalse(start.server_is_ready("http://127.0.0.1:1010"))

    def test_start_backend_sets_only_web_server_runtime_values(self) -> None:
        process = FakeProcess()
        executable = Path("C:/tmp/tkb_rust_api.exe")
        captured_env: dict[str, str] = {}

        def launch(_executable, env, _foreground):
            captured_env.update(env)
            return process

        with (
            patch.object(start, "build_backend_if_needed", return_value=executable),
            patch.object(start, "ensure_sqlite_runtime"),
            patch.object(start, "start_process", side_effect=launch),
            patch.object(start, "wait_until_ready", return_value=True),
        ):
            selected_process, url, selected_executable = start.start_backend(backend_args())

        self.assertIs(selected_process, process)
        self.assertEqual(url, "http://127.0.0.1:1010")
        self.assertEqual(selected_executable, executable)
        self.assertEqual(captured_env["TKB_RUST_HOST"], "127.0.0.1")
        self.assertEqual(captured_env["TKB_RUST_PORT"], "1010")
        self.assertEqual(captured_env["TKB_NO_LOGS"], "1")
        self.assertFalse(any(key.startswith("TKB_SOLVER_") for key in captured_env))

    def test_failed_health_check_stops_the_started_process(self) -> None:
        process = FakeProcess()
        args = backend_args()
        with (
            patch.object(start, "build_backend_if_needed", return_value=Path("server.exe")),
            patch.object(start, "ensure_sqlite_runtime"),
            patch.object(start, "start_process", return_value=process),
            patch.object(start, "wait_until_ready", return_value=False),
            patch.object(start, "stop_backend_process") as stop_process,
        ):
            with self.assertRaisesRegex(RuntimeError, "/api/health"):
                start.start_backend(args)
        stop_process.assert_called_once_with(process, 1010)


if __name__ == "__main__":
    unittest.main()
