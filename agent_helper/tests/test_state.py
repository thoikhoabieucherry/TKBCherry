from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agent_helper.state import (
    set_wsl_setup_restart_pending,
    wsl_setup_restart_pending,
)


class WslSetupRestartStateTests(unittest.TestCase):
    def test_restart_marker_round_trip_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"

            self.assertFalse(wsl_setup_restart_pending(state_dir))
            set_wsl_setup_restart_pending(True, state_dir)
            self.assertTrue(wsl_setup_restart_pending(state_dir))
            set_wsl_setup_restart_pending(True, state_dir)
            self.assertTrue(wsl_setup_restart_pending(state_dir))
            set_wsl_setup_restart_pending(False, state_dir)
            self.assertFalse(wsl_setup_restart_pending(state_dir))


if __name__ == "__main__":
    unittest.main()
