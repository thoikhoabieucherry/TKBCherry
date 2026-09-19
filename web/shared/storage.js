(function(){
  "use strict";

  const SC = window.TKBSchool;
  const REMOTE_ONLY_STORAGE = true;
  let remoteAuthRequired = false;

  // 31/08: BỘ CHẶN GHI ĐÈ KHO. Trạng thái lần nạp kho gần nhất của từng trường trong phiên trang này:
  //   "ok"       — máy chủ trả 2xx và kho CÓ dữ liệu
  //   "ok-empty" — máy chủ trả 2xx nhưng kho trống (trường mới)
  //   "failed"   — 503 / mất mạng / 401-403 / JSON hỏng → KHÔNG biết máy chủ đang giữ gì
  // Bối cảnh: 31/08 20:17 trang Sắp xếp mở đúng lúc máy chủ chập chờn, nạp về null → DATA = {} →
  // vẫn lưu → kho trường fiwemj2uyk1 (81 GV, 1266 tiết đã xếp) bị ghi rỗng. Quy tắc:
  //   (1) nạp thất bại → từ chối MỌI lần lưu cho tới khi tải lại trang;
  //   (2) bản lưu trống (không có lớp/GV/môn/phân công/TKB/luật) chỉ được phép khi kho trên máy chủ
  //       cũng đang trống ("ok-empty") — muốn xoá cả trường thì dùng mục Quản lý.
  const remoteLoadState = {};
  function noteRemoteLoad(schoolId, data){
    const id = cleanSchoolId(schoolId);
    if(!data || typeof data !== "object") remoteLoadState[id] = "failed";
    else remoteLoadState[id] = hasMeaningfulData(data) ? "ok" : "ok-empty";
    return remoteLoadState[id];
  }
  function remoteLoadStateOf(schoolId){
    return remoteLoadState[cleanSchoolId(schoolId)] || "";
  }
  function remoteSaveGuard(schoolId, dataJson){
    const id = cleanSchoolId(schoolId);
    const state = remoteLoadState[id] || "";
    const parsed = typeof dataJson === "string" ? safeParseJSON(dataJson, null) : dataJson;
    const meaningful = hasMeaningfulData(parsed);
    if(state === "failed"){
      return { ok:false, kind:"remote_load_failed_guard",
        message:"Lúc mở trang KHÔNG nạp được dữ liệu trường từ máy chủ (mạng/máy chủ lỗi hoặc hết phiên đăng nhập), nên trang này không lưu để tránh ghi đè kho bằng bản trống/cũ. Hãy tải lại trang rồi thao tác lại." };
    }
    if(!meaningful && state !== "ok-empty"){
      return { ok:false, kind:"empty_payload_guard",
        message: state === "ok"
          ? "Bản đang giữ trên trang trống rỗng trong khi kho trên máy chủ đang có dữ liệu — không lưu để tránh xoá sạch trường. Hãy tải lại trang; nếu thật sự muốn xoá trường, dùng mục Quản lý."
          : "Trang chưa nạp được kho trường từ máy chủ mà lại định lưu bản trống — không lưu để tránh xoá sạch. Hãy tải lại trang." };
    }
    return { ok:true, meaningful };
  }
  function showStoreGuardBanner(message){
    try{
      if(typeof document === "undefined" || !document.body) return false;
      let el = document.getElementById("tkb-store-guard-banner");
      if(!el){
        el = document.createElement("div");
        el.id = "tkb-store-guard-banner";
        el.setAttribute("role", "alert");
        el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#b91c1c;color:#fff;padding:10px 16px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;";
        const text = document.createElement("span");
        text.className = "tkb-store-guard-text";
        text.style.cssText = "flex:1;";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Tải lại trang";
        btn.style.cssText = "background:#fff;color:#b91c1c;border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;";
        btn.addEventListener("click", () => { try{ location.reload(); }catch(_){ } });
        el.appendChild(text);
        el.appendChild(btn);
        document.body.appendChild(el);
      }
      const t = el.querySelector(".tkb-store-guard-text");
      if(t) t.textContent = "⚠ " + String(message || "Không lưu được dữ liệu.");
      return true;
    }catch(_){ return false; }
  }

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

  // 31/08: Chuẩn hoá Unicode NFC TẠI CHỖ cho toàn bộ dữ liệu trường (khoá lẫn chuỗi).
  // Văn bản gõ/dán từ macOS, Excel, Word hay ở dạng NFD ("à" = "a" + U+0300) trong khi app sinh
  // chuỗi NFC ("à" = U+00E0): hai chuỗi nhìn y hệt nhưng so sánh khác nhau → một giáo viên
  // "ĐP.Hà" thành hai người ở trang Sắp xếp (trường 0l2vcan0xx1: dòng GV dán NFD, phân công NFC).
  // Giữ nguyên tham chiếu object/mảng (UI đang giữ dòng) — chỉ đổi chuỗi và đổi tên khoá; khoá
  // trùng sau chuẩn hoá thì giữ bản NFC sẵn có. Trả về true nếu có gì thay đổi. Idempotent.
  function normalizeUnicodeNFC(root){
    if(!root || typeof root !== "object" || typeof String.prototype.normalize !== "function") return false;
    let changed = false;
    const seen = new Set();
    const norm = (str) => { const n = str.normalize("NFC"); if(n !== str) changed = true; return n; };
    const walk = (v) => {
      if(!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if(Array.isArray(v)){
        for(let i = 0; i < v.length; i++){
          const x = v[i];
          if(typeof x === "string") v[i] = norm(x); else walk(x);
        }
        return;
      }
      for(const k of Object.keys(v)){
        const x = v[k];
        let nv = x;
        if(typeof x === "string") nv = norm(x); else walk(x);
        const nk = norm(k);
        if(nk !== k){
          delete v[k];
          if(!Object.prototype.hasOwnProperty.call(v, nk)) v[nk] = nv;
        }else if(nv !== x){
          v[k] = nv;
        }
      }
    };
    walk(root);
    return changed;
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
      const data = await fetchJsonWithTimeout(remoteStoreUrl(schoolId), 5000);
      noteRemoteLoad(schoolId, data);
      return data;
    }catch(e){
      console.warn("Remote school store load failed", e);
      noteRemoteLoad(schoolId, null);
      return null;
    }
  }

  async function loadRemoteSchoolDataWithFallback(schoolId){
    const target = cleanSchoolId(schoolId);
    const direct = await loadRemoteSchoolData(target);
    if(remoteAuthRequired) return null;
    if(hasMeaningfulData(direct)) return direct;
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
    if(remoteAuthRequired){ noteRemoteLoad(schoolId, null); return null; }
    try{
      if(typeof XMLHttpRequest === "undefined"){ noteRemoteLoad(schoolId, null); return null; }
      const xhr = new XMLHttpRequest();
      xhr.open("GET", remoteStoreUrl(schoolId), false);
      xhr.setRequestHeader("Accept", "application/json");
      const headers = authHeaders();
      if(headers.Authorization) xhr.setRequestHeader("Authorization", headers.Authorization);
      xhr.send(null);
      if(xhr.status === 401 || xhr.status === 403){
        reportRemoteAuthRequired(xhr.status, "school-store-load-sync");
        noteRemoteLoad(schoolId, null);
        return null;
      }
      if(xhr.status < 200 || xhr.status >= 300){ noteRemoteLoad(schoolId, null); return null; }
      const data = safeParseJSON(xhr.responseText, null);
      noteRemoteLoad(schoolId, data);
      return data;
    }catch(e){
      noteRemoteLoad(schoolId, null);
      return null;
    }
  }

  function loadRemoteSchoolDataWithFallbackSync(schoolId){
    const target = cleanSchoolId(schoolId);
    const direct = loadRemoteSchoolDataSync(target);
    if(remoteAuthRequired) return null;
    if(hasMeaningfulData(direct)) return direct;
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

  async function saveRemoteSchoolData(schoolId, dataJson){
    const raw = String(dataJson || "{}");
    if(remoteAuthRequired){
      window.TKBStorage_lastSaveError = { status: 401, kind: "auth_required_latched",
        message: "Phiên đăng nhập đã hết hạn từ trước — TẢI LẠI TRANG và đăng nhập lại rồi thao tác lại." };
      return false;
    }
    const guard = remoteSaveGuard(schoolId, raw);
    if(!guard.ok){
      window.TKBStorage_lastSaveError = { status: 0, kind: guard.kind, message: guard.message };
      console.warn("Remote school store save blocked:", guard.kind, cleanSchoolId(schoolId));
      showStoreGuardBanner(guard.message);
      return false;
    }
    try{
      const resp = await fetch(remoteStoreUrl(schoolId), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: raw,
        cache: "no-store"
      });
      if(resp.status === 401 || resp.status === 403){
        let payload = null;
        try{ payload = await resp.clone().json(); }catch(_){ }
        reportRemoteAuthRequired(resp.status, "school-store-save", payload);
        window.TKBStorage_lastSaveError = { status: resp.status, kind: (payload && (payload.kind || payload.error)) || "unauthorized",
          message: "Máy chủ từ chối quyền (" + resp.status + ") — đăng nhập lại hoặc kiểm tra tài khoản có quyền với trường này." };
        return false;
      }
      if(!resp.ok){
        let payload = null;
        try{ payload = await resp.clone().json(); }catch(_){ }
        const kind = (payload && (payload.kind || payload.error)) || ("http_" + resp.status);
        let msg = (payload && payload.message) || "";
        if(kind === "max1_class_limit_exceeded"){
          msg = "Trường có " + ((payload && payload.classCount) || "?") + " lớp, vượt giới hạn gói hiện tại (" + ((payload && payload.limit) || 39) + " lớp) — máy chủ từ chối lưu.";
        }else if(kind === "school_plan_unavailable"){
          msg = msg || "Trường này chưa gắn gói dịch vụ trong registry — máy chủ từ chối lưu (kể cả superadmin, trừ store 'default').";
        }
        window.TKBStorage_lastSaveError = { status: resp.status, kind, message: msg };
        console.warn("Remote school store save rejected", resp.status, kind, msg);
        return false;
      }
      window.TKBStorage_lastSaveError = null;
      remoteLoadState[cleanSchoolId(schoolId)] = guard.meaningful ? "ok" : "ok-empty";
      return true;
    }catch(e){
      window.TKBStorage_lastSaveError = { status: 0, kind: "network", message: "Không kết nối được máy chủ (mất mạng?)." };
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
    normalizeUnicodeNFC,
    loadRemoteSchoolData,
    loadRemoteSchoolDataWithFallback,
    loadRemoteSchoolDataSync,
    loadRemoteSchoolDataWithFallbackSync,
    saveRemoteSchoolData,
    remoteLoadStateOf,
    remoteSaveGuard,
    showStoreGuardBanner,
    openKvStore,
    loadSchoolData,
    saveSchoolData
  };
})();
