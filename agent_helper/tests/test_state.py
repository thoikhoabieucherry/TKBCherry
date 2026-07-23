from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_helper.state import (
    set_wsl_setup_restart_pending,
    wsl_setup_restart_pending,
    wsl_setup_restart_state,
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

    def test_restart_marker_blocks_same_boot_and_resumes_after_boot_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            with patch("agent_helper.state._current_windows_boot_id", return_value=41):
                set_wsl_setup_restart_pending(True, state_dir)

            same_boot = wsl_setup_restart_state(state_dir, current_boot_id=41)
            next_boot = wsl_setup_restart_state(state_dir, current_boot_id=42)

        self.assertTrue(same_boot.pending)
        self.assertTrue(same_boot.same_boot)
        self.assertEqual(same_boot.boot_id, 41)
        self.assertTrue(next_boot.pending)
        self.assertFalse(next_boot.same_boot)
        self.assertEqual(next_boot.boot_id, 41)

    def test_new_setup_generation_can_retry_once_during_the_same_boot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            with patch("agent_helper.state._current_windows_boot_id", return_value=41):
                set_wsl_setup_restart_pending(
                    True, state_dir, setup_generation="1.6.28"
                )

            newer = wsl_setup_restart_state(
                state_dir,
                current_boot_id=41,
                current_setup_generation="1.6.29",
            )
            same = wsl_setup_restart_state(
                state_dir,
                current_boot_id=41,
                current_setup_generation="1.6.28",
            )

        self.assertTrue(newer.pending)
        self.assertTrue(newer.same_boot)
        self.assertFalse(newer.same_setup_generation)
        self.assertEqual(newer.setup_generation, "1.6.28")
        self.assertTrue(same.same_setup_generation)

    def test_legacy_marker_allows_one_versioned_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            state_dir.mkdir()
            (state_dir / "wsl-setup-restart-pending").write_text(
                "1\n", encoding="ascii"
            )

            state = wsl_setup_restart_state(
                state_dir,
                current_boot_id=99,
                boot_started_ns=0,
                current_setup_generation="1.6.29",
            )

        self.assertTrue(state.pending)
        self.assertFalse(state.same_setup_generation)
        self.assertIsNone(state.setup_generation)

    def test_schema_one_same_boot_marker_allows_new_generation_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            state_dir.mkdir()
            (state_dir / "wsl-setup-restart-pending").write_text(
                '{"bootId":41,"createdNs":2000000000,"schema":1}\n',
                encoding="ascii",
            )

            state = wsl_setup_restart_state(
                state_dir,
                current_boot_id=41,
                current_setup_generation="1.6.29",
            )

        self.assertTrue(state.pending)
        self.assertTrue(state.same_boot)
        self.assertFalse(state.same_setup_generation)
        self.assertIsNone(state.setup_generation)

    def test_legacy_marker_uses_boot_start_time_for_upgrade_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            state_dir.mkdir()
            marker = state_dir / "wsl-setup-restart-pending"
            marker.write_text("1\n", encoding="ascii")
            os.utime(marker, ns=(2_000_000_000, 2_000_000_000))

            same_boot = wsl_setup_restart_state(
                state_dir,
                current_boot_id=-1,
                boot_started_ns=1_000_000_000,
            )
            next_boot = wsl_setup_restart_state(
                state_dir,
                current_boot_id=-1,
                boot_started_ns=3_000_000_000,
            )

        self.assertTrue(same_boot.same_boot)
        self.assertFalse(next_boot.same_boot)

    def test_damaged_marker_conservatively_suppresses_automatic_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            state_dir.mkdir()
            (state_dir / "wsl-setup-restart-pending").write_text(
                "not-json\n", encoding="ascii"
            )

            state = wsl_setup_restart_state(
                state_dir,
                current_boot_id=99,
                current_setup_generation="1.6.29",
            )

        self.assertTrue(state.pending)
        self.assertTrue(state.same_boot)
        self.assertTrue(state.same_setup_generation)


if __name__ == "__main__":
    unittest.main()
