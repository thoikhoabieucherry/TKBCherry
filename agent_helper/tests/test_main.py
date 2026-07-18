from __future__ import annotations

import types
import unittest
from unittest.mock import patch

from agent_helper.__main__ import _gui_smoke_main


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


if __name__ == "__main__":
    unittest.main()
