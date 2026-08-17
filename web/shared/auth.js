(function(){
  "use strict";

  const REGISTRY_KEY = "TKB_AUTH_REGISTRY";
  const SCHOOLS_INDEX_KEY = "TKB_SCHOOLS_INDEX";
  const SESSION_KEY = "TKB_SESSION";
  const SUPER_ID = "suadmin";
  const MAX_SCHOOL_USERS = 5;
  const OTP_TTL_MS = 15 * 60 * 1000;
  const EMAIL_VERIFY_OTP_TTL_MS = 60 * 1000;
  const REMOTE_ONLY_AUTH = true;

  function backupLocalRegistryBeforePurge(){
    try{
      const raw = localStorage.getItem(REGISTRY_KEY);
      if(!raw) return;
      const reg = safeParse(raw, null);
      if(registryHasData(reg)){
        sessionStorage.setItem("TKB_AUTH_REGISTRY_BACKUP", raw);
      }
    }catch(_){}
  }

  function readLocalRegistryBackup(){
    try{
      const live = safeParse(localStorage.getItem(REGISTRY_KEY), null);
      if(registryHasData(live)) return live;
      return safeParse(sessionStorage.getItem("TKB_AUTH_REGISTRY_BACKUP"), null);
    }catch(_){
      return null;
    }
  }

  function mergeRegistryRecords(base, incoming){
    const out = safeParse(JSON.stringify(base || emptyRegistry()), emptyRegistry());
    const sections = ["users", "schools", "registeredIps", "otpPending", "deletedSchools", "deletedUsers", "blockedIps"];
    sections.forEach(section => {
      const src = incoming && incoming[section];
      if(!src || typeof src !== "object") return;
      out[section] = out[section] || {};
      Object.keys(src).forEach(key => {
        if(out[section][key] == null) out[section][key] = src[key];
      });
    });
    return syncSchoolsRegistry(normalizeRegistryUsers(out));
  }

  function tryMigrateLocalRegistryToServer(role){
    if(role !== "superadmin") return false;
    const local = readLocalRegistryBackup();
    if(!local || !registryHasData(local)) return false;
    const remote = registryCache || emptyRegistry();
    const localUsers = Object.keys(local.users || {}).length;
    const remoteUsers = Object.keys(remote.users || {}).length;
    const localSchools = Object.keys(local.schools || {}).length;
    const remoteSchools = Object.keys(remote.schools || {}).length;
    if(localUsers <= remoteUsers && localSchools <= remoteSchools) return false;
    const merged = mergeRegistryRecords(remote, local);
    if(!saveRegistry(merged)) return false;
    try{ sessionStorage.removeItem("TKB_AUTH_REGISTRY_BACKUP"); }catch(_){}
    return true;
  }

  function purgeLocalAppData(){
    backupLocalRegistryBeforePurge();
    try{
      const remove = [];
      for(let i = 0; i < localStorage.length; i++){
        const key = String(localStorage.key(i) || "");
        if(
          key === SCHOOLS_INDEX_KEY ||
          key === "TKB_SCHOOL_LIST" ||
          key === "TKB_SCHOOL_NAMES" ||
          key === "TKB_LAST_SCHOOL" ||
          key === "TKB_LAST_SCHOOL_LABEL" ||
          key === "TKB_STORE" ||
          key === "VietSchool_TKB_STORE" ||
          key === "VIETSCHOOL_STORE" ||
          key.startsWith("TKB_STORE::") ||
          key.startsWith("TKB::SCHOOL::")
        ){
          remove.push(key);
        }
      }
      remove.forEach(key => localStorage.removeItem(key));
    }catch(e){
      console.warn("[TKBAuth] local data purge failed", e);
    }
    try{
      if(typeof indexedDB !== "undefined"){
        indexedDB.deleteDatabase("TKB_SQLJS_DB");
      }
    }catch(e){
      console.warn("[TKBAuth] local IndexedDB purge failed", e);
    }
  }

  if(REMOTE_ONLY_AUTH) purgeLocalAppData();

  const MAX_PLAN_PRICING = Object.freeze({
    periodLabel: "1 năm",
    dimension: "classes",
    thresholdClasses: 40,
    tiers: Object.freeze([
      Object.freeze({
        id: "under-40-classes",
        planId: "max1",
        minClasses: 1,
        maxClasses: 39,
        label: "Max 1 · Dưới 40 lớp",
        detail: "Từ 1 đến 39 lớp",
        price: 1000000
      }),
      Object.freeze({
        id: "from-40-classes",
        planId: "max2",
        minClasses: 40,
        maxClasses: null,
        label: "Max 2 · Từ 40 lớp",
        detail: "Không giới hạn số lớp",
        price: 1500000
      })
    ])
  });

  function maxPlanTierForClasses(value){
    const parsed = Number(value);
    const classCount = Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : MAX_PLAN_PRICING.tiers[0].maxClasses;
    return MAX_PLAN_PRICING.tiers.find(tier => (
      tier.maxClasses == null || classCount <= tier.maxClasses
    )) || MAX_PLAN_PRICING.tiers[MAX_PLAN_PRICING.tiers.length - 1];
  }

  function maxPlanPriceForClasses(value){
    return maxPlanTierForClasses(value).price;
  }

  function maxPlanIdForClasses(value){
    return maxPlanTierForClasses(value).planId;
  }

  // Transitional aliases keep an older cached portal from failing while the
  // class-based assets roll out. Values from the retired student selector are
  // mapped to the nearest new tier; all current code must use the class APIs.
  function maxPlanTierForStudents(value){
    const legacyStudentCount = Number(value);
    const equivalentClassCount = Number.isFinite(legacyStudentCount) && legacyStudentCount > 1000
      ? MAX_PLAN_PRICING.thresholdClasses
      : MAX_PLAN_PRICING.tiers[0].maxClasses;
    return maxPlanTierForClasses(equivalentClassCount);
  }

  function maxPlanPriceForStudents(value){
    return maxPlanTierForStudents(value).price;
  }

  const PLANS = {
    free: {
      id: "free",
      label: "Free",
      price: 0,
      durationDays: 0,
      solveLimit: 5,
      print: false,
      color: "#94a3b8",
      glow: "0 0 12px rgb(148 163 184 / 45%)"
    },
    trial: {
      id: "trial",
      label: "Trial",
      price: 0,
      durationDays: 30,
      print: true,
      trial: true,
      color: "#34d399",
      glow: "0 0 16px rgb(52 211 153 / 55%)"
    },
    plus: {
      id: "plus",
      label: "Plus",
      price: 300000,
      durationDays: 30,
      solveLimit: 100,
      print: true,
      color: "#22d3ee",
      glow: "0 0 16px rgb(34 211 238 / 55%)"
    },
    max1: {
      id: "max1",
      label: "Max 1",
      price: 1000000,
      durationDays: 365,
      classLimit: 39,
      unlimitedSolves: true,
      print: true,
      color: "#a855f7",
      glow: "0 0 18px rgb(168 85 247 / 58%)"
    },
    max2: {
      id: "max2",
      label: "Max 2",
      price: 1500000,
      durationDays: 365,
      unlimitedClasses: true,
      unlimitedSolves: true,
      print: true,
      color: "#7c3aed",
      glow: "0 0 20px rgb(124 58 237 / 62%)"
    },
    max: {
      id: "max",
      label: "Max",
      price: MAX_PLAN_PRICING.tiers[0].price,
      priceByClasses: true,
      durationDays: 365,
      unlimitedSolves: true,
      print: true,
      color: "#c084fc",
      glow: "0 0 18px rgb(192 132 252 / 60%)",
      legacyAlias: true
    },
    ultra: {
      id: "ultra",
      label: "Ultra",
      price: 2000000,
      durationDays: 0,
      unlimited: true,
      print: true,
      color: "#fbbf24",
      glow: "0 0 20px rgb(251 191 36 / 65%)"
    }
  };

  const MANAGED_SERVICE = {
    label: "Xếp hộ TKB",
    contact: "Zalo Thầy Ân",
    phone: "0352261815",
    zaloUrl: "https://zalo.me/0352261815"
  };

  const BANK_TRANSFER = {
    bank: "BIDV",
    accountNumber: "0352261815",
    accountName: "Nguyen Hoang An",
    zaloPhone: "0352261815",
    zaloUrl: "https://zalo.me/0352261815"
  };

  function safeParse(raw, fallback){
    try{ return raw ? JSON.parse(raw) : (fallback ?? null); }catch(_){ return fallback ?? null; }
  }

  function nowIso(){ return new Date().toISOString(); }

  function normEmail(v){
    return String(v || "").trim().toLowerCase();
  }

  function isEmail(v){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(v));
  }

  function normLoginId(v){
    const raw = String(v || "").trim();
    if(isEmail(raw)) return normEmail(raw);
    return raw.toLowerCase();
  }

  function normPhone(v){
    return String(v || "").replace(/\D/g, "");
  }

  function isPhone(v){
    const p = normPhone(v);
    return p.length >= 9 && p.length <= 11;
  }

  function formatPhone(v){
    const p = normPhone(v);
    if(p.length === 10) return p.replace(/(\d{4})(\d{3})(\d{3})/, "$1 $2 $3");
    if(p.length === 11) return p.replace(/(\d{4})(\d{3})(\d{4})/, "$1 $2 $3");
    return p;
  }

  function isValidLoginId(v){
    const id = normLoginId(v);
    if(!id || id.length < 3) return false;
    if(isEmail(id)) return false;
    return /^[a-z0-9][a-z0-9._-]*$/.test(id);
  }

  function emailInUse(reg, email){
    const e = normEmail(email);
    if(!e) return false;
    return Object.values(reg.users || {}).some(u => normEmail(u.email) === e);
  }

  function normalizeRegistryUsers(reg){
    let changed = false;
    const users = reg.users || {};
    Object.keys(users).forEach(key => {
      const u = users[key];
      if(!u) return;
      const canonical = isEmail(key) ? normEmail(key) : String(key).trim().toLowerCase();
      if(!canonical || canonical === key) return;
      if(users[canonical]){
        if(u.role === "school_user" && users[canonical].role !== "school_admin"){
          users[canonical] = Object.assign({}, users[canonical], u, { id: canonical });
        }
        delete users[key];
        changed = true;
        return;
      }
      users[canonical] = Object.assign({}, u, { id: canonical });
      delete users[key];
      changed = true;
    });
    if(changed) saveRegistry(reg);
    return reg;
  }

  function findUser(reg, loginId){
    const raw = String(loginId || "").trim();
    if(!raw) return null;
    const canonical = normLoginId(raw);
    if(reg.users[canonical]) return { key: canonical, user: reg.users[canonical] };
    if(reg.users[raw]) return { key: raw, user: reg.users[raw] };
    const hit = Object.entries(reg.users || {}).find(([, u]) => {
      const uid = String(u?.id || "").trim();
      return uid && (uid.toLowerCase() === canonical || uid === raw);
    });
    if(hit) return { key: hit[0], user: hit[1] };
    return null;
  }

  async function hashPassword(password){
    const text = String(password || "");
    if(!text) return "";
    if(window.TKBAuthApi && window.TKBAuthApi.apiHashPassword){
      return window.TKBAuthApi.apiHashPassword(text);
    }
    if(window.crypto && crypto.subtle){
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 5381;
    for(let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
    return "djb2_" + (h >>> 0).toString(16);
  }

  function emptyRegistry(){
    return {
      version: 1,
      users: {},
      schools: {},
      otpPending: {},
      deletedSchools: {},
      deletedUsers: {},
      registeredIps: {}
    };
  }

  function isSchoolDeleted(reg, schoolId){
    const sid = String(schoolId || "");
    return !!(reg?.deletedSchools && reg.deletedSchools[sid]);
  }

  function markSchoolDeleted(reg, schoolId){
    const sid = String(schoolId || "");
    if(!sid) return;
    reg.deletedSchools = reg.deletedSchools || {};
    reg.deletedSchools[sid] = nowIso();
  }

  function markUserDeleted(reg, userId){
    const id = String(userId || "").trim().toLowerCase();
    if(!id) return;
    reg.deletedUsers = reg.deletedUsers || {};
    reg.deletedUsers[id] = nowIso();
  }

  function purgeSchoolLocalData(schoolId){
    const sid = sanitizeStoredSchoolId(schoolId);
    if(!sid) return;
    try{ localStorage.removeItem(schoolStoreKey(sid)); }catch(_){}
    try{
      const list = safeParse(localStorage.getItem("TKB_SCHOOL_LIST"), []) || [];
      const next = (Array.isArray(list) ? list : []).filter(id => sanitizeStoredSchoolId(id) !== sid);
      localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(next));
    }catch(_){}
    try{
      const names = safeParse(localStorage.getItem("TKB_SCHOOL_NAMES"), {}) || {};
      if(names[sid]){
        delete names[sid];
        localStorage.setItem("TKB_SCHOOL_NAMES", JSON.stringify(names));
      }
    }catch(_){}
    try{
      const index = safeParse(localStorage.getItem(SCHOOLS_INDEX_KEY), {}) || {};
      if(index[sid]){
        delete index[sid];
        localStorage.setItem(SCHOOLS_INDEX_KEY, JSON.stringify(index));
      }
    }catch(_){}
    try{
      if(localStorage.getItem("TKB_LAST_SCHOOL") === sid){
        localStorage.removeItem("TKB_LAST_SCHOOL");
        localStorage.removeItem("TKB_LAST_SCHOOL_LABEL");
      }
    }catch(_){}
  }

  function sanitizeStoredSchoolId(raw){
    const SC = window.TKBSchool;
    if(SC && SC.sanitizeSchoolId) return SC.sanitizeSchoolId(raw);
    return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "";
  }

  // Một "tên trường" giống mã trường (in thường, viết liền, không dấu) không phải
  // tên hiển thị thật — chỉ là fallback từ logic cũ. Bỏ qua để giữ tên đầy đủ có dấu.
  function isSidLikeName(value, sid){
    const v = String(value || "").trim();
    if(!v) return true;
    const cleanValue = sanitizeStoredSchoolId(v);
    const cleanSid = sanitizeStoredSchoolId(sid);
    if(cleanValue !== cleanSid) return false;
    return v === v.toLowerCase() && !/[\s\u00C0-\u1EF9]/.test(v);
  }

  function bestSchoolName(sid, candidates){
    for(const c of (candidates || [])){
      const v = String(c || "").trim();
      if(v && !isSidLikeName(v, sid)) return v;
    }
    return String(sid || "").trim();
  }

  function readSchoolMetaFromStore(schoolId){
    const sid = String(schoolId || "");
    const SC = window.TKBSchool;
    const key = SC && SC.lsKey ? SC.lsKey(sid) : `TKB_STORE::${sid}`;
    const data = safeParse(localStorage.getItem(key), {}) || {};
    const meta = data.tkbConstraints?.meta || {};
    const names = SC && SC.schoolNameMap ? SC.schoolNameMap() : safeParse(localStorage.getItem("TKB_SCHOOL_NAMES"), {}) || {};
    const nameCandidates = [meta.schoolName, names[sid]].filter(v => !isSidLikeName(v, sid));
    return {
      name: String(nameCandidates[0] || "").trim(),
      scheduleNumber: String(meta.scheduleNumber || "").trim(),
      effectiveDate: String(meta.effectiveDate || "").trim()
    };
  }

  function discoverLegacySchoolIds(){
    const ids = [];
    const add = (raw) => {
      const sid = sanitizeStoredSchoolId(raw);
      if(!sid || sid === "default" || ids.includes(sid)) return;
      ids.push(sid);
    };
    const list = safeParse(localStorage.getItem("TKB_SCHOOL_LIST"), []) || [];
    if(Array.isArray(list)) list.forEach(add);
    try{
      for(let i = 0; i < localStorage.length; i++){
        const key = String(localStorage.key(i) || "");
        const match = key.match(/^TKB_STORE::(.+)$/);
        if(match) add(match[1]);
      }
    }catch(_){}
    return ids;
  }

  function persistSchoolsIndex(reg){
    if(REMOTE_ONLY_AUTH) return;
    const schools = reg?.schools || {};
    try{
      localStorage.setItem(SCHOOLS_INDEX_KEY, JSON.stringify(schools));
    }catch(e){
      console.warn("[TKBAuth] schools index save failed", e);
    }
  }

  function mergeSchoolsIndexInto(reg){
    if(REMOTE_ONLY_AUTH) return reg;
    const index = safeParse(localStorage.getItem(SCHOOLS_INDEX_KEY), null);
    if(!index || typeof index !== "object" || Array.isArray(index)) return reg;
    reg.schools = reg.schools || {};
    Object.keys(index).forEach(id => {
      const sid = sanitizeStoredSchoolId(id);
      if(!sid || isSchoolDeleted(reg, sid)) return;
      const row = index[id];
      if(!row || typeof row !== "object") return;
      reg.schools[sid] = Object.assign({}, row, reg.schools[sid] || {}, { id: sid });
    });
    return reg;
  }

  function schoolStoreKey(schoolId){
    const SC = window.TKBSchool;
    if(SC && SC.lsKey) return SC.lsKey(schoolId);
    return `TKB_STORE::${sanitizeStoredSchoolId(schoolId)}`;
  }

  function remoteSchoolStoreUrl(schoolId){
    return `/api/school/store?id=${encodeURIComponent(sanitizeStoredSchoolId(schoolId))}`;
  }

  function loadRemoteSchoolStoreSync(schoolId){
    try{
      if(typeof XMLHttpRequest === "undefined") return null;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", remoteSchoolStoreUrl(schoolId), false);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.send(null);
      if(xhr.status < 200 || xhr.status >= 300) return null;
      return safeParse(xhr.responseText, {});
    }catch(_){
      return null;
    }
  }

  function saveRemoteSchoolStoreSync(schoolId, data){
    try{
      if(typeof XMLHttpRequest === "undefined") return false;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", remoteSchoolStoreUrl(schoolId), false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.send(JSON.stringify(data || {}));
      return xhr.status >= 200 && xhr.status < 300;
    }catch(_){
      return false;
    }
  }

  function hasSchoolStore(schoolId){
    try{
      return !!localStorage.getItem(schoolStoreKey(schoolId));
    }catch(_){
      return false;
    }
  }

  function persistSchoolRecord(school){
    if(!school || !school.id) return;
    const reg = loadRegistry();
    reg.schools = reg.schools || {};
    reg.schools[school.id] = Object.assign({}, reg.schools[school.id] || {}, school, { id: school.id, updatedAt: nowIso() });
    saveRegistry(reg);
  }

  function findSchoolAdmin(reg, schoolId){
    const sid = String(schoolId || "");
    return Object.values(reg.users || {}).find(u =>
      u.role === "school_admin" && String(u.schoolId || "") === sid
    ) || null;
  }

  function syncSchoolsRegistry(reg){
    let changed = false;
    reg.schools = reg.schools || {};
    reg.users = reg.users || {};
    if(Array.isArray(reg.schools)){
      const obj = {};
      reg.schools.forEach(row => { if(row && row.id) obj[row.id] = row; });
      reg.schools = obj;
      changed = true;
    }
    mergeSchoolsIndexInto(reg);

    const upsert = (schoolId, patch) => {
      const sid = String(schoolId || "");
      if(!sid) return;
      const cur = reg.schools[sid];
      const next = Object.assign({
        id: sid,
        name: sid,
        ownerEmail: "",
        ownerPhone: "",
        ownerLoginId: "",
        plan: "free",
        active: true,
        verified: false,
        scheduleNumber: "",
        effectiveDate: "",
        expiresAt: "",
        createdAt: nowIso()
      }, cur || {}, patch || {}, { id: sid });
      const curCmp = Object.assign({}, cur || {});
      const nextCmp = Object.assign({}, next);
      delete curCmp.updatedAt;
      delete nextCmp.updatedAt;
      if(!cur || JSON.stringify(curCmp) !== JSON.stringify(nextCmp)){
        next.updatedAt = nowIso();
        reg.schools[sid] = next;
        changed = true;
      }
    };

    Object.values(reg.users).forEach(user => {
      if(user.role !== "school_admin" || !user.schoolId) return;
      const sid = String(user.schoolId);
      const meta = readSchoolMetaFromStore(sid);
      const cur = reg.schools[sid] || {};
      upsert(sid, {
        name: bestSchoolName(sid, [meta.name, user.displayName, cur.name]),
        ownerEmail: user.email || cur.ownerEmail || "",
        ownerPhone: user.phone || cur.ownerPhone || "",
        ownerLoginId: user.id || cur.ownerLoginId || "",
        plan: cur.plan || "free",
        active: cur.active !== false,
        verified: user.emailVerified === true || cur.verified === true,
        scheduleNumber: meta.scheduleNumber || cur.scheduleNumber || "",
        effectiveDate: meta.effectiveDate || cur.effectiveDate || "",
        expiresAt: cur.expiresAt || ""
      });
    });

    if(!REMOTE_ONLY_AUTH){
      discoverLegacySchoolIds().forEach(sid => {
        if(isSchoolDeleted(reg, sid) || reg.schools[sid]) return;
        const admin = findSchoolAdmin(reg, sid);
        const meta = readSchoolMetaFromStore(sid);
        if(!admin && !meta.name && !hasSchoolStore(sid)) return;
        upsert(sid, {
          name: bestSchoolName(sid, [meta.name, admin?.displayName]),
          ownerEmail: admin?.email || admin?.id || "",
          scheduleNumber: meta.scheduleNumber,
          effectiveDate: meta.effectiveDate
        });
      });

      const names = safeParse(localStorage.getItem("TKB_SCHOOL_NAMES"), {}) || {};
      Object.entries(names).forEach(([rawId, label]) => {
        const sid = sanitizeStoredSchoolId(rawId);
        if(!sid || sid === "default" || isSchoolDeleted(reg, sid)) return;
        const admin = findSchoolAdmin(reg, sid);
        const meta = readSchoolMetaFromStore(sid);
        const cur = reg.schools[sid] || {};
        upsert(sid, {
          name: bestSchoolName(sid, [label, meta.name, cur.name, admin?.displayName]),
          ownerEmail: cur.ownerEmail || admin?.email || admin?.id || "",
          scheduleNumber: meta.scheduleNumber || cur.scheduleNumber || "",
          effectiveDate: meta.effectiveDate || cur.effectiveDate || ""
        });
      });
    }

    Object.values(reg.users).forEach(user => {
      if(user.role !== "school_user" || !user.schoolId || reg.schools[user.schoolId]) return;
      const sid = String(user.schoolId);
      if(isSchoolDeleted(reg, sid)) return;
      const admin = findSchoolAdmin(reg, sid);
      const meta = readSchoolMetaFromStore(sid);
      upsert(sid, {
        name: bestSchoolName(sid, [meta.name, admin?.displayName]),
        ownerEmail: admin?.email || admin?.id || ""
      });
    });

    // Loại bỏ các bản ghi "ma": chính là mã phiên bản TKB (shortId + số thứ tự)
    // của một trường thật, bị phát hiện nhầm thành trường riêng.
    const realShortIds = [];
    Object.values(reg.schools).forEach(s => { if(s && s.shortId) realShortIds.push(String(s.shortId)); });
    if(realShortIds.length){
      Object.keys(reg.schools).forEach(id => {
        const s = reg.schools[id];
        if(!s || s.shortId || s.ownerLoginId) return;
        const isVersionSid = realShortIds.some(sh => new RegExp("^" + sh + "\\d+$").test(id));
        if(isVersionSid){ delete reg.schools[id]; changed = true; }
      });
    }

    if(changed) saveRegistry(reg);
    else persistSchoolsIndex(reg);
    return reg;
  }

  function rebuildSchoolsFromAllSources(){
    if(REMOTE_ONLY_AUTH){
      const reg = loadRegistry();
      return Object.values(reg.schools || {});
    }
    let reg = safeParse(localStorage.getItem(REGISTRY_KEY), null);
    if(!reg || typeof reg !== "object") reg = emptyRegistry();
    reg.users = reg.users || {};
    reg.schools = {};
    reg.otpPending = reg.otpPending || {};
    reg.deletedSchools = reg.deletedSchools || {};
    reg = normalizeRegistryUsers(reg);
    reg = syncSchoolsRegistry(reg);
    persistSchoolsIndex(reg);
    saveRegistry(reg);
    return Object.values(reg.schools || {});
  }

  const REGISTRY_API = "/api/auth/registry";
  let remoteSyncPromise = null;
  let remoteRegistryLoaded = false;
  let remoteRegistryOnline = false;
  let registryCache = null;
  let registryWriteSeq = 0;

  function registryHasData(reg){
    return !!(
      reg && typeof reg === "object" && (
        Object.keys(reg.users || {}).length ||
        Object.keys(reg.schools || {}).length ||
        Object.keys(reg.deletedSchools || {}).length
      )
    );
  }

  function cacheRegistry(reg){
    if(!reg || typeof reg !== "object") return;
    registryCache = reg;
    try{ localStorage.removeItem(REGISTRY_KEY); }catch(_){}
    persistSchoolsIndex(reg);
  }

  function requestRemoteRegistrySync(){
    if(window.TKBAuthApi && window.TKBAuthApi.apiFetchRegistrySync){
      return window.TKBAuthApi.apiFetchRegistrySync();
    }
    try{
      if(typeof XMLHttpRequest === "undefined") return null;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", REGISTRY_API, false);
      xhr.setRequestHeader("Accept", "application/json");
      const token = window.TKBAuthApi && window.TKBAuthApi.getSessionToken ? window.TKBAuthApi.getSessionToken() : "";
      if(token) xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.send(null);
      if(xhr.status < 200 || xhr.status >= 300) return null;
      return safeParse(xhr.responseText, null);
    }catch(e){
      return null;
    }
  }

  function postRemoteRegistrySync(reg){
    if(window.TKBAuthApi && window.TKBAuthApi.apiSaveRegistrySync){
      const ok = window.TKBAuthApi.apiSaveRegistrySync(reg);
      remoteRegistryOnline = remoteRegistryOnline || ok;
      return ok;
    }

    try{
      if(typeof XMLHttpRequest === "undefined") return false;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", REGISTRY_API, false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Accept", "application/json");
      const token = window.TKBAuthApi && window.TKBAuthApi.getSessionToken ? window.TKBAuthApi.getSessionToken() : "";
      if(token) xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.send(JSON.stringify(reg || emptyRegistry()));
      const ok = xhr.status >= 200 && xhr.status < 300;
      remoteRegistryOnline = remoteRegistryOnline || ok;
      return ok;
    }catch(e){
      return false;
    }
  }

  async function postRemoteRegistry(reg){
    if(window.TKBAuthApi && window.TKBAuthApi.apiSaveRegistry){
      const ok = await window.TKBAuthApi.apiSaveRegistry(reg);
      remoteRegistryOnline = ok || remoteRegistryOnline;
      return ok;
    }
    try{
      const headers = { "Content-Type": "application/json", "Accept": "application/json" };
      const token = window.TKBAuthApi && window.TKBAuthApi.getSessionToken ? window.TKBAuthApi.getSessionToken() : "";
      if(token) headers.Authorization = "Bearer " + token;
      const resp = await fetch(REGISTRY_API, {
        method: "POST",
        headers,
        body: JSON.stringify(reg || emptyRegistry()),
        cache: "no-store"
      });
      remoteRegistryOnline = resp.ok || remoteRegistryOnline;
      return resp.ok;
    }catch(e){
      return false;
    }
  }

  function syncRemoteRegistryBlocking(){
    if(remoteRegistryLoaded) return;
    remoteRegistryLoaded = true;
    const token = window.TKBAuthApi && window.TKBAuthApi.getSessionToken ? window.TKBAuthApi.getSessionToken() : "";
    if(!token){
      cacheRegistry(emptyRegistry());
      return;
    }
    const remote = requestRemoteRegistrySync();
    if(remote && typeof remote === "object"){
      remoteRegistryOnline = true;
      cacheRegistry(registryHasData(remote) ? remote : emptyRegistry());
      return;
    }
    cacheRegistry(emptyRegistry());
  }

  function syncRemoteRegistry(){
    if(!remoteSyncPromise){
      const startedAtSeq = registryWriteSeq;
      const headers = window.TKBAuthApi && window.TKBAuthApi.getAuthHeaders
        ? window.TKBAuthApi.getAuthHeaders()
        : { "Accept": "application/json" };
      remoteSyncPromise = fetch(REGISTRY_API, {
        headers,
        cache: "no-store"
      }).then(r => r.ok ? r.json() : null).then(data => {
        remoteRegistryLoaded = true;
        if(startedAtSeq !== registryWriteSeq) return;
        if(data && typeof data === "object"){
          remoteRegistryOnline = true;
          cacheRegistry(registryHasData(data) ? data : emptyRegistry());
        }
      }).catch(e => console.warn("Remote sync failed", e));
    }
    return remoteSyncPromise;
  }
  syncRemoteRegistryBlocking();
  syncRemoteRegistry();

  function loadRegistry(){
    syncRemoteRegistryBlocking();
    let reg = registryCache;
    if(!reg || typeof reg !== "object") reg = emptyRegistry();
    reg.users = reg.users || {};
    reg.schools = reg.schools || {};
    reg.otpPending = reg.otpPending || {};
    reg.deletedSchools = reg.deletedSchools || {};
    reg.deletedUsers = reg.deletedUsers || {};
    reg.blockedIps = reg.blockedIps || {};
    reg.registeredIps = reg.registeredIps || {};
    mergeSchoolsIndexInto(reg);
    reg = syncSchoolsRegistry(normalizeRegistryUsers(reg));
    if(migrateRegisteredIps(reg)) saveRegistry(reg);
    return reg;
  }

  function saveRegistry(reg){
    const saved = postRemoteRegistrySync(reg);
    if(saved){
      registryWriteSeq += 1;
      cacheRegistry(reg);
    }else{
      postRemoteRegistry(reg).then(ok => {
        if(ok){
          registryWriteSeq += 1;
          cacheRegistry(reg);
        }
      }).catch(()=>{});
    }
    return saved;
  }

  function remoteSaveError(){
    return { ok: false, message: "Không lưu được dữ liệu tài khoản lên VPS. Kiểm tra backend/kết nối rồi thử lại." };
  }

  function getSession(){
    let session = null;
    try{ session = safeParse(localStorage.getItem(SESSION_KEY), null); }catch(_){}
    if(session) return session;

    // Migrate sessions created by older builds so closing or refreshing a tab
    // does not orphan the server-side session lock.
    try{
      session = safeParse(sessionStorage.getItem(SESSION_KEY), null);
      if(session){
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        sessionStorage.removeItem(SESSION_KEY);
      }
    }catch(_){}
    return session;
  }

  function setSession(session){
    if(!session){
      try{ localStorage.removeItem(SESSION_KEY); }catch(_){}
      try{ sessionStorage.removeItem(SESSION_KEY); }catch(_){}
      return;
    }
    try{
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      sessionStorage.removeItem(SESSION_KEY);
    }catch(_){
      // Keep authentication usable in privacy modes that block localStorage.
      try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); }catch(__){}
    }
  }

  function currentUser(){
    const s = getSession();
    if(!s || !s.userId) return null;
    const reg = loadRegistry();
    const found = findUser(reg, s.userId);
    if(!found || found.user.active === false) return null;
    return { session: s, user: found.user, registry: reg };
  }

  function schoolIdFromName(name){
    const SC = window.TKBSchool;
    if(SC && SC.sanitizeSchoolId) return SC.sanitizeSchoolId(name);
    return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "school";
  }

  function planDurationLabel(plan){
    if(!plan) return "-";
    if(plan.unlimited) return "Unlimited";
    if(plan.durationDays) return plan.durationDays + " ngày sử dụng";
    return "Không giới hạn thời gian";
  }

  function normalizedPlanId(planId, school){
    const raw = String(planId || school?.plan || "free").trim().toLowerCase();
    if(raw !== "max") return PLANS[raw] ? raw : "free";
    const savedTier = String(school?.maxPlanPricingTier || "").trim().toLowerCase();
    if(savedTier === "under-40-classes") return "max1";
    if(savedTier === "from-40-classes") return "max2";
    const classCount = Number(school?.classCount);
    if(Number.isFinite(classCount) && classCount > 0){
      return classCount < MAX_PLAN_PRICING.thresholdClasses ? "max1" : "max2";
    }
    // A legacy Max record without class metadata must not unexpectedly lose
    // capacity when the two explicit plans roll out.
    return "max2";
  }

  function effectivePlan(school){
    if(!school) return PLANS.free;
    const planId = normalizedPlanId(school.plan, school);
    const base = PLANS[planId] || PLANS.free;
    if(planId === "free" || base.unlimited) return base;
    const exp = school.expiresAt ? Date.parse(school.expiresAt) : 0;
    if(exp && Date.now() > exp){
      return Object.assign({}, PLANS.free, { expiredFrom: planId });
    }
    return base;
  }

  function canAddSchoolUsers(school){
    const plan = effectivePlan(school);
    return plan.id === "plus" || plan.id === "max1" || plan.id === "max2" || plan.id === "ultra" || plan.id === "trial";
  }

  function canPrintForSchool(school){
    if(!school || school.active === false) return false;
    return !!effectivePlan(school).print;
  }

  function canPrint(){
    const ctx = currentUser();
    if(!ctx) return false;
    if(ctx.user.role === "superadmin") return true;
    const schoolId = ctx.session.schoolId || ctx.user.schoolId;
    if(!schoolId) return false;
    return canPrintForSchool(ctx.registry.schools[schoolId]);
  }

  function planBadgeHtml(planId, school){
    const plan = school ? effectivePlan(school) : (PLANS[planId] || PLANS.free);
    const id = plan.id || planId || "free";
    const icon = id === "ultra" ? "&#9733;" : (id === "max" || id === "max1" || id === "max2") ? "&#9733;" : id === "plus" ? "&#9670;" : id === "trial" ? "&#9678;" : "&#9675;";
    return `<span class="tkb-plan-badge tkb-plan-${id}" style="--plan-color:${plan.color};--plan-glow:${plan.glow}"><span class="tkb-plan-icon" aria-hidden="true">${icon}</span>${plan.label}</span>`;
  }

  async function login(loginId, password, clientIp){
    const id = String(loginId || "").trim();
    const pw = String(password || "");
    if(!id || !pw) return { ok: false, message: "Nhập đầy đủ tài khoản và mật khẩu." };

    const ip = String(clientIp || "").trim();
    let apiResult = null;
    if(window.TKBAuthApi && window.TKBAuthApi.apiLogin){
      try{
        apiResult = await window.TKBAuthApi.apiLogin(id, pw, ip);
      }catch(e){
        return { ok: false, message: "Không kết nối được backend. Chạy start.py rồi thử lại." };
      }
    }
    if(!apiResult || apiResult.ok !== true){
      return {
        ok: false,
        message: (apiResult && apiResult.message) || "Đăng nhập thất bại."
      };
    }

    const reg = loadRegistry();
    const found = findUser(reg, id);
    const userKey = (apiResult.user && apiResult.user.id) || (found && found.key) || id;
    const user = found ? found.user : (apiResult.user || {});
    const schoolId = apiResult.schoolId || user.schoolId || "";
    const school = schoolId ? reg.schools[schoolId] : null;

    recordClientIp(reg, ip, schoolId, userKey);
    saveRegistry(reg);

    const session = {
      userId: userKey,
      role: apiResult.role || user.role || "",
      schoolId: schoolId || "",
      displayName: (apiResult.user && apiResult.user.displayName) || user.displayName || userKey,
      sessionToken: apiResult.sessionToken || "",
      loginAt: nowIso()
    };
    setSession(session);
    remoteRegistryLoaded = false;
    remoteSyncPromise = null;
    syncRemoteRegistryBlocking();
    tryMigrateLocalRegistryToServer(session.role);
    syncRemoteRegistry();

    if(!REMOTE_ONLY_AUTH && schoolId && window.TKBSchool){
      try{
        localStorage.setItem("TKB_LAST_SCHOOL", schoolId);
        const label = school?.name || schoolId;
        localStorage.setItem("TKB_LAST_SCHOOL_LABEL", label);
        if(window.TKBSchool.setSchoolName) window.TKBSchool.setSchoolName(schoolId, label);
        if(typeof addSchoolToList === "function") addSchoolToList(schoolId);
      }catch(_){}
    }

    return { ok: true, role: session.role, schoolId: session.schoolId };
  }

  function expireSession(){
    setSession(null);
    registryCache = emptyRegistry();
    remoteRegistryLoaded = false;
    remoteSyncPromise = null;
  }

  async function logout(){
    if(window.TKBAuthApi && window.TKBAuthApi.apiLogout){
      try{ await window.TKBAuthApi.apiLogout(); }catch(_){}
    }
    expireSession();
  }

  function randomOtp(){
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function randomPassword(len){
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const n = Number(len || 10);
    let out = "";
    for(let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function findUserByLoginOrEmail(reg, loginOrEmail){
    const raw = String(loginOrEmail || "").trim();
    if(!raw) return null;
    const byLogin = findUser(reg, raw);
    if(byLogin) return byLogin;
    const email = normEmail(raw);
    if(!isEmail(email)) return null;
    const hit = Object.entries(reg.users || {}).find(([, u]) => normEmail(u.email) === email);
    if(hit) return { key: hit[0], user: hit[1] };
    return null;
  }

  function otpKeyPasswordReset(userKey){
    return "pwd:" + String(userKey || "");
  }

  function resolveUserEmail(reg, user){
    const direct = normEmail(user?.email);
    if(isEmail(direct)) return direct;
    if(user?.role === "school_user" && user.schoolId){
      const admin = findSchoolAdmin(reg, user.schoolId);
      const adminEmail = normEmail(admin?.email);
      if(isEmail(adminEmail)) return adminEmail;
    }
    if(user?.role === "school_admin" && user.schoolId){
      const school = reg.schools[user.schoolId];
      const ownerEmail = normEmail(school?.ownerEmail);
      if(isEmail(ownerEmail)) return ownerEmail;
    }
    return "";
  }

  async function requestPasswordReset(loginOrEmail){
    const reg = loadRegistry();
    const found = findUserByLoginOrEmail(reg, loginOrEmail);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản hoặc email." };
    if(found.user.role === "superadmin"){
      return { ok: false, message: "Super admin vui lòng liên hệ hỗ trợ trực tiếp." };
    }
    if(found.user.role === "school_user"){
      return { ok: false, message: "Đây là tài khoản phụ. Vui lòng liên hệ admin trường để được đổi mật khẩu." };
    }
    if(found.user.active === false){
      return { ok: false, message: "Tài khoản đã bị khóa." };
    }

    const email = resolveUserEmail(reg, found.user);
    if(!isEmail(email)){
      return { ok: false, message: "Tài khoản chưa có email. Liên hệ admin trường hoặc Zalo hỗ trợ." };
    }

    const otp = randomOtp();
    reg.otpPending[otpKeyPasswordReset(found.key)] = {
      code: otp,
      expiresAt: Date.now() + OTP_TTL_MS,
      type: "password_reset",
      userId: found.key,
      email
    };
    if(!saveRegistry(reg)) return remoteSaveError();

    const sent = await sendOtpEmail(email, otp, "password_reset");
    return {
      ok: true,
      email,
      emailSent: sent,
      demoOtp: sent ? undefined : otp,
      message: sent
        ? ("Đã gửi mã xác thực tới " + email + ". Kiểm tra hộp thư (kể cả mục Spam).")
        : "Đã tạo mã xác thực (chưa gửi được email — demo hiển thị trên màn hình)."
    };
  }

  async function confirmPasswordReset(loginOrEmail, code){
    const reg = loadRegistry();
    const found = findUserByLoginOrEmail(reg, loginOrEmail);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản hoặc email." };

    const pendingKey = otpKeyPasswordReset(found.key);
    const pending = reg.otpPending[pendingKey];
    if(!pending || pending.type !== "password_reset"){
      return { ok: false, message: "Chưa có yêu cầu đặt lại mật khẩu. Bấm Gửi mã trước." };
    }
    if(Date.now() > Number(pending.expiresAt || 0)){
      delete reg.otpPending[pendingKey];
      saveRegistry(reg);
      return { ok: false, message: "Mã đã hết hạn. Gửi mã mới." };
    }
    if(String(code || "").trim() !== String(pending.code || "")){
      return { ok: false, message: "Mã xác thực không đúng." };
    }

    const newPassword = randomPassword(10);
    found.user.passwordHash = await hashPassword(newPassword);
    found.user.updatedAt = nowIso();
    reg.users[found.key] = found.user;
    delete reg.otpPending[pendingKey];
    if(!saveRegistry(reg)) return remoteSaveError();

    return {
      ok: true,
      email: pending.email,
      demoNewPassword: newPassword,
      message: "Mật khẩu mới đã gửi tới email (demo: hiển thị bên dưới). Hãy đăng nhập và đổi mật khẩu trong Quản lý."
    };
  }

  async function registerSchool(payload){
    const loginId = normLoginId(payload?.loginId);
    const email = normEmail(payload?.email);
    const phone = normPhone(payload?.phone);
    const password = String(payload?.password || "");
    const schoolName = String(payload?.schoolName || "").trim();
    const scheduleNumber = String(payload?.scheduleNumber || "").trim();
    const effectiveDate = String(payload?.effectiveDate || "").trim();
    const clientIp = String(payload?.clientIp || "").trim();

    if(!isValidLoginId(loginId)) return { ok: false, message: "Tên đăng nhập tối thiểu 3 ký tự, chỉ chữ/số, không dùng email." };
    if(!isEmail(email)) return { ok: false, message: "Email không hợp lệ." };
    if(!isPhone(phone)) return { ok: false, message: "Số điện thoại không hợp lệ (9–11 số)." };
    if(password.length < 6) return { ok: false, message: "Mật khẩu tối thiểu 6 ký tự." };
    if(!schoolName) return { ok: false, message: "Nhập tên trường." };
    if(!scheduleNumber) return { ok: false, message: "Nhập số TKB." };
    if(!effectiveDate) return { ok: false, message: "Chọn ngày áp dụng TKB." };

    if(window.TKBAuthApi && window.TKBAuthApi.apiRegister){
      const res = await window.TKBAuthApi.apiRegister({
        loginId,
        email,
        phone,
        password,
        schoolName,
        scheduleNumber: Number(scheduleNumber) || 1,
        effectiveDate,
        clientIp
      });
      if(!res.ok) return res;
      const firstScheduleSid = res.scheduleSid || "";
      const schoolId = res.schoolId || "";
      if(!REMOTE_ONLY_AUTH && firstScheduleSid){
        seedSchoolMeta(firstScheduleSid, schoolName, String(scheduleNumber), effectiveDate, {
          schoolId,
          ownerLoginId: res.loginId || loginId,
          scheduleSid: firstScheduleSid
        });
        if(window.TKBSchool){
          try{
            window.TKBSchool.setSchoolName(firstScheduleSid, schoolName);
            localStorage.setItem("TKB_LAST_SCHOOL", firstScheduleSid);
            localStorage.setItem("TKB_LAST_SCHOOL_LABEL", schoolName);
          }catch(_){}
        }
      }
      return {
        ok: true,
        loginId: res.loginId || loginId,
        schoolId,
        message: res.message || "Đăng ký thành công. Đăng nhập bằng tên đăng nhập."
      };
    }

    const reg = loadRegistry();
    if(clientIp && registeredIpHit(reg, clientIp)){
      return { ok: false, message: "IP này đã được dùng để đăng ký tài khoản trường. Mỗi IP chỉ được đăng ký 1 lần." };
    }
    if(clientIp && isIpBlocked(reg, clientIp)){
      return { ok: false, message: "IP của bạn đã bị khóa. Liên hệ quản trị." };
    }
    if(reg.users[loginId]) return { ok: false, message: "Tên đăng nhập đã tồn tại." };
    if(emailInUse(reg, email)) return { ok: false, message: "Email đã được đăng ký." };

    const schoolId = generateSchoolId(reg);

    const hash = await hashPassword(password);
    const ts = nowIso();
    const shortId = generateShortId();

    const school = {
      id: schoolId,
      shortId,
      name: schoolName,
      ownerEmail: email,
      ownerPhone: phone,
      ownerLoginId: loginId,
      plan: "free",
      active: true,
      verified: false,
      scheduleNumber,
      effectiveDate,
      expiresAt: "",
      trialUsed: false,
      ips: clientIp ? [clientIp] : [],
      lastIp: clientIp || "",
      createdAt: ts,
      updatedAt: ts
    };

    reg.users[loginId] = {
      id: loginId,
      passwordHash: hash,
      role: "school_admin",
      schoolId,
      displayName: schoolName,
      email,
      phone,
      active: true,
      emailVerified: false,
      ips: clientIp ? [clientIp] : [],
      lastIp: clientIp || "",
      createdAt: ts,
      updatedAt: ts
    };
    const firstScheduleNumber = Number(scheduleNumber) || 1;
    const firstScheduleSid = scheduleEntrySid(school, firstScheduleNumber);
    school.activeSchedule = firstScheduleNumber;
    school.schedules = [{
      number: firstScheduleNumber,
      effectiveDate,
      sid: firstScheduleSid,
      original: true,
      createdAt: ts
    }];
    reg.schools[schoolId] = school;

    recordRegistrationIp(reg, clientIp, schoolId, loginId, ts);
    if(!saveRegistry(reg)) return remoteSaveError();
    if(!REMOTE_ONLY_AUTH) persistSchoolRecord(reg.schools[schoolId]);
    seedSchoolMeta(firstScheduleSid, schoolName, String(firstScheduleNumber), effectiveDate, {
      schoolId,
      ownerLoginId: loginId,
      scheduleSid: firstScheduleSid
    });

    if(!REMOTE_ONLY_AUTH && window.TKBSchool){
      try{
        window.TKBSchool.setSchoolName(firstScheduleSid, schoolName);
        localStorage.setItem("TKB_LAST_SCHOOL", firstScheduleSid);
        localStorage.setItem("TKB_LAST_SCHOOL_LABEL", schoolName);
      }catch(_){}
    }
    if(!REMOTE_ONLY_AUTH) try{
      const list = safeParse(localStorage.getItem("TKB_SCHOOL_LIST"), []) || [];
      if(!list.includes(firstScheduleSid)){
        list.push(firstScheduleSid);
        localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(list));
      }
    }catch(_){}

    return {
      ok: true,
      loginId,
      schoolId,
      message: "Đăng ký thành công. Đăng nhập bằng tên đăng nhập, sau đó xác thực email trong mục Quản lý."
    };
  }

  function otpKeyForUser(userKey){
    return "email:" + String(userKey || "");
  }

  async function requestEmailVerification(loginId){
    const reg = loadRegistry();
    const found = findUser(reg, loginId);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản." };
    const user = found.user;
    if(user.role !== "school_admin") return { ok: false, message: "Chỉ admin trường mới xác thực email tại đây." };
    if(user.emailVerified) return { ok: false, message: "Email đã được xác thực." };

    const email = normEmail(user.email);
    if(!isEmail(email)) return { ok: false, message: "Email không hợp lệ. Cập nhật email trước khi gửi mã." };

    const otp = randomOtp();
    const expiresAt = Date.now() + EMAIL_VERIFY_OTP_TTL_MS;
    reg.otpPending[otpKeyForUser(found.key)] = {
      code: otp,
      expiresAt,
      type: "email_verify",
      userId: found.key,
      email
    };
    if(!saveRegistry(reg)) return remoteSaveError();

    const sent = await sendOtpEmail(email, otp, "email_verify");
    return {
      ok: true,
      email,
      emailSent: sent,
      demoOtp: sent ? undefined : otp,
      expiresAt,
      ttlMs: EMAIL_VERIFY_OTP_TTL_MS,
      message: sent
        ? ("Mã xác thực đã được gửi tới " + email + ". Kiểm tra hộp thư (kể cả mục Spam).")
        : "Mã xác thực đã được tạo (chưa gửi được email — demo hiển thị trên màn hình)."
    };
  }

  async function verifyAccountEmail(loginId, code){
    const reg = loadRegistry();
    const found = findUser(reg, loginId);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản." };

    const pendingKey = otpKeyForUser(found.key);
    const pending = reg.otpPending[pendingKey];
    if(!pending || pending.type !== "email_verify"){
      return { ok: false, message: "Chưa có yêu cầu xác thực. Bấm Gửi mã trước." };
    }
    if(Date.now() > Number(pending.expiresAt || 0)){
      delete reg.otpPending[pendingKey];
      saveRegistry(reg);
      return { ok: false, message: "Mã đã hết hạn. Gửi mã mới." };
    }
    if(String(code || "").trim() !== String(pending.code || "")){
      return { ok: false, message: "Mã xác thực không đúng." };
    }

    found.user.emailVerified = true;
    found.user.updatedAt = nowIso();
    const school = reg.schools[found.user.schoolId];
    let trialGranted = false;
    if(school){
      school.verified = true;
      school.ownerEmail = normEmail(found.user.email) || school.ownerEmail;
      // Kích hoạt dùng thử 30 ngày lần đầu tiên khi xác thực email (nếu đang Free và chưa từng dùng thử)
      const curPlan = String(school.plan || "free").toLowerCase();
      if(curPlan === "free" && !school.trialUsed){
        const exp = new Date();
        exp.setDate(exp.getDate() + (PLANS.trial.durationDays || 30));
        school.plan = "trial";
        school.expiresAt = exp.toISOString();
        school.trialUsed = true;
        trialGranted = true;
      }
      school.updatedAt = nowIso();
    }

    delete reg.otpPending[pendingKey];
    if(!saveRegistry(reg)) return remoteSaveError();
    if(school) persistSchoolRecord(school);

    return {
      ok: true,
      trialGranted,
      message: trialGranted
        ? "Email đã xác thực! Đã kích hoạt gói Trial 30 ngày."
        : "Email đã được xác thực."
    };
  }

  function updateAccountContact(loginId, patch){
    const reg = loadRegistry();
    const found = findUser(reg, loginId);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản." };
    const user = found.user;
    if(user.role !== "school_admin") return { ok: false, message: "Không được phép." };

    const school = reg.schools[user.schoolId];
    if(patch.email != null){
      if(user.emailVerified) return { ok: false, message: "Email đã xác thực, không đổi được." };
      const email = normEmail(patch.email);
      if(!isEmail(email)) return { ok: false, message: "Email không hợp lệ." };
      if(emailInUse(reg, email) && normEmail(user.email) !== email){
        return { ok: false, message: "Email đã được dùng bởi tài khoản khác." };
      }
      user.email = email;
      if(school) school.ownerEmail = email;
    }
    if(patch.phone != null){
      const phone = normPhone(patch.phone);
      if(!isPhone(phone)) return { ok: false, message: "Số điện thoại không hợp lệ." };
      user.phone = phone;
      if(school) school.ownerPhone = phone;
    }

    user.updatedAt = nowIso();
    if(school) school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    if(school) persistSchoolRecord(school);
    return { ok: true };
  }

  async function verifyEmailOtp(email, code){
    const key = normEmail(email);
    const reg = loadRegistry();
    const pending = reg.otpPending[key];
    if(!pending) return { ok: false, message: "Không có yêu cầu xác thực." };
    if(Date.now() > Number(pending.expiresAt || 0)){
      delete reg.otpPending[key];
      saveRegistry(reg);
      return { ok: false, message: "Mã xác thực đã hết hạn. Đăng ký lại." };
    }
    if(String(code || "").trim() !== String(pending.code || "")){
      return { ok: false, message: "Mã xác thực không đúng." };
    }

    const p = pending.payload || {};
    const hash = await hashPassword(p.password);
    const ts = nowIso();

    reg.schools[p.schoolId] = {
      id: p.schoolId,
      name: p.schoolName,
      ownerEmail: key,
      plan: "free",
      active: true,
      verified: true,
      scheduleNumber: p.scheduleNumber,
      effectiveDate: p.effectiveDate,
      expiresAt: "",
      createdAt: ts,
      updatedAt: ts
    };

    reg.users[key] = {
      id: key,
      passwordHash: hash,
      role: "school_admin",
      schoolId: p.schoolId,
      displayName: p.schoolName,
      email: key,
      active: true,
      emailVerified: true,
      createdAt: ts
    };

    delete reg.otpPending[key];
    if(!saveRegistry(reg)) return remoteSaveError();

    persistSchoolRecord(reg.schools[p.schoolId]);

    seedSchoolMeta(p.schoolId, p.schoolName, p.scheduleNumber, p.effectiveDate);
    if(!REMOTE_ONLY_AUTH && window.TKBSchool){
      try{
        window.TKBSchool.setSchoolName(p.schoolId, p.schoolName);
        localStorage.setItem("TKB_LAST_SCHOOL", p.schoolId);
        localStorage.setItem("TKB_LAST_SCHOOL_LABEL", p.schoolName);
      }catch(_){}
    }
  if(!REMOTE_ONLY_AUTH) try{
      const list = safeParse(localStorage.getItem("TKB_SCHOOL_LIST"), []) || [];
      if(!list.includes(p.schoolId)){
        list.push(p.schoolId);
        localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(list));
      }
    }catch(_){}

    return { ok: true, schoolId: p.schoolId };
  }

  function seedSchoolMeta(schoolId, schoolName, scheduleNumber, effectiveDate, extraMeta){
    const metaPatch = Object.assign({
      schoolName,
      scheduleNumber,
      effectiveDate,
      updatedAt: nowIso()
    }, extraMeta || {});
    if(REMOTE_ONLY_AUTH){
      const data = loadRemoteSchoolStoreSync(schoolId) || {};
      data.tkbConstraints = data.tkbConstraints || {};
      data.tkbConstraints.meta = Object.assign({}, data.tkbConstraints.meta || {}, metaPatch);
      saveRemoteSchoolStoreSync(schoolId, data);
      return;
    }
    const key = window.TKBSchool ? window.TKBSchool.lsKey(schoolId) : `TKB_STORE::${schoolId}`;
    const data = safeParse(localStorage.getItem(key), {}) || {};
    data.tkbConstraints = data.tkbConstraints || {};
    data.tkbConstraints.meta = Object.assign({}, data.tkbConstraints.meta || {}, metaPatch);
    try{ localStorage.setItem(key, JSON.stringify(data)); }catch(_){}
  }

  function listSchools(){
    const reg = loadRegistry();
    const schools = Object.values(reg.schools || {});
    if(!schools.length){
      return rebuildSchoolsFromAllSources().sort((a,b) => String(a.name).localeCompare(String(b.name), "vi"));
    }
    return schools.sort((a,b) => String(a.name).localeCompare(String(b.name), "vi"));
  }

  function listSchoolUsers(schoolId){
    const reg = loadRegistry();
    const sid = String(schoolId || "");
    return Object.values(reg.users || {}).filter(u =>
      u.schoolId === sid && u.role !== "superadmin"
    );
  }

  function countSchoolSubUsers(schoolId){
    const sid = String(schoolId || "");
    return Object.values(loadRegistry().users || {}).filter(u =>
      u.schoolId === sid && u.role === "school_user"
    ).length;
  }

  async function createSchoolUser(schoolId, loginId, password, displayName){
    const sid = String(schoolId || "");
    const id = normLoginId(loginId);
    const pw = String(password || "");
    const name = String(displayName || "").trim() || id;
    if(!sid) return { ok: false, message: "Thiếu mã trường." };
    if(!id || id.length < 3) return { ok: false, message: "Tên đăng nhập tối thiểu 3 ký tự." };
    if(isEmail(id)) return { ok: false, message: "Tài khoản phụ dùng tên đăng nhập, không dùng email." };
    if(pw.length < 6) return { ok: false, message: "Mật khẩu tối thiểu 6 ký tự." };

    const reg = loadRegistry();
    const school = reg.schools[sid];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    if(!canAddSchoolUsers(school)){
      return { ok: false, message: "Chỉ gói Plus, Max hoặc Ultra mới được thêm tài khoản phụ. Nâng cấp tại mục Gói dịch vụ." };
    }
    const used = countSchoolSubUsers(sid);
    if(used >= MAX_SCHOOL_USERS){
      return { ok: false, message: `Đã đủ ${MAX_SCHOOL_USERS} tài khoản phụ (kể cả tài khoản đã block).` };
    }
    if(reg.users[id]) return { ok: false, message: "Tên đăng nhập đã tồn tại." };

    reg.users[id] = {
      id,
      passwordHash: await hashPassword(pw),
      role: "school_user",
      schoolId: sid,
      displayName: name,
      active: true,
      emailVerified: true,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true };
  }

  async function updateUserPassword(userId, newPassword){
    const reg = loadRegistry();
    const found = findUser(reg, userId);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản." };
    const pw = String(newPassword || "");
    if(pw.length < 6) return { ok: false, message: "Mật khẩu mới tối thiểu 6 ký tự." };
    const user = found.user;
    user.passwordHash = await hashPassword(pw);
    user.updatedAt = nowIso();
    reg.users[found.key] = user;
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true };
  }

  function setUserActive(userId, active){
    const reg = loadRegistry();
    const found = findUser(reg, userId);
    if(!found) return { ok: false, message: "Không tìm thấy tài khoản." };
    found.user.active = !!active;
    found.user.updatedAt = nowIso();
    reg.users[found.key] = found.user;
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true };
  }

  function setSchoolActive(schoolId, active){
    const reg = loadRegistry();
    const sid = String(schoolId || "");
    const school = reg.schools[sid];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const on = !!active;
    school.active = on;
    school.updatedAt = nowIso();
    if(on) unblockSchoolIps(reg, sid);
    else blockSchoolIps(reg, sid);
    Object.values(reg.users || {}).forEach(u => {
      if(String(u.schoolId || "") === sid && u.role !== "superadmin"){
        u.active = on;
        u.updatedAt = nowIso();
      }
    });
    if(!saveRegistry(reg)) return remoteSaveError();
    persistSchoolRecord(school);
    return { ok: true, active: on };
  }

  function activatePlan(schoolId, planId, demoPaid, options){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const requestedPlanId = String(planId || "free").trim().toLowerCase();
    const explicitClassCount = Number(options?.classCount);
    const hasExplicitClassCount = Number.isFinite(explicitClassCount) && explicitClassCount > 0;
    // Super Admin assigns Max 1/Max 2 directly. Do not let stale metadata from
    // the previous Max tier prevent that explicit assignment; the API still
    // enforces the real 39-class ceiling on every store write and solve.
    const requestedClassCount = hasExplicitClassCount
      ? explicitClassCount
      : requestedPlanId === "max1"
        ? MAX_PLAN_PRICING.tiers[0].maxClasses
        : requestedPlanId === "max2"
          ? MAX_PLAN_PRICING.thresholdClasses
          : Number(school.classCount);
    const legacyStudentCount = Number(options?.studentCount ?? school.studentCount);
    const hasClassCount = Number.isFinite(requestedClassCount) && requestedClassCount > 0;
    const classCount = hasClassCount
      ? Math.floor(requestedClassCount)
      : (Number.isFinite(legacyStudentCount) && legacyStudentCount > 1000
          ? MAX_PLAN_PRICING.thresholdClasses
          : MAX_PLAN_PRICING.tiers[0].maxClasses);
    const maxPricingTier = maxPlanTierForClasses(classCount);
    const resolvedPlanId = requestedPlanId === "max"
      ? maxPricingTier.planId
      : normalizedPlanId(requestedPlanId, school);
    const plan = PLANS[resolvedPlanId];
    if(resolvedPlanId === "max1" && classCount > 39){
      return {
        ok: false,
        kind: "max1_class_limit_exceeded",
        message: "Gói Max 1 hỗ trợ tối đa 39 lớp. Vui lòng chọn Max 2 cho trường từ 40 lớp."
      };
    }
    const paymentAmount = Number(plan?.price || 0);
    if(!plan || resolvedPlanId === "free"){
      school.plan = "free";
      school.expiresAt = "";
    }else if(plan.unlimited){
      school.plan = resolvedPlanId;
      school.expiresAt = "";
      school.lastPaymentAt = nowIso();
      school.lastPaymentAmount = paymentAmount;
      school.lastPaymentDemo = !!demoPaid;
    }else{
      const days = Number(plan.durationDays || 0);
      const now = new Date();
      const currentPlan = normalizedPlanId(school.plan, school);
      const isSamePlanRenewal = currentPlan === resolvedPlanId;
      let base = now;
      if(isSamePlanRenewal && school.expiresAt){
        const cur = new Date(school.expiresAt);
        if(!isNaN(cur.getTime()) && cur > now) base = cur;
      }
      const exp = new Date(base);
      exp.setDate(exp.getDate() + days);
      school.plan = resolvedPlanId;
      school.expiresAt = exp.toISOString();
      school.lastPaymentAt = nowIso();
      school.lastPaymentAmount = paymentAmount;
      school.lastPaymentDemo = !!demoPaid;
    }
    if(resolvedPlanId === "plus"){
      school.plusQuotaCycleId = `${Date.now().toString(36)}-${generateShortId()}`;
    }
    if(resolvedPlanId === "max1" || resolvedPlanId === "max2"){
      school.classCount = classCount;
      school.maxPlanPricingTier = resolvedPlanId === "max1"
        ? "under-40-classes"
        : "from-40-classes";
      // Do not discard metadata submitted by an older cached portal.
      if(Number.isFinite(legacyStudentCount) && legacyStudentCount > 0){
        school.studentCount = Math.floor(legacyStudentCount);
      }
    }
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    return {
      ok: true,
      expiresAt: school.expiresAt,
      plan: resolvedPlanId,
      paymentAmount,
      classCount:(resolvedPlanId === "max1" || resolvedPlanId === "max2") ? classCount : null,
      pricingTierId:resolvedPlanId === "max1"
        ? "under-40-classes"
        : resolvedPlanId === "max2" ? "from-40-classes" : null,
      studentCount:(resolvedPlanId === "max1" || resolvedPlanId === "max2") && Number.isFinite(legacyStudentCount) && legacyStudentCount > 0
        ? Math.floor(legacyStudentCount)
        : null
    };
  }

  async function superCreateSchool(data){
    const name = String(data?.name || "").trim();
    const loginId = normLoginId(data?.loginId);
    const email = normEmail(data?.email);
    const phone = normPhone(data?.phone);
    const password = String(data?.password || "");
    const scheduleNumber = String(data?.scheduleNumber || "1").trim();
    const effectiveDate = String(data?.effectiveDate || "").trim();
    if(!name) return { ok: false, message: "Nhập tên trường." };
    if(!isValidLoginId(loginId)) return { ok: false, message: "Tên đăng nhập không hợp lệ." };
    if(!isEmail(email)) return { ok: false, message: "Email không hợp lệ." };
    if(!isPhone(phone)) return { ok: false, message: "Số điện thoại không hợp lệ." };
    if(password.length < 6) return { ok: false, message: "Mật khẩu tối thiểu 6 ký tự." };

    const reg = loadRegistry();
    if(reg.users[loginId]) return { ok: false, message: "Tên đăng nhập đã tồn tại." };
    if(emailInUse(reg, email)) return { ok: false, message: "Email đã tồn tại." };
    const schoolId = generateSchoolId(reg);

    const ts = nowIso();
    const shortId = generateShortId();
    const school = {
      id: schoolId,
      shortId,
      name,
      ownerEmail: email,
      ownerPhone: phone,
      ownerLoginId: loginId,
      plan: "free",
      active: true,
      verified: true,
      scheduleNumber,
      effectiveDate,
      expiresAt: "",
      createdAt: ts,
      updatedAt: ts
    };
    const firstScheduleNumber = Number(scheduleNumber) || 1;
    const firstScheduleSid = scheduleEntrySid(school, firstScheduleNumber);
    school.activeSchedule = firstScheduleNumber;
    school.schedules = [{
      number: firstScheduleNumber,
      effectiveDate,
      sid: firstScheduleSid,
      original: true,
      createdAt: ts
    }];
    reg.schools[schoolId] = school;
    reg.users[loginId] = {
      id: loginId,
      passwordHash: await hashPassword(password),
      role: "school_admin",
      schoolId,
      displayName: name,
      email,
      phone,
      active: true,
      emailVerified: true,
      createdAt: ts,
      updatedAt: ts
    };
    if(!saveRegistry(reg)) return remoteSaveError();
    if(!REMOTE_ONLY_AUTH) persistSchoolRecord(reg.schools[schoolId]);
    seedSchoolMeta(firstScheduleSid, name, String(firstScheduleNumber), effectiveDate, {
      schoolId,
      ownerLoginId: loginId,
      scheduleSid: firstScheduleSid
    });
    return { ok: true, schoolId };
  }

  function deleteSchool(schoolId){
    const reg = loadRegistry();
    const sid = String(schoolId || "");
    if(!reg.schools[sid]) return { ok: false, message: "Không tìm thấy trường." };
    // A block created from this school belongs to the school lifecycle. Once
    // the school is deleted it must not leave an orphan IP ban behind.
    unblockSchoolIps(reg, sid);
    delete reg.schools[sid];
    Object.keys(reg.users).forEach(uid => {
      if(reg.users[uid].schoolId === sid) delete reg.users[uid];
    });
    markSchoolDeleted(reg, sid);
    if(!saveRegistry(reg)) return remoteSaveError();
    purgeSchoolLocalData(sid);
    return { ok: true };
  }

  function deleteUser(userId){
    const reg = loadRegistry();
    const found = findUser(reg, userId);
    if(!found) return { ok: false, message: "Không tìm thấy." };
    if(found.user.role === "superadmin") return { ok: false, message: "Không thể xóa super admin." };
    delete reg.users[found.key];
    markUserDeleted(reg, found.key);
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true };
  }

  function setSchoolExpiry(schoolId, expiresAt){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const raw = String(expiresAt || "").trim();
    if(raw){
      const t = Date.parse(raw);
      if(isNaN(t)) return { ok: false, message: "Ngày không hợp lệ (YYYY-MM-DD)." };
      school.expiresAt = new Date(t).toISOString();
    }else{
      school.expiresAt = "";
    }
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    persistSchoolRecord(school);
    return { ok: true, expiresAt: school.expiresAt };
  }

  async function fetchClientIp(){
    try{
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
      const resp = await fetch("https://api.ipify.org?format=json", {
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined
      });
      if(timer) clearTimeout(timer);
      const data = await resp.json();
      return String(data?.ip || "").trim();
    }catch(_){
      return "";
    }
  }

  function mailApiBase(){
    if(typeof window !== "undefined" && window.TKB_MAIL_API) return String(window.TKB_MAIL_API).replace(/\/+$/, "");
    try{
      const saved = localStorage.getItem("TKB_MAIL_API");
      if(saved) return String(saved).replace(/\/+$/, "");
    }catch(_){}
    try{
      const loc = window.location;
      if(loc && /^https?:$/i.test(loc.protocol)){
        const host = String(loc.hostname || "").toLowerCase();
        if(host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1"){
          return String(loc.origin).replace(/\/+$/, "");
        }
      }
    }catch(_){}
    return "http://localhost:8787";
  }

  // Gửi email OTP qua backend (mail-server). Trả về true nếu server báo gửi thành công.
  async function sendOtpEmail(email, code, purpose){
    try{
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      const resp = await fetch(mailApiBase() + "/api/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, purpose }),
        signal: ctrl ? ctrl.signal : undefined
      });
      if(timer) clearTimeout(timer);
      if(!resp.ok) return false;
      const data = await resp.json().catch(() => ({}));
      return !!data.ok;
    }catch(_){
      return false;
    }
  }

  function transferContentForSchool(school){
    const name = String(school?.name || school?.id || "").trim();
    const SC = window.TKBSchool;
    const stripped = SC && SC.stripVietnameseMarks ? SC.stripVietnameseMarks(name) : name;
    return stripped.toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function isIpBlocked(reg, ip){
    const addr = String(ip || "").trim();
    if(!addr || !reg?.blockedIps) return false;
    return !!reg.blockedIps[addr];
  }

  function registeredIpHit(reg, ip){
    const addr = String(ip || "").trim();
    if(!addr || !reg?.registeredIps) return null;
    const hit = reg.registeredIps[addr] || null;
    if(!hit || typeof hit !== "object") return null;
    const schoolId = String(hit.schoolId || "").trim();
    const userId = String(hit.userId || hit.loginId || "").trim();
    const canonicalUserId = userId.toLowerCase();
    const schoolExists = !!(schoolId && reg.schools && reg.schools[schoolId]);
    const userExists = !!(userId && reg.users && (
      reg.users[userId]
      || reg.users[canonicalUserId]
      || Object.values(reg.users).some(user => String(user?.id || "").trim().toLowerCase() === canonicalUserId)
    ));
    if(schoolExists || userExists) return hit;

    // A stale audit entry must not hide a live legacy owner. Older registries
    // may carry the registration IP only as the first school IP.
    const legacySchool = Object.values(reg.schools || {}).find(school => {
      const firstIp = Array.isArray(school?.ips) ? String(school.ips[0] || "").trim() : "";
      return firstIp === addr;
    });
    return legacySchool ? {
      schoolId: String(legacySchool.id || ""),
      loginId: String(legacySchool.ownerLoginId || ""),
      legacy: true
    } : null;
  }

  function migrateRegisteredIps(reg){
    if(!reg || typeof reg !== "object") return false;
    reg.registeredIps = reg.registeredIps || {};
    let changed = false;
    Object.entries(reg.schools || {}).forEach(([schoolId, school]) => {
      if(!school || !Object.prototype.hasOwnProperty.call(school, "trialUsed")) return;
      const addr = String(Array.isArray(school.ips) ? (school.ips[0] || "") : "").trim();
      if(!addr || reg.registeredIps[addr]) return;
      reg.registeredIps[addr] = {
        schoolId: String(school.id || schoolId || ""),
        userId: String(school.ownerLoginId || ""),
        at: school.createdAt || nowIso(),
        legacy: true
      };
      changed = true;
    });
    return changed;
  }

  function recordRegistrationIp(reg, ip, schoolId, userKey, at){
    const addr = String(ip || "").trim();
    if(!addr) return;
    reg.registeredIps = reg.registeredIps || {};
    reg.registeredIps[addr] = {
      schoolId: String(schoolId || ""),
      userId: String(userKey || ""),
      at: at || nowIso()
    };
  }

  function recordClientIp(reg, ip, schoolId, userKey){
    const addr = String(ip || "").trim();
    if(!addr) return;
    const school = schoolId ? reg.schools[schoolId] : null;
    if(school){
      school.ips = Array.isArray(school.ips) ? school.ips : [];
      if(!school.ips.includes(addr)) school.ips.push(addr);
      school.lastIp = addr;
    }
    const user = userKey ? reg.users[userKey] : null;
    if(user){
      user.ips = Array.isArray(user.ips) ? user.ips : [];
      if(!user.ips.includes(addr)) user.ips.push(addr);
      user.lastIp = addr;
    }
  }

  function blockSchoolIps(reg, schoolId){
    const school = reg.schools[schoolId];
    if(!school) return;
    reg.blockedIps = reg.blockedIps || {};
    const ips = new Set();
    (school.ips || []).forEach(ip => ips.add(ip));
    if(school.lastIp) ips.add(school.lastIp);
    Object.values(reg.users || {}).forEach(u => {
      if(String(u.schoolId || "") !== String(schoolId)) return;
      if(u.lastIp) ips.add(u.lastIp);
      (u.ips || []).forEach(ip => ips.add(ip));
    });
    ips.forEach(ip => { reg.blockedIps[ip] = { schoolId, at: nowIso() }; });
  }

  function unblockSchoolIps(reg, schoolId){
    if(!reg.blockedIps) return;
    Object.keys(reg.blockedIps).forEach(ip => {
      if(reg.blockedIps[ip]?.schoolId === schoolId) delete reg.blockedIps[ip];
    });
  }

  function generateShortId(){
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for(let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function generateSchoolId(reg){
    const schools = (reg && reg.schools) || {};
    let id = "";
    for(let i = 0; i < 40; i++){
      id = "sch" + generateShortId();
      if(!schools[id]) break;
    }
    return id;
  }

  function ensureSchoolShortId(reg, schoolId){
    const school = reg.schools[schoolId];
    if(!school) return "";
    if(school.shortId) return school.shortId;
    let id = "";
    for(let i = 0; i < 30; i++){
      id = generateShortId();
      const taken = Object.values(reg.schools).some(s => s.shortId === id);
      if(!taken) break;
    }
    school.shortId = id;
    return id;
  }

  function scheduleEntrySid(school, number){
    const shortId = school?.shortId || ensureSchoolShortId(loadRegistry(), school?.id) || school?.id || "";
    return `${shortId}${Number(number) || 1}`;
  }

  function migrateScheduleSids(reg, schoolId){
    const school = reg.schools[schoolId];
    if(!school) return;
    ensureSchoolShortId(reg, schoolId);
    const list = Array.isArray(school.schedules) ? school.schedules : [];
    list.forEach(entry => {
      const n = Number(entry.number) || 1;
      const newSid = scheduleEntrySid(school, n);
      const oldSid = entry.sid;
      if(oldSid && oldSid !== newSid){
        let migrated = true;
        if(REMOTE_ONLY_AUTH){
          const data = loadRemoteSchoolStoreSync(oldSid);
          // A failed source read is not an empty timetable. Keep the old SID so
          // a temporary backend problem cannot orphan the only persisted copy.
          if(data == null){
            migrated = false;
          }else if(typeof data === "object" && Object.keys(data).length){
            // The destination must exist before the source can be cleared or
            // the registry can point at the new SID.
            migrated = saveRemoteSchoolStoreSync(newSid, data);
            if(migrated) saveRemoteSchoolStoreSync(oldSid, {});
          }
        }else{
          try{
            const raw = localStorage.getItem(schoolStoreKey(oldSid));
            if(raw != null){
              localStorage.setItem(schoolStoreKey(newSid), raw);
              localStorage.removeItem(schoolStoreKey(oldSid));
            }
          }catch(_){}
        }
        if(!migrated) return;
        if(!REMOTE_ONLY_AUTH && window.TKBSchool && window.TKBSchool.setSchoolName){
          window.TKBSchool.setSchoolName(newSid, school.name);
        }
      }
      entry.sid = newSid;
    });
  }

  function updateSchoolMeta(schoolId, patch){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    if(patch.name != null){
      const nextName = String(patch.name)
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim();
      if(!nextName) return { ok: false, message: "Tên trường không được để trống." };
      if(Array.from(nextName).length > 160 || /[\u0000-\u001f\u007f]/.test(nextName)){
        return { ok: false, message: "Tên trường không hợp lệ." };
      }
      school.name = nextName;
      Object.values(reg.users || {}).forEach(user => {
        if(user?.role === "school_admin" && String(user.schoolId || "") === String(schoolId)){
          user.displayName = nextName;
          user.updatedAt = nowIso();
        }
      });
    }
    if(patch.scheduleNumber != null) school.scheduleNumber = String(patch.scheduleNumber).trim();
    if(patch.effectiveDate != null) school.effectiveDate = String(patch.effectiveDate).trim();
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    const schedules = Array.isArray(school.schedules) ? school.schedules : [];
    const targets = schedules.length ? schedules : [{
      sid: schoolId,
      number: school.scheduleNumber || 1,
      effectiveDate: school.effectiveDate || ""
    }];
    targets.forEach(entry => {
      const sid = String(entry?.sid || schoolId).trim() || String(schoolId);
      const number = String(entry?.number || school.scheduleNumber || 1);
      const effectiveDate = String(entry?.effectiveDate || school.effectiveDate || "");
      seedSchoolMeta(sid, school.name, number, effectiveDate, {
        schoolId: String(schoolId),
        ownerLoginId: String(school.ownerLoginId || ""),
        scheduleSid: sid
      });
      if(!REMOTE_ONLY_AUTH && window.TKBSchool && window.TKBSchool.setSchoolName){
        window.TKBSchool.setSchoolName(sid, school.name);
      }
    });
    return { ok: true, name: school.name };
  }

  // ---- Quản lý phiên bản (số) thời khóa biểu của một trường ----
  function scheduleVersionSid(baseSid, entry){
    if(entry && entry.sid) return entry.sid;
    const reg = loadRegistry();
    const school = reg.schools[baseSid];
    if(school){
      const n = Number(entry && entry.number) || 1;
      return scheduleEntrySid(school, n);
    }
    const base = sanitizeStoredSchoolId(baseSid);
    if(entry && entry.original) return base;
    const n = Number(entry && entry.number) || 0;
    return `${base}tkb${n}`;
  }

  function ensureSchoolSchedules(reg, schoolId){
    const school = reg.schools[schoolId];
    if(!school) return null;
    ensureSchoolShortId(reg, schoolId);
    let list = Array.isArray(school.schedules) ? school.schedules : [];
    if(!list.length){
      list = [{
        number: 1,
        effectiveDate: school.effectiveDate || "",
        sid: scheduleEntrySid(school, 1),
        original: true,
        createdAt: school.createdAt || nowIso()
      }];
      school.schedules = list;
    }
    migrateScheduleSids(reg, schoolId);
    return school.schedules;
  }

  function listSchoolSchedules(schoolId){
    const reg = loadRegistry();
    const list = ensureSchoolSchedules(reg, schoolId);
    if(!list) return [];
    saveRegistry(reg);
    return list.slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  }

  function activeScheduleEntry(schoolId){
    const list = listSchoolSchedules(schoolId);
    if(!list.length) return null;
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    const want = Number(school && school.activeSchedule);
    return list.find(s => Number(s.number) === want) || list.find(s => s.original) || list[0];
  }

  function setActiveSchedule(schoolId, number){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const list = ensureSchoolSchedules(reg, schoolId);
    const entry = list.find(s => Number(s.number) === Number(number));
    if(!entry) return { ok: false, message: "Không tìm thấy TKB." };
    school.activeSchedule = Number(number);
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true, sid: entry.sid, number: entry.number };
  }

  function copySchoolSchedule(schoolId, fromNumber){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const list = ensureSchoolSchedules(reg, schoolId);
    const src = list.find(s => Number(s.number) === Number(fromNumber)) || list[0];
    if(!src) return { ok: false, message: "Không tìm thấy TKB nguồn." };

    const nextNumber = smallestFreeScheduleNumber(list);
    const entry = {
      number: nextNumber,
      effectiveDate: src.effectiveDate || "",
      sid: scheduleEntrySid(school, nextNumber),
      original: false,
      createdAt: nowIso()
    };

    if(REMOTE_ONLY_AUTH){
      const data = loadRemoteSchoolStoreSync(src.sid);
      if(data == null){
        return { ok: false, message: "Không đọc được dữ liệu TKB nguồn. Vui lòng kiểm tra kết nối rồi thử lại." };
      }
      data.tkbConstraints = data.tkbConstraints || {};
      data.tkbConstraints.meta = Object.assign({}, data.tkbConstraints.meta || {}, {
        schoolName: school.name,
        scheduleNumber: String(nextNumber),
        effectiveDate: entry.effectiveDate,
        updatedAt: nowIso()
      });
      if(!saveRemoteSchoolStoreSync(entry.sid, data)){
        return { ok: false, message: "Không lưu được bản sao TKB. Dữ liệu và TKB nguồn vẫn được giữ nguyên." };
      }
    }else{
      const srcKey = schoolStoreKey(src.sid);
      const destKey = schoolStoreKey(entry.sid);
      try{
        const rawSrc = localStorage.getItem(srcKey);
        const data = safeParse(rawSrc, {}) || {};
        data.tkbConstraints = data.tkbConstraints || {};
        data.tkbConstraints.meta = Object.assign({}, data.tkbConstraints.meta || {}, {
          schoolName: school.name,
          scheduleNumber: String(nextNumber),
          effectiveDate: entry.effectiveDate,
          updatedAt: nowIso()
        });
        localStorage.setItem(destKey, JSON.stringify(data));
      }catch(_){
        seedSchoolMeta(entry.sid, school.name, String(nextNumber), entry.effectiveDate);
      }
    }

    if(!REMOTE_ONLY_AUTH && window.TKBSchool && window.TKBSchool.setSchoolName){
      window.TKBSchool.setSchoolName(entry.sid, school.name);
    }

    list.push(entry);
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true, number: nextNumber, sid: entry.sid };
  }

  function smallestFreeScheduleNumber(list){
    const used = new Set((list || []).map(s => Number(s.number) || 0));
    let n = 1;
    while(used.has(n)) n++;
    return n;
  }

  function createSchoolSchedule(schoolId, effectiveDate){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const list = ensureSchoolSchedules(reg, schoolId);
    const nextNumber = smallestFreeScheduleNumber(list);
    const entry = {
      number: nextNumber,
      effectiveDate: effectiveDate || "",
      sid: scheduleEntrySid(school, nextNumber),
      original: false,
      createdAt: nowIso()
    };
    seedSchoolMeta(entry.sid, school.name, String(nextNumber), entry.effectiveDate);
    if(!REMOTE_ONLY_AUTH && window.TKBSchool && window.TKBSchool.setSchoolName){
      window.TKBSchool.setSchoolName(entry.sid, school.name);
    }
    list.push(entry);
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true, number: nextNumber, sid: entry.sid };
  }

  function updateScheduleDate(schoolId, number, effectiveDate){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const list = ensureSchoolSchedules(reg, schoolId);
    const entry = list.find(s => Number(s.number) === Number(number));
    if(!entry) return { ok: false, message: "Không tìm thấy TKB." };
    entry.effectiveDate = String(effectiveDate || "").trim();
    if(entry.original){
      school.effectiveDate = entry.effectiveDate;
      school.scheduleNumber = String(entry.number);
    }
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    seedSchoolMeta(entry.sid, school.name, String(entry.number), entry.effectiveDate);
    return { ok: true };
  }

  function updateSchedule(schoolId, number, patch){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const list = ensureSchoolSchedules(reg, schoolId);
    const entry = list.find(s => Number(s.number) === Number(number));
    if(!entry) return { ok: false, message: "Không tìm thấy TKB." };
    if(patch && patch.effectiveDate != null){
      entry.effectiveDate = String(patch.effectiveDate || "").trim();
      if(entry.original){
        school.effectiveDate = entry.effectiveDate;
        school.scheduleNumber = String(entry.number);
      }
    }
    if(patch && patch.label != null){
      const label = String(patch.label || "").trim();
      if(label) entry.label = label;
      else delete entry.label;
    }
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    seedSchoolMeta(entry.sid, school.name, String(entry.number), entry.effectiveDate);
    return { ok: true };
  }

  function deleteSchoolSchedule(schoolId, number){
    const reg = loadRegistry();
    const school = reg.schools[schoolId];
    if(!school) return { ok: false, message: "Không tìm thấy trường." };
    const list = ensureSchoolSchedules(reg, schoolId);
    if(list.length <= 1) return { ok: false, message: "Phải giữ ít nhất một TKB." };
    const idx = list.findIndex(s => Number(s.number) === Number(number));
    if(idx < 0) return { ok: false, message: "Không tìm thấy TKB." };
    const [removed] = list.splice(idx, 1);
    if(removed && REMOTE_ONLY_AUTH){
      saveRemoteSchoolStoreSync(removed.sid, {});
    }else if(removed && !removed.original){
      try{ localStorage.removeItem(schoolStoreKey(removed.sid)); }catch(_){}
    }else if(removed && removed.original){
      const next = list[0];
      try{ localStorage.removeItem(schoolStoreKey(removed.sid)); }catch(_){}
      if(next){
        const newSid = scheduleEntrySid(school, 1);
        try{
          const raw = localStorage.getItem(schoolStoreKey(next.sid));
          if(raw != null){
            localStorage.setItem(schoolStoreKey(newSid), raw);
            if(next.sid !== newSid) localStorage.removeItem(schoolStoreKey(next.sid));
          }
        }catch(_){}
        next.number = 1;
        next.sid = newSid;
        next.original = true;
        school.scheduleNumber = "1";
        school.effectiveDate = next.effectiveDate || "";
      }
    }
    if(Number(school.activeSchedule) === Number(number)){
      school.activeSchedule = Number(list[0] && list[0].number) || 1;
    }
    school.updatedAt = nowIso();
    if(!saveRegistry(reg)) return remoteSaveError();
    return { ok: true };
  }

  function requireAuth(roles){
    const ctx = currentUser();
    if(!ctx) return { ok: false, redirect: "/" };
    if(roles && roles.length && !roles.includes(ctx.user.role)){
      return { ok: false, redirect: "/" };
    }
    return { ok: true, ctx };
  }

  function redirectAfterLogin(role){
    if(role === "superadmin") return "/super-admin";
    if(role === "school_admin") return "/school-portal";
    return "/app";
  }

  function formatMoney(v){
    return new Intl.NumberFormat("vi-VN").format(Number(v || 0)) + " đ";
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

  window.TKBAuth = {
    PLANS,
    MAX_PLAN_PRICING,
    MANAGED_SERVICE,
    BANK_TRANSFER,
    MAX_SCHOOL_USERS,
    remoteOnly: REMOTE_ONLY_AUTH,
    syncRemoteRegistry,
    remoteRegistryOnline: () => remoteRegistryOnline,
    loadRegistry,
    getSession,
    currentUser,
    fetchClientIp,
    transferContentForSchool,
    login,
    logout,
    expireSession,
    registerSchool,
    verifyEmailOtp,
    requestEmailVerification,
    verifyAccountEmail,
    updateAccountContact,
    requestPasswordReset,
    confirmPasswordReset,
    syncSchoolsRegistry,
    rebuildSchoolsFromAllSources,
    persistSchoolRecord,
    listSchools,
    listSchoolUsers,
    countSchoolSubUsers,
    createSchoolUser,
    updateUserPassword,
    setUserActive,
    setSchoolActive,
    activatePlan,
    superCreateSchool,
    deleteSchool,
    deleteUser,
    setSchoolExpiry,
    updateSchoolMeta,
    listSchoolSchedules,
    activeScheduleEntry,
    setActiveSchedule,
    copySchoolSchedule,
    createSchoolSchedule,
    updateScheduleDate,
    updateSchedule,
    deleteSchoolSchedule,
    scheduleVersionSid,
    scheduleEntrySid,
    effectivePlan,
    canPrint,
    canPrintForSchool,
    canAddSchoolUsers,
    planBadgeHtml,
    planDurationLabel,
    maxPlanTierForClasses,
    maxPlanPriceForClasses,
    maxPlanIdForClasses,
    normalizedPlanId,
    maxPlanTierForStudents,
    maxPlanPriceForStudents,
    requireAuth,
    redirectAfterLogin,
    formatMoney,
    formatDate,
    hashPassword,
    normEmail,
    normLoginId,
    isEmail,
    isPhone,
    formatPhone,
    isValidLoginId
  };

})();
