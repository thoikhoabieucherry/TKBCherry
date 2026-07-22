from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_helper.config import AgentConfig, ConfigError
from agent_helper.state import (
    SingleInstanceLock,
    StateError,
    default_state_dir,
    load_or_create_agent_id,
)


class ConfigTests(unittest.TestCase):
    def test_requires_https_for_non_loopback_hosts(self) -> None:
        with self.assertRaises(ConfigError):
            AgentConfig.from_mapping(
                {"api_base": "http://tkbcherry.com/api/agent-helper/v1"}
            )

    def test_local_http_requires_explicit_development_switch(self) -> None:
        with self.assertRaises(ConfigError):
            AgentConfig.from_mapping({"api_base": "http://127.0.0.1:8080/v1"})
        config = AgentConfig.from_mapping(
            {
                "api_base": "http://127.0.0.1:8080/v1/",
                "allow_local_http": True,
            }
        )
        self.assertEqual(config.api_base, "http://127.0.0.1:8080/v1")

    def test_rejects_inline_secret_keys(self) -> None:
        for key in ("token", "password", "api_key", "client-secret"):
            with self.subTest(key=key), self.assertRaises(ConfigError):
                AgentConfig.from_mapping({key: "must-not-be-here"})

    def test_token_is_required_from_named_environment_variable(self) -> None:
        config = AgentConfig.from_mapping({"token_env": "MY_TKB_TOKEN"})
        with self.assertRaises(ConfigError):
            config.load_token({})
        self.assertEqual(
            config.load_token({"MY_TKB_TOKEN": "  secret-value  "}), "secret-value"
        )
        self.assertNotIn("secret-value", repr(config))

    @patch("agent_helper.config.os.cpu_count", return_value=2)
    def test_cpu_limit_is_clamped_to_the_machine(self, cpu_count: object) -> None:
        del cpu_count
        config = AgentConfig.from_mapping({"cpu_workers": 8})
        self.assertEqual(config.cpu_workers, 2)

    @patch("agent_helper.config._physical_memory_bytes", return_value=16 * 1024**3)
    @patch("agent_helper.config.os.cpu_count", return_value=12)
    def test_defaults_allow_all_detected_cpu_and_physical_ram(
        self, cpu_count: object, physical_memory: object
    ) -> None:
        del cpu_count, physical_memory
        config = AgentConfig.from_mapping({})
        self.assertEqual(config.cpu_workers, 12)
        self.assertEqual(config.max_memory_mb, 16 * 1024)
        self.assertEqual(config.solver_timeout_seconds, 1800)
        requested = AgentConfig.from_mapping(
            {"cpu_workers": 256, "max_memory_mb": 1_048_576}
        )
        self.assertEqual(requested.cpu_workers, 12)
        self.assertEqual(requested.max_memory_mb, 16 * 1024)

    def test_rejects_nonfinite_numbers_in_mapping_and_json(self) -> None:
        with self.assertRaises(ConfigError):
            AgentConfig.from_mapping({"heartbeat_seconds": float("nan")})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            path.write_text('{"heartbeat_seconds":NaN}', encoding="utf-8")
            with self.assertRaises(ConfigError):
                AgentConfig.load(path)

    def test_persists_only_a_stable_agent_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary)
            first = load_or_create_agent_id(state_dir)
            second = load_or_create_agent_id(state_dir)
            self.assertEqual(first, second)
            files = [path.name for path in state_dir.iterdir()]
            self.assertEqual(files, ["agent-id"])

    def test_operator_can_select_an_absolute_headless_state_directory(self) -> None:
        selected = (
            Path("C:/tkb-state")
            if Path.cwd().drive
            else Path("/var/lib/tkb-state")
        )
        with patch.dict(
            "os.environ", {"TKB_AGENT_STATE_DIR": str(selected)}, clear=False
        ):
            self.assertEqual(default_state_dir(), selected)

    def test_headless_state_directory_rejects_relative_paths(self) -> None:
        with patch.dict(
            "os.environ", {"TKB_AGENT_STATE_DIR": "relative-state"}, clear=False
        ):
            with self.assertRaises(StateError):
                default_state_dir()

    @unittest.skipIf(os.name == "nt", "Linux XDG path semantics")
    def test_linux_default_uses_the_xdg_state_directory(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "TKB_AGENT_STATE_DIR": "",
                "LOCALAPPDATA": "",
                "XDG_STATE_HOME": "/tmp/tkb-xdg-state",
            },
            clear=False,
        ):
            self.assertEqual(
                default_state_dir(), Path("/tmp/tkb-xdg-state/tkbcherry-agent")
            )

    def test_single_instance_lock_rejects_a_second_helper(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary)
            agent_id = load_or_create_agent_id(state_dir)
            first = SingleInstanceLock(agent_id, state_dir)
            try:
                with self.assertRaises(StateError):
                    SingleInstanceLock(agent_id, state_dir)
            finally:
                first.close()
            replacement = SingleInstanceLock(agent_id, state_dir)
            replacement.close()


if __name__ == "__main__":
    unittest.main()
