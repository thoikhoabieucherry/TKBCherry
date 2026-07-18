use std::collections::HashMap;
use std::env;
use std::fmt::Write as FmtWrite;
use std::io;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db::Db;

pub const SUPER_ID: &str = "suadmin";
const SESSION_TTL_SECS: u64 = 86_400;
const AGENT_CREDENTIAL_TTL_SECS: u64 = 90 * 86_400;
const LOGIN_MAX_ATTEMPTS: u32 = 12;
const LOGIN_WINDOW_SECS: u64 = 900;

struct LoginLimiter {
    attempts: HashMap<String, (u32, u64)>,
}

static LOGIN_LIMITER: LazyLock<Mutex<LoginLimiter>> = LazyLock::new(|| {
    Mutex::new(LoginLimiter {
        attempts: HashMap::new(),
    })
});
// Serializes the active-session check and session creation so two simultaneous
// login requests cannot both claim the same non-superadmin account.
static SESSION_LOGIN_GUARD: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
// Registration reads and rewrites one registry document. Serialize the whole
// check-and-create transaction so two simultaneous requests cannot both claim
// the same IP/login/email and overwrite each other's registry changes.
static REGISTRATION_GUARD: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn legacy_sha256_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn hash_password(password: &str) -> String {
    let mut salt_bytes = [0_u8; 16];
    fill_os_random(&mut salt_bytes).expect("operating-system CSPRNG unavailable");
    let salt = SaltString::encode_b64(&salt_bytes).expect("valid Argon2 salt");
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("Argon2id password hashing failed")
        .to_string()
}

fn verify_password(password: &str, stored_hash: &str) -> bool {
    let stored_hash = stored_hash.trim();
    if stored_hash.starts_with("$argon2") {
        return PasswordHash::new(stored_hash).ok().is_some_and(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        });
    }
    !stored_hash.is_empty() && stored_hash == legacy_sha256_password(password)
}

fn password_hash_needs_upgrade(stored_hash: &str) -> bool {
    !stored_hash.trim().starts_with("$argon2id$")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
    // SAFETY: BCryptGenRandom writes exactly `buffer_len` bytes into the valid
    // mutable slice. A null algorithm handle is required with the system RNG flag.
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
compile_error!("TKB authentication requires an operating-system CSPRNG");

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    fill_os_random(&mut bytes).expect("operating-system CSPRNG unavailable");
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
    }
    token
}

pub fn ensure_super_admin(db: &Db) {
    let mut reg = load_registry(db);
    if !reg.is_object() {
        reg = json!({});
    }
    {
        let root = reg.as_object_mut().expect("registry object");
        if !root.contains_key("users") {
            root.insert("users".to_string(), json!({}));
        }
        if !root.contains_key("schools") {
            root.insert("schools".to_string(), json!({}));
        }
        if !root.contains_key("registeredIps") {
            root.insert("registeredIps".to_string(), json!({}));
        }
        if !root.contains_key("otpPending") {
            root.insert("otpPending".to_string(), json!({}));
        }
    }

    let users = reg
        .as_object_mut()
        .and_then(|root| root.get_mut("users"))
        .and_then(Value::as_object_mut);
    let Some(users) = users else {
        return;
    };

    let needs_bootstrap = !users.contains_key(SUPER_ID)
        || users
            .get(SUPER_ID)
            .and_then(|u| u.get("passwordHash"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty();

    if !needs_bootstrap {
        return;
    }

    let password = env::var("TKB_SUPER_PASSWORD").unwrap_or_default();
    let password = if password.trim().is_empty() {
        let generated = format!("TKB-{}", &random_token()[..12]);
        if !quiet_auth_logs() {
            eprintln!(
                "[TKB Auth] Chưa có super admin. Mật khẩu tạm: {generated}\n\
                 Đặt TKB_SUPER_PASSWORD trong .env để dùng mật khẩu cố định."
            );
        }
        generated
    } else {
        password
    };

    let hash = hash_password(password.trim());
    let entry = json!({
        "id": SUPER_ID,
        "passwordHash": hash,
        "role": "superadmin",
        "displayName": "Super Admin",
        "active": true,
        "emailVerified": true,
        "createdAt": chrono_like_now()
    });
    users.insert(SUPER_ID.to_string(), entry);
    let _ = save_registry(db, &reg);
}

fn chrono_like_now() -> String {
    // ISO-8601-ish without extra deps
    format!("{}", now_secs())
}

fn quiet_auth_logs() -> bool {
    matches!(
        env::var("TKB_NO_LOGS")
            .or_else(|_| env::var("TKB_RUST_QUIET"))
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "on" | "yes"
    )
}

pub fn load_registry(db: &Db) -> Value {
    db.get("auth_registry")
        .ok()
        .flatten()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}))
}

pub fn save_registry(db: &Db, reg: &Value) -> bool {
    db.set(
        "auth_registry",
        &serde_json::to_string(reg).unwrap_or_else(|_| "{}".to_string()),
    )
    .is_ok()
}

pub fn strip_registry_for_client(mut reg: Value) -> Value {
    if let Some(users) = reg
        .as_object_mut()
        .and_then(|root| root.get_mut("users"))
        .and_then(Value::as_object_mut)
    {
        for user in users.values_mut() {
            if let Some(obj) = user.as_object_mut() {
                obj.remove("passwordHash");
            }
        }
    }
    if let Some(otp) = reg
        .as_object_mut()
        .and_then(|root| root.get_mut("otpPending"))
        .and_then(Value::as_object_mut)
    {
        for entry in otp.values_mut() {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("code");
                obj.remove("otp");
            }
        }
    }
    reg
}

pub fn restore_user_password_hashes(current: &Value, merged: &mut Value) {
    let current_users = current
        .get("users")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let Some(next_users) = merged
        .as_object_mut()
        .and_then(|root| root.get_mut("users"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };

    for (id, user) in next_users.iter_mut() {
        let next_hash = user
            .get("passwordHash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !next_hash.is_empty() {
            continue;
        }
        if let Some(prev) = current_users.get(id) {
            if let Some(prev_hash) = prev.get("passwordHash").and_then(Value::as_str) {
                if !prev_hash.is_empty() {
                    if let Some(obj) = user.as_object_mut() {
                        obj.insert("passwordHash".to_string(), json!(prev_hash));
                    }
                }
            }
        }
    }
}

fn login_blocked(ip: &str) -> bool {
    let ip = ip.trim();
    if ip.is_empty() {
        return false;
    }
    let now = now_secs();
    let mut guard = LOGIN_LIMITER.lock().unwrap();
    if let Some((count, since)) = guard.attempts.get(ip).copied() {
        if now.saturating_sub(since) > LOGIN_WINDOW_SECS {
            guard.attempts.remove(ip);
            return false;
        }
        return count >= LOGIN_MAX_ATTEMPTS;
    }
    false
}

fn record_login_failure(ip: &str) {
    let ip = ip.trim();
    if ip.is_empty() {
        return;
    }
    let now = now_secs();
    let mut guard = LOGIN_LIMITER.lock().unwrap();
    let entry = guard.attempts.entry(ip.to_string()).or_insert((0, now));
    if now.saturating_sub(entry.1) > LOGIN_WINDOW_SECS {
        *entry = (1, now);
    } else {
        entry.0 += 1;
    }
}

fn clear_login_failures(ip: &str) {
    let ip = ip.trim();
    if ip.is_empty() {
        return;
    }
    let mut guard = LOGIN_LIMITER.lock().unwrap();
    guard.attempts.remove(ip);
}

fn find_user(reg: &Value, login_id: &str) -> Option<(String, Value)> {
    let raw = login_id.trim();
    if raw.is_empty() {
        return None;
    }
    let users = reg.get("users").and_then(Value::as_object)?;
    let canonical = raw.to_ascii_lowercase();
    if let Some(user) = users.get(&canonical) {
        return Some((canonical, user.clone()));
    }
    if let Some(user) = users.get(raw) {
        return Some((raw.to_string(), user.clone()));
    }
    users.iter().find_map(|(key, user)| {
        let uid = user.get("id").and_then(Value::as_str).unwrap_or("");
        if uid.eq_ignore_ascii_case(raw) {
            Some((key.clone(), user.clone()))
        } else {
            None
        }
    })
}

fn is_ip_blocked(reg: &Value, ip: &str) -> bool {
    let ip = ip.trim();
    if ip.is_empty() {
        return false;
    }
    reg.get("blockedIps")
        .and_then(Value::as_object)
        .and_then(|items| items.get(ip))
        .is_some()
}

fn session_key(token: &str) -> String {
    format!("auth_session:{token}")
}

fn agent_credential_key(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"tkb-agent-credential-v1\0");
    hasher.update(token.trim().as_bytes());
    format!("auth_agent_credential:{:x}", hasher.finalize())
}

fn active_session_key(user_key: &str) -> String {
    format!("auth_active_session:{user_key}")
}

fn is_superadmin_session(session: &Value) -> bool {
    session.get("userId").and_then(Value::as_str) == Some(SUPER_ID)
}

fn session_has_expired(session: &Value) -> bool {
    let Some(expires) = session.get("expiresAt").and_then(Value::as_u64) else {
        return true;
    };
    expires == 0 || now_secs() >= expires
}

fn clear_active_session_if_matches(db: &Db, user_key: &str, token: &str) {
    if user_key.trim().is_empty() || token.trim().is_empty() {
        return;
    }
    let key = active_session_key(user_key);
    let _ = db.clear_if_matches(&key, token.trim());
}

fn active_session_exists(db: &Db, user_key: &str) -> rusqlite::Result<bool> {
    let key = active_session_key(user_key);
    let token = db.get(&key)?.unwrap_or_default();
    let token = token.trim();
    if token.is_empty() {
        return Ok(false);
    }

    let raw = db.get(&session_key(token))?.unwrap_or_default();
    let session = serde_json::from_str::<Value>(&raw).ok();
    let valid = session.as_ref().is_some_and(|value| {
        !session_has_expired(value) && value.get("userId").and_then(Value::as_str) == Some(user_key)
    });
    if !valid {
        db.clear_if_matches(&key, token)?;
    }
    Ok(valid)
}

fn session_is_active(db: &Db, token: &str, session: &Value) -> bool {
    if is_superadmin_session(session) {
        return true;
    }
    let user_key = session
        .get("userId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if user_key.is_empty() {
        return false;
    }
    let _session_login_guard = SESSION_LOGIN_GUARD.lock().unwrap();
    let key = active_session_key(user_key);
    if db.claim_if_empty(&key, token.trim()).unwrap_or(false) {
        // Seamlessly adopt sessions issued before single-login enforcement was
        // deployed. The first old session used becomes the sole active one.
        return true;
    }
    db.get(&key)
        .ok()
        .flatten()
        .is_some_and(|current| current.trim() == token.trim())
}

pub fn create_session(db: &Db, user_key: &str, user: &Value) -> Option<String> {
    let token = random_token();
    let expires = now_secs().saturating_add(SESSION_TTL_SECS);
    let payload = json!({
        "userId": user_key,
        "role": user.get("role").cloned().unwrap_or(json!("")),
        "schoolId": user.get("schoolId").cloned().unwrap_or(json!("")),
        "displayName": user.get("displayName").cloned().unwrap_or(json!(user_key)),
        "expiresAt": expires
    });
    if db
        .set(
            &session_key(&token),
            &serde_json::to_string(&payload).unwrap_or_default(),
        )
        .is_err()
    {
        return None;
    }
    if !is_superadmin_session(&payload) {
        match db.claim_if_empty(&active_session_key(user_key), &token) {
            Ok(true) => {}
            Ok(false) | Err(_) => {
                let _ = db.set(&session_key(&token), "");
                return None;
            }
        }
    }
    Some(token)
}

/// Issues a durable bearer that can only be accepted by Agent Helper routes.
/// It is intentionally stored outside the normal single-login session index,
/// so closing or renewing the browser session cannot stop a running Agent.
pub fn create_agent_credential(db: &Db, session: &Value) -> Option<(String, u64)> {
    let user_key = session.get("userId").and_then(Value::as_str)?.trim();
    let school_id = session
        .get("schoolId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if user_key.is_empty() && school_id.is_empty() {
        return None;
    }
    let token = format!("tkba_{}", random_token());
    let expires_at = now_secs().saturating_add(AGENT_CREDENTIAL_TTL_SECS);
    let payload = json!({
        "scope": "agent_helper",
        "userId": user_key,
        "schoolId": school_id,
        "displayName": session
            .get("displayName")
            .cloned()
            .unwrap_or(json!(user_key)),
        "issuedAt": now_secs(),
        "expiresAt": expires_at
    });
    db.set(
        &agent_credential_key(&token),
        &serde_json::to_string(&payload).ok()?,
    )
    .ok()?;
    Some((token, expires_at))
}

/// Validates the limited Agent bearer without adopting it as a browser login.
pub fn require_agent_credential(db: &Db, token: Option<&str>) -> Option<Value> {
    let token = token?.trim();
    if !token.starts_with("tkba_") || token.len() > 512 {
        return None;
    }
    let key = agent_credential_key(token);
    let raw = db.get(&key).ok().flatten()?;
    let credential: Value = serde_json::from_str(&raw).ok()?;
    if credential.get("scope").and_then(Value::as_str) != Some("agent_helper")
        || session_has_expired(&credential)
    {
        let _ = db.set(&key, "");
        return None;
    }
    Some(credential)
}

pub fn login_json(db: &Db, body: &[u8], request_ip: &str) -> Vec<u8> {
    let parsed = match serde_json::from_slice::<Value>(body) {
        Ok(v) => v,
        Err(_) => {
            return json_bytes(
                400,
                json!({"ok": false, "message": "Dữ liệu đăng nhập không hợp lệ."}),
            )
        }
    };

    let login_id = parsed
        .get("loginId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let password = parsed.get("password").and_then(Value::as_str).unwrap_or("");
    let client_ip = request_ip.trim();

    if login_id.is_empty() || password.is_empty() {
        return json_bytes(
            400,
            json!({"ok": false, "message": "Nhập đầy đủ tài khoản và mật khẩu."}),
        );
    }

    if login_blocked(client_ip) {
        return json_bytes(
            429,
            json!({"ok": false, "message": "Quá nhiều lần đăng nhập sai. Thử lại sau."}),
        );
    }

    let mut reg = load_registry(db);
    if is_ip_blocked(&reg, client_ip) {
        return json_bytes(
            403,
            json!({"ok": false, "message": "IP của bạn đã bị khóa. Liên hệ quản trị."}),
        );
    }

    let Some((user_key, user)) = find_user(&reg, login_id) else {
        record_login_failure(client_ip);
        return json_bytes(
            401,
            json!({"ok": false, "message": "Tài khoản không tồn tại."}),
        );
    };

    if user.get("active") == Some(&Value::Bool(false)) {
        return json_bytes(
            403,
            json!({"ok": false, "message": "Tài khoản đã bị khóa. Liên hệ quản trị."}),
        );
    }

    let stored_hash = user
        .get("passwordHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !verify_password(password, stored_hash) {
        record_login_failure(client_ip);
        return json_bytes(401, json!({"ok": false, "message": "Mật khẩu không đúng."}));
    }

    // Existing installations stored unsalted SHA-256 hashes. Upgrade only after
    // a successful login so no password reset or bulk migration is required.
    if password_hash_needs_upgrade(stored_hash) {
        let upgraded_hash = hash_password(password);
        if let Some(registry_user) = reg
            .get_mut("users")
            .and_then(Value::as_object_mut)
            .and_then(|users| users.get_mut(&user_key))
            .and_then(Value::as_object_mut)
        {
            registry_user.insert("passwordHash".to_string(), json!(upgraded_hash));
            let _ = save_registry(db, &reg);
        }
    }

    let role = user.get("role").and_then(Value::as_str).unwrap_or("");
    let school_id = user.get("schoolId").and_then(Value::as_str).unwrap_or("");
    if role != "superadmin" {
        if let Some(school) = reg.get("schools").and_then(|s| s.get(school_id)) {
            if school.get("active") == Some(&Value::Bool(false)) {
                return json_bytes(
                    403,
                    json!({"ok": false, "message": "Trường đã bị khóa. Liên hệ quản trị."}),
                );
            }
        }
    }

    clear_login_failures(client_ip);
    let _session_login_guard = SESSION_LOGIN_GUARD.lock().unwrap();
    if user_key != SUPER_ID && active_session_exists(db, &user_key).unwrap_or(true) {
        return json_bytes(
            409,
            json!({
                "ok": false,
                "error": "account_already_logged_in",
                "message": "Tài khoản này đang được đăng nhập ở nơi khác. Hãy đăng xuất phiên hiện tại trước."
            }),
        );
    }
    let Some(token) = create_session(db, &user_key, &user) else {
        return json_bytes(
            500,
            json!({"ok": false, "message": "Không tạo được phiên đăng nhập."}),
        );
    };

    json_bytes(
        200,
        json!({
            "ok": true,
            "sessionToken": token,
            "role": role,
            "schoolId": school_id,
            "user": {
                "id": user_key,
                "role": role,
                "schoolId": school_id,
                "displayName": user.get("displayName").cloned().unwrap_or(json!(user_key))
            }
        }),
    )
}

pub fn session_json(db: &Db, token: &str) -> Vec<u8> {
    let token = token.trim();
    if token.is_empty() {
        return json_bytes(401, json!({"ok": false, "error": "missing_token"}));
    }
    let raw = match db.get(&session_key(token)) {
        Ok(Some(v)) => v,
        _ => {
            return json_bytes(401, json!({"ok": false, "error": "invalid_session"}));
        }
    };
    let session: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => {
            return json_bytes(401, json!({"ok": false, "error": "invalid_session"}));
        }
    };
    if session_has_expired(&session) {
        let _ = db.set(&session_key(token), "");
        let user_key = session.get("userId").and_then(Value::as_str).unwrap_or("");
        clear_active_session_if_matches(db, user_key, token);
        return json_bytes(401, json!({"ok": false, "error": "session_expired"}));
    }
    if !session_is_active(db, token, &session) {
        let _ = db.set(&session_key(token), "");
        return json_bytes(401, json!({"ok": false, "error": "invalid_session"}));
    }
    json_bytes(200, json!({"ok": true, "session": session}))
}

pub fn hash_password_json(db: &Db, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    if require_session(db, auth_token).is_none() {
        return unauthorized_response();
    }
    let parsed = serde_json::from_slice::<Value>(body).unwrap_or(json!({}));
    let password = parsed.get("password").and_then(Value::as_str).unwrap_or("");
    if password.is_empty() {
        return json_bytes(400, json!({"ok": false, "error": "empty_password"}));
    }
    json_bytes(
        200,
        json!({"ok": true, "passwordHash": hash_password(password)}),
    )
}

fn json_bytes(status: u16, payload: Value) -> Vec<u8> {
    let body = serde_json::to_vec(&payload)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"json_encode_failed"}"#.to_vec());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store, max-age=0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(&body);
    out
}

pub fn unauthorized_response() -> Vec<u8> {
    json_bytes(
        401,
        json!({"ok": false, "error": "auth_required", "message": "Yêu cầu đăng nhập."}),
    )
}

pub fn forbidden_response() -> Vec<u8> {
    json_bytes(
        403,
        json!({"ok": false, "error": "forbidden", "message": "Không có quyền truy cập."}),
    )
}

pub fn require_session(db: &Db, auth_token: Option<&str>) -> Option<Value> {
    let token = auth_token?.trim();
    if token.is_empty() {
        return None;
    }
    let raw = db.get(&session_key(token)).ok().flatten()?;
    let session: Value = serde_json::from_str(&raw).ok()?;
    if session_has_expired(&session) {
        let _ = db.set(&session_key(token), "");
        let user_key = session.get("userId").and_then(Value::as_str).unwrap_or("");
        clear_active_session_if_matches(db, user_key, token);
        return None;
    }
    if !session_is_active(db, token, &session) {
        let _ = db.set(&session_key(token), "");
        return None;
    }
    Some(session)
}

pub fn can_read_registry(session: &Value) -> bool {
    matches!(
        session.get("role").and_then(Value::as_str),
        Some("superadmin") | Some("school_admin") | Some("school_user")
    )
}

pub fn can_write_registry(session: &Value) -> bool {
    matches!(
        session.get("role").and_then(Value::as_str),
        Some("superadmin") | Some("school_admin")
    )
}

fn sanitize_store_id(raw: &str) -> String {
    raw.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

pub fn can_access_school_store(session: &Value, store_id: &str, reg: &Value) -> bool {
    let role = session.get("role").and_then(Value::as_str).unwrap_or("");
    if role == "superadmin" {
        return true;
    }
    let user_school = session
        .get("schoolId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if user_school.is_empty() {
        return false;
    }
    let target = sanitize_store_id(store_id);
    if target.is_empty() {
        return false;
    }
    if sanitize_store_id(user_school) == target {
        return true;
    }
    let schools = reg.get("schools").and_then(Value::as_object);
    let Some(school) = schools.and_then(|items| items.get(user_school)) else {
        return false;
    };
    if let Some(short) = school.get("shortId").and_then(Value::as_str) {
        let short_clean = sanitize_store_id(short);
        if !short_clean.is_empty() && target.starts_with(&short_clean) {
            return true;
        }
    }
    if let Some(schedules) = school.get("schedules").and_then(Value::as_array) {
        for item in schedules {
            if let Some(sid) = item.get("sid").and_then(Value::as_str) {
                if sanitize_store_id(sid) == target {
                    return true;
                }
            }
        }
    }
    sanitize_store_id(user_school) == target
}

pub fn logout_json(db: &Db, auth_token: Option<&str>, body: &[u8]) -> Vec<u8> {
    let token = auth_token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| {
            serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| {
                    v.get("sessionToken")
                        .and_then(Value::as_str)
                        .map(|s| s.trim().to_string())
                })
                .filter(|t| !t.is_empty())
        });
    if let Some(token) = token {
        let session = db
            .get(&session_key(&token))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let _ = db.set(&session_key(&token), "");
        if let Some(session) = session {
            if !is_superadmin_session(&session) {
                let user_key = session.get("userId").and_then(Value::as_str).unwrap_or("");
                clear_active_session_if_matches(db, user_key, &token);
            }
        }
    }
    json_bytes(200, json!({"ok": true}))
}

fn random_short_id(len: usize) -> String {
    let seed = random_token();
    seed.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(len.max(6))
        .collect()
}

fn generate_school_id(reg: &Value) -> String {
    let schools = reg.get("schools").and_then(Value::as_object);
    for _ in 0..40 {
        let id = format!("sch{}", random_short_id(10));
        if schools.and_then(|items| items.get(&id)).is_none() {
            return id;
        }
    }
    format!("sch{}", random_short_id(12))
}

fn generate_short_id(reg: &Value) -> String {
    for _ in 0..30 {
        let id = random_short_id(10);
        let taken = reg
            .get("schools")
            .and_then(Value::as_object)
            .map(|schools| {
                schools
                    .values()
                    .any(|school| school.get("shortId").and_then(Value::as_str).unwrap_or("") == id)
            })
            .unwrap_or(false);
        if !taken {
            return id;
        }
    }
    random_short_id(12)
}

fn is_valid_login_id(login_id: &str) -> bool {
    let id = login_id.trim().to_lowercase();
    id.len() >= 3
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
}

fn is_email(value: &str) -> bool {
    let v = value.trim();
    v.contains('@') && v.contains('.') && !v.contains(' ')
}

fn is_phone(value: &str) -> bool {
    let digits: String = value.chars().filter(|ch| ch.is_ascii_digit()).collect();
    (9..=11).contains(&digits.len())
}

fn email_in_use(reg: &Value, email: &str) -> bool {
    let email = email.trim().to_ascii_lowercase();
    reg.get("users")
        .and_then(Value::as_object)
        .map(|users| {
            users.values().any(|user| {
                user.get("email")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case(&email)
            })
        })
        .unwrap_or(false)
}

fn ip_registered(reg: &Value, ip: &str) -> bool {
    let ip = ip.trim();
    if ip.is_empty() {
        return false;
    }
    let registered_owner_still_exists = reg
        .get("registeredIps")
        .and_then(Value::as_object)
        .and_then(|items| items.get(ip))
        .map(|entry| {
            let school_id = entry
                .get("schoolId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let login_id = entry
                .get("userId")
                .or_else(|| entry.get("loginId"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let school_exists = !school_id.is_empty()
                && reg
                    .get("schools")
                    .and_then(Value::as_object)
                    .is_some_and(|schools| schools.contains_key(school_id));
            let user_exists = !login_id.is_empty() && find_user(reg, login_id).is_some();
            school_exists || user_exists
        })
        .unwrap_or(false);

    if registered_owner_still_exists {
        return true;
    }

    // Legacy registries may not have a registeredIps entry. In that case the
    // first recorded school IP is the registration IP. Only live schools count:
    // an audit entry left behind after a superadmin deletion must not block a
    // replacement account forever.
    reg.get("schools")
        .and_then(Value::as_object)
        .map(|schools| {
            schools.values().any(|school| {
                school
                    .get("ips")
                    .and_then(Value::as_array)
                    .and_then(|ips| ips.first())
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    == ip
            })
        })
        .unwrap_or(false)
}

pub fn register_json(db: &Db, body: &[u8], request_ip: &str) -> Vec<u8> {
    let payload = match serde_json::from_slice::<Value>(body) {
        Ok(v) => v,
        Err(_) => {
            return json_bytes(
                400,
                json!({"ok": false, "message": "Dữ liệu đăng ký không hợp lệ."}),
            )
        }
    };

    let login_id = payload
        .get("loginId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or("");
    let email = payload
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let phone = payload.get("phone").and_then(Value::as_str).unwrap_or("");
    let school_name = payload
        .get("schoolName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let schedule_number = payload
        .get("scheduleNumber")
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .get("scheduleNumber")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<u64>().ok())
        })
        .unwrap_or(1);
    let effective_date = payload
        .get("effectiveDate")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let client_ip = request_ip.trim();

    if !is_valid_login_id(&login_id) {
        return json_bytes(
            400,
            json!({"ok": false, "message": "Tên đăng nhập tối thiểu 3 ký tự, chỉ chữ/số."}),
        );
    }
    if !is_email(&email) {
        return json_bytes(400, json!({"ok": false, "message": "Email không hợp lệ."}));
    }
    if !is_phone(phone) {
        return json_bytes(
            400,
            json!({"ok": false, "message": "Số điện thoại không hợp lệ."}),
        );
    }
    if password.len() < 6 {
        return json_bytes(
            400,
            json!({"ok": false, "message": "Mật khẩu tối thiểu 6 ký tự."}),
        );
    }
    if school_name.is_empty() {
        return json_bytes(400, json!({"ok": false, "message": "Nhập tên trường."}));
    }
    if effective_date.is_empty() {
        return json_bytes(
            400,
            json!({"ok": false, "message": "Chọn ngày áp dụng TKB."}),
        );
    }
    let _registration_guard = REGISTRATION_GUARD.lock().unwrap();
    let mut reg = load_registry(db);
    if is_ip_blocked(&reg, client_ip) {
        return json_bytes(
            403,
            json!({"ok": false, "message": "IP của bạn đã bị khóa. Liên hệ quản trị."}),
        );
    }
    if ip_registered(&reg, client_ip) {
        return json_bytes(
            409,
            json!({"ok": false, "message": "IP này đã được dùng để đăng ký. Mỗi IP chỉ đăng ký 1 lần."}),
        );
    }

    let users = reg
        .as_object_mut()
        .and_then(|root| root.get_mut("users"))
        .and_then(Value::as_object_mut);
    let Some(users) = users else {
        return json_bytes(500, json!({"ok": false, "message": "Registry lỗi."}));
    };
    if users.contains_key(&login_id) {
        return json_bytes(
            409,
            json!({"ok": false, "message": "Tên đăng nhập đã tồn tại."}),
        );
    }
    if email_in_use(&reg, &email) {
        return json_bytes(
            409,
            json!({"ok": false, "message": "Email đã được đăng ký."}),
        );
    }

    let school_id = generate_school_id(&reg);
    let short_id = generate_short_id(&reg);
    let ts = now_secs().to_string();
    let schedule_sid = format!("{short_id}{schedule_number}");
    let hash = hash_password(password);

    let school = json!({
        "id": school_id,
        "shortId": short_id,
        "name": school_name,
        "ownerEmail": email,
        "ownerPhone": phone,
        "ownerLoginId": login_id,
        "plan": "free",
        "active": true,
        "verified": false,
        "scheduleNumber": schedule_number.to_string(),
        "effectiveDate": effective_date,
        "expiresAt": "",
        "trialUsed": false,
        "ips": if client_ip.is_empty() { json!([]) } else { json!([client_ip]) },
        "lastIp": client_ip,
        "createdAt": ts,
        "updatedAt": ts,
        "activeSchedule": schedule_number,
        "schedules": [{
            "number": schedule_number,
            "effectiveDate": effective_date,
            "sid": schedule_sid,
            "original": true,
            "createdAt": ts
        }]
    });

    let user = json!({
        "id": login_id,
        "passwordHash": hash,
        "role": "school_admin",
        "schoolId": school_id,
        "displayName": school_name,
        "email": email,
        "phone": phone,
        "active": true,
        "emailVerified": false,
        "ips": if client_ip.is_empty() { json!([]) } else { json!([client_ip]) },
        "lastIp": client_ip,
        "createdAt": ts,
        "updatedAt": ts
    });

    if let Some(root) = reg.as_object_mut() {
        if let Some(deleted_users) = root.get_mut("deletedUsers").and_then(Value::as_object_mut) {
            deleted_users.retain(|id, _| !id.eq_ignore_ascii_case(&login_id));
        }
        root.entry("users".to_string())
            .or_insert(json!({}))
            .as_object_mut()
            .unwrap()
            .insert(login_id.clone(), user);
        root.entry("schools".to_string())
            .or_insert(json!({}))
            .as_object_mut()
            .unwrap()
            .insert(school_id.clone(), school);
        if !client_ip.is_empty() {
            root.entry("registeredIps".to_string())
                .or_insert(json!({}))
                .as_object_mut()
                .unwrap()
                .insert(
                    client_ip.to_string(),
                    json!({"schoolId": school_id, "loginId": login_id, "at": ts}),
                );
        }
    }

    if !save_registry(db, &reg) {
        return json_bytes(
            500,
            json!({"ok": false, "message": "Không lưu được đăng ký."}),
        );
    }

    json_bytes(
        200,
        json!({
            "ok": true,
            "loginId": login_id,
            "schoolId": school_id,
            "scheduleSid": schedule_sid,
            "message": "Đăng ký thành công. Đăng nhập bằng tên đăng nhập."
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2_password_hashes_are_salted_and_verifiable() {
        let first = hash_password("correct horse battery staple");
        let second = hash_password("correct horse battery staple");
        assert!(first.starts_with("$argon2id$"));
        assert!(second.starts_with("$argon2id$"));
        assert_ne!(first, second);
        assert!(verify_password("correct horse battery staple", &first));
        assert!(!verify_password("wrong password", &first));
        assert!(!password_hash_needs_upgrade(&first));
    }

    #[test]
    fn legacy_sha256_passwords_remain_valid_until_login_migration() {
        let legacy = legacy_sha256_password("legacy-password");
        assert!(verify_password("legacy-password", &legacy));
        assert!(!verify_password("wrong-password", &legacy));
        assert!(password_hash_needs_upgrade(&legacy));
    }

    #[test]
    fn successful_legacy_login_upgrades_the_stored_hash() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        let legacy = legacy_sha256_password("legacy-password");
        save_registry(
            &db,
            &json!({
                "users": {
                    "teacher1": {
                        "id": "teacher1",
                        "passwordHash": legacy,
                        "role": "school_user",
                        "schoolId": "school1",
                        "active": true
                    }
                },
                "schools": {"school1": {"id": "school1", "active": true}}
            }),
        );

        let response = login_json(
            &db,
            br#"{"loginId":"teacher1","password":"legacy-password"}"#,
            "203.0.113.10",
        );
        assert!(String::from_utf8_lossy(&response).contains("200 OK"));
        let upgraded = load_registry(&db)
            .get("users")
            .and_then(|users| users.get("teacher1"))
            .and_then(|user| user.get("passwordHash"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        assert!(upgraded.starts_with("$argon2id$"));
        assert!(verify_password("legacy-password", &upgraded));
    }

    #[test]
    fn registration_uses_the_server_ip_instead_of_spoofed_json() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        save_registry(
            &db,
            &json!({
                "users": {
                    "existing": {
                        "id":"existing",
                        "role":"school_admin",
                        "schoolId":"existing-school"
                    }
                },
                "schools": {
                    "existing-school": {
                        "id":"existing-school",
                        "ips":["203.0.113.55"],
                        "lastIp":"203.0.113.55"
                    }
                },
                "registeredIps": {
                    "203.0.113.55": {"schoolId":"existing-school", "loginId":"existing"}
                }
            }),
        );
        let response = register_json(
            &db,
            br#"{
                "loginId":"newschool",
                "password":"secret123",
                "email":"school@example.com",
                "phone":"0912345678",
                "schoolName":"New School",
                "scheduleNumber":1,
                "effectiveDate":"2026-07-13",
                "clientIp":"198.51.100.99"
            }"#,
            "203.0.113.55",
        );
        assert!(String::from_utf8_lossy(&response).contains("409 Conflict"));
        assert!(load_registry(&db)["users"].get("newschool").is_none());
    }

    #[test]
    fn deleted_registration_owner_releases_its_ip_for_a_new_school() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        save_registry(
            &db,
            &json!({
                "users": {},
                "schools": {},
                "registeredIps": {
                    "203.0.113.55": {
                        "schoolId":"deleted-school",
                        "loginId":"deleted-admin"
                    }
                },
                "deletedSchools": {"deleted-school": true},
                "deletedUsers": {"deleted-admin": true}
            }),
        );

        let response = register_json(
            &db,
            br#"{
                "loginId":"replacement",
                "password":"secret123",
                "email":"replacement@example.com",
                "phone":"0912345678",
                "schoolName":"Replacement School",
                "scheduleNumber":1,
                "effectiveDate":"2026-07-13"
            }"#,
            "203.0.113.55",
        );

        assert!(String::from_utf8_lossy(&response).contains("200 OK"));
        let registry = load_registry(&db);
        assert!(registry["users"].get("replacement").is_some());
        assert_eq!(
            registry["registeredIps"]["203.0.113.55"]["loginId"],
            json!("replacement")
        );
    }

    #[test]
    fn legacy_user_id_still_keeps_its_registration_ip_claim_live() {
        let registry = json!({
            "users": {
                "legacy-key": {"id":"OwnerAccount", "role":"school_admin"}
            },
            "schools": {},
            "registeredIps": {
                "203.0.113.56": {"loginId":"owneraccount"}
            }
        });
        assert!(ip_registered(&registry, "203.0.113.56"));
    }

    #[test]
    fn registration_rejects_an_independently_blocked_ip() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        save_registry(
            &db,
            &json!({
                "users": {},
                "schools": {},
                "registeredIps": {},
                "blockedIps": {"203.0.113.57": {"at":"test"}}
            }),
        );

        let response = register_json(
            &db,
            br#"{
                "loginId":"blockedschool",
                "password":"secret123",
                "email":"blocked@example.com",
                "phone":"0912345678",
                "schoolName":"Blocked School",
                "scheduleNumber":1,
                "effectiveDate":"2026-07-13"
            }"#,
            "203.0.113.57",
        );

        assert!(String::from_utf8_lossy(&response).contains("403 Forbidden"));
        assert!(load_registry(&db)["users"].get("blockedschool").is_none());
    }

    #[test]
    fn recreating_a_deleted_login_clears_its_user_tombstone() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        save_registry(
            &db,
            &json!({
                "users": {},
                "schools": {},
                "registeredIps": {
                    "203.0.113.58": {
                        "schoolId":"deleted-school",
                        "loginId":"same-login"
                    }
                },
                "deletedSchools": {"deleted-school": true},
                "deletedUsers": {"SAME-LOGIN": true}
            }),
        );

        let response = register_json(
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
            "203.0.113.58",
        );

        assert!(String::from_utf8_lossy(&response).contains("200 OK"));
        let registry = load_registry(&db);
        assert!(registry["users"].get("same-login").is_some());
        assert!(registry["deletedUsers"].as_object().unwrap().is_empty());
    }

    #[test]
    fn simultaneous_registrations_cannot_both_claim_the_same_ip() {
        use std::sync::{Arc, Barrier};

        let db = Arc::new(Db::new(":memory:".into()).expect("in-memory database"));
        save_registry(
            &db,
            &json!({"users": {}, "schools": {}, "registeredIps": {}}),
        );
        let barrier = Arc::new(Barrier::new(2));
        let bodies = [
            br#"{
                "loginId":"parallel-one",
                "password":"secret123",
                "email":"parallel-one@example.com",
                "phone":"0912345678",
                "schoolName":"Parallel One",
                "scheduleNumber":1,
                "effectiveDate":"2026-07-13"
            }"#
            .to_vec(),
            br#"{
                "loginId":"parallel-two",
                "password":"secret123",
                "email":"parallel-two@example.com",
                "phone":"0987654321",
                "schoolName":"Parallel Two",
                "scheduleNumber":1,
                "effectiveDate":"2026-07-13"
            }"#
            .to_vec(),
        ];
        let handles: Vec<_> = bodies
            .into_iter()
            .map(|body| {
                let db = Arc::clone(&db);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    register_json(&db, &body, "203.0.113.60")
                })
            })
            .collect();
        let responses: Vec<String> = handles
            .into_iter()
            .map(|handle| String::from_utf8_lossy(&handle.join().unwrap()).to_string())
            .collect();

        assert_eq!(
            responses
                .iter()
                .filter(|body| body.contains("200 OK"))
                .count(),
            1
        );
        assert_eq!(
            responses
                .iter()
                .filter(|body| body.contains("409 Conflict"))
                .count(),
            1
        );
        assert_eq!(load_registry(&db)["users"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn generated_session_tokens_are_unique_within_the_same_process() {
        assert_ne!(random_token(), random_token());
    }

    #[test]
    fn generated_short_ids_are_unique_within_the_same_process() {
        assert_ne!(random_short_id(10), random_short_id(10));
    }

    #[test]
    fn superadmin_sessions_are_not_single_login_limited() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        let user = json!({
            "role": "superadmin",
            "schoolId": "",
            "displayName": "Super Admin"
        });
        let first = create_session(&db, SUPER_ID, &user).expect("first session");
        let second = create_session(&db, SUPER_ID, &user).expect("second session");
        assert_ne!(first, second);
        assert!(require_session(&db, Some(&first)).is_some());
        assert!(require_session(&db, Some(&second)).is_some());
    }

    #[test]
    fn ordinary_account_can_claim_only_one_active_session() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        let user = json!({
            "role": "school_admin",
            "schoolId": "school1",
            "displayName": "School Admin"
        });
        let first = create_session(&db, "school_admin_1", &user).expect("first session");
        assert!(create_session(&db, "school_admin_1", &user).is_none());
        assert!(require_session(&db, Some(&first)).is_some());
    }

    #[test]
    fn stale_logout_cannot_clear_a_newer_active_session() {
        let db = Db::new(":memory:".into()).expect("in-memory database");
        let key = active_session_key("school_admin_1");
        db.set(&key, "new-token").expect("store active token");
        clear_active_session_if_matches(&db, "school_admin_1", "old-token");
        assert_eq!(
            db.get(&key).expect("read active token").as_deref(),
            Some("new-token")
        );
    }
}
