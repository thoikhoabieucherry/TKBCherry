use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

const DEFAULT_MAX_CONCURRENT: usize = 3;
const DEFAULT_MIN_WORKERS_PER_JOB: usize = 2;
const DEFAULT_MAX_WORKERS_PER_JOB: usize = 6;
const COMPLETE_FRESH_WORKERS_PER_JOB: usize = 6;
const MAX_WORKERS_PER_JOB: usize = 64;
// Background browser tabs may throttle timers to roughly one heartbeat per
// minute. Keep their FIFO ticket alive without making abandoned tickets
// block the queue indefinitely.
const QUEUE_LEASE_MS: u64 = 120_000;
const QUEUE_RETRY_AFTER_MS: u64 = 700;
// A browser may be closed overnight while the VPS keeps solving. Retain the
// finished response for a full week so another device can reconnect and apply
// it without restarting the solve.
const SERVER_RESULT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_SERVER_RESULTS: usize = 64;
const MAX_SCHEDULE_FINGERPRINT_BYTES: usize = 128;
const MAX_SCHEDULE_SCOPE_BYTES: usize = 128;
const MAX_PROGRESS_BUDGET_SECONDS: u64 = 600;
const MAX_PROGRESS_RUN_INDEX: u64 = 999;
const MAX_SERVER_PROGRESS_BYTES: usize = 16 * 1024;
const MAX_SERVER_PROGRESS_STAGE_BYTES: usize = 160;
pub const MAX_UNRESOLVED_SERVER_JOBS: usize = 32;
pub const MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER: usize = 2;
// A server-owned request carries one watchdog budget across every executor
// handoff. Keep this in the pool module so both the coordinator and status
// surfaces use the same upper bound without importing main.rs constants.
pub const MAX_SERVER_WATCHDOG_MS: u64 = 1_800_000;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SolverOwner {
    school_id: String,
    login_id: String,
}

impl SolverOwner {
    pub fn new(school_id: &str, login_id: &str) -> Self {
        Self {
            school_id: school_id.trim().to_ascii_lowercase(),
            login_id: login_id.trim().to_ascii_lowercase(),
        }
    }

    pub fn anonymous() -> Self {
        Self::default()
    }
}

pub struct SolverJob {
    pub job_id: String,
    pub allocated_workers: usize,
    pub cancel_requested: AtomicBool,
    pub started_ms: AtomicU64,
    owner: SolverOwner,
}

pub struct SolverPool {
    max_concurrent: usize,
    total_worker_tokens: usize,
    min_workers_per_job: usize,
    max_workers_per_job: usize,
    state: Mutex<SolverPoolState>,
}

#[derive(Default)]
struct SolverPoolState {
    jobs: HashMap<String, Arc<SolverJob>>,
    queue: VecDeque<QueuedSolverJob>,
    server_jobs: HashMap<String, ServerOwnedSolverJob>,
}

struct ServerOwnedSolverJob {
    owner: SolverOwner,
    schedule_scope: Option<String>,
    created_ms: u64,
    schedule_fingerprint: Option<String>,
    progress_budget_seconds: Option<u64>,
    progress_run_index: Option<u64>,
    progress: Option<Value>,
    progress_updated_ms: Option<u64>,
    watchdog_budget_ms: Option<u64>,
    watchdog_started_ms: Option<u64>,
    cancel_requested: bool,
    execution_phase: ServerExecutionPhase,
    execution_generation: u64,
    completed_ms: Option<u64>,
    response: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServerExecutor {
    Vps,
    Agent,
}

impl ServerExecutor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vps => "vps",
            Self::Agent => "agent",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServerExecutionPhase {
    Pending,
    VpsQueued,
    VpsRunning,
    HandoffToAgent,
    AgentWaiting,
    AgentRunning,
    Cancelling,
    Completed,
}

impl ServerExecutionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::VpsQueued => "vps_queued",
            Self::VpsRunning => "vps_running",
            Self::HandoffToAgent => "handoff_to_agent",
            Self::AgentWaiting => "agent_waiting",
            Self::AgentRunning => "agent_running",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
        }
    }

    pub fn executor(self) -> Option<ServerExecutor> {
        match self {
            Self::VpsQueued | Self::VpsRunning => Some(ServerExecutor::Vps),
            Self::AgentWaiting | Self::AgentRunning => Some(ServerExecutor::Agent),
            _ => None,
        }
    }

    pub fn handoff_in_progress(self) -> bool {
        matches!(self, Self::HandoffToAgent)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServerExecutionFence {
    pub generation: u64,
    pub executor: ServerExecutor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServerExecutionSnapshot {
    pub phase: ServerExecutionPhase,
    pub generation: u64,
    pub cancel_requested: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerJobSnapshot {
    pub job_id: String,
    pub created_ms: u64,
    pub completed_ms: Option<u64>,
    pub schedule_scope: Option<String>,
    pub schedule_fingerprint: Option<String>,
    pub progress_budget_seconds: Option<u64>,
    pub progress_run_index: Option<u64>,
    pub progress: Option<Value>,
    pub progress_updated_ms: Option<u64>,
    pub watchdog_budget_ms: Option<u64>,
    pub watchdog_started_ms: Option<u64>,
    pub execution_phase: ServerExecutionPhase,
    pub execution_generation: u64,
}

struct QueuedSolverJob {
    job_id: String,
    queued_ms: u64,
    last_seen_ms: u64,
    desired_workers: usize,
    owner: SolverOwner,
}

pub enum SolverAdmission {
    Acquired(SolverJobGuard),
    Queued {
        position: usize,
        queued_ms: u64,
        retry_after_ms: u64,
    },
    AlreadyRunning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerJobClaim {
    Claimed,
    Existing,
    ExistingSchedule(String),
    ExistingScope(String),
    OwnerMismatch,
    GlobalCapacity,
    OwnerCapacity,
}

pub struct SolverJobGuard {
    pool: Arc<SolverPool>,
    pub job: Arc<SolverJob>,
}

impl Drop for SolverJobGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.pool.state.lock() {
            let owns_slot = state
                .jobs
                .get(&self.job.job_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.job));
            if owns_slot {
                state.jobs.remove(&self.job.job_id);
            }
        }
        self.job.cancel_requested.store(false, Ordering::SeqCst);
    }
}

impl SolverPool {
    pub fn from_env() -> Arc<Self> {
        let max_concurrent = solver_max_concurrent_from_env();
        let total_worker_tokens = solver_total_worker_tokens_from_env();
        let min_workers_per_job = solver_min_workers_from_env(total_worker_tokens);
        let max_workers_per_job =
            solver_max_workers_from_env(total_worker_tokens, min_workers_per_job);
        Arc::new(Self {
            max_concurrent,
            total_worker_tokens,
            min_workers_per_job,
            max_workers_per_job,
            state: Mutex::new(SolverPoolState::default()),
        })
    }

    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    pub fn max_workers_per_job(&self) -> usize {
        self.max_workers_per_job
    }

    pub fn min_workers_per_job(&self) -> usize {
        self.min_workers_per_job
    }

    pub fn total_worker_tokens(&self) -> usize {
        self.total_worker_tokens
    }

    pub fn allocated_worker_tokens(&self) -> usize {
        self.state
            .lock()
            .map(|state| allocated_workers(&state.jobs))
            .unwrap_or(self.total_worker_tokens)
    }

    pub fn available_worker_tokens(&self) -> usize {
        self.total_worker_tokens
            .saturating_sub(self.allocated_worker_tokens())
    }

    pub fn active_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.jobs.len())
            .unwrap_or(self.max_concurrent)
    }

    pub fn queued_count(&self) -> usize {
        self.state
            .lock()
            .map(|mut state| {
                prune_stale_queue(&mut state, crate::now_millis());
                state.queue.len()
            })
            .unwrap_or(0)
    }

    pub fn slots_available(&self) -> usize {
        if self.queued_count() > 0 {
            return 0;
        }
        let concurrent_slots = self.max_concurrent.saturating_sub(self.active_count());
        let token_slots = self.available_worker_tokens() / self.min_workers_per_job.max(1);
        concurrent_slots.min(token_slots)
    }

    pub fn at_capacity(&self) -> bool {
        self.queued_count() > 0
            || self.active_count() >= self.max_concurrent
            || self.available_worker_tokens() < self.min_workers_per_job
    }

    pub fn desired_workers(&self, request: Option<&Value>) -> usize {
        let requested =
            solver_worker_demand(request, self.min_workers_per_job, self.max_workers_per_job);
        let settings = request
            .and_then(|value| value.get("settings"))
            .and_then(Value::as_object);
        let unified = setting_enabled(settings.and_then(|items| items.get("ui_unified_auto_sort")));
        let unified_solve_kind =
            normalized_mode(settings.and_then(|items| items.get("ui_unified_solve_kind")));
        let quality_fresh = unified && unified_solve_kind == "fresh_complete_first";
        if quality_fresh {
            COMPLETE_FRESH_WORKERS_PER_JOB
                .max(self.min_workers_per_job)
                .min(self.max_workers_per_job)
        } else {
            requested
        }
    }

    #[cfg(test)]
    pub fn claim_server_job(&self, job_id: &str, owner: &SolverOwner) -> ServerJobClaim {
        self.claim_server_job_with_fingerprint(job_id, owner, None)
    }

    #[cfg(test)]
    pub fn claim_server_job_with_fingerprint(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        schedule_fingerprint: Option<&str>,
    ) -> ServerJobClaim {
        self.claim_server_job_with_progress(job_id, owner, schedule_fingerprint, None, None)
    }

    pub fn claim_server_job_with_progress(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        schedule_fingerprint: Option<&str>,
        progress_budget_seconds: Option<u64>,
        progress_run_index: Option<u64>,
    ) -> ServerJobClaim {
        self.claim_server_job_with_scope_progress(
            job_id,
            owner,
            None,
            schedule_fingerprint,
            progress_budget_seconds,
            progress_run_index,
        )
    }

    pub fn claim_server_job_with_scope_progress(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        schedule_scope: Option<&str>,
        schedule_fingerprint: Option<&str>,
        progress_budget_seconds: Option<u64>,
        progress_run_index: Option<u64>,
    ) -> ServerJobClaim {
        self.claim_server_job_with_scope_progress_and_watchdog(
            job_id,
            owner,
            schedule_scope,
            schedule_fingerprint,
            progress_budget_seconds,
            progress_run_index,
            None,
        )
    }

    /// Claim a canonical server job and attach its one-shot watchdog budget.
    /// The older claim helpers intentionally remain usable by unit callers
    /// that do not execute a server-owned request.
    pub fn claim_server_job_with_scope_progress_and_watchdog(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        schedule_scope: Option<&str>,
        schedule_fingerprint: Option<&str>,
        progress_budget_seconds: Option<u64>,
        progress_run_index: Option<u64>,
        watchdog_budget_ms: Option<u64>,
    ) -> ServerJobClaim {
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return ServerJobClaim::GlobalCapacity,
        };
        prune_completed_server_jobs(&mut state, now_ms);
        if let Some(existing) = state.server_jobs.get(job_id) {
            return if &existing.owner == owner {
                ServerJobClaim::Existing
            } else {
                ServerJobClaim::OwnerMismatch
            };
        }
        let normalized_schedule_scope = normalize_schedule_scope(schedule_scope);
        let normalized_schedule_fingerprint = normalize_schedule_fingerprint(schedule_fingerprint);
        let normalized_progress_budget_seconds =
            normalize_progress_budget_seconds(progress_budget_seconds);
        let normalized_progress_run_index = normalize_progress_run_index(progress_run_index);
        let normalized_watchdog_budget_ms = normalize_server_watchdog_budget_ms(watchdog_budget_ms);
        if let Some(fingerprint) = normalized_schedule_fingerprint.as_deref() {
            let existing_job_id = state
                .server_jobs
                .iter()
                .filter(|(_, job)| {
                    &job.owner == owner
                        && job.completed_ms.is_none()
                        && !job.cancel_requested
                        && job.schedule_fingerprint.as_deref() == Some(fingerprint)
                })
                .min_by(|(left_id, left), (right_id, right)| {
                    let left_priority = if state.jobs.contains_key(left_id.as_str()) {
                        0
                    } else if state
                        .queue
                        .iter()
                        .any(|queued| queued.job_id.as_str() == left_id.as_str())
                    {
                        1
                    } else {
                        2
                    };
                    let right_priority = if state.jobs.contains_key(right_id.as_str()) {
                        0
                    } else if state
                        .queue
                        .iter()
                        .any(|queued| queued.job_id.as_str() == right_id.as_str())
                    {
                        1
                    } else {
                        2
                    };
                    left_priority
                        .cmp(&right_priority)
                        .then_with(|| left.created_ms.cmp(&right.created_ms))
                        .then_with(|| left_id.cmp(right_id))
                })
                .map(|(existing_job_id, _)| existing_job_id.to_string());
            if let Some(existing_job_id) = existing_job_id {
                return ServerJobClaim::ExistingSchedule(existing_job_id);
            }
        }
        if let Some(scope) = normalized_schedule_scope.as_deref() {
            let existing_job_id = state
                .server_jobs
                .iter()
                .filter(|(_, job)| {
                    &job.owner == owner
                        && job.completed_ms.is_none()
                        && !job.cancel_requested
                        && job.schedule_scope.as_deref() == Some(scope)
                })
                .min_by(|(left_id, left), (right_id, right)| {
                    let left_priority = if state.jobs.contains_key(left_id.as_str()) {
                        0
                    } else if state
                        .queue
                        .iter()
                        .any(|queued| queued.job_id.as_str() == left_id.as_str())
                    {
                        1
                    } else {
                        2
                    };
                    let right_priority = if state.jobs.contains_key(right_id.as_str()) {
                        0
                    } else if state
                        .queue
                        .iter()
                        .any(|queued| queued.job_id.as_str() == right_id.as_str())
                    {
                        1
                    } else {
                        2
                    };
                    left_priority
                        .cmp(&right_priority)
                        .then_with(|| left.created_ms.cmp(&right.created_ms))
                        .then_with(|| left_id.cmp(right_id))
                })
                .map(|(existing_job_id, _)| existing_job_id.to_string());
            if let Some(existing_job_id) = existing_job_id {
                return ServerJobClaim::ExistingScope(existing_job_id);
            }
        }
        let unresolved_global = state
            .server_jobs
            .values()
            .filter(|job| job.completed_ms.is_none())
            .count();
        if unresolved_global >= MAX_UNRESOLVED_SERVER_JOBS {
            return ServerJobClaim::GlobalCapacity;
        }
        let unresolved_owner = state
            .server_jobs
            .values()
            .filter(|job| job.completed_ms.is_none() && &job.owner == owner)
            .count();
        if unresolved_owner >= MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER {
            return ServerJobClaim::OwnerCapacity;
        }
        state.server_jobs.insert(
            job_id.to_string(),
            ServerOwnedSolverJob {
                owner: owner.clone(),
                schedule_scope: normalized_schedule_scope,
                created_ms: now_ms,
                schedule_fingerprint: normalized_schedule_fingerprint,
                progress_budget_seconds: normalized_progress_budget_seconds,
                progress_run_index: normalized_progress_run_index,
                progress: None,
                progress_updated_ms: None,
                watchdog_budget_ms: normalized_watchdog_budget_ms,
                watchdog_started_ms: None,
                cancel_requested: false,
                execution_phase: ServerExecutionPhase::Pending,
                execution_generation: 0,
                completed_ms: None,
                response: None,
            },
        );
        ServerJobClaim::Claimed
    }

    pub fn server_job_known_for_owner(&self, job_id: &str, owner: &SolverOwner) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_completed_server_jobs(&mut state, crate::now_millis());
        state
            .server_jobs
            .get(job_id)
            .map(|job| &job.owner == owner)
            .unwrap_or(false)
    }

    pub fn server_job_cancel_requested(&self, job_id: &str, owner: &SolverOwner) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .server_jobs
                    .get(job_id)
                    .filter(|job| &job.owner == owner)
                    .map(|job| job.cancel_requested)
            })
            .unwrap_or(true)
    }

    pub fn server_execution_snapshot(
        &self,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<ServerExecutionSnapshot> {
        let state = self.state.lock().ok()?;
        let job = state
            .server_jobs
            .get(job_id)
            .filter(|job| &job.owner == owner)?;
        Some(ServerExecutionSnapshot {
            phase: job.execution_phase,
            generation: job.execution_generation,
            cancel_requested: job.cancel_requested,
        })
    }

    /// Return the remaining canonical watchdog budget for a server-owned job.
    /// `Some(0)` is a real exhausted budget; `None` means the caller used a
    /// legacy claim without a server watchdog.
    pub fn server_job_watchdog_remaining_ms(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        now_ms: u64,
    ) -> Option<u64> {
        let state = self.state.lock().ok()?;
        let job = state
            .server_jobs
            .get(job_id)
            .filter(|job| &job.owner == owner)?;
        let budget_ms = job.watchdog_budget_ms?;
        let started_ms = job.watchdog_started_ms?;
        Some(budget_ms.saturating_sub(now_ms.saturating_sub(started_ms)))
    }

    pub fn server_job_watchdog_snapshot(
        &self,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<(Option<u64>, Option<u64>)> {
        let state = self.state.lock().ok()?;
        let job = state
            .server_jobs
            .get(job_id)
            .filter(|job| &job.owner == owner)?;
        Some((job.watchdog_budget_ms, job.watchdog_started_ms))
    }

    /// Ask the active VPS executor to stop and reserve the canonical job for an
    /// Agent. The generation is bumped while holding the pool lock, so a local
    /// result racing this transition can never become authoritative.
    pub fn request_agent_handoff_for_owner(&self, owner: &SolverOwner) -> Vec<String> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Vec::new(),
        };
        let job_ids = state
            .server_jobs
            .iter()
            .filter(|(_, job)| {
                &job.owner == owner
                    && job.completed_ms.is_none()
                    && !job.cancel_requested
                    && matches!(
                        job.execution_phase,
                        ServerExecutionPhase::Pending
                            | ServerExecutionPhase::VpsQueued
                            | ServerExecutionPhase::VpsRunning
                    )
            })
            .map(|(job_id, _)| job_id.clone())
            .collect::<Vec<_>>();
        for job_id in &job_ids {
            if let Some(job) = state.server_jobs.get_mut(job_id) {
                job.execution_generation = job.execution_generation.saturating_add(1);
                job.execution_phase = ServerExecutionPhase::HandoffToAgent;
            }
            if let Some(job) = state.jobs.get(job_id) {
                job.cancel_requested.store(true, Ordering::SeqCst);
            }
        }
        if !job_ids.is_empty() {
            state
                .queue
                .retain(|queued| !job_ids.iter().any(|job_id| job_id == &queued.job_id));
        }
        job_ids
    }

    pub fn prepare_agent_execution(
        &self,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<ServerExecutionFence> {
        let mut state = self.state.lock().ok()?;
        let job = state
            .server_jobs
            .get_mut(job_id)
            .filter(|job| &job.owner == owner && !job.cancel_requested && job.completed_ms.is_none())?;
        match job.execution_phase {
            ServerExecutionPhase::Pending => {
                job.execution_generation = job.execution_generation.saturating_add(1);
                job.execution_phase = ServerExecutionPhase::AgentWaiting;
                start_server_watchdog(job, crate::now_millis());
            }
            ServerExecutionPhase::HandoffToAgent => {
                job.execution_phase = ServerExecutionPhase::AgentWaiting;
                start_server_watchdog(job, crate::now_millis());
            }
            ServerExecutionPhase::AgentWaiting => {
                start_server_watchdog(job, crate::now_millis());
            }
            _ => return None,
        }
        Some(ServerExecutionFence {
            generation: job.execution_generation,
            executor: ServerExecutor::Agent,
        })
    }

    pub fn mark_agent_execution_running(&self, fence: ServerExecutionFence, job_id: &str, owner: &SolverOwner) -> bool {
        self.transition_execution(
            job_id,
            owner,
            fence,
            ServerExecutionPhase::AgentWaiting,
            ServerExecutionPhase::AgentRunning,
        )
    }

    pub fn prepare_vps_execution(
        &self,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<ServerExecutionFence> {
        let mut state = self.state.lock().ok()?;
        let job = state
            .server_jobs
            .get_mut(job_id)
            .filter(|job| &job.owner == owner && !job.cancel_requested && job.completed_ms.is_none())?;
        match job.execution_phase {
            ServerExecutionPhase::Pending => {
                job.execution_generation = job.execution_generation.saturating_add(1);
                job.execution_phase = ServerExecutionPhase::VpsQueued;
                start_server_watchdog(job, crate::now_millis());
            }
            ServerExecutionPhase::VpsQueued => {
                start_server_watchdog(job, crate::now_millis());
            }
            _ => return None,
        }
        Some(ServerExecutionFence {
            generation: job.execution_generation,
            executor: ServerExecutor::Vps,
        })
    }

    pub fn mark_vps_execution_running(&self, fence: ServerExecutionFence, job_id: &str, owner: &SolverOwner) -> bool {
        self.transition_execution(
            job_id,
            owner,
            fence,
            ServerExecutionPhase::VpsQueued,
            ServerExecutionPhase::VpsRunning,
        )
    }

    /// Release an Agent lease after expiry/failure and reserve the same
    /// canonical request for the VPS. The returned fence invalidates every
    /// previous Agent writer.
    pub fn fallback_agent_to_vps(
        &self,
        fence: ServerExecutionFence,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<ServerExecutionFence> {
        let mut state = self.state.lock().ok()?;
        let job = state
            .server_jobs
            .get_mut(job_id)
            .filter(|job| &job.owner == owner && !job.cancel_requested && job.completed_ms.is_none())?;
        if job.execution_generation != fence.generation
            || fence.executor != ServerExecutor::Agent
            || !matches!(
                job.execution_phase,
                ServerExecutionPhase::AgentWaiting | ServerExecutionPhase::AgentRunning
            )
        {
            return None;
        }
        job.execution_generation = job.execution_generation.saturating_add(1);
        job.execution_phase = ServerExecutionPhase::VpsQueued;
        Some(ServerExecutionFence {
            generation: job.execution_generation,
            executor: ServerExecutor::Vps,
        })
    }

    pub fn execution_fence_current(
        &self,
        fence: ServerExecutionFence,
        job_id: &str,
        owner: &SolverOwner,
    ) -> bool {
        let Some(snapshot) = self.server_execution_snapshot(job_id, owner) else {
            return false;
        };
        snapshot.generation == fence.generation
            && snapshot.phase.executor() == Some(fence.executor)
            && !snapshot.cancel_requested
    }

    pub fn complete_server_job_fenced(
        &self,
        fence: ServerExecutionFence,
        job_id: &str,
        owner: &SolverOwner,
        response: Vec<u8>,
    ) -> bool {
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let Some(job) = state
            .server_jobs
            .get(job_id)
            .filter(|job| &job.owner == owner)
        else {
            return false;
        };
        if job.cancel_requested
            || job.completed_ms.is_some()
            || job.execution_generation != fence.generation
            || job.execution_phase.executor() != Some(fence.executor)
        {
            return false;
        }
        let job = state
            .server_jobs
            .get_mut(job_id)
            .expect("owned server job still exists");
        job.response = Some(response);
        job.completed_ms = Some(now_ms);
        job.execution_phase = ServerExecutionPhase::Completed;
        state.queue.retain(|queued| queued.job_id != job_id);
        prune_completed_server_jobs(&mut state, now_ms);
        true
    }

    fn transition_execution(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        fence: ServerExecutionFence,
        from: ServerExecutionPhase,
        to: ServerExecutionPhase,
    ) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let Some(job) = state
            .server_jobs
            .get_mut(job_id)
            .filter(|job| &job.owner == owner)
        else {
            return false;
        };
        if job.execution_generation != fence.generation
            || job.execution_phase != from
            || job.cancel_requested
            || job.completed_ms.is_some()
        {
            return false;
        }
        job.execution_phase = to;
        true
    }

    pub fn update_server_job_progress(&self, job_id: &str, progress: Value) -> bool {
        let Some(progress) = normalize_server_progress(progress) else {
            return false;
        };
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let Some(job) = state.server_jobs.get_mut(job_id) else {
            return false;
        };
        if job.completed_ms.is_some() || job.cancel_requested {
            return false;
        }
        job.progress = Some(progress);
        job.progress_updated_ms = Some(now_ms);
        true
    }

    pub fn complete_server_job(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        response: Vec<u8>,
    ) -> bool {
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let Some(job) = state
            .server_jobs
            .get(job_id)
            .filter(|job| &job.owner == owner)
        else {
            return false;
        };
        if job.cancel_requested {
            state.server_jobs.remove(job_id);
            return false;
        }
        // The unfenced compatibility helper is only safe for callers that
        // never reserved an executor. Runtime server-owned workers must use
        // `complete_server_job_fenced`, otherwise an old writer could commit
        // after a VPS/Agent generation transition.
        if !matches!(job.execution_phase, ServerExecutionPhase::Pending) {
            return false;
        }
        let job = state
            .server_jobs
            .get_mut(job_id)
            .expect("owned server job still exists");
        job.response = Some(response);
        job.completed_ms = Some(now_ms);
        job.execution_phase = ServerExecutionPhase::Completed;
        state.queue.retain(|queued| queued.job_id != job_id);
        prune_completed_server_jobs(&mut state, now_ms);
        true
    }

    pub fn completed_server_response_for_owner(
        &self,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<Vec<u8>> {
        let mut state = self.state.lock().ok()?;
        prune_completed_server_jobs(&mut state, crate::now_millis());
        state
            .server_jobs
            .get(job_id)
            .filter(|job| &job.owner == owner)
            .and_then(|job| job.response.clone())
    }

    pub fn server_job_snapshots_for_owner(&self, owner: &SolverOwner) -> Vec<ServerJobSnapshot> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Vec::new(),
        };
        prune_completed_server_jobs(&mut state, crate::now_millis());
        let mut snapshots = state
            .server_jobs
            .iter()
            .filter(|(_, job)| &job.owner == owner)
            .map(|(job_id, job)| ServerJobSnapshot {
                job_id: job_id.clone(),
                created_ms: job.created_ms,
                completed_ms: job.completed_ms,
                schedule_scope: job.schedule_scope.clone(),
                schedule_fingerprint: job.schedule_fingerprint.clone(),
                progress_budget_seconds: job.progress_budget_seconds,
                progress_run_index: job.progress_run_index,
                progress: job.progress.clone(),
                progress_updated_ms: job.progress_updated_ms,
                watchdog_budget_ms: job.watchdog_budget_ms,
                watchdog_started_ms: job.watchdog_started_ms,
                execution_phase: job.execution_phase,
                execution_generation: job.execution_generation,
            })
            .collect::<Vec<_>>();
        snapshots.sort_unstable_by(|left, right| {
            right
                .created_ms
                .cmp(&left.created_ms)
                .then_with(|| left.job_id.cmp(&right.job_id))
        });
        snapshots
    }

    pub fn abandon_server_job(&self, job_id: &str, owner: &SolverOwner) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let owned = state
            .server_jobs
            .get(job_id)
            .map(|job| &job.owner == owner)
            .unwrap_or(false);
        if owned {
            state.server_jobs.remove(job_id);
        }
        owned
    }

    fn normalized_worker_demand(&self, desired_workers: usize) -> usize {
        desired_workers.clamp(self.min_workers_per_job, self.max_workers_per_job)
    }

    #[allow(dead_code)]
    pub fn try_acquire(
        self: &Arc<Self>,
        job_id: String,
        desired_workers: usize,
    ) -> Result<SolverJobGuard, ()> {
        self.try_acquire_for_owner(job_id, desired_workers, SolverOwner::anonymous())
    }

    pub fn try_acquire_for_owner(
        self: &Arc<Self>,
        job_id: String,
        desired_workers: usize,
        owner: SolverOwner,
    ) -> Result<SolverJobGuard, ()> {
        let desired_workers = self.normalized_worker_demand(desired_workers);
        let mut state = self.state.lock().map_err(|_| ())?;
        prune_stale_queue(&mut state, crate::now_millis());
        if state
            .server_jobs
            .get(&job_id)
            .filter(|job| job.owner == owner)
            .map(|job| {
                job.cancel_requested
                    || !matches!(
                        job.execution_phase,
                        ServerExecutionPhase::Pending
                            | ServerExecutionPhase::VpsQueued
                            | ServerExecutionPhase::VpsRunning
                    )
            })
            .unwrap_or(false)
        {
            return Err(());
        }
        if !state.queue.is_empty()
            || state.jobs.contains_key(&job_id)
            || state.jobs.len() >= self.max_concurrent
        {
            return Err(());
        }
        let available_workers = self
            .total_worker_tokens
            .saturating_sub(allocated_workers(&state.jobs));
        if available_workers < desired_workers {
            return Err(());
        }
        Ok(self.insert_job(&mut state, job_id, desired_workers, owner))
    }

    #[allow(dead_code)]
    pub fn acquire_or_enqueue(
        self: &Arc<Self>,
        job_id: String,
        desired_workers: usize,
    ) -> SolverAdmission {
        self.acquire_or_enqueue_for_owner(job_id, desired_workers, SolverOwner::anonymous())
    }

    pub fn acquire_or_enqueue_for_owner(
        self: &Arc<Self>,
        job_id: String,
        desired_workers: usize,
        owner: SolverOwner,
    ) -> SolverAdmission {
        let desired_workers = self.normalized_worker_demand(desired_workers);
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => {
                return SolverAdmission::Queued {
                    position: 1,
                    queued_ms: now_ms,
                    retry_after_ms: QUEUE_RETRY_AFTER_MS,
                }
            }
        };
        prune_stale_queue(&mut state, now_ms);

        if state
            .server_jobs
            .get(&job_id)
            .filter(|job| job.owner == owner)
            .map(|job| {
                job.cancel_requested
                    || !matches!(
                        job.execution_phase,
                        ServerExecutionPhase::Pending
                            | ServerExecutionPhase::VpsQueued
                            | ServerExecutionPhase::VpsRunning
                    )
            })
            .unwrap_or(false)
        {
            return SolverAdmission::AlreadyRunning;
        }

        if state.jobs.contains_key(&job_id) {
            return SolverAdmission::AlreadyRunning;
        }

        let queued_index = state
            .queue
            .iter()
            .position(|queued| queued.job_id == job_id);
        if let Some(index) = queued_index {
            if let Some(queued) = state.queue.get_mut(index) {
                if queued.owner != owner {
                    return SolverAdmission::AlreadyRunning;
                }
                queued.last_seen_ms = now_ms;
            }
        } else {
            let available_workers = self
                .total_worker_tokens
                .saturating_sub(allocated_workers(&state.jobs));
            if state.queue.is_empty()
                && state.jobs.len() < self.max_concurrent
                && available_workers >= desired_workers
            {
                return SolverAdmission::Acquired(self.insert_job(
                    &mut state,
                    job_id,
                    desired_workers,
                    owner,
                ));
            }
            state.queue.push_back(QueuedSolverJob {
                job_id: job_id.clone(),
                queued_ms: now_ms,
                last_seen_ms: now_ms,
                desired_workers,
                owner: owner.clone(),
            });
        }

        let available_workers = self
            .total_worker_tokens
            .saturating_sub(allocated_workers(&state.jobs));
        let front_can_run = state
            .queue
            .front()
            .map(|queued| {
                queued.job_id == job_id
                    && state.jobs.len() < self.max_concurrent
                    && available_workers >= queued.desired_workers
            })
            .unwrap_or(false);
        if front_can_run {
            let queued = state.queue.pop_front().expect("queue front exists");
            return SolverAdmission::Acquired(self.insert_job(
                &mut state,
                queued.job_id,
                queued.desired_workers,
                queued.owner,
            ));
        }

        let (position, queued_ms) = state
            .queue
            .iter()
            .enumerate()
            .find(|(_, queued)| queued.job_id == job_id)
            .map(|(index, queued)| (index + 1, queued.queued_ms))
            .unwrap_or((state.queue.len().saturating_add(1), now_ms));
        SolverAdmission::Queued {
            position,
            queued_ms,
            retry_after_ms: QUEUE_RETRY_AFTER_MS,
        }
    }

    fn insert_job(
        self: &Arc<Self>,
        state: &mut SolverPoolState,
        job_id: String,
        desired_workers: usize,
        owner: SolverOwner,
    ) -> SolverJobGuard {
        let available_workers = self
            .total_worker_tokens
            .saturating_sub(allocated_workers(&state.jobs));
        let allocated_worker_count = self.normalized_worker_demand(desired_workers);
        debug_assert!(available_workers >= allocated_worker_count);
        let job = Arc::new(SolverJob {
            job_id: job_id.clone(),
            allocated_workers: allocated_worker_count,
            cancel_requested: AtomicBool::new(false),
            started_ms: AtomicU64::new(crate::now_millis()),
            owner,
        });
        state.jobs.insert(job_id, job.clone());
        SolverJobGuard {
            pool: Arc::clone(self),
            job,
        }
    }

    #[allow(dead_code)]
    pub fn cancel_job(&self, job_id: &str) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let mut cancelled = false;
        let mut remove_completed = false;
        if let Some(job) = state.server_jobs.get_mut(job_id) {
            if job.response.is_some() {
                remove_completed = true;
                cancelled = true;
            } else {
                job.cancel_requested = true;
                job.execution_generation = job.execution_generation.saturating_add(1);
                job.execution_phase = ServerExecutionPhase::Cancelling;
                cancelled = true;
            }
        }
        if remove_completed {
            state.server_jobs.remove(job_id);
        }
        if let Some(job) = state.jobs.get(job_id) {
            job.cancel_requested.store(true, Ordering::SeqCst);
            cancelled = true;
        }
        let before = state.queue.len();
        state.queue.retain(|queued| queued.job_id != job_id);
        cancelled || state.queue.len() != before
    }

    pub fn cancel_job_for_owner(&self, job_id: &str, owner: &SolverOwner) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let mut cancelled = false;
        let mut remove_completed = false;
        if let Some(job) = state
            .server_jobs
            .get_mut(job_id)
            .filter(|job| &job.owner == owner)
        {
            if job.response.is_some() {
                remove_completed = true;
                cancelled = true;
            } else {
                job.cancel_requested = true;
                job.execution_generation = job.execution_generation.saturating_add(1);
                job.execution_phase = ServerExecutionPhase::Cancelling;
                cancelled = true;
            }
        }
        if remove_completed {
            state.server_jobs.remove(job_id);
        }
        if let Some(job) = state.jobs.get(job_id) {
            if &job.owner == owner {
                job.cancel_requested.store(true, Ordering::SeqCst);
                cancelled = true;
            }
        }
        let before = state.queue.len();
        state
            .queue
            .retain(|queued| queued.job_id != job_id || &queued.owner != owner);
        cancelled || state.queue.len() != before
    }

    #[allow(dead_code)]
    pub fn snapshot(&self) -> Vec<(String, u64, bool, usize)> {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Vec::new(),
        };
        state
            .jobs
            .values()
            .map(|job| {
                (
                    job.job_id.clone(),
                    job.started_ms.load(Ordering::SeqCst),
                    job.cancel_requested.load(Ordering::SeqCst),
                    job.allocated_workers,
                )
            })
            .collect()
    }

    pub fn snapshot_for_owner(&self, owner: &SolverOwner) -> Vec<(String, u64, bool, usize)> {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Vec::new(),
        };
        state
            .jobs
            .values()
            .filter(|job| &job.owner == owner)
            .map(|job| {
                (
                    job.job_id.clone(),
                    job.started_ms.load(Ordering::SeqCst),
                    job.cancel_requested.load(Ordering::SeqCst),
                    job.allocated_workers,
                )
            })
            .collect()
    }

    #[allow(dead_code)]
    pub fn queue_snapshot(&self) -> Vec<(String, u64)> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Vec::new(),
        };
        prune_stale_queue(&mut state, crate::now_millis());
        state
            .queue
            .iter()
            .map(|queued| (queued.job_id.clone(), queued.queued_ms))
            .collect()
    }

    pub fn queue_snapshot_for_owner(
        &self,
        owner: &SolverOwner,
    ) -> Vec<(String, u64, usize, usize)> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return Vec::new(),
        };
        prune_stale_queue(&mut state, crate::now_millis());
        state
            .queue
            .iter()
            .enumerate()
            .filter(|(_, queued)| &queued.owner == owner)
            .map(|(index, queued)| {
                (
                    queued.job_id.clone(),
                    queued.queued_ms,
                    index + 1,
                    queued.desired_workers,
                )
            })
            .collect()
    }

    #[allow(dead_code)]
    pub fn touch_queued_job(&self, job_id: &str) -> bool {
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_stale_queue(&mut state, now_ms);
        let Some(queued) = state
            .queue
            .iter_mut()
            .find(|queued| queued.job_id == job_id)
        else {
            return false;
        };
        queued.last_seen_ms = now_ms;
        true
    }

    pub fn touch_queued_job_for_owner(&self, job_id: &str, owner: &SolverOwner) -> bool {
        let now_ms = crate::now_millis();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_stale_queue(&mut state, now_ms);
        let Some(queued) = state
            .queue
            .iter_mut()
            .find(|queued| queued.job_id == job_id && &queued.owner == owner)
        else {
            return false;
        };
        queued.last_seen_ms = now_ms;
        true
    }
}

fn prune_stale_queue(state: &mut SolverPoolState, now_ms: u64) {
    state
        .queue
        .retain(|queued| now_ms.saturating_sub(queued.last_seen_ms) <= QUEUE_LEASE_MS);
}

fn prune_completed_server_jobs(state: &mut SolverPoolState, now_ms: u64) {
    state.server_jobs.retain(|_, job| {
        job.completed_ms
            .map(|completed_ms| now_ms.saturating_sub(completed_ms) <= SERVER_RESULT_TTL_MS)
            .unwrap_or(true)
    });
    let completed_count = state
        .server_jobs
        .values()
        .filter(|job| job.completed_ms.is_some())
        .count();
    if completed_count <= MAX_SERVER_RESULTS {
        return;
    }
    let mut completed = state
        .server_jobs
        .iter()
        .filter_map(|(job_id, job)| {
            job.completed_ms
                .map(|completed_ms| (completed_ms, job.created_ms, job_id.clone()))
        })
        .collect::<Vec<_>>();
    completed.sort_unstable();
    for (_, _, job_id) in completed
        .into_iter()
        .take(completed_count - MAX_SERVER_RESULTS)
    {
        state.server_jobs.remove(&job_id);
    }
}

fn normalize_schedule_fingerprint(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > MAX_SCHEDULE_FINGERPRINT_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(value.to_string())
}

fn normalize_schedule_scope(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > MAX_SCHEDULE_SCOPE_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b':' | b'.' | b'_' | b'-' | b'/')
        })
    {
        return None;
    }
    Some(value.to_string())
}

fn normalize_progress_budget_seconds(value: Option<u64>) -> Option<u64> {
    value.filter(|seconds| *seconds > 0 && *seconds <= MAX_PROGRESS_BUDGET_SECONDS)
}

fn normalize_progress_run_index(value: Option<u64>) -> Option<u64> {
    value.filter(|run_index| *run_index > 0 && *run_index <= MAX_PROGRESS_RUN_INDEX)
}

fn normalize_server_watchdog_budget_ms(value: Option<u64>) -> Option<u64> {
    value.filter(|budget_ms| *budget_ms > 0).map(|budget_ms| {
        budget_ms.min(MAX_SERVER_WATCHDOG_MS)
    })
}

fn start_server_watchdog(job: &mut ServerOwnedSolverJob, now_ms: u64) {
    if job.watchdog_budget_ms.is_some() && job.watchdog_started_ms.is_none() {
        job.watchdog_started_ms = Some(now_ms);
    }
}

fn normalize_server_progress(value: Value) -> Option<Value> {
    let object = value.as_object()?;
    let stage = object.get("stage")?.as_str()?.trim();
    if stage.is_empty()
        || stage.len() > MAX_SERVER_PROGRESS_STAGE_BYTES
        || stage.chars().any(char::is_control)
    {
        return None;
    }
    let encoded = serde_json::to_vec(&value).ok()?;
    if encoded.len() > MAX_SERVER_PROGRESS_BYTES {
        return None;
    }
    Some(value)
}

fn allocated_workers(jobs: &HashMap<String, Arc<SolverJob>>) -> usize {
    jobs.values().map(|job| job.allocated_workers).sum()
}

pub fn solver_max_concurrent_from_env() -> usize {
    let configured = std::env::var("TKB_SOLVER_MAX_CONCURRENT").ok();
    solver_max_concurrent(configured.as_deref())
}

fn solver_max_concurrent(configured: Option<&str>) -> usize {
    configured
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_CONCURRENT)
}

pub fn solver_total_worker_tokens_from_env() -> usize {
    let available_workers = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let configured = std::env::var("TKB_SOLVER_CPU_TOKENS")
        .ok()
        .or_else(|| std::env::var("TKB_SOLVER_TOTAL_WORKERS").ok());
    solver_total_worker_tokens(configured.as_deref(), available_workers)
}

fn solver_total_worker_tokens(configured: Option<&str>, available_workers: usize) -> usize {
    configured
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| available_workers.max(1))
        .min(MAX_WORKERS_PER_JOB)
}

pub fn solver_min_workers_from_env(total_worker_tokens: usize) -> usize {
    let configured = std::env::var("TKB_SOLVER_MIN_WORKERS").ok();
    solver_min_workers(configured.as_deref(), total_worker_tokens)
}

fn solver_min_workers(configured: Option<&str>, total_worker_tokens: usize) -> usize {
    configured
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MIN_WORKERS_PER_JOB)
        .clamp(1, total_worker_tokens.max(1))
}

pub fn solver_max_workers_from_env(
    total_worker_tokens: usize,
    min_workers_per_job: usize,
) -> usize {
    let configured = std::env::var("TKB_SOLVER_MAX_WORKERS").ok();
    solver_max_workers(
        configured.as_deref(),
        total_worker_tokens,
        min_workers_per_job,
    )
}

fn solver_max_workers(
    configured: Option<&str>,
    total_worker_tokens: usize,
    min_workers_per_job: usize,
) -> usize {
    let requested = configured
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_WORKERS_PER_JOB);
    requested
        .max(min_workers_per_job.max(1))
        .min(total_worker_tokens.max(1))
        .min(MAX_WORKERS_PER_JOB)
}

fn normalized_mode(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
}

fn setting_enabled(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        Some(Value::String(value)) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        _ => false,
    }
}

fn solver_worker_demand(
    request: Option<&Value>,
    min_workers_per_job: usize,
    max_workers_per_job: usize,
) -> usize {
    let settings = request
        .and_then(|value| value.get("settings"))
        .and_then(Value::as_object);
    let auto_sort_mode = normalized_mode(settings.and_then(|items| items.get("auto_sort_mode")));
    let unified = setting_enabled(settings.and_then(|items| items.get("ui_unified_auto_sort")));
    let unified_solve_kind =
        normalized_mode(settings.and_then(|items| items.get("ui_unified_solve_kind")));
    let unified_partial_repair = unified
        && (setting_enabled(settings.and_then(|items| items.get("ui_unified_partial_repair")))
            || unified_solve_kind == "repair_partial");
    let is_max = matches!(
        auto_sort_mode.as_str(),
        "max"
            | "teacher_session_opt"
            | "teacher_session_optimization"
            | "teacher_session_optimized"
    );
    if unified_partial_repair {
        2_usize.max(min_workers_per_job).min(max_workers_per_job)
    } else if unified && unified_solve_kind == "fresh_complete_first" {
        COMPLETE_FRESH_WORKERS_PER_JOB
            .max(min_workers_per_job)
            .min(max_workers_per_job)
    } else if unified && unified_solve_kind == "refine_complete" {
        // A complete incumbent refinement is a bounded quality search, not a
        // lightweight fill.  With three workers the production default case
        // can spend about 187 seconds across its cap portfolio and miss the
        // 180-second server deadline; using the full six-token pool lets the
        // same search return its better candidate before the deadline.  The
        // schedule-scope single-flight lock still prevents duplicate work.
        COMPLETE_FRESH_WORKERS_PER_JOB
            .max(min_workers_per_job)
            .min(max_workers_per_job)
    } else if unified {
        3_usize.max(min_workers_per_job).min(max_workers_per_job)
    } else if is_max {
        4_usize.max(min_workers_per_job).min(max_workers_per_job)
    } else {
        2_usize.max(min_workers_per_job).min(max_workers_per_job)
    }
}

pub fn job_id_from_solve_body(body: &[u8], fallback_ms: u64) -> String {
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let settings = value.get("settings");
    let candidates = [
        settings.and_then(|item| item.get("solve_run_id")),
        settings.and_then(|item| item.get("ui_solve_run_id")),
        value
            .get("data")
            .and_then(|item| item.get("__tkbSolverRequestNonce")),
    ];
    for candidate in candidates {
        if let Some(raw) = candidate.and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    format!("anon-{fallback_ms}")
}

pub fn job_id_from_cancel_body(body: &[u8]) -> String {
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let candidates = [
        value.get("solve_run_id"),
        value.get("jobId"),
        value.get("job_id"),
    ];
    for candidate in candidates {
        if let Some(raw) = candidate.and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn concurrent_budget_defaults_to_three_and_honors_valid_configuration() {
        assert_eq!(solver_max_concurrent(None), 3);
        assert_eq!(solver_max_concurrent(Some("invalid")), 3);
        assert_eq!(solver_max_concurrent(Some("0")), 3);
        assert_eq!(solver_max_concurrent(Some(" 4 ")), 4);
    }

    #[test]
    fn total_worker_tokens_default_to_cpu_and_honor_configuration() {
        assert_eq!(solver_total_worker_tokens(None, 6), 6);
        assert_eq!(solver_total_worker_tokens(Some("invalid"), 6), 6);
        assert_eq!(solver_total_worker_tokens(Some("0"), 6), 6);
        assert_eq!(solver_total_worker_tokens(Some(" 8 "), 6), 8);
        assert_eq!(solver_total_worker_tokens(Some("128"), 6), 64);
    }

    #[test]
    fn per_job_worker_limits_default_to_two_through_six() {
        assert_eq!(solver_min_workers(None, 6), 2);
        assert_eq!(solver_min_workers(Some("3"), 6), 3);
        assert_eq!(solver_min_workers(Some("10"), 6), 6);
        assert_eq!(solver_min_workers(None, 1), 1);

        assert_eq!(solver_max_workers(None, 6, 2), 6);
        assert_eq!(solver_max_workers(Some(" 3 "), 6, 2), 3);
        assert_eq!(solver_max_workers(Some("1"), 6, 2), 2);
        assert_eq!(solver_max_workers(Some("128"), 6, 2), 6);
        assert_eq!(solver_max_workers(Some("invalid"), 3, 2), 3);
    }

    #[test]
    fn unified_fresh_and_refine_use_all_quality_workers() {
        let max_request = json!({"settings": {"auto_sort_mode": "teacher-session-opt"}});
        let max_alias = json!({"settings": {"auto_sort_mode": "max"}});
        let fast_request = json!({"settings": {"auto_sort_mode": "fast"}});
        let unified_fresh = json!({"settings": {
            "ui_unified_auto_sort": true,
            "ui_unified_solve_kind": "fresh_complete_first",
            "auto_sort_mode": "fast"
        }});
        let unified_refine = json!({"settings": {
            "ui_unified_auto_sort": true,
            "ui_unified_solve_kind": "refine_complete",
            "auto_sort_mode": "teacher_session_opt"
        }});
        let unified_partial = json!({"settings": {
            "ui_unified_auto_sort": true,
            "ui_unified_partial_repair": true,
            "auto_sort_mode": "teacher_session_opt"
        }});
        let unified_partial_kind = json!({"settings": {
            "ui_unified_auto_sort": true,
            "ui_unified_solve_kind": "repair_partial",
            "auto_sort_mode": "teacher_session_opt"
        }});
        assert_eq!(solver_worker_demand(Some(&max_request), 2, 6), 4);
        assert_eq!(solver_worker_demand(Some(&max_alias), 2, 6), 4);
        assert_eq!(solver_worker_demand(Some(&fast_request), 2, 6), 2);
        assert_eq!(solver_worker_demand(Some(&unified_fresh), 2, 6), 6);
        assert_eq!(solver_worker_demand(Some(&unified_refine), 2, 6), 6);
        assert_eq!(solver_worker_demand(Some(&unified_partial), 2, 6), 2);
        assert_eq!(solver_worker_demand(Some(&unified_partial_kind), 2, 6), 2);
        assert_eq!(solver_worker_demand(None, 2, 6), 2);
    }

    fn test_pool() -> Arc<SolverPool> {
        Arc::new(SolverPool {
            max_concurrent: 3,
            total_worker_tokens: 6,
            min_workers_per_job: 2,
            max_workers_per_job: 6,
            state: Mutex::new(SolverPoolState::default()),
        })
    }

    #[test]
    fn max_job_waits_until_all_four_worker_tokens_are_available() {
        let pool = test_pool();
        let first = pool.try_acquire("max-1".to_string(), 4).expect("first max");
        assert_eq!(first.job.allocated_workers, 4);
        assert_eq!(pool.allocated_worker_tokens(), 4);
        assert_eq!(pool.available_worker_tokens(), 2);

        assert!(pool.try_acquire("max-2".to_string(), 4).is_err());
        assert!(matches!(
            pool.acquire_or_enqueue("max-2".to_string(), 4),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert!(matches!(
            pool.acquire_or_enqueue("max-2".to_string(), 2),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert!(matches!(
            pool.acquire_or_enqueue("fast-3".to_string(), 2),
            SolverAdmission::Queued { position: 2, .. }
        ));
        assert!(pool.at_capacity());
        assert_eq!(pool.slots_available(), 0);

        drop(first);
        let second = match pool.acquire_or_enqueue("max-2".to_string(), 4) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("max job should run once all four tokens are free"),
        };
        assert_eq!(second.job.allocated_workers, 4);
        let fast = match pool.acquire_or_enqueue("fast-3".to_string(), 2) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("next FIFO fast job should use the remaining two tokens"),
        };
        assert_eq!(fast.job.allocated_workers, 2);
        assert_eq!(pool.allocated_worker_tokens(), 6);
    }

    #[test]
    fn three_fast_jobs_share_six_tokens() {
        let pool = test_pool();
        let first = pool.try_acquire("fast-1".to_string(), 2).expect("fast 1");
        let second = pool.try_acquire("fast-2".to_string(), 2).expect("fast 2");
        let third = pool.try_acquire("fast-3".to_string(), 2).expect("fast 3");
        assert_eq!(first.job.allocated_workers, 2);
        assert_eq!(second.job.allocated_workers, 2);
        assert_eq!(third.job.allocated_workers, 2);
        assert_eq!(pool.active_count(), 3);
        assert_eq!(pool.allocated_worker_tokens(), 6);
        assert!(pool.try_acquire("fast-4".to_string(), 2).is_err());
    }

    #[test]
    fn two_unified_quality_jobs_use_full_tokens_and_the_rest_wait_fifo() {
        let pool = test_pool();
        let first = pool
            .try_acquire("unified-1".to_string(), 6)
            .expect("first unified job");
        assert_eq!(first.job.allocated_workers, 6);
        assert_eq!(pool.allocated_worker_tokens(), 6);
        assert!(matches!(
            pool.acquire_or_enqueue("unified-2".to_string(), 6),
            SolverAdmission::Queued { position: 1, .. }
        ));

        drop(first);
        let second = match pool.acquire_or_enqueue("unified-2".to_string(), 6) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("queued unified refinement should receive all six released tokens"),
        };
        assert_eq!(second.job.allocated_workers, 6);
        assert_eq!(pool.allocated_worker_tokens(), 6);
    }

    #[test]
    fn ten_fresh_jobs_are_accepted_fifo_with_full_worker_quality() {
        let pool = test_pool();
        let request = json!({"settings": {
            "ui_unified_auto_sort": true,
            "ui_unified_solve_kind": "fresh_complete_first",
            "auto_sort_mode": "teacher_session_opt"
        }});
        let workers = pool.desired_workers(Some(&request));
        assert_eq!(workers, 6);

        let first = match pool.acquire_or_enqueue("fresh-1".to_string(), workers) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("first fresh job should start"),
        };
        for index in 2..=10 {
            match pool.acquire_or_enqueue(format!("fresh-{index}"), workers) {
                SolverAdmission::Queued { position, .. } => assert_eq!(position, index - 1),
                _ => panic!("remaining fresh jobs should be accepted in FIFO order"),
            }
        }
        assert_eq!(pool.active_count(), 1);
        assert_eq!(pool.queued_count(), 9);

        drop(first);
        let second = match pool.acquire_or_enqueue("fresh-2".to_string(), workers) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("second fresh job should start as soon as all six tokens are released"),
        };
        assert_eq!(second.job.allocated_workers, 6);
        assert_eq!(pool.active_count(), 1);
        assert_eq!(pool.queued_count(), 8);
        drop(second);
    }

    #[test]
    fn queued_six_worker_job_waits_for_all_tokens_and_remains_fifo_head() {
        let pool = test_pool();
        let refine = pool
            .try_acquire("refine-running".to_string(), 6)
            .expect("refine job");

        assert!(matches!(
            pool.acquire_or_enqueue("fresh-waiting".to_string(), 6),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert!(matches!(
            pool.acquire_or_enqueue("refine-behind".to_string(), 6),
            SolverAdmission::Queued { position: 2, .. }
        ));

        drop(refine);
        assert!(matches!(
            pool.acquire_or_enqueue("refine-behind".to_string(), 6),
            SolverAdmission::Queued { position: 2, .. }
        ));
        let fresh = match pool.acquire_or_enqueue("fresh-waiting".to_string(), 6) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("six-worker queue head should acquire the whole worker pool"),
        };
        assert_eq!(fresh.job.allocated_workers, 6);
        assert_eq!(pool.available_worker_tokens(), 0);
        assert!(matches!(
            pool.acquire_or_enqueue("refine-behind".to_string(), 6),
            SolverAdmission::Queued { position: 1, .. }
        ));

        drop(fresh);
        let refine_behind = match pool.acquire_or_enqueue("refine-behind".to_string(), 6) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("refine job should run after the exclusive six-worker job"),
        };
        assert_eq!(refine_behind.job.allocated_workers, 6);
    }

    #[test]
    fn unresolved_server_jobs_are_capped_globally_and_per_owner() {
        let pool = test_pool();
        let owner = SolverOwner::new("school-a", "admin-a");
        for index in 0..MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER {
            assert_eq!(
                pool.claim_server_job(&format!("owner-job-{index}"), &owner),
                ServerJobClaim::Claimed
            );
        }
        assert_eq!(
            pool.claim_server_job("owner-job-overflow", &owner),
            ServerJobClaim::OwnerCapacity
        );
        assert_eq!(
            pool.claim_server_job("owner-job-0", &owner),
            ServerJobClaim::Existing
        );

        let response = b"HTTP/1.1 200 OK\r\n\r\n{}".to_vec();
        assert!(pool.complete_server_job("owner-job-0", &owner, response));
        assert_eq!(
            pool.claim_server_job("owner-job-after-complete", &owner),
            ServerJobClaim::Claimed
        );

        let global_pool = test_pool();
        for owner_index in 0..(MAX_UNRESOLVED_SERVER_JOBS / 2) {
            let owner = SolverOwner::new(&format!("school-{owner_index}"), "admin");
            for job_index in 0..2 {
                assert_eq!(
                    global_pool.claim_server_job(
                        &format!("global-job-{owner_index}-{job_index}"),
                        &owner,
                    ),
                    ServerJobClaim::Claimed
                );
            }
        }
        assert_eq!(
            global_pool.claim_server_job(
                "global-job-overflow",
                &SolverOwner::new("school-overflow", "admin"),
            ),
            ServerJobClaim::GlobalCapacity
        );
    }

    #[test]
    fn server_owned_results_are_owner_scoped_and_expire_after_ttl() {
        let pool = test_pool();
        let owner_a = SolverOwner::new("school-a", "admin-a");
        let owner_b = SolverOwner::new("school-b", "admin-b");
        assert_eq!(
            pool.claim_server_job_with_progress(
                "server-result",
                &owner_a,
                Some("v2:0123456789abcdef:42"),
                Some(120),
                Some(3),
            ),
            ServerJobClaim::Claimed
        );
        assert_eq!(
            pool.claim_server_job("server-result", &owner_a),
            ServerJobClaim::Existing
        );
        assert_eq!(
            pool.claim_server_job("server-result", &owner_b),
            ServerJobClaim::OwnerMismatch
        );
        let response = b"HTTP/1.1 200 OK\r\n\r\n{}".to_vec();
        assert!(pool.complete_server_job("server-result", &owner_a, response.clone()));
        assert_eq!(
            pool.completed_server_response_for_owner("server-result", &owner_a),
            Some(response)
        );
        assert!(pool
            .completed_server_response_for_owner("server-result", &owner_b)
            .is_none());
        let snapshots = pool.server_job_snapshots_for_owner(&owner_a);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].job_id, "server-result");
        assert_eq!(
            snapshots[0].schedule_fingerprint.as_deref(),
            Some("v2:0123456789abcdef:42")
        );
        assert_eq!(snapshots[0].progress_budget_seconds, Some(120));
        assert_eq!(snapshots[0].progress_run_index, Some(3));
        assert!(snapshots[0].created_ms > 0);
        assert!(snapshots[0].completed_ms.is_some());
        assert!(pool.server_job_snapshots_for_owner(&owner_b).is_empty());

        {
            let mut state = pool.state.lock().unwrap();
            state
                .server_jobs
                .get_mut("server-result")
                .unwrap()
                .completed_ms = Some(crate::now_millis().saturating_sub(SERVER_RESULT_TTL_MS + 1));
        }
        assert!(pool
            .completed_server_response_for_owner("server-result", &owner_a)
            .is_none());
        assert!(pool.server_job_snapshots_for_owner(&owner_a).is_empty());
        assert!(!pool.server_job_known_for_owner("server-result", &owner_a));
    }

    #[test]
    fn server_owned_job_keeps_only_the_latest_bounded_progress_snapshot() {
        let pool = test_pool();
        let owner = SolverOwner::new("school-a", "admin-a");
        assert_eq!(
            pool.claim_server_job("progress-job", &owner),
            ServerJobClaim::Claimed
        );

        assert!(pool.update_server_job_progress(
            "progress-job",
            json!({
                "protocol": "tkb-reference-solver-progress-v1",
                "stage": "session:model",
                "message": "building",
                "sequence": 1
            }),
        ));
        assert!(pool.update_server_job_progress(
            "progress-job",
            json!({
                "protocol": "tkb-reference-solver-progress-v1",
                "stage": "session:solve",
                "message": "solving",
                "sequence": 2
            }),
        ));

        let snapshot = pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .next()
            .expect("progress snapshot");
        assert_eq!(
            snapshot
                .progress
                .as_ref()
                .and_then(|value| value["stage"].as_str()),
            Some("session:solve")
        );
        assert_eq!(
            snapshot
                .progress
                .as_ref()
                .and_then(|value| value["sequence"].as_u64()),
            Some(2)
        );
        assert!(snapshot.progress_updated_ms.is_some());

        let oversized = "x".repeat(MAX_SERVER_PROGRESS_BYTES + 1);
        assert!(!pool.update_server_job_progress(
            "progress-job",
            json!({"stage":"period:solve", "message":oversized}),
        ));
        let after_oversized = pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .next()
            .expect("preserved progress snapshot");
        assert_eq!(
            after_oversized
                .progress
                .as_ref()
                .and_then(|value| value["sequence"].as_u64()),
            Some(2)
        );

        assert!(!pool.update_server_job_progress("missing-job", json!({"stage":"session:solve"}),));
        assert!(!pool.update_server_job_progress("progress-job", json!({"stage":"bad\nheader"}),));
    }

    #[test]
    fn exclusive_executor_handoff_fences_vps_and_agent_writers() {
        let pool = test_pool();
        let owner = SolverOwner::new("school-handoff", "admin");
        let response = b"HTTP/1.1 200 OK\r\n\r\n{}".to_vec();

        // No Agent: the canonical job is reserved for the VPS and can commit
        // exactly once.
        assert_eq!(pool.claim_server_job("handoff-job", &owner), ServerJobClaim::Claimed);
        let vps = pool
            .prepare_vps_execution("handoff-job", &owner)
            .expect("VPS fence");
        assert!(pool.mark_vps_execution_running(vps, "handoff-job", &owner));

        // An Agent hello invalidates the local generation. The old local result
        // is rejected even if it races after the child has been asked to stop.
        assert_eq!(
            pool.request_agent_handoff_for_owner(&owner),
            vec!["handoff-job".to_string()]
        );
        assert!(!pool.complete_server_job_fenced(vps, "handoff-job", &owner, response.clone()));
        let agent = pool
            .prepare_agent_execution("handoff-job", &owner)
            .expect("Agent fence after VPS reaping");
        assert!(pool.mark_agent_execution_running(agent, "handoff-job", &owner));
        assert!(pool.complete_server_job_fenced(agent, "handoff-job", &owner, response.clone()));
        assert!(!pool.complete_server_job_fenced(vps, "handoff-job", &owner, response.clone()));

        // A fresh canonical job demonstrates abrupt Agent loss: expiry/failure
        // advances the generation and hands the same job back to the VPS.
        assert_eq!(pool.claim_server_job("agent-loss", &owner), ServerJobClaim::Claimed);
        let agent = pool
            .prepare_agent_execution("agent-loss", &owner)
            .expect("initial Agent fence");
        assert!(pool.mark_agent_execution_running(agent, "agent-loss", &owner));
        let vps = pool
            .fallback_agent_to_vps(agent, "agent-loss", &owner)
            .expect("VPS fallback fence");
        assert!(!pool.complete_server_job_fenced(agent, "agent-loss", &owner, response.clone()));
        assert!(pool.mark_vps_execution_running(vps, "agent-loss", &owner));
        assert!(pool.complete_server_job_fenced(vps, "agent-loss", &owner, response));
    }

    #[test]
    fn server_watchdog_budget_is_monotonic_across_vps_to_agent_handoff() {
        let pool = test_pool();
        let owner = SolverOwner::new("school-watchdog", "admin");
        assert_eq!(
            pool.claim_server_job_with_scope_progress_and_watchdog(
                "watchdog-job",
                &owner,
                None,
                None,
                None,
                None,
                Some(10_000),
            ),
            ServerJobClaim::Claimed
        );
        let vps = pool
            .prepare_vps_execution("watchdog-job", &owner)
            .expect("VPS fence");
        let (budget, started) = pool
            .server_job_watchdog_snapshot("watchdog-job", &owner)
            .expect("watchdog snapshot");
        assert_eq!(budget, Some(10_000));
        let started = started.expect("watchdog start");
        assert_eq!(
            pool.server_job_watchdog_remaining_ms("watchdog-job", &owner, started + 2_500),
            Some(7_500)
        );
        assert!(pool
            .request_agent_handoff_for_owner(&owner)
            .contains(&"watchdog-job".to_string()));
        let agent = pool
            .prepare_agent_execution("watchdog-job", &owner)
            .expect("Agent fence");
        assert!(agent.generation > vps.generation);
        assert_eq!(
            pool.server_job_watchdog_remaining_ms("watchdog-job", &owner, started + 2_500),
            Some(7_500),
            "handoff must not reset the canonical deadline"
        );

        let pending_pool = test_pool();
        assert_eq!(
            pending_pool.claim_server_job_with_scope_progress_and_watchdog(
                "pending-watchdog",
                &owner,
                None,
                None,
                None,
                None,
                Some(5_000),
            ),
            ServerJobClaim::Claimed
        );
        assert_eq!(
            pending_pool.request_agent_handoff_for_owner(&owner),
            vec!["pending-watchdog".to_string()]
        );
        pending_pool
            .prepare_agent_execution("pending-watchdog", &owner)
            .expect("pending Agent fence");
        assert!(pending_pool
            .server_job_watchdog_snapshot("pending-watchdog", &owner)
            .and_then(|(_, started)| started)
            .is_some());
    }

    #[test]
    fn unresolved_server_jobs_with_the_same_owner_and_fingerprint_are_deduplicated() {
        let pool = test_pool();
        let owner = SolverOwner::new("school-a", "admin-a");
        let other_owner = SolverOwner::new("school-a", "admin-b");
        let fingerprint = "v3:0123456789abcdef:42";

        assert_eq!(
            pool.claim_server_job_with_fingerprint("first-job", &owner, Some(fingerprint)),
            ServerJobClaim::Claimed
        );
        assert_eq!(
            pool.claim_server_job_with_fingerprint("second-job", &owner, Some(fingerprint)),
            ServerJobClaim::ExistingSchedule("first-job".to_string())
        );
        assert_eq!(
            pool.claim_server_job_with_fingerprint(
                "other-schedule",
                &owner,
                Some("v3:fedcba9876543210:42"),
            ),
            ServerJobClaim::Claimed
        );
        assert_eq!(
            pool.claim_server_job_with_fingerprint("other-owner", &other_owner, Some(fingerprint),),
            ServerJobClaim::Claimed
        );
        assert_eq!(pool.server_job_snapshots_for_owner(&owner).len(), 2);
        assert_eq!(pool.server_job_snapshots_for_owner(&other_owner).len(), 1);
    }

    #[test]
    fn unresolved_server_jobs_with_the_same_schedule_scope_are_never_duplicated() {
        let pool = test_pool();
        let owner = SolverOwner::new("school-a", "admin-a");

        assert_eq!(
            pool.claim_server_job_with_scope_progress(
                "scope-first",
                &owner,
                Some("default"),
                Some("v1:first"),
                Some(60),
                Some(1),
            ),
            ServerJobClaim::Claimed
        );
        assert_eq!(
            pool.claim_server_job_with_scope_progress(
                "scope-second",
                &owner,
                Some("default"),
                Some("v1:changed"),
                Some(60),
                Some(2),
            ),
            ServerJobClaim::ExistingScope("scope-first".to_string())
        );
        assert_eq!(pool.server_job_snapshots_for_owner(&owner).len(), 1);

        let response = b"HTTP/1.1 200 OK\r\n\r\n{}".to_vec();
        assert!(pool.complete_server_job("scope-first", &owner, response));
        assert_eq!(
            pool.claim_server_job_with_scope_progress(
                "scope-after-complete",
                &owner,
                Some("default"),
                Some("v1:changed"),
                Some(60),
                Some(3),
            ),
            ServerJobClaim::Claimed
        );
    }

    #[test]
    fn server_job_fingerprint_is_bounded_and_rejects_unsafe_metadata() {
        let pool = test_pool();
        let owner = SolverOwner::new("school", "admin");
        assert_eq!(
            pool.claim_server_job_with_fingerprint(
                "unsafe-fingerprint",
                &owner,
                Some("v2:abc\r\nInjected:true"),
            ),
            ServerJobClaim::Claimed
        );
        let snapshots = pool.server_job_snapshots_for_owner(&owner);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].schedule_fingerprint, None);
    }

    #[test]
    fn cancelled_server_owned_queue_ticket_cannot_be_reacquired() {
        let pool = test_pool();
        let owner = SolverOwner::new("school", "admin");
        let running = pool
            .try_acquire("all-workers".to_string(), 6)
            .expect("exclusive running job");
        assert_eq!(
            pool.claim_server_job("cancelled-queued", &owner),
            ServerJobClaim::Claimed
        );
        assert!(matches!(
            pool.acquire_or_enqueue_for_owner("cancelled-queued".to_string(), 3, owner.clone()),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert!(pool.cancel_job_for_owner("cancelled-queued", &owner));
        drop(running);
        assert!(matches!(
            pool.acquire_or_enqueue_for_owner("cancelled-queued".to_string(), 3, owner.clone()),
            SolverAdmission::AlreadyRunning
        ));
        assert_eq!(pool.queued_count(), 0);
    }

    #[test]
    fn cancel_discards_completed_or_racing_server_result() {
        let pool = test_pool();
        let owner = SolverOwner::new("school", "admin");
        assert_eq!(
            pool.claim_server_job("completed-cancel", &owner),
            ServerJobClaim::Claimed
        );
        assert!(pool.complete_server_job(
            "completed-cancel",
            &owner,
            b"HTTP/1.1 200 OK\r\n\r\n{}".to_vec()
        ));
        assert!(pool.cancel_job_for_owner("completed-cancel", &owner));
        assert!(!pool.server_job_known_for_owner("completed-cancel", &owner));

        assert_eq!(
            pool.claim_server_job("racing-cancel", &owner),
            ServerJobClaim::Claimed
        );
        assert!(pool.cancel_job_for_owner("racing-cancel", &owner));
        assert!(!pool.complete_server_job(
            "racing-cancel",
            &owner,
            b"HTTP/1.1 200 OK\r\n\r\n{}".to_vec()
        ));
        assert!(!pool.server_job_known_for_owner("racing-cancel", &owner));
    }

    #[test]
    fn queued_jobs_are_admitted_in_fifo_order() {
        let pool = test_pool();
        let running_max = pool.try_acquire("running-max".to_string(), 4).unwrap();
        let running_fast = pool.try_acquire("running-fast".to_string(), 2).unwrap();

        match pool.acquire_or_enqueue("queued-1".to_string(), 4) {
            SolverAdmission::Queued { position, .. } => assert_eq!(position, 1),
            _ => panic!("first waiting job should be queued"),
        }
        match pool.acquire_or_enqueue("queued-2".to_string(), 4) {
            SolverAdmission::Queued { position, .. } => assert_eq!(position, 2),
            _ => panic!("second waiting job should be queued"),
        }

        drop(running_fast);
        match pool.acquire_or_enqueue("queued-2".to_string(), 4) {
            SolverAdmission::Queued { position, .. } => assert_eq!(position, 2),
            _ => panic!("second job must not jump over the queue head"),
        }
        assert!(matches!(
            pool.acquire_or_enqueue("queued-1".to_string(), 4),
            SolverAdmission::Queued { position: 1, .. }
        ));

        drop(running_max);
        let queued_1 = match pool.acquire_or_enqueue("queued-1".to_string(), 4) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("queue head should acquire all four released tokens"),
        };
        assert_eq!(queued_1.job.allocated_workers, 4);
        assert!(matches!(
            pool.acquire_or_enqueue("queued-2".to_string(), 4),
            SolverAdmission::Queued { position: 1, .. }
        ));

        drop(queued_1);
        let queued_2 = match pool.acquire_or_enqueue("queued-2".to_string(), 4) {
            SolverAdmission::Acquired(guard) => guard,
            _ => panic!("second queued job should run after all four tokens are free"),
        };
        assert_eq!(queued_2.job.allocated_workers, 4);
    }

    #[test]
    fn cancelling_a_waiting_job_removes_it_from_the_queue() {
        let pool = test_pool();
        let running_1 = pool.try_acquire("running-1".to_string(), 4).unwrap();
        let running_2 = pool.try_acquire("running-2".to_string(), 2).unwrap();
        assert!(matches!(
            pool.acquire_or_enqueue("waiting".to_string(), 2),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert_eq!(pool.queued_count(), 1);
        assert!(pool.touch_queued_job("waiting"));
        assert!(!pool.touch_queued_job("missing"));
        assert!(pool.cancel_job("waiting"));
        assert_eq!(pool.queued_count(), 0);
        assert!(!pool.cancel_job("waiting"));
        drop((running_1, running_2));
    }

    #[test]
    fn active_jobs_are_visible_and_cancellable_only_by_their_owner() {
        let pool = test_pool();
        let owner_a = SolverOwner::new("school-a", "admin-a");
        let owner_b = SolverOwner::new("school-b", "admin-b");
        let running = pool
            .try_acquire_for_owner("owned-active".to_string(), 2, owner_a.clone())
            .expect("owner A active job");

        assert_eq!(pool.snapshot_for_owner(&owner_a).len(), 1);
        assert!(pool.snapshot_for_owner(&owner_b).is_empty());
        assert!(!pool.cancel_job_for_owner("owned-active", &owner_b));
        assert!(!running.job.cancel_requested.load(Ordering::SeqCst));
        assert!(pool.cancel_job_for_owner("owned-active", &owner_a));
        assert!(running.job.cancel_requested.load(Ordering::SeqCst));
    }

    #[test]
    fn queued_jobs_keep_global_position_but_reject_other_owners() {
        let pool = test_pool();
        let owner_a = SolverOwner::new("school-a", "admin-a");
        let owner_b = SolverOwner::new("school-b", "admin-b");
        let running_1 = pool
            .try_acquire_for_owner("running-a".to_string(), 4, owner_a.clone())
            .unwrap();
        let running_2 = pool
            .try_acquire_for_owner("running-b".to_string(), 2, owner_b.clone())
            .unwrap();

        assert!(matches!(
            pool.acquire_or_enqueue_for_owner("waiting-a".to_string(), 2, owner_a.clone()),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert!(matches!(
            pool.acquire_or_enqueue_for_owner("waiting-b".to_string(), 2, owner_b.clone()),
            SolverAdmission::Queued { position: 2, .. }
        ));
        assert!(matches!(
            pool.acquire_or_enqueue_for_owner("waiting-a".to_string(), 2, owner_b.clone()),
            SolverAdmission::AlreadyRunning
        ));

        assert_eq!(
            pool.queue_snapshot_for_owner(&owner_a)
                .into_iter()
                .map(|(job_id, _, position, _)| (job_id, position))
                .collect::<Vec<_>>(),
            vec![("waiting-a".to_string(), 1)]
        );
        assert_eq!(
            pool.queue_snapshot_for_owner(&owner_b)
                .into_iter()
                .map(|(job_id, _, position, _)| (job_id, position))
                .collect::<Vec<_>>(),
            vec![("waiting-b".to_string(), 2)]
        );
        assert_eq!(pool.queue_snapshot_for_owner(&owner_a)[0].3, 2);
        assert_eq!(pool.queue_snapshot_for_owner(&owner_b)[0].3, 2);
        assert!(!pool.touch_queued_job_for_owner("waiting-a", &owner_b));
        assert!(!pool.cancel_job_for_owner("waiting-a", &owner_b));
        assert!(pool.touch_queued_job_for_owner("waiting-a", &owner_a));
        assert!(pool.cancel_job_for_owner("waiting-a", &owner_a));
        assert_eq!(pool.queue_snapshot_for_owner(&owner_b)[0].2, 1);

        drop((running_1, running_2));
    }

    #[test]
    fn stale_queue_head_cannot_block_new_work_forever() {
        let pool = test_pool();
        let running_1 = pool.try_acquire("running-1".to_string(), 4).unwrap();
        let running_2 = pool.try_acquire("running-2".to_string(), 2).unwrap();
        assert!(matches!(
            pool.acquire_or_enqueue("stale".to_string(), 2),
            SolverAdmission::Queued { position: 1, .. }
        ));
        {
            let mut state = pool.state.lock().unwrap();
            state.queue.front_mut().unwrap().last_seen_ms =
                crate::now_millis().saturating_sub(QUEUE_LEASE_MS + 1);
        }
        assert!(matches!(
            pool.acquire_or_enqueue("fresh".to_string(), 2),
            SolverAdmission::Queued { position: 1, .. }
        ));
        drop((running_1, running_2));
    }

    #[test]
    fn ten_waiters_finish_without_starvation() {
        let pool = test_pool();
        let running = (1..=3)
            .map(|index| {
                pool.try_acquire(format!("running-{index}"), 2)
                    .expect("initial capacity")
            })
            .collect::<Vec<_>>();
        for index in 1..=10 {
            match pool.acquire_or_enqueue(format!("waiting-{index}"), 2) {
                SolverAdmission::Queued { position, .. } => assert_eq!(position, index),
                _ => panic!("all ten jobs should enter the wait queue"),
            }
        }
        drop(running);

        for index in 1..=10 {
            if index < 10 {
                match pool.acquire_or_enqueue("waiting-10".to_string(), 2) {
                    SolverAdmission::Queued { position, .. } => {
                        assert_eq!(position, 11 - index)
                    }
                    _ => panic!("the last job must not skip the remaining queue"),
                }
            }
            let guard = match pool.acquire_or_enqueue(format!("waiting-{index}"), 2) {
                SolverAdmission::Acquired(guard) => guard,
                _ => panic!("the next FIFO job should be admitted"),
            };
            drop(guard);
        }
        assert_eq!(pool.active_count(), 0);
        assert_eq!(pool.queued_count(), 0);
    }
}
