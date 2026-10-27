/* ============================================================
   Bản web KHÔNG ĐĂNG NHẬP (Netlify) — shared/auth-local.js
   Thay cho shared/auth-api.js + shared/auth.js + shared/runtime.js.

   27/10/2026 (chủ dự án: "up trực tiếp lên tkbcherry, ko cần login vào thẳng trang app"):
   dựa trên shim của Cherry Local / bản V4 nhưng CHỈ giữ:
     - người dùng giả "Máy này" (school_admin), không đăng nhập;
     - kho dữ liệu trường trong trình duyệt (localStorage CHERRY_HOST_*): app đọc/ghi
       /api/school/store và /api/local/schools như với máy chủ, shim trả lời tại chỗ.
   BỎ so với V4: tự nạp /data/<mã>.json (V4 đăng kèm dữ liệu thật của trường lên web công
   khai), đồng bộ kho sang máy local, và chuyển/đánh thức lệnh giải — việc giải do
   tkb-rust-bridge.js lo (nút gạt "Máy này" -> bộ giải tools/local-solver ở 127.0.0.1:2211,
   chỉ đánh thức cherry-local:// khi người dùng bấm).
============================================================ */
(function(){
  "use strict";

  const HOST_SCHOOLS_KEY = "CHERRY_HOST_SCHOOLS_V1";
  const HOST_DATA_PREFIX = "CHERRY_HOST_DATA_V1::";
  const origFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  function sanitize(value){
    try{
      if(window.TKBSchool && typeof window.TKBSchool.sanitizeSchoolId === "function"){
        return window.TKBSchool.sanitizeSchoolId(value);
      }
    }catch(_){ }
    const x = String(value || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d").replace(/Đ/g, "D")
      .replace(/[^0-9a-zA-Z]+/g, "").toLowerCase();
    return x || "default";
  }

  function countTkbCells(tkb){
    let n = 0;
    if(!tkb || typeof tkb !== "object") return 0;
    for(const byDay of Object.values(tkb)){
      if(!byDay || typeof byDay !== "object") continue;
      for(const bySession of Object.values(byDay)){
        if(!bySession || typeof bySession !== "object") continue;
        for(const arr of Object.values(bySession)){
          if(!Array.isArray(arr)) continue;
          for(const cell of arr){
            if(!cell || cell === "OFF") continue;
            if(typeof cell === "object"){
              if(cell.off === true) continue;
              if(!String(cell.mon || cell.val || "").trim()) continue;
            }
            n += 1;
          }
        }
      }
    }
    return n;
  }

  function summarizeData(data){
    if(!data || typeof data !== "object") return {lop:0, giaovien:0, monhoc:0, tkbCells:0};
    return {
      lop: Array.isArray(data.lop) ? data.lop.length : 0,
      giaovien: Array.isArray(data.giaovien) ? data.giaovien.length : 0,
      monhoc: Array.isArray(data.monhoc) ? data.monhoc.length : 0,
      tkbCells: countTkbCells(data.tkb)
    };
  }

  /* ---------------- Kho dữ liệu trong trình duyệt ---------------- */
  function readSchoolsMap(){
    try{
      const parsed = JSON.parse(localStorage.getItem(HOST_SCHOOLS_KEY) || "null");
      if(parsed && parsed.schools && typeof parsed.schools === "object") return parsed.schools;
    }catch(_){ }
    return {};
  }

  function writeSchoolsMap(map){
    try{ localStorage.setItem(HOST_SCHOOLS_KEY, JSON.stringify({schools: map || {}})); }catch(_){ }
  }

  function readSchoolData(sid){
    try{
      const parsed = JSON.parse(localStorage.getItem(HOST_DATA_PREFIX + sanitize(sid)) || "null");
      if(parsed && typeof parsed === "object") return parsed;
    }catch(_){ }
    return {};
  }

  function writeSchoolData(sid, dataObjOrStr, optName){
    const clean = sanitize(sid);
    let obj = dataObjOrStr;
    let raw = "";
    if(typeof dataObjOrStr === "string"){
      raw = dataObjOrStr;
      try{ obj = JSON.parse(raw); }catch(_){ obj = {}; }
    }else{
      obj = (dataObjOrStr && typeof dataObjOrStr === "object") ? dataObjOrStr : {};
      raw = JSON.stringify(obj);
    }
    // localStorage đầy (trường lớn) phải báo lỗi cho app, không được nuốt im lặng.
    localStorage.setItem(HOST_DATA_PREFIX + clean, raw);
    const map = readSchoolsMap();
    const existing = map[clean] || {};
    const now = Date.now();
    map[clean] = {
      name: String(optName || existing.name || (obj && obj.schoolName) || clean),
      createdAt: Number(existing.createdAt || now),
      updatedAt: now,
      summary: summarizeData(obj)
    };
    writeSchoolsMap(map);
    return obj;
  }

  function listSchoolsLocal(){
    const out = [];
    for(const [sid, entry] of Object.entries(readSchoolsMap())){
      const clean = sanitize(sid);
      const item = entry && typeof entry === "object" ? entry : {};
      out.push({
        id: clean,
        name: String(item.name || clean),
        updatedAt: Number(item.updatedAt || Date.now()),
        createdAt: Number(item.createdAt || Date.now()),
        summary: item.summary || summarizeData(readSchoolData(clean))
      });
    }
    out.sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name));
    return out;
  }

  function schoolsAction(req){
    req = req && typeof req === "object" ? req : {};
    const action = String(req.action || "").trim().toLowerCase();
    const map = readSchoolsMap();
    if(action === "import"){
      if(!req.data || typeof req.data !== "object") return {status: 400, payload: {ok:false, error:"Thiếu data."}};
      const sid = sanitize(req.id || "");
      const name = String(req.name || "").trim() || sid;
      writeSchoolData(sid, req.data, name);
      return {status: 200, payload: {ok:true, id:sid, name}};
    }
    if(action === "create"){
      const name = String(req.name || "").trim();
      if(!name) return {status: 400, payload: {ok:false, error:"Thiếu tên trường."}};
      const base = sanitize(req.id || name);
      let sid = base;
      let i = 2;
      while(map[sid]){ sid = `${base}${i}`; i++; }
      writeSchoolData(sid, {lop:[], giaovien:[], monhoc:[], pccmMatrix:{}, tkb:{}}, name);
      return {status: 200, payload: {ok:true, id:sid, name}};
    }
    if(action === "rename"){
      const sid = sanitize(req.id || "");
      const name = String(req.name || "").trim();
      if(!name) return {status: 400, payload: {ok:false, error:"Thiếu tên."}};
      map[sid] = Object.assign({}, map[sid] || {}, {name, updatedAt: Date.now()});
      writeSchoolsMap(map);
      return {status: 200, payload: {ok:true, id:sid, name}};
    }
    if(action === "delete"){
      const sid = sanitize(req.id || "");
      delete map[sid];
      writeSchoolsMap(map);
      try{ localStorage.removeItem(HOST_DATA_PREFIX + sid); }catch(_){ }
      return {status: 200, payload: {ok:true, id:sid}};
    }
    return {status: 400, payload: {ok:false, error:`Không hiểu action '${action}'.`}};
  }

  // shared/storage.js đọc kho đồng bộ qua đây khi trang không có máy chủ.
  window.__cherryHostStore = {
    isRemoteHost: true,
    readSchoolSync: readSchoolData,
    readSchoolAsync: async sid => readSchoolData(sid),
    writeSchoolSync: writeSchoolData,
    listSchoolsSync: listSchoolsLocal
  };

  function jsonResponse(status, obj){
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: {"Content-Type": "application/json; charset=utf-8"}
    });
  }

  if(origFetch){
    window.fetch = async function(input, init){
      const urlStr = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : "");
      let parsed = null;
      try{ parsed = new URL(urlStr, location.href); }catch(_){ }
      if(parsed && parsed.origin === location.origin && parsed.pathname.startsWith("/api/")){
        const path = parsed.pathname;
        const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        const bodyText = () => String((init && init.body) || "{}");
        if(path === "/api/local/schools"){
          if(method === "GET") return jsonResponse(200, {ok:true, schools:listSchoolsLocal(), dataDir:"browser-storage"});
          let body = {};
          try{ body = JSON.parse(bodyText()); }catch(_){ }
          const res = schoolsAction(body);
          return jsonResponse(res.status, res.payload);
        }
        if(path === "/api/school/store"){
          const sid = sanitize(parsed.searchParams.get("id") || "default");
          if(method === "GET") return jsonResponse(200, readSchoolData(sid));
          try{
            writeSchoolData(sid, bodyText());
          }catch(err){
            return jsonResponse(507, {ok:false, kind:"browser_storage_full",
              error:"Trình duyệt hết chỗ lưu dữ liệu trường: " + ((err && err.message) || err)});
          }
          return jsonResponse(200, {ok:true, id:sid, savedAt:Date.now()});
        }
        if(path === "/api/health"){
          // Trang này KHÔNG có máy chủ giải (api khác "rust"): bridge chỉ dùng bộ giải trên máy.
          return jsonResponse(200, {ok:true, api:"browser-store", server:false});
        }
        if(path === "/api/solve-precheck"){
          return jsonResponse(200, {ok:true, backend:"browser-store", warnings:[], issues:[]});
        }
        // Mọi /api/* khác không có ở bản không đăng nhập: trả JSON thay vì trang 404 HTML.
        return jsonResponse(404, {ok:false, kind:"no_server", error:"Bản web không đăng nhập không có máy chủ."});
      }
      return origFetch(input, init);
    };
  }

  const LOCAL_USER = {id:"local", loginId:"local", name:"Máy này", role:"school_admin", active:true};
  let schoolsCache = null;

  function schools(){
    if(!schoolsCache) schoolsCache = listSchoolsLocal();
    return schoolsCache;
  }

  function refreshSchools(){
    schoolsCache = null;
    return schools();
  }

  function currentSid(){
    try{
      const url = new URL(location.href);
      const fromUrl = url.searchParams.get("sid") || url.searchParams.get("school") || "";
      if(fromUrl) return sanitize(fromUrl);
    }catch(_){ }
    const list = schools();
    try{
      const last = sanitize(localStorage.getItem("TKB_LAST_SCHOOL") || "");
      if(last && (!list.length || list.some(s => s.id === last))) return last;
    }catch(_){ }
    return list.length ? String(list[0].id) : "default";
  }

  function schoolNameOf(sid){
    const found = schools().find(s => String(s.id) === sid);
    return found && found.name ? String(found.name) : sid;
  }

  function scheduleEntry(sid){
    return {number:1, sid, original:true, effectiveDate:"", createdAt:""};
  }

  function schoolRecord(id, name){
    return {
      id, name: name || id, shortId:id, plan:"local", active:true,
      activeSchedule:1, schedules:[scheduleEntry(id)], effectiveDate:"", createdAt:"", updatedAt:""
    };
  }

  function loadRegistry(){
    const sid = currentSid();
    const map = {};
    schools().forEach(s => {
      const id = sanitize(s.id);
      map[id] = schoolRecord(id, s.name);
    });
    if(!map[sid]) map[sid] = schoolRecord(sid, schoolNameOf(sid));
    return {
      users:{local:Object.assign({}, LOCAL_USER, {schoolId:sid})},
      schools:map, otpPending:{}, deletedSchools:{}, deletedUsers:{}, blockedIps:{}, registeredIps:{}
    };
  }

  function getSession(){
    return {userId:"local", loginId:"local", role:"school_admin", schoolId:currentSid(), sessionToken:"local", createdAt:0};
  }

  function currentUser(){
    return {session:getSession(), user:Object.assign({}, LOCAL_USER, {schoolId:currentSid()}), registry:loadRegistry()};
  }

  function updateSchoolMeta(schoolId, patch){
    const id = sanitize(schoolId);
    const name = String((patch && patch.name) || "").trim();
    if(!name) return {ok:false, message:"Tên trường không được để trống."};
    const res = schoolsAction({action:"rename", id, name});
    if(res.status === 200 && res.payload && res.payload.ok){
      refreshSchools();
      return {ok:true, school:loadRegistry().schools[id] || schoolRecord(id, name)};
    }
    return {ok:false, message:(res.payload && res.payload.error) || "Lỗi đổi tên"};
  }

  function schoolInfoForSid(sid){
    const school = loadRegistry().schools[sanitize(sid)];
    if(!school) return null;
    return {schoolId:school.id, schoolName:school.name, scheduleNumber:1, effectiveDate:"", sid:school.id};
  }

  function formatDate(iso){
    if(!iso) return "-";
    try{
      const d = new Date(iso);
      if(isNaN(d.getTime())) return String(iso);
      const pad = n => String(n).padStart(2, "0");
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }catch(_){ return String(iso); }
  }

  const PLAN = {id:"local", name:"Cherry máy này", print:true, unlimited:true};

  window.TKBAuth = {
    isLocal:true,
    noServer:true,
    remoteOnly:false,
    PLANS:{local:PLAN},
    loadRegistry,
    getSession,
    currentUser,
    requireAuth(){ return {ok:true, ctx:currentUser()}; },
    listSchools(){ return Object.values(loadRegistry().schools); },
    listSchoolSchedules(schoolId){ return [scheduleEntry(sanitize(schoolId))]; },
    activeScheduleEntry(schoolId){ return scheduleEntry(sanitize(schoolId)); },
    setActiveSchedule(schoolId){ return {ok:true, sid:sanitize(schoolId), number:1}; },
    scheduleEntrySid(school){ return sanitize(school && school.id); },
    createSchoolSchedule(){
      return {ok:false, message:"Bản không đăng nhập không có nhiều phiên bản TKB cho một trường. Hãy Xuất file .cherry rồi Nhập lại thành trường khác."};
    },
    schoolInfoForSid,
    updateSchoolMeta,
    canPrint(){ return true; },
    canPrintForSchool(){ return true; },
    effectivePlan(){ return PLAN; },
    async logout(){ return true; },
    expireSession(){ },
    redirectAfterLogin(){ return "/app"; },
    formatDate,
    formatMoney(v){ return String(v || 0); },
    refreshSchools,
    sanitizeSchoolId:sanitize,
    currentSchoolId:currentSid
  };

  window.TKBAuthApi = {
    getAuthHeaders(extra){ return Object.assign({"Accept":"application/json"}, extra || {}); },
    getSessionToken(){ return "local"; },
    async apiHealth(){
      try{ return await (await fetch("/api/health", {cache:"no-store"})).json(); }catch(_){ return null; }
    },
    async apiValidateSession(){ return true; },
    getLastSessionFailure(){ return null; }
  };

  function dispatchReady(){
    try{ window.dispatchEvent(new CustomEvent("tkb:auth-ready", {detail:{source:"browser-store"}})); }catch(_){ }
  }

  window.TKBRuntime = {
    async guardProtectedPage(){ dispatchReady(); return true; },
    async checkHealth(){ return true; },
    async validateSession(){ return true; },
    handleAuthExpired(){ },
    rememberAuthReturnTarget(){ },
    startHealthPolling(){ }
  };
})();
