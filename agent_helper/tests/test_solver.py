from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_helper.config import AgentConfig
from agent_helper.models import Lease, LeaseLimits
from agent_helper.solver import (
    SolverCancelled,
    SolverInfrastructureError,
    SolverRunner,
    SolverTimedOut,
    _effective_memory_limit_mb,
)


def make_config(**overrides: object) -> AgentConfig:
    values: dict[str, object] = {
        "cpu_workers": 2,
        "heartbeat_seconds": 0.1,
        "solver_timeout_seconds": 3,
        "retry_attempts": 1,
    }
    values.update(overrides)
    return AgentConfig.from_mapping(values)


def make_lease(*, timeout: int = 3) -> Lease:
    return Lease(
        job_id="job-test",
        lease_id="lease-test",
        attempt=1,
        lease_expires_at=None,
        payload={"data": {"classes": []}, "settings": {"num_workers": 99}},
        limits=LeaseLimits(cpu_workers=2, timeout_seconds=timeout),
    )


class SolverRunnerTests(unittest.TestCase):
    def test_workload_uses_only_the_workers_that_improve_search(self) -> None:
        cases = (
            ("fresh_complete_first", 300, 2),
            ("fresh_complete_first", 1566, 4),
            ("refine_complete", 1566, 6),
            ("fresh_complete_first", 3000, 6),
        )
        for solve_kind, expected, effective in cases:
            with self.subTest(solve_kind=solve_kind, expected=expected):
                lease = Lease(
                    job_id="job-adaptive",
                    lease_id="lease-adaptive",
                    attempt=1,
                    lease_expires_at=None,
                    payload={
                        "data": {},
                        "settings": {
                            "expected_scheduled_periods": expected,
                            "ui_unified_solve_kind": solve_kind,
                            "num_workers": 22,
                        },
                    },
                    limits=LeaseLimits(cpu_workers=22, timeout_seconds=180),
                )
                request = SolverRunner._normalized_request(lease)
                self.assertEqual(request["settings"]["num_workers"], effective)

    def test_workload_memory_limit_is_a_bounded_slice_of_permission(self) -> None:
        for expected, effective_mb in ((300, 4096), (1566, 8192), (3000, 16384)):
            with self.subTest(expected=expected):
                request = {
                    "data": {},
                    "settings": {"expected_scheduled_periods": expected},
                }
                self.assertEqual(
                    _effective_memory_limit_mb(request, 32 * 1024), effective_mb
                )
        self.assertEqual(
            _effective_memory_limit_mb(
                {"data": {}, "settings": {"expected_scheduled_periods": 1566}},
                6 * 1024,
            ),
            6 * 1024,
        )

    def test_passes_bounded_workers_and_reads_framed_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "fake_solver.py"
            script.write_text(
                "\n".join(
                    [
                        "import json, os, sys",
                        "request = json.load(sys.stdin)",
                        "payload = {'workers': request['settings']['num_workers'], 'envWorkers': os.environ['TKB_SOLVER_MAX_WORKERS'], 'noLogs': os.environ['TKB_NO_LOGS'], 'hasBearer': 'TKB_AGENT_TOKEN' in os.environ, 'hasOtherSecret': 'UNRELATED_SECRET' in os.environ}",
                        "print(json.dumps({'protocol': 'tkb-reference-solver-stdio-v1', 'status': 422, 'payload': payload}), flush=True)",
                    ]
                ),
                encoding="utf-8",
            )
            heartbeats: list[tuple[float, float]] = []
            runner = SolverRunner(
                make_config(), command=[sys.executable, str(script)], cwd=root
            )
            with patch.dict(
                os.environ,
                {"TKB_AGENT_TOKEN": "sensitive", "UNRELATED_SECRET": "also-sensitive"},
            ):
                result = runner.run(
                    make_lease(),
                    heartbeat=lambda elapsed, remaining: (
                        heartbeats.append((elapsed, remaining)) or False
                    ),
                    stop_event=threading.Event(),
                )
            self.assertEqual(result.status, 422)
            self.assertEqual(result.payload["workers"], 2)
            self.assertEqual(result.payload["envWorkers"], "2")
            self.assertEqual(result.payload["noLogs"], "1")
            self.assertFalse(result.payload["hasBearer"])
            self.assertFalse(result.payload["hasOtherSecret"])
            self.assertGreaterEqual(len(heartbeats), 1)

    def test_timeout_terminates_solver(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "sleep.py"
            script.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
            runner = SolverRunner(
                make_config(solver_timeout_seconds=1),
                command=[sys.executable, str(script)],
                cwd=root,
            )
            started = time.monotonic()
            with self.assertRaises(SolverTimedOut):
                runner.run(
                    make_lease(timeout=1),
                    heartbeat=lambda elapsed, remaining: False,
                    stop_event=threading.Event(),
                )
            self.assertLess(time.monotonic() - started, 8)

    def test_server_cancellation_terminates_solver(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "sleep.py"
            script.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
            runner = SolverRunner(
                make_config(), command=[sys.executable, str(script)], cwd=root
            )
            started = time.monotonic()
            with self.assertRaises(SolverCancelled):
                runner.run(
                    make_lease(),
                    heartbeat=lambda elapsed, remaining: True,
                    stop_event=threading.Event(),
                )
            self.assertLess(time.monotonic() - started, 8)

    def test_shutdown_is_not_blocked_by_hung_network_heartbeat(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "sleep.py"
            script.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
            runner = SolverRunner(
                make_config(), command=[sys.executable, str(script)], cwd=root
            )
            stop_event = threading.Event()
            timer = threading.Timer(0.2, stop_event.set)
            timer.start()
            started = time.monotonic()
            try:
                with self.assertRaises(SolverCancelled):
                    runner.run(
                        make_lease(),
                        heartbeat=lambda elapsed, remaining: time.sleep(60) or False,
                        stop_event=stop_event,
                    )
            finally:
                timer.cancel()
            self.assertLess(time.monotonic() - started, 3)

    def test_stderr_is_capped_while_process_is_running(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "noisy.py"
            script.write_text(
                "import sys, time\nsys.stderr.write('x' * (2 * 1024 * 1024))\nsys.stderr.flush()\ntime.sleep(60)\n",
                encoding="utf-8",
            )
            runner = SolverRunner(
                make_config(max_stderr_bytes=1024),
                command=[sys.executable, str(script)],
                cwd=root,
            )
            with self.assertRaises(SolverInfrastructureError) as raised:
                runner.run(
                    make_lease(),
                    heartbeat=lambda elapsed, remaining: False,
                    stop_event=threading.Event(),
                )
            self.assertEqual(raised.exception.kind, "solver_stderr_too_large")

    def test_cancellation_kills_solver_descendants(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "child-survived.txt"
            ready = root / "child-started.txt"
            child = root / "child.py"
            child.write_text(
                "import sys, time\nfrom pathlib import Path\ntime.sleep(1)\nPath(sys.argv[1]).write_text('survived', encoding='utf-8')\n",
                encoding="utf-8",
            )
            parent = root / "parent.py"
            parent.write_text(
                "import subprocess, sys, time\nfrom pathlib import Path\nsubprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\nPath(sys.argv[3]).write_text('started', encoding='utf-8')\ntime.sleep(60)\n",
                encoding="utf-8",
            )
            runner = SolverRunner(
                make_config(),
                command=[
                    sys.executable,
                    str(parent),
                    str(child),
                    str(marker),
                    str(ready),
                ],
                cwd=root,
            )

            def cancel_after_child_starts(elapsed: float, remaining: float) -> bool:
                del elapsed, remaining
                return ready.exists()

            with self.assertRaises(SolverCancelled):
                runner.run(
                    make_lease(),
                    heartbeat=cancel_after_child_starts,
                    stop_event=threading.Event(),
                )
            self.assertTrue(
                ready.exists(), "the process-tree fixture did not start its child"
            )
            time.sleep(1.3)
            self.assertFalse(
                marker.exists(), "a descendant escaped the solver process container"
            )

    def test_rejects_nonfinite_json_and_nonzero_exit(self) -> None:
        cases = {
            "nan": (
                'print(\'{"protocol":"tkb-reference-solver-stdio-v1","status":200,"payload":{"value":NaN}}\', flush=True)\n',
                "solver_protocol_error",
            ),
            "exit": (
                'print(\'{"protocol":"tkb-reference-solver-stdio-v1","status":200,"payload":{}}\', flush=True)\nraise SystemExit(7)\n',
                "solver_exit_failed",
            ),
        }
        for name, (source, expected_kind) in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                script = root / "invalid.py"
                script.write_text(source, encoding="utf-8")
                runner = SolverRunner(
                    make_config(), command=[sys.executable, str(script)], cwd=root
                )
                with self.assertRaises(SolverInfrastructureError) as raised:
                    runner.run(
                        make_lease(),
                        heartbeat=lambda elapsed, remaining: False,
                        stop_event=threading.Event(),
                    )
                self.assertEqual(raised.exception.kind, expected_kind)


if __name__ == "__main__":
    unittest.main()
