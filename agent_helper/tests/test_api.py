from __future__ import annotations

import json
import threading
import unittest

from agent_helper import AGENT_PROTOCOL
from agent_helper.api import (
    ApiClient,
    ApiError,
    HttpResponse,
    RESULT_DIGEST_PROTOCOL,
    TransportError,
    make_idempotency_key,
    result_digest,
)
from agent_helper.config import AgentConfig
from agent_helper.models import AgentIdentity, Lease, LeaseLimits


class FakeTransport:
    def __init__(self, responses: list[HttpResponse | BaseException]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: object) -> HttpResponse:
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected HTTP request")
        response_value = self.responses.pop(0)
        if isinstance(response_value, BaseException):
            raise response_value
        return response_value


def response(status: int, payload: dict[str, object] | None = None) -> HttpResponse:
    body = b"" if payload is None else json.dumps(payload).encode("utf-8")
    return HttpResponse(status=status, body=body, headers={})


def identity() -> AgentIdentity:
    return AgentIdentity(
        agent_id="123e4567-e89b-12d3-a456-426614174000",
        version="0.1.0",
        platform="windows-amd64",
    )


def lease() -> Lease:
    return Lease(
        job_id="job-1",
        lease_id="lease-1",
        attempt=1,
        lease_expires_at=None,
        payload={"data": {}, "settings": {}},
        limits=LeaseLimits(cpu_workers=2, timeout_seconds=30),
    )


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = AgentConfig.from_mapping(
            {
                "cpu_workers": 2,
                "retry_attempts": 1,
                "poll_wait_seconds": 0,
            }
        )

    def test_lease_supports_http_204_no_work(self) -> None:
        registered = {
            "protocol": AGENT_PROTOCOL,
            "ok": True,
            "workerToken": "f" * 64,
        }
        transport = FakeTransport([response(200, registered), response(204)])
        client = ApiClient(
            self.config, identity(), token="test-token", transport=transport
        )
        client.hello()
        self.assertIsNone(client.lease())
        headers = transport.calls[1]["headers"]
        self.assertEqual(headers["Authorization"], "Bearer test-token")  # type: ignore[index]
        self.assertNotIn(b"test-token", transport.calls[1]["body"])  # type: ignore[operator]
        lease_body = json.loads(transport.calls[1]["body"])  # type: ignore[arg-type]
        self.assertEqual(lease_body["workerToken"], "f" * 64)

    def test_candidate_digest_and_idempotency_are_stable(self) -> None:
        accepted = {
            "protocol": AGENT_PROTOCOL,
            "ok": True,
            "candidateId": "candidate-1",
            "sha256": result_digest({"a": 1, "b": 2}),
        }
        registered = {
            "protocol": AGENT_PROTOCOL,
            "ok": True,
            "workerToken": "f" * 64,
        }
        transport = FakeTransport(
            [
                response(200, registered),
                response(201, accepted),
                response(201, accepted),
            ]
        )
        client = ApiClient(
            self.config, identity(), token="test-token", transport=transport
        )
        client.hello()
        first = client.candidate(lease(), solver_status=200, result={"b": 2, "a": 1})
        second = client.candidate(lease(), solver_status=200, result={"a": 1, "b": 2})
        self.assertEqual(first, second)
        first_headers = transport.calls[1]["headers"]
        second_headers = transport.calls[2]["headers"]
        self.assertEqual(
            first_headers["Idempotency-Key"], second_headers["Idempotency-Key"]
        )  # type: ignore[index]
        first_body = json.loads(transport.calls[1]["body"])  # type: ignore[arg-type]
        self.assertEqual(first_body["sha256"], result_digest({"a": 1, "b": 2}))
        self.assertEqual(first_body["digestProtocol"], RESULT_DIGEST_PROTOCOL)

    def test_idempotency_key_changes_with_operation(self) -> None:
        first = make_idempotency_key("candidate", "lease", "digest")
        second = make_idempotency_key("complete", "lease", "digest")
        self.assertNotEqual(first, second)
        self.assertEqual(first, make_idempotency_key("candidate", "lease", "digest"))

    def test_tree_digest_is_order_stable_and_preserves_number_types(self) -> None:
        first = result_digest({"b": [1e-7, -0.0], "a": 1})
        second = result_digest({"a": 1, "b": [1e-7, -0.0]})
        self.assertEqual(first, second)
        self.assertNotEqual(result_digest({"value": 1}), result_digest({"value": 1.0}))
        self.assertEqual(len(first), 64)
        self.assertEqual(
            result_digest({"a": 1, "b": [1e-7, -0.0], "c": "đ"}),
            "08ff413feef63ffe43b690d4bccb07ce3dbf6cff38d312c9cfc32ed82a464a31",
        )

    def test_success_json_requires_protocol_ok_and_nonempty_body(self) -> None:
        for malformed in (
            response(200),
            response(200, {"ok": True, "workerToken": "f" * 64}),
            response(
                200,
                {
                    "protocol": AGENT_PROTOCOL,
                    "ok": False,
                    "workerToken": "f" * 64,
                },
            ),
        ):
            with self.subTest(body=malformed.body):
                client = ApiClient(
                    self.config,
                    identity(),
                    token="test-token",
                    transport=FakeTransport([malformed]),
                )
                with self.assertRaises(ApiError):
                    client.hello()

    def test_lease_retry_reuses_request_id_and_idempotency_key(self) -> None:
        config = AgentConfig.from_mapping(
            {
                "cpu_workers": 2,
                "retry_attempts": 2,
                "retry_backoff_seconds": 0,
                "poll_wait_seconds": 0,
            }
        )
        registered = {
            "protocol": AGENT_PROTOCOL,
            "ok": True,
            "workerToken": "f" * 64,
        }
        no_work = {"protocol": AGENT_PROTOCOL, "ok": True, "lease": None}
        transport = FakeTransport(
            [
                response(200, registered),
                TransportError("lost response"),
                response(200, no_work),
            ]
        )
        client = ApiClient(
            config,
            identity(),
            token="test-token",
            transport=transport,
            sleep=lambda seconds: None,
        )
        client.hello()
        self.assertIsNone(client.lease())
        first, second = transport.calls[1], transport.calls[2]
        self.assertEqual(first["body"], second["body"])
        self.assertEqual(
            first["headers"]["Idempotency-Key"],  # type: ignore[index]
            second["headers"]["Idempotency-Key"],  # type: ignore[index]
        )

    def test_shutdown_interrupts_network_retry_backoff(self) -> None:
        stop_event = threading.Event()
        registered = {
            "protocol": AGENT_PROTOCOL,
            "ok": True,
            "workerToken": "f" * 64,
        }

        class StopOnLeaseTransport(FakeTransport):
            def request(self, **kwargs: object) -> HttpResponse:
                try:
                    return super().request(**kwargs)
                except TransportError:
                    stop_event.set()
                    raise

        transport = StopOnLeaseTransport(
            [response(200, registered), TransportError("offline")]
        )
        config = AgentConfig.from_mapping(
            {
                "cpu_workers": 2,
                "retry_attempts": 4,
                "retry_backoff_seconds": 30,
                "poll_wait_seconds": 0,
            }
        )
        client = ApiClient(
            config,
            identity(),
            token="test-token",
            transport=transport,
            stop_event=stop_event,
        )
        client.hello()
        with self.assertRaisesRegex(ApiError, "shutdown"):
            client.lease()
        self.assertEqual(len(transport.calls), 2)


if __name__ == "__main__":
    unittest.main()
