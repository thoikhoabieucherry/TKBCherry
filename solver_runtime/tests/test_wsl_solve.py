from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from solver_runtime.scripts.wsl_solve import _apply_memory_limit, _memory_limit_bytes


class WslSolveTests(unittest.TestCase):
    def test_memory_limit_requires_at_least_512_mb(self) -> None:
        with patch.dict(os.environ, {"TKB_SOLVER_MAX_MEMORY_MB": "511"}):
            self.assertEqual(_memory_limit_bytes(), 0)
        with patch.dict(os.environ, {"TKB_SOLVER_MAX_MEMORY_MB": "4096"}):
            self.assertEqual(_memory_limit_bytes(), 4096 * 1024 * 1024)

    def test_memory_ceiling_is_applied_to_linux_address_space(self) -> None:
        calls: list[tuple[object, tuple[int, int]]] = []

        class Resource:
            RLIMIT_AS = object()

            @staticmethod
            def setrlimit(kind: object, limits: tuple[int, int]) -> None:
                calls.append((kind, limits))

        with (
            patch.dict(os.environ, {"TKB_SOLVER_MAX_MEMORY_MB": "1024"}),
            patch.dict("sys.modules", {"resource": Resource}),
        ):
            _apply_memory_limit()

        self.assertEqual(calls, [(Resource.RLIMIT_AS, (1024**3, 1024**3))])


if __name__ == "__main__":
    unittest.main()
