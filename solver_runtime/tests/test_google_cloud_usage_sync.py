from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from solver_runtime.scripts import google_cloud_usage_sync as usage


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self):
        self.requests = []

    def request(self, method, url, *, params=None, json=None, timeout=None):
        self.requests.append(
            {
                "method": method,
                "url": url,
                "params": params,
                "json": json,
                "timeout": timeout,
            }
        )
        if "monitoring.googleapis.com" in url:
            metric_filter = str((params or {}).get("filter", ""))
            if "request_count" in metric_filter:
                value = 2 if 'response_code_class="5xx"' in metric_filter else 20
            elif "request_latencies" in metric_filter:
                value = 1250
            elif "cpu/utilizations" in metric_filter:
                value = 0.72
            elif "memory/utilizations" in metric_filter:
                value = 0.61
            elif "instance_count" in metric_filter:
                value = 2
            elif "billable_instance_time" in metric_filter:
                value = 120
            else:
                value = 0
            return FakeResponse(
                {
                    "timeSeries": [
                        {
                            "points": [
                                {
                                    "interval": {"endTime": "2026-08-01T02:00:00Z"},
                                    "value": {"doubleValue": value},
                                }
                            ]
                        }
                    ]
                }
            )
        if "run.googleapis.com" in url:
            return FakeResponse(
                {
                    "generation": "3",
                    "latestReadyRevision": "tkb-solver-00003-abc",
                    "template": {
                        "maxInstanceRequestConcurrency": 1,
                        "timeout": "360s",
                        "scaling": {"minInstanceCount": 0, "maxInstanceCount": 3},
                        "containers": [
                            {"resources": {"limits": {"cpu": "6", "memory": "4Gi"}}}
                        ],
                    },
                }
            )
        if "bigquery.googleapis.com" in url:
            return FakeResponse(
                {
                    "jobComplete": True,
                    "schema": {
                        "fields": [
                            {"name": "row_count"},
                            {"name": "gross_cost"},
                            {"name": "credits"},
                            {"name": "promotion_credits"},
                            {"name": "currency"},
                            {"name": "latest_export_time"},
                        ]
                    },
                    "rows": [
                        {
                            "f": [
                                {"v": "42"},
                                {"v": "780000"},
                                {"v": "-780000"},
                                {"v": "-780000"},
                                {"v": "VND"},
                                {"v": "2026-08-01T01:30:00Z"},
                            ]
                        }
                    ],
                }
            )
        raise AssertionError(f"Unexpected URL: {url}")


def config_env(**overrides):
    values = {
        "TKB_GOOGLE_CLOUD_PROJECT_ID": "project-61ee7855-507e-40a3-879",
        "TKB_GOOGLE_CLOUD_REGION": "asia-southeast2",
        "TKB_GOOGLE_CLOUD_SERVICE": "tkb-solver",
    }
    values.update(overrides)
    return values


class GoogleCloudUsageSyncTests(unittest.TestCase):
    def test_configuration_contains_only_public_ids_and_validates_billing_table(self):
        config = usage.load_config(
            config_env(
                TKB_GOOGLE_CLOUD_MONITOR_SERVICE_ACCOUNT=(
                    "tkb-cloud-monitor@project-61ee7855-507e-40a3-879."
                    "iam.gserviceaccount.com"
                ),
                TKB_GOOGLE_BILLING_EXPORT_TABLE=(
                    "project-61ee7855-507e-40a3-879.billing."
                    "gcp_billing_export_resource_v1_0106E4_FC8666_B2FF00"
                ),
                TKB_GOOGLE_BILLING_START_DATE="2026-08-01",
            )
        )
        self.assertEqual(config.billing_query_project, config.project_id)
        self.assertNotIn("credential", repr(config).lower())

        with self.assertRaisesRegex(usage.SyncError, "billing_export_table_invalid"):
            usage.load_config(
                config_env(TKB_GOOGLE_BILLING_EXPORT_TABLE="project.dataset.table`; DROP")
            )
        with self.assertRaisesRegex(
            usage.SyncError, "billing_detailed_export_required"
        ):
            usage.load_config(
                config_env(
                    TKB_GOOGLE_BILLING_EXPORT_TABLE=(
                        "project-61ee7855-507e-40a3-879.billing."
                        "gcp_billing_export_v1_0106E4_FC8666_B2FF00"
                    )
                )
            )

    def test_monitoring_filter_is_server_owned_and_scoped_to_one_service(self):
        config = usage.load_config(config_env())
        spec = usage.METRICS[0]
        params = usage._metric_params(config, spec, 1000, 2000)
        self.assertIn('resource.labels.service_name="tkb-solver"', params["filter"])
        self.assertIn('resource.labels.location="asia-southeast2"', params["filter"])
        self.assertNotIn("token", json.dumps(params).lower())
        self.assertEqual(params["aggregation.perSeriesAligner"], "ALIGN_DELTA")

    def test_collect_snapshot_separates_near_real_time_metrics_and_delayed_billing(self):
        config = usage.load_config(
            config_env(
                TKB_GOOGLE_BILLING_EXPORT_TABLE=(
                    "project-61ee7855-507e-40a3-879.billing."
                    "gcp_billing_export_resource_v1_0106E4_FC8666_B2FF00"
                ),
                TKB_GOOGLE_BILLING_START_DATE="2026-08-01",
            )
        )
        session = FakeSession()
        snapshot = usage.collect_snapshot(
            session,
            config,
            now_seconds=1_754_017_400,  # 2026-08-01T02:10:00Z
        )
        self.assertEqual(snapshot["schema"], usage.SCHEMA)
        self.assertTrue(snapshot["monitoring"]["nearRealTime"])
        self.assertEqual(snapshot["monitoring"]["metrics"]["requestCount"], 20)
        self.assertEqual(snapshot["monitoring"]["metrics"]["serverErrorCount"], 2)
        self.assertEqual(snapshot["monitoring"]["metrics"]["errorRatePct"], 10)
        self.assertEqual(snapshot["monitoring"]["metrics"]["cpuP95Pct"], 72)
        self.assertEqual(snapshot["capacity"]["maxInstances"], 3)
        self.assertTrue(snapshot["billing"]["reconciled"])
        self.assertFalse(snapshot["billing"]["realTime"])
        self.assertEqual(snapshot["billing"]["currency"], "VND")
        self.assertNotIn("budgetAmount", snapshot["billing"])
        self.assertNotIn("budgetUsedPct", snapshot["billing"])
        self.assertNotIn("estimatedBudgetRemaining", snapshot["billing"])
        warning_codes = {item["code"] for item in snapshot["warnings"]}
        self.assertIn("cloud_run_error_rate_high", warning_codes)

        query_request = next(
            request
            for request in session.requests
            if "bigquery.googleapis.com" in request["url"]
        )
        self.assertIn("maximumBytesBilled", query_request["json"])
        self.assertIn("@project_id", query_request["json"]["query"])
        self.assertIn("resource.global_name", query_request["json"]["query"])
        self.assertIn("@region", query_request["json"]["query"])
        self.assertIn("@service_name", query_request["json"]["query"])
        parameter_names = {
            item["name"] for item in query_request["json"]["queryParameters"]
        }
        self.assertEqual(
            parameter_names, {"project_id", "start_date", "region", "service_name"}
        )
        self.assertNotIn(config.project_id, query_request["json"]["query"].split("WHERE", 1)[1])

    def test_empty_billing_export_is_pending_instead_of_fake_zero_cost(self):
        class EmptyBillingSession(FakeSession):
            def request(self, method, url, *, params=None, json=None, timeout=None):
                if "bigquery.googleapis.com" not in url:
                    return super().request(
                        method, url, params=params, json=json, timeout=timeout
                    )
                return FakeResponse(
                    {
                        "jobComplete": True,
                        "schema": {
                            "fields": [
                                {"name": "row_count"},
                                {"name": "gross_cost"},
                                {"name": "credits"},
                                {"name": "promotion_credits"},
                                {"name": "currency"},
                                {"name": "latest_export_time"},
                            ]
                        },
                        "rows": [
                            {
                                "f": [
                                    {"v": "0"},
                                    {"v": "0"},
                                    {"v": "0"},
                                    {"v": "0"},
                                    {"v": None},
                                    {"v": None},
                                ]
                            }
                        ],
                    }
                )

        config = usage.load_config(
            config_env(
                TKB_GOOGLE_BILLING_EXPORT_TABLE=(
                    "project-61ee7855-507e-40a3-879.billing."
                    "gcp_billing_export_resource_v1_0106E4_FC8666_B2FF00"
                ),
            )
        )
        snapshot = usage.collect_snapshot(
            EmptyBillingSession(), config, now_seconds=1_754_017_400
        )
        self.assertFalse(snapshot["billing"]["reconciled"])
        self.assertEqual(snapshot["billing"]["status"], "billing_export_pending")
        self.assertNotIn("netCost", snapshot["billing"])
        self.assertNotIn("budgetAmount", snapshot["billing"])
        self.assertIn(
            "billing_export_pending",
            {item["code"] for item in snapshot["warnings"]},
        )

    def test_permission_errors_use_stable_codes_without_google_response_details(self):
        class ForbiddenSession(FakeSession):
            def request(self, method, url, *, params=None, json=None, timeout=None):
                return FakeResponse(
                    {"error": {"message": "Bearer secret-token from /root/key.json"}},
                    status_code=403,
                )

        config = usage.load_config(config_env())
        snapshot = usage.collect_snapshot(ForbiddenSession(), config, now_seconds=10)
        serialized = json.dumps(snapshot)
        self.assertNotIn("secret-token", serialized)
        self.assertNotIn("/root/key.json", serialized)
        warning_codes = {item["code"] for item in snapshot["warnings"]}
        self.assertIn("monitoring_permission_denied", warning_codes)

    def test_atomic_snapshot_keeps_only_sanitized_failure_state(self):
        config = usage.load_config(config_env())
        previous = {
            "schema": usage.SCHEMA,
            "lastSuccessAtMs": 111,
            "monitoring": {"available": True, "metrics": {"requestCount": 4}},
            "capacity": {"available": True, "maxInstances": 3},
            "billing": {"configured": False, "reconciled": False},
        }
        snapshot = usage._failure_snapshot(
            config, "google_auth_failed", 222, previous
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "usage.json"
            usage.write_snapshot(path, snapshot)
            loaded = usage.read_previous(path)
        self.assertEqual(loaded["status"], "error")
        self.assertEqual(loaded["lastSuccessAtMs"], 111)
        self.assertEqual(loaded["monitoring"]["metrics"]["requestCount"], 4)

    def test_transient_billing_failure_keeps_last_reconciled_same_scope(self):
        previous = {
            "schema": usage.SCHEMA,
            "projectId": "project-61ee7855-507e-40a3-879",
            "region": "asia-southeast2",
            "serviceName": "tkb-solver",
            "billing": {
                "configured": True,
                "reconciled": True,
                "currency": "VND",
                "grossCost": 1234,
                "credits": -234,
                "netCost": 1000,
                "latestExportAtMs": 100,
                "scope": {
                    "projectId": "project-61ee7855-507e-40a3-879",
                    "region": "asia-southeast2",
                    "serviceName": "tkb-solver",
                },
            },
        }
        snapshot = {
            "projectId": "project-61ee7855-507e-40a3-879",
            "region": "asia-southeast2",
            "serviceName": "tkb-solver",
            "billing": {
                "configured": True,
                "reconciled": False,
                "status": "billing_unavailable",
                "scope": {
                    "projectId": "project-61ee7855-507e-40a3-879",
                    "region": "asia-southeast2",
                    "serviceName": "tkb-solver",
                },
            },
            "warnings": [],
        }
        usage._preserve_last_billing(snapshot, previous)
        self.assertTrue(snapshot["billing"]["reconciled"])
        self.assertTrue(snapshot["billing"]["stale"])
        self.assertEqual(snapshot["billing"]["grossCost"], 1234)
        self.assertEqual(
            snapshot["billing"]["refreshStatus"], "billing_unavailable"
        )
        self.assertIn(
            "billing_using_last_reconciled",
            {item["code"] for item in snapshot["warnings"]},
        )


if __name__ == "__main__":
    unittest.main()
