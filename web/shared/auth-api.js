(function(){
  "use strict";

  const LOGIN_API = "/api/auth/login";
  const LOGOUT_API = "/api/auth/logout";
  const REGISTER_API = "/api/auth/register";
  const HASH_API = "/api/auth/hash-password";
  const SESSION_API = "/api/auth/session";
  const REGISTRY_API = "/api/auth/registry";
  const SESSION_KEY = "TKB_SESSION";

  function readSession(){
    let raw = "";
    try{
      raw = localStorage.getItem(SESSION_KEY) || "";
      if(raw) return JSON.parse(raw);
    }catch(_){}

    try{
      raw = sessionStorage.getItem(SESSION_KEY) || "";
      if(!raw) return null;
      const session = JSON.parse(raw);
      try{
        localStorage.setItem(SESSION_KEY, raw);
        sessionStorage.removeItem(SESSION_KEY);
      }catch(_){}
      return session;
    }catch(_){ return null; }
  }

  function getSessionToken(){
    const session = readSession();
    return session && session.sessionToken ? String(session.sessionToken) : "";
  }

  function getAuthHeaders(extra){
    const headers = Object.assign({
      "Accept": "application/json"
    }, extra || {});
    const token = getSessionToken();
    if(token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  async function parseJson(resp){
    return resp.json().catch(() => ({}));
  }

  async function apiLogin(loginId, password, clientIp){
    const resp = await fetch(LOGIN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        loginId: String(loginId || "").trim(),
        password: String(password || ""),
        clientIp: String(clientIp || "").trim()
      }),
      cache: "no-store"
    });
    const data = await parseJson(resp);
    if(!resp.ok || !data || data.ok !== true){
      const serverMsg = data && (data.message || data.error);
      return {
        ok: false,
        message: serverMsg || "Đăng nhập thất bại. Kiểm tra tài khoản hoặc thử lại sau."
      };
    }
    return data;
  }

  async function apiLogout(){
    const token = getSessionToken();
    if(!token) return true;
    try{
      const resp = await fetch(LOGOUT_API, {
        method: "POST",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionToken: token }),
        cache: "no-store"
      });
      return resp.ok;
    }catch(_){
      return false;
    }
  }

  async function apiRegister(payload){
    const resp = await fetch(REGISTER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload || {}),
      cache: "no-store"
    });
    const data = await parseJson(resp);
    if(!resp.ok || !data || data.ok !== true){
      return {
        ok: false,
        message: (data && data.message) || "Đăng ký thất bại. Kiểm tra backend đang chạy."
      };
    }
    return data;
  }

  async function apiHashPassword(password){
    const text = String(password || "");
    if(!text) return "";
    try{
      const resp = await fetch(HASH_API, {
        method: "POST",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ password: text }),
        cache: "no-store"
      });
      if(resp.ok){
        const data = await parseJson(resp);
        if(data && data.passwordHash) return String(data.passwordHash);
      }
    }catch(_){ /* fallback below */ }
    if(window.crypto && crypto.subtle){
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 5381;
    for(let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
    return "djb2_" + (h >>> 0).toString(16);
  }

  async function apiValidateSession(token){
    const active = token || getSessionToken();
    if(!active) return null;
    try{
      const resp = await fetch(`${SESSION_API}?token=${encodeURIComponent(active)}`, {
        headers: getAuthHeaders(),
        cache: "no-store"
      });
      if(!resp.ok) return null;
      const data = await parseJson(resp);
      return data && data.ok ? data.session : null;
    }catch(_){
      return null;
    }
  }

  async function apiFetchRegistry(){
    try{
      const resp = await fetch(REGISTRY_API, {
        headers: getAuthHeaders(),
        cache: "no-store"
      });
      if(resp.status === 401 || resp.status === 403) return null;
      if(!resp.ok) return null;
      return await parseJson(resp);
    }catch(_){
      return null;
    }
  }

  function apiFetchRegistrySync(){
    try{
      if(typeof XMLHttpRequest === "undefined") return null;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", REGISTRY_API, false);
      xhr.setRequestHeader("Accept", "application/json");
      const token = getSessionToken();
      if(token) xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.send(null);
      if(xhr.status === 401 || xhr.status === 403 || xhr.status < 200 || xhr.status >= 300) return null;
      return JSON.parse(xhr.responseText || "{}");
    }catch(_){
      return null;
    }
  }

  async function apiSaveRegistry(reg){
    try{
      const resp = await fetch(REGISTRY_API, {
        method: "POST",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(reg || {}),
        cache: "no-store"
      });
      return resp.ok;
    }catch(_){
      return false;
    }
  }

  function apiSaveRegistrySync(reg){
    try{
      if(typeof XMLHttpRequest === "undefined") return false;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", REGISTRY_API, false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Accept", "application/json");
      const token = getSessionToken();
      if(token) xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.send(JSON.stringify(reg || {}));
      return xhr.status >= 200 && xhr.status < 300;
    }catch(_){
      return false;
    }
  }

  async function apiHealth(){
    try{
      const resp = await fetch("/api/health", { cache: "no-store", headers: { "Accept": "application/json" } });
      if(!resp.ok) return null;
      return await parseJson(resp);
    }catch(_){
      return null;
    }
  }

  window.TKBAuthApi = {
    getAuthHeaders,
    getSessionToken,
    apiLogin,
    apiLogout,
    apiRegister,
    apiHashPassword,
    apiValidateSession,
    apiFetchRegistry,
    apiFetchRegistrySync,
    apiSaveRegistry,
    apiSaveRegistrySync,
    apiHealth
  };
})();
