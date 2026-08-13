//! Read the periodic Google Cloud telemetry snapshot exposed to Super Admin.
//!
//! Google calls are deliberately performed by a separate, timer-driven Python
//! process. This module is read-only, bounded, and contains no solver logic. It
//! also returns only an explicit public-field allowlist, so a damaged local
//! file cannot expose ADC paths, tokens, query text, or arbitrary diagnostics.

use serde_json::{json, Map, Number, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const SNAPSHOT_SCHEMA: &str = "tkb-google-cloud-usage-v1";
const SNAPSHOT_ENV: &str = "TKB_GOOGLE_CLOUD_USAGE_SNAPSHOT";
const REFRESH_MARKER: &str = "google-cloud-usage-refresh.request";
const MAX_SNAPSHOT_BYTES: u64 = 512 * 1024;
const DEFAULT_STALE_AFTER_SECONDS: u64 = 5 * 60;

pub fn snapshot_for_superadmin(app_root: &Path) -> Value {
    let path = env::var(SNAPSHOT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_root.join("data").join("google-cloud-usage.json"));
    snapshot_from_path(&path, crate::now_millis())
}

pub fn request_refresh(app_root: &Path, requested_at_ms: u64) -> Result<PathBuf, &'static str> {
    let data_dir = app_root.join("data");
    fs::create_dir_all(&data_dir).map_err(|_| "google_refresh_directory_unavailable")?;
    let marker = data_dir.join(REFRESH_MARKER);
    fs::write(&marker, format!("{requested_at_ms}\n"))
        .map_err(|_| "google_refresh_request_failed")?;
    Ok(marker)
}

/// Refuse to show money from a Google project other than the active solver.
///
/// The Cloud Run routing profile lives in SQLite while the read-only billing
/// identity/table lives in a root-owned environment file.  A future profile
/// switch must update both.  This server-side check prevents a successful but
/// stale billing connection from being presented as the cost of the new
/// project.
pub fn enforce_profile_scope(
    mut snapshot: Value,
    project_id: &str,
    region: &str,
    service_url: &str,
) -> Value {
    if snapshot.get("configured").and_then(Value::as_bool) != Some(true) {
        return snapshot;
    }
    let actual_project = snapshot
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let actual_region = snapshot
        .get("region")
        .and_then(Value::as_str)
        .unwrap_or("");
    let actual_service = snapshot
        .get("serviceName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected_project = project_id.trim();
    let expected_region = region.trim();
    let hostname = service_url
        .trim()
        .strip_prefix("https://")
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let service_matches = actual_service.is_empty()
        || hostname.is_empty()
        || hostname == actual_service
        || hostname.starts_with(&format!("{}-", actual_service.to_ascii_lowercase()));
    let matches = (expected_project.is_empty() || expected_project == actual_project)
        && (expected_region.is_empty() || expected_region == actual_region)
        && service_matches;
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("scopeMatchesActiveProfile".to_string(), json!(matches));
        if !matches {
            object.insert(
                "billing".to_string(),
                json!({
                    "configured": true,
                    "reconciled": false,
                    "realTime": false,
                    "source": "google-cloud-billing-export",
                    "status": "google_usage_scope_mismatch"
                }),
            );
            let warnings = object
                .entry("warnings".to_string())
                .or_insert_with(|| json!([]));
            if let Some(items) = warnings.as_array_mut() {
                items.retain(|item| {
                    item.get("code").and_then(Value::as_str)
                        != Some("google_usage_scope_mismatch")
                });
                items.insert(
                    0,
                    json!({
                        "code": "google_usage_scope_mismatch",
                        "severity": "critical",
                        "message": "Cấu hình chi phí Google không trùng dự án Cloud Run đang xếp; số tiền đã được ẩn để tránh báo sai."
                    }),
                );
                items.truncate(20);
            }
        }
    }
    snapshot
}

fn snapshot_from_path(path: &Path, now_ms: u64) -> Value {
    let Ok(metadata) = fs::metadata(path) else {
        return unavailable("snapshot_not_configured", false);
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SNAPSHOT_BYTES {
        return unavailable("snapshot_invalid", true);
    }
    let Ok(raw) = fs::read(path) else {
        return unavailable("snapshot_unreadable", true);
    };
    let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
        return unavailable("snapshot_invalid", true);
    };
    let Some(object) = value.as_object() else {
        return unavailable("snapshot_invalid", true);
    };
    if object.get("schema").and_then(Value::as_str) != Some(SNAPSHOT_SCHEMA) {
        return unavailable("snapshot_incompatible", true);
    }

    // Do not trust a local snapshot that claims to be sampled in the future:
    // otherwise a damaged file could suppress the stale-data warning forever.
    // A small clock-skew allowance keeps normal NTP drift from being reported
    // as invalid while still making freshness server-time based.
    let max_future_ms = now_ms.saturating_add(5 * 60 * 1_000);
    let sampled_at_ms = public_u64(object.get("sampledAtMs"), u64::MAX)
        .filter(|value| *value <= max_future_ms)
        .unwrap_or(0);
    let last_success_at_ms = public_u64(object.get("lastSuccessAtMs"), u64::MAX)
        .filter(|value| *value > 0 && *value <= max_future_ms);
    let stale_after_seconds = public_u64(object.get("staleAfterSeconds"), 24 * 60 * 60)
        .unwrap_or(DEFAULT_STALE_AFTER_SECONDS)
        .clamp(120, 24 * 60 * 60);
    let freshness_ms = last_success_at_ms.unwrap_or(sampled_at_ms);
    let age_seconds = if freshness_ms > 0 {
        now_ms.saturating_sub(freshness_ms) / 1_000
    } else {
        u64::MAX
    };
    let stale = age_seconds > stale_after_seconds;

    let mut warnings = public_warnings(object.get("warnings"));
    if stale
        && !warnings
            .iter()
            .any(|warning| warning.get("code").and_then(Value::as_str) == Some("google_snapshot_stale"))
    {
        warnings.push(json!({
            "code": "google_snapshot_stale",
            "severity": "warning",
            "message": "Số liệu Google Cloud chưa được làm mới đúng thời gian."
        }));
    }

    let status = match object.get("status").and_then(Value::as_str) {
        Some("ok") => "ok",
        Some("partial") => "partial",
        Some("error") => "error",
        _ => "invalid",
    };
    json!({
        "configured": true,
        "available": status != "invalid",
        "schema": SNAPSHOT_SCHEMA,
        "status": if stale && status == "ok" { "stale" } else { status },
        "sampledAtMs": sampled_at_ms,
        "lastSuccessAtMs": last_success_at_ms,
        "ageSeconds": if age_seconds == u64::MAX { Value::Null } else { json!(age_seconds) },
        "staleAfterSeconds": stale_after_seconds,
        "stale": stale,
        "projectId": public_text(object.get("projectId"), 160),
        "region": public_text(object.get("region"), 80),
        "serviceName": public_text(object.get("serviceName"), 80),
        "monitoring": public_monitoring(object.get("monitoring")),
        "capacity": public_capacity(object.get("capacity")),
        "billing": public_billing(object.get("billing")),
        "warnings": warnings
    })
}

fn unavailable(status: &str, configured: bool) -> Value {
    json!({
        "configured": configured,
        "available": false,
        "schema": SNAPSHOT_SCHEMA,
        "status": status,
        "stale": true,
        "monitoring": {"available": false, "nearRealTime": true},
        "capacity": {"available": false},
        "billing": {
            "configured": false,
            "reconciled": false,
            "realTime": false,
            "source": "google-cloud-billing-export"
        },
        "warnings": []
    })
}

fn public_monitoring(value: Option<&Value>) -> Value {
    let Some(object) = value.and_then(Value::as_object) else {
        return json!({"available": false, "nearRealTime": true});
    };
    let metrics = object.get("metrics").and_then(Value::as_object);
    let mut public_metrics = Map::new();
    for key in [
        "requestCount",
        "serverErrorCount",
        "errorRatePct",
        "p95LatencyMs",
        "cpuP95Pct",
        "memoryP95Pct",
        "instanceCountLatest",
        "instanceCountMax",
        "billableInstanceSeconds",
    ] {
        if let Some(value) = metrics
            .and_then(|items| items.get(key))
            .and_then(public_number)
        {
            public_metrics.insert(key.to_string(), value);
        }
    }
    json!({
        "available": object.get("available").and_then(Value::as_bool).unwrap_or(false),
        "source": "google-cloud-monitoring",
        "nearRealTime": true,
        "expectedLagSeconds": public_u64(object.get("expectedLagSeconds"), 86_400),
        "windowSeconds": public_u64(object.get("windowSeconds"), 86_400),
        "newestPointAtMs": public_u64(object.get("newestPointAtMs"), u64::MAX),
        "metrics": public_metrics
    })
}

fn public_capacity(value: Option<&Value>) -> Value {
    let Some(object) = value.and_then(Value::as_object) else {
        return json!({"available": false});
    };
    json!({
        "available": object.get("available").and_then(Value::as_bool).unwrap_or(false),
        "minInstances": object.get("minInstances").and_then(public_number),
        "maxInstances": object.get("maxInstances").and_then(public_number),
        "concurrency": object.get("concurrency").and_then(public_number),
        "timeout": public_text(object.get("timeout"), 32),
        "cpu": public_text(object.get("cpu"), 32),
        "memory": public_text(object.get("memory"), 32),
        "latestReadyRevision": public_text(object.get("latestReadyRevision"), 160),
        "generation": object.get("generation").and_then(public_number)
    })
}

fn public_billing(value: Option<&Value>) -> Value {
    let Some(object) = value.and_then(Value::as_object) else {
        return json!({
            "configured": false,
            "reconciled": false,
            "realTime": false,
            "source": "google-cloud-billing-export"
        });
    };
    json!({
        "configured": object.get("configured").and_then(Value::as_bool).unwrap_or(false),
        "reconciled": object.get("reconciled").and_then(Value::as_bool).unwrap_or(false),
        "realTime": false,
        "source": "google-cloud-billing-export",
        "status": public_text(object.get("status"), 80),
        "expectedLagHours": public_u64(object.get("expectedLagHours"), 168),
        "currency": public_currency(object.get("currency")),
        "grossCost": object.get("grossCost").and_then(public_number),
        "credits": object.get("credits").and_then(public_number),
        "promotionCreditsApplied": object.get("promotionCreditsApplied").and_then(public_number),
        "netCost": object.get("netCost").and_then(public_number),
        "rowCount": public_u64(object.get("rowCount"), u64::MAX),
        "latestExportAtMs": public_u64(object.get("latestExportAtMs"), u64::MAX),
        "lastBillingSuccessAtMs": public_u64(object.get("lastBillingSuccessAtMs"), u64::MAX),
        "lagSeconds": public_u64(object.get("lagSeconds"), 365 * 24 * 60 * 60),
        "startDate": public_text(object.get("startDate"), 16),
        "stale": object.get("stale").and_then(Value::as_bool).unwrap_or(false),
        "refreshStatus": public_text(object.get("refreshStatus"), 80)
    })
}

fn public_warnings(value: Option<&Value>) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let code = public_text(object.get("code"), 80)?;
            let severity = match object.get("severity").and_then(Value::as_str) {
                Some("info") => "info",
                Some("warning") => "warning",
                Some("critical") => "critical",
                _ => return None,
            };
            let message = public_text(object.get("message"), 240).unwrap_or_else(|| code.clone());
            Some(json!({"code": code, "severity": severity, "message": message}))
        })
        .take(20)
        .collect()
}

fn public_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(
        text.chars()
            .filter(|character| !character.is_control())
            .take(max_chars)
            .collect(),
    )
}

fn public_currency(value: Option<&Value>) -> Option<String> {
    let currency = public_text(value, 3)?;
    (currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_uppercase()))
        .then_some(currency)
}

fn public_number(value: &Value) -> Option<Value> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.abs() > 1_000_000_000_000.0 {
        return None;
    }
    Number::from_f64(number).map(Value::Number)
}

fn public_u64(value: Option<&Value>, maximum: u64) -> Option<u64> {
    value?.as_u64().map(|value| value.min(maximum))
}

pub fn billing_reconciled(snapshot: &Value) -> bool {
    snapshot
        .get("billing")
        .and_then(|billing| billing.get("reconciled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(1);

    fn test_path() -> PathBuf {
        env::temp_dir().join(format!(
            "tkb-google-usage-{}-{}.json",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn snapshot_is_whitelisted_and_freshness_is_computed_server_side() {
        let path = test_path();
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema": SNAPSHOT_SCHEMA,
                "status": "ok",
                "sampledAtMs": 2_000_000,
                "lastSuccessAtMs": 2_000_000,
                "staleAfterSeconds": 300,
                "projectId": "safe-project",
                "credentialPath": "/root/secret.json",
                "monitoring": {
                    "available": true,
                    "metrics": {"requestCount": 12, "accessToken": "secret"}
                },
                "capacity": {"available": true, "maxInstances": 3},
                "billing": {"configured": true, "reconciled": true, "currency":"VND", "grossCost": 100},
                "warnings": []
            }))
            .unwrap(),
        )
        .unwrap();
        let snapshot = snapshot_from_path(&path, 2_100_000);
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(snapshot["available"].as_bool().unwrap());
        assert!(!snapshot["stale"].as_bool().unwrap());
        assert_eq!(snapshot["monitoring"]["metrics"]["requestCount"], json!(12.0));
        assert!(!serialized.contains("credentialPath"));
        assert!(!serialized.contains("accessToken"));
        assert!(!serialized.contains("secret"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_snapshot_gets_a_warning_without_trusting_file_age_fields() {
        let path = test_path();
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema": SNAPSHOT_SCHEMA,
                "status": "ok",
                "sampledAtMs": 1_000,
                "lastSuccessAtMs": 1_000,
                "staleAfterSeconds": 120,
                "monitoring": {"available": true},
                "billing": {"configured": false, "reconciled": false}
            }))
            .unwrap(),
        )
        .unwrap();
        let snapshot = snapshot_from_path(&path, 500_000);
        assert_eq!(snapshot["status"], json!("stale"));
        assert!(snapshot["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == json!("google_snapshot_stale")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn future_snapshot_timestamps_cannot_hide_staleness() {
        let path = test_path();
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema": SNAPSHOT_SCHEMA,
                "status": "ok",
                "sampledAtMs": u64::MAX,
                "lastSuccessAtMs": u64::MAX,
                "staleAfterSeconds": 120,
                "monitoring": {"available": true}
            }))
            .unwrap(),
        )
        .unwrap();
        let snapshot = snapshot_from_path(&path, 500_000);
        assert_eq!(snapshot["sampledAtMs"], json!(0));
        assert_eq!(snapshot["lastSuccessAtMs"], Value::Null);
        assert_eq!(snapshot["status"], json!("stale"));
        assert!(snapshot["stale"].as_bool().unwrap());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn missing_snapshot_is_not_misreported_as_google_billing() {
        let snapshot = snapshot_from_path(&test_path(), 1);
        assert_eq!(snapshot["configured"], json!(false));
        assert_eq!(snapshot["billing"]["reconciled"], json!(false));
        assert!(!billing_reconciled(&snapshot));
    }

    #[test]
    fn mismatched_active_profile_hides_billing_amounts() {
        let scoped = enforce_profile_scope(
            json!({
                "configured": true,
                "projectId": "billing-project",
                "region": "asia-southeast2",
                "serviceName": "tkb-solver",
                "billing": {
                    "configured": true,
                    "reconciled": true,
                    "currency": "VND",
                    "grossCost": 500
                },
                "warnings": []
            }),
            "different-project",
            "asia-southeast2",
            "https://tkb-solver-abc-et.a.run.app",
        );
        assert_eq!(scoped["scopeMatchesActiveProfile"], json!(false));
        assert_eq!(scoped["billing"]["reconciled"], json!(false));
        assert!(scoped["billing"].get("grossCost").is_none());
        assert_eq!(
            scoped["warnings"][0]["code"],
            json!("google_usage_scope_mismatch")
        );
    }

    #[test]
    fn refresh_request_writes_only_a_timestamp_marker() {
        let root = env::temp_dir().join(format!(
            "tkb-google-refresh-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::SeqCst)
        ));
        let marker = request_refresh(&root, 123_456).expect("refresh marker");
        assert_eq!(fs::read_to_string(&marker).unwrap(), "123456\n");
        let _ = fs::remove_dir_all(root);
    }
}
