from __future__ import annotations

import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agent_helper.__main__ import _gui_smoke_main, main
from agent_helper.config import AgentConfig


class GuiSmokeTests(unittest.TestCase):
    def test_gui_smoke_creates_withdraws_updates_and_destroys_real_root_contract(self) -> None:
        events: list[str] = []

        class Root:
            def withdraw(self) -> None:
                events.append("withdraw")

            def update_idletasks(self) -> None:
                events.append("update")

            def destroy(self) -> None:
                events.append("destroy")

        tkinter = types.SimpleNamespace(Tk=lambda: events.append("create") or Root())
        with patch.dict("sys.modules", {"tkinter": tkinter}):
            self.assertEqual(_gui_smoke_main(), 0)
        self.assertEqual(events, ["create", "withdraw", "update", "destroy"])


class HeadlessMainTests(unittest.TestCase):
    def _config(self) -> AgentConfig:
        return AgentConfig.from_mapping(
            {"cpu_workers": 1, "poll_wait_seconds": 0}
        )

    def test_headless_runs_forever_without_importing_the_gui(self) -> None:
        solver = MagicMock()
        solver._command_and_cwd.return_value = (["python"], Path.cwd())
        worker = MagicMock()
        with (
            patch("agent_helper.__main__.AgentConfig.load", return_value=self._config()),
            patch("agent_helper.__main__.load_or_create_agent_id", return_value="agent-id"),
            patch(
                "agent_helper.__main__.solver_blocked_by_windows_code_integrity",
                return_value=False,
            ),
            patch("agent_helper.__main__.SolverRunner", return_value=solver),
            patch("agent_helper.__main__.SingleInstanceLock"),
            patch(
                "agent_helper.__main__._load_or_pair_token",
                return_value="tkbt_test",
            ) as token_loader,
            patch("agent_helper.__main__.ApiClient") as api_client,
            patch("agent_helper.__main__.AgentWorker", return_value=worker),
            patch.dict("sys.modules", {"agent_helper.gui": None}),
        ):
            self.assertEqual(main(["--headless"]), 0)
        worker.run_forever.assert_called_once_with()
        worker.run_once.assert_not_called()
        self.assertFalse(token_loader.call_args.kwargs["allow_pair"])
        self.assertIsNotNone(api_client.call_args.kwargs["stop_event"])

    def test_check_validates_the_server_credential_after_solver_probe(self) -> None:
        solver = MagicMock()
        solver._command_and_cwd.return_value = (["python"], Path.cwd())
        api = MagicMock()
        with (
            patch("agent_helper.__main__.AgentConfig.load", return_value=self._config()),
            patch("agent_helper.__main__.load_or_create_agent_id", return_value="agent-id"),
            patch(
                "agent_helper.__main__.solver_blocked_by_windows_code_integrity",
                return_value=False,
            ),
            patch("agent_helper.__main__.SolverRunner", return_value=solver),
            patch("agent_helper.__main__.SingleInstanceLock"),
            patch("agent_helper.__main__._load_or_pair_token", return_value="tkbt_test"),
            patch("agent_helper.__main__._probe_solver", return_value=200),
            patch("agent_helper.__main__.ApiClient", return_value=api),
        ):
            self.assertEqual(main(["--check"]), 0)
        api.hello.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
