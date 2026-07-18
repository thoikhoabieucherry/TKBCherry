(function(){
  "use strict";

  const HEALTH_URL = "/api/health";
  let healthTimer = null;

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
    if(A.logout) A.logout();
    return false;
  }

  async function guardProtectedPage(roles){
    const A = window.TKBAuth;
    if(!A || !A.requireAuth) return;
    const auth = A.requireAuth(roles || null);
    if(!auth.ok){
      window.location.replace(auth.redirect || "/");
      return;
    }
    const ok = await validateSession();
    if(!ok){
      window.location.replace("/");
    }
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
    guardProtectedPage,
    startHealthPolling
  };

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", startHealthPolling);
  }else{
    startHealthPolling();
  }
})();
