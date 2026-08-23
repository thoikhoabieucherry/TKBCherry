//! Minimal web host for TKBCherry.
//!
//! Timetable construction and optimisation belong to the browser FET worker.
//! This process intentionally has only three responsibilities:
//! serving static assets, authenticating users, and persisting school data.

mod auth;
mod db;

use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

const APP_VERSION: &str = "tkb-web-fet-v1";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "1010";
const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_STORE_ID_BYTES: usize = 160;

#[derive(Clone)]
struct App {
    root: PathBuf,
    web_root: PathBuf,
    db: Arc<db::Db>,
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    query: String,
    body: Vec<u8>,
    auth_token: Option<String>,
    client_ip: String,
}

fn main() -> std::io::Result<()> {
    let host = env::var("TKB_RUST_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    let port = env::var("TKB_RUST_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_string());
    let root = resolve_app_root()?;
    let web_root = root.join("web");
    if !web_root.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("web root not found: {}", web_root.display()),
        ));
    }

    let db_path = env::var("TKB_DB_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("rust_api").join("tkb_store.db"));
    let db = Arc::new(db::Db::new(db_path).expect("Failed to initialize SQLite store"));
    auth::ensure_super_admin(&db);

    let app = Arc::new(App { root, web_root, db });
    let listener = TcpListener::bind(format!("{host}:{port}"))?;
    if !quiet_logs() {
        println!("TKBCherry web FET: http://{host}:{port}");
        println!("Engine: browser Web Worker");
    }

    for stream in listener.incoming() {
        let app = Arc::clone(&app);
        match stream {
            Ok(stream) => {
                thread::spawn(move || {
                    if let Err(error) = handle_stream(stream, &app) {
                        if !quiet_logs() {
                            eprintln!("request failed: {error}");
                        }
                    }
                });
            }
            Err(error) if !quiet_logs() => eprintln!("accept failed: {error}"),
            Err(_) => {}
        }
    }
    Ok(())
}

fn env_flag(name: &str, default: bool) -> bool {
    let fallback = if default { "1" } else { "0" };
    matches!(
        env::var(name)
            .unwrap_or_else(|_| fallback.to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn quiet_logs() -> bool {
    env_flag("TKB_NO_LOGS", false) || env_flag("TKB_RUST_QUIET", false)
}

fn resolve_app_root() -> std::io::Result<PathBuf> {
    if let Ok(value) = env::var("TKB_APP_ROOT") {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
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
    let current = env::current_dir()?;
    if current.join("web").is_dir() {
        return Ok(current);
    }
    Ok(current.parent().unwrap_or(Path::new(".")).to_path_buf())
}

fn handle_stream(mut stream: TcpStream, app: &App) -> std::io::Result<()> {
    let peer_ip = stream.peer_addr().ok().map(|address| address.ip());
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];

    loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_HTTP_HEADER_BYTES && find_header_end(&buffer).is_none() {
            stream.write_all(&json_response(
                431,
                json!({"ok":false,"error":"request_header_too_large"}),
            ))?;
            return Ok(());
        }

        let Some(header_end) = find_header_end(&buffer) else {
            continue;
        };
        if header_end > MAX_HTTP_HEADER_BYTES {
            stream.write_all(&json_response(
                431,
                json!({"ok":false,"error":"request_header_too_large"}),
            ))?;
            return Ok(());
        }
        let header = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let content_length = parse_content_length(&header);
        if content_length > MAX_HTTP_REQUEST_BODY_BYTES {
            stream.write_all(&json_response(
                413,
                json!({"ok":false,"error":"request_too_large"}),
            ))?;
            return Ok(());
        }
        let body_start = header_end + 4;
        let Some(expected_end) = body_start.checked_add(content_length) else {
            stream.write_all(&json_response(
                413,
                json!({"ok":false,"error":"request_too_large"}),
            ))?;
            return Ok(());
        };
        while buffer.len() < expected_end {
            let count = stream.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..count]);
        }
        if buffer.len() < expected_end {
            stream.write_all(&json_response(
                400,
                json!({"ok":false,"error":"incomplete_request_body"}),
            ))?;
            return Ok(());
        }
        let request = parse_request(&header, &buffer[body_start..expected_end], peer_ip);
        stream.write_all(&route(request, app))?;
        return Ok(());
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> usize {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }).unwrap_or(0)
}

fn parse_auth_token(header: &str) -> Option<String> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("authorization") {
            return None;
        }
        let value = value.trim();
        let token = value.get(7..).filter(|_| value[..7].eq_ignore_ascii_case("bearer "))?;
        (!token.trim().is_empty()).then(|| token.trim().to_string())
    })
}

fn parse_header_ip(header: &str, name: &str, take_last: bool) -> Option<IpAddr> {
    header.lines().find_map(|line| {
        let (header_name, value) = line.split_once(':')?;
        if !header_name.trim().eq_ignore_ascii_case(name) {
            return None;
        }
        let mut values = value.split(',').map(str::trim).filter(|item| !item.is_empty());
        let candidate = if take_last { values.next_back()? } else { values.next()? };
        candidate.parse().ok()
    })
}

fn request_client_ip(header: &str, peer_ip: Option<IpAddr>) -> String {
    let Some(peer_ip) = peer_ip else {
        return "unknown".to_string();
    };
    if !peer_ip.is_loopback() {
        return peer_ip.to_string();
    }
    parse_header_ip(header, "x-real-ip", false)
        .or_else(|| parse_header_ip(header, "x-forwarded-for", true))
        .unwrap_or(peer_ip)
        .to_string()
}

fn parse_request(header: &str, body: &[u8], peer_ip: Option<IpAddr>) -> Request {
    let mut request_line = header.lines().next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_ascii_uppercase();
    let target = request_line.next().unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    Request {
        method,
        path: percent_decode(path),
        query: query.to_string(),
        body: body.to_vec(),
        auth_token: parse_auth_token(header),
        client_ip: request_client_ip(header, peer_ip),
    }
}

fn route(request: Request, app: &App) -> Vec<u8> {
    match (request.method.as_str(), request.path.as_str()) {
        ("OPTIONS", _) => http_response(204, "text/plain; charset=utf-8", &[], ""),
        ("GET", "/api/health") => health_json(app),
        ("GET", "/api/version") => json_response(
            200,
            json!({"ok":true,"version":APP_VERSION,"engine":"fet-web-worker"}),
        ),
        ("POST", "/api/auth/login") => {
            auth::login_json(&app.db, &request.body, &request.client_ip)
        }
        ("POST", "/api/auth/logout") => {
            auth::logout_json(&app.db, request.auth_token.as_deref(), &request.body)
        }
        ("POST", "/api/auth/register") => {
            auth::register_json(&app.db, &request.body, &request.client_ip)
        }
        ("POST", "/api/auth/hash-password") => {
            auth::hash_password_json(&app.db, request.auth_token.as_deref(), &request.body)
        }
        ("GET", "/api/auth/session") => {
            auth_session_get_json(app, &request.query, request.auth_token.as_deref())
        }
        ("GET", "/api/auth/registry") => {
            auth_registry_get_json(app, request.auth_token.as_deref())
        }
        ("POST", "/api/auth/registry") => {
            auth_registry_post_json(app, request.auth_token.as_deref(), &request.body)
        }
        ("GET", "/api/school/store") => {
            school_store_get_json(app, &request.query, request.auth_token.as_deref())
        }
        ("POST", "/api/school/store") => {
            school_store_post_json(app, &request.query, request.auth_token.as_deref(), &request.body)
        }
        ("GET", "/sapxep") | ("GET", "/sapxep/") => {
            redirect_response(308, "/pages/sapxep")
        }
        ("GET", path) => static_file(app, path),
        _ => json_response(404, json!({"ok":false,"error":"not_found"})),
    }
}

fn health_json(app: &App) -> Vec<u8> {
    json_response(
        200,
        json!({
            "ok": true,
            "api": "rust",
            "version": APP_VERSION,
            "architecture": "browser-only",
            "engine": "fet-web-worker",
            "webRoot": app.web_root.to_string_lossy(),
            "appRoot": app.root.to_string_lossy(),
            "capabilities": ["static-web", "auth", "school-store"]
        }),
    )
}

fn auth_session_get_json(app: &App, query: &str, auth_token: Option<&str>) -> Vec<u8> {
    let token = auth_token
        .filter(|token| !token.trim().is_empty())
        .map(str::to_string)
        .or_else(|| query_param(query, "token"))
        .filter(|token| !token.trim().is_empty());
    match token {
        Some(token) => auth::session_json(&app.db, &token),
        None => json_response(401, json!({"ok":false,"error":"missing_token"})),
    }
}

fn auth_registry_get_json(app: &App, auth_token: Option<&str>) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !auth::can_read_registry(&session) {
        return auth::forbidden_response();
    }
    let registry = auth::load_registry(&app.db);
    let scoped = scoped_registry(&registry, &session);
    json_response(200, auth::strip_registry_for_client(scoped))
}

fn auth_registry_post_json(app: &App, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    if !auth::can_write_registry(&session) {
        return auth::forbidden_response();
    }
    let Ok(incoming) = serde_json::from_slice::<Value>(body) else {
        return json_response(400, json!({"ok":false,"error":"invalid_json"}));
    };
    if !incoming.is_object() {
        return json_response(400, json!({"ok":false,"error":"invalid_registry"}));
    }

    let current = auth::load_registry(&app.db);
    let role = session.get("role").and_then(Value::as_str).unwrap_or("");
    let merged = if role == "superadmin" {
        merge_superadmin_registry(&current, incoming)
    } else {
        let Some(school_id) = session.get("schoolId").and_then(Value::as_str) else {
            return auth::forbidden_response();
        };
        match merge_school_registry(&current, &incoming, school_id, &session) {
            Ok(value) => value,
            Err(message) => {
                return json_response(400, json!({"ok":false,"error":message}));
            }
        }
    };

    if !auth::save_registry(&app.db, &merged) {
        return json_response(503, json!({"ok":false,"error":"registry_write_failed"}));
    }
    let scoped = scoped_registry(&merged, &session);
    json_response(
        200,
        json!({"ok":true,"registry":auth::strip_registry_for_client(scoped)}),
    )
}

fn ensure_registry_shape(mut value: Value) -> Value {
    if !value.is_object() {
        value = json!({});
    }
    let root = value.as_object_mut().expect("registry object");
    for key in ["users", "schools", "registeredIps", "otpPending", "blockedIps"] {
        if !root.get(key).is_some_and(Value::is_object) {
            root.insert(key.to_string(), json!({}));
        }
    }
    value
}

fn merge_superadmin_registry(current: &Value, incoming: Value) -> Value {
    let current = ensure_registry_shape(current.clone());
    let mut merged = ensure_registry_shape(incoming);
    auth::restore_user_password_hashes(&current, &mut merged);
    preserve_sensitive_registry_fields(&current, &mut merged);

    let current_super = current
        .get("users")
        .and_then(Value::as_object)
        .and_then(|users| users.get(auth::SUPER_ID))
        .cloned();
    if let Some(current_super) = current_super {
        let users = merged
            .get_mut("users")
            .and_then(Value::as_object_mut)
            .expect("users object");
        let entry = users.entry(auth::SUPER_ID.to_string()).or_insert(current_super.clone());
        if let Some(object) = entry.as_object_mut() {
            object.insert("id".to_string(), json!(auth::SUPER_ID));
            object.insert("role".to_string(), json!("superadmin"));
            if object
                .get("passwordHash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
            {
                if let Some(hash) = current_super.get("passwordHash") {
                    object.insert("passwordHash".to_string(), hash.clone());
                }
            }
        }
    }
    merged
}

fn merge_school_registry(
    current: &Value,
    incoming: &Value,
    school_id: &str,
    session: &Value,
) -> Result<Value, &'static str> {
    let school_id = school_id.trim();
    if school_id.is_empty() {
        return Err("missing_school_id");
    }
    let mut merged = ensure_registry_shape(current.clone());
    let incoming_school = incoming
        .get("schools")
        .and_then(Value::as_object)
        .and_then(|schools| find_case_insensitive(schools, school_id))
        .map(|(_, value)| value.clone());
    if let Some(mut school) = incoming_school {
        if !school.is_object() {
            return Err("invalid_school_record");
        }
        school
            .as_object_mut()
            .expect("school object")
            .insert("id".to_string(), json!(school_id));
        merged
            .get_mut("schools")
            .and_then(Value::as_object_mut)
            .expect("schools object")
            .insert(school_id.to_string(), school);
    }

    let incoming_users = incoming
        .get("users")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let current_users = current
        .get("users")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let session_user = session.get("userId").and_then(Value::as_str).unwrap_or("");
    let target_users = merged
        .get_mut("users")
        .and_then(Value::as_object_mut)
        .expect("users object");

    let removable = target_users
        .iter()
        .filter_map(|(id, user)| {
            let same_school = user
                .get("schoolId")
                .and_then(Value::as_str)
                .is_some_and(|value| value.eq_ignore_ascii_case(school_id));
            (same_school && !id.eq_ignore_ascii_case(session_user)).then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in removable {
        target_users.remove(&id);
    }

    for (id, mut user) in incoming_users {
        let user_school = user.get("schoolId").and_then(Value::as_str).unwrap_or("");
        if !user_school.eq_ignore_ascii_case(school_id) || !user.is_object() {
            continue;
        }
        let role = user.get("role").and_then(Value::as_str).unwrap_or("school_user");
        if !matches!(role, "school_admin" | "school_user") {
            continue;
        }
        let canonical_id = id.trim().to_ascii_lowercase();
        if canonical_id.is_empty() || canonical_id == auth::SUPER_ID {
            continue;
        }
        let existing_other_school = current_users.get(&canonical_id).is_some_and(|existing| {
            existing
                .get("schoolId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.eq_ignore_ascii_case(school_id))
        });
        if existing_other_school {
            continue;
        }
        if let Some(object) = user.as_object_mut() {
            object.insert("id".to_string(), json!(canonical_id));
            object.insert("schoolId".to_string(), json!(school_id));
            if object
                .get("passwordHash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
            {
                if let Some(hash) = current_users
                    .get(&canonical_id)
                    .and_then(|previous| previous.get("passwordHash"))
                {
                    object.insert("passwordHash".to_string(), hash.clone());
                }
            }
        }
        target_users.insert(canonical_id, user);
    }

    if !session_user.is_empty() && !target_users.keys().any(|id| id.eq_ignore_ascii_case(session_user)) {
        if let Some((id, user)) = find_case_insensitive(&current_users, session_user) {
            target_users.insert(id.clone(), user.clone());
        }
    }
    preserve_sensitive_registry_fields(current, &mut merged);
    Ok(merged)
}

fn preserve_sensitive_registry_fields(current: &Value, merged: &mut Value) {
    for root_key in ["registeredIps", "blockedIps"] {
        let missing = merged
            .get(root_key)
            .and_then(Value::as_object)
            .map(Map::is_empty)
            .unwrap_or(true);
        if missing {
            if let Some(value) = current.get(root_key) {
                merged
                    .as_object_mut()
                    .expect("registry object")
                    .insert(root_key.to_string(), value.clone());
            }
        }
    }

    let current_otp = current.get("otpPending").and_then(Value::as_object);
    let next_otp = merged.get_mut("otpPending").and_then(Value::as_object_mut);
    if let (Some(current_otp), Some(next_otp)) = (current_otp, next_otp) {
        for (id, entry) in next_otp.iter_mut() {
            let Some(previous) = current_otp.get(id) else {
                continue;
            };
            let Some(object) = entry.as_object_mut() else {
                continue;
            };
            for field in ["code", "otp"] {
                if !object.contains_key(field) {
                    if let Some(value) = previous.get(field) {
                        object.insert(field.to_string(), value.clone());
                    }
                }
            }
        }
    }
}

fn scoped_registry(registry: &Value, session: &Value) -> Value {
    if session.get("role").and_then(Value::as_str) == Some("superadmin") {
        return ensure_registry_shape(registry.clone());
    }
    let school_id = session.get("schoolId").and_then(Value::as_str).unwrap_or("");
    let mut scoped = ensure_registry_shape(json!({}));
    if school_id.is_empty() {
        return scoped;
    }
    if let Some((id, school)) = registry
        .get("schools")
        .and_then(Value::as_object)
        .and_then(|schools| find_case_insensitive(schools, school_id))
    {
        scoped
            .get_mut("schools")
            .and_then(Value::as_object_mut)
            .expect("schools object")
            .insert(id.clone(), school.clone());
    }
    if let Some(users) = registry.get("users").and_then(Value::as_object) {
        let target = scoped
            .get_mut("users")
            .and_then(Value::as_object_mut)
            .expect("users object");
        for (id, user) in users {
            if user
                .get("schoolId")
                .and_then(Value::as_str)
                .is_some_and(|value| value.eq_ignore_ascii_case(school_id))
            {
                target.insert(id.clone(), user.clone());
            }
        }
    }
    scoped
}

fn find_case_insensitive<'a>(
    values: &'a Map<String, Value>,
    key: &str,
) -> Option<(&'a String, &'a Value)> {
    values.iter().find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
}

fn school_store_get_json(app: &App, query: &str, auth_token: Option<&str>) -> Vec<u8> {
    let Some(store_id) = query_param(query, "id").filter(|value| valid_store_id(value)) else {
        return json_response(400, json!({"ok":false,"error":"invalid_store_id"}));
    };
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    let registry = auth::load_registry(&app.db);
    if !auth::can_access_school_store(&session, &store_id, &registry) {
        return auth::forbidden_response();
    }
    match app.db.get(&format!("school_{store_id}")) {
        Ok(Some(content)) => json_response(
            200,
            serde_json::from_str(&content).unwrap_or_else(|_| json!({})),
        ),
        Ok(None) => json_response(200, json!({})),
        Err(_) => json_response(503, json!({"ok":false,"error":"school_store_read_failed"})),
    }
}

fn school_store_post_json(
    app: &App,
    query: &str,
    auth_token: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    let Some(store_id) = query_param(query, "id").filter(|value| valid_store_id(value)) else {
        return json_response(400, json!({"ok":false,"error":"invalid_store_id"}));
    };
    let Some(session) = auth::require_session(&app.db, auth_token) else {
        return auth::unauthorized_response();
    };
    let registry = auth::load_registry(&app.db);
    if !auth::can_access_school_store(&session, &store_id, &registry) {
        return auth::forbidden_response();
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return json_response(400, json!({"ok":false,"error":"invalid_json"}));
    };
    if !value.is_object() {
        return json_response(400, json!({"ok":false,"error":"school_store_must_be_object"}));
    }
    let Ok(content) = serde_json::to_string(&value) else {
        return json_response(400, json!({"ok":false,"error":"invalid_json"}));
    };
    match app.db.set(&format!("school_{store_id}"), &content) {
        Ok(()) => json_response(200, json!({"ok":true})),
        Err(_) => json_response(503, json!({"ok":false,"error":"school_store_write_failed"})),
    }
}

fn valid_store_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_STORE_ID_BYTES
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(key) == name).then(|| percent_decode(value))
    })
}

fn static_file(app: &App, url_path: &str) -> Vec<u8> {
    let mapped = match url_path {
        "/" => "/index.html",
        "/app" | "/app/" => "/app.html",
        "/school-portal" | "/school-portal/" => "/school-portal.html",
        "/super-admin" | "/super-admin/" => "/super-admin.html",
        "/pages/sapxep" | "/pages/sapxep/" => "/pages/sapxep.html",
        "/pages/phanmon" | "/pages/phanmon/" => "/pages/phanmon.html",
        "/favicon.ico" => "/favicon.svg",
        path => path,
    };
    if mapped.contains('\0') || mapped.contains('\\') || mapped.split('/').any(|part| part == "..") {
        return json_response(400, json!({"ok":false,"error":"invalid_path"}));
    }
    let relative = mapped.trim_start_matches('/');
    let candidate = app.web_root.join(relative);
    let root = match app.web_root.canonicalize() {
        Ok(path) => path,
        Err(_) => return json_response(500, json!({"ok":false,"error":"web_root_unavailable"})),
    };
    let candidate = match candidate.canonicalize() {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
        _ => return json_response(404, json!({"ok":false,"error":"not_found"})),
    };
    match fs::read(&candidate) {
        Ok(body) => http_response(200, content_type(&candidate), &body, static_cache_header(&candidate)),
        Err(_) => json_response(404, json!({"ok":false,"error":"not_found"})),
    }
}

fn static_cache_header(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("") {
        "html" => "Cache-Control: no-store, max-age=0\r\n",
        _ => "Cache-Control: public, max-age=3600\r\n",
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
}

fn json_response(status: u16, value: Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"json_encode_failed"}"#.to_vec());
    http_response(status, "application/json; charset=utf-8", &body, "Cache-Control: no-store, max-age=0\r\n")
}

fn http_response(status: u16, content_type: &str, body: &[u8], cache_header: &str) -> Vec<u8> {
    let reason = status_reason(status);
    let cors_origin = env::var("TKB_CORS_ORIGIN").unwrap_or_else(|_| "*".to_string());
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{cache_header}X-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nPermissions-Policy: camera=(), microphone=(), geolocation=()\r\nAccess-Control-Allow-Origin: {cors_origin}\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut response = header.into_bytes();
    response.extend_from_slice(body);
    response
}

fn redirect_response(status: u16, location: &str) -> Vec<u8> {
    let header = format!(
        "HTTP/1.1 {status} {}\r\nLocation: {location}\r\nContent-Length: 0\r\nCache-Control: no-store, max-age=0\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        status_reason(status)
    );
    header.into_bytes()
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    }
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
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_nibble(bytes[index + 1]), hex_nibble(bytes[index + 2])) {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_paths_and_query_values() {
        assert_eq!(percent_decode("Tr%C6%B0%E1%BB%9Dng+1"), "Trường 1");
    }

    #[test]
    fn store_ids_are_bounded_and_file_safe() {
        assert!(valid_store_id("sch01-tkb_2.2026"));
        assert!(!valid_store_id("../tkb_store"));
        assert!(!valid_store_id("school/one"));
        assert!(!valid_store_id(""));
    }

    #[test]
    fn request_parser_reads_bearer_and_proxy_ip() {
        let request = parse_request(
            "GET /api/health?q=1 HTTP/1.1\r\nAuthorization: Bearer abc\r\nX-Real-IP: 203.0.113.8\r\n",
            &[],
            Some("127.0.0.1".parse().unwrap()),
        );
        assert_eq!(request.path, "/api/health");
        assert_eq!(request.query, "q=1");
        assert_eq!(request.auth_token.as_deref(), Some("abc"));
        assert_eq!(request.client_ip, "203.0.113.8");
    }

    #[test]
    fn school_scope_never_exposes_another_school() {
        let registry = json!({
            "schools": {"a":{"id":"a"}, "b":{"id":"b"}},
            "users": {
                "ua":{"id":"ua","schoolId":"a","passwordHash":"secret"},
                "ub":{"id":"ub","schoolId":"b","passwordHash":"secret"}
            }
        });
        let session = json!({"role":"school_admin","schoolId":"a","userId":"ua"});
        let scoped = auth::strip_registry_for_client(scoped_registry(&registry, &session));
        assert!(scoped["schools"].get("a").is_some());
        assert!(scoped["schools"].get("b").is_none());
        assert!(scoped["users"].get("ua").is_some());
        assert!(scoped["users"].get("ub").is_none());
        assert!(scoped["users"]["ua"].get("passwordHash").is_none());
    }

    #[test]
    fn school_merge_preserves_other_tenants_and_passwords() {
        let current = json!({
            "schools":{"a":{"id":"a","name":"Old"},"b":{"id":"b","name":"Keep"}},
            "users":{
                "ua":{"id":"ua","schoolId":"a","role":"school_admin","passwordHash":"hash-a"},
                "ub":{"id":"ub","schoolId":"b","role":"school_admin","passwordHash":"hash-b"}
            }
        });
        let incoming = json!({
            "schools":{"a":{"id":"different","name":"New"}},
            "users":{"ua":{"id":"ua","schoolId":"a","role":"school_admin"}}
        });
        let session = json!({"role":"school_admin","schoolId":"a","userId":"ua"});
        let merged = merge_school_registry(&current, &incoming, "a", &session).unwrap();
        assert_eq!(merged["schools"]["a"]["id"], json!("a"));
        assert_eq!(merged["schools"]["a"]["name"], json!("New"));
        assert_eq!(merged["schools"]["b"]["name"], json!("Keep"));
        assert_eq!(merged["users"]["ua"]["passwordHash"], json!("hash-a"));
        assert_eq!(merged["users"]["ub"]["passwordHash"], json!("hash-b"));
    }
}
