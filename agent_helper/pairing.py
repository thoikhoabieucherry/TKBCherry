"""Browser-approved device pairing for first-run Agent credentials."""

from __future__ import annotations

import json
import logging
import socket
import threading
import time
import webbrowser
from typing import Any, Mapping
from urllib.parse import urljoin, urlsplit

from . import AGENT_PROTOCOL
from .api import HttpTransport, TransportError, UrllibTransport, canonical_json_bytes
from .config import AgentConfig
from .models import AgentIdentity, ProtocolError


LOGGER = logging.getLogger("agent_helper")


class PairingError(RuntimeError):
    """A sanitized first-run pairing failure."""


def _safe_json(response_body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            response_body.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant: {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProtocolError("pairing response is not valid JSON") from exc
    if not isinstance(value, dict) or value.get("protocol") != AGENT_PROTOCOL:
        raise ProtocolError("pairing response uses an incompatible protocol")
    return value


class PairingClient:
    def __init__(
        self,
        config: AgentConfig,
        identity: AgentIdentity,
        *,
        transport: HttpTransport | None = None,
        monotonic: Any = time.monotonic,
        wall_time: Any = time.time,
    ) -> None:
        self.config = config
        self.identity = identity
        self.transport = transport or UrllibTransport()
        self.monotonic = monotonic
        self.wall_time = wall_time

    def _post(self, path: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        try:
            response = self.transport.request(
                method="POST",
                url=self.config.api_base + path,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json; charset=utf-8",
                    "User-Agent": f"TKBCherry-Agent/{self.identity.version}",
                    "X-TKB-Agent-Id": self.identity.agent_id,
                },
                body=canonical_json_bytes(payload),
                timeout=float(self.config.request_timeout_seconds),
                max_response_bytes=min(
                    self.config.max_http_response_bytes, 1024 * 1024
                ),
            )
        except TransportError as exc:
            raise PairingError("cannot reach the TKBCherry pairing service") from exc
        value = _safe_json(response.body)
        if response.status not in {200, 201, 202} or value.get("ok") is not True:
            raise PairingError("the pairing request was rejected or expired")
        return value

    def _verification_url(self, raw: object) -> str:
        value = str(raw or "").strip()
        if not value:
            raise ProtocolError("pairing response is missing verificationUrl")
        base = urlsplit(self.config.api_base)
        target = urlsplit(urljoin(self.config.api_base + "/", value))
        if (
            target.scheme != base.scheme
            or target.hostname != base.hostname
            or target.port != base.port
            or target.scheme != "https"
        ):
            raise ProtocolError("pairing verificationUrl is outside TKBCherry")
        return target.geturl()

    def pair(self, stop_event: threading.Event | None = None) -> str:
        stop = stop_event or threading.Event()
        started = self._post(
            "/pair/start",
            {
                "protocol": AGENT_PROTOCOL,
                "agent": {
                    "agentId": self.identity.agent_id,
                    "name": socket.gethostname()[:80] or "Windows PC",
                    "version": self.identity.version,
                    "platform": self.identity.platform,
                },
            },
        )
        device_code = str(started.get("deviceCode") or "").strip()
        user_code = str(started.get("userCode") or "").strip().upper()
        if (
            len(device_code) < 32
            or len(device_code) > 512
            or len(user_code) != 9
            or user_code[4:5] != "-"
        ):
            raise ProtocolError("pairing response contains an invalid device code")
        verification_url = self._verification_url(started.get("verificationUrl"))
        expires_at_ms = int(started.get("expiresAtMs") or 0)
        remaining_seconds = max(
            1.0, (expires_at_ms / 1000.0) - float(self.wall_time())
        )
        deadline = self.monotonic() + min(600.0, remaining_seconds)
        poll_seconds = max(
            0.5, min(10.0, float(started.get("pollEveryMs") or 1500) / 1000.0)
        )

        LOGGER.info("Open the browser to approve Agent code %s.", user_code)
        opened = False
        try:
            opened = bool(webbrowser.open(verification_url, new=2, autoraise=True))
        except (OSError, webbrowser.Error):
            opened = False
        if not opened:
            LOGGER.info("Pairing page: %s", verification_url)

        while not stop.is_set() and self.monotonic() < deadline:
            result = self._post(
                "/pair/status",
                {"protocol": AGENT_PROTOCOL, "deviceCode": device_code},
            )
            status = str(result.get("status") or "").strip().casefold()
            if result.get("approved") is True or status == "approved":
                token = str(result.get("agentToken") or "").strip()
                if not token.startswith("tkba_") or len(token) > 512:
                    raise ProtocolError("approved pairing omitted the Agent credential")
                return token
            if status not in {"", "pending"}:
                raise PairingError("the pairing request was rejected or expired")
            stop.wait(poll_seconds)
        if stop.is_set():
            raise PairingError("Agent pairing was cancelled")
        raise PairingError("Agent pairing expired; reopen Agent to try again")

