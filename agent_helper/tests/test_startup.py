from __future__ import annotations

import unittest

from agent_helper.startup import (
    RUN_KEY,
    RUN_VALUE_NAME,
    StartupRegistrationError,
    set_current_user_startup,
    should_manage_startup,
    startup_toggle_for_current_process,
)


class FakeKey:
    def __init__(self, registry: "FakeRegistry") -> None:
        self.registry = registry

    def __enter__(self) -> "FakeKey":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback


class FakeRegistry:
    HKEY_CURRENT_USER = object()
    KEY_QUERY_VALUE = 0x0001
    KEY_SET_VALUE = 0x0002
    REG_SZ = 1

    def __init__(self) -> None:
        self.key_exists = False
        self.values: dict[str, tuple[object, int]] = {}
        self.create_calls: list[tuple[object, str, int, int]] = []
        self.open_calls: list[tuple[object, str, int, int]] = []
        self.set_calls: list[tuple[str, object, int]] = []
        self.delete_calls: list[str] = []

    def CreateKeyEx(
        self, root: object, path: str, reserved: int, access: int
    ) -> FakeKey:
        self.create_calls.append((root, path, reserved, access))
        self.key_exists = True
        return FakeKey(self)

    def OpenKey(
        self, root: object, path: str, reserved: int, access: int
    ) -> FakeKey:
        self.open_calls.append((root, path, reserved, access))
        if not self.key_exists:
            raise FileNotFoundError(path)
        return FakeKey(self)

    def QueryValueEx(self, key: FakeKey, name: str) -> tuple[object, int]:
        del key
        if name not in self.values:
            raise FileNotFoundError(name)
        return self.values[name]

    def SetValueEx(
        self, key: FakeKey, name: str, reserved: int, kind: int, value: object
    ) -> None:
        del key, reserved
        self.values[name] = (value, kind)
        self.set_calls.append((name, value, kind))

    def DeleteValue(self, key: FakeKey, name: str) -> None:
        del key
        if name not in self.values:
            raise FileNotFoundError(name)
        del self.values[name]
        self.delete_calls.append(name)


class StartupRegistrationTests(unittest.TestCase):
    def test_only_normal_frozen_windows_gui_is_eligible(self) -> None:
        self.assertTrue(
            should_manage_startup(True, frozen=True, platform_name="nt")
        )
        self.assertFalse(
            should_manage_startup(False, frozen=True, platform_name="nt")
        )
        self.assertFalse(
            should_manage_startup(True, frozen=False, platform_name="nt")
        )
        self.assertFalse(
            should_manage_startup(True, frozen=True, platform_name="posix")
        )

        registry = FakeRegistry()
        for gui_mode, frozen, platform_name in (
            (False, True, "nt"),
            (True, False, "nt"),
            (True, True, "posix"),
        ):
            with self.subTest(
                gui_mode=gui_mode,
                frozen=frozen,
                platform_name=platform_name,
            ):
                self.assertIsNone(
                    startup_toggle_for_current_process(
                        gui_mode,
                        frozen=frozen,
                        platform_name=platform_name,
                        executable=r"C:\TKBCherryAgent.exe",
                        registry=registry,
                    )
                )
        self.assertEqual(registry.create_calls, [])
        self.assertEqual(registry.open_calls, [])

    def test_registration_is_hkcu_idempotent_and_contains_only_exe_and_startup_flag(self) -> None:
        registry = FakeRegistry()
        executable = r"C:\Users\Teacher Name\TKBCherryAgent.exe"
        self.assertTrue(
            set_current_user_startup(
                True, executable=executable, registry=registry
            )
        )
        command, kind = registry.values[RUN_VALUE_NAME]
        self.assertEqual(command, f'"{executable}" --startup')
        self.assertEqual(kind, registry.REG_SZ)
        self.assertEqual(str(command).count("--startup"), 1)
        self.assertNotIn("token", str(command).casefold())
        root, path, reserved, access = registry.create_calls[0]
        self.assertIs(root, registry.HKEY_CURRENT_USER)
        self.assertEqual(path, RUN_KEY)
        self.assertEqual(reserved, 0)
        self.assertEqual(
            access, registry.KEY_QUERY_VALUE | registry.KEY_SET_VALUE
        )

        self.assertFalse(
            set_current_user_startup(
                True, executable=executable, registry=registry
            )
        )
        self.assertEqual(len(registry.set_calls), 1)

        registry.values[RUN_VALUE_NAME] = (r"C:\Old\Agent.exe", registry.REG_SZ)
        self.assertTrue(
            set_current_user_startup(
                True, executable=executable, registry=registry
            )
        )
        self.assertEqual(registry.values[RUN_VALUE_NAME], (command, registry.REG_SZ))
        self.assertEqual(len(registry.set_calls), 2)

    def test_registration_is_reversible_without_deleting_shared_run_key(self) -> None:
        registry = FakeRegistry()
        executable = r"C:\TKBCherryAgent.exe"
        set_current_user_startup(True, executable=executable, registry=registry)
        self.assertTrue(
            set_current_user_startup(
                False, executable=executable, registry=registry
            )
        )
        self.assertNotIn(RUN_VALUE_NAME, registry.values)
        self.assertTrue(registry.key_exists)
        self.assertEqual(registry.delete_calls, [RUN_VALUE_NAME])
        self.assertFalse(
            set_current_user_startup(
                False, executable=executable, registry=registry
            )
        )

        missing_registry = FakeRegistry()
        self.assertFalse(
            set_current_user_startup(
                False, executable=executable, registry=missing_registry
            )
        )
        self.assertEqual(missing_registry.create_calls, [])

    def test_controller_captures_packaged_exe_and_rejects_argument_injection(self) -> None:
        registry = FakeRegistry()
        toggle = startup_toggle_for_current_process(
            True,
            frozen=True,
            platform_name="nt",
            executable=r"C:\Program Files\TKBCherry\TKBCherryAgent.exe",
            registry=registry,
        )
        self.assertIsNotNone(toggle)
        assert toggle is not None
        self.assertTrue(toggle(True))
        self.assertTrue(toggle(False))

        for invalid in (
            "",
            r"C:\Agent.py",
            'C:\\Agent.exe" --token secret',
            "C:\\Agent.exe\n--token secret",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(
                StartupRegistrationError
            ):
                set_current_user_startup(
                    True, executable=invalid, registry=FakeRegistry()
                )


if __name__ == "__main__":
    unittest.main()
