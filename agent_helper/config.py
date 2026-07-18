"""Configuration loading and security validation for Agent Helper."""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit


DEFAULT_API_BASE = "https://tkbcherry.com/api/agent-helper/v1"
DEFAULT_TOKEN_ENV = "TKB_AGENT_TOKEN"
_MAX_CONFIG_BYTES = 64 * 1024
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_INLINE_SECRET_KEYS = {
    "authorization",
    "bearer",
    "client_secret",
    "password",
    "secret",
    "token",
    "access_token",
    "api_key",
    "api_token",
}


class ConfigError(ValueError):
    """Raised when local configuration is unsafe or malformed."""


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _detected_cpu_workers() -> int:
    return max(1, os.cpu_count() or 1)


def _default_cpu_workers() -> int:
    return _detected_cpu_workers()


def _physical_memory_bytes() -> int:
    """Return installed physical RAM without adding a runtime dependency."""

    try:
        if os.name == "nt":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("length", ctypes.c_ulong),
                    ("memory_load", ctypes.c_ulong),
                    ("total_physical", ctypes.c_ulonglong),
                    ("available_physical", ctypes.c_ulonglong),
                    ("total_page_file", ctypes.c_ulonglong),
                    ("available_page_file", ctypes.c_ulonglong),
                    ("total_virtual", ctypes.c_ulonglong),
                    ("available_virtual", ctypes.c_ulonglong),
                    ("available_extended_virtual", ctypes.c_ulonglong),
                ]

            status = MemoryStatus()
            status.length = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.total_physical)
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
        page_count = int(os.sysconf("SC_PHYS_PAGES"))
        return page_size * page_count
    except (AttributeError, OSError, TypeError, ValueError):
        return 64 * 1024 * 1024 * 1024


def _physical_memory_mb() -> int:
    detected = _physical_memory_bytes() // (1024 * 1024)
    return max(512, min(int(detected), 1_048_576))


def _default_max_memory_mb() -> int:
    return _physical_memory_mb()


def _is_loopback_host(hostname: str | None) -> bool:
    if not hostname:
        return False
    return hostname.casefold() in {"localhost", "127.0.0.1", "::1"}


def _validate_api_base(value: str, allow_local_http: bool) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError("api_base must be a non-empty URL")
    normalized = value.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.username or parsed.password:
        raise ConfigError("api_base must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ConfigError("api_base must not contain a query or fragment")
    if not parsed.hostname:
        raise ConfigError("api_base must include a hostname")
    if parsed.scheme == "https":
        return normalized
    if (
        parsed.scheme == "http"
        and allow_local_http
        and _is_loopback_host(parsed.hostname)
    ):
        return normalized
    raise ConfigError(
        "api_base must use HTTPS (HTTP is allowed only for explicit loopback development)"
    )


def _reject_inline_secrets(value: Any, path: str = "config") -> None:
    if isinstance(value, Mapping):
        for raw_key, child in value.items():
            key = str(raw_key).strip().casefold().replace("-", "_")
            child_path = f"{path}.{raw_key}"
            if key in _INLINE_SECRET_KEYS:
                raise ConfigError(
                    f"inline secrets are forbidden: {child_path}; use token_env"
                )
            _reject_inline_secrets(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_inline_secrets(child, f"{path}[{index}]")


def _integer(name: str, value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return value


def _number(name: str, value: Any, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return result


@dataclass(frozen=True, slots=True)
class AgentConfig:
    """Non-secret Agent Helper configuration.

    The bearer token is deliberately not a field. It is read on demand from
    ``token_env`` so dataclass representations and config files cannot expose it.
    """

    api_base: str = DEFAULT_API_BASE
    token_env: str = DEFAULT_TOKEN_ENV
    cpu_workers: int = _default_cpu_workers()
    poll_wait_seconds: int = 20
    heartbeat_seconds: float = 5.0
    request_timeout_seconds: int = 35
    idle_backoff_seconds: float = 2.0
    solver_timeout_seconds: int = 1800
    max_memory_mb: int = _default_max_memory_mb()
    max_request_bytes: int = 32 * 1024 * 1024
    max_result_bytes: int = 64 * 1024 * 1024
    max_stderr_bytes: int = 8 * 1024 * 1024
    max_http_response_bytes: int = 64 * 1024 * 1024
    retry_attempts: int = 4
    retry_backoff_seconds: float = 0.5
    allow_local_http: bool = False

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any] | None) -> "AgentConfig":
        values = dict(raw or {})
        _reject_inline_secrets(values)
        allowed = {field.name for field in fields(cls)}
        unknown = sorted(set(values) - allowed)
        if unknown:
            raise ConfigError(f"unknown configuration key(s): {', '.join(unknown)}")

        allow_local_http = values.get("allow_local_http", False)
        if not isinstance(allow_local_http, bool):
            raise ConfigError("allow_local_http must be true or false")

        token_env = values.get("token_env", DEFAULT_TOKEN_ENV)
        if not isinstance(token_env, str) or not _ENV_NAME_RE.fullmatch(token_env):
            raise ConfigError("token_env must be a valid environment variable name")

        cpu_ceiling = _detected_cpu_workers()
        requested_cpu_workers = _integer(
            "cpu_workers",
            values.get("cpu_workers", _default_cpu_workers()),
            1,
            256,
        )
        checked: dict[str, Any] = {
            "api_base": _validate_api_base(
                values.get("api_base", DEFAULT_API_BASE), allow_local_http
            ),
            "token_env": token_env,
            "cpu_workers": min(requested_cpu_workers, cpu_ceiling),
            "poll_wait_seconds": _integer(
                "poll_wait_seconds", values.get("poll_wait_seconds", 20), 0, 60
            ),
            "heartbeat_seconds": _number(
                "heartbeat_seconds", values.get("heartbeat_seconds", 5.0), 0.1, 300.0
            ),
            "request_timeout_seconds": _integer(
                "request_timeout_seconds",
                values.get("request_timeout_seconds", 35),
                1,
                300,
            ),
            "idle_backoff_seconds": _number(
                "idle_backoff_seconds",
                values.get("idle_backoff_seconds", 2.0),
                0.0,
                300.0,
            ),
            "solver_timeout_seconds": _integer(
                "solver_timeout_seconds",
                values.get("solver_timeout_seconds", 1800),
                1,
                86_400,
            ),
            "max_memory_mb": min(
                _integer(
                    "max_memory_mb",
                    values.get("max_memory_mb", _default_max_memory_mb()),
                    512,
                    1_048_576,
                ),
                _physical_memory_mb(),
            ),
            "max_request_bytes": _integer(
                "max_request_bytes",
                values.get("max_request_bytes", 32 * 1024 * 1024),
                1_024,
                256 * 1024 * 1024,
            ),
            "max_result_bytes": _integer(
                "max_result_bytes",
                values.get("max_result_bytes", 64 * 1024 * 1024),
                1_024,
                256 * 1024 * 1024,
            ),
            "max_stderr_bytes": _integer(
                "max_stderr_bytes",
                values.get("max_stderr_bytes", 8 * 1024 * 1024),
                1_024,
                64 * 1024 * 1024,
            ),
            "max_http_response_bytes": _integer(
                "max_http_response_bytes",
                values.get("max_http_response_bytes", 64 * 1024 * 1024),
                1_024,
                256 * 1024 * 1024,
            ),
            "retry_attempts": _integer(
                "retry_attempts", values.get("retry_attempts", 4), 1, 10
            ),
            "retry_backoff_seconds": _number(
                "retry_backoff_seconds",
                values.get("retry_backoff_seconds", 0.5),
                0.0,
                30.0,
            ),
            "allow_local_http": allow_local_http,
        }
        return cls(**checked)

    @classmethod
    def load(cls, path: str | os.PathLike[str] | None = None) -> "AgentConfig":
        if path is None:
            return cls.from_mapping({})
        config_path = Path(path).expanduser()
        try:
            raw_bytes = config_path.read_bytes()
        except OSError as exc:
            raise ConfigError(f"cannot read config file: {config_path}") from exc
        if len(raw_bytes) > _MAX_CONFIG_BYTES:
            raise ConfigError("config file is too large")
        try:
            parsed = json.loads(
                raw_bytes.decode("utf-8"),
                parse_constant=_reject_json_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ConfigError("config file must be valid UTF-8 JSON") from exc
        if not isinstance(parsed, dict):
            raise ConfigError("config file root must be a JSON object")
        return cls.from_mapping(parsed)

    def load_token(self, environ: Mapping[str, str] | None = None) -> str:
        source = os.environ if environ is None else environ
        value = source.get(self.token_env, "").strip()
        if not value:
            raise ConfigError(
                f"required environment variable is missing: {self.token_env}"
            )
        if len(value) > 4096 or any(ord(character) < 32 for character in value):
            raise ConfigError(
                f"environment variable {self.token_env} contains an invalid token"
            )
        return value
