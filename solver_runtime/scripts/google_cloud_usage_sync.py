#!/usr/bin/env python3
"""Write a credential-free Google Cloud usage snapshot for Super Admin.

The process is intentionally separate from the solver and the Rust HTTP request
path.  A systemd timer can run it once per minute using Application Default
Credentials (ADC); the web API only reads the resulting JSON file.  This keeps
Google latency and temporary API failures away from timetable requests.

Cloud Monitoring is near-real-time (normally one to three minutes behind).
Google Billing Export is optional and is never real-time; its values can lag by
many hours.  The snapshot labels those two sources separately so an estimate is
never presented as a reconciled Google invoice.

No password, OAuth token, service-account key, ADC document, or bearer header is
written to the snapshot or to stderr.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import tempfile
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, MutableMapping, Sequence


SCHEMA = "tkb-google-cloud-usage-v1"
MONITORING_API = "https://monitoring.googleapis.com/v3"
RUN_API = "https://run.googleapis.com/v2"
BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2"
CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
DEFAULT_LOOKBACK_SECONDS = 60 * 60
DEFAULT_STALE_AFTER_SECONDS = 5 * 60
DEFAULT_MAXIMUM_BYTES_BILLED = 1_000_000_000
MAX_OUTPUT_BYTES = 512 * 1024
IDENTIFIER_RE = re.compile(r"^[a-z][a-z0-9-]{4,62}$")
REGION_RE = re.compile(r"^[a-z]+(?:-[a-z0-9]+)+[0-9]$")
SERVICE_RE = re.compile(r"^[a-z][a-z0-9-]{0,61}[a-z0-9]$")
SERVICE_ACCOUNT_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$"
)
TABLE_RE = re.compile(
    r"^(?P<project>[a-z][a-z0-9-]{4,62})\."
    r"(?P<dataset>[A-Za-z_][A-Za-z0-9_]{0,1023})\."
    r"(?P<table>[A-Za-z0-9_]{1,1024})$"
)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SyncError(RuntimeError):
    """A stable, public-safe synchronization error."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Config:
    project_id: str
    region: str
    service_name: str
    lookback_seconds: int
    stale_after_seconds: int
    monitor_service_account: str | None
    billing_table: str | None
    billing_query_project: str | None
    billing_location: str | None
    billing_start_date: str | None
    billing_maximum_bytes_billed: int


@dataclass(frozen=True)
class MetricSpec:
    key: str
    metric_type: str
    aligner: str
    reducer: str
    summary: str
    extra_filter: str = ""
    percent: bool = False


METRICS: tuple[MetricSpec, ...] = (
    MetricSpec(
        "requestCount",
        "run.googleapis.com/request_count",
        "ALIGN_DELTA",
        "REDUCE_SUM",
        "sum",
    ),
    MetricSpec(
        "serverErrorCount",
        "run.googleapis.com/request_count",
        "ALIGN_DELTA",
        "REDUCE_SUM",
        "sum",
        'metric.labels.response_code_class="5xx"',
    ),
    MetricSpec(
        "p95LatencyMs",
        "run.googleapis.com/request_latencies",
        "ALIGN_PERCENTILE_95",
        "REDUCE_MAX",
        "max",
    ),
    MetricSpec(
        "cpuP95Pct",
        "run.googleapis.com/container/cpu/utilizations",
        "ALIGN_PERCENTILE_95",
        "REDUCE_MAX",
        "max",
        percent=True,
    ),
    MetricSpec(
        "memoryP95Pct",
        "run.googleapis.com/container/memory/utilizations",
        "ALIGN_PERCENTILE_95",
        "REDUCE_MAX",
        "max",
        percent=True,
    ),
    MetricSpec(
        "instanceCountLatest",
        "run.googleapis.com/container/instance_count",
        "ALIGN_MAX",
        "REDUCE_SUM",
        "latest",
    ),
    MetricSpec(
        "instanceCountMax",
        "run.googleapis.com/container/instance_count",
        "ALIGN_MAX",
        "REDUCE_SUM",
        "max",
    ),
    MetricSpec(
        "billableInstanceSeconds",
        "run.googleapis.com/container/billable_instance_time",
        "ALIGN_DELTA",
        "REDUCE_SUM",
        "sum",
    ),
)


def _env_text(env: Mapping[str, str], *names: str) -> str:
    for name in names:
        value = str(env.get(name, "") or "").strip()
        if value:
            return value
    return ""


def _bounded_int(raw: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


def load_config(env: Mapping[str, str] = os.environ) -> Config:
    project_id = _env_text(
        env, "TKB_GOOGLE_CLOUD_PROJECT_ID", "TKB_CLOUD_RUN_PROJECT_ID"
    )
    region = _env_text(env, "TKB_GOOGLE_CLOUD_REGION", "TKB_CLOUD_RUN_REGION")
    service_name = _env_text(env, "TKB_GOOGLE_CLOUD_SERVICE", "TKB_CLOUD_RUN_SERVICE")
    if not IDENTIFIER_RE.fullmatch(project_id):
        raise SyncError("project_id_invalid")
    if not REGION_RE.fullmatch(region):
        raise SyncError("region_invalid")
    if not SERVICE_RE.fullmatch(service_name):
        raise SyncError("service_name_invalid")

    service_account = _env_text(env, "TKB_GOOGLE_CLOUD_MONITOR_SERVICE_ACCOUNT")
    if service_account and not SERVICE_ACCOUNT_RE.fullmatch(service_account):
        raise SyncError("monitor_service_account_invalid")

    billing_table = _env_text(env, "TKB_GOOGLE_BILLING_EXPORT_TABLE")
    table_match = TABLE_RE.fullmatch(billing_table) if billing_table else None
    if billing_table and table_match is None:
        raise SyncError("billing_export_table_invalid")
    # Reconciled service-level cost requires the detailed Billing Export. A
    # standard export has no resource identity, so accepting it here would
    # silently report every Cloud Run service in the project as TKB Cherry.
    if billing_table and "gcp_billing_export_resource_v1_" not in billing_table:
        raise SyncError("billing_detailed_export_required")
    billing_query_project = _env_text(env, "TKB_GOOGLE_BILLING_QUERY_PROJECT")
    if billing_table and not billing_query_project:
        assert table_match is not None
        billing_query_project = table_match.group("project")
    if billing_query_project and not IDENTIFIER_RE.fullmatch(billing_query_project):
        raise SyncError("billing_query_project_invalid")

    billing_start_date = _env_text(env, "TKB_GOOGLE_BILLING_START_DATE")
    if billing_start_date:
        if not DATE_RE.fullmatch(billing_start_date):
            raise SyncError("billing_start_date_invalid")
        try:
            dt.date.fromisoformat(billing_start_date)
        except ValueError as error:
            raise SyncError("billing_start_date_invalid") from error
    elif billing_table:
        billing_start_date = dt.date.today().replace(day=1).isoformat()

    return Config(
        project_id=project_id,
        region=region,
        service_name=service_name,
        lookback_seconds=_bounded_int(
            _env_text(env, "TKB_GOOGLE_CLOUD_LOOKBACK_SECONDS"),
            DEFAULT_LOOKBACK_SECONDS,
            300,
            24 * 60 * 60,
        ),
        stale_after_seconds=_bounded_int(
            _env_text(env, "TKB_GOOGLE_CLOUD_STALE_AFTER_SECONDS"),
            DEFAULT_STALE_AFTER_SECONDS,
            120,
            24 * 60 * 60,
        ),
        monitor_service_account=service_account or None,
        billing_table=billing_table or None,
        billing_query_project=billing_query_project or None,
        billing_location=_env_text(env, "TKB_GOOGLE_BILLING_LOCATION") or None,
        billing_start_date=billing_start_date or None,
        billing_maximum_bytes_billed=_bounded_int(
            _env_text(env, "TKB_GOOGLE_BILLING_MAXIMUM_BYTES_BILLED"),
            DEFAULT_MAXIMUM_BYTES_BILLED,
            10_000_000,
            100_000_000_000,
        ),
    )


def authorized_session(config: Config):
    """Create an ADC session, optionally impersonating a keyless monitor SA."""

    try:
        import google.auth  # type: ignore
        from google.auth import impersonated_credentials  # type: ignore
        from google.auth.transport.requests import AuthorizedSession  # type: ignore
    except Exception as error:  # noqa: BLE001 - return only the stable code.
        raise SyncError("google_auth_unavailable") from error

    try:
        credentials, _ = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
        if config.monitor_service_account:
            credentials = impersonated_credentials.Credentials(
                source_credentials=credentials,
                target_principal=config.monitor_service_account,
                target_scopes=[CLOUD_PLATFORM_SCOPE],
                lifetime=900,
            )
        return AuthorizedSession(credentials)
    except Exception as error:  # noqa: BLE001 - never expose credential details.
        raise SyncError("google_auth_failed") from error


def _iso_time(epoch_seconds: float) -> str:
    return (
        dt.datetime.fromtimestamp(epoch_seconds, tz=dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _request_json(
    session: Any,
    method: str,
    url: str,
    *,
    source: str,
    params: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    timeout: float = 20.0,
) -> MutableMapping[str, Any]:
    try:
        response = session.request(
            method,
            url,
            params=params,
            json=body,
            timeout=timeout,
        )
        status = int(getattr(response, "status_code", 0) or 0)
        if status == 403:
            raise SyncError(f"{source}_permission_denied")
        if status == 404:
            raise SyncError(f"{source}_not_found")
        if status < 200 or status >= 300:
            raise SyncError(f"{source}_http_error")
        payload = response.json()
        if not isinstance(payload, dict):
            raise SyncError(f"{source}_response_invalid")
        return payload
    except SyncError:
        raise
    except Exception as error:  # noqa: BLE001 - do not persist HTTP/auth details.
        raise SyncError(f"{source}_unavailable") from error


def _metric_filter(config: Config, spec: MetricSpec) -> str:
    parts = [
        f'metric.type="{spec.metric_type}"',
        'resource.type="cloud_run_revision"',
        f'resource.labels.service_name="{config.service_name}"',
        f'resource.labels.location="{config.region}"',
    ]
    if spec.extra_filter:
        parts.append(spec.extra_filter)
    return " AND ".join(parts)


def _metric_params(
    config: Config, spec: MetricSpec, start_seconds: float, end_seconds: float
) -> dict[str, str]:
    return {
        "filter": _metric_filter(config, spec),
        "interval.startTime": _iso_time(start_seconds),
        "interval.endTime": _iso_time(end_seconds),
        "aggregation.alignmentPeriod": "60s",
        "aggregation.perSeriesAligner": spec.aligner,
        "aggregation.crossSeriesReducer": spec.reducer,
        "view": "FULL",
        "pageSize": "1000",
    }


def _point_number(point: Mapping[str, Any]) -> float | None:
    value = point.get("value")
    if not isinstance(value, Mapping):
        return None
    raw = value.get("doubleValue", value.get("int64Value"))
    try:
        number = float(raw)
    except (TypeError, ValueError):
        distribution = value.get("distributionValue")
        if not isinstance(distribution, Mapping):
            return None
        try:
            number = float(distribution.get("mean"))
        except (TypeError, ValueError):
            return None
    return number if math.isfinite(number) else None


def _point_end_ms(point: Mapping[str, Any]) -> int:
    interval = point.get("interval")
    raw = interval.get("endTime") if isinstance(interval, Mapping) else None
    if not isinstance(raw, str):
        return 0
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int(parsed.timestamp() * 1000)


def _summarize_points(
    series: Sequence[Mapping[str, Any]], summary: str, percent: bool
) -> tuple[float | None, int]:
    values: list[tuple[int, float]] = []
    for item in series:
        points = item.get("points")
        if not isinstance(points, list):
            continue
        for point in points:
            if not isinstance(point, Mapping):
                continue
            number = _point_number(point)
            if number is not None:
                values.append((_point_end_ms(point), number))
    if not values:
        return None, 0
    if summary == "sum":
        result = sum(max(0.0, value) for _, value in values)
    elif summary == "latest":
        result = max(values, key=lambda item: item[0])[1]
    else:
        result = max(value for _, value in values)
    # Monitoring returns ratio metrics using the UCUM 10^2.% convention, where
    # 1.0 represents 100%.  Keep compatibility with mocks/exporters that
    # already return a percentage.
    if percent and abs(result) <= 1.5:
        result *= 100.0
    return max(0.0, result), max(timestamp for timestamp, _ in values)


def fetch_monitoring(
    session: Any, config: Config, now_seconds: float
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    values: dict[str, Any] = {}
    newest_ms = 0
    failed: list[str] = []
    endpoint = f"{MONITORING_API}/projects/{urllib.parse.quote(config.project_id, safe='')}/timeSeries"
    for spec in METRICS:
        try:
            payload = _request_json(
                session,
                "GET",
                endpoint,
                source="monitoring",
                params=_metric_params(
                    config, spec, now_seconds - config.lookback_seconds, now_seconds
                ),
            )
            result, point_ms = _summarize_points(
                payload.get("timeSeries", []), spec.summary, spec.percent
            )
            if result is not None:
                values[spec.key] = round(result, 4)
                newest_ms = max(newest_ms, point_ms)
        except SyncError as error:
            failed.append(error.code)

    request_count = float(values.get("requestCount", 0.0) or 0.0)
    error_count = float(values.get("serverErrorCount", 0.0) or 0.0)
    values["errorRatePct"] = round(
        (100.0 * error_count / request_count) if request_count > 0 else 0.0, 3
    )
    warnings: list[dict[str, str]] = []
    if failed:
        code = (
            "monitoring_permission_denied"
            if any(item.endswith("permission_denied") for item in failed)
            else "monitoring_partial"
        )
        warnings.append(
            {
                "code": code,
                "severity": "warning",
                "message": "Chưa đồng bộ đủ số liệu Cloud Monitoring từ Google.",
            }
        )
    return {
        "available": bool(values),
        "source": "google-cloud-monitoring",
        "nearRealTime": True,
        "expectedLagSeconds": 180,
        "windowSeconds": config.lookback_seconds,
        "newestPointAtMs": newest_ms or None,
        "metrics": values,
    }, warnings


def fetch_service_capacity(
    session: Any, config: Config
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    endpoint = (
        f"{RUN_API}/projects/{urllib.parse.quote(config.project_id, safe='')}/"
        f"locations/{urllib.parse.quote(config.region, safe='')}/services/"
        f"{urllib.parse.quote(config.service_name, safe='')}"
    )
    try:
        payload = _request_json(session, "GET", endpoint, source="cloud_run")
    except SyncError as error:
        return (
            {"available": False},
            [
                {
                    "code": error.code,
                    "severity": "warning",
                    "message": "Chưa đọc được giới hạn dịch vụ Cloud Run từ Google.",
                }
            ],
        )
    template = payload.get("template") if isinstance(payload.get("template"), dict) else {}
    scaling = template.get("scaling") if isinstance(template.get("scaling"), dict) else {}
    containers = template.get("containers") if isinstance(template.get("containers"), list) else []
    container = containers[0] if containers and isinstance(containers[0], dict) else {}
    resources = container.get("resources") if isinstance(container.get("resources"), dict) else {}
    limits = resources.get("limits") if isinstance(resources.get("limits"), dict) else {}
    return {
        "available": True,
        "minInstances": _safe_number(scaling.get("minInstanceCount")),
        "maxInstances": _safe_number(scaling.get("maxInstanceCount")),
        "concurrency": _safe_number(template.get("maxInstanceRequestConcurrency")),
        "timeout": _safe_text(template.get("timeout"), 32),
        "cpu": _safe_text(limits.get("cpu"), 32),
        "memory": _safe_text(limits.get("memory"), 32),
        "latestReadyRevision": _safe_text(payload.get("latestReadyRevision"), 160),
        "generation": _safe_number(payload.get("generation")),
    }, []


def _safe_number(value: Any) -> int | float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def _safe_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = "".join(ch for ch in value.strip() if ch.isprintable())[:limit]
    return value or None


def _billing_query(config: Config) -> str:
    assert config.billing_table is not None
    # The table identifier cannot be a query parameter, so load_config validates
    # it with TABLE_RE before it is interpolated. All actual values use named
    # parameters. Credits are negative in the Billing Export schema.
    return f"""
SELECT
  COUNT(*) AS row_count,
  IFNULL(SUM(cost), 0) AS gross_cost,
  IFNULL(SUM((SELECT SUM(IFNULL(c.amount, 0)) FROM UNNEST(credits) AS c)), 0) AS credits,
  IFNULL(SUM((SELECT SUM(IF(c.type = 'PROMOTION', IFNULL(c.amount, 0), 0)) FROM UNNEST(credits) AS c)), 0) AS promotion_credits,
  ANY_VALUE(currency) AS currency,
  MAX(export_time) AS latest_export_time
FROM `{config.billing_table}`
WHERE project.id = @project_id
  AND service.description = 'Cloud Run'
  AND DATE(usage_start_time) >= @start_date
  AND (
    resource.name = @service_name
    OR resource.global_name = CONCAT(
      '//run.googleapis.com/projects/', @project_id,
      '/locations/', @region, '/services/', @service_name
    )
    OR STARTS_WITH(
      resource.global_name,
      CONCAT(
        '//run.googleapis.com/projects/', @project_id,
        '/locations/', @region, '/services/', @service_name, '/'
      )
    )
  )
""".strip()


def _query_parameter(name: str, type_name: str, value: str) -> dict[str, Any]:
    return {
        "name": name,
        "parameterType": {"type": type_name},
        "parameterValue": {"value": value},
    }


def _bigquery_row(payload: Mapping[str, Any]) -> dict[str, Any]:
    schema = payload.get("schema")
    rows = payload.get("rows")
    fields = schema.get("fields") if isinstance(schema, Mapping) else None
    if not isinstance(fields, list) or not isinstance(rows, list) or not rows:
        raise SyncError("billing_response_invalid")
    cells = rows[0].get("f") if isinstance(rows[0], Mapping) else None
    if not isinstance(cells, list) or len(cells) != len(fields):
        raise SyncError("billing_response_invalid")
    result: dict[str, Any] = {}
    for field, cell in zip(fields, cells):
        name = field.get("name") if isinstance(field, Mapping) else None
        if isinstance(name, str) and isinstance(cell, Mapping):
            result[name] = cell.get("v")
    return result


def fetch_billing(
    session: Any, config: Config, now_ms: int
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    if not config.billing_table:
        return {
            "configured": False,
            "reconciled": False,
            "realTime": False,
            "source": "google-cloud-billing-export",
        }, []
    assert config.billing_query_project is not None
    assert config.billing_start_date is not None
    endpoint = (
        f"{BIGQUERY_API}/projects/"
        f"{urllib.parse.quote(config.billing_query_project, safe='')}/queries"
    )
    body: dict[str, Any] = {
        "query": _billing_query(config),
        "useLegacySql": False,
        "useQueryCache": True,
        "timeoutMs": 20_000,
        "maximumBytesBilled": str(config.billing_maximum_bytes_billed),
        "parameterMode": "NAMED",
        "queryParameters": [
            _query_parameter("project_id", "STRING", config.project_id),
            _query_parameter("start_date", "DATE", config.billing_start_date),
            _query_parameter("region", "STRING", config.region),
            _query_parameter("service_name", "STRING", config.service_name),
        ],
    }
    if config.billing_location:
        body["location"] = config.billing_location
    try:
        payload = _request_json(
            session, "POST", endpoint, source="billing", body=body, timeout=30.0
        )
        if payload.get("jobComplete") is False:
            reference = payload.get("jobReference")
            job_id = reference.get("jobId") if isinstance(reference, Mapping) else None
            if not isinstance(job_id, str) or not job_id:
                raise SyncError("billing_response_invalid")
            poll_url = (
                f"{endpoint}/{urllib.parse.quote(job_id, safe='')}"
            )
            params = {"timeoutMs": "20000"}
            location = (
                reference.get("location") if isinstance(reference, Mapping) else None
            ) or config.billing_location
            if location:
                params["location"] = str(location)
            payload = _request_json(
                session,
                "GET",
                poll_url,
                source="billing",
                params=params,
                timeout=30.0,
            )
            if payload.get("jobComplete") is False:
                raise SyncError("billing_query_pending")
        row = _bigquery_row(payload)
        row_count = _finite_float(row.get("row_count"), "billing_response_invalid")
        gross = _finite_float(row.get("gross_cost"), "billing_response_invalid")
        credits = _finite_float(row.get("credits"), "billing_response_invalid")
        promotions = _finite_float(
            row.get("promotion_credits"), "billing_response_invalid"
        )
        latest_export_ms = _parse_timestamp_ms(row.get("latest_export_time"))
        if row_count <= 0:
            pending: dict[str, Any] = {
                "configured": True,
                "reconciled": False,
                "realTime": False,
                "source": "google-cloud-billing-export",
                "status": "billing_export_pending",
                "expectedLagHours": 24,
                "latestExportAtMs": None,
                "startDate": config.billing_start_date,
                "scope": {
                    "projectId": config.project_id,
                    "region": config.region,
                    "serviceName": config.service_name,
                },
            }
            return pending, [
                {
                    "code": "billing_export_pending",
                    "severity": "info",
                    "message": "Billing Export đã bật và đang chờ Google xuất dòng dữ liệu đầu tiên.",
                }
            ]
        currency = _safe_text(row.get("currency"), 8) or ""
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise SyncError("billing_currency_invalid")
        result: dict[str, Any] = {
            "configured": True,
            "reconciled": True,
            "realTime": False,
            "source": "google-cloud-billing-export",
            "expectedLagHours": 24,
            "currency": currency,
            "grossCost": round(gross, 6),
            "credits": round(credits, 6),
            "promotionCreditsApplied": round(max(0.0, -promotions), 6),
            "netCost": round(gross + credits, 6),
            "rowCount": int(row_count),
            "latestExportAtMs": latest_export_ms or None,
            "lagSeconds": (
                max(0, int((now_ms - latest_export_ms) / 1000))
                if latest_export_ms
                else None
            ),
            "startDate": config.billing_start_date,
            "scope": {
                "projectId": config.project_id,
                "region": config.region,
                "serviceName": config.service_name,
            },
        }
        return result, []
    except SyncError as error:
        return (
            {
                "configured": True,
                "reconciled": False,
                "realTime": False,
                "source": "google-cloud-billing-export",
                "status": error.code,
                "scope": {
                    "projectId": config.project_id,
                    "region": config.region,
                    "serviceName": config.service_name,
                },
            },
            [
                {
                    "code": error.code,
                    "severity": "warning",
                    "message": "Google Billing Export chưa đồng bộ được; số tiền thực tế có thể đang trễ.",
                }
            ],
        )


def _finite_float(value: Any, error_code: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise SyncError(error_code) from error
    if not math.isfinite(result):
        raise SyncError(error_code)
    return result


def _parse_timestamp_ms(value: Any) -> int:
    if not isinstance(value, str) or not value:
        return 0
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int(parsed.timestamp() * 1000)


def _threshold_warnings(snapshot: Mapping[str, Any]) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    monitoring = snapshot.get("monitoring")
    metrics = monitoring.get("metrics") if isinstance(monitoring, Mapping) else {}
    capacity = snapshot.get("capacity")

    def number(source: Mapping[str, Any], key: str) -> float | None:
        try:
            value = float(source.get(key))
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) else None

    if isinstance(metrics, Mapping):
        error_pct = number(metrics, "errorRatePct")
        cpu = number(metrics, "cpuP95Pct")
        memory = number(metrics, "memoryP95Pct")
        latency = number(metrics, "p95LatencyMs")
        if error_pct is not None and error_pct >= 5:
            warnings.append(
                {
                    "code": "cloud_run_error_rate_high",
                    "severity": "critical" if error_pct >= 20 else "warning",
                    "message": "Tỷ lệ lỗi Cloud Run đang cao hơn mức an toàn.",
                }
            )
        if cpu is not None and cpu >= 80:
            warnings.append(
                {
                    "code": "cloud_run_cpu_high",
                    "severity": "critical" if cpu >= 95 else "warning",
                    "message": "CPU Cloud Run đang gần mức bão hòa.",
                }
            )
        if memory is not None and memory >= 80:
            warnings.append(
                {
                    "code": "cloud_run_memory_high",
                    "severity": "critical" if memory >= 95 else "warning",
                    "message": "RAM Cloud Run đang gần mức bão hòa.",
                }
            )
        if latency is not None and latency >= 300_000:
            warnings.append(
                {
                    "code": "cloud_run_latency_high",
                    "severity": "warning",
                    "message": "Thời gian phản hồi Cloud Run đang gần giới hạn request.",
                }
            )
        if isinstance(capacity, Mapping):
            active = number(metrics, "instanceCountMax")
            maximum = number(capacity, "maxInstances")
            if active is not None and maximum and active >= maximum:
                warnings.append(
                    {
                        "code": "cloud_run_instance_limit",
                        "severity": "critical",
                        "message": "Cloud Run đã chạm số instance tối đa; lượt mới có thể phải chờ.",
                    }
                )

    return warnings


def collect_snapshot(
    session: Any, config: Config, now_seconds: float | None = None
) -> dict[str, Any]:
    now_seconds = time.time() if now_seconds is None else float(now_seconds)
    now_ms = int(now_seconds * 1000)
    monitoring, monitoring_warnings = fetch_monitoring(session, config, now_seconds)
    capacity, capacity_warnings = fetch_service_capacity(session, config)
    billing, billing_warnings = fetch_billing(session, config, now_ms)
    snapshot: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "ok" if monitoring.get("available") else "partial",
        "sampledAtMs": now_ms,
        "lastSuccessAtMs": now_ms if monitoring.get("available") else None,
        "staleAfterSeconds": config.stale_after_seconds,
        "projectId": config.project_id,
        "region": config.region,
        "serviceName": config.service_name,
        "monitoring": monitoring,
        "capacity": capacity,
        "billing": billing,
    }
    warnings = monitoring_warnings + capacity_warnings + billing_warnings
    warnings.extend(_threshold_warnings(snapshot))
    snapshot["warnings"] = _deduplicate_warnings(warnings)
    return snapshot


def _deduplicate_warnings(items: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        code = _safe_text(item.get("code"), 80)
        severity = _safe_text(item.get("severity"), 16)
        message = _safe_text(item.get("message"), 240)
        if not code or code in seen or severity not in {"info", "warning", "critical"}:
            continue
        seen.add(code)
        result.append({"code": code, "severity": severity, "message": message or code})
    return result[:20]


def _failure_snapshot(
    config: Config | None,
    code: str,
    now_ms: int,
    previous: Mapping[str, Any] | None,
) -> dict[str, Any]:
    previous = previous if isinstance(previous, Mapping) else {}
    snapshot: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "error",
        "sampledAtMs": now_ms,
        "lastSuccessAtMs": previous.get("lastSuccessAtMs"),
        "staleAfterSeconds": (
            config.stale_after_seconds if config else DEFAULT_STALE_AFTER_SECONDS
        ),
        "projectId": config.project_id if config else None,
        "region": config.region if config else None,
        "serviceName": config.service_name if config else None,
        "monitoring": previous.get("monitoring", {"available": False}),
        "capacity": previous.get("capacity", {"available": False}),
        "billing": previous.get(
            "billing",
            {
                "configured": bool(config and config.billing_table),
                "reconciled": False,
                "realTime": False,
                "source": "google-cloud-billing-export",
            },
        ),
        "warnings": [
            {
                "code": code,
                "severity": "critical",
                "message": "Không thể làm mới số liệu Google Cloud; Super Admin đang xem bản gần nhất.",
            }
        ],
    }
    return snapshot


def _preserve_last_billing(
    snapshot: MutableMapping[str, Any], previous: Mapping[str, Any] | None
) -> None:
    """Keep the last reconciled invoice when a later refresh is transiently bad.

    BigQuery export can briefly return an API/permission error while the
    Monitoring calls are healthy. Replacing a known invoice with zero or a
    blank pending object would be misleading. Keep the previous amount only
    when its project/region/service scope is the same, and mark it stale so the
    portal never presents it as a fresh reading.
    """
    if not isinstance(previous, Mapping):
        return
    old_billing = previous.get("billing")
    new_billing = snapshot.get("billing")
    if not isinstance(old_billing, Mapping) or not isinstance(new_billing, Mapping):
        return
    if old_billing.get("reconciled") is not True:
        return
    old_scope = old_billing.get("scope")
    new_scope = new_billing.get("scope")
    if isinstance(old_scope, Mapping) and isinstance(new_scope, Mapping):
        if any(
            old_scope.get(key) != new_scope.get(key)
            for key in ("projectId", "region", "serviceName")
        ):
            return
    elif any(
        previous.get(key) != snapshot.get(key)
        for key in ("projectId", "region", "serviceName")
    ):
        return
    # Keep only public billing fields; the Rust allowlist independently protects
    # the response, but this also keeps the on-disk snapshot small.
    preserved = dict(old_billing)
    preserved["stale"] = True
    preserved["refreshStatus"] = (
        new_billing.get("status") or "billing_refresh_failed"
    )
    preserved["lastBillingSuccessAtMs"] = (
        old_billing.get("lastBillingSuccessAtMs")
        or old_billing.get("latestExportAtMs")
    )
    snapshot["billing"] = preserved
    warnings = snapshot.setdefault("warnings", [])
    if isinstance(warnings, list):
        warnings.append(
            {
                "code": "billing_using_last_reconciled",
                "severity": "warning",
                "message": "Google Billing Export tạm thời chưa làm mới; đang giữ số tiền đã đối soát gần nhất.",
            }
        )


def read_previous(path: Path) -> Mapping[str, Any] | None:
    try:
        if path.stat().st_size > MAX_OUTPUT_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) and value.get("schema") == SCHEMA else None
    except (OSError, ValueError, TypeError):
        return None


def write_snapshot(path: Path, snapshot: Mapping[str, Any]) -> None:
    payload = json.dumps(
        snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    if len(payload) > MAX_OUTPUT_BYTES:
        raise SyncError("snapshot_too_large")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def run(output: Path, *, stdout: bool = False) -> int:
    previous = read_previous(output)
    config: Config | None = None
    now_ms = int(time.time() * 1000)
    try:
        config = load_config()
        snapshot = collect_snapshot(authorized_session(config), config, now_ms / 1000.0)
        _preserve_last_billing(snapshot, previous)
        billing = snapshot.get("billing")
        if isinstance(billing, MutableMapping) and billing.get("reconciled") is True:
            billing["lastBillingSuccessAtMs"] = now_ms
        code = 0 if snapshot.get("status") != "error" else 1
    except SyncError as error:
        snapshot = _failure_snapshot(config, error.code, now_ms, previous)
        code = 1
    except Exception:  # noqa: BLE001 - never serialize raw auth/API exceptions.
        snapshot = _failure_snapshot(config, "google_sync_unexpected", now_ms, previous)
        code = 1
    write_snapshot(output, snapshot)
    if stdout:
        print(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
    return code


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(
            os.environ.get(
                "TKB_GOOGLE_CLOUD_USAGE_SNAPSHOT",
                "/opt/cherry-scheduler/data/google-cloud-usage.json",
            )
        ),
    )
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args(argv)
    return run(args.output, stdout=args.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
