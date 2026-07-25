use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::solver_pool::SolverOwner;

pub const AGENT_WORKER_HEARTBEAT_MS: u64 = 10_000;
pub const AGENT_WORKER_TTL_MS: u64 = 90_000;
pub const AGENT_WORK_LEASE_MS: u64 = 30_000;
pub const AGENT_IDLE_RETRY_MS: u64 = 2_000;
pub const AGENT_PAIR_TTL_MS: u64 = 5 * 60 * 1_000;
pub const AGENT_PAIR_POLL_MS: u64 = 1_500;
const AGENT_JOB_TTL_MS: u64 = 6 * 60 * 60 * 1_000;
const MAX_AGENT_WORKERS: usize = 128;
const MAX_AGENT_WORKERS_PER_OWNER: usize = 16;
const MAX_AGENT_PAIRINGS: usize = 256;
const MAX_TRUSTED_HANDOFF_REQUESTS: usize = 1_024;
const MAX_AGENT_PARALLEL_PER_WORKER: usize = 8;
const MAX_AGENT_SEEDS_PER_JOB: usize = 16;
const MAX_WORKER_ID_BYTES: usize = 80;
const MAX_WORKER_NAME_BYTES: usize = 120;
const MAX_JOB_SCOPE_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentHelperError {
    InvalidWorker,
    InvalidLeaseRequest,
    UnauthorizedWorker,
    WorkerCapacity,
    JobNotFound,
    NoWork,
    WorkerAtCapacity,
    LeaseNotFound,
    LeaseExpired,
    WorkAlreadyCompleted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentPairError {
    InvalidRequest,
    Capacity,
    NotFound,
    Expired,
    AlreadyApproved,
    ApprovalMismatch,
}

impl AgentPairError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "agent_pair_invalid",
            Self::Capacity => "agent_pair_capacity",
            Self::NotFound => "agent_pair_not_found",
            Self::Expired => "agent_pair_expired",
            Self::AlreadyApproved => "agent_pair_already_approved",
            Self::ApprovalMismatch => "agent_pair_approval_mismatch",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentPairStart {
    pub device_code: String,
    pub user_code: String,
    pub agent_id: String,
    pub agent_name: String,
    pub expires_at_ms: u64,
    pub poll_every_ms: u64,
}

#[derive(Clone, Debug)]
pub struct AgentPairApprovalTicket {
    pairing_key: String,
    approval_token: String,
    pub agent_id: String,
    pub agent_name: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentPairStatus {
    Pending {
        expires_at_ms: u64,
        poll_every_ms: u64,
    },
    Approved {
        agent_token: String,
        agent_token_expires_at: u64,
        expires_at_ms: u64,
    },
}

impl AgentHelperError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidWorker => "agent_worker_invalid",
            Self::InvalidLeaseRequest => "agent_lease_request_invalid",
            Self::UnauthorizedWorker => "agent_worker_unauthorized",
            Self::WorkerCapacity => "agent_worker_capacity",
            Self::JobNotFound => "agent_job_not_found",
            Self::NoWork => "agent_no_work",
            Self::WorkerAtCapacity => "agent_worker_at_capacity",
            Self::LeaseNotFound => "agent_lease_not_found",
            Self::LeaseExpired => "agent_lease_expired",
            Self::WorkAlreadyCompleted => "agent_work_already_completed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentWorkerRegistration {
    pub worker_token: String,
    pub worker_id: String,
    pub heartbeat_every_ms: u64,
    pub worker_expires_at_ms: u64,
    pub lease_ms: u64,
}

#[derive(Clone, Debug)]
pub struct AgentLeaseHeartbeat {
    pub work_id: String,
    pub lease_token: String,
}

#[derive(Clone, Debug, Default)]
pub struct AgentHeartbeatResult {
    pub renewed_work_ids: Vec<String>,
    pub lost_work_ids: Vec<String>,
    pub worker_expires_at_ms: u64,
}

#[derive(Clone)]
pub struct AgentWorkLease {
    pub work_id: String,
    pub job_id: String,
    pub job_owner: SolverOwner,
    pub lease_token: String,
    pub lease_expires_at_ms: u64,
    pub seed: u64,
    pub attempt: u32,
    pub request_body: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub struct AgentSubmissionTicket {
    pub work_id: String,
    pub job_id: String,
    pub job_owner: SolverOwner,
    pub worker_id: String,
    pub seed: u64,
    pub request_body: Arc<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct AgentCandidate {
    pub work_id: String,
    pub worker_id: String,
    pub seed: u64,
    pub payload: Value,
    pub quality: [i64; 4],
}

#[derive(Clone, Debug)]
pub enum AgentJobExecution {
    Queued,
    Leased { expires_at_ms: u64 },
    Completed { candidate: Option<AgentCandidate> },
}

#[derive(Clone, Debug)]
struct AgentWorker {
    owner: SolverOwner,
    trusted_global: bool,
    session_binding: String,
    worker_id: String,
    _name: String,
    job_scope: Option<String>,
    eligible: bool,
    max_parallel: usize,
    last_seen_ms: u64,
    expires_at_ms: u64,
}

#[derive(Clone, Debug)]
enum AgentTaskState {
    Queued,
    Leased {
        worker_token_hash: String,
        lease_token_hash: String,
        lease_token: String,
        lease_request_id: String,
        expires_at_ms: u64,
    },
    Completed,
}

#[derive(Clone, Debug)]
struct AgentTask {
    work_id: String,
    seed: u64,
    attempt: u32,
    state: AgentTaskState,
}

struct AgentJob {
    job_id: String,
    owner: SolverOwner,
    trusted_global_eligible: bool,
    created_at_ms: u64,
    request_body: Arc<Vec<u8>>,
    tasks: Vec<AgentTask>,
    best_candidate: Option<AgentCandidate>,
    checkpoint_candidate: Option<AgentCandidate>,
}

fn better_agent_candidate(
    left: Option<AgentCandidate>,
    right: Option<AgentCandidate>,
) -> Option<AgentCandidate> {
    match (left, right) {
        (Some(left), Some(right)) => Some(if left.quality <= right.quality { left } else { right }),
        (Some(candidate), None) | (None, Some(candidate)) => Some(candidate),
        (None, None) => None,
    }
}

#[derive(Clone, Debug)]
enum AgentPairState {
    Pending,
    Approving {
        owner: SolverOwner,
        approval_token_hash: String,
    },
    Approved {
        owner: SolverOwner,
        agent_token: String,
        agent_token_expires_at: u64,
    },
}

#[derive(Clone, Debug)]
struct AgentPairing {
    user_code: String,
    agent_id: String,
    agent_name: String,
    expires_at_ms: u64,
    state: AgentPairState,
}

#[derive(Clone, Debug)]
struct TrustedHandoffRequest {
    worker_token_hash: String,
    expires_at_ms: u64,
    job_id: Option<String>,
    capacity_reserved: bool,
}

#[derive(Default)]
struct AgentHelperState {
    workers: HashMap<String, AgentWorker>,
    jobs: HashMap<String, AgentJob>,
    pairings: HashMap<String, AgentPairing>,
    trusted_handoff_requests: HashMap<String, TrustedHandoffRequest>,
    trusted_handoff_capacity_releases: VecDeque<String>,
}

#[derive(Default)]
pub struct AgentHelperCoordinator {
    state: Mutex<AgentHelperState>,
}

impl AgentHelperCoordinator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Return the number of live Agent sessions owned by the current browser
    /// identity. Expired workers are pruned before counting so the web status
    /// indicator never treats a stale process as online.
    pub fn online_worker_count(&self, owner: &SolverOwner, now_ms: u64) -> usize {
        let (native, browser) = self.online_worker_counts(owner, now_ms);
        native + browser
    }

    /// Split durable native Agents from job-scoped Browser Agents. A browser
    /// tab must not mistake another tab's scoped worker for a native executor
    /// that can claim its new job.
    pub fn online_worker_counts(&self, owner: &SolverOwner, now_ms: u64) -> (usize, usize) {
        let Ok(mut state) = self.state.lock() else {
            return (0, 0);
        };
        prune_state(&mut state, now_ms);
        state
            .workers
            .values()
            .filter(|worker| {
                !worker.trusted_global
                    && worker.owner == *owner
                    && worker.eligible
                    && worker.expires_at_ms > now_ms
            })
            .fold((0, 0), |(native, browser), worker| {
                if worker.job_scope.is_some() {
                    (native, browser + 1)
                } else {
                    (native + 1, browser)
                }
            })
    }

    /// Count executors that may actually claim this canonical job. Durable
    /// native Agents are unscoped; a browser worker is visible only to the one
    /// job named during its hello handshake.
    pub fn online_worker_count_for_job(
        &self,
        owner: &SolverOwner,
        job_id: &str,
        now_ms: u64,
    ) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        prune_state(&mut state, now_ms);
        state
            .workers
            .values()
            .filter(|worker| {
                !worker.trusted_global
                    && worker.owner == *owner
                    && worker.eligible
                    && worker.expires_at_ms > now_ms
                    && worker
                        .job_scope
                        .as_deref()
                        .is_none_or(|scope| scope == job_id)
            })
            .count()
    }

    /// Return whether an exact live worker token may receive canonical work.
    /// Upgrade-only registrations remain authenticated for heartbeat/no-work
    /// polling, but are deliberately excluded from executor selection.
    pub fn worker_eligibility(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        now_ms: u64,
    ) -> Option<bool> {
        let mut state = self.state.lock().ok()?;
        prune_state(&mut state, now_ms);
        authenticated_worker(&state, owner, session_binding.trim(), worker_token, now_ms)
            .ok()
            .map(|(_, worker)| worker.eligible)
    }

    /// Authorize at most one global VPS-queue handoff for one authenticated
    /// logical lease poll. Transport retries reuse `lease_request_id`, so the
    /// hashed request marker prevents a dropped long-poll connection from
    /// draining multiple jobs before its first Agent task becomes visible.
    pub fn begin_trusted_handoff_request(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        lease_request_id: &str,
        now_ms: u64,
    ) -> Result<bool, AgentHelperError> {
        let lease_request_id = normalize_lease_request_id(lease_request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        if !worker.eligible || !worker.trusted_global {
            return Ok(false);
        }
        let marker = trusted_handoff_marker(&worker_token_hash, &lease_request_id);
        if state.trusted_handoff_requests.contains_key(&marker) {
            return Ok(false);
        }
        let active_leases = state
            .jobs
            .values()
            .flat_map(|job| job.tasks.iter())
            .filter(|task| {
                matches!(
                    &task.state,
                    AgentTaskState::Leased {
                        worker_token_hash: assigned,
                        ..
                    } if assigned == &worker_token_hash
                )
            })
            .count();
        let pending_handoffs = state
            .trusted_handoff_requests
            .values()
            .filter(|request| {
                request.worker_token_hash == worker_token_hash && request.capacity_reserved
            })
            .count();
        if active_leases.saturating_add(pending_handoffs) >= worker.max_parallel {
            return Err(AgentHelperError::WorkerAtCapacity);
        }
        if state.trusted_handoff_requests.len() >= MAX_TRUSTED_HANDOFF_REQUESTS {
            return Err(AgentHelperError::WorkerCapacity);
        }
        state.trusted_handoff_requests.insert(
            marker,
            TrustedHandoffRequest {
                worker_token_hash,
                expires_at_ms: now_ms.saturating_add(AGENT_WORKER_TTL_MS),
                job_id: None,
                capacity_reserved: true,
            },
        );
        Ok(true)
    }

    pub fn commit_trusted_handoff_request(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        lease_request_id: &str,
        job_id: &str,
        now_ms: u64,
    ) -> Result<bool, AgentHelperError> {
        let lease_request_id = normalize_lease_request_id(lease_request_id)?;
        let job_id = job_id.trim();
        if job_id.is_empty() || job_id.len() > 256 {
            return Err(AgentHelperError::JobNotFound);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        if !worker.eligible || !worker.trusted_global {
            return Ok(false);
        }
        let marker = trusted_handoff_marker(&worker_token_hash, &lease_request_id);
        let Some(existing_request) = state.trusted_handoff_requests.get(&marker) else {
            return Ok(false);
        };
        if let Some(existing_job_id) = existing_request.job_id.as_deref() {
            return Ok(existing_job_id == job_id);
        }
        let job_registered = state.jobs.contains_key(job_id);
        let job_already_transitioned = take_trusted_handoff_capacity_release(&mut state, job_id);
        let request = state
            .trusted_handoff_requests
            .get_mut(&marker)
            .expect("trusted handoff marker checked above");
        // A committed marker remains a replay tombstone until TTL. It keeps
        // reserving one worker slot until the Agent job is registered; if the
        // coordinator won that race already, only the tombstone remains.
        request.job_id = Some(job_id.to_string());
        request.capacity_reserved = !(job_registered || job_already_transitioned);
        clear_orphaned_trusted_handoff_capacity_releases(&mut state);
        Ok(true)
    }

    /// Release an uncommitted trusted-handoff marker when no VPS-queued job
    /// was available. A later tick of the same long-poll may then try again;
    /// committed markers remain until TTL so transport replays stay idempotent.
    pub fn release_trusted_handoff_request(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        lease_request_id: &str,
        now_ms: u64,
    ) -> Result<bool, AgentHelperError> {
        let lease_request_id = normalize_lease_request_id(lease_request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        if !worker.eligible || !worker.trusted_global {
            return Ok(false);
        }
        let marker = trusted_handoff_marker(&worker_token_hash, &lease_request_id);
        let releasable = state
            .trusted_handoff_requests
            .get(&marker)
            .is_some_and(|request| request.job_id.is_none());
        if releasable {
            state.trusted_handoff_requests.remove(&marker);
            clear_orphaned_trusted_handoff_capacity_releases(&mut state);
        }
        Ok(releasable)
    }

    /// Remove every live registration for one Agent identity. This is used
    /// when `/hello` proves that a previously accepted workstation has been
    /// downgraded to an incompatible binary. Any lease is requeued so the
    /// canonical coordinator can return it to the VPS.
    pub fn revoke_worker_identity(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_id: &str,
        now_ms: u64,
    ) -> bool {
        let Ok(worker_id) = normalize_worker_id(worker_id) else {
            return false;
        };
        let session_binding = session_binding.trim();
        if session_binding.is_empty() {
            return false;
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_state(&mut state, now_ms);
        let revoked = state
            .workers
            .iter()
            .filter(|(_, worker)| {
                worker.owner == *owner
                    && worker.session_binding == session_binding
                    && worker.worker_id == worker_id
            })
            .map(|(token_hash, _)| token_hash.clone())
            .collect::<HashSet<_>>();
        for token_hash in &revoked {
            state.workers.remove(token_hash);
        }
        state
            .trusted_handoff_requests
            .retain(|_, request| !revoked.contains(&request.worker_token_hash));
        clear_orphaned_trusted_handoff_capacity_releases(&mut state);
        release_worker_leases(&mut state.jobs, &revoked);
        !revoked.is_empty()
    }

    /// Revoke the exact session-bound token that attempted to claim work with
    /// an incompatible version. Ownership/session checks prevent one tenant
    /// from invalidating another tenant's worker.
    pub fn revoke_worker_token(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        now_ms: u64,
    ) -> bool {
        let token_hash = secret_hash(worker_token.trim());
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_state(&mut state, now_ms);
        let owned = state.workers.get(&token_hash).is_some_and(|worker| {
            worker.owner == *owner && worker.session_binding == session_binding.trim()
        });
        if !owned {
            return false;
        }
        state.workers.remove(&token_hash);
        state
            .trusted_handoff_requests
            .retain(|_, request| request.worker_token_hash != token_hash);
        clear_orphaned_trusted_handoff_capacity_releases(&mut state);
        let revoked = HashSet::from([token_hash]);
        release_worker_leases(&mut state.jobs, &revoked);
        true
    }

    pub fn start_pairing(
        &self,
        agent_id: &str,
        agent_name: &str,
        now_ms: u64,
    ) -> Result<AgentPairStart, AgentPairError> {
        let agent_id = normalize_worker_id(agent_id).map_err(|_| AgentPairError::InvalidRequest)?;
        let agent_name = normalize_worker_name(agent_name, &agent_id);
        let mut state = self.state.lock().map_err(|_| AgentPairError::Capacity)?;
        prune_state(&mut state, now_ms);
        if state.pairings.len() >= MAX_AGENT_PAIRINGS {
            return Err(AgentPairError::Capacity);
        }

        for _ in 0..32 {
            let device_code = format!("tkbp_{}", make_secret());
            let pairing_key = secret_hash(&device_code);
            let user_code = make_user_code();
            if state.pairings.contains_key(&pairing_key)
                || state
                    .pairings
                    .values()
                    .any(|pairing| pairing.user_code == user_code)
            {
                continue;
            }
            let expires_at_ms = now_ms.saturating_add(AGENT_PAIR_TTL_MS);
            state.pairings.insert(
                pairing_key,
                AgentPairing {
                    user_code: user_code.clone(),
                    agent_id: agent_id.clone(),
                    agent_name: agent_name.clone(),
                    expires_at_ms,
                    state: AgentPairState::Pending,
                },
            );
            return Ok(AgentPairStart {
                device_code,
                user_code,
                agent_id,
                agent_name,
                expires_at_ms,
                poll_every_ms: AGENT_PAIR_POLL_MS,
            });
        }
        Err(AgentPairError::Capacity)
    }

    pub fn begin_pair_approval(
        &self,
        user_code: &str,
        owner: &SolverOwner,
        now_ms: u64,
    ) -> Result<AgentPairApprovalTicket, AgentPairError> {
        let user_code = normalize_user_code(user_code)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentPairError::ApprovalMismatch)?;
        let pairing_key = state
            .pairings
            .iter()
            .find(|(_, pairing)| pairing.user_code == user_code)
            .map(|(key, _)| key.clone())
            .ok_or(AgentPairError::NotFound)?;
        let expired = state
            .pairings
            .get(&pairing_key)
            .is_some_and(|pairing| pairing.expires_at_ms <= now_ms);
        if expired {
            state.pairings.remove(&pairing_key);
            return Err(AgentPairError::Expired);
        }
        let approval_token = make_secret();
        let approval_token_hash = secret_hash(&approval_token);
        let pairing = state
            .pairings
            .get_mut(&pairing_key)
            .ok_or(AgentPairError::NotFound)?;
        match &pairing.state {
            AgentPairState::Pending => {}
            AgentPairState::Approving {
                owner: existing_owner,
                ..
            }
            | AgentPairState::Approved {
                owner: existing_owner,
                ..
            } => {
                // The comparison deliberately stays internal: callers learn
                // only that the one-time code was used, never who owns it.
                let _same_owner = existing_owner == owner;
                return Err(AgentPairError::AlreadyApproved);
            }
        }
        pairing.state = AgentPairState::Approving {
            owner: owner.clone(),
            approval_token_hash,
        };
        Ok(AgentPairApprovalTicket {
            pairing_key,
            approval_token,
            agent_id: pairing.agent_id.clone(),
            agent_name: pairing.agent_name.clone(),
            expires_at_ms: pairing.expires_at_ms,
        })
    }

    pub fn complete_pair_approval(
        &self,
        ticket: &AgentPairApprovalTicket,
        owner: &SolverOwner,
        agent_token: &str,
        agent_token_expires_at: u64,
        now_ms: u64,
    ) -> Result<(), AgentPairError> {
        let agent_token = agent_token.trim();
        if !agent_token.starts_with("tkba_")
            || agent_token.len() > 512
            || agent_token_expires_at == 0
        {
            return Err(AgentPairError::InvalidRequest);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentPairError::ApprovalMismatch)?;
        let expired = state
            .pairings
            .get(&ticket.pairing_key)
            .is_some_and(|pairing| pairing.expires_at_ms <= now_ms);
        if expired {
            state.pairings.remove(&ticket.pairing_key);
            return Err(AgentPairError::Expired);
        }
        let pairing = state
            .pairings
            .get_mut(&ticket.pairing_key)
            .ok_or(AgentPairError::NotFound)?;
        let approval_token_hash = secret_hash(&ticket.approval_token);
        let matches_approval = matches!(
            &pairing.state,
            AgentPairState::Approving {
                owner: approving_owner,
                approval_token_hash: expected,
            } if approving_owner == owner && expected == &approval_token_hash
        );
        if !matches_approval {
            return Err(AgentPairError::ApprovalMismatch);
        }
        pairing.state = AgentPairState::Approved {
            owner: owner.clone(),
            agent_token: agent_token.to_string(),
            agent_token_expires_at,
        };
        Ok(())
    }

    pub fn abort_pair_approval(
        &self,
        ticket: &AgentPairApprovalTicket,
        owner: &SolverOwner,
        now_ms: u64,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let Some(pairing) = state.pairings.get_mut(&ticket.pairing_key) else {
            return;
        };
        if pairing.expires_at_ms <= now_ms {
            state.pairings.remove(&ticket.pairing_key);
            return;
        }
        let approval_token_hash = secret_hash(&ticket.approval_token);
        if matches!(
            &pairing.state,
            AgentPairState::Approving {
                owner: approving_owner,
                approval_token_hash: expected,
            } if approving_owner == owner && expected == &approval_token_hash
        ) {
            pairing.state = AgentPairState::Pending;
        }
    }

    pub fn pairing_status(
        &self,
        device_code: &str,
        now_ms: u64,
    ) -> Result<AgentPairStatus, AgentPairError> {
        let device_code = normalize_device_code(device_code)?;
        let pairing_key = secret_hash(device_code);
        let mut state = self.state.lock().map_err(|_| AgentPairError::NotFound)?;
        let expired = state
            .pairings
            .get(&pairing_key)
            .is_some_and(|pairing| pairing.expires_at_ms <= now_ms);
        if expired {
            state.pairings.remove(&pairing_key);
            return Err(AgentPairError::Expired);
        }
        let pairing = state
            .pairings
            .get(&pairing_key)
            .ok_or(AgentPairError::NotFound)?;
        match &pairing.state {
            AgentPairState::Pending | AgentPairState::Approving { .. } => {
                Ok(AgentPairStatus::Pending {
                    expires_at_ms: pairing.expires_at_ms,
                    poll_every_ms: AGENT_PAIR_POLL_MS,
                })
            }
            AgentPairState::Approved {
                owner: _,
                agent_token,
                agent_token_expires_at,
            } => Ok(AgentPairStatus::Approved {
                agent_token: agent_token.clone(),
                agent_token_expires_at: *agent_token_expires_at,
                expires_at_ms: pairing.expires_at_ms,
            }),
        }
    }

    pub fn register_job(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        request_body: Arc<Vec<u8>>,
        seed_count: usize,
        now_ms: u64,
    ) -> bool {
        self.register_job_with_trusted_eligibility(
            job_id,
            owner,
            request_body,
            seed_count,
            false,
            now_ms,
        )
    }

    pub fn register_job_with_trusted_eligibility(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        request_body: Arc<Vec<u8>>,
        seed_count: usize,
        trusted_global_eligible: bool,
        now_ms: u64,
    ) -> bool {
        let job_id = job_id.trim();
        if job_id.is_empty() || request_body.is_empty() {
            return false;
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_state(&mut state, now_ms);
        if let Some(existing) = state.jobs.get(job_id) {
            let owned = existing.owner == *owner;
            if owned {
                release_trusted_handoff_capacity_for_job(&mut state, job_id);
            }
            return owned;
        }
        let seed_count = seed_count.clamp(1, MAX_AGENT_SEEDS_PER_JOB);
        let tasks = (0..seed_count)
            .map(|index| AgentTask {
                work_id: format!("{job_id}:seed:{:02}", index + 1),
                seed: seed_for(job_id, index),
                attempt: 0,
                state: AgentTaskState::Queued,
            })
            .collect();
        state.jobs.insert(
            job_id.to_string(),
            AgentJob {
                job_id: job_id.to_string(),
                owner: owner.clone(),
                trusted_global_eligible,
                created_at_ms: now_ms,
                request_body,
                tasks,
                best_candidate: None,
                checkpoint_candidate: None,
            },
        );
        release_trusted_handoff_capacity_for_job(&mut state, job_id);
        true
    }

    pub fn finish_job(&self, job_id: &str, owner: &SolverOwner) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        let owned = state
            .jobs
            .get(job_id)
            .map(|job| job.owner == *owner)
            .unwrap_or(false);
        if owned {
            state.jobs.remove(job_id);
        }
        // Cleanup can win the small race after the VPS queue handoff commits
        // but before the AgentJob is registered. Free that reservation while
        // retaining its replay tombstone.
        release_trusted_handoff_capacity_for_job(&mut state, job_id);
        owned
    }

    /// Atomically close one owned Agent job and return a candidate that was
    /// already accepted before the close. The server watchdog uses this as its
    /// terminal fence so a submission cannot land between a stale no-result
    /// snapshot and committing a timeout response.
    pub fn take_candidate_and_finish_job(
        &self,
        job_id: &str,
        owner: &SolverOwner,
    ) -> Option<AgentCandidate> {
        let mut state = self.state.lock().ok()?;
        let owned = state
            .jobs
            .get(job_id)
            .is_some_and(|job| job.owner == *owner);
        if !owned {
            release_trusted_handoff_capacity_for_job(&mut state, job_id);
            return None;
        }
        let candidate = state.jobs.remove(job_id).and_then(|job| {
            better_agent_candidate(job.best_candidate, job.checkpoint_candidate)
        });
        release_trusted_handoff_capacity_for_job(&mut state, job_id);
        candidate
    }

    /// Return one coherent snapshot of the canonical Agent task. Calling this
    /// method also prunes expired workers/leases, which lets the VPS watchdog
    /// resume work even when a powered-off Agent cannot send a final request.
    pub fn job_execution(
        &self,
        job_id: &str,
        owner: &SolverOwner,
        now_ms: u64,
    ) -> Option<AgentJobExecution> {
        let mut state = self.state.lock().ok()?;
        prune_state(&mut state, now_ms);
        let job = state.jobs.get(job_id).filter(|job| job.owner == *owner)?;
        if let Some(candidate) = job.best_candidate.clone() {
            return Some(AgentJobExecution::Completed {
                candidate: Some(candidate),
            });
        }
        if let Some(expires_at_ms) = job.tasks.iter().find_map(|task| match &task.state {
            AgentTaskState::Leased { expires_at_ms, .. } => Some(*expires_at_ms),
            _ => None,
        }) {
            return Some(AgentJobExecution::Leased { expires_at_ms });
        }
        if let Some(candidate) = job.checkpoint_candidate.clone() {
            return Some(AgentJobExecution::Completed {
                candidate: Some(candidate),
            });
        }
        if job
            .tasks
            .iter()
            .all(|task| matches!(&task.state, AgentTaskState::Completed))
        {
            Some(AgentJobExecution::Completed { candidate: None })
        } else {
            Some(AgentJobExecution::Queued)
        }
    }

    /// Atomically remove an Agent job only when no lease is still active. This
    /// closes the expiry/reclaim race: a worker that manages to reclaim a task
    /// just as the watchdog notices an old lease cannot be killed underneath a
    /// running solver while the VPS starts a replacement.
    pub fn take_over_for_vps(&self, job_id: &str, owner: &SolverOwner, now_ms: u64) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        prune_state(&mut state, now_ms);
        let Some(job) = state.jobs.get(job_id).filter(|job| job.owner == *owner) else {
            release_trusted_handoff_capacity_for_job(&mut state, job_id);
            return true;
        };
        // A candidate may complete between the watchdog's snapshot and this
        // atomic takeover check. Preserve that candidate and let the
        // coordinator re-enter the Agent path to commit it instead of
        // discarding it and needlessly restarting on the VPS.
        if job.best_candidate.is_some() || job.checkpoint_candidate.is_some() {
            return false;
        }
        if job
            .tasks
            .iter()
            .any(|task| matches!(&task.state, AgentTaskState::Leased { .. }))
        {
            return false;
        }
        state.jobs.remove(job_id);
        release_trusted_handoff_capacity_for_job(&mut state, job_id);
        true
    }

    pub fn register_worker(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_id: &str,
        name: &str,
        max_parallel: usize,
        now_ms: u64,
    ) -> Result<AgentWorkerRegistration, AgentHelperError> {
        self.register_worker_with_eligibility(
            owner,
            session_binding,
            worker_id,
            name,
            max_parallel,
            true,
            false,
            None,
            now_ms,
        )
    }

    /// Register a foreground browser worker for one exact canonical job. This
    /// scope is enforced by every lease, heartbeat and submission lookup, so a
    /// tab cannot consume another tab's older job for the same owner.
    pub fn register_scoped_worker(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_id: &str,
        name: &str,
        max_parallel: usize,
        job_id: &str,
        now_ms: u64,
    ) -> Result<AgentWorkerRegistration, AgentHelperError> {
        self.register_worker_with_eligibility(
            owner,
            session_binding,
            worker_id,
            name,
            max_parallel,
            true,
            false,
            Some(job_id),
            now_ms,
        )
    }

    /// Register an operator-managed worker that may draw from the global
    /// canonical queue. This entry point is never used by browser pairing;
    /// the HTTP layer exposes it only after a separate trusted-worker bearer
    /// has been verified against server configuration.
    pub fn register_trusted_worker(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_id: &str,
        name: &str,
        max_parallel: usize,
        now_ms: u64,
    ) -> Result<AgentWorkerRegistration, AgentHelperError> {
        self.register_worker_with_eligibility(
            owner,
            session_binding,
            worker_id,
            name,
            max_parallel,
            true,
            true,
            None,
            now_ms,
        )
    }

    /// Register an authenticated Agent only long enough for old packaged
    /// clients to remain idle and offer their signed self-update. These
    /// workers never count as online executors and cannot claim work.
    pub fn register_upgrade_worker(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_id: &str,
        name: &str,
        max_parallel: usize,
        now_ms: u64,
    ) -> Result<AgentWorkerRegistration, AgentHelperError> {
        self.register_worker_with_eligibility(
            owner,
            session_binding,
            worker_id,
            name,
            max_parallel,
            false,
            false,
            None,
            now_ms,
        )
    }

    fn register_worker_with_eligibility(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_id: &str,
        name: &str,
        max_parallel: usize,
        eligible: bool,
        trusted_global: bool,
        job_scope: Option<&str>,
        now_ms: u64,
    ) -> Result<AgentWorkerRegistration, AgentHelperError> {
        let worker_id = normalize_worker_id(worker_id)?;
        let session_binding = session_binding.trim();
        if session_binding.is_empty() {
            return Err(AgentHelperError::UnauthorizedWorker);
        }
        let name = normalize_worker_name(name, &worker_id);
        let job_scope = match job_scope {
            Some(value) => {
                let value = value.trim();
                if value.is_empty() || value.len() > MAX_JOB_SCOPE_BYTES {
                    return Err(AgentHelperError::InvalidWorker);
                }
                Some(value.to_string())
            }
            None => None,
        };
        let max_parallel = max_parallel.clamp(1, MAX_AGENT_PARALLEL_PER_WORKER);
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);

        let replaced = state
            .workers
            .iter()
            .filter(|(_, worker)| {
                worker.owner == *owner
                    && worker.session_binding == session_binding
                    && worker.worker_id == worker_id
            })
            .map(|(token_hash, _)| token_hash.clone())
            .collect::<HashSet<_>>();
        for token_hash in &replaced {
            state.workers.remove(token_hash);
        }
        release_worker_leases(&mut state.jobs, &replaced);

        if state.workers.len() >= MAX_AGENT_WORKERS
            || state
                .workers
                .values()
                .filter(|worker| worker.owner == *owner)
                .count()
                >= MAX_AGENT_WORKERS_PER_OWNER
        {
            return Err(AgentHelperError::WorkerCapacity);
        }

        let worker_token = make_secret();
        let worker_token_hash = secret_hash(&worker_token);
        let expires_at_ms = now_ms.saturating_add(AGENT_WORKER_TTL_MS);
        state.workers.insert(
            worker_token_hash,
            AgentWorker {
                owner: owner.clone(),
                trusted_global,
                session_binding: session_binding.to_string(),
                worker_id: worker_id.clone(),
                _name: name,
                job_scope,
                eligible,
                max_parallel,
                last_seen_ms: now_ms,
                expires_at_ms,
            },
        );
        Ok(AgentWorkerRegistration {
            worker_token,
            worker_id,
            heartbeat_every_ms: AGENT_WORKER_HEARTBEAT_MS,
            worker_expires_at_ms: expires_at_ms,
            lease_ms: AGENT_WORK_LEASE_MS,
        })
    }

    pub fn heartbeat(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        leases: &[AgentLeaseHeartbeat],
        now_ms: u64,
    ) -> Result<AgentHeartbeatResult, AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let expires_at_ms = now_ms.saturating_add(AGENT_WORKER_TTL_MS);
        if let Some(stored) = state.workers.get_mut(&worker_token_hash) {
            stored.last_seen_ms = now_ms;
            stored.expires_at_ms = expires_at_ms;
        }
        let mut result = AgentHeartbeatResult {
            worker_expires_at_ms: expires_at_ms,
            ..AgentHeartbeatResult::default()
        };
        for lease in leases.iter().take(MAX_AGENT_PARALLEL_PER_WORKER) {
            let lease_hash = secret_hash(lease.lease_token.trim());
            let mut renewed = false;
            for job in state
                .jobs
                .values_mut()
                .filter(|job| worker_can_access_job(&worker, job))
            {
                let Some(task) = job
                    .tasks
                    .iter_mut()
                    .find(|task| task.work_id == lease.work_id)
                else {
                    continue;
                };
                if let AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash,
                    expires_at_ms,
                    ..
                } = &mut task.state
                {
                    if assigned_worker == &worker_token_hash
                        && lease_token_hash == &lease_hash
                        && *expires_at_ms > now_ms
                    {
                        *expires_at_ms = now_ms.saturating_add(AGENT_WORK_LEASE_MS);
                        renewed = true;
                    }
                }
                break;
            }
            if renewed {
                result.renewed_work_ids.push(lease.work_id.clone());
            } else {
                result.lost_work_ids.push(lease.work_id.clone());
            }
        }
        Ok(result)
    }

    #[cfg(test)]
    pub fn claim_work(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        now_ms: u64,
    ) -> Result<AgentWorkLease, AgentHelperError> {
        let request_id = format!("internal-{}", make_secret());
        self.claim_work_with_request_id(owner, session_binding, worker_token, &request_id, now_ms)
    }

    pub fn claim_work_with_request_id(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        lease_request_id: &str,
        now_ms: u64,
    ) -> Result<AgentWorkLease, AgentHelperError> {
        let lease_request_id = normalize_lease_request_id(lease_request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        if !worker.eligible {
            return Err(AgentHelperError::NoWork);
        }

        // Transport retries carry the same request ID. Resolve that replay
        // before enforcing capacity so the caller gets the exact active lease
        // rather than a second job or a worker-at-capacity response.
        let replay = state
            .jobs
            .iter()
            .filter(|(_, job)| worker_can_access_job(&worker, job))
            .find_map(|(job_id, job)| {
                job.tasks.iter().find_map(|task| match &task.state {
                    AgentTaskState::Leased {
                        worker_token_hash: assigned_worker,
                        lease_token,
                        lease_request_id: assigned_request,
                        expires_at_ms,
                        ..
                    } if assigned_worker == &worker_token_hash
                        && assigned_request == &lease_request_id
                        && *expires_at_ms > now_ms =>
                    {
                        Some(AgentWorkLease {
                            work_id: task.work_id.clone(),
                            job_id: job_id.clone(),
                            job_owner: job.owner.clone(),
                            lease_token: lease_token.clone(),
                            lease_expires_at_ms: *expires_at_ms,
                            seed: task.seed,
                            attempt: task.attempt,
                            request_body: Arc::clone(&job.request_body),
                        })
                    }
                    _ => None,
                })
            });
        if let Some(lease) = replay {
            return Ok(lease);
        }

        // A committed trusted request may claim only the job reserved for that
        // logical poll. Once that job is gone, a delayed replay must return no
        // work instead of leasing another tenant's already-exposed Agent task.
        // While the handoff is still uncommitted, overlapping retries wait for
        // the first request to attach its canonical job ID.
        let trusted_job_scope = if worker.trusted_global {
            let marker = trusted_handoff_marker(&worker_token_hash, &lease_request_id);
            match state.trusted_handoff_requests.get(&marker) {
                Some(request) => match request.job_id.as_ref() {
                    Some(job_id) => Some(job_id.clone()),
                    None => return Err(AgentHelperError::NoWork),
                },
                None => None,
            }
        } else {
            None
        };

        let active_leases = state
            .jobs
            .values()
            .flat_map(|job| job.tasks.iter())
            .filter(|task| {
                matches!(
                    &task.state,
                    AgentTaskState::Leased { worker_token_hash: assigned, .. }
                        if assigned == &worker_token_hash
                )
            })
            .count();
        if active_leases >= worker.max_parallel {
            return Err(AgentHelperError::WorkerAtCapacity);
        }

        let mut available = state
            .jobs
            .iter()
            .filter(|(job_id, job)| {
                worker_can_access_job(&worker, job)
                    && trusted_job_scope
                        .as_deref()
                        .is_none_or(|assigned_job_id| assigned_job_id == job_id.as_str())
            })
            .flat_map(|(job_id, job)| {
                job.tasks
                    .iter()
                    .enumerate()
                    .filter(|(_, task)| matches!(task.state, AgentTaskState::Queued))
                    .map(move |(task_index, task)| {
                        (
                            job.created_at_ms,
                            job_id.clone(),
                            task_index,
                            task.work_id.clone(),
                        )
                    })
            })
            .collect::<Vec<_>>();
        available.sort_unstable();
        let Some((_, job_id, task_index, _)) = available.into_iter().next() else {
            return Err(AgentHelperError::NoWork);
        };

        let lease_token = make_secret();
        let lease_token_hash = secret_hash(&lease_token);
        let lease_expires_at_ms = now_ms.saturating_add(AGENT_WORK_LEASE_MS);
        let lease = {
            let job = state
                .jobs
                .get_mut(&job_id)
                .ok_or(AgentHelperError::JobNotFound)?;
            let task = job
                .tasks
                .get_mut(task_index)
                .ok_or(AgentHelperError::JobNotFound)?;
            task.attempt = task.attempt.saturating_add(1);
            task.state = AgentTaskState::Leased {
                worker_token_hash,
                lease_token_hash,
                lease_token: lease_token.clone(),
                lease_request_id,
                expires_at_ms: lease_expires_at_ms,
            };
            AgentWorkLease {
                work_id: task.work_id.clone(),
                job_id: job_id.clone(),
                job_owner: job.owner.clone(),
                lease_token,
                lease_expires_at_ms,
                seed: task.seed,
                attempt: task.attempt,
                request_body: Arc::clone(&job.request_body),
            }
        };
        release_trusted_handoff_capacity_for_job(&mut state, &job_id);
        Ok(lease)
    }

    pub fn work_id_for_lease(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        lease_token: &str,
        now_ms: u64,
    ) -> Result<String, AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let lease_token_hash = secret_hash(lease_token.trim());
        state
            .jobs
            .values()
            .filter(|job| worker_can_access_job(&worker, job))
            .flat_map(|job| job.tasks.iter())
            .find_map(|task| match &task.state {
                AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash: assigned_lease,
                    expires_at_ms,
                    ..
                } if assigned_worker == &worker_token_hash
                    && assigned_lease == &lease_token_hash
                    && *expires_at_ms > now_ms =>
                {
                    Some(task.work_id.clone())
                }
                _ => None,
            })
            .ok_or(AgentHelperError::LeaseNotFound)
    }

    pub fn begin_submission(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        work_id: &str,
        lease_token: &str,
        now_ms: u64,
    ) -> Result<AgentSubmissionTicket, AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let lease_token_hash = secret_hash(lease_token.trim());
        for (job_id, job) in state
            .jobs
            .iter()
            .filter(|(_, job)| worker_can_access_job(&worker, job))
        {
            let Some(task) = job.tasks.iter().find(|task| task.work_id == work_id) else {
                continue;
            };
            return match &task.state {
                AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash: assigned_lease,
                    expires_at_ms,
                    ..
                } if assigned_worker == &worker_token_hash
                    && assigned_lease == &lease_token_hash
                    && *expires_at_ms > now_ms =>
                {
                    Ok(AgentSubmissionTicket {
                        work_id: task.work_id.clone(),
                        job_id: job_id.clone(),
                        job_owner: job.owner.clone(),
                        worker_id: worker.worker_id.clone(),
                        seed: task.seed,
                        request_body: Arc::clone(&job.request_body),
                    })
                }
                AgentTaskState::Completed => Err(AgentHelperError::WorkAlreadyCompleted),
                AgentTaskState::Leased { expires_at_ms, .. } if *expires_at_ms <= now_ms => {
                    Err(AgentHelperError::LeaseExpired)
                }
                _ => Err(AgentHelperError::LeaseNotFound),
            };
        }
        Err(AgentHelperError::LeaseNotFound)
    }

    pub fn accept_submission(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        work_id: &str,
        lease_token: &str,
        payload: Value,
        quality: [i64; 4],
        now_ms: u64,
    ) -> Result<bool, AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let lease_token_hash = secret_hash(lease_token.trim());
        for job in state
            .jobs
            .values_mut()
            .filter(|job| worker_can_access_job(&worker, job))
        {
            let Some(task_index) = job.tasks.iter().position(|task| task.work_id == work_id) else {
                continue;
            };
            let task = &mut job.tasks[task_index];
            match &task.state {
                AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash: assigned_lease,
                    expires_at_ms,
                    ..
                } if assigned_worker == &worker_token_hash
                    && assigned_lease == &lease_token_hash
                    && *expires_at_ms > now_ms => {}
                AgentTaskState::Completed => return Err(AgentHelperError::WorkAlreadyCompleted),
                AgentTaskState::Leased { expires_at_ms, .. } if *expires_at_ms <= now_ms => {
                    return Err(AgentHelperError::LeaseExpired)
                }
                _ => return Err(AgentHelperError::LeaseNotFound),
            }
            let candidate = AgentCandidate {
                work_id: task.work_id.clone(),
                worker_id: worker.worker_id.clone(),
                seed: task.seed,
                payload,
                quality,
            };
            let current_best = better_agent_candidate(
                job.best_candidate.clone(),
                job.checkpoint_candidate.clone(),
            );
            let became_best = current_best
                .as_ref()
                .map(|current| candidate.quality < current.quality)
                .unwrap_or(true);
            job.best_candidate = Some(if became_best {
                candidate
            } else {
                current_best.expect("an unchanged Agent best candidate exists")
            });
            job.checkpoint_candidate = None;
            task.state = AgentTaskState::Completed;
            return Ok(became_best);
        }
        Err(AgentHelperError::LeaseNotFound)
    }

    /// Keep a validated strict-best candidate while its worker continues
    /// searching. Checkpoints do not complete the lease, but Stop/watchdog
    /// finalization can atomically take the best accepted checkpoint.
    pub fn accept_checkpoint(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        work_id: &str,
        lease_token: &str,
        payload: Value,
        quality: [i64; 4],
        now_ms: u64,
    ) -> Result<bool, AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let lease_token_hash = secret_hash(lease_token.trim());
        for job in state
            .jobs
            .values_mut()
            .filter(|job| worker_can_access_job(&worker, job))
        {
            let Some(task_index) = job.tasks.iter().position(|task| task.work_id == work_id) else {
                continue;
            };
            let task = &job.tasks[task_index];
            match &task.state {
                AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash: assigned_lease,
                    expires_at_ms,
                    ..
                } if assigned_worker == &worker_token_hash
                    && assigned_lease == &lease_token_hash
                    && *expires_at_ms > now_ms => {}
                AgentTaskState::Completed => return Err(AgentHelperError::WorkAlreadyCompleted),
                AgentTaskState::Leased { expires_at_ms, .. } if *expires_at_ms <= now_ms => {
                    return Err(AgentHelperError::LeaseExpired)
                }
                _ => return Err(AgentHelperError::LeaseNotFound),
            }
            let candidate = AgentCandidate {
                work_id: task.work_id.clone(),
                worker_id: worker.worker_id.clone(),
                seed: task.seed,
                payload,
                quality,
            };
            let current_best = better_agent_candidate(
                job.best_candidate.clone(),
                job.checkpoint_candidate.clone(),
            );
            let became_best = current_best
                .as_ref()
                .map(|current| candidate.quality < current.quality)
                .unwrap_or(true);
            if became_best {
                job.checkpoint_candidate = Some(candidate);
            }
            return Ok(became_best);
        }
        Err(AgentHelperError::LeaseNotFound)
    }

    pub fn accept_structured_outcome(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        work_id: &str,
        lease_token: &str,
        now_ms: u64,
    ) -> Result<(), AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let lease_token_hash = secret_hash(lease_token.trim());
        for job in state
            .jobs
            .values_mut()
            .filter(|job| worker_can_access_job(&worker, job))
        {
            let Some(task) = job.tasks.iter_mut().find(|task| task.work_id == work_id) else {
                continue;
            };
            match &task.state {
                AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash: assigned_lease,
                    expires_at_ms,
                    ..
                } if assigned_worker == &worker_token_hash
                    && assigned_lease == &lease_token_hash
                    && *expires_at_ms > now_ms =>
                {
                    task.state = AgentTaskState::Completed;
                    return Ok(());
                }
                AgentTaskState::Completed => return Err(AgentHelperError::WorkAlreadyCompleted),
                AgentTaskState::Leased { expires_at_ms, .. } if *expires_at_ms <= now_ms => {
                    return Err(AgentHelperError::LeaseExpired)
                }
                _ => return Err(AgentHelperError::LeaseNotFound),
            }
        }
        Err(AgentHelperError::LeaseNotFound)
    }

    pub fn reject_submission(
        &self,
        owner: &SolverOwner,
        session_binding: &str,
        worker_token: &str,
        work_id: &str,
        lease_token: &str,
        now_ms: u64,
    ) -> Result<(), AgentHelperError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AgentHelperError::UnauthorizedWorker)?;
        prune_state(&mut state, now_ms);
        let (worker_token_hash, worker) =
            authenticated_worker(&state, owner, session_binding, worker_token, now_ms)?;
        let lease_token_hash = secret_hash(lease_token.trim());
        for job in state
            .jobs
            .values_mut()
            .filter(|job| worker_can_access_job(&worker, job))
        {
            let Some(task) = job.tasks.iter_mut().find(|task| task.work_id == work_id) else {
                continue;
            };
            if matches!(
                &task.state,
                AgentTaskState::Leased {
                    worker_token_hash: assigned_worker,
                    lease_token_hash: assigned_lease,
                    expires_at_ms,
                    ..
                } if assigned_worker == &worker_token_hash
                    && assigned_lease == &lease_token_hash
                    && *expires_at_ms > now_ms
            ) {
                task.state = AgentTaskState::Queued;
                return Ok(());
            }
            return Err(AgentHelperError::LeaseNotFound);
        }
        Err(AgentHelperError::LeaseNotFound)
    }

    pub fn best_candidate(&self, job_id: &str, owner: &SolverOwner) -> Option<AgentCandidate> {
        let state = self.state.lock().ok()?;
        let job = state.jobs.get(job_id).filter(|job| job.owner == *owner)?;
        better_agent_candidate(
            job.best_candidate.clone(),
            job.checkpoint_candidate.clone(),
        )
    }

    pub fn has_active_lease(&self, job_id: &str, owner: &SolverOwner) -> bool {
        matches!(
            self.job_execution(job_id, owner, crate::now_millis()),
            Some(AgentJobExecution::Leased { .. })
        )
    }
}

pub fn session_binding(auth_token: &str) -> String {
    secret_hash(auth_token.trim())
}

fn normalize_worker_id(value: &str) -> Result<String, AgentHelperError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_WORKER_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(AgentHelperError::InvalidWorker);
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_lease_request_id(value: &str) -> Result<String, AgentHelperError> {
    let value = value.trim();
    if !(8..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err(AgentHelperError::InvalidLeaseRequest);
    }
    Ok(value.to_string())
}

fn normalize_worker_name(value: &str, fallback: &str) -> String {
    let mut cleaned = String::new();
    for ch in value.trim().chars().filter(|ch| !ch.is_control()) {
        if cleaned.len().saturating_add(ch.len_utf8()) > MAX_WORKER_NAME_BYTES {
            break;
        }
        cleaned.push(ch);
    }
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

fn normalize_user_code(value: &str) -> Result<String, AgentPairError> {
    const ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let compact = value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != b'-')
        .map(|byte| byte.to_ascii_uppercase())
        .collect::<Vec<_>>();
    if compact.len() != 8
        || compact
            .iter()
            .any(|byte| !ALPHABET.as_bytes().contains(byte))
    {
        return Err(AgentPairError::InvalidRequest);
    }
    let compact = String::from_utf8(compact).map_err(|_| AgentPairError::InvalidRequest)?;
    Ok(format!("{}-{}", &compact[..4], &compact[4..]))
}

fn normalize_device_code(value: &str) -> Result<&str, AgentPairError> {
    let value = value.trim();
    if value.len() != 69
        || !value.starts_with("tkbp_")
        || !value[5..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AgentPairError::InvalidRequest);
    }
    Ok(value)
}

fn worker_can_access_job(worker: &AgentWorker, job: &AgentJob) -> bool {
    let owner_allowed = if worker.trusted_global {
        job.trusted_global_eligible
    } else {
        job.owner == worker.owner
    };
    owner_allowed
        && worker
            .job_scope
            .as_deref()
            .is_none_or(|job_scope| job_scope == job.job_id)
}

/// Browser WASM may run bounded Quick completion or refine a revalidated,
/// complete incumbent. Quick eligibility is based only on the canonical solve
/// envelope; any client-supplied partial incumbent remains untrusted and the
/// submitted candidate must still pass the server's complete validator.
pub(crate) fn browser_refinement_request_eligible(request_body: &[u8]) -> bool {
    let Ok(request) = serde_json::from_slice::<Value>(request_body) else {
        return false;
    };
    let Some(settings) = request.get("settings").and_then(Value::as_object) else {
        return false;
    };
    let optimization_focus = settings
        .get("optimization_focus")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .replace(' ', "_")
        .replace('-', "_");
    if optimization_focus == "quick_complete" {
        if settings
            .get("ui_solver_fifo_admission")
            .and_then(Value::as_bool)
            != Some(true)
            || settings
                .get("ui_solver_async_job")
                .and_then(Value::as_bool)
                != Some(true)
            || settings
                .get("require_complete_schedule")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return false;
        }
        return settings
            .get("ui_progress_metric_target")
            .is_none_or(|target| {
                target
                    .as_u64()
                    .is_some_and(|target| target > 0 && target <= i64::MAX as u64)
            });
    }
    if optimization_focus == "automatic"
        && settings
            .get("ui_unified_solve_kind")
            .and_then(Value::as_str)
            == Some("fresh_complete_first")
    {
        return settings
            .get("ui_solver_fifo_admission")
            .and_then(Value::as_bool)
            == Some(true)
            && settings
                .get("ui_solver_async_job")
                .and_then(Value::as_bool)
                == Some(true)
            && settings
                .get("require_complete_schedule")
                .and_then(Value::as_bool)
                == Some(true);
    }
    if matches!(optimization_focus.as_str(), "quick" | "complete") {
        return false;
    }
    if settings
        .get("ui_unified_solve_kind")
        .and_then(Value::as_str)
        != Some("refine_complete")
        || settings
            .get("ui_use_existing_complete_incumbent")
            .and_then(Value::as_bool)
            != Some(true)
        || settings
            .get("ui_existing_incumbent_revalidated")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return false;
    }

    let Some(result) = request
        .get("data")
        .and_then(|data| data.get("tkbSolverResult"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    let Some(metrics) = result.get("metrics").and_then(Value::as_object) else {
        return false;
    };
    let expected = metrics
        .get("expected_periods")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let scheduled = metrics
        .get("scheduled_periods")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let unassigned = metrics
        .get("unassigned_periods")
        .and_then(Value::as_u64)
        .unwrap_or(u64::MAX);
    let violations = metrics
        .get("app_constraint_violation_count")
        .and_then(Value::as_u64)
        .unwrap_or(u64::MAX);
    let lessons = result
        .get("lessons")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0);

    expected > 0
        && scheduled == expected
        && lessons == expected
        && unassigned == 0
        && violations == 0
        && metrics.get("hard_ok").and_then(Value::as_bool) == Some(true)
        && result
            .get("validation")
            .and_then(|validation| validation.get("hard_ok"))
            .and_then(Value::as_bool)
            == Some(true)
}

fn trusted_handoff_marker(worker_token_hash: &str, lease_request_id: &str) -> String {
    secret_hash(&format!(
        "trusted-handoff\0{worker_token_hash}\0{lease_request_id}"
    ))
}

fn release_trusted_handoff_capacity_for_job(state: &mut AgentHelperState, job_id: &str) {
    for request in state.trusted_handoff_requests.values_mut() {
        if request.job_id.as_deref() == Some(job_id) {
            request.capacity_reserved = false;
        }
    }
    // Registration/cleanup can beat commit_trusted_handoff_request after the
    // solver-pool fence has moved. Remember that transition while any
    // uncommitted reservation exists so the later commit becomes a tombstone
    // instead of reserving a dead job for the full worker TTL.
    if state
        .trusted_handoff_requests
        .values()
        .any(|request| request.job_id.is_none() && request.capacity_reserved)
        && !state
            .trusted_handoff_capacity_releases
            .iter()
            .any(|released_job_id| released_job_id == job_id)
    {
        state
            .trusted_handoff_capacity_releases
            .push_back(job_id.to_string());
        while state.trusted_handoff_capacity_releases.len() > MAX_TRUSTED_HANDOFF_REQUESTS {
            state.trusted_handoff_capacity_releases.pop_front();
        }
    }
}

fn take_trusted_handoff_capacity_release(state: &mut AgentHelperState, job_id: &str) -> bool {
    let Some(index) = state
        .trusted_handoff_capacity_releases
        .iter()
        .position(|released_job_id| released_job_id == job_id)
    else {
        return false;
    };
    state.trusted_handoff_capacity_releases.remove(index);
    true
}

fn clear_orphaned_trusted_handoff_capacity_releases(state: &mut AgentHelperState) {
    if !state
        .trusted_handoff_requests
        .values()
        .any(|request| request.job_id.is_none() && request.capacity_reserved)
    {
        state.trusted_handoff_capacity_releases.clear();
    }
}

fn authenticated_worker(
    state: &AgentHelperState,
    owner: &SolverOwner,
    session_binding: &str,
    worker_token: &str,
    now_ms: u64,
) -> Result<(String, AgentWorker), AgentHelperError> {
    let worker_token_hash = secret_hash(worker_token.trim());
    let worker = state
        .workers
        .get(&worker_token_hash)
        .filter(|worker| {
            worker.owner == *owner
                && worker.session_binding == session_binding
                && worker.expires_at_ms > now_ms
        })
        .cloned()
        .ok_or(AgentHelperError::UnauthorizedWorker)?;
    Ok((worker_token_hash, worker))
}

fn prune_state(state: &mut AgentHelperState, now_ms: u64) {
    state
        .pairings
        .retain(|_, pairing| pairing.expires_at_ms > now_ms);
    state
        .trusted_handoff_requests
        .retain(|_, request| request.expires_at_ms > now_ms);
    let expired_workers = state
        .workers
        .iter()
        .filter(|(_, worker)| worker.expires_at_ms <= now_ms)
        .map(|(token_hash, _)| token_hash.clone())
        .collect::<HashSet<_>>();
    state
        .workers
        .retain(|token_hash, _| !expired_workers.contains(token_hash));
    state
        .trusted_handoff_requests
        .retain(|_, request| !expired_workers.contains(&request.worker_token_hash));
    clear_orphaned_trusted_handoff_capacity_releases(state);
    for job in state.jobs.values_mut() {
        for task in &mut job.tasks {
            let release = matches!(
                &task.state,
                AgentTaskState::Leased {
                    worker_token_hash,
                    expires_at_ms,
                    ..
                } if *expires_at_ms <= now_ms || expired_workers.contains(worker_token_hash)
            );
            if release {
                task.state = AgentTaskState::Queued;
            }
        }
    }
    state
        .jobs
        .retain(|_, job| now_ms.saturating_sub(job.created_at_ms) <= AGENT_JOB_TTL_MS);
}

fn release_worker_leases(
    jobs: &mut HashMap<String, AgentJob>,
    worker_token_hashes: &HashSet<String>,
) {
    if worker_token_hashes.is_empty() {
        return;
    }
    for job in jobs.values_mut() {
        for task in &mut job.tasks {
            if matches!(
                &task.state,
                AgentTaskState::Leased { worker_token_hash, .. }
                    if worker_token_hashes.contains(worker_token_hash)
            ) {
                task.state = AgentTaskState::Queued;
            }
        }
    }
}

fn seed_for(job_id: &str, index: usize) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(b"tkb-agent-seed-v1\0");
    hasher.update(job_id.as_bytes());
    hasher.update((index as u64).to_le_bytes());
    let digest = hasher.finalize();
    u64::from_le_bytes(digest[..8].try_into().unwrap_or([0; 8])).max(1)
}

#[cfg(unix)]
fn fill_os_random(bytes: &mut [u8]) -> io::Result<()> {
    use std::io::Read;

    std::fs::File::open("/dev/urandom")?.read_exact(bytes)
}

#[cfg(windows)]
fn fill_os_random(bytes: &mut [u8]) -> io::Result<()> {
    use std::ffi::c_void;
    use std::ptr;

    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;

    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut c_void,
            buffer: *mut u8,
            buffer_len: u32,
            flags: u32,
        ) -> i32;
    }

    let buffer_len = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "random buffer too large"))?;
    // SAFETY: BCryptGenRandom writes exactly `buffer_len` bytes to this valid
    // mutable slice. A null algorithm handle is required with the system flag.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            bytes.as_mut_ptr(),
            buffer_len,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status >= 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "BCryptGenRandom failed with NTSTATUS {status:#x}"
        )))
    }
}

#[cfg(not(any(unix, windows)))]
compile_error!("TKB Agent Helper requires an operating-system CSPRNG");

fn make_secret() -> String {
    let mut bytes = [0_u8; 32];
    fill_os_random(&mut bytes).expect("operating-system CSPRNG unavailable");
    hex_bytes(&bytes)
}

fn make_user_code() -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0_u8; 8];
    fill_os_random(&mut bytes).expect("operating-system CSPRNG unavailable");
    let mut compact = String::with_capacity(8);
    for byte in bytes {
        compact.push(ALPHABET[(byte & 31) as usize] as char);
    }
    format!("{}-{}", &compact[..4], &compact[4..])
}

fn secret_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"tkb-agent-token-hash-v1\0");
    hasher.update(value.as_bytes());
    hex_bytes(&hasher.finalize())
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser_refinement_request() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "data": {
                "tkbSolverResult": {
                    "lessons": [{"classId":"6A"}, {"classId":"6A"}],
                    "metrics": {
                        "scheduled_periods": 2,
                        "expected_periods": 2,
                        "unassigned_periods": 0,
                        "app_constraint_violation_count": 0,
                        "hard_ok": true
                    },
                    "validation": {"hard_ok": true}
                }
            },
            "settings": {
                "ui_unified_solve_kind": "refine_complete",
                "ui_use_existing_complete_incumbent": true,
                "ui_existing_incumbent_revalidated": true
            }
        }))
        .unwrap()
    }

    #[test]
    fn browser_worker_accepts_only_revalidated_complete_refinement_jobs() {
        let request = browser_refinement_request();
        assert!(browser_refinement_request_eligible(&request));

        let mut quick: Value = serde_json::from_slice(&request).unwrap();
        quick["settings"]["optimization_focus"] = serde_json::json!("quick_complete");
        quick["settings"]["ui_solver_fifo_admission"] = serde_json::json!(true);
        quick["settings"]["ui_solver_async_job"] = serde_json::json!(true);
        quick["settings"]["require_complete_schedule"] = serde_json::json!(true);
        quick["settings"]["ui_progress_metric_target"] = serde_json::json!(2);
        assert!(browser_refinement_request_eligible(
            &serde_json::to_vec(&quick).unwrap()
        ));

        let mut quick_alias = quick.clone();
        quick_alias["settings"]["optimization_focus"] = serde_json::json!("quick");
        assert!(!browser_refinement_request_eligible(
            &serde_json::to_vec(&quick_alias).unwrap()
        ));

        let mut quick_partial = quick.clone();
        quick_partial["data"]["tkbSolverResult"]["lessons"] =
            serde_json::json!([{"classId":"6A"}]);
        quick_partial["data"]["tkbSolverResult"]["metrics"]["scheduled_periods"] =
            serde_json::json!(1);
        quick_partial["data"]["tkbSolverResult"]["metrics"]["unassigned_periods"] =
            serde_json::json!(1);
        assert!(browser_refinement_request_eligible(
            &serde_json::to_vec(&quick_partial).unwrap()
        ));

        let mut quick_without_complete_contract = quick.clone();
        quick_without_complete_contract["settings"]["require_complete_schedule"] =
            serde_json::json!(false);
        assert!(!browser_refinement_request_eligible(
            &serde_json::to_vec(&quick_without_complete_contract).unwrap()
        ));

        let mut quick_with_invalid_target = quick.clone();
        quick_with_invalid_target["settings"]["ui_progress_metric_target"] =
            serde_json::json!(0);
        assert!(!browser_refinement_request_eligible(
            &serde_json::to_vec(&quick_with_invalid_target).unwrap()
        ));

        let mut fresh: Value = serde_json::from_slice(&request).unwrap();
        fresh["settings"]["ui_unified_solve_kind"] = serde_json::json!("fresh_complete_first");
        fresh["settings"]["optimization_focus"] = serde_json::json!("automatic");
        fresh["settings"]["ui_solver_fifo_admission"] = serde_json::json!(true);
        fresh["settings"]["ui_solver_async_job"] = serde_json::json!(true);
        fresh["settings"]["require_complete_schedule"] = serde_json::json!(true);
        fresh["data"]
            .as_object_mut()
            .unwrap()
            .remove("tkbSolverResult");
        assert!(browser_refinement_request_eligible(
            &serde_json::to_vec(&fresh).unwrap()
        ));

        let mut incomplete: Value = serde_json::from_slice(&request).unwrap();
        incomplete["data"]["tkbSolverResult"]["metrics"]["unassigned_periods"] =
            serde_json::json!(1);
        assert!(!browser_refinement_request_eligible(
            &serde_json::to_vec(&incomplete).unwrap()
        ));

        let mut forged: Value = serde_json::from_slice(&request).unwrap();
        forged["data"]["tkbSolverResult"]["lessons"] = serde_json::json!([{"classId":"6A"}]);
        assert!(!browser_refinement_request_eligible(
            &serde_json::to_vec(&forged).unwrap()
        ));
    }

    #[test]
    fn online_worker_count_is_owner_scoped_and_drops_expired_sessions() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let other_owner = SolverOwner::new("school-b", "admin-b");
        coordinator
            .register_worker(
                &owner,
                &session_binding("session-a"),
                "pc-online",
                "PC Online",
                1,
                1_000,
            )
            .unwrap();
        coordinator
            .register_scoped_worker(
                &owner,
                &session_binding("session-browser"),
                "web-online",
                "Browser Online",
                1,
                "job-browser",
                1_000,
            )
            .unwrap();

        assert_eq!(coordinator.online_worker_count(&owner, 1_000), 2);
        assert_eq!(coordinator.online_worker_counts(&owner, 1_000), (1, 1));
        assert_eq!(coordinator.online_worker_count(&other_owner, 1_000), 0);
        assert_eq!(
            coordinator.online_worker_count(&owner, 1_000 + AGENT_WORKER_TTL_MS),
            0
        );
    }

    #[test]
    fn trusted_worker_draws_global_fifo_without_appearing_as_a_user_agent() {
        let coordinator = AgentHelperCoordinator::default();
        let first_owner = SolverOwner::new("school-a", "admin-a");
        let second_owner = SolverOwner::new("school-b", "admin-b");
        let trusted_owner = SolverOwner::new("operator-infrastructure", "trusted-worker");
        let trusted_binding = session_binding("trusted-service-token");
        assert!(coordinator.register_job(
            "owner-direct-job",
            &first_owner,
            Arc::new(br#"{"data":{"school":"owner"},"settings":{}}"#.to_vec()),
            1,
            999,
        ));
        assert!(coordinator.register_job_with_trusted_eligibility(
            "global-job-a",
            &first_owner,
            Arc::new(br#"{"data":{"school":"a"},"settings":{}}"#.to_vec()),
            1,
            true,
            1_000,
        ));
        assert!(coordinator.register_job_with_trusted_eligibility(
            "global-job-b",
            &second_owner,
            Arc::new(br#"{"data":{"school":"b"},"settings":{}}"#.to_vec()),
            1,
            true,
            1_001,
        ));
        let worker = coordinator
            .register_trusted_worker(
                &trusted_owner,
                &trusted_binding,
                "trusted-linux-1",
                "Trusted Linux 1",
                1,
                1_002,
            )
            .unwrap();

        assert_eq!(coordinator.online_worker_count(&first_owner, 1_003), 0);
        assert_eq!(coordinator.online_worker_count(&second_owner, 1_003), 0);
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_003,
            )
            .unwrap());
        assert!(!coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_003,
            )
            .unwrap());
        assert!(coordinator
            .release_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_003,
            )
            .unwrap());
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_003,
            )
            .unwrap());
        assert!(coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                "global-job-a",
                1_004,
            )
            .unwrap());
        let first = coordinator
            .claim_work_with_request_id(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_004,
            )
            .unwrap();
        assert_eq!(first.job_id, "global-job-a");
        assert!(!coordinator
            .release_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_004,
            )
            .unwrap());
        coordinator
            .accept_structured_outcome(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                &first.work_id,
                &first.lease_token,
                1_005,
            )
            .unwrap();
        assert!(coordinator.finish_job("global-job-a", &first_owner));

        assert!(matches!(
            coordinator.claim_work_with_request_id(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_006,
            ),
            Err(AgentHelperError::NoWork)
        ));
        assert!(!coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-1",
                1_006,
            )
            .unwrap());
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-2",
                1_006,
            )
            .unwrap());
        assert!(coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-2",
                "global-job-b",
                1_006,
            )
            .unwrap());

        let second = coordinator
            .claim_work_with_request_id(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-poll-2",
                1_006,
            )
            .unwrap();
        assert_eq!(second.job_id, "global-job-b");
        assert!(matches!(
            coordinator.job_execution("owner-direct-job", &first_owner, 1_007),
            Some(AgentJobExecution::Queued)
        ));
    }

    #[test]
    fn committed_trusted_handoff_reserves_capacity_until_registration_or_cancel() {
        let coordinator = AgentHelperCoordinator::default();
        let job_owner = SolverOwner::new("school-capacity", "admin");
        let trusted_owner = SolverOwner::new("operator-infrastructure", "trusted-worker");
        let trusted_binding = session_binding("trusted-capacity-service-token");
        let worker = coordinator
            .register_trusted_worker(
                &trusted_owner,
                &trusted_binding,
                "trusted-linux-capacity",
                "Trusted Linux Capacity",
                1,
                1_000,
            )
            .unwrap();

        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-poll-one",
                1_001,
            )
            .unwrap());
        assert!(coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-poll-one",
                "capacity-job-one",
                1_001,
            )
            .unwrap());
        assert!(matches!(
            coordinator.begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-poll-two",
                1_002,
            ),
            Err(AgentHelperError::WorkerAtCapacity)
        ));

        assert!(coordinator.register_job_with_trusted_eligibility(
            "capacity-job-one",
            &job_owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            true,
            1_003,
        ));
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-poll-two",
                1_003,
            )
            .unwrap());
        assert!(coordinator
            .release_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-poll-two",
                1_003,
            )
            .unwrap());
        assert!(!coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-poll-one",
                1_004,
            )
            .unwrap());

        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "cancel-before-register",
                1_005,
            )
            .unwrap());
        assert!(coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "cancel-before-register",
                "cancelled-capacity-job",
                1_005,
            )
            .unwrap());
        assert!(matches!(
            coordinator.begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-after-cancel",
                1_006,
            ),
            Err(AgentHelperError::WorkerAtCapacity)
        ));
        assert!(!coordinator.finish_job("cancelled-capacity-job", &job_owner));
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "capacity-after-cancel",
                1_006,
            )
            .unwrap());
        assert!(!coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "cancel-before-register",
                1_006,
            )
            .unwrap());
    }

    #[test]
    fn transition_before_trusted_handoff_commit_releases_capacity_but_keeps_replay() {
        let coordinator = AgentHelperCoordinator::default();
        let job_owner = SolverOwner::new("school-commit-race", "admin");
        let trusted_owner = SolverOwner::new("operator-infrastructure", "trusted-worker");
        let trusted_binding = session_binding("trusted-commit-race-token");
        let worker = coordinator
            .register_trusted_worker(
                &trusted_owner,
                &trusted_binding,
                "trusted-linux-commit-race",
                "Trusted Linux Commit Race",
                1,
                1_000,
            )
            .unwrap();

        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "commit-race-poll",
                1_001,
            )
            .unwrap());
        assert!(coordinator.register_job_with_trusted_eligibility(
            "commit-race-job",
            &job_owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            true,
            1_002,
        ));
        assert!(coordinator.finish_job("commit-race-job", &job_owner));

        // The lifecycle transition won the race before the HTTP handoff path
        // attached its job ID. Commit must not resurrect the capacity hold.
        assert!(coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "commit-race-poll",
                "commit-race-job",
                1_003,
            )
            .unwrap());
        assert!(!coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "commit-race-poll",
                "different-job-must-not-rebind",
                1_003,
            )
            .unwrap());
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "next-after-commit-race",
                1_004,
            )
            .unwrap());
        assert!(!coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "commit-race-poll",
                1_004,
            )
            .unwrap());
    }

    #[test]
    fn cancelled_trusted_handoff_keeps_a_replay_tombstone_until_ttl() {
        let coordinator = AgentHelperCoordinator::default();
        let trusted_owner = SolverOwner::new("operator-infrastructure", "trusted-worker");
        let trusted_binding = session_binding("trusted-service-token");
        let worker = coordinator
            .register_trusted_worker(
                &trusted_owner,
                &trusted_binding,
                "trusted-linux-tombstone",
                "Trusted Linux Tombstone",
                1,
                1_000,
            )
            .unwrap();

        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-cancelled-poll",
                1_001,
            )
            .unwrap());
        assert!(coordinator
            .commit_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-cancelled-poll",
                "cancelled-before-agent-registration",
                1_001,
            )
            .unwrap());

        // Cancellation can reach cleanup before an AgentJob is registered.
        // The committed request must still block its own replay, while no
        // longer occupying this worker's single execution slot.
        assert!(!coordinator.finish_job(
            "cancelled-before-agent-registration",
            &SolverOwner::new("school-cancelled", "admin")
        ));
        assert!(!coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-cancelled-poll",
                1_002,
            )
            .unwrap());
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-next-poll",
                1_002,
            )
            .unwrap());
        assert!(matches!(
            coordinator.begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-third-poll",
                1_002,
            ),
            Err(AgentHelperError::WorkerAtCapacity)
        ));
        assert!(coordinator
            .release_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-next-poll",
                1_002,
            )
            .unwrap());

        let heartbeat_at = 1_000 + AGENT_WORKER_TTL_MS - 1;
        coordinator
            .heartbeat(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                &[],
                heartbeat_at,
            )
            .unwrap();
        assert!(coordinator
            .begin_trusted_handoff_request(
                &trusted_owner,
                &trusted_binding,
                &worker.worker_token,
                "trusted-cancelled-poll",
                1_001 + AGENT_WORKER_TTL_MS,
            )
            .unwrap());
    }

    #[test]
    fn upgrade_only_worker_can_idle_but_never_counts_online_or_claims_work() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "upgrade-only-job",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let worker = coordinator
            .register_upgrade_worker(&owner, &binding, "old-pc", "Old PC", 1, 1_000)
            .unwrap();

        assert_eq!(coordinator.online_worker_count(&owner, 1_001), 0);
        assert_eq!(
            coordinator.worker_eligibility(&owner, &binding, &worker.worker_token, 1_001),
            Some(false)
        );
        assert!(coordinator
            .heartbeat(&owner, &binding, &worker.worker_token, &[], 1_002)
            .is_ok());
        assert!(matches!(
            coordinator.claim_work(&owner, &binding, &worker.worker_token, 1_003),
            Err(AgentHelperError::NoWork)
        ));
        assert!(matches!(
            coordinator.job_execution("upgrade-only-job", &owner, 1_004),
            Some(AgentJobExecution::Queued)
        ));
    }

    #[test]
    fn revoking_worker_identity_or_token_requeues_its_active_lease() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "revoked-worker-job",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let first = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let first_lease = coordinator
            .claim_work(&owner, &binding, &first.worker_token, 1_001)
            .unwrap();

        assert!(coordinator.revoke_worker_identity(&owner, &binding, "PC-1", 1_002));
        assert_eq!(coordinator.online_worker_count(&owner, 1_002), 0);
        assert!(matches!(
            coordinator.job_execution("revoked-worker-job", &owner, 1_002),
            Some(AgentJobExecution::Queued)
        ));
        assert!(matches!(
            coordinator.begin_submission(
                &owner,
                &binding,
                &first.worker_token,
                &first_lease.work_id,
                &first_lease.lease_token,
                1_003,
            ),
            Err(AgentHelperError::UnauthorizedWorker)
        ));

        let replacement = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_003)
            .unwrap();
        let replacement_lease = coordinator
            .claim_work(&owner, &binding, &replacement.worker_token, 1_004)
            .unwrap();
        assert_eq!(replacement_lease.work_id, first_lease.work_id);
        assert_eq!(replacement_lease.attempt, 2);
        assert!(coordinator.revoke_worker_token(
            &owner,
            &binding,
            &replacement.worker_token,
            1_005,
        ));
        assert_eq!(coordinator.online_worker_count(&owner, 1_005), 0);
        assert!(matches!(
            coordinator.job_execution("revoked-worker-job", &owner, 1_005),
            Some(AgentJobExecution::Queued)
        ));
    }

    #[test]
    fn leases_are_session_bound_exclusive_and_reassigned_after_expiry() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let other_owner = SolverOwner::new("school-b", "admin-b");
        let binding = session_binding("session-a");
        let other_binding = session_binding("session-b");
        assert!(coordinator.register_job(
            "job-a",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let first = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let second = coordinator
            .register_worker(&owner, &binding, "pc-2", "PC 2", 1, 1_000)
            .unwrap();
        let lease = coordinator
            .claim_work(&owner, &binding, &first.worker_token, 1_001)
            .unwrap();
        assert!(matches!(
            coordinator.claim_work(&owner, &binding, &second.worker_token, 1_002),
            Err(AgentHelperError::NoWork)
        ));
        assert!(matches!(
            coordinator.begin_submission(
                &other_owner,
                &other_binding,
                &first.worker_token,
                &lease.work_id,
                &lease.lease_token,
                1_003,
            ),
            Err(AgentHelperError::UnauthorizedWorker)
        ));

        let reassigned = coordinator
            .claim_work(
                &owner,
                &binding,
                &second.worker_token,
                lease.lease_expires_at_ms + 1,
            )
            .unwrap();
        assert_eq!(reassigned.work_id, lease.work_id);
        assert_ne!(reassigned.lease_token, lease.lease_token);
        assert_eq!(reassigned.attempt, 2);
        assert!(matches!(
            coordinator.begin_submission(
                &owner,
                &binding,
                &first.worker_token,
                &lease.work_id,
                &lease.lease_token,
                lease.lease_expires_at_ms + 2,
            ),
            Err(AgentHelperError::LeaseNotFound)
        ));
    }

    #[test]
    fn job_execution_snapshot_requeues_an_abrupt_agent_without_a_final_request() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "handoff-job",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let worker = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        assert!(matches!(
            coordinator.job_execution("handoff-job", &owner, 1_000),
            Some(AgentJobExecution::Queued)
        ));
        let lease = coordinator
            .claim_work(&owner, &binding, &worker.worker_token, 1_001)
            .unwrap();
        assert!(matches!(
            coordinator.job_execution("handoff-job", &owner, 1_002),
            Some(AgentJobExecution::Leased { .. })
        ));
        assert!(!coordinator.take_over_for_vps("handoff-job", &owner, 1_002));
        assert!(matches!(
            coordinator.job_execution("handoff-job", &owner, lease.lease_expires_at_ms + 1,),
            Some(AgentJobExecution::Queued)
        ));
        assert!(coordinator.take_over_for_vps(
            "handoff-job",
            &owner,
            lease.lease_expires_at_ms + 1,
        ));
        assert!(coordinator
            .job_execution("handoff-job", &owner, lease.lease_expires_at_ms + 2)
            .is_none());
    }

    #[test]
    fn takeover_yields_to_a_candidate_completed_after_the_watchdog_snapshot() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "handoff-race",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let worker = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let lease = coordinator
            .claim_work(&owner, &binding, &worker.worker_token, 1_001)
            .unwrap();

        // The watchdog has already observed the lease as expired/queued. A
        // replacement Agent can still claim and finish it before takeover's
        // atomic check; that result must win over a VPS restart.
        let replacement = coordinator
            .claim_work(
                &owner,
                &binding,
                &worker.worker_token,
                lease.lease_expires_at_ms + 1,
            )
            .unwrap();
        assert!(coordinator
            .accept_submission(
                &owner,
                &binding,
                &worker.worker_token,
                &replacement.work_id,
                &replacement.lease_token,
                serde_json::json!({"ok": true}),
                [1, 0, 0, 0],
                lease.lease_expires_at_ms + 2,
            )
            .unwrap());
        assert!(!coordinator.take_over_for_vps(
            "handoff-race",
            &owner,
            lease.lease_expires_at_ms + 3,
        ));
        assert!(matches!(
            coordinator.job_execution("handoff-race", &owner, lease.lease_expires_at_ms + 3),
            Some(AgentJobExecution::Completed { candidate: Some(_) })
        ));
    }

    #[test]
    fn checkpoint_stays_leased_and_stop_atomically_takes_the_best() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "checkpoint-stop",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let worker = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let lease = coordinator
            .claim_work(&owner, &binding, &worker.worker_token, 1_001)
            .unwrap();

        assert!(coordinator
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                serde_json::json!({"marker":"first"}),
                [0, 0, 5, 0],
                1_002,
            )
            .unwrap());
        assert!(matches!(
            coordinator.job_execution("checkpoint-stop", &owner, 1_003),
            Some(AgentJobExecution::Leased { .. })
        ));
        assert!(coordinator
            .accept_checkpoint(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                serde_json::json!({"marker":"better"}),
                [0, 0, 3, 0],
                1_004,
            )
            .unwrap());

        let stopped = coordinator
            .take_candidate_and_finish_job("checkpoint-stop", &owner)
            .expect("Stop must retain the accepted checkpoint");
        assert_eq!(stopped.payload["marker"], serde_json::json!("better"));
        assert!(coordinator
            .job_execution("checkpoint-stop", &owner, 1_005)
            .is_none());
    }

    #[test]
    fn heartbeat_renews_only_the_exact_lease_and_best_candidate_is_scoped() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        coordinator.register_job(
            "job-a",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            2_000,
        );
        let worker = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 2_000)
            .unwrap();
        let lease = coordinator
            .claim_work(&owner, &binding, &worker.worker_token, 2_001)
            .unwrap();
        let heartbeat = coordinator
            .heartbeat(
                &owner,
                &binding,
                &worker.worker_token,
                &[
                    AgentLeaseHeartbeat {
                        work_id: lease.work_id.clone(),
                        lease_token: lease.lease_token.clone(),
                    },
                    AgentLeaseHeartbeat {
                        work_id: "missing".to_string(),
                        lease_token: "wrong".to_string(),
                    },
                ],
                2_500,
            )
            .unwrap();
        assert_eq!(heartbeat.renewed_work_ids, vec![lease.work_id.clone()]);
        assert_eq!(heartbeat.lost_work_ids, vec!["missing".to_string()]);

        let ticket = coordinator
            .begin_submission(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                2_501,
            )
            .unwrap();
        assert_eq!(ticket.job_id, "job-a");
        assert!(coordinator
            .accept_submission(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                serde_json::json!({"ok": true}),
                [0, 0, 1, 0],
                2_502,
            )
            .unwrap());
        let best = coordinator.best_candidate("job-a", &owner).unwrap();
        assert_eq!(best.worker_id, "pc-1");
        assert_eq!(best.seed, ticket.seed);
        assert!(coordinator
            .best_candidate("job-a", &SolverOwner::new("school-b", "admin-b"))
            .is_none());
        let terminal_candidate = coordinator
            .take_candidate_and_finish_job("job-a", &owner)
            .expect("accepted candidate must win the terminal close");
        assert_eq!(terminal_candidate.worker_id, "pc-1");
        assert!(coordinator.best_candidate("job-a", &owner).is_none());

        assert!(coordinator.register_job(
            "job-without-candidate",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            2_600,
        ));
        assert!(coordinator
            .take_candidate_and_finish_job("job-without-candidate", &owner)
            .is_none());
        assert!(coordinator
            .job_execution("job-without-candidate", &owner, 2_601)
            .is_none());
    }

    #[test]
    fn heartbeat_extends_the_lease_and_session_binding_is_required() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        let wrong_binding = session_binding("session-b");
        assert!(coordinator.register_job(
            "job-a",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let first = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let second = coordinator
            .register_worker(&owner, &binding, "pc-2", "PC 2", 1, 1_000)
            .unwrap();
        let lease = coordinator
            .claim_work(&owner, &binding, &first.worker_token, 1_001)
            .unwrap();

        assert!(matches!(
            coordinator.heartbeat(&owner, &wrong_binding, &first.worker_token, &[], 1_002),
            Err(AgentHelperError::UnauthorizedWorker)
        ));
        let heartbeat_at = lease.lease_expires_at_ms - 1;
        let heartbeat = coordinator
            .heartbeat(
                &owner,
                &binding,
                &first.worker_token,
                &[AgentLeaseHeartbeat {
                    work_id: lease.work_id.clone(),
                    lease_token: lease.lease_token.clone(),
                }],
                heartbeat_at,
            )
            .unwrap();
        assert_eq!(heartbeat.renewed_work_ids, vec![lease.work_id.clone()]);

        assert!(matches!(
            coordinator.claim_work(
                &owner,
                &binding,
                &second.worker_token,
                lease.lease_expires_at_ms + 1,
            ),
            Err(AgentHelperError::NoWork)
        ));
        let renewed_expires_at = heartbeat_at + AGENT_WORK_LEASE_MS;
        let reassigned = coordinator
            .claim_work(&owner, &binding, &second.worker_token, renewed_expires_at)
            .unwrap();
        assert_eq!(reassigned.work_id, lease.work_id);
        assert_eq!(reassigned.attempt, 2);
    }

    #[test]
    fn reregistering_same_worker_invalidates_token_and_requeues_its_lease() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "job-a",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let first = coordinator
            .register_worker(&owner, &binding, "PC-1", "Primary PC", 1, 1_000)
            .unwrap();
        let first_lease = coordinator
            .claim_work(&owner, &binding, &first.worker_token, 1_001)
            .unwrap();

        let replacement = coordinator
            .register_worker(&owner, &binding, "pc-1", "Primary PC", 1, 1_002)
            .unwrap();
        assert_eq!(replacement.worker_id, "pc-1");
        assert_ne!(replacement.worker_token, first.worker_token);
        assert!(matches!(
            coordinator.begin_submission(
                &owner,
                &binding,
                &first.worker_token,
                &first_lease.work_id,
                &first_lease.lease_token,
                1_003,
            ),
            Err(AgentHelperError::UnauthorizedWorker)
        ));

        let replacement_lease = coordinator
            .claim_work(&owner, &binding, &replacement.worker_token, 1_003)
            .unwrap();
        assert_eq!(replacement_lease.work_id, first_lease.work_id);
        assert_eq!(replacement_lease.attempt, 2);
    }

    #[test]
    fn rejected_submission_is_requeued_without_accepting_a_candidate() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "job-a",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let worker = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let lease = coordinator
            .claim_work(&owner, &binding, &worker.worker_token, 1_001)
            .unwrap();
        coordinator
            .reject_submission(
                &owner,
                &binding,
                &worker.worker_token,
                &lease.work_id,
                &lease.lease_token,
                1_002,
            )
            .unwrap();
        assert!(coordinator.best_candidate("job-a", &owner).is_none());

        let retry = coordinator
            .claim_work(&owner, &binding, &worker.worker_token, 1_003)
            .unwrap();
        assert_eq!(retry.work_id, lease.work_id);
        assert_eq!(retry.attempt, 2);
        assert_ne!(retry.lease_token, lease.lease_token);
    }

    #[test]
    fn lease_request_replay_returns_the_exact_active_lease_before_capacity_checks() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let binding = session_binding("session-a");
        assert!(coordinator.register_job(
            "job-a",
            &owner,
            Arc::new(br#"{"data":{},"settings":{}}"#.to_vec()),
            1,
            1_000,
        ));
        let worker = coordinator
            .register_worker(&owner, &binding, "pc-1", "PC 1", 1, 1_000)
            .unwrap();
        let first = coordinator
            .claim_work_with_request_id(
                &owner,
                &binding,
                &worker.worker_token,
                "lease-request-0001",
                1_001,
            )
            .unwrap();
        let replay = coordinator
            .claim_work_with_request_id(
                &owner,
                &binding,
                &worker.worker_token,
                "lease-request-0001",
                1_002,
            )
            .unwrap();
        assert_eq!(replay.work_id, first.work_id);
        assert_eq!(replay.job_id, first.job_id);
        assert_eq!(replay.lease_token, first.lease_token);
        assert_eq!(replay.lease_expires_at_ms, first.lease_expires_at_ms);
        assert_eq!(replay.seed, first.seed);
        assert_eq!(replay.attempt, 1);
        assert!(Arc::ptr_eq(&replay.request_body, &first.request_body));

        assert!(matches!(
            coordinator.claim_work_with_request_id(
                &owner,
                &binding,
                &worker.worker_token,
                "lease-request-0002",
                1_003,
            ),
            Err(AgentHelperError::WorkerAtCapacity)
        ));
        let after_expiry = coordinator
            .claim_work_with_request_id(
                &owner,
                &binding,
                &worker.worker_token,
                "lease-request-0001",
                first.lease_expires_at_ms + 1,
            )
            .unwrap();
        assert_eq!(after_expiry.work_id, first.work_id);
        assert_eq!(after_expiry.attempt, 2);
        assert_ne!(after_expiry.lease_token, first.lease_token);
        assert!(matches!(
            coordinator.claim_work_with_request_id(
                &owner,
                &binding,
                &worker.worker_token,
                "short",
                first.lease_expires_at_ms + 2,
            ),
            Err(AgentHelperError::InvalidLeaseRequest)
        ));
    }

    #[test]
    fn browser_approval_pairs_once_and_never_exposes_an_owner_in_status() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let other_owner = SolverOwner::new("school-b", "admin-b");
        let started = coordinator
            .start_pairing("PC-Primary", "Windows 11", 1_000)
            .unwrap();
        assert_eq!(started.agent_id, "pc-primary");
        assert_eq!(started.agent_name, "Windows 11");
        assert_eq!(started.user_code.len(), 9);
        assert_eq!(started.device_code.len(), 69);
        assert_eq!(started.expires_at_ms, 1_000 + AGENT_PAIR_TTL_MS);
        assert_eq!(started.poll_every_ms, AGENT_PAIR_POLL_MS);
        assert!(matches!(
            coordinator.pairing_status(&started.device_code, 1_001),
            Ok(AgentPairStatus::Pending { .. })
        ));

        let ticket = coordinator
            .begin_pair_approval(&started.user_code.to_ascii_lowercase(), &owner, 1_002)
            .unwrap();
        assert_eq!(ticket.agent_id, "pc-primary");
        assert_eq!(ticket.agent_name, "Windows 11");
        assert_eq!(ticket.expires_at_ms, started.expires_at_ms);
        assert!(matches!(
            coordinator.pairing_status(&started.device_code, 1_003),
            Ok(AgentPairStatus::Pending { .. })
        ));
        assert!(matches!(
            coordinator.begin_pair_approval(&started.user_code, &other_owner, 1_003),
            Err(AgentPairError::AlreadyApproved)
        ));
        assert_eq!(
            coordinator.complete_pair_approval(
                &ticket,
                &other_owner,
                "tkba_wrong-owner",
                9_000,
                1_004,
            ),
            Err(AgentPairError::ApprovalMismatch)
        );

        coordinator
            .complete_pair_approval(&ticket, &owner, "tkba_limited", 9_000, 1_005)
            .unwrap();
        assert_eq!(
            coordinator.pairing_status(&started.device_code, 1_006),
            Ok(AgentPairStatus::Approved {
                agent_token: "tkba_limited".to_string(),
                agent_token_expires_at: 9_000,
                expires_at_ms: started.expires_at_ms,
            })
        );
        assert!(matches!(
            coordinator.begin_pair_approval(&started.user_code, &owner, 1_007),
            Err(AgentPairError::AlreadyApproved)
        ));
    }

    #[test]
    fn pairing_codes_expire_and_failed_credential_creation_can_be_retried() {
        let coordinator = AgentHelperCoordinator::default();
        let owner = SolverOwner::new("school-a", "admin-a");
        let started = coordinator
            .start_pairing("pc-1", "Primary PC", 2_000)
            .unwrap();
        let first_ticket = coordinator
            .begin_pair_approval(&started.user_code, &owner, 2_001)
            .unwrap();
        coordinator.abort_pair_approval(&first_ticket, &owner, 2_002);
        let retry_ticket = coordinator
            .begin_pair_approval(&started.user_code, &owner, 2_003)
            .unwrap();
        assert_ne!(first_ticket.approval_token, retry_ticket.approval_token);

        assert_eq!(
            coordinator.pairing_status(&started.device_code, started.expires_at_ms),
            Err(AgentPairError::Expired)
        );
        assert_eq!(
            coordinator.pairing_status(&started.device_code, started.expires_at_ms + 1),
            Err(AgentPairError::NotFound)
        );
        assert!(matches!(
            coordinator.begin_pair_approval("1234", &owner, 2_004),
            Err(AgentPairError::InvalidRequest)
        ));
        assert_eq!(
            coordinator.pairing_status("not-a-device-secret", 2_004),
            Err(AgentPairError::InvalidRequest)
        );
    }
}
