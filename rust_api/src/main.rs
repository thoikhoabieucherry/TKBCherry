use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Condvar, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{panic, panic::AssertUnwindSafe};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

mod agent_helper;
mod auth;
mod db;
mod google_cloud_usage;
mod jsonlite;
mod native_precheck;
mod native_solver;
mod serverless;
mod solver_telemetry;
mod solver_pool;

const VERSION: &str = "tkb_new-rust-api-2026-08-10-constraint-sanitize-safe-partial-v131";
const REFERENCE_STDIO_PROTOCOL: &str = "tkb-reference-solver-stdio-v1";
const REFERENCE_SOLVER_CONTRACT_VERSION: &str = "tkb-reference-solver-contract-v1";
const EXTERNAL_MODEL_PLAN_VERSION: &str = "tkb-model-plan-v1";
const REFERENCE_PROGRESS_PROTOCOL: &str = "tkb-reference-solver-progress-v1";
const REFERENCE_PROGRESS_PREFIX: &str = "@@TKB_PROGRESS@@";
const MAX_REFERENCE_PROGRESS_FRAME_BYTES: usize = 32 * 1024;
const AGENT_HELPER_PROTOCOL: &str = "tkb-agent-helper-v1";
const AGENT_RESULT_DIGEST_PROTOCOL: &str = "tkb-json-tree-sha256-v1";
const TRUSTED_AGENT_TOKEN_HASH_ENV: &str = "TKB_TRUSTED_AGENT_TOKEN_SHA256";
const TRUSTED_AGENT_TOKEN_PREFIX: &str = "tkbt_";
// Windows is native-Agent-only. Require the first package that carries the
// exact reference-runtime identity and the complete protobuf/OR-Tools bundle;
// 1.6.32 could fail immediately and silently hand the same job to VPS.
const MIN_AGENT_HELPER_VERSION: &str = "1.6.33";
const MIN_AGENT_HELPER_SEMVER: (u32, u32, u32) = (1, 6, 33);
const MIN_BROWSER_AGENT_HELPER_VERSION: &str = "1.6.32";
const MIN_BROWSER_AGENT_HELPER_SEMVER: (u32, u32, u32) = (1, 6, 32);
const NATIVE_SOLVER_RUNTIME_VERSION: &str = "20260729.1";
const NATIVE_SOLVER_RUNTIME_DIGEST: &str =
    "91d56f56d684b6361bcd27e6aeb809ddf29c0c45035600487b4b68f904922d7e";
// A canonical server-owned job has exactly one executor. Keeping one Agent
// task (instead of a seed portfolio) prevents the Agent and VPS from adding
// parallel attempts to the same user request.
const AGENT_HELPER_SEEDS_PER_JOB: usize = 1;
#[cfg(not(test))]
const AGENT_CLAIM_GRACE_MS: u64 = 8_000;
#[cfg(test)]
// Keep test grace above the 150 ms HTTP lease-poll cadence so parallel tests
// can observe a newly registered canonical task before the VPS fallback wins.
const AGENT_CLAIM_GRACE_MS: u64 = 500;
const MIN_SOLVER_DEADLINE_MS: u64 = 1_000;
const MAX_SOLVER_DEADLINE_MS: u64 = 1_800_000;
const DEFAULT_SOLVER_DEADLINE_MS: u64 = 180_000;
const DEFAULT_SOLVER_RESERVE_MS: u64 = 1_500;
const MAX_SOLVER_RESERVE_MS: u64 = 30_000;
const BROWSER_WASM_QUICK_ATTEMPT_MS: u64 = 12_000;
const BROWSER_WASM_QUICK_RESERVE_MS: u64 = 750;
// Rich Browser-Agent requests use the exact CP-SAT/HiGHS stream for their
// first-feasible seed.  Thirty seconds was enough for the compact heuristic
// lane but repeatedly ended the exact model in UNKNOWN before a complete
// timetable could be materialized.  Keep this below the canonical 180-second
// attempt so the quality/refinement phase still has a bounded tail.
const BROWSER_WASM_EXACT_COMPLETION_SEED_MS: u64 = 90_000;
const UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS: u64 = 20_000;
const CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS: u64 = 295;
// Once the helper has announced a successful terminal result, computation is
// already complete. Give it a small, bounded window to flush the JSON wrapper
// and exit instead of replacing that finished timetable with a watchdog 422.
const REFERENCE_TERMINAL_RESULT_GRACE_MS: u64 = 10_000;
const REFERENCE_CANDIDATE_VALIDATION_TIMEOUT_MS: u64 = 15_000;
const EXTERNAL_CP_SAT_STEP_TIMEOUT_MS: u64 = 120_000;
const MAX_EXTERNAL_CP_SAT_STEPS: usize = 64;
const EXTERNAL_CP_SAT_STREAM_REAPER_MS: u64 = 1_000;
// A Cloud Run transport/auth/startup failure is safe to rescue on VPS while
// almost the whole canonical solve window remains. A late Cloud failure must
// not start a second low-quality three-minute attempt after consuming the first
// one; the user receives the Cloud error and may retry deliberately instead.
const SERVERLESS_EARLY_FALLBACK_MAX_MS: u64 = 30_000;
const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXTERNAL_CP_SAT_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXTERNAL_CP_SAT_RESPONSE_BASE64_CHARS: usize =
    ((MAX_EXTERNAL_CP_SAT_RESPONSE_BYTES + 2) / 3) * 4;
const MAX_EXTERNAL_RESULT_ATTESTATIONS: usize = 512;
const CLOUD_STOP_PROBE_MAX_WAIT_MS: u64 = 10_000;
const CLOUD_STOP_PROBE_TTL_MS: u64 = MAX_SERVER_WATCHDOG_MS + 60_000;

#[cfg(test)]
fn reference_helper_process_limit() -> usize {
    3
}

#[cfg(not(test))]
fn reference_helper_process_limit() -> usize {
    env::var("TKB_REFERENCE_HELPER_PROCESSES")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 8)
}

#[derive(Clone, Copy)]
enum ReferenceHelperKind {
    ModelBuilder,
    CandidateValidator,
}

#[derive(Clone, Copy, Debug, Default)]
struct ReferenceHelperProcessSnapshot {
    limit: usize,
    active: usize,
    model_builders_active: usize,
    candidate_validators_active: usize,
    peak_active: usize,
    waiting: usize,
    starts: u64,
    admission_timeouts: u64,
}

#[derive(Default)]
struct ReferenceHelperProcessState {
    active: usize,
    model_builders_active: usize,
    candidate_validators_active: usize,
    peak_active: usize,
    waiting: usize,
    starts: u64,
    admission_timeouts: u64,
}

struct ReferenceHelperProcessLimiter {
    limit: usize,
    state: Mutex<ReferenceHelperProcessState>,
    available: Condvar,
}

impl ReferenceHelperProcessLimiter {
    fn new(limit: usize) -> Self {
        Self {
            limit: limit.max(1),
            state: Mutex::new(ReferenceHelperProcessState::default()),
            available: Condvar::new(),
        }
    }

    fn acquire(
        &'static self,
        kind: ReferenceHelperKind,
        timeout: Duration,
    ) -> Option<ReferenceHelperProcessPermit> {
        let started = Instant::now();
        let mut state = self.state.lock().ok()?;
        let mut counted_waiter = false;
        loop {
            if state.active < self.limit {
                if counted_waiter {
                    state.waiting = state.waiting.saturating_sub(1);
                }
                state.active += 1;
                match kind {
                    ReferenceHelperKind::ModelBuilder => state.model_builders_active += 1,
                    ReferenceHelperKind::CandidateValidator => {
                        state.candidate_validators_active += 1
                    }
                }
                state.peak_active = state.peak_active.max(state.active);
                state.starts = state.starts.saturating_add(1);
                return Some(ReferenceHelperProcessPermit {
                    limiter: self,
                    kind,
                    active: true,
                });
            }
            if !counted_waiter {
                state.waiting += 1;
                counted_waiter = true;
            }
            let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                state.waiting = state.waiting.saturating_sub(1);
                state.admission_timeouts = state.admission_timeouts.saturating_add(1);
                return None;
            };
            let (next_state, wait) = self.available.wait_timeout(state, remaining).ok()?;
            state = next_state;
            if wait.timed_out() && state.active >= self.limit {
                state.waiting = state.waiting.saturating_sub(1);
                state.admission_timeouts = state.admission_timeouts.saturating_add(1);
                return None;
            }
        }
    }

    fn release(&self, kind: ReferenceHelperKind) {
        if let Ok(mut state) = self.state.lock() {
            state.active = state.active.saturating_sub(1);
            match kind {
                ReferenceHelperKind::ModelBuilder => {
                    state.model_builders_active = state.model_builders_active.saturating_sub(1)
                }
                ReferenceHelperKind::CandidateValidator => {
                    state.candidate_validators_active =
                        state.candidate_validators_active.saturating_sub(1)
                }
            }
            self.available.notify_one();
        }
    }

    fn snapshot(&self) -> ReferenceHelperProcessSnapshot {
        let Ok(state) = self.state.lock() else {
            return ReferenceHelperProcessSnapshot {
                limit: self.limit,
                ..ReferenceHelperProcessSnapshot::default()
            };
        };
        ReferenceHelperProcessSnapshot {
            limit: self.limit,
            active: state.active,
            model_builders_active: state.model_builders_active,
            candidate_validators_active: state.candidate_validators_active,
            peak_active: state.peak_active,
            waiting: state.waiting,
            starts: state.starts,
            admission_timeouts: state.admission_timeouts,
        }
    }
}

struct ReferenceHelperProcessPermit {
    limiter: &'static ReferenceHelperProcessLimiter,
    kind: ReferenceHelperKind,
    active: bool,
}

impl Drop for ReferenceHelperProcessPermit {
    fn drop(&mut self) {
        if self.active {
            self.limiter.release(self.kind);
            self.active = false;
        }
    }
}

fn reference_helper_process_limiter() -> &'static ReferenceHelperProcessLimiter {
    static LIMITER: OnceLock<ReferenceHelperProcessLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| ReferenceHelperProcessLimiter::new(reference_helper_process_limit()))
}

struct ManagedChild(Child);

type ExternalCpSatStreamOutput = Result<Option<String>, String>;

struct ExternalCpSatStreamInput {
    bytes: Vec<u8>,
    ack: mpsc::Sender<Result<(), String>>,
}

struct ExternalCpSatStream {
    _process_permit: ReferenceHelperProcessPermit,
    child: ManagedChild,
    input_tx: Option<mpsc::SyncSender<ExternalCpSatStreamInput>>,
    output_rx: mpsc::Receiver<ExternalCpSatStreamOutput>,
    input_writer: Option<thread::JoinHandle<()>>,
    stdout_reader: Option<thread::JoinHandle<()>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
    stderr_tail: Arc<Mutex<String>>,
    next_step: usize,
    pending_model_digest: Option<String>,
    accepted_response_digests: Vec<String>,
    deadline_at_ms: u64,
    cancelled: Arc<AtomicBool>,
}

impl Drop for ExternalCpSatStream {
    fn drop(&mut self) {
        self.input_tx.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(writer) = self.input_writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

struct ExternalCpSatStreamEntry {
    stream: Arc<Mutex<ExternalCpSatStream>>,
    worker_key: String,
    job_id: String,
    stream_kind: String,
    deadline_at_ms: u64,
    lease_expires_at_ms: u64,
    cancelled: Arc<AtomicBool>,
}

struct ExternalCpSatPendingStart {
    worker_key: String,
    job_id: String,
    stream_kind: String,
    deadline_at_ms: u64,
    lease_expires_at_ms: u64,
    cancelled: Arc<AtomicBool>,
}

struct ExternalResultAttestation {
    worker_key: String,
    job_id: String,
    digest: String,
    expires_at_ms: u64,
}

#[derive(Default)]
struct ExternalCpSatStreamState {
    streams: HashMap<String, ExternalCpSatStreamEntry>,
    starts: HashMap<String, ExternalCpSatPendingStart>,
    result_attestations: HashMap<String, ExternalResultAttestation>,
}

#[derive(Default)]
struct ExternalCpSatStreamCoordinator {
    state: Mutex<ExternalCpSatStreamState>,
}

#[derive(Debug)]
enum ExternalCpSatStreamError {
    Capacity,
    Conflict(String),
    Cancelled,
    TimedOut,
    Failed(String),
}

impl ExternalCpSatStreamError {
    fn invalidates_stream(&self) -> bool {
        matches!(self, Self::Cancelled | Self::TimedOut | Self::Failed(_))
    }
}

#[cfg(test)]
fn external_cp_sat_stream_limit() -> usize {
    2
}

#[cfg(not(test))]
fn external_cp_sat_stream_limit() -> usize {
    env::var("TKB_EXTERNAL_CP_SAT_BUILDERS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, 8)
}

impl ExternalCpSatStreamCoordinator {
    fn new() -> Arc<Self> {
        let coordinator = Arc::new(Self::default());
        let weak = Arc::downgrade(&coordinator);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(EXTERNAL_CP_SAT_STREAM_REAPER_MS));
            let Some(coordinator) = weak.upgrade() else {
                break;
            };
            coordinator.prune_expired(now_millis());
        });
        coordinator
    }

    fn get_or_start<F>(
        &self,
        lease_id: &str,
        worker_key: &str,
        job_id: &str,
        stream_kind: &str,
        response_count: usize,
        deadline_at_ms: u64,
        lease_expires_at_ms: u64,
        start: F,
    ) -> Result<Arc<Mutex<ExternalCpSatStream>>, ExternalCpSatStreamError>
    where
        F: FnOnce(Arc<AtomicBool>) -> Result<ExternalCpSatStream, ExternalCpSatStreamError>,
    {
        self.prune_expired(now_millis());
        let mut state = self.state.lock().map_err(|_| {
            ExternalCpSatStreamError::Failed("external CP-SAT stream registry poisoned".to_string())
        })?;
        if let Some(entry) = state.streams.get(lease_id) {
            if entry.worker_key != worker_key
                || entry.job_id != job_id
                || entry.stream_kind != stream_kind
            {
                return Err(ExternalCpSatStreamError::Conflict(
                    "external CP-SAT stream owner changed".to_string(),
                ));
            }
            return Ok(entry.stream.clone());
        }
        if state.starts.contains_key(lease_id) {
            return Err(ExternalCpSatStreamError::Conflict(
                "external CP-SAT stream start is already in progress".to_string(),
            ));
        }
        if response_count != 0 {
            return Err(ExternalCpSatStreamError::Conflict(
                "external CP-SAT stream state is unavailable".to_string(),
            ));
        }
        if state.streams.len().saturating_add(state.starts.len()) >= external_cp_sat_stream_limit()
        {
            return Err(ExternalCpSatStreamError::Capacity);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.starts.insert(
            lease_id.to_string(),
            ExternalCpSatPendingStart {
                worker_key: worker_key.to_string(),
                job_id: job_id.to_string(),
                stream_kind: stream_kind.to_string(),
                deadline_at_ms,
                lease_expires_at_ms,
                cancelled: cancelled.clone(),
            },
        );
        drop(state);

        let started = start(cancelled.clone());
        let mut state = self.state.lock().map_err(|_| {
            ExternalCpSatStreamError::Failed("external CP-SAT stream registry poisoned".to_string())
        })?;
        let pending = state.starts.remove(lease_id);
        let Some(pending) = pending else {
            drop(state);
            drop(started);
            return Err(ExternalCpSatStreamError::Cancelled);
        };
        if pending.cancelled.load(Ordering::Relaxed)
            || pending.worker_key != worker_key
            || pending.job_id != job_id
            || pending.stream_kind != stream_kind
        {
            drop(state);
            drop(started);
            return Err(ExternalCpSatStreamError::Cancelled);
        }
        let stream = Arc::new(Mutex::new(started?));
        state.streams.insert(
            lease_id.to_string(),
            ExternalCpSatStreamEntry {
                stream: stream.clone(),
                worker_key: pending.worker_key,
                job_id: pending.job_id,
                stream_kind: pending.stream_kind,
                deadline_at_ms: pending.deadline_at_ms,
                lease_expires_at_ms: pending.lease_expires_at_ms,
                cancelled,
            },
        );
        Ok(stream)
    }

    fn remove_lease(&self, lease_id: &str) {
        let removed = if let Ok(mut state) = self.state.lock() {
            if let Some(pending) = state.starts.remove(lease_id) {
                pending.cancelled.store(true, Ordering::Relaxed);
            }
            state.result_attestations.remove(lease_id);
            state.streams.remove(lease_id)
        } else {
            None
        };
        if let Some(entry) = &removed {
            entry.cancelled.store(true, Ordering::Relaxed);
        }
        drop(removed);
    }

    fn remove_lease_if_same(&self, lease_id: &str, stream: &Arc<Mutex<ExternalCpSatStream>>) {
        let removed = if let Ok(mut state) = self.state.lock() {
            let matches = state
                .streams
                .get(lease_id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.stream, stream));
            if matches {
                state.streams.remove(lease_id)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(entry) = &removed {
            entry.cancelled.store(true, Ordering::Relaxed);
        }
        drop(removed);
    }

    fn remove_worker(&self, worker_key: &str) {
        let removed = if let Ok(mut state) = self.state.lock() {
            let pending_ids = state
                .starts
                .iter()
                .filter_map(|(lease_id, pending)| {
                    (pending.worker_key == worker_key).then_some(lease_id.clone())
                })
                .collect::<Vec<_>>();
            for lease_id in pending_ids {
                if let Some(pending) = state.starts.remove(&lease_id) {
                    pending.cancelled.store(true, Ordering::Relaxed);
                }
            }
            state
                .result_attestations
                .retain(|_, attestation| attestation.worker_key != worker_key);
            let lease_ids = state
                .streams
                .iter()
                .filter_map(|(lease_id, entry)| {
                    (entry.worker_key == worker_key).then_some(lease_id.clone())
                })
                .collect::<Vec<_>>();
            lease_ids
                .into_iter()
                .filter_map(|lease_id| state.streams.remove(&lease_id))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for entry in &removed {
            entry.cancelled.store(true, Ordering::Relaxed);
        }
        drop(removed);
    }

    fn remove_job(&self, job_id: &str) {
        let removed = if let Ok(mut state) = self.state.lock() {
            let pending_ids = state
                .starts
                .iter()
                .filter_map(|(lease_id, pending)| {
                    (pending.job_id == job_id).then_some(lease_id.clone())
                })
                .collect::<Vec<_>>();
            for lease_id in pending_ids {
                if let Some(pending) = state.starts.remove(&lease_id) {
                    pending.cancelled.store(true, Ordering::Relaxed);
                }
            }
            state
                .result_attestations
                .retain(|_, attestation| attestation.job_id != job_id);
            let lease_ids = state
                .streams
                .iter()
                .filter_map(|(lease_id, entry)| {
                    (entry.job_id == job_id).then_some(lease_id.clone())
                })
                .collect::<Vec<_>>();
            lease_ids
                .into_iter()
                .filter_map(|lease_id| state.streams.remove(&lease_id))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for entry in &removed {
            entry.cancelled.store(true, Ordering::Relaxed);
        }
        drop(removed);
    }

    fn renew_lease(&self, lease_id: &str, lease_expires_at_ms: u64) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(entry) = state.streams.get_mut(lease_id) {
                entry.lease_expires_at_ms = lease_expires_at_ms;
            }
            if let Some(pending) = state.starts.get_mut(lease_id) {
                pending.lease_expires_at_ms = lease_expires_at_ms;
            }
            if let Some(attestation) = state.result_attestations.get_mut(lease_id) {
                attestation.expires_at_ms = lease_expires_at_ms;
            }
        }
    }

    fn attest_result(
        &self,
        lease_id: &str,
        worker_key: &str,
        job_id: &str,
        digest: &str,
        expires_at_ms: u64,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state
            .result_attestations
            .retain(|_, attestation| attestation.expires_at_ms > now_millis());
        if state.result_attestations.len() >= MAX_EXTERNAL_RESULT_ATTESTATIONS {
            if let Some(oldest) = state
                .result_attestations
                .iter()
                .min_by_key(|(_, attestation)| attestation.expires_at_ms)
                .map(|(lease_id, _)| lease_id.clone())
            {
                state.result_attestations.remove(&oldest);
            }
        }
        state.result_attestations.insert(
            lease_id.to_string(),
            ExternalResultAttestation {
                worker_key: worker_key.to_string(),
                job_id: job_id.to_string(),
                digest: digest.to_string(),
                expires_at_ms,
            },
        );
    }

    fn consume_attested_result(
        &self,
        lease_id: &str,
        worker_key: &str,
        job_id: &str,
        digest: &str,
        now_ms: u64,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let matches = state
            .result_attestations
            .get(lease_id)
            .is_some_and(|attestation| {
                attestation.worker_key == worker_key
                    && attestation.job_id == job_id
                    && attestation.digest == digest
                    && attestation.expires_at_ms > now_ms
            });
        if matches {
            state.result_attestations.remove(lease_id);
        } else {
            state
                .result_attestations
                .retain(|_, attestation| attestation.expires_at_ms > now_ms);
        }
        matches
    }

    fn prune_expired(&self, now_ms: u64) {
        let removed = if let Ok(mut state) = self.state.lock() {
            state
                .result_attestations
                .retain(|_, attestation| attestation.expires_at_ms > now_ms);
            let pending_ids = state
                .starts
                .iter()
                .filter_map(|(lease_id, pending)| {
                    (pending.deadline_at_ms <= now_ms || pending.lease_expires_at_ms <= now_ms)
                        .then_some(lease_id.clone())
                })
                .collect::<Vec<_>>();
            for lease_id in pending_ids {
                if let Some(pending) = state.starts.remove(&lease_id) {
                    pending.cancelled.store(true, Ordering::Relaxed);
                }
            }
            let lease_ids = state
                .streams
                .iter()
                .filter_map(|(lease_id, entry)| {
                    (entry.deadline_at_ms <= now_ms || entry.lease_expires_at_ms <= now_ms)
                        .then_some(lease_id.clone())
                })
                .collect::<Vec<_>>();
            lease_ids
                .into_iter()
                .filter_map(|lease_id| state.streams.remove(&lease_id))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for entry in &removed {
            entry.cancelled.store(true, Ordering::Relaxed);
        }
        drop(removed);
    }
}

fn external_cp_sat_streams() -> &'static Arc<ExternalCpSatStreamCoordinator> {
    static STREAMS: OnceLock<Arc<ExternalCpSatStreamCoordinator>> = OnceLock::new();
    STREAMS.get_or_init(ExternalCpSatStreamCoordinator::new)
}

fn external_cp_sat_stream_worker_key(worker_token: &str) -> String {
    let digest = Sha256::digest(worker_token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct ManagedStopFile(PathBuf);

impl Drop for ManagedStopFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl std::ops::Deref for ManagedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        // std::process::Child does not kill on drop. Always reap the helper so an
        // early pipe/poll error cannot release a solver slot while Python keeps
        // consuming CPU in the background.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

use agent_helper::{
    session_binding as agent_session_binding, AgentHelperCoordinator, AgentHelperError,
    AgentJobExecution, AgentLeaseHeartbeat, AgentNativeState, AgentPairError, AgentPairStatus,
    AgentResourceTelemetry, AgentStopTakeover, AgentVpsTakeover, AgentWorkLease,
    ExternalCpSatAdmission, ExternalCpSatReplay, AGENT_IDLE_RETRY_MS, AGENT_WORK_LEASE_MS,
};
use solver_pool::{
    job_id_from_cancel_body, job_id_from_solve_body, ServerExecutionFence, ServerExecutionPhase,
    ServerExecutor, ServerJobClaim, ServerJobSnapshot, SolverAdmission, SolverJobGuard,
    SolverOwner, SolverPool, MAX_SERVER_WATCHDOG_MS, MAX_UNRESOLVED_SERVER_JOBS,
    MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER,
};
use serverless::{ReservationOutcome, RoutingMode, ServerlessCoordinator};

#[derive(Clone)]
struct App {
    root: PathBuf,
    web_root: PathBuf,
    sample_data: PathBuf,
    solver_pool: Arc<SolverPool>,
    agent_helper: Arc<AgentHelperCoordinator>,
    serverless: Arc<ServerlessCoordinator>,
    db: Arc<db::Db>,
}

struct Request {
    method: String,
    path: String,
    query: String,
    body: Vec<u8>,
    auth_token: Option<String>,
    client_ip: String,
}

#[derive(Clone)]
struct CloudStopProbeRegistration {
    token: String,
    owner: SolverOwner,
    expires_at_ms: u64,
}

struct CloudStopProbeGuard {
    job_id: String,
    token: String,
}

fn cloud_stop_probes() -> &'static Mutex<HashMap<String, CloudStopProbeRegistration>> {
    static PROBES: OnceLock<Mutex<HashMap<String, CloudStopProbeRegistration>>> = OnceLock::new();
    PROBES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cloud_stop_probe(job_id: &str, owner: &SolverOwner) -> CloudStopProbeGuard {
    let token = auth::random_token();
    let registration = CloudStopProbeRegistration {
        token: token.clone(),
        owner: owner.clone(),
        expires_at_ms: now_millis().saturating_add(CLOUD_STOP_PROBE_TTL_MS),
    };
    if let Ok(mut probes) = cloud_stop_probes().lock() {
        probes.insert(job_id.to_string(), registration);
    }
    CloudStopProbeGuard {
        job_id: job_id.to_string(),
        token,
    }
}

impl Drop for CloudStopProbeGuard {
    fn drop(&mut self) {
        let Ok(mut probes) = cloud_stop_probes().lock() else {
            return;
        };
        let matches = probes
            .get(&self.job_id)
            .is_some_and(|probe| constant_time_ascii_equal(&probe.token, &self.token));
        if matches {
            probes.remove(&self.job_id);
        }
    }
}

fn cloud_stop_probe_url() -> String {
    env::var("TKB_CLOUD_STOP_PROBE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            "https://tkbcherry.com/api/internal/solver-stop-probe".to_string()
        })
}

fn main() -> std::io::Result<()> {
    let host = env::var("TKB_RUST_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("TKB_RUST_PORT").unwrap_or_else(|_| "1010".to_string());
    let root = resolve_app_root()?;
    let db_path = env::var("TKB_DB_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("rust_api").join("tkb_store.db"));
    let db = Arc::new(db::Db::new(db_path).expect("Failed to initialize database"));
    auth::ensure_super_admin(&db);
    let app = Arc::new(App {
        web_root: root.join("web"),
        sample_data: root
            .join("rust_api")
            .join("fixtures")
            .join("sample-data.json"),
        solver_pool: SolverPool::from_env(),
        agent_helper: AgentHelperCoordinator::new(),
        serverless: ServerlessCoordinator::new(Arc::clone(&db)),
        root,
        db,
    });

    let listener = TcpListener::bind(format!("{host}:{port}"))?;
    if !quiet_logs() {
        println!("tkb_rust_api listening on http://{host}:{port}");
        println!("solver: rust fill non-off with teacher zero-gap repair v15");
    }

    for stream in listener.incoming() {
        let app = app.clone();
        match stream {
            Ok(stream) => {
                thread::spawn(move || {
                    if let Err(err) = handle_stream(stream, &app) {
                        if !quiet_logs() {
                            eprintln!("request failed: {err}");
                        }
                    }
                });
            }
            Err(err) => {
                if !quiet_logs() {
                    eprintln!("accept failed: {err}");
                }
            }
        }
    }
    Ok(())
}

fn env_flag(name: &str, default: bool) -> bool {
    let raw = env::var(name).unwrap_or_else(|_| if default { "1" } else { "0" }.to_string());
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

fn quiet_logs() -> bool {
    env_flag("TKB_NO_LOGS", false) || env_flag("TKB_RUST_QUIET", false)
}

fn resolve_app_root() -> std::io::Result<PathBuf> {
    if let Ok(value) = env::var("TKB_APP_ROOT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Ok(exe) = env::current_exe() {
        for ancestor in exe.ancestors() {
            if ancestor.file_name().and_then(|value| value.to_str()) == Some("rust_api") {
                if let Some(parent) = ancestor.parent() {
                    return Ok(parent.to_path_buf());
                }
            }
        }
    }
    Ok(env::current_dir()?
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf())
}

fn handle_stream(mut stream: TcpStream, app: &App) -> std::io::Result<()> {
    let peer_ip = stream.peer_addr().ok().map(|address| address.ip());
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];

    loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);

        if let Some(header_end) = find_header_end(&buffer) {
            if header_end > MAX_HTTP_HEADER_BYTES {
                stream.write_all(&json_response(
                    431,
                    json!({"ok": false, "error": "request_header_too_large"}),
                ))?;
                return Ok(());
            }
            let header = String::from_utf8_lossy(&buffer[..header_end]).to_string();
            let content_length = parse_content_length(&header);
            if content_length > MAX_HTTP_REQUEST_BODY_BYTES {
                stream.write_all(&json_response(
                    413,
                    json!({"ok": false, "error": "request_too_large"}),
                ))?;
                return Ok(());
            }
            let body_start = header_end + 4;
            let Some(expected_end) = body_start.checked_add(content_length) else {
                stream.write_all(&json_response(
                    413,
                    json!({"ok": false, "error": "request_too_large"}),
                ))?;
                return Ok(());
            };
            while buffer.len() < expected_end {
                let n = stream.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
            }
            let body_end = expected_end.min(buffer.len());
            let request = parse_request(&header, &buffer[body_start..body_end], peer_ip);
            let response = route(request, app);
            stream.write_all(&response)?;
            return Ok(());
        }

        if buffer.len() > MAX_HTTP_HEADER_BYTES {
            stream.write_all(&json_response(
                413,
                json!({"ok": false, "error": "request_too_large"}),
            ))?;
            return Ok(());
        }
    }

    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> usize {
    header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

fn parse_auth_token(header: &str) -> Option<String> {
    for line in header.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("authorization:") {
            let value = trimmed.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
            if value.len() > 7 && value[..7].eq_ignore_ascii_case("bearer ") {
                let token = value[7..].trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn parse_header_ip(header: &str, name: &str, take_last: bool) -> Option<IpAddr> {
    header.lines().find_map(|line| {
        let (header_name, value) = line.split_once(':')?;
        if !header_name.trim().eq_ignore_ascii_case(name) {
            return None;
        }
        let mut candidates = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if take_last {
            candidates.next_back()?.parse::<IpAddr>().ok()
        } else {
            candidates.next()?.parse::<IpAddr>().ok()
        }
    })
}

fn request_client_ip(header: &str, peer_ip: Option<IpAddr>) -> String {
    let Some(peer_ip) = peer_ip else {
        return "unknown".to_string();
    };
    if !peer_ip.is_loopback() {
        return peer_ip.to_string();
    }

    // The production reverse proxy overwrites X-Real-IP with its TCP peer, so
    // prefer it over client-controlled JSON or a possibly pre-populated XFF chain.
    // For local proxies without X-Real-IP, use the last valid XFF hop because nginx
    // appends the actual peer to that side of the list.
    parse_header_ip(header, "x-real-ip", false)
        .or_else(|| parse_header_ip(header, "x-forwarded-for", true))
        .unwrap_or(peer_ip)
        .to_string()
}

fn parse_request(header: &str, body: &[u8], peer_ip: Option<IpAddr>) -> Request {
    let first = header.lines().next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    Request {
        method,
        path: percent_decode(path),
        query: query.to_string(),
        body: body.to_vec(),
        auth_token: parse_auth_token(header),
        client_ip: request_client_ip(header, peer_ip),
    }
}

fn solver_owner_from_session(session: &Value) -> Option<SolverOwner> {
    let school_id = session
        .get("schoolId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let login_id = session
        .get("userId")
        .or_else(|| session.get("loginId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if school_id.is_empty() && login_id.is_empty() {
        None
    } else {
        Some(SolverOwner::new(school_id, login_id))
    }
}

fn solver_request_owner(app: &App, auth_token: Option<&str>) -> Result<SolverOwner, Vec<u8>> {
    solver_request_owner_with_requirement(
        &app.db,
        auth_token,
        env_flag("TKB_SOLVER_REQUIRE_AUTH", false),
    )
}

const MAX1_CLASS_LIMIT: usize = 39;

#[derive(Clone, Debug, Eq, PartialEq)]
enum SolverPlanPolicy {
    Exempt,
    Free,
    Trial,
    Plus { quota_cycle_id: String },
    Max1,
    Unknown,
}

fn registry_school_by_id<'a>(registry: &'a Value, school_id: &str) -> Option<&'a Value> {
    let school_id = school_id.trim();
    if school_id.is_empty() {
        return None;
    }
    registry
        .get("schools")
        .and_then(Value::as_object)
        .and_then(|schools| {
            schools.iter().find_map(|(id, school)| {
                let recorded_id = school.get("id").and_then(Value::as_str).unwrap_or("");
                (id.eq_ignore_ascii_case(school_id)
                    || recorded_id.eq_ignore_ascii_case(school_id))
                .then_some(school)
            })
        })
}

fn plus_quota_cycle_id(school: &Value) -> String {
    for key in ["plusQuotaCycleId", "expiresAt", "lastPaymentAt"] {
        let value = school
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !value.is_empty() {
            return if key == "plusQuotaCycleId" {
                value.to_string()
            } else {
                format!("legacy-{key}-{value}")
            };
        }
    }
    // Older Plus records may predate billing-cycle metadata. Keep one stable,
    // server-owned pool until Super Admin renews the plan and writes a real
    // cycle ID; never accept a cycle identifier supplied in the solve body.
    "legacy-plus-current".to_string()
}

fn legacy_max_is_max1(school: &Value) -> bool {
    match school
        .get("maxPlanPricingTier")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "under-40-classes" | "max1" => return true,
        "from-40-classes" | "max2" => return false,
        _ => {}
    }
    school
        .get("classCount")
        .and_then(Value::as_u64)
        .is_some_and(|count| (1..40).contains(&count))
}

fn ascii_decimal(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() || bytes.iter().any(|byte| !byte.is_ascii_digit()) {
        return None;
    }
    bytes.iter().try_fold(0_i64, |value, byte| {
        value
            .checked_mul(10)?
            .checked_add(i64::from(byte.saturating_sub(b'0')))
    })
}

fn days_in_month(year: i64, month: i64) -> Option<i64> {
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 => Some(if leap { 29 } else { 28 }),
        _ => None,
    }
}

fn civil_days_since_unix_epoch(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Parses the ISO timestamps written by the browser (`Date#toISOString`) and
/// ordinary RFC3339 offsets without adding a date-time dependency to the API.
/// Invalid legacy values deliberately behave like the browser's `Date.parse`
/// failure and do not expire a plan.
fn plan_expiry_millis(raw: &str) -> Option<u64> {
    let value = raw.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let year = ascii_decimal(&bytes[0..4])?;
    let month = ascii_decimal(&bytes[5..7])?;
    let day = ascii_decimal(&bytes[8..10])?;
    if day < 1 || day > days_in_month(year, month)? {
        return None;
    }

    let mut hour = 0_i64;
    let mut minute = 0_i64;
    let mut second = 0_i64;
    let mut millis = 0_i64;
    let mut offset_seconds = 0_i64;
    if bytes.len() > 10 {
        if !matches!(bytes.get(10), Some(b'T' | b't' | b' ')) || bytes.len() < 16 {
            return None;
        }
        if bytes.get(13) != Some(&b':') {
            return None;
        }
        hour = ascii_decimal(&bytes[11..13])?;
        minute = ascii_decimal(&bytes[14..16])?;
        let mut cursor = 16_usize;
        if bytes.get(cursor) == Some(&b':') {
            if bytes.len() < cursor + 3 {
                return None;
            }
            second = ascii_decimal(&bytes[cursor + 1..cursor + 3])?;
            cursor += 3;
        }
        if bytes.get(cursor) == Some(&b'.') {
            cursor += 1;
            let fraction_start = cursor;
            while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            if cursor == fraction_start {
                return None;
            }
            let mut factor = 100_i64;
            for byte in bytes[fraction_start..cursor].iter().take(3) {
                millis += i64::from(byte.saturating_sub(b'0')) * factor;
                factor /= 10;
            }
        }
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        if cursor < bytes.len() {
            match bytes[cursor] {
                b'Z' | b'z' if cursor + 1 == bytes.len() => {}
                sign @ (b'+' | b'-') if cursor + 6 == bytes.len() => {
                    if bytes.get(cursor + 3) != Some(&b':') {
                        return None;
                    }
                    let offset_hour = ascii_decimal(&bytes[cursor + 1..cursor + 3])?;
                    let offset_minute = ascii_decimal(&bytes[cursor + 4..cursor + 6])?;
                    if offset_hour > 23 || offset_minute > 59 {
                        return None;
                    }
                    let direction = if sign == b'+' { 1 } else { -1 };
                    offset_seconds = direction * (offset_hour * 3_600 + offset_minute * 60);
                }
                _ => return None,
            }
        }
    }

    let seconds = civil_days_since_unix_epoch(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)?
        .checked_sub(offset_seconds)?;
    let total = seconds.checked_mul(1_000)?.checked_add(millis)?;
    Some(total.max(0) as u64)
}

fn school_plan_expired(school: &Value) -> bool {
    school
        .get("expiresAt")
        .and_then(Value::as_str)
        .and_then(plan_expiry_millis)
        .is_some_and(|expires_at| now_millis() > expires_at)
}

fn solver_plan_policy_for_school(school: &Value) -> SolverPlanPolicy {
    let plan = school
        .get("plan")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(plan.as_str(), "free" | "ultra") && school_plan_expired(school) {
        return SolverPlanPolicy::Free;
    }
    match plan.as_str() {
        "free" => SolverPlanPolicy::Free,
        "trial" => SolverPlanPolicy::Trial,
        "plus" => SolverPlanPolicy::Plus {
            quota_cycle_id: plus_quota_cycle_id(school),
        },
        "max1" => SolverPlanPolicy::Max1,
        "max" if legacy_max_is_max1(school) => SolverPlanPolicy::Max1,
        "max" | "max2" | "ultra" => SolverPlanPolicy::Exempt,
        _ => SolverPlanPolicy::Unknown,
    }
}

fn solver_plan_policy(
    app: &App,
    session: Option<&Value>,
    require_auth: bool,
) -> SolverPlanPolicy {
    let Some(session) = session else {
        return if require_auth {
            SolverPlanPolicy::Unknown
        } else {
            SolverPlanPolicy::Exempt
        };
    };
    let role = session
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if role == "superadmin" {
        return SolverPlanPolicy::Exempt;
    }
    if !matches!(role.as_str(), "school_admin" | "school_user") {
        return SolverPlanPolicy::Unknown;
    }
    let school_id = session
        .get("schoolId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if school_id.is_empty() {
        return SolverPlanPolicy::Unknown;
    }
    let registry = auth::load_registry(&app.db);
    registry_school_by_id(&registry, school_id)
        .map(solver_plan_policy_for_school)
        .unwrap_or(SolverPlanPolicy::Unknown)
}

fn solver_plan_policy_for_solve(
    app: &App,
    session: Option<&Value>,
    require_auth: bool,
    body: &[u8],
) -> SolverPlanPolicy {
    let base = solver_plan_policy(app, session, require_auth);
    let Some(session) = session else {
        return base;
    };
    if session
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        != "superadmin"
    {
        return base;
    }

    // Super Admin remains exempt from solve-count quotas, but a planner opened
    // on a registered Max 1 schedule must retain that school's class cap. The
    // body supplies only the store selector; the plan itself is always resolved
    // from the server registry.
    let target_policy = serde_json::from_slice::<Value>(body)
        .ok()
        .as_ref()
        .and_then(|request| solver_schedule_scope(Some(request)))
        .and_then(|store_id| {
            let registry = auth::load_registry(&app.db);
            registry_school_for_store(&registry, session, &store_id)
                .map(solver_plan_policy_for_school)
        });
    if matches!(target_policy, Some(SolverPlanPolicy::Max1)) {
        SolverPlanPolicy::Max1
    } else {
        base
    }
}

fn claim_free_solve(
    app: &App,
    owner: &SolverOwner,
    job_id: &str,
) -> Result<(), Vec<u8>> {
    match app
        .serverless
        .claim_free_solve(owner.school_id(), owner.login_id(), job_id)
    {
        Ok(serverless::FreeSolveAdmission::Claimed { .. }) => Ok(()),
        Ok(serverless::FreeSolveAdmission::Existing { used }) => Err(json_response(
            409,
            json!({
                "ok": false,
                "kind": "free_solve_job_replayed",
                "error": "free_solve_job_replayed",
                "used": used,
                "retryable": false,
                "message": "Lượt xếp này đã được ghi nhận. Vui lòng bấm lại để tạo một lượt mới."
            }),
        )),
        Ok(serverless::FreeSolveAdmission::Exhausted { used }) => Err(json_response(
            429,
            json!({
                "ok": false,
                "kind": "free_solve_quota_exhausted",
                "error": "free_solve_quota_exhausted",
                "limit": serverless::FREE_SOLVE_ACTION_LIMIT,
                "used": used,
                "remaining": 0,
                "retryable": false,
                "message": "Gói Free đã dùng hết 5 lượt Xếp và Tối ưu. Vui lòng nâng cấp để tiếp tục."
            }),
        )),
        Err(error) => Err(json_response(
            503,
            json!({
                "ok": false,
                "kind": "free_solve_quota_unavailable",
                "error": "free_solve_quota_unavailable",
                "retryable": false,
                "message": "Chưa kiểm tra được số lượt Free. Vui lòng thử lại sau.",
                "detail": error.chars().take(240).collect::<String>()
            }),
        )),
    }
}

fn claim_trial_solve(
    app: &App,
    owner: &SolverOwner,
    job_id: &str,
) -> Result<(), Vec<u8>> {
    match app
        .serverless
        .claim_trial_solve(owner.school_id(), owner.login_id(), job_id)
    {
        Ok(serverless::TrialSolveAdmission::Claimed { .. }) => Ok(()),
        Ok(serverless::TrialSolveAdmission::Existing { used }) => Err(json_response(
            409,
            json!({
                "ok": false,
                "kind": "trial_solve_job_replayed",
                "error": "trial_solve_job_replayed",
                "used": used,
                "retryable": false,
                "message": "Lượt xếp này đã được ghi nhận. Vui lòng bấm lại để tạo một lượt mới."
            }),
        )),
        Ok(serverless::TrialSolveAdmission::Exhausted { used }) => Err(json_response(
            429,
            json!({
                "ok": false,
                "kind": "trial_solve_quota_exhausted",
                "error": "trial_solve_quota_exhausted",
                "limit": serverless::TRIAL_SOLVE_ACTION_LIMIT,
                "used": used,
                "remaining": 0,
                "retryable": false,
                "message": "Gói Trial đã dùng hết 50 lượt Xếp và Tối ưu. Vui lòng nâng cấp để tiếp tục."
            }),
        )),
        Err(error) => Err(json_response(
            503,
            json!({
                "ok": false,
                "kind": "trial_solve_quota_unavailable",
                "error": "trial_solve_quota_unavailable",
                "retryable": false,
                "message": "Chưa kiểm tra được số lượt Trial. Vui lòng thử lại sau.",
                "detail": error.chars().take(240).collect::<String>()
            }),
        )),
    }
}

fn claim_plus_solve(
    app: &App,
    owner: &SolverOwner,
    quota_cycle_id: &str,
    job_id: &str,
) -> Result<(), Vec<u8>> {
    match app.serverless.claim_plus_solve(
        owner.school_id(),
        owner.login_id(),
        quota_cycle_id,
        job_id,
    ) {
        Ok(serverless::PlusSolveAdmission::Claimed { .. }) => Ok(()),
        Ok(serverless::PlusSolveAdmission::Existing { used }) => Err(json_response(
            409,
            json!({
                "ok": false,
                "kind": "plus_solve_job_replayed",
                "error": "plus_solve_job_replayed",
                "used": used,
                "retryable": false,
                "message": "Lượt xếp này đã được ghi nhận. Vui lòng bấm lại để tạo một lượt mới."
            }),
        )),
        Ok(serverless::PlusSolveAdmission::Exhausted { used }) => Err(json_response(
            429,
            json!({
                "ok": false,
                "kind": "plus_solve_quota_exhausted",
                "error": "plus_solve_quota_exhausted",
                "limit": serverless::PLUS_SOLVE_ACTION_LIMIT,
                "used": used,
                "remaining": 0,
                "retryable": false,
                "message": "Gói Plus đã dùng hết 100 lượt Xếp và Tối ưu trong kỳ hiện tại. Vui lòng gia hạn hoặc nâng cấp để tiếp tục."
            }),
        )),
        Err(error) => Err(json_response(
            503,
            json!({
                "ok": false,
                "kind": "plus_solve_quota_unavailable",
                "error": "plus_solve_quota_unavailable",
                "retryable": false,
                "message": "Chưa kiểm tra được số lượt Plus. Vui lòng thử lại sau.",
                "detail": error.chars().take(240).collect::<String>()
            }),
        )),
    }
}

fn claim_plan_solve(
    app: &App,
    owner: &SolverOwner,
    job_id: &str,
    policy: &SolverPlanPolicy,
) -> Result<(), Vec<u8>> {
    match policy {
        SolverPlanPolicy::Free => claim_free_solve(app, owner, job_id),
        SolverPlanPolicy::Trial => claim_trial_solve(app, owner, job_id),
        SolverPlanPolicy::Plus { quota_cycle_id } => {
            claim_plus_solve(app, owner, quota_cycle_id, job_id)
        }
        SolverPlanPolicy::Exempt | SolverPlanPolicy::Max1 => Ok(()),
        SolverPlanPolicy::Unknown => Err(json_response(
            503,
            json!({
                "ok": false,
                "kind": "solver_plan_unavailable",
                "error": "solver_plan_unavailable",
                "retryable": false
            }),
        )),
    }
}

struct SolvePlanClaimGuard<'a> {
    app: &'a App,
    owner: &'a SolverOwner,
    job_id: &'a str,
    policy: &'a SolverPlanPolicy,
    accepted: bool,
}

impl<'a> SolvePlanClaimGuard<'a> {
    fn new(
        app: &'a App,
        owner: &'a SolverOwner,
        job_id: &'a str,
        policy: &'a SolverPlanPolicy,
    ) -> Self {
        Self {
            app,
            owner,
            job_id,
            policy,
            accepted: false,
        }
    }

    fn accept(&mut self) {
        self.accepted = true;
    }
}

impl Drop for SolvePlanClaimGuard<'_> {
    fn drop(&mut self) {
        if self.accepted {
            return;
        }
        let released = match self.policy {
            SolverPlanPolicy::Free => self.app.serverless.release_free_solve_claim(
                self.owner.school_id(),
                self.owner.login_id(),
                self.job_id,
            ),
            SolverPlanPolicy::Trial => self.app.serverless.release_trial_solve_claim(
                self.owner.school_id(),
                self.owner.login_id(),
                self.job_id,
            ),
            SolverPlanPolicy::Plus { quota_cycle_id } => {
                self.app.serverless.release_plus_solve_claim(
                    self.owner.school_id(),
                    self.owner.login_id(),
                    quota_cycle_id,
                    self.job_id,
                )
            }
            SolverPlanPolicy::Exempt | SolverPlanPolicy::Max1 | SolverPlanPolicy::Unknown => {
                return
            }
        };
        if let Err(error) = released {
            eprintln!(
                "solver quota pre-admission claim release failed for {}: {}",
                self.job_id, error
            );
        }
    }
}

fn accept_solve_plan_claim(claim: &mut Option<SolvePlanClaimGuard<'_>>) {
    if let Some(claim) = claim.as_mut() {
        claim.accept();
    }
}

fn class_count_from_school_data(value: &Value) -> Option<usize> {
    value
        .get("lop")
        .and_then(Value::as_array)
        .map(Vec::len)
}

fn class_count_from_solve_request(value: &Value) -> Option<usize> {
    value.get("data").and_then(class_count_from_school_data)
}

fn max1_class_limit_response(class_count: usize) -> Vec<u8> {
    json_response(
        409,
        json!({
            "ok": false,
            "kind": "max1_class_limit_exceeded",
            "error": "max1_class_limit_exceeded",
            "limit": MAX1_CLASS_LIMIT,
            "classCount": class_count,
            "upgradePlan": "max2",
            "retryable": false,
            "message": "Gói Max 1 hỗ trợ tối đa 39 lớp. Vui lòng nâng cấp Max 2 để tạo hoặc import từ 40 lớp."
        }),
    )
}

fn school_plan_unavailable_response() -> Vec<u8> {
    json_response(
        503,
        json!({
            "ok": false,
            "kind": "school_plan_unavailable",
            "error": "school_plan_unavailable",
            "retryable": false,
            "message": "Chưa xác định được gói dịch vụ của trường. Vui lòng tải lại trang hoặc liên hệ quản trị viên."
        }),
    )
}

fn solver_request_owner_with_requirement(
    db: &db::Db,
    auth_token: Option<&str>,
    require_auth: bool,
) -> Result<SolverOwner, Vec<u8>> {
    if !require_auth {
        return Ok(SolverOwner::anonymous());
    }
    let Some(session) = auth::require_session(db, auth_token) else {
        return Err(auth::unauthorized_response());
    };
    solver_owner_from_session(&session).ok_or_else(auth::forbidden_response)
}

fn with_solver_owner<F>(app: &App, auth_token: Option<&str>, handler: F) -> Vec<u8>
where
    F: FnOnce(&SolverOwner) -> Vec<u8>,
{
    match solver_request_owner(app, auth_token) {
        Ok(owner) => handler(&owner),
        Err(response) => response,
    }
}

fn require_infrastructure_admin(app: &App, auth_token: Option<&str>) -> Result<Value, Vec<u8>> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return Err(auth::unauthorized_response());
    };
    // Infrastructure configuration, Cloud Run profiles and Google billing
    // telemetry are Super Admin-only. School accounts must never be able to
    // inspect or mutate this control plane; their solve requests use the
    // policy selected here without exposing its internals in the portal.
    if session.get("role").and_then(Value::as_str) != Some("superadmin") {
        return Err(auth::forbidden_response());
    }
    Ok(session)
}

fn scoped_google_cloud_usage(app: &App) -> Value {
    let snapshot = google_cloud_usage::snapshot_for_superadmin(&app.root);
    let config = app.serverless.config();
    match config.selected_profile() {
        Some(profile) => google_cloud_usage::enforce_profile_scope(
            snapshot,
            &profile.project_id,
            &profile.region,
            &profile.url,
        ),
        None => snapshot,
    }
}

fn serverless_infrastructure_get_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    match require_infrastructure_admin(app, auth_token) {
        Ok(_) => {}
        Err(response) => return response,
    }
    let config = app.serverless.config();
    let selected_profile = config.selected_profile();
    let google_cloud = scoped_google_cloud_usage(app);
    let mut response = json!({
        "ok": true,
        "config": config.public_value(),
        "configured": selected_profile.is_some(),
        "selectedProfileId": selected_profile.as_ref().map(|profile| profile.id.as_str()),
        "effectiveMode": if selected_profile.is_some() || config.mode == RoutingMode::ServerlessOnly {
            config.mode.as_str()
        } else {
            RoutingMode::VpsOnly.as_str()
        },
        "usage": app.serverless.usage_json(),
        "scope": "global",
        "scopeSchoolId": Value::Null,
        "canManageProfiles": true,
        "credentialStorage": "google-adc-environment-only"
    });
    response["googleCloud"] = google_cloud.clone();
    response["billingReconciled"] = json!(google_cloud_usage::billing_reconciled(&google_cloud));
    json_response(200, response)
}

fn serverless_infrastructure_write_json(
    app: &App,
    auth_token: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    match require_infrastructure_admin(app, auth_token) {
        Ok(_) => {}
        Err(response) => return response,
    }
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => {
            return json_response(
                400,
                json!({"ok": false, "kind": "serverless_config_invalid", "error": "serverless_config_invalid"}),
            )
        }
    };
    let update = app.serverless.set_config(&value);
    match update {
        Ok(config) => json_response(
            200,
            json!({
                "ok": true,
                "config": config.public_value(),
                "usage": app.serverless.usage_json(),
                "scope": "global",
                "scopeSchoolId": Value::Null,
                "canManageProfiles": true
            }),
        ),
        Err(error) => json_response(
            400,
            json!({
                "ok": false,
                "kind": "serverless_config_invalid",
                "error": "serverless_config_invalid",
                "detail": error.chars().take(240).collect::<String>()
            }),
        ),
    }
}

fn serverless_usage_get_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    match require_infrastructure_admin(app, auth_token) {
        Ok(_) => {}
        Err(response) => return response,
    }
    let mut response = json!({
        "ok": true,
        "usage": app.serverless.usage_json(),
        "billingReconciled": false
    });
    let google_cloud = scoped_google_cloud_usage(app);
    let reconciled = google_cloud_usage::billing_reconciled(&google_cloud);
    response["billingReconciled"] = json!(reconciled);
    response["googleCloud"] = google_cloud;
    json_response(200, response)
}

fn serverless_usage_refresh_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    match require_infrastructure_admin(app, auth_token) {
        Ok(_) => {}
        Err(response) => return response,
    }
    let requested_at_ms = now_millis();
    if let Err(error) = google_cloud_usage::request_refresh(&app.root, requested_at_ms) {
        return json_response(
            503,
            json!({
                "ok": false,
                "kind": error,
                "error": error,
                "message": "Không gửi được yêu cầu đồng bộ Google Cloud."
            }),
        );
    }
    json_response(
        202,
        json!({
            "ok": true,
            "refreshRequested": true,
            "refreshRequestedAtMs": requested_at_ms,
            "googleCloud": scoped_google_cloud_usage(app)
        }),
    )
}

/// Returns privacy-safe solver telemetry only to Super Admin.  The telemetry
/// module returns aggregates; it never exposes timetable/request/account/
/// school/event identifiers or raw solver errors through this route.
fn solver_telemetry_get_json(app: &App, auth_token: Option<&str>, query: &str) -> Vec<u8> {
    match require_infrastructure_admin(app, auth_token) {
        Ok(_) => {}
        Err(response) => return response,
    }
    let window = query_param(query, "window").unwrap_or_else(|| "24h".to_string());
    match solver_telemetry::aggregate_for_window(&app.db, &window) {
        Ok(payload) => json_response(200, payload),
        Err(solver_telemetry::TelemetryError::Invalid) => json_response(
            400,
            json!({
                "ok": false,
                "kind": "solver_telemetry_window_invalid",
                "error": "solver_telemetry_window_invalid",
                "allowedWindows": ["24h", "7d", "30d"]
            }),
        ),
        Err(error) => json_response(
            503,
            json!({
                "ok": false,
                "kind": error.kind(),
                "error": error.kind()
            }),
        ),
    }
}

/// Browser FET telemetry is a small, session-authenticated terminal event.
/// The only accepted body fields are enforced inside `solver_telemetry`; in
/// particular this endpoint cannot become a path for a raw TKB, IDs or errors.
fn fet_solver_telemetry_post_json(
    app: &App,
    auth_token: Option<&str>,
    client_ip: &str,
    body: &[u8],
) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !auth::can_read_registry(&session) {
        return auth::forbidden_response();
    }
    let Some(token) = auth_token.filter(|token| !token.trim().is_empty()) else {
        return auth::unauthorized_response();
    };
    match solver_telemetry::record_browser_fet_event(&app.db, token, client_ip, body) {
        Ok(inserted) => json_response(
            200,
            json!({
                "ok": true,
                "accepted": inserted,
                "duplicate": !inserted,
                "executor": "fet_web_worker"
            }),
        ),
        Err(solver_telemetry::TelemetryError::TooLarge) => json_response(
            413,
            json!({
                "ok": false,
                "kind": "solver_telemetry_too_large",
                "error": "solver_telemetry_too_large"
            }),
        ),
        Err(solver_telemetry::TelemetryError::Invalid) => json_response(
            400,
            json!({
                "ok": false,
                "kind": "solver_telemetry_invalid",
                "error": "solver_telemetry_invalid"
            }),
        ),
        Err(solver_telemetry::TelemetryError::RateLimited) => json_response(
            429,
            json!({
                "ok": false,
                "kind": "solver_telemetry_rate_limited",
                "error": "solver_telemetry_rate_limited",
                "retryAfterSeconds": 3600
            }),
        ),
        Err(error) => json_response(
            503,
            json!({
                "ok": false,
                "kind": error.kind(),
                "error": error.kind()
            }),
        ),
    }
}

fn cloud_solver_stop_probe_json(app: &App, body: &[u8]) -> Vec<u8> {
    let parsed = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let job_id = parsed
        .get("jobId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let token = parsed
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let wait_ms = parsed
        .get("waitMs")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(CLOUD_STOP_PROBE_MAX_WAIT_MS);
    if job_id.is_empty() || job_id.len() > 512 || token.len() != 64 {
        return json_response(404, json!({"ok": false, "error": "stop_probe_not_found"}));
    }

    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    loop {
        let registration = cloud_stop_probes()
            .lock()
            .ok()
            .and_then(|probes| probes.get(job_id).cloned());
        let Some(registration) = registration else {
            return json_response(
                404,
                json!({"ok": false, "error": "stop_probe_not_found"}),
            );
        };
        if registration.expires_at_ms < now_millis()
            || !constant_time_ascii_equal(&registration.token, token)
        {
            return json_response(
                404,
                json!({"ok": false, "error": "stop_probe_not_found"}),
            );
        }

        let snapshot = app
            .solver_pool
            .server_execution_snapshot(job_id, &registration.owner);
        let best_effort_stop_requested = snapshot
            .as_ref()
            .is_some_and(|value| value.best_effort_stop_requested);
        let cancel_requested = snapshot.is_none()
            || app
                .solver_pool
                .server_job_cancel_requested(job_id, &registration.owner);
        if best_effort_stop_requested || cancel_requested || Instant::now() >= deadline {
            return json_response(
                200,
                json!({
                    "ok": true,
                    "known": snapshot.is_some(),
                    "stopRequested": best_effort_stop_requested,
                    "cancelRequested": cancel_requested,
                    "jobId": job_id
                }),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn route(req: Request, app: &App) -> Vec<u8> {
    if req.method == "GET" {
        if let Some(location) = canonical_page_redirect(&req.path, &req.query) {
            return redirect_response(308, &location);
        }
        if let Some(file_path) = clean_page_file(&req.path) {
            return static_file(app, file_path);
        }
    }

    if req.method == "POST" && req.path.starts_with("/api/agent-helper/v1/leases/") {
        return agent_helper_lease_action_json(
            app,
            &req.path,
            req.auth_token.as_deref(),
            &req.body,
        );
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/health") => health_json(app),
        ("GET", "/api/version") => json_response(
            200,
            json!({"app": "tkb_new", "api": "rust", "version": VERSION}),
        ),
        ("GET", "/api/sample-data") => sample_data_json(app),
        ("POST", "/api/internal/solver-stop-probe") => {
            cloud_solver_stop_probe_json(app, &req.body)
        }
        ("GET", "/api/solver-state") => {
            with_solver_owner(app, req.auth_token.as_deref(), |owner| {
                solver_state_json(app, &req.query, owner)
            })
        }
        ("GET", "/api/admin/solver-infrastructure") => {
            serverless_infrastructure_get_json(app, req.auth_token.as_deref())
        }
        ("POST", "/api/admin/solver-infrastructure")
        | ("PATCH", "/api/admin/solver-infrastructure") => serverless_infrastructure_write_json(
            app,
            req.auth_token.as_deref(),
            &req.body,
        ),
        ("GET", "/api/admin/solver-usage") => {
            serverless_usage_get_json(app, req.auth_token.as_deref())
        }
        ("POST", "/api/admin/solver-usage/refresh") => {
            serverless_usage_refresh_json(app, req.auth_token.as_deref())
        }
        ("GET", "/api/admin/solver-telemetry") => {
            solver_telemetry_get_json(app, req.auth_token.as_deref(), &req.query)
        }
        ("POST", "/api/solver-telemetry/fet") => fet_solver_telemetry_post_json(
            app,
            req.auth_token.as_deref(),
            &req.client_ip,
            &req.body,
        ),
        ("GET", "/api/solve-result") => {
            with_solver_owner(app, req.auth_token.as_deref(), |owner| {
                solve_result_json(app, &req.query, owner)
            })
        }
        ("GET", "/api/agent-helper/v1/status") => {
            agent_helper_status_json(app, &req.query, req.auth_token.as_deref())
        }
        ("POST", "/api/solve-cancel") => {
            with_solver_owner(app, req.auth_token.as_deref(), |owner| {
                solve_cancel_json(app, &req.body, owner)
            })
        }
        ("POST", "/api/solve-precheck") => {
            with_solver_owner(app, req.auth_token.as_deref(), |_| {
                native_solve_precheck(&req.body)
            })
        }
        ("POST", "/api/solve-data") => {
            let session = auth::require_session(&app.db, req.auth_token.as_deref());
            let agent_allowed = session
                .as_ref()
                .is_some_and(auth::can_write_registry);
            let plan_policy = solver_plan_policy_for_solve(
                app,
                session.as_ref(),
                env_flag("TKB_SOLVER_REQUIRE_AUTH", false),
                &req.body,
            );
            with_solver_owner(app, req.auth_token.as_deref(), |owner| {
                solve_json_with_agent_permission(
                    app,
                    &req.body,
                    owner,
                    agent_allowed,
                    plan_policy,
                )
            })
        }
        ("POST", "/api/agent-helper/v1/bootstrap") => {
            agent_helper_bootstrap_json(app, req.auth_token.as_deref())
        }
        ("POST", "/api/agent-helper/v1/pair/start") => agent_pair_start_json(app, &req.body),
        ("POST", "/api/agent-helper/v1/pair/approve") => {
            agent_pair_approve_json(app, req.auth_token.as_deref(), &req.body)
        }
        ("POST", "/api/agent-helper/v1/pair/status") => agent_pair_status_json(app, &req.body),
        ("POST", "/api/agent-helper/v1/hello") => {
            agent_helper_hello_json(app, req.auth_token.as_deref(), &req.body)
        }
        ("POST", "/api/agent-helper/v1/heartbeat") => {
            agent_helper_heartbeat_json(app, req.auth_token.as_deref(), &req.body)
        }
        ("POST", "/api/agent-helper/v1/disconnect") => {
            agent_helper_disconnect_json(app, req.auth_token.as_deref(), &req.body)
        }
        ("POST", "/api/agent-helper/v1/lease") => {
            agent_helper_claim_json(app, req.auth_token.as_deref(), &req.body)
        }
        ("POST", "/api/export/tkb-class-docx") => export_tkb_class_docx_json(&req.query, &req.body),
        ("POST", "/api/export/tkb-class-xlsx") => export_tkb_class_xlsx_json(&req.query, &req.body),
        ("POST", "/api/auth/login") => auth::login_json(&app.db, &req.body, &req.client_ip),
        ("POST", "/api/auth/logout") => {
            auth::logout_json(&app.db, req.auth_token.as_deref(), &req.body)
        }
        ("POST", "/api/auth/register") => auth::register_json(&app.db, &req.body, &req.client_ip),
        ("POST", "/api/auth/hash-password") => {
            auth::hash_password_json(&app.db, req.auth_token.as_deref(), &req.body)
        }
        ("GET", "/api/auth/session") => {
            auth_session_get_json(app, &req.query, req.auth_token.as_deref())
        }
        ("GET", "/api/auth/registry") => auth_registry_get_json(app, req.auth_token.as_deref()),
        ("POST", "/api/auth/registry") => {
            auth_registry_post_json(app, req.auth_token.as_deref(), &req.body)
        }
        ("GET", "/api/school/store") => {
            school_store_get_json(app, &req.query, req.auth_token.as_deref())
        }
        ("POST", "/api/school/store") => {
            school_store_post_json(app, &req.query, req.auth_token.as_deref(), &req.body)
        }
        ("OPTIONS", _) => http_response(204, "text/plain; charset=utf-8", &[]),
        ("GET", "/") => static_file(app, "/index.html"),
        ("GET", "/e2e/bootstrap") => e2e_removed_json(&req.query),
        ("GET", path) => static_file(app, path),
        _ => json_response(404, json!({"ok": false, "error": "not_found"})),
    }
}

struct AgentHelperContext {
    owner: SolverOwner,
    session_binding: String,
    trusted_global: bool,
}

fn trusted_agent_token_digest(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"tkb-trusted-agent-token-v1\0");
    hasher.update(token.trim().as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_ascii_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (*left ^ *right)
        })
        == 0
}

fn trusted_agent_token_matches(configured_hash: Option<&str>, token: &str) -> bool {
    let token = token.trim();
    if !token.starts_with(TRUSTED_AGENT_TOKEN_PREFIX)
        || token.len() < TRUSTED_AGENT_TOKEN_PREFIX.len() + 32
        || token.len() > 512
    {
        return false;
    }
    let configured = configured_hash
        .map(str::trim)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    let Some(configured) = configured else {
        return false;
    };
    constant_time_ascii_equal(&configured, &trusted_agent_token_digest(token))
}

fn session_can_manage_agent(app: &App, session: &Value) -> bool {
    if auth::can_write_registry(session) {
        return true;
    }
    // Durable Agent credentials intentionally are not full browser sessions.
    // Resolve their owner against the current registry so credentials minted
    // before this policy change are accepted only for an admin account.
    let user_id = session
        .get("userId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if user_id.is_empty() {
        return false;
    }
    auth::load_registry(&app.db)
        .get("users")
        .and_then(Value::as_object)
        .is_some_and(|users| {
            users.iter().any(|(key, user)| {
                (key.eq_ignore_ascii_case(user_id)
                    || user
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.eq_ignore_ascii_case(user_id)))
                    && matches!(
                        user.get("role").and_then(Value::as_str),
                        Some("superadmin") | Some("school_admin")
                    )
            })
        })
}

fn agent_helper_context(
    app: &App,
    auth_token: Option<&str>,
) -> Result<AgentHelperContext, Vec<u8>> {
    let token = auth_token.map(str::trim).filter(|value| !value.is_empty());
    let configured_trusted_hash = env::var(TRUSTED_AGENT_TOKEN_HASH_ENV).ok();
    if token
        .is_some_and(|token| trusted_agent_token_matches(configured_trusted_hash.as_deref(), token))
    {
        let token = token.unwrap_or_default();
        return Ok(AgentHelperContext {
            owner: SolverOwner::new("operator-infrastructure", "trusted-worker"),
            session_binding: agent_session_binding(token),
            trusted_global: true,
        });
    }
    let Some(session) = auth::require_session(&app.db, token)
        .or_else(|| auth::require_agent_credential(&app.db, token))
    else {
        return Err(auth::unauthorized_response());
    };
    if !session_can_manage_agent(app, &session) {
        return Err(auth::forbidden_response());
    }
    let owner = solver_owner_from_session(&session).ok_or_else(auth::forbidden_response)?;
    Ok(AgentHelperContext {
        owner,
        session_binding: agent_session_binding(token.unwrap_or_default()),
        trusted_global: false,
    })
}

fn agent_helper_bootstrap_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    // Only a live browser session may mint an Agent credential. Agent
    // credentials themselves cannot mint more credentials or access any
    // non-Agent API.
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !session_can_manage_agent(app, &session)
        || solver_owner_from_session(&session).is_none()
    {
        return auth::forbidden_response();
    }
    let Some((credential, expires_at)) = auth::create_agent_credential(&app.db, &session) else {
        return json_response(
            500,
            json!({"ok":false,"error":"agent_credential_create_failed"}),
        );
    };
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "agentToken": credential,
            "expiresAt": expires_at,
            "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip",
            "installFileName": "TKBCherryAgent-Windows.zip"
        }),
    )
}

fn agent_helper_status_json(app: &App, query: &str, auth_token: Option<&str>) -> Vec<u8> {
    // This is deliberately a browser-session endpoint. It exposes only an
    // owner-scoped count and an optional non-secret paired Agent ID; credentials
    // and worker tokens are never returned.
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !session_can_manage_agent(app, &session) {
        return auth::forbidden_response();
    }
    let Some(owner) = solver_owner_from_session(&session) else {
        return auth::forbidden_response();
    };
    let checked_at_ms = now_millis();
    let requested_agent_id = query_param(query, "agentId")
        .filter(|value| !value.trim().is_empty());
    let (native_agent_count, native_state, matched_agent_id, native_telemetry) = app
        .agent_helper
        .native_worker_status_for_id(&owner, requested_agent_id.as_deref(), checked_at_ms);
    let browser_agent_count = app
        .agent_helper
        .online_worker_counts(&owner, checked_at_ms)
        .1;
    let agent_count = native_agent_count + browser_agent_count;
    let active_execution = app
        .solver_pool
        .server_job_snapshots_for_owner(&owner)
        .into_iter()
        .find(|job| job.completed_ms.is_none() && job.execution_phase.executor().is_some());
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "online": agent_count > 0,
            "agentCount": agent_count,
            "nativeOnline": native_agent_count > 0,
            "nativeAgentCount": native_agent_count,
            "nativeRunning": native_state.is_running(),
            "nativeState": native_state.as_str(),
            "agentId": matched_agent_id,
            "browserOnline": browser_agent_count > 0,
            "browserAgentCount": browser_agent_count,
            "executionSource": active_execution
                .as_ref()
                .and_then(|job| job.execution_phase.executor())
                .map(ServerExecutor::as_str),
            "executionPhase": active_execution
                .as_ref()
                .map(|job| job.execution_phase.as_str()),
            "nativeTelemetry": native_telemetry.map(|sample| json!({
                "systemCpuPercent": sample.system_cpu_tenths
                    .map(|value| f64::from(value) / 10.0),
                "systemRamPercent": sample.system_ram_tenths
                    .map(|value| f64::from(value) / 10.0),
                "sampledAtMs": sample.sampled_at_ms,
                "sampleAgeMs": checked_at_ms.saturating_sub(sample.sampled_at_ms)
            })),
            "checkedAtMs": checked_at_ms,
            "staleAfterMs": agent_helper::AGENT_WORKER_TTL_MS
        }),
    )
}

fn agent_pair_error_json(error: AgentPairError) -> Vec<u8> {
    let status = match error {
        AgentPairError::InvalidRequest => 400,
        AgentPairError::Capacity => 429,
        AgentPairError::NotFound => 404,
        AgentPairError::Expired => 410,
        AgentPairError::AlreadyApproved | AgentPairError::ApprovalMismatch => 409,
    };
    json_response(
        status,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": false,
            "kind": error.kind(),
            "error": error.kind()
        }),
    )
}

fn agent_pair_start_json(app: &App, body: &[u8]) -> Vec<u8> {
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(agent) = body.get("agent").and_then(Value::as_object) else {
        return agent_pair_error_json(AgentPairError::InvalidRequest);
    };
    let agent_id = agent
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let explicit_name = agent
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let generated_name = format!(
        "{} {}",
        agent
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
        agent
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
    );
    let agent_name = if explicit_name.is_empty() {
        generated_name.trim()
    } else {
        explicit_name
    };
    match app
        .agent_helper
        .start_pairing(agent_id, agent_name, now_millis())
    {
        Ok(pairing) => {
            let approval_url = format!("/pages/sapxep?agentPair={}", pairing.user_code);
            json_response(
                200,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": true,
                    "status": "pending",
                    "deviceCode": pairing.device_code,
                    "userCode": pairing.user_code,
                    "agentId": pairing.agent_id,
                    "agentName": pairing.agent_name,
                    "approvalUrl": approval_url,
                    "verificationUrl": approval_url,
                    "verificationUri": "/pages/sapxep",
                    "verificationUriComplete": approval_url,
                    "expiresAtMs": pairing.expires_at_ms,
                    "pollEveryMs": pairing.poll_every_ms
                }),
            )
        }
        Err(error) => agent_pair_error_json(error),
    }
}

fn agent_pair_approve_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    // Pair approval is a browser action. A durable Agent credential must never
    // approve another device, even though it is accepted by Agent work routes.
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !session_can_manage_agent(app, &session) {
        return auth::forbidden_response();
    }
    let Some(owner) = solver_owner_from_session(&session) else {
        return auth::forbidden_response();
    };
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let user_code = body
        .get("userCode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let now_ms = now_millis();
    let ticket = match app
        .agent_helper
        .begin_pair_approval(user_code, &owner, now_ms)
    {
        Ok(ticket) => ticket,
        Err(error) => return agent_pair_error_json(error),
    };
    let Some((agent_token, agent_token_expires_at)) =
        auth::create_agent_credential(&app.db, &session)
    else {
        app.agent_helper
            .abort_pair_approval(&ticket, &owner, now_millis());
        return json_response(
            500,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "agent_credential_create_failed",
                "error": "agent_credential_create_failed"
            }),
        );
    };
    if let Err(error) = app.agent_helper.complete_pair_approval(
        &ticket,
        &owner,
        &agent_token,
        agent_token_expires_at,
        now_millis(),
    ) {
        return agent_pair_error_json(error);
    }
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "status": "approved",
            "agentId": ticket.agent_id,
            "agentName": ticket.agent_name,
            "expiresAtMs": ticket.expires_at_ms
        }),
    )
}

fn agent_pair_status_json(app: &App, body: &[u8]) -> Vec<u8> {
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let device_code = body
        .get("deviceCode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match app.agent_helper.pairing_status(device_code, now_millis()) {
        Ok(AgentPairStatus::Pending {
            expires_at_ms,
            poll_every_ms,
        }) => json_response(
            200,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": true,
                "status": "pending",
                "expiresAtMs": expires_at_ms,
                "retryAfterMs": poll_every_ms
            }),
        ),
        Ok(AgentPairStatus::Approved {
            agent_token,
            agent_token_expires_at,
            expires_at_ms,
        }) => json_response(
            200,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": true,
                "status": "approved",
                "agentToken": agent_token,
                "agentTokenExpiresAt": agent_token_expires_at,
                "expiresAtMs": expires_at_ms
            }),
        ),
        Err(error) => agent_pair_error_json(error),
    }
}

fn agent_helper_body(body: &[u8]) -> Result<Value, Vec<u8>> {
    let value = serde_json::from_slice::<Value>(body).map_err(|_| {
        json_response(
            400,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "agent_request_invalid",
                "error": "agent_request_invalid"
            }),
        )
    })?;
    if !value.is_object()
        || value.get("protocol").and_then(Value::as_str) != Some(AGENT_HELPER_PROTOCOL)
    {
        return Err(json_response(
            400,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "agent_protocol_invalid",
                "error": "agent_protocol_invalid"
            }),
        ));
    }
    Ok(value)
}

fn agent_helper_worker_token(body: &Value) -> Result<String, Vec<u8>> {
    body.get("workerToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
        .ok_or_else(|| {
            json_response(
                401,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": false,
                    "kind": "agent_worker_token_required",
                    "error": "agent_worker_token_required"
                }),
            )
        })
}

fn agent_helper_error_json(error: AgentHelperError) -> Vec<u8> {
    let status = match error {
        AgentHelperError::InvalidWorker | AgentHelperError::InvalidLeaseRequest => 400,
        AgentHelperError::UnauthorizedWorker => 401,
        AgentHelperError::WorkerCapacity | AgentHelperError::WorkerAtCapacity => 429,
        AgentHelperError::JobNotFound => 404,
        AgentHelperError::NoWork => 200,
        AgentHelperError::LeaseExpired | AgentHelperError::WorkAlreadyCompleted => 410,
        AgentHelperError::LeaseNotFound => 409,
    };
    json_response(
        status,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": false,
            "kind": error.kind(),
            "error": error.kind()
        }),
    )
}

fn agent_helper_capacity(body: &Value) -> usize {
    body.get("capacity")
        .and_then(|value| value.get("cpuWorkers"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(1)
        .max(1)
}

fn agent_helper_resource_telemetry(body: &Value) -> Option<AgentResourceTelemetry> {
    let telemetry = body.get("telemetry")?.as_object()?;
    let percent_tenths = |key: &str| {
        let value = telemetry.get(key)?.as_f64()?;
        (value.is_finite() && (0.0..=100.0).contains(&value)).then(|| (value * 10.0).round() as u16)
    };
    let resource = AgentResourceTelemetry {
        system_cpu_tenths: percent_tenths("systemCpuPercent"),
        system_ram_tenths: percent_tenths("systemRamPercent"),
    };
    (resource.system_cpu_tenths.is_some() || resource.system_ram_tenths.is_some())
        .then_some(resource)
}

fn agent_request_workload_periods(request: &Value) -> u64 {
    let mut maximum = 0_u64;
    let settings = request_settings(request);
    if let Some(items) = settings {
        maximum = maximum.max(
            items
                .get("expected_scheduled_periods")
                .and_then(value_as_positive_u64)
                .unwrap_or_default(),
        );
        let progress_focus = setting_string(settings, "ui_progress_metric_focus")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .replace('-', "_")
            .replace(' ', "_");
        if progress_focus == "scheduled_periods" {
            for key in [
                "ui_progress_metric_target",
                "ui_progress_metric_baseline",
                "ui_progress_metric_current",
            ] {
                maximum = maximum.max(
                    items
                        .get(key)
                        .and_then(value_as_positive_u64)
                        .unwrap_or_default(),
                );
            }
        }
    }

    let Some(data) = request.get("data").and_then(Value::as_object) else {
        return maximum;
    };
    for result_key in ["tkbSolverResult", "tkbRustSolverResult"] {
        let Some(result) = data.get(result_key).and_then(Value::as_object) else {
            continue;
        };
        if let Some(metrics) = result.get("metrics").and_then(Value::as_object) {
            maximum = maximum.max(
                metrics
                    .get("expected_periods")
                    .and_then(value_as_positive_u64)
                    .unwrap_or_default(),
            );
            let scheduled = metrics
                .get("scheduled_periods")
                .and_then(value_as_positive_u64)
                .unwrap_or_default();
            let unassigned = metrics
                .get("unassigned_periods")
                .and_then(value_as_positive_u64)
                .unwrap_or_default();
            maximum = maximum.max(scheduled.saturating_add(unassigned));
        }
        maximum = maximum.max(
            result
                .get("lessons")
                .and_then(Value::as_array)
                .and_then(|lessons| u64::try_from(lessons.len()).ok())
                .unwrap_or_default(),
        );
    }
    maximum.max(expected_periods_from_request(request).max(0) as u64)
}

fn adaptive_agent_worker_count(request: &Value, permitted_workers: usize) -> usize {
    let permitted_workers = permitted_workers.clamp(1, 64);
    let settings = request_settings(request);
    let optimization_focus = setting_string(settings, "optimization_focus")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let workload = agent_request_workload_periods(request);
    // CP-SAT portfolios stop scaling linearly once each worker has too little
    // useful search time. These measured tiers match Browser/native execution;
    // the VPS pool keeps its separately allocated width.
    let recommended = if matches!(
        optimization_focus.as_str(),
        "quick" | "complete" | "quick_complete"
    ) {
        match workload {
            0 => 4,
            1..=128 => 1,
            129..=512 => 2,
            513..=2_000 => 4,
            _ => 8,
        }
    } else {
        match workload {
            0 => 6,
            1..=128 => 2,
            129..=512 => 4,
            513..=2_000 => 6,
            2_001..=4_000 => 8,
            _ => 12,
        }
    };
    permitted_workers.min(recommended)
}

fn agent_helper_parallel(body: &Value) -> usize {
    body.get("capacity")
        .and_then(|value| value.get("maxConcurrentJobs"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(1)
        .clamp(1, 8)
}

fn parse_agent_helper_semver(value: &str) -> Option<(u32, u32, u32)> {
    let value = value.trim();
    if value.is_empty() || value.len() > 32 {
        return None;
    }
    let mut parts = value.split('.');
    let mut next = || {
        let part = parts.next()?;
        if part.is_empty()
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        part.parse::<u32>().ok()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

fn agent_helper_version_supported(version: &str) -> bool {
    parse_agent_helper_semver(version).is_some_and(|version| version >= MIN_AGENT_HELPER_SEMVER)
}

fn agent_helper_browser_platform(platform: &str) -> bool {
    matches!(
        platform.trim().to_ascii_lowercase().as_str(),
        "web-wasm" | "web-cpsat-wasm"
    )
}

fn agent_helper_version_supported_for_platform(version: &str, platform: &str) -> bool {
    let Some(version) = parse_agent_helper_semver(version) else {
        return false;
    };
    if agent_helper_browser_platform(platform) {
        version >= MIN_BROWSER_AGENT_HELPER_SEMVER
    } else {
        version >= MIN_AGENT_HELPER_SEMVER
    }
}

fn agent_helper_native_runtime_supported(agent: &serde_json::Map<String, Value>) -> bool {
    let runtime_version = agent.get("solverRuntimeVersion").and_then(Value::as_str);
    let runtime_digest = agent.get("solverRuntimeDigest").and_then(Value::as_str);
    match (runtime_version, runtime_digest) {
        // Native 1.6.33+ must prove it embeds the exact same solver snapshot as
        // the VPS. Browser and trusted-worker compatibility is handled before
        // this function; an unmarked native executable is upgrade-only.
        (None, None) => false,
        (Some(version), Some(digest)) => {
            version == NATIVE_SOLVER_RUNTIME_VERSION && digest == NATIVE_SOLVER_RUNTIME_DIGEST
        }
        _ => false,
    }
}

fn agent_helper_body_version(body: &Value) -> &str {
    body.get("agent")
        .and_then(Value::as_object)
        .and_then(|agent| agent.get("version"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn fresh_automatic_no_checkpoint_rescue_eligible(request: Option<&Value>) -> bool {
    let Some(request) = request else {
        return false;
    };
    let settings = request_settings(request);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let requested_mode = setting_string(settings, "ui_requested_solve_mode")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let focus = setting_string(settings, "optimization_focus")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let browser_ready = setting_bool(settings, "ui_browser_wasm_ready", false)
        || setting_bool(settings, "ui_browser_cpsat_ready", false);
    solve_kind == "fresh_complete_first"
        && matches!(requested_mode.as_str(), "" | "auto" | "automatic")
        && matches!(focus.as_str(), "" | "auto" | "automatic")
        && browser_ready
        && setting_bool(settings, "require_complete_schedule", true)
}

fn fresh_automatic_no_checkpoint_rescue_body_eligible(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .as_ref()
        .is_some_and(|request| fresh_automatic_no_checkpoint_rescue_eligible(Some(request)))
}

fn agent_helper_upgrade_required_json(minimum_version: &str) -> Vec<u8> {
    json_response(
        426,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": false,
            "kind": "agent_upgrade_required",
            "error": "agent_upgrade_required",
            "minimumAgentVersion": minimum_version,
            "solverRuntimeVersion": NATIVE_SOLVER_RUNTIME_VERSION,
            "solverRuntimeDigest": NATIVE_SOLVER_RUNTIME_DIGEST,
            "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip"
        }),
    )
}

fn agent_helper_upgrade_wait_json(minimum_version: &str) -> Vec<u8> {
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "lease": Value::Null,
            "retryAfterMs": AGENT_IDLE_RETRY_MS,
            "agentEligible": false,
            "upgradeRequired": true,
            "minimumAgentVersion": minimum_version,
            "solverRuntimeVersion": NATIVE_SOLVER_RUNTIME_VERSION,
            "solverRuntimeDigest": NATIVE_SOLVER_RUNTIME_DIGEST,
            "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip"
        }),
    )
}

fn agent_helper_hello_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let AgentHelperContext {
        owner,
        session_binding,
        trusted_global,
    } = match agent_helper_context(app, auth_token) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(agent) = body.get("agent").and_then(Value::as_object) else {
        return agent_helper_error_json(AgentHelperError::InvalidWorker);
    };
    let agent_id = agent
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version = agent
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let platform = agent
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let platform_is_browser_heuristic = platform.trim().eq_ignore_ascii_case("web-wasm");
    let platform_is_browser_cp_sat = platform.trim().eq_ignore_ascii_case("web-cpsat-wasm");
    let platform_is_native =
        !trusted_global && !platform_is_browser_heuristic && !platform_is_browser_cp_sat;
    // Older native packages did not send this field and remain ON by default.
    // Only an explicit boolean false establishes the live-but-stopped process
    // marker consumed by the authenticated browser status endpoint.
    let native_enabled = if platform_is_native {
        match body.get("enabled") {
            None => true,
            Some(Value::Bool(enabled)) => *enabled,
            Some(_) => return agent_helper_error_json(AgentHelperError::InvalidWorker),
        }
    } else {
        true
    };
    let minimum_version = if platform_is_browser_heuristic || platform_is_browser_cp_sat {
        MIN_BROWSER_AGENT_HELPER_VERSION
    } else {
        MIN_AGENT_HELPER_VERSION
    };
    let Some(version_semver) = parse_agent_helper_semver(version) else {
        app.agent_helper
            .revoke_worker_identity(&owner, &session_binding, agent_id, now_millis());
        return agent_helper_upgrade_required_json(minimum_version);
    };
    let name = format!("{} {}", platform.trim(), version.trim());
    let browser_job_scope =
        if !trusted_global && (platform_is_browser_heuristic || platform_is_browser_cp_sat) {
            let Some(job_id) = body
                .get("jobId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 256)
            else {
                return agent_helper_error_json(AgentHelperError::InvalidWorker);
            };
            if !app.solver_pool.server_job_known_for_owner(job_id, &owner) {
                return agent_helper_error_json(AgentHelperError::JobNotFound);
            }
            let eligible = if platform_is_browser_cp_sat {
                app.solver_pool
                    .server_job_browser_cp_sat_eligible(job_id, &owner)
            } else {
                app.solver_pool
                    .server_job_browser_wasm_eligible(job_id, &owner)
            };
            if !eligible {
                // Keep requests outside the independently verified Browser-WASM
                // or CP-SAT envelope on VPS. A rejected browser hello has no
                // handoff side effect, so the canonical job continues without an
                // avoidable timeout.
                return json_response(
                    409,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": if platform_is_browser_cp_sat {
                            "browser_cpsat_refinement_required"
                        } else {
                            "browser_wasm_refinement_required"
                        },
                        "error": if platform_is_browser_cp_sat {
                            "browser_cpsat_refinement_required"
                        } else {
                            "browser_wasm_refinement_required"
                        }
                    }),
                );
            }
            Some(job_id.to_string())
        } else {
            None
        };
    let version_supported = if platform_is_browser_heuristic || platform_is_browser_cp_sat {
        version_semver >= MIN_BROWSER_AGENT_HELPER_SEMVER
    } else {
        version_semver >= MIN_AGENT_HELPER_SEMVER
    };
    let runtime_supported = trusted_global
        || platform_is_browser_heuristic
        || platform_is_browser_cp_sat
        || agent_helper_native_runtime_supported(agent);
    if !version_supported || !runtime_supported {
        let registration = if platform_is_native && !native_enabled {
            app.agent_helper.register_paused_worker(
                &owner,
                &session_binding,
                agent_id,
                &name,
                agent_helper_parallel(&body),
                now_millis(),
            )
        } else {
            app.agent_helper.register_upgrade_worker(
                &owner,
                &session_binding,
                agent_id,
                &name,
                agent_helper_parallel(&body),
                now_millis(),
            )
        };
        return match registration {
            Ok(registration) => json_response(
                200,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": true,
                    "workerToken": registration.worker_token,
                    "agentId": registration.worker_id,
                    "heartbeatEveryMs": registration.heartbeat_every_ms,
                    "workerExpiresAtMs": registration.worker_expires_at_ms,
                    "leaseMs": registration.lease_ms,
                    "agentEligible": false,
                    "agentEnabled": native_enabled,
                    "upgradeRequired": true,
                    "minimumAgentVersion": minimum_version,
                    "solverRuntimeVersion": NATIVE_SOLVER_RUNTIME_VERSION,
                    "solverRuntimeDigest": NATIVE_SOLVER_RUNTIME_DIGEST,
                    "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip",
                    "handoffJobIds": []
                }),
            ),
            Err(error) => agent_helper_error_json(error),
        };
    }
    let registration = if trusted_global {
        app.agent_helper.register_trusted_worker(
            &owner,
            &session_binding,
            agent_id,
            &name,
            agent_helper_parallel(&body),
            now_millis(),
        )
    } else if let Some(job_id) = browser_job_scope.as_deref() {
        app.agent_helper.register_scoped_worker(
            &owner,
            &session_binding,
            agent_id,
            &name,
            agent_helper_parallel(&body),
            job_id,
            now_millis(),
        )
    } else if !native_enabled {
        app.agent_helper.register_paused_worker(
            &owner,
            &session_binding,
            agent_id,
            &name,
            agent_helper_parallel(&body),
            now_millis(),
        )
    } else {
        app.agent_helper.register_worker(
            &owner,
            &session_binding,
            agent_id,
            &name,
            agent_helper_parallel(&body),
            now_millis(),
        )
    };
    match registration {
        Ok(registration) => {
            // A fresh eligible hello is the explicit signal that an Agent is
            // available. A paused hello stays heartbeat-visible but must have
            // no handoff side effect. For eligible workers, mark VPS-owned jobs
            // while holding the solver-pool fence; the coordinator exposes a
            // lease only after the local child and its guard have exited.
            let agent_eligible = !platform_is_native || native_enabled;
            let handoff_jobs = if !agent_eligible {
                Vec::new()
            } else if trusted_global {
                // A trusted worker drains the global queue only from its
                // authenticated lease poll. Keeping hello side-effect free
                // prevents hello + lease from reserving two jobs for one slot.
                Vec::new()
            } else if let Some(job_id) = browser_job_scope.as_deref() {
                app.solver_pool
                    .request_agent_handoff_for_job(job_id, &owner)
                    .then(|| vec![job_id.to_string()])
                    .unwrap_or_default()
            } else {
                app.solver_pool.request_agent_handoff_for_owner(&owner)
            };
            json_response(
                200,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": true,
                    "workerToken": registration.worker_token,
                    "agentId": registration.worker_id,
                    "heartbeatEveryMs": registration.heartbeat_every_ms,
                    "workerExpiresAtMs": registration.worker_expires_at_ms,
                    "leaseMs": registration.lease_ms,
                    "agentEligible": agent_eligible,
                    "agentEnabled": native_enabled,
                    "upgradeRequired": false,
                    "minimumAgentVersion": minimum_version,
                    "solverRuntimeVersion": NATIVE_SOLVER_RUNTIME_VERSION,
                    "solverRuntimeDigest": NATIVE_SOLVER_RUNTIME_DIGEST,
                    "handoffJobIds": handoff_jobs,
                    "jobScope": browser_job_scope
                }),
            )
        }
        Err(error) => agent_helper_error_json(error),
    }
}

fn agent_helper_heartbeat_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let AgentHelperContext {
        owner,
        session_binding,
        ..
    } = match agent_helper_context(app, auth_token) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let worker_token = match agent_helper_worker_token(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let active_execution = app
        .solver_pool
        .server_job_snapshots_for_owner(&owner)
        .into_iter()
        .find(|job| job.completed_ms.is_none() && job.execution_phase.executor().is_some());
    let now_ms = now_millis();
    let resource_telemetry = agent_helper_resource_telemetry(&body);
    match app.agent_helper.heartbeat_with_telemetry(
        &owner,
        &session_binding,
        &worker_token,
        &[],
        resource_telemetry,
        now_ms,
    ) {
        Ok(result) => json_response(
            200,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": true,
                "workerExpiresAtMs": result.worker_expires_at_ms,
                "renewedLeaseIds": [],
                "lostLeaseIds": [],
                "executionSource": active_execution
                    .as_ref()
                    .and_then(|job| job.execution_phase.executor())
                    .map(ServerExecutor::as_str),
                "executionPhase": active_execution
                    .as_ref()
                    .map(|job| job.execution_phase.as_str())
            }),
        ),
        Err(error) => agent_helper_error_json(error),
    }
}

fn agent_helper_disconnect_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let AgentHelperContext {
        owner,
        session_binding,
        ..
    } = match agent_helper_context(app, auth_token) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let worker_token = match agent_helper_worker_token(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    // Authenticate the exact session-bound token before revoking it. Revocation
    // atomically requeues any live lease, so the fenced coordinator may return
    // the same canonical request to VPS without waiting for the worker TTL.
    if let Err(error) =
        app.agent_helper
            .heartbeat(&owner, &session_binding, &worker_token, &[], now_millis())
    {
        return agent_helper_error_json(error);
    }
    let disconnected =
        app.agent_helper
            .revoke_worker_token(&owner, &session_binding, &worker_token, now_millis());
    if disconnected {
        external_cp_sat_streams().remove_worker(&external_cp_sat_stream_worker_key(&worker_token));
    }
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "disconnected": disconnected
        }),
    )
}

fn agent_helper_claim_payload(
    lease: AgentWorkLease,
    cpu_workers: usize,
    browser_wasm: bool,
    remaining_watchdog_ms: Option<u64>,
) -> Value {
    let mut request = serde_json::from_slice::<Value>(&lease.request_body)
        .unwrap_or_else(|_| json!({"data":{}, "settings":{}}));
    if let Some(remaining_ms) = remaining_watchdog_ms {
        request = server_request_with_remaining_watchdog(&request, remaining_ms);
    }
    {
        let settings = ensure_object_child(&mut request, "settings");
        settings.insert("random_seed".to_string(), json!(lease.seed));
        settings.insert(
            "solve_run_id".to_string(),
            json!(format!(
                "agent-{}-{}-{}",
                lease.job_id, lease.seed, lease.attempt
            )),
        );
        settings.insert("ui_solver_async_job".to_string(), json!(false));
        settings.insert("ui_solver_fifo_admission".to_string(), json!(false));
        settings.insert("agent_helper_seed".to_string(), json!(lease.seed));
    }

    // VPS Python, the packaged Windows solver and Browser-exact model builder
    // must receive the same server-owned worker/deadline contract. Previously
    // only the VPS and later Browser CP-SAT stream passed through this
    // normalizer; a native lease therefore retained stale client budgets and
    // let the desktop process silently choose a different solve envelope.
    let budget = reference_solver_budget(&request);
    let agent_workers = adaptive_agent_worker_count(&request, cpu_workers);
    let request_body = serde_json::to_vec(&request).unwrap_or_default();
    let normalized = reference_solver_body(&request_body, &request, budget, agent_workers);
    request = serde_json::from_slice(&normalized).unwrap_or(request);

    let settings = ensure_object_child(&mut request, "settings");
    if browser_wasm {
        // The coordinator deliberately clears the outer async/FIFO flags on
        // every leased execution copy. Keep an explicit internal marker so the
        // Browser Agent can recognize this server-issued payload without
        // weakening the canonical admission check on /api/solve-data.
        settings.insert("browser_wasm_server_lease".to_string(), json!(true));
        let optimization_focus = settings
            .get("optimization_focus")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .replace(' ', "_")
            .replace('-', "_");
        if optimization_focus == "quick_complete" {
            // Quick owns completeness only. Keep the canonical fresh/partial
            // choice instead of forcing the incumbent-preserving refinement
            // path, and bound this local attempt before VPS fallback.
            settings.insert("require_complete_schedule".to_string(), json!(true));
            settings.insert("best_effort_on_timeout".to_string(), json!(false));
            settings.insert("native_skip_teacher_optimization".to_string(), json!(true));
            settings.insert("browser_wasm_quick_attempt".to_string(), json!(true));
            for key in ["backend_deadline_ms", "native_global_deadline_ms"] {
                let capped = settings
                    .get(key)
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0)
                    .unwrap_or(BROWSER_WASM_QUICK_ATTEMPT_MS)
                    .min(BROWSER_WASM_QUICK_ATTEMPT_MS);
                settings.insert(key.to_string(), json!(capped));
            }
            let reserve = settings
                .get("native_deadline_reserve_ms")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .unwrap_or(BROWSER_WASM_QUICK_RESERVE_MS)
                .min(BROWSER_WASM_QUICK_RESERVE_MS);
            settings.insert("native_deadline_reserve_ms".to_string(), json!(reserve));
        } else {
            // The canonical refinement request keeps the reference solver's
            // settings. Only the browser lease copy selects the incumbent-preserving
            // Rust path; candidate validation still uses the untouched request.
            settings.insert("optimize_existing_schedule".to_string(), json!(true));
            settings.insert("force_fresh_backend_solve".to_string(), json!(false));
            settings.insert("native_skip_teacher_optimization".to_string(), json!(false));
            settings.insert("browser_wasm_refinement".to_string(), json!(true));
        }
    }
    json!({
        "protocol": AGENT_HELPER_PROTOCOL,
        "ok": true,
        "lease": {
            "jobId": lease.job_id,
            "leaseId": lease.lease_token,
            "attempt": lease.attempt,
            "leaseExpiresAt": Value::Null,
            "leaseExpiresAtMs": lease.lease_expires_at_ms,
            "payload": request,
            "limits": {
                "cpuWorkers": agent_workers,
                "timeoutSeconds": MAX_SOLVER_DEADLINE_MS / 1_000
            }
        }
    })
}

fn try_trusted_queue_handoff(
    app: &App,
    owner: &SolverOwner,
    session_binding: &str,
    worker_token: &str,
    lease_request_id: &str,
) -> Result<bool, AgentHelperError> {
    let now_ms = now_millis();
    if !app.agent_helper.begin_trusted_handoff_request(
        owner,
        session_binding,
        worker_token,
        lease_request_id,
        now_ms,
    )? {
        // This logical request was already committed by an overlapping
        // transport retry, or the authenticated worker is not trusted-global.
        return Ok(true);
    }
    let moved = app.solver_pool.request_agent_handoff_for_trusted_worker(1);
    if let Some(job_id) = moved.first() {
        app.agent_helper.commit_trusted_handoff_request(
            owner,
            session_binding,
            worker_token,
            lease_request_id,
            job_id,
            now_millis(),
        )?;
        return Ok(true);
    }
    app.agent_helper.release_trusted_handoff_request(
        owner,
        session_binding,
        worker_token,
        lease_request_id,
        now_millis(),
    )?;
    Ok(false)
}

fn agent_helper_claim_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let AgentHelperContext {
        owner,
        session_binding,
        trusted_global,
    } = match agent_helper_context(app, auth_token) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let worker_token = match agent_helper_worker_token(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let version = agent_helper_body_version(&body);
    let cpu_workers = agent_helper_capacity(&body);
    // Executor kind comes from the authenticated hello registration. A
    // repeated client-side `agent.platform` field is advisory only; relying
    // on it here would let a stale Browser poll bypass native-first routing.
    let registered_job_scope =
        app.agent_helper
            .worker_job_scope(&owner, &session_binding, &worker_token, now_millis());
    let browser_wasm = registered_job_scope
        .as_ref()
        .is_some_and(|scope| scope.is_some());
    let minimum_version = if browser_wasm {
        MIN_BROWSER_AGENT_HELPER_VERSION
    } else {
        MIN_AGENT_HELPER_VERSION
    };
    let version_supported = if browser_wasm {
        agent_helper_version_supported_for_platform(version, "web-wasm")
    } else {
        agent_helper_version_supported(version)
    };
    let runtime_supported = trusted_global
        || browser_wasm
        || body
            .get("agent")
            .and_then(Value::as_object)
            .is_some_and(agent_helper_native_runtime_supported);
    if !version_supported || !runtime_supported {
        if parse_agent_helper_semver(version).is_some()
            && app.agent_helper.worker_eligibility(
                &owner,
                &session_binding,
                &worker_token,
                now_millis(),
            ) == Some(false)
        {
            return agent_helper_upgrade_wait_json(minimum_version);
        }
        app.agent_helper
            .revoke_worker_token(&owner, &session_binding, &worker_token, now_millis());
        return agent_helper_upgrade_required_json(minimum_version);
    }
    let lease_request_id = body
        .get("leaseRequestId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let wait_seconds = body
        .get("waitSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(30);
    let wait_deadline = Instant::now() + Duration::from_secs(wait_seconds);
    let mut trusted_handoff_requested = false;
    loop {
        let now_ms = now_millis();
        let job_id = registered_job_scope
            .as_ref()
            .and_then(|scope| scope.as_deref())
            .or_else(|| body.get("jobId").and_then(Value::as_str))
            .unwrap_or_default();
        let replaying_browser_lease = browser_wasm
            && app.agent_helper.has_active_lease_request(
                &owner,
                &session_binding,
                &worker_token,
                lease_request_id,
                now_ms,
            );
        if browser_wasm
            && !replaying_browser_lease
            && !job_id.is_empty()
            && !app
                .solver_pool
                .server_job_browser_agent_required(job_id, &owner)
            && app
                .agent_helper
                .native_worker_priority_available(&owner, job_id, now_ms)
        {
            if Instant::now() < wait_deadline {
                thread::sleep(Duration::from_millis(150));
                continue;
            }
            return json_response(
                200,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": true,
                    "lease": Value::Null,
                    "nativePreferred": true,
                    "retryAfterMs": 250
                }),
            );
        }
        match app.agent_helper.claim_work_with_request_id(
            &owner,
            &session_binding,
            &worker_token,
            lease_request_id,
            now_ms,
        ) {
            Ok(lease) => {
                if app
                    .solver_pool
                    .server_job_known_for_owner(&lease.job_id, &lease.job_owner)
                    && app
                        .solver_pool
                        .server_job_cancel_requested(&lease.job_id, &lease.job_owner)
                {
                    let _ = app.agent_helper.finish_job(&lease.job_id, &lease.job_owner);
                    return json_response(
                        409,
                        json!({
                            "protocol": AGENT_HELPER_PROTOCOL,
                            "ok": false,
                            "cancel": true,
                            "kind": "solver_cancelled",
                            "error": "solver_cancelled"
                        }),
                    );
                }
                if browser_wasm
                    && app
                        .solver_pool
                        .server_job_native_agent_required(&lease.job_id, &lease.job_owner)
                {
                    // Browser eligibility is disabled before a native-only job
                    // is published. Keep this second fence at lease delivery so
                    // even a stale/pre-existing scoped registration can never
                    // receive the Windows execution payload.
                    app.agent_helper.revoke_worker_token(
                        &owner,
                        &session_binding,
                        &worker_token,
                        now_millis(),
                    );
                    return native_agent_required_response(&lease.job_id, "native_agent_required");
                }
                let remaining_watchdog_ms = app.solver_pool.server_job_watchdog_remaining_ms(
                    &lease.job_id,
                    &lease.job_owner,
                    now_millis(),
                );
                return json_response(
                    200,
                    agent_helper_claim_payload(
                        lease,
                        cpu_workers,
                        browser_wasm,
                        remaining_watchdog_ms,
                    ),
                );
            }
            Err(AgentHelperError::NoWork) if Instant::now() < wait_deadline => {
                // Reaching NoWork proves both the durable bearer/worker token
                // and the worker's free capacity. Reserve at most one queued
                // job for this logical long-poll, then wait for its coordinator
                // to publish the canonical Agent task.
                if trusted_global && !trusted_handoff_requested {
                    match try_trusted_queue_handoff(
                        app,
                        &owner,
                        &session_binding,
                        &worker_token,
                        lease_request_id,
                    ) {
                        Ok(committed) => trusted_handoff_requested = committed,
                        Err(error) => return agent_helper_error_json(error),
                    }
                }
                thread::sleep(Duration::from_millis(150));
            }
            Err(AgentHelperError::NoWork) => {
                if trusted_global && !trusted_handoff_requested {
                    // A zero-wait poll still nudges one queued job. The next
                    // poll may lease it after the fenced handoff completes.
                    match try_trusted_queue_handoff(
                        app,
                        &owner,
                        &session_binding,
                        &worker_token,
                        lease_request_id,
                    ) {
                        Ok(_) => {}
                        Err(error) => return agent_helper_error_json(error),
                    }
                }
                return json_response(
                    200,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": true,
                        "lease": Value::Null,
                        "retryAfterMs": AGENT_IDLE_RETRY_MS
                    }),
                );
            }
            Err(error) => return agent_helper_error_json(error),
        }
    }
}

fn agent_helper_result_digest(result: &Value) -> Result<String, Vec<u8>> {
    fn update_length(hasher: &mut Sha256, length: usize) -> Result<(), ()> {
        let length = u64::try_from(length).map_err(|_| ())?;
        hasher.update(length.to_be_bytes());
        Ok(())
    }

    fn update_value(hasher: &mut Sha256, value: &Value) -> Result<(), ()> {
        match value {
            Value::Null => hasher.update(b"N"),
            Value::Bool(true) => hasher.update(b"T"),
            Value::Bool(false) => hasher.update(b"F"),
            Value::String(text) => {
                hasher.update(b"S");
                update_length(hasher, text.len())?;
                hasher.update(text.as_bytes());
            }
            Value::Number(number) if number.is_i64() => {
                let encoded = number.as_i64().ok_or(())?.to_string();
                hasher.update(b"I");
                update_length(hasher, encoded.len())?;
                hasher.update(encoded.as_bytes());
            }
            Value::Number(number) if number.is_u64() => {
                let encoded = number.as_u64().ok_or(())?.to_string();
                hasher.update(b"I");
                update_length(hasher, encoded.len())?;
                hasher.update(encoded.as_bytes());
            }
            Value::Number(number) => {
                let value = number.as_f64().ok_or(())?;
                if !value.is_finite() {
                    return Err(());
                }
                hasher.update(b"D");
                hasher.update(value.to_be_bytes());
            }
            Value::Array(items) => {
                hasher.update(b"L");
                update_length(hasher, items.len())?;
                for item in items {
                    update_value(hasher, item)?;
                }
            }
            Value::Object(items) => {
                hasher.update(b"O");
                update_length(hasher, items.len())?;
                let mut keys = items.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                for key in keys {
                    update_value(hasher, &Value::String(key.clone()))?;
                    update_value(hasher, items.get(key).ok_or(())?)?;
                }
            }
        }
        Ok(())
    }

    let mut digest = Sha256::new();
    digest.update(AGENT_RESULT_DIGEST_PROTOCOL.as_bytes());
    digest.update(b"\0");
    update_value(&mut digest, result).map_err(|_| {
        json_response(
            400,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "agent_candidate_invalid_json",
                "error": "agent_candidate_invalid_json"
            }),
        )
    })?;
    let digest = digest.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn agent_checkpoint_progress(request_body: &[u8], candidate: &Value) -> Option<Value> {
    fn metric(metrics: &Value, key: &str) -> i64 {
        metrics
            .get(key)
            .and_then(Value::as_i64)
            .unwrap_or_default()
            .max(0)
    }
    fn gap_count(metrics: &Value, minimum_gap: i64) -> i64 {
        metrics
            .get("gap_distribution")
            .and_then(Value::as_object)
            .map(|distribution| {
                distribution
                    .iter()
                    .filter_map(|(gap, count)| {
                        let gap = gap.parse::<i64>().ok()?;
                        (gap >= minimum_gap).then(|| count.as_i64().unwrap_or_default().max(0))
                    })
                    .sum()
            })
            .unwrap_or_default()
    }

    let request: Value = serde_json::from_slice(request_body).ok()?;
    let settings = request.get("settings").and_then(Value::as_object)?;
    let focus = settings
        .get("optimization_focus")
        .and_then(Value::as_str)
        .unwrap_or("automatic")
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let focus = match focus.as_str() {
        "singleton" | "singletons" | "one_period_teacher_sessions" => "singletons",
        "session" | "sessions" | "teacher_sessions" => "sessions",
        "gap" | "gaps" | "teacher_gaps" => "gaps",
        _ => return None,
    };
    let gap_target = settings
        .get("optimization_gap_target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let metrics = candidate.get("metrics")?;
    let baseline = request
        .get("data")
        .and_then(|data| data.get("tkbSolverResult"))
        .and_then(|result| result.get("metrics"))
        .unwrap_or(metrics);
    let configured_metric = |key: &str| {
        settings.get(key).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
                .map(|number| number.max(0))
        })
    };
    let (solve_mode, progress_focus, current, target, baseline_value, percent) = match focus {
        "singletons" => {
            let current = metric(metrics, "one_period_teacher_sessions");
            // The browser request carries the click's canonical baseline. Keep it
            // even when the Agent request body omits the incumbent payload or the
            // candidate is temporarily worse; otherwise every live checkpoint
            // resets progress to 0% at the latest count.
            let baseline = configured_metric("ui_progress_metric_baseline")
                .unwrap_or_else(|| metric(baseline, "one_period_teacher_sessions"));
            let percent = if current == 0 {
                100.0
            } else if baseline == 0 {
                0.0
            } else {
                (baseline - current) as f64 * 100.0 / baseline as f64
            };
            (
                "optimize_singletons",
                "one_period_teacher_sessions",
                current,
                0,
                baseline,
                percent,
            )
        }
        "sessions" => {
            let current = metric(metrics, "teacher_sessions");
            let baseline = configured_metric("ui_progress_metric_baseline")
                .unwrap_or_else(|| metric(baseline, "teacher_sessions"));
            let target = settings
                .get("ui_progress_metric_target")
                .or_else(|| settings.get("target_teacher_sessions"))
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .max(0);
            let percent = if target > 0 && current > target {
                target as f64 * 100.0 / current as f64
            } else if target > 0 {
                100.0
            } else if baseline > 0 {
                (baseline - current) as f64 * 100.0 / baseline as f64
            } else {
                0.0
            };
            (
                "optimize_sessions",
                "teacher_sessions",
                current,
                target,
                baseline,
                percent,
            )
        }
        _ => {
            let current_gap2 = metric(metrics, "teacher_gap2_sessions").max(gap_count(metrics, 2));
            let current_gap1 = metrics
                .get("gap_distribution")
                .and_then(|distribution| distribution.get("1"))
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .max(0);
            let baseline_gap2 =
                configured_metric("ui_progress_gap2_baseline").unwrap_or_else(|| {
                    metric(baseline, "teacher_gap2_sessions").max(gap_count(baseline, 2))
                });
            let baseline_gap1 =
                configured_metric("ui_progress_gap1_baseline").unwrap_or_else(|| {
                    baseline
                        .get("gap_distribution")
                        .and_then(|distribution| distribution.get("1"))
                        .and_then(Value::as_i64)
                        .unwrap_or_default()
                        .max(0)
                });
            let (solve_mode, progress_focus, current, baseline) = match gap_target.as_str() {
                "gap2" | "gap_2" | "teacher_gap2_sessions" | "optimize_gap2" => (
                    "optimize_gap2",
                    "teacher_gap2_sessions",
                    current_gap2,
                    baseline_gap2,
                ),
                "gap1" | "gap_1" | "teacher_gap1_sessions" | "optimize_gap1" => (
                    "optimize_gap1",
                    "teacher_gap1_sessions",
                    current_gap1,
                    baseline_gap1,
                ),
                _ => (
                    "optimize_gaps",
                    "teacher_gap_sessions",
                    current_gap1 + current_gap2,
                    baseline_gap1 + baseline_gap2,
                ),
            };
            let percent = if current == 0 {
                100.0
            } else if baseline > 0 {
                (baseline - current) as f64 * 100.0 / baseline as f64
            } else {
                0.0
            };
            (solve_mode, progress_focus, current, 0, baseline, percent)
        }
    };
    Some(json!({
        "stage":"browser_agent:checkpoint",
        "solveRequestMode":solve_mode,
        "optimizationFocus":progress_focus,
        "metricCurrent":current,
        "metricTarget":target,
        "metricBaseline":baseline_value,
        "metricPercent":(percent.clamp(0.0, 100.0) * 10.0).round() / 10.0
    }))
}

fn agent_helper_lease_action_json(
    app: &App,
    path: &str,
    auth_token: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    let Some(rest) = path.strip_prefix("/api/agent-helper/v1/leases/") else {
        return json_response(404, json!({"ok":false,"error":"not_found"}));
    };
    let Some((lease_id, action)) = rest.split_once('/') else {
        return json_response(404, json!({"ok":false,"error":"not_found"}));
    };
    if lease_id.is_empty() || lease_id.len() > 256 || action.contains('/') {
        return json_response(404, json!({"ok":false,"error":"not_found"}));
    }
    let AgentHelperContext {
        owner,
        session_binding,
        ..
    } = match agent_helper_context(app, auth_token) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = match agent_helper_body(body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if body
        .get("leaseId")
        .and_then(Value::as_str)
        .is_some_and(|value| value != lease_id)
    {
        return json_response(
            409,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "agent_lease_id_mismatch",
                "error": "agent_lease_id_mismatch"
            }),
        );
    }
    let worker_token = match agent_helper_worker_token(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if action == "complete" {
        if app
            .agent_helper
            .heartbeat(&owner, &session_binding, &worker_token, &[], now_millis())
            .is_err()
        {
            return agent_helper_error_json(AgentHelperError::UnauthorizedWorker);
        }
        let candidate_id_ok = body
            .get("candidateId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.len() <= 128);
        let digest_ok = body
            .get("sha256")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if !candidate_id_ok || !digest_ok {
            return json_response(
                400,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": false,
                    "kind": "agent_completion_invalid",
                    "error": "agent_completion_invalid"
                }),
            );
        }
        external_cp_sat_streams().remove_lease(lease_id);
        return json_response(
            202,
            json!({"protocol":AGENT_HELPER_PROTOCOL,"ok":true,"completed":true}),
        );
    }
    if action == "fail" {
        // Signal the stream before submission bookkeeping so a concurrent
        // model build stops even if the lease is being requeued at this moment.
        external_cp_sat_streams().remove_lease(lease_id);
    }

    let now_ms = now_millis();
    let work_id = match app.agent_helper.work_id_for_lease(
        &owner,
        &session_binding,
        &worker_token,
        lease_id,
        now_ms,
    ) {
        Ok(value) => value,
        Err(error) => return agent_helper_error_json(error),
    };
    let ticket = match app.agent_helper.begin_submission(
        &owner,
        &session_binding,
        &worker_token,
        &work_id,
        lease_id,
        now_ms,
    ) {
        Ok(value) => value,
        Err(error) => return agent_helper_error_json(error),
    };
    if body
        .get("jobId")
        .and_then(Value::as_str)
        .is_some_and(|value| value != ticket.job_id)
    {
        return json_response(
            409,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "agent_job_id_mismatch",
                "error": "agent_job_id_mismatch"
            }),
        );
    }
    if app
        .solver_pool
        .server_job_cancel_requested(&ticket.job_id, &ticket.job_owner)
    {
        external_cp_sat_streams().remove_lease(lease_id);
        if action == "heartbeat" {
            return json_response(
                200,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": true,
                    "cancel": true,
                    "action": "cancel"
                }),
            );
        }
        return json_response(
            409,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "cancel": true,
                "kind": "solver_cancelled",
                "error": "solver_cancelled"
            }),
        );
    }

    match action {
        "cpsat-step" => {
            if !external_model_plan_version_matches(&body) {
                return json_response(
                    409,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "external_model_plan_version_mismatch",
                        "error": "external_model_plan_version_mismatch",
                        "expectedModelPlanVersion": EXTERNAL_MODEL_PLAN_VERSION
                    }),
                );
            }
            let stream_kind = body
                .get("streamKind")
                .and_then(Value::as_str)
                .unwrap_or("quality");
            if !matches!(stream_kind, "quality" | "completion_seed") {
                return json_response(
                    400,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "external_cp_sat_stream_kind_invalid",
                        "error": "external_cp_sat_stream_kind_invalid"
                    }),
                );
            }
            let responses = body.get("responses").and_then(Value::as_array);
            let response_count = responses.map(Vec::len).unwrap_or(usize::MAX);
            let requested_step = body
                .get("stepIndex")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(response_count);
            if response_count > MAX_EXTERNAL_CP_SAT_STEPS
                || requested_step != response_count
                || responses.is_none_or(|values| !external_cp_sat_responses_are_bounded(values))
            {
                return json_response(
                    400,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "external_cp_sat_step_invalid",
                        "error": "external_cp_sat_step_invalid"
                    }),
                );
            }
            let responses = Value::Array(responses.cloned().unwrap_or_default());
            // Renew exact lease before starting Python model reconstruction.
            // Browser heartbeat continues during the remote solve itself.
            if app
                .agent_helper
                .heartbeat(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &[AgentLeaseHeartbeat {
                        work_id: work_id.clone(),
                        lease_token: lease_id.to_string(),
                    }],
                    now_ms,
                )
                .is_err()
            {
                external_cp_sat_streams().remove_lease(lease_id);
                return agent_helper_error_json(AgentHelperError::LeaseExpired);
            }
            external_cp_sat_streams()
                .renew_lease(lease_id, now_ms.saturating_add(AGENT_WORK_LEASE_MS));
            let step_key = match agent_helper_result_digest(&responses) {
                Ok(value) => format!("{stream_kind}:{response_count}:{value}"),
                Err(response) => return response,
            };
            let admission_started = Instant::now();
            let admission_wait_ms = app
                .solver_pool
                .server_job_watchdog_remaining_ms(&ticket.job_id, &ticket.job_owner, now_ms)
                .unwrap_or(EXTERNAL_CP_SAT_STEP_TIMEOUT_MS)
                .min(EXTERNAL_CP_SAT_STEP_TIMEOUT_MS);
            let admission = loop {
                match app.agent_helper.try_begin_external_cp_sat_step(
                    lease_id,
                    &step_key,
                    now_millis(),
                ) {
                    ExternalCpSatAdmission::Acquired(permit) => break permit,
                    ExternalCpSatAdmission::Replay(replay) => {
                        return json_response(replay.status, replay.payload)
                    }
                    ExternalCpSatAdmission::Conflict => {
                        return json_response(
                            409,
                            json!({
                                "protocol": AGENT_HELPER_PROTOCOL,
                                "ok": false,
                                "kind": "external_cp_sat_step_conflict",
                                "error": "external_cp_sat_step_conflict"
                            }),
                        )
                    }
                    ExternalCpSatAdmission::Busy => {}
                }
                if app
                    .solver_pool
                    .server_job_cancel_requested(&ticket.job_id, &ticket.job_owner)
                {
                    return json_response(
                        409,
                        json!({
                            "protocol": AGENT_HELPER_PROTOCOL,
                            "ok": false,
                            "cancel": true,
                            "kind": "solver_cancelled",
                            "error": "solver_cancelled"
                        }),
                    );
                }
                if admission_started.elapsed() >= Duration::from_millis(admission_wait_ms) {
                    return json_response(
                        503,
                        json!({
                            "protocol": AGENT_HELPER_PROTOCOL,
                            "ok": false,
                            "kind": "external_cp_sat_builder_capacity",
                            "error": "external_cp_sat_builder_capacity",
                            "retryAfterMs": 250
                        }),
                    );
                }
                thread::sleep(Duration::from_millis(20));
            };
            // Admission can wait behind another school's builder. Recompute
            // the canonical watchdog so Python never receives a stale budget.
            let remaining_watchdog_ms = app.solver_pool.server_job_watchdog_remaining_ms(
                &ticket.job_id,
                &ticket.job_owner,
                now_millis(),
            );
            // Fresh mobile Automatic first creates and uploads a complete
            // device-local seed. Build the exact stream from that validated
            // checkpoint, not from the original empty request. The Browser
            // never supplies the incumbent here; only the coordinator's
            // accepted candidate may enter the exact CP-SAT request.
            let exact_request_body = if stream_kind == "completion_seed" {
                external_cp_sat_completion_seed_request_body(&ticket.request_body)
            } else {
                external_cp_sat_request_body_with_checkpoint(
                    &ticket.request_body,
                    app.agent_helper
                        .best_candidate(&ticket.job_id, &ticket.job_owner)
                        .as_ref()
                        .map(|candidate| &candidate.payload),
                )
            };
            let outcome = match run_external_cp_sat_step(
                app,
                &exact_request_body,
                &ticket.job_id,
                lease_id,
                &worker_token,
                stream_kind,
                ticket.seed,
                agent_helper_capacity(&body),
                body.get("capacity")
                    .and_then(Value::as_object)
                    .and_then(|capacity| capacity.get("fullReferenceRefine"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                remaining_watchdog_ms,
                responses,
            ) {
                Ok(value) => value,
                Err(error) => return external_cp_sat_stream_error_json(error),
            };
            let replay = match outcome {
                ExternalCpSatStepOutcome::Model(payload) => {
                    let kind =
                        external_solver_model_kind(&payload).unwrap_or("external_cp_sat_model");
                    let runtime = payload.get("runtime").cloned().unwrap_or_else(|| {
                        if kind == "external_highs_model" {
                            json!("highs-wasm-1.15-lp-v1")
                        } else {
                            json!("ortools-cp-sat-9.15-wire-v1")
                        }
                    });
                    ExternalCpSatReplay {
                        status: 200,
                        payload: json!({
                            "protocol": AGENT_HELPER_PROTOCOL,
                            "ok": true,
                            "kind": kind,
                            "stepIndex": payload.get("stepIndex").cloned().unwrap_or(json!(response_count)),
                            "modelDigest": payload.get("modelDigest").cloned().unwrap_or(Value::Null),
                            "modelBase64": payload.get("modelBase64").cloned().unwrap_or(Value::Null),
                            "parameterBase64": payload.get("parameterBase64").cloned().unwrap_or(Value::Null),
                            "modelBytes": payload.get("modelBytes").cloned().unwrap_or(json!(0)),
                            "parameterBytes": payload.get("parameterBytes").cloned().unwrap_or(json!(0)),
                            "runtime": runtime,
                            "modelPlanVersion": EXTERNAL_MODEL_PLAN_VERSION
                        }),
                    }
                }
                ExternalCpSatStepOutcome::Result { status, payload } => {
                    if (200..300).contains(&status) {
                        if let Ok(digest) = agent_helper_result_digest(&payload) {
                            external_cp_sat_streams().attest_result(
                                lease_id,
                                &external_cp_sat_stream_worker_key(&worker_token),
                                &ticket.job_id,
                                &digest,
                                now_millis().saturating_add(AGENT_WORK_LEASE_MS),
                            );
                        }
                    }
                    if !(200..300).contains(&status) {
                        ExternalCpSatReplay {
                            status: 502,
                            payload: json!({
                                "protocol": AGENT_HELPER_PROTOCOL,
                                "ok": false,
                                "kind": "external_cp_sat_result_failed",
                                "error": "external_cp_sat_result_failed",
                                "solverStatus": status,
                                "result": payload
                            }),
                        }
                    } else {
                        ExternalCpSatReplay {
                            status: 200,
                            payload: json!({
                                "protocol": AGENT_HELPER_PROTOCOL,
                                "ok": true,
                                "kind": "external_cp_sat_result",
                                "solverStatus": status,
                                "result": payload
                            }),
                        }
                    }
                }
            };
            let replay = admission.complete(replay, now_millis());
            json_response(replay.status, replay.payload)
        }
        "heartbeat" => {
            let lease = AgentLeaseHeartbeat {
                work_id,
                lease_token: lease_id.to_string(),
            };
            match app.agent_helper.heartbeat_with_telemetry(
                &owner,
                &session_binding,
                &worker_token,
                &[lease],
                agent_helper_resource_telemetry(&body),
                now_ms,
            ) {
                Ok(result) => {
                    if !result.renewed_work_ids.is_empty() {
                        external_cp_sat_streams()
                            .renew_lease(lease_id, now_ms.saturating_add(AGENT_WORK_LEASE_MS));
                    } else {
                        external_cp_sat_streams().remove_lease(lease_id);
                    }
                    json_response(
                        200,
                        json!({
                            "protocol": AGENT_HELPER_PROTOCOL,
                            "ok": true,
                            "cancel": false,
                            "renewed": !result.renewed_work_ids.is_empty(),
                            "workerExpiresAtMs": result.worker_expires_at_ms
                        }),
                    )
                }
                Err(error) => agent_helper_error_json(error),
            }
        }
        "candidate" | "checkpoint" => {
            let is_checkpoint = action == "checkpoint";
            let solver_status = body.get("solverStatus").and_then(Value::as_u64);
            let status_is_structured = solver_status.is_some_and(|status| {
                (200..300).contains(&status) || matches!(status, 409 | 422 | 500)
            });
            if body.get("solverProtocol").and_then(Value::as_str) != Some(REFERENCE_STDIO_PROTOCOL)
                || body.get("digestProtocol").and_then(Value::as_str)
                    != Some(AGENT_RESULT_DIGEST_PROTOCOL)
                || !status_is_structured
            {
                if !is_checkpoint {
                    let _ = app.agent_helper.reject_submission(
                        &owner,
                        &session_binding,
                        &worker_token,
                        &work_id,
                        lease_id,
                        now_millis(),
                    );
                }
                return json_response(
                    422,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "agent_solver_result_invalid",
                        "error": "agent_solver_result_invalid"
                    }),
                );
            }
            let Some(result) = body.get("result").filter(|value| value.is_object()) else {
                return json_response(
                    400,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "agent_candidate_missing",
                        "error": "agent_candidate_missing"
                    }),
                );
            };
            let is_success_status =
                solver_status.is_some_and(|status| (200..300).contains(&status));
            if !is_success_status
                && (result.get("ok").and_then(Value::as_bool) == Some(true)
                    || result
                        .get("error")
                        .and_then(Value::as_str)
                        .is_none_or(|value| value.trim().is_empty()))
            {
                if !is_checkpoint {
                    let _ = app.agent_helper.reject_submission(
                        &owner,
                        &session_binding,
                        &worker_token,
                        &work_id,
                        lease_id,
                        now_millis(),
                    );
                }
                return json_response(
                    422,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "agent_solver_result_invalid",
                        "error": "agent_solver_result_invalid"
                    }),
                );
            }
            let digest = match agent_helper_result_digest(result) {
                Ok(value) => value,
                Err(response) => return response,
            };
            if body.get("sha256").and_then(Value::as_str) != Some(digest.as_str()) {
                if !is_checkpoint {
                    let _ = app.agent_helper.reject_submission(
                        &owner,
                        &session_binding,
                        &worker_token,
                        &work_id,
                        lease_id,
                        now_millis(),
                    );
                }
                return json_response(
                    422,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": false,
                        "kind": "agent_candidate_digest_mismatch",
                        "error": "agent_candidate_digest_mismatch"
                    }),
                );
            }
            let solver_status = solver_status.unwrap_or_default();
            let partial_resume_checkpoint = is_checkpoint
                && solver_status == 422
                && result
                    .get("metrics")
                    .and_then(|metrics| metrics.get("placement_hard_ok"))
                    .and_then(Value::as_bool)
                    == Some(true)
                && result
                    .get("metrics")
                    .and_then(|metrics| metrics.get("unassigned_periods"))
                    .and_then(Value::as_i64)
                    .is_some_and(|value| value > 0)
                && result
                    .get("lessons")
                    .and_then(Value::as_array)
                    .is_some_and(|lessons| !lessons.is_empty());
            let became_best = if (200..300).contains(&solver_status) {
                let mut validated =
                    match native_solver::validate_agent_candidate(&ticket.request_body, result) {
                        Ok(value) => value,
                        Err(_) => {
                            if !is_checkpoint {
                                let _ = app.agent_helper.reject_submission(
                                    &owner,
                                    &session_binding,
                                    &worker_token,
                                    &work_id,
                                    lease_id,
                                    now_millis(),
                                );
                            }
                            return json_response(
                                422,
                                json!({
                                    "protocol": AGENT_HELPER_PROTOCOL,
                                    "ok": false,
                                    "kind": "agent_candidate_validation_failed",
                                    "error": "agent_candidate_validation_failed"
                                }),
                            );
                        }
                    };
                let stream_attested = external_cp_sat_streams().consume_attested_result(
                    lease_id,
                    &external_cp_sat_stream_worker_key(&worker_token),
                    &ticket.job_id,
                    &digest,
                    now_millis(),
                );
                if request_has_active_tkb_constraints(&ticket.request_body) {
                    if stream_attested {
                        validated.payload["validation"]["agent_helper_reference_validated"] =
                            json!(true);
                        validated.payload["validation"]
                            ["agent_helper_reference_validation_source"] =
                            json!("external_model_stream_attestation");
                    } else {
                        match run_reference_candidate_validator(
                            app,
                            &ticket.request_body,
                            &validated.payload,
                        ) {
                            Ok(report) => {
                                validated.payload["validation"]
                                    ["agent_helper_reference_validated"] = json!(true);
                                validated.payload["validation"]
                                    ["agent_helper_reference_validation"] = report;
                            }
                            Err(_) => {
                                if !is_checkpoint {
                                    let _ = app.agent_helper.reject_submission(
                                        &owner,
                                        &session_binding,
                                        &worker_token,
                                        &work_id,
                                        lease_id,
                                        now_millis(),
                                    );
                                }
                                return json_response(
                                    422,
                                    json!({
                                        "protocol": AGENT_HELPER_PROTOCOL,
                                        "ok": false,
                                        "kind": "agent_candidate_reference_validation_failed",
                                        "error": "agent_candidate_reference_validation_failed"
                                    }),
                                );
                            }
                        }
                    }
                }
                let checkpoint_progress = is_checkpoint
                    .then(|| agent_checkpoint_progress(&ticket.request_body, &validated.payload))
                    .flatten();
                let accepted = if is_checkpoint {
                    app.agent_helper.accept_checkpoint(
                        &owner,
                        &session_binding,
                        &worker_token,
                        &work_id,
                        lease_id,
                        validated.payload,
                        validated.quality,
                        now_millis(),
                    )
                } else {
                    app.agent_helper.accept_submission(
                        &owner,
                        &session_binding,
                        &worker_token,
                        &work_id,
                        lease_id,
                        validated.payload,
                        validated.quality,
                        now_millis(),
                    )
                };
                let became_best = match accepted {
                    Ok(value) => value,
                    Err(error) => return agent_helper_error_json(error),
                };
                if is_checkpoint && became_best {
                    if let (Some(progress), Some(snapshot)) = (
                        checkpoint_progress,
                        app.solver_pool
                            .server_execution_snapshot(&ticket.job_id, &ticket.job_owner),
                    ) {
                        if snapshot.phase.executor() == Some(ServerExecutor::Agent) {
                            let _ = app.solver_pool.update_server_job_progress_frame_fenced(
                                &ticket.job_id,
                                snapshot.generation,
                                REFERENCE_PROGRESS_PROTOCOL,
                                progress,
                            );
                        }
                    }
                }
                became_best
            } else if partial_resume_checkpoint {
                let validated = match native_solver::validate_agent_resume_checkpoint(
                    &ticket.request_body,
                    result,
                ) {
                    Ok(value) => value,
                    Err(_) => {
                        return json_response(
                            422,
                            json!({
                                "protocol": AGENT_HELPER_PROTOCOL,
                                "ok": false,
                                "kind": "agent_partial_checkpoint_validation_failed",
                                "error": "agent_partial_checkpoint_validation_failed"
                            }),
                        )
                    }
                };
                match app.agent_helper.accept_resume_checkpoint(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    validated.payload,
                    validated.quality,
                    now_millis(),
                ) {
                    Ok(value) => value,
                    Err(error) => return agent_helper_error_json(error),
                }
            } else {
                if let Err(error) = app.agent_helper.accept_structured_outcome(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_millis(),
                ) {
                    return agent_helper_error_json(error);
                }
                false
            };
            let candidate_id = format!("candidate-{}", &digest[..32]);
            json_response(
                202,
                json!({
                    "protocol": AGENT_HELPER_PROTOCOL,
                    "ok": true,
                    "candidateId": candidate_id,
                    "sha256": digest,
                    "becameBest": became_best,
                    "solverStatus": solver_status
                }),
            )
        }
        "fail" => {
            let failure_kind = body
                .get("kind")
                .and_then(Value::as_str)
                .or_else(|| {
                    body.get("failure")
                        .and_then(Value::as_object)
                        .and_then(|failure| failure.get("kind"))
                        .and_then(Value::as_str)
                })
                .unwrap_or_default();
            let accepted_checkpoint = app
                .agent_helper
                .best_candidate(&ticket.job_id, &ticket.job_owner);
            let request = serde_json::from_slice::<Value>(&ticket.request_body).ok();
            if browser_agent_required_for_job(
                app,
                &ticket.job_id,
                &ticket.job_owner,
                request.as_ref(),
            ) {
                // Local-required `/fail` is terminal for this click. Mark the
                // lease complete so it cannot be reclaimed, then commit an
                // explicit failure on the current Agent generation. The
                // coordinator retains the same hard fence if this HTTP thread
                // loses the narrow completion race; VPS remains impossible.
                let released = app.agent_helper.accept_structured_outcome(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_ms,
                );
                if let Err(error) = released {
                    return agent_helper_error_json(error);
                }
                let response =
                    browser_agent_required_response(&ticket.job_id, "browser_agent_failed");
                let completed = app
                    .solver_pool
                    .server_execution_snapshot(&ticket.job_id, &ticket.job_owner)
                    .filter(|snapshot| snapshot.phase.executor() == Some(ServerExecutor::Agent))
                    .is_some_and(|snapshot| {
                        app.solver_pool.complete_server_job_fenced(
                            ServerExecutionFence {
                                generation: snapshot.generation,
                                executor: ServerExecutor::Agent,
                            },
                            &ticket.job_id,
                            &ticket.job_owner,
                            response,
                        )
                    });
                if completed {
                    app.agent_helper
                        .finish_job(&ticket.job_id, &ticket.job_owner);
                }
                return json_response(
                    202,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": true,
                        "requeued": false,
                        "terminal": true,
                        "vpsFallback": false,
                        "kind": "browser_agent_failed",
                        "failureKind": failure_kind
                    }),
                );
            }
            let fresh_vps_from_scratch = failure_kind == "browser_wasm_quality_unknown_fresh_vps"
                && body
                    .get("freshVpsFromScratch")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && fresh_automatic_no_checkpoint_rescue_eligible(request.as_ref())
                && accepted_checkpoint.as_ref().is_some_and(|candidate| {
                    complete_existing_incumbent_is_safe(&candidate.payload)
                        && fresh_automatic_terminal_quality_unmet(
                            request.as_ref(),
                            &candidate.payload,
                        )
                });
            let no_complete_checkpoint = failure_kind != "browser_wasm_partial_resume_checkpoint"
                && body
                    .get("noCompleteCheckpoint")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && accepted_checkpoint.is_none()
                && fresh_automatic_no_checkpoint_rescue_body_eligible(&ticket.request_body);
            let mobile_checkpoint_handoff =
                failure_kind == "browser_wasm_mobile_checkpoint_vps_refine";
            let fresh_vps_rescue_armed =
                if no_complete_checkpoint || fresh_vps_from_scratch || mobile_checkpoint_handoff {
                    // The Browser spent its bounded local attempt without giving
                    // the coordinator a publishable 0/0 result. Arm one bounded
                    // server-checked VPS rescue window before requeueing the lease.
                    // An exact-quality UNKNOWN discards only the rough checkpoint;
                    // ordinary failures, Stop, and checkpoint handoffs stay monotonic.
                    app.solver_pool
                        .request_no_checkpoint_vps_rescue(&ticket.job_id, &ticket.job_owner)
                } else {
                    false
                };
            // `/fail` is an explicit terminal surrender by either the native
            // protocol (`failure.kind`) or Browser protocol (`kind`). Keep the
            // worker online for later jobs, but fence this canonical job from
            // immediately reclaiming itself at the final VPS start gate.
            let _ = app.solver_pool.set_server_job_agent_preference(
                &ticket.job_id,
                &ticket.job_owner,
                false,
            );
            // A validated partial checkpoint is an explicit surrender to the
            // VPS, not a retry on the same Browser worker. Mark its task
            // completed so the claim loop cannot lease it again before the
            // coordinator atomically takes the resume checkpoint and advances
            // the canonical execution generation to VPS.
            let released = if fresh_vps_from_scratch {
                app.agent_helper.reject_submission_and_discard_checkpoints(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_ms,
                )
            } else if failure_kind == "browser_wasm_partial_resume_checkpoint"
                || mobile_checkpoint_handoff
            {
                // A checkpoint handoff is no longer claimable by another
                // Browser worker. The coordinator can atomically take the
                // accepted checkpoint while the rescue generation is rebased.
                app.agent_helper.accept_structured_outcome(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_ms,
                )
            } else {
                app.agent_helper.reject_submission(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_ms,
                )
            };
            match released {
                Ok(()) => json_response(
                    202,
                    json!({
                        "protocol":AGENT_HELPER_PROTOCOL,
                        "ok":true,
                        "requeued":true,
                        "freshVpsRescueArmed":fresh_vps_rescue_armed,
                        "freshVpsFromScratch":fresh_vps_from_scratch
                    }),
                ),
                Err(error) => agent_helper_error_json(error),
            }
        }
        _ => json_response(404, json!({"ok":false,"error":"not_found"})),
    }
}

fn auth_registry_get_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    let reg = auth::load_registry(&app.db);
    if !auth::can_read_registry(&session) {
        return auth::forbidden_response();
    }
    let scoped = scoped_auth_registry(&reg, &session);
    json_response(200, auth::strip_registry_for_client(scoped))
}

fn auth_session_get_json(app: &App, query: &str, auth_token: Option<&str>) -> Vec<u8> {
    let token = auth_token
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.to_string())
        .or_else(|| query_param(query, "token"))
        .filter(|t| !t.trim().is_empty());
    match token {
        Some(token) => auth::session_json(&app.db, &token),
        None => json_response(401, json!({"ok": false, "error": "missing_token"})),
    }
}

fn auth_registry_post_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !auth::can_write_registry(&session) {
        return auth::forbidden_response();
    }
    if let Ok(content) = String::from_utf8(body.to_vec()) {
        if let Ok(value) = serde_json::from_str::<Value>(&content) {
            let current = load_auth_registry_value(app);
            if let Some(ip) = duplicate_registration_ip(&current, &value) {
                return json_response(
                    409,
                    json!({
                        "ok": false,
                        "error": "duplicate_registration_ip",
                        "message": "IP này đã được dùng để đăng ký tài khoản trường. Mỗi IP chỉ được đăng ký 1 lần.",
                        "ip": ip
                    }),
                );
            }
            let role = session.get("role").and_then(Value::as_str).unwrap_or("");
            let mut merged = if role == "superadmin" {
                merge_auth_registry(&current, value)
            } else if role == "school_admin" {
                match merge_school_admin_registry(&current, &value, &session) {
                    Some(value) => value,
                    None => return auth::forbidden_response(),
                }
            } else {
                return auth::forbidden_response();
            };
            auth::restore_user_password_hashes(&current, &mut merged);
            let _ = app.db.set(
                "auth_registry",
                &serde_json::to_string(&merged).unwrap_or_default(),
            );
            return json_response(200, json!({"ok": true}));
        }
    }
    json_response(400, json!({"ok": false, "error": "invalid_json"}))
}

fn load_auth_registry_value(app: &App) -> Value {
    app.db
        .get("auth_registry")
        .ok()
        .flatten()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}))
}

fn scoped_auth_registry(registry: &Value, session: &Value) -> Value {
    let role = session.get("role").and_then(Value::as_str).unwrap_or("");
    if role == "superadmin" {
        return registry.clone();
    }

    let school_id = session
        .get("schoolId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let user_id = session
        .get("userId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if school_id.is_empty() || user_id.is_empty() {
        return json!({
            "version": 1,
            "users": {},
            "schools": {},
            "otpPending": {},
            "deletedSchools": {},
            "deletedUsers": {},
            "registeredIps": {},
            "blockedIps": {}
        });
    }

    let include_school_users = role == "school_admin";
    let mut users = Map::new();
    if let Some(all_users) = registry.get("users").and_then(Value::as_object) {
        for (id, user) in all_users {
            let belongs_to_school = user.get("schoolId").and_then(Value::as_str) == Some(school_id);
            let is_current_user =
                id == user_id || user.get("id").and_then(Value::as_str) == Some(user_id);
            if is_current_user || (include_school_users && belongs_to_school) {
                users.insert(id.clone(), user.clone());
            }
        }
    }

    let mut schools = Map::new();
    if let Some(school) = registry
        .get("schools")
        .and_then(Value::as_object)
        .and_then(|items| items.get(school_id))
    {
        schools.insert(school_id.to_string(), school.clone());
    }

    let mut registered_ips = Map::new();
    if include_school_users {
        if let Some(items) = registry.get("registeredIps").and_then(Value::as_object) {
            for (ip, entry) in items {
                if entry.get("schoolId").and_then(Value::as_str) == Some(school_id) {
                    registered_ips.insert(ip.clone(), entry.clone());
                }
            }
        }
    }

    json!({
        "version": registry.get("version").cloned().unwrap_or(json!(1)),
        "users": users,
        "schools": schools,
        "otpPending": {},
        "deletedSchools": {},
        "deletedUsers": {},
        "registeredIps": registered_ips,
        "blockedIps": {}
    })
}

fn copy_string_field(source: &Value, target: &mut Map<String, Value>, key: &str, max_len: usize) {
    let Some(value) = source.get(key).and_then(Value::as_str) else {
        return;
    };
    let value = value.trim();
    if value.len() <= max_len {
        target.insert(key.to_string(), json!(value));
    }
}

fn valid_password_hash(value: &str) -> bool {
    let value = value.trim();
    (value.starts_with("$argon2id$") && value.len() <= 512)
        || (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn sanitized_school_schedules(current_school: &Value, incoming_school: &Value) -> Option<Value> {
    let short_id = current_school
        .get("shortId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if short_id.is_empty() {
        return None;
    }
    let incoming = incoming_school.get("schedules")?.as_array()?;
    if incoming.is_empty() || incoming.len() > 100 {
        return None;
    }

    let mut seen = HashSet::new();
    let mut sanitized = Vec::with_capacity(incoming.len());
    for entry in incoming {
        let number = entry.get("number").and_then(Value::as_u64)?;
        if number == 0 || number > 999 || !seen.insert(number) {
            return None;
        }
        let mut safe = Map::new();
        safe.insert("number".to_string(), json!(number));
        safe.insert("sid".to_string(), json!(format!("{short_id}{number}")));
        copy_string_field(entry, &mut safe, "effectiveDate", 64);
        copy_string_field(entry, &mut safe, "label", 128);
        copy_string_field(entry, &mut safe, "createdAt", 64);
        if let Some(original) = entry.get("original").and_then(Value::as_bool) {
            safe.insert("original".to_string(), json!(original));
        }
        sanitized.push(Value::Object(safe));
    }
    Some(Value::Array(sanitized))
}

fn update_school_admin_school(current_school: &mut Value, incoming_school: &Value) {
    let schedules = sanitized_school_schedules(current_school, incoming_school);
    let Some(target) = current_school.as_object_mut() else {
        return;
    };
    for key in [
        "name",
        "ownerEmail",
        "ownerPhone",
        "scheduleNumber",
        "effectiveDate",
        "updatedAt",
    ] {
        copy_string_field(incoming_school, target, key, 512);
    }
    if let Some(schedules) = schedules {
        target.insert("schedules".to_string(), schedules);
    }
    if let Some(active) = incoming_school
        .get("activeSchedule")
        .and_then(Value::as_u64)
    {
        let exists = target
            .get("schedules")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("number").and_then(Value::as_u64) == Some(active))
            });
        if exists {
            target.insert("activeSchedule".to_string(), json!(active));
        }
    }
}

fn update_school_user_record(
    current_user: &mut Value,
    incoming_user: &Value,
    allow_active: bool,
    allow_email_verification: bool,
) {
    let Some(target) = current_user.as_object_mut() else {
        return;
    };
    for key in ["displayName", "email", "phone", "updatedAt"] {
        copy_string_field(incoming_user, target, key, 512);
    }
    if let Some(hash) = incoming_user.get("passwordHash").and_then(Value::as_str) {
        if valid_password_hash(hash) {
            target.insert("passwordHash".to_string(), json!(hash.trim()));
        }
    }
    if allow_active {
        if let Some(active) = incoming_user.get("active").and_then(Value::as_bool) {
            target.insert("active".to_string(), json!(active));
        }
    }
    // Email verification is monotonic. The signed-in school administrator may
    // confirm only their own record; an older tab can never turn it off again.
    if allow_email_verification
        && incoming_user.get("emailVerified").and_then(Value::as_bool) == Some(true)
    {
        target.insert("emailVerified".to_string(), json!(true));
    }
}

fn valid_new_school_user_id(raw: &str) -> Option<String> {
    let id = raw.trim().to_ascii_lowercase();
    if (3..=64).contains(&id.len()) && id.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        Some(id)
    } else {
        None
    }
}

fn new_school_user_record(id: &str, school_id: &str, incoming: &Value) -> Option<Value> {
    if incoming.get("role").and_then(Value::as_str) != Some("school_user")
        || incoming.get("schoolId").and_then(Value::as_str) != Some(school_id)
    {
        return None;
    }
    let hash = incoming.get("passwordHash").and_then(Value::as_str)?;
    if !valid_password_hash(hash) {
        return None;
    }
    let mut user = Map::new();
    user.insert("id".to_string(), json!(id));
    user.insert("role".to_string(), json!("school_user"));
    user.insert("schoolId".to_string(), json!(school_id));
    user.insert("passwordHash".to_string(), json!(hash.trim()));
    for key in ["displayName", "email", "phone", "createdAt", "updatedAt"] {
        copy_string_field(incoming, &mut user, key, 512);
    }
    user.insert(
        "active".to_string(),
        json!(incoming
            .get("active")
            .and_then(Value::as_bool)
            .unwrap_or(true)),
    );
    user.insert("emailVerified".to_string(), json!(true));
    Some(Value::Object(user))
}

fn merge_school_admin_registry(
    current: &Value,
    incoming: &Value,
    session: &Value,
) -> Option<Value> {
    let school_id = session.get("schoolId")?.as_str()?.trim();
    let session_user_id = session.get("userId")?.as_str()?.trim();
    if school_id.is_empty() || session_user_id.is_empty() {
        return None;
    }

    let mut merged = current.clone();
    let incoming_school = incoming
        .get("schools")
        .and_then(Value::as_object)
        .and_then(|schools| schools.get(school_id))
        .cloned();
    if let (Some(current_school), Some(incoming_school)) = (
        merged
            .get_mut("schools")
            .and_then(Value::as_object_mut)
            .and_then(|schools| schools.get_mut(school_id)),
        incoming_school.as_ref(),
    ) {
        update_school_admin_school(current_school, incoming_school);
    }

    let incoming_users = incoming
        .get("users")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let deleted_users: HashSet<String> = incoming
        .get("deletedUsers")
        .and_then(Value::as_object)
        .map(|items| items.keys().map(|id| id.to_ascii_lowercase()).collect())
        .unwrap_or_default();
    let users = merged.get_mut("users").and_then(Value::as_object_mut)?;

    let mut authorized_deleted_users = HashSet::new();
    for id in &deleted_users {
        let may_delete = users.get(id).is_some_and(|user| {
            user.get("schoolId").and_then(Value::as_str) == Some(school_id)
                && user.get("role").and_then(Value::as_str) == Some("school_user")
        });
        if may_delete {
            users.remove(id);
            authorized_deleted_users.insert(id.clone());
        }
    }

    let mut owner_email_verified = false;
    for (id, incoming_user) in &incoming_users {
        let Some(existing) = users.get_mut(id) else {
            continue;
        };
        if existing.get("schoolId").and_then(Value::as_str) != Some(school_id) {
            continue;
        }
        let role = existing.get("role").and_then(Value::as_str).unwrap_or("");
        let owns_admin_record = role == "school_admin" && id == session_user_id;
        let may_edit = role == "school_user" || owns_admin_record;
        if may_edit {
            update_school_user_record(
                existing,
                incoming_user,
                role == "school_user",
                owns_admin_record,
            );
            if owns_admin_record {
                owner_email_verified = existing
                    .get("emailVerified")
                    .and_then(Value::as_bool)
                    == Some(true);
            }
        }
    }

    let mut subuser_count = users
        .values()
        .filter(|user| {
            user.get("schoolId").and_then(Value::as_str) == Some(school_id)
                && user.get("role").and_then(Value::as_str) == Some("school_user")
        })
        .count();
    for (raw_id, incoming_user) in incoming_users {
        if subuser_count >= 5 {
            break;
        }
        let Some(id) = valid_new_school_user_id(&raw_id) else {
            continue;
        };
        if users.contains_key(&id) || authorized_deleted_users.contains(&id) {
            continue;
        }
        if let Some(user) = new_school_user_record(&id, school_id, &incoming_user) {
            users.insert(id, user);
            subuser_count += 1;
        }
    }

    if let Some(root) = merged.as_object_mut() {
        let deleted = root
            .entry("deletedUsers".to_string())
            .or_insert_with(|| json!({}));
        if let Some(items) = deleted.as_object_mut() {
            for id in authorized_deleted_users {
                items.insert(id, json!(crate::now_millis()));
            }
        }
    }

    if owner_email_verified {
        if let Some(school) = merged
            .get_mut("schools")
            .and_then(Value::as_object_mut)
            .and_then(|schools| schools.get_mut(school_id))
            .and_then(Value::as_object_mut)
        {
            school.insert("verified".to_string(), json!(true));
            let current_plan = school
                .get("plan")
                .and_then(Value::as_str)
                .unwrap_or("free")
                .trim()
                .to_ascii_lowercase();
            if current_plan == "trial" {
                school.insert("trialUsed".to_string(), json!(true));
            } else if current_plan == "free"
                && school.get("trialUsed").and_then(Value::as_bool) != Some(true)
            {
                let requested_expiry = incoming_school
                    .as_ref()
                    .filter(|value| {
                        value
                            .get("plan")
                            .and_then(Value::as_str)
                            .is_some_and(|plan| plan.eq_ignore_ascii_case("trial"))
                    })
                    .and_then(|value| value.get("expiresAt"))
                    .and_then(Value::as_str)
                    .and_then(|raw| plan_expiry_millis(raw).map(|expiry| (raw, expiry)));
                let now = now_millis();
                if let Some((raw_expiry, expiry)) = requested_expiry.filter(|(_, expiry)| {
                    *expiry > now
                        && *expiry <= now.saturating_add(31 * 24 * 60 * 60 * 1_000)
                }) {
                    school.insert("plan".to_string(), json!("trial"));
                    school.insert("expiresAt".to_string(), json!(raw_expiry));
                    school.insert("trialUsed".to_string(), json!(true));
                }
            }
        }
    }
    Some(merged)
}

fn duplicate_registration_ip(current: &Value, next: &Value) -> Option<String> {
    let current_schools = current.get("schools").and_then(Value::as_object);
    let next_schools = next.get("schools").and_then(Value::as_object)?;
    let mut used_ips = registration_ips_from_registry(current);
    let mut new_ips = HashSet::new();

    for (school_id, school) in next_schools {
        if current_schools
            .and_then(|schools| schools.get(school_id))
            .is_some()
        {
            continue;
        }
        let Some(ip) = registration_ip_from_school(school) else {
            continue;
        };
        if used_ips.contains(&ip) || !new_ips.insert(ip.clone()) {
            return Some(ip);
        }
        used_ips.insert(ip);
    }
    None
}

fn merge_auth_registry(current: &Value, next: Value) -> Value {
    let mut merged = if next.is_object() { next } else { json!({}) };
    if !merged.is_object() {
        merged = json!({});
    }

    merge_union_object(current, &mut merged, "deletedSchools");
    merge_union_object(current, &mut merged, "deletedUsers");
    merge_union_object(current, &mut merged, "registeredIps");

    let new_school_count = count_new_keys(current, &merged, "schools");
    let new_user_count = count_new_keys(current, &merged, "users");
    let additive_post = new_school_count > 0 || new_user_count > 0;

    let deleted_schools = object_key_set(&merged, "deletedSchools");
    let deleted_users = object_key_set(&merged, "deletedUsers");

    merge_entity_object(
        current,
        &mut merged,
        "schools",
        &deleted_schools,
        additive_post,
    );
    merge_users_object(
        current,
        &mut merged,
        &deleted_users,
        &deleted_schools,
        additive_post,
    );
    preserve_monotonic_verification(current, &mut merged);

    if additive_post {
        merge_union_object(current, &mut merged, "otpPending");
        merge_union_object(current, &mut merged, "blockedIps");
    }

    prune_deleted_school_ip_blocks(&mut merged, &deleted_schools);

    merged
}

fn preserve_monotonic_verification(current: &Value, merged: &mut Value) {
    if let (Some(current_users), Some(merged_users)) = (
        current.get("users").and_then(Value::as_object),
        merged.get_mut("users").and_then(Value::as_object_mut),
    ) {
        for (id, current_user) in current_users {
            if current_user.get("emailVerified").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            if let Some(user) = merged_users.get_mut(id).and_then(Value::as_object_mut) {
                user.insert("emailVerified".to_string(), json!(true));
            }
        }
    }
    if let (Some(current_schools), Some(merged_schools)) = (
        current.get("schools").and_then(Value::as_object),
        merged.get_mut("schools").and_then(Value::as_object_mut),
    ) {
        for (id, current_school) in current_schools {
            let Some(school) = merged_schools.get_mut(id).and_then(Value::as_object_mut) else {
                continue;
            };
            for key in ["verified", "trialUsed"] {
                if current_school.get(key).and_then(Value::as_bool) == Some(true) {
                    school.insert(key.to_string(), json!(true));
                }
            }
        }
    }
}

fn prune_deleted_school_ip_blocks(registry: &mut Value, deleted_schools: &HashSet<String>) {
    if deleted_schools.is_empty() {
        return;
    }
    if let Some(blocked_ips) = registry
        .get_mut("blockedIps")
        .and_then(Value::as_object_mut)
    {
        blocked_ips.retain(|_, entry| {
            let school_id = entry
                .get("schoolId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            school_id.is_empty()
                || !deleted_schools
                    .iter()
                    .any(|deleted_id| deleted_id.eq_ignore_ascii_case(school_id))
        });
    }
}

fn count_new_keys(current: &Value, next: &Value, key: &str) -> usize {
    let current_obj = current.get(key).and_then(Value::as_object);
    next.get(key)
        .and_then(Value::as_object)
        .map(|obj| {
            obj.keys()
                .filter(|id| current_obj.and_then(|cur| cur.get(*id)).is_none())
                .count()
        })
        .unwrap_or(0)
}

fn object_key_set(registry: &Value, key: &str) -> HashSet<String> {
    registry
        .get(key)
        .and_then(Value::as_object)
        .map(|obj| obj.keys().map(|id| id.to_string()).collect())
        .unwrap_or_default()
}

fn merge_union_object(current: &Value, merged: &mut Value, key: &str) {
    let mut out = current
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(next_obj) = merged.get(key).and_then(Value::as_object) {
        for (id, value) in next_obj {
            out.insert(id.to_string(), value.clone());
        }
    }
    if let Some(root) = merged.as_object_mut() {
        root.insert(key.to_string(), Value::Object(out));
    }
}

fn merge_entity_object(
    current: &Value,
    merged: &mut Value,
    key: &str,
    deleted: &HashSet<String>,
    additive_post: bool,
) {
    let current_obj = current.get(key).and_then(Value::as_object);
    let next_obj = merged.get(key).and_then(Value::as_object);
    let mut out = current_obj.cloned().unwrap_or_default();

    if let Some(next_obj) = next_obj {
        for (id, value) in next_obj {
            if additive_post && current_obj.and_then(|cur| cur.get(id)).is_some() {
                continue;
            }
            out.insert(id.to_string(), value.clone());
        }
    }

    for id in deleted {
        out.remove(id);
    }
    if let Some(root) = merged.as_object_mut() {
        root.insert(key.to_string(), Value::Object(out));
    }
}

fn merge_users_object(
    current: &Value,
    merged: &mut Value,
    deleted_users: &HashSet<String>,
    deleted_schools: &HashSet<String>,
    additive_post: bool,
) {
    let current_obj = current.get("users").and_then(Value::as_object);
    let next_obj = merged.get("users").and_then(Value::as_object);
    let mut out = current_obj.cloned().unwrap_or_default();

    if let Some(next_obj) = next_obj {
        for (id, value) in next_obj {
            if additive_post && current_obj.and_then(|cur| cur.get(id)).is_some() {
                continue;
            }
            out.insert(id.to_string(), value.clone());
        }
    }

    out.retain(|id, value| {
        if deleted_users.contains(id) {
            return false;
        }
        let sid = value
            .get("schoolId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        !deleted_schools.contains(sid)
    });

    if let Some(root) = merged.as_object_mut() {
        root.insert("users".to_string(), Value::Object(out));
    }
}

fn registration_ips_from_registry(registry: &Value) -> HashSet<String> {
    let mut ips = HashSet::new();
    if let Some(registered) = registry.get("registeredIps").and_then(Value::as_object) {
        for (ip, entry) in registered {
            let addr = ip.trim();
            if !addr.is_empty() && registration_ip_owner_exists(registry, entry) {
                ips.insert(addr.to_string());
            }
        }
    }
    if let Some(schools) = registry.get("schools").and_then(Value::as_object) {
        for school in schools.values() {
            if let Some(ip) = registration_ip_from_school(school) {
                ips.insert(ip);
            }
        }
    }
    ips
}

fn registration_ip_owner_exists(registry: &Value, entry: &Value) -> bool {
    let school_id = entry
        .get("schoolId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let user_id = entry
        .get("userId")
        .or_else(|| entry.get("loginId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let school_exists = !school_id.is_empty()
        && registry
            .get("schools")
            .and_then(Value::as_object)
            .is_some_and(|schools| schools.contains_key(school_id));
    let user_exists = !user_id.is_empty()
        && registry
            .get("users")
            .and_then(Value::as_object)
            .is_some_and(|users| {
                users.iter().any(|(key, user)| {
                    key.eq_ignore_ascii_case(user_id)
                        || user
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| id.eq_ignore_ascii_case(user_id))
                })
            });
    school_exists || user_exists
}

fn registration_ip_from_school(school: &Value) -> Option<String> {
    if !school
        .as_object()
        .map(|obj| obj.contains_key("trialUsed"))
        .unwrap_or(false)
    {
        return None;
    }
    let addr = school
        .get("ips")
        .and_then(Value::as_array)
        .and_then(|ips| ips.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if addr.is_empty() {
        None
    } else {
        Some(addr.to_string())
    }
}

fn school_store_get_json(app: &App, query: &str, auth_token: Option<&str>) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    let id = query_param(query, "id").unwrap_or_default();
    if id.is_empty() {
        return json_response(400, json!({"error": "missing_id"}));
    }
    let reg = auth::load_registry(&app.db);
    if !auth::can_access_school_store(&session, &id, &reg) {
        return auth::forbidden_response();
    }
    let key = format!("school_{id}");
    if let Ok(Some(content)) = app.db.get(&key) {
        return json_response(
            200,
            serde_json::from_str::<Value>(&content).unwrap_or(json!({})),
        );
    }
    json_response(200, json!({}))
}

fn canonical_store_identity(raw: &str) -> String {
    raw.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn registry_school_for_store<'a>(
    registry: &'a Value,
    session: &Value,
    store_id: &str,
) -> Option<&'a Value> {
    let role = session
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if role != "superadmin" {
        return session
            .get("schoolId")
            .and_then(Value::as_str)
            .and_then(|school_id| registry_school_by_id(registry, school_id));
    }

    let target = canonical_store_identity(store_id);
    if target.is_empty() {
        return None;
    }
    let schools = registry.get("schools").and_then(Value::as_object)?;

    // Prefer exact server-owned IDs and schedule IDs. Only then accept the
    // legacy short-ID prefix used by old timetable stores.
    for (id, school) in schools {
        let recorded_id = school.get("id").and_then(Value::as_str).unwrap_or("");
        let exact_school = canonical_store_identity(id) == target
            || canonical_store_identity(recorded_id) == target;
        let exact_schedule = school
            .get("schedules")
            .and_then(Value::as_array)
            .is_some_and(|schedules| {
                schedules.iter().any(|schedule| {
                    schedule
                        .get("sid")
                        .and_then(Value::as_str)
                        .is_some_and(|sid| canonical_store_identity(sid) == target)
                })
            });
        if exact_school || exact_schedule {
            return Some(school);
        }
    }
    schools.values().find(|school| {
        school
            .get("shortId")
            .and_then(Value::as_str)
            .map(canonical_store_identity)
            .is_some_and(|short_id| !short_id.is_empty() && target.starts_with(&short_id))
    })
}

fn school_store_post_json(
    app: &App,
    query: &str,
    auth_token: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    let id = query_param(query, "id").unwrap_or_default();
    if id.is_empty() {
        return json_response(400, json!({"error": "missing_id"}));
    }
    let reg = auth::load_registry(&app.db);
    if !auth::can_access_school_store(&session, &id, &reg) {
        return auth::forbidden_response();
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return json_response(400, json!({"ok": false, "error": "invalid_json"}));
    };
    let store_policy = registry_school_for_store(&reg, &session, &id)
        .map(solver_plan_policy_for_school)
        .unwrap_or(SolverPlanPolicy::Unknown);
    let class_count = class_count_from_school_data(&value);
    if matches!(store_policy, SolverPlanPolicy::Max1) {
        if let Some(class_count) = class_count {
            if class_count > MAX1_CLASS_LIMIT {
                return max1_class_limit_response(class_count);
            }
        }
    }
    if matches!(store_policy, SolverPlanPolicy::Unknown) {
        let superadmin = session
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role.eq_ignore_ascii_case("superadmin"));
        let superadmin_default_store = superadmin && canonical_store_identity(&id) == "default";
        // A school account must always resolve through its authenticated
        // registry record. The owner's historical `default` Super Admin store
        // is explicitly unscoped and remains unlimited; any other unowned store
        // cannot silently claim Max 2 capacity.
        if !superadmin
            || (!superadmin_default_store
                && class_count.is_some_and(|count| count > MAX1_CLASS_LIMIT))
        {
            return school_plan_unavailable_response();
        }
    }
    let key = format!("school_{id}");
    let content = match serde_json::to_string(&value) {
        Ok(content) => content,
        Err(_) => return json_response(400, json!({"ok": false, "error": "invalid_json"})),
    };
    match app.db.set(&key, &content) {
        Ok(()) => json_response(200, json!({"ok": true})),
        Err(error) => {
            eprintln!("school store write failed: {error}");
            json_response(
                503,
                json!({"ok": false, "kind": "school_store_write_failed"}),
            )
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn server_watchdog_remaining_from_snapshot(
    snapshot: &ServerJobSnapshot,
    now_ms: u64,
) -> Option<u64> {
    let budget_ms = snapshot.watchdog_budget_ms?;
    let started_ms = snapshot.watchdog_started_ms?;
    Some(budget_ms.saturating_sub(now_ms.saturating_sub(started_ms)))
}

/// Return the one canonical start timestamp shared by every observer of a
/// server-owned job.  The watchdog starts when the coordinator reserves the
/// executor and remains unchanged across Agent/VPS handoff; a claimed job
/// without a watchdog (legacy/unit callers) falls back to its creation time.
fn server_job_started_at_ms(snapshot: &ServerJobSnapshot) -> Option<u64> {
    snapshot
        .watchdog_started_ms
        .or_else(|| (snapshot.created_ms > 0).then_some(snapshot.created_ms))
}

fn server_job_started_at_for_owner(app: &App, job_id: &str, owner: &SolverOwner) -> Option<u64> {
    app.solver_pool
        .server_job_snapshots_for_owner(owner)
        .into_iter()
        .find(|job| job.job_id == job_id)
        .and_then(|job| server_job_started_at_ms(&job))
}

fn solver_state_json(app: &App, query: &str, owner: &SolverOwner) -> Vec<u8> {
    let pool = &app.solver_pool;
    let requested_job_id = query_param(query, "jobId").unwrap_or_default();
    let requested_job_queued = !requested_job_id.is_empty()
        && app
            .solver_pool
            .touch_queued_job_for_owner(&requested_job_id, owner);
    let active_jobs = pool.active_count();
    let max_concurrent = pool.max_concurrent();
    let slots_available = pool.slots_available();
    let server_jobs = pool.server_job_snapshots_for_owner(owner);
    let mut jobs = pool
        .snapshot_for_owner(owner)
        .into_iter()
        .map(
            |(job_id, started_at_ms, cancel_requested, allocated_workers)| {
                let server_job = server_jobs.iter().find(|job| job.job_id == job_id);
                let canonical_started_at_ms =
                    server_job.and_then(server_job_started_at_ms);
                json!({
                    "jobId": job_id,
                    "startedAtMs": canonical_started_at_ms.unwrap_or(started_at_ms),
                    "createdAtMs": server_job.map(|job| job.created_ms),
                    "scheduleScope": server_job.and_then(|job| job.schedule_scope.as_deref()),
                    "scheduleFingerprint": server_job.and_then(|job| job.schedule_fingerprint.as_deref()),
                    "progressBudgetSeconds": server_job.and_then(|job| job.progress_budget_seconds),
                    "progressRunIndex": server_job.and_then(|job| job.progress_run_index),
                     "progress": server_job.and_then(|job| job.progress.as_ref()),
                     "progressUpdatedAtMs": server_job.and_then(|job| job.progress_updated_ms),
                     "watchdogBudgetMs": server_job.and_then(|job| job.watchdog_budget_ms),
                     "watchdogStartedAtMs": server_job.and_then(|job| job.watchdog_started_ms),
                     "watchdogRemainingMs": server_job.and_then(|job| server_watchdog_remaining_from_snapshot(job, now_millis())),
                     "serverOwned": server_job.is_some(),
                    "executor": server_job.and_then(|job| job.execution_phase.executor()).map(ServerExecutor::as_str),
                    "executionPhase": server_job.map(|job| job.execution_phase.as_str()),
                    "executionGeneration": server_job.map(|job| job.execution_generation),
                    "handoffInProgress": server_job.is_some_and(|job| job.execution_phase.handoff_in_progress()),
                    "cancelRequested": cancel_requested,
                    "bestEffortStopRequested": server_job.is_some_and(|job| job.best_effort_stop_requested),
                    "allocatedWorkers": allocated_workers
                })
            },
        )
        .collect::<Vec<_>>();
    let requested_job_result_ready = !requested_job_id.is_empty()
        && pool
            .completed_server_response_for_owner(&requested_job_id, owner)
            .is_some();
    let requested_job_server_owned =
        !requested_job_id.is_empty() && pool.server_job_known_for_owner(&requested_job_id, owner);
    let queue = pool
        .queue_snapshot_for_owner(owner)
        .into_iter()
        .map(|(job_id, queued_at_ms, position, desired_workers)| {
            let server_job = server_jobs.iter().find(|job| job.job_id == job_id);
            json!({
                "jobId": job_id,
                "position": position,
                "queuedAtMs": queued_at_ms,
                // A queued server job may already have a canonical watchdog
                // start (the coordinator reserves it before FIFO admission).
                // Do not invent one from creation time while it is merely
                // waiting for workers.
                "startedAtMs": server_job.and_then(|job| job.watchdog_started_ms),
                "createdAtMs": server_job.map(|job| job.created_ms),
                "scheduleScope": server_job.and_then(|job| job.schedule_scope.as_deref()),
                "scheduleFingerprint": server_job.and_then(|job| job.schedule_fingerprint.as_deref()),
                "progressBudgetSeconds": server_job.and_then(|job| job.progress_budget_seconds),
                "progressRunIndex": server_job.and_then(|job| job.progress_run_index),
                 "progress": server_job.and_then(|job| job.progress.as_ref()),
                 "progressUpdatedAtMs": server_job.and_then(|job| job.progress_updated_ms),
                 "watchdogBudgetMs": server_job.and_then(|job| job.watchdog_budget_ms),
                 "watchdogStartedAtMs": server_job.and_then(|job| job.watchdog_started_ms),
                 "watchdogRemainingMs": server_job.and_then(|job| server_watchdog_remaining_from_snapshot(job, now_millis())),
                 "serverOwned": server_job.is_some(),
                "executor": server_job.and_then(|job| job.execution_phase.executor()).map(ServerExecutor::as_str),
                "executionPhase": server_job.map(|job| job.execution_phase.as_str()),
                "executionGeneration": server_job.map(|job| job.execution_generation),
                "handoffInProgress": server_job.is_some_and(|job| job.execution_phase.handoff_in_progress()),
                "bestEffortStopRequested": server_job.is_some_and(|job| job.best_effort_stop_requested),
                "desiredWorkers": desired_workers
            })
        })
        .collect::<Vec<_>>();
    for server_job in server_jobs.iter().filter(|job| job.completed_ms.is_none()) {
        let represented = jobs.iter().chain(queue.iter()).any(|item| {
            item.get("jobId").and_then(Value::as_str) == Some(server_job.job_id.as_str())
        });
        if represented {
            continue;
        }
        jobs.push(json!({
            "jobId": server_job.job_id,
            "startedAtMs": server_job_started_at_ms(server_job),
            "createdAtMs": server_job.created_ms,
            "scheduleScope": server_job.schedule_scope,
            "scheduleFingerprint": server_job.schedule_fingerprint,
            "progressBudgetSeconds": server_job.progress_budget_seconds,
            "progressRunIndex": server_job.progress_run_index,
             "progress": server_job.progress,
             "progressUpdatedAtMs": server_job.progress_updated_ms,
             "watchdogBudgetMs": server_job.watchdog_budget_ms,
             "watchdogStartedAtMs": server_job.watchdog_started_ms,
             "watchdogRemainingMs": server_watchdog_remaining_from_snapshot(server_job, now_millis()),
             "serverOwned": true,
            "executor": server_job.execution_phase.executor().map(ServerExecutor::as_str),
            "executionPhase": server_job.execution_phase.as_str(),
            "executionGeneration": server_job.execution_generation,
            "handoffInProgress": server_job.execution_phase.handoff_in_progress(),
            "cancelRequested": matches!(server_job.execution_phase, ServerExecutionPhase::Cancelling),
            "bestEffortStopRequested": server_job.best_effort_stop_requested,
            "allocatedWorkers": 0
        }));
    }
    let requested_job_active = !requested_job_id.is_empty()
        && jobs
            .iter()
            .any(|job| job.get("jobId").and_then(Value::as_str) == Some(requested_job_id.as_str()));
    let mut completed_server_jobs = server_jobs
        .iter()
        .filter(|job| job.completed_ms.is_some())
        .collect::<Vec<_>>();
    completed_server_jobs.sort_unstable_by(|left, right| {
        right
            .completed_ms
            .cmp(&left.completed_ms)
            .then_with(|| right.created_ms.cmp(&left.created_ms))
            .then_with(|| left.job_id.cmp(&right.job_id))
    });
    let completed_jobs = completed_server_jobs
        .into_iter()
        .map(|job| {
            json!({
                "jobId": job.job_id,
                "startedAtMs": server_job_started_at_ms(job),
                "createdAtMs": job.created_ms,
                "completedAtMs": job.completed_ms,
                "scheduleScope": job.schedule_scope,
                "scheduleFingerprint": job.schedule_fingerprint,
                "progressBudgetSeconds": job.progress_budget_seconds,
                "progressRunIndex": job.progress_run_index,
                 "progress": job.progress,
                 "progressUpdatedAtMs": job.progress_updated_ms,
                 "watchdogBudgetMs": job.watchdog_budget_ms,
                 "watchdogStartedAtMs": job.watchdog_started_ms,
                 "watchdogRemainingMs": server_watchdog_remaining_from_snapshot(job, now_millis()),
                 "executor": job.execution_phase.executor().map(ServerExecutor::as_str),
                "executionPhase": job.execution_phase.as_str(),
                "executionGeneration": job.execution_generation,
                "bestEffortStopRequested": job.best_effort_stop_requested
            })
        })
        .collect::<Vec<_>>();
    let owned_active_jobs = jobs.len();
    let owned_queued_jobs = queue.len();
    let owned_completed_jobs = completed_jobs.len();
    let requested_server_job = server_jobs
        .iter()
        .find(|job| job.job_id == requested_job_id);
    json_response(
        200,
        json!({
            "ok": true,
            "busy": pool.at_capacity(),
            "activeJobs": active_jobs,
            "maxConcurrent": max_concurrent,
            "minWorkersPerJob": pool.min_workers_per_job(),
            "maxWorkersPerJob": pool.max_workers_per_job(),
            "workerTokensTotal": pool.total_worker_tokens(),
            "workerTokensAllocated": pool.allocated_worker_tokens(),
            "workerTokensAvailable": pool.available_worker_tokens(),
            "slotsAvailable": slots_available,
            "jobs": jobs,
            "queuedJobs": pool.queued_count(),
            "ownedActiveJobs": owned_active_jobs,
            "ownedQueuedJobs": owned_queued_jobs,
            "ownedCompletedJobs": owned_completed_jobs,
            "queue": queue,
            "completedJobs": completed_jobs,
            "requestedJobId": requested_job_id,
            "requestedJobActive": requested_job_active,
            "requestedJobQueued": requested_job_queued,
            "requestedJobServerOwned": requested_job_server_owned,
            "requestedJobResultReady": requested_job_result_ready,
            "requestedJobStartedAtMs": requested_server_job.and_then(server_job_started_at_ms),
            "requestedJobProgress": requested_server_job.and_then(|job| job.progress.as_ref()),
             "requestedJobProgressUpdatedAtMs": requested_server_job.and_then(|job| job.progress_updated_ms),
             "requestedJobWatchdogBudgetMs": requested_server_job.and_then(|job| job.watchdog_budget_ms),
             "requestedJobWatchdogStartedAtMs": requested_server_job.and_then(|job| job.watchdog_started_ms),
             "requestedJobWatchdogRemainingMs": requested_server_job.and_then(|job| server_watchdog_remaining_from_snapshot(job, now_millis())),
             "requestedJobExecutor": requested_server_job.and_then(|job| job.execution_phase.executor()).map(ServerExecutor::as_str),
            "requestedJobExecutionPhase": requested_server_job.map(|job| job.execution_phase.as_str()),
            "requestedJobHandoffInProgress": requested_server_job.is_some_and(|job| job.execution_phase.handoff_in_progress()),
            "requestedJobBestEffortStopRequested": requested_server_job.is_some_and(|job| job.best_effort_stop_requested)
        }),
    )
}

fn solve_result_json(app: &App, query: &str, owner: &SolverOwner) -> Vec<u8> {
    let job_id = query_param(query, "jobId").unwrap_or_default();
    if job_id.is_empty() {
        return json_response(
            400,
            json!({"ok": false, "kind": "missing_job_id", "error": "missing_job_id"}),
        );
    }
    solve_result_for_job_id_json(app, &job_id, owner)
}

fn solve_result_for_job_id_json(app: &App, job_id: &str, owner: &SolverOwner) -> Vec<u8> {
    let server_job = app
        .solver_pool
        .server_job_snapshots_for_owner(owner)
        .into_iter()
        .find(|job| job.job_id == job_id);
    if let Some(response) = app
        .solver_pool
        .completed_server_response_for_owner(job_id, owner)
    {
        return solver_response_with_progress(
            response,
            server_job.as_ref().and_then(|job| job.progress.as_ref()),
            server_job.as_ref().and_then(|job| job.progress_updated_ms),
            server_job.as_ref().and_then(server_job_started_at_ms),
            server_job
                .as_ref()
                .is_some_and(|job| job.best_effort_stop_requested),
        );
    }
    if !app.solver_pool.server_job_known_for_owner(job_id, owner) {
        return json_response(
            404,
            json!({
                "ok": false,
                "kind": "solver_job_not_found",
                "error": "solver_job_not_found",
                "jobId": job_id
            }),
        );
    }
    let progress_budget_seconds = server_job
        .as_ref()
        .and_then(|job| job.progress_budget_seconds);
    let progress_run_index = server_job.as_ref().and_then(|job| job.progress_run_index);
    let progress = server_job.as_ref().and_then(|job| job.progress.as_ref());
    let progress_updated_ms = server_job.as_ref().and_then(|job| job.progress_updated_ms);
    let watchdog_budget_ms = server_job.as_ref().and_then(|job| job.watchdog_budget_ms);
    let watchdog_started_ms = server_job.as_ref().and_then(|job| job.watchdog_started_ms);
    let watchdog_remaining_ms = server_job
        .as_ref()
        .and_then(|job| server_watchdog_remaining_from_snapshot(job, now_millis()));
    let canonical_started_at_ms = server_job.as_ref().and_then(server_job_started_at_ms);
    let queue_item = app
        .solver_pool
        .queue_snapshot_for_owner(owner)
        .into_iter()
        .find(|(queued_job_id, _, _, _)| queued_job_id.as_str() == job_id);
    if let Some((_, queued_ms, position, desired_workers)) = queue_item {
        return json_response(
            202,
            json!({
                "ok": false,
                "queued": true,
                "serverOwned": true,
                "kind": "solver_queued",
                "error": "solver_queued",
                "jobId": job_id,
                "startedAtMs": server_job
                    .as_ref()
                    .and_then(|job| job.watchdog_started_ms),
                "queuePosition": position,
                "queuedAtMs": queued_ms,
                "progressBudgetSeconds": progress_budget_seconds,
                "progressRunIndex": progress_run_index,
                 "progress": progress,
                 "progressUpdatedAtMs": progress_updated_ms,
                 "watchdogBudgetMs": watchdog_budget_ms,
                 "watchdogStartedAtMs": watchdog_started_ms,
                 "watchdogRemainingMs": watchdog_remaining_ms,
                 "executor": ServerExecutor::Vps.as_str(),
                "executionPhase": server_job
                    .as_ref()
                    .map(|job| job.execution_phase.as_str()),
                "bestEffortStopRequested": server_job
                    .as_ref()
                    .is_some_and(|job| job.best_effort_stop_requested),
                "retryAfterMs": 700,
                "requiredWorkers": desired_workers
            }),
        );
    }
    let running = app
        .solver_pool
        .snapshot_for_owner(owner)
        .into_iter()
        .find(|(running_job_id, _, _, _)| running_job_id.as_str() == job_id);
    if let Some((_, started_ms, cancel_requested, allocated_workers)) = running {
        return json_response(
            202,
            json!({
                "ok": false,
                "running": true,
                "serverOwned": true,
                "kind": "solver_running",
                "error": "solver_running",
                "jobId": job_id,
                "startedAtMs": canonical_started_at_ms.unwrap_or(started_ms),
                "progressBudgetSeconds": progress_budget_seconds,
                "progressRunIndex": progress_run_index,
                 "progress": progress,
                 "progressUpdatedAtMs": progress_updated_ms,
                 "watchdogBudgetMs": watchdog_budget_ms,
                 "watchdogStartedAtMs": watchdog_started_ms,
                 "watchdogRemainingMs": watchdog_remaining_ms,
                 "executor": ServerExecutor::Vps.as_str(),
                "executionPhase": server_job
                    .as_ref()
                    .map(|job| job.execution_phase.as_str()),
                "cancelRequested": cancel_requested,
                "bestEffortStopRequested": server_job
                    .as_ref()
                    .is_some_and(|job| job.best_effort_stop_requested),
                "allocatedWorkers": allocated_workers,
                "retryAfterMs": 700
            }),
        );
    }
    if let Some(server_job) = server_job.as_ref() {
        if server_job.completed_ms.is_none()
            && matches!(
                server_job.execution_phase,
                ServerExecutionPhase::Pending
                    | ServerExecutionPhase::ServerlessQueued
                    | ServerExecutionPhase::ServerlessRunning
                    | ServerExecutionPhase::VpsQueued
                    | ServerExecutionPhase::HandoffToAgent
                    | ServerExecutionPhase::AgentWaiting
                    | ServerExecutionPhase::AgentRunning
                    | ServerExecutionPhase::Cancelling
            )
        {
            return json_response(
                202,
                json!({
                    "ok": false,
                    "running": true,
                    "serverOwned": true,
                    "kind": "solver_running",
                    "error": "solver_running",
                    "jobId": job_id,
                    "startedAtMs": canonical_started_at_ms,
                    "executor": server_job.execution_phase.executor().map(ServerExecutor::as_str),
                    "executionPhase": server_job.execution_phase.as_str(),
                    "handoffInProgress": server_job.execution_phase.handoff_in_progress(),
                    "progressBudgetSeconds": progress_budget_seconds,
                    "progressRunIndex": progress_run_index,
                     "progress": progress,
                     "progressUpdatedAtMs": progress_updated_ms,
                     "watchdogBudgetMs": watchdog_budget_ms,
                     "watchdogStartedAtMs": watchdog_started_ms,
                     "watchdogRemainingMs": watchdog_remaining_ms,
                     "cancelRequested": server_job.execution_phase == ServerExecutionPhase::Cancelling,
                    "bestEffortStopRequested": server_job.best_effort_stop_requested,
                    "allocatedWorkers": 0,
                    "retryAfterMs": 700
                }),
            );
        }
    }
    json_response(
        202,
        json!({
            "ok": false,
            "serverOwned": true,
            "kind": "solver_cancelling",
            "error": "solver_cancelling",
            "jobId": job_id,
            "startedAtMs": canonical_started_at_ms,
            "progressBudgetSeconds": progress_budget_seconds,
            "progressRunIndex": progress_run_index,
             "progress": progress,
             "progressUpdatedAtMs": progress_updated_ms,
             "watchdogBudgetMs": watchdog_budget_ms,
             "watchdogStartedAtMs": watchdog_started_ms,
             "watchdogRemainingMs": watchdog_remaining_ms,
            "bestEffortStopRequested": server_job
                .as_ref()
                .is_some_and(|job| job.best_effort_stop_requested),
             "retryAfterMs": 250
        }),
    )
}

fn solve_cancel_json(app: &App, body: &[u8], owner: &SolverOwner) -> Vec<u8> {
    let job_id = job_id_from_cancel_body(body);
    let retain_best = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("retainBest").and_then(Value::as_bool))
        .unwrap_or(false);
    if !retain_best
        && !job_id.is_empty()
        && app.solver_pool.server_job_known_for_owner(&job_id, owner)
    {
        // Persist the owner-authorized cancellation before opening the
        // in-memory cancellation fence. A Cloud completion racing this call
        // will therefore reconcile as cancelled even if it reaches SQLite
        // immediately after the pool transition.
        app.serverless.mark_cancel_requested(&job_id);
    }
    let requested = if job_id.is_empty() {
        false
    } else if retain_best {
        app.solver_pool
            .request_best_effort_stop_for_owner(&job_id, owner)
    } else {
        app.solver_pool.cancel_job_for_owner(&job_id, owner)
    };
    if requested && !retain_best {
        external_cp_sat_streams().remove_job(&job_id);
        // A queued Cloud job has not consumed billable compute and can release
        // its durable quota immediately. A dispatched row is intentionally
        // retained for the Cloud coordinator to record measured cancellation
        // cost exactly once.
        app.serverless.release_before_dispatch(&job_id);
    }
    json_response(
        200,
        json!({
            "ok": true,
            "cancelRequested": requested && !retain_best,
            "bestEffortStopRequested": requested && retain_best,
            "jobId": job_id,
            "activeJobs": app.solver_pool.active_count(),
            "maxConcurrent": app.solver_pool.max_concurrent(),
            "workerTokensAllocated": app.solver_pool.allocated_worker_tokens(),
            "workerTokensAvailable": app.solver_pool.available_worker_tokens(),
            "queuedJobs": app.solver_pool.queued_count(),
            "slotsAvailable": app.solver_pool.slots_available()
        }),
    )
}

fn health_json(app: &App) -> Vec<u8> {
    let solver_helper = reference_solver_script(app);
    let reference_helpers = reference_helper_process_limiter().snapshot();
    let serverless_config = app.serverless.config();
    let serverless_usage = app.serverless.usage_json();
    json_response(
        200,
        json!({
            "ok": true,
            "app": "tkb_new",
            "api": "rust",
            "version": VERSION,
            "appRoot": app.root.display().to_string(),
            "webRoot": app.web_root.display().to_string(),
            "exePath": env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
            "sampleBackend": "rust-static",
            "fixtureBackend": "rust-static",
            "solverBackend": if solver_helper.is_some() { "hybrid-reference-cp-sat-milp+rust-fallback" } else { "native-rust" },
            "solverNative": true,
            "solverMaxConcurrent": app.solver_pool.max_concurrent(),
            "solverWorkerTokensTotal": app.solver_pool.total_worker_tokens(),
            "solverMinWorkersPerJob": app.solver_pool.min_workers_per_job(),
            "solverMaxWorkersPerJob": app.solver_pool.max_workers_per_job(),
            "solverWorkerTokensAllocated": app.solver_pool.allocated_worker_tokens(),
            "solverWorkerTokensAvailable": app.solver_pool.available_worker_tokens(),
            "solverActiveJobs": app.solver_pool.active_count(),
            "solverQueuedJobs": app.solver_pool.queued_count(),
            "serverless": {
                "configured": serverless_config.selected_profile().is_some(),
                "mode": serverless_config.mode.as_str(),
                "fallback": serverless_config.fallback,
                "activeReservations": serverless_usage.get("activeReservations").cloned().unwrap_or(Value::Null)
            },
            "agentReferenceHelpers": {
                "limit": reference_helpers.limit,
                "active": reference_helpers.active,
                "modelBuildersActive": reference_helpers.model_builders_active,
                "candidateValidatorsActive": reference_helpers.candidate_validators_active,
                "peakActive": reference_helpers.peak_active,
                "waiting": reference_helpers.waiting,
                "starts": reference_helpers.starts,
                "admissionTimeouts": reference_helpers.admission_timeouts
            },
            "solverHelper": solver_helper.map(|path| path.display().to_string()).unwrap_or_default(),
            "algorithmStatus": if reference_solver_script(app).is_some() { "hybrid-reference-cp-sat-milp-v1" } else { "native-rust-teacher-gap-repair-v15" }
        }),
    )
}

fn sample_data_json(app: &App) -> Vec<u8> {
    match fs::read(&app.sample_data) {
        Ok(bytes) => http_response(200, "application/json; charset=utf-8", &bytes),
        Err(err) => json_response(
            500,
            json!({
                "ok": false,
                "error": format!("failed_to_read_sample_data: {err}")
            }),
        ),
    }
}

fn native_solve_precheck(body: &[u8]) -> Vec<u8> {
    match native_precheck::solve_precheck_json(body) {
        Ok(payload) => http_response(200, "application/json; charset=utf-8", payload.as_bytes()),
        Err(err) => json_response(
            400,
            json!({
                "ok": false,
                "kind": "precheck_failed",
                "error": err
            }),
        ),
    }
}

fn value_truthy(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_i64().unwrap_or(0) != 0,
        Value::String(value) => {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        }
        _ => false,
    }
}

fn request_settings(request: &Value) -> Option<&serde_json::Map<String, Value>> {
    request.get("settings").and_then(Value::as_object)
}

fn setting_bool(
    settings: Option<&serde_json::Map<String, Value>>,
    key: &str,
    default: bool,
) -> bool {
    settings
        .and_then(|items| items.get(key))
        .map(value_truthy)
        .unwrap_or(default)
}

fn setting_string(settings: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    settings
        .and_then(|items| items.get(key))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn solver_schedule_fingerprint(request: Option<&Value>) -> Option<String> {
    let request = request?;
    let settings = request_settings(request);
    setting_string(settings, "ui_schedule_fingerprint")
        .or_else(|| setting_string(settings, "schedule_fingerprint"))
        .or_else(|| {
            request
                .get("scheduleFingerprint")
                .or_else(|| request.get("schedule_fingerprint"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn solver_schedule_scope(request: Option<&Value>) -> Option<String> {
    let request = request?;
    let settings = request_settings(request);
    setting_string(settings, "ui_schedule_scope")
        .or_else(|| setting_string(settings, "schedule_scope"))
}

fn hybrid_cloud_run_requested(request: Option<&Value>) -> bool {
    request
        .and_then(request_settings)
        .and_then(|settings| setting_string(Some(settings), "ui_hybrid_executor"))
        .is_some_and(|executor| executor.eq_ignore_ascii_case("cloud_run"))
}

/// The browser supplies the UX choice, but Cloud Run's compute budget is an
/// infrastructure contract. Clamp it again on the VPS so a stale or forged
/// client cannot turn a Standard Hybrid click into an unbounded request.
fn clamp_hybrid_cloud_run_request(request: &mut Value) -> Option<u64> {
    let settings = request.get_mut("settings")?.as_object_mut()?;
    let executor = settings
        .get("ui_hybrid_executor")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !executor.eq_ignore_ascii_case("cloud_run") {
        return None;
    }
    let deep = settings
        .get("ui_hybrid_deep_optimize")
        .map(value_truthy)
        .unwrap_or(false);
    let seconds = if deep { 180 } else { 60 };
    let milliseconds = seconds * 1_000;
    settings.insert("ui_hybrid_executor".to_string(), json!("cloud_run"));
    settings.insert("ui_hybrid_deep_optimize".to_string(), json!(deep));
    settings.insert("ui_hybrid_cloud_run_requested".to_string(), json!(true));
    settings.insert("routing_mode".to_string(), json!("serverless_only"));
    settings.insert(
        "ui_hybrid_cloud_run_budget_seconds".to_string(),
        json!(seconds),
    );
    settings.insert(
        "ui_hybrid_cloud_run_budget_kind".to_string(),
        json!(if deep { "deep" } else { "standard" }),
    );
    for key in [
        "optimization_time_limit_seconds",
        "optimization_adaptive_time_limit_seconds",
        "overall_time_limit_seconds",
        "integrated_time_limit",
        "progress_estimate_seconds",
        "ui_progress_budget_seconds",
    ] {
        settings.insert(key.to_string(), json!(seconds));
    }
    for key in ["backend_deadline_ms", "native_global_deadline_ms"] {
        settings.insert(key.to_string(), json!(milliseconds));
    }
    Some(seconds)
}

fn solver_progress_budget_seconds(request: Option<&Value>) -> Option<u64> {
    let request = request?;
    let settings = request_settings(request);
    let automatic_floor_seconds = automatic_large_fresh_budget_floor_ms(request) / 1_000;
    let explicit = setting_u64_allow_zero(settings, "ui_progress_budget_seconds", 0);
    if explicit > 0 {
        return Some(
            explicit
                .max(automatic_floor_seconds)
                .clamp(1, MAX_SOLVER_DEADLINE_MS / 1_000),
        );
    }
    let backend_ms = setting_u64_allow_zero(settings, "backend_deadline_ms", 0);
    let effective_ms = backend_ms.max(automatic_floor_seconds.saturating_mul(1_000));
    (effective_ms > 0).then(|| {
        effective_ms
            .div_ceil(1_000)
            .clamp(1, MAX_SOLVER_DEADLINE_MS / 1_000)
    })
}

fn solver_progress_run_index(request: Option<&Value>) -> Option<u64> {
    let settings = request.map(request_settings)?;
    let run_index = setting_u64_allow_zero(settings, "ui_progress_run_index", 0);
    (run_index > 0).then(|| run_index.clamp(1, 999))
}

fn solver_initial_work_progress(request: Option<&Value>) -> Option<Value> {
    let settings = request.map(request_settings)?;
    let solve_mode = setting_string(settings, "ui_requested_solve_mode")?
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    if !matches!(
        solve_mode.as_str(),
        "quick_complete"
            | "optimize_singletons"
            | "optimize_sessions"
            | "optimize_gaps"
            | "optimize_gap2"
            | "optimize_gap1"
    ) {
        return None;
    }
    let focus = setting_string(settings, "ui_progress_metric_focus")?
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    if !matches!(
        focus.as_str(),
        "scheduled_periods"
            | "quick_complete"
            | "one_period_teacher_sessions"
            | "teacher_sessions"
            | "teacher_gap_sessions"
            | "teacher_gap1_sessions"
            | "teacher_gap2_sessions"
    ) {
        return None;
    }
    let metric = |key: &str| {
        settings.and_then(|items| items.get(key)).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        })
    };
    let current = metric("ui_progress_metric_current")?;
    let target = metric("ui_progress_metric_target")?;
    let baseline_value = metric("ui_progress_metric_baseline")?;
    let gap_mode = matches!(
        solve_mode.as_str(),
        "optimize_gaps" | "optimize_gap2" | "optimize_gap1"
    );
    let baseline = if gap_mode {
        baseline_value
    } else {
        baseline_value.max(current)
    };
    let mut progress = json!({
        "protocol": REFERENCE_PROGRESS_PROTOCOL,
        "stage": "request:accepted",
        "sequence": 1,
        "elapsedMs": 0,
        "solveRequestMode": solve_mode,
        "optimizationFocus": focus,
        "metricCurrent": current,
        "metricTarget": target,
        "metricBaseline": baseline
    });
    if let Some(percent) = metric("ui_progress_metric_percent").map(|value| value.min(100)) {
        progress["metricPercent"] = json!(percent);
    }
    if gap_mode {
        if let (Some(gap1), Some(gap2)) = (
            metric("ui_progress_gap1_baseline"),
            metric("ui_progress_gap2_baseline"),
        ) {
            progress["gap1Baseline"] = json!(gap1);
            progress["gap2Baseline"] = json!(gap2);
        }
    }
    Some(progress)
}

fn setting_u64(settings: Option<&serde_json::Map<String, Value>>, key: &str, default: u64) -> u64 {
    settings
        .and_then(|items| items.get(key))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        })
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn setting_u64_allow_zero(
    settings: Option<&serde_json::Map<String, Value>>,
    key: &str,
    default: u64,
) -> u64 {
    settings
        .and_then(|items| items.get(key))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        })
        .unwrap_or(default)
}

fn clamped_solver_deadline_ms(
    settings: Option<&serde_json::Map<String, Value>>,
    key: &str,
    default: u64,
) -> u64 {
    setting_u64(settings, key, default).clamp(MIN_SOLVER_DEADLINE_MS, MAX_SOLVER_DEADLINE_MS)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReferenceBudget {
    hard_ms: u64,
    solver_ms: u64,
    reserve_ms: u64,
    backend_ms: u64,
    native_ms: u64,
}

fn cloud_run_client_timeout_seconds(budget: ReferenceBudget) -> u64 {
    budget
        .hard_ms
        .div_ceil(1_000)
        .saturating_add(30)
        .min(CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS)
}

fn uses_unified_reference_compute_budget(
    settings: Option<&serde_json::Map<String, Value>>,
) -> bool {
    if !setting_bool(settings, "ui_unified_auto_sort", false)
        || setting_bool(settings, "ui_unified_partial_repair", false)
    {
        return false;
    }
    setting_string(settings, "ui_unified_solve_kind")
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .as_deref()
        != Some("repair_partial")
}

fn constraint_value_is_enabled(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(enabled) => *enabled,
        Value::Number(number) => number.as_f64().is_some_and(|item| item != 0.0),
        Value::String(text) => !text.trim().is_empty() && text.trim() != "0",
        Value::Array(items) => items.iter().any(constraint_value_is_enabled),
        Value::Object(items) => items.values().any(constraint_value_is_enabled),
    }
}

fn has_subject_period_requirement(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(has_subject_period_requirement),
        Value::Object(items) => items.iter().any(|(key, child)| {
            (matches!(
                key.as_str(),
                "lessonBlocks"
                    | "avoidBreakPairs"
                    | "avoidBreakPair23"
                    | "avoidBreakPair34"
                    | "linkedDays"
            ) && constraint_value_is_enabled(child))
                || has_subject_period_requirement(child)
        }),
        _ => false,
    }
}

fn collect_class_off_slots(value: Option<&Value>, slots: &mut HashSet<String>) {
    let Some(classes) = value.and_then(Value::as_object) else {
        return;
    };
    for (class_id, raw_slots) in classes {
        match raw_slots {
            Value::Array(items) => {
                for slot in items.iter().filter_map(Value::as_str) {
                    let slot = slot.trim();
                    if !slot.is_empty() {
                        slots.insert(format!("{class_id}\0{slot}"));
                    }
                }
            }
            Value::Object(items) => {
                for (slot, enabled) in items {
                    if !slot.trim().is_empty() && constraint_value_is_enabled(enabled) {
                        slots.insert(format!("{class_id}\0{}", slot.trim()));
                    }
                }
            }
            _ => {}
        }
    }
}

fn request_policy_expected_periods(request: &Value) -> u64 {
    let mut expected = u64::try_from(expected_periods_from_request(request)).unwrap_or(0);
    let matrix_sum = request
        .get("data")
        .and_then(|data| data.get("pccmTietMatrix"))
        .and_then(Value::as_object)
        .map(|items| {
            items
                .values()
                .filter_map(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
                })
                .filter(|value| *value > 0)
                .fold(0_u64, u64::saturating_add)
        })
        .unwrap_or(0);
    expected = expected.max(matrix_sum);
    expected
}

fn request_large_zero_slack_profile_matches(request: &Value, expected_periods: u64) -> bool {
    if expected_periods < 900 {
        return false;
    }
    let settings = request_settings(request);
    if let Some(profile) = settings
        .and_then(|items| items.get("tight_class_fixed_off_profile"))
        .and_then(Value::as_object)
    {
        let field = |key: &str| {
            profile.get(key).and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
            })
        };
        return field("expected") == Some(expected_periods)
            && field("availableSlots") == Some(expected_periods)
            && field("fixedSlots").is_some_and(|value| value > 0)
            && field("slack") == Some(0);
    }

    // Cached clients can omit the derived profile entirely. Reconstruct the
    // same canonical 6-day x (5 morning + 5 afternoon) capacity from the
    // request data and de-duplicate fixed-off slots across the two legacy
    // stores. This is a conservative exact-equality check, not an estimate.
    let Some(data) = request.get("data").and_then(Value::as_object) else {
        return false;
    };
    let class_count = data
        .get("lop")
        .and_then(Value::as_array)
        .map(Vec::len)
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
    if class_count == 0 {
        return false;
    }
    let mut fixed_slots = HashSet::new();
    collect_class_off_slots(data.get("tkbUserOff"), &mut fixed_slots);
    collect_class_off_slots(
        data.get("tkbConstraints")
            .and_then(|value| value.get("fixedOff"))
            .and_then(|value| value.get("class")),
        &mut fixed_slots,
    );
    let fixed_count = u64::try_from(fixed_slots.len()).unwrap_or(u64::MAX);
    let Some(total_slots) = class_count.checked_mul(6 * (5 + 5)) else {
        return false;
    };
    fixed_count > 0
        && total_slots
            .checked_sub(fixed_count)
            .is_some_and(|available| available == expected_periods)
}

/// Cached PWA documents can keep an older automatic 60-75 second ceiling even
/// after the server and solver contract have moved on. Large fixed-anchor first
/// solves need enough time to produce one complete timetable; a blank automatic
/// duration may therefore be raised server-side, while an explicit user duration
/// (marked with `ui_custom_solve_duration_override`) remains authoritative. A
/// cached numeric duration without that marker is not a user choice and must not
/// restore the retired 60s + 20s watchdog.
fn automatic_large_fresh_budget_floor_ms(request: &Value) -> u64 {
    let settings = request_settings(request);
    let has_subject_period_rules = request
        .get("data")
        .and_then(|data| data.get("tkbConstraints"))
        .is_some_and(has_subject_period_requirement);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .unwrap_or_default();
    // Older browser payloads omitted this setting. Derive demand from the
    // actual assignment data so the server can still identify a large job.
    let expected_periods = setting_u64_allow_zero(settings, "expected_scheduled_periods", 0)
        .max(request_policy_expected_periods(request));
    let custom_duration_overridden =
        setting_bool(settings, "ui_custom_solve_duration_override", false)
            && setting_u64_allow_zero(settings, "ui_custom_solve_duration_seconds", 0) > 0;
    let automatic_large = setting_bool(settings, "ui_unified_auto_sort", false)
        && !custom_duration_overridden
        && expected_periods >= 900;
    let automatic_fresh = solve_kind == "fresh_complete_first";
    // A fixed-anchor or constraint edit can make the browser classify the
    // same incomplete large Automatic click as `repair_constraints`. It still
    // owns completeness and needs the robust floor; focused Optimize commands
    // use separate solve kinds and remain unaffected.
    let automatic_constraint_repair = solve_kind == "repair_constraints";
    let stale_subject_period_fresh = automatic_constraint_repair && has_subject_period_rules;
    if !automatic_large
        || (!automatic_fresh && !automatic_constraint_repair && !stale_subject_period_fresh)
    {
        return 0;
    }
    // Keep stale/mobile clients on the refreshed bridge's 180-second fresh
    // ceiling.  Older cached clients must not silently restore the retired
    // five-minute workload tier.
    180_000
}

fn reference_solver_budget(request: &Value) -> ReferenceBudget {
    let settings = request_settings(request);
    let automatic_floor_ms = automatic_large_fresh_budget_floor_ms(request);
    let backend_ms =
        clamped_solver_deadline_ms(settings, "backend_deadline_ms", DEFAULT_SOLVER_DEADLINE_MS)
            .max(automatic_floor_ms);
    let native_ms = clamped_solver_deadline_ms(settings, "native_global_deadline_ms", backend_ms)
        .max(automatic_floor_ms);
    // A server-owned handoff may inject the remaining canonical watchdog into
    // the request. Treat it as an upper bound on both the helper and native
    // lanes; otherwise a VPS -> Agent retry would silently restore the full
    // per-request deadline.
    let requested_watchdog_cap_ms =
        setting_u64_allow_zero(settings, "reference_watchdog_deadline_ms", 0);
    let watchdog_cap_ms = (requested_watchdog_cap_ms > 0)
        .then_some(requested_watchdog_cap_ms.clamp(MIN_SOLVER_DEADLINE_MS, MAX_SERVER_WATCHDOG_MS));
    let effective_backend_ms = backend_ms.min(watchdog_cap_ms.unwrap_or(MAX_SERVER_WATCHDOG_MS));
    let effective_native_ms = native_ms.min(watchdog_cap_ms.unwrap_or(MAX_SERVER_WATCHDOG_MS));
    // The watchdog is an end-to-end budget.  When a request is handed from
    // the VPS to an Agent (or back), leave the configured serialization/
    // upload reserve outside the child solver deadline.  Previously the
    // watchdog cap was applied before adding the reserve, so a 120-second
    // remaining lease gave the child the full 120 seconds and its complete
    // JSON result was killed at the boundary.
    let effective_compute_ceiling_ms = effective_backend_ms.min(effective_native_ms);
    if uses_unified_reference_compute_budget(settings) {
        let requested_watchdog_reserve = setting_u64(
            settings,
            "ui_unified_reference_watchdog_reserve_ms",
            UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS,
        )
        .clamp(UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS, 20_000);
        let hard_ms = effective_compute_ceiling_ms
            .saturating_add(requested_watchdog_reserve)
            .min(MAX_SOLVER_DEADLINE_MS)
            .min(watchdog_cap_ms.unwrap_or(MAX_SERVER_WATCHDOG_MS));
        let solver_ms = effective_compute_ceiling_ms
            .min(hard_ms.saturating_sub(requested_watchdog_reserve))
            .max(MIN_SOLVER_DEADLINE_MS);
        return ReferenceBudget {
            hard_ms,
            solver_ms,
            reserve_ms: hard_ms.saturating_sub(solver_ms),
            backend_ms: effective_backend_ms,
            native_ms: effective_native_ms,
        };
    }
    let hard_ms = effective_compute_ceiling_ms;
    let requested_reserve = setting_u64_allow_zero(
        settings,
        "native_deadline_reserve_ms",
        DEFAULT_SOLVER_RESERVE_MS,
    )
    .min(MAX_SOLVER_RESERVE_MS);
    // Python budgets are expressed as whole seconds. Preserve at least one
    // second for the helper and use the remainder for startup/serialization.
    let reserve_ms = requested_reserve.min(hard_ms.saturating_sub(MIN_SOLVER_DEADLINE_MS));
    ReferenceBudget {
        hard_ms,
        solver_ms: hard_ms
            .saturating_sub(reserve_ms)
            .max(MIN_SOLVER_DEADLINE_MS),
        reserve_ms,
        backend_ms: effective_backend_ms,
        native_ms: effective_native_ms,
    }
}

fn server_owned_watchdog_budget_ms(request: &Value) -> u64 {
    // The browser is allowed to describe the solve, but it does not own the
    // lifetime of a canonical server job. Cached clients can still carry the
    // former 60s + 20s watchdog in this field. If that stale cap participates
    // in the initial budget calculation, the server records an 80-second job
    // even though the large Automatic policy raised the CP-SAT window to 180s.
    // Remove only that transport cap while deriving the one-shot server clock;
    // every later executor handoff is capped to the remaining value below.
    let mut canonical = request.clone();
    let settings = ensure_object_child(&mut canonical, "settings");
    for key in [
        "reference_watchdog_deadline_ms",
        "reference_solver_budget_ms",
        "reference_deadline_reserve_ms",
    ] {
        settings.remove(key);
    }
    let budget = reference_solver_budget(&canonical);
    if uses_unified_reference_compute_budget(request_settings(&canonical)) {
        budget.hard_ms
    } else {
        let reserve_ms = UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS
            .min(budget.hard_ms.saturating_sub(MIN_SOLVER_DEADLINE_MS));
        budget
            .hard_ms
            .saturating_add(reserve_ms)
            .min(MAX_SERVER_WATCHDOG_MS)
    }
}

fn value_as_positive_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn cap_seconds_setting(
    settings: &mut serde_json::Map<String, Value>,
    key: &str,
    cap_seconds: u64,
    insert_when_missing: bool,
    server_budget_authoritative: bool,
) {
    let current = settings.get(key).and_then(value_as_positive_u64);
    if insert_when_missing || current.is_some() {
        let effective_seconds = if server_budget_authoritative {
            cap_seconds
        } else {
            current.unwrap_or(cap_seconds).min(cap_seconds)
        };
        settings.insert(key.to_string(), json!(effective_seconds));
    }
}

fn should_use_reference_solver(request: &Value) -> bool {
    let settings = request_settings(request);
    if setting_bool(settings, "native_force_rust_solver", false)
        || setting_bool(settings, "disable_reference_solver", false)
        || setting_bool(settings, "disable_hybrid_reference_solver", false)
    {
        return false;
    }
    let mode = setting_string(settings, "solver_mode")
        .unwrap_or_else(|| "auto".to_string())
        .to_ascii_lowercase()
        .replace('-', "_");
    !matches!(
        mode.as_str(),
        "shuffle_fill" | "rust" | "native" | "native_rust"
    )
}

fn reference_solver_body(
    body: &[u8],
    request: &Value,
    budget: ReferenceBudget,
    allocated_workers: usize,
) -> Vec<u8> {
    let settings = request_settings(request);
    let unified_reference_budget = uses_unified_reference_compute_budget(settings);
    let server_budget_authoritative = automatic_large_fresh_budget_floor_ms(request) > 0;
    let mode = setting_string(settings, "solver_mode")
        .unwrap_or_else(|| "auto".to_string())
        .to_ascii_lowercase()
        .replace('-', "_");
    let should_normalize = setting_bool(settings, "require_complete_schedule", true)
        && matches!(
            mode.as_str(),
            "shuffle_fill" | "rust" | "native" | "native_rust"
        );
    let mut normalized = request.clone();
    let Some(root) = normalized.as_object_mut() else {
        return body.to_vec();
    };
    if !root.get("settings").is_some_and(Value::is_object) {
        root.insert("settings".to_string(), json!({}));
    }
    if let Some(items) = normalized
        .get_mut("settings")
        .and_then(Value::as_object_mut)
    {
        items.insert(
            "reference_solver_contract_version".to_string(),
            json!(REFERENCE_SOLVER_CONTRACT_VERSION),
        );
        items.insert("num_workers".to_string(), json!(allocated_workers.max(1)));

        if should_normalize {
            items.insert("solver_mode".to_string(), json!("auto"));
            let auto_sort_mode = items
                .get("auto_sort_mode")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .replace('-', "_");
            if auto_sort_mode == "shuffle_fill" {
                items.insert("auto_sort_mode".to_string(), json!("fast"));
            }
            let strategy = items
                .get("auto_sort_strategy")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .replace('-', "_");
            if strategy == "shuffle_fill" {
                items.insert(
                    "auto_sort_strategy".to_string(),
                    json!("reference_from_shuffle_fill"),
                );
            }
            items.insert(
                "reference_solver_mode_normalized_from".to_string(),
                json!(mode),
            );
        }

        let solver_seconds = (budget.solver_ms / 1_000).max(1);
        cap_seconds_setting(
            items,
            "overall_time_limit_seconds",
            solver_seconds,
            true,
            server_budget_authoritative,
        );
        cap_seconds_setting(
            items,
            "integrated_time_limit",
            solver_seconds,
            false,
            server_budget_authoritative,
        );
        cap_seconds_setting(
            items,
            "optimization_time_limit_seconds",
            solver_seconds,
            false,
            server_budget_authoritative,
        );
        items.insert(
            "reference_solver_budget_ms".to_string(),
            json!(budget.solver_ms),
        );
        items.insert(
            "reference_watchdog_deadline_ms".to_string(),
            json!(budget.hard_ms),
        );
        items.insert(
            "reference_deadline_reserve_ms".to_string(),
            json!(budget.reserve_ms),
        );
        if unified_reference_budget {
            // Server policy owns the terminal upload/validation reserve. Old
            // cached clients may still send 5-10 seconds; never let that stale
            // hint shorten the reserve used inside the CP-SAT pipeline.
            items.insert(
                "ui_unified_reference_watchdog_reserve_ms".to_string(),
                json!(budget.reserve_ms),
            );
        }
    }
    serde_json::to_vec(&normalized).unwrap_or_else(|_| body.to_vec())
}

/// Clamp every solver-facing deadline in a canonical request to the remaining
/// server watchdog. The same body is used when the job is handed to an Agent,
/// while the parsed value is passed to the VPS solver, so neither executor can
/// silently restart the original full budget.
fn server_request_with_remaining_watchdog(request: &Value, remaining_ms: u64) -> Value {
    let cap_ms = remaining_ms.clamp(MIN_SOLVER_DEADLINE_MS, MAX_SERVER_WATCHDOG_MS);
    let cap_seconds = (cap_ms / 1_000).max(1);
    let unified_reference_budget = uses_unified_reference_compute_budget(request_settings(request));
    let mut capped = request.clone();
    let settings = ensure_object_child(&mut capped, "settings");

    for key in [
        "backend_deadline_ms",
        "native_global_deadline_ms",
        "reference_watchdog_deadline_ms",
        "reference_solver_budget_ms",
    ] {
        let current = setting_u64_allow_zero(Some(settings), key, 0);
        settings.insert(
            key.to_string(),
            json!(if key == "reference_watchdog_deadline_ms" {
                cap_ms
            } else if current > 0 {
                current.min(cap_ms)
            } else {
                cap_ms
            }),
        );
    }
    let reserve = setting_u64_allow_zero(Some(settings), "native_deadline_reserve_ms", 0)
        .min(cap_ms.saturating_sub(MIN_SOLVER_DEADLINE_MS));
    settings.insert("native_deadline_reserve_ms".to_string(), json!(reserve));
    if unified_reference_budget {
        let unified_reserve = UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS
            .min(cap_ms.saturating_sub(MIN_SOLVER_DEADLINE_MS));
        settings.insert(
            "ui_unified_reference_watchdog_reserve_ms".to_string(),
            json!(unified_reserve),
        );
        settings.insert(
            "reference_deadline_reserve_ms".to_string(),
            json!(unified_reserve),
        );
    }
    for key in [
        "overall_time_limit_seconds",
        "integrated_time_limit",
        "optimization_time_limit_seconds",
    ] {
        let current = setting_u64_allow_zero(Some(settings), key, 0);
        settings.insert(
            key.to_string(),
            json!(if current > 0 {
                current.min(cap_seconds)
            } else {
                cap_seconds
            }),
        );
    }
    capped
}

fn server_request_with_canonical_seed(request: &Value, job_id: &str) -> Value {
    let mut seeded = request.clone();
    let seed = agent_helper::canonical_job_seed(job_id);
    let settings = ensure_object_child(&mut seeded, "settings");
    settings.insert("random_seed".to_string(), json!(seed));
    settings.insert("agent_helper_seed".to_string(), json!(seed));
    seeded
}

fn server_request_body_with_remaining_watchdog(
    body: &[u8],
    request: Option<&Value>,
    remaining_ms: u64,
) -> Arc<Vec<u8>> {
    let Some(request) = request else {
        return Arc::new(body.to_vec());
    };
    let capped = server_request_with_remaining_watchdog(request, remaining_ms);
    Arc::new(serde_json::to_vec(&capped).unwrap_or_else(|_| body.to_vec()))
}

fn server_watchdog_timeout_response(request: &Value) -> Vec<u8> {
    if let Some(existing) = existing_incumbent_payload(request) {
        if fresh_automatic_quality_gate_required(request)
            && complete_existing_incumbent_is_safe(existing)
            && !fresh_automatic_quality_gate_met(request, existing)
            && !agent_checkpoint_quality_debt_timeout_fallback_allowed(
                request,
                "server_watchdog_exhausted",
            )
        {
            return json_response(
                422,
                json!({
                    "ok": false,
                    "kind": "fresh_automatic_quality_gate_unmet",
                    "error": "The complete recovery checkpoint still has one-period teacher sessions or Gap2.",
                    "metrics": existing.get("metrics").cloned().unwrap_or_else(|| json!({}))
                }),
            );
        }
    }
    if let Some((status, payload)) = complete_existing_incumbent_payload(
        request,
        "server_watchdog_exhausted",
        "canonical server watchdog budget exhausted",
    ) {
        if let Ok(mut payload) = serde_json::from_str::<Value>(&payload) {
            if !fresh_automatic_quality_gate_met(request, &payload)
                && !agent_checkpoint_quality_debt_timeout_fallback_allowed(
                    request,
                    "server_watchdog_exhausted",
                )
            {
                // A rough complete Agent checkpoint is only a recovery point.
                // Do not turn watchdog expiry into a successful first result.
                return json_response(
                    422,
                    json!({
                        "ok": false,
                        "kind": "fresh_automatic_quality_gate_unmet",
                        "error": "The complete recovery checkpoint still has one-period teacher sessions or Gap2.",
                        "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({}))
                    }),
                );
            }
            let runtime = ensure_object_child(&mut payload, "solver")
                .entry("runtime_settings".to_string())
                .or_insert_with(|| json!({}));
            if !runtime.is_object() {
                *runtime = json!({});
            }
            if let Some(runtime) = runtime.as_object_mut() {
                let phase = if runtime
                    .get("quality_debt_retained")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    "agent_checkpoint_quality_debt_timeout_fallback"
                } else {
                    "server_watchdog_incumbent_fallback"
                };
                runtime.insert("phase".to_string(), json!(phase));
                runtime.insert("deadline_hit".to_string(), json!(true));
                runtime.insert("server_watchdog_exhausted".to_string(), json!(true));
            }
            return json_response(status, payload);
        }
    }
    let expected = expected_periods_from_request(request);
    let budget = reference_solver_budget(request);
    json_response(
        422,
        json!({
            "ok": false,
            "kind": "no_complete_schedule_before_deadline",
            "error": "Server watchdog budget was exhausted before a complete schedule was returned.",
            "lessons": [],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 0,
                "expected_periods": expected,
                "unassigned_periods": expected,
                "app_constraint_violation_count": 0,
                "hard_ok": false,
                "core_hard_ok": false,
                "best_effort": false
            },
            "solver": {
                "name": "server_watchdog",
                "backend": "exclusive-vps-agent",
                "runtime_settings": {
                    "backend_deadline_ms": budget.backend_ms,
                    "native_global_deadline_ms": budget.native_ms,
                    "reference_solver_budget_ms": budget.solver_ms,
                    "reference_watchdog_deadline_ms": budget.hard_ms,
                    "deadline_hit": true,
                    "server_watchdog_exhausted": true
                }
            }
        }),
    )
}

fn reference_solver_script(app: &App) -> Option<PathBuf> {
    if let Ok(raw) = env::var("TKB_REFERENCE_SOLVER_SCRIPT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.exists() {
                return Some(path);
            }
        }
    }
    let candidates = [
        app.root
            .join("solver_runtime")
            .join("scripts")
            .join("solve_stdio.py"),
        app.root.join("scripts").join("solve_stdio.py"),
        app.root.join("TKB").join("scripts").join("solve_stdio.py"),
        app.root
            .join(".codex-reference")
            .join("tkb-rar")
            .join("TKB")
            .join("scripts")
            .join("solve_stdio.py"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn cloud_run_client_script(app: &App) -> Option<PathBuf> {
    if let Ok(raw) = env::var("TKB_CLOUD_RUN_CLIENT_SCRIPT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.exists() {
                return Some(path);
            }
        }
    }
    let candidates = [
        app.root
            .join("solver_runtime")
            .join("scripts")
            .join("cloud_run_client.py"),
        app.root.join("scripts").join("cloud_run_client.py"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn reference_python_command() -> String {
    env::var("TKB_REFERENCE_PYTHON")
        .or_else(|_| env::var("TKB_RUST_PYTHON"))
        .unwrap_or_else(|_| "python".to_string())
}

fn reference_solver_deadline(request: &Value) -> Duration {
    Duration::from_millis(reference_solver_budget(request).hard_ms)
}

fn expected_periods_from_request(request: &Value) -> i64 {
    let Some(data) = request.get("data").and_then(Value::as_object) else {
        return 0;
    };
    if let Some(expected) = data
        .get("tkbSolverResult")
        .and_then(|value| value.get("metrics"))
        .and_then(|value| value.get("expected_periods"))
        .and_then(Value::as_i64)
    {
        return expected.max(0);
    }
    let matrix_sum = data
        .get("pccmTietMatrix")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .values()
                .filter_map(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
                })
                .filter(|value| *value > 0)
                .sum::<i64>()
        })
        .unwrap_or(0);
    if matrix_sum > 0 {
        return matrix_sum;
    }

    let mut class_grade: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Some(classes) = data.get("lop").and_then(Value::as_array) {
        for class in classes {
            let grade = class
                .get("khoi")
                .and_then(Value::as_str)
                .map(norm_key)
                .unwrap_or_default();
            if grade.is_empty() {
                continue;
            }
            for key in ["id", "ten", "name", "ten2"] {
                if let Some(alias) = class.get(key).and_then(Value::as_str) {
                    let alias = norm_key(alias);
                    if !alias.is_empty() {
                        class_grade.insert(alias, grade.clone());
                    }
                }
            }
        }
    }

    let mut subject_periods: std::collections::HashMap<(String, String), i64> =
        std::collections::HashMap::new();
    if let Some(subjects) = data.get("mon").and_then(Value::as_array) {
        for subject in subjects {
            let grade = subject
                .get("khoi")
                .and_then(Value::as_str)
                .map(norm_key)
                .unwrap_or_default();
            let name = subject
                .get("ten")
                .or_else(|| subject.get("mon"))
                .and_then(Value::as_str)
                .map(norm_key)
                .unwrap_or_default();
            let periods = subject
                .get("sotiet")
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
                })
                .unwrap_or(0);
            if !grade.is_empty() && !name.is_empty() && periods > 0 {
                subject_periods.insert((grade, name), periods);
            }
        }
    }

    data.get("pccmMatrix")
        .and_then(Value::as_object)
        .map(|assignments| {
            assignments
                .iter()
                .filter(|(_, teacher)| {
                    teacher
                        .as_str()
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                })
                .filter_map(|(raw_key, _)| {
                    let (class, subject) = raw_key.split_once('|')?;
                    let grade = class_grade.get(&norm_key(class))?;
                    subject_periods
                        .get(&(grade.clone(), norm_key(subject)))
                        .copied()
                })
                .sum::<i64>()
        })
        .unwrap_or(0)
}

fn metrics_i64(payload: &Value, key: &str) -> i64 {
    payload
        .get("metrics")
        .and_then(Value::as_object)
        .and_then(|items| items.get(key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        })
        .unwrap_or(0)
}

fn metrics_bool(payload: &Value, key: &str) -> bool {
    payload
        .get("metrics")
        .and_then(Value::as_object)
        .and_then(|items| items.get(key))
        .map(value_truthy)
        .unwrap_or(false)
}

fn norm_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn count_fixed_tkb_cells(data: &Value) -> usize {
    let Some(tkb) = data.get("tkb").and_then(Value::as_object) else {
        return 0;
    };
    tkb.values()
        .filter_map(Value::as_object)
        .flat_map(|class_tkb| class_tkb.values())
        .filter_map(Value::as_object)
        .flat_map(|day| {
            ["sang", "chieu"]
                .into_iter()
                .filter_map(move |key| day.get(key))
        })
        .filter_map(Value::as_array)
        .flat_map(|items| items.iter())
        .filter(|cell| {
            cell.as_object()
                .and_then(|item| item.get("fixed"))
                .map(value_truthy)
                .unwrap_or(false)
        })
        .count()
}

fn array_len(data: &Value, keys: &[&str]) -> usize {
    keys.iter()
        .find_map(|key| data.get(*key).and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0)
}

fn object_len(data: &Value, keys: &[&str]) -> usize {
    keys.iter()
        .find_map(|key| {
            data.get(*key)
                .and_then(Value::as_object)
                .map(serde_json::Map::len)
        })
        .unwrap_or(0)
}

fn request_artifact_diagnostics(raw_body: &[u8]) -> Value {
    let Ok(request) = serde_json::from_slice::<Value>(raw_body) else {
        return json!({
            "raw_body_bytes": raw_body.len(),
            "parse_error": true
        });
    };
    let data = request.get("data").unwrap_or(&Value::Null);
    let data_keys = data
        .as_object()
        .map(|items| items.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let tkb_solver_result_lessons = data
        .get("tkbSolverResult")
        .and_then(|item| item.get("lessons"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    json!({
        "raw_body_bytes": raw_body.len(),
        "expected_periods_from_request": expected_periods_from_request(&request),
        "settings": request.get("settings").cloned().unwrap_or_else(|| json!({})),
        "data_keys": data_keys,
        "counts": {
            "classes": array_len(data, &["lophoc", "classes", "lop"]),
            "teachers": array_len(data, &["giaovien", "teachers"]),
            "subjects": array_len(data, &["monhoc", "subjects", "mon"]),
            "assignments": object_len(data, &["pccmMatrix", "assignments"]),
            "tkb_classes": object_len(data, &["tkb"]),
            "fixed_tkb_cells": count_fixed_tkb_cells(data),
            "tkb_solver_result_lessons": tkb_solver_result_lessons
        }
    })
}

fn keyed_counts(items: Option<&Value>, key: &str) -> Value {
    let mut counts = serde_json::Map::new();
    if let Some(items) = items.and_then(Value::as_array) {
        for item in items {
            let name = item.get(key).and_then(Value::as_str).unwrap_or("").trim();
            if name.is_empty() {
                continue;
            }
            let next = counts.get(name).and_then(Value::as_u64).unwrap_or(0) + 1;
            counts.insert(name.to_string(), json!(next));
        }
    }
    Value::Object(counts)
}

fn reference_payload_complete(payload: &Value) -> bool {
    let expected = metrics_i64(payload, "expected_periods");
    let scheduled = metrics_i64(payload, "scheduled_periods");
    expected > 0
        && scheduled == expected
        && metrics_i64(payload, "unassigned_periods") == 0
        && metrics_i64(payload, "app_constraint_violation_count") == 0
        && metrics_bool(payload, "hard_ok")
}

/// Identify an actual successful, complete hard-valid response. The separate
/// publication gate also recognizes a strictly validated capacity-only
/// partial; every other failed/partial response remains unsafe.
fn server_response_complete(response: &[u8]) -> bool {
    if !response.starts_with(b"HTTP/1.1 200 ") {
        return false;
    }
    let Some(separator) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let Some(payload) = serde_json::from_slice::<Value>(&response[separator + 4..]).ok() else {
        return false;
    };
    payload.get("ok").and_then(Value::as_bool) == Some(true)
        && complete_existing_incumbent_is_safe(&payload)
}

/// Apply the final watchdog fence without discarding a complete response that
/// crossed the deadline by a few milliseconds while it was being serialized.
fn server_watchdog_final_response(
    request: &Value,
    response: Vec<u8>,
    remaining_watchdog_ms: Option<u64>,
) -> Vec<u8> {
    // A large zero-slack first solve can be canonically complete and hard
    // valid while still carrying the optional singleton/Gap2 debt.  That is
    // a usable timetable, not a failed solve: publish it as the first result
    // and let the next explicit Optimize click continue the soft cleanup.
    if server_response_complete(&response) {
        if let Some(payload) = response_json_payload(&response) {
            if !fresh_automatic_quality_gate_met(request, &payload)
                && zero_slack_large_fresh_quality_debt_terminal_allowed(request, &payload)
            {
                return mark_zero_slack_quality_debt_terminal(response, payload);
            }
        }
    }
    // Fresh Automatic has a product-level first-result contract, not merely a
    // watchdog contract.  A complete-but-rough response must never escape via
    // a normal Agent/VPS return while there is still time on the clock.  The
    // timeout response retains the incumbent (when safe) or returns a gated
    // 422 so the coordinator can continue from a checkpoint instead.
    let quality_unmet = fresh_automatic_quality_gate_required(request)
        && server_response_complete(&response)
        && !server_response_publishable_for_request(request, &response);
    let watchdog_unmet = remaining_watchdog_ms
        .is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS)
        && !server_response_publishable_for_request(request, &response);
    if quality_unmet || watchdog_unmet {
        server_watchdog_timeout_response(request)
    } else {
        response
    }
}

fn reference_payload_usable_partial(payload: &Value) -> bool {
    // Capacity-partial payloads have a stronger publication contract than a
    // generic timeout checkpoint.  Never let the permissive legacy predicate
    // accept a mixed capacity/solver shortfall or a payload with forged
    // accounting; those results must remain a terminal 422.
    if reference_payload_mentions_capacity_shortfall(payload) {
        return reference_payload_safe_capacity_partial(payload);
    }
    let expected = metrics_i64(payload, "expected_periods");
    let scheduled = metrics_i64(payload, "scheduled_periods");
    let unassigned = metrics_i64(payload, "unassigned_periods");
    let violations = metrics_i64(payload, "app_constraint_violation_count");
    let placed_hard_ok = metrics_bool(payload, "placement_hard_ok")
        || metrics_bool(payload, "placement_core_hard_ok")
        || metrics_bool(payload, "hard_ok")
        || metrics_bool(payload, "core_hard_ok");
    expected > 0
        && scheduled > 0
        && scheduled < expected
        && unassigned > 0
        && violations == 0
        && placed_hard_ok
}

fn reference_payload_mentions_capacity_shortfall(payload: &Value) -> bool {
    let metrics = payload.get("metrics").and_then(Value::as_object);
    metrics.is_some_and(|items| {
        items.contains_key("capacity_unassigned_periods")
            || items.contains_key("solver_unassigned_periods")
            || items.contains_key("capacity_limited")
    }) || payload
        .get("unassignedLessons")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| reason.trim() == "not_enough_available_slots")
            })
        })
}

fn payload_metric_i64(payload: &Value, key: &str) -> Option<i64> {
    payload
        .get("metrics")
        .and_then(Value::as_object)
        .and_then(|items| items.get(key))
        .and_then(|value| nonnegative_metric_value(Some(value)))
}

fn payload_metric_bool(payload: &Value, key: &str) -> Option<bool> {
    payload
        .get("metrics")
        .and_then(Value::as_object)
        .and_then(|items| items.get(key))
        .and_then(Value::as_bool)
}

fn payload_period_sum(items: Option<&Value>) -> Option<i64> {
    items
        .and_then(Value::as_array)?
        .iter()
        .try_fold(0_i64, |sum, item| {
            let periods = item
                .get("periods")
                .or_else(|| item.get("count"))
                .and_then(|value| nonnegative_metric_value(Some(value)))?;
            (periods > 0)
                .then_some(())
                .and_then(|_| sum.checked_add(periods))
        })
}

/// Strict publication gate for a best-possible timetable after a proven
/// physical capacity shortage.  A bounded solver remainder is allowed, but
/// only when every requested period is exactly accounted for and all placed
/// lessons pass the independent hard-placement checks.
fn reference_payload_safe_capacity_partial(payload: &Value) -> bool {
    let Some(metrics) = payload.get("metrics").and_then(Value::as_object) else {
        return false;
    };
    let Some(expected) = payload_metric_i64(payload, "expected_periods") else {
        return false;
    };
    let Some(scheduled) = payload_metric_i64(payload, "scheduled_periods") else {
        return false;
    };
    let Some(unassigned) = payload_metric_i64(payload, "unassigned_periods") else {
        return false;
    };
    let Some(capacity_unassigned) = payload_metric_i64(payload, "capacity_unassigned_periods")
    else {
        return false;
    };
    let Some(solver_unassigned) = payload_metric_i64(payload, "solver_unassigned_periods") else {
        return false;
    };
    let Some(accounting_ok) = payload_metric_bool(payload, "accounting_ok") else {
        return false;
    };

    // A safe partial must have a real, non-empty placed schedule and an
    // exactly declared remainder. Solver debt is not called hard-valid; it is
    // retained only as an explicit Chua-phan item after placement validation.
    if expected <= 0
        || scheduled <= 0
        || scheduled >= expected
        || unassigned <= 0
        || capacity_unassigned.checked_add(solver_unassigned) != Some(unassigned)
        || scheduled.checked_add(unassigned) != Some(expected)
        || !accounting_ok
    {
        return false;
    }
    if metrics.contains_key("accounted_periods")
        && payload_metric_i64(payload, "accounted_periods") != Some(expected)
    {
        return false;
    }
    // Older capacity-only wrappers can omit the global gates, but an explicit
    // false value is inconsistent with a zero-solver-debt result. Global gates
    // are expected to be false when a bounded solver remainder exists.
    if solver_unassigned == 0 {
        for key in ["hard_ok", "core_hard_ok"] {
            if metrics.contains_key(key) && payload_metric_bool(payload, key) != Some(true) {
                return false;
            }
        }
    }
    for key in ["placement_hard_ok", "placement_core_hard_ok"] {
        if payload_metric_bool(payload, key) != Some(true) {
            return false;
        }
    }
    if let Some(validation) = payload.get("validation") {
        let Some(validation) = validation.as_object() else {
            return false;
        };
        if validation.contains_key("placement_hard_ok")
            && validation.get("placement_hard_ok").and_then(Value::as_bool) != Some(true)
        {
            return false;
        }
        if validation.contains_key("violations")
            && !validation
                .get("violations")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
        {
            return false;
        }
    }

    for key in [
        "class_slot_conflicts",
        "teacher_slot_conflicts",
        "room_slot_conflicts",
        "app_constraint_violation_count",
    ] {
        if payload_metric_i64(payload, key) != Some(0) {
            return false;
        }
    }
    if metrics.contains_key("app_constraint_violations")
        && !metrics
            .get("app_constraint_violations")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        return false;
    }

    if let Some(lessons) = payload.get("lessons") {
        let Some(lessons) = lessons.as_array() else {
            return false;
        };
        if lessons.len() as i64 != scheduled {
            return false;
        }
    }
    if let Some(unassigned_value) = payload.get("unassignedLessons") {
        let Some(unassigned_items) = unassigned_value.as_array() else {
            return false;
        };
        let Some(unassigned_sum) = payload_period_sum(Some(unassigned_value)) else {
            return false;
        };
        if unassigned_sum != unassigned {
            return false;
        }
        let capacity_sum = unassigned_items.iter().try_fold(0_i64, |sum, item| {
            let periods = item
                .get("periods")
                .or_else(|| item.get("count"))
                .and_then(|value| nonnegative_metric_value(Some(value)))?;
            if periods <= 0 {
                return None;
            }
            let is_capacity = item
                .get("reason")
                .and_then(Value::as_str)
                .is_some_and(|reason| reason.trim() == "not_enough_available_slots");
            sum.checked_add(if is_capacity { periods } else { 0 })
        });
        if capacity_sum != Some(capacity_unassigned)
            || unassigned.checked_sub(capacity_unassigned) != Some(solver_unassigned)
        {
            return false;
        }
    }

    true
}

fn reference_payload_reports_timeout(payload: &Value) -> bool {
    let kind_is_timeout = payload
        .get("kind")
        .and_then(Value::as_str)
        .map(|value| value.trim() == "no_complete_schedule_before_deadline")
        .unwrap_or(false);
    let root_timeout = payload
        .get("deadlineExhausted")
        .or_else(|| payload.get("deadline_exhausted"))
        .or_else(|| payload.get("deadline_hit"))
        .map(value_truthy)
        .unwrap_or(false);
    let runtime_timeout = payload
        .get("solver")
        .and_then(|solver| solver.get("runtime_settings"))
        .and_then(Value::as_object)
        .map(|runtime| {
            ["deadlineExhausted", "deadline_exhausted", "deadline_hit"]
                .into_iter()
                .filter_map(|key| runtime.get(key))
                .any(value_truthy)
        })
        .unwrap_or(false);
    kind_is_timeout || root_timeout || runtime_timeout
}

fn preserve_complete_hybrid_existing_payload(request: &Value) -> Option<(u16, String)> {
    let settings = request_settings(request);
    if !setting_bool(settings, "optimize_existing_schedule", false) {
        return None;
    }
    if !setting_bool(settings, "ui_existing_incumbent_revalidated", false) {
        return None;
    }
    if setting_bool(settings, "allow_native_existing_optimize_for_hybrid", false) {
        return None;
    }
    let existing = request.get("data")?.get("tkbSolverResult")?;
    if !reference_payload_complete(existing) {
        return None;
    }
    // A rough Fresh Automatic checkpoint is a warm start only.  Preserving it
    // here would bypass both the VPS quality phase and the terminal 0/0 gate.
    if !fresh_automatic_quality_gate_met(request, existing) {
        return None;
    }
    let backend = existing
        .get("solver")
        .and_then(|solver| solver.get("backend"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if backend != "hybrid-python-reference" {
        return None;
    }

    let mut payload = existing.clone();
    payload["ok"] = json!(true);
    payload["kind"] = json!("");
    payload["error"] = json!("");

    let solver = ensure_object_child(&mut payload, "solver");
    solver.insert("backend".to_string(), json!("hybrid-python-reference"));
    solver.insert(
        "description".to_string(),
        json!("Preserved a complete hybrid CP-SAT/MILP incumbent; skipped Rust existing-schedule optimizer because its stricter legacy validator can reject valid hybrid schedules."),
    );
    let runtime = solver
        .entry("runtime_settings".to_string())
        .or_insert_with(|| json!({}));
    if !runtime.is_object() {
        *runtime = json!({});
    }
    if let Some(runtime) = runtime.as_object_mut() {
        runtime.insert("phase".to_string(), json!("existing_hybrid_preserved"));
        runtime.insert("returned_incumbent".to_string(), json!(true));
        runtime.insert(
            "optimize_existing_schedule_skipped".to_string(),
            json!(true),
        );
        runtime.insert(
            "skip_reason".to_string(),
            json!("complete_hybrid_incumbent_already_hard_ok"),
        );
        runtime.insert(
            "backend_deadline_ms".to_string(),
            json!(setting_u64(settings, "backend_deadline_ms", 180_000)),
        );
        runtime.insert("deadline_hit".to_string(), json!(false));
    }

    let warnings = payload
        .as_object_mut()?
        .entry("warnings".to_string())
        .or_insert_with(|| json!([]));
    if !warnings.is_array() {
        *warnings = json!([]);
    }
    if let Some(warnings) = warnings.as_array_mut() {
        warnings.push(json!({
            "kind": "existing_hybrid_preserved",
            "message": "Lich hybrid da day du va hop le; bo qua toi uu native phu de khong bao loi rang buoc gia."
        }));
    }

    let body = serde_json::to_string(&payload).ok()?;
    Some((200, body))
}

fn unified_complete_refinement_requested(
    settings: Option<&serde_json::Map<String, Value>>,
) -> bool {
    setting_bool(settings, "ui_unified_auto_sort", false)
        && setting_bool(settings, "ui_use_existing_complete_incumbent", false)
        && setting_string(settings, "ui_unified_solve_kind")
            .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
            .as_deref()
            == Some("refine_complete")
}

fn existing_incumbent_payload(request: &Value) -> Option<&Value> {
    request
        .get("data")?
        .get("tkbSolverResult")
        .or_else(|| request.get("data")?.get("tkbRustSolverResult"))
}

fn complete_existing_incumbent_is_safe(payload: &Value) -> bool {
    if !reference_payload_complete(payload) {
        return false;
    }
    let expected = metrics_i64(payload, "expected_periods");
    let scheduled = metrics_i64(payload, "scheduled_periods");
    let lesson_count = payload
        .get("lessons")
        .and_then(Value::as_array)
        .map(|lessons| lessons.len() as i64)
        .unwrap_or(0);
    let unassigned_count = payload
        .get("unassignedLessons")
        .and_then(Value::as_array)
        .map(|lessons| lessons.len() as i64)
        .unwrap_or(0);
    expected > 0 && scheduled == expected && lesson_count == expected && unassigned_count == 0
}

fn complete_existing_incumbent_payload(
    request: &Value,
    reason: &str,
    detail: &str,
) -> Option<(u16, String)> {
    let settings = request_settings(request);
    let explicit_existing_optimize = setting_bool(settings, "optimize_existing_schedule", false)
        && setting_bool(
            settings,
            "ui_return_complete_incumbent_on_existing_optimize_failure",
            false,
        );
    let unified_refinement = unified_complete_refinement_requested(settings);
    if !(explicit_existing_optimize || unified_refinement)
        || (!unified_refinement
            && !setting_bool(settings, "ui_existing_incumbent_revalidated", false))
    {
        return None;
    }
    let existing = existing_incumbent_payload(request)?;
    if !complete_existing_incumbent_is_safe(existing) {
        return None;
    }
    let quality_debt_timeout_fallback =
        agent_checkpoint_quality_debt_timeout_fallback_allowed(request, reason);
    // Existing-schedule fallbacks are terminal responses.  Never turn a rough
    // Fresh Automatic recovery incumbent into a successful first timetable,
    // except for the explicitly marked mobile checkpoint rescue after its
    // bounded VPS quality window has been exhausted.
    if !fresh_automatic_quality_gate_met(request, existing) && !quality_debt_timeout_fallback {
        return None;
    }

    let mut payload = existing.clone();
    payload["ok"] = json!(true);
    payload["kind"] = json!("");
    payload["error"] = json!("");

    let solver = ensure_object_child(&mut payload, "solver");
    solver.insert(
        "description".to_string(),
        json!("Returned the complete incumbent after existing-schedule optimization could not produce a safer result."),
    );
    let runtime = solver
        .entry("runtime_settings".to_string())
        .or_insert_with(|| json!({}));
    if !runtime.is_object() {
        *runtime = json!({});
    }
    if let Some(runtime) = runtime.as_object_mut() {
        runtime.insert(
            "phase".to_string(),
            json!(if quality_debt_timeout_fallback {
                "agent_checkpoint_quality_debt_timeout_fallback"
            } else {
                "existing_optimize_incumbent_fallback"
            }),
        );
        runtime.insert("returned_incumbent".to_string(), json!(true));
        runtime.insert("native_existing_optimize_failed".to_string(), json!(true));
        runtime.insert("fallback_reason".to_string(), json!(reason));
        runtime.insert(
            "failure_detail".to_string(),
            json!(detail.chars().take(240).collect::<String>()),
        );
        runtime.insert(
            "backend_deadline_ms".to_string(),
            json!(setting_u64(settings, "backend_deadline_ms", 180_000)),
        );
        runtime.insert(
            "native_global_deadline_ms".to_string(),
            json!(setting_u64(
                settings,
                "native_global_deadline_ms",
                setting_u64(settings, "backend_deadline_ms", 180_000)
            )),
        );
        runtime.insert(
            "deadline_hit".to_string(),
            json!(quality_debt_timeout_fallback),
        );
        runtime.insert("optimization_noop_safe_fallback".to_string(), json!(true));
        if quality_debt_timeout_fallback {
            runtime.insert("quality_debt_retained".to_string(), json!(true));
        }
    }

    let warnings = payload
        .as_object_mut()?
        .entry("warnings".to_string())
        .or_insert_with(|| json!([]));
    if !warnings.is_array() {
        *warnings = json!([]);
    }
    if let Some(warnings) = warnings.as_array_mut() {
        warnings.push(json!({
            "kind": if quality_debt_timeout_fallback {
                "agent_checkpoint_quality_debt_timeout_fallback"
            } else {
                "existing_optimize_incumbent_fallback"
            },
            "message": if quality_debt_timeout_fallback {
                "VPS het thoi gian toi uu; da giu lai lich day du, hop le tu checkpoint thiet bi."
            } else {
                "Thu toi uu lich hien tai khong tao duoc phuong an an toan; da giu nguyen lich dang day du."
            }
        }));
    }

    let body = serde_json::to_string(&payload).ok()?;
    Some((200, body))
}

fn ensure_object_child<'a>(
    root: &'a mut Value,
    key: &str,
) -> &'a mut serde_json::Map<String, Value> {
    if !root.get(key).is_some_and(Value::is_object) {
        root[key] = json!({});
    }
    root.get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object child was just inserted")
}

fn normalize_reference_payload(
    mut payload: Value,
    request: &Value,
    status: u16,
    started: Instant,
    deadline: Duration,
) -> (u16, String) {
    let settings = request_settings(request);
    let require_complete = setting_bool(settings, "require_complete_schedule", true);
    let best_effort_allowed = setting_bool(settings, "best_effort_on_timeout", !require_complete);
    let mut out_status = status;
    let complete = reference_payload_complete(&payload);
    let safe_capacity_partial = reference_payload_safe_capacity_partial(&payload);
    let usable_partial = reference_payload_usable_partial(&payload);
    let elapsed = started.elapsed();
    let deadline_hit = elapsed >= deadline || reference_payload_reports_timeout(&payload);
    let timeout_best_effort = best_effort_allowed && deadline_hit && usable_partial && !complete;

    if safe_capacity_partial {
        // Cloud Run may report this as HTTP-style 422 because the global
        // timetable is incomplete. The coordinator independently revalidates
        // placement/accounting above, then publishes it as an explicit
        // best-effort partial instead of discarding all useful lessons.
        out_status = 200;
        payload["ok"] = json!(true);
        payload["bestEffort"] = json!(true);
        payload["kind"] = json!("best_effort_unassigned_accepted");
        payload["error"] = json!("");
    } else if out_status == 200
        && require_complete
        && !complete
        && !timeout_best_effort
    {
        out_status = 422;
        payload["ok"] = json!(false);
        payload["kind"] = json!(if deadline_hit {
            "no_complete_schedule_before_deadline"
        } else {
            "incomplete_schedule"
        });
        if payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            payload["error"] =
                json!("Backend hybrid chua tra duoc lich hoan chinh thoa rang buoc.");
        }
    } else if out_status == 200 && timeout_best_effort {
        payload["ok"] = json!(true);
        payload["bestEffort"] = json!(true);
    }

    if !(200..300).contains(&out_status) {
        payload["ok"] = json!(false);
        let missing_failure_kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .is_empty();
        if out_status >= 500 && missing_failure_kind {
            payload["kind"] = json!("reference_solver_failed");
        }
    }

    let budget = reference_solver_budget(request);
    let elapsed_seconds = (elapsed.as_secs_f64() * 100.0).round() / 100.0;

    let solver = ensure_object_child(&mut payload, "solver");
    solver.insert("backend".to_string(), json!("hybrid-python-reference"));
    solver
        .entry("name".to_string())
        .or_insert_with(|| json!("hybrid_reference_cp_sat_milp_v1"));
    solver.entry("description".to_string()).or_insert_with(|| {
        json!("Session-first CP-SAT/MILP reference pipeline: build a complete feasible timetable first, then minimize one-period teacher sessions and teacher gaps.")
    });
    let runtime = solver
        .entry("runtime_settings".to_string())
        .or_insert_with(|| json!({}));
    if !runtime.is_object() {
        *runtime = json!({});
    }
    if let Some(runtime) = runtime.as_object_mut() {
        runtime.insert("elapsed_seconds".to_string(), json!(elapsed_seconds));
        runtime.insert("backend_deadline_ms".to_string(), json!(budget.backend_ms));
        runtime.insert(
            "native_global_deadline_ms".to_string(),
            json!(budget.native_ms),
        );
        runtime.insert(
            "native_deadline_reserve_ms".to_string(),
            json!(budget.reserve_ms),
        );
        runtime.insert(
            "reference_solver_budget_ms".to_string(),
            json!(budget.solver_ms),
        );
        runtime.insert(
            "reference_watchdog_deadline_ms".to_string(),
            json!(budget.hard_ms),
        );
        runtime.insert("deadline_hit".to_string(), json!(deadline_hit));
        runtime.insert(
            "returned_incumbent".to_string(),
            json!(deadline_hit && (complete || safe_capacity_partial || timeout_best_effort)),
        );
        runtime.insert(
            "capacity_partial_accepted".to_string(),
            json!(safe_capacity_partial),
        );
        runtime.insert("phase".to_string(), json!("reference_pipeline"));
        runtime.insert(
            "require_complete_schedule".to_string(),
            json!(require_complete),
        );
        runtime.insert(
            "best_effort_on_timeout".to_string(),
            json!(best_effort_allowed),
        );
    }

    let payload_best_effort = payload
        .get("bestEffort")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let payload_unassigned_count = payload
        .get("unassignedLessons")
        .and_then(Value::as_array)
        .map(|items| items.len() as i64)
        .unwrap_or(0);
    let metrics = ensure_object_child(&mut payload, "metrics");
    if timeout_best_effort {
        metrics.insert("best_effort".to_string(), json!(true));
    }
    if !metrics.contains_key("teacher_gap2_sessions") {
        let gap2 = metrics
            .get("gap_distribution")
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|(gap, count)| {
                        let gap = gap.parse::<i64>().ok()?;
                        let count = count.as_i64()?;
                        (gap >= 2).then_some(count)
                    })
                    .sum::<i64>()
            })
            .unwrap_or(0);
        metrics.insert("teacher_gap2_sessions".to_string(), json!(gap2));
    }
    metrics
        .entry("best_effort".to_string())
        .or_insert_with(|| json!(payload_best_effort));
    metrics
        .entry("unassigned_periods".to_string())
        .or_insert_with(|| json!(payload_unassigned_count));
    if !metrics.contains_key("expected_periods") {
        metrics.insert(
            "expected_periods".to_string(),
            json!(expected_periods_from_request(request)),
        );
    }

    let payload = serde_json::to_string(&payload).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"reference_payload_encode_failed"}"#.to_string()
    });
    (out_status, payload)
}

fn reference_timeout_payload(request: &Value, started: Instant, detail: &str) -> (u16, String) {
    let expected = expected_periods_from_request(request);
    let settings = request_settings(request);
    let budget = reference_solver_budget(request);
    let elapsed_seconds = (started.elapsed().as_secs_f64() * 100.0).round() / 100.0;
    let payload = json!({
        "ok": false,
        "kind": "no_complete_schedule_before_deadline",
        "error": "Backend hybrid CP-SAT/MILP het deadline truoc khi tra lich hoan chinh.",
        "detail": detail,
        "lessons": [],
        "unassignedLessons": [],
        "metrics": {
            "scheduled_periods": 0,
            "expected_periods": expected,
            "unassigned_periods": expected,
            "app_constraint_violation_count": 0,
            "hard_ok": false,
            "core_hard_ok": false,
            "best_effort": false
        },
        "solver": {
            "name": "hybrid_reference_cp_sat_milp_v1",
            "backend": "hybrid-python-reference",
            "runtime_settings": {
                "elapsed_seconds": elapsed_seconds,
                "backend_deadline_ms": budget.backend_ms,
                "native_global_deadline_ms": budget.native_ms,
                "native_deadline_reserve_ms": budget.reserve_ms,
                "reference_solver_budget_ms": budget.solver_ms,
                "reference_watchdog_deadline_ms": budget.hard_ms,
                "deadline_hit": true,
                "returned_incumbent": false,
                "phase": "reference_timeout",
                "require_complete_schedule": setting_bool(settings, "require_complete_schedule", true),
                "best_effort_on_timeout": setting_bool(settings, "best_effort_on_timeout", false)
            }
        }
    });
    (
        422,
        serde_json::to_string(&payload).unwrap_or_else(|_| {
            r#"{"ok":false,"kind":"no_complete_schedule_before_deadline"}"#.to_string()
        }),
    )
}

fn reference_cancelled_payload(request: &Value, started: Instant) -> (u16, String) {
    let expected = expected_periods_from_request(request);
    let budget = reference_solver_budget(request);
    let payload = json!({
        "ok": false,
        "kind": "solver_cancelled",
        "error": "Solver run was cancelled.",
        "lessons": [],
        "unassignedLessons": [],
        "metrics": {
            "scheduled_periods": 0,
            "expected_periods": expected,
            "unassigned_periods": expected,
            "app_constraint_violation_count": 0,
            "hard_ok": false,
            "core_hard_ok": false,
            "best_effort": false
        },
        "solver": {
            "name": "hybrid_reference_cp_sat_milp_v1",
            "backend": "hybrid-python-reference",
            "runtime_settings": {
                "elapsed_seconds": (started.elapsed().as_secs_f64() * 100.0).round() / 100.0,
                "backend_deadline_ms": budget.backend_ms,
                "native_global_deadline_ms": budget.native_ms,
                "native_deadline_reserve_ms": budget.reserve_ms,
                "reference_solver_budget_ms": budget.solver_ms,
                "reference_watchdog_deadline_ms": budget.hard_ms,
                "deadline_hit": false,
                "cancelled": true,
                "returned_incumbent": false,
                "phase": "reference_cancelled"
            }
        }
    });
    (
        409,
        serde_json::to_string(&payload)
            .unwrap_or_else(|_| r#"{"ok":false,"kind":"solver_cancelled"}"#.to_string()),
    )
}

fn payload_artifact_summary(payload: &str, status: u16) -> Option<(bool, i64, i64, Value)> {
    let parsed: Value = serde_json::from_str(payload).ok()?;
    let metrics = parsed.get("metrics").and_then(Value::as_object);
    let scheduled = metrics
        .and_then(|items| items.get("scheduled_periods"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        })
        .unwrap_or(0);
    let expected = metrics
        .and_then(|items| items.get("expected_periods"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        })
        .unwrap_or(0);
    let unassigned = metrics
        .and_then(|items| items.get("unassigned_periods"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        })
        .unwrap_or(0);
    let violations = metrics
        .and_then(|items| items.get("app_constraint_violation_count"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        })
        .unwrap_or(0);
    let hard_ok = metrics
        .and_then(|items| items.get("hard_ok"))
        .map(value_truthy)
        .unwrap_or(false);
    let best_effort = parsed.get("bestEffort").map(value_truthy).unwrap_or(false)
        || metrics
            .and_then(|items| items.get("best_effort"))
            .map(value_truthy)
            .unwrap_or(false);
    let kind = parsed
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let needs_artifact = status >= 400
        || unassigned > 0
        || violations > 0
        || best_effort
        || !hard_ok
        || (expected > 0 && scheduled < expected)
        || !kind.is_empty();
    Some((needs_artifact, scheduled, expected, parsed))
}

fn solve_artifacts_enabled() -> bool {
    let raw = env::var("TKB_SAVE_SOLVE_ARTIFACTS")
        .or_else(|_| env::var("TKB_SAVE_RUST_SOLVE_ARTIFACTS"))
        .unwrap_or_else(|_| "0".to_string());
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

fn save_solve_artifacts(app: &App, raw_body: &[u8], status: u16, payload: &str, source: &str) {
    if !solve_artifacts_enabled() {
        return;
    }
    let Some((needs_artifact, scheduled, expected, parsed)) =
        payload_artifact_summary(payload, status)
    else {
        return;
    };
    if !needs_artifact {
        return;
    }
    let log_dir = app.root.join("logs");
    if let Err(err) = fs::create_dir_all(&log_dir) {
        if !quiet_logs() {
            eprintln!("failed to create solve log dir: {err}");
        }
        return;
    }
    let stamp = now_millis();
    let safe_source = source
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let prefix = format!("solve-rust-{stamp}-status{status}-{scheduled}of{expected}-{safe_source}");
    let request_path = log_dir.join(format!("{prefix}-request.json"));
    let response_path = log_dir.join(format!("{prefix}-response.json"));
    let summary_path = log_dir.join(format!("{prefix}-summary.json"));
    if let Err(err) = fs::write(&request_path, raw_body) {
        if !quiet_logs() {
            eprintln!("failed to write solve request artifact: {err}");
        }
    }
    if let Err(err) = fs::write(&response_path, payload) {
        if !quiet_logs() {
            eprintln!("failed to write solve response artifact: {err}");
        }
    }
    let metrics = parsed.get("metrics").cloned().unwrap_or_else(|| json!({}));
    let summary = json!({
        "status": status,
        "source": source,
        "artifact_files": {
            "request": request_path.to_string_lossy(),
            "response": response_path.to_string_lossy(),
            "summary": summary_path.to_string_lossy()
        },
        "request_diagnostics": request_artifact_diagnostics(raw_body),
        "metrics": metrics,
        "diagnostics": {
            "violation_kinds": keyed_counts(
                parsed.get("metrics").and_then(|items| items.get("app_constraint_violations")),
                "kind"
            ),
            "unassigned_reasons": keyed_counts(parsed.get("unassignedLessons"), "reason")
        },
        "validation": parsed.get("validation").cloned().unwrap_or_else(|| json!({})),
        "solver": parsed.get("solver").cloned().unwrap_or_else(|| json!({})),
        "kind": parsed.get("kind").cloned().unwrap_or_else(|| json!("")),
        "error": parsed.get("error").cloned().unwrap_or_else(|| json!(""))
    });
    match serde_json::to_string_pretty(&summary) {
        Ok(text) => {
            if let Err(err) = fs::write(&summary_path, text) {
                if !quiet_logs() {
                    eprintln!("failed to write solve summary artifact: {err}");
                }
            }
        }
        Err(err) => {
            if !quiet_logs() {
                eprintln!("failed to serialize solve summary artifact: {err}");
            }
        }
    }
}

fn solve_payload_response(
    app: &App,
    raw_body: &[u8],
    status: u16,
    payload: String,
    source: &str,
) -> Vec<u8> {
    save_solve_artifacts(app, raw_body, status, &payload, source);
    http_response(
        status,
        "application/json; charset=utf-8",
        payload.as_bytes(),
    )
}

fn reference_wrapper_protocol(value: &Value) -> Option<bool> {
    let wrapper = value.as_object()?;
    let status = wrapper.get("status")?.as_u64()?;
    if !(100..=599).contains(&status) || !wrapper.get("payload")?.is_object() {
        return None;
    }
    match wrapper.get("protocol") {
        None => Some(false),
        Some(Value::String(protocol)) if protocol == REFERENCE_STDIO_PROTOCOL => Some(true),
        _ => None,
    }
}

fn reference_wrapper_candidate_starts(stdout: &str) -> (Vec<usize>, Vec<usize>) {
    let bytes = stdout.as_bytes();
    let mut object_stack = Vec::new();
    let mut protocol_starts = Vec::new();
    let mut status_starts = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for (index, byte) in bytes.iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'{' => object_stack.push(index),
            b'}' => {
                object_stack.pop();
            }
            b'"' => {
                if let Some(start) = object_stack.last().copied() {
                    if bytes[index..].starts_with(br#""protocol""#) {
                        protocol_starts.push(start);
                    } else if bytes[index..].starts_with(br#""status""#) {
                        status_starts.push(start);
                    }
                }
                in_string = true;
            }
            _ => {}
        }
    }

    for starts in [&mut protocol_starts, &mut status_starts] {
        starts.sort_unstable();
        starts.dedup();
    }
    (protocol_starts, status_starts)
}

fn last_valid_reference_wrapper(
    stdout: &str,
    starts: Vec<usize>,
    require_framed: bool,
) -> Option<(usize, Value)> {
    let mut last = None;
    let mut covered_until = 0;
    for start in starts {
        // Once an outer wrapper parsed successfully, keys inside its payload
        // are not independent transport candidates.
        if start < covered_until {
            continue;
        }
        let mut values = serde_json::Deserializer::from_str(&stdout[start..]).into_iter::<Value>();
        let Some(Ok(value)) = values.next() else {
            continue;
        };
        let Some(framed) = reference_wrapper_protocol(&value) else {
            continue;
        };
        if framed != require_framed {
            continue;
        }
        let end = start.saturating_add(values.byte_offset());
        covered_until = end;
        last = Some((end, value));
    }
    last
}

fn parse_reference_solver_wrapper(stdout: &str) -> Result<Value, String> {
    let trimmed = stdout.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Err("stdout was empty".to_string());
    }

    let strict_error = match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => {
            if reference_wrapper_protocol(&value).is_some() {
                return Ok(value);
            }
            return Err(
                "stdout was valid JSON but not a reference-solver wrapper with status and object payload"
                    .to_string(),
            );
        }
        Err(error) => error.to_string(),
    };

    // Compatibility path for older helpers whose native solver wrote logs to
    // stdout. Prefer an explicitly framed wrapper, otherwise accept only the
    // last legacy object that passes the complete wrapper schema.
    let (protocol_starts, status_starts) = reference_wrapper_candidate_starts(stdout);
    last_valid_reference_wrapper(stdout, protocol_starts, true)
        .or_else(|| last_valid_reference_wrapper(stdout, status_starts, false))
        .map(|(_, value)| value)
        .ok_or_else(|| {
            format!(
                "no valid reference-solver wrapper in {} stdout bytes; strict JSON error: {strict_error}",
                stdout.len()
            )
        })
}

fn constraint_value_active(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(
                normalized.as_str(),
                "" | "0" | "false" | "off" | "no" | "none" | "null"
            )
        }
        Value::Array(values) => values.iter().any(constraint_value_active),
        Value::Object(values) => values.values().any(constraint_value_active),
    }
}

fn request_has_active_tkb_constraints(request_body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(request_body)
        .ok()
        .and_then(|request| request.get("data").cloned())
        .and_then(|data| data.get("tkbConstraints").cloned())
        .and_then(|constraints| constraints.as_object().cloned())
        .is_some_and(|constraints| {
            constraints.iter().any(|(key, value)| {
                // Normalized UI models always carry descriptive scaffolding.
                // It does not constrain a timetable and must not launch the
                // Python reference validator for every Browser-Agent checkpoint.
                !matches!(
                    key.as_str(),
                    "version" | "meta" | "groups" | "__normalizedBy"
                ) && constraint_value_active(value)
            })
        })
}

fn nonnegative_metric_value(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| {
            value
                .as_str()
                .and_then(|value| value.trim().parse::<i64>().ok())
        })
        .filter(|value| *value >= 0)
}

fn teacher_gap2_plus_metric(payload: &Value) -> Option<i64> {
    let metrics = payload.get("metrics")?;
    if let Some(value) = nonnegative_metric_value(metrics.get("teacher_gap2_sessions")) {
        return Some(value);
    }
    let distribution = metrics.get("gap_distribution")?.as_object()?;
    Some(
        distribution
            .iter()
            .filter_map(|(gap, count)| {
                let gap = gap.trim().parse::<i64>().ok()?;
                (gap >= 2).then(|| nonnegative_metric_value(Some(count)).unwrap_or(0))
            })
            .sum(),
    )
}

fn strict_teacher_gap2_plus_metric(payload: &Value) -> Option<i64> {
    let metrics = payload.get("metrics")?.as_object()?;
    let explicit = nonnegative_metric_value(metrics.get("teacher_gap2_sessions"))?;
    let distribution = metrics.get("gap_distribution")?.as_object()?;
    let mut measured = 0_i64;
    for (gap, count) in distribution {
        let gap = gap.trim().parse::<i64>().ok().filter(|value| *value >= 0)?;
        let count = nonnegative_metric_value(Some(count))?;
        if gap >= 2 {
            measured = measured.checked_add(count)?;
        }
    }
    (explicit == measured).then_some(explicit)
}

/// Read a solver-proven singleton lower bound without letting an arbitrary
/// metric field relax the public quality gate. Older payloads have no proof
/// and therefore retain the historical target of zero.
fn strict_one_period_teacher_session_floor(payload: &Value) -> Option<i64> {
    let metrics = payload.get("metrics")?.as_object()?;
    let current = nonnegative_metric_value(metrics.get("one_period_teacher_sessions"))?;
    let Some(raw_floor) = metrics.get("one_period_teacher_sessions_lower_bound") else {
        return Some(0);
    };
    let floor = nonnegative_metric_value(Some(raw_floor))?;
    if floor == 0 {
        return Some(0);
    }
    if floor > current {
        return None;
    }

    let evidence = metrics
        .get("one_period_teacher_sessions_lower_bound_evidence")?
        .as_array()?;
    if evidence.is_empty() {
        return None;
    }
    let mut seen_teacher_parts = HashSet::new();
    let mut proven_total = 0_i64;
    for item in evidence {
        let item = item.as_object()?;
        let teacher = item.get("teacher")?.as_str()?.trim();
        let part = item.get("part")?.as_str()?.trim();
        let class_name = item.get("class")?.as_str()?.trim();
        let subject = item.get("subject")?.as_str()?.trim();
        if teacher.is_empty()
            || class_name.is_empty()
            || subject.is_empty()
            || !matches!(part, "AM" | "PM")
            || !seen_teacher_parts.insert((teacher.to_string(), part.to_string()))
        {
            return None;
        }
        let periods = nonnegative_metric_value(item.get("periods_per_week"))?;
        let max_per_session =
            nonnegative_metric_value(item.get("max_periods_per_session"))?;
        let minimum_sessions = nonnegative_metric_value(item.get("minimum_sessions"))?;
        let forced_singletons = nonnegative_metric_value(item.get("forced_singletons"))?;
        if periods <= 0 || max_per_session <= 0 || forced_singletons <= 0 {
            return None;
        }
        let expected_sessions = periods
            .checked_add(max_per_session - 1)?
            .checked_div(max_per_session)?;
        let expected_singletons = expected_sessions
            .checked_mul(2)?
            .checked_sub(periods)?
            .max(0);
        if minimum_sessions != expected_sessions || forced_singletons != expected_singletons {
            return None;
        }
        proven_total = proven_total.checked_add(forced_singletons)?;
    }
    (proven_total == floor).then_some(floor)
}

/// Fresh Automatic has a product-level first-result gate in addition to hard
/// feasibility. A complete checkpoint is recoverable, but it is not a terminal
/// result until one-period teacher sessions and Gap2 are both zero.
fn fresh_automatic_quality_gate_required(request: &Value) -> bool {
    let settings = request_settings(request);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let focus = setting_string(settings, "optimization_focus")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let policy = setting_string(settings, "ui_agent_execution_policy")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let browser_required = setting_bool(settings, "ui_browser_agent_required", false)
        || matches!(policy.as_str(), "web_agent_required" | "browser_required");
    (solve_kind == "fresh_complete_first"
        || setting_bool(settings, "ui_agent_fresh_automatic_quality_recovery", false)
        || (browser_required
            && matches!(solve_kind.as_str(), "repair_constraints" | "refine_complete")))
        && matches!(focus.as_str(), "" | "auto" | "automatic")
        && setting_bool(settings, "require_complete_schedule", true)
}

fn fresh_automatic_quality_gate_met(request: &Value, payload: &Value) -> bool {
    if !fresh_automatic_quality_gate_required(request) {
        return true;
    }
    if !reference_payload_complete(payload) {
        return false;
    }
    let one_period = nonnegative_metric_value(
        payload
            .get("metrics")
            .and_then(|metrics| metrics.get("one_period_teacher_sessions")),
    );
    let floor = strict_one_period_teacher_session_floor(payload);
    matches!((one_period, floor), (Some(current), Some(target)) if current <= target)
        && strict_teacher_gap2_plus_metric(payload) == Some(0)
}

/// Permit the server-owned completion-first rescue to publish a complete
/// timetable even when the optional singleton/Gap2 targets need another
/// explicit Automatic click.  Both root and runtime markers are required,
/// and the full canonical hard-validation evidence must be present; a client
/// supplied partial or metrics-only payload cannot use this escape hatch.
fn completion_first_fallback_terminal_allowed(request: &Value, payload: &Value) -> bool {
    let settings = request_settings(request);
    if !fresh_automatic_quality_gate_required(request)
        || !setting_bool(settings, "ui_completion_first_rescue", false)
        || payload
            .get("completion_first_fallback")
            .and_then(Value::as_bool)
            != Some(true)
        || payload.get("ok").and_then(Value::as_bool) != Some(true)
        || !complete_existing_incumbent_is_safe(payload)
    {
        return false;
    }
    let runtime_marked = payload
        .get("solver")
        .and_then(|solver| solver.get("runtime_settings"))
        .and_then(|runtime| runtime.get("completion_first_fallback"))
        .and_then(Value::as_bool)
        == Some(true);
    if !runtime_marked {
        return false;
    }
    let Some(validation) = payload.get("validation").and_then(Value::as_object) else {
        return false;
    };
    if validation.get("hard_ok").and_then(Value::as_bool) != Some(true)
        || validation
            .get("violations")
            .and_then(Value::as_array)
            .is_none_or(|items| !items.is_empty())
    {
        return false;
    }
    let Some(metrics) = payload.get("metrics").and_then(Value::as_object) else {
        return false;
    };
    if metrics.get("core_hard_ok").and_then(Value::as_bool) != Some(true)
        || metrics.get("hard_ok").and_then(Value::as_bool) != Some(true)
        || metrics.get("class_slot_conflicts").and_then(Value::as_i64) != Some(0)
        || metrics.get("teacher_slot_conflicts").and_then(Value::as_i64) != Some(0)
        || metrics.get("room_slot_conflicts").and_then(Value::as_i64) != Some(0)
        || metrics
            .get("app_constraint_violation_count")
            .and_then(Value::as_i64)
            != Some(0)
    {
        return false;
    }
    for key in [
        "assignment_mismatches",
        "class_session_violations",
        "subject_session_limit_violations",
        "contiguous_block_violations",
        "invalid_lesson_slots",
        "app_constraint_violations",
    ] {
        if metrics
            .get(key)
            .and_then(Value::as_array)
            .is_none_or(|items| !items.is_empty())
        {
            return false;
        }
    }
    true
}

/// Legacy zero-slack compatibility hook. It no longer accepts arbitrary soft
/// quality debt: only a complete result at a verified structural singleton
/// floor with Gap2=0 is eligible. The normal quality gate already accepts that
/// result, so this path cannot weaken current publication rules.
fn zero_slack_large_fresh_quality_debt_terminal_allowed(
    request: &Value,
    payload: &Value,
) -> bool {
    let settings = request_settings(request);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let focus = setting_string(settings, "optimization_focus")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    if solve_kind != "fresh_complete_first"
        || !matches!(focus.as_str(), "" | "auto" | "automatic")
        || !setting_bool(settings, "require_complete_schedule", true)
    {
        return false;
    }
    let expected = setting_u64_allow_zero(settings, "expected_scheduled_periods", 0)
        .max(request_policy_expected_periods(request));
    if !request_large_zero_slack_profile_matches(request, expected)
        || !complete_existing_incumbent_is_safe(payload)
        || payload.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return false;
    }
    let Some(validation) = payload.get("validation").and_then(Value::as_object) else {
        return false;
    };
    if validation.get("hard_ok").and_then(Value::as_bool) != Some(true)
        || validation
            .get("violations")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    {
        return false;
    }
    let metrics = payload.get("metrics").and_then(Value::as_object);
    if metrics
        .and_then(|items| items.get("core_hard_ok"))
        .is_some_and(|value| value.as_bool() != Some(true))
        || metrics
            .and_then(|items| items.get("app_constraint_violations"))
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    {
        return false;
    }
    let Some(one_period) = nonnegative_metric_value(metrics.and_then(|items| {
        items.get("one_period_teacher_sessions")
    })) else {
        return false;
    };
    let Some(floor) = strict_one_period_teacher_session_floor(payload) else {
        return false;
    };
    let Some(gap2) = strict_teacher_gap2_plus_metric(payload) else {
        return false;
    };
    // The historical zero-slack escape hatch accepted arbitrary positive
    // quality debt. Keep the compatibility hook only for an independently
    // evidenced structural floor; Gap2 remains an absolute zero target.
    floor > 0 && one_period <= floor && gap2 == 0
}

fn mark_zero_slack_quality_debt_terminal(_response: Vec<u8>, mut payload: Value) -> Vec<u8> {
    payload["quality_debt_retained"] = json!(true);
    let solver = ensure_object_child(&mut payload, "solver");
    let runtime = solver
        .entry("runtime_settings".to_string())
        .or_insert_with(|| json!({}));
    if !runtime.is_object() {
        *runtime = json!({});
    }
    if let Some(runtime) = runtime.as_object_mut() {
        runtime.insert(
            "phase".to_string(),
            json!("zero_slack_complete_quality_debt_terminal"),
        );
        runtime.insert("quality_debt_retained".to_string(), json!(true));
        runtime.insert("quality_gate_bypassed".to_string(), json!(true));
        runtime.insert(
            "quality_gate_reason".to_string(),
            json!("zero_slack_complete_first_result"),
        );
        runtime.insert("returned_incumbent".to_string(), json!(true));
    }
    json_response(200, payload)
}

/// A user retain-best Stop is stricter than an ordinary refinement timeout.
/// Fresh and refinement Automatic may publish a Stop result only after the
/// mandatory zero-singleton/zero-Gap2 envelope is present. Ordinary timeout
/// handling still keeps a complete hard-valid incumbent so an impossible soft
/// quality target never destroys the user's timetable.
fn automatic_best_effort_stop_quality_gate_required(request: &Value) -> bool {
    let settings = request_settings(request);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let focus = setting_string(settings, "optimization_focus")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    matches!(solve_kind.as_str(), "fresh_complete_first" | "refine_complete")
        && matches!(focus.as_str(), "" | "auto" | "automatic")
        && setting_bool(settings, "require_complete_schedule", true)
}

fn automatic_best_effort_stop_quality_gate_met(request: &Value, payload: &Value) -> bool {
    if !automatic_best_effort_stop_quality_gate_required(request) {
        return true;
    }
    if !reference_payload_complete(payload) {
        return false;
    }
    let one_period = nonnegative_metric_value(
        payload
            .get("metrics")
            .and_then(|metrics| metrics.get("one_period_teacher_sessions")),
    );
    let floor = strict_one_period_teacher_session_floor(payload);
    matches!((one_period, floor), (Some(current), Some(target)) if current <= target)
        && strict_teacher_gap2_plus_metric(payload) == Some(0)
}

fn automatic_best_effort_stop_quality_unmet(
    request: Option<&Value>,
    payload: &Value,
) -> bool {
    request.is_some_and(|request| {
        automatic_best_effort_stop_quality_gate_required(request)
            && !automatic_best_effort_stop_quality_gate_met(request, payload)
    })
}

fn browser_mobile_checkpoint_vps_refine(payload: &Value) -> bool {
    payload
        .get("browser_mobile_checkpoint_vps_refine")
        .and_then(Value::as_bool)
        == Some(true)
        || payload
            .get("solver")
            .and_then(|solver| solver.get("runtime_settings"))
            .and_then(|runtime| runtime.get("browser_mobile_checkpoint_vps_refine"))
            .and_then(Value::as_bool)
            == Some(true)
}

fn browser_mobile_local_quality_terminal(payload: &Value) -> bool {
    let marked = payload
        .get("mobile_local_quality_terminal")
        .and_then(Value::as_bool)
        == Some(true)
        || payload
            .get("solver")
            .and_then(|solver| solver.get("runtime_settings"))
            .and_then(|runtime| runtime.get("mobile_local_quality_terminal"))
            .and_then(Value::as_bool)
            == Some(true);
    if !marked || payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let metrics = payload.get("metrics").and_then(Value::as_object);
    let expected =
        nonnegative_metric_value(metrics.and_then(|value| value.get("expected_periods")));
    let scheduled =
        nonnegative_metric_value(metrics.and_then(|value| value.get("scheduled_periods")));
    marked
        && expected.is_some_and(|value| value > 0)
        && scheduled == expected
        && nonnegative_metric_value(metrics.and_then(|value| value.get("unassigned_periods")))
            == Some(0)
        && nonnegative_metric_value(
            metrics.and_then(|value| value.get("app_constraint_violation_count")),
        ) == Some(0)
        && metrics
            .and_then(|value| value.get("hard_ok"))
            .and_then(Value::as_bool)
            == Some(true)
        && payload
            .get("validation")
            .and_then(|value| value.get("hard_ok"))
            .and_then(Value::as_bool)
            == Some(true)
        && complete_existing_incumbent_is_safe(payload)
}

fn agent_checkpoint_quality_debt_timeout_fallback_allowed(request: &Value, reason: &str) -> bool {
    setting_bool(
        request_settings(request),
        "ui_agent_checkpoint_hard_valid_timeout_fallback",
        false,
    ) && matches!(
        reason,
        "server_watchdog_exhausted" | "reference_solver_non_200" | "reference_solver_error"
    )
}

fn fresh_automatic_terminal_quality_unmet(request: Option<&Value>, payload: &Value) -> bool {
    request.is_some_and(|request| {
        fresh_automatic_quality_gate_required(request)
            && !fresh_automatic_quality_gate_met(request, payload)
            && !browser_mobile_local_quality_terminal(payload)
    })
}

fn server_response_publishable_for_request(request: &Value, response: &[u8]) -> bool {
    if !response.starts_with(b"HTTP/1.1 200 ") {
        return false;
    }
    let Some(separator) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    serde_json::from_slice::<Value>(&response[separator + 4..])
        .ok()
        .is_some_and(|payload| {
            // A physically capacity-limited timetable is terminal only under
            // the strict partial contract.  It bypasses complete-schedule
            // quality targets because those targets are mathematically
            // unreachable, while mixed/solver partials remain unpublished.
            reference_payload_safe_capacity_partial(&payload)
                || (payload.get("ok").and_then(Value::as_bool) == Some(true)
                    && complete_existing_incumbent_is_safe(&payload)
                    && (fresh_automatic_quality_gate_met(request, &payload)
                        || completion_first_fallback_terminal_allowed(request, &payload)
                        || browser_mobile_local_quality_terminal(&payload)
                        || zero_slack_large_fresh_quality_debt_terminal_allowed(
                            request,
                            &payload,
                        )))
        })
}

enum ExternalCpSatStepOutcome {
    Model(Value),
    Result { status: u16, payload: Value },
}

fn external_solver_model_kind(payload: &Value) -> Option<&str> {
    match payload.get("kind").and_then(Value::as_str) {
        Some(kind @ ("external_cp_sat_model" | "external_highs_model")) => Some(kind),
        _ => None,
    }
}

fn external_model_plan_version_matches(body: &Value) -> bool {
    match body.get("modelPlanVersion") {
        None => true,
        Some(Value::String(version)) => version == EXTERNAL_MODEL_PLAN_VERSION,
        Some(_) => false,
    }
}

fn external_cp_sat_responses_are_bounded(responses: &[Value]) -> bool {
    responses.iter().all(|response| {
        let Some(response) = response.as_object() else {
            return false;
        };
        let digest_ok = response
            .get("modelDigest")
            .and_then(Value::as_str)
            .is_some_and(|digest| {
                digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        let payload_ok = response
            .get("responseBase64")
            .and_then(Value::as_str)
            .is_some_and(|encoded| {
                !encoded.is_empty() && encoded.len() <= MAX_EXTERNAL_CP_SAT_RESPONSE_BASE64_CHARS
            });
        digest_ok && payload_ok
    })
}

fn external_cp_sat_agent_request(
    request_body: &[u8],
    job_id: &str,
    seed: u64,
    allocated_workers: usize,
    full_reference_refine: bool,
    remaining_watchdog_ms: Option<u64>,
) -> Result<Value, String> {
    let mut request: Value = serde_json::from_slice(request_body)
        .map_err(|error| format!("external CP-SAT request JSON invalid: {error}"))?;
    if let Some(remaining_ms) = remaining_watchdog_ms {
        request = server_request_with_remaining_watchdog(&request, remaining_ms);
    }
    let budget = reference_solver_budget(&request);
    let agent_workers = adaptive_agent_worker_count(&request, allocated_workers);
    let normalized = reference_solver_body(request_body, &request, budget, agent_workers);
    request = serde_json::from_slice(&normalized)
        .map_err(|error| format!("external CP-SAT normalized request invalid: {error}"))?;
    let browser_fresh_complete_first = external_cp_sat_fresh_complete_first(&request);
    let browser_focus = setting_string(request_settings(&request), "optimization_focus")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    let browser_full_reference_refine = full_reference_refine
        && allocated_workers >= 6
        && matches!(browser_focus.as_str(), "" | "auto" | "automatic")
        && unified_complete_refinement_requested(request_settings(&request))
        && existing_incumbent_payload(&request).is_some_and(complete_existing_incumbent_is_safe);
    let settings = ensure_object_child(&mut request, "settings");
    settings.insert("random_seed".to_string(), json!(seed));
    settings.insert("agent_helper_seed".to_string(), json!(seed));
    settings.insert(
        "solve_run_id".to_string(),
        json!(format!("agent-cpsat-{job_id}-{seed}")),
    );
    settings.insert("ui_solver_async_job".to_string(), json!(false));
    settings.insert("ui_solver_fifo_admission".to_string(), json!(false));
    settings.insert("browser_wasm_server_lease".to_string(), json!(true));
    settings.insert("browser_wasm_external_cp_sat".to_string(), json!(true));
    // A desktop with the full exact runtime may request the canonical
    // whole-school refinement model. Mobile and older/limited clients keep the
    // compact Browser LNS path; the flag is derived from the validated lease
    // capacity claim and safe incumbent, never from the original UI settings.
    settings.insert(
        "browser_wasm_full_reference_refine".to_string(),
        json!(browser_full_reference_refine),
    );
    if browser_fresh_complete_first {
        // Keep Automatic as Automatic. The Python pipeline first retains a
        // complete hard-valid timetable, then uses the same canonical budget
        // for singleton, Gap2, session and Gap1 cleanup. Older code rewrote
        // this to quick_complete, so Web Agent stopped after merely filling all
        // periods and returned avoidable quality debt.
        settings
            .entry("optimization_focus".to_string())
            .or_insert_with(|| json!("automatic"));
        settings.insert(
            "browser_wasm_external_complete_first".to_string(),
            json!(true),
        );
    }
    Ok(request)
}

fn external_cp_sat_fresh_complete_first(request: &Value) -> bool {
    let settings = request.get("settings").and_then(Value::as_object);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_");
    let focus = setting_string(settings, "optimization_focus")
        .unwrap_or_else(|| "automatic".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace(' ', "_")
        .replace('-', "_");
    let existing_is_complete =
        existing_incumbent_payload(request).is_some_and(complete_existing_incumbent_is_safe);
    solve_kind == "fresh_complete_first"
        && matches!(focus.as_str(), "" | "auto" | "automatic")
        && !existing_is_complete
}

fn external_cp_sat_request_body_with_checkpoint(
    request_body: &Arc<Vec<u8>>,
    checkpoint: Option<&Value>,
) -> Arc<Vec<u8>> {
    let Some(checkpoint) = checkpoint.filter(|value| complete_existing_incumbent_is_safe(value))
    else {
        return Arc::clone(request_body);
    };
    let Ok(request) = serde_json::from_slice::<Value>(request_body) else {
        return Arc::clone(request_body);
    };
    let Some(request) = server_request_with_agent_checkpoint(Some(&request), checkpoint) else {
        return Arc::clone(request_body);
    };
    serde_json::to_vec(&request)
        .map(Arc::new)
        .unwrap_or_else(|_| Arc::clone(request_body))
}

fn external_cp_sat_completion_seed_request_body(request_body: &Arc<Vec<u8>>) -> Arc<Vec<u8>> {
    let Ok(mut request) = serde_json::from_slice::<Value>(request_body) else {
        return Arc::clone(request_body);
    };
    let data = ensure_object_child(&mut request, "data");
    for key in [
        "tkbSolverResult",
        "tkbRustSolverResult",
        "tkbSolverPayload",
        "solverResult",
        "solverMetrics",
    ] {
        data.remove(key);
    }
    let settings = ensure_object_child(&mut request, "settings");
    settings.insert("optimization_focus".to_string(), json!("quick_complete"));
    settings.insert(
        "ui_requested_solve_mode".to_string(),
        json!("quick_complete"),
    );
    settings.insert(
        "ui_unified_solve_kind".to_string(),
        json!("fresh_complete_first"),
    );
    settings.insert("browser_wasm_quick_attempt".to_string(), json!(true));
    settings.insert(
        "browser_wasm_automatic_completion_seed".to_string(),
        json!(true),
    );
    settings.insert(
        "browser_wasm_exact_completion_seed".to_string(),
        json!(true),
    );
    settings.insert(
        "browser_wasm_automatic_progressive_search".to_string(),
        json!(false),
    );
    settings.insert("ui_unified_return_first_complete".to_string(), json!(true));
    settings.insert(
        "ui_stop_after_first_complete_schedule".to_string(),
        json!(true),
    );
    settings.insert(
        "optimization_first_click_skip_global_quality".to_string(),
        json!(true),
    );
    settings.insert("require_complete_schedule".to_string(), json!(true));
    settings.insert("best_effort_on_timeout".to_string(), json!(false));
    settings.insert("native_skip_teacher_optimization".to_string(), json!(true));
    settings.insert("optimize_existing_schedule".to_string(), json!(false));
    settings.insert("existing_fill_missing_schedule".to_string(), json!(false));
    settings.insert("preserve_existing_tkb".to_string(), json!(false));
    settings.insert("preserve_fixed_lessons_only".to_string(), json!(true));
    settings.insert("partial_existing_rebuild".to_string(), json!(true));
    settings.insert("repair_fill_first".to_string(), json!(false));
    settings.insert("repair_partial_existing".to_string(), json!(false));
    settings.insert("force_fresh_backend_solve".to_string(), json!(true));
    settings.insert("auto_sort_strategy".to_string(), json!("fresh"));
    settings.insert("allow_backend_cache".to_string(), json!(false));
    settings.insert("allow_solver_warm_start".to_string(), json!(false));
    for key in [
        "backend_deadline_ms",
        "native_global_deadline_ms",
        "reference_watchdog_deadline_ms",
    ] {
        settings.insert(
            key.to_string(),
            json!(BROWSER_WASM_EXACT_COMPLETION_SEED_MS),
        );
    }
    settings.insert(
        "overall_time_limit_seconds".to_string(),
        json!(BROWSER_WASM_EXACT_COMPLETION_SEED_MS / 1_000),
    );
    settings.insert("optimization_time_limit_seconds".to_string(), json!(0));
    for key in [
        "ui_use_existing_complete_incumbent",
        "ui_existing_incumbent_revalidated",
        "ui_return_complete_incumbent_on_existing_optimize_failure",
        "browser_wasm_external_complete_first",
    ] {
        settings.remove(key);
    }
    serde_json::to_vec(&request)
        .map(Arc::new)
        .unwrap_or_else(|_| Arc::clone(request_body))
}

fn run_external_cp_sat_step(
    app: &App,
    request_body: &[u8],
    job_id: &str,
    lease_id: &str,
    worker_token: &str,
    stream_kind: &str,
    seed: u64,
    allocated_workers: usize,
    full_reference_refine: bool,
    remaining_watchdog_ms: Option<u64>,
    responses: Value,
) -> Result<ExternalCpSatStepOutcome, ExternalCpSatStreamError> {
    let responses = responses.as_array().ok_or_else(|| {
        ExternalCpSatStreamError::Conflict("external CP-SAT responses must be an array".to_string())
    })?;
    if responses.len() > MAX_EXTERNAL_CP_SAT_STEPS {
        return Err(ExternalCpSatStreamError::Conflict(
            "external CP-SAT step limit exceeded".to_string(),
        ));
    }
    let remaining_watchdog_ms = remaining_watchdog_ms.unwrap_or(DEFAULT_SOLVER_DEADLINE_MS);
    if remaining_watchdog_ms < MIN_SOLVER_DEADLINE_MS {
        return Err(ExternalCpSatStreamError::TimedOut);
    }
    let total_timeout_ms = remaining_watchdog_ms.min(MAX_SOLVER_DEADLINE_MS);
    let deadline_at_ms = now_millis().saturating_add(total_timeout_ms);
    let lease_expires_at_ms = now_millis().saturating_add(AGENT_WORK_LEASE_MS);
    let worker_key = external_cp_sat_stream_worker_key(worker_token);
    let stream = external_cp_sat_streams().get_or_start(
        lease_id,
        &worker_key,
        job_id,
        stream_kind,
        responses.len(),
        deadline_at_ms,
        lease_expires_at_ms,
        |cancelled| {
            spawn_external_cp_sat_stream(
                app,
                request_body,
                job_id,
                seed,
                allocated_workers,
                full_reference_refine,
                Some(remaining_watchdog_ms),
                deadline_at_ms,
                cancelled,
            )
        },
    )?;

    let result = match stream.lock() {
        Ok(mut stream_guard) => advance_external_cp_sat_stream(&mut stream_guard, responses),
        Err(_) => Err(ExternalCpSatStreamError::Failed(
            "external CP-SAT stream state poisoned".to_string(),
        )),
    };
    let remove_stream = match &result {
        Ok(ExternalCpSatStepOutcome::Result { .. }) => true,
        Ok(ExternalCpSatStepOutcome::Model(_)) => false,
        Err(error) => error.invalidates_stream(),
    };
    if remove_stream {
        external_cp_sat_streams().remove_lease_if_same(lease_id, &stream);
    }
    result
}

fn spawn_external_cp_sat_stream(
    app: &App,
    request_body: &[u8],
    job_id: &str,
    seed: u64,
    allocated_workers: usize,
    full_reference_refine: bool,
    remaining_watchdog_ms: Option<u64>,
    deadline_at_ms: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<ExternalCpSatStream, ExternalCpSatStreamError> {
    let process_wait_ms = deadline_at_ms.saturating_sub(now_millis());
    let process_permit = reference_helper_process_limiter()
        .acquire(
            ReferenceHelperKind::ModelBuilder,
            Duration::from_millis(process_wait_ms),
        )
        .ok_or(ExternalCpSatStreamError::Capacity)?;
    let Some(script) = reference_solver_script(app) else {
        return Err(ExternalCpSatStreamError::Failed(
            "external CP-SAT reference solver script not found".to_string(),
        ));
    };
    let solver_request = external_cp_sat_agent_request(
        request_body,
        job_id,
        seed,
        allocated_workers,
        full_reference_refine,
        remaining_watchdog_ms,
    )
    .map_err(ExternalCpSatStreamError::Failed)?;
    let solver_workers = solver_request
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("num_workers"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .map(|value| value.clamp(1, 64))
        .unwrap_or_else(|| adaptive_agent_worker_count(&solver_request, allocated_workers));
    let mut stdin_body =
        serde_json::to_vec(&json!({"request": solver_request})).map_err(|error| {
            ExternalCpSatStreamError::Failed(format!(
                "external CP-SAT stream body encode failed: {error}"
            ))
        })?;
    stdin_body.push(b'\n');

    let python = reference_python_command();
    let mut child = ManagedChild(
        Command::new(&python)
            .arg(&script)
            .arg("external-cp-sat-stream")
            .current_dir(script.parent().and_then(Path::parent).unwrap_or(&app.root))
            .env("PYTHONIOENCODING", "utf-8")
            .env("TKB_NO_LOGS", "1")
            .env("TKB_SOLVER_MAX_WORKERS", solver_workers.to_string())
            .env("OMP_NUM_THREADS", "1")
            .env("OMP_THREAD_LIMIT", "1")
            .env("OPENBLAS_NUM_THREADS", "1")
            .env("MKL_NUM_THREADS", "1")
            .env("NUMEXPR_NUM_THREADS", "1")
            .env("VECLIB_MAXIMUM_THREADS", "1")
            .env("BLIS_NUM_THREADS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                ExternalCpSatStreamError::Failed(format!(
                    "failed to start external CP-SAT stream: {error}"
                ))
            })?,
    );
    let mut stdin = child.stdin.take().ok_or_else(|| {
        ExternalCpSatStreamError::Failed("failed to open external CP-SAT stream stdin".to_string())
    })?;
    let (input_tx, input_rx) = mpsc::sync_channel::<ExternalCpSatStreamInput>(1);
    let input_writer = thread::spawn(move || {
        while let Ok(input) = input_rx.recv() {
            let result = stdin
                .write_all(&input.bytes)
                .and_then(|_| stdin.flush())
                .map_err(|error| error.to_string());
            let failed = result.is_err();
            let _ = input.ack.send(result);
            if failed {
                break;
            }
        }
    });

    let stdout_pipe = child.stdout.take().ok_or_else(|| {
        ExternalCpSatStreamError::Failed(
            "failed to capture external CP-SAT stream stdout".to_string(),
        )
    })?;
    let (output_tx, output_rx) = mpsc::channel::<ExternalCpSatStreamOutput>();
    let stdout_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout_pipe);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = output_tx.send(Ok(None));
                    break;
                }
                Ok(_) => {
                    if output_tx.send(Ok(Some(line))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = output_tx.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });
    let stderr_pipe = child.stderr.take().ok_or_else(|| {
        ExternalCpSatStreamError::Failed(
            "failed to capture external CP-SAT stream stderr".to_string(),
        )
    })?;
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_tail_writer = stderr_tail.clone();
    let stderr_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stderr_pipe);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(mut tail) = stderr_tail_writer.lock() {
                        append_external_cp_sat_stderr_tail(&mut tail, &line);
                    }
                }
            }
        }
    });

    let mut stream = ExternalCpSatStream {
        _process_permit: process_permit,
        child,
        input_tx: Some(input_tx),
        output_rx,
        input_writer: Some(input_writer),
        stdout_reader: Some(stdout_reader),
        stderr_reader: Some(stderr_reader),
        stderr_tail,
        next_step: 0,
        pending_model_digest: None,
        accepted_response_digests: Vec::new(),
        deadline_at_ms,
        cancelled,
    };
    write_external_cp_sat_stream_input(&mut stream, stdin_body)?;
    Ok(stream)
}

fn append_external_cp_sat_stderr_tail(tail: &mut String, line: &str) {
    const MAX_STDERR_TAIL_BYTES: usize = 4 * 1024;
    tail.push_str(line);
    if tail.len() <= MAX_STDERR_TAIL_BYTES {
        return;
    }
    let mut start = tail.len().saturating_sub(MAX_STDERR_TAIL_BYTES);
    while !tail.is_char_boundary(start) {
        start += 1;
    }
    tail.drain(..start);
}

fn advance_external_cp_sat_stream(
    stream: &mut ExternalCpSatStream,
    responses: &[Value],
) -> Result<ExternalCpSatStepOutcome, ExternalCpSatStreamError> {
    if let Some((encoded, response_digest)) = prepare_external_cp_sat_stream_response(
        stream.next_step,
        stream.pending_model_digest.as_deref(),
        &stream.accepted_response_digests,
        responses,
    )? {
        write_external_cp_sat_stream_input(stream, encoded)?;
        stream.pending_model_digest = None;
        stream.accepted_response_digests.push(response_digest);
    }

    read_external_cp_sat_stream_output(stream)
}

fn write_external_cp_sat_stream_input(
    stream: &mut ExternalCpSatStream,
    bytes: Vec<u8>,
) -> Result<(), ExternalCpSatStreamError> {
    if stream.cancelled.load(Ordering::Relaxed) {
        return Err(ExternalCpSatStreamError::Cancelled);
    }
    if now_millis() >= stream.deadline_at_ms {
        return Err(ExternalCpSatStreamError::TimedOut);
    }
    let (ack_tx, ack_rx) = mpsc::channel();
    let Some(input_tx) = stream.input_tx.as_ref() else {
        return Err(ExternalCpSatStreamError::Failed(
            "external CP-SAT stream input is closed".to_string(),
        ));
    };
    input_tx
        .try_send(ExternalCpSatStreamInput { bytes, ack: ack_tx })
        .map_err(|error| {
            ExternalCpSatStreamError::Failed(format!(
                "failed to queue external CP-SAT stream input: {error}"
            ))
        })?;

    let started = Instant::now();
    loop {
        if stream.cancelled.load(Ordering::Relaxed) {
            return Err(ExternalCpSatStreamError::Cancelled);
        }
        if now_millis() >= stream.deadline_at_ms
            || started.elapsed() >= Duration::from_millis(EXTERNAL_CP_SAT_STEP_TIMEOUT_MS)
        {
            return Err(ExternalCpSatStreamError::TimedOut);
        }
        match ack_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) => {
                return Err(ExternalCpSatStreamError::Failed(format!(
                    "failed to write external CP-SAT stream input: {error}"
                )))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ExternalCpSatStreamError::Failed(
                    "external CP-SAT stream input writer disconnected".to_string(),
                ))
            }
        }
    }
}

fn prepare_external_cp_sat_stream_response(
    next_step: usize,
    pending_model_digest: Option<&str>,
    accepted_response_digests: &[String],
    responses: &[Value],
) -> Result<Option<(Vec<u8>, String)>, ExternalCpSatStreamError> {
    if responses.len() != next_step {
        return Err(ExternalCpSatStreamError::Conflict(format!(
            "external CP-SAT expected step {}, received {}",
            next_step,
            responses.len()
        )));
    }
    let accepted_count = if responses.is_empty() {
        0
    } else {
        responses.len() - 1
    };
    if accepted_response_digests.len() != accepted_count {
        return Err(ExternalCpSatStreamError::Conflict(
            "external CP-SAT response history length changed".to_string(),
        ));
    }
    for (index, response) in responses.iter().take(accepted_count).enumerate() {
        let digest = agent_helper_result_digest(response).map_err(|_| {
            ExternalCpSatStreamError::Conflict(
                "external CP-SAT response history is invalid".to_string(),
            )
        })?;
        if accepted_response_digests.get(index) != Some(&digest) {
            return Err(ExternalCpSatStreamError::Conflict(
                "external CP-SAT response history changed".to_string(),
            ));
        }
    }

    if let Some(response) = responses.last() {
        let expected_digest = pending_model_digest.ok_or_else(|| {
            ExternalCpSatStreamError::Conflict(
                "external CP-SAT stream has no pending model".to_string(),
            )
        })?;
        if response.get("modelDigest").and_then(Value::as_str) != Some(expected_digest) {
            return Err(ExternalCpSatStreamError::Conflict(
                "external CP-SAT model digest mismatch".to_string(),
            ));
        }
        if response
            .get("responseBase64")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(ExternalCpSatStreamError::Conflict(
                "external CP-SAT response is empty".to_string(),
            ));
        }
        let response_digest = agent_helper_result_digest(response).map_err(|_| {
            ExternalCpSatStreamError::Conflict("external CP-SAT response is invalid".to_string())
        })?;
        let mut frame = response.as_object().cloned().ok_or_else(|| {
            ExternalCpSatStreamError::Conflict(
                "external CP-SAT response must be an object".to_string(),
            )
        })?;
        frame.insert("stepIndex".to_string(), json!(responses.len() - 1));
        let mut encoded = serde_json::to_vec(&Value::Object(frame)).map_err(|error| {
            ExternalCpSatStreamError::Failed(format!(
                "failed to encode external CP-SAT stream response: {error}"
            ))
        })?;
        encoded.push(b'\n');
        return Ok(Some((encoded, response_digest)));
    }
    Ok(None)
}

fn read_external_cp_sat_stream_output(
    stream: &mut ExternalCpSatStream,
) -> Result<ExternalCpSatStepOutcome, ExternalCpSatStreamError> {
    let started = Instant::now();
    let mut last_parse_error = String::new();
    loop {
        if stream.cancelled.load(Ordering::Relaxed) {
            return Err(ExternalCpSatStreamError::Cancelled);
        }
        if now_millis() >= stream.deadline_at_ms
            || started.elapsed() >= Duration::from_millis(EXTERNAL_CP_SAT_STEP_TIMEOUT_MS)
        {
            return Err(ExternalCpSatStreamError::TimedOut);
        }
        let line = match stream.output_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                let stderr = stream
                    .stderr_tail
                    .lock()
                    .map(|tail| tail.trim().to_string())
                    .unwrap_or_default();
                return Err(ExternalCpSatStreamError::Failed(format!(
                    "external CP-SAT stream closed; {last_parse_error}; {stderr}"
                )));
            }
            Ok(Err(error)) => {
                return Err(ExternalCpSatStreamError::Failed(format!(
                    "failed to read external CP-SAT stream output: {error}"
                )));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ExternalCpSatStreamError::Failed(
                    "external CP-SAT stream output disconnected".to_string(),
                ));
            }
        };
        let wrapper = match parse_reference_solver_wrapper(&line) {
            Ok(wrapper) => wrapper,
            Err(error) => {
                last_parse_error = error;
                continue;
            }
        };
        let status = wrapper
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(500);
        let payload = wrapper.get("payload").cloned().ok_or_else(|| {
            ExternalCpSatStreamError::Failed("external CP-SAT stream omitted payload".to_string())
        })?;
        if status == 209 && external_solver_model_kind(&payload).is_some() {
            if payload.get("modelPlanVersion").and_then(Value::as_str)
                != Some(EXTERNAL_MODEL_PLAN_VERSION)
            {
                return Err(ExternalCpSatStreamError::Failed(
                    "external CP-SAT stream model-plan version mismatch".to_string(),
                ));
            }
            if stream.pending_model_digest.is_some()
                || stream.next_step >= MAX_EXTERNAL_CP_SAT_STEPS
            {
                return Err(ExternalCpSatStreamError::Failed(
                    "external CP-SAT stream emitted a model out of sequence".to_string(),
                ));
            }
            let step_index = payload
                .get("stepIndex")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            if step_index != Some(stream.next_step) {
                return Err(ExternalCpSatStreamError::Failed(
                    "external CP-SAT stream model step mismatch".to_string(),
                ));
            }
            let model_digest = payload
                .get("modelDigest")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    ExternalCpSatStreamError::Failed(
                        "external CP-SAT stream model digest invalid".to_string(),
                    )
                })?;
            stream.pending_model_digest = Some(model_digest.to_string());
            stream.next_step += 1;
            return Ok(ExternalCpSatStepOutcome::Model(payload));
        }
        return Ok(ExternalCpSatStepOutcome::Result { status, payload });
    }
}

fn external_cp_sat_stream_error_json(error: ExternalCpSatStreamError) -> Vec<u8> {
    match error {
        ExternalCpSatStreamError::Capacity => json_response(
            503,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "external_cp_sat_builder_capacity",
                "error": "external_cp_sat_builder_capacity",
                "retryAfterMs": 250
            }),
        ),
        ExternalCpSatStreamError::Conflict(detail) => json_response(
            409,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "external_cp_sat_step_conflict",
                "error": "external_cp_sat_step_conflict",
                "detail": detail.chars().take(240).collect::<String>()
            }),
        ),
        ExternalCpSatStreamError::Cancelled => json_response(
            409,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "cancel": true,
                "kind": "solver_cancelled",
                "error": "solver_cancelled"
            }),
        ),
        ExternalCpSatStreamError::TimedOut => json_response(
            502,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "external_cp_sat_step_failed",
                "error": "external_cp_sat_step_failed",
                "detail": "external CP-SAT stream timed out"
            }),
        ),
        ExternalCpSatStreamError::Failed(detail) => json_response(
            502,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": false,
                "kind": "external_cp_sat_step_failed",
                "error": "external_cp_sat_step_failed",
                "detail": detail.chars().take(240).collect::<String>()
            }),
        ),
    }
}

fn run_reference_candidate_validator(
    app: &App,
    request_body: &[u8],
    candidate: &Value,
) -> Result<Value, String> {
    let validation_started = Instant::now();
    let _process_permit = reference_helper_process_limiter()
        .acquire(
            ReferenceHelperKind::CandidateValidator,
            Duration::from_millis(REFERENCE_CANDIDATE_VALIDATION_TIMEOUT_MS),
        )
        .ok_or_else(|| "reference candidate validator capacity timed out".to_string())?;
    let Some(script) = reference_solver_script(app) else {
        return Err("reference candidate validator script not found".to_string());
    };
    let request: Value = serde_json::from_slice(request_body)
        .map_err(|error| format!("candidate validation request JSON invalid: {error}"))?;
    let body = serde_json::to_vec(&json!({
        "request": request,
        "candidate": candidate,
    }))
    .map_err(|error| format!("failed to encode candidate validation body: {error}"))?;
    let python = reference_python_command();
    let mut child = ManagedChild(
        Command::new(&python)
            .arg(&script)
            .arg("validate-candidate")
            .current_dir(script.parent().and_then(Path::parent).unwrap_or(&app.root))
            .env("PYTHONIOENCODING", "utf-8")
            .env("TKB_NO_LOGS", "1")
            .env("TKB_SOLVER_MAX_WORKERS", "1")
            .env("OMP_NUM_THREADS", "1")
            .env("OMP_THREAD_LIMIT", "1")
            .env("OPENBLAS_NUM_THREADS", "1")
            .env("MKL_NUM_THREADS", "1")
            .env("NUMEXPR_NUM_THREADS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to start reference candidate validator: {error}"))?,
    );
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "failed to open reference candidate validator stdin".to_string())?
        .write_all(&body)
        .map_err(|error| format!("failed to write reference candidate validator stdin: {error}"))?;
    drop(child.stdin.take());

    loop {
        if child
            .try_wait()
            .map_err(|error| format!("failed to poll reference candidate validator: {error}"))?
            .is_some()
        {
            break;
        }
        if validation_started.elapsed()
            >= Duration::from_millis(REFERENCE_CANDIDATE_VALIDATION_TIMEOUT_MS)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("reference candidate validation timed out".to_string());
        }
        thread::sleep(Duration::from_millis(20));
    }

    let mut stdout = String::new();
    child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture reference candidate validator stdout".to_string())?
        .read_to_string(&mut stdout)
        .map_err(|error| format!("failed to read reference candidate validator stdout: {error}"))?;
    let wrapper = parse_reference_solver_wrapper(&stdout)
        .map_err(|error| format!("reference candidate validator output invalid: {error}"))?;
    let status = wrapper.get("status").and_then(Value::as_u64).unwrap_or(500);
    let report = wrapper
        .get("payload")
        .cloned()
        .ok_or_else(|| "reference candidate validator omitted payload".to_string())?;
    if status != 200
        || report.get("ok").and_then(Value::as_bool) != Some(true)
        || report.get("hard_ok").and_then(Value::as_bool) != Some(true)
    {
        return Err("reference candidate validator rejected candidate".to_string());
    }
    Ok(report)
}

fn parse_reference_progress_frame(line: &[u8]) -> Option<Value> {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let encoded = line.strip_prefix(REFERENCE_PROGRESS_PREFIX.as_bytes())?;
    if encoded.is_empty() || encoded.len() > MAX_REFERENCE_PROGRESS_FRAME_BYTES {
        return None;
    }
    let value = serde_json::from_slice::<Value>(encoded).ok()?;
    let object = value.as_object()?;
    if object.get("protocol").and_then(Value::as_str) != Some(REFERENCE_PROGRESS_PROTOCOL) {
        return None;
    }
    let stage = object.get("stage").and_then(Value::as_str)?.trim();
    if stage.is_empty() || stage.chars().any(char::is_control) {
        return None;
    }
    Some(value)
}

fn reference_progress_reports_complete(progress: &Value) -> bool {
    progress.get("stage").and_then(Value::as_str) == Some("result:complete")
        && progress
            .get("status")
            .and_then(Value::as_u64)
            .is_some_and(|status| (200..300).contains(&status))
}

fn reference_terminal_grace_active(
    terminal_result_ready: bool,
    elapsed: Duration,
    deadline: Duration,
) -> bool {
    terminal_result_ready
        && elapsed
            < deadline.saturating_add(Duration::from_millis(REFERENCE_TERMINAL_RESULT_GRACE_MS))
}

fn decode_reference_solver_stdout(
    stdout: &str,
    request: &Value,
    started: Instant,
    deadline: Duration,
) -> Result<(u16, String), String> {
    let wrapper = parse_reference_solver_wrapper(stdout)?;
    let status = wrapper
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(200);
    let payload = wrapper
        .get("payload")
        .cloned()
        .ok_or_else(|| "reference solver response missing payload".to_string())?;
    Ok(normalize_reference_payload(
        payload, request, status, started, deadline,
    ))
}

fn validate_cloud_solver_result(
    result: (u16, String),
    profile: Option<&serverless::ServerlessProfile>,
) -> Result<(u16, String), String> {
    let Some(profile) = profile else {
        return Ok(result);
    };
    let payload = serde_json::from_str::<Value>(&result.1)
        .map_err(|_| "cloud_solver_terminal_payload_invalid".to_string())?;
    let runtime = payload
        .get("solver")
        .and_then(|solver| solver.get("runtime_settings"));
    let digest = runtime
        .and_then(|settings| settings.get("cloud_solver_digest"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let protocol = runtime
        .and_then(|settings| settings.get("cloud_protocol"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if digest != profile.solver_digest {
        return Err("cloud_solver_digest_mismatch".to_string());
    }
    if protocol != "tkb-cloud-solver-v1" {
        return Err("cloud_solver_protocol_mismatch".to_string());
    }
    Ok(result)
}

#[derive(Clone, Debug)]
enum ReferenceSolverTransport {
    Local,
    CloudRun(serverless::ServerlessProfile),
}

fn run_reference_solver(
    app: &App,
    body: &[u8],
    request: &Value,
    job_id: &str,
    cancel_requested: &AtomicBool,
    best_effort_stop_requested: &AtomicBool,
    progress_execution_generation: Option<u64>,
    allocated_workers: usize,
    transport: ReferenceSolverTransport,
    server_owner: Option<&SolverOwner>,
) -> Result<(u16, String), String> {
    let (script, cloud_profile) = match transport {
        ReferenceSolverTransport::Local => (
            reference_solver_script(app)
                .ok_or_else(|| "reference solver script not found".to_string())?,
            None,
        ),
        ReferenceSolverTransport::CloudRun(profile) => (
            cloud_run_client_script(app)
                .ok_or_else(|| "Cloud Run client script not found".to_string())?,
            Some(profile),
        ),
    };
    let python = reference_python_command();
    let budget = reference_solver_budget(request);
    let deadline = reference_solver_deadline(request);
    let helper_body = reference_solver_body(body, request, budget, allocated_workers);
    let cloud_stop_probe_guard = if cloud_profile.is_some() {
        server_owner.map(|owner| register_cloud_stop_probe(job_id, owner))
    } else {
        None
    };
    let started = Instant::now();
    let mut stop_file_hasher = Sha256::new();
    stop_file_hasher.update(b"tkb-solver-stop-v1\0");
    stop_file_hasher.update(job_id.as_bytes());
    let stop_file_job_hash = stop_file_hasher
        .finalize()
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let stop_file = env::temp_dir().join(format!(
        "tkb-solver-stop-{}-{}-{}.flag",
        std::process::id(),
        now_millis(),
        stop_file_job_hash
    ));
    let _stop_file_guard = ManagedStopFile(stop_file.clone());
    let mut command = Command::new(&python);
    command
        .arg(&script)
        .arg("solve")
        .current_dir(script.parent().and_then(Path::parent).unwrap_or(&app.root))
        .env("PYTHONIOENCODING", "utf-8")
        .env("TKB_SOLVER_MAX_WORKERS", allocated_workers.to_string())
        .env("TKB_SOLVER_STOP_FILE", &stop_file)
        .env("OMP_NUM_THREADS", "1")
        .env("OMP_THREAD_LIMIT", "1")
        .env("OPENBLAS_NUM_THREADS", "1")
        .env("MKL_NUM_THREADS", "1")
        .env("NUMEXPR_NUM_THREADS", "1")
        .env("VECLIB_MAXIMUM_THREADS", "1")
        .env("BLIS_NUM_THREADS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(profile) = cloud_profile.as_ref() {
        command
            .env("TKB_CLOUD_RUN_URL", &profile.url)
            .env("TKB_CLOUD_RUN_AUDIENCE", &profile.audience)
            .env("TKB_CLOUD_RUN_REGION", &profile.region)
            .env("TKB_CLOUD_RUN_PROJECT_ID", &profile.project_id)
            .env("TKB_CLOUD_RUN_SOLVER_DIGEST", &profile.solver_digest)
            .env(
                "TKB_CLOUD_RUN_TIMEOUT_SECONDS",
                cloud_run_client_timeout_seconds(budget).to_string(),
            );
        if let Some(probe) = cloud_stop_probe_guard.as_ref() {
            command
                .env("TKB_CLOUD_RUN_JOB_ID", job_id)
                .env("TKB_CLOUD_STOP_PROBE_URL", cloud_stop_probe_url())
                .env("TKB_CLOUD_STOP_PROBE_TOKEN", &probe.token);
        }
    }
    let mut child = ManagedChild(
        command
            .spawn()
            .map_err(|err| format!("failed to start reference solver: {err}"))?,
    );

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture reference solver stdout".to_string())?;
    let stdout_reader = thread::spawn(move || {
        let mut stdout = String::new();
        let result = stdout_pipe.read_to_string(&mut stdout);
        (stdout, result)
    });

    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture reference solver stderr".to_string())?;
    let progress_pool = Arc::clone(&app.solver_pool);
    let progress_job_id = job_id.to_string();
    let terminal_result_ready = Arc::new(AtomicBool::new(false));
    let terminal_result_observer = Arc::clone(&terminal_result_ready);
    let stderr_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stderr_pipe);
        let mut stderr = String::new();
        let result = loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break Ok(()),
                Ok(_) => {
                    if let Some(progress) = parse_reference_progress_frame(&line) {
                        if reference_progress_reports_complete(&progress) {
                            terminal_result_observer.store(true, Ordering::SeqCst);
                        }
                        if let Some(generation) = progress_execution_generation {
                            progress_pool.update_server_job_progress_fenced(
                                &progress_job_id,
                                generation,
                                progress,
                            );
                        } else {
                            progress_pool.update_server_job_progress(&progress_job_id, progress);
                        }
                    } else {
                        stderr.push_str(&String::from_utf8_lossy(&line));
                    }
                }
                Err(error) => break Err(error),
            }
        };
        (stderr, result)
    });

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(&helper_body)
            .map_err(|err| format!("failed to write reference solver stdin: {err}"))?;
    }
    drop(child.stdin.take());

    let mut best_effort_stop_signalled = false;
    loop {
        let server_cancel_requested = server_owner.is_some_and(|owner| {
            app.solver_pool
                .server_job_cancel_requested(job_id, owner)
        });
        if cancel_requested.load(Ordering::SeqCst) || server_cancel_requested {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Ok(reference_cancelled_payload(request, started));
        }
        let server_best_effort_stop_requested = server_owner
            .and_then(|owner| app.solver_pool.server_execution_snapshot(job_id, owner))
            .is_some_and(|snapshot| snapshot.best_effort_stop_requested);
        if (best_effort_stop_requested.load(Ordering::SeqCst)
            || server_best_effort_stop_requested)
            && !best_effort_stop_signalled
        {
            fs::write(&stop_file, b"stop\n")
                .map_err(|err| format!("failed to signal best-effort solver stop: {err}"))?;
            best_effort_stop_signalled = true;
        }
        if child
            .try_wait()
            .map_err(|err| format!("failed to poll reference solver: {err}"))?
            .is_some()
        {
            break;
        }
        let elapsed = started.elapsed();
        if elapsed >= deadline {
            if reference_terminal_grace_active(
                terminal_result_ready.load(Ordering::SeqCst),
                elapsed,
                deadline,
            ) {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            let _ = child.kill();
            let _ = child.wait();
            let (stdout, stdout_read) = stdout_reader
                .join()
                .map_err(|_| "failed to join reference stdout reader".to_string())?;
            stdout_read.map_err(|err| format!("failed to read reference stdout: {err}"))?;
            let (stderr, stderr_read) = stderr_reader
                .join()
                .map_err(|_| "failed to join reference stderr reader".to_string())?;
            stderr_read.map_err(|err| format!("failed to read reference stderr: {err}"))?;
            // The wrapper may already be fully present even if the process had
            // not exited before the last watchdog poll. Never discard it solely
            // because process teardown crossed the boundary.
            if let Ok(result) = decode_reference_solver_stdout(&stdout, request, started, deadline)
            {
                return validate_cloud_solver_result(result, cloud_profile.as_ref());
            }
            return Ok(reference_timeout_payload(request, started, stderr.trim()));
        }
        thread::sleep(Duration::from_millis(100));
    }

    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for reference solver: {err}"))?;
    let (stdout, stdout_read) = stdout_reader
        .join()
        .map_err(|_| "failed to join reference stdout reader".to_string())?;
    stdout_read.map_err(|err| format!("failed to read reference stdout: {err}"))?;
    let (stderr, stderr_read) = stderr_reader
        .join()
        .map_err(|_| "failed to join reference stderr reader".to_string())?;
    stderr_read.map_err(|err| format!("failed to read reference stderr: {err}"))?;
    if !status.success() {
        return Err(format!(
            "reference solver exited with {:?}: {}",
            status.code(),
            stderr.trim()
        ));
    }

    let result = decode_reference_solver_stdout(&stdout, request, started, deadline).map_err(|err| {
        format!(
            "reference solver returned invalid JSON: {err}; stderr={}",
            stderr.trim()
        )
    })?;
    validate_cloud_solver_result(result, cloud_profile.as_ref())
}

fn reference_solver_error_status(error: &str) -> u16 {
    if error == "reference solver script not found"
        || error.starts_with("failed to start reference solver:")
    {
        503
    } else {
        500
    }
}

fn reference_solver_error_kind(error: &str) -> &'static str {
    if reference_solver_error_status(error) == 503 {
        "reference_solver_unavailable"
    } else {
        "reference_solver_failed"
    }
}

fn response_json_payload(response: &[u8]) -> Option<Value> {
    let body_start = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?
        + 4;
    serde_json::from_slice(response.get(body_start..)?).ok()
}

fn solver_execution_outcome_from_response(
    response: &[u8],
    cancel_requested: bool,
) -> ReservationOutcome {
    if cancel_requested {
        return ReservationOutcome::Cancelled;
    }
    let status = std::str::from_utf8(response)
        .ok()
        .and_then(|text| text.lines().next())
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok());
    let payload_ok = response_json_payload(response)
        .and_then(|payload| payload.get("ok").and_then(Value::as_bool))
        .unwrap_or(true);
    if status.is_some_and(|value| (200..300).contains(&value)) && payload_ok {
        ReservationOutcome::Completed
    } else {
        ReservationOutcome::Failed
    }
}

fn solver_response_with_progress(
    response: Vec<u8>,
    progress: Option<&Value>,
    progress_updated_ms: Option<u64>,
    started_at_ms: Option<u64>,
    best_effort_stop_requested: bool,
) -> Vec<u8> {
    if progress.is_none() && started_at_ms.is_none() && !best_effort_stop_requested {
        return response;
    }
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return response;
    };
    let Some(status) = std::str::from_utf8(&response[..header_end])
        .ok()
        .and_then(|header| header.lines().next())
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
    else {
        return response;
    };
    let Some(mut payload) = response_json_payload(&response) else {
        return response;
    };
    let Some(payload) = payload.as_object_mut() else {
        return response;
    };
    if let Some(progress) = progress {
        payload.insert("progress".to_string(), progress.clone());
    }
    if let Some(updated_ms) = progress_updated_ms {
        payload.insert("progressUpdatedAtMs".to_string(), json!(updated_ms));
    }
    if let Some(started_at_ms) = started_at_ms {
        payload.insert("startedAtMs".to_string(), json!(started_at_ms));
    }
    if best_effort_stop_requested {
        payload.insert("bestEffortStopRequested".to_string(), json!(true));
    }
    json_response(status, Value::Object(payload.clone()))
}

enum ServerCoordinatorStart {
    Serverless {
        fence: ServerExecutionFence,
        profile: serverless::ServerlessProfile,
        fallback_to_vps: bool,
    },
    Vps {
        fence: ServerExecutionFence,
        initial_guard: Option<SolverJobGuard>,
    },
    Agent {
        fence: ServerExecutionFence,
    },
}

enum AgentBestEffortStopOutcome {
    NotRequested,
    Completed,
    FallbackToVps {
        fence: ServerExecutionFence,
        checkpoint: Option<Value>,
    },
    Stale,
}

fn stop_agent_best_effort_if_requested(
    app: &App,
    job_id: &str,
    owner: &SolverOwner,
    fence: ServerExecutionFence,
    request: Option<&Value>,
) -> AgentBestEffortStopOutcome {
    let Some(snapshot) = app.solver_pool.server_execution_snapshot(job_id, owner) else {
        return AgentBestEffortStopOutcome::Stale;
    };
    if snapshot.generation != fence.generation
        || snapshot.phase.executor() != Some(ServerExecutor::Agent)
    {
        return AgentBestEffortStopOutcome::Stale;
    }
    if !snapshot.best_effort_stop_requested {
        return AgentBestEffortStopOutcome::NotRequested;
    }

    // Closing the Agent task and taking its accepted candidate share one
    // coordinator lock. A worker can therefore neither publish a late result
    // beside the VPS nor lose a candidate that arrived just before Stop.
    let resume_checkpoint = match app.agent_helper.take_for_best_effort_stop(job_id, owner) {
        AgentStopTakeover::Terminal(candidate) => {
            if automatic_best_effort_stop_quality_unmet(request, &candidate.payload) {
                // Stop may retain the best hard-valid timetable, but the first
                // Fresh Automatic result still has to satisfy 0/0.  Hand the
                // rough timetable to VPS as a warm start instead of publishing
                // it as the user's final result.
                Some(candidate.payload)
            } else {
                let response = json_response(200, candidate.payload);
                let response =
                    if let Some(request) = request {
                        let remaining_watchdog_ms = app
                            .solver_pool
                            .server_job_watchdog_remaining_ms(job_id, owner, now_millis());
                        server_watchdog_final_response(request, response, remaining_watchdog_ms)
                    } else {
                        response
                    };
                return if app
                    .solver_pool
                    .complete_server_job_fenced(fence, job_id, owner, response)
                {
                    AgentBestEffortStopOutcome::Completed
                } else {
                    AgentBestEffortStopOutcome::Stale
                };
            }
        }
        AgentStopTakeover::Resume(candidate) => Some(candidate.payload),
        AgentStopTakeover::Empty => None,
    };

    // A focused run always starts from a complete incumbent. When Stop lands
    // before the Browser Agent has uploaded its first checkpoint, returning
    // that already validated incumbent is both safer and faster than starting
    // a VPS process only for its stop-file path to return the same timetable.
    if resume_checkpoint.is_none() {
        if let Some(request) = request {
            if let Some((status, payload)) = complete_existing_incumbent_payload(
                request,
                "best_effort_stop_before_checkpoint",
                "No accepted Agent checkpoint was available; retained the complete incumbent.",
            ) {
                if let Ok(payload) = serde_json::from_str::<Value>(&payload) {
                    let response = json_response(status, payload);
                    return if app
                        .solver_pool
                        .complete_server_job_fenced(fence, job_id, owner, response)
                    {
                        AgentBestEffortStopOutcome::Completed
                    } else {
                        AgentBestEffortStopOutcome::Stale
                    };
                }
            }
        }
    }

    if let Some(response) = required_agent_failure_response(
        app,
        job_id,
        owner,
        request,
        "native_agent_stopped",
        "browser_agent_stopped",
    ) {
        return if app
            .solver_pool
            .complete_server_job_fenced(fence, job_id, owner, response)
        {
            app.agent_helper.finish_job(job_id, owner);
            AgentBestEffortStopOutcome::Completed
        } else {
            AgentBestEffortStopOutcome::Stale
        };
    }

    app.solver_pool
        .fallback_agent_to_vps(fence, job_id, owner)
        .map(|fence| AgentBestEffortStopOutcome::FallbackToVps {
            fence,
            checkpoint: resume_checkpoint,
        })
        .unwrap_or(AgentBestEffortStopOutcome::Stale)
}

fn cleanup_server_owned_job(app: &App, job_id: &str, owner: &SolverOwner) {
    app.agent_helper.finish_job(job_id, owner);
    app.solver_pool.abandon_server_job(job_id, owner);
}

/// Start a privacy-safe per-attempt telemetry row.  The helper deliberately
/// receives only solver settings and Cloud profile metadata; no owner, job ID,
/// timetable, request body or error text is passed to the telemetry store.
fn start_server_solver_telemetry(
    app: &App,
    executor: &str,
    request: Option<&Value>,
    cloud_profile: Option<&serverless::ServerlessProfile>,
) -> solver_telemetry::ServerRun {
    let metadata = solver_telemetry::ServerRunMetadata::from_request(
        executor,
        request,
        cloud_profile.map(|profile| profile.id.as_str()),
        cloud_profile.map(|profile| profile.solver_digest.as_str()),
    );
    solver_telemetry::ServerRun::start(Arc::clone(&app.db), metadata)
}

fn telemetry_outcome_from_reservation(outcome: ReservationOutcome) -> &'static str {
    match outcome {
        ReservationOutcome::Completed => "completed",
        ReservationOutcome::Failed => "failed",
        ReservationOutcome::Cancelled => "cancelled",
        ReservationOutcome::Released => "released",
    }
}

fn server_request_with_agent_checkpoint(
    request: Option<&Value>,
    checkpoint: &Value,
) -> Option<Value> {
    let mut request = request?.clone();
    if !request.is_object() || !checkpoint.is_object() {
        return None;
    }
    let complete_checkpoint = reference_payload_complete(checkpoint);
    let mobile_checkpoint_vps_refine =
        complete_checkpoint && browser_mobile_checkpoint_vps_refine(checkpoint);
    let fresh_automatic_recovery =
        complete_checkpoint && fresh_automatic_quality_gate_required(&request);
    let scheduled_periods = checkpoint
        .get("metrics")
        .and_then(|metrics| metrics.get("scheduled_periods"))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let fixed_periods = request
        .get("data")
        .map(count_fixed_tkb_cells)
        .unwrap_or_default() as u64;
    let checkpoint_has_search_progress =
        complete_checkpoint || fixed_periods == 0 || scheduled_periods > fixed_periods;
    let canonical_solve_kind = request
        .get("settings")
        .and_then(|settings| settings.get("ui_unified_solve_kind"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let fresh_completion_fallback = !complete_checkpoint
        && matches!(
            canonical_solve_kind.as_str(),
            "fresh_complete_first" | "repair_constraints"
        );

    if !checkpoint_has_search_progress || fresh_completion_fallback {
        let data = ensure_object_child(&mut request, "data");
        for key in [
            "tkbSolverResult",
            "tkbRustSolverResult",
            "tkbSolverPayload",
            "solverResult",
            "solverMetrics",
        ] {
            data.remove(key);
        }
        let settings = ensure_object_child(&mut request, "settings");
        settings.insert("optimize_existing_schedule".to_string(), json!(false));
        settings.insert("existing_fill_missing_schedule".to_string(), json!(false));
        settings.insert("preserve_existing_tkb".to_string(), json!(false));
        settings.insert("preserve_fixed_lessons_only".to_string(), json!(true));
        settings.insert("partial_existing_rebuild".to_string(), json!(false));
        settings.insert("repair_fill_first".to_string(), json!(false));
        settings.insert("repair_partial_existing".to_string(), json!(false));
        settings.insert("force_fresh_backend_solve".to_string(), json!(true));
        settings.insert("allow_backend_cache".to_string(), json!(false));
        settings.insert("allow_solver_warm_start".to_string(), json!(false));
        settings.insert("require_complete_schedule".to_string(), json!(true));
        settings.insert("best_effort_on_timeout".to_string(), json!(false));
        settings.insert("native_skip_teacher_optimization".to_string(), json!(true));
        settings.insert(
            "ui_stop_after_first_complete_schedule".to_string(),
            json!(true),
        );
        settings.insert(
            "optimization_first_click_quality_time_limit_seconds".to_string(),
            json!(0),
        );
        settings.insert("optimization_time_limit_seconds".to_string(), json!(0));
        settings.insert(
            "ui_unified_solve_kind".to_string(),
            json!("fresh_complete_first"),
        );
        settings.insert("ui_unified_partial_repair".to_string(), json!(false));
        settings.insert("ui_agent_checkpoint_fallback".to_string(), json!(true));
        settings.insert(
            "ui_agent_checkpoint_no_progress_fresh".to_string(),
            json!(!checkpoint_has_search_progress),
        );
        settings.insert(
            "ui_agent_checkpoint_partial_fresh".to_string(),
            json!(fresh_completion_fallback),
        );
        for key in [
            "native_force_rust_solver",
            "disable_reference_solver",
            "disable_hybrid_reference_solver",
            "ui_use_existing_complete_incumbent",
            "ui_existing_incumbent_revalidated",
            "ui_return_complete_incumbent_on_existing_optimize_failure",
            "ui_browser_wasm_ready",
            "ui_browser_cpsat_ready",
            "browser_wasm_refinement",
            "browser_wasm_quick_attempt",
            "browser_wasm_automatic_progressive_search",
            "browser_wasm_automatic_phase",
        ] {
            settings.remove(key);
        }
        return Some(request);
    }

    ensure_object_child(&mut request, "data")
        .insert("tkbSolverResult".to_string(), checkpoint.clone());
    let settings = ensure_object_child(&mut request, "settings");
    let missing_periods = checkpoint
        .get("metrics")
        .and_then(|metrics| metrics.get("unassigned_periods"))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    settings.insert("optimize_existing_schedule".to_string(), json!(true));
    settings.insert(
        "existing_fill_missing_schedule".to_string(),
        json!(!complete_checkpoint),
    );
    settings.insert("preserve_existing_tkb".to_string(), json!(true));
    settings.insert("preserve_fixed_lessons_only".to_string(), json!(true));
    settings.insert(
        "preserve_existing_min_ratio".to_string(),
        json!(if complete_checkpoint { 1 } else { 0 }),
    );
    settings.insert(
        "force_preserve_partial_existing".to_string(),
        json!(!complete_checkpoint),
    );
    settings.insert(
        "partial_existing_rebuild".to_string(),
        json!(!complete_checkpoint),
    );
    settings.insert("repair_fill_first".to_string(), json!(!complete_checkpoint));
    settings.insert(
        "repair_partial_existing".to_string(),
        json!(!complete_checkpoint),
    );
    settings.insert(
        "repair_existing_missing_periods".to_string(),
        json!(if complete_checkpoint {
            0
        } else {
            missing_periods
        }),
    );
    settings.insert(
        "repair_fill_first_max_missing".to_string(),
        json!(if complete_checkpoint {
            0
        } else {
            missing_periods.max(96)
        }),
    );
    settings.insert("force_fresh_backend_solve".to_string(), json!(false));
    settings.insert("allow_backend_cache".to_string(), json!(false));
    settings.insert("allow_solver_warm_start".to_string(), json!(true));
    settings.insert("require_complete_schedule".to_string(), json!(true));
    settings.insert("best_effort_on_timeout".to_string(), json!(false));
    settings.insert(
        "ui_unified_solve_kind".to_string(),
        json!(if complete_checkpoint {
            "refine_complete"
        } else {
            "repair_partial"
        }),
    );
    settings.insert(
        "ui_unified_partial_repair".to_string(),
        json!(!complete_checkpoint),
    );
    settings.insert(
        "ui_use_existing_complete_incumbent".to_string(),
        json!(complete_checkpoint),
    );
    settings.insert(
        "ui_existing_incumbent_revalidated".to_string(),
        json!(complete_checkpoint),
    );
    settings.insert(
        "ui_return_complete_incumbent_on_existing_optimize_failure".to_string(),
        json!(complete_checkpoint),
    );
    settings.insert("ui_agent_checkpoint_fallback".to_string(), json!(true));
    settings.remove("ui_agent_checkpoint_hard_valid_timeout_fallback");
    if mobile_checkpoint_vps_refine {
        // The phone already contributed a server-validated, complete recovery
        // point. VPS still receives the full strict quality window; only a
        // terminal timeout/error may fall back to this hard-valid timetable.
        settings.insert(
            "ui_agent_checkpoint_hard_valid_timeout_fallback".to_string(),
            json!(true),
        );
    }
    if fresh_automatic_recovery {
        // Preserve the first-click quality contract while changing the execution
        // owner. The checkpoint remains a warm start, but VPS must continue the
        // singleton/Gap2 cleanup instead of publishing it as a finished result.
        settings.insert(
            "ui_agent_fresh_automatic_quality_recovery".to_string(),
            json!(true),
        );
        settings.insert("optimization_focus".to_string(), json!("automatic"));
        settings.insert(
            "optimization_continue_quality_search".to_string(),
            json!(true),
        );
        settings.insert(
            "ui_stop_after_first_complete_schedule".to_string(),
            json!(false),
        );
        settings.insert(
            "optimization_first_click_skip_global_quality".to_string(),
            json!(false),
        );
        settings.insert(
            "optimization_first_click_continue_local_after_complete".to_string(),
            json!(true),
        );
        settings.insert("max_one_period_sessions".to_string(), json!(0));
        settings.insert("strict_one_period_sessions_cap".to_string(), json!(true));
        settings.insert("enforce_max_one_period_sessions".to_string(), json!(true));
        settings.insert("one_period_priority_absolute".to_string(), json!(true));
        settings.insert("target_gap2_plus_sessions".to_string(), json!(0));
        settings.insert("period_max_teacher_gap".to_string(), json!(1));
    }
    for key in [
        "ui_browser_wasm_ready",
        "ui_browser_cpsat_ready",
        "browser_wasm_refinement",
        "browser_wasm_quick_attempt",
        "browser_wasm_automatic_progressive_search",
        "browser_wasm_automatic_phase",
    ] {
        settings.remove(key);
    }
    Some(request)
}

fn apply_agent_checkpoint_to_server_request(
    body: &mut Arc<Vec<u8>>,
    request: &mut Option<Value>,
    checkpoint: Option<Value>,
) {
    let Some(checkpoint) = checkpoint else {
        return;
    };
    let Some(checkpoint_request) =
        server_request_with_agent_checkpoint(request.as_ref(), &checkpoint)
    else {
        return;
    };
    let Ok(checkpoint_body) = serde_json::to_vec(&checkpoint_request) else {
        return;
    };
    *body = Arc::new(checkpoint_body);
    *request = Some(checkpoint_request);
}

fn spawn_server_owned_solver(
    app: &App,
    job_id: String,
    owner: SolverOwner,
    desired_workers: usize,
    body: Arc<Vec<u8>>,
    request: Option<Value>,
    start: ServerCoordinatorStart,
) -> Result<(), String> {
    let (body, request) = if let Some(request) = request {
        let request = server_request_with_canonical_seed(&request, &job_id);
        let body = serde_json::to_vec(&request).map(Arc::new).unwrap_or(body);
        (body, Some(request))
    } else {
        (body, None)
    };
    let background_app = app.clone();
    let cleanup_job_id = job_id.clone();
    let cleanup_owner = owner.clone();
    thread::Builder::new()
        .name("tkb-server-solver".to_string())
        .spawn(move || {
            let mut body = body;
            let mut request = request;
            let mut mode = start;
            'coordinator: loop {
                if background_app
                    .solver_pool
                    .server_job_cancel_requested(&job_id, &owner)
                {
                    if matches!(&mode, ServerCoordinatorStart::Serverless { .. }) {
                        // The Cloud request has not crossed the dispatch gate
                        // yet, so no billable work exists. Release only an
                        // undispatched row; a running Cloud request is left
                        // for its own terminal reconciliation below.
                        background_app.serverless.mark_cancel_requested(&job_id);
                        background_app.serverless.release_before_dispatch(&job_id);
                    }
                    cleanup_server_owned_job(&background_app, &job_id, &owner);
                    return;
                }

                match mode {
                    ServerCoordinatorStart::Serverless {
                        fence,
                        profile,
                        fallback_to_vps,
                    } => {
                        if !background_app
                            .solver_pool
                            .execution_fence_current(fence, &job_id, &owner)
                        {
                            let cancelled = background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner);
                            if cancelled {
                                background_app.serverless.mark_cancel_requested(&job_id);
                                background_app.serverless.release_before_dispatch(&job_id);
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                            } else {
                                let snapshot = background_app
                                    .solver_pool
                                    .server_execution_snapshot(&job_id, &owner);
                                // If the original job was already abandoned,
                                // a new request may have reused the same job
                                // ID. Never let this stale coordinator delete
                                // that newer reservation. A pending/new
                                // generation is not a VPS rescue target.
                                if snapshot.is_none()
                                    || snapshot.as_ref().is_some_and(|snapshot| {
                                        snapshot.phase == ServerExecutionPhase::Pending
                                            || snapshot.generation < fence.generation
                                    })
                                {
                                    return;
                                }
                                // Another fenced executor (normally the VPS
                                // rescue) won ownership. Reconcile the Cloud
                                // reservation as a failed/discarded attempt;
                                // do not abandon the canonical job now owned
                                // by that executor.
                                if !background_app
                                    .serverless
                                    .release_before_dispatch(&job_id)
                                {
                                    background_app.serverless.reconcile_outcome(
                                        &job_id,
                                        None,
                                        ReservationOutcome::Failed,
                                    );
                                }
                            }
                            return;
                        }
                        if !background_app.solver_pool.mark_serverless_execution_running(
                            fence,
                            &job_id,
                            &owner,
                        ) {
                            background_app.serverless.release_before_dispatch(&job_id);
                            cleanup_server_owned_job(&background_app, &job_id, &owner);
                            return;
                        }
                        let mut cloud_telemetry = start_server_solver_telemetry(
                            &background_app,
                            "cloud_run",
                            request.as_ref(),
                            Some(&profile),
                        );
                        let remaining_watchdog_ms = background_app
                            .solver_pool
                            .server_job_watchdog_remaining_ms(&job_id, &owner, now_millis());
                        let watchdog_expired = request.is_some()
                            && remaining_watchdog_ms
                                .is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS);
                        let executor_request = request.as_ref().map(|request| {
                            remaining_watchdog_ms
                                .filter(|_| !watchdog_expired)
                                .map(|remaining_ms| {
                                    server_request_with_remaining_watchdog(request, remaining_ms)
                                })
                                .unwrap_or_else(|| request.clone())
                        });
                        let executor_body = remaining_watchdog_ms
                            .filter(|_| !watchdog_expired)
                            .map(|remaining_ms| {
                                server_request_body_with_remaining_watchdog(
                                    &body,
                                    request.as_ref(),
                                    remaining_ms,
                                )
                            })
                            .unwrap_or_else(|| Arc::clone(&body));

                        let cloud_attempt_started = Instant::now();
                        let attempt = if watchdog_expired {
                            Err("serverless_watchdog_exhausted".to_string())
                        } else if let Some(executor_request) = executor_request.as_ref() {
                            if !background_app.serverless.mark_dispatched(&job_id) {
                                Err("serverless_reservation_missing".to_string())
                            } else {
                            let cancel_requested = AtomicBool::new(false);
                            let best_effort_stop_requested = AtomicBool::new(false);
                            panic::catch_unwind(AssertUnwindSafe(|| {
                                run_reference_solver(
                                    &background_app,
                                    &executor_body,
                                    executor_request,
                                    &job_id,
                                    &cancel_requested,
                                    &best_effort_stop_requested,
                                    Some(fence.generation),
                                    desired_workers,
                                    ReferenceSolverTransport::CloudRun(profile.clone()),
                                    Some(&owner),
                                )
                            }))
                            .unwrap_or_else(|_| Err("serverless_solver_panicked".to_string()))
                            }
                        } else {
                            Err("serverless_request_invalid".to_string())
                        };

                        let terminal = match attempt {
                            Ok((status, payload)) => {
                                let kind = serde_json::from_str::<Value>(&payload)
                                    .ok()
                                    .and_then(|value| {
                                        value
                                            .get("kind")
                                            .and_then(Value::as_str)
                                            .map(str::to_string)
                                    })
                                    .unwrap_or_default();
                                let infrastructure_failure = status >= 500
                                    || kind.starts_with("cloud_solver_")
                                    || kind.starts_with("serverless_");
                                if kind == "solver_cancelled"
                                    || background_app
                                        .solver_pool
                                        .server_job_cancel_requested(&job_id, &owner)
                                {
                                    Err("serverless_cancelled".to_string())
                                } else if infrastructure_failure {
                                    Err(format!("{kind}:{status}"))
                                } else {
                                    Ok(solve_payload_response(
                                        &background_app,
                                        &executor_body,
                                        status,
                                        payload,
                                        "google-cloud-run-reference",
                                    ))
                                }
                            }
                            Err(error) => Err(error),
                        };
                        let cloud_elapsed_ms = cloud_attempt_started
                            .elapsed()
                            .as_millis()
                            .min(u64::MAX as u128) as u64;
                        let estimated_actual_usd =
                            ServerlessCoordinator::estimate_actual_cost_usd(
                                &profile,
                                cloud_elapsed_ms,
                            );

                        match terminal {
                            Ok(response) => {
                                let response = if let Some(request) = request.as_ref() {
                                    let remaining = background_app
                                        .solver_pool
                                        .server_job_watchdog_remaining_ms(
                                            &job_id,
                                            &owner,
                                            now_millis(),
                                        );
                                    server_watchdog_final_response(request, response, remaining)
                                } else {
                                    response
                                };
                                let response_payload = response_json_payload(&response);
                                let response_outcome = solver_execution_outcome_from_response(
                                    &response,
                                    background_app
                                        .solver_pool
                                        .server_job_cancel_requested(&job_id, &owner),
                                );
                                let accepted = background_app.solver_pool.complete_server_job_fenced(
                                    fence,
                                    &job_id,
                                    &owner,
                                    response,
                                );
                                if accepted {
                                    // Commit only after the canonical fence is
                                    // accepted. A simultaneous Cancel can win
                                    // the fence during response serialization;
                                    // that result must be charged as cancelled,
                                    // never as a successful timetable.
                                    background_app.serverless.reconcile_outcome(
                                        &job_id,
                                        Some(estimated_actual_usd),
                                        ReservationOutcome::Completed,
                                    );
                                    cloud_telemetry.finish(
                                        telemetry_outcome_from_reservation(response_outcome),
                                        response_payload.as_ref(),
                                        Some("none"),
                                        Some(estimated_actual_usd),
                                    );
                                    background_app.agent_helper.finish_job(&job_id, &owner);
                                } else {
                                    let outcome = if background_app
                                        .solver_pool
                                        .server_job_cancel_requested(&job_id, &owner)
                                    {
                                        ReservationOutcome::Cancelled
                                    } else {
                                        ReservationOutcome::Failed
                                    };
                                    background_app.serverless.reconcile_outcome(
                                        &job_id,
                                        Some(estimated_actual_usd),
                                        outcome,
                                    );
                                    cloud_telemetry.finish(
                                        telemetry_outcome_from_reservation(outcome),
                                        response_payload.as_ref(),
                                        Some("none"),
                                        Some(estimated_actual_usd),
                                    );
                                    cleanup_server_owned_job(&background_app, &job_id, &owner);
                                }
                                return;
                            }
                            Err(error) => {
                                let cancelled = error == "serverless_cancelled"
                                    || background_app
                                        .solver_pool
                                        .server_job_cancel_requested(&job_id, &owner);
                                let never_dispatched = matches!(
                                    error.as_str(),
                                    "serverless_watchdog_exhausted"
                                        | "serverless_request_invalid"
                                        | "serverless_reservation_missing"
                                );
                                let telemetry_failure_outcome = if cancelled {
                                    "cancelled"
                                } else if error == "serverless_watchdog_exhausted" {
                                    "timeout"
                                } else if never_dispatched {
                                    "released"
                                } else {
                                    "failed"
                                };
                                if never_dispatched {
                                    background_app.serverless.release_before_dispatch(&job_id);
                                } else {
                                    background_app.serverless.reconcile_outcome(
                                        &job_id,
                                        Some(estimated_actual_usd),
                                        if cancelled {
                                            ReservationOutcome::Cancelled
                                        } else {
                                            ReservationOutcome::Failed
                                        },
                                    );
                                }
                                if cancelled {
                                    cloud_telemetry.finish(
                                        "cancelled",
                                        None,
                                        Some("none"),
                                        Some(estimated_actual_usd),
                                    );
                                    cleanup_server_owned_job(&background_app, &job_id, &owner);
                                    return;
                                }
                                if fallback_to_vps
                                    && cloud_elapsed_ms <= SERVERLESS_EARLY_FALLBACK_MAX_MS
                                {
                                    if let Some(vps_fence) = background_app
                                        .solver_pool
                                        .fallback_serverless_to_vps(fence, &job_id, &owner)
                                    {
                                        cloud_telemetry.finish(
                                            telemetry_failure_outcome,
                                            None,
                                            Some("vps"),
                                            Some(estimated_actual_usd),
                                        );
                                        mode = ServerCoordinatorStart::Vps {
                                            fence: vps_fence,
                                            initial_guard: None,
                                        };
                                        continue 'coordinator;
                                    }
                                }
                                let response = json_response(
                                    503,
                                    json!({
                                        "ok": false,
                                        "kind": "serverless_solver_unavailable",
                                        "error": "serverless_solver_unavailable",
                                        "detail": error.chars().take(500).collect::<String>(),
                                        "jobId": job_id,
                                        "fallback": false
                                    }),
                                );
                                let _ = background_app.solver_pool.complete_server_job_fenced(
                                    fence,
                                    &job_id,
                                    &owner,
                                    response,
                                );
                                cloud_telemetry.finish(
                                    telemetry_failure_outcome,
                                    None,
                                    Some("none"),
                                    Some(estimated_actual_usd),
                                );
                                return;
                            }
                        }
                    }
                    ServerCoordinatorStart::Vps {
                        fence,
                        mut initial_guard,
                    } => {
                        background_app.serverless.record_execution_requested(
                            &job_id,
                            owner.school_id(),
                            owner.login_id(),
                            "vps",
                        );
                        let mut vps_telemetry = start_server_solver_telemetry(
                            &background_app,
                            "vps",
                            request.as_ref(),
                            None,
                        );
                        let job_guard = loop {
                            // An Agent hello can land after its expired task was
                            // atomically removed but just before the coordinator
                            // commits the VPS fallback generation. Recheck live
                            // owner workers at the final VPS start gate so that
                            // narrow reconnect window returns the same canonical
                            // job to the device without starting a server child.
                            if handoff_online_agent_before_vps_start(
                                &background_app,
                                &job_id,
                                &owner,
                            ) {
                                drop(initial_guard.take());
                                break None;
                            }
                            if request.is_some()
                                && background_app
                                    .solver_pool
                                    .server_job_watchdog_remaining_ms(&job_id, &owner, now_millis())
                                    .is_some_and(|remaining_ms| {
                                        remaining_ms < MIN_SOLVER_DEADLINE_MS
                                    })
                            {
                                let response = server_watchdog_timeout_response(
                                    request.as_ref().expect("watchdog request is present"),
                                );
                                let response_payload = response_json_payload(&response);
                                if background_app
                                    .solver_pool
                                    .complete_server_job_fenced(fence, &job_id, &owner, response)
                                {
                                    background_app.serverless.record_execution_outcome(
                                        &job_id,
                                        owner.school_id(),
                                        owner.login_id(),
                                        "vps",
                                        ReservationOutcome::Failed,
                                    );
                                    vps_telemetry.finish(
                                        "timeout",
                                        response_payload.as_ref(),
                                        Some("none"),
                                        None,
                                    );
                                    background_app.agent_helper.finish_job(&job_id, &owner);
                                    return;
                                }
                            }
                            if background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner)
                            {
                                background_app.serverless.record_execution_outcome(
                                    &job_id,
                                    owner.school_id(),
                                    owner.login_id(),
                                    "vps",
                                    ReservationOutcome::Cancelled,
                                );
                                vps_telemetry.finish("cancelled", None, Some("none"), None);
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                                return;
                            }
                            if !background_app
                                .solver_pool
                                .execution_fence_current(fence, &job_id, &owner)
                            {
                                break None;
                            }
                            let admission = if let Some(guard) = initial_guard.take() {
                                SolverAdmission::Acquired(guard)
                            } else {
                                background_app.solver_pool.acquire_or_enqueue_for_owner(
                                    job_id.clone(),
                                    desired_workers,
                                    owner.clone(),
                                )
                            };
                            match admission {
                                SolverAdmission::Acquired(guard) => {
                                    if background_app
                                        .solver_pool
                                        .mark_vps_execution_running(fence, &job_id, &owner)
                                    {
                                        background_app.serverless.record_execution_started(
                                            &job_id,
                                            owner.school_id(),
                                            owner.login_id(),
                                            "vps",
                                        );
                                        break Some(guard);
                                    }
                                    drop(guard);
                                    break None;
                                }
                                SolverAdmission::Queued { .. }
                                | SolverAdmission::AlreadyRunning => {
                                    thread::sleep(Duration::from_millis(100));
                                }
                            }
                        };

                        let Some(job_guard) = job_guard else {
                            if let Some(agent_fence) = background_app
                                .solver_pool
                                .prepare_agent_execution(&job_id, &owner)
                            {
                                background_app.serverless.record_execution_outcome(
                                    &job_id,
                                    owner.school_id(),
                                    owner.login_id(),
                                    "vps",
                                    ReservationOutcome::Released,
                                );
                                vps_telemetry.finish("released", None, Some("agent"), None);
                                mode = ServerCoordinatorStart::Agent { fence: agent_fence };
                                continue;
                            }
                            if background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner)
                            {
                                background_app.serverless.record_execution_outcome(
                                    &job_id,
                                    owner.school_id(),
                                    owner.login_id(),
                                    "vps",
                                    ReservationOutcome::Cancelled,
                                );
                                vps_telemetry.finish("cancelled", None, Some("none"), None);
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                            } else {
                                background_app.serverless.record_execution_outcome(
                                    &job_id,
                                    owner.school_id(),
                                    owner.login_id(),
                                    "vps",
                                    ReservationOutcome::Released,
                                );
                                vps_telemetry.finish("released", None, Some("none"), None);
                            }
                            return;
                        };

                        let remaining_watchdog_ms = background_app
                            .solver_pool
                            .server_job_watchdog_remaining_ms(&job_id, &owner, now_millis());
                        let watchdog_expired = request.is_some()
                            && remaining_watchdog_ms
                                .is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS);
                        let executor_request = request.as_ref().map(|request| {
                            remaining_watchdog_ms
                                .filter(|_| !watchdog_expired)
                                .map(|remaining_ms| {
                                    server_request_with_remaining_watchdog(request, remaining_ms)
                                })
                                .unwrap_or_else(|| request.clone())
                        });
                        let executor_body = remaining_watchdog_ms
                            .filter(|_| !watchdog_expired)
                            .map(|remaining_ms| {
                                server_request_body_with_remaining_watchdog(
                                    &body,
                                    request.as_ref(),
                                    remaining_ms,
                                )
                            })
                            .unwrap_or_else(|| Arc::clone(&body));
                        let response = if watchdog_expired {
                            server_watchdog_timeout_response(
                                request.as_ref().expect("watchdog request is present"),
                            )
                        } else {
                            panic::catch_unwind(AssertUnwindSafe(|| {
                                solve_admitted_json(
                                    &background_app,
                                    &executor_body,
                                    executor_request.as_ref(),
                                    &job_guard,
                                    Some(fence.generation),
                                )
                            }))
                            .unwrap_or_else(|_| {
                                json_response(
                                    500,
                                    json!({
                                        "ok": false,
                                        "kind": "solver_worker_panicked",
                                        "error": "solver_worker_panicked",
                                        "jobId": job_id
                                    }),
                                )
                            })
                        };

                        let response = if let Some(request) = request.as_ref() {
                            let remaining_watchdog_ms = background_app
                                .solver_pool
                                .server_job_watchdog_remaining_ms(&job_id, &owner, now_millis());
                            server_watchdog_final_response(request, response, remaining_watchdog_ms)
                        } else {
                            response
                        };
                        let vps_outcome = solver_execution_outcome_from_response(
                            &response,
                            background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner),
                        );
                        let vps_telemetry_outcome = if watchdog_expired {
                            "timeout"
                        } else {
                            telemetry_outcome_from_reservation(vps_outcome)
                        };
                        let response_payload = response_json_payload(&response);

                        // The child process has been killed/waited by the solver
                        // path before it returns. Drop the CPU guard as the last
                        // local-executor step, then expose Agent work.
                        drop(job_guard);
                        if background_app
                            .solver_pool
                            .complete_server_job_fenced(fence, &job_id, &owner, response)
                        {
                            background_app.serverless.record_execution_outcome(
                                &job_id,
                                owner.school_id(),
                                owner.login_id(),
                                "vps",
                                vps_outcome,
                            );
                            vps_telemetry.finish(
                                vps_telemetry_outcome,
                                response_payload.as_ref(),
                                Some("none"),
                                None,
                            );
                            background_app.agent_helper.finish_job(&job_id, &owner);
                            return;
                        }
                        let handoff_outcome = if background_app
                            .solver_pool
                            .server_job_cancel_requested(&job_id, &owner)
                        {
                            ReservationOutcome::Cancelled
                        } else {
                            ReservationOutcome::Failed
                        };
                        background_app.serverless.record_execution_outcome(
                            &job_id,
                            owner.school_id(),
                            owner.login_id(),
                            "vps",
                            handoff_outcome,
                        );
                        if let Some(agent_fence) = background_app
                            .solver_pool
                            .prepare_agent_execution(&job_id, &owner)
                        {
                            vps_telemetry.finish(
                                telemetry_outcome_from_reservation(handoff_outcome),
                                response_payload.as_ref(),
                                Some("agent"),
                                None,
                            );
                            mode = ServerCoordinatorStart::Agent { fence: agent_fence };
                            continue;
                        }
                        vps_telemetry.finish(
                            telemetry_outcome_from_reservation(handoff_outcome),
                            response_payload.as_ref(),
                            Some("none"),
                            None,
                        );
                        if background_app
                            .solver_pool
                            .server_job_cancel_requested(&job_id, &owner)
                        {
                            cleanup_server_owned_job(&background_app, &job_id, &owner);
                        }
                        return;
                    }
                    ServerCoordinatorStart::Agent { fence } => {
                        match stop_agent_best_effort_if_requested(
                            &background_app,
                            &job_id,
                            &owner,
                            fence,
                            request.as_ref(),
                        ) {
                            AgentBestEffortStopOutcome::NotRequested => {}
                            AgentBestEffortStopOutcome::Completed => return,
                            AgentBestEffortStopOutcome::FallbackToVps {
                                fence: vps_fence,
                                checkpoint,
                            } => {
                                apply_agent_checkpoint_to_server_request(
                                    &mut body,
                                    &mut request,
                                    checkpoint,
                                );
                                mode = ServerCoordinatorStart::Vps {
                                    fence: vps_fence,
                                    initial_guard: None,
                                };
                                continue 'coordinator;
                            }
                            AgentBestEffortStopOutcome::Stale => {
                                if background_app
                                    .solver_pool
                                    .server_job_cancel_requested(&job_id, &owner)
                                {
                                    cleanup_server_owned_job(&background_app, &job_id, &owner);
                                }
                                return;
                            }
                        }
                        // No Agent task exists while a VPS child is alive. This
                        // registration point is therefore the strict handoff
                        // boundary in both the initial-Agent and VPS->Agent path.
                        let remaining_watchdog_ms = background_app
                            .solver_pool
                            .server_job_watchdog_remaining_ms(&job_id, &owner, now_millis());
                        if request.is_some()
                            && remaining_watchdog_ms
                                .is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS)
                        {
                            let response = required_agent_failure_response(
                                &background_app,
                                &job_id,
                                &owner,
                                request.as_ref(),
                                "native_agent_start_failed",
                                "browser_agent_start_failed",
                            )
                            .unwrap_or_else(|| {
                                server_watchdog_timeout_response(
                                    request.as_ref().expect("watchdog request is present"),
                                )
                            });
                            if background_app
                                .solver_pool
                                .complete_server_job_fenced(fence, &job_id, &owner, response)
                            {
                                background_app.agent_helper.finish_job(&job_id, &owner);
                            }
                            return;
                        }
                        let agent_body = remaining_watchdog_ms
                            .map(|remaining_ms| {
                                server_request_body_with_remaining_watchdog(
                                    &body,
                                    request.as_ref(),
                                    remaining_ms,
                                )
                            })
                            .unwrap_or_else(|| Arc::clone(&body));
                        let trusted_worker_eligible = background_app
                            .solver_pool
                            .trusted_worker_eligible_for_agent_execution(fence, &job_id, &owner);
                        let browser_agent_required = browser_agent_required_for_job(
                            &background_app,
                            &job_id,
                            &owner,
                            request.as_ref(),
                        );
                        if !background_app
                            .agent_helper
                            .register_job_with_execution_policy(
                                &job_id,
                                &owner,
                                agent_body,
                                AGENT_HELPER_SEEDS_PER_JOB,
                                trusted_worker_eligible,
                                browser_agent_required,
                                now_millis(),
                            )
                        {
                            if let Some(response) = required_agent_failure_response(
                                &background_app,
                                &job_id,
                                &owner,
                                request.as_ref(),
                                "native_agent_start_failed",
                                "browser_agent_start_failed",
                            ) {
                                if background_app
                                    .solver_pool
                                    .complete_server_job_fenced(fence, &job_id, &owner, response)
                                {
                                    background_app.agent_helper.finish_job(&job_id, &owner);
                                }
                                return;
                            }
                            let Some(vps_fence) = background_app
                                .solver_pool
                                .fallback_agent_to_vps(fence, &job_id, &owner)
                            else {
                                return;
                            };
                            mode = ServerCoordinatorStart::Vps {
                                fence: vps_fence,
                                initial_guard: None,
                            };
                            continue;
                        }

                        let waiting_since = Instant::now();
                        let mut lease_started = false;
                        let agent_response = loop {
                            if background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner)
                            {
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                                return;
                            }
                            if !background_app
                                .solver_pool
                                .execution_fence_current(fence, &job_id, &owner)
                            {
                                break None;
                            }
                            match stop_agent_best_effort_if_requested(
                                &background_app,
                                &job_id,
                                &owner,
                                fence,
                                request.as_ref(),
                            ) {
                                AgentBestEffortStopOutcome::NotRequested => {}
                                AgentBestEffortStopOutcome::Completed => return,
                                AgentBestEffortStopOutcome::FallbackToVps {
                                    fence: vps_fence,
                                    checkpoint,
                                } => {
                                    apply_agent_checkpoint_to_server_request(
                                        &mut body,
                                        &mut request,
                                        checkpoint,
                                    );
                                    mode = ServerCoordinatorStart::Vps {
                                        fence: vps_fence,
                                        initial_guard: None,
                                    };
                                    continue 'coordinator;
                                }
                                AgentBestEffortStopOutcome::Stale => {
                                    if background_app
                                        .solver_pool
                                        .server_job_cancel_requested(&job_id, &owner)
                                    {
                                        cleanup_server_owned_job(&background_app, &job_id, &owner);
                                    }
                                    return;
                                }
                            }
                            let remaining_watchdog_ms = request.as_ref().and_then(|_| {
                                background_app.solver_pool.server_job_watchdog_remaining_ms(
                                    &job_id,
                                    &owner,
                                    now_millis(),
                                )
                            });
                            let watchdog_expired = request.is_some()
                                && remaining_watchdog_ms.is_some_and(|remaining_ms| {
                                    remaining_ms < MIN_SOLVER_DEADLINE_MS
                                });
                            // A validated candidate wins the boundary race. A
                            // live lease also remains authoritative until its
                            // heartbeat fence is genuinely lost.
                            match background_app.agent_helper.job_execution(
                                &job_id,
                                &owner,
                                now_millis(),
                            ) {
                                Some(AgentJobExecution::Completed {
                                    candidate: Some(candidate),
                                }) => {
                                    if fresh_automatic_terminal_quality_unmet(
                                        request.as_ref(),
                                        &candidate.payload,
                                    ) {
                                        if let Some(response) = required_agent_failure_response(
                                            &background_app,
                                            &job_id,
                                            &owner,
                                            request.as_ref(),
                                            "native_agent_quality_unmet",
                                            "browser_agent_quality_unmet",
                                        ) {
                                            if background_app
                                                .solver_pool
                                                .complete_server_job_fenced(
                                                    fence, &job_id, &owner, response,
                                                )
                                            {
                                                background_app
                                                    .agent_helper
                                                    .finish_job(&job_id, &owner);
                                            }
                                            return;
                                        }
                                        // A native/legacy Agent can still submit a
                                        // hard-valid but rough complete result.  Keep
                                        // it as the VPS warm start and fence this
                                        // canonical job away from another immediate
                                        // Agent retry; never publish it as Fresh
                                        // Automatic's first timetable.
                                        let checkpoint = background_app
                                            .agent_helper
                                            .take_candidate_and_finish_job(&job_id, &owner)
                                            .map(|value| value.payload)
                                            .or_else(|| Some(candidate.payload.clone()));
                                        let _ = background_app
                                            .solver_pool
                                            .set_server_job_agent_preference(
                                                &job_id, &owner, false,
                                            );
                                        let _ = background_app
                                            .solver_pool
                                            .request_no_checkpoint_vps_rescue(&job_id, &owner);
                                        if let Some(vps_fence) = background_app
                                            .solver_pool
                                            .fallback_agent_to_vps(fence, &job_id, &owner)
                                        {
                                            apply_agent_checkpoint_to_server_request(
                                                &mut body,
                                                &mut request,
                                                checkpoint,
                                            );
                                            mode = ServerCoordinatorStart::Vps {
                                                fence: vps_fence,
                                                initial_guard: None,
                                            };
                                            continue 'coordinator;
                                        }
                                        // A concurrent fence won the handoff.  Let
                                        // that owner finish; if no owner remains,
                                        // return the explicit gated failure below.
                                        if let Some(request) = request.as_ref() {
                                            let response =
                                                server_watchdog_timeout_response(request);
                                            if background_app
                                                .solver_pool
                                                .complete_server_job_fenced(
                                                    fence, &job_id, &owner, response,
                                                )
                                            {
                                                background_app
                                                    .agent_helper
                                                    .finish_job(&job_id, &owner);
                                                return;
                                            }
                                        }
                                        break None;
                                    }
                                    let response = json_response(200, candidate.payload);
                                    let response = if let Some(request) = request.as_ref() {
                                        server_watchdog_final_response(
                                            request,
                                            response,
                                            remaining_watchdog_ms,
                                        )
                                    } else {
                                        response
                                    };
                                    break Some(response);
                                }
                                Some(AgentJobExecution::Leased { .. }) => {
                                    // A renewed Agent lease is the authoritative
                                    // ownership fence. The per-attempt compute
                                    // deadline may expire while the device is
                                    // still returning or refining a candidate;
                                    // do not start VPS beside that healthy lease.
                                    // Once heartbeats stop, job_execution prunes
                                    // the lease and one of the takeover arms below
                                    // transfers this same canonical job to VPS.
                                    lease_started = true;
                                    let _ = background_app
                                        .solver_pool
                                        .mark_agent_execution_running(fence, &job_id, &owner);
                                }
                                Some(AgentJobExecution::Completed { candidate: None }) => {
                                    if let Some(response) = required_agent_failure_response(
                                        &background_app,
                                        &job_id,
                                        &owner,
                                        request.as_ref(),
                                        "native_agent_disconnected",
                                        "browser_agent_failed",
                                    ) {
                                        break Some(response);
                                    }
                                    // Every Agent task returned a terminal
                                    // structured outcome without a publishable
                                    // candidate. This job may use VPS fallback,
                                    // but a still-online worker must not reclaim
                                    // the same failed generation at its start gate.
                                    let _ = background_app
                                        .solver_pool
                                        .set_server_job_agent_preference(&job_id, &owner, false);
                                    break None;
                                }
                                Some(AgentJobExecution::Checkpoint { candidate })
                                    if browser_mobile_local_quality_terminal(
                                        &candidate.payload,
                                    ) && background_app
                                        .solver_pool
                                        .server_job_agent_preference_enabled(&job_id, &owner) =>
                                {
                                    // The phone exhausted its bounded local quality
                                    // window and durably marked this complete,
                                    // hard-valid timetable as terminal. This branch
                                    // covers a lost final /candidate or /complete
                                    // exchange without silently starting a second
                                    // VPS solve after the device lease expires.
                                    break background_app
                                        .agent_helper
                                        .take_candidate_and_finish_job(&job_id, &owner)
                                        .map(|candidate| json_response(200, candidate.payload));
                                }
                                Some(AgentJobExecution::Checkpoint { candidate })
                                    if complete_existing_incumbent_is_safe(&candidate.payload)
                                        && request.as_ref().is_none_or(|request| {
                                            fresh_automatic_quality_gate_met(
                                                request,
                                                &candidate.payload,
                                            )
                                        })
                                        && background_app
                                            .solver_pool
                                            .server_job_agent_preference_enabled(
                                                &job_id, &owner,
                                            ) =>
                                {
                                    // A clean checkpoint is safe to publish when a
                                    // browser disappears before /complete. Fresh
                                    // Automatic rough checkpoints are deliberately
                                    // excluded above; they continue on VPS instead
                                    // of becoming a misleading first timetable.
                                    break background_app
                                        .agent_helper
                                        .take_candidate_and_finish_job(&job_id, &owner)
                                        .map(|candidate| json_response(200, candidate.payload));
                                }
                                Some(AgentJobExecution::Checkpoint { candidate })
                                    if complete_existing_incumbent_is_safe(&candidate.payload)
                                        && request.as_ref().is_some_and(|request| {
                                            fresh_automatic_quality_gate_required(request)
                                                && !fresh_automatic_quality_gate_met(
                                                    request,
                                                    &candidate.payload,
                                                )
                                        }) =>
                                {
                                    if browser_agent_required_for_job(
                                        &background_app,
                                        &job_id,
                                        &owner,
                                        request.as_ref(),
                                    ) {
                                        break Some(browser_agent_required_response(
                                            &job_id,
                                            "browser_agent_quality_unmet",
                                        ));
                                    }
                                    // Keep the validated checkpoint as a warm
                                    // start, but reserve a fresh VPS window for
                                    // the strict first-result quality gate.
                                    let _ = background_app
                                        .solver_pool
                                        .request_no_checkpoint_vps_rescue(&job_id, &owner);
                                    break None;
                                }
                                Some(AgentJobExecution::Checkpoint { .. }) => {
                                    if browser_agent_required_for_job(
                                        &background_app,
                                        &job_id,
                                        &owner,
                                        request.as_ref(),
                                    ) {
                                        break Some(browser_agent_required_response(
                                            &job_id,
                                            "browser_agent_failed",
                                        ));
                                    }
                                    break None;
                                }
                                Some(AgentJobExecution::Queued)
                                    if lease_started
                                        || background_app.agent_helper.job_has_claimed_task(
                                            &job_id,
                                            &owner,
                                            now_millis(),
                                        ) =>
                                {
                                    break None;
                                }
                                Some(AgentJobExecution::Queued)
                                    if waiting_since.elapsed()
                                        >= Duration::from_millis(AGENT_CLAIM_GRACE_MS)
                                        && background_app
                                            .agent_helper
                                            .online_worker_count_for_job(
                                                &owner,
                                                &job_id,
                                                now_millis(),
                                            )
                                            == 0 =>
                                {
                                    break None;
                                }
                                _ if watchdog_expired => {
                                    let disconnected_kind = if lease_started {
                                        "native_agent_disconnected"
                                    } else {
                                        "native_agent_start_failed"
                                    };
                                    let browser_kind = if lease_started {
                                        "browser_agent_disconnected"
                                    } else {
                                        "browser_agent_start_failed"
                                    };
                                    if let Some(response) = required_agent_failure_response(
                                        &background_app,
                                        &job_id,
                                        &owner,
                                        request.as_ref(),
                                        disconnected_kind,
                                        browser_kind,
                                    ) {
                                        break Some(response);
                                    }
                                    // No Agent lease owns the job at this
                                    // boundary. Close the task while holding its
                                    // coordinator lock so a candidate accepted
                                    // during the snapshot race wins, but no late
                                    // writer can overlap the terminal response.
                                    let response = background_app
                                        .agent_helper
                                        .take_candidate_and_finish_job(&job_id, &owner)
                                        .map(|candidate| json_response(200, candidate.payload))
                                        .unwrap_or_else(|| {
                                            server_watchdog_timeout_response(
                                                request
                                                    .as_ref()
                                                    .expect("watchdog request is present"),
                                            )
                                        });
                                    break Some(server_watchdog_final_response(
                                        request.as_ref().expect("watchdog request is present"),
                                        response,
                                        remaining_watchdog_ms,
                                    ));
                                }
                                Some(AgentJobExecution::Queued) => {}
                                None => break None,
                            }
                            thread::sleep(Duration::from_millis(100));
                        };

                        if let Some(response) = agent_response {
                            if background_app
                                .solver_pool
                                .complete_server_job_fenced(fence, &job_id, &owner, response)
                            {
                                background_app.agent_helper.finish_job(&job_id, &owner);
                                return;
                            }
                        }
                        // Remove the Agent task atomically only after confirming
                        // that no fresh lease won the expiry race. If a worker
                        // reclaimed it in the meantime, keep waiting on that
                        // same task instead of starting a VPS child beside it.
                        let checkpoint = match background_app
                            .agent_helper
                            .take_over_for_vps_with_checkpoint(&job_id, &owner, now_millis())
                        {
                            AgentVpsTakeover::Retry => {
                                mode = ServerCoordinatorStart::Agent { fence };
                                continue;
                            }
                            AgentVpsTakeover::Taken(checkpoint) => checkpoint,
                        };
                        let no_checkpoint = checkpoint.is_none();
                        if let Some(checkpoint) = checkpoint {
                            if let Some(checkpoint_request) = server_request_with_agent_checkpoint(
                                request.as_ref(),
                                &checkpoint.payload,
                            ) {
                                if let Ok(checkpoint_body) = serde_json::to_vec(&checkpoint_request)
                                {
                                    body = Arc::new(checkpoint_body);
                                    request = Some(checkpoint_request);
                                }
                            }
                        }
                        if no_checkpoint
                            && fresh_automatic_no_checkpoint_rescue_eligible(request.as_ref())
                        {
                            // A suspended mobile tab can expire without sending
                            // /fail. Arm the same one-time VPS rescue used by an
                            // explicit Browser failure, so the fallback does
                            // not inherit only the last few seconds of the
                            // Agent watchdog.
                            let _ = background_app
                                .solver_pool
                                .request_no_checkpoint_vps_rescue(&job_id, &owner);
                        }
                        let Some(vps_fence) = background_app
                            .solver_pool
                            .fallback_agent_to_vps(fence, &job_id, &owner)
                        else {
                            if let Some(response) = required_agent_failure_response(
                                &background_app,
                                &job_id,
                                &owner,
                                request.as_ref(),
                                "native_agent_disconnected",
                                "browser_agent_disconnected",
                            ) {
                                if background_app
                                    .solver_pool
                                    .complete_server_job_fenced(fence, &job_id, &owner, response)
                                {
                                    background_app.agent_helper.finish_job(&job_id, &owner);
                                }
                                return;
                            }
                            if background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner)
                            {
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                            }
                            return;
                        };
                        mode = ServerCoordinatorStart::Vps {
                            fence: vps_fence,
                            initial_guard: None,
                        };
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|error| {
            app.solver_pool
                .cancel_job_for_owner(&cleanup_job_id, &cleanup_owner);
            app.solver_pool
                .abandon_server_job(&cleanup_job_id, &cleanup_owner);
            app.agent_helper.finish_job(&cleanup_job_id, &cleanup_owner);
            format!("failed to start server solver worker: {error}")
        })
}

fn handoff_online_agent_before_vps_start(app: &App, job_id: &str, owner: &SolverOwner) -> bool {
    app.agent_helper
        .online_worker_count_for_job(owner, job_id, now_millis())
        > 0
        && app.solver_pool.request_agent_handoff_for_job(job_id, owner)
}

fn native_agent_required_for_request(request: Option<&Value>) -> bool {
    let Some(request) = request else {
        return false;
    };
    let settings = request_settings(request);
    setting_bool(settings, "ui_native_agent_required", false)
        || setting_string(settings, "ui_agent_execution_policy")
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("native_required"))
}

fn native_agent_required_for_job(
    app: &App,
    job_id: &str,
    owner: &SolverOwner,
    request: Option<&Value>,
) -> bool {
    app.solver_pool
        .server_job_native_agent_required(job_id, owner)
        || native_agent_required_for_request(request)
}

fn native_agent_required_response(job_id: &str, kind: &str) -> Vec<u8> {
    json_response(
        428,
        json!({
            "ok": false,
            "kind": kind,
            "error": kind,
            "jobId": job_id,
            "nativeAgentRequired": true,
            "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip",
            "retryable": true
        }),
    )
}

fn browser_agent_required_for_request(request: Option<&Value>) -> bool {
    let Some(request) = request else {
        return false;
    };
    let settings = request_settings(request);
    let policy = setting_string(settings, "ui_agent_execution_policy")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    // An explicit OFF/VPS click is authoritative even if an older client
    // accidentally leaves a stale Browser-required boolean in the payload.
    if matches!(policy.as_str(), "vps_only" | "native_paused_vps") {
        return false;
    }
    setting_bool(settings, "ui_browser_agent_required", false)
        || matches!(policy.as_str(), "web_agent_required" | "browser_required")
}

fn native_agent_id_for_request(request: Option<&Value>) -> Option<String> {
    request
        .and_then(request_settings)
        .and_then(|settings| settings.get("ui_native_agent_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn native_paused_vps_for_request(request: Option<&Value>) -> bool {
    request
        .and_then(request_settings)
        .and_then(|settings| setting_string(Some(settings), "ui_agent_execution_policy"))
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("native_paused_vps"))
}

fn browser_agent_required_for_job(
    app: &App,
    job_id: &str,
    owner: &SolverOwner,
    request: Option<&Value>,
) -> bool {
    app.solver_pool
        .server_job_browser_agent_required(job_id, owner)
        || browser_agent_required_for_request(request)
}

fn browser_agent_required_response(job_id: &str, kind: &str) -> Vec<u8> {
    json_response(
        428,
        json!({
            "ok": false,
            "kind": kind,
            "error": kind,
            "jobId": job_id,
            "browserAgentRequired": true,
            "localModeRequired": true,
            "vpsFallback": false,
            "retryable": true
        }),
    )
}

fn required_agent_failure_response(
    app: &App,
    job_id: &str,
    owner: &SolverOwner,
    request: Option<&Value>,
    native_kind: &str,
    browser_kind: &str,
) -> Option<Vec<u8>> {
    if native_agent_required_for_job(app, job_id, owner, request) {
        Some(native_agent_required_response(job_id, native_kind))
    } else if browser_agent_required_for_job(app, job_id, owner, request) {
        Some(browser_agent_required_response(job_id, browser_kind))
    } else {
        None
    }
}

#[cfg(test)]
fn solve_json(app: &App, body: &[u8], owner: &SolverOwner) -> Vec<u8> {
    // Existing unit tests exercise explicit Agent contracts directly. The
    // production route derives this permission from the authenticated role.
    solve_json_with_agent_permission(
        app,
        body,
        owner,
        true,
        SolverPlanPolicy::Exempt,
    )
}

fn solve_json_with_agent_permission(
    app: &App,
    body: &[u8],
    owner: &SolverOwner,
    agent_allowed: bool,
    plan_policy: SolverPlanPolicy,
) -> Vec<u8> {
    if matches!(&plan_policy, SolverPlanPolicy::Unknown) {
        return json_response(
            503,
            json!({
                "ok": false,
                "kind": "solver_plan_unavailable",
                "error": "solver_plan_unavailable",
                "retryable": false,
                "message": "Chưa xác định được gói dịch vụ của trường. Vui lòng đăng nhập lại hoặc liên hệ quản trị viên."
            }),
        );
    }
    let mut request = serde_json::from_slice::<Value>(body).ok();
    // Canonicalize the explicit Hybrid executor/budget before any admission,
    // watchdog or Cloud Run body is derived from the request.
    let hybrid_cloud_run_budget_seconds = request
        .as_mut()
        .and_then(clamp_hybrid_cloud_run_request);
    let hybrid_cloud_run_request = hybrid_cloud_run_budget_seconds.is_some()
        && hybrid_cloud_run_requested(request.as_ref());
    if matches!(&plan_policy, SolverPlanPolicy::Max1) {
        if let Some(class_count) = request.as_ref().and_then(class_count_from_solve_request) {
            if class_count > MAX1_CLASS_LIMIT {
                return max1_class_limit_response(class_count);
            }
        }
    }
    let job_id = job_id_from_solve_body(body, now_millis());
    let shared_body = Arc::new(
        request
            .as_ref()
            .and_then(|value| serde_json::to_vec(value).ok())
            .unwrap_or_else(|| body.to_vec()),
    );
    let schedule_scope = solver_schedule_scope(request.as_ref());
    let schedule_fingerprint = solver_schedule_fingerprint(request.as_ref());
    let progress_budget_seconds = solver_progress_budget_seconds(request.as_ref());
    let progress_run_index = solver_progress_run_index(request.as_ref());
    let initial_work_progress = solver_initial_work_progress(request.as_ref());
    let server_watchdog_budget_ms = request.as_ref().map(server_owned_watchdog_budget_ms);
    let desired_workers = app.solver_pool.desired_workers(request.as_ref());
    let supports_fifo_admission = request
        .as_ref()
        .map(|request| setting_bool(request_settings(request), "ui_solver_fifo_admission", false))
        .unwrap_or(false);
    let client_requested_vps = request.as_ref().is_some_and(|request| {
        setting_string(request_settings(request), "ui_agent_execution_policy")
            .is_some_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "vps_only" | "native_paused_vps"
                )
            })
    });
    let school_id = owner.school_id();
    let metered_plan = matches!(
        &plan_policy,
        SolverPlanPolicy::Free | SolverPlanPolicy::Trial | SolverPlanPolicy::Plus { .. }
    );
    let mut plan_claim: Option<SolvePlanClaimGuard<'_>> = None;
    let configured_serverless_only = app.serverless.serverless_only_for_school(school_id);
    if hybrid_cloud_run_request
        && request.is_some()
        && app
            .serverless
            .selected_profile_for_school(school_id)
            .is_none()
    {
        return json_response(
            503,
            json!({
                "ok": false,
                "kind": "serverless_profile_unavailable",
                "error": "serverless_profile_unavailable",
                "jobId": job_id,
                "executor": "cloud_run",
                "fallback": false,
                "budgetSeconds": hybrid_cloud_run_budget_seconds
            }),
        );
    }
    if hybrid_cloud_run_request
        && request.is_some()
        && !app.serverless.enabled_for_new_job_for_school(school_id)
    {
        // A Hybrid click must never silently cross into the VPS lane merely
        // because the school is configured VPS-only.
        return json_response(
            503,
            json!({
                "ok": false,
                "kind": "cloud_run_route_unavailable",
                "error": "cloud_run_route_unavailable",
                "jobId": job_id,
                "executor": "cloud_run",
                "fallback": false,
                "budgetSeconds": hybrid_cloud_run_budget_seconds
            }),
        );
    }
    // A normal browser may not override the server-owned infrastructure policy
    // by sending a stale `vps_only` hint. Only a privileged Agent-capable admin
    // may request VPS, and even that hint is ignored when the selected policy
    // is explicitly ServerlessOnly.
    let request_forces_vps = agent_allowed
        && !configured_serverless_only
        && !hybrid_cloud_run_request
        && client_requested_vps;
    // Once a Cloud Run profile is configured, ordinary clients are promoted to
    // the same durable async contract even if their older cached JS omitted the
    // two async settings. Explicit admin VPS mode remains authoritative.
    if configured_serverless_only
        && request.is_some()
        && app.serverless.selected_profile_for_school(school_id).is_none()
    {
        return json_response(
            503,
            json!({
                "ok": false,
                "kind": "serverless_profile_unavailable",
                "error": "serverless_profile_unavailable",
                "fallback": false
            }),
        );
    }
    let serverless_candidate = app.serverless.enabled_for_new_job_for_school(school_id)
        && !request_forces_vps
        && request.is_some();
    let server_owned = supports_fifo_admission
        && request
            .as_ref()
            .map(|request| setting_bool(request_settings(request), "ui_solver_async_job", false))
            .unwrap_or(false)
        || serverless_candidate;
    let browser_wasm_eligible = agent_helper::browser_refinement_request_eligible(body);
    let browser_cp_sat_eligible = agent_helper::browser_cp_sat_request_eligible(body);
    let mut native_agent_required =
        agent_allowed && native_agent_required_for_request(request.as_ref());
    let mut browser_agent_required =
        agent_allowed && browser_agent_required_for_request(request.as_ref());
    let mut native_paused_vps = agent_allowed && native_paused_vps_for_request(request.as_ref());
    if configured_serverless_only || serverless_candidate {
        // Infrastructure policy is server-owned. A cached admin request may
        // still contain native/browser Agent flags from an older UI, but those
        // flags must not preempt an eligible Cloud Run attempt. Auto retains
        // its existing direct VPS fallback when reservation fails, while
        // ServerlessOnly continues to fail closed.
        native_agent_required = false;
        browser_agent_required = false;
        native_paused_vps = false;
    }
    let native_agent_id = native_agent_id_for_request(request.as_ref());
    let explicit_vps_only = request_forces_vps;
    let local_agent_preference_enabled = agent_allowed
        && !explicit_vps_only
        && (native_agent_required
            || browser_agent_required
            || request
                .as_ref()
                .map(|request| {
                    setting_bool(
                        request_settings(request),
                        "ui_agent_preference_enabled",
                        true,
                    )
                })
                .unwrap_or(true));
    let browser_wasm_ready = local_agent_preference_enabled
        && browser_wasm_eligible
        && request
            .as_ref()
            .map(|request| setting_bool(request_settings(request), "ui_browser_wasm_ready", false))
            .unwrap_or(false);
    let browser_cp_sat_ready = local_agent_preference_enabled
        && browser_cp_sat_eligible
        && request
            .as_ref()
            .map(|request| setting_bool(request_settings(request), "ui_browser_cpsat_ready", false))
            .unwrap_or(false);
    let browser_agent_ready =
        !native_agent_required && (browser_wasm_ready || browser_cp_sat_ready);
    if native_agent_required && browser_agent_required {
        return json_response(
            400,
            json!({
                "ok": false,
                "kind": "solver_executor_policy_invalid",
                "error": "solver_executor_policy_invalid",
                "jobId": job_id
            }),
        );
    }
    if native_agent_required && !server_owned {
        return native_agent_required_response(&job_id, "native_agent_requires_async_job");
    }
    if browser_agent_required && !server_owned {
        return browser_agent_required_response(&job_id, "browser_agent_requires_async_job");
    }
    if browser_agent_required && !browser_agent_ready {
        return browser_agent_required_response(&job_id, "browser_agent_required");
    }
    if native_paused_vps {
        let Some(agent_id) = native_agent_id.as_deref() else {
            return native_agent_required_response(&job_id, "native_agent_identity_required");
        };
        if app
            .agent_helper
            .native_worker_state_for_id(owner, agent_id, now_millis())
            != AgentNativeState::Stopped
        {
            return native_agent_required_response(&job_id, "native_agent_must_be_running_and_off");
        }
    }
    if server_owned
        && native_agent_required
        && !app.solver_pool.server_job_known_for_owner(&job_id, owner)
        && app
            .agent_helper
            .native_worker_status_for_id(
                owner,
                native_agent_id.as_deref(),
                now_millis(),
            )
            .0
            == 0
    {
        return native_agent_required_response(&job_id, "native_agent_required");
    }
    let mut server_execution_fence = None;
    let mut serverless_fallback_forces_vps = false;
    if server_owned {
        if let Some(response) = app
            .solver_pool
            .completed_server_response_for_owner(&job_id, owner)
        {
            return response;
        }
        match app
            .solver_pool
            .claim_server_job_with_scope_progress_and_watchdog(
                &job_id,
                owner,
                schedule_scope.as_deref(),
                schedule_fingerprint.as_deref(),
                progress_budget_seconds,
                progress_run_index,
                server_watchdog_budget_ms,
            ) {
            ServerJobClaim::Claimed => {
                if let Some(progress) = initial_work_progress {
                    let _ = app
                        .solver_pool
                        .update_server_job_progress(&job_id, progress);
                }
                app.solver_pool.set_server_job_browser_wasm_eligible(
                    &job_id,
                    owner,
                    browser_wasm_eligible && !native_agent_required,
                );
                app.solver_pool.set_server_job_browser_cp_sat_eligible(
                    &job_id,
                    owner,
                    browser_cp_sat_eligible && !native_agent_required,
                );
                app.solver_pool.set_server_job_agent_preference(
                    &job_id,
                    owner,
                    local_agent_preference_enabled,
                );
                if !app.solver_pool.set_server_job_native_agent_required(
                    &job_id,
                    owner,
                    native_agent_required,
                ) {
                    cleanup_server_owned_job(app, &job_id, owner);
                    return json_response(
                        500,
                        json!({
                            "ok": false,
                            "kind": "solver_executor_policy_invalid",
                            "error": "solver_executor_policy_invalid",
                            "jobId": job_id
                        }),
                    );
                }
                if !app.solver_pool.set_server_job_browser_agent_required(
                    &job_id,
                    owner,
                    browser_agent_required,
                ) {
                    cleanup_server_owned_job(app, &job_id, owner);
                    return json_response(
                        500,
                        json!({
                            "ok": false,
                            "kind": "solver_executor_policy_invalid",
                            "error": "solver_executor_policy_invalid",
                            "jobId": job_id
                        }),
                    );
                }
                if metered_plan {
                    if let Err(response) = claim_plan_solve(app, owner, &job_id, &plan_policy) {
                        cleanup_server_owned_job(app, &job_id, owner);
                        return response;
                    }
                    plan_claim = Some(SolvePlanClaimGuard::new(
                        app,
                        owner,
                        &job_id,
                        &plan_policy,
                    ));
                }
            }
            ServerJobClaim::Existing => {
                return solve_result_for_job_id_json(app, &job_id, owner);
            }
            ServerJobClaim::ExistingSchedule(existing_job_id) => {
                return solve_result_for_job_id_json(app, &existing_job_id, owner);
            }
            ServerJobClaim::ExistingScope(existing_job_id) => {
                let existing = app
                    .solver_pool
                    .server_job_snapshots_for_owner(owner)
                    .into_iter()
                    .find(|job| job.job_id == existing_job_id);
                return json_response(
                    409,
                    json!({
                        "ok": false,
                        "kind": "solver_schedule_busy",
                        "error": "solver_schedule_busy",
                        "jobId": job_id,
                        "existingJobId": existing_job_id,
                        "existingScheduleScope": existing.as_ref().and_then(|job| job.schedule_scope.as_deref()),
                        "existingScheduleFingerprint": existing.as_ref().and_then(|job| job.schedule_fingerprint.as_deref()),
                        "retryAfterMs": 700
                    }),
                );
            }
            ServerJobClaim::OwnerMismatch => {
                return json_response(
                    409,
                    json!({
                        "ok": false,
                        "kind": "solver_job_id_conflict",
                        "error": "solver_job_id_conflict",
                        "jobId": job_id
                    }),
                );
            }
            ServerJobClaim::GlobalCapacity => {
                return json_response(
                    429,
                    json!({
                        "ok": false,
                        "kind": "solver_server_job_capacity",
                        "error": "solver_server_job_capacity",
                        "jobId": job_id,
                        "maxUnresolvedServerJobs": MAX_UNRESOLVED_SERVER_JOBS,
                        "retryAfterMs": 700
                    }),
                );
            }
            ServerJobClaim::OwnerCapacity => {
                return json_response(
                    429,
                    json!({
                        "ok": false,
                        "kind": "solver_owner_job_capacity",
                        "error": "solver_owner_job_capacity",
                        "jobId": job_id,
                        "maxUnresolvedServerJobsPerOwner": MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER,
                        "retryAfterMs": 700
                    }),
                );
            }
        }

        if serverless_candidate && !native_agent_required && !browser_agent_required {
            match app
                .serverless
                .reserve_for_owner(&job_id, school_id, owner.login_id())
            {
                Ok(reservation) => {
                    let profile = reservation.profile;
                    let fallback_to_vps = !hybrid_cloud_run_request
                        && app.serverless.fallback_to_vps_for_school(school_id);
                    let Some(fence) = app
                        .solver_pool
                        .prepare_serverless_execution(&job_id, owner)
                    else {
                        app.serverless.release(&job_id);
                        cleanup_server_owned_job(app, &job_id, owner);
                        return json_response(
                            500,
                            json!({
                                "ok": false,
                                "kind": "solver_executor_state_invalid",
                                "error": "solver_executor_state_invalid",
                                "jobId": job_id
                            }),
                        );
                    };
                    if let Err(error) = spawn_server_owned_solver(
                        app,
                        job_id.clone(),
                        owner.clone(),
                        desired_workers,
                        Arc::clone(&shared_body),
                        request,
                        ServerCoordinatorStart::Serverless {
                            fence,
                            profile: profile.clone(),
                            fallback_to_vps,
                        },
                    ) {
                        app.serverless.release(&job_id);
                        return json_response(
                            500,
                            json!({
                                "ok": false,
                                "kind": "solver_worker_start_failed",
                                "error": error,
                                "jobId": job_id
                            }),
                        );
                    }
                    accept_solve_plan_claim(&mut plan_claim);
                    return json_response(
                        202,
                        json!({
                            "ok": false,
                            "running": true,
                            "serverOwned": true,
                            "kind": "solver_started",
                            "error": "solver_started",
                            "jobId": job_id,
                            "startedAtMs": server_job_started_at_for_owner(app, &job_id, owner),
                            "executor": ServerExecutor::Serverless.as_str(),
                            "executionPhase": ServerExecutionPhase::ServerlessQueued.as_str(),
                            "cloudProfileId": profile.id,
                            "progressBudgetSeconds": progress_budget_seconds,
                            "progressRunIndex": progress_run_index,
                            "requiredWorkers": desired_workers,
                            "vpsWorkerTokensAllocated": 0,
                            "retryAfterMs": 700
                        }),
                    );
                }
                Err(kind) => {
                    if app.serverless.serverless_only_for_school(school_id)
                        || hybrid_cloud_run_request
                    {
                        cleanup_server_owned_job(app, &job_id, owner);
                        return json_response(
                            503,
                            json!({
                                "ok": false,
                                "kind": kind.clone(),
                                "error": kind,
                                "jobId": job_id,
                                "fallback": false,
                                "usage": app.serverless.usage_json_for_school(school_id)
                            }),
                        );
                    }
                    // Auto mode falls back directly to the existing VPS lane.
                    // Do not let an Agent hint from a cached browser preempt it.
                    serverless_fallback_forces_vps = true;
                    let _ = app
                        .solver_pool
                        .set_server_job_agent_preference(&job_id, owner, false);
                }
            }
        }

        // A browser that already compiled the WASM runtime may publish this
        // bounded readiness hint with its complete, revalidated refinement
        // request. The server independently verifies eligibility above and
        // starts in AgentWaiting so it does not allocate VPS CPU just to stop
        // it again after the browser receives the durable job ID. A spoofed or
        // vanished browser can only consume the existing claim grace before
        // the fenced coordinator falls back to VPS.
        if browser_agent_ready && !serverless_fallback_forces_vps {
            let Some(fence) = app.solver_pool.prepare_agent_execution(&job_id, owner) else {
                cleanup_server_owned_job(app, &job_id, owner);
                return json_response(
                    500,
                    json!({
                        "ok": false,
                        "kind": "solver_executor_state_invalid",
                        "error": "solver_executor_state_invalid",
                        "jobId": job_id
                    }),
                );
            };
            if let Err(error) = spawn_server_owned_solver(
                app,
                job_id.clone(),
                owner.clone(),
                desired_workers,
                Arc::clone(&shared_body),
                request,
                ServerCoordinatorStart::Agent { fence },
            ) {
                return json_response(
                    500,
                    json!({
                        "ok": false,
                        "kind": "solver_worker_start_failed",
                        "error": error,
                        "jobId": job_id
                    }),
                );
            }
            accept_solve_plan_claim(&mut plan_claim);
            return json_response(
                202,
                json!({
                    "ok": false,
                    "running": true,
                    "serverOwned": true,
                    "kind": "solver_started",
                    "error": "solver_started",
                    "jobId": job_id,
                    "startedAtMs": server_job_started_at_for_owner(app, &job_id, owner),
                    "executor": ServerExecutor::Agent.as_str(),
                    "executionPhase": ServerExecutionPhase::AgentWaiting.as_str(),
                    "progressBudgetSeconds": progress_budget_seconds,
                    "progressRunIndex": progress_run_index,
                    "requiredWorkers": 0,
                    "retryAfterMs": 700
                }),
            );
        }

        // A paired owner Agent may take its own job immediately. Operator
        // trusted workers remain auxiliary queue capacity and never race a
        // fresh direct start for the same job.
        if local_agent_preference_enabled
            && !serverless_fallback_forces_vps
            && app
                .agent_helper
                .online_worker_count_for_job(owner, &job_id, now_millis())
                > 0
        {
            // Any eligible local Agent is authoritative. VPS is fallback only
            // after the Agent is absent, disabled, disconnected, or timed out.
            let Some(fence) = app.solver_pool.prepare_agent_execution(&job_id, owner) else {
                cleanup_server_owned_job(app, &job_id, owner);
                return json_response(
                    500,
                    json!({
                        "ok": false,
                        "kind": "solver_executor_state_invalid",
                        "error": "solver_executor_state_invalid",
                        "jobId": job_id
                    }),
                );
            };
            if let Err(error) = spawn_server_owned_solver(
                app,
                job_id.clone(),
                owner.clone(),
                desired_workers,
                Arc::clone(&shared_body),
                request,
                ServerCoordinatorStart::Agent { fence },
            ) {
                return json_response(
                    500,
                    json!({
                        "ok": false,
                        "kind": "solver_worker_start_failed",
                        "error": error,
                        "jobId": job_id
                    }),
                );
            }
            accept_solve_plan_claim(&mut plan_claim);
            return json_response(
                202,
                json!({
                    "ok": false,
                    "running": true,
                    "serverOwned": true,
                    "kind": "solver_started",
                    "error": "solver_started",
                    "jobId": job_id,
                    "startedAtMs": server_job_started_at_for_owner(app, &job_id, owner),
                    "executor": ServerExecutor::Agent.as_str(),
                    "executionPhase": ServerExecutionPhase::AgentWaiting.as_str(),
                    "progressBudgetSeconds": progress_budget_seconds,
                    "progressRunIndex": progress_run_index,
                    "requiredWorkers": 0,
                    "retryAfterMs": 700
                }),
            );
        }

        server_execution_fence = app.solver_pool.prepare_vps_execution(&job_id, owner);
        if server_execution_fence.is_none() {
            // A hello can win the race between the online check and VPS
            // reservation. Honor that fenced handoff instead of abandoning the
            // canonical job.
            if let Some(fence) = app.solver_pool.prepare_agent_execution(&job_id, owner) {
                if let Err(error) = spawn_server_owned_solver(
                    app,
                    job_id.clone(),
                    owner.clone(),
                    desired_workers,
                    Arc::clone(&shared_body),
                    request,
                    ServerCoordinatorStart::Agent { fence },
                ) {
                    return json_response(
                        500,
                        json!({
                            "ok": false,
                            "kind": "solver_worker_start_failed",
                            "error": error,
                            "jobId": job_id
                        }),
                    );
                }
                accept_solve_plan_claim(&mut plan_claim);
                return json_response(
                    202,
                    json!({
                        "ok": false,
                        "running": true,
                        "serverOwned": true,
                        "kind": "solver_started",
                        "error": "solver_started",
                        "jobId": job_id,
                        "startedAtMs": server_job_started_at_for_owner(app, &job_id, owner),
                        "executor": ServerExecutor::Agent.as_str(),
                        "executionPhase": ServerExecutionPhase::AgentWaiting.as_str(),
                        "progressBudgetSeconds": progress_budget_seconds,
                        "progressRunIndex": progress_run_index,
                        "requiredWorkers": 0,
                        "retryAfterMs": 700
                    }),
                );
            }
            cleanup_server_owned_job(app, &job_id, owner);
            return json_response(
                500,
                json!({
                    "ok": false,
                    "kind": "solver_executor_state_invalid",
                    "error": "solver_executor_state_invalid",
                    "jobId": job_id
                }),
            );
        }
    }
    if !server_owned && metered_plan {
        if let Err(response) = claim_plan_solve(app, owner, &job_id, &plan_policy) {
            return response;
        }
        plan_claim = Some(SolvePlanClaimGuard::new(
            app,
            owner,
            &job_id,
            &plan_policy,
        ));
    }
    let admission = if supports_fifo_admission {
        app.solver_pool
            .acquire_or_enqueue_for_owner(job_id.clone(), desired_workers, owner.clone())
    } else {
        match app
            .solver_pool
            .try_acquire_for_owner(job_id.clone(), desired_workers, owner.clone())
        {
            Ok(guard) => SolverAdmission::Acquired(guard),
            Err(_) => {
                return json_response(
                    409,
                    json!({
                        "ok": false,
                        "kind": "solver_busy",
                        "error": "solver_busy",
                        "jobId": job_id,
                        "activeJobs": app.solver_pool.active_count(),
                        "queuedJobs": app.solver_pool.queued_count(),
                        "maxConcurrent": app.solver_pool.max_concurrent(),
                        "minWorkersPerJob": app.solver_pool.min_workers_per_job(),
                        "maxWorkersPerJob": app.solver_pool.max_workers_per_job(),
                        "workerTokensTotal": app.solver_pool.total_worker_tokens(),
                        "workerTokensAllocated": app.solver_pool.allocated_worker_tokens(),
                        "workerTokensAvailable": app.solver_pool.available_worker_tokens(),
                        "slotsAvailable": app.solver_pool.slots_available()
                    }),
                );
            }
        }
    };
    let job_guard = match admission {
        SolverAdmission::Acquired(guard) => {
            if server_owned {
                if let Err(error) = spawn_server_owned_solver(
                    app,
                    job_id.clone(),
                    owner.clone(),
                    desired_workers,
                    Arc::clone(&shared_body),
                    request,
                    ServerCoordinatorStart::Vps {
                        fence: server_execution_fence.expect("server-owned VPS fence exists"),
                        initial_guard: Some(guard),
                    },
                ) {
                    return json_response(
                        500,
                        json!({
                            "ok": false,
                            "kind": "solver_worker_start_failed",
                            "error": error,
                            "jobId": job_id
                        }),
                    );
                }
                accept_solve_plan_claim(&mut plan_claim);
                return json_response(
                    202,
                    json!({
                        "ok": false,
                        "running": true,
                        "serverOwned": true,
                        "kind": "solver_started",
                        "error": "solver_started",
                        "jobId": job_id,
                        "startedAtMs": server_job_started_at_for_owner(app, &job_id, owner),
                        "executor": ServerExecutor::Vps.as_str(),
                        "executionPhase": ServerExecutionPhase::VpsRunning.as_str(),
                        "progressBudgetSeconds": progress_budget_seconds,
                        "progressRunIndex": progress_run_index,
                        "requiredWorkers": desired_workers,
                        "retryAfterMs": 700
                    }),
                );
            }
            guard
        }
        SolverAdmission::Queued {
            position,
            queued_ms,
            retry_after_ms,
        } => {
            if server_owned {
                if let Err(error) = spawn_server_owned_solver(
                    app,
                    job_id.clone(),
                    owner.clone(),
                    desired_workers,
                    Arc::clone(&shared_body),
                    request,
                    ServerCoordinatorStart::Vps {
                        fence: server_execution_fence.expect("server-owned VPS fence exists"),
                        initial_guard: None,
                    },
                ) {
                    return json_response(
                        500,
                        json!({
                            "ok": false,
                            "kind": "solver_worker_start_failed",
                            "error": error,
                            "jobId": job_id
                        }),
                    );
                }
            }
            accept_solve_plan_claim(&mut plan_claim);
            return json_response(
                202,
                json!({
                    "ok": false,
                    "queued": true,
                    "serverOwned": server_owned,
                    "kind": "solver_queued",
                    "error": "solver_queued",
                    "jobId": job_id,
                    "startedAtMs": if server_owned {
                        server_job_started_at_for_owner(app, &job_id, owner)
                    } else {
                        None
                    },
                    "executor": if server_owned { Value::String(ServerExecutor::Vps.as_str().to_string()) } else { Value::Null },
                    "executionPhase": if server_owned { Value::String(ServerExecutionPhase::VpsQueued.as_str().to_string()) } else { Value::Null },
                    "progressBudgetSeconds": progress_budget_seconds,
                    "progressRunIndex": progress_run_index,
                    "queuePosition": position,
                    "queuedAtMs": queued_ms,
                    "retryAfterMs": retry_after_ms,
                    "requiredWorkers": desired_workers,
                    "activeJobs": app.solver_pool.active_count(),
                    "queuedJobs": app.solver_pool.queued_count(),
                    "maxConcurrent": app.solver_pool.max_concurrent(),
                    "minWorkersPerJob": app.solver_pool.min_workers_per_job(),
                    "maxWorkersPerJob": app.solver_pool.max_workers_per_job(),
                    "workerTokensTotal": app.solver_pool.total_worker_tokens(),
                    "workerTokensAllocated": app.solver_pool.allocated_worker_tokens(),
                    "workerTokensAvailable": app.solver_pool.available_worker_tokens(),
                    "slotsAvailable": app.solver_pool.slots_available()
                }),
            );
        }
        SolverAdmission::AlreadyRunning => {
            if server_owned {
                if let Some(fence) = app.solver_pool.prepare_agent_execution(&job_id, owner) {
                    if let Err(error) = spawn_server_owned_solver(
                        app,
                        job_id.clone(),
                        owner.clone(),
                        desired_workers,
                        Arc::clone(&shared_body),
                        request,
                        ServerCoordinatorStart::Agent { fence },
                    ) {
                        return json_response(
                            500,
                            json!({
                                "ok": false,
                                "kind": "solver_worker_start_failed",
                                "error": error,
                                "jobId": job_id
                            }),
                        );
                    }
                    accept_solve_plan_claim(&mut plan_claim);
                    return json_response(
                        202,
                        json!({
                            "ok": false,
                            "running": true,
                            "serverOwned": true,
                            "kind": "solver_started",
                            "error": "solver_started",
                            "jobId": job_id,
                            "startedAtMs": server_job_started_at_for_owner(app, &job_id, owner),
                            "executor": ServerExecutor::Agent.as_str(),
                            "executionPhase": ServerExecutionPhase::AgentWaiting.as_str(),
                            "progressBudgetSeconds": progress_budget_seconds,
                            "progressRunIndex": progress_run_index,
                            "retryAfterMs": 700
                        }),
                    );
                }
                cleanup_server_owned_job(app, &job_id, owner);
            }
            return json_response(
                409,
                json!({
                    "ok": false,
                    "kind": "solver_job_already_running",
                    "error": "solver_job_already_running",
                    "jobId": job_id
                }),
            );
        }
    };
    accept_solve_plan_claim(&mut plan_claim);
    app.serverless.record_execution_started(
        &job_id,
        owner.school_id(),
        owner.login_id(),
        "vps",
    );
    let mut vps_telemetry = start_server_solver_telemetry(app, "vps", request.as_ref(), None);
    let response = solve_admitted_json(app, body, request.as_ref(), &job_guard, None);
    let response_payload = response_json_payload(&response);
    let outcome = solver_execution_outcome_from_response(
        &response,
        job_guard.job.cancel_requested.load(Ordering::Relaxed),
    );
    app.serverless.record_execution_outcome(
        &job_id,
        owner.school_id(),
        owner.login_id(),
        "vps",
        outcome,
    );
    vps_telemetry.finish(
        telemetry_outcome_from_reservation(outcome),
        response_payload.as_ref(),
        Some("none"),
        None,
    );
    response
}

fn solve_admitted_json(
    app: &App,
    body: &[u8],
    request: Option<&Value>,
    job_guard: &SolverJobGuard,
    progress_execution_generation: Option<u64>,
) -> Vec<u8> {
    let cancel_requested = &job_guard.job.cancel_requested;
    let best_effort_stop_requested = &job_guard.job.best_effort_stop_requested;
    let allocated_workers = job_guard.job.allocated_workers;
    if let Some(request) = request {
        if let Some((status, payload)) = preserve_complete_hybrid_existing_payload(request) {
            return solve_payload_response(app, body, status, payload, "hybrid-preserve-existing");
        }
    }
    if request
        .map(|request| should_use_reference_solver(request))
        .unwrap_or(false)
    {
        if let Some(request) = request {
            match run_reference_solver(
                app,
                body,
                request,
                &job_guard.job.job_id,
                cancel_requested,
                best_effort_stop_requested,
                progress_execution_generation,
                allocated_workers,
                ReferenceSolverTransport::Local,
                None,
            ) {
                Ok((status, payload)) => {
                    if status != 200 {
                        if let Some((fallback_status, fallback_payload)) =
                            complete_existing_incumbent_payload(
                                request,
                                "reference_solver_non_200",
                                &payload,
                            )
                        {
                            return solve_payload_response(
                                app,
                                body,
                                fallback_status,
                                fallback_payload,
                                "reference-existing-incumbent-fallback",
                            );
                        }
                    }
                    return solve_payload_response(app, body, status, payload, "hybrid-reference");
                }
                Err(err) => {
                    if let Some((fallback_status, fallback_payload)) =
                        complete_existing_incumbent_payload(request, "reference_solver_error", &err)
                    {
                        return solve_payload_response(
                            app,
                            body,
                            fallback_status,
                            fallback_payload,
                            "reference-existing-incumbent-fallback",
                        );
                    }
                    if setting_bool(
                        request_settings(request),
                        "allow_native_reference_fallback",
                        false,
                    ) {
                        if !quiet_logs() {
                            eprintln!(
                                "reference solver unavailable, falling back to native Rust: {err}"
                            );
                        }
                    } else {
                        let error_status = reference_solver_error_status(&err);
                        let error_kind = reference_solver_error_kind(&err);
                        let budget = reference_solver_budget(request);
                        let payload = json!({
                            "ok": false,
                            "kind": error_kind,
                            "error": "Backend hybrid Python solver failed before returning a structured timetable.",
                            "detail": err,
                            "metrics": {
                                "scheduled_periods": 0,
                                "expected_periods": expected_periods_from_request(request),
                                "unassigned_periods": expected_periods_from_request(request),
                                "app_constraint_violation_count": 0,
                                "hard_ok": false,
                                "core_hard_ok": false,
                                "best_effort": false
                            },
                            "solver": {
                                "name": "hybrid_reference_cp_sat_milp_v1",
                                "backend": "hybrid-python-reference",
                                "runtime_settings": {
                                    "phase": if error_status == 503 { "reference_unavailable" } else { "reference_failed" },
                                    "returned_incumbent": false,
                                    "backend_deadline_ms": budget.backend_ms,
                                    "native_global_deadline_ms": budget.native_ms,
                                    "reference_watchdog_deadline_ms": budget.hard_ms,
                                    "reference_solver_budget_ms": budget.solver_ms
                                }
                            }
                        });
                        let payload = serde_json::to_string(&payload)
                            .unwrap_or_else(|_| format!(r#"{{"ok":false,"kind":"{error_kind}"}}"#));
                        return solve_payload_response(
                            app,
                            body,
                            error_status,
                            payload,
                            "hybrid-reference-error",
                        );
                    }
                }
            }
        }
    }
    match native_solver::solve_native_hint_json(&app.root, body, Some(cancel_requested)) {
        Ok(Some(result)) => {
            if result.status != 200 {
                if let Some(request) = request {
                    if let Some((status, payload)) = complete_existing_incumbent_payload(
                        request,
                        "native_existing_optimize_non_200",
                        &result.payload,
                    ) {
                        return solve_payload_response(
                            app,
                            body,
                            status,
                            payload,
                            "native-existing-incumbent-fallback",
                        );
                    }
                }
            }
            solve_payload_response(app, body, result.status, result.payload, "native-rust")
        }
        Ok(None) => {
            if let Some(request) = request {
                if let Some((status, payload)) = complete_existing_incumbent_payload(
                    request,
                    "native_existing_optimize_no_result",
                    "native solver returned no result",
                ) {
                    return solve_payload_response(
                        app,
                        body,
                        status,
                        payload,
                        "native-existing-incumbent-fallback",
                    );
                }
            }
            let payload = serde_json::to_string(&json!({
                "ok": false,
                "kind": "simple_solver_no_result",
                "error": "Simple solver did not return a schedule."
            }))
            .unwrap_or_else(|_| r#"{"ok":false,"kind":"simple_solver_no_result"}"#.to_string());
            solve_payload_response(app, body, 422, payload, "native-rust-no-result")
        }
        Err(err) => {
            if let Some(request) = request {
                if let Some((status, payload)) = complete_existing_incumbent_payload(
                    request,
                    "native_existing_optimize_error",
                    &err,
                ) {
                    return solve_payload_response(
                        app,
                        body,
                        status,
                        payload,
                        "native-existing-incumbent-fallback",
                    );
                }
            }
            let request_error = err.contains("missing data") || err.contains("JSON invalid");
            let status = if request_error { 400 } else { 500 };
            let payload = serde_json::to_string(&json!({
                    "ok": false,
                    "kind": if request_error { "invalid_solve_request" } else { "simple_solver_failed" },
                    "error": err
                }))
                .unwrap_or_else(|_| r#"{"ok":false,"kind":"simple_solver_failed"}"#.to_string());
            solve_payload_response(app, body, status, payload, "native-rust-error")
        }
    }
}

fn e2e_removed_json(_query: &str) -> Vec<u8> {
    json_response(
        410,
        json!({
            "ok": false,
            "kind": "e2e_removed",
            "error": "E2E bootstrap was removed with the old scheduling algorithm."
        }),
    )
}

fn export_tkb_class_docx_json(query: &str, body: &[u8]) -> Vec<u8> {
    export_tkb_class_file_json(query, body, "docx")
}

fn export_tkb_class_xlsx_json(query: &str, body: &[u8]) -> Vec<u8> {
    export_tkb_class_file_json(query, body, "xlsx")
}

fn export_tkb_class_file_json(query: &str, body: &[u8], extension: &str) -> Vec<u8> {
    if body.is_empty() {
        return json_response(
            400,
            json!({"ok": false, "error": format!("empty_{extension}_payload")}),
        );
    }

    let raw_date = query_param(query, "date").unwrap_or_default();
    let Some(date_stamp) = normalize_export_date(&raw_date) else {
        return json_response(
            400,
            json!({"ok": false, "error": "invalid_date_stamp", "expected": "ddmmyyyy"}),
        );
    };

    let dir = tkb_export_dir();
    if let Err(err) = fs::create_dir_all(&dir) {
        return json_response(
            500,
            json!({
                "ok": false,
                "error": format!("create_export_dir_failed: {err}"),
                "directory": dir.display().to_string()
            }),
        );
    }

    let raw_prefix = query_param(query, "prefix").unwrap_or_default();
    let file_prefix = normalize_export_file_prefix(&raw_prefix);
    let (path, file_name, sequence) =
        next_tkb_export_path(&dir, &date_stamp, extension, &file_prefix);
    if let Err(err) = fs::write(&path, body) {
        return json_response(
            500,
            json!({
                "ok": false,
                "error": format!("write_{extension}_failed: {err}"),
                "path": path.display().to_string()
            }),
        );
    }

    json_response(
        200,
        json!({
            "ok": true,
            "fileName": file_name,
            "sequence": sequence,
            "directory": dir.display().to_string(),
            "path": path.display().to_string()
        }),
    )
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(name) == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn normalize_export_date(value: &str) -> Option<String> {
    let digits: String = value.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.len() != 8 {
        None
    } else if looks_like_yyyymmdd(&digits) {
        Some(format!(
            "{}{}{}",
            &digits[6..8],
            &digits[4..6],
            &digits[0..4]
        ))
    } else {
        Some(digits)
    }
}

fn looks_like_yyyymmdd(digits: &str) -> bool {
    let Ok(year) = digits[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = digits[4..6].parse::<u32>() else {
        return false;
    };
    let Ok(day) = digits[6..8].parse::<u32>() else {
        return false;
    };
    (1900..=2199).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn normalize_export_file_prefix(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn tkb_export_dir() -> PathBuf {
    if let Ok(path) = env::var("TKB_EXPORT_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        let trimmed = profile.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed)
                .join("Documents")
                .join("Thoi Khoa Bieu");
        }
    }
    if let Ok(user) = env::var("USERNAME") {
        let trimmed = user.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(format!(r"C:\Users\{trimmed}"))
                .join("Documents")
                .join("Thoi Khoa Bieu");
        }
    }
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Documents")
        .join("Thoi Khoa Bieu")
}

fn next_tkb_export_path(
    dir: &Path,
    date_stamp: &str,
    extension: &str,
    file_prefix: &str,
) -> (PathBuf, String, u32) {
    let clean_ext: String = extension
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    let clean_ext = if clean_ext.is_empty() {
        "xlsx".to_string()
    } else {
        clean_ext.to_ascii_lowercase()
    };
    let suffix = format!("{date_stamp}.{clean_ext}").to_ascii_lowercase();
    let clean_file_prefix = normalize_export_file_prefix(file_prefix);
    let mut max_sequence = 0_u32;
    if let Ok(items) = fs::read_dir(dir) {
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            if !lower.ends_with(&suffix) {
                continue;
            }
            let prefix_len = lower.len().saturating_sub(suffix.len());
            let name_prefix = &lower[..prefix_len];
            let sequence_part = if clean_file_prefix.is_empty() {
                name_prefix
            } else {
                let Some(rest) = name_prefix.strip_prefix(&clean_file_prefix) else {
                    continue;
                };
                rest
            };
            if sequence_part.is_empty() || !sequence_part.chars().all(|ch| ch.is_ascii_digit()) {
                continue;
            }
            if let Ok(value) = sequence_part.parse::<u32>() {
                max_sequence = max_sequence.max(value);
            }
        }
    }

    let mut sequence = max_sequence.saturating_add(1).max(1);
    loop {
        let file_name = format!("{clean_file_prefix}{sequence:02}{date_stamp}.{clean_ext}");
        let path = dir.join(&file_name);
        if !path.exists() {
            return (path, file_name, sequence);
        }
        sequence = sequence.saturating_add(1);
    }
}

fn static_file(app: &App, url_path: &str) -> Vec<u8> {
    let Some(candidate) = resolve_static_path(&app.web_root, url_path) else {
        return json_response(404, json!({"ok": false, "error": "not_found"}));
    };
    let candidate = if candidate.is_dir() {
        candidate.join("index.html")
    } else {
        candidate
    };
    let Ok(root) = fs::canonicalize(&app.web_root) else {
        return json_response(404, json!({"ok": false, "error": "not_found"}));
    };
    let Ok(path) = fs::canonicalize(candidate) else {
        return json_response(404, json!({"ok": false, "error": "not_found"}));
    };
    if !path.starts_with(&root) {
        return json_response(403, json!({"ok": false, "error": "forbidden"}));
    }
    if !path.is_file() || !is_public_static_file(&path) {
        return json_response(404, json!({"ok": false, "error": "not_found"}));
    }
    match fs::read(&path) {
        Ok(bytes) => {
            let cross_origin_isolated = static_resource_requires_cross_origin_isolation(url_path);
            static_http_response(200, content_type(&path), &bytes, cross_origin_isolated)
        }
        Err(_) => json_response(404, json!({"ok": false, "error": "not_found"})),
    }
}

fn static_resource_requires_cross_origin_isolation(url_path: &str) -> bool {
    matches!(url_path, "/pages/sapxep" | "/pages/sapxep.html")
        || url_path.ends_with("-worker.js")
        || url_path.ends_with(".wasm")
        || url_path.starts_with("/vendor/or-tools-wasm/")
        || url_path.starts_with("/vendor/highs/")
}

fn resolve_static_path(root: &Path, url_path: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for component in Path::new(url_path.trim_start_matches('/')).components() {
        match component {
            Component::Normal(part) => {
                if part.to_string_lossy().starts_with('.') {
                    return None;
                }
                out.push(part);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn clean_page_file(url_path: &str) -> Option<&'static str> {
    match url_path {
        "/app" => Some("/app.html"),
        "/school-portal" => Some("/school-portal.html"),
        "/super-admin" => Some("/super-admin.html"),
        "/pages/phanmon" => Some("/pages/phanmon.html"),
        "/pages/sapxep" => Some("/pages/sapxep.html"),
        _ => None,
    }
}

fn canonical_page_redirect(url_path: &str, query: &str) -> Option<String> {
    let clean_path = match url_path {
        "/index.html" => "/",
        "/app.html" => "/app",
        "/school-portal.html" => "/school-portal",
        "/super-admin.html" => "/super-admin",
        "/pages/phanmon.html" => "/pages/phanmon",
        "/pages/sapxep.html" => "/pages/sapxep",
        _ => return None,
    };
    if query.is_empty() || !query.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Some(clean_path.to_string());
    }
    Some(format!("{clean_path}?{query}"))
}

fn is_public_static_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "html"
            | "js"
            | "css"
            | "webmanifest"
            | "png"
            | "jpg"
            | "jpeg"
            | "svg"
            | "ico"
            | "wasm"
            | "zip"
    )
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        "exe" => "application/vnd.microsoft.portable-executable",
        _ => "application/octet-stream",
    }
}

fn json_response(status: u16, value: serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"json_encode_failed"}"#.to_vec());
    http_response(status, "application/json; charset=utf-8", &body)
}

fn http_response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    http_response_with_extra_headers(status, content_type, body, "")
}

fn static_http_response(
    status: u16,
    content_type: &str,
    body: &[u8],
    cross_origin_isolated: bool,
) -> Vec<u8> {
    let extra_headers = if cross_origin_isolated {
        "Cross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\n"
    } else {
        ""
    };
    http_response_with_extra_headers(status, content_type, body, extra_headers)
}

fn http_response_with_extra_headers(
    status: u16,
    content_type: &str,
    body: &[u8],
    extra_headers: &str,
) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nPermissions-Policy: camera=(), microphone=(), geolocation=()\r\n{extra_headers}Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(body);
    out
}

fn redirect_response(status: u16, location: &str) -> Vec<u8> {
    let reason = if status == 308 {
        "Permanent Redirect"
    } else {
        "Redirect"
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nLocation: {location}\r\nContent-Length: 0\r\nCache-Control: no-store, max-age=0\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(value: &str) -> String {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_nibble(bytes[index + 1]), hex_nibble(bytes[index + 2]))
            {
                out.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    static TRUSTED_AGENT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvironmentRestore {
        name: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvironmentRestore {
        fn set(name: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, previous }
        }
    }

    impl Drop for EnvironmentRestore {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var(self.name, previous);
            } else {
                std::env::remove_var(self.name);
            }
        }
    }

    fn registry_security_fixture() -> Value {
        json!({
            "version": 1,
            "users": {
                "suadmin": {"id":"suadmin", "role":"superadmin", "passwordHash":"root-secret"},
                "admina": {"id":"admina", "role":"school_admin", "schoolId":"school-a", "passwordHash":"admin-a-secret", "active":true},
                "suba": {"id":"suba", "role":"school_user", "schoolId":"school-a", "passwordHash":"sub-a-secret", "active":true},
                "adminb": {"id":"adminb", "role":"school_admin", "schoolId":"school-b", "passwordHash":"admin-b-secret", "active":true}
            },
            "schools": {
                "school-a": {
                    "id":"school-a", "shortId":"aa", "name":"School A", "plan":"ultra", "active":true,
                    "activeSchedule":1,
                    "schedules":[{"number":1,"sid":"aa1","original":true}]
                },
                "school-b": {"id":"school-b", "shortId":"bb", "name":"School B", "plan":"max", "active":true}
            },
            "registeredIps": {
                "203.0.113.1": {"schoolId":"school-a"},
                "203.0.113.2": {"schoolId":"school-b"}
            }
        })
    }

    #[test]
    fn school_registry_reads_are_tenant_scoped_and_secret_free() {
        let registry = registry_security_fixture();
        let admin_session = json!({
            "userId":"admina", "role":"school_admin", "schoolId":"school-a"
        });
        let scoped =
            auth::strip_registry_for_client(scoped_auth_registry(&registry, &admin_session));
        assert!(scoped["schools"].get("school-a").is_some());
        assert!(scoped["schools"].get("school-b").is_none());
        assert!(scoped["users"].get("admina").is_some());
        assert!(scoped["users"].get("suba").is_some());
        assert!(scoped["users"].get("adminb").is_none());
        assert!(scoped["users"].get("suadmin").is_none());
        assert!(scoped["users"]["admina"].get("passwordHash").is_none());
        assert!(scoped["registeredIps"].get("203.0.113.1").is_some());
        assert!(scoped["registeredIps"].get("203.0.113.2").is_none());

        let user_session = json!({
            "userId":"suba", "role":"school_user", "schoolId":"school-a"
        });
        let user_scoped = scoped_auth_registry(&registry, &user_session);
        assert!(user_scoped["users"].get("suba").is_some());
        assert!(user_scoped["users"].get("admina").is_none());
    }

    #[test]
    fn registration_ip_usage_tracks_only_owners_still_in_the_registry() {
        let live = registry_security_fixture();
        let live_ips = registration_ips_from_registry(&live);
        assert!(live_ips.contains("203.0.113.1"));
        assert!(live_ips.contains("203.0.113.2"));

        let deleted = json!({
            "users": {},
            "schools": {},
            "registeredIps": {
                "203.0.113.1": {"schoolId":"school-a", "loginId":"admina"}
            },
            "deletedSchools": {"school-a": true},
            "deletedUsers": {"admina": true}
        });
        assert!(!registration_ips_from_registry(&deleted).contains("203.0.113.1"));

        let legacy_user_key = json!({
            "users": {"legacy-key": {"id":"OwnerAccount"}},
            "schools": {},
            "registeredIps": {
                "203.0.113.3": {"loginId":"owneraccount"}
            }
        });
        assert!(registration_ips_from_registry(&legacy_user_key).contains("203.0.113.3"));
    }

    #[test]
    fn registry_write_allows_reusing_an_ip_after_its_school_was_deleted() {
        let current = json!({
            "users": {},
            "schools": {},
            "registeredIps": {
                "203.0.113.7": {"schoolId":"old-school", "loginId":"old-admin"}
            },
            "deletedSchools": {"old-school": true},
            "deletedUsers": {"old-admin": true}
        });
        let next = json!({
            "schools": {
                "replacement-school": {
                    "id":"replacement-school",
                    "trialUsed":false,
                    "ips":["203.0.113.7"]
                }
            }
        });
        assert_eq!(duplicate_registration_ip(&current, &next), None);
    }

    #[test]
    fn stale_superadmin_snapshot_cannot_resurrect_tombstoned_entities() {
        let current = json!({
            "users": {
                "suadmin": {"id":"suadmin", "role":"superadmin", "passwordHash":"root"}
            },
            "schools": {},
            "deletedUsers": {"same-login": true},
            "deletedSchools": {"old-school": true},
            "blockedIps": {},
            "registeredIps": {}
        });
        let incoming = json!({
            "users": {
                "suadmin": {"id":"suadmin", "role":"superadmin"},
                "same-login": {
                    "id":"same-login",
                    "role":"school_admin",
                    "schoolId":"new-school"
                }
            },
            "schools": {
                "new-school": {"id":"new-school", "name":"New School"},
                "old-school": {"id":"old-school", "name":"Stale Deleted School"}
            },
            "deletedUsers": {"same-login": true},
            "deletedSchools": {"old-school": true},
            "blockedIps": {
                "203.0.113.20": {"schoolId":"old-school"},
                "203.0.113.21": {"manual":true}
            },
            "registeredIps": {}
        });

        let merged = merge_auth_registry(&current, incoming);
        assert!(merged["users"].get("same-login").is_none());
        assert!(merged["schools"].get("old-school").is_none());
        assert!(merged["deletedUsers"].get("same-login").is_some());
        assert!(merged["deletedSchools"].get("old-school").is_some());
        assert!(merged["blockedIps"].get("203.0.113.20").is_none());
        assert!(merged["blockedIps"].get("203.0.113.21").is_some());
    }

    #[test]
    fn direct_registration_recreation_survives_a_later_superadmin_merge() {
        let db = db::Db::new(":memory:".into()).expect("in-memory database");
        auth::save_registry(
            &db,
            &json!({
                "users": {},
                "schools": {},
                "registeredIps": {
                    "203.0.113.59": {"schoolId":"deleted-school", "loginId":"same-login"}
                },
                "deletedSchools": {"deleted-school": true},
                "deletedUsers": {"same-login": true}
            }),
        );
        let response = auth::register_json(
            &db,
            br#"{
                "loginId":"same-login",
                "password":"secret123",
                "email":"same-login@example.com",
                "phone":"0912345678",
                "schoolName":"Recreated School",
                "scheduleNumber":1,
                "effectiveDate":"2026-07-13"
            }"#,
            "203.0.113.59",
        );
        assert!(String::from_utf8_lossy(&response).contains("200 OK"));

        let current = auth::load_registry(&db);
        assert!(current["deletedUsers"].get("same-login").is_none());
        let merged = merge_auth_registry(&current, current.clone());
        assert!(merged["users"].get("same-login").is_some());
    }

    #[test]
    fn verified_email_and_trial_history_cannot_be_downgraded_by_a_stale_snapshot() {
        let current = json!({
            "users": {
                "admina": {"id":"admina", "schoolId":"school-a", "emailVerified":true}
            },
            "schools": {
                "school-a": {"id":"school-a", "verified":true, "trialUsed":true}
            }
        });
        let stale = json!({
            "users": {
                "admina": {"id":"admina", "schoolId":"school-a", "emailVerified":false}
            },
            "schools": {
                "school-a": {"id":"school-a", "verified":false, "trialUsed":false}
            }
        });
        let merged = merge_auth_registry(&current, stale);
        assert_eq!(merged["users"]["admina"]["emailVerified"], json!(true));
        assert_eq!(merged["schools"]["school-a"]["verified"], json!(true));
        assert_eq!(merged["schools"]["school-a"]["trialUsed"], json!(true));
    }

    #[test]
    fn school_admin_registry_writes_cannot_cross_tenants_or_escalate_roles() {
        let registry = registry_security_fixture();
        let session = json!({
            "userId":"admina", "role":"school_admin", "schoolId":"school-a"
        });
        let password_hash = "a".repeat(64);
        let incoming = json!({
            "schools": {
                "school-a": {
                    "id":"school-a", "shortId":"bb", "name":"Updated A", "plan":"free", "active":false,
                    "activeSchedule":2,
                    "schedules":[{"number":2,"sid":"bb1","label":"Second"}]
                },
                "school-b": {"id":"school-b", "name":"Stolen B", "plan":"free", "active":false}
            },
            "users": {
                "suadmin": {"id":"suadmin", "role":"school_user", "schoolId":"school-a", "passwordHash":password_hash},
                "admina": {"id":"admina", "role":"superadmin", "schoolId":"school-b", "passwordHash":password_hash, "emailVerified":true},
                "adminb": {"id":"adminb", "role":"school_user", "schoolId":"school-a", "passwordHash":password_hash},
                "newadmin": {"id":"newadmin", "role":"school_admin", "schoolId":"school-a", "passwordHash":password_hash},
                "newuser": {"id":"newuser", "role":"school_user", "schoolId":"school-a", "passwordHash":password_hash, "displayName":"New User"}
            },
            "deletedUsers": {"suba":true, "adminb":true}
        });

        let merged = merge_school_admin_registry(&registry, &incoming, &session)
            .expect("authorized school admin merge");
        assert_eq!(merged["schools"]["school-a"]["name"], json!("Updated A"));
        assert_eq!(merged["schools"]["school-a"]["plan"], json!("ultra"));
        assert_eq!(merged["schools"]["school-a"]["active"], json!(true));
        assert_eq!(merged["schools"]["school-a"]["shortId"], json!("aa"));
        assert_eq!(
            merged["schools"]["school-a"]["schedules"][0]["sid"],
            json!("aa2")
        );
        assert_eq!(merged["schools"]["school-b"]["name"], json!("School B"));
        assert_eq!(
            merged["users"]["suadmin"]["passwordHash"],
            json!("root-secret")
        );
        assert_eq!(merged["users"]["adminb"]["role"], json!("school_admin"));
        assert_eq!(merged["users"]["admina"]["role"], json!("school_admin"));
        assert_eq!(merged["users"]["admina"]["schoolId"], json!("school-a"));
        assert_eq!(merged["users"]["admina"]["emailVerified"], json!(true));
        assert_eq!(merged["schools"]["school-a"]["verified"], json!(true));
        assert_eq!(
            merged["users"]["admina"]["passwordHash"],
            json!(password_hash)
        );
        assert!(merged["users"].get("suba").is_none());
        assert!(merged["users"].get("newadmin").is_none());
        assert_eq!(merged["users"]["newuser"]["role"], json!("school_user"));
        assert!(merged["deletedUsers"].get("suba").is_some());
        assert!(merged["deletedUsers"].get("adminb").is_none());
    }

    #[test]
    fn clean_page_routes_are_explicit_and_legacy_html_is_canonicalized() {
        assert_eq!(clean_page_file("/app"), Some("/app.html"));
        assert_eq!(clean_page_file("/pages/sapxep"), Some("/pages/sapxep.html"));
        assert_eq!(clean_page_file("/api/health"), None);
        assert_eq!(clean_page_file("/unknown"), None);

        assert_eq!(
            canonical_page_redirect("/app.html", "sid=abc123"),
            Some("/app?sid=abc123".to_string())
        );
        assert_eq!(
            canonical_page_redirect("/index.html", ""),
            Some("/".to_string())
        );
        assert_eq!(canonical_page_redirect("/unknown.html", ""), None);
    }

    #[test]
    fn canonical_redirect_drops_header_unsafe_query_bytes() {
        assert_eq!(
            canonical_page_redirect("/app.html", "sid=ok\r\nInjected: yes"),
            Some("/app".to_string())
        );
    }

    #[test]
    fn request_path_decoder_does_not_panic_on_malformed_escape_before_utf8() {
        let request = parse_request(
            "GET /%A\u{e9} HTTP/1.1\r\nHost: localhost",
            b"",
            Some("127.0.0.1".parse().unwrap()),
        );
        assert_eq!(request.path, "/%A\u{e9}");
        assert_eq!(percent_decode("/%C3%A9"), "/\u{e9}");
    }

    #[test]
    fn loopback_proxy_uses_server_supplied_real_ip() {
        let request = parse_request(
            "POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nX-Real-IP: 203.0.113.9\r\nX-Forwarded-For: 198.51.100.8, 203.0.113.9",
            b"{}",
            Some("127.0.0.1".parse().unwrap()),
        );
        assert_eq!(request.client_ip, "203.0.113.9");
    }

    #[test]
    fn direct_client_cannot_spoof_forwarded_ip_headers() {
        let request = parse_request(
            "POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nX-Real-IP: 203.0.113.9\r\nX-Forwarded-For: 198.51.100.8",
            b"{}",
            Some("192.0.2.44".parse().unwrap()),
        );
        assert_eq!(request.client_ip, "192.0.2.44");
    }

    #[test]
    fn loopback_proxy_uses_last_forwarded_hop_when_real_ip_is_absent() {
        let request = parse_request(
            "POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 198.51.100.8, 203.0.113.9",
            b"{}",
            Some("127.0.0.1".parse().unwrap()),
        );
        assert_eq!(request.client_ip, "203.0.113.9");
    }

    #[test]
    fn static_path_policy_blocks_hidden_and_non_public_files() {
        let root = Path::new("web");
        assert!(resolve_static_path(root, "/.env").is_none());
        assert!(resolve_static_path(root, "/pages/../index.html").is_none());
        assert!(is_public_static_file(Path::new("web/app.js")));
        assert!(is_public_static_file(Path::new("web/vendor/sql-wasm.wasm")));
        assert!(is_public_static_file(Path::new(
            "web/downloads/TKBCherryAgent-Windows.zip"
        )));
        assert!(!is_public_static_file(Path::new(
            "web/downloads/TKBCherryAgent.exe"
        )));
        assert!(!is_public_static_file(Path::new("web/TKBCherryAgent.exe")));
        assert!(!is_public_static_file(Path::new(
            "web/downloads/OtherProgram.exe"
        )));
        assert!(is_public_static_file(Path::new(
            "web/pages/planner.webmanifest"
        )));
        assert_eq!(
            content_type(Path::new("web/pages/planner.webmanifest")),
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("web/downloads/TKBCherryAgent-Windows.zip")),
            "application/zip"
        );
        assert_eq!(
            content_type(Path::new("web/downloads/TKBCherryAgent.exe")),
            "application/vnd.microsoft.portable-executable"
        );
        assert!(!is_public_static_file(Path::new("web/source.map")));
        assert!(!is_public_static_file(Path::new("web/private.db")));
    }

    #[test]
    fn responses_include_baseline_browser_security_headers() {
        let response =
            String::from_utf8(http_response(200, "text/plain", b"ok")).expect("HTTP response");
        assert!(response.contains("X-Content-Type-Options: nosniff\r\n"));
        assert!(response.contains("X-Frame-Options: DENY\r\n"));
        assert!(response.contains("Referrer-Policy: strict-origin-when-cross-origin\r\n"));
        assert!(
            response.contains("Permissions-Policy: camera=(), microphone=(), geolocation=()\r\n")
        );

        let redirect =
            String::from_utf8(redirect_response(308, "/app?sid=one")).expect("redirect response");
        assert!(redirect.starts_with("HTTP/1.1 308 Permanent Redirect\r\n"));
        assert!(redirect.contains("Location: /app?sid=one\r\n"));
    }

    #[test]
    fn scheduler_workers_and_wasm_keep_cross_origin_isolation() {
        for path in [
            "/pages/sapxep",
            "/pages/tkb-browser-wasm-worker.js",
            "/pages/tkb-cpsat-worker.js",
            "/pages/tkb-highs-worker.js",
            "/pages/tkb_native_solver.wasm",
            "/vendor/or-tools-wasm/browser/cp-sat.js",
            "/vendor/or-tools-wasm/wasm/cp_sat_runtime.wasm",
            "/vendor/highs/highs.js",
            "/vendor/highs/highs.wasm",
        ] {
            assert!(
                static_resource_requires_cross_origin_isolation(path),
                "{path} must remain isolated"
            );
        }
        assert!(!static_resource_requires_cross_origin_isolation("/app.js"));
        assert!(!static_resource_requires_cross_origin_isolation(
            "/downloads/TKBCherryAgent-Windows.zip"
        ));

        let isolated = String::from_utf8(static_http_response(
            200,
            "application/javascript; charset=utf-8",
            b"ok",
            true,
        ))
        .expect("isolated response");
        assert!(isolated.contains("Cross-Origin-Opener-Policy: same-origin\r\n"));
        assert!(isolated.contains("Cross-Origin-Embedder-Policy: require-corp\r\n"));
        assert!(isolated.contains("Cross-Origin-Resource-Policy: same-origin\r\n"));
    }

    #[test]
    fn solver_auth_gate_is_optional_locally_and_requires_a_valid_session_when_enabled() {
        let db = db::Db::new(PathBuf::from(":memory:")).expect("in-memory auth database");
        assert_eq!(
            solver_request_owner_with_requirement(&db, None, false).unwrap(),
            SolverOwner::anonymous()
        );

        let unauthorized = solver_request_owner_with_requirement(&db, None, true)
            .expect_err("missing production session must be rejected");
        assert!(String::from_utf8_lossy(&unauthorized).starts_with("HTTP/1.1 401"));

        let token = auth::create_session(
            &db,
            "school-admin",
            &json!({
                "role": "school_admin",
                "schoolId": "School-A",
                "displayName": "School Admin"
            }),
        )
        .expect("session token");
        assert_eq!(
            solver_request_owner_with_requirement(&db, Some(&token), true).unwrap(),
            SolverOwner::new("school-a", "school-admin")
        );
    }

    #[test]
    fn solver_owner_requires_school_or_login_identity() {
        assert_eq!(
            solver_owner_from_session(&json!({"schoolId": "School-A", "userId": "Admin-A"})),
            Some(SolverOwner::new("school-a", "admin-a"))
        );
        assert!(solver_owner_from_session(&json!({"role": "school_admin"})).is_none());
    }

    #[test]
    fn solver_plan_policy_is_role_explicit_and_resolves_max_legacy_metadata() {
        let (app, _, _) = agent_test_app();
        assert!(auth::save_registry(
            &app.db,
            &json!({
                "schools": {
                    "free-school": {"id":"free-school", "plan":"free"},
                    "trial-school": {"id":"trial-school", "plan":"trial"},
                    "plus-school": {"id":"plus-school", "plan":"plus", "plusQuotaCycleId":"cycle-2026-08"},
                    "max1-school": {"id":"max1-school", "plan":"max1"},
                    "max2-school": {"id":"max2-school", "plan":"max2"},
                    "legacy-max1": {"id":"legacy-max1", "plan":"max", "classCount":39},
                    "legacy-max2": {"id":"legacy-max2", "plan":"max", "classCount":40},
                    "legacy-max-zero": {"id":"legacy-max-zero", "plan":"max", "classCount":0},
                    "legacy-max-untyped": {"id":"legacy-max-untyped", "plan":"max"},
                    "expired-trial": {"id":"expired-trial", "plan":"trial", "expiresAt":"2000-01-01T00:00:00.000Z"},
                    "expired-plus": {"id":"expired-plus", "plan":"plus", "expiresAt":"2000-01-01T07:00:00+07:00"},
                    "expired-max1": {"id":"expired-max1", "plan":"max1", "expiresAt":"2000-01-01"},
                    "ultra-school": {"id":"ultra-school", "plan":"ultra"}
                },
                "users": {}
            })
        ));
        let session = |role: &str, school_id: &str| {
            json!({"role":role, "schoolId":school_id, "userId":"account"})
        };
        for school_id in ["free-school", "expired-trial", "expired-plus", "expired-max1"] {
            assert_eq!(
                solver_plan_policy(
                    &app,
                    Some(&session("school_user", school_id)),
                    true
                ),
                SolverPlanPolicy::Free
            );
        }
        assert_eq!(
            solver_plan_policy(
                &app,
                Some(&session("school_admin", "trial-school")),
                true
            ),
            SolverPlanPolicy::Trial
        );
        assert_eq!(
            solver_plan_policy(
                &app,
                Some(&session("school_user", "plus-school")),
                true
            ),
            SolverPlanPolicy::Plus {
                quota_cycle_id: "cycle-2026-08".to_string()
            }
        );
        for school_id in ["max1-school", "legacy-max1"] {
            assert_eq!(
                solver_plan_policy(
                    &app,
                    Some(&session("school_user", school_id)),
                    true
                ),
                SolverPlanPolicy::Max1
            );
        }
        for school_id in [
            "max2-school",
            "legacy-max2",
            "legacy-max-zero",
            "legacy-max-untyped",
            "ultra-school",
        ] {
            assert_eq!(
                solver_plan_policy(
                    &app,
                    Some(&session("school_user", school_id)),
                    true
                ),
                SolverPlanPolicy::Exempt
            );
        }
        assert_eq!(
            solver_plan_policy(
                &app,
                Some(&session("superadmin", "")),
                true
            ),
            SolverPlanPolicy::Exempt
        );
        assert_eq!(
            solver_plan_policy(
                &app,
                Some(&session("school_admin", "missing-school")),
                true
            ),
            SolverPlanPolicy::Unknown
        );
        assert_eq!(
            solver_plan_policy(&app, None, true),
            SolverPlanPolicy::Unknown
        );
        assert_eq!(
            plan_expiry_millis("2026-08-03T12:34:56.789Z"),
            plan_expiry_millis("2026-08-03T19:34:56.789+07:00")
        );
        assert!(plan_expiry_millis("not-a-date").is_none());
    }

    #[test]
    fn free_quota_blocks_replay_and_the_sixth_job_before_execution() {
        let (app, _, owner) = agent_test_app();
        for index in 0..serverless::FREE_SOLVE_ACTION_LIMIT {
            assert!(matches!(
                app.serverless
                    .claim_free_solve(
                        owner.school_id(),
                        owner.login_id(),
                        &format!("free-seed-{index}")
                    )
                    .unwrap(),
                serverless::FreeSolveAdmission::Claimed { .. }
            ));
        }

        let replay = async_preserved_request("free-seed-0");
        let replay_response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&replay).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Free,
        );
        assert_eq!(response_status(&replay_response), 409);
        assert_eq!(
            response_payload(&replay_response)["kind"],
            json!("free_solve_job_replayed")
        );

        let request = async_preserved_request("free-job-6");
        let response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&request).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Free,
        );
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 429);
        assert_eq!(payload["kind"], json!("free_solve_quota_exhausted"));
        assert_eq!(payload["limit"], json!(5));
        assert_eq!(payload["used"], json!(5));
        assert_eq!(payload["retryable"], json!(false));
        assert!(!app
            .solver_pool
            .server_job_known_for_owner("free-job-6", &owner));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
    }

    #[test]
    fn trial_quota_blocks_replay_and_the_fifty_first_job_before_execution() {
        let (app, _, owner) = agent_test_app();
        for index in 0..50 {
            assert!(matches!(
                app.serverless
                    .claim_trial_solve(
                        owner.school_id(),
                        owner.login_id(),
                        &format!("trial-seed-{index}")
                    )
                    .unwrap(),
                serverless::TrialSolveAdmission::Claimed { .. }
            ));
        }

        let replay = async_preserved_request("trial-seed-0");
        let replay_response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&replay).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Trial,
        );
        assert_eq!(response_status(&replay_response), 409);
        assert_eq!(
            response_payload(&replay_response)["kind"],
            json!("trial_solve_job_replayed")
        );

        let request = async_preserved_request("trial-job-51");
        let response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&request).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Trial,
        );
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 429);
        assert_eq!(payload["kind"], json!("trial_solve_quota_exhausted"));
        assert_eq!(payload["limit"], json!(50));
        assert_eq!(payload["used"], json!(50));
        assert!(!app
            .solver_pool
            .server_job_known_for_owner("trial-job-51", &owner));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        let usage = app.serverless.usage_json();
        assert_eq!(usage["activeReservations"], json!(0));
        assert_eq!(usage["accountRequestTotals"]["totalRequests"], json!(0));
    }

    #[test]
    fn plus_quota_blocks_the_hundred_and_first_job_before_execution() {
        let (app, _, owner) = agent_test_app();
        let cycle = "plus-cycle-2026-08";
        for index in 0..serverless::PLUS_SOLVE_ACTION_LIMIT {
            assert!(matches!(
                app.serverless
                    .claim_plus_solve(
                        owner.school_id(),
                        owner.login_id(),
                        cycle,
                        &format!("plus-seed-{index}")
                    )
                    .unwrap(),
                serverless::PlusSolveAdmission::Claimed { .. }
            ));
        }

        let request = async_preserved_request("plus-job-101");
        let response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&request).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Plus {
                quota_cycle_id: cycle.to_string(),
            },
        );
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 429);
        assert_eq!(payload["kind"], json!("plus_solve_quota_exhausted"));
        assert_eq!(payload["limit"], json!(100));
        assert_eq!(payload["used"], json!(100));
        assert_eq!(payload["retryable"], json!(false));
        assert!(!app
            .solver_pool
            .server_job_known_for_owner("plus-job-101", &owner));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(
            app.serverless.usage_json()["accountRequestTotals"]["totalRequests"],
            json!(0)
        );
    }

    #[test]
    fn metered_claim_is_released_when_vps_cannot_accept_the_job() {
        let (app, _, owner) = agent_test_app();
        let blocker = app
            .solver_pool
            .try_acquire(
                "metered-pre-admission-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS blocker");

        let free_request = json!({
            "settings": {"solve_run_id":"free-pre-admission-rejected"}
        });
        let free_response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&free_request).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Free,
        );
        assert_eq!(response_status(&free_response), 409);
        assert_eq!(response_payload(&free_response)["kind"], json!("solver_busy"));
        assert_eq!(
            app.serverless
                .claim_free_solve(
                    owner.school_id(),
                    owner.login_id(),
                    "free-pre-admission-rejected",
                )
                .unwrap(),
            serverless::FreeSolveAdmission::Claimed { used: 1 }
        );
        assert!(app
            .serverless
            .release_free_solve_claim(
                owner.school_id(),
                owner.login_id(),
                "free-pre-admission-rejected",
            )
            .unwrap());

        let plus_request = json!({
            "settings": {"solve_run_id":"plus-pre-admission-rejected"}
        });
        let plus_response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&plus_request).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Plus {
                quota_cycle_id: "plus-pre-admission-cycle".to_string(),
            },
        );
        assert_eq!(response_status(&plus_response), 409);
        assert_eq!(response_payload(&plus_response)["kind"], json!("solver_busy"));
        assert_eq!(
            app.serverless
                .claim_plus_solve(
                    owner.school_id(),
                    owner.login_id(),
                    "plus-pre-admission-cycle",
                    "plus-pre-admission-rejected",
                )
                .unwrap(),
            serverless::PlusSolveAdmission::Claimed { used: 1 }
        );
        assert!(app
            .serverless
            .release_plus_solve_claim(
                owner.school_id(),
                owner.login_id(),
                "plus-pre-admission-cycle",
                "plus-pre-admission-rejected",
            )
            .unwrap());

        let trial_request = json!({
            "settings": {"solve_run_id":"trial-pre-admission-rejected"}
        });
        let trial_response = solve_json_with_agent_permission(
            &app,
            &serde_json::to_vec(&trial_request).unwrap(),
            &owner,
            false,
            SolverPlanPolicy::Trial,
        );
        assert_eq!(response_status(&trial_response), 409);
        assert_eq!(response_payload(&trial_response)["kind"], json!("solver_busy"));
        assert_eq!(
            app.serverless
                .claim_trial_solve(
                    owner.school_id(),
                    owner.login_id(),
                    "trial-pre-admission-rejected",
                )
                .unwrap(),
            serverless::TrialSolveAdmission::Claimed { used: 1 }
        );
        assert!(app
            .serverless
            .release_trial_solve_claim(
                owner.school_id(),
                owner.login_id(),
                "trial-pre-admission-rejected",
            )
            .unwrap());
        drop(blocker);
    }

    #[test]
    fn max1_class_limit_is_atomic_and_uses_the_authenticated_registry_plan() {
        let (app, token, owner) = agent_test_app();
        assert!(auth::save_registry(
            &app.db,
            &json!({
                "schools": {
                    "school-agent": {
                        "id":"school-agent",
                        "shortId":"sa",
                        "schedules":[{"number":1,"sid":"sa1"}],
                        "plan":"max1",
                        "active":true
                    },
                    "body-claimed-school": {
                        "id":"body-claimed-school",
                        "plan":"max2",
                        "active":true
                    }
                },
                "users": {}
            })
        ));
        let classes = |count: usize| {
            Value::Array(
                (0..count)
                    .map(|index| json!({"id":format!("L{index}")}))
                    .collect(),
            )
        };

        let original = json!({"lop":classes(1), "marker":"original"});
        app.db
            .set(
                "school_school-agent",
                &serde_json::to_string(&original).unwrap(),
            )
            .unwrap();
        let attempted_store = json!({
            "schoolId":"body-claimed-school",
            "plan":"max2",
            "lop":classes(40),
            "marker":"must-not-save"
        });
        let rejected_store = school_store_post_json(
            &app,
            "id=school-agent",
            Some(&token),
            &serde_json::to_vec(&attempted_store).unwrap(),
        );
        let rejected_store_payload = response_payload(&rejected_store);
        assert_eq!(response_status(&rejected_store), 409);
        assert_eq!(
            rejected_store_payload["kind"],
            json!("max1_class_limit_exceeded")
        );
        assert_eq!(rejected_store_payload["limit"], json!(39));
        assert_eq!(rejected_store_payload["classCount"], json!(40));
        assert_eq!(rejected_store_payload["upgradePlan"], json!("max2"));
        let persisted: Value = serde_json::from_str(
            &app.db
                .get("school_school-agent")
                .unwrap()
                .expect("original school store"),
        )
        .unwrap();
        assert_eq!(persisted["marker"], json!("original"));
        assert_eq!(persisted["lop"].as_array().map(Vec::len), Some(1));

        let mut solve_request = async_preserved_request("max1-over-limit-solve");
        solve_request["data"]["schoolId"] = json!("body-claimed-school");
        solve_request["data"]["plan"] = json!("max2");
        solve_request["data"]["lop"] = classes(40);
        let rejected_solve = agent_route(
            &app,
            Some(&token),
            "/api/solve-data",
            solve_request,
        );
        assert_eq!(response_status(&rejected_solve), 409);
        assert_eq!(
            response_payload(&rejected_solve)["kind"],
            json!("max1_class_limit_exceeded")
        );
        assert!(!app
            .solver_pool
            .server_job_known_for_owner("max1-over-limit-solve", &owner));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);

        let superadmin_token = auth::create_session(
            &app.db,
            "max1-superadmin",
            &json!({"role":"superadmin","displayName":"Max 1 Super Admin"}),
        )
        .expect("superadmin session");
        let mut superadmin_solve = async_preserved_request("max1-superadmin-over-limit");
        superadmin_solve["data"]["lop"] = classes(40);
        superadmin_solve["settings"]["ui_schedule_scope"] = json!("school-agent");
        let superadmin_rejected = agent_route(
            &app,
            Some(&superadmin_token),
            "/api/solve-data",
            superadmin_solve,
        );
        assert_eq!(response_status(&superadmin_rejected), 409);
        assert_eq!(
            response_payload(&superadmin_rejected)["kind"],
            json!("max1_class_limit_exceeded")
        );

        let allowed_store = json!({"lop":classes(39), "marker":"allowed"});
        let allowed = school_store_post_json(
            &app,
            "id=school-agent",
            Some(&token),
            &serde_json::to_vec(&allowed_store).unwrap(),
        );
        assert_eq!(response_status(&allowed), 200);
        let persisted: Value = serde_json::from_str(
            &app.db
                .get("school_school-agent")
                .unwrap()
                .expect("allowed school store"),
        )
        .unwrap();
        assert_eq!(persisted["lop"].as_array().map(Vec::len), Some(39));

        assert!(auth::save_registry(
            &app.db,
            &json!({
                "schools": {
                    "school-agent": {
                        "id":"school-agent",
                        "plan":"max2",
                        "active":true
                    }
                },
                "users": {}
            })
        ));
        let max2_store = json!({"lop":classes(80), "marker":"max2-unlimited"});
        let max2_allowed = school_store_post_json(
            &app,
            "id=school-agent",
            Some(&token),
            &serde_json::to_vec(&max2_store).unwrap(),
        );
        assert_eq!(response_status(&max2_allowed), 200);
        let persisted: Value = serde_json::from_str(
            &app.db
                .get("school_school-agent")
                .unwrap()
                .expect("Max 2 school store"),
        )
        .unwrap();
        assert_eq!(persisted["lop"].as_array().map(Vec::len), Some(80));

        assert!(auth::save_registry(
            &app.db,
            &json!({"schools":{},"users":{}})
        ));
        let unresolved_school = school_store_post_json(
            &app,
            "id=school-agent",
            Some(&token),
            &serde_json::to_vec(&json!({"lop":classes(10)})).unwrap(),
        );
        assert_eq!(response_status(&unresolved_school), 503);
        assert_eq!(
            response_payload(&unresolved_school)["kind"],
            json!("school_plan_unavailable")
        );

        let unresolved_superadmin = school_store_post_json(
            &app,
            "id=unowned-store",
            Some(&superadmin_token),
            &serde_json::to_vec(&json!({"lop":classes(40)})).unwrap(),
        );
        assert_eq!(response_status(&unresolved_superadmin), 503);
        assert_eq!(
            response_payload(&unresolved_superadmin)["kind"],
            json!("school_plan_unavailable")
        );

        let superadmin_default = school_store_post_json(
            &app,
            "id=default",
            Some(&superadmin_token),
            &serde_json::to_vec(&json!({"lop":classes(80)})).unwrap(),
        );
        assert_eq!(response_status(&superadmin_default), 200);
    }

    #[test]
    fn trusted_agent_bearer_requires_the_exact_server_configured_digest() {
        let token = format!("{TRUSTED_AGENT_TOKEN_PREFIX}{}", "a".repeat(64));
        let digest = trusted_agent_token_digest(&token);
        assert!(trusted_agent_token_matches(Some(&digest), &token));
        assert!(trusted_agent_token_matches(
            Some(&digest.to_ascii_uppercase()),
            &token
        ));
        assert!(!trusted_agent_token_matches(Some(&digest), "tkbt_wrong"));
        assert!(!trusted_agent_token_matches(None, &token));
        assert!(!trusted_agent_token_matches(Some(&"0".repeat(64)), &token));
    }

    fn response_payload(response: &[u8]) -> Value {
        let text = String::from_utf8_lossy(response);
        let (_, body) = text
            .split_once("\r\n\r\n")
            .expect("HTTP response body separator");
        serde_json::from_str(body).expect("JSON response body")
    }

    fn response_status(response: &[u8]) -> u16 {
        String::from_utf8_lossy(response)
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|status| status.parse::<u16>().ok())
            .expect("HTTP response status")
    }

    fn agent_test_app() -> (App, String, SolverOwner) {
        let db = Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database"));
        let token = auth::create_session(
            &db,
            "agent-admin",
            &json!({
                "role":"school_admin",
                "schoolId":"School-Agent",
                "displayName":"Agent Admin"
            }),
        )
        .expect("agent session");
        assert!(auth::save_registry(
            &db,
            &json!({
                "schools": {
                    "school-agent": {
                        "id":"school-agent",
                        "name":"Agent Test School",
                        "plan":"ultra",
                        "active":true
                    }
                },
                "users": {}
            })
        ));
        (
            App {
                root: PathBuf::new(),
                web_root: PathBuf::new(),
                sample_data: PathBuf::new(),
                solver_pool: SolverPool::from_env(),
                agent_helper: AgentHelperCoordinator::new(),
                serverless: ServerlessCoordinator::new(Arc::clone(&db)),
                db,
            },
            token,
            SolverOwner::new("school-agent", "agent-admin"),
        )
    }

    fn agent_route(app: &App, token: Option<&str>, path: &str, value: Value) -> Vec<u8> {
        route(
            Request {
                method: "POST".to_string(),
                path: path.to_string(),
                query: String::new(),
                body: serde_json::to_vec(&value).unwrap(),
                auth_token: token.map(str::to_string),
                client_ip: "127.0.0.1".to_string(),
            },
            app,
        )
    }

    #[test]
    fn solver_telemetry_routes_require_session_and_return_aggregate_only() {
        let (app, school_token, _) = agent_test_app();
        let event_id = format!("fet-route-event-{}", now_millis());
        let event = json!({
            "eventId": event_id,
            "executor": "fet_web_worker",
            "focus": "singletons",
            "budgetKind": "local",
            "budgetSeconds": 12,
            "runtimeMs": 44,
            "outcome": "completed",
            "resultKind": "completed",
            "hardValid": true,
            "applied": true,
            "targetReached": true,
            "floorReached": true,
            "metricKey": "singletons",
            "metricBefore": 2,
            "metricAfter": 0,
            "metricDelta": 2,
            "targetMetric": 0,
            "floorMetric": 0
        });
        let unauthenticated = agent_route(&app, None, "/api/solver-telemetry/fet", event.clone());
        assert_eq!(response_status(&unauthenticated), 401);
        let accepted = agent_route(
            &app,
            Some(&school_token),
            "/api/solver-telemetry/fet",
            event.clone(),
        );
        assert_eq!(response_status(&accepted), 200);
        assert_eq!(response_payload(&accepted)["accepted"], json!(true));
        let duplicate = agent_route(
            &app,
            Some(&school_token),
            "/api/solver-telemetry/fet",
            event,
        );
        assert_eq!(response_status(&duplicate), 200);
        assert_eq!(response_payload(&duplicate)["duplicate"], json!(true));

        let school_read = route(
            Request {
                method: "GET".to_string(),
                path: "/api/admin/solver-telemetry".to_string(),
                query: "window=24h".to_string(),
                body: Vec::new(),
                auth_token: Some(school_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&school_read), 403);

        let superadmin_token = auth::create_session(
            &app.db,
            "telemetry-superadmin",
            &json!({"role":"superadmin","displayName":"Telemetry Super Admin"}),
        )
        .expect("superadmin session");
        let admin_read = route(
            Request {
                method: "GET".to_string(),
                path: "/api/admin/solver-telemetry".to_string(),
                query: "window=24h".to_string(),
                body: Vec::new(),
                auth_token: Some(superadmin_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&admin_read), 200);
        let response_text = String::from_utf8_lossy(&admin_read);
        assert!(!response_text.contains("fet-route-event-"));
        assert!(response_text.contains("byExecutorFocusBudget"));
        assert!(response_text.contains("aggregateOnly"));
    }

    #[test]
    fn infrastructure_profiles_and_google_usage_are_superadmin_only() {
        let (mut app, school_admin_token, _) = agent_test_app();
        let refresh_root = env::temp_dir().join(format!(
            "tkb-admin-refresh-{}-{}",
            std::process::id(),
            now_millis()
        ));
        app.root = refresh_root.clone();
        let superadmin_token = auth::create_session(
            &app.db,
            "infrastructure-superadmin",
            &json!({
                "role":"superadmin",
                "displayName":"Infrastructure Superadmin"
            }),
        )
        .expect("superadmin session");
        let school_user_token = auth::create_session(
            &app.db,
            "ordinary-user",
            &json!({
                "role":"school_user",
                "schoolId":"School-Agent",
                "displayName":"Ordinary User"
            }),
        )
        .expect("school user session");

        let read = |token: &str| {
            route(
                Request {
                    method: "GET".to_string(),
                    path: "/api/admin/solver-infrastructure".to_string(),
                    query: String::new(),
                    body: Vec::new(),
                    auth_token: Some(token.to_string()),
                    client_ip: "127.0.0.1".to_string(),
                },
                &app,
            )
        };
        assert_eq!(response_status(&read(&school_user_token)), 403);

        let config = json!({
            "mode":"auto",
            "fallback":"vps",
            "budgetUsd":300,
            "estimatedCostUsd":0.06,
            "activeProfileId":"primary",
            "accessToken":"must-not-persist",
            "profiles":[{
                "id":"primary",
                "url":"https://solver.example.run.app",
                "audience":"https://solver.example.run.app",
                "projectId":"example-project",
                "region":"asia-southeast1",
                "solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "serviceAccountKey":"must-not-persist"
            }]
        });
        let forbidden_school_write = route(
            Request {
                method: "POST".to_string(),
                path: "/api/admin/solver-infrastructure".to_string(),
                query: String::new(),
                body: serde_json::to_vec(&config).unwrap(),
                auth_token: Some(school_admin_token.clone()),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&forbidden_school_write), 403);
        assert!(app.db.get(serverless::CONFIG_KEY).unwrap().is_none());

        let written = route(
            Request {
                method: "POST".to_string(),
                path: "/api/admin/solver-infrastructure".to_string(),
                query: String::new(),
                body: serde_json::to_vec(&config).unwrap(),
                auth_token: Some(superadmin_token.clone()),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&written), 200);
        let stored = app
            .db
            .get(serverless::CONFIG_KEY)
            .unwrap()
            .expect("stored serverless config");
        assert!(!stored.contains("must-not-persist"));
        assert!(!stored.contains("attacker"));

        let school_usage = route(
            Request {
                method: "GET".to_string(),
                path: "/api/admin/solver-usage".to_string(),
                query: String::new(),
                body: Vec::new(),
                auth_token: Some(school_admin_token.clone()),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&school_usage), 403);

        let superadmin_usage = route(
            Request {
                method: "GET".to_string(),
                path: "/api/admin/solver-usage".to_string(),
                query: String::new(),
                body: Vec::new(),
                auth_token: Some(superadmin_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&superadmin_usage), 200);
        assert_eq!(response_payload(&superadmin_usage)["googleCloud"]["configured"], json!(false));

        let forbidden_refresh = route(
            Request {
                method: "POST".to_string(),
                path: "/api/admin/solver-usage/refresh".to_string(),
                query: String::new(),
                body: Vec::new(),
                auth_token: Some(school_admin_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&forbidden_refresh), 403);

        let superadmin_token = auth::create_session(
            &app.db,
            "infrastructure-refresh-superadmin",
            &json!({"role":"superadmin","displayName":"Refresh Superadmin"}),
        )
        .expect("refresh superadmin session");
        let refresh = route(
            Request {
                method: "POST".to_string(),
                path: "/api/admin/solver-usage/refresh".to_string(),
                query: String::new(),
                body: Vec::new(),
                auth_token: Some(superadmin_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&refresh), 202);
        assert_eq!(response_payload(&refresh)["refreshRequested"], json!(true));
        assert!(refresh_root
            .join("data")
            .join("google-cloud-usage-refresh.request")
            .is_file());
        let _ = fs::remove_dir_all(refresh_root);
    }

    #[test]
    fn ordinary_user_cannot_spoof_an_agent_executor_policy() {
        let (app, _, _) = agent_test_app();
        let user_token = auth::create_session(
            &app.db,
            "ordinary-solver-user",
            &json!({
                "role":"school_user",
                "schoolId":"School-Agent",
                "displayName":"Ordinary Solver User"
            }),
        )
        .expect("school user session");
        let mut request = async_preserved_request("ordinary-agent-spoof");
        request["settings"]["ui_agent_execution_policy"] = json!("web_agent_required");
        request["settings"]["ui_browser_wasm_ready"] = json!(true);
        request["settings"]["ui_browser_cpsat_ready"] = json!(true);
        let started = route(
            Request {
                method: "POST".to_string(),
                path: "/api/solve-data".to_string(),
                query: String::new(),
                body: serde_json::to_vec(&request).unwrap(),
                auth_token: Some(user_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("vps"));
        let job_id = response_payload(&started)["jobId"]
            .as_str()
            .expect("server job id")
            .to_string();
        let owner = SolverOwner::anonymous();
        app.solver_pool.cancel_job_for_owner(&job_id, &owner);
    }

    #[test]
    fn ordinary_user_vps_hint_cannot_bypass_configured_cloud_run() {
        let (app, _, _) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"auto",
                "fallback":"vps",
                "budgetUsd":300,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .expect("Cloud profile");
        let user_token = auth::create_session(
            &app.db,
            "ordinary-cloud-user",
            &json!({
                "role":"school_user",
                "schoolId":"School-Agent",
                "displayName":"Ordinary Cloud User"
            }),
        )
        .expect("school user session");
        let mut request = async_preserved_request("ordinary-cloud-vps-hint");
        request["settings"]["ui_agent_execution_policy"] = json!("vps_only");
        let started = route(
            Request {
                method: "POST".to_string(),
                path: "/api/solve-data".to_string(),
                query: String::new(),
                body: serde_json::to_vec(&request).unwrap(),
                auth_token: Some(user_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("serverless"));
        let job_id = response_payload(&started)["jobId"]
            .as_str()
            .expect("Cloud job id")
            .to_string();
        let owner = SolverOwner::anonymous();
        let _ = app.solver_pool.cancel_job_for_owner(&job_id, &owner);
        app.serverless.release_before_dispatch(&job_id);
    }

    #[test]
    fn explicit_hybrid_cloud_run_preempts_a_stale_privileged_vps_hint() {
        let (app, _, owner) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"auto",
                "fallback":"vps",
                "budgetUsd":300,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .expect("Cloud profile");
        let mut request = async_preserved_request("hybrid-cloud-stale-vps-hint");
        request["settings"]["ui_agent_execution_policy"] = json!("vps_only");
        request["settings"]["ui_hybrid_executor"] = json!("cloud_run");
        request["settings"]["ui_hybrid_deep_optimize"] = json!(false);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("serverless"));
        let _ = app
            .solver_pool
            .cancel_job_for_owner("hybrid-cloud-stale-vps-hint", &owner);
        app.serverless
            .release_before_dispatch("hybrid-cloud-stale-vps-hint");
    }

    #[test]
    fn serverless_only_without_a_profile_fails_closed_instead_of_using_vps() {
        let (app, _, _) = agent_test_app();
        app.db
            .set(
                serverless::CONFIG_KEY,
                &json!({
                    "mode":"serverless_only",
                    "fallback":"none",
                    "profiles":[]
                })
                .to_string(),
            )
            .unwrap();
        let user_token = auth::create_session(
            &app.db,
            "profileless-cloud-user",
            &json!({
                "role":"school_user",
                "schoolId":"School-Agent",
                "displayName":"Profileless Cloud User"
            }),
        )
        .expect("school user session");
        let request = async_preserved_request("profileless-serverless-only");
        let response = route(
            Request {
                method: "POST".to_string(),
                path: "/api/solve-data".to_string(),
                query: String::new(),
                body: serde_json::to_vec(&request).unwrap(),
                auth_token: Some(user_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&response), 503);
        assert_eq!(response_payload(&response)["kind"], json!("serverless_profile_unavailable"));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
    }

    #[test]
    fn explicit_hybrid_cloud_run_never_falls_back_to_a_vps_only_school_route() {
        let (app, _, _) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"vps_only",
                "fallback":"vps",
                "budgetUsd":300,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .expect("VPS-only profile");
        let user_token = auth::create_session(
            &app.db,
            "hybrid-cloud-route-user",
            &json!({
                "role":"school_user",
                "schoolId":"School-Agent",
                "displayName":"Hybrid Cloud Route User"
            }),
        )
        .expect("school user session");
        let mut request = async_preserved_request("hybrid-cloud-vps-only");
        request["settings"]["ui_hybrid_executor"] = json!("cloud_run");
        request["settings"]["ui_hybrid_deep_optimize"] = json!(false);
        request["settings"]["backend_deadline_ms"] = json!(999_000);
        let response = route(
            Request {
                method: "POST".to_string(),
                path: "/api/solve-data".to_string(),
                query: String::new(),
                body: serde_json::to_vec(&request).unwrap(),
                auth_token: Some(user_token),
                client_ip: "127.0.0.1".to_string(),
            },
            &app,
        );
        assert_eq!(response_status(&response), 503);
        let payload = response_payload(&response);
        assert_eq!(payload["kind"], json!("cloud_run_route_unavailable"));
        assert_eq!(payload["executor"], json!("cloud_run"));
        assert_eq!(payload["fallback"], json!(false));
        assert_eq!(payload["budgetSeconds"], json!(60));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
    }

    #[test]
    fn serverless_only_ignores_stale_admin_agent_requirements() {
        let (app, _, owner) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"serverless_only",
                "fallback":"none",
                "budgetUsd":300,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .unwrap();
        let request = native_required_automatic_request("serverless-only-stale-native");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("serverless"));
        let _ = app.solver_pool.cancel_job_for_owner(
            "serverless-only-stale-native",
            &owner,
        );
        app.serverless
            .release_before_dispatch("serverless-only-stale-native");
    }

    #[test]
    fn auto_cloud_run_preempts_stale_native_and_browser_agent_requirements() {
        let mut browser_request = browser_required_quick_request("auto-cloud-stale-browser");
        browser_request["settings"]["ui_browser_wasm_ready"] = json!(false);
        browser_request["settings"]["ui_browser_cpsat_ready"] = json!(false);
        for (job_id, request) in [
            (
                "auto-cloud-stale-native",
                native_required_automatic_request("auto-cloud-stale-native"),
            ),
            ("auto-cloud-stale-browser", browser_request),
        ] {
            let (app, _, owner) = agent_test_app();
            app.serverless
                .set_config(&json!({
                    "mode":"auto",
                    "fallback":"vps",
                    "budgetUsd":300,
                    "estimatedCostUsd":0.06,
                    "activeProfileId":"primary",
                    "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
                }))
                .expect("Auto Cloud profile");
            let blocker = app
                .solver_pool
                .try_acquire(
                    format!("{job_id}-vps-blocker"),
                    app.solver_pool.total_worker_tokens(),
                )
                .expect("exclusive VPS blocker");

            let started = solve_json(&app, request.to_string().as_bytes(), &owner);
            assert_eq!(response_status(&started), 202);
            assert_eq!(response_payload(&started)["executor"], json!("serverless"));
            assert_eq!(
                response_payload(&started)["executionPhase"],
                json!("serverless_queued")
            );
            let snapshot = app
                .solver_pool
                .server_job_snapshots_for_owner(&owner)
                .into_iter()
                .find(|snapshot| snapshot.job_id == job_id)
                .expect("Cloud-owned snapshot");
            assert!(!snapshot.native_agent_required);
            assert!(!snapshot.browser_agent_required);
            // The fake Cloud endpoint can fail before this snapshot is read,
            // so the fenced coordinator may already have advanced to its VPS
            // fallback. The synchronous 202 contract above proves Cloud won
            // admission; this assertion proves neither stale Agent lane can
            // reclaim the job during that asynchronous transition.
            assert_ne!(
                snapshot.execution_phase.executor(),
                Some(ServerExecutor::Agent)
            );

            let cancelled = solve_cancel_json(
                &app,
                format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
                &owner,
            );
            assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
            app.serverless.release_before_dispatch(job_id);
            drop(blocker);
        }
    }

    #[test]
    fn auto_cloud_ignores_legacy_zero_budget_and_still_uses_cloud_run() {
        let (app, _, owner) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"auto",
                "fallback":"vps",
                "budgetUsd":0,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .expect("Auto Cloud profile with legacy zero budget");
        let blocker = app
            .solver_pool
            .try_acquire(
                "auto-cloud-budget-fallback-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS blocker");
        let job_id = "auto-cloud-budget-stale-browser";
        let mut request = browser_required_quick_request(job_id);
        request["settings"]["ui_browser_wasm_ready"] = json!(false);
        request["settings"]["ui_browser_cpsat_ready"] = json!(false);

        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("serverless"));
        assert_eq!(
            response_payload(&started)["executionPhase"],
            json!("serverless_queued")
        );
        let snapshot = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("Cloud-owned snapshot");
        assert!(!snapshot.native_agent_required);
        assert!(!snapshot.browser_agent_required);
        assert_ne!(
            snapshot.execution_phase.executor(),
            Some(ServerExecutor::Agent)
        );
        assert!(app
            .serverless
            .usage_json_for_school(owner.school_id())
            .get("budgetEnforced")
            .is_none());

        let cancelled = solve_cancel_json(
            &app,
            format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        app.serverless.release_before_dispatch(job_id);
        drop(blocker);
    }

    #[test]
    fn cancelling_queued_cloud_job_releases_quota_before_coordinator_cleanup() {
        let (app, _, owner) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"auto",
                "fallback":"vps",
                "budgetUsd":0.10,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .unwrap();
        let job_id = "queued-cloud-cancel";
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        app.serverless
            .reserve_for_school(job_id, owner.school_id())
            .unwrap();
        app.solver_pool
            .prepare_serverless_execution(job_id, &owner)
            .expect("Cloud queue fence");
        assert_eq!(
            app.serverless
                .usage_json_for_school(owner.school_id())["activeReservations"],
            json!(1)
        );

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"queued-cloud-cancel"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        assert!(app.solver_pool.server_job_known_for_owner(job_id, &owner));
        let usage = app.serverless.usage_json_for_school(owner.school_id());
        assert_eq!(usage["activeReservations"], json!(0));
        assert!(usage.get("committedUsd").is_none());
        assert_eq!(usage["cancelledJobs"], json!(0));
        cleanup_server_owned_job(&app, job_id, &owner);
        assert!(!app.solver_pool.server_job_known_for_owner(job_id, &owner));
    }

    #[test]
    fn dispatched_cloud_cancel_reconciles_as_cancelled_not_completed() {
        let (app, _, owner) = agent_test_app();
        app.serverless
            .set_config(&json!({
                "mode":"auto",
                "fallback":"vps",
                "budgetUsd":1,
                "estimatedCostUsd":0.06,
                "activeProfileId":"primary",
                "profiles":[{"id":"primary","url":"https://solver.example.run.app","solverDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
            }))
            .unwrap();
        let job_id = "running-cloud-cancel";
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let fence = app
            .solver_pool
            .prepare_serverless_execution(job_id, &owner)
            .expect("Cloud fence");
        app.serverless
            .reserve_for_school(job_id, owner.school_id())
            .unwrap();
        assert!(app
            .solver_pool
            .mark_serverless_execution_running(fence, job_id, &owner));
        assert!(app.serverless.mark_dispatched(job_id));

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"running-cloud-cancel"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        assert!(app.solver_pool.server_job_known_for_owner(job_id, &owner));
        assert!(app.serverless.reconcile_outcome(
            job_id,
            Some(0.004),
            ReservationOutcome::Cancelled
        ));
        cleanup_server_owned_job(&app, job_id, &owner);

        let usage = app.serverless.usage_json_for_school(owner.school_id());
        assert_eq!(usage["activeReservations"], json!(0));
        assert_eq!(usage["cancelledJobs"], json!(1));
        assert_eq!(usage["completedJobs"], json!(0));
        assert_eq!(usage["failedJobs"], json!(0));
    }

    fn agent_get_route(app: &App, token: Option<&str>, path: &str) -> Vec<u8> {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        route(
            Request {
                method: "GET".to_string(),
                path: path.to_string(),
                query: query.to_string(),
                body: Vec::new(),
                auth_token: token.map(str::to_string),
                client_ip: "127.0.0.1".to_string(),
            },
            app,
        )
    }

    fn agent_protocol_body(value: Value) -> Value {
        let mut value = value;
        value["protocol"] = json!(AGENT_HELPER_PROTOCOL);
        if let Some(agent) = value.get_mut("agent").and_then(Value::as_object_mut) {
            let browser_platform = agent
                .get("platform")
                .and_then(Value::as_str)
                .is_some_and(agent_helper_browser_platform);
            if !browser_platform {
                // Current native workers must attest the exact packaged solver
                // snapshot. Keep the common HTTP fixture representative of a
                // real 1.6.33 hello/lease while allowing mismatch tests to
                // override either field explicitly (including with null).
                if !agent.contains_key("solverRuntimeVersion") {
                    agent.insert(
                        "solverRuntimeVersion".to_string(),
                        json!(NATIVE_SOLVER_RUNTIME_VERSION),
                    );
                }
                if !agent.contains_key("solverRuntimeDigest") {
                    agent.insert(
                        "solverRuntimeDigest".to_string(),
                        json!(NATIVE_SOLVER_RUNTIME_DIGEST),
                    );
                }
            }
        }
        value
    }

    fn agent_solver_request(job_id: &str) -> Value {
        json!({
            "data": {
                "lop": [{"id":"6A", "ten":"6A", "khoi":"6"}],
                "monhoc": [
                    {"id":"math", "ten":"Math"},
                    {"id":"literature", "ten":"Literature"}
                ],
                "mon": [
                    {"khoi":"6", "ten":"Math", "sotiet":1, "gioihan":1},
                    {"khoi":"6", "ten":"Literature", "sotiet":1, "gioihan":1}
                ],
                "pccmMatrix": {
                    "6A|Math":"Teacher 1",
                    "6A|Literature":"Teacher 2"
                },
                "pccmTietMatrix": {"6A|Math":1, "6A|Literature":1},
                "tkb": {
                    "6A": {
                        "thu2": {
                            "sang": [
                                {"mon":"Math", "fixed":true}, null, null, null, null
                            ]
                        }
                    }
                },
                "tkbLessonTeachers": {"6A|Math":"Teacher 1"}
            },
            "settings": {
                "solve_run_id": job_id,
                "require_complete_schedule":true,
                "native_skip_teacher_optimization":true
            }
        })
    }

    #[test]
    fn agent_result_tree_digest_matches_the_python_cross_language_vector() {
        let first: Value = serde_json::from_str(r#"{"a":1,"b":[1e-7,-0.0],"c":"đ"}"#).unwrap();
        let reordered: Value = serde_json::from_str(r#"{"c":"đ","b":[1e-7,-0.0],"a":1}"#).unwrap();
        assert_eq!(
            agent_helper_result_digest(&first).unwrap(),
            "08ff413feef63ffe43b690d4bccb07ce3dbf6cff38d312c9cfc32ed82a464a31"
        );
        assert_eq!(
            agent_helper_result_digest(&first).unwrap(),
            agent_helper_result_digest(&reordered).unwrap()
        );
        assert_ne!(
            agent_helper_result_digest(&json!({"value":1})).unwrap(),
            agent_helper_result_digest(&json!({"value":1.0})).unwrap()
        );
        assert_ne!(
            agent_helper_result_digest(&json!({"value":0.0})).unwrap(),
            agent_helper_result_digest(&json!({"value":-0.0})).unwrap()
        );
    }

    #[test]
    fn browser_checkpoint_progress_exposes_the_latest_focused_count() {
        let request = json!({
            "data": {
                "tkbSolverResult": {
                    "metrics": {"one_period_teacher_sessions":136}
                }
            },
            "settings": {"optimization_focus":"singletons"}
        });
        let body = serde_json::to_vec(&request).unwrap();
        let progress = agent_checkpoint_progress(
            &body,
            &json!({"metrics":{"one_period_teacher_sessions":134}}),
        )
        .expect("focused checkpoint progress");
        assert_eq!(progress["solveRequestMode"], json!("optimize_singletons"));
        assert_eq!(
            progress["optimizationFocus"],
            json!("one_period_teacher_sessions")
        );
        assert_eq!(progress["metricCurrent"], json!(134));
        assert_eq!(progress["metricBaseline"], json!(136));
        assert_eq!(progress["metricTarget"], json!(0));
        assert_eq!(progress["metricPercent"], json!(1.5));
    }

    #[test]
    fn browser_checkpoint_progress_keeps_the_click_baseline_without_incumbent_payload() {
        let request = json!({
            "data": {},
            "settings": {
                "optimization_focus":"singletons",
                "ui_progress_metric_focus":"one_period_teacher_sessions",
                "ui_progress_metric_current":58,
                "ui_progress_metric_target":0,
                "ui_progress_metric_baseline":58
            }
        });
        let body = serde_json::to_vec(&request).unwrap();
        let progress = agent_checkpoint_progress(
            &body,
            &json!({"metrics":{"one_period_teacher_sessions":53}}),
        )
        .expect("focused checkpoint progress");

        assert_eq!(
            progress["optimizationFocus"],
            json!("one_period_teacher_sessions")
        );
        assert_eq!(progress["metricCurrent"], json!(53));
        assert_eq!(progress["metricBaseline"], json!(58));
        assert_eq!(progress["metricPercent"], json!(8.6));
    }

    #[test]
    fn gap_checkpoint_uses_the_combined_quick_baseline() {
        let request = json!({
            "data": {
                "tkbSolverResult": {
                    "metrics": {
                        "teacher_gap2_sessions":2,
                        "gap_distribution":{"1":8, "2":2}
                    }
                }
            },
            "settings": {
                "optimization_focus":"gaps",
                "ui_progress_metric_focus":"teacher_gap_sessions",
                "ui_progress_metric_current":10,
                "ui_progress_metric_target":0,
                "ui_progress_metric_baseline":10,
                "ui_progress_gap1_baseline":8,
                "ui_progress_gap2_baseline":2
            }
        });
        let body = serde_json::to_vec(&request).unwrap();
        let progress = agent_checkpoint_progress(
            &body,
            &json!({
                "metrics": {
                    "teacher_gap2_sessions":2,
                    "gap_distribution":{"1":7, "2":2}
                }
            }),
        )
        .expect("gap checkpoint progress");

        assert_eq!(progress["optimizationFocus"], json!("teacher_gap_sessions"));
        assert_eq!(progress["metricCurrent"], json!(9));
        assert_eq!(progress["metricBaseline"], json!(10));
        assert_eq!(progress["metricPercent"], json!(10.0));
    }

    #[test]
    fn gap_checkpoint_keeps_gap2_and_gap1_progress_separate() {
        for (target, focus, current, baseline, expected_percent) in [
            ("gap2", "teacher_gap2_sessions", 2_i64, 4_i64, 50.0_f64),
            ("gap1", "teacher_gap1_sessions", 3_i64, 5_i64, 40.0_f64),
        ] {
            let request = json!({
                "data": {},
                "settings": {
                    "optimization_focus":"gaps",
                    "optimization_gap_target":target,
                    "ui_progress_metric_focus":focus,
                    "ui_progress_metric_current":baseline,
                    "ui_progress_metric_target":0,
                    "ui_progress_metric_baseline":baseline,
                    "ui_progress_gap1_baseline":5,
                    "ui_progress_gap2_baseline":4
                }
            });
            let body = serde_json::to_vec(&request).unwrap();
            let candidate = if target == "gap2" {
                json!({"metrics":{"gap_distribution":{"1":5,"2":2}}})
            } else {
                json!({"metrics":{"gap_distribution":{"1":3,"2":0}}})
            };
            let progress = agent_checkpoint_progress(&body, &candidate)
                .expect("focused gap checkpoint progress");
            assert_eq!(
                progress["solveRequestMode"],
                json!(format!("optimize_{target}"))
            );
            assert_eq!(progress["optimizationFocus"], json!(focus));
            assert_eq!(progress["metricCurrent"], json!(current));
            assert_eq!(progress["metricBaseline"], json!(baseline));
            assert_eq!(progress["metricPercent"], json!(expected_percent));
        }
    }

    #[test]
    fn bootstrap_issues_a_durable_agent_only_credential() {
        let (app, session_token, owner) = agent_test_app();
        let bootstrap = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/bootstrap",
            json!({}),
        );
        assert_eq!(response_status(&bootstrap), 200);
        let payload = response_payload(&bootstrap);
        let agent_token = payload["agentToken"]
            .as_str()
            .expect("limited Agent token")
            .to_string();
        assert!(agent_token.starts_with("tkba_"));
        assert_eq!(
            payload["downloadUrl"],
            json!("/downloads/TKBCherryAgent-Windows.zip")
        );
        assert_eq!(
            payload["installFileName"],
            json!("TKBCherryAgent-Windows.zip")
        );
        assert!(auth::require_session(&app.db, Some(&agent_token)).is_none());
        assert_eq!(
            auth::require_agent_credential(&app.db, Some(&agent_token))
                .and_then(|value| solver_owner_from_session(&value)),
            Some(owner)
        );
        assert!(solver_request_owner_with_requirement(&app.db, Some(&agent_token), true).is_err());

        let nested_bootstrap = agent_route(
            &app,
            Some(&agent_token),
            "/api/agent-helper/v1/bootstrap",
            json!({}),
        );
        assert_eq!(response_status(&nested_bootstrap), 401);

        let hello = agent_route(
            &app,
            Some(&agent_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"limited-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        assert!(response_payload(&hello)["workerToken"].is_string());
    }

    #[test]
    fn trusted_worker_handoff_requires_an_authenticated_free_lease_poll() {
        let _environment_lock = TRUSTED_AGENT_ENV_LOCK.lock().unwrap();
        let trusted_token = format!("{TRUSTED_AGENT_TOKEN_PREFIX}{}", "b".repeat(64));
        let trusted_digest = trusted_agent_token_digest(&trusted_token);
        let _environment = EnvironmentRestore::set(TRUSTED_AGENT_TOKEN_HASH_ENV, &trusted_digest);
        let (app, _session_token, _) = agent_test_app();
        let foreign_owner = SolverOwner::new("school-foreign", "foreign-admin");
        let mut blockers = Vec::new();
        while !app.solver_pool.at_capacity() {
            let blocker_id = format!("trusted-http-blocker-{}", blockers.len());
            blockers.push(
                app.solver_pool
                    .try_acquire(blocker_id, app.solver_pool.max_workers_per_job())
                    .expect("fill VPS capacity before testing trusted spillover"),
            );
        }
        assert_eq!(
            app.solver_pool
                .claim_server_job("trusted-queued-job", &foreign_owner),
            ServerJobClaim::Claimed
        );
        app.solver_pool
            .prepare_vps_execution("trusted-queued-job", &foreign_owner)
            .expect("queued VPS fence");
        assert_eq!(
            app.solver_pool
                .claim_server_job("trusted-queued-job-second", &foreign_owner),
            ServerJobClaim::Claimed
        );
        app.solver_pool
            .prepare_vps_execution("trusted-queued-job-second", &foreign_owner)
            .expect("second queued VPS fence");
        assert!(matches!(
            app.solver_pool.acquire_or_enqueue_for_owner(
                "trusted-queued-job".to_string(),
                app.solver_pool.min_workers_per_job(),
                foreign_owner.clone(),
            ),
            SolverAdmission::Queued { position: 1, .. }
        ));
        assert!(matches!(
            app.solver_pool.acquire_or_enqueue_for_owner(
                "trusted-queued-job-second".to_string(),
                app.solver_pool.min_workers_per_job(),
                foreign_owner.clone(),
            ),
            SolverAdmission::Queued { position: 2, .. }
        ));

        let hello = agent_route(
            &app,
            Some(&trusted_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent": {
                    "agentId":"trusted-worker-http",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"linux-amd64"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let hello = response_payload(&hello);
        assert_eq!(hello["handoffJobIds"], json!([]));
        let worker_token = hello["workerToken"]
            .as_str()
            .expect("trusted worker token")
            .to_string();
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("trusted-queued-job", &foreign_owner)
                .expect("queued snapshot")
                .phase,
            ServerExecutionPhase::VpsQueued
        );

        let rejected = agent_route(
            &app,
            Some(&trusted_token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":"invalid-worker-token",
                "leaseRequestId":"trusted-invalid-poll",
                "agent": {
                    "agentId":"trusted-worker-http",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"linux-amd64"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&rejected), 401);
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("trusted-queued-job", &foreign_owner)
                .expect("still queued after rejected poll")
                .phase,
            ServerExecutionPhase::VpsQueued
        );

        let poll = agent_route(
            &app,
            Some(&trusted_token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token.clone(),
                "leaseRequestId":"trusted-valid-poll",
                "agent": {
                    "agentId":"trusted-worker-http",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"linux-amd64"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&poll), 200);
        assert!(response_payload(&poll)["lease"].is_null());
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("trusted-queued-job", &foreign_owner)
                .expect("trusted handoff snapshot")
                .phase,
            ServerExecutionPhase::HandoffToAgent
        );
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("trusted-queued-job-second", &foreign_owner)
                .expect("second job remains queued")
                .phase,
            ServerExecutionPhase::VpsQueued
        );

        let replay = agent_route(
            &app,
            Some(&trusted_token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token.clone(),
                "leaseRequestId":"trusted-valid-poll",
                "agent": {
                    "agentId":"trusted-worker-http",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"linux-amd64"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&replay), 200);
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("trusted-queued-job-second", &foreign_owner)
                .expect("idempotent replay keeps second job queued")
                .phase,
            ServerExecutionPhase::VpsQueued
        );
    }

    #[test]
    fn browser_agent_status_is_authenticated_live_and_owner_scoped() {
        let (app, session_token, owner) = agent_test_app();
        let unauthorized = agent_get_route(&app, None, "/api/agent-helper/v1/status");
        assert_eq!(response_status(&unauthorized), 401);

        let offline = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(offline["online"], json!(false));
        assert_eq!(offline["agentCount"], json!(0));
        assert_eq!(offline["nativeOnline"], json!(false));
        assert_eq!(offline["nativeAgentCount"], json!(0));
        assert_eq!(offline["nativeRunning"], json!(false));
        assert_eq!(offline["nativeState"], json!("missing"));
        assert_eq!(offline["browserOnline"], json!(false));
        assert_eq!(offline["browserAgentCount"], json!(0));
        assert_eq!(offline["nativeTelemetry"], Value::Null);
        assert_eq!(offline["executionSource"], Value::Null);
        assert_eq!(offline["executionPhase"], Value::Null);

        let hello = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"status-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows-amd64"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);

        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("worker token")
            .to_string();
        let heartbeat = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/heartbeat",
            agent_protocol_body(json!({
                "agentId":"status-pc",
                "workerToken":worker_token,
                "status":"idle",
                "telemetry":{
                    "systemCpuPercent":71.26,
                    "systemRamPercent":63.04
                }
            })),
        );
        assert_eq!(response_status(&heartbeat), 200);

        let online = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(online["protocol"], json!(AGENT_HELPER_PROTOCOL));
        assert_eq!(online["online"], json!(true));
        assert_eq!(online["agentCount"], json!(1));
        assert_eq!(online["nativeOnline"], json!(true));
        assert_eq!(online["nativeAgentCount"], json!(1));
        assert_eq!(online["nativeRunning"], json!(true));
        assert_eq!(online["nativeState"], json!("online"));
        assert_eq!(online["agentId"], json!("status-pc"));
        assert_eq!(online["browserOnline"], json!(false));
        assert_eq!(online["browserAgentCount"], json!(0));
        assert_eq!(online["nativeTelemetry"]["systemCpuPercent"], json!(71.3));
        assert_eq!(online["nativeTelemetry"]["systemRamPercent"], json!(63.0));
        assert!(online["nativeTelemetry"]["sampledAtMs"].is_u64());
        assert!(online["nativeTelemetry"]["sampleAgeMs"].is_u64());
        assert_eq!(
            online["staleAfterMs"],
            json!(agent_helper::AGENT_WORKER_TTL_MS)
        );

        app.agent_helper
            .register_scoped_worker(
                &owner,
                "browser-status-binding",
                "web-status",
                "Web Status",
                1,
                "browser-status-job",
                now_millis(),
            )
            .unwrap();
        let mixed = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(mixed["online"], json!(true));
        assert_eq!(mixed["agentCount"], json!(2));
        assert_eq!(mixed["nativeAgentCount"], json!(1));
        assert_eq!(mixed["browserAgentCount"], json!(1));
        let mismatched = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status?agentId=other-pc",
        ));
        assert_eq!(mismatched["nativeOnline"], json!(false));
        assert_eq!(mismatched["nativeState"], json!("missing"));

        let other_token = auth::create_session(
            &app.db,
            "other-status-admin",
            &json!({
                "role":"school_admin",
                "schoolId":"Other-Status-School",
                "displayName":"Other Status Admin"
            }),
        )
        .expect("other status session");
        let other = response_payload(&agent_get_route(
            &app,
            Some(&other_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(other["online"], json!(false));
        assert_eq!(other["agentCount"], json!(0));
        assert_eq!(other["nativeTelemetry"], Value::Null);

        assert_eq!(
            app.solver_pool.claim_server_job("status-vps-job", &owner),
            ServerJobClaim::Claimed
        );
        app.solver_pool
            .prepare_vps_execution("status-vps-job", &owner)
            .expect("VPS status fence");
        let vps_status = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(vps_status["executionSource"], json!("vps"));
        assert_eq!(vps_status["executionPhase"], json!("vps_queued"));
        assert!(app.solver_pool.abandon_server_job("status-vps-job", &owner));

        assert_eq!(
            app.solver_pool.claim_server_job("status-agent-job", &owner),
            ServerJobClaim::Claimed
        );
        let agent_fence = app
            .solver_pool
            .prepare_agent_execution("status-agent-job", &owner)
            .expect("Agent status fence");
        assert!(app.solver_pool.mark_agent_execution_running(
            agent_fence,
            "status-agent-job",
            &owner
        ));
        let agent_status = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(agent_status["executionSource"], json!("agent"));
        assert_eq!(agent_status["executionPhase"], json!("agent_running"));
    }

    #[test]
    fn native_disabled_hello_is_running_but_stopped_and_defaults_back_to_enabled() {
        let (app, session_token, _owner) = agent_test_app();
        let paused_hello = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "enabled":false,
                "agent":{
                    "agentId":"paused-status-pc",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows-amd64"
                },
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&paused_hello), 200);
        let paused_payload = response_payload(&paused_hello);
        assert_eq!(paused_payload["agentEnabled"], json!(false));
        assert_eq!(paused_payload["agentEligible"], json!(false));
        assert_eq!(paused_payload["upgradeRequired"], json!(false));
        assert_eq!(paused_payload["handoffJobIds"], json!([]));

        let paused_status = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(paused_status["online"], json!(false));
        assert_eq!(paused_status["nativeOnline"], json!(false));
        assert_eq!(paused_status["nativeAgentCount"], json!(0));
        assert_eq!(paused_status["nativeRunning"], json!(true));
        assert_eq!(paused_status["nativeState"], json!("stopped"));

        let worker_token = paused_payload["workerToken"]
            .as_str()
            .expect("paused worker token");
        let heartbeat = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/heartbeat",
            agent_protocol_body(json!({
                "agentId":"paused-status-pc",
                "workerToken":worker_token,
                "status":"stopped"
            })),
        );
        assert_eq!(response_status(&heartbeat), 200);
        let after_heartbeat = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(after_heartbeat["nativeState"], json!("stopped"));

        // Compatibility contract: omitting `enabled` means ON, so an existing
        // native package continues to register exactly as it did before.
        let enabled_hello = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{
                    "agentId":"paused-status-pc",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows-amd64"
                },
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&enabled_hello), 200);
        let enabled_payload = response_payload(&enabled_hello);
        assert_eq!(enabled_payload["agentEnabled"], json!(true));
        assert_eq!(enabled_payload["agentEligible"], json!(true));
        let enabled_status = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(enabled_status["nativeOnline"], json!(true));
        assert_eq!(enabled_status["nativeRunning"], json!(true));
        assert_eq!(enabled_status["nativeState"], json!("online"));
    }

    #[test]
    fn agent_resource_telemetry_parser_is_optional_and_bounded() {
        assert_eq!(agent_helper_resource_telemetry(&json!({})), None);
        assert_eq!(
            agent_helper_resource_telemetry(&json!({
                "telemetry":{
                    "systemCpuPercent":-0.1,
                    "systemRamPercent":100.1
                }
            })),
            None
        );
        assert_eq!(
            agent_helper_resource_telemetry(&json!({
                "telemetry":{
                    "systemCpuPercent":42.26,
                    "systemRamPercent":"not-a-number"
                }
            })),
            Some(AgentResourceTelemetry {
                system_cpu_tenths: Some(423),
                system_ram_tenths: None,
            })
        );
    }

    #[test]
    fn browser_worker_cannot_take_over_a_fresh_or_incomplete_job() {
        let (app, session_token, owner) = agent_test_app();
        assert_eq!(
            app.solver_pool
                .claim_server_job("browser-fresh-job", &owner),
            ServerJobClaim::Claimed
        );
        app.solver_pool
            .prepare_vps_execution("browser-fresh-job", &owner)
            .expect("fresh job VPS fence");

        let hello = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":"browser-fresh-job",
                "agent":{"agentId":"web-fresh-worker","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":1,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 409);
        assert_eq!(
            response_payload(&hello)["kind"],
            json!("browser_wasm_refinement_required")
        );
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("browser-fresh-job", &owner)
                .expect("fresh job snapshot")
                .phase,
            ServerExecutionPhase::VpsQueued
        );
        assert_eq!(
            app.agent_helper.online_worker_count(&owner, now_millis()),
            0
        );
    }

    #[test]
    fn browser_worker_disconnect_requeues_its_lease_and_clears_online_status() {
        let (app, session_token, owner) = agent_test_app();
        assert_eq!(
            app.solver_pool
                .claim_server_job("browser-disconnect-job", &owner),
            ServerJobClaim::Claimed
        );
        app.solver_pool
            .prepare_vps_execution("browser-disconnect-job", &owner)
            .expect("browser job VPS fence");
        assert!(app.solver_pool.set_server_job_browser_wasm_eligible(
            "browser-disconnect-job",
            &owner,
            true,
        ));
        assert_eq!(
            app.solver_pool
                .claim_server_job("browser-other-job", &owner),
            ServerJobClaim::Claimed
        );
        app.solver_pool
            .prepare_vps_execution("browser-other-job", &owner)
            .expect("other job VPS fence");
        let hello = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":"browser-disconnect-job",
                "agent":{"agentId":"web-browser-worker","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":1,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("browser worker token")
            .to_string();
        assert_eq!(
            app.agent_helper.online_worker_count_for_job(
                &owner,
                "browser-disconnect-job",
                now_millis(),
            ),
            1
        );
        assert_eq!(
            app.agent_helper
                .online_worker_count_for_job(&owner, "browser-other-job", now_millis(),),
            0
        );
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("browser-disconnect-job", &owner)
                .expect("scoped handoff snapshot")
                .phase,
            ServerExecutionPhase::HandoffToAgent
        );
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot("browser-other-job", &owner)
                .expect("unrelated job snapshot")
                .phase,
            ServerExecutionPhase::VpsQueued
        );
        assert!(app.agent_helper.register_job(
            "browser-disconnect-job",
            &owner,
            Arc::new(serde_json::to_vec(&agent_solver_request("browser-disconnect-job")).unwrap()),
            1,
            now_millis(),
        ));
        assert!(app.agent_helper.register_job(
            "browser-other-job",
            &owner,
            Arc::new(serde_json::to_vec(&agent_solver_request("browser-other-job")).unwrap()),
            1,
            now_millis(),
        ));

        let lease = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token.clone(),
                "jobId":"browser-disconnect-job",
                "leaseRequestId":"browser-disconnect-request",
                "agent":{"agentId":"web-browser-worker","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":1,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&lease), 200);
        let lease_payload = response_payload(&lease);
        let lease_id = lease_payload["lease"]["leaseId"]
            .as_str()
            .expect("Browser lease id")
            .to_string();
        assert!(lease_payload["lease"].is_object());
        assert_eq!(
            lease_payload["lease"]["payload"]["settings"]["optimize_existing_schedule"],
            json!(true)
        );
        assert_eq!(
            lease_payload["lease"]["payload"]["settings"]["browser_wasm_refinement"],
            json!(true)
        );
        assert!(matches!(
            app.agent_helper
                .job_execution("browser-disconnect-job", &owner, now_millis()),
            Some(AgentJobExecution::Leased { .. })
        ));
        let binding = agent_session_binding(&session_token);
        let work_id = app
            .agent_helper
            .work_id_for_lease(&owner, &binding, &worker_token, &lease_id, now_millis())
            .expect("Browser leased work id");
        assert!(app
            .agent_helper
            .accept_checkpoint(
                &owner,
                &binding,
                &worker_token,
                &work_id,
                &lease_id,
                json!({"marker":"checkpoint-survives-disconnect"}),
                [0, 0, 1, 0],
                now_millis(),
            )
            .expect("disconnect checkpoint accepted"));

        let disconnected = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/disconnect",
            agent_protocol_body(json!({
                "agentId":"web-browser-worker",
                "workerToken":worker_token.clone()
            })),
        );
        assert_eq!(response_status(&disconnected), 200);
        assert_eq!(response_payload(&disconnected)["disconnected"], json!(true));
        assert!(matches!(
            app.agent_helper
                .job_execution("browser-disconnect-job", &owner, now_millis()),
            Some(AgentJobExecution::Checkpoint { .. })
        ));
        assert_eq!(
            app.agent_helper
                .best_candidate("browser-disconnect-job", &owner)
                .expect("disconnect must retain its accepted checkpoint")
                .payload["marker"],
            json!("checkpoint-survives-disconnect")
        );
        let status = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(status["online"], json!(false));

        let replay = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/disconnect",
            agent_protocol_body(json!({
                "agentId":"web-browser-worker",
                "workerToken":worker_token
            })),
        );
        assert_eq!(response_status(&replay), 401);
    }

    #[test]
    fn agent_capacity_allows_modern_high_core_windows_hosts() {
        assert_eq!(
            agent_helper_capacity(&json!({"capacity":{"cpuWorkers":22}})),
            22
        );
        assert_eq!(
            agent_helper_capacity(&json!({"capacity":{"cpuWorkers":999}})),
            999
        );
    }

    #[test]
    fn agent_helper_version_gate_uses_strict_three_component_semver() {
        for version in ["1.6.33", "1.7.0", "2.0.0"] {
            assert!(
                agent_helper_version_supported(version),
                "{version} should be eligible"
            );
        }
        for version in [
            "1.6.7",
            "1.6.8",
            "1.6.9",
            "1.6.10",
            "1.6.14",
            "1.6.15",
            "1.6.16",
            "1.6.17",
            "1.6.18",
            "1.6.19",
            "1.6.20",
            "1.6.22",
            "1.6.23",
            "1.6.29",
            "1.6.30",
            "1.6.31",
            "1.6.32",
            "1.6",
            "1.6.8-beta",
            "",
            "not-a-version",
            "01.6.8",
            "1.06.8",
            "1.6.08",
            "1.6.8.0",
        ] {
            assert!(
                !agent_helper_version_supported(version),
                "{version:?} should not be eligible"
            );
        }
        assert_eq!(parse_agent_helper_semver(" 1.6.8 "), Some((1, 6, 8)));
        assert!(agent_helper_version_supported_for_platform(
            "1.6.32",
            "web-cpsat-wasm"
        ));
        assert!(!agent_helper_version_supported_for_platform(
            "1.6.31",
            "web-cpsat-wasm"
        ));
    }

    #[test]
    fn old_agent_stays_upgrade_only_without_handing_a_vps_job_over() {
        let (app, token, owner) = agent_test_app();
        assert_eq!(
            app.solver_pool
                .claim_server_job("old-agent-keeps-vps-owner", &owner),
            ServerJobClaim::Claimed
        );
        let vps_fence = app
            .solver_pool
            .prepare_vps_execution("old-agent-keeps-vps-owner", &owner)
            .expect("VPS execution fence");
        assert_eq!(vps_fence.executor, ServerExecutor::Vps);
        let before = app
            .solver_pool
            .server_execution_snapshot("old-agent-keeps-vps-owner", &owner)
            .expect("VPS execution snapshot");

        let old_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"upgrade-only-pc","version":"1.6.7","platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&old_hello), 200);
        let old_payload = response_payload(&old_hello);
        assert_eq!(old_payload["agentEligible"], json!(false));
        assert_eq!(old_payload["upgradeRequired"], json!(true));
        assert_eq!(
            old_payload["minimumAgentVersion"],
            json!(MIN_AGENT_HELPER_VERSION)
        );
        assert_eq!(old_payload["handoffJobIds"], json!([]));
        assert_eq!(
            app.agent_helper.online_worker_count(&owner, now_millis()),
            0
        );
        let old_status = response_payload(&agent_get_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(old_status["nativeOnline"], json!(false));
        assert_eq!(old_status["nativeRunning"], json!(false));
        assert_eq!(old_status["nativeState"], json!("missing"));
        let after = app
            .solver_pool
            .server_execution_snapshot("old-agent-keeps-vps-owner", &owner)
            .expect("unchanged VPS execution snapshot");
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.phase, before.phase);

        let old_worker_token = old_payload["workerToken"].as_str().unwrap().to_string();
        let old_lease = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":old_worker_token,
                "leaseRequestId":"upgrade-only-request-0001",
                "agent":{"agentId":"upgrade-only-pc","version":"1.6.7","platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&old_lease), 200);
        assert_eq!(response_payload(&old_lease)["lease"], Value::Null);
        assert_eq!(response_payload(&old_lease)["upgradeRequired"], json!(true));
        let old_heartbeat = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/heartbeat",
            agent_protocol_body(json!({
                "workerToken":old_worker_token,
                "agentId":"upgrade-only-pc",
                "status":"idle"
            })),
        );
        assert_eq!(response_status(&old_heartbeat), 200);
        let old_heartbeat_payload = response_payload(&old_heartbeat);
        assert_eq!(old_heartbeat_payload["executionSource"], json!("vps"));
        assert_eq!(old_heartbeat_payload["executionPhase"], json!("vps_queued"));

        let explicitly_paused_upgrade = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "enabled":false,
                "agent":{"agentId":"upgrade-only-pc","version":"1.6.7","platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&explicitly_paused_upgrade), 200);
        let explicitly_paused_payload = response_payload(&explicitly_paused_upgrade);
        assert_eq!(explicitly_paused_payload["upgradeRequired"], json!(true));
        assert_eq!(explicitly_paused_payload["agentEligible"], json!(false));
        assert_eq!(explicitly_paused_payload["agentEnabled"], json!(false));
        let explicitly_paused_status = response_payload(&agent_get_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(explicitly_paused_status["nativeOnline"], json!(false));
        assert_eq!(explicitly_paused_status["nativeRunning"], json!(true));
        assert_eq!(explicitly_paused_status["nativeState"], json!("stopped"));

        let current_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"upgrade-only-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&current_hello), 200);
        let current_payload = response_payload(&current_hello);
        assert_eq!(current_payload["agentEligible"], json!(true));
        assert_eq!(
            current_payload["handoffJobIds"],
            json!(["old-agent-keeps-vps-owner"])
        );
        app.solver_pool
            .abandon_server_job("old-agent-keeps-vps-owner", &owner);
    }

    #[test]
    fn native_agent_rejects_a_claimed_solver_runtime_mismatch() {
        let (app, token, owner) = agent_test_app();
        let mismatched = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent": {
                    "agentId":"runtime-mismatch-pc",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows-amd64",
                    "solverRuntimeVersion":NATIVE_SOLVER_RUNTIME_VERSION,
                    "solverRuntimeDigest":"0".repeat(64)
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&mismatched), 200);
        let mismatched_payload = response_payload(&mismatched);
        assert_eq!(mismatched_payload["agentEligible"], json!(false));
        assert_eq!(mismatched_payload["upgradeRequired"], json!(true));
        assert_eq!(
            mismatched_payload["solverRuntimeDigest"],
            json!(NATIVE_SOLVER_RUNTIME_DIGEST)
        );
        assert_eq!(
            app.agent_helper.online_worker_count(&owner, now_millis()),
            0
        );

        let matching = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent": {
                    "agentId":"runtime-mismatch-pc",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows-amd64",
                    "solverRuntimeVersion":NATIVE_SOLVER_RUNTIME_VERSION,
                    "solverRuntimeDigest":NATIVE_SOLVER_RUNTIME_DIGEST
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&matching), 200);
        assert_eq!(response_payload(&matching)["agentEligible"], json!(true));
        assert_eq!(
            app.agent_helper.online_worker_count(&owner, now_millis()),
            1
        );
    }

    #[test]
    fn downgraded_lease_revokes_the_agent_and_falls_back_to_vps() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"downgraded-lease-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .unwrap()
            .to_string();

        let request = async_preserved_request("downgraded-agent-fallback");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));
        let leased = (0..5)
            .find_map(|attempt| {
                let response = agent_route(
                    &app,
                    Some(&token),
                    "/api/agent-helper/v1/lease",
                    agent_protocol_body(json!({
                        "workerToken":worker_token.clone(),
                        "leaseRequestId":format!("downgraded-current-request-{attempt:04}"),
                        "agent":{"agentId":"downgraded-lease-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                        "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                        "waitSeconds":1
                    })),
                );
                (response_payload(&response)["lease"]["jobId"]
                    == json!("downgraded-agent-fallback"))
                .then_some(response)
            })
            .expect("canonical Agent lease should become available");
        assert_eq!(response_status(&leased), 200);
        assert_eq!(
            response_payload(&leased)["lease"]["jobId"],
            json!("downgraded-agent-fallback")
        );

        let downgraded = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"downgraded-old-request-0002",
                "agent":{"agentId":"downgraded-lease-pc","version":"1.6.7","platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&downgraded), 426);
        let downgraded_payload = response_payload(&downgraded);
        assert_eq!(downgraded_payload["kind"], json!("agent_upgrade_required"));
        assert_eq!(
            downgraded_payload["minimumAgentVersion"],
            json!(MIN_AGENT_HELPER_VERSION)
        );
        assert_eq!(
            app.agent_helper.online_worker_count(&owner, now_millis()),
            0
        );

        let completed = wait_for_server_result(&app, "downgraded-agent-fallback", &owner);
        assert_eq!(response_status(&completed), 200);
        assert!(app
            .solver_pool
            .completed_server_response_for_owner("downgraded-agent-fallback", &owner)
            .is_some());
        app.solver_pool
            .abandon_server_job("downgraded-agent-fallback", &owner);
    }

    #[test]
    fn device_pairing_requires_browser_approval_and_delivers_only_an_agent_credential() {
        let (app, session_token, owner) = agent_test_app();
        let started = agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/start",
            agent_protocol_body(json!({
                "agent": {
                    "agentId":"pairing-pc",
                    "name":"Máy phòng giáo vụ",
                    "version":"0.2.0",
                    "platform":"windows"
                }
            })),
        );
        assert_eq!(response_status(&started), 200);
        let started_payload = response_payload(&started);
        assert_eq!(started_payload["status"], json!("pending"));
        assert_eq!(started_payload["agentId"], json!("pairing-pc"));
        assert_eq!(started_payload["agentName"], json!("Máy phòng giáo vụ"));
        assert!(started_payload["deviceCode"]
            .as_str()
            .is_some_and(|value| value.starts_with("tkbp_") && value.len() == 69));
        assert!(started_payload["userCode"]
            .as_str()
            .is_some_and(|value| value.len() == 9 && value.as_bytes()[4] == b'-'));
        assert!(started_payload["verificationUriComplete"]
            .as_str()
            .is_some_and(|value| value.contains("agentPair=")));
        assert_eq!(
            started_payload["verificationUrl"],
            started_payload["verificationUriComplete"]
        );
        assert!(started_payload.get("agentToken").is_none());

        let device_code = started_payload["deviceCode"].as_str().unwrap().to_string();
        let user_code = started_payload["userCode"].as_str().unwrap().to_string();
        let pending = agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/status",
            agent_protocol_body(json!({"deviceCode":device_code})),
        );
        assert_eq!(response_status(&pending), 200);
        assert_eq!(response_payload(&pending)["status"], json!("pending"));
        assert!(response_payload(&pending).get("agentToken").is_none());

        let approval_body = agent_protocol_body(json!({"userCode":user_code}));
        let anonymous_approval = agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/approve",
            approval_body.clone(),
        );
        assert_eq!(response_status(&anonymous_approval), 401);

        let session = auth::require_session(&app.db, Some(&session_token)).unwrap();
        let (old_agent_token, _) = auth::create_agent_credential(&app.db, &session).unwrap();
        let agent_approval = agent_route(
            &app,
            Some(&old_agent_token),
            "/api/agent-helper/v1/pair/approve",
            approval_body.clone(),
        );
        assert_eq!(response_status(&agent_approval), 401);

        let approved = agent_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/pair/approve",
            approval_body.clone(),
        );
        assert_eq!(response_status(&approved), 200);
        let approved_payload = response_payload(&approved);
        assert_eq!(approved_payload["status"], json!("approved"));
        assert_eq!(approved_payload["agentId"], json!("pairing-pc"));
        assert!(approved_payload.get("agentToken").is_none());

        let paired = agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/status",
            agent_protocol_body(json!({"deviceCode":device_code})),
        );
        assert_eq!(response_status(&paired), 200);
        let paired_payload = response_payload(&paired);
        assert_eq!(paired_payload["status"], json!("approved"));
        let paired_token = paired_payload["agentToken"]
            .as_str()
            .expect("paired limited credential");
        assert!(paired_token.starts_with("tkba_"));
        assert!(auth::require_session(&app.db, Some(paired_token)).is_none());
        assert_eq!(
            auth::require_agent_credential(&app.db, Some(paired_token))
                .and_then(|value| solver_owner_from_session(&value)),
            Some(owner)
        );

        let other_session = auth::create_session(
            &app.db,
            "other-pair-admin",
            &json!({
                "role":"school_admin",
                "schoolId":"Other-Pair-School",
                "displayName":"Other Pair Admin"
            }),
        )
        .unwrap();
        let cross_owner_reapproval = agent_route(
            &app,
            Some(&other_session),
            "/api/agent-helper/v1/pair/approve",
            approval_body,
        );
        assert_eq!(response_status(&cross_owner_reapproval), 409);
        assert_eq!(
            response_payload(&cross_owner_reapproval)["kind"],
            json!("agent_pair_already_approved")
        );
        let paired_again = response_payload(&agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/status",
            agent_protocol_body(json!({"deviceCode":device_code})),
        ));
        assert_eq!(paired_again["agentToken"], json!(paired_token));
    }

    #[test]
    fn device_pairing_rejects_short_codes_as_status_secrets_and_invalid_agents() {
        let (app, _, _) = agent_test_app();
        let invalid_agent = agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/start",
            agent_protocol_body(json!({"agent":{"agentId":"bad id with spaces"}})),
        );
        assert_eq!(response_status(&invalid_agent), 400);
        assert_eq!(
            response_payload(&invalid_agent)["kind"],
            json!("agent_pair_invalid")
        );

        let short_secret = agent_route(
            &app,
            None,
            "/api/agent-helper/v1/pair/status",
            agent_protocol_body(json!({"deviceCode":"ABCD-EFGH"})),
        );
        assert_eq!(response_status(&short_secret), 400);
        assert_eq!(
            response_payload(&short_secret)["kind"],
            json!("agent_pair_invalid")
        );
    }

    #[test]
    fn lease_request_id_replay_returns_the_exact_active_lease_over_http() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"replay-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .unwrap()
            .to_string();
        let request_body =
            Arc::new(serde_json::to_vec(&agent_solver_request("agent-replay-job")).unwrap());
        assert!(app.agent_helper.register_job(
            "agent-replay-job",
            &owner,
            request_body,
            1,
            now_millis(),
        ));
        let lease_body = agent_protocol_body(json!({
            "workerToken":worker_token,
            "leaseRequestId":"be672948-35a1-4619-a133-6548a61bb834",
            "agent":{"agentId":"replay-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
            "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1},
            "waitSeconds":0
        }));
        let first = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            lease_body.clone(),
        );
        let replay = agent_route(&app, Some(&token), "/api/agent-helper/v1/lease", lease_body);
        assert_eq!(response_status(&first), 200);
        assert_eq!(response_status(&replay), 200);
        let first_lease = response_payload(&first)["lease"].clone();
        let replay_lease = response_payload(&replay)["lease"].clone();
        assert_eq!(replay_lease["leaseId"], first_lease["leaseId"]);
        assert_eq!(replay_lease["jobId"], first_lease["jobId"]);
        assert_eq!(replay_lease["attempt"], json!(1));
        assert_eq!(
            replay_lease["leaseExpiresAtMs"],
            first_lease["leaseExpiresAtMs"]
        );
        assert_eq!(replay_lease["payload"], first_lease["payload"]);

        let distinct_request = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"be672948-35a1-4619-a133-6548a61bb835",
                "agent":{"agentId":"replay-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&distinct_request), 429);
        assert_eq!(
            response_payload(&distinct_request)["kind"],
            json!("agent_worker_at_capacity")
        );

        let missing_request_id = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agent":{"agentId":"replay-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&missing_request_id), 400);
        assert_eq!(
            response_payload(&missing_request_id)["kind"],
            json!("agent_lease_request_invalid")
        );
        app.agent_helper.finish_job("agent-replay-job", &owner);
    }

    #[test]
    fn agent_helper_routes_require_a_session_and_keep_candidates_job_scoped() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_protocol_body(json!({
            "agent":{"agentId":"pc-1","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
            "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
        }));
        let unauthorized = agent_route(&app, None, "/api/agent-helper/v1/hello", hello.clone());
        assert_eq!(response_status(&unauthorized), 401);

        let registered = agent_route(&app, Some(&token), "/api/agent-helper/v1/hello", hello);
        assert_eq!(response_status(&registered), 200);
        let worker_token = response_payload(&registered)["workerToken"]
            .as_str()
            .expect("worker token")
            .to_string();

        let mut request = agent_solver_request("agent-route-job");
        request["settings"]["optimization_focus"] = json!("singletons");
        request["data"]["tkbSolverResult"] = json!({
            "metrics":{"one_period_teacher_sessions":4}
        });
        let request_body = Arc::new(serde_json::to_vec(&request).unwrap());
        assert_eq!(
            app.solver_pool.claim_server_job("agent-route-job", &owner),
            ServerJobClaim::Claimed
        );
        let agent_fence = app
            .solver_pool
            .prepare_agent_execution("agent-route-job", &owner)
            .expect("Agent execution fence");
        assert!(app.solver_pool.mark_agent_execution_running(
            agent_fence,
            "agent-route-job",
            &owner
        ));
        assert!(app.agent_helper.register_job(
            "agent-route-job",
            &owner,
            Arc::clone(&request_body),
            1,
            now_millis(),
        ));
        let lease_response = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"route-lease-request-0001",
                "agent":{"agentId":"pc-1","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&lease_response), 200);
        let lease_payload = response_payload(&lease_response);
        let lease_id = lease_payload["lease"]["leaseId"]
            .as_str()
            .expect("lease id")
            .to_string();
        assert_eq!(lease_payload["lease"]["jobId"], json!("agent-route-job"));
        assert_eq!(
            lease_payload["lease"]["payload"]["settings"]["ui_solver_async_job"],
            json!(false)
        );
        assert_eq!(
            lease_payload["lease"]["payload"]["settings"]["ui_solver_fifo_admission"],
            json!(false)
        );

        let other_token = auth::create_session(
            &app.db,
            "other-agent-admin",
            &json!({
                "role":"school_admin",
                "schoolId":"Other-School",
                "displayName":"Other Agent Admin"
            }),
        )
        .expect("other agent session");
        let cross_owner = agent_route(
            &app,
            Some(&other_token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/heartbeat"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"pc-1",
                "jobId":"agent-route-job",
                "leaseId":lease_id
            })),
        );
        assert_eq!(response_status(&cross_owner), 401);

        let heartbeat = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/heartbeat"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"pc-1",
                "jobId":"agent-route-job",
                "leaseId":lease_id
            })),
        );
        assert_eq!(response_status(&heartbeat), 200);
        assert_eq!(response_payload(&heartbeat)["renewed"], json!(true));

        let native = native_solver::solve_native_hint_json(Path::new(""), &request_body, None)
            .expect("native solver")
            .expect("native result");
        assert_eq!(native.status, 200);
        let result: Value = serde_json::from_str(&native.payload).unwrap();
        let digest = agent_helper_result_digest(&result).unwrap();
        let checkpoint = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/checkpoint"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"pc-1",
                "jobId":"agent-route-job",
                "leaseId":lease_id,
                "sha256":digest,
                "digestProtocol":AGENT_RESULT_DIGEST_PROTOCOL,
                "solverProtocol":REFERENCE_STDIO_PROTOCOL,
                "solverStatus":native.status,
                "result":result.clone()
            })),
        );
        assert_eq!(response_status(&checkpoint), 202);
        assert!(matches!(
            app.agent_helper
                .job_execution("agent-route-job", &owner, now_millis()),
            Some(AgentJobExecution::Leased { .. })
        ));
        let progress = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|job| job.job_id == "agent-route-job")
            .and_then(|job| job.progress)
            .expect("checkpoint progress");
        assert_eq!(progress["stage"], json!("browser_agent:checkpoint"));
        assert_eq!(progress["protocol"], json!(REFERENCE_PROGRESS_PROTOCOL));
        assert_eq!(progress["sequence"], json!(1));
        assert!(progress["elapsedMs"].as_u64().is_some());
        assert_eq!(progress["solveRequestMode"], json!("optimize_singletons"));
        assert_eq!(
            progress["metricCurrent"],
            result["metrics"]["one_period_teacher_sessions"]
        );
        let candidate = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/candidate"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"pc-1",
                "jobId":"agent-route-job",
                "leaseId":lease_id,
                "sha256":digest,
                "digestProtocol":AGENT_RESULT_DIGEST_PROTOCOL,
                "solverProtocol":REFERENCE_STDIO_PROTOCOL,
                "solverStatus":native.status,
                "result":result
            })),
        );
        assert_eq!(response_status(&candidate), 202);
        let candidate_payload = response_payload(&candidate);
        assert!(candidate_payload["candidateId"].is_string());
        assert!(app
            .agent_helper
            .best_candidate("agent-route-job", &owner)
            .is_some());
        assert!(app
            .solver_pool
            .completed_server_response_for_owner("agent-route-job", &owner)
            .is_none());

        let complete = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/complete"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"pc-1",
                "jobId":"agent-route-job",
                "leaseId":lease_id,
                "candidateId":candidate_payload["candidateId"],
                "sha256":candidate_payload["sha256"],
                "solverStatus":200
            })),
        );
        assert_eq!(response_status(&complete), 202);

        app.agent_helper.finish_job("agent-route-job", &owner);
        app.solver_pool
            .abandon_server_job("agent-route-job", &owner);
    }

    #[test]
    fn structured_solver_409_422_and_500_outcomes_are_accepted_without_requeue() {
        let (app, token, owner) = agent_test_app();
        let registered = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"outcome-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        let worker_token = response_payload(&registered)["workerToken"]
            .as_str()
            .unwrap()
            .to_string();
        let binding = agent_session_binding(&token);

        for solver_status in [409_u64, 422, 500] {
            let job_id = format!("agent-structured-{solver_status}");
            let request_body =
                Arc::new(serde_json::to_vec(&agent_solver_request(&job_id)).unwrap());
            assert_eq!(
                app.solver_pool.claim_server_job(&job_id, &owner),
                ServerJobClaim::Claimed
            );
            assert!(app
                .agent_helper
                .register_job(&job_id, &owner, request_body, 1, now_millis(),));
            let leased = agent_route(
                &app,
                Some(&token),
                "/api/agent-helper/v1/lease",
                agent_protocol_body(json!({
                    "workerToken":worker_token,
                    "leaseRequestId":format!("structured-request-{solver_status}"),
                    "agent":{"agentId":"outcome-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                    "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1},
                    "waitSeconds":0
                })),
            );
            assert_eq!(response_status(&leased), 200);
            let lease_id = response_payload(&leased)["lease"]["leaseId"]
                .as_str()
                .unwrap()
                .to_string();
            let result = json!({
                "ok":false,
                "kind":"reference_solver_structured_outcome",
                "error":format!("reference solver returned {solver_status}"),
                "details":{"solverStatus":solver_status}
            });
            let digest = agent_helper_result_digest(&result).unwrap();
            let accepted = agent_route(
                &app,
                Some(&token),
                &format!("/api/agent-helper/v1/leases/{lease_id}/candidate"),
                agent_protocol_body(json!({
                    "workerToken":worker_token,
                    "agentId":"outcome-pc",
                    "jobId":job_id,
                    "leaseId":lease_id,
                    "sha256":digest,
                    "digestProtocol":AGENT_RESULT_DIGEST_PROTOCOL,
                    "solverProtocol":REFERENCE_STDIO_PROTOCOL,
                    "solverStatus":solver_status,
                    "result":result
                })),
            );
            assert_eq!(response_status(&accepted), 202);
            let accepted_payload = response_payload(&accepted);
            assert_eq!(accepted_payload["solverStatus"], json!(solver_status));
            assert_eq!(accepted_payload["becameBest"], json!(false));
            assert!(accepted_payload["candidateId"].is_string());
            assert!(app.agent_helper.best_candidate(&job_id, &owner).is_none());
            assert!(matches!(
                app.agent_helper
                    .claim_work(&owner, &binding, &worker_token, now_millis(),),
                Err(AgentHelperError::NoWork)
            ));

            let completed = agent_route(
                &app,
                Some(&token),
                &format!("/api/agent-helper/v1/leases/{lease_id}/complete"),
                agent_protocol_body(json!({
                    "workerToken":worker_token,
                    "agentId":"outcome-pc",
                    "jobId":job_id,
                    "leaseId":lease_id,
                    "candidateId":accepted_payload["candidateId"],
                    "sha256":digest,
                    "solverStatus":solver_status
                })),
            );
            assert_eq!(response_status(&completed), 202);
            assert!(app.agent_helper.finish_job(&job_id, &owner));
            app.solver_pool.abandon_server_job(&job_id, &owner);
        }
    }

    #[test]
    fn health_reports_aggregate_solver_capacity_without_job_or_owner_details() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };

        let payload = response_payload(&health_json(&app));
        let total = payload["solverWorkerTokensTotal"]
            .as_u64()
            .expect("total worker tokens");
        assert!(total > 0);
        assert_eq!(payload["solverWorkerTokensAllocated"], json!(0));
        assert_eq!(payload["solverWorkerTokensAvailable"], json!(total));
        assert_eq!(payload["solverQueuedJobs"], json!(0));
        let helpers = &payload["agentReferenceHelpers"];
        let helper_limit = helpers["limit"].as_u64().expect("helper limit");
        let helper_active = helpers["active"].as_u64().expect("active helpers");
        let builders = helpers["modelBuildersActive"]
            .as_u64()
            .expect("active model builders");
        let validators = helpers["candidateValidatorsActive"]
            .as_u64()
            .expect("active candidate validators");
        assert!(helper_limit > 0);
        assert_eq!(helper_active, builders + validators);
        assert!(helpers["peakActive"].as_u64().unwrap_or(0) >= helper_active);
        assert!(helpers["waiting"].is_u64());
        assert!(helpers["starts"].is_u64());
        assert!(helpers["admissionTimeouts"].is_u64());
        assert!(payload.get("jobs").is_none());
        assert!(payload.get("queue").is_none());
        assert!(payload.get("owner").is_none());
    }

    #[test]
    fn reference_helper_processes_share_one_bounded_admission_pool() {
        let limiter = Box::leak(Box::new(ReferenceHelperProcessLimiter::new(2)));
        let builder = limiter
            .acquire(ReferenceHelperKind::ModelBuilder, Duration::from_millis(5))
            .expect("first helper permit");
        let validator = limiter
            .acquire(
                ReferenceHelperKind::CandidateValidator,
                Duration::from_millis(5),
            )
            .expect("second helper permit");
        assert!(limiter
            .acquire(ReferenceHelperKind::ModelBuilder, Duration::from_millis(5))
            .is_none());
        let saturated = limiter.snapshot();
        assert_eq!(saturated.limit, 2);
        assert_eq!(saturated.active, 2);
        assert_eq!(saturated.model_builders_active, 1);
        assert_eq!(saturated.candidate_validators_active, 1);
        assert_eq!(saturated.peak_active, 2);
        assert_eq!(saturated.admission_timeouts, 1);

        drop(validator);
        let replacement = limiter
            .acquire(ReferenceHelperKind::ModelBuilder, Duration::from_millis(5))
            .expect("released capacity must be reusable");
        let reused = limiter.snapshot();
        assert_eq!(reused.active, 2);
        assert_eq!(reused.model_builders_active, 2);
        assert_eq!(reused.candidate_validators_active, 0);
        assert_eq!(reused.starts, 3);
        drop(replacement);
        drop(builder);
        assert_eq!(limiter.snapshot().active, 0);
    }

    #[test]
    fn solver_state_and_cancel_are_scoped_to_the_authenticated_owner() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner_a = SolverOwner::new("school-a", "admin-a");
        let owner_b = SolverOwner::new("school-b", "admin-b");
        let running = app
            .solver_pool
            .try_acquire_for_owner("private-job".to_string(), 2, owner_a.clone())
            .expect("owner A active job");

        let state_a = response_payload(&solver_state_json(&app, "", &owner_a));
        let requested_state_a =
            response_payload(&solver_state_json(&app, "jobId=private-job", &owner_a));
        let state_b = response_payload(&solver_state_json(&app, "", &owner_b));
        assert_eq!(state_a["jobs"].as_array().map(Vec::len), Some(1));
        assert_eq!(requested_state_a["requestedJobActive"], json!(true));
        assert_eq!(state_b["jobs"].as_array().map(Vec::len), Some(0));

        let cancel_body = br#"{"jobId":"private-job"}"#;
        let wrong_cancel = response_payload(&solve_cancel_json(&app, cancel_body, &owner_b));
        assert_eq!(wrong_cancel["cancelRequested"], json!(false));
        assert!(!running.job.cancel_requested.load(Ordering::SeqCst));

        let owner_cancel = response_payload(&solve_cancel_json(&app, cancel_body, &owner_a));
        assert_eq!(owner_cancel["cancelRequested"], json!(true));
        assert!(running.job.cancel_requested.load(Ordering::SeqCst));
    }

    #[test]
    fn retain_best_stop_is_owner_scoped_and_keeps_the_canonical_job_alive() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("school-a", "admin-a");
        let other_owner = SolverOwner::new("school-b", "admin-b");
        assert_eq!(
            app.solver_pool.claim_server_job("keep-best", &owner),
            ServerJobClaim::Claimed
        );
        let running = app
            .solver_pool
            .try_acquire_for_owner("keep-best".to_string(), 2, owner.clone())
            .expect("active solver");

        let wrong_owner = response_payload(&solve_cancel_json(
            &app,
            br#"{"jobId":"keep-best","retainBest":true}"#,
            &other_owner,
        ));
        assert_eq!(wrong_owner["bestEffortStopRequested"], json!(false));

        let response = response_payload(&solve_cancel_json(
            &app,
            br#"{"jobId":"keep-best","retainBest":true}"#,
            &owner,
        ));
        assert_eq!(response["cancelRequested"], json!(false));
        assert_eq!(response["bestEffortStopRequested"], json!(true));
        assert!(running
            .job
            .best_effort_stop_requested
            .load(Ordering::SeqCst));
        assert!(!running.job.cancel_requested.load(Ordering::SeqCst));
        assert!(app
            .solver_pool
            .server_job_known_for_owner("keep-best", &owner));

        let state = response_payload(&solver_state_json(&app, "jobId=keep-best", &owner));
        assert_eq!(state["requestedJobBestEffortStopRequested"], json!(true));
        assert_eq!(state["jobs"][0]["bestEffortStopRequested"], json!(true));
        let result = response_payload(&solve_result_json(&app, "jobId=keep-best", &owner));
        assert_eq!(result["bestEffortStopRequested"], json!(true));

        drop(running);
    }

    #[test]
    fn cloud_stop_probe_requires_its_ephemeral_token_and_reports_soft_stop() {
        let (app, _, owner) = agent_test_app();
        let job_id = "cloud-stop-probe-job";
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let guard = register_cloud_stop_probe(job_id, &owner);
        let request = |token: &str| {
            serde_json::to_vec(&json!({
                "jobId": job_id,
                "token": token,
                "waitMs": 0
            }))
            .unwrap()
        };

        let initial = cloud_solver_stop_probe_json(&app, &request(&guard.token));
        let initial_payload = response_payload(&initial);
        assert_eq!(response_status(&initial), 200);
        assert_eq!(initial_payload["known"], json!(true));
        assert_eq!(initial_payload["stopRequested"], json!(false));
        assert_eq!(initial_payload["cancelRequested"], json!(false));

        let wrong = cloud_solver_stop_probe_json(&app, &request(&"0".repeat(64)));
        assert_eq!(response_status(&wrong), 404);
        assert_eq!(response_payload(&wrong)["error"], json!("stop_probe_not_found"));

        assert!(app
            .solver_pool
            .request_best_effort_stop_for_owner(job_id, &owner));
        let stopped = cloud_solver_stop_probe_json(&app, &request(&guard.token));
        let stopped_payload = response_payload(&stopped);
        assert_eq!(response_status(&stopped), 200);
        assert_eq!(stopped_payload["stopRequested"], json!(true));
        assert_eq!(stopped_payload["cancelRequested"], json!(false));

        let token = guard.token.clone();
        drop(guard);
        let expired = cloud_solver_stop_probe_json(&app, &request(&token));
        assert_eq!(response_status(&expired), 404);
    }

    #[test]
    fn agent_best_effort_stop_falls_back_to_vps_with_the_stop_flag_intact() {
        for agent_running in [false, true] {
            let app = App {
                root: PathBuf::new(),
                web_root: PathBuf::new(),
                sample_data: PathBuf::new(),
                solver_pool: SolverPool::from_env(),
                agent_helper: AgentHelperCoordinator::new(),
                serverless: ServerlessCoordinator::new(Arc::new(
                    db::Db::new(PathBuf::from(":memory:"))
                        .expect("in-memory serverless database"),
                )),
                db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
            };
            let owner = SolverOwner::new("agent-stop-school", "admin");
            let job_id = if agent_running {
                "agent-running-soft-stop"
            } else {
                "agent-waiting-soft-stop"
            };
            assert_eq!(
                app.solver_pool.claim_server_job(job_id, &owner),
                ServerJobClaim::Claimed
            );
            let agent_fence = app
                .solver_pool
                .prepare_agent_execution(job_id, &owner)
                .expect("Agent fence");
            if agent_running {
                assert!(app
                    .solver_pool
                    .mark_agent_execution_running(agent_fence, job_id, &owner));
            }
            assert!(app
                .solver_pool
                .request_best_effort_stop_for_owner(job_id, &owner));

            let vps_fence = match stop_agent_best_effort_if_requested(
                &app,
                job_id,
                &owner,
                agent_fence,
                None,
            ) {
                AgentBestEffortStopOutcome::FallbackToVps { fence, checkpoint } => {
                    assert!(checkpoint.is_none());
                    fence
                }
                _ => panic!("Agent soft Stop must return the canonical job to VPS"),
            };
            let running = app
                .solver_pool
                .try_acquire_for_owner(job_id.to_string(), 2, owner.clone())
                .expect("VPS acquires the canonical job");
            assert!(running
                .job
                .best_effort_stop_requested
                .load(Ordering::SeqCst));
            assert!(app
                .solver_pool
                .mark_vps_execution_running(vps_fence, job_id, &owner));
        }
    }

    #[test]
    fn agent_stop_preserves_partial_resume_checkpoint_for_same_job_vps_takeover() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("agent-partial-stop-school", "admin");
        let job_id = "agent-partial-soft-stop";
        let mut request = agent_solver_request(job_id);
        request["data"]["tkb"] = json!({});
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let agent_fence = app
            .solver_pool
            .prepare_agent_execution(job_id, &owner)
            .expect("Agent fence");
        assert!(app.agent_helper.register_job(
            job_id,
            &owner,
            Arc::new(serde_json::to_vec(&request).unwrap()),
            1,
            now_millis(),
        ));
        let binding = agent_session_binding("partial-stop-session");
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "partial-stop-browser",
                "Partial Stop Browser",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let lease = app
            .agent_helper
            .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            .expect("Agent lease");
        assert!(app
            .agent_helper
            .accept_resume_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                json!({
                    "ok":false,
                    "kind":"agent_partial_resume_checkpoint",
                    "marker":"resume-after-stop",
                    "lessons":[{"classId":"6A"}],
                    "unassignedLessons":[{"classId":"6A"}],
                    "metrics":{
                        "scheduled_periods":1,
                        "expected_periods":2,
                        "unassigned_periods":1,
                        "hard_ok":false,
                        "placement_hard_ok":true
                    },
                    "validation":{"hard_ok":false,"placement_hard_ok":true}
                }),
                [1, -1, 1, 0],
                now_millis(),
            )
            .expect("partial resume checkpoint"));
        assert!(app
            .solver_pool
            .request_best_effort_stop_for_owner(job_id, &owner));

        let (vps_fence, checkpoint) = match stop_agent_best_effort_if_requested(
            &app,
            job_id,
            &owner,
            agent_fence,
            Some(&request),
        ) {
            AgentBestEffortStopOutcome::FallbackToVps {
                fence,
                checkpoint: Some(checkpoint),
            } => (fence, checkpoint),
            _ => panic!("partial Stop must hand its resume checkpoint to VPS"),
        };
        assert_eq!(checkpoint["marker"], json!("resume-after-stop"));
        assert_eq!(vps_fence.executor, ServerExecutor::Vps);
        let mut resumed_request = Some(request.clone());
        let mut resumed_body = Arc::new(serde_json::to_vec(&request).unwrap());
        apply_agent_checkpoint_to_server_request(
            &mut resumed_body,
            &mut resumed_request,
            Some(checkpoint),
        );
        let resumed_request = resumed_request.expect("VPS continuation request");
        assert_eq!(
            resumed_request["data"]["tkbSolverResult"]["marker"],
            json!("resume-after-stop")
        );
        assert_eq!(
            resumed_request["settings"]["ui_unified_solve_kind"],
            json!("repair_partial")
        );
        assert!(app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .is_none());
        app.solver_pool.abandon_server_job(job_id, &owner);
    }

    #[test]
    fn agent_checkpoint_builds_a_safe_vps_refinement_request() {
        let request = json!({
            "data":{"marker":"canonical"},
            "settings":{
                "solve_run_id":"checkpoint-fallback",
                "ui_unified_solve_kind":"fresh_complete_first",
                "ui_browser_wasm_ready":true,
                "ui_browser_cpsat_ready":true,
                "browser_wasm_refinement":true,
                "browser_wasm_quick_attempt":true,
                "browser_wasm_automatic_progressive_search":true,
                "browser_wasm_automatic_phase":"sessions",
                "force_fresh_backend_solve":true
            }
        });
        let checkpoint = json!({
            "ok":true,
            "lessons":[{"classId":"6A"}],
            "unassignedLessons":[],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":1,
                "unassigned_periods":0,
                "hard_ok":true,
                "app_constraint_violation_count":0
            },
            "validation":{"hard_ok":true}
        });

        let resumed = server_request_with_agent_checkpoint(Some(&request), &checkpoint)
            .expect("checkpoint refinement request");
        assert_eq!(resumed["data"]["marker"], json!("canonical"));
        assert_eq!(resumed["data"]["tkbSolverResult"], checkpoint);
        assert_eq!(
            resumed["settings"]["solve_run_id"],
            json!("checkpoint-fallback")
        );
        assert_eq!(
            resumed["settings"]["optimize_existing_schedule"],
            json!(true)
        );
        assert_eq!(resumed["settings"]["preserve_existing_tkb"], json!(true));
        assert_eq!(
            resumed["settings"]["ui_unified_solve_kind"],
            json!("refine_complete")
        );
        assert_eq!(
            resumed["settings"]["ui_existing_incumbent_revalidated"],
            json!(true)
        );
        assert_eq!(
            resumed["settings"]["ui_agent_checkpoint_fallback"],
            json!(true)
        );
        assert_eq!(
            resumed["settings"]["ui_agent_fresh_automatic_quality_recovery"],
            json!(true)
        );
        assert_eq!(
            resumed["settings"]["ui_stop_after_first_complete_schedule"],
            json!(false)
        );
        assert_eq!(resumed["settings"]["target_gap2_plus_sessions"], json!(0));
        for key in [
            "ui_browser_wasm_ready",
            "ui_browser_cpsat_ready",
            "browser_wasm_refinement",
            "browser_wasm_quick_attempt",
            "browser_wasm_automatic_progressive_search",
            "browser_wasm_automatic_phase",
        ] {
            assert!(
                resumed["settings"].get(key).is_none(),
                "{key} must be disabled"
            );
        }

        let partial_checkpoint = json!({
            "ok":false,
            "kind":"agent_partial_resume_checkpoint",
            "lessons":[{"classId":"6A"}],
            "unassignedLessons":[{"classId":"6B"}],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":4,
                "unassigned_periods":3,
                "hard_ok":false,
                "placement_hard_ok":true,
                "app_constraint_violation_count":0
            },
            "validation":{"hard_ok":false,"placement_hard_ok":true}
        });
        let partial_resumed =
            server_request_with_agent_checkpoint(Some(&request), &partial_checkpoint)
                .expect("partial checkpoint continuation request");
        assert_eq!(
            partial_resumed["settings"]["ui_unified_solve_kind"],
            json!("fresh_complete_first")
        );
        assert_eq!(
            partial_resumed["settings"]["ui_unified_partial_repair"],
            json!(false)
        );
        assert_eq!(
            partial_resumed["settings"]["existing_fill_missing_schedule"],
            json!(false)
        );
        assert_eq!(
            partial_resumed["settings"]["force_fresh_backend_solve"],
            json!(true)
        );
        assert_eq!(
            partial_resumed["settings"]["ui_use_existing_complete_incumbent"],
            Value::Null
        );
        assert_eq!(
            partial_resumed["settings"]["ui_agent_checkpoint_partial_fresh"],
            json!(true)
        );
        assert!(partial_resumed["data"].get("tkbSolverResult").is_none());

        let mut partial_repair_request = request.clone();
        partial_repair_request["settings"]["ui_unified_solve_kind"] = json!("repair_partial");
        let partial_repair_resumed = server_request_with_agent_checkpoint(
            Some(&partial_repair_request),
            &partial_checkpoint,
        )
        .expect("existing partial repair continuation request");
        assert_eq!(
            partial_repair_resumed["settings"]["ui_unified_solve_kind"],
            json!("repair_partial")
        );
        assert_eq!(
            partial_repair_resumed["settings"]["ui_unified_partial_repair"],
            json!(true)
        );
        assert_eq!(
            partial_repair_resumed["settings"]["repair_existing_missing_periods"],
            json!(3)
        );

        let no_progress_request = json!({
            "data":{
                "tkb":{
                    "6A":{
                        "thu2":{
                            "sang":[{"mon":"Math","fixed":true}]
                        }
                    }
                },
                "tkbSolverResult":{"marker":"stale"}
            },
            "settings":{
                "ui_unified_solve_kind":"fresh_complete_first",
                "ui_browser_wasm_ready":true,
                "optimization_time_limit_seconds":130
            }
        });
        let no_progress_checkpoint = json!({
            "ok":false,
            "kind":"agent_partial_resume_checkpoint",
            "lessons":[{"classId":"6A"}],
            "unassignedLessons":[{"classId":"6B"}],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":4,
                "unassigned_periods":3,
                "hard_ok":false,
                "placement_hard_ok":true,
                "app_constraint_violation_count":0
            },
            "validation":{"hard_ok":false,"placement_hard_ok":true}
        });
        let fresh_resumed = server_request_with_agent_checkpoint(
            Some(&no_progress_request),
            &no_progress_checkpoint,
        )
        .expect("fixed-only checkpoint fresh continuation request");
        assert!(fresh_resumed["data"].get("tkbSolverResult").is_none());
        assert_eq!(
            fresh_resumed["settings"]["ui_unified_solve_kind"],
            json!("fresh_complete_first")
        );
        assert_eq!(
            fresh_resumed["settings"]["ui_agent_checkpoint_no_progress_fresh"],
            json!(true)
        );
        assert_eq!(
            fresh_resumed["settings"]["native_skip_teacher_optimization"],
            json!(true)
        );
        assert_eq!(
            fresh_resumed["settings"]["optimization_time_limit_seconds"],
            json!(0)
        );
        assert!(fresh_resumed["settings"]
            .get("ui_browser_wasm_ready")
            .is_none());
    }

    #[test]
    fn fresh_automatic_checkpoint_requires_zero_singletons_and_gap2() {
        let request = browser_ready_automatic_fresh_request("fresh-quality-gate");
        let checkpoint = |one_period: i64, gap2: i64| {
            json!({
                "ok": true,
                "lessons": [{"classId":"6A"}],
                "unassignedLessons": [],
                "metrics": {
                    "scheduled_periods": 1,
                    "expected_periods": 1,
                    "unassigned_periods": 0,
                    "app_constraint_violation_count": 0,
                    "hard_ok": true,
                    "one_period_teacher_sessions": one_period,
                    "teacher_gap2_sessions": gap2,
                    "gap_distribution": {"1": 3, "2": gap2}
                },
                "validation": {"hard_ok": true},
                "solver": {"backend": "hybrid-python-reference"}
            })
        };

        assert!(fresh_automatic_quality_gate_required(&request));
        assert!(!fresh_automatic_quality_gate_met(
            &request,
            &checkpoint(2, 0)
        ));
        assert!(!fresh_automatic_quality_gate_met(
            &request,
            &checkpoint(0, 1)
        ));
        assert!(fresh_automatic_quality_gate_met(
            &request,
            &checkpoint(0, 0)
        ));
        let mut structural_floor = checkpoint(1, 0);
        structural_floor["metrics"]["one_period_teacher_sessions_lower_bound"] = json!(1);
        structural_floor["metrics"]["one_period_teacher_sessions_lower_bound_evidence"] =
            json!([{
                "teacher": "SĐ.Phương",
                "part": "PM",
                "class": "6/3",
                "subject": "Lịch sử và Địa lý",
                "periods_per_week": 3,
                "max_periods_per_session": 2,
                "minimum_sessions": 2,
                "forced_singletons": 1
            }]);
        assert_eq!(
            strict_one_period_teacher_session_floor(&structural_floor),
            Some(1)
        );
        assert!(fresh_automatic_quality_gate_met(
            &request,
            &structural_floor
        ));

        let mut missing_floor_evidence = structural_floor.clone();
        missing_floor_evidence["metrics"]
            .as_object_mut()
            .expect("metrics")
            .remove("one_period_teacher_sessions_lower_bound_evidence");
        assert_eq!(
            strict_one_period_teacher_session_floor(&missing_floor_evidence),
            None
        );
        assert!(!fresh_automatic_quality_gate_met(
            &request,
            &missing_floor_evidence
        ));
        let mut malformed_floor = structural_floor.clone();
        malformed_floor["metrics"]["one_period_teacher_sessions_lower_bound"] = json!(2);
        malformed_floor["metrics"]["one_period_teacher_sessions"] = json!(2);
        assert_eq!(strict_one_period_teacher_session_floor(&malformed_floor), None);
        assert!(!fresh_automatic_quality_gate_met(
            &request,
            &malformed_floor
        ));
        let mut missing_metric = checkpoint(0, 0);
        missing_metric["metrics"]
            .as_object_mut()
            .expect("metrics")
            .remove("teacher_gap2_sessions");
        assert!(!fresh_automatic_quality_gate_met(&request, &missing_metric));
        let mut conflicting_metric = checkpoint(0, 0);
        conflicting_metric["metrics"]["teacher_gap2_sessions"] = json!(1);
        assert!(!fresh_automatic_quality_gate_met(
            &request,
            &conflicting_metric
        ));

        for solve_kind in ["repair_constraints", "refine_complete"] {
            let mut browser_required = request.clone();
            browser_required["settings"]["ui_unified_solve_kind"] = json!(solve_kind);
            browser_required["settings"]["ui_browser_agent_required"] = json!(true);
            browser_required["settings"]["ui_agent_execution_policy"] =
                json!("web_agent_required");
            assert!(fresh_automatic_quality_gate_required(&browser_required));
            assert!(!fresh_automatic_quality_gate_met(
                &browser_required,
                &checkpoint(1, 0)
            ));
            assert!(fresh_automatic_quality_gate_met(
                &browser_required,
                &checkpoint(0, 0)
            ));
        }

        let mut ordinary_refine = request.clone();
        ordinary_refine["settings"]["ui_unified_solve_kind"] = json!("refine_complete");
        assert!(!fresh_automatic_quality_gate_required(&ordinary_refine));
        assert!(automatic_best_effort_stop_quality_gate_required(
            &ordinary_refine
        ));
        assert!(!automatic_best_effort_stop_quality_gate_met(
            &ordinary_refine,
            &checkpoint(1, 0)
        ));
        assert!(automatic_best_effort_stop_quality_gate_met(
            &ordinary_refine,
            &checkpoint(0, 0)
        ));

        let resumed = server_request_with_agent_checkpoint(Some(&request), &checkpoint(0, 1))
            .expect("rough complete checkpoint remains a VPS warm start");
        assert!(fresh_automatic_quality_gate_required(&resumed));
        assert!(!fresh_automatic_quality_gate_met(
            &resumed,
            &resumed["data"]["tkbSolverResult"]
        ));
        let timeout = server_watchdog_timeout_response(&resumed);
        assert_eq!(response_status(&timeout), 422);
        assert_eq!(
            response_payload(&timeout)["kind"],
            json!("fresh_automatic_quality_gate_unmet")
        );
        assert!(
            preserve_complete_hybrid_existing_payload(&resumed).is_none(),
            "VPS recovery must not preserve a rough hybrid checkpoint"
        );
        assert!(
            complete_existing_incumbent_payload(
                &resumed,
                "reference_solver_non_200",
                "quality search failed"
            )
            .is_none(),
            "solver failure must not publish a rough Fresh Automatic incumbent"
        );
        let normal_terminal = server_watchdog_final_response(
            &resumed,
            json_response(200, resumed["data"]["tkbSolverResult"].clone()),
            Some(120_000),
        );
        assert_eq!(response_status(&normal_terminal), 422);
        assert_eq!(
            response_payload(&normal_terminal)["kind"],
            json!("fresh_automatic_quality_gate_unmet")
        );

        let mut completion_request = request.clone();
        completion_request["settings"]["ui_completion_first_rescue"] = json!(true);
        let mut completion_fallback = checkpoint(2, 1);
        completion_fallback["completion_first_fallback"] = json!(true);
        completion_fallback["validation"] = json!({"hard_ok": true, "violations": []});
        completion_fallback["solver"]["runtime_settings"] = json!({
            "completion_first_fallback": true,
            "completion_first_fallback_seed": 17
        });
        completion_fallback["metrics"]["core_hard_ok"] = json!(true);
        completion_fallback["metrics"]["class_slot_conflicts"] = json!(0);
        completion_fallback["metrics"]["teacher_slot_conflicts"] = json!(0);
        completion_fallback["metrics"]["room_slot_conflicts"] = json!(0);
        for key in [
            "assignment_mismatches",
            "class_session_violations",
            "subject_session_limit_violations",
            "contiguous_block_violations",
            "invalid_lesson_slots",
            "app_constraint_violations",
        ] {
            completion_fallback["metrics"][key] = json!([]);
        }
        assert!(completion_first_fallback_terminal_allowed(
            &completion_request,
            &completion_fallback,
        ));
        let completion_response = json_response(200, completion_fallback.clone());
        assert!(server_response_publishable_for_request(
            &completion_request,
            &completion_response,
        ));
        let completion_terminal = server_watchdog_final_response(
            &completion_request,
            completion_response.clone(),
            Some(120_000),
        );
        assert_eq!(completion_terminal, completion_response);

        let mut invalid_completion_fallback = completion_fallback.clone();
        invalid_completion_fallback["metrics"]["teacher_slot_conflicts"] = json!(1);
        assert!(!completion_first_fallback_terminal_allowed(
            &completion_request,
            &invalid_completion_fallback,
        ));
        let rejected_completion = server_watchdog_final_response(
            &completion_request,
            json_response(200, invalid_completion_fallback),
            Some(120_000),
        );
        assert_eq!(response_status(&rejected_completion), 422);

        let mut mobile_checkpoint = checkpoint(2, 0);
        mobile_checkpoint["browser_mobile_checkpoint_vps_refine"] = json!(true);
        mobile_checkpoint["solver"]["runtime_settings"] = json!({
            "browser_mobile_checkpoint_vps_refine": true
        });
        let mobile_resumed =
            server_request_with_agent_checkpoint(Some(&request), &mobile_checkpoint)
                .expect("mobile checkpoint remains a VPS quality warm start");
        assert_eq!(
            mobile_resumed["settings"]["ui_agent_checkpoint_hard_valid_timeout_fallback"],
            json!(true)
        );
        assert!(
            preserve_complete_hybrid_existing_payload(&mobile_resumed).is_none(),
            "VPS must still attempt strict quality before the timeout fallback"
        );
        let (fallback_status, fallback_body) = complete_existing_incumbent_payload(
            &mobile_resumed,
            "reference_solver_non_200",
            r#"{"kind":"no_complete_schedule_before_deadline","deadline_hit":true}"#,
        )
        .expect("mobile VPS timeout must retain the validated complete checkpoint");
        assert_eq!(fallback_status, 200);
        let fallback_payload: Value =
            serde_json::from_str(&fallback_body).expect("mobile fallback payload");
        assert_eq!(fallback_payload["ok"], json!(true));
        assert_eq!(
            fallback_payload["lessons"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            fallback_payload["solver"]["runtime_settings"]["phase"],
            json!("agent_checkpoint_quality_debt_timeout_fallback")
        );
        assert_eq!(
            fallback_payload["solver"]["runtime_settings"]["quality_debt_retained"],
            json!(true)
        );

        let mobile_timeout = server_watchdog_timeout_response(&mobile_resumed);
        assert_eq!(response_status(&mobile_timeout), 200);
        let mobile_timeout_payload = response_payload(&mobile_timeout);
        assert_eq!(mobile_timeout_payload["ok"], json!(true));
        assert_eq!(
            mobile_timeout_payload["solver"]["runtime_settings"]["deadline_hit"],
            json!(true)
        );

        let mut mobile_terminal = checkpoint(2, 0);
        mobile_terminal["mobile_local_quality_terminal"] = json!(true);
        mobile_terminal["quality_debt_retained"] = json!(true);
        mobile_terminal["solver"]["runtime_settings"] = json!( {
            "mobile_local_quality_terminal": true,
            "quality_debt_retained": true
        });
        assert!(browser_mobile_local_quality_terminal(&mobile_terminal));
        assert!(!fresh_automatic_quality_gate_met(
            &request,
            &mobile_terminal
        ));
        assert!(!fresh_automatic_terminal_quality_unmet(
            Some(&request),
            &mobile_terminal
        ));
        let mobile_terminal_response = server_watchdog_final_response(
            &request,
            json_response(200, mobile_terminal.clone()),
            Some(120_000),
        );
        assert_eq!(response_status(&mobile_terminal_response), 200);
        let mut invalid_mobile_terminal = mobile_terminal.clone();
        invalid_mobile_terminal["lessons"] = json!([]);
        assert!(!browser_mobile_local_quality_terminal(
            &invalid_mobile_terminal
        ));
        assert!(fresh_automatic_terminal_quality_unmet(
            Some(&request),
            &invalid_mobile_terminal
        ));
    }

    #[test]
    fn zero_slack_large_fresh_does_not_bypass_unverified_quality_debt() {
        let request = legacy_large_automatic_request(
            "zero-slack-quality-debt",
            "fresh_complete_first",
        );
        let lessons = (0..2031)
            .map(|index| json!({"classId": format!("class-{index}")}))
            .collect::<Vec<_>>();
        let rough = json!({
            "ok": true,
            "lessons": lessons,
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 2031,
                "expected_periods": 2031,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "app_constraint_violations": [],
                "hard_ok": true,
                "core_hard_ok": true,
                "one_period_teacher_sessions": 76,
                "teacher_gap2_sessions": 80,
                "gap_distribution": {"0": 492, "1": 155, "2": 67, "3": 13}
            },
            "validation": {"hard_ok": true, "violations": []},
            "solver": {"backend": "hybrid-python-reference"}
        });

        assert!(!zero_slack_large_fresh_quality_debt_terminal_allowed(
            &request,
            &rough,
        ));
        let response = json_response(200, rough.clone());
        assert!(!server_response_publishable_for_request(&request, &response));
        let terminal = server_watchdog_final_response(&request, response, Some(120_000));
        assert_eq!(response_status(&terminal), 422);

        let mut strict_quality = rough.clone();
        strict_quality["metrics"]["one_period_teacher_sessions"] = json!(0);
        strict_quality["metrics"]["teacher_gap2_sessions"] = json!(0);
        strict_quality["metrics"]["gap_distribution"] = json!({"0": 492, "1": 155});
        let strict_response = json_response(200, strict_quality);
        let strict_terminal =
            server_watchdog_final_response(&request, strict_response.clone(), Some(120_000));
        assert_eq!(strict_terminal, strict_response);
        assert!(response_payload(&strict_terminal)
            .get("quality_debt_retained")
            .is_none());

        let mut structural_floor = rough.clone();
        structural_floor["metrics"]["one_period_teacher_sessions"] = json!(1);
        structural_floor["metrics"]["teacher_gap2_sessions"] = json!(0);
        structural_floor["metrics"]["gap_distribution"] = json!({"0": 492, "1": 155});
        structural_floor["metrics"]["one_period_teacher_sessions_lower_bound"] = json!(1);
        structural_floor["metrics"]["one_period_teacher_sessions_lower_bound_evidence"] =
            json!([{
                "teacher": "SĐ.Phương",
                "part": "PM",
                "class": "6/3",
                "subject": "Lịch sử và Địa lý",
                "periods_per_week": 3,
                "max_periods_per_session": 2,
                "minimum_sessions": 2,
                "forced_singletons": 1
            }]);
        assert!(fresh_automatic_quality_gate_met(&request, &structural_floor));
        let floor_response = json_response(200, structural_floor);
        let floor_terminal =
            server_watchdog_final_response(&request, floor_response.clone(), Some(120_000));
        assert_eq!(floor_terminal, floor_response);
        assert!(response_payload(&floor_terminal)
            .get("quality_debt_retained")
            .is_none());

        let mut non_zero_slack = request.clone();
        non_zero_slack["settings"]["tight_class_fixed_off_profile"]["availableSlots"] =
            json!(2032);
        assert!(!zero_slack_large_fresh_quality_debt_terminal_allowed(
            &non_zero_slack,
            &rough,
        ));
        let rejected = server_watchdog_final_response(
            &non_zero_slack,
            json_response(200, rough.clone()),
            Some(120_000),
        );
        assert_eq!(response_status(&rejected), 422);

        let mut invalid = rough.clone();
        invalid["validation"]["hard_ok"] = json!(false);
        assert!(!zero_slack_large_fresh_quality_debt_terminal_allowed(
            &request,
            &invalid,
        ));
        let rejected = server_watchdog_final_response(
            &request,
            json_response(200, invalid),
            Some(120_000),
        );
        assert_eq!(response_status(&rejected), 422);

        let mut partial = rough;
        partial["metrics"]["scheduled_periods"] = json!(2030);
        partial["metrics"]["unassigned_periods"] = json!(1);
        assert!(!zero_slack_large_fresh_quality_debt_terminal_allowed(
            &request,
            &partial,
        ));
        let rejected = server_watchdog_final_response(
            &request,
            json_response(200, partial),
            Some(MIN_SOLVER_DEADLINE_MS - 1),
        );
        assert_eq!(response_status(&rejected), 422);
    }

    #[test]
    fn agent_best_effort_stop_commits_the_accepted_checkpoint_without_vps_fallback() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("agent-checkpoint-school", "admin");
        let job_id = "agent-checkpoint-soft-stop";
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let agent_fence = app
            .solver_pool
            .prepare_agent_execution(job_id, &owner)
            .expect("Agent fence");
        assert!(app.agent_helper.register_job(
            job_id,
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            now_millis(),
        ));
        let binding = agent_session_binding("checkpoint-stop-session");
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "web-checkpoint",
                "Web checkpoint",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let lease = app
            .agent_helper
            .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            .expect("Agent lease");
        assert!(app
            .agent_helper
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                json!({"ok":true,"marker":"accepted-checkpoint"}),
                [0, 0, 3, 0],
                now_millis(),
            )
            .expect("accepted checkpoint"));
        assert!(app
            .solver_pool
            .request_best_effort_stop_for_owner(job_id, &owner));

        assert!(matches!(
            stop_agent_best_effort_if_requested(&app, job_id, &owner, agent_fence, None,),
            AgentBestEffortStopOutcome::Completed
        ));
        let response = app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .expect("checkpoint response");
        assert_eq!(
            response_payload(&response)["marker"],
            json!("accepted-checkpoint")
        );
        assert_eq!(app.solver_pool.active_count(), 0);
    }

    #[test]
    fn fresh_automatic_stop_keeps_a_rough_checkpoint_for_vps_instead_of_publishing_it() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("fresh-stop-school", "admin");
        let job_id = "fresh-rough-checkpoint-soft-stop";
        let request = browser_ready_automatic_fresh_request(job_id);
        let rough = json!({
            "ok":true,
            "marker":"rough-fresh-stop-checkpoint",
            "lessons":[{"classId":"6A"}],
            "unassignedLessons":[],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":1,
                "unassigned_periods":0,
                "app_constraint_violation_count":0,
                "hard_ok":true,
                "one_period_teacher_sessions":2,
                "teacher_gap2_sessions":1,
                "gap_distribution":{"1":1,"2":1}
            },
            "validation":{"hard_ok":true}
        });
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let agent_fence = app
            .solver_pool
            .prepare_agent_execution(job_id, &owner)
            .expect("Agent fence");
        assert!(app.agent_helper.register_job(
            job_id,
            &owner,
            Arc::new(serde_json::to_vec(&request).expect("request body")),
            1,
            now_millis(),
        ));
        let binding = agent_session_binding("fresh-rough-stop-session");
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "fresh-rough-stop-browser",
                "Fresh rough Stop Browser",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let lease = app
            .agent_helper
            .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            .expect("Agent lease");
        assert!(app
            .agent_helper
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                rough.clone(),
                [2, 1, 1, 3],
                now_millis(),
            )
            .expect("rough checkpoint accepted as a warm start"));
        assert!(app
            .solver_pool
            .request_best_effort_stop_for_owner(job_id, &owner));

        let (vps_fence, checkpoint) = match stop_agent_best_effort_if_requested(
            &app,
            job_id,
            &owner,
            agent_fence,
            Some(&request),
        ) {
            AgentBestEffortStopOutcome::FallbackToVps {
                fence,
                checkpoint: Some(checkpoint),
            } => (fence, checkpoint),
            _ => panic!("rough Fresh Automatic Stop must continue from VPS"),
        };
        assert_eq!(vps_fence.executor, ServerExecutor::Vps);
        assert_eq!(checkpoint["marker"], json!("rough-fresh-stop-checkpoint"));
        assert!(app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .is_none());
        app.solver_pool.abandon_server_job(job_id, &owner);
    }

    #[test]
    fn agent_best_effort_stop_before_first_checkpoint_returns_the_incumbent_immediately() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("agent-incumbent-school", "admin");
        let job_id = "agent-incumbent-soft-stop";
        let incumbent = json!({
            "ok": true,
            "lessons": [
                {"classId":"L1", "day":2, "session":"AM", "period":1},
                {"classId":"L1", "day":2, "session":"AM", "period":2}
            ],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "hard_ok": true,
                "core_hard_ok": true,
                "teacher_sessions": 1,
                "one_period_teacher_sessions": 0,
                "teacher_gap2_sessions": 0,
                "gap_distribution": {"1": 0, "2": 0}
            },
            "validation": {"hard_ok":true},
            "solver": {"backend":"hybrid-python-reference"}
        });
        let request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_use_existing_complete_incumbent": true,
                "require_complete_schedule": true
            },
            "data": {"tkbSolverResult":incumbent.clone()}
        });
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let agent_fence = app
            .solver_pool
            .prepare_agent_execution(job_id, &owner)
            .expect("Agent fence");
        assert!(app.agent_helper.register_job(
            job_id,
            &owner,
            Arc::new(serde_json::to_vec(&request).expect("request body")),
            1,
            now_millis(),
        ));
        assert!(app
            .solver_pool
            .request_best_effort_stop_for_owner(job_id, &owner));

        assert!(matches!(
            stop_agent_best_effort_if_requested(&app, job_id, &owner, agent_fence, Some(&request),),
            AgentBestEffortStopOutcome::Completed
        ));
        let response = app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .expect("incumbent response");
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 200);
        assert_eq!(payload["lessons"], incumbent["lessons"]);
        assert_eq!(payload["metrics"], incumbent["metrics"]);
        assert_eq!(
            payload["solver"]["runtime_settings"]["fallback_reason"],
            json!("best_effort_stop_before_checkpoint")
        );
        assert_eq!(app.solver_pool.active_count(), 0);
    }

    #[test]
    fn solver_state_and_result_expose_live_progress_for_owned_jobs() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("progress-school", "progress-admin");
        assert_eq!(
            app.solver_pool.claim_server_job("live-progress", &owner),
            ServerJobClaim::Claimed
        );
        let running = app
            .solver_pool
            .try_acquire_for_owner("live-progress".to_string(), 2, owner.clone())
            .expect("running server job");
        assert!(app.solver_pool.update_server_job_progress(
            "live-progress",
            json!({
                "protocol":REFERENCE_PROGRESS_PROTOCOL,
                "stage":"session:solve",
                "message":"solving",
                "sequence":7,
                "elapsedMs":3210
            }),
        ));

        let state = response_payload(&solver_state_json(&app, "jobId=live-progress", &owner));
        assert_eq!(
            state["jobs"][0]["progress"]["stage"],
            json!("session:solve")
        );
        assert_eq!(state["requestedJobProgress"]["sequence"], json!(7));
        assert!(state["requestedJobProgressUpdatedAtMs"].is_u64());

        let pending = solve_result_for_job_id_json(&app, "live-progress", &owner);
        assert_eq!(response_status(&pending), 202);
        let pending = response_payload(&pending);
        assert_eq!(pending["progress"]["elapsedMs"], json!(3210));
        assert!(pending["progressUpdatedAtMs"].is_u64());

        assert!(app.solver_pool.complete_server_job(
            "live-progress",
            &owner,
            json_response(200, json!({"ok":true,"metrics":{"scheduled_periods":1}})),
        ));
        let completed = solve_result_for_job_id_json(&app, "live-progress", &owner);
        assert_eq!(response_status(&completed), 200);
        let completed = response_payload(&completed);
        assert_eq!(completed["progress"]["stage"], json!("session:solve"));
        assert!(completed["progressUpdatedAtMs"].is_u64());

        drop(running);
        app.solver_pool.abandon_server_job("live-progress", &owner);
    }

    #[test]
    fn fifo_responses_expose_the_queued_jobs_full_worker_demand() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let running_owner = SolverOwner::new("school-running", "admin-running");
        let queued_owner = SolverOwner::new("school-queued", "admin-queued");
        let mut running = Vec::new();
        for index in 0..app.solver_pool.max_concurrent() {
            let Ok(guard) = app.solver_pool.try_acquire_for_owner(
                format!("running-{index}"),
                app.solver_pool.min_workers_per_job(),
                running_owner.clone(),
            ) else {
                break;
            };
            running.push(guard);
        }
        assert!(!running.is_empty());
        assert!(app.solver_pool.at_capacity());

        let request = json!({
            "settings": {
                "solve_run_id": "queued-unified",
                "ui_solver_fifo_admission": true,
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete"
            }
        });
        let response = solve_json(&app, request.to_string().as_bytes(), &queued_owner);
        let payload = response_payload(&response);
        let required_workers = app.solver_pool.desired_workers(Some(&request));
        assert_eq!(response_status(&response), 202);
        assert_eq!(payload["kind"], json!("solver_queued"));
        assert_eq!(payload["requiredWorkers"], json!(required_workers));

        let state = response_payload(&solver_state_json(
            &app,
            "jobId=queued-unified",
            &queued_owner,
        ));
        assert_eq!(state["queue"][0]["desiredWorkers"], json!(required_workers));
        assert_eq!(state["requestedJobQueued"], json!(true));
        assert_eq!(state["requestedJobActive"], json!(false));
    }

    fn async_preserved_request(job_id: &str) -> Value {
        json!({
            "data": {
                "tkbSolverResult": {
                    "ok": true,
                    "lessons": [],
                    "unassignedLessons": [],
                    "metrics": {
                        "scheduled_periods": 1,
                        "expected_periods": 1,
                        "unassigned_periods": 0,
                        "app_constraint_violation_count": 0,
                        "hard_ok": true
                    },
                    "solver": {"backend": "hybrid-python-reference"}
                }
            },
            "settings": {
                "solve_run_id": job_id,
                "ui_solver_fifo_admission": true,
                "ui_solver_async_job": true,
                "ui_schedule_fingerprint": "v2:0123456789abcdef:42",
                "ui_progress_budget_seconds": 120,
                "ui_progress_run_index": 3,
                "optimize_existing_schedule": true,
                "ui_existing_incumbent_revalidated": true
            }
        })
    }

    fn browser_ready_refinement_request(job_id: &str) -> Value {
        let mut request = async_preserved_request(job_id);
        request["data"]["tkbSolverResult"]["lessons"] = json!([{"classId":"6A"}]);
        request["data"]["tkbSolverResult"]["validation"] = json!({"hard_ok":true});
        request["settings"]["ui_unified_solve_kind"] = json!("refine_complete");
        request["settings"]["ui_use_existing_complete_incumbent"] = json!(true);
        request["settings"]["ui_browser_wasm_ready"] = json!(true);
        request
    }

    fn browser_ready_quick_request(job_id: &str, partial: bool) -> Value {
        let mut request = agent_solver_request(job_id);
        request["settings"]["ui_solver_fifo_admission"] = json!(true);
        request["settings"]["ui_solver_async_job"] = json!(true);
        request["settings"]["ui_unified_solve_kind"] = if partial {
            json!("repair_partial")
        } else {
            json!("fresh_complete_first")
        };
        request["settings"]["ui_requested_solve_mode"] = json!("quick_complete");
        request["settings"]["optimization_focus"] = json!("quick_complete");
        request["settings"]["ui_progress_metric_focus"] = json!("scheduled_periods");
        request["settings"]["ui_progress_metric_target"] = json!(2);
        request["settings"]["require_complete_schedule"] = json!(true);
        request["settings"]["ui_browser_wasm_ready"] = json!(true);
        request["settings"]["optimize_existing_schedule"] = json!(partial);
        request["settings"]["force_fresh_backend_solve"] = json!(!partial);
        if partial {
            request["data"]["tkbSolverResult"] = json!({
                "ok": false,
                "lessons": [{"classId":"6A","subject":"Math"}],
                "unassignedLessons": [{"classId":"6A","subject":"Literature"}],
                "metrics": {
                    "scheduled_periods": 1,
                    "expected_periods": 2,
                    "unassigned_periods": 1,
                    "app_constraint_violation_count": 0,
                    "hard_ok": true
                }
            });
        }
        request
    }

    fn browser_ready_automatic_fresh_request(job_id: &str) -> Value {
        let mut request = agent_solver_request(job_id);
        request["settings"]["ui_solver_fifo_admission"] = json!(true);
        request["settings"]["ui_solver_async_job"] = json!(true);
        request["settings"]["ui_unified_solve_kind"] = json!("fresh_complete_first");
        request["settings"]["ui_requested_solve_mode"] = json!("automatic");
        request["settings"]["optimization_focus"] = json!("automatic");
        request["settings"]["require_complete_schedule"] = json!(true);
        request["settings"]["ui_browser_wasm_ready"] = json!(true);
        request["settings"]["force_fresh_backend_solve"] = json!(true);
        request
    }

    fn legacy_large_automatic_request(job_id: &str, solve_kind: &str) -> Value {
        let mut request = browser_ready_automatic_fresh_request(job_id);
        let settings = request
            .get_mut("settings")
            .and_then(Value::as_object_mut)
            .expect("legacy large Automatic settings");
        settings.insert("ui_browser_wasm_ready".to_string(), json!(false));
        settings.insert("ui_browser_cpsat_ready".to_string(), json!(false));
        settings.insert("ui_agent_execution_policy".to_string(), json!("vps_only"));
        settings.insert("ui_unified_auto_sort".to_string(), json!(true));
        settings.insert("ui_unified_solve_kind".to_string(), json!(solve_kind));
        settings.insert("ui_custom_solve_duration_seconds".to_string(), json!(60));
        settings.insert("expected_scheduled_periods".to_string(), json!(2031));
        settings.insert("backend_deadline_ms".to_string(), json!(60_000));
        settings.insert("native_global_deadline_ms".to_string(), json!(60_000));
        settings.insert("reference_solver_budget_ms".to_string(), json!(60_000));
        settings.insert(
            "reference_watchdog_deadline_ms".to_string(),
            json!(80_000),
        );
        settings.insert("reference_deadline_reserve_ms".to_string(), json!(20_000));
        settings.insert("overall_time_limit_seconds".to_string(), json!(60));
        settings.insert("integrated_time_limit".to_string(), json!(60));
        settings.insert("optimization_time_limit_seconds".to_string(), json!(60));
        settings.insert(
            "tight_class_fixed_off_profile".to_string(),
            json!({
                "expected": 2031,
                "availableSlots": 2031,
                "fixedSlots": 144,
                "slack": 0
            }),
        );
        request
    }

    fn native_required_automatic_request(job_id: &str) -> Value {
        let mut request = browser_ready_automatic_fresh_request(job_id);
        let settings = request
            .get_mut("settings")
            .and_then(Value::as_object_mut)
            .expect("native-required request settings");
        settings.insert("ui_browser_wasm_ready".to_string(), json!(false));
        settings.insert("ui_browser_cpsat_ready".to_string(), json!(false));
        settings.insert(
            "ui_agent_execution_policy".to_string(),
            json!("native_required"),
        );
        settings.insert("ui_native_agent_required".to_string(), json!(true));
        settings.insert("ui_agent_preference_enabled".to_string(), json!(true));
        request
    }

    fn browser_required_quick_request(job_id: &str) -> Value {
        let mut request = browser_ready_quick_request(job_id, false);
        let settings = request
            .get_mut("settings")
            .and_then(Value::as_object_mut)
            .expect("browser-required request settings");
        settings.insert(
            "ui_agent_execution_policy".to_string(),
            json!("web_agent_required"),
        );
        settings.insert("ui_browser_agent_required".to_string(), json!(true));
        settings.insert("ui_agent_preference_enabled".to_string(), json!(true));
        request
    }

    fn browser_ready_cp_sat_automatic_fresh_request(job_id: &str) -> Value {
        let mut request = browser_ready_automatic_fresh_request(job_id);
        request["settings"]["ui_browser_cpsat_ready"] = json!(true);
        request["data"]["tkbConstraints"] = json!({
            "teacher": {
                "GV1": {
                    "mustTeach": {"thu2|sang|0": true}
                }
            }
        });
        request
    }

    fn browser_ready_automatic_constraint_repair_request(job_id: &str) -> Value {
        let mut request = browser_ready_automatic_fresh_request(job_id);
        request["settings"]["ui_unified_solve_kind"] = json!("repair_constraints");
        request["settings"]["preserve_existing_tkb"] = json!(true);
        request["settings"]["ui_constraint_change_repair"] = json!(true);
        request
    }

    #[test]
    fn no_checkpoint_vps_rescue_is_scoped_to_fresh_automatic_browser_work() {
        let automatic = browser_ready_automatic_fresh_request("automatic-rescue");
        assert!(fresh_automatic_no_checkpoint_rescue_eligible(Some(
            &automatic
        )));
        assert!(fresh_automatic_no_checkpoint_rescue_body_eligible(
            automatic.to_string().as_bytes()
        ));

        let quick = browser_ready_quick_request("quick-no-rescue", false);
        assert!(!fresh_automatic_no_checkpoint_rescue_eligible(Some(&quick)));
        let refinement = browser_ready_refinement_request("refine-no-rescue");
        assert!(!fresh_automatic_no_checkpoint_rescue_eligible(Some(
            &refinement
        )));
        let repair = browser_ready_automatic_constraint_repair_request("repair-no-rescue");
        assert!(!fresh_automatic_no_checkpoint_rescue_eligible(Some(
            &repair
        )));
        let mut no_browser = automatic;
        no_browser["settings"]["ui_browser_wasm_ready"] = json!(false);
        no_browser["settings"]["ui_browser_cpsat_ready"] = json!(false);
        assert!(!fresh_automatic_no_checkpoint_rescue_eligible(Some(
            &no_browser
        )));
    }

    #[test]
    fn browser_required_without_verified_readiness_is_rejected_before_claim() {
        let (app, _token, owner) = agent_test_app();
        let job_id = "browser-required-not-ready";
        let mut request = browser_required_quick_request(job_id);
        request["settings"]["ui_browser_wasm_ready"] = json!(false);
        request["settings"]["ui_browser_cpsat_ready"] = json!(false);

        let response = solve_json(&app, request.to_string().as_bytes(), &owner);
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 428);
        assert_eq!(payload["kind"], json!("browser_agent_required"));
        assert_eq!(payload["browserAgentRequired"], json!(true));
        assert_eq!(payload["vpsFallback"], json!(false));
        assert!(!app.solver_pool.server_job_known_for_owner(job_id, &owner));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
    }

    #[test]
    fn explicit_vps_only_ignores_stale_browser_local_flags() {
        let (app, _token, owner) = agent_test_app();
        let job_id = "explicit-vps-only-stale-browser-flags";
        let blocker = app
            .solver_pool
            .try_acquire(
                "explicit-vps-only-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS blocker");
        let mut request = browser_required_quick_request(job_id);
        request["settings"]["ui_agent_execution_policy"] = json!("vps_only");

        let response = solve_json(&app, request.to_string().as_bytes(), &owner);
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 202);
        assert_eq!(payload["executor"], json!("vps"));
        assert_eq!(payload["executionPhase"], json!("vps_queued"));
        let snapshot = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("VPS-only snapshot");
        assert!(!snapshot.browser_agent_required);
        assert_eq!(snapshot.execution_generation, 1);

        let cancelled = solve_cancel_json(
            &app,
            format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        drop(blocker);
    }

    #[test]
    fn large_automatic_claim_owns_200_second_watchdog_instead_of_client_80_seconds() {
        for solve_kind in ["fresh_complete_first", "repair_constraints"] {
            let (app, _token, owner) = agent_test_app();
            let job_id = format!("large-watchdog-{solve_kind}");
            let blocker = app
                .solver_pool
                .try_acquire(
                    format!("large-watchdog-blocker-{solve_kind}"),
                    app.solver_pool.total_worker_tokens(),
                )
                .expect("exclusive VPS blocker");
            let request = legacy_large_automatic_request(&job_id, solve_kind);
            assert_eq!(
                reference_solver_budget(&request).hard_ms,
                80_000,
                "the fixture must retain the stale browser cap"
            );

            let started = solve_json(&app, request.to_string().as_bytes(), &owner);
            let started_payload = response_payload(&started);
            assert_eq!(response_status(&started), 202);
            assert_eq!(started_payload["executor"], json!("vps"));
            assert_eq!(started_payload["executionPhase"], json!("vps_queued"));

            let (watchdog_budget, watchdog_started) = app
                .solver_pool
                .server_job_watchdog_snapshot(&job_id, &owner)
                .expect("canonical watchdog snapshot");
            assert_eq!(watchdog_budget, Some(200_000));
            assert!(watchdog_started.is_some());
            let state = response_payload(&solver_state_json(
                &app,
                &format!("jobId={job_id}"),
                &owner,
            ));
            assert_eq!(state["requestedJobWatchdogBudgetMs"], json!(200_000));
            assert_eq!(state["requestedJobWatchdogStartedAtMs"], json!(watchdog_started));

            let cancelled = solve_cancel_json(
                &app,
                format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
                &owner,
            );
            assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
            drop(blocker);
        }
    }

    #[test]
    fn native_paused_vps_requires_the_exact_live_paused_agent() {
        let (app, token, owner) = agent_test_app();
        let mut request = browser_ready_refinement_request("native-paused-vps-fence");
        request["settings"]["ui_agent_execution_policy"] = json!("native_paused_vps");
        request["settings"]["ui_agent_preference_enabled"] = json!(false);
        request["settings"]["ui_native_agent_id"] = json!("paused-vps-pc");

        let missing = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&missing), 428);
        assert_eq!(response_payload(&missing)["kind"], json!("native_agent_must_be_running_and_off"));

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "enabled":false,
                "agent":{"agentId":"paused-vps-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":2,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let blocker = app
            .solver_pool
            .try_acquire("native-paused-vps-blocker".to_string(), app.solver_pool.total_worker_tokens())
            .expect("exclusive VPS blocker");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("vps"));
        assert_eq!(response_payload(&started)["executionPhase"], json!("vps_queued"));
        let mut wrong_id = request.clone();
        wrong_id["settings"]["ui_native_agent_id"] = json!("another-pc");
        let wrong = solve_json(&app, wrong_id.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&wrong), 428);
        assert_eq!(response_payload(&wrong)["kind"], json!("native_agent_must_be_running_and_off"));
        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"native-paused-vps-fence"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        drop(blocker);
    }

    #[test]
    fn ready_browser_quick_starts_agent_waiting_without_vps_tokens() {
        for partial in [false, true] {
            let (app, _token, owner) = agent_test_app();
            let job_id = if partial {
                "browser-ready-quick-partial"
            } else {
                "browser-ready-quick-fresh"
            };
            let request = browser_ready_quick_request(job_id, partial);
            let body = request.to_string();
            assert!(agent_helper::browser_refinement_request_eligible(
                body.as_bytes()
            ));

            let started = solve_json(&app, body.as_bytes(), &owner);
            let started_payload = response_payload(&started);
            assert_eq!(response_status(&started), 202);
            assert_eq!(started_payload["jobId"], json!(job_id));
            assert_eq!(started_payload["executor"], json!("agent"));
            assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
            assert_eq!(started_payload["requiredWorkers"], json!(0));
            assert_eq!(app.solver_pool.active_count(), 0);
            assert_eq!(app.solver_pool.queued_count(), 0);
            assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

            let cancelled = solve_cancel_json(
                &app,
                format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
                &owner,
            );
            assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        }
    }

    #[test]
    fn ready_browser_refinement_starts_agent_waiting_without_vps_tokens() {
        let (app, _token, owner) = agent_test_app();
        let request = browser_ready_refinement_request("browser-ready-direct-agent");
        let body = request.to_string();
        assert!(agent_helper::browser_refinement_request_eligible(
            body.as_bytes()
        ));
        assert_eq!(
            app.agent_helper.online_worker_count_for_job(
                &owner,
                "browser-ready-direct-agent",
                now_millis(),
            ),
            0,
            "the readiness fast path must not depend on a pre-online Agent"
        );

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(
            started_payload["jobId"],
            json!("browser-ready-direct-agent")
        );
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            app.solver_pool.total_worker_tokens()
        );

        let cancelled =
            solve_cancel_json(&app, br#"{"jobId":"browser-ready-direct-agent"}"#, &owner);
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn ready_browser_gap_prefers_local_agent_when_vps_workers_are_free() {
        let (app, _token, owner) = agent_test_app();
        let mut request = browser_ready_refinement_request("browser-ready-gap-agent-first");
        request["settings"]["optimization_focus"] = json!("gaps");
        let body = request.to_string();
        assert!(agent_helper::browser_refinement_request_eligible(
            body.as_bytes()
        ));
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            app.solver_pool.total_worker_tokens()
        );

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"browser-ready-gap-agent-first"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn ready_browser_gap_spills_to_local_agent_while_vps_workers_are_busy() {
        let (app, _token, owner) = agent_test_app();
        let blocker = app
            .solver_pool
            .try_acquire(
                "browser-gap-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        assert_eq!(app.solver_pool.available_worker_tokens(), 0);
        let mut request = browser_ready_refinement_request("browser-ready-gap-spillover");
        request["settings"]["optimization_focus"] = json!("gaps");
        let body = request.to_string();

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));

        let cancelled =
            solve_cancel_json(&app, br#"{"jobId":"browser-ready-gap-spillover"}"#, &owner);
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        drop(blocker);
    }

    #[test]
    fn ready_browser_sessions_prefers_local_agent_when_vps_workers_are_free() {
        let (app, _token, owner) = agent_test_app();
        let mut request = browser_ready_refinement_request("browser-ready-sessions-agent-first");
        request["settings"]["optimization_focus"] = json!("sessions");
        let body = request.to_string();
        assert!(agent_helper::browser_refinement_request_eligible(
            body.as_bytes()
        ));
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            app.solver_pool.total_worker_tokens()
        );

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"browser-ready-sessions-agent-first"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn focused_sessions_prefer_online_native_agent_over_free_vps() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"focused-vps-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);

        let mut request = browser_ready_refinement_request("focused-agent-over-free-vps");
        request["settings"]["optimization_focus"] = json!("sessions");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let cancelled =
            solve_cancel_json(&app, br#"{"jobId":"focused-agent-over-free-vps"}"#, &owner);
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn healthy_native_http_agent_owns_solve_without_vps_capacity() {
        let (app, token, owner) = agent_test_app();
        let job_id = "healthy-native-http-owns-solve";
        let baseline_total = app.solver_pool.total_worker_tokens();
        let baseline_allocated = app.solver_pool.allocated_worker_tokens();
        let baseline_available = app.solver_pool.available_worker_tokens();

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{
                    "agentId":"healthy-native-http-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let hello_payload = response_payload(&hello);
        assert_eq!(hello_payload["agentEligible"], json!(true));
        let worker_token = hello_payload["workerToken"]
            .as_str()
            .expect("native HTTP worker token")
            .to_string();

        let mut request = browser_ready_automatic_fresh_request(job_id);
        // Disable the Browser readiness shortcut so this solve can enter
        // Agent ownership only because the native HTTP worker is online.
        request["settings"]["ui_browser_wasm_ready"] = json!(false);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        let agent_generation = app
            .solver_pool
            .server_execution_snapshot(job_id, &owner)
            .expect("initial Agent execution snapshot")
            .generation;
        assert_eq!(
            agent_generation, 1,
            "the canonical job must enter Agent ownership directly"
        );
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(
            app.solver_pool.allocated_worker_tokens(),
            baseline_allocated
        );
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            baseline_available
        );

        let lease = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"healthy-native-http-lease-0001",
                "agent":{
                    "agentId":"healthy-native-http-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":5
            })),
        );
        assert_eq!(response_status(&lease), 200);
        let lease_payload = response_payload(&lease);
        assert_eq!(lease_payload["lease"]["jobId"], json!(job_id));
        assert!(lease_payload["lease"]["payload"]["settings"]
            .get("browser_wasm_server_lease")
            .is_none());
        let lease_id = lease_payload["lease"]["leaseId"]
            .as_str()
            .expect("native HTTP lease id")
            .to_string();

        let running_deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = app
                .solver_pool
                .server_execution_snapshot(job_id, &owner)
                .expect("native Agent execution snapshot");
            if snapshot.phase == ServerExecutionPhase::AgentRunning {
                assert_eq!(snapshot.generation, agent_generation);
                break;
            }
            assert!(
                Instant::now() < running_deadline,
                "native HTTP lease did not become the running executor: {snapshot:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let heartbeat = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/heartbeat"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"healthy-native-http-worker",
                "jobId":job_id,
                "leaseId":lease_id
            })),
        );
        assert_eq!(response_status(&heartbeat), 200);
        assert_eq!(response_payload(&heartbeat)["renewed"], json!(true));

        // Every Agent-to-VPS transition first increments this generation.
        // Keeping it stable proves that no transient VPS generation could
        // acquire capacity and then disappear between the counter checks.
        thread::sleep(Duration::from_millis(150));
        let snapshot = app
            .solver_pool
            .server_execution_snapshot(job_id, &owner)
            .expect("healthy native Agent remains authoritative");
        assert_eq!(snapshot.phase, ServerExecutionPhase::AgentRunning);
        assert_eq!(snapshot.generation, agent_generation);
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.total_worker_tokens(), baseline_total);
        assert_eq!(
            app.solver_pool.allocated_worker_tokens(),
            baseline_allocated
        );
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            baseline_available
        );

        let state = response_payload(&solver_state_json(&app, &format!("jobId={job_id}"), &owner));
        assert_eq!(state["requestedJobExecutor"], json!("agent"));
        assert_eq!(state["requestedJobExecutionPhase"], json!("agent_running"));

        let cancelled = solve_cancel_json(
            &app,
            format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn native_required_offline_returns_428_and_browser_worker_does_not_satisfy_it() {
        let (app, _token, owner) = agent_test_app();
        let job_id = "native-required-offline";
        let browser_binding = agent_session_binding("native-required-browser-only");
        app.agent_helper
            .register_scoped_worker(
                &owner,
                &browser_binding,
                "native-required-browser-only",
                "Browser-only worker",
                1,
                job_id,
                now_millis(),
            )
            .expect("scoped Browser worker");
        assert_eq!(
            app.agent_helper.online_worker_counts(&owner, now_millis()),
            (0, 1)
        );

        let baseline_total = app.solver_pool.total_worker_tokens();
        let baseline_available = app.solver_pool.available_worker_tokens();
        let response = solve_json(
            &app,
            native_required_automatic_request(job_id)
                .to_string()
                .as_bytes(),
            &owner,
        );
        let payload = response_payload(&response);
        assert_eq!(response_status(&response), 428);
        assert!(String::from_utf8_lossy(&response)
            .starts_with("HTTP/1.1 428 Precondition Required\r\n"));
        assert_eq!(payload["kind"], json!("native_agent_required"));
        assert_eq!(payload["nativeAgentRequired"], json!(true));
        assert_eq!(payload["jobId"], json!(job_id));
        assert_eq!(
            payload["downloadUrl"],
            json!("/downloads/TKBCherryAgent-Windows.zip")
        );
        assert!(!app.solver_pool.server_job_known_for_owner(job_id, &owner));
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
        assert_eq!(app.solver_pool.total_worker_tokens(), baseline_total);
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            baseline_available
        );
    }

    #[test]
    fn native_required_online_worker_no_show_is_an_explicit_start_failure() {
        let (app, token, owner) = agent_test_app();
        let job_id = "native-required-no-show";
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{
                    "agentId":"native-required-no-show-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        assert_eq!(response_payload(&hello)["agentEligible"], json!(true));

        let mut request = native_required_automatic_request(job_id);
        request["settings"]["backend_deadline_ms"] = json!(MIN_SOLVER_DEADLINE_MS);
        request["settings"]["native_global_deadline_ms"] = json!(MIN_SOLVER_DEADLINE_MS);
        request["settings"]["reference_watchdog_deadline_ms"] = json!(MIN_SOLVER_DEADLINE_MS);
        request["settings"]["native_deadline_reserve_ms"] = json!(0);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));

        let terminal_deadline = Instant::now() + Duration::from_secs(3);
        let terminal = loop {
            let response = solve_result_for_job_id_json(&app, job_id, &owner);
            if response_status(&response) == 428 {
                break response;
            }
            assert!(
                Instant::now() < terminal_deadline,
                "native-required no-show did not settle explicitly: {}",
                response_payload(&response)
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            response_payload(&terminal)["kind"],
            json!("native_agent_start_failed")
        );
        let completed = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("completed native-required no-show job");
        assert!(completed.native_agent_required);
        assert_eq!(completed.execution_phase, ServerExecutionPhase::Completed);
        assert_eq!(completed.execution_generation, 1);
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
    }

    #[test]
    fn native_required_disconnect_is_terminal_without_a_vps_generation() {
        let (app, token, owner) = agent_test_app();
        let job_id = "native-required-disconnect";
        let baseline_allocated = app.solver_pool.allocated_worker_tokens();
        let baseline_available = app.solver_pool.available_worker_tokens();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{
                    "agentId":"native-required-disconnect-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let hello_payload = response_payload(&hello);
        assert_eq!(hello_payload["agentEligible"], json!(true));
        let worker_token = hello_payload["workerToken"]
            .as_str()
            .expect("native worker token")
            .to_string();

        let started = solve_json(
            &app,
            native_required_automatic_request(job_id)
                .to_string()
                .as_bytes(),
            &owner,
        );
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        let initial = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("native-required server job");
        assert!(initial.native_agent_required);
        assert_eq!(initial.execution_generation, 1);
        assert_eq!(
            app.solver_pool.allocated_worker_tokens(),
            baseline_allocated
        );

        let browser_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":job_id,
                "agent":{
                    "agentId":"native-required-browser-rejected",
                    "version":MIN_BROWSER_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&browser_hello), 409);
        assert_eq!(
            response_payload(&browser_hello)["kind"],
            json!("browser_wasm_refinement_required")
        );
        assert_eq!(
            app.agent_helper.online_worker_counts(&owner, now_millis()),
            (1, 0)
        );

        let lease = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"native-required-disconnect-lease-0001",
                "agent":{
                    "agentId":"native-required-disconnect-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":5
            })),
        );
        assert_eq!(response_status(&lease), 200);
        let lease_payload = response_payload(&lease);
        assert_eq!(lease_payload["lease"]["jobId"], json!(job_id));
        assert!(lease_payload["lease"]["payload"]["settings"]
            .get("browser_wasm_server_lease")
            .is_none());

        let running_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = app
                .solver_pool
                .server_execution_snapshot(job_id, &owner)
                .expect("native-required execution snapshot");
            if snapshot.phase == ServerExecutionPhase::AgentRunning {
                assert_eq!(snapshot.generation, 1);
                break;
            }
            assert!(
                Instant::now() < running_deadline,
                "native-required lease did not become authoritative: {snapshot:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let disconnected = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/disconnect",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agent":{
                    "agentId":"native-required-disconnect-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                }
            })),
        );
        assert_eq!(response_status(&disconnected), 200);

        let terminal_deadline = Instant::now() + Duration::from_secs(2);
        let terminal = loop {
            let response = solve_result_for_job_id_json(&app, job_id, &owner);
            if response_status(&response) == 428 {
                break response;
            }
            assert!(
                Instant::now() < terminal_deadline,
                "native-required disconnect did not settle explicitly: {}",
                response_payload(&response)
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            response_payload(&terminal)["kind"],
            json!("native_agent_disconnected")
        );
        let completed = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("completed native-required job");
        assert!(completed.native_agent_required);
        assert_eq!(completed.execution_phase, ServerExecutionPhase::Completed);
        assert_eq!(
            completed.execution_generation, 1,
            "a VPS fallback would have advanced the canonical generation"
        );
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(
            app.solver_pool.allocated_worker_tokens(),
            baseline_allocated
        );
        assert_eq!(
            app.solver_pool.available_worker_tokens(),
            baseline_available
        );
    }

    #[test]
    fn native_required_quality_failure_is_terminal_without_vps_rescue() {
        let (app, token, owner) = agent_test_app();
        let job_id = "native-required-quality-unmet";
        let binding = agent_session_binding(&token);
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{
                    "agentId":"native-required-quality-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("native worker token")
            .to_string();

        let started = solve_json(
            &app,
            native_required_automatic_request(job_id)
                .to_string()
                .as_bytes(),
            &owner,
        );
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));
        let lease = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"native-required-quality-lease-0001",
                "agent":{
                    "agentId":"native-required-quality-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":5
            })),
        );
        assert_eq!(response_status(&lease), 200);
        let lease_id = response_payload(&lease)["lease"]["leaseId"]
            .as_str()
            .expect("native lease id")
            .to_string();
        let work_id = app
            .agent_helper
            .work_id_for_lease(&owner, &binding, &worker_token, &lease_id, now_millis())
            .expect("native work id");
        let rough_candidate = json!({
            "ok":true,
            "lessons":[
                {"classId":"6A","subject":"Math"},
                {"classId":"6A","subject":"Literature"}
            ],
            "unassignedLessons":[],
            "metrics":{
                "scheduled_periods":2,
                "expected_periods":2,
                "unassigned_periods":0,
                "app_constraint_violation_count":0,
                "hard_ok":true,
                "one_period_teacher_sessions":1,
                "teacher_gap2_sessions":0,
                "gap_distribution":{"1":0}
            },
            "validation":{"hard_ok":true},
            "solver":{"backend":"hybrid-python-reference"}
        });
        assert!(app
            .agent_helper
            .accept_submission(
                &owner,
                &binding,
                &worker_token,
                &work_id,
                &lease_id,
                rough_candidate,
                [1, 0, 2, 0],
                now_millis(),
            )
            .expect("accepted native result"));

        let terminal_deadline = Instant::now() + Duration::from_secs(2);
        let terminal = loop {
            let response = solve_result_for_job_id_json(&app, job_id, &owner);
            if response_status(&response) == 428 {
                break response;
            }
            assert!(
                Instant::now() < terminal_deadline,
                "native-required quality failure did not settle explicitly: {}",
                response_payload(&response)
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            response_payload(&terminal)["kind"],
            json!("native_agent_quality_unmet")
        );
        let completed = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("completed native-required job");
        assert!(completed.native_agent_required);
        assert_eq!(completed.execution_phase, ServerExecutionPhase::Completed);
        assert_eq!(completed.execution_generation, 1);
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
    }

    #[test]
    fn browser_worker_yields_first_claim_to_available_native_cp_sat_agent() {
        let (app, token, owner) = agent_test_app();
        let native_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"native-cp-sat-first","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&native_hello), 200);
        let native_token = response_payload(&native_hello)["workerToken"]
            .as_str()
            .expect("native worker token")
            .to_string();

        let mut request = browser_ready_refinement_request("native-cp-sat-first-job");
        request["settings"]["optimization_focus"] = json!("sessions");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        let priority_deadline = Instant::now() + Duration::from_millis(1_000);
        loop {
            if app.agent_helper.native_worker_priority_available(
                &owner,
                "native-cp-sat-first-job",
                now_millis().saturating_add(4_000),
            ) {
                break;
            }
            assert!(
                Instant::now() < priority_deadline,
                "native Agent job did not become visible to the claim gate"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let browser_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":"native-cp-sat-first-job",
                "agent":{"agentId":"browser-cp-sat-fallback","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&browser_hello), 200);
        let browser_token = response_payload(&browser_hello)["workerToken"]
            .as_str()
            .expect("browser worker token")
            .to_string();
        let browser_claim = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":browser_token,
                "jobId":"native-cp-sat-first-job",
                "leaseRequestId":"browser-yields-native-0001",
                "agent":{"agentId":"browser-cp-sat-fallback","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&browser_claim), 200);
        assert_eq!(response_payload(&browser_claim)["lease"], Value::Null);
        assert_eq!(
            response_payload(&browser_claim)["nativePreferred"],
            json!(true)
        );

        let native_claim = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":native_token,
                "leaseRequestId":"native-claims-cp-sat-0001",
                "agent":{"agentId":"native-cp-sat-first","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":0
            })),
        );
        assert_eq!(response_status(&native_claim), 200);
        assert_eq!(
            response_payload(&native_claim)["lease"]["jobId"],
            json!("native-cp-sat-first-job")
        );
        assert!(
            response_payload(&native_claim)["lease"]["payload"]["settings"]
                .get("browser_wasm_server_lease")
                .is_none()
        );

        let cancelled = solve_cancel_json(&app, br#"{"jobId":"native-cp-sat-first-job"}"#, &owner);
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn browser_lease_replay_survives_a_native_agent_appearing_after_claim() {
        let (app, token, owner) = agent_test_app();
        let mut request = browser_ready_refinement_request("browser-replay-before-native");
        request["settings"]["optimization_focus"] = json!("sessions");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);

        let browser_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":"browser-replay-before-native",
                "agent":{"agentId":"browser-replay-worker","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&browser_hello), 200);
        let browser_token = response_payload(&browser_hello)["workerToken"]
            .as_str()
            .expect("browser worker token")
            .to_string();
        let lease_request = agent_protocol_body(json!({
            "workerToken":browser_token,
            "jobId":"browser-replay-before-native",
            "leaseRequestId":"browser-replay-before-native-0001",
            "agent":{"agentId":"browser-replay-worker","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
            "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
            "waitSeconds":1
        }));
        let first = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            lease_request.clone(),
        );
        assert_eq!(response_status(&first), 200);
        let first_lease = response_payload(&first)["lease"].clone();
        assert_eq!(first_lease["jobId"], json!("browser-replay-before-native"));
        assert_eq!(
            first_lease["payload"]["settings"]["browser_wasm_server_lease"],
            json!(true)
        );

        let native_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"native-after-browser-claim","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&native_hello), 200);

        // Repeat the same request with deliberately stale advisory fields.
        // Server-recorded scope must still identify this as Browser WASM and
        // replay the same lease before applying native-first priority. Its
        // remaining canonical watchdog may only shrink between HTTP retries.
        let mut replay_request = lease_request;
        replay_request["agent"]["platform"] = json!("windows");
        replay_request.as_object_mut().unwrap().remove("jobId");
        let replay = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            replay_request,
        );
        assert_eq!(response_status(&replay), 200);
        let replay_lease = response_payload(&replay)["lease"].clone();
        assert_eq!(replay_lease["leaseId"], first_lease["leaseId"]);
        assert_eq!(replay_lease["attempt"], first_lease["attempt"]);
        assert_eq!(
            replay_lease["payload"]["data"],
            first_lease["payload"]["data"]
        );
        assert_eq!(
            replay_lease["payload"]["settings"]["solve_run_id"],
            first_lease["payload"]["settings"]["solve_run_id"]
        );
        assert_eq!(
            replay_lease["payload"]["settings"]["random_seed"],
            first_lease["payload"]["settings"]["random_seed"]
        );
        let first_watchdog = first_lease["payload"]["settings"]["reference_watchdog_deadline_ms"]
            .as_u64()
            .expect("first remaining watchdog");
        let replay_watchdog = replay_lease["payload"]["settings"]["reference_watchdog_deadline_ms"]
            .as_u64()
            .expect("replayed remaining watchdog");
        assert!(replay_watchdog <= first_watchdog);
        assert!(first_watchdog.saturating_sub(replay_watchdog) <= 1_000);

        let cancelled =
            solve_cancel_json(&app, br#"{"jobId":"browser-replay-before-native"}"#, &owner);
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn explicit_agent_off_uses_vps_even_when_native_agent_is_online() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"agent-off-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);

        let mut request = browser_ready_refinement_request("agent-off-vps");
        request["settings"]["optimization_focus"] = json!("automatic");
        request["settings"]["ui_agent_preference_enabled"] = json!(false);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("vps"));
        assert_eq!(started_payload["executionPhase"], json!("vps_running"));
        assert!(started_payload["requiredWorkers"].as_u64().unwrap_or(0) > 0);

        let completed = wait_for_server_result(&app, "agent-off-vps", &owner);
        assert_eq!(response_status(&completed), 200);
        app.solver_pool.abandon_server_job("agent-off-vps", &owner);
    }

    #[test]
    fn late_agent_hello_cannot_take_an_explicit_vps_only_job() {
        let (app, token, owner) = agent_test_app();
        let blocker = app
            .solver_pool
            .try_acquire(
                "agent-off-late-hello-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let mut request = browser_ready_refinement_request("agent-off-late-hello");
        request["settings"]["optimization_focus"] = json!("automatic");
        request["settings"]["ui_agent_preference_enabled"] = json!(false);

        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("vps"));
        assert_eq!(
            response_payload(&started)["executionPhase"],
            json!("vps_queued")
        );

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"late-agent-off-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        assert_eq!(response_payload(&hello)["handoffJobIds"], json!([]));
        let state = response_payload(&solver_state_json(
            &app,
            "jobId=agent-off-late-hello",
            &owner,
        ));
        assert_eq!(state["requestedJobExecutor"], json!("vps"));
        assert_eq!(state["requestedJobExecutionPhase"], json!("vps_queued"));

        app.solver_pool
            .abandon_server_job("agent-off-late-hello", &owner);
        drop(blocker);
    }

    #[test]
    fn ready_browser_sessions_spills_to_local_agent_while_vps_workers_are_busy() {
        let (app, _token, owner) = agent_test_app();
        let blocker = app
            .solver_pool
            .try_acquire(
                "browser-sessions-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        assert_eq!(app.solver_pool.available_worker_tokens(), 0);
        let mut request = browser_ready_refinement_request("browser-ready-sessions-spillover");
        request["settings"]["optimization_focus"] = json!("sessions");
        let body = request.to_string();

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"browser-ready-sessions-spillover"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        drop(blocker);
    }

    #[test]
    fn ready_browser_automatic_fresh_starts_agent_before_vps() {
        let (app, _token, owner) = agent_test_app();
        let request = browser_ready_automatic_fresh_request("browser-ready-automatic-fresh");
        let body = request.to_string();
        assert!(agent_helper::browser_refinement_request_eligible(
            body.as_bytes()
        ));

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(
            started_payload["jobId"],
            json!("browser-ready-automatic-fresh")
        );
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"browser-ready-automatic-fresh"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn ready_browser_cp_sat_claims_rich_fresh_automatic_and_keeps_its_lease() {
        let (app, token, owner) = agent_test_app();
        let job_id = "browser-cpsat-rich-fresh";
        let request = browser_ready_cp_sat_automatic_fresh_request(job_id);
        let body = request.to_string();
        assert!(!agent_helper::browser_refinement_request_eligible(
            body.as_bytes()
        ));
        assert!(agent_helper::browser_cp_sat_request_eligible(
            body.as_bytes()
        ));

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let heuristic_hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":job_id,
                "agent":{
                    "agentId":"browser-heuristic-rich-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&heuristic_hello), 409);
        assert_eq!(
            response_payload(&heuristic_hello)["kind"],
            json!("browser_wasm_refinement_required")
        );

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":job_id,
                "agent":{
                    "agentId":"browser-cpsat-rich-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"web-cpsat-wasm"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("exact Browser CP-SAT worker token")
            .to_string();
        let lease_response = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "jobId":job_id,
                "leaseRequestId":"browser-cpsat-rich-lease-0001",
                "agent":{
                    "agentId":"browser-cpsat-rich-worker",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"web-cpsat-wasm"
                },
                "capacity":{"cpuWorkers":6,"maxConcurrentJobs":1},
                "waitSeconds":1
            })),
        );
        assert_eq!(response_status(&lease_response), 200);
        let lease_id = response_payload(&lease_response)["lease"]["leaseId"]
            .as_str()
            .expect("exact Browser CP-SAT lease")
            .to_string();

        let heartbeat = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/heartbeat"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"browser-cpsat-rich-worker",
                "jobId":job_id,
                "leaseId":lease_id
            })),
        );
        assert_eq!(response_status(&heartbeat), 200);
        assert_eq!(response_payload(&heartbeat)["renewed"], json!(true));

        let running_deadline = Instant::now() + Duration::from_millis(1_500);
        let running = loop {
            let state =
                response_payload(&solver_state_json(&app, &format!("jobId={job_id}"), &owner));
            if state["requestedJobExecutionPhase"] == json!("agent_running") {
                break state;
            }
            assert!(
                Instant::now() < running_deadline,
                "exact Browser CP-SAT lease did not become AgentRunning"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(running["requestedJobExecutor"], json!("agent"));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let cancelled = solve_cancel_json(
            &app,
            format!(r#"{{"jobId":"{job_id}"}}"#).as_bytes(),
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn ready_browser_automatic_constraint_repair_starts_agent_before_vps() {
        let (app, _token, owner) = agent_test_app();
        let request = browser_ready_automatic_constraint_repair_request(
            "browser-ready-automatic-constraint-repair",
        );
        let body = request.to_string();
        assert!(agent_helper::browser_refinement_request_eligible(
            body.as_bytes()
        ));

        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"browser-ready-automatic-constraint-repair"}"#,
            &owner,
        );
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
    }

    #[test]
    fn browser_required_no_show_is_terminal_without_a_vps_generation() {
        let (app, _token, owner) = agent_test_app();
        let job_id = "browser-required-no-show";
        let started = solve_json(
            &app,
            browser_required_quick_request(job_id)
                .to_string()
                .as_bytes(),
            &owner,
        );
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));

        let terminal_deadline =
            Instant::now() + Duration::from_millis(AGENT_CLAIM_GRACE_MS + 1_500);
        let terminal = loop {
            let response = solve_result_for_job_id_json(&app, job_id, &owner);
            if response_status(&response) == 428 {
                break response;
            }
            assert!(
                Instant::now() < terminal_deadline,
                "Browser-required no-show did not become terminal: {}",
                response_payload(&response)
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            response_payload(&terminal)["kind"],
            json!("browser_agent_disconnected")
        );
        let completed = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("completed Browser-required no-show job");
        assert!(completed.browser_agent_required);
        assert_eq!(completed.execution_phase, ServerExecutionPhase::Completed);
        assert_eq!(
            completed.execution_generation, 1,
            "a VPS fallback would advance the canonical generation"
        );
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
    }

    #[test]
    fn browser_required_fail_is_terminal_and_never_requeues_to_vps() {
        let (app, token, owner) = agent_test_app();
        let job_id = "browser-required-explicit-fail";
        let started = solve_json(
            &app,
            browser_required_quick_request(job_id)
                .to_string()
                .as_bytes(),
            &owner,
        );
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":job_id,
                "agent":{
                    "agentId":"browser-required-failure-worker",
                    "version":MIN_BROWSER_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("Browser worker token")
            .to_string();
        let leased = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"browser-required-failure-lease-0001",
                "agent":{
                    "agentId":"browser-required-failure-worker",
                    "version":MIN_BROWSER_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":1
            })),
        );
        assert_eq!(response_status(&leased), 200);
        let lease_id = response_payload(&leased)["lease"]["leaseId"]
            .as_str()
            .expect("Browser lease ID")
            .to_string();

        let failed = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/fail"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"browser-required-failure-worker",
                "jobId":job_id,
                "leaseId":lease_id,
                "kind":"browser_wasm_oom",
                "noCompleteCheckpoint":true
            })),
        );
        assert_eq!(response_status(&failed), 202);
        let failed_payload = response_payload(&failed);
        assert_eq!(failed_payload["requeued"], json!(false));
        assert_eq!(failed_payload["terminal"], json!(true));
        assert_eq!(failed_payload["vpsFallback"], json!(false));

        let terminal = solve_result_for_job_id_json(&app, job_id, &owner);
        assert_eq!(response_status(&terminal), 428);
        assert_eq!(
            response_payload(&terminal)["kind"],
            json!("browser_agent_failed")
        );
        let completed = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("completed Browser-required failure job");
        assert!(completed.browser_agent_required);
        assert_eq!(completed.execution_phase, ServerExecutionPhase::Completed);
        assert_eq!(completed.execution_generation, 1);
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
    }

    #[test]
    fn browser_required_disconnect_after_lease_never_starts_vps() {
        let (app, token, owner) = agent_test_app();
        let job_id = "browser-required-disconnect";
        let started = solve_json(
            &app,
            browser_required_quick_request(job_id)
                .to_string()
                .as_bytes(),
            &owner,
        );
        assert_eq!(response_status(&started), 202);

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":job_id,
                "agent":{
                    "agentId":"browser-required-disconnect-worker",
                    "version":MIN_BROWSER_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("Browser worker token")
            .to_string();
        let leased = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"browser-required-disconnect-lease-0001",
                "agent":{
                    "agentId":"browser-required-disconnect-worker",
                    "version":MIN_BROWSER_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":1
            })),
        );
        assert_eq!(response_status(&leased), 200);
        assert_eq!(response_payload(&leased)["lease"]["jobId"], json!(job_id));

        let running_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = app
                .solver_pool
                .server_execution_snapshot(job_id, &owner)
                .expect("Browser-required execution snapshot");
            if snapshot.phase == ServerExecutionPhase::AgentRunning {
                assert_eq!(snapshot.generation, 1);
                break;
            }
            assert!(
                Instant::now() < running_deadline,
                "Browser-required lease did not become authoritative: {snapshot:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let disconnected = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/disconnect",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agent":{
                    "agentId":"browser-required-disconnect-worker",
                    "version":MIN_BROWSER_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                }
            })),
        );
        assert_eq!(response_status(&disconnected), 200);

        let terminal_deadline = Instant::now() + Duration::from_secs(2);
        let terminal = loop {
            let response = solve_result_for_job_id_json(&app, job_id, &owner);
            if response_status(&response) == 428 {
                break response;
            }
            assert!(
                Instant::now() < terminal_deadline,
                "Browser-required disconnect did not settle: {}",
                response_payload(&response)
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            response_payload(&terminal)["kind"],
            json!("browser_agent_disconnected")
        );
        let completed = app
            .solver_pool
            .server_job_snapshots_for_owner(&owner)
            .into_iter()
            .find(|snapshot| snapshot.job_id == job_id)
            .expect("completed Browser-required disconnect job");
        assert!(completed.browser_agent_required);
        assert_eq!(completed.execution_phase, ServerExecutionPhase::Completed);
        assert_eq!(completed.execution_generation, 1);
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);
    }

    #[test]
    fn ready_browser_quick_no_show_falls_back_to_vps_on_the_same_job_after_grace() {
        let (app, _token, owner) = agent_test_app();
        let blocker = app
            .solver_pool
            .try_acquire(
                "browser-no-show-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let baseline_allocated = app.solver_pool.allocated_worker_tokens();
        let request = browser_ready_quick_request("browser-ready-no-show", false);
        let body = request.to_string();

        let started_at = Instant::now();
        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        assert_eq!(started_payload["requiredWorkers"], json!(0));
        assert_eq!(
            app.solver_pool.allocated_worker_tokens(),
            baseline_allocated,
            "the readiness fast path must not allocate VPS tokens before claim grace"
        );
        let canonical_started_at_ms = started_payload["startedAtMs"]
            .as_u64()
            .expect("browser-ready job must expose canonical startedAtMs");

        let fallback_deadline =
            Instant::now() + Duration::from_millis(AGENT_CLAIM_GRACE_MS + 1_500);
        let fallback_state = loop {
            let state = response_payload(&solver_state_json(
                &app,
                "jobId=browser-ready-no-show",
                &owner,
            ));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "browser no-show did not fall back to VPS within bounded claim grace: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert!(
            started_at.elapsed() >= Duration::from_millis(AGENT_CLAIM_GRACE_MS),
            "VPS must not race the browser before its bounded claim grace expires"
        );
        assert_eq!(
            fallback_state["requestedJobId"],
            json!("browser-ready-no-show")
        );
        assert_eq!(fallback_state["requestedJobServerOwned"], json!(true));
        assert_eq!(
            fallback_state["requestedJobStartedAtMs"],
            json!(canonical_started_at_ms),
            "Agent-to-VPS fallback must retain the same canonical job"
        );

        drop(blocker);
        // This test app deliberately has no reference-solver runtime. The
        // asserted contract is the same canonical job returning to the VPS
        // queue; production completion is covered by staging and browser E2E.
        app.solver_pool
            .abandon_server_job("browser-ready-no-show", &owner);
    }

    #[test]
    fn failed_browser_quick_lease_returns_the_same_job_to_vps() {
        let (app, token, owner) = agent_test_app();
        let blocker = app
            .solver_pool
            .try_acquire(
                "browser-quick-failure-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let request = browser_ready_quick_request("browser-ready-quick-failure", false);
        let body = request.to_string();
        let started = solve_json(&app, body.as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        let canonical_started_at_ms = started_payload["startedAtMs"]
            .as_u64()
            .expect("Quick job must expose canonical startedAtMs");

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":"browser-ready-quick-failure",
                "agent":{"agentId":"web-quick-failure","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("worker token")
            .to_string();
        let leased = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "leaseRequestId":"browser-quick-failure-lease-1",
                "agent":{"agentId":"web-quick-failure","version":MIN_AGENT_HELPER_VERSION,"platform":"web-wasm"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":1
            })),
        );
        assert_eq!(response_status(&leased), 200);
        let lease_payload = response_payload(&leased);
        let lease_id = lease_payload["lease"]["leaseId"]
            .as_str()
            .expect("lease id")
            .to_string();
        let lease_settings = &lease_payload["lease"]["payload"]["settings"];
        assert_eq!(lease_settings["require_complete_schedule"], json!(true));
        assert_eq!(lease_settings["best_effort_on_timeout"], json!(false));
        assert_eq!(
            lease_settings["native_skip_teacher_optimization"],
            json!(true)
        );
        assert_eq!(lease_settings["browser_wasm_quick_attempt"], json!(true));
        assert_eq!(lease_settings["backend_deadline_ms"], json!(12_000));
        assert_eq!(lease_settings["native_global_deadline_ms"], json!(12_000));
        assert_eq!(lease_settings["native_deadline_reserve_ms"], json!(750));
        assert_eq!(lease_settings["optimize_existing_schedule"], json!(false));
        assert_eq!(lease_settings["force_fresh_backend_solve"], json!(true));
        assert!(lease_settings.get("browser_wasm_refinement").is_none());

        let agent_started_at_ms = app
            .solver_pool
            .server_job_watchdog_snapshot("browser-ready-quick-failure", &owner)
            .and_then(|(_, started)| started)
            .expect("Agent watchdog start");
        thread::sleep(Duration::from_millis(5));

        let failed = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{lease_id}/fail"),
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agentId":"web-quick-failure",
                "jobId":"browser-ready-quick-failure",
                "leaseId":lease_id,
                "kind":"browser_wasm_failed",
                "noCompleteCheckpoint":true
            })),
        );
        assert_eq!(response_status(&failed), 202);
        let failed_payload = response_payload(&failed);
        assert_eq!(failed_payload["requeued"], json!(true));
        assert_eq!(failed_payload["freshVpsRescueArmed"], json!(false));
        assert!(!app
            .solver_pool
            .server_job_agent_preference_enabled("browser-ready-quick-failure", &owner));

        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        let fallback_state = loop {
            let state = response_payload(&solver_state_json(
                &app,
                "jobId=browser-ready-quick-failure",
                &owner,
            ));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "failed Quick lease did not return to VPS: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            fallback_state["requestedJobId"],
            json!("browser-ready-quick-failure")
        );
        assert_eq!(
            fallback_state["requestedJobStartedAtMs"],
            json!(canonical_started_at_ms)
        );
        let rescued_started_at_ms = app
            .solver_pool
            .server_job_watchdog_snapshot("browser-ready-quick-failure", &owner)
            .and_then(|(_, started)| started)
            .expect("rescued VPS watchdog start");
        assert_eq!(
            rescued_started_at_ms, agent_started_at_ms,
            "Quick failure must keep the original canonical watchdog"
        );

        drop(blocker);
        // Completion needs the production reference-solver runtime; this unit
        // contract ends once the same canonical job is back in the VPS queue.
        app.solver_pool
            .abandon_server_job("browser-ready-quick-failure", &owner);
    }

    #[test]
    fn structured_cpsat_unknown_discards_rough_checkpoint_and_restarts_fresh_vps() {
        let (app, token, owner) = agent_test_app();
        let binding = agent_session_binding(&token);
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "cpsat-unknown-browser",
                "CP-SAT UNKNOWN Browser",
                1,
                now_millis(),
            )
            .expect("Browser Agent worker");
        let blocker = app
            .solver_pool
            .try_acquire(
                "cpsat-unknown-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let job_id = "browser-cpsat-unknown-fresh-vps";
        let request = browser_ready_cp_sat_automatic_fresh_request(job_id);
        assert!(request["data"].get("tkbSolverResult").is_none());

        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["jobId"], json!(job_id));
        assert_eq!(started_payload["executor"], json!("agent"));

        let lease_deadline = Instant::now() + Duration::from_millis(1_000);
        let lease = loop {
            match app
                .agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            {
                Ok(lease) => break lease,
                Err(AgentHelperError::NoWork) => {
                    assert!(
                        Instant::now() < lease_deadline,
                        "Fresh Automatic Agent task was not registered"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Browser Agent lease failed: {error:?}"),
            }
        };
        let rough_checkpoint = json!({
            "ok":true,
            "marker":"rough-before-cpsat-unknown",
            "lessons":[{"classId":"6A"}],
            "unassignedLessons":[],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":1,
                "unassigned_periods":0,
                "app_constraint_violation_count":0,
                "hard_ok":true,
                "one_period_teacher_sessions":2,
                "teacher_gap2_sessions":1,
                "gap_distribution":{"1":1,"2":1}
            },
            "validation":{"hard_ok":true}
        });
        assert!(app
            .agent_helper
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                rough_checkpoint,
                [2, 1, 1, 3],
                now_millis(),
            )
            .expect("rough checkpoint accepted for recovery"));
        assert_eq!(
            app.agent_helper
                .best_candidate(job_id, &owner)
                .expect("accepted rough checkpoint")
                .payload["marker"],
            json!("rough-before-cpsat-unknown")
        );
        let agent_started_at_ms = app
            .solver_pool
            .server_job_watchdog_snapshot(job_id, &owner)
            .and_then(|(_, started)| started)
            .expect("Agent watchdog start");
        thread::sleep(Duration::from_millis(5));

        let failed = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{}/fail", lease.lease_token),
            agent_protocol_body(json!({
                "workerToken":worker.worker_token,
                "agentId":"cpsat-unknown-browser",
                "jobId":job_id,
                "leaseId":lease.lease_token,
                "kind":"browser_wasm_quality_unknown_fresh_vps",
                "freshVpsFromScratch":true
            })),
        );
        assert_eq!(response_status(&failed), 202);
        let failed_payload = response_payload(&failed);
        assert_eq!(failed_payload["requeued"], json!(true));
        assert_eq!(failed_payload["freshVpsRescueArmed"], json!(true));
        assert_eq!(failed_payload["freshVpsFromScratch"], json!(true));
        assert!(
            app.agent_helper.best_candidate(job_id, &owner).is_none(),
            "CP-SAT UNKNOWN must discard the rough recovery checkpoint"
        );

        // This is the same request-update path used immediately before the VPS
        // executor starts. With the rejected checkpoint absent, it must leave
        // the canonical Fresh request free of any incumbent payload.
        let mut vps_body = Arc::new(serde_json::to_vec(&request).expect("Fresh request body"));
        let mut vps_request = Some(request.clone());
        apply_agent_checkpoint_to_server_request(
            &mut vps_body,
            &mut vps_request,
            app.agent_helper
                .best_candidate(job_id, &owner)
                .map(|candidate| candidate.payload),
        );
        let vps_request: Value = serde_json::from_slice(&vps_body).expect("Fresh VPS request body");
        assert!(vps_request["data"].get("tkbSolverResult").is_none());
        assert_eq!(
            vps_request["settings"]["ui_unified_solve_kind"],
            json!("fresh_complete_first")
        );
        assert_eq!(
            vps_request["settings"]["optimization_focus"],
            json!("automatic")
        );
        assert_eq!(
            vps_request["settings"]["force_fresh_backend_solve"],
            json!(true)
        );

        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        let fallback_state = loop {
            let state =
                response_payload(&solver_state_json(&app, &format!("jobId={job_id}"), &owner));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "CP-SAT UNKNOWN did not return the same Fresh job to VPS: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(fallback_state["requestedJobId"], json!(job_id));
        assert!(
            fallback_state["requestedJobWatchdogRemainingMs"]
                .as_u64()
                .unwrap_or(0)
                > 0,
            "Fresh VPS rescue must receive a renewed bounded watchdog"
        );
        let rescued_started_at_ms = app
            .solver_pool
            .server_job_watchdog_snapshot(job_id, &owner)
            .and_then(|(_, started)| started)
            .expect("rescued VPS watchdog start");
        assert!(
            rescued_started_at_ms > agent_started_at_ms,
            "Fresh VPS rescue must rebase the Agent watchdog for its bounded attempt"
        );
        assert!(app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .is_none());

        app.solver_pool.abandon_server_job(job_id, &owner);
        drop(blocker);
    }

    #[test]
    fn online_agent_gets_the_canonical_job_without_vps_allocation() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"exclusive-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);

        let request = async_preserved_request("agent-only-canonical");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        let started_payload = response_payload(&started);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        let canonical_started_at_ms = started_payload["startedAtMs"]
            .as_u64()
            .expect("Agent-owned start response must expose canonical startedAtMs");
        assert!(canonical_started_at_ms >= 1_000_000_000_000);
        assert_eq!(app.solver_pool.active_count(), 0);
        assert_eq!(app.solver_pool.allocated_worker_tokens(), 0);

        let running = solve_result_for_job_id_json(&app, "agent-only-canonical", &owner);
        assert_eq!(response_status(&running), 202);
        let running_payload = response_payload(&running);
        assert_eq!(running_payload["executor"], json!("agent"));
        assert_eq!(running_payload["running"], json!(true));
        assert_eq!(
            running_payload["startedAtMs"],
            json!(canonical_started_at_ms),
            "solve-result must use the same timestamp as the initial Agent response"
        );

        let owner_state = solver_state_json(&app, "jobId=agent-only-canonical", &owner);
        let owner_state_payload = response_payload(&owner_state);
        assert_eq!(owner_state_payload["requestedJobServerOwned"], json!(true));
        assert_eq!(owner_state_payload["requestedJobActive"], json!(true));
        assert_eq!(owner_state_payload["requestedJobExecutor"], json!("agent"));
        assert_eq!(
            owner_state_payload["requestedJobStartedAtMs"],
            json!(canonical_started_at_ms)
        );
        let visible_job = owner_state_payload["jobs"]
            .as_array()
            .and_then(|jobs| {
                jobs.iter()
                    .find(|job| job["jobId"] == json!("agent-only-canonical"))
            })
            .expect("Agent-owned canonical job must stay visible after reload");
        assert_eq!(visible_job["serverOwned"], json!(true));
        assert_eq!(visible_job["executor"], json!("agent"));
        assert_eq!(visible_job["startedAtMs"], json!(canonical_started_at_ms));

        let cancelled = solve_cancel_json(&app, br#"{"jobId":"agent-only-canonical"}"#, &owner);
        assert_eq!(response_payload(&cancelled)["cancelRequested"], json!(true));
        for _ in 0..100 {
            if !app
                .solver_pool
                .server_job_known_for_owner("agent-only-canonical", &owner)
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(!app
            .solver_pool
            .server_job_known_for_owner("agent-only-canonical", &owner));
    }

    #[test]
    fn mobile_local_quality_terminal_agent_candidate_completes_without_vps() {
        let (app, _token, owner) = agent_test_app();
        let binding = agent_session_binding("rough-terminal-agent-session");
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "rough-terminal-agent",
                "Rough terminal Agent",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let blocker = app
            .solver_pool
            .try_acquire(
                "rough-terminal-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let job_id = "rough-fresh-terminal-agent";
        let request = browser_ready_automatic_fresh_request(job_id);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));

        let lease_deadline = Instant::now() + Duration::from_millis(1_000);
        let lease = loop {
            match app
                .agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            {
                Ok(lease) => break lease,
                Err(AgentHelperError::NoWork) => {
                    assert!(
                        Instant::now() < lease_deadline,
                        "Agent task was not registered"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Agent lease failed: {error:?}"),
            }
        };
        let rough = json!({
            "ok":true,
            "marker":"rough-terminal-warm-start",
            "lessons":[
                {"classId":"6A","subject":"Math"},
                {"classId":"6A","subject":"Literature"}
            ],
            "unassignedLessons":[],
            "metrics":{
                "scheduled_periods":2,
                "expected_periods":2,
                "unassigned_periods":0,
                "app_constraint_violation_count":0,
                "hard_ok":true,
                "one_period_teacher_sessions":2,
                "teacher_gap2_sessions":1,
                "gap_distribution":{"1":1,"2":1}
            },
            "validation":{"hard_ok":true},
            "solver":{
                "backend":"browser-wasm",
                "runtime_settings":{
                    "mobile_local_quality_terminal":true,
                    "quality_debt_retained":true
                }
            },
            "mobile_local_quality_terminal":true,
            "quality_debt_retained":true
        });
        let mut checkpoint = rough.clone();
        checkpoint
            .as_object_mut()
            .expect("checkpoint payload")
            .remove("mobile_local_quality_terminal");
        checkpoint
            .as_object_mut()
            .expect("checkpoint payload")
            .remove("quality_debt_retained");
        checkpoint["solver"]["runtime_settings"] = json!({
            "browser_mobile_checkpoint_vps_refine": true,
            "quality_debt_retained": true
        });
        assert!(app
            .agent_helper
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                checkpoint,
                [2, 1, 2, 3],
                now_millis(),
            )
            .expect("unmarked equal-quality checkpoint accepted"));
        assert!(app
            .agent_helper
            .accept_submission(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                rough.clone(),
                [2, 1, 2, 3],
                now_millis(),
            )
            .expect("equal-quality marked terminal result must replace the checkpoint"));
        assert!(browser_mobile_local_quality_terminal(&rough));

        let result_deadline = Instant::now() + Duration::from_millis(1_500);
        let response = loop {
            let response = solve_result_for_job_id_json(&app, job_id, &owner);
            if response_status(&response) == 200 {
                break response;
            }
            assert!(
                Instant::now() < result_deadline,
                "mobile terminal candidate did not complete locally: {} {}",
                response_status(&response),
                response_payload(&response)
            );
            thread::sleep(Duration::from_millis(10));
        };
        let result_payload = response_payload(&response);
        assert_eq!(result_payload["mobile_local_quality_terminal"], json!(true));
        assert_eq!(result_payload["quality_debt_retained"], json!(true));
        assert_eq!(
            app.solver_pool.active_count(),
            1,
            "the exclusive test blocker must remain the only VPS allocation"
        );
        assert!(app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .is_some());
        app.solver_pool.abandon_server_job(job_id, &owner);
        drop(blocker);
    }

    #[test]
    fn disabled_agent_hands_its_checkpoint_to_vps_without_completing_the_job() {
        let (app, token, owner) = agent_test_app();
        let binding = agent_session_binding(&token);
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "checkpoint-resume-pc",
                "Checkpoint resume PC",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let blocker = app
            .solver_pool
            .try_acquire(
                "checkpoint-resume-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let request = async_preserved_request("agent-checkpoint-vps-resume");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));
        let canonical_started_at_ms = response_payload(&started)["startedAtMs"]
            .as_u64()
            .expect("canonical start timestamp");

        let lease_deadline = Instant::now() + Duration::from_millis(1_000);
        let lease = loop {
            match app
                .agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            {
                Ok(lease) => break lease,
                Err(AgentHelperError::NoWork) => {
                    assert!(
                        Instant::now() < lease_deadline,
                        "Agent task was not registered"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Agent lease failed: {error:?}"),
            }
        };
        let checkpoint = json!({
            "ok":true,
            "marker":"validated-agent-checkpoint",
            "lessons":[{"classId":"6A"}],
            "unassignedLessons":[],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":1,
                "unassigned_periods":0,
                "hard_ok":true,
                "app_constraint_violation_count":0
            },
            "validation":{"hard_ok":true}
        });
        assert!(app
            .agent_helper
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                checkpoint,
                [0, 0, 1, 0],
                now_millis(),
            )
            .expect("accepted checkpoint"));
        let yielded = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{}/fail", lease.lease_token),
            agent_protocol_body(json!({
                "workerToken":worker.worker_token,
                "agentId":"checkpoint-resume-pc",
                "jobId":"agent-checkpoint-vps-resume",
                "leaseId":lease.lease_token,
                "kind":"browser_agent_disabled"
            })),
        );
        assert_eq!(response_status(&yielded), 202);
        assert_eq!(response_payload(&yielded)["requeued"], json!(true));
        assert!(!app
            .solver_pool
            .server_job_agent_preference_enabled("agent-checkpoint-vps-resume", &owner));

        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        let fallback_state = loop {
            let state = response_payload(&solver_state_json(
                &app,
                "jobId=agent-checkpoint-vps-resume",
                &owner,
            ));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "checkpoint did not resume on VPS: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            fallback_state["requestedJobStartedAtMs"],
            json!(canonical_started_at_ms)
        );
        assert!(app
            .solver_pool
            .completed_server_response_for_owner("agent-checkpoint-vps-resume", &owner)
            .is_none());
        app.solver_pool
            .abandon_server_job("agent-checkpoint-vps-resume", &owner);
        drop(blocker);
    }

    #[test]
    fn partial_agent_checkpoint_surrenders_the_same_job_without_a_reclaim_race() {
        let (app, token, owner) = agent_test_app();
        let binding = agent_session_binding(&token);
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "partial-checkpoint-race-pc",
                "Partial checkpoint race PC",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let mut blockers = Vec::new();
        loop {
            let desired_workers = app
                .solver_pool
                .available_worker_tokens()
                .min(app.solver_pool.max_workers_per_job());
            let blocker_id = format!("partial-checkpoint-race-vps-blocker-{}", blockers.len());
            match app.solver_pool.try_acquire(blocker_id, desired_workers) {
                Ok(blocker) => blockers.push(blocker),
                Err(()) => break,
            }
        }
        assert!(!blockers.is_empty(), "VPS capacity blocker");
        let job_id = "partial-checkpoint-race";
        let request = browser_ready_automatic_fresh_request(job_id);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));
        let canonical_started_at_ms = response_payload(&started)["startedAtMs"]
            .as_u64()
            .expect("canonical start timestamp");

        let lease_deadline = Instant::now() + Duration::from_millis(1_000);
        let lease = loop {
            match app
                .agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            {
                Ok(lease) => break lease,
                Err(AgentHelperError::NoWork) => {
                    assert!(
                        Instant::now() < lease_deadline,
                        "Agent task was not registered"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Agent lease failed: {error:?}"),
            }
        };
        let partial = json!({
            "ok":false,
            "kind":"no_complete_schedule_before_deadline",
            "error":"partial timetable retained for VPS continuation",
            "lessons":[{
                "classId":"6A",
                "className":"6A",
                "subject":"Math",
                "teacher":"Teacher 1",
                "room":"",
                "day":2,
                "session":"AM",
                "period":1,
                "fixed":false
            }],
            "unassignedLessons":[{"classId":"6A", "subject":"Literature", "periods":1}],
            "metrics":{
                "scheduled_periods":1,
                "expected_periods":2,
                "unassigned_periods":1,
                "app_constraint_violation_count":0,
                "hard_ok":false,
                "placement_hard_ok":true
            },
            "validation":{"hard_ok":false, "placement_hard_ok":true, "violations":[]}
        });
        let digest = agent_helper_result_digest(&partial).expect("partial digest");
        let checkpoint = agent_route(
            &app,
            Some(&token),
            &format!(
                "/api/agent-helper/v1/leases/{}/checkpoint",
                lease.lease_token
            ),
            agent_protocol_body(json!({
                "workerToken":worker.worker_token,
                "agentId":"partial-checkpoint-race-pc",
                "jobId":job_id,
                "leaseId":lease.lease_token,
                "sha256":digest,
                "digestProtocol":AGENT_RESULT_DIGEST_PROTOCOL,
                "solverProtocol":REFERENCE_STDIO_PROTOCOL,
                "solverStatus":422,
                "result":partial
            })),
        );
        assert_eq!(response_status(&checkpoint), 202);
        let failed = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{}/fail", lease.lease_token),
            agent_protocol_body(json!({
                "workerToken":worker.worker_token,
                "agentId":"partial-checkpoint-race-pc",
                "jobId":job_id,
                "leaseId":lease.lease_token,
                "kind":"browser_wasm_partial_resume_checkpoint"
            })),
        );
        assert_eq!(response_status(&failed), 202);
        let failed_payload = response_payload(&failed);
        assert_eq!(failed_payload["requeued"], json!(true));
        assert_eq!(failed_payload["freshVpsRescueArmed"], json!(false));
        assert!(!app
            .solver_pool
            .server_job_agent_preference_enabled(job_id, &owner));

        // The partial resume checkpoint is now committed to the canonical job;
        // the same Browser task must not be claimable again while VPS takes it.
        assert!(matches!(
            app.agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis()),
            Err(AgentHelperError::NoWork)
        ));
        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        let fallback_state = loop {
            let state = response_payload(&solver_state_json(
                &app,
                "jobId=partial-checkpoint-race",
                &owner,
            ));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "partial checkpoint did not hand the same job to VPS: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(fallback_state["requestedJobId"], json!(job_id));
        assert_eq!(
            fallback_state["requestedJobStartedAtMs"],
            json!(canonical_started_at_ms)
        );
        assert!(app
            .solver_pool
            .completed_server_response_for_owner(job_id, &owner)
            .is_none());
        app.solver_pool.abandon_server_job(job_id, &owner);
        drop(blockers);
    }

    #[test]
    fn mobile_checkpoint_handoff_arms_rescue_and_fences_reclaim() {
        let (app, token, owner) = agent_test_app();
        let binding = agent_session_binding(&token);
        let worker = app
            .agent_helper
            .register_worker(
                &owner,
                &binding,
                "mobile-checkpoint-race-pc",
                "Mobile checkpoint race PC",
                1,
                now_millis(),
            )
            .expect("Agent worker");
        let mut blockers = Vec::new();
        loop {
            let desired_workers = app
                .solver_pool
                .available_worker_tokens()
                .min(app.solver_pool.max_workers_per_job());
            let blocker_id = format!("mobile-checkpoint-race-vps-blocker-{}", blockers.len());
            match app.solver_pool.try_acquire(blocker_id, desired_workers) {
                Ok(blocker) => blockers.push(blocker),
                Err(()) => break,
            }
        }
        assert!(!blockers.is_empty(), "VPS capacity blocker");
        let job_id = "mobile-checkpoint-race";
        let request = browser_ready_automatic_fresh_request(job_id);
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert!(
            !app.solver_pool
                .server_job_snapshots_for_owner(&owner)
                .into_iter()
                .find(|snapshot| snapshot.job_id == job_id)
                .expect("mobile WebAgent job")
                .native_agent_required
        );
        let lease_deadline = Instant::now() + Duration::from_millis(1_000);
        let lease = loop {
            match app
                .agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis())
            {
                Ok(lease) => break lease,
                Err(AgentHelperError::NoWork) => {
                    assert!(Instant::now() < lease_deadline);
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Agent lease failed: {error:?}"),
            }
        };
        let native =
            native_solver::solve_native_hint_json(Path::new(""), &lease.request_body, None)
                .expect("native solver")
                .expect("native result");
        assert_eq!(native.status, 200);
        let mut checkpoint: Value =
            serde_json::from_str(&native.payload).expect("valid native checkpoint");
        checkpoint["browser_mobile_checkpoint_vps_refine"] = json!(true);
        let runtime = ensure_object_child(&mut checkpoint, "solver")
            .entry("runtime_settings".to_string())
            .or_insert_with(|| json!({}));
        if !runtime.is_object() {
            *runtime = json!({});
        }
        runtime["browser_mobile_checkpoint_vps_refine"] = json!(true);
        let digest = agent_helper_result_digest(&checkpoint).expect("checkpoint digest");
        let accepted = agent_route(
            &app,
            Some(&token),
            &format!(
                "/api/agent-helper/v1/leases/{}/checkpoint",
                lease.lease_token
            ),
            agent_protocol_body(json!({
                "workerToken":worker.worker_token,
                "agentId":"mobile-checkpoint-race-pc",
                "jobId":job_id,
                "leaseId":lease.lease_token,
                "sha256":digest,
                "digestProtocol":AGENT_RESULT_DIGEST_PROTOCOL,
                "solverProtocol":REFERENCE_STDIO_PROTOCOL,
                "solverStatus":native.status,
                "result":checkpoint
            })),
        );
        assert_eq!(response_status(&accepted), 202);
        let failed = agent_route(
            &app,
            Some(&token),
            &format!("/api/agent-helper/v1/leases/{}/fail", lease.lease_token),
            agent_protocol_body(json!({
                "workerToken":worker.worker_token,
                "agentId":"mobile-checkpoint-race-pc",
                "jobId":job_id,
                "leaseId":lease.lease_token,
                "kind":"browser_wasm_mobile_checkpoint_vps_refine"
            })),
        );
        assert_eq!(response_status(&failed), 202);
        assert_eq!(
            response_payload(&failed)["freshVpsRescueArmed"],
            json!(true)
        );
        assert!(!app
            .solver_pool
            .server_job_agent_preference_enabled(job_id, &owner));
        assert!(matches!(
            app.agent_helper
                .claim_work(&owner, &binding, &worker.worker_token, now_millis()),
            Err(AgentHelperError::NoWork)
        ));
        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        loop {
            let state =
                response_payload(&solver_state_json(&app, &format!("jobId={job_id}"), &owner));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "mobile rescue did not start: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        }
        app.solver_pool.abandon_server_job(job_id, &owner);
        drop(blockers);
    }

    #[test]
    fn healthy_online_agent_stays_authoritative_until_disconnect_then_falls_back() {
        let (app, token, owner) = agent_test_app();
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{"agentId":"idle-exclusive-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("worker token")
            .to_string();
        let blocker = app
            .solver_pool
            .try_acquire(
                "healthy-agent-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");

        let request = async_preserved_request("agent-unclaimed-fallback");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));
        let canonical_started_at_ms = response_payload(&started)["startedAtMs"]
            .as_u64()
            .expect("fallback job must have a canonical startedAtMs");
        thread::sleep(Duration::from_millis(AGENT_CLAIM_GRACE_MS + 200));
        let heartbeat = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/heartbeat",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agent":{"agentId":"idle-exclusive-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"},
                "status":"idle"
            })),
        );
        assert_eq!(response_status(&heartbeat), 200);
        let still_agent = response_payload(&solver_state_json(
            &app,
            "jobId=agent-unclaimed-fallback",
            &owner,
        ));
        assert_eq!(still_agent["requestedJobExecutor"], json!("agent"));
        assert_eq!(
            still_agent["requestedJobExecutionPhase"],
            json!("agent_waiting")
        );

        let disconnected = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/disconnect",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agent":{"agentId":"idle-exclusive-pc","version":MIN_AGENT_HELPER_VERSION,"platform":"windows"}
            })),
        );
        assert_eq!(response_status(&disconnected), 200);
        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        let fallback_state = loop {
            let state = response_payload(&solver_state_json(
                &app,
                "jobId=agent-unclaimed-fallback",
                &owner,
            ));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "disconnected Agent did not return its canonical job to VPS: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            fallback_state["requestedJobStartedAtMs"],
            json!(canonical_started_at_ms),
            "Agent-to-VPS fallback must preserve the canonical start timestamp"
        );
        app.solver_pool
            .abandon_server_job("agent-unclaimed-fallback", &owner);
        drop(blocker);
    }

    #[test]
    fn reconnect_before_vps_start_returns_the_canonical_job_to_agent() {
        let (app, token, owner) = agent_test_app();
        let job_id = "agent-reconnect-before-vps-start";
        assert_eq!(
            app.solver_pool.claim_server_job(job_id, &owner),
            ServerJobClaim::Claimed
        );
        let first_agent_fence = app
            .solver_pool
            .prepare_agent_execution(job_id, &owner)
            .expect("initial Agent fence");
        assert!(app
            .solver_pool
            .mark_agent_execution_running(first_agent_fence, job_id, &owner,));

        // Reproduce the narrow ordering from a real reconnect: hello arrives
        // while the old Agent generation is still visible, then lease expiry
        // commits VPS fallback immediately afterwards.
        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "agent":{
                    "agentId":"reconnected-primary-pc",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"windows"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        assert_eq!(response_payload(&hello)["handoffJobIds"], json!([]));
        assert_eq!(
            app.agent_helper
                .online_worker_count_for_job(&owner, job_id, now_millis()),
            1
        );

        let stale_vps_fence = app
            .solver_pool
            .fallback_agent_to_vps(first_agent_fence, job_id, &owner)
            .expect("temporary VPS fallback fence");
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot(job_id, &owner)
                .expect("VPS queued snapshot")
                .phase,
            ServerExecutionPhase::VpsQueued
        );

        assert!(handoff_online_agent_before_vps_start(&app, job_id, &owner));
        assert!(
            !app.solver_pool
                .execution_fence_current(stale_vps_fence, job_id, &owner),
            "the reconnect must fence the not-yet-started VPS generation"
        );
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot(job_id, &owner)
                .expect("Agent handoff snapshot")
                .phase,
            ServerExecutionPhase::HandoffToAgent
        );
        let reclaimed_agent_fence = app
            .solver_pool
            .prepare_agent_execution(job_id, &owner)
            .expect("reconnected Agent fence");
        assert!(app
            .solver_pool
            .execution_fence_current(reclaimed_agent_fence, job_id, &owner,));
        assert_eq!(
            app.solver_pool
                .server_execution_snapshot(job_id, &owner)
                .expect("reconnected Agent waiting snapshot")
                .phase,
            ServerExecutionPhase::AgentWaiting
        );

        app.solver_pool.abandon_server_job(job_id, &owner);
    }

    #[test]
    fn healthy_agent_lease_survives_watchdog_boundary_until_real_disconnect() {
        let (app, token, owner) = agent_test_app();
        let job_id = "healthy-agent-watchdog-boundary";
        let blocker = app
            .solver_pool
            .try_acquire(
                "healthy-agent-watchdog-vps-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive VPS capacity blocker");
        let mut request = browser_ready_automatic_fresh_request(job_id);
        request["settings"]["backend_deadline_ms"] = json!(2_000);
        request["settings"]["native_global_deadline_ms"] = json!(2_000);
        request["settings"]["native_deadline_reserve_ms"] = json!(0);

        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        let started_payload = response_payload(&started);
        assert_eq!(response_status(&started), 202);
        assert_eq!(started_payload["executor"], json!("agent"));
        assert_eq!(started_payload["executionPhase"], json!("agent_waiting"));
        let canonical_started_at_ms = started_payload["startedAtMs"]
            .as_u64()
            .expect("canonical Agent start timestamp");

        let hello = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/hello",
            agent_protocol_body(json!({
                "jobId":job_id,
                "agent":{
                    "agentId":"watchdog-boundary-browser",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1}
            })),
        );
        assert_eq!(response_status(&hello), 200);
        let worker_token = response_payload(&hello)["workerToken"]
            .as_str()
            .expect("Browser Agent worker token")
            .to_string();
        let lease = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/lease",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "jobId":job_id,
                "leaseRequestId":"watchdog-boundary-lease-0001",
                "agent":{
                    "agentId":"watchdog-boundary-browser",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                },
                "capacity":{"cpuWorkers":4,"maxConcurrentJobs":1},
                "waitSeconds":1
            })),
        );
        assert_eq!(response_status(&lease), 200);
        let lease_id = response_payload(&lease)["lease"]["leaseId"]
            .as_str()
            .expect("Browser Agent lease id")
            .to_string();

        let boundary_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let heartbeat = agent_route(
                &app,
                Some(&token),
                &format!("/api/agent-helper/v1/leases/{lease_id}/heartbeat"),
                agent_protocol_body(json!({
                    "workerToken":worker_token,
                    "agentId":"watchdog-boundary-browser",
                    "jobId":job_id,
                    "leaseId":lease_id
                })),
            );
            assert_eq!(response_status(&heartbeat), 200);
            assert_eq!(response_payload(&heartbeat)["renewed"], json!(true));
            let remaining = app
                .solver_pool
                .server_job_watchdog_remaining_ms(job_id, &owner, now_millis())
                .expect("canonical watchdog must be active");
            if remaining == 0 {
                break;
            }
            assert!(
                Instant::now() < boundary_deadline,
                "canonical watchdog did not reach its test boundary"
            );
            thread::sleep(Duration::from_millis(100));
        }

        // Give the coordinator another poll after the ordinary watchdog has
        // fully elapsed. The renewed lease must remain the sole executor.
        thread::sleep(Duration::from_millis(150));
        let still_agent =
            response_payload(&solver_state_json(&app, &format!("jobId={job_id}"), &owner));
        assert_eq!(still_agent["requestedJobExecutor"], json!("agent"));
        assert_eq!(
            still_agent["requestedJobExecutionPhase"],
            json!("agent_running")
        );
        assert_eq!(still_agent["requestedJobWatchdogRemainingMs"], json!(0));
        let pending_result = solve_result_json(&app, &format!("jobId={job_id}"), &owner);
        assert_eq!(response_status(&pending_result), 202);

        let disconnected = agent_route(
            &app,
            Some(&token),
            "/api/agent-helper/v1/disconnect",
            agent_protocol_body(json!({
                "workerToken":worker_token,
                "agent":{
                    "agentId":"watchdog-boundary-browser",
                    "version":MIN_AGENT_HELPER_VERSION,
                    "platform":"web-wasm"
                }
            })),
        );
        assert_eq!(response_status(&disconnected), 200);

        let fallback_deadline = Instant::now() + Duration::from_millis(1_500);
        let fallback_state = loop {
            let state =
                response_payload(&solver_state_json(&app, &format!("jobId={job_id}"), &owner));
            if state["requestedJobExecutor"] == json!("vps")
                && state["requestedJobExecutionPhase"] == json!("vps_queued")
            {
                break state;
            }
            assert!(
                Instant::now() < fallback_deadline,
                "VPS took no ownership after the Agent lease was really disconnected: {state}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(fallback_state["requestedJobId"], json!(job_id));
        assert!(
            fallback_state["requestedJobStartedAtMs"]
                .as_u64()
                .unwrap_or(0)
                >= canonical_started_at_ms,
            "the same canonical job may open only a newer bounded VPS rescue epoch"
        );
        assert!(
            fallback_state["requestedJobWatchdogRemainingMs"]
                .as_u64()
                .unwrap_or(0)
                > 0,
            "fresh no-checkpoint disconnect must arm one bounded VPS rescue window"
        );

        app.solver_pool.abandon_server_job(job_id, &owner);
        drop(blocker);
    }

    #[test]
    fn server_owned_job_caps_return_http_429_before_spawning_more_threads() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("school-a", "admin-a");
        for index in 0..MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER {
            assert_eq!(
                app.solver_pool
                    .claim_server_job(&format!("held-owner-{index}"), &owner),
                ServerJobClaim::Claimed
            );
        }
        let owner_request = async_preserved_request("owner-overflow");
        let owner_response = solve_json(&app, owner_request.to_string().as_bytes(), &owner);
        let owner_payload = response_payload(&owner_response);
        assert_eq!(response_status(&owner_response), 429);
        assert_eq!(owner_payload["kind"], json!("solver_owner_job_capacity"));
        assert_eq!(
            owner_payload["maxUnresolvedServerJobsPerOwner"],
            json!(MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER)
        );

        for owner_index in 1..(MAX_UNRESOLVED_SERVER_JOBS / 2) {
            let filler_owner = SolverOwner::new(&format!("school-{owner_index}"), "admin");
            for job_index in 0..2 {
                assert_eq!(
                    app.solver_pool.claim_server_job(
                        &format!("held-global-{owner_index}-{job_index}"),
                        &filler_owner,
                    ),
                    ServerJobClaim::Claimed
                );
            }
        }
        let global_owner = SolverOwner::new("school-global-overflow", "admin");
        let global_request = async_preserved_request("global-overflow");
        let global_response =
            solve_json(&app, global_request.to_string().as_bytes(), &global_owner);
        let global_payload = response_payload(&global_response);
        assert_eq!(response_status(&global_response), 429);
        assert_eq!(global_payload["kind"], json!("solver_server_job_capacity"));
        assert_eq!(
            global_payload["maxUnresolvedServerJobs"],
            json!(MAX_UNRESOLVED_SERVER_JOBS)
        );
    }

    #[test]
    fn simultaneous_posts_for_the_same_owner_schedule_reuse_one_server_job() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("school-a", "admin-a");
        let blocker = app
            .solver_pool
            .try_acquire(
                "dedupe-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive blocker");

        let first_request = async_preserved_request("dedupe-first");
        let first_response = solve_json(&app, first_request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&first_response), 202);
        assert_eq!(
            response_payload(&first_response)["jobId"],
            json!("dedupe-first")
        );

        let second_request = async_preserved_request("dedupe-second");
        let second_response = solve_json(&app, second_request.to_string().as_bytes(), &owner);
        let second_payload = response_payload(&second_response);
        assert_eq!(response_status(&second_response), 202);
        assert_eq!(second_payload["jobId"], json!("dedupe-first"));
        assert_eq!(
            app.solver_pool.server_job_snapshots_for_owner(&owner).len(),
            1
        );

        assert!(app.solver_pool.cancel_job_for_owner("dedupe-first", &owner));
        drop(blocker);
    }

    #[test]
    fn simultaneous_posts_with_changed_fingerprint_still_share_one_schedule_lock() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("school-a", "admin-a");
        let blocker = app
            .solver_pool
            .try_acquire(
                "scope-dedupe-blocker".to_string(),
                app.solver_pool.total_worker_tokens(),
            )
            .expect("exclusive blocker");

        let mut first_request = async_preserved_request("scope-dedupe-first");
        first_request["settings"]["ui_schedule_scope"] = json!("default");
        first_request["settings"]["ui_schedule_fingerprint"] = json!("v1:first");
        let first_response = solve_json(&app, first_request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&first_response), 202);

        let mut second_request = async_preserved_request("scope-dedupe-second");
        second_request["settings"]["ui_schedule_scope"] = json!("default");
        second_request["settings"]["ui_schedule_fingerprint"] = json!("v1:changed");
        let second_response = solve_json(&app, second_request.to_string().as_bytes(), &owner);
        let second_payload = response_payload(&second_response);
        assert_eq!(response_status(&second_response), 409);
        assert_eq!(second_payload["kind"], json!("solver_schedule_busy"));
        assert_eq!(second_payload["existingJobId"], json!("scope-dedupe-first"));
        assert_eq!(
            app.solver_pool.server_job_snapshots_for_owner(&owner).len(),
            1
        );

        assert!(app
            .solver_pool
            .cancel_job_for_owner("scope-dedupe-first", &owner));
        drop(blocker);
    }

    fn wait_for_server_result(app: &App, job_id: &str, owner: &SolverOwner) -> Vec<u8> {
        for _ in 0..200 {
            let response = solve_result_json(app, &format!("jobId={job_id}"), owner);
            if response_status(&response) != 202 {
                return response;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("server-owned solver result did not become ready");
    }

    #[test]
    fn async_post_is_idempotent_and_completed_result_is_owner_scoped() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let owner = SolverOwner::new("school-a", "admin-a");
        let other_owner = SolverOwner::new("school-b", "admin-b");
        let request = async_preserved_request("async-idempotent");
        let body = request.to_string();

        let started = solve_json(&app, body.as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert!(matches!(
            response_payload(&started)["kind"].as_str(),
            Some("solver_started")
        ));
        assert_eq!(response_payload(&started)["executor"], json!("vps"));
        let canonical_started_at_ms = response_payload(&started)["startedAtMs"]
            .as_u64()
            .expect("VPS start response must expose canonical startedAtMs");
        assert!(canonical_started_at_ms >= 1_000_000_000_000);
        let duplicate = solve_json(&app, body.as_bytes(), &owner);
        assert!(matches!(response_status(&duplicate), 200 | 202));

        let completed = wait_for_server_result(&app, "async-idempotent", &owner);
        assert_eq!(response_status(&completed), 200);
        assert_eq!(
            response_payload(&completed)["metrics"]["scheduled_periods"],
            json!(1)
        );
        assert_eq!(
            response_payload(&completed)["startedAtMs"],
            json!(canonical_started_at_ms),
            "completed solve-result must retain the canonical start timestamp"
        );
        assert_eq!(
            response_status(&solve_result_json(
                &app,
                "jobId=async-idempotent",
                &other_owner
            )),
            404
        );
        assert_eq!(
            response_status(&solve_json(&app, body.as_bytes(), &owner)),
            200
        );
        let state = response_payload(&solver_state_json(&app, "jobId=async-idempotent", &owner));
        assert_eq!(state["requestedJobServerOwned"], json!(true));
        assert_eq!(state["requestedJobResultReady"], json!(true));
        assert_eq!(state["completedJobs"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            state["completedJobs"][0]["scheduleFingerprint"],
            json!("v2:0123456789abcdef:42")
        );
        assert_eq!(
            state["completedJobs"][0]["progressBudgetSeconds"],
            json!(120)
        );
        assert_eq!(state["completedJobs"][0]["progressRunIndex"], json!(3));
        assert!(state["completedJobs"][0]["createdAtMs"].is_u64());
        assert!(state["completedJobs"][0]["completedAtMs"].is_u64());
        assert_eq!(
            state["completedJobs"][0]["startedAtMs"],
            json!(canonical_started_at_ms)
        );
        assert!(state["completedJobs"][0].get("response").is_none());
        let other_state = response_payload(&solver_state_json(&app, "", &other_owner));
        assert_eq!(
            other_state["completedJobs"].as_array().map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn queued_async_job_acquires_on_server_without_browser_heartbeat() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let blocking_owner = SolverOwner::new("blocking", "admin");
        let owner = SolverOwner::new("queued-school", "admin");
        let mut blocking = Vec::new();
        for index in 0..app.solver_pool.max_concurrent() {
            if let Ok(guard) = app.solver_pool.try_acquire_for_owner(
                format!("blocking-{index}"),
                app.solver_pool.min_workers_per_job(),
                blocking_owner.clone(),
            ) {
                blocking.push(guard);
            }
        }
        assert!(app.solver_pool.at_capacity());
        let request = async_preserved_request("async-queued");
        let body = request.to_string();
        let queued = solve_json(&app, body.as_bytes(), &owner);
        assert_eq!(response_status(&queued), 202);
        assert_eq!(response_payload(&queued)["kind"], json!("solver_queued"));
        assert_eq!(response_payload(&queued)["serverOwned"], json!(true));
        let duplicate = solve_json(&app, body.as_bytes(), &owner);
        assert_eq!(response_status(&duplicate), 202);
        assert_eq!(response_payload(&duplicate)["kind"], json!("solver_queued"));
        let queued_state = response_payload(&solver_state_json(&app, "", &owner));
        assert_eq!(queued_state["queue"][0]["serverOwned"], json!(true));
        assert_eq!(
            queued_state["queue"][0]["scheduleFingerprint"],
            json!("v2:0123456789abcdef:42")
        );
        assert_eq!(
            queued_state["queue"][0]["progressBudgetSeconds"],
            json!(120)
        );
        assert_eq!(queued_state["queue"][0]["progressRunIndex"], json!(3));
        assert!(queued_state["queue"][0]["createdAtMs"].is_u64());

        thread::sleep(Duration::from_millis(50));
        drop(blocking);
        let completed = wait_for_server_result(&app, "async-queued", &owner);
        assert_eq!(response_status(&completed), 200);
        assert_eq!(app.solver_pool.queued_count(), 0);
    }

    #[test]
    fn cancelling_queued_async_job_does_not_reenqueue_it() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
            serverless: ServerlessCoordinator::new(Arc::new(
                db::Db::new(PathBuf::from(":memory:")).expect("in-memory serverless database"),
            )),
            db: Arc::new(db::Db::new(PathBuf::from(":memory:")).expect("in-memory database")),
        };
        let blocking_owner = SolverOwner::new("blocking", "admin");
        let owner = SolverOwner::new("cancelled-school", "admin");
        let mut blocking = Vec::new();
        for index in 0..app.solver_pool.max_concurrent() {
            if let Ok(guard) = app.solver_pool.try_acquire_for_owner(
                format!("cancel-blocking-{index}"),
                app.solver_pool.min_workers_per_job(),
                blocking_owner.clone(),
            ) {
                blocking.push(guard);
            }
        }
        let request = async_preserved_request("async-cancelled");
        let body = request.to_string();
        assert_eq!(
            response_payload(&solve_json(&app, body.as_bytes(), &owner))["kind"],
            json!("solver_queued")
        );
        let cancelled = response_payload(&solve_cancel_json(
            &app,
            br#"{"jobId":"async-cancelled"}"#,
            &owner,
        ));
        assert_eq!(cancelled["cancelRequested"], json!(true));
        drop(blocking);
        for _ in 0..100 {
            if !app
                .solver_pool
                .server_job_known_for_owner("async-cancelled", &owner)
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!app
            .solver_pool
            .server_job_known_for_owner("async-cancelled", &owner));
        assert_eq!(app.solver_pool.queued_count(), 0);
        assert_eq!(
            response_status(&solve_result_json(&app, "jobId=async-cancelled", &owner)),
            404
        );
    }

    fn safe_capacity_partial_payload() -> Value {
        json!({
            "ok": true,
            "lessons": [{
                "classId": "L1",
                "subject": "Math",
                "teacher": "T1",
                "day": 2,
                "session": "AM",
                "period": 1
            }],
            "unassignedLessons": [{
                "classId": "L1",
                "subject": "Math",
                "teacher": "T1",
                "periods": 1,
                "reason": "not_enough_available_slots"
            }],
            "metrics": {
                "scheduled_periods": 1,
                "expected_periods": 2,
                "unassigned_periods": 1,
                "capacity_unassigned_periods": 1,
                "solver_unassigned_periods": 0,
                "accounted_periods": 2,
                "accounting_ok": true,
                "capacity_limited": true,
                "placement_hard_ok": true,
                "placement_core_hard_ok": true,
                "hard_ok": true,
                "core_hard_ok": true,
                "class_slot_conflicts": 0,
                "teacher_slot_conflicts": 0,
                "room_slot_conflicts": 0,
                "app_constraint_violation_count": 0,
                "app_constraint_violations": []
            },
            "validation": {"hard_ok": true, "violations": []},
            "bestEffort": false,
            "deadlineExhausted": false
        })
    }

    fn incomplete_reference_payload(deadline_exhausted: bool) -> Value {
        json!({
            "ok": true,
            "deadlineExhausted": deadline_exhausted,
            "lessons": [{"classId": "L1"}],
            "unassignedLessons": [{"classId": "L1"}],
            "metrics": {
                "scheduled_periods": 9,
                "expected_periods": 10,
                "unassigned_periods": 1,
                "app_constraint_violation_count": 0,
                "hard_ok": false,
                "core_hard_ok": false,
                "placement_hard_ok": true,
                "placement_core_hard_ok": true,
                "best_effort": false
            }
        })
    }

    fn safe_mixed_capacity_partial_payload() -> Value {
        let mut payload = safe_capacity_partial_payload();
        payload["ok"] = json!(false);
        payload["kind"] = json!("incomplete_schedule");
        payload["error"] = json!("one bounded solver period remains");
        payload["unassignedLessons"] = json!([
            {
                "classId": "L1",
                "subject": "Math",
                "teacher": "T1",
                "periods": 1,
                "reason": "not_enough_available_slots"
            },
            {
                "classId": "L1",
                "subject": "Science",
                "teacher": "T2",
                "periods": 1,
                "reason": "session_constraints_best_effort"
            }
        ]);
        payload["metrics"]["expected_periods"] = json!(3);
        payload["metrics"]["unassigned_periods"] = json!(2);
        payload["metrics"]["solver_unassigned_periods"] = json!(1);
        payload["metrics"]["accounted_periods"] = json!(3);
        payload["metrics"]["hard_ok"] = json!(false);
        payload["metrics"]["core_hard_ok"] = json!(false);
        payload["validation"]["hard_ok"] = json!(false);
        payload
    }

    #[test]
    fn safe_capacity_partial_is_publishable_without_waiting_for_timeout() {
        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "best_effort_on_timeout": false
            }
        });
        let source = safe_capacity_partial_payload();
        assert!(reference_payload_safe_capacity_partial(&source));
        let mut wire_compat = source.clone();
        let metrics = wire_compat["metrics"].as_object_mut().expect("metrics object");
        metrics.remove("capacity_limited");
        metrics.remove("accounted_periods");
        metrics.remove("core_hard_ok");
        metrics.remove("hard_ok");
        metrics.remove("app_constraint_violations");
        wire_compat.as_object_mut().expect("payload object").remove("validation");
        assert!(reference_payload_safe_capacity_partial(&wire_compat));

        let (status, body) = normalize_reference_payload(
            source,
            &request,
            200,
            Instant::now(),
            Duration::from_secs(60),
        );
        let payload: Value = serde_json::from_str(&body).expect("normalized capacity payload");
        assert_eq!(status, 200);
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["bestEffort"], json!(true));
        assert_eq!(
            payload["solver"]["runtime_settings"]["capacity_partial_accepted"],
            json!(true)
        );
    }

    #[test]
    fn exact_mixed_capacity_partial_is_promoted_from_422_to_safe_best_effort() {
        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "best_effort_on_timeout": true,
                "ui_accept_incomplete_best_effort": true
            }
        });
        let source = safe_mixed_capacity_partial_payload();
        assert!(reference_payload_safe_capacity_partial(&source));

        let (status, body) = normalize_reference_payload(
            source,
            &request,
            422,
            Instant::now(),
            Duration::from_secs(180),
        );
        let payload: Value = serde_json::from_str(&body).expect("normalized mixed partial");
        assert_eq!(status, 200);
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["bestEffort"], json!(true));
        assert_eq!(payload["kind"], json!("best_effort_unassigned_accepted"));
        assert_eq!(payload["metrics"]["hard_ok"], json!(false));
        assert_eq!(
            payload["solver"]["runtime_settings"]["capacity_partial_accepted"],
            json!(true)
        );
    }

    #[test]
    fn exact_solver_only_remainder_is_promoted_after_placement_validation() {
        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "best_effort_on_timeout": true,
                "ui_accept_incomplete_best_effort": true
            }
        });
        let mut source = safe_capacity_partial_payload();
        source["ok"] = json!(false);
        source["kind"] = json!("incomplete_schedule");
        source["unassignedLessons"][0]["reason"] =
            json!("session_constraints_best_effort");
        source["metrics"]["capacity_unassigned_periods"] = json!(0);
        source["metrics"]["solver_unassigned_periods"] = json!(1);
        source["metrics"]["capacity_limited"] = json!(false);
        source["metrics"]["hard_ok"] = json!(false);
        source["metrics"]["core_hard_ok"] = json!(false);
        source["validation"]["hard_ok"] = json!(false);

        assert!(reference_payload_safe_capacity_partial(&source));
        let (status, body) = normalize_reference_payload(
            source,
            &request,
            422,
            Instant::now(),
            Duration::from_secs(180),
        );
        let payload: Value = serde_json::from_str(&body).expect("normalized solver partial");
        assert_eq!(status, 200);
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["bestEffort"], json!(true));
        assert_eq!(payload["metrics"]["hard_ok"], json!(false));
    }

    #[test]
    fn mixed_or_forged_capacity_partials_remain_422_even_at_timeout() {
        let mut bad_payloads = Vec::new();

        let mut solver_debt_mismatch = safe_capacity_partial_payload();
        solver_debt_mismatch["metrics"]["solver_unassigned_periods"] = json!(1);
        bad_payloads.push(("solver debt accounting mismatch", solver_debt_mismatch));

        let mut capacity_mismatch = safe_capacity_partial_payload();
        capacity_mismatch["metrics"]["capacity_unassigned_periods"] = json!(2);
        bad_payloads.push(("capacity mismatch", capacity_mismatch));

        let mut accounting_flag = safe_capacity_partial_payload();
        accounting_flag["metrics"]["accounting_ok"] = json!(false);
        bad_payloads.push(("accounting flag", accounting_flag));

        let mut accounted_periods = safe_capacity_partial_payload();
        accounted_periods["metrics"]["accounted_periods"] = json!(1);
        bad_payloads.push(("accounted periods", accounted_periods));

        let mut unassigned_sum = safe_capacity_partial_payload();
        unassigned_sum["unassignedLessons"][0]["periods"] = json!(2);
        bad_payloads.push(("unassigned sum", unassigned_sum));

        let mut mixed_reason = safe_capacity_partial_payload();
        mixed_reason["unassignedLessons"][0]["reason"] =
            json!("session_constraints_best_effort");
        bad_payloads.push(("mixed reason", mixed_reason));

        let mut lesson_count = safe_capacity_partial_payload();
        lesson_count["lessons"] = json!([]);
        bad_payloads.push(("lesson count", lesson_count));

        for gate in [
            "placement_hard_ok",
            "placement_core_hard_ok",
            "hard_ok",
            "core_hard_ok",
        ] {
            let mut payload = safe_capacity_partial_payload();
            payload["metrics"][gate] = json!(false);
            bad_payloads.push((gate, payload));
        }
        for conflict in [
            "class_slot_conflicts",
            "teacher_slot_conflicts",
            "room_slot_conflicts",
        ] {
            let mut payload = safe_capacity_partial_payload();
            payload["metrics"][conflict] = json!(1);
            bad_payloads.push((conflict, payload));
        }

        let mut application_count = safe_capacity_partial_payload();
        application_count["metrics"]["app_constraint_violation_count"] = json!(1);
        bad_payloads.push(("application count", application_count));

        let mut hidden_application_violation = safe_capacity_partial_payload();
        hidden_application_violation["metrics"]["app_constraint_violations"] =
            json!([{"kind": "mustTeach"}]);
        bad_payloads.push(("hidden application violation", hidden_application_violation));

        let mut validation_violation = safe_capacity_partial_payload();
        validation_violation["validation"]["violations"] =
            json!([{"kind": "mustTeach"}]);
        bad_payloads.push(("validation violation", validation_violation));

        let mut missing_conflict_metric = safe_capacity_partial_payload();
        missing_conflict_metric["metrics"]
            .as_object_mut()
            .expect("metrics object")
            .remove("teacher_slot_conflicts");
        bad_payloads.push(("missing conflict metric", missing_conflict_metric));

        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "best_effort_on_timeout": true
            }
        });
        for (name, mut payload) in bad_payloads {
            payload["deadlineExhausted"] = json!(true);
            assert!(
                !reference_payload_safe_capacity_partial(&payload),
                "{name} must fail the strict capacity gate"
            );
            let (status, body) = normalize_reference_payload(
                payload,
                &request,
                200,
                Instant::now(),
                Duration::from_secs(60),
            );
            let payload: Value =
                serde_json::from_str(&body).expect("normalized rejected capacity payload");
            assert_eq!(status, 422, "{name} must remain HTTP 422");
            assert_eq!(payload["ok"], json!(false), "{name} must remain failed");
        }
    }

    #[test]
    fn async_watchdog_preserves_only_safe_capacity_partial() {
        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "fresh_complete_first",
                "optimization_focus": "automatic"
            }
        });
        let safe_response = json_response(200, safe_capacity_partial_payload());
        assert!(!server_response_complete(&safe_response));
        assert!(server_response_publishable_for_request(
            &request,
            &safe_response
        ));
        assert_eq!(
            solver_execution_outcome_from_response(&safe_response, false),
            ReservationOutcome::Completed
        );
        let preserved = server_watchdog_final_response(
            &request,
            safe_response.clone(),
            Some(MIN_SOLVER_DEADLINE_MS - 1),
        );
        assert_eq!(preserved, safe_response);

        let mut mixed = safe_capacity_partial_payload();
        mixed["metrics"]["solver_unassigned_periods"] = json!(1);
        let mixed_response = json_response(200, mixed);
        assert!(!server_response_publishable_for_request(
            &request,
            &mixed_response
        ));
        let rejected = server_watchdog_final_response(
            &request,
            mixed_response,
            Some(MIN_SOLVER_DEADLINE_MS - 1),
        );
        assert_eq!(response_status(&rejected), 422);
        assert_eq!(
            solver_execution_outcome_from_response(&rejected, false),
            ReservationOutcome::Failed
        );
    }

    #[test]
    fn incomplete_reference_is_not_success_before_timeout() {
        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "best_effort_on_timeout": true
            }
        });
        let (status, payload) = normalize_reference_payload(
            incomplete_reference_payload(false),
            &request,
            200,
            Instant::now(),
            Duration::from_secs(60),
        );
        let payload: Value = serde_json::from_str(&payload).expect("normalized payload");
        assert_eq!(status, 422);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            payload.get("kind").and_then(Value::as_str),
            Some("incomplete_schedule")
        );
    }

    #[test]
    fn reference_server_error_without_kind_gets_terminal_failure_contract() {
        let request = json!({"settings": {}});

        for source_payload in [
            json!({"error": "reference helper crashed"}),
            json!({"ok": true, "kind": "   ", "error": "reference helper crashed"}),
        ] {
            let (status, payload) = normalize_reference_payload(
                source_payload,
                &request,
                500,
                Instant::now(),
                Duration::from_secs(60),
            );
            let payload: Value = serde_json::from_str(&payload).expect("normalized payload");

            assert_eq!(status, 500);
            assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
            assert_eq!(
                payload.get("kind").and_then(Value::as_str),
                Some("reference_solver_failed")
            );
            assert_eq!(
                payload.get("error").and_then(Value::as_str),
                Some("reference helper crashed")
            );
        }
    }

    #[test]
    fn reference_non_success_forces_ok_false_and_preserves_existing_kind() {
        let request = json!({"settings": {}});
        let (status, payload) = normalize_reference_payload(
            json!({
                "ok": true,
                "kind": "no_complete_schedule_before_deadline",
                "error": "deadline exhausted"
            }),
            &request,
            422,
            Instant::now(),
            Duration::from_secs(60),
        );
        let payload: Value = serde_json::from_str(&payload).expect("normalized payload");

        assert_eq!(status, 422);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            payload.get("kind").and_then(Value::as_str),
            Some("no_complete_schedule_before_deadline")
        );
    }

    #[test]
    fn reference_server_error_preserves_existing_failure_kind() {
        let request = json!({"settings": {}});
        let (status, payload) = normalize_reference_payload(
            json!({
                "kind": "period_allocation_best_effort_failed",
                "error": "fallback failed"
            }),
            &request,
            500,
            Instant::now(),
            Duration::from_secs(60),
        );
        let payload: Value = serde_json::from_str(&payload).expect("normalized payload");

        assert_eq!(status, 500);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            payload.get("kind").and_then(Value::as_str),
            Some("period_allocation_best_effort_failed")
        );
    }

    #[test]
    fn unvalidated_existing_incumbent_is_never_returned_with_old_schedule_or_metrics() {
        let incumbent = json!({
            "ok": true,
            "lessons": [{"classId": "L1", "day": 2, "period": 1}],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 10,
                "expected_periods": 10,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "hard_ok": true,
                "teacher_sessions": 471,
                "teacher_single_gaps": 35
            },
            "solver": {"backend": "hybrid-python-reference"}
        });

        for revalidated in [None, Some(false)] {
            let mut settings = json!({
                "optimize_existing_schedule": true,
                "ui_return_complete_incumbent_on_existing_optimize_failure": true
            });
            if let Some(value) = revalidated {
                settings["ui_existing_incumbent_revalidated"] = json!(value);
            }
            let request = json!({
                "settings": settings,
                "data": {"tkbSolverResult": incumbent.clone()}
            });

            assert!(
                preserve_complete_hybrid_existing_payload(&request).is_none(),
                "unvalidated hybrid schedule and metrics must not be preserved"
            );
            assert!(
                complete_existing_incumbent_payload(&request, "solver_failed", "detail").is_none(),
                "unvalidated fallback schedule and metrics must not be returned"
            );
        }
    }

    #[test]
    fn unified_refinement_timeout_returns_complete_incumbent() {
        // This mirrors the browser's refine_complete request. Older cached
        // clients do not send the revalidated marker, so the explicit solve
        // kind is part of the compatibility contract.
        let incumbent = json!({
            "ok": true,
            "lessons": [
                {"classId": "L1", "day": 2, "session": "AM", "period": 1},
                {"classId": "L1", "day": 2, "session": "AM", "period": 2}
            ],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "hard_ok": true,
                "core_hard_ok": true,
                "teacher_sessions": 1,
                "one_period_teacher_sessions": 0
            },
            "validation": {"hard_ok": true},
            "solver": {"backend": "hybrid-python-reference"}
        });
        let request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_use_existing_complete_incumbent": true,
                "require_complete_schedule": true
            },
            "data": {"tkbSolverResult": incumbent}
        });

        let (status, body) = complete_existing_incumbent_payload(
            &request,
            "reference_solver_non_200",
            "no_complete_schedule_before_deadline",
        )
        .expect("complete refinement must have a safe timeout fallback");
        let payload: Value = serde_json::from_str(&body).expect("fallback payload");
        assert_eq!(status, 200);
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["metrics"]["scheduled_periods"], json!(2));
        assert_eq!(payload["lessons"].as_array().map(Vec::len), Some(2));
        assert_eq!(
            payload["solver"]["runtime_settings"]["phase"],
            json!("existing_optimize_incumbent_fallback")
        );
        assert_eq!(
            payload["solver"]["runtime_settings"]["returned_incumbent"],
            json!(true)
        );

        let timeout_response = server_watchdog_timeout_response(&request);
        assert_eq!(response_status(&timeout_response), 200);
        let timeout_payload = response_payload(&timeout_response);
        assert_eq!(timeout_payload["ok"], json!(true));
        assert_eq!(
            timeout_payload["solver"]["runtime_settings"]["phase"],
            json!("server_watchdog_incumbent_fallback")
        );
        assert_eq!(
            timeout_payload["solver"]["runtime_settings"]["deadline_hit"],
            json!(true)
        );
    }

    #[test]
    fn unified_refinement_watchdog_rejects_incumbent_without_lessons() {
        let request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_use_existing_complete_incumbent": true,
                "ui_existing_incumbent_revalidated": true,
                "require_complete_schedule": true
            },
            "data": {
                "tkbSolverResult": {
                    "ok": true,
                    "unassignedLessons": [],
                    "metrics": {
                        "scheduled_periods": 2,
                        "expected_periods": 2,
                        "unassigned_periods": 0,
                        "app_constraint_violation_count": 0,
                        "hard_ok": true,
                        "core_hard_ok": true
                    },
                    "validation": {"hard_ok": true}
                }
            }
        });

        assert!(complete_existing_incumbent_payload(&request, "timeout", "detail").is_none());
        let timeout = server_watchdog_timeout_response(&request);
        assert_eq!(response_status(&timeout), 422);
        assert_eq!(
            response_payload(&timeout)["kind"],
            json!("no_complete_schedule_before_deadline")
        );
    }

    #[test]
    fn watchdog_preserves_complete_hard_valid_response_at_deadline() {
        let request = json!({"settings": {}});
        let complete_payload = json!({
            "ok": true,
            "lessons": [{"classId":"L1","day":1,"period":1}],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 1,
                "expected_periods": 1,
                "unassigned_periods": 0,
                "app_constraint_violation_count": 0,
                "hard_ok": true,
                "core_hard_ok": true
            }
        });
        let complete_response = json_response(200, complete_payload);
        assert!(server_response_complete(&complete_response));
        let preserved = server_watchdog_final_response(
            &request,
            complete_response.clone(),
            Some(MIN_SOLVER_DEADLINE_MS - 1),
        );
        assert_eq!(preserved, complete_response);

        for invalid_payload in [
            json!({
                "ok": true,
                "lessons": [{"classId":"L1"}],
                "unassignedLessons": [{"classId":"L2"}],
                "metrics": {
                    "scheduled_periods": 1,
                    "expected_periods": 2,
                    "unassigned_periods": 1,
                    "app_constraint_violation_count": 0,
                    "hard_ok": false
                }
            }),
            json!({
                "ok": false,
                "lessons": [{"classId":"L1"}],
                "unassignedLessons": [],
                "metrics": {
                    "scheduled_periods": 1,
                    "expected_periods": 1,
                    "unassigned_periods": 0,
                    "app_constraint_violation_count": 0,
                    "hard_ok": true
                }
            }),
            json!({
                "ok": true,
                "lessons": [],
                "unassignedLessons": [],
                "metrics": {
                    "scheduled_periods": 1,
                    "expected_periods": 1,
                    "unassigned_periods": 0,
                    "app_constraint_violation_count": 0,
                    "hard_ok": true
                }
            }),
        ] {
            let response = json_response(200, invalid_payload);
            assert!(!server_response_complete(&response));
            let timeout = server_watchdog_final_response(
                &request,
                response,
                Some(MIN_SOLVER_DEADLINE_MS - 1),
            );
            assert_eq!(response_status(&timeout), 422);
            assert_eq!(
                response_payload(&timeout)["kind"],
                json!("no_complete_schedule_before_deadline")
            );
        }
        assert!(!server_response_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nnot-json"
        ));

        let at_boundary = server_watchdog_final_response(
            &request,
            complete_response.clone(),
            Some(MIN_SOLVER_DEADLINE_MS),
        );
        assert_eq!(at_boundary, complete_response);
    }

    #[test]
    fn unified_refinement_does_not_trust_incomplete_incumbent_metrics() {
        let request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_use_existing_complete_incumbent": true
            },
            "data": {
                "tkbSolverResult": {
                    "ok": true,
                    "lessons": [{"classId": "L1"}],
                    "unassignedLessons": [],
                    "metrics": {
                        "scheduled_periods": 2,
                        "expected_periods": 2,
                        "unassigned_periods": 0,
                        "app_constraint_violation_count": 0,
                        "hard_ok": true
                    }
                }
            }
        });

        assert!(complete_existing_incumbent_payload(&request, "timeout", "detail").is_none());
    }

    #[test]
    fn usable_timeout_partial_can_be_best_effort_success() {
        let request = json!({
            "settings": {
                "require_complete_schedule": true,
                "best_effort_on_timeout": true
            }
        });
        let (status, payload) = normalize_reference_payload(
            incomplete_reference_payload(true),
            &request,
            200,
            Instant::now(),
            Duration::from_secs(60),
        );
        let payload: Value = serde_json::from_str(&payload).expect("normalized payload");
        assert_eq!(status, 200);
        assert_eq!(
            payload.get("bestEffort").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            payload
                .get("metrics")
                .and_then(|value| value.get("best_effort"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn reference_budget_caps_helper_below_watchdog() {
        let request = json!({
            "settings": {
                "solver_mode": "auto",
                "auto_sort_mode": "fast",
                "backend_deadline_ms": 55_000,
                "native_global_deadline_ms": 55_000,
                "native_deadline_reserve_ms": 1_500,
                "overall_time_limit_seconds": 55,
                "integrated_time_limit": 55,
                "optimization_time_limit_seconds": 90
            }
        });
        let budget = reference_solver_budget(&request);
        assert_eq!(budget.hard_ms, 55_000);
        assert_eq!(budget.solver_ms, 53_500);
        let body = serde_json::to_vec(&request).expect("request body");
        let helper: Value =
            serde_json::from_slice(&reference_solver_body(&body, &request, budget, 3))
                .expect("helper body");
        assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(53));
        assert_eq!(helper["settings"]["integrated_time_limit"], json!(53));
        assert_eq!(
            helper["settings"]["optimization_time_limit_seconds"],
            json!(53)
        );
        assert_eq!(helper["settings"]["auto_sort_mode"], json!("fast"));
        assert_eq!(helper["settings"]["num_workers"], json!(3));
    }

    #[test]
    fn browser_automatic_uses_the_same_canonical_watchdog_as_other_jobs() {
        let mut request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_browser_wasm_ready": true,
                "optimization_focus": "automatic",
                "backend_deadline_ms": 180_000,
                "native_global_deadline_ms": 180_000
            }
        });
        assert_eq!(reference_solver_budget(&request).hard_ms, 200_000);
        assert_eq!(server_owned_watchdog_budget_ms(&request), 200_000);

        request["settings"]["optimization_focus"] = json!("gaps");
        assert_eq!(server_owned_watchdog_budget_ms(&request), 200_000);
        request["settings"]["optimization_focus"] = json!("automatic");
        request["settings"]["ui_browser_wasm_ready"] = json!(false);
        assert_eq!(server_owned_watchdog_budget_ms(&request), 200_000);
    }

    #[test]
    fn unified_reference_budget_keeps_compute_ceiling_and_adds_watchdog_only() {
        for solve_kind in ["fresh_complete_first", "refine_complete"] {
            let request = json!({
                "settings": {
                    "ui_unified_auto_sort": true,
                    "ui_unified_solve_kind": solve_kind,
                    "ui_unified_reference_watchdog_reserve_ms": 5_000,
                    "backend_deadline_ms": 180_000,
                    "native_global_deadline_ms": 180_000,
                    "native_deadline_reserve_ms": 1_500,
                    "overall_time_limit_seconds": 180,
                    "integrated_time_limit": 180,
                    "optimization_time_limit_seconds": 180
                }
            });
            let budget = reference_solver_budget(&request);
            assert_eq!(budget.backend_ms, 180_000);
            assert_eq!(budget.native_ms, 180_000);
            assert_eq!(budget.solver_ms, 180_000);
            assert_eq!(budget.hard_ms, 200_000);
            assert_eq!(budget.reserve_ms, 20_000);

            let body = serde_json::to_vec(&request).expect("request body");
            let helper: Value =
                serde_json::from_slice(&reference_solver_body(&body, &request, budget, 3))
                    .expect("helper body");
            assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(180));
            assert_eq!(helper["settings"]["integrated_time_limit"], json!(180));
            assert_eq!(
                helper["settings"]["optimization_time_limit_seconds"],
                json!(180)
            );
            assert_eq!(
                helper["settings"]["reference_solver_budget_ms"],
                json!(180_000)
            );
            assert_eq!(
                helper["settings"]["reference_watchdog_deadline_ms"],
                json!(200_000)
            );
            assert_eq!(
                helper["settings"]["ui_unified_reference_watchdog_reserve_ms"],
                json!(20_000)
            );
        }

        let partial_repair = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "repair_partial",
                "ui_unified_partial_repair": true,
                "backend_deadline_ms": 30_000,
                "native_global_deadline_ms": 30_000,
                "native_deadline_reserve_ms": 1_500,
                "overall_time_limit_seconds": 30
            }
        });
        let budget = reference_solver_budget(&partial_repair);
        assert_eq!(budget.hard_ms, 30_000);
        assert_eq!(budget.solver_ms, 28_500);
        assert_eq!(budget.reserve_ms, 1_500);
    }

    #[test]
    fn old_automatic_large_fresh_request_gets_the_current_server_budget_floor() {
        let constrained = json!({
            "data": {
                "tkbConstraints": {
                    "subject": {
                        "Math": {
                            "byClass": {
                                "L1": {"lessonBlocks": {"2": {"min": 1}}}
                            }
                        }
                    }
                }
            },
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "fresh_complete_first",
                "expected_scheduled_periods": 1566,
                "backend_deadline_ms": 60_000,
                "native_global_deadline_ms": 60_000,
                "overall_time_limit_seconds": 60
            }
        });
        let budget = reference_solver_budget(&constrained);
        assert_eq!(budget.backend_ms, 180_000);
        assert_eq!(budget.native_ms, 180_000);
        assert_eq!(budget.solver_ms, 180_000);
        assert_eq!(budget.hard_ms, 200_000);
        assert_eq!(
            solver_progress_budget_seconds(Some(&constrained)),
            Some(180)
        );

        let mut cached_v153_repair = constrained.clone();
        cached_v153_repair["settings"]["ui_unified_solve_kind"] = json!("repair_constraints");
        let cached_budget = reference_solver_budget(&cached_v153_repair);
        assert_eq!(cached_budget.solver_ms, 180_000);
        assert_eq!(cached_budget.hard_ms, 200_000);
        assert_eq!(
            solver_progress_budget_seconds(Some(&cached_v153_repair)),
            Some(180)
        );

        let plain = json!({
            "data": {"tkbConstraints": {}},
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "fresh_complete_first",
                "expected_scheduled_periods": 1566,
                "backend_deadline_ms": 60_000,
                "native_global_deadline_ms": 60_000
            }
        });
        let plain_budget = reference_solver_budget(&plain);
        assert_eq!(plain_budget.solver_ms, 180_000);
        assert_eq!(plain_budget.hard_ms, 200_000);
        assert_eq!(solver_progress_budget_seconds(Some(&plain)), Some(180));

        let mut small = plain.clone();
        small["settings"]["expected_scheduled_periods"] = json!(899);
        let small_budget = reference_solver_budget(&small);
        assert_eq!(small_budget.solver_ms, 60_000);
        assert_eq!(small_budget.hard_ms, 80_000);
        assert_eq!(solver_progress_budget_seconds(Some(&small)), Some(60));

        let mut threshold = plain.clone();
        threshold["settings"]["expected_scheduled_periods"] = json!(900);
        let threshold_budget = reference_solver_budget(&threshold);
        assert_eq!(threshold_budget.solver_ms, 180_000);
        assert_eq!(threshold_budget.hard_ms, 200_000);
        assert_eq!(solver_progress_budget_seconds(Some(&threshold)), Some(180));

        let mut merged = plain;
        merged["settings"]["expected_scheduled_periods"] = json!(2000);
        let merged_budget = reference_solver_budget(&merged);
        assert_eq!(merged_budget.solver_ms, 180_000);
        assert_eq!(merged_budget.hard_ms, 200_000);
        assert_eq!(solver_progress_budget_seconds(Some(&merged)), Some(180));
    }

    #[test]
    fn server_owned_watchdog_uses_compute_window_not_transport_metadata() {
        let request = json!({
            "data": {"tkbConstraints": {}},
            "settings": {
                "backend_deadline_ms": 180_000,
                "native_global_deadline_ms": 180_000,
                "reference_solver_budget_ms": 60_000,
                "reference_watchdog_deadline_ms": 80_000,
                "reference_deadline_reserve_ms": 20_000
            }
        });
        assert_eq!(reference_solver_budget(&request).hard_ms, 80_000);
        assert_eq!(server_owned_watchdog_budget_ms(&request), 200_000);

        let mut short = request;
        short["settings"]["backend_deadline_ms"] = json!(60_000);
        short["settings"]["native_global_deadline_ms"] = json!(60_000);
        assert_eq!(server_owned_watchdog_budget_ms(&short), 80_000);
    }

    #[test]
    fn large_automatic_server_job_replaces_stale_client_watchdog_without_resetting_handoffs() {
        let request = json!({
            "data": {"tkbConstraints": {}},
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "repair_constraints",
                "expected_scheduled_periods": 2031,
                "backend_deadline_ms": 60_000,
                "native_global_deadline_ms": 60_000,
                "reference_solver_budget_ms": 60_000,
                "reference_watchdog_deadline_ms": 80_000,
                "overall_time_limit_seconds": 60,
                "integrated_time_limit": 60,
                "optimization_time_limit_seconds": 60
            }
        });

        // This reproduces the cached-browser payload that used to terminate a
        // valid 72-class solve after roughly 80 seconds.
        assert_eq!(reference_solver_budget(&request).hard_ms, 80_000);
        let canonical_watchdog_ms = server_owned_watchdog_budget_ms(&request);
        assert_eq!(canonical_watchdog_ms, 200_000);

        let initial =
            server_request_with_remaining_watchdog(&request, canonical_watchdog_ms);
        assert_eq!(
            initial["settings"]["reference_watchdog_deadline_ms"],
            json!(200_000)
        );
        let initial_budget = reference_solver_budget(&initial);
        assert_eq!(initial_budget.hard_ms, 200_000);
        assert_eq!(initial_budget.solver_ms, 180_000);

        // Executor changes consume one shared clock. Replaying either the
        // normalized request or the original client body must produce the same
        // smaller remaining cap, never restore 200 seconds and never retain the
        // stale 80-second browser cap.
        for source in [&initial, &request] {
            let handoff = server_request_with_remaining_watchdog(source, 117_500);
            assert_eq!(
                handoff["settings"]["reference_watchdog_deadline_ms"],
                json!(117_500)
            );
            let handoff_budget = reference_solver_budget(&handoff);
            assert_eq!(handoff_budget.hard_ms, 117_500);
            assert_eq!(handoff_budget.solver_ms, 97_500);
        }

        let mut explicit_duration = request;
        explicit_duration["settings"]["ui_custom_solve_duration_seconds"] = json!(60);
        explicit_duration["settings"]["ui_custom_solve_duration_override"] = json!(true);
        assert_eq!(server_owned_watchdog_budget_ms(&explicit_duration), 80_000);
        let explicit = server_request_with_remaining_watchdog(&explicit_duration, 200_000);
        assert_eq!(
            explicit["settings"]["reference_watchdog_deadline_ms"],
            json!(200_000),
            "the server-owned remaining clock replaces stale transport metadata"
        );
        let explicit_budget = reference_solver_budget(&explicit);
        assert_eq!(explicit_budget.solver_ms, 60_000);
        assert_eq!(explicit_budget.hard_ms, 80_000);
    }

    #[test]
    fn production_large_automatic_without_cached_demand_gets_180_second_compute_window() {
        for solve_kind in ["fresh_complete_first", "repair_constraints"] {
            let request = json!({
                "data": {
                    "pccmTietMatrix": {"6A|Math": 2031},
                    "tkbConstraints": {}
                },
                "settings": {
                    "ui_unified_auto_sort": true,
                    "ui_unified_solve_kind": solve_kind,
                    "optimization_focus": "automatic",
                    "ui_custom_solve_duration_seconds": 60,
                    "backend_deadline_ms": 60_000,
                    "native_global_deadline_ms": 60_000,
                    "reference_solver_budget_ms": 60_000,
                    "reference_watchdog_deadline_ms": 80_000,
                    "reference_deadline_reserve_ms": 20_000,
                    "overall_time_limit_seconds": 60,
                    "integrated_time_limit": 60,
                    "optimization_time_limit_seconds": 60
                }
            });

            assert_eq!(expected_periods_from_request(&request), 2031);
            assert_eq!(automatic_large_fresh_budget_floor_ms(&request), 180_000);
            assert_eq!(server_owned_watchdog_budget_ms(&request), 200_000);

            let canonical = server_request_with_remaining_watchdog(&request, 200_000);
            let budget = reference_solver_budget(&canonical);
            assert_eq!(budget.backend_ms, 180_000);
            assert_eq!(budget.native_ms, 180_000);
            assert_eq!(budget.solver_ms, 180_000);
            assert_eq!(budget.hard_ms, 200_000);

            let body = serde_json::to_vec(&canonical).expect("canonical request body");
            let helper: Value = serde_json::from_slice(&reference_solver_body(
                &body,
                &canonical,
                budget,
                6,
            ))
            .expect("canonical helper body");
            assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(180));
            assert_eq!(helper["settings"]["integrated_time_limit"], json!(180));
            assert_eq!(
                helper["settings"]["optimization_time_limit_seconds"],
                json!(180),
            );

            let mut explicit = request;
            explicit["settings"]["ui_custom_solve_duration_override"] = json!(true);
            assert_eq!(automatic_large_fresh_budget_floor_ms(&explicit), 0);
            assert_eq!(server_owned_watchdog_budget_ms(&explicit), 80_000);
        }
    }

    #[test]
    fn explicit_large_fresh_duration_is_not_raised_by_the_server() {
        let request = json!({
            "data": {
                "tkbConstraints": {
                    "subject": {
                        "Math": {"lessonBlocks": {"2": {"min": 1}}}
                    }
                }
            },
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "fresh_complete_first",
                "ui_custom_solve_duration_seconds": 60,
                "ui_custom_solve_duration_override": true,
                "expected_scheduled_periods": 1566,
                "backend_deadline_ms": 60_000,
                "native_global_deadline_ms": 60_000,
                "overall_time_limit_seconds": 60
            }
        });
        let budget = reference_solver_budget(&request);
        assert_eq!(budget.solver_ms, 60_000);
        assert_eq!(budget.hard_ms, 80_000);
        assert_eq!(solver_progress_budget_seconds(Some(&request)), Some(60));

        let mut cached_v153_repair = request.clone();
        cached_v153_repair["settings"]["ui_unified_solve_kind"] = json!("repair_constraints");
        let cached_budget = reference_solver_budget(&cached_v153_repair);
        assert_eq!(cached_budget.solver_ms, 60_000);
        assert_eq!(cached_budget.hard_ms, 80_000);

        let mut automatic_repair = cached_v153_repair.clone();
        automatic_repair["data"]["tkbConstraints"] = json!({});
        automatic_repair["settings"]["ui_custom_solve_duration_seconds"] = json!(0);
        let automatic_repair_budget = reference_solver_budget(&automatic_repair);
        assert_eq!(automatic_repair_budget.backend_ms, 180_000);
        assert_eq!(automatic_repair_budget.native_ms, 180_000);
        assert_eq!(automatic_repair_budget.solver_ms, 180_000);
        assert_eq!(automatic_repair_budget.hard_ms, 200_000);
        assert_eq!(
            solver_progress_budget_seconds(Some(&automatic_repair)),
            Some(180)
        );
        let automatic_repair_body =
            serde_json::to_vec(&automatic_repair).expect("automatic repair body");
        let helper: Value = serde_json::from_slice(&reference_solver_body(
            &automatic_repair_body,
            &automatic_repair,
            automatic_repair_budget,
            6,
        ))
        .expect("automatic repair helper body");
        assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(180));

        let mut zero_slack = request.clone();
        zero_slack["settings"]
            .as_object_mut()
            .expect("zero-slack settings")
            .remove("ui_custom_solve_duration_override");
        zero_slack["settings"]["expected_scheduled_periods"] = json!(2031);
        zero_slack["settings"]["tight_class_fixed_off_profile"] = json!({
            "expected": 2031,
            "availableSlots": 2031,
            "fixedSlots": 2289,
            "slack": 0
        });
        let zero_slack_budget = reference_solver_budget(&zero_slack);
        assert_eq!(zero_slack_budget.backend_ms, 180_000);
        assert_eq!(zero_slack_budget.native_ms, 180_000);
        assert_eq!(zero_slack_budget.solver_ms, 180_000);
        assert_eq!(zero_slack_budget.hard_ms, 200_000);
        assert_eq!(solver_progress_budget_seconds(Some(&zero_slack)), Some(180));

        zero_slack["settings"]["integrated_time_limit"] = json!(60);
        zero_slack["settings"]["optimization_time_limit_seconds"] = json!(60);
        let zero_slack_body = serde_json::to_vec(&zero_slack).expect("zero-slack body");
        let helper: Value = serde_json::from_slice(&reference_solver_body(
            &zero_slack_body,
            &zero_slack,
            zero_slack_budget,
            6,
        ))
        .expect("zero-slack helper body");
        assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(180));
        assert_eq!(helper["settings"]["integrated_time_limit"], json!(180));
        assert_eq!(
            helper["settings"]["optimization_time_limit_seconds"],
            json!(180)
        );

        zero_slack["settings"]["ui_custom_solve_duration_override"] = json!(true);
        zero_slack["settings"]["tight_class_fixed_off_profile"]["availableSlots"] = json!(2032);
        let mismatched_profile_budget = reference_solver_budget(&zero_slack);
        assert_eq!(mismatched_profile_budget.solver_ms, 60_000);
        assert_eq!(mismatched_profile_budget.hard_ms, 80_000);
        let mismatched_body = serde_json::to_vec(&zero_slack).expect("mismatched body");
        let helper: Value = serde_json::from_slice(&reference_solver_body(
            &mismatched_body,
            &zero_slack,
            mismatched_profile_budget,
            6,
        ))
        .expect("mismatched helper body");
        assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(60));
        assert_eq!(helper["settings"]["integrated_time_limit"], json!(60));
        assert_eq!(
            helper["settings"]["optimization_time_limit_seconds"],
            json!(60)
        );
    }

    #[test]
    fn focused_server_job_is_seeded_with_the_visible_incumbent_metric() {
        let request = json!({
            "settings": {
                "ui_requested_solve_mode": "optimize_sessions",
                "ui_progress_mode": "work",
                "ui_progress_metric_focus": "teacher_sessions",
                "ui_progress_metric_current": 654,
                "ui_progress_metric_target": 432,
                "ui_progress_metric_baseline": 654,
                "ui_progress_metric_percent": 66
            }
        });
        let progress = solver_initial_work_progress(Some(&request)).expect("focused progress");
        assert_eq!(progress["protocol"], json!(REFERENCE_PROGRESS_PROTOCOL));
        assert_eq!(progress["stage"], json!("request:accepted"));
        assert_eq!(progress["solveRequestMode"], json!("optimize_sessions"));
        assert_eq!(progress["optimizationFocus"], json!("teacher_sessions"));
        assert_eq!(progress["metricCurrent"], json!(654));
        assert_eq!(progress["metricTarget"], json!(432));
        assert_eq!(progress["metricBaseline"], json!(654));
        assert_eq!(progress["metricPercent"], json!(66));

        let gap_request = json!({
            "settings": {
                "ui_requested_solve_mode": "optimize_gaps",
                "ui_progress_mode": "work",
                "ui_progress_metric_focus": "teacher_gap1_sessions",
                "ui_progress_metric_current": 12,
                "ui_progress_metric_target": 0,
                "ui_progress_metric_baseline": 10,
                "ui_progress_metric_percent": 0,
                "ui_progress_gap1_baseline": 10,
                "ui_progress_gap2_baseline": 4
            }
        });
        let gap_progress = solver_initial_work_progress(Some(&gap_request)).expect("gap progress");
        assert_eq!(gap_progress["metricBaseline"], json!(10));
        assert_eq!(gap_progress["metricPercent"], json!(0));
        assert_eq!(gap_progress["gap1Baseline"], json!(10));
        assert_eq!(gap_progress["gap2Baseline"], json!(4));

        for (mode, focus, current, baseline) in [
            ("optimize_gap2", "teacher_gap2_sessions", 2, 4),
            ("optimize_gap1", "teacher_gap1_sessions", 5, 8),
        ] {
            let split_request = json!({
                "settings": {
                    "ui_requested_solve_mode": mode,
                    "ui_progress_mode": "work",
                    "ui_progress_metric_focus": focus,
                    "ui_progress_metric_current": current,
                    "ui_progress_metric_target": 0,
                    "ui_progress_metric_baseline": baseline,
                    "ui_progress_metric_percent": 0,
                    "ui_progress_gap1_baseline": 8,
                    "ui_progress_gap2_baseline": 4
                }
            });
            let split =
                solver_initial_work_progress(Some(&split_request)).expect("split gap progress");
            assert_eq!(split["solveRequestMode"], json!(mode));
            assert_eq!(split["optimizationFocus"], json!(focus));
            assert_eq!(split["metricCurrent"], json!(current));
            assert_eq!(split["metricBaseline"], json!(baseline));
        }

        let mut automatic = request;
        automatic["settings"]["ui_requested_solve_mode"] = json!("automatic");
        assert!(solver_initial_work_progress(Some(&automatic)).is_none());
    }

    #[test]
    fn unified_reference_budget_keeps_serialization_reserve_inside_remaining_watchdog() {
        let request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_unified_reference_watchdog_reserve_ms": 5_000,
                "backend_deadline_ms": 180_000,
                "native_global_deadline_ms": 180_000,
                "reference_watchdog_deadline_ms": 120_000,
                "overall_time_limit_seconds": 180
            }
        });
        let budget = reference_solver_budget(&request);
        assert_eq!(budget.hard_ms, 120_000);
        assert_eq!(budget.solver_ms, 100_000);
        assert_eq!(budget.reserve_ms, 20_000);

        let body = serde_json::to_vec(&request).expect("request body");
        let helper: Value =
            serde_json::from_slice(&reference_solver_body(&body, &request, budget, 3))
                .expect("helper body");
        assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(100));
        assert_eq!(
            helper["settings"]["reference_watchdog_deadline_ms"],
            json!(120_000)
        );
        assert_eq!(
            helper["settings"]["ui_unified_reference_watchdog_reserve_ms"],
            json!(20_000)
        );
    }

    #[test]
    fn explicit_hybrid_cloud_run_budget_is_clamped_server_side() {
        let mut standard = json!({
            "settings": {
                "ui_hybrid_executor": "cloud_run",
                "ui_hybrid_deep_optimize": false,
                "overall_time_limit_seconds": 999,
                "integrated_time_limit": 999,
                "optimization_time_limit_seconds": 999,
                "backend_deadline_ms": 999_000,
                "native_global_deadline_ms": 999_000
            }
        });
        assert_eq!(clamp_hybrid_cloud_run_request(&mut standard), Some(60));
        let settings = request_settings(&standard).expect("standard settings");
        assert_eq!(settings.get("routing_mode"), Some(&json!("serverless_only")));
        assert_eq!(settings.get("overall_time_limit_seconds"), Some(&json!(60)));
        assert_eq!(settings.get("backend_deadline_ms"), Some(&json!(60_000)));
        assert_eq!(solver_progress_budget_seconds(Some(&standard)), Some(60));
        let standard_budget = reference_solver_budget(&standard);
        assert_eq!(standard_budget.backend_ms, 60_000);
        assert_eq!(standard_budget.native_ms, 60_000);

        let mut deep = standard;
        deep["settings"]["ui_hybrid_deep_optimize"] = json!(true);
        deep["settings"]["backend_deadline_ms"] = json!(999_000);
        assert_eq!(clamp_hybrid_cloud_run_request(&mut deep), Some(180));
        let deep_settings = request_settings(&deep).expect("deep settings");
        assert_eq!(deep_settings.get("overall_time_limit_seconds"), Some(&json!(180)));
        assert_eq!(deep_settings.get("backend_deadline_ms"), Some(&json!(180_000)));
        assert_eq!(solver_progress_budget_seconds(Some(&deep)), Some(180));
        let deep_budget = reference_solver_budget(&deep);
        assert_eq!(deep_budget.backend_ms, 180_000);
        assert_eq!(deep_budget.native_ms, 180_000);
    }

    #[test]
    fn cloud_run_client_caps_270_second_compute_below_platform_timeout() {
        let request = json!({
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_unified_reference_watchdog_reserve_ms": 20_000,
                "backend_deadline_ms": 270_000,
                "native_global_deadline_ms": 270_000,
                "overall_time_limit_seconds": 270
            }
        });
        let budget = reference_solver_budget(&request);
        assert_eq!(budget.solver_ms, 270_000);
        assert_eq!(budget.reserve_ms, 20_000);
        assert_eq!(budget.hard_ms, 290_000);
        assert_eq!(
            cloud_run_client_timeout_seconds(budget),
            CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS
        );

        let legacy = ReferenceBudget {
            hard_ms: 360_000,
            solver_ms: 330_000,
            reserve_ms: 30_000,
            backend_ms: 330_000,
            native_ms: 330_000,
        };
        assert_eq!(
            cloud_run_client_timeout_seconds(legacy),
            CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS
        );
    }

    #[test]
    fn reference_helper_uses_the_exact_allocated_worker_count() {
        let request = json!({
            "settings": {
                "num_workers": 1,
                "expected_scheduled_periods": 3_300,
                "backend_deadline_ms": 10_000
            }
        });
        let budget = reference_solver_budget(&request);
        let body = serde_json::to_vec(&request).expect("request body");
        let helper: Value =
            serde_json::from_slice(&reference_solver_body(&body, &request, budget, 4))
                .expect("helper body");
        assert_eq!(helper["settings"]["num_workers"], json!(4));
    }

    #[test]
    fn agent_worker_policy_scales_quality_by_workload_without_using_every_core() {
        let medium = json!({
            "data": {},
            "settings": {
                "optimization_focus": "automatic",
                "expected_scheduled_periods": 1_566
            }
        });
        let large = json!({
            "data": {},
            "settings": {
                "optimization_focus": "sessions",
                "expected_scheduled_periods": 3_300
            }
        });
        let very_large = json!({
            "data": {},
            "settings": {
                "optimization_focus": "sessions",
                "expected_scheduled_periods": 5_000
            }
        });
        assert_eq!(adaptive_agent_worker_count(&medium, 22), 6);
        assert_eq!(adaptive_agent_worker_count(&large, 22), 8);
        assert_eq!(adaptive_agent_worker_count(&very_large, 22), 12);
        assert_eq!(adaptive_agent_worker_count(&large, 3), 3);
        assert_eq!(adaptive_agent_worker_count(&large, 1), 1);
    }

    #[test]
    fn agent_workload_falls_back_to_progress_and_incumbent_evidence() {
        let progress = json!({
            "settings": {
                "optimization_focus": "automatic",
                "ui_progress_metric_focus": "scheduled-periods",
                "ui_progress_metric_target": "1566"
            }
        });
        assert_eq!(agent_request_workload_periods(&progress), 1_566);
        assert_eq!(adaptive_agent_worker_count(&progress, 22), 6);

        let incumbent = json!({
            "data": {
                "tkbRustSolverResult": {
                    "metrics": {
                        "scheduled_periods": 3_100,
                        "unassigned_periods": 200
                    },
                    "lessons": [1, 2]
                }
            },
            "settings": {"optimization_focus": "automatic"}
        });
        assert_eq!(agent_request_workload_periods(&incumbent), 3_300);
        assert_eq!(adaptive_agent_worker_count(&incumbent, 22), 8);
    }

    #[test]
    fn agent_workload_derives_periods_when_settings_omit_the_advisory_count() {
        let request = json!({
            "data": {
                "pccmTietMatrix": {
                    "6A1|Math": 1_650,
                    "6A2|Math": 1_650
                }
            },
            "settings": {"optimization_focus": "automatic"}
        });
        assert_eq!(agent_request_workload_periods(&request), 3_300);
        assert_eq!(adaptive_agent_worker_count(&request, 22), 8);
    }

    #[test]
    fn legacy_quick_agent_worker_policy_keeps_its_smaller_tiers() {
        for (workload, expected) in [(0, 4), (128, 1), (512, 2), (2_000, 4), (3_300, 8)] {
            let request = json!({
                "data": {},
                "settings": {
                    "optimization_focus": "quick_complete",
                    "expected_scheduled_periods": workload
                }
            });
            assert_eq!(adaptive_agent_worker_count(&request, 22), expected);
        }
    }

    #[test]
    fn agent_claims_apply_adaptive_width_but_reference_vps_width_stays_exact() {
        let request = json!({
            "data": {},
            "settings": {
                "optimization_focus": "automatic",
                "expected_scheduled_periods": 1_566,
                "backend_deadline_ms": 10_000
            }
        });
        let request_body = serde_json::to_vec(&request).expect("request body");
        let lease = AgentWorkLease {
            work_id: "work-adaptive-workers".to_string(),
            job_id: "job-adaptive-workers".to_string(),
            job_owner: SolverOwner::new("school-adaptive-workers", "admin"),
            lease_token: "lease-adaptive-workers".to_string(),
            lease_expires_at_ms: 1,
            seed: 7,
            attempt: 1,
            request_body: Arc::new(request_body.clone()),
        };
        let claim = agent_helper_claim_payload(lease, 22, false, None);
        assert_eq!(
            claim["lease"]["payload"]["settings"]["num_workers"],
            json!(6)
        );
        assert_eq!(claim["lease"]["limits"]["cpuWorkers"], json!(6));

        let exact = external_cp_sat_agent_request(
            &request_body,
            "job-adaptive-workers",
            7,
            22,
            false,
            None,
        )
        .expect("external exact request");
        assert_eq!(exact["settings"]["num_workers"], json!(6));

        let budget = reference_solver_budget(&request);
        let vps: Value =
            serde_json::from_slice(&reference_solver_body(&request_body, &request, budget, 5))
                .expect("reference VPS body");
        assert_eq!(vps["settings"]["num_workers"], json!(5));
    }

    #[test]
    fn reference_deadlines_are_clamped_and_zero_reserve_is_honored() {
        let request = json!({
            "settings": {
                "backend_deadline_ms": u64::MAX,
                "native_global_deadline_ms": u64::MAX,
                "native_deadline_reserve_ms": 0
            }
        });
        let budget = reference_solver_budget(&request);
        assert_eq!(budget.hard_ms, MAX_SOLVER_DEADLINE_MS);
        assert_eq!(budget.solver_ms, MAX_SOLVER_DEADLINE_MS);
        assert_eq!(budget.reserve_ms, 0);
    }

    #[test]
    fn convergence_watchdog_is_shared_by_progress_and_agent_leases() {
        let request = json!({
            "data": {},
            "settings": {
                "backend_deadline_ms": MAX_SOLVER_DEADLINE_MS,
                "ui_progress_budget_seconds": u64::MAX
            }
        });
        assert_eq!(
            solver_progress_budget_seconds(Some(&request)),
            Some(MAX_SOLVER_DEADLINE_MS / 1_000)
        );

        let lease = AgentWorkLease {
            work_id: "work-convergence".to_string(),
            job_id: "job-convergence".to_string(),
            job_owner: SolverOwner::new("school-convergence", "admin"),
            lease_token: "lease-convergence".to_string(),
            lease_expires_at_ms: 1,
            seed: 7,
            attempt: 1,
            request_body: Arc::new(serde_json::to_vec(&request).expect("request")),
        };
        let payload = agent_helper_claim_payload(lease, 4, false, None);
        assert_eq!(
            payload["lease"]["limits"]["timeoutSeconds"],
            json!(MAX_SOLVER_DEADLINE_MS / 1_000)
        );
    }

    #[test]
    fn browser_agent_lease_keeps_internal_admission_marker() {
        let request = json!({
            "data": {},
            "settings": {
                "optimization_focus": "automatic",
                "ui_solver_async_job": true,
                "ui_solver_fifo_admission": true
            }
        });
        let lease = || AgentWorkLease {
            work_id: "work-browser-marker".to_string(),
            job_id: "job-browser-marker".to_string(),
            job_owner: SolverOwner::new("school-browser-marker", "admin"),
            lease_token: "lease-browser-marker".to_string(),
            lease_expires_at_ms: 1,
            seed: 7,
            attempt: 1,
            request_body: Arc::new(serde_json::to_vec(&request).expect("request")),
        };

        let browser_payload = agent_helper_claim_payload(lease(), 4, true, None);
        assert_eq!(
            browser_payload["lease"]["payload"]["settings"]["browser_wasm_server_lease"],
            json!(true)
        );
        assert_eq!(
            browser_payload["lease"]["payload"]["settings"]["ui_solver_async_job"],
            json!(false)
        );
        assert_eq!(
            browser_payload["lease"]["payload"]["settings"]["ui_solver_fifo_admission"],
            json!(false)
        );

        let native_payload = agent_helper_claim_payload(lease(), 4, false, None);
        assert!(native_payload["lease"]["payload"]["settings"]
            .get("browser_wasm_server_lease")
            .is_none());
    }

    #[test]
    fn agent_executors_share_reference_worker_deadline_and_seed_contract() {
        let request = json!({
            "data": {},
            "settings": {
                "solver_mode": "shuffle_fill",
                "auto_sort_mode": "shuffle_fill",
                "require_complete_schedule": true,
                "optimization_focus": "sessions",
                "num_workers": 1,
                "backend_deadline_ms": 55_000,
                "native_global_deadline_ms": 55_000,
                "native_deadline_reserve_ms": 1_500,
                "overall_time_limit_seconds": 55,
                "integrated_time_limit": 55,
                "optimization_time_limit_seconds": 55
            }
        });
        let request_body = serde_json::to_vec(&request).expect("request body");
        let lease = || AgentWorkLease {
            work_id: "work-reference-contract".to_string(),
            job_id: "job-reference-contract".to_string(),
            job_owner: SolverOwner::new("school-reference-contract", "admin"),
            lease_token: "lease-reference-contract".to_string(),
            lease_expires_at_ms: 1,
            seed: 42,
            attempt: 1,
            request_body: Arc::new(request_body.clone()),
        };

        let native = agent_helper_claim_payload(lease(), 4, false, Some(37_500));
        let browser = agent_helper_claim_payload(lease(), 4, true, Some(37_500));
        let browser_exact = external_cp_sat_agent_request(
            &request_body,
            "job-reference-contract",
            42,
            4,
            false,
            Some(37_500),
        )
        .expect("Browser exact request");
        let native_settings = native["lease"]["payload"]["settings"]
            .as_object()
            .expect("native settings");
        let browser_settings = browser["lease"]["payload"]["settings"]
            .as_object()
            .expect("Browser settings");
        let browser_exact_settings = browser_exact["settings"]
            .as_object()
            .expect("Browser exact settings");

        for key in [
            "reference_solver_contract_version",
            "solver_mode",
            "auto_sort_mode",
            "num_workers",
            "backend_deadline_ms",
            "native_global_deadline_ms",
            "reference_solver_budget_ms",
            "reference_watchdog_deadline_ms",
            "reference_deadline_reserve_ms",
            "overall_time_limit_seconds",
            "integrated_time_limit",
            "optimization_time_limit_seconds",
            "random_seed",
            "agent_helper_seed",
        ] {
            assert_eq!(
                native_settings.get(key),
                browser_settings.get(key),
                "native and Browser lease diverged at {key}"
            );
            assert_eq!(
                native_settings.get(key),
                browser_exact_settings.get(key),
                "native and Browser exact request diverged at {key}"
            );
        }
        assert_eq!(native_settings.get("solver_mode"), Some(&json!("auto")));
        assert_eq!(
            native_settings.get("reference_solver_contract_version"),
            Some(&json!(REFERENCE_SOLVER_CONTRACT_VERSION))
        );
        assert_eq!(native_settings.get("auto_sort_mode"), Some(&json!("fast")));
        assert_eq!(native_settings.get("num_workers"), Some(&json!(4)));
        assert_eq!(
            native_settings.get("reference_solver_budget_ms"),
            Some(&json!(36_000))
        );
        assert_eq!(
            native_settings.get("reference_watchdog_deadline_ms"),
            Some(&json!(37_500))
        );
        assert_eq!(
            native_settings.get("overall_time_limit_seconds"),
            Some(&json!(36))
        );
        assert_eq!(native_settings.get("random_seed"), Some(&json!(42)));
    }

    #[test]
    fn server_owned_vps_and_agent_use_the_same_canonical_job_seed() {
        let job_id = "job-canonical-seed";
        let original = json!({
            "data": {},
            "settings": {"random_seed": 999, "agent_helper_seed": 998}
        });
        let seeded = server_request_with_canonical_seed(&original, job_id);
        let canonical_seed = agent_helper::canonical_job_seed(job_id);
        assert_eq!(seeded["settings"]["random_seed"], json!(canonical_seed));
        assert_eq!(
            seeded["settings"]["agent_helper_seed"],
            json!(canonical_seed)
        );

        let lease = AgentWorkLease {
            work_id: "work-canonical-seed".to_string(),
            job_id: job_id.to_string(),
            job_owner: SolverOwner::new("school-canonical-seed", "admin"),
            lease_token: "lease-canonical-seed".to_string(),
            lease_expires_at_ms: 1,
            seed: canonical_seed,
            attempt: 1,
            request_body: Arc::new(serde_json::to_vec(&seeded).expect("request")),
        };
        let agent = agent_helper_claim_payload(lease, 4, false, None);
        assert_eq!(
            agent["lease"]["payload"]["settings"]["random_seed"],
            seeded["settings"]["random_seed"]
        );
        assert_eq!(
            agent["lease"]["payload"]["settings"]["agent_helper_seed"],
            seeded["settings"]["agent_helper_seed"]
        );
    }

    #[test]
    fn server_handoff_caps_every_agent_and_vps_deadline_to_remaining_budget() {
        let request = json!({
            "data": {},
            "settings": {
                "backend_deadline_ms": 180_000,
                "native_global_deadline_ms": 180_000,
                "native_deadline_reserve_ms": 1_500,
                "overall_time_limit_seconds": 180,
                "integrated_time_limit": 180,
                "optimization_time_limit_seconds": 180
            }
        });
        let capped = server_request_with_remaining_watchdog(&request, 37_500);
        let settings = capped.get("settings").and_then(Value::as_object).unwrap();
        assert_eq!(settings.get("backend_deadline_ms"), Some(&json!(37_500)));
        assert_eq!(
            settings.get("native_global_deadline_ms"),
            Some(&json!(37_500))
        );
        assert_eq!(
            settings.get("reference_watchdog_deadline_ms"),
            Some(&json!(37_500))
        );
        assert_eq!(settings.get("overall_time_limit_seconds"), Some(&json!(37)));
        assert_eq!(settings.get("integrated_time_limit"), Some(&json!(37)));
        assert_eq!(
            settings.get("optimization_time_limit_seconds"),
            Some(&json!(37))
        );
        let budget = reference_solver_budget(&capped);
        assert_eq!(budget.hard_ms, 37_500);
        assert_eq!(budget.backend_ms, 37_500);
        assert_eq!(budget.native_ms, 37_500);

        let body = serde_json::to_vec(&request).expect("request body");
        let capped_body =
            server_request_body_with_remaining_watchdog(&body, Some(&request), 37_500);
        let decoded: Value = serde_json::from_slice(&capped_body).expect("capped body");
        assert_eq!(
            decoded["settings"]["reference_watchdog_deadline_ms"],
            json!(37_500)
        );

        let mut unified_request = request;
        unified_request["settings"]["ui_unified_auto_sort"] = json!(true);
        unified_request["settings"]["ui_unified_solve_kind"] = json!("refine_complete");
        unified_request["settings"]["ui_unified_reference_watchdog_reserve_ms"] = json!(5_000);
        let unified = server_request_with_remaining_watchdog(&unified_request, 37_500);
        assert_eq!(
            unified["settings"]["ui_unified_reference_watchdog_reserve_ms"],
            json!(20_000)
        );
        assert_eq!(
            unified["settings"]["reference_deadline_reserve_ms"],
            json!(20_000)
        );
        let unified_budget = reference_solver_budget(&unified);
        assert_eq!(unified_budget.hard_ms, 37_500);
        assert_eq!(unified_budget.solver_ms, 17_500);
        assert_eq!(unified_budget.reserve_ms, 20_000);
    }

    #[test]
    fn reference_stdio_parser_accepts_exact_framed_wrapper() {
        let stdout = serde_json::to_string(&json!({
            "protocol": REFERENCE_STDIO_PROTOCOL,
            "status": 200,
            "payload": {"ok": true, "run": "framed"}
        }))
        .expect("wrapper JSON");

        let parsed = parse_reference_solver_wrapper(&stdout).expect("framed wrapper");
        assert_eq!(parsed["status"], json!(200));
        assert_eq!(parsed["payload"]["run"], json!("framed"));
    }

    #[test]
    fn reference_stdio_parser_recovers_wrapper_from_native_noise() {
        let wrapper = serde_json::to_string(&json!({
            "protocol": REFERENCE_STDIO_PROTOCOL,
            "status": 422,
            "payload": {"ok": false, "kind": "incomplete_schedule"}
        }))
        .expect("wrapper JSON");
        let stdout = format!(
            "HiGHS debug before {{not-json}}\n{wrapper}\nHiGHS debug after {{phase=done}}\n"
        );

        let parsed = parse_reference_solver_wrapper(&stdout).expect("noisy wrapper");
        assert_eq!(parsed["status"], json!(422));
        assert_eq!(parsed["payload"]["kind"], json!("incomplete_schedule"));
    }

    #[test]
    fn reference_stdio_parser_prefers_frame_and_uses_last_legacy_wrapper() {
        let legacy_first = r#"{"status":200,"payload":{"run":"legacy-first"}}"#;
        let legacy_last = r#"{"status":409,"payload":{"run":"legacy-last"}}"#;
        let legacy_stdout = format!("debug\n{legacy_first}\nmore debug\n{legacy_last}\ntail");
        let parsed = parse_reference_solver_wrapper(&legacy_stdout).expect("last legacy wrapper");
        assert_eq!(parsed["payload"]["run"], json!("legacy-last"));

        let framed = serde_json::to_string(&json!({
            "protocol": REFERENCE_STDIO_PROTOCOL,
            "status": 200,
            "payload": {"run": "trusted-frame"}
        }))
        .expect("wrapper JSON");
        let mixed_stdout = format!("{framed}\nnoise\n{legacy_last}\n");
        let parsed = parse_reference_solver_wrapper(&mixed_stdout).expect("framed wrapper wins");
        assert_eq!(parsed["payload"]["run"], json!("trusted-frame"));
    }

    #[test]
    fn authoritative_agent_validation_is_enabled_only_for_active_constraints() {
        let inactive = serde_json::to_vec(&json!({
            "data": {
                "tkbConstraints": {
                    "version": "constraints-ui-v38-one-session-responsive-tables",
                    "groups": {
                        "class": {
                            "all-grade-6": {"name": "Khoi 6", "items": ["6A1"]}
                        }
                    },
                    "meta": {
                        "updatedAt": "2026-07-25T16:00:00.000Z",
                        "schoolName": "Cherry"
                    },
                    "teacher": {
                        "T1": {
                            "maxDaysSessions": {"maxDays": 0},
                            "oneSessionPerDay": {"thu2": false}
                        }
                    }
                }
            }
        }))
        .unwrap();
        let active = serde_json::to_vec(&json!({
            "data": {
                "tkbConstraints": {
                    "teacher": {"T1": {"maxDaysSessions": {"maxDays": 3}}}
                }
            }
        }))
        .unwrap();

        assert!(!request_has_active_tkb_constraints(&inactive));
        assert!(request_has_active_tkb_constraints(&active));
    }

    #[test]
    fn reference_stdio_parser_rejects_wrong_wrapper_schema() {
        for stdout in [
            r#"{"status":200,"payload":"not-an-object"}"#,
            r#"{"protocol":"other-protocol","status":200,"payload":{"ok":true}}"#,
            r#"{"payload":{"status":200,"payload":{"ok":true}}}"#,
        ] {
            assert!(
                parse_reference_solver_wrapper(stdout).is_err(),
                "unexpectedly accepted {stdout}"
            );
        }
    }

    #[test]
    fn reference_progress_parser_accepts_only_bounded_framed_events() {
        let line = format!(
            "{}{}\r\n",
            REFERENCE_PROGRESS_PREFIX,
            serde_json::to_string(&json!({
                "protocol":REFERENCE_PROGRESS_PROTOCOL,
                "stage":"period:session_done",
                "message":"done",
                "sequence":9,
                "elapsedMs":4321
            }))
            .expect("progress JSON")
        );
        let parsed = parse_reference_progress_frame(line.as_bytes()).expect("progress frame");
        assert_eq!(parsed["stage"], json!("period:session_done"));
        assert_eq!(parsed["sequence"], json!(9));

        assert!(parse_reference_progress_frame(b"native diagnostic\n").is_none());
        assert!(parse_reference_progress_frame(
            b"@@TKB_PROGRESS@@{\"protocol\":\"wrong\",\"stage\":\"session:solve\"}\n"
        )
        .is_none());
        let oversized = format!(
            "{}{{\"protocol\":\"{}\",\"stage\":\"session:solve\",\"message\":\"{}\"}}\n",
            REFERENCE_PROGRESS_PREFIX,
            REFERENCE_PROGRESS_PROTOCOL,
            "x".repeat(MAX_REFERENCE_PROGRESS_FRAME_BYTES)
        );
        assert!(parse_reference_progress_frame(oversized.as_bytes()).is_none());
    }

    #[test]
    fn terminal_result_grace_only_follows_a_successful_complete_frame() {
        let complete = json!({"stage": "result:complete", "status": 200});
        assert!(reference_progress_reports_complete(&complete));
        assert!(!reference_progress_reports_complete(
            &json!({"stage": "result:error", "status": 422})
        ));
        assert!(!reference_progress_reports_complete(
            &json!({"stage": "result:complete", "status": 500})
        ));

        let deadline = Duration::from_secs(80);
        assert!(reference_terminal_grace_active(
            true,
            deadline + Duration::from_millis(1),
            deadline,
        ));
        assert!(!reference_terminal_grace_active(
            true,
            deadline + Duration::from_millis(REFERENCE_TERMINAL_RESULT_GRACE_MS),
            deadline,
        ));
        assert!(!reference_terminal_grace_active(
            false,
            deadline + Duration::from_millis(1),
            deadline,
        ));
    }

    #[test]
    fn completed_stdout_wrapper_survives_a_deadline_boundary() {
        let request = json!({
            "settings": {
                "backend_deadline_ms": 1_000,
                "native_global_deadline_ms": 1_000,
                "require_complete_schedule": true
            }
        });
        let stdout = serde_json::to_string(&json!({
            "protocol": REFERENCE_STDIO_PROTOCOL,
            "status": 200,
            "payload": {
                "ok": true,
                "lessons": [{"classId": "L1", "day": 2, "period": 1}],
                "unassignedLessons": [],
                "metrics": {
                    "scheduled_periods": 1,
                    "expected_periods": 1,
                    "unassigned_periods": 0,
                    "app_constraint_violation_count": 0,
                    "hard_ok": true,
                    "core_hard_ok": true
                }
            }
        }))
        .expect("stdout wrapper");
        let started = Instant::now()
            .checked_sub(Duration::from_secs(2))
            .expect("test instant");
        let (status, payload) =
            decode_reference_solver_stdout(&stdout, &request, started, Duration::from_secs(1))
                .expect("complete wrapper must remain decodable after the deadline");
        let payload: Value = serde_json::from_str(&payload).expect("normalized payload");
        assert_eq!(status, 200);
        assert_eq!(payload["ok"], json!(true));
        assert_eq!(payload["metrics"]["scheduled_periods"], json!(1));
        assert_eq!(
            payload["solver"]["runtime_settings"]["deadline_hit"],
            json!(true)
        );
    }

    #[test]
    fn cloud_terminal_result_requires_the_pinned_digest_and_protocol() {
        let digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let profile = serverless::ServerlessProfile {
            id: "primary".to_string(),
            url: "https://solver.example.run.app".to_string(),
            audience: "https://solver.example.run.app".to_string(),
            region: "asia-southeast1".to_string(),
            project_id: "example-project".to_string(),
            enabled: true,
            priority: 1,
            vcpu: 6,
            memory_gib: 4.0,
            max_concurrency: 1,
            solver_digest: digest.to_string(),
        };
        let payload = json!({
            "ok":true,
            "solver":{"runtime_settings":{
                "cloud_solver_digest":digest,
                "cloud_protocol":"tkb-cloud-solver-v1"
            }}
        })
        .to_string();
        assert!(validate_cloud_solver_result((200, payload.clone()), Some(&profile)).is_ok());

        let stale = payload.replace(digest, &"b".repeat(64));
        assert_eq!(
            validate_cloud_solver_result((200, stale), Some(&profile)).unwrap_err(),
            "cloud_solver_digest_mismatch"
        );
        let wrong_protocol = payload.replace("tkb-cloud-solver-v1", "tkb-cloud-solver-v0");
        assert_eq!(
            validate_cloud_solver_result((200, wrong_protocol), Some(&profile)).unwrap_err(),
            "cloud_solver_protocol_mismatch"
        );
    }

    #[test]
    fn missing_reference_helper_is_service_unavailable() {
        assert_eq!(
            reference_solver_error_status("reference solver script not found"),
            503
        );
        assert_eq!(
            reference_solver_error_status("reference solver returned invalid JSON"),
            500
        );
    }

    #[test]
    fn external_cp_sat_agent_request_is_canonical_seeded_and_watchdog_bounded() {
        let body = serde_json::to_vec(&json!({
            "data": {"pccmTietMatrix": {"L1|Math": 1_566}},
            "settings": {
                "backend_deadline_ms": 180_000,
                "native_global_deadline_ms": 180_000,
                "overall_time_limit_seconds": 180,
                "ui_solver_async_job": true,
                "ui_solver_fifo_admission": true
            }
        }))
        .expect("request body");
        let request =
            external_cp_sat_agent_request(&body, "job-wire", 42, 999, false, Some(60_000))
                .expect("external CP-SAT request");
        let settings = request["settings"].as_object().expect("settings");
        assert_eq!(settings["random_seed"], json!(42));
        assert_eq!(settings["agent_helper_seed"], json!(42));
        assert_eq!(settings["num_workers"], json!(6));
        assert_eq!(settings["ui_solver_async_job"], json!(false));
        assert_eq!(settings["ui_solver_fifo_admission"], json!(false));
        assert_eq!(settings["browser_wasm_external_cp_sat"], json!(true));
        assert!(settings["backend_deadline_ms"].as_u64().unwrap_or_default() <= 60_000);
        assert!(
            settings["native_global_deadline_ms"]
                .as_u64()
                .unwrap_or_default()
                <= 60_000
        );
        assert!(
            settings["overall_time_limit_seconds"]
                .as_u64()
                .unwrap_or_default()
                <= 60
        );
    }

    #[test]
    fn desktop_exact_refinement_enables_full_reference_only_with_six_workers() {
        let body = serde_json::to_vec(&json!({
            "data": {
                "tkbSolverResult": {
                    "ok": true,
                    "lessons": [
                        {"classId":"6A","subjectId":"Math","day":2,"period":1},
                        {"classId":"6A","subjectId":"Math","day":2,"period":2}
                    ],
                    "unassignedLessons": [],
                    "metrics": {
                        "expected_periods": 2,
                        "scheduled_periods": 2,
                        "unassigned_periods": 0,
                        "app_constraint_violation_count": 0,
                        "hard_ok": true
                    }
                }
            },
            "settings": {
                "ui_unified_auto_sort": true,
                "ui_unified_solve_kind": "refine_complete",
                "ui_use_existing_complete_incumbent": true,
                "ui_existing_incumbent_revalidated": true,
                "overall_time_limit_seconds": 180
            }
        }))
        .expect("complete refine request");

        let heavy =
            external_cp_sat_agent_request(&body, "job-heavy-reference", 7, 6, true, Some(180_000))
                .expect("desktop heavy request");
        assert_eq!(
            heavy["settings"]["browser_wasm_full_reference_refine"],
            json!(true)
        );

        let limited = external_cp_sat_agent_request(
            &body,
            "job-limited-reference",
            7,
            5,
            true,
            Some(180_000),
        )
        .expect("limited request");
        assert_eq!(
            limited["settings"]["browser_wasm_full_reference_refine"],
            json!(false)
        );

        let mut focused_body: Value =
            serde_json::from_slice(&body).expect("focused complete refine request");
        focused_body["settings"]["optimization_focus"] = json!("sessions");
        let focused_body = serde_json::to_vec(&focused_body).expect("focused request body");
        let focused = external_cp_sat_agent_request(
            &focused_body,
            "job-focused-reference",
            7,
            6,
            true,
            Some(180_000),
        )
        .expect("focused request");
        assert_eq!(
            focused["settings"]["browser_wasm_full_reference_refine"],
            json!(false)
        );
    }

    #[test]
    fn external_cp_sat_fresh_automatic_uses_complete_first_without_overriding_focus_modes() {
        let fresh = serde_json::to_vec(&json!({
            "data": {"pccmTietMatrix": {"L1|Math": 2}},
            "settings": {
                "ui_unified_solve_kind": "fresh_complete_first",
                "overall_time_limit_seconds": 180
            }
        }))
        .expect("fresh request");
        let request = external_cp_sat_agent_request(
            &fresh,
            "job-fresh-complete-first",
            7,
            4,
            false,
            Some(180_000),
        )
        .expect("fresh external request");
        assert_eq!(
            request["settings"]["optimization_focus"],
            json!("automatic")
        );
        assert_eq!(
            request["settings"]["browser_wasm_external_complete_first"],
            json!(true)
        );

        let focused = serde_json::to_vec(&json!({
            "data": {"pccmTietMatrix": {"L1|Math": 2}},
            "settings": {
                "ui_unified_solve_kind": "fresh_complete_first",
                "optimization_focus": "sessions",
                "overall_time_limit_seconds": 180
            }
        }))
        .expect("focused request");
        let request = external_cp_sat_agent_request(
            &focused,
            "job-fresh-sessions",
            7,
            4,
            false,
            Some(180_000),
        )
        .expect("focused external request");
        assert_eq!(request["settings"]["optimization_focus"], json!("sessions"));
        assert!(request["settings"]
            .get("browser_wasm_external_complete_first")
            .is_none());
    }

    #[test]
    fn external_cp_sat_checkpoint_injects_only_a_safe_complete_incumbent() {
        let request_body = Arc::new(
            serde_json::to_vec(&json!({
                "data": {"pccmTietMatrix": {"6A|Math": 2}},
                "settings": {
                    "ui_unified_solve_kind": "fresh_complete_first",
                    "ui_browser_wasm_ready": true,
                    "ui_browser_cpsat_ready": true
                }
            }))
            .expect("canonical request body"),
        );
        let checkpoint = json!({
            "ok": true,
            "lessons": [
                {"classId": "6A", "subjectId": "Math", "period": 1},
                {"classId": "6A", "subjectId": "Math", "period": 2}
            ],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "hard_ok": true,
                "app_constraint_violation_count": 0
            }
        });

        let exact_body =
            external_cp_sat_request_body_with_checkpoint(&request_body, Some(&checkpoint));
        assert!(!Arc::ptr_eq(&exact_body, &request_body));
        let exact_request: Value =
            serde_json::from_slice(&exact_body).expect("checkpoint exact request");
        assert_eq!(exact_request["data"]["tkbSolverResult"], checkpoint);
        assert_eq!(
            exact_request["settings"]["ui_unified_solve_kind"],
            json!("refine_complete")
        );
        assert_eq!(
            exact_request["settings"]["ui_use_existing_complete_incumbent"],
            json!(true)
        );
        assert_eq!(
            exact_request["settings"]["ui_existing_incumbent_revalidated"],
            json!(true)
        );
        assert!(exact_request["settings"]
            .get("ui_browser_wasm_ready")
            .is_none());
        assert!(exact_request["settings"]
            .get("ui_browser_cpsat_ready")
            .is_none());
    }

    #[test]
    fn external_cp_sat_checkpoint_does_not_inject_a_partial_incumbent() {
        let request_body = Arc::new(
            serde_json::to_vec(&json!({
                "data": {"pccmTietMatrix": {"6A|Math": 2}},
                "settings": {"ui_unified_solve_kind": "fresh_complete_first"}
            }))
            .expect("canonical request body"),
        );
        let checkpoint = json!({
            "ok": false,
            "lessons": [{"classId": "6A", "subjectId": "Math", "period": 1}],
            "unassignedLessons": [{"classId": "6A", "subjectId": "Math"}],
            "metrics": {
                "scheduled_periods": 1,
                "expected_periods": 2,
                "unassigned_periods": 1,
                "hard_ok": false,
                "app_constraint_violation_count": 0
            }
        });

        let exact_body =
            external_cp_sat_request_body_with_checkpoint(&request_body, Some(&checkpoint));
        assert!(Arc::ptr_eq(&exact_body, &request_body));
        let exact_request: Value =
            serde_json::from_slice(&exact_body).expect("unchanged exact request");
        assert!(exact_request["data"].get("tkbSolverResult").is_none());
        assert_eq!(
            exact_request["settings"]["ui_unified_solve_kind"],
            json!("fresh_complete_first")
        );
    }

    #[test]
    fn external_cp_sat_checkpoint_rejects_malformed_or_metric_only_incumbents() {
        let request_body = Arc::new(
            serde_json::to_vec(&json!({
                "data": {"pccmTietMatrix": {"6A|Math": 2}},
                "settings": {"ui_unified_solve_kind": "fresh_complete_first"}
            }))
            .expect("canonical request body"),
        );
        let unsafe_metric_only = json!({
            "ok": true,
            "lessons": [{"classId": "6A", "subjectId": "Math", "period": 1}],
            "unassignedLessons": [],
            "metrics": {
                "scheduled_periods": 2,
                "expected_periods": 2,
                "unassigned_periods": 0,
                "hard_ok": true,
                "app_constraint_violation_count": 0
            }
        });
        assert!(reference_payload_complete(&unsafe_metric_only));
        assert!(!complete_existing_incumbent_is_safe(&unsafe_metric_only));

        for checkpoint in [&json!("malformed"), &unsafe_metric_only] {
            let exact_body =
                external_cp_sat_request_body_with_checkpoint(&request_body, Some(checkpoint));
            assert!(Arc::ptr_eq(&exact_body, &request_body));
            let exact_request: Value =
                serde_json::from_slice(&exact_body).expect("unchanged exact request");
            assert!(exact_request["data"].get("tkbSolverResult").is_none());
        }
    }

    #[test]
    fn external_cp_sat_completion_seed_request_is_exact_quick_and_bounded() {
        let request_body = Arc::new(
            serde_json::to_vec(&json!({
                "data": {
                    "pccmTietMatrix": {"6A|Math": 2},
                    "tkb": {
                        "6A": {"thu2": {"sang": [
                            {"mon": "Math", "fixed": true},
                            {"mon": "Math"}
                        ]}}
                    },
                    "tkbSolverResult": {
                        "ok": true,
                        "lessons": [{"classId": "6A", "subjectId": "Math"}],
                        "metrics": {"scheduled_periods": 1, "expected_periods": 2}
                    },
                    "tkbConstraints": {
                        "teacher": {"GV1": {"mustTeach": {"thu2|sang|0": true}}}
                    }
                },
                "settings": {
                    "ui_unified_solve_kind": "repair_constraints",
                    "optimization_focus": "automatic",
                    "optimize_existing_schedule": true,
                    "preserve_existing_tkb": true,
                    "ui_use_existing_complete_incumbent": true,
                    "ui_existing_incumbent_revalidated": true,
                    "overall_time_limit_seconds": 180
                }
            }))
            .expect("canonical rich request body"),
        );

        let seed_body = external_cp_sat_completion_seed_request_body(&request_body);
        assert!(!Arc::ptr_eq(&seed_body, &request_body));
        let seed_request: Value =
            serde_json::from_slice(&seed_body).expect("exact completion seed request");
        assert_eq!(
            seed_request["data"]["tkbConstraints"]["teacher"]["GV1"]["mustTeach"]["thu2|sang|0"],
            json!(true)
        );
        assert_eq!(
            seed_request["settings"]["optimization_focus"],
            json!("quick_complete")
        );
        assert_eq!(
            seed_request["settings"]["ui_unified_solve_kind"],
            json!("fresh_complete_first")
        );
        assert!(seed_request["data"].get("tkbSolverResult").is_none());
        assert_eq!(
            seed_request["data"]["tkb"]["6A"]["thu2"]["sang"][0]["fixed"],
            json!(true)
        );
        assert_eq!(
            seed_request["settings"]["optimize_existing_schedule"],
            json!(false)
        );
        assert_eq!(
            seed_request["settings"]["preserve_existing_tkb"],
            json!(false)
        );
        assert_eq!(
            seed_request["settings"]["preserve_fixed_lessons_only"],
            json!(true)
        );
        assert_eq!(
            seed_request["settings"]["auto_sort_strategy"],
            json!("fresh")
        );
        assert!(seed_request["settings"]
            .get("ui_use_existing_complete_incumbent")
            .is_none());
        assert_eq!(
            seed_request["settings"]["browser_wasm_automatic_completion_seed"],
            json!(true)
        );
        assert_eq!(
            seed_request["settings"]["browser_wasm_exact_completion_seed"],
            json!(true)
        );
        assert_eq!(
            seed_request["settings"]["ui_stop_after_first_complete_schedule"],
            json!(true)
        );
        assert_eq!(
            seed_request["settings"]["backend_deadline_ms"],
            json!(BROWSER_WASM_EXACT_COMPLETION_SEED_MS)
        );
        assert_eq!(
            seed_request["settings"]["overall_time_limit_seconds"],
            json!(BROWSER_WASM_EXACT_COMPLETION_SEED_MS / 1_000)
        );
    }

    #[test]
    fn external_cp_sat_stream_response_binds_step_digest_and_history() {
        assert!(prepare_external_cp_sat_stream_response(0, None, &[], &[])
            .expect("initial stream request")
            .is_none());

        let first_model_digest = "a".repeat(64);
        let first_response = json!({
            "modelDigest": first_model_digest.clone(),
            "responseBase64": "AQ=="
        });
        let (encoded, first_response_digest) = prepare_external_cp_sat_stream_response(
            1,
            Some(first_model_digest.as_str()),
            &[],
            std::slice::from_ref(&first_response),
        )
        .expect("first response")
        .expect("response frame");
        let frame: Value = serde_json::from_slice(&encoded).expect("response frame JSON");
        assert_eq!(frame["stepIndex"], json!(0));
        assert_eq!(frame["modelDigest"], json!(first_model_digest.clone()));

        let second_model_digest = "b".repeat(64);
        let second_response = json!({
            "modelDigest": second_model_digest.clone(),
            "responseBase64": "Ag=="
        });
        let history = vec![first_response_digest];
        let responses = vec![first_response.clone(), second_response.clone()];
        let (encoded, _) = prepare_external_cp_sat_stream_response(
            2,
            Some(second_model_digest.as_str()),
            &history,
            &responses,
        )
        .expect("second response")
        .expect("second response frame");
        let frame: Value = serde_json::from_slice(&encoded).expect("second response JSON");
        assert_eq!(frame["stepIndex"], json!(1));

        let wrong_step = prepare_external_cp_sat_stream_response(
            2,
            Some(second_model_digest.as_str()),
            &history,
            std::slice::from_ref(&second_response),
        );
        assert!(matches!(
            wrong_step,
            Err(ExternalCpSatStreamError::Conflict(_))
        ));

        let wrong_digest = json!({
            "modelDigest": "c".repeat(64),
            "responseBase64": "Ag=="
        });
        let wrong_digest = prepare_external_cp_sat_stream_response(
            2,
            Some(second_model_digest.as_str()),
            &history,
            &[first_response.clone(), wrong_digest],
        );
        assert!(matches!(
            wrong_digest,
            Err(ExternalCpSatStreamError::Conflict(_))
        ));

        let changed_history = json!({
            "modelDigest": first_model_digest,
            "responseBase64": "Aw=="
        });
        let changed_history = prepare_external_cp_sat_stream_response(
            2,
            Some(second_model_digest.as_str()),
            &history,
            &[changed_history, second_response],
        );
        assert!(matches!(
            changed_history,
            Err(ExternalCpSatStreamError::Conflict(_))
        ));
    }

    #[test]
    fn external_solver_model_kind_accepts_only_cp_sat_and_highs() {
        assert_eq!(
            external_solver_model_kind(&json!({"kind":"external_cp_sat_model"})),
            Some("external_cp_sat_model")
        );
        assert_eq!(
            external_solver_model_kind(&json!({"kind":"external_highs_model"})),
            Some("external_highs_model")
        );
        assert_eq!(
            external_solver_model_kind(&json!({"kind":"external_untrusted_model"})),
            None
        );
        assert_eq!(external_solver_model_kind(&json!({})), None);
    }

    #[test]
    fn external_model_plan_accepts_current_and_legacy_missing_versions_only() {
        assert!(external_model_plan_version_matches(&json!({})));
        assert!(external_model_plan_version_matches(&json!({
            "modelPlanVersion": EXTERNAL_MODEL_PLAN_VERSION
        })));
        assert!(!external_model_plan_version_matches(&json!({
            "modelPlanVersion": "tkb-model-plan-v0"
        })));
        assert!(!external_model_plan_version_matches(&json!({
            "modelPlanVersion": 1
        })));
    }

    #[test]
    fn external_cp_sat_response_wire_is_bounded_before_hashing() {
        let valid = json!({
            "modelDigest": "a".repeat(64),
            "responseBase64": "AQ=="
        });
        assert!(external_cp_sat_responses_are_bounded(std::slice::from_ref(
            &valid
        )));
        assert!(!external_cp_sat_responses_are_bounded(&[json!({
            "modelDigest": "a".repeat(63),
            "responseBase64": "AQ=="
        })]));
        assert!(!external_cp_sat_responses_are_bounded(&[json!({
            "modelDigest": "a".repeat(64),
            "responseBase64": "A".repeat(MAX_EXTERNAL_CP_SAT_RESPONSE_BASE64_CHARS + 1)
        })]));
        assert!(!external_cp_sat_responses_are_bounded(&[json!(
            "not-an-object"
        )]));
    }

    #[test]
    fn external_result_attestation_is_expiring_owner_bound_and_one_time() {
        let coordinator = ExternalCpSatStreamCoordinator::default();
        let now_ms = now_millis();
        coordinator.attest_result(
            "lease-attested",
            "worker-attested",
            "job-attested",
            "aabbcc",
            now_ms + 1_000,
        );
        assert!(!coordinator.consume_attested_result(
            "lease-attested",
            "other-worker",
            "job-attested",
            "aabbcc",
            now_ms,
        ));
        assert!(coordinator.consume_attested_result(
            "lease-attested",
            "worker-attested",
            "job-attested",
            "aabbcc",
            now_ms,
        ));
        assert!(!coordinator.consume_attested_result(
            "lease-attested",
            "worker-attested",
            "job-attested",
            "aabbcc",
            now_ms,
        ));

        coordinator.attest_result(
            "lease-expired-attestation",
            "worker-attested",
            "job-attested",
            "ddeeff",
            now_ms,
        );
        assert!(!coordinator.consume_attested_result(
            "lease-expired-attestation",
            "worker-attested",
            "job-attested",
            "ddeeff",
            now_ms,
        ));
    }

    #[test]
    fn exhausted_watchdog_does_not_start_external_stream() {
        let (app, _, _) = agent_test_app();
        let outcome = run_external_cp_sat_step(
            &app,
            br#"{"data":{},"settings":{}}"#,
            "expired-job",
            "expired-lease",
            "expired-worker",
            "quality",
            1,
            1,
            false,
            Some(0),
            json!([]),
        );
        assert!(matches!(outcome, Err(ExternalCpSatStreamError::TimedOut)));
    }

    #[test]
    fn stream_start_can_be_cancelled_by_job_without_registry_locking() {
        let coordinator = ExternalCpSatStreamCoordinator::new();
        let worker = coordinator.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            worker.get_or_start(
                "lease-cancel-start",
                "worker-cancel-start",
                "job-cancel-start",
                "quality",
                0,
                now_millis().saturating_add(60_000),
                now_millis().saturating_add(AGENT_WORK_LEASE_MS),
                |cancelled| {
                    started_tx.send(()).expect("start signal");
                    while !cancelled.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(ExternalCpSatStreamError::Cancelled)
                },
            )
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("stream start entered");
        let cancelled_at = Instant::now();
        coordinator.remove_job("job-cancel-start");
        assert!(cancelled_at.elapsed() < Duration::from_millis(200));
        assert!(matches!(
            join.join().expect("start thread"),
            Err(ExternalCpSatStreamError::Cancelled)
        ));
        assert!(coordinator
            .state
            .lock()
            .expect("coordinator state")
            .starts
            .is_empty());
    }

    #[test]
    fn stream_pending_start_expires_with_agent_lease_ttl() {
        let coordinator = ExternalCpSatStreamCoordinator::new();
        let worker = coordinator.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let now_ms = now_millis();
        let join = thread::spawn(move || {
            worker.get_or_start(
                "lease-expire-start",
                "worker-expire-start",
                "job-expire-start",
                "quality",
                0,
                now_ms.saturating_add(60_000),
                now_ms.saturating_add(10),
                |cancelled| {
                    started_tx.send(()).expect("start signal");
                    while !cancelled.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(ExternalCpSatStreamError::Cancelled)
                },
            )
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("stream start entered");
        coordinator.prune_expired(now_ms.saturating_add(11));
        assert!(matches!(
            join.join().expect("start thread"),
            Err(ExternalCpSatStreamError::Cancelled)
        ));
    }

    #[test]
    fn http_rejects_oversized_body_before_reading_it() {
        let (app, _, _) = agent_test_app();
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept request");
            handle_stream(stream, &app).expect("handle request");
        });
        let mut client = TcpStream::connect(address).expect("connect request");
        write!(
            client,
            "POST /api/agent-helper/lease HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
            MAX_HTTP_REQUEST_BODY_BYTES + 1
        )
        .expect("write request header");
        client
            .shutdown(std::net::Shutdown::Write)
            .expect("finish request");
        let mut response = String::new();
        client.read_to_string(&mut response).expect("read response");
        server.join().expect("server thread");
        assert!(response.starts_with("HTTP/1.1 413"));
        assert!(response.contains("request_too_large"));
    }
}
