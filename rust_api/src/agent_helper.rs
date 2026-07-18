use std::collections::{HashMap, HashSet};
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
const MAX_AGENT_PARALLEL_PER_WORKER: usize = 8;
const MAX_AGENT_SEEDS_PER_JOB: usize = 16;
const MAX_WORKER_ID_BYTES: usize = 80;
const MAX_WORKER_NAME_BYTES: usize = 120;

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
struct AgentWorker {
    owner: SolverOwner,
    session_binding: String,
    worker_id: String,
    _name: String,
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
    owner: SolverOwner,
    created_at_ms: u64,
    request_body: Arc<Vec<u8>>,
    tasks: Vec<AgentTask>,
    best_candidate: Option<AgentCandidate>,
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

#[derive(Default)]
struct AgentHelperState {
    workers: HashMap<String, AgentWorker>,
    jobs: HashMap<String, AgentJob>,
    pairings: HashMap<String, AgentPairing>,
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
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        prune_state(&mut state, now_ms);
        state
            .workers
            .values()
            .filter(|worker| worker.owner == *owner && worker.expires_at_ms > now_ms)
            .count()
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
            return existing.owner == *owner;
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
                owner: owner.clone(),
                created_at_ms: now_ms,
                request_body,
                tasks,
                best_candidate: None,
            },
        );
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
        owned
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
        let worker_id = normalize_worker_id(worker_id)?;
        let session_binding = session_binding.trim();
        if session_binding.is_empty() {
            return Err(AgentHelperError::UnauthorizedWorker);
        }
        let name = normalize_worker_name(name, &worker_id);
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
                session_binding: session_binding.to_string(),
                worker_id: worker_id.clone(),
                _name: name,
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
                .filter(|job| job.owner == worker.owner)
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

        // Transport retries carry the same request ID. Resolve that replay
        // before enforcing capacity so the caller gets the exact active lease
        // rather than a second job or a worker-at-capacity response.
        let replay = state
            .jobs
            .iter()
            .filter(|(_, job)| job.owner == worker.owner)
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
            .filter(|(_, job)| job.owner == worker.owner)
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
        Ok(AgentWorkLease {
            work_id: task.work_id.clone(),
            job_id,
            lease_token,
            lease_expires_at_ms,
            seed: task.seed,
            attempt: task.attempt,
            request_body: Arc::clone(&job.request_body),
        })
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
            .filter(|job| job.owner == worker.owner)
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
            .filter(|(_, job)| job.owner == worker.owner)
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
            .filter(|job| job.owner == worker.owner)
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
            let became_best = job
                .best_candidate
                .as_ref()
                .map(|current| candidate.quality < current.quality)
                .unwrap_or(true);
            if became_best {
                job.best_candidate = Some(candidate);
            }
            task.state = AgentTaskState::Completed;
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
            .filter(|job| job.owner == worker.owner)
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
            .filter(|job| job.owner == worker.owner)
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
        self.state
            .lock()
            .ok()?
            .jobs
            .get(job_id)
            .filter(|job| job.owner == *owner)
            .and_then(|job| job.best_candidate.clone())
    }

    pub fn has_active_lease(&self, job_id: &str, owner: &SolverOwner) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .jobs
                    .get(job_id)
                    .filter(|job| job.owner == *owner)
                    .map(|job| {
                        job.tasks
                            .iter()
                            .any(|task| matches!(task.state, AgentTaskState::Leased { .. }))
                    })
            })
            .unwrap_or(false)
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
    let expired_workers = state
        .workers
        .iter()
        .filter(|(_, worker)| worker.expires_at_ms <= now_ms)
        .map(|(token_hash, _)| token_hash.clone())
        .collect::<HashSet<_>>();
    state
        .workers
        .retain(|token_hash, _| !expired_workers.contains(token_hash));
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

        assert_eq!(coordinator.online_worker_count(&owner, 1_000), 1);
        assert_eq!(coordinator.online_worker_count(&other_owner, 1_000), 0);
        assert_eq!(
            coordinator.online_worker_count(&owner, 1_000 + AGENT_WORKER_TTL_MS),
            0
        );
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
        assert!(coordinator.finish_job("job-a", &owner));
        assert!(coordinator.best_candidate("job-a", &owner).is_none());
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
