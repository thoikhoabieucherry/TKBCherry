"""HTTPS-only REST client for the TKB Agent Helper protocol."""

from __future__ import annotations

import hashlib
import json
import math
import socket
import ssl
import struct
import threading
import time
import uuid
from dataclasses import dataclass
from email.message import Message
from typing import Any, Mapping, Protocol, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    HTTPHandler,
    Request,
    build_opener,
)

from . import AGENT_PROTOCOL, SOLVER_PROTOCOL
from .config import AgentConfig
from .models import AgentIdentity, Lease, ProtocolError, validate_identifier


_RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


class ApiError(RuntimeError):
    """A sanitized network or server failure (never includes a token/body)."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class TransportError(RuntimeError):
    """A sanitized transport-layer failure."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str]


class HttpTransport(Protocol):
    def request(
        self,
        *,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
        max_response_bytes: int,
    ) -> HttpResponse: ...


class _NoRedirect(HTTPRedirectHandler):
    """Reject redirects so Authorization can never be forwarded to another host."""

    def redirect_request(  # type: ignore[override]
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> None:
        return None


def _read_limited(stream: Any, maximum: int) -> bytes:
    data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise TransportError("HTTP response exceeded the configured size limit")
    return data


class UrllibTransport:
    """Small standard-library transport with verified system TLS roots."""

    def __init__(self, tls_context: ssl.SSLContext | None = None) -> None:
        self._tls_context = tls_context or ssl.create_default_context()

    def _opener(self) -> Any:
        # One opener per request keeps concurrent upload heartbeats isolated.
        return build_opener(
            _NoRedirect(),
            HTTPSHandler(context=self._tls_context),
            HTTPHandler(),
        )

    def request(
        self,
        *,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
        max_response_bytes: int,
    ) -> HttpResponse:
        request = Request(url=url, data=body, headers=dict(headers), method=method)
        try:
            with self._opener().open(request, timeout=timeout) as response:
                return HttpResponse(
                    status=int(response.status),
                    body=_read_limited(response, max_response_bytes),
                    headers={
                        key.casefold(): value for key, value in response.headers.items()
                    },
                )
        except HTTPError as exc:
            try:
                response_body = _read_limited(exc, max_response_bytes)
            finally:
                exc.close()
            return HttpResponse(
                status=int(exc.code),
                body=response_body,
                headers={
                    key.casefold(): value
                    for key, value in (exc.headers.items() if exc.headers else [])
                },
            )
        except (URLError, TimeoutError, socket.timeout, OSError) as exc:
            raise TransportError("HTTPS request failed") from exc


def canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ProtocolError("value is not valid JSON") from exc


RESULT_DIGEST_PROTOCOL = "tkb-json-tree-sha256-v1"


def _digest_length(digest: Any, value: int) -> None:
    if value < 0 or value >= 2**64:
        raise ProtocolError("JSON value is too large to digest")
    digest.update(struct.pack(">Q", value))


def _update_tree_digest(digest: Any, value: Any) -> None:
    if value is None:
        digest.update(b"N")
    elif value is True:
        digest.update(b"T")
    elif value is False:
        digest.update(b"F")
    elif isinstance(value, str):
        encoded = value.encode("utf-8")
        digest.update(b"S")
        _digest_length(digest, len(encoded))
        digest.update(encoded)
    elif isinstance(value, int):
        encoded = str(value).encode("ascii")
        digest.update(b"I")
        _digest_length(digest, len(encoded))
        digest.update(encoded)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ProtocolError("value is not valid JSON")
        digest.update(b"D")
        digest.update(struct.pack(">d", value))
    elif isinstance(value, (list, tuple)):
        digest.update(b"L")
        _digest_length(digest, len(value))
        for item in value:
            _update_tree_digest(digest, item)
    elif isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise ProtocolError("JSON object keys must be strings")
        digest.update(b"O")
        _digest_length(digest, len(value))
        for key in sorted(value):
            _update_tree_digest(digest, key)
            _update_tree_digest(digest, value[key])
    else:
        raise ProtocolError("value is not valid JSON")


def result_digest(result: Mapping[str, Any]) -> str:
    digest = hashlib.sha256()
    digest.update(RESULT_DIGEST_PROTOCOL.encode("ascii") + b"\0")
    _update_tree_digest(digest, result)
    return digest.hexdigest()


def make_idempotency_key(operation: str, *parts: object) -> str:
    safe_operation = "".join(
        character
        for character in operation.casefold()
        if character.isalnum() or character == "-"
    )
    if not safe_operation:
        raise ValueError("operation is invalid")
    material = canonical_json_bytes(
        [AGENT_PROTOCOL, safe_operation, *[str(part) for part in parts]]
    )
    return f"tkb-{safe_operation}-{hashlib.sha256(material).hexdigest()}"


class ApiClient:
    def __init__(
        self,
        config: AgentConfig,
        identity: AgentIdentity,
        *,
        token: str | None = None,
        transport: HttpTransport | None = None,
        sleep: Any = time.sleep,
        stop_event: threading.Event | None = None,
    ) -> None:
        self.config = config
        self.identity = identity
        self._token = (token if token is not None else config.load_token()).strip()
        if (
            not self._token
            or len(self._token) > 4096
            or any(ord(character) < 32 for character in self._token)
        ):
            raise ApiError("bearer token is missing")
        self._worker_token: str | None = None
        self._transport = transport or UrllibTransport()
        self._sleep = sleep
        self._stop_event = stop_event

    def _raise_if_stopped(self) -> None:
        if self._stop_event is not None and self._stop_event.is_set():
            raise ApiError("Agent shutdown was requested")

    def _wait_before_retry(self, delay: float) -> None:
        if self._stop_event is None:
            self._sleep(delay)
            return
        if self._stop_event.wait(max(0.0, delay)):
            self._raise_if_stopped()

    def _require_worker_token(self) -> str:
        if self._worker_token is None:
            raise ApiError("Agent must complete /hello before requesting work")
        return self._worker_token

    def _retry_delay(self, attempt: int, response: HttpResponse | None = None) -> float:
        if response is not None:
            raw = response.headers.get("retry-after")
            if raw:
                try:
                    return min(30.0, max(0.0, float(raw)))
                except ValueError:
                    pass
        return min(30.0, self.config.retry_backoff_seconds * (2**attempt))

    def _post(
        self,
        path: str,
        payload: Mapping[str, Any],
        *,
        expected: Sequence[int],
        idempotency_key: str | None = None,
        timeout: float | None = None,
        max_body_bytes: int | None = None,
        retry_attempts: int | None = None,
    ) -> tuple[int, dict[str, Any] | None]:
        if not path.startswith("/") or "?" in path or "#" in path:
            raise ValueError("API path must be absolute and must not contain a query")
        encoded = canonical_json_bytes(payload)
        outgoing_limit = max_body_bytes or self.config.max_request_bytes
        if len(encoded) > outgoing_limit:
            raise ApiError("outgoing JSON exceeded the configured size limit")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": f"TKBCherry-AgentHelper/{self.identity.version}",
            "X-TKB-Agent-Id": self.identity.agent_id,
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        url = self.config.api_base + path
        last_transport_error: TransportError | None = None
        attempts = (
            self.config.retry_attempts
            if retry_attempts is None
            else max(1, retry_attempts)
        )
        for attempt in range(attempts):
            self._raise_if_stopped()
            response: HttpResponse | None = None
            try:
                response = self._transport.request(
                    method="POST",
                    url=url,
                    headers=headers,
                    body=encoded,
                    timeout=timeout or self.config.request_timeout_seconds,
                    max_response_bytes=self.config.max_http_response_bytes,
                )
            except TransportError as exc:
                last_transport_error = exc
                if attempt + 1 < attempts:
                    self._wait_before_retry(self._retry_delay(attempt))
                    continue
                raise ApiError(f"request to {path} failed after retries") from exc

            if response.status in expected:
                if response.status == 204:
                    if response.body.strip():
                        raise ApiError(
                            f"server returned a body with HTTP 204 for {path}",
                            status=response.status,
                        )
                    return response.status, None
                if not response.body.strip():
                    raise ApiError(
                        f"server returned an empty JSON response for {path}",
                        status=response.status,
                    )
                try:
                    decoded = json.loads(
                        response.body.decode("utf-8"),
                        parse_constant=_reject_json_constant,
                    )
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                    raise ApiError(
                        f"server returned invalid JSON for {path}",
                        status=response.status,
                    ) from exc
                if not isinstance(decoded, dict):
                    raise ApiError(
                        f"server returned a non-object JSON response for {path}",
                        status=response.status,
                    )
                if decoded.get("protocol") != AGENT_PROTOCOL:
                    raise ApiError(
                        f"server returned an unsupported protocol for {path}",
                        status=response.status,
                    )
                if decoded.get("ok") is not True:
                    raise ApiError(
                        f"server returned an unsuccessful response for {path}",
                        status=response.status,
                    )
                return response.status, decoded

            if response.status in _RETRYABLE_STATUSES and attempt + 1 < attempts:
                self._wait_before_retry(self._retry_delay(attempt, response))
                continue
            raise ApiError(
                f"server rejected {path} with HTTP {response.status}",
                status=response.status,
            )

        raise ApiError(
            f"request to {path} failed after retries"
        ) from last_transport_error

    def hello(self) -> dict[str, Any] | None:
        _, response = self._post(
            "/hello",
            {
                "protocol": AGENT_PROTOCOL,
                "agent": self.identity.to_wire(),
                "capacity": {
                    "cpuWorkers": self.config.cpu_workers,
                    "maxConcurrentJobs": 1,
                },
            },
            expected=(200, 201, 202),
        )
        if not response:
            raise ApiError("hello response did not include a workerToken")
        worker_token = response.get("workerToken")
        if (
            not isinstance(worker_token, str)
            or len(worker_token) < 32
            or len(worker_token) > 512
            or any(
                ord(character) < 33 or ord(character) > 126
                for character in worker_token
            )
        ):
            raise ApiError("hello response included an invalid workerToken")
        # The server-issued token is session-bound and deliberately kept only
        # in process memory. It is never persisted or included in diagnostics.
        self._worker_token = worker_token
        return response

    def heartbeat(self, status: str = "idle") -> dict[str, Any] | None:
        _, response = self._post(
            "/heartbeat",
            {
                "protocol": AGENT_PROTOCOL,
                "agentId": self.identity.agent_id,
                "workerToken": self._require_worker_token(),
                "status": status,
                "capacity": {
                    "cpuWorkers": self.config.cpu_workers,
                    "maxConcurrentJobs": 1,
                },
            },
            expected=(200, 202, 204),
            timeout=min(
                float(self.config.request_timeout_seconds),
                max(1.0, float(self.config.heartbeat_seconds)),
            ),
            retry_attempts=1,
        )
        return response

    def lease(self) -> Lease | None:
        request_id = str(uuid.uuid4())
        status, response = self._post(
            "/lease",
            {
                "protocol": AGENT_PROTOCOL,
                "workerToken": self._require_worker_token(),
                "leaseRequestId": request_id,
                "agent": self.identity.to_wire(),
                "capacity": {
                    "cpuWorkers": self.config.cpu_workers,
                    "maxConcurrentJobs": 1,
                },
                "waitSeconds": self.config.poll_wait_seconds,
            },
            expected=(200, 204),
            idempotency_key=make_idempotency_key(
                "lease", self.identity.agent_id, request_id
            ),
            # The server is expected to answer when waitSeconds elapses. A
            # small transport margin keeps the socket bounded without turning
            # a configured 60-second poll into a guaranteed early timeout.
            timeout=max(1.0, float(self.config.poll_wait_seconds) + 5.0),
        )
        if status == 204 or response is None:
            return None
        return Lease.from_response(
            response,
            configured_cpu_workers=self.config.cpu_workers,
            default_timeout_seconds=self.config.solver_timeout_seconds,
            maximum_timeout_seconds=self.config.solver_timeout_seconds,
        )

    def lease_heartbeat(
        self,
        lease: Lease,
        *,
        elapsed_seconds: float,
        remaining_seconds: float,
        phase: str = "solving",
    ) -> bool:
        escaped = quote(lease.lease_id, safe="")
        _, response = self._post(
            f"/leases/{escaped}/heartbeat",
            {
                "protocol": AGENT_PROTOCOL,
                "agentId": self.identity.agent_id,
                "workerToken": self._require_worker_token(),
                "jobId": lease.job_id,
                "leaseId": lease.lease_id,
                "phase": phase
                if phase in {"solving", "uploading", "committing"}
                else "solving",
                "progress": {
                    "elapsedSeconds": round(max(0.0, elapsed_seconds), 3),
                    "remainingSeconds": round(max(0.0, remaining_seconds), 3),
                },
            },
            expected=(200, 202, 204),
            timeout=min(
                float(self.config.request_timeout_seconds),
                max(1.0, float(self.config.heartbeat_seconds)),
            ),
            retry_attempts=1,
        )
        if not response:
            return False
        return response.get("cancel") is True or response.get("action") == "cancel"

    def candidate(
        self,
        lease: Lease,
        *,
        solver_status: int,
        result: Mapping[str, Any],
    ) -> tuple[str, str]:
        digest = result_digest(result)
        escaped = quote(lease.lease_id, safe="")
        idempotency_key = make_idempotency_key(
            "candidate",
            self.identity.agent_id,
            lease.job_id,
            lease.lease_id,
            digest,
            solver_status,
        )
        _, response = self._post(
            f"/leases/{escaped}/candidate",
            {
                "protocol": AGENT_PROTOCOL,
                "agentId": self.identity.agent_id,
                "workerToken": self._require_worker_token(),
                "jobId": lease.job_id,
                "leaseId": lease.lease_id,
                "sha256": digest,
                "digestProtocol": RESULT_DIGEST_PROTOCOL,
                "solverProtocol": SOLVER_PROTOCOL,
                "solverStatus": solver_status,
                "result": dict(result),
            },
            expected=(200, 201, 202),
            idempotency_key=idempotency_key,
            max_body_bytes=self.config.max_result_bytes + (1024 * 1024),
        )
        if not response:
            raise ApiError("candidate response did not include a candidateId")
        candidate_id = validate_identifier("candidateId", response.get("candidateId"))
        server_digest = response.get("sha256")
        if (
            not isinstance(server_digest, str)
            or len(server_digest) != 64
            or any(character not in "0123456789abcdef" for character in server_digest)
        ):
            raise ApiError("candidate response included an invalid sha256")
        return candidate_id, server_digest

    def complete(
        self,
        lease: Lease,
        *,
        candidate_id: str,
        digest: str,
        solver_status: int,
    ) -> None:
        candidate_id = validate_identifier("candidateId", candidate_id)
        if not isinstance(digest, str) or len(digest) != 64:
            raise ProtocolError("candidate digest is invalid")
        escaped = quote(lease.lease_id, safe="")
        idempotency_key = make_idempotency_key(
            "complete",
            self.identity.agent_id,
            lease.job_id,
            lease.lease_id,
            candidate_id,
            digest,
            solver_status,
        )
        self._post(
            f"/leases/{escaped}/complete",
            {
                "protocol": AGENT_PROTOCOL,
                "agentId": self.identity.agent_id,
                "workerToken": self._require_worker_token(),
                "jobId": lease.job_id,
                "leaseId": lease.lease_id,
                "candidateId": candidate_id,
                "sha256": digest,
                "solverStatus": solver_status,
            },
            expected=(200, 202, 204),
            idempotency_key=idempotency_key,
        )

    def fail(self, lease: Lease, *, kind: str, message: str) -> None:
        safe_kind = "".join(
            character
            for character in kind.casefold()
            if character.isalnum() or character in "_-"
        )[:64]
        if not safe_kind:
            safe_kind = "agent_failure"
        safe_message = " ".join(str(message).split())[:500]
        escaped = quote(lease.lease_id, safe="")
        idempotency_key = make_idempotency_key(
            "fail",
            self.identity.agent_id,
            lease.job_id,
            lease.lease_id,
            safe_kind,
            safe_message,
        )
        try:
            self._post(
                f"/leases/{escaped}/fail",
                {
                    "protocol": AGENT_PROTOCOL,
                    "agentId": self.identity.agent_id,
                    "workerToken": self._require_worker_token(),
                    "jobId": lease.job_id,
                    "leaseId": lease.lease_id,
                    "failure": {"kind": safe_kind, "message": safe_message},
                },
                expected=(200, 202, 204),
                idempotency_key=idempotency_key,
            )
        except ApiError as exc:
            if exc.status not in {409, 410}:
                raise
