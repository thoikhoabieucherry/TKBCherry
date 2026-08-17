//! Cloud Run routing, profile and cost accounting.
//!
//! This module deliberately contains no solver logic. The reference Python
//! solver remains the source of truth; this coordinator only decides whether a
//! server-owned job may be sent to an authorized Cloud Run service and keeps a
//! an execution ledger for operational telemetry. Google Billing Export is the
//! source of truth for money spent. Legacy application budget fields are
//! accepted only as unknown input during a cached-client rollout, then dropped;
//! they never gate Cloud Run admission or appear in a public response.

use crate::db::Db;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::Arc;

pub const CONFIG_KEY: &str = "serverless_infrastructure_v1";
pub const USAGE_KEY: &str = "serverless_usage_v1";
const SCHOOL_POLICY_KEY_PREFIX: &str = "serverless_school_policy_v1:";
// Six vCPU + 4 GiB for the full 285-second subprocess ceiling is roughly $0.044 at
// the default rates. The estimate is retained only as internal execution-ledger
// telemetry; Google Billing Export is the sole public source of monetary cost.
pub const DEFAULT_ESTIMATED_COST_USD: f64 = 0.06;
const DEFAULT_RESERVATION_TTL_MS: u64 = 60 * 60 * 1_000;
const MAX_RESERVATION_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
pub const FREE_SOLVE_ACTION_LIMIT: u64 = 5;
pub const TRIAL_SOLVE_ACTION_LIMIT: u64 = 50;
pub const PLUS_SOLVE_ACTION_LIMIT: u64 = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoutingMode {
    Auto,
    ServerlessOnly,
    VpsOnly,
    /// Kept only so an old persisted value can be read safely. New writes do
    /// not accept this mode until a real server-side WebAgent fallback exists.
    ServerlessWebAgentFallback,
}

impl RoutingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::ServerlessOnly => "serverless_only",
            Self::VpsOnly => "vps_only",
            Self::ServerlessWebAgentFallback => "serverless_webagent_fallback",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "serverless" | "serverless_only" | "cloud_run" => Self::ServerlessOnly,
            "vps" | "vps_only" => Self::VpsOnly,
            "serverless_webagent_fallback" | "serverless_web_agent_fallback" => {
                Self::ServerlessWebAgentFallback
            }
            _ => Self::Auto,
        }
    }
}

fn checked_routing_mode(raw: Option<&str>) -> Result<RoutingMode, String> {
    match raw
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "auto" => Ok(RoutingMode::Auto),
        "serverless" | "serverless_only" | "cloud_run" => Ok(RoutingMode::ServerlessOnly),
        "vps" | "vps_only" => Ok(RoutingMode::VpsOnly),
        "serverless_webagent_fallback" | "serverless_web_agent_fallback" => {
            Err("serverless_webagent_fallback_unavailable".to_string())
        }
        _ => Err("serverless_mode_invalid".to_string()),
    }
}

#[derive(Clone, Debug)]
pub struct ServerlessProfile {
    pub id: String,
    pub url: String,
    pub audience: String,
    pub region: String,
    pub project_id: String,
    pub enabled: bool,
    pub priority: i64,
    pub vcpu: u32,
    pub memory_gib: f64,
    pub max_concurrency: u32,
    pub solver_digest: String,
}

impl ServerlessProfile {
    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id").and_then(Value::as_str)?.trim();
        let raw_url = object.get("url").and_then(Value::as_str)?.trim();
        if id.is_empty() || !valid_cloud_run_base_url(raw_url) {
            return None;
        }
        let solver_digest = object
            .get("solverDigest")
            .or_else(|| object.get("solver_digest"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !valid_solver_digest(&solver_digest) {
            return None;
        }
        let url = raw_url
            .trim_end_matches('/')
            .chars()
            .take(500)
            .collect::<String>();
        Some(Self {
            id: id.chars().take(80).collect(),
            // Google validates the ID token's `aud` claim against the exact
            // Cloud Run service URL. Never let a browser supply a different
            // audience for a superadmin-approved destination.
            audience: url.clone(),
            url,
            region: object
                .get("region")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .chars()
                .take(80)
                .collect(),
            project_id: object
                .get("projectId")
                .or_else(|| object.get("project_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .chars()
                .take(160)
                .collect(),
            enabled: object.get("enabled").map(value_truthy).unwrap_or(true),
            priority: object
                .get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            vcpu: object
                .get("vcpu")
                .and_then(Value::as_u64)
                .unwrap_or(6)
                .clamp(1, 64) as u32,
            memory_gib: object
                .get("memoryGiB")
                .or_else(|| object.get("memory_gib"))
                .and_then(Value::as_f64)
                .unwrap_or(4.0)
                .clamp(0.5, 64.0),
            max_concurrency: object
                .get("maxConcurrency")
                .or_else(|| object.get("max_concurrency"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 1000) as u32,
            solver_digest,
        })
    }

    pub fn public_value(&self) -> Value {
        json!({
            "id": self.id,
            "url": self.url,
            "audience": self.audience,
            "region": self.region,
            "projectId": self.project_id,
            "enabled": self.enabled,
            "priority": self.priority,
            "vcpu": self.vcpu,
            "memoryGiB": self.memory_gib,
            "maxConcurrency": self.max_concurrency,
            "solverDigest": self.solver_digest
        })
    }
}

#[derive(Clone, Debug)]
pub struct ServerlessConfig {
    pub mode: RoutingMode,
    pub fallback: String,
    pub estimated_cost_usd: f64,
    pub active_profile_id: Option<String>,
    pub profiles: Vec<ServerlessProfile>,
}

impl ServerlessConfig {
    fn from_value(value: &Value) -> Self {
        let object = value.as_object();
        let mode = object
            .and_then(|items| items.get("mode"))
            .and_then(Value::as_str)
            .map(RoutingMode::parse)
            .unwrap_or_else(|| {
                RoutingMode::parse(&env::var("TKB_SERVERLESS_MODE").unwrap_or_default())
            });
        let raw_fallback = object
            .and_then(|items| items.get("fallback"))
            .and_then(Value::as_str)
            .unwrap_or("vps")
            .trim()
            .to_ascii_lowercase();
        // `webagent` used to be accepted even though the coordinator had no
        // implementation for it. Treat old persisted values as the safe VPS
        // fallback and reject new writes in `sanitize_config`.
        let fallback = if matches!(raw_fallback.as_str(), "vps" | "none") {
            raw_fallback
        } else {
            "vps".to_string()
        };
        let minimum_estimate = env_f64(
            "TKB_SERVERLESS_MIN_ESTIMATED_COST_USD",
            DEFAULT_ESTIMATED_COST_USD,
        )
        .clamp(0.0001, 1000.0);
        let estimated_cost_usd = env_f64(
            "TKB_SERVERLESS_ESTIMATED_COST_USD",
            DEFAULT_ESTIMATED_COST_USD,
        )
        .clamp(minimum_estimate, 1000.0);
        let mut profiles = object
            .and_then(|items| items.get("profiles"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(ServerlessProfile::from_value)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if profiles.is_empty() {
            let url = env::var("TKB_CLOUD_RUN_URL").unwrap_or_default();
            if let Some(profile) = ServerlessProfile::from_value(&json!({
                "id": "env-default",
                "url": url,
                "region": env::var("TKB_CLOUD_RUN_REGION").unwrap_or_default(),
                "projectId": env::var("TKB_CLOUD_RUN_PROJECT_ID").unwrap_or_default(),
                "solverDigest": env::var("TKB_CLOUD_RUN_SOLVER_DIGEST").unwrap_or_default(),
                "enabled": true
            })) {
                profiles.push(profile);
            }
        }
        let active_profile_id = object
            .and_then(|items| items.get("activeProfileId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(80).collect::<String>());
        Self {
            mode,
            fallback,
            estimated_cost_usd,
            active_profile_id,
            profiles,
        }
    }

    pub fn public_value(&self) -> Value {
        json!({
            "mode": self.mode.as_str(),
            "fallback": self.fallback,
            "activeProfileId": self.active_profile_id,
            "profiles": self.profiles.iter().map(ServerlessProfile::public_value).collect::<Vec<_>>()
        })
    }

    pub fn selected_profile(&self) -> Option<ServerlessProfile> {
        if let Some(active_id) = self.active_profile_id.as_deref() {
            return self
                .profiles
                .iter()
                .find(|profile| profile.enabled && profile.id == active_id)
                .cloned();
        }
        self.profiles
            .iter()
            .filter(|profile| profile.enabled)
            .max_by_key(|profile| profile.priority)
            .cloned()
    }
}

#[derive(Clone, Debug)]
pub struct ServerlessReservation {
    pub profile: ServerlessProfile,
    pub estimated_usd: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReservationOutcome {
    Completed,
    Failed,
    Cancelled,
    Released,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrialSolveAdmission {
    Claimed { used: u64 },
    Existing { used: u64 },
    Exhausted { used: u64 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FreeSolveAdmission {
    Claimed { used: u64 },
    Existing { used: u64 },
    Exhausted { used: u64 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlusSolveAdmission {
    Claimed { used: u64 },
    Existing { used: u64 },
    Exhausted { used: u64 },
}

#[derive(Default)]
struct LedgerSnapshot {
    profile_committed: HashMap<String, f64>,
    profile_reserved: HashMap<String, f64>,
    profile_completed: HashMap<String, u64>,
    profile_failed: HashMap<String, u64>,
    profile_cancelled: HashMap<String, u64>,
    active_reservations: u64,
}

#[derive(Default)]
struct AccountExecutionUsage {
    school_id: String,
    account_id: String,
    cloud_run_requests: u64,
    cloud_run_completed: u64,
    cloud_run_failed: u64,
    cloud_run_cancelled: u64,
    cloud_run_released: u64,
    cloud_run_active: u64,
    vps_requests: u64,
    vps_completed: u64,
    vps_failed: u64,
    vps_cancelled: u64,
    vps_released: u64,
    vps_active: u64,
    last_requested_at_ms: u64,
}

pub struct ServerlessCoordinator {
    db: Arc<Db>,
    reservation_ttl_ms: u64,
}

impl ServerlessCoordinator {
    pub fn new(db: Arc<Db>) -> Arc<Self> {
        let coordinator = Arc::new(Self {
            db,
            reservation_ttl_ms: env_u64(
                "TKB_SERVERLESS_RESERVATION_TTL_MS",
                DEFAULT_RESERVATION_TTL_MS,
            )
            .clamp(60_000, MAX_RESERVATION_TTL_MS),
        });
        coordinator
            .ensure_ledger_storage()
            .expect("Failed to initialize serverless accounting tables");
        // Do not zero live reservations on process restart. A rolling restart
        // can overlap another API process and Cloud Run may still be billing
        // the request. Only timestamp-expired rows are safe to release.
        let _ = coordinator.prune_expired(crate::now_millis());
        coordinator
    }

    pub fn config(&self) -> ServerlessConfig {
        self.db
            .get(CONFIG_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .map(|value| ServerlessConfig::from_value(&value))
            .unwrap_or_else(|| ServerlessConfig::from_value(&json!({})))
    }

    /// Atomically counts one canonical solver job for a Free school. The five
    /// actions are one lifetime pool shared by every account at that school.
    /// A browser reconnect and a Cloud Run -> VPS fallback keep the same job id
    /// and therefore cannot consume another action.
    pub fn claim_free_solve(
        &self,
        school_id: &str,
        account_id: &str,
        job_id: &str,
    ) -> Result<FreeSolveAdmission, String> {
        let school_id = normalized_owner_part(school_id);
        let account_id = normalized_owner_part(account_id);
        let job_id = job_id.trim().chars().take(160).collect::<String>();
        if school_id.is_empty() || account_id.is_empty() || job_id.is_empty() {
            return Err("free_solve_identity_required".to_string());
        }
        self.db
            .with_immediate_transaction(|tx| {
                let used = || {
                    tx.query_row(
                        "SELECT COUNT(*) FROM solver_free_solve_usage WHERE school_id = ?1",
                        [&school_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(nonnegative_u64)
                };
                if tx
                    .query_row(
                        "SELECT 1 FROM solver_free_solve_usage \
                         WHERE school_id = ?1 AND account_id = ?2 AND job_id = ?3",
                        params![school_id, account_id, job_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Ok(FreeSolveAdmission::Existing { used: used()? });
                }
                let current = used()?;
                if current >= FREE_SOLVE_ACTION_LIMIT {
                    return Ok(FreeSolveAdmission::Exhausted { used: current });
                }
                let now_ms = crate::now_millis();
                tx.execute(
                    "INSERT INTO solver_free_solve_usage \
                     (school_id, account_id, job_id, requested_at_ms) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        school_id,
                        account_id,
                        job_id,
                        sqlite_millis(now_ms)
                    ],
                )?;
                Ok(FreeSolveAdmission::Claimed {
                    used: current.saturating_add(1),
                })
            })
            .map_err(|error| error.to_string())
    }

    /// Releases a Free claim only when no executor accepted the canonical job.
    pub fn release_free_solve_claim(
        &self,
        school_id: &str,
        account_id: &str,
        job_id: &str,
    ) -> Result<bool, String> {
        let school_id = normalized_owner_part(school_id);
        let account_id = normalized_owner_part(account_id);
        let job_id = job_id.trim().chars().take(160).collect::<String>();
        if school_id.is_empty() || account_id.is_empty() || job_id.is_empty() {
            return Err("free_solve_identity_required".to_string());
        }
        self.db
            .with_immediate_transaction(|tx| {
                tx.execute(
                    "DELETE FROM solver_free_solve_usage \
                     WHERE school_id = ?1 AND account_id = ?2 AND job_id = ?3",
                    params![school_id, account_id, job_id],
                )
                .map(|changed| changed > 0)
            })
            .map_err(|error| error.to_string())
    }

    /// Atomically counts one canonical solver job for a Trial school.
    ///
    /// HTTP retries reuse the same server job id and Cloud Run -> VPS fallback
    /// stays inside that same job.  Client-provided UI action ids are not an
    /// authority boundary: trusting them would let a caller replay an old id to
    /// bypass the school quota.  Account id remains part of the idempotency key
    /// so two users at one school cannot accidentally deduplicate each other,
    /// while the limit itself is counted across the whole school.
    pub fn claim_trial_solve(
        &self,
        school_id: &str,
        account_id: &str,
        job_id: &str,
    ) -> Result<TrialSolveAdmission, String> {
        let school_id = normalized_owner_part(school_id);
        let account_id = normalized_owner_part(account_id);
        let job_id = job_id.trim().chars().take(160).collect::<String>();
        if school_id.is_empty() || account_id.is_empty() || job_id.is_empty() {
            return Err("trial_solve_identity_required".to_string());
        }
        self.db
            .with_immediate_transaction(|tx| {
                let used = || {
                    tx.query_row(
                        "SELECT COUNT(*) FROM solver_trial_solve_usage WHERE school_id = ?1",
                        [&school_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(nonnegative_u64)
                };
                if tx
                    .query_row(
                        "SELECT 1 FROM solver_trial_solve_usage \
                         WHERE school_id = ?1 AND account_id = ?2 AND job_id = ?3",
                        params![school_id, account_id, job_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Ok(TrialSolveAdmission::Existing { used: used()? });
                }
                let current = used()?;
                if current >= TRIAL_SOLVE_ACTION_LIMIT {
                    return Ok(TrialSolveAdmission::Exhausted { used: current });
                }
                let now_ms = crate::now_millis();
                tx.execute(
                    "INSERT INTO solver_trial_solve_usage \
                     (school_id, account_id, job_id, requested_at_ms) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        school_id,
                        account_id,
                        job_id,
                        sqlite_millis(now_ms)
                    ],
                )?;
                Ok(TrialSolveAdmission::Claimed {
                    used: current.saturating_add(1),
                })
            })
            .map_err(|error| error.to_string())
    }

    /// Releases a Trial claim only when its canonical job was never accepted
    /// by an executor. Callers must not use this for a job that returned 202,
    /// started running, was stopped, or was cancelled after acceptance.
    pub fn release_trial_solve_claim(
        &self,
        school_id: &str,
        account_id: &str,
        job_id: &str,
    ) -> Result<bool, String> {
        let school_id = normalized_owner_part(school_id);
        let account_id = normalized_owner_part(account_id);
        let job_id = job_id.trim().chars().take(160).collect::<String>();
        if school_id.is_empty() || account_id.is_empty() || job_id.is_empty() {
            return Err("trial_solve_identity_required".to_string());
        }
        self.db
            .with_immediate_transaction(|tx| {
                tx.execute(
                    "DELETE FROM solver_trial_solve_usage \
                     WHERE school_id = ?1 AND account_id = ?2 AND job_id = ?3",
                    params![school_id, account_id, job_id],
                )
                .map(|changed| changed > 0)
            })
            .map_err(|error| error.to_string())
    }

    /// Atomically counts one canonical solver job against a Plus billing cycle.
    ///
    /// The quota pool is shared by every account at the school and resets only
    /// when the server-authoritative `quota_cycle_id` changes. Idempotency stays
    /// keyed by school/account/job across cycles, so retrying an old canonical
    /// job can never spend another unit. The dedicated table intentionally has
    /// no migration or backfill from the execution ledger: a newly introduced
    /// Plus cycle therefore starts at zero accepted solver jobs.
    pub fn claim_plus_solve(
        &self,
        school_id: &str,
        account_id: &str,
        quota_cycle_id: &str,
        job_id: &str,
    ) -> Result<PlusSolveAdmission, String> {
        let school_id = normalized_owner_part(school_id);
        let account_id = normalized_owner_part(account_id);
        let quota_cycle_id = normalized_owner_part(quota_cycle_id);
        let job_id = job_id.trim().chars().take(160).collect::<String>();
        if school_id.is_empty()
            || account_id.is_empty()
            || quota_cycle_id.is_empty()
            || job_id.is_empty()
        {
            return Err("plus_solve_identity_required".to_string());
        }
        self.db
            .with_immediate_transaction(|tx| {
                let used = || {
                    tx.query_row(
                        "SELECT COUNT(*) FROM solver_plus_solve_usage \
                         WHERE school_id = ?1 AND quota_cycle_id = ?2",
                        params![school_id, quota_cycle_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(nonnegative_u64)
                };
                if tx
                    .query_row(
                        "SELECT 1 FROM solver_plus_solve_usage \
                         WHERE school_id = ?1 AND account_id = ?2 AND job_id = ?3",
                        params![school_id, account_id, job_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Ok(PlusSolveAdmission::Existing { used: used()? });
                }
                let current = used()?;
                if current >= PLUS_SOLVE_ACTION_LIMIT {
                    return Ok(PlusSolveAdmission::Exhausted { used: current });
                }
                let now_ms = crate::now_millis();
                tx.execute(
                    "INSERT INTO solver_plus_solve_usage \
                     (school_id, quota_cycle_id, account_id, job_id, requested_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        school_id,
                        quota_cycle_id,
                        account_id,
                        job_id,
                        sqlite_millis(now_ms)
                    ],
                )?;
                Ok(PlusSolveAdmission::Claimed {
                    used: current.saturating_add(1),
                })
            })
            .map_err(|error| error.to_string())
    }

    /// Releases a Plus claim only when its canonical job was never accepted by
    /// an executor. Matching the billing cycle prevents a stale cleanup from
    /// deleting an unrelated claim after a renewal changes the active cycle.
    pub fn release_plus_solve_claim(
        &self,
        school_id: &str,
        account_id: &str,
        quota_cycle_id: &str,
        job_id: &str,
    ) -> Result<bool, String> {
        let school_id = normalized_owner_part(school_id);
        let account_id = normalized_owner_part(account_id);
        let quota_cycle_id = normalized_owner_part(quota_cycle_id);
        let job_id = job_id.trim().chars().take(160).collect::<String>();
        if school_id.is_empty()
            || account_id.is_empty()
            || quota_cycle_id.is_empty()
            || job_id.is_empty()
        {
            return Err("plus_solve_identity_required".to_string());
        }
        self.db
            .with_immediate_transaction(|tx| {
                tx.execute(
                    "DELETE FROM solver_plus_solve_usage \
                     WHERE school_id = ?1 AND quota_cycle_id = ?2 \
                       AND account_id = ?3 AND job_id = ?4",
                    params![school_id, quota_cycle_id, account_id, job_id],
                )
                .map(|changed| changed > 0)
            })
            .map_err(|error| error.to_string())
    }

    pub fn config_for_school(&self, school_id: &str) -> ServerlessConfig {
        let mut config = self.config();
        let Some(policy) = self.school_policy(school_id) else {
            return config;
        };
        config.mode = policy.mode;
        if let Some(profile_id) = policy.active_profile_id {
            config.active_profile_id = Some(profile_id);
        }
        config
    }

    pub fn set_config(&self, value: &Value) -> Result<ServerlessConfig, String> {
        let sanitized = sanitize_config(value)?;
        let config = ServerlessConfig::from_value(&sanitized);
        self.db
            .set(
                CONFIG_KEY,
                &serde_json::to_string(&sanitized).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        Ok(config)
    }

    /// A school administrator may select only a mode and one of the enabled
    /// profiles already created by the superadmin. URLs, audiences, budgets,
    /// credentials and profile resources are never accepted here.
    pub fn set_school_policy(
        &self,
        school_id: &str,
        value: &Value,
    ) -> Result<ServerlessConfig, String> {
        let school_id = school_id.trim();
        if school_id.is_empty() {
            return Err("serverless_school_required".to_string());
        }
        let object = value
            .as_object()
            .ok_or_else(|| "serverless_school_policy_must_be_object".to_string())?;
        let forbidden = [
            "profiles",
            "budgetUsd",
            "estimatedCostUsd",
            "fallback",
            "url",
            "audience",
            "projectId",
            "region",
        ];
        if forbidden.iter().any(|key| object.contains_key(*key)) {
            return Err("serverless_school_policy_forbidden_field".to_string());
        }
        let mode = checked_routing_mode(object.get("mode").and_then(Value::as_str))?;
        let profile_id = object
            .get("activeProfileId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(80).collect::<String>());
        let global = self.config();
        if let Some(profile_id) = profile_id.as_deref() {
            if !global
                .profiles
                .iter()
                .any(|profile| profile.enabled && profile.id == profile_id)
            {
                return Err("serverless_profile_not_allowed".to_string());
            }
        }
        let effective_profile = profile_id
            .as_deref()
            .and_then(|id| {
                global
                    .profiles
                    .iter()
                    .find(|profile| profile.enabled && profile.id == id)
            })
            .cloned()
            .or_else(|| global.selected_profile());
        if mode == RoutingMode::ServerlessOnly && effective_profile.is_none() {
            return Err("serverless_profile_unavailable".to_string());
        }
        let policy = json!({
            "version": 1,
            "schoolId": school_id,
            "mode": mode.as_str(),
            "activeProfileId": profile_id,
            "updatedAtMs": crate::now_millis()
        });
        self.db
            .set(
                &school_policy_key(school_id),
                &serde_json::to_string(&policy).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        Ok(self.config_for_school(school_id))
    }

    pub fn enabled_for_new_job(&self) -> bool {
        self.enabled_for_new_job_for_school("")
    }

    pub fn enabled_for_new_job_for_school(&self, school_id: &str) -> bool {
        let config = self.config_for_school(school_id);
        !matches!(config.mode, RoutingMode::VpsOnly) && config.selected_profile().is_some()
    }

    pub fn serverless_only(&self) -> bool {
        self.serverless_only_for_school("")
    }

    pub fn serverless_only_for_school(&self, school_id: &str) -> bool {
        self.config_for_school(school_id).mode == RoutingMode::ServerlessOnly
    }

    pub fn fallback_to_vps(&self) -> bool {
        self.fallback_to_vps_for_school("")
    }

    pub fn fallback_to_vps_for_school(&self, school_id: &str) -> bool {
        let config = self.config_for_school(school_id);
        config.fallback == "vps" && config.mode != RoutingMode::ServerlessOnly
    }

    pub fn selected_profile(&self) -> Option<ServerlessProfile> {
        self.selected_profile_for_school("")
    }

    pub fn selected_profile_for_school(&self, school_id: &str) -> Option<ServerlessProfile> {
        self.config_for_school(school_id).selected_profile()
    }

    /// Conservative Cloud Run request estimate. These are intentionally
    /// estimates (Google's billing export is reconciled separately); the
    /// reservation remains the safety ceiling when an export is unavailable.
    pub fn estimate_actual_cost_usd(profile: &ServerlessProfile, elapsed_ms: u64) -> f64 {
        let seconds = (elapsed_ms as f64 / 1000.0).max(0.1);
        let cpu_rate = env_f64("TKB_CLOUD_RUN_CPU_USD_PER_VCPU_SECOND", 0.000024);
        let memory_rate = env_f64("TKB_CLOUD_RUN_MEMORY_USD_PER_GIB_SECOND", 0.0000025);
        (seconds * (f64::from(profile.vcpu) * cpu_rate + profile.memory_gib * memory_rate))
            .clamp(0.0, 1000.0)
    }

    pub fn reserve(&self, job_id: &str) -> Result<f64, String> {
        self.reserve_for_school(job_id, "")
            .map(|reservation| reservation.estimated_usd)
    }

    pub fn reserve_for_school(
        &self,
        job_id: &str,
        school_id: &str,
    ) -> Result<ServerlessReservation, String> {
        self.reserve_for_owner(job_id, school_id, "")
    }

    pub fn reserve_for_owner(
        &self,
        job_id: &str,
        school_id: &str,
        account_id: &str,
    ) -> Result<ServerlessReservation, String> {
        self.reserve_at(
            job_id,
            school_id,
            account_id,
            crate::now_millis(),
            self.reservation_ttl_ms,
        )
    }

    fn reserve_at(
        &self,
        job_id: &str,
        school_id: &str,
        account_id: &str,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<ServerlessReservation, String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return Err("serverless_job_id_required".to_string());
        }
        let now_i64 = sqlite_millis(now_ms);
        let expires_i64 = sqlite_millis(now_ms.saturating_add(ttl_ms.max(1)));
        self
            .db
            .with_immediate_transaction(|tx| {
                // Read the routing policy while holding the same SQLite writer
                // transaction as reservation creation. The reservation remains
                // an idempotent execution/usage record, but its estimated cost
                // is telemetry only and never blocks Cloud Run admission.
                let config = config_for_school_transaction(tx, school_id)?;
                let selected = config.selected_profile().ok_or_else(|| {
                    ledger_user_error("serverless_profile_unavailable")
                })?;
                let estimate = config.estimated_cost_usd;
                tx.execute(
                    "DELETE FROM serverless_reservations WHERE expires_at_ms <= ?1",
                    [now_i64],
                )?;
                if let Some(existing) = tx
                    .query_row(
                        "SELECT profile_id, estimated_usd FROM serverless_reservations WHERE job_id = ?1",
                        [job_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
                    )
                    .optional()?
                {
                    let profile = config
                        .profiles
                        .iter()
                        .find(|profile| profile.enabled && profile.id == existing.0)
                        .cloned()
                        .ok_or_else(|| {
                            ledger_user_error("serverless_reserved_profile_unavailable")
                        })?;
                    let normalized_school_id = normalized_owner_part(school_id);
                    let normalized_account_id = normalized_owner_part(account_id);
                    tx.execute(
                        "UPDATE serverless_reservations \
                         SET school_id = CASE WHEN school_id = '' THEN ?2 ELSE school_id END, \
                             account_id = CASE WHEN account_id = '' THEN ?3 ELSE account_id END \
                         WHERE job_id = ?1",
                        params![job_id, normalized_school_id, normalized_account_id],
                    )?;
                    tx.execute(
                        "UPDATE OR IGNORE solver_execution_usage \
                         SET school_id = CASE WHEN school_id = '' THEN ?2 ELSE school_id END, \
                             account_id = CASE WHEN account_id = '' THEN ?3 ELSE account_id END \
                         WHERE job_id = ?1 AND executor = 'cloud_run' \
                           AND status IN ('requested','running')",
                        params![job_id, normalized_school_id, normalized_account_id],
                    )?;
                    record_execution_requested(
                        tx,
                        job_id,
                        school_id,
                        account_id,
                        "cloud_run",
                        Some(&profile.id),
                        existing.1,
                        now_ms,
                    )?;
                    return Ok(ServerlessReservation {
                        profile,
                        estimated_usd: existing.1,
                    });
                }
                tx.execute(
                    "INSERT INTO serverless_reservations \
                     (job_id, profile_id, school_id, account_id, estimated_usd, created_at_ms, expires_at_ms, dispatched_at_ms, cancel_requested_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)",
                    params![
                        job_id,
                        selected.id,
                        normalized_owner_part(school_id),
                        normalized_owner_part(account_id),
                        estimate,
                        now_i64,
                        expires_i64
                    ],
                )?;
                record_execution_requested(
                    tx,
                    job_id,
                    school_id,
                    account_id,
                    "cloud_run",
                    Some(&selected.id),
                    estimate,
                    now_ms,
                )?;
                Ok(ServerlessReservation {
                    profile: selected,
                    estimated_usd: estimate,
                })
            })
            .map_err(ledger_error_string)
    }

    /// Marks the point after which Cloud Run may have started billing. This is
    /// deliberately separate from reservation: cancellation before dispatch
    /// releases the full estimate, while cancellation after dispatch records
    /// its measured cost and a dedicated `cancelledJobs` outcome.
    pub fn mark_dispatched(&self, job_id: &str) -> bool {
        let now_ms = crate::now_millis();
        self.db
            .with_immediate_transaction(|tx| {
                let changed = tx.execute(
                    "UPDATE serverless_reservations \
                     SET dispatched_at_ms = COALESCE(dispatched_at_ms, ?2), \
                         expires_at_ms = MAX(expires_at_ms, ?3) \
                     WHERE job_id = ?1",
                    params![
                        job_id,
                        sqlite_millis(now_ms),
                        sqlite_millis(now_ms.saturating_add(self.reservation_ttl_ms))
                    ],
                )?;
                if changed > 0 {
                    tx.execute(
                        "UPDATE solver_execution_usage \
                         SET status = 'running', started_at_ms = COALESCE(started_at_ms, ?2), \
                             updated_at_ms = ?2 \
                         WHERE job_id = ?1 AND executor = 'cloud_run' \
                           AND status IN ('requested','running')",
                        params![job_id, sqlite_millis(now_ms)],
                    )?;
                }
                Ok(changed > 0)
            })
            .unwrap_or(false)
    }

    /// Persists cancellation intent beside the reservation so a Cloud result
    /// racing between the in-memory job fence and SQLite reconciliation cannot
    /// be counted as a successful timetable.
    pub fn mark_cancel_requested(&self, job_id: &str) -> bool {
        self.db
            .with_immediate_transaction(|tx| {
                let changed = tx.execute(
                    "UPDATE serverless_reservations \
                     SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?2) \
                     WHERE job_id = ?1",
                    params![job_id, sqlite_millis(crate::now_millis())],
                )?;
                Ok(changed > 0)
            })
            .unwrap_or(false)
    }

    pub fn reconcile(&self, job_id: &str, actual_usd: Option<f64>, success: bool) {
        let outcome = if success {
            ReservationOutcome::Completed
        } else {
            ReservationOutcome::Failed
        };
        let _ = self.reconcile_outcome(job_id, actual_usd, outcome);
    }

    pub fn reconcile_outcome(
        &self,
        job_id: &str,
        actual_usd: Option<f64>,
        outcome: ReservationOutcome,
    ) -> bool {
        self.db
            .with_immediate_transaction(|tx| {
                let reservation = tx
                    .query_row(
                        "SELECT profile_id, estimated_usd, cancel_requested_at_ms IS NOT NULL, \
                                school_id, account_id, created_at_ms \
                         FROM serverless_reservations WHERE job_id = ?1",
                        [job_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, f64>(1)?,
                                row.get::<_, bool>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, i64>(5)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((profile_id, estimate, cancel_requested, school_id, account_id, created_at_ms)) = reservation else {
                    return Ok(false);
                };
                tx.execute(
                    "DELETE FROM serverless_reservations WHERE job_id = ?1",
                    [job_id],
                )?;
                if outcome == ReservationOutcome::Released {
                    finish_execution_row(
                        tx,
                        job_id,
                        &school_id,
                        &account_id,
                        "cloud_run",
                        Some(&profile_id),
                        estimate,
                        0.0,
                        "released",
                        created_at_ms.max(0) as u64,
                        crate::now_millis(),
                    )?;
                    return Ok(true);
                }
                let outcome = if cancel_requested {
                    ReservationOutcome::Cancelled
                } else {
                    outcome
                };
                let measured = actual_usd.unwrap_or(estimate).clamp(0.0, 1000.0);
                // On a transport failure or client-side cancellation Cloud Run
                // may continue briefly after the HTTP client disconnects. Keep
                // the original reservation as the minimum conservative charge
                // for those outcomes; successful requests can use their lower
                // measured estimate.
                let actual = if outcome == ReservationOutcome::Completed {
                    measured
                } else {
                    measured.max(estimate)
                };
                let (completed, failed, cancelled) = match outcome {
                    ReservationOutcome::Completed => (1_i64, 0_i64, 0_i64),
                    ReservationOutcome::Failed => (0, 1, 0),
                    ReservationOutcome::Cancelled => (0, 0, 1),
                    ReservationOutcome::Released => unreachable!(),
                };
                tx.execute(
                    "INSERT INTO serverless_profile_usage \
                     (profile_id, committed_usd, completed_jobs, failed_jobs, cancelled_jobs, last_event_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                     ON CONFLICT(profile_id) DO UPDATE SET \
                       committed_usd = serverless_profile_usage.committed_usd + excluded.committed_usd, \
                       completed_jobs = serverless_profile_usage.completed_jobs + excluded.completed_jobs, \
                       failed_jobs = serverless_profile_usage.failed_jobs + excluded.failed_jobs, \
                       cancelled_jobs = serverless_profile_usage.cancelled_jobs + excluded.cancelled_jobs, \
                       last_event_at_ms = excluded.last_event_at_ms",
                    params![
                        profile_id,
                        actual,
                        completed,
                        failed,
                        cancelled,
                        sqlite_millis(crate::now_millis())
                    ],
                )?;
                finish_execution_row(
                    tx,
                    job_id,
                    &school_id,
                    &account_id,
                    "cloud_run",
                    Some(&profile_id),
                    estimate,
                    actual,
                    match outcome {
                        ReservationOutcome::Completed => "completed",
                        ReservationOutcome::Failed => "failed",
                        ReservationOutcome::Cancelled => "cancelled",
                        ReservationOutcome::Released => unreachable!(),
                    },
                    created_at_ms.max(0) as u64,
                    crate::now_millis(),
                )?;
                Ok(true)
            })
            .unwrap_or(false)
    }

    pub fn release(&self, job_id: &str) -> bool {
        self.reconcile_outcome(job_id, Some(0.0), ReservationOutcome::Released)
    }

    /// Releases a not-yet-dispatched reservation. Returns false once Cloud Run
    /// may be billing it; the coordinator thread then owns final reconciliation.
    pub fn release_before_dispatch(&self, job_id: &str) -> bool {
        self.db
            .with_immediate_transaction(|tx| {
                let reservation = tx
                    .query_row(
                        "SELECT profile_id, school_id, account_id, estimated_usd, created_at_ms \
                         FROM serverless_reservations \
                         WHERE job_id = ?1 AND dispatched_at_ms IS NULL",
                        [job_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, f64>(3)?,
                                row.get::<_, i64>(4)?,
                            ))
                        },
                    )
                    .optional()?;
                let changed = tx.execute(
                    "DELETE FROM serverless_reservations \
                     WHERE job_id = ?1 AND dispatched_at_ms IS NULL",
                    [job_id],
                )?;
                if let Some((profile_id, school_id, account_id, estimate, created_at_ms)) = reservation {
                    finish_execution_row(
                        tx,
                        job_id,
                        &school_id,
                        &account_id,
                        "cloud_run",
                        Some(&profile_id),
                        estimate,
                        0.0,
                        "released",
                        created_at_ms.max(0) as u64,
                        crate::now_millis(),
                    )?;
                }
                Ok(changed > 0)
            })
            .unwrap_or(false)
    }

    /// Records a server execution request. This ledger is deliberately separate
    /// from Cloud budget reservations: it counts who asked the VPS or Cloud Run
    /// to solve, while the profile ledger remains the budget gate.
    pub fn record_execution_requested(
        &self,
        job_id: &str,
        school_id: &str,
        account_id: &str,
        executor: &str,
    ) -> bool {
        let Some(executor) = normalized_server_executor(executor) else {
            return false;
        };
        let now_ms = crate::now_millis();
        self.db
            .with_immediate_transaction(|tx| {
                record_execution_requested(
                    tx,
                    job_id,
                    school_id,
                    account_id,
                    executor,
                    None,
                    0.0,
                    now_ms,
                )?;
                Ok(true)
            })
            .unwrap_or(false)
    }

    pub fn record_execution_started(
        &self,
        job_id: &str,
        school_id: &str,
        account_id: &str,
        executor: &str,
    ) -> bool {
        let Some(executor) = normalized_server_executor(executor) else {
            return false;
        };
        let now_ms = crate::now_millis();
        self.db
            .with_immediate_transaction(|tx| {
                record_execution_requested(
                    tx,
                    job_id,
                    school_id,
                    account_id,
                    executor,
                    None,
                    0.0,
                    now_ms,
                )?;
                tx.execute(
                    "UPDATE solver_execution_usage \
                     SET status = 'running', started_at_ms = COALESCE(started_at_ms, ?3), \
                         updated_at_ms = ?3 \
                     WHERE job_id = ?1 AND executor = ?2 AND school_id = ?4 AND account_id = ?5 \
                       AND status IN ('requested','running')",
                    params![
                        job_id,
                        executor,
                        sqlite_millis(now_ms),
                        normalized_owner_part(school_id),
                        normalized_owner_part(account_id)
                    ],
                )?;
                Ok(true)
            })
            .unwrap_or(false)
    }

    pub fn record_execution_outcome(
        &self,
        job_id: &str,
        school_id: &str,
        account_id: &str,
        executor: &str,
        outcome: ReservationOutcome,
    ) -> bool {
        let Some(executor) = normalized_server_executor(executor) else {
            return false;
        };
        let now_ms = crate::now_millis();
        self.db
            .with_immediate_transaction(|tx| {
                finish_execution_row(
                    tx,
                    job_id,
                    school_id,
                    account_id,
                    executor,
                    None,
                    0.0,
                    0.0,
                    match outcome {
                        ReservationOutcome::Completed => "completed",
                        ReservationOutcome::Failed => "failed",
                        ReservationOutcome::Cancelled => "cancelled",
                        ReservationOutcome::Released => "released",
                    },
                    now_ms,
                    now_ms,
                )?;
                Ok(true)
            })
            .unwrap_or(false)
    }

    pub fn usage_json(&self) -> Value {
        self.usage_json_for_school("")
    }

    pub fn usage_json_for_school(&self, school_id: &str) -> Value {
        let now_ms = crate::now_millis();
        let _ = self.prune_expired(now_ms);
        let snapshot = self.ledger_snapshot().unwrap_or_default();
        let config = self.config_for_school(school_id);
        let active_profile = config.selected_profile();
        let active_id = active_profile.as_ref().map(|profile| profile.id.clone());
        let mut profile_ids = HashSet::new();
        profile_ids.extend(config.profiles.iter().map(|profile| profile.id.clone()));
        profile_ids.extend(snapshot.profile_committed.keys().cloned());
        profile_ids.extend(snapshot.profile_reserved.keys().cloned());
        let mut profiles = Map::new();
        for profile_id in profile_ids {
            profiles.insert(
                profile_id.clone(),
                json!({
                    "completedJobs": snapshot.profile_completed.get(&profile_id).copied().unwrap_or(0),
                    "failedJobs": snapshot.profile_failed.get(&profile_id).copied().unwrap_or(0),
                    "cancelledJobs": snapshot.profile_cancelled.get(&profile_id).copied().unwrap_or(0)
                }),
            );
        }
        let completed = snapshot.profile_completed.values().sum::<u64>();
        let failed = snapshot.profile_failed.values().sum::<u64>();
        let cancelled = snapshot.profile_cancelled.values().sum::<u64>();
        let account_requests = self.account_execution_usage(school_id).unwrap_or_default();
        let account_request_totals = account_usage_totals(&account_requests);
        let account_requests = account_requests
            .into_iter()
            .map(account_usage_json)
            .collect::<Vec<_>>();
        json!({
            "completedJobs": completed,
            "failedJobs": failed,
            "cancelledJobs": cancelled,
            "profiles": profiles,
            "activeProfileId": active_id,
            "activeReservations": snapshot.active_reservations,
            "accountRequestTotals": account_request_totals,
            "accountRequests": account_requests
        })
    }

    fn account_execution_usage(
        &self,
        school_id: &str,
    ) -> Result<Vec<AccountExecutionUsage>, String> {
        self.db
            .with_immediate_transaction(|conn| {
                let mut statement = conn.prepare(
                    "SELECT school_id, account_id, \
                        SUM(CASE WHEN executor = 'cloud_run' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'cloud_run' AND status = 'completed' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'cloud_run' AND status = 'failed' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'cloud_run' AND status = 'cancelled' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'cloud_run' AND status = 'released' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'cloud_run' AND status IN ('requested','running') THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'vps' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'vps' AND status = 'completed' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'vps' AND status = 'failed' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'vps' AND status = 'cancelled' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'vps' AND status = 'released' THEN 1 ELSE 0 END), \
                        SUM(CASE WHEN executor = 'vps' AND status IN ('requested','running') THEN 1 ELSE 0 END), \
                        MAX(requested_at_ms) \
                     FROM solver_execution_usage \
                     WHERE (?1 = '' OR school_id = ?1) \
                     GROUP BY school_id, account_id \
                     ORDER BY MAX(requested_at_ms) DESC, school_id, account_id",
                )?;
                let rows = statement.query_map([normalized_owner_part(school_id)], |row| {
                    Ok(AccountExecutionUsage {
                        school_id: row.get(0)?,
                        account_id: row.get(1)?,
                        cloud_run_requests: nonnegative_u64(row.get::<_, i64>(2)?),
                        cloud_run_completed: nonnegative_u64(row.get::<_, i64>(3)?),
                        cloud_run_failed: nonnegative_u64(row.get::<_, i64>(4)?),
                        cloud_run_cancelled: nonnegative_u64(row.get::<_, i64>(5)?),
                        cloud_run_released: nonnegative_u64(row.get::<_, i64>(6)?),
                        cloud_run_active: nonnegative_u64(row.get::<_, i64>(7)?),
                        vps_requests: nonnegative_u64(row.get::<_, i64>(8)?),
                        vps_completed: nonnegative_u64(row.get::<_, i64>(9)?),
                        vps_failed: nonnegative_u64(row.get::<_, i64>(10)?),
                        vps_cancelled: nonnegative_u64(row.get::<_, i64>(11)?),
                        vps_released: nonnegative_u64(row.get::<_, i64>(12)?),
                        vps_active: nonnegative_u64(row.get::<_, i64>(13)?),
                        last_requested_at_ms: nonnegative_u64(row.get::<_, i64>(14)?),
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| error.to_string())
    }

    fn school_policy(&self, school_id: &str) -> Option<SchoolRoutingPolicy> {
        let school_id = school_id.trim();
        if school_id.is_empty() {
            return None;
        }
        self.db
            .get(&school_policy_key(school_id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| SchoolRoutingPolicy::from_value(&value, school_id))
    }

    fn ensure_ledger_storage(&self) -> Result<(), String> {
        let legacy = self
            .db
            .get(USAGE_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        self.db
            .with_immediate_transaction(|tx| {
                tx.execute_batch(
                    "CREATE TABLE IF NOT EXISTS serverless_profile_usage (
                       profile_id TEXT PRIMARY KEY,
                       committed_usd REAL NOT NULL DEFAULT 0,
                       completed_jobs INTEGER NOT NULL DEFAULT 0,
                       failed_jobs INTEGER NOT NULL DEFAULT 0,
                       cancelled_jobs INTEGER NOT NULL DEFAULT 0,
                       last_event_at_ms INTEGER NOT NULL DEFAULT 0
                     );
                     CREATE TABLE IF NOT EXISTS serverless_reservations (
                       job_id TEXT PRIMARY KEY,
                       profile_id TEXT NOT NULL,
                       school_id TEXT NOT NULL DEFAULT '',
                       account_id TEXT NOT NULL DEFAULT '',
                       estimated_usd REAL NOT NULL,
                       created_at_ms INTEGER NOT NULL,
                       expires_at_ms INTEGER NOT NULL,
                       dispatched_at_ms INTEGER,
                       cancel_requested_at_ms INTEGER
                     );
                     CREATE INDEX IF NOT EXISTS idx_serverless_reservations_profile
                       ON serverless_reservations(profile_id, expires_at_ms);
                     CREATE TABLE IF NOT EXISTS solver_execution_usage (
                       job_id TEXT NOT NULL,
                       executor TEXT NOT NULL,
                       school_id TEXT NOT NULL DEFAULT '',
                       account_id TEXT NOT NULL DEFAULT '',
                       profile_id TEXT,
                       status TEXT NOT NULL DEFAULT 'requested',
                       estimated_usd REAL NOT NULL DEFAULT 0,
                       committed_usd REAL NOT NULL DEFAULT 0,
                       requested_at_ms INTEGER NOT NULL,
                       started_at_ms INTEGER,
                       completed_at_ms INTEGER,
                       updated_at_ms INTEGER NOT NULL,
                       PRIMARY KEY(job_id, executor, school_id, account_id)
                     );
                     CREATE INDEX IF NOT EXISTS idx_solver_execution_usage_owner
                       ON solver_execution_usage(school_id, account_id, requested_at_ms);
                     CREATE INDEX IF NOT EXISTS idx_solver_execution_usage_status
                       ON solver_execution_usage(executor, status, requested_at_ms);
                     CREATE TABLE IF NOT EXISTS solver_free_solve_usage (
                       school_id TEXT NOT NULL,
                       account_id TEXT NOT NULL,
                       job_id TEXT NOT NULL,
                       requested_at_ms INTEGER NOT NULL,
                       PRIMARY KEY(school_id, account_id, job_id)
                     );
                     CREATE INDEX IF NOT EXISTS idx_solver_free_solve_usage_school
                       ON solver_free_solve_usage(school_id, requested_at_ms);
                     CREATE TABLE IF NOT EXISTS solver_trial_solve_usage (
                       school_id TEXT NOT NULL,
                       account_id TEXT NOT NULL,
                       job_id TEXT NOT NULL,
                       requested_at_ms INTEGER NOT NULL,
                       PRIMARY KEY(school_id, account_id, job_id)
                     );
                     CREATE INDEX IF NOT EXISTS idx_solver_trial_solve_usage_school
                       ON solver_trial_solve_usage(school_id, requested_at_ms);
                     CREATE TABLE IF NOT EXISTS solver_plus_solve_usage (
                       school_id TEXT NOT NULL,
                       quota_cycle_id TEXT NOT NULL,
                       account_id TEXT NOT NULL,
                       job_id TEXT NOT NULL,
                       requested_at_ms INTEGER NOT NULL,
                       PRIMARY KEY(school_id, account_id, job_id)
                     );
                     CREATE INDEX IF NOT EXISTS idx_solver_plus_solve_usage_cycle
                       ON solver_plus_solve_usage(school_id, quota_cycle_id, requested_at_ms);",
                )?;
                ensure_solver_execution_usage_primary_key(tx)?;
                let has_cancel_column = {
                    let mut columns = tx.prepare("PRAGMA table_info(serverless_reservations)")?;
                    let names = columns.query_map([], |row| row.get::<_, String>(1))?;
                    let mut found = false;
                    for name in names {
                        if name? == "cancel_requested_at_ms" {
                            found = true;
                            break;
                        }
                    }
                    found
                };
                if !has_cancel_column {
                    tx.execute(
                        "ALTER TABLE serverless_reservations ADD COLUMN cancel_requested_at_ms INTEGER",
                        [],
                    )?;
                }
                for (column, definition) in [
                    ("school_id", "TEXT NOT NULL DEFAULT ''"),
                    ("account_id", "TEXT NOT NULL DEFAULT ''"),
                ] {
                    if !table_has_column(tx, "serverless_reservations", column)? {
                        tx.execute(
                            &format!(
                                "ALTER TABLE serverless_reservations ADD COLUMN {column} {definition}"
                            ),
                            [],
                        )?;
                    }
                }
                tx.execute(
                    "INSERT OR IGNORE INTO solver_execution_usage \
                     (job_id, executor, school_id, account_id, profile_id, status, estimated_usd, \
                      committed_usd, requested_at_ms, started_at_ms, completed_at_ms, updated_at_ms) \
                     SELECT job_id, 'cloud_run', school_id, account_id, profile_id, \
                            CASE WHEN dispatched_at_ms IS NULL THEN 'requested' ELSE 'running' END, \
                            estimated_usd, 0, created_at_ms, dispatched_at_ms, NULL, created_at_ms \
                     FROM serverless_reservations",
                    [],
                )?;
                let row_count = tx.query_row(
                    "SELECT COUNT(*) FROM serverless_profile_usage",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                if row_count == 0 {
                    if let Some(legacy) = legacy.as_ref() {
                        migrate_legacy_usage(tx, legacy)?;
                    }
                }
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    fn prune_expired(&self, now_ms: u64) -> Result<usize, String> {
        self.db
            .with_immediate_transaction(|tx| {
                // An undispatched row is only a quota hold and can be released.
                // A dispatched row may already have consumed Cloud Run CPU; if
                // the API died before reconciliation, conservatively commit its
                // reserved estimate as a failed attempt instead of forgetting
                // billable work at TTL expiry.
                let mut statement = tx.prepare(
                    "SELECT profile_id, COALESCE(SUM(estimated_usd), 0), COUNT(*) \
                     FROM serverless_reservations \
                     WHERE expires_at_ms <= ?1 AND dispatched_at_ms IS NOT NULL \
                     GROUP BY profile_id",
                )?;
                let rows = statement
                    .query_map([sqlite_millis(now_ms)], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, f64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(statement);
                for (profile_id, committed, failed) in rows {
                    tx.execute(
                        "INSERT INTO serverless_profile_usage \
                         (profile_id, committed_usd, completed_jobs, failed_jobs, cancelled_jobs, last_event_at_ms) \
                         VALUES (?1, ?2, 0, ?3, 0, ?4) \
                         ON CONFLICT(profile_id) DO UPDATE SET \
                           committed_usd = serverless_profile_usage.committed_usd + excluded.committed_usd, \
                           failed_jobs = serverless_profile_usage.failed_jobs + excluded.failed_jobs, \
                           last_event_at_ms = excluded.last_event_at_ms",
                        params![
                            profile_id,
                            committed.max(0.0),
                            failed.max(0),
                            sqlite_millis(now_ms)
                        ],
                    )?;
                }
                tx.execute(
                    "UPDATE solver_execution_usage \
                     SET status = 'failed', \
                         committed_usd = MAX(committed_usd, COALESCE(( \
                           SELECT estimated_usd FROM serverless_reservations r \
                           WHERE r.job_id = solver_execution_usage.job_id \
                         ), 0)), \
                         completed_at_ms = COALESCE(completed_at_ms, ?1), updated_at_ms = ?1 \
                     WHERE executor = 'cloud_run' AND status IN ('requested','running') \
                       AND EXISTS (SELECT 1 FROM serverless_reservations r \
                         WHERE r.job_id = solver_execution_usage.job_id \
                           AND r.expires_at_ms <= ?1 AND r.dispatched_at_ms IS NOT NULL)",
                    [sqlite_millis(now_ms)],
                )?;
                tx.execute(
                    "UPDATE solver_execution_usage \
                     SET status = 'released', completed_at_ms = COALESCE(completed_at_ms, ?1), \
                         updated_at_ms = ?1 \
                     WHERE executor = 'cloud_run' AND status IN ('requested','running') \
                       AND EXISTS (SELECT 1 FROM serverless_reservations r \
                         WHERE r.job_id = solver_execution_usage.job_id \
                           AND r.expires_at_ms <= ?1 AND r.dispatched_at_ms IS NULL)",
                    [sqlite_millis(now_ms)],
                )?;
                tx.execute(
                    "DELETE FROM serverless_reservations WHERE expires_at_ms <= ?1",
                    [sqlite_millis(now_ms)],
                )
            })
            .map_err(|error| error.to_string())
    }

    fn ledger_snapshot(&self) -> Result<LedgerSnapshot, String> {
        self.db
            .with_immediate_transaction(|conn| {
                let mut snapshot = LedgerSnapshot::default();
                let mut usage = conn.prepare(
                    "SELECT profile_id, committed_usd, completed_jobs, failed_jobs, cancelled_jobs \
                     FROM serverless_profile_usage",
                )?;
                let rows = usage.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?;
                for row in rows {
                    let (id, committed, completed, failed, cancelled) = row?;
                    snapshot.profile_committed.insert(id.clone(), committed.max(0.0));
                    snapshot.profile_completed.insert(id.clone(), completed.max(0) as u64);
                    snapshot.profile_failed.insert(id.clone(), failed.max(0) as u64);
                    snapshot.profile_cancelled.insert(id, cancelled.max(0) as u64);
                }
                let mut reservations = conn.prepare(
                    "SELECT profile_id, COALESCE(SUM(estimated_usd), 0), COUNT(*) \
                     FROM serverless_reservations GROUP BY profile_id",
                )?;
                let rows = reservations.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?;
                for row in rows {
                    let (id, reserved, count) = row?;
                    snapshot.profile_reserved.insert(id, reserved.max(0.0));
                    snapshot.active_reservations = snapshot
                        .active_reservations
                        .saturating_add(count.max(0) as u64);
                }
                Ok(snapshot)
            })
            .map_err(|error| error.to_string())
    }
}

fn normalized_owner_part(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .take(160)
        .collect()
}

fn normalized_server_executor(executor: &str) -> Option<&'static str> {
    match executor.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "cloud" | "cloud_run" | "serverless" => Some("cloud_run"),
        "vps" => Some("vps"),
        _ => None,
    }
}

fn nonnegative_u64(value: i64) -> u64 {
    value.max(0) as u64
}

fn table_has_column(
    tx: &Transaction<'_>,
    table: &str,
    expected_column: &str,
) -> rusqlite::Result<bool> {
    let mut statement = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == expected_column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn table_primary_key_columns(
    tx: &Transaction<'_>,
    table: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
    })?;
    let mut columns = rows
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(_, position)| *position > 0)
        .collect::<Vec<_>>();
    columns.sort_by_key(|(_, position)| *position);
    Ok(columns.into_iter().map(|(name, _)| name).collect())
}

fn ensure_solver_execution_usage_primary_key(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let expected = ["job_id", "executor", "school_id", "account_id"];
    let actual = table_primary_key_columns(tx, "solver_execution_usage")?;
    if actual
        .iter()
        .map(String::as_str)
        .eq(expected.iter().copied())
    {
        return Ok(());
    }

    // The first account-ledger release used PRIMARY KEY(job_id, executor).
    // The later owner-scoped upsert correctly targets all four identity
    // columns, but CREATE TABLE IF NOT EXISTS cannot change an existing
    // primary key. SQLite then rejected every new Cloud Run reservation with
    // "ON CONFLICT clause does not match"; Auto silently fell back to VPS and
    // the VPS telemetry write was ignored by its best-effort call site. Rebuild
    // the small operational ledger transactionally so no request row is lost
    // and a reused client job ID remains independent across school accounts.
    tx.execute_batch(
        "DROP TABLE IF EXISTS solver_execution_usage_owner_migration;
         CREATE TABLE solver_execution_usage_owner_migration (
           job_id TEXT NOT NULL,
           executor TEXT NOT NULL,
           school_id TEXT NOT NULL DEFAULT '',
           account_id TEXT NOT NULL DEFAULT '',
           profile_id TEXT,
           status TEXT NOT NULL DEFAULT 'requested',
           estimated_usd REAL NOT NULL DEFAULT 0,
           committed_usd REAL NOT NULL DEFAULT 0,
           requested_at_ms INTEGER NOT NULL,
           started_at_ms INTEGER,
           completed_at_ms INTEGER,
           updated_at_ms INTEGER NOT NULL,
           PRIMARY KEY(job_id, executor, school_id, account_id)
         );
         INSERT OR IGNORE INTO solver_execution_usage_owner_migration
           (job_id, executor, school_id, account_id, profile_id, status,
            estimated_usd, committed_usd, requested_at_ms, started_at_ms,
            completed_at_ms, updated_at_ms)
         SELECT job_id, executor, school_id, account_id, profile_id, status,
                estimated_usd, committed_usd, requested_at_ms, started_at_ms,
                completed_at_ms, updated_at_ms
         FROM solver_execution_usage;
         DROP TABLE solver_execution_usage;
         ALTER TABLE solver_execution_usage_owner_migration
           RENAME TO solver_execution_usage;
         CREATE INDEX idx_solver_execution_usage_owner
           ON solver_execution_usage(school_id, account_id, requested_at_ms);
         CREATE INDEX idx_solver_execution_usage_status
           ON solver_execution_usage(executor, status, requested_at_ms);",
    )
}

#[allow(clippy::too_many_arguments)]
fn record_execution_requested(
    tx: &Transaction<'_>,
    job_id: &str,
    school_id: &str,
    account_id: &str,
    executor: &str,
    profile_id: Option<&str>,
    estimated_usd: f64,
    requested_at_ms: u64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO solver_execution_usage \
         (job_id, executor, school_id, account_id, profile_id, status, estimated_usd, \
          committed_usd, requested_at_ms, started_at_ms, completed_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'requested', ?6, 0, ?7, NULL, NULL, ?7) \
         ON CONFLICT(job_id, executor, school_id, account_id) DO UPDATE SET \
           profile_id = COALESCE(solver_execution_usage.profile_id, excluded.profile_id), \
           estimated_usd = MAX(solver_execution_usage.estimated_usd, excluded.estimated_usd), \
           requested_at_ms = MIN(solver_execution_usage.requested_at_ms, excluded.requested_at_ms), \
           updated_at_ms = MAX(solver_execution_usage.updated_at_ms, excluded.updated_at_ms)",
        params![
            job_id.trim().chars().take(160).collect::<String>(),
            executor,
            normalized_owner_part(school_id),
            normalized_owner_part(account_id),
            profile_id.map(|value| value.trim().chars().take(80).collect::<String>()),
            estimated_usd.clamp(0.0, 1000.0),
            sqlite_millis(requested_at_ms)
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn finish_execution_row(
    tx: &Transaction<'_>,
    job_id: &str,
    school_id: &str,
    account_id: &str,
    executor: &str,
    profile_id: Option<&str>,
    estimated_usd: f64,
    committed_usd: f64,
    status: &str,
    requested_at_ms: u64,
    completed_at_ms: u64,
) -> rusqlite::Result<()> {
    record_execution_requested(
        tx,
        job_id,
        school_id,
        account_id,
        executor,
        profile_id,
        estimated_usd,
        requested_at_ms,
    )?;
    tx.execute(
        "UPDATE solver_execution_usage \
         SET status = ?3, committed_usd = MAX(committed_usd, ?4), \
             completed_at_ms = COALESCE(completed_at_ms, ?5), updated_at_ms = ?5 \
         WHERE job_id = ?1 AND executor = ?2 AND school_id = ?6 AND account_id = ?7 \
           AND status IN ('requested','running')",
        params![
            job_id.trim().chars().take(160).collect::<String>(),
            executor,
            status,
            committed_usd.clamp(0.0, 1000.0),
            sqlite_millis(completed_at_ms),
            normalized_owner_part(school_id),
            normalized_owner_part(account_id)
        ],
    )?;
    Ok(())
}

fn account_usage_json(usage: AccountExecutionUsage) -> Value {
    let total_requests = usage.cloud_run_requests.saturating_add(usage.vps_requests);
    json!({
        "schoolId": usage.school_id,
        "accountId": usage.account_id,
        "totalRequests": total_requests,
        "completedJobs": usage.cloud_run_completed.saturating_add(usage.vps_completed),
        "failedJobs": usage.cloud_run_failed.saturating_add(usage.vps_failed),
        "cancelledJobs": usage.cloud_run_cancelled.saturating_add(usage.vps_cancelled),
        "releasedJobs": usage.cloud_run_released.saturating_add(usage.vps_released),
        "activeJobs": usage.cloud_run_active.saturating_add(usage.vps_active),
        "lastRequestedAtMs": usage.last_requested_at_ms,
        "cloudRun": {
            "requests": usage.cloud_run_requests,
            "completedJobs": usage.cloud_run_completed,
            "failedJobs": usage.cloud_run_failed,
            "cancelledJobs": usage.cloud_run_cancelled,
            "releasedJobs": usage.cloud_run_released,
            "activeJobs": usage.cloud_run_active
        },
        "vps": {
            "requests": usage.vps_requests,
            "completedJobs": usage.vps_completed,
            "failedJobs": usage.vps_failed,
            "cancelledJobs": usage.vps_cancelled,
            "releasedJobs": usage.vps_released,
            "activeJobs": usage.vps_active
        }
    })
}

fn account_usage_totals(rows: &[AccountExecutionUsage]) -> Value {
    let mut cloud_requests = 0_u64;
    let mut vps_requests = 0_u64;
    let mut completed = 0_u64;
    let mut failed = 0_u64;
    let mut cancelled = 0_u64;
    let mut released = 0_u64;
    let mut active = 0_u64;
    for row in rows {
        cloud_requests = cloud_requests.saturating_add(row.cloud_run_requests);
        vps_requests = vps_requests.saturating_add(row.vps_requests);
        completed = completed
            .saturating_add(row.cloud_run_completed)
            .saturating_add(row.vps_completed);
        failed = failed
            .saturating_add(row.cloud_run_failed)
            .saturating_add(row.vps_failed);
        cancelled = cancelled
            .saturating_add(row.cloud_run_cancelled)
            .saturating_add(row.vps_cancelled);
        released = released
            .saturating_add(row.cloud_run_released)
            .saturating_add(row.vps_released);
        active = active
            .saturating_add(row.cloud_run_active)
            .saturating_add(row.vps_active);
    }
    json!({
        "totalRequests": cloud_requests.saturating_add(vps_requests),
        "cloudRunRequests": cloud_requests,
        "vpsRequests": vps_requests,
        "completedJobs": completed,
        "failedJobs": failed,
        "cancelledJobs": cancelled,
        "releasedJobs": released,
        "activeJobs": active
    })
}

#[derive(Clone, Debug)]
struct SchoolRoutingPolicy {
    mode: RoutingMode,
    active_profile_id: Option<String>,
}

impl SchoolRoutingPolicy {
    fn from_value(value: &Value, expected_school_id: &str) -> Option<Self> {
        let object = value.as_object()?;
        if object
            .get("schoolId")
            .and_then(Value::as_str)
            .is_some_and(|stored| !stored.eq_ignore_ascii_case(expected_school_id))
        {
            return None;
        }
        Some(Self {
            mode: RoutingMode::parse(object.get("mode").and_then(Value::as_str).unwrap_or("auto")),
            active_profile_id: object
                .get("activeProfileId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(80).collect()),
        })
    }
}

#[derive(Debug)]
struct ServerlessLedgerError(String);

impl std::fmt::Display for ServerlessLedgerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ServerlessLedgerError {}

fn ledger_user_error(kind: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(ServerlessLedgerError(
        kind.to_string(),
    )))
}

fn config_for_school_transaction(
    tx: &Transaction<'_>,
    school_id: &str,
) -> rusqlite::Result<ServerlessConfig> {
    let raw_config = tx
        .query_row(
            "SELECT v FROM kvstore WHERE k = ?1",
            [CONFIG_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let mut config = raw_config
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|value| ServerlessConfig::from_value(&value))
        .unwrap_or_else(|| ServerlessConfig::from_value(&json!({})));
    let school_id = school_id.trim();
    if school_id.is_empty() {
        return Ok(config);
    }
    let raw_policy = tx
        .query_row(
            "SELECT v FROM kvstore WHERE k = ?1",
            [school_policy_key(school_id)],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(policy) = raw_policy
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| SchoolRoutingPolicy::from_value(&value, school_id))
    {
        config.mode = policy.mode;
        if let Some(profile_id) = policy.active_profile_id {
            config.active_profile_id = Some(profile_id);
        }
    }
    Ok(config)
}

fn ledger_error_string(error: rusqlite::Error) -> String {
    if let rusqlite::Error::ToSqlConversionFailure(source) = &error {
        if let Some(error) = source.downcast_ref::<ServerlessLedgerError>() {
            return error.0.clone();
        }
    }
    // Do not return SQLite paths/schema text to an HTTP caller. The detailed
    // database error remains available to a debugger, while routing gets one
    // stable infrastructure outcome it can safely fall back from.
    "serverless_accounting_unavailable".to_string()
}

fn migrate_legacy_usage(tx: &Transaction<'_>, usage: &Value) -> rusqlite::Result<()> {
    let mut migrated_profile = false;
    if let Some(profiles) = usage.get("profiles").and_then(Value::as_object) {
        for (profile_id, profile) in profiles {
            let committed = profile
                .get("committedUsd")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);
            let completed = profile
                .get("completedJobs")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(i64::MAX as u64) as i64;
            let failed = profile
                .get("failedJobs")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(i64::MAX as u64) as i64;
            if committed > 0.0 || completed > 0 || failed > 0 {
                tx.execute(
                    "INSERT OR IGNORE INTO serverless_profile_usage \
                     (profile_id, committed_usd, completed_jobs, failed_jobs, cancelled_jobs, last_event_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                    params![
                        profile_id,
                        committed,
                        completed,
                        failed,
                        sqlite_millis(crate::now_millis())
                    ],
                )?;
                migrated_profile = true;
            }
        }
    }
    if !migrated_profile {
        let committed = usage
            .get("committedUsd")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        let completed = usage
            .get("completedJobs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(i64::MAX as u64) as i64;
        let failed = usage
            .get("failedJobs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(i64::MAX as u64) as i64;
        if committed > 0.0 || completed > 0 || failed > 0 {
            tx.execute(
                "INSERT OR IGNORE INTO serverless_profile_usage \
                 (profile_id, committed_usd, completed_jobs, failed_jobs, cancelled_jobs, last_event_at_ms) \
                 VALUES ('__legacy__', ?1, ?2, ?3, 0, ?4)",
                params![
                    committed,
                    completed,
                    failed,
                    sqlite_millis(crate::now_millis())
                ],
            )?;
        }
    }
    Ok(())
}

fn env_f64(name: &str, default: f64) -> f64 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn sqlite_millis(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn value_truthy(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        _ => false,
    }
}

fn valid_cloud_run_base_url(url: &str) -> bool {
    let url = url.trim();
    let Some(host_and_path) = url.strip_prefix("https://") else {
        return false;
    };
    !host_and_path.is_empty()
        && !host_and_path.bytes().any(|byte| byte.is_ascii_whitespace())
        && !host_and_path.contains('@')
        && !host_and_path.contains('?')
        && !host_and_path.contains('#')
        && !host_and_path.trim_matches('/').contains('/')
}

fn valid_solver_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn school_policy_key(school_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"tkb-serverless-school-policy-v1\0");
    hasher.update(school_id.trim().to_ascii_lowercase().as_bytes());
    format!("{SCHOOL_POLICY_KEY_PREFIX}{:x}", hasher.finalize())
}

fn sanitize_config(value: &Value) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "serverless_config_must_be_object".to_string())?;
    let mode = checked_routing_mode(object.get("mode").and_then(Value::as_str))?;
    let fallback = object
        .get("fallback")
        .and_then(Value::as_str)
        .unwrap_or("vps")
        .trim()
        .to_ascii_lowercase();
    if !matches!(fallback.as_str(), "vps" | "none") {
        return Err(if fallback == "webagent" {
            "serverless_webagent_fallback_unavailable".to_string()
        } else {
            "serverless_fallback_invalid".to_string()
        });
    }
    if mode == RoutingMode::ServerlessOnly && fallback != "none" {
        return Err("serverless_only_fallback_must_be_none".to_string());
    }
    let mut ids = HashSet::new();
    let profiles = object
        .get("profiles")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let profile = ServerlessProfile::from_value(item)
                        .ok_or_else(|| "serverless_profile_invalid".to_string())?;
                    if !ids.insert(profile.id.clone()) {
                        return Err("serverless_profile_duplicate".to_string());
                    }
                    Ok(profile.public_value())
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    let requested_active_profile_id = object
        .get("activeProfileId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(80).collect::<String>());
    let active_profile_id = match requested_active_profile_id {
        Some(active_id)
            if profiles.iter().any(|profile| {
                profile.get("id").and_then(Value::as_str) == Some(active_id.as_str())
                    && profile.get("enabled").map(value_truthy).unwrap_or(true)
            }) => Some(active_id),
        Some(_) => return Err("serverless_active_profile_invalid".to_string()),
        None => None,
    };
    if mode == RoutingMode::ServerlessOnly && active_profile_id.is_none() && profiles.is_empty() {
        return Err("serverless_profile_unavailable".to_string());
    }
    let mut result = Map::new();
    result.insert("version".to_string(), json!(1));
    result.insert("mode".to_string(), json!(mode.as_str()));
    result.insert("fallback".to_string(), json!(fallback));
    result.insert("activeProfileId".to_string(), json!(active_profile_id));
    result.insert("profiles".to_string(), Value::Array(profiles));
    result.insert("updatedAtMs".to_string(), json!(crate::now_millis()));
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    static TEST_ID: AtomicU64 = AtomicU64::new(1);

    fn test_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "tkb-serverless-test-{}-{}.db",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn coordinator() -> Arc<ServerlessCoordinator> {
        ServerlessCoordinator::new(Arc::new(Db::new(test_path()).unwrap()))
    }

    fn digest() -> &'static str {
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }

    fn configure(c: &ServerlessCoordinator, budget: f64) {
        c.set_config(&json!({
            "mode": "auto",
            "fallback": "vps",
            "budgetUsd": budget,
            "estimatedCostUsd": 0.06,
            "activeProfileId": "p",
            "profiles": [{"id":"p","url":"https://example.run.app","budgetUsd":budget,"solverDigest":digest()}]
        }))
        .unwrap();
    }

    #[test]
    fn mode_profile_and_audience_are_sanitized() {
        let c = coordinator();
        let config = c
            .set_config(&json!({
                "mode": "serverless",
                "fallback": "none",
                "activeProfileId": "p2",
                "profiles": [
                    {"id":"p1","url":"https://one.example.run.app","solverDigest":digest(),"priority":10},
                    {"id":"p2","url":"https://two.example.run.app","audience":"https://attacker.example","solverDigest":digest(),"priority":1}
                ]
            }))
            .unwrap();
        assert_eq!(config.mode, RoutingMode::ServerlessOnly);
        let selected = config.selected_profile().unwrap();
        assert_eq!(selected.id, "p2");
        assert_eq!(selected.audience, selected.url);
        let public = config.public_value();
        assert!(public.get("budgetUsd").is_none());
        assert!(public.get("estimatedCostUsd").is_none());
        assert!(public["profiles"][0].get("budgetUsd").is_none());
    }

    #[test]
    fn missing_active_profile_does_not_rotate_to_another_account() {
        let config = ServerlessConfig::from_value(&json!({
            "mode":"auto",
            "activeProfileId":"disabled",
            "profiles":[
                {"id":"disabled","url":"https://disabled.example.run.app","solverDigest":digest(),"enabled":false},
                {"id":"other","url":"https://other.example.run.app","solverDigest":digest(),"enabled":true,"priority":99}
            ]
        }));
        assert!(config.selected_profile().is_none());
    }

    #[test]
    fn reservations_ignore_legacy_budget_and_reconcile_once() {
        let c = coordinator();
        configure(&c, 0.10);
        assert_eq!(c.reserve_for_school("a", "school").unwrap().estimated_usd, 0.06);
        assert_eq!(c.reserve_for_school("b", "school").unwrap().estimated_usd, 0.06);
        assert!(c.reconcile_outcome("a", Some(0.02), ReservationOutcome::Completed));
        assert!(!c.reconcile_outcome("a", Some(0.02), ReservationOutcome::Completed));
        let usage = c.usage_json_for_school("school");
        assert!(usage.get("budgetEnforced").is_none());
        assert!(usage.get("committedUsd").is_none());
        assert!(usage.get("reservedUsd").is_none());
        assert!(usage.get("remainingUsd").is_none());
        let snapshot = c.ledger_snapshot().unwrap();
        assert!((snapshot.profile_committed["p"] - 0.02).abs() < 1e-9);
        assert_eq!(usage["completedJobs"], json!(1));
        assert_eq!(usage["activeReservations"], json!(1));
        assert_eq!(c.reserve_for_school("c", "school").unwrap().estimated_usd, 0.06);
    }

    #[test]
    fn reservations_are_atomic_across_coordinators() {
        let path = test_path();
        let first = ServerlessCoordinator::new(Arc::new(Db::new(path.clone()).unwrap()));
        configure(&first, 0.10);
        let second = ServerlessCoordinator::new(Arc::new(Db::new(path).unwrap()));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let attempts = [(first, "a"), (second, "b")]
            .into_iter()
            .map(|(coordinator, job_id)| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    coordinator.reserve_for_school(job_id, "school").is_ok()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let admitted = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 2);
    }

    #[test]
    fn durable_reservation_survives_restart_and_expires_by_timestamp() {
        let path = test_path();
        let first = ServerlessCoordinator::new(Arc::new(Db::new(path.clone()).unwrap()));
        configure(&first, 0.10);
        let baseline = crate::now_millis();
        first
            .reserve_at("durable", "school", "", baseline, 10_000)
            .unwrap();
        drop(first);
        let second = ServerlessCoordinator::new(Arc::new(Db::new(path).unwrap()));
        assert_eq!(second.usage_json_for_school("school")["activeReservations"], json!(1));
        assert!(second
            .reserve_at("concurrent", "school", "", baseline + 5_000, 10_000)
            .is_ok());
        assert!(second
            .reserve_at("after-expiry", "school", "", baseline + 10_001, 10_000)
            .is_ok());
    }

    #[test]
    fn expired_dispatched_reservation_is_counted_as_failed_work() {
        let c = coordinator();
        configure(&c, 1.0);
        let baseline = crate::now_millis();
        c.reserve_at("expired-dispatched", "school", "", baseline, 10_000)
            .unwrap();
        assert!(c.mark_dispatched("expired-dispatched"));
        // mark_dispatched extends the lease by the coordinator TTL; advancing
        // beyond that lease simulates a process crash with no final callback.
        c.prune_expired(
            baseline
                .saturating_add(c.reservation_ttl_ms)
                .saturating_add(60_000),
        )
        .unwrap();
        let usage = c.usage_json_for_school("school");
        assert_eq!(usage["activeReservations"], json!(0));
        assert_eq!(usage["failedJobs"], json!(1));
        assert!(usage.get("committedUsd").is_none());
        let snapshot = c.ledger_snapshot().unwrap();
        assert!((snapshot.profile_committed["p"] - 0.06).abs() < 1e-9);
    }

    #[test]
    fn cancellation_before_dispatch_releases_but_running_cancel_is_accounted() {
        let c = coordinator();
        configure(&c, 1.0);
        c.reserve_for_school("before", "school").unwrap();
        assert!(c.release_before_dispatch("before"));
        assert_eq!(c.usage_json_for_school("school")["cancelledJobs"], json!(0));

        c.reserve_for_school("running", "school").unwrap();
        assert!(c.mark_dispatched("running"));
        assert!(!c.release_before_dispatch("running"));
        assert!(c.mark_cancel_requested("running"));
        assert!(c.reconcile_outcome(
            "running",
            Some(0.004),
            ReservationOutcome::Completed
        ));
        let usage = c.usage_json_for_school("school");
        assert_eq!(usage["cancelledJobs"], json!(1));
        assert_eq!(usage["failedJobs"], json!(0));
        assert_eq!(usage["completedJobs"], json!(0));
        assert_eq!(usage["activeReservations"], json!(0));
    }

    #[test]
    fn school_policy_cannot_mutate_profiles_or_budget() {
        let c = coordinator();
        configure(&c, 300.0);
        assert!(c
            .set_school_policy(
                "school-a",
                &json!({"mode":"vps_only","profiles":[],"budgetUsd":0})
            )
            .is_err());
        let effective = c
            .set_school_policy(
                "school-a",
                &json!({"mode":"serverless_only","activeProfileId":"p"}),
            )
            .unwrap();
        assert_eq!(effective.mode, RoutingMode::ServerlessOnly);
        assert_eq!(effective.selected_profile().unwrap().id, "p");
        assert_eq!(c.config().mode, RoutingMode::Auto);
    }

    #[test]
    fn unsupported_webagent_fallback_is_rejected() {
        let c = coordinator();
        let error = c
            .set_config(&json!({
                "mode":"auto",
                "fallback":"webagent",
                "profiles":[]
            }))
            .unwrap_err();
        assert_eq!(error, "serverless_webagent_fallback_unavailable");
    }

    #[test]
    fn account_request_usage_separates_cloud_run_vps_and_school_scope() {
        let c = coordinator();
        configure(&c, 10.0);

        c.reserve_for_owner("cloud-a", "School-A", "Alice")
            .unwrap();
        assert!(c.mark_dispatched("cloud-a"));
        assert!(c.reconcile_outcome(
            "cloud-a",
            Some(0.01),
            ReservationOutcome::Completed
        ));

        c.reserve_for_owner("cloud-b", "school-b", "bob")
            .unwrap();
        assert!(c.mark_dispatched("cloud-b"));
        assert!(c.reconcile_outcome(
            "cloud-b",
            Some(0.02),
            ReservationOutcome::Failed
        ));

        assert!(c.record_execution_started("vps-a", "school-a", "alice", "vps"));
        assert!(c.record_execution_outcome(
            "vps-a",
            "school-a",
            "alice",
            "vps",
            ReservationOutcome::Failed
        ));
        // Replayed callbacks and poll retries must not count another request.
        assert!(c.record_execution_started("vps-a", "school-a", "alice", "vps"));
        assert!(c.record_execution_outcome(
            "vps-a",
            "school-a",
            "alice",
            "vps",
            ReservationOutcome::Completed
        ));

        assert!(c.record_execution_started("vps-b", "school-b", "bob", "vps"));
        assert!(c.record_execution_outcome(
            "vps-b",
            "school-b",
            "bob",
            "vps",
            ReservationOutcome::Completed
        ));

        // A client-supplied job ID may be reused by another school after the
        // first result expires; ownership remains part of the telemetry key.
        assert!(c.record_execution_started("shared-id", "school-a", "alice", "vps"));
        assert!(c.record_execution_outcome(
            "shared-id",
            "school-a",
            "alice",
            "vps",
            ReservationOutcome::Completed
        ));
        assert!(c.record_execution_started("shared-id", "school-b", "bob", "vps"));
        assert!(c.record_execution_outcome(
            "shared-id",
            "school-b",
            "bob",
            "vps",
            ReservationOutcome::Failed
        ));

        let school = c.usage_json_for_school("SCHOOL-A");
        assert_eq!(school["accountRequestTotals"]["totalRequests"], json!(3));
        assert_eq!(school["accountRequestTotals"]["cloudRunRequests"], json!(1));
        assert_eq!(school["accountRequestTotals"]["vpsRequests"], json!(2));
        let alice = &school["accountRequests"][0];
        assert_eq!(alice["schoolId"], json!("school-a"));
        assert_eq!(alice["accountId"], json!("alice"));
        assert_eq!(alice["cloudRun"]["completedJobs"], json!(1));
        assert_eq!(alice["vps"]["failedJobs"], json!(1));
        assert_eq!(alice["vps"]["completedJobs"], json!(1));

        let global = c.usage_json();
        assert_eq!(global["accountRequestTotals"]["totalRequests"], json!(6));
        assert_eq!(global["accountRequests"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn free_solves_share_one_school_total_and_stop_atomically_at_five() {
        let path = test_path();
        let c = ServerlessCoordinator::new(Arc::new(Db::new(path.clone()).unwrap()));
        assert_eq!(
            c.claim_free_solve("School-A", "admin", "job-1").unwrap(),
            FreeSolveAdmission::Claimed { used: 1 }
        );
        assert_eq!(
            c.claim_free_solve("school-a", "admin", "job-1").unwrap(),
            FreeSolveAdmission::Existing { used: 1 }
        );
        assert_eq!(
            c.claim_free_solve("school-a", "sub-user", "job-1")
                .unwrap(),
            FreeSolveAdmission::Claimed { used: 2 }
        );
        for index in 2..(FREE_SOLVE_ACTION_LIMIT - 1) {
            assert_eq!(
                c.claim_free_solve("school-a", "admin", &format!("job-{index}"))
                    .unwrap(),
                FreeSolveAdmission::Claimed { used: index + 1 }
            );
        }
        let other = ServerlessCoordinator::new(Arc::new(Db::new(path).unwrap()));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let attempts = [(Arc::clone(&c), "last-a"), (Arc::clone(&other), "last-b")]
            .into_iter()
            .map(|(coordinator, suffix)| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    coordinator
                        .claim_free_solve("school-a", suffix, &format!("job-{suffix}"))
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, FreeSolveAdmission::Claimed { used: 5 }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, FreeSolveAdmission::Exhausted { used: 5 }))
                .count(),
            1
        );
        assert_eq!(
            other
                .claim_free_solve("school-b", "admin", "job-1")
                .unwrap(),
            FreeSolveAdmission::Claimed { used: 1 }
        );
        assert_eq!(
            other
                .claim_trial_solve("school-a", "admin", "trial-job")
                .unwrap(),
            TrialSolveAdmission::Claimed { used: 1 },
            "Free and Trial must remain independent pools"
        );
    }

    #[test]
    fn trial_solves_share_one_school_total_without_cross_account_deduplication() {
        let c = coordinator();
        assert_eq!(
            c.claim_trial_solve("School-A", "admin", "job-1").unwrap(),
            TrialSolveAdmission::Claimed { used: 1 }
        );
        assert_eq!(
            c.claim_trial_solve("school-a", "admin", "job-1").unwrap(),
            TrialSolveAdmission::Existing { used: 1 }
        );
        assert_eq!(
            c.claim_trial_solve("school-a", "sub-user", "job-1")
                .unwrap(),
            TrialSolveAdmission::Claimed { used: 2 }
        );
        assert_eq!(
            c.claim_trial_solve("school-a", "sub-user", "job-2")
                .unwrap(),
            TrialSolveAdmission::Claimed { used: 3 }
        );
        assert_eq!(
            c.claim_trial_solve("school-b", "admin", "job-1").unwrap(),
            TrialSolveAdmission::Claimed { used: 1 }
        );
    }

    #[test]
    fn trial_solve_limit_is_atomic_across_independent_database_connections() {
        let path = test_path();
        let c = ServerlessCoordinator::new(Arc::new(Db::new(path.clone()).unwrap()));
        for index in 0..49 {
            assert!(matches!(
                c.claim_trial_solve("school-a", "admin", &format!("job-{index}"))
                    .unwrap(),
                TrialSolveAdmission::Claimed { .. }
            ));
        }

        let other = ServerlessCoordinator::new(Arc::new(Db::new(path).unwrap()));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let attempts = [(Arc::clone(&c), "last-a"), (other, "last-b")]
            .into_iter()
            .map(|(coordinator, suffix)| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    coordinator
                        .claim_trial_solve("school-a", suffix, &format!("job-{suffix}"))
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, TrialSolveAdmission::Claimed { used: 50 }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, TrialSolveAdmission::Exhausted { used: 50 }))
                .count(),
            1
        );
    }

    #[test]
    fn unaccepted_metered_claims_release_exactly_and_can_be_reclaimed() {
        let c = coordinator();
        assert_eq!(
            c.claim_free_solve("school-a", "admin", "free-job")
                .unwrap(),
            FreeSolveAdmission::Claimed { used: 1 }
        );
        assert!(!c
            .release_free_solve_claim("school-a", "other", "free-job")
            .unwrap());
        assert!(c
            .release_free_solve_claim("SCHOOL-A", "ADMIN", "free-job")
            .unwrap());
        assert_eq!(
            c.claim_free_solve("school-a", "admin", "free-job")
                .unwrap(),
            FreeSolveAdmission::Claimed { used: 1 }
        );

        assert_eq!(
            c.claim_trial_solve("school-a", "admin", "trial-job")
                .unwrap(),
            TrialSolveAdmission::Claimed { used: 1 }
        );
        assert!(!c
            .release_trial_solve_claim("school-a", "other", "trial-job")
            .unwrap());
        assert!(c
            .release_trial_solve_claim("SCHOOL-A", "ADMIN", "trial-job")
            .unwrap());
        assert!(!c
            .release_trial_solve_claim("school-a", "admin", "trial-job")
            .unwrap());
        assert_eq!(
            c.claim_trial_solve("school-a", "admin", "trial-job")
                .unwrap(),
            TrialSolveAdmission::Claimed { used: 1 }
        );

        assert_eq!(
            c.claim_plus_solve("school-a", "admin", "cycle-a", "plus-job")
                .unwrap(),
            PlusSolveAdmission::Claimed { used: 1 }
        );
        assert!(!c
            .release_plus_solve_claim("school-a", "admin", "cycle-b", "plus-job")
            .unwrap());
        assert!(!c
            .release_plus_solve_claim("school-a", "other", "cycle-a", "plus-job")
            .unwrap());
        assert!(c
            .release_plus_solve_claim("SCHOOL-A", "ADMIN", "CYCLE-A", "plus-job")
            .unwrap());
        assert!(!c
            .release_plus_solve_claim("school-a", "admin", "cycle-a", "plus-job")
            .unwrap());
        assert_eq!(
            c.claim_plus_solve("school-a", "admin", "cycle-a", "plus-job")
                .unwrap(),
            PlusSolveAdmission::Claimed { used: 1 }
        );
    }

    #[test]
    fn plus_solves_share_each_school_cycle_and_do_not_backfill_trial_usage() {
        let c = coordinator();
        assert_eq!(
            c.claim_trial_solve("school-a", "admin", "trial-job")
                .unwrap(),
            TrialSolveAdmission::Claimed { used: 1 }
        );
        assert_eq!(
            c.claim_plus_solve("School-A", "Admin", "Cycle-A", "job-1")
                .unwrap(),
            PlusSolveAdmission::Claimed { used: 1 }
        );
        assert_eq!(
            c.claim_plus_solve("school-a", "admin", "cycle-a", "job-1")
                .unwrap(),
            PlusSolveAdmission::Existing { used: 1 }
        );
        assert_eq!(
            c.claim_plus_solve("school-a", "sub-user", "cycle-a", "job-1")
                .unwrap(),
            PlusSolveAdmission::Claimed { used: 2 }
        );
        assert_eq!(
            c.claim_plus_solve("school-a", "admin", "cycle-b", "job-2")
                .unwrap(),
            PlusSolveAdmission::Claimed { used: 1 }
        );
        // Canonical job idempotency spans cycles; an old job cannot be replayed
        // to consume another unit in the newly active cycle.
        assert_eq!(
            c.claim_plus_solve("school-a", "admin", "cycle-b", "job-1")
                .unwrap(),
            PlusSolveAdmission::Existing { used: 1 }
        );
        assert_eq!(
            c.claim_plus_solve("school-b", "admin", "cycle-a", "job-1")
                .unwrap(),
            PlusSolveAdmission::Claimed { used: 1 }
        );
    }

    #[test]
    fn plus_solve_limit_is_atomic_across_independent_database_connections() {
        let path = test_path();
        let c = ServerlessCoordinator::new(Arc::new(Db::new(path.clone()).unwrap()));
        for index in 0..99 {
            assert!(matches!(
                c.claim_plus_solve("school-a", "admin", "cycle-a", &format!("job-{index}"))
                    .unwrap(),
                PlusSolveAdmission::Claimed { .. }
            ));
        }

        let other = ServerlessCoordinator::new(Arc::new(Db::new(path).unwrap()));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let attempts = [(Arc::clone(&c), "last-a"), (other, "last-b")]
            .into_iter()
            .map(|(coordinator, suffix)| {
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    coordinator
                        .claim_plus_solve("school-a", suffix, "cycle-a", &format!("job-{suffix}"))
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, PlusSolveAdmission::Claimed { used: 100 }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, PlusSolveAdmission::Exhausted { used: 100 }))
                .count(),
            1
        );
    }

    #[test]
    fn migrates_legacy_execution_ledger_primary_key_for_owner_scoped_rows() {
        let path = test_path();
        let db = Arc::new(Db::new(path).unwrap());
        db.with_immediate_transaction(|tx| {
            tx.execute_batch(
                "CREATE TABLE solver_execution_usage (
                   job_id TEXT NOT NULL,
                   executor TEXT NOT NULL,
                   school_id TEXT NOT NULL DEFAULT '',
                   account_id TEXT NOT NULL DEFAULT '',
                   profile_id TEXT,
                   status TEXT NOT NULL DEFAULT 'requested',
                   estimated_usd REAL NOT NULL DEFAULT 0,
                   committed_usd REAL NOT NULL DEFAULT 0,
                   requested_at_ms INTEGER NOT NULL,
                   started_at_ms INTEGER,
                   completed_at_ms INTEGER,
                   updated_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(job_id, executor)
                 );
                 CREATE INDEX idx_solver_execution_usage_owner
                   ON solver_execution_usage(school_id, account_id, requested_at_ms);
                 CREATE INDEX idx_solver_execution_usage_status
                   ON solver_execution_usage(executor, status, requested_at_ms);
                 INSERT INTO solver_execution_usage
                   (job_id, executor, school_id, account_id, status,
                    requested_at_ms, updated_at_ms)
                 VALUES ('legacy-job', 'vps', 'legacy-school', 'legacy-admin',
                         'completed', 1, 1);",
            )?;
            Ok(())
        })
        .unwrap();

        let c = ServerlessCoordinator::new(db.clone());
        let primary_key = db
            .with_immediate_transaction(|tx| {
                table_primary_key_columns(tx, "solver_execution_usage")
            })
            .unwrap();
        assert_eq!(
            primary_key,
            vec![
                "job_id".to_string(),
                "executor".to_string(),
                "school_id".to_string(),
                "account_id".to_string()
            ]
        );

        // The same client-generated ID must remain independently attributable
        // when two owners submit it after the legacy migration.
        assert!(c.record_execution_started(
            "reused-job",
            "school-a",
            "alice",
            "vps"
        ));
        assert!(c.record_execution_outcome(
            "reused-job",
            "school-a",
            "alice",
            "vps",
            ReservationOutcome::Completed,
        ));
        assert!(c.record_execution_started(
            "reused-job",
            "school-b",
            "bob",
            "vps"
        ));
        assert!(c.record_execution_outcome(
            "reused-job",
            "school-b",
            "bob",
            "vps",
            ReservationOutcome::Completed,
        ));
        assert_eq!(
            c.usage_json()["accountRequestTotals"]["vpsRequests"],
            json!(3)
        );
    }

    #[test]
    fn elapsed_cost_estimate_uses_profile_resources() {
        let profile = ServerlessProfile::from_value(&json!({
            "id":"p",
            "url":"https://example.run.app",
            "solverDigest":digest(),
            "vcpu":6,
            "memoryGiB":4
        }))
        .unwrap();
        let estimate = ServerlessCoordinator::estimate_actual_cost_usd(&profile, 180_000);
        assert!(estimate > 0.02 && estimate < 0.04);
    }
}
