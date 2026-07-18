(function(){
  "use strict";

  const SC = window.TKBSchool;
  const REMOTE_ONLY_STORAGE = true;

  function safeParseJSON(raw, fallback){
    if(SC && SC.safeParseJSON) return SC.safeParseJSON(raw, fallback);
    try{ return raw ? JSON.parse(raw) : (fallback ?? {}); }catch(_){ return (fallback ?? {}); }
  }

  function lsKey(schoolId){
    if(SC && SC.lsKey) return SC.lsKey(schoolId);
    return `TKB_STORE::${schoolId || "default"}`;
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
    try{
      if(typeof indexedDB !== "undefined"){
        indexedDB.deleteDatabase("TKB_SQLJS_DB");
      }
    }catch(e){
      console.warn("Local KVDB purge failed", e);
    }
  }

  if(REMOTE_ONLY_STORAGE) purgeLocalSchoolCaches();

  function cleanSchoolId(schoolId){
    if(SC && SC.sanitizeSchoolId) return SC.sanitizeSchoolId(schoolId);
    return String(schoolId || "default").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "default";
  }

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

  async function fetchJsonWithTimeout(url, timeoutMs){
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), Number(timeoutMs || 5000)) : null;
    try{
      const resp = await fetch(url, {
        headers: authHeaders(),
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined
      });
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
    if(hasMeaningfulData(direct)) return direct;
    const ids = relatedStoreIds(target).filter(id => id !== target);
    for(const id of ids){
      const data = await loadRemoteSchoolData(id);
      if(hasMeaningfulData(data)){
        saveRemoteSchoolData(target, JSON.stringify(data)).catch(() => {});
        return data;
      }
    }
    return direct;
  }

  function loadRemoteSchoolDataSync(schoolId){
    try{
      if(typeof XMLHttpRequest === "undefined") return null;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", remoteStoreUrl(schoolId), false);
      xhr.setRequestHeader("Accept", "application/json");
      const headers = authHeaders();
      if(headers.Authorization) xhr.setRequestHeader("Authorization", headers.Authorization);
      xhr.send(null);
      if(xhr.status < 200 || xhr.status >= 300) return null;
      return safeParseJSON(xhr.responseText, null);
    }catch(e){
      return null;
    }
  }

  function loadRemoteSchoolDataWithFallbackSync(schoolId){
    const target = cleanSchoolId(schoolId);
    const direct = loadRemoteSchoolDataSync(target);
    if(hasMeaningfulData(direct)) return direct;
    const ids = relatedStoreIds(target).filter(id => id !== target);
    for(const id of ids){
      const data = loadRemoteSchoolDataSync(id);
      if(hasMeaningfulData(data)){
        try{ saveRemoteSchoolData(target, JSON.stringify(data)).catch(() => {}); }catch(_){}
        return data;
      }
    }
    return direct;
  }

  async function saveRemoteSchoolData(schoolId, dataJson){
    const raw = String(dataJson || "{}");
    try{
      const resp = await fetch(remoteStoreUrl(schoolId), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: raw,
        cache: "no-store"
      });
      return resp.ok;
    }catch(e){
      console.warn("Remote school store save failed", e);
      return false;
    }
  }

  async function openKvStore(dbName){
    if(!window.KVDB || !window.KVDB.available || !window.KVDB.available()){
      return null;
    }
    try{
      return await window.KVDB.open(dbName);
    }catch(e){
      console.warn("KVDB open failed", e);
      return null;
    }
  }

  async function loadSchoolData(schoolId, dbName){
    const key = lsKey(schoolId);
    if(REMOTE_ONLY_STORAGE){
      const remoteData = await loadRemoteSchoolDataWithFallback(schoolId);
      purgeLocalSchoolCaches();
      return {
        kv: null,
        data: hasMeaningfulData(remoteData) ? remoteData : {},
        storeKey: key,
        source: hasMeaningfulData(remoteData) ? "remote" : "empty"
      };
    }
    const rawLS = localStorage.getItem(key);
    let kv = null;
    let raw = null;
    let source = "empty";

    const remoteData = await loadRemoteSchoolDataWithFallback(schoolId);
    if(hasMeaningfulData(remoteData)){
      raw = JSON.stringify(remoteData);
      source = "remote";
      try{ localStorage.setItem(key, raw); }catch(_){}
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
    if(REMOTE_ONLY_STORAGE){
      purgeLocalSchoolCaches();
      return await saveRemoteSchoolData(schoolId, dataJson);
    }
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
    safeParseJSON,
    remoteOnly: REMOTE_ONLY_STORAGE,
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
