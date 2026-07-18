"""Validated wire models shared by the Agent Helper components."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping


_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class ProtocolError(ValueError):
    """Raised when the server returns an invalid protocol object."""


def validate_identifier(name: str, value: Any) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise ProtocolError(f"{name} is missing or invalid")
    return value


def _positive_int(name: str, value: Any, *, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > maximum
    ):
        raise ProtocolError(f"{name} must be an integer between 1 and {maximum}")
    return value


def clamp_cpu_workers(requested: int, configured: int) -> int:
    local_cpu = max(1, os.cpu_count() or 1)
    return max(1, min(requested, configured, local_cpu))


@dataclass(frozen=True, slots=True)
class AgentIdentity:
    agent_id: str
    version: str
    platform: str

    def __post_init__(self) -> None:
        validate_identifier("agentId", self.agent_id)
        if (
            not isinstance(self.version, str)
            or not self.version
            or len(self.version) > 64
        ):
            raise ProtocolError("agent version is invalid")
        if (
            not isinstance(self.platform, str)
            or not self.platform
            or len(self.platform) > 64
        ):
            raise ProtocolError("agent platform is invalid")

    def to_wire(self) -> dict[str, str]:
        return {
            "agentId": self.agent_id,
            "version": self.version,
            "platform": self.platform,
        }


@dataclass(frozen=True, slots=True)
class LeaseLimits:
    cpu_workers: int
    timeout_seconds: int


@dataclass(frozen=True, slots=True)
class Lease:
    job_id: str
    lease_id: str
    attempt: int
    lease_expires_at: str | None
    payload: dict[str, Any]
    limits: LeaseLimits

    @classmethod
    def from_response(
        cls,
        response: Mapping[str, Any],
        *,
        configured_cpu_workers: int,
        default_timeout_seconds: int,
        maximum_timeout_seconds: int,
    ) -> "Lease | None":
        if response.get("ok") is not True:
            raise ProtocolError("lease response was not accepted by the server")
        if "lease" not in response:
            raise ProtocolError("lease response is missing the lease field")
        raw = response.get("lease")
        if raw is None:
            return None
        if not isinstance(raw, Mapping):
            raise ProtocolError("lease must be an object or null")

        job_id = validate_identifier("jobId", raw.get("jobId"))
        lease_id = validate_identifier("leaseId", raw.get("leaseId"))
        attempt = _positive_int("attempt", raw.get("attempt", 1), maximum=1_000_000)

        expires = raw.get("leaseExpiresAt")
        if expires is not None:
            if not isinstance(expires, str) or len(expires) > 64:
                raise ProtocolError("leaseExpiresAt must be an ISO-8601 string")
            try:
                parsed = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ProtocolError(
                    "leaseExpiresAt must be an ISO-8601 string"
                ) from exc
            if parsed.tzinfo is None:
                raise ProtocolError("leaseExpiresAt must include a timezone")

        raw_payload = raw.get("payload")
        if not isinstance(raw_payload, Mapping):
            raise ProtocolError("lease payload must be an object")
        if not isinstance(raw_payload.get("data"), Mapping):
            raise ProtocolError("lease payload.data must be an object")
        settings = raw_payload.get("settings", {})
        if not isinstance(settings, Mapping):
            raise ProtocolError("lease payload.settings must be an object")
        try:
            payload = json.loads(
                json.dumps(
                    raw_payload,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            )
        except (TypeError, ValueError) as exc:
            raise ProtocolError("lease payload must contain valid JSON values") from exc
        payload.setdefault("settings", {})

        raw_limits = raw.get("limits", {})
        if not isinstance(raw_limits, Mapping):
            raise ProtocolError("lease limits must be an object")
        requested_cpu = _positive_int(
            "limits.cpuWorkers",
            raw_limits.get("cpuWorkers", configured_cpu_workers),
            maximum=65_536,
        )
        requested_timeout = _positive_int(
            "limits.timeoutSeconds",
            raw_limits.get("timeoutSeconds", default_timeout_seconds),
            maximum=86_400,
        )
        limits = LeaseLimits(
            cpu_workers=clamp_cpu_workers(requested_cpu, configured_cpu_workers),
            timeout_seconds=min(
                requested_timeout, default_timeout_seconds, maximum_timeout_seconds
            ),
        )
        return cls(
            job_id=job_id,
            lease_id=lease_id,
            attempt=attempt,
            lease_expires_at=expires,
            payload=payload,
            limits=limits,
        )
