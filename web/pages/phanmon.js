window.__PHANMON_VERSION = "updated-v10.3 (v1.43 diverse quality seed)";
try{
  window.__TKB_PLANNER_DATA_READY = false;
  window.__TKB_PLANNER_REMOTE_HYDRATION_PENDING = false;
  window.__TKB_MARK_PLANNER_DATA_READY = function(){
    if(window.__TKB_PLANNER_DATA_READY === true) return false;
    window.__TKB_PLANNER_DATA_READY = true;
    window.__TKB_PLANNER_DATA_READY_AT = Date.now();
    window.dispatchEvent?.(new Event("tkb:planner-data-ready"));
    return true;
  };
}catch(_){ }

(function installPlannerMobileViewportSync(){
  if(window.__TKB_MOBILE_VIEWPORT_SYNC_BOUND === true) return;
  window.__TKB_MOBILE_VIEWPORT_SYNC_BOUND = true;

  let pendingFrame = 0;
  function standaloneMobileScreenHeight(measuredHeight){
    const navigatorStandalone = window.navigator?.standalone === true;
    let displayModeStandalone = false;
    try{
      displayModeStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches === true
        || window.matchMedia?.("(display-mode: fullscreen)")?.matches === true;
    }catch(_){ }
    const touchCapable = navigatorStandalone
      || Number(window.navigator?.maxTouchPoints || 0) > 0;
    if(!touchCapable || (!navigatorStandalone && !displayModeStandalone)) return 0;

    const screenWidth = Number(window.screen?.width || 0);
    const screenHeight = Number(window.screen?.height || 0);
    if(screenWidth < 240 || screenHeight < 240) return 0;

    let portrait = Number(window.innerHeight || 0) >= Number(window.innerWidth || 0);
    try{
      portrait = window.matchMedia?.("(orientation: portrait)")?.matches === true;
    }catch(_){ }
    const orientedScreenHeight = portrait
      ? Math.max(screenWidth, screenHeight)
      : Math.min(screenWidth, screenHeight);
    const baseHeight = Math.max(240, Number(measuredHeight || 0));
    // In standalone mode iOS and Android may report a viewport that excludes
    // system overlays even though viewport-fit=cover can use that screen area.
    // Avoid screen.height in split-screen or windowed modes where it can be far
    // larger than the app window.
    if(orientedScreenHeight < baseHeight || orientedScreenHeight > baseHeight * 1.35) return 0;
    return orientedScreenHeight;
  }

  function syncPlannerMobileViewportHeight(){
    pendingFrame = 0;
    const visualHeight = Number(window.visualViewport?.height || 0);
    const innerHeight = Number(window.innerHeight || 0);
    const layoutHeight = Number(document.documentElement?.clientHeight || 0);
    // iOS standalone can exclude the top safe area from visualViewport after
    // rotation. The page already pads for safe areas, so using that shorter
    // value alone would subtract the inset twice and leave a blank bottom band.
    const measuredHeight = Math.max(visualHeight, innerHeight, layoutHeight);
    const height = Math.max(
      measuredHeight,
      standaloneMobileScreenHeight(measuredHeight)
    );
    if(!Number.isFinite(height) || height < 240) return false;
    document.documentElement.style.setProperty(
      "--tkb-mobile-viewport-h",
      `${Math.round(height * 100) / 100}px`
    );
    return true;
  }

  function schedulePlannerMobileViewportSync(){
    if(pendingFrame) window.cancelAnimationFrame(pendingFrame);
    pendingFrame = window.requestAnimationFrame(syncPlannerMobileViewportHeight);
  }

  function settlePlannerMobileViewportAfterRotation(){
    schedulePlannerMobileViewportSync();
    [120, 360, 900].forEach(delay => window.setTimeout(schedulePlannerMobileViewportSync, delay));
  }

  window.syncPlannerMobileViewportHeight = syncPlannerMobileViewportHeight;
  syncPlannerMobileViewportHeight();
  window.addEventListener("resize", schedulePlannerMobileViewportSync, {passive:true});
  window.addEventListener("orientationchange", settlePlannerMobileViewportAfterRotation, {passive:true});
  window.addEventListener("pageshow", settlePlannerMobileViewportAfterRotation, {passive:true});
  window.visualViewport?.addEventListener?.("resize", schedulePlannerMobileViewportSync, {passive:true});
  window.screen?.orientation?.addEventListener?.("change", settlePlannerMobileViewportAfterRotation);
})();
/* =======================
   PHÂN MÔN / SẮP XẾP TKB (DẠNG NGANG)
   - Lấy lớp theo KHỐI, và lấy TIẾT CHUẨN theo KHỐI từ DATA.mon (bắt buộc có khối + số tiết)
   - Drag & drop có kiểm tra "không trùng môn trong 1 buổi" (chỉ cho phép 1 cụm liên tiếp, tối đa = giới hạn/buổi)
   - Khi kéo: các ô cùng môn sẽ mờ (conflict) để cảnh báo
======================= */

/* ======================= LOAD DATA ======================= */
const SC = window.TKBSchool || {};
const stripVietnameseMarks = SC.stripVietnameseMarks || function(s){ return (s||"").toString(); };
const sanitizeOptionalSchoolId = SC.sanitizeOptionalSchoolId || function(s){ return (s||"").toString().trim(); };
const sanitizeSchoolId = SC.sanitizeSchoolId || function(s){ return sanitizeOptionalSchoolId(s) || "default"; };
const legacySanitizeSchoolId = SC.legacyUpperSanitizeSchoolId || function(s){ return (s||"").toString().trim().toUpperCase(); };
const legacyUnderscoreSanitizeSchoolId = SC.legacySanitizeSchoolId || function(s){ return (s||"").toString().trim(); };

const urlParams = new URLSearchParams(location.search);
// school: tên hiển thị (có thể có dấu) để URL dễ đọc
const rawSchoolParamFromUrl = (urlParams.get("school") || "").toString().trim();
// sid: mã trường ổn định để đọc/ghi storage (ưu tiên dùng sid nếu có)
const rawSidParamFromUrl = (urlParams.get("sid") || "").toString().trim();

function getStoredSchoolName(sid){
  if(SC.getSchoolName) return SC.getSchoolName(sid);
  try{
    const key = sanitizeSchoolId(sid);
    const map = JSON.parse(localStorage.getItem("TKB_SCHOOL_NAMES") || "{}");
    const name = map && map[key];
    return (name == null) ? "" : String(name).trim();
  }catch(_){
    return "";
  }
}

function storedSchoolDataScore(sid){
  if(SC.schoolStoreScore) return SC.schoolStoreScore(sid);
  return 0;
}

function discoverStoredSchoolIds(){
  if(SC.discoverStoredSchoolIds) return SC.discoverStoredSchoolIds();
  return [];
}

function getStoredSchoolListFirst(){
  try{
    const list = discoverStoredSchoolIds();
    let fallback = "";
    let best = "";
    let bestScore = -1;
    for(const item of list){
      const sid = sanitizeSchoolId(item);
      if(!sid) continue;
      if(sid !== "default"){
        const score = storedSchoolDataScore(sid);
        if(!best || score > bestScore){
          best = sid;
          bestScore = score;
        }
        continue;
      }
      fallback = fallback || sid;
    }
    return best || fallback;
  }catch(_){}
  return "";
}

function getLastSchoolContext(){
  const lastSid = sanitizeOptionalSchoolId(localStorage.getItem("TKB_LAST_SCHOOL") || "");
  const listedSid = getStoredSchoolListFirst();
  let sid = "";
  if(lastSid && lastSid !== "default"){
    const lastScore = storedSchoolDataScore(lastSid);
    const listedScore = listedSid ? storedSchoolDataScore(listedSid) : 0;
    sid = (!listedSid || listedSid === "default" || lastSid === listedSid || lastScore >= listedScore)
      ? lastSid
      : listedSid;
  }else{
    sid = listedSid || lastSid;
  }
  if(!sid || sid === "default") return { sid: "", label: "" };
  const label = (
    getStoredSchoolName(sid) ||
    (lastSid === sid ? localStorage.getItem("TKB_LAST_SCHOOL_LABEL") : "") ||
    sid
  ).toString().trim();
  return { sid, label: label || sid };
}

const lastSchoolContext = (!rawSidParamFromUrl && !rawSchoolParamFromUrl)
  ? getLastSchoolContext()
  : { sid: "", label: "" };
const rawSchoolParam = rawSchoolParamFromUrl || lastSchoolContext.label || "";
const rawSidParam = rawSidParamFromUrl || lastSchoolContext.sid || "";

const schoolParam = sanitizeSchoolId(rawSchoolParam || rawSidParam);
const schoolParamLegacy = legacySanitizeSchoolId(rawSidParam || rawSchoolParam || schoolParam);
const schoolParamLegacyUnderscore = legacyUnderscoreSanitizeSchoolId(rawSidParam || rawSchoolParam || schoolParam);

try{ window.__TKB_GET_SCHOOL_ID__ = () => schoolParam; }catch(_){}

try{
  if(window.TKBSchoolSwitcher && window.TKBSchoolSwitcher.ensureSuperAdminDefault){
    window.TKBSchoolSwitcher.ensureSuperAdminDefault();
  }
}catch(_){}

try{
  window.__TKB_SCHOOL_CONTEXT = {
    sid: schoolParam,
    label: rawSchoolParam || getStoredSchoolName(schoolParam) || schoolParam,
    storeKey: `TKB_STORE::${schoolParam}`,
    fromUrl: !!(rawSidParamFromUrl || rawSchoolParamFromUrl),
    fromLast: !!lastSchoolContext.sid
  };
}catch(_){}

try{
  if(schoolParam){
    const label = (rawSchoolParam || getStoredSchoolName(schoolParam) || schoolParam).toString().trim();
    localStorage.setItem("TKB_LAST_SCHOOL", schoolParam);
    localStorage.setItem("TKB_LAST_SCHOOL_LABEL", label || schoolParam);
    if(!rawSidParamFromUrl || rawSchoolParamFromUrl){
      const u = new URL(location.href);
      u.searchParams.set("sid", schoolParam);
      u.searchParams.delete("school");
      history.replaceState(null, "", u.toString());
    }
  }
}catch(_){}

let __isSuperPlanner = false;
try{
  __isSuperPlanner = !!(window.TKBAuth && window.TKBAuth.currentUser && window.TKBAuth.currentUser()?.user?.role === "superadmin");
}catch(_){ __isSuperPlanner = false; }

// Super admin: "default" là một TKB riêng, độc lập — không được lấy dữ liệu
// từ store toàn cục (vốn là dữ liệu trường thật), tránh việc chọn default lại ra trường khác.
try{
  if(__isSuperPlanner && schoolParam === "default"){
    const defaultKey = "TKB_STORE::default";
    const globalRaw = localStorage.getItem("TKB_STORE");
    if(globalRaw && localStorage.getItem(defaultKey) === globalRaw){
      localStorage.removeItem(defaultKey);
    }
  }
}catch(_){}

const PRIMARY_STORE_KEY = schoolParam ? `TKB_STORE::${schoolParam}` : "TKB_STORE";
const LEGACY_SCHOOL_KEY = (schoolParamLegacy ? `TKB_STORE::${schoolParamLegacy}` : "");
const LEGACY_UNDERSCORE_SCHOOL_KEY = (schoolParamLegacyUnderscore ? `TKB_STORE::${schoolParamLegacyUnderscore}` : "");
const ALLOW_GLOBAL_STORE_FALLBACK = !schoolParam || (schoolParam === "default" && !__isSuperPlanner);

const STORE_KEYS = [
  PRIMARY_STORE_KEY,
  ...(LEGACY_SCHOOL_KEY && LEGACY_SCHOOL_KEY !== PRIMARY_STORE_KEY ? [LEGACY_SCHOOL_KEY] : []),
  ...(LEGACY_UNDERSCORE_SCHOOL_KEY && LEGACY_UNDERSCORE_SCHOOL_KEY !== PRIMARY_STORE_KEY && LEGACY_UNDERSCORE_SCHOOL_KEY !== LEGACY_SCHOOL_KEY ? [LEGACY_UNDERSCORE_SCHOOL_KEY] : []),
  ...(ALLOW_GLOBAL_STORE_FALLBACK ? [
    "TKB_STORE",
    "VietSchool_TKB_STORE",
    "VIETSCHOOL_STORE"
  ] : [])
];

let REMOTE_INITIAL_DATA = null;
try{
  if(window.TKBStorage && schoolParam){
    const remoteInitial = window.TKBStorage.loadRemoteSchoolDataWithFallbackSync
      ? window.TKBStorage.loadRemoteSchoolDataWithFallbackSync(schoolParam)
      : window.TKBStorage.loadRemoteSchoolDataSync(schoolParam);
    if(window.TKBStorage.hasMeaningfulData(remoteInitial)){
      REMOTE_INITIAL_DATA = remoteInitial;
      if(!window.TKBStorage.remoteOnly) localStorage.setItem(PRIMARY_STORE_KEY, JSON.stringify(remoteInitial));
    }else if(window.TKBStorage.remoteOnly){
      STORE_KEYS.forEach(k => { try{ localStorage.removeItem(k); }catch(_){} });
    }
  }
}catch(e){
  console.warn("Remote store preload failed", e);
}

let __plannerKv = null;
function plannerDbName(){
  return `TKB::SCHOOL::${schoolParam}`;
}

function saveStoreKVDBBackup(payload){
  if(window.TKBStorage && window.TKBStorage.remoteOnly) return;
  try{
    if(!window.KVDB || !payload) return;
    if(typeof window.KVDB.available === "function" && !window.KVDB.available()) return;
    const write = kv => {
      __plannerKv = kv;
      try{ kv.set("DATA_JSON", payload); }catch(_){}
    };
    if(__plannerKv){
      write(__plannerKv);
      return;
    }
    window.KVDB.open(plannerDbName()).then(write).catch(e=>console.warn("TKB planner KVDB save failed", e));
  }catch(e){
    console.warn("TKB planner KVDB save failed", e);
  }
}

function initPlannerKVDBBackup(){
  if(window.TKBStorage && window.TKBStorage.remoteOnly) return;
  try{
    if(!window.KVDB) return;
    if(typeof window.KVDB.available === "function" && !window.KVDB.available()) return;
    window.KVDB.open(plannerDbName())
      .then(kv=>{ __plannerKv = kv; })
      .catch(e=>console.warn("TKB planner KVDB open failed", e));
  }catch(e){
    console.warn("TKB planner KVDB open failed", e);
  }
}
initPlannerKVDBBackup();

let STORE_KEY = PRIMARY_STORE_KEY;
let DATA = {};
if(window.TKBStorage && window.TKBStorage.remoteOnly){
  DATA = REMOTE_INITIAL_DATA || {};
}else{
  for (const k of STORE_KEYS){
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const obj = JSON.parse(raw || "{}");
      if (obj && (Array.isArray(obj.lop) || Array.isArray(obj.mon) || obj.pccmMatrix || obj.tkb)) {
        STORE_KEY = k; DATA = obj; break;
      }
    } catch(e){}
  }
}

// Nếu mở theo schoolParam mà key chuẩn chưa có dữ liệu, nhưng lại tìm thấy ở key khác
// => migrate về key chuẩn để đồng bộ với trang "Phân công"
try{
  if(!(window.TKBStorage && window.TKBStorage.remoteOnly) && schoolParam){
    const hasPrimary = !!localStorage.getItem(PRIMARY_STORE_KEY);
    if(!hasPrimary && STORE_KEY !== PRIMARY_STORE_KEY){
      localStorage.setItem(PRIMARY_STORE_KEY, JSON.stringify(DATA));
      STORE_KEY = PRIMARY_STORE_KEY;
    }
  }
}catch(e){}
if(!DATA || typeof DATA !== "object") DATA = {};
if(!DATA.tkb) DATA.tkb = {};
if(!DATA.lop) DATA.lop = [];
if(!DATA.mon) DATA.mon = [];
if(!DATA.monhoc) DATA.monhoc = [];
if(!DATA.pccmMatrix) DATA.pccmMatrix = {};
if(!DATA.pccmRoomMatrix) DATA.pccmRoomMatrix = {};
if(!DATA.pccmTietMatrix) DATA.pccmTietMatrix = {};
if(!DATA.pccmGioihanMatrix) DATA.pccmGioihanMatrix = {};
if(!DATA.tkbUserOff || typeof DATA.tkbUserOff !== "object") DATA.tkbUserOff = {};

// Sync from remote store on load. In VPS-only mode the synchronous preload above
// is already the source of truth; re-fetching here can compare against the
// normalized DATA shape and trigger an endless reload loop.
if (typeof schoolParam !== "undefined" && schoolParam && !(window.TKBStorage && window.TKBStorage.remoteOnly)) {
  try{ window.__TKB_PLANNER_REMOTE_HYDRATION_PENDING = true; }catch(_){ }
  const remoteLoader = window.TKBStorage && window.TKBStorage.loadRemoteSchoolData
    ? window.TKBStorage.loadRemoteSchoolData(schoolParam)
    : fetch(`/api/school/store?id=${encodeURIComponent(schoolParam)}`).then(r => r.json());
  remoteLoader.then(remoteData => {
    const hasRemote = window.TKBStorage && window.TKBStorage.hasMeaningfulData
      ? window.TKBStorage.hasMeaningfulData(remoteData)
      : !!(remoteData && Object.keys(remoteData).length > 0 && (remoteData.lop || remoteData.mon || remoteData.tkb));
    if (hasRemote) {
      const remoteDataStr = JSON.stringify(remoteData);
      if (remoteDataStr !== JSON.stringify(DATA)) {
        if(!(window.TKBStorage && window.TKBStorage.remoteOnly)){
          localStorage.setItem(PRIMARY_STORE_KEY, remoteDataStr);
        }
        try{ window.__TKB_PLANNER_REMOTE_RELOAD_REQUESTED = true; }catch(_){ }
        window.location.reload();
      }
    }
  }).catch(e => console.warn("Remote store sync failed on load", e)).finally(() => {
    try{
      window.__TKB_PLANNER_REMOTE_HYDRATION_PENDING = false;
      if(window.__TKB_PLANNER_REMOTE_RELOAD_REQUESTED !== true
        && window.__TKB_PLANNER_DOM_READY === true){
        window.__TKB_MARK_PLANNER_DATA_READY?.();
      }
    }catch(_){ }
  });
}

// Many optimizer patches run in separate script blocks and access the store as
// window.DATA. A top-level `let DATA` is not automatically exposed on window, so
// keep both entry points bound to the same object to avoid saving a stale TKB
// after auto-sort/optimize and then seeing lessons reappear as unassigned on F5.
try{
  if(!Object.getOwnPropertyDescriptor(window, "DATA")?.get){
    Object.defineProperty(window, "DATA", {
      configurable: true,
      get(){ return DATA; },
      set(v){
        DATA = (v && typeof v === "object") ? v : {};
        if(!DATA.tkb) DATA.tkb = {};
        if(!DATA.lop) DATA.lop = [];
        if(!DATA.mon) DATA.mon = [];
        if(!DATA.monhoc) DATA.monhoc = [];
        if(!DATA.pccmMatrix) DATA.pccmMatrix = {};
        if(!DATA.pccmRoomMatrix) DATA.pccmRoomMatrix = {};
        if(!DATA.pccmTietMatrix) DATA.pccmTietMatrix = {};
        if(!DATA.pccmGioihanMatrix) DATA.pccmGioihanMatrix = {};
        if(!DATA.tkbUserOff || typeof DATA.tkbUserOff !== "object") DATA.tkbUserOff = {};
      }
    });
  }else{
    window.DATA = DATA;
  }
}catch(_){}


/* ===== CONFIG VIETSCHOOL (mặc định) ===== */
const TC = window.TKBConstants || {};
const SANG = TC.SANG != null ? TC.SANG : 5;
const CHIEU = TC.CHIEU != null ? TC.CHIEU : 5;
const DAYS = Array.isArray(TC.DAYS) ? TC.DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];

if(!DATA.tkbConfig){
  DATA.tkbConfig = {
    // Mặc định KHÔNG auto chèn "Chào cờ" / "SHL" nữa.
    // Người dùng có thể tự cố định bằng cách double-click vào tiết đã xếp.
    fixed: [],
    off: []
  };
}

const LABEL = { thu2:"Thứ 2", thu3:"Thứ 3", thu4:"Thứ 4", thu5:"Thứ 5", thu6:"Thứ 6", thu7:"Thứ 7" };

let currentLop = null;

// UI chỉ hiển thị bảng theo Lớp. Các hàm GV/Phòng vẫn giữ để kiểm tra ràng buộc.
const TKB_CLASS_VIEW_ONLY = true;
try{ window.TKB_CLASS_VIEW_ONLY = true; }catch(_){ }

// Chế độ xem: theo Lớp / Giáo viên / Phòng
let VIEW_MODE = "lop"; // "lop" | "gv" | "phong"
let currentGV = null;
let currentPhong = null;

let dragData = null;   // {type:"mon", mon} or {type:"cell", from, val}
let dragMon = "";      // tên môn đang kéo

// Cache tiết chuẩn theo lớp đang chọn
let CURRENT_MONS = [];         // [{ten,sotiet,gioihan}]
let CURRENT_MON_META = {};     // ten -> {sotiet, gioihan}

/* ======================= CHỌN Ô + COPY/PASTE (NGHỈ) ======================= */
let TKB_CELL_SELECTION = new Set(); // key: "thu|buoi|ti"
let TKB_CELL_ANCHOR = null;         // key
let TKB_CELL_ACTIVE = null;         // key
let TKB_DRAG_SELECTING = false;
let TKB_CLIPBOARD = { type: "", payload: null };
let TKB_PAIR_NAV_SCOPE = "class"; // class | teacher
let TKB_UNASSIGNED_OPEN_CLASS = "";

// Cell menu is only opened by explicit commands; long-press on timetable cells is disabled.
let __CELL_LONGPRESS_TIMER = null;
let __CELL_LONGPRESS_FIRED = false;
let __CELL_MENU = null;
let __CELL_MENU_KEY = null;
let __CELL_MENU_TD = null;
let __CELL_LAST_TOUCH_TAP = null;

/* ======================= HELPERS ======================= */
function extractKhoiNumber(str){
  const m = (str||"").toString().match(/\d+/);
  return m ? m[0] : "";
}
function khoiKey(str){
  const n = extractKhoiNumber(str);
  return n ? ("Khối " + n) : (str||"").toString().trim();
}

function normalizeClassName(name){
  if(!name) return "";
  const raw = name.toString().trim().toUpperCase();
  const slash = raw.match(/^(\d+)[.\-_/ ]+(\d+)$/);
  if(slash) return `${slash[1]}/${Number(slash[2])}`;
  if(/^\d+A\d+$/i.test(raw)) return raw.replace(/^(\d+)A0?(\d+)$/i, "$1A$2").toUpperCase();
  return raw.replace(/\s+/g,'').toUpperCase();
}

function legacyClassNameAliases(name){
  const raw = (name||"").toString().trim();
  const out = [];
  const add = (v)=>{
    const s = (v||"").toString().trim();
    if(s && !out.includes(s)) out.push(s);
  };
  add(raw);
  add(normalizeClassName(raw));
  const slash = raw.match(/^(\d+)[.\-_/ ]+(\d+)$/);
  if(slash){
    add(`${slash[1]}/${Number(slash[2])}`);
    add(`${slash[1]}A${Number(slash[2])}`.toUpperCase());
  }
  const a = raw.match(/^(\d+)A0?(\d+)$/i);
  if(a){
    add(`${a[1]}A${Number(a[2])}`.toUpperCase());
    add(`${a[1]}/${Number(a[2])}`);
  }
  return out;
}

function classCanonFromLop(lop){
  const ten = (lop?.ten||"").toString().trim();
  const ten2 = (lop?.ten2||"").toString().trim();
  const id = (lop?.id||"").toString().trim();
  return ten || ten2 || id;
}

function classRecordOrderValue(lop, fallbackIndex){
  if(!lop) return Number.MAX_SAFE_INTEGER;
  for(const key of ["stt","tt","soThuTu","sothutu","thuTu","thutu","order","sort","index"]){
    const n = Number(lop?.[key]);
    if(Number.isFinite(n) && n > 0) return n;
  }
  return Number.isFinite(fallbackIndex) && fallbackIndex >= 0
    ? fallbackIndex + 1
    : Number.MAX_SAFE_INTEGER;
}

function findClassRecordForOrder(value){
  const lops = Array.isArray(DATA?.lop) ? DATA.lop : [];
  if(value && typeof value === "object"){
    const idx = lops.indexOf(value);
    if(idx >= 0) return {lop:value, index:idx};
  }
  const raw = (
    value && typeof value === "object"
      ? (value.id ?? value.ten ?? value.ten2 ?? classCanonFromLop(value))
      : value
  );
  const key = (raw||"").toString().trim();
  if(!key) return {lop:null, index:-1};
  let idx = lops.findIndex(l => String(l?.id||"").trim() === key);
  if(idx < 0) idx = lops.findIndex(l => [classCanonFromLop(l), l?.ten, l?.ten2].some(v => String(v||"").trim() === key));
  if(idx < 0){
    const groupKey = classAliasGroupKey(key);
    if(groupKey) idx = lops.findIndex(l => classAliasGroupKeyForLop(l) === groupKey);
  }
  return {lop: idx >= 0 ? lops[idx] : null, index:idx};
}

function classOrderIndex(value){
  const found = findClassRecordForOrder(value);
  return classRecordOrderValue(found.lop, found.index);
}

function compareClassByDataOrder(a,b){
  const ia = classOrderIndex(a);
  const ib = classOrderIndex(b);
  if(ia !== ib) return ia - ib;
  const labelOf = (v)=>{
    if(v && typeof v === "object") return classCanonFromLop(v);
    const found = findClassRecordForOrder(v);
    return found.lop ? classCanonFromLop(found.lop) : String(v||"");
  };
  return labelOf(a).localeCompare(labelOf(b),'vi',{numeric:true,sensitivity:'base'});
}

function classAliasGroupKey(value){
  const raw = (value||"").toString().trim();
  if(!raw) return "";
  const slash = raw.match(/^(\d+)[.\-_/ ]+(\d+)$/);
  if(slash) return `${Number(slash[1])}|${Number(slash[2])}`;
  const a = raw.match(/^(\d+)A0?(\d+)$/i);
  if(a) return `${Number(a[1])}|${Number(a[2])}`;
  return `raw:${normalizeClassName(raw).toLowerCase()}`;
}

function classAliasGroupKeyForLop(lop){
  const vals = [
    lop?.ten2,
    lop?.ten,
    classCanonFromLop(lop),
    lop?.id
  ].map(v => (v||"").toString().trim()).filter(Boolean);
  for(const v of vals){
    const key = classAliasGroupKey(v);
    if(key && !key.startsWith("raw:")) return key;
  }
  return vals.length ? classAliasGroupKey(vals[0]) : "";
}

function classDisplayLooksSlash(value){
  return /^(\d+)[.\-_/ ]+(\d+)$/i.test((value||"").toString().trim());
}

function classDisplayLooksA(value){
  return /^(\d+)A0?(\d+)$/i.test((value||"").toString().trim());
}

function plannerClassKeepScore(lop, index){
  const display = classCanonFromLop(lop);
  const ten2 = (lop?.ten2||"").toString().trim();
  const ten = (lop?.ten||"").toString().trim();
  let score = 0;
  if(classDisplayLooksSlash(ten)) score += 12000;
  if(classDisplayLooksSlash(display)) score += 8000;
  if(classDisplayLooksSlash(ten2)) score += 3000;
  if(classDisplayLooksA(ten)) score -= 1200;
  if(classDisplayLooksA(display)) score -= 800;
  if(String(lop?.id||"").trim()) score += 100;
  score += Object.keys(lop || {}).filter(k => String(lop?.[k] ?? "").trim()).length;
  return score - (Number(index) || 0) / 1000;
}

function plannerBuildValidClassAliases(){
  const valid = new Set();
  (DATA.lop || []).forEach(lop=>{
    [lop?.id, lop?.ten, lop?.ten2, classCanonFromLop(lop)].forEach(v=>{
      legacyClassNameAliases(v).forEach(alias=>{
        const s = (alias||"").toString().trim();
        if(s) valid.add(s);
      });
    });
  });
  return valid;
}

function plannerBuildCanonicalClassAliasMap(){
  const map = new Map();
  (DATA.lop || []).forEach(lop=>{
    const canon = classCanonFromLop(lop);
    if(!canon) return;
    [lop?.id, lop?.ten, lop?.ten2, canon].forEach(v=>{
      legacyClassNameAliases(v).forEach(alias=>{
        const s = (alias||"").toString().trim();
        if(s) map.set(s.toLowerCase(), canon);
      });
    });
  });
  return map;
}

function normalizeClassSubjectMatrixByAliases(matrix, classAliasMap){
  if(!matrix || typeof matrix !== "object") return false;
  let changed = false;
  Object.keys(matrix).forEach(key=>{
    const parts = String(key || "").split("|");
    const cls = (parts.shift() || "").trim();
    const subject = parts.join("|").trim();
    const canon = classAliasMap.get(cls.toLowerCase());
    if(!cls || !subject || !canon){
      delete matrix[key];
      changed = true;
      return;
    }
    const nextKey = `${canon}|${subject}`;
    if(nextKey !== key){
      if(matrix[nextKey] == null || String(matrix[nextKey]).trim() === ""){
        matrix[nextKey] = matrix[key];
      }
      delete matrix[key];
      changed = true;
    }
  });
  return changed;
}

function pruneRedundantPccmPeriodMatrices(){
  if(!DATA || typeof DATA !== "object") return false;
  const periodMatrix = DATA.pccmTietMatrix;
  const limitMatrix = DATA.pccmGioihanMatrix;
  if((!periodMatrix || typeof periodMatrix !== "object") && (!limitMatrix || typeof limitMatrix !== "object")) return false;

  const classToKhoi = new Map();
  (DATA.lop || []).forEach(lop=>{
    const canon = classCanonFromLop(lop);
    const khoi = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || extractKhoiNumber(canon);
    if(canon && khoi) classToKhoi.set(canon, khoi);
  });

  const sameNumber = (left, right) => {
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
  };
  const keys = new Set([
    ...Object.keys(periodMatrix || {}),
    ...Object.keys(limitMatrix || {})
  ]);
  let changed = false;
  keys.forEach(key=>{
    const parts = String(key || "").split("|");
    if(parts.length < 2) return;
    const cls = parts.shift().trim();
    const monKey = parts.join("|").trim();
    const khoiNum = classToKhoi.get(cls) || extractKhoiNumber(cls);
    if(!cls || !monKey || !khoiNum) return;
    const row = _findTietChuanRow(khoiNum, monKey);
    if(!row) return;
    if(periodMatrix && Object.prototype.hasOwnProperty.call(periodMatrix, key) && sameNumber(periodMatrix[key], row.sotiet)){
      delete periodMatrix[key];
      changed = true;
    }
    if(limitMatrix && Object.prototype.hasOwnProperty.call(limitMatrix, key) && sameNumber(limitMatrix[key], row.gioihan || 1)){
      delete limitMatrix[key];
      changed = true;
    }
  });
  return changed;
}

function remapPlannerClassObjectMap(obj, idRemap, validIds){
  if(!obj || typeof obj !== "object") return false;
  let changed = false;
  Object.keys(obj).forEach(key=>{
    const next = idRemap.get(String(key));
    if(next){
      if(obj[next] == null || (typeof obj[next] === "object" && !Object.keys(obj[next] || {}).length)){
        obj[next] = obj[key];
      }
      delete obj[key];
      changed = true;
      return;
    }
    if(validIds && !validIds.has(String(key))){
      delete obj[key];
      changed = true;
    }
  });
  return changed;
}

function sanitizePlannerDataFromIndex(){
  let changed = false;
  if(!DATA || typeof DATA !== "object") return false;
  if(!Array.isArray(DATA.lop)) DATA.lop = [];

  const validClassIds = new Set((DATA.lop || []).map(l=>String(l?.id || "").trim()).filter(Boolean));
  const classAliasMap = plannerBuildCanonicalClassAliasMap();

  if(!DATA.tkb || typeof DATA.tkb !== "object") DATA.tkb = {};
  changed = remapPlannerClassObjectMap(DATA.tkb, new Map(), validClassIds) || changed;
  if(DATA.tkbUserOff && typeof DATA.tkbUserOff === "object"){
    changed = remapPlannerClassObjectMap(DATA.tkbUserOff, new Map(), validClassIds) || changed;
  }
  try{
    const fixedClass = DATA.tkbConstraints?.fixedOff?.class;
    if(fixedClass && typeof fixedClass === "object"){
      changed = remapPlannerClassObjectMap(fixedClass, new Map(), validClassIds) || changed;
    }
  }catch(_){ }

  ["pccmMatrix","pccmRoomMatrix","pccmTietMatrix","pccmGioihanMatrix","tkbLessonTeachers","tkbLessonRooms"].forEach(field=>{
    if(DATA[field] && typeof DATA[field] === "object"){
      changed = normalizeClassSubjectMatrixByAliases(DATA[field], classAliasMap) || changed;
    }
  });
  changed = pruneRedundantPccmPeriodMatrices() || changed;

  if(changed){
    try{ invalidatePccmNumCaches(); }catch(_){ }
    try{ COMPUTE_MONS_CACHE = {refs: [], values: new Map()}; }catch(_){ }
    try{ TEACHER_FOR_CLASS_MON_CACHE = {pccmRef: null, lessonRef: null, monRef: null, monhocRef: null, values: new Map()}; }catch(_){ }
    try{ ROOM_FOR_CLASS_MON_CACHE = {roomRef: null, lessonRef: null, monRef: null, monhocRef: null, values: new Map()}; }catch(_){ }
  }
  return changed;
}

// Chuẩn hoá text để tránh trùng do khoảng trắng / unicode
function normText(s){
  return (s ?? "").toString().normalize('NFC').trim().replace(/\s+/g,' ');
}
function normKey(s){
  return normText(s).toLowerCase();
}

// Migration: bỏ mặc định "Chào cờ" / "SHL" (nếu dữ liệu cũ còn)
function migrateRemoveLegacyDefaultFixedEvents(){
  let changed = false;

  // 1) dọn trong config.fixed
  try{
    const cfg = DATA.tkbConfig;
    if(cfg && Array.isArray(cfg.fixed)){
      const before = cfg.fixed.length;
      cfg.fixed = cfg.fixed.filter(f=>{
        const ten = (f?.ten||"").toString().trim();
        const thu = (f?.thu||"").toString().trim();
        const buoi = (f?.buoi||"").toString().trim();
        const tiet = Number(f?.tiet);
        const isCC = (ten === "Chào cờ" && thu === "thu2" && buoi === "sang" && tiet === 0);
        const isSHL = (ten === "SHL" && thu === "thu6" && buoi === "chieu" && tiet === (CHIEU-1));
        return !(isCC || isSHL);
      });
      if(cfg.fixed.length !== before) changed = true;
    }
  }catch(_){ }

  // 2) dọn trong từng TKB lớp (nếu đã được chèn trước đây)
  try{
    const positions = [
      {thu:"thu2", buoi:"sang", ti:0, ten:"Chào cờ"},
      {thu:"thu6", buoi:"chieu", ti:(CHIEU-1), ten:"SHL"}
    ];
    for(const lopId of Object.keys(DATA.tkb||{})){
      const tkb = DATA.tkb?.[lopId];
      if(!tkb) continue;
      for(const p of positions){
        const cur = tkb?.[p.thu]?.[p.buoi]?.[p.ti];
        const mon = cellMon(cur);
        if(mon && mon.toString().trim() === p.ten){
          tkb[p.thu][p.buoi][p.ti] = "";
          changed = true;
        }
      }
    }
  }catch(_){ }

  if(changed){
    try{ saveStore(); }catch(_){ }
  }
}

function looksLikeCode(s){
  const str = (s||"").toString().trim();
  return str && str.length <= 10 && !/\s/.test(str) && /^[A-Za-z0-9_.-]+$/.test(str);
}

function resolveTeacherCode(input){
  const raw = (input||"").toString().trim();
  if(!raw) return "";
  const lower = raw.toLowerCase();

  const byCode = (DATA.giaovien||[]).find(g => (g.magv||"").toString().trim().toLowerCase() === lower);
  if(byCode && byCode.magv) return byCode.magv.toString().trim();

  const byName = (DATA.giaovien||[]).find(g=>{
    const full = `${(g.hodem||"").toString().trim()} ${(g.ten||"").toString().trim()}`.trim().toLowerCase();
    return full && full === lower;
  });
  if(byName && byName.magv) return byName.magv.toString().trim();

  return raw;
}

function teacherOrderIndex(code){
  const c = resolveTeacherCode(code).toLowerCase();
  if(!c) return Number.MAX_SAFE_INTEGER;
  const idx = (DATA.giaovien||[]).findIndex(g => resolveTeacherCode(g?.magv).toLowerCase() === c);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function compareTeacherCodeByDataOrder(a,b){
  const aa = resolveTeacherCode((typeof a === "object" ? (a?.code || a?.magv || a?.value) : a) || "");
  const bb = resolveTeacherCode((typeof b === "object" ? (b?.code || b?.magv || b?.value) : b) || "");
  const ia = teacherOrderIndex(aa);
  const ib = teacherOrderIndex(bb);
  if(ia !== ib) return ia - ib;
  return String(aa||"").localeCompare(String(bb||""),'vi');
}

function teacherListFromValue(raw){
  let parts = [];
  if(Array.isArray(raw)){
    parts = raw;
  }else{
    parts = (raw||"").toString()
      .replace(/\r?\n/g, ",")
      .replace(/[;；]+/g, ",")
      .replace(/\s*[+＋]\s*/g, ",")
      .split(",");
  }
  const out = [];
  const seen = new Set();
  parts.forEach(item=>{
    const code = resolveTeacherCode((item||"").toString().trim());
    if(!code) return;
    const key = code.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    out.push(code);
  });
  return out;
}

function teacherValueFromRaw(raw){
  return teacherListFromValue(raw).join(", ");
}

function teacherValueHas(raw, code){
  const target = resolveTeacherCode((code||"").toString().trim()).toLowerCase();
  if(!target) return false;
  return teacherListFromValue(raw).some(x=>x.toLowerCase() === target);
}

function teacherValuesIntersect(a, b){
  const aa = teacherListFromValue(a).map(x=>x.toLowerCase());
  const bb = new Set(teacherListFromValue(b).map(x=>x.toLowerCase()));
  return aa.some(x=>bb.has(x));
}

function allMonRecords(){
  return [
    ...(Array.isArray(DATA.monhoc) ? DATA.monhoc : []),
    ...(Array.isArray(DATA.mon) ? DATA.mon : [])
  ];
}

function monRecordAliases(m){
  return [m?.ten, m?.mon, m?.mamon, m?.ma, m?.ma2, m?.id, m?.key]
    .map(v => (v == null ? "" : String(v)).trim())
    .filter(Boolean);
}

let MON_ALIAS_INDEX = {
  monRef: null,
  monhocRef: null,
  monLen: -1,
  monhocLen: -1,
  aliasToCanonical: new Map(),
  recordByCanonical: new Map()
};

function ensureMonAliasIndex(){
  const monhoc = Array.isArray(DATA.monhoc) ? DATA.monhoc : [];
  const mon = Array.isArray(DATA.mon) ? DATA.mon : [];
  if(MON_ALIAS_INDEX.monRef === mon &&
     MON_ALIAS_INDEX.monhocRef === monhoc &&
     MON_ALIAS_INDEX.monLen === mon.length &&
     MON_ALIAS_INDEX.monhocLen === monhoc.length){
    return MON_ALIAS_INDEX;
  }

  const parent = new Map();
  const find = key => {
    let k = key;
    while(parent.get(k) && parent.get(k) !== k) k = parent.get(k);
    let cur = key;
    while(parent.get(cur) && parent.get(cur) !== cur){
      const next = parent.get(cur);
      parent.set(cur, k);
      cur = next;
    }
    return k;
  };
  const addKey = key => {
    if(key && !parent.has(key)) parent.set(key, key);
  };
  const union = (a,b) => {
    addKey(a); addKey(b);
    const ra = find(a), rb = find(b);
    if(ra && rb && ra !== rb) parent.set(rb, ra);
  };

  const records = allMonRecords();
  records.forEach(record=>{
    const keys = monRecordAliases(record).map(normKey).filter(Boolean);
    if(!keys.length) return;
    keys.forEach(addKey);
    const root = keys[0];
    keys.forEach(k=>union(root, k));
  });

  const aliasToCanonical = new Map();
  const recordByCanonical = new Map();
  records.forEach(record=>{
    const keys = monRecordAliases(record).map(normKey).filter(Boolean);
    if(!keys.length) return;
    const canonical = find(keys[0]) || keys[0];
    if(!recordByCanonical.has(canonical)) recordByCanonical.set(canonical, record);
    keys.forEach(k=>aliasToCanonical.set(k, canonical));
  });

  MON_ALIAS_INDEX = {
    monRef: mon,
    monhocRef: monhoc,
    monLen: mon.length,
    monhocLen: monhoc.length,
    aliasToCanonical,
    recordByCanonical
  };
  return MON_ALIAS_INDEX;
}

function monCanonicalKey(mon){
  const key = normKey(mon);
  if(!key) return "";
  const index = ensureMonAliasIndex();
  return index.aliasToCanonical.get(key) || key;
}

function monMatches(a,b){
  const aa = monCanonicalKey(a);
  const bb = monCanonicalKey(b);
  return !!aa && !!bb && aa === bb;
}

function findMonHoc(mon){
  const key = monCanonicalKey(mon);
  if(!key) return null;
  return ensureMonAliasIndex().recordByCanonical.get(key) || null;
}
function monSortCode(mon){
  const mh = findMonHoc(mon);
  if(!mh) return (mon||"").toString().trim();
  return (mh.ma || mh.ma2 || mh.id || mh.ten || mon || "").toString().trim();
}
function compareMonByHiddenCode(a,b){
  const aa = typeof a === "object" ? (a?.ten || a?.mon || a?.key || "") : a;
  const bb = typeof b === "object" ? (b?.ten || b?.mon || b?.key || "") : b;
  const code = monSortCode(aa).localeCompare(monSortCode(bb),'vi',{sensitivity:'base'});
  if(code) return code;
  return String(aa||"").localeCompare(String(bb||""),'vi');
}

function getMonShort(mon){
  const mh = findMonHoc(mon);
  if(!mh) return (mon||"").toString().trim();
  const ten = (mh.ten||"").toString().trim();
  const ma = (mh.ma||"").toString().trim();
  const ma2 = (mh.ma2||"").toString().trim();
  // ưu tiên code ngắn, fallback ten
  const candidates = [ma, ma2, ten].filter(Boolean).sort((a,b)=>a.length-b.length);
  // nếu code nhìn giống mã thì ưu tiên, còn lại dùng candidate ngắn nhất
  if(looksLikeCode(ma)) return ma;
  if(looksLikeCode(ma2)) return ma2;
  return candidates[0] || (mon||"").toString().trim();
}

function classKeyCandidates(input){
  const raw = (input||"").toString().trim();
  const out = [];
  const add = (v)=>{
    const s = (v||"").toString().trim();
    if(s && !out.includes(s)) out.push(s);
  };
  const addAliases = (v)=>legacyClassNameAliases(v).forEach(add);
  addAliases(raw);
  const rawAliases = legacyClassNameAliases(raw).map(v => v.toLowerCase());
  (DATA.lop||[]).forEach(lop=>{
    const vals = [classCanonFromLop(lop), lop?.id, lop?.ten, lop?.ten2].map(v => (v||"").toString().trim()).filter(Boolean);
    const ownAliases = [];
    vals.forEach(v=>legacyClassNameAliases(v).forEach(a=>{
      if(a && !ownAliases.includes(a)) ownAliases.push(a);
    }));
    const matches = ownAliases.some(v => rawAliases.includes(v.toLowerCase()));
    if(!matches) return;
    vals.forEach(addAliases);
  });
  return out;
}

let TEACHER_FOR_CLASS_MON_CACHE = {
  pccmRef: null,
  lessonRef: null,
  monRef: null,
  monhocRef: null,
  values: new Map()
};

function ensureTeacherForClassMonCache(){
  if(TEACHER_FOR_CLASS_MON_CACHE.pccmRef === DATA.pccmMatrix &&
     TEACHER_FOR_CLASS_MON_CACHE.lessonRef === DATA.tkbLessonTeachers &&
     TEACHER_FOR_CLASS_MON_CACHE.monRef === DATA.mon &&
     TEACHER_FOR_CLASS_MON_CACHE.monhocRef === DATA.monhoc){
    return TEACHER_FOR_CLASS_MON_CACHE.values;
  }
  TEACHER_FOR_CLASS_MON_CACHE = {
    pccmRef: DATA.pccmMatrix,
    lessonRef: DATA.tkbLessonTeachers,
    monRef: DATA.mon,
    monhocRef: DATA.monhoc,
    values: new Map()
  };
  return TEACHER_FOR_CLASS_MON_CACHE.values;
}

function getTeacherForClassMon(lopCanon, mon){
  const cache = ensureTeacherForClassMonCache();
  const cacheKey = `${lopCanon || ""}|${mon || ""}`;
  if(cache.has(cacheKey)) return cache.get(cacheKey);
  const classKeys = classKeyCandidates(lopCanon);
  const monRaw = (mon||"").toString().trim();
  if(!classKeys.length || !monRaw){
    cache.set(cacheKey, "");
    return "";
  }

  const mh = findMonHoc(monRaw);
  const tries = [];
  const subjects = [monRaw];
  if(mh){
    [mh.ma, mh.ten, mh.ma2, mh.id].forEach(v=>{
      const s = (v||"").toString().trim();
      if(s && !subjects.includes(s)) subjects.push(s);
    });
  }
  classKeys.forEach(cls => subjects.forEach(subject => tries.push(`${cls}|${subject}`)));

  for(const k of tries){
    const v = DATA.tkbLessonTeachers?.[k];
    if(v){
      const out = teacherValueFromRaw(v);
      cache.set(cacheKey, out);
      return out;
    }
  }
  for(const k of tries){
    const v = DATA.pccmMatrix?.[k];
    if(v){
      const out = teacherValueFromRaw(v);
      cache.set(cacheKey, out);
      return out;
    }
  }
  cache.set(cacheKey, "");
  return "";
}

function getTeachersForClassMon(lopCanon, mon){
  return teacherListFromValue(getTeacherForClassMon(lopCanon, mon));
}

let ROOM_FOR_CLASS_MON_CACHE = {
  roomRef: null,
  lessonRef: null,
  monRef: null,
  monhocRef: null,
  values: new Map()
};

function ensureRoomForClassMonCache(){
  if(ROOM_FOR_CLASS_MON_CACHE.roomRef === DATA.pccmRoomMatrix &&
     ROOM_FOR_CLASS_MON_CACHE.lessonRef === DATA.tkbLessonRooms &&
     ROOM_FOR_CLASS_MON_CACHE.monRef === DATA.mon &&
     ROOM_FOR_CLASS_MON_CACHE.monhocRef === DATA.monhoc){
    return ROOM_FOR_CLASS_MON_CACHE.values;
  }
  ROOM_FOR_CLASS_MON_CACHE = {
    roomRef: DATA.pccmRoomMatrix,
    lessonRef: DATA.tkbLessonRooms,
    monRef: DATA.mon,
    monhocRef: DATA.monhoc,
    values: new Map()
  };
  return ROOM_FOR_CLASS_MON_CACHE.values;
}

function getRoomForClassMon(lopCanon, mon){
  const cache = ensureRoomForClassMonCache();
  const cacheKey = `${lopCanon || ""}|${mon || ""}`;
  if(cache.has(cacheKey)) return cache.get(cacheKey);
  const classKeys = classKeyCandidates(lopCanon);
  const monRaw = (mon||"").toString().trim();
  if(!classKeys.length || !monRaw){
    cache.set(cacheKey, "");
    return "";
  }

  const mh = findMonHoc(monRaw);
  const tries = [];
  const subjects = [monRaw];
  if(mh){
    [mh.ma, mh.ten, mh.ma2, mh.id].forEach(v=>{
      const s = (v||"").toString().trim();
      if(s && !subjects.includes(s)) subjects.push(s);
    });
  }
  classKeys.forEach(cls => subjects.forEach(subject => tries.push(`${cls}|${subject}`)));

  for(const k of tries){
    const v = DATA.tkbLessonRooms?.[k];
    if(v && String(v).trim()){
      const out = String(v).trim();
      cache.set(cacheKey, out);
      return out;
    }
  }
  for(const k of tries){
    const v = DATA.pccmRoomMatrix?.[k];
    if(v && String(v).trim()){
      const out = String(v).trim();
      cache.set(cacheKey, out);
      return out;
    }
  }
  cache.set(cacheKey, "");
  return "";
}

// Lấy số tiết / giới hạn theo Lớp|Môn từ bảng phân công (ưu tiên)
function _getPccmNum(matrix, lopCanon, mon){
  const cls = (lopCanon||"").toString().trim();
  const monRaw = (mon||"").toString().trim();
  if(!cls || !monRaw) return 0;

  const mh = findMonHoc(monRaw);
  const classKeys = classKeyCandidates(cls);
  const subjects = [];
  const addSubject = (v)=>{
    const s = (v||"").toString().trim();
    if(s && !subjects.includes(s)) subjects.push(s);
  };
  addSubject(monRaw);
  if(mh){
    [mh.ma, mh.ten, mh.ma2, mh.id].forEach(addSubject);
  }
  const tries = [];
  classKeys.forEach(clsKey => subjects.forEach(subject => tries.push(`${clsKey}|${subject}`)));

  for(const k of tries){
    const v = matrix?.[k];
    const s = (v==null) ? "" : String(v).trim();
    if(!s) continue;
    const n = Number(s);
    if(Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

const PCCM_NUM_CACHE = new WeakMap();
function invalidatePccmNumCaches(){
  try{ if(DATA.pccmTietMatrix) PCCM_NUM_CACHE.delete(DATA.pccmTietMatrix); }catch(_){}
  try{ if(DATA.pccmGioihanMatrix) PCCM_NUM_CACHE.delete(DATA.pccmGioihanMatrix); }catch(_){}
  try{ COMPUTE_MONS_CACHE = {refs: [], values: new Map()}; }catch(_){}
}
function getPccmNumCached(matrix, lopCanon, mon){
  if(!matrix || typeof matrix !== "object") return 0;
  let cache = PCCM_NUM_CACHE.get(matrix);
  if(!cache){
    cache = new Map();
    PCCM_NUM_CACHE.set(matrix, cache);
  }
  const key = `${lopCanon || ""}|${mon || ""}`;
  if(cache.has(key)) return cache.get(key);
  const out = _getPccmNum(matrix, lopCanon, mon);
  cache.set(key, out);
  return out;
}

function getSoTietForClassMon(lopCanon, mon){
  return getPccmNumCached(DATA.pccmTietMatrix, lopCanon, mon);
}
function getGioiHanForClassMon(lopCanon, mon){
  return getPccmNumCached(DATA.pccmGioihanMatrix, lopCanon, mon);
}

function monPrimaryStorageKey(mon){
  const mh = findMonHoc(mon);
  const raw = mh ? (mh.ma || mh.ma2 || mh.ten || mh.id || mon) : mon;
  return (raw||"").toString().trim();
}

function setClassSubjectSessionLimit(lopCanon, mon, limit){
  const cls = (lopCanon||"").toString().trim();
  const monKey = monPrimaryStorageKey(mon);
  const next = Math.max(1, Math.round(Number(limit || 1)));
  if(!cls || !monKey || !Number.isFinite(next)) return false;
  if(!DATA.pccmGioihanMatrix || typeof DATA.pccmGioihanMatrix !== "object") DATA.pccmGioihanMatrix = {};
  DATA.pccmGioihanMatrix[`${cls}|${monKey}`] = String(next);
  invalidatePccmNumCaches();
  CURRENT_MONS.forEach(m=>{
    if(monMatches(m.ten, mon)){
      m.gioihan = next;
      CURRENT_MON_META[m.ten] = {sotiet: m.sotiet, gioihan: next};
    }
  });
  const directMeta = CURRENT_MON_META[mon] || {sotiet: getMonMeta(mon).sotiet || 0, gioihan: next};
  CURRENT_MON_META[mon] = {...directMeta, gioihan: next};
  try{ saveStore({force:true}); }catch(e){ console.error("saveStore failed", e); }
  return true;
}
function cellMon(v){
  if(v === "OFF" || v === "" || v == null) return "";
  if(typeof v === "string") return v;
  if(typeof v === "object" && v.mon) return v.mon;
  return "";
}
function isFixed(v){ return (v && typeof v === "object" && v.fixed); }

function getLopCanonById(lopId){
  const id = (lopId||"").toString();
  const lop = (DATA.lop||[]).find(l=>String(l.id) === id);
  if(!lop) return normalizeClassName(id) || id;
  return (classCanonFromLop(lop) || normalizeClassName(lop.id) || id).toString().trim();
}

function findTeacherConflictAtSlot(teacherCode, thu, buoi, ti, ignoreLopId){
  const gv = teacherValueFromRaw(teacherCode);
  if(!gv) return null;
  const tThu = String(thu||"");
  const tBuoi = String(buoi||"");
  const tTi = Number(ti);
  const tkbs = DATA.tkb || {};
  for(const lopId of Object.keys(tkbs)){
    if(ignoreLopId && String(lopId) === String(ignoreLopId)) continue;
    const tkb = tkbs[lopId];
    const cell = tkb?.[tThu]?.[tBuoi]?.[tTi];
    if(!cell || cell === "OFF") continue;
    const mon = cellMon(cell);
    if(!mon) continue;
    const canon = getLopCanonById(lopId);
    const gv2 = getTeacherForClassMon(canon, mon);
    if(gv2 && teacherValuesIntersect(gv2, gv)) return { lopId, mon };
  }
  return null;
}

function findRoomConflictAtSlot(roomName, thu, buoi, ti, ignoreLopId){
  const room = (roomName||"").toString().trim();
  if(!room) return null;
  const tThu = String(thu||"");
  const tBuoi = String(buoi||"");
  const tTi = Number(ti);
  const tkbs = DATA.tkb || {};
  for(const lopId of Object.keys(tkbs)){
    if(ignoreLopId && String(lopId) === String(ignoreLopId)) continue;
    const tkb = tkbs[lopId];
    const cell = tkb?.[tThu]?.[tBuoi]?.[tTi];
    if(!cell || cell === "OFF") continue;
    const mon = cellMon(cell);
    if(!mon) continue;
    const canon = getLopCanonById(lopId);
    const r2 = getRoomForClassMon(canon, mon);
    if(r2 && String(r2).trim() === room) return { lopId, mon };
  }
  return null;
}

let __tkbStableSave = { payload: "", stats: null, at: 0, reason: "init" };

function __tkbSaveNum(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function __tkbCurrentSaveStats(){
  try{
    if(typeof calcSchoolTKBStats === "function"){
      const s = calcSchoolTKBStats() || {};
      return {
        total: __tkbSaveNum(s.soTiet),
        assigned: __tkbSaveNum(s.daXepTiet),
        missing: __tkbSaveNum(s.chuaXepTiet)
      };
    }
  }catch(_){}
  return { total: 0, assigned: 0, missing: 0 };
}
function __tkbStatsWorse(a, b){
  if(!a || !b) return false;
  if(__tkbSaveNum(a.missing) > __tkbSaveNum(b.missing)) return true;
  if(__tkbSaveNum(a.assigned) < __tkbSaveNum(b.assigned)) return true;
  return false;
}
function __tkbAlgorithmRunning(){
  try{
    return !!(
      window.__TKB_AUTO_SORT_RUNNING_20260508 ||
      window.__TKB_SUPPRESS_UNSTABLE_SAVE_20260508 ||
      window.__AUTO_SORT_STOP_REQUESTED ||
      window.__OPT_PANEL_STATE?.running
    );
  }catch(_){
    return false;
  }
}

const TKB_HISTORY_LIMIT = 50;
let TKB_UNDO_STACK = [];
let TKB_REDO_STACK = [];
let TKB_HISTORY_CURRENT = "";
let TKB_HISTORY_APPLYING = false;
let __tkbLastSavedPayload = "";
let __tkbPendingSavePayload = "";
let __tkbLastSavePromise = null;
let __tkbNavigatingHome = false;

function __tkbEnsureDataShape(){
  if(!DATA || typeof DATA !== "object") DATA = {};
  if(!DATA.tkb) DATA.tkb = {};
  if(!DATA.lop) DATA.lop = [];
  if(!DATA.mon) DATA.mon = [];
  if(!DATA.monhoc) DATA.monhoc = [];
  if(!DATA.pccmMatrix) DATA.pccmMatrix = {};
  if(!DATA.pccmRoomMatrix) DATA.pccmRoomMatrix = {};
  if(!DATA.pccmTietMatrix) DATA.pccmTietMatrix = {};
  if(!DATA.pccmGioihanMatrix) DATA.pccmGioihanMatrix = {};
  if(!DATA.tkbUserOff || typeof DATA.tkbUserOff !== "object") DATA.tkbUserOff = {};
}

function __tkbHistoryPayload(){
  try{ return JSON.stringify(DATA); }catch(_){ return ""; }
}

function __tkbPushHistory(stack, payload){
  if(!payload) return;
  if(stack.length && stack[stack.length - 1] === payload) return;
  stack.push(payload);
  while(stack.length > TKB_HISTORY_LIMIT) stack.shift();
}

function __tkbUpdateHistoryButtons(){
  const undoBtn = document.getElementById("btnUndoTKB");
  const redoBtn = document.getElementById("btnRedoTKB");
  if(undoBtn){
    undoBtn.disabled = TKB_UNDO_STACK.length === 0;
    if(undoBtn.disabled) undoBtn.setAttribute("aria-disabled", "true");
    else undoBtn.removeAttribute("aria-disabled");
  }
  if(redoBtn){
    redoBtn.disabled = TKB_REDO_STACK.length === 0;
    if(redoBtn.disabled) redoBtn.setAttribute("aria-disabled", "true");
    else redoBtn.removeAttribute("aria-disabled");
  }
}

function __tkbRecordHistoryAfterSave(payload, options, usedStable){
  const opts = options || {};
  if(TKB_HISTORY_APPLYING || opts.beforeUnload || opts.suppressHistory || usedStable){
    __tkbUpdateHistoryButtons();
    return;
  }
  if(!payload) return;
  if(!TKB_HISTORY_CURRENT) TKB_HISTORY_CURRENT = __tkbHistoryPayload();
  if(payload === TKB_HISTORY_CURRENT){
    __tkbUpdateHistoryButtons();
    return;
  }
  __tkbPushHistory(TKB_UNDO_STACK, TKB_HISTORY_CURRENT);
  TKB_REDO_STACK = [];
  TKB_HISTORY_CURRENT = payload;
  __tkbUpdateHistoryButtons();
}

function __tkbRestoreHistoryPayload(payload){
  let obj = {};
  try{ obj = JSON.parse(payload || "{}"); }catch(_){ obj = {}; }
  DATA = (obj && typeof obj === "object") ? obj : {};
  __tkbEnsureDataShape();
  try{ window.DATA = DATA; }catch(_){}
}

function __tkbRefreshAfterHistory(label){
  try{ clearDragVisual(); }catch(_){}
  dragData = null;
  dragMon = "";
  try{ clearCellSelection(); }catch(_){}
  try{ hideCellMenu(); }catch(_){}
  try{ renderCurrentView(); }catch(e){ console.error("renderCurrentView failed", e); }
  try{ loadMonList(); }catch(e){ console.error("loadMonList failed", e); }
  try{ applyCellSelectionStyles(); }catch(_){}
  __tkbUpdateHistoryButtons();
  const status = document.getElementById("statusMsg");
  if(status && label) status.textContent = label;
}

function tkbUndo(){
  if(!TKB_UNDO_STACK.length) return false;
  const current = TKB_HISTORY_CURRENT || __tkbHistoryPayload();
  const prev = TKB_UNDO_STACK.pop();
  __tkbPushHistory(TKB_REDO_STACK, current);
  TKB_HISTORY_APPLYING = true;
  try{
    __tkbRestoreHistoryPayload(prev);
    TKB_HISTORY_CURRENT = prev;
    saveStore({force:true});
    __tkbRememberStablePayload(prev, __tkbCurrentSaveStats(), "undo");
  }finally{
    TKB_HISTORY_APPLYING = false;
  }
  __tkbRefreshAfterHistory("Đã Undo");
  return true;
}

function tkbRedo(){
  if(!TKB_REDO_STACK.length) return false;
  const current = TKB_HISTORY_CURRENT || __tkbHistoryPayload();
  const next = TKB_REDO_STACK.pop();
  __tkbPushHistory(TKB_UNDO_STACK, current);
  TKB_HISTORY_APPLYING = true;
  try{
    __tkbRestoreHistoryPayload(next);
    TKB_HISTORY_CURRENT = next;
    saveStore({force:true});
    __tkbRememberStablePayload(next, __tkbCurrentSaveStats(), "redo");
  }finally{
    TKB_HISTORY_APPLYING = false;
  }
  __tkbRefreshAfterHistory("Đã Redo");
  return true;
}

function __tkbRememberStablePayload(payload, stats, reason){
  if(!payload) return;
  __tkbStableSave = {
    payload,
    stats: stats || __tkbCurrentSaveStats(),
    at: Date.now(),
    reason: reason || "save"
  };
  try{
    window.__TKB_STABLE_SAVE_20260508 = {
      stats: __tkbStableSave.stats,
      at: __tkbStableSave.at,
      reason: __tkbStableSave.reason
    };
  }catch(_){}
}
function __tkbPayloadForSave(options){
  const opts = options || {};
  const payload = JSON.stringify(DATA);
  const knownStats = opts.trustedSolverApply === true
    && opts.knownStats
    && typeof opts.knownStats === "object"
    ? opts.knownStats
    : null;
  const hasKnownStats = knownStats
    && Number.isFinite(Number(knownStats.total))
    && Number.isFinite(Number(knownStats.assigned))
    && Number.isFinite(Number(knownStats.missing));
  const currentStats = hasKnownStats
    ? {
        total:Math.max(0, Number(knownStats.total) || 0),
        assigned:Math.max(0, Number(knownStats.assigned) || 0),
        missing:Math.max(0, Number(knownStats.missing) || 0)
      }
    : __tkbCurrentSaveStats();
  const stable = __tkbStableSave || {};
  const running = __tkbAlgorithmRunning();
  const worse = stable.payload && __tkbStatsWorse(currentStats, stable.stats);
  const guardWorse = !!(worse && (running || opts.beforeUnload || opts.guardUnstable));
  const partialRefresh = !!(opts.beforeUnload && running && __tkbSaveNum(currentStats.missing) > 0);

  if(!opts.force && stable.payload && (guardWorse || partialRefresh)){
    try{
      window.__TKB_LAST_BLOCKED_UNSTABLE_SAVE_20260508 = {
        reason: worse ? "worse-than-stable" : "partial-refresh",
        currentStats,
        stableStats: stable.stats,
        at: new Date().toISOString()
      };
    }catch(_){}
    return { payload: stable.payload, stats: stable.stats, usedStable: true };
  }

  __tkbRememberStablePayload(payload, currentStats, opts.beforeUnload ? "beforeunload-current" : "saveStore");
  return { payload, stats: currentStats, usedStable: false };
}
function saveStore(options){
  let opts = options || {};
  const trustedSolverApply = opts.trustedSolverApply === true;
  if(!trustedSolverApply){
    try{ if(typeof reapplyAllUserOffLocks === "function") reapplyAllUserOffLocks(); }catch(_){}
  }
  let sanitizedChanged = false;
  if(!trustedSolverApply){
    try{ sanitizedChanged = !!sanitizePlannerDataFromIndex(); }catch(e){ console.warn("sanitizePlannerDataFromIndex before save failed", e); }
  }
  if(sanitizedChanged){
    opts = Object.assign({}, opts, {force:true});
    options = opts;
  }
  const chosen = __tkbPayloadForSave(opts);
  const payload = chosen.payload;
  if(opts.skipIfUnchanged && payload){
    if(payload === __tkbLastSavedPayload){
      return opts.awaitRemote ? Promise.resolve(false) : false;
    }
    if(payload === __tkbPendingSavePayload && __tkbLastSavePromise){
      return opts.awaitRemote ? __tkbLastSavePromise.then(() => false) : false;
    }
  }
  const changed = !chosen.usedStable;
  if(opts.syncRemote === true && typeof schoolParam !== "undefined" && schoolParam && typeof XMLHttpRequest !== "undefined"){
    try{
      const url = window.TKBStorage && typeof window.TKBStorage.remoteStoreUrl === "function"
        ? window.TKBStorage.remoteStoreUrl(schoolParam)
        : `/api/school/store?id=${encodeURIComponent(schoolParam)}`;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.send(payload);
      if(xhr.status >= 200 && xhr.status < 300){
        __tkbLastSavedPayload = payload;
        __tkbPendingSavePayload = "";
        __tkbLastSavePromise = null;
        __tkbRecordHistoryAfterSave(payload, options, chosen.usedStable);
        return changed;
      }
      console.warn("Sync remote store save failed", xhr.status);
    }catch(e){
      console.warn("Sync remote store save failed", e);
    }
  }
  let remoteSave = null;
  if(window.TKBStorage && typeof window.TKBStorage.saveSchoolData === "function"){
    remoteSave = Promise.resolve(window.TKBStorage.saveSchoolData(__plannerKv, schoolParam, payload)).then(ok => {
      if(ok === false) throw new Error("Remote school store save failed");
      return true;
    });
  }else{
    localStorage.setItem(STORE_KEY, payload);
    if (typeof schoolParam !== "undefined" && schoolParam) {
      remoteSave = fetch(`/api/school/store?id=${encodeURIComponent(schoolParam)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload
      }).then(resp => {
        if(!resp.ok) throw new Error("Remote school store save failed");
        return true;
      });
    }
  }
  try{
    if(!(window.TKBStorage && window.TKBStorage.remoteOnly) && typeof PRIMARY_STORE_KEY !== "undefined" && PRIMARY_STORE_KEY && PRIMARY_STORE_KEY !== STORE_KEY){
      localStorage.setItem(PRIMARY_STORE_KEY, payload);
    }
  }catch(_){}
  if(!(window.TKBStorage && window.TKBStorage.remoteOnly)) saveStoreKVDBBackup(payload);
  __tkbRecordHistoryAfterSave(payload, options, chosen.usedStable);
  if(remoteSave){
    __tkbPendingSavePayload = payload;
    __tkbLastSavePromise = remoteSave.then(() => {
      __tkbLastSavedPayload = payload;
      if(__tkbPendingSavePayload === payload) __tkbPendingSavePayload = "";
      return true;
    }).catch(e => {
      if(__tkbPendingSavePayload === payload) __tkbPendingSavePayload = "";
      throw e;
    });
    if(!opts.awaitRemote) __tkbLastSavePromise.catch(e => console.warn("Failed to sync store", e));
    if(opts.awaitRemote) return __tkbLastSavePromise.then(() => changed);
  }else{
    __tkbLastSavedPayload = payload;
  }
  return changed;
}

function deferInitialHistorySnapshot(){
  const run = () => {
    try{
      const payload = JSON.stringify(DATA);
      __tkbRememberStablePayload(payload, __tkbCurrentSaveStats(), "loaded");
      __tkbLastSavedPayload = payload;
      TKB_HISTORY_CURRENT = payload;
      __tkbUpdateHistoryButtons();
    }catch(e){
      console.warn("initial history snapshot failed", e);
    }
  };
  try{
    if(typeof window.requestIdleCallback === "function"){
      window.requestIdleCallback(run, {timeout: 3000});
      return;
    }
  }catch(_){ }
  try{ setTimeout(run, 300); }catch(_){ run(); }
}
try{
  window.saveStore = saveStore;
  window.tkbUndo = tkbUndo;
  window.tkbRedo = tkbRedo;
  window.__tkbMarkStableSavePoint20260508 = function(reason){
    __tkbRememberStablePayload(JSON.stringify(DATA), __tkbCurrentSaveStats(), reason || "mark");
    return true;
  };
  if(!window.__TKB_SAVE_ON_RELOAD_20260508__){
    window.__TKB_SAVE_ON_RELOAD_20260508__ = true;
    window.addEventListener("beforeunload", function(){
      if(__tkbNavigatingHome) return;
      try{
        const payload = JSON.stringify(DATA);
        if(payload === __tkbLastSavedPayload) return;
        if(payload === __tkbPendingSavePayload) return;
      }catch(_){}
      try{ saveStore({ beforeUnload: true }); }catch(_){}
    });
  }
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", __tkbUpdateHistoryButtons);
  }else{
    __tkbUpdateHistoryButtons();
  }
  deferInitialHistorySnapshot();
}catch(_){}

function getMonMeta(mon){
  return CURRENT_MON_META[mon] || {sotiet: 0, gioihan: 1};
}



/* [MOVED -> phanmon-ops.js] Section: heuristic_optimize */

/* ======================= VIEW MODE (LỚP / GIÁO VIÊN) ======================= */
function updateViewButtonsActive(){
  const bL = document.getElementById("btnViewLop");
  const bG = document.getElementById("btnViewGV");
  const bP = document.getElementById("btnViewPhong");
  if(bL) bL.classList.toggle("primary", VIEW_MODE === "lop");
  if(bG) bG.classList.toggle("primary", VIEW_MODE === "gv");
  if(bP) bP.classList.toggle("primary", VIEW_MODE === "phong");

  const leftTitle = document.getElementById("leftTitle");
  if(leftTitle) leftTitle.innerText = (VIEW_MODE === "gv") ? "Giáo viên" : "Lớp";

  // cập nhật placeholder tiêu đề
  const t = document.getElementById("titleLop");
  if(t){
    if(VIEW_MODE === "gv" && !currentGV) t.innerText = "Chọn giáo viên để xem TKB";
    if(VIEW_MODE === "phong" && !currentLop) t.innerText = "Chọn lớp để xem TKB";
    if(VIEW_MODE === "lop" && !currentLop) t.innerText = "Chọn lớp để xem TKB";
  }
}

function getFilteredLops(){
  const khoiSel = document.getElementById("chonKhoi")?.value || "";
  const kFilter = extractKhoiNumber(khoiSel);
  return (DATA.lop||[]).filter(l=>{
    if(!kFilter) return true;
    const kNum = extractKhoiNumber(l?.khoi) || extractKhoiNumber(l?.ten2) || extractKhoiNumber(l?.ten);
    return String(kNum) === String(kFilter);
  });
}

function getTeacherNameByCode(code){
  const c = (code||"").toString().trim().toLowerCase();
  if(!c) return "";
  const g = (DATA.giaovien||[]).find(x => (x.magv||"").toString().trim().toLowerCase() === c);
  if(!g) return "";
  return `${(g.hodem||"").toString().trim()} ${(g.ten||"").toString().trim()}`.trim();
}

function getTeacherShort(code){
  const raw = (code||"").toString().trim();
  const c = raw.toLowerCase();
  if(!c) return "";
  const g = (DATA.giaovien||[]).find(x => (x.magv||"").toString().trim().toLowerCase() === c);
  const short = (g?.tenTat || g?.tentat || g?.ten_tat || g?.vietTat || g?.viettat || g?.tenVietTat || g?.tenviettat || g?.shortName || g?.short || "").toString().trim();
  if(short) return short;
  return (g?.magv || raw).toString().trim();
}

function mobileStackCellLineHTML(primary, secondary, extraClasses){
  const first = (primary || "").toString().trim();
  const second = (secondary || "").toString().trim();
  const classes = ["tkb-cell-line", "tkb-mobile-stack-line", extraClasses || ""]
    .filter(Boolean)
    .join(" ");
  const separator = first && second
    ? `<span class="tkb-cell-separator" aria-hidden="true"> - </span>`
    : "";
  return `<div class="${classes}">`+
    (first ? `<span class="tkb-cell-primary">${escapeHtml(first)}</span>` : "")+
    separator+
    (second ? `<span class="tkb-cell-secondary">${escapeHtml(second)}</span>` : "")+
  `</div>`;
}

function getTeacherListForCurrentFilter(){
  const map = new Map(); // code -> {code,name}

  // 1) Lấy từ bảng giáo viên
  (DATA.giaovien||[]).forEach(g=>{
    const code = resolveTeacherCode(g?.magv);
    if(!code) return;
    map.set(code, {code, name: getTeacherNameByCode(code)});
  });

  // 2) Lấy thêm từ bảng phân công (lọc theo khối hiện tại)
  const lops = getFilteredLops();
  const classCanonSet = new Set();
  lops.forEach(l => classKeyCandidates(getLopCanonById(l.id)).forEach(k=>classCanonSet.add(k)));
  for(const [k,v] of Object.entries(DATA.pccmMatrix || {})){
    const cls = (k||"").split("|")[0] || "";
    if(!cls) continue;
    if(classCanonSet.size && !classCanonSet.has(cls)) continue;
    teacherListFromValue(v).forEach(code=>{
      if(!code) return;
      if(!map.has(code)) map.set(code, {code, name: getTeacherNameByCode(code)});
    });
  }

  // Nếu đang lọc theo khối và có dữ liệu phân công, ưu tiên chỉ hiện GV có phân công trong khối
  const khoiSel = document.getElementById("chonKhoi")?.value || "";
  const kFilter = extractKhoiNumber(khoiSel);
  let arr = Array.from(map.values()).filter(x=>x.code);
  if(kFilter){
    const has = new Set();
    for(const [k,v] of Object.entries(DATA.pccmMatrix || {})){
      const cls = (k||"").split("|")[0] || "";
      if(!cls) continue;
      if(!classCanonSet.has(cls)) continue;
      teacherListFromValue(v).forEach(code=>{ if(code) has.add(code); });
    }
    if(has.size) arr = arr.filter(t=>has.has(t.code));
  }

  arr.sort(compareTeacherCodeByDataOrder);
  return arr;
}

function showAllGV(){
  const box = document.getElementById("listLop");
  if(!box) return;
  box.innerHTML = "";

  const teachers = getTeacherListForCurrentFilter();

  if(!teachers.length){
    currentGV = null;
    updateViewButtonsActive();

    const t = document.getElementById("titleLop");
    if(t) t.innerText = "Chưa có giáo viên (hoặc chưa phân công)";
    const tkbBox = document.getElementById("tkb");
    if(tkbBox) tkbBox.innerHTML = "";
    return;
  }

  teachers.forEach(ti=>{
    const d = document.createElement("div");
    d.className = "lop-item";
    d.dataset.id = ti.code;
    // Theo yêu cầu: danh sách giáo viên chỉ hiển thị MÃ GV
    const activeStatType = getActiveTeacherStatType();
    const activeStatIssue = getActiveTeacherStatIssueForTeacher(ti.code);
    const onePeriodIssue = activeStatIssue;
    if(activeStatIssue){
      d.classList.add("teacher-one-period-issue");
      d.classList.add("teacher-stat-issue");
      d.title = onePeriodIssue.sessions.map(s=>`${s.thu} ${s.buoi} tiết ${Number(s.ti) + 1}`).join("\n");
      d.title = `${getTeacherStatLabel(activeStatType)}\n` + activeStatIssue.sessions.map(s=>`${s.thu} ${s.buoi}`).join("\n");
      d.innerHTML = `${escapeHtml(ti.code)} <span class="teacher-issue-badge">${teacherStatIssueCount(activeStatIssue)}</span>`;
      d.onclick = ()=>focusTeacherStatIssue(activeStatType, ti.code);
    }else{
      d.innerText = ti.code;
      d.onclick = ()=>selectGV(ti.code);
    }
    box.appendChild(d);
  });

  // tự mở GV đầu tiên
  if(!currentGV || !teachers.some(t=>t.code===currentGV)) currentGV = teachers[0].code;
  selectGV(currentGV);
}

function selectGV(code){
  clearDragVisual();
  dragData = null;
  dragMon = "";

  currentGV = (code||"").toString().trim();

  // active highlight ở danh sách
  document.querySelectorAll("#listLop .lop-item").forEach(el=>{
    el.classList.toggle("active", (el.dataset.id||"") == currentGV);
  });

  renderTKBTeacher(currentGV);
}

function renderCurrentView(){
  if(VIEW_MODE === "gv"){
    if(currentGV) renderTKBTeacher(currentGV);
    else {
      const t = document.getElementById("titleLop");
      if(t) t.innerText = "Chọn giáo viên để xem TKB";
      const tkbBox = document.getElementById("tkb");
      if(tkbBox) tkbBox.innerHTML = "";
    }
    return;
  }

  if(VIEW_MODE === "phong"){
    if(currentLop) renderTKBPhong(currentPhong || "");
    else {
      const t = document.getElementById("titleLop");
      if(t) t.innerText = "Chọn lớp để xem TKB";
      const tkbBox = document.getElementById("tkb");
      if(tkbBox) tkbBox.innerHTML = "";
    }
    return;
  }

  if(currentLop) renderTKB(currentLop);
  else {
    const t = document.getElementById("titleLop");
    if(t) t.innerText = "Chọn lớp để xem TKB";
    const tkbBox = document.getElementById("tkb");
    if(tkbBox) tkbBox.innerHTML = "";
  }
}

function setViewMode(mode){
  const m = (mode||"").toString();
  VIEW_MODE = TKB_CLASS_VIEW_ONLY ? "lop" : ((m === "gv") ? "gv" : (m === "phong" ? "phong" : "lop"));

  // clear kéo thả khi đổi mode
  clearDragVisual();
  dragData = null;
  dragMon = "";

  // clear chọn ô / menu khi đổi mode
  try{ clearCellSelection(); }catch(_){ }
  try{ hideCellMenu(); }catch(_){ }
  try{ _cancelCellLongPress(); }catch(_){ }

  // ẩn menu xóa nếu đang mở
  if(typeof cancelDeleteMenu === "function") cancelDeleteMenu(true);

  updateViewButtonsActive();

  if(VIEW_MODE === "gv"){
    // Tắt trạng thái lớp để danh sách Chưa phân không còn draggable
    currentLop = null;
    currentPhong = null;
    showAllGV();
  } else if(VIEW_MODE === "phong"){
    currentGV = null;
    currentPhong = null;
    showAllLop();
  } else {
    currentGV = null;
    currentPhong = null;
    // luôn hiển thị tất cả lớp
    showAllLop();
  }

  // refresh danh sách Chưa phân theo khối hiện tại
  scheduleLoadMonList("setViewMode");
}

/* ===== TKB theo Giáo viên ===== */
function buildTeacherSchedule(gvCode){
  const code = (gvCode||"").toString().trim();
  const sched = {};
  DAYS.forEach(d=>{
    sched[d] = {
      sang: Array.from({length:SANG}, ()=>[]),
      chieu: Array.from({length:CHIEU}, ()=>[])
    };
  });

  const lops = getFilteredLops();
  lops.forEach(l=>{
    const classId = l.id;
    const tkb = DATA.tkb?.[classId];
    if(!tkb) return;

    const classDisplay = classCanonFromLop(l);
    const classCanon = getLopCanonById(classId);

    for(const thu of DAYS){
      // sáng
      for(let ti=0; ti<SANG; ti++){
        const v = tkb?.[thu]?.sang?.[ti];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        const gv = getTeacherForClassMon(classCanon, mon);
        if(gv && teacherValueHas(gv, code)){
          const room = getRoomForClassMon(classCanon, mon);
          sched[thu].sang[ti].push({classId, classDisplay, mon, room, fixed: !!isFixed(v)});
        }
      }
      // chiều
      for(let ti=0; ti<CHIEU; ti++){
        const v = tkb?.[thu]?.chieu?.[ti];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        const gv = getTeacherForClassMon(classCanon, mon);
        if(gv && teacherValueHas(gv, code)){
          const room = getRoomForClassMon(classCanon, mon);
          sched[thu].chieu[ti].push({classId, classDisplay, mon, room, fixed: !!isFixed(v)});
        }
      }
    }
  });

  return sched;
}

function cellHTMLTeacher(entries, thu, buoi, ti, gvCode){
  const arr = Array.isArray(entries) ? entries : [];
  const conflict = arr.length > 1;
  const teacherOff = isTeacherFixedOff(gvCode, thu, buoi, ti);
  const offConflict = teacherOff && arr.length > 0;
  const fixed = !teacherOff && arr.length > 0 && arr.some(e=>!!e.fixed);

  const lines = arr.map(e=>{
    const monShort = getMonShort(e.mon);
    const room = (e.room||"").toString().trim();
    return `<div class="tkb-cell-stack">`+
      mobileStackCellLineHTML(e.classDisplay, monShort, "tkb-class-line tkb-class-subject-line")+
      (room ? `<div class="tkb-cell-line tkb-teacher-line tkb-room-line">${escapeHtml(room)}</div>` : "")+
    `</div>`;
  });

  const htmlLines = lines.join("");
  const visibleLines = teacherOff
    ? (offConflict ? `<div class="tkb-off-conflict-label">Nghỉ</div>${htmlLines}` : "")
    : htmlLines;
  const classIds = arr.map(e=>String(e.classId)).join(",");
  const one = arr.length === 1 ? arr[0] : null;
  const oneAttrs = one
    ? ` data-classid="${escapeHtml(String(one.classId))}" data-mon="${escapeHtml(String(one.mon || ""))}"`
    : "";

  return `<td class="${conflict?"tkb-gv-conflict":""} ${teacherOff?"tkb-off":""} ${offConflict?"tkb-off-conflict":""} ${fixed?"tkb-fixed":""}" data-classids="${escapeHtml(classIds)}" data-teacher="${escapeHtml(String(gvCode || ""))}" data-thu="${thu}" data-buoi="${buoi}" data-ti="${ti}"${oneAttrs} draggable="false">`+
         `<div class="tkb-gv-cell">${visibleLines}</div>`+
         `</td>`;
}

function bindTeacherCells(){
  document.querySelectorAll("#tkb td").forEach(td=>{
    bindSelectableCell(td);
    bindRightClickUnassignCell(td);
    const ids = (td.dataset.classids||"").split(",").map(s=>s.trim()).filter(Boolean);
    if(!ids.length) return;
    td.style.cursor = "pointer";
    td.ondblclick = (e)=>{
      if(ids.length === 1){
        handleCellDoubleAction(td, e);
        return;
      }
      try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
      // nhiều lớp trong cùng tiết => báo xung đột
      const txt = (td.innerText || "").trim();
      alert("⚠ Trùng lịch (nhiều lớp cùng 1 tiết):\n" + txt);
    };
  });
}

function renderTKBTeacher(gvCode){
  const box = document.getElementById("tkb");
  if(!box) return;
  box.classList.remove("tkb-pair-stack", "tkb-pair-lop-gv", "tkb-pair-gv-phong", "tkb-pair-lop-phong");

  const code = (gvCode||"").toString().trim();
  const name = getTeacherNameByCode(code);
  const title = document.getElementById("titleLop");
  // Theo yêu cầu: chỉ hiển thị TÊN GV (nếu không có tên thì fallback mã)
  if(title) title.innerText = name || code;

  const sched = buildTeacherSchedule(code);

  let h = "<table class='table'><tr>";
  DAYS.forEach(d => h += `<th>${LABEL[d]}</th>`);
  h += "</tr>";

  const TOTAL = SANG + CHIEU;
  for(let row=0; row<TOTAL; row++){
    const isAfternoon = row >= SANG;
    const buoi = isAfternoon ? "chieu" : "sang";
    const ti = isAfternoon ? (row - SANG) : row;

    h += `<tr${row===SANG ? " class=\"split-row\"" : ""}>`;
    DAYS.forEach(d => {
      const entries = isAfternoon ? sched[d].chieu[ti] : sched[d].sang[ti];
      h += cellHTMLTeacher(entries, d, buoi, ti, code);
    });
    h += "</tr>";
  }

  h += "</table>";
  box.innerHTML = h;
  bindTeacherCells();
}


/* ===== TKB theo Phòng ===== */
function getRoomListForCurrentFilter(){
  const set = new Set();
  const lops = getFilteredLops();
  const classCanonSet = new Set();
  lops.forEach(l => classKeyCandidates(getLopCanonById(l.id)).forEach(k=>classCanonSet.add(k)));

  // Ưu tiên lấy từ bảng phân công phòng
  for(const [k,v] of Object.entries(DATA.pccmRoomMatrix || {})){
    const cls = (k||"").split("|")[0] || "";
    if(classCanonSet.size && cls && !classCanonSet.has(cls)) continue;
    const room = (v==null) ? "" : String(v).trim();
    if(room) set.add(room);
  }

  // Fallback: nếu chưa có phân công phòng, quét trong TKB hiện tại
  if(set.size === 0){
    const tkbs = DATA.tkb || {};
    for(const lopId of Object.keys(tkbs)){
      const tkb = tkbs[lopId];
      if(!tkb) continue;
      const canon = getLopCanonById(lopId);
      for(const thu of DAYS){
        for(const buoi of ["sang","chieu"]){
          const arr = tkb?.[thu]?.[buoi] || [];
          for(let ti=0; ti<arr.length; ti++){
            const v = arr[ti];
            if(!v || v === "OFF" || isFixed(v)) continue;
            const mon = cellMon(v);
            if(!mon) continue;
            const room = getRoomForClassMon(canon, mon);
            if(room) set.add(String(room).trim());
          }
        }
      }
    }
  }

  return Array.from(set).filter(Boolean).sort((a,b)=>a.localeCompare(b,'vi'));
}

function showAllPhong(){
  const box = document.getElementById("listLop");
  if(!box) return;
  box.innerHTML = "";

  const rooms = getRoomListForCurrentFilter();

  if(!rooms.length){
    currentPhong = null;
    updateViewButtonsActive();

    const t = document.getElementById("titleLop");
    if(t) t.innerText = "Chưa có phòng (hoặc chưa phân công phòng)";
    const tkbBox = document.getElementById("tkb");
    if(tkbBox) tkbBox.innerHTML = "";
    return;
  }

  rooms.forEach(room=>{
    const d = document.createElement("div");
    d.className = "lop-item";
    d.dataset.id = room;
    d.innerText = room;
    d.onclick = ()=>selectPhong(room);
    box.appendChild(d);
  });

  if(!currentPhong || !rooms.includes(currentPhong)) currentPhong = rooms[0];
  selectPhong(currentPhong);
}

function selectPhong(room){
  clearDragVisual();
  dragData = null;
  dragMon = "";

  currentPhong = (room||"").toString().trim();
  document.querySelectorAll("#listLop .lop-item").forEach(el=>{
    el.classList.toggle("active", (el.dataset.id||"") == currentPhong);
  });
  renderTKBPhong(currentPhong);
}

function buildRoomSchedule(roomName){
  const roomKey = (roomName||"").toString().trim();
  const sched = {};
  DAYS.forEach(d=>{
    sched[d] = {
      sang: Array.from({length:SANG}, ()=>[]),
      chieu: Array.from({length:CHIEU}, ()=>[])
    };
  });

  const lops = getFilteredLops();
  lops.forEach(l=>{
    const classId = l.id;
    const tkb = DATA.tkb?.[classId];
    if(!tkb) return;
    const classDisplay = classCanonFromLop(l);
    const classCanon = getLopCanonById(classId);

    for(const thu of DAYS){
      for(let ti=0; ti<SANG; ti++){
        const v = tkb?.[thu]?.sang?.[ti];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        const room = getRoomForClassMon(classCanon, mon);
        if(room && String(room).trim() === roomKey){
          const gv = getTeacherForClassMon(classCanon, mon);
          sched[thu].sang[ti].push({classId, classDisplay, mon, gv});
        }
      }
      for(let ti=0; ti<CHIEU; ti++){
        const v = tkb?.[thu]?.chieu?.[ti];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        const room = getRoomForClassMon(classCanon, mon);
        if(room && String(room).trim() === roomKey){
          const gv = getTeacherForClassMon(classCanon, mon);
          sched[thu].chieu[ti].push({classId, classDisplay, mon, gv});
        }
      }
    }
  });
  return sched;
}

function cellHTMLPhong(entries, thu, buoi, ti){
  const arr = Array.isArray(entries) ? entries : [];
  const conflict = arr.length > 1;

  const lines = arr.map(e=>{
    const monShort = getMonShort(e.mon);
    const gv = (e.gv||"").toString().trim();
    const top = [e.classDisplay, monShort].filter(Boolean).join(" - ");
    return `<div class="tkb-cell-stack">`+
      `<div class="tkb-cell-line tkb-class-line">${escapeHtml(top)}</div>`+
      (gv ? `<div class="tkb-cell-line tkb-teacher-line">${escapeHtml(gv)}</div>` : "")+
    `</div>`;
  });
  const htmlLines = lines.join("");
  const classIds = arr.map(e=>String(e.classId)).join(",");
  const one = arr.length === 1 ? arr[0] : null;
  const oneAttrs = one
    ? ` data-classid="${escapeHtml(String(one.classId))}" data-mon="${escapeHtml(String(one.mon || ""))}"`
    : "";

  return `<td class="${conflict?"tkb-gv-conflict":""}" data-classids="${escapeHtml(classIds)}" data-thu="${thu}" data-buoi="${buoi}" data-ti="${ti}"${oneAttrs} draggable="false">`+
         `<div class="tkb-gv-cell">${htmlLines}</div>`+
         `</td>`;
}

function bindRoomCells(){
  document.querySelectorAll("#tkb td").forEach(td=>{
    bindSelectableCell(td);
    bindRightClickUnassignCell(td);
    const ids = (td.dataset.classids||"").split(",").map(s=>s.trim()).filter(Boolean);
    if(!ids.length) return;
    td.style.cursor = "pointer";
    td.ondblclick = (e)=>{
      if(ids.length === 1){
        handleCellDoubleAction(td, e);
        return;
      }
      try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
      const txt = (td.innerText || "").trim();
      alert("⚠ Trùng phòng (nhiều lớp cùng 1 tiết):\n" + txt);
    };
  });
}

function renderTKBPhong(roomName){
  const box = document.getElementById("tkb");
  if(!box) return;
  box.classList.remove("tkb-pair-stack", "tkb-pair-lop-gv", "tkb-pair-gv-phong", "tkb-pair-lop-phong");

  const name = (roomName||"").toString().trim();
  const title = document.getElementById("titleLop");
  if(title) title.innerText = name || "";

  const sched = buildRoomSchedule(name);

  let h = "<table class='table'><tr>";
  DAYS.forEach(d => h += `<th>${LABEL[d]}</th>`);
  h += "</tr>";

  const TOTAL = SANG + CHIEU;
  for(let row=0; row<TOTAL; row++){
    const isAfternoon = row >= SANG;
    const buoi = isAfternoon ? "chieu" : "sang";
    const ti = isAfternoon ? (row - SANG) : row;

    h += `<tr${row===SANG ? " class=\"split-row\"" : ""}>`;
    DAYS.forEach(d => {
      const entries = isAfternoon ? sched[d].chieu[ti] : sched[d].sang[ti];
      h += cellHTMLPhong(entries, d, buoi, ti);
    });
    h += "</tr>";
  }
  h += "</table>";

  box.innerHTML = h;
  bindRoomCells();
}


/* ======================= INIT ======================= */
function deferInitialSaveStore(reason){
  const run = () => {
    try{ saveStore({force:true, reason: reason || "deferred-init"}); }
    catch(e){ console.warn("deferred init saveStore failed", e); }
  };
  try{
    if(typeof window.requestIdleCallback === "function"){
      window.requestIdleCallback(run, {timeout: 2500});
      return;
    }
  }catch(_){ }
  try{ setTimeout(run, 250); }catch(_){ run(); }
}

document.addEventListener("DOMContentLoaded", () => {
  // Dong bo theo du lieu index: chi hien lop that trong DATA.lop, don alias cu 6A1 <-> 6/1.
  try{
    if(sanitizePlannerDataFromIndex()) deferInitialSaveStore("sanitize-on-load");
  }catch(e){
    console.warn("sanitizePlannerDataFromIndex failed", e);
  }

  // Migration dữ liệu cũ
  try{ migrateRemoveLegacyDefaultFixedEvents(); }catch(_){ }
  try{ migrateInvalidPartialSchedule(); }catch(_){ }
  // Hotkeys: Ctrl/Cmd+C + Ctrl/Cmd+V (copy/paste ô NGHỈ)
  try{ installTKBHotkeysOnce(); }catch(_){ }

  initKhoiOptions();
  // Mặc định: xem theo Lớp
  setViewMode("lop");
  try{ initRightPanelCollapse(); }catch(_){ }
});

document.addEventListener("DOMContentLoaded", () => {
  try{
    window.__TKB_PLANNER_DOM_READY = true;
    if(window.__TKB_PLANNER_REMOTE_HYDRATION_PENDING !== true
      && window.__TKB_PLANNER_REMOTE_RELOAD_REQUESTED !== true){
      window.__TKB_MARK_PLANNER_DATA_READY?.();
    }
  }catch(_){ }
}, {once:true});

function initRightPanelCollapse(){
  const panel = document.getElementById("rightPanel");
  if(!panel) return;
  let collapsed = true;
  try{
    const saved = localStorage.getItem("tkbRightCollapsed");
    if(saved === "0") collapsed = false;
    if(saved === "1") collapsed = true;
    const savedWidth = Number(localStorage.getItem("tkbRightWidth") || 0);
    if(Number.isFinite(savedWidth) && savedWidth >= 240){
      panel.style.setProperty("--tkb-right-width", Math.max(240, Math.min(560, savedWidth)) + "px");
    }
  }catch(_){}
  panel.classList.toggle("is-collapsed", collapsed);
  updateRightPanelToggle();
  installRightPanelResize();
}

function updateRightPanelToggle(){
  const panel = document.getElementById("rightPanel");
  const btn = document.getElementById("rightPanelToggle");
  if(!panel || !btn) return;
  const collapsed = panel.classList.contains("is-collapsed");
  btn.textContent = collapsed ? "<" : ">";
  btn.title = collapsed ? "Mở bảng bên phải" : "Bấm để thu nhỏ, kéo ngang để đổi độ rộng";
  btn.setAttribute("aria-label", btn.title);
}

function toggleRightPanel(force){
  const panel = document.getElementById("rightPanel");
  if(!panel) return;
  if(window.__tkbRightSuppressNextToggle && typeof force !== "boolean"){
    window.__tkbRightSuppressNextToggle = false;
    return;
  }
  const collapsed = (typeof force === "boolean") ? force : !panel.classList.contains("is-collapsed");
  panel.classList.toggle("is-collapsed", collapsed);
  try{ localStorage.setItem("tkbRightCollapsed", collapsed ? "1" : "0"); }catch(_){}
  updateRightPanelToggle();
}
window.toggleRightPanel = toggleRightPanel;

function positionStatsPopover(){
  const pop = document.getElementById("statsPopover");
  const btn = document.getElementById("statsToggle");
  if(!pop || !btn || pop.hidden) return;
  const rect = btn.getBoundingClientRect();
  const toolbarRect = document.querySelector(".toolbar")?.getBoundingClientRect();
  const narrow = window.innerWidth <= 900;
  const gap = 10;
  const margin = 8;
  const top = Math.max(
    margin,
    Math.round(rect.bottom + gap),
    Math.round((toolbarRect?.bottom || 0) + gap)
  );
  const right = narrow ? margin : Math.max(margin, Math.round(window.innerWidth - rect.right));
  const left = narrow ? margin : "";
  const availableHeight = Math.max(180, Math.round(window.innerHeight - top - margin));
  pop.style.position = "fixed";
  pop.style.top = top + "px";
  pop.style.left = left ? left + "px" : "";
  pop.style.right = right + "px";
  pop.style.width = narrow ? "auto" : "";
  pop.style.maxHeight = Math.min(680, availableHeight) + "px";
  pop.style.zIndex = "15000";
}

function setStatsPopoverOpen(open){
  const pop = document.getElementById("statsPopover");
  const btn = document.getElementById("statsToggle");
  if(!pop || !btn) return;
  const shouldOpen = !!open;
  if(shouldOpen){
    try{ renderStatsBox(); }catch(_){ }
  }
  pop.hidden = !shouldOpen;
  btn.classList.toggle("is-open", shouldOpen);
  btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  if(shouldOpen) requestAnimationFrame(positionStatsPopover);
}

function closeStatsPopover(){
  setStatsPopoverOpen(false);
}

function toggleStatsPopover(ev){
  try{ ev?.preventDefault(); ev?.stopPropagation(); }catch(_){ }
  const pop = document.getElementById("statsPopover");
  if(!pop) return;
  setStatsPopoverOpen(pop.hidden);
}
window.toggleStatsPopover = toggleStatsPopover;
window.closeStatsPopover = closeStatsPopover;
window.setStatsPopoverOpen = setStatsPopoverOpen;
window.positionStatsPopover = positionStatsPopover;

function openStatsPopoverDuringSolve(){
  setStatsPopoverOpen(true);
  try{ renderStatsBox(); }catch(_){ }
}
window.openStatsPopoverDuringSolve = openStatsPopoverDuringSolve;

if(!window.__TKB_STATS_POPOVER_BOUND){
  window.__TKB_STATS_POPOVER_BOUND = true;
  document.addEventListener("pointerdown", ev=>{
    if(ev.target?.closest?.(".stats-popover-wrap")) return;
    closeStatsPopover();
  }, true);
  document.addEventListener("keydown", ev=>{
    if(ev.key === "Escape") closeStatsPopover();
  });
  window.addEventListener("resize", positionStatsPopover, {passive: true});
  window.addEventListener("scroll", positionStatsPopover, {passive: true});
}

function installRightPanelResize(){
  const panel = document.getElementById("rightPanel");
  const btn = document.getElementById("rightPanelToggle");
  if(!panel || !btn || btn.__tkbResizeBound) return;
  btn.__tkbResizeBound = true;

  btn.addEventListener("pointerdown", (ev)=>{
    if(ev.button != null && ev.button !== 0) return;
    const startX = ev.clientX;
    const startWidth = panel.classList.contains("is-collapsed")
      ? 320
      : Math.max(240, panel.getBoundingClientRect().width || 320);
    let moved = false;

    const onMove = (mv)=>{
      const dx = mv.clientX - startX;
      if(!moved && Math.abs(dx) < 5) return;
      moved = true;
      panel.classList.remove("is-collapsed");
      const next = Math.max(240, Math.min(560, Math.round(startWidth - dx)));
      panel.style.setProperty("--tkb-right-width", next + "px");
      try{ localStorage.setItem("tkbRightCollapsed", "0"); }catch(_){}
      updateRightPanelToggle();
      mv.preventDefault();
    };

    const onUp = ()=>{
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if(moved){
        const w = Math.round(panel.getBoundingClientRect().width || startWidth);
        try{ localStorage.setItem("tkbRightWidth", String(w)); }catch(_){}
        window.__tkbRightSuppressNextToggle = true;
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

/* ======================= KHỐI ======================= */
function initKhoiOptions(){
  const sel = document.getElementById("chonKhoi");
  const btnBox = document.getElementById("khoiButtons");
  if(!sel) return;
  sel.innerHTML = `<option value="">Tất cả</option>`;

  // chuẩn hóa khối: luôn dùng "Khối N"
  // fallback: nếu l.khoi trống thì suy ra từ tên lớp (6A1 -> 6)
  const set = new Map();
  (DATA.lop||[]).forEach(l=>{
    const n = extractKhoiNumber(l?.khoi) || extractKhoiNumber(l?.ten2) || extractKhoiNumber(l?.ten);
    if(n) set.set("Khối "+n, "Khối "+n);
  });
  const khois = [...set.keys()].sort((a,b)=>Number(extractKhoiNumber(a))-Number(extractKhoiNumber(b)));
  khois.forEach(k=> sel.innerHTML += `<option value="${k}">${k}</option>`);

  // Render buttons (thay cho listbox)
  if(btnBox){
    const cur = sel.value || "";
    const mkBtn = (val, label) => {
      const safe = (val||"").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
      const cls = (cur === (val||"")) ? "primary" : "";
      return `<button data-khoi="${val||""}" class="${cls}" onclick="chonKhoiBtn('${safe}')">${label}</button>`;
    };
    btnBox.innerHTML = [mkBtn("", "Tất cả"), ...khois.map(k=>mkBtn(k, k))].join("\n");
  }
}

function updateKhoiButtonsActive(){
  const sel = document.getElementById("chonKhoi");
  const btnBox = document.getElementById("khoiButtons");
  if(!btnBox || !sel) return;
  const cur = sel.value || "";
  btnBox.querySelectorAll("button[data-khoi]").forEach(b=>{
    if((b.getAttribute("data-khoi")||"") === cur) b.classList.add("primary");
    else b.classList.remove("primary");
  });
}

function chonKhoiBtn(khoi){
  const sel = document.getElementById("chonKhoi");
  if(!sel) return;
  sel.value = khoi || "";
  updateKhoiButtonsActive();

  // Nếu đang xem theo giáo viên thì chỉ cần reload danh sách GV + bảng TKB GV
  if(VIEW_MODE === "gv"){
    showAllGV();
    loadMonList();
    return;
  }

  // Mặc định: theo lớp
  if(sel.value) loadLopList();
  else showAllLop();
}

/* ======================= LỚP ======================= */
function showAllLop(){
  // reset khối filter
  const sel = document.getElementById("chonKhoi");
  if(sel) sel.value = "";
  updateKhoiButtonsActive();

  const box = document.getElementById("listLop");
  if(!box) return;
  box.innerHTML = "";

  const lops = (DATA.lop||[]).slice().sort(compareClassByDataOrder);

  lops.forEach(l=>{
    const d = document.createElement("div");
    d.className = "lop-item";
    d.dataset.id = l.id;
    d.innerText = classCanonFromLop(l);
    d.onclick = ()=>selectLop(l.id);
    box.appendChild(d);
  });

  // tự mở lớp đầu tiên
  if(lops.length){
    selectLop(lops[0].id);
  }else{
    currentLop = null;
    const t = document.getElementById("titleLop");
    if(t) t.innerText = "Chưa có lớp";
    const tkbBox = document.getElementById("tkb");
    if(tkbBox) tkbBox.innerHTML = "";
    loadMonList();
  }
}

function loadLopList(){
  if(VIEW_MODE === "gv"){ showAllGV(); return; }

  const khoi = document.getElementById("chonKhoi").value; // "Khối N"
  updateKhoiButtonsActive();
  const box = document.getElementById("listLop");
  if(!box) return;
  box.innerHTML = "";
  if(!khoi) return;

  const kNum = extractKhoiNumber(khoi);
  const lops = (DATA.lop||[]).filter(l => (extractKhoiNumber(l?.khoi) || extractKhoiNumber(l?.ten2) || extractKhoiNumber(l?.ten)) === kNum)
    .sort(compareClassByDataOrder);

  lops.forEach(l=>{
      const d = document.createElement("div");
      d.className = "lop-item";
      d.dataset.id = l.id;
      d.innerText = classCanonFromLop(l);
      d.onclick = ()=>selectLop(l.id);
      box.appendChild(d);
    });

  // tự mở lớp đầu tiên trong khối
  if(lops.length) selectLop(lops[0].id);
  else {
    currentLop = null;
    const t = document.getElementById("titleLop");
    if(t) t.innerText = "Chưa có lớp";
    const tkbBox = document.getElementById("tkb");
    if(tkbBox) tkbBox.innerHTML = "";
    loadMonList();
  }
}

/* ======================= TIẾT CHUẨN THEO KHỐI ======================= */
function _monDisplayName(monKey){
  const raw = (monKey||"").toString().trim();
  if(!raw) return "";
  const mh = findMonHoc(raw);
  const ten = (mh && mh.ten) ? String(mh.ten).trim() : "";
  return ten || raw;
}

let PCCM_SUBJECT_INDEX = {
  refs: [],
  byClass: new Map()
};

function ensurePccmSubjectIndex(){
  const refs = [DATA.pccmMatrix, DATA.pccmTietMatrix, DATA.pccmGioihanMatrix, DATA.pccmRoomMatrix];
  if(PCCM_SUBJECT_INDEX.refs.length === refs.length && refs.every((ref,i)=>ref === PCCM_SUBJECT_INDEX.refs[i])){
    return PCCM_SUBJECT_INDEX.byClass;
  }
  const byClass = new Map();
  const addMatrix = mat => {
    if(!mat || typeof mat !== "object") return;
    Object.keys(mat).forEach(k=>{
      const parts = String(k || "").split("|");
      const cls = String(parts.shift() || "").trim();
      const monKey = String(parts.join("|") || "").trim();
      if(!cls || !monKey) return;
      if(!byClass.has(cls)) byClass.set(cls, new Set());
      byClass.get(cls).add(monKey);
    });
  };
  refs.forEach(addMatrix);
  PCCM_SUBJECT_INDEX = {refs, byClass};
  return byClass;
}

function _collectPCCMSubjectKeysForClass(lopCanon){
  const cls = (lopCanon||"").toString().trim();
  const out = new Set();
  if(!cls) return out;
  const classKeys = classKeyCandidates(cls);
  const index = ensurePccmSubjectIndex();
  classKeys.forEach(classKey=>{
    const indexed = index.get(classKey);
    if(indexed) indexed.forEach(monKey=>out.add(monKey));
  });
  if(out.size) return out;

  const add = (mat)=>{
    if(!mat || typeof mat !== "object") return;
    for(const k of Object.keys(mat)){
      for(const classKey of classKeys){
        const prefix = `${classKey}|`;
        if(!k.startsWith(prefix)) continue;
        const monKey = k.slice(prefix.length);
        if(monKey) out.add(monKey);
      }
    }
  };

  // GV / Tiết / Giới hạn / Phòng: hễ có trong phân công là coi như "có môn"
  add(DATA.pccmMatrix);
  add(DATA.pccmTietMatrix);
  add(DATA.pccmGioihanMatrix);
  add(DATA.pccmRoomMatrix);
  return out;
}

// Fallback: tìm Tiết chuẩn theo khối cho 1 môn (match theo tên/mã nếu có monhoc)
function _findTietChuanRow(khoiNum, monNameOrKey){
  const k = String(khoiNum||"");
  const raw = (monNameOrKey||"").toString().trim();
  if(!k || !raw) return null;

  const mh = findMonHoc(raw);
  const tries = [];
  tries.push(raw);
  if(mh){
    if(mh.ten) tries.push(String(mh.ten).trim());
    if(mh.ma) tries.push(String(mh.ma).trim());
    if(mh.ma2) tries.push(String(mh.ma2).trim());
    if(mh.id) tries.push(String(mh.id).trim());
  }

  const norm = (s)=> (s||"").toString().trim().toLowerCase();
  const tset = new Set(tries.filter(Boolean).map(norm));

  return (DATA.mon||[]).find(r=>{
    const rk = String(extractKhoiNumber(r?.khoi) || "");
    if(rk !== k) return false;
    const rt = norm(r?.ten);
    return rt && tset.has(rt);
  }) || null;
}

// PURE: không mutate CURRENT_*
// - Ưu tiên: lấy môn + số tiết + giới hạn từ bảng PHÂN CÔNG của lớp
// - Fallback: Tiết chuẩn theo khối (DATA.mon)
let COMPUTE_MONS_CACHE = {
  refs: [],
  values: new Map()
};

let TKB_LOAD_MON_LIST_TIMER = 0;
let TKB_LOAD_MON_LIST_LAST_AT = 0;
function scheduleLoadMonList(reason){
  if(TKB_LOAD_MON_LIST_TIMER) return;
  const run = () => {
    TKB_LOAD_MON_LIST_TIMER = 0;
    try{ loadMonList(); }catch(e){ console.error("loadMonList failed", e); }
  };
  try{
    TKB_LOAD_MON_LIST_TIMER = setTimeout(run, 120);
  }catch(_){
    TKB_LOAD_MON_LIST_TIMER = 0;
    run();
  }
}
try{ window.scheduleLoadMonList = scheduleLoadMonList; }catch(_){}

function cloneMonsList(list){
  return (Array.isArray(list) ? list : []).map(m=>Object.assign({}, m));
}

function ensureComputeMonsCache(){
  const refs = [DATA.mon, DATA.monhoc, DATA.pccmMatrix, DATA.pccmTietMatrix, DATA.pccmGioihanMatrix, DATA.pccmRoomMatrix, DATA.tkbLessonTeachers];
  if(COMPUTE_MONS_CACHE.refs.length === refs.length && refs.every((ref,i)=>ref === COMPUTE_MONS_CACHE.refs[i])){
    return COMPUTE_MONS_CACHE.values;
  }
  COMPUTE_MONS_CACHE = {refs, values: new Map()};
  return COMPUTE_MONS_CACHE.values;
}

function computeMonsForClass(khoiNum, lopCanon=null){
  const k = String(khoiNum||"");
  const cls = (lopCanon||"").toString().trim();
  const cache = ensureComputeMonsCache();
  const cacheKey = `${k}|${cls}`;
  if(cache.has(cacheKey)) return cloneMonsList(cache.get(cacheKey));

  const map = new Map(); // normTen -> {ten, sotiet, gioihan}

  // 1) Base: tiết chuẩn theo khối (nếu có)
  (DATA.mon||[])
    .filter(m => String(extractKhoiNumber(m?.khoi) || "") === k)
    .forEach(m=>{
      const ten = (m.ten||"").toString().trim();
      const sotiet = Number(m.sotiet||0);
      const gioihan = Number(m.gioihan||1);
      if(!ten) return;
      const key = normKey(ten);
      if(!map.has(key)){
        map.set(key, {
          ten,
          sotiet: Number.isFinite(sotiet) ? sotiet : 0,
          gioihan: Number.isFinite(gioihan) ? gioihan : 1
        });
      }
    });

  // 2) Merge/override: môn từ phân công của lớp
  if(cls){
    const subKeys = _collectPCCMSubjectKeysForClass(cls);

    subKeys.forEach(monKey=>{
      const ten = _monDisplayName(monKey);
      if(!ten) return;
      const key = normKey(ten);
      if(!map.has(key)) map.set(key, {ten, sotiet: 0, gioihan: 1});
      const entry = map.get(key);

      // lấy số tiết / giới hạn ưu tiên từ bảng phân công
      const t = getSoTietForClassMon(cls, ten) || getSoTietForClassMon(cls, monKey);
      const g = getGioiHanForClassMon(cls, ten) || getGioiHanForClassMon(cls, monKey);

      if(t > 0) entry.sotiet = t;
      if(g > 0) entry.gioihan = g;

      // fallback nếu chưa có số tiết trong phân công
      if(!(entry.sotiet > 0) && k){
        const tc = _findTietChuanRow(k, ten) || _findTietChuanRow(k, monKey);
        const tt = Number(tc?.sotiet || 0);
        const gg = Number(tc?.gioihan || 0);
        if(tt > 0) entry.sotiet = tt;
        if(gg > 0) entry.gioihan = gg;
      }
    });

    // 3) Override lần cuối cho các môn base: nếu phân công có giá trị thì lấy theo phân công
    map.forEach(entry=>{
      const ten = entry.ten;
      const t = getSoTietForClassMon(cls, ten);
      const g = getGioiHanForClassMon(cls, ten);
      if(t > 0) entry.sotiet = t;
      if(g > 0) entry.gioihan = g;
    });
  }

  let mons = [...map.values()]
    .map(m=>({
      ten: (m.ten||"").toString().trim(),
      sotiet: Number(m.sotiet||0),
      gioihan: Math.max(1, Number(m.gioihan||1))
    }))
    .filter(m => m.ten && Number.isFinite(m.sotiet) && m.sotiet > 0)
    .sort(compareMonByHiddenCode);

  // Theo yêu cầu: Chỉ hiện/xếp các môn đã được PHÂN CÔNG GIÁO VIÊN.
  // (Không có phân công => không đưa vào danh sách môn để tạo TKB)
  if(cls){
    mons = mons.filter(m=>{
      const gv = getTeacherForClassMon(cls, m.ten);
      return !!(gv && String(gv).trim());
    });
  }

  cache.set(cacheKey, cloneMonsList(mons));
  return cloneMonsList(mons);
}

function buildMonsForKhoi(khoiNum, lopCanon=null){
  const mons = computeMonsForClass(khoiNum, lopCanon);

  CURRENT_MONS = mons;
  CURRENT_MON_META = {};
  mons.forEach(m => CURRENT_MON_META[m.ten] = {sotiet: m.sotiet, gioihan: m.gioihan || 1});
  return mons;
}

function ensureClassTkbShape(classId){
  if(!classId) return false;
  if(!DATA.tkb || typeof DATA.tkb !== "object") DATA.tkb = {};
  let tkb = DATA.tkb[classId];
  let changed = false;
  if(!tkb || typeof tkb !== "object"){
    DATA.tkb[classId] = taoTKBTheoConfig([], DATA.tkbConfig);
    return true;
  }
  DAYS.forEach(day=>{
    if(!tkb[day] || typeof tkb[day] !== "object"){
      tkb[day] = {};
      changed = true;
    }
    ["sang","chieu"].forEach(buoi=>{
      const len = buoi === "sang" ? SANG : CHIEU;
      if(!Array.isArray(tkb[day][buoi])){
        tkb[day][buoi] = [];
        changed = true;
      }
      while(tkb[day][buoi].length < len){
        tkb[day][buoi].push("");
        changed = true;
      }
      if(tkb[day][buoi].length > len){
        tkb[day][buoi] = tkb[day][buoi].slice(0, len);
        changed = true;
      }
    });
  });
  return changed;
}

/* ======================= SELECT LỚP ======================= */
function selectLop(id){
  clearDragVisual();
  dragData = null;
  dragMon = "";
  try{ closeUnassignedDropdown(); }catch(_){ }
  currentLop = id;

  // reset chọn ô khi đổi lớp
  try{ clearCellSelection(); }catch(_){ }

  // active highlight ở danh sách lớp
  document.querySelectorAll("#listLop .lop-item").forEach(el=>{
    el.classList.toggle("active", (el.dataset.id||"") == id);
  });

  const lop = (DATA.lop||[]).find(x=>x.id==id);
  if(!lop) return;

  const lopKhoiNum = extractKhoiNumber(lop.khoi);
  const lopCanon = getLopCanonById(id);
  const mons = buildMonsForKhoi(lopKhoiNum, lopCanon);

  if(!DATA.tkb[id]){
    // Mặc định: KHÔNG tự động xếp vào TKB, chỉ tạo khung trống + cố định (nếu có)
    DATA.tkb[id] = taoTKBTheoConfig([], DATA.tkbConfig);
    saveStore();
  }else if(ensureClassTkbShape(id)){
    saveStore({force:true});
  }

  renderTKB(id);
  scheduleLoadMonList("selectLop");
}



/* [MOVED -> phanmon-ops.js] Section: auto_sort_all */

/* ======================= RENDER TKB ======================= */
function renderTKB(id){
  const box = document.getElementById("tkb");
  if(!box) return;
  box.classList.remove("tkb-pair-stack", "tkb-pair-lop-gv", "tkb-pair-gv-phong", "tkb-pair-lop-phong");

  const lop = (DATA.lop||[]).find(x=>x.id==id);
  if(ensureClassTkbShape(id)){
    try{ saveStore({force:true}); }catch(_){ }
  }
  const tkb = DATA.tkb[id];
  const lopCanon = getLopCanonById(id);
  const __t = document.getElementById("titleLop");
  if (__t) __t.innerText = "TKB lớp " + (classCanonFromLop(lop) || id);

  let h = "<table class='table'><tr>";
  DAYS.forEach(d => h += `<th>${LABEL[d]}</th>`);
  h += "</tr>";

  // 10 ô / ngày (5 ô đầu: sáng tiết 1-5, 5 ô sau: chiều tiết 1-5)
  const TOTAL = SANG + CHIEU;
  for(let row=0; row<TOTAL; row++){
    const isAfternoon = row >= SANG;
    const buoi = isAfternoon ? "chieu" : "sang";
    const ti = isAfternoon ? (row - SANG) : row;

    h += `<tr${row===SANG ? " class=\"split-row\"" : ""}>`;
    DAYS.forEach(d => {
      const v = isAfternoon ? tkb[d].chieu[ti] : tkb[d].sang[ti];
      h += cellHTML(v, d, buoi, ti, lopCanon);
    });
    h += "</tr>";
  }

  h += "</table>";
  box.innerHTML = h;

  bindCells();
}

/* ======================= CELL ======================= */
function cellHTML(v, thu, buoi, ti, lopCanon){
  const off = (v === "OFF");
  const fixed = isFixed(v);
  const mon = off ? "" : (fixed ? (v.mon||"") : (cellMon(v)||""));
  let teacher = "";
  let title = "";
  let body = "";
  if(!off){
    const monShort = getMonShort(mon);
    teacher = getTeacherForClassMon(lopCanon, mon);
    const teacherShort = getTeacherShort(teacher);
    const teacherFull = getTeacherNameByCode(teacher) || teacher;
    title = [mon, teacherFull].filter(Boolean).join(" - ");
    body =
      `<div class="tkb-cell-stack">`+
        mobileStackCellLineHTML(monShort, teacherShort, "tkb-class-line tkb-lesson-line")+
      `</div>`;
  }

  // note: data-mon để highlight conflict
  return `<td class="${off?'tkb-off':''} ${fixed?'tkb-fixed':''}"
    data-thu="${thu}" data-buoi="${buoi}" data-ti="${ti}" data-mon="${escapeHtml(mon)}" data-teacher="${escapeHtml(teacher)}"
    title="${escapeHtml(title)}"
    draggable="${off?'false':'true'}">${body}</td>`;
}

function escapeHtml(str){
  return (str ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

/* ======================= CELL SELECT + MENU (NGHỈ) ======================= */
function cellKey(thu, buoi, ti, scope="", classId=""){
  if(scope || classId) return `${scope||""}|${classId||""}|${thu}|${buoi}|${ti}`;
  return `${thu}|${buoi}|${ti}`;
}
function parseCellKey(key){
  const parts = (key||"").split("|");
  if(parts.length >= 5){
    const [scope, classId, thu, buoi, ti] = parts;
    return {scope, classId, thu, buoi, ti: Number(ti)};
  }
  const [thu, buoi, ti] = parts;
  return {scope:"", classId:"", thu, buoi, ti: Number(ti)};
}
function cellScopeForTd(td){
  if((td?.dataset?.pairSlot || "") === "teacher") return "teacher";
  if(VIEW_MODE === "gv") return "teacher";
  const table = td?.closest?.("table");
  if(table?.classList?.contains("tkb-main-table")) return "main";
  if(table?.classList?.contains("tkb-support-table")) return "support";
  return "single";
}
function cellClassIdForTd(td){
  const scope = cellScopeForTd(td);
  if(scope === "teacher"){
    const teacherDirect = (td?.dataset?.teacher || "").toString().trim();
    if(teacherDirect) return teacherDirect;
    return (currentGV || "").toString();
  }
  const direct = (td?.dataset?.classid || "").toString().trim();
  if(direct) return direct;
  const ids = (td?.dataset?.classids || "").split(",").map(s=>s.trim()).filter(Boolean);
  if(ids.length === 1) return ids[0];
  if(scope === "support") return "";
  if(VIEW_MODE === "lop" || VIEW_MODE === "phong") return (currentLop || "").toString();
  return "";
}
function cellKeyForTd(td){
  return cellKey(
    td?.dataset?.thu,
    td?.dataset?.buoi,
    td?.dataset?.ti,
    cellScopeForTd(td),
    cellClassIdForTd(td)
  );
}
function findTdByCellKey(key){
  let found = null;
  document.querySelectorAll("#tkb td[data-thu][data-buoi][data-ti]").forEach(td=>{
    if(!found && cellKeyForTd(td) === key) found = td;
  });
  return found;
}
function tdToPos(td){
  const thu = td?.dataset?.thu;
  const buoi = td?.dataset?.buoi;
  const ti = Number(td?.dataset?.ti);
  const col = DAYS.indexOf(thu);
  const row = (buoi === "chieu") ? (SANG + ti) : ti;
  return {thu, buoi, ti, row, col};
}
function posToKey(pos){
  return cellKey(pos.thu, pos.buoi, pos.ti, pos.scope || "", pos.classId || "");
}
function clearCellSelection(){
  TKB_CELL_SELECTION.clear();
  TKB_CELL_ANCHOR = null;
  TKB_CELL_ACTIVE = null;
  applyCellSelectionStyles();
}
function applyCellSelectionStyles(){
  document.querySelectorAll("#tkb td").forEach(td=>{
    if(!td.dataset.thu || !td.dataset.buoi || td.dataset.ti == null){
      td.classList.remove("tkb-selected");
      return;
    }
    const k = cellKeyForTd(td);
    td.classList.toggle("tkb-selected", TKB_CELL_SELECTION.has(k));
  });
}
function selectSingleCell(td){
  const pos = tdToPos(td);
  pos.scope = cellScopeForTd(td);
  pos.classId = cellClassIdForTd(td);
  const key = posToKey(pos);
  TKB_CELL_SELECTION = new Set([key]);
  TKB_CELL_ANCHOR = key;
  TKB_CELL_ACTIVE = key;
  applyCellSelectionStyles();
}
function toggleCellInSelection(td){
  const pos = tdToPos(td);
  pos.scope = cellScopeForTd(td);
  pos.classId = cellClassIdForTd(td);
  const key = posToKey(pos);
  if(TKB_CELL_SELECTION.has(key)) TKB_CELL_SELECTION.delete(key);
  else TKB_CELL_SELECTION.add(key);
  if(!TKB_CELL_ANCHOR) TKB_CELL_ANCHOR = key;
  TKB_CELL_ACTIVE = key;
  applyCellSelectionStyles();
}
function selectRange(anchorKey, toTd){
  if(!anchorKey) return selectSingleCell(toTd);
  const anchorTd = findTdByCellKey(anchorKey);
  if(!anchorTd) return selectSingleCell(toTd);
  const p1 = tdToPos(anchorTd);
  const p2 = tdToPos(toTd);
  const scope = cellScopeForTd(anchorTd);
  const table = anchorTd.closest("table");
  if(table && table !== toTd.closest("table")){
    return selectSingleCell(toTd);
  }

  const r1 = Math.min(p1.row, p2.row);
  const r2 = Math.max(p1.row, p2.row);
  const c1 = Math.min(p1.col, p2.col);
  const c2 = Math.max(p1.col, p2.col);

  const set = new Set();
  (table || document).querySelectorAll("td[data-thu][data-buoi][data-ti]").forEach(td=>{
    if(cellScopeForTd(td) !== scope) return;
    const p = tdToPos(td);
    if(p.row >= r1 && p.row <= r2 && p.col >= c1 && p.col <= c2){
      p.scope = cellScopeForTd(td);
      p.classId = cellClassIdForTd(td);
      set.add(posToKey(p));
    }
  });
  TKB_CELL_SELECTION = set;
  const activePos = tdToPos(toTd);
  activePos.scope = cellScopeForTd(toTd);
  activePos.classId = cellClassIdForTd(toTd);
  TKB_CELL_ACTIVE = posToKey(activePos);
  applyCellSelectionStyles();
}

function ensureCellMenu(){
  if(__CELL_MENU) return __CELL_MENU;
  const d = document.createElement("div");
  d.id = "tkbCellMenu";
  d.className = "tkb-cell-action-menu";
  d.setAttribute("role", "menu");
  d.setAttribute("aria-label", "Thao tác tiết học");
  d.hidden = true;
  d.innerHTML = `
    <button type="button" class="tkb-cell-action" data-cell-action="fixed" role="menuitem">Cố định</button>
    <button type="button" class="tkb-cell-action" data-cell-action="off" role="menuitem">Nghỉ</button>
    <button type="button" class="tkb-cell-action is-danger" data-cell-action="delete" role="menuitem">Xóa</button>
  `;
  document.body.appendChild(d);

  d.addEventListener("click", (ev)=>{
    const btn = ev.target?.closest?.("[data-cell-action]");
    if(!btn || !d.contains(btn)) return;
    try{ ev.preventDefault(); ev.stopPropagation(); }catch(_){ }
    const action = (btn.dataset.cellAction || "").toString();
    const td = __CELL_MENU_TD;
    const cellKeyValue = __CELL_MENU_KEY || cellKeyForTd(td);
    const fixedKey = fixedLessonKeyForTd(td);
    if(action === "fixed"){
      hideCellMenu();
      if(fixedKey) toggleFixedByKey(fixedKey);
      return;
    }
    if(action === "off"){
      const isOff = getCellValueByKeyForCurrentLop(cellKeyValue) === "OFF";
      hideCellMenu();
      if(cellKeyValue) setOffByKey(cellKeyValue, !isOff);
      return;
    }
    if(action === "delete"){
      if(td) selectSingleCell(td);
      hideCellMenu();
      deleteSelectedCells();
    }
  });

  // Chạm ngoài menu, cuộn hoặc xoay màn hình thì đóng.
  document.addEventListener("pointerdown", (ev)=>{
    if(d.hidden) return;
    if(d.contains(ev.target)) return;
    hideCellMenu();
  }, true);
  document.addEventListener("keydown", (ev)=>{
    if(ev.key === "Escape") hideCellMenu();
  }, true);
  window.addEventListener("resize", hideCellMenu, {passive:true});
  window.addEventListener("scroll", hideCellMenu, {passive:true, capture:true});

  __CELL_MENU = d;
  return d;
}

function showCellMenuForTd(td, clientX, clientY){
  const key = cellKeyForTd(td);
  if(!key) return false;
  __CELL_MENU_KEY = key;
  __CELL_MENU_TD = td;
  const d = ensureCellMenu();
  const fixedKey = fixedLessonKeyForTd(td);
  const isOff = getCellValueByKeyForCurrentLop(key) === "OFF";
  const fixedBtn = d.querySelector('[data-cell-action="fixed"]');
  if(fixedBtn) fixedBtn.textContent = td.classList.contains("tkb-fixed") ? "Bỏ cố định" : "Cố định";
  if(fixedBtn) fixedBtn.disabled = !fixedKey || isOff;
  const offBtn = d.querySelector('[data-cell-action="off"]');
  if(offBtn) offBtn.textContent = isOff ? "Bỏ nghỉ" : "Nghỉ";
  d.hidden = false;

  // Đặt sát ô nhưng luôn nằm trọn trong vùng nhìn thấy.
  const pad = 8;
  const rect = td.getBoundingClientRect();
  const anchorX = Number.isFinite(Number(clientX)) && Number(clientX) > 0
    ? Number(clientX)
    : rect.left + rect.width / 2;
  const w = d.offsetWidth || 310;
  const h = d.offsetHeight || 52;
  let left = Math.min(window.innerWidth - w - pad, Math.max(pad, anchorX - w / 2));
  let top = rect.bottom + 6;
  if(top + h > window.innerHeight - pad) top = rect.top - h - 6;
  top = Math.min(window.innerHeight - h - pad, Math.max(pad, top));
  d.style.left = `${left}px`;
  d.style.top = `${top}px`;
  try{ fixedBtn?.focus({preventScroll:true}); }catch(_){ }
  return true;
}

function hideCellMenu(){
  if(__CELL_MENU){
    __CELL_MENU.hidden = true;
  }
  __CELL_MENU_KEY = null;
  __CELL_MENU_TD = null;
}

function _cancelCellLongPress(){
  if(__CELL_LONGPRESS_TIMER){
    clearTimeout(__CELL_LONGPRESS_TIMER);
    __CELL_LONGPRESS_TIMER = null;
  }
}

function _startCellLongPress(td, clientX, clientY){
  _cancelCellLongPress();
  __CELL_LONGPRESS_FIRED = false;
}

function usesCoarseCellActions(){
  try{
    if(window.matchMedia?.("(any-pointer: coarse)")?.matches) return true;
  }catch(_){ }
  return Number(navigator?.maxTouchPoints || 0) > 0;
}

function touchPointForCellAction(e){
  const touch = e?.changedTouches?.[0] || e?.touches?.[0] || null;
  return {
    x: Number(touch?.clientX ?? e?.clientX ?? 0),
    y: Number(touch?.clientY ?? e?.clientY ?? 0)
  };
}

function bindTouchDoubleAction(td){
  if(!td || td.__tkbTouchDoubleBound) return;
  td.__tkbTouchDoubleBound = true;
  const state = {active:false, startedAt:0, startX:0, startY:0, moved:false};

  const begin = (e)=>{
    if(e?.pointerType === "mouse") return;
    const p = touchPointForCellAction(e);
    state.active = true;
    state.startedAt = Date.now();
    state.startX = p.x;
    state.startY = p.y;
    state.moved = false;
  };
  const move = (e)=>{
    if(!state.active) return;
    const p = touchPointForCellAction(e);
    if(Math.hypot(p.x - state.startX, p.y - state.startY) > 12) state.moved = true;
  };
  const cancel = ()=>{
    state.active = false;
    state.moved = false;
    __CELL_LAST_TOUCH_TAP = null;
  };
  const end = (e)=>{
    if(!state.active) return;
    state.active = false;
    const p = touchPointForCellAction(e);
    const now = Date.now();
    const heldMs = now - state.startedAt;
    if(state.moved || heldMs > 320){
      __CELL_LAST_TOUCH_TAP = null;
      return;
    }
    // Touch menus also apply to empty/OFF cells so the user can reserve a
    // break directly from the timetable.
    const key = cellKeyForTd(td);
    if(!key){
      __CELL_LAST_TOUCH_TAP = null;
      return;
    }
    const previous = __CELL_LAST_TOUCH_TAP;
    const isDouble = !!previous
      && previous.key === key
      && now - previous.at <= 380
      && Math.hypot(p.x - previous.x, p.y - previous.y) <= 28;
    if(!isDouble){
      __CELL_LAST_TOUCH_TAP = {key, at:now, x:p.x, y:p.y};
      return;
    }

    __CELL_LAST_TOUCH_TAP = null;
    td.__tkbTouchDoubleHandled = true;
    try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
    handleCellDoubleAction(td, e);
  };

  if(window.PointerEvent){
    td.addEventListener("pointerdown", begin, {passive:true});
    td.addEventListener("pointermove", move, {passive:true});
    td.addEventListener("pointerup", end, {passive:false});
    td.addEventListener("pointercancel", cancel, {passive:true});
  }else{
    td.addEventListener("touchstart", begin, {passive:true});
    td.addEventListener("touchmove", move, {passive:true});
    td.addEventListener("touchend", end, {passive:false});
    td.addEventListener("touchcancel", cancel, {passive:true});
  }
}

function handleCellDoubleAction(td, e){
  try{ e?.preventDefault(); e?.stopPropagation(); }catch(_){ }
  if(usesCoarseCellActions()){
    const key = cellKeyForTd(td);
    if(!key) return false;
    selectSingleCell(td);
    return showCellMenuForTd(td, e?.clientX, e?.clientY);
  }
  const key = fixedLessonKeyForTd(td);
  if(!key) return false;
  toggleFixedByKey(key);
  return true;
}

function setOffByKey(key, isOff, opts){
  return setOffByKeys([key], isOff, opts);
}

function userOffLockKey(thu, buoi, ti){
  return `${thu}|${buoi}|${Number(ti)}`;
}

function parseUserOffLockKey(key){
  const [thu, buoi, ti] = String(key || "").split("|");
  return {thu, buoi, ti: Number(ti)};
}

function ensureClassFixedOffConstraints(){
  if(!DATA.tkbConstraints || typeof DATA.tkbConstraints !== "object") DATA.tkbConstraints = {};
  const c = DATA.tkbConstraints;
  if(!c.fixedOff || typeof c.fixedOff !== "object") c.fixedOff = {};
  ["class","teacher","subject","room","subjectGroup"].forEach(type=>{
    if(!c.fixedOff[type] || typeof c.fixedOff[type] !== "object") c.fixedOff[type] = {};
  });
  return c.fixedOff.class;
}

function ensureTeacherFixedOffConstraints(){
  ensureClassFixedOffConstraints();
  return DATA.tkbConstraints.fixedOff.teacher;
}

function syncClassFixedOffConstraint(classId, thu, buoi, ti, isOff){
  const id = String(classId || "");
  if(!id || !DAYS.includes(thu)) return false;
  if(buoi !== "sang" && buoi !== "chieu") return false;
  const max = buoi === "sang" ? SANG : CHIEU;
  if(!Number.isFinite(Number(ti)) || Number(ti) < 0 || Number(ti) >= max) return false;
  const fixedClass = ensureClassFixedOffConstraints();
  const key = userOffLockKey(thu, buoi, ti);
  fixedClass[id] = fixedClass[id] || {};
  const before = !!fixedClass[id][key];
  if(isOff) fixedClass[id][key] = true;
  else delete fixedClass[id][key];
  if(Object.keys(fixedClass[id] || {}).length === 0) delete fixedClass[id];
  return before !== !!isOff;
}

function syncTeacherFixedOffConstraint(gvCode, thu, buoi, ti, isOff){
  const id = String(gvCode || "").trim();
  if(!id || !DAYS.includes(thu)) return false;
  if(buoi !== "sang" && buoi !== "chieu") return false;
  const max = buoi === "sang" ? SANG : CHIEU;
  if(!Number.isFinite(Number(ti)) || Number(ti) < 0 || Number(ti) >= max) return false;
  const fixedTeacher = ensureTeacherFixedOffConstraints();
  const key = userOffLockKey(thu, buoi, ti);
  fixedTeacher[id] = fixedTeacher[id] || {};
  const before = !!fixedTeacher[id][key];
  if(isOff) fixedTeacher[id][key] = true;
  else delete fixedTeacher[id][key];
  if(Object.keys(fixedTeacher[id] || {}).length === 0) delete fixedTeacher[id];
  return before !== !!isOff;
}

function isTeacherFixedOff(gvCode, thu, buoi, ti){
  const id = String(gvCode || "").trim();
  if(!id) return false;
  const key = userOffLockKey(thu, buoi, ti);
  return !!DATA.tkbConstraints?.fixedOff?.teacher?.[id]?.[key];
}

function clearTeacherLessonsAtSlot(gvCode, thu, buoi, ti){
  const gvCodeNorm = String(gvCode || "").trim();
  if(!gvCodeNorm || !DAYS.includes(thu) || (buoi !== "sang" && buoi !== "chieu")) return false;
  const idx = Number(ti);
  if(!Number.isFinite(idx)) return false;
  let changed = false;
  for(const classId of Object.keys(DATA.tkb || {})){
    const tkb = DATA.tkb?.[classId];
    const arr = tkb?.[thu]?.[buoi];
    if(!arr || idx < 0 || idx >= arr.length) continue;
    const cur = arr[idx];
    if(!cur || cur === "OFF") continue;
    const mon = cellMon(cur);
    if(!mon) continue;
    const gv = getTeacherForClassMon(getLopCanonById(classId), mon);
    if(!teacherValueHas(gv, gvCodeNorm)) continue;
    arr[idx] = "";
    changed = true;
  }
  return changed;
}

function normalizeUserOffList(classId){
  const id = String(classId || "");
  if(!id) return [];
  const raw = DATA.tkbUserOff?.[id];
  const values = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" ? Object.keys(raw).filter(k => raw[k]) : []);
  const set = new Set();
  for(const item of values){
    let thu, buoi, ti;
    if(typeof item === "string"){
      ({thu, buoi, ti} = parseUserOffLockKey(item));
    }else if(item && typeof item === "object"){
      thu = item.thu;
      buoi = item.buoi;
      ti = Number(item.ti);
    }
    if(!DAYS.includes(thu)) continue;
    if(buoi !== "sang" && buoi !== "chieu") continue;
    const max = buoi === "sang" ? SANG : CHIEU;
    if(!Number.isFinite(ti) || ti < 0 || ti >= max) continue;
    set.add(userOffLockKey(thu, buoi, ti));
  }
  const out = Array.from(set);
  DATA.tkbUserOff[id] = out;
  return out;
}

function addUserOffLock(classId, thu, buoi, ti){
  const id = String(classId || "");
  if(!id) return false;
  const list = normalizeUserOffList(id);
  const key = userOffLockKey(thu, buoi, ti);
  const before = list.includes(key);
  if(!before) list.push(key);
  DATA.tkbUserOff[id] = list;
  const constraintChanged = syncClassFixedOffConstraint(id, thu, buoi, ti, true);
  return !before || constraintChanged;
}

function removeUserOffLock(classId, thu, buoi, ti){
  const id = String(classId || "");
  if(!id) return false;
  const key = userOffLockKey(thu, buoi, ti);
  const before = normalizeUserOffList(id).includes(key);
  DATA.tkbUserOff[id] = normalizeUserOffList(id).filter(x => x !== key);
  const constraintChanged = syncClassFixedOffConstraint(id, thu, buoi, ti, false);
  return before || constraintChanged;
}

function cloneTkbCellValue(value){
  if(value && typeof value === "object"){
    try{ return JSON.parse(JSON.stringify(value)); }catch(_){ return Object.assign({}, value); }
  }
  return value;
}

function ensureOffRestoreStore(){
  if(!DATA.tkbOffRestore || typeof DATA.tkbOffRestore !== "object") DATA.tkbOffRestore = {};
  return DATA.tkbOffRestore;
}

function clearOffDisplacedLesson(classId, thu, buoi, ti){
  const id = String(classId || "");
  if(!id || !DATA.tkbOffRestore || typeof DATA.tkbOffRestore !== "object") return false;
  const slotKey = userOffLockKey(thu, buoi, ti);
  if(!DATA.tkbOffRestore[id] || !DATA.tkbOffRestore[id][slotKey]) return false;
  delete DATA.tkbOffRestore[id][slotKey];
  if(Object.keys(DATA.tkbOffRestore[id] || {}).length === 0) delete DATA.tkbOffRestore[id];
  return true;
}

function rememberOffDisplacedLesson(classId, thu, buoi, ti, value){
  const id = String(classId || "");
  const mon = cellMon(value);
  if(!id || !mon || value === "OFF") return clearOffDisplacedLesson(classId, thu, buoi, ti);
  const slotKey = userOffLockKey(thu, buoi, ti);
  const store = ensureOffRestoreStore();
  const lopCanon = getLopCanonById(id) || id;
  store[id] = store[id] || {};
  store[id][slotKey] = {
    value: cloneTkbCellValue(value),
    mon,
    fixed: !!isFixed(value),
    teacher: getTeacherForClassMon(lopCanon, mon),
    room: getRoomForClassMon(lopCanon, mon),
    savedAt: Date.now()
  };
  DATA.tkbOffRestoreLast = {
    at: Date.now(),
    classId: id,
    slotKey,
    action: "remember",
    restored: 0
  };
  return true;
}

function offRestoreTeacherConflict(entry, classId, thu, buoi, ti){
  const teacher = entry?.teacher || getTeacherForClassMon(getLopCanonById(classId) || classId, entry?.mon || "");
  const wanted = teacherListFromValue(teacher);
  if(!wanted.length) return false;
  for(const otherClassId of Object.keys(DATA.tkb || {})){
    if(String(otherClassId) === String(classId)) continue;
    const cell = DATA.tkb?.[otherClassId]?.[thu]?.[buoi]?.[ti];
    if(!cell || cell === "OFF") continue;
    const mon = cellMon(cell);
    if(!mon) continue;
    const otherTeacher = getTeacherForClassMon(getLopCanonById(otherClassId) || otherClassId, mon);
    if(wanted.some(code => teacherValueHas(otherTeacher, code))) return true;
  }
  return false;
}

function offRestoreRoomConflict(entry, classId, thu, buoi, ti){
  const room = String(entry?.room || "").trim();
  if(!room) return false;
  for(const otherClassId of Object.keys(DATA.tkb || {})){
    if(String(otherClassId) === String(classId)) continue;
    const cell = DATA.tkb?.[otherClassId]?.[thu]?.[buoi]?.[ti];
    if(!cell || cell === "OFF") continue;
    const mon = cellMon(cell);
    if(!mon) continue;
    const otherRoom = String(getRoomForClassMon(getLopCanonById(otherClassId) || otherClassId, mon) || "").trim();
    if(otherRoom && otherRoom === room) return true;
  }
  return false;
}

function restoreOffDisplacedLesson(classId, thu, buoi, ti, options={}){
  const id = String(classId || "");
  const slotKey = userOffLockKey(thu, buoi, ti);
  const entry = DATA.tkbOffRestore?.[id]?.[slotKey];
  if(!id || !entry) return null;
  const tkb = DATA.tkb?.[id];
  if(!tkb?.[thu]?.[buoi]) return null;
  const cur = tkb[thu][buoi][ti];
  if(cur && cur !== "OFF" && cellMon(cur)) return null;
  if(offRestoreTeacherConflict(entry, id, thu, buoi, ti)){
    return {restored:false, reason:"teacher_conflict", classId:id, thu, buoi, ti, mon:entry.mon};
  }
  if(offRestoreRoomConflict(entry, id, thu, buoi, ti)){
    return {restored:false, reason:"room_conflict", classId:id, thu, buoi, ti, mon:entry.mon};
  }
  const restoredValue = entry.value != null && cellMon(entry.value)
    ? cloneTkbCellValue(entry.value)
    : (entry.fixed ? {mon: entry.mon, fixed: true} : entry.mon);
  tkb[thu][buoi][ti] = restoredValue;
  clearOffDisplacedLesson(id, thu, buoi, ti);
  DATA.tkbOffRestoreLast = {
    at: Date.now(),
    classId: id,
    slotKey,
    action: options.reason || "restore",
    restored: 1,
    mon: entry.mon
  };
  return {restored:true, classId:id, thu, buoi, ti, mon:entry.mon};
}

function restorePendingOffDisplacedLessons(options={}){
  const maxRestore = Math.max(1, Math.round(Number(options.maxRestore || 12) || 12));
  const details = [];
  let restored = 0;
  const store = DATA.tkbOffRestore && typeof DATA.tkbOffRestore === "object" ? DATA.tkbOffRestore : {};
  for(const classId of Object.keys(store)){
    if(restored >= maxRestore) break;
    for(const slotKey of Object.keys(store[classId] || {})){
      if(restored >= maxRestore) break;
      const pos = parseUserOffLockKey(slotKey);
      if(!pos.thu || !pos.buoi || !Number.isFinite(pos.ti)) continue;
      const offLocked = normalizeUserOffList(classId).includes(slotKey);
      if(offLocked && options.includeLocked !== true) continue;
      const result = restoreOffDisplacedLesson(classId, pos.thu, pos.buoi, pos.ti, {reason: options.reason || "pending_restore"});
      if(result?.restored){
        restored++;
        details.push(result);
      }else if(result){
        details.push(result);
      }
    }
  }
  if(restored > 0){
    DATA.tkbOffRestoreLast = {
      at: Date.now(),
      action: options.reason || "pending_restore",
      restored,
      details
    };
    try{ saveStore({force:true}); }catch(e){ console.error("saveStore failed", e); }
    if(options.render !== false){
      try{ renderCurrentView(); }catch(e){ console.error("renderCurrentView failed", e); }
      try{ loadMonList(); }catch(e){ console.error("loadMonList failed", e); }
      try{ renderStatsBox(); }catch(_){ }
      try{ applyCellSelectionStyles(); }catch(_){ }
    }
  }
  return {restored, details};
}

function getUserOffPositionsForClass(classId){
  return normalizeUserOffList(classId).map(parseUserOffLockKey);
}

function syncUserOffLocksFromTkb(classId){
  // OFF cells in the rendered timetable are output state, not rules.
  // Only explicit user locks in DATA.tkbUserOff / fixedOff.class are authoritative.
  return !!classId && false;
}

function syncAllUserOffLocksFromTkb(){
  let changed = false;
  for(const id of Object.keys(DATA.tkb || {})) changed = syncUserOffLocksFromTkb(id) || changed;
  return changed;
}

function collectOffPositionsForClass(classId){
  const map = new Map();
  for(const o of getUserOffPositionsForClass(classId)){
    map.set(userOffLockKey(o.thu, o.buoi, o.ti), o);
  }
  return Array.from(map.values());
}

function applyOffPositionsToTkb(tkb, positions){
  for(const o of (positions || [])){
    if(tkb?.[o.thu]?.[o.buoi] && Number.isFinite(Number(o.ti))){
      tkb[o.thu][o.buoi][Number(o.ti)] = "OFF";
    }
  }
  return tkb;
}

function collectFixedLessonsForClass(classId){
  const out = [];
  const tkb = DATA.tkb?.[classId];
  if(!tkb) return out;
  for(const thu of DAYS){
    for(const buoi of ["sang","chieu"]){
      (tkb?.[thu]?.[buoi] || []).forEach((value, ti)=>{
        if(!isFixed(value)) return;
        const mon = cellMon(value);
        if(!mon) return;
        out.push({thu, buoi, ti, mon});
      });
    }
  }
  return out;
}

function applyFixedLessonsToTkb(tkb, lessons){
  for(const item of (lessons || [])){
    if(tkb?.[item.thu]?.[item.buoi] && Number.isFinite(Number(item.ti))){
      tkb[item.thu][item.buoi][Number(item.ti)] = {mon: item.mon, fixed: true};
    }
  }
  return tkb;
}

function makeEmptyTKBPreservingOff(classId, cfg){
  const offPositions = collectOffPositionsForClass(classId);
  const fixedLessons = collectFixedLessonsForClass(classId);
  const tkb = applyFixedLessonsToTkb(taoTKBTheoConfig([], cfg), fixedLessons);
  return applyOffPositionsToTkb(tkb, offPositions);
}

function tkbPartialMetricNumber(value, fallback=0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function detectStoredPartialSolverSchedule(){
  const result = DATA?.tkbSolverResult;
  if(!result || typeof result !== "object") return null;
  if(result.version === "invalidated-partial") return null;

  const metrics = result.metrics || result.payload?.metrics || {};
  const validation = result.validation || result.payload?.validation || {};
  const scheduledMetric = tkbPartialMetricNumber(metrics.scheduled_periods, -1);
  const expectedMetric = tkbPartialMetricNumber(metrics.expected_periods, 0);
  const unassignedMetric = tkbPartialMetricNumber(metrics.unassigned_periods, 0);
  const violationsMetric = tkbPartialMetricNumber(metrics.app_constraint_violation_count, 0);
  const bestEffort = result.bestEffort === true
    || result.best_effort === true
    || metrics.best_effort === true
    || result.payload?.bestEffort === true;
  const hardOk = metrics.hard_ok !== false
    && metrics.core_hard_ok !== false
    && validation.hard_ok !== false;
  const incompleteMetric = expectedMetric > 0 && scheduledMetric >= 0 && scheduledMetric < expectedMetric;
  const hasBadSolverSignal = bestEffort
    || unassignedMetric > 0
    || incompleteMetric
    || violationsMetric > 0
    || !hardOk;
  if(!hasBadSolverSignal) return null;

  const stats = calcSchoolTKBStats();
  const scheduledNow = tkbPartialMetricNumber(stats.daXepTiet, 0);
  const expectedNow = tkbPartialMetricNumber(stats.soTiet, expectedMetric);
  const missingNow = tkbPartialMetricNumber(stats.chuaXepTiet, 0);
  const hasPartialScheduleNow = expectedNow > 0 && scheduledNow > 0 && missingNow > 0;
  const hasEmptyScheduleNow = expectedNow > 0 && scheduledNow === 0 && missingNow > 0;
  if(!hasPartialScheduleNow && !hasEmptyScheduleNow) return null;

  const reportedExpected = expectedMetric > 0 ? expectedMetric : expectedNow;
  const reportedScheduled = (scheduledMetric >= 0 && expectedMetric > 0) ? scheduledMetric : scheduledNow;
  const reportedMissing = Math.max(unassignedMetric, missingNow);

  return {
    stats,
    metrics,
    validation,
    scheduled: reportedScheduled,
    expected: reportedExpected,
    missing: reportedMissing,
    scheduledNow,
    expectedNow,
    missingNow,
    scheduledMetric,
    expectedMetric,
    unassignedMetric,
    bestEffort,
    hardOk,
    incompleteMetric,
    hasPartialScheduleNow
  };
}

function migrateInvalidPartialSchedule(){
  return false;
}

function reapplyAllUserOffLocks(){
  for(const id of Object.keys(DATA.tkb || {})){
    const tkb = DATA.tkb?.[id];
    if(tkb) applyOffPositionsToTkb(tkb, getUserOffPositionsForClass(id));
  }
}

try{
  window.__tkbCollectOffPositionsForClass = collectOffPositionsForClass;
  window.__tkbApplyOffPositionsToTkb = applyOffPositionsToTkb;
  window.__tkbMakeEmptyTKBPreservingOff = makeEmptyTKBPreservingOff;
  window.__tkbDetectStoredPartialSolverSchedule = detectStoredPartialSolverSchedule;
  window.__tkbMigrateInvalidPartialSchedule = migrateInvalidPartialSchedule;
  window.__tkbReapplyAllUserOffLocks = reapplyAllUserOffLocks;
  window.__tkbSyncAllUserOffLocksFromTkb = syncAllUserOffLocksFromTkb;
  window.__tkbRestorePendingOffDisplacedLessons = restorePendingOffDisplacedLessons;
}catch(_){}

function setOffByKeys(keys, isOff, opts){
  const options = opts || {};
  let changed = false;

  for(const key of (keys||[])){
    const {scope, classId, thu, buoi, ti} = parseCellKey(key);
    if(scope === "teacher"){
      const targetGV = (classId || currentGV || "").toString().trim();
      if(!targetGV || !thu || !buoi || !Number.isFinite(ti)) continue;
      changed = syncTeacherFixedOffConstraint(targetGV, thu, buoi, ti, !!isOff) || changed;
      if(isOff) changed = clearTeacherLessonsAtSlot(targetGV, thu, buoi, ti) || changed;
      continue;
    }
    const targetLop = (classId || currentLop || "").toString();
    if(!targetLop) continue;
    const tkb = DATA.tkb?.[targetLop];
    if(!tkb) continue;
    if(!thu || !buoi || !Number.isFinite(ti)) continue;
    if(!tkb?.[thu]?.[buoi]) continue;

    const cur = tkb[thu][buoi][ti];
    if(isOff){
      // nếu đang cố định thì hỏi bỏ cố định (trừ khi batch đã xác nhận)
      if(isFixed(cur) && !options.skipConfirm){
        const ok = confirm("Tiết này đang CỐ ĐỊNH. Bỏ cố định và đặt NGHỈ?");
        if(!ok) return;
      }
      changed = addUserOffLock(targetLop, thu, buoi, ti) || changed;
      if(cur !== "OFF"){
        if(cellMon(cur)) rememberOffDisplacedLesson(targetLop, thu, buoi, ti, cur);
        else clearOffDisplacedLesson(targetLop, thu, buoi, ti);
        tkb[thu][buoi][ti] = "OFF";
        changed = true;
      }
    } else {
      changed = removeUserOffLock(targetLop, thu, buoi, ti) || changed;
      if(cur === "OFF"){
        const restored = restoreOffDisplacedLesson(targetLop, thu, buoi, ti, {reason:"clear_off"});
        if(!restored?.restored) tkb[thu][buoi][ti] = "";
        changed = true;
      }
    }
  }

  if(!changed) return;
  try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
  applyCellSelectionStyles();
}

function toggleFixedByKey(key){
  const {classId, thu, buoi, ti} = parseCellKey(key);
  const targetLop = (classId || currentLop || "").toString();
  if(!targetLop) return;
  if(!thu || !buoi || !Number.isFinite(ti)) return;
  const tkb = DATA.tkb?.[targetLop];
  if(!tkb || !tkb?.[thu]?.[buoi]) return;
  const cur = tkb[thu][buoi][ti];
  if(cur === "OFF") return;
  const mon = cellMon(cur);
  if(!mon) return;

  if(isFixed(cur)) tkb[thu][buoi][ti] = mon;
  else tkb[thu][buoi][ti] = {mon, fixed: true};

  try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
  applyCellSelectionStyles();
}

function clearLessonByKey(key){
  const {classId, thu, buoi, ti} = parseCellKey(key);
  const targetLop = (classId || currentLop || "").toString();
  if(!targetLop || !thu || !buoi || !Number.isFinite(ti)) return false;
  const tkb = DATA.tkb?.[targetLop];
  if(!tkb?.[thu]?.[buoi]) return false;
  const cur = tkb[thu][buoi][ti];
  if(!cur || cur === "OFF") return false;
  const mon = cellMon(cur);
  if(!mon) return false;

  tkb[thu][buoi][ti] = "";
  try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
  try{ _setStatus("Đã đưa tiết về Chưa phân.", "ok"); }catch(_){ }
  applyCellSelectionStyles();
  return true;
}

function getCellValueByKeyForCurrentLop(key){
  const {scope, classId, thu, buoi, ti} = parseCellKey(key);
  if(scope === "teacher"){
    const targetGV = (classId || currentGV || "").toString().trim();
    if(!targetGV || !thu || !buoi || !Number.isFinite(ti)) return null;
    return isTeacherFixedOff(targetGV, thu, buoi, ti) ? "OFF" : "";
  }
  const targetLop = (classId || currentLop || "").toString();
  if(!targetLop) return null;
  const tkb = DATA.tkb?.[targetLop];
  if(!tkb) return null;
  if(!thu || !buoi || !Number.isFinite(ti)) return null;
  if(!tkb?.[thu]?.[buoi]) return null;
  return tkb[thu][buoi][ti];
}

function cellPosFromKey(key){
  const p = parseCellKey(key);
  const col = DAYS.indexOf(p.thu);
  const row = (p.buoi === "chieu") ? (SANG + Number(p.ti)) : Number(p.ti);
  return {...p, row, col};
}

function keyFromCellPos(base, row, col){
  if(!Number.isFinite(row) || !Number.isFinite(col)) return "";
  if(row < 0 || row >= (SANG + CHIEU)) return "";
  if(col < 0 || col >= DAYS.length) return "";
  const thu = DAYS[col];
  const buoi = row >= SANG ? "chieu" : "sang";
  const ti = row >= SANG ? (row - SANG) : row;
  return cellKey(thu, buoi, ti, base.scope || "", base.classId || "");
}

function selectedKeysForClipboard(){
  return TKB_CELL_SELECTION.size ? [...TKB_CELL_SELECTION] : (TKB_CELL_ACTIVE ? [TKB_CELL_ACTIVE] : []);
}

function topLeftKeyFromKeys(keys){
  let best = "";
  let bestPos = null;
  for(const key of (keys || [])){
    const p = cellPosFromKey(key);
    if(!Number.isFinite(p.row) || !Number.isFinite(p.col)) continue;
    if(!bestPos || p.row < bestPos.row || (p.row === bestPos.row && p.col < bestPos.col)){
      best = key;
      bestPos = p;
    }
  }
  return best;
}

function buildOffPatternFromKeys(keys){
  const parsed = (keys || [])
    .map(key => ({key, pos: cellPosFromKey(key), value: getCellValueByKeyForCurrentLop(key)}))
    .filter(x => Number.isFinite(x.pos.row) && Number.isFinite(x.pos.col));
  if(!parsed.length) return null;

  const minRow = Math.min(...parsed.map(x => x.pos.row));
  const maxRow = Math.max(...parsed.map(x => x.pos.row));
  const minCol = Math.min(...parsed.map(x => x.pos.col));
  const maxCol = Math.max(...parsed.map(x => x.pos.col));
  const offsets = parsed
    .filter(x => x.value === "OFF")
    .map(x => ({dr: x.pos.row - minRow, dc: x.pos.col - minCol}));

  return {
    type: "OFF_PATTERN",
    height: maxRow - minRow + 1,
    width: maxCol - minCol + 1,
    offsets
  };
}

function keysFromOffPatternAt(pattern, anchorKey){
  const base = cellPosFromKey(anchorKey);
  if(!Number.isFinite(base.row) || !Number.isFinite(base.col)) return [];
  return (pattern?.offsets || [])
    .map(o => keyFromCellPos(base, base.row + Number(o.dr || 0), base.col + Number(o.dc || 0)))
    .filter(Boolean);
}

function tkbHandleCopy(){
  const keys = selectedKeysForClipboard();
  if(!keys.length) return;

  const pattern = buildOffPatternFromKeys(keys);
  if(pattern && pattern.offsets.length){
    TKB_CLIPBOARD = {type: "OFF_PATTERN", payload: pattern};
    try{ _setStatus(`Đã copy mẫu NGHỈ: ${pattern.offsets.length} ô`, "info"); }catch(_){ }
  } else {
    try{ _setStatus("Vùng chọn không có ô NGHỈ", "info"); }catch(_){ }
  }
}

function tkbHandlePaste(){
  if(TKB_CLIPBOARD?.type !== "OFF" && TKB_CLIPBOARD?.type !== "OFF_PATTERN") return;

  let keys = selectedKeysForClipboard();
  if(!keys.length) return;

  if(TKB_CLIPBOARD?.type === "OFF_PATTERN"){
    const pattern = TKB_CLIPBOARD.payload;
    const singleOffPattern = Number(pattern?.width || 0) === 1
      && Number(pattern?.height || 0) === 1
      && (pattern?.offsets || []).length === 1;

    if(!(singleOffPattern && keys.length > 1)){
      const anchorKey = TKB_CELL_ACTIVE || topLeftKeyFromKeys(keys);
      keys = keysFromOffPatternAt(pattern, anchorKey);
    }
  }

  if(!keys.length) return;

  // confirm 1 lần nếu dán vào các ô đang cố định
  let fixedCount = 0;
  for(const k of keys){
    const v = getCellValueByKeyForCurrentLop(k);
    if(isFixed(v)) fixedCount++;
  }
  let skipConfirm = false;
  if(fixedCount > 0){
    const ok = confirm(`Có ${fixedCount} tiết đang CỐ ĐỊNH. Bỏ cố định và dán NGHỈ?`);
    if(!ok) return;
    skipConfirm = true;
  }
  setOffByKeys(keys, true, {skipConfirm});
}

function deleteActionForClassSlot(key, classId, thu, buoi, ti){
  const targetLop = (classId || currentLop || "").toString();
  if(!targetLop || !thu || !buoi || !Number.isFinite(ti)) return null;
  const tkb = DATA.tkb?.[targetLop];
  if(!tkb?.[thu]?.[buoi]) return null;
  const cur = tkb[thu][buoi][ti];
  if(cur === "" || cur == null) return null;
  if(cur === "OFF"){
    return {kind:"off", key, classId:targetLop, thu, buoi, ti, protected:true};
  }
  const mon = cellMon(cur);
  if(!mon) return null;
  return {kind:"lesson", key, classId:targetLop, thu, buoi, ti, protected:!!isFixed(cur), fixed:!!isFixed(cur)};
}

function deleteActionForKey(key){
  const {scope, classId, thu, buoi, ti} = parseCellKey(key);
  if(!thu || !buoi || !Number.isFinite(ti)) return null;
  const td = findTdByCellKey(key);
  if(scope === "teacher"){
    const targetGV = (classId || td?.dataset?.teacher || currentGV || "").toString().trim();
    if(targetGV && isTeacherFixedOff(targetGV, thu, buoi, ti)){
      return {kind:"teacherOff", key, teacher:targetGV, thu, buoi, ti, protected:true};
    }
    const lessonClassIds = (td?.dataset?.classids || "").split(",").map(s=>s.trim()).filter(Boolean);
    const lessonClassId = (td?.dataset?.classid || "").toString().trim()
      || (lessonClassIds.length === 1 ? lessonClassIds[0] : "");
    if(lessonClassId) return deleteActionForClassSlot(key, lessonClassId, thu, buoi, ti);
    return null;
  }
  return deleteActionForClassSlot(key, classId, thu, buoi, ti);
}

function confirmDeleteProtectedActions(actions){
  const protectedActions = (actions || []).filter(a=>a?.protected);
  if(!protectedActions.length) return true;
  const offCount = protectedActions.filter(a=>a.kind === "off" || a.kind === "teacherOff").length;
  const fixedCount = protectedActions.filter(a=>a.kind === "lesson" && a.fixed).length;
  const parts = [];
  if(offCount) parts.push(`${offCount} ô NGHỈ`);
  if(fixedCount) parts.push(`${fixedCount} tiết CỐ ĐỊNH`);
  const subject = parts.length ? parts.join(" và ") : `${protectedActions.length} ô`;
  return confirm(`Có ${subject} trong vùng chọn. Bạn có chắc chắn xóa không?`);
}

function deleteSelectedCells(){
  const keys = selectedKeysForClipboard();
  if(!keys.length) return;
  const actions = keys.map(deleteActionForKey).filter(Boolean);
  if(!actions.length) return;
  if(!confirmDeleteProtectedActions(actions)) return;

  let changed = false;
  let lessonCount = 0;
  let offCount = 0;
  let restoredCount = 0;

  for(const action of actions){
    if(action.kind === "teacherOff"){
      changed = syncTeacherFixedOffConstraint(action.teacher, action.thu, action.buoi, action.ti, false) || changed;
      offCount++;
      continue;
    }
    const tkb = DATA.tkb?.[action.classId];
    if(!tkb?.[action.thu]?.[action.buoi]) continue;
    const cur = tkb[action.thu][action.buoi][action.ti];
    if(cur === "" || cur == null) continue;
    if(action.kind === "off"){
      removeUserOffLock(action.classId, action.thu, action.buoi, action.ti);
      if(cur === "OFF"){
        const restored = restoreOffDisplacedLesson(action.classId, action.thu, action.buoi, action.ti, {reason:"delete_off"});
        if(restored?.restored) restoredCount++;
        else tkb[action.thu][action.buoi][action.ti] = "";
        changed = true;
        offCount++;
      }
      continue;
    }
    if(action.kind === "lesson"){
      if(cur !== "OFF" && cellMon(cur)){
        tkb[action.thu][action.buoi][action.ti] = "";
        changed = true;
        lessonCount++;
      }
    }
  }

  if(!changed) return;
  try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
  try{
    if(restoredCount > 0){
      _setStatus(`Đã khôi phục ${restoredCount} tiết từ ô nghỉ.`, "ok");
    }else
    if(lessonCount > 0) _setStatus(`Đã đưa ${lessonCount} tiết về Chưa phân.`, "ok");
    else if(offCount > 0) _setStatus(`Đã xóa ${offCount} ô nghỉ.`, "ok");
  }catch(_){ }
  applyCellSelectionStyles();
}

function tkbHandleSetSelectedOff(){
  const keys = TKB_CELL_SELECTION.size ? [...TKB_CELL_SELECTION] : (TKB_CELL_ACTIVE ? [TKB_CELL_ACTIVE] : []);
  if(!keys.length) return;
  let fixedCount = 0;
  for(const k of keys){
    const v = getCellValueByKeyForCurrentLop(k);
    if(isFixed(v)) fixedCount++;
  }
  let skipConfirm = false;
  if(fixedCount > 0){
    const ok = confirm(`Có ${fixedCount} tiết đang CỐ ĐỊNH. Bỏ cố định và đặt NGHỈ?`);
    if(!ok) return;
    skipConfirm = true;
  }
  setOffByKeys(keys, true, {skipConfirm});
}

function selectedClassCellKeysForFixedLesson(classId){
  const targetClass = String(classId || currentLop || "");
  if(!targetClass || VIEW_MODE !== "lop") return {keys: [], invalid: 0, wrongClass: 0};
  const keys = selectedKeysForClipboard();
  const out = [];
  let invalid = 0;
  let wrongClass = 0;
  for(const key of keys){
    const p = parseCellKey(key);
    const scope = String(p.scope || "");
    const keyClass = String(p.classId || currentLop || "");
    if(scope === "teacher" || keyClass !== targetClass){
      wrongClass++;
      continue;
    }
    if(!p.thu || !p.buoi || !Number.isFinite(p.ti)){
      invalid++;
      continue;
    }
    const tkb = DATA.tkb?.[targetClass];
    const arr = tkb?.[p.thu]?.[p.buoi];
    if(!arr || p.ti < 0 || p.ti >= arr.length){
      invalid++;
      continue;
    }
    const cur = arr[p.ti];
    if(cur !== "" && cur != null){
      invalid++;
      continue;
    }
    if(!out.includes(key)) out.push(key);
  }
  return {keys: out, invalid, wrongClass};
}

function tryApplyFixedLessonFromUnassigned(task){
  if(!task || !task.mon) return false;
  const rawKeys = selectedKeysForClipboard();
  if(!rawKeys.length) return false;
  const classId = String(task.classId || "");
  if(VIEW_MODE !== "lop" || !classId || String(currentLop || "") !== classId){
    try{ _setStatus("Chọn lớp của môn này rồi chọn ô trống để cố định hàng loạt.", "info"); }catch(_){ }
    return true;
  }

  const selection = selectedClassCellKeysForFixedLesson(classId);
  if(selection.wrongClass || selection.invalid || !selection.keys.length){
    try{ _setStatus("Chỉ chọn các ô trống của lớp hiện tại để thêm tiết cố định.", "error"); }catch(_){ }
    return true;
  }

  const remain = Number(task.remain || 0);
  if(remain > 0 && selection.keys.length > remain){
    try{ _setStatus(`Môn ${getMonShort(task.mon)} chỉ còn ${remain} tiết, đang chọn ${selection.keys.length} ô.`, "error"); }catch(_){ }
    return true;
  }

  const placements = [];
  const originals = [];
  const tkb = DATA.tkb?.[classId];
  for(const key of selection.keys){
    const p = parseCellKey(key);
    const td = findTdByCellKey(key);
    if(!td){
      try{ _setStatus("Không tìm thấy ô đang chọn. Hãy chọn lại ô trên TKB.", "error"); }catch(_){ }
      return true;
    }
    placements.push({key, p, td});
    originals.push({p, value: tkb?.[p.thu]?.[p.buoi]?.[p.ti]});
  }

  let fail = null;
  try{
    for(const item of placements){
      const res = validateDrop(item.td, task.mon);
      if(!res.ok || res.warn){
        fail = res.warn
          ? {msg: "Ô đang chọn có xung đột giáo viên/phòng. Hãy xử lý từng ô bằng kéo thả trước.", td:item.td}
          : {res, td:item.td};
        break;
      }
      tkb[item.p.thu][item.p.buoi][item.p.ti] = task.mon;
    }
  }finally{
    originals.forEach(item=>{
      if(tkb?.[item.p.thu]?.[item.p.buoi]) tkb[item.p.thu][item.p.buoi][item.p.ti] = item.value;
    });
  }

  if(fail){
    if(fail.res) showDropError(fail.res, fail.td);
    else{
      try{ showDropToast("⚠ " + fail.msg, fail.td, "error"); }catch(_){ }
      try{ _setStatus("⚠ " + fail.msg, "error"); }catch(_){ }
    }
    return true;
  }

  placements.forEach(item=>{
    tkb[item.p.thu][item.p.buoi][item.p.ti] = {mon: task.mon, fixed: true};
  });

  try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
  applyCellSelectionStyles();
  closeUnassignedDropdown();
  try{ _setStatus(`Đã cố định ${placements.length} tiết ${getMonShort(task.mon)}.`, "ok"); }catch(_){ }
  return true;
}

try{
  window.__tkbApplySelectedFixedLesson = tryApplyFixedLessonFromUnassigned;
}catch(_){}

function isClassTeacherPairView(){
  return VIEW_MODE === "lop" && !!document.querySelector("#tkb.tkb-pair-lop-gv");
}

function setPairNavScope(scope){
  if(scope !== "class" && scope !== "teacher") return;
  TKB_PAIR_NAV_SCOPE = scope;
  try{ window.__TKB_PAIR_NAV_SCOPE = scope; }catch(_){}
  try{
    const box = document.getElementById("tkb");
    if(box) box.dataset.pairNavScope = scope;
  }catch(_){}
}

function pairNavScopeForElement(el){
  if(!isClassTeacherPairView()) return "";
  const node = el && el.nodeType === 1 ? el : el?.parentElement;
  if(!node) return "";
  const id = (node.id || "").toString();
  if(id === "pairTeacherSelect" || node.closest?.("#tkbPairSupport")) return "teacher";
  if(id === "pairMainClassSelect" || node.closest?.("#tkb .tkb-pair-pane.main") || node.closest?.("#listLop")) return "class";
  if(node.closest?.("#tkb")) return TKB_PAIR_NAV_SCOPE || "class";
  return "";
}

function updatePairNavScopeFromElement(el){
  const scope = pairNavScopeForElement(el);
  if(scope) setPairNavScope(scope);
}

function stepSelectByKeyboard(selectId, dir){
  const sel = document.getElementById(selectId);
  if(!sel) return false;
  if(sel?.dataset?.pairSelect === "1"){
    const options = Array.from(sel.querySelectorAll("[data-pair-option]"));
    if(!options.length) return false;
    const cur = String(sel.dataset.value || "");
    let current = options.findIndex(btn => String(btn.dataset.pairOption || "") === cur);
    if(current < 0) current = 0;
    const next = Math.max(0, Math.min(options.length - 1, current + Number(dir || 0)));
    try{ sel.querySelector(".tkb-pair-select-btn")?.focus({preventScroll:true}); }catch(_){ }
    if(next === current) return true;
    try{ pairChooseSelectOption(options[next]); }catch(_){ }
    return true;
  }
  if(!sel.options || sel.options.length <= 0) return false;
  const current = Math.max(0, Number(sel.selectedIndex || 0));
  const next = Math.max(0, Math.min(sel.options.length - 1, current + Number(dir || 0)));
  if(next === current){
    try{ sel.focus({preventScroll:true}); }catch(_){ try{ sel.focus(); }catch(__){} }
    return true;
  }
  sel.selectedIndex = next;
  try{ sel.focus({preventScroll:true}); }catch(_){ try{ sel.focus(); }catch(__){} }
  sel.dispatchEvent(new Event("change", {bubbles:true}));
  return true;
}

function navigatePairScopeByKeyboard(dir){
  if(!isClassTeacherPairView()) return false;
  const activeScope = pairNavScopeForElement(document.activeElement);
  const scope = activeScope || TKB_PAIR_NAV_SCOPE || "class";
  if(scope === "teacher") return stepSelectByKeyboard("pairTeacherSelect", dir);
  return stepSelectByKeyboard("pairMainClassSelect", dir) || navigateCurrentListByKeyboard(dir);
}

function navigateCurrentListByKeyboard(dir){
  const items = Array.from(document.querySelectorAll("#listLop .lop-item"))
    .filter(el => el && el.dataset && (el.dataset.id || "").toString().trim());
  if(!items.length) return false;

  let idx = items.findIndex(el => el.classList.contains("active"));
  if(idx < 0){
    const currentId = VIEW_MODE === "gv" ? currentGV : (VIEW_MODE === "phong" ? currentPhong : currentLop);
    idx = items.findIndex(el => String(el.dataset.id || "") === String(currentId || ""));
  }
  if(idx < 0) idx = 0;

  const next = Math.max(0, Math.min(items.length - 1, idx + dir));
  if(next === idx) return true;

  const id = (items[next].dataset.id || "").toString();
  if(VIEW_MODE === "gv") selectGV(id);
  else selectLop(id);

  try{ items[next].scrollIntoView({block:"nearest"}); }catch(_){}
  return true;
}

function installTKBHotkeysOnce(){
  if(window.__TKB_HOTKEYS_INSTALLED) return;
  window.__TKB_HOTKEYS_INSTALLED = true;
  document.addEventListener("pointerdown", (e)=>{
    updatePairNavScopeFromElement(e?.target);
  }, true);
  document.addEventListener("focusin", (e)=>{
    updatePairNavScopeFromElement(e?.target);
  }, true);
  document.addEventListener("keydown", (e)=>{
    if(!e) return;
    if(document.getElementById("tkbConstraintsFullPanel")) return;
    // Không bắt phím khi đang focus input/select
    const tag = (document.activeElement?.tagName||"").toUpperCase();
    if(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // ESC: đóng menu
    if(e.key === "Escape"){
      hideCellMenu();
      return;
    }

    const k = (e.key||"").toLowerCase();
    if(k === "x" && !e.ctrlKey && !e.metaKey && !e.altKey){
      e.preventDefault();
      tkbHandleSetSelectedOff();
      return;
    }
    if(k === "delete" || k === "backspace"){
      e.preventDefault();
      deleteSelectedCells();
      return;
    }

    if(!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey){
      if(e.key === "ArrowRight" || e.key === "ArrowDown"){
        const handled = e.key === "ArrowDown"
          ? navigatePairScopeByKeyboard(1) || navigateCurrentListByKeyboard(1)
          : navigateCurrentListByKeyboard(1);
        if(handled) e.preventDefault();
        return;
      }
      if(e.key === "ArrowLeft" || e.key === "ArrowUp"){
        const handled = e.key === "ArrowUp"
          ? navigatePairScopeByKeyboard(-1) || navigateCurrentListByKeyboard(-1)
          : navigateCurrentListByKeyboard(-1);
        if(handled) e.preventDefault();
        return;
      }
    }

    const isMod = (e.ctrlKey || e.metaKey);
    if(!isMod) return;
    if(k === "c"){
      e.preventDefault();
      tkbHandleCopy();
    } else if(k === "v"){
      e.preventDefault();
      tkbHandlePaste();
    }
  }, true);
}

function bindSelectableCell(td){
  if(!td || td.__tkbSelectableBound) return;
  if(!td.dataset || !td.dataset.thu || !td.dataset.buoi || td.dataset.ti == null) return;
  td.__tkbSelectableBound = true;
  bindTouchDoubleAction(td);

  td.addEventListener("click", (e)=>{
    if(td.__tkbTouchDoubleHandled){
      td.__tkbTouchDoubleHandled = false;
      try{ e.preventDefault(); e.stopImmediatePropagation(); }catch(_){ }
      return;
    }
    if(td.__tkbCtrlFixedJustNow){
      td.__tkbCtrlFixedJustNow = false;
      try{ e.preventDefault(); e.stopImmediatePropagation(); }catch(_){}
    }
  }, true);

  td.addEventListener("mousedown", (e)=>{
    if(!e || e.button !== 0) return;

    try{ hideCellMenu(); }catch(_){ }
    try{ closeUnassignedDropdown(); }catch(_){ }
    try{
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if(tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") document.activeElement.blur();
    }catch(_){ }

    const key = cellKeyForTd(td);
    const hasMon = !!(td.dataset.mon||"").trim();
    const isOff = td.classList.contains("tkb-off");

    if((e.ctrlKey || e.metaKey) && hasMon && !isOff){
      try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
      td.__tkbCtrlFixedJustNow = true;
      selectSingleCell(td);
      toggleFixedByKey(key);
      return;
    }

    if(e.shiftKey){
      if(!TKB_CELL_ANCHOR) TKB_CELL_ANCHOR = key;
      selectRange(TKB_CELL_ANCHOR, td);
    } else if(e.ctrlKey || e.metaKey){
      toggleCellInSelection(td);
    } else {
      selectSingleCell(td);
    }

    // drag-select chỉ khi ô rỗng/NGHỈ (để không đụng Drag môn học)
    TKB_DRAG_SELECTING = (!hasMon || isOff);
  });

  td.addEventListener("mouseenter", ()=>{
    if(!TKB_DRAG_SELECTING) return;
    try{ _cancelCellLongPress(); }catch(_){ }
    if(TKB_CELL_ANCHOR) selectRange(TKB_CELL_ANCHOR, td);
  });

  td.addEventListener("mouseup", ()=>{
    TKB_DRAG_SELECTING = false;
    _cancelCellLongPress();
  });
}

function fixedLessonKeyForTd(td){
  const mon = (td?.dataset?.mon || "").toString().trim();
  if(!mon || td?.classList?.contains("tkb-off")) return "";
  const classIds = (td?.dataset?.classids || "").split(",").map(s=>s.trim()).filter(Boolean);
  const classId = (td?.dataset?.classid || "").toString().trim()
    || (classIds.length === 1 ? classIds[0] : "")
    || (currentLop || "").toString();
  if(!classId) return "";
  return cellKey(td?.dataset?.thu, td?.dataset?.buoi, td?.dataset?.ti, "", classId);
}

function handleRightClickUnassign(td, e){
  const key = fixedLessonKeyForTd(td);
  if(!key) return false;
  try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
  return clearLessonByKey(key);
}

function bindRightClickUnassignCell(td){
  if(!td || td.__tkbRightUnassignBound) return;
  td.__tkbRightUnassignBound = true;
  const previousContextMenu = td.oncontextmenu;
  td.oncontextmenu = (e)=>{
    if(handleRightClickUnassign(td, e)) return false;
    if(typeof previousContextMenu === "function") return previousContextMenu.call(td, e);
  };
}

/* ======================= DRAG DROP ======================= */
function setNativeDragTransfer(e, value){
  try{
    if(!e?.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(value || ""));
  }catch(_){ }
}

function bindCells(){
  document.querySelectorAll("#tkb td").forEach(td=>{
    bindSelectableCell(td);
    bindRightClickUnassignCell(td);
    td.ondragstart = (e)=>{
      // bảo đảm menu ô không bật khi drag
      try{ _cancelCellLongPress(); hideCellMenu(); }catch(_){ }
      let unfixedFromFixed = false;
      // OFF không được kéo
      if(td.classList.contains("tkb-off")) { e.preventDefault(); return; }

      // Nếu là tiết cố định: hỏi có bỏ cố định để kéo không?
      if(td.classList.contains("tkb-fixed")){
        const ok = confirm("Tiết này đang CỐ ĐỊNH. Bạn muốn BỎ cố định để kéo không?");
        if(!ok){ e.preventDefault(); return; }

        // Bỏ cố định trong dữ liệu (không render lại ngay để tránh giật khi đang drag)
        try{
          if(currentLop){
            const t = td.dataset;
            const tkb = DATA.tkb?.[currentLop];
            if(tkb && tkb?.[t.thu]?.[t.buoi]){
              const ti = Number(t.ti);
              const mon = (td.dataset.mon||"").trim();
              if(mon){
                tkb[t.thu][t.buoi][ti] = mon;
                td.classList.remove("tkb-fixed");
                unfixedFromFixed = true;
              }
            }
          }
        }catch(_){ /* ignore */ }
      }

      // KHÔNG lấy textContent vì text hiển thị có thể là "MÃMÔN-MÃGV".
      const val = (td.dataset.mon||"").trim();
      if(!val) { e.preventDefault(); return; }
      dragData = { type:"cell", from: td, val, _unfixedFromFixed: unfixedFromFixed };
      dragMon = val;
      // WebKit/iPhone chỉ khởi động kéo native ổn định khi có payload.
      setNativeDragTransfer(e, val);
      applyDragVisual(dragMon, td);
    };

    td.ondragend = ()=>{
      clearDragVisual();
      // Nếu vừa bỏ cố định ở dragstart mà user thả (không drop), render lại để UI đồng bộ.
      if(dragData && dragData.type === "cell" && dragData._unfixedFromFixed){
        try{ saveStore(); }catch(_){ }
        try{ renderCurrentView(); loadMonList(); }catch(_){ }
      }
      dragData = null;
      dragMon = "";
    };

    td.ondragover = (e)=>{
      if(!dragData) return;
      e.preventDefault();
      const res = validateDrop(td, dragMon);
      setDropHint(td, res.ok && !res.warn);
    };

    td.ondragenter = ()=>{
      if(!dragData) return;
      td.classList.add("drag-over");
    };
    td.ondragleave = ()=>{
      td.classList.remove("drag-over", "drop-valid", "drop-invalid");
    };

    td.ondrop = (e)=>{
      if(!dragData) return;
      try{ if(e) e.preventDefault(); }catch(_){ }
      let res = validateDrop(td, dragMon);
      if(!res.ok && maybeRaiseSessionLimitForDrop(td, dragMon, res)){
        res = validateDrop(td, dragMon);
      }

      // Không hợp lệ => chặn luôn
      if(!res.ok){
        flashInvalid(td);
        showDropError(res, td);
        return;
      }

      // Có xung đột (GV/Phòng) => cho chọn thay thế
      if(res.warn && Array.isArray(res.conflicts) && res.conflicts.length){
        try{ showDropToast("⚠ " + (res.msg || "Có xung đột. Bạn có muốn thay thế không?"), td, "warn"); }catch(_){ }
        const ok = confirm(res.confirmText || buildReplaceConfirmText(res.conflicts));
        if(!ok){
          // người dùng hủy
          try{ showDropToast("Đã hủy thao tác.", td, "info"); }catch(_){ }
          flashInvalid(td);
          return;
        }
        // Thay thế: đưa các tiết trùng ở lớp kia về "Chưa phân" (thực chất là xóa khỏi TKB lớp kia)
        clearConflictSlots(res.conflicts);
      }

      try{
        onDrop(td);
      }catch(err){

        console.error(err);
        flashInvalid(td);
        showDropError({ok:false, reason:"runtime", msg:(err && err.message) ? err.message : String(err)}, td);
      }
    };

    td.oncontextmenu = (e)=>{
      if(handleRightClickUnassign(td, e)) return false;
    };

    // Máy tính: cố định trực tiếp. Điện thoại: mở menu Cố định/Nghỉ/Xóa.
    td.ondblclick = (e)=>{
      if(VIEW_MODE !== "lop") return;
      handleCellDoubleAction(td, e);
    };

  });

  // re-apply selection highlight sau khi render lại
  applyCellSelectionStyles();
}

function flashInvalid(td){
  td.classList.add("drop-invalid");
  setTimeout(()=>td.classList.remove("drop-invalid"), 450);
}

let __DROP_TOAST_EL = null;
let __DROP_TOAST_TIMER = null;

function _ensureDropToastEl(){
  if(__DROP_TOAST_EL) return __DROP_TOAST_EL;
  const d = document.createElement("div");
  d.id = "dropToast";
  d.className = "drop-toast";
  d.style.display = "none";
  document.body.appendChild(d);
  __DROP_TOAST_EL = d;
  return d;
}

// Hiện nhắc nhở nhỏ gần ô đang thả (không chặn thao tác)
function showDropToast(msg, td, type="error"){
  const text = (msg||"").toString().trim();
  if(!text) return;
  const d = _ensureDropToastEl();
  d.classList.remove("ok","info","error");
  d.classList.add(type === "ok" ? "ok" : (type === "info" ? "info" : "error"));
  d.textContent = text;
  d.style.display = "block";

  // position (tránh tràn màn hình)
  const pad = 8;
  const r = td ? td.getBoundingClientRect() : {left: window.innerWidth/2, top: window.innerHeight/2, width: 0, height: 0};
  // đo size sau khi show
  const w = d.offsetWidth || 240;
  const h = d.offsetHeight || 48;

  let left = r.left + r.width + pad;
  let top  = r.top + pad;

  if(left + w > window.innerWidth - pad) left = r.left - w - pad;
  if(left < pad) left = pad;
  if(top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  if(top < pad) top = pad;

  d.style.left = `${left}px`;
  d.style.top  = `${top}px`;

  if(__DROP_TOAST_TIMER) clearTimeout(__DROP_TOAST_TIMER);
  __DROP_TOAST_TIMER = setTimeout(()=>{
    if(__DROP_TOAST_EL) __DROP_TOAST_EL.style.display = "none";
  }, 1600);
}

function flashLopItemConflict(lopId){
  const id = (lopId == null) ? "" : String(lopId);
  if(!id) return;
  const els = document.querySelectorAll("#listLop .lop-item");
  els.forEach(el=>{
    if(String(el.dataset.id) === id){
      el.classList.add("flash-conflict");
      setTimeout(()=>el.classList.remove("flash-conflict"), 1400);
    }
  });
}

function showDropError(res, td){
  const reason = (res?.reason || "").toString();
  let msg = (res?.msg || "").toString().trim();

  if(!msg){
    switch(reason){
      case "no class": msg = "Chưa chọn lớp để xếp TKB."; break;
      case "empty": msg = "Chưa xác định môn học để thả."; break;
      case "locked": msg = "Ô này đang NGHỈ hoặc CỐ ĐỊNH."; break;
      case "wrong class": msg = "Tiết này thuộc lớp khác. Hãy chọn đúng lớp trước khi kéo."; break;
      case "exceed week total": msg = "Vượt số tiết/tuần của môn này."; break;
      case "exceed day limit": msg = "Vượt giới hạn số tiết/môn trong ngày. Hãy chỉnh giới hạn trong Yêu cầu môn học."; break;
      case "exceed session limit": msg = "Vượt giới hạn số tiết/môn trong một buổi ở Phân công."; break;
      case "split block":
      case "touch left":
      case "touch right":
        msg = "Môn này không được tách rời trong cùng buổi (các tiết phải LIỀN nhau).";
        break;
      case "teacher conflict": msg = "Trùng lịch giáo viên ở tiết này."; break;
      case "room conflict": msg = "Trùng phòng ở tiết này."; break;
      case "runtime": msg = "Có lỗi khi thả. Vui lòng thử lại."; break;
      default: msg = "Không thể thả vào ô này."; break;
    }
  }

  try{ showDropToast("⚠ " + msg, td, "error"); }catch(_){ }
  try{ _setStatus("⚠ " + msg, "error"); }catch(_){ }

  if(res?.conflictLopId != null){
    try{ flashLopItemConflict(res.conflictLopId); }catch(_){ }
  }
}

function maybeRaiseSessionLimitForDrop(td, mon, res){
  if(!res || res.reason !== "exceed session limit" || res.canRaiseSessionLimit !== true) return false;
  const classId = String(res.classId || currentLop || "");
  const lopCanon = getLopCanonById(classId);
  const label = getMonShort(mon) || mon;
  const currentLimit = Math.max(1, Number(res.limit || getGioiHanForClassMon(lopCanon, mon) || getMonMeta(mon).gioihan || 1));
  const requestedLimit = Math.max(currentLimit + 1, Number(res.requestedLimit || res.used || 0));
  const ok = confirm(
    `Môn ${label} của lớp ${lopCanon} đang giới hạn tối đa ${currentLimit} tiết trong một buổi ở Phân công.\n` +
    `Nếu tiếp tục, hệ thống sẽ nâng riêng lớp-môn này lên ${requestedLimit} tiết/buổi. ` +
    `Giới hạn số tiết/ngày trong Yêu cầu môn học không thay đổi.\n\n` +
    `Bạn có muốn nâng giới hạn và thả tiết không?`
  );
  if(!ok) return false;
  const changed = setClassSubjectSessionLimit(lopCanon, mon, requestedLimit);
  if(changed){
    try{ showDropToast(`Đã nâng giới hạn ${label}-${lopCanon} lên ${requestedLimit} tiết/buổi.`, td, "info"); }catch(_){ }
    try{ _setStatus(`Đã nâng giới hạn ${label}-${lopCanon} lên ${requestedLimit} tiết/buổi.`, "info"); }catch(_){ }
  }
  return changed;
}

function buildReplaceConfirmText(conflicts){
  // conflicts: [{type:'teacher'|'room', gv, room, lopId, mon, thu, buoi, ti, msg}]
  const lines = [];
  const seen = new Set();
  for(const c of (conflicts || [])){
    const lop = getLopCanonById(c.lopId);
    const mon = getMonShort(c.mon || "");
    const key = `${c.type}|${c.lopId}|${c.thu}|${c.buoi}|${c.ti}|${mon}`;
    if(seen.has(key)) continue;
    seen.add(key);

    if(c.type === "teacher"){
      lines.push(`- Trùng GV ${c.gv || ""}: ${mon}-${lop}`);
    } else if(c.type === "room"){
      lines.push(`- Trùng phòng ${c.room || ""}: ${mon}-${lop}`);
    } else {
      lines.push(`- Xung đột: ${mon}-${lop}`);
    }
  }

  return (
    "⚠ Phát hiện xung đột ở tiết này:\n" +
    (lines.length ? lines.join("\n") : "- (Không rõ chi tiết)") +
    "\n\nBạn có muốn THAY THẾ không?\n" +
    "(Nếu thay thế, tiết trùng ở lớp kia sẽ được đưa về \"Chưa phân\".)"
  );
}

function clearConflictSlots(conflicts){
  const uniqueLops = new Set();
  for(const c of (conflicts || [])){
    const lopId = c.lopId;
    if(lopId == null) continue;
    const tkbOther = DATA?.tkb?.[lopId];
    if(!tkbOther) continue;

    const thu = c.thu, buoi = c.buoi, ti = Number(c.ti);
    if(!thu || !buoi || !Number.isFinite(ti)) continue;

    const cell = tkbOther?.[thu]?.[buoi]?.[ti];
    // Không đụng tới OFF/cố định (trường hợp hi hữu)
    if(cell === "OFF") continue;
    if(cell && typeof cell === "object" && cell.fixed) continue;

    tkbOther[thu][buoi][ti] = "";
    uniqueLops.add(String(lopId));
  }

  // Nhấp nháy các lớp bị ảnh hưởng để user dễ thấy
  try{
    uniqueLops.forEach(id=>flashLopItemConflict(id));
  }catch(_){ }
}

function onDrop(td){
  if(!dragData) return;
  if(td.classList.contains("tkb-off") || td.classList.contains("tkb-fixed")) return;

  const t = td.dataset;
  const ti = Number(t.ti);
  const tkb = DATA.tkb[currentLop];

  // clear target
  tkb[t.thu][t.buoi][ti] = "";

  if(dragData.type === "mon"){
    tkb[t.thu][t.buoi][ti] = dragData.mon;
  } else if(dragData.type === "cell" || dragData.type === "pairTeacherCell"){
    if(dragData.classId != null && String(dragData.classId) !== String(currentLop)){
      throw new Error("Tiết kéo đang thuộc lớp khác với bảng lớp hiện tại.");
    }
    const s = dragData.from?.dataset;
    if(!s) throw new Error("Thiếu dữ liệu ô nguồn để kéo thả (dragData.from)");
    tkb[s.thu][s.buoi][Number(s.ti)] = "";
    tkb[t.thu][t.buoi][ti] = dragData.val;
  } else {
    throw new Error("Dữ liệu kéo thả không hợp lệ (dragData.type)");
  }

  try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }

  clearDragVisual();
  dragData = null;
  dragMon = "";
}

function setDropHint(td, ok){
  td.classList.remove("drop-valid", "drop-invalid");
  td.classList.add(ok ? "drop-valid" : "drop-invalid");
}

function applyDragVisual(mon, excludeTd){
  clearDragVisual();

  // excludeTd có thể là <td> (khi kéo trong TKB) hoặc null (khi kéo từ "Chưa phân")
  const isEl = !!(excludeTd && typeof excludeTd === "object" && excludeTd.classList);

  // mờ tất cả ô cùng môn để cảnh báo trùng
  document.querySelectorAll("#tkb td").forEach(td=>{
    if(isEl && td === excludeTd) return;
    const m = (td.dataset.mon || "").trim();
    if(m && m === mon) td.classList.add("conflict");
  });

  if(isEl) excludeTd.classList.add("drag-source");
}

function clearDragVisual(){
  document.querySelectorAll("#tkb td").forEach(td=>{
    td.classList.remove("conflict","drag-source","drag-over","drop-valid","drop-invalid");
  });
}

/* ======================= VALIDATION (KHÔNG TRÙNG MÔN TRONG 1 BUỔI) ======================= */
/*
  Quy tắc:
  - Trong 1 buổi (sáng hoặc chiều) của 1 ngày: 1 môn chỉ được xuất hiện trong 1 CỤM LIỀN NHAU.
    Ví dụ lim=2 => được phép 2 tiết liền nhau; KHÔNG cho phép "Toán - Văn - Toán" trong cùng buổi.
  - Số tiết trong từng BUỔI không vượt quá gioihan ở Phân công (nếu không có => coi như 1).
  - Giới hạn số tiết/ngày là constraint riêng trong Yêu cầu môn học (maxPeriods.day).
  - Số tiết/tuần không vượt quá sotiet của môn (nếu có)
*/
function validateDrop(targetTd, mon){
  if(!currentLop) return {ok:false, reason:"no class"};
  if(!mon) return {ok:false, reason:"empty"};
  if(targetTd.classList.contains("tkb-off") || targetTd.classList.contains("tkb-fixed")) return {ok:false, reason:"locked"};

  // Nếu kéo từ "Chưa phân" nhưng item thuộc lớp khác => không cho thả nhầm
  if(dragData && dragData.type === "mon" && dragData.classId != null && String(dragData.classId) !== String(currentLop)){
    const other = getLopCanonById(dragData.classId);
    return {ok:false, reason:"wrong class", msg:`Tiết này thuộc lớp ${other}. Hãy chọn lớp đó trước khi kéo.`, conflictLopId: dragData.classId};
  }
  if(dragData && dragData.type === "pairTeacherCell" && dragData.classId != null && String(dragData.classId) !== String(currentLop)){
    const other = getLopCanonById(dragData.classId);
    return {ok:false, reason:"wrong class", msg:`Tiết này thuộc lớp ${other}. Chỉ kéo trực tiếp lên bảng lớp khi bảng trên đang là lớp đó.`, conflictLopId: dragData.classId};
  }


  const tkb = DATA.tkb[currentLop];
  const tThu = targetTd.dataset.thu;
  const tBuoi = targetTd.dataset.buoi;
  const tTi = Number(targetTd.dataset.ti);

  const meta = getMonMeta(mon);
  const total = Number(meta.sotiet||0);
  const sessionLimit = Math.max(1, Number(meta.gioihan||1));

  // tổng tuần
  const used = countMon(mon);
  const targetVal = cellMon(tkb[tThu][tBuoi][tTi]);

  const src = (dragData && (dragData.type==="cell" || dragData.type==="pairTeacherCell")) ? dragData.from?.dataset : null;
  const srcThu = src?.thu;
  const srcBuoi = src?.buoi;
  const srcTi = src ? Number(src.ti) : -1;
  const srcVal = (src && srcThu && srcBuoi) ? cellMon(tkb[srcThu][srcBuoi][srcTi]) : "";

  // tính newUsed sau drop
  let newUsed = used;
  // remove source if it is the same mon
  if(srcVal === mon) newUsed -= 1;
  // remove target if target currently is same mon (vì ta clear target trước khi đặt)
  if(targetVal === mon) newUsed -= 1;
  // add one at target
  newUsed += 1;

  if(total > 0 && newUsed > total){
    return {ok:false, reason:"exceed week total"};
  }

  // xây arr mô phỏng cho buổi mục tiêu
  const arr = (tkb[tThu][tBuoi] || []).slice();

  // nếu kéo từ chính buổi mục tiêu, xóa vị trí nguồn
  if(srcThu === tThu && srcBuoi === tBuoi && srcTi >= 0){
    arr[srcTi] = "";
  }
  // xóa target rồi đặt
  arr[tTi] = mon;

  // gioihan của Phân công là giới hạn riêng cho BUỔI mục tiêu, không cộng sáng + chiều.
  const idx = [];
  for(let i=0;i<arr.length;i++){
    if(cellMon(arr[i]) === mon) idx.push(i);
  }
  if(idx.length > sessionLimit){
    return {
      ok:false,
      reason:"exceed session limit",
      confirmable:true,
      canRaiseSessionLimit:true,
      classId:currentLop,
      limit:sessionLimit,
      used:idx.length,
      requestedLimit:idx.length
    };
  }
  // nếu có >=2 tiết trong cùng buổi, phải liền nhau (1 cụm)
  for(let i=1;i<idx.length;i++){
    if(idx[i] !== idx[i-1] + 1){
      return {ok:false, reason:"split block"};
    }
  }

  // thêm một kiểm tra nhỏ: không cho đặt trùng "dính" ở ngoài cụm (phòng trường hợp data lạ)
  if(idx.length){
    const left = idx[0]-1;
    const right = idx[idx.length-1] + 1;
    if(left >= 0 && cellMon(arr[left]) === mon) return {ok:false, reason:"touch left"};
    if(right < arr.length && cellMon(arr[right]) === mon) return {ok:false, reason:"touch right"};
  }


  // ===== Tránh trùng lịch GV/Phòng (ràng buộc toàn trường) =====
  // NEW: nếu trùng thì KHÔNG chặn ngay, mà cho phép thả kèm confirm "Thay thế"
  const lopCanon = getLopCanonById(currentLop);

  const conflicts = [];

  const gv = getTeacherForClassMon(lopCanon, mon);
  const gvConflict = findTeacherConflictAtSlot(gv, tThu, tBuoi, tTi, currentLop);
  if(gvConflict){
    conflicts.push({
      type: "teacher",
      gv,
      lopId: gvConflict.lopId,
      mon: gvConflict.mon,
      thu: tThu,
      buoi: tBuoi,
      ti: tTi,
      msg: `Trùng GV ${gv} (đang dạy ${getMonShort(gvConflict.mon)}-${getLopCanonById(gvConflict.lopId)} ở tiết này)`
    });
  }

  const room = getRoomForClassMon(lopCanon, mon);
  const roomConflict = findRoomConflictAtSlot(room, tThu, tBuoi, tTi, currentLop);
  if(roomConflict){
    conflicts.push({
      type: "room",
      room,
      lopId: roomConflict.lopId,
      mon: roomConflict.mon,
      thu: tThu,
      buoi: tBuoi,
      ti: tTi,
      msg: `Trùng phòng ${room} (đang dùng bởi ${getMonShort(roomConflict.mon)}-${getLopCanonById(roomConflict.lopId)})`
    });
  }

  if(conflicts.length){
    // highlight lớp bị trùng
    try{
      conflicts.forEach(c=>flashLopItemConflict(c.lopId));
    }catch(_){ }

    const msg = (conflicts.length === 1)
      ? conflicts[0].msg
      : ("Có " + conflicts.length + " xung đột (GV/Phòng) ở tiết này.");

    return {
      ok: true,
      warn: true,
      reason: "conflict",
      msg,
      conflicts,
      conflictLopId: conflicts[0].lopId,
      confirmText: buildReplaceConfirmText(conflicts)
    };
  }

  return {ok:true};

}

/* ======================= MÔN LIST ======================= */
function countMonInTKB(tkb, mon){
  return countMonFromTkbCountMap(buildTkbMonCountMap(tkb), mon);
}

function buildTkbMonCountMap(tkb){
  const counts = new Map();
  if(!tkb) return counts;
  DAYS.forEach(d=>["sang","chieu"].forEach(b=>{
    (tkb[d]?.[b] || []).forEach(x=>{
      const key = monCanonicalKey(cellMon(x));
      if(key) counts.set(key, (counts.get(key) || 0) + 1);
    });
  }));
  return counts;
}

function countMonFromTkbCountMap(counts, mon){
  if(!counts || typeof counts.get !== "function") return 0;
  const key = monCanonicalKey(mon);
  return key ? Number(counts.get(key) || 0) : 0;
}

function requiredSubjectsForClass(lop){
  const classId = String(lop?.id || "").trim();
  if(!classId) return [];
  const classCanon = getLopCanonById(classId);
  const khoiNum = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "";
  const bySubject = new Map();
  const addRow = (subject, periods, teacher, room)=>{
    const mon = String(subject || "").trim();
    const key = monCanonicalKey(mon);
    const req = Number(periods || 0);
    if(!key || !mon || !Number.isFinite(req) || req <= 0) return;
    const current = bySubject.get(key) || {mon, required:0, gv:"", room:""};
    current.required = Math.max(Number(current.required || 0), Math.round(req));
    if(!current.gv) current.gv = String(teacher || "").trim();
    if(!current.room) current.room = String(room || "").trim();
    bySubject.set(key, current);
  };

  (computeMonsForClass(khoiNum, classCanon) || []).forEach(item=>{
    const mon = String(item?.ten || item?.mon || item?.ma || item?.id || "").trim();
    const req = Number(item?.sotiet ?? item?.soTiet ?? item?.periods ?? 0);
    addRow(mon, req, getTeacherForClassMon(classCanon, mon), getRoomForClassMon(classCanon, mon));
  });

  const matrix = DATA.pccmMatrix || {};
  const periods = DATA.pccmTietMatrix || {};
  const rooms = DATA.pccmRoomMatrix || {};
  Object.keys(matrix).forEach(rawKey=>{
    const parts = String(rawKey).split("|");
    const cid = String(parts.shift() || "").trim();
    const subject = String(parts.join("|") || "").trim();
    if(cid !== classId || !subject) return;
    let req = Number(periods[rawKey] ?? periods[`${cid}|${subject}`] ?? 0);
    if(!Number.isFinite(req) || req <= 0){
      const existing = bySubject.get(monCanonicalKey(subject));
      req = Number(existing?.required || 0);
    }
    addRow(
      subject,
      req,
      matrix[rawKey] || getTeacherForClassMon(classCanon, subject),
      rooms[rawKey] || rooms[`${cid}|${subject}`] || getRoomForClassMon(classCanon, subject)
    );
  });

  return Array.from(bySubject.values()).map(row=>({
    mon: row.mon,
    required: Number(row.required || 0),
    gv: String(row.gv || getTeacherForClassMon(classCanon, row.mon) || "").trim(),
    room: String(row.room || getRoomForClassMon(classCanon, row.mon) || "").trim()
  }));
}

function collectUnassignedTasks(options={}){
  const hasOnlyClass = Object.prototype.hasOwnProperty.call(options || {}, "onlyClassId");
  const onlyClassId = hasOnlyClass ? String(options.onlyClassId || "") : "";
  if(hasOnlyClass && !onlyClassId) return [];

  const useKhoiFilter = options?.useKhoiFilter === true;
  const khoiSel = document.getElementById("chonKhoi")?.value || "";
  const kFilter = useKhoiFilter ? extractKhoiNumber(khoiSel) : "";
  const lops = Array.isArray(DATA.lop)
    ? DATA.lop.filter(l => {
        if(hasOnlyClass && String(l.id) !== onlyClassId) return false;
        if(kFilter){
          const khoiNum = extractKhoiNumber(l?.khoi) || extractKhoiNumber(l?.ten2) || extractKhoiNumber(l?.ten) || "";
          if(String(khoiNum) !== String(kFilter)) return false;
        }
        return true;
      })
    : [];

  const tasks = [];
  lops.forEach(l=>{
    const classId = l.id;
    const classCanon = getLopCanonById(classId);
    if(!classCanon) return;

    const tkb = DATA.tkb?.[classId];
    const tkbMonCounts = buildTkbMonCountMap(tkb);
    const subjects = requiredSubjectsForClass(l);

    subjects.forEach(s=>{
      const mon = (s?.mon || s?.ten || "").toString().trim();
      if(!mon) return;
      const gv = String(s?.gv || getTeacherForClassMon(classCanon, mon) || "").trim();
      const required = Number(s?.required ?? s?.sotiet ?? 0);
      if(!Number.isFinite(required) || required <= 0) return;
      const used = countMonFromTkbCountMap(tkbMonCounts, mon);
      const remain = Math.max(0, required - used);
      if(remain <= 0) return;
      tasks.push({
        classId,
        classCanon,
        className: classCanonFromLop(l),
        mon,
        remain,
        gv,
        room: s?.room || getRoomForClassMon(classCanon, mon) || ""
      });
    });
  });

  const map = new Map();
  tasks.forEach(t=>{
    const k = `${t.classId}|${t.mon}`;
    if(!map.has(k)) map.set(k, {...t});
    else map.get(k).remain += Number(t.remain || 0);
  });

  return Array.from(map.values()).sort((a,b)=>{
    const c = (a.className||"").localeCompare((b.className||""),'vi');
    if(c) return c;
    const m = compareMonByHiddenCode(a.mon,b.mon);
    if(m) return m;
    return Number(b.remain || 0) - Number(a.remain || 0);
  });
}

// giữ API cũ (đếm trên lớp đang chọn)
function tkbAutoRepairCellStub(classId, thu, buoi, ti){
  return {
    dataset: {
      classid: String(classId || ""),
      classId: String(classId || ""),
      thu: String(thu || ""),
      buoi: String(buoi || ""),
      ti: String(ti)
    },
    classList: {
      contains(cls){
        const value = DATA?.tkb?.[classId]?.[thu]?.[buoi]?.[ti];
        if(cls === "tkb-off") return value === "OFF";
        if(cls === "tkb-fixed") return !!isFixed(value);
        return false;
      },
      add(){},
      remove(){},
      toggle(){}
    }
  };
}

function tkbAutoRepairWithDropContext(task, fn){
  const oldLop = currentLop;
  const oldDragData = dragData;
  const oldDragMon = dragMon;
  const mon = String(task?.mon || "").trim();
  const hadMeta = Object.prototype.hasOwnProperty.call(CURRENT_MON_META, mon);
  const oldMeta = CURRENT_MON_META[mon];
  try{
    currentLop = String(task?.classId || "");
    dragData = task?.dragData || {type:"mon", classId: task?.classId, mon};
    dragMon = mon;
    const tkb = DATA?.tkb?.[task?.classId];
    const used = countMonInTKB(tkb, mon);
    const required = Math.max(used + 1, used + Number(task?.remain || 1));
    const classLimit = Number(getGioiHanForClassMon(task?.classCanon, mon) || oldMeta?.gioihan || getMonMeta(mon).gioihan || 1);
    CURRENT_MON_META[mon] = Object.assign({}, oldMeta || {}, {
      sotiet: required,
      gioihan: Math.max(1, Number.isFinite(classLimit) ? classLimit : 1)
    });
    return fn();
  }finally{
    currentLop = oldLop;
    dragData = oldDragData;
    dragMon = oldDragMon;
    if(hadMeta) CURRENT_MON_META[mon] = oldMeta;
    else delete CURRENT_MON_META[mon];
  }
}

function tkbAutoRepairSlotStub(slot){
  return tkbAutoRepairCellStub(slot?.classId, slot?.thu, slot?.buoi, slot?.ti);
}

function tkbAutoRepairSlotsForClass(classId){
  const tkb = DATA?.tkb?.[classId];
  const out = [];
  if(!tkb) return out;
  for(const thu of DAYS){
    for(const buoi of ["sang","chieu"]){
      const arr = tkb?.[thu]?.[buoi] || [];
      for(let ti = 0; ti < arr.length; ti++){
        out.push({classId, thu, buoi, ti});
      }
    }
  }
  return out;
}

function tkbAutoRepairSlotValue(classId, slot){
  return DATA?.tkb?.[classId]?.[slot?.thu]?.[slot?.buoi]?.[slot?.ti];
}

function tkbAutoRepairIsBlankSlot(classId, slot){
  const value = tkbAutoRepairSlotValue(classId, slot);
  return value !== "OFF" && !isFixed(value) && !cellMon(value);
}

function tkbAutoRepairIsMovableLesson(classId, slot){
  const value = tkbAutoRepairSlotValue(classId, slot);
  return value !== "OFF" && !isFixed(value) && !!cellMon(value);
}

function tkbAutoRepairValidateResultAtSlot(task, slot){
  return tkbAutoRepairWithDropContext(task, ()=>{
    try{
      return validateDrop(tkbAutoRepairSlotStub(slot), task.mon);
    }catch(_){
      return {ok:false, reason:"runtime"};
    }
  });
}

function tkbAutoRepairValidateAtSlot(task, slot){
  const res = tkbAutoRepairValidateResultAtSlot(task, slot);
  return !!(res && res.ok && !res.warn);
}

function tkbAutoRepairSlotScore(task, slot){
  const tkb = DATA?.tkb?.[task?.classId];
  const arr = tkb?.[slot.thu]?.[slot.buoi] || [];
  let score = 0;
  if(cellMon(arr[slot.ti - 1])) score += 4;
  if(cellMon(arr[slot.ti + 1])) score += 4;
  if(slot.buoi === "sang") score += 2;
  score -= Number(slot.ti || 0) * 0.01;
  return score;
}

function tkbAutoRepairFindSlot(task){
  const tkb = DATA?.tkb?.[task?.classId];
  if(!tkb) return null;
  const candidates = [];
  for(const thu of DAYS){
    for(const buoi of ["sang","chieu"]){
      const arr = tkb?.[thu]?.[buoi] || [];
      for(let ti = 0; ti < arr.length; ti++){
        const value = arr[ti];
        if(value === "OFF" || isFixed(value) || cellMon(value)) continue;
        const td = tkbAutoRepairCellStub(task.classId, thu, buoi, ti);
        const ok = tkbAutoRepairWithDropContext(task, ()=>{
          try{
            const res = validateDrop(td, task.mon);
            return !!(res && res.ok && !res.warn);
          }catch(_){
            return false;
          }
        });
        if(ok) candidates.push({thu, buoi, ti, score: tkbAutoRepairSlotScore(task, {thu, buoi, ti})});
      }
    }
  }
  candidates.sort((a,b)=>Number(b.score || 0) - Number(a.score || 0));
  return candidates[0] || null;
}

function tkbAutoRepairMoveScore(task, target, buffer){
  let score = tkbAutoRepairSlotScore(task, target);
  if(target.thu !== buffer.thu) score += 1;
  if(target.buoi !== buffer.buoi) score += 0.5;
  score -= Math.abs(Number(target.ti || 0) - Number(buffer.ti || 0)) * 0.01;
  return score;
}

function tkbAutoRepairTryOneMove(task){
  const classId = task?.classId;
  const tkb = DATA?.tkb?.[classId];
  if(!tkb) return null;
  const slots = tkbAutoRepairSlotsForClass(classId);
  const blankSlots = slots.filter(slot => tkbAutoRepairIsBlankSlot(classId, slot));
  const occupiedSlots = slots
    .filter(slot => tkbAutoRepairIsMovableLesson(classId, slot))
    .filter(slot => monCanonicalKey(cellMon(tkbAutoRepairSlotValue(classId, slot))) !== monCanonicalKey(task?.mon));

  const attempts = [];
  for(const buffer of blankSlots){
    for(const target of occupiedSlots){
      attempts.push({buffer, target, score: tkbAutoRepairMoveScore(task, target, buffer)});
    }
  }
  attempts.sort((a,b)=>Number(b.score || 0) - Number(a.score || 0));

  for(const attempt of attempts){
    const {buffer, target} = attempt;
    const targetValue = tkbAutoRepairSlotValue(classId, target);
    const movedMon = cellMon(targetValue);
    if(!movedMon) continue;

    const moveTask = {
      classId,
      classCanon: task.classCanon,
      mon: movedMon,
      remain: 1,
      dragData: {
        type: "cell",
        classId,
        from: tkbAutoRepairSlotStub(target),
        val: targetValue,
        mon: movedMon
      }
    };
    if(!tkbAutoRepairValidateAtSlot(moveTask, buffer)) continue;

    tkb[buffer.thu][buffer.buoi][buffer.ti] = targetValue;
    tkb[target.thu][target.buoi][target.ti] = "";
    const canPlaceMissing = tkbAutoRepairValidateAtSlot(task, target);
    if(canPlaceMissing){
      tkb[target.thu][target.buoi][target.ti] = task.mon;
      return {
        classId,
        className: task.className,
        mon: task.mon,
        placed: true,
        method: "one_move",
        thu: target.thu,
        buoi: target.buoi,
        ti: target.ti,
        movedMon,
        movedTo: {thu: buffer.thu, buoi: buffer.buoi, ti: buffer.ti}
      };
    }
    tkb[target.thu][target.buoi][target.ti] = targetValue;
    tkb[buffer.thu][buffer.buoi][buffer.ti] = "";
  }
  return null;
}

function tkbAutoRepairConflictMoveCandidates(classId, sourceSlot){
  const slots = tkbAutoRepairSlotsForClass(classId);
  const sourceValue = tkbAutoRepairSlotValue(classId, sourceSlot);
  const movedMon = cellMon(sourceValue);
  if(!movedMon) return [];
  const classCanon = getLopCanonById(classId);
  const moveTask = {
    classId,
    classCanon,
    className: classCanon,
    mon: movedMon,
    remain: 1,
    dragData: {
      type: "cell",
      classId,
      from: tkbAutoRepairSlotStub(sourceSlot),
      val: sourceValue,
      mon: movedMon
    }
  };
  return slots
    .filter(slot => tkbAutoRepairIsBlankSlot(classId, slot))
    .filter(slot => tkbAutoRepairValidateAtSlot(moveTask, slot))
    .map(slot => ({
      slot,
      moveTask,
      sourceValue,
      movedMon,
      score: tkbAutoRepairSlotScore(moveTask, slot)
    }))
    .sort((a,b)=>Number(b.score || 0) - Number(a.score || 0));
}

function tkbAutoRepairTryConflictMove(task){
  const classId = task?.classId;
  const tkb = DATA?.tkb?.[classId];
  if(!tkb) return null;
  const slots = tkbAutoRepairSlotsForClass(classId).filter(slot => tkbAutoRepairIsBlankSlot(classId, slot));
  const attempts = [];

  for(const slot of slots){
    const res = tkbAutoRepairValidateResultAtSlot(task, slot);
    if(!res || !res.ok || !res.warn || !Array.isArray(res.conflicts) || !res.conflicts.length) continue;
    const conflictMap = new Map();
    res.conflicts.forEach(c=>{
      const otherClassId = String(c?.lopId || "");
      if(!otherClassId || otherClassId === String(classId)) return;
      const otherSlot = {classId: otherClassId, thu: c.thu || slot.thu, buoi: c.buoi || slot.buoi, ti: Number(c.ti)};
      if(!Number.isFinite(otherSlot.ti)) return;
      if(!tkbAutoRepairIsMovableLesson(otherClassId, otherSlot)) return;
      const key = `${otherClassId}|${otherSlot.thu}|${otherSlot.buoi}|${otherSlot.ti}`;
      if(!conflictMap.has(key)) conflictMap.set(key, otherSlot);
    });
    if(!conflictMap.size) continue;
    attempts.push({
      slot,
      conflicts: Array.from(conflictMap.values()),
      score: tkbAutoRepairSlotScore(task, slot) - conflictMap.size
    });
  }
  attempts.sort((a,b)=>Number(b.score || 0) - Number(a.score || 0));

  for(const attempt of attempts){
    const originals = [];
    const moves = [];
    let ok = true;

    const remember = (slot)=>{
      originals.push({
        slot: {...slot},
        value: tkbAutoRepairSlotValue(slot.classId, slot)
      });
    };

    try{
      for(const conflictSlot of attempt.conflicts){
        const candidates = tkbAutoRepairConflictMoveCandidates(conflictSlot.classId, conflictSlot);
        const target = candidates.find(item => !moves.some(move =>
          String(move.to.classId) === String(item.slot.classId)
          && String(move.to.thu) === String(item.slot.thu)
          && String(move.to.buoi) === String(item.slot.buoi)
          && Number(move.to.ti) === Number(item.slot.ti)
        ));
        if(!target){
          ok = false;
          break;
        }
        remember(conflictSlot);
        remember(target.slot);
        DATA.tkb[conflictSlot.classId][conflictSlot.thu][conflictSlot.buoi][conflictSlot.ti] = "";
        DATA.tkb[target.slot.classId][target.slot.thu][target.slot.buoi][target.slot.ti] = target.sourceValue;
        moves.push({
          classId: conflictSlot.classId,
          mon: target.movedMon,
          from: {thu: conflictSlot.thu, buoi: conflictSlot.buoi, ti: conflictSlot.ti},
          to: {classId: target.slot.classId, thu: target.slot.thu, buoi: target.slot.buoi, ti: target.slot.ti}
        });
      }

      if(ok && tkbAutoRepairValidateAtSlot(task, attempt.slot)){
        tkb[attempt.slot.thu][attempt.slot.buoi][attempt.slot.ti] = task.mon;
        return {
          classId,
          className: task.className,
          mon: task.mon,
          placed: true,
          method: "conflict_move",
          thu: attempt.slot.thu,
          buoi: attempt.slot.buoi,
          ti: attempt.slot.ti,
          moves
        };
      }
    }finally{
      if(!ok || !tkbAutoRepairSlotValue(classId, attempt.slot)){
        originals.reverse().forEach(item=>{
          const dest = DATA?.tkb?.[item.slot.classId]?.[item.slot.thu]?.[item.slot.buoi];
          if(dest) dest[item.slot.ti] = item.value;
        });
      }
    }
  }
  return null;
}

function tkbAutoPlaceUnassignedLessons(options={}){
  const maxPlace = Math.max(0, Math.round(Number(options.maxPlace ?? 24) || 0));
  const onlyClassId = options.onlyClassId != null ? String(options.onlyClassId || "") : "";
  const details = [];
  let placed = 0;

  while(placed < maxPlace){
    const tasks = collectUnassignedTasks(onlyClassId ? {onlyClassId} : {});
    if(!tasks.length) break;
    let didPlace = false;
    for(const task of tasks){
      if(placed >= maxPlace) break;
      const slot = tkbAutoRepairFindSlot(task);
      if(!slot){
        const moved = tkbAutoRepairTryOneMove(task);
        if(moved){
          placed++;
          didPlace = true;
          details.push(moved);
          break;
        }
        const conflictMoved = tkbAutoRepairTryConflictMove(task);
        if(conflictMoved){
          placed++;
          didPlace = true;
          details.push(conflictMoved);
          break;
        }
        details.push({classId: task.classId, className: task.className, mon: task.mon, placed:false});
        continue;
      }
      const tkb = DATA?.tkb?.[task.classId];
      if(!tkb?.[slot.thu]?.[slot.buoi]) continue;
      tkb[slot.thu][slot.buoi][slot.ti] = task.mon;
      placed++;
      didPlace = true;
      details.push({classId: task.classId, className: task.className, mon: task.mon, thu: slot.thu, buoi: slot.buoi, ti: slot.ti, placed:true});
      break;
    }
    if(!didPlace) break;
  }

  if(placed > 0){
    try{ saveStore({force:true}); }catch(e){ console.error("saveStore failed", e); }
    if(options.render !== false){
      try{ renderCurrentView(); }catch(e){ console.error("renderCurrentView failed", e); }
      try{ loadMonList(); }catch(e){ console.error("loadMonList failed", e); }
      try{ renderStatsBox(); }catch(_){ }
      try{ applyCellSelectionStyles(); }catch(_){ }
    }
  }

  const remainingTasks = collectUnassignedTasks(onlyClassId ? {onlyClassId} : {});
  const remaining = remainingTasks.reduce((sum, item)=>sum + Math.max(0, Number(item.remain || 0) || 0), 0);
  let studentGaps = null;
  try{
    const gaps = calcStudentTimetableGapStats();
    studentGaps = Number(gaps?.totalGaps || 0) || 0;
  }catch(_){}
  return {placed, remaining, studentGaps, details};
}

try{ window.__tkbAutoPlaceUnassignedLessons = tkbAutoPlaceUnassignedLessons; }catch(_){}

function countMon(mon){
  return countMonInTKB(DATA.tkb[currentLop], mon);
}

function calcClassTKBPeriodStats(classId){
  const id = (classId || "").toString();
  if(!id) return {total:0, assigned:0, missing:0};

  const lop = (DATA.lop||[]).find(x=>String(x.id) === id);
  const tkb = DATA.tkb?.[id];
  const tkbMonCounts = buildTkbMonCountMap(tkb);
  const mons = requiredSubjectsForClass(lop || {id});

  let total = 0;
  let assigned = 0;
  for(const m of mons){
    const monName = (m?.mon || m?.ten || "").toString().trim();
    const req = Number(m?.required ?? m?.sotiet ?? 0);
    if(!monName || !Number.isFinite(req) || req <= 0) continue;
    const used = countMonFromTkbCountMap(tkbMonCounts, monName);
    total += req;
    assigned += Math.min(req, Math.max(0, used));
  }

  if(total <= 0 && tkb){
    for(const d of DAYS){
      for(const buoi of ["sang","chieu"]){
        (tkb?.[d]?.[buoi] || []).forEach(v=>{
          if(v && v !== "OFF" && cellMon(v)) assigned++;
        });
      }
    }
  }

  return {
    total,
    assigned,
    missing: Math.max(0, total - assigned)
  };
}

/* ======================= CHƯA PHÂN =======================
   - Hiển thị dạng: Lớp - Môn - GV
   - Sắp xếp theo lớp, sau đó theo môn
   - Khi còn_lại = 0 thì không hiển thị
============================================================== */
function goToUnassignedItem(classId, gvCode){
  const id = (classId || "").toString();
  const gv = (typeof resolveTeacherCode === "function")
    ? resolveTeacherCode(gvCode)
    : (gvCode || "").toString().trim();
  if(!id) return;
  if(VIEW_MODE !== "lop") setViewMode("lop");
  if(gv) currentGV = gv;
  selectLop(id);
  if(gv && typeof window.pairSelectTeacher === "function"){
    try{ window.pairSelectTeacher(gv); }catch(_){ }
  }
}

function unassignedDropdownHTML(){
  return `<div id="unassignedBar" class="unassigned-dropdown" aria-label="Chưa phân">
    <button id="unassignedToggle" class="unassigned-dropdown-btn" type="button" onclick="toggleUnassignedDropdown(event)" aria-expanded="false">
      <span id="unassignedSummary">Chưa phân:0</span>
      <span class="unassigned-caret">v</span>
    </button>
    <div id="monList" class="unassigned-menu" hidden></div>
  </div>`;
}

function setUnassignedDropdownOpen(open){
  const root = document.getElementById("unassignedBar");
  const btn = document.getElementById("unassignedToggle");
  const menu = document.getElementById("monList");
  if(!root || !btn || !menu) return;
  const shouldOpen = !!open && !btn.disabled;
  root.classList.toggle("is-open", shouldOpen);
  menu.hidden = !shouldOpen;
  btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

function closeUnassignedDropdown(){
  setUnassignedDropdownOpen(false);
}

function toggleUnassignedDropdown(ev){
  try{ ev?.preventDefault(); ev?.stopPropagation(); }catch(_){ }
  const root = document.getElementById("unassignedBar");
  const menu = document.getElementById("monList");
  if(!root || !menu) return;
  setUnassignedDropdownOpen(menu.hidden);
}

function currentClassUnassignedFallback(){
  const id = String(currentLop || "");
  if(!id || typeof calcClassTKBPeriodStats !== "function") return 0;
  try{
    const st = calcClassTKBPeriodStats(id) || {};
    const explicitMissing = Number(st.missing);
    if(Number.isFinite(explicitMissing) && explicitMissing > 0) return Math.round(explicitMissing);
    const total = Number(st.total || 0);
    const assigned = Number(st.assigned || 0);
    if(Number.isFinite(total) && Number.isFinite(assigned)) return Math.max(0, Math.round(total - assigned));
  }catch(_){ }
  return 0;
}

function updateUnassignedSummary(grouped, totalRemain){
  const summary = document.getElementById("unassignedSummary");
  const btn = document.getElementById("unassignedToggle");
  if(!summary || !btn) return;
  const fallback = currentClassUnassignedFallback();
  const cur = String(currentLop || "");
  const currentGroup = cur ? grouped?.get?.(cur) : null;
  const total = Math.max(0, Number(totalRemain || 0), fallback);
  const currentRemain = cur
    ? (currentGroup ? Math.max(0, Number(currentGroup.totalRemain || 0), fallback) : fallback)
    : total;
  summary.textContent = `Chưa phân:${currentRemain}`;
  btn.disabled = currentRemain <= 0;
  if(btn.disabled) setUnassignedDropdownOpen(false);
}

if(!window.__TKB_UNASSIGNED_DROPDOWN_BOUND){
  window.__TKB_UNASSIGNED_DROPDOWN_BOUND = true;
  document.addEventListener("pointerdown", ev=>{
    if(ev.target?.closest?.("#unassignedBar")) return;
    closeUnassignedDropdown();
  }, true);
}

function loadMonList(){
  if(TKB_LOAD_MON_LIST_TIMER){
    try{ clearTimeout(TKB_LOAD_MON_LIST_TIMER); }catch(_){}
    TKB_LOAD_MON_LIST_TIMER = 0;
  }
  const now = Date.now();
  const elapsed = now - TKB_LOAD_MON_LIST_LAST_AT;
  if(elapsed < 80){
    TKB_LOAD_MON_LIST_TIMER = setTimeout(()=>{
      TKB_LOAD_MON_LIST_TIMER = 0;
      loadMonList();
    }, Math.max(20, 85 - elapsed));
    return;
  }
  TKB_LOAD_MON_LIST_LAST_AT = now;
  const box = document.getElementById("monList");
  if(!box){
    renderStatsBox();
    return;
  }
  box.innerHTML = "";


  const otherBox = document.getElementById("monListOther");
  if(otherBox) otherBox.innerHTML = "";

  // Theo yêu cầu:
  // - Danh sách "Chưa phân" chỉ hiển thị cho LỚP đang chọn (không hiển thị dạng mờ cho lớp khác)
  // - Không hiển thị các môn chưa phân công giáo viên
  if(false && (VIEW_MODE !== "lop" || !currentLop)){
    // vẫn render thống kê (bảng nằm dưới "Chưa phân")
    renderStatsBox();
    return;
  }

  const khoiSel = document.getElementById("chonKhoi")?.value || "";
  const kFilter = extractKhoiNumber(khoiSel);

  const currentClassId = String(currentLop || "");
  const classOrder = new Map();
  (Array.isArray(DATA.lop) ? DATA.lop : []).forEach((lop, index)=>{
    classOrder.set(String(lop?.id || ""), index);
  });
  const taskOptions = (VIEW_MODE === "lop" && currentClassId) ? {onlyClassId: currentClassId} : {};
  let tasksUniq = collectUnassignedTasks(taskOptions).slice().sort((a,b)=>{
    const ac = String(a.classId || "");
    const bc = String(b.classId || "");
    if(currentClassId && ac !== bc){
      if(ac === currentClassId) return -1;
      if(bc === currentClassId) return 1;
    }
    const ai = classOrder.has(ac) ? classOrder.get(ac) : 999999;
    const bi = classOrder.has(bc) ? classOrder.get(bc) : 999999;
    if(ai !== bi) return ai - bi;
    const m = compareMonByHiddenCode(a.mon,b.mon);
    if(m) return m;
    return Number(b.remain || 0) - Number(a.remain || 0);
  });

  if(false){
  const onlyClassId = String(currentLop || "");
  const lops = Array.isArray(DATA.lop)
    ? DATA.lop.filter(l => String(l.id) === onlyClassId)
    : [];

  let tasks = [];
  lops.forEach(l=>{
    const classId = l.id;
    const classCanon = getLopCanonById(classId);
    if(!classCanon) return;

    // (Không bắt buộc, nhưng giữ hành vi lọc khối theo combobox)
    const khoiNum = extractKhoiNumber(l?.khoi) || extractKhoiNumber(l?.ten2) || extractKhoiNumber(l?.ten) || "";
    if(false && kFilter && String(khoiNum) !== String(kFilter)) return;

    const tkb = DATA.tkb?.[classId];
    const tkbMonCounts = buildTkbMonCountMap(tkb);

    const subjects = computeMonsForClass(khoiNum, classCanon) || [];
    // Override theo bảng phân công (nếu có)
    subjects.forEach(s=>{
      const t = getSoTietForClassMon(classCanon, s.ten);
      const g = getGioiHanForClassMon(classCanon, s.ten);
      if(t > 0) s.sotiet = t;
      if(g > 0) s.gioihan = g;
    });

    const countAssigned = (monName)=>countMonFromTkbCountMap(tkbMonCounts, monName);

    subjects.forEach(s=>{
      const gv = getTeacherForClassMon(classCanon, s.ten);
      if(!gv) return; // <-- môn chưa có giáo viên => không hiển thị trong "Chưa phân"

      const used = countAssigned(s.ten);
      const remain = Math.max(0, Number(s.sotiet||0) - used);
      if(remain <= 0) return;

      tasks.push({
        classId,
        classCanon,
        className: classCanonFromLop(l),
        mon: s.ten,
        remain,
        gv,
        room: getRoomForClassMon(classCanon, s.ten) || ""
      });
    });
  });

  // gộp theo môn (trong 1 lớp chỉ là an toàn)
  const map = new Map(); // key: classId|mon
  tasks.forEach(t=>{
    const k = `${t.classId}|${t.mon}`;
    if(!map.has(k)) map.set(k, {...t});
    else map.get(k).remain += Number(t.remain||0);
  });
  const tasksUniq = Array.from(map.values()).sort((a,b)=>{
    const c = (a.className||"").localeCompare((b.className||""),'vi');
    if(c) return c;
    const m = compareMonByHiddenCode(a.mon,b.mon);
    if(m) return m;
    return 0;
  });

  if(!tasksUniq.length){
    box.innerHTML = `<div style="color:#999;font-size:12px;padding:6px 4px;">Không có tiết chưa xếp.</div>`;
  }

  }

  const grouped = new Map();
  tasksUniq.forEach(t=>{
    const key = String(t.classId);
    if(!grouped.has(key)){
      grouped.set(key, {
        classId: key,
        className: t.className || key,
        totalRemain: 0,
        items: []
      });
    }
    const g = grouped.get(key);
    g.totalRemain += Number(t.remain || 0);
    g.items.push(t);
  });

  if(grouped.size){
    if(!TKB_UNASSIGNED_OPEN_CLASS || !grouped.has(String(TKB_UNASSIGNED_OPEN_CLASS))){
      const cur = String(currentLop || "");
      TKB_UNASSIGNED_OPEN_CLASS = grouped.has(cur) ? cur : grouped.keys().next().value;
    }
  }

  updateUnassignedSummary(grouped, tasksUniq.reduce((sum,t)=>sum + Number(t.remain || 0), 0));

  if(!grouped.size){
    const fallbackRemain = currentClassUnassignedFallback();
    if(fallbackRemain > 0){
      const empty = document.createElement("div");
      empty.style.cssText = "color:#667085;font-size:12px;padding:8px 10px;line-height:1.35;";
      empty.textContent = `Có ${fallbackRemain} tiết chưa xếp.`;
      box.appendChild(empty);
    }
  }

  grouped.forEach(group=>{
    const groupEl = document.createElement("div");
    groupEl.className = "unassigned-group";
    groupEl.dataset.classid = group.classId;
    const isOpen = String(TKB_UNASSIGNED_OPEN_CLASS || "") === String(group.classId);
    groupEl.classList.toggle("is-open", isOpen);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "unassigned-class-toggle";
    header.innerHTML =
      `<span class="unassigned-arrow">${isOpen ? "v" : ">"}</span>`+
      `<span class="unassigned-class-name">${escapeHtml(group.className)}</span>`+
      `<span class="unassigned-count">${Number(group.totalRemain || 0)} tiết</span>`;
    header.onclick = (ev)=>{
      try{ ev.preventDefault(); ev.stopPropagation(); }catch(_){ }
      const openNow = String(TKB_UNASSIGNED_OPEN_CLASS || "") === String(group.classId);
      TKB_UNASSIGNED_OPEN_CLASS = openNow ? "" : group.classId;
      box.querySelectorAll(".unassigned-group").forEach(el=>{
        const isTarget = String(el.dataset.classid || "") === String(group.classId);
        const shouldOpen = isTarget && !openNow;
        el.classList.toggle("is-open", shouldOpen);
        const arrow = el.querySelector(".unassigned-arrow");
        if(arrow) arrow.textContent = shouldOpen ? "v" : ">";
        const childList = el.querySelector(".unassigned-list");
        if(childList) childList.hidden = !shouldOpen;
      });
    };

    const list = document.createElement("div");
    list.className = "unassigned-list";
    list.hidden = !isOpen;

    group.items.forEach(t=>{
      const d = document.createElement("div");
      d.className = "mon-item";
      d.dataset.mon = t.mon;
      d.dataset.classid = String(t.classId);

      const monShort = getMonShort(t.mon);
      const gvTxt = (t.gv||"").toString().trim();
      const roomTxt = (t.room||"").toString().trim();
      const roomDisp = roomTxt ? ` (${roomTxt})` : "";
      const remainDisp = Number(t.remain || 0) > 1 ? ` x${Number(t.remain || 0)}` : "";
      const gvPart = gvTxt ? ` - ${escapeHtml(gvTxt)}` : "";

      d.innerHTML = `<span class="mon-item-main">${escapeHtml(monShort)}${gvPart}${escapeHtml(remainDisp)}</span>`+
                    `<span class="mon-item-meta">${escapeHtml(roomDisp)}</span>`;
      d.onclick = ()=>{
        if(tryApplyFixedLessonFromUnassigned(t)) return;
        closeUnassignedDropdown();
        goToUnassignedItem(t.classId, gvTxt);
      };
      d.draggable = (VIEW_MODE === "lop" && String(currentLop || "") === String(t.classId));
      d.ondragstart = (e)=>{
        dragMon = t.mon;
        dragData = { type:"mon", classId: t.classId, mon: t.mon };
        setNativeDragTransfer(e, t.mon);
        applyDragVisual(dragMon, null);
        try{ _setStatus("", "info"); }catch(_){ }
      };
      d.ondragend = ()=>{
        clearDragVisual();
        dragData = null;
        dragMon = "";
      };

      list.appendChild(d);
    });

    groupEl.appendChild(header);
    groupEl.appendChild(list);
    box.appendChild(groupEl);
  });

  // The full-school teacher statistics live inside a popover and can be
  // expensive on a large timetable. Opening the popover renders on demand.
  const statsPopover = document.getElementById("statsPopover");
  if(statsPopover && !statsPopover.hidden) renderStatsBox();
}


/* ======================= CHƯA PHÂN – CÁC LỚP KHÁC =======================
   - Hiển thị danh sách Chưa phân của các lớp KHÁC lớp đang chọn
   - Click để nhảy sang lớp đó (tiện bổ sung lại)
============================================================================= */
function renderOtherUnassignedList(kFilter){
  const otherBox = document.getElementById("monListOther");
  if(!otherBox) return;

  otherBox.innerHTML = "";

  if(VIEW_MODE !== "lop" || !currentLop){
    otherBox.innerHTML = `<div style="color:#999;font-size:12px;padding:6px 4px;">Chọn một lớp để xem.</div>`;
    return;
  }

  const curId = String(currentLop);
  const lopsAll = getFilteredLops().filter(l => String(l.id) !== curId);

  let tasks = [];

  lopsAll.forEach(l=>{
    const classId = l.id;
    const classCanon = getLopCanonById(classId);
    if(!classCanon) return;

    const khoiNum = extractKhoiNumber(l?.khoi) || extractKhoiNumber(l?.ten2) || extractKhoiNumber(l?.ten) || "";
    if(kFilter && String(khoiNum) !== String(kFilter)) return;

    const tkb = DATA.tkb?.[classId];
    const tkbMonCounts = buildTkbMonCountMap(tkb);

    const subjects = computeMonsForClass(khoiNum, classCanon) || [];

    // Override theo bảng phân công (nếu có)
    subjects.forEach(s=>{
      const t = getSoTietForClassMon(classCanon, s.ten);
      const g = getGioiHanForClassMon(classCanon, s.ten);
      if(t > 0) s.sotiet = t;
      if(g > 0) s.gioihan = g;
    });

    const countAssigned = (monName)=>countMonFromTkbCountMap(tkbMonCounts, monName);

    const className = classCanonFromLop(l);

    subjects.forEach(s=>{
      const gv = getTeacherForClassMon(classCanon, s.ten);
      if(!gv) return; // giữ cùng hành vi: không hiển thị môn chưa có GV

      const used = countAssigned(s.ten);
      const remain = Math.max(0, Number(s.sotiet||0) - used);
      if(remain <= 0) return;

      tasks.push({
        classId,
        classCanon,
        className,
        mon: s.ten,
        remain,
        gv,
        room: getRoomForClassMon(classCanon, s.ten) || ""
      });
    });
  });

  // gộp theo lớp|môn
  const map = new Map();
  tasks.forEach(t=>{
    const k = `${t.classId}|${t.mon}`;
    if(!map.has(k)) map.set(k, {...t});
    else map.get(k).remain += Number(t.remain||0);
  });

  const list = Array.from(map.values()).sort((a,b)=>{
    const c = (a.className||"").localeCompare((b.className||""),'vi');
    if(c) return c;
    const m = compareMonByHiddenCode(a.mon,b.mon);
    if(m) return m;
    // remain desc
    return (Number(b.remain||0) - Number(a.remain||0));
  });

  if(list.length === 0){
    otherBox.innerHTML = `<div style="color:#999;font-size:12px;padding:6px 4px;">Không có.</div>`;
    return;
  }

  const MAX_SHOW = 140;
  const show = list.slice(0, MAX_SHOW);

  show.forEach(t=>{
    const d = document.createElement("div");
    d.className = "mon-item mon-other";
    d.dataset.classid = String(t.classId);

    const monShort = getMonShort(t.mon);
    const gvTxt = (t.gv||"").toString().trim();
    const roomTxt = (t.room||"").toString().trim();
    const roomDisp = roomTxt ? ` (${roomTxt})` : "";
    const gvPart = gvTxt ? ` - ${escapeHtml(gvTxt)}` : "";

    d.innerHTML =
      `<span class="mon-item-main">${escapeHtml(t.className)} - ${escapeHtml(monShort)}${gvPart}</span>`+
      `<span class="mon-item-meta">${escapeHtml(roomDisp)}</span>`;

    d.onclick = ()=>goToUnassignedItem(t.classId, gvTxt);

    otherBox.appendChild(d);
  });

  if(list.length > MAX_SHOW){
    const more = document.createElement("div");
    more.style.cssText = "color:#999;font-size:12px;padding:6px 4px;";
    more.textContent = `… còn ${list.length - MAX_SHOW} mục khác`;
    otherBox.appendChild(more);
  }
}


/* ======================= THỐNG KÊ BÊN PHẢI =======================
   - Hiển thị dưới "Chưa phân"
   - Nội dung theo mẫu người dùng cung cấp
============================================================== */

function calcStudentTimetableGapStats(){
  let totalGaps = 0;
  const byClass = [];
  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];

  const isStudentGapSlot = (v)=>{
    if(v === "OFF") return false;
    return !cellMon(v);
  };

  for(const lop of lops){
    const classId = lop?.id;
    const tkb = DATA.tkb?.[classId];
    if(!tkb) continue;
    let classGaps = 0;
    const sessions = [];

    for(const thu of DAYS){
      for(const buoi of ["sang","chieu"]){
        const arr = tkb?.[thu]?.[buoi] || [];
        const limit = buoi === "sang" ? SANG : CHIEU;
        for(let i=0; i<limit; i++){
          if(isStudentGapSlot(arr[i])){
            classGaps++;
            sessions.push({thu, buoi, ti:i});
          }
        }
      }
    }

    if(classGaps > 0){
      byClass.push({
        id: classId,
        name: (lop?.ten || lop?.ten2 || classId || "").toString().trim(),
        gaps: classGaps,
        sessions
      });
      totalGaps += classGaps;
    }
  }

  byClass.sort((a,b)=>Number(b.gaps||0)-Number(a.gaps||0) || String(a.name||"").localeCompare(String(b.name||""), "vi"));
  return {totalGaps, byClass};
}

function classTeacherCodesForStudentGap(classId){
  const id = (classId || "").toString();
  if(!id) return [];
  const set = new Set();
  const add = (code)=>{
    const c = (code || "").toString().trim();
    if(c) set.add(c);
  };
  const lop = (DATA.lop || []).find(x => String(x.id) === id);
  const canon = getLopCanonById(id);
  const khoiNum = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "";
  (computeMonsForClass(khoiNum, canon) || []).forEach(m=>{
    const mon = (m?.ten || "").toString().trim();
    if(mon) teacherListFromValue(getTeacherForClassMon(canon, mon)).forEach(add);
  });
  const tkb = DATA.tkb?.[id];
  if(tkb){
    for(const thu of DAYS){
      for(const buoi of ["sang","chieu"]){
        const arr = tkb?.[thu]?.[buoi] || [];
        for(const cell of arr){
          if(!cell || cell === "OFF") continue;
          const mon = cellMon(cell);
          if(mon) teacherListFromValue(getTeacherForClassMon(canon, mon)).forEach(add);
        }
      }
    }
  }
  return Array.from(set);
}

function studentGapTeacherFreeAtSlot(gvCode, slot, cache){
  const code = (gvCode || "").toString().trim();
  const thu = slot?.thu;
  const buoi = slot?.buoi;
  const ti = Number(slot?.ti);
  if(!code || !DAYS.includes(thu) || !["sang","chieu"].includes(buoi) || !Number.isFinite(ti)) return false;
  const key = `${code}|${thu}|${buoi}|${ti}`;
  if(cache && cache.has(key)) return cache.get(key);
  let free = true;
  try{
    if(isTeacherFixedOff(code, thu, buoi, ti)) free = false;
    else {
      const sched = buildTeacherSchedule(code);
      const entries = sched?.[thu]?.[buoi]?.[ti];
      free = !Array.isArray(entries) || entries.length === 0;
    }
  }catch(_){
    free = false;
  }
  if(cache) cache.set(key, free);
  return free;
}

function inferTeacherForStudentGapSlot(classId, slot, cache){
  const id = (classId || "").toString();
  const teachers = classTeacherCodesForStudentGap(id);
  if(!teachers.length) return "";
  const freeTeachers = teachers.filter(code => studentGapTeacherFreeAtSlot(code, slot, cache));
  const freeSet = new Set(freeTeachers);
  const current = (currentGV || "").toString().trim();
  if(current && freeSet.has(current)) return current;

  const canon = getLopCanonById(id);
  const tkb = DATA.tkb?.[id];
  const arr = tkb?.[slot?.thu]?.[slot?.buoi] || [];
  const ti = Number(slot?.ti);
  if(Number.isFinite(ti)){
    for(const delta of [-1, 1, -2, 2]){
      const cell = arr[ti + delta];
      const mon = cellMon(cell);
      if(!mon) continue;
      const gv = getTeacherForClassMon(canon, mon);
      if(freeSet.has(gv)) return gv;
    }
  }

  const lop = (DATA.lop || []).find(x => String(x.id) === id);
  const khoiNum = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "";
  const tkbMonCounts = buildTkbMonCountMap(tkb);
  for(const m of (computeMonsForClass(khoiNum, canon) || [])){
    const mon = (m?.ten || "").toString().trim();
    const req = Number(m?.sotiet || 0);
    if(!mon || !(req > 0)) continue;
    const used = countMonFromTkbCountMap(tkbMonCounts, mon);
    if(used >= req) continue;
    const gv = getTeacherForClassMon(canon, mon);
    if(freeSet.has(gv)) return gv;
  }

  if(freeTeachers.length) return freeTeachers[0];
  if(current && teachers.includes(current)) return current;
  return teachers[0] || "";
}

function studentGapTargetsFromIssues(issues){
  const out = [];
  (Array.isArray(issues) ? issues : []).forEach((issue, issueIndex)=>{
    (Array.isArray(issue?.sessions) ? issue.sessions : []).forEach((slot, slotIndex)=>{
      out.push({
        issueIndex,
        slotIndex,
        classId: issue.id,
        name: issue.name || issue.id,
        thu: slot.thu,
        buoi: slot.buoi,
        ti: Number(slot.ti)
      });
    });
  });
  return out.filter(t => t.classId && DAYS.includes(t.thu) && ["sang","chieu"].includes(t.buoi) && Number.isFinite(t.ti));
}

function studentGapTargetKey(target){
  if(!target) return "";
  return `${target.classId}|${target.thu}|${target.buoi}|${Number(target.ti)}`;
}

function renderStatsBox(){
  const box = document.getElementById("statsBox");
  if(!box) return;
  const isSolving = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
  box.classList.toggle("is-solving", isSolving);

  const school = calcSchoolTKBStats();
  const gvStats = calcTeacherTKBStats();
  const studentGapStats = calcStudentTimetableGapStats();
  const unassignedIssues = getUnassignedIssuesFromStats();
  window.__TKB_UNASSIGNED_STAT_ISSUES = unassignedIssues;
  window.__TKB_STUDENT_GAP_ISSUES = Array.isArray(studentGapStats.byClass) ? studentGapStats.byClass : [];
  const onePeriodTeachers = Array.isArray(gvStats.onePeriodTeachers) ? gvStats.onePeriodTeachers : [];
  window.__TKB_ONE_PERIOD_TEACHER_ISSUES = onePeriodTeachers;
  window.__TKB_TEACHER_STAT_ISSUES = {
    gapAll: Array.isArray(gvStats.gapTeachers) ? gvStats.gapTeachers : [],
    gap1: Array.isArray(gvStats.gap1Teachers) ? gvStats.gap1Teachers : [],
    gap2: Array.isArray(gvStats.gap2Teachers) ? gvStats.gap2Teachers : [],
    onePeriod: onePeriodTeachers
  };
  const onePeriodTeacherTitle = onePeriodTeachers.length
    ? "Bấm để xem giáo viên ở bảng dưới.\n" + onePeriodTeachers.map(t => `${t.code}: ${t.sessions.length}`).join("\n")
    : "Không có giáo viên dạy 1 tiết trong 1 buổi.";

  // helper in HTML
  const n = (v)=>{
    const num = Number(v||0);
    if(!Number.isFinite(num)) return "0";
    return String(Math.round(num));
  };
  const stat = (label, value)=>(
    `<div class="stats-pair"><span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${escapeHtml(value)}</span></div>`
  );

  box.innerHTML =
    `<div class="stats-grid-2 stats-note-grid stats-teacher-grid">`+
      stat("Đã xếp", school.daXepTiet)+
      stat("Chưa xếp", school.chuaXepTiet)+
      stat("Tiết trống", gvStats.soTietTrong)+
      stat("Buổi dạy", gvStats.tsBuoiDay)+
      stat("Trống 1 tiết", gvStats.soBuoiTrong1)+
      stat("Ngày dạy", gvStats.tsNgayDay)+
      stat("Trống 2 tiết", gvStats.soBuoiTrong2)+
      stat("Dạy 1 tiết", gvStats.soBuoiDay1)+
      stat("Lỗ trống HS", studentGapStats.totalGaps)+
      stat("Dạy 5 tiết", gvStats.soBuoiDay5)+
    `</div>`;

  const teacherGrid = box.querySelector(".stats-teacher-grid");
  const teacherCells = teacherGrid ? Array.from(teacherGrid.children) : [];
  const drillButton = (type, label, count, issues)=>{
    const safeIssues = Array.isArray(issues) ? issues : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stats-pair stats-link stats-link-drilldown stats-teacher-drilldown";
    btn.disabled = safeIssues.length === 0;
    btn.innerHTML = `<span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${n(count)}</span>`;
    btn.title = safeIssues.length
      ? `Bấm để xem giáo viên liên quan.\n${safeIssues.map(t => `${t.code}: ${teacherStatIssueCount(t)}`).join("\n")}`
      : "Không có giáo viên liên quan.";
    btn.onclick = () => goToTeacherStatIssues(type);
    return btn;
  };
  const studentGapButton = (label, count, issues)=>{
    const safeIssues = Array.isArray(issues) ? issues : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stats-pair stats-link stats-link-drilldown stats-student-gap-drilldown";
    btn.disabled = safeIssues.length === 0;
    btn.innerHTML = `<span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${n(count)}</span>`;
    btn.title = safeIssues.length
      ? safeIssues.map(t => `${t.name || t.id}: ${n(t.gaps)}`).join("\n")
      : "";
    btn.onclick = () => goToStudentGapIssues();
    return btn;
  };
  const unassignedButton = (label, count, issues)=>{
    const safeIssues = Array.isArray(issues) ? issues : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stats-pair stats-link stats-link-drilldown stats-unassigned-drilldown";
    btn.disabled = safeIssues.length === 0 || Number(count || 0) <= 0;
    btn.innerHTML = `<span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${n(count)}</span>`;
    btn.title = safeIssues.length
      ? safeIssues.map(t => `${t.className || t.classId} - ${getMonShort(t.mon)}: ${unassignedIssueCount(t)}`).join("\n")
      : "";
    btn.onclick = () => goToUnassignedIssues();
    return btn;
  };
  const replaceStatCell = (index, type, label, count, issues)=>{
    const cell = teacherCells[index];
    if(!cell) return;
    cell.textContent = "";
    cell.appendChild(drillButton(type, label, count, issues));
  };
  const replaceUnassignedCell = (index, count, issues)=>{
    const cell = teacherCells[index];
    if(!cell) return;
    const label = (cell.querySelector(".stats-label")?.textContent || "Tiết chưa xếp").replace(/:\s*$/, "");
    cell.textContent = "";
    cell.appendChild(unassignedButton(label, count, issues));
  };
  const replaceStudentGapCell = (index, count, issues)=>{
    const cell = teacherCells[index];
    if(!cell) return;
    const label = (cell.querySelector(".stats-label")?.textContent || "Lo trong HS").replace(/:\s*$/, "");
    cell.textContent = "";
    cell.appendChild(studentGapButton(label, count, issues));
  };
  replaceUnassignedCell(1, school.chuaXepTiet, unassignedIssues);
  replaceStatCell(2, "gapAll", "Tiết trống", gvStats.soTietTrong, window.__TKB_TEACHER_STAT_ISSUES.gapAll);
  replaceStatCell(4, "gap1", "Trống 1 tiết", gvStats.soBuoiTrong1, window.__TKB_TEACHER_STAT_ISSUES.gap1);
  replaceStatCell(6, "gap2", "Trống 2 tiết", gvStats.soBuoiTrong2, window.__TKB_TEACHER_STAT_ISSUES.gap2);
  replaceStatCell(7, "onePeriod", "Dạy 1 tiết", gvStats.soBuoiDay1, window.__TKB_TEACHER_STAT_ISSUES.onePeriod);
  replaceStudentGapCell(8, studentGapStats.totalGaps, window.__TKB_STUDENT_GAP_ISSUES);
}

let SCHOOL_TKB_STATS_CACHE = {sig:"", value:null};
function schoolStatsObjectSignature(obj){
  if(!obj || typeof obj !== "object") return "";
  return Object.entries(obj).map(([k,v])=>`${k}:${v}`).join("~");
}
function schoolStatsTkbSignature(){
  const parts = [
    Array.isArray(DATA.lop) ? DATA.lop.map(l=>`${l?.id}:${l?.ten}:${l?.ten2}:${l?.khoi}`).join(",") : "",
    schoolStatsObjectSignature(DATA.pccmMatrix),
    schoolStatsObjectSignature(DATA.pccmTietMatrix),
    schoolStatsObjectSignature(DATA.pccmRoomMatrix)
  ];
  const tkbs = DATA.tkb || {};
  Object.keys(tkbs).forEach(classId=>{
    const tkb = tkbs[classId];
    parts.push(`class=${classId}`);
    DAYS.forEach(d=>["sang","chieu"].forEach(b=>{
      const arr = tkb?.[d]?.[b] || [];
      parts.push(`${d}.${b}:${arr.map(v=>`${cellMon(v)}${isFixed(v)?"!":""}${v==="OFF"?"#":""}`).join(",")}`);
    }));
  });
  return parts.join("|");
}

function calcSchoolTKBStats(){
  const cacheSig = schoolStatsTkbSignature();
  if(SCHOOL_TKB_STATS_CACHE.sig === cacheSig && SCHOOL_TKB_STATS_CACHE.value){
    return Object.assign({}, SCHOOL_TKB_STATS_CACHE.value);
  }
  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];
  const tkbs = DATA.tkb || {};

  let soTiet = 0;
  let chuaXepTiet = 0;

  let soLop = lops.length;
  let daXepLop = 0;

  // gom thiếu theo GV (để tính Đã xếp/Chưa xếp giáo viên)
  const teacherMissing = new Map();
  const teacherRequired = new Map();
  const teacherSet = new Set();

  // rooms: tổng từ danh mục phòng nếu có, fallback từ phân công phòng
  const roomList = new Set(
    (Array.isArray(DATA.phong) ? DATA.phong : [])
      .map(p=>String(p?.ten||"").trim())
      .filter(Boolean)
  );
  const roomFromAssign = new Set(
    Object.values(DATA.pccmRoomMatrix||{})
      .map(r=>String(r||"").trim())
      .filter(Boolean)
  );
  const roomAll = (roomList.size ? roomList : roomFromAssign);
  const roomUsed = new Set();

  for(const lop of lops){
    const classId = lop.id;
    const classCanon = getLopCanonById(classId);
    const mons = requiredSubjectsForClass(lop);
    const tkb = tkbs?.[classId];
    const tkbMonCounts = buildTkbMonCountMap(tkb);

    let remainForClass = 0;

    for(const m of mons){
      const monName = (m?.mon || m?.ten || "").toString().trim();
      if(!monName) continue;

      const req = Number(m?.required ?? m?.sotiet ?? 0);
      if(!Number.isFinite(req) || req <= 0) continue;

      const used = countMonFromTkbCountMap(tkbMonCounts, monName);
      const rem = Math.max(0, req - used);

      soTiet += req;
      chuaXepTiet += rem;
      remainForClass += rem;

      const gv = String(m?.gv || getTeacherForClassMon(classCanon, monName) || "").trim();
      if(gv){
        teacherSet.add(gv);
        teacherMissing.set(gv, (teacherMissing.get(gv)||0) + rem);
        teacherRequired.set(gv, (teacherRequired.get(gv)||0) + req);
      }

      const room = m?.room || getRoomForClassMon(classCanon, monName);
      if(room) roomFromAssign.add(room);
    }

    if(remainForClass === 0) daXepLop++;

    // scan phòng đang dùng theo TKB (chỉ để tính Đã xếp/Chưa xếp phòng)
    if(tkb){
      for(const d of DAYS){
        for(const buoi of ["sang","chieu"]){
          const arr = (tkb?.[d]?.[buoi]||[]);
          for(let i=0;i<arr.length;i++){
            const v = arr[i];
            if(!v || v === "OFF") continue;
            const mon = cellMon(v);
            if(!mon) continue;
            const room = getRoomForClassMon(classCanon, mon);
            if(room) roomUsed.add(room);
          }
        }
      }
    }
  }

  // GV: chỉ tính những GV có phân công (teacherSet)
  let soGV = teacherSet.size;
  let daXepGV = 0;
  teacherSet.forEach(code=>{
    const req = teacherRequired.get(code) || 0;
    const miss = teacherMissing.get(code) || 0;
    // chỉ coi là "đã xếp" nếu có yêu cầu và không còn thiếu
    if(req > 0 && miss === 0) daXepGV++;
  });

  // Phòng: tổng từ danh mục hoặc phân công (roomAll)
  const soPhong = roomAll.size;
  let daXepPhong = 0;
  if(soPhong > 0){
    roomAll.forEach(r=>{ if(roomUsed.has(r)) daXepPhong++; });
  }

  const daXepTiet = soTiet - chuaXepTiet;

  const result = {
    soTiet,
    daXepTiet,
    chuaXepTiet,
    soLop,
    daXepLop,
    chuaXepLop: Math.max(0, soLop - daXepLop),
    soGV,
    daXepGV,
    chuaXepGV: Math.max(0, soGV - daXepGV),
    soPhong,
    daXepPhong,
    chuaXepPhong: Math.max(0, soPhong - daXepPhong)
  };
  SCHOOL_TKB_STATS_CACHE = {sig: cacheSig, value: Object.assign({}, result)};
  return result;
}

try{ window.renderStatsBox = renderStatsBox; }catch(_){}
try{ window.calcSchoolTKBStats = calcSchoolTKBStats; }catch(_){}

function _getAssignedTeacherCodes(){
  const set = new Set();
  const classCanonSet = new Set();
  (DATA.lop||[]).forEach(l=>classKeyCandidates(getLopCanonById(l.id)).forEach(k=>classCanonSet.add(k)));
  for(const [k,v] of Object.entries(DATA.pccmMatrix || {})){
    const cls = (k||"").split("|")[0] || "";
    if(cls && classCanonSet.size && !classCanonSet.has(cls)) continue;
    teacherListFromValue(v).forEach(code=>{ if(code) set.add(code); });
  }
  if(set.size) return set;

  // fallback: danh sách GV trong dữ liệu
  (DATA.giaovien||[]).forEach(g=>{
    const c = resolveTeacherCode(g?.magv || g?.ten || "");
    if(c) set.add(c);
  });
  return new Set(Array.from(set).sort(compareTeacherCodeByDataOrder));
}

function getOnePeriodIssueForTeacher(code){
  const key = (code||"").toString().trim();
  if(!key) return null;
  const cached = Array.isArray(window.__TKB_ONE_PERIOD_TEACHER_ISSUES)
    ? window.__TKB_ONE_PERIOD_TEACHER_ISSUES
    : [];
  return cached.find(item => String(item?.code||"").trim() === key) || null;
}

function getOnePeriodIssuesFromStats(){
  const st = calcTeacherTKBStats();
  return Array.isArray(st.onePeriodTeachers) ? st.onePeriodTeachers : [];
}

function getTeacherStatLabel(type){
  switch(String(type || "")){
    case "gapAll": return "Tiết trống";
    case "gap1": return "Trống 1 tiết";
    case "gap2": return "Trống 2 tiết";
    case "onePeriod": return "Dạy 1 tiết";
    default: return "Thống kê giáo viên";
  }
}

function teacherStatIssueCount(item){
  const count = Number(item?.count);
  if(Number.isFinite(count) && count > 0) return Math.round(count);
  return Number(item?.sessions?.length || 0);
}

function getTeacherStatIssuesFromStats(type){
  const st = calcTeacherTKBStats();
  const key = String(type || "onePeriod");
  if(key === "gapAll") return Array.isArray(st.gapTeachers) ? st.gapTeachers : [];
  if(key === "gap1") return Array.isArray(st.gap1Teachers) ? st.gap1Teachers : [];
  if(key === "gap2") return Array.isArray(st.gap2Teachers) ? st.gap2Teachers : [];
  return Array.isArray(st.onePeriodTeachers) ? st.onePeriodTeachers : [];
}

function getStudentGapIssuesFromStats(){
  const st = calcStudentTimetableGapStats();
  return Array.isArray(st.byClass) ? st.byClass : [];
}

function getUnassignedIssuesFromStats(){
  return collectUnassignedTasks();
}

function unassignedIssueCount(item){
  const count = Number(item?.remain ?? item?.count);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function unassignedIssueKey(item){
  if(!item) return "";
  return `${String(item.classId || "")}|${String(item.mon || "")}`;
}

function goToUnassignedIssues(){
  const issues = getUnassignedIssuesFromStats();
  window.__TKB_UNASSIGNED_STAT_ISSUES = issues;
  if(!issues.length){
    try{ _setStatus("Ti\u1ebft ch\u01b0a x\u1ebfp: 0", "ok"); }catch(_){ }
    return;
  }
  const stored = Number(window.__TKB_UNASSIGNED_STAT_INDEX);
  const hasActive = Number.isFinite(stored)
    && stored >= 0
    && stored < issues.length
    && String(issues[stored]?.classId || "") === String(currentLop || "");
  const currentIndex = issues.findIndex(item => String(item?.classId || "") === String(currentLop || ""));
  const nextIndex = hasActive
    ? (stored + 1) % issues.length
    : (currentIndex >= 0 ? currentIndex : 0);
  window.__TKB_UNASSIGNED_STAT_INDEX = nextIndex;
  focusUnassignedIssue(issues[nextIndex]);
}

function focusUnassignedIssue(target){
  if(!target) return;
  const classId = String(target.classId || "");
  if(!classId) return;
  const gv = (typeof resolveTeacherCode === "function")
    ? resolveTeacherCode(target.gv)
    : String(target.gv || "").trim();
  const issues = Array.isArray(window.__TKB_UNASSIGNED_STAT_ISSUES) && window.__TKB_UNASSIGNED_STAT_ISSUES.length
    ? window.__TKB_UNASSIGNED_STAT_ISSUES
    : getUnassignedIssuesFromStats();
  const idx = issues.findIndex(item => unassignedIssueKey(item) === unassignedIssueKey(target));
  if(idx >= 0) window.__TKB_UNASSIGNED_STAT_INDEX = idx;

  if(VIEW_MODE !== "lop") setViewMode("lop");
  const visibleClass = Array.from(document.querySelectorAll("#listLop .lop-item"))
    .some(el => String(el.dataset.id || "") === classId);
  if(!visibleClass) showAllLop();

  TKB_UNASSIGNED_OPEN_CLASS = classId;
  if(gv) currentGV = gv;
  if(String(currentLop || "") !== classId) selectLop(classId);
  else {
    renderCurrentView();
    loadMonList();
  }
  if(gv && typeof window.pairSelectTeacher === "function"){
    try{ window.pairSelectTeacher(gv); }catch(_){ }
  }
  window.setTimeout(()=>highlightUnassignedIssue(target), 0);
}

function highlightUnassignedIssue(target){
  if(!target) return;
  const classId = String(target.classId || "");
  const mon = String(target.mon || "");
  clearScheduleStatHighlights();
  document.querySelectorAll("#monList .tkb-unassigned-focus").forEach(el=>{
    el.classList.remove("tkb-unassigned-focus");
  });
  setUnassignedDropdownOpen(true);
  const item = Array.from(document.querySelectorAll("#monList .mon-item")).find(el =>
    String(el.dataset.classid || "") === classId && String(el.dataset.mon || "") === mon
  );
  if(item){
    item.classList.add("tkb-unassigned-focus");
    try{ item.scrollIntoView({block:"nearest", inline:"nearest"}); }catch(_){ }
  }
  try{
    const monShort = getMonShort(mon);
    const count = unassignedIssueCount(target);
    const name = target.className || classId;
    _setStatus(`Ti\u1ebft ch\u01b0a x\u1ebfp: ${name} - ${monShort}${count > 1 ? ` x${count}` : ""}`, "info");
  }catch(_){ }
}

try{ window.goToUnassignedIssues = goToUnassignedIssues; }catch(_){}

function studentGapIssueCount(item){
  const count = Number(item?.gaps ?? item?.count);
  if(Number.isFinite(count) && count > 0) return Math.round(count);
  return Number(item?.sessions?.length || 0);
}

function getStudentGapStatLabel(){
  const label = document.querySelector(".stats-student-gap-drilldown .stats-label")?.textContent || "";
  return label.replace(/:\s*$/, "") || "Lo trong HS";
}

function clearStudentGapHighlights(){
  document.querySelectorAll("#tkb td.tkb-student-gap-cell").forEach(td=>{
    td.classList.remove("tkb-student-gap-cell");
  });
}

function clearScheduleStatHighlights(){
  document.querySelectorAll("#tkb td.tkb-one-period-session,#tkb td.tkb-one-period-cell,#tkb td.tkb-teacher-gap-session,#tkb td.tkb-teacher-gap-cell,#tkb td.tkb-student-gap-cell").forEach(td=>{
    td.classList.remove("tkb-one-period-session", "tkb-one-period-cell", "tkb-teacher-gap-session", "tkb-teacher-gap-cell", "tkb-student-gap-cell");
  });
}

function goToStudentGapIssues(){
  const issues = getStudentGapIssuesFromStats();
  window.__TKB_STUDENT_GAP_ISSUES = issues;
  if(!issues.length){
    try{ _setStatus(`${getStudentGapStatLabel()}: 0`, "ok"); }catch(_){ }
    return;
  }
  const targets = studentGapTargetsFromIssues(issues);
  if(!targets.length) return;
  const stored = Number(window.__TKB_STUDENT_GAP_TARGET_INDEX);
  const hasActive = Number.isFinite(stored)
    && stored >= 0
    && stored < targets.length
    && String(targets[stored]?.classId || "") === String(currentLop || "");
  const currentIndex = targets.findIndex(item => String(item?.classId || "") === String(currentLop || ""));
  const nextIndex = hasActive
    ? (stored + 1) % targets.length
    : (currentIndex >= 0 ? currentIndex : 0);
  window.__TKB_STUDENT_GAP_TARGET_INDEX = nextIndex;
  focusStudentGapTarget(targets[nextIndex]);
}

function focusStudentGapIssue(classId){
  const issues = Array.isArray(window.__TKB_STUDENT_GAP_ISSUES) && window.__TKB_STUDENT_GAP_ISSUES.length
    ? window.__TKB_STUDENT_GAP_ISSUES
    : getStudentGapIssuesFromStats();
  window.__TKB_STUDENT_GAP_ISSUES = issues;
  const found = issues.findIndex(item => String(item?.id || "") === String(classId || ""));
  const idx = found >= 0 ? found : 0;
  const target = issues[idx];
  if(!target) return;
  const firstSlot = studentGapTargetsFromIssues([target])[0];
  if(firstSlot){
    firstSlot.issueIndex = idx;
    return focusStudentGapTarget(firstSlot);
  }
  window.__TKB_STUDENT_GAP_INDEX = idx;
  if(VIEW_MODE !== "lop") setViewMode("lop");
  if(target.id && String(currentLop || "") !== String(target.id)){
    selectLop(target.id);
  }else if(currentLop){
    renderCurrentView();
  }
  window.setTimeout(()=>highlightStudentGapIssue(target.id), 0);
}

function focusStudentGapTarget(target){
  if(!target) return;
  const issues = Array.isArray(window.__TKB_STUDENT_GAP_ISSUES) && window.__TKB_STUDENT_GAP_ISSUES.length
    ? window.__TKB_STUDENT_GAP_ISSUES
    : getStudentGapIssuesFromStats();
  window.__TKB_STUDENT_GAP_ISSUES = issues;
  const targets = studentGapTargetsFromIssues(issues);
  const idx = targets.findIndex(t => studentGapTargetKey(t) === studentGapTargetKey(target));
  if(idx >= 0) window.__TKB_STUDENT_GAP_TARGET_INDEX = idx;

  const classId = (target.classId || target.id || "").toString();
  const issueIndex = issues.findIndex(item => String(item?.id || "") === classId);
  if(issueIndex >= 0) window.__TKB_STUDENT_GAP_INDEX = issueIndex;

  if(VIEW_MODE !== "lop") setViewMode("lop");
  if(classId && String(currentLop || "") !== classId){
    selectLop(classId);
  }else if(currentLop){
    renderCurrentView();
  }else if(classId){
    selectLop(classId);
  }
  window.setTimeout(()=>highlightStudentGapIssue(classId, target), 0);
}

function highlightStudentGapIssue(classId, targetSlot){
  clearScheduleStatHighlights();
  const issues = Array.isArray(window.__TKB_STUDENT_GAP_ISSUES) && window.__TKB_STUDENT_GAP_ISSUES.length
    ? window.__TKB_STUDENT_GAP_ISSUES
    : getStudentGapIssuesFromStats();
  const issue = issues.find(item => String(item?.id || "") === String(classId || ""));
  if(!issue) return;
  const table = document.querySelector("#tkb .tkb-main-table") || document.querySelector("#tkb > table.table") || document.querySelector("#tkb table.table");
  const slots = targetSlot
    ? [targetSlot]
    : (Array.isArray(issue.sessions) ? issue.sessions : []);
  const mainHits = [];
  slots.forEach(s=>{
    const td = table?.querySelector?.(`td[data-thu="${s.thu}"][data-buoi="${s.buoi}"][data-ti="${s.ti}"]`);
    if(td){
      td.classList.add("tkb-student-gap-cell");
      mainHits.push(td);
    }
  });
  try{ mainHits[0]?.scrollIntoView({block:"nearest", inline:"nearest"}); }catch(_){ }
  try{
    const s = targetSlot || slots[0] || {};
    const period = Number.isFinite(Number(s.ti)) ? ` T${Number(s.ti) + 1}` : "";
    const pos = s.thu ? ` - ${LABEL[s.thu] || s.thu} ${s.buoi || ""}${period}` : "";
    _setStatus(`${getStudentGapStatLabel()}: ${issue.name || issue.id}${pos}`, "info");
  }catch(_){ }
}

function getActiveTeacherStatType(){
  const type = String(window.__TKB_TEACHER_STAT_ACTIVE || "onePeriod");
  return ["gapAll","gap1","gap2","onePeriod"].includes(type) ? type : "onePeriod";
}

function getActiveTeacherStatIssueForTeacher(code){
  const type = getActiveTeacherStatType();
  const source = window.__TKB_TEACHER_STAT_ISSUES || {};
  const cached = Array.isArray(source[type]) ? source[type] : getTeacherStatIssuesFromStats(type);
  return cached.find(item => String(item?.code || "").trim() === String(code || "").trim()) || null;
}

function classHasTeacherInSession(classId, code, session){
  const tkb = DATA.tkb?.[classId];
  if(!tkb) return false;
  const canon = getLopCanonById(classId);
  const teacherCode = String(code || "").trim();
  if(!teacherCode) return false;
  const checkCell = (cell)=>{
    if(!cell || cell === "OFF") return false;
    const mon = cellMon(cell);
    if(!mon) return false;
    return teacherValueHas(getTeacherForClassMon(canon, mon), teacherCode);
  };
  const thu = session?.thu;
  const buoi = session?.buoi;
  const ti = Number(session?.ti);
  if(thu && buoi && tkb?.[thu]?.[buoi]){
    const arr = tkb[thu][buoi] || [];
    if(Number.isFinite(ti) && ti >= 0) return checkCell(arr[ti]);
    return arr.some(checkCell);
  }
  for(const d of DAYS){
    for(const b of ["sang","chieu"]){
      if((tkb?.[d]?.[b] || []).some(checkCell)) return true;
    }
  }
  return false;
}

function classAssignedToTeacher(classId, code){
  const teacherCode = String(code || "").trim();
  if(!teacherCode) return false;
  const lop = (DATA.lop || []).find(x => String(x.id) === String(classId));
  const canon = getLopCanonById(classId);
  const khoiNum = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "";
  return (computeMonsForClass(khoiNum, canon) || []).some(m=>{
    const mon = (m?.ten || "").toString().trim();
    return mon && teacherValueHas(getTeacherForClassMon(canon, mon), teacherCode);
  });
}

function findClassForTeacherIssue(code, issue){
  const lops = getFilteredLops();
  const ordered = [];
  const add = (classId)=>{
    if(classId == null) return;
    const id = String(classId);
    if(id && !ordered.some(l => String(l.id) === id)){
      const lop = lops.find(x => String(x.id) === id) || (DATA.lop || []).find(x => String(x.id) === id);
      if(lop) ordered.push(lop);
    }
  };
  add(currentLop);
  lops.forEach(l=>add(l.id));
  (DATA.lop || []).forEach(l=>add(l.id));

  const sessions = Array.isArray(issue?.sessions) ? issue.sessions : [];
  for(const session of sessions){
    for(const lop of ordered){
      if(classHasTeacherInSession(lop.id, code, session)) return lop.id;
    }
  }
  for(const lop of ordered){
    if(classHasTeacherInSession(lop.id, code, null)) return lop.id;
  }
  for(const lop of ordered){
    if(classAssignedToTeacher(lop.id, code)) return lop.id;
  }
  return currentLop || ordered[0]?.id || "";
}

function focusTeacherIssueInClassPair(type, target){
  const code = String(target?.code || "").trim();
  if(!code) return;
  const classId = findClassForTeacherIssue(code, target);
  if(VIEW_MODE !== "lop") setViewMode("lop");
  currentGV = code;
  if(classId && String(currentLop || "") !== String(classId)){
    selectLop(classId);
  }else if(currentLop){
    renderCurrentView();
  }else if(classId){
    selectLop(classId);
  }
  currentGV = code;
  if(typeof window.pairSelectTeacher === "function" && currentLop){
    try{ window.pairSelectTeacher(code); }catch(_){ }
  }
  window.__TKB_TEACHER_STAT_ACTIVE = type;
}

function goToTeacherStatIssues(type){
  const key = ["gapAll","gap1","gap2","onePeriod"].includes(String(type || "")) ? String(type) : "onePeriod";
  const issues = getTeacherStatIssuesFromStats(key);
  window.__TKB_TEACHER_STAT_ACTIVE = key;
  window.__TKB_TEACHER_STAT_ISSUES = Object.assign({}, window.__TKB_TEACHER_STAT_ISSUES || {}, {[key]: issues});
  if(key === "onePeriod") window.__TKB_ONE_PERIOD_TEACHER_ISSUES = issues;
  if(!issues.length){
    try{ _setStatus(`${getTeacherStatLabel(key)}: không có giáo viên cần xem.`, "ok"); }catch(_){ }
    return;
  }
  const currentIndex = issues.findIndex(item => String(item?.code||"").trim() === String(currentGV||"").trim());
  const nextIndex = (currentIndex >= 0)
    ? (currentIndex + 1) % issues.length
    : 0;
  window.__TKB_TEACHER_STAT_INDEX = nextIndex;
  focusTeacherStatIssue(key, issues[nextIndex].code);
}

function focusTeacherStatIssue(type, code){
  const key = ["gapAll","gap1","gap2","onePeriod"].includes(String(type || "")) ? String(type) : getActiveTeacherStatType();
  const source = window.__TKB_TEACHER_STAT_ISSUES || {};
  const issues = Array.isArray(source[key]) && source[key].length ? source[key] : getTeacherStatIssuesFromStats(key);
  window.__TKB_TEACHER_STAT_ACTIVE = key;
  window.__TKB_TEACHER_STAT_ISSUES = Object.assign({}, source, {[key]: issues});
  if(key === "onePeriod") window.__TKB_ONE_PERIOD_TEACHER_ISSUES = issues;
  const found = issues.findIndex(item => String(item?.code||"").trim() === String(code||"").trim());
  const idx = found >= 0 ? found : 0;
  const target = issues[idx];
  if(!target) return;
  window.__TKB_TEACHER_STAT_INDEX = idx;
  currentGV = target.code;
  if(TKB_CLASS_VIEW_ONLY) focusTeacherIssueInClassPair(key, target);
  else if(VIEW_MODE !== "gv") setViewMode("gv");
  else selectGV(target.code);
  window.setTimeout(()=>{
    markTeacherStatIssueList();
    clearOnePeriodIssueNavigator();
    highlightTeacherStatIssue(key, target.code);
  }, 0);
}

function stepTeacherStatIssue(delta){
  const key = getActiveTeacherStatType();
  const issues = Array.isArray(window.__TKB_TEACHER_STAT_ISSUES?.[key]) ? window.__TKB_TEACHER_STAT_ISSUES[key] : [];
  if(!issues.length) return;
  const cur = Number(window.__TKB_TEACHER_STAT_INDEX || 0);
  const next = (cur + Number(delta || 0) + issues.length) % issues.length;
  window.__TKB_TEACHER_STAT_INDEX = next;
  focusTeacherStatIssue(key, issues[next].code);
}

function markTeacherStatIssueList(){
  if(TKB_CLASS_VIEW_ONLY) return;
  const key = getActiveTeacherStatType();
  const issues = Array.isArray(window.__TKB_TEACHER_STAT_ISSUES?.[key]) ? window.__TKB_TEACHER_STAT_ISSUES[key] : [];
  const counts = new Map(issues.map(item => [String(item.code||""), teacherStatIssueCount(item)]));
  document.querySelectorAll("#listLop .lop-item").forEach(el=>{
    const code = String(el.dataset.id || "");
    const count = counts.get(code) || 0;
    el.classList.toggle("teacher-one-period-issue", count > 0);
    el.classList.toggle("teacher-stat-issue", count > 0);
    el.querySelectorAll(".teacher-issue-badge").forEach(badge=>badge.remove());
    if(count > 0){
      el.insertAdjacentHTML("beforeend", ` <span class="teacher-issue-badge">${count}</span>`);
      el.onclick = ()=>focusTeacherStatIssue(key, code);
    }
  });
  const active = document.querySelector("#listLop .lop-item.active");
  try{ active?.scrollIntoView({block:"nearest"}); }catch(_){ }
}

function highlightTeacherStatIssue(type, code){
  const key = ["gapAll","gap1","gap2","onePeriod"].includes(String(type || "")) ? String(type) : getActiveTeacherStatType();
  const issues = Array.isArray(window.__TKB_TEACHER_STAT_ISSUES?.[key]) ? window.__TKB_TEACHER_STAT_ISSUES[key] : [];
  const issue = issues.find(item => String(item?.code||"").trim() === String(code||"").trim());
  clearStudentGapHighlights();
  document.querySelectorAll("#tkb td.tkb-one-period-session,#tkb td.tkb-one-period-cell,#tkb td.tkb-teacher-gap-session,#tkb td.tkb-teacher-gap-cell").forEach(td=>{
    td.classList.remove("tkb-one-period-session", "tkb-one-period-cell", "tkb-teacher-gap-session", "tkb-teacher-gap-cell");
  });
  if(!issue) return;
  issue.sessions.forEach(s=>{
    const scopeSelector = (key !== "onePeriod" && document.getElementById("tkbPairSupport"))
      ? `#tkbPairSupport td[data-pair-slot="teacher"][data-thu="${s.thu}"][data-buoi="${s.buoi}"]`
      : `#tkb td[data-thu="${s.thu}"][data-buoi="${s.buoi}"]`;
    document.querySelectorAll(scopeSelector).forEach(td=>{
      if(key === "onePeriod"){
        td.classList.add("tkb-one-period-session");
        if(Number(td.dataset.ti) === Number(s.ti)) td.classList.add("tkb-one-period-cell");
      }else{
        td.classList.add("tkb-teacher-gap-session");
        if(Array.isArray(s.gapSlots) && s.gapSlots.some(x => Number(x) === Number(td.dataset.ti))){
          td.classList.add("tkb-teacher-gap-cell");
        }
      }
    });
  });
  try{ _setStatus(`Đang xem GV ${issue.code}: ${teacherStatIssueCount(issue)} mục - ${getTeacherStatLabel(key)}.`, "info"); }catch(_){ }
}

function goToOnePeriodTeachers(){
  return goToTeacherStatIssues("onePeriod");
  const issues = getOnePeriodIssuesFromStats();
  window.__TKB_ONE_PERIOD_TEACHER_ISSUES = issues;
  if(!issues.length){
    try{ _setStatus("Không có giáo viên dạy 1 tiết trong 1 buổi.", "ok"); }catch(_){ }
    return;
  }
  const currentIndex = issues.findIndex(item => String(item?.code||"").trim() === String(currentGV||"").trim());
  const nextIndex = (VIEW_MODE === "gv" && currentIndex >= 0)
    ? (currentIndex + 1) % issues.length
    : 0;
  window.__TKB_ONE_PERIOD_TEACHER_INDEX = nextIndex;
  focusOnePeriodTeacher(issues[nextIndex].code);
}

function focusOnePeriodTeacher(code){
  const issues = Array.isArray(window.__TKB_ONE_PERIOD_TEACHER_ISSUES) && window.__TKB_ONE_PERIOD_TEACHER_ISSUES.length
    ? window.__TKB_ONE_PERIOD_TEACHER_ISSUES
    : getOnePeriodIssuesFromStats();
  window.__TKB_ONE_PERIOD_TEACHER_ISSUES = issues;
  const found = issues.findIndex(item => String(item?.code||"").trim() === String(code||"").trim());
  const idx = found >= 0 ? found : 0;
  const target = issues[idx];
  if(!target) return;
  window.__TKB_ONE_PERIOD_TEACHER_INDEX = idx;
  currentGV = target.code;
  if(TKB_CLASS_VIEW_ONLY) focusTeacherIssueInClassPair("onePeriod", target);
  else if(VIEW_MODE !== "gv") setViewMode("gv");
  else selectGV(target.code);
  window.setTimeout(()=>{
    markOnePeriodTeacherList();
    clearOnePeriodIssueNavigator();
    highlightOnePeriodTeacherSessions(target.code);
  }, 0);
}

function stepOnePeriodTeacher(delta){
  const issues = Array.isArray(window.__TKB_ONE_PERIOD_TEACHER_ISSUES) ? window.__TKB_ONE_PERIOD_TEACHER_ISSUES : [];
  if(!issues.length) return;
  const cur = Number(window.__TKB_ONE_PERIOD_TEACHER_INDEX || 0);
  const next = (cur + Number(delta || 0) + issues.length) % issues.length;
  window.__TKB_ONE_PERIOD_TEACHER_INDEX = next;
  focusOnePeriodTeacher(issues[next].code);
}

function markOnePeriodTeacherList(){
  if(TKB_CLASS_VIEW_ONLY) return;
  const issues = Array.isArray(window.__TKB_ONE_PERIOD_TEACHER_ISSUES) ? window.__TKB_ONE_PERIOD_TEACHER_ISSUES : [];
  const counts = new Map(issues.map(item => [String(item.code||""), Number(item.sessions?.length || 0)]));
  document.querySelectorAll("#listLop .lop-item").forEach(el=>{
    const code = String(el.dataset.id || "");
    const count = counts.get(code) || 0;
    el.classList.toggle("teacher-one-period-issue", count > 0);
    if(count <= 0){
      el.querySelectorAll(".teacher-issue-badge").forEach(badge=>badge.remove());
    }
    if(count > 0 && !el.querySelector(".teacher-issue-badge")){
      el.insertAdjacentHTML("beforeend", ` <span class="teacher-issue-badge">${count}</span>`);
    }
    if(count > 0) el.onclick = ()=>focusOnePeriodTeacher(code);
  });
  const active = document.querySelector("#listLop .lop-item.active");
  try{ active?.scrollIntoView({block:"nearest"}); }catch(_){ }
}

function clearOnePeriodIssueNavigator(){
  document.querySelectorAll(".tkb-one-period-nav").forEach(el=>el.remove());
}

function highlightOnePeriodTeacherSessions(code){
  const issue = getOnePeriodIssueForTeacher(code);
  clearStudentGapHighlights();
  document.querySelectorAll("#tkb td.tkb-one-period-session,#tkb td.tkb-one-period-cell").forEach(td=>{
    td.classList.remove("tkb-one-period-session", "tkb-one-period-cell");
  });
  if(!issue) return;
  issue.sessions.forEach(s=>{
    document.querySelectorAll(`#tkb td[data-thu="${s.thu}"][data-buoi="${s.buoi}"]`).forEach(td=>{
      td.classList.add("tkb-one-period-session");
      if(Number(td.dataset.ti) === Number(s.ti)) td.classList.add("tkb-one-period-cell");
    });
  });
  try{ _setStatus(`Đang xem GV ${issue.code}: ${issue.sessions.length} buổi dạy 1 tiết.`, "info"); }catch(_){ }
}

function calcTeacherTKBStats(){
  const teacherCodes = Array.from(_getAssignedTeacherCodes());
  const occ = {}; // code -> day -> buoi -> boolean[]

  teacherCodes.forEach(code=>{
    occ[code] = {};
    DAYS.forEach(d=>{
      occ[code][d] = {
        sang: Array.from({length:SANG}, ()=>false),
        chieu: Array.from({length:CHIEU}, ()=>false)
      };
    });
  });

  // Scan toàn bộ TKB để đánh dấu tiết dạy cho từng GV
  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];
  for(const lop of lops){
    const classId = lop.id;
    const tkb = DATA.tkb?.[classId];
    if(!tkb) continue;
    const classCanon = getLopCanonById(classId);

    for(const d of DAYS){
      // sáng
      const as = (tkb?.[d]?.sang || []);
      for(let i=0;i<as.length;i++){
        const v = as[i];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        const gv = getTeacherForClassMon(classCanon, mon);
        if(gv && occ[gv]) occ[gv][d].sang[i] = true;
      }
      // chiều
      const ac = (tkb?.[d]?.chieu || []);
      for(let i=0;i<ac.length;i++){
        const v = ac[i];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        const gv = getTeacherForClassMon(classCanon, mon);
        if(gv && occ[gv]) occ[gv][d].chieu[i] = true;
      }
    }
  }

  // Tính thống kê theo mô tả:
  // - Số tiết trống = số buổi trống 1 tiết + số buổi trống 2 tiết.
  // - Buổi dạy 1 tiết: buổi có đúng 1 tiết dạy (đây là phần cần tối ưu)
  let soBuoiTrong1 = 0;
  let soBuoiTrong2 = 0;
  let soBuoiDay1 = 0;
  let soBuoiDay5 = 0;
  let tsBuoiDay = 0;
  let tsNgayDay = 0;
  const onePeriodTeacherMap = new Map();
  const gapTeacherMap = new Map();
  const gap1TeacherMap = new Map();
  const gap2TeacherMap = new Map();
  let soTietTrong = 0;

  const _pushTeacherIssue = (map, code, sessionInfo, amount)=>{
    if(!code) return;
    if(!map.has(code)){
      map.set(code, {code, name: getTeacherNameByCode(code), sessions: [], count: 0});
    }
    const item = map.get(code);
    item.sessions.push(sessionInfo);
    item.count += Math.max(1, Number(amount || 1));
  };

  const _countGaps = (arr)=>{
    const idx = [];
    for(let i=0;i<arr.length;i++) if(arr[i]) idx.push(i);
    if(!idx.length) return {tietDay:0, gaps:0, gapSlots:[]};
    const first = idx[0];
    const last = idx[idx.length-1];
    const span = (last - first + 1);
    const tietDay = idx.length;
    const gaps = Math.max(0, span - tietDay);
    const gapSlots = [];
    for(let i=first;i<=last;i++){
      if(!arr[i]) gapSlots.push(i);
    }
    return {tietDay, gaps, gapSlots};
  };

  for(const code of teacherCodes){
    let dayCounted = 0;
    for(const d of DAYS){
      let dayHas = false;
      for(const buoi of ["sang","chieu"]){
        const arr = (occ[code]?.[d]?.[buoi] || []);
        const {tietDay, gaps, gapSlots} = _countGaps(arr);
        if(tietDay > 0){
          tsBuoiDay++;
          dayHas = true;

          if(tietDay === 1){
            soBuoiDay1++;
            if(!onePeriodTeacherMap.has(code)){
              onePeriodTeacherMap.set(code, {code, name: getTeacherNameByCode(code), sessions: [], count: 0});
            }
            onePeriodTeacherMap.get(code).sessions.push({thu:d, buoi, ti:arr.findIndex(Boolean)});
            onePeriodTeacherMap.get(code).count += 1;
          }
          if(tietDay === 5) soBuoiDay5++;

          if(gaps > 0){
            soTietTrong += gaps;
            const info = {thu:d, buoi, gap:gaps, gapSlots:gapSlots.slice()};
            _pushTeacherIssue(gapTeacherMap, code, info, gaps);
            if(gaps === 1){
              soBuoiTrong1++;
              _pushTeacherIssue(gap1TeacherMap, code, info);
            }
            if(gaps >= 2){
              soBuoiTrong2++;
              _pushTeacherIssue(gap2TeacherMap, code, info);
            }
          }
        }
      }
      if(dayHas) dayCounted++;
    }
    tsNgayDay += dayCounted;
  }

  const onePeriodTeachers = Array.from(onePeriodTeacherMap.values())
    .sort(compareTeacherCodeByDataOrder);
  const sortTeacherIssues = (map)=>Array.from(map.values())
    .sort(compareTeacherCodeByDataOrder);

  return {
    soTietTrong,
    soBuoiTrong1,
    soBuoiTrong2,
    soBuoiDay1,
    soBuoiDay5,
    tsBuoiDay,
    tsNgayDay,
    onePeriodTeachers,
    gapTeachers: sortTeacherIssues(gapTeacherMap),
    gap1Teachers: sortTeacherIssues(gap1TeacherMap),
    gap2Teachers: sortTeacherIssues(gap2TeacherMap)
  };
}

/* ======================= XÓA TKB (INLINE MENU) =======================
   - Theo yêu cầu: không dùng hộp thoại, hiển thị listbox ngay tại toolbar
   - Có 2 lựa chọn: Xóa lớp hiện tại / Xóa TKB toàn trường
   - Cơ chế xác nhận inline (không dùng confirm/alert)
======================= */
let _deleteChoice = "";

function fitPlannerMobileStatusMessage(el){
  if(!el) return false;
  el.style.fontSize = "";
  el.style.transform = "";
  el.style.transformOrigin = "";
  const text = String(el.textContent || "").trim();
  if(!text || el.style.display === "none") return false;
  let mobile = Number(window.innerWidth || 0) <= 480;
  try{
    mobile = mobile
      || window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches === true;
  }catch(_){ }
  if(!mobile) return false;
  el.style.letterSpacing = "0";
  el.title = text;
  return true;
}

try{
  window.fitPlannerMobileStatusMessage = fitPlannerMobileStatusMessage;
  window.addEventListener("resize", () => {
    fitPlannerMobileStatusMessage(document.getElementById("statusMsg"));
  }, {passive:true});
}catch(_){ }

function _setStatus(msg, type="error"){
  const el = document.getElementById("statusMsg");
  if(!el) return;
  window.clearTimeout(window.__TKB_STATUS_HIDE_TIMER);
  window.__TKB_STATUS_HIDE_TIMER = 0;
  el.textContent = msg || "";
  el.style.display = msg ? "inline-block" : "none";
  if(type === "ok") el.style.color = "#135200";
  else if(type === "info") el.style.color = "#2f54eb";
  else if(type === "warning") el.style.color = "#b45309";
  else el.style.color = "#a8071a";
  fitPlannerMobileStatusMessage(el);
  const persistentCompletion = String(msg || "").trim() === "Đã xếp xong!";
  if(msg && !persistentCompletion){
    window.__TKB_STATUS_HIDE_TIMER = window.setTimeout(() => {
      el.textContent = "";
      el.style.display = "none";
      fitPlannerMobileStatusMessage(el);
      el.classList.remove("is-auto-sort-running-label");
      window.__TKB_STATUS_HIDE_TIMER = 0;
    }, 5000);
  }
}

function _autoSortProgressYield(){
  return new Promise(resolve => setTimeout(resolve, 0));
}

if(typeof window !== "undefined" && typeof window.__AUTO_SORT_STOP_REQUESTED === "undefined"){
  window.__AUTO_SORT_STOP_REQUESTED = false;
}

function setAutoSortControlLocked(control, locked){
  if(!control) return false;
  if(locked){
    if(!control.dataset.autoSortLock){
      control.dataset.autoSortLock = "1";
      control.dataset.autoSortPrevDisabled = control.disabled ? "1" : "0";
    }
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    control.classList.add("is-auto-sort-disabled");
    return true;
  }
  if(control.dataset.autoSortLock){
    control.disabled = control.dataset.autoSortPrevDisabled === "1";
    delete control.dataset.autoSortLock;
    delete control.dataset.autoSortPrevDisabled;
  }
  if(control.disabled) control.setAttribute("aria-disabled", "true");
  else control.removeAttribute("aria-disabled");
  control.classList.remove("is-auto-sort-disabled");
  return true;
}

function isAgentHelperSupportedDevice(deviceNavigator){
  const nav = deviceNavigator || {};
  const uaData = nav.userAgentData && typeof nav.userAgentData === "object"
    ? nav.userAgentData
    : {};
  const platform = String(uaData.platform || nav.platform || "");
  const userAgent = String(nav.userAgent || "");
  const isIPadDesktopMode = /MacIntel/i.test(platform) && Number(nav.maxTouchPoints || 0) > 1;
  const isWindows = /Windows/i.test(platform) || /Windows NT/i.test(userAgent);
  const isAndroid = uaData.platform === "Android" || /Android/i.test(userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent) || isIPadDesktopMode;
  const isMacOS = (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent))
    && !isIPadDesktopMode;
  const isLinux = /Linux/i.test(platform) || /Linux|X11/i.test(userAgent);
  return isWindows || isAndroid || isIOS || isMacOS || (isLinux && !isAndroid);
}

const BROWSER_AGENT_UNAVAILABLE_LABEL = "Agent không khả dụng trên trình duyệt này; VPS sẽ xử lý.";
const BROWSER_AGENT_OFF_LABEL = "Agent đã tắt; lượt xếp sẽ dùng VPS. Bấm để bật Agent.";

function browserAgentLabel(state){
  const workers = Math.max(1, Number(
    state?.workerCount
    || state?.lastComputeWorkerCount
    || state?.plannedWorkerCount
    || 1
  ) || 1);
  if(state?.working) return `Agent đang tối ưu bằng ${workers} Worker trên thiết bị. Bấm để chuyển về VPS.`;
  if(state?.active) return `Agent đã kết nối bằng ${workers} Worker và đang chờ việc. Bấm để chuyển về VPS.`;
  if(state?.probed) return `Agent đã nạp WASM bằng ${workers} Worker và đang chờ kết nối. Hiện chưa dùng CPU để xếp.`;
  if(state?.available && state?.enabled){
    if(Number(state?.localAcceptedResults || 0) > 0){
      return `Agent đang bật; lượt gần nhất đã xử lý cục bộ bằng ${workers} Worker. Hiện đang nghỉ; bấm để dùng VPS.`;
    }
    return `Agent đang bật nhưng chưa kết nối; sẽ dùng ${workers} Worker CPU/RAM khi bắt đầu lượt xếp phù hợp. Bấm để dùng VPS.`;
  }
  return state?.available ? BROWSER_AGENT_OFF_LABEL : BROWSER_AGENT_UNAVAILABLE_LABEL;
}

function browserAgentRuntimeState(deviceNavigator){
  const nav = deviceNavigator || (typeof navigator !== "undefined" ? navigator : {});
  const executor = window.TKBBrowserWasmExecutor;
  const supportedDevice = isAgentHelperSupportedDevice(nav);
  const available = supportedDevice
    && !!executor
    && typeof executor.isSupportedNavigator === "function"
    && executor.isSupportedNavigator(nav) === true
    && typeof executor.prepare === "function"
    && typeof executor.state === "function"
    && typeof window.Worker === "function"
    && typeof window.WebAssembly === "object"
    && typeof window.BigInt === "function"
    && typeof window.TextEncoder === "function"
    && !!window.crypto?.subtle
    && typeof window.fetch === "function";
  let executorState = {};
  if(available){
    try{
      executorState = executor.state() || {};
    }catch(_){
      executorState = {};
    }
  }
  const enabled = available && (typeof executor.isEnabled !== "function" || executor.isEnabled() !== false);
  const workerCount = Math.max(0, Number(executorState.workerCount || 0) || 0);
  let plannedWorkerCount = 1;
  try{
    plannedWorkerCount = Math.max(1, Number(executor.portfolioWorkerCount?.(nav) || 1) || 1);
  }catch(_){ }
  return {
    supportedDevice,
    available,
    enabled,
    active:available && enabled && executorState.active === true,
    working:available && enabled && executorState.computeActive === true,
    probed:available && enabled && executorState.probed === true,
    workerCount,
    plannedWorkerCount,
    localComputeRuns:Math.max(0, Number(executorState.localComputeRuns || 0) || 0),
    localAcceptedResults:Math.max(0, Number(executorState.localAcceptedResults || 0) || 0),
    lastComputeWorkerCount:Math.max(0, Number(executorState.lastComputeWorkerCount || 0) || 0),
    lastComputeStartedAtMs:Math.max(0, Number(executorState.lastComputeStartedAtMs || 0) || 0),
    lastComputeFinishedAtMs:Math.max(0, Number(executorState.lastComputeFinishedAtMs || 0) || 0),
    lastAcceptedResultAtMs:Math.max(0, Number(executorState.lastAcceptedResultAtMs || 0) || 0)
  };
}

function renderBrowserAgentIndicator(runtimeState){
  const state = runtimeState && typeof runtimeState === "object"
    ? runtimeState
    : browserAgentRuntimeState();
  const available = state.available === true;
  const enabled = available && state.enabled !== false;
  const active = enabled && state.active === true;
  const working = enabled && state.working === true;
  const name = working
    ? "working"
    : (active ? "active" : (state.probed ? "prepared" : (enabled ? "enabled" : (available ? "off" : "unavailable"))));
  const label = browserAgentLabel(Object.assign({}, state, {available, enabled, active, working}));
  window.__TKB_BROWSER_AGENT_READY = enabled && state.probed === true;
  window.__TKB_BROWSER_AGENT_ENABLED = enabled;
  window.__TKB_BROWSER_AGENT_ACTIVE = active;
  window.__TKB_BROWSER_AGENT_WORKING = working;
  const btn = document.getElementById("btnAgentHelper");
  if(!btn) return available;
  btn.dataset.agentState = name;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  btn.disabled = !available;
  btn.setAttribute("aria-disabled", available ? "false" : "true");
  return available;
}

function syncAgentHelperVisibility(){
  const btn = document.getElementById("btnAgentHelper");
  if(!btn) return false;
  const visible = isAgentHelperSupportedDevice(
    typeof navigator !== "undefined" ? navigator : {}
  );
  btn.hidden = !visible;
  btn.setAttribute("aria-hidden", visible ? "false" : "true");
  if(visible) renderBrowserAgentIndicator(browserAgentRuntimeState());
  return visible;
}

async function toggleBrowserAgent(){
  const executor = window.TKBBrowserWasmExecutor;
  if(!executor || typeof executor.setEnabled !== "function") return false;
  const next = !(typeof executor.isEnabled === "function" ? executor.isEnabled() : true);
  const enabled = await executor.setEnabled(next);
  renderBrowserAgentIndicator(browserAgentRuntimeState());
  _setStatus(
    enabled
      ? "Agent đã bật; thiết bị sẽ hỗ trợ các lượt tối ưu phù hợp."
      : "Agent đã tắt; các lượt xếp sẽ dùng VPS.",
    enabled ? "ok" : "info"
  );
  return enabled;
}

function setAgentHelperOnlineState(){
  // Compatibility name retained for older cached bridge code. The indicator
  // deliberately ignores native-Agent server status and reads only local WASM.
  return renderBrowserAgentIndicator(browserAgentRuntimeState());
}

async function refreshAgentHelperStatus(force){
  void force;
  if(!syncAgentHelperVisibility()) return null;
  return setAgentHelperOnlineState();
}

function startAgentHelperStatusPolling(){
  if(!syncAgentHelperVisibility()) return false;
  refreshAgentHelperStatus(true);
  if(!window.__TKB_BROWSER_AGENT_STATUS_TIMER){
    window.__TKB_BROWSER_AGENT_STATUS_TIMER = window.setInterval(
      () => refreshAgentHelperStatus(true),
      750
    );
  }
  return true;
}

try{
  window.addEventListener?.("tkb-browser-agent-state", () => {
    renderBrowserAgentIndicator(browserAgentRuntimeState());
  });
}catch(_){ }

async function maybeInviteAgentBeforeSort(options){
  void options;
  return true;
}

function setAutoSortHomeHidden(hidden){
  const shouldLock = !!hidden;
  const btn = document.getElementById("btnHome");
  const agentBtn = document.getElementById("btnAgentHelper");
  if(!btn && !agentBtn) return false;
  // Keep Home in the toolbar so controls do not shift while sorting.
  if(btn){
    btn.hidden = false;
    btn.setAttribute("aria-hidden", "false");
    setAutoSortControlLocked(btn, shouldLock);
  }
  // The status indicator keeps its desktop slot while sorting so it can show
  // when the browser executor actually owns a lease.
  if(agentBtn){
    const agentVisible = syncAgentHelperVisibility();
    agentBtn.hidden = !agentVisible;
    agentBtn.setAttribute("aria-hidden", agentVisible ? "false" : "true");
    agentBtn.classList.remove("is-auto-sort-disabled");
  }
  return true;
}

function setAutoSortStopAccessibleState(stopping){
  const btn = document.getElementById("btnStopAutoSort");
  if(!btn) return;
  const label = stopping ? "Đang dừng sắp xếp" : "Dừng sắp xếp";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function setAutoSortBusyControls(locked){
  const solverStillRunning = window.__TKB_RUST_SOLVER_RUNNING === true
    || window.__TKB_SOLVE_UI_BUSY === true;
  const shouldLock = !!locked || solverStillRunning;
  const controls = [
    document.getElementById("btnDeleteAll"),
    document.getElementById("btnRangBuoc"),
    document.getElementById("btnUndoTKB"),
    document.getElementById("btnRedoTKB"),
    document.getElementById("solveDurationSeconds"),
    ...Array.from(document.querySelectorAll(".solver-preset-btn[data-preset]"))
  ].filter(Boolean);
  controls.forEach(el => setAutoSortControlLocked(el, shouldLock));
  const presetGroup = document.getElementById("solverPresetGroup");
  if(presetGroup) presetGroup.setAttribute("aria-disabled", shouldLock ? "true" : "false");
  setAutoSortHomeHidden(shouldLock);
  if(!shouldLock) __tkbUpdateHistoryButtons();
}

function setAutoSortStopVisible(visible){
  setAutoSortBusyControls(!!visible);
  const btn = document.getElementById("btnStopAutoSort");
  if(!btn) return;
  btn.classList.toggle("is-active", !!visible);
  btn.setAttribute("aria-hidden", "false");
  if(!visible){
    btn.disabled = true;
    setAutoSortStopAccessibleState(false);
  }
  if(visible && !window.__AUTO_SORT_STOP_REQUESTED) btn.disabled = false;
}

function resetAutoSortStopRequest(){
  window.__AUTO_SORT_STOP_REQUESTED = false;
  const btn = document.getElementById("btnStopAutoSort");
  if(btn){
    btn.disabled = !btn.classList.contains("is-active");
    setAutoSortStopAccessibleState(false);
  }
}

function requestStopAutoSort(){
  setAutoSortBusyControls(true);
  window.__AUTO_SORT_STOP_REQUESTED = true;
  const btn = document.getElementById("btnStopAutoSort");
  if(btn){
    btn.classList.add("is-active");
    btn.setAttribute("aria-hidden", "false");
    btn.disabled = true;
    setAutoSortStopAccessibleState(true);
  }
  try{ _setStatus("Đang dừng xếp...", "info"); }catch(_){ }
}

async function downloadAgentHelper(){
  return toggleBrowserAgent();
}

async function approveAgentPairFromUrl(){
  const params = new URLSearchParams(window.location.search || "");
  const userCode = String(params.get("agentPair") || "").trim().toUpperCase();
  if(!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) return false;
  const accepted = window.confirm(
    `Cho phép Agent mã ${userCode} dùng CPU máy tính này để hỗ trợ các lượt xếp của tài khoản hiện tại?`
  );
  if(!accepted) return false;
  try{
    const headers = window.TKBAuthApi?.getAuthHeaders
      ? window.TKBAuthApi.getAuthHeaders({"Content-Type":"application/json"})
      : {"Content-Type":"application/json", "Accept":"application/json"};
    const response = await fetch("/api/agent-helper/v1/pair/approve", {
      method:"POST",
      headers,
      body:JSON.stringify({protocol:"tkb-agent-helper-v1", userCode}),
      cache:"no-store"
    });
    const payload = await response.json().catch(() => ({}));
    if(!response.ok || payload?.ok !== true){
      throw new Error(response.status === 401
        ? "Phiên đăng nhập đã hết hạn. Hãy đăng nhập rồi mở Agent lại."
        : "Mã ghép nối đã hết hạn. Hãy mở Agent lại để nhận mã mới.");
    }
    params.delete("agentPair");
    const nextQuery = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
    _setStatus("Agent đã kết nối an toàn với tài khoản này.", "ok");
    window.setTimeout(() => refreshAgentHelperStatus(true), 1800);
    window.setTimeout(() => refreshAgentHelperStatus(true), 4500);
    window.alert("Agent đã kết nối thành công. Bạn có thể quay lại trang Xếp.");
    return true;
  }catch(error){
    _setStatus(error?.message || "Không kết nối được Agent.", "error");
    return false;
  }
}

window.setTimeout(() => {
  syncAgentHelperVisibility();
  startAgentHelperStatusPolling();
  approveAgentPairFromUrl();
}, 0);

try{
  window.setAutoSortStopVisible = setAutoSortStopVisible;
  window.setAutoSortBusyControls = setAutoSortBusyControls;
  window.setAutoSortHomeHidden = setAutoSortHomeHidden;
  window.resetAutoSortStopRequest = resetAutoSortStopRequest;
  window.requestStopAutoSort = requestStopAutoSort;
  window.downloadAgentHelper = downloadAgentHelper;
  window.isAgentHelperSupportedDevice = isAgentHelperSupportedDevice;
  window.syncAgentHelperVisibility = syncAgentHelperVisibility;
  window.setAgentHelperOnlineState = setAgentHelperOnlineState;
  window.refreshAgentHelperStatus = refreshAgentHelperStatus;
  window.toggleBrowserAgent = toggleBrowserAgent;
  window.maybeInviteAgentBeforeSort = maybeInviteAgentBeforeSort;
  window.hideAutoSortProgress = hideAutoSortProgress;
  window.setAutoSortProgress = setAutoSortProgress;
  window.finishAutoSortProgress = finishAutoSortProgress;
}catch(_){ }

function hideAutoSortProgress(options){
  const preserveStopRequest = options?.preserveStopRequest === true;
  // Keep the feedback row's height reserved so the timetable never jumps, but
  // hide idle progress content until a solve or reconnect actually starts.
  window.clearTimeout(window.__autoSortProgressHideTimer);
  window.__autoSortProgressHideTimer = null;
  const wrap = document.getElementById("autoSortProgress");
  if(wrap){
    wrap.classList.remove("is-active", "is-error", "is-warning", "is-complete");
    wrap.classList.add("is-idle");
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    const track = wrap.querySelector(".auto-sort-track");
    const fill = document.getElementById("autoSortProgressFill");
    const pct = document.getElementById("autoSortProgressPct");
    const text = wrap.querySelector(".auto-sort-label");
    if(track){
      track.style.setProperty("--auto-sort-progress", "0deg");
      track.setAttribute("aria-label", "Sẵn sàng");
    }
    if(fill) fill.style.width = "0%";
    if(pct) pct.textContent = "0%";
    if(text){
      text.textContent = "Sẵn sàng";
      text.title = "";
    }
  }
  setAutoSortStopVisible(false);
  if(!preserveStopRequest) resetAutoSortStopRequest();
}

function setAutoSortProgress(percent, label){
  const sortBtn = document.getElementById("btnAutoSort");
  const solving = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
  if(sortBtn && !sortBtn.disabled && !solving){
    hideAutoSortProgress();
    return;
  }
  const wrap = document.getElementById("autoSortProgress");
  const fill = document.getElementById("autoSortProgressFill");
  const pct = document.getElementById("autoSortProgressPct");
  const track = wrap?.querySelector(".auto-sort-track");
  const text = wrap?.querySelector(".auto-sort-label");
  if(!wrap || !fill || !pct) return;
  const n = Math.max(0, Math.min(100, Math.round(Number(percent || 0))));
  const btn = document.getElementById("btnStopAutoSort");
  if(btn) btn.disabled = true;
  window.clearTimeout(window.__autoSortProgressHideTimer);
  setAutoSortStopVisible(true);
  wrap.classList.remove("is-idle", "is-error", "is-warning", "is-complete");
  if(!window.__AUTO_SORT_STOP_REQUESTED && n < 100){
    const btn = document.getElementById("btnStopAutoSort");
    if(btn){
      btn.disabled = false;
      setAutoSortStopAccessibleState(false);
    }
  }
  wrap.classList.add("is-active");
  wrap.hidden = false;
  wrap.setAttribute("aria-hidden", "false");
  if(track){
    track.style.setProperty("--auto-sort-progress", (n * 3.6) + "deg");
    track.setAttribute("aria-label", n + "%");
  }
  fill.style.width = n + "%";
  pct.textContent = n + "%";
  if(text){
    text.textContent = label || "Đang tối ưu";
    text.title = label || "";
  }
}

function finishAutoSortProgress(label, state){
  const sortBtn = document.getElementById("btnAutoSort");
  const solving = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
  if(sortBtn && !sortBtn.disabled && !solving){
    hideAutoSortProgress();
    return;
  }
  const text = (label || "").toString().trim();
  const lower = text.toLowerCase();
  const stateKind = String(state || "").toLowerCase();
  const isWarning = stateKind === "warning"
    || lower.includes("chưa đủ")
    || lower.includes("chua du");
  const isError = stateKind === "error"
    || lower.includes("error")
    || lower.includes("loi")
    || lower.includes("lỗi")
    || lower.includes("chưa đạt");
  if(isError || isWarning){
    const currentPct = Number((document.getElementById("autoSortProgressPct")?.textContent || "").match(/\d+/)?.[0]);
    const numericText = text.match(/^(\d+)\s*%$/);
    const fallbackPct = Number.isFinite(currentPct) && currentPct > 0 ? currentPct : 1;
    const targetPct = Math.max(1, Math.min(99, numericText ? Number(numericText[1]) : fallbackPct));
    setAutoSortProgress(targetPct, text || (isWarning ? "Chưa đủ" : "Lỗi"));
    const wrap = document.getElementById("autoSortProgress");
    const pct = document.getElementById("autoSortProgressPct");
    const track = wrap?.querySelector(".auto-sort-track");
    if(wrap){
      wrap.classList.remove("is-idle");
      wrap.classList.toggle("is-error", isError);
      wrap.classList.toggle("is-warning", isWarning);
      wrap.classList.remove("is-complete");
    }
    if(pct) pct.textContent = numericText ? `${targetPct}%` : "!";
    if(track) track.setAttribute("aria-label", `${isWarning ? "Chưa đủ" : "Lỗi"} ${targetPct}%`);
    window.clearTimeout(window.__autoSortProgressHideTimer);
    window.__autoSortProgressHideTimer = null;
    setAutoSortStopVisible(false);
    resetAutoSortStopRequest();
    return;
  }
  hideAutoSortProgress();
}

function invalidateSolverStateAfterScheduleDelete(resetLessonMappings){
  if(!DATA || typeof DATA !== "object") return;
  try{
    const previousRevision = Math.max(0, Number(DATA.tkbScheduleRevision || 0) || 0);
    DATA.tkbScheduleRevision = Math.max(Date.now(), previousRevision + 1);
    window.TKBRustAPI?.invalidatePendingSolveForScheduleMutation?.();
  }catch(_){ }
  [
    "tkbSolverResult",
    "tkbRustSolverResult",
    "tkbSolverPayload",
    "solverResult",
    "solverMetrics",
    "tkbOptimizationPlateau"
  ].forEach(key=>{
    try{ delete DATA[key]; }catch(_){ DATA[key] = null; }
  });
  if(resetLessonMappings === true){
    DATA.tkbLessonTeachers = {};
    DATA.tkbLessonRooms = {};
  }
  try{
    window.__TKB_SOLVER_LAST_PAYLOAD = null;
    window.__TKB_SOLVER_LAST_RESULT = null;
    window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = "";
    window.__TKB_SOLVER_LAST_ERROR = "";
    window.__TKB_SOLVER_LAST_ERROR_PAYLOAD = null;
  }catch(_){ }
}

function persistScheduleDelete(){
  // A completed timetable may still have an asynchronous save in flight when
  // Delete is pressed. Serialize the destructive save behind it, then expose
  // one barrier so an immediate Play cannot race this write and later have the
  // deleted state overwrite the newly solved timetable on the remote store.
  let previousMutation = null;
  try{ previousMutation = window.__TKB_SCHEDULE_MUTATION_SAVE_PROMISE; }catch(_){ }
  const previousSave = previousMutation || __tkbLastSavePromise;
  const persistence = Promise.resolve(previousSave)
    .catch(e => console.warn("Previous save failed before schedule delete", e))
    .then(() => saveStore({force:true, awaitRemote:true}));
  try{ window.__TKB_SCHEDULE_MUTATION_SAVE_PROMISE = persistence; }catch(_){ }
  persistence
    .catch(e => console.warn("Delete save failed", e))
    .finally(() => {
      try{
        if(window.__TKB_SCHEDULE_MUTATION_SAVE_PROMISE === persistence){
          window.__TKB_SCHEDULE_MUTATION_SAVE_PROMISE = null;
        }
      }catch(_){ }
    });
  return persistence;
}

function deleteCurrentClassTKB(){
  cancelDeleteMenu(true);
  if(!currentLop){
    _setStatus("Chưa chọn lớp để xóa.", "error");
    return;
  }

  const cfg = DATA.tkbConfig || {fixed:[], off:[]};
  DATA.tkb[currentLop] = makeEmptyTKBPreservingOff(currentLop, cfg);
  invalidateSolverStateAfterScheduleDelete(false);
  persistScheduleDelete();
  renderCurrentView();
  loadMonList();

  const lop = (DATA.lop||[]).find(x=>x.id==currentLop);
  const name = (lop?.ten||lop?.ten2||currentLop);
  _setStatus(`✔ Đã xóa TKB lớp ${name}.`, "ok");
}

function deleteAllTKB(){
  cancelDeleteMenu(true);
  const classCount = (DATA.lop || []).length;
  const schoolLabel = (
    (window.__TKB_SCHOOL_CONTEXT && window.__TKB_SCHOOL_CONTEXT.label) ||
    localStorage.getItem("TKB_LAST_SCHOOL_LABEL") ||
    schoolParam ||
    "trường hiện tại"
  ).toString().trim();
  const msg = `Bạn có chắc chắn muốn xóa toàn bộ TKB của "${schoolLabel}" không?`;
  if(!window.confirm(msg)) return;
  const cfg = DATA.tkbConfig || {fixed:[], off:[]};
  (DATA.lop||[]).forEach(l=>{
    DATA.tkb[l.id] = makeEmptyTKBPreservingOff(l.id, cfg);
  });
  invalidateSolverStateAfterScheduleDelete(true);
  persistScheduleDelete();
  renderCurrentView();
  loadMonList();
  _setStatus("✔ Đã xóa TKB toàn trường.", "ok");
}

function toggleDeleteMenu(){
  const sel = document.getElementById("deleteSelect");
  if(!sel) return;
  const isOpen = (sel.style.display !== "none");
  if(isOpen){
    cancelDeleteMenu(true);
  } else {
    _setStatus("", "info");
    sel.value = "";
    sel.style.display = "inline-block";
    const confirmBox = document.getElementById("deleteConfirm");
    if(confirmBox) confirmBox.style.display = "none";
    _deleteChoice = "";
  }
}

// silent=true => chỉ đóng menu, không set status
function cancelDeleteMenu(silent=false){
  const sel = document.getElementById("deleteSelect");
  const confirmBox = document.getElementById("deleteConfirm");
  if(sel) sel.style.display = "none";
  if(confirmBox) confirmBox.style.display = "none";
  _deleteChoice = "";
  if(!silent) _setStatus("", "info");
}

function onDeleteSelectChange(){
  const sel = document.getElementById("deleteSelect");
  const confirmBox = document.getElementById("deleteConfirm");
  const txt = document.getElementById("deleteConfirmText");
  if(!sel) return;

  _deleteChoice = sel.value || "";
  if(!_deleteChoice){
    if(confirmBox) confirmBox.style.display = "none";
    return;
  }

  const label = (_deleteChoice === "school") ? "Xóa TKB toàn trường" : "Xóa TKB lớp hiện tại";
  if(txt) txt.textContent = `Xác nhận: ${label}?`;
  if(confirmBox) confirmBox.style.display = "inline-flex";
}

function confirmDeleteMenu(){
  const choice = _deleteChoice;
  if(!choice){ cancelDeleteMenu(true); return; }

  if(choice === "class"){
    if(!currentLop){
      _setStatus("Chưa chọn lớp để xóa.", "error");
      return;
    }
    const cfg = DATA.tkbConfig || {fixed:[], off:[]};
    DATA.tkb[currentLop] = makeEmptyTKBPreservingOff(currentLop, cfg);
    invalidateSolverStateAfterScheduleDelete(false);
    persistScheduleDelete();
    renderCurrentView();
    loadMonList();
    const lop = (DATA.lop||[]).find(x=>x.id==currentLop);
    const name = (lop?.ten||lop?.ten2||currentLop);
    _setStatus(`✔ Đã xóa TKB lớp ${name}.`, "ok");
    cancelDeleteMenu(true);
    return;
  }

  if(choice === "school"){
    const cfg = DATA.tkbConfig || {fixed:[], off:[]};
    (DATA.lop||[]).forEach(l=>{
      DATA.tkb[l.id] = makeEmptyTKBPreservingOff(l.id, cfg);
    });
    invalidateSolverStateAfterScheduleDelete(true);
    persistScheduleDelete();
    renderCurrentView();
    loadMonList();
    _setStatus("✔ Đã xóa TKB toàn trường.", "ok");
    cancelDeleteMenu(true);
    return;
  }

  cancelDeleteMenu(true);
}



/* [MOVED -> phanmon-ops.js] Section: xep_lai */



/* [MOVED -> phanmon-ops.js] Section: panel_and_constraints */

/* ======================= CHECK / EXPORT ======================= */
function showTKBError(){
  if(!currentLop){ alert("Chưa chọn lớp"); return; }

  const errors=[];
  CURRENT_MONS.forEach(m=>{
    const used = countMon(m.ten);
    if(used !== Number(m.sotiet||0)) errors.push(`${m.ten}: ${used}/${m.sotiet}`);
  });

  const tkb = DATA.tkb[currentLop];
  // gioihan ở Phân công và quy tắc liền tiết đều được kiểm tra độc lập theo từng buổi.
  // Giới hạn cả ngày (nếu có) thuộc Yêu cầu môn học và do TKBConstraints kiểm tra.
  DAYS.forEach(thu=>{
    ["sang","chieu"].forEach(buoi=>{
      const arr = tkb[thu][buoi] || [];
      const seen = {};
      for(let i=0;i<arr.length;i++){
        const mon = cellMon(arr[i]);
        if(!mon) continue;
        (seen[mon] ||= []).push(i);
      }
      Object.entries(seen).forEach(([mon, idx])=>{
        const lim = Math.max(1, Number(getMonMeta(mon).gioihan||1));
        if(idx.length > lim) errors.push(`${LABEL[thu]}-${buoi}: ${mon} vượt giới hạn buổi (${idx.length}/${lim})`);
        for(let k=1;k<idx.length;k++){
          if(idx[k] !== idx[k-1]+1){
            errors.push(`${LABEL[thu]}-${buoi}: ${mon} bị tách rời (${idx.map(x=>x+1).join(",")})`);
            break;
          }
        }
      });
    });
  });

  if(!errors.length) alert("✔ Không thấy lỗi.");
  else alert("⚠ Lỗi:\n- " + errors.join("\n- "));
}

function exportExcel(){
  if(!currentLop){ alert("Chưa chọn lớp"); return; }
  const lop = (DATA.lop||[]).find(x=>x.id==currentLop);
  const tkb = DATA.tkb[currentLop];
  const rows = [];

  rows.push(["Tiết", ...DAYS.map(d=>LABEL[d])]);

  for(let i=0;i<SANG;i++){
    rows.push([`S${i+1}`, ...DAYS.map(d=>cellMon(tkb[d].sang[i]) || "")]);
  }
  rows.push(["", "CHIỀU", "", "", "", "", ""]);
  for(let i=0;i<CHIEU;i++){
    rows.push([`C${i+1}`, ...DAYS.map(d=>cellMon(tkb[d].chieu[i]) || "")]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const sectionRow = 1 + SANG;
  try{
    ws["!merges"] = [
      { s: { r: sectionRow, c: 1 }, e: { r: sectionRow, c: DAYS.length } }
    ];
    window.TKBExcelStyle?.styleSheet(ws, rows, {
      widths: [10, ...DAYS.map(()=>18)],
      headerRows: [0],
      sectionRows: [sectionRow],
      freeze: { xSplit: 1, ySplit: 1 },
      bodyRowHeight: 24,
      maxWidth: 24,
      centerAll: true
    });
  }catch(e){
    console.warn("exportExcel style failed", e);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "TKB");
  XLSX.writeFile(wb, `TKB_${lop?.ten||lop?.ten2||currentLop}.xlsx`, window.TKBExcelStyle?.writeOptions ? window.TKBExcelStyle.writeOptions() : { compression: true, cellStyles: true });
}

/* ======================= SAVE / BACK ======================= */
function saveTKB(){ saveStore({force:true}); }

function isAutoSortRunningForNavigation(){
  return window.__TKB_RUST_SOLVER_RUNNING === true
    || window.__TKB_SOLVE_UI_BUSY === true
    || window.__AUTO_SORT_STOP_REQUESTED === true;
}

async function stopAutoSortBeforeHome(){
  try{ _setStatus("Đang dừng xếp để về Home...", "info"); }catch(_){ }
  try{
    const stopResult = typeof window.requestStopAutoSort === "function"
      ? window.requestStopAutoSort()
      : null;
    if(stopResult && typeof stopResult.then === "function") await stopResult;
  }catch(err){
    console.warn("stop before home failed", err);
  }
}

async function saveAndBack(){
  const btn = document.querySelector("button[onclick*='saveAndBack']");
  const status = document.getElementById("statusMsg");
  let navigating = false;
  try{
    if(isAutoSortRunningForNavigation()){
      const ok = window.confirm("Đang sắp xếp. Bạn muốn dừng lượt xếp hiện tại và về Home?");
      if(!ok) return;
      await stopAutoSortBeforeHome();
    }
    if(btn) btn.disabled = true;
    __tkbNavigatingHome = true;
    const result = saveStore({force:true, awaitRemote:true, skipIfUnchanged:true});
    if(result && typeof result.then === "function") await result;
    navigating = true;
    backToMain();
  }catch(e){
    __tkbNavigatingHome = false;
    console.error("saveAndBack failed", e);
    alert("Không lưu được dữ liệu lên VPS. Vui lòng kiểm tra kết nối rồi thử lại.");
  }finally{
    if(!navigating && btn) btn.disabled = false;
  }
}

function printTKB(){
  if(window.TKBAuth && !window.TKBAuth.canPrint()){
    alert("Gói Free chỉ được xếp TKB, không in/xuất.\nNâng cấp Plus hoặc Max tại Quản lý.");
    return;
  }
  const box = document.getElementById("tkb");
  if(!box || !String(box.innerHTML || "").trim()){
    alert("Chưa có thời khóa biểu để in.");
    return;
  }
  try{ saveStore({force:true}); }catch(_){ }
  try{ document.getElementById("statsPopover")?.setAttribute("hidden", ""); }catch(_){ }
  try{ document.getElementById("statsToggle")?.classList.remove("is-open"); }catch(_){ }
  window.print();
}

function setPrintTKBMenuOpen(open){
  const menu = document.getElementById("printTKBMenu");
  const btn = document.getElementById("btnPrintTKB");
  if(!menu || !btn) return;
  const shouldOpen = !!open;
  if(shouldOpen){
    try{ closeStatsPopover(); }catch(_){ }
    menu.hidden = false;
    const rect = btn.getBoundingClientRect();
    const width = menu.offsetWidth || 260;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.max(8, Math.round(top))}px`;
  }else{
    menu.hidden = true;
  }
  btn.classList.toggle("is-open", shouldOpen);
  btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

function closePrintTKBMenu(){
  setPrintTKBMenuOpen(false);
}

function togglePrintTKBMenu(ev){
  try{ ev?.preventDefault(); ev?.stopPropagation(); }catch(_){ }
  const menu = document.getElementById("printTKBMenu");
  setPrintTKBMenuOpen(!!menu?.hidden);
}

function printCurrentClassTKB(){
  const id = String(currentLop || getFilteredLops()[0]?.id || "");
  if(!id){
    alert("Chưa có lớp để in.");
    return;
  }
  if(VIEW_MODE !== "lop") setViewMode("lop");
  if(String(currentLop || "") !== id) selectLop(id);
  if(typeof window.exportCurrentClassTKBExcel === "function"){
    window.exportCurrentClassTKBExcel();
    return;
  }
  if(typeof window.exportCurrentClassTKBDocx === "function"){
    window.exportCurrentClassTKBDocx();
    return;
  }
  setTimeout(()=>printTKB(), 30);
}

function printCurrentTeacherTKB(){
  const code = String(currentGV || getTeacherListForCurrentFilter()[0]?.code || "").trim();
  if(!code){
    alert("Chưa có giáo viên để in.");
    return;
  }
  if(VIEW_MODE !== "gv") setViewMode("gv");
  if(String(currentGV || "") !== code) selectGV(code);
  setTimeout(()=>printTKB(), 30);
}

function printTeacherTKBTemplate1(){
  if(typeof window.exportTeacherTKBExcelTemplate1 === "function"){
    window.exportTeacherTKBExcelTemplate1();
    return;
  }
  printCurrentTeacherTKB();
}

function printTeacherTKBTemplate2(){
  if(typeof window.exportTeacherTKBExcelTemplate2 === "function"){
    window.exportTeacherTKBExcelTemplate2();
    return;
  }
  printCurrentTeacherTKB();
}

function handlePrintTKBOption(mode){
  closePrintTKBMenu();
  if(window.TKBAuth && !window.TKBAuth.canPrint()){
    alert("Gói Free chỉ được xếp TKB, không in/xuất.\nNâng cấp Plus hoặc Max tại Quản lý.");
    return;
  }
  const key = String(mode || "");
  if(typeof window.onPrintTKBOption === "function"){
    window.onPrintTKBOption(key);
    return;
  }
  if(key === "class") return printCurrentClassTKB();
  if(key === "teacher" || key === "teacher-template-1") return printTeacherTKBTemplate1();
  if(key === "teacher-template-2") return printTeacherTKBTemplate2();
  if(key === "school-class"){
    if(typeof window.exportSchoolClassTKBExcel === "function") return window.exportSchoolClassTKBExcel();
    return alert("Chưa tải xong module xuất Excel toàn trường theo lớp học.");
  }
  if(key === "school-teacher"){
    if(typeof window.exportSchoolTeacherTKBExcel === "function") return window.exportSchoolTeacherTKBExcel();
    return alert("Chưa tải xong module xuất Excel toàn trường theo giáo viên.");
  }
}

window.togglePrintTKBMenu = togglePrintTKBMenu;
window.closePrintTKBMenu = closePrintTKBMenu;
window.handlePrintTKBOption = handlePrintTKBOption;

if(!window.__TKB_PRINT_MENU_BOUND){
  window.__TKB_PRINT_MENU_BOUND = true;
  document.addEventListener("click", ev=>{
    const item = ev.target?.closest?.("[data-print-tkb-option]");
    if(!item) return;
    try{ ev.preventDefault(); ev.stopPropagation(); }catch(_){ }
    handlePrintTKBOption(item.dataset.printTkbOption || "");
  });
  document.addEventListener("pointerdown", ev=>{
    if(ev.target?.closest?.("#printTKBMenu") || ev.target?.closest?.("#btnPrintTKB")) return;
    closePrintTKBMenu();
  }, true);
  document.addEventListener("keydown", ev=>{
    if(ev.key === "Escape") closePrintTKBMenu();
  });
  window.addEventListener("resize", closePrintTKBMenu);
  window.addEventListener("scroll", closePrintTKBMenu, true);
}

function mainUrlWithSchoolContext(target){
  const u = new URL(target || "/app", location.href);
  try{
    const sid = sanitizeSchoolId(schoolParam || rawSidParamFromUrl || rawSchoolParamFromUrl || "");
    if(sid){
      u.searchParams.set("sid", sid);
      u.searchParams.delete("school");
    }
  }catch(_){}
  return u.toString();
}

function backToMain(){
  location.href = mainUrlWithSchoolContext("/app");
}





/* [MOVED -> phanmon-ops.js] Section: optimize_improvements */

/* =========================================================
   PATCH 2026-05-03: paired schedule views
   ========================================================= */
(function(){
  try{
    if(window.__TKB_PAIRED_VIEW_PATCH_20260503__) return;
    window.__TKB_PAIRED_VIEW_PATCH_20260503__ = true;

    const __origUpdateViewButtonsActive = updateViewButtonsActive;
    const __origRenderTKB = renderTKB;
    const __origRenderTKBTeacher = renderTKBTeacher;
    const __origRenderTKBPhong = renderTKBPhong;

    function pvSetButtonText(){
      const bL = document.getElementById("btnViewLop");
      const bG = document.getElementById("btnViewGV");
      const bP = document.getElementById("btnViewPhong");
      if(bL) bL.innerText = "Lớp";
      if(bG) bG.innerText = "Giáo viên";
      if(bP) bP.innerText = "Phòng";
    }

    updateViewButtonsActive = function(){
      try{ __origUpdateViewButtonsActive(); }catch(e){}
      pvSetButtonText();
      const leftTitle = document.getElementById("leftTitle");
      if(leftTitle){
        if(VIEW_MODE === "gv") leftTitle.innerText = "Giáo viên";
        else if(VIEW_MODE === "phong") leftTitle.innerText = "Lớp";
        else leftTitle.innerText = "Lớp";
      }
    };

    function pvClassLabel(classId){
      const lop = (DATA.lop || []).find(x => String(x.id) === String(classId));
      return lop ? classCanonFromLop(lop) : (classId || "");
    }

    function pvTeacherLabel(code){
      const c = (code || "").toString().trim();
      const name = getTeacherNameByCode(c);
      return name ? `${c} - ${name}` : c;
    }

    function pvTeachersForClass(classId){
      const set = new Set();
      const tkb = DATA.tkb?.[classId];
      const canon = getLopCanonById(classId);
      const lop = (DATA.lop || []).find(x => String(x.id) === String(classId));
      const khoiNum = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "";
      (computeMonsForClass(khoiNum, canon) || []).forEach(m=>{
        const mon = (m?.ten || "").toString().trim();
        if(!mon) return;
        const gv = getTeacherForClassMon(canon, mon);
        teacherListFromValue(gv).forEach(code=>set.add(code));
      });
      if(tkb){
        for(const thu of DAYS){
          for(const buoi of ["sang","chieu"]){
            const arr = tkb?.[thu]?.[buoi] || [];
            for(const cell of arr){
              if(!cell || cell === "OFF") continue;
              const mon = cellMon(cell);
              if(!mon) continue;
              const gv = getTeacherForClassMon(canon, mon);
              teacherListFromValue(gv).forEach(code=>set.add(code));
            }
          }
        }
      }
      const out = Array.from(set).filter(Boolean).sort(compareTeacherCodeByDataOrder);
      if(out.length) return out;
      return getTeacherListForCurrentFilter().map(x => x.code).filter(Boolean);
    }

    function pvRoomsForTeacher(gvCode){
      const code = (gvCode || "").toString().trim();
      const set = new Set();
      const lops = getFilteredLops();
      for(const l of lops){
        const classId = l.id;
        const tkb = DATA.tkb?.[classId];
        if(!tkb) continue;
        const canon = getLopCanonById(classId);
        for(const thu of DAYS){
          for(const buoi of ["sang","chieu"]){
            const arr = tkb?.[thu]?.[buoi] || [];
            for(const cell of arr){
              if(!cell || cell === "OFF") continue;
              const mon = cellMon(cell);
              if(!mon) continue;
              const gv = getTeacherForClassMon(canon, mon);
              if(!teacherValueHas(gv, code)) continue;
              const room = getRoomForClassMon(canon, mon);
              if(room) set.add(String(room).trim());
            }
          }
        }
      }
      const out = Array.from(set).filter(Boolean).sort((a,b)=>a.localeCompare(b,'vi'));
      if(out.length) return out;
      return getRoomListForCurrentFilter();
    }

    function pvRoomsForClass(classId){
      const set = new Set();
      const tkb = DATA.tkb?.[classId];
      const canon = getLopCanonById(classId);
      if(tkb){
        for(const thu of DAYS){
          for(const buoi of ["sang","chieu"]){
            const arr = tkb?.[thu]?.[buoi] || [];
            for(const cell of arr){
              if(!cell || cell === "OFF") continue;
              const mon = cellMon(cell);
              if(!mon) continue;
              const room = getRoomForClassMon(canon, mon);
              if(room) set.add(String(room).trim());
            }
          }
        }
      }
      return Array.from(set).filter(Boolean).sort((a,b)=>a.localeCompare(b,'vi'));
    }

    function pvClassesForRoom(roomName){
      const roomKey = (roomName || "").toString().trim();
      const set = new Set();
      const lops = getFilteredLops();
      for(const l of lops){
        const classId = l.id;
        const tkb = DATA.tkb?.[classId];
        if(!tkb) continue;
        const canon = getLopCanonById(classId);
        let hit = false;
        for(const thu of DAYS){
          for(const buoi of ["sang","chieu"]){
            const arr = tkb?.[thu]?.[buoi] || [];
            for(const cell of arr){
              if(!cell || cell === "OFF") continue;
              const mon = cellMon(cell);
              if(!mon) continue;
              const room = getRoomForClassMon(canon, mon);
              if(room && String(room).trim() === roomKey) hit = true;
            }
          }
        }
        if(hit) set.add(String(classId));
      }
      const out = Array.from(set).sort(compareClassByDataOrder);
      if(out.length) return out;
      return getFilteredLops().map(l => l.id);
    }

    function pvEnsureTeacherForClass(classId){
      const list = pvAllTeacherCodes(pvTeachersForClass(classId));
      if(!list.length){ currentGV = null; return ""; }
      if(!currentGV || !list.includes(currentGV)) currentGV = list[0];
      return currentGV;
    }

    function pvAllTeacherCodes(preferred){
      const seen = new Set();
      const out = [];
      const add = (code)=>{
        const c = (code || "").toString().trim();
        if(!c || seen.has(c)) return;
        seen.add(c);
        out.push(c);
      };
      (preferred || []).forEach(add);
      getTeacherListForCurrentFilter().forEach(t => add(t?.code));
      (DATA.giaovien || []).forEach(g => add(resolveTeacherCode(g?.magv)));
      for(const value of Object.values(DATA.pccmMatrix || {})) teacherListFromValue(value).forEach(add);
      return out.filter(Boolean).sort(compareTeacherCodeByDataOrder);
    }

    function pvTeacherStats(gvCode){
      const code = (gvCode || "").toString().trim();
      if(!code) return {total:0, assigned:0};
      let total = 0;
      const lops = getFilteredLops();
      for(const l of lops){
        for(const row of requiredSubjectsForClass(l)){
          const teacher = String(row?.gv || "").trim();
          const required = Number(row?.required || 0);
          if(teacherValueHas(teacher, code) && Number.isFinite(required) && required > 0){
            total += required;
          }
        }
      }
      let assigned = 0;
      let offAssigned = 0;
      try{
        const sched = buildTeacherSchedule(code);
        for(const thu of DAYS){
          for(const buoi of ["sang","chieu"]){
            const slots = sched?.[thu]?.[buoi] || [];
            slots.forEach((entries, ti)=>{
              const count = Array.isArray(entries) ? entries.length : 0;
              assigned += count;
              if(count && isTeacherFixedOff(code, thu, buoi, ti)) offAssigned += count;
            });
          }
        }
      }catch(_){
        assigned = 0;
        offAssigned = 0;
      }
      return {total: total > 0 ? total : assigned, assigned, offAssigned};
    }

    function pvEnsureRoomForTeacher(gvCode){
      const list = pvRoomsForTeacher(gvCode);
      if(!list.length){ currentPhong = null; return ""; }
      if(!currentPhong || !list.includes(currentPhong)) currentPhong = list[0];
      return currentPhong;
    }

    function pvEnsureRoomForClass(classId){
      const list = pvRoomsForClass(classId);
      if(!list.length){ currentPhong = null; return ""; }
      if(!currentPhong || !list.includes(currentPhong)) currentPhong = list[0];
      return currentPhong;
    }

    function pvEnsureClassForRoom(roomName){
      const list = pvClassesForRoom(roomName);
      if(!list.length){ currentLop = null; return ""; }
      if(!currentLop || !list.includes(String(currentLop))) currentLop = list[0];
      return currentLop;
    }

    function pvTeacherCellHTML(entries, thu, buoi, ti, gvCode){
      const arr = Array.isArray(entries) ? entries : [];
      const conflict = arr.length > 1;
      const teacherOff = isTeacherFixedOff(gvCode, thu, buoi, ti);
      const offConflict = teacherOff && arr.length > 0;
      const fixed = !teacherOff && arr.length > 0 && arr.some(e=>!!e.fixed);
      const lines = arr.map(e=>{
        const monShort = getMonShort(e.mon);
        const room = (e.room||"").toString().trim();
        return `<div class="tkb-cell-stack">`+
          mobileStackCellLineHTML(e.classDisplay, monShort, "tkb-class-line tkb-class-subject-line")+
          (room ? `<div class="tkb-cell-line tkb-teacher-line tkb-room-line">${escapeHtml(room)}</div>` : "")+
        `</div>`;
      });
      const htmlLines = lines.join("");
      const visibleLines = teacherOff
        ? (offConflict ? `<div class="tkb-off-conflict-label">Nghỉ</div>${htmlLines}` : "")
        : htmlLines;
      const classIds = arr.map(e=>String(e.classId)).join(",");
      const one = arr.length === 1 ? arr[0] : null;
      const oneAttrs = one
        ? ` data-classid="${escapeHtml(String(one.classId))}" data-mon="${escapeHtml(String(one.mon || ""))}" draggable="${fixed ? "false" : "true"}"`
        : ` draggable="false"`;
      return `<td class="${conflict?"tkb-gv-conflict":""} ${one && !fixed?"tkb-pair-draggable":""} ${teacherOff?"tkb-off":""} ${offConflict?"tkb-off-conflict":""} ${fixed?"tkb-fixed":""}" data-pair-slot="teacher" data-teacher="${escapeHtml(String(gvCode || ""))}" data-classids="${escapeHtml(classIds)}" data-thu="${thu}" data-buoi="${buoi}" data-ti="${ti}"${oneAttrs}>`+
             `<div class="tkb-gv-cell">${visibleLines}</div>`+
             `</td>`;
    }

    function pvTeacherTableHTML(gvCode){
      const code = (gvCode || "").toString().trim();
      if(!code) return `<div class="tkb-pair-empty">Chưa chọn giáo viên</div>`;
      const sched = buildTeacherSchedule(code);
      let h = "<table class='table tkb-support-table'><tr>";
      DAYS.forEach(d => h += `<th>${LABEL[d]}</th>`);
      h += "</tr>";
      const TOTAL = SANG + CHIEU;
      for(let row=0; row<TOTAL; row++){
        const isAfternoon = row >= SANG;
        const buoi = isAfternoon ? "chieu" : "sang";
        const ti = isAfternoon ? (row - SANG) : row;
        h += `<tr${row===SANG ? " class=\"split-row\"" : ""}>`;
        DAYS.forEach(d => {
          const entries = isAfternoon ? sched[d].chieu[ti] : sched[d].sang[ti];
          h += pvTeacherCellHTML(entries, d, buoi, ti, code);
        });
        h += "</tr>";
      }
      return h + "</table>";
    }

    function pvRoomTableHTML(roomName){
      const room = (roomName || "").toString().trim();
      if(!room) return pvBlankTimetableHTML();
      const sched = buildRoomSchedule(room);
      let h = "<table class='table tkb-support-table'><tr>";
      DAYS.forEach(d => h += `<th>${LABEL[d]}</th>`);
      h += "</tr>";
      const TOTAL = SANG + CHIEU;
      for(let row=0; row<TOTAL; row++){
        const isAfternoon = row >= SANG;
        const buoi = isAfternoon ? "chieu" : "sang";
        const ti = isAfternoon ? (row - SANG) : row;
        h += `<tr${row===SANG ? " class=\"split-row\"" : ""}>`;
        DAYS.forEach(d => {
          const entries = isAfternoon ? sched[d].chieu[ti] : sched[d].sang[ti];
          h += cellHTMLPhong(entries, d, buoi, ti);
        });
        h += "</tr>";
      }
      return h + "</table>";
    }

    function pvBlankTimetableHTML(){
      let h = "<table class='table tkb-support-table'><tr>";
      DAYS.forEach(d => h += `<th>${LABEL[d]}</th>`);
      h += "</tr>";
      const TOTAL = SANG + CHIEU;
      for(let row=0; row<TOTAL; row++){
        h += `<tr${row===SANG ? " class=\"split-row\"" : ""}>`;
        DAYS.forEach(()=>{ h += `<td draggable="false"><div class="tkb-gv-cell"></div></td>`; });
        h += "</tr>";
      }
      return h + "</table>";
    }

    function pvSelectHTML(id, items, current, labelFn, onchange){
      const rows = (items || []).map(v => {
        const val = String(v || "");
        const active = val === String(current || "");
        return `<button type="button" class="${active ? "active" : ""}" data-pair-option="${escapeHtml(val)}" onclick="pairChooseSelectOption(this)">${escapeHtml(labelFn ? labelFn(val) : val)}</button>`;
      }).join("");
      const cur = String(current || "");
      const label = labelFn ? labelFn(cur) : cur;
      return `<div id="${id}" class="tkb-pair-select" data-pair-select="1" data-value="${escapeHtml(cur)}" data-onchange="${escapeHtml(onchange || "")}">
        <button type="button" class="tkb-pair-select-btn" onclick="pairToggleSelectMenu(this.closest('[data-pair-select]'),event)" onkeydown="pairSelectKeydown(event,this.closest('[data-pair-select]'))" title="${escapeHtml(label)}">
          <span>${escapeHtml(label || "Chọn")}</span><span class="tkb-pair-select-caret">v</span>
        </button>
        <div class="tkb-pair-select-menu" hidden>${rows || `<div class="tkb-pair-select-empty">Không có dữ liệu</div>`}</div>
      </div>`;
    }

    function pairScrollActiveOptionToTop(root, menu){
      if(!root || !menu) return false;
      const options = Array.from(menu.querySelectorAll?.("[data-pair-option]") || []);
      if(!options.length){
        menu.scrollTop = 0;
        return false;
      }
      const current = String(root.dataset?.value || "");
      const active = options.find(option => String(option.dataset?.pairOption || "") === current)
        || options.find(option => option.classList?.contains?.("active"));
      if(!active){
        menu.scrollTop = 0;
        return false;
      }
      let targetTop = Number(active.offsetTop);
      if(!Number.isFinite(targetTop)){
        try{
          const menuRect = menu.getBoundingClientRect();
          const activeRect = active.getBoundingClientRect();
          targetTop = Math.max(0, Number(menu.scrollTop || 0) || 0)
            + activeRect.top
            - menuRect.top
            - Math.max(0, Number(menu.clientTop || 0) || 0);
        }catch(_){
          targetTop = NaN;
        }
      }
      if(!Number.isFinite(targetTop)) return false;
      menu.scrollTop = Math.max(0, Math.round(targetTop));
      return true;
    }

    function pairCloseSelectMenus(except){
      document.querySelectorAll(".tkb-pair-select").forEach(root=>{
        if(except && root === except) return;
        root.classList.remove("is-open");
        const menu = root.querySelector(".tkb-pair-select-menu");
        if(menu) menu.hidden = true;
      });
    }

    window.pairToggleSelectMenu = function(root, ev){
      try{ ev?.preventDefault(); ev?.stopPropagation(); }catch(_){ }
      if(!root) return;
      const menu = root.querySelector(".tkb-pair-select-menu");
      if(!menu) return;
      const willOpen = menu.hidden;
      pairCloseSelectMenus(root);
      root.classList.toggle("is-open", willOpen);
      menu.hidden = !willOpen;
      if(willOpen) pairScrollActiveOptionToTop(root, menu);
    };

    window.pairChooseSelectOption = function(btn){
      const root = btn?.closest?.("[data-pair-select]");
      if(!root) return;
      const value = String(btn.dataset.pairOption || "");
      root.dataset.value = value;
      pairCloseSelectMenus();
      if(root.id === "pairMainClassSelect") window.pairSelectMainClass?.(value);
      else if(root.id === "pairMainTeacherSelect") window.pairSelectMainTeacher?.(value);
      else if(root.id === "pairTeacherSelect") window.pairSelectTeacher?.(value);
      else if(root.id === "pairRoomSelect") window.pairSelectRoom?.(value);
    };

    if(!window.__TKB_PAIR_SELECT_CLOSE_BOUND){
      window.__TKB_PAIR_SELECT_CLOSE_BOUND = true;
      document.addEventListener("pointerdown", ev=>{
        if(ev.target?.closest?.(".tkb-pair-select")) return;
        pairCloseSelectMenus();
      }, true);
    }

    function pvSortedClassIds(current){
      const ids = [];
      const lops = getFilteredLops().slice().sort(compareClassByDataOrder);
      lops.forEach(l=>{
        const id = l?.id;
        if(id == null) return;
        if(!ids.some(x => String(x) === String(id))) ids.push(id);
      });
      if(current && !ids.some(x => String(x) === String(current))) ids.unshift(current);
      return ids;
    }

    function pvTeacherCodes(current){
      const codes = [];
      getTeacherListForCurrentFilter().forEach(t=>{
        const code = (t?.code || "").toString().trim();
        if(code && !codes.includes(code)) codes.push(code);
      });
      const cur = (current || "").toString().trim();
      if(cur && !codes.includes(cur)) codes.unshift(cur);
      return codes;
    }

    function pvClassMainTools(classId){
      return pvSelectHTML("pairMainClassSelect", pvSortedClassIds(classId), classId, pvClassLabel, "pairSelectMainClass(this.value)");
    }

    function pvClassStatsHTML(classId){
      const st = (typeof calcClassTKBPeriodStats === "function")
        ? calcClassTKBPeriodStats(classId)
        : {total:0, assigned:0};
      const n = (v)=>{
        const x = Number(v || 0);
        return Number.isFinite(x) ? String(Math.round(x)) : "0";
      };
      const total = Number(st.total || 0);
      const assigned = Number(st.assigned || 0);
      const unassigned = Math.max(0, total - assigned);
      return `<div class="tkb-pair-class-stats">`+
        `<span>Đã xếp:<b>${n(assigned)}</b></span>`+
        `<span>Chưa phân:<b>${n(unassigned)}</b></span>`+
      `</div>`;
    }

    function pvTeacherMainTools(gvCode){
      const id = "pairMainTeacherSelect";
      return pvSelectHTML(id, pvTeacherCodes(gvCode), gvCode, pvTeacherLabel, "pairSelectMainTeacher(this.value)");
    }

    function pvTeacherStatsHTML(gvCode){
      const st = pvTeacherStats(gvCode);
      const n = (v)=>{
        const x = Number(v || 0);
        return Number.isFinite(x) ? String(Math.round(x)) : "0";
      };
      const total = Number(st.total || 0);
      const assigned = Number(st.assigned || 0);
      const unassigned = Math.max(0, total - assigned);
      const offAssigned = Number(st.offAssigned || 0);
      const offAssignedHTML = offAssigned > 0
        ? `<span class="tkb-pair-stat-warning">Giờ nghỉ:<b>${n(offAssigned)}</b></span>`
        : "";
      return `<div class="tkb-pair-class-stats tkb-pair-teacher-stats">`+
        `<span>Đã xếp:<b>${n(assigned)}</b></span>`+
        `<span>Chưa phân:<b>${n(unassigned)}</b></span>`+
        offAssignedHTML+
      `</div>`;
    }

    function pvSetPairStack(box, className){
      if(!box) return;
      box.classList.add("tkb-pair-stack");
      box.classList.remove("tkb-pair-lop-gv", "tkb-pair-gv-phong", "tkb-pair-lop-phong");
      if(className) box.classList.add(className);
    }

    function pvRoleLabel(title){
      const t = (title || "").toString().toLowerCase();
      if(t.includes("giáo")) return "GV";
      if(t.includes("phòng")) return "Phòng";
      if(t.includes("lớp")) return "Lớp";
      return "";
    }

    function pvPane(title, tools, body, role, stats){
      const label = pvRoleLabel(title);
      const summary = stats ? `<div class="tkb-pair-summary">${stats}</div>` : "";
      const head = (tools || summary) ? `<div class="tkb-pair-toolbar"><div class="tkb-pair-tools">${tools || ""}</div>${summary}</div>` : "";
      return `<section class="tkb-pair-pane ${role||""}">
        ${head}
        <div class="tkb-pair-body">${body || ""}</div>
      </section>`;
    }

    function pvWrapMainTable(box, title, tools, role){
      const table = box.querySelector("table.table");
      if(!table) return null;
      table.classList.add("tkb-main-table");
      const label = pvRoleLabel(title);
      const stats = (role === "main")
        ? (VIEW_MODE === "gv" ? pvTeacherStatsHTML(currentGV) : pvClassStatsHTML(currentLop))
        : "";
      const unassigned = (role === "main" && VIEW_MODE === "lop") ? unassignedDropdownHTML() : "";
      const summary = (unassigned || stats) ? `<div class="tkb-pair-summary">${unassigned}${stats}</div>` : "";
      const head = (tools || summary) ? `<div class="tkb-pair-toolbar"><div class="tkb-pair-tools">${tools || ""}</div>${summary}</div>` : "";
      const pane = document.createElement("section");
      pane.className = `tkb-pair-pane ${role || ""}`;
      pane.innerHTML = `${head}<div class="tkb-pair-body"></div>`;
      const body = pane.querySelector(".tkb-pair-body");
      body.appendChild(table);
      box.innerHTML = "";
      box.appendChild(pane);
      return pane;
    }

    function pvBindSupportNav(root){
      (root || document).querySelectorAll(".tkb-support-table td[data-thu][data-buoi][data-ti]").forEach(td=>{
        bindSelectableCell(td);
        bindRightClickUnassignCell(td);
      });
      (root || document).querySelectorAll(".tkb-support-table td[data-classids]").forEach(td=>{
        const ids = (td.dataset.classids||"").split(",").map(s=>s.trim()).filter(Boolean);
        if(!ids.length) return;
        td.style.cursor = "pointer";
        const openClassFromSupport = ()=>{
          if(ids.length === 1){
            const targetId = ids[0];
            const keepGV = (currentGV || "").toString().trim();
            if(VIEW_MODE !== "lop"){
              setViewMode("lop");
            }
            if(keepGV) currentGV = keepGV;
            if(String(currentLop || "") !== String(targetId)){
              selectLop(targetId);
            }
            return;
          }
          alert("Trùng lịch:\n" + ((td.innerText || "").trim()));
        };
        td.onclick = (e)=>{
          if(e && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
          if(ids.length !== 1) return;
          openClassFromSupport();
        };
        td.ondblclick = (e)=>{
          if(ids.length > 1){
            try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
            openClassFromSupport();
            return;
          }
          handleCellDoubleAction(td, e);
        };
      });
    }

    function pvPairDragInfo(){
      if(!dragData) return null;
      if(dragData.type === "pairTeacherCell"){
        const from = dragData.from?.dataset || {};
        return {
          type: "cell",
          classId: dragData.classId,
          mon: dragData.mon || dragData.val || "",
          val: dragData.val || dragData.mon || "",
          fromThu: from.thu,
          fromBuoi: from.buoi,
          fromTi: Number(from.ti)
        };
      }
      if(dragData.type === "cell"){
        const from = dragData.from?.dataset || {};
        return {
          type: "cell",
          classId: currentLop,
          mon: dragData.val || "",
          val: dragData.val || "",
          fromThu: from.thu,
          fromBuoi: from.buoi,
          fromTi: Number(from.ti)
        };
      }
      if(dragData.type === "mon"){
        return {
          type: "mon",
          classId: dragData.classId || currentLop,
          mon: dragData.mon || "",
          val: dragData.mon || ""
        };
      }
      return null;
    }

    function pvValidateSupportDrop(td){
      const info = pvPairDragInfo();
      if(!info || !info.classId || !info.mon) return {ok:false, reason:"empty"};
      const thu = td.dataset.thu;
      const buoi = td.dataset.buoi;
      const ti = Number(td.dataset.ti);
      const tkb = DATA?.tkb?.[info.classId];
      if(!tkb?.[thu]?.[buoi] || !Number.isFinite(ti)) return {ok:false, reason:"runtime", msg:"Không xác định được ô đích."};
      const targetVal = tkb[thu][buoi][ti];
      if(targetVal === "OFF" || isFixed(targetVal)) return {ok:false, reason:"locked"};
      if(currentGV){
        const canon = getLopCanonById(info.classId);
        const gv = getTeacherForClassMon(canon, info.mon);
        if(!teacherValueHas(gv, currentGV)){
          return {ok:false, reason:"teacher conflict", msg:"Tiết này không thuộc giáo viên đang xem ở bảng dưới."};
        }
      }

      const oldLop = currentLop;
      try{
        currentLop = info.classId;
        return validateDrop(td, info.mon);
      }finally{
        currentLop = oldLop;
      }
    }

    function pvApplySupportDrop(td){
      const info = pvPairDragInfo();
      if(!info) return;
      const thu = td.dataset.thu;
      const buoi = td.dataset.buoi;
      const ti = Number(td.dataset.ti);
      let res = pvValidateSupportDrop(td);
      if(!res.ok && maybeRaiseSessionLimitForDrop(td, info.mon, res)){
        res = pvValidateSupportDrop(td);
      }
      if(!res.ok){
        flashInvalid(td);
        showDropError(res, td);
        return;
      }
      if(res.warn && Array.isArray(res.conflicts) && res.conflicts.length){
        const ok = confirm(res.confirmText || buildReplaceConfirmText(res.conflicts));
        if(!ok){
          flashInvalid(td);
          return;
        }
        clearConflictSlots(res.conflicts);
      }

      const tkb = DATA?.tkb?.[info.classId];
      if(!tkb?.[thu]?.[buoi]) return;
      if(info.type === "cell" && info.fromThu && info.fromBuoi && Number.isFinite(info.fromTi)){
        tkb[info.fromThu][info.fromBuoi][info.fromTi] = "";
      }
      tkb[thu][buoi][ti] = info.val || info.mon;

      try{ saveStore(); }catch(e){ console.error('saveStore failed', e); }
      try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
      try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
      clearDragVisual();
      dragData = null;
      dragMon = "";
    }

    function pvBindTeacherSupportDrag(root){
      (root || document).querySelectorAll(".tkb-support-table td[data-pair-slot='teacher']").forEach(td=>{
        td.ondragstart = (e)=>{
          const classId = (td.dataset.classid || "").toString().trim();
          const mon = (td.dataset.mon || "").toString().trim();
          const thu = td.dataset.thu;
          const buoi = td.dataset.buoi;
          const ti = Number(td.dataset.ti);
          if(!classId || !mon || !thu || !buoi || !Number.isFinite(ti)){
            try{ e.preventDefault(); }catch(_){}
            return;
          }
          const raw = DATA?.tkb?.[classId]?.[thu]?.[buoi]?.[ti];
          if(!raw || raw === "OFF" || isFixed(raw)){
            try{ e.preventDefault(); }catch(_){}
            return;
          }
          dragData = { type:"pairTeacherCell", classId, from:td, val:raw, mon };
          dragMon = mon;
          setNativeDragTransfer(e, mon);
          applyDragVisual(mon, td);
        };
        td.ondragend = ()=>{
          clearDragVisual();
          dragData = null;
          dragMon = "";
        };
        td.ondragover = (e)=>{
          if(!dragData) return;
          try{ e.preventDefault(); }catch(_){}
          const res = pvValidateSupportDrop(td);
          setDropHint(td, res.ok && !res.warn);
        };
        td.ondragenter = ()=>{
          if(!dragData) return;
          td.classList.add("drag-over");
        };
        td.ondragleave = ()=>{
          td.classList.remove("drag-over", "drop-valid", "drop-invalid");
        };
        td.ondrop = (e)=>{
          if(!dragData) return;
          try{ e.preventDefault(); }catch(_){}
          pvApplySupportDrop(td);
        };
      });
    }

    function pvUpdateTeacherSupport(classId){
      const root = document.getElementById("tkbPairSupport");
      if(!root) return;
      const gv = pvEnsureTeacherForClass(classId);
      const teachers = pvAllTeacherCodes(pvTeachersForClass(classId));
      const tools = pvSelectHTML("pairTeacherSelect", teachers, gv, pvTeacherLabel, "pairSelectTeacher(this.value)");
      root.innerHTML = pvPane("TKB giáo viên", tools, pvTeacherTableHTML(gv), "support", pvTeacherStatsHTML(gv));
      pvBindSupportNav(root);
      pvBindTeacherSupportDrag(root);
    }

    window.pairSelectTeacher = function(code){
      currentGV = (code || "").toString().trim();
      if(VIEW_MODE === "lop") pvUpdateTeacherSupport(currentLop);
      else renderCurrentView();
    };

    window.pairSelectRoom = function(room){
      currentPhong = (room || "").toString().trim();
      renderCurrentView();
    };

    window.pairSelectClass = function(classId){
      currentLop = (classId || "").toString();
      renderCurrentView();
    };

    window.pairSelectMainClass = function(classId){
      const id = (classId || "").toString();
      if(!id) return;
      selectLop(id);
    };

    window.pairSelectMainTeacher = function(code){
      const gv = (code || "").toString().trim();
      if(!gv) return;
      selectGV(gv);
    };

    window.pairSelectKeydown = function(e, sel){
      try{
        const key = e?.key || "";
        if(key === "Escape"){
          pairCloseSelectMenus();
          return;
        }
        if(key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== " ") return;
        if(!sel) return;
        if(sel.dataset?.pairSelect === "1"){
          e.preventDefault();
          if(key === "Enter" || key === " "){
            pairToggleSelectMenu(sel, e);
            return;
          }
          updatePairNavScopeFromElement(sel);
          stepSelectByKeyboard(sel.id, key === "ArrowDown" ? 1 : -1);
          return;
        }
        if(!sel.options || sel.options.length <= 0) return;
        e.preventDefault();
        updatePairNavScopeFromElement(sel);
        const dir = key === "ArrowDown" ? 1 : -1;
        if(sel.id && stepSelectByKeyboard(sel.id, dir)) return;
        const current = Math.max(0, Number(sel.selectedIndex || 0));
        const next = Math.max(0, Math.min(sel.options.length - 1, current + dir));
        if(next === current) return;
        sel.selectedIndex = next;
        sel.dispatchEvent(new Event("change", {bubbles:true}));
      }catch(err){
        console.error("[phanmon] pair select keydown failed", err);
      }
    };

    renderTKB = function(id){
      if(VIEW_MODE === "phong"){
        return pvRenderClassRoomPair(id);
      }
      if(VIEW_MODE !== "lop"){
        return __origRenderTKB(id);
      }

      __origRenderTKB(id);
      const box = document.getElementById("tkb");
      if(!box) return;
      pvSetPairStack(box, "tkb-pair-lop-gv");
      const classTitle = "TKB lớp " + pvClassLabel(id);
      pvWrapMainTable(box, classTitle, pvClassMainTools(id), "main");
      try{
        const gv = pvEnsureTeacherForClass(id);
        const teachers = pvAllTeacherCodes(pvTeachersForClass(id));
        const tools = pvSelectHTML("pairTeacherSelect", teachers, gv, pvTeacherLabel, "pairSelectTeacher(this.value)");
        box.insertAdjacentHTML("beforeend", `<div id="tkbPairSupport">${pvPane("TKB giáo viên", tools, pvTeacherTableHTML(gv), "support", pvTeacherStatsHTML(gv))}</div>`);
      }catch(err){
        console.error("[phanmon] render teacher support failed", err);
        const fallback = '<div class="tkb-pair-empty">Chưa tải được TKB giáo viên</div>';
        box.insertAdjacentHTML("beforeend", `<div id="tkbPairSupport">${pvPane("TKB giáo viên", "", fallback, "support")}</div>`);
      }
      const mainTable = box.querySelector(".tkb-main-table");
      if(mainTable){
        mainTable.querySelectorAll("td[data-mon]").forEach(td=>{
          td.addEventListener("click", ()=>{
            const mon = td.dataset.mon || "";
            if(!mon) return;
            const gv2 = getTeacherForClassMon(getLopCanonById(id), mon);
            const list = teacherListFromValue(gv2);
            if(!list.length || teacherValueHas(gv2, currentGV)) return;
            currentGV = list[0];
            pvUpdateTeacherSupport(id);
          });
          td.ondblclick = (e)=>{
            handleCellDoubleAction(td, e);
          };
        });
      }
      pvBindSupportNav(box);
      pvBindTeacherSupportDrag(box);
    };

    function pvRenderClassRoomPair(classId){
      const id = classId || currentLop || (getFilteredLops()[0]?.id);
      if(!id){
        const box0 = document.getElementById("tkb");
        if(box0) box0.innerHTML = "";
        return;
      }
      currentLop = id;
      __origRenderTKB(id);
      const box = document.getElementById("tkb");
      if(!box) return;
      pvSetPairStack(box, "tkb-pair-lop-phong");
      pvWrapMainTable(box, "TKB lớp " + pvClassLabel(id), pvClassMainTools(id), "main");
      const rooms = pvRoomsForClass(id);
      const room = pvEnsureRoomForClass(id);
      const toolsRoom = rooms.length ? pvSelectHTML("pairRoomSelect", rooms, room, null, "pairSelectRoom(this.value)") : "";
      box.insertAdjacentHTML("beforeend", `<div id="tkbPairSupport">${pvPane("TKB phòng", toolsRoom, pvRoomTableHTML(room), "support")}</div>`);
      pvBindSupportNav(box);
    }

    renderTKBTeacher = function(gvCode){
      if(VIEW_MODE !== "gv"){
        return __origRenderTKBTeacher(gvCode);
      }
      __origRenderTKBTeacher(gvCode);
      const box = document.getElementById("tkb");
      if(!box) return;
      pvSetPairStack(box, "tkb-pair-gv-phong");
      const gv = (gvCode || "").toString().trim();
      const title = "TKB giáo viên " + pvTeacherLabel(gv);
      const rooms = pvRoomsForTeacher(gv);
      const room = pvEnsureRoomForTeacher(gv);
      pvWrapMainTable(box, title, pvTeacherMainTools(gv), "main");
      const tools = pvSelectHTML("pairRoomSelect", rooms, room, null, "pairSelectRoom(this.value)");
      box.insertAdjacentHTML("beforeend", `<div id="tkbPairSupport">${pvPane("TKB phòng", tools, pvRoomTableHTML(room), "support")}</div>`);
      pvBindSupportNav(box);
    };

    renderTKBPhong = function(roomName){
      if(VIEW_MODE !== "phong"){
        return __origRenderTKBPhong(roomName);
      }
      currentPhong = (roomName || currentPhong || "").toString().trim();
      return pvRenderClassRoomPair(currentLop);
    };

    document.addEventListener("DOMContentLoaded", pvSetButtonText);
    pvSetButtonText();
  }catch(e){
    console.error("[phanmon] paired view patch failed", e);
  }
})();
