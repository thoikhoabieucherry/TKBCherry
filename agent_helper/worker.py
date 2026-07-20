"""Single-capacity polling worker for Agent Helper leases."""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Callable, Mapping, Protocol

from .api import ApiError
from .models import Lease, ProtocolError
from .solver import (
    SolverCancelled,
    SolverInfrastructureError,
    SolverRunner,
)


LOGGER = logging.getLogger("agent_helper")


class WorkerApi(Protocol):
    def hello(self) -> object: ...

    def heartbeat(self, status: str = "idle") -> object: ...

    def lease(self) -> Lease | None: ...

    def lease_heartbeat(
        self,
        lease: Lease,
        *,
        elapsed_seconds: float,
        remaining_seconds: float,
        phase: str = "solving",
    ) -> bool: ...

    def candidate(
        self,
        lease: Lease,
        *,
        solver_status: int,
        result: dict[str, object],
    ) -> tuple[str, str]: ...

    def complete(
        self,
        lease: Lease,
        *,
        candidate_id: str,
        digest: str,
        solver_status: int,
    ) -> None: ...

    def fail(self, lease: Lease, *, kind: str, message: str) -> None: ...


class _UploadHeartbeat:
    """Keep a lease alive while candidate/complete HTTP uploads are in flight."""

    def __init__(
        self,
        api: WorkerApi,
        lease: Lease,
        *,
        interval_seconds: float,
        stop_event: threading.Event,
    ) -> None:
        self.api = api
        self.lease = lease
        self.interval_seconds = max(0.1, interval_seconds)
        self.outer_stop = stop_event
        self._stop = threading.Event()
        self._first = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._phase = "uploading"
        self._error: BaseException | None = None
        self._cancelled = False
        self._started = time.monotonic()

    def _run(self) -> None:
        try:
            while not self._stop.is_set() and not self.outer_stop.is_set():
                elapsed = max(0.0, time.monotonic() - self._started)
                self._cancelled = bool(
                    self.api.lease_heartbeat(
                        self.lease,
                        elapsed_seconds=elapsed,
                        remaining_seconds=max(
                            0.0, self.lease.limits.timeout_seconds - elapsed
                        ),
                        phase=self._phase,
                    )
                )
                self._first.set()
                if self._cancelled:
                    return
                self._stop.wait(self.interval_seconds)
        except BaseException as exc:
            self._error = exc
            self._first.set()

    def start(self) -> None:
        self._thread.start()
        while not self._first.wait(0.05):
            if self.outer_stop.is_set():
                self.close()
                raise SolverCancelled(
                    "Agent shutdown was requested during result upload"
                )
        self.raise_if_unhealthy()

    def set_phase(self, phase: str) -> None:
        self._phase = phase

    def raise_if_unhealthy(self) -> None:
        if self.outer_stop.is_set():
            raise SolverCancelled("Agent shutdown was requested during result upload")
        if self._cancelled:
            raise SolverCancelled("The server cancelled this job during result upload")
        if self._error is not None:
            raise SolverInfrastructureError(
                "lease_heartbeat_failed",
                "The job lease could not be renewed during result upload",
            ) from self._error

    def close(self) -> None:
        self._stop.set()
        self._thread.join(max(1.0, self.interval_seconds + 1.0))


class AgentWorker:
    def __init__(
        self,
        api: WorkerApi,
        solver: SolverRunner,
        *,
        stop_event: threading.Event | None = None,
        status_callback: Callable[[str], None] | None = None,
    ) -> None:
        self.api = api
        self.solver = solver
        self.stop_event = stop_event or threading.Event()
        self.status_callback = status_callback or (lambda status: None)
        self._registered = False

    def _ensure_registered(self) -> None:
        if self._registered:
            return
        response = self.api.hello()
        if isinstance(response, Mapping):
            candidates = [float(self.solver.config.heartbeat_seconds)]
            heartbeat_ms = response.get("heartbeatEveryMs")
            lease_ms = response.get("leaseMs")
            if isinstance(heartbeat_ms, int) and not isinstance(heartbeat_ms, bool):
                candidates.append(max(0.1, heartbeat_ms / 1000.0))
            if isinstance(lease_ms, int) and not isinstance(lease_ms, bool):
                candidates.append(max(0.1, lease_ms / 3000.0))
            self.solver.heartbeat_seconds = min(candidates)
        self._registered = True
        self.status_callback("waiting")
        LOGGER.info("Agent Helper connected securely to the server.")

    def _report_failure(self, lease: Lease, exc: SolverInfrastructureError) -> None:
        if isinstance(exc, SolverCancelled) and self.stop_event.is_set():
            # OFF must release the local CPU immediately. The short server lease
            # will expire/requeue safely without making the UI wait on HTTP.
            LOGGER.info("Local solver stopped because Agent was switched OFF.")
            return
        self.api.fail(lease, kind=exc.kind, message=str(exc))
        LOGGER.warning("Solver job stopped safely: %s", exc.kind)

    def run_once(self) -> bool:
        """Poll once and return ``True`` when a lease was handled."""

        self._ensure_registered()
        if self.stop_event.is_set():
            return False
        lease = self.api.lease()
        if self.stop_event.is_set():
            # A long-poll may finish just after OFF was requested. Do not start
            # a solver process for that late lease; the server will reclaim it
            # through the normal short lease expiry.
            return lease is not None
        if lease is None:
            self.api.heartbeat("idle")
            self.status_callback("waiting")
            return False

        self.status_callback("working")
        LOGGER.info("A solver job was received and started.")
        try:
            result = self.solver.run(
                lease,
                heartbeat=lambda elapsed, remaining: self.api.lease_heartbeat(
                    lease,
                    elapsed_seconds=elapsed,
                    remaining_seconds=remaining,
                    phase="solving",
                ),
                stop_event=self.stop_event,
            )
        except SolverInfrastructureError as exc:
            self._report_failure(lease, exc)
            if not self.stop_event.is_set():
                self.status_callback("waiting")
            return True

        upload_heartbeat = _UploadHeartbeat(
            self.api,
            lease,
            interval_seconds=self.solver.heartbeat_seconds,
            stop_event=self.stop_event,
        )
        try:
            upload_heartbeat.start()
            candidate_id, digest = self.api.candidate(
                lease,
                solver_status=result.status,
                result=result.payload,
            )
            upload_heartbeat.raise_if_unhealthy()
            upload_heartbeat.set_phase("committing")
            self.api.complete(
                lease,
                candidate_id=candidate_id,
                digest=digest,
                solver_status=result.status,
            )
        except SolverInfrastructureError as exc:
            upload_heartbeat.close()
            self._report_failure(lease, exc)
            if not self.stop_event.is_set():
                self.status_callback("waiting")
            return True
        finally:
            upload_heartbeat.close()
        LOGGER.info("Solver result was committed to the server.")
        self.status_callback("waiting")
        return True

    def run_forever(self) -> None:
        """Keep long-polling until a signal sets ``stop_event``."""

        base_backoff = max(1.0, self.solver.config.idle_backoff_seconds)
        consecutive_failures = 0
        jitter = random.SystemRandom()
        while not self.stop_event.is_set():
            try:
                handled = self.run_once()
                consecutive_failures = 0
                if not handled and self.solver.config.idle_backoff_seconds > 0:
                    self.stop_event.wait(self.solver.config.idle_backoff_seconds)
            except ApiError as exc:
                self._registered = False
                if exc.status in {401, 403, 404}:
                    self.status_callback("error")
                    LOGGER.error(
                        "Agent stopped because authentication or the server endpoint is invalid (HTTP %s).",
                        exc.status,
                    )
                    self.stop_event.set()
                    break
                consecutive_failures += 1
                delay = min(
                    60.0, base_backoff * (2 ** min(5, consecutive_failures - 1))
                )
                delay *= jitter.uniform(0.8, 1.2)
                LOGGER.warning("Server is temporarily unavailable; retrying shortly.")
                self.stop_event.wait(delay)
            except ProtocolError:
                self.status_callback("error")
                LOGGER.error(
                    "Agent stopped because the server protocol is incompatible."
                )
                self._registered = False
                self.stop_event.set()
                break
            except Exception:
                consecutive_failures += 1
                delay = min(
                    60.0, base_backoff * (2 ** min(5, consecutive_failures - 1))
                )
                LOGGER.exception(
                    "Agent Helper encountered an internal error and will retry."
                )
                self._registered = False
                self.stop_event.wait(delay)

        LOGGER.info("Agent Helper stopped.")
