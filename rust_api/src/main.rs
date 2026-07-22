use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{panic, panic::AssertUnwindSafe};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

mod agent_helper;
mod auth;
mod db;
mod jsonlite;
mod native_precheck;
mod native_solver;
mod solver_pool;

const VERSION: &str = "tkb_new-rust-api-2026-07-22-session-modes-sac-fallback-v58";
const REFERENCE_STDIO_PROTOCOL: &str = "tkb-reference-solver-stdio-v1";
const REFERENCE_PROGRESS_PROTOCOL: &str = "tkb-reference-solver-progress-v1";
const REFERENCE_PROGRESS_PREFIX: &str = "@@TKB_PROGRESS@@";
const MAX_REFERENCE_PROGRESS_FRAME_BYTES: usize = 32 * 1024;
const AGENT_HELPER_PROTOCOL: &str = "tkb-agent-helper-v1";
const AGENT_RESULT_DIGEST_PROTOCOL: &str = "tkb-json-tree-sha256-v1";
// v1.6.23 detects Smart App Control before loading native solver DLLs and
// leaves the canonical job for the VPS on affected unsigned installations.
// Older binaries remain upgrade-only so they cannot trigger repeated blocks.
const MIN_AGENT_HELPER_VERSION: &str = "1.6.23";
const MIN_AGENT_HELPER_SEMVER: (u32, u32, u32) = (1, 6, 23);
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
const UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS: u64 = 10_000;
// Once the helper has announced a successful terminal result, computation is
// already complete. Give it a small, bounded window to flush the JSON wrapper
// and exit instead of replacing that finished timetable with a watchdog 422.
const REFERENCE_TERMINAL_RESULT_GRACE_MS: u64 = 10_000;
const REFERENCE_CANDIDATE_VALIDATION_TIMEOUT_MS: u64 = 15_000;

struct ManagedChild(Child);

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
    AgentJobExecution, AgentLeaseHeartbeat, AgentPairError, AgentPairStatus, AgentWorkLease,
    AGENT_IDLE_RETRY_MS,
};
use solver_pool::{
    job_id_from_cancel_body, job_id_from_solve_body, ServerJobClaim, ServerJobSnapshot,
    SolverAdmission,
    ServerExecutionFence, ServerExecutionPhase, ServerExecutor, SolverJobGuard, SolverOwner,
    SolverPool, MAX_SERVER_WATCHDOG_MS, MAX_UNRESOLVED_SERVER_JOBS,
    MAX_UNRESOLVED_SERVER_JOBS_PER_OWNER,
};

#[derive(Clone)]
struct App {
    root: PathBuf,
    web_root: PathBuf,
    sample_data: PathBuf,
    solver_pool: Arc<SolverPool>,
    agent_helper: Arc<AgentHelperCoordinator>,
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
            let header = String::from_utf8_lossy(&buffer[..header_end]).to_string();
            let content_length = parse_content_length(&header);
            let body_start = header_end + 4;
            while buffer.len() < body_start + content_length {
                let n = stream.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..n]);
            }
            let body_end = (body_start + content_length).min(buffer.len());
            let request = parse_request(&header, &buffer[body_start..body_end], peer_ip);
            let response = route(request, app);
            stream.write_all(&response)?;
            return Ok(());
        }

        if buffer.len() > 16 * 1024 * 1024 {
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
        ("GET", "/api/solver-state") => {
            with_solver_owner(app, req.auth_token.as_deref(), |owner| {
                solver_state_json(app, &req.query, owner)
            })
        }
        ("GET", "/api/solve-result") => {
            with_solver_owner(app, req.auth_token.as_deref(), |owner| {
                solve_result_json(app, &req.query, owner)
            })
        }
        ("GET", "/api/agent-helper/v1/status") => {
            agent_helper_status_json(app, req.auth_token.as_deref())
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
        ("POST", "/api/solve-data") => with_solver_owner(app, req.auth_token.as_deref(), |owner| {
            solve_json(app, &req.body, owner)
        }),
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

fn agent_helper_context(
    app: &App,
    auth_token: Option<&str>,
) -> Result<(SolverOwner, String), Vec<u8>> {
    let token = auth_token.map(str::trim).filter(|value| !value.is_empty());
    let Some(session) = auth::require_session(&app.db, token)
        .or_else(|| auth::require_agent_credential(&app.db, token))
    else {
        return Err(auth::unauthorized_response());
    };
    let owner = solver_owner_from_session(&session).ok_or_else(auth::forbidden_response)?;
    Ok((owner, agent_session_binding(token.unwrap_or_default())))
}

fn agent_helper_bootstrap_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    // Only a live browser session may mint an Agent credential. Agent
    // credentials themselves cannot mint more credentials or access any
    // non-Agent API.
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if solver_owner_from_session(&session).is_none() {
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

fn agent_helper_status_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    // This is deliberately a browser-session endpoint. It exposes only an
    // owner-scoped online count and never returns Agent identifiers or tokens.
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    let Some(owner) = solver_owner_from_session(&session) else {
        return auth::forbidden_response();
    };
    let checked_at_ms = now_millis();
    let agent_count = app.agent_helper.online_worker_count(&owner, checked_at_ms);
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "online": agent_count > 0,
            "agentCount": agent_count,
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
        .clamp(1, 256)
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

fn agent_helper_body_version(body: &Value) -> &str {
    body.get("agent")
        .and_then(Value::as_object)
        .and_then(|agent| agent.get("version"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn agent_helper_upgrade_required_json() -> Vec<u8> {
    json_response(
        426,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": false,
            "kind": "agent_upgrade_required",
            "error": "agent_upgrade_required",
            "minimumAgentVersion": MIN_AGENT_HELPER_VERSION,
            "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip"
        }),
    )
}

fn agent_helper_upgrade_wait_json() -> Vec<u8> {
    json_response(
        200,
        json!({
            "protocol": AGENT_HELPER_PROTOCOL,
            "ok": true,
            "lease": Value::Null,
            "retryAfterMs": AGENT_IDLE_RETRY_MS,
            "agentEligible": false,
            "upgradeRequired": true,
            "minimumAgentVersion": MIN_AGENT_HELPER_VERSION,
            "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip"
        }),
    )
}

fn agent_helper_hello_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let (owner, session_binding) = match agent_helper_context(app, auth_token) {
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
    let Some(version_semver) = parse_agent_helper_semver(version) else {
        app.agent_helper.revoke_worker_identity(
            &owner,
            &session_binding,
            agent_id,
            now_millis(),
        );
        return agent_helper_upgrade_required_json();
    };
    let platform = agent
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = format!("{} {}", platform.trim(), version.trim());
    if version_semver < MIN_AGENT_HELPER_SEMVER {
        return match app.agent_helper.register_upgrade_worker(
            &owner,
            &session_binding,
            agent_id,
            &name,
            agent_helper_parallel(&body),
            now_millis(),
        ) {
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
                    "upgradeRequired": true,
                    "minimumAgentVersion": MIN_AGENT_HELPER_VERSION,
                    "downloadUrl": "/downloads/TKBCherryAgent-Windows.zip",
                    "handoffJobIds": []
                }),
            ),
            Err(error) => agent_helper_error_json(error),
        };
    }
    match app.agent_helper.register_worker(
        &owner,
        &session_binding,
        agent_id,
        &name,
        agent_helper_parallel(&body),
        now_millis(),
    ) {
        Ok(registration) => {
            // A fresh hello is the explicit signal that an Agent is available.
            // Mark any VPS-owned canonical jobs for handoff while holding the
            // solver-pool fence; the coordinator will only expose a lease once
            // the local child has exited and its guard has been dropped.
            let handoff_jobs = app.solver_pool.request_agent_handoff_for_owner(&owner);
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
                    "agentEligible": true,
                    "upgradeRequired": false,
                    "minimumAgentVersion": MIN_AGENT_HELPER_VERSION,
                    "handoffJobIds": handoff_jobs
                }),
            )
        }
        Err(error) => agent_helper_error_json(error),
    }
}

fn agent_helper_heartbeat_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let (owner, session_binding) = match agent_helper_context(app, auth_token) {
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
    match app
        .agent_helper
        .heartbeat(&owner, &session_binding, &worker_token, &[], now_millis())
    {
        Ok(result) => json_response(
            200,
            json!({
                "protocol": AGENT_HELPER_PROTOCOL,
                "ok": true,
                "workerExpiresAtMs": result.worker_expires_at_ms,
                "renewedLeaseIds": [],
                "lostLeaseIds": []
            }),
        ),
        Err(error) => agent_helper_error_json(error),
    }
}

fn agent_helper_claim_payload(lease: AgentWorkLease, cpu_workers: usize) -> Value {
    let mut request = serde_json::from_slice::<Value>(&lease.request_body)
        .unwrap_or_else(|_| json!({"data":{}, "settings":{}}));
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
                "cpuWorkers": cpu_workers,
                "timeoutSeconds": MAX_SOLVER_DEADLINE_MS / 1_000
            }
        }
    })
}

fn agent_helper_claim_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let (owner, session_binding) = match agent_helper_context(app, auth_token) {
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
    if !agent_helper_version_supported(version) {
        if parse_agent_helper_semver(version).is_some()
            && app.agent_helper.worker_eligibility(
                &owner,
                &session_binding,
                &worker_token,
                now_millis(),
            ) == Some(false)
        {
            return agent_helper_upgrade_wait_json();
        }
        app.agent_helper.revoke_worker_token(
            &owner,
            &session_binding,
            &worker_token,
            now_millis(),
        );
        return agent_helper_upgrade_required_json();
    }
    let cpu_workers = agent_helper_capacity(&body);
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
    loop {
        match app.agent_helper.claim_work_with_request_id(
            &owner,
            &session_binding,
            &worker_token,
            lease_request_id,
            now_millis(),
        ) {
            Ok(lease) => {
                if app
                    .solver_pool
                    .server_job_known_for_owner(&lease.job_id, &owner)
                    && app
                        .solver_pool
                        .server_job_cancel_requested(&lease.job_id, &owner)
                {
                    let _ = app.agent_helper.finish_job(&lease.job_id, &owner);
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
                return json_response(200, agent_helper_claim_payload(lease, cpu_workers));
            }
            Err(AgentHelperError::NoWork) if Instant::now() < wait_deadline => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(AgentHelperError::NoWork) => {
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
    let (owner, session_binding) = match agent_helper_context(app, auth_token) {
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
        return json_response(
            202,
            json!({"protocol":AGENT_HELPER_PROTOCOL,"ok":true,"completed":true}),
        );
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
        .server_job_cancel_requested(&ticket.job_id, &owner)
    {
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
        "heartbeat" => {
            let lease = AgentLeaseHeartbeat {
                work_id,
                lease_token: lease_id.to_string(),
            };
            match app.agent_helper.heartbeat(
                &owner,
                &session_binding,
                &worker_token,
                &[lease],
                now_ms,
            ) {
                Ok(result) => json_response(
                    200,
                    json!({
                        "protocol": AGENT_HELPER_PROTOCOL,
                        "ok": true,
                        "cancel": false,
                        "renewed": !result.renewed_work_ids.is_empty(),
                        "workerExpiresAtMs": result.worker_expires_at_ms
                    }),
                ),
                Err(error) => agent_helper_error_json(error),
            }
        }
        "candidate" => {
            let solver_status = body.get("solverStatus").and_then(Value::as_u64);
            let status_is_structured = solver_status.is_some_and(|status| {
                (200..300).contains(&status) || matches!(status, 409 | 422 | 500)
            });
            if body.get("solverProtocol").and_then(Value::as_str) != Some(REFERENCE_STDIO_PROTOCOL)
                || body.get("digestProtocol").and_then(Value::as_str)
                    != Some(AGENT_RESULT_DIGEST_PROTOCOL)
                || !status_is_structured
            {
                let _ = app.agent_helper.reject_submission(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_millis(),
                );
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
                let _ = app.agent_helper.reject_submission(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_millis(),
                );
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
                let _ = app.agent_helper.reject_submission(
                    &owner,
                    &session_binding,
                    &worker_token,
                    &work_id,
                    lease_id,
                    now_millis(),
                );
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
            let became_best = if (200..300).contains(&solver_status) {
                let mut validated =
                    match native_solver::validate_agent_candidate(&ticket.request_body, result) {
                        Ok(value) => value,
                        Err(_) => {
                            let _ = app.agent_helper.reject_submission(
                                &owner,
                                &session_binding,
                                &worker_token,
                                &work_id,
                                lease_id,
                                now_millis(),
                            );
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
                if request_has_active_tkb_constraints(&ticket.request_body) {
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
                            let _ = app.agent_helper.reject_submission(
                                &owner,
                                &session_binding,
                                &worker_token,
                                &work_id,
                                lease_id,
                                now_millis(),
                            );
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
                match app.agent_helper.accept_submission(
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
        "fail" => match app.agent_helper.reject_submission(
            &owner,
            &session_binding,
            &worker_token,
            &work_id,
            lease_id,
            now_ms,
        ) {
            Ok(()) => json_response(
                202,
                json!({"protocol":AGENT_HELPER_PROTOCOL,"ok":true,"requeued":true}),
            ),
            Err(error) => agent_helper_error_json(error),
        },
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

fn update_school_user_record(current_user: &mut Value, incoming_user: &Value, allow_active: bool) {
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
        .and_then(|schools| schools.get(school_id));
    if let (Some(current_school), Some(incoming_school)) = (
        merged
            .get_mut("schools")
            .and_then(Value::as_object_mut)
            .and_then(|schools| schools.get_mut(school_id)),
        incoming_school,
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

    for (id, incoming_user) in &incoming_users {
        let Some(existing) = users.get_mut(id) else {
            continue;
        };
        if existing.get("schoolId").and_then(Value::as_str) != Some(school_id) {
            continue;
        }
        let role = existing.get("role").and_then(Value::as_str).unwrap_or("");
        let may_edit = role == "school_user" || (role == "school_admin" && id == session_user_id);
        if may_edit {
            update_school_user_record(existing, incoming_user, role == "school_user");
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

    if additive_post {
        merge_union_object(current, &mut merged, "otpPending");
        merge_union_object(current, &mut merged, "blockedIps");
    }

    prune_deleted_school_ip_blocks(&mut merged, &deleted_schools);

    merged
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
    let key = format!("school_{id}");
    if let Ok(content) = String::from_utf8(body.to_vec()) {
        if let Ok(_value) = serde_json::from_str::<Value>(&content) {
            let _ = app.db.set(&key, &content);
            return json_response(200, json!({"ok": true}));
        }
    }
    json_response(400, json!({"ok": false, "error": "invalid_json"}))
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

fn server_job_started_at_for_owner(
    app: &App,
    job_id: &str,
    owner: &SolverOwner,
) -> Option<u64> {
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
                "desiredWorkers": desired_workers
            })
        })
        .collect::<Vec<_>>();
    for server_job in server_jobs
        .iter()
        .filter(|job| job.completed_ms.is_none())
    {
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
            "allocatedWorkers": 0
        }));
    }
    let requested_job_active = !requested_job_id.is_empty()
        && jobs.iter().any(|job| {
            job.get("jobId").and_then(Value::as_str) == Some(requested_job_id.as_str())
        });
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
                "executionGeneration": job.execution_generation
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
            "requestedJobHandoffInProgress": requested_server_job.is_some_and(|job| job.execution_phase.handoff_in_progress())
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
            server_job
                .as_ref()
                .and_then(server_job_started_at_ms),
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
    let canonical_started_at_ms = server_job
        .as_ref()
        .and_then(server_job_started_at_ms);
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
             "retryAfterMs": 250
        }),
    )
}

fn solve_cancel_json(app: &App, body: &[u8], owner: &SolverOwner) -> Vec<u8> {
    let job_id = job_id_from_cancel_body(body);
    let cancelled = if job_id.is_empty() {
        false
    } else {
        app.solver_pool.cancel_job_for_owner(&job_id, owner)
    };
    json_response(
        200,
        json!({
            "ok": true,
            "cancelRequested": cancelled,
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

/// Cached PWA documents can keep an older automatic 60-75 second ceiling even
/// after the server and solver contract have moved on. Large fixed-anchor first
/// solves need enough time to produce one complete timetable; a blank automatic
/// duration may therefore be raised server-side, while an explicit user duration
/// remains authoritative. The solver still returns as soon as its quality gate is
/// met, so this is a ceiling rather than a forced wait.
fn automatic_large_fresh_budget_floor_ms(request: &Value) -> u64 {
    let settings = request_settings(request);
    let has_subject_period_rules = request
        .get("data")
        .and_then(|data| data.get("tkbConstraints"))
        .is_some_and(has_subject_period_requirement);
    let solve_kind = setting_string(settings, "ui_unified_solve_kind")
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .unwrap_or_default();
    let automatic_large = setting_bool(settings, "ui_unified_auto_sort", false)
        && setting_u64_allow_zero(settings, "ui_custom_solve_duration_seconds", 0) == 0
        && setting_u64_allow_zero(settings, "expected_scheduled_periods", 0) >= 900;
    let automatic_fresh = solve_kind == "fresh_complete_first";
    // v1.53 PWA tabs could misclassify localized lessonBlocks Min debt as a
    // constraint repair. Keep that stale-client request on the same robust
    // fixed-anchor budget until the refreshed bridge supplies the stable kind.
    let stale_subject_period_fresh = solve_kind == "repair_constraints"
        && has_subject_period_rules;
    if !automatic_large || (!automatic_fresh && !stale_subject_period_fresh) {
        return 0;
    }
    if has_subject_period_rules {
        180_000
    } else {
        130_000
    }
}

fn reference_solver_budget(request: &Value) -> ReferenceBudget {
    let settings = request_settings(request);
    let automatic_floor_ms = automatic_large_fresh_budget_floor_ms(request);
    let backend_ms = clamped_solver_deadline_ms(
        settings,
        "backend_deadline_ms",
        DEFAULT_SOLVER_DEADLINE_MS,
    )
    .max(automatic_floor_ms);
    let native_ms = clamped_solver_deadline_ms(settings, "native_global_deadline_ms", backend_ms)
        .max(automatic_floor_ms);
    // A server-owned handoff may inject the remaining canonical watchdog into
    // the request. Treat it as an upper bound on both the helper and native
    // lanes; otherwise a VPS -> Agent retry would silently restore the full
    // per-request deadline.
    let requested_watchdog_cap_ms =
        setting_u64_allow_zero(settings, "reference_watchdog_deadline_ms", 0);
    let watchdog_cap_ms = (requested_watchdog_cap_ms > 0).then_some(
        requested_watchdog_cap_ms.clamp(MIN_SOLVER_DEADLINE_MS, MAX_SERVER_WATCHDOG_MS),
    );
    let effective_backend_ms = backend_ms.min(watchdog_cap_ms.unwrap_or(MAX_SERVER_WATCHDOG_MS));
    let effective_native_ms = native_ms.min(watchdog_cap_ms.unwrap_or(MAX_SERVER_WATCHDOG_MS));
    // The watchdog is an end-to-end budget.  When a request is handed from
    // the VPS to an Agent (or back), leave the configured serialization/
    // upload reserve outside the child solver deadline.  Previously the
    // watchdog cap was applied before adding the reserve, so a 120-second
    // remaining lease gave the child the full 120 seconds and its complete
    // JSON result was killed at the boundary.
    let effective_compute_ceiling_ms = backend_ms.min(native_ms);
    if uses_unified_reference_compute_budget(settings) {
        let requested_watchdog_reserve = setting_u64(
            settings,
            "ui_unified_reference_watchdog_reserve_ms",
            UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS,
        )
        .clamp(UNIFIED_REFERENCE_WATCHDOG_RESERVE_MS, 10_000);
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
) {
    let current = settings.get(key).and_then(value_as_positive_u64);
    if insert_when_missing || current.is_some() {
        settings.insert(
            key.to_string(),
            json!(current.unwrap_or(cap_seconds).min(cap_seconds)),
        );
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
        cap_seconds_setting(items, "overall_time_limit_seconds", solver_seconds, true);
        cap_seconds_setting(items, "integrated_time_limit", solver_seconds, false);
        cap_seconds_setting(
            items,
            "optimization_time_limit_seconds",
            solver_seconds,
            false,
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
    }
    serde_json::to_vec(&normalized).unwrap_or_else(|_| body.to_vec())
}

/// Clamp every solver-facing deadline in a canonical request to the remaining
/// server watchdog. The same body is used when the job is handed to an Agent,
/// while the parsed value is passed to the VPS solver, so neither executor can
/// silently restart the original full budget.
fn server_request_with_remaining_watchdog(request: &Value, remaining_ms: u64) -> Value {
    let cap_ms = remaining_ms
        .clamp(MIN_SOLVER_DEADLINE_MS, MAX_SERVER_WATCHDOG_MS);
    let cap_seconds = (cap_ms / 1_000).max(1);
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
            json!(if current > 0 { current.min(cap_ms) } else { cap_ms }),
        );
    }
    let reserve = setting_u64_allow_zero(Some(settings), "native_deadline_reserve_ms", 0)
        .min(cap_ms.saturating_sub(MIN_SOLVER_DEADLINE_MS));
    settings.insert("native_deadline_reserve_ms".to_string(), json!(reserve));
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
    if let Some((status, payload)) = complete_existing_incumbent_payload(
        request,
        "server_watchdog_exhausted",
        "canonical server watchdog budget exhausted",
    ) {
        if let Ok(mut payload) = serde_json::from_str::<Value>(&payload) {
            let runtime = ensure_object_child(&mut payload, "solver")
                .entry("runtime_settings".to_string())
                .or_insert_with(|| json!({}));
            if !runtime.is_object() {
                *runtime = json!({});
            }
            if let Some(runtime) = runtime.as_object_mut() {
                runtime.insert("phase".to_string(), json!("server_watchdog_incumbent_fallback"));
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

/// A solver response is safe to keep after the watchdog boundary only when it
/// is an actual successful, complete hard-valid schedule. Metrics alone are
/// not enough: a failed/partial response can still report a stale incumbent.
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
    if remaining_watchdog_ms.is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS)
        && !server_response_complete(&response)
    {
        server_watchdog_timeout_response(request)
    } else {
        response
    }
}

fn reference_payload_usable_partial(payload: &Value) -> bool {
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

fn unified_complete_refinement_requested(settings: Option<&serde_json::Map<String, Value>>) -> bool {
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
    expected > 0
        && scheduled == expected
        && lesson_count == expected
        && unassigned_count == 0
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
            json!("existing_optimize_incumbent_fallback"),
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
        runtime.insert("deadline_hit".to_string(), json!(false));
        runtime.insert("optimization_noop_safe_fallback".to_string(), json!(true));
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
            "kind": "existing_optimize_incumbent_fallback",
            "message": "Thu toi uu lich hien tai khong tao duoc phuong an an toan; da giu nguyen lich dang day du."
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
    let usable_partial = reference_payload_usable_partial(&payload);
    let elapsed = started.elapsed();
    let deadline_hit = elapsed >= deadline || reference_payload_reports_timeout(&payload);
    let timeout_best_effort = best_effort_allowed && deadline_hit && usable_partial && !complete;

    if out_status == 200 && require_complete && !complete && !timeout_best_effort {
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
            json!(deadline_hit && (complete || timeout_best_effort)),
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
            !matches!(normalized.as_str(), "" | "0" | "false" | "off" | "no" | "none" | "null")
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
        .is_some_and(|constraints| constraint_value_active(&constraints))
}

fn run_reference_candidate_validator(
    app: &App,
    request_body: &[u8],
    candidate: &Value,
) -> Result<Value, String> {
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

    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("failed to poll reference candidate validator: {error}"))?
            .is_some()
        {
            break;
        }
        if started.elapsed() >= Duration::from_millis(REFERENCE_CANDIDATE_VALIDATION_TIMEOUT_MS) {
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

fn run_reference_solver(
    app: &App,
    body: &[u8],
    request: &Value,
    job_id: &str,
    cancel_requested: &AtomicBool,
    allocated_workers: usize,
) -> Result<(u16, String), String> {
    let Some(script) = reference_solver_script(app) else {
        return Err("reference solver script not found".to_string());
    };
    let python = reference_python_command();
    let budget = reference_solver_budget(request);
    let deadline = reference_solver_deadline(request);
    let helper_body = reference_solver_body(body, request, budget, allocated_workers);
    let started = Instant::now();
    let mut child = ManagedChild(
        Command::new(&python)
            .arg(&script)
            .arg("solve")
            .current_dir(script.parent().and_then(Path::parent).unwrap_or(&app.root))
            .env("PYTHONIOENCODING", "utf-8")
            .env("TKB_SOLVER_MAX_WORKERS", allocated_workers.to_string())
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
                        progress_pool.update_server_job_progress(&progress_job_id, progress);
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

    loop {
        if cancel_requested.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Ok(reference_cancelled_payload(request, started));
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
                return Ok(result);
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

    decode_reference_solver_stdout(&stdout, request, started, deadline).map_err(|err| {
        format!(
            "reference solver returned invalid JSON: {err}; stderr={}",
            stderr.trim()
        )
    })
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

fn solver_response_with_progress(
    response: Vec<u8>,
    progress: Option<&Value>,
    progress_updated_ms: Option<u64>,
    started_at_ms: Option<u64>,
) -> Vec<u8> {
    if progress.is_none() && started_at_ms.is_none() {
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
    json_response(status, Value::Object(payload.clone()))
}

enum ServerCoordinatorStart {
    Vps {
        fence: ServerExecutionFence,
        initial_guard: Option<SolverJobGuard>,
    },
    Agent {
        fence: ServerExecutionFence,
    },
}

fn cleanup_server_owned_job(app: &App, job_id: &str, owner: &SolverOwner) {
    app.agent_helper.finish_job(job_id, owner);
    app.solver_pool.abandon_server_job(job_id, owner);
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
    let background_app = app.clone();
    let cleanup_job_id = job_id.clone();
    let cleanup_owner = owner.clone();
    thread::Builder::new()
        .name("tkb-server-solver".to_string())
        .spawn(move || {
            let mut mode = start;
            loop {
                if background_app
                    .solver_pool
                    .server_job_cancel_requested(&job_id, &owner)
                {
                    cleanup_server_owned_job(&background_app, &job_id, &owner);
                    return;
                }

                match mode {
                    ServerCoordinatorStart::Vps {
                        fence,
                        mut initial_guard,
                    } => {
                        let job_guard = loop {
                            if request.is_some()
                                && background_app
                                    .solver_pool
                                    .server_job_watchdog_remaining_ms(
                                        &job_id,
                                        &owner,
                                        now_millis(),
                                    )
                                    .is_some_and(|remaining_ms| {
                                        remaining_ms < MIN_SOLVER_DEADLINE_MS
                                    })
                            {
                                let response = server_watchdog_timeout_response(
                                    request.as_ref().expect("watchdog request is present"),
                                );
                                if background_app.solver_pool.complete_server_job_fenced(
                                    fence, &job_id, &owner, response,
                                ) {
                                    background_app.agent_helper.finish_job(&job_id, &owner);
                                    return;
                                }
                            }
                            if background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner)
                            {
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                                return;
                            }
                            if !background_app.solver_pool.execution_fence_current(
                                fence, &job_id, &owner,
                            ) {
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
                                    if background_app.solver_pool.mark_vps_execution_running(
                                        fence, &job_id, &owner,
                                    ) {
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
                                mode = ServerCoordinatorStart::Agent {
                                    fence: agent_fence,
                                };
                                continue;
                            }
                            if background_app
                                .solver_pool
                                .server_job_cancel_requested(&job_id, &owner)
                            {
                                cleanup_server_owned_job(&background_app, &job_id, &owner);
                            }
                            return;
                        };

                        let remaining_watchdog_ms = background_app
                            .solver_pool
                            .server_job_watchdog_remaining_ms(
                                &job_id,
                                &owner,
                                now_millis(),
                            );
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
                                .server_job_watchdog_remaining_ms(
                                    &job_id,
                                    &owner,
                                    now_millis(),
                                );
                            server_watchdog_final_response(
                                request,
                                response,
                                remaining_watchdog_ms,
                            )
                        } else {
                            response
                        };

                        // The child process has been killed/waited by the solver
                        // path before it returns. Drop the CPU guard as the last
                        // local-executor step, then expose Agent work.
                        drop(job_guard);
                        if background_app.solver_pool.complete_server_job_fenced(
                            fence, &job_id, &owner, response,
                        ) {
                            background_app.agent_helper.finish_job(&job_id, &owner);
                            return;
                        }
                        if let Some(agent_fence) = background_app
                            .solver_pool
                            .prepare_agent_execution(&job_id, &owner)
                        {
                            mode = ServerCoordinatorStart::Agent {
                                fence: agent_fence,
                            };
                            continue;
                        }
                        if background_app
                            .solver_pool
                            .server_job_cancel_requested(&job_id, &owner)
                        {
                            cleanup_server_owned_job(&background_app, &job_id, &owner);
                        }
                        return;
                    }
                    ServerCoordinatorStart::Agent { fence } => {
                        // No Agent task exists while a VPS child is alive. This
                        // registration point is therefore the strict handoff
                        // boundary in both the initial-Agent and VPS->Agent path.
                        let remaining_watchdog_ms = background_app
                            .solver_pool
                            .server_job_watchdog_remaining_ms(
                                &job_id,
                                &owner,
                                now_millis(),
                            );
                        if request.is_some()
                            && remaining_watchdog_ms
                                .is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS)
                        {
                            let response = server_watchdog_timeout_response(
                                request.as_ref().expect("watchdog request is present"),
                            );
                            if background_app.solver_pool.complete_server_job_fenced(
                                fence, &job_id, &owner, response,
                            ) {
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
                        if !background_app.agent_helper.register_job(
                            &job_id,
                            &owner,
                            agent_body,
                            AGENT_HELPER_SEEDS_PER_JOB,
                            now_millis(),
                        ) {
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
                            if !background_app.solver_pool.execution_fence_current(
                                fence, &job_id, &owner,
                            ) {
                                break None;
                            }
                            let remaining_watchdog_ms = request.as_ref().and_then(|_| {
                                background_app
                                    .solver_pool
                                    .server_job_watchdog_remaining_ms(
                                        &job_id,
                                        &owner,
                                        now_millis(),
                                    )
                            });
                            let watchdog_expired = request.is_some()
                                && remaining_watchdog_ms
                                    .is_some_and(|remaining_ms| remaining_ms < MIN_SOLVER_DEADLINE_MS);
                            // A candidate that has already passed validation wins the
                            // boundary race; every other state remains watchdog-bounded.
                            match background_app.agent_helper.job_execution(
                                &job_id,
                                &owner,
                                now_millis(),
                            ) {
                                Some(AgentJobExecution::Completed {
                                    candidate: Some(candidate),
                                }) => {
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
                                _ if watchdog_expired => {
                                    // Close the Agent task while holding its
                                    // coordinator lock. A candidate accepted
                                    // after the snapshot above but before this
                                    // terminal fence must win over the timeout;
                                    // after the close, no late submission can
                                    // race a second HTTP result into this job.
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
                                Some(AgentJobExecution::Leased { .. }) => {
                                    lease_started = true;
                                    let _ = background_app
                                        .solver_pool
                                        .mark_agent_execution_running(fence, &job_id, &owner);
                                }
                                Some(AgentJobExecution::Completed { candidate: None }) => {
                                    break None;
                                }
                                Some(AgentJobExecution::Queued)
                                    if lease_started
                                        || waiting_since.elapsed()
                                            >= Duration::from_millis(AGENT_CLAIM_GRACE_MS) =>
                                {
                                    break None;
                                }
                                Some(AgentJobExecution::Queued) => {}
                                None => break None,
                            }
                            thread::sleep(Duration::from_millis(100));
                        };

                        if let Some(response) = agent_response {
                            if background_app.solver_pool.complete_server_job_fenced(
                                fence, &job_id, &owner, response,
                            ) {
                                background_app.agent_helper.finish_job(&job_id, &owner);
                                return;
                            }
                        }
                        // Remove the Agent task atomically only after confirming
                        // that no fresh lease won the expiry race. If a worker
                        // reclaimed it in the meantime, keep waiting on that
                        // same task instead of starting a VPS child beside it.
                        if !background_app
                            .agent_helper
                            .take_over_for_vps(&job_id, &owner, now_millis())
                        {
                            mode = ServerCoordinatorStart::Agent { fence };
                            continue;
                        }
                        let Some(vps_fence) = background_app
                            .solver_pool
                            .fallback_agent_to_vps(fence, &job_id, &owner)
                        else {
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

fn solve_json(app: &App, body: &[u8], owner: &SolverOwner) -> Vec<u8> {
    let job_id = job_id_from_solve_body(body, now_millis());
    let shared_body = Arc::new(body.to_vec());
    let request = serde_json::from_slice::<Value>(body).ok();
    let schedule_scope = solver_schedule_scope(request.as_ref());
    let schedule_fingerprint = solver_schedule_fingerprint(request.as_ref());
    let progress_budget_seconds = solver_progress_budget_seconds(request.as_ref());
    let progress_run_index = solver_progress_run_index(request.as_ref());
    let server_watchdog_budget_ms = request
        .as_ref()
        .map(|request| reference_solver_budget(request).hard_ms);
    let desired_workers = app.solver_pool.desired_workers(request.as_ref());
    let supports_fifo_admission = request
        .as_ref()
        .map(|request| setting_bool(request_settings(request), "ui_solver_fifo_admission", false))
        .unwrap_or(false);
    let server_owned = supports_fifo_admission
        && request
            .as_ref()
            .map(|request| setting_bool(request_settings(request), "ui_solver_async_job", false))
            .unwrap_or(false);
    let mut server_execution_fence = None;
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
            ServerJobClaim::Claimed => {}
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

        if app.agent_helper.online_worker_count(owner, now_millis()) > 0 {
            let Some(fence) = app
                .solver_pool
                .prepare_agent_execution(&job_id, owner)
            else {
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
            if let Some(fence) = app
                .solver_pool
                .prepare_agent_execution(&job_id, owner)
            {
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
                        fence: server_execution_fence
                            .expect("server-owned VPS fence exists"),
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
                        fence: server_execution_fence
                            .expect("server-owned VPS fence exists"),
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
                if let Some(fence) = app
                    .solver_pool
                    .prepare_agent_execution(&job_id, owner)
                {
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
    solve_admitted_json(app, body, request.as_ref(), &job_guard)
}

fn solve_admitted_json(
    app: &App,
    body: &[u8],
    request: Option<&Value>,
    job_guard: &SolverJobGuard,
) -> Vec<u8> {
    let cancel_requested = &job_guard.job.cancel_requested;
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
                allocated_workers,
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
                        complete_existing_incumbent_payload(
                            request,
                            "reference_solver_error",
                            &err,
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
        Ok(bytes) => http_response(200, content_type(&path), &bytes),
        Err(_) => json_response(404, json!({"ok": false, "error": "not_found"})),
    }
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
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nPermissions-Policy: camera=(), microphone=(), geolocation=()\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
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
                "admina": {"id":"admina", "role":"superadmin", "schoolId":"school-b", "passwordHash":password_hash},
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
        (
            App {
                root: PathBuf::new(),
                web_root: PathBuf::new(),
                sample_data: PathBuf::new(),
                solver_pool: SolverPool::from_env(),
                agent_helper: AgentHelperCoordinator::new(),
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

    fn agent_get_route(app: &App, token: Option<&str>, path: &str) -> Vec<u8> {
        route(
            Request {
                method: "GET".to_string(),
                path: path.to_string(),
                query: String::new(),
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
    fn browser_agent_status_is_authenticated_live_and_owner_scoped() {
        let (app, session_token, _) = agent_test_app();
        let unauthorized = agent_get_route(&app, None, "/api/agent-helper/v1/status");
        assert_eq!(response_status(&unauthorized), 401);

        let offline = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(offline["online"], json!(false));
        assert_eq!(offline["agentCount"], json!(0));

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

        let online = response_payload(&agent_get_route(
            &app,
            Some(&session_token),
            "/api/agent-helper/v1/status",
        ));
        assert_eq!(online["protocol"], json!(AGENT_HELPER_PROTOCOL));
        assert_eq!(online["online"], json!(true));
        assert_eq!(online["agentCount"], json!(1));
        assert_eq!(
            online["staleAfterMs"],
            json!(agent_helper::AGENT_WORKER_TTL_MS)
        );

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
    }

    #[test]
    fn agent_capacity_allows_modern_high_core_windows_hosts() {
        assert_eq!(
            agent_helper_capacity(&json!({"capacity":{"cpuWorkers":22}})),
            22
        );
        assert_eq!(
            agent_helper_capacity(&json!({"capacity":{"cpuWorkers":999}})),
            256
        );
    }

    #[test]
    fn agent_helper_version_gate_uses_strict_three_component_semver() {
        for version in ["1.6.23", "1.7.0", "2.0.0"] {
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
        assert_eq!(app.agent_helper.online_worker_count(&owner, now_millis()), 0);
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
        assert_eq!(
            downgraded_payload["kind"],
            json!("agent_upgrade_required")
        );
        assert_eq!(
            downgraded_payload["minimumAgentVersion"],
            json!(MIN_AGENT_HELPER_VERSION)
        );
        assert_eq!(app.agent_helper.online_worker_count(&owner, now_millis()), 0);

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

        let request = agent_solver_request("agent-route-job");
        let request_body = Arc::new(serde_json::to_vec(&request).unwrap());
        assert_eq!(
            app.solver_pool.claim_server_job("agent-route-job", &owner),
            ServerJobClaim::Claimed
        );
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
        assert!(payload.get("jobs").is_none());
        assert!(payload.get("queue").is_none());
        assert!(payload.get("owner").is_none());
    }

    #[test]
    fn solver_state_and_cancel_are_scoped_to_the_authenticated_owner() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
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
    fn solver_state_and_result_expose_live_progress_for_owned_jobs() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
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

        let owner_state = solver_state_json(
            &app,
            "jobId=agent-only-canonical",
            &owner,
        );
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
                jobs.iter().find(|job| {
                    job["jobId"] == json!("agent-only-canonical")
                })
            })
            .expect("Agent-owned canonical job must stay visible after reload");
        assert_eq!(visible_job["serverOwned"], json!(true));
        assert_eq!(visible_job["executor"], json!("agent"));
        assert_eq!(visible_job["startedAtMs"], json!(canonical_started_at_ms));

        let cancelled = solve_cancel_json(
            &app,
            br#"{"jobId":"agent-only-canonical"}"#,
            &owner,
        );
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
    fn online_agent_that_never_claims_falls_back_to_vps_on_the_same_job() {
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

        let request = async_preserved_request("agent-unclaimed-fallback");
        let started = solve_json(&app, request.to_string().as_bytes(), &owner);
        assert_eq!(response_status(&started), 202);
        assert_eq!(response_payload(&started)["executor"], json!("agent"));
        let canonical_started_at_ms = response_payload(&started)["startedAtMs"]
            .as_u64()
            .expect("fallback job must have a canonical startedAtMs");
        assert_eq!(app.solver_pool.active_count(), 0);

        let completed = wait_for_server_result(&app, "agent-unclaimed-fallback", &owner);
        assert_eq!(response_status(&completed), 200);
        assert_eq!(
            response_payload(&completed)["startedAtMs"],
            json!(canonical_started_at_ms),
            "Agent-to-VPS fallback must preserve the canonical start timestamp"
        );
        assert_eq!(app.solver_pool.active_count(), 0);
        assert!(app
            .solver_pool
            .completed_server_response_for_owner("agent-unclaimed-fallback", &owner)
            .is_some());
        app.solver_pool
            .abandon_server_job("agent-unclaimed-fallback", &owner);
    }

    #[test]
    fn server_owned_job_caps_return_http_429_before_spawning_more_threads() {
        let app = App {
            root: PathBuf::new(),
            web_root: PathBuf::new(),
            sample_data: PathBuf::new(),
            solver_pool: SolverPool::from_env(),
            agent_helper: AgentHelperCoordinator::new(),
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
            assert_eq!(budget.hard_ms, 190_000);
            assert_eq!(budget.reserve_ms, 10_000);

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
                json!(190_000)
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
        assert_eq!(budget.hard_ms, 190_000);
        assert_eq!(solver_progress_budget_seconds(Some(&constrained)), Some(180));

        let mut cached_v153_repair = constrained.clone();
        cached_v153_repair["settings"]["ui_unified_solve_kind"] =
            json!("repair_constraints");
        let cached_budget = reference_solver_budget(&cached_v153_repair);
        assert_eq!(cached_budget.solver_ms, 180_000);
        assert_eq!(cached_budget.hard_ms, 190_000);
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
        assert_eq!(plain_budget.solver_ms, 130_000);
        assert_eq!(plain_budget.hard_ms, 140_000);
        assert_eq!(solver_progress_budget_seconds(Some(&plain)), Some(130));
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
                "expected_scheduled_periods": 1566,
                "backend_deadline_ms": 60_000,
                "native_global_deadline_ms": 60_000,
                "overall_time_limit_seconds": 60
            }
        });
        let budget = reference_solver_budget(&request);
        assert_eq!(budget.solver_ms, 60_000);
        assert_eq!(budget.hard_ms, 70_000);
        assert_eq!(solver_progress_budget_seconds(Some(&request)), Some(60));

        let mut cached_v153_repair = request.clone();
        cached_v153_repair["settings"]["ui_unified_solve_kind"] =
            json!("repair_constraints");
        let cached_budget = reference_solver_budget(&cached_v153_repair);
        assert_eq!(cached_budget.solver_ms, 60_000);
        assert_eq!(cached_budget.hard_ms, 70_000);
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
        assert_eq!(budget.solver_ms, 110_000);
        assert_eq!(budget.reserve_ms, 10_000);

        let body = serde_json::to_vec(&request).expect("request body");
        let helper: Value =
            serde_json::from_slice(&reference_solver_body(&body, &request, budget, 3))
                .expect("helper body");
        assert_eq!(helper["settings"]["overall_time_limit_seconds"], json!(110));
        assert_eq!(
            helper["settings"]["reference_watchdog_deadline_ms"],
            json!(120_000)
        );
    }

    #[test]
    fn reference_helper_uses_the_exact_allocated_worker_count() {
        let request = json!({
            "settings": {
                "num_workers": 1,
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
            lease_token: "lease-convergence".to_string(),
            lease_expires_at_ms: 1,
            seed: 7,
            attempt: 1,
            request_body: Arc::new(serde_json::to_vec(&request).expect("request")),
        };
        let payload = agent_helper_claim_payload(lease, 4);
        assert_eq!(
            payload["lease"]["limits"]["timeoutSeconds"],
            json!(MAX_SOLVER_DEADLINE_MS / 1_000)
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
        assert_eq!(settings.get("native_global_deadline_ms"), Some(&json!(37_500)));
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
        let capped_body = server_request_body_with_remaining_watchdog(
            &body,
            Some(&request),
            37_500,
        );
        let decoded: Value = serde_json::from_slice(&capped_body).expect("capped body");
        assert_eq!(
            decoded["settings"]["reference_watchdog_deadline_ms"],
            json!(37_500)
        );
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
}
