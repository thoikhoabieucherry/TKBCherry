from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from tkb_optimizer_ref.random_seed import (  # noqa: E402
    CP_SAT_RANDOM_SEED_MAX,
    normalize_cp_sat_seed,
)
from tkb_new.adapter import solve_from_ui_data  # noqa: E402


class RandomSeedContractTests(unittest.TestCase):
    def test_preserves_valid_positive_int32_seed(self) -> None:
        self.assertEqual(normalize_cp_sat_seed(123456789), 123456789)
        self.assertEqual(normalize_cp_sat_seed(CP_SAT_RANDOM_SEED_MAX), CP_SAT_RANDOM_SEED_MAX)

    def test_wraps_legacy_unsigned_and_derived_seeds(self) -> None:
        normalized = normalize_cp_sat_seed(2654435761)
        self.assertIsNotNone(normalized)
        self.assertGreaterEqual(normalized, 1)
        self.assertLessEqual(normalized, CP_SAT_RANDOM_SEED_MAX)
        self.assertEqual(
            normalize_cp_sat_seed(2654435762),
            (int(normalized) % CP_SAT_RANDOM_SEED_MAX) + 1,
        )

    def test_maps_zero_negative_and_huge_values_into_the_same_safe_range(self) -> None:
        for value in (0, -1, -(2**63), 2**63, "999999999999999999999"):
            normalized = normalize_cp_sat_seed(value)
            self.assertIsNotNone(normalized)
            self.assertGreaterEqual(normalized, 1)
            self.assertLessEqual(normalized, CP_SAT_RANDOM_SEED_MAX)

    def test_missing_or_invalid_seed_remains_unspecified(self) -> None:
        for value in (None, "", "not-a-seed", float("inf")):
            self.assertIsNone(normalize_cp_sat_seed(value))

    def test_solver_entry_normalizes_legacy_client_and_variant_seeds(self) -> None:
        settings = {
            "auto_sort_mode": "teacher_session_opt",
            "random_seed": 2654435761,
            "quality_variant_seed": 2654435762,
        }
        with patch(
            "tkb_new.adapter._solve_teacher_session_optimized_from_ui_data",
            return_value={"ok": True},
        ) as optimized:
            self.assertEqual(solve_from_ui_data({}, settings), {"ok": True})

        forwarded = optimized.call_args.args[1]
        self.assertEqual(forwarded["random_seed"], normalize_cp_sat_seed(2654435761))
        self.assertEqual(
            forwarded["quality_variant_seed"],
            normalize_cp_sat_seed(2654435762),
        )


if __name__ == "__main__":
    unittest.main()
