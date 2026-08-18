(function(){
  "use strict";

  const SC = window.TKBSchool;
  const REMOTE_ONLY_STORAGE = true;
  const REMOTE_SAVE_MAX_ATTEMPTS = 3;
  const REMOTE_SAVE_RETRY_WINDOW_MS = 5000;
  const remoteSaveQueues = new Map();
  let remoteAuthRequired = false;

  function safeParseJSON(raw, fallback){
    if(SC && SC.safeParseJSON) return SC.safeParseJSON(raw, fallback);
    try{ return raw ? JSON.parse(raw) : (fallback ?? {}); }catch(_){ return (fallback ?? {}); }
  }

  function lsKey(schoolId){
    if(SC && SC.lsKey) return SC.lsKey(schoolId);
    return `TKB_STORE::${schoolId || "default"}`;
  }

  function cleanSchoolId(schoolId){
    if(SC && SC.sanitizeSchoolId) return SC.sanitizeSchoolId(schoolId);
    return String(schoolId || "default").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "default";
  }

  function purgeLocalSchoolCaches(){
    try{
      const remove = [];
      for(let i = 0; i < localStorage.length; i++){
        const key = String(localStorage.key(i) || "");
        if(
          key === "TKB_STORE" ||
          key === "VietSchool_TKB_STORE" ||
          key === "VIETSCHOOL_STORE" ||
          key === "TKB_SCHOOL_LIST" ||
          key === "TKB_SCHOOL_NAMES" ||
          key === "TKB_LAST_SCHOOL" ||
          key === "TKB_LAST_SCHOOL_LABEL" ||
          key.startsWith("TKB_STORE::") ||
          key.startsWith("TKB::SCHOOL::")
        ){
          remove.push(key);
        }
      }
      remove.forEach(key => localStorage.removeItem(key));
    }catch(e){
      console.warn("Local school cache purge failed", e);
    }
  }

  if(REMOTE_ONLY_STORAGE) purgeLocalSchoolCaches();

  function remoteStoreUrl(schoolId){
    return `/api/school/store?id=${encodeURIComponent(cleanSchoolId(schoolId))}`;
  }

  function hasObjectEntries(obj){
    return !!(obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length > 0);
  }

  function hasDeepContent(value){
    if(Array.isArray(value)) return value.length > 0;
    if(value && typeof value === "object"){
      return Object.keys(value).some(key => hasDeepContent(value[key]));
    }
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function hasMeaningfulConstraints(constraints){
    if(!constraints || typeof constraints !== "object" || Array.isArray(constraints)) return false;
    return Object.keys(constraints).some(key => {
      if(key === "meta" || key === "__normalizedBy") return false;
      return hasDeepContent(constraints[key]);
    });
  }

  function hasMeaningfulData(data){
    if(!data || typeof data !== "object" || Array.isArray(data)) return false;
    return !!(
      (Array.isArray(data.khoi) && data.khoi.length > 0) ||
      (Array.isArray(data.lop) && data.lop.length > 0) ||
      (Array.isArray(data.giaovien) && data.giaovien.length > 0) ||
      (Array.isArray(data.monhoc) && data.monhoc.length > 0) ||
      (Array.isArray(data.mon) && data.mon.length > 0) ||
      hasObjectEntries(data.pccmMatrix) ||
      hasObjectEntries(data.pccmTietMatrix) ||
      hasObjectEntries(data.pccmGioihanMatrix) ||
      hasObjectEntries(data.tkb) ||
      hasObjectEntries(data.tkbUserOff) ||
      hasMeaningfulConstraints(data.tkbConstraints)
    );
  }

  function addUnique(list, value){
    const id = cleanSchoolId(value);
    if(id && !list.includes(id)) list.push(id);
  }

  function relatedStoreIds(schoolId){
    const target = cleanSchoolId(schoolId);
    const out = [];
    addUnique(out, target);
    if(target === "default") return out;
    try{
      const A = window.TKBAuth;
      if(!A || typeof A.loadRegistry !== "function") return out;
      const reg = A.loadRegistry() || {};
      const schools = reg.schools || {};
      Object.keys(schools).forEach(baseId => {
        const school = schools[baseId] || {};
        const schedules = Array.isArray(school.schedules) ? school.schedules : [];
        const isMatch = cleanSchoolId(baseId) === target || schedules.some(item => cleanSchoolId(item && item.sid) === target);
        if(!isMatch) return;
        const activeNum = Number(school.activeSchedule);
        const active = schedules.find(item => Number(item.number) === activeNum);
        const original = schedules.find(item => item && item.original);
        if(active) addUnique(out, active.sid);
        if(original) addUnique(out, original.sid);
        schedules
          .slice()
          .sort((a, b) => (Number(a && a.number) || 0) - (Number(b && b.number) || 0))
          .forEach(item => addUnique(out, item && item.sid));
        addUnique(out, baseId);
      });
    }catch(e){
      console.warn("Related school stores lookup failed", e);
    }
    return out;
  }

  function authHeaders(extra){
    if(window.TKBAuthApi && window.TKBAuthApi.getAuthHeaders){
      return window.TKBAuthApi.getAuthHeaders(extra);
    }
    return Object.assign({ "Accept": "application/json" }, extra || {});
  }

  function reportRemoteAuthRequired(status, source, payload){
    const value = Number(status || 0) || 0;
    if(value !== 401 && value !== 403) return false;
    const first = !remoteAuthRequired;
    remoteAuthRequired = true;
    if(!first) return true;
    const detail = {
      status:value,
      source:String(source || "school-store"),
      payload:payload && typeof payload === "object" ? payload : null,
      returnTo:String(location.pathname || "") + String(location.search || "")
    };
    try{
      const handler = window.TKBRuntime?.handleAuthExpired;
      if(typeof handler === "function"){
        Promise.resolve(handler(detail)).catch(() => {});
      }else{
        window.dispatchEvent?.(new CustomEvent("tkb:auth-expired", {detail}));
      }
    }catch(_){ }
    return true;
  }

  try{
    window.addEventListener?.("tkb:auth-ready", () => {
      remoteAuthRequired = false;
    });
  }catch(_){ }

  async function fetchJsonWithTimeout(url, timeoutMs){
    if(remoteAuthRequired) return null;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), Number(timeoutMs || 5000)) : null;
    try{
      const resp = await fetch(url, {
        headers: authHeaders(),
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined
      });
      if(resp.status === 401 || resp.status === 403){
        let payload = null;
        try{ payload = await resp.clone().json(); }catch(_){ }
        reportRemoteAuthRequired(resp.status, "school-store-load", payload);
        return null;
      }
      if(!resp.ok) return null;
      return await resp.json().catch(() => null);
    }finally{
      if(timer) clearTimeout(timer);
    }
  }

  async function loadRemoteSchoolData(schoolId){
    try{
      return await fetchJsonWithTimeout(remoteStoreUrl(schoolId), 5000);
    }catch(e){
      console.warn("Remote school store load failed", e);
      return null;
    }
  }

  async function loadRemoteSchoolDataWithFallback(schoolId){
    const target = cleanSchoolId(schoolId);
    const direct = await loadRemoteSchoolData(target);
    if(remoteAuthRequired) return null;
    if(target === "default" || hasMeaningfulData(direct)) return direct;
    const ids = relatedStoreIds(target).filter(id => id !== target);
    for(const id of ids){
      if(remoteAuthRequired) return null;
      const data = await loadRemoteSchoolData(id);
      if(hasMeaningfulData(data)){
        saveRemoteSchoolData(target, JSON.stringify(data)).catch(() => {});
        return data;
      }
    }
    return direct;
  }

  function loadRemoteSchoolDataSync(schoolId){
    if(remoteAuthRequired) return null;
    try{
      if(typeof XMLHttpRequest === "undefined") return null;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", remoteStoreUrl(schoolId), false);
      xhr.setRequestHeader("Accept", "application/json");
      const headers = authHeaders();
      if(headers.Authorization) xhr.setRequestHeader("Authorization", headers.Authorization);
      xhr.send(null);
      if(xhr.status === 401 || xhr.status === 403){
        reportRemoteAuthRequired(xhr.status, "school-store-load-sync");
        return null;
      }
      if(xhr.status < 200 || xhr.status >= 300) return null;
      return safeParseJSON(xhr.responseText, null);
    }catch(e){
      return null;
    }
  }

  function loadRemoteSchoolDataWithFallbackSync(schoolId){
    const target = cleanSchoolId(schoolId);
    const direct = loadRemoteSchoolDataSync(target);
    if(remoteAuthRequired) return null;
    if(target === "default" || hasMeaningfulData(direct)) return direct;
    const ids = relatedStoreIds(target).filter(id => id !== target);
    for(const id of ids){
      if(remoteAuthRequired) return null;
      const data = loadRemoteSchoolDataSync(id);
      if(hasMeaningfulData(data)){
        try{ saveRemoteSchoolData(target, JSON.stringify(data)).catch(() => {}); }catch(_){}
        return data;
      }
    }
    return direct;
  }

  function remoteSaveRetryableStatus(status){
    const value = Number(status || 0) || 0;
    return value === 408 || value === 425 || value === 429 || value >= 500;
  }

  function remoteSaveRetryDelayMs(resp, attempt){
    try{
      const raw = String(resp?.headers?.get?.("Retry-After") || "").trim();
      if(/^\d+(?:\.\d+)?$/.test(raw)){
        return Math.max(100, Math.min(10000, Math.round(Number(raw) * 1000)));
      }
    }catch(_){ }
    return Math.min(5000, 250 * Math.pow(2, Math.min(5, Math.max(0, Number(attempt) || 0))));
  }

  function waitForRemoteSaveRetry(delayMs){
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
  }

  function recordRemoteSaveState(schoolId, detail){
    try{
      window.__TKB_REMOTE_STORE_LAST_SAVE = Object.assign({
        schoolId:cleanSchoolId(schoolId),
        at:new Date().toISOString()
      }, detail || {});
    }catch(_){ }
  }

  function reportRemoteSaveRejected(schoolId, status, payload){
    const value = Number(status || 0) || 0;
    if(value !== 409 && payload?.retryable !== false) return;
    const message = String(
      payload?.message
      || payload?.detail
      || "Không lưu được dữ liệu trường. Vui lòng kiểm tra gói dịch vụ rồi thử lại."
    ).trim();
    const detail = {
      schoolId:cleanSchoolId(schoolId),
      status:value,
      kind:String(payload?.kind || payload?.error || "school_store_rejected"),
      message,
      retryable:false
    };
    recordRemoteSaveState(schoolId, Object.assign({ok:false}, detail));
    try{
      if(typeof window.CustomEvent === "function"){
        window.dispatchEvent?.(new window.CustomEvent("tkb:school-store-save-rejected", {detail}));
      }
    }catch(_){ }
    try{
      if(typeof window.showBottomPopup === "function") window.showBottomPopup(message, "warning");
      else if(typeof window.alert === "function") window.alert(message);
    }catch(_){ }
  }

  async function saveRemoteSchoolDataWithRetry(schoolId, raw){
    const startedAt = Date.now();
    let lastError = null;
    let lastStatus = 0;
    let attemptsUsed = 0;
    for(let attempt = 0; attempt < REMOTE_SAVE_MAX_ATTEMPTS; attempt += 1){
      attemptsUsed = attempt + 1;
      let resp = null;
      try{
        resp = await fetch(remoteStoreUrl(schoolId), {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: raw,
          cache: "no-store",
          keepalive: true
        });
        lastStatus = Number(resp?.status || 0) || 0;
        let payload = null;
        if(!resp.ok){
          try{ payload = await resp.clone().json(); }catch(_){ }
        }
        if(lastStatus === 401 || lastStatus === 403){
          reportRemoteAuthRequired(lastStatus, "school-store-save", payload);
          recordRemoteSaveState(schoolId, {ok:false, authRequired:true, status:lastStatus, attempts:attempt + 1});
          return false;
        }
        if(resp.ok){
          recordRemoteSaveState(schoolId, {ok:true, status:lastStatus, attempts:attempt + 1});
          return true;
        }
        if(payload?.retryable === false || !remoteSaveRetryableStatus(lastStatus)){
          reportRemoteSaveRejected(schoolId, lastStatus, payload);
          recordRemoteSaveState(schoolId, {
            ok:false,
            status:lastStatus,
            attempts:attempt + 1,
            kind:String(payload?.kind || payload?.error || ""),
            message:String(payload?.message || payload?.detail || ""),
            retryable:false
          });
          return false;
        }
      }catch(e){
        lastError = e;
        lastStatus = 0;
      }

      const delayMs = remoteSaveRetryDelayMs(resp, attempt);
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if(
        attempt + 1 >= REMOTE_SAVE_MAX_ATTEMPTS
        || elapsedMs + delayMs > REMOTE_SAVE_RETRY_WINDOW_MS
      ) break;
      recordRemoteSaveState(schoolId, {
        ok:false,
        retrying:true,
        status:lastStatus,
        attempts:attempt + 1,
        retryInMs:delayMs
      });
      await waitForRemoteSaveRetry(delayMs);
    }
    if(lastError) console.warn("Remote school store save failed", lastError);
    recordRemoteSaveState(schoolId, {
      ok:false,
      status:lastStatus,
      attempts:attemptsUsed,
      exhausted:true
    });
    return false;
  }

  function saveRemoteSchoolData(schoolId, dataJson){
    const target = cleanSchoolId(schoolId);
    const raw = String(dataJson || "{}");

    const previous = remoteSaveQueues.get(target) || null;
    if(previous && previous.raw === raw) return previous.promise;

    const queued = Promise.resolve(previous?.promise)
      .catch(() => false)
      .then(() => saveRemoteSchoolDataWithRetry(target, raw));
    const entry = {raw, promise:null};
    entry.promise = queued.finally(() => {
      if(remoteSaveQueues.get(target) === entry) remoteSaveQueues.delete(target);
    });
    remoteSaveQueues.set(target, entry);
    return entry.promise;
  }

  async function openKvStore(dbName){
    if(!window.KVDB || !window.KVDB.available || !window.KVDB.available()){
      return null;
    }
    try{
      return await Promise.race([
        window.KVDB.open(dbName),
        new Promise(resolve => setTimeout(() => resolve(null), 300))
      ]);
    }catch(e){
      console.warn("KVDB open failed", e);
      return null;
    }
  }

  async function loadSchoolData(schoolId, dbName){
    const key = lsKey(schoolId);
    const rawLS = localStorage.getItem(key);
    let kv = null;
    let raw = null;
    let source = "empty";

    const remoteData = await loadRemoteSchoolDataWithFallback(schoolId);
    if(hasMeaningfulData(remoteData)){
      raw = JSON.stringify(remoteData);
      source = "remote";
      try{ localStorage.setItem(key, raw); }catch(_){}
      return {
        kv: null,
        data: remoteData,
        storeKey: key,
        source: "remote"
      };
    }

    if(window.KVDB){
      try{
        kv = await openKvStore(dbName || `tkb_${schoolId || "default"}`);
        if(!raw && kv){
          raw = await kv.get("DATA_JSON");
          if(raw) source = "kvdb";
        }
        if(!raw && rawLS){
          raw = rawLS;
          source = "local";
          try{ await kv.set("DATA_JSON", raw); }catch(_){}
        }
        if(raw && kv && source === "remote"){
          try{ await kv.set("DATA_JSON", raw); }catch(_){}
        }
      }catch(e){
        console.warn("KVDB load failed; fallback to localStorage", e);
        kv = null;
      }
    }

    if(!raw && rawLS){
      raw = rawLS;
      source = "local";
    }
    const data = safeParseJSON(raw, {});
    return {
      kv,
      data,
      storeKey: key,
      source
    };
  }

  async function saveSchoolData(kv, schoolId, dataJson){
    const key = lsKey(schoolId);
    try{ localStorage.setItem(key, dataJson); }catch(e){
      console.warn("localStorage save failed", e);
    }
    if(kv){
      try{ await kv.set("DATA_JSON", dataJson); }catch(e){
        console.warn("KVDB save failed", e);
      }
    }
    return await saveRemoteSchoolData(schoolId, dataJson);
  }

  window.TKBStorage = {
    version:"remote-save-retry-v3",
    safeParseJSON,
    lsKey,
    cleanSchoolId,
    remoteStoreUrl,
    hasMeaningfulData,
    loadRemoteSchoolData,
    loadRemoteSchoolDataWithFallback,
    loadRemoteSchoolDataSync,
    loadRemoteSchoolDataWithFallbackSync,
    saveRemoteSchoolData,
    openKvStore,
    loadSchoolData,
    saveSchoolData
  };
})();
