from __future__ import annotations

import unittest
from unittest.mock import patch

from agent_helper.models import Lease, ProtocolError


def lease_response() -> dict[str, object]:
    return {
        "ok": True,
        "lease": {
            "jobId": "job-123",
            "leaseId": "lease-456",
            "attempt": 2,
            "leaseExpiresAt": "2026-07-14T12:00:00Z",
            "payload": {"data": {"classes": []}, "settings": {"mode": "fast"}},
            "limits": {"cpuWorkers": 12, "timeoutSeconds": 120},
        },
    }


class LeaseModelTests(unittest.TestCase):
    @patch("agent_helper.models.os.cpu_count", return_value=8)
    def test_validates_and_clamps_server_limits(self, cpu_count: object) -> None:
        del cpu_count
        lease = Lease.from_response(
            lease_response(),
            configured_cpu_workers=4,
            default_timeout_seconds=90,
            maximum_timeout_seconds=100,
        )
        self.assertIsNotNone(lease)
        assert lease is not None
        self.assertEqual(lease.limits.cpu_workers, 4)
        self.assertEqual(lease.limits.timeout_seconds, 90)
        self.assertEqual(lease.attempt, 2)

    def test_accepts_explicit_no_work_response(self) -> None:
        self.assertIsNone(
            Lease.from_response(
                {"ok": True, "lease": None},
                configured_cpu_workers=2,
                default_timeout_seconds=30,
                maximum_timeout_seconds=30,
            )
        )

    def test_rejects_unsafe_identifier(self) -> None:
        response = lease_response()
        response["lease"]["leaseId"] = "../../another-path"  # type: ignore[index]
        with self.assertRaises(ProtocolError):
            Lease.from_response(
                response,
                configured_cpu_workers=2,
                default_timeout_seconds=30,
                maximum_timeout_seconds=30,
            )

    def test_rejects_missing_data_or_non_object_settings(self) -> None:
        for payload in ({"settings": {}}, {"data": {}, "settings": []}):
            response = lease_response()
            response["lease"]["payload"] = payload  # type: ignore[index]
            with self.subTest(payload=payload), self.assertRaises(ProtocolError):
                Lease.from_response(
                    response,
                    configured_cpu_workers=2,
                    default_timeout_seconds=30,
                    maximum_timeout_seconds=30,
                )


if __name__ == "__main__":
    unittest.main()
