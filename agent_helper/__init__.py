"""Outbound-only worker used to run TKBCherry's reference solver."""

from __future__ import annotations


VERSION = "1.6.24"
AGENT_PROTOCOL = "tkb-agent-helper-v1"
SOLVER_PROTOCOL = "tkb-reference-solver-stdio-v1"


__all__ = ["AGENT_PROTOCOL", "SOLVER_PROTOCOL", "VERSION"]
