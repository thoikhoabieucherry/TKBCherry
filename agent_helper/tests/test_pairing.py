from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_helper import AGENT_PROTOCOL
from agent_helper.api import HttpResponse
from agent_helper.config import AgentConfig
from agent_helper.models import AgentIdentity, ProtocolError
from agent_helper.pairing import PairingClient
from agent_helper.state import (
    StateError,
    clear_agent_token,
    load_agent_token,
    save_agent_token,
)


class SequenceTransport:
    def __init__(self, payloads: list[dict[str, object]]) -> None:
        self.payloads = list(payloads)
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: object) -> HttpResponse:
        self.calls.append(dict(kwargs))
        payload = self.payloads.pop(0)
        return HttpResponse(
            status=int(payload.pop("_status", 200)),
            body=json.dumps(payload).encode("utf-8"),
            headers={},
        )


class AdvancingStop(threading.Event):
    def __init__(self, clock: list[float]) -> None:
        super().__init__()
        self.clock = clock

    def wait(self, timeout: float | None = None) -> bool:
        self.clock[0] += float(timeout or 0)
        return self.is_set()


def identity() -> AgentIdentity:
    return AgentIdentity(
        agent_id="00000000-0000-4000-8000-000000000001",
        version="test",
        platform="windows-amd64",
    )


class PairingTests(unittest.TestCase):
    def test_first_run_opens_same_origin_verification_and_receives_token(self) -> None:
        clock = [100.0]
        transport = SequenceTransport(
            [
                {
                    "protocol": AGENT_PROTOCOL,
                    "ok": True,
                    "deviceCode": "d" * 64,
                    "userCode": "ABCD-1234",
                    "expiresAtMs": 400_000,
                    "pollEveryMs": 500,
                    "verificationUrl": "https://tkbcherry.com/pages/sapxep?agentPair=ABCD-1234",
                },
                {"protocol": AGENT_PROTOCOL, "ok": True, "status": "pending"},
                {
                    "protocol": AGENT_PROTOCOL,
                    "ok": True,
                    "status": "approved",
                    "approved": True,
                    "agentToken": "tkba_" + "a" * 64,
                    "expiresAt": 999999,
                },
            ]
        )
        client = PairingClient(
            AgentConfig(),
            identity(),
            transport=transport,
            monotonic=lambda: clock[0],
            wall_time=lambda: 100.0,
        )
        with patch("agent_helper.pairing.webbrowser.open", return_value=True) as opened:
            token = client.pair(AdvancingStop(clock))
        self.assertEqual(token, "tkba_" + "a" * 64)
        opened.assert_called_once()
        self.assertEqual(len(transport.calls), 3)
        self.assertTrue(all("Authorization" not in call["headers"] for call in transport.calls))

    def test_pairing_rejects_verification_urls_outside_tkbcherry(self) -> None:
        transport = SequenceTransport(
            [
                {
                    "protocol": AGENT_PROTOCOL,
                    "ok": True,
                    "deviceCode": "d" * 64,
                    "userCode": "ABCD-1234",
                    "expiresAtMs": 400_000,
                    "verificationUrl": "https://example.net/steal",
                }
            ]
        )
        client = PairingClient(AgentConfig(), identity(), transport=transport)
        with self.assertRaises(ProtocolError):
            client.pair()

    def test_paired_token_round_trips_and_can_be_cleared(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            token = "tkba_" + "b" * 64
            save_agent_token(token, state_dir)
            self.assertEqual(load_agent_token(state_dir), token)
            clear_agent_token(state_dir)
            self.assertIsNone(load_agent_token(state_dir))

    def test_invalid_paired_token_is_never_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(StateError):
                save_agent_token("browser-session-token", Path(directory))


if __name__ == "__main__":
    unittest.main()
