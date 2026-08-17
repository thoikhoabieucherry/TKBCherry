#!/usr/bin/env python3
"""Authenticated streaming client for the TKBCherry Cloud Run solver.

The Rust coordinator launches this helper exactly like the local reference
solver. Progress frames are copied to stderr and the final stdio wrapper is
written to stdout, so the existing watchdog/progress/result contract remains
unchanged when compute moves to Cloud Run.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import re
from typing import Final


CLOUD_PROTOCOL: Final = "tkb-cloud-solver-v1"
RESULT_PREFIX: Final = "@@TKB_RESULT@@"
PROGRESS_PREFIX: Final = "@@TKB_PROGRESS@@"
HEARTBEAT_PREFIX: Final = "@@TKB_CLOUD_HEARTBEAT@@"
MAX_REQUEST_BYTES: Final = 64 * 1024 * 1024
DIGEST_RE: Final = re.compile(r"^[0-9a-f]{64}$")
STOP_PROBE_TOKEN_RE: Final = re.compile(r"^[0-9a-f]{64}$")
STOP_PROBE_PATH: Final = "/api/internal/solver-stop-probe"
SERVICE_ACCOUNT_RE: Final = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$"
)
CLOUD_PLATFORM_SCOPE: Final = "https://www.googleapis.com/auth/cloud-platform"
CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS: Final = 295.0


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "1" if default else "0")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _cloud_url() -> str:
    raw = os.environ.get("TKB_CLOUD_RUN_URL", "").strip().rstrip("/")
    if not raw.startswith("https://") and not (
        _env_flag("TKB_CLOUD_RUN_ALLOW_HTTP") and raw.startswith("http://")
    ):
        raise RuntimeError("TKB_CLOUD_RUN_URL must be an HTTPS URL")
    return f"{raw}/solve"


def _workload_identity_token(audience: str) -> str:
    """Mint an ID token from keyless ADC such as X.509 WIF.

    ``google.oauth2.id_token.fetch_id_token`` supports metadata and service
    account files, but it deliberately does not load external-account ADC.
    A raw Workload Identity Federation credential can exchange its short-lived
    STS access token for a Cloud Run ID token through IAM Credentials instead.
    The target service account is explicit so an ADC file cannot redirect the
    dispatcher to a different identity.
    """
    import google.auth  # type: ignore
    from google.auth.transport.requests import Request  # type: ignore

    credentials, _ = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
    credentials.refresh(Request())
    access_token = str(getattr(credentials, "token", "") or "").strip()
    if not access_token:
        raise RuntimeError("Google ADC returned no federated access token")

    service_account = os.environ.get(
        "TKB_CLOUD_RUN_SERVICE_ACCOUNT", ""
    ).strip()
    if not SERVICE_ACCOUNT_RE.fullmatch(service_account):
        raise RuntimeError(
            "TKB_CLOUD_RUN_SERVICE_ACCOUNT must name the dedicated invoker"
        )
    encoded_account = urllib.parse.quote(service_account, safe="@.-")
    endpoint = (
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
        f"{encoded_account}:generateIdToken"
    )
    body = json.dumps(
        {"audience": audience, "includeEmail": True},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30.0) as response:
        payload = json.loads(response.read(MAX_REQUEST_BYTES + 1))
    token = payload.get("token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or token.count(".") != 2:
        raise RuntimeError("IAM Credentials returned no Cloud Run ID token")
    return token


def _identity_token(audience: str) -> str:
    explicit = os.environ.get("TKB_CLOUD_RUN_ID_TOKEN", "").strip()
    if explicit and _env_flag("TKB_CLOUD_RUN_ALLOW_EXPLICIT_ID_TOKEN"):
        return explicit

    primary_error: Exception | None = None
    try:
        from google.auth.transport.requests import Request  # type: ignore
        from google.oauth2 import id_token  # type: ignore

        token = id_token.fetch_id_token(Request(), audience)
        if token:
            return str(token)
    except Exception as error:
        primary_error = error

    try:
        return _workload_identity_token(audience)
    except Exception as error:
        detail = "Google ADC returned no Cloud Run identity token"
        if primary_error is not None:
            detail = "cannot obtain a Cloud Run identity token from Google ADC"
        raise RuntimeError(detail) from error


def _expected_digest() -> str:
    value = os.environ.get("TKB_CLOUD_RUN_SOLVER_DIGEST", "").strip().lower()
    if DIGEST_RE.fullmatch(value):
        return value
    if _env_flag("TKB_CLOUD_RUN_ALLOW_UNPINNED_DIGEST"):
        return ""
    raise RuntimeError(
        "TKB_CLOUD_RUN_SOLVER_DIGEST must be a 64-character build digest"
    )


def _stop_probe_headers() -> dict[str, str]:
    job_id = os.environ.get("TKB_CLOUD_RUN_JOB_ID", "").strip()
    probe_url = os.environ.get("TKB_CLOUD_STOP_PROBE_URL", "").strip()
    token = os.environ.get("TKB_CLOUD_STOP_PROBE_TOKEN", "").strip().lower()
    configured = [bool(job_id), bool(probe_url), bool(token)]
    if not any(configured):
        return {}
    if not all(configured):
        raise RuntimeError("Cloud Run stop probe configuration is incomplete")
    if len(job_id) > 512 or any(ord(char) < 32 or ord(char) == 127 for char in job_id):
        raise RuntimeError("Cloud Run stop probe job id is invalid")
    if not STOP_PROBE_TOKEN_RE.fullmatch(token):
        raise RuntimeError("Cloud Run stop probe token is invalid")

    parsed = urllib.parse.urlsplit(probe_url)
    local_http = (
        _env_flag("TKB_CLOUD_STOP_PROBE_ALLOW_LOCAL_HTTP")
        and parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    )
    production_https = (
        parsed.scheme == "https"
        and parsed.hostname == "tkbcherry.com"
        and parsed.port in {None, 443}
    )
    if (
        not (production_https or local_http)
        or parsed.username
        or parsed.password
        or parsed.path.rstrip("/") != STOP_PROBE_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("Cloud Run stop probe URL is not an approved callback")
    return {
        "X-TKB-Stop-Probe-Job": job_id,
        "X-TKB-Stop-Probe-Url": probe_url,
        "X-TKB-Stop-Probe-Token": token,
    }


def _request_headers(url: str, expected_digest: str = "") -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/x-ndjson, application/json",
        "X-TKB-Cloud-Protocol": CLOUD_PROTOCOL,
    }
    if not _env_flag("TKB_CLOUD_RUN_ALLOW_UNAUTHENTICATED"):
        service_url = url.rsplit("/solve", 1)[0]
        audience = os.environ.get("TKB_CLOUD_RUN_AUDIENCE", "").strip() or service_url
        if audience.rstrip("/") != service_url.rstrip("/"):
            raise RuntimeError("Cloud Run audience must exactly match the service URL")
        headers["Authorization"] = f"Bearer {_identity_token(audience)}"
    if expected_digest:
        headers["X-TKB-Expected-Solver-Digest"] = expected_digest
    headers.update(_stop_probe_headers())
    return headers


def _timeout_seconds() -> float:
    try:
        value = float(
            os.environ.get(
                "TKB_CLOUD_RUN_TIMEOUT_SECONDS",
                str(int(CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS)),
            )
        )
    except ValueError:
        value = CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS
    # Fail closed below Cloud Run's 300-second request limit. Rust and stale
    # service environments may still request the former 320/360-second guard;
    # neither may widen this transport envelope.
    return min(CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS, max(30.0, value))


def _read_request() -> bytes:
    body = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not body or len(body) > MAX_REQUEST_BYTES:
        raise RuntimeError("cloud solver request size is invalid")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise RuntimeError("cloud solver request must be a JSON object")
    return body


def _forward_stream(response, expected_digest: str = "") -> None:
    if response.headers.get("X-TKB-Cloud-Protocol", "") != CLOUD_PROTOCOL:
        raise RuntimeError("Cloud Run response protocol marker is missing or stale")
    actual_digest = response.headers.get("X-TKB-Solver-Digest", "").strip().lower()
    if expected_digest and actual_digest != expected_digest:
        raise RuntimeError("Cloud Run solver digest does not match the pinned profile")
    final_wrapper: str | None = None
    for raw in response:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line or line.startswith(HEARTBEAT_PREFIX):
            continue
        if line.startswith(PROGRESS_PREFIX):
            sys.stderr.write(f"{line}\n")
            sys.stderr.flush()
            continue
        if line.startswith(RESULT_PREFIX):
            final_wrapper = line[len(RESULT_PREFIX) :].strip()
            continue
        # A non-streaming development endpoint may return the wrapper directly.
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "status" in parsed and "payload" in parsed:
            final_wrapper = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))

    if not final_wrapper:
        raise RuntimeError("Cloud Run response did not contain a terminal solver wrapper")
    parsed = json.loads(final_wrapper)
    if not isinstance(parsed, dict) or "payload" not in parsed:
        raise RuntimeError("Cloud Run terminal wrapper is invalid")
    payload = parsed.get("payload")
    runtime = (
        payload.get("solver", {}).get("runtime_settings", {})
        if isinstance(payload, dict) and isinstance(payload.get("solver"), dict)
        else {}
    )
    if expected_digest and runtime.get("cloud_solver_digest") != expected_digest:
        raise RuntimeError("Cloud Run terminal digest is missing or stale")
    sys.stdout.write(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()


def solve() -> int:
    body = _read_request()
    url = _cloud_url()
    expected_digest = _expected_digest()
    request = urllib.request.Request(
        url,
        data=body,
        headers=_request_headers(url, expected_digest),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
            _forward_stream(response, expected_digest)
    except urllib.error.HTTPError as error:
        detail = error.read(4096).decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Cloud Run returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cloud Run transport failed: {error.reason}") from error
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] not in {"solve", "--solve"}:
        raise RuntimeError("unsupported Cloud Run client command")
    return solve()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - Rust needs one bounded error line.
        sys.stderr.write(f"cloud_run_client_error: {error}\n")
        raise SystemExit(1)
