from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agent_helper.relocation import maybe_relaunch_from_install_dir


class RelocationTests(unittest.TestCase):
    def test_source_and_headless_runs_are_not_relocated(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for args, frozen in (
                ((), False),
                (("--check",), True),
                (("--once",), True),
                (("--gui-smoke",), True),
                (("--wsl-setup",), True),
            ):
                spawned: list[object] = []
                self.assertTrue(
                    maybe_relaunch_from_install_dir(
                        args,
                        executable=root / "download" / "TKBCherryAgent.exe",
                        frozen=frozen,
                        platform_name="nt",
                        install_dir=root / "C-TKBCherryAgent",
                        fallback_dir=root / "fallback",
                        spawn_process=lambda *a, **k: spawned.append((a, k)),
                    )
                )
                self.assertEqual(spawned, [])

    def test_packaged_gui_copies_and_relaunches_from_preferred_directory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "Downloads" / "TKBCherryAgent.exe"
            source.parent.mkdir()
            source.write_bytes(b"agent-binary")
            spawned: list[tuple[object, dict[str, object]]] = []
            result = maybe_relaunch_from_install_dir(
                (),
                executable=source,
                frozen=True,
                platform_name="nt",
                install_dir=root / "C-TKBCherryAgent",
                fallback_dir=root / "fallback",
                spawn_process=lambda *a, **k: spawned.append((a, k)),
            )
            installed = root / "C-TKBCherryAgent" / "TKBCherryAgent.exe"
            self.assertFalse(result)
            self.assertEqual(installed.read_bytes(), b"agent-binary")
            self.assertEqual(spawned[0][0], ([str(installed)],))
            self.assertEqual(spawned[0][1]["cwd"], str(installed.parent))

    def test_root_permission_failure_uses_current_user_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "Downloads" / "TKBCherryAgent.exe"
            source.parent.mkdir()
            source.write_bytes(b"agent-binary")
            preferred = root / "locked"
            fallback = root / "fallback"
            copied_to: list[str] = []

            def copy(source_path: str, destination_path: str) -> None:
                if destination_path.startswith(str(preferred)):
                    raise PermissionError("preferred directory is not writable")
                copied_to.append(destination_path)
                Path(destination_path).write_bytes(Path(source_path).read_bytes())

            spawned: list[tuple[object, dict[str, object]]] = []
            self.assertFalse(
                maybe_relaunch_from_install_dir(
                    (),
                    executable=source,
                    frozen=True,
                    platform_name="nt",
                    install_dir=preferred,
                    fallback_dir=fallback,
                    copy_executable=copy,
                    spawn_process=lambda *a, **k: spawned.append((a, k)),
                )
            )
            installed = fallback / "TKBCherryAgent.exe"
            self.assertEqual(installed.read_bytes(), b"agent-binary")
            self.assertEqual(spawned[0][0], ([str(installed)],))
            self.assertEqual(len(copied_to), 1)

    def test_running_from_install_directory_does_not_spawn_again(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            installed = Path(raw) / "TKBCherryAgent.exe"
            installed.write_bytes(b"agent-binary")
            spawned: list[object] = []
            self.assertTrue(
                maybe_relaunch_from_install_dir(
                    (),
                    executable=installed,
                    frozen=True,
                    platform_name="nt",
                    install_dir=installed.parent,
                    fallback_dir=Path(raw) / "fallback",
                    spawn_process=lambda *a, **k: spawned.append((a, k)),
                )
            )
            self.assertEqual(spawned, [])

    def test_existing_stopped_install_is_updated_before_relaunch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "Downloads" / "TKBCherryAgent.exe"
            installed = root / "C-TKBCherryAgent" / "TKBCherryAgent.exe"
            source.parent.mkdir()
            installed.parent.mkdir()
            source.write_bytes(b"agent-v2")
            installed.write_bytes(b"agent-v1")
            spawned: list[tuple[object, dict[str, object]]] = []

            self.assertFalse(
                maybe_relaunch_from_install_dir(
                    ("--startup",),
                    executable=source,
                    frozen=True,
                    platform_name="nt",
                    install_dir=installed.parent,
                    fallback_dir=root / "fallback",
                    spawn_process=lambda *a, **k: spawned.append((a, k)),
                )
            )
            self.assertEqual(installed.read_bytes(), b"agent-v2")
            self.assertEqual(spawned[0][0], ([str(installed), "--startup"],))

    def test_existing_running_install_is_stopped_before_atomic_update(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "Downloads" / "TKBCherryAgent.exe"
            installed = root / "C-TKBCherryAgent" / "TKBCherryAgent.exe"
            source.parent.mkdir()
            installed.parent.mkdir()
            source.write_bytes(b"agent-v2")
            installed.write_bytes(b"agent-v1")
            events: list[tuple[str, object]] = []

            def stop(executable: Path) -> bool:
                events.append(("stop", executable))
                self.assertEqual(executable.read_bytes(), b"agent-v1")
                return True

            def copy(source_path: str, destination_path: str) -> None:
                events.append(("copy", destination_path))
                Path(destination_path).write_bytes(Path(source_path).read_bytes())

            def spawn(*args: object, **kwargs: object) -> None:
                events.append(("spawn", (args, kwargs)))

            self.assertFalse(
                maybe_relaunch_from_install_dir(
                    (),
                    executable=source,
                    frozen=True,
                    platform_name="nt",
                    install_dir=installed.parent,
                    fallback_dir=root / "fallback",
                    copy_executable=copy,
                    spawn_process=spawn,
                    stop_running_executable=stop,
                )
            )
            self.assertEqual([event[0] for event in events], ["stop", "copy", "spawn"])
            self.assertEqual(installed.read_bytes(), b"agent-v2")

    def test_identical_installed_binary_is_reused_without_kill_or_copy(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "Downloads" / "TKBCherryAgent.exe"
            installed = root / "C-TKBCherryAgent" / "TKBCherryAgent.exe"
            source.parent.mkdir()
            installed.parent.mkdir()
            source.write_bytes(b"same-agent")
            installed.write_bytes(b"same-agent")
            stopped: list[Path] = []
            copied: list[str] = []
            spawned: list[tuple[object, dict[str, object]]] = []

            self.assertFalse(
                maybe_relaunch_from_install_dir(
                    (),
                    executable=source,
                    frozen=True,
                    platform_name="nt",
                    install_dir=installed.parent,
                    fallback_dir=root / "fallback",
                    copy_executable=lambda source_path, destination_path: copied.append(
                        destination_path
                    ),
                    spawn_process=lambda *a, **k: spawned.append((a, k)),
                    stop_running_executable=lambda path: stopped.append(path) or True,
                )
            )
            self.assertEqual(stopped, [])
            self.assertEqual(copied, [])
            self.assertEqual(spawned[0][0], ([str(installed)],))


if __name__ == "__main__":
    unittest.main()
