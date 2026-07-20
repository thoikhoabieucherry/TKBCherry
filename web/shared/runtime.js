(function(){
  "use strict";

  const HEALTH_URL = "/api/health";
  const AUTH_RETURN_TO_KEY = "TKB_AUTH_RETURN_TO";
  let healthTimer = null;
  let authExpiryPromise = null;

  function isDevRuntime(){
    const host = String(location.hostname || "").toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "[::1]"
      || host.endsWith(".local");
  }

  function ensureStatusPill(){
    if(!isDevRuntime()) return null;
    let pill = document.getElementById("tkbRuntimeStatus");
    if(pill) return pill;
    pill = document.createElement("div");
    pill.id = "tkbRuntimeStatus";
    pill.className = "tkb-runtime-status is-checking";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");
    pill.innerHTML = '<span class="tkb-runtime-dot" aria-hidden="true"></span><span class="tkb-runtime-label">Đang kiểm tra...</span>';
    document.body.appendChild(pill);
    return pill;
  }

  function setStatus(state, label){
    const pill = ensureStatusPill();
    if(!pill) return;
    pill.className = "tkb-runtime-status is-" + state;
    const labelEl = pill.querySelector(".tkb-runtime-label");
    if(labelEl) labelEl.textContent = label;
  }

  async function checkHealth(){
    const api = window.TKBAuthApi;
    const data = api && api.apiHealth ? await api.apiHealth() : null;
    const ok = !!(data && data.api === "rust");
    if(isDevRuntime()){
      if(ok) setStatus("online", "Backend sẵn sàng");
      else setStatus("offline", "Backend chưa chạy — mở start.py");
    }
    return ok;
  }

  async function validateSession(){
    const A = window.TKBAuth;
    const api = window.TKBAuthApi;
    if(!A || !api) return false;
    const session = A.getSession && A.getSession();
    if(!session || !session.sessionToken) return false;
    const live = await api.apiValidateSession(session.sessionToken);
    if(live) return true;
    if(A.expireSession) A.expireSession();
    else if(A.logout) await A.logout();
    return false;
  }

  function protectedReturnTarget(value){
    const raw = String(value || "").trim();
    if(!raw.startsWith("/") || raw.startsWith("//") || raw === "/") return "";
    return raw;
  }

  function dispatchAuthEvent(name, detail){
    try{
      window.dispatchEvent(new CustomEvent(name, {detail:detail || {}}));
    }catch(_){ }
  }

  function rememberAuthReturnTarget(value){
    const target = protectedReturnTarget(value);
    if(!target) return "";
    try{ sessionStorage.setItem(AUTH_RETURN_TO_KEY, target); }catch(_){ }
    return target;
  }

  async function handleAuthExpired(options){
    if(authExpiryPromise) return authExpiryPromise;
    const detail = Object.assign({}, options || {});
    rememberAuthReturnTarget(
      detail.returnTo
      || (String(location.pathname || "") + String(location.search || ""))
    );
    authExpiryPromise = (async () => {
      // Let the singleton promise become visible before dispatching. A planner
      // listener may route the same event back through this central handler.
      await Promise.resolve();
      dispatchAuthEvent("tkb:auth-expired", detail);
      const live = await validateSession();
      const protectedRequestRejected = Number(detail.status || 0) === 401
        || Number(detail.status || 0) === 403;
      if(live && !protectedRequestRejected){
        authExpiryPromise = null;
        dispatchAuthEvent("tkb:auth-ready", {source:"session-validation"});
        return false;
      }
      if(live){
        const A = window.TKBAuth;
        if(A?.expireSession) A.expireSession();
        else if(A?.logout) await A.logout();
      }
      if(detail.redirect !== false) window.location.replace("/");
      return true;
    })();
    return authExpiryPromise;
  }

  async function guardProtectedPage(roles){
    const A = window.TKBAuth;
    if(!A || !A.requireAuth) return false;
    const auth = A.requireAuth(roles || null);
    if(!auth.ok){
      window.location.replace(auth.redirect || "/");
      return false;
    }
    const ok = await validateSession();
    if(authExpiryPromise){
      await authExpiryPromise;
      return false;
    }
    if(!ok){
      window.location.replace("/");
      return false;
    }
    dispatchAuthEvent("tkb:auth-ready", {source:"protected-page-guard"});
    return true;
  }

  function startHealthPolling(){
    if(!isDevRuntime()){
      const pill = document.getElementById("tkbRuntimeStatus");
      if(pill) pill.remove();
      return;
    }
    checkHealth();
    if(healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(checkHealth, 30000);
  }

  window.TKBRuntime = {
    checkHealth,
    validateSession,
    handleAuthExpired,
    rememberAuthReturnTarget,
    guardProtectedPage,
    startHealthPolling
  };

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", startHealthPolling);
  }else{
    startHealthPolling();
  }
})();
