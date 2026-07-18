from __future__ import annotations

import threading
import time
import unittest

from agent_helper.config import AgentConfig
from agent_helper.models import Lease, LeaseLimits
from agent_helper.solver import SolverCancelled, SolverResult
from agent_helper.worker import AgentWorker


def lease() -> Lease:
    return Lease(
        job_id="job-1",
        lease_id="lease-1",
        attempt=1,
        lease_expires_at=None,
        payload={"data": {}, "settings": {}},
        limits=LeaseLimits(cpu_workers=2, timeout_seconds=30),
    )


class FakeApi:
    def __init__(
        self, next_lease: Lease | None, *, candidate_delay: float = 0.0
    ) -> None:
        self.next_lease = next_lease
        self.candidate_delay = candidate_delay
        self.events: list[str] = []

    def hello(self) -> None:
        self.events.append("hello")

    def heartbeat(self, status: str = "idle") -> None:
        self.events.append(f"heartbeat:{status}")

    def lease(self) -> Lease | None:
        self.events.append("lease")
        value, self.next_lease = self.next_lease, None
        return value

    def lease_heartbeat(
        self,
        active: Lease,
        *,
        elapsed_seconds: float,
        remaining_seconds: float,
        phase: str = "solving",
    ) -> bool:
        del active, elapsed_seconds, remaining_seconds
        self.events.append(f"lease-heartbeat:{phase}")
        return False

    def candidate(
        self, active: Lease, *, solver_status: int, result: dict[str, object]
    ) -> tuple[str, str]:
        del active, solver_status, result
        self.events.append("candidate")
        if self.candidate_delay:
            time.sleep(self.candidate_delay)
        return "candidate-1", "a" * 64

    def complete(
        self,
        active: Lease,
        *,
        candidate_id: str,
        digest: str,
        solver_status: int,
    ) -> None:
        del active, candidate_id, digest, solver_status
        self.events.append("complete")

    def fail(self, active: Lease, *, kind: str, message: str) -> None:
        del active, kind, message
        self.events.append("fail")


class FakeSolver:
    def __init__(self) -> None:
        self.config = AgentConfig.from_mapping(
            {"cpu_workers": 2, "poll_wait_seconds": 0}
        )
        self.heartbeat_seconds = self.config.heartbeat_seconds

    def run(
        self, active: Lease, *, heartbeat: object, stop_event: threading.Event
    ) -> SolverResult:
        del active, stop_event
        heartbeat(0.0, 30.0)  # type: ignore[operator]
        return SolverResult(
            protocol="tkb-reference-solver-stdio-v1",
            status=200,
            payload={"ok": True},
        )


class CancelledSolver(FakeSolver):
    def run(
        self, active: Lease, *, heartbeat: object, stop_event: threading.Event
    ) -> SolverResult:
        del active, heartbeat
        stop_event.set()
        raise SolverCancelled("Agent was switched off")


class WorkerTests(unittest.TestCase):
    def test_full_flow_is_hello_lease_heartbeat_candidate_complete(self) -> None:
        api = FakeApi(lease())
        worker = AgentWorker(api, FakeSolver())  # type: ignore[arg-type]
        self.assertTrue(worker.run_once())
        self.assertEqual(
            api.events,
            [
                "hello",
                "lease",
                "lease-heartbeat:solving",
                "lease-heartbeat:uploading",
                "candidate",
                "complete",
            ],
        )

    def test_no_work_sends_idle_heartbeat(self) -> None:
        api = FakeApi(None)
        worker = AgentWorker(api, FakeSolver())  # type: ignore[arg-type]
        self.assertFalse(worker.run_once())
        self.assertEqual(api.events, ["hello", "lease", "heartbeat:idle"])

    def test_lease_heartbeat_continues_during_slow_candidate_upload(self) -> None:
        api = FakeApi(lease(), candidate_delay=0.35)
        solver = FakeSolver()
        solver.heartbeat_seconds = 0.1
        worker = AgentWorker(api, solver)  # type: ignore[arg-type]
        self.assertTrue(worker.run_once())
        uploading = [
            event for event in api.events if event == "lease-heartbeat:uploading"
        ]
        self.assertGreaterEqual(len(uploading), 2)

    def test_switching_off_does_not_block_on_failure_upload(self) -> None:
        api = FakeApi(lease())
        stop_event = threading.Event()
        worker = AgentWorker(
            api,
            CancelledSolver(),  # type: ignore[arg-type]
            stop_event=stop_event,
        )
        self.assertTrue(worker.run_once())
        self.assertNotIn("fail", api.events)


if __name__ == "__main__":
    unittest.main()
