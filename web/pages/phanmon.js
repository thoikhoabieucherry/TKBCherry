window.__PHANMON_VERSION = "20260810-client-agent-retired-v1";
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

let resolvedSchoolParam = sanitizeOptionalSchoolId(rawSidParam || rawSchoolParam);
if(!resolvedSchoolParam){
  try{
    if(window.TKBAuth && typeof window.TKBAuth.loadRegistry === "function"){
      const reg = window.TKBAuth.loadRegistry() || {};
      const schools = reg.schools || {};
      const schoolKeys = Object.keys(schools);
      if(schoolKeys.length > 0){
        const activeEntry = window.TKBAuth.activeScheduleEntry ? window.TKBAuth.activeScheduleEntry(schoolKeys[0]) : null;
        if(activeEntry && activeEntry.sid){
          resolvedSchoolParam = sanitizeSchoolId(activeEntry.sid);
        }
      }
    }
  }catch(_){}
}

const schoolParam = resolvedSchoolParam || "default";
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
// 31/08: nếu lần nạp kho lúc mở trang THẤT BẠI (503 / mất mạng / hết phiên) thì DATA bên dưới chỉ là
// vỏ rỗng. Trước đây planner vẫn lưu ngay khi mở → ghi đè kho của trường bằng bản trống (trường
// fiwemj2uyk1, 31/08 20:17, mất 81 GV + 1266 tiết đã xếp). storage.js đã chặn ở đường lưu async
// (remoteSaveGuard); cờ này báo cho người dùng và chặn thêm đường XHR đồng bộ trong saveStore.
const __TKB_REMOTE_LOAD_FAILED = !!(window.TKBStorage && typeof window.TKBStorage.remoteLoadStateOf === "function"
  && schoolParam && window.TKBStorage.remoteLoadStateOf(schoolParam) === "failed");
if(__TKB_REMOTE_LOAD_FAILED){
  const __showGuard = () => { try{ window.TKBStorage.showStoreGuardBanner("Không nạp được dữ liệu trường từ máy chủ (mạng/máy chủ lỗi hoặc hết phiên đăng nhập). Trang này sẽ KHÔNG lưu gì để tránh ghi đè kho — hãy tải lại trang."); }catch(_){ } };
  if(document.body) __showGuard(); else document.addEventListener("DOMContentLoaded", __showGuard);
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

// Safe sync from remote store on load: NEVER overwrite newer or richer local data
if (typeof schoolParam !== "undefined" && schoolParam && !(window.TKBStorage && window.TKBStorage.remoteOnly)) {
  try{ window.__TKB_PLANNER_REMOTE_HYDRATION_PENDING = true; }catch(_){ }
  const remoteLoader = window.TKBStorage && window.TKBStorage.loadRemoteSchoolData
    ? window.TKBStorage.loadRemoteSchoolData(schoolParam)
    : fetch(`/api/school/store?id=${encodeURIComponent(schoolParam)}`).then(r => r.json());
  remoteLoader.then(remoteData => {
    const hasRemote = !!(remoteData && Object.keys(remoteData).length > 0 && (remoteData.lop?.length > 0 || remoteData.mon?.length > 0 || (remoteData.tkb && Object.keys(remoteData.tkb).length > 0)));
    if (hasRemote) {
      const localHasData = !!(DATA && (DATA.lop?.length > 0 || DATA.mon?.length > 0 || (DATA.tkb && Object.keys(DATA.tkb).length > 0)));

      const countTkbPlaced = (tkbObj) => {
        if(!tkbObj || typeof tkbObj !== "object") return 0;
        let count = 0;
        const allDays = ["thu2","thu3","thu4","thu5","thu6","thu7","T2","T3","T4","T5","T6","T7"];
        for(const c in tkbObj){
          for(const d of allDays){
            const dayObj = tkbObj[c]?.[d];
            if(dayObj){
              for(const p of ["sang","chieu"]){
                const arr = dayObj[p] || [];
                for(const cell of arr) if(cell && cell !== "OFF") count++;
              }
            }
          }
        }
        return count;
      };

      const remotePlaced = countTkbPlaced(remoteData.tkb);
      const localPlaced = countTkbPlaced(DATA.tkb);
      const remoteTs = Number(remoteData?._lastModified || remoteData?._updatedAt || 0) || 0;
      const localTs = Number(DATA?._lastModified || DATA?._updatedAt || 0) || 0;

      const acceptRemote = !localHasData || (remoteTs > localTs && remotePlaced >= localPlaced) || (localPlaced === 0 && remotePlaced > 0);

      if (acceptRemote) {
        const remoteDataStr = JSON.stringify(remoteData);
        if (remoteDataStr !== JSON.stringify(DATA)) {
          if(!(window.TKBStorage && window.TKBStorage.remoteOnly)){
            localStorage.setItem(PRIMARY_STORE_KEY, remoteDataStr);
          }
          DATA = remoteData;
          try { tkbNormalizeDataNFC(DATA); } catch(_) {}   // 31/08: NFC trước khi dùng
          try { tkbJointClearStalePins(); } catch(_) {}    // 31/08: ghim tạm còn sót từ lượt giải dở
          try { tkbJointTakeSnapshot(); } catch(_) {}   // 29/08: ảnh chụp tiết chung theo dữ liệu vừa nạp
          try { renderCurrentView(); } catch(_) {}
          try { loadMonList(); } catch(_) {}
        }
      } else if (localHasData && localPlaced >= remotePlaced) {
        // Local is newer or has equal/more progress: push local to remote VPS so VPS is up-to-date
        try {
          fetch(`/api/school/store?id=${encodeURIComponent(schoolParam)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(DATA)
          }).catch(() => {});
        } catch(_) {}
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
        try{ if(typeof tkbJointTakeSnapshot === "function") tkbJointTakeSnapshot(); }catch(_){ }   // 29/08 tiết chung
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
// PERF 21/08: dragover ban lien tuc (moi lan chuot nhich ~vai chuc lan/giay) ma
// validateDrop quet toan bo lop de tim trung GV/phong -> keo tha giat. Trong MOT
// luot keo, DATA khong doi nen ket qua validate cua tung o giu nguyen: cache theo
// td, xoa khi bat dau/ket thuc keo (applyDragVisual/clearDragVisual).
const DRAG_VALIDATE_CACHE = new Map(); // td -> ket qua validate cua luot keo hien tai
// 13/09: ke hoach doi cho khi tha de (tkbDropSwapPlan) cua luot keo hien tai; bang lop va
// bang GV cung o dich dung chung mot ke hoach. Xoa cung luc voi DRAG_VALIDATE_CACHE.
const DRAG_SWAP_PLAN_CACHE = new Map();
const DRAG_SWAP_PAINT_BUDGET_MS = 150;

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

// Ham thuan: cung chuoi vao => cung ket qua. Render 1 lop goi toi hon 46.000 lan
// nhung chi voi vai chuc ten khac nhau, nen nho ket qua theo ten.
const CLASS_ALIAS_CACHE = new Map();
const CLASS_ALIAS_CACHE_MAX = 5000;

function legacyClassNameAliases(name){
  const raw = (name||"").toString().trim();
  const cachedAliases = CLASS_ALIAS_CACHE.get(raw);
  // tra ban sao de noi goi tu do sap xep/them bot ma khong hong cache
  if(cachedAliases) return cachedAliases.slice();
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
  if(CLASS_ALIAS_CACHE.size >= CLASS_ALIAS_CACHE_MAX) CLASS_ALIAS_CACHE.clear();
  CLASS_ALIAS_CACHE.set(raw, out);
  return out.slice();
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
  // Kept as a compatibility hook for older callers.  Explicit PCCM periods
  // are now an authored snapshot, even when they equal Tiết chuẩn. Removing
  // them here would make a later Tiết chuẩn edit silently rewrite Phân công.
  return false;
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

// 31/08: Chuẩn hoá Unicode NFC tại chỗ (shared/storage.js normalizeUnicodeNFC): mã/tên GV dán từ
// Mac/Excel ở dạng NFD ("Hà" = "Ha" + U+0300) không khớp chuỗi NFC app sinh trong phân công →
// "ĐP.Hà" hiện 2 lần ở danh sách GV (vị trí thật trống, bản trùng mã nằm cuối). Chạy ở mọi điểm
// nạp dữ liệu và trước mỗi lần lưu; KHÔNG tính là "thay đổi" để không ép lưu ngay lúc tải trang.
function tkbNormalizeDataNFC(root){
  const fn = window.TKBStorage && window.TKBStorage.normalizeUnicodeNFC;
  if(typeof fn !== "function") return false;
  return !!fn(root);
}
function tkbNFC(value){
  const str = (value ?? "").toString();
  return (typeof str.normalize === "function") ? str.normalize("NFC") : str;
}

function sanitizePlannerDataFromIndex(){
  let changed = false;
  if(!DATA || typeof DATA !== "object") return false;
  try{ tkbNormalizeDataNFC(DATA); }catch(_){ }
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
  // Don muc giao vien-theo-tiet mau thuan voi Phan cong (xem chu thich o
  // pruneLessonTeacherConflicts): mot muc sai o day lam lech ca thong ke lan
  // ket qua xep.
  try{ if(pruneLessonTeacherConflicts() > 0) changed = true; }catch(_){ }

  if(changed){
    try{ invalidatePccmNumCaches(); }catch(_){ }
    try{ COMPUTE_MONS_CACHE = {refs: [], values: new Map()}; }catch(_){ }
    try{ REQUIRED_SUBJECTS_CACHE = {refs: [], values: new Map()}; }catch(_){ }
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

function looksLikeCode(s){
  const str = (s||"").toString().trim();
  return str && str.length <= 10 && !/\s/.test(str) && /^[A-Za-z0-9_.-]+$/.test(str);
}

/* Chi muc ma giao vien.
   Ban cu quet tuyen tinh ca DATA.giaovien cho MOI lan goi, va teacherOrderIndex
   con goi resolveTeacherCode mot lan cho TUNG giao vien => doi 1 lop trong
   planner ton ~1,0s (resolveTeacherCode bi goi hon 141.000 lan). Dung Map mot
   lan roi tra O(1). Cache tu huy khi mang giao vien bi thay the/doi so luong,
   va bi xoa tuong minh o saveStore(). */
let TEACHER_CODE_INDEX = { ref: null, len: -1, byCode: new Map(), byName: new Map(), orderByCode: new Map() };

function invalidateTeacherCodeIndex(){
  TEACHER_CODE_INDEX = { ref: null, len: -1, byCode: new Map(), byName: new Map(), orderByCode: new Map() };
}

function ensureTeacherCodeIndex(){
  const list = Array.isArray(DATA.giaovien) ? DATA.giaovien : [];
  if(TEACHER_CODE_INDEX.ref === list && TEACHER_CODE_INDEX.len === list.length){
    return TEACHER_CODE_INDEX;
  }
  const byCode = new Map();
  const byName = new Map();
  const orderByCode = new Map();
  list.forEach((g, i)=>{
    const code = tkbNFC(g?.magv).trim();   // 31/08: so sánh sau NFC
    if(code){
      const k = code.toLowerCase();
      // ban ghi xuat hien truoc thang, dung nhu find/findIndex cu
      if(!byCode.has(k)) byCode.set(k, code);
      if(!orderByCode.has(k)) orderByCode.set(k, i);
    }
    const full = tkbNFC(`${(g?.hodem||"").toString().trim()} ${(g?.ten||"").toString().trim()}`).trim().toLowerCase();
    // luu ca ma rong: khi do resolveTeacherCode tra nguyen van input nhu ban cu
    if(full && !byName.has(full)) byName.set(full, code);
  });
  TEACHER_CODE_INDEX = { ref: list, len: list.length, byCode, byName, orderByCode };
  return TEACHER_CODE_INDEX;
}

function resolveTeacherCode(input){
  const raw = tkbNFC(input).trim();   // 31/08: NFD/NFC cùng một mã
  if(!raw) return "";
  const lower = raw.toLowerCase();

  const index = ensureTeacherCodeIndex();
  const byCode = index.byCode.get(lower);
  if(byCode) return byCode;

  const byName = index.byName.get(lower);
  if(byName) return byName;

  return raw;
}

function teacherOrderIndex(code){
  const c = resolveTeacherCode(code).toLowerCase();
  if(!c) return Number.MAX_SAFE_INTEGER;
  const pos = ensureTeacherCodeIndex().orderByCode.get(c);
  return pos === undefined ? Number.MAX_SAFE_INTEGER : pos;
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

/* Thứ tự môn ĐÚNG NHƯ bảng "Môn học" trong phần app (thứ tự dòng DATA.monhoc).
   Dùng cho danh sách "Chưa phân" để người dùng đối chiếu dễ. Môn không có
   trong bảng Môn học rơi xuống cuối, fallback sort theo mã như cũ. */
let MON_HOC_ORDER_CACHE = { ref: null, len: -1, map: new Map() };

function monHocOrderIndex(mon){
  const list = Array.isArray(DATA.monhoc) ? DATA.monhoc : [];
  if(MON_HOC_ORDER_CACHE.ref !== list || MON_HOC_ORDER_CACHE.len !== list.length){
    const map = new Map();
    list.forEach((m, i)=>{
      // ghi index cho MỌI alias của môn (tên + mã) để khớp bất kể tasks lưu dạng nào
      monRecordAliases(m).forEach(alias=>{
        const key = monCanonicalKey(alias);
        if(key && !map.has(key)) map.set(key, i);
      });
    });
    MON_HOC_ORDER_CACHE = { ref: list, len: list.length, map };
  }
  const idx = MON_HOC_ORDER_CACHE.map.get(monCanonicalKey(mon));
  return idx === undefined ? Number.MAX_SAFE_INTEGER : idx;
}

function compareMonByMonHocOrder(a,b){
  const aa = typeof a === "object" ? (a?.ten || a?.mon || a?.key || "") : a;
  const bb = typeof b === "object" ? (b?.ten || b?.mon || b?.key || "") : b;
  const ai = monHocOrderIndex(aa);
  const bi = monHocOrderIndex(bb);
  if(ai !== bi) return ai - bi;
  return compareMonByHiddenCode(aa, bb);
}

function getMonShort(mon){
  const mh = findMonHoc(mon);
  if(!mh){
    // 29/08: khoá dạy ghép -> nhãn người dùng đặt (chip môn, thống kê, RB, xuất file…)
    try{ const g = tkbGhepRowByIdentity(mon); if(g) return tkbGhepLabelOf(g) || (mon||"").toString().trim(); }catch(_){ }
    return (mon||"").toString().trim();
  }
  const ten = (mh.ten||"").toString().trim();
  const ma = (mh.ma||"").toString().trim();
  const ma2 = (mh.ma2||"").toString().trim();
  // 01/09 (chủ dự án): ô TKB hiện ĐÚNG "Mã môn học" người dùng đặt trong bảng Môn học,
  // không tự chọn alias ngắn nhất nữa — trước đây mã "HĐTN-HN 1" bị hiện thành tên
  // "Chào cờ" chỉ vì tên ngắn hơn, đổi mã trong app mà TKB không đổi theo.
  return ma || ma2 || ten || (mon||"").toString().trim();
}

// Quet toan bo DATA.lop moi lan goi; render 1 lop goi ~150 lan (~200ms) nhung
// chi voi vai chuc ten lop => nho ket qua theo ten, huy khi mang lop doi.
let CLASS_KEY_CANDIDATES_CACHE = { ref: null, len: -1, values: new Map() };

function invalidateClassKeyCandidatesCache(){
  CLASS_KEY_CANDIDATES_CACHE = { ref: null, len: -1, values: new Map() };
}

function classKeyCandidates(input){
  const lopList = Array.isArray(DATA.lop) ? DATA.lop : [];
  if(CLASS_KEY_CANDIDATES_CACHE.ref !== lopList || CLASS_KEY_CANDIDATES_CACHE.len !== lopList.length){
    CLASS_KEY_CANDIDATES_CACHE = { ref: lopList, len: lopList.length, values: new Map() };
  }
  const raw = (input||"").toString().trim();
  const cachedKeys = CLASS_KEY_CANDIDATES_CACHE.values.get(raw);
  if(cachedKeys) return cachedKeys.slice();

  const out = [];
  const add = (v)=>{
    const s = (v||"").toString().trim();
    if(s && !out.includes(s)) out.push(s);
  };
  const addAliases = (v)=>legacyClassNameAliases(v).forEach(add);
  addAliases(raw);
  const rawAliases = legacyClassNameAliases(raw).map(v => v.toLowerCase());
  lopList.forEach(lop=>{
    const vals = [classCanonFromLop(lop), lop?.id, lop?.ten, lop?.ten2].map(v => (v||"").toString().trim()).filter(Boolean);
    const ownAliases = [];
    vals.forEach(v=>legacyClassNameAliases(v).forEach(a=>{
      if(a && !ownAliases.includes(a)) ownAliases.push(a);
    }));
    const matches = ownAliases.some(v => rawAliases.includes(v.toLowerCase()));
    if(!matches) return;
    vals.forEach(addAliases);
  });
  CLASS_KEY_CANDIDATES_CACHE.values.set(raw, out);
  return out.slice();
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

  // 19/08 SUA THU TU UU TIEN — day la goc cua "thong ke sai" va "khong xep
  // duoc". TRUOC day tkbLessonTeachers duoc tra TRUOC pccmMatrix. Bang do luu
  // giao vien theo TUNG TIET DA XEP va co ca khoa theo TEN DAY DU cua mon, nen
  // mot muc cu/sai kieu:
  //     tkbLessonTeachers["7/2|Hoat dong trai nghiem huong nghiep"] = "Phuong"
  // se DE LEN phan cong that cua nguoi dung:
  //     pccmMatrix["7/2|TNHN"] = "Phuong"   (khac dau, khac nguoi!)
  // Hau qua do duoc tren truong that: 7/2, 8/2, 8/5 mon Toan/TNHN bi gan cho
  // co Phuong (Le Thi Hoa) thay vi thay Phuong (Nguyen Dang) -> thong ke lech,
  // bam vao o thong ke nhay sai nguoi, va bo giai (dung PCCM) mau thuan voi
  // giao dien (dung bang nay) nen tiet bi coi la trung va bi go ra.
  // PHAN CONG LA NGUON SU THAT: tra PCCM truoc, bang tiet chi la du phong.
  for(const k of tries){
    const v = DATA.pccmMatrix?.[k];
    if(v){
      const out = teacherValueFromRaw(v);
      cache.set(cacheKey, out);
      return out;
    }
  }
  for(const k of tries){
    const v = DATA.tkbLessonTeachers?.[k];
    if(v){
      const out = teacherValueFromRaw(v);
      cache.set(cacheKey, out);
      return out;
    }
  }
  cache.set(cacheKey, "");
  return "";
}

// Dong bo cac muc trong tkbLessonTeachers mau thuan voi Phan cong (so sanh co
// xet bi danh cua mon, vi khoa co the la ten ngan hoac ten day du). Muc sai
// duoc GHI DE bang gia tri Phan cong chu KHONG bi xoa. Chay mot lan khi nap
// du lieu; tra ve so muc da sua.
function pruneLessonTeacherConflicts(){
  const lt = DATA.tkbLessonTeachers;
  if(!lt || typeof lt !== "object") return 0;
  let removed = 0;
  for(const key of Object.keys(lt)){
    const parts = String(key).split("|");
    if(parts.length < 2) continue;
    const cls = parts[0];
    const mon = parts.slice(1).join("|");
    let pccmValue = "";
    try{
      const mh = findMonHoc(mon);
      const subjects = [mon];
      if(mh){
        [mh.ma, mh.ten, mh.ma2, mh.id].forEach(v => {
          const t = String(v || "").trim();
          if(t && !subjects.includes(t)) subjects.push(t);
        });
      }
      for(const subject of subjects){
        const v = DATA.pccmMatrix?.[`${cls}|${subject}`];
        if(v){ pccmValue = String(v); break; }
      }
    }catch(_){ continue; }
    if(!pccmValue) continue;
    const a = teacherListFromValue(lt[key]).map(x => x.toLowerCase()).sort().join(",");
    const b = teacherListFromValue(pccmValue).map(x => x.toLowerCase()).sort().join(",");
    if(a && b && a !== b){
      // KHONG xoa du lieu: ghi de bang gia tri Phan cong (nguon su that) de
      // vua het mau thuan vua giu nguyen dong du lieu cua nguoi dung.
      lt[key] = pccmValue;
      removed += 1;
    }
  }
  if(removed > 0){
    try{ TEACHER_FOR_CLASS_MON_CACHE = {pccmRef: null, lessonRef: null, monRef: null, monhocRef: null, values: new Map()}; }catch(_){ }
    try{ console.warn(`[TKB] Da dong bo ${removed} muc giao vien theo tiet cho khop Phan cong`); }catch(_){ }
  }
  return removed;
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
  try{ REQUIRED_SUBJECTS_CACHE = {refs: [], values: new Map()}; }catch(_){}
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
  // PERF 21/08: ham nay chi duoc goi giua mot luot tha (maybeRaiseSessionLimitForDrop);
  // luu dong bo o day + luu cua onDrop = 2 lan "khung" cho MOT lan tha -> luu tre.
  try{ saveStoreDeferred(); }catch(e){ console.error("saveStore failed", e); }
  return true;
}
function cellMon(v){
  if(v === "OFF" || v === "" || v == null) return "";
  if(typeof v === "string") return v;
  if(typeof v === "object" && v.mon) return v.mon;
  return "";
}
function isFixed(v){ return (v && typeof v === "object" && v.fixed); }
// Ô dạng cũ "Môn - GV" (chuỗi). 29/08: CHỈ khi cả chuỗi không phải môn đã phân công của lớp —
// nhãn/khoá môn dạy ghép như "AI - 1" là một môn, "1" không phải giáo viên.
function cellLegacyTeacher(v, classCanon){
  if(typeof v !== "string" || !v.includes(" - ")) return "";
  try{ if(getTeacherForClassMon(classCanon, v)) return ""; }catch(_){ }
  return v.split(" - ").slice(1).join(" - ").trim();
}

function getLopCanonById(lopId){
  const id = (lopId||"").toString();
  const lop = (DATA.lop||[]).find(l=>String(l.id) === id);
  if(!lop) return normalizeClassName(id) || id;
  return (classCanonFromLop(lop) || normalizeClassName(lop.id) || id).toString().trim();
}

/* 28/08 Dạy ghép (modules/day-ghep.js). Một dòng dạy ghép = {lop:[lớp…], mon:[môn…],
   gv:[…], ten, viettat}. 29/08: mọi dòng là "môn ghép" riêng, không liên quan môn
   thật: `ten` = KHOÁ app tự sinh (đứng sau "Lớp|" trong phân công, lưu trong ô TKB),
   `viettat` = NHÃN người dùng đặt tùy ý (hiện trên TKB).
   29/08 chiều (chủ dự án chốt lại): dòng NHIỀU LỚP = MỘT TIẾT HỌC CHUNG — các lớp
   học cùng lúc (hội trường), mọi GV của dòng cùng dạy. Mỗi lớp thấy tiết đó trong
   TKB của mình (đếm 1 tiết/lớp), mỗi GV thấy MỘT ô (các lớp gộp, đếm 1 tiết), cùng
   GV ở các lớp của dòng tại cùng giờ KHÔNG phải trùng lịch. Xem khối "TIẾT HỌC CHUNG". */
function tkbGhepRowFor(classRef, mon){
  const rows = Array.isArray(DATA?.dayGhep) ? DATA.dayGhep : [];
  if(!rows.length) return null;
  const monRaw = String(mon || "").trim();
  if(!monRaw) return null;
  const monLow = monRaw.toLowerCase();
  // 29/08: classRef có thể là MÃ lớp (L001) hay TÊN lớp (6.1 — bảng lớp truyền canon);
  // getLopCanonById("6.1") có thể chuẩn hoá thành "6A1"/"6/1" nên so với MỌI bí danh.
  const names = new Set();
  const add = v => { const t = String(v || "").trim().toLowerCase(); if(t) names.add(t); };
  add(classRef);
  try{ add(getLopCanonById(classRef)); }catch(_){ }
  try{ if(typeof classKeyCandidates === "function") classKeyCandidates(getLopCanonById(classRef) || classRef).forEach(add); }catch(_){ }
  if(!names.size) return null;
  for(const row of rows){
    if(!row || !Array.isArray(row.lop) || !row.lop.some(x => names.has(String(x || "").trim().toLowerCase()))) continue;
    if(String(row.ten || "").trim().toLowerCase() === monLow) return row;
  }
  return null;
}

// Dòng dạy ghép có khoá `ten` = mon (không cần biết lớp) — cho các chỗ hiển thị chung.
function tkbGhepRowByIdentity(mon){
  const rows = Array.isArray(DATA?.dayGhep) ? DATA.dayGhep : [];
  if(!rows.length) return null;
  const monLow = String(mon || "").trim().toLowerCase();
  if(!monLow) return null;
  return rows.find(row => row && String(row.ten || "").trim().toLowerCase() === monLow) || null;
}

function tkbGhepLabelOf(row){
  return String(row?.viettat || "").trim() || String(row?.ten || "").trim();
}

// 02/09: dòng dạy ghép KHÔNG giáo viên (modules/day-ghep.js gv:[]) — tiết chiếm ô của lớp,
// máy tự xếp, không chiếm ai. Không có khoá pccmMatrix nên các chỗ dùng "có GV phân công" làm
// điều kiện "là tiết thật" (Chưa phân, thống kê lớp/trường) phải nhận thêm trường hợp này.
function tkbGhepRowHasNoTeacher(row){
  if(!row) return false;
  const gv = Array.isArray(row.gv) ? row.gv : String(row.gv || "").split(/[,;+\n]+/);
  return !gv.some(x => String(x || "").trim());
}

function tkbIsNoTeacherGhep(classRef, mon){
  if(!Array.isArray(DATA?.dayGhep) || !DATA.dayGhep.length) return false;
  let row = null;
  try{ row = tkbGhepRowFor(classRef, mon); }catch(_){ row = null; }
  return !!row && tkbGhepRowHasNoTeacher(row);
}

// Nhãn môn hiện trên TKB / danh sách Chưa phân: nhãn dòng dạy ghép nếu (lớp, môn) thuộc một dòng, không thì mã môn.
function tkbMonLabel(classRef, mon){
  try{
    const row = tkbGhepRowFor(classRef, mon) || tkbGhepRowByIdentity(mon);
    const label = row ? tkbGhepLabelOf(row) : "";
    if(label) return label;
  }catch(_){ }
  return getMonShort(mon);
}

// ======================= TIẾT HỌC CHUNG NHIỀU LỚP (Dạy ghép) =======================
// Chủ dự án 29/08: "Toán ghép 6A1 + 6A2, thầy A + thầy B, 1 tiết" = MỘT tiết: cả hai lớp
// cùng học ở cùng giờ, cả hai thầy cùng dạy; TKB mỗi lớp có tiết đó (1 tiết), TKB mỗi thầy
// có MỘT ô (đếm 1 tiết). Cài đặt:
//   - Ô của các lớp thành viên luôn được ĐỒNG BỘ (tkbJointReconcile) tại điểm chốt lưu
//     (saveStore/saveStoreDeferred): lớp nào vừa đổi (so với ảnh chụp lần trước) là "sự
//     thật", các lớp còn lại đặt/xóa/khóa theo. Không móc từng đường thao tác (28-29/08
//     móc onDrop/xóa/khóa đã sót đường khác -> ô lệch giữa các lớp).
//   - Trước khi kéo (validateDrop) kiểm ô cùng vị trí ở các lớp còn lại: ô nghỉ / ô cố
//     định môn khác -> chặn; ô đang có tiết khác -> hỏi rồi đưa về Chưa phân.
//   - Bảng GV gộp các lớp của tiết chung thành một ô, không tô trùng lịch; kiểm tra
//     trùng GV bỏ qua cặp ô cùng dòng.
//   - Bộ giải (Cherry / ▶ FET / Tối ưu v3) xếp từng lớp riêng nên trước mỗi lượt app GHIM
//     TẠM tiết chung vào cùng ô ở mọi lớp (fixed + jointPin) — engine v3 / FET giữ ô
//     cố định dùng chung GV; khi lượt giải kết thúc (cờ bận tắt) app BỎ GHIM (không để
//     lại ô "cố định" người dùng không xóa được).
function tkbJointGhepRows(){
  const rows = Array.isArray(DATA?.dayGhep) ? DATA.dayGhep : [];
  return rows.filter(r => r && Array.isArray(r.lop) && r.lop.length >= 2 && String(r.ten || "").trim());
}

function tkbJointRowKey(row){
  return String(row?.id || row?.ten || "").trim();
}

function tkbGhepSiblingClassIds(row, exceptClassId){
  const out = [];
  const names = (Array.isArray(row?.lop) ? row.lop : []).map(x => String(x || "").trim().toLowerCase()).filter(Boolean);
  if(!names.length) return out;
  const except = exceptClassId == null ? null : String(exceptClassId);
  (DATA?.lop || []).forEach(l => {
    if(!l || (except != null && String(l.id) === except)) return;
    const aliases = [getLopCanonById(l.id), l.ten2, l.ten, l.id].map(v => String(v || "").trim().toLowerCase()).filter(Boolean);
    if(aliases.some(a => names.includes(a))) out.push(String(l.id));
  });
  return out;
}

function tkbGhepMemberClassIds(row){
  return tkbGhepSiblingClassIds(row, null);
}

function tkbGhepJointRowAt(classId, mon){
  const row = tkbGhepRowFor(classId, mon);
  if(!row || !Array.isArray(row.lop) || row.lop.length < 2) return null;
  return row;
}

// Hai ô ở hai lớp khác nhau thuộc cùng một dòng dạy ghép nhiều lớp = MỘT tiết học chung.
function tkbIsJointGhepPair(monA, lopIdA, monB, lopIdB){
  if(String(lopIdA) === String(lopIdB)) return false;
  const rowA = tkbGhepJointRowAt(lopIdA, monA);
  if(!rowA) return false;
  return tkbGhepJointRowAt(lopIdB, monB) === rowA;
}

// Các ô TKB GV tại một giờ đều thuộc cùng một dòng nhiều lớp -> dòng đó, không thì null.
function tkbJointGhepRow(arr){
  if(!Array.isArray(arr) || arr.length < 2) return null;
  const row = tkbGhepJointRowAt(arr[0]?.classId, arr[0]?.mon);
  if(!row) return null;
  return arr.every(e => tkbGhepJointRowAt(e?.classId, e?.mon) === row) ? row : null;
}

function tkbJointClassLabel(row){
  return tkbGhepMemberClassIds(row).map(id => { try{ return getLopCanonById(id) || String(id); }catch(_){ return String(id); } }).join(", ");
}

// Gộp các ô cùng tiết chung (TKB GV, xuất file): entries [{classId, classDisplay, mon, ...}]
function tkbJointMergeEntries(list){
  const arr = Array.isArray(list) ? list : [];
  const row = tkbJointGhepRow(arr);
  if(!row) return arr;
  // 29/08 (chủ dự án): GV chỉ cần biết tiết đó dạy NỘI DUNG gì -> ô chỉ ghi tên viết tắt;
  // danh sách lớp để ở tooltip (jointClassLabel), không in trước tên.
  return [Object.assign({}, arr[0], {
    classDisplay: "",
    jointClassLabel: arr.map(e => String(e.classDisplay || "").trim()).filter(Boolean).join(", "),
    fixed: arr.some(e => !!e.fixed),
    jointClassIds: arr.map(e => String(e.classId))
  })];
}
try{ window.tkbJointMergeEntries = tkbJointMergeEntries; }catch(_){ }

function tkbJointSessions(){ return ["sang", "chieu"]; }

// Vị trí các ô của khoá `low` trong lớp: Map "thu|buoi|ti" -> "F" (cố định) | "-".
function tkbJointPlacements(classId, low){
  const out = new Map();
  const tkb = DATA?.tkb?.[classId];
  if(!tkb) return out;
  for(const thu of DAYS) for(const buoi of tkbJointSessions()){
    const arr = tkb?.[thu]?.[buoi];
    if(!Array.isArray(arr)) continue;
    for(let i = 0; i < arr.length; i++){
      const m = String(cellMon(arr[i]) || "").trim().toLowerCase();
      if(m && m === low) out.set(`${thu}|${buoi}|${i}`, isFixed(arr[i]) ? "F" : "-");
    }
  }
  return out;
}

function tkbJointSig(map){
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + v).join(";");
}

let __TKB_JOINT_SNAP = null;

function tkbJointTakeSnapshot(){
  const snap = new Map();
  tkbJointGhepRows().forEach(row => {
    const low = String(row.ten || "").trim().toLowerCase();
    const m = new Map();
    tkbGhepMemberClassIds(row).forEach(id => { if(DATA?.tkb?.[id]) m.set(id, tkbJointSig(tkbJointPlacements(id, low))); });
    snap.set(tkbJointRowKey(row), m);
  });
  __TKB_JOINT_SNAP = snap;
  return snap;
}

// Đồng bộ ô tiết chung giữa các lớp của từng dòng. Trả về {changed, displaced, blocked, rows}.
function tkbJointReconcile(opts){
  opts = opts || {};
  const res = {changed:false, displaced:[], blocked:[], rows:[]};
  if(!opts.force && typeof isPlannerBusySolving === "function" && isPlannerBusySolving()) return res;
  if(!__TKB_JOINT_SNAP && !opts.force){ tkbJointTakeSnapshot(); return res; }   // chưa có ảnh chụp: không đoán, chỉ chụp
  const rows = tkbJointGhepRows();
  const snap = __TKB_JOINT_SNAP || new Map();
  const next = new Map();
  rows.forEach(row => {
    const key = String(row.ten || "").trim();
    const low = key.toLowerCase();
    const rk = tkbJointRowKey(row);
    const members = tkbGhepMemberClassIds(row).filter(id => DATA?.tkb?.[id]);
    if(!members.length) return;
    const cur = new Map();
    const sigs = new Map();
    members.forEach(id => { const p = tkbJointPlacements(id, low); cur.set(id, p); sigs.set(id, tkbJointSig(p)); });
    const distinct = new Set(sigs.values());
    if(distinct.size > 1){
      const snapRow = snap.get(rk);
      const changed = members.filter(id => !snapRow || !snapRow.has(id) || snapRow.get(id) !== sigs.get(id));
      const changedSigs = new Set(changed.map(id => sigs.get(id)));
      let truthId = null;
      if(changed.length && changedSigs.size === 1){
        truthId = changed[0];                       // một lớp vừa đổi -> lớp đó là sự thật
      }else{
        // nhiều lớp cùng đổi (bộ giải, nạp lại, undo): trạng thái phổ biến nhất; hòa -> nhiều tiết hơn
        const count = new Map();
        members.forEach(id => { const sg = sigs.get(id); count.set(sg, (count.get(sg) || 0) + 1); });
        let best = null;
        members.forEach(id => {
          const sg = sigs.get(id); const c = count.get(sg); const n = cur.get(id).size;
          if(!best || c > best.c || (c === best.c && n > best.n)) best = {id, c, n};
        });
        truthId = best.id;
      }
      const truth = cur.get(truthId);
      const truthSig = sigs.get(truthId);
      members.forEach(id => {
        if(id === truthId || sigs.get(id) === truthSig) return;
        const tkb = DATA.tkb[id];
        cur.get(id).forEach((_, sk) => {
          if(truth.has(sk)) return;
          const [thu, buoi, ti] = sk.split("|");
          tkb[thu][buoi][Number(ti)] = "";
          res.changed = true;
        });
        truth.forEach((flag, sk) => {
          const [thu, buoi, tiS] = sk.split("|");
          const ti = Number(tiS);
          const arr = tkb?.[thu]?.[buoi];
          if(!Array.isArray(arr)){ res.blocked.push({classId:id, thu, buoi, ti, why:"chưa có bảng TKB"}); return; }
          const cell = arr[ti];
          if(cell === "OFF"){ res.blocked.push({classId:id, thu, buoi, ti, why:"ô nghỉ"}); return; }
          const m = String(cellMon(cell) || "").trim();
          if(m && m.toLowerCase() !== low){
            if(isFixed(cell)){ res.blocked.push({classId:id, thu, buoi, ti, why:`ô cố định ${tkbMonLabel(id, m)}`}); return; }
            res.displaced.push({classId:id, mon:m, thu, buoi, ti});
          }else if(m && (isFixed(cell) ? "F" : "-") === flag){
            return;
          }
          arr[ti] = (flag === "F") ? {mon:key, fixed:true} : key;
          res.changed = true;
        });
      });
      res.rows.push({row, truthId});
    }
    const m2 = new Map();
    members.forEach(id => m2.set(id, tkbJointSig(tkbJointPlacements(id, low))));
    next.set(rk, m2);
  });
  __TKB_JOINT_SNAP = next;
  if(res.changed){
    try{ window.__TKB_UNASSIGNED_TASKS_CACHE = null; window.__TKB_TEACHER_TKB_STATS_CACHE = null; }catch(_){ }
  }
  return res;
}

function tkbJointReconcileMessage(res){
  if(!res || !res.rows || !res.rows.length) return "";
  const cls = id => { try{ return getLopCanonById(id) || String(id); }catch(_){ return String(id); } };
  const parts = [];
  res.rows.forEach(r => {
    const name = String(r.row?.viettat || r.row?.ten || "").trim();
    parts.push(`Tiết chung "${name}" đã đồng bộ theo lớp ${cls(r.truthId)}.`);
  });
  if(res.displaced.length) parts.push(`Đưa về Chưa phân: ${res.displaced.map(d => `${getMonShort(d.mon)}-${cls(d.classId)}`).join(", ")}.`);
  if(res.blocked.length) parts.push(`Không đặt được ở: ${res.blocked.map(b => `${cls(b.classId)} (${b.why})`).join("; ")}.`);
  return parts.join(" ");
}

// Gọi tại điểm chốt lưu. Chỉ báo khi thật sự có đồng bộ.
function tkbJointReconcileAtSave(){
  let res = null;
  try{ res = tkbJointReconcile(); }catch(err){ console.error("joint reconcile", err); return null; }
  if(res && res.rows.length){
    const msg = tkbJointReconcileMessage(res);
    if(msg){ try{ _setStatus(msg, res.blocked.length ? "warning" : "ok"); }catch(_){ } }
    try{ if(res.displaced.length) res.displaced.forEach(d => flashLopItemConflict(d.classId)); }catch(_){ }
  }
  return res;
}

// Kiểm ô cùng vị trí ở các lớp còn lại trước khi đặt tiết chung vào classId.
function tkbJointSiblingBlockers(classId, mon, thu, buoi, ti){
  const row = tkbGhepJointRowAt(classId, mon);
  if(!row) return null;
  const low = String(row.ten || "").trim().toLowerCase();
  const idx = Number(ti);
  const out = {row, blocked:[], displace:[]};
  tkbGhepSiblingClassIds(row, classId).forEach(sid => {
    const arr = DATA?.tkb?.[sid]?.[thu]?.[buoi];
    if(!Array.isArray(arr)) return;
    const cell = arr[idx];
    if(cell === "OFF"){ out.blocked.push({classId:sid, why:"ô nghỉ"}); return; }
    const m = String(cellMon(cell) || "").trim();
    if(!m || m.toLowerCase() === low) return;
    if(isFixed(cell)){ out.blocked.push({classId:sid, why:`ô cố định ${tkbMonLabel(sid, m)}`}); return; }
    out.displace.push({type:"joint", lopId:sid, mon:m, thu, buoi, ti:idx,
      msg:`Lớp ${getLopCanonById(sid)} đang có ${getMonShort(m)} ở tiết chung này`});
  });
  return out;
}

// ---- Ghim tạm trước khi giải ----
let __TKB_JOINT_PINNED = [];
function tkbJointPinnedCount(){ return __TKB_JOINT_PINNED.length; }

// GV của dòng có tiết ở lớp NGOÀI nhóm tại ô này?
function tkbGhepTeachersBusyOutside(row, memberIds, thu, buoi, ti){
  const gvs = Array.isArray(row?.gv) ? row.gv.join(", ") : String(row?.gv || "");
  if(!gvs) return false;
  const members = new Set(memberIds.map(String));
  const tkbs = DATA.tkb || {};
  for(const lopId of Object.keys(tkbs)){
    if(members.has(String(lopId))) continue;
    const cell = tkbs[lopId]?.[thu]?.[buoi]?.[ti];
    if(!cell || cell === "OFF") continue;
    const mon = cellMon(cell);
    if(!mon) continue;
    const gv2 = getTeacherForClassMon(getLopCanonById(lopId), mon);
    if(gv2 && teacherValuesIntersect(gv2, gvs)) return true;
  }
  return false;
}

// Ghim: mọi tiết chung đang có -> fixed (jointPin); dòng còn thiếu tiết -> chọn ô mọi lớp cùng
// trống (GV không bận ngoài nhóm, không ô nghỉ, tôn trọng giới hạn/buổi, trải ngày) rồi ghi vào
// mọi lớp. allowDisplace: được đưa tiết khác về Chưa phân khi không còn ô nào cùng trống
// (chỉ lượt xếp đầy đủ; lane tối ưu không xếp tiết thiếu nên không được đè).
function tkbJointPinForSolve(opts){
  opts = opts || {};
  const allowDisplace = opts.allowDisplace === true;
  const out = {changed:false, pinned:[], displaced:0, skipped:[]};
  __TKB_JOINT_PINNED = [];   // lượt mới: bỏ sổ ghim cũ
  try{ tkbJointReconcile({force:true}); }catch(_){ }
  const sessions = tkbJointSessions();
  const sessionLen = b => (b === "chieu" ? CHIEU : SANG);
  tkbJointGhepRows().forEach(row => {
    const key = String(row.ten || "").trim();
    const low = key.toLowerCase();
    const label = String(row.viettat || key);
    const members = tkbGhepMemberClassIds(row).filter(id => DATA.tkb?.[id]);
    if(members.length < 2){ out.skipped.push({row:label, why:"chưa đủ 2 lớp có bảng TKB"}); return; }
    const need = Math.max(1, Number(row.sotiet) || 1);
    const gh = Math.max(1, Number(row.gioihan) || 1);
    const gvList = Array.isArray(row.gv) ? row.gv : [];
    const same = v => String(cellMon(v) || "").trim().toLowerCase() === low;

    const slots = [];
    for(const thu of DAYS) for(const buoi of sessions){
      const n = sessionLen(buoi);
      for(let ti = 0; ti < n; ti++){
        let have = 0, displace = 0, blocked = false;
        for(const id of members){
          const arr = DATA.tkb[id]?.[thu]?.[buoi];
          const cell = Array.isArray(arr) ? arr[ti] : undefined;
          if(cell === "OFF"){ blocked = true; break; }
          if(same(cell)){ have += 1; continue; }
          if(cellMon(cell)){
            if(isFixed(cell) || !allowDisplace){ blocked = true; break; }
            displace += 1;
          }
        }
        if(blocked) continue;
        if(have === 0){
          if(gvList.some(gv => isTeacherFixedOff(gv, thu, buoi, ti))) continue;
          if(tkbGhepTeachersBusyOutside(row, members, thu, buoi, ti)) continue;
        }
        slots.push({thu, buoi, ti, have, displace});
      }
    }
    const chosen = [];
    const usedDays = new Set();
    const usedSession = new Map();
    const take = sl => { chosen.push(sl); usedDays.add(sl.thu); const k = `${sl.thu}|${sl.buoi}`; usedSession.set(k, (usedSession.get(k) || 0) + 1); };
    // 1) ô đã có tiết chung (đã đồng bộ nên mọi lớp đều có) -> giữ nguyên chỗ người dùng/bộ giải đã đặt
    slots.filter(sl => sl.have > 0).forEach(take);
    // 2) bổ sung cho đủ `need`
    while(chosen.length < need){
      const cand = slots.filter(sl => !chosen.includes(sl) && (usedSession.get(`${sl.thu}|${sl.buoi}`) || 0) < gh);
      if(!cand.length) break;
      cand.sort((a, b) =>
        (a.displace - b.displace)
        || ((usedDays.has(a.thu) ? 1 : 0) - (usedDays.has(b.thu) ? 1 : 0))
        || (DAYS.indexOf(a.thu) - DAYS.indexOf(b.thu)) || (sessions.indexOf(a.buoi) - sessions.indexOf(b.buoi)) || (a.ti - b.ti));
      take(cand[0]);
    }
    if(!chosen.length){ out.skipped.push({row:label, why:"không còn ô nào mọi lớp cùng trống"}); return; }
    if(chosen.length < need) out.skipped.push({row:label, why:`chỉ ghim được ${chosen.length}/${need} tiết`});

    const isChosen = (thu, buoi, ti) => chosen.some(sl => sl.thu === thu && sl.buoi === buoi && sl.ti === ti);
    let rowChanged = false;
    members.forEach(id => {
      const tkb = DATA.tkb[id];
      for(const thu of DAYS) for(const buoi of sessions){
        const arr = tkb?.[thu]?.[buoi];
        if(!Array.isArray(arr)) continue;
        for(let ti = 0; ti < arr.length; ti++){
          const cell = arr[ti];
          if(!isChosen(thu, buoi, ti)) continue;
          const wasFixed = same(cell) && isFixed(cell) && !cell.jointPin;
          if(wasFixed) continue;                       // người dùng tự khóa: giữ nguyên, không bỏ ghim sau này
          if(cellMon(cell) && !same(cell)) out.displaced += 1;
          arr[ti] = {mon:key, fixed:true, jointPin:true};
          __TKB_JOINT_PINNED.push({classId:id, thu, buoi, ti, key});
          rowChanged = true;
        }
      }
    });
    if(rowChanged){
      out.changed = true;
      out.pinned.push({row:label, classes:members.length, slots:chosen.map(sl => `${sl.thu}/${sl.buoi}/${sl.ti + 1}`)});
    }
  });
  try{ tkbJointTakeSnapshot(); }catch(_){ }
  if(out.changed){
    try{ window.__TKB_UNASSIGNED_TASKS_CACHE = null; window.__TKB_TEACHER_TKB_STATS_CACHE = null; }catch(_){ }
  }
  return out;
}

function tkbJointPinMessage(res){
  if(!res) return "";
  const parts = [];
  if(res.pinned && res.pinned.length) parts.push(`Giữ ${res.pinned.length} tiết chung nhiều lớp cùng ô trong lượt xếp (${res.pinned.map(p => `${p.row}: ${p.slots.join(", ")}`).join("; ")}).`);
  if(res.displaced) parts.push(`${res.displaced} tiết khác được đưa về Chưa phân để bộ giải xếp lại.`);
  if(res.skipped && res.skipped.length) parts.push(`Chưa ghim được: ${res.skipped.map(sk => `${sk.row} (${sk.why})`).join("; ")}.`);
  return parts.join(" ");
}

// Bỏ ghim sau lượt giải: ô ghim tạm trở lại ô thường (người dùng xóa/kéo như tiết khác).
// Sổ ghim được GIỮ tới lượt ghim kế tiếp: bridge có thể áp kết quả (mang fixed:true từ payload)
// SAU khi cờ bận đã tắt -> saveStore(trustedSolverApply) gọi lại hàm này để gỡ lần nữa.
function tkbJointUnpin(){
  const list = __TKB_JOINT_PINNED;
  let changed = false;
  list.forEach(p => {
    const arr = DATA?.tkb?.[p.classId]?.[p.thu]?.[p.buoi];
    if(!Array.isArray(arr)) return;
    const cell = arr[p.ti];
    if(!cell || cell === "OFF") return;
    if(String(cellMon(cell) || "").trim().toLowerCase() !== p.key.toLowerCase()) return;
    if(isFixed(cell)){ arr[p.ti] = p.key; changed = true; }
  });
  // ô ghim còn sót (kết quả bộ giải giữ cờ jointPin) -> bỏ luôn
  Object.keys(DATA?.tkb || {}).forEach(id => {
    const tkb = DATA.tkb[id];
    for(const thu of DAYS) for(const buoi of tkbJointSessions()){
      const arr = tkb?.[thu]?.[buoi];
      if(!Array.isArray(arr)) continue;
      for(let ti = 0; ti < arr.length; ti++){
        const cell = arr[ti];
        if(cell && typeof cell === "object" && cell.jointPin){ arr[ti] = cellMon(cell); changed = true; }
      }
    }
  });
  try{ tkbJointReconcile({force:true}); }catch(_){ }
  if(changed){
    try{ window.__TKB_UNASSIGNED_TASKS_CACHE = null; window.__TKB_TEACHER_TKB_STATS_CACHE = null; }catch(_){ }
    try{ saveStoreDeferred(); }catch(_){ }
    try{ renderCurrentView(); }catch(_){ }
    try{ loadMonList(); }catch(_){ }
  }
  return changed;
}

// Gỡ ghim không lưu/vẽ lại (dùng bên trong saveStore để tránh gọi đệ quy).
function tkbJointUnpinQuiet(){
  let changed = false;
  __TKB_JOINT_PINNED.forEach(p => {
    const arr = DATA?.tkb?.[p.classId]?.[p.thu]?.[p.buoi];
    if(!Array.isArray(arr)) return;
    const cell = arr[p.ti];
    if(!cell || cell === "OFF") return;
    if(String(cellMon(cell) || "").trim().toLowerCase() !== p.key.toLowerCase()) return;
    if(isFixed(cell)){ arr[p.ti] = p.key; changed = true; }
  });
  if(changed){ try{ window.__TKB_UNASSIGNED_TASKS_CACHE = null; window.__TKB_TEACHER_TKB_STATS_CACHE = null; }catch(_){ } try{ tkbJointTakeSnapshot(); }catch(_){ } }
  return changed;
}

// 31/08: Ghim tạm chỉ có nghĩa TRONG lượt giải. Pin gọi saveStoreDeferred nên ô {fixed, jointPin}
// có thể nằm lại trong kho nếu trang bị tải lại / đóng giữa lượt (F5, mất mạng, đóng tab) — khi đó
// không còn cờ bận nào tắt để kích tkbJointUnpin → người dùng thấy tiết ghép "tự xếp vào TKB và cố
// định luôn" (trường ow14iqw5cb1: Chào cờ (ghép) 37 lớp). Gọi ở mọi điểm nạp dữ liệu khi không giải.
function tkbJointClearStalePins(){
  if(typeof isPlannerBusySolving === "function" && isPlannerBusySolving()) return 0;
  let n = 0;
  Object.keys(DATA?.tkb || {}).forEach(id => {
    const tkb = DATA.tkb[id];
    for(const thu of DAYS) for(const buoi of ["sang", "chieu"]){
      const arr = tkb?.[thu]?.[buoi];
      if(!Array.isArray(arr)) continue;
      for(let ti = 0; ti < arr.length; ti++){
        const cell = arr[ti];
        if(cell && typeof cell === "object" && cell.jointPin){ arr[ti] = cellMon(cell); n += 1; }
      }
    }
  });
  if(n){
    __TKB_JOINT_PINNED = [];
    try{ window.__TKB_UNASSIGNED_TASKS_CACHE = null; window.__TKB_TEACHER_TKB_STATS_CACHE = null; }catch(_){ }
    try{ tkbJointTakeSnapshot(); }catch(_){ }
  }
  return n;
}
try{ window.tkbJointClearStalePins = tkbJointClearStalePins; }catch(_){ }

// Ghim trước lượt giải (gọi từ ▶ FET / bridge Cherry / Tối ưu v3). Trả về thông điệp (có thể rỗng).
function tkbJointPinBeforeSolve(opts){
  let pin = null;
  try{ pin = tkbJointPinForSolve(opts || {}); }catch(err){ console.error("pin ghep", err); return ""; }
  if(pin && pin.changed){
    try{ saveStoreDeferred(); }catch(_){ }
    try{ renderCurrentView(); }catch(_){ }
  }
  return tkbJointPinMessage(pin);
}
try{ window.tkbJointPinBeforeSolve = tkbJointPinBeforeSolve; window.tkbJointUnpin = tkbJointUnpin; }catch(_){ }

// Cờ bận của bộ giải tắt -> bỏ ghim (một điểm chốt cho mọi lane: Cherry, FET, Tối ưu v3, Dừng).
(function installJointUnpinOnSolveEnd(){
  const names = ["__TKB_RUST_SOLVER_RUNNING", "__TKB_SOLVE_UI_BUSY", "__ACTIVE_TKB_FET_WORKER"];
  const store = {};
  let timer = 0;
  names.forEach(n => {
    store[n] = window[n];
    try{
      Object.defineProperty(window, n, {
        configurable:true, enumerable:true,
        get(){ return store[n]; },
        set(v){
          store[n] = v;
          if(timer || !__TKB_JOINT_PINNED.length) return;
          if(typeof isPlannerBusySolving === "function" && isPlannerBusySolving()) return;
          timer = setTimeout(()=>{ timer = 0; try{ tkbJointUnpin(); }catch(err){ console.error("unpin ghep", err); } }, 0);
        }
      });
    }catch(_){ }
  });
})();

// jointMon: môn đang đặt vào lớp ignoreLopId — ô cùng dòng dạy ghép nhiều lớp ở lớp khác là
// cùng MỘT tiết chung, không tính là trùng GV.
function findTeacherConflictAtSlot(teacherCode, thu, buoi, ti, ignoreLopId, jointMon){
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
    if(jointMon && ignoreLopId && tkbIsJointGhepPair(jointMon, ignoreLopId, mon, lopId)) continue;
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
  if(opts.replaceHistoryCurrent === true && payload && !usedStable){
    // Metadata that belongs to the current timetable (for example the
    // two-click Automatic cycle) must travel with that history entry without
    // becoming a separate Undo step. Otherwise Undo can restore the identical
    // visible timetable with stale metadata and accidentally repeat a solve.
    TKB_HISTORY_CURRENT = payload;
    __tkbUpdateHistoryButtons();
    return;
  }
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
  try{ tkbJointTakeSnapshot(); }catch(_){ }   // 29/08 tiết chung: lịch sử đã nhất quán, chụp lại
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
  flushDeferredSaveStore();
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
  flushDeferredSaveStore();
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
  if(typeof DATA === "object" && DATA){
    DATA._lastModified = Date.now();
    DATA._updatedAt = Date.now();
  }
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
  const guardWorse = !!(worse && (running || (opts.guardUnstable && running)));
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
// PERF 18/08: keo/tha & sua tung o — don phan LUU (sanitize + stringify + localStorage
// + day server + history) ve sau 500ms yen lang thay vi chay dong bo theo TUNG o
// (truong lon: moi luot luu ton hang tram ms => keo tha "khung"). DATA trong bo nho
// da doi ngay nen render/solve van dung; chi phan persist duoc gom lo.
// Flush ngay khi: roi trang/an tab, Undo/Redo, hoac truoc khi chay xep/toi uu.
let __tkbDeferredSaveTimer = null;
// 30/08: planner CÓ thay đổi chưa đẩy lên kho không? (còn hẹn lưu, hoặc DATA khác
// bản đã lưu/nạp gần nhất). Chưa có mốc so sánh (vừa mở trang) = chưa sửa gì.
function __tkbHasUnsavedChanges(){
  if(__tkbDeferredSaveTimer) return true;
  if(!__tkbLastSavedPayload) return false;
  try{ return JSON.stringify(DATA) !== __tkbLastSavedPayload; }catch(_){ return true; }
}
// 30/08: CHỈ ghi khi có thay đổi chưa lưu. Trước đây hàm này luôn ghi đè kho bằng bản
// planner đang giữ mỗi khi ẩn tab / tải lại trang -> nếu trang Dữ liệu (tab khác) vừa
// đổi tên môn/GV, xoá môn, xoá phân công… thì bản cũ của planner xoá sạch các sửa đổi đó
// ("đổi tên không đồng bộ", "xoá bên app mà qua Sắp xếp vẫn còn").
function flushDeferredSaveStore(){
  const pending = !!__tkbDeferredSaveTimer;
  if(__tkbDeferredSaveTimer){
    clearTimeout(__tkbDeferredSaveTimer);
    __tkbDeferredSaveTimer = null;
  }
  if(!pending && !__tkbHasUnsavedChanges()) return;
  try{ saveStore({ force: true, beforeUnload: true, syncRemote: true }); }catch(e){ console.error("deferred saveStore failed", e); }
}

/* ===== 30/08: Nạp lại bản mới nhất từ kho khi quay lại tab (hai tab Dữ liệu + Sắp xếp) =====
   Trang Dữ liệu lưu ngay mỗi thao tác; planner đang mở ở tab khác vẫn giữ bản cũ trong bộ
   nhớ. Khi tab planner hiện lại / được focus mà KHÔNG có sửa đổi chưa lưu và không đang giải,
   đọc kho: khác bản đang giữ -> thay DATA, vẽ lại. Có sửa đổi chưa lưu thì giữ nguyên. */
let __tkbRemoteRefreshInFlight = false;
let __tkbRemoteRefreshLastAt = 0;
function __tkbDataStamp(d){
  const n = Number(d?._lastModified || d?._updatedAt || 0);
  return Number.isFinite(n) ? n : 0;
}
// JSON với khoá đã sắp (máy chủ trả khoá theo thứ tự bảng chữ) — chỉ dùng khi thiếu mốc thời gian.
function __tkbStableJson(v){
  if(Array.isArray(v)) return "[" + v.map(__tkbStableJson).join(",") + "]";
  if(v && typeof v === "object"){
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + __tkbStableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}
function tkbRemoteDataDiffers(remote){
  if(!remote || typeof remote !== "object") return false;
  const rt = __tkbDataStamp(remote), lt = __tkbDataStamp(DATA);
  if(rt || lt) return rt !== lt;
  try{ return __tkbStableJson(remote) !== __tkbStableJson(DATA); }catch(_){ return false; }
}
function tkbPlannerIdleForRemoteRefresh(){
  try{ if(typeof isPlannerBusySolving === "function" && isPlannerBusySolving()) return false; }catch(_){ }
  try{ if(__tkbAlgorithmRunning()) return false; }catch(_){ }
  if(window.__TKB_PLANNER_REMOTE_HYDRATION_PENDING === true) return false;
  if(__tkbPendingSavePayload) return false;
  if(typeof dragData !== "undefined" && dragData) return false;
  if(__tkbHasUnsavedChanges()) return false;
  return true;
}
function tkbAdoptRemoteData(remote, reason){
  DATA = (remote && typeof remote === "object") ? remote : {};
  if(!DATA.tkb) DATA.tkb = {};
  if(!DATA.lop) DATA.lop = [];
  if(!DATA.mon) DATA.mon = [];
  if(!DATA.monhoc) DATA.monhoc = [];
  if(!DATA.pccmMatrix) DATA.pccmMatrix = {};
  if(!DATA.pccmRoomMatrix) DATA.pccmRoomMatrix = {};
  if(!DATA.pccmTietMatrix) DATA.pccmTietMatrix = {};
  if(!DATA.pccmGioihanMatrix) DATA.pccmGioihanMatrix = {};
  if(!DATA.tkbUserOff || typeof DATA.tkbUserOff !== "object") DATA.tkbUserOff = {};
  try{ if(!Object.getOwnPropertyDescriptor(window, "DATA")?.get) window.DATA = DATA; }catch(_){ }
  try{ tkbJointClearStalePins(); }catch(_){ }   // 31/08: ghim tạm còn sót từ lượt giải dở
  try{ tkbJointTakeSnapshot(); }catch(_){ }   // 29/08 tiết chung: ảnh chụp theo bản vừa nạp
  try{ sanitizePlannerDataFromIndex(); }catch(_){ }
  try{ invalidateTeacherCodeIndex(); invalidateClassKeyCandidatesCache(); }catch(_){ }
  try{ invalidatePccmNumCaches(); }catch(_){ }
  try{ COMPUTE_MONS_CACHE = {refs: [], values: new Map()}; }catch(_){ }
  try{ REQUIRED_SUBJECTS_CACHE = {refs: [], values: new Map()}; }catch(_){ }
  try{ TEACHER_FOR_CLASS_MON_CACHE = {pccmRef: null, lessonRef: null, monRef: null, monhocRef: null, values: new Map()}; }catch(_){ }
  try{ ROOM_FOR_CLASS_MON_CACHE = {roomRef: null, lessonRef: null, monRef: null, monhocRef: null, values: new Map()}; }catch(_){ }
  try{ window.TKBConstraints?.invalidateConstraintCache?.(); }catch(_){ }
  try{
    const payload = JSON.stringify(DATA);
    __tkbLastSavedPayload = payload;
    __tkbPendingSavePayload = "";
    __tkbRememberStablePayload(payload, __tkbCurrentSaveStats(), reason || "remote-refresh");
    TKB_HISTORY_CURRENT = payload;
    TKB_UNDO_STACK.length = 0;   // lịch sử cũ thuộc bản trước, Undo sẽ ghi đè bản mới -> bỏ
    TKB_REDO_STACK.length = 0;
    __tkbUpdateHistoryButtons();
  }catch(_){ }
  try{ initKhoiOptions(); }catch(_){ }
  try{ if(VIEW_MODE === "gv") showAllGV(); else showAllLop(); }catch(_){ }
  try{ renderCurrentView(); }catch(_){ }
  try{ scheduleLoadMonList("remote-refresh"); }catch(_){ try{ loadMonList(); }catch(__){ } }
}
async function tkbRefreshFromRemoteIfIdle(reason){
  try{
    if(typeof schoolParam === "undefined" || !schoolParam) return false;
    if(!window.TKBStorage || typeof window.TKBStorage.loadRemoteSchoolData !== "function") return false;
    if(document.visibilityState !== "visible") return false;
    if(__tkbRemoteRefreshInFlight) return false;
    const now = Date.now();
    if(now - __tkbRemoteRefreshLastAt < 1500) return false;   // focus + visibilitychange bắn cùng lúc
    __tkbRemoteRefreshLastAt = now;
    if(!tkbPlannerIdleForRemoteRefresh()) return false;
    __tkbRemoteRefreshInFlight = true;
    const localBefore = JSON.stringify(DATA);
    const remote = await window.TKBStorage.loadRemoteSchoolData(schoolParam);
    if(!window.TKBStorage.hasMeaningfulData(remote)) return false;
    if(!tkbRemoteDataDiffers(remote)) return false;
    // Trong lúc chờ mạng người dùng có thể đã sửa -> không thay
    if(!tkbPlannerIdleForRemoteRefresh() || JSON.stringify(DATA) !== localBefore) return false;
    tkbAdoptRemoteData(remote, "remote-refresh:" + (reason || ""));
    try{ _setStatus("Đã nạp dữ liệu mới nhất vừa lưu ở trang Dữ liệu.", "ok"); }catch(_){ }
    return true;
  }catch(e){
    console.warn("tkbRefreshFromRemoteIfIdle failed", e);
    return false;
  }finally{
    __tkbRemoteRefreshInFlight = false;
  }
}
try{
  document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState === "visible") tkbRefreshFromRemoteIfIdle("visible"); });
  window.addEventListener("focus", ()=>tkbRefreshFromRemoteIfIdle("focus"));
  window.tkbRefreshFromRemoteIfIdle = tkbRefreshFromRemoteIfIdle;
  window.__tkbHasUnsavedChanges = __tkbHasUnsavedChanges;
}catch(_){ }
function saveStoreDeferred(){
  try{ tkbJointReconcileAtSave(); }catch(_){ }   // 29/08: đồng bộ tiết chung nhiều lớp trước khi lưu/vẽ
  if(__tkbDeferredSaveTimer) clearTimeout(__tkbDeferredSaveTimer);
  __tkbDeferredSaveTimer = setTimeout(()=>{
    __tkbDeferredSaveTimer = null;
    try{ saveStore({ force: true }); }catch(e){ console.error("deferred saveStore failed", e); }
  }, 300);
}
try{
  window.addEventListener("pagehide", flushDeferredSaveStore);
  window.addEventListener("beforeunload", flushDeferredSaveStore);
  document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState === "hidden") flushDeferredSaveStore(); });
}catch(_){ }
window.flushDeferredSaveStore = flushDeferredSaveStore;

function saveStore(options){
  let opts = options || {};
  if(opts.trustedSolverApply !== true){ try{ tkbJointReconcileAtSave(); }catch(_){ } }
  else if(typeof isPlannerBusySolving === "function" && !isPlannerBusySolving() && __TKB_JOINT_PINNED.length){
    // 29/08: kết quả bộ giải áp sau khi cờ bận tắt -> ô ghim tạm quay lại "cố định" -> gỡ lần nữa
    try{ tkbJointUnpinQuiet(); }catch(_){ }
  }
  // Du lieu vua doi => cac chi muc tra cuu co the cu.
  // (TEACHER_LIST_FILTER_CACHE khong can xoa o day: planner chi DOC pccmMatrix/
  //  giaovien/lop — cache do tu miss khi cac object nay bi thay the boi remote
  //  load, va xoa o day se pha cache dung luc toggle Co dinh dang can no.)
  try{ invalidateTeacherCodeIndex(); invalidateClassKeyCandidatesCache(); }catch(_){ }
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
  // 31/08: chặn ghi đè kho khi bản đang giữ là vỏ rỗng do nạp thất bại (xem storage.js remoteSaveGuard).
  // Phải chặn ở đây vì nhánh XHR đồng bộ bên dưới không đi qua TKBStorage.saveRemoteSchoolData.
  try{
    if(window.TKBStorage && typeof window.TKBStorage.remoteSaveGuard === "function" && typeof schoolParam !== "undefined" && schoolParam){
      const guard = window.TKBStorage.remoteSaveGuard(schoolParam, payload);
      if(!guard.ok){
        window.TKBStorage_lastSaveError = { status: 0, kind: guard.kind, message: guard.message };
        console.warn("Remote school store save blocked:", guard.kind);
        try{ if(typeof _setStatus === "function") _setStatus(guard.message, "error"); }catch(_){ }
        try{ window.TKBStorage.showStoreGuardBanner(guard.message); }catch(_){ }
        return opts.awaitRemote ? Promise.resolve(false) : false;
      }
    }
  }catch(_){ }
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
      // /api/school/store yeu cau Bearer token. Thieu header nay thi may chu
      // luon tra 401 va moi lan luu deu ton mot vong hong truoc khi roi ve
      // duong luu async (TKBStorage.saveSchoolData) — chinh la dong
      // "Sync remote store save failed 401" trong console.
      try{
        const authHeaders = (window.TKBAuthApi && typeof window.TKBAuthApi.getAuthHeaders === "function")
          ? window.TKBAuthApi.getAuthHeaders()
          : null;
        if(authHeaders && authHeaders.Authorization){
          xhr.setRequestHeader("Authorization", authHeaders.Authorization);
        }
      }catch(_){ }
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
        body: payload,
        keepalive: true
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
    if(payload){
      localStorage.setItem("TKB_PERSISTENT_DATA_BACKUP", payload);
      if(typeof schoolParam !== "undefined" && schoolParam) localStorage.setItem("TKB_PERSISTENT_DATA_BACKUP::" + schoolParam, payload);
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



/* [REMOVED] Section: heuristic_optimize */

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

/* Quet ca DATA.pccmMatrix (hon 1.000 key) moi lan goi, bi goi 2 lan cho MOI
   luot render — chiem ~30ms trong cu "khung nhe" khi double-click Co dinh.
   Ket qua chi phu thuoc (giaovien, pccmMatrix, lop, khoi dang loc) nen cache
   theo cac ref do; toggle co dinh/keo tha khong lam thay doi chung. */
let TEACHER_LIST_FILTER_CACHE = { pccmRef: null, gvRef: null, lopRef: null, khoi: "", value: null };

function invalidateTeacherListFilterCache(){
  TEACHER_LIST_FILTER_CACHE = { pccmRef: null, gvRef: null, lopRef: null, khoi: "", value: null };
}

function getTeacherListForCurrentFilter(){
  const cachedKhoi = document.getElementById("chonKhoi")?.value || "";
  const c = TEACHER_LIST_FILTER_CACHE;
  if(c.value
      && c.pccmRef === DATA.pccmMatrix
      && c.gvRef === DATA.giaovien
      && c.lopRef === DATA.lop
      && c.khoi === cachedKhoi){
    // tra ban sao nong: noi goi co the sort/loc tuy y ma khong pha cache
    return c.value.slice();
  }

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
  const khoiSel = cachedKhoi;
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
  TEACHER_LIST_FILTER_CACHE = {
    pccmRef: DATA.pccmMatrix,
    gvRef: DATA.giaovien,
    lopRef: DATA.lop,
    khoi: cachedKhoi,
    value: arr
  };
  return arr.slice();
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
  if(!__TKB_JOINT_SNAP){ try{ tkbJointTakeSnapshot(); }catch(_){ } }   // ảnh chụp tiết chung lúc nạp trang
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
        let gv = (typeof v === "object" && v.gv) ? v.gv : cellLegacyTeacher(v, classCanon);
        // Ô "Chào cờ" trần chỉ bỏ qua khi trường KHÔNG có môn thật mang tên đó (bản rất cũ
        // tự chèn, không GV); nếu là alias của môn thật (vd HĐTN-HN 1 tên "Chào cờ") vẫn tra
        // GVCN — không thì TKB GV thiếu tiết dù TKB lớp có (trường fiwemj2uyk1, 01/09).
        if(!gv && (mon !== "Chào cờ" || findMonHoc(mon))){
          gv = getTeacherForClassMon(classCanon, mon);
        }
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
        let gv = (typeof v === "object" && v.gv) ? v.gv : cellLegacyTeacher(v, classCanon);
        // Ô "Chào cờ" trần chỉ bỏ qua khi trường KHÔNG có môn thật mang tên đó (bản rất cũ
        // tự chèn, không GV); nếu là alias của môn thật (vd HĐTN-HN 1 tên "Chào cờ") vẫn tra
        // GVCN — không thì TKB GV thiếu tiết dù TKB lớp có (trường fiwemj2uyk1, 01/09).
        if(!gv && (mon !== "Chào cờ" || findMonHoc(mon))){
          gv = getTeacherForClassMon(classCanon, mon);
        }
        if(gv && teacherValueHas(gv, code)){
          const room = getRoomForClassMon(classCanon, mon);
          sched[thu].chieu[ti].push({classId, classDisplay, mon, room, fixed: !!isFixed(v)});
        }
      }
    }
  });

  return sched;
}

// Ô TKB giáo viên: >1 lớp cùng tiết = trùng lịch, TRỪ các lớp của cùng một tiết học chung
// (Dạy ghép nhiều lớp) -> gộp thành MỘT ô "6A1, 6A2 <nhãn>", đếm 1 tiết.
function tkbTeacherCellView(arr){
  const list = Array.isArray(arr) ? arr : [];
  const merged = tkbJointMergeEntries(list);
  if(merged !== list) return {entries: merged, conflict: false};
  return {entries: list, conflict: list.length > 1};
}

function cellHTMLTeacher(entries, thu, buoi, ti, gvCode){
  const arr = Array.isArray(entries) ? entries : [];
  const view = tkbTeacherCellView(arr);
  const conflict = view.conflict;
  const teacherOff = isTeacherFixedOff(gvCode, thu, buoi, ti);
  const offConflict = teacherOff && arr.length > 0;
  const fixed = !teacherOff && arr.length > 0 && arr.some(e=>!!e.fixed);

  const lines = view.entries.map(e=>{
    const monShort = tkbMonLabel(e.classId, e.mon);
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
  const one = view.entries.length === 1 ? view.entries[0] : null;   // ô tiết chung gộp -> thao tác theo lớp đầu, các lớp còn lại đồng bộ
  const oneAttrs = one
    ? ` data-classid="${escapeHtml(String(one.classId))}" data-mon="${escapeHtml(String(one.mon || ""))}"`
      + (one.jointClassLabel ? ` title="${escapeHtml(`Tiết chung: ${one.jointClassLabel}`)}"` : "")
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
      if(ids.length === 1 || (td.dataset.classid || "").trim()){
        handleCellDoubleAction(td, e);
        return;
      }
      try{ e.preventDefault(); e.stopPropagation(); }catch(_){ }
      if(td.classList && !td.classList.contains("tkb-gv-conflict")) return;
      // nhiều lớp trong cùng tiết => báo xung đột
      const txt = (td.innerText || "").trim();
      alert("⚠ Trùng lịch (nhiều lớp cùng 1 tiết):\n" + txt);
    };
  });
}

function renderTKBTeacher(gvCode, forceFullRebuild = false){
  const box = document.getElementById("tkb");
  if(!box) return;
  box.classList.remove("tkb-pair-stack", "tkb-pair-lop-gv", "tkb-pair-gv-phong", "tkb-pair-lop-phong");

  const code = (gvCode||"").toString().trim();
  const name = getTeacherNameByCode(code);
  const title = document.getElementById("titleLop");
  // Theo yêu cầu: chỉ hiển thị TÊN GV (nếu không có tên thì fallback mã)
  if(title) title.innerText = name || code;

  const sched = buildTeacherSchedule(code);

  const existingTable = box.querySelector("table.table");
  if(!forceFullRebuild && existingTable){
    const tds = existingTable.querySelectorAll("td[data-thu][data-buoi][data-ti]");
    if(tds.length === DAYS.length * (SANG + CHIEU)){
      tds.forEach(td => {
        const thu = td.getAttribute("data-thu");
        const buoi = td.getAttribute("data-buoi");
        const ti = parseInt(td.getAttribute("data-ti"), 10);
        if(!thu || !buoi || isNaN(ti)) return;

        const entries = (buoi === "chieu") ? sched[thu]?.chieu?.[ti] : sched[thu]?.sang?.[ti];
        const arr = Array.isArray(entries) ? entries : [];
        const view = tkbTeacherCellView(arr);
        const conflict = view.conflict;
        const teacherOff = isTeacherFixedOff(code, thu, buoi, ti);
        const offConflict = teacherOff && arr.length > 0;
        const fixed = !teacherOff && arr.length > 0 && arr.some(e=>!!e.fixed);

        const lines = view.entries.map(e=>{
          const monShort = tkbMonLabel(e.classId, e.mon);
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
        const one = view.entries.length === 1 ? view.entries[0] : null;   // ô tiết chung gộp -> thao tác theo lớp đầu, các lớp còn lại đồng bộ

        const newClass = `${conflict?"tkb-gv-conflict":""} ${teacherOff?"tkb-off":""} ${offConflict?"tkb-off-conflict":""} ${fixed?"tkb-fixed":""}`.trim();
        if(td.className !== newClass) td.className = newClass;
        if(td.getAttribute("data-classids") !== classIds) td.setAttribute("data-classids", classIds);
        if(td.getAttribute("data-teacher") !== String(code || "")) td.setAttribute("data-teacher", String(code || ""));
        if(one){
          if(td.getAttribute("data-classid") !== String(one.classId)) td.setAttribute("data-classid", String(one.classId));
          if(td.getAttribute("data-mon") !== String(one.mon || "")) td.setAttribute("data-mon", String(one.mon || ""));
        } else {
          td.removeAttribute("data-classid");
          td.removeAttribute("data-mon");
        }

        const inner = `<div class="tkb-gv-cell">${visibleLines}</div>`;
        if(td.innerHTML !== inner){
          td.innerHTML = inner;
        }
      });
      return;
    }
  }

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
    const monShort = tkbMonLabel(e.classId, e.mon);
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
      + (one.jointClassLabel ? ` title="${escapeHtml(`Tiết chung: ${one.jointClassLabel}`)}"` : "")
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
      if(ids.length === 1 || (td.dataset.classid || "").trim()){
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

  // 31/08: ĐÃ BỎ migrateRemoveLegacyDefaultFixedEvents() (di sản v1.69). Hàm đó chạy MỖI lần tải trang,
  // xóa ô "Chào cờ" ở Thứ 2/sáng/tiết 1 và "SHL" ở Thứ 6/chiều/tiết cuối (mặc định tự chèn của bản rất cũ)
  // rồi saveStore() ngay → người dùng tự cố định Chào cờ đúng ô đó (trường 0l2vcan0xx1, 59 lớp) cứ F5 là mất
  // và kho bị ghi đè bằng bản đã xóa. Mặc định tự chèn đã bỏ từ lâu (tkbConfig.fixed = []) nên không còn gì để dọn.
  // Test khóa: e2e_tests/planner_fixed_chao_co_survives_load_node.test.js
  try{ migrateInvalidPartialSchedule(); }catch(_){ }
  // 31/08: ô ghim tạm {fixed, jointPin} còn sót (tải lại giữa lượt giải) -> trả về ô thường
  try{ tkbJointClearStalePins(); }catch(_){ }   // không ép lưu lúc tải; bản sạch đi cùng lần lưu kế tiếp
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

let STATS_BOX_RENDER_REQUEST = 0;
let STATS_BOX_RENDER_FRAME = 0;
let STATS_BOX_RENDER_TIMER = 0;
let STATS_BOX_RENDER_IDLE = 0;

function renderStatsBoxLoading(){
  const box = document.getElementById("statsBox");
  if(!box) return;
  box.classList.add("is-loading");
  box.setAttribute("aria-live", "polite");
  box.innerHTML = '<div class="stats-loading" role="status"><span class="stats-loading-dot" aria-hidden="true"></span><span>Đang cập nhật thống kê…</span></div>';
}

function cancelScheduledStatsBoxRender(){
  STATS_BOX_RENDER_REQUEST++;
  if(STATS_BOX_RENDER_FRAME){
    try{ cancelAnimationFrame(STATS_BOX_RENDER_FRAME); }catch(_){ }
    STATS_BOX_RENDER_FRAME = 0;
  }
  if(STATS_BOX_RENDER_TIMER){
    try{ clearTimeout(STATS_BOX_RENDER_TIMER); }catch(_){ }
    STATS_BOX_RENDER_TIMER = 0;
  }
  if(STATS_BOX_RENDER_IDLE){
    try{ cancelIdleCallback(STATS_BOX_RENDER_IDLE); }catch(_){ }
    STATS_BOX_RENDER_IDLE = 0;
  }
}

function scheduleStatsBoxRender(options={}){
  cancelScheduledStatsBoxRender();
  const requestId = ++STATS_BOX_RENDER_REQUEST;
  const pop = document.getElementById("statsPopover");
  if(options.onlyIfOpen !== false && (!pop || pop.hidden)) return requestId;

  STATS_BOX_RENDER_FRAME = requestAnimationFrame(()=>{
    STATS_BOX_RENDER_FRAME = 0;
    if(requestId !== STATS_BOX_RENDER_REQUEST) return;
    try{
      renderStatsBox();
    }catch(err){
      console.warn("renderStatsBox failed", err);
    }finally{
      pop?.removeAttribute("aria-busy");
    }
  });
  return requestId;
}

function refreshStatsBoxIfOpen(){
  const pop = document.getElementById("statsPopover");
  if(!pop || pop.hidden) return false;
  pop.setAttribute("aria-busy", "true");
  scheduleStatsBoxRender({onlyIfOpen:true});
  return true;
}

function setStatsPopoverOpen(open){
  const pop = document.getElementById("statsPopover");
  const btn = document.getElementById("statsToggle");
  if(!pop || !btn) return;
  const shouldOpen = !!open;
  if(shouldOpen){
    // Paint the popover first.  On a large timetable the detailed teacher and
    // student scans can take several seconds; doing them inside the click
    // handler made the button look dead (and left a text caret in the focused
    // button).  Keep the last rendered values when available and refresh them
    // in a macrotask after the browser has had a chance to paint.
    pop.hidden = false;
    pop.removeAttribute("aria-busy");
    const box = document.getElementById("statsBox");
    if(box && !box.innerHTML.trim()) renderStatsBoxLoading();
    renderStatsBox();
  }else{
    cancelScheduledStatsBoxRender();
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
window.scheduleStatsBoxRender = scheduleStatsBoxRender;
window.refreshStatsBoxIfOpen = refreshStatsBoxIfOpen;

function openStatsPopoverDuringSolve(){
  setStatsPopoverOpen(true);
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
  if(!ten){
    try{ const g = tkbGhepRowByIdentity(raw); if(g) return tkbGhepLabelOf(g) || raw; }catch(_){ }
  }
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
  // Khong dong dropdown "Chua phan" o day: click item trong menu cung di qua
  // selectLop, va nguoi dung muon menu mo lien tuc de keo nhieu tiet.
  // (Click ra ngoai da co listener pointerdown toan cuc lo viec dong.)
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

  // 26/08: dang xep thi CHI XEM — van dung DATA trong bo nho de ve luoi,
  // nhung khong ghi kho (luot xep se ap ket qua va luu sau; ghi xen giua co
  // the dam vao ban luu cua luot dang chay).
  const __solvingReadOnly = (typeof isPlannerBusySolving === "function") && isPlannerBusySolving();
  if(!DATA.tkb[id]){
    // Mặc định: KHÔNG tự động xếp vào TKB, chỉ tạo khung trống + cố định (nếu có)
    DATA.tkb[id] = taoTKBTheoConfig([], DATA.tkbConfig);
    if(!__solvingReadOnly) saveStore();
  }else if(ensureClassTkbShape(id)){
    if(!__solvingReadOnly) saveStore({force:true});
  }

  renderTKB(id);
  scheduleLoadMonList("selectLop");
}



/* [REMOVED] Section: auto_sort_all */

/* ======================= RENDER TKB ======================= */
function renderTKB(id, forceFullRebuild = false){
  const box = document.getElementById("tkb");
  if(!box) return;
  box.classList.remove("tkb-pair-stack", "tkb-pair-lop-gv", "tkb-pair-gv-phong", "tkb-pair-lop-phong");

  const lop = (DATA.lop||[]).find(x=>x.id==id);
  if(ensureClassTkbShape(id)){
    try{ saveStore({force:true}); }catch(_){ }
  }
  const tkb = DATA.tkb?.[id];
  if(!tkb) return;
  const lopCanon = getLopCanonById(id);
  const __t = document.getElementById("titleLop");
  if (__t) __t.innerText = "TKB lớp " + (classCanonFromLop(lop) || id);

  const existingTable = box.querySelector("table.table");
  if(!forceFullRebuild && existingTable){
    const tds = existingTable.querySelectorAll("td[data-thu][data-buoi][data-ti]");
    if(tds.length === DAYS.length * (SANG + CHIEU)){
      tds.forEach(td => {
        const thu = td.getAttribute("data-thu");
        const buoi = td.getAttribute("data-buoi");
        const ti = parseInt(td.getAttribute("data-ti"), 10);
        if(!thu || !buoi || isNaN(ti)) return;

        const v = tkb[thu]?.[buoi]?.[ti];
        const off = (v === "OFF");
        const fixed = isFixed(v);
        const mon = off ? "" : (fixed ? (v.mon||"") : (cellMon(v)||""));
        let teacher = "";
        let title = "";
        let body = "";
        if(!off){
          const view = tkbClassCellView(lopCanon, mon);
          teacher = view.teacher;
          title = view.title;
          body =
            `<div class="tkb-cell-stack">`+
              mobileStackCellLineHTML(view.monShort, view.teacherShort, "tkb-class-line tkb-lesson-line")+
            `</div>`;
        }

        const newClass = `${off?'tkb-off':''} ${fixed?'tkb-fixed':''}`.trim();
        if(td.className !== newClass) td.className = newClass;
        if(td.getAttribute("data-mon") !== mon) td.setAttribute("data-mon", mon);
        if(td.getAttribute("data-teacher") !== teacher) td.setAttribute("data-teacher", teacher);
        if(td.title !== title) td.title = title;
        const dragVal = off ? "false" : "true";
        if(td.getAttribute("draggable") !== dragVal) td.setAttribute("draggable", dragVal);
        if(td.innerHTML !== body) td.innerHTML = body;
      });
      return;
    }
  }

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
// Nội dung ô bảng LỚP: {monShort, teacher, teacherShort, title}. 29/08 (chủ dự án): ô môn dạy ghép
// chỉ ghi tên viết tắt — chuỗi "GV1, GV2, GV3, GV4" quá dài; GV (và các lớp cùng tiết chung) vào tooltip.
function tkbClassCellView(lopCanon, mon){
  const monShort = tkbMonLabel(lopCanon, mon);
  const teacher = getTeacherForClassMon(lopCanon, mon);
  let teacherShort = getTeacherShort(teacher);
  const teacherFull = getTeacherNameByCode(teacher) || teacher;
  let title = [mon, teacherFull].filter(Boolean).join(" - ");
  let ghepRow = null;
  try{ ghepRow = tkbGhepRowFor(lopCanon, mon); }catch(_){ ghepRow = null; }
  if(ghepRow){
    teacherShort = "";
    const parts = [monShort];
    if(teacher) parts.push(`GV: ${teacherFull}`);
    else if(tkbGhepRowHasNoTeacher(ghepRow)) parts.push("Tiết không giáo viên");
    if(Array.isArray(ghepRow.lop) && ghepRow.lop.length >= 2) parts.push(`Tiết chung: ${ghepRow.lop.join(", ")}`);
    title = parts.join(" — ");
  }
  return {monShort, teacher, teacherShort, title};
}

function cellHTML(v, thu, buoi, ti, lopCanon){
  const off = (v === "OFF");
  const fixed = isFixed(v);
  const mon = off ? "" : (fixed ? (v.mon||"") : (cellMon(v)||""));
  let teacher = "";
  let title = "";
  let body = "";
  if(!off){
    const view = tkbClassCellView(lopCanon, mon);
    teacher = view.teacher;
    title = view.title;
    body =
      `<div class="tkb-cell-stack">`+
        mobileStackCellLineHTML(view.monShort, view.teacherShort, "tkb-class-line tkb-lesson-line")+
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
      try{ refreshStatsBoxIfOpen(); }catch(_){ }
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

function taoTKBTrong(){
  const tkb = {};
  const daysList = (typeof DAYS !== "undefined" && Array.isArray(DAYS)) ? DAYS : ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const sangLen = (typeof SANG !== "undefined") ? SANG : 5;
  const chieuLen = (typeof CHIEU !== "undefined") ? CHIEU : 5;
  daysList.forEach(day => {
    tkb[day] = {
      sang: Array(sangLen).fill(""),
      chieu: Array(chieuLen).fill("")
    };
  });
  return tkb;
}

function _cloneTkbShell(value){
  try{
    if(value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  }catch(_){}
  return taoTKBTrong();
}

function _ensureTkbShape(tkb){
  const out = tkb && typeof tkb === "object" ? tkb : {};
  const daysList = (typeof DAYS !== "undefined" && Array.isArray(DAYS)) ? DAYS : ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const sangLen = (typeof SANG !== "undefined") ? SANG : 5;
  const chieuLen = (typeof CHIEU !== "undefined") ? CHIEU : 5;
  daysList.forEach(day => {
    out[day] = out[day] && typeof out[day] === "object" ? out[day] : {};
    out[day].sang = Array.isArray(out[day].sang) ? out[day].sang : [];
    out[day].chieu = Array.isArray(out[day].chieu) ? out[day].chieu : [];
    while(out[day].sang.length < sangLen) out[day].sang.push("");
    while(out[day].chieu.length < chieuLen) out[day].chieu.push("");
    out[day].sang = out[day].sang.slice(0, sangLen);
    out[day].chieu = out[day].chieu.slice(0, chieuLen);
  });
  return out;
}

function _applyFixedAndOff(tkb, config){
  const out = _ensureTkbShape(tkb);
  const cfg = config && typeof config === "object" ? config : {};

  (cfg.fixed || []).forEach(item => {
    if(!item || !out[item.thu] || !Array.isArray(out[item.thu][item.buoi])) return;
    const index = Number(item.tiet);
    if(Number.isInteger(index) && index >= 0 && index < out[item.thu][item.buoi].length){
      out[item.thu][item.buoi][index] = {mon: item.ten || "", fixed: true};
    }
  });

  (cfg.off || []).forEach(item => {
    if(!item || !out[item.thu] || !Array.isArray(out[item.thu][item.buoi])) return;
    const index = Number(item.tiet);
    if(Number.isInteger(index) && index >= 0 && index < out[item.thu][item.buoi].length){
      out[item.thu][item.buoi][index] = "OFF";
    }
  });

  return out;
}

function taoTKBTheoConfig(_mons, config){
  return _applyFixedAndOff(taoTKBTrong(), config);
}

function taoTKBBoSungTheoConfig(existingTkb, _mons, config, _extraCanPlaceCell, _extraScoreBlock){
  return _applyFixedAndOff(_cloneTkbShell(existingTkb), config);
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
  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
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

  // PERF 21/08: bam Co dinh tung o cung dinh don "luu dong bo" nhu keo tha -> luu tre.
  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
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
  // PERF 21/08: xoa tung tiet (chuot phai / menu o) cung la thao tac lien tay -> luu tre.
  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
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
  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
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

  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
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
    if(!e || e.button !== 0 || isPlannerBusySolving()) return;

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
    if(!TKB_DRAG_SELECTING || isPlannerBusySolving()) return;
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
  if(isPlannerBusySolving()) return false;
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
      if(isPlannerBusySolving()){ try{ e.preventDefault(); }catch(_){} return; }
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
        try{ saveStoreDeferred(); }catch(_){ }
        try{ renderCurrentView(); loadMonList(); }catch(_){ }
      }
      dragData = null;
      dragMon = "";
    };

    td.ondragover = (e)=>{
      if(!dragData || isPlannerBusySolving()) return;
      e.preventDefault();
      let res = DRAG_VALIDATE_CACHE.get(td);
      if(!res){
        // lượt 6: chưa tô tới ô này -> kiểm nhanh, kế hoạch đổi chỗ để lát tô màu tính
        res = tkbMainDropResult(td, dragMon, {deadline: Date.now() - 1});
        DRAG_VALIDATE_CACHE.set(td, res);
      }
      setDropHint(td, res.ok && !res.warn);
    };

    td.ondragenter = (e)=>{
      if(!dragData || isPlannerBusySolving()) return;
      // 13/09 (lượt 8, chủ dự án: "kéo thả bị đứng, không kéo thả được" — tái hiện bằng kéo chuột thật
      // trên Chrome): con trỏ đi từ chữ trong ô (span) sang nền ô (td) là ĐỔI phần tử đích; lần cập nhật đó
      // Chrome lấy kết quả của dragenter (dragover chỉ bắn ở lần sau). dragenter không huỷ = "không thả được"
      // -> thả đúng lúc đó bị từ chối (dragleave + dragend, không có drop). Phải huỷ cả dragenter.
      try{ if(e) e.preventDefault(); }catch(_){ }
      td.classList.add("drag-over");
    };
    td.ondragleave = (e)=>{
      // rời chữ bên trong ô sang chính ô đó (hoặc ngược lại) không phải rời ô
      if(e && e.relatedTarget && td.contains(e.relatedTarget)) return;
      releaseDragOver(td);
    };

    td.ondrop = (e)=>{
      if(!dragData || isPlannerBusySolving()){ try{ if(e) e.preventDefault(); }catch(_){} return; }
      try{ if(e) e.preventDefault(); }catch(_){ }
      // 13/09: tiết bị đè chuyển được sang ô cũ -> đổi chỗ, không đưa về "Chưa phân"
      if(tkbTryDropSwap(td, currentLop)) return;
      let res = validateDrop(td, dragMon);
      if(!res.ok && maybeRaiseSessionLimitForDrop(td, dragMon, res)){
        res = validateDrop(td, dragMon);
        if(res.ok && tkbTryDropSwap(td, currentLop)) return;
      }

      // Không hợp lệ => chặn luôn
      if(!res.ok){
        flashInvalid(td);
        showDropError(res, td);
        return;
      }

      // 13/09 (lượt 4): tiết đang có mà thả đè tiết khác thì phải đổi chỗ được — không cho thả, không
      // đưa tiết nào về "Chưa phân". (Kéo từ "Chưa phân" vẫn đi đường cũ bên dưới.)
      const blockedNote = tkbSwapBlockedNote(td, currentLop, res);
      if(blockedNote){
        flashInvalid(td);
        showDropError({ok:false, reason:"swap-blocked", msg:blockedNote}, td);
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
    } else if(c.type === "joint"){
      lines.push(`- Tiết chung: lớp ${lop} đang có ${mon} ở ô này (sẽ về Chưa phân)`);
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

  // PERF 21/08: luu tre nhu setOffByKeys/pvApplySupportDrop — saveStore dong bo
  // (sanitize + stringify + 3x localStorage) ton hang tram ms o truong lon,
  // chinh la con "khung" ngay sau moi lan tha.
  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }

  clearDragVisual();
  dragData = null;
  dragMon = "";
}

/* ======================= ĐỔI CHỖ KHI THẢ ĐÈ (13/09) =======================
   Chủ dự án 13/09: kéo tiết A thả lên ô đang có tiết khác — nếu các tiết bị đè chuyển được
   sang ô cũ của A mà vẫn đúng mọi luật thì ĐỔI CHỖ thay vì đưa chúng về "Chưa phân".
   Tiết bị đè = tiết B của chính lớp ở ô đích + tiết C ở lớp khác cùng giờ đang giữ GV/phòng
   của A; ô cũ của A ở lớp đó đang có tiết D thì D sang ô đích (đổi chỗ kép — kéo 2 tiết của
   cùng GV ở 2 lớp trên bảng GV). Dùng cho bảng lớp và bảng GV.
   Chủ dự án 13/09 (lượt 4): "2 bên phải thật sự trống mới xanh" — kéo một tiết ĐANG CÓ lên ô sẽ đè
   tiết khác chỉ được khi đổi chỗ được; không thì ô đỏ, thả bị từ chối kèm lý do, KHÔNG đưa tiết
   nào về "Chưa phân". Kéo từ "Chưa phân" giữ đường cũ.
   - Chỉ đổi trong lớp: kiểm "A kéo nguồn -> đích" và "B kéo đích -> nguồn" trên dữ liệu thật;
     validateDrop + luật Yêu cầu loại cả ô nguồn lẫn ô đích nên không đếm trùng tiết.
   - Có tiết lớp khác: đặt thử trạng thái SAU khi đổi, xoá bộ đệm luật Yêu cầu (chỉ mục lịch
     không tự theo dõi ô đổi) rồi kiểm từng tiết tại chỗ mới; luôn trả nguyên dữ liệu.
   Không đổi tiết cố định, ô nghỉ, tiết học chung nhiều lớp (Dạy ghép). */
function tkbSwapSlot(ds){
  if(!ds) return null;
  const ti = Number(ds.ti);
  if(!ds.thu || !ds.buoi || !Number.isInteger(ti) || ti < 0) return null;
  return {thu:String(ds.thu), buoi:String(ds.buoi), ti};
}

function tkbSwapMovable(raw){
  return raw !== "OFF" && !isFixed(raw) && !!cellMon(raw);
}

function tkbSwapIsJoint(classId, mon){
  try{ return typeof tkbGhepJointRowAt === "function" && !!tkbGhepJointRowAt(classId, mon); }
  catch(_){ return true; }
}

// warm: dựng lại NGAY chỉ mục lịch của luật Yêu cầu. Luật ở chế độ kéo thả dừng sau 24 ms; lượt
// kiểm đầu sau khi xoá bộ đệm mà phải tự dựng chỉ mục sẽ bị cắt giữa chừng và cho qua dễ dãi.
// 13/09 (lượt 6, "kéo bị đứng"): trước đây làm ấm bằng một lượt kiểm ĐẦY ĐỦ (cả luật toàn trường)
// cho mỗi lần thử đổi chỗ khác lớp — quá nặng; nay chỉ dựng chỉ mục (teacherCellsAfterPlace).
function tkbSwapInvalidateRules(warm){
  try{ window.TKBConstraints?.invalidateConstraintCache?.(); }catch(_){ }
  if(warm){
    try{ window.TKBConstraints?.teacherCellsAfterPlace?.("__tkb_swap_warm__", {}); }catch(_){ }
  }
}

// 13/09 (lượt 7, chủ dự án: "kéo thả các tiết bị đứng, không kéo thả được"): mỗi lần thử đổi chỗ khác
// lớp trước đây gọi invalidateConstraintCache 2 lần = dựng lại CẢ chỉ mục luật + xoá mọi bảng dẫn xuất
// (đo kho TEST 36 lớp: ~20-60 ms/lần, và ô kế tiếp lại phải dựng tiếp) -> lát tô màu chặn luồng liên tục.
// Nay chỉ quét lại ô của các lớp trong kế hoạch (TKBConstraints.refreshScheduleIndexClasses, ~1 ms);
// bản tkb-constraints.js cũ chưa có hàm đó thì dựng lại đầy đủ như trước.
function tkbSwapRefreshRules(plan, warm){
  const api = window.TKBConstraints;
  if(api && typeof api.refreshScheduleIndexClasses === "function"){
    const ids = [plan.classId].concat(plan.moves.map(mv=>mv.classId));
    try{ if(api.refreshScheduleIndexClasses(ids)) return; }catch(_){ }
  }
  tkbSwapInvalidateRules(warm);
}

function tkbSwapWarmCtx(classId, slot, mon){
  return {lopId:String(classId), mon, thu:slot.thu, buoi:slot.buoi, ti:slot.ti};
}

// Kiểm tiết `mon` của lớp ở ô `slot` như một lần kéo tay từ ô `from` (mặc định: tại chỗ).
function tkbSwapLessonCheck(classId, slot, mon, from){
  const src = from || slot;
  const stub = tkbAutoRepairCellStub(classId, slot.thu, slot.buoi, slot.ti);
  const task = {
    classId, classCanon:getLopCanonById(classId), mon, remain:1,
    dragData:{type:"cell", classId, mon, val:mon, from:tkbAutoRepairCellStub(classId, src.thu, src.buoi, src.ti)}
  };
  try{
    return tkbAutoRepairWithDropContext(task, ()=>validateDrop(stub, mon)) || {ok:false, reason:"runtime"};
  }catch(err){
    return {ok:false, reason:"runtime", msg:String(err && err.message || err)};
  }
}

function tkbSwapLessonFits(classId, slot, mon, from){
  const res = tkbSwapLessonCheck(classId, slot, mon, from);
  return !!(res && res.ok && !res.warn);
}

// Ghi các ô của kế hoạch vào DATA.tkb; trả hàm hoàn tác.
function tkbSwapWriteCells(plan){
  const tkbs = DATA.tkb;
  const saved = [];
  const put = (classId, slot, value)=>{
    const arr = tkbs[classId][slot.thu][slot.buoi];
    saved.push([arr, slot.ti, arr[slot.ti]]);
    arr[slot.ti] = value;
  };
  put(plan.classId, plan.from, "");
  plan.moves.forEach(mv=>put(mv.classId, mv.from, ""));
  put(plan.classId, plan.to, plan.raw);
  plan.moves.forEach(mv=>put(mv.classId, mv.to, mv.raw));
  return ()=>{
    for(let i = saved.length - 1; i >= 0; i--){
      const [arr, ti, value] = saved[i];
      arr[ti] = value;
    }
  };
}

function tkbSwapPlanFits(plan){
  if(plan.moves.every(mv=>mv.classId === plan.classId)){
    return tkbSwapLessonFits(plan.classId, plan.to, plan.mon, plan.from)
      && tkbSwapLessonFits(plan.classId, plan.from, plan.moves[0].mon, plan.to);
  }
  const undo = tkbSwapWriteCells(plan);
  try{
    tkbSwapRefreshRules(plan, tkbSwapWarmCtx(plan.classId, plan.to, plan.mon));
    return tkbSwapLessonFits(plan.classId, plan.to, plan.mon)
      && plan.moves.every(mv=>tkbSwapLessonFits(mv.classId, mv.to, mv.mon));
  }catch(_){
    return false;
  }finally{
    undo();
    tkbSwapRefreshRules(plan, tkbSwapWarmCtx(plan.classId, plan.from, plan.mon));
  }
}

// Kế hoạch đổi chỗ khi thả tiết `mon` của lớp từ ô `from` lên ô `to`; null = không đổi được.
function tkbDropSwapPlan(classId, from, to, mon){
  classId = String(classId || "");
  mon = String(mon || "").trim();
  if(!classId || !mon || !from || !to) return null;
  if(from.thu === to.thu && from.buoi === to.buoi && from.ti === to.ti) return null;
  const tkbs = DATA?.tkb || {};
  const session = (lopId, slot)=>{
    const arr = tkbs[lopId]?.[slot.thu]?.[slot.buoi];
    return (Array.isArray(arr) && slot.ti < arr.length) ? arr : null;
  };
  const srcArr = session(classId, from);
  const dstArr = session(classId, to);
  if(!srcArr || !dstArr) return null;
  const raw = srcArr[from.ti];
  if(!tkbSwapMovable(raw) || cellMon(raw) !== mon || tkbSwapIsJoint(classId, mon)) return null;
  const rawTarget = dstArr[to.ti];
  if(rawTarget === "OFF" || isFixed(rawTarget)) return null;

  const moves = [];
  const targetMon = cellMon(rawTarget);
  if(targetMon){
    if(targetMon === mon || tkbSwapIsJoint(classId, targetMon)) return null;
    moves.push({classId, mon:targetMon, raw:rawTarget, from:to, to:from});
  }

  const canon = getLopCanonById(classId);
  const gv = teacherValueFromRaw(getTeacherForClassMon(canon, mon));
  const room = String(getRoomForClassMon(canon, mon) || "").trim();
  for(const lopId of Object.keys(tkbs)){
    if(String(lopId) === classId) continue;
    const other = session(lopId, to)?.[to.ti];
    const otherMon = cellMon(other);
    if(!otherMon) continue;
    const otherCanon = getLopCanonById(lopId);
    const clashGv = !!gv && teacherValuesIntersect(getTeacherForClassMon(otherCanon, otherMon), gv)
      && !tkbIsJointGhepPair(mon, classId, otherMon, lopId);
    const clashRoom = !!room && String(getRoomForClassMon(otherCanon, otherMon) || "").trim() === room;
    if(!clashGv && !clashRoom) continue;
    if(!tkbSwapMovable(other) || tkbSwapIsJoint(lopId, otherMon)) return null;
    const back = session(lopId, from);
    const backRaw = back ? back[from.ti] : "OFF";
    if(backRaw === "OFF" || isFixed(backRaw)) return null;
    moves.push({classId:String(lopId), mon:otherMon, raw:other, from:to, to:from});
    // ô cũ của A ở lớp này đang có tiết D -> D sang ô đích của lớp này (đổi chỗ kép)
    const backMon = cellMon(backRaw);
    if(backMon){
      if(tkbSwapIsJoint(lopId, backMon)) return null;
      moves.push({classId:String(lopId), mon:backMon, raw:backRaw, from, to});
    }
  }
  if(!moves.length) return null;

  const plan = {classId, from, to, mon, raw, moves};
  return tkbSwapPlanFits(plan) ? plan : null;
}

// opts.fresh: bỏ qua bộ đệm (lúc thả); opts.deadline: hết ngân sách lúc tô thì trả undefined.
function tkbDropSwapPlanCached(classId, from, to, mon, opts){
  const o = opts || {};
  if(!from || !to) return null;
  const key = [classId, from.thu, from.buoi, from.ti, to.thu, to.buoi, to.ti, mon].join("|");
  if(!o.fresh && DRAG_SWAP_PLAN_CACHE.has(key)) return DRAG_SWAP_PLAN_CACHE.get(key);
  if(o.deadline && Date.now() > o.deadline) return undefined;
  const plan = tkbDropSwapPlan(classId, from, to, mon);
  DRAG_SWAP_PLAN_CACHE.set(key, plan);
  return plan;
}

// Ô nguồn/đích của lượt kéo một tiết đang có trên lưới (không áp cho kéo từ "Chưa phân").
function tkbDragSwapContext(td, classId){
  if(!dragData || (dragData.type !== "cell" && dragData.type !== "pairTeacherCell")) return null;
  const lop = String(classId || "");
  if(!lop) return null;
  if(dragData.classId != null && String(dragData.classId) !== lop) return null;
  const from = tkbSwapSlot(dragData.from?.dataset);
  const to = tkbSwapSlot(td?.dataset);
  return (from && to) ? {classId:lop, from, to} : null;
}

// Lượt kéo tiết đang có này có đè tiết nào không (tiết khác môn ở ô đích / tiết trùng GV-phòng cùng giờ).
function tkbSwapDisplaces(ctx, mon, res){
  const targetMon = cellMon(DATA?.tkb?.[ctx.classId]?.[ctx.to.thu]?.[ctx.to.buoi]?.[ctx.to.ti]);
  return (!!targetMon && targetMon !== mon) || !!(res && res.warn);
}

// Kết quả kiểm khi thả tiết đang có (base = validateDrop của tiết đó): đè tiết khác thì chỉ hợp lệ
// khi đổi chỗ được. {swap} = xanh + đổi chỗ; swap-pending = chưa kịp tính (tính lúc rê chuột);
// swap-blocked = đỏ, không cho thả.
function tkbSwapAwareResult(res, classId, from, to, mon, opts){
  const onlyGvRoom = !(Array.isArray(res.conflicts) && res.conflicts.some(c=>c.type !== "teacher" && c.type !== "room"));
  const plan = onlyGvRoom ? tkbDropSwapPlanCached(classId, from, to, mon, opts) : null;
  if(plan === undefined) return {ok:false, reason:"swap-pending", swapDeferred:true};
  if(plan) return Object.assign({}, res, {warn:false, conflicts:[], swap:plan});
  return {ok:false, reason:"swap-blocked", swapBlocked:true};
}

// Bảng lớp.
function tkbMainDropResult(td, mon, opts){
  const res = validateDrop(td, mon);
  if(!res || !res.ok) return res;
  const ctx = tkbDragSwapContext(td, currentLop);
  if(!ctx || !tkbSwapDisplaces(ctx, mon, res)) return res;
  return tkbSwapAwareResult(res, ctx.classId, ctx.from, ctx.to, mon, opts);
}

function tkbApplyDropSwap(plan, td){
  tkbSwapWriteCells(plan);
  tkbSwapInvalidateRules(tkbSwapWarmCtx(plan.classId, plan.to, plan.mon));
  const others = plan.moves.map(mv=>mv.classId === plan.classId
    ? getMonShort(mv.mon)
    : `${getMonShort(mv.mon)}-${getLopCanonById(mv.classId)}`).join(", ");
  const msg = `Đã đổi chỗ ${getMonShort(plan.mon)} ↔ ${others}.`;
  try{ showDropToast(msg, td, "info"); }catch(_){ }
  try{ _setStatus(msg, "info"); }catch(_){ }
  try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
  try{ renderCurrentView(); }catch(e){ console.error('renderCurrentView failed', e); }
  try{ loadMonList(); }catch(e){ console.error('loadMonList failed', e); }
  clearDragVisual();
  dragData = null;
  dragMon = "";
}

// Lý do (tiếng Việt) một lần kiểm không đạt.
function tkbSwapReasonText(res){
  if(!res || (res.ok && !res.warn)) return "";
  const first = String(res.msg || "").split("\n")[0].trim();
  switch(res.reason){
    case "exceed session limit": return `vượt giới hạn ${Number(res.limit) || 1} tiết/buổi`;
    case "split block":
    case "touch left":
    case "touch right": return "các tiết cùng môn trong buổi sẽ không liền nhau";
    case "exceed week total": return "vượt số tiết/tuần";
    case "locked": return "ô bị khoá (nghỉ / cố định)";
    default: return first || String(res.reason || "");
  }
}

// Kéo tiết đang có lên ô sẽ đè tiết khác mà không đổi chỗ được: câu báo lý do ("" = không đè tiết nào).
// res = validateDrop của tiết đang kéo tại ô đích (để biết tiết trùng GV/phòng).
function tkbSwapBlockedNote(td, classId, res){
  const ctx = tkbDragSwapContext(td, classId);
  if(!ctx) return "";
  const targetMon = cellMon(DATA?.tkb?.[ctx.classId]?.[ctx.to.thu]?.[ctx.to.buoi]?.[ctx.to.ti]);
  const hasTarget = !!targetMon && targetMon !== dragMon;
  const conflicts = (res && res.warn && Array.isArray(res.conflicts)) ? res.conflicts : [];
  if(!hasTarget && !conflicts.length) return "";
  const name = hasTarget ? getMonShort(targetMon) : "";
  let why = "";
  if(hasTarget && (tkbSwapIsJoint(ctx.classId, targetMon) || tkbSwapIsJoint(ctx.classId, dragMon))){
    why = "tiết học chung nhiều lớp không đổi chỗ bằng kéo thả";
  }else if(hasTarget){
    const back = tkbSwapReasonText(tkbSwapLessonCheck(ctx.classId, ctx.from, targetMon, ctx.to));
    if(back) why = `${name} về ô cũ thì ${back}`;
  }
  if(!why && conflicts.length){
    const clash = conflicts.map(c=>c && c.msg).filter(Boolean)[0] || "trùng lịch ở tiết này";
    why = `${clash} — tiết đó không đổi sang ô cũ được`;
  }
  return `Không đổi chỗ được${why ? ": " + why : ""}.`;
}

// Thả trên bảng lớp: true = đã đổi chỗ xong.
function tkbTryDropSwap(td, classId){
  const ctx = tkbDragSwapContext(td, classId);
  if(!ctx) return false;
  const plan = tkbDropSwapPlanCached(ctx.classId, ctx.from, ctx.to, dragMon, {fresh:true});
  if(!plan) return false;
  tkbApplyDropSwap(plan, td);
  return true;
}
/* ======================= HẾT ĐỔI CHỖ KHI THẢ ĐÈ ======================= */

function setDropHint(td, ok){
  const want = ok ? "drop-valid" : "drop-invalid";
  if(td.classList.contains(want)) return; // tranh churn class -> style recalc moi dragover
  td.classList.remove("drop-valid", "drop-invalid");
  td.classList.add(want);
}

/* Tô sẵn ô thả được / không thả được ngay khi bắt đầu kéo.
   Chạy ở frame kế tiếp để dragstart trả về ngay (trình duyệt khởi động thao tác
   kéo mượt), người dùng vẫn thấy màu gần như tức thì. Token chặn việc tô muộn
   sau khi đã thả/hủy kéo. Kết quả nằm luôn trong DRAG_VALIDATE_CACHE nên
   ondragover sau đó không phải tính lại. */
let DRAG_PAINT_TOKEN = 0;

function tkbMainDropCells(){
  return Array.from(document.querySelectorAll("#tkb td"))
    .filter(td => !td.closest(".tkb-support-table"));
}

function tkbSupportDropCells(){
  return Array.from(document.querySelectorAll(".tkb-support-table td[data-pair-slot='teacher']"));
}

// 13/09 (lượt 6, chủ dự án: "kéo các tiết bị đứng, không mượt"): tô theo LÁT ~12 ms rồi nhả luồng
// cho trình duyệt (setTimeout 0) thay vì kiểm toàn bộ ô trong một khung. Ô cần kế hoạch đổi chỗ mà
// hết lát (swapDeferred) được xếp lại cuối hàng; mỗi lát luôn tính xong ít nhất một ô nên chắc chắn
// tiến. Rê chuột (dragover) không tự tính kế hoạch nặng — chỉ đọc kết quả lát đã tô.
const DRAG_PAINT_SLICE_MS = 12;

function paintDropTargets(mon){
  const token = ++DRAG_PAINT_TOKEN;
  const validateSupport = window.__tkbValidateSupportDrop;
  const queue = tkbMainDropCells().map(td=>({td, main:true}));
  if(typeof validateSupport === "function"){
    tkbSupportDropCells().forEach(td=>queue.push({td, main:false}));
  }
  let warmed = false;
  const run = ()=>{
    if(token !== DRAG_PAINT_TOKEN || !dragData) return;
    if(!warmed){
      // lượt 7: dựng chỉ mục luật MỘT lần ở đầu lượt kéo (lưới có thể vừa đổi mà chưa lưu), các lần
      // thử đổi chỗ sau chỉ làm tươi từng lớp. Lát riêng để thao tác kéo khởi động mượt.
      warmed = true;
      tkbSwapInvalidateRules(true);
      setTimeout(run, 0);
      return;
    }
    const sliceEnd = Date.now() + DRAG_PAINT_SLICE_MS;
    let first = true;
    while(queue.length && (first || Date.now() < sliceEnd)){
      const item = queue.shift();
      const td = item.td;
      if(td.classList.contains("drag-source")) continue;
      let res = DRAG_VALIDATE_CACHE.get(td);
      if(!res || res.swapDeferred){
        const opts = {deadline: first ? Date.now() + DRAG_SWAP_PAINT_BUDGET_MS : sliceEnd};
        first = false;
        try{ res = item.main ? tkbMainDropResult(td, mon, opts) : validateSupport(td, opts); }
        catch(_){ res = {ok:false, reason:"runtime"}; }
        DRAG_VALIDATE_CACHE.set(td, res);
        if(res && res.swapDeferred) queue.push(item);
      }
      setDropHint(td, !!(res && res.ok && !res.warn));
    }
    if(queue.length) setTimeout(run, 0);
  };
  setTimeout(run, 0);
}

function applyDragVisual(mon, excludeTd){
  clearDragVisual();
  DRAG_VALIDATE_CACHE.clear();
  DRAG_SWAP_PLAN_CACHE.clear();

  // excludeTd có thể là <td> (khi kéo trong TKB) hoặc null (khi kéo từ "Chưa phân")
  const isEl = !!(excludeTd && typeof excludeTd === "object" && excludeTd.classList);

  // mờ tất cả ô cùng môn để cảnh báo trùng
  document.querySelectorAll("#tkb td").forEach(td=>{
    if(isEl && td === excludeTd) return;
    const m = (td.dataset.mon || "").trim();
    if(m && m === mon) td.classList.add("conflict");
  });

  if(isEl) excludeTd.classList.add("drag-source");

  paintDropTargets(mon);
}

function clearDragVisual(){
  DRAG_PAINT_TOKEN++; // huỷ lượt tô đang chờ frame
  DRAG_VALIDATE_CACHE.clear();
  DRAG_SWAP_PLAN_CACHE.clear();
  document.querySelectorAll("#tkb td").forEach(td=>{
    td.classList.remove("conflict","drag-source","drag-over","drop-valid","drop-invalid");
  });
}

// Rời ô: chỉ bỏ viền hover, giữ nguyên màu thả được/không thả được đã tô sẵn.
function releaseDragOver(td){
  td.classList.remove("drag-over");
  if(!DRAG_VALIDATE_CACHE.has(td)) td.classList.remove("drop-valid","drop-invalid");
}

/* ======================= KÉO THẢ BẰNG CẢM ỨNG (ĐIỆN THOẠI) ======================= */
// 13/09 (lượt 9, chủ dự án: "kéo thả trên điện thoại không được"): trang chỉ dựa vào kéo thả gốc
// (dragstart / dragover / drop) mà trình duyệt điện thoại (Android Chrome, nhiều bản iOS) không bắn
// khi chạm vào ô draggable. Android còn bắn contextmenu khi giữ ngón tay -> td.oncontextmenu (chuột
// phải = đưa tiết về Chưa phân) có thể xoá mất tiết. Ở đây: giữ ngón tay ~300 ms trên phần tử kéo
// được của trang Sắp xếp thì bắt đầu kéo, bóng tiết chạy theo ngón tay, rồi PHÁT LẠI đúng chuỗi sự
// kiện dragstart / dragenter / dragover / dragleave / drop / dragend lên phần tử dưới ngón tay — đi
// chung mọi handler của chuột (tô xanh/đỏ, đổi chỗ, bảng GV, kéo từ Chưa phân). Chuột vẫn kéo gốc.
const TKB_TOUCH_DRAG_HOLD_MS = 300;
const TKB_TOUCH_DRAG_SLOP_PX = 10;
const TKB_TOUCH_DRAG_EDGE_PX = 48;
const TKB_TOUCH_DRAG = {state:null, touchingUntil:0};

function tkbTouchDragDataTransfer(){
  const data = {};
  return {
    dropEffect:"move", effectAllowed:"all", types:[], files:[], items:[],
    setData(type, value){ data[String(type)] = String(value); this.types = Object.keys(data); },
    getData(type){ return data[String(type)] || ""; },
    clearData(){ Object.keys(data).forEach(k=>{ delete data[k]; }); this.types = []; },
    setDragImage(){ }
  };
}

// Sự kiện kéo giả: Event thường + các thuộc tính handler kéo thả đọc (dataTransfer, relatedTarget, toạ độ).
function tkbTouchDragEvent(type, extra){
  const st = TKB_TOUCH_DRAG.state;
  const ev = new Event(type, {bubbles:true, cancelable:true});
  const props = Object.assign({
    dataTransfer: st ? st.dt : tkbTouchDragDataTransfer(),
    clientX: st ? st.x : 0,
    clientY: st ? st.y : 0,
    relatedTarget: null,
    pointerType: "touch",
    tkbTouchDrag: true
  }, extra || {});
  Object.keys(props).forEach(key=>{
    try{ Object.defineProperty(ev, key, {value:props[key], configurable:true}); }catch(_){ }
  });
  return ev;
}

// true = không ai huỷ sự kiện (dragover: không thả được ở đây).
function tkbTouchDragFire(el, type, extra){
  if(!el) return true;
  try{ return el.dispatchEvent(tkbTouchDragEvent(type, extra)); }
  catch(err){ console.warn("[tkb-touch-drag]", type, err); return true; }
}

function tkbTouchDragSource(target){
  const el = target && target.closest ? target.closest("[draggable]") : null;
  if(!el || el.getAttribute("draggable") !== "true") return null;
  if(!el.matches("#tkb td, .mon-item")) return null;
  return el;
}

function tkbTouchDragPlaceGhost(st){
  if(!st.ghost) return;
  st.ghost.style.left = `${Math.round(st.x)}px`;
  st.ghost.style.top = `${Math.round(st.y)}px`;
}

function tkbTouchDragUpdateTarget(st){
  let el = null;
  try{ el = document.elementFromPoint(st.x, st.y); }catch(_){ }
  if(el && st.ghost && st.ghost.contains(el)) el = null;
  if(el !== st.target){
    const prev = st.target;
    if(el) tkbTouchDragFire(el, "dragenter", {relatedTarget:prev});
    if(prev) tkbTouchDragFire(prev, "dragleave", {relatedTarget:el});
    st.target = el;
  }
  st.allowed = el ? !tkbTouchDragFire(el, "dragover") : false;
  st.overAt = Date.now();
}

function tkbTouchDragScroller(el){
  for(let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement){
    let oy = "";
    try{ oy = getComputedStyle(node).overflowY; }catch(_){ }
    if((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

// Ngón tay sát mép vùng cuộn (bảng lớp/GV hoặc cả trang) thì tự cuộn; ngón tay đứng yên vẫn bắn
// dragover định kỳ như trình duyệt để màu ô cập nhật khi lát tô màu tính xong.
function tkbTouchDragTick(st){
  if(TKB_TOUCH_DRAG.state !== st || st.phase !== "active") return;
  const edge = TKB_TOUCH_DRAG_EDGE_PX;
  let scrolled = false;
  const box = tkbTouchDragScroller(st.target || st.source);
  if(box){
    const r = box.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const before = box.scrollTop;
    if(st.y < top + edge) box.scrollTop = before - Math.ceil((top + edge - st.y) / 4);
    else if(st.y > bottom - edge) box.scrollTop = before + Math.ceil((st.y - (bottom - edge)) / 4);
    scrolled = box.scrollTop !== before;
  }
  if(!scrolled){
    const vh = window.innerHeight;
    const before = window.scrollY;
    if(st.y < edge) window.scrollBy(0, -Math.ceil((edge - st.y) / 4));
    else if(st.y > vh - edge) window.scrollBy(0, Math.ceil((st.y - (vh - edge)) / 4));
    scrolled = window.scrollY !== before;
  }
  if(scrolled || Date.now() - (st.overAt || 0) > 100) tkbTouchDragUpdateTarget(st);
  st.raf = requestAnimationFrame(()=>tkbTouchDragTick(st));
}

function tkbTouchDragTeardown(st){
  if(!st) return;
  if(st.timer){ clearTimeout(st.timer); st.timer = 0; }
  if(st.raf){ try{ cancelAnimationFrame(st.raf); }catch(_){ } st.raf = 0; }
  if(st.ghost){ try{ st.ghost.remove(); }catch(_){ } st.ghost = null; }
  // trả lại draggable đã tắt tạm (chặn kéo gốc của iOS/Android trong lúc giữ ngón tay)
  if(st.source && st.restoreDraggable && st.source.getAttribute("draggable") === "false"){
    st.source.setAttribute("draggable", "true");
  }
  st.restoreDraggable = false;
  document.documentElement.classList.remove("tkb-touch-pending", "tkb-touch-dragging");
}

function tkbTouchDragReset(){
  tkbTouchDragTeardown(TKB_TOUCH_DRAG.state);
  TKB_TOUCH_DRAG.state = null;
}

function tkbTouchDragActivate(st){
  if(TKB_TOUCH_DRAG.state !== st || st.phase !== "pending") return;
  st.timer = 0;
  if(!st.source.isConnected || (typeof isPlannerBusySolving === "function" && isPlannerBusySolving())){
    tkbTouchDragReset();
    return;
  }
  st.phase = "active";
  const started = tkbTouchDragFire(st.source, "dragstart");
  if(!started || !dragData){
    // ô nghỉ / cố định bị từ chối / đang xếp: handler đã huỷ dragstart
    st.phase = "pending";
    tkbTouchDragReset();
    return;
  }
  try{ navigator.vibrate && navigator.vibrate(12); }catch(_){ }
  const ghost = document.createElement("div");
  ghost.className = "tkb-touch-drag-ghost";
  ghost.textContent = String(st.source.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48) || String(dragMon || "");
  document.body.appendChild(ghost);
  st.ghost = ghost;
  document.documentElement.classList.add("tkb-touch-dragging");
  tkbTouchDragPlaceGhost(st);
  tkbTouchDragUpdateTarget(st);
  st.raf = requestAnimationFrame(()=>tkbTouchDragTick(st));
}

function tkbTouchDragOnStart(e){
  TKB_TOUCH_DRAG.touchingUntil = Date.now() + 60000;
  if(TKB_TOUCH_DRAG.state){
    // ngón thứ hai trong lúc đang kéo: bỏ qua, giữ lượt kéo
    if(TKB_TOUCH_DRAG.state.phase === "active") return;
    tkbTouchDragReset();
  }
  if(!e.touches || e.touches.length !== 1) return;
  const source = tkbTouchDragSource(e.target);
  if(!source) return;
  if(typeof isPlannerBusySolving === "function" && isPlannerBusySolving()) return;
  const t = e.touches[0];
  const st = {
    phase:"pending", source, id:t.identifier, x0:t.clientX, y0:t.clientY, x:t.clientX, y:t.clientY,
    timer:0, raf:0, ghost:null, target:null, allowed:false, overAt:0,
    dt:tkbTouchDragDataTransfer(), restoreDraggable:false
  };
  // tắt tạm kéo gốc của trình duyệt cho phần tử này (iOS nhấc ô sau ~0,5 s rồi huỷ chuỗi chạm)
  source.setAttribute("draggable", "false");
  st.restoreDraggable = true;
  document.documentElement.classList.add("tkb-touch-pending");
  st.timer = setTimeout(()=>tkbTouchDragActivate(st), TKB_TOUCH_DRAG_HOLD_MS);
  TKB_TOUCH_DRAG.state = st;
}

function tkbTouchDragFind(list, id){
  const arr = Array.from(list || []);
  return arr.find(t=>t.identifier === id) || null;
}

function tkbTouchDragOnMove(e){
  const st = TKB_TOUCH_DRAG.state;
  if(!st) return;
  const t = tkbTouchDragFind(e.touches, st.id);
  if(!t) return;
  if(st.phase === "pending"){
    if(e.touches.length !== 1 || Math.hypot(t.clientX - st.x0, t.clientY - st.y0) > TKB_TOUCH_DRAG_SLOP_PX){
      tkbTouchDragReset(); // đang cuộn trang, không phải kéo
    }
    return;
  }
  try{ if(e.cancelable) e.preventDefault(); }catch(_){ }
  st.x = t.clientX;
  st.y = t.clientY;
  tkbTouchDragPlaceGhost(st);
  tkbTouchDragUpdateTarget(st);
}

function tkbTouchDragOnEnd(e){
  const st = TKB_TOUCH_DRAG.state;
  if(!e.touches || !e.touches.length) TKB_TOUCH_DRAG.touchingUntil = Date.now() + 800;
  if(!st) return;
  if(st.phase !== "active"){
    tkbTouchDragReset();
    return;
  }
  const t = tkbTouchDragFind(e.changedTouches, st.id);
  if(!t) return; // ngón khác nhấc lên, ngón đang kéo vẫn giữ
  try{ if(e.cancelable) e.preventDefault(); }catch(_){ } // không để chạm thành click / chạm đúp mở menu ô
  st.x = t.clientX;
  st.y = t.clientY;
  tkbTouchDragUpdateTarget(st);
  const target = st.target;
  const source = st.source;
  const allowed = st.allowed;
  tkbTouchDragTeardown(st);
  if(target && allowed) tkbTouchDragFire(target, "drop");
  else if(target) tkbTouchDragFire(target, "dragleave", {relatedTarget:null});
  TKB_TOUCH_DRAG.state = null;
  tkbTouchDragFire(source, "dragend");
}

function tkbTouchDragOnCancel(e){
  if(!e || !e.touches || !e.touches.length) TKB_TOUCH_DRAG.touchingUntil = Date.now() + 800;
  const st = TKB_TOUCH_DRAG.state;
  if(!st) return;
  if(e && e.changedTouches && e.changedTouches.length && !tkbTouchDragFind(e.changedTouches, st.id)) return;
  if(st.phase === "active"){
    const target = st.target;
    const source = st.source;
    tkbTouchDragTeardown(st);
    TKB_TOUCH_DRAG.state = null;
    if(target) tkbTouchDragFire(target, "dragleave", {relatedTarget:null});
    tkbTouchDragFire(source, "dragend");
    return;
  }
  tkbTouchDragReset();
}

(function tkbTouchDragInstall(){
  if(typeof window === "undefined" || typeof document === "undefined" || window.__tkbTouchDragInstalled) return;
  window.__tkbTouchDragInstalled = true;
  try{
    const css = document.createElement("style");
    css.id = "tkbTouchDragStyle";
    css.textContent = [
      ".tkb-touch-drag-ghost{position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;transform:translate(-50%,-140%);padding:6px 10px;border-radius:8px;background:#2f54eb;color:#fff;font:600 13px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 6px 18px rgba(15,23,42,.28);white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis;opacity:.95}",
      "html.tkb-touch-pending #tkb td, html.tkb-touch-pending .mon-item, html.tkb-touch-dragging #tkb td, html.tkb-touch-dragging .mon-item{-webkit-user-drag:none !important;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}",
      "html.tkb-touch-dragging, html.tkb-touch-dragging body{overscroll-behavior:none}",
      "@media (any-pointer: coarse){#tkb td[draggable], .mon-item[draggable]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(css);
  }catch(_){ }
  if(typeof document.addEventListener !== "function" || typeof window.addEventListener !== "function") return;
  document.addEventListener("touchstart", tkbTouchDragOnStart, {passive:true, capture:true});
  document.addEventListener("touchmove", tkbTouchDragOnMove, {passive:false, capture:true});
  document.addEventListener("touchend", tkbTouchDragOnEnd, {passive:false, capture:true});
  document.addEventListener("touchcancel", tkbTouchDragOnCancel, {passive:true, capture:true});
  // kéo gốc của trình duyệt bắt đầu từ chạm (Chrome Windows/Android, iOS): nhường cho kéo cảm ứng
  window.addEventListener("dragstart", e=>{
    if(TKB_TOUCH_DRAG.state && e.isTrusted){
      try{ e.preventDefault(); e.stopImmediatePropagation(); }catch(_){ }
    }
  }, true);
  // giữ ngón tay trên ô: Android bắn contextmenu -> KHÔNG được coi là chuột phải (đưa tiết về Chưa phân)
  window.addEventListener("contextmenu", e=>{
    const touching = !!TKB_TOUCH_DRAG.state || Date.now() < TKB_TOUCH_DRAG.touchingUntil || e.pointerType === "touch";
    if(!touching) return;
    const target = e.target && e.target.closest ? e.target.closest("#tkb td, .mon-item") : null;
    if(!target) return;
    try{ e.preventDefault(); e.stopImmediatePropagation(); }catch(_){ }
  }, true);
})();
/* ======================= HẾT KÉO THẢ BẰNG CẢM ỨNG ======================= */

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
  const gvConflict = findTeacherConflictAtSlot(gv, tThu, tBuoi, tTi, currentLop, mon);
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

  // ===== Tiết học chung nhiều lớp: ô cùng vị trí ở các lớp còn lại =====
  const joint = (typeof tkbJointSiblingBlockers === "function") ? tkbJointSiblingBlockers(currentLop, mon, tThu, tBuoi, tTi) : null;
  if(joint && joint.blocked.length){
    const name = String(joint.row.viettat || joint.row.ten || mon);
    return {
      ok:false,
      reason:"joint blocked",
      msg:`Tiết chung "${name}" không đặt được ở tiết này: ${joint.blocked.map(b => `${getLopCanonById(b.classId)} (${b.why})`).join("; ")}.`
    };
  }
  if(joint && joint.displace.length) joint.displace.forEach(d => conflicts.push(d));

  if(conflicts.length){
    // highlight lớp bị trùng
    try{
      conflicts.forEach(c=>flashLopItemConflict(c.lopId));
    }catch(_){ }

    const msg = (conflicts.length === 1)
      ? conflicts[0].msg
      : ("Có " + conflicts.length + " xung đột (GV/Phòng/tiết chung) ở tiết này.");

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

// 20/08 DO DUOC TREN MAY THAT: goi ham nay cho 72 lop het 2.704 ms, va no bi
// goi lai nhieu lan trong mot luot bam (expectedLessonCount, capacity precheck,
// completeScheduleState...) -> cong don hang chuc giay TRUOC KHI gui len may
// chu, chinh la doan "do lag" nguoi dung thay. Ham chi doc bang phan cong +
// danh muc mon, KHONG doc DATA.tkb, nen cache theo danh tinh cac bang do la an
// toan; moi thay doi phan cong deu di qua invalidatePccmNumCaches().
let REQUIRED_SUBJECTS_CACHE = {refs: [], values: new Map()};

function ensureRequiredSubjectsCache(){
  const refs = [
    DATA.lop, DATA.mon, DATA.monhoc,
    DATA.pccmMatrix, DATA.pccmTietMatrix, DATA.pccmGioihanMatrix, DATA.pccmRoomMatrix,
    DATA.tkbLessonTeachers
  ];
  if(
    REQUIRED_SUBJECTS_CACHE.refs.length === refs.length
    && refs.every((ref, i) => ref === REQUIRED_SUBJECTS_CACHE.refs[i])
  ){
    return REQUIRED_SUBJECTS_CACHE.values;
  }
  REQUIRED_SUBJECTS_CACHE = {refs, values: new Map()};
  return REQUIRED_SUBJECTS_CACHE.values;
}

function requiredSubjectsForClass(lop){
  const classId = String(lop?.id || "").trim();
  if(!classId) return [];
  const cache = ensureRequiredSubjectsCache();
  if(cache.has(classId)){
    // Tra ban sao: nhieu cho goi xong con sua tai cho tren ket qua.
    return cache.get(classId).map(row => Object.assign({}, row));
  }
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
  // 29/08: khoá phân công có thể theo TÊN lớp ("6.1|AI-1" — app.js và Dạy ghép chiếu theo tên)
  // hay theo mã lớp ("L001|…"); trước chỉ so mã nên môn ghép không vào danh sách Chưa phân.
  let classKeys;
  try{ classKeys = new Set([classId].concat(classKeyCandidates(classCanon) || []).map(x => String(x || "").trim().toLowerCase()).filter(Boolean)); }
  catch(_){ classKeys = new Set([classId.toLowerCase()]); }
  // 02/09: dòng Dạy ghép KHÔNG giáo viên chỉ có khoá trong bảng Tiết (không có pccmMatrix) —
  // quét thêm các khoá đó (chỉ khoá do dòng không GV sở hữu, tránh môn ma từ bảng Tiết lạc).
  const noTeacherKeys = Object.keys(periods).filter(rawKey => {
    if(Object.prototype.hasOwnProperty.call(matrix, rawKey)) return false;
    if(typeof tkbIsNoTeacherGhep !== "function") return false;
    const parts = String(rawKey).split("|");
    const cid = String(parts.shift() || "").trim();
    const subject = String(parts.join("|") || "").trim();
    return !!subject && classKeys.has(cid.toLowerCase()) && tkbIsNoTeacherGhep(classCanon, subject);
  });
  Object.keys(matrix).concat(noTeacherKeys).forEach(rawKey=>{
    const parts = String(rawKey).split("|");
    const cid = String(parts.shift() || "").trim();
    const subject = String(parts.join("|") || "").trim();
    if(!classKeys.has(cid.toLowerCase()) || !subject) return;
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

  const rows = Array.from(bySubject.values()).map(row=>({
    mon: row.mon,
    required: Number(row.required || 0),
    gv: String(row.gv || getTeacherForClassMon(classCanon, row.mon) || "").trim(),
    room: String(row.room || getRoomForClassMon(classCanon, row.mon) || "").trim()
  }));
  cache.set(classId, rows);
  return rows.map(row => Object.assign({}, row));
}

/* 22/08 (toi): tiet Cherry da CHU DONG dua ve Chua phan vi GV van con buoi 1
   tiet / trong >= 2 (reason teacher_quality_unreachable) KHONG duoc cac luot
   "va nhanh" tu xep lai (truoc khi giai / sau khi ap): xep lai se tao dung
   buoi le do, roi Cherry lai dua ra -> vong lap. Co nay duoc bat trong
   tkbAutoPlaceUnassignedLessons; hop Chua phan van liet ke du de nguoi dung
   tu keo neu muon. */
let TKB_SKIP_QUALITY_EJECTED_TASKS = false;
// Danh sach tiet da dua ra cua KET QUA VUA AP (bridge truyen vao khi
// DATA.tkbSolverResult chua kip cap nhat); null = doc tu DATA.tkbSolverResult.
let TKB_QUALITY_EJECTED_OVERRIDE = null;
function tkbQualityEjectedPeriodsFor(classId, mon){
  try{
    if(typeof tkbUnassignedItemsFor !== "function") return 0;
    let total = 0;
    tkbUnassignedItemsFor(classId, mon, TKB_QUALITY_EJECTED_OVERRIDE).forEach(u => {
      if(String(u?.reason || "") !== "teacher_quality_unreachable") return;
      total += Math.max(1, Math.round(Number(u.periods ?? u.count) || 1));
    });
    return total;
  }catch(_){
    return 0;
  }
}

function collectUnassignedTasks(options={}){
  const hasOnlyClass = Object.prototype.hasOwnProperty.call(options || {}, "onlyClassId");
  const onlyClassId = hasOnlyClass ? String(options.onlyClassId || "") : "";
  if(hasOnlyClass && !onlyClassId) return [];

  const useKhoiFilter = options?.useKhoiFilter === true;
  const skipEjected = TKB_SKIP_QUALITY_EJECTED_TASKS === true || options?.excludeQualityEjected === true;
  const cacheEligible = !hasOnlyClass && !useKhoiFilter && !skipEjected;
  const cacheSig = cacheEligible
    ? String(options?.cacheSignature || schoolStatsTkbSignature())
    : "";
  const taskCache = window.__TKB_UNASSIGNED_TASKS_CACHE || {sig:"", value:null};
  if(cacheEligible && cacheSig && taskCache.sig === cacheSig && Array.isArray(taskCache.value)){
    return taskCache.value.map(item=>Object.assign({}, item));
  }
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
      // Count only teacher assignments that exist in the current PCCM data.
      // Timetable cells and legacy subject rows must not create phantom work.
      // 02/09: trừ tiết dạy ghép KHÔNG giáo viên (tkbIsNoTeacherGhep) — là tiết thật của lớp.
      const pccmTeachers = teacherListFromValue(
        classAssignmentStatisticsTeacherForClassMon(classCanon, mon)
      );
      if(!pccmTeachers.length && !tkbIsNoTeacherGhep(classCanon, mon)) return;
      const gv = pccmTeachers.join(", ");
      const required = Number(s?.required ?? s?.sotiet ?? 0);
      if(!Number.isFinite(required) || required <= 0) return;
      const used = countMonFromTkbCountMap(tkbMonCounts, mon);
      const ejected = skipEjected ? tkbQualityEjectedPeriodsFor(classId, mon) : 0;
      const remain = Math.max(0, required - used - ejected);
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

  const result = Array.from(map.values()).sort((a,b)=>{
    const c = (a.className||"").localeCompare((b.className||""),'vi');
    if(c) return c;
    const m = compareMonByHiddenCode(a.mon,b.mon);
    if(m) return m;
    return Number(b.remain || 0) - Number(a.remain || 0);
  });
  if(cacheEligible && cacheSig){
    window.__TKB_UNASSIGNED_TASKS_CACHE = {
      sig:cacheSig,
      value:result.map(item=>Object.assign({}, item))
    };
  }
  return result;
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

/* 21/08: pha va cuc bo truoc day CHI kiem luat keo-tha (validateDrop: trung
   GV, gioi han buoi...) ma khong hoi bo rang buoc "Yeu cau" (TKBConstraints)
   — nen no dat tiet vao cho vi pham "hoc sang hoac chieu" (oneSessionPerDay),
   khong cung ngay/buoi, gioi han tiet/ngay... va lam vo yeu cau tiet doi.
   Bo sung: (1) moi vi tri dat/di doi phai qua canPlaceCell cua TKBConstraints;
   (2) cham diem uu tien o KE tiet cung mon khi mon con thieu cum tiet doi. */
function tkbAutoRepairConstraintOk(taskOrClassId, monOrSlot, maybeSlot){
  try{
    const api = window.TKBConstraints || window.TKBConstraintsFull;
    if(!api || typeof api.canPlaceCell !== "function") return true;
    // Ho tro ca 2 dang goi: (task, slot) va (classId, mon, slot).
    let classId, mon, slot, srcOpts = {};
    if(maybeSlot){
      classId = taskOrClassId; mon = monOrSlot; slot = maybeSlot;
    }else{
      const task = taskOrClassId || {};
      classId = task.classId; mon = task.mon; slot = monOrSlot;
      // Neu task la DI DOI mot tiet dang co (dragData type 'cell'), phai khai
      // bao o nguon de canPlaceCell loai tiet cu khoi phep dem — khong thi
      // oneSessionPerDay/spacing tu chan chinh minh.
      const from = task.dragData?.type === "cell" ? task.dragData?.from : null;
      const ds = from?.dataset;
      if(ds && ds.thu && ds.buoi != null){
        srcOpts = {src: {thu: ds.thu, buoi: ds.buoi, ti: Number(ds.ti)}};
      }
    }
    const res = api.canPlaceCell(String(classId), String(mon), slot.thu, slot.buoi, Number(slot.ti), srcOpts);
    return !res || res.ok !== false;
  }catch(_){
    return true;
  }
}

function tkbAutoRepairLessonBlockPairShortfall(task){
  // >0 khi mon nay co yeu cau "min N cum 2 tiet lien" va lich hien tai chua du.
  try{
    const subj = DATA?.tkbConstraints?.subject;
    if(!subj) return 0;
    let min = 0;
    for(const key of Object.keys(subj)){
      if(!monMatches(key, task?.mon)) continue;
      const rule = subj[key]?.byClass?.[String(task?.classId)];
      const m = Number(rule?.lessonBlocks?.[2]?.min || 0);
      if(m > min) min = m;
    }
    if(min <= 0) return 0;
    // 25/08: mon chi co 1 tiet/tuan (hay it hon 2*min) thi khong the co cum
    // doi -> khong phai vi pham (nguoi dung quick-fill "all" min=1 cho ca
    // mon Tin 1 tiet). Cung nguong voi TKBConstraints (impossibleLessonBlockMinimum).
    if(tkbLessonBlockMinImpossible(task?.classId, task?.mon, 2, min)) return 0;
    const tkb = DATA?.tkb?.[task?.classId];
    if(!tkb) return min;
    let pairs = 0;
    for(const thu of DAYS){
      for(const buoi of ["sang","chieu"]){
        const arr = tkb?.[thu]?.[buoi] || [];
        let run = 0;
        for(let i=0;i<=arr.length;i++){
          const hit = i < arr.length && arr[i] && arr[i] !== "OFF" && monMatches(cellMon(arr[i]), task?.mon);
          if(hit) run++;
          else { if(run >= 2) pairs += 1; run = 0; }
        }
      }
    }
    return Math.max(0, min - pairs);
  }catch(_){
    return 0;
  }
}

/* 27/08: LOP KHONG HOC MON NAY. Truong x2454rrc9y1: KHTN-CS / ToanCD chi day
   o 6/1, 7/1, 8/1 (Phan cong 1 tiet) nhung "Yeu cau mon hoc" van con muc
   byClass cho ca 6/2..6/8, 7/2..7/7 tu lan quick-fill "all" hoi mon con 2 tiet.
   tkbLessonBlockPeriodsForClassMon roi ve Tiet chuan THEO KHOI (khoi 6/7 van
   ghi 2 tiet) nen 26 lop khong he hoc mon do bi do bang so tiet cua ca khoi
   => bang RB bao "Tiet doi >= 1 ✗ thieu 1 cum" trong khi trinh kiem tra tong
   bao 0 vi pham. Lop khong hoc mon thi luat cua mon do la RONG: khong the vi
   pham, cung khong the sua. Nhan dien giong computeMonsForClass: co phan cong
   giao vien / co mat trong danh sach mon cua lop (Phan cong) hay khong. */
function tkbClassSubjectUnassigned(classId, mon){
  try{
    if(typeof getLopCanonById !== "function") return false;
    const canon = getLopCanonById(classId);
    const monRaw = String(mon == null ? "" : mon).trim();
    if(!canon || !monRaw) return false;
    if(typeof getTeacherForClassMon === "function"
      && String(getTeacherForClassMon(canon, monRaw) || "").trim()) return false;
    if(typeof getSoTietForClassMon === "function"
      && Number(getSoTietForClassMon(canon, monRaw)) > 0) return false;
    if(typeof _collectPCCMSubjectKeysForClass !== "function") return false;
    const keys = _collectPCCMSubjectKeysForClass(canon);
    // Lop chua co dong phan cong nao: khong ket luan (giu cach do cu).
    if(!keys || !keys.size) return false;
    for(const k of keys){
      if(typeof monMatches === "function" ? monMatches(k, monRaw) : String(k).trim() === monRaw) return false;
    }
    return true;
  }catch(_){
    return false;
  }
}

/* 25/08: so tiet/tuan cua (lop, mon) theo Phan cong (pccmTietMatrix); 0 khi
   chua biet. Dung de bo qua yeu cau "min N cum L tiet lien" bat kha thi:
   min > floor(soTiet / L) thi khong lich nao dat duoc, nen bang RB va bo tu
   sua KHONG duoc tinh la vi pham (khop TKBConstraints.impossibleLessonBlockMinimum). */
function tkbLessonBlockPeriodsForClassMon(classId, mon){
  try{
    if(typeof getLopCanonById !== "function") return 0;
    const canon = getLopCanonById(classId);
    let n = 0;
    if(typeof getSoTietForClassMon === "function") n = Number(getSoTietForClassMon(canon, mon));
    if(!(Number.isFinite(n) && n > 0) && typeof _findTietChuanRow === "function" && typeof extractKhoiNumber === "function"){
      // khong co so tiet rieng trong Phan cong -> Tiet chuan cua khoi (cung
      // cach computeMonsForClass / TKBConstraints.assignedPeriodsForConstraint)
      const lop = (DATA?.lop || []).find(l => l && (String(l.id) === String(classId) || String(l.ten || "") === canon || String(l.ten2 || "") === canon));
      const k = String(extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || extractKhoiNumber(canon) || "");
      const row = k ? _findTietChuanRow(k, mon) : null;
      n = Number(row?.sotiet || 0);
    }
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }catch(_){
    return 0;
  }
}
function tkbLessonBlockMinImpossible(classId, mon, len, min){
  if(tkbClassSubjectUnassigned(classId, mon)) return true;   // lop khong hoc mon nay
  const periods = tkbLessonBlockPeriodsForClassMon(classId, mon);
  if(periods <= 0) return false;   // chua biet so tiet: khong ket luan
  return Number(min) > Math.floor(periods / Math.max(1, Number(len) || 1));
}

function tkbAutoRepairValidateAtSlot(task, slot){
  const res = tkbAutoRepairValidateResultAtSlot(task, slot);
  if(!res || !res.ok || res.warn) return false;
  return tkbAutoRepairConstraintOk(task, slot);
}

function tkbAutoRepairSlotScore(task, slot){
  const tkb = DATA?.tkb?.[task?.classId];
  const arr = tkb?.[slot.thu]?.[slot.buoi] || [];
  let score = 0;
  const prevMon = cellMon(arr[slot.ti - 1]);
  const nextMon = cellMon(arr[slot.ti + 1]);
  if(prevMon) score += 4;
  if(nextMon) score += 4;
  if(slot.buoi === "sang") score += 2;
  score -= Number(slot.ti || 0) * 0.01;
  // Mon con thieu cum tiet doi: o ke tiet CUNG MON duoc uu tien tuyet doi
  // de pha va tu tao cum doi thay vi rai tiet le.
  if(tkbAutoRepairLessonBlockPairShortfall(task) > 0){
    const monKey = task?.mon;
    if((prevMon && monMatches(prevMon, monKey)) || (nextMon && monMatches(nextMon, monKey))) score += 12;
  }
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
        // 21/08: them lop kiem "Yeu cau" (oneSessionPerDay, khong cung
        // ngay/buoi, gioi han tiet/ngay...) truoc khi coi o nay la ung vien.
        if(ok && tkbAutoRepairConstraintOk(task.classId, task.mon, {thu, buoi, ti})){
          candidates.push({thu, buoi, ti, score: tkbAutoRepairSlotScore(task, {thu, buoi, ti})});
        }
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

// 19/08: XEP LUI (backtracking) cho MOT lop.
// Vi sao can: pha va nhanh cu chi la "tham lam first-fit" — moi tiet chon o
// dau tien hop le roi khong bao gio quay lai. Voi lop kin nhu 6/10 (dung 27 o
// trong cho dung 27 tiet, khong con o du) tham lam gan nhu chac chan ket, du
// ton tai loi giai. Do do neu tham lam bo cuoc thi chay them mot luot quay
// lui co that bai-quay-lai, van dung validateDrop lam trong tai nen moi rang
// buoc (o NGHI, tiet CO DINH, trung giao vien, trung phong, gioi han mon moi
// buoi) deu duoc ton trong y het khi nguoi dung keo tay.
function tkbBacktrackPlaceClass(classId, options={}){
  const tkb = DATA?.tkb?.[classId];
  if(!tkb) return {placed: 0, remaining: 0, ok: false, reason: "khong_co_lop"};
  const budgetMs = Math.max(500, Number(options.budgetMs) || 8000);
  const startedAt = Date.now();

  const tasks = collectUnassignedTasks({onlyClassId: String(classId)});
  const items = [];
  tasks.forEach(t => {
    const n = Math.max(0, Math.round(Number(t.remain) || 0));
    for(let i = 0; i < n; i++) items.push(t);
  });
  if(!items.length) return {placed: 0, remaining: 0, ok: true};

  const slots = [];
  for(const thu of DAYS){
    for(const buoi of ["sang", "chieu"]){
      const arr = tkb?.[thu]?.[buoi] || [];
      for(let ti = 0; ti < arr.length; ti++){
        const v = arr[ti];
        if(v === "OFF" || isFixed(v) || cellMon(v)) continue;
        slots.push({classId, thu, buoi, ti});
      }
    }
  }
  if(slots.length < items.length){
    return {placed: 0, remaining: items.length, ok: false, reason: "thieu_o", slots: slots.length, need: items.length};
  }

  // Tap o kha thi ban dau cho tung tiet (dung de cat nhanh va de sap thu tu
  // MRV: tiet nao it lua chon nhat thi thu truoc).
  const base = items.map(t => {
    const list = [];
    for(let j = 0; j < slots.length; j++){
      if(tkbAutoRepairValidateAtSlot(t, slots[j])) list.push(j);
    }
    return list;
  });
  const order = items.map((_, i) => i).sort((a, b) => base[a].length - base[b].length);
  if(order.some(i => base[i].length === 0)){
    const stuck = order.filter(i => base[i].length === 0).map(i => items[i].mon);
    return {placed: 0, remaining: items.length, ok: false, reason: "khong_o_hop_le", stuck: [...new Set(stuck)]};
  }

  const used = new Set();
  const done = [];
  let timedOut = false;
  const step = (k) => {
    if(k >= order.length) return true;
    if(Date.now() - startedAt > budgetMs){ timedOut = true; return false; }
    const i = order[k];
    const task = items[i];
    for(const j of base[i]){
      if(used.has(j)) continue;
      const slot = slots[j];
      // Kiem tra LAI theo trang thai hien tai: cac tiet vua dat cua chinh lop
      // nay co the lam thay doi gioi han buoi / trung giao vien.
      if(!tkbAutoRepairValidateAtSlot(task, slot)) continue;
      tkb[slot.thu][slot.buoi][slot.ti] = task.mon;
      used.add(j);
      done.push({slot, task});
      if(step(k + 1)) return true;
      done.pop();
      used.delete(j);
      tkb[slot.thu][slot.buoi][slot.ti] = "";
      if(timedOut) return false;
    }
    return false;
  };

  const ok = step(0);
  if(!ok){
    // Khong tim duoc loi giai day du -> tra ve nguyen trang, KHONG dat nua voi.
    while(done.length){
      const d = done.pop();
      tkb[d.slot.thu][d.slot.buoi][d.slot.ti] = "";
    }
    return {placed: 0, remaining: items.length, ok: false, reason: timedOut ? "het_thoi_gian" : "vo_nghiem"};
  }
  return {
    placed: done.length,
    remaining: 0,
    ok: true,
    ms: Date.now() - startedAt,
    details: done.map(d => ({classId, mon: d.task.mon, thu: d.slot.thu, buoi: d.slot.buoi, ti: d.slot.ti, placed: true, method: "backtrack"}))
  };
}

try{ window.__tkbBacktrackPlaceClass = tkbBacktrackPlaceClass; }catch(_){ }

// 19/08: GO NUT CHEO LOP.
// tkbBacktrackPlaceClass chi xao lai trong MOT lop, nen no bo tay khi o trong
// duy nhat con lai bi giao vien cua chinh mon do "ban" o LOP KHAC. Vi du that
// tren 6/10: chi con thu7 chieu tiet 3 va 4, ma co B.Anh dang day Van-6/8 o
// tiet 3 va GDDP-6/3 o tiet 4 -> 2 tiet Ngu van khong bao gio dat duoc.
// Ham nay di sang lop dang chan, doi tiet cua ho sang o khac (hoac hoan doi
// hai o trong chinh lop ho), roi moi dat tiet con thieu. Moi buoc deu qua
// validateDrop nen o NGHI / tiet CO DINH / trung GV / trung phong / gioi han
// van duoc ton trong. Co nhat ky de hoan tac sach neu khong thanh.
function tkbCrossClassEjectionPlace(task, options={}){
  const classId = task?.classId;
  const tkb = DATA?.tkb?.[classId];
  if(!tkb) return null;
  const maxSwapScan = Math.max(1, Number(options.maxSwapScan) || 60);

  const journal = [];
  const setCell = (lopId, slot, value) => {
    const grid = DATA?.tkb?.[lopId];
    if(!grid?.[slot.thu]?.[slot.buoi]) return false;
    journal.push({lopId, slot, prev: grid[slot.thu][slot.buoi][slot.ti]});
    grid[slot.thu][slot.buoi][slot.ti] = value;
    return true;
  };
  const rollback = () => {
    while(journal.length){
      const j = journal.pop();
      const grid = DATA?.tkb?.[j.lopId];
      if(grid?.[j.slot.thu]?.[j.slot.buoi]) grid[j.slot.thu][j.slot.buoi][j.slot.ti] = j.prev;
    }
  };

  const targets = [];
  for(const thu of DAYS){
    for(const buoi of ["sang", "chieu"]){
      const arr = tkb?.[thu]?.[buoi] || [];
      for(let ti = 0; ti < arr.length; ti++){
        const v = arr[ti];
        if(v === "OFF" || isFixed(v) || cellMon(v)) continue;
        targets.push({classId, thu, buoi, ti});
      }
    }
  }

  const teachers = teacherListFromValue(task.gv || getTeacherForClassMon(task.classCanon, task.mon));

  for(const slot of targets){
    const mark = journal.length;
    let cleared = true;
    // Mot o co the bi nhieu giao viec cua mon nay chan (mon day chung).
    for(const gv of teachers){
      let guard = 0;
      while(guard++ < 4){
        const clash = findTeacherConflictAtSlot(gv, slot.thu, slot.buoi, slot.ti, classId, task.mon);
        if(!clash) break;
        if(!tkbFreeBlockingLesson(clash.lopId, slot, setCell, maxSwapScan)){ cleared = false; break; }
      }
      if(!cleared) break;
    }
    if(cleared && tkbAutoRepairValidateAtSlot(task, slot)){
      tkb[slot.thu][slot.buoi][slot.ti] = task.mon;
      return {
        classId,
        className: task.className,
        mon: task.mon,
        thu: slot.thu,
        buoi: slot.buoi,
        ti: slot.ti,
        placed: true,
        method: "cross_class_ejection",
        moves: journal.length
      };
    }
    // Khong xong o nay -> tra lai nguyen trang roi thu o ke tiep.
    while(journal.length > mark){
      const j = journal.pop();
      const grid = DATA?.tkb?.[j.lopId];
      if(grid?.[j.slot.thu]?.[j.slot.buoi]) grid[j.slot.thu][j.slot.buoi][j.slot.ti] = j.prev;
    }
  }

  // Giai doan 2: o trong con lai bi chan cung dau -> HOAN DOI trong chinh lop.
  // Doi mot tiet khac cua lop sang o trong, roi dat tiet dang thieu vao cho
  // vua giai phong (cho do giao vien cua no ranh). Vi du that tren 6/10: o
  // trong cuoi cung la thu 7 chieu t4 nhung B.Anh dang day GDDP-6/2 o do;
  // chuyen GDCD tu thu 2 sang t1 xuong thu 7 chieu t4, roi dat Ngu van vao
  // thu 2 sang t1 - hop le hoan toan.
  const movable = [];
  for(const thu of DAYS){
    for(const buoi of ["sang", "chieu"]){
      const arr = tkb?.[thu]?.[buoi] || [];
      for(let ti = 0; ti < arr.length; ti++){
        const v = arr[ti];
        if(v === "OFF" || isFixed(v) || !cellMon(v)) continue;
        movable.push({classId, thu, buoi, ti});
      }
    }
  }
  const taskKey = monCanonicalKey(task.mon);
  for(const blank of targets){
    for(const spot of movable){
      const mark2 = journal.length;
      const val = tkbAutoRepairSlotValue(classId, spot);
      const mon2 = cellMon(val);
      if(!mon2 || monCanonicalKey(mon2) === taskKey) continue;
      const task2 = {classId, classCanon: task.classCanon, className: task.className, mon: mon2, remain: 1};
      setCell(classId, spot, "");
      const okMove = tkbAutoRepairValidateAtSlot(task2, blank);
      if(okMove){
        setCell(classId, blank, val);
        let cleared2 = true;
        for(const gv of teachers){
          let guard2 = 0;
          while(guard2++ < 4){
            const clash = findTeacherConflictAtSlot(gv, spot.thu, spot.buoi, spot.ti, classId, task.mon);
            if(!clash) break;
            if(!tkbFreeBlockingLesson(clash.lopId, spot, setCell, maxSwapScan)){ cleared2 = false; break; }
          }
          if(!cleared2) break;
        }
        if(cleared2 && tkbAutoRepairValidateAtSlot(task, spot)){
          tkb[spot.thu][spot.buoi][spot.ti] = task.mon;
          return {
            classId,
            className: task.className,
            mon: task.mon,
            thu: spot.thu,
            buoi: spot.buoi,
            ti: spot.ti,
            placed: true,
            method: "swap_then_place",
            movedMon: mon2,
            movedTo: {thu: blank.thu, buoi: blank.buoi, ti: blank.ti},
            moves: journal.length
          };
        }
      }
      while(journal.length > mark2){
        const j = journal.pop();
        const grid = DATA?.tkb?.[j.lopId];
        if(grid?.[j.slot.thu]?.[j.slot.buoi]) grid[j.slot.thu][j.slot.buoi][j.slot.ti] = j.prev;
      }
    }
  }

  rollback();
  return null;
}

// Don o (thu, buoi, ti) cua lop `lopId`: chuyen tiet dang o do sang o trong
// khac cua chinh lop do, hoac hoan doi voi mot tiet khac cung lop.
function tkbFreeBlockingLesson(lopId, slot, setCell, maxSwapScan){
  const grid = DATA?.tkb?.[lopId];
  if(!grid) return false;
  const here = {classId: lopId, thu: slot.thu, buoi: slot.buoi, ti: slot.ti};
  const val = tkbAutoRepairSlotValue(lopId, here);
  if(val === "OFF" || isFixed(val)) return false;   // tiet CO DINH: khong dong vao
  const mon = cellMon(val);
  if(!mon) return true;
  const canon = getLopCanonById(lopId);
  const moveTask = {classId: lopId, classCanon: canon, className: canon, mon, remain: 1};

  const slots = tkbAutoRepairSlotsForClass(lopId)
    .filter(s => !(s.thu === here.thu && s.buoi === here.buoi && s.ti === here.ti));

  // 1) Con o trong trong lop do -> chi can doi sang.
  if(!setCell(lopId, here, "")) return false;
  for(const s of slots){
    if(!tkbAutoRepairIsBlankSlot(lopId, s)) continue;
    if(!tkbAutoRepairValidateAtSlot(moveTask, s)) continue;
    setCell(lopId, s, val);
    return true;
  }

  // 2) Lop do da kin -> hoan doi voi mot tiet khac cung lop.
  let scanned = 0;
  for(const s of slots){
    if(scanned++ > maxSwapScan) break;
    if(!tkbAutoRepairIsMovableLesson(lopId, s)) continue;
    const val2 = tkbAutoRepairSlotValue(lopId, s);
    const mon2 = cellMon(val2);
    if(!mon2 || monCanonicalKey(mon2) === monCanonicalKey(mon)) continue;
    const task2 = {classId: lopId, classCanon: canon, className: canon, mon: mon2, remain: 1};
    setCell(lopId, s, "");
    const okA = tkbAutoRepairValidateAtSlot(moveTask, s);
    const okB = okA && tkbAutoRepairValidateAtSlot(task2, here);
    if(okA && okB){
      setCell(lopId, s, val);
      setCell(lopId, here, val2);
      return true;
    }
    setCell(lopId, s, val2);
  }
  return false;
}

try{ window.__tkbCrossClassEjectionPlace = tkbCrossClassEjectionPlace; }catch(_){ }

/* 21/08: PASS "DU CAP TIET DOI". Sau khi va xong tiet thieu, ra soat moi
   (lop, mon) co yeu cau lessonBlocks[2].min chua dat va thu SWAP noi lop de
   keo mot tiet cua mon ve KE tiet cung mon (moi buoc qua validateDrop +
   TKBConstraints.canPlaceCell nhu keo tay). Co ngan sach thoi gian de khong
   treo; truong hop qua ket van de lai cho bang loi rang buoc bao. */
function tkbPairTrySwapCells(classId, src, dst){
  const tkb = DATA?.tkb?.[classId];
  if(!tkb?.[src.thu]?.[src.buoi] || !tkb?.[dst.thu]?.[dst.buoi]) return false;
  const vS = tkb[src.thu][src.buoi][src.ti];
  const vD = tkb[dst.thu][dst.buoi][dst.ti];
  const bad = v=>!v || v === "OFF" || isFixed(v);
  if(bad(vS) || bad(vD)) return false;
  const monS = cellMon(vS), monD = cellMon(vD);
  if(!monS || !monD) return false;
  const classCanon = getLopCanonById(classId);
  // B1: dua tiet mon (src) sang dst — di doi tiet dang co
  tkb[dst.thu][dst.buoi][dst.ti] = "";
  const taskM = {classId, classCanon, mon: monS, remain: 1,
    dragData: {type:"cell", classId, from: tkbAutoRepairSlotStub({classId, thu:src.thu, buoi:src.buoi, ti:src.ti}), val: vS, mon: monS}};
  if(!tkbAutoRepairValidateAtSlot(taskM, dst)){
    tkb[dst.thu][dst.buoi][dst.ti] = vD;
    return false;
  }
  tkb[src.thu][src.buoi][src.ti] = "";
  tkb[dst.thu][dst.buoi][dst.ti] = vS;
  // B2: dua mon X (vua nhac khoi dst) ve o nguon
  const taskX = {classId, classCanon, mon: monD, remain: 1};
  if(!tkbAutoRepairValidateAtSlot(taskX, src)){
    tkb[src.thu][src.buoi][src.ti] = vS;
    tkb[dst.thu][dst.buoi][dst.ti] = vD;
    return false;
  }
  tkb[src.thu][src.buoi][src.ti] = vD;
  return true;
}

/* 21/08: xoay 3 o cung lop (src -> dst, tiet o dst -> mid, tiet o mid -> src).
   Moi buoc deu qua tkbAutoRepairValidateAtSlot nhu keo tay; hong o buoc nao
   thi tra nguyen trang. Dung cho ca ket ma hoan doi 2 o khong go duoc. */
function tkbTriangleRotateCells(classId, src, dst, mid){
  const tkb = DATA?.tkb?.[classId];
  if(!tkb?.[src.thu]?.[src.buoi] || !tkb?.[dst.thu]?.[dst.buoi] || !tkb?.[mid.thu]?.[mid.buoi]) return false;
  const vS = tkb[src.thu][src.buoi][src.ti];
  const vD = tkb[dst.thu][dst.buoi][dst.ti];
  const vM = tkb[mid.thu][mid.buoi][mid.ti];
  const bad = v=>!v || v === "OFF" || isFixed(v);
  if(bad(vS) || bad(vD) || bad(vM)) return false;
  const classCanon = getLopCanonById(classId);
  const restore = ()=>{
    tkb[src.thu][src.buoi][src.ti] = vS;
    tkb[dst.thu][dst.buoi][dst.ti] = vD;
    tkb[mid.thu][mid.buoi][mid.ti] = vM;
  };
  const mk = mon => ({classId, classCanon, mon, remain: 1});
  tkb[dst.thu][dst.buoi][dst.ti] = "";
  const taskS = Object.assign(mk(cellMon(vS)), {
    dragData: {type:"cell", classId, from: tkbAutoRepairSlotStub({classId, thu:src.thu, buoi:src.buoi, ti:src.ti}), val: vS, mon: cellMon(vS)}
  });
  if(!tkbAutoRepairValidateAtSlot(taskS, dst)){ restore(); return false; }
  tkb[src.thu][src.buoi][src.ti] = "";
  tkb[dst.thu][dst.buoi][dst.ti] = vS;
  tkb[mid.thu][mid.buoi][mid.ti] = "";
  if(!tkbAutoRepairValidateAtSlot(mk(cellMon(vD)), mid)){ restore(); return false; }
  tkb[mid.thu][mid.buoi][mid.ti] = vD;
  if(!tkbAutoRepairValidateAtSlot(mk(cellMon(vM)), src)){ restore(); return false; }
  tkb[src.thu][src.buoi][src.ti] = vM;
  return true;
}

function tkbPairListShortfallCases(onlyClassId){
  const out = [];
  const subj = DATA?.tkbConstraints?.subject || {};
  for(const key of Object.keys(subj)){
    const byClass = subj[key]?.byClass || {};
    for(const cid of Object.keys(byClass)){
      if(onlyClassId && String(cid) !== String(onlyClassId)) continue;
      if(Number(byClass[cid]?.lessonBlocks?.[2]?.min || 0) <= 0) continue;
      if(tkbAutoRepairLessonBlockPairShortfall({classId: cid, mon: key}) > 0){
        out.push({classId: String(cid), mon: key});
      }
    }
  }
  return out;
}

async function tkbPairSimpleFixCase(cse, deadline, slice){
  const tkb = DATA?.tkb?.[cse.classId];
  if(!tkb) return false;
  const spots = [];
  DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
    (tkb?.[thu]?.[buoi]||[]).forEach((v,i)=>{
      if(v && v !== "OFF" && !isFixed(v) && monMatches(cellMon(v), cse.mon)) spots.push({thu, buoi, ti:i});
    });
  }));
  for(const anchor of spots){
    for(const d of [-1, 1]){
      const ti = anchor.ti + d;
      if(ti < 0) continue;
      const arr = tkb?.[anchor.thu]?.[anchor.buoi] || [];
      if(ti >= arr.length) continue;
      const dv = arr[ti];
      if(!dv || dv === "OFF" || isFixed(dv) || monMatches(cellMon(dv), cse.mon)) continue;
      const dst = {thu: anchor.thu, buoi: anchor.buoi, ti};
      for(const src of spots){
        if(src.thu === anchor.thu && src.buoi === anchor.buoi) continue;
        if(Date.now() > deadline) return false;
        if(slice) await tkbQualityMaybeYield(slice);
        if(tkbPairTrySwapCells(cse.classId, src, dst)) return true;
      }
    }
  }
  return false;
}

/* 21/08: chien luoc SAU cho cap tiet doi khi hoan doi don khong go duoc:
   chon mot cap o ke nhau ma GV cua mon ranh o ca hai tiet (hoac dang day
   chinh mon do), roi keo 2 tiet cua mon ve dung cap o do bang hoan doi 2 o
   hoac xoay 3 o. Chi giu ket qua khi tong so loi rang buoc GIAM. */
async function tkbPairDeepFixCase(classId, monKey, deadline, slice){
  const tkb = DATA?.tkb?.[classId];
  if(!tkb || typeof TKBConstraints === "undefined") return false;
  const snapshot = JSON.parse(JSON.stringify(tkb));
  const restoreSnapshot = ()=>{
    DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
      const from = snapshot?.[thu]?.[buoi] || [];
      const to = tkb?.[thu]?.[buoi];
      if(to) from.forEach((v,i)=>{ to[i] = v; });
    }));
  };
  // 22/08: chi quet PHAM VI LOP nay (vai chuc ms) thay vi validateAll toan
  // truong (1-3 s dong bo); caller xac nhan toan truong bang ban chia lat.
  const before = tkbVioScopedCount(classId);
  const classCanon = getLopCanonById(classId);
  const gv = getTeacherForClassMon(classCanon, monKey);
  const busy = new Set();
  if(gv){
    Object.keys(DATA?.tkb || {}).forEach(otherId => {
      if(String(otherId) === String(classId)) return;
      const otherCanon = getLopCanonById(otherId);
      const grid = DATA.tkb[otherId];
      DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
        (grid?.[thu]?.[buoi]||[]).forEach((v,ti)=>{
          if(!v || v === "OFF") return;
          const g = getTeacherForClassMon(otherCanon, cellMon(v));
          if(g && teacherValueHas(g, gv)) busy.add(`${thu}|${buoi}|${ti}`);
        });
      }));
    });
  }
  const usable = v => v && v !== "OFF" && !isFixed(v);
  const isMonCell = v => usable(v) && monMatches(cellMon(v), monKey);
  const monSpots = ()=>{
    const out = [];
    DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
      (tkb?.[thu]?.[buoi]||[]).forEach((v,i)=>{ if(isMonCell(v)) out.push({thu, buoi, ti:i}); });
    }));
    return out;
  };
  const allSlots = ()=>{
    const out = [];
    DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
      (tkb?.[thu]?.[buoi]||[]).forEach((v,i)=>{ if(usable(v)) out.push({thu, buoi, ti:i}); });
    }));
    return out;
  };
  const pairs = [];
  DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
    const arr = tkb?.[thu]?.[buoi] || [];
    for(let i = 0; i + 1 < arr.length; i++){
      if(!usable(arr[i]) || !usable(arr[i+1])) continue;
      const aOk = !busy.has(`${thu}|${buoi}|${i}`) || isMonCell(arr[i]);
      const bOk = !busy.has(`${thu}|${buoi}|${i+1}`) || isMonCell(arr[i+1]);
      if(aOk && bOk) pairs.push({thu, buoi, ti:i});
    }
  }));
  for(const p of pairs){
    if(Date.now() > deadline) break;
    const targets = [{thu:p.thu, buoi:p.buoi, ti:p.ti}, {thu:p.thu, buoi:p.buoi, ti:p.ti+1}]
      .filter(t => !isMonCell(tkb[t.thu][t.buoi][t.ti]));
    let ok = true;
    for(const target of targets){
      const sources = monSpots().filter(s => !(s.thu === p.thu && s.buoi === p.buoi));
      let placedOne = false;
      for(const srcSpot of sources){
        if(Date.now() > deadline){ ok = false; break; }
        if(slice) await tkbQualityMaybeYield(slice);
        if(tkbPairTrySwapCells(classId, srcSpot, target)){ placedOne = true; break; }
        for(const mid of allSlots()){
          if(mid.thu === srcSpot.thu && mid.buoi === srcSpot.buoi && mid.ti === srcSpot.ti) continue;
          if(mid.thu === target.thu && mid.buoi === target.buoi && mid.ti === target.ti) continue;
          if(tkbTriangleRotateCells(classId, srcSpot, target, mid)){ placedOne = true; break; }
        }
        if(placedOne) break;
      }
      if(!placedOne){ ok = false; break; }
    }
    if(ok){
      const after = tkbVioScopedCount(classId);
      if(after < before) return true;
    }
    restoreSnapshot();
  }
  restoreSnapshot();
  return false;
}

async function tkbAutoRepairEnsureLessonPairs(options = {}){
  const deadline = Date.now() + Math.max(1000, Number(options.budgetMs) || 6000);
  const fixedCases = [];
  const slice = {lastYield: Date.now()};
  let cases = [];
  try{ cases = tkbPairListShortfallCases(options.onlyClassId); }catch(_){ return fixedCases; }
  if(!cases.length) return fixedCases;
  // 22/08: quet toan truong MOT lan (chia lat); moi ca sua xong duoc xac nhan
  // toan truong, xau hon thi hoan tac — khong con validateAll dong bo.
  const vio = tkbVioStateFromItems(await tkbVioScanAsync());
  for(const cse of cases){
    if(Date.now() > deadline) break;
    const gridBefore = tkbGridSnapshot();
    let done = false;
    try{ done = await tkbPairSimpleFixCase(cse, deadline, slice); }catch(_){ }
    if(!done && Date.now() <= deadline){
      try{ done = await tkbPairDeepFixCase(cse.classId, cse.mon, deadline, slice); }catch(e){ console.warn("pair deep fix failed", e); }
    }
    if(done && !(await tkbVioConfirmMove(vio, gridBefore, false))) done = false;
    if(done) fixedCases.push(`${cse.classId}|${cse.mon}`);
  }
  return fixedCases;
}

function tkbAutoPlaceUnassignedLessons(options={}){
  // 22/08 (toi): bo qua tiet Cherry da dua ra vi chat luong GV (xem
  // TKB_SKIP_QUALITY_EJECTED_TASKS) tru khi goi ro includeQualityEjected.
  const prevSkip = TKB_SKIP_QUALITY_EJECTED_TASKS;
  const prevOverride = TKB_QUALITY_EJECTED_OVERRIDE;
  // 22/08 (khuya): engine khong rot tiet nua -> va nhanh xep MOI tiet Chua phan
  // nhu truoc; chi bo qua tiet "rot vi chat luong" khi goi ro excludeQualityEjected
  // (du lieu cu con ma ly do teacher_quality_unreachable).
  TKB_SKIP_QUALITY_EJECTED_TASKS = options.excludeQualityEjected === true;
  TKB_QUALITY_EJECTED_OVERRIDE = Array.isArray(options.qualityEjectedItems) ? options.qualityEjectedItems : null;
  try{
    return tkbAutoPlaceUnassignedLessonsInner(options);
  }finally{
    TKB_SKIP_QUALITY_EJECTED_TASKS = prevSkip;
    TKB_QUALITY_EJECTED_OVERRIDE = prevOverride;
  }
}

function tkbAutoPlaceUnassignedLessonsInner(options={}){
  // 19/08: tran cu la 24 nen mot lop thieu 27 tiet (6/10) khong bao gio duoc
  // va het. Nguoi dung yeu cau "cu xep vao", nen tran mac dinh phai lon hon
  // so tiet thuc te con thieu.
  const maxPlace = Math.max(0, Math.round(Number(options.maxPlace ?? 400) || 0));
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

  // Tham lam da het duong -> quay lui tung lop. Xu ly lop thieu nhieu truoc.
  if(options.backtrack !== false){
    const budgetMs = Math.max(1000, Number(options.backtrackBudgetMs) || 8000);
    const leftover = collectUnassignedTasks(onlyClassId ? {onlyClassId} : {});
    const byClass = new Map();
    leftover.forEach(t => {
      const cur = byClass.get(t.classId) || {classId: t.classId, className: t.className, remain: 0};
      cur.remain += Math.max(0, Number(t.remain) || 0);
      byClass.set(t.classId, cur);
    });
    const classes = [...byClass.values()].sort((a, b) => b.remain - a.remain);
    for(const c of classes){
      if(placed >= maxPlace) break;
      const res = tkbBacktrackPlaceClass(c.classId, {budgetMs});
      if(res && res.ok && res.placed > 0){
        placed += res.placed;
        (res.details || []).forEach(d => details.push(Object.assign({className: c.className}, d)));
      }else if(res){
        details.push({classId: c.classId, className: c.className, placed: false, method: "backtrack", reason: res.reason, stuck: res.stuck});
      }
    }

    // Con sot lai -> go nut cheo lop (doi tiet cua lop khac de giai phong GV).
    let guard = 0;
    while(placed < maxPlace && guard++ < 60){
      const rest = collectUnassignedTasks(onlyClassId ? {onlyClassId} : {});
      if(!rest.length) break;
      let moved = false;
      for(const task of rest){
        if(placed >= maxPlace) break;
        const done = tkbCrossClassEjectionPlace(task);
        if(done){
          placed++;
          moved = true;
          details.push(done);
          break;
        }
        details.push({classId: task.classId, className: task.className, mon: task.mon, placed: false, method: "cross_class_ejection"});
      }
      if(!moved) break;
    }
  }

  // 21/08: viec ep du cap tiet doi da chuyen sang pass ASYNC (bridge goi sau
  // MOI lan ap ket qua xep). O day chi kich hoat nen khi duoc va truc tiep tu
  // giao dien de khong chan luong dong bo.
  try{
    if(options.ensurePairs !== false && typeof window.__tkbEnsureLessonPairs === "function"){
      window.__tkbEnsureLessonPairs({onlyClassId, budgetMs: 6000});
    }
  }catch(_){ }

  if(placed > 0){
    try{ saveStore({force:true}); }catch(e){ console.error("saveStore failed", e); }
    if(options.render !== false){
      try{ renderCurrentView(); }catch(e){ console.error("renderCurrentView failed", e); }
      try{ loadMonList(); }catch(e){ console.error("loadMonList failed", e); }
      try{ refreshStatsBoxIfOpen(); }catch(_){ }
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

/* 21/08: PASS "BUOI DAY GV" chay sau khi ap ket qua xep: do dem buoi GV chi
   day 1 tiet va buoi GV trong >= 2 tiet giua hai tiet day, roi go bang hoan
   doi noi lop (giu nguyen do day cua lop, moi buoc qua kiem tra rang buoc).
   Mot buoc doi chi duoc GIU khi chi so muc tieu giam, chi so kia khong tang
   va tong so loi rang buoc khong tang. */
function tkbTeacherQualitySnapshot(){
  const sessions = new Map();
  Object.keys(DATA?.tkb || {}).forEach(cid => {
    const canon = getLopCanonById(cid);
    const grid = DATA.tkb[cid];
    DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
      (grid?.[thu]?.[buoi]||[]).forEach((v,ti)=>{
        if(!v || v === "OFF") return;
        const mon = cellMon(v);
        if(!mon) return;
        const gv = getTeacherForClassMon(canon, mon);
        if(!gv) return;
        String(gv).split(/[,;+]/).map(s=>s.trim()).filter(Boolean).forEach(code=>{
          if(!sessions.has(code)) sessions.set(code, new Map());
          const byKey = sessions.get(code);
          const key = `${thu}|${buoi}`;
          if(!byKey.has(key)) byKey.set(key, []);
          byKey.get(key).push({ti, classId: String(cid), thu, buoi});
        });
      });
    }));
  });
  let onePeriod = 0, gap1 = 0, gap2Plus = 0, excess = 0;
  const onePeriodCases = [], gapCases = [], gap1Cases = [];
  sessions.forEach((byKey, code)=>{
    byKey.forEach((cells, key)=>{
      const tis = [...new Set(cells.map(c=>c.ti))].sort((a,b)=>a-b);
      if(tis.length === 1){ onePeriod++; onePeriodCases.push({code, key, cells}); return; }
      const holes = (tis[tis.length-1] - tis[0] + 1) - tis.length;
      if(holes === 1){ gap1++; gap1Cases.push({code, key, cells, holes}); }
      else if(holes >= 2){ gap2Plus++; gapCases.push({code, key, cells, holes}); }
      excess += Math.max(0, holes - 1);
    });
  });
  // "bad" = so buoi xau (1 tiet/buoi + trong >= 2); "excess" = tong so lo
  // trong vuot muc 1 — dung so sanh vector de nhan ca cai thien TUNG PHAN
  // (vi du buoi trong 3 tiet lap con 2 van la tien bo).
  return {onePeriod, gap1, gap2Plus, excess, bad: onePeriod + gap2Plus, onePeriodCases, gapCases, gap1Cases, sessions};
}

function tkbCellPairBackup(classId, a, b){
  const grid = DATA?.tkb?.[classId];
  const rowA = grid?.[a.thu]?.[a.buoi];
  const rowB = grid?.[b.thu]?.[b.buoi];
  if(!rowA || !rowB) return null;
  const va = rowA[a.ti], vb = rowB[b.ti];
  return ()=>{ rowA[a.ti] = va; rowB[b.ti] = vb; };
}

// So sanh vector (bad, excess): true khi `now` tot hon `base` that su.
function tkbTeacherQualityBetter(now, base){
  if(now.bad !== base.bad) return now.bad < base.bad;
  return now.excess < base.excess;
}

function tkbCellsBackup(classId, slots){
  const grid = DATA?.tkb?.[classId];
  if(!grid) return null;
  const saved = [];
  for(const s of slots){
    const row = grid?.[s.thu]?.[s.buoi];
    if(!row) return null;
    saved.push({row, ti: s.ti, v: row[s.ti]});
  }
  return ()=>{ saved.forEach(x=>{ x.row[x.ti] = x.v; }); };
}

/* 21/08: cac pass chat luong chay ASYNC theo lat ~40ms de khong dong bang
   giao dien (truoc day chay dong bo 8-16s lien tuc gay khung). Khi tab bi an
   thi nhuong quyen qua Web Worker timer de Chrome khong bop tien do. */
const TKB_QUALITY_SLICE_MS = 40;
function tkbQualityYield(){
  try{
    if(document.hidden && typeof window.__tkbBgSleep === "function") return window.__tkbBgSleep(0);
  }catch(_){ }
  return new Promise(r=>setTimeout(r, 0));
}
async function tkbQualityMaybeYield(slice){
  if(Date.now() - slice.lastYield < TKB_QUALITY_SLICE_MS) return;
  await tkbQualityYield();
  slice.lastYield = Date.now();
}

/* 22/08 (Cherry "giat / do"): TKBConstraints.validateAll() quet TOAN truong
   (74 lop: 1-3 s, DONG BO) nhung cac pass hau kiem ben duoi goi no trong
   TUNG lan thu doi o va moi vong lap -> sau khi ap ket qua, giao dien dong
   bang tung cu 1-3 s suot 10-50 s. Thay bang hai lop kiem tra:
   (1) accepted(classId): chi kiem tra PHAM VI LOP vua doi o
       (TKBConstraints.validateClasses, vai chuc ms) so voi so loi cua lop do
       luc bat dau pass;
   (2) nuoc di duoc giu -> XAC NHAN TOAN TRUONG bang validateAllAsync (chia lat
       8 ms, khong dong bang); tong loi tang thi hoan tac ca nuoc di.
   Ket qua van "khong bao gio lam xau them" nhu truoc, nhung khong con do. */
// Tran cao de so dem khong bi "bao hoa" (luoi dang hong nang co the co vai
// tram loi; bao hoa thi phep so sanh <= se bo lot loi moi).
const TKB_VIO_SCAN_MAX = 3000;

function tkbVioStateFromItems(items){
  const state = {base: 0, byClass: new Map()};
  const list = Array.isArray(items) ? items : [];
  state.base = list.length;
  list.forEach(v => {
    const key = String(v?.lopId || "");
    if(!key) return;
    state.byClass.set(key, (state.byClass.get(key) || 0) + 1);
  });
  return state;
}

async function tkbVioScanAsync(){
  const api = (typeof TKBConstraints !== "undefined") ? TKBConstraints : null;
  if(!api) return [];
  try{
    if(typeof api.validateAllAsync === "function"){
      let r = await api.validateAllAsync(TKB_VIO_SCAN_MAX, {sliceBudgetMs: 8});
      if(r && r.stale === true) r = await api.validateAllAsync(TKB_VIO_SCAN_MAX, {sliceBudgetMs: 8});
      if(Array.isArray(r)) return r;
    }
    if(typeof api.validateAll === "function") return api.validateAll(TKB_VIO_SCAN_MAX) || [];
  }catch(_){ }
  return [];
}

function tkbVioScopedCount(classId){
  const api = (typeof TKBConstraints !== "undefined") ? TKBConstraints : null;
  if(!api || typeof api.validateClasses !== "function") return 0;
  try{ return (api.validateClasses([String(classId)], TKB_VIO_SCAN_MAX) || []).length; }
  catch(_){ return 0; }
}

// Dieu kien nhanh trong accepted(): lop vua doi o khong duoc co them loi so
// voi luc bat dau pass (cac lop khac chua doi -> khong can quet).
function tkbVioScopedOk(state, classId, strictLess){
  if(!state) return true;
  const api = (typeof TKBConstraints !== "undefined") ? TKBConstraints : null;
  if(!api || typeof api.validateClasses !== "function") return true;
  const now = tkbVioScopedCount(classId);
  const base = state.byClass.get(String(classId)) || 0;
  return strictLess ? now < base : now <= base;
}

function tkbGridSnapshot(){
  try{
    return JSON.stringify({
      tkb: DATA?.tkb || {},
      lt: DATA?.tkbLessonTeachers || {},
      lr: DATA?.tkbLessonRooms || {}
    });
  }catch(_){ return null; }
}

function tkbGridRestore(snapshot){
  if(!snapshot) return false;
  try{
    const saved = JSON.parse(snapshot);
    const tkb = DATA.tkb || (DATA.tkb = {});
    Object.keys(saved.tkb || {}).forEach(cid => {
      if(!tkb[cid]){ tkb[cid] = saved.tkb[cid]; return; }
      Object.keys(saved.tkb[cid] || {}).forEach(thu => {
        if(!tkb[cid][thu]){ tkb[cid][thu] = saved.tkb[cid][thu]; return; }
        Object.keys(saved.tkb[cid][thu] || {}).forEach(buoi => { tkb[cid][thu][buoi] = saved.tkb[cid][thu][buoi]; });
      });
    });
    DATA.tkbLessonTeachers = saved.lt || {};
    DATA.tkbLessonRooms = saved.lr || {};
    window.__TKB_TEACHER_TKB_STATS_CACHE = null;
    window.__TKB_UNASSIGNED_TASKS_CACHE = null;
    return true;
  }catch(_){ return false; }
}

// Sau khi mot nuoc di duoc giu: xac nhan toan truong (chia lat, khong dong
// bang). true = giu (cap nhat state); false = da hoan tac ve snapshot.
async function tkbVioConfirmMove(state, snapshot, strictLess){
  if(!state) return true;
  const items = await tkbVioScanAsync();
  const total = items.length;
  const ok = strictLess ? total < state.base : total <= state.base;
  if(!ok){
    tkbGridRestore(snapshot);
    return false;
  }
  const next = tkbVioStateFromItems(items);
  state.base = next.base;
  state.byClass = next.byClass;
  return true;
}

// Dua tiet o `src` ve `dst` (cung lop): thu hoan doi 2 o truoc, khong duoc
// thi xoay 3 o qua mot o trung gian bat ky cua lop. Chi GIU khi acceptFn()
// dong y; nguoc lai tra nguyen trang.
async function tkbTryMoveCellWithFallback(classId, src, dst, acceptFn, deadline, slice){
  // 22/08: acceptFn nhan classId de kiem tra rang buoc theo PHAM VI LOP.
  let undo = tkbCellsBackup(classId, [src, dst]);
  if(undo && tkbPairTrySwapCells(classId, src, dst)){
    if(acceptFn(classId)) return "swap";
    undo();
  }
  const grid = DATA?.tkb?.[classId];
  const mids = [];
  DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
    (grid?.[thu]?.[buoi]||[]).forEach((v,i)=>{
      if(!v || v === "OFF" || isFixed(v)) return;
      if(thu === src.thu && buoi === src.buoi && i === src.ti) return;
      if(thu === dst.thu && buoi === dst.buoi && i === dst.ti) return;
      mids.push({thu, buoi, ti:i});
    });
  }));
  for(const mid of mids){
    if(Date.now() > deadline) return null;
    if(slice) await tkbQualityMaybeYield(slice);
    undo = tkbCellsBackup(classId, [src, dst, mid]);
    if(!undo) continue;
    if(!tkbTriangleRotateCells(classId, src, dst, mid)) continue;
    if(acceptFn(classId)) return "tri";
    undo();
  }
  return null;
}

// Chieu nguoc lai: keo mot tiet KHAC cua chinh GV tu buoi khac VE cac vi
// tri `targetTis` cua buoi `key` (lap lo trong / ghep sat tiet le).
async function tkbTeacherTryPullIntoSession(code, key, targetTis, sessions, acceptFn, deadline, slice){
  const parts = key.split("|");
  const thu = parts[0], buoi = parts[1];
  const byKey = sessions.get(code) || new Map();
  for(const [key2, cells2] of byKey){
    if(key2 === key) continue;
    for(const cell2 of cells2){
      for(const ti of targetTis){
        if(Date.now() > deadline) return false;
        const arr = DATA?.tkb?.[cell2.classId]?.[thu]?.[buoi] || [];
        if(ti < 0 || ti >= arr.length) continue;
        if(await tkbTryMoveCellWithFallback(
          cell2.classId,
          {thu: cell2.thu, buoi: cell2.buoi, ti: cell2.ti},
          {thu, buoi, ti},
          acceptFn,
          deadline,
          slice
        )) return true;
      }
    }
  }
  return false;
}

// Thu chuyen o `cell` (cua GV `code`) sang mot buoi KHAC ma GV da co mat,
// dat vao lo trong hoac sat ngay dau/cuoi day tiet cua GV o buoi do.
async function tkbTeacherTrySwapIntoOwnSession(code, cell, sessions, excludeKey, acceptFn, deadline, slice){
  const byKey = sessions.get(code) || new Map();
  for(const [key2, cells2] of byKey){
    if(key2 === excludeKey) continue;
    const p2 = key2.split("|");
    const thu2 = p2[0], buoi2 = p2[1];
    const tis2 = [...new Set(cells2.map(c=>c.ti))].sort((a,b)=>a-b);
    const targets = [];
    for(let t = tis2[0] + 1; t < tis2[tis2.length-1]; t++){ if(!tis2.includes(t)) targets.push(t); }
    if(tis2[0] > 0) targets.push(tis2[0] - 1);
    targets.push(tis2[tis2.length-1] + 1);
    for(const ti2 of targets){
      if(Date.now() > deadline) return false;
      const arr = DATA?.tkb?.[cell.classId]?.[thu2]?.[buoi2] || [];
      if(ti2 < 0 || ti2 >= arr.length) continue;
      if(await tkbTryMoveCellWithFallback(
        cell.classId,
        {thu: cell.thu, buoi: cell.buoi, ti: cell.ti},
        {thu: thu2, buoi: buoi2, ti: ti2},
        acceptFn,
        deadline,
        slice
      )) return true;
    }
  }
  return false;
}

async function tkbAutoRepairTeacherQuality(options = {}){
  const deadline = Date.now() + Math.max(1000, Number(options.budgetMs) || 6000);
  const fixes = [];
  const slice = {lastYield: Date.now()};
  // 22/08: quet toan truong MOT lan (chia lat), sau do chi kiem tra pham vi lop.
  const vio = tkbVioStateFromItems(await tkbVioScanAsync());
  let guard = 0;
  while(Date.now() <= deadline && guard++ < 80){
    const snap = tkbTeacherQualitySnapshot();
    if(!snap.gapCases.length && !snap.onePeriodCases.length) break;
    const gridBefore = tkbGridSnapshot();
    const accepted = (classId)=>{
      const now = tkbTeacherQualitySnapshot();
      return tkbTeacherQualityBetter(now, snap) && tkbVioScopedOk(vio, classId, false);
    };
    let improved = false;

    // 1) Buoi GV trong >= 2 tiet — thu theo thu tu:
    //    (a) keo mot tiet cua GV vao lo trong CUNG buoi (lop van kin nhu cu),
    //    (b) chuyen mot tiet le cua GV sang buoi khac ma GV da co mat
    //        (can cho ca o bi kep giua cac tiet CO DINH khong the xe dich).
    for(const cse of snap.gapCases){
      if(improved || Date.now() > deadline) break;
      await tkbQualityMaybeYield(slice);
      const parts = cse.key.split("|");
      const thu = parts[0], buoi = parts[1];
      const tis = [...new Set(cse.cells.map(c=>c.ti))].sort((a,b)=>a-b);
      const holeTis = [];
      for(let t = tis[0] + 1; t < tis[tis.length-1]; t++){ if(!tis.includes(t)) holeTis.push(t); }
      for(const cell of cse.cells){
        if(improved) break;
        for(const hole of holeTis){
          if(Date.now() > deadline) break;
          if(await tkbTryMoveCellWithFallback(cell.classId, {thu, buoi, ti: cell.ti}, {thu, buoi, ti: hole}, accepted, deadline, slice)){
            fixes.push(`gap2:${cse.code}:${cse.key}`);
            improved = true;
            break;
          }
        }
      }
      for(const cell of cse.cells){
        if(improved || Date.now() > deadline) break;
        if(await tkbTeacherTrySwapIntoOwnSession(cse.code, cell, snap.sessions, cse.key, accepted, deadline, slice)){
          fixes.push(`gap2out:${cse.code}:${cse.key}`);
          improved = true;
        }
      }
      // (c) keo mot tiet khac cua chinh GV tu buoi khac VE lap lo trong.
      if(!improved && Date.now() <= deadline
        && await tkbTeacherTryPullIntoSession(cse.code, cse.key, holeTis, snap.sessions, accepted, deadline, slice)){
        fixes.push(`gap2in:${cse.code}:${cse.key}`);
        improved = true;
      }
    }
    if(improved){
      // 22/08: xac nhan toan truong (chia lat); xau hon thi hoan tac va thu phan 2.
      if(await tkbVioConfirmMove(vio, gridBefore, false)) continue;
      fixes.pop();
      improved = false;
    }

    // 2) Buoi GV chi day 1 tiet: (a) chuyen tiet le sang buoi khac ma GV da
    //    co mat; (b) nguoc lai, keo mot tiet khac cua GV ve ghep sat tiet le.
    for(const cse of snap.onePeriodCases){
      if(improved || Date.now() > deadline) break;
      await tkbQualityMaybeYield(slice);
      const cell = cse.cells[0];
      if(await tkbTeacherTrySwapIntoOwnSession(cse.code, cell, snap.sessions, cse.key, accepted, deadline, slice)){
        fixes.push(`1tiet:${cse.code}:${cse.key}`);
        improved = true;
        break;
      }
      if(Date.now() <= deadline
        && await tkbTeacherTryPullIntoSession(cse.code, cse.key, [cell.ti - 1, cell.ti + 1], snap.sessions, accepted, deadline, slice)){
        fixes.push(`1tietin:${cse.code}:${cse.key}`);
        improved = true;
      }
    }
    if(improved && !(await tkbVioConfirmMove(vio, gridBefore, false))){
      fixes.pop();
      improved = false;
    }
    if(!improved) break;
  }
  return fixes;
}

/* 21/08: PASS SUA VI PHAM RANG BUOC CON SOT sau khi xep — vi du mon "chi hoc
   1 buoi/ngay" nhung bi xep ca sang lan chieu. Voi moi vi pham gan voi mot O
   cu the, thu don o do sang vi tri khac bang hoan doi 2 o / xoay 3 o; chi giu
   buoc doi khi TONG so vi pham GIAM (khong bao gio lam xau them). */
async function tkbAutoRepairConstraintViolations(options = {}){
  const deadline = Date.now() + Math.max(1000, Number(options.budgetMs) || 8000);
  const fixes = [];
  const slice = {lastYield: Date.now()};
  if(typeof TKBConstraints === "undefined") return fixes;
  let guard = 0;
  while(Date.now() <= deadline && guard++ < 30){
    // 22/08: quet toan truong bang ban chia lat (khong dong bang), sau do
    // kiem tra pham vi lop trong accepted(); xac nhan toan truong khi giu.
    let scan = [];
    try{ scan = await tkbVioScanAsync(); }catch(_){ break; }
    const items = scan.filter(v =>
      v && v.lopId && v.thu && v.buoi && v.ti != null
      && DATA?.tkb?.[v.lopId]?.[v.thu]?.[v.buoi]
    );
    if(!items.length) break;
    const vio = tkbVioStateFromItems(scan);
    const gridBefore = tkbGridSnapshot();
    const accepted = (classId)=> tkbVioScopedOk(vio, classId, true);
    let improved = false;
    for(const item of items){
      if(improved || Date.now() > deadline) break;
      await tkbQualityMaybeYield(slice);
      const classId = String(item.lopId);
      const src = {thu: item.thu, buoi: item.buoi, ti: Number(item.ti)};
      const grid = DATA?.tkb?.[classId];
      const dsts = [];
      DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
        (grid?.[thu]?.[buoi]||[]).forEach((v,i)=>{
          if(thu === src.thu && buoi === src.buoi && i === src.ti) return;
          if(!v || v === "OFF" || isFixed(v)) return;
          if(item.mon && monMatches(cellMon(v), item.mon)) return;
          dsts.push({thu, buoi, ti:i});
        });
      }));
      for(const dst of dsts){
        if(Date.now() > deadline) break;
        if(await tkbTryMoveCellWithFallback(classId, src, dst, accepted, deadline, slice)){
          fixes.push(`vi:${item.className || classId}|${item.mon || ""}|${src.thu}-${src.buoi}-t${src.ti + 1}`);
          improved = true;
          break;
        }
      }
    }
    if(improved && !(await tkbVioConfirmMove(vio, gridBefore, true))){
      fixes.pop();
      improved = false;
    }
    if(!improved) break;
  }
  return fixes;
}

/* 22/08: PASS "GHEP TIET LE" (yeu cau nguoi dung): sau khi xep, mon nao con
   cac tiet don le roi rac thi keo chung ve KE nhau thanh cum >= 2 tiet — uu
   tien ghep vao TIET CO DINH (o co dinh khong xe dich duoc nen tiet linh
   hoat phai tim den no). Moi buoc doi deu qua kiem tra rang buoc; chi giu
   khi: so tiet le GIAM, so loi rang buoc KHONG tang, va chat luong buoi day
   GV (buoi xau / lo trong) KHONG xau di. Mon co Gioi han tiet/buoi = 1 se
   tu bi validator chan nen khong bao gio ghep sai luat. */
function tkbLoneSingleCases(){
  const cases = [];
  Object.keys(DATA?.tkb || {}).forEach(cid => {
    const grid = DATA.tkb[cid];
    const bySubject = new Map();
    DAYS.forEach(thu=>["sang","chieu"].forEach(buoi=>{
      (grid?.[thu]?.[buoi]||[]).forEach((v,ti)=>{
        if(!v || v === "OFF") return;
        const mon = cellMon(v);
        if(!mon) return;
        const key = monCanonicalKey(mon);
        if(!bySubject.has(key)) bySubject.set(key, {mon, cells: []});
        bySubject.get(key).cells.push({thu, buoi, ti, fixed: isFixed(v)});
      });
    }));
    bySubject.forEach(info => {
      if(info.cells.length < 2) return;
      const has = (thu, buoi, ti) => info.cells.some(c => c.thu === thu && c.buoi === buoi && c.ti === ti);
      const lones = info.cells.filter(c => !has(c.thu, c.buoi, c.ti - 1) && !has(c.thu, c.buoi, c.ti + 1));
      if(lones.length < 2) return;
      cases.push({classId: String(cid), mon: info.mon, lones});
    });
  });
  return cases;
}

function tkbCountLoneSingles(){
  let total = 0;
  try{ tkbLoneSingleCases().forEach(c => { total += c.lones.length; }); }catch(_){ }
  return total;
}

async function tkbAutoRepairAestheticPairs(options = {}){
  const deadline = Date.now() + Math.max(1000, Number(options.budgetMs) || 8000);
  const fixes = [];
  const slice = {lastYield: Date.now()};
  if(typeof TKBConstraints === "undefined") return fixes;
  // 22/08: quet toan truong MOT lan (chia lat), sau do chi kiem tra pham vi lop.
  const vio = tkbVioStateFromItems(await tkbVioScanAsync());
  let guard = 0;
  while(Date.now() <= deadline && guard++ < 60){
    const cases = tkbLoneSingleCases();
    if(!cases.length) break;
    const gridBefore = tkbGridSnapshot();
    const baseQ = tkbTeacherQualitySnapshot();
    const baseLone = cases.reduce((sum, c) => sum + c.lones.length, 0);
    const accepted = (classId)=>{
      const q = tkbTeacherQualitySnapshot();
      if(q.bad > baseQ.bad || q.excess > baseQ.excess) return false;
      if(tkbCountLoneSingles() >= baseLone) return false;
      return tkbVioScopedOk(vio, classId, false);
    };
    // Uu tien 0: keo tiet linh hoat ve canh tiet CO DINH; uu tien 1: ghep
    // hai tiet linh hoat le voi nhau.
    const ordered = [];
    cases.forEach(c => {
      const fixedAnchors = c.lones.filter(l => l.fixed);
      const movables = c.lones.filter(l => !l.fixed);
      fixedAnchors.forEach(anchor => movables.forEach(src => ordered.push({c, anchor, src, pri: 0})));
      for(let i = 0; i < movables.length; i++){
        for(let j = 0; j < movables.length; j++){
          if(i !== j) ordered.push({c, anchor: movables[i], src: movables[j], pri: 1});
        }
      }
    });
    ordered.sort((a, b) => a.pri - b.pri);
    let improved = false;
    for(const item of ordered){
      if(improved || Date.now() > deadline) break;
      await tkbQualityMaybeYield(slice);
      const {c, anchor, src} = item;
      if(src.thu === anchor.thu && src.buoi === anchor.buoi) continue;
      const arr = DATA?.tkb?.[c.classId]?.[anchor.thu]?.[anchor.buoi] || [];
      for(const d of [-1, 1]){
        const ti = anchor.ti + d;
        if(ti < 0 || ti >= arr.length) continue;
        const dv = arr[ti];
        if(!dv || dv === "OFF" || isFixed(dv)) continue;
        if(monMatches(cellMon(dv), c.mon)) continue;
        if(await tkbTryMoveCellWithFallback(
          c.classId,
          {thu: src.thu, buoi: src.buoi, ti: src.ti},
          {thu: anchor.thu, buoi: anchor.buoi, ti},
          accepted,
          deadline,
          slice
        )){
          fixes.push(`pair:${c.classId}|${c.mon}${anchor.fixed ? "|codinh" : ""}`);
          improved = true;
          break;
        }
      }
    }
    if(improved && !(await tkbVioConfirmMove(vio, gridBefore, false))){
      fixes.pop();
      improved = false;
    }
    if(!improved) break;
  }
  return fixes;
}

try{
  window.__tkbAutoRepairAestheticPairs = async function(options){
    const fixes = await tkbAutoRepairAestheticPairs(options || {});
    if(fixes.length){
      try{ saveStore({force:true}); }catch(_){ }
      try{ renderCurrentView(); }catch(_){ }
    }
    return fixes;
  };
  window.__tkbCountLoneSingles = tkbCountLoneSingles;
}catch(_){ }

try{
  window.__tkbAutoRepairConstraintViolations = async function(options){
    const fixes = await tkbAutoRepairConstraintViolations(options || {});
    if(fixes.length){
      try{ saveStore({force:true}); }catch(_){ }
      try{ renderCurrentView(); }catch(_){ }
    }
    return fixes;
  };
}catch(_){ }

/* 22/08: PASS "CAN BANG TRONG 1 TIET" (yeu cau nguoi dung): thay vi de vai
   GV ganh 4-5 buoi trong 1 tiet trong khi nhieu GV khong dinh buoi nao, don
   bot cua nguoi nang nhat. Thuoc do la HO SO CONG BANG: day so trong-1 cua
   tung GV xep giam dan, so sanh theo thu tu tu dien — [5,5,4,...] xau hon
   [4,4,4,...]; mot phep doi duoc GIU khi ho so tot len (ke ca khi phai
   chuyen 1 buoi trong tu GV 5 sang GV 0), voi dieu kien: tong loi rang buoc
   khong tang va chat luong cung (buoi 1 tiet / trong >= 2) khong xau di. */
function tkbGap1FairnessProfile(snapshot){
  const per = new Map();
  (snapshot.gap1Cases || []).forEach(c => { per.set(c.code, (per.get(c.code) || 0) + 1); });
  return {per, sorted: [...per.values()].sort((a, b) => b - a)};
}

function tkbGap1ProfileBetter(now, base){
  const length = Math.max(now.length, base.length);
  for(let i = 0; i < length; i++){
    const x = now[i] || 0, y = base[i] || 0;
    if(x !== y) return x < y;
  }
  return false;
}

async function tkbAutoRepairGap1Balance(options = {}){
  const deadline = Date.now() + Math.max(1000, Number(options.budgetMs) || 8000);
  const fixes = [];
  const slice = {lastYield: Date.now()};
  if(typeof TKBConstraints === "undefined") return fixes;
  // 22/08: quet toan truong MOT lan (chia lat), sau do chi kiem tra pham vi lop.
  const vio = tkbVioStateFromItems(await tkbVioScanAsync());
  let guard = 0;
  while(Date.now() <= deadline && guard++ < 60){
    const snap = tkbTeacherQualitySnapshot();
    const fair = tkbGap1FairnessProfile(snap);
    if(!fair.sorted.length || fair.sorted[0] <= 1) break;   // khong con GV nao > 1: da can bang
    const gridBefore = tkbGridSnapshot();
    const accepted = (classId)=>{
      const q = tkbTeacherQualitySnapshot();
      if(q.bad > snap.bad || q.excess > snap.excess) return false;
      if(!tkbGap1ProfileBetter(tkbGap1FairnessProfile(q).sorted, fair.sorted)) return false;
      return tkbVioScopedOk(vio, classId, false);
    };
    // Xu ly GV nang nhat truoc.
    const cases = (snap.gap1Cases || [])
      .slice()
      .sort((a, b) => (fair.per.get(b.code) || 0) - (fair.per.get(a.code) || 0))
      .filter(c => (fair.per.get(c.code) || 0) > 1);
    let improved = false;
    for(const cse of cases){
      if(improved || Date.now() > deadline) break;
      await tkbQualityMaybeYield(slice);
      const parts = cse.key.split("|");
      const thu = parts[0], buoi = parts[1];
      const tis = [...new Set(cse.cells.map(c=>c.ti))].sort((a,b)=>a-b);
      const holeTis = [];
      for(let t = tis[0] + 1; t < tis[tis.length-1]; t++){ if(!tis.includes(t)) holeTis.push(t); }
      // (a) lap lo trong cung buoi
      for(const cell of cse.cells){
        if(improved) break;
        for(const hole of holeTis){
          if(Date.now() > deadline) break;
          if(await tkbTryMoveCellWithFallback(cell.classId, {thu, buoi, ti: cell.ti}, {thu, buoi, ti: hole}, accepted, deadline, slice)){
            fixes.push(`bal:${cse.code}:${cse.key}`);
            improved = true;
            break;
          }
        }
      }
      // (b) chuyen mot tiet cua GV sang buoi khac ma GV da co mat
      for(const cell of cse.cells){
        if(improved || Date.now() > deadline) break;
        if(await tkbTeacherTrySwapIntoOwnSession(cse.code, cell, snap.sessions, cse.key, accepted, deadline, slice)){
          fixes.push(`balout:${cse.code}:${cse.key}`);
          improved = true;
        }
      }
      // (c) keo mot tiet khac cua GV ve lap lo trong
      if(!improved && Date.now() <= deadline
        && await tkbTeacherTryPullIntoSession(cse.code, cse.key, holeTis, snap.sessions, accepted, deadline, slice)){
        fixes.push(`balin:${cse.code}:${cse.key}`);
        improved = true;
      }
    }
    if(improved && !(await tkbVioConfirmMove(vio, gridBefore, false))){
      fixes.pop();
      improved = false;
    }
    if(!improved) break;
  }
  return fixes;
}

/* 22/08: BANG "KIEM TRA RANG BUOC" (nut RB canh nut Loi, chi superadmin):
   liet ke TUNG rang buoc da khai bao trong Yeu cau mon hoc va do trang thai
   THUC TE tren luoi hien tai — de kiem chung rang buoc co duoc thuc thi
   khong (vi du tiet doi theo tung mon). */
/* 24/08: "Yeu cau mon hoc" van giu byClass cua nhung lop DA XOA (truong
   v2mjxf2tbt1 rut tu 31 xuong 21 lop nhung con L022..L031). Cac muc do khong
   con lop nao doi ung: tkbAutoRepairLessonBlockPairShortfall khong tim thay
   luoi nen tra ve dung `min` => bang RB bao "281 luat, 50 chua dat" trong khi
   trinh kiem tra tong bao 0 vi pham. Chi do luat cua lop CON TON TAI; so muc
   rac duoc bao rieng de chu du an tu don, khong am tham nuot. */
function tkbConstraintAuditClassLive(cid){
  const id = String(cid == null ? "" : cid).trim();
  if(!id) return false;
  if(DATA?.tkb?.[id]) return true;
  const list = DATA?.lop || [];
  if(!list.length) return true;   // danh muc lop chua nap: khong loc gi ca
  return list.some(l => [l?.id, l?.ten, l?.ten2, l?.ma]
    .some(v => String(v == null ? "" : v).trim() === id));
}

function tkbConstraintAuditStaleSummary(){
  const classes = [];
  const seen = new Set();
  let rules = 0;
  const subj = DATA?.tkbConstraints?.subject || {};
  for(const key of Object.keys(subj)){
    const byClass = subj[key]?.byClass || {};
    for(const cid of Object.keys(byClass)){
      if(tkbConstraintAuditClassLive(cid)) continue;
      if(!seen.has(cid)){ seen.add(cid); classes.push(cid); }
      const rule = byClass[cid] || {};
      if(Number(rule?.lessonBlocks?.[2]?.min || 0) > 0) rules++;
      if(rule?.sessionAllowed?.oneSessionPerDay === true) rules++;
    }
  }
  return {classes, rules};
}

function tkbConstraintAuditRows(){
  const rows = [];
  const subj = DATA?.tkbConstraints?.subject || {};
  for(const key of Object.keys(subj)){
    const byClass = subj[key]?.byClass || {};
    for(const cid of Object.keys(byClass)){
      if(!tkbConstraintAuditClassLive(cid)) continue;
      const rule = byClass[cid] || {};
      const canon = getLopCanonById(cid);
      const minPairs = Number(rule?.lessonBlocks?.[2]?.min || 0);
      if(minPairs > 0){
        // 25/08: mon it tiet hon 2*min (vd Tin 1 tiet/tuan, quick-fill min=1)
        // -> yeu cau bat kha thi, bao "bo qua" thay vi "thieu cum".
        // 27/08: lop khong hoc mon do (Phan cong khong co) cung la "bo qua",
        // nhung ghi ly do khac de chu du an biet la luat thua trong du lieu.
        const unassigned = tkbClassSubjectUnassigned(cid, key);
        const periods = unassigned ? 0 : tkbLessonBlockPeriodsForClassMon(cid, key);
        if(unassigned || (periods > 0 && minPairs > Math.floor(periods / 2))){
          rows.push({
            lop: canon, mon: key,
            rb: "Tiết đôi ≥ " + minPairs,
            ok: true,
            skipped: true,
            note: unassigned
              ? "bỏ qua: lớp không học môn này (Phân công không có)"
              : "bỏ qua: chỉ " + periods + " tiết/tuần, không thể xếp " + minPairs + " cụm đôi"
          });
        }else{
          let shortfall = 0;
          try{ shortfall = Math.max(0, Number(tkbAutoRepairLessonBlockPairShortfall({classId: cid, mon: key}) || 0)); }catch(_){ }
          rows.push({
            lop: canon, mon: key,
            rb: "Tiết đôi ≥ " + minPairs,
            ok: shortfall <= 0,
            note: shortfall > 0 ? ("thiếu " + shortfall + " cụm") : "đủ"
          });
        }
      }
      if(rule?.sessionAllowed?.oneSessionPerDay === true){
        let badDays = 0;
        const grid = DATA?.tkb?.[cid];
        DAYS.forEach(thu => {
          const hasIn = buoi => (grid?.[thu]?.[buoi] || []).some(v => v && v !== "OFF" && monMatches(cellMon(v), key));
          if(hasIn("sang") && hasIn("chieu")) badDays++;
        });
        rows.push({
          lop: canon, mon: key,
          rb: "1 buổi/ngày",
          ok: badDays === 0,
          note: badDays > 0 ? (badDays + " ngày vi phạm") : "đạt"
        });
      }
    }
  }
  return rows;
}

try{
  window.__tkbToggleConstraintAudit = function(){
    try{
      const existing = document.getElementById("tkbConstraintAuditPanel");
      if(existing){ existing.remove(); return; }
      let rows = [];
      try{ rows = tkbConstraintAuditRows(); }catch(_){ }
      let vio = [];
      try{ vio = (TKBConstraints.validateAll(500) || []).map(v => String(v.message || "")); }catch(_){ }
      let stale = {classes: [], rules: 0};
      try{ stale = tkbConstraintAuditStaleSummary() || stale; }catch(_){ }
      const bad = rows.filter(r => !r.ok);
      const skipped = rows.filter(r => r.skipped);
      const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const rowHtml = r => "<tr>"
        + `<td style="padding:2px 10px 2px 0">${esc(r.lop)}</td>`
        + `<td style="padding:2px 10px 2px 0">${esc(r.mon)}</td>`
        + `<td style="padding:2px 10px 2px 0">${esc(r.rb)}</td>`
        + `<td style="padding:2px 0;color:${r.ok ? "#0a7" : "#c00"};font-weight:600">${r.ok ? "✓" : "✗"} ${esc(r.note)}</td>`
        + "</tr>";
      const listRows = bad.length ? bad : rows.slice(0, 200);
      const panel = document.createElement("div");
      panel.id = "tkbConstraintAuditPanel";
      panel.style.cssText = "position:fixed;top:64px;right:16px;z-index:99999;width:min(640px,94vw);"
        + "max-height:72vh;overflow:auto;background:#fff;border:1px solid #2a7;border-radius:10px;"
        + "box-shadow:0 8px 30px rgba(0,0,0,.25);padding:12px 14px;font-size:13px;line-height:1.45;";
      panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">`
        + `<b>Kiểm tra ràng buộc — ${rows.length} luật, <span style="color:${bad.length ? "#c00" : "#0a7"}">${bad.length} chưa đạt</span></b>`
        + `<button type="button" onclick="document.getElementById('tkbConstraintAuditPanel').remove()">Đóng</button></div>`
        + `<div style="color:${vio.length ? "#c00" : "#0a7"};margin-bottom:8px">Trình kiểm tra tổng: `
        + (vio.length ? `${vio.length} vi phạm` : "0 vi phạm — mọi ràng buộc đang được thực thi ✓") + "</div>"
        + (stale.rules
          ? `<div style="color:#a60;margin-bottom:8px">Đã bỏ qua ${stale.rules} luật của ${stale.classes.length} lớp đã xóa `
            + `(${esc(stale.classes.slice(0, 12).join(", "))}${stale.classes.length > 12 ? "…" : ""}) — nên xóa trong Yêu cầu môn học.</div>`
          : "")
        + (skipped.length
          ? `<div style="color:#a60;margin-bottom:8px">Đã bỏ qua ${skipped.length} luật tiết đôi bất khả thi `
            + `(lớp không học môn đó, hoặc môn ít tiết hơn 1 cụm) — có thể xóa trong Yêu cầu môn học.</div>`
          : "")
        + (bad.length
          ? `<div style="color:#c00;margin-bottom:4px"><b>Các luật chưa đạt:</b></div>`
          : `<div style="color:#666;margin-bottom:4px">Tất cả đạt — liệt kê${rows.length > 200 ? " 200/" + rows.length : ""} luật:</div>`)
        + `<table style="border-collapse:collapse">${listRows.map(rowHtml).join("")}</table>`
        + (vio.length ? `<div style="margin-top:8px"><b>Vi phạm chi tiết:</b><br>${vio.slice(0, 20).map(esc).join("<br>")}</div>` : "");
      document.body.appendChild(panel);
    }catch(_){ }
  };
}catch(_){ }

try{
  window.__tkbAutoRepairGap1Balance = async function(options){
    const fixes = await tkbAutoRepairGap1Balance(options || {});
    if(fixes.length){
      try{ saveStore({force:true}); }catch(_){ }
      try{ renderCurrentView(); }catch(_){ }
    }
    return fixes;
  };
}catch(_){ }

try{
  window.__tkbEnsureLessonPairs = async function(options){
    const fixes = await tkbAutoRepairEnsureLessonPairs(options || {});
    if(fixes.length){
      try{ saveStore({force:true}); }catch(_){ }
      try{ renderCurrentView(); }catch(_){ }
    }
    return fixes;
  };
  window.__tkbAutoRepairTeacherQuality = async function(options){
    const fixes = await tkbAutoRepairTeacherQuality(options || {});
    if(fixes.length){
      try{ saveStore({force:true}); }catch(_){ }
      try{ renderCurrentView(); }catch(_){ }
    }
    return fixes;
  };
  window.__tkbTeacherQualitySnapshot = tkbTeacherQualitySnapshot;
}catch(_){ }

// Hybrid is an executor boundary, not a hint that an old timetable is a
// successful Cloud Run result.  Keep this contract local to the UI so legacy
// bridge payloads are normalized before they are ever allowed to redraw DATA.
function cloneHybridScheduleState(data){
  const clone = value => JSON.parse(JSON.stringify(value == null ? {} : value));
  return {
    tkb: clone(data?.tkb),
    tkbLessonTeachers: clone(data?.tkbLessonTeachers),
    tkbLessonRooms: clone(data?.tkbLessonRooms),
    tkbSolverResult: clone(data?.tkbSolverResult),
    tkbRustSolverResult: clone(data?.tkbRustSolverResult)
  };
}

function restoreHybridScheduleState(data, snapshot){
  if(!data || !snapshot) return;
  data.tkb = snapshot.tkb || {};
  data.tkbLessonTeachers = snapshot.tkbLessonTeachers || {};
  data.tkbLessonRooms = snapshot.tkbLessonRooms || {};
  if(snapshot.tkbSolverResult) data.tkbSolverResult = snapshot.tkbSolverResult;
  else delete data.tkbSolverResult;
  if(snapshot.tkbRustSolverResult) data.tkbRustSolverResult = snapshot.tkbRustSolverResult;
  else delete data.tkbRustSolverResult;
}

function hybridCandidateTkbFromResponse(response){
  const candidates = [
    response?.candidateTkb,
    response?.candidate?.tkb,
    response?.candidate?.timetable,
    response?.payload?.tkb,
    response?.tkb
  ];
  for(const candidate of candidates){
    if(candidate && typeof candidate === "object" && !Array.isArray(candidate)){
      return candidate;
    }
  }
  return null;
}

function hybridStableJson(value){
  try{
    const normalize = item => {
      if(item == null || typeof item !== "object") return item;
      if(Array.isArray(item)) return item.map(normalize);
      const out = {};
      Object.keys(item).sort().forEach(key => { out[key] = normalize(item[key]); });
      return out;
    };
    return JSON.stringify(normalize(value));
  }catch(_){
    return "";
  }
}

// Cloud Run metrics alone are not enough to safely replace the visible
// timetable: a malformed/empty candidate would otherwise erase DATA.tkb even
// when a stale metrics object claims the run is complete.  Count actual
// lesson cells in the candidate grid before accepting it.  This deliberately
// accepts both the legacy string cells and the current {mon, fixed} cells.
function hybridCandidateScheduledCellCount(value, seen){
  if(value == null) return 0;
  if(typeof value === "string"){
    const subject = value.trim();
    return subject && subject.toUpperCase() !== "OFF" ? 1 : 0;
  }
  if(typeof value !== "object") return 0;
  const visited = seen || new WeakSet();
  if(visited.has(value)) return 0;
  visited.add(value);
  if(!Array.isArray(value)){
    const subject = value.mon ?? value.subject ?? value.ten ?? value.name ?? "";
    if(String(subject || "").trim()){
      return String(subject).trim().toUpperCase() === "OFF" ? 0 : 1;
    }
  }
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.reduce((count, item) => count + hybridCandidateScheduledCellCount(item, visited), 0);
}

function hybridNonnegativeMetric(value){
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function hybridMetricSnapshot(metrics){
  const source = metrics && typeof metrics === "object" ? metrics : {};
  const distribution = source.gap_distribution && typeof source.gap_distribution === "object"
    ? source.gap_distribution
    : {};
  const firstMetric = (...values) => {
    for(const value of values){
      const number = hybridNonnegativeMetric(value);
      if(number != null) return number;
    }
    return null;
  };
  const gap2FromDistribution = (() => {
    let total = 0;
    let seen = false;
    for(const [gap, count] of Object.entries(distribution)){
      const gapNumber = hybridNonnegativeMetric(gap);
      const countNumber = hybridNonnegativeMetric(count);
      if(gapNumber == null || countNumber == null) return null;
      if(gapNumber >= 2){
        total += countNumber;
        seen = true;
      }
    }
    return seen || Object.keys(distribution).length ? total : null;
  })();
  return {
    singletons:firstMetric(source.soBuoiDay1, source.one_period_teacher_sessions),
    sessions:firstMetric(source.tsBuoiDay, source.teacher_sessions),
    gap1:firstMetric(source.soBuoiTrong1, source.teacher_gap1_sessions, distribution["1"]),
    gap2:firstMetric(source.soBuoiTrong2, source.teacher_gap2_sessions, gap2FromDistribution)
  };
}

function hybridCanonicalOptimizeMode(value){
  const mode = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "optimize_singletons",
    "optimize_sessions",
    "optimize_gap2",
    "optimize_gap1"
  ].includes(mode) ? mode : "";
}

// A Cloud result must improve the action the user actually clicked, while
// retaining the objective guards for that action.  Do this at the UI executor
// boundary as well as in the solver so a stale/misrouted response can never
// replace a valid incumbent merely because its grid differs.
function hybridParetoAcceptance(modeValue, incumbentMetrics, candidateMetrics){
  const mode = hybridCanonicalOptimizeMode(modeValue);
  if(!mode) return { ok:true, enforced:false };
  const before = hybridMetricSnapshot(incumbentMetrics);
  const after = hybridMetricSnapshot(candidateMetrics);
  const required = mode === "optimize_singletons"
    ? ["singletons", "sessions", "gap1", "gap2"]
    : (mode === "optimize_sessions"
      ? ["singletons", "sessions", "gap1", "gap2"]
      : (mode === "optimize_gap2"
        ? ["singletons", "gap2"]
        : ["singletons", "gap1", "gap2"]));
  if(required.some(key => before[key] == null || after[key] == null)){
    return {
      ok:false,
      failureKind:"cloud_run_pareto_metrics_missing",
      error:"Cloud Run thiếu chỉ số chất lượng cần thiết để chứng thực nghiệm tốt hơn lịch hiện tại."
    };
  }

  let better = false;
  let preserved = true;
  if(mode === "optimize_singletons"){
    better = after.singletons < before.singletons;
    preserved = after.sessions <= before.sessions
      && after.gap2 <= before.gap2
      && after.gap1 <= before.gap1;
  }else if(mode === "optimize_sessions"){
    better = after.sessions < before.sessions;
    preserved = after.singletons <= before.singletons
      && after.gap2 <= before.gap2
      && after.gap1 <= before.gap1;
  }else if(mode === "optimize_gap2"){
    better = after.gap2 < before.gap2;
    // A gap-2 ejection is allowed to use a temporary/opened session, but it
    // must never create an extra singleton as its price.
    preserved = after.singletons <= before.singletons;
  }else{
    better = after.gap1 < before.gap1;
    preserved = after.singletons <= before.singletons
      && after.gap2 <= before.gap2;
  }
  return {
    ok:better && preserved,
    enforced:true,
    before,
    after,
    failureKind:"cloud_run_no_pareto_improvement",
    error:"Cloud Run không đưa ra lịch Pareto tốt hơn cho mục tiêu đang chọn."
  };
}

function normalizeHybridCloudRunResult(response, data, incumbentFingerprint = ""){
  const payload = response?.candidate && typeof response.candidate === "object"
    ? response.candidate
    : (response?.payload && typeof response.payload === "object" ? response.payload : response);
  const metrics = payload?.metrics && typeof payload.metrics === "object" ? payload.metrics : {};
  const validation = payload?.validation && typeof payload.validation === "object" ? payload.validation : {};
  const expected = Number(metrics.expected_periods || 0);
  const scheduled = Number(metrics.scheduled_periods || 0);
  const unassigned = Number(metrics.unassigned_periods || 0);
  const explicitOk = response?.ok === true || payload?.ok === true;
  // A response without an explicit candidate is never successful. In
  // particular, the incumbent in `data.tkb` must not be used as evidence that
  // Cloud Run produced a new schedule.
  const candidate = hybridCandidateTkbFromResponse(response);
  const candidateScheduled = candidate ? hybridCandidateScheduledCellCount(candidate) : 0;
  const hardValid = explicitOk
    && metrics.hard_ok === true
    && metrics.core_hard_ok !== false
    && validation.hard_ok === true
    && expected > 0
    && scheduled >= expected
    && unassigned === 0
    && Array.isArray(payload?.lessons)
    && payload.lessons.length >= expected
    && candidateScheduled >= expected;

  if(hardValid && candidate){
    let changed = true;
    try{
      const candidateFingerprint = hybridStableJson(candidate);
      changed = !incumbentFingerprint || candidateFingerprint !== incumbentFingerprint;
    }catch(_){}
    if(!changed){
      return {
        ok: true,
        applied: false,
        executor: "cloud_run",
        tkb: candidate,
        candidate: payload,
        candidateSource: response?.candidateTkb ? "bridge_candidate_tkb" : "response_tkb",
        failureKind:"cloud_run_no_pareto_improvement"
      };
    }
    const pareto = hybridParetoAcceptance(
      response?.hybridMode,
      response?.hybridIncumbentMetrics,
      metrics
    );
    if(pareto.ok !== true){
      if(pareto.failureKind === "cloud_run_no_pareto_improvement"){
        return {
          ok:true,
          applied:false,
          executor:"cloud_run",
          tkb:candidate,
          candidate:payload,
          candidateSource:response?.candidateTkb ? "bridge_candidate_tkb" : "response_tkb",
          failureKind:pareto.failureKind,
          error:pareto.error,
          pareto
        };
      }
      return {
        ok:false,
        applied:false,
        executor:"cloud_run",
        error:pareto.error,
        failureKind:pareto.failureKind,
        candidate:payload,
        pareto
      };
    }
    return {
      ok: true,
      applied: true,
      executor: "cloud_run",
      tkb: candidate,
      candidate: payload,
      candidateSource: response?.candidateTkb ? "bridge_candidate_tkb" : "response_tkb",
      failureKind:"",
      pareto
    };
  }
  return {
    ok: false,
    applied: false,
    executor: "cloud_run",
    error: String(payload?.error || payload?.message || "Cloud Run không trả về lịch hoàn chỉnh, hợp lệ."),
    failureKind: String(payload?.failureKind || payload?.kind || "cloud_run_candidate_rejected"),
    candidate: payload || null
  };
}

async function offerHybridFailureChoice(options, failure){
  const failureKind = String(failure?.failureKind || "").trim().toLowerCase();
  const profileUnavailable = /serverless_profile_unavailable|cloud_run_route_unavailable|cloud_run_executor_unavailable|cloud.*profile.*unavailable/.test(failureKind);
  const detail = profileUnavailable
    ? "Cloud Run chưa được cấu hình hoặc không sẵn sàng trong môi trường này. Hybrid Cloud Run chỉ chạy khi profile Serverless của staging/production sẵn sàng."
    : String(failure?.error || "Cloud Run không trả về nghiệm hợp lệ.");

  // A numeric prompt defaulted to Cancel and made a recoverable Hybrid
  // failure look like a broken optimizer. This explicit in-page decision is
  // deliberately not an automatic fallback: the user chooses the executor.
  if(typeof document === "undefined" || !document.body || typeof document.createElement !== "function"){
    return Object.assign({}, failure, { cancelled:true, failureKind:failure?.failureKind || "cloud_run_failed" });
  }

  try{ document.getElementById("hybridFailureChoice")?.remove(); }catch(_){}
  return await new Promise(resolve => {
    const panel = document.createElement("section");
    panel.id = "hybridFailureChoice";
    panel.className = "hybrid-failure-choice";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "hybridFailureChoiceTitle");

    const title = document.createElement("h3");
    title.id = "hybridFailureChoiceTitle";
    title.textContent = "Cloud Run thất bại — lịch chưa thay đổi";
    const message = document.createElement("p");
    message.textContent = detail;
    const explanation = document.createElement("p");
    explanation.className = "hybrid-failure-choice-note";
    explanation.textContent = "Bạn có thể thử lại Cloud Run, hoặc chủ động chạy tối ưu trên máy này. Không có fallback ngầm.";
    const actions = document.createElement("div");
    actions.className = "hybrid-failure-choice-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary";
    retry.textContent = "Thử lại Cloud Run";
    const local = document.createElement("button");
    local.type = "button";
    local.textContent = "Chạy trên máy này";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "secondary";
    keep.textContent = "Giữ nguyên lịch";
    actions.append(retry, local, keep);
    panel.append(title, message, explanation, actions);
    document.body.appendChild(panel);

    const choose = (choice) => {
      try{ panel.remove(); }catch(_){}
      if(choice === "retry"){
        resolve(executeDirectFastSchedule(Object.assign({}, options, {
          hybridRetry:true,
          forceLocalFet:false
        })));
        return;
      }
      if(choice === "local"){
        resolve(executeDirectFastSchedule(Object.assign({}, options, {
          forceLocalFet:true,
          fallbackFromCloudRun:true
        })));
        return;
      }
      resolve(Object.assign({}, failure, { cancelled:true }));
    };
    retry.addEventListener("click", () => choose("retry"));
    local.addEventListener("click", () => choose("local"));
    keep.addEventListener("click", () => choose("keep"));
    try{ keep.focus(); }catch(_){}
  });
}

function clearFetDiagnosticPanel(){
  try{ document.getElementById("fetScheduleDiagnostics")?.remove(); }catch(_){}
}

function renderFetDiagnosticPanel(diagnostics){
  if(!diagnostics || diagnostics.origin === "candidate_validation" || typeof document === "undefined") return;
  clearFetDiagnosticPanel();
  const host = document.getElementById("statusMsg")?.parentElement || document.body;
  if(!host || typeof document.createElement !== "function") return;
  const items = [
    ...(Array.isArray(diagnostics.zeroDomainActivities) ? diagnostics.zeroDomainActivities : []),
    ...(Array.isArray(diagnostics.blockedActivities) ? diagnostics.blockedActivities : [])
  ].slice(0, 12);
  if(!items.length && !(diagnostics.capacityShortages || []).length) return;

  const panel = document.createElement("details");
  panel.id = "fetScheduleDiagnostics";
  panel.className = "fet-schedule-diagnostics";
  panel.open = true;
  const summary = document.createElement("summary");
  const isCandidateValidation = diagnostics.origin === "candidate_validation";
  summary.textContent = isCandidateValidation
    ? "Lịch mới chưa vượt qua kiểm tra ràng buộc — xem chi tiết"
    : "Không tìm được lịch hoàn chỉnh — xem chẩn đoán ràng buộc";
  panel.appendChild(summary);
  const intro = document.createElement("p");
  if(isCandidateValidation){
    const introduced = Number(diagnostics.introducedViolationCount || 0) || 0;
    intro.textContent = introduced > 0
      ? `Lịch mới tạo thêm ${introduced} vi phạm so với lịch trước khi tối ưu. Lịch cũ được giữ nguyên.`
      : `Lịch mới chưa vượt qua kiểm tra ràng buộc. Lịch cũ được giữ nguyên.`;
  }else{
    intro.textContent = `Preflight: ${diagnostics.activityCount || 0} hoạt động, ${diagnostics.blockedSlotCount || 0} slot bị khóa. Lịch cũ được giữ nguyên.`;
  }
  panel.appendChild(intro);
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  (isCandidateValidation
    ? ["Hoạt động", "Trạng thái", "Ràng buộc vi phạm"]
    : ["Hoạt động", "Số slot hợp lệ", "Nhóm ràng buộc"]
  ).forEach(text => {
    const cell = document.createElement("th");
    cell.textContent = text;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  items.forEach(item => {
    const row = document.createElement("tr");
    [
      `${item.subject || "?"}${item.teacher ? ` — ${item.teacher}` : ""}`,
      isCandidateValidation ? "Cần giữ nguyên ràng buộc" : String(item.allowedSlots ?? 0),
      item.constraintCategory || "hard_domain"
    ].forEach(text => {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  (diagnostics.capacityShortages || []).slice(0, 12).forEach(item => {
    const row = document.createElement("tr");
    [`Lớp ${item.classId || "?"}`, `${item.availableSlots || 0}/${item.requiredPeriods || 0}`, "capacity_shortage"].forEach(text => {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  table.appendChild(body);
  panel.appendChild(table);
  host.appendChild(panel);
}

// A positive FET floor is deliberately narrower than a heuristic plateau: it
// is emitted only when fixed cells, OFF slots and compiled domains prove that
// the selected metric cannot go lower.  Keep the message tied to the selected
// mode so a floor for (for example) teacher sessions is never presented as a
// proof about Gap2.
function fetTargetMetricKeyForMode(mode){
  const normalized = String(mode || "").trim().toLowerCase();
  if(normalized === "optimize_singletons") return "soBuoiDay1";
  if(normalized === "optimize_sessions") return "tsBuoiDay";
  if(normalized === "optimize_gap2") return "soBuoiTrong2";
  if(normalized === "optimize_gap1") return "soBuoiTrong1";
  return "";
}

function fetProvenMetricFloorMessage(mode, metrics, diagnostics){
  const key = fetTargetMetricKeyForMode(mode);
  if(!key) return "";
  const value = Number(metrics?.[key]);
  const floor = Number(diagnostics?.structuralFloor?.metricLowerBounds?.[key]);
  if(!Number.isFinite(value) || !Number.isFinite(floor) || floor <= 0) return "";
  // Never use a lower-bound metadata error to claim success.  Equality is
  // the only case in which the current schedule has actually reached it.
  if(Math.round(value) !== Math.round(floor)) return "";
  return `Tối thiểu đã chứng minh: ${Math.round(floor)}.`;
}

function fetHardViolationSignature(item){
  const kind = String(item?.kind || item?.type || "ui_hard_validation").trim() || "ui_hard_validation";
  const lopId = String(item?.lopId || item?.classId || "").trim();
  const mon = String(item?.mon || item?.subject || "").trim();
  const teacherId = String(item?.teacherId || item?.gv || item?.teacher || "").trim();
  // Aggregate / rule-based violations are keyed by rule identity rather than exact slot coordinates
  return [kind, lopId, mon, teacherId].join("|");
}

function compareFetCandidateViolationsToIncumbent(candidateRows, incumbentBaseline){
  const baselineRows = Array.isArray(incumbentBaseline?.violations)
    ? incumbentBaseline.violations
    : null;
  const candList = Array.isArray(candidateRows) ? candidateRows : [];
  if(!baselineRows) return { ok: candList.length === 0, addedRows: candList, incumbentCount: 0, retainedCount: candList.length };

  // If candidate schedule has <= violations than incumbent, it does not worsen the schedule
  if(candList.length <= baselineRows.length){
    return {
      ok: true,
      addedRows: [],
      retainedCount: candList.length,
      incumbentCount: baselineRows.length
    };
  }

  const available = new Map();
  baselineRows.forEach(item => {
    const key = fetHardViolationSignature(item);
    available.set(key, (available.get(key) || 0) + 1);
  });

  const addedRows = [];
  candList.forEach(item => {
    const key = fetHardViolationSignature(item);
    const remaining = available.get(key) || 0;
    if(remaining > 0){
      available.set(key, remaining - 1);
    }else{
      addedRows.push(item);
    }
  });
  return {
    ok: addedRows.length === 0 || candList.length <= baselineRows.length,
    addedRows,
    retainedCount: candList.length,
    incumbentCount: baselineRows.length
  };
}

function fetValidatorDiagnostics(rows, options = {}){
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    origin:"candidate_validation",
    candidateViolationCount:safeRows.length,
    incumbentViolationCount:Number(options.incumbentViolationCount || 0) || 0,
    introducedViolationCount:Number(options.introducedViolationCount || 0) || 0,
    blockedActivities:safeRows.slice(0, 12).map(item => ({
      subject:String(item?.mon || item?.subject || "?").slice(0, 120),
      teacher:String(item?.gv || item?.teacher || "").slice(0, 120),
      allowedSlots:null,
      constraintCategory:String(item?.kind || item?.type || "ui_hard_validation").slice(0, 120)
    }))
  };
}

async function inspectFetCandidateHardConstraints(data, candidateTkb){
  const api = window.TKBConstraints || window.TKBConstraintsFull;
  const validateAsync = api?.validateAllAsync;
  const validateSync = api?.validateAll;
  if(!api || (typeof validateAsync !== "function" && typeof validateSync !== "function")){
    return {
      available:false,
      failureKind:"fet_validator_unavailable",
      error:"Không có validator ràng buộc đầy đủ để chứng thực nghiệm."
    };
  }
  const snapshot = cloneHybridScheduleState(data);
  try{
    data.tkb = candidateTkb;
    if(typeof api.invalidateConstraintCache === "function") api.invalidateConstraintCache();
    const violations = typeof validateAsync === "function"
      ? await validateAsync.call(api, 3000, {sliceBudgetMs:8, ignoreStop:true})
      : validateSync.call(api, 3000);
    const rows = Array.isArray(violations) ? violations : [];
    return {available:true, violations:rows};
  }catch(err){
    return {
      available:false,
      failureKind:"fet_candidate_validation_error",
      error:String(err?.message || err || "Validator ràng buộc thất bại.")
    };
  }finally{
    restoreHybridScheduleState(data, snapshot);
    if(typeof api.invalidateConstraintCache === "function") api.invalidateConstraintCache();
  }
}

async function validateFetCandidateHardConstraints(data, candidateTkb, options = {}){
  const inspection = await inspectFetCandidateHardConstraints(data, candidateTkb);
  if(inspection.available !== true){
    return {
      ok:false,
      failureKind:inspection.failureKind || "fet_candidate_validation_error",
      error:inspection.error || "Không thể kiểm tra ràng buộc của nghiệm."
    };
  }

  const rows = inspection.violations || [];
  if(!rows.length) return {ok:true, applied:true, executor:"fet_worker", hardValid:true};

  // Optimisation can start from a legacy timetable created before a constraint
  // was enabled.  A checkpoint may retain those exact old violations, but it
  // must never add or worsen one.  First-sort and all callers without this
  // explicit baseline remain strictly zero-violation.
  if(options.allowUnchangedIncumbentViolations === true){
    const comparison = compareFetCandidateViolationsToIncumbent(rows, options.incumbentBaseline);
    if(comparison.ok === true){
      return {
        ok:true,
        applied:true,
        executor:"fet_worker",
        hardValid:false,
        retainedLegacyViolations:comparison.retainedCount,
        incumbentViolationCount:comparison.incumbentCount,
        diagnostics:fetValidatorDiagnostics(rows, {
          incumbentViolationCount:comparison.incumbentCount,
          introducedViolationCount:0
        })
      };
    }
    const diagnosticRows = comparison.addedRows?.length ? comparison.addedRows : rows;
    return {
      ok:false,
      failureKind:"fet_candidate_hard_validation_failed",
      error:`Nghiệm tạo thêm ${diagnosticRows.length} vi phạm ràng buộc so với lịch trước khi tối ưu.`,
      diagnostics:fetValidatorDiagnostics(diagnosticRows, {
        incumbentViolationCount:comparison.incumbentCount,
        introducedViolationCount:diagnosticRows.length
      })
    };
  }

  return {
    ok:false,
    failureKind:"fet_candidate_hard_validation_failed",
    error:`Nghiệm còn ${rows.length} vi phạm ràng buộc cứng.`,
    diagnostics:fetValidatorDiagnostics(rows, {introducedViolationCount:rows.length})
  };
}

function nextPlannerPaint(){
  // 21/08: tab an thi rAF KHONG BAO GIO chay -> promise nay treo vinh vien
  // den khi quay lai tab (dung la trieu chung "xem ket qua no moi tra").
  if(typeof document !== "undefined" && document.hidden){
    return typeof window.__tkbBgSleep === "function"
      ? window.__tkbBgSleep(0)
      : Promise.resolve();
  }
  return new Promise(resolve => {
    try{
      if(typeof requestAnimationFrame === "function"){
        requestAnimationFrame(() => resolve());
        return;
      }
    }catch(_){ }
    setTimeout(resolve, 0);
  });
}

// Apply only after validation.  Paint the actual timetable before the larger
// persistence/list/stat scans so a completed FET solve is visible immediately;
// those secondary refreshes are intentionally moved out of the critical path.
// 19/08: CHOT CHAN CUOI CUNG TRUOC KHI AP LICH.
// Bo giai co luoi rieng cua no; nhung ten mon trong o co the khac ten trong
// PCCM (vi du o ghi "Ngu van" con PCCM ghi "Van"), nen giao vien MA GIAO DIEN
// suy ra tu mot o co the khac giao vien ma bo giai nghi. Khi do luoi hop le voi
// bo giai lai thanh TRUNG TIET tren man hinh. Kiem lai bang DUNG cach giao dien
// suy ra giao vien, va tiet nao trung/di vao o Nghi-co dinh thi GO ve Chua phan
// — khong bao gio de hai lop de len nhau.
function auditCandidateHardConflicts(data, candidateTkb){
  const days = Array.isArray(DAYS) ? DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];
  const sessions = ["sang", "chieu"];
  const busy = new Map();
  const removed = [];
  const classes = Array.isArray(data?.lop) ? data.lop : [];
  for(const lop of classes){
    const cid = String(lop?.id || "");
    if(!cid || !candidateTkb?.[cid]) continue;
    const canon = lop?.ten2 || lop?.ten || cid;
    for(const d of days){
      for(const b of sessions){
        const arr = candidateTkb[cid]?.[d]?.[b];
        if(!Array.isArray(arr)) continue;
        for(let i = 0; i < arr.length; i++){
          const cell = arr[i];
          if(!cell || cell === "OFF") continue;
          const mon = typeof cell === "object" ? String(cell.mon || "") : String(cell).split(" - ")[0];
          if(!mon || mon === "OFF") continue;
          let gv = "";
          try{ gv = getTeacherForClassMon(canon, mon) || ""; }catch(_){ gv = ""; }
          if(!gv) continue;
          const teachers = String(gv).split(/[,;+]/).map(x => x.trim().toLowerCase()).filter(Boolean);
          let clashWith = "";
          for(const t of teachers){
            const key = `${t}|${d}|${b}|${i}`;
            const holder = busy.get(key);
            if(holder && holder.cid !== cid){
              // 29/08: các lớp của cùng tiết học chung (Dạy ghép nhiều lớp) không phải trùng
              let joint = false;
              try{ joint = tkbIsJointGhepPair(mon, cid, holder.mon, holder.cid); }catch(_){ joint = false; }
              if(joint) continue;
              clashWith = `${holder.ten} - ${holder.mon}`; break;
            }
          }
          if(clashWith){
            const isFixed = typeof cell === "object" && cell.fixed === true;
            if(isFixed) continue; // tiet co dinh cua nguoi dung: khong dung vao
            arr[i] = "";
            removed.push({lop: String(lop?.ten || cid), mon, thu: d, buoi: b, tiet: i + 1, trungVoi: clashWith});
            continue;
          }
          for(const t of teachers){
            busy.set(`${t}|${d}|${b}|${i}`, {cid, ten: String(lop?.ten || cid), mon});
          }
        }
      }
    }
  }
  return removed;
}

async function applyValidatedFetCandidate(data, candidateTkb, options = {}){
  const startedAt = fetTelemetryNowMs();
  try{
    const droppedByAudit = auditCandidateHardConflicts(data, candidateTkb);
    if(droppedByAudit.length){
      window.__TKB_LAST_CONFLICT_AUDIT = droppedByAudit;
      console.warn(`[TKB] Da go ${droppedByAudit.length} tiet trung giao vien ve Chua phan`, droppedByAudit.slice(0, 10));
    }else{
      window.__TKB_LAST_CONFLICT_AUDIT = [];
    }
  }catch(auditErr){
    console.warn("[TKB] audit trung tiet that bai", auditErr);
  }
  data.tkb = candidateTkb;
  if(typeof DATA !== "undefined" && DATA) {
    DATA.tkb = candidateTkb;
    DATA._lastModified = Date.now();
    DATA._updatedAt = Date.now();
  }
  window.__TKB_GLOBAL_DATA_VERSION = (window.__TKB_GLOBAL_DATA_VERSION || 0) + 1;
  window.__TKB_TEACHER_TKB_STATS_CACHE = null;
  window.__TKB_UNASSIGNED_TASKS_CACHE = null;
  try{ if(typeof SCHOOL_TKB_STATS_CACHE !== "undefined") SCHOOL_TKB_STATS_CACHE.value = null; }catch(_){ }

  try{ renderCurrentView(); }catch(err){ console.warn("Schedule render failed", err); }
  try{ applyCellSelectionStyles(); }catch(_){ }
  await nextPlannerPaint();

  let saveError = null;
  try{
    // Local persistence is synchronous; syncRemote sends to server synchronously if possible
    saveStore({force:true, trustedSolverApply:true, syncRemote:true});
  }catch(err){
    saveError = err;
    console.warn("Schedule candidate persistence failed", err);
  }
  try{
    setTimeout(() => {
      try{ loadMonList(); }catch(_){ }
      try{ refreshStatsBoxIfOpen(); }catch(_){ }
    }, 0);
  }catch(_){ }
  window.__TKB_LAST_FET_APPLY_TIMING = {
    mode:String(options?.mode || "auto"),
    renderMs:Math.max(0, Math.round(fetTelemetryNowMs() - startedAt)),
    persisted:!saveError,
    at:new Date().toISOString()
  };
  return {ok:!saveError, applied:!saveError, saveError};
}

// Browser FET is intentionally outside the solve request path.  Emit one
// best-effort terminal telemetry event only after a local attempt settles so
// Super Admin can see aggregate FET health without receiving timetable data,
// teacher/class IDs, diagnostics or raw errors.  The Rust endpoint applies a
// strict allowlist, authentication, idempotency and rate limiting again.
function fetTelemetryNowMs(){
  try{
    if(typeof performance !== "undefined" && typeof performance.now === "function"){
      return performance.now();
    }
  }catch(_){ }
  return Date.now();
}

function fetTelemetryOpaqueEventId(){
  try{
    if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"){
      return crypto.randomUUID().replace(/-/g, "");
    }
  }catch(_){ }
  const entropy = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `fet${Date.now().toString(36)}${entropy}`.slice(0, 80).padEnd(16, "0");
}

function fetTelemetryFocus(mode){
  switch(String(mode || "").trim().toLowerCase()){
    case "optimize_singletons": return { focus:"singletons", gapTarget:null, metricKey:"singletons", metricsKey:"soBuoiDay1" };
    case "optimize_sessions": return { focus:"sessions", gapTarget:null, metricKey:"sessions", metricsKey:"tsBuoiDay" };
    case "optimize_gap2": return { focus:"gaps", gapTarget:"gap2", metricKey:"gap2", metricsKey:"soBuoiTrong2" };
    case "optimize_gap1": return { focus:"gaps", gapTarget:"gap1", metricKey:"gap1", metricsKey:"soBuoiTrong1" };
    default: return { focus:"automatic", gapTarget:null, metricKey:null, metricsKey:null };
  }
}

function fetTelemetryOutcome(result){
  const failure = String(result?.failureKind || "").trim().toLowerCase();
  if(result?.cancelled === true || failure === "user_cancelled") return {outcome:"cancelled", resultKind:"cancelled"};
  if(result?.ok === true && result?.applied === true) return {outcome:"completed", resultKind:"completed"};
  if(result?.ok === true && result?.applied === false) return {outcome:"no_improvement", resultKind:"no_improvement"};
  if(/hard_validation|location_constraint|constraint_violation/.test(failure)){
    return {outcome:"failed", resultKind:"hard_constraint_violation"};
  }
  if(/zero_domain|infeasible|capacity|must_teach|fixed_location/.test(failure)){
    return {outcome:"infeasible", resultKind:"preflight_infeasible"};
  }
  if(/budget|time_budget|timeout/.test(failure)) return {outcome:"timeout", resultKind:"budget_exhausted"};
  return {outcome:"failed", resultKind:"failed"};
}

function postFetTerminalTelemetry(options, startedAtMs, result, details = {}){
  try{
    if(typeof window === "undefined" || typeof window.fetch !== "function") return null;
    const authApi = window.TKBAuthApi;
    if(!authApi || typeof authApi.getAuthHeaders !== "function") return null;
    const focus = fetTelemetryFocus(options?.mode);
    const outcome = fetTelemetryOutcome(result);
    const elapsed = Math.max(0, Math.round(fetTelemetryNowMs() - Number(startedAtMs || fetTelemetryNowMs())));
    const localBudgetSeconds = Math.max(1, Math.min(300, Number(options?.deepLocalFet === true ? 30 : (options?.localFetBudgetSeconds || 12)) || 12));
    const payload = {
      eventId:fetTelemetryOpaqueEventId(),
      executor:"fet_web_worker",
      focus:focus.focus,
      budgetKind:"local",
      budgetSeconds:localBudgetSeconds,
      runtimeMs:elapsed,
      outcome:outcome.outcome,
      resultKind:outcome.resultKind,
      fallback:options?.fallbackFromCloudRun === true
        ? "cloud_run_failed"
        : (options?.forceLocalFet === true ? "user_selected_fet" : "none"),
      applied:result?.applied === true
    };
    if(focus.gapTarget) payload.gapTarget = focus.gapTarget;
    if(typeof details.hardValid === "boolean") payload.hardValid = details.hardValid;
    if(typeof details.targetReached === "boolean") payload.targetReached = details.targetReached;
    if(typeof details.floorReached === "boolean") payload.floorReached = details.floorReached;

    const before = Number(details?.initialMetrics?.[focus.metricsKey]);
    const after = Number(details?.metrics?.[focus.metricsKey]);
    if(focus.metricKey && Number.isFinite(before) && Number.isFinite(after)){
      payload.metricKey = focus.metricKey;
      payload.metricBefore = Math.max(0, Math.round(before));
      payload.metricAfter = Math.max(0, Math.round(after));
      payload.metricDelta = payload.metricBefore - payload.metricAfter;
      const floor = Number(details.floorMetric);
      if(Number.isFinite(floor)) payload.floorMetric = Math.max(0, Math.round(floor));
      const target = Number(details.targetMetric);
      if(Number.isFinite(target)) payload.targetMetric = Math.max(0, Math.round(target));
    }
    const headers = Object.assign({"Content-Type":"application/json"}, authApi.getAuthHeaders() || {});
    if(!headers.Authorization) return null;
    // Intentionally not awaited: telemetry must never hold the UI lock or
    // affect a validated local result when the VPS is unavailable.
    window.fetch("/api/solver-telemetry/fet", {
      method:"POST",
      headers,
      body:JSON.stringify(payload),
      cache:"no-store",
      keepalive:true
    }).catch(() => {});
    return payload;
  }catch(_){
    return null;
  }
}

/* 21/08: giu tab song trong luc FET worker chay (Chrome co the DONG BANG tab
   nen sau ~5 phut — ke ca Worker — khien "quay lai tab moi thay ket qua").
   Trang giu Web Lock duoc mien tru dong bang; watcher tu nha khi worker xong. */
function tkbFetAcquireKeepalive(){
  try{
    if(!navigator.locks || typeof navigator.locks.request !== "function") return;
    if(!window.__tkbFetKeepaliveRelease){
      navigator.locks.request("tkb-fet-keepalive", () => new Promise(resolve => {
        window.__tkbFetKeepaliveRelease = resolve;
      })).catch(() => {});
    }
    if(window.__tkbFetKeepaliveTimer) window.clearInterval(window.__tkbFetKeepaliveTimer);
    window.__tkbFetKeepaliveTimer = window.setInterval(() => {
      try{
        if(window.__ACTIVE_TKB_FET_WORKER || window.__TKB_RUST_SOLVER_RUNNING) return;
        window.clearInterval(window.__tkbFetKeepaliveTimer);
        window.__tkbFetKeepaliveTimer = null;
        const release = window.__tkbFetKeepaliveRelease;
        window.__tkbFetKeepaliveRelease = null;
        if(typeof release === "function") release();
      }catch(_){ }
    }, 4000);
  }catch(_){ }
}

/* 22/08 (chi dao chu du an): chuoi "HAU-FET" (21/08, tkbPostFetQualityChain)
   — sau khi ▶ xep xong thi tu goi backend CP-SAT/Cloud Run de xep bu / toi uu
   roi keo theo bac thang tu tinh chinh — DA GO BO. Nut ▶ chi con FET trong
   trinh duyet de kiem tra xep du hay khong; toi uu GV dung nut Cherry hoac
   menu Toi uu v3 (menu Toi uu FET trong trinh duyet da go han 03/09). */

async function executeDirectFastSchedule(options = {}){
  try{
    // SINGLE-FLIGHT GUARD (sua 17/08): duong goi truc tiep (menu Toi uu FET, nut
    // Tron goi — ca hai da go, 03/09) truoc day KHONG co khoa nhu nut Sap xep (preflight token o
    // bridge), nen bam chong len nhau tao NHIEU worker song song; ket qua
    // muon cua worker cu ap de trang thai moi (da tai hien: luot optimize 225s
    // ket thuc sau khi nguoi dung xoa lich + bam xep lai -> luu lich rong).
    // Chi khoa theo WORKER THAT SU dang chay — khong dua vao co UI
    // (__TKB_SOLVE_UI_BUSY co the bi luong khac bat roi khong tat -> truoc
    // day lam nut Sap xep bi khoa vinh vien; sua 17/08 v2).
    if(window.__ACTIVE_TKB_FET_WORKER){
      const busyMsg = "Đang có lượt xếp/tối ưu chạy — hãy chờ xong hoặc bấm Dừng trước khi chạy lượt mới.";
      if(typeof setStatus === "function") setStatus(busyMsg, "info");
      return { ok:false, applied:false, failureKind:"solver_busy", error:busyMsg };
    }
    clearFetDiagnosticPanel();
    const data = (typeof window !== "undefined" && window.DATA) ? window.DATA : ((typeof DATA !== "undefined") ? DATA : null);
    if(!data) return { ok: false, error: "no_data" };
    if(!data.tkb) data.tkb = {};
    if(!data.tkbLessonTeachers) data.tkbLessonTeachers = {};
    if(!data.tkbLessonRooms) data.tkbLessonRooms = {};

    // 29/08 Tiết học chung nhiều lớp: ghim tạm vào cùng ô trước khi xếp (bộ giải giữ ô cố định).
    // Lane tối ưu chỉ tối ưu lưới đang có, không xếp tiết thiếu -> không được đè tiết khác.
    try{
      const pinMsg = tkbJointPinBeforeSolve({allowDisplace: !/^optimize/.test(String(options?.mode || ""))});
      if(pinMsg && typeof setStatus === "function") setStatus(pinMsg, "info");
    }catch(err){ console.error("pin ghep", err); }

    const FetEngineClass = (typeof window !== "undefined" && window.FetTimetableEngine)
      ? window.FetTimetableEngine
      : ((typeof FetTimetableEngine !== "undefined") ? FetTimetableEngine : null);

    let totalPlaced = 0;
    let totalUnplaced = 0;
    let directFetResult = null;
    // CẢ 2 NÚT "Trọn gói ★" và "NEW ★": LUÔN TỐI ƯU TIẾP TỪ LỊCH HIỆN TẠI (Refine incumbent)
    // tuyệt đối không đập đi xếp lại từ đầu.
    if(["solve_optimize_all", "solve_optimize_all_fresh"].includes(String(options?.mode || ""))){
      options = Object.assign({}, options, { mode: "optimize_all", __trongoiRefine: true });
      if(typeof setStatus === "function"){
        setStatus("Tối ưu tiếp từ lịch hiện tại (trọn gói)...", "info");
      }
    }
    const isOptimizeMode = ["optimize_singletons", "optimize_sessions", "optimize_gap2", "optimize_gap1", "optimize_all", "solve_optimize_all", "solve_optimize_all_fresh"].includes(options?.mode);
    // FAIL-CLOSED: mode tối ưu không nhận diện được (JS cũ bị cache, mode lạ…)
    // tuyệt đối không được rơi xuống nhánh XẾP MỚI — nhánh đó đập lịch hiện tại
    // và xây lại từ đầu. Từ chối ngay để bảo vệ lịch của người dùng.
    if(!isOptimizeMode && /^optimize/i.test(String(options?.mode || ""))){
      const failMsg = "Chế độ tối ưu chưa được phiên bản đang tải hỗ trợ. Nhấn Ctrl+F5 để tải bản mới rồi thử lại.";
      if(typeof setStatus === "function") setStatus(failMsg, "error");
      return { ok:false, applied:false, failureKind:"unknown_optimize_mode", error:failMsg };
    }
    const modeLabelMap = {
      "auto_min2": "Sắp tự động (>= 2 tiết/buổi)",
      "optimize_singletons": "1 tiết/buổi",
      "optimize_sessions": "Buổi",
      "optimize_gap2": "2 tiết trống",
      "optimize_gap1": "1 tiết trống",
      "optimize_all": "Tất cả",
      "solve_optimize_all": "Xếp + tối ưu trọn gói",
      "solve_optimize_all_fresh": "NEW – xếp mới + khóa tuần tự"
    };
    let label = modeLabelMap[options.mode] || options.mode || "Tự động";
    if(options.__trongoiRefine === true) label = "Trọn gói – tối ưu tiếp";
    const preparationMessage = isOptimizeMode
      ? (options?.fallbackFromCloudRun
          ? `Tối ưu trên máy này (Cloud Run không khả dụng) — ${label}…`
          : `Đang chuẩn bị tối ưu ${label} trên máy này…`)
      : "Đang chuẩn bị xếp lịch trên máy này…";
    if(typeof setStatus === "function") setStatus(preparationMessage, "info");
    else if(typeof _setStatus === "function") _setStatus(preparationMessage, "info");
    // optimize_all luôn chạy FET worker cục bộ (Cloud Run không có pipeline này).
    const useHybridOptimization = isOptimizeMode && options?.mode !== "optimize_all" && (isHybridModeEnabled() || options?.forceCloudRun === true);

    // Initialize live metric display immediately (Frame 0)
    const initialStatsAvailable = typeof calcTeacherTKBStats === "function";
    const initialStats = initialStatsAvailable ? calcTeacherTKBStats() : { soBuoiDay1: 0, tsBuoiDay: 0, soBuoiTrong1: 0, soBuoiTrong2: 0 };
    // Start this asynchronously so the optimiser begins at once.  It records
    // the exact validator state of the timetable before the run.  A stopped
    // checkpoint may keep that pre-existing debt, but never introduce a new
    // violation simply to obtain a nicer quality metric.
    const incumbentValidationPromise = isOptimizeMode
      ? inspectFetCandidateHardConstraints(data, JSON.parse(JSON.stringify(data.tkb || {})))
      : Promise.resolve(null);
    const validateLocalFetCandidate = async candidateTkb => {
      const incumbentBaseline = isOptimizeMode ? await incumbentValidationPromise : null;
      return validateFetCandidateHardConstraints(data, candidateTkb, isOptimizeMode ? {
        allowUnchangedIncumbentViolations:true,
        incumbentBaseline
      } : {});
    };
    let initialDetail = "";
    if(["optimize_all","solve_optimize_all","solve_optimize_all_fresh"].includes(options?.mode)){
      initialDetail = `1 tiết/buổi: ${initialStats.soBuoiDay1} • Trống 2: ${initialStats.soBuoiTrong2} • Buổi: ${initialStats.tsBuoiDay} • Trống 1: ${initialStats.soBuoiTrong1}`;
    }else if(options?.mode === "optimize_sessions"){
      initialDetail = `Buổi dạy: ${initialStats.tsBuoiDay}`;
    }else if(options?.mode === "optimize_singletons"){
      initialDetail = `Dạy 1 tiết: ${initialStats.soBuoiDay1}`;
    }else if(options?.mode === "optimize_gap2"){
      initialDetail = `Trống 2 tiết: ${initialStats.soBuoiTrong2}`;
    }else if(options?.mode === "optimize_gap1"){
      initialDetail = `Trống 1 tiết: ${initialStats.soBuoiTrong1}`;
    }else{
      let curPlaced = 0;
      let totalReq = 0;
      try {
        const lops = Array.isArray(data.lop) ? data.lop : [];
        for(const lop of lops){
          const stats = calcClassTKBPeriodStats(lop.id);
          curPlaced += stats.assigned || 0;
          totalReq += stats.total || 0;
        }
      } catch(_) {}
      initialDetail = totalReq > 0 ? `${curPlaced}/${totalReq} tiết` : `0%...`;
    }
    window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL = initialDetail;

    // Check if missing unplaced lessons exist
    let unplacedPeriodsCount = 0;
    try {
      const lops = Array.isArray(data.lop) ? data.lop : [];
      for(const lop of lops){
        const stats = calcClassTKBPeriodStats(lop.id);
        unplacedPeriodsCount += Math.max(0, (stats.total || 0) - (stats.assigned || 0));
      }
    } catch(_) {}

    if(isOptimizeMode && options.mode === "optimize_gap2" && initialStats.soBuoiTrong2 === 0){
      if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
      else setAutoSortStopVisible(false);
      if(typeof setStatus === "function") setStatus("Trống 2 tiết: 0 -> 0", "ok");
      return { ok: true, skipped: true };
    }
    if(isOptimizeMode && options.mode === "optimize_singletons" && initialStats.soBuoiDay1 === 0){
      if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
      else setAutoSortStopVisible(false);
      if(typeof setStatus === "function") setStatus("Dạy 1 tiết: 0 -> 0", "ok");
      return { ok: true, skipped: true };
    }
    if(isOptimizeMode && options.mode === "optimize_gap1" && initialStats.soBuoiTrong1 === 0){
      if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
      else setAutoSortStopVisible(false);
      if(typeof setStatus === "function") setStatus("Trống 1 tiết: 0 -> 0", "ok");
      return { ok: true, skipped: true };
    }

    if(isOptimizeMode && unplacedPeriodsCount > 0){
      if(typeof setStatus === "function") setStatus(`TKB còn ${unplacedPeriodsCount} tiết chưa xếp, đang tự động xếp đủ 100% và tối ưu [${label}]...`, "info");
    }

    // Hybrid never owns the first construction pass.  Auto always runs FET in
    // the worker; Cloud Run is reserved for an explicit optimization click.
    if(useHybridOptimization){
      const incumbentBeforeCloudRun = cloneHybridScheduleState(data);
      const incumbentFingerprint = hybridStableJson(incumbentBeforeCloudRun.tkb || {});
      window.__TKB_SOLVE_EXPLICIT_RUNNING = true;
      setAutoSortStopVisible(true);
      window.__TKB_IS_HYBRID_ACTIVE = true;
      if(typeof setStatus === "function"){
        setStatus(`Cloud Run CP-SAT — tối ưu ${label}.`, "info");
      }
      if(typeof setAutoSortProgress === "function"){
        setAutoSortProgress(0, "", { metricLabel: initialDetail, isHybrid: true });
      }
      try{
        let solverFn = (typeof window.bridgeSapXepTuDongAll === "function")
          ? window.bridgeSapXepTuDongAll
          : ((window.TKBRustAPI && typeof window.TKBRustAPI.bridgeSapXepTuDongAll === "function")
              ? window.TKBRustAPI.bridgeSapXepTuDongAll
              : ((window.TKBRustAPI && typeof window.TKBRustAPI.solve === "function")
                  ? window.TKBRustAPI.solve
                  : ((window.TkbRustBridge && typeof window.TkbRustBridge.solve === "function") ? window.TkbRustBridge.solve : null)));

        if(solverFn){
          let backendRes = await solverFn({
            mode: options.mode,
            fromHybridCaller: true,
            settings: {
              routing_mode: "serverless_only",
              ui_hybrid_executor: "cloud_run",
              ui_hybrid_deep_optimize: options?.deepOptimize === true
            }
          });
          // Some legacy bridge paths apply their own validated payload to
          // DATA before resolving. Capture that *new* snapshot explicitly,
          // then restore the incumbent before the normalized contract runs.
          // This keeps a stale/missing response from being mistaken for a
          // successful Cloud Run candidate while remaining compatible with
          // those bridge implementations during migration.
          const returnedCandidate = hybridCandidateTkbFromResponse(backendRes);
          const observedCandidate = returnedCandidate || (
            hybridStableJson(data?.tkb || {}) !== incumbentFingerprint
              ? JSON.parse(JSON.stringify(data?.tkb || {}))
              : null
          );
          if(observedCandidate){
            backendRes = Object.assign({}, backendRes || {}, {
              candidateTkb: observedCandidate,
              candidateSource: returnedCandidate ? "response_tkb" : "bridge_applied_snapshot",
              hybridMode: options.mode,
              hybridIncumbentMetrics: initialStatsAvailable ? initialStats : null
            });
          }else if(backendRes && typeof backendRes === "object"){
            // Preserve the mode/baseline even when a bridge returned no new
            // grid; the normalizer must then fail closed instead of treating
            // stale DATA.tkb as a candidate.
            backendRes = Object.assign({}, backendRes, {
              hybridMode: options.mode,
              hybridIncumbentMetrics: initialStatsAvailable ? initialStats : null
            });
          }
          restoreHybridScheduleState(data, incumbentBeforeCloudRun);
          window.__TKB_IS_HYBRID_ACTIVE = false;
          window.__TKB_SOLVE_UI_BUSY = false;
          if(typeof hideAutoSortProgress === "function"){
            hideAutoSortProgress();
          }else{
            setAutoSortStopVisible(false);
          }
          const normalized = normalizeHybridCloudRunResult(backendRes, data, incumbentFingerprint);
          if(normalized.ok === true && normalized.applied === true && normalized.tkb && typeof normalized.tkb === "object"){
            // Cloud Run's own validation is necessary but not sufficient: the
            // browser must re-run the complete local hard-constraint validator
            // against the exact candidate before mutating DATA or persisting it.
            const localCloudValidation = await validateFetCandidateHardConstraints(data, normalized.tkb);
            if(localCloudValidation.ok !== true){
              restoreHybridScheduleState(data, incumbentBeforeCloudRun);
              const localFailure = Object.assign({}, normalized, {
                ok:false,
                applied:false,
                failureKind:"cloud_run_candidate_local_validation_failed",
                error:localCloudValidation.error || "Cloud Run candidate không qua validator ràng buộc cứng tại trình duyệt.",
                diagnostics:localCloudValidation.diagnostics || null
              });
              try{ renderCurrentView(); }catch(_){ }
              try{ refreshStatsBoxIfOpen(); }catch(_){ }
              if(typeof setStatus === "function") setStatus("Cloud Run thất bại — lịch chưa thay đổi.", "error");
              return await offerHybridFailureChoice(options, localFailure);
            }
            const cloudApplyResult = await applyValidatedFetCandidate(data, normalized.tkb, options);
            if(typeof setStatus === "function"){
              setStatus(
                cloudApplyResult.ok === true
                  ? `Cloud Run CP-SAT — đã tối ưu ${label}.`
                  : `Cloud Run CP-SAT — lịch đã hiển thị nhưng chưa lưu được ngay; hãy kiểm tra kết nối rồi lưu lại.`,
                cloudApplyResult.ok === true ? "ok" : "warning"
              );
            }
            return normalized;
          }
          if(normalized.ok === true && normalized.applied === false){
            restoreHybridScheduleState(data, incumbentBeforeCloudRun);
            try{ renderCurrentView(); }catch(_){}
            if(typeof setStatus === "function"){
              setStatus(`Cloud Run CP-SAT — chưa tìm được lịch Pareto tốt hơn cho ${label}; lịch giữ nguyên.`, "info");
            }
            return normalized;
          }
          restoreHybridScheduleState(data, incumbentBeforeCloudRun);
          try{ renderCurrentView(); }catch(_){}
          try{ refreshStatsBoxIfOpen(); }catch(_){}
          if(typeof setStatus === "function"){
            setStatus("Cloud Run thất bại — lịch chưa thay đổi.", "error");
          }
          return await offerHybridFailureChoice(options, normalized);
        }
        const unavailable = {
          ok:false,
          applied:false,
          executor:"cloud_run",
          failureKind:"cloud_run_executor_unavailable",
          error:"Không tìm thấy executor Cloud Run."
        };
        restoreHybridScheduleState(data, incumbentBeforeCloudRun);
        if(typeof setStatus === "function") setStatus("Cloud Run thất bại — lịch chưa thay đổi.", "error");
        return await offerHybridFailureChoice(options, unavailable);
      }catch(err){
        window.__TKB_IS_HYBRID_ACTIVE = false;
        window.__TKB_SOLVE_UI_BUSY = false;
        if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
        console.warn("Hybrid solver error:", err);
        restoreHybridScheduleState(data, incumbentBeforeCloudRun);
        try{ renderCurrentView(); }catch(_){}
        try{ refreshStatsBoxIfOpen(); }catch(_){}
        const failure = {
          ok:false,
          applied:false,
          executor:"cloud_run",
          failureKind:String(err?.kind || "cloud_run_exception"),
          error:String(err?.message || err || "Cloud Run thất bại.")
        };
        if(typeof setStatus === "function") setStatus("Cloud Run thất bại — lịch chưa thay đổi.", "error");
        return await offerHybridFailureChoice(options, failure);
      }
    }

    // 2. Initial Sort OR Local Optimization (Hybrid OFF): Run common / supercharged local FET engine on background Web Worker
    if(typeof Worker !== "undefined"){
      return await new Promise((resolve) => {
        const telemetryStartedAtMs = fetTelemetryNowMs();
        let workerSettled = false;
        const settleWorker = (result, telemetryDetails = {}) => {
          if(workerSettled) return;
          workerSettled = true;
          try{
            postFetTerminalTelemetry(options, telemetryStartedAtMs, result, telemetryDetails);
          }catch(_){ }
          resolve(result);
        };
        let worker = null;
        try{
          worker = new Worker("tkb-fet-worker.js?v=" + Date.now());
        }catch(e){
          console.warn("Web Worker creation fallback:", e);
        }

        if(!worker){
          settleWorker({ ok: false, applied:false, executor:"fet_worker", failureKind:"fet_worker_unavailable", error: "worker_failed" });
          return;
        }

        window.__ACTIVE_TKB_FET_WORKER = worker;
        tkbFetAcquireKeepalive();
        window.__ACTIVE_TKB_FET_WORKER_RESOLVE = (result) => settleWorker(result, {
          initialMetrics:initialStats,
          hardValid:false
        });
        window.__LATEST_OPTIMIZE_TKB = null;
        window.__LATEST_OPTIMIZE_CHECKPOINT = null;
        window.__AUTO_SORT_STOP_REQUESTED = false;

        // Transform delete button into stop button during optimization
        setAutoSortStopVisible(true);

        const updateStatusMsg = (msg, level="info") => {
          if(typeof setStatus === "function") setStatus(msg, level);
          else if(typeof _setStatus === "function") _setStatus(msg, level);
        };

        // The Stop button is deliberately different for an initial build and
        // a focused optimizer. Construction may only have a partial grid, so
        // it always preserves the old schedule. Optimization can retain the
        // last *engine-locked*, complete checkpoint, but only after browser
        // validation confirms it is clean or carries no new violation beyond
        // the exact incumbent it started from.
        window.__ACTIVE_TKB_FET_WORKER_STOP = async () => {
          if(workerSettled) return;
          const checkpoint = window.__LATEST_OPTIMIZE_CHECKPOINT;
          try{ worker.terminate(); }catch(_){ }
          window.__ACTIVE_TKB_FET_WORKER = null;
          const pendingResolve = window.__ACTIVE_TKB_FET_WORKER_RESOLVE;
          window.__ACTIVE_TKB_FET_WORKER_RESOLVE = null;
          window.__ACTIVE_TKB_FET_WORKER_STOP = null;

          if(!isOptimizeMode || !checkpoint?.complete || !checkpoint?.tkb || typeof checkpoint.tkb !== "object"){
            window.__LATEST_OPTIMIZE_TKB = null;
            window.__LATEST_OPTIMIZE_CHECKPOINT = null;
            if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
            else setAutoSortStopVisible(false);
            updateStatusMsg("Đã dừng sắp xếp; lịch trước khi chạy được giữ nguyên.", "info");
            if(typeof pendingResolve === "function"){
              pendingResolve({
                ok:false,
                applied:false,
                cancelled:true,
                executor:"fet_worker",
                failureKind:"user_cancelled"
              });
            }
            return;
          }

          updateStatusMsg("Đã dừng; đang kiểm tra nghiệm tốt nhất để giữ lại…", "info");
          {
            // ANTI-WIPE GATE cho checkpoint khi bấm Dừng (sua 17/08)
            let ckCells = 0, curCells = 0;
            try{
              const cnt = (tkbObj) => {
                let n = 0;
                for(const cid of Object.keys(tkbObj || {})){
                  const byDay = tkbObj[cid]; if(!byDay || typeof byDay !== "object") continue;
                  for(const thu of Object.keys(byDay)){
                    const byBuoi = byDay[thu]; if(!byBuoi || typeof byBuoi !== "object") continue;
                    for(const buoi of Object.keys(byBuoi)){
                      const arr = byBuoi[buoi]; if(!Array.isArray(arr)) continue;
                      for(const cell of arr){
                        if(!cell || cell === "OFF") continue;
                        if(typeof cell === "object" && (cell.off === true || String(cell.val || cell.mon || "").trim() === "")) continue;
                        n++;
                      }
                    }
                  }
                }
                return n;
              };
              ckCells = cnt(checkpoint.tkb); curCells = cnt(data.tkb || {});
            }catch(_){ }
            if(ckCells < curCells){
              window.__LATEST_OPTIMIZE_TKB = null;
              window.__LATEST_OPTIMIZE_CHECKPOINT = null;
              if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
              else setAutoSortStopVisible(false);
              updateStatusMsg("Đã dừng; checkpoint thiếu tiết nên lịch hiện tại được giữ nguyên.", "warning");
              if(typeof pendingResolve === "function"){
                pendingResolve({ ok:false, applied:false, cancelled:true, executor:"fet_worker", failureKind:"fet_checkpoint_fewer_lessons_rejected" });
              }
              return;
            }
          }
          const candidateValidation = await validateLocalFetCandidate(checkpoint.tkb);
          if(candidateValidation.ok !== true){
            window.__LATEST_OPTIMIZE_TKB = null;
            window.__LATEST_OPTIMIZE_CHECKPOINT = null;
            if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
            else setAutoSortStopVisible(false);
            updateStatusMsg("Đã dừng tối ưu; checkpoint tạo thêm vi phạm ràng buộc nên lịch cũ được giữ nguyên.", "warning");
            if(typeof pendingResolve === "function"){
              pendingResolve({
                ok:false,
                applied:false,
                cancelled:true,
                executor:"fet_worker",
                failureKind:candidateValidation.failureKind || "fet_checkpoint_hard_validation_failed",
                error:candidateValidation.error
              });
            }
            return;
          }

          const applied = await applyValidatedFetCandidate(data, checkpoint.tkb, options);
          // Sau khi ap checkpoint: tinh lai chi so TU LUOI DA AP de thong bao
          // va bang Thong ke luon khop voi nhau (sua 17/08 — truoc day nhan
          // "19 -> 3" lay tu checkpoint.metrics nhung neu co lech voi luoi
          // thi nguoi dung thay so lieu mau thuan).
          let appliedStats = null;
          try{
            window.__TKB_TEACHER_TKB_STATS_CACHE = null;
            appliedStats = (typeof calcTeacherTKBStats === "function") ? calcTeacherTKBStats() : null;
          }catch(_){ appliedStats = null; }
          try{ if(typeof refreshStatsBoxIfOpen === "function") refreshStatsBoxIfOpen(); }catch(_){ }
          window.__LATEST_OPTIMIZE_TKB = null;
          window.__LATEST_OPTIMIZE_CHECKPOINT = null;
          if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
          else setAutoSortStopVisible(false);
          if(applied.ok !== true){
            updateStatusMsg("Đã dừng tối ưu; nghiệm tốt nhất đã hiển thị nhưng không lưu được ngay. Hãy kiểm tra kết nối rồi lưu lại.", "warning");
          }else{
            let transitionLabel = `[${label}]`;
            if(["optimize_all","solve_optimize_all","solve_optimize_all_fresh"].includes(options?.mode)){
              const mAll = appliedStats || checkpoint?.metrics || {};
              transitionLabel = `1 tiết/buổi: ${initialStats.soBuoiDay1} ➔ ${mAll.soBuoiDay1 ?? "?"}, Trống 2: ${initialStats.soBuoiTrong2} ➔ ${mAll.soBuoiTrong2 ?? "?"}, Buổi: ${initialStats.tsBuoiDay} ➔ ${mAll.tsBuoiDay ?? "?"}, Trống 1: ${initialStats.soBuoiTrong1} ➔ ${mAll.soBuoiTrong1 ?? "?"}`;
            }else if(options?.mode === "optimize_gap2"){
              const curGap2 = Number(appliedStats?.soBuoiTrong2 ?? checkpoint?.metrics?.soBuoiTrong2 ?? initialStats.soBuoiTrong2);
              transitionLabel = `Trống 2 tiết: ${initialStats.soBuoiTrong2} ➔ ${curGap2}`;
            }else if(options?.mode === "optimize_singletons"){
              const curSingle = Number(appliedStats?.soBuoiDay1 ?? checkpoint?.metrics?.soBuoiDay1 ?? initialStats.soBuoiDay1);
              transitionLabel = `Dạy 1 tiết/buổi: ${initialStats.soBuoiDay1} ➔ ${curSingle}`;
            }else if(options?.mode === "optimize_gap1"){
              const curGap1 = Number(appliedStats?.soBuoiTrong1 ?? checkpoint?.metrics?.soBuoiTrong1 ?? initialStats.soBuoiTrong1);
              transitionLabel = `Trống 1 tiết: ${initialStats.soBuoiTrong1} ➔ ${curGap1}`;
            }else if(options?.mode === "optimize_sessions"){
              const curSessions = Number(appliedStats?.tsBuoiDay ?? checkpoint?.metrics?.tsBuoiDay ?? initialStats.tsBuoiDay);
              transitionLabel = `Buổi dạy: ${initialStats.tsBuoiDay} ➔ ${curSessions}`;
            }
            updateStatusMsg(`Đã dừng và giữ nghiệm tốt nhất: ${transitionLabel}`, "ok");
          }
          if(typeof pendingResolve === "function"){
            pendingResolve({
              ok:true,
              applied:true,
              cancelled:true,
              retainedBestCheckpoint:true,
              executor:"fet_worker",
              tkb:data.tkb
            }, {
              initialMetrics:initialStats,
              metrics:checkpoint.metrics || null,
              hardValid:candidateValidation.hardValid === true
            });
          }
        };

        if(!isOptimizeMode){
          updateStatusMsg("Đang xếp lượt đầu: 0%...");
        }else{
          updateStatusMsg(`Đang tối ưu [${label}]: 0%...`);
        }

        // Show immediate live progress chip
        if(typeof setAutoSortProgress === "function"){
          setAutoSortProgress(0, "", { metricLabel: initialDetail, isHybrid: false });
        }

        worker.onmessage = async function(e) {
          const msg = e.data || {};
          if(msg.type === "preflight"){
            const preflight = msg.preflight || {};
            const min = preflight.minDomainActivity;
            const shortage = Array.isArray(preflight.capacityShortages) && preflight.capacityShortages.length
              ? ` Thiếu ${preflight.capacityShortages.reduce((sum, item) => sum + Number(item.shortage || 0), 0)} slot.`
              : "";
            const domain = min
              ? ` Hoạt động hẹp nhất: ${min.subject || "?"} (${min.allowedSlots ?? 0} slot).`
              : "";
            updateStatusMsg(
              `Kiểm tra dữ liệu: ${preflight.activityCount || 0} hoạt động, ${preflight.blockedSlotCount || 0} slot bị khóa.${domain}${shortage}`,
              shortage ? "warning" : "info"
            );
          }else if(msg.type === "progress"){
            const checkpoint = msg.checkpoint;
            if(isOptimizeMode && checkpoint?.complete === true && checkpoint?.tkb && typeof checkpoint.tkb === "object"){
              window.__LATEST_OPTIMIZE_CHECKPOINT = checkpoint;
              window.__LATEST_OPTIMIZE_TKB = checkpoint.tkb;

              const now = Date.now();
              if(!window.__LAST_LIVE_GRID_RENDER || (now - window.__LAST_LIVE_GRID_RENDER) >= 400){
                window.__LAST_LIVE_GRID_RENDER = now;
                try {
                  data.tkb = checkpoint.tkb;
                  if(typeof renderCurrentView === "function") renderCurrentView();
                } catch(_) {}
              }
            }

            let detail = "";
            const initVal = msg.initialMetric;
            const curVal = msg.currentMetric;
            if(msg.stage === "construction"){
              // Pha XEP MOI cua mode tron goi: hien tien do dat tiet truc tiep
              const done = Number(msg.currentMetric) || 0;
              const total = Number(msg.initialMetric) || 0;
              window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL = total > 0
                ? `Đang xếp: ${done}/${total} tiết`
                : `Đang xếp lịch mới…`;
            }
            if(["optimize_all","solve_optimize_all","solve_optimize_all_fresh"].includes(options.mode) && msg.metrics){
              const stageLabelMap = {
                "optimize_singletons": "1 tiết/buổi",
                "optimize_gap2": "Trống 2 tiết",
                "optimize_sessions": "Buổi dạy",
                "optimize_gap1": "Trống 1 tiết"
              };
              const stageLabel = stageLabelMap[msg.stage] || "Tối ưu";
              detail = `${stageLabel} • 1t/buổi:${msg.metrics.soBuoiDay1} T2:${msg.metrics.soBuoiTrong2} B:${msg.metrics.tsBuoiDay} T1:${msg.metrics.soBuoiTrong1}`;
            }else if(initVal !== undefined && curVal !== undefined){
              if(options.mode === "optimize_sessions"){
                detail = `Buổi dạy: ${initVal} ➔ ${curVal}`;
              }else if(options.mode === "optimize_singletons"){
                detail = `Dạy 1 tiết: ${initVal} ➔ ${curVal}`;
              }else if(options.mode === "optimize_gap2"){
                detail = `Trống 2 tiết: ${initVal} ➔ ${curVal}`;
              }else if(options.mode === "optimize_gap1"){
                detail = `Trống 1 tiết: ${initVal} ➔ ${curVal}`;
              }
            }else if(msg.metrics){
              if(options.mode === "optimize_sessions"){
                detail = `Buổi dạy: ${msg.metrics.tsBuoiDay}`;
              }else if(options.mode === "optimize_singletons"){
                detail = `Dạy 1 tiết: ${msg.metrics.soBuoiDay1}`;
              }else if(options.mode === "optimize_gap2"){
                detail = `Trống 2 tiết: ${msg.metrics.soBuoiTrong2}`;
              }else if(options.mode === "optimize_gap1"){
                detail = `Trống 1 tiết: ${msg.metrics.soBuoiTrong1}`;
              }
            }else if(!isOptimizeMode){
              const placed = msg.placed ?? 0;
              const total = msg.total ?? 0;
              detail = `${placed}/${total} tiết`;
            }

            if(detail){
              window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL = detail;
            }

            if(typeof setAutoSortProgress === "function"){
              setAutoSortProgress(msg.percent, "", { metricLabel: detail || window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL, isHybrid: false });
            }

            if(typeof updateStatsBoxLiveProgress === "function"){
              try{
                updateStatsBoxLiveProgress({
                  focus: options.mode,
                  current: msg.currentMetric
                });
              }catch(_){}
            }
          }else if(msg.type === "error"){
            // The worker catches engine exceptions and posts this structured
            // terminal frame, so it does not trigger `worker.onerror`.
            // Treat it as a normal fail-closed finish instead of leaving the
            // toolbar busy forever.
            try{ worker.terminate(); }catch(_){ }
            window.__ACTIVE_TKB_FET_WORKER = null;
            window.__ACTIVE_TKB_FET_WORKER_RESOLVE = null;
            window.__ACTIVE_TKB_FET_WORKER_STOP = null;
            if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
            else setAutoSortStopVisible(false);
            updateStatusMsg("Bộ xử lý xếp lịch trên máy gặp lỗi; lịch hiện tại được giữ nguyên.", "error");
            settleWorker({
              ok:false,
              applied:false,
              executor:"fet_worker",
              failureKind:"fet_worker_error",
              error:"Bộ xử lý xếp lịch trên máy gặp lỗi."
            }, {
              initialMetrics:initialStats,
              hardValid:false
            });
            return;
          }else if(msg.type === "done"){
            worker.terminate();
            window.__ACTIVE_TKB_FET_WORKER = null;
            window.__ACTIVE_TKB_FET_WORKER_RESOLVE = null;
            window.__ACTIVE_TKB_FET_WORKER_STOP = null;

            // Keep stop button visible in disabled/finalizing state until candidate is applied,
            // never unlock buttons or show trash button while apply is in progress.
            const stopBtn = document.getElementById("btnStopAutoSort");
            if(stopBtn){
              stopBtn.disabled = true;
              setAutoSortStopAccessibleState(true);
            }

            if(msg.ok !== true || msg.applied !== true || !msg.tkb || typeof msg.tkb !== "object"){
              if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
              else setAutoSortStopVisible(false);
              const diagnostic = msg?.diagnostics?.blockedActivities?.[0]
                || msg?.diagnostics?.zeroDomainActivities?.[0]
                || msg?.diagnostics?.minDomainActivity;
              const detail = diagnostic
                ? (Number.isFinite(Number(diagnostic.allowedSlots))
                  ? ` Hoạt động kẹt: ${diagnostic.subject || "?"} (${Number(diagnostic.allowedSlots)} slot hợp lệ).`
                  : ` Hoạt động kẹt: ${diagnostic.subject || "?"}.`)
                : "";
              updateStatusMsg(
                `Chưa thể xếp đủ lịch với các yêu cầu hiện tại.${detail} Lịch hiện tại được giữ nguyên. Bạn có thể kiểm tra tiết nghỉ, tiết cố định hoặc giới hạn rồi thử lại.`,
                "warning"
              );
              renderFetDiagnosticPanel(msg.diagnostics || null);
              settleWorker({
                ok:false,
                applied:false,
                executor:msg.executor || "fet_worker",
                failureKind:msg.failureKind || "fet_incomplete_or_infeasible",
                diagnostics:msg.diagnostics || null,
                error:"Không tìm được lịch hoàn chỉnh; lịch hiện tại được giữ nguyên."
              }, {
                initialMetrics:msg.initialMetrics || initialStats,
                metrics:msg.metrics || null
              });
              return;
            }

            // ANTI-WIPE GATE (sua 17/08): mot ket qua toi uu KHONG BAO GIO duoc
            // co it o tiet hon luoi hien tai — chan moi ket qua muon/rong ap de
            // lich (nguon goc vu luu lich 150 o luc 13:03).
            const __countLessonCells = (tkbObj) => {
              let n = 0;
              try{
                for(const cid of Object.keys(tkbObj || {})){
                  const byDay = tkbObj[cid];
                  if(!byDay || typeof byDay !== "object") continue;
                  for(const thu of Object.keys(byDay)){
                    const byBuoi = byDay[thu];
                    if(!byBuoi || typeof byBuoi !== "object") continue;
                    for(const buoi of Object.keys(byBuoi)){
                      const arr = byBuoi[buoi];
                      if(!Array.isArray(arr)) continue;
                      for(const cell of arr){
                        if(!cell || cell === "OFF") continue;
                        if(typeof cell === "object" && (cell.off === true || String(cell.val || cell.mon || "").trim() === "")) continue;
                        n++;
                      }
                    }
                  }
                }
              }catch(_){ }
              return n;
            };
            if(isOptimizeMode){
              const __candCells = __countLessonCells(msg.tkb);
              const __curCells = __countLessonCells(data.tkb || {});
              if(__candCells < __curCells){
                if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
                else setAutoSortStopVisible(false);
                updateStatusMsg(
                  `Kết quả tối ưu bị loại vì thiếu tiết (${__candCells}/${__curCells} ô) — lịch hiện tại được giữ nguyên.`,
                  "warning"
                );
                settleWorker({
                  ok:false,
                  applied:false,
                  executor:"fet_worker",
                  failureKind:"fet_candidate_fewer_lessons_rejected",
                  error:"Optimize candidate has fewer lesson cells than the current grid."
                }, {
                  initialMetrics:msg.initialMetrics || initialStats,
                  metrics:msg.metrics || null,
                  hardValid:false
                });
                return;
              }
            }
            let candidateValidation = { ok: true };
            if(isOptimizeMode){
              candidateValidation = await validateFetCandidateHardConstraints(data, msg.tkb, {
                allowUnchangedIncumbentViolations:true,
                incumbentBaseline: await incumbentValidationPromise
              });
              if(candidateValidation.ok !== true){
                if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
                else setAutoSortStopVisible(false);
                updateStatusMsg(
                  "Không thể tối ưu thêm do chạm giới hạn ràng buộc (lịch hiện tại được giữ nguyên).",
                  "info"
                );
                clearFetDiagnosticPanel();
                settleWorker({
                  ok:false,
                  applied:false,
                  executor:"fet_worker",
                  failureKind:candidateValidation.failureKind || "fet_candidate_hard_validation_failed",
                  diagnostics:validationDiagnostics,
                  error:candidateValidation.error
                }, {
                  initialMetrics:msg.initialMetrics || initialStats,
                  metrics:msg.metrics || null,
                  hardValid:false
                });
                return;
              }
            }

            const applyResult = await applyValidatedFetCandidate(data, msg.tkb, options);

            let doneStatusMsg = "";
            if(!isOptimizeMode){
              const placed = msg.placed ?? totalPlaced;
              const total = msg.total ?? (msg.placed + (msg.unassigned || 0));
              const unassigned = msg.unassigned ?? 0;
              if(total > 0){
                if(unassigned === 0){
                  doneStatusMsg = `Đã xếp xong toàn bộ ${placed}/${total} tiết.`;
                }else{
                  doneStatusMsg = `Đã xếp xong ${placed}/${total} tiết (Còn ${unassigned} tiết chưa xếp).`;
                  // 19/08: noi ro LY DO khi thieu o. Truoc day may xay dung
                  // quay 20 luot roi tra ve "con N tiet chua xep" ma khong cho
                  // biet la KHONG THE xep du — vi so o trong it hon so tiet.
                  const deficit = Number(msg.capacityDeficit) || 0;
                  if(deficit > 0){
                    const rows = Array.isArray(msg.capacityRows) ? msg.capacityRows : [];
                    const detail = rows.slice(0, 6)
                      .map(r => `${r.className} thiếu ${r.deficit}`)
                      .join(", ");
                    doneStatusMsg += ` KHÔNG đủ ô trống: cần thêm ${deficit} ô${detail ? " — " + detail : ""}.`
                      + " Hãy bỏ bớt ô Nghỉ hoặc giảm tiết chuẩn cho các lớp này.";
                  }else if(msg.deadlineHit === true){
                    doneStatusMsg += " Hết thời gian tìm kiếm — bấm lại để chạy tiếp.";
                  }
                  // 19/08: mau thuan "cap tiet doi" vs "Gioi han tiet/buoi" —
                  // day la nguyen nhan kieu "con 4 tiet cua co Thuy.A chua phan"
                  // ma nhin vao Phan cong thi thay da phan cong day du.
                  // 19/08: be tac vi GIAO VIEN, khong phai vi lop. Lop co the
                  // vua khit nhung mot GV phai day nhieu tiet hon so o thoi gian
                  // ma cac lop cua ho mo ra -> khong bao gio xep du.
                  const tDeficit = Number(msg.teacherDeficit) || 0;
                  if(tDeficit > 0){
                    const tRows = Array.isArray(msg.teacherRows) ? msg.teacherRows : [];
                    const tDetail = tRows.slice(0, 5)
                      .map(r => `${r.teacher} cần ${r.need} tiết nhưng chỉ có ${r.slots} ô (${r.classCount} lớp)`)
                      .join("; ");
                    doneStatusMsg += ` GIÁO VIÊN QUÁ TẢI ${tDeficit} tiết: ${tDetail}.`
                      + " Hãy chia bớt lớp cho giáo viên khác hoặc mở thêm buổi cho các lớp đó.";
                  }
                  const audit = Array.isArray(window.__TKB_LAST_CONFLICT_AUDIT) ? window.__TKB_LAST_CONFLICT_AUDIT : [];
                  if(audit.length){
                    const first = audit.slice(0, 3)
                      .map(r => `${r.lop} ${r.mon} (${r.thu} ${r.buoi} tiết ${r.tiet}, trùng ${r.trungVoi})`)
                      .join("; ");
                    doneStatusMsg += ` Đã gỡ ${audit.length} tiết TRÙNG GIÁO VIÊN về Chưa phân: ${first}.`;
                  }
                  const blockConflicts = Array.isArray(msg.blockLimitConflicts) ? msg.blockLimitConflicts : [];
                  if(blockConflicts.length){
                    const detail = blockConflicts.slice(0, 5)
                      .map(c => `${c.className} ${c.mon} (đôi ${c.blockLen} tiết / giới hạn ${c.sessionLimit})`)
                      .join(", ");
                    doneStatusMsg += ` Có yêu cầu tiết đôi vượt Giới hạn tiết/buổi nên đã bỏ ghép đôi: ${detail}.`;
                  }
                }
              }else{
                doneStatusMsg = `Đã xếp xong ${placed} tiết.`;
              }
            }else{
              const initM = msg.initialMetrics;
              const bestM = msg.metrics;
              if(initM && bestM){
                if(options.mode === "solve_optimize_all" || options.mode === "solve_optimize_all_fresh"){
                  doneStatusMsg = `Đã xếp mới + tối ưu trọn gói — 1 tiết/buổi: ${bestM.soBuoiDay1}, Trống 2: ${bestM.soBuoiTrong2}, Trống 1: ${bestM.soBuoiTrong1}, Buổi: ${bestM.tsBuoiDay}`;
                }else if(options.mode === "optimize_all"){
                  doneStatusMsg = `Đã tối ưu tất cả — 1 tiết/buổi: ${initM.soBuoiDay1} ➔ ${bestM.soBuoiDay1}, Trống 2: ${initM.soBuoiTrong2} ➔ ${bestM.soBuoiTrong2}, Buổi: ${initM.tsBuoiDay} ➔ ${bestM.tsBuoiDay}, Trống 1: ${initM.soBuoiTrong1} ➔ ${bestM.soBuoiTrong1}`;
                }else if(options.mode === "optimize_gap2"){
                  doneStatusMsg = `Đã tối ưu Trống 2 tiết: ${initM.soBuoiTrong2} ➔ ${bestM.soBuoiTrong2}`;
                }else if(options.mode === "optimize_singletons"){
                  doneStatusMsg = `Đã tối ưu Dạy 1 tiết/buổi: ${initM.soBuoiDay1} ➔ ${bestM.soBuoiDay1}`;
                }else if(options.mode === "optimize_gap1"){
                  doneStatusMsg = `Đã tối ưu Trống 1 tiết: ${initM.soBuoiTrong1} ➔ ${bestM.soBuoiTrong1}`;
                }else if(options.mode === "optimize_sessions"){
                  doneStatusMsg = `Đã tối ưu Buổi dạy: ${initM.tsBuoiDay} ➔ ${bestM.tsBuoiDay}`;
                }
              }
              if(!doneStatusMsg){
                doneStatusMsg = `Đã tối ưu xong mục tiêu [${label}].`;
              }
              const finalTarget = options.mode === "optimize_sessions"
                ? Number(bestM?.tsBuoiDay || 0)
                : (options.mode === "optimize_singletons"
                  ? Number(bestM?.soBuoiDay1 || 0)
                  : (options.mode === "optimize_gap2"
                    ? Number(bestM?.soBuoiTrong2 || 0)
                    : Number(bestM?.soBuoiTrong1 || 0)));
              if(options.mode !== "optimize_singletons"){
                const provenFloorMessage = fetProvenMetricFloorMessage(
                  options.mode,
                  bestM,
                  msg.diagnostics || null
                );
                if(provenFloorMessage){
                  doneStatusMsg = `${doneStatusMsg} ${provenFloorMessage}`.trim();
                }else if(msg.stagnated === true && finalTarget > 0){
                  doneStatusMsg = `Đạt cận hiện biết cho [${label}]: ${finalTarget}. Chưa thể cải thiện thêm trong thời gian cho phép.`;
                }
              }
            }

            if(isOptimizeMode && Number(msg.unassigned) > 0){
              doneStatusMsg = `${doneStatusMsg} Còn ${Number(msg.unassigned)} tiết chưa xếp được do ràng buộc — kiểm tra tiết nghỉ/cố định rồi chạy lại.`.trim();
            }
            // BAO CAO TRUNG THUC THEO GOC NHIN APP (sua 17/08): engine chi xep
            // duoc nhung hoat dong no TAO RA duoc tu PCCM; neu app van thay
            // thieu tiet (vd mon alias chua khop phan cong -> muc "Chua phan")
            // thi phai noi ro thay vi bao "xong toan bo".
            try{
              let __appMissing = 0;
              for(const lop of (Array.isArray(data.lop) ? data.lop : [])){
                const st = calcClassTKBPeriodStats(lop.id);
                __appMissing += Number(st.missing) || 0;
              }
              if(__appMissing > 0){
                doneStatusMsg = (doneStatusMsg + " ⚠ Theo phân công, còn " + __appMissing + " tiết chưa xếp được (xem mục Chưa phân — thường do môn chưa gán giáo viên hoặc tên môn/GV không khớp PCCM).").trim();
              }
            }catch(_){ }
            window.__TKB_IS_HYBRID_ACTIVE = false;
            window.__TKB_TEACHER_TKB_STATS_CACHE = null;
            const saveSuffix = applyResult.ok === true
              ? ""
              : " Lịch đã hiển thị nhưng chưa lưu được ngay; hãy kiểm tra kết nối rồi lưu lại.";
            if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
            updateStatusMsg(
              `${doneStatusMsg || (isOptimizeMode ? "Đã tối ưu hoàn tất." : "Đã sắp xếp xong!")}${saveSuffix}`,
              "ok"
            );
            settleWorker({
              ok: true,
              applied:true,
              executor:"fet_worker",
              tkb: data.tkb,
              targetReached:msg.targetReached === true,
              floorReached:msg.floorReached === true,
              targetMetric:msg.targetMetricLowerBound,
              floorMetric:msg.targetMetricLowerBound
            }, {
              initialMetrics:msg.initialMetrics || initialStats,
              metrics:msg.metrics || null,
              hardValid:candidateValidation.hardValid === true,
              targetReached:msg.targetReached === true,
              floorReached:msg.floorReached === true,
              targetMetric:msg.targetMetricLowerBound,
              floorMetric:msg.targetMetricLowerBound
            });
            // 22/08: nut ▶ dung tai day. Chuoi hau ky "tkbPostFetQualityChain"
            // (21/08: tu goi backend CP-SAT khi con thieu tiet / con no chat
            // luong roi keo theo bac thang) da duoc go theo chi dao chu du an —
            // ▶ chi la FET de kiem tra xep du hay khong.
          }
        };

        worker.onerror = function(err) {
          console.error("FET Worker Error:", err);
          worker.terminate();
          window.__ACTIVE_TKB_FET_WORKER = null;
          window.__ACTIVE_TKB_FET_WORKER_RESOLVE = null;
          window.__ACTIVE_TKB_FET_WORKER_STOP = null;
          if(typeof hideAutoSortProgress === "function") hideAutoSortProgress();
          updateStatusMsg("Có lỗi xảy ra trong quá trình xếp thời khóa biểu trên máy.", "error");
          settleWorker({
            ok:false,
            applied:false,
            executor:"fet_worker",
            failureKind:"fet_worker_error",
            error:"Bộ xử lý xếp lịch trên máy gặp lỗi."
          }, {
            initialMetrics:initialStats,
            hardValid:false
          });
        };

        // Send task to background worker
        worker.postMessage({
          action: isOptimizeMode ? "optimize" : "solve",
          mode: options.mode || "fast",
          data: JSON.parse(JSON.stringify(data)),
          options
        });
      });
    }

    if(FetEngineClass){
      const directFetIncumbent = cloneHybridScheduleState(data);
      const engine = new FetEngineClass(data, options);
      let res;

      if(isOptimizeMode){
        const modeLabelMap = {
          "optimize_singletons": "1 tiết/buổi",
          "optimize_sessions": "Buổi",
          "optimize_gap2": "2 tiết trống",
          "optimize_gap1": "1 tiết trống"
        };
        const label = modeLabelMap[options.mode] || options.mode;
        if(typeof setStatus === "function") setStatus(`Đang tối ưu mục tiêu [${label}]...`, "info");
        else if(typeof _setStatus === "function") _setStatus(`Đang tối ưu mục tiêu [${label}]...`, "info");

        // Run deep FET Engine optimizer for maximum quality convergence and 100% timetable integrity
        res = await engine.optimize(options.mode, (prog) => {
          let detail = "";
          if(prog.metrics){
            if(options.mode === "optimize_sessions"){
              detail = `Buổi dạy: ${prog.metrics.tsBuoiDay}`;
            }else if(options.mode === "optimize_singletons"){
              detail = `Dạy 1 tiết: ${prog.metrics.soBuoiDay1}`;
            }else if(options.mode === "optimize_gap2"){
              detail = `Trống 2 tiết: ${prog.metrics.soBuoiTrong2}`;
            }else if(options.mode === "optimize_gap1"){
              detail = `Trống 1 tiết: ${prog.metrics.soBuoiTrong1}`;
            }
          }else{
            detail = `${prog.currentMetric ?? ''}`;
          }

          if(typeof setAutoSortProgress === "function"){
            setAutoSortProgress(prog.percent, "", { metricLabel: detail });
          }

          if(typeof updateStatsBoxLiveProgress === "function"){
            try{
              updateStatsBoxLiveProgress({
                focus: options.mode,
                current: prog.currentMetric
              });
            }catch(_){}
          }
        });
      }else{
        res = await engine.solve((prog) => {
          const msg = prog.message || `Đang sắp xếp: ${prog.percent}% (${prog.placed || 0}/${prog.total || 0} tiết)...`;
          if(typeof setStatus === "function") setStatus(msg, "info");
          else if(typeof _setStatus === "function") _setStatus(msg, "info");
        });
      }

      if(res?.ok !== true || res?.applied === false){
        const diagnostic = res?.diagnostics?.blockedActivities?.[0]
          || res?.diagnostics?.zeroDomainActivities?.[0]
          || res?.diagnostics?.minDomainActivity;
        const detail = diagnostic
          ? ` Hoạt động kẹt: ${diagnostic.subject || "?"} (${diagnostic.allowedSlots ?? 0} slot hợp lệ).`
          : "";
        const message = `Chưa thể xếp đủ lịch với các yêu cầu hiện tại.${detail} Lịch hiện tại được giữ nguyên. Bạn có thể kiểm tra tiết nghỉ, tiết cố định hoặc giới hạn rồi thử lại.`;
        if(typeof setStatus === "function") setStatus(message, "warning");
        else if(typeof _setStatus === "function") _setStatus(message, "warning");
        renderFetDiagnosticPanel(res?.diagnostics || null);
        return {
          ok:false,
          applied:false,
          executor:res?.executor || "fet_worker",
          failureKind:res?.failureKind || "fet_incomplete_or_infeasible",
          diagnostics:res?.diagnostics || null,
          error:message
        };
      }
      const candidateValidation = await validateLocalFetCandidate(data.tkb);
      if(candidateValidation.ok !== true){
        restoreHybridScheduleState(data, directFetIncumbent);
        const message = "Không thể tối ưu thêm do chạm giới hạn ràng buộc (lịch hiện tại được giữ nguyên).";
        if(typeof setStatus === "function") setStatus(message, "info");
        else if(typeof _setStatus === "function") _setStatus(message, "info");
        clearFetDiagnosticPanel();
        return {
          ok:false,
          applied:false,
          executor:"fet_worker",
          failureKind:candidateValidation.failureKind || "fet_candidate_hard_validation_failed",
          diagnostics:candidateValidation.diagnostics || null,
          error:message
        };
      }
      totalPlaced = res.placed;
      totalUnplaced = res.unassigned;
      directFetResult = res;
    }else{
      // The historical inline greedy placer cannot certify all current hard
      // constraints.  Do not silently route to it if the FET worker/engine is
      // unavailable; fail closed and leave the incumbent untouched.
      return {
        ok:false,
        applied:false,
        executor:"fet_worker",
        failureKind:"fet_engine_unavailable",
        error:"Bộ xử lý xếp lịch trên máy không khả dụng; lịch hiện tại được giữ nguyên."
      };

      // Fallback Greedy Placer
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      // 1. Ensure grid structure exists for every class
      const classes = Array.isArray(data.lop) ? data.lop : [];
      classes.forEach(l => {
        const cid = String(l.id || "");
        if(!cid) return;
        if(!data.tkb[cid]) data.tkb[cid] = {};
        DAYS_LIST.forEach(thu => {
          if(!data.tkb[cid][thu]) data.tkb[cid][thu] = {};
          SESSIONS_LIST.forEach(buoi => {
            if(!Array.isArray(data.tkb[cid][thu][buoi])){
              data.tkb[cid][thu][buoi] = [null, null, null, null, null];
            }
            while(data.tkb[cid][thu][buoi].length < 5){
              data.tkb[cid][thu][buoi].push(null);
            }
          });
        });
      });

      // 2. Build occupancy maps for Teachers, Rooms, and Classes
      const teacherOccupancy = new Map();
      const roomOccupancy = new Map();
      const classOccupancy = new Map();

      function addTeacherSlot(teacherRaw, slotKey){
        if(!teacherRaw) return;
        const list = teacherListFromValue(teacherRaw);
        list.forEach(t => {
          const k = t.trim().toLowerCase();
          if(!k) return;
          if(!teacherOccupancy.has(k)) teacherOccupancy.set(k, new Set());
          teacherOccupancy.get(k).add(slotKey);
        });
      }

      function addRoomSlot(roomRaw, slotKey){
        const r = String(roomRaw || "").trim().toLowerCase();
        if(!r) return;
        if(!roomOccupancy.has(r)) roomOccupancy.set(r, new Set());
        roomOccupancy.get(r).add(slotKey);
      }

      function isTeacherBusy(teacherRaw, slotKey){
        if(!teacherRaw) return false;
        const list = teacherListFromValue(teacherRaw);
        return list.some(t => {
          const k = t.trim().toLowerCase();
          return k && teacherOccupancy.has(k) && teacherOccupancy.get(k).has(slotKey);
        });
      }

      function isRoomBusy(roomRaw, slotKey){
        const r = String(roomRaw || "").trim().toLowerCase();
        if(!r) return false;
        return roomOccupancy.has(r) && roomOccupancy.get(r).has(slotKey);
      }

      classes.forEach(l => {
        const cid = String(l.id || "");
        const canon = getLopCanonById(cid);
        const classSlots = new Set();
        classOccupancy.set(cid, classSlots);

        DAYS_LIST.forEach(thu => {
          SESSIONS_LIST.forEach(buoi => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            for(let ti = 0; ti < 5; ti++){
              const cell = arr[ti];
              const slotKey = `${thu}|${buoi}|${ti}`;
              if(cell === "OFF"){
                classSlots.add(slotKey);
              }else if(cell){
                const mon = cellMon(cell);
                if(mon){
                  classSlots.add(slotKey);
                  const gv = getTeacherForClassMon(canon, mon);
                  const rm = getRoomForClassMon(canon, mon);
                  addTeacherSlot(gv, slotKey);
                  addRoomSlot(rm, slotKey);
                }
              }
            }
          });
        });
      });

      const tasks = collectUnassignedTasks({});
      if(!tasks || !tasks.length){
        const msg = "Thời khóa biểu đã đủ tiết, không còn tiết nào chưa phân.";
        if(typeof setStatus === "function") setStatus(msg, "ok");
        else if(typeof _setStatus === "function") _setStatus(msg, "ok");
        return { ok: true, placed: 0, unassigned: 0 };
      }

      const teacherFrequency = new Map();
      tasks.forEach(t => {
        const gvList = teacherListFromValue(t.gv);
        gvList.forEach(g => {
          const k = g.trim().toLowerCase();
          if(k) teacherFrequency.set(k, (teacherFrequency.get(k) || 0) + 1);
        });
      });

      tasks.sort((a, b) => {
        let freqA = 0;
        teacherListFromValue(a.gv).forEach(g => freqA += teacherFrequency.get(g.trim().toLowerCase()) || 0);
        let freqB = 0;
        teacherListFromValue(b.gv).forEach(g => freqB += teacherFrequency.get(g.trim().toLowerCase()) || 0);
        if(freqB !== freqA) return freqB - freqA;
        return (b.remain || 0) - (a.remain || 0);
      });

      for(const task of tasks){
        const cid = String(task.classId || "");
        const canon = task.classCanon || getLopCanonById(cid);
        const mon = task.mon;
        const gv = task.gv || getTeacherForClassMon(canon, mon);
        const room = task.room || getRoomForClassMon(canon, mon);
        let remain = Number(task.remain || 0);

        const classSlots = classOccupancy.get(cid) || new Set();

        while(remain >= 2){
          let pairSlot = null;
          for(const thu of DAYS_LIST){
            if(pairSlot) break;
            for(const buoi of SESSIONS_LIST){
              if(pairSlot) break;
              const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
              for(let ti = 0; ti <= 3; ti++){
                const slot1 = `${thu}|${buoi}|${ti}`;
                const slot2 = `${thu}|${buoi}|${ti + 1}`;
                if(classSlots.has(slot1) || classSlots.has(slot2)) continue;
                if(arr[ti] === "OFF" || isFixed(arr[ti]) || cellMon(arr[ti])) continue;
                if(arr[ti + 1] === "OFF" || isFixed(arr[ti + 1]) || cellMon(arr[ti + 1])) continue;
                if(isTeacherBusy(gv, slot1) || isTeacherBusy(gv, slot2)) continue;
                if(isRoomBusy(room, slot1) || isRoomBusy(room, slot2)) continue;

                pairSlot = { thu, buoi, ti, slot1, slot2 };
                break;
              }
            }
          }

          if(pairSlot){
            const { thu, buoi, ti, slot1, slot2 } = pairSlot;
            data.tkb[cid][thu][buoi][ti] = mon;
            data.tkb[cid][thu][buoi][ti + 1] = mon;
            classSlots.add(slot1);
            classSlots.add(slot2);
            addTeacherSlot(gv, slot1);
            addTeacherSlot(gv, slot2);
            addRoomSlot(room, slot1);
            addRoomSlot(room, slot2);

            const key = `${cid}|${mon}`;
            if(gv) data.tkbLessonTeachers[key] = gv;
            if(room) data.tkbLessonRooms[key] = room;

            remain -= 2;
            totalPlaced += 2;
          }else{
            break;
          }
        }

        while(remain > 0){
          let singleSlot = null;
          for(const thu of DAYS_LIST){
            if(singleSlot) break;
            for(const buoi of SESSIONS_LIST){
              if(singleSlot) break;
              const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
              for(let ti = 0; ti < 5; ti++){
                const slotKey = `${thu}|${buoi}|${ti}`;
                if(classSlots.has(slotKey)) continue;
                const cell = arr[ti];
                if(cell === "OFF" || isFixed(cell) || cellMon(cell)) continue;
                if(isTeacherBusy(gv, slotKey)) continue;
                if(isRoomBusy(room, slotKey)) continue;

                singleSlot = { thu, buoi, ti, slotKey };
                break;
              }
            }
          }

          if(singleSlot){
            const { thu, buoi, ti, slotKey } = singleSlot;
            data.tkb[cid][thu][buoi][ti] = mon;
            classSlots.add(slotKey);
            addTeacherSlot(gv, slotKey);
            addRoomSlot(room, slotKey);

            const key = `${cid}|${mon}`;
            if(gv) data.tkbLessonTeachers[key] = gv;
            if(room) data.tkbLessonRooms[key] = room;

            remain--;
            totalPlaced++;
          }else{
            totalUnplaced += remain;
            break;
          }
        }
      }
    }

    // Save and refresh UI
    if(totalPlaced > 0){
      if(typeof saveStore === "function"){
        try{
          await Promise.resolve(saveStore({ force: true, trustedSolverApply: true }));
        }catch(e){
          console.error("saveStore failed:", e);
        }
      }
      if(typeof renderCurrentView === "function"){
        try{ renderCurrentView(); }catch(_){}
      }
      if(typeof loadMonList === "function"){
        try{ loadMonList(); }catch(_){}
      }
      if(typeof updateStatsTkbTable === "function"){
        try{ updateStatsTkbTable(); }catch(_){}
      }
      if(typeof refreshStatsBoxIfOpen === "function"){
        try{ refreshStatsBoxIfOpen(); }catch(_){}
      }
    }

    let finalMsg;
    if(isOptimizeMode){
      const initM = directFetResult?.initialMetrics || initialStats;
      const bestM = directFetResult?.metrics || (typeof calcTeacherTKBStats === "function" ? calcTeacherTKBStats() : {});
      if(options.mode === "optimize_gap2"){
        finalMsg = `Trống 2 tiết: ${initM.soBuoiTrong2 ?? 0} -> ${bestM.soBuoiTrong2 ?? 0}`;
      }else if(options.mode === "optimize_singletons"){
        finalMsg = `Dạy 1 tiết: ${initM.soBuoiDay1 ?? 0} -> ${bestM.soBuoiDay1 ?? 0}`;
      }else if(options.mode === "optimize_gap1"){
        finalMsg = `Trống 1 tiết: ${initM.soBuoiTrong1 ?? 0} -> ${bestM.soBuoiTrong1 ?? 0}`;
      }else if(options.mode === "optimize_sessions"){
        finalMsg = `Buổi dạy: ${initM.tsBuoiDay ?? 0} -> ${bestM.tsBuoiDay ?? 0}`;
      }else{
        finalMsg = `Đã hoàn tất tối ưu mục tiêu [${options.mode}]!`;
      }
      const directFloorMessage = fetProvenMetricFloorMessage(
        options.mode,
        directFetResult?.metrics || null,
        directFetResult?.diagnostics || null
      );
      if(directFloorMessage) finalMsg += ` ${directFloorMessage}`;
    }else{
      finalMsg = (totalUnplaced === 0)
        ? `Đã xếp thành công toàn bộ ${totalPlaced} tiết vào thời khóa biểu!`
        : `Đã xếp ${totalPlaced} tiết. Còn ${totalUnplaced} tiết chưa thể xếp do ràng buộc quá chặt (ở mục Chưa phân).`;
    }

    if(typeof setStatus === "function") setStatus(finalMsg, totalUnplaced === 0 ? "ok" : "warning");
    else if(typeof _setStatus === "function") _setStatus(finalMsg, totalUnplaced === 0 ? "ok" : "warning");

    if(typeof finishAutoSortProgress === "function"){
      try{ finishAutoSortProgress("100%", "ok"); }catch(_){}
    }

    return { ok: true, placed: totalPlaced, unassigned: totalUnplaced };
  }catch(err){
    console.error("executeDirectFastSchedule error:", err);
    const errMsg = "Lỗi khi sắp xếp: " + (err?.message || err);
    if(typeof setStatus === "function") setStatus(errMsg, "error");
    else if(typeof _setStatus === "function") _setStatus(errMsg, "error");
    return { ok: false, error: err };
  }
}

try{
  window.executeDirectFastSchedule = executeDirectFastSchedule;
  window.sapXepTuDongAll = async function(options = {}){
    // 22/08 (chi dao chu du an, TRA LAI nhu ban dau): nut ▶ Sap xep = CHI
    // thuat toan FET chay trong trinh duyet (worker `solve`, mode "auto"),
    // muc dich la KIEM TRA XEP DU HAY KHONG: bao "Da xep xong X/Y tiet" + ly
    // do thieu (thieu o, GV qua tai, tiet doi vuot gioi han...). KHONG doi
    // sang mode "xep + toi uu tron goi", KHONG goi backend CP-SAT/Cloud Run,
    // KHONG noi chuoi hau ky (da go ngay 22/08). Toi uu giao vien la viec
    // cua nut Cherry / Toi uu v3.
    return await executeDirectFastSchedule({ mode: options?.mode || "auto" });
  };
}catch(_){}

async function sapXepTuDongAll(options = {}){
  return await executeDirectFastSchedule({ mode: options?.mode || "auto" });
}


function countMon(mon){
  return countMonInTKB(DATA.tkb[currentLop], mon);
}

function calcClassTKBPeriodStats(classId){
  const id = (classId || "").toString();
  if(!id) return {total:0, assigned:0, missing:0};

  const lop = (DATA.lop||[]).find(x=>String(x.id) === id);
  const classCanon = getLopCanonById(id);
  const tkb = DATA.tkb?.[id];
  const tkbMonCounts = buildTkbMonCountMap(tkb);
  const mons = requiredSubjectsForClass(lop || {id});

  let total = 0;
  let assigned = 0;
  for(const m of mons){
    const monName = (m?.mon || m?.ten || "").toString().trim();
    const req = Number(m?.required ?? m?.sotiet ?? 0);
    if(!monName || !Number.isFinite(req) || req <= 0) continue;
    if(!teacherListFromValue(
      classAssignmentStatisticsTeacherForClassMon(classCanon, monName)
    ).length && !tkbIsNoTeacherGhep(classCanon, monName)) continue;   // 02/09: tiết ghép không GV vẫn là tiết của lớp
    const used = countMonFromTkbCountMap(tkbMonCounts, monName);
    total += req;
    assigned += Math.min(req, Math.max(0, used));
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

/* 22/08 (yeu cau chu du an): tiet khong xep duoc vi rang buoc thi DUA VE
   "Chua phan" KEM LY DO + HUONG XU LY, thay vi chi bao "Chua xep du".
   Ma ly do do bo giai tra ve trong tkbSolverResult.unassignedLessons[].reason
   (solver_runtime/src/tkb_new/adapter.py, tkb_engine_v3/entry.py). */
window.TKB_UNASSIGNED_REASON_INFO = {
  not_enough_available_slots: {
    label: "Thiếu chỗ xếp (GV hết ô trống)",
    hint: "GV không còn ô trống hợp lệ sau khi áp dụng tiết nghỉ và ràng buộc. Hướng xử lý: bớt tiết nghỉ của GV, cho phép dạy thêm buổi, hoặc chuyển bớt tiết sang GV khác."
  },
  not_enough_class_slots: {
    label: "Thiếu chỗ xếp (lớp hết ô học)",
    hint: "Lớp không còn ô học trống (ô Nghỉ/OFF hoặc tiết cố định chiếm hết). Hướng xử lý: mở thêm ô học cho lớp hoặc giảm số tiết/tuần của môn."
  },
  engine_v3_best_effort: {
    label: "Hết thời gian, chưa xếp được (không vi phạm ràng buộc)",
    hint: "Bấm Cherry lần nữa để xếp tiếp từ lịch hiện tại; nếu vẫn còn, nới ràng buộc của môn/GV liên quan (tiết đôi, tránh tiết 2–3, giới hạn môn/buổi, lịch nghỉ)."
  },
  period_best_effort_failed_session: {
    label: "Không còn ô hợp lệ trong buổi",
    hint: "Kiểm tra giới hạn tiết/buổi của môn và lịch nghỉ của GV trong buổi đó; nới bớt rồi bấm xếp lại."
  },
  constraint_violation: {
    label: "Gỡ ra vì vi phạm ràng buộc",
    hint: "Xếp vào sẽ vi phạm ràng buộc nên tiết được đưa về Chưa phân. Hướng xử lý: nới ràng buộc tương ứng hoặc kéo thả vào ô hợp lệ."
  },
  // 22/08 (toi): Cherry da toi uu het muc ma GV van con buoi 1 tiet / trong >=2
  // -> tiet gay ra duoc dua ve Chua phan; `message` cua bo giai mang goi y
  // cu the (GV nghi nhieu, mon cam buoi, GV chi 1 tiet/tuan...).
  teacher_quality_unreachable: {
    label: "Đưa ra để GV không còn buổi 1 tiết / trống ≥2",
    hint: "Cherry đã thử hết cách mà tiết này vẫn làm GV có buổi 1 tiết hoặc trống ≥2 tiết. Hướng xử lý: làm theo gợi ý ở từng tiết (nới lịch nghỉ/ràng buộc, đổi GV), hoặc kéo tiết vào cạnh một buổi đã có tiết của GV rồi Cố định ô đó và bấm Cherry lại."
  }
};
window.TKB_UNASSIGNED_REASON_DEFAULT = {
  label: "Chưa xếp được",
  hint: "Kéo thả thủ công vào ô hợp lệ, hoặc bấm Cherry để xếp tiếp. Nếu không còn ô nào hợp lệ: nới lịch nghỉ/ràng buộc của GV hoặc môn liên quan."
};

function tkbUnassignedReasonInfo(reason, message){
  const code = String(reason || "").trim();
  const table = window.TKB_UNASSIGNED_REASON_INFO || {};
  let info = table[code] || null;
  // adapter dung chung ma not_enough_available_slots cho ca GV lan LOP; phan
  // biet bang thong diep ("o hoc ... cua lop" = lop het o).
  if(code === "not_enough_available_slots" && /o hoc|ô học|cua lop|của lớp/i.test(String(message || ""))){
    info = table.not_enough_class_slots || info;
  }
  if(code === "teacher_quality_unreachable" && info){
    // Goi y cu the cua bo giai cho TUNG tiet (co dau tieng Viet) di truoc,
    // huong xu ly chung di sau.
    const specific = String(message || "").trim();
    if(specific) return {label: info.label, hint: `${specific} ${info.hint}`.trim(), specific};
  }
  if(info) return info;
  const fallback = window.TKB_UNASSIGNED_REASON_DEFAULT || {label: "Chưa xếp được", hint: ""};
  return code ? {label: `${fallback.label} (${code})`, hint: fallback.hint} : fallback;
}
window.tkbUnassignedReasonInfo = tkbUnassignedReasonInfo;

function tkbUnassignedItemsFor(classId, mon, itemsOverride){
  try{
    const items = Array.isArray(itemsOverride) ? itemsOverride : DATA?.tkbSolverResult?.unassignedLessons;
    if(!Array.isArray(items) || !items.length) return [];
    const norm = v => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();
    const cid = String(classId || "");
    const canon = norm(getLopCanonById(cid) || "");
    const monN = norm(mon);
    const monShort = norm(typeof getMonShort === "function" ? getMonShort(mon) : "");
    return items.filter(u => {
      if(!u || typeof u !== "object") return false;
      const sameClass = String(u.classId || "") === cid
        || norm(u.className) === canon
        || norm(u.classId) === canon;
      if(!sameClass) return false;
      const subj = norm(u.subject);
      return subj === monN || (monShort && subj === monShort)
        || (typeof getMonShort === "function" && norm(getMonShort(u.subject)) === monN);
    });
  }catch(_){
    return [];
  }
}

function tkbUnassignedReasonFor(classId, mon){
  try{
    const hits = tkbUnassignedItemsFor(classId, mon);
    if(!hits.length) return null;
    const first = hits[0];
    const info = tkbUnassignedReasonInfo(first.reason, first.message);
    let periods = 0;
    hits.forEach(u => { periods += Math.max(1, Math.round(Number(u.periods ?? u.count) || 1)); });
    return {reason: String(first.reason || ""), label: info.label, hint: info.hint, periods, teacher: String(first.teacher || "")};
  }catch(_){
    return null;
  }
}

function unassignedDropdownHTML(){
  // Nướng sẵn trạng thái mở + NỘI DUNG gần nhất vào markup: bar bị dựng lại
  // sau mỗi re-render còn loadMonList chạy sau ~120ms; nếu render menu đóng
  // hoặc rỗng thì danh sách xổ ra chớp tắt trong khoảng đó.
  const open = TKB_UNASSIGNED_MENU_OPEN === true;
  return `<div id="unassignedBar" class="unassigned-dropdown${open ? " is-open" : ""}" aria-label="Chưa phân">
    <button id="unassignedToggle" class="unassigned-dropdown-btn" type="button" onclick="toggleUnassignedDropdown(event)" aria-expanded="${open ? "true" : "false"}"${TKB_UNASSIGNED_BTN_DISABLED ? " disabled" : ""}>
      <span id="unassignedSummary">${escapeHtml(TKB_UNASSIGNED_SUMMARY_TEXT || "Chưa phân:0")}</span>
      <span class="unassigned-caret">v</span>
    </button>
    <div id="monList" class="unassigned-menu"${open ? "" : " hidden"}>${open ? TKB_UNASSIGNED_MENU_HTML : ""}</div>
  </div>`;
}

// Trang thai mo mong muon: song sot qua cac lan re-render (moi luot tha tiet
// deu dung lai #unassignedBar) de nguoi dung keo nhieu tiet lien tiep.
let TKB_UNASSIGNED_MENU_OPEN = false;
// Snapshot noi dung menu + summary cua lan loadMonList gan nhat. Bar bi dung
// lai boi renderTKB roi loadMonList moi chay sau ~120ms (scheduleLoadMonList):
// neu render menu rong thi hop xo ra "chop" mat noi dung trong khoang do.
// Nuong lai noi dung cu => nhin lien mach; loadMonList thay bang ban moi
// (kem handler) ngay sau do.
let TKB_UNASSIGNED_MENU_HTML = "";
let TKB_UNASSIGNED_SUMMARY_TEXT = "Chưa phân:0";
let TKB_UNASSIGNED_BTN_DISABLED = true;

function setUnassignedDropdownOpen(open){
  const root = document.getElementById("unassignedBar");
  const btn = document.getElementById("unassignedToggle");
  const menu = document.getElementById("monList");
  if(!root || !btn || !menu) return;
  const shouldOpen = !!open && !btn.disabled;
  TKB_UNASSIGNED_MENU_OPEN = shouldOpen;
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
    // môn theo đúng thứ tự bảng "Môn học" trong phần app
    const m = compareMonByMonHocOrder(a.mon,b.mon);
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

      const monShort = tkbMonLabel(t.classId, t.mon);
      const gvTxt = (t.gv||"").toString().trim();
      const roomTxt = (t.room||"").toString().trim();
      const roomDisp = roomTxt ? ` (${roomTxt})` : "";
      const remainDisp = Number(t.remain || 0) > 1 ? ` x${Number(t.remain || 0)}` : "";
      const gvPart = gvTxt ? ` - ${escapeHtml(gvTxt)}` : "";

      d.innerHTML = `<span class="mon-item-main">${escapeHtml(monShort)}${gvPart}${escapeHtml(remainDisp)}</span>`+
                    `<span class="mon-item-meta">${escapeHtml(roomDisp)}</span>`;
      // 22/08: ly do bo giai dua tiet nay ve Chua phan + huong xu ly (tooltip).
      try{
        const why = (typeof tkbUnassignedReasonFor === "function") ? tkbUnassignedReasonFor(t.classId, t.mon) : null;
        const fallbackWhy = (typeof tkbUnassignedReasonInfo === "function") ? tkbUnassignedReasonInfo("", "") : null;
        const info = why || fallbackWhy;
        if(info){
          d.title = `${info.label} — ${info.hint}`;
        }
        if(why){
          const note = document.createElement("div");
          note.className = "mon-item-why";
          note.style.cssText = "flex-basis:100%;width:100%;font-size:11px;color:#b45309;line-height:1.3;margin-top:2px;white-space:normal;";
          note.textContent = `⚠ ${why.label}`;
          note.title = why.hint;
          d.style.flexWrap = "wrap"; // .mon-item la flex row -> cho dong ly do xuong hang
          d.appendChild(note);
        }
      }catch(_){ }
      d.onclick = ()=>{
        // Giong co che pane GV: chi DIEU HUONG (dua GV cua tiet nay xuong bang
        // duoi), khong xep + khoa tiet vao TKB nua, va giu menu mo de keo tiep.
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

  // Bar vua duoc dung lai (mac dinh dong): khoi phuc trang thai mo truoc do
  // de sau moi luot tha tiet menu van mo cho nguoi dung keo tiep.
  if(TKB_UNASSIGNED_MENU_OPEN) setUnassignedDropdownOpen(true);

  // Snapshot de lan dung lai bar ke tiep render san noi dung (chong chop tat).
  try{
    TKB_UNASSIGNED_MENU_HTML = box.innerHTML;
    const summaryEl = document.getElementById("unassignedSummary");
    if(summaryEl) TKB_UNASSIGNED_SUMMARY_TEXT = summaryEl.textContent || "Chưa phân:0";
    TKB_UNASSIGNED_BTN_DISABLED = !!document.getElementById("unassignedToggle")?.disabled;
  }catch(_){ }

  // The full-school teacher statistics live inside a popover and can be
  // expensive on a large timetable. Opening the popover renders on demand.
  const statsPopover = document.getElementById("statsPopover");
  if(statsPopover && !statsPopover.hidden) scheduleStatsBoxRender({onlyIfOpen:true});
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

    const monShort = tkbMonLabel(t.classId, t.mon);
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
  const cacheSignature = arguments[0];
  const cacheSig = String(cacheSignature || schoolStatsTkbSignature());
  const statsCache = window.__TKB_STUDENT_TKB_GAP_STATS_CACHE || {sig:"", value:null};
  if(statsCache.sig === cacheSig && statsCache.value){
    return statsCache.value;
  }
  let totalGaps = 0;
  const byClass = [];
  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];

  const isStudentGapSlot = (v)=>{
    if(v === "OFF") return false;
    return !cellMon(v);
  };

  for(const lop of lops){
    const classId = lop?.id;
    const classCanon = getLopCanonById(classId) || lop?.ten || lop?.ten2 || classId;
    const tkb = (classId ? DATA.tkb?.[classId] : null)
      || (classCanon ? DATA.tkb?.[classCanon] : null)
      || (lop?.ten ? DATA.tkb?.[lop.ten] : null)
      || (lop?.ten2 ? DATA.tkb?.[lop.ten2] : null);
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
        name: (lop?.ten || lop?.ten2 || classCanon || classId || "").toString().trim(),
        gaps: classGaps,
        sessions
      });
      totalGaps += classGaps;
    }
  }

  byClass.sort((a,b)=>Number(b.gaps||0)-Number(a.gaps||0) || String(a.name||"").localeCompare(String(b.name||""), "vi"));
  const result = {totalGaps, byClass};
  window.__TKB_STUDENT_TKB_GAP_STATS_CACHE = {sig:cacheSig, value:result};
  return result;
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

const CLASS_ASSIGNMENT_STATS_MODAL_ID = "classAssignmentStatsModal";

function classAssignmentStatisticsSubjectMeta(mon){
  const raw = String(mon || "").trim();
  if(!raw) return null;
  const key = monCanonicalKey(raw) || normKey(raw);
  if(!key) return null;
  const record = findMonHoc(raw);
  const fullName = String(record?.ten || raw).trim() || raw;
  const label = String(getMonShort(raw) || raw).trim() || raw;
  return {key, label, fullName, source:raw};
}

let CLASS_ASSIGNMENT_TEACHER_CACHE = {
  pccmRef: null,
  monRef: null,
  monhocRef: null,
  lopRef: null,
  values: new Map()
};

function ensureClassAssignmentTeacherCache(){
  if(CLASS_ASSIGNMENT_TEACHER_CACHE.pccmRef === DATA.pccmMatrix &&
     CLASS_ASSIGNMENT_TEACHER_CACHE.monRef === DATA.mon &&
     CLASS_ASSIGNMENT_TEACHER_CACHE.monhocRef === DATA.monhoc &&
     CLASS_ASSIGNMENT_TEACHER_CACHE.lopRef === DATA.lop){
    return CLASS_ASSIGNMENT_TEACHER_CACHE.values;
  }
  CLASS_ASSIGNMENT_TEACHER_CACHE = {
    pccmRef: DATA.pccmMatrix,
    monRef: DATA.mon,
    monhocRef: DATA.monhoc,
    lopRef: DATA.lop,
    values: new Map()
  };
  return CLASS_ASSIGNMENT_TEACHER_CACHE.values;
}

/* 04/09: chi muc PCCM theo KHOA CHUAN HOA (lop + mon canonical).
   Tra cuu ben duoi so khop CHUOI CHINH XAC, nen mot phan cong nhap lech chu
   hoa/thuong so voi bang Mon hoc (vi du ma mon "TIN" trong khi Mon hoc ghi
   "Tin") khong bao gio khop. Hau qua: buildClassAssignmentStatistics bo han
   mon do khoi tong tiet cua lop, con calcTeacherTKBStats mat luon cac tiet ay
   nen bao NHAM "day 1 tiet" cho GV day nhieu mon (do 04/09 tren THCS An Phu:
   CN.Ly day ca Tin lan Cong nghe -> 3 buoi 2 tiet bi dem con 1). Bo giai von
   khop khong phan biet hoa/thuong nen van xep du tiet; chi thong ke tren
   trinh duyet lech. Chi muc nay la duong lui, dung dung ngu nghia
   monCanonicalKey (giong monMatches) nen khong the ghep nham hai mon khac. */
function ensureClassAssignmentTeacherCanonIndex(){
  ensureClassAssignmentTeacherCache();
  if(CLASS_ASSIGNMENT_TEACHER_CACHE.canonical){
    return CLASS_ASSIGNMENT_TEACHER_CACHE.canonical;
  }
  const index = new Map();
  const pccm = DATA.pccmMatrix;
  if(pccm && typeof pccm === "object"){
    for(const rawKey of Object.keys(pccm)){
      const value = String(pccm[rawKey] ?? "").trim();
      if(!value) continue;
      const key = String(rawKey);
      const sep = key.indexOf("|");
      if(sep < 0) continue;
      const classPart = key.slice(0, sep).trim();
      const monPart = key.slice(sep + 1).trim();
      if(!classPart || !monPart) continue;
      const clsKey = normKey(classPart);
      const monKey = monCanonicalKey(monPart);
      if(!clsKey || !monKey) continue;
      const canonKey = clsKey + "|" + monKey;
      if(!index.has(canonKey)) index.set(canonKey, value);
    }
  }
  CLASS_ASSIGNMENT_TEACHER_CACHE.canonical = index;
  return index;
}

function classAssignmentStatisticsTeacherForClassMon(classCanon, mon){
  const cls = String(classCanon || "").trim();
  const rawMon = String(mon || "").trim();
  if(!cls || !rawMon) return "";
  const cache = ensureClassAssignmentTeacherCache();
  const cacheKey = `${cls}|${rawMon}`;
  if(cache.has(cacheKey)) return cache.get(cacheKey);
  const mh = findMonHoc(rawMon);
  const subjects = [];
  const addSubject = value=>{
    const text = String(value || "").trim();
    if(text && !subjects.includes(text)) subjects.push(text);
  };
  addSubject(rawMon);
  [mh?.ten, mh?.ma, mh?.ma2, mh?.id].forEach(addSubject);
  const classKeys = classKeyCandidates(cls);
  for(const classKey of classKeys){
    for(const subject of subjects){
      const value = DATA.pccmMatrix?.[classKey + "|" + subject];
      if(value != null && String(value).trim()){
        const result = String(value).trim();
        cache.set(cacheKey, result);
        return result;
      }
    }
  }
  // Duong lui: khop theo khoa chuan hoa (bo qua chu hoa/thuong va bi danh).
  const monKey = monCanonicalKey(rawMon);
  if(monKey){
    const canonIndex = ensureClassAssignmentTeacherCanonIndex();
    for(const classKey of classKeys){
      const hit = canonIndex.get(normKey(classKey) + "|" + monKey);
      if(hit){
        cache.set(cacheKey, hit);
        return hit;
      }
    }
  }
  cache.set(cacheKey, "");
  return "";
}

function classAssignmentStatisticsPeriodForClassMon(lop, classCanon, mon, fallback){
  const override = Number(getSoTietForClassMon(classCanon, mon) || 0);
  if(Number.isFinite(override) && override > 0) return Math.round(override);
  const grade = extractKhoiNumber(lop?.khoi) || extractKhoiNumber(lop?.ten2) || extractKhoiNumber(lop?.ten) || "";
  const standard = _findTietChuanRow(grade, mon);
  const value = Number(standard?.sotiet ?? fallback ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function buildClassAssignmentStatistics(){
  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];
  const subjectCatalog = new Map();
  const rows = lops.map((lop, index)=>{
    const classId = String(lop?.id || "").trim();
    const classCanon = classId ? getLopCanonById(classId) : "";
    const className = String(classCanon || classCanonFromLop(lop) || lop?.ten2 || lop?.ten || classId).trim();
    const grade = String(
      extractKhoiNumber(lop?.khoi)
      || extractKhoiNumber(lop?.ten2)
      || extractKhoiNumber(lop?.ten)
      || ""
    );
    const bySubject = new Map();

    const addSubject = (mon, fallbackPeriods)=>{
      const raw = String(mon || "").trim();
      if(!raw) return;
      const meta = classAssignmentStatisticsSubjectMeta(raw);
      if(!meta) return;
      const periods = classAssignmentStatisticsPeriodForClassMon(lop, classCanon, raw, fallbackPeriods);
      if(!(periods > 0)) return;
      const teacherRaw = classAssignmentStatisticsTeacherForClassMon(classCanon, raw);
      // A subject without a PCCM teacher is not an assigned period and must
      // stay out of both the subject total and the class total.
      // 02/09: trừ tiết dạy ghép KHÔNG giáo viên — vẫn là tiết của lớp (đếm vào tổng).
      if(!teacherListFromValue(teacherRaw).length && !tkbIsNoTeacherGhep(classCanon, raw)) return;
      const current = bySubject.get(meta.key);
      if(!current || periods > current.periods){
        bySubject.set(meta.key, {meta, periods, teacherRaw});
      }else if(!current.teacherRaw && teacherRaw){
        current.teacherRaw = teacherRaw;
      }
      if(!subjectCatalog.has(meta.key)) subjectCatalog.set(meta.key, meta);
    };

    (DATA.mon || []).forEach(standard=>{
      const standardGrade = extractKhoiNumber(standard?.khoi);
      if(String(standardGrade || "") !== grade) return;
      addSubject(standard?.ten, standard?.sotiet);
    });
    _collectPCCMSubjectKeysForClass(classCanon).forEach(monKey=>addSubject(monKey, 0));

    const subjectPeriods = Object.create(null);
    let singlePeriods = 0;
    let combinedPeriods = 0;
    bySubject.forEach(item=>{
      subjectPeriods[item.meta.key] = item.periods;
      const teachers = teacherListFromValue(item.teacherRaw);
      if(teachers.length > 1) combinedPeriods += item.periods;
      else singlePeriods += item.periods;
    });

    const tkb = DATA.tkb?.[classId] || {};
    let daXep = 0;
    let oTrong = 0;
    const days = Array.isArray(DAYS) ? DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];
    for(const d of days){
      for(const buoi of ["sang", "chieu"]){
        const arr = tkb?.[d]?.[buoi] || [];
        for(let ti = 0; ti < 5; ti++){
          const v = arr[ti];
          if(!v || v === ""){
            oTrong++;
          }else if(v === "OFF"){
            // OFF slot
          }else{
            daXep++;
          }
        }
      }
    }
    const totalPeriods = singlePeriods + combinedPeriods;
    const chuaXep = Math.max(0, totalPeriods - daXep);

    return {
      index:index + 1,
      classId,
      className,
      grade,
      singlePeriods,
      combinedPeriods,
      totalPeriods,
      daXep,
      chuaXep,
      oTrong,
      subjectPeriods
    };
  });

  const subjects = [];
  const added = new Set();
  const addSubjectToOrder = value=>{
    const meta = classAssignmentStatisticsSubjectMeta(value);
    if(!meta || added.has(meta.key) || !subjectCatalog.has(meta.key)) return;
    added.add(meta.key);
    subjects.push(subjectCatalog.get(meta.key));
  };
  (Array.isArray(DATA.monhoc) ? DATA.monhoc : []).forEach(record=>{
    [record?.ten, record?.ma, record?.ma2, record?.id].forEach(addSubjectToOrder);
  });
  Array.from(subjectCatalog.values())
    .filter(meta=>!added.has(meta.key))
    .sort((a,b)=>compareMonByHiddenCode(a.source, b.source))
    .forEach(meta=>{
      added.add(meta.key);
      subjects.push(meta);
    });
  return {subjects, rows};
}

function renderClassAssignmentStatisticsTable(model){
  const subjects = Array.isArray(model?.subjects) ? model.subjects : [];
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  if(!rows.length){
    return '<div class="class-assignment-stats-empty">Chưa có dữ liệu lớp học để thống kê.</div>';
  }
  const html = [];
  html.push('<div class="class-assignment-stats-table-wrap"><table class="class-assignment-stats-table"><thead>');
  html.push('<tr>');
  html.push('<th class="class-stats-index-col" rowspan="2" scope="col">TT</th>');
  html.push('<th class="class-stats-class-col" rowspan="2" scope="col">Lớp học</th>');
  html.push('<th class="class-stats-total-group" colspan="3" scope="colgroup">Tổng số</th>');
  html.push('<th class="class-stats-status-group" colspan="3" scope="colgroup">Tình trạng xếp</th>');
  subjects.forEach(subject=>{
    html.push('<th class="class-stats-subject-col" rowspan="2" scope="col" title="'
      + escapeHtml(subject.fullName || subject.label || "") + '">'
      + escapeHtml(subject.label || subject.fullName || "") + '</th>');
  });
  html.push('</tr><tr>');
  html.push('<th scope="col">Tiết đơn</th><th scope="col">Tiết ghép</th>');
  html.push('<th class="class-stats-total-col" scope="col">Cộng</th>');
  html.push('<th class="class-stats-placed-col" scope="col">Đã xếp</th>');
  html.push('<th class="class-stats-unassigned-col" scope="col">Chưa xếp</th>');
  html.push('<th class="class-stats-empty-col" scope="col">Trống</th>');
  html.push('</tr></thead><tbody>');

  let sumSingle = 0;
  let sumCombined = 0;
  let sumTotal = 0;
  let sumDaXep = 0;
  let sumChuaXep = 0;
  let sumTrong = 0;
  const sumSubjects = Object.create(null);
  subjects.forEach(s => { sumSubjects[s.key] = 0; });

  rows.forEach((row, index)=>{
    sumSingle += Number(row.singlePeriods || 0);
    sumCombined += Number(row.combinedPeriods || 0);
    sumTotal += Number(row.totalPeriods || 0);
    sumDaXep += Number(row.daXep || 0);
    sumChuaXep += Number(row.chuaXep || 0);
    sumTrong += Number(row.oTrong || 0);

    const previousGrade = index > 0 ? String(rows[index - 1]?.grade || "") : "";
    const gradeStart = index > 0 && String(row?.grade || "") !== previousGrade;
    html.push('<tr' + (gradeStart ? ' class="class-stats-grade-start"' : "")
      + ' data-class-id="' + escapeHtml(row.classId || "") + '">');
    html.push('<td class="class-stats-index-col">' + escapeHtml(row.index) + '</td>');
    html.push('<th class="class-stats-class-col" scope="row">' + escapeHtml(row.className || row.classId || "") + '</th>');
    html.push('<td>' + escapeHtml(row.singlePeriods) + '</td>');
    html.push('<td>' + escapeHtml(row.combinedPeriods) + '</td>');
    html.push('<td class="class-stats-total-col">' + escapeHtml(row.totalPeriods) + '</td>');
    html.push('<td class="class-stats-placed-col">' + escapeHtml(row.daXep) + '</td>');
    html.push('<td class="class-stats-unassigned-col' + (row.chuaXep > 0 ? ' has-unassigned' : '') + '">' + escapeHtml(row.chuaXep) + '</td>');
    html.push('<td class="class-stats-empty-col">' + escapeHtml(row.oTrong) + '</td>');
    subjects.forEach(subject=>{
      const periods = Number(row.subjectPeriods?.[subject.key] || 0);
      sumSubjects[subject.key] = (sumSubjects[subject.key] || 0) + periods;
      html.push('<td data-subject-key="' + escapeHtml(subject.key || "")
        + '">' + (periods > 0 ? escapeHtml(Math.round(periods)) : "") + '</td>');
    });
    html.push('</tr>');
  });
  html.push('</tbody>');

  // Summary footer row across all classes
  html.push('<tfoot><tr class="class-stats-total-row">');
  html.push('<th class="class-stats-index-col" scope="row" colspan="2">Tổng cộng (' + rows.length + ' lớp)</th>');
  html.push('<td>' + escapeHtml(Math.round(sumSingle)) + '</td>');
  html.push('<td>' + escapeHtml(Math.round(sumCombined)) + '</td>');
  html.push('<td class="class-stats-total-col">' + escapeHtml(Math.round(sumTotal)) + '</td>');
  html.push('<td class="class-stats-placed-col">' + escapeHtml(Math.round(sumDaXep)) + '</td>');
  html.push('<td class="class-stats-unassigned-col' + (sumChuaXep > 0 ? ' has-unassigned' : '') + '">' + escapeHtml(Math.round(sumChuaXep)) + '</td>');
  html.push('<td class="class-stats-empty-col">' + escapeHtml(Math.round(sumTrong)) + '</td>');
  subjects.forEach(subject=>{
    const total = sumSubjects[subject.key] || 0;
    html.push('<td data-subject-key="' + escapeHtml(subject.key || "") + '">' + (total > 0 ? escapeHtml(Math.round(total)) : "") + '</td>');
  });
  html.push('</tr></tfoot>');

  html.push('</table></div>');
  return html.join("");
}

function closeClassAssignmentStatistics(){
  const modal = document.getElementById(CLASS_ASSIGNMENT_STATS_MODAL_ID);
  if(modal) modal.remove();
  document.body?.classList?.remove("class-assignment-stats-open");
}

function openClassAssignmentStatistics(){
  try{ closeStatsPopover(); }catch(_){ }
  try{ closePrintTKBMenu(); }catch(_){ }
  try{ closeTeacherAssignmentStatistics(); }catch(_){ }
  closeClassAssignmentStatistics();
  const model = buildClassAssignmentStatistics();
  const modal = document.createElement("div");
  modal.id = CLASS_ASSIGNMENT_STATS_MODAL_ID;
  modal.className = "class-assignment-stats-overlay";
  modal.innerHTML = '<section class="class-assignment-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="classAssignmentStatsTitle">'
    + '<header class="class-assignment-stats-header"><div>'
    + '<h2 id="classAssignmentStatsTitle">Thống kê theo lớp</h2>'
    + '<p>Tiết ghép là môn có từ 2 giáo viên; chỉ tính các môn đã có phân công giáo viên.</p>'
    + '</div><button type="button" class="class-assignment-stats-close" aria-label="Đóng thống kê">×</button></header>'
    + renderClassAssignmentStatisticsTable(model) + '</section>';
  document.body.appendChild(modal);
  document.body.classList.add("class-assignment-stats-open");
  modal.querySelector(".class-assignment-stats-close")?.addEventListener("click", closeClassAssignmentStatistics);
  modal.addEventListener("pointerdown", ev=>{
    if(ev.target === modal) closeClassAssignmentStatistics();
  });
  window.setTimeout(()=>modal.querySelector(".class-assignment-stats-close")?.focus(), 0);
  return model;
}

if(!window.__TKB_CLASS_ASSIGNMENT_STATS_BOUND){
  window.__TKB_CLASS_ASSIGNMENT_STATS_BOUND = true;
  document.addEventListener("keydown", ev=>{
    if(ev.key === "Escape" && document.getElementById(CLASS_ASSIGNMENT_STATS_MODAL_ID)){
      closeClassAssignmentStatistics();
    }
  });
}
window.buildClassAssignmentStatistics = buildClassAssignmentStatistics;
window.renderClassAssignmentStatisticsTable = renderClassAssignmentStatisticsTable;
window.openClassAssignmentStatistics = openClassAssignmentStatistics;
window.closeClassAssignmentStatistics = closeClassAssignmentStatistics;

/* ======================= THỐNG KÊ THEO GIÁO VIÊN (19/09) =======================
   Song song "Thống kê theo lớp": mỗi dòng = 1 GV đã phân công, cột môn = tổng
   tiết PCCM của GV đó, kèm đã xếp / chưa xếp / buổi dạy / 1 tiết / trống.
============================================================================= */
const TEACHER_ASSIGNMENT_STATS_MODAL_ID = "teacherAssignmentStatsModal";

function buildTeacherAssignmentStatistics(){
  const subjectCatalog = new Map();
  const byTeacher = new Map();

  const ensureTeacher = (code)=>{
    const key = resolveTeacherCode(code) || String(code || "").trim();
    if(!key) return null;
    if(!byTeacher.has(key)){
      byTeacher.set(key, {
        code:key,
        name:getTeacherNameByCode(key) || key,
        subjectPeriods:Object.create(null),
        totalPeriods:0,
        classKeys:new Set()
      });
    }
    return byTeacher.get(key);
  };

  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];
  lops.forEach(lop=>{
    const classId = String(lop?.id || "").trim();
    const classCanon = classId ? getLopCanonById(classId) : "";
    if(!classCanon) return;
    const grade = String(
      extractKhoiNumber(lop?.khoi)
      || extractKhoiNumber(lop?.ten2)
      || extractKhoiNumber(lop?.ten)
      || ""
    );
    const seen = new Set();
    const consider = (mon, fallbackPeriods)=>{
      const raw = String(mon || "").trim();
      if(!raw) return;
      const meta = classAssignmentStatisticsSubjectMeta(raw);
      if(!meta || seen.has(meta.key)) return;
      const periods = classAssignmentStatisticsPeriodForClassMon(lop, classCanon, raw, fallbackPeriods);
      if(!(periods > 0)) return;
      const teacherRaw = classAssignmentStatisticsTeacherForClassMon(classCanon, raw);
      const teachers = teacherListFromValue(teacherRaw);
      if(!teachers.length){
        if(tkbIsNoTeacherGhep(classCanon, raw)) return;
        return;
      }
      seen.add(meta.key);
      if(!subjectCatalog.has(meta.key)) subjectCatalog.set(meta.key, meta);
      // Nhiều GV cùng ô (dạy ghép): mỗi người đếm đủ số tiết của dòng.
      teachers.forEach(code=>{
        const row = ensureTeacher(code);
        if(!row) return;
        row.subjectPeriods[meta.key] = (row.subjectPeriods[meta.key] || 0) + periods;
        row.totalPeriods += periods;
        row.classKeys.add(classCanon);
      });
    };
    (DATA.mon || []).forEach(standard=>{
      const standardGrade = extractKhoiNumber(standard?.khoi);
      if(String(standardGrade || "") !== grade) return;
      consider(standard?.ten, standard?.sotiet);
    });
    _collectPCCMSubjectKeysForClass(classCanon).forEach(monKey=>consider(monKey, 0));
  });

  // Đếm đã xếp trên TKB theo GV (cùng cách calcTeacherTKBStats).
  const placedByTeacher = new Map();
  const bumpPlaced = (code)=>{
    const key = resolveTeacherCode(code) || String(code || "").trim();
    if(!key) return;
    placedByTeacher.set(key, (placedByTeacher.get(key) || 0) + 1);
    ensureTeacher(key);
  };
  const days = Array.isArray(DAYS) ? DAYS : ["thu2","thu3","thu4","thu5","thu6","thu7"];
  lops.forEach(lop=>{
    const classId = lop?.id;
    const tkb = DATA.tkb?.[classId];
    if(!tkb) return;
    const classCanon = getLopCanonById(classId);
    days.forEach(d=>{
      ["sang","chieu"].forEach(buoi=>{
        const arr = tkb?.[d]?.[buoi] || [];
        for(let i = 0; i < arr.length; i++){
          const v = arr[i];
          if(!v || v === "OFF") continue;
          const mon = cellMon(v);
          if(!mon) continue;
          let teachers = [];
          if(typeof v === "object" && v.gv) teachers = teacherListFromValue(v.gv);
          else if(cellLegacyTeacher(v, classCanon)) teachers = teacherListFromValue(cellLegacyTeacher(v, classCanon));
          if(!teachers.length){
            teachers = teacherListFromValue(
              classAssignmentStatisticsTeacherForClassMon(classCanon, mon)
            );
          }
          teachers.forEach(bumpPlaced);
        }
      });
    });
  });

  const quality = calcTeacherTKBStats();
  const oneMap = new Map((quality.onePeriodTeachers || []).map(t => [String(t.code), Number(t.count || t.sessions?.length || 0)]));
  const gap1Map = new Map((quality.gap1Teachers || []).map(t => [String(t.code), Number(t.count || 0)]));
  const gap2Map = new Map((quality.gap2Teachers || []).map(t => [String(t.code), Number(t.count || 0)]));

  // Buổi dạy từng GV: tái dùng occ từ calcTeacherTKBStats quá nặng — ước từ
  // quality tổng không tách được. Tính nhanh lại chỉ số buổi / GV.
  const sessionByTeacher = new Map();
  {
    const occ = {};
    const ensureOcc = (raw)=>{
      const key = resolveTeacherCode(raw) || String(raw || "").trim();
      if(!key) return null;
      if(!occ[key]){
        occ[key] = {};
        days.forEach(d=>{
          occ[key][d] = {sang:Array.from({length:5},()=>false), chieu:Array.from({length:5},()=>false)};
        });
      }
      return occ[key];
    };
    lops.forEach(lop=>{
      const classId = lop?.id;
      const tkb = DATA.tkb?.[classId];
      if(!tkb) return;
      const classCanon = getLopCanonById(classId);
      days.forEach(d=>{
        ["sang","chieu"].forEach(buoi=>{
          const arr = tkb?.[d]?.[buoi] || [];
          for(let i = 0; i < arr.length; i++){
            const v = arr[i];
            if(!v || v === "OFF") continue;
            const mon = cellMon(v);
            if(!mon) continue;
            let teachers = [];
            if(typeof v === "object" && v.gv) teachers = teacherListFromValue(v.gv);
            else if(cellLegacyTeacher(v, classCanon)) teachers = teacherListFromValue(cellLegacyTeacher(v, classCanon));
            if(!teachers.length){
              teachers = teacherListFromValue(
                classAssignmentStatisticsTeacherForClassMon(classCanon, mon)
              );
            }
            teachers.forEach(code=>{
              const obj = ensureOcc(code);
              if(obj) obj[d][buoi][i] = true;
            });
          }
        });
      });
    });
    Object.keys(occ).forEach(code=>{
      let sessions = 0;
      days.forEach(d=>{
        ["sang","chieu"].forEach(buoi=>{
          if((occ[code][d][buoi] || []).some(Boolean)) sessions++;
        });
      });
      sessionByTeacher.set(code, sessions);
    });
  }

  const subjects = [];
  const added = new Set();
  const addSubjectToOrder = value=>{
    const meta = classAssignmentStatisticsSubjectMeta(value);
    if(!meta || added.has(meta.key) || !subjectCatalog.has(meta.key)) return;
    added.add(meta.key);
    subjects.push(subjectCatalog.get(meta.key));
  };
  (Array.isArray(DATA.monhoc) ? DATA.monhoc : []).forEach(record=>{
    [record?.ten, record?.ma, record?.ma2, record?.id].forEach(addSubjectToOrder);
  });
  Array.from(subjectCatalog.values())
    .filter(meta=>!added.has(meta.key))
    .sort((a,b)=>compareMonByHiddenCode(a.source, b.source))
    .forEach(meta=>{
      added.add(meta.key);
      subjects.push(meta);
    });

  const rows = Array.from(byTeacher.values())
    .sort((a,b)=>compareTeacherCodeByDataOrder(a.code, b.code))
    .map((row, index)=>{
      const daXep = Math.max(0, Number(placedByTeacher.get(row.code) || 0));
      const chuaXep = Math.max(0, row.totalPeriods - daXep);
      return {
        index:index + 1,
        code:row.code,
        name:row.name,
        totalPeriods:row.totalPeriods,
        daXep,
        chuaXep,
        sessions:Math.max(0, Number(sessionByTeacher.get(row.code) || 0)),
        onePeriod:Math.max(0, Number(oneMap.get(row.code) || 0)),
        gap1:Math.max(0, Number(gap1Map.get(row.code) || 0)),
        gap2:Math.max(0, Number(gap2Map.get(row.code) || 0)),
        classCount:row.classKeys.size,
        subjectPeriods:row.subjectPeriods
      };
    });

  return {subjects, rows};
}

function renderTeacherAssignmentStatisticsTable(model){
  const subjects = Array.isArray(model?.subjects) ? model.subjects : [];
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  if(!rows.length){
    return '<div class="class-assignment-stats-empty">Chưa có dữ liệu giáo viên để thống kê.</div>';
  }
  const html = [];
  html.push('<div class="class-assignment-stats-table-wrap"><table class="class-assignment-stats-table teacher-assignment-stats-table"><thead>');
  html.push('<tr>');
  html.push('<th class="class-stats-index-col" rowspan="2" scope="col">TT</th>');
  html.push('<th class="class-stats-class-col" rowspan="2" scope="col">Giáo viên</th>');
  html.push('<th class="class-stats-total-group" colspan="4" scope="colgroup">Tổng số</th>');
  html.push('<th class="class-stats-status-group" colspan="4" scope="colgroup">Chất lượng lịch</th>');
  subjects.forEach(subject=>{
    html.push('<th class="class-stats-subject-col" rowspan="2" scope="col" title="'
      + escapeHtml(subject.fullName || subject.label || "") + '">'
      + escapeHtml(subject.label || subject.fullName || "") + '</th>');
  });
  html.push('</tr><tr>');
  html.push('<th scope="col">Tiết PCCM</th>');
  html.push('<th class="class-stats-placed-col" scope="col">Đã xếp</th>');
  html.push('<th class="class-stats-unassigned-col" scope="col">Chưa xếp</th>');
  html.push('<th scope="col">Lớp</th>');
  html.push('<th scope="col">Buổi dạy</th>');
  html.push('<th scope="col">1 tiết/buổi</th>');
  html.push('<th scope="col">Trống 1</th>');
  html.push('<th scope="col">Trống ≥2</th>');
  html.push('</tr></thead><tbody>');

  let sumTotal = 0, sumDaXep = 0, sumChuaXep = 0, sumSessions = 0;
  let sumOne = 0, sumGap1 = 0, sumGap2 = 0, sumClasses = 0;
  const sumSubjects = Object.create(null);
  subjects.forEach(s => { sumSubjects[s.key] = 0; });

  rows.forEach(row=>{
    sumTotal += Number(row.totalPeriods || 0);
    sumDaXep += Number(row.daXep || 0);
    sumChuaXep += Number(row.chuaXep || 0);
    sumSessions += Number(row.sessions || 0);
    sumOne += Number(row.onePeriod || 0);
    sumGap1 += Number(row.gap1 || 0);
    sumGap2 += Number(row.gap2 || 0);
    sumClasses += Number(row.classCount || 0);
    html.push('<tr data-teacher-code="' + escapeHtml(row.code || "") + '">');
    html.push('<td class="class-stats-index-col">' + escapeHtml(row.index) + '</td>');
    html.push('<th class="class-stats-class-col" scope="row" title="'
      + escapeHtml(row.code || "") + '">'
      + escapeHtml(row.name || row.code || "") + '</th>');
    html.push('<td class="class-stats-total-col">' + escapeHtml(row.totalPeriods) + '</td>');
    html.push('<td class="class-stats-placed-col">' + escapeHtml(row.daXep) + '</td>');
    html.push('<td class="class-stats-unassigned-col' + (row.chuaXep > 0 ? ' has-unassigned' : '') + '">'
      + escapeHtml(row.chuaXep) + '</td>');
    html.push('<td>' + escapeHtml(row.classCount) + '</td>');
    html.push('<td>' + escapeHtml(row.sessions) + '</td>');
    html.push('<td' + (row.onePeriod > 0 ? ' class="has-unassigned"' : '') + '>'
      + escapeHtml(row.onePeriod) + '</td>');
    html.push('<td>' + escapeHtml(row.gap1) + '</td>');
    html.push('<td>' + escapeHtml(row.gap2) + '</td>');
    subjects.forEach(subject=>{
      const periods = Number(row.subjectPeriods?.[subject.key] || 0);
      sumSubjects[subject.key] = (sumSubjects[subject.key] || 0) + periods;
      html.push('<td data-subject-key="' + escapeHtml(subject.key || "")
        + '">' + (periods > 0 ? escapeHtml(Math.round(periods)) : "") + '</td>');
    });
    html.push('</tr>');
  });
  html.push('</tbody>');
  html.push('<tfoot><tr class="class-stats-total-row">');
  html.push('<th class="class-stats-index-col" scope="row" colspan="2">Tổng cộng (' + rows.length + ' GV)</th>');
  html.push('<td class="class-stats-total-col">' + escapeHtml(Math.round(sumTotal)) + '</td>');
  html.push('<td class="class-stats-placed-col">' + escapeHtml(Math.round(sumDaXep)) + '</td>');
  html.push('<td class="class-stats-unassigned-col' + (sumChuaXep > 0 ? ' has-unassigned' : '') + '">'
    + escapeHtml(Math.round(sumChuaXep)) + '</td>');
  html.push('<td>' + escapeHtml(Math.round(sumClasses)) + '</td>');
  html.push('<td>' + escapeHtml(Math.round(sumSessions)) + '</td>');
  html.push('<td' + (sumOne > 0 ? ' class="has-unassigned"' : '') + '>' + escapeHtml(Math.round(sumOne)) + '</td>');
  html.push('<td>' + escapeHtml(Math.round(sumGap1)) + '</td>');
  html.push('<td>' + escapeHtml(Math.round(sumGap2)) + '</td>');
  subjects.forEach(subject=>{
    const total = sumSubjects[subject.key] || 0;
    html.push('<td data-subject-key="' + escapeHtml(subject.key || "") + '">'
      + (total > 0 ? escapeHtml(Math.round(total)) : "") + '</td>');
  });
  html.push('</tr></tfoot></table></div>');
  return html.join("");
}

function closeTeacherAssignmentStatistics(){
  const modal = document.getElementById(TEACHER_ASSIGNMENT_STATS_MODAL_ID);
  if(modal) modal.remove();
  document.body?.classList?.remove("class-assignment-stats-open");
}

function openTeacherAssignmentStatistics(){
  try{ closeStatsPopover(); }catch(_){ }
  try{ closePrintTKBMenu(); }catch(_){ }
  try{ closeClassAssignmentStatistics(); }catch(_){ }
  closeTeacherAssignmentStatistics();
  const model = buildTeacherAssignmentStatistics();
  const modal = document.createElement("div");
  modal.id = TEACHER_ASSIGNMENT_STATS_MODAL_ID;
  modal.className = "class-assignment-stats-overlay";
  modal.innerHTML = '<section class="class-assignment-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="teacherAssignmentStatsTitle">'
    + '<header class="class-assignment-stats-header"><div>'
    + '<h2 id="teacherAssignmentStatsTitle">Thống kê theo giáo viên</h2>'
    + '<p>Tiết PCCM theo phân công; đã xếp đếm trên TKB. Dạy ghép nhiều GV: mỗi người được tính đủ số tiết của dòng.</p>'
    + '</div><button type="button" class="class-assignment-stats-close" aria-label="Đóng thống kê">×</button></header>'
    + renderTeacherAssignmentStatisticsTable(model) + '</section>';
  document.body.appendChild(modal);
  document.body.classList.add("class-assignment-stats-open");
  modal.querySelector(".class-assignment-stats-close")?.addEventListener("click", closeTeacherAssignmentStatistics);
  modal.addEventListener("pointerdown", ev=>{
    if(ev.target === modal) closeTeacherAssignmentStatistics();
  });
  window.setTimeout(()=>modal.querySelector(".class-assignment-stats-close")?.focus(), 0);
  return model;
}

if(!window.__TKB_TEACHER_ASSIGNMENT_STATS_BOUND){
  window.__TKB_TEACHER_ASSIGNMENT_STATS_BOUND = true;
  document.addEventListener("keydown", ev=>{
    if(ev.key === "Escape" && document.getElementById(TEACHER_ASSIGNMENT_STATS_MODAL_ID)){
      closeTeacherAssignmentStatistics();
    }
  });
}
window.buildTeacherAssignmentStatistics = buildTeacherAssignmentStatistics;
window.renderTeacherAssignmentStatisticsTable = renderTeacherAssignmentStatisticsTable;
window.openTeacherAssignmentStatistics = openTeacherAssignmentStatistics;
window.closeTeacherAssignmentStatistics = closeTeacherAssignmentStatistics;

/* ======================= TIÊN LƯỢNG GV / THỜI ĐIỂM (20/09) =======================
   Lưới Thứ × tiết (sáng/chiều) đếm số GV có mặt cùng lúc.
   - Đã xếp: đếm từ TKB hiện tại (như hình khi xếp xong).
   - Tiên lượng: phân bổ tiết PCCM đều trên các ô GV còn dạy được (trừ nghỉ),
     cộng ô cố định — ước lượng trước khi xếp xong, không phải kết quả cuối.
============================================================================= */
const TEACHER_SLOT_PRESENCE_MODAL_ID = "teacherSlotPresenceModal";

function teacherSlotPresenceKey(thu, buoi, ti){
  return String(thu) + "|" + String(buoi) + "|" + String(ti);
}

function buildTeacherSlotPresenceStatistics(){
  const days = Array.isArray(DAYS) ? DAYS.slice() : ["thu2","thu3","thu4","thu5","thu6","thu7"];
  const sangN = Math.max(0, Number(SANG) || 5);
  const chieuN = Math.max(0, Number(CHIEU) || 5);
  const emptyGrid = ()=>{
    const grid = Object.create(null);
    days.forEach(thu=>{
      grid[thu] = {sang: Array(sangN).fill(0), chieu: Array(chieuN).fill(0)};
    });
    return grid;
  };
  const actual = emptyGrid();
  const forecast = emptyGrid();
  const available = emptyGrid();

  // --- Đã xếp: mỗi ô = số GV khác nhau đang có tiết ---
  const actualSets = Object.create(null);
  const bumpActual = (thu, buoi, ti, code)=>{
    const key = teacherSlotPresenceKey(thu, buoi, ti);
    if(!actualSets[key]) actualSets[key] = new Set();
    actualSets[key].add(code);
  };
  const lops = Array.isArray(DATA.lop) ? DATA.lop : [];
  lops.forEach(lop=>{
    const classId = String(lop?.id || "").trim();
    if(!classId) return;
    const classCanon = getLopCanonById(classId) || classCanonFromLop(lop) || "";
    days.forEach(thu=>{
      ["sang","chieu"].forEach(buoi=>{
        const arr = DATA.tkb?.[classId]?.[thu]?.[buoi];
        if(!Array.isArray(arr)) return;
        arr.forEach((cell, ti)=>{
          if(cell == null || cell === "" || cell === "OFF") return;
          const mon = cellMon(cell);
          if(!mon) return;
          let teachers = [];
          try{
            const fromMatrix = typeof getTeacherForClassMon === "function"
              ? getTeacherForClassMon(classCanon, mon)
              : "";
            teachers = teacherListFromValue(fromMatrix);
          }catch(_){ teachers = []; }
          if(!teachers.length){
            const legacy = cellLegacyTeacher(cell, classCanon);
            if(legacy) teachers = teacherListFromValue(legacy);
          }
          teachers.forEach(raw=>{
            const code = resolveTeacherCode(raw) || String(raw || "").trim();
            if(code) bumpActual(thu, buoi, ti, code);
          });
        });
      });
    });
  });
  Object.keys(actualSets).forEach(key=>{
    const [thu, buoi, tiRaw] = key.split("|");
    const ti = Number(tiRaw);
    if(!actual[thu] || !actual[thu][buoi] || !Number.isFinite(ti)) return;
    actual[thu][buoi][ti] = actualSets[key].size;
  });

  // --- Tiên lượng: PCCM periods / ô cho phép + ô cố định ---
  const teacherPeriods = Object.create(null);
  lops.forEach(lop=>{
    const classId = String(lop?.id || "").trim();
    const classCanon = classId ? getLopCanonById(classId) : "";
    if(!classCanon) return;
    const grade = String(
      extractKhoiNumber(lop?.khoi)
      || extractKhoiNumber(lop?.ten2)
      || extractKhoiNumber(lop?.ten)
      || ""
    );
    const seen = new Set();
    const consider = (mon, fallbackPeriods)=>{
      const raw = String(mon || "").trim();
      if(!raw) return;
      const meta = classAssignmentStatisticsSubjectMeta(raw);
      if(!meta || seen.has(meta.key)) return;
      const periods = classAssignmentStatisticsPeriodForClassMon(lop, classCanon, raw, fallbackPeriods);
      if(!(periods > 0)) return;
      const teachers = teacherListFromValue(
        classAssignmentStatisticsTeacherForClassMon(classCanon, raw)
      );
      if(!teachers.length){
        if(typeof tkbIsNoTeacherGhep === "function" && tkbIsNoTeacherGhep(classCanon, raw)) return;
        return;
      }
      seen.add(meta.key);
      teachers.forEach(rawCode=>{
        const code = resolveTeacherCode(rawCode) || String(rawCode || "").trim();
        if(!code) return;
        teacherPeriods[code] = (teacherPeriods[code] || 0) + periods;
      });
    };
    (DATA.mon || []).forEach(standard=>{
      const standardGrade = extractKhoiNumber(standard?.khoi);
      if(String(standardGrade || "") !== grade) return;
      consider(standard?.ten, standard?.sotiet);
    });
    if(typeof _collectPCCMSubjectKeysForClass === "function"){
      _collectPCCMSubjectKeysForClass(classCanon).forEach(monKey=>consider(monKey, 0));
    }
  });

  const fixedByTeacher = Object.create(null);
  lops.forEach(lop=>{
    const classId = String(lop?.id || "").trim();
    if(!classId) return;
    const classCanon = getLopCanonById(classId) || "";
    days.forEach(thu=>{
      ["sang","chieu"].forEach(buoi=>{
        const arr = DATA.tkb?.[classId]?.[thu]?.[buoi];
        if(!Array.isArray(arr)) return;
        arr.forEach((cell, ti)=>{
          if(!cell || typeof cell !== "object" || cell.fixed !== true) return;
          const mon = cellMon(cell);
          if(!mon) return;
          const teachers = teacherListFromValue(
            typeof getTeacherForClassMon === "function"
              ? getTeacherForClassMon(classCanon, mon)
              : ""
          );
          teachers.forEach(raw=>{
            const code = resolveTeacherCode(raw) || String(raw || "").trim();
            if(!code) return;
            if(!fixedByTeacher[code]) fixedByTeacher[code] = new Set();
            fixedByTeacher[code].add(teacherSlotPresenceKey(thu, buoi, ti));
          });
        });
      });
    });
  });

  const allSlots = [];
  days.forEach(thu=>{
    for(let ti = 0; ti < sangN; ti++) allSlots.push({thu, buoi:"sang", ti});
    for(let ti = 0; ti < chieuN; ti++) allSlots.push({thu, buoi:"chieu", ti});
  });

  let periodMass = 0;
  Object.keys(teacherPeriods).forEach(code=>{
    const total = Math.max(0, Number(teacherPeriods[code]) || 0);
    if(!(total > 0)) return;
    periodMass += total;
    const allowed = allSlots.filter(slot=>{
      try{ return !isTeacherFixedOff(code, slot.thu, slot.buoi, slot.ti); }
      catch(_){ return true; }
    });
    allowed.forEach(slot=>{
      available[slot.thu][slot.buoi][slot.ti] += 1;
    });
    const fixedKeys = fixedByTeacher[code] || new Set();
    let remaining = total;
    fixedKeys.forEach(key=>{
      const [thu, buoi, tiRaw] = key.split("|");
      const ti = Number(tiRaw);
      if(forecast[thu] && forecast[thu][buoi] && Number.isFinite(ti)){
        forecast[thu][buoi][ti] += 1;
        remaining = Math.max(0, remaining - 1);
      }
    });
    const freeSlots = allowed.filter(slot => !fixedKeys.has(
      teacherSlotPresenceKey(slot.thu, slot.buoi, slot.ti)
    ));
    if(remaining > 0 && freeSlots.length > 0){
      // Kì vọng: mỗi ô nhận periods/ô_còn — không làm tròn từng ô (sẽ về 0
      // khi trường nhỏ). Làm tròn Hamilton bên dưới để tổng ≈ tổng tiết PCCM.
      const share = remaining / freeSlots.length;
      freeSlots.forEach(slot=>{
        forecast[slot.thu][slot.buoi][slot.ti] += share;
      });
    }
  });

  // Làm tròn Hamilton (largest remainder): giữ tổng số nguyên ≈ tổng tiết GV.
  const cells = [];
  days.forEach(thu=>{
    ["sang","chieu"].forEach(buoi=>{
      const arr = forecast[thu][buoi];
      for(let ti = 0; ti < arr.length; ti++){
        const raw = Number(arr[ti]) || 0;
        cells.push({thu, buoi, ti, raw, base: Math.floor(raw), frac: raw - Math.floor(raw)});
      }
    });
  });
  const targetTotal = Math.max(0, Math.round(periodMass));
  let assigned = cells.reduce((sum, cell) => sum + cell.base, 0);
  cells.sort((a, b)=>{
    if(b.frac !== a.frac) return b.frac - a.frac;
    if(a.thu !== b.thu) return String(a.thu).localeCompare(String(b.thu));
    if(a.buoi !== b.buoi) return a.buoi === "sang" ? -1 : 1;
    return a.ti - b.ti;
  });
  for(let i = 0; assigned < targetTotal && i < cells.length; i++){
    cells[i].base += 1;
    assigned += 1;
  }
  cells.forEach(cell=>{
    forecast[cell.thu][cell.buoi][cell.ti] = cell.base;
  });

  return {
    days,
    sangN,
    chieuN,
    actual,
    forecast,
    available,
    teacherCount: Object.keys(teacherPeriods).length,
    periodMass: targetTotal
  };
}

function renderTeacherSlotPresenceTable(model, mode){
  const view = mode === "actual" ? "actual" : "forecast";
  const grid = view === "actual" ? model.actual : model.forecast;
  const days = Array.isArray(model?.days) ? model.days : [];
  const sangN = Math.max(0, Number(model?.sangN) || 5);
  const chieuN = Math.max(0, Number(model?.chieuN) || 5);
  const html = [];
  html.push('<div class="class-assignment-stats-table-wrap teacher-slot-presence-wrap">');
  html.push('<table class="class-assignment-stats-table teacher-slot-presence-table"><thead><tr>');
  days.forEach(thu=>{
    html.push('<th scope="col">' + escapeHtml((LABEL && LABEL[thu]) || thu).toUpperCase() + '</th>');
  });
  html.push('</tr></thead><tbody>');
  const renderSession = (buoi, count, sessionClass)=>{
    for(let ti = 0; ti < count; ti++){
      html.push('<tr class="' + sessionClass + (ti === count - 1 && buoi === "sang" ? " teacher-slot-presence-session-end" : "") + '">');
      days.forEach(thu=>{
        const actual = Number(model.actual?.[thu]?.[buoi]?.[ti] || 0);
        const forecast = Number(model.forecast?.[thu]?.[buoi]?.[ti] || 0);
        const available = Number(model.available?.[thu]?.[buoi]?.[ti] || 0);
        const value = view === "actual" ? actual : forecast;
        const title = "Đã xếp: " + actual
          + " · Tiên lượng: " + forecast
          + " · GV còn có thể dạy ô này: " + available;
        html.push('<td title="' + escapeHtml(title) + '">'
          + (value > 0 ? escapeHtml(value) : "") + '</td>');
      });
      html.push('</tr>');
    }
  };
  renderSession("sang", sangN, "teacher-slot-presence-morning");
  renderSession("chieu", chieuN, "teacher-slot-presence-afternoon");
  html.push('</tbody></table></div>');
  return html.join("");
}

function closeTeacherSlotPresenceStatistics(){
  const modal = document.getElementById(TEACHER_SLOT_PRESENCE_MODAL_ID);
  if(modal) modal.remove();
  document.body?.classList?.remove("class-assignment-stats-open");
}

function openTeacherSlotPresenceStatistics(preferredMode){
  try{ closeStatsPopover(); }catch(_){ }
  try{ closePrintTKBMenu(); }catch(_){ }
  try{ closeClassAssignmentStatistics(); }catch(_){ }
  try{ closeTeacherAssignmentStatistics(); }catch(_){ }
  closeTeacherSlotPresenceStatistics();
  const model = buildTeacherSlotPresenceStatistics();
  const school = typeof calcSchoolTKBStats === "function" ? (calcSchoolTKBStats() || {}) : {};
  const hasUnassigned = Number(school.chuaXepTiet || 0) > 0;
  let mode = preferredMode === "actual" || preferredMode === "forecast"
    ? preferredMode
    : (hasUnassigned ? "forecast" : "actual");
  const modal = document.createElement("div");
  modal.id = TEACHER_SLOT_PRESENCE_MODAL_ID;
  modal.className = "class-assignment-stats-overlay";
  const renderBody = ()=>{
    const note = mode === "forecast"
      ? "Ước lượng từ phân công (PCCM) + nghỉ GV + ô cố định: chia đều tiết còn lại lên các ô GV còn dạy được, làm tròn giữ tổng tiết. Không phải lịch cuối — chỉ để đoán mật độ GV trước khi xếp xong."
      : "Đếm GV đang có tiết trên TKB hiện tại (sau khi xếp / đang xếp dở).";
    return '<header class="class-assignment-stats-header"><div>'
      + '<h2 id="teacherSlotPresenceTitle">Tiên lượng GV / thời điểm</h2>'
      + '<p>' + escapeHtml(note) + '</p>'
      + '<div class="teacher-slot-presence-modes" role="tablist">'
      + '<button type="button" data-presence-mode="forecast"'
      + (mode === "forecast" ? ' aria-pressed="true" class="is-active"' : ' aria-pressed="false"')
      + '>Tiên lượng</button>'
      + '<button type="button" data-presence-mode="actual"'
      + (mode === "actual" ? ' aria-pressed="true" class="is-active"' : ' aria-pressed="false"')
      + '>Đã xếp trên TKB</button>'
      + '</div></div>'
      + '<button type="button" class="class-assignment-stats-close" aria-label="Đóng thống kê">×</button></header>'
      + renderTeacherSlotPresenceTable(model, mode);
  };
  modal.innerHTML = '<section class="class-assignment-stats-dialog teacher-slot-presence-dialog" role="dialog" aria-modal="true" aria-labelledby="teacherSlotPresenceTitle">'
    + renderBody() + '</section>';
  document.body.appendChild(modal);
  document.body.classList.add("class-assignment-stats-open");
  const dialog = modal.querySelector(".class-assignment-stats-dialog");
  const rebind = ()=>{
    dialog.innerHTML = renderBody();
    dialog.querySelector(".class-assignment-stats-close")?.addEventListener("click", closeTeacherSlotPresenceStatistics);
    dialog.querySelectorAll("[data-presence-mode]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        mode = btn.getAttribute("data-presence-mode") === "actual" ? "actual" : "forecast";
        rebind();
      });
    });
  };
  rebind();
  modal.addEventListener("pointerdown", ev=>{
    if(ev.target === modal) closeTeacherSlotPresenceStatistics();
  });
  window.setTimeout(()=>modal.querySelector(".class-assignment-stats-close")?.focus(), 0);
  return model;
}

if(!window.__TKB_TEACHER_SLOT_PRESENCE_BOUND){
  window.__TKB_TEACHER_SLOT_PRESENCE_BOUND = true;
  document.addEventListener("keydown", ev=>{
    if(ev.key === "Escape" && document.getElementById(TEACHER_SLOT_PRESENCE_MODAL_ID)){
      closeTeacherSlotPresenceStatistics();
    }
  });
}
window.buildTeacherSlotPresenceStatistics = buildTeacherSlotPresenceStatistics;
window.renderTeacherSlotPresenceTable = renderTeacherSlotPresenceTable;
window.openTeacherSlotPresenceStatistics = openTeacherSlotPresenceStatistics;
window.closeTeacherSlotPresenceStatistics = closeTeacherSlotPresenceStatistics;

function renderStatsBox(){
  const box = document.getElementById("statsBox");
  if(!box) return;
  const isSolving = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
  box.classList.toggle("is-solving", isSolving);

  // One content signature is enough for the four views below.  Previously
  // each view rescanned the entire timetable just to build its own cache key.
  const cacheSignature = schoolStatsTkbSignature();
  const school = calcSchoolTKBStats(cacheSignature);
  const gvStats = calcTeacherTKBStats(cacheSignature);
  const studentGapStats = calcStudentTimetableGapStats(cacheSignature);
  const unassignedIssues = getUnassignedIssuesFromStats(cacheSignature);
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
  const stat = (label, value, key)=>(
    `<div class="stats-pair"${key ? ` data-stat-key="${escapeHtml(key)}"` : ""}><span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${escapeHtml(value)}</span></div>`
  );

  // Fast in-place DOM update if grid already exists (0 lag, 0 flicker, 60fps)
  const existingGrid = box.querySelector(".stats-teacher-grid");
  if(existingGrid){
    const updateVal = (key, val) => {
      const el = box.querySelector(`[data-stat-key="${key}"] .stats-value`);
      if(el && el.textContent !== String(val)) el.textContent = String(val);
    };
    updateVal("scheduledPeriods", school.daXepTiet);
    updateVal("unassignedPeriods", school.chuaXepTiet);
    updateVal("teacherGapPeriods", gvStats.soTietTrong);
    updateVal("teacherSessions", gvStats.tsBuoiDay);
    updateVal("teacherGap1Sessions", gvStats.soBuoiTrong1);
    updateVal("teacherDays", gvStats.tsNgayDay);
    updateVal("teacherGap2Sessions", gvStats.soBuoiTrong2);
    updateVal("onePeriodTeacherSessions", gvStats.soBuoiDay1);
    updateVal("studentGaps", studentGapStats.totalGaps);
    updateVal("fivePeriodTeacherSessions", gvStats.soBuoiDay5);

    // Cập nhật lại TRẠNG THÁI của các nút drill-down mỗi lần refresh.
    // Nút LUÔN bấm được (kể cả = 0 — bấm sẽ báo "Thời khóa biểu không có ...");
    // đồng thời gỡ khóa live-progress ngay khi lượt tối ưu kết thúc.
    const updateDrill = (key, emptyKind, issues, title)=>{
      const cell = box.querySelector(`[data-stat-key="${key}"]`);
      const btn = cell?.querySelector?.("button");
      if(!cell || !btn) return;
      const has = Array.isArray(issues) && issues.length > 0;
      btn.disabled = false;
      btn.title = has ? (title || "") : statEmptyMessage(emptyKind);
      if(!isSolving){
        cell.classList.remove("is-live-progress");
        cell.removeAttribute("title");
      }
    };
    const teacherIssues = window.__TKB_TEACHER_STAT_ISSUES || {};
    const teacherTitle = issues => (Array.isArray(issues) && issues.length)
      ? `Bấm để xem giáo viên liên quan.\n${issues.map(t => `${t.code}: ${teacherStatIssueCount(t)}`).join("\n")}`
      : "";
    updateDrill("unassignedPeriods", "unassigned", unassignedIssues,
      unassignedIssues.length
        ? unassignedIssues.map(t => `${t.className || t.classId} - ${getMonShort(t.mon)}: ${unassignedIssueCount(t)}`).join("\n")
        : "");
    updateDrill("teacherGapPeriods", "gapAll", teacherIssues.gapAll, teacherTitle(teacherIssues.gapAll));
    updateDrill("teacherGap1Sessions", "gap1", teacherIssues.gap1, teacherTitle(teacherIssues.gap1));
    updateDrill("teacherGap2Sessions", "gap2", teacherIssues.gap2, teacherTitle(teacherIssues.gap2));
    updateDrill("onePeriodTeacherSessions", "onePeriod", teacherIssues.onePeriod, teacherTitle(teacherIssues.onePeriod));
    updateDrill("studentGaps", "studentGaps", window.__TKB_STUDENT_GAP_ISSUES,
      (window.__TKB_STUDENT_GAP_ISSUES || []).length
        ? window.__TKB_STUDENT_GAP_ISSUES.map(t => `${t.name || t.id}: ${Math.round(Number(t.gaps || 0))}`).join("\n")
        : "");

    box.classList.remove("is-loading");
    box.dataset.statsReady = "1";
    box.removeAttribute("aria-live");
    if(isSolving) updateStatsBoxLiveProgress(window.__TKB_LIVE_STATS_PROGRESS);
    return;
  }

  box.innerHTML =
    `<div class="stats-grid-2 stats-note-grid stats-teacher-grid">`+
      stat("Đã xếp", school.daXepTiet, "scheduledPeriods")+
      stat("Chưa xếp", school.chuaXepTiet, "unassignedPeriods")+
      stat("Tiết trống", gvStats.soTietTrong, "teacherGapPeriods")+
      stat("Buổi dạy", gvStats.tsBuoiDay, "teacherSessions")+
      stat("Trống 1 tiết", gvStats.soBuoiTrong1, "teacherGap1Sessions")+
      stat("Ngày dạy", gvStats.tsNgayDay, "teacherDays")+
      stat("Trống 2 tiết", gvStats.soBuoiTrong2, "teacherGap2Sessions")+
      stat("Dạy 1 tiết", gvStats.soBuoiDay1, "onePeriodTeacherSessions")+
      stat("Lỗ trống HS", studentGapStats.totalGaps, "studentGaps")+
      stat("Dạy 5 tiết", gvStats.soBuoiDay5, "fivePeriodTeacherSessions")+
    `</div>`;

  const teacherGrid = box.querySelector(".stats-teacher-grid");
  const teacherCells = teacherGrid ? Array.from(teacherGrid.children) : [];
  // Nút luôn bấm được, kể cả khi chỉ số = 0: bấm sẽ báo
  // "Thời khóa biểu không có ..." qua goTo* thay vì disable.
  const drillButton = (type, label, count, issues)=>{
    const safeIssues = Array.isArray(issues) ? issues : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stats-pair stats-link stats-link-drilldown stats-teacher-drilldown";
    btn.innerHTML = `<span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${n(count)}</span>`;
    btn.title = safeIssues.length
      ? `Bấm để xem giáo viên liên quan.\n${safeIssues.map(t => `${t.code}: ${teacherStatIssueCount(t)}`).join("\n")}`
      : statEmptyMessage(type);
    btn.onclick = () => goToTeacherStatIssues(type);
    return btn;
  };
  const studentGapButton = (label, count, issues)=>{
    const safeIssues = Array.isArray(issues) ? issues : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stats-pair stats-link stats-link-drilldown stats-student-gap-drilldown";
    btn.innerHTML = `<span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${n(count)}</span>`;
    btn.title = safeIssues.length
      ? safeIssues.map(t => `${t.name || t.id}: ${n(t.gaps)}`).join("\n")
      : statEmptyMessage("studentGaps");
    btn.onclick = () => goToStudentGapIssues();
    return btn;
  };
  const unassignedButton = (label, count, issues)=>{
    const safeIssues = Array.isArray(issues) ? issues : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stats-pair stats-link stats-link-drilldown stats-unassigned-drilldown";
    btn.innerHTML = `<span class="stats-label">${escapeHtml(label)}: </span><span class="stats-value">${n(count)}</span>`;
    btn.title = safeIssues.length
      ? safeIssues.map(t => `${t.className || t.classId} - ${getMonShort(t.mon)}: ${unassignedIssueCount(t)}`).join("\n")
      : statEmptyMessage("unassigned");
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
  if(isSolving) updateStatsBoxLiveProgress(window.__TKB_LIVE_STATS_PROGRESS);
  box.classList.remove("is-loading");
  box.dataset.statsReady = "1";
  box.removeAttribute("aria-live");
}

function updateStatsBoxLiveProgress(snapshot){
  if(!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const box = document.getElementById("statsBox");
  if(!box) return false;
  const solving = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
  if(!solving) return false;
  const focus = String(snapshot.focus || snapshot.optimizationFocus || snapshot.optimization_focus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const current = Number(snapshot.current ?? snapshot.metricCurrent ?? snapshot.metric_current);
  if(!Number.isFinite(current) || current < 0) return false;
  const statKey = focus === "one_period_teacher_sessions" || focus === "optimize_singletons"
    ? "onePeriodTeacherSessions"
    : (focus === "teacher_sessions" || focus === "optimize_sessions"
        ? "teacherSessions"
        : (focus === "teacher_gap2_sessions" || focus === "optimize_gap2"
            ? "teacherGap2Sessions"
            : (focus === "teacher_gap1_sessions" || focus === "optimize_gap1"
                ? "teacherGap1Sessions"
                : "")));
  if(!statKey) return false;
  const cell = box.querySelector(`[data-stat-key="${statKey}"]`);
  const value = cell?.querySelector?.(".stats-value");
  if(!cell || !value) return false;
  value.textContent = String(Math.max(0, Math.round(current)));
  cell.classList.add("is-live-progress");
  cell.title = "Phương án tốt nhất tạm thời trong lượt tối ưu.";
  const drilldown = cell.querySelector("button");
  if(drilldown){
    drilldown.disabled = true;
    drilldown.title = "Hoàn tất tối ưu để xem chi tiết.";
  }
  return true;
}
window.updateStatsBoxLiveProgress = updateStatsBoxLiveProgress;

let SCHOOL_TKB_STATS_CACHE = {sig:"", value:null};
let __TKB_FAST_SIG_CACHE = { rev: -1, hash: "", val: "" };

function schoolStatsObjectSignature(obj){
  if(!obj || typeof obj !== "object") return "";
  return Object.entries(obj).map(([k,v])=>`${k}:${v}`).join("~");
}

function schoolStatsTkbSignature(){
  const curVer = window.__TKB_GLOBAL_DATA_VERSION || 0;
  let hash = 0;
  const tkbs = DATA.tkb || {};
  for(const classId in tkbs){
    const tkb = tkbs[classId];
    if(!tkb) continue;
    for(let d = 0; d < 6; d++){
      const thu = DAYS[d];
      const sang = tkb[thu]?.sang || [];
      const chieu = tkb[thu]?.chieu || [];
      for(let i = 0; i < 5; i++){
        const v1 = sang[i];
        if(v1){
          const s = (typeof v1 === 'object') ? (v1.mon || '') : v1;
          for(let c = 0; c < s.length; c++) hash = (hash * 31 + s.charCodeAt(c)) | 0;
        }
        const v2 = chieu[i];
        if(v2){
          const s = (typeof v2 === 'object') ? (v2.mon || '') : v2;
          for(let c = 0; c < s.length; c++) hash = (hash * 31 + s.charCodeAt(c)) | 0;
        }
      }
    }
  }
  return `v_${curVer}_h_${hash}`;
}

function calcSchoolTKBStats(){
  const cacheSignature = arguments[0];
  const cacheSig = String(cacheSignature || schoolStatsTkbSignature());
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

      const pccmTeachers = teacherListFromValue(
        classAssignmentStatisticsTeacherForClassMon(classCanon, monName)
      );
      if(!pccmTeachers.length && !tkbIsNoTeacherGhep(classCanon, monName)) continue;   // 02/09: tiết ghép không GV

      const req = Number(m?.required ?? m?.sotiet ?? 0);
      if(!Number.isFinite(req) || req <= 0) continue;

      const used = countMonFromTkbCountMap(tkbMonCounts, monName);
      const rem = Math.max(0, req - used);

      soTiet += req;
      chuaXepTiet += rem;
      remainForClass += rem;

      pccmTeachers.forEach(gv=>{
        teacherSet.add(gv);
        teacherMissing.set(gv, (teacherMissing.get(gv)||0) + rem);
        teacherRequired.set(gv, (teacherRequired.get(gv)||0) + req);
      });

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

// Thông báo khi chỉ số thống kê = 0: nút vẫn bấm được, bấm thì báo rõ ràng.
function statEmptyMessage(kind){
  switch(String(kind || "")){
    case "unassigned": return "Thời khóa biểu không có tiết chưa xếp.";
    case "gapAll": return "Thời khóa biểu không có tiết trống của giáo viên.";
    case "gap1": return "Thời khóa biểu không có buổi trống 1 tiết.";
    case "gap2": return "Thời khóa biểu không có buổi trống 2 tiết.";
    case "onePeriod": return "Thời khóa biểu không có buổi giáo viên dạy 1 tiết.";
    case "studentGaps": return "Thời khóa biểu không có lỗ trống của học sinh.";
    default: return "Thời khóa biểu không có dữ liệu liên quan.";
  }
}

function getUnassignedIssuesFromStats(cacheSignature){
  return collectUnassignedTasks(cacheSignature ? {cacheSignature} : {});
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
    try{ _setStatus(statEmptyMessage("unassigned"), "ok"); }catch(_){ }
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
    const monShort = tkbMonLabel(classId, mon);
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
    try{ _setStatus(statEmptyMessage("studentGaps"), "ok"); }catch(_){ }
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
  // 19/08: TRUOC day khi khong tim duoc lop nao lien quan, ham nay tra ve
  // `currentLop` — tuc la lop DANG XEM, chang lien quan gi toi giao vien co
  // van de. Ket qua: tieu de ghi mot giao vien, luoi ben duoi lai la giao vien
  // khac (nhat la hai ma gan giong nhau nhu "Phuong" va "Phuong"), va o duoc
  // to sang la o cua nguoi khac. Tha khong doi lop con hon chi sai cho.
  return "";
}

function focusTeacherIssueInClassPair(type, target){
  const code = String(target?.code || "").trim();
  if(!code) return;
  // Ghim giao vien dang xem: pvEnsureTeacherForClass() se KHONG duoc tu y doi
  // sang giao vien dau danh sach cua lop nua.
  window.__TKB_PAIR_PINNED_GV = code;
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
    try{ _setStatus(statEmptyMessage(key), "ok"); }catch(_){ }
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
    // 19/08: PHAI khoa theo dung ma giao vien. Truoc day bo loc chi co thu +
    // buoi, nen neu luoi ben duoi dang hien giao vien khac (vi du bi doi ngam)
    // thi cac o cua NGUOI KHAC bi to sang — dung canh "bam vao thong ke ma no
    // dan toi cho sai".
    const teacherAttr = String(issue.code || "").replace(/"/g, '\\"');
    const scopeSelector = (key !== "onePeriod" && document.getElementById("tkbPairSupport"))
      ? `#tkbPairSupport td[data-pair-slot="teacher"][data-teacher="${teacherAttr}"][data-thu="${s.thu}"][data-buoi="${s.buoi}"]`
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
  try{
    // Ten day du de phan biet hai ma gan giong nhau (vi du "Phuong" vs "Phuong").
    let hoTen = "";
    try{
      const row = (DATA.giaovien || []).find(g => String(g?.magv || "").trim() === String(issue.code || "").trim());
      hoTen = row ? `${String(row.hodem || "").trim()} ${String(row.ten || "").trim()}`.trim() : "";
    }catch(_){ }
    const shownTeacher = String(document.querySelector("#tkbPairSupport td[data-pair-slot='teacher']")?.dataset?.teacher || "").trim();
    const mismatch = shownTeacher && shownTeacher !== String(issue.code || "").trim();
    _setStatus(
      `Đang xem GV ${issue.code}${hoTen ? ` (${hoTen})` : ""}: ${teacherStatIssueCount(issue)} mục - ${getTeacherStatLabel(key)}.`
      + (mismatch ? ` ⚠ Lưới bên dưới đang hiển thị GV ${shownTeacher}, không phải GV này.` : ""),
      mismatch ? "warning" : "info"
    );
  }catch(_){ }
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
  const cacheSignature = arguments[0];
  const cacheSig = String(cacheSignature || schoolStatsTkbSignature());
  const statsCache = window.__TKB_TEACHER_TKB_STATS_CACHE || {sig:"", value:null};
  if(statsCache.sig === cacheSig && statsCache.value){
    return statsCache.value;
  }
  const teacherCodes = Array.from(_getAssignedTeacherCodes());
  const occ = {}; // code -> day -> buoi -> boolean[]

  const _ensureTeacherOcc = (rawCode) => {
    if(!rawCode) return null;
    const key = resolveTeacherCode(rawCode) || String(rawCode).trim();
    if(!key) return null;
    if(!occ[key]){
      occ[key] = {};
      DAYS.forEach(d=>{
        occ[key][d] = {
          sang: Array.from({length:SANG}, ()=>false),
          chieu: Array.from({length:CHIEU}, ()=>false)
        };
      });
    }
    return { key, obj: occ[key] };
  };

  teacherCodes.forEach(code => _ensureTeacherOcc(code));

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
        let teachers = [];
        if(typeof v === "object" && v.gv){
          teachers = teacherListFromValue(v.gv);
        }else if(cellLegacyTeacher(v, classCanon)){
          teachers = teacherListFromValue(cellLegacyTeacher(v, classCanon));
        }
        if(!teachers.length){
          teachers = teacherListFromValue(
            classAssignmentStatisticsTeacherForClassMon(classCanon, mon)
          );
        }
        teachers.forEach(gv=>{
          const tRes = _ensureTeacherOcc(gv);
          if(tRes && tRes.obj) tRes.obj[d].sang[i] = true;
        });
      }
      // chiều
      const ac = (tkb?.[d]?.chieu || []);
      for(let i=0;i<ac.length;i++){
        const v = ac[i];
        if(!v || v === "OFF") continue;
        const mon = cellMon(v);
        if(!mon) continue;
        let teachers = [];
        if(typeof v === "object" && v.gv){
          teachers = teacherListFromValue(v.gv);
        }else if(cellLegacyTeacher(v, classCanon)){
          teachers = teacherListFromValue(cellLegacyTeacher(v, classCanon));
        }
        if(!teachers.length){
          teachers = teacherListFromValue(
            classAssignmentStatisticsTeacherForClassMon(classCanon, mon)
          );
        }
        teachers.forEach(gv=>{
          const tRes = _ensureTeacherOcc(gv);
          if(tRes && tRes.obj) tRes.obj[d].chieu[i] = true;
        });
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

  const allTrackedTeachers = Array.from(new Set([...teacherCodes, ...Object.keys(occ)]));
  for(const code of allTrackedTeachers){
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
            soTietTrong += 1;
            const info = {thu:d, buoi, gap:gaps, gapSlots:gapSlots.slice()};
            _pushTeacherIssue(gapTeacherMap, code, info);
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

  const result = {
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
  window.__TKB_TEACHER_TKB_STATS_CACHE = {sig:cacheSig, value:result};
  return result;
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
  const wrap = document.getElementById("autoSortProgress");
  const isSolving = wrap && (wrap.classList.contains("is-active") || !wrap.hidden);
  // 19/09: dung mem / ap lich tot nhat PHAI hien — truoc day moi chuoi
  // "Dang nhan..." bi an khi thanh tien do dang chay, nen nguoi dung tuong
  // tien trinh tat im trong 10-20s.
  const isSoftStopOrApply = /đang nhận (phương án|lịch) tốt nhất|đang áp lịch tốt nhất/i.test(
    String(msg || "").trim()
  );
  const isRoutine = /^(đang sắp xếp|đang tối ưu|đang nhận|đang xử lý)/i.test(String(msg || "").trim());
  if(isSolving && isRoutine && !isSoftStopOrApply){
    el.textContent = "";
    el.style.display = "none";
    return;
  }
  window.clearTimeout(window.__TKB_STATUS_HIDE_TIMER);
  window.__TKB_STATUS_HIDE_TIMER = 0;
  el.textContent = msg || "";
  el.style.display = msg ? "inline-block" : "none";
  el.style.fontWeight = "600";
  el.style.letterSpacing = "-0.01em";
  const isCompletionText = /^(đã tối ưu|đã xếp xong|trống \d tiết|dạy 1 tiết|buổi dạy)/i.test(String(msg || "").trim());
  if(type === "ok" || isCompletionText) el.style.color = "#16a34a";
  else if(type === "info") el.style.color = "#2563eb";
  else if(type === "warning") el.style.color = "#d97706";
  else el.style.color = "#dc2626";
  fitPlannerMobileStatusMessage(el);
  const persistentCompletion = String(msg || "").trim() === "Đã xếp xong!" || /^(đã tối ưu|dạy 1 tiết|trống \d tiết|buổi dạy)/i.test(String(msg || "").trim());
  const persistentSoftStop = /đang nhận (phương án|lịch) tốt nhất|đang áp lịch tốt nhất/i.test(String(msg || "").trim());
  if(msg && !persistentCompletion && !persistentSoftStop){
    window.__TKB_STATUS_HIDE_TIMER = window.setTimeout(() => {
      el.textContent = "";
      el.style.display = "none";
      fitPlannerMobileStatusMessage(el);
      el.classList.remove("is-auto-sort-running-label");
      window.__TKB_STATUS_HIDE_TIMER = 0;
    }, 6000);
  }
}

function _autoSortProgressYield(){
  // 21/08: tab an -> setTimeout bi bop ~1 lan/phut; nhuong qua worker timer.
  if(typeof document !== "undefined" && document.hidden && typeof window.__tkbBgSleep === "function"){
    return window.__tkbBgSleep(0);
  }
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

// Retired local-solver names remain as inert hooks for an older cached bridge.
// They never detect a device or enable a client-owned executor.
if(typeof window !== "undefined"){
  window.__TKB_CLIENT_AGENT_LANES_ENABLED = false;
  window.__TKB_AGENT_ROLE_ALLOWED = false;
  window.__TKB_WINDOWS_WEB_AGENT_TRIAL = false;
}
function isAgentHelperSupportedDevice(){ return false; }
function isWindowsNativeAgentDevice(){ return false; }
function plannerAgentRoleAllowed(){ return false; }
function isAgentHelperVisibleForCurrentUser(){
  return plannerServerRouteToggleAllowed();
}

// Serverless/Hybrid routing is retired from the planner.  Keep the old helper
// names only so a stale cached page fails closed instead of opening a route.
function plannerServerRouteToggleAllowed(){
  return false;
}

const solverInfrastructureRouteToggleState = {
  payload:null,
  pending:null,
  loading:false,
  error:""
};

function solverInfrastructureRouteMode(payload){
  const mode = String(payload?.config?.mode || "").trim().toLowerCase();
  return ["auto", "serverless_only", "vps_only"].includes(mode) ? mode : "";
}

function solverInfrastructureRouteLabel(mode, options){
  const loading = options?.loading === true;
  const error = String(options?.error || "").trim();
  if(loading) return "Đang tải trạng thái Serverless/VPS…";
  if(error) return `Không đọc được trạng thái Serverless/VPS: ${error}. Bấm để thử lại.`;
  if(mode === "serverless_only"){
    return "Serverless đang bật: chỉ Cloud Run. Bấm để chuyển sang chỉ VPS.";
  }
  if(mode === "auto"){
    return "Serverless đang bật: Cloud Run → VPS dự phòng. Bấm để chuyển sang chỉ VPS.";
  }
  if(mode === "vps_only"){
    return "Serverless đang tắt: chỉ VPS. Bấm để chuyển sang Cloud Run → VPS dự phòng.";
  }
  return "Chưa xác định tuyến Serverless/VPS. Bấm để tải lại.";
}

function renderSolverInfrastructureRouteToggle(){
  const btn = document.getElementById("btnSolverInfrastructureRoute");
  if(!btn) return false;
  const allowed = plannerServerRouteToggleAllowed();
  if(!allowed){
    btn.hidden = true;
    btn.setAttribute("aria-hidden", "true");
    return false;
  }
  const mode = solverInfrastructureRouteMode(solverInfrastructureRouteToggleState.payload);
  const cloudEnabled = mode === "auto" || mode === "serverless_only";
  const loading = solverInfrastructureRouteToggleState.loading === true;
  const error = solverInfrastructureRouteToggleState.error;
  const label = solverInfrastructureRouteLabel(mode, {loading, error});
  btn.hidden = false;
  btn.setAttribute("aria-hidden", "false");
  btn.dataset.agentState = loading
    ? "working"
    : (error ? "error" : (cloudEnabled ? "enabled" : (mode === "vps_only" ? "fallback" : "off")));
  btn.dataset.solverRouteMode = mode || "unknown";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", cloudEnabled ? "true" : "false");
  const autoSortLocked = btn.dataset.autoSortLock === "1"
    || window.__TKB_RUST_SOLVER_RUNNING === true
    || window.__TKB_SOLVE_UI_BUSY === true;
  btn.disabled = loading || autoSortLocked;
  btn.setAttribute("aria-disabled", loading || autoSortLocked ? "true" : "false");
  window.__TKB_SOLVER_ROUTE_MODE = mode;
  window.__TKB_SOLVER_ROUTE_SERVERLESS_ENABLED = cloudEnabled;
  return true;
}

async function requestSolverInfrastructure(method, body){
  const api = window.TKBAuthApi;
  if(!api || typeof api.getAuthHeaders !== "function"){
    throw new Error("Phiên đăng nhập chưa sẵn sàng");
  }
  const headers = api.getAuthHeaders(body === undefined
    ? undefined
    : {"Content-Type":"application/json"});
  const response = await window.fetch("/api/admin/solver-infrastructure", {
    method:method || "GET",
    headers,
    body:body === undefined ? undefined : JSON.stringify(body),
    cache:"no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if(!response.ok || payload?.ok !== true){
    throw new Error(payload?.message || payload?.detail || payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function refreshSolverInfrastructureRouteToggle(){
  if(!plannerServerRouteToggleAllowed()){
    renderSolverInfrastructureRouteToggle();
    return null;
  }
  if(solverInfrastructureRouteToggleState.pending){
    return solverInfrastructureRouteToggleState.pending;
  }
  solverInfrastructureRouteToggleState.loading = true;
  solverInfrastructureRouteToggleState.error = "";
  renderSolverInfrastructureRouteToggle();
  const pending = requestSolverInfrastructure("GET")
    .then(payload => {
      solverInfrastructureRouteToggleState.payload = payload;
      return payload;
    })
    .catch(error => {
      solverInfrastructureRouteToggleState.error = String(error?.message || error || "Không xác định");
      return null;
    })
    .finally(() => {
      solverInfrastructureRouteToggleState.loading = false;
      solverInfrastructureRouteToggleState.pending = null;
      renderSolverInfrastructureRouteToggle();
    });
  solverInfrastructureRouteToggleState.pending = pending;
  return pending;
}

function solverInfrastructureToggleConfig(payload, targetMode){
  const config = payload?.config && typeof payload.config === "object"
    ? payload.config
    : null;
  if(!config) throw new Error("Chưa tải được cấu hình Serverless/VPS");
  const profiles = Array.isArray(config.profiles)
    ? config.profiles.map(profile => Object.assign({}, profile))
    : [];
  const selectedProfileId = String(
    config.activeProfileId
    || payload?.selectedProfileId
    || profiles.find(profile => profile?.enabled !== false && String(profile?.id || "").trim())?.id
    || ""
  ).trim();
  if(targetMode === "auto" && !selectedProfileId){
    throw new Error("Chưa có Cloud Run profile đang hoạt động");
  }
  return Object.assign({}, config, {
    mode:targetMode,
    fallback:"vps",
    activeProfileId:selectedProfileId || null,
    profiles
  });
}

async function toggleSolverInfrastructureRoute(){
  if(!plannerServerRouteToggleAllowed()) return false;
  if(solverInfrastructureRouteToggleState.pending){
    await solverInfrastructureRouteToggleState.pending;
  }
  if(!solverInfrastructureRouteToggleState.payload){
    await refreshSolverInfrastructureRouteToggle();
  }
  try{
    const currentMode = solverInfrastructureRouteMode(solverInfrastructureRouteToggleState.payload);
    if(!currentMode) throw new Error("Chưa xác định được tuyến hiện tại");
    const targetMode = currentMode === "vps_only" ? "auto" : "vps_only";
    const config = solverInfrastructureToggleConfig(
      solverInfrastructureRouteToggleState.payload,
      targetMode
    );
    solverInfrastructureRouteToggleState.loading = true;
    solverInfrastructureRouteToggleState.error = "";
    renderSolverInfrastructureRouteToggle();
    const saved = await requestSolverInfrastructure("PATCH", config);
    solverInfrastructureRouteToggleState.payload = Object.assign({}, saved, {
      selectedProfileId:config.activeProfileId,
      effectiveMode:targetMode
    });
    _setStatus(
      targetMode === "auto"
        ? "Đã bật Serverless: các lượt xếp mới sẽ dùng Cloud Run, nếu lỗi sẽ tự chuyển VPS."
        : "Đã tắt Serverless: các lượt xếp mới sẽ chỉ dùng VPS.",
      targetMode === "auto" ? "ok" : "info"
    );
    try{
      window.dispatchEvent?.(new CustomEvent("tkb:solver-infrastructure-changed", {
        detail:{mode:targetMode, config:saved.config}
      }));
    }catch(_){ }
    return targetMode === "auto";
  }catch(error){
    solverInfrastructureRouteToggleState.error = String(error?.message || error || "Không xác định");
    _setStatus(`Không chuyển được tuyến Serverless/VPS: ${solverInfrastructureRouteToggleState.error}`, "error");
    return false;
  }finally{
    solverInfrastructureRouteToggleState.loading = false;
    renderSolverInfrastructureRouteToggle();
  }
}

// Fail-closed compatibility API for bridge code cached before client Agent retirement.
function nativeAgentStatusSnapshot(){
  return {
    known:false, online:false, nativeRunning:false, nativeRunningKnown:false,
    installedKnown:false, agentId:"", state:"retired", error:"client_agent_retired"
  };
}
function nativeAgentSortPolicy(){
  return {mode:"server", allowSort:true, nativeRequired:false, installedKnown:false, agentId:""};
}
function isHybridModeEnabled(){
  // Hybrid is retired from the planner. Keep this hook for old cached pages,
  // but never allow a stale localStorage flag to route a solve.
  return false;
}

function setHybridModeEnabled(enabled){
  window.__TKB_HYBRID_ENGINE_ENABLED = false;
  try{
    localStorage.removeItem("TKB_HYBRID_MODE_ENABLED");
    localStorage.removeItem("TKB_USE_HYBRID_SOLVER");
  }catch(_){}
  syncAgentHelperVisibility();
  return false;
}

function syncAgentHelperVisibility(){
  const btn = document.getElementById("btnAgentHelper");
  if(!btn) return false;
  btn.hidden = true;
  btn.setAttribute("aria-hidden", "true");
  btn.setAttribute("aria-disabled", "true");
  return false;
}

async function toggleBrowserAgent(){
  setHybridModeEnabled(false);
  return false;
}
async function maybeInviteAgentBeforeSort(){ return true; }

try{
  window.isHybridModeEnabled = isHybridModeEnabled;
  window.setHybridModeEnabled = setHybridModeEnabled;
  window.syncAgentHelperVisibility = syncAgentHelperVisibility;
  window.toggleBrowserAgent = toggleBrowserAgent;
}catch(_){ }

function setAutoSortHomeHidden(hidden){
  const shouldLock = !!hidden;
  const btn = document.getElementById("btnHome");
  const agentBtn = document.getElementById("btnAgentHelper");
  if(!btn && !agentBtn) return false;
  if(btn){
    btn.hidden = false;
    btn.setAttribute("aria-hidden", "false");
    setAutoSortControlLocked(btn, shouldLock);
  }
  // The superadmin infrastructure status dot stays visible while the route
  // control itself is dimmed and disabled for the server-owned sort.
  if(agentBtn){
    const agentVisible = syncAgentHelperVisibility();
    agentBtn.hidden = !agentVisible;
    agentBtn.setAttribute("aria-hidden", agentVisible ? "false" : "true");
    setAutoSortControlLocked(agentBtn, shouldLock);
    if(!shouldLock) syncAgentHelperVisibility();
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

function isPlannerBusySolving(){
  return (window.__ACTIVE_TKB_FET_WORKER != null)
    || (window.__TKB_RUST_SOLVER_RUNNING === true)
    || (window.__TKB_SOLVE_UI_BUSY === true);
}

function setAutoSortBusyControls(locked){
  const workerStillRunning = isPlannerBusySolving();
  const shouldLock = !!locked || workerStillRunning;
  const controls = [
    document.getElementById("btnDeleteAll"),
    document.getElementById("btnRangBuoc"),
    document.getElementById("btnUndoTKB"),
    document.getElementById("btnRedoTKB"),
    document.getElementById("btnAutoSort"),
    document.getElementById("btnEngineCherry"),
    // 25/08 (chi dao chu du an): nut "Toi uu v3" truoc day KHONG bi khoa khi
    // dang xep. runPlannerV3Mode van chan bang testControlBusy() nen bam
    // khong chay gi, nhung nut sang binh thuong nen nguoi dung tuong no hong.
    document.getElementById("btnTestMenu"),
    // 26/08 (chi dao chu du an): nut RB (kiem tra rang buoc) cung khoa khi
    // dang xep — bang RB doc DATA.tkb dang bi luot xep ghi de.
    document.getElementById("btnConstraintAudit"),
    document.getElementById("btnHome"),
    document.getElementById("solveDurationSeconds"),
    // Muc ben trong menu Toi uu v3: menu co the dang mo khi luot xep bat dau.
    ...Array.from(document.querySelectorAll(
      "#plannerTestMenu button"
    )),
    ...Array.from(document.querySelectorAll(".solver-preset-btn[data-preset]"))
  ].filter(Boolean);
  controls.forEach(el => setAutoSortControlLocked(el, shouldLock));
  if(shouldLock){
    [
      ["plannerTestMenu", "btnTestMenu"]
    ].forEach(([menuId, buttonId]) => {
      const menu = document.getElementById(menuId);
      const button = document.getElementById(buttonId);
      if(menu) menu.hidden = true;
      if(button) button.setAttribute("aria-expanded", "false");
    });
  }
  const presetGroup = document.getElementById("solverPresetGroup");
  if(presetGroup) presetGroup.setAttribute("aria-disabled", shouldLock ? "true" : "false");
  setAutoSortHomeHidden(shouldLock);
  if(!shouldLock) __tkbUpdateHistoryButtons();

  // Khóa tương tác lưới thời khóa biểu bên dưới (chỉ xem, không kéo thả/chỉnh sửa khi đang xếp)
  const tkbEl = document.getElementById("tkb");
  if(tkbEl) tkbEl.classList.toggle("is-solving-readonly", shouldLock);
  const centerEl = document.querySelector(".center");
  if(centerEl) centerEl.classList.toggle("is-solving-readonly", shouldLock);
  // 26/08 (chi dao chu du an): cot trai chi khoa NGUON KEO (.mon-item); van
  // cho doi lop / giao vien de XEM trong luc dang xep (chon lop chi doc DATA,
  // luoi #tkb van read-only nen khong the keo tha / sua).
  const leftEl = document.querySelector(".left");
  if(leftEl){
    leftEl.classList.remove("is-solving-readonly");
    leftEl.classList.toggle("is-solving-select-only", shouldLock);
  }
}

function setAutoSortStopVisible(visible){
  setAutoSortBusyControls(!!visible);
  const stopBtn = document.getElementById("btnStopAutoSort");
  const delBtn = document.getElementById("btnDeleteAll");

  if(visible){
    if(delBtn){
      delBtn.style.display = "none";
      delBtn.setAttribute("aria-hidden", "true");
    }
    if(stopBtn){
      stopBtn.style.display = "inline-flex";
      stopBtn.classList.add("is-active");
      stopBtn.setAttribute("aria-hidden", "false");
      stopBtn.disabled = false;
      setAutoSortStopAccessibleState(false);
    }
  }else{
    if(delBtn){
      delBtn.style.display = "";
      delBtn.removeAttribute("aria-hidden");
    }
    if(stopBtn){
      stopBtn.style.display = "none";
      stopBtn.classList.remove("is-active");
      stopBtn.setAttribute("aria-hidden", "true");
      stopBtn.disabled = true;
      setAutoSortStopAccessibleState(false);
    }
  }
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
  window.__AUTO_SORT_STOP_REQUESTED = true;
  window.__TKB_RUST_SOLVER_RUNNING = false;
  window.__TKB_SOLVE_UI_BUSY = false;

  // Focused FET optimization owns an explicit asynchronous stop flow. It
  // validates and applies the latest safe checkpoint; construction still uses
  // the cancellation path below and keeps the incumbent timetable.
  if(typeof window.__ACTIVE_TKB_FET_WORKER_STOP === "function"){
    setAutoSortStopAccessibleState(true);
    try{ return window.__ACTIVE_TKB_FET_WORKER_STOP(); }catch(err){
      console.warn("FET stop handling failed", err);
    }
  }

  if(window.__ACTIVE_TKB_FET_WORKER){
    try{
      window.__ACTIVE_TKB_FET_WORKER.terminate();
      window.__ACTIVE_TKB_FET_WORKER = null;
    }catch(_){}
  }
  const pendingFetResolve = window.__ACTIVE_TKB_FET_WORKER_RESOLVE;
  window.__ACTIVE_TKB_FET_WORKER_RESOLVE = null;
  if(typeof pendingFetResolve === "function"){
    pendingFetResolve({
      ok:false,
      applied:false,
      cancelled:true,
      executor:"fet_worker",
      failureKind:"user_cancelled"
    });
  }
  // Worker progress snapshots are intentionally never committed.  They can
  // contain a partially constructed/ejected timetable and therefore do not
  // satisfy the same hard-valid candidate contract as a terminal result.
  window.__LATEST_OPTIMIZE_TKB = null;
  window.__LATEST_OPTIMIZE_CHECKPOINT = null;
  window.__ACTIVE_TKB_FET_WORKER_STOP = null;
  if(typeof hideAutoSortProgress === "function"){
    hideAutoSortProgress();
  }else{
    setAutoSortStopVisible(false);
  }
  try{ _setStatus("Đã dừng tối ưu; lịch trước khi chạy được giữ nguyên.", "info"); }catch(_){ }
}

window.setTimeout(() => {
  syncAgentHelperVisibility();
  if(plannerServerRouteToggleAllowed()) refreshSolverInfrastructureRouteToggle();
}, 0);

try{
  window.addEventListener?.("tkb:auth-ready", () => {
    syncAgentHelperVisibility();
    if(plannerServerRouteToggleAllowed()) refreshSolverInfrastructureRouteToggle();
  });
  window.addEventListener?.("pageshow", () => {
    syncAgentHelperVisibility();
    if(plannerServerRouteToggleAllowed()) refreshSolverInfrastructureRouteToggle();
  });
}catch(_){ }

try{
  window.setAutoSortStopVisible = setAutoSortStopVisible;
  window.setAutoSortBusyControls = setAutoSortBusyControls;
  window.setAutoSortHomeHidden = setAutoSortHomeHidden;
  window.resetAutoSortStopRequest = resetAutoSortStopRequest;
  window.requestStopAutoSort = requestStopAutoSort;
  window.isAgentHelperSupportedDevice = isAgentHelperSupportedDevice;
  window.isAgentHelperVisibleForCurrentUser = isAgentHelperVisibleForCurrentUser;
  window.plannerAgentRoleAllowed = plannerAgentRoleAllowed;
  window.plannerServerRouteToggleAllowed = plannerServerRouteToggleAllowed;
  window.refreshSolverInfrastructureRouteToggle = refreshSolverInfrastructureRouteToggle;
  window.toggleSolverInfrastructureRoute = toggleSolverInfrastructureRoute;
  window.isWindowsNativeAgentDevice = isWindowsNativeAgentDevice;
  window.nativeAgentStatusSnapshot = nativeAgentStatusSnapshot;
  window.nativeAgentSortPolicy = nativeAgentSortPolicy;
  window.checkNativeAgentNow = checkNativeAgentNow;
  window.syncAgentHelperVisibility = syncAgentHelperVisibility;
  window.toggleBrowserAgent = toggleBrowserAgent;
  window.isHybridModeEnabled = isHybridModeEnabled;
  window.setHybridModeEnabled = setHybridModeEnabled;
  window.maybeInviteAgentBeforeSort = maybeInviteAgentBeforeSort;
  window.hideAutoSortProgress = hideAutoSortProgress;
  window.setAutoSortProgress = setAutoSortProgress;
  window.finishAutoSortProgress = finishAutoSortProgress;
}catch(_){ }

function hideAutoSortProgress(options){
  const preserveStopRequest = options?.preserveStopRequest === true;
  window.clearTimeout(window.__autoSortProgressHideTimer);
  window.__autoSortProgressHideTimer = null;
  if(window.__autoSortTimerInterval){
    window.clearInterval(window.__autoSortTimerInterval);
    window.__autoSortTimerInterval = null;
  }
  window.__autoSortStartTime = null;

  const wrap = document.getElementById("autoSortProgress");
  if(wrap){
    wrap.classList.remove("is-active", "is-error", "is-warning", "is-complete");
    wrap.classList.add("is-idle");
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    const timerVal = document.getElementById("autoSortTimerVal");
    const metric = document.getElementById("autoSortProgressMetric");
    if(timerVal) timerVal.textContent = "00:00";
    if(metric){
      metric.textContent = "";
      metric.hidden = true;
    }
  }
  setAutoSortStopVisible(false);
  if(!preserveStopRequest) resetAutoSortStopRequest();
}

function setAutoSortProgress(percent, label, details){
  const wrap = document.getElementById("autoSortProgress");
  const metric = document.getElementById("autoSortProgressMetric");
  const timerVal = document.getElementById("autoSortTimerVal");
  if(!wrap) return;

  const n = Math.max(0, Math.min(100, Math.round(Number(percent || 0))));
  window.clearTimeout(window.__autoSortProgressHideTimer);
  setAutoSortStopVisible(true);
  wrap.classList.remove("is-idle", "is-error", "is-warning", "is-complete");
  wrap.classList.add("is-active");
  wrap.hidden = false;
  wrap.setAttribute("aria-hidden", "false");

  // Manage Stopwatch Timer
  if(!window.__autoSortStartTime){
    window.__autoSortStartTime = Date.now();
  }
  if(!window.__autoSortTimerInterval){
    window.__autoSortTimerInterval = window.setInterval(() => {
      if(!window.__autoSortStartTime) return;
      const elapsedSec = Math.floor((Date.now() - window.__autoSortStartTime) / 1000);
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      const tStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      const tEl = document.getElementById("autoSortTimerVal");
      if(tEl) tEl.textContent = tStr;
    }, 250);
  }
  if(timerVal && window.__autoSortStartTime){
    const elapsedSec = Math.floor((Date.now() - window.__autoSortStartTime) / 1000);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    timerVal.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Update Metric Chip (an hoan toan khi chay Cherry)
  const isAltEngine = window.__TKB_HIDE_PROGRESS_METRIC === true
    || window.__TKB_FORCE_ENGINE === "cherry"
    || window.__CURRENT_ACTIVE_ENGINE === "cherry";

  if(isAltEngine){
    // 19/08: KHONG duoc de nhan tien do CU dinh lai khi chay Cherry (nhan cu
    // "Trong 1 tiet: 70 -> 6" cua luot truoc tung hien lai o giay thu 2).
    // 22/08 (khuya, chu du an: "nut toi uu v3 phai hien 1 tiet -> 0 tiet"):
    // engine v3 nay gui nhan so lieu truc tiep qua khung tien do (bridge dua
    // vao details.metricLabel, vd "D\u1ea1y 1 ti\u1ebft: 43 \u2794 4"); co nhan do thi hien
    // no, chua co thi hien ten thuat toan dang chay.
    var __engKey = String(window.__TKB_FORCE_ENGINE || window.__CURRENT_ACTIVE_ENGINE || "").trim().toLowerCase();
    var __focusMode = String(window.__TKB_ENGINE_FOCUS_MODE || "").trim();
    var __live = String(details?.metricLabel || "").trim();
    var __liveIsNumbers = !!__live && /\d\s*\u2794\s*\d|\d+\s*(bu\u1ed5i|ti\u1ebft)/i.test(__live)
      && !/^\d+\s*gi\u00e2y$/i.test(__live) && !/^\d+:\d+$/.test(__live);
    var __engBadge = __engKey === "cherry"
      ? (__focusMode ? "\u0110ang t\u1ed1i \u01b0u v3\u2026" : "\u0110ang x\u1ebfp b\u1eb1ng Cherry v3!")
      : "";
    var __text = __liveIsNumbers
      ? (__focusMode || /\u2794/.test(__live) && /\u00b7/.test(__live) ? __live : ("Cherry v3 \u00b7 " + __live))
      : (window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL || __engBadge);
    if(__liveIsNumbers) window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL = __text;
    if(metric){
      if(__text){
        metric.classList.remove("is-hybrid");
        metric.textContent = __text;
        metric.title = __text;
        metric.hidden = false;
      }else{
        metric.textContent = "";
        metric.hidden = true;
      }
    }
  }else if(metric){
    let rawMetric = String(details?.metricLabel || "").trim();
    const isSystemNoise = (str) => {
      const s = String(str || "").trim().toLowerCase();
      if (!s || /^\d+\s*giây$/i.test(s) || /^\d+:\d+$/.test(s) || s === "nối lại" || s === "đăng nhập" || s === "đang sắp xếp...") return true;
      if (window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL && !/^\d+\/\d+\s*tiết$/i.test(window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL)) {
        if (/^\d+\/\d+\s*tiết$/i.test(s)) return true;
      }
      return false;
    };

    if(isSystemNoise(rawMetric) && label && !isSystemNoise(label)){
      rawMetric = String(label).trim();
    }
    if(isSystemNoise(rawMetric) && window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL){
      rawMetric = window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL;
    }
    if(!isSystemNoise(rawMetric)){
      window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL = rawMetric;
      metric.classList.remove("is-hybrid");
      metric.textContent = rawMetric;
      metric.title = rawMetric;
      metric.hidden = false;
    }else{
      metric.hidden = true;
    }
  }

  const btn = document.getElementById("btnStopAutoSort");
  // 24/08: chi giu nut Dung o trang thai khoa khi lan dung mem VAN con trong
  // thoi gian cho. Khi bridge bao da treo qua han, nut phai song lai de lan
  // bam ke tiep huy han - neu khong nguoi dung khong the dung duoc luot xep.
  const bestEffortStopStuck = window.__TKB_RUST_PROGRESS_STATE?.bestEffortStopStuck === true;
  const bestEffortStopPending = window.__TKB_RUST_PROGRESS_STATE?.bestEffortStopPending === true
    && !bestEffortStopStuck;
  // 19/09: dung mem / dang ap lich tot nhat — GIU statusMsg. Truoc day moi
  // khung tien do xoa statusMsg -> nguoi dung thay tien trinh "tat" roi doi
  // 10-20s moi thay "Da xep xong", tuong bi rollback im lang.
  const statusMsgEl = document.getElementById("statusMsg");
  if(statusMsgEl && statusMsgEl.textContent){
    const statusText = String(statusMsgEl.textContent || "");
    const keepStopStatus = bestEffortStopPending
      || bestEffortStopStuck
      || window.__TKB_SOFT_STOP_APPLYING === true
      || /đang nhận (phương án|lịch) tốt nhất|đang áp lịch tốt nhất/i.test(statusText);
    if(!keepStopStatus) statusMsgEl.textContent = "";
  }
  if(bestEffortStopPending && metric && !metric.hidden){
    const live = String(metric.textContent || "").trim();
    if(live && !/đang nhận lịch tốt nhất/i.test(live)){
      metric.textContent = "Đang nhận lịch tốt nhất · " + live;
      metric.title = metric.textContent;
    }
  }
  if(btn && !window.__AUTO_SORT_STOP_REQUESTED && !bestEffortStopPending && n < 100){
    btn.disabled = false;
    setAutoSortStopAccessibleState(false);
  }else if(btn && bestEffortStopPending){
    btn.disabled = true;
    setAutoSortStopAccessibleState(true);
  }
}

function finishAutoSortProgress(label, state){
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



/* [REMOVED] Section: xep_lai */



/* [REMOVED] Section: panel_and_constraints */

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
    || !!String(window.__TKB_ACTIVE_BACKEND_JOB_ID || "").trim();
}

async function saveAndBack(){
  const btn = document.getElementById("btnHome") || document.querySelector("button[onclick*='saveAndBack']");
  if(btn) btn.disabled = true;
  __tkbNavigatingHome = true;
  try{
    if(isAutoSortRunningForNavigation()){
      try{
        _setStatus("Lượt xếp vẫn tiếp tục trên máy chủ; khi quay lại hệ thống sẽ tự nối lại.", "info");
      }catch(_){ }
    }
    try{
      const result = saveStore({force:true, awaitRemote:true, skipIfUnchanged:true});
      if(result && typeof result.then === "function"){
        await Promise.race([
          result,
          new Promise(resolve => setTimeout(resolve, 800))
        ]);
      }
    }catch(e){
      console.warn("saveAndBack remote save warning", e);
      try{ saveStore({force:true, syncRemote:false}); }catch(_){}
    }
  }finally{
    backToMain();
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

/* 31/08: "In TKB" luôn là XUẤT EXCEL (tkb-student-excel-export.js). Trước đây nếu module đó không nạp
   được lúc mở trang (mạng chập chờn, tải hụt một file) thì các nhánh dưới lặng lẽ rơi về window.print()
   → người dùng thấy hộp "In / Lưu PDF" và tưởng tính năng đổi. Nay: thử nạp lại module đúng một lần,
   vẫn không có thì báo rõ và KHÔNG in PDF thay thế. */
const PRINT_EXPORT_MODULE_FILE = "tkb-student-excel-export.js";
function __printExportModuleSrc(){
  let src = PRINT_EXPORT_MODULE_FILE;
  try{
    const tag = Array.from(document.scripts || []).find(el => /tkb-student-excel-export\.js/.test(String(el.src || "")));
    if(tag && tag.src) src = tag.src;
  }catch(_){ }
  return `${src}${src.includes("?") ? "&" : "?"}retry=${Date.now()}`;
}

function ensurePrintExportFn(name){
  if(typeof window[name] === "function") return Promise.resolve(window[name]);
  if(!window.__TKB_PRINT_EXPORT_RELOAD){
    window.__TKB_PRINT_EXPORT_RELOAD = new Promise(resolve => {
      let done = false;
      const finish = () => { if(done) return; done = true; resolve(); };
      try{
        const el = document.createElement("script");
        el.src = __printExportModuleSrc();
        el.onload = finish;
        el.onerror = finish;
        (document.head || document.body).appendChild(el);
        setTimeout(finish, 8000);
      }catch(_){ finish(); }
    }).finally(() => { window.__TKB_PRINT_EXPORT_RELOAD = null; });
  }
  return window.__TKB_PRINT_EXPORT_RELOAD.then(() => (typeof window[name] === "function" ? window[name] : null));
}

function runPrintExport(name, label, fallback){
  try{ if(typeof _setStatus === "function") _setStatus(`Đang chuẩn bị ${label}...`, "info"); }catch(_){ }
  return ensurePrintExportFn(name).then(fn => {
    if(fn) return fn();
    if(typeof fallback === "function"){
      const r = fallback();
      if(r !== null && r !== undefined) return r;
    }
    const msg = `Chưa tải được module ${label} (mạng chập chờn khi mở trang?). Hãy tải lại trang (F5) rồi bấm In TKB lại.`;
    try{ if(typeof _setStatus === "function") _setStatus(msg, "error"); }catch(_){ }
    alert(msg);
    return null;
  });
}

function printCurrentClassTKB(){
  const id = String(currentLop || getFilteredLops()[0]?.id || "");
  if(!id){
    alert("Chưa có lớp để in.");
    return;
  }
  if(VIEW_MODE !== "lop") setViewMode("lop");
  if(String(currentLop || "") !== id) selectLop(id);
  return runPrintExport("exportCurrentClassTKBExcel", "xuất Excel TKB lớp học", () => {
    if(typeof window.exportCurrentClassTKBDocx === "function") return window.exportCurrentClassTKBDocx();
    return null;
  });
}

function printTeacherTKBTemplate1(){
  return runPrintExport("exportTeacherTKBExcelTemplate1", "xuất Excel TKB giáo viên (mẫu 1)");
}

function printTeacherTKBTemplate2(){
  return runPrintExport("exportTeacherTKBExcelTemplate2", "xuất Excel TKB giáo viên (mẫu 2)");
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
  if(key === "school-class") return runPrintExport("exportSchoolClassTKBExcel", "xuất Excel TKB toàn trường theo lớp học");
  if(key === "school-teacher") return runPrintExport("exportSchoolTeacherTKBExcel", "xuất Excel TKB toàn trường theo giáo viên");
  if(key === "industry-database"){
    if(typeof window.exportIndustryDatabaseExcel === "function") return window.exportIndustryDatabaseExcel();
    return alert("Chưa tải xong module chuyển CSDL ngành.");
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





/* [REMOVED] Section: optimize_improvements */

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
      // 19/08: giu nguyen giao vien da ghim (khi dang soi mot van de tu bang
      // thong ke). Truoc day dong duoi day am tham thay bang list[0] khien
      // luoi hien SAI giao vien so voi tieu de.
      const pinned = String(window.__TKB_PAIR_PINNED_GV || "").trim();
      if(pinned){
        currentGV = pinned;
        return currentGV;
      }
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
        const classCanon = getLopCanonById(l?.id);
        for(const row of requiredSubjectsForClass(l)){
          const monName = String(row?.mon || row?.ten || "").trim();
          const teacher = classAssignmentStatisticsTeacherForClassMon(classCanon, monName);
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
      const view = tkbTeacherCellView(arr);
      const conflict = view.conflict;
      const teacherOff = isTeacherFixedOff(gvCode, thu, buoi, ti);
      const offConflict = teacherOff && arr.length > 0;
      const fixed = !teacherOff && arr.length > 0 && arr.some(e=>!!e.fixed);
      const lines = view.entries.map(e=>{
        const monShort = tkbMonLabel(e.classId, e.mon);
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
      const one = view.entries.length === 1 ? view.entries[0] : null;   // ô tiết chung gộp -> thao tác theo lớp đầu, các lớp còn lại đồng bộ
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

    function pvValidateSupportDrop(td, opts){
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
      let res;
      try{
        currentLop = info.classId;
        res = validateDrop(td, info.mon);
      }finally{
        currentLop = oldLop;
      }
      if(!res || !res.ok) return res || {ok:false, reason:"runtime"};

      // 13/09: tiết bị đè (của lớp ở ô này / trùng GV-phòng ở lớp khác) chuyển được sang ô
      // cũ -> đổi chỗ (ô xanh), không đưa về "Chưa phân".
      const occupied = cellMon(targetVal);
      if(info.type === "cell" && ((occupied && occupied !== info.mon) || res.warn)){
        // lượt 4: tiết đang có đè tiết khác -> chỉ hợp lệ khi đổi chỗ được
        const from = tkbSwapSlot({thu:info.fromThu, buoi:info.fromBuoi, ti:info.fromTi});
        const swapRes = tkbSwapAwareResult(res, info.classId, from, tkbSwapSlot(td.dataset), info.mon, opts);
        if(swapRes.swapBlocked && opts && opts.fresh) swapRes.msg = tkbSwapBlockedNote(td, info.classId, res);
        return swapRes;
      }

      // O tren luoi GV trong khong co nghia la o cua LOP cung trong. Khong hoi
      // truoc thi tiet cu cua lop se bi ghi de am tham.
      if(occupied && occupied !== info.mon){
        const lopCanon = getLopCanonById(info.classId);
        const extra = `Ô này của lớp ${lopCanon} đang có ${getMonShort(occupied)}.\n`+
          `Nếu tiếp tục, tiết đó sẽ được đưa về "Chưa phân".`;
        return Object.assign({}, res, {
          warn: true,
          msg: res.msg || `Lớp ${lopCanon} đang có ${getMonShort(occupied)} ở tiết này.`,
          confirmText: res.confirmText
            ? (res.confirmText + "\n\n" + extra)
            : (extra + "\n\nBạn có muốn tiếp tục không?")
        });
      }
      return res;
    }

    // applyDragVisual nằm ngoài closure này nhưng cần đúng bộ kiểm tra của bảng
    // phụ để tô sẵn màu cho ô GV ngay khi bắt đầu kéo.
    window.__tkbValidateSupportDrop = pvValidateSupportDrop;

    function pvApplySupportDrop(td){
      const info = pvPairDragInfo();
      if(!info) return;
      const thu = td.dataset.thu;
      const buoi = td.dataset.buoi;
      const ti = Number(td.dataset.ti);
      let res = pvValidateSupportDrop(td, {fresh:true});
      if(!res.ok && maybeRaiseSessionLimitForDrop(td, info.mon, res)){
        res = pvValidateSupportDrop(td, {fresh:true});
      }
      if(!res.ok){
        flashInvalid(td);
        showDropError(res, td);
        return;
      }
      if(res.swap){
        tkbApplyDropSwap(res.swap, td);
        return;
      }
      if(res.warn){
        const ok = confirm(res.confirmText || buildReplaceConfirmText(res.conflicts || []));
        if(!ok){
          flashInvalid(td);
          return;
        }
        if(Array.isArray(res.conflicts) && res.conflicts.length) clearConflictSlots(res.conflicts);
      }

      const tkb = DATA?.tkb?.[info.classId];
      if(!tkb?.[thu]?.[buoi]) return;
      if(info.type === "cell" && info.fromThu && info.fromBuoi && Number.isFinite(info.fromTi)){
        tkb[info.fromThu][info.fromBuoi][info.fromTi] = "";
      }
      tkb[thu][buoi][ti] = info.val || info.mon;

      try{ saveStoreDeferred(); }catch(e){ console.error('saveStore failed', e); }
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
          let res = DRAG_VALIDATE_CACHE.get(td);
          if(!res){
            res = pvValidateSupportDrop(td, {deadline: Date.now() - 1});
            DRAG_VALIDATE_CACHE.set(td, res);
          }
          setDropHint(td, res.ok && !res.warn);
        };
        td.ondragenter = (e)=>{
          if(!dragData) return;
          // lượt 8: huỷ cả dragenter (xem bindCells) — không thì thả lúc con trỏ vừa đổi phần tử con bị từ chối
          try{ if(e) e.preventDefault(); }catch(_){ }
          td.classList.add("drag-over");
        };
        td.ondragleave = (e)=>{
          if(e && e.relatedTarget && td.contains(e.relatedTarget)) return;
          releaseDragOver(td);
        };
        td.ondrop = (e)=>{
          if(!dragData) return;
          try{ e.preventDefault(); }catch(_){}
          pvApplySupportDrop(td);
        };
      });
    }

    /* ===== "Chua phan" cua GIAO VIEN (pane duoi) =====
       Danh sach PHANG "9A6 - GDTC x2" (khong xo theo lop), chi liet ke tiet
       cua giao vien dang xem. Item keo ra dat dragData.type = "mon" kem
       classId nen di thang vao duong drop san co cua pane GV
       (pvPairDragInfo -> pvValidateSupportDrop). */

    function pvTeacherUnassignedHTML(){
      // Nướng sẵn trạng thái mở vào markup để không chớp tắt khi pane re-render.
      const open = pvGvUnassignedMenuOpen === true;
      return `<div id="gvUnassignedBar" class="unassigned-dropdown unassigned-dropdown-gv${open ? " is-open" : ""}" aria-label="Chưa phân của giáo viên">
        <button id="gvUnassignedToggle" class="unassigned-dropdown-btn" type="button" onclick="toggleTeacherUnassignedDropdown(event)" aria-expanded="${open ? "true" : "false"}">
          <span id="gvUnassignedSummary">Chưa phân:0</span>
          <span class="unassigned-caret">v</span>
        </button>
        <div id="gvMonList" class="unassigned-menu unassigned-menu-gv"${open ? "" : " hidden"}></div>
      </div>`;
    }

    // Trang thai mo mong muon, song sot qua re-render (nhu ban cua pane lop).
    let pvGvUnassignedMenuOpen = false;

    function pvSetTeacherUnassignedOpen(open){
      const root = document.getElementById("gvUnassignedBar");
      const btn = document.getElementById("gvUnassignedToggle");
      const menu = document.getElementById("gvMonList");
      if(!root || !btn || !menu) return;
      const shouldOpen = !!open && !btn.disabled;
      pvGvUnassignedMenuOpen = shouldOpen;
      root.classList.toggle("is-open", shouldOpen);
      menu.hidden = !shouldOpen;
      btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    }

    window.closeTeacherUnassignedDropdown = function(){
      pvSetTeacherUnassignedOpen(false);
    };

    window.toggleTeacherUnassignedDropdown = function(ev){
      try{ ev?.preventDefault(); ev?.stopPropagation(); }catch(_){ }
      const menu = document.getElementById("gvMonList");
      if(!menu) return;
      pvSetTeacherUnassignedOpen(menu.hidden);
    };

    if(!window.__TKB_GV_UNASSIGNED_DROPDOWN_BOUND){
      window.__TKB_GV_UNASSIGNED_DROPDOWN_BOUND = true;
      document.addEventListener("pointerdown", ev=>{
        if(ev.target?.closest?.("#gvUnassignedBar")) return;
        try{ pvSetTeacherUnassignedOpen(false); }catch(_){ }
      }, true);
    }

    function pvTeacherUnassignedTasks(gvCode){
      const code = (gvCode || "").toString().trim();
      if(!code) return [];
      const classOrder = new Map();
      (Array.isArray(DATA.lop) ? DATA.lop : []).forEach((lop, index)=>{
        classOrder.set(String(lop?.id || ""), index);
      });
      // Thứ tự CỐ ĐỊNH: lớp từ trên xuống theo bảng Lớp học, trong mỗi lớp môn
      // theo đúng thứ tự bảng "Môn học" trong phần app. Không kéo lớp đang
      // chọn lên đầu nữa (đổi lớp làm danh sách nhảy chỗ, khó theo dõi).
      return collectUnassignedTasks({})
        .filter(t => teacherValueHas(t.gv, code))
        .sort((a,b)=>{
          const ac = String(a.classId || "");
          const bc = String(b.classId || "");
          const ai = classOrder.has(ac) ? classOrder.get(ac) : 999999;
          const bi = classOrder.has(bc) ? classOrder.get(bc) : 999999;
          if(ai !== bi) return ai - bi;
          return compareMonByMonHocOrder(a.mon, b.mon);
        });
    }

    function pvLoadTeacherUnassigned(gvCode){
      const box = document.getElementById("gvMonList");
      const btn = document.getElementById("gvUnassignedToggle");
      const summary = document.getElementById("gvUnassignedSummary");
      if(!box || !btn || !summary) return;
      box.innerHTML = "";

      const code = (gvCode || currentGV || "").toString().trim();
      let tasks = [];
      try{
        tasks = pvTeacherUnassignedTasks(code);
      }catch(err){
        console.error("[phanmon] teacher unassigned failed", err);
      }

      const totalRemain = tasks.reduce((sum,t)=>sum + Number(t.remain || 0), 0);
      summary.textContent = `Chưa phân:${totalRemain}`;
      btn.disabled = totalRemain <= 0;
      if(btn.disabled){
        pvSetTeacherUnassignedOpen(false);
        return;
      }

      // Danh sách PHẲNG "9A6 - GDTC x2": nhìn là kéo được ngay, không phải mở
      // thêm một cấp xổ xuống theo từng lớp nữa. (tasks đã sort: lớp đang chọn
      // trước, rồi theo thứ tự lớp trong dữ liệu.)
      tasks.forEach(t=>{
        const d = document.createElement("div");
        d.className = "mon-item";
        d.dataset.mon = t.mon;
        d.dataset.classid = String(t.classId);

        const clsName = (t.className || getLopCanonById(t.classId) || t.classId || "").toString();
        const monShort = tkbMonLabel(t.classId, t.mon);
        const roomTxt = (t.room||"").toString().trim();
        const remainDisp = Number(t.remain || 0) > 1 ? ` x${Number(t.remain || 0)}` : "";
        d.innerHTML = `<span class="mon-item-main">${escapeHtml(clsName)} - ${escapeHtml(monShort)}${escapeHtml(remainDisp)}</span>`+
                      `<span class="mon-item-meta">${escapeHtml(roomTxt ? ` (${roomTxt})` : "")}</span>`;
        d.title = `${clsName} - ${t.mon}`;

        d.onclick = ()=>{
          // Dua lop cua tiet nay len bang tren; pvEnsureTeacherForClass giu
          // nguyen currentGV nen bang duoi van la giao vien dang xem.
          // Giu menu mo de nguoi dung keo tiep nhieu tiet.
          if(String(currentLop || "") === String(t.classId)) return;
          selectLop(t.classId);
        };

        d.draggable = true;
        d.ondragstart = (e)=>{
          if(isPlannerBusySolving()){ try{ e.preventDefault(); }catch(_){ } return; }
          dragMon = t.mon;
          dragData = { type:"mon", classId: t.classId, mon: t.mon };
          setNativeDragTransfer(e, t.mon);
          applyDragVisual(dragMon, null);
        };
        d.ondragend = ()=>{
          clearDragVisual();
          dragData = null;
          dragMon = "";
        };

        box.appendChild(d);
      });

      // Bar vua duoc dung lai (mac dinh dong): khoi phuc trang thai mo truoc do.
      if(pvGvUnassignedMenuOpen) pvSetTeacherUnassignedOpen(true);
    }

    function pvTeacherSummaryHTML(gvCode){
      return pvTeacherUnassignedHTML() + pvTeacherStatsHTML(gvCode);
    }

    function pvUpdateTeacherSupport(classId){
      const root = document.getElementById("tkbPairSupport");
      if(!root) return;
      const gv = pvEnsureTeacherForClass(classId);
      const teachers = pvAllTeacherCodes(pvTeachersForClass(classId));
      const tools = pvSelectHTML("pairTeacherSelect", teachers, gv, pvTeacherLabel, "pairSelectTeacher(this.value)");
      root.innerHTML = pvPane("TKB giáo viên", tools, pvTeacherTableHTML(gv), "support", pvTeacherSummaryHTML(gv));
      pvBindSupportNav(root);
      pvBindTeacherSupportDrag(root);
      pvLoadTeacherUnassigned(gv);
    }

    window.pairSelectTeacher = function(code){
      // Nguoi dung tu chon giao vien -> bo ghim cua che do soi thong ke.
      window.__TKB_PAIR_PINNED_GV = "";
      currentGV = (code || "").toString().trim();
      if(VIEW_MODE === "lop") pvUpdateTeacherSupport(currentLop);
      else renderCurrentView();
    };

    window.pairSelectRoom = function(room){
      currentPhong = (room || "").toString().trim();
      renderCurrentView();
    };

    window.pairSelectClass = function(classId){
      window.__TKB_PAIR_PINNED_GV = "";
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
        box.insertAdjacentHTML("beforeend", `<div id="tkbPairSupport">${pvPane("TKB giáo viên", tools, pvTeacherTableHTML(gv), "support", pvTeacherSummaryHTML(gv))}</div>`);
        pvLoadTeacherUnassigned(gv);
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


