/* ============================================================
   LOAD PAGE — xem modules/admin-nav.js
============================================================ */

/* ============================================================
   LOCAL STORAGE INIT
============================================================ */
// ============================================================
// B1 STORAGE (SQLite/sql.js + IndexedDB) — tách theo TRƯỜNG
// Mỗi trường = 1 DB riêng trong IndexedDB (không lẫn dữ liệu)
// URL: /?school=TruongA
// ============================================================
let __kv = null;

// LocalStorage backup per school (đảm bảo dữ liệu không bị "mất trắng" khi KVDB/sql.js lỗi)
function _lsKey(schoolId){
    const SC = window.TKBSchool;
    if(SC && SC.lsKey) return SC.lsKey(schoolId || CTX.schoolId || getSchoolId());
    return `TKB_STORE::${_sanitizeSchoolId(schoolId || CTX.schoolId || getSchoolId())}`;
}

function _safeParseJSON(raw, fallback){
    const SC = window.TKBSchool;
    if(SC && SC.safeParseJSON) return SC.safeParseJSON(raw, fallback);
    try{
        return raw ? JSON.parse(raw) : (fallback ?? {});
    }catch(e){
        console.warn("JSON parse failed; reset to empty", e);
        return (fallback ?? {});
    }
}

function _stripVietnameseMarks(x){
    const SC = window.TKBSchool;
    if(SC && SC.stripVietnameseMarks) return SC.stripVietnameseMarks(x);
    return (x || "").toString();
}

function _sanitizeSchoolId(x){
    const SC = window.TKBSchool;
    if(SC && SC.sanitizeSchoolId) return SC.sanitizeSchoolId(x);
    x = (x || "default").toString().trim();
    x = _stripVietnameseMarks(x).replace(/[^0-9a-zA-Z]+/g, "").toLowerCase();
    if (!x) x = "default";
    return x;
}

function _legacySanitizeSchoolId(x){
    const SC = window.TKBSchool;
    if(SC && SC.legacySanitizeSchoolId) return SC.legacySanitizeSchoolId(x);
    x = (x || "").toString().trim();
    x = x.replace(/[^0-9a-zA-Z_\-]/g, "_");
    return x || "";
}

function _legacyUpperSanitizeSchoolId(x){
    const SC = window.TKBSchool;
    if(SC && SC.legacyUpperSanitizeSchoolId) return SC.legacyUpperSanitizeSchoolId(x);
    return (x || "").toString().trim().toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_-]/g, "").slice(0, 40) || "";
}

function _schoolNameMap(){
    const SC = window.TKBSchool;
    if(SC && SC.schoolNameMap) return SC.schoolNameMap();
    return _safeParseJSON(localStorage.getItem("TKB_SCHOOL_NAMES"), {});
}

function _getSchoolName(sid){
    const SC = window.TKBSchool;
    if(SC && SC.getSchoolName) return SC.getSchoolName(sid);
    const key = _sanitizeSchoolId(sid);
    const map = _schoolNameMap();
    const v = map ? map[key] : "";
    return (v == null) ? "" : String(v);
}

function _schoolStoreScore(sid){
    const SC = window.TKBSchool;
    if(SC && SC.schoolStoreScore) return SC.schoolStoreScore(sid);
    try{
        const key = `TKB_STORE::${_sanitizeSchoolId(sid)}`;
        const raw = localStorage.getItem(key);
        if(!raw) return 0;
        const data = JSON.parse(raw);
        if(!data || typeof data !== "object") return 0;
        let score = 1;
        if(Array.isArray(data.lop)) score += data.lop.length * 20;
        if(Array.isArray(data.giaovien)) score += data.giaovien.length * 8;
        if(Array.isArray(data.monhoc)) score += data.monhoc.length * 6;
        if(Array.isArray(data.mon)) score += data.mon.length * 4;
        if(data.pccmMatrix && typeof data.pccmMatrix === "object") score += Object.keys(data.pccmMatrix).length * 3;
        if(data.tkb && typeof data.tkb === "object") score += Object.keys(data.tkb).length * 2;
        return score;
    }catch(e){
        return 0;
    }
}

function _discoverStoredSchoolIds(){
    const SC = window.TKBSchool;
    if(SC && SC.discoverStoredSchoolIds) return SC.discoverStoredSchoolIds();
    const ids = [];
    const add = (value)=>{
        const raw = (value == null) ? "" : String(value).trim();
        if(!raw) return;
        const sid = _sanitizeSchoolId(raw);
        if(!sid || ids.includes(sid)) return;
        ids.push(sid);
    };
    try{
        const list = _safeParseJSON(localStorage.getItem("TKB_SCHOOL_LIST"), []);
        if(Array.isArray(list)) list.forEach(add);
    }catch(e){ /* ignore */ }
    try{
        for(let i = 0; i < localStorage.length; i++){
            const key = String(localStorage.key(i) || "");
            const match = key.match(/^TKB_STORE::(.+)$/);
            if(match) add(match[1]);
        }
    }catch(e){ /* ignore */ }
    return ids;
}

function _setSchoolName(sid, name){
    const SC = window.TKBSchool;
    if(SC && SC.setSchoolName) return SC.setSchoolName(sid, name);
    const key = _sanitizeSchoolId(sid);
    const n = (name||"").toString().trim();
    if(!key || !n) return;
    const map = _schoolNameMap();
    map[key] = n;
    try{ localStorage.setItem("TKB_SCHOOL_NAMES", JSON.stringify(map)); }catch(e){ /* ignore */ }
}

function _deleteSchoolName(sid){
    const key = _sanitizeSchoolId(sid);
    if(!key) return;
    const map = _schoolNameMap();
    if(map && Object.prototype.hasOwnProperty.call(map, key)){
        delete map[key];
        try{ localStorage.setItem("TKB_SCHOOL_NAMES", JSON.stringify(map)); }catch(e){ /* ignore */ }
    }
}

function _copySchoolStorageAlias(oldSid, newSid, displayName){
    const oldKey = (oldSid == null) ? "" : String(oldSid).trim();
    const nextKey = _sanitizeSchoolId(newSid);
    if(!oldKey || !nextKey || oldKey === nextKey) return false;

    let changed = false;
    try{
        const from = `TKB_STORE::${oldKey}`;
        const to = `TKB_STORE::${nextKey}`;
        const raw = localStorage.getItem(from);
        if(raw && !localStorage.getItem(to)){
            localStorage.setItem(to, raw);
            changed = true;
        }
    }catch(e){ /* ignore */ }

    try{
        const map = _schoolNameMap();
        const name = (displayName || map[oldKey] || "").toString().trim();
        if(name && !map[nextKey]){
            map[nextKey] = name;
            localStorage.setItem("TKB_SCHOOL_NAMES", JSON.stringify(map));
            changed = true;
        }
    }catch(e){ /* ignore */ }

    try{
        const list = _safeParseJSON(localStorage.getItem("TKB_SCHOOL_LIST"), []);
        if(Array.isArray(list)){
            const next = [];
            let touched = false;
            list.forEach(item=>{
                const raw = String(item || "").trim();
                if(!raw) return;
                const clean = (raw === oldKey || _legacySanitizeSchoolId(raw) === oldKey || _legacyUpperSanitizeSchoolId(raw) === oldKey) ? nextKey : _sanitizeSchoolId(raw);
                if(!next.includes(clean)) next.push(clean);
                if(clean !== raw) touched = true;
            });
            if(!next.includes(nextKey)) next.push(nextKey);
            if(touched || !list.includes(nextKey)){
                localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(next));
                changed = true;
            }
        }
    }catch(e){ /* ignore */ }

    try{
        const last = String(localStorage.getItem("TKB_LAST_SCHOOL") || "").trim();
        if(last === oldKey || _legacySanitizeSchoolId(last) === oldKey || _legacyUpperSanitizeSchoolId(last) === oldKey){
            localStorage.setItem("TKB_LAST_SCHOOL", nextKey);
            changed = true;
        }
    }catch(e){ /* ignore */ }

    return changed;
}

function _migrateSchoolAliasesToCleanId(cleanSid, aliases, displayName){
    const sid = _sanitizeSchoolId(cleanSid);
    if(!sid) return;
    if(displayName) _setSchoolName(sid, displayName);
    const values = new Set();
    (aliases || []).forEach(v=>{
        const raw = (v == null) ? "" : String(v).trim();
        if(!raw) return;
        values.add(raw);
        const legacy = _legacySanitizeSchoolId(raw);
        if(legacy) values.add(legacy);
        const legacyUpper = _legacyUpperSanitizeSchoolId(raw);
        if(legacyUpper) values.add(legacyUpper);
    });
    values.forEach(oldSid=>_copySchoolStorageAlias(oldSid, sid, displayName));
}

function _migrateNamedSchoolIdsToCleanIds(){
    try{
        const map = _schoolNameMap();
        Object.entries(map || {}).forEach(([oldSid, name])=>{
            const clean = _sanitizeSchoolId(name || oldSid);
            if(clean) _migrateSchoolAliasesToCleanId(clean, [oldSid], name);
        });
    }catch(e){ /* ignore */ }
}

function _prettySchoolLabel(x){
    return (x||"").toString().trim()
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function _getSchoolContextFromURL(){
    try{
        const u = new URL(window.location.href);
        return {
            sid: String(u.searchParams.get("sid") || "").trim(),
            school: String(u.searchParams.get("school") || "").trim()
        };
    }catch(e){
        return { sid: "", school: "" };
    }
}

let CTX = { schoolId: "", schoolLabel: "" };

function _getFirstStoredSchoolId(){
    try{
        const list = _discoverStoredSchoolIds();
        let fallback = "";
        let best = "";
        let bestScore = -1;
        if(Array.isArray(list)){
            for(const item of list){
                const sid = _sanitizeSchoolId(item);
                if(!sid) continue;
                if(sid !== "default"){
                    const score = _schoolStoreScore(sid);
                    if(!best || score > bestScore){
                        best = sid;
                        bestScore = score;
                    }
                    continue;
                }
                fallback = fallback || sid;
            }
        }
        return best || fallback;
    }catch(e){
        return "";
    }
}

function _setSchoolUrlParams(url, sid, label){
    const safeSid = _sanitizeSchoolId(sid);
    const display = _prettySchoolLabel(label || _getSchoolName(safeSid) || safeSid) || safeSid;
    if(display && _sanitizeSchoolId(display) !== display) _setSchoolName(safeSid, display);
    url.searchParams.set("sid", safeSid);
    return url;
}

function _cleanSchoolUrlParams(){
    try{
        const u = new URL(window.location.href);
        if(!u.searchParams.has("sid") && !u.searchParams.has("school")) return;
        u.searchParams.delete("sid");
        u.searchParams.delete("school");
        history.replaceState(null, "", u.toString());
    }catch(e){ /* ignore */ }
}

function _findManagedScheduleContext(sid){
    const cleanSid = _sanitizeSchoolId(sid);
    if(!cleanSid || !window.TKBAuth || !window.TKBAuth.loadRegistry) return null;
    try{
        const reg = window.TKBAuth.loadRegistry();
        const schools = reg.schools || {};
        for(const schoolId of Object.keys(schools)){
            const school = schools[schoolId];
            if(!school) continue;
            const list = Array.isArray(school.schedules) ? school.schedules : [];
            const entry = list.find(item => _sanitizeSchoolId(item && item.sid) === cleanSid);
            if(entry) return { schoolId, school, entry };
            if(_sanitizeSchoolId(schoolId) === cleanSid) return { schoolId, school, entry: null };
        }
    }catch(_){ }
    return null;
}

function getSchoolId(){
    if(window.TKBAuth){
        const authCtx = window.TKBAuth.currentUser();
        if(authCtx && authCtx.session && authCtx.session.schoolId && authCtx.user.role !== "superadmin"){
            const lockedSid = _sanitizeSchoolId(authCtx.session.schoolId);
            const reg = window.TKBAuth.loadRegistry();
            const school = reg.schools[lockedSid];
            const label = school?.name || _getSchoolName(lockedSid) || lockedSid;
            // Mặc định tài khoản của trường luôn mở TKB hiện hành; URL chỉ được
            // dùng khi trỏ tới một phiên bản TKB hợp lệ của chính trường đó.
            let activeSid = lockedSid;
            try{
                const urlCtx = _getSchoolContextFromURL();
                const urlSid = _sanitizeSchoolId(urlCtx.sid || urlCtx.school || "");
                const schedules = window.TKBAuth.listSchoolSchedules(lockedSid);
                const validSids = schedules.map(s => _sanitizeSchoolId(s && s.sid)).filter(Boolean);
                const activeEntry = window.TKBAuth.activeScheduleEntry
                    ? window.TKBAuth.activeScheduleEntry(lockedSid)
                    : null;
                const activeEntrySid = _sanitizeSchoolId(activeEntry && activeEntry.sid);
                if(activeEntrySid && validSids.includes(activeEntrySid)){
                    activeSid = activeEntrySid;
                }
                if(urlSid && validSids.includes(urlSid)){
                    activeSid = urlSid;
                }
                if(activeSid && activeSid !== urlSid){
                    const u = new URL(window.location.href);
                    _setSchoolUrlParams(u, activeSid, label);
                    history.replaceState(null, "", u.toString());
                }
            }catch(_){}
            CTX.schoolId = activeSid;
            CTX.schoolLabel = _prettySchoolLabel(label) || label;
            try{
                localStorage.setItem("TKB_LAST_SCHOOL", activeSid);
                localStorage.setItem("TKB_LAST_SCHOOL_LABEL", CTX.schoolLabel);
                if(typeof addSchoolToList === "function") addSchoolToList(activeSid);
            }catch(_){}
            return activeSid;
        }

        // Super admin: được chọn mọi trường (kể cả "default"). Luôn tôn trọng
        // lựa chọn từ URL rồi tới trường mở gần nhất, KHÔNG tự nhảy sang trường khác.
        if(authCtx && authCtx.user && authCtx.user.role === "superadmin"){
            const urlCtx = _getSchoolContextFromURL();
            const rawUrl = urlCtx.sid || urlCtx.school || "";
            const urlSid = rawUrl ? _sanitizeSchoolId(rawUrl) : "";
            const rawLast = localStorage.getItem("TKB_LAST_SCHOOL") || "";
            const lastSid = rawLast ? _sanitizeSchoolId(rawLast) : "";
            let sid = urlSid || lastSid || "default";
            const managedCtx = _findManagedScheduleContext(sid);
            const scheduleLabel = managedCtx && managedCtx.entry
                ? `TKB ${managedCtx.entry.label || managedCtx.entry.number || ""}`.trim()
                : "";
            const label = managedCtx
                ? [managedCtx.school?.name || managedCtx.schoolId || sid, scheduleLabel].filter(Boolean).join(" - ")
                : (_getSchoolName(sid) || (sid === "default" ? "Default" : sid));
            CTX.schoolId = sid;
            CTX.schoolLabel = _prettySchoolLabel(label) || label;
            try{
                localStorage.setItem("TKB_LAST_SCHOOL", sid);
                localStorage.setItem("TKB_LAST_SCHOOL_LABEL", CTX.schoolLabel);
                if(typeof addSchoolToList === "function") addSchoolToList(sid);
            }catch(_){}
            return sid;
        }
    }

    _migrateNamedSchoolIdsToCleanIds();

    const urlCtx = _getSchoolContextFromURL();
    const rawUrlSid = urlCtx.sid || "";
    const rawUrlSchool = urlCtx.school || "";
    const fromUrlSid = rawUrlSid ? _sanitizeSchoolId(rawUrlSid) : "";
    const fromUrlSchool = rawUrlSchool ? _sanitizeSchoolId(rawUrlSchool) : "";
    const rawLastSid = localStorage.getItem("TKB_LAST_SCHOOL") || "";
    const rawLastLabel = localStorage.getItem("TKB_LAST_SCHOOL_LABEL") || "";
    const lastSid = rawLastSid ? _sanitizeSchoolId(rawLastSid) : "";
    const lastLabelSid = rawLastLabel ? _sanitizeSchoolId(rawLastLabel) : "";

    if(lastLabelSid && lastLabelSid !== "default"){
        _migrateSchoolAliasesToCleanId(lastLabelSid, [rawLastSid, rawLastLabel], rawLastLabel);
    }

    const listedSid = _getFirstStoredSchoolId();
    const fromLSKey = lastSid || listedSid || "default";
    const schoolId = _sanitizeSchoolId(
        fromUrlSchool ||
        fromUrlSid ||
        lastLabelSid ||
        fromLSKey ||
        "default"
    );

    let label = "";
    if(rawUrlSchool){
        const raw = String(rawUrlSchool).trim();
        if(raw && _sanitizeSchoolId(raw) !== raw){
            label = _prettySchoolLabel(raw) || raw;
            _setSchoolName(schoolId, label);
        }
    }
    if(!label && rawLastLabel && (lastSid === schoolId || lastLabelSid === schoolId)){
        label = _prettySchoolLabel(rawLastLabel) || rawLastLabel;
    }

    if(!label){
        label = _getSchoolName(schoolId) || schoolId;
    }

    _migrateSchoolAliasesToCleanId(schoolId, [
        rawUrlSid,
        rawUrlSchool,
        fromUrlSid,
        fromUrlSchool,
        rawLastSid,
        rawLastLabel,
        listedSid
    ], label);

    CTX.schoolId = schoolId;
    CTX.schoolLabel = _prettySchoolLabel(label || schoolId) || schoolId;

    try{
        localStorage.setItem("TKB_LAST_SCHOOL", schoolId);
        localStorage.setItem("TKB_LAST_SCHOOL_LABEL", CTX.schoolLabel);
    }catch(e){ /* ignore */ }

    // đảm bảo trường hiện tại luôn có trong danh sách trường
    try{ if(typeof addSchoolToList === "function") addSchoolToList(schoolId); }catch(_){ /* ignore */ }
    _cleanSchoolUrlParams();
    return schoolId;
}

function getSchoolLabel(){
    // Đảm bảo CTX được set
    if(!CTX.schoolId) getSchoolId();
    return CTX.schoolLabel || _prettySchoolLabel(CTX.schoolId) || CTX.schoolId || "default";
}

function getDbName(){
    return `TKB::SCHOOL::${getSchoolId()}`;
}

// DATA sẽ được nạp trong appBoot()
let DATA = {};

/* ============================================================
   EXCEL-LIKE TABLE UX (ROW SELECT + INLINE EDIT)
   - Click: select
   - Ctrl/Cmd + Click: toggle multi-select
   - Shift + Click: range select
   - Double click: edit row inline
============================================================ */
let TABLE_SELECTION = {};   // { section: Set(index) }
let TABLE_LAST_INDEX = {};  // { section: lastClickedIndex }
let INLINE_EDIT = { section: "", index: -1 };

function ensureDataShape(){
    ["khoi","lop","giaovien","monhoc","mon","phong"].forEach(sec=>{
        if (!Array.isArray(DATA[sec])) DATA[sec]=[];
    });
    (DATA.lop || []).forEach(lop=>{
        if(!lop || typeof lop !== "object") return;
        delete lop.buoi;
        delete lop.buoihoc;
        delete lop.session;
        delete lop.shift;
    });
    (DATA.monhoc || []).forEach(mon=>{
        if(!mon || typeof mon !== "object") return;
        delete mon.giaoan;
    });
    if (!DATA.pccmMatrix) DATA.pccmMatrix={};
    DATA.pccmRoomMatrix = {};

    // (NEW) Lưu riêng số tiết/giới hạn theo Lớp|Môn để màn "Sắp xếp TKB" lấy đúng từ "Bảng phân công"
    // key: "Lop|Mon" -> "4" (string)
    if (!DATA.pccmTietMatrix) DATA.pccmTietMatrix = {};
    if (!DATA.pccmGioihanMatrix) DATA.pccmGioihanMatrix = {};
}

function syncClassAvailabilityIntegrity(){
    let changed = false;
    const classes = Array.isArray(DATA.lop) ? DATA.lop.filter(lop=>lop && typeof lop === "object") : [];
    const validAliases = new Set();
    const addAlias = value => {
        legacyClassNameAliases(value).forEach(alias=>{
            const key = _normText(alias).toLowerCase();
            if(key) validAliases.add(key);
        });
    };
    classes.forEach(lop=>{
        addAlias(lop.id);
        addAlias(lop.ten);
        addAlias(lop.ten2);
        addAlias(classCanonFromLop(lop));
    });

    const pruneMap = (owner, field) => {
        if(!owner || typeof owner !== "object") return;
        const current = owner[field];
        if(current == null) return;
        if(!current || typeof current !== "object" || Array.isArray(current)){
            owner[field] = {};
            changed = true;
            return;
        }
        Object.keys(current).forEach(rawId=>{
            const key = _normText(rawId).toLowerCase();
            if(!key || !validAliases.has(key)){
                delete current[rawId];
                changed = true;
            }
        });
    };

    pruneMap(DATA, "tkbUserOff");
    const fixedOff = DATA.tkbConstraints && typeof DATA.tkbConstraints === "object"
        ? DATA.tkbConstraints.fixedOff
        : null;
    pruneMap(fixedOff, "class");
    return changed;
}

/* ============================================================
   ĐỒNG BỘ DỮ LIỆU (LIÊN KẾT CÁC BẢNG)
   - Khi Môn / Lớp / Giáo viên bị xoá → các bảng phụ thuộc phải trống
   - Khi chỉ xoá 1 phần → tự động dọn rác (orphan) theo dữ liệu còn lại
============================================================ */
function syncDerivedDataIntegrity(){
    let changed = false;

    const hasMonHoc = Array.isArray(DATA.monhoc) && DATA.monhoc.length > 0;
    const hasLop    = Array.isArray(DATA.lop) && DATA.lop.length > 0;
    const hasGV     = Array.isArray(DATA.giaovien) && DATA.giaovien.length > 0;

    changed = syncClassAvailabilityIntegrity() || changed;

    // ===== valid sets =====
    const classNormSet = new Set((DATA.lop || [])
        .map(canonTen2FromLop)
        .filter(Boolean));

    const classAliasToCanon = new Map();
    (DATA.lop || []).forEach(lop => {
        const canon = canonTen2FromLop(lop);
        if (!canon) return;
        [canon, lop?.ten, lop?.ten2, lop?.id].forEach(v => {
            classLookupCandidates(v).forEach(alias => {
                const key = _normText(alias).toLowerCase();
                if (key) classAliasToCanon.set(key, canon);
            });
        });
    });

    const classIdSet = new Set((DATA.lop || [])
        .map(l => String(l.id))
        .filter(Boolean));

    const monAliasSet = new Set();
    (DATA.monhoc || []).forEach(m => {
        [m.ten, m.ma, m.ma2].forEach(v => {
            const s = _normText(v).toLowerCase();
            if (s) monAliasSet.add(s);
        });
    });
    // Thêm cả các key mà PCCM có thể lưu (mã nếu có)
    try{
        (buildPCCMMonList() || []).forEach(x => {
            [x.key, x.ten, x.code, x.ma, x.ma2].forEach(v => {
                const s = _normText(v).toLowerCase();
                if (s) monAliasSet.add(s);
            });
        });
    }catch(_){ /* ignore */ }

    const gvCodeSet = new Set((DATA.giaovien || [])
        .map(g => _normText(g.magv).toUpperCase())
        .filter(Boolean));

    const pruneObj = (obj, keepFn) => {
        if (!obj || typeof obj !== "object") return false;
        let ch = false;
        Object.keys(obj).forEach(k => {
            try{
                if (!keepFn(k, obj[k])){
                    delete obj[k];
                    ch = true;
                }
            }catch(_){
                delete obj[k];
                ch = true;
            }
        });
        return ch;
    };

    const normalizeClassSubjectKeys = (obj) => {
        if (!obj || typeof obj !== "object") return false;
        let ch = false;
        Object.keys(obj).forEach(k => {
            const parts = String(k).split("|");
            if (parts.length < 2){
                delete obj[k];
                ch = true;
                return;
            }
            const cls = _normText(parts[0]).toLowerCase();
            const mon = _normText(parts.slice(1).join("|"));
            const canon = classAliasToCanon.get(cls);
            if (!canon || !mon){
                delete obj[k];
                ch = true;
                return;
            }
            const nextKey = `${canon}|${mon}`;
            if (nextKey !== k){
                if (obj[nextKey] == null || _normText(obj[nextKey]) === "") obj[nextKey] = obj[k];
                delete obj[k];
                ch = true;
            }
        });
        return ch;
    };

    const classCanonToKhoi = new Map();
    (DATA.lop || []).forEach(lop => {
        const canon = canonTen2FromLop(lop);
        const khoi = _normText(lop?.khoi) || ("Khối " + extractKhoiNumber(canon));
        if (canon && khoi) classCanonToKhoi.set(canon, khoi);
    });

    const findPccmMonObj = (monKey) => {
        const k = _normText(monKey).toLowerCase();
        return (DATA.monhoc || []).find(m => {
            return [_normText(m?.ten), _normText(m?.ma), _normText(m?.ma2), _normText(m?.id)]
                .map(v => v.toLowerCase())
                .some(v => v && v === k);
        }) || { key: monKey, ten: monKey, ma: "", ma2: "" };
    };

    const initializeAssignedPccmPeriods = () => {
        const periodMatrix = DATA.pccmTietMatrix;
        const limitMatrix = DATA.pccmGioihanMatrix;
        const teacherMatrix = DATA.pccmMatrix;
        if (!teacherMatrix || typeof teacherMatrix !== "object") return false;
        let ch = false;
        Object.entries(teacherMatrix).forEach(([key, teacherValue]) => {
            if (!pccmTeacherListFromValue(teacherValue).length) return;
            const parts = String(key).split("|");
            if (parts.length < 2) return;
            const rawClass = _normText(parts.shift());
            const monKey = _normText(parts.join("|"));
            const cls = classAliasToCanon.get(rawClass.toLowerCase()) || rawClass;
            const khoiName = classCanonToKhoi.get(cls);
            if (!cls || !monKey || !khoiName) return;
            const monObj = findPccmMonObj(monKey);
            const tc = lookupTietChuan(khoiName, monObj);
            if (!tc) return;

            // Tiết chuẩn is only the initial seed.  Once a teacher assignment
            // exists, persist an explicit class/subject value so later edits
            // to DATA.mon cannot silently rewrite an already agreed PCCM row.
            if (pccmGetNumberFromMatrix(periodMatrix, cls, monObj) == null){
                const periods = _normText(tc.sotiet);
                if (_toPositiveNumberOrZero(periods) > 0){
                    periodMatrix[key] = periods;
                    ch = true;
                }
            }
            if (pccmGetNumberFromMatrix(limitMatrix, cls, monObj) == null){
                const limit = _normText(tc.gioihan || "1");
                if (_toPositiveNumberOrZero(limit) > 0){
                    limitMatrix[key] = limit;
                    ch = true;
                }
            }
        });
        return ch;
    };

    const clearObjIfNotEmpty = (field) => {
        if (DATA[field] && typeof DATA[field] === "object" && Object.keys(DATA[field]).length){
            DATA[field] = {};
            changed = true;
        }
    };

    // ===== 1) PCCM & phụ thuộc =====
    // Nếu thiếu 1 trong 3 dữ liệu cốt lõi → phân công phải trống
    if (!hasMonHoc || !hasLop || !hasGV){
        clearObjIfNotEmpty("pccmMatrix");
        clearObjIfNotEmpty("pccmRoomMatrix");
        clearObjIfNotEmpty("pccmTietMatrix");
        clearObjIfNotEmpty("pccmGioihanMatrix");
    } else {
        const keepKeyByClassMon = (key) => {
            const parts = String(key).split("|");
            if (parts.length < 2) return false;
            const classCandidates = classLookupCandidates(parts[0]);
            const mon = _normText(parts.slice(1).join("|")).toLowerCase();
            if (!classCandidates.some(cls => classNormSet.has(cls))) return false;
            if (!mon || !monAliasSet.has(mon)) return false;
            return true;
        };

        changed = normalizeClassSubjectKeys(DATA.pccmMatrix) || changed;
        changed = normalizeClassSubjectKeys(DATA.pccmRoomMatrix) || changed;
        changed = normalizeClassSubjectKeys(DATA.pccmTietMatrix) || changed;
        changed = normalizeClassSubjectKeys(DATA.pccmGioihanMatrix) || changed;

        changed = pruneObj(DATA.pccmMatrix, (k, v) => {
            if (!keepKeyByClassMon(k)) return false;
            const teachers = pccmTeacherListFromValue(v);
            if (!teachers.length) return false; // rỗng thì coi như chưa phân công → xoá key
            return teachers.every(gv => gvCodeSet.has(_normText(gv).toUpperCase()));
        }) || changed;

        changed = initializeAssignedPccmPeriods() || changed;

        changed = pruneObj(DATA.pccmRoomMatrix, (k, v) => {
            if (!keepKeyByClassMon(k)) return false;
            const room = _normText(v);
            return room !== ""; // rỗng thì bỏ
        }) || changed;

        changed = pruneObj(DATA.pccmTietMatrix, (k, v) => {
            if (!keepKeyByClassMon(k)) return false;
            const n = Number(String(v).trim());
            return Number.isFinite(n) && n > 0;
        }) || changed;

        changed = pruneObj(DATA.pccmGioihanMatrix, (k, v) => {
            if (!keepKeyByClassMon(k)) return false;
            const n = Number(String(v).trim());
            return Number.isFinite(n) && n > 0;
        }) || changed;
    }

    // ===== 2) Tiết chuẩn =====
    // Nếu không có Môn hoặc Lớp → tiết chuẩn trở về mặc định (trống, sẽ auto-sync lại khi nạp mới)
    if (!hasMonHoc || !hasLop){
        if (Array.isArray(DATA.mon) && DATA.mon.length){
            DATA.mon = [];
            changed = true;
        }
    } else {
        // Dọn các dòng tiết chuẩn không còn thuộc môn hiện tại
        if (Array.isArray(DATA.mon) && DATA.mon.length){
            const before = DATA.mon.length;
            DATA.mon = DATA.mon.filter(r => {
                const ten = _normText(r.ten).toLowerCase();
                return ten && monAliasSet.has(ten);
            });
            if (DATA.mon.length !== before) changed = true;
        }
    }

    // ===== 3) TKB theo lớp (id) =====
    if (!hasLop){
        if (DATA.tkb && typeof DATA.tkb === "object" && Object.keys(DATA.tkb).length){
            DATA.tkb = {};
            changed = true;
        }
    } else {
        if (!DATA.tkb || typeof DATA.tkb !== "object") DATA.tkb = {};
        Object.keys(DATA.tkb).forEach(id => {
            if (!classIdSet.has(String(id))){
                delete DATA.tkb[id];
                changed = true;
            }
        });
    }

    return changed;
}

function saveStore(options){
    const opts = options || {};
    // DATA is mutated in place throughout the app. Drop PCCM's derived lookup
    // indexes before serializing so an autosave followed by a badge refresh or
    // tab switch always sees the just-edited values.
    try{ pccmInvalidateLookupCache(); }catch(_){ /* PCCM module not initialized yet */ }
    const sid = CTX.schoolId || getSchoolId();
    const json = JSON.stringify(DATA);

    try{
        localStorage.setItem(_lsKey(sid), json);
    }catch(e){
        console.warn("saveStore localStorage failed", e);
    }

    if(window.TKBStorage && typeof window.TKBStorage.saveSchoolData === "function"){
        const pending = Promise.resolve(window.TKBStorage.saveSchoolData(__kv, sid, json)).then(ok => {
            return ok !== false;
        }).catch(e => {
            console.warn("saveStore remote/local helper failed", e);
            if(opts.throwOnError) throw e;
            return false;
        });
        return pending;
    }

    try{
        if (__kv) __kv.set("DATA_JSON", json);
    }catch(e){
        console.warn("saveStore KVDB failed", e);
    }
    return Promise.resolve(true);
}

function updateSchoolBadge(){
    const badge = document.getElementById("schoolBadgeText");
    if (badge) badge.textContent = `Trường: ${getSchoolLabel()}`;
}

function showPendingSchoolPopup(){
    let message = "";
    try{
        message = sessionStorage.getItem("TKB_SCHOOL_POPUP") || "";
        if(message) sessionStorage.removeItem("TKB_SCHOOL_POPUP");
    }catch(e){ /* ignore */ }
    if(message) window.setTimeout(()=>showBottomPopup(message, "ok"), 0);
}

// Nút đổi trường trên UI
function changeSchool(){
    const cur = CTX.schoolId || getSchoolId();
    const next = prompt("Nhập mã trường (ví dụ: TruongA, TruongB). Mỗi mã là 1 dữ liệu riêng:", cur);
    if (next === null) return;
    if (!String(next || "").trim()){
        showBottomPopup("Nhập mã trường.", "warning");
        return;
    }
    const sid = _sanitizeSchoolId(next);
    // lưu tên hiển thị (có thể có dấu)
    try{ if(_sanitizeSchoolId(next) !== String(next).trim()) _setSchoolName(sid, String(next).trim()); }catch(_){ }
    try{
        const label = _prettySchoolLabel(_getSchoolName(sid) || String(next).trim() || sid);
        sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã mở trường ${label}.`);
    }catch(e){ /* ignore */ }
    // giữ lại path, đổi param school
    const u = new URL(window.location.href);
    _setSchoolUrlParams(u, sid, _getSchoolName(sid) || String(next).trim() || sid);
    window.location.href = u.toString();
}

// Mở trang Sắp xếp TKB và mang theo schoolId để dùng đúng dữ liệu trường.
async function openTKBPlanner(){
    const u = new URL("/pages/sapxep", window.location.origin);
    const sid = getSchoolId();
    _setSchoolUrlParams(u, sid, getSchoolLabel());
    const btn = document.querySelector("button[onclick*='openTKBPlanner']") || document.querySelector(".btn-planner");
    if(btn) btn.disabled = true;
    try{
        try{
            const pending = saveStore();
            if(pending && typeof pending.then === "function"){
                await Promise.race([
                    pending,
                    new Promise(resolve => setTimeout(resolve, 800))
                ]);
            }
        }catch(saveErr){
            console.warn("openTKBPlanner saveStore warning", saveErr);
        }
    }finally{
        window.location.href = u.toString();
    }
}



async function appBoot(){
    // mở DB theo schoolId
    const schoolId = getSchoolId();
    CTX.schoolId = schoolId;

    // Super admin: "default" là TKB riêng, độc lập. Dọn dữ liệu bị copy nhầm
    // từ store toàn cục (dữ liệu trường thật) vào default ở các phiên trước.
    try{
        if(_isSuperAdmin() && schoolId === "default"){
            const defaultKey = _lsKey("default");
            const globalRaw = localStorage.getItem("TKB_STORE");
            if(globalRaw && localStorage.getItem(defaultKey) === globalRaw){
                localStorage.removeItem(defaultKey);
                try{ await _kvdbDeleteDbByName(`TKB::SCHOOL::default`); }catch(_){}
            }
        }
    }catch(_){}

    // Ưu tiên lấy từ server SQLite; localStorage/KVDB chỉ là cache dự phòng.
    let loadedViaSharedStorage = false;
    if(window.TKBStorage && typeof window.TKBStorage.loadSchoolData === "function"){
        try{
            const loaded = await window.TKBStorage.loadSchoolData(schoolId, getDbName());
            loadedViaSharedStorage = true;
            __kv = loaded.kv || null;
            DATA = loaded.data || {};
        }catch(e){
            console.warn("Server-backed storage load failed; fallback to local/KVDB", e);
        }
    }

    const rawLS = localStorage.getItem(_lsKey(schoolId));

    if (!loadedViaSharedStorage && (!DATA || !Object.keys(DATA).length)) {
      if (window.KVDB) {
        try{
            __kv = await window.KVDB.open(getDbName());
            let raw = await __kv.get("DATA_JSON");

            // Nếu KVDB trống nhưng localStorage có dữ liệu => nạp từ backup và seed lại KVDB
            if (!raw && rawLS) {
                raw = rawLS;
                try{ await __kv.set("DATA_JSON", raw); }catch(e){ /* ignore */ }
            }

            DATA = _safeParseJSON(raw, {});
        }catch(e){
            console.warn("KVDB init/load failed; fallback to localStorage", e);
            __kv = null;
            DATA = _safeParseJSON(rawLS, {});
        }
      } else {
        // không có KVDB (thiếu sql.js) => dùng localStorage theo trường
        DATA = _safeParseJSON(rawLS, {});
      }
    }

    ensureDataShape();

    // Đồng bộ dữ liệu giữa các bảng: nếu thiếu Môn/Lớp/GV thì các bảng phụ thuộc (phân công, tiết chuẩn...) phải trống.
    // Đồng thời tự dọn các liên kết mồ côi khi người dùng xoá / nạp lại dữ liệu.
    try{
        const changed = syncDerivedDataIntegrity();
        if (changed) saveStore();
    }catch(e){
        console.warn("syncDerivedDataIntegrity failed", e);
    }
    updateSchoolBadge();
    showPendingSchoolPopup();
    loadPage("khoi");
}

/* ============================================================
   KHỐI HỌC — EXTRACT NUMBER (Ví dụ: "Khối 6" → "6")
============================================================ */
function extractKhoiNumber(str){
    return (str+"").match(/\d+/)?.[0] || "";
}

const QUICK_KHOI_LEVELS = {
    TH: {
        label: "Tiểu học",
        numbers: [1, 2, 3, 4, 5]
    },
    THCS: {
        label: "THCS",
        numbers: [6, 7, 8, 9]
    },
    THPT_GDTX: {
        label: "THPT (GDTX)",
        numbers: [10, 11, 12]
    }
};

const DIA_DIEM_OPTIONS = Array.from({ length: 10 }, (_, i) => `Địa điểm ${i + 1}`);
const DEFAULT_DIA_DIEM = DIA_DIEM_OPTIONS[0];

function getKhoiLevelPreset(level){
    const key = (level || "").toString().trim().toUpperCase();
    if (key === "THPT") return QUICK_KHOI_LEVELS.THPT_GDTX;
    return QUICK_KHOI_LEVELS[key] || null;
}

function renderDiaDiemOptions(value){
    const selectedValue = _normText(value) || DEFAULT_DIA_DIEM;
    const options = DIA_DIEM_OPTIONS.slice();
    if (selectedValue && !options.includes(selectedValue)) options.unshift(selectedValue);
    return options
        .map(item => `<option value="${escapeHtml(item)}" ${item === selectedValue ? "selected" : ""}>${escapeHtml(item)}</option>`)
        .join("");
}

function khoiNumberKey(value){
    const raw = extractKhoiNumber(value);
    if (!raw) return "";
    const n = Number(raw);
    return Number.isFinite(n) ? String(n) : raw;
}

function quickAddKhoiByLevel(level){
    const preset = getKhoiLevelPreset(level);
    if (!preset) return;

    if (!Array.isArray(DATA.khoi)) DATA.khoi = [];

    const existingNumbers = new Set(
        (DATA.khoi || [])
            .map(row => khoiNumberKey(_normText(row?.ten || row?.makhoi || "")))
            .filter(Boolean)
    );

    let added = 0;
    preset.numbers.forEach(num => {
        const key = String(num);
        if (existingNumbers.has(key)) return;
        DATA.khoi.push({
            id: autoID("khoi"),
            ten: `Khối ${num}`,
            makhoi: `K${num}`
        });
        existingNumbers.add(key);
        added++;
    });

    if (added){
        saveStore();
        TABLE_SELECTION.khoi = new Set();
        TABLE_LAST_INDEX.khoi = -1;
        INLINE_EDIT = { section:"", index:-1 };
        renderSectionInto("khoi", "section-content", document);
        showBottomPopup(`Đã thêm ${added} khối cho cấp ${preset.label}.`, "ok");
    } else {
        showBottomPopup(`Cấp ${preset.label} đã có đủ khối.`, "info");
    }
}

function ensureKhoiNameExists(khoiName){
    const name = _normText(khoiName);
    const numKey = khoiNumberKey(name);
    if (!name || !numKey) return false;

    if (!Array.isArray(DATA.khoi)) DATA.khoi = [];

    const exists = (DATA.khoi || []).some(row => {
        const rowName = _normText(row?.ten || row?.makhoi || "");
        return khoiNumberKey(rowName) === numKey || rowName.toLowerCase() === name.toLowerCase();
    });
    if (exists) return false;

    DATA.khoi.push({
        id: autoID("khoi"),
        ten: `Khối ${numKey}`,
        makhoi: `K${numKey}`
    });
    return true;
}

const MAX1_CLASS_LIMIT = 39;

function schoolRecordForCurrentStore(){
    try{
        const A = window.TKBAuth;
        if(!A || typeof A.loadRegistry !== "function") return null;
        const ctx = typeof A.currentUser === "function" ? A.currentUser() : null;
        const reg = ctx?.registry || A.loadRegistry() || {};
        const schools = reg.schools || {};
        const sessionSchoolId = String(ctx?.session?.schoolId || ctx?.user?.schoolId || "").trim();
        if(sessionSchoolId && schools[sessionSchoolId]) return schools[sessionSchoolId];
        const clean = value => _sanitizeSchoolId(value || "");
        const target = clean(CTX.schoolId || getSchoolId());
        return Object.entries(schools).find(([id, school]) => {
            if(clean(id) === target || clean(school?.id) === target) return true;
            if(clean(school?.shortId) === target) return true;
            return (Array.isArray(school?.schedules) ? school.schedules : [])
                .some(entry => clean(entry?.sid) === target);
        })?.[1] || null;
    }catch(_){
        return null;
    }
}

function max1ClassLimitForCurrentStore(){
    try{
        const A = window.TKBAuth;
        const school = schoolRecordForCurrentStore();
        const plan = school && typeof A?.effectivePlan === "function" ? A.effectivePlan(school) : null;
        return plan?.id === "max1" ? MAX1_CLASS_LIMIT : null;
    }catch(_){
        return null;
    }
}

function ensureClassCapacity(nextCount){
    const limit = max1ClassLimitForCurrentStore();
    if(!limit || Number(nextCount || 0) <= limit) return true;
    alert("Gói Max 1 hỗ trợ tối đa 39 lớp. Vui lòng nâng cấp Max 2 để tạo hoặc import từ 40 lớp.");
    return false;
}

function quickAddLopFromInputs(){
    const prefix = _normText(document.getElementById("quick_lop_prefix")?.value || "");
    const letter = _normText(document.getElementById("quick_lop_letter")?.value || "").replace(/\s+/g, "").toUpperCase();
    const countRaw = _normText(document.getElementById("quick_lop_count")?.value || "");
    const diaDiem = _normText(document.getElementById("quick_lop_diadiem")?.value || "") || DEFAULT_DIA_DIEM;
    const count = Number(countRaw);
    const khoiNum = khoiNumberKey(prefix);

    if (!prefix || !Number.isInteger(count) || count <= 0){
        showBottomPopup("Nhập tiền tố và số lớp.", "warning");
        return;
    }
    if (!khoiNum){
        showBottomPopup("Tiền tố cần có số khối, ví dụ 6 hoặc 10.", "warning");
        return;
    }

    if (!Array.isArray(DATA.lop)) DATA.lop = [];

    const existing = new Set(
        (DATA.lop || [])
            .map(row => normalizeClassName(classCanonFromLop(row)))
            .filter(Boolean)
    );
    const khoiName = `Khối ${khoiNum}`;
    const candidates = [];
    let skipped = 0;

    for (let i = 1; i <= count; i++){
        const className = `${prefix}${letter}${i}`;
        const classKey = normalizeClassName(className);
        if (existing.has(classKey)){
            skipped++;
            continue;
        }
        candidates.push({
            ten: className,
            ten2: className,
            khoi: khoiName,
            diadiem: diaDiem
        });
        existing.add(classKey);
    }

    if (!candidates.length){
        showBottomPopup("Các lớp này đã có sẵn.", "info");
        return;
    }
    if(!ensureClassCapacity(DATA.lop.length + candidates.length)) return;
    // Generate each ID only when the preceding candidate is already present.
    // `autoID()` scans DATA.lop, so assigning IDs while merely collecting the
    // candidates would give every row in the batch the same ID.
    candidates.forEach(candidate => {
        candidate.id = autoID("lop");
        DATA.lop.push(candidate);
    });
    const added = candidates.length;

    const addedKhoi = ensureKhoiNameExists(khoiName);
    saveStore();
    TABLE_SELECTION.lop = new Set();
    TABLE_LAST_INDEX.lop = -1;
    INLINE_EDIT = { section:"", index:-1 };
    renderSectionInto("lop", "section-content", document);

    const tail = [
        skipped ? `Bỏ qua ${skipped} lớp đã có.` : "",
        addedKhoi ? `Đã thêm ${khoiName}.` : ""
    ].filter(Boolean).join(" ");
    showBottomPopup(`Đã thêm ${added} lớp. ${tail}`.trim(), "ok");
}

function normalizeMaGV2Part(value){
    const text = (value ?? "")
        .toString()
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    if (!text) return "";
    return text
        .split(/\s+/)
        .map(part => part.charAt(0).toLocaleUpperCase("vi-VN") + part.slice(1).toLocaleLowerCase("vi-VN"))
        .join("");
}

function maGV2CodeKey(value){
    return (value ?? "")
        .toString()
        .trim()
        .normalize("NFC")
        .toLocaleUpperCase("vi-VN");
}

function teacherHoLotInitialParts(hodem){
    return (hodem ?? "")
        .toString()
        .trim()
        .split(/\s+/)
        .map(part => normalizeMaGV2Part(part).charAt(0))
        .filter(Boolean);
}

function teacherHoLotInitials(hodem){
    return teacherHoLotInitialParts(hodem).join("");
}

function teacherLeadingInitial(hodem){
    return teacherHoLotInitialParts(hodem)[0] || "";
}

function joinMaGV2Parts(parts){
    return (parts || []).filter(Boolean).join(".");
}

function buildMaGV2Base(teacher, rule){
    const initial = teacherLeadingInitial(teacher?.hodem);
    const ten = normalizeMaGV2Part(teacher?.ten);
    const key = (rule || "").toString();

    if (key === "ten_holot"){
        return joinMaGV2Parts([ten, initial]) || "GV";
    }
    if (key === "ten"){
        return ten || initial || "GV";
    }
    return joinMaGV2Parts([initial, ten]) || ten || initial || "GV";
}

function buildAutoMaGVBase(teacher){
    const initials = teacherHoLotInitialParts(teacher?.hodem).join(".");
    const ten = normalizeMaGV2Part(teacher?.ten);
    return joinMaGV2Parts([initials, ten]) || ten || initials || "GV";
}

function uniqueTeacherCodeFromBase(base, usedCodes){
    const cleanBase = (base ?? "")
        .toString()
        .split(".")
        .map(part => normalizeMaGV2Part(part))
        .filter(Boolean)
        .join(".") || "GV";
    let code = cleanBase;
    let suffix = 1;
    while (usedCodes.has(maGV2CodeKey(code))){
        suffix++;
        code = `${cleanBase}.${suffix}`;
    }
    usedCodes.add(maGV2CodeKey(code));
    return code;
}

function autoFillMissingMaGVForTeachers(teachers){
    const rows = Array.isArray(teachers) ? teachers : [];
    if (!rows.length) return 0;

    const usedCodes = new Set();
    (DATA.giaovien || []).forEach(gv => {
        const code = maGV2CodeKey(gv?.magv);
        if (code) usedCodes.add(code);
    });
    rows.forEach(gv => {
        const code = maGV2CodeKey(gv?.magv);
        if (code) usedCodes.add(code);
    });

    let filled = 0;
    rows.forEach(gv => {
        if (_normText(gv?.magv)) return;
        const base = buildAutoMaGVBase(gv);
        gv.magv = uniqueTeacherCodeFromBase(base, usedCodes);
        filled++;
    });
    return filled;
}

function buildUniqueMaGV2Codes(rule){
    const used = new Set();
    const counts = new Map();
    return (DATA.giaovien || []).map(gv => {
        const base = buildMaGV2Base(gv, rule);
        const baseKey = maGV2CodeKey(base);
        let suffix = counts.get(baseKey) || 0;
        let code = suffix === 0 ? base : `${base}${suffix}`;
        while (used.has(maGV2CodeKey(code))){
            suffix = Math.max(1, suffix + 1);
            code = `${base}${suffix}`;
        }
        counts.set(baseKey, suffix + 1);
        used.add(maGV2CodeKey(code));
        return code;
    });
}

function quickCreateMaGV2(){
    const rule = _normText(document.getElementById("quick_gv_magv2_rule")?.value || "");
    const ruleLabels = {
        holot_ten: "Ký tự đầu . Tên . Số thứ tự nếu trùng",
        ten_holot: "Tên . ký tự đầu . Số thứ tự nếu trùng",
        ten: "Tên . Số thứ tự nếu trùng"
    };

    if (!rule || !ruleLabels[rule]){
        showBottomPopup("Chọn quy tắc tạo MaGV2.", "warning");
        return;
    }
    if (!Array.isArray(DATA.giaovien) || !DATA.giaovien.length){
        showBottomPopup("Chưa có giáo viên để tạo MaGV2.", "warning");
        return;
    }

    const message = `Tạo/cập nhật MaGV2 cho ${DATA.giaovien.length} giáo viên theo quy tắc:\n${ruleLabels[rule]}\n\nMaGV hiện tại vẫn giữ nguyên.`;
    if (!confirm(message)) return;

    const codes = buildUniqueMaGV2Codes(rule);
    DATA.giaovien.forEach((gv, idx) => {
        gv.magv2 = codes[idx] || "";
    });

    saveStore();
    TABLE_SELECTION.giaovien = new Set();
    TABLE_LAST_INDEX.giaovien = -1;
    INLINE_EDIT = { section:"", index:-1 };
    renderSectionInto("giaovien", "section-content", document);
    showBottomPopup(`Đã tạo MaGV2 cho ${DATA.giaovien.length} giáo viên.`, "ok");
}

function quickSubjectPresets(){
    return (window.TKB_QUICK_SUBJECT_PRESETS && typeof window.TKB_QUICK_SUBJECT_PRESETS === "object")
        ? window.TKB_QUICK_SUBJECT_PRESETS
        : {};
}

function quickSubjectPreset(level){
    const key = (level || "").toString().trim().toUpperCase();
    return quickSubjectPresets()[key] || null;
}

const SUBJECT_LEVEL_LABELS = ["Tiểu học", "THCS", "THPT (GDTX)"];

function subjectLevelLabelFromKey(value){
    const raw = _normText(value);
    const key = raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
    if (!key) return "";
    if (key.includes("tieu") || key === "th") return "Tiểu học";
    if (key.includes("thcs")) return "THCS";
    if (key.includes("thpt") || key.includes("gdtx")) return "THPT (GDTX)";
    return "";
}

function khoiLevelLabel(khoiName){
    const n = Number(khoiNumberKey(khoiName));
    if (!Number.isFinite(n)) return "";
    if (n >= 1 && n <= 5) return "Tiểu học";
    if (n >= 6 && n <= 9) return "THCS";
    if (n >= 10 && n <= 12) return "THPT (GDTX)";
    return "";
}

function subjectLevelLabels(value){
    const raw = _normText(value);
    if (!raw) return [];
    const found = [];
    SUBJECT_LEVEL_LABELS.forEach(label => {
        if (raw.toLowerCase().includes(label.toLowerCase())) found.push(label);
    });
    raw.split(/[,;|/]+/).forEach(part => {
        const label = subjectLevelLabelFromKey(part);
        if (label && !found.includes(label)) found.push(label);
    });
    return SUBJECT_LEVEL_LABELS.filter(label => found.includes(label));
}

function normalizeSubjectLevelText(value){
    const labels = subjectLevelLabels(value);
    return labels.length ? labels.join(", ") : _normText(value);
}

function mergeSubjectLevelLabel(current, label){
    const labels = subjectLevelLabels(current);
    const next = subjectLevelLabelFromKey(label) || _normText(label);
    if (next && !labels.includes(next)) labels.push(next);
    return SUBJECT_LEVEL_LABELS.filter(item => labels.includes(item)).join(", ") || _normText(current) || next;
}

function monhocLevelText(monhocRow){
    return _normText(monhocRow?.caphoc || monhocRow?.khoi || "");
}

function monhocAppliesToKhoi(monhocRow, khoiName){
    const levels = subjectLevelLabels(monhocLevelText(monhocRow));
    if (!levels.length) return true;
    const khoiLevel = khoiLevelLabel(khoiName);
    return !!khoiLevel && levels.includes(khoiLevel);
}

function quickAddMonHocByLevel(level){
    const preset = quickSubjectPreset(level);
    if (!preset){
        showBottomPopup("Chưa tải được dữ liệu môn học mẫu.", "error");
        return;
    }

    if (!Array.isArray(DATA.monhoc)) DATA.monhoc = [];
    if (!Array.isArray(DATA.mon)) DATA.mon = [];

    const subjectIndex = new Map();
    (DATA.monhoc || []).forEach((row, idx) => {
        const keys = [_normText(row?.ma), _normText(row?.ma2), _normText(row?.ten)]
            .filter(Boolean)
            .map(x => x.toLowerCase());
        keys.forEach(key => {
            if (!subjectIndex.has(key)) subjectIndex.set(key, idx);
        });
    });

    let addedSubjects = 0;
    let updatedSubjects = 0;
    (preset.subjects || []).forEach(item => {
        const ten = _normText(item?.ten);
        const ma = _normText(item?.ma);
        if (!ten || !ma) return;
        const idx = subjectIndex.get(ma.toLowerCase()) ?? subjectIndex.get(ten.toLowerCase());
        if (idx === undefined){
            const row = { id: autoID("monhoc"), caphoc: preset.label, ten, ma };
            DATA.monhoc.push(row);
            const newIdx = DATA.monhoc.length - 1;
            [ten, ma].forEach(v => subjectIndex.set(v.toLowerCase(), newIdx));
            addedSubjects++;
            return;
        }
        const row = DATA.monhoc[idx];
        let changed = false;
        if (!_normText(row.ten)){ row.ten = ten; changed = true; }
        if (!_normText(row.ma)){ row.ma = ma; changed = true; }
        const mergedLevel = mergeSubjectLevelLabel(row.caphoc, preset.label);
        if (_normText(row.caphoc) !== mergedLevel){ row.caphoc = mergedLevel; changed = true; }
        if (changed) updatedSubjects++;
    });

    const subjectAliasToCode = new Map();
    (preset.subjects || []).forEach(item => {
        const ten = _normText(item?.ten);
        const ma = _normText(item?.ma);
        if (!ma) return;
        subjectAliasToCode.set(ma.toLowerCase(), ma);
        if (ten) subjectAliasToCode.set(ten.toLowerCase(), ma);
    });
    const canonPresetSubjectCode = (value)=>{
        const raw = _normText(value);
        if (!raw) return "";
        return subjectAliasToCode.get(raw.toLowerCase()) || raw;
    };

    const standardIndex = new Map();
    (DATA.mon || []).forEach((row, idx) => {
        const ten = canonPresetSubjectCode(row?.ten);
        const key = `${_normText(row?.khoi).toLowerCase()}|${ten.toLowerCase()}`;
        if (key !== "|") standardIndex.set(key, idx);
    });

    let addedStandards = 0;
    let updatedStandards = 0;
    (preset.standards || []).forEach(item => {
        const khoi = _normText(item?.khoi);
        const ten = canonPresetSubjectCode(item?.ten);
        if (!khoi || !ten) return;
        const sotiet = _normText(item?.sotiet);
        const gioihan = _normText(item?.gioihan);
        const key = `${khoi.toLowerCase()}|${ten.toLowerCase()}`;
        const idx = standardIndex.get(key);
        if (idx === undefined){
            DATA.mon.push({
                id: autoID("mon"),
                khoi,
                ten,
                sotiet,
                gioihan
            });
            standardIndex.set(key, DATA.mon.length - 1);
            addedStandards++;
            return;
        }
        const row = DATA.mon[idx];
        let changed = false;
        if (_normText(row.khoi) !== khoi){ row.khoi = khoi; changed = true; }
        if (_normText(row.ten) !== ten){ row.ten = ten; changed = true; }
        if (_normText(row.sotiet) !== sotiet){ row.sotiet = sotiet; changed = true; }
        if (_normText(row.gioihan) !== gioihan){ row.gioihan = gioihan; changed = true; }
        if (changed) updatedStandards++;
    });

    saveStore();
    TABLE_SELECTION.monhoc = new Set();
    TABLE_LAST_INDEX.monhoc = -1;
    INLINE_EDIT = { section:"", index:-1 };
    renderSectionInto("monhoc", "section-content", document);
    showBottomPopup(
        `Đã tạo ${preset.label}: thêm ${addedSubjects} môn, cập nhật ${updatedSubjects}; tiết chuẩn thêm ${addedStandards}, cập nhật ${updatedStandards}.`,
        "ok"
    );
}

/* ============================================================
   CHUẨN HOÁ TÊN LỚP — giữ đúng mã lớp từ Excel/index (vd 6/1)
============================================================ */
function normalizeClassName(name){
    if (!name) return "";
    name = name.toString().trim();

    // 6.1 / 6-1 / 6_1 -> 6/1; KHÔNG đổi thành 6A1 nữa.
    let m = name.match(/^(\d+)[\.\-_/ ]+(\d+)$/);
    if (m) return `${m[1]}/${Number(m[2])}`;

    // 6A01 → 6A1
    let m2 = name.match(/^(\d+)A0?(\d+)$/i);
    if (m2) return `${m2[1]}A${m2[2]}`.toUpperCase();

    return name.replace(/\s+/g, "").toUpperCase();
}

function legacyClassNameAliases(name){
    const raw = (name || "").toString().trim();
    const aliases = [];
    const add = v => {
        const s = (v || "").toString().trim();
        if(s && !aliases.includes(s)) aliases.push(s);
    };
    add(raw);
    add(normalizeClassName(raw));
    let m = raw.match(/^(\d+)[\.\-_/ ]+(\d+)$/);
    if(m) add(`${m[1]}A${Number(m[2])}`.toUpperCase());
    let a = raw.match(/^(\d+)A0?(\d+)$/i);
    if(a) add(`${a[1]}/${Number(a[2])}`);
    return aliases;
}

function classLookupCandidates(name){
    const rawAliases = legacyClassNameAliases(name);
    const out = [];
    const add = v => {
        const s = (v || "").toString().trim();
        if(s && !out.includes(s)) out.push(s);
    };
    rawAliases.forEach(add);

    // Fast path used by the Phân công renderer. The indexed lists retain DATA.lop
    // order and the same alias order as the legacy scan below.
    if (PCCM_LOOKUP_CACHE){
        rawAliases.forEach(alias=>{
            const own = PCCM_LOOKUP_CACHE.classAliases.get(String(alias || "").toLowerCase());
            (own || []).forEach(add);
        });
        return out;
    }

    const rawSet = new Set(rawAliases.map(a => a.toLowerCase()));
    (DATA.lop || []).forEach(lop=>{
        const vals = [
            classCanonFromLop(lop),
            lop?.ten,
            lop?.ten2,
            lop?.id
        ].filter(Boolean);
        const own = [];
        vals.forEach(v=>legacyClassNameAliases(v).forEach(a=>{
            if(a && !own.includes(a)) own.push(a);
        }));
        if(own.some(a => rawSet.has(a.toLowerCase()))) own.forEach(add);
    });
    return out;
}

function classCanonFromLop(l){
    const ten = (l && l.ten ? String(l.ten) : "").trim();
    const ten2 = (l && l.ten2 ? String(l.ten2) : "").trim();
    const id = (l && l.id ? String(l.id) : "").trim();
    return ten || ten2 || id;
}

/* ============================================================
   PCCM / TKB: dùng mã lớp đúng Excel/index, alias 6A1 chỉ để đọc dữ liệu cũ
============================================================ */
function canonTen2FromLop(l){
    return classCanonFromLop(l);
}


/* ============================================================
   FORM CONFIG — ĐÚNG THEO EXCEL (Lớp + Môn)
============================================================ */
const FORM_CONFIG={
    lop:{
        label:"Lớp học",
        fields:[
            {k:"ten",label:"Tên lớp"},
            {k:"khoi",label:"Khối học"},
            {k:"diadiem",label:"Địa điểm"}
        ]
    },

    monhoc:{
        label:"Môn học",
        fields:[
            {k:"caphoc",label:"Khối học"},
            {k:"ten",label:"Tên môn học"},
            {k:"ma",label:"Mã môn học"}
        ]
    },

    mon:{
        label:"Tiết chuẩn",
        fields:[
            {k:"khoi",label:"Khối học"},
            {k:"ten",label:"Môn học"},
            {k:"sotiet",label:"Số tiết/1 tuần"},
            {k:"gioihan",label:"Giới hạn số tiết/1 buổi"}
        ]
    },

    khoi:{label:"Khối học",fields:[
        {k:"ten",label:"Tên khối học"}
    ]},

    giaovien:{label:"Giáo viên",fields:[
        {k:"hodem",label:"Họ đệm"},
        {k:"ten",label:"Tên"},
        {k:"magv",label:"Mã GV"},
        {k:"magv2",label:"MaGV2"}
    ]}
};

/* ============================================================
   IMPORT EXCEL — CHUẨN (Lớp & Môn theo Excel)
============================================================ */
let IMPORT_SECTION="";
let IS_PCCM_IMPORT=false;

function triggerExcel(section){
    IMPORT_SECTION=section;
    IS_PCCM_IMPORT=false;
    document.getElementById("excelFile").click();
}

function bootWhenReady(){
    if (!document.getElementById("excelFile")){
        const inp=document.createElement("input");
        inp.type="file";
        inp.accept=".xlsx,.xls";
        inp.id="excelFile";
        inp.style.display="none";
        document.body.appendChild(inp);
    }
    const excelEl = document.getElementById("excelFile");
    if(excelEl) excelEl.addEventListener("change",readExcel);

    // Tiết chuẩn: hỗ trợ Ctrl/Shift chọn nhiều ô + Ctrl/Cmd+C, Ctrl/Cmd+V
    // (Chỉ kích hoạt khi đang ở trang Tiết chuẩn)
    document.addEventListener("keydown", tcGlobalKeyDown, true);
    document.addEventListener("paste", tcGlobalPaste, true);

    // Phân công: chọn vùng/copy/paste cột dữ liệu giống bảng tính.
    document.addEventListener("keydown", pccmGlobalKeyDown, true);
    document.addEventListener("paste", pccmGlobalPaste, true);
    document.addEventListener("mouseup", ()=>{
        TC_CELL_DRAGGING = false;
        TC_CELL_DRAG_START = null;
        PCCM_CELL_DRAGGING = false;
        PCCM_CELL_DRAG_START = null;
    }, true);

    // Boot app (nạp DB theo trường) rồi render tab mặc định
    appBoot().catch(err=>{
        console.error(err);
        const c=document.getElementById('section-content');
        if (c) c.innerHTML = '<div style="padding:16px;color:#c00">Lỗi khởi tạo dữ liệu: '+(err && err.message ? err.message : err)+'</div>';
    });
}

if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", bootWhenReady);
}else{
    bootWhenReady();
}

function readExcel(e){
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (!window.XLSX){
        alert("❌ Chưa tải thư viện Excel (XLSX). Hãy kiểm tra kết nối mạng hoặc thẻ <script src=...xlsx...> trong HTML.");
        e.target.value = "";
        return;
    }

    const reader = new FileReader();

    reader.onload = async (evt)=>{
        try{
            const data = evt.target.result;

            // Ưu tiên ArrayBuffer (ổn định trên Chrome/Edge/Safari). Fallback binary nếu cần.
            let wb;
            if (data instanceof ArrayBuffer){
                wb = XLSX.read(data, { type: "array" });
            }else{
                wb = XLSX.read(data, { type: "binary" });
            }

            if (IS_PCCM_IMPORT) await importPCCMFromExcel(wb);
            else await importFromExcel(wb);
        }catch(err){
            console.error(err);
            const detail = String(err?.message || "").trim();
            alert(detail
                ? `❌ Không thể nhập Excel: ${detail}`
                : "❌ Không đọc được file Excel. Vui lòng kiểm tra định dạng .xlsx/.xls hoặc thử lưu lại file rồi nhập lại.");
        }finally{
            // reset input để có thể chọn lại cùng 1 file
            e.target.value = "";
        }
    };

    reader.onerror = (err)=>{
        console.error(err);
        alert("❌ Lỗi đọc file. Vui lòng thử lại.");
        e.target.value = "";
    };

    // ArrayBuffer works best across browsers
    try{
        reader.readAsArrayBuffer(file);
    }catch(_){
        // Old fallback
        reader.readAsBinaryString(file);
    }
}

/* ============================================================
   IMPORT CHÍNH (Lớp / Môn / Mặc định)
============================================================ */
function importFromExcel(wb){
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(sheet,{defval:""});

    if (IMPORT_SECTION==="lop") return importExcel_Lop(rows);
    if (IMPORT_SECTION==="monhoc") return importExcel_MonHoc(rows);
    if (IMPORT_SECTION==="mon") return importExcel_Mon(rows);

    return importExcel_Default(rows);
}

/* ============================================================
   IMPORT LỚP (Chuẩn Excel)
============================================================ */
function importExcel_Lop(rows){
    if(!Array.isArray(DATA.lop)) DATA.lop = [];
    if(!ensureClassCapacity(DATA.lop.length + (Array.isArray(rows) ? rows.length : 0))) return;
    // Nếu danh sách lớp đang trống, dọn ngay yêu cầu nghỉ cũ trước khi ID/tên lớp
    // từ file mới có thể tái sử dụng cùng alias.
    syncClassAvailabilityIntegrity();
    rows.forEach(r=>{
        let obj={};

        obj.ten = r["Tên lớp"]?.trim() || "";
        obj.ten2 = r["Tên lớp 2"]?.trim() || "";
        obj.khoi = r["Khối học"]?.trim() || "";
        obj.diadiem = r["Địa điểm"]?.trim() || DEFAULT_DIA_DIEM;
        obj.dienthoai = r["Điện thoại di động"]?.trim() || "";
        obj.email = r["Email"]?.trim() || "";
        obj.zalo = r["Zalo UID"]?.trim() || "";

        if (!obj.ten2) obj.ten2 = obj.ten;

        obj.id = autoID("lop");
        DATA.lop.push(obj);
    });

    saveStore();
    renderSectionInto("lop","section-content",document);
    alert("✔ Import lớp thành công!");
}

/* ============================================================
   IMPORT MÔN (Chuẩn Excel)
============================================================ */
function importExcel_Mon(rows){
    if (!Array.isArray(rows) || !rows.length){
        alert("⚠ File Excel trống hoặc không đọc được dữ liệu.");
        return;
    }

    if (!Array.isArray(DATA.mon)) DATA.mon = [];

    const _norm = (s)=> (s ?? "")
        .toString()
        .normalize('NFC')
        .trim()
        .replace(/\s+/g,' ')
        .toLowerCase();

    const _canonKhoi = (s)=>{
        const t = (s ?? "").toString().normalize('NFC').trim();
        const kn = extractKhoiNumber(t);
        return kn ? `Khối ${kn}` : t;
    };

    const _normKhoiKey = (s)=>{
        const t = (s ?? "").toString().normalize('NFC').trim();
        const m = t.match(/\d+/);
        if (m) return `khối ${m[0]}`;
        return _norm(t);
    };

    // ===== helper: tìm môn theo mọi alias (id/ten/ma/ma2) =====
    const _findMonhoc = (monValue)=>{
        const v = (monValue ?? "").toString().normalize('NFC').trim();
        if(!v) return null;
        const low = v.toLowerCase();
        return (DATA.monhoc || []).find(r=>{
            const id  = _normText(r.id).toLowerCase();
            const ten = _normText(r.ten).toLowerCase();
            const ma  = _normText(r.ma).toLowerCase();
            const ma2 = _normText(r.ma2).toLowerCase();
            return (id && id === low) || (ten && ten === low) || (ma && ma === low) || (ma2 && ma2 === low);
        }) || null;
    };

    const _canonMon = (monRaw)=>{
        const found = _findMonhoc(monRaw);
        if(!found) return _normText(monRaw);
        return _normText(found.ten) || _normText(monRaw);
    };

    // ===== 1) Dọn trùng trong dữ liệu cũ (Khối + Môn) để tránh dữ liệu phình / import lần 2 bị đúp =====
    // Đồng thời chuẩn hoá:
    // - Khối: về "Khối X"
    // - Môn: nếu đang lưu theo mã (KHTN...) thì map về tên chuẩn trong bảng Môn học (DATA.monhoc.ten)
    const _seen = new Map(); // key -> newIndex
    const _clean = [];
    let changed = false;

    (DATA.mon || []).forEach((m)=>{
        if (!m || typeof m !== "object"){
            _clean.push(m);
            return;
        }

        const khoi0Raw = (m?.khoi || "").toString().trim();
        const ten0Raw  = (m?.ten  || "").toString().trim();
        if (!khoi0Raw || !ten0Raw){
            _clean.push(m);
            return;
        }

        const khoi0 = _canonKhoi(khoi0Raw);
        const ten0  = _canonMon(ten0Raw);

        if (_normText(m.khoi) !== khoi0){ m.khoi = khoi0; changed = true; }
        if (_normText(m.ten)  !== ten0 ){ m.ten  = ten0;  changed = true; }

        const k0 = `${_normKhoiKey(khoi0)}|${_norm(ten0)}`;
        const exIdx = _seen.get(k0);

        if (exIdx === undefined){
            _seen.set(k0, _clean.length);
            _clean.push(m);
        }else{
            // merge vào dòng đã có (ưu tiên giá trị đang có; nếu trống/không hợp lệ thì lấy từ dòng trùng)
            const ex = _clean[exIdx];
            const st1 = String(ex.sotiet ?? "").trim();
            const gh1 = String(ex.gioihan ?? "").trim();
            const st2 = String(m.sotiet ?? "").trim();
            const gh2 = String(m.gioihan ?? "").trim();

            if ((st1 === "" || Number.isNaN(Number(st1))) && st2 !== "" && !Number.isNaN(Number(st2))){
                ex.sotiet = st2; changed = true;
            }
            if ((gh1 === "" || Number.isNaN(Number(gh1))) && gh2 !== "" && !Number.isNaN(Number(gh2))){
                ex.gioihan = gh2; changed = true;
            }

            changed = true; // bỏ dòng trùng
        }
    });

    if (_clean.length !== (DATA.mon||[]).length){
        DATA.mon = _clean;
    }

    // ===== 2) Chuẩn hoá dữ liệu từ Excel trước khi ghi =====
    const ops = [];
    let unknownMonCount = 0;

    rows.forEach(r=>{
        const khoiRaw = (r["Khối học"] ?? r["Khối"] ?? "").toString().trim() || "";
        const tenRaw  = (r["Môn học"] ?? r["Tên môn"] ?? r["Tên môn học"] ?? "").toString().trim() || "";
        if(!khoiRaw || !tenRaw) return;

        const khoi = _canonKhoi(khoiRaw);
        const found = _findMonhoc(tenRaw);
        const ten = found ? (_normText(found.ten) || _normText(tenRaw)) : _normText(tenRaw);
        if (!found) unknownMonCount++;

        const sotiet = (r["Số tiết/1 tuần"] ?? r["Số tiết"] ?? "").toString().trim() || "";
        const gioihan = (r["Giới hạn số tiết/1 buổi"] ?? r["Giới hạn"] ?? "").toString().trim() || "1";

        const key = `${_normKhoiKey(khoi)}|${_norm(ten)}`;
        ops.push({ key, khoi, ten, sotiet, gioihan, tenRaw, hasMonHoc: !!found });
    });

    if (!ops.length){
        alert("⚠ Không tìm thấy dòng hợp lệ (cần có cột Khối học + Môn học).");
        return;
    }

    // Gộp trùng trong file (cùng Khối+Môn) => lấy dòng CUỐI CÙNG
    const opMap = new Map();
    ops.forEach(op=>opMap.set(op.key, op));
    const uniqOps = Array.from(opMap.values());

    // ===== 3) Tính toán tác động để hỏi người dùng có muốn 'thêm mới' không =====
    let willUpdate = 0;
    let willAdd = 0;
    uniqOps.forEach(op=>{
        if (_seen.has(op.key)) willUpdate++;
        else willAdd++;
    });

    let mode = "1"; // 1=upsert, 2=update-only, 3=replace
    if (willAdd > 0 || unknownMonCount > 0){
        const msg =
`⚠ File Tiết chuẩn có thể làm phát sinh dòng mới (và dễ gây dữ liệu phình nếu Môn chưa khớp danh mục).

Tổng dòng (duy nhất theo Khối+Môn): ${uniqOps.length}
- Sẽ cập nhật: ${willUpdate}
- Sẽ thêm mới: ${willAdd}
${unknownMonCount ? ("- Dòng có Môn không khớp danh mục Môn học: " + unknownMonCount + "\n") : ""}

Chọn cách nhập:
1 = Cập nhật + Thêm mới
2 = Chỉ cập nhật (bỏ qua thêm mới)  ✅ (an toàn chống đúp)
3 = Thay thế toàn bộ (xóa Tiết chuẩn hiện tại rồi nhập lại)
0 = Huỷ`;

        const def = (willAdd > 0) ? "2" : "1";
        const ans = prompt(msg, def);
        if (ans === null) return;
        const v = String(ans).trim();
        if (v === "0") return;
        if (v === "1" || v === "2" || v === "3") mode = v;
        else mode = def;
    }

    // Replace: xoá sạch tiết chuẩn trước
    if (mode === "3"){
        DATA.mon = [];
        _seen.clear();
        changed = true;
    }

    // ===== 4) Apply =====
    let added = 0;
    let updated = 0;
    let skippedNew = 0;

    uniqOps.forEach(op=>{
        const idx = _seen.get(op.key);

        if (idx !== undefined){
            const obj = DATA.mon[idx];
            obj.khoi = op.khoi;
            obj.ten = op.ten;
            obj.sotiet = op.sotiet;
            obj.gioihan = op.gioihan || "1";
            updated++;
        }else{
            if (mode === "2"){
                skippedNew++;
                return;
            }
            const obj = {
                id: autoID("mon"),
                khoi: op.khoi,
                ten: op.ten,
                sotiet: op.sotiet,
                gioihan: op.gioihan || "1"
            };
            DATA.mon.push(obj);
            _seen.set(op.key, DATA.mon.length - 1);
            added++;
        }
    });

    // Đồng bộ thêm lần nữa để dọn các case "mã vs tên" vừa import (nếu có)
    try{ if(typeof ensureTietChuanSyncedFromMonHoc === "function") ensureTietChuanSyncedFromMonHoc(); }catch(_){}

    saveStore();
    tcResetSelection();
    const sc = document.getElementById("section-content");
    if (sc && typeof renderTietChuanPage === "function") {
        sc.innerHTML = renderTietChuanPage();
    } else {
        renderSectionInto("mon","section-content",document);
    }

    let tail = "";
    if (skippedNew) tail += `, Bỏ qua thêm mới: ${skippedNew}`;
    const warn = (unknownMonCount ? `\n⚠ Có ${unknownMonCount} dòng môn không khớp danh mục Môn học (kiểm tra lại mã/tên môn trong file hoặc bảng Môn học).` : "");

    alert(`✔ Import tiết chuẩn thành công! (Cập nhật: ${updated}, Thêm mới: ${added}${tail})${warn}`);
}



/* ============================================================
   IMPORT MÔN HỌC TỔNG HỢP (mon.xlsx)
   Cột: Tên môn học | Mã môn học | Mã môn học 2
============================================================ */
function importExcel_MonHoc(rows){
    const imported = [];
    const missingCodeRows = [];

    rows.forEach((r, idx)=>{
        let obj={};

        obj.ten = (r["Tên môn học"] ?? r["Tên môn"] ?? r["Môn học"] ?? "").toString().trim();
        obj.ma  = (r["Mã môn học"] ?? r["Mã môn"] ?? r["Ma mon hoc"] ?? r["Ma mon"] ?? r["ma"] ?? "").toString().trim();
        obj.ma2 = (r["Mã môn học 2"] ?? r["Mã môn 2"] ?? r["Ma mon hoc 2"] ?? r["Ma mon 2"] ?? r["ma2"] ?? "").toString().trim();
        obj.caphoc = normalizeSubjectLevelText(r["Khối học"] ?? r["Cấp học"] ?? r["Cap hoc"] ?? r["Cấp"] ?? r["Cap"] ?? r["caphoc"] ?? "");

        if (!obj.ten && !obj.ma && !obj.ma2) return;
        if (!obj.ten || !obj.ma){
            missingCodeRows.push(idx + 2);
            return;
        }
        imported.push(obj);
    });

    if (missingCodeRows.length){
        alert(`⚠ Không thể import Môn học.\nMỗi dòng phải có Tên môn học và Mã môn học.\nDòng thiếu dữ liệu: ${missingCodeRows.slice(0, 20).join(", ")}${missingCodeRows.length > 20 ? "..." : ""}`);
        return;
    }
    if (!imported.length){
        alert("⚠ Không tìm thấy dòng Môn học hợp lệ.");
        return;
    }

    imported.forEach(obj=>{
        obj.id = autoID("monhoc");
        DATA.monhoc.push(obj);
    });

    saveStore();
    renderSectionInto("monhoc","section-content",document);
    alert("✔ Import môn học (tổng hợp) thành công!");
}



/* ============================================================
   IMPORT MẶC ĐỊNH (khi không phải Lớp/Môn)
============================================================ */
function importExcel_Default(rows){
    const cfg=FORM_CONFIG[IMPORT_SECTION];
    const getCell = (row, field)=>{
        if (IMPORT_SECTION === "giaovien"){
            if (field.k === "magv"){
                return row[field.label] ?? row["MaGV"] ?? row["Mã GV"] ?? row["Mã giáo viên"] ?? row[field.k] ?? "";
            }
            if (field.k === "magv2"){
                return row[field.label] ?? row["MaGV2"] ?? row["Mã GV2"] ?? row[field.k] ?? "";
            }
        }
        return row[field.label] ?? row[field.k] ?? "";
    };

    const imported = rows.map(r=>{
        let obj={};

        cfg.fields.forEach(f=>{
            obj[f.k] = getCell(r, f);
        });

        return obj;
    });

    const autoMagvCount = IMPORT_SECTION === "giaovien" ? autoFillMissingMaGVForTeachers(imported) : 0;

    imported.forEach(obj=>{
        obj.id = autoID(IMPORT_SECTION);
        DATA[IMPORT_SECTION].push(obj);
    });

    saveStore();
    renderSectionInto(IMPORT_SECTION,"section-content",document);
    alert(`✔ Import thành công!${autoMagvCount ? `\nĐã tự tạo Mã GV cho ${autoMagvCount} giáo viên.` : ""}`);
}
/* ============================================================
   ==========  PART 2 / 4 – EXPORT + RENDER + MODAL ==========
============================================================ */


/* ============================================================
   EXPORT EXCEL — GIỮ NGUYÊN HEADER THEO EXCEL
============================================================ */
function exportExcel(section){
    const cfg = FORM_CONFIG[section];
    const exportName = section === "mon" ? "tietchuan" : section;
    const rows = DATA[section].map((r,i)=>{
        let obj = { STT: i+1 };

        cfg.fields.forEach(f=>{
            let v = r[f.k] || "";
            if (section === "mon" && f.k === "ten"){
                v = excelSubjectShortName(v);
            }
            // Tiết chuẩn: mặc định giới hạn = 1 để người dùng xuất Excel và chỉnh theo ý
            if (section === "mon" && f.k === "gioihan"){
                const s = (v ?? "").toString().trim();
                v = s === "" ? "1" : s;
            }
            obj[f.label] = v;
        });

        return obj;
    });

    const cols = (rows && rows.length) ? Object.keys(rows[0]) : ["STT", ...(cfg.fields||[]).map(f=>f.label)];
    const matrix = [cols, ...(rows || []).map(r=>cols.map(k=>r?.[k] ?? ""))];
    const ws = XLSX.utils.json_to_sheet(rows, { header: cols });
    let widths = [];

    // set độ rộng cột cho Excel (tránh tình trạng các cột bằng nhau)
    try{
        let equalWidth = 12;
        cols.slice(1).forEach(k=>{
            equalWidth = Math.max(equalWidth, String(k||"").length + 2);
            (rows||[]).forEach(r=>{
                const s = (r?.[k] == null) ? "" : String(r[k]);
                s.split(/\r?\n/).forEach(part=>{ equalWidth = Math.max(equalWidth, part.length + 2); });
            });
        });
        equalWidth = Math.min(Math.max(12, equalWidth), section === "mon" ? 18 : 32);
        widths = cols.map((k, idx)=>{
            if (idx === 0) return { wch: 6 };
            return { wch: equalWidth };
        });
        ws["!cols"] = widths;
    }catch(e){
        console.warn("exportExcel set column widths failed", e);
    }
    try{
        window.TKBExcelStyle?.styleSheet(ws, matrix, {
            widths,
            headerRows: [0],
            freeze: { xSplit: 0, ySplit: 1 },
            filterRow: 0,
            bodyRowHeight: 22,
            maxWidth: 42
        });
    }catch(e){
        console.warn("exportExcel style failed", e);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, exportName);

    XLSX.writeFile(wb, `${exportName}.xlsx`, window.TKBExcelStyle?.writeOptions ? window.TKBExcelStyle.writeOptions() : { compression: true, cellStyles: true });
}


/* ============================================================
   HIỂN THỊ DANH SÁCH DỮ LIỆU TRONG TRANG TỔNG HỢP
============================================================ */
function appUiIcon(name){
    const paths = {
        plus: '<path d="M12 5v14M5 12h14"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
        wand: '<path d="m15 4 5 5L8 21l-5-5Z"/><path d="m6 14 5 5M19 2v3M22 5h-3M5 2v2M7 4H3"/>',
        more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
        rowsDelete: '<path d="M3 6h18M3 12h12M3 18h9"/><path d="m17 15 4 4m0-4-4 4"/>',
        trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5M14 11v5"/>'
    };
    return `<svg class="app-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.more}</svg>`;
}

function appQuickAddDetails(content){
    if(!content) return "";
    return `
        <details class="app-quick-add-details">
            <summary class="btn app-icon-button" title="Thêm nhanh" aria-label="Mở công cụ thêm nhanh">
                ${appUiIcon("wand")}
                <span class="app-quick-add-summary-label">Thêm nhanh</span>
            </summary>
            ${content}
        </details>`;
}

function closeAppActionDetails(except){
    document.querySelectorAll(".app-quick-add-details[open]").forEach(details=>{
        if(details !== except) details.removeAttribute("open");
    });
}

document.addEventListener("toggle", event=>{
    const details = event.target;
    if(
        details instanceof HTMLDetailsElement
        && details.open
        && details.matches(".app-quick-add-details")
    ) closeAppActionDetails(details);
}, true);

document.addEventListener("click", event=>{
    if(!event.target.closest?.(".app-quick-add-details")){
        closeAppActionDetails(null);
    }
});

function renderSectionInto(section, containerId, doc=document){
    const cfg = FORM_CONFIG[section];
    const arr = DATA[section];
    const container = doc.getElementById(containerId);

    // selection count for UX
    const selSet = TABLE_SELECTION[section] || new Set();
    const selCount = selSet.size;
    const selIndex = (selCount === 1) ? Array.from(selSet.values())[0] : -1;

    const isEditing = (INLINE_EDIT.section === section && Number.isFinite(INLINE_EDIT.index) && INLINE_EDIT.index >= 0);
    const editingIndex = isEditing ? INLINE_EDIT.index : -1;
    const isCompactTable = cfg.fields.length <= 3;
    const tableClass = `data-table data-table-${section}${isCompactTable ? " data-table-compact" : ""}`;
    const wrapClass = `table-wrap data-table-wrap data-table-wrap-${section}${isCompactTable ? " data-table-wrap-compact" : ""}`;

    let quickAdd = "";
    if(section === "khoi"){
        quickAdd = `
        <div class="quick-add-control">
            <span class="quick-add-label">Thêm nhanh</span>
            <select class="quick-add-select" onchange="quickAddKhoiByLevel(this.value); this.value=''; this.closest('details')?.removeAttribute('open')">
                <option value="">Chọn cấp học</option>
                <option value="TH">Tiểu học</option>
                <option value="THCS">THCS</option>
                <option value="THPT_GDTX">THPT (GDTX)</option>
            </select>
        </div>`;
    }else if(section === "lop"){
        quickAdd = `
        <div class="quick-add-control quick-add-lop">
            <span class="quick-add-label">Thêm nhanh</span>
            <input id="quick_lop_prefix" class="quick-add-input quick-add-prefix" value="" placeholder="6" title="Tiền tố">
            <input id="quick_lop_letter" class="quick-add-input quick-add-letter" value="" maxlength="3" placeholder="A" title="Chữ lớp, có thể bỏ trống">
            <input id="quick_lop_count" class="quick-add-input quick-add-count" type="number" min="1" step="1" placeholder="Số lớp" title="Số lớp">
            <select id="quick_lop_diadiem" class="quick-add-select quick-add-diadiem" title="Địa điểm">
                ${renderDiaDiemOptions(DEFAULT_DIA_DIEM)}
            </select>
            <button class="btn" onclick="quickAddLopFromInputs()" title="Tạo nhanh lớp" aria-label="Tạo nhanh lớp">${appUiIcon("wand")}<span class="app-action-label">Tạo</span></button>
        </div>`;
    }else if(section === "giaovien"){
        quickAdd = `
        <div class="quick-add-control quick-add-gv">
            <span class="quick-add-label">Tạo Mã:</span>
            <select id="quick_gv_magv2_rule" class="quick-add-select quick-add-gv-rule" title="Quy tắc tạo MaGV2">
                <option value="holot_ten" selected>Ký tự đầu + Tên + Số nếu trùng</option>
                <option value="ten_holot">Tên + Ký tự đầu + Số nếu trùng</option>
                <option value="ten">Tên + Số nếu trùng</option>
            </select>
            <button class="btn" onclick="quickCreateMaGV2()" title="Tạo mã giáo viên" aria-label="Tạo mã giáo viên">${appUiIcon("wand")}<span class="app-action-label">Tạo</span></button>
        </div>`;
    }else if(section === "monhoc"){
        quickAdd = `
        <div class="quick-add-control quick-add-monhoc">
            <span class="quick-add-label">Thêm nhanh</span>
            <select class="quick-add-select quick-add-level" onchange="quickAddMonHocByLevel(this.value); this.value=''; this.closest('details')?.removeAttribute('open')">
                <option value="">Chọn cấp học</option>
                <option value="TH">Tiểu học</option>
                <option value="THCS">THCS</option>
                <option value="THPT_GDTX">THPT (GDTX)</option>
            </select>
        </div>`;
    }

    let html = `
    <div class="action-bar action-bar-data${quickAdd ? " has-quick-add" : ""}">
        <button class="btn primary app-action-button app-action-create" onclick="openModal('${section}')" title="Thêm mới" aria-label="Thêm mới">
            ${appUiIcon("plus")}<span class="app-action-label">Thêm mới</span><span class="app-mobile-only-label">Thêm</span>
        </button>
        ${appQuickAddDetails(quickAdd)}
        <button class="btn app-action-button" onclick="triggerExcel('${section}')" title="Nhập Excel" aria-label="Nhập Excel">${appUiIcon("upload")}<span class="app-action-label">Nhập Excel</span></button>
        <button class="btn app-action-button" onclick="exportExcel('${section}')" title="Xuất Excel" aria-label="Xuất Excel">${appUiIcon("download")}<span class="app-action-label">Xuất Excel</span></button>

        ${isEditing
            ? `<button class="btn app-desktop-action" onclick="tableCancelEdit()">Hủy</button>`
            : ``
        }

        <button class="btn danger app-action-button app-delete-action" type="button" ${selCount ? "" : "disabled"}
                title="Xóa đã chọn" aria-label="Xóa đã chọn${selCount ? ` (${selCount})` : ""}"
                onclick="deleteSelectedRows('${section}')">
            ${appUiIcon("rowsDelete")}
            <span class="app-action-label">Xóa đã chọn${selCount ? ` (${selCount})` : ""}</span>
            ${selCount ? `<span class="app-selection-badge" aria-hidden="true">${selCount}</span>` : ""}
        </button>

        <!-- Xóa riêng mục -->
        <button class="btn danger app-action-button app-delete-action" type="button"
                title="Xóa mục này" aria-label="Xóa mục này"
                onclick="deleteSection('${section}')">
            ${appUiIcon("trash")}<span class="app-action-label">Xóa mục này</span>
        </button>

    </div>

    <div class="${wrapClass}">
    <table class="${tableClass}">
        <tr>
            <th>STT</th>`;

    // Thêm các column header
    cfg.fields.forEach(f=>{
        html += `<th>${f.label}</th>`;
    });

    // (Đã bỏ cột "Đồng bộ" theo yêu cầu)
    html += `</tr>`;

    if (!arr.length){
        html += `
        <tr class="data-empty-row">
            <td colspan="${cfg.fields.length + 1}">Chưa có dữ liệu.</td>
        </tr>`;
    }

    // Thêm các dòng dữ liệu
    arr.forEach((row,i)=>{
        const isSelected = (TABLE_SELECTION[section] && TABLE_SELECTION[section].has(i));
        const isEditing = (INLINE_EDIT.section === section && INLINE_EDIT.index === i);

        html += `<tr class="${isSelected?"row-selected":""} ${isEditing?"row-editing":""}"
            onclick="tableRowClick(event,'${section}',${i})"
            ondblclick="tableRowDblClick(event,'${section}',${i})">
            <td>${i+1}</td>`;

        cfg.fields.forEach(f=>{
            if (isEditing){
                const val = row ? (row[f.k] || "") : "";

                // KHỐI => select
                if (f.k === "khoi"){
                    const opts = (DATA.khoi || []).map(k => (k.ten||"").trim()).filter(Boolean);
                    html += `<td>
                        <select class="inline-edit-select" id="edit_${section}_${i}_${f.k}" onkeydown="tableEditKeyDown(event,'${section}',${i})">
                            <option value="">-- Chọn khối --</option>
                            ${opts.map(k=>`<option value="${escapeHtml(k)}" ${k===val?"selected":""}>${escapeHtml(k)}</option>`).join("")}
                        </select>
                    </td>`;
                    return;
                }

                if (section === "lop" && f.k === "diadiem"){
                    html += `<td>
                        <select class="inline-edit-select" id="edit_${section}_${i}_${f.k}" onkeydown="tableEditKeyDown(event,'${section}',${i})">
                            ${renderDiaDiemOptions(val)}
                        </select>
                    </td>`;
                    return;
                }

                // default => input
                html += `<td>
                    <input class="inline-edit-input" id="edit_${section}_${i}_${f.k}" value="${escapeHtml(val)}" onkeydown="tableEditKeyDown(event,'${section}',${i})">
                </td>`;
                return;
            }

            // ===== VIEW MODE =====
            html += `<td>${row[f.k] || ""}</td>`;
        });

        // (Đã bỏ cột "Đồng bộ" theo yêu cầu)

        html += `
        </tr>`;
    });

    html += `
        </table>
    </div>`;

    
    container.innerHTML = html;
}

/* ============================================================
   MODAL (THÊM / SỬA)
============================================================ */
let CURRENT_SECTION = "";
let EDIT_INDEX = -1;

function openModal(section,index=-1){
    CURRENT_SECTION = section;
    EDIT_INDEX = index;

    const cfg = FORM_CONFIG[section];
    const row = index >= 0 ? DATA[section][index] : null;

    document.getElementById("modal-title").innerText =
        (index === -1 ? "Thêm " : "Sửa ") + cfg.label;

    // Build form
    let html = "";

    cfg.fields.forEach(f=>{
        const val = row ? (row[f.k] || "") : "";

        // ===== KHỐI =====
if (f.k === "khoi") {
    html += `
    <div class="form-row">
        <label>${f.label}</label>
        <select id="f_${f.k}">
            <option value="">-- Chọn khối --</option>
            ${DATA.khoi.map(k =>
                `<option value="${k.ten}" ${k.ten===val?"selected":""}>${k.ten}</option>`
            ).join("")}
        </select>
    </div>`;
    return;
}

if (section === "lop" && f.k === "diadiem") {
    html += `
    <div class="form-row">
        <label>${f.label}</label>
        <select id="f_${f.k}">
            ${renderDiaDiemOptions(val)}
        </select>
    </div>`;
    return;
}

// ===== CÁC FIELD KHÁC =====
html += `
<div class="form-row">
    <label>${f.label}</label>
    <input id="f_${f.k}" value="${val}">
</div>`;

    });

    document.getElementById("modal-body").innerHTML = html;
    document.getElementById("modal").style.display = "flex";
}

function closeModal(){
    document.getElementById("modal").style.display = "none";
}


/* ============================================================
   SAVE DATA — CHUẨN HOÁ THEO EXCEL
============================================================ */
function saveData(){
    const section = CURRENT_SECTION;
    const cfg = FORM_CONFIG[section];

    let obj = {};

    cfg.fields.forEach(f=>{
        obj[f.k] = document.getElementById("f_"+f.k).value.trim();
    });

    // Chuẩn hoá tên lớp nếu là LỚP
    if (section === "lop"){
        if(!obj.ten2) obj.ten2 = obj.ten;
        if(!obj.diadiem) obj.diadiem = DEFAULT_DIA_DIEM;
    }

    if (EDIT_INDEX === -1){
        if(section === "lop" && !ensureClassCapacity((DATA.lop || []).length + 1)) return;
        obj.id = autoID(section);
        DATA[section].push(obj);
    } else {
        obj.id = DATA[section][EDIT_INDEX].id;
        DATA[section][EDIT_INDEX] = obj;
    }

    saveStore();
    closeModal();
    renderSectionInto(section,"section-content",document);
}


/* ============================================================
   XÓA DỮ LIỆU
============================================================ */
function deleteRow(section,index){
    if (!confirm("Bạn có chắc muốn xóa?")) return;

    const removed = (DATA[section] || [])[index];
    DATA[section].splice(index,1);
    // Nếu xóa môn tổng hợp (monhoc) => hỏi có xóa luôn trong Tiết chuẩn (mon) không
    if (section === "monhoc" && removed){
        const ten = _normText(removed.ten);
        const ma  = _normText(removed.ma);
        const ma2 = _normText(removed.ma2);
        const candidates = Array.from(new Set([ma, ten, ma2].filter(Boolean)));

        if (candidates.length){
            const msg =
                "Bạn có muốn xóa môn này khỏi TIẾT CHUẨN (tất cả khối) không?\n" +
                "- Nếu chọn OK: sẽ xóa các dòng tiết chuẩn có Môn = " + candidates.join(" / ") + "\n" +
                "- Nếu chọn Cancel: chỉ xóa trong MÔN HỌC (môn tổng hợp).";
            if (confirm(msg)){
                const before = (DATA.mon || []).length;
                DATA.mon = (DATA.mon || []).filter(m => !candidates.includes(_normText(m.ten)));
                const after = (DATA.mon || []).length;

                // Không tự xóa PCCM để tránh mất phân công ngoài ý muốn
                if (before !== after){
                    // Nếu đang ở trang Tiết chuẩn (nếu có) thì nó sẽ tự render lại qua logic phía dưới
                }
            }
        }
    }


    // Nếu xóa tiết chuẩn (mon) => cũng dọn PCCM liên quan theo khối+môn
    if (section === "mon" && removed){
        const khoi = _normText(removed.khoi);
        const ten  = _normText(removed.ten);
        if (khoi && ten){
            const khoiNum = extractKhoiNumber(khoi);
            const shouldRemoveKey = (key)=>{
                if (!key.includes("|")) return false;
                const [lopCanon, monTen] = key.split("|");
                if (_normText(monTen) !== ten) return false;
                return extractKhoiNumber(lopCanon) === khoiNum;
            };
            for (const key in (DATA.pccmMatrix || {})){
                if (shouldRemoveKey(key)) delete DATA.pccmMatrix[key];
            }
            for (const key in (DATA.pccmRoomMatrix || {})){
                if (shouldRemoveKey(key)) delete DATA.pccmRoomMatrix[key];
            }
        }
    }

    // Đồng bộ liên kết sau khi xoá (tránh tình trạng xoá Môn/Lớp/GV nhưng phân công vẫn còn)
    try{ syncDerivedDataIntegrity(); }catch(e){ console.warn("syncDerivedDataIntegrity failed", e); }

    saveStore();

    // Nếu đang ở PCCM thì refresh PCCM; ngược lại render section bình thường
    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function" && sc.innerHTML && sc.innerHTML.includes("PCCM")) {
        pccmRenderCurrent(sc);
    } else {
        renderSectionInto(section,"section-content",document);
    }
}

/* ============================================================
   EXCEL-LIKE UX HELPERS (ROW SELECT + INLINE EDIT + BULK DELETE)
============================================================ */
function _getSelSet(section){
    if (!TABLE_SELECTION[section]) TABLE_SELECTION[section] = new Set();
    return TABLE_SELECTION[section];
}

function tableRowClick(evt, section, index){
    // ignore clicks on interactive elements
    const t = evt?.target;
    if (t && t.closest && t.closest("button, input, select, textarea, a")) return;

    // Tránh đụng với dblclick (trình duyệt sẽ bắn click 2 lần trước khi dblclick)
    if (evt && typeof evt.detail === "number" && evt.detail > 1) return;

    const set = _getSelSet(section);
    const last = TABLE_LAST_INDEX[section];
    const isCtrl = !!(evt && (evt.ctrlKey || evt.metaKey));
    const isShift = !!(evt && evt.shiftKey);

    if (isShift && typeof last === "number" && last >= 0){
        const a = Math.min(last, index);
        const b = Math.max(last, index);
        if (!isCtrl) set.clear();
        for (let i=a;i<=b;i++) set.add(i);
    } else if (isCtrl){
        if (set.has(index)) set.delete(index);
        else set.add(index);
    } else {
        // Click 1 lần: chọn; click lại cùng dòng: bỏ chọn
        if (set.size === 1 && set.has(index)) {
            set.clear();
        } else {
            set.clear();
            set.add(index);
        }
    }

    TABLE_LAST_INDEX[section] = index;
    // selection only; don't keep inline edit when user selects
    if (INLINE_EDIT.section === section && INLINE_EDIT.index !== index){
        INLINE_EDIT = { section:"", index:-1 };
    }

    renderSectionInto(section, "section-content", document);
}

function tableRowDblClick(evt, section, index){
    const t = evt?.target;
    if (t && t.closest && t.closest("button, input, select, textarea, a")) return;
    tableBeginEdit(section, index);
}

function tableBeginEdit(section, index){
    INLINE_EDIT = { section, index };
    // chọn đúng dòng đang sửa
    const set = _getSelSet(section);
    set.clear();
    set.add(index);
    TABLE_LAST_INDEX[section] = index;
    renderSectionInto(section, "section-content", document);
}

function tableCancelEdit(){
    const sec = INLINE_EDIT.section;
    INLINE_EDIT = { section:"", index:-1 };
    if (sec) renderSectionInto(sec, "section-content", document);
}

// Khi đang sửa inline: Enter = Lưu, Esc = Hủy
function tableEditKeyDown(evt, section, index){
    if (!evt) return;
    const key = evt.key || evt.code || "";
    if (key === "Enter"){
        evt.preventDefault();
        tableSaveEdit(section, index);
    }
    if (key === "Escape"){
        evt.preventDefault();
        tableCancelEdit();
    }
}

function tableSaveEdit(section, index){
    const cfg = FORM_CONFIG[section];
    const row = (DATA[section] || [])[index];
    if (!cfg || !row) return;

    const obj = {};
    cfg.fields.forEach(f=>{
        const id = `edit_${section}_${index}_${f.k}`;
        const el = document.getElementById(id);
        obj[f.k] = (el ? el.value : "").toString().trim();
    });

    // Chuẩn hoá tên lớp nếu là LỚP
    if (section === "lop"){
        if(!obj.ten2) obj.ten2 = obj.ten;
        if(!obj.diadiem) obj.diadiem = DEFAULT_DIA_DIEM;
    }

    obj.id = row.id;
    DATA[section][index] = { ...row, ...obj, id: row.id };

    saveStore();
    INLINE_EDIT = { section:"", index:-1 };
    renderSectionInto(section, "section-content", document);
}

function deleteSelectedRows(section){
    const set = _getSelSet(section);
    const idxs = Array.from(set.values()).filter(i=>Number.isFinite(i)).sort((a,b)=>b-a);
    if (!idxs.length){
        alert("Chưa chọn dòng nào.");
        return;
    }

    if (!confirm(`Xóa ${idxs.length} dòng đã chọn?`)) return;

    const removed = [];
    idxs.forEach(i=>{
        if (i >= 0 && i < (DATA[section]||[]).length){
            removed.push(DATA[section][i]);
            DATA[section].splice(i, 1);
        }
    });

    // Special cleanup: monhoc => optional delete in Tiết chuẩn
    if (section === "monhoc" && removed.length){
        const candSet = new Set();
        removed.forEach(r=>{
            const ten = _normText(r?.ten);
            const ma  = _normText(r?.ma);
            const ma2 = _normText(r?.ma2);
            [ten, ma, ma2].filter(Boolean).forEach(x=>candSet.add(x));
        });
        const candidates = Array.from(candSet);
        if (candidates.length){
            const msg =
                "Bạn có muốn xóa các môn này khỏi TIẾT CHUẨN (tất cả khối) không?\n" +
                "- OK: xóa các dòng tiết chuẩn có Môn = " + candidates.join(" / ") + "\n" +
                "- Cancel: chỉ xóa trong MÔN HỌC (môn tổng hợp).";
            if (confirm(msg)){
                DATA.mon = (DATA.mon || []).filter(m => !candidates.includes(_normText(m.ten)));
            }
        }
    }

    // Special cleanup: mon (tiết chuẩn) => dọn PCCM theo khối+môn
    if (section === "mon" && removed.length){
        removed.forEach(r=>{
            const khoi = _normText(r?.khoi);
            const ten  = _normText(r?.ten);
            if (!khoi || !ten) return;
            const khoiNum = extractKhoiNumber(khoi);
            const shouldRemoveKey = (key)=>{
                if (!key.includes("|")) return false;
                const [lopCanon, monTen] = key.split("|");
                if (_normText(monTen) !== ten) return false;
                return extractKhoiNumber(lopCanon) === khoiNum;
            };
            for (const key in (DATA.pccmMatrix || {})){
                if (shouldRemoveKey(key)) delete DATA.pccmMatrix[key];
            }
            for (const key in (DATA.pccmRoomMatrix || {})){
                if (shouldRemoveKey(key)) delete DATA.pccmRoomMatrix[key];
            }
        });
    }

    saveStore();
    set.clear();
    TABLE_LAST_INDEX[section] = -1;
    INLINE_EDIT = { section:"", index:-1 };
    renderSectionInto(section, "section-content", document);
}
/* ============================================================
   ==========  PART 3 / 4 — PHÂN CÔNG CHUYÊN MÔN (PCCM)  ==========
   PCCM key = "LớpChuẩn|TênMôn"
   Ví dụ: "6A1|Toán"
============================================================ */
/* ============================================================
   ==========  PART 3 / 4 — PHÂN CÔNG CHUYÊN MÔN (PCCM)  ==========
   PCCM key = "LớpChuẩn|TênMôn"
   Ví dụ: "6A1|Toán"
============================================================ */

/* ============================================================
   RENDER PCCM TRONG TRANG TỔNG HỢP
============================================================ */
/* ============================================================
   ==========  PCCM HOÀN CHỈNH — AUTO FIX LỚP & MÔN  ==========
============================================================ */

/* KHÓA PCCM: "6A1|Toán" */

/* ============================================================
   RENDER PCCM TRÊN GIAO DIỆN
============================================================ */

/* ============================================================
   PCCM UI STATE (TAB + SELECTED)
============================================================ */
let PCCM_TAB = "lop";         // "lop" | "giaovien" | "monhoc"
let PCCM_SELECTED_CLASS = ""; // vd "10A1"
let PCCM_SELECTED_GV = "";    // tên GV
let PCCM_SIDE_SCROLL = { lop: 0, giaovien: 0, monhoc: 0 };

// Lookup indexes used while rendering the Phân công tabs.  The old helpers
// deliberately scanned every class/teacher/standard row on each lookup.  That
// was harmless for small imports, but made a tab switch quadratic for a real
// school (the teacher and subject tabs call those helpers once per cell).  The
// index is rebuilt at the beginning of every PCCM render and invalidated by
// saveStore(), so edits never observe stale values.
let PCCM_LOOKUP_CACHE = null;

function pccmInvalidateLookupCache(){
    PCCM_LOOKUP_CACHE = null;
}

function pccmBuildLookupCache(){
    const classAliases = new Map();
    const addClassAlias = (alias, ownAliases) => {
        const key = String(alias || "").trim().toLowerCase();
        if (!key) return;
        let list = classAliases.get(key);
        if (!list){ list = []; classAliases.set(key, list); }
        (ownAliases || []).forEach(value=>{
            const text = String(value || "").trim();
            if (text && !list.includes(text)) list.push(text);
        });
    };

    (DATA.lop || []).forEach(lop=>{
        const values = [classCanonFromLop(lop), lop?.ten, lop?.ten2, lop?.id]
            .filter(Boolean);
        const ownAliases = [];
        values.forEach(value=>legacyClassNameAliases(value).forEach(alias=>{
            if (alias && !ownAliases.includes(alias)) ownAliases.push(alias);
        }));
        ownAliases.forEach(alias=>addClassAlias(alias, ownAliases));
    });

    const teacherByCode = new Map();
    const teacherByName = new Map();
    const teacherNames = new Map();
    (DATA.giaovien || []).forEach(g=>{
        const code = _normText(g?.magv);
        if (!code) return;
        const codeKey = code.toLowerCase();
        if (!teacherByCode.has(codeKey)) teacherByCode.set(codeKey, code);
        if (!teacherNames.has(codeKey)){
            teacherNames.set(codeKey, `${_normText(g?.hodem)} ${_normText(g?.ten)}`.trim());
        }
        const full = `${_normText(g?.hodem)} ${_normText(g?.ten)}`.trim();
        if (full && !teacherByName.has(full.toLowerCase())) teacherByName.set(full.toLowerCase(), code);
    });

    // lookupTietChuan() compares the standard row's subject name with one of
    // the subject aliases. Keep the first row to preserve Array.find order.
    const standards = new Map();
    (DATA.mon || []).forEach(row=>{
        const grade = extractKhoiNumber(_normText(row?.khoi));
        const subject = _normText(row?.ten).toLowerCase();
        if (!grade || !subject) return;
        const key = `${grade}|${subject}`;
        if (!standards.has(key)) standards.set(key, row);
    });

    return {classAliases, teacherByCode, teacherByName, teacherNames, standards};
}

function pccmEnsureLookupCache(){
    if (!PCCM_LOOKUP_CACHE) PCCM_LOOKUP_CACHE = pccmBuildLookupCache();
    return PCCM_LOOKUP_CACHE;
}

// Cache chỉnh sửa PCCM (tab Lớp) để nút Lưu có thể đọc DOM
let PCCM_CLASS_EDIT_CACHE = { cls:"", khoiName:"", mons:[] };

// Cache chỉnh sửa PCCM (tab Giáo viên)
let PCCM_TEACHER_EDIT_CACHE = { gv:"", rows:[] };
let PCCM_TEACHER_CLASS_FILTER = "Tất cả";

// Cache chỉnh sửa PCCM (tab Môn học)
let PCCM_SUBJECT_EDIT_CACHE = { monKey:"", rows:[] };

// Bộ lọc khối trong PCCM
let PCCM_KHOI = "Tất cả";     // "Tất cả" hoặc "Khối 6", "Khối 7", ...
let PCCM_ALLOWED_CLASS_SET = null;

// Bộ lọc môn trong tab Tiết chuẩn
let TC_MON = "Tất cả";

// Bộ lọc cho trang Tiết chuẩn (menu lớn)
let TC_KHOI = "Tất cả";

// Tiết chuẩn: chọn nhiều ô (Ctrl/Shift) + Copy/Paste
let TC_CELL_SELECTION = new Set(); // key "r,c"
let TC_CELL_ANCHOR = null;         // {r,c}
let TC_CELL_DRAGGING = false;
let TC_CELL_DRAG_START = null;
let TC_CELL_DRAG_MOVED = false;

// Thêm nhanh PCCM: chọn nhiều lớp trong tab Lớp.
let PCCM_QUICK_SELECTED_CLASSES = [];
let PCCM_QUICK_CLASS_ANCHOR = "";
let PCCM_QUICK_SELECTED_SUBJECTS = [];
let PCCM_QUICK_SUBJECT_ANCHOR = "";
let PCCM_QUICK_SELECTED_TEACHERS = [];
let PCCM_QUICK_TEACHER_ANCHOR = "";

// Phân công: chọn vùng/copy/paste kiểu bảng tính.
let PCCM_CELL_SELECTION = new Set(); // key "r,c"
let PCCM_CELL_ANCHOR = null;         // {r,c}
let PCCM_CELL_DRAGGING = false;
let PCCM_CELL_DRAG_START = null;


function pccmSafeTab(tab){
    return ["lop", "giaovien", "monhoc"].includes(tab) ? tab : "lop";
}

function pccmRememberSideScroll(tab){
    try{
        const key = pccmSafeTab(tab || PCCM_TAB);
        const el = document.querySelector(`.pccm-side-list[data-pccm-tab="${key}"]`)
            || document.querySelector(".pccm-side-list");
        if (el) PCCM_SIDE_SCROLL[key] = Number(el.scrollTop || 0);
    }catch(e){ /* ignore */ }
}

function pccmRestoreSideScroll(tab){
    try{
        const key = pccmSafeTab(tab || PCCM_TAB);
        const y = Math.max(0, Number(PCCM_SIDE_SCROLL[key] || 0));
        const apply = ()=>{
            const el = document.querySelector(`.pccm-side-list[data-pccm-tab="${key}"]`)
                || document.querySelector(".pccm-side-list");
            if (!el) return;
            const maxY = Math.max(0, Number(el.scrollHeight || 0) - Number(el.clientHeight || 0));
            el.scrollTop = Math.min(y, maxY || y);
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
        else setTimeout(apply, 0);
    }catch(e){ /* ignore */ }
}

function pccmRenderCurrent(target, opts){
    opts = opts || {};
    const sc = (typeof target === "string")
        ? document.getElementById(target)
        : (target || document.getElementById("section-content"));
    if (!sc || typeof renderPCCM !== "function") return;
    if (!opts.skipRemember) pccmRememberSideScroll(opts.rememberTab || PCCM_TAB);
    sc.innerHTML = renderPCCM();
    pccmRestoreSideScroll(opts.restoreTab || PCCM_TAB);
}

function pccmSideListAttrs(tab){
    const key = pccmSafeTab(tab);
    return `class="pccm-side-list" data-pccm-tab="${key}" onscroll="pccmRememberSideScroll('${key}')"`;
}

function renderPCCM() {
    // Always rebuild once per visible render. This also covers test/import code
    // that replaces DATA directly without going through saveStore().
    PCCM_LOOKUP_CACHE = pccmBuildLookupCache();
    try{
        PCCM_CELL_SELECTION = new Set();
        PCCM_CELL_ANCHOR = null;
        PCCM_CELL_DRAGGING = false;
        PCCM_CELL_DRAG_START = null;
    }catch(e){ /* ignore */ }

    // ===== Lớp (hiển thị tất cả, không lọc theo khối) =====
    const lopObjs = (DATA.lop || []).map(l=>{
        // chỉ lấy Tên lớp 2 (ten2), và CHUẨN HOÁ để không bị 6/1 & 6A1
        const ten2 = canonTen2FromLop(l);
        const khoi = (l.khoi || "").trim() || ("Khối " + extractKhoiNumber(ten2));
        return {ten2, khoi};
    }).filter(x=>x.ten2);

    const classNames = Array.from(new Set(lopObjs.map(x=>x.ten2)));

    if (!PCCM_SELECTED_CLASS && classNames.length) PCCM_SELECTED_CLASS = classNames[0];
    if (PCCM_SELECTED_CLASS && !classNames.includes(PCCM_SELECTED_CLASS) && classNames.length) {
        PCCM_SELECTED_CLASS = classNames[0];
    }

    // ===== Tiết chuẩn: CHỈ dùng để lookup số tiết/tuần & giới hạn theo khối =====
    // (Danh mục môn trong PCCM lấy từ Môn học tổng hợp: DATA.monhoc)
    const tcRowsAll = (DATA.mon || []).map(m=>({
        khoi: (m.khoi || "").trim(),
        ten: (m.ten || "").trim(),
        sotiet: (m.sotiet || "").toString().trim(),
        gioihan: (m.gioihan || "").toString().trim()
    })).filter(r=>r.khoi && r.ten);

    const pccmMonsAll = buildPCCMMonList(); // [{key, ten, ma, ma2}]

    // Danh mục môn (từ Môn học tổng hợp) nhưng chỉ HIỂN THỊ những môn có TIẾT CHUẨN (số tiết > 0)
    // ở ít nhất 1 khối. (Môn không có tiết sẽ không hiển thị trong Phân công.)
    const pccmMonsBase = pccmMonsAll.filter(m => monHasPositiveTietChuanAnyKhoi(m));

    // Tab Môn học vẫn phải giữ toàn bộ danh mục môn để người dùng có thể
    // chọn nhanh và phân công từ chính danh sách này.  Môn chưa có giáo viên
    // chỉ được đánh dấu trạng thái "Chưa phân công"; không được loại khỏi
    // danh sách (loại khỏi bảng sẽ khiến người dùng không có chỗ để phân).
    const pccmMonsBySubject = pccmMonsBase;
    if (PCCM_TAB === "monhoc") {
        const visibleKeys = new Set(pccmMonsBySubject.map(m=>_normText(m.key || m.ten)));
        if (!visibleKeys.has(_normText(PCCM_SUBJ))) {
            PCCM_SUBJ = _normText(pccmMonsBySubject[0]?.key || pccmMonsBySubject[0]?.ten);
        }
    }

    // ===== Giáo viên: ưu tiên lấy từ bảng Giáo viên (mã GV), fallback từ PCCM nếu bảng GV trống =====
    let gvs = (DATA.giaovien || [])
        .map(g=>_normText(g?.magv))
        .filter(Boolean);
    if (!gvs.length){
        const teachersSet = new Set();
        Object.values(DATA.pccmMatrix || {}).forEach(v=>{
            pccmTeacherListFromValue(v).forEach(s=>teachersSet.add(s));
        });
        gvs = Array.from(teachersSet);
    }
    if (!PCCM_SELECTED_GV && gvs.length) PCCM_SELECTED_GV = gvs[0];
    if (PCCM_SELECTED_GV && !gvs.includes(PCCM_SELECTED_GV) && gvs.length) PCCM_SELECTED_GV = gvs[0];

    // Tổng số tiết đã phân công theo tab hiện tại.
    let pccmTotalInfoHtml = "";
    const currentTabMons = PCCM_TAB === "monhoc" ? pccmMonsBySubject : pccmMonsBase;
    const pccmTotal = pccmComputeTotalTietForCurrentTab(classNames, currentTabMons);
    if (pccmTotal){
        pccmTotalInfoHtml = `
            <span class="pccm-total-badge"
                  title="${escapeHtml(pccmTotal.title || "")}"
                  aria-label="Tổng tiết: ${pccmTotal.assigned}">
                <span class="pccm-total-prefix">Tổng: </span><span class="pccm-total-value">${pccmTotal.assigned}</span>
            </span>`;
    }

    // ===== UI: tabs =====
    const tabBtn = (key, text, compactText) => `
        <button class="btn ${PCCM_TAB===key?"primary":""}"
                aria-label="${escapeHtml(text)}"
                onclick="setPCCMTab('${key}')">
            <span class="pccm-tab-label-full">${escapeHtml(text)}</span>
            <span class="pccm-tab-label-mobile">${escapeHtml(compactText || text)}</span>
        </button>`;

    let html = `
    <div class="action-bar pccm-action-bar">
        <div class="pccm-tab-actions">
            ${tabBtn("lop","Lớp học","Lớp")}
            ${tabBtn("giaovien","Giáo viên","GV")}
            ${tabBtn("monhoc","Môn học","Môn")}
        </div>

        <div class="pccm-main-actions">
            <button class="btn pccm-action-button" onclick="triggerPCCMImport()" title="Nhập Excel" aria-label="Nhập Excel">${appUiIcon("upload")}<span class="app-action-label">Nhập Excel</span></button>
            <button class="btn pccm-action-button" onclick="exportPCCMExcel()" title="Xuất Excel" aria-label="Xuất Excel">${appUiIcon("download")}<span class="app-action-label">Xuất Excel</span></button>
        </div>

        <div class="pccm-side-actions pccm-summary-actions">
            ${pccmTotalInfoHtml}
            <button class="btn danger pccm-delete-btn" title="Xóa Phân công" aria-label="Xóa Phân công" onclick="deleteAllPCCM()">${appUiIcon("trash")}<span class="app-action-label">Xóa</span></button>
        </div>
    </div>
    `;

    // ===== Content routing =====

    if (!classNames.length) {
        html += `
        <div style="padding:14px;background:#fff;border-radius:8px;border:1px solid #e3e8f3;margin-top:10px">
            Chưa có <b>Lớp</b>.
        </div>`;
        return html;
    }

    
    if (!pccmMonsAll.length) {
        html += `
        <div style="padding:14px;background:#fff;border-radius:8px;border:1px solid #e3e8f3;margin-top:10px">
            Chưa có <b>Môn học</b>. Vào menu <b>Môn học</b> để nhập file <b>mon.xlsx</b> trước.
        </div>`;
        return html;
    }

    if (!pccmMonsBase.length) {
        html += `
        <div style="padding:14px;background:#fff;border-radius:8px;border:1px solid #e3e8f3;margin-top:10px">
            Chưa có <b>Tiết chuẩn</b> (Số tiết &gt; 0). Vào menu <b>Tiết chuẩn</b> để nhập/thiết lập số tiết trước, sau đó quay lại <b>Phân công</b>.
        </div>`;
        return html;
    }


    if (PCCM_TAB === "giaovien") {
        html += renderPCCM_ByTeacher(gvs, pccmMonsBase, classNames);
    } else if (PCCM_TAB === "monhoc") {
        html += renderPCCM_BySubject(classNames, pccmMonsBySubject);
    } else {
        // mặc định = tab Lớp
        html += renderPCCM_ByClass(classNames, pccmMonsBase);
    }

    return html;
}



/* ==============================
   TRANG TIẾT CHUẨN (MENU LỚN)
   ============================== */

function setTCKhoi(khoi){
    TC_KHOI = khoi || "Tất cả";
    tcResetSelection();
    const sc = document.getElementById("section-content");
    if (sc) sc.innerHTML = renderTietChuanPage();
}

// Giữ tên hàm cũ (được gọi từ HTML) nhưng thực chất set cho trang Tiết chuẩn
function setPCCMTCMon(mon){
    TC_MON = mon || "Tất cả";
    tcResetSelection();
    const sc = document.getElementById("section-content");
    if (sc) sc.innerHTML = renderTietChuanPage();
}

function renderTietChuanPage(){
    // Đồng bộ Tiết chuẩn theo danh sách Môn học (nếu có dữ liệu)
    try{ ensureTietChuanSyncedFromMonHoc(); }catch(e){ /* ignore */ }

    // Nếu Môn học trống => không hiển thị dữ liệu Tiết chuẩn
    const monhocSet = new Set(
        (DATA.monhoc || [])
            .flatMap(r=>[r?.ten, r?.ma, r?.ma2, r?.id])
            .map(x=>_normText(x).toLowerCase())
            .filter(Boolean)
    );

    // lấy tất cả tiết chuẩn
    let monRowsAll = (DATA.mon || []).map(m=>({
        id: (m.id || "").toString().trim(),
        khoi: (m.khoi || "").trim(),
        ten: (m.ten || "").trim(),
        sotiet: (m.sotiet || "").toString().trim(),
        gioihan: (m.gioihan || "").toString().trim()
    })).filter(r=>r.khoi && r.ten);

    // lọc theo Môn học để tránh hiển thị dữ liệu cũ/khác
    if(monhocSet.size){
        monRowsAll = monRowsAll.filter(r=>monhocSet.has(_normText(r.ten).toLowerCase()));
    } else {
        monRowsAll = [];
    }

    // Danh sách khối ưu tiên lấy từ bảng Khối (nhanh hơn listbox)
    const khoiFromTable = (DATA.khoi || []).map(k => (k.ten || "").trim()).filter(Boolean);
    const khoiNames = Array.from(new Set(monRowsAll.map(r=>r.khoi))).filter(Boolean);

    const khoiUniq = Array.from(new Set((khoiFromTable.length ? khoiFromTable : khoiNames)));
    const khoiOptions = ["Tất cả", ...khoiUniq];

    if (!khoiOptions.includes(TC_KHOI)) TC_KHOI = "Tất cả";

    const rowsKhoi = (TC_KHOI === "Tất cả") ? monRowsAll : monRowsAll.filter(r => r.khoi === TC_KHOI);

    const filtered = rowsKhoi.slice();

    // ===== action bar (đồng bộ với các bảng khác) =====
    let html = `
    <div class="action-bar action-bar-data action-bar-tietchuan">
        <div class="tietchuan-filter-list">
            ${khoiOptions.map(k=>{
                const js = (k||"").toString().replace(/\\/g,"\\\\").replace(/'/g,"\\'");
                const compactLabel = k === "Tất cả" ? k : (extractKhoiNumber(k) || k);
                return `<button class="btn ${TC_KHOI===k?"primary":""}" aria-label="${escapeHtml(k)}" onclick="setTCKhoi('${js}')"><span class="tietchuan-filter-label-full">${escapeHtml(k)}</span><span class="tietchuan-filter-label-mobile">${escapeHtml(compactLabel)}</span></button>`;
            }).join("")}
        </div>
        <button class="btn app-action-button" onclick="triggerExcel('mon')" title="Nhập Excel" aria-label="Nhập Excel">${appUiIcon("upload")}<span class="app-action-label">Nhập Excel</span></button>
        <button class="btn app-action-button" onclick="exportExcel('mon')" title="Xuất Excel" aria-label="Xuất Excel">${appUiIcon("download")}<span class="app-action-label">Xuất Excel</span></button>

    </div>

    <div class="table-wrap tietchuan-table-wrap">
    <table class="tietchuan-table">
        <colgroup>
            <col class="tc-col-tt">
            <col class="tc-col-grade">
            <col class="tc-col-subject">
            <col class="tc-col-number">
            <col class="tc-col-number">
        </colgroup>
        <tr>
            <th>TT</th>
            <th>Khối học</th>
            <th>Môn học</th>
            <th class="tc-number-head">Số tiết</th>
            <th class="tc-number-head">Giới hạn</th>
        </tr>`;

    filtered.forEach((r,i)=>{
        const rid = (r.id || "").toString().trim();
        html += `
        <tr>
            <td style="text-align:center">${i+1}</td>
            <td>${escapeHtml(r.khoi)}</td>
            <td>${escapeHtml(r.ten)}</td>
            <td class="tc-cell" style="text-align:center;cursor:cell" 
                data-rowid="${escapeHtml(rid)}" data-field="sotiet" data-val="${escapeHtml(r.sotiet)}"
                data-r="${i}" data-c="0"
                onmousedown="tcCellMouseDown(event,this)" onmouseover="tcCellMouseOver(event,this)"
                onclick="tcCellClick(event,this)"
                ondblclick="tcBeginCellEdit(this)">${escapeHtml(r.sotiet)}</td>
            <td class="tc-cell" style="text-align:center;cursor:cell" 
                data-rowid="${escapeHtml(rid)}" data-field="gioihan" data-val="${escapeHtml(r.gioihan)}"
                data-r="${i}" data-c="1"
                onmousedown="tcCellMouseDown(event,this)" onmouseover="tcCellMouseOver(event,this)"
                onclick="tcCellClick(event,this)"
                ondblclick="tcBeginCellEdit(this)">${escapeHtml(r.gioihan)}</td>
        </tr>`;
    });

    if (!filtered.length){
        html += `<tr><td colspan="5" style="padding:14px;color:#666">Chưa có dữ liệu tiết chuẩn.</td></tr>`;
    }

    html += `</table></div>`;
    return html;
}
function setPCCMKhoi(khoi){
    PCCM_KHOI = khoi || "Tất cả";
    PCCM_SELECTED_CLASS = "";
    PCCM_SELECTED_GV = "";
    const sc = document.getElementById("section-content");
    if (sc) {
        const html = (sc.innerHTML || "");
        if (html.includes("PCCM") && typeof renderPCCM === "function") pccmRenderCurrent(sc);
        else if (typeof renderTietChuanPage === "function") sc.innerHTML = renderTietChuanPage();
    }
}

function setPCCMTietChuanMon(mon){
    TC_MON = mon || "Tất cả";
    const sc = document.getElementById("section-content");
    if (sc && typeof renderTietChuanPage === "function") sc.innerHTML = renderTietChuanPage();
}


function setPCCMTab(tab){
    const oldTab = PCCM_TAB;
    pccmRememberSideScroll(oldTab);
    PCCM_TAB = ["lop","giaovien","monhoc"].includes(tab) ? tab : "lop";
    pccmRenderCurrent("section-content", { skipRemember: true, restoreTab: PCCM_TAB });
}
function setPCCMSelectedClass(cls){
    PCCM_SELECTED_CLASS = cls;
    pccmRenderCurrent("section-content");
}
function setPCCMSelectedGV(name){
    PCCM_SELECTED_GV = name;
    pccmRenderCurrent("section-content");
}

function pccmNotifySaveProblem(message, silent){
    if (silent && typeof showBottomPopup === "function") showBottomPopup(message, "warning");
    else alert(message);
}

function pccmRefreshTotalBadge(){
    try{
        const badge = document.querySelector(".pccm-summary-actions .pccm-total-badge");
        if (!badge) return;
        pccmEnsureLookupCache();
        const lopObjs = (DATA.lop || []).map(l=>({
            ten2: canonTen2FromLop(l)
        })).filter(x=>x.ten2);
        const classNames = Array.from(new Set(lopObjs.map(x=>x.ten2)));
        const pccmMonsBase = buildPCCMMonList().filter(m => monHasPositiveTietChuanAnyKhoi(m));
        const pccmTotal = pccmComputeTotalTietForCurrentTab(classNames, pccmMonsBase);
        if (!pccmTotal) return;
        const value = badge.querySelector(".pccm-total-value");
        if (value) value.textContent = String(pccmTotal.assigned);
        else badge.textContent = `Tổng: ${pccmTotal.assigned}`;
        badge.setAttribute("aria-label", `Tổng tiết: ${pccmTotal.assigned}`);
        badge.title = pccmTotal.title || "";
    }catch(e){
        // ignore
    }
}

// Lưu theo đúng tab PCCM đang mở. UI hiện tự lưu khi chỉnh ô, không cần nút Lưu.
function pccmSaveActive(opts){
    opts = opts || {};
    switch (PCCM_TAB){
        case "giaovien":
            return (typeof pccmSaveTeacherEdits === "function") ? pccmSaveTeacherEdits(opts) : void 0;
        case "monhoc":
            return (typeof pccmSaveSubjectEdits === "function") ? pccmSaveSubjectEdits(opts) : void 0;
        case "lop":
        default:
            return (typeof pccmSaveClassEdits === "function") ? pccmSaveClassEdits(opts) : void 0;
    }
}

function pccmAutoSaveActive(){
    try{
        if (!document.querySelector(".pccm-action-bar")) return true;
        return pccmSaveActive({silent:true});
    }catch(e){
        return false;
    }
}

function pccmCellAttrs(r, c, kind){
    return `class="pccm-copy-cell pccm-cell-${escapeHtml(kind || "data")}" data-r="${Number(r)}" data-c="${Number(c)}" data-kind="${escapeHtml(kind || "data")}" onmousedown="pccmCellMouseDown(event,this)" onmouseover="pccmCellMouseOver(event,this)" ondblclick="pccmCellDblClick(event,this)"`;
}

function pccmIsActive(){
    return !!document.querySelector(".pccm-copy-cell[data-r][data-c]");
}

function pccmKey(r,c){
    return `${Number(r)},${Number(c)}`;
}

function pccmGetCell(r,c){
    return document.querySelector(`.pccm-copy-cell[data-r="${Number(r)}"][data-c="${Number(c)}"]`);
}

function pccmUpdateSelectionUI(){
    const cells = Array.from(document.querySelectorAll(".pccm-copy-cell[data-r][data-c]"));
    cells.forEach(td=>{
        const key = pccmKey(td.dataset.r, td.dataset.c);
        td.classList.toggle("pccm-cell-selected", PCCM_CELL_SELECTION.has(key));
        td.classList.toggle("pccm-cell-anchor", !!PCCM_CELL_ANCHOR && Number(td.dataset.r) === Number(PCCM_CELL_ANCHOR.r) && Number(td.dataset.c) === Number(PCCM_CELL_ANCHOR.c));
    });
}

function pccmSetSingleSelection(r,c){
    PCCM_CELL_SELECTION = new Set([pccmKey(r,c)]);
    PCCM_CELL_ANCHOR = {r:Number(r), c:Number(c)};
    pccmUpdateSelectionUI();
}

function pccmSelectRange(a,b, keepAnchor){
    if (!a || !b) return;
    const r1 = Math.min(Number(a.r), Number(b.r));
    const r2 = Math.max(Number(a.r), Number(b.r));
    const c1 = Math.min(Number(a.c), Number(b.c));
    const c2 = Math.max(Number(a.c), Number(b.c));
    const next = new Set();
    for(let r=r1; r<=r2; r++){
        for(let c=c1; c<=c2; c++){
            if(pccmGetCell(r,c)) next.add(pccmKey(r,c));
        }
    }
    PCCM_CELL_SELECTION = next;
    if(!keepAnchor) PCCM_CELL_ANCHOR = {r:Number(b.r), c:Number(b.c)};
    pccmUpdateSelectionUI();
}

function pccmToggleSelection(r,c){
    const key = pccmKey(r,c);
    if(PCCM_CELL_SELECTION.has(key)) PCCM_CELL_SELECTION.delete(key);
    else PCCM_CELL_SELECTION.add(key);
    PCCM_CELL_ANCHOR = {r:Number(r), c:Number(c)};
    pccmUpdateSelectionUI();
}

function pccmClearSelection(){
    PCCM_CELL_SELECTION = new Set();
    PCCM_CELL_ANCHOR = null;
    PCCM_CELL_DRAG_START = null;
    pccmUpdateSelectionUI();
}

function pccmCellMouseDown(ev, td){
    try{
        if (!ev || !td) return;
        if (ev.button !== 0) return;
        if (ev.target && ev.target.closest && ev.target.closest(".pccm-multi-menu")) return;
        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        if(!Number.isFinite(r) || !Number.isFinite(c)) return;

        if (ev.shiftKey && PCCM_CELL_ANCHOR){
            pccmSelectRange(PCCM_CELL_ANCHOR, {r,c});
        } else if (ev.ctrlKey || ev.metaKey){
            pccmToggleSelection(r,c);
        } else {
            pccmSetSingleSelection(r,c);
        }
        PCCM_CELL_DRAGGING = true;
        PCCM_CELL_DRAG_START = {r,c};
        // Numeric PCCM cells behave like spreadsheet cells: a normal click
        // selects the cell without entering the input. Double-click/Enter/F2
        // remains available for explicit editing, while a typed digit is
        // applied and saved directly by pccmGlobalKeyDown().
        const kind = String(td.dataset?.kind || "").toLowerCase();
        const numericInput = (kind === "periods" || kind === "limit")
            ? td.querySelector("input.inline-edit-input")
            : null;
        if(numericInput){
            try{
                const active = document.activeElement;
                if(active && active !== document.body && typeof active.blur === "function") active.blur();
            }catch(_){ }
            ev.preventDefault();
            return;
        }
        // Selects/buttons keep their native focus. Other cells cancel native
        // text selection so drag-selection remains spreadsheet-like.
        const opensControl = ev.target && ev.target.closest && ev.target.closest(
            ".pccm-multi-button, select.inline-edit-select, input.inline-edit-input"
        );
        if (!opensControl){
            ev.preventDefault();
        }
    }catch(e){
        // ignore
    }
}

function pccmCellMouseOver(ev, td){
    try{
        if(!PCCM_CELL_DRAGGING || !PCCM_CELL_ANCHOR || !td) return;
        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        if(!Number.isFinite(r) || !Number.isFinite(c)) return;
        pccmSelectRange(PCCM_CELL_DRAG_START || PCCM_CELL_ANCHOR, {r,c}, true);
        if(ev) ev.preventDefault();
    }catch(e){
        // ignore
    }
}

function pccmCellDblClick(ev, td){
    try{
        if(!td) return;
        const target = ev?.target;
        if (target && target.closest && target.closest(".pccm-multi-menu")) return;
        const input = td.querySelector("input.inline-edit-input");
        if(input){
            input.focus();
            input.select();
            return;
        }
        const select = td.querySelector("select.inline-edit-select");
        if(select){
            select.focus();
            return;
        }
        const button = td.querySelector(".pccm-multi-button");
        if(button) button.click();
    }catch(e){
        // ignore
    }
}

function pccmGetSelectionRect(){
    if(!PCCM_CELL_SELECTION || PCCM_CELL_SELECTION.size === 0) return null;
    let minR = 1e9, maxR = -1e9, minC = 1e9, maxC = -1e9;
    for(const key of PCCM_CELL_SELECTION){
        const [r,c] = (key||"").split(",").map(Number);
        if(!Number.isFinite(r) || !Number.isFinite(c)) continue;
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
    }
    if(minR > maxR || minC > maxC) return null;
    return {minR, maxR, minC, maxC};
}

function pccmCellValue(td){
    if(!td) return "";
    const teacherHidden = td.querySelector(".pccm-teacher-multi input[type='hidden']");
    if(teacherHidden) return (teacherHidden.value ?? "").toString();
    const input = td.querySelector("input.inline-edit-input");
    if(input) return (input.value ?? "").toString();
    const select = td.querySelector("select.inline-edit-select");
    if(select) return (select.value ?? "").toString();
    return (td.innerText ?? td.textContent ?? "").toString().trim();
}

function pccmSetSelectValue(select, raw){
    if(!select) return false;
    const value = (raw ?? "").toString().trim();
    const low = value.toLowerCase();
    const options = Array.from(select.options || []);
    let found = options.find(opt => (opt.value || "").toString().trim().toLowerCase() === low)
        || options.find(opt => (opt.textContent || "").toString().trim().toLowerCase() === low);
    if(!found && value){
        found = document.createElement("option");
        found.value = value;
        found.textContent = `(Đang lưu) ${value}`;
        found.setAttribute("data-title", value);
        select.insertBefore(found, select.firstChild);
    }
    if(found){
        select.value = found.value;
        pccmUpdateOptionTitle(select);
        return true;
    }
    return false;
}

function pccmSetCellValue(td, raw){
    if(!td) return false;
    const value = (raw ?? "").toString().trim();
    const teacherHidden = td.querySelector(".pccm-teacher-multi input[type='hidden']");
    if(teacherHidden){
        pccmTeacherMultiApply(teacherHidden.id, value);
        return true;
    }
    const input = td.querySelector("input.inline-edit-input");
    if(input){
        input.value = value;
        return true;
    }
    const select = td.querySelector("select.inline-edit-select");
    if(select){
        return pccmSetSelectValue(select, value);
    }
    return false;
}

function pccmBuildCopyText(){
    const rect = pccmGetSelectionRect();
    if(!rect) return "";
    const lines = [];
    for(let r=rect.minR; r<=rect.maxR; r++){
        const row = [];
        for(let c=rect.minC; c<=rect.maxC; c++){
            const key = pccmKey(r,c);
            const td = pccmGetCell(r,c);
            row.push((td && PCCM_CELL_SELECTION.has(key)) ? pccmCellValue(td) : "");
        }
        lines.push(row.join("\t"));
    }
    return lines.join("\n");
}

function pccmCopySelectionToClipboard(){
    try{
        const text = pccmBuildCopyText();
        if(!text) return;
        if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(text).catch(()=>tcFallbackCopy(text));
        }else{
            tcFallbackCopy(text);
        }
    }catch(e){
        // ignore
    }
}

function pccmPasteMatrix(matrix){
    const rect = pccmGetSelectionRect();
    if(!rect || !Array.isArray(matrix) || !matrix.length) return;

    if(matrix.length === 1 && (matrix[0] || []).length === 1 && PCCM_CELL_SELECTION.size > 1){
        const value = (matrix[0][0] ?? "").toString();
        for(const key of PCCM_CELL_SELECTION){
            const [r,c] = (key||"").split(",").map(Number);
            pccmSetCellValue(pccmGetCell(r,c), value);
        }
        pccmAutoSaveActive();
        pccmUpdateSelectionUI();
        return;
    }

    for(let i=0; i<matrix.length; i++){
        const row = matrix[i] || [];
        for(let j=0; j<row.length; j++){
            pccmSetCellValue(pccmGetCell(rect.minR + i, rect.minC + j), row[j]);
        }
    }
    pccmAutoSaveActive();
    pccmUpdateSelectionUI();
}

function pccmClearSelectedCells(){
    for(const key of PCCM_CELL_SELECTION){
        const [r,c] = (key||"").split(",").map(Number);
        pccmSetCellValue(pccmGetCell(r,c), "");
    }
    pccmAutoSaveActive();
    pccmUpdateSelectionUI();
}

function pccmSelectedNumericCell(){
    const candidates = [];
    if(PCCM_CELL_ANCHOR){
        candidates.push(pccmGetCell(PCCM_CELL_ANCHOR.r, PCCM_CELL_ANCHOR.c));
    }
    for(const key of (PCCM_CELL_SELECTION || [])){
        const [r,c] = String(key || "").split(",").map(Number);
        candidates.push(pccmGetCell(r,c));
    }
    return candidates.find(td=>{
        if(!td) return false;
        const kind = String(td.dataset?.kind || "").toLowerCase();
        return (kind === "periods" || kind === "limit")
            && !!td.querySelector("input.inline-edit-input");
    }) || null;
}

function pccmBeginSelectedNumericEdit(initialValue){
    const td = pccmSelectedNumericCell();
    const input = td?.querySelector("input.inline-edit-input");
    if(!input) return false;
    try{ input.focus({preventScroll:true}); }catch(_){ try{ input.focus(); }catch(__){} }
    if(initialValue !== undefined && initialValue !== null){
        input.value = String(initialValue);
        try{
            const end = input.value.length;
            input.setSelectionRange?.(end, end);
        }catch(_){ }
    }else{
        try{ input.select(); }catch(_){ }
    }
    return true;
}

function pccmSetSelectedNumericValue(value){
    const td = pccmSelectedNumericCell();
    const input = td?.querySelector("input.inline-edit-input");
    if(!input) return false;
    input.value = String(value ?? "").trim();
    pccmAutoSaveActive();
    pccmUpdateSelectionUI();
    return true;
}

function pccmGlobalKeyDown(ev){
    try{
        if(!pccmIsActive()) return;
        if(!PCCM_CELL_SELECTION || PCCM_CELL_SELECTION.size === 0) return;
        const tag = (ev?.target?.tagName || "").toUpperCase();
        const isTyping = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
        const isCmd = !!(ev.ctrlKey || ev.metaKey);
        const key = (ev.key || "").toLowerCase();

        if(isCmd && key === "c"){
            if(isTyping) return;
            ev.preventDefault();
            pccmCopySelectionToClipboard();
            return;
        }

        if(key === "escape"){
            if(isTyping) return;
            pccmClearSelection();
            return;
        }

        // Spreadsheet-style entry: a digit changes and saves the selected
        // Số tiết/Giới hạn cell immediately without focusing its input.
        if(!isTyping && !isCmd && !ev.altKey && /^[0-9]$/.test(String(ev.key || ""))){
            if(pccmSetSelectedNumericValue(ev.key)){
                ev.preventDefault();
                return;
            }
        }
        if(!isTyping && !isCmd && !ev.altKey && (key === "enter" || key === "f2")){
            if(pccmBeginSelectedNumericEdit()){
                ev.preventDefault();
                return;
            }
        }

        if((key === "delete" || key === "backspace") && !isTyping){
            ev.preventDefault();
            pccmClearSelectedCells();
        }
    }catch(e){
        // ignore
    }
}

function pccmGlobalPaste(ev){
    try{
        if(!pccmIsActive()) return;
        if(!PCCM_CELL_SELECTION || PCCM_CELL_SELECTION.size === 0) return;
        const tag = (ev?.target?.tagName || "").toUpperCase();
        const isTyping = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
        if(isTyping) return;

        const text = (ev.clipboardData || window.clipboardData)?.getData("text");
        if(typeof text !== "string") return;
        const matrix = tcParseClipboard(text);
        if(!matrix.length) return;
        ev.preventDefault();
        pccmPasteMatrix(matrix);
    }catch(e){
        // ignore
    }
}

function setPCCMTeacherClassFilter(cls){
    PCCM_TEACHER_CLASS_FILTER = cls || "Tất cả";
    const sc = document.getElementById("section-content");
    if (sc) pccmRenderCurrent(sc);
}

function setPCCMTeacher(lopCanon, monTen, val){
    const key = `${lopCanon}|${monTen}`;
    val = pccmNormalizeTeacherValue(val);
    if (val) DATA.pccmMatrix[key] = val;
    else delete DATA.pccmMatrix[key];
    saveStore();
}

function setPCCMRoom(lopCanon, monTen, val){
    const key = `${lopCanon}|${monTen}`;
    val = (val||"").trim();
    if (val) DATA.pccmRoomMatrix[key] = val;
    else delete DATA.pccmRoomMatrix[key];
    saveStore();
}

// ===== PCCM: Copy/Paste nhanh Giáo viên trong listbox (Ctrl/Cmd + C / V) =====
let PCCM_CLIPBOARD_GV = "";

function pccmHandleGVCopyPaste(ev, selectEl){
    try{
        const isCmd = !!(ev && (ev.ctrlKey || ev.metaKey));
        if (!isCmd) return;
        const key = (ev.key || "").toLowerCase();
        if (key === "c"){
            PCCM_CLIPBOARD_GV = (selectEl?.value ?? "").toString();
            ev.preventDefault();
            return;
        }
        if (key === "v"){
            const v = (PCCM_CLIPBOARD_GV ?? "").toString();
            if (!selectEl) return;

            // nếu value chưa có trong options thì thêm option tạm để tránh mất dữ liệu
            const exists = Array.from(selectEl.options || []).some(o => (o.value||"") === v);
            if (v && !exists){
                const opt = document.createElement("option");
                opt.value = v;
                opt.textContent = `(Đang lưu) ${v}`;
                const hint = pccmTeacherHint(v) || v;
                opt.title = hint;
                opt.setAttribute("data-title", hint);
                selectEl.insertBefore(opt, selectEl.firstChild);
            }
            selectEl.value = v;
            pccmUpdateOptionTitle(selectEl);
            ev.preventDefault();
        }
    }catch(e){
        // ignore
    }
}


// ===== PCCM: Double-click để mở listbox (Lớp/Môn), 1-click để chọn text copy =====
function pccmSelectText(el){
    try{
        if (!el) return;
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA"){
            // lưu lại giá trị trước khi người dùng paste/sửa
            try{ el.setAttribute('data-prev', (el.value ?? '').toString()); }catch(_){ }
            el.focus();
            el.select();
            return;
        }

        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
    }catch(e){
        // ignore
    }
}


// ===== PCCM: Input (1-click) để copy/paste + Enter/Blur để commit sang select =====
function pccmDblInputKeyDown(ev, inputEl){
    try{
        if (!ev || !inputEl) return;
        if (ev.key === 'Enter'){
            ev.preventDefault();
            inputEl.blur();
            return;
        }
        if (ev.key === 'Escape'){
            ev.preventDefault();
            const prev = inputEl.getAttribute('data-prev');
            if (prev !== null && prev !== undefined) inputEl.value = prev;
            inputEl.blur();
            return;
        }
    }catch(e){
        // ignore
    }
}

function pccmDblInputCommit(inputEl){
    try{
        const el = (typeof inputEl === 'string') ? document.getElementById(inputEl) : inputEl;
        if (!el) return;
        // reset "click-armed" state so lần click sau lại trở về hành vi chọn-copy trước
        try{ el.setAttribute('data-openarmed','0'); }catch(_){ }
        const selectId = el.getAttribute('data-selectid');
        if (!selectId) return;
        const sel = document.getElementById(selectId);
        if (!sel) return;

        const kind = (el.getAttribute('data-kind') || sel.getAttribute('data-kind') || '').toString();

        // Nếu là Môn và select có data-class-select => refresh list theo lớp
        if (kind === 'mon'){
            const clsSelId = sel.getAttribute('data-class-select');
            if (clsSelId){
                const clsSel = document.getElementById(clsSelId);
                const clsVal = clsSel ? (clsSel.value || '') : '';
                pccmFillMonOptions(sel, clsVal);
            }
        }

        const raw = (el.value || '').toString();
        const txt = raw.normalize('NFC').trim();
        if (!txt){
            // không cho rỗng => revert
            const prev = el.getAttribute('data-prev');
            if (prev !== null && prev !== undefined) el.value = prev;
            return;
        }

        const low = txt.toLowerCase();
        let matched = null;

        const opts = Array.from(sel.options || []);
        for (const opt of opts){
            const v = (opt.value || '').toString().normalize('NFC').trim().toLowerCase();
            const t = (opt.textContent || '').toString().normalize('NFC').trim().toLowerCase();
            if (low === v || low === t){
                matched = opt.value;
                break;
            }
        }

        // fallback: match contains (duy nhất)
        if (matched === null){
            const cands = opts.filter(opt => {
                const t = (opt.textContent || '').toString().normalize('NFC').trim().toLowerCase();
                return t.includes(low);
            });
            if (cands.length === 1) matched = cands[0].value;
        }

        if (matched !== null){
            sel.value = matched;
            pccmDblSelSyncText(selectId);

            // Nếu commit là Lớp => refresh lại list Môn của dòng
            if (kind === 'cls'){
                pccmRowClassChanged(sel);
                pccmDblSelSyncText(selectId);
            }
        }else{
            const prev = el.getAttribute('data-prev');
            if (prev !== null && prev !== undefined) el.value = prev;
        }
    }catch(e){
        // ignore
    }
}


function pccmDblSelSyncText(selectId){
    try{
        const sel = document.getElementById(selectId);
        if (!sel) return;

        const inputId = sel.getAttribute('data-inputid');
        const textId  = sel.getAttribute('data-textid');
        const node = inputId ? document.getElementById(inputId) : (textId ? document.getElementById(textId) : null);
        if (!node) return;

        const opt = (sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex] : null;
        const display = opt ? (opt.textContent || '') : (sel.value || '');

        const tag = (node.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA'){
            node.value = display;
        }else{
            node.textContent = display;
        }
        try{ node.setAttribute('data-value', sel.value || ''); }catch(_){ }
    }catch(e){
        // ignore
    }
}


function pccmFillMonOptions(selectEl, clsVal){
    try{
        if (!selectEl) return;
        const curVal = (selectEl.value || "").toString();

        // base list: chỉ các môn có tiết chuẩn ở ít nhất 1 khối
        const base = buildPCCMMonList().filter(m => monHasPositiveTietChuanAnyKhoi(m));
        const allowed = clsVal ? pccmGetAllowedMonsForClass(clsVal, base) : base;

        const allowedKeys = new Set(allowed.map(m => (m.key || m.ten || "").toString()));

        // nếu current đang là 1 giá trị lạ (do dữ liệu cũ), giữ lại option tạm
        const extraOpt = (curVal && !allowedKeys.has(curVal))
            ? `<option value="${escapeHtml(curVal)}" selected title="${escapeHtml(curVal)}" data-title="${escapeHtml(curVal)}">(Đang lưu) ${escapeHtml(curVal)}</option>`
            : "";

        const opts = allowed.map(m=>{
            const k = (m.key || m.ten || "").toString();
            return pccmRenderSubjectOption(m, k===curVal);
        }).join("");

        selectEl.innerHTML = `${extraOpt}${opts}`;

        // nếu cur không còn hợp lệ => chọn môn đầu tiên
        if (curVal && allowedKeys.has(curVal)){
            selectEl.value = curVal;
        }else if (allowed[0]){
            selectEl.value = (allowed[0].key || allowed[0].ten || "").toString();
        }
        pccmUpdateOptionTitle(selectEl);
    }catch(e){
        // ignore
    }
}

function pccmRowClassChanged(clsSelectEl){
    try{
        if (!clsSelectEl) return;
        const monSelId = clsSelectEl.getAttribute("data-monselect");
        if (!monSelId) return;
        const monSel = document.getElementById(monSelId);
        if (!monSel) return;
        pccmFillMonOptions(monSel, (clsSelectEl.value || "").toString());
        pccmDblSelSyncText(monSelId);
    }catch(e){
        // ignore
    }
}


// PCCM listbox input:
// - Click lần 1: chọn text để copy
// - Click lần 2 (vẫn ở đúng ô đang focus): xổ listbox
// (Ctrl/Cmd+Click: mở listbox ngay)
function pccmInputClick(ev, inputEl, selId){
    try{
        if(!inputEl) return;

        // (NEW) Click 1 lần: mở listbox ngay.
        // Giữ Ctrl/Cmd khi click: chỉ chọn text để copy (không mở listbox).
        if(ev && (ev.ctrlKey || ev.metaKey)){
            pccmSelectText(inputEl);
            try{ inputEl.setAttribute('data-openarmed','0'); }catch(_){ }
            return;
        }

        try{ inputEl.setAttribute('data-openarmed','0'); }catch(_){ }
        pccmDblSelOpen(selId);
    }catch(e){
        // ignore
    }
}

function pccmDblSelOpen(selectId){
    try{
        const sel = document.getElementById(selectId);
        if (!sel) return;

        // Nếu là list Môn thì refresh option theo Lớp hiện tại (chỉ khi có data-class-select)
        const kind = sel.getAttribute('data-kind') || '';
        if (kind === 'mon'){
            const clsSelId = sel.getAttribute('data-class-select');
            if (clsSelId){
                const clsSel = document.getElementById(clsSelId);
                const clsVal = clsSel ? (clsSel.value || '') : '';
                pccmFillMonOptions(sel, clsVal);
            }
        }

        const inputId = sel.getAttribute('data-inputid');
        const textId  = sel.getAttribute('data-textid');
        const node = inputId ? document.getElementById(inputId) : (textId ? document.getElementById(textId) : null);
        if (node) node.style.display = 'none';

        // Hiển thị dạng listbox (size>1) khi mở
        const size = Number(sel.getAttribute('data-size') || 8);
        if (Number.isFinite(size) && size > 1) sel.size = size;

        sel.style.display = '';
        sel.disabled = false;
        sel.focus();

        // cố gắng mở dropdown ngay khi dblclick (tùy trình duyệt)
        try{ sel.click(); }catch(e){}
    }catch(e){
        // ignore
    }
}


function pccmDblSelClose(selectId, commit){
    try{
        const sel = document.getElementById(selectId);
        if (!sel) return;
        if (commit) pccmDblSelSyncText(selectId);

        const inputId = sel.getAttribute('data-inputid');
        const textId  = sel.getAttribute('data-textid');
        const node = inputId ? document.getElementById(inputId) : (textId ? document.getElementById(textId) : null);

        sel.style.display = 'none';
        sel.disabled = true;
        if (node) node.style.display = '';
    }catch(e){
        // ignore
    }
}



/* ============================================================
   PASTE FROM EXCEL (Tab-separated) — TIẾT CHUẨN
   - Cho phép copy bảng từ Excel rồi dán vào textarea
   - Nếu thiếu cột Khối học, sẽ dùng khối đang chọn ở PCCM
============================================================ */
function _normText(x){
    return (x ?? "")
        .toString()
        .normalize("NFC")
        .replace(/\r?\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// ============================================================
// TIẾT CHUẨN: đồng bộ từ Môn học
// - Nếu Môn học có dữ liệu: tạo thiếu (Khối x Môn) với mặc định
//   Số tiết/tuần = 1, Giới hạn = 1.
// - Nếu Môn học trống: KHÔNG tự tạo. (render sẽ không hiển thị)
// ============================================================
function ensureTietChuanSyncedFromMonHoc(){
    const monhoc = Array.isArray(DATA.monhoc) ? DATA.monhoc : [];
    if(!monhoc.length) return;

    // Danh sách khối
    let khoiList = (DATA.khoi || []).map(k=>_normText(k?.ten)).filter(Boolean);
    if(!khoiList.length){
        // fallback: lấy từ danh sách lớp
        const set = new Set();
        (DATA.lop || []).forEach(l=>{
            const raw = _normText(l?.khoi) || _normText(l?.ten2) || _normText(l?.ten);
            const kn = extractKhoiNumber(raw);
            if(kn) set.add(`Khối ${kn}`);
        });
        khoiList = [...set];
    }
    if(!khoiList.length) return;

    // Danh sách môn (tôn trọng cột Khối học/Cấp học trong Môn học)
    const monItems = [];
    const seen = new Set();
    monhoc.forEach(m=>{
        const ten = _normText(m?.ten);
        const ma = _normText(m?.ma);
        const ma2 = _normText(m?.ma2);
        const keyName = ma || ma2 || ten;
        if(!keyName) return;
        const k = `${keyName.toLowerCase()}|${monhocLevelText(m).toLowerCase()}`;
        if(seen.has(k)) return;
        seen.add(k);
        monItems.push(m);
    });
    if(!monItems.length) return;

    if(!Array.isArray(DATA.mon)) DATA.mon = [];
    let changed = false;

    // Canon khoi: luôn về dạng "Khối X" nếu lấy được số
    const canonKhoi = (khoiRaw)=>{
        const t = _normText(khoiRaw);
        const n = extractKhoiNumber(t);
        return n ? `Khối ${n}` : t;
    };

    // Tìm môn theo mọi alias (id/ten/ma/ma2) để map code -> tên hiển thị
    const findMonhoc = (monValue)=>{
        const v = _normText(monValue);
        if(!v) return null;
        const low = v.toLowerCase();
        return (DATA.monhoc || []).find(r=>{
            const id  = _normText(r.id).toLowerCase();
            const ten = _normText(r.ten).toLowerCase();
            const ma  = _normText(r.ma).toLowerCase();
            const ma2 = _normText(r.ma2).toLowerCase();
            return (id && id === low) || (ten && ten === low) || (ma && ma === low) || (ma2 && ma2 === low);
        }) || null;
    };
    const canonMon = (monRaw)=>{
        const found = findMonhoc(monRaw);
        if(!found) return _normText(monRaw);
        return _normText(found.ma) || _normText(found.ma2) || _normText(found.ten) || _normText(monRaw);
    };

    // Map existing (khoiCanon|tenCanonLower) + dọn trùng (merge) để tránh đúp
    const map = new Map();
    const cleaned = [];

    for(const r of (DATA.mon || [])){
        if(!r || typeof r !== "object"){
            cleaned.push(r);
            continue;
        }
        const khoi0 = canonKhoi(r.khoi);
        const ten0  = canonMon(r.ten);

        if(!khoi0 || !ten0){
            cleaned.push(r);
            continue;
        }

        const key = `${khoi0}|${ten0.toLowerCase()}`;

        // normalize dữ liệu đang lưu (để lần sau không lệch)
        if(_normText(r.khoi) !== khoi0){ r.khoi = khoi0; changed = true; }
        if(_normText(r.ten)  !== ten0 ){ r.ten  = ten0;  changed = true; }

        const ex = map.get(key);
        if(!ex){
            map.set(key, r);
            cleaned.push(r);
        }else{
            // merge dữ liệu (ưu tiên giá trị đang có; nếu trống/không hợp lệ thì lấy của dòng trùng)
            const st1 = String(ex.sotiet ?? "").trim();
            const gh1 = String(ex.gioihan ?? "").trim();
            const st2 = String(r.sotiet ?? "").trim();
            const gh2 = String(r.gioihan ?? "").trim();

            if((st1 === "" || Number.isNaN(Number(st1))) && st2 !== "" && !Number.isNaN(Number(st2))){
                ex.sotiet = st2;
                changed = true;
            }
            if((gh1 === "" || Number.isNaN(Number(gh1))) && gh2 !== "" && !Number.isNaN(Number(gh2))){
                ex.gioihan = gh2;
                changed = true;
            }

            // bỏ dòng trùng khỏi DATA.mon
            changed = true;
        }
    }

    if(cleaned.length !== (DATA.mon || []).length){
        DATA.mon = cleaned;
    }

    // Ensure all combos exist
    for(const khoiRaw of khoiList){
        const khoi = canonKhoi(khoiRaw);
        if(!khoi) continue;

        for(const monItem of monItems){
            if(!monhocAppliesToKhoi(monItem, khoi)) continue;
            const tenRaw = _normText(monItem?.ma) || _normText(monItem?.ma2) || _normText(monItem?.ten);
            const ten = canonMon(tenRaw) || _normText(tenRaw);
            if(!ten) continue;

            const key = `${khoi}|${ten.toLowerCase()}`;
            const ex = map.get(key);

            if(!ex){
                const obj = {
                    id: autoID("mon"),
                    khoi: khoi,
                    ten: ten,
                    sotiet: "1",
                    gioihan: "1"
                };
                DATA.mon.push(obj);
                map.set(key, obj);
                changed = true;
                continue;
            }

            // điền mặc định nếu thiếu/không hợp lệ
            const st = String(ex.sotiet ?? "").trim();
            const gh = String(ex.gioihan ?? "").trim();
            if(st === "" || Number.isNaN(Number(st))){
                ex.sotiet = "1";
                changed = true;
            }
            if(gh === "" || Number.isNaN(Number(gh))){
                ex.gioihan = "1";
                changed = true;
            }
        }
    }

    if(changed) saveStore();
}

// Room list helpers (hiển thị kèm Mã môn học trong ngoặc nếu có)
function getPhongOptionItems(){
    const items = (DATA.phong || [])
        .map(p=>({
            value: _normText(p?.ten),
            mon: _normText(p?.tinhtrang)
        }))
        .filter(x=>x.value)
        .sort((a,b)=>a.value.localeCompare(b.value,'vi'));
    return items.map(x=>({
        value: x.value,
        label: x.mon ? `${x.value} (${x.mon})` : x.value
    }));
}

/* ============================================================
   Helpers: hiển thị tên môn theo mã / id / tên
============================================================ */
function resolveMonDisplay(monValue){
    const v = _normText(monValue);
    if (!v) return "";
    const low = v.toLowerCase();
    const found = (DATA.monhoc || []).find(r=>{
        const id  = _normText(r.id).toLowerCase();
        const ten = _normText(r.ten).toLowerCase();
        const ma  = _normText(r.ma).toLowerCase();
        const ma2 = _normText(r.ma2).toLowerCase();
        return (id && id === low) || (ten && ten === low) || (ma && ma === low) || (ma2 && ma2 === low);
    });
    return found ? (_normText(found.ten) || v) : v;
}

function monhocHiddenSortCode(row){
    if(!row) return "";
    return _normText(row.ma) || _normText(row.ma2) || _normText(row.id) || _normText(row.ten) || "";
}
function compareMonhocByHiddenCode(a,b){
    const code = monhocHiddenSortCode(a).localeCompare(monhocHiddenSortCode(b),'vi',{sensitivity:'base'});
    if(code) return code;
    return _normText(a?.ten || a?.ma || a?.ma2 || a?.id).localeCompare(_normText(b?.ten || b?.ma || b?.ma2 || b?.id),'vi');
}
function pccmMonHiddenSortCode(monObj){
    if(!monObj) return "";
    return _normText(monObj.code) || _normText(monObj.ma) || _normText(monObj.ma2) || _normText(monObj.key) || _normText(monObj.ten);
}
function pccmSubjectCode(monObj){
    if(!monObj) return "";
    return _normText(monObj.code) || _normText(monObj.ma) || _normText(monObj.ma2) || _normText(monObj.key) || _normText(monObj.ten);
}
function excelSubjectShortName(monValue){
    const raw = _normText(monValue);
    if(!raw) return "";
    const low = raw.toLowerCase();
    const found = (DATA.monhoc || []).find(r=>{
        const id  = _normText(r.id).toLowerCase();
        const ten = _normText(r.ten).toLowerCase();
        const ma  = _normText(r.ma).toLowerCase();
        const ma2 = _normText(r.ma2).toLowerCase();
        return (id && id === low) || (ten && ten === low) || (ma && ma === low) || (ma2 && ma2 === low);
    });
    if(!found) return raw;
    return pccmSubjectCode({
        key: raw,
        ten: _normText(found.ten),
        ma: _normText(found.ma),
        ma2: _normText(found.ma2),
        code: ""
    }) || raw;
}
function pccmSubjectName(monObj){
    if(!monObj) return "";
    return _normText(monObj.ten) || _normText(monObj.name) || _normText(monObj.key) || pccmSubjectCode(monObj);
}
function pccmSubjectHint(monObj){
    const code = pccmSubjectCode(monObj);
    const name = pccmSubjectName(monObj);
    if (code && name && code !== name) return `${code} - ${name}`;
    return name || code;
}
function pccmRenderSubjectOption(monObj, selected){
    const value = (monObj && (monObj.key || monObj.ten || monObj.code || monObj.ma || monObj.ma2)) || "";
    const label = pccmSubjectCode(monObj) || pccmSubjectName(monObj) || value;
    const title = pccmSubjectHint(monObj) || label;
    return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""} title="${escapeHtml(title)}" data-title="${escapeHtml(title)}">${escapeHtml(label)}</option>`;
}
function pccmTeacherName(code){
    const value = _normText(code);
    if (!value) return "";
    const low = value.toLowerCase();
    if (PCCM_LOOKUP_CACHE){
        return PCCM_LOOKUP_CACHE.teacherNames.get(low) || "";
    }
    const found = (DATA.giaovien || []).find(g => _normText(g?.magv).toLowerCase() === low);
    if (!found) return "";
    return `${_normText(found.hodem)} ${_normText(found.ten)}`.trim();
}
function pccmTeacherHint(code){
    const value = _normText(code);
    const name = pccmTeacherName(value);
    if (value && name && value !== name) return `${value} - ${name}`;
    return name || value;
}
function pccmRenderTeacherOption(code, selected){
    const value = _normText(code);
    const title = pccmTeacherHint(value) || value;
    return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""} title="${escapeHtml(title)}" data-title="${escapeHtml(title)}">${escapeHtml(value)}</option>`;
}
function pccmTeacherListFromValue(raw){
    let parts = [];
    if (Array.isArray(raw)){
        parts = raw;
    } else {
        const text = (raw ?? "").toString()
            .replace(/\r?\n/g, ",")
            .replace(/[;；]+/g, ",")
            .replace(/\s*[+＋]\s*/g, ",");
        parts = text.split(",");
    }
    const out = [];
    const seen = new Set();
    parts.forEach(item=>{
        const code = resolveTeacherCode(_normText(item));
        if (!code) return;
        const key = code.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(code);
    });
    return out;
}
function pccmNormalizeTeacherValue(raw){
    return pccmTeacherListFromValue(raw).join(", ");
}
function pccmTeacherLabel(raw){
    const list = pccmTeacherListFromValue(raw);
    if (!list.length) return "";
    const base = list.join(", ");
    return list.length > 1 ? `${base} (dạy ghép)` : base;
}
function pccmTeacherHas(raw, code){
    const target = resolveTeacherCode(_normText(code)).toLowerCase();
    if (!target) return false;
    return pccmTeacherListFromValue(raw).some(x => x.toLowerCase() === target);
}
function pccmRenderTeacherMultiItem(controlId, code, label, selected){
    const value = _normText(code);
    const title = pccmTeacherHint(value) || value;
    return `
        <button type="button"
                class="pccm-multi-item pccm-teacher-item ${selected ? "selected" : ""}"
                data-pccm-teacher-value="${escapeHtml(value)}"
                data-pccm-teacher-label="${escapeHtml(label || value)}"
                title="${escapeHtml(title)}"
                onclick="pccmTeacherMultiItemClick(event,'${controlId}', this.getAttribute('data-pccm-teacher-value'))">
            ${escapeHtml(label || value)}
        </button>`;
}
function pccmRenderTeacherMulti(controlId, selectedRaw, teacherItems){
    const selected = pccmTeacherListFromValue(selectedRaw);
    const label = pccmTeacherLabel(selected);
    const hiddenValue = pccmNormalizeTeacherValue(selected);
    // Teacher lists can contain 100+ entries and are repeated for every row
    // in the class/subject views. Render only the clear action initially; the
    // full menu is hydrated on first open. Selected legacy codes are added by
    // the hydrator, so no value is lost when the data dictionary is incomplete.
    return `
        <div id="${controlId}_box" class="pccm-multi-select pccm-teacher-multi">
            <input id="${controlId}" type="hidden" value="${escapeHtml(hiddenValue)}">
            <button type="button" class="pccm-multi-button" onclick="pccmTeacherMultiToggle(event,'${controlId}')" title="${escapeHtml(label)}">
                <span id="${controlId}_text">${escapeHtml(label || "(Chưa phân)")}</span>
                <span class="pccm-multi-arrow">▾</span>
            </button>
            <div class="pccm-multi-menu" data-pccm-menu-lazy="1">
                <button type="button" class="pccm-multi-item pccm-teacher-clear" onclick="pccmTeacherMultiClear(event,'${controlId}')">(Chưa phân)</button>
            </div>
        </div>`;
}

function pccmEnsureTeacherMultiMenu(box){
    try{
        if (!box) return null;
        const menu = pccmTeacherMultiMenuForBox(box);
        if (!menu) return null;
        if (menu.getAttribute("data-pccm-menu-hydrated") === "1") return menu;

        const controlId = (box.id || "").replace(/_box$/, "");
        const selected = pccmTeacherListFromValue(document.getElementById(controlId)?.value || "");
        const selectedSet = new Set(selected.map(x=>x.toLowerCase()));
        const items = (DATA.giaovien || [])
            .map(g=>_normText(g?.magv))
            .filter(Boolean)
            .map(code=>({code, label:code}));
        const itemSet = new Set(items.map(x=>x.code.toLowerCase()));
        const missing = selected
            .filter(code=>!itemSet.has(code.toLowerCase()))
            .map(code=>({code, label:`(Đang lưu) ${code}`}));
        const allItems = missing.concat(items);
        menu.innerHTML = `
            <button type="button" class="pccm-multi-item pccm-teacher-clear" onclick="pccmTeacherMultiClear(event,'${controlId}')">(Chưa phân)</button>
            ${allItems.map(item=>pccmRenderTeacherMultiItem(controlId, item.code, item.label, selectedSet.has(item.code.toLowerCase()))).join("")}`;
        menu.setAttribute("data-pccm-menu-hydrated", "1");
        return menu;
    }catch(_){
        return null;
    }
}

function pccmTeacherMultiToggle(ev, controlId){
    try{
        if (ev) ev.stopPropagation();
        const box = document.getElementById(`${controlId}_box`);
        if (!box) return;
        const willOpen = !box.classList.contains("open");
        pccmQuickMultiCloseAll();
        if (willOpen){
            pccmEnsureTeacherMultiMenu(box);
            box.classList.add("open");
            pccmPositionTeacherMultiMenu(box);
        }
    }catch(e){}
}
function pccmResetTeacherMultiMenu(menu){
    if (!menu) return;
    const ownerId = menu.getAttribute("data-pccm-menu-owner") || "";
    const owner = ownerId ? document.getElementById(ownerId) : null;
    menu.classList.remove("pccm-mobile-floating-menu");
    menu.removeAttribute("data-pccm-menu-owner");
    ["top", "right", "bottom", "left", "width", "max-height"].forEach(prop=>menu.style.removeProperty(prop));
    if (owner && menu.parentElement !== owner) owner.appendChild(menu);
    else if (!owner && menu.parentElement === document.body) menu.remove();
}
function pccmTeacherMultiMenuForBox(box){
    if (!box) return null;
    const anchored = box.querySelector(".pccm-multi-menu");
    if (anchored) return anchored;
    const ownerId = box.id || "";
    if (!ownerId) return null;
    return Array.from(document.querySelectorAll(".pccm-mobile-floating-menu[data-pccm-menu-owner]"))
        .find(menu=>menu.getAttribute("data-pccm-menu-owner") === ownerId) || null;
}
function pccmPositionTeacherMultiMenu(box){
    try{
        const menu = pccmTeacherMultiMenuForBox(box);
        const button = box?.querySelector(".pccm-multi-button");
        pccmResetTeacherMultiMenu(menu);
        if (!menu || !button || !window.matchMedia("(max-width: 760px)").matches) return;

        const rect = button.getBoundingClientRect();
        const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
        const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
        const edge = 8;
        const gap = 4;
        const menuWidth = Math.min(Math.max(rect.width, 220), Math.max(0, viewportWidth - edge * 2));
        const menuLeft = Math.min(Math.max(edge, rect.left), Math.max(edge, viewportWidth - edge - menuWidth));
        const roomBelow = Math.max(0, viewportHeight - rect.bottom - gap - edge);
        const roomAbove = Math.max(0, rect.top - gap - edge);
        const openAbove = roomBelow < 160 && roomAbove > roomBelow;
        const availableHeight = openAbove ? roomAbove : roomBelow;

        menu.setAttribute("data-pccm-menu-owner", box.id);
        menu.classList.add("pccm-mobile-floating-menu");
        document.body.appendChild(menu);
        menu.style.left = `${menuLeft}px`;
        menu.style.width = `${menuWidth}px`;
        menu.style.maxHeight = `${Math.max(96, Math.min(240, availableHeight))}px`;
        if (openAbove){
            menu.style.bottom = `${Math.max(edge, viewportHeight - rect.top + gap)}px`;
        } else {
            menu.style.top = `${Math.min(viewportHeight - edge, rect.bottom + gap)}px`;
        }
    }catch(e){
        // Keep the normal anchored menu when floating placement is unavailable.
    }
}
function pccmTeacherMultiApply(controlId, values){
    const list = pccmTeacherListFromValue(values);
    const value = pccmNormalizeTeacherValue(list);
    const label = pccmTeacherLabel(list);
    const hidden = document.getElementById(controlId);
    const text = document.getElementById(`${controlId}_text`);
    const box = document.getElementById(`${controlId}_box`);
    if (hidden) hidden.value = value;
    if (text) text.textContent = label || "(Chưa phân)";
    const btn = box ? box.querySelector(".pccm-multi-button") : null;
    if (btn) btn.title = label;
    const selectedSet = new Set(list.map(x=>x.toLowerCase()));
    const menu = pccmTeacherMultiMenuForBox(box);
    if (menu){
        menu.querySelectorAll(".pccm-teacher-item").forEach(item=>{
            const v = _normText(item.getAttribute("data-pccm-teacher-value")).toLowerCase();
            item.classList.toggle("selected", selectedSet.has(v));
        });
    }
    pccmAutoSaveActive();
}
function pccmTeacherMultiItemClick(ev, controlId, value){
    try{
        if (ev) ev.stopPropagation();
        const hidden = document.getElementById(controlId);
        const cur = new Set(pccmTeacherListFromValue(hidden?.value || "").map(x=>x.toLowerCase()));
        const byLower = new Map(pccmTeacherListFromValue(hidden?.value || "").map(x=>[x.toLowerCase(), x]));
        const code = resolveTeacherCode(_normText(value));
        if (!code) return;
        const key = code.toLowerCase();
        if (cur.has(key)){
            cur.delete(key);
            byLower.delete(key);
        } else {
            cur.add(key);
            byLower.set(key, code);
        }
        pccmTeacherMultiApply(controlId, Array.from(cur).map(k=>byLower.get(k) || k));
    }catch(e){}
}
function pccmTeacherMultiClear(ev, controlId){
    try{
        if (ev) ev.stopPropagation();
        pccmTeacherMultiApply(controlId, []);
    }catch(e){}
}
function pccmUpdateOptionTitle(selectEl){
    try{
        if (!selectEl) return;
        const opt = (selectEl.options && selectEl.selectedIndex >= 0) ? selectEl.options[selectEl.selectedIndex] : null;
        const title = opt ? (opt.getAttribute("data-title") || opt.getAttribute("title") || opt.textContent || "") : "";
        selectEl.title = title;
    }catch(e){
        // ignore
    }
}
function comparePCCMMonByHiddenCode(a,b){
    const code = pccmMonHiddenSortCode(a).localeCompare(pccmMonHiddenSortCode(b),'vi',{sensitivity:'base'});
    if(code) return code;
    return _normText(a?.ten || a?.key).localeCompare(_normText(b?.ten || b?.key),'vi');
}




function escapeHtml(s){
    s = (s===undefined || s===null) ? "" : String(s);
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
            .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

/* ===== PCCM helpers: danh mục môn (môn tổng hợp) + lookup tiết chuẩn ===== */
function buildPCCMMonList(){
    // HIỂN THỊ: TÊN MÔN (Âm nhạc, Chào cờ...)
    // LƯU/TRA PCCM: ưu tiên MÃ (SHDC, SHL...) để khớp dữ liệu PCCM đang lưu theo mã
    function looksLikeCode(s){
        s = _normText(s);
        if (!s) return false;
        const hasNonASCII = /[^\x00-\x7F]/.test(s);
        const hasSpace = /\s/.test(s);
        if (hasNonASCII || hasSpace) return false;
        return s.length <= 12;
    }

    const out = [];
    const seen = new Set();

    (DATA.monhoc || []).forEach(r=>{
        const ten = _normText(r.ten);
        const ma  = _normText(r.ma);
        const ma2 = _normText(r.ma2);

        const fields = [ten, ma, ma2].filter(Boolean);
        if (!fields.length) return;

        const displayName = _normText(fields.find(x=>!looksLikeCode(x)) || ten || ma || ma2);
        if (!displayName) return;

        const code = _normText(fields.find(x=>looksLikeCode(x)) || ma || ma2 || "");
        const storageKey = code || displayName;

        const normSeen = displayName.toLowerCase();
        if (seen.has(normSeen)) return;
        seen.add(normSeen);

        out.push({
            key: storageKey,      // key dùng để đọc/ghi PCCM (mã nếu có)
            ten: displayName,     // hiển thị
            code: code || "",     // hiển thị mã trên header
            ma: ma,
            ma2: ma2
        });
    });

    return out;
}

function pccmGetTeacher(lopCanon, monObj){
    if (!lopCanon || !monObj) return "";

    const clsRaw = _normText(lopCanon);
    const classCandidates = classLookupCandidates(clsRaw);

    const monCandidates = [];
    if (monObj.key) monCandidates.push(monObj.key);
    if (monObj.ten && monObj.ten !== monObj.key) monCandidates.push(monObj.ten);
    if (monObj.ma2) monCandidates.push(monObj.ma2);
    if (monObj.ma && monObj.ma !== monObj.key) monCandidates.push(monObj.ma);

    const matrix = DATA.pccmMatrix || {};
    for (const cls of classCandidates){
        for (const mk of monCandidates){
            const v = matrix[`${cls}|${mk}`];
            if (v) return pccmNormalizeTeacherValue(v);
        }
    }
    return "";
}

function pccmTeacherPrimaryKey(lopCanon, monObj){
    const monKey = (monObj?.key || monObj?.ten || "").toString().trim();
    if (!lopCanon || !monKey) return "";
    return `${lopCanon}|${monKey}`;
}

function pccmTeacherLegacyKeys(lopCanon, monObj){
    const primaryKey = pccmTeacherPrimaryKey(lopCanon, monObj);
    const legacyKeys = [];
    if (monObj?.ten && monObj?.key && monObj.ten !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ten}`);
    if (monObj?.ma2 && monObj?.key && monObj.ma2 !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ma2}`);
    if (monObj?.ma && monObj?.key && monObj.ma !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ma}`);
    return legacyKeys.filter(k=>k && k !== primaryKey);
}

function pccmSetTeachersNoSave(lopCanon, monObj, rawTeachers){
    if (!lopCanon || !monObj) return;
    if (typeof DATA.pccmMatrix !== "object" || !DATA.pccmMatrix) DATA.pccmMatrix = {};
    const primaryKey = pccmTeacherPrimaryKey(lopCanon, monObj);
    const value = pccmNormalizeTeacherValue(rawTeachers);
    if (!primaryKey) return;
    if (value){
        DATA.pccmMatrix[primaryKey] = value;
        // A teacher assignment starts an authored PCCM row.  Materialize the
        // current standard immediately when the row has no explicit periods
        // or limit yet, so a later edit to Tiết chuẩn cannot change it during
        // the same session (before the next integrity-sync/app reload).
        try{ pccmInitializeAssignedPccmNumbersNoSave(lopCanon, monObj); }catch(_){ /* keep teacher edit usable */ }
    }else delete DATA.pccmMatrix[primaryKey];
    pccmTeacherLegacyKeys(lopCanon, monObj).forEach(k=>{
        if (DATA.pccmMatrix && DATA.pccmMatrix[k]) delete DATA.pccmMatrix[k];
    });
}

function pccmGetTeachers(lopCanon, monObj){
    return pccmTeacherListFromValue(pccmGetTeacher(lopCanon, monObj));
}

function pccmSetTeacherMembershipNoSave(lopCanon, monObj, teacherCode, shouldAssign){
    const teacher = resolveTeacherCode(_normText(teacherCode));
    if (!teacher) return;
    const list = pccmGetTeachers(lopCanon, monObj);
    const low = teacher.toLowerCase();
    const next = list.filter(x=>x.toLowerCase() !== low);
    if (shouldAssign) next.push(teacher);
    pccmSetTeachersNoSave(lopCanon, monObj, next);
}

function pccmGetNumberFromMatrix(matrix, lopCanon, monObj){
    if (!matrix || !lopCanon || !monObj) return null;

    const clsRaw = _normText(lopCanon);
    const classCandidates = classLookupCandidates(clsRaw);

    const monCandidates = [];
    if (monObj.key) monCandidates.push(monObj.key);
    if (monObj.ten && monObj.ten !== monObj.key) monCandidates.push(monObj.ten);
    if (monObj.ma2) monCandidates.push(monObj.ma2);
    if (monObj.ma && monObj.ma !== monObj.key) monCandidates.push(monObj.ma);

    for (const cls of classCandidates){
        for (const mk of monCandidates){
            const raw = matrix[`${cls}|${mk}`];
            if (raw === undefined || raw === null) continue;
            const s = String(raw).trim();
            if (s === "") continue;
            const n = Number(s);
            if (!Number.isNaN(n)) return n;
        }
    }
    return null;
}

function pccmGetTiet(lopCanon, monObj){
    return pccmGetNumberFromMatrix(DATA.pccmTietMatrix || {}, lopCanon, monObj);
}
function pccmGetGioihan(lopCanon, monObj){
    return pccmGetNumberFromMatrix(DATA.pccmGioihanMatrix || {}, lopCanon, monObj);
}

// Snapshot the grade standard at the moment a class/subject first receives a
// teacher.  The migration in syncDerivedDataIntegrity covers legacy rows; this
// hook covers live edits and direct/quick assignment paths immediately.
function pccmInitializeAssignedPccmNumbersNoSave(lopCanon, monObj, khoiNameOverride){
    if (!lopCanon || !monObj) return false;
    if (!DATA.pccmTietMatrix || typeof DATA.pccmTietMatrix !== "object") DATA.pccmTietMatrix = {};
    if (!DATA.pccmGioihanMatrix || typeof DATA.pccmGioihanMatrix !== "object") DATA.pccmGioihanMatrix = {};

    const khoiName = _normText(khoiNameOverride || pccmGetKhoiNameForClass(lopCanon));
    const tc = lookupTietChuan(khoiName, monObj);
    if (!tc) return false;
    const key = pccmTeacherPrimaryKey(lopCanon, monObj);
    if (!key) return false;
    let changed = false;

    if (pccmGetNumberFromMatrix(DATA.pccmTietMatrix, lopCanon, monObj) == null){
        const periods = _normText(tc.sotiet);
        if (_toPositiveNumberOrZero(periods) > 0){
            DATA.pccmTietMatrix[key] = periods;
            changed = true;
        }
    }
    if (pccmGetNumberFromMatrix(DATA.pccmGioihanMatrix, lopCanon, monObj) == null){
        const limit = _normText(tc.gioihan || "1");
        if (_toPositiveNumberOrZero(limit) > 0){
            DATA.pccmGioihanMatrix[key] = limit;
            changed = true;
        }
    }
    return changed;
}
function pccmGetTietDisplay(lopCanon, monObj, khoiName){
    const ov = pccmGetTiet(lopCanon, monObj);
    if (ov !== null && ov !== undefined) return ov;
    const tc = lookupTietChuan(khoiName, monObj);
    return tc ? (tc.sotiet || "") : "";
}
function pccmGetGioihanDisplay(lopCanon, monObj, khoiName){
    const ov = pccmGetGioihan(lopCanon, monObj);
    if (ov !== null && ov !== undefined) return ov;
    const tc = lookupTietChuan(khoiName, monObj);
    return tc ? (tc.gioihan || "") : "";
}

function pccmClassKhoiMeta(classDisplayName){
    if (!classDisplayName) return null;
    const aliases = classLookupCandidates(classDisplayName).map(x=>x.toLowerCase());

    const lopObj = (DATA.lop || []).find(l=>{
        const own = classLookupCandidates(classCanonFromLop(l))
            .concat(classLookupCandidates(l?.ten2 || ""))
            .concat(classLookupCandidates(l?.id || ""))
            .map(x=>x.toLowerCase());
        return aliases.some(a => own.includes(a));
    });
    if (!lopObj) return null;

    const canon = classCanonFromLop(lopObj);
    const rawKhoi = _normText(lopObj?.khoi) || _normText(lopObj?.ten2) || _normText(lopObj?.ten);
    const khoiNum = extractKhoiNumber(rawKhoi);
    const khoiName = khoiNum ? `Khối ${khoiNum}` : (_normText(lopObj?.khoi) || rawKhoi);
    return { canon, khoiName };
}

function pccmAssignedPeriodForClassSubject(classCanon, khoiName, monObj){
    const raw = pccmGetTietDisplay(classCanon, monObj, khoiName);
    const n = Number(String(raw ?? "").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Tổng số tiết của 1 lớp: chỉ cộng các môn đã phân công giáo viên.
function pccmComputeTotalTietForClass(classDisplayName, monList){
    const meta = pccmClassKhoiMeta(classDisplayName);
    if (!meta) return null;
    let total = 0;
    let assigned = 0;

    (monList || []).forEach(m=>{
        const tiet = pccmAssignedPeriodForClassSubject(meta.canon, meta.khoiName, m);
        if (!tiet) return;
        total += tiet;
        if (pccmGetTeachers(meta.canon, m).length) assigned += tiet;
    });

    return { total, assigned, khoiName: meta.khoiName, canon: meta.canon };
}

function pccmComputeTotalTietForTeacher(teacherCode, classNames, monList){
    const teacher = _normText(teacherCode);
    if (!teacher) return null;
    let assigned = 0;
    (classNames || []).forEach(cls=>{
        const meta = pccmClassKhoiMeta(cls);
        if (!meta) return;
        (monList || []).forEach(m=>{
            if (!pccmTeacherHas(pccmGetTeacher(meta.canon, m), teacher)) return;
            assigned += pccmAssignedPeriodForClassSubject(meta.canon, meta.khoiName, m);
        });
    });
    return { assigned, title: `Tổng số tiết đã phân công cho ${teacher}` };
}

function pccmSubjectHasAssignedTeacher(monObj, classNames){
    if (!monObj) return false;
    return (classNames || []).some(cls=>pccmGetTeachers(cls, monObj).length > 0);
}

function pccmComputeTotalTietForSubject(monKey, classNames, monList){
    const key = _normText(monKey || ((monList || [])[0]?.key || (monList || [])[0]?.ten));
    if (!key) return null;
    const monObj = (monList || []).find(m=>_normText(m.key || m.ten) === key)
        || (monList || []).find(m=>_normText(m.ten) === key || _normText(m.ma) === key || _normText(m.ma2) === key)
        || {key, ten:key};
    let assigned = 0;
    (classNames || []).forEach(cls=>{
        const meta = pccmClassKhoiMeta(cls);
        if (!meta) return;
        if (!pccmGetTeachers(meta.canon, monObj).length) return;
        assigned += pccmAssignedPeriodForClassSubject(meta.canon, meta.khoiName, monObj);
    });
    return { assigned, title: `Tổng số tiết đã phân công cho ${pccmSubjectHint(monObj) || key}` };
}

function pccmComputeTotalTietForCurrentTab(classNames, monList){
    if (PCCM_TAB === "giaovien") return pccmComputeTotalTietForTeacher(PCCM_SELECTED_GV, classNames, monList);
    if (PCCM_TAB === "monhoc") return pccmComputeTotalTietForSubject(PCCM_SUBJ, classNames, monList);
    const totals = pccmComputeTotalTietForClass(PCCM_SELECTED_CLASS, monList);
    return totals ? {
        assigned: totals.assigned,
        title: `Tổng số tiết đã phân công cho lớp ${totals.canon}`
    } : null;
}

function pccmSetTeacher(lopCanon, monObj, val){
    if (!lopCanon || !monObj) return;
    // lưu theo key chính
    pccmSetTeachersNoSave(lopCanon, monObj, val);
    saveStore();
}

// ===== PCCM ROOM (Phòng học) =====
function pccmGetRoom(lopCanon, monObj){
    if (!lopCanon || !monObj) return "";
    const clsRaw = _normText(lopCanon);
    const classCandidates = classLookupCandidates(clsRaw);

    const monCandidates = [];
    if (monObj.key) monCandidates.push(monObj.key);
    if (monObj.ten && monObj.ten !== monObj.key) monCandidates.push(monObj.ten);
    if (monObj.ma2) monCandidates.push(monObj.ma2);
    if (monObj.ma && monObj.ma !== monObj.key) monCandidates.push(monObj.ma);

    for (const clsKey of classCandidates){
        for (const mk of monCandidates){
            const k = `${clsKey}|${mk}`;
            const v = (DATA.pccmRoomMatrix || {})[k];
            if (v) return v;
        }
    }
    return "";
}

function pccmSetRoom(lopCanon, monObj, val){
    if (!lopCanon || !monObj) return;
    setPCCMRoom(lopCanon, monObj.key || monObj.ten, val);

    // dọn key legacy để tránh lưu trùng (tương tự GV)
    const legacyKeys = [];
    if (monObj.ten && monObj.key && monObj.ten !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ten}`);
    if (monObj.ma2 && monObj.key && monObj.ma2 !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ma2}`);
    if (monObj.ma && monObj.key && monObj.ma !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ma}`);
    legacyKeys.forEach(k=>{
        if (k === `${lopCanon}|${(monObj.key||"")}`) return;
        if (DATA.pccmRoomMatrix && DATA.pccmRoomMatrix[k]) delete DATA.pccmRoomMatrix[k];
    });
}

// ===== PCCM TIẾT / GIỚI HẠN theo Lớp|Môn (để màn "Sắp xếp TKB" lấy đúng tổng số tiết từ bảng phân công) =====
function pccmSetTietGioihanNoSave(lopCanon, monObj, sotietVal, gioihanVal){
    if (!lopCanon || !monObj) return;
    if (typeof DATA.pccmTietMatrix !== "object" || !DATA.pccmTietMatrix) DATA.pccmTietMatrix = {};
    if (typeof DATA.pccmGioihanMatrix !== "object" || !DATA.pccmGioihanMatrix) DATA.pccmGioihanMatrix = {};

    const monKey = (monObj.key || monObj.ten || "").toString().trim();
    if (!monKey) return;
    const primaryKey = `${lopCanon}|${monKey}`;

    const s1 = (sotietVal ?? "").toString().trim();
    const s2 = (gioihanVal ?? "").toString().trim();
    if (s1) DATA.pccmTietMatrix[primaryKey] = s1;
    else delete DATA.pccmTietMatrix[primaryKey];
    if (s2) DATA.pccmGioihanMatrix[primaryKey] = s2;
    else delete DATA.pccmGioihanMatrix[primaryKey];

    // dọn key legacy (tương tự GV/Phòng) để tránh lưu trùng theo tên/mã khác nhau
    const legacyKeys = [];
    if (monObj.ten && monObj.key && monObj.ten !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ten}`);
    if (monObj.ma2 && monObj.key && monObj.ma2 !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ma2}`);
    if (monObj.ma && monObj.key && monObj.ma !== monObj.key) legacyKeys.push(`${lopCanon}|${monObj.ma}`);
    legacyKeys.forEach(k=>{
        if (k === primaryKey) return;
        if (DATA.pccmTietMatrix && (k in DATA.pccmTietMatrix)) delete DATA.pccmTietMatrix[k];
        if (DATA.pccmGioihanMatrix && (k in DATA.pccmGioihanMatrix)) delete DATA.pccmGioihanMatrix[k];
    });
}

// Set nhanh theo monKey (dùng trong tab Môn học)
function pccmSetTeacherByMonKey(lopCanon, monKey, val){
    const mons = buildPCCMMonList();
    const monObj = mons.find(m => _normText(m.key) === _normText(monKey)) || {key: monKey, ten: monKey};
    pccmSetTeacher(lopCanon, monObj, val);
    saveStore();
}
function pccmSetRoomByMonKey(lopCanon, monKey, val){
    const mons = buildPCCMMonList();
    const monObj = mons.find(m => _normText(m.key) === _normText(monKey)) || {key: monKey, ten: monKey};
    pccmSetRoom(lopCanon, monObj, val);
    saveStore();
}

function lookupTietChuan(khoiName, monObj){
    const kNum = extractKhoiNumber(_normText(khoiName));
    if (!kNum || !monObj) return null;
    const m1 = (monObj.ten||"").toLowerCase();
    const m2 = (monObj.key||"").toLowerCase();
    const m3 = (monObj.ma2||"").toLowerCase();

    if (PCCM_LOOKUP_CACHE){
        const standards = PCCM_LOOKUP_CACHE.standards;
        return standards.get(`${kNum}|${m1}`)
            || standards.get(`${kNum}|${m2}`)
            || (m3 ? standards.get(`${kNum}|${m3}`) : null)
            || null;
    }

    return (DATA.mon || []).find(r=>{
        const rk = extractKhoiNumber(_normText(r.khoi));
        if (rk !== kNum) return false;
        const rt = _normText(r.ten).toLowerCase();
        return (rt && (rt === m1 || rt === m2 || (m3 && rt === m3)));
    }) || null;
}

// ===== Helpers: kiểm tra "môn có tiết" =====
function _toPositiveNumberOrZero(x){
    const s = (x ?? "").toString().trim();
    if (s === "") return 0;
    const n = Number(s);
    if (!Number.isFinite(n)) return 0;
    return n;
}

function monHasPositiveTietChuanForKhoi(khoiName, monObj){
    const tc = lookupTietChuan(khoiName, monObj);
    if (!tc) return false;
    return _toPositiveNumberOrZero(tc.sotiet) > 0;
}

function monHasPositiveTietChuanAnyKhoi(monObj){
    const khoiNames = Array.from(new Set((DATA.mon || []).map(r=>_normText(r.khoi)).filter(Boolean)));
    for (const k of khoiNames){
        if (monHasPositiveTietChuanForKhoi(k, monObj)) return true;
    }
    return false;
}

function pccmSetTeacherFromInput(inp, lopCanon){
    const monObj = {
        key: inp.dataset.monkey || "",
        ten: inp.dataset.monten || "",
        ma: inp.dataset.monma || "",
        ma2: inp.dataset.monma2 || ""
    };
    pccmSetTeacher(lopCanon, monObj, inp.value);
    saveStore();
}

function buildTeacherDatalistHTML(){
    const items = (DATA.giaovien || [])
        .map(g=>{
            const code = _normText(g.magv);
            const name = `${(g.hodem||"").trim()} ${(g.ten||"").trim()}`.trim();
            return {code, name};
        })
        .filter(x=>x.code);

    const opts = items.map(x=>{
        // Chỉ hiển thị mã GV (tên tắt) theo yêu cầu
        const label = x.code;
        return `<option value="${escapeHtml(x.code)}" label="${escapeHtml(label)}"></option>`;
    }).join("");

    return `<datalist id="pccmTeacherCodes">${opts}</datalist>`;
}

function resolveTeacherCode(input){
    const raw = (input||"").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();

    if (PCCM_LOOKUP_CACHE){
        return PCCM_LOOKUP_CACHE.teacherByCode.get(lower)
            || PCCM_LOOKUP_CACHE.teacherByName.get(lower)
            || raw;
    }

    // Ưu tiên match theo mã GV
    const byCode = (DATA.giaovien || []).find(g => _normText(g.magv).toLowerCase() === lower);
    if (byCode && byCode.magv) return _normText(byCode.magv);

    // Fallback: match theo tên đầy đủ
    const byName = (DATA.giaovien || []).find(g=>{
        const full = `${(g.hodem||"").trim()} ${(g.ten||"").trim()}`.trim().toLowerCase();
        return full && full === lower;
    });
    if (byName && byName.magv) return _normText(byName.magv);

    // Nếu không khớp, giữ nguyên (cho phép nhập tự do)
    return raw;
}

function pccmQuickValidatePositiveNumber(v){
    const s = (v ?? "").toString().trim();
    if (s === "") return { ok:true, val:"" };
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return { ok:false };
    return { ok:true, val: Number.isInteger(n) ? String(n) : String(n) };
}

function pccmFindMonByQuickKey(monKey, allMons){
    const k = _normText(monKey);
    return (allMons || []).find(m=>_normText(m.key || m.ten) === k)
        || (allMons || []).find(m=>_normText(m.ten) === k || _normText(m.ma) === k || _normText(m.ma2) === k)
        || (k ? {key:k, ten:k, code:"", ma:"", ma2:""} : null);
}

function pccmSetTeacherQuickNoSave(lopCanon, monObj, val){
    pccmSetTeachersNoSave(lopCanon, monObj, val);
}

function pccmQuickUpdateTietChuanForClass(cls, monObj, sotietVal, gioihanVal){
    // PCCM is class-specific; do not write these values back to DATA.mon,
    // because DATA.mon is the standard period table for the whole grade.
    // Empty quick-edit fields mean "keep the current/default assignment";
    // they must never erase an already-authored PCCM snapshot.
    const periods = _normText(sotietVal) || pccmGetTiet(cls, monObj);
    const limit = _normText(gioihanVal) || pccmGetGioihan(cls, monObj);
    pccmSetTietGioihanNoSave(cls, monObj, periods == null ? "" : periods, limit == null ? "" : limit);
}

function pccmQuickPickTeacher(teachers, classIndex, subjectIndex){
    if (!teachers.length) return "";
    return pccmNormalizeTeacherValue(teachers);
}

// Sửa nhanh PCCM theo đúng tab đang đứng.
function pccmQuickEditApply(){
    const sotietInput = (document.getElementById("pccmQuickSoTiet")?.value || "").toString().trim();
    const gioihanInput = (document.getElementById("pccmQuickGioiHan")?.value || "").toString().trim();

    const v1 = pccmQuickValidatePositiveNumber(sotietInput);
    const v2 = pccmQuickValidatePositiveNumber(gioihanInput);
    if (!v1.ok || !v2.ok){
        alert("⚠ Số tiết/Giới hạn không hợp lệ. Chỉ được để trống hoặc nhập số > 0.");
        return;
    }

    const allMons = buildPCCMMonList().filter(m => monHasPositiveTietChuanAnyKhoi(m));
    let classes = [];
    let subjects = [];
    let teachers = [];

    if (PCCM_TAB === "giaovien"){
        classes = pccmQuickMultiValues(document.getElementById("pccmQuickClass")?.value || "");
        subjects = pccmQuickMultiValues(document.getElementById("pccmQuickMon")?.value || "")
            .map(k=>pccmFindMonByQuickKey(k, allMons))
            .filter(Boolean);
        teachers = [_normText(PCCM_SELECTED_GV)].filter(Boolean);
    }else if (PCCM_TAB === "monhoc"){
        classes = pccmQuickMultiValues(document.getElementById("pccmQuickClass")?.value || "");
        const monObj = pccmFindMonByQuickKey(PCCM_SUBJ, allMons);
        subjects = monObj ? [monObj] : [];
        teachers = pccmQuickMultiValues(document.getElementById("pccmQuickGv")?.value || "")
            .map(resolveTeacherCode)
            .filter(Boolean);
    }else{
        classes = [_normText(PCCM_SELECTED_CLASS)].filter(Boolean);
        subjects = pccmQuickMultiValues(document.getElementById("pccmQuickMon")?.value || "")
            .map(k=>pccmFindMonByQuickKey(k, allMons))
            .filter(Boolean);
        teachers = pccmQuickMultiValues(document.getElementById("pccmQuickGv")?.value || "")
            .map(resolveTeacherCode)
            .filter(Boolean);
    }

    if (!classes.length || !subjects.length){
        alert("Chọn đủ Lớp học và Môn học trước.");
        return;
    }
    if (!teachers.length){
        alert("Chọn Giáo viên trước.");
        return;
    }

    let applied = 0;
    classes.forEach((cls, classIndex)=>{
        const khoiName = pccmGetKhoiNameForClass(cls);
        subjects.forEach((monObj, subjectIndex)=>{
            if (!monHasPositiveTietChuanForKhoi(khoiName, monObj)) return;
            const teacher = pccmQuickPickTeacher(teachers, classIndex, subjectIndex);
            if (PCCM_TAB === "giaovien"){
                pccmSetTeacherMembershipNoSave(cls, monObj, teacher, true);
            }else{
                pccmSetTeacherQuickNoSave(cls, monObj, teacher);
            }
            pccmQuickUpdateTietChuanForClass(cls, monObj, v1.val, v2.val);
            applied += 1;
        });
    });

    if (!applied){
        alert("Không có phân công phù hợp với tiết chuẩn của lớp/môn đã chọn.");
        return;
    }

    saveStore();

    // clear 2 ô nhập để tránh áp dụng nhầm lần sau
    try{
        const a = document.getElementById("pccmQuickSoTiet");
        const b = document.getElementById("pccmQuickGioiHan");
        if (a) a.value = "";
        if (b) b.value = "";
    }catch(e){}

    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function") pccmRenderCurrent(sc);
}

// ===== PCCM: lọc danh sách môn theo lớp (dựa theo tiết chuẩn: số tiết > 0) =====
function pccmGetKhoiNameForClass(cls){
    const aliases = classLookupCandidates(cls).map(x=>x.toLowerCase());
    const found = (DATA.lop || []).find(l => {
        const own = classLookupCandidates(classCanonFromLop(l))
            .concat(classLookupCandidates(l?.ten2 || ""))
            .concat(classLookupCandidates(l?.id || ""))
            .map(x=>x.toLowerCase());
        return aliases.some(a => own.includes(a));
    });
    const khoi = _normText(found?.khoi);
    return khoi || ("Khối " + extractKhoiNumber(_normText(cls)));
}

function pccmGetAllowedMonsForClass(cls, monList){
    const khoiName = pccmGetKhoiNameForClass(cls);
    const out = (monList || []).filter(m => monHasPositiveTietChuanForKhoi(khoiName, m));
    return out;
}

function pccmQuickMultiValues(raw){
    return String(raw || "")
        .split(",")
        .map(x=>_normText(x))
        .filter(Boolean);
}

function pccmQuickClassValues(raw){
    return pccmQuickMultiValues(raw);
}

function pccmQuickPrimaryClass(raw){
    return pccmQuickMultiValues(raw)[0] || "";
}

function pccmQuickGetSelected(type){
    if (type === "subject") return PCCM_QUICK_SELECTED_SUBJECTS || [];
    if (type === "teacher") return PCCM_QUICK_SELECTED_TEACHERS || [];
    return PCCM_QUICK_SELECTED_CLASSES || [];
}

function pccmQuickSetSelected(type, values){
    const clean = Array.from(new Set((values || []).map(v=>_normText(v)).filter(Boolean)));
    if (type === "subject") PCCM_QUICK_SELECTED_SUBJECTS = clean;
    else if (type === "teacher") PCCM_QUICK_SELECTED_TEACHERS = clean;
    else PCCM_QUICK_SELECTED_CLASSES = clean;
    return clean;
}

function pccmQuickGetAnchor(type){
    if (type === "subject") return PCCM_QUICK_SUBJECT_ANCHOR || "";
    if (type === "teacher") return PCCM_QUICK_TEACHER_ANCHOR || "";
    return PCCM_QUICK_CLASS_ANCHOR || "";
}

function pccmQuickSetAnchor(type, value){
    value = _normText(value);
    if (type === "subject") PCCM_QUICK_SUBJECT_ANCHOR = value;
    else if (type === "teacher") PCCM_QUICK_TEACHER_ANCHOR = value;
    else PCCM_QUICK_CLASS_ANCHOR = value;
}

function pccmQuickSelectedValues(type, allValues, fallbackValues){
    const valid = new Set((allValues || []).map(v=>_normText(v)).filter(Boolean));
    const fallbacks = Array.isArray(fallbackValues) ? fallbackValues : [fallbackValues];
    let selected = pccmQuickGetSelected(type).filter(v=>valid.has(v));
    if (!selected.length){
        selected = fallbacks.map(v=>_normText(v)).filter(v=>v && valid.has(v));
    }
    return pccmQuickSetSelected(type, selected);
}

function pccmQuickSelectedClasses(classes, fallbackClass){
    return pccmQuickSelectedValues("class", classes, fallbackClass ? [fallbackClass] : []);
}

function pccmQuickMultiId(type){
    if (type === "subject") return "pccmQuickMon";
    if (type === "teacher") return "pccmQuickGv";
    return "pccmQuickClass";
}

function pccmQuickMultiBoxId(type){
    if (type === "subject") return "pccmQuickSubjectMulti";
    if (type === "teacher") return "pccmQuickTeacherMulti";
    return "pccmQuickClassMulti";
}

function pccmQuickMultiTextId(type){
    if (type === "subject") return "pccmQuickSubjectText";
    if (type === "teacher") return "pccmQuickTeacherText";
    return "pccmQuickClassText";
}

function pccmQuickMultiPlaceholder(type){
    if (type === "subject") return "Chọn môn học";
    if (type === "teacher") return "Chọn giáo viên";
    return "Chọn lớp học";
}

function pccmQuickRenderMultiItem(type, item, selectedValues){
    const value = _normText(item?.value);
    const label = _normText(item?.label) || value;
    const title = _normText(item?.title) || label;
    const selected = (selectedValues || []).includes(value);
    return `
        <button type="button"
                class="pccm-multi-item ${selected ? "selected" : ""}"
                data-pccm-quick-type="${escapeHtml(type)}"
                data-pccm-quick-value="${escapeHtml(value)}"
                data-pccm-quick-label="${escapeHtml(label)}"
                title="${escapeHtml(title)}"
                onclick="pccmQuickMultiItemClick(event,'${type}', this.getAttribute('data-pccm-quick-value'))">
            ${escapeHtml(label)}
        </button>`;
}

function pccmQuickRenderMulti(type, items, selectedValues, placeholder){
    items = (items || []).map(item=>({
        value: _normText(item?.value),
        label: _normText(item?.label) || _normText(item?.value),
        title: _normText(item?.title) || _normText(item?.label) || _normText(item?.value)
    })).filter(item=>item.value);
    const values = items.map(item=>item.value);
    selectedValues = (selectedValues || []).filter(v=>values.includes(v));
    const labelByValue = new Map(items.map(item=>[item.value, item.label || item.value]));
    const selectedLabel = selectedValues.map(v=>labelByValue.get(v) || v).join(", ");
    const text = selectedLabel || placeholder || pccmQuickMultiPlaceholder(type);
    const id = pccmQuickMultiId(type);
    const boxId = pccmQuickMultiBoxId(type);
    const textId = pccmQuickMultiTextId(type);
    return `
        <div id="${boxId}" class="pccm-multi-select" data-pccm-quick-box="${escapeHtml(type)}">
            <input id="${id}" type="hidden" value="${escapeHtml(selectedValues.join(", "))}">
            <button type="button" class="pccm-multi-button" onclick="pccmQuickMultiToggle(event,'${type}')" title="${escapeHtml(selectedLabel)}">
                <span id="${textId}">${escapeHtml(text)}</span>
                <span class="pccm-multi-arrow">▾</span>
            </button>
            <div class="pccm-multi-menu">
                ${items.map(item=>pccmQuickRenderMultiItem(type, item, selectedValues)).join("")}
            </div>
        </div>`;
}

function pccmQuickMultiToggle(ev, type){
    try{
        if (ev) ev.stopPropagation();
        const box = document.getElementById(pccmQuickMultiBoxId(type));
        if (!box) return;
        const willOpen = !box.classList.contains("open");
        pccmQuickMultiCloseAll();
        if (willOpen) box.classList.add("open");
    }catch(e){
        // ignore
    }
}

function pccmQuickMultiCloseAll(){
    try{
        document.querySelectorAll(".pccm-multi-select.open").forEach(box=>{
            pccmResetTeacherMultiMenu(pccmTeacherMultiMenuForBox(box));
            box.classList.remove("open");
        });
        document.querySelectorAll(".pccm-mobile-floating-menu").forEach(menu=>pccmResetTeacherMultiMenu(menu));
    }catch(e){
        // ignore
    }
}

function pccmQuickMultiUpdateUI(type){
    try{
        const allButtons = Array.from(document.querySelectorAll(`[data-pccm-quick-type="${type}"]`));
        const allValues = allButtons.map(btn=>_normText(btn.getAttribute("data-pccm-quick-value"))).filter(Boolean);
        const selected = pccmQuickSelectedValues(type, allValues, []);
        const selectedSet = new Set(selected);
        const labelByValue = new Map(allButtons.map(btn=>[
            _normText(btn.getAttribute("data-pccm-quick-value")),
            _normText(btn.getAttribute("data-pccm-quick-label")) || _normText(btn.getAttribute("data-pccm-quick-value"))
        ]));
        const label = selected.map(v=>labelByValue.get(v) || v).join(", ");
        const hidden = document.getElementById(pccmQuickMultiId(type));
        const text = document.getElementById(pccmQuickMultiTextId(type));
        const button = document.querySelector(`#${pccmQuickMultiBoxId(type)} .pccm-multi-button`);
        if (hidden) hidden.value = selected.join(", ");
        if (text) text.textContent = label || pccmQuickMultiPlaceholder(type);
        if (button) button.title = label;
        allButtons.forEach(btn=>{
            const value = _normText(btn.getAttribute("data-pccm-quick-value"));
            btn.classList.toggle("selected", selectedSet.has(value));
        });
        if (type === "class") pccmQuickOnClassChange(selected.join(", "));
    }catch(e){
        // ignore
    }
}

function pccmQuickMultiItemClick(ev, type, value){
    try{
        if (ev){
            ev.preventDefault();
            ev.stopPropagation();
        }
        const all = Array.from(document.querySelectorAll(`[data-pccm-quick-type="${type}"]`))
            .map(btn=>_normText(btn.getAttribute("data-pccm-quick-value")))
            .filter(Boolean);
        const cur = _normText(value);
        if (!cur) return;
        const selected = new Set(pccmQuickGetSelected(type));
        const anchor = pccmQuickGetAnchor(type);

        if (ev && ev.shiftKey && anchor){
            const a = all.indexOf(anchor);
            const b = all.indexOf(cur);
            if (a >= 0 && b >= 0){
                const from = Math.min(a, b);
                const to = Math.max(a, b);
                all.slice(from, to + 1).forEach(v=>selected.add(v));
            }else{
                selected.add(cur);
            }
        }else if (ev && (ev.ctrlKey || ev.metaKey)){
            if (selected.has(cur)) selected.delete(cur);
            else selected.add(cur);
        }else{
            selected.clear();
            selected.add(cur);
        }

        pccmQuickSetAnchor(type, cur);
        pccmQuickSetSelected(type, Array.from(selected).filter(v=>all.includes(v)));
        pccmQuickMultiUpdateUI(type);
        if (!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey))){
            pccmQuickMultiCloseAll();
        }
    }catch(e){
        // ignore
    }
}

function pccmQuickClassToggleDropdown(ev){
    return pccmQuickMultiToggle(ev, "class");
}

function pccmQuickClassCloseDropdown(){
    return pccmQuickMultiCloseAll();
}

function pccmQuickClassUpdateUI(){
    return pccmQuickMultiUpdateUI("class");
}

function pccmQuickClassItemClick(ev, cls){
    return pccmQuickMultiItemClick(ev, "class", cls);
}

document.addEventListener("click", (ev)=>{
    try{
        if (ev.target && ev.target.closest && ev.target.closest(".pccm-multi-select")) return;
        pccmQuickMultiCloseAll();
    }catch(e){
        // ignore
    }
});

function pccmQuickSubjectItemsForClasses(selectedClasses, monList){
    const base = (monList || []).slice();
    const classes = (selectedClasses || []).map(c=>_normText(c)).filter(Boolean);
    let mons = [];
    if (classes.length){
        const seen = new Set();
        classes.forEach(cls=>{
            pccmGetAllowedMonsForClass(cls, base).forEach(m=>{
                const key = _normText(m.key || m.ten || m.ma || m.ma2);
                if (key && !seen.has(key)){
                    seen.add(key);
                    mons.push(m);
                }
            });
        });
    }else{
        mons = base.filter(m => monHasPositiveTietChuanAnyKhoi(m));
    }
    if (!mons.length) mons = base.filter(m => monHasPositiveTietChuanAnyKhoi(m));
    return mons.map(m=>({
        value: _normText(m.key || m.ten || m.ma || m.ma2),
        label: pccmSubjectCode(m),
        title: pccmSubjectHint(m),
        monObj: m
    })).filter(item=>item.value);
}

function pccmQuickOnClassChange(cls){
    const monSel = document.getElementById("pccmQuickMon");
    if (!monSel) return;

    // base list giống như màn Phân công: chỉ lấy môn có tiết chuẩn ở ít nhất 1 khối
    const base = buildPCCMMonList().filter(m => monHasPositiveTietChuanAnyKhoi(m));
    const selectedClasses = pccmQuickMultiValues(cls);
    const allowedItems = pccmQuickSubjectItemsForClasses(selectedClasses, base);
    const allowed = allowedItems.map(item=>item.monObj);

    if (monSel.tagName === "SELECT"){
        const cur = (monSel.value || "").toString();
        monSel.innerHTML = allowed.map(m=>pccmRenderSubjectOption(m, false)).join("");
        if (allowed.some(m => (m.key||m.ten||"") === cur)) monSel.value = cur;
        pccmUpdateOptionTitle(monSel);
    }else{
        const values = allowedItems.map(item=>item.value);
        const current = pccmQuickMultiValues(monSel.value);
        const fallback = current.concat([values[0]]).filter(Boolean);
        const selected = pccmQuickSelectedValues("subject", values, fallback);
        const menu = document.querySelector(`#${pccmQuickMultiBoxId("subject")} .pccm-multi-menu`);
        if (menu) menu.innerHTML = allowedItems.map(item=>pccmQuickRenderMultiItem("subject", item, selected)).join("");
        pccmQuickMultiUpdateUI("subject");
    }

    // reset 2 ô nhập nhanh số tiết/giới hạn (để mặc định theo Tiết chuẩn)
    try{
        const a = document.getElementById("pccmQuickSoTiet");
        const b = document.getElementById("pccmQuickGioiHan");
        if (a) a.value = "";
        if (b) b.value = "";
    }catch(e){}
}

// Box "Thêm nhanh" ở bên phải trong mục Phân công
function renderPCCMQuickBox(classNames, monList){
    const classes = (classNames || []).slice();
    const mons = (monList || []).slice();

    // Teachers: chỉ hiển thị mã (tên tắt)
    const gvCodes = (DATA.giaovien || [])
        .map(g=>_normText(g?.magv))
        .filter(Boolean);

    const defaultClass = classes.includes(PCCM_SELECTED_CLASS) ? PCCM_SELECTED_CLASS : (classes[0] || "");
    const classItems = classes.map(c=>({ value:c, label:c, title:c }));
    const teacherItems = gvCodes.map(code=>({ value:code, label:code, title:pccmTeacherHint(code) }));
    const field = (label, body) => `
            <div class="pccm-field-label">${label}</div>
            ${body}`;

    let quickFields = "";
    if (PCCM_TAB === "giaovien"){
        const selectedClasses = pccmQuickSelectedValues("class", classes, defaultClass ? [defaultClass] : []);
        const subjectItems = pccmQuickSubjectItemsForClasses(selectedClasses, mons);
        const subjectValues = subjectItems.map(item=>item.value);
        const selectedSubjects = pccmQuickSelectedValues("subject", subjectValues, [subjectValues[0]].filter(Boolean));
        quickFields += field("Môn học", pccmQuickRenderMulti("subject", subjectItems, selectedSubjects, "Chọn môn học"));
        quickFields += field("Lớp học", pccmQuickRenderMulti("class", classItems, selectedClasses, "Chọn lớp học"));
    }else if (PCCM_TAB === "monhoc"){
        const selectedClasses = pccmQuickSelectedValues("class", classes, defaultClass ? [defaultClass] : []);
        const selectedTeachers = pccmQuickSelectedValues("teacher", gvCodes, []);
        quickFields += field("Lớp học", pccmQuickRenderMulti("class", classItems, selectedClasses, "Chọn lớp học"));
        quickFields += field("Giáo viên", pccmQuickRenderMulti("teacher", teacherItems, selectedTeachers, "Chọn giáo viên"));
    }else{
        const subjectItems = pccmQuickSubjectItemsForClasses(defaultClass ? [defaultClass] : [], mons);
        const subjectValues = subjectItems.map(item=>item.value);
        const selectedSubjects = pccmQuickSelectedValues("subject", subjectValues, [subjectValues[0]].filter(Boolean));
        const selectedTeachers = pccmQuickSelectedValues("teacher", gvCodes, []);
        quickFields += field("Môn học", pccmQuickRenderMulti("subject", subjectItems, selectedSubjects, "Chọn môn học"));
        quickFields += field("Giáo viên", pccmQuickRenderMulti("teacher", teacherItems, selectedTeachers, "Chọn giáo viên"));
    }

    return `
    <div class="pccm-quick">
        <div class="pccm-side-title">Thêm nhanh</div>
        <div class="pccm-quick-card">
            ${quickFields}

            <div class="pccm-field-label">Số tiết</div>
            <input id="pccmQuickSoTiet" class="inline-edit-input" type="number" min="0" step="1"
                   placeholder="(mặc định theo Tiết chuẩn)" style="text-align:center">

            <div class="pccm-field-label">Giới hạn</div>
            <input id="pccmQuickGioiHan" class="inline-edit-input" type="number" min="0" step="1"
                   placeholder="(mặc định theo Tiết chuẩn)" style="text-align:center">

            <button class="btn primary" style="width:100%" onclick="pccmQuickEditApply()">Áp dụng</button>

        </div>
    </div>`;
}

// Lưu PCCM (tab Lớp): GV (listbox) + Tiết/Giới hạn (textbox) — chỉ lưu 1 lần
function pccmSaveClassEdits(opts){
    const silent = !!(opts && opts.silent);
    const cls = (PCCM_CLASS_EDIT_CACHE?.cls || "").trim();
    const khoiName = (PCCM_CLASS_EDIT_CACHE?.khoiName || "").trim();
    const mons = PCCM_CLASS_EDIT_CACHE?.mons || [];

    if (!cls || !khoiName || !Array.isArray(mons) || !mons.length){
        pccmNotifySaveProblem("Không có dữ liệu để lưu. Hãy chọn lớp trước.", silent);
        return false;
    }

    // validate: empty allowed; if not empty => >0
    function _validateNumber(v){
        const s = (v ?? "").toString().trim();
        if (s === "") return { ok:true, val:"" };
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok:false };
        if (n < 0) return { ok:false };
        return { ok:true, val: String(n) };
    }

    // set teacher without saving each change
    function _setTeacherNoSave(lopCanon, monObj, val){
        pccmSetTeachersNoSave(lopCanon, monObj, val);
    }

    // pass 1: đọc DOM + check trùng khóa (Lớp|Môn)
    const allMons = buildPCCMMonList();
    const monMap = new Map(allMons.map(m=>[_normText(m.key||m.ten), m]));
    function _findMonObj(monKey){
        const k = _normText(monKey);
        return monMap.get(k)
            || allMons.find(m=>_normText(m.ten) === k)
            || { key: k, ten: k, code:"", ma:"", ma2:"" };
    }

    const ops = [];
    const seen = new Set();

    for (let idx=0; idx<mons.length; idx++){
        const oldMonObj = mons[idx];
        const newMonKey = (document.getElementById(`pccm_mon_${idx}`)?.value || (oldMonObj.key||oldMonObj.ten||""))
            .toString().trim();
        if (!newMonKey){
            pccmNotifySaveProblem(`Môn học không hợp lệ ở dòng ${idx+1}.`, silent);
            return false;
        }
        const newMonObj = _findMonObj(newMonKey);
        const key = `${cls}|${(newMonObj.key || newMonObj.ten || '').trim()}`;
        if (seen.has(key)){
            pccmNotifySaveProblem(`Trùng phân công (Lớp|Môn) ở dòng ${idx+1}: ${key}.`, silent);
            return false;
        }
        seen.add(key);

        ops.push({ idx, oldMonObj, newMonObj });
    }

    // clear key cũ nếu người dùng đổi Môn
    const cleared = new Set();
    for (const op of ops){
        const oldKey = `${cls}|${(op.oldMonObj?.key || op.oldMonObj?.ten || '').trim()}`;
        const newKey = `${cls}|${(op.newMonObj?.key || op.newMonObj?.ten || '').trim()}`;
        if (oldKey && newKey && oldKey !== newKey && !cleared.has(oldKey)){
            cleared.add(oldKey);
            _setTeacherNoSave(cls, op.oldMonObj, "");
            pccmSetTietGioihanNoSave(cls, op.oldMonObj, "", "");
        }
    }

    // apply all rows
    for (const op of ops){
        const idx = op.idx;
        const m = op.newMonObj;

        const gv = pccmNormalizeTeacherValue(document.getElementById(`pccm_gv_${idx}`)?.value || "");
        const sotietRaw = (document.getElementById(`pccm_sotiet_${idx}`)?.value || "").toString().trim();
        const gioihanRaw = (document.getElementById(`pccm_gioihan_${idx}`)?.value || "").toString().trim();

        // 1) GV (PCCM)
        _setTeacherNoSave(cls, m, gv);

        // 2) Tiết/Giới hạn theo Lớp|Môn
        const v1 = _validateNumber(sotietRaw);
        const v2 = _validateNumber(gioihanRaw);
        if (!v1.ok || !v2.ok){
            pccmNotifySaveProblem(`Dữ liệu không hợp lệ ở môn: ${(m.ten||m.key||"")}. Chỉ được để trống hoặc nhập số > 0.`, silent);
            return false;
        }

        // Lưu số tiết / giới hạn theo Lớp|Môn (nguồn cho màn "Sắp xếp TKB")
        pccmSetTietGioihanNoSave(cls, m, v1.val, v2.val);

    }

    if (silent && PCCM_CLASS_EDIT_CACHE && Array.isArray(PCCM_CLASS_EDIT_CACHE.mons)){
        ops.forEach(op=>{
            PCCM_CLASS_EDIT_CACHE.mons[op.idx] = op.newMonObj;
        });
    }

    saveStore();
    if (silent){
        pccmRefreshTotalBadge();
        return true;
    }

    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function") pccmRenderCurrent(sc);
    alert("✔ Đã lưu PCCM.");
    return true;
}

// Backward compatibility (nếu đâu đó còn gọi)
function pccmQuickAssignClass(){
    return pccmQuickEditApply();
}

// Lưu PCCM (tab Giáo viên): Lớp/Môn + Tiết/Giới hạn — lưu 1 lần
function pccmSaveTeacherEdits(opts){
    const silent = !!(opts && opts.silent);
    const rows = PCCM_TEACHER_EDIT_CACHE?.rows || [];
    const gv = (PCCM_TEACHER_EDIT_CACHE?.gv || "").toString().trim();
    if (!Array.isArray(rows) || !rows.length){
        pccmNotifySaveProblem("Không có dữ liệu để lưu.", silent);
        return false;
    }
    if (!gv){
        pccmNotifySaveProblem("Chưa chọn giáo viên.", silent);
        return false;
    }

    if (typeof DATA.pccmMatrix !== "object" || !DATA.pccmMatrix) DATA.pccmMatrix = {};

    // map lớp -> khối (để update tiết chuẩn đúng khối sau khi đổi lớp)
    const classToKhoi = new Map((DATA.lop||[]).map(l=>{
        const canon = classCanonFromLop(l);
        const khoi = (l.khoi || ("Khối " + extractKhoiNumber(canon))).trim();
        return [canon.trim(), khoi];
    }).filter(x=>x[0]));

    // map mônKey -> monObj
    const allMons = buildPCCMMonList();
    const monMap = new Map(allMons.map(m=>[_normText(m.key||m.ten), m]));
    function _findMonObj(monKey){
        const k = _normText(monKey);
        return monMap.get(k)
            || allMons.find(m=>_normText(m.ten) === k)
            || { key: k, ten: k, code:"", ma:"", ma2:"" };
    }

    function _validateNumber(v){
        const s = (v ?? "").toString().trim();
        if (s === "") return { ok:true, val:"" };
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok:false };
        if (n < 0) return { ok:false };
        return { ok:true, val: String(n) };
    }

    function _setTeacherNoSave(lopCanon, monObj, val){
        pccmSetTeachersNoSave(lopCanon, monObj, val);
    }

    // pass 1: đọc DOM + check trùng khóa
    const ops = [];
    const seenKeys = new Set();
    for (let idx=0; idx<rows.length; idx++){
        const r = rows[idx];
        const newCls = (document.getElementById(`pccmT_cls_${idx}`)?.value || r.cls || "").toString().trim();
        const newMonKey = (document.getElementById(`pccmT_mon_${idx}`)?.value || (r.monObj?.key||r.monObj?.ten||""))
            .toString().trim();
        if (!newCls || !newMonKey){
            pccmNotifySaveProblem(`Dữ liệu Lớp/Môn không hợp lệ ở dòng ${idx+1}.`, silent);
            return false;
        }
        const newMonObj = _findMonObj(newMonKey);
        const newKey = `${newCls}|${(newMonObj.key || newMonObj.ten || "").trim()}`;
        if (seenKeys.has(newKey)){
            pccmNotifySaveProblem(`Trùng phân công (Lớp|Môn) ở dòng ${idx+1}: ${newKey}.`, silent);
            return false;
        }
        seenKeys.add(newKey);

        ops.push({
            idx,
            r,
            oldCls: (r.cls||"").trim(),
            oldMonObj: r.monObj,
            newCls,
            newMonObj,
            sotietRaw: (document.getElementById(`pccmT_sotiet_${idx}`)?.value || "").toString().trim(),
            gioihanRaw: (document.getElementById(`pccmT_gioihan_${idx}`)?.value || "").toString().trim()
        });
    }

    // clear các key cũ nếu người dùng đổi Lớp/Môn
    const cleared = new Set();
    ops.forEach(op=>{
        const oldKey = `${op.oldCls}|${(op.oldMonObj?.key || op.oldMonObj?.ten || "").toString().trim()}`;
        const newKey = `${op.newCls}|${(op.newMonObj?.key || op.newMonObj?.ten || "").toString().trim()}`;
        if (oldKey && newKey && oldKey !== newKey && !cleared.has(oldKey)){
            cleared.add(oldKey);
            pccmSetTeacherMembershipNoSave(op.oldCls, op.oldMonObj, gv, false);
        }
    });

    // apply
    for (const op of ops){
        const khoiName = classToKhoi.get(op.newCls) || ("Khối " + extractKhoiNumber(op.newCls));

        // 1) GV (giáo viên đang chọn)
        pccmSetTeacherMembershipNoSave(op.newCls, op.newMonObj, gv, true);

        // 2) Tiết/Giới hạn theo Lớp|Môn
        const v1 = _validateNumber(op.sotietRaw);
        const v2 = _validateNumber(op.gioihanRaw);
        if (!v1.ok || !v2.ok){
            pccmNotifySaveProblem(`Dữ liệu không hợp lệ ở: ${(op.newMonObj.ten||op.newMonObj.key||"")} (${khoiName}). Chỉ được để trống hoặc nhập số > 0.`, silent);
            return false;
        }

        // Lưu số tiết / giới hạn theo Lớp|Môn (nguồn cho màn "Sắp xếp TKB")
        pccmSetTietGioihanNoSave(op.newCls, op.newMonObj, v1.val, v2.val);

    }

    if (silent && PCCM_TEACHER_EDIT_CACHE && Array.isArray(PCCM_TEACHER_EDIT_CACHE.rows)){
        ops.forEach(op=>{
            const row = PCCM_TEACHER_EDIT_CACHE.rows[op.idx];
            if (!row) return;
            row.cls = op.newCls;
            row.monObj = op.newMonObj;
            row.khoiName = classToKhoi.get(op.newCls) || ("Khối " + extractKhoiNumber(op.newCls));
            row.sotiet = op.sotietRaw;
            row.gioihan = op.gioihanRaw;
        });
    }

    saveStore();
    if (silent){
        pccmRefreshTotalBadge();
        return true;
    }
    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function") pccmRenderCurrent(sc);
    alert("✔ Đã lưu PCCM.");
    return true;
}

// Lưu PCCM (tab Môn học): GV + Tiết/Giới hạn — lưu 1 lần
function pccmSaveSubjectEdits(opts){
    const silent = !!(opts && opts.silent);
    const rows = PCCM_SUBJECT_EDIT_CACHE?.rows || [];
    const monObj = PCCM_SUBJECT_EDIT_CACHE?.monObj || null;

    if (!monObj || !Array.isArray(rows) || !rows.length){
        pccmNotifySaveProblem("Không có dữ liệu để lưu.", silent);
        return false;
    }

    if (typeof DATA.pccmMatrix !== "object" || !DATA.pccmMatrix) DATA.pccmMatrix = {};

    // map lớp -> khối (để update tiết chuẩn đúng khối sau khi đổi lớp)
    const classToKhoi = new Map((DATA.lop||[]).map(l=>{
        const canon = classCanonFromLop(l);
        const khoi = (l.khoi || ("Khối " + extractKhoiNumber(canon))).trim();
        return [canon.trim(), khoi];
    }).filter(x=>x[0]));

    function _validateNumber(v){
        const s = (v ?? "").toString().trim();
        if (s === "") return { ok:true, val:"" };
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok:false };
        if (n < 0) return { ok:false };
        return { ok:true, val: String(n) };
    }

    function _setTeacherNoSave(lopCanon, monObj, val){
        pccmSetTeachersNoSave(lopCanon, monObj, val);
    }

    // pass 1: đọc DOM + check trùng lớp
    const ops = [];
    const seenCls = new Set();
    for (let idx=0; idx<rows.length; idx++){
        const r = rows[idx];
        const newCls = (document.getElementById(`pccmS_cls_${idx}`)?.value || r.cls || "").toString().trim();
        if (!newCls){
            pccmNotifySaveProblem(`Dữ liệu Lớp không hợp lệ ở dòng ${idx+1}.`, silent);
            return false;
        }
        if (seenCls.has(newCls)){
            pccmNotifySaveProblem(`Trùng Lớp ở dòng ${idx+1}: ${newCls}.`, silent);
            return false;
        }
        seenCls.add(newCls);

        ops.push({
            idx,
            r,
            oldCls: (r.cls||"").trim(),
            newCls,
            gv: pccmNormalizeTeacherValue(document.getElementById(`pccmS_gv_${idx}`)?.value || ""),
            sotietRaw: (document.getElementById(`pccmS_sotiet_${idx}`)?.value || "").toString().trim(),
            gioihanRaw: (document.getElementById(`pccmS_gioihan_${idx}`)?.value || "").toString().trim()
        });
    }

    // clear key cũ nếu đổi lớp
    const cleared = new Set();
    ops.forEach(op=>{
        if (op.oldCls && op.newCls && op.oldCls !== op.newCls && !cleared.has(op.oldCls)){
            cleared.add(op.oldCls);
            _setTeacherNoSave(op.oldCls, monObj, "");
        }
    });

    // apply
    for (const op of ops){
        const khoiName = classToKhoi.get(op.newCls) || ("Khối " + extractKhoiNumber(op.newCls));

        // 1) GV
        _setTeacherNoSave(op.newCls, monObj, op.gv);

        // 2) Tiết/Giới hạn theo Lớp|Môn
        const v1 = _validateNumber(op.sotietRaw);
        const v2 = _validateNumber(op.gioihanRaw);
        if (!v1.ok || !v2.ok){
            pccmNotifySaveProblem(`Dữ liệu không hợp lệ ở lớp: ${op.newCls} (${khoiName}). Chỉ được để trống hoặc nhập số > 0.`, silent);
            return false;
        }

        // Lưu số tiết / giới hạn theo Lớp|Môn (nguồn cho màn "Sắp xếp TKB")
        pccmSetTietGioihanNoSave(op.newCls, monObj, v1.val, v2.val);

    }

    if (silent && PCCM_SUBJECT_EDIT_CACHE && Array.isArray(PCCM_SUBJECT_EDIT_CACHE.rows)){
        ops.forEach(op=>{
            const row = PCCM_SUBJECT_EDIT_CACHE.rows[op.idx];
            if (!row) return;
            row.cls = op.newCls;
            row.khoiName = classToKhoi.get(op.newCls) || ("Khối " + extractKhoiNumber(op.newCls));
            row.gv = op.gv;
            row.sotiet = op.sotietRaw;
            row.gioihan = op.gioihanRaw;
        });
    }

    saveStore();
    if (silent){
        pccmRefreshTotalBadge();
        return true;
    }
    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function") pccmRenderCurrent(sc);
    alert("✔ Đã lưu PCCM.");
    return true;
}



/* ============================================================
   ĐỒNG BỘ MÔN (menu lớn "Môn học" = DATA.monhoc)
   - Ý tưởng: 1 môn tổng hợp (monhoc) được xem là "đồng bộ" nếu đã có đủ
     trong TIẾT CHUẨN (DATA.mon) của TẤT CẢ các khối.
   - Nếu chưa đủ, bấm checkbox sẽ tự bổ sung môn đó vào các khối còn thiếu.
============================================================ */
function getAllKhoiNamesForSync(){
    let khois = (DATA.khoi || []).map(k => _normText(k.ten)).filter(Boolean);

    // Nếu chưa có danh sách khối, thử lấy từ danh sách lớp
    if (!khois.length){
        khois = (DATA.lop || []).map(l=>{
            const canon = classCanonFromLop(l);
            const khoi = _normText(l.khoi || ("Khối " + extractKhoiNumber(canon)));
            return khoi;
        }).filter(Boolean);
    }

    // Nếu vẫn trống, thử lấy từ tiết chuẩn hiện có
    if (!khois.length){
        khois = (DATA.mon || []).map(m => _normText(m.khoi)).filter(Boolean);
    }

    return Array.from(new Set(khois)).sort((a,b)=>a.localeCompare(b,'vi'));
}

function _findMonhocByIdOrTen(x){
    x = _normText(x);
    if (!x) return null;
    return (DATA.monhoc || []).find(m => _normText(m.id) === x)
        || (DATA.monhoc || []).find(m => _normText(m.ten) === x)
        || (DATA.monhoc || []).find(m => _normText(m.ma) === x)
        || (DATA.monhoc || []).find(m => _normText(m.ma2) === x)
        || null;
}
function _monhocCandidates(mh){
    if (!mh) return [];
    const ten = _normText(mh.ten);
    const ma  = _normText(mh.ma);
    const ma2 = _normText(mh.ma2);
    return Array.from(new Set([ma, ma2, ten].filter(Boolean)));
}
function _monhocCanonicalKey(mh){
    if (!mh) return "";
    return _normText(mh.ma) || _normText(mh.ma2) || _normText(mh.ten) || "";
}

/**
 * ĐỒNG BỘ MÔN: check đã có đủ trong TIẾT CHUẨN (DATA.mon) cho mọi khối hay chưa.
 * - Ưu tiên dùng MÃ MÔN (ma/ma2). Nếu không có mã thì dùng TÊN.
 * - Không tạo trùng kiểu "Nhạc" và "Âm nhạc": chỉ cần 1 trong các biến thể (mã/tên) là xem như đã có.
 */
function isMonSyncedAcrossKhoi(monhocIdOrTen){
    const mh = _findMonhocByIdOrTen(monhocIdOrTen);
    const candidates = mh ? _monhocCandidates(mh) : [_normText(monhocIdOrTen)].filter(Boolean);
    if (!candidates.length) return false;

    const khois = getAllKhoiNamesForSync().filter(khoi => !mh || monhocAppliesToKhoi(mh, khoi));
    if (!khois.length) return false;

    return khois.every(khoi =>
        (DATA.mon || []).some(m =>
            _normText(m.khoi) === _normText(khoi) && candidates.includes(_normText(m.ten))
        )
    );
}

/**
 * Đồng bộ Môn học (DATA.monhoc) -> Tiết chuẩn (DATA.mon)
 * - Lưu vào tiết chuẩn bằng MÃ MÔN (ma/ma2) để tránh trùng (ví dụ: "Nhạc" vs "Âm nhạc")
 * - Khi hiển thị, UI dùng resolveMonDisplay(...) để hiện TÊN MÔN.
 * - Nếu trong 1 khối đã có môn theo TÊN nhưng chưa theo MÃ, hàm sẽ "chuẩn hoá" về MÃ thay vì thêm dòng mới.
 */
function syncMonAcrossKhoi(monhocIdOrTen){
    const mh = _findMonhocByIdOrTen(monhocIdOrTen);

    const displayName = mh ? (_normText(mh.ten) || _normText(monhocIdOrTen)) : _normText(monhocIdOrTen);
    const candidates = mh ? _monhocCandidates(mh) : [_normText(monhocIdOrTen)].filter(Boolean);
    const canonicalKey = mh ? _monhocCanonicalKey(mh) : _normText(monhocIdOrTen);

    if (!canonicalKey) return;

    const khois = getAllKhoiNamesForSync().filter(khoi => !mh || monhocAppliesToKhoi(mh, khoi));
    if (!khois.length) {
        alert("⚠ Chưa có danh sách Khối. Hãy nhập 'Khối học' trước.");
        return;
    }

    // Lấy template số tiết/giới hạn từ 1 khối đã có (nếu có) để đỡ nhập lại
    const tpl = (DATA.mon || []).find(m => candidates.includes(_normText(m.ten)) && _normText(m.khoi));

    let added = 0;
    let normalized = 0;
    let removedDup = 0;

    khois.forEach(khoi=>{
        const khoiNorm = _normText(khoi);

        // Tất cả dòng "môn" của khối này khớp theo mã/tên
        const rows = (DATA.mon || []).filter(m =>
            _normText(m.khoi) === khoiNorm && candidates.includes(_normText(m.ten))
        );

        if (rows.length === 0){
            // chưa có -> thêm mới (ten = mã)
            DATA.mon.push({
                id: autoID("mon"),
                khoi: khoi,
                ten: canonicalKey,
                sotiet: tpl ? (tpl.sotiet || "") : "",
                gioihan: tpl ? (tpl.gioihan || "") : ""
            });
            added++;
            return;
        }

        // đã có -> chuẩn hoá về canonicalKey để tránh "Nhạc" & "Âm nhạc" cùng tồn tại
        // Nếu có nhiều dòng, giữ 1 dòng "tốt nhất", xoá dòng còn lại.
        // Tiêu chí giữ: ưu tiên dòng có ten==canonicalKey; nếu không có thì chọn dòng có nhiều dữ liệu sotiet/gioihan hơn.
        let keep = rows.find(r => _normText(r.ten) === canonicalKey) || rows[0];
        for (const r of rows){
            const score = (x)=> (String(x.sotiet||"").trim()?1:0) + (String(x.gioihan||"").trim()?1:0);
            if (r !== keep && score(r) > score(keep)) keep = r;
        }

        // merge: nếu keep thiếu sotiet/gioihan mà tpl có, bổ sung nhẹ
        if (tpl){
            if (!String(keep.sotiet||"").trim() && String(tpl.sotiet||"").trim()) keep.sotiet = tpl.sotiet;
            if (!String(keep.gioihan||"").trim() && String(tpl.gioihan||"").trim()) keep.gioihan = tpl.gioihan;
        }

        if (_normText(keep.ten) !== canonicalKey){
            keep.ten = canonicalKey;
            normalized++;
        }

        // remove dups beyond keep
        if (rows.length > 1){
            const keepId = keep.id;
            DATA.mon = (DATA.mon || []).filter(m => {
                if (_normText(m.khoi) !== khoiNorm) return true;
                if (!candidates.includes(_normText(m.ten))) return true;
                // loại các dòng trùng, giữ lại đúng keepId
                return (m.id === keepId);
            });
            removedDup += (rows.length - 1);
        }
    });

    saveStore();

    // refresh UI: nếu đang ở PCCM thì renderPCCM, ngược lại render lại môn học
    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function" && sc.innerHTML && sc.innerHTML.includes("PCCM")) {
        pccmRenderCurrent(sc);
    } else {
        renderSectionInto("monhoc","section-content",document);
    }

    let msg = `✔ Đồng bộ "${displayName}" xong.`;
    if (added) msg += ` Thêm mới: ${added} khối.`;
    if (normalized) msg += ` Chuẩn hoá: ${normalized} khối.`;
    if (removedDup) msg += ` Xoá trùng: ${removedDup} dòng.`;
    alert(msg);
}



// (đã bỏ tính năng dán từ Excel)




function renderPCCM_ByClass(classNames, monList){
    // Left: danh sách lớp (đã lọc theo khối ở renderPCCM)
    const left = `
    <div class="pccm-side">
        <div ${pccmSideListAttrs("lop")}>
            ${(classNames||[]).map(c=>`
                <div onclick="setPCCMSelectedClass('${escapeHtml(c)}')"
                     class="pccm-side-item ${c===PCCM_SELECTED_CLASS?"active":""}">
                    ${escapeHtml(c)}
                </div>
            `).join("")}
        </div>
    </div>`;

    if (!PCCM_SELECTED_CLASS && (classNames||[]).length) PCCM_SELECTED_CLASS = classNames[0];
    if (PCCM_SELECTED_CLASS && !(classNames||[]).includes(PCCM_SELECTED_CLASS) && (classNames||[]).length) PCCM_SELECTED_CLASS = classNames[0];

    const cls = PCCM_SELECTED_CLASS;

    const classToKhoi = new Map((DATA.lop||[]).map(l=>{
        const canon = classCanonFromLop(l);
        const khoi = (l.khoi || ("Khối " + extractKhoiNumber(canon))).trim();
        return [canon, khoi];
    }).filter(x=>x[0]));
    const khoiName = classToKhoi.get(cls) || ("Khối " + extractKhoiNumber(cls));

    // Danh sách môn: lấy từ môn tổng hợp, lookup sotiet/gioihan từ tiết chuẩn theo khối
    // Chỉ HIỂN THỊ môn có số tiết > 0 trong tiết chuẩn (môn không có tiết sẽ ẩn)
    const mons = (monList||[])
        .map(m=>{
            const tc = lookupTietChuan(khoiName, m);
            return {...m, sotiet: tc ? (tc.sotiet||"") : "", gioihan: tc ? (tc.gioihan||"") : ""};
        })
        .filter(m=> _toPositiveNumberOrZero(m.sotiet) > 0)
        // Chỉ hiển thị môn đã phân công giáo viên (môn chưa phân công sẽ ẩn)
        .filter(m=> {
            return pccmGetTeachers(cls, m).length > 0;
        });

    // Giữ nguyên thứ tự môn theo Bảng Môn (không sort theo GV)

    // Cache cho nút Lưu (đọc DOM)
    PCCM_CLASS_EDIT_CACHE = { cls, khoiName, mons };

    // Teacher options
    const gvItems = (DATA.giaovien || [])
        .map(g=>{
            const code = _normText(g.magv);
            const name = `${(g.hodem||"").trim()} ${(g.ten||"").trim()}`.trim();
            return {code, name};
        })
        .filter(x=>x.code);
    const gvCodesSet = new Set(gvItems.map(x=>x.code));


    let mid = `
    <div class="pccm-workspace">
        <div class="table-wrap pccm-table-wrap"><table class="pccm-table pccm-list-table">
            <colgroup>
                <col class="pccm-col-tt">
                <col class="pccm-col-main pccm-col-subject">
                <col class="pccm-col-main pccm-col-teacher">
                <col class="pccm-col-number">
                <col class="pccm-col-number">
            </colgroup>
            <tr>
                <th>TT</th>
                <th>Môn học</th>
                <th>Giáo viên</th>
                <th>Số tiết</th>
                <th>Giới hạn</th>
            </tr>`;

    mons.forEach((m, idx)=>{
        const val = pccmNormalizeTeacherValue(pccmGetTeacher(cls,m));

        // nếu đã lưu override (từ lần phân công trước) thì hiển thị đúng giá trị
        let sotietDisp = pccmGetTiet(cls, m);
        if(sotietDisp === null || sotietDisp === undefined){
            sotietDisp = (m.sotiet ?? "");
        }
        let gioihanDisp = pccmGetGioihan(cls, m);
        if(gioihanDisp === null || gioihanDisp === undefined){
            gioihanDisp = (m.gioihan ?? "");
        }
        // default 1 (như yêu cầu) nếu còn trống / không hợp lệ
        const _stNum = Number(String(sotietDisp).trim());
        if(String(sotietDisp).trim()==="" || Number.isNaN(_stNum)) sotietDisp = "1";
        const _ghNum = Number(String(gioihanDisp).trim());
        if(String(gioihanDisp).trim()==="" || Number.isNaN(_ghNum)) gioihanDisp = "1";

        mid += `
        <tr>
            <td style="text-align:center">${idx+1}</td>
            <td ${pccmCellAttrs(idx, 0, "subject")}>
                <select id="pccm_mon_${idx}" class="inline-edit-select pccm-subject-select" data-kind="mon" onchange="pccmUpdateOptionTitle(this); pccmAutoSaveActive()" title="${escapeHtml(pccmSubjectHint(m))}">
                    ${(function(){
                        const curV = (m.key||m.ten||'').toString();
                        const curN = _normText(curV);
                        const opts = (mons||[]).map(mm=>{
                            const v = (mm.key||mm.ten||'').toString();
                            const vn = _normText(v);
                            return pccmRenderSubjectOption(mm, vn===curN);
                        }).join('');
                        return opts;
                    })()}
                </select>
            </td>
            <td ${pccmCellAttrs(idx, 1, "teacher")}>
                ${pccmRenderTeacherMulti(`pccm_gv_${idx}`, val, gvItems)}
            </td>
            <td ${pccmCellAttrs(idx, 2, "periods")} style="text-align:center">
                <input id="pccm_sotiet_${idx}" class="inline-edit-input" type="number" min="0" step="1"
                       value="${escapeHtml(sotietDisp)}" placeholder="trống hoặc >=0" style="text-align:center"
                       oninput="pccmAutoSaveActive()" onchange="pccmAutoSaveActive()" onblur="pccmAutoSaveActive()">
            </td>
            <td ${pccmCellAttrs(idx, 3, "limit")} style="text-align:center">
                <input id="pccm_gioihan_${idx}" class="inline-edit-input" type="number" min="0" step="1"
                       value="${escapeHtml(gioihanDisp)}" placeholder="trống hoặc >=0" style="text-align:center"
                       oninput="pccmAutoSaveActive()" onchange="pccmAutoSaveActive()" onblur="pccmAutoSaveActive()">
            </td>
        </tr>`;
    });

    mid += `</table></div></div>`;

    const right = renderPCCMQuickBox(classNames, monList);

    return `<div class="pccm-layout">${left}${mid}${right}</div>`;
}




function renderPCCM_ByTeacher(gvs, monList, classNames){
    const left = `
    <div class="pccm-side">
        <div ${pccmSideListAttrs("giaovien")}>
            ${(gvs||[]).map(g=>`
                <div onclick="setPCCMSelectedGV('${escapeHtml(g)}')"
                     class="pccm-side-item ${g===PCCM_SELECTED_GV?"active":""}"
                     title="${escapeHtml(pccmTeacherHint(g))}">
                    ${escapeHtml(g)}
                </div>
            `).join("")}
        </div>
    </div>`;

    if (!PCCM_SELECTED_GV && (gvs||[]).length) PCCM_SELECTED_GV = gvs[0];
    if (PCCM_SELECTED_GV && !(gvs||[]).includes(PCCM_SELECTED_GV) && (gvs||[]).length) PCCM_SELECTED_GV = gvs[0];

    const gv = PCCM_SELECTED_GV;

    // class -> khối để lookup tiết chuẩn
    const classToKhoi = new Map((DATA.lop||[]).map(l=>{
        const canon = classCanonFromLop(l);
        const khoi = (l.khoi || ("Khối " + extractKhoiNumber(canon))).trim();
        return [canon, khoi];
    }).filter(x=>x[0]));

    const rowsAll = [];
    (classNames||[]).forEach(cls=>{
        const khoiName = classToKhoi.get(cls) || ("Khối " + extractKhoiNumber(cls));
        (monList||[]).forEach(m=>{
            const val = (pccmGetTeacher(cls,m) || "").trim();
            if (!val) return;
            if (!pccmTeacherHas(val, gv)) return;

            // Ẩn môn không có tiết
            if (!monHasPositiveTietChuanForKhoi(khoiName, m)) return;

            rowsAll.push({
                cls,
                khoiName,
                monObj: m,
                sotiet: pccmGetTietDisplay(cls, m, khoiName),
                gioihan: pccmGetGioihanDisplay(cls, m, khoiName)
            });
        });
    });

    let rows = rowsAll;

    PCCM_TEACHER_EDIT_CACHE = { gv, rows };

    let mid = `
    <div class="pccm-workspace">
        <div class="table-wrap pccm-table-wrap"><table class="pccm-table pccm-list-table">
            <colgroup>
                <col class="pccm-col-tt">
                <col class="pccm-col-main pccm-col-subject">
                <col class="pccm-col-main pccm-col-class">
                <col class="pccm-col-number">
                <col class="pccm-col-number">
            </colgroup>
            <tr>
                <th>TT</th>
                <th>Môn học</th>
                <th>Lớp</th>
                <th>Số tiết</th>
                <th>Giới hạn</th>
            </tr>`;

    rows.forEach((r,idx)=>{
        const clsVal = (r.cls || "").trim();
        const monKey = _normText(r.monObj?.key || r.monObj?.ten);

        // options Lớp
        const clsSet = new Set(classNames || []);
        const extraClsOpt = (clsVal && !clsSet.has(clsVal))
            ? `<option value="${escapeHtml(clsVal)}" selected>(Đang lưu) ${escapeHtml(clsVal)}</option>`
            : "";
        const clsOpts = (classNames||[])
            .map(c=>`<option value="${escapeHtml(c)}" ${c===clsVal?"selected":""}>${escapeHtml(c)}</option>`)
            .join("");

        // options Môn (lọc theo lớp)
        const allowedMons = pccmGetAllowedMonsForClass(clsVal, (monList||[]));
        const allowedKeys = new Set(allowedMons.map(m => (m.key||m.ten||"")));
        const extraMonOpt = (monKey && !allowedKeys.has(monKey))
            ? `<option value="${escapeHtml(monKey)}" selected>(Đang lưu) ${escapeHtml(monKey)}</option>`
            : "";
        const monOpts = allowedMons.map(m=>{
            const k = (m.key||m.ten||"").toString();
            return pccmRenderSubjectOption(m, k===monKey);
        }).join("");

        mid += `
        <tr>
            <td style="text-align:center">${idx+1}</td>
            <td ${pccmCellAttrs(idx, 0, "subject")}>
                <select id="pccmT_mon_${idx}" class="inline-edit-select pccm-subject-select" data-kind="mon" onchange="pccmUpdateOptionTitle(this); pccmAutoSaveActive()" title="${escapeHtml(pccmSubjectHint(r.monObj))}">
                    ${extraMonOpt}${monOpts}
                </select>
            </td>
            <td ${pccmCellAttrs(idx, 1, "class")}>
                <select id="pccmT_cls_${idx}" class="inline-edit-select" data-kind="cls" data-monselect="pccmT_mon_${idx}"
                        onchange="pccmRowClassChanged(this); pccmAutoSaveActive()">
                    ${extraClsOpt}${clsOpts}
                </select>
            </td>
            <td ${pccmCellAttrs(idx, 2, "periods")} style="text-align:center">
                <input id="pccmT_sotiet_${idx}" class="inline-edit-input" type="number" min="0" step="1"
                       value="${escapeHtml(r.sotiet||"")}" placeholder="trống hoặc >=0" style="text-align:center"
                       oninput="pccmAutoSaveActive()" onchange="pccmAutoSaveActive()" onblur="pccmAutoSaveActive()">
            </td>
            <td ${pccmCellAttrs(idx, 3, "limit")} style="text-align:center">
                <input id="pccmT_gioihan_${idx}" class="inline-edit-input" type="number" min="0" step="1"
                       value="${escapeHtml(r.gioihan||"")}" placeholder="trống hoặc >=0" style="text-align:center"
                       oninput="pccmAutoSaveActive()" onchange="pccmAutoSaveActive()" onblur="pccmAutoSaveActive()">
            </td>
        </tr>`;
    });

    if (!rows.length){
        mid += `<tr><td colspan="5" style="padding:14px;color:#666">Không có dữ liệu phù hợp.</td></tr>`;
    }

    mid += `</table></div></div>`;

    const right = renderPCCMQuickBox(classNames, monList);
    return `<div class="pccm-layout">${left}${mid}${right}</div>`;
}



let PCCM_SUBJ = ""; // môn (key) đang chọn trong tab Môn học

function setPCCMSelectedSubject(monKey){
    PCCM_SUBJ = monKey || "";
    const sc = document.getElementById("section-content");
    if (sc) pccmRenderCurrent(sc);
}

// Tab "Môn học": Lớp học, Giáo viên, Phòng học (nếu có), Số tiết, Giới hạn
function renderPCCM_BySubject(classNames, monList){
    const subjects = (monList || [])
        .map(m=>({
            key: _normText(m.key || m.ten),
            code: pccmSubjectCode(m),
            name: pccmSubjectName(m),
            hint: pccmSubjectHint(m),
            assigned: pccmSubjectHasAssignedTeacher(m, classNames)
        }))
        .filter(s=>s.key);

    if (!subjects.length) {
        PCCM_SUBJ = "";
        PCCM_SUBJECT_EDIT_CACHE = null;
        return `
        <div style="padding:14px;background:#fff;border-radius:8px;border:1px solid #e3e8f3;margin-top:10px">
            Chưa có <b>môn học</b>.
        </div>`;
    }

    if (!PCCM_SUBJ && subjects.length) PCCM_SUBJ = subjects[0].key;
    if (PCCM_SUBJ && !subjects.some(s=>s.key===PCCM_SUBJ) && subjects.length) PCCM_SUBJ = subjects[0].key;

    const monObj = (monList || []).find(m=>_normText(m.key||m.ten) === _normText(PCCM_SUBJ))
        || { key: PCCM_SUBJ, ten: PCCM_SUBJ };

    // Left: list môn
    const left = `
    <div class="pccm-side">
        <div ${pccmSideListAttrs("monhoc")}>
            ${subjects.map(s=>{
                const js = (s.key||"").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
                return `
                <div onclick="setPCCMSelectedSubject('${js}')"
                     class="pccm-side-item ${s.key===PCCM_SUBJ?"active":""} ${s.assigned?"":"pccm-side-item-unassigned"}"
                     title="${escapeHtml(s.hint || s.name || s.code)}">
                    <span class="pccm-side-item-name">${escapeHtml(s.code || s.name)}</span>
                    ${s.assigned ? "" : '<span class="pccm-side-item-status">Chưa phân công</span>'}
                </div>`;
            }).join("")}
        </div>
    </div>`;

    // Teachers (mã GV)
    const gvCodes = (DATA.giaovien || [])
        .map(g=>_normText(g?.magv))
        .filter(Boolean);
    const gvSet = new Set(gvCodes);

    // class -> khối để lookup tiết chuẩn
    const classToKhoi = new Map((DATA.lop||[]).map(l=>{
        const canon = classCanonFromLop(l);
        const khoi = (l.khoi || ("Khối " + extractKhoiNumber(canon))).trim();
        return [canon, khoi];
    }).filter(x=>x[0]));

    // Chỉ hiển thị các lớp mà môn này có số tiết > 0 (tiết chuẩn)
    const rows = [];
    (classNames||[]).forEach(cls=>{
        const khoiName = classToKhoi.get(cls) || ("Khối " + extractKhoiNumber(cls));
        if (!monHasPositiveTietChuanForKhoi(khoiName, monObj)) return;
        rows.push({
            cls,
            khoiName,
            gv: pccmNormalizeTeacherValue(pccmGetTeacher(cls, monObj)),
            sotiet: pccmGetTietDisplay(cls, monObj, khoiName),
            gioihan: pccmGetGioihanDisplay(cls, monObj, khoiName)
        });
    });

    PCCM_SUBJECT_EDIT_CACHE = { monKey: _normText(monObj.key||monObj.ten), monObj, rows };

    let mid = `
    <div class="pccm-workspace">
        <div class="table-wrap pccm-table-wrap"><table class="pccm-table pccm-list-table">
            <colgroup>
                <col class="pccm-col-tt">
                <col class="pccm-col-main pccm-col-class">
                <col class="pccm-col-main pccm-col-teacher">
                <col class="pccm-col-number">
                <col class="pccm-col-number">
            </colgroup>
            <tr>
                <th>TT</th>
                <th>Lớp học</th>
                <th>Giáo viên</th>
                <th>Số tiết</th>
                <th>Giới hạn</th>
            </tr>`;

    rows.forEach((r, idx)=>{
        const gvVal = r.gv;
        const teacherItems = gvCodes.map(code=>({code, label:code}));

        mid += `
        <tr>
            <td style="text-align:center">${idx+1}</td>
            <td ${pccmCellAttrs(idx, 0, "class")}>
                <select id="pccmS_cls_${idx}" class="inline-edit-select" data-kind="cls" onchange="pccmAutoSaveActive()">
                    ${(classNames||[]).map(c=>`<option value="${escapeHtml(c)}" ${c===r.cls?"selected":""}>${escapeHtml(c)}</option>`).join("")}
                </select>
            </td>
            <td ${pccmCellAttrs(idx, 1, "teacher")}>
                ${pccmRenderTeacherMulti(`pccmS_gv_${idx}`, gvVal, teacherItems)}
            </td>
            <td ${pccmCellAttrs(idx, 2, "periods")} style="text-align:center">
                <input id="pccmS_sotiet_${idx}" class="inline-edit-input" type="number" min="0" step="1"
                       value="${escapeHtml(r.sotiet||"")}" placeholder="trống hoặc >=0" style="text-align:center"
                       oninput="pccmAutoSaveActive()" onchange="pccmAutoSaveActive()" onblur="pccmAutoSaveActive()">
            </td>
            <td ${pccmCellAttrs(idx, 3, "limit")} style="text-align:center">
                <input id="pccmS_gioihan_${idx}" class="inline-edit-input" type="number" min="0" step="1"
                       value="${escapeHtml(r.gioihan||"")}" placeholder="trống hoặc >=0" style="text-align:center"
                       oninput="pccmAutoSaveActive()" onchange="pccmAutoSaveActive()" onblur="pccmAutoSaveActive()">
            </td>
        </tr>`;
    });

    if (!rows.length){
        mid += `<tr><td colspan="5" style="padding:14px;color:#666">Không có dữ liệu phù hợp.</td></tr>`;
    }

    mid += `</table></div></div>`;

    const right = renderPCCMQuickBox(classNames, monList);
    return `<div class="pccm-layout">${left}${mid}${right}</div>`;
}


function renderPCCM_TongHop(lops, mons){
    // mons: danh mục môn tổng hợp [{key,ten,ma,ma2}]
    const monsSorted = (mons || []).slice();

    let html = `
    <div class="table-wrap">
    <table class="pccm-table">
        <tr><th>Lớp / Môn</th>`;

    monsSorted.forEach(m => html += `<th>${renderPCCMMonHeader(m)}</th>`);
    html += `</tr>`;

    (lops||[]).forEach(l => {
        html += `<tr><td><b>${escapeHtml(l)}</b></td>`;
        monsSorted.forEach(m => {
            const val = pccmGetTeacher(l, m);
            html += `
            <td>
                <input value="${escapeHtml(val)}"
                       data-monkey="${escapeHtml(m.key||"")}"
                       data-monten="${escapeHtml(m.ten||"")}"
                       data-monma="${escapeHtml(m.ma||"")}"
                       data-monma2="${escapeHtml(m.ma2||"")}"
                       oninput="pccmSetTeacherFromInput(this,'${escapeHtml(l)}')">
            </td>`;
        });
        html += `</tr>`;
    });

    html += `</table></div>`;
    return html;
}


/* ============================================================
   XÓA TOÀN BỘ PCCM
============================================================ */


function renderPCCM_TietChuan(monRows){
    const rows = (monRows || []).map(m=>({
        id: (m.id || "").toString().trim(),
        khoi: (m.khoi || "").trim(),
        ten: (m.ten || "").trim(),
        sotiet: (m.sotiet || "").toString().trim(),
        gioihan: (m.gioihan || "").toString().trim()
    })).filter(r => r.ten && r.khoi);

    const monNames = Array.from(new Set(rows.map(r=>r.ten)));
    if (!TC_MON) TC_MON = "Tất cả";
    if (TC_MON !== "Tất cả" && !monNames.includes(TC_MON)) TC_MON = "Tất cả";

    const filtered = (TC_MON === "Tất cả") ? rows : rows.filter(r => r.ten === TC_MON);

    let mid = `
    <div style="flex:1;min-width:760px">
        <div style="display:flex;align-items:center;gap:10px;margin:6px 0 10px;flex-wrap:wrap">
            <div style="font-weight:700;font-size:20px">Tiết chuẩn</div>

            <button class="btn" onclick="triggerExcel('mon')">Nhập Excel</button>
            <button class="btn" onclick="exportExcel('mon')">Xuất Excel</button>

            <div style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-weight:700">Môn</span>
                <select onchange="setPCCMTCMon(this.value)">
                    <option value="Tất cả"${TC_MON==="Tất cả"?" selected":""}>(Chọn tất cả)</option>
                    ${monNames.map(n=>`<option value="${escapeHtml(n)}"${n===TC_MON?" selected":""}>${escapeHtml(n)}</option>`).join("")}
                </select>
            </div>
        </div>

        <div style="font-size:12px;color:#667;margin:0 0 10px;line-height:1.35">
            * Sửa trực tiếp <b>Số tiết</b> và <b>Giới hạn</b> trên bảng, dữ liệu sẽ tự lưu khi đổi ô.<br>
            * Ô trống được phép. Nếu nhập số thì phải <b>&gt; 0</b> (không âm).
        </div>

        <div class="table-wrap">
        <table>
            <tr>
                <th style="width:60px">TT</th>
                <th style="width:140px">Khối học</th>
                <th>Môn học</th>
                <th style="width:160px">Số tiết/1 tuần</th>
                <th style="width:210px">Giới hạn số tiết/1 buổi</th>
            </tr>`;

    filtered.forEach((r,i)=>{
        const rid = r.id || `${r.khoi}__${r.ten}`;
        mid += `
        <tr>
            <td style="text-align:center">${i+1}</td>
            <td>${escapeHtml(r.khoi)}</td>
            <td>${escapeHtml(r.ten)}</td>
            <td style="text-align:center">
                <input class="inline-edit-input tc-edit" type="number" min="0" step="1"
                       data-rowid="${escapeHtml(rid)}" data-field="sotiet" value="${escapeHtml(r.sotiet)}"
                       placeholder="(trống hoặc >0)" style="text-align:center"
                       onchange="tcAutoSaveEdits()" onblur="tcAutoSaveEdits()">
            </td>
            <td style="text-align:center">
                <input class="inline-edit-input tc-edit" type="number" min="0" step="1"
                       data-rowid="${escapeHtml(rid)}" data-field="gioihan" value="${escapeHtml(r.gioihan)}"
                       placeholder="(trống hoặc >0)" style="text-align:center"
                       onchange="tcAutoSaveEdits()" onblur="tcAutoSaveEdits()">
            </td>
        </tr>`;
    });

    if (!filtered.length){
        mid += `<tr><td colspan="5" style="padding:14px;color:#666">Chưa có dữ liệu tiết chuẩn.</td></tr>`;
    }

    mid += `</table></div></div>`;

    return `<div style="display:flex;gap:12px">${mid}</div>`;
}

// Lưu toàn bộ chỉnh sửa Tiết chuẩn (inline edit)
function tcSaveAllEdits(opts){
    opts = opts || {};
    const silent = !!opts.silent;
    const shouldRefresh = opts.refresh !== false;
    // Hỗ trợ 2 kiểu UI:
    // 1) input.tc-edit (cũ)
    // 2) ô text .tc-cell (mới) + input chỉ xuất hiện khi click sửa
    const byId = {};

    const cells = Array.from(document.querySelectorAll(".tc-cell[data-rowid][data-field]"));
    if (cells.length){
        cells.forEach(td=>{
            const id = (td.dataset.rowid || "").toString();
            const field = (td.dataset.field || "").toString();
            if (!id || !field) return;
            if (!byId[id]) byId[id] = {};

            // Nếu đang sửa (có input) thì lấy value từ input, ngược lại lấy từ data-val
            const inp = td.querySelector("input");
            const val = inp ? (inp.value ?? "") : (td.dataset.val ?? "");
            byId[id][field] = (val ?? "").toString().trim();
        });
    } else {
        const inputs = Array.from(document.querySelectorAll(".tc-edit"));
        if (!inputs.length) return false;
        inputs.forEach(inp=>{
            const id = (inp.dataset.rowid || "").toString();
            const field = (inp.dataset.field || "").toString();
            if (!id || !field) return;
            if (!byId[id]) byId[id] = {};
            byId[id][field] = (inp.value ?? "").toString().trim();
        });
    }

    // validate helper: empty allowed; if not empty => >0
    function _validateNumber(v){
        const s = (v ?? "").toString().trim();
        if (s === "") return { ok:true, val:"" };
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok:false };
        if (n <= 0) return { ok:false };
        // lưu dạng integer nếu là số nguyên
        const out = Number.isInteger(n) ? String(n) : String(n);
        return { ok:true, val: out };
    }

    // map id -> row in DATA.mon
    const mapIdToRow = new Map();
    (DATA.mon||[]).forEach(r=>{
        const id = (r.id || "").toString().trim();
        if (id) mapIdToRow.set(id, r);
    });

    // apply
    for (const [rid, upd] of Object.entries(byId)){
        const row = mapIdToRow.get(rid);
        if (!row) continue;

        const v1 = _validateNumber(upd.sotiet);
        const v2 = _validateNumber(upd.gioihan);
        if (!v1.ok || !v2.ok){
            const msg = `Dữ liệu không hợp lệ ở: ${row.ten} (${row.khoi}). Chỉ được để trống hoặc nhập số > 0.`;
            if (silent && typeof showBottomPopup === "function") showBottomPopup(msg, "warning");
            else alert(`⚠ ${msg}`);
            return false;
        }
        row.sotiet = v1.val;
        row.gioihan = v2.val;
    }

    saveStore();
    if (silent) return true;

    // refresh đúng màn đang mở
    const sc = document.getElementById("section-content");
    if (sc && shouldRefresh) sc.innerHTML = renderTietChuanPage();
    alert("✔ Đã lưu tiết chuẩn.");
    return true;
}

function tcAutoSaveEdits(){
    try{
        return tcSaveAllEdits({silent:true, refresh:false});
    }catch(e){
        return false;
    }
}

/* =======================
   TIẾT CHUẨN: CHỌN NHIỀU Ô + COPY/PASTE
   - Click: chọn 1 ô
   - Ctrl/Cmd + Click: thêm/bớt ô
   - Shift + Click: chọn theo vùng (rect)
   - Ctrl/Cmd + C: copy (TSV)
   - Ctrl/Cmd + V: paste (TSV) vào ô đang chọn
======================= */

function tcIsActive(){
    return !!document.querySelector(".tc-cell[data-r][data-c]");
}

function tcKey(r,c){
    return `${Number(r)},${Number(c)}`;
}

function tcGetCell(r,c){
    return document.querySelector(`.tc-cell[data-r="${Number(r)}"][data-c="${Number(c)}"]`);
}

function tcGetCellValue(td){
    if(!td) return "";
    const inp = td.querySelector("input");
    if(inp) return (inp.value ?? "").toString();
    // ưu tiên data-val để đồng bộ với cơ chế Lưu
    return (td.dataset.val ?? td.textContent ?? "").toString();
}

function tcSetCellValue(td, v){
    if(!td) return;
    const val = (v ?? "").toString().trim();
    const inp = td.querySelector("input");
    if(inp) inp.value = val;
    td.dataset.val = val;
    if(!inp) td.textContent = val;
}

function tcUpdateSelectionUI(){
    const cells = Array.from(document.querySelectorAll(".tc-cell[data-r][data-c]"));
    if(!cells.length) return;
    cells.forEach(td=>{
        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        const k = tcKey(r,c);
        td.classList.toggle("tc-selected", TC_CELL_SELECTION.has(k));
        td.classList.toggle("tc-anchor", !!TC_CELL_ANCHOR && Number(td.dataset.r) === Number(TC_CELL_ANCHOR.r) && Number(td.dataset.c) === Number(TC_CELL_ANCHOR.c));
    });
}

function tcResetSelection(){
    TC_CELL_SELECTION = new Set();
    TC_CELL_ANCHOR = null;
    TC_CELL_DRAGGING = false;
    TC_CELL_DRAG_START = null;
    TC_CELL_DRAG_MOVED = false;
}

function tcCommitActiveEditor(exceptTd){
    try{
        const ownInput = exceptTd?.querySelector?.("input.tc-edit, input.inline-edit-input");
        let active = document.activeElement;
        if(!active || !active.matches?.("input.tc-edit, input.inline-edit-input")){
            active = document.querySelector?.(".tc-cell input.tc-edit, .tc-cell input.inline-edit-input");
        }
        if(active && active !== ownInput) active.blur?.();
    }catch(_){
        // A missing activeElement in an embedded/legacy browser must not block
        // selecting another cell.
    }
}

function tcClearSelection(){
    tcResetSelection();
    tcUpdateSelectionUI();
}

function tcSetSingleSelection(r,c){
    TC_CELL_SELECTION = new Set([tcKey(r,c)]);
    TC_CELL_ANCHOR = {r:Number(r), c:Number(c)};
    tcUpdateSelectionUI();
}

function tcToggleSelection(r,c){
    const k = tcKey(r,c);
    if(TC_CELL_SELECTION.has(k)) TC_CELL_SELECTION.delete(k);
    else TC_CELL_SELECTION.add(k);
    TC_CELL_ANCHOR = {r:Number(r), c:Number(c)};
    tcUpdateSelectionUI();
}

function tcSelectRange(a, b, keepAnchor){
    const r1 = Math.min(Number(a?.r), Number(b?.r));
    const r2 = Math.max(Number(a?.r), Number(b?.r));
    const c1 = Math.min(Number(a?.c), Number(b?.c));
    const c2 = Math.max(Number(a?.c), Number(b?.c));
    const next = new Set();
    for(let r=r1; r<=r2; r++){
        for(let c=c1; c<=c2; c++){
            if(tcGetCell(r,c)) next.add(tcKey(r,c));
        }
    }
    TC_CELL_SELECTION = next;
    if(!keepAnchor) TC_CELL_ANCHOR = {r:Number(b?.r), c:Number(b?.c)};
    tcUpdateSelectionUI();
}

function tcCellMouseDown(ev, td){
    try{
        if(!ev || !td) return;
        if(ev.button !== 0) return;
        if(td.querySelector("input")) return;

        // Commit the previous cell before moving focus. Otherwise the old
        // editor keeps keyboard focus and a digit typed for the new cell is
        // silently sent to the previous row.
        tcCommitActiveEditor(td);

        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        if(!Number.isFinite(r) || !Number.isFinite(c)) return;

        if(ev.shiftKey && TC_CELL_ANCHOR){
            tcSelectRange(TC_CELL_ANCHOR, {r,c});
        } else if(ev.ctrlKey || ev.metaKey){
            tcToggleSelection(r,c);
        } else {
            tcSetSingleSelection(r,c);
        }

        TC_CELL_DRAGGING = true;
        TC_CELL_DRAG_START = {r,c};
        TC_CELL_DRAG_MOVED = false;
        // Keep the click as a pure spreadsheet selection. Explicit editing is
        // still available through double-click, Enter, or F2.
        ev.preventDefault();
    }catch(e){
        // ignore
    }
}

function tcCellMouseOver(ev, td){
    try{
        if(!TC_CELL_DRAGGING || !TC_CELL_DRAG_START || !td) return;
        if(td.querySelector("input")) return;

        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        if(!Number.isFinite(r) || !Number.isFinite(c)) return;

        if(Number(TC_CELL_DRAG_START.r) !== r || Number(TC_CELL_DRAG_START.c) !== c){
            TC_CELL_DRAG_MOVED = true;
        }
        tcSelectRange(TC_CELL_DRAG_START, {r,c}, true);
        if(ev) ev.preventDefault();
    }catch(e){
        // ignore
    }
}

// Một click/chạm chỉ chọn ô, không tự mở trình sửa số.
function tcCellClick(ev, td){
    try{
        if(!ev || !td) return;
        // Nếu đang sửa (có input) thì để người dùng thao tác trong input
        if(td.querySelector("input")) return;

        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        if(!Number.isFinite(r) || !Number.isFinite(c)) return;

        const isCmd = !!(ev.ctrlKey || ev.metaKey);
        const isShift = !!ev.shiftKey;

        if(isShift || isCmd || TC_CELL_DRAG_MOVED || TC_CELL_SELECTION.size !== 1){
            TC_CELL_DRAG_MOVED = false;
            ev.preventDefault();
            return;
        }
        if(!TC_CELL_SELECTION.has(tcKey(r,c))){
            tcSetSingleSelection(r,c);
        }
        ev.preventDefault();
    }catch(e){
        // ignore
    }
}

function tcGetSelectionRect(){
    if(!TC_CELL_SELECTION || TC_CELL_SELECTION.size === 0) return null;
    let minR = 1e9, maxR = -1e9, minC = 1e9, maxC = -1e9;
    for(const k of TC_CELL_SELECTION){
        const [r,c] = (k||"").split(",").map(Number);
        if(!Number.isFinite(r) || !Number.isFinite(c)) continue;
        if(r < minR) minR = r;
        if(r > maxR) maxR = r;
        if(c < minC) minC = c;
        if(c > maxC) maxC = c;
    }
    if(minR > maxR || minC > maxC) return null;
    return {minR, maxR, minC, maxC};
}

function tcBuildCopyText(){
    const rect = tcGetSelectionRect();
    if(!rect) return "";
    const lines = [];
    for(let r=rect.minR; r<=rect.maxR; r++){
        const row = [];
        for(let c=rect.minC; c<=rect.maxC; c++){
            const k = tcKey(r,c);
            const td = tcGetCell(r,c);
            const v = (td && TC_CELL_SELECTION.has(k)) ? tcGetCellValue(td) : "";
            row.push((v ?? "").toString());
        }
        lines.push(row.join("\t"));
    }
    return lines.join("\n");
}

function tcFallbackCopy(text){
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly","readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); }catch(e){ /* ignore */ }
    ta.remove();
}

function tcCopySelectionToClipboard(){
    try{
        const text = tcBuildCopyText();
        if(!text) return;
        if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(text).catch(()=>tcFallbackCopy(text));
        } else {
            tcFallbackCopy(text);
        }
    }catch(e){
        // ignore
    }
}

function tcParseClipboard(text){
    let t = (text ?? "").toString();
    t = t.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
    // bỏ dòng trống cuối (Excel hay thêm)
    while(t.endsWith("\n")) t = t.slice(0,-1);
    if(!t) return [];
    const rows = t.split("\n").map(line=> line.split("\t"));
    return rows;
}

function tcPasteMatrix(matrix){
    const rect = tcGetSelectionRect();
    if(!rect) return;
    if(!Array.isArray(matrix) || !matrix.length) return;

    // Nếu clipboard chỉ có 1 giá trị -> dán vào tất cả ô đang chọn
    if(matrix.length === 1 && (matrix[0]||[]).length === 1 && TC_CELL_SELECTION.size > 1){
        const v = (matrix[0][0] ?? "").toString().trim();
        for(const k of TC_CELL_SELECTION){
            const [r,c] = (k||"").split(",").map(Number);
            const td = tcGetCell(r,c);
            if(td) tcSetCellValue(td, v);
        }
        tcAutoSaveEdits();
        return;
    }

    const startR = rect.minR;
    const startC = rect.minC;
    for(let i=0;i<matrix.length;i++){
        const row = matrix[i] || [];
        for(let j=0;j<row.length;j++){
            const td = tcGetCell(startR+i, startC+j);
            if(!td) continue;
            tcSetCellValue(td, (row[j] ?? "").toString());
        }
    }
    tcAutoSaveEdits();
}

function tcClearSelectedCells(){
    for(const k of TC_CELL_SELECTION){
        const [r,c] = (k||"").split(",").map(Number);
        const td = tcGetCell(r,c);
        if(td) tcSetCellValue(td, "");
    }
    tcAutoSaveEdits();
}

function tcSelectedNumericCell(){
    if(TC_CELL_ANCHOR){
        const anchor = tcGetCell(TC_CELL_ANCHOR.r, TC_CELL_ANCHOR.c);
        if(anchor) return anchor;
    }
    for(const key of (TC_CELL_SELECTION || [])){
        const [r,c] = String(key || "").split(",").map(Number);
        const td = tcGetCell(r,c);
        if(td) return td;
    }
    return null;
}

function tcBeginSelectedNumericEdit(initialValue){
    const td = tcSelectedNumericCell();
    if(!td) return false;
    tcBeginCellEdit(td, initialValue);
    return !!td.querySelector("input.inline-edit-input");
}

function tcSetSelectedNumericValue(value){
    const td = tcSelectedNumericCell();
    if(!td) return false;
    tcSetCellValue(td, value);
    tcAutoSaveEdits();
    tcUpdateSelectionUI();
    return true;
}

// Lắng nghe Ctrl/Cmd+C và Delete/Backspace (toàn trang)
function tcGlobalKeyDown(ev){
    try{
        if(!tcIsActive()) return;
        if(!TC_CELL_SELECTION || TC_CELL_SELECTION.size === 0) return;

        const tag = (ev?.target?.tagName || "").toUpperCase();
        const isTyping = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");

        const isCmd = !!(ev.ctrlKey || ev.metaKey);
        const key = (ev.key || "").toLowerCase();

        if(isCmd && key === "c"){
            // nếu đang gõ trong input -> để copy bình thường
            if(isTyping) return;
            ev.preventDefault();
            tcCopySelectionToClipboard();
            return;
        }

        if(key === "escape"){
            if(isTyping) return;
            tcClearSelection();
            return;
        }

        // Typing a digit updates and saves the selected Tiết chuẩn cell
        // directly; the cell remains selected and no editor is opened.
        if(!isTyping && !isCmd && !ev.altKey && /^[0-9]$/.test(String(ev.key || ""))){
            if(tcSetSelectedNumericValue(ev.key)){
                ev.preventDefault();
                return;
            }
        }
        if(!isTyping && !isCmd && !ev.altKey && (key === "enter" || key === "f2")){
            if(tcBeginSelectedNumericEdit()){
                ev.preventDefault();
                return;
            }
        }

        if((key === "delete" || key === "backspace") && !isTyping){
            ev.preventDefault();
            tcClearSelectedCells();
            tcUpdateSelectionUI();
            return;
        }
    }catch(e){
        // ignore
    }
}

// Lắng nghe paste (Ctrl/Cmd+V) để dán vào bảng Tiết chuẩn
function tcGlobalPaste(ev){
    try{
        if(!tcIsActive()) return;
        if(!TC_CELL_SELECTION || TC_CELL_SELECTION.size === 0) return;

        const tag = (ev?.target?.tagName || "").toUpperCase();
        const isTyping = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
        if(isTyping) return; // để paste vào input bình thường

        const text = (ev.clipboardData || window.clipboardData)?.getData("text");
        if(typeof text !== "string") return;

        const matrix = tcParseClipboard(text);
        if(!matrix.length) return;

        ev.preventDefault();
        tcPasteMatrix(matrix);
        tcUpdateSelectionUI();
    }catch(e){
        // ignore
    }
}

// Tiết chuẩn: click vào ô để sửa (input chỉ xuất hiện khi cần)
function tcBeginCellEdit(td, initialValue){
    try{
        if (!td) return;
        if (td.querySelector("input")) return; // đang sửa

        const rowid = (td.dataset.rowid || "").toString();
        const field = (td.dataset.field || "").toString();
        const cur = (td.dataset.val ?? td.textContent ?? "").toString().trim();
        if (!rowid || !field) return;

        td.innerHTML = `<input class="inline-edit-input tc-edit" type="number" min="0" step="1"
                            data-rowid="${escapeHtml(rowid)}" data-field="${escapeHtml(field)}"
                            value="${escapeHtml(cur)}" style="text-align:center">`;
        const inp = td.querySelector("input");
        if (!inp) return;
        if(initialValue !== undefined && initialValue !== null){
            inp.value = String(initialValue);
        }
        inp.focus();
        if(initialValue === undefined || initialValue === null){
            inp.select();
        }else{
            try{
                const end = inp.value.length;
                inp.setSelectionRange?.(end, end);
            }catch(_){ }
        }

        inp.onkeydown = (ev)=>{
            const k = (ev.key || "");
            if (k === "Enter"){
                ev.preventDefault();
                inp.blur();
            }
            if (k === "Escape"){
                ev.preventDefault();
                inp.value = cur;
                inp.blur();
            }
        };

        inp.onblur = ()=>{
            const v = (inp.value ?? "").toString().trim();
            td.dataset.val = v;
            td.innerHTML = escapeHtml(v);
            tcAutoSaveEdits();
        };
    }catch(e){
        // ignore
    }
}

function tcQuickUpsert(){
    const khoi = _normText(document.getElementById("tc_khoi")?.value || "");
    const ten = _normText(document.getElementById("tc_mon")?.value || "");
    const sotiet = _normText(document.getElementById("tc_sotiet")?.value || "");
    const gioihan = _normText(document.getElementById("tc_gioihan")?.value || "");
    if (!khoi || !ten || !sotiet) return alert("⚠ Cần có Khối + Môn + Số tiết/tuần.");

    const existing = (DATA.mon||[]).find(m => _normText(m.khoi)===khoi && _normText(m.ten)===ten);
    if (existing){
        existing.sotiet = sotiet;
        existing.gioihan = gioihan;
    } else {
        DATA.mon.push({ id:autoID("mon"), khoi, ten, sotiet, gioihan });
    }
    saveStore();
    pccmRenderCurrent("section-content");
}

function tcDelete(khoi, ten){
    khoi = _normText(khoi);
    ten = _normText(ten);
    if (!khoi || !ten) return;

    if (!confirm(`Xóa tiết chuẩn: ${ten} (${khoi}) ?`)) return;

    // 1) Xóa khỏi DATA.mon (tiết chuẩn)
    DATA.mon = (DATA.mon || []).filter(m => !(_normText(m.khoi)===khoi && _normText(m.ten)===ten));

    // 2) Xóa phân công PCCM liên quan: chỉ trong các lớp thuộc khối đó
    const khoiNum = extractKhoiNumber(khoi);
    const shouldRemoveKey = (key)=>{
        if (!key.includes("|")) return false;
        const [lopCanon, monTen] = key.split("|");
        if (_normText(monTen) !== ten) return false;
        // lopCanon dạng 6A1/10A1..., khối lấy số đầu
        return extractKhoiNumber(lopCanon) === khoiNum;
    };

    for (const key in (DATA.pccmMatrix || {})){
        if (shouldRemoveKey(key)) delete DATA.pccmMatrix[key];
    }
    for (const key in (DATA.pccmRoomMatrix || {})){
        if (shouldRemoveKey(key)) delete DATA.pccmRoomMatrix[key];
    }

    saveStore();

    // refresh đúng màn đang mở (PCCM hoặc Tiết chuẩn)
    const sc = document.getElementById("section-content");
    if (sc) {
        const html = (sc.innerHTML || "");
        if (html.includes("PCCM") && typeof renderPCCM === "function") {
            pccmRenderCurrent(sc);
        } else if (typeof renderTietChuanPage === "function") {
            sc.innerHTML = renderTietChuanPage();
        }
    }
}



function deleteAllPCCM(){
    if (!confirm("⚠ Bạn có chắc muốn XÓA TOÀN BỘ PCCM?")) return;

    DATA.pccmMatrix = {};
    DATA.pccmRoomMatrix = {};
    DATA.pccmTietMatrix = {};
    DATA.pccmGioihanMatrix = {};
    saveStore();

    pccmRenderCurrent("section-content");
    alert("✔ Đã xóa sạch PCCM");
}

/* ============================================================
   UPDATE Ô PCCM
============================================================ */
function updatePCCMCell(el){
    // giữ tương thích với UI cũ (ma trận tổng hợp)
    let lop = el.dataset.lop;
    let mon = el.dataset.mon;
    setPCCMTeacher(lop, mon, el.value);
}

/* ============================================================
   TRIGGER IMPORT PCCM
============================================================ */

function mapPCCMMonNameByCode(monRaw){
    const m = _normText(monRaw);
    if (!m) return "";
    const low = m.toLowerCase();
    const found = (DATA.monhoc || []).find(r=>{
        const ten = _normText(r.ten).toLowerCase();
        const ma  = _normText(r.ma).toLowerCase();
        const ma2 = _normText(r.ma2).toLowerCase();
        return (ten && ten === low) || (ma && ma === low) || (ma2 && ma2 === low);
    });
    if (!found) return m;

    const ten = _normText(found.ten);
    const ma  = _normText(found.ma);
    const ma2 = _normText(found.ma2);
    const fields = [ten, ma, ma2].filter(Boolean);

    function looksLikeCode(s){
        s = _normText(s);
        if (!s) return false;
        const hasNonASCII = /[^\x00-\x7F]/.test(s);
        const hasSpace = /\s/.test(s);
        if (hasNonASCII || hasSpace) return false;
        return s.length <= 12;
    }

    const displayName = _normText(fields.find(x=>!looksLikeCode(x)) || ten || ma || ma2 || m);
    return displayName || m;
}

function triggerPCCMImport(){
    IS_PCCM_IMPORT = true;
    document.getElementById("excelFile").click();
}

/* ============================================================
   IMPORT PCCM EXCEL — AUTO FIX LỖI + BỔ SUNG LỚP/MÔN
============================================================ */

async function importPCCMFromExcel(wb){
    // Hỗ trợ 2 dạng:
    // (A) Dạng ma trận (như file pccm.xlsx): hàng 1 là mã/tên môn, cột A là lớp, các ô là GV
    // (B) Dạng 3 cột: Lớp | Môn học | Giáo viên
    const preferSheet = (wb.SheetNames||[]).includes("M3") ? "M3" : (wb.SheetNames||[])[0];
    const sheet = wb.Sheets[preferSheet];
    if (!sheet){
        alert("❌ Không tìm thấy sheet để nhập PCCM.");
        return;
    }

    const rows = XLSX.utils.sheet_to_json(sheet,{header:1,defval:""});
    if (!rows || !rows.length){
        alert("❌ Sheet rỗng.");
        return;
    }

    const yieldImportUi = ()=>new Promise(resolve=>{
        if(typeof requestAnimationFrame === "function") requestAnimationFrame(()=>setTimeout(resolve, 0));
        else setTimeout(resolve, 0);
    });
    let importedAssignments = 0;

    // helpers
    function looksLikeCode(s){
        s = _normText(s);
        if (!s) return false;
        const hasNonASCII = /[^\x00-\x7F]/.test(s);
        const hasSpace = /\s/.test(s);
        if (hasNonASCII || hasSpace) return false;
        return s.length <= 12;
    }

    function resolveMon(monHeader){
        const raw = _normText(monHeader);
        if (!raw) return null;
        const low = raw.toLowerCase();

        let found = (DATA.monhoc || []).find(r=>{
            const ten = _normText(r.ten).toLowerCase();
            const ma  = _normText(r.ma).toLowerCase();
            const ma2 = _normText(r.ma2).toLowerCase();
            return (ten && ten === low) || (ma && ma === low) || (ma2 && ma2 === low);
        });

        if (!found){
            // không có trong danh mục môn => dùng raw làm cả tên lẫn key
            return { key: raw, ten: raw, code: looksLikeCode(raw) ? raw : "" };
        }

        const ten = _normText(found.ten);
        const ma  = _normText(found.ma);
        const ma2 = _normText(found.ma2);
        const fields = [ten, ma, ma2].filter(Boolean);

        const displayName = _normText(fields.find(x=>!looksLikeCode(x)) || ten || ma || ma2 || raw) || raw;
        const code = _normText(fields.find(x=>looksLikeCode(x)) || ma || ma2 || "") || (looksLikeCode(raw) ? raw : "");
        const key = code || displayName; // KEY lưu PCCM ưu tiên mã
        return { key, ten: displayName, code, ma, ma2 };
    }

    function canonLop(x){
        const raw = String(x||"").trim();
        if (!raw) return "";
        const aliases = legacyClassNameAliases(raw);
        for(const lop of (DATA.lop || [])){
            const own = legacyClassNameAliases(classCanonFromLop(lop))
                .concat(legacyClassNameAliases(lop?.ten2 || ""))
                .concat(legacyClassNameAliases(lop?.id || ""));
            if(aliases.some(a => own.includes(a))) return classCanonFromLop(lop);
        }
        return normalizeClassName(raw) || raw;
    }

    // Import có thể chứa hàng nghìn ô.  Chuẩn bị index lớp một lần để không
    // quét toàn bộ DATA.lop cho từng ô Excel.
    const importClassCanonByAlias = new Map();
    (DATA.lop || []).forEach(lop=>{
        const canon = classCanonFromLop(lop);
        if(!canon) return;
        const aliases = legacyClassNameAliases(canon)
            .concat(legacyClassNameAliases(lop?.ten2 || ""))
            .concat(legacyClassNameAliases(lop?.id || ""));
        aliases.forEach(alias=>{
            const key = String(alias || "").trim().toLowerCase();
            if(key && !importClassCanonByAlias.has(key)) importClassCanonByAlias.set(key, canon);
        });
    });
    const canonLopFast = (value)=>{
        const raw = String(value || "").trim();
        if(!raw) return "";
        for(const alias of legacyClassNameAliases(raw)){
            const found = importClassCanonByAlias.get(String(alias || "").trim().toLowerCase());
            if(found) return found;
        }
        return normalizeClassName(raw) || raw;
    };

    // ---- Detect long format (3 columns) ----
    // Nếu hàng đầu có chứa "Lớp" và "Môn" => long format
    const header0 = rows[0].map(x=>String(x||"").trim().toLowerCase());
    const hasLop = header0.some(x=>x==="lớp" || x==="lop" || x==="tên lớp" || x==="ten lop");
    const hasMon = header0.some(x=>x==="môn học" || x==="mon hoc" || x==="môn" || x==="mon");
    const hasGV  = header0.some(x=>x==="giáo viên" || x==="giao vien" || x==="gv");

    if (hasLop && hasMon && hasGV){
        const objs = XLSX.utils.sheet_to_json(sheet,{defval:""});
        for(let rowIndex = 0; rowIndex < objs.length; rowIndex++){
            const r = objs[rowIndex];
            const lop = canonLopFast(r["Lớp"] || r["lop"] || r["Tên lớp"] || r["ten lop"] || "");
            const mon = resolveMon(r["Môn học"] || r["Mon hoc"] || r["Môn"] || r["Mon"] || "");
            const gv  = _normText(r["Giáo viên"] || r["Giao vien"] || r["GV"] || r["gv"] || "");
            if (lop && mon && gv){
                pccmSetTeachersNoSave(lop, mon, gv);
                importedAssignments++;
            }
            if(rowIndex > 0 && rowIndex % 120 === 0) await yieldImportUi();
        }
        const saved = await saveStore();
        if(saved === false) throw new Error("Không thể đồng bộ dữ liệu Phân công lên máy chủ.");
        alert(`✔ Đã nhập PCCM từ Excel (dạng 3 cột): ${importedAssignments} phân công.`);
        const sc = document.getElementById("section-content");
        if (sc && typeof renderPCCM === "function") pccmRenderCurrent(sc);
        return;
    }

    // ---- Matrix format ----
    // tìm dòng header: dòng đầu tiên có ít nhất 3 ô có dữ liệu
    let headerRow = 0;
    for (let i=0;i<Math.min(rows.length,10);i++){
        const nonEmpty = rows[i].filter(x=>String(x||"").trim()!=="").length;
        if (nonEmpty >= 3){
            headerRow = i; break;
        }
    }

    const header = rows[headerRow].map(x=>String(x||"").trim());
    const monHeaders = header.slice(1); // bỏ cột lớp (* / Lớp)

    const monObjs = monHeaders.map(h=>resolveMon(h));

    for (let i=headerRow+1;i<rows.length;i++){
        const line = rows[i];
        if (!line || !line.length) continue;

        const lop = canonLopFast(line[0]);
        if (!lop) continue;

        for (let j=0;j<monObjs.length;j++){
            const mon = monObjs[j];
            if (!mon) continue;
            const gv = _normText(line[j+1] || "");
            if (gv){
                pccmSetTeachersNoSave(lop, mon, gv);
                importedAssignments++;
            }
        }
        if(i > headerRow + 1 && (i - headerRow) % 30 === 0) await yieldImportUi();
    }

    const saved = await saveStore();
    if(saved === false) throw new Error("Không thể đồng bộ dữ liệu Phân công lên máy chủ.");
    alert(`✔ Đã nhập PCCM từ Excel (dạng ma trận): ${importedAssignments} phân công.`);
    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function") pccmRenderCurrent(sc);
}

/* ============================================================
   EXPORT PCCM
============================================================ */

function excelTeacherCodesForValidation(){
    const seen = new Set();
    const out = [];
    const add = (value)=>{
        const code = resolveTeacherCode(_normText(value));
        if(!code) return;
        const key = code.toLowerCase();
        if(seen.has(key)) return;
        seen.add(key);
        out.push(code);
    };
    (DATA.giaovien || []).forEach(g=>add(g?.magv));
    Object.values(DATA.pccmMatrix || {}).forEach(v=>pccmTeacherListFromValue(v).forEach(add));
    return out.sort((a,b)=>a.localeCompare(b,'vi',{numeric:true,sensitivity:'base'}));
}

function excelUniqueSheetName(wb, base){
    const used = new Set((wb.SheetNames || []).map(n=>String(n).toLowerCase()));
    let name = String(base || "DanhMuc").slice(0, 31);
    if(!used.has(name.toLowerCase())) return name;
    for(let i=2;i<100;i++){
        const suffix = `_${i}`;
        name = `${String(base || "DanhMuc").slice(0, 31 - suffix.length)}${suffix}`;
        if(!used.has(name.toLowerCase())) return name;
    }
    return `DanhMuc_${Date.now()}`.slice(0,31);
}

function excelQuoteSheetName(name){
    return `'${String(name || '').replace(/'/g, "''")}'`;
}

function excelHideSheet(wb, name){
    const idx = (wb.SheetNames || []).indexOf(name);
    if(idx < 0) return;
    wb.Workbook = wb.Workbook || {};
    wb.Workbook.Sheets = wb.Workbook.Sheets || wb.SheetNames.map(n=>({name:n}));
    wb.Workbook.Sheets[idx] = wb.Workbook.Sheets[idx] || {name};
    wb.Workbook.Sheets[idx].Hidden = 1;
}

function excelAppendTeacherValidationSheet(wb, teacherCodes){
    const codes = Array.isArray(teacherCodes) ? teacherCodes.filter(Boolean) : [];
    if(!codes.length) return "";
    const sheetName = excelUniqueSheetName(wb, "DanhMucGV");
    const rows = [["MaGV"], ...codes.map(code=>[code])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    try{
        window.TKBExcelStyle?.styleSheet(ws, rows, {
            widths: [{wch: 18}],
            headerRows: [0],
            bodyRowHeight: 20,
            maxWidth: 18,
            centerAll: true
        });
    }catch(e){
        console.warn("excelAppendTeacherValidationSheet style failed", e);
    }
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    excelHideSheet(wb, sheetName);
    return `${excelQuoteSheetName(sheetName)}!$A$2:$A$${codes.length + 1}`;
}

async function exportPCCMExcel(){
    // Xuất theo khối đang chọn; nếu "Tất cả" thì xuất toàn bộ
    const lopObjs = (DATA.lop || []).map(l=>{
        const canon = classCanonFromLop(l);
        const khoi = (l.khoi || ("Khối " + extractKhoiNumber(canon))).trim();
        return { canon, khoi };
    }).filter(x=>x.canon);

    const lops = (PCCM_KHOI === "Tất cả")
        ? lopObjs.map(x=>x.canon)
        : lopObjs.filter(x=>extractKhoiNumber(x.khoi)===extractKhoiNumber(PCCM_KHOI)).map(x=>x.canon);

    const monList = buildPCCMMonList();
    const headerMons = monList.map(m=>pccmSubjectCode(m) || m.key || m.ten);

    let rows = [];
    rows.push(["Lớp / Môn", ...headerMons]);

    lops.forEach(l=>{
        let line = [l];
        monList.forEach(m=>{
            line.push(pccmGetTeacher(l,m) || "");
        });
        rows.push(line);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    let widths = [];

    // set độ rộng cột cho file PCCM (tránh các cột bằng nhau)
    try{
        const colCount = rows.reduce((m, r)=>Math.max(m, (r||[]).length), 0);
        widths = Array.from({length: colCount}).map(()=>({ wch: 12 }));
        ws["!cols"] = widths;
    }catch(e){
        console.warn("exportPCCMExcel set column widths failed", e);
    }
    try{
        window.TKBExcelStyle?.styleSheet(ws, rows, {
            widths,
            headerRows: [0],
            freeze: { xSplit: 1, ySplit: 1 },
            filterRow: 0,
            bodyRowHeight: 22,
            centerAll: true,
            maxWidth: 12
        });
    }catch(e){
        console.warn("exportPCCMExcel style failed", e);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "PCCM");

    const dataValidations = [];
    const teacherCodes = excelTeacherCodesForValidation();
    const formula1 = excelAppendTeacherValidationSheet(wb, teacherCodes);
    if(formula1 && rows.length > 1 && monList.length){
        dataValidations.push({
            sheetName: "PCCM",
            range: XLSX.utils.encode_range({
                s: { r: 1, c: 1 },
                e: { r: Math.max(1, rows.length - 1), c: monList.length }
            }),
            formula1
        });
    }

    try{
        if(window.TKBExcelStyle?.writeFile){
            await window.TKBExcelStyle.writeFile(wb, "PCCM.xlsx", { dataValidations });
        }else{
            XLSX.writeFile(wb, "PCCM.xlsx", { compression: true, cellStyles: true });
        }
    }catch(e){
        console.error("exportPCCMExcel write failed", e);
        alert(`❌ Xuất Excel thất bại: ${e?.message || e}`);
    }
}



/* ============================================================
   ==========  PART 4 / 4 — TIỆN ÍCH & HOÀN TẤT FILE ==========
============================================================ */

/* ============================================================
   XÓA SẠCH TOÀN BỘ DỮ LIỆU
============================================================ */
function clearAllData(){
    if (!confirm("⚠ Bạn có chắc muốn XÓA SẠCH toàn bộ dữ liệu?")) return;

    const sid = CTX.schoolId || getSchoolId();

    // Xóa backup localStorage của trường hiện tại
    try{ localStorage.removeItem(_lsKey(sid)); }catch(e){}

    // Xóa dữ liệu trong KVDB của trường hiện tại (nếu có)
    try{
        if (__kv) __kv.set("DATA_JSON", "{}");
    }catch(e){}

    try{
        if(window.TKBStorage && window.TKBStorage.saveRemoteSchoolData){
            window.TKBStorage.saveRemoteSchoolData(sid, "{}").catch(()=>{});
        }
    }catch(e){}

    location.reload();
}


/* ============================================================
   TẠO ID TỰ ĐỘNG (K001 / L001 / M001…)
============================================================ */
function autoID(section){
    const map = { khoi:"K", lop:"L", giaovien:"GV", monhoc:"MH", mon:"M", phong:"P" };
    let prefix = map[section] || "X";

    if (!DATA || typeof DATA !== "object") DATA = {};
    if (!Array.isArray(DATA[section])) DATA[section] = [];

    let max = 0;
    DATA[section].forEach(item=>{
        const m = (item.id || "").match(/(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1],10));
    });

    return prefix + String(max+1).padStart(3,"0");
}


/* ============================================================
   REFRESH VIEW SAU KHI LƯU / IMPORT
============================================================ */
function refreshView(section){
    renderSectionInto(section, "section-content", document);
}

function afterDataChanged(section){
    saveStore();
    refreshView(section);
}


/* ============================================================
   ĐIỀU HƯỚNG VỀ TRANG CHÍNH
============================================================ */
function backToMain(){
    window.location.href = "/";
}


/* ============================================================
   HIỂN THỊ GỢI Ý BẢNG TRỐNG
============================================================ */
function renderEmptyMessage(text){
    return `
        <div style="padding:20px; text-align:center; color:#777;">
            ${text}
        </div>
    `;
}


/* ============================================================
   UTILS
============================================================ */
function isEmptyObject(obj){
    return Object.keys(obj).length === 0;
}

function debug(...args){
    // Bật lên khi cần:
    // console.log("[DEBUG]", ...args);
}

function showBottomPopup(message, type="info"){
    const text = (message == null ? "" : String(message)).trim();
    if(!text) return;
    let toast = document.getElementById("appBottomPopup");
    if(!toast){
        toast = document.createElement("div");
        toast.id = "appBottomPopup";
        document.body.appendChild(toast);
    }
    const bg = type === "warning" ? "#8a4b00" : (type === "error" ? "#a8071a" : (type === "ok" ? "#1f6f43" : "#172033"));
    toast.className = "app-bottom-popup " + (type || "info");
    toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:22px",
        "transform:translate(-50%,16px)",
        "z-index:10050",
        "min-width:min(420px,calc(100vw - 32px))",
        "max-width:calc(100vw - 32px)",
        "padding:10px 14px",
        "border-radius:8px",
        `background:${bg}`,
        "color:#fff",
        "box-shadow:0 10px 28px rgba(23,32,51,.28)",
        "font-size:13px",
        "line-height:1.4",
        "text-align:center",
        "opacity:0",
        "pointer-events:none",
        "transition:opacity .18s ease, transform .18s ease"
    ].join(";");
    toast.textContent = text;
    toast.classList.remove("show");
    window.clearTimeout(toast.__hideTimer);
    requestAnimationFrame(()=>{
        toast.classList.add("show");
        toast.style.opacity = "1";
        toast.style.transform = "translate(-50%,0)";
    });
    toast.__hideTimer = window.setTimeout(()=>{
        toast.classList.remove("show");
        toast.style.opacity = "0";
        toast.style.transform = "translate(-50%,16px)";
    }, 3200);
}

window.showBottomPopup = showBottomPopup;
/* ============================================================
   XÓA TOÀN BỘ DỮ LIỆU RIÊNG CỦA MỤC (Khối / Lớp / Môn ...)
============================================================ */
function deleteSection(section){
    if (!confirm("⚠ Bạn có chắc muốn XÓA toàn bộ dữ liệu mục: " + section.toUpperCase() + " ?"))
        return;

    DATA[section] = [];

    // Nếu xóa lớp → phải xóa TKB tương ứng
    if (section === "lop") DATA.tkb = {};

    // Đồng bộ liên kết sau khi xoá mục dữ liệu (tránh tình trạng xoá Môn/Lớp/GV nhưng phân công/tiết chuẩn còn)
    try{ syncDerivedDataIntegrity(); }catch(e){ console.warn("syncDerivedDataIntegrity failed", e); }

    saveStore();

    const sc = document.getElementById("section-content");
    if (sc && typeof renderPCCM === "function" && sc.innerHTML && sc.innerHTML.includes("PCCM")) {
        pccmRenderCurrent(sc);
    } else {
        renderSectionInto(section, "section-content", document);
    }

    alert("✔ Đã xóa sạch dữ liệu mục: " + section.toUpperCase());
}



/* ============================================================
   THÔNG BÁO HOÀN TẤT
============================================================ */
debug("✔ app.js đã tải thành công (PART 1 → PART 4)");

/* ============================================================
   SCHOOL SWITCHER (Facebook-like)
============================================================ */
function getSchoolList(){
  return JSON.parse(localStorage.getItem("TKB_SCHOOL_LIST") || "[]");
}
function _isSuperAdmin(){
  try{
    const ctx = window.TKBAuth && window.TKBAuth.currentUser();
    return !!(ctx && ctx.user && ctx.user.role === "superadmin");
  }catch(_){ return false; }
}
function addSchoolToList(sid){
  sid = _sanitizeSchoolId(sid);
  if(!sid) return;
  const list = [];
  getSchoolList().forEach(item=>{
    const clean = _sanitizeSchoolId(item);
    if(clean && !list.includes(clean)) list.push(clean);
  });
  if(!list.includes(sid)) list.push(sid);
  localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(list));
}

function _jsString(value){
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function _scheduleDisplayLabel(entry){
  if(!entry) return "Chưa có TKB";
  const raw = String(entry.label || entry.number || "").trim();
  return raw ? `TKB ${raw}` : "TKB hiện hành";
}

function _activeScheduleEntryForDisplay(school){
  if(!school) return null;
  const list = Array.isArray(school.schedules) ? school.schedules : [];
  const want = Number(school.activeSchedule);
  const found = list.find(s => Number(s.number) === want) || list.find(s => s && s.original) || list[0];
  if(found) return found;
  if(window.TKBAuth && window.TKBAuth.scheduleEntrySid){
    return {
      number: 1,
      effectiveDate: school.effectiveDate || "",
      sid: window.TKBAuth.scheduleEntrySid(school, 1),
      original: true
    };
  }
  return null;
}

function _superAdminSchoolRows(){
  const rows = [{
    isDefault: true,
    school: {
      id: "default",
      name: _getSchoolName("default") || "Default"
    },
    entry: {
      number: 1,
      label: "mặc định",
      sid: "default",
      effectiveDate: ""
    }
  }];
  if(!window.TKBAuth || !window.TKBAuth.listSchools) return rows;
  try{
    window.TKBAuth.listSchools().forEach(school => {
      const entry = _activeScheduleEntryForDisplay(school);
      rows.push({ school, entry });
    });
    return rows;
  }catch(e){
    console.warn("super admin school rows failed", e);
    return rows;
  }
}

function switchManagedSchool(schoolId){
  if(!window.TKBAuth) return;
  const reg = window.TKBAuth.loadRegistry ? window.TKBAuth.loadRegistry() : { schools: {} };
  const school = reg.schools && reg.schools[schoolId];
  if(!school){
    showBottomPopup("Không tìm thấy trường trên VPS.", "error");
    return;
  }
  let entry = window.TKBAuth.activeScheduleEntry ? window.TKBAuth.activeScheduleEntry(schoolId) : null;
  if(!entry && window.TKBAuth.createSchoolSchedule){
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    const created = window.TKBAuth.createSchoolSchedule(schoolId, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    if(!created || !created.ok){
      showBottomPopup((created && created.message) || "Không tạo được TKB hiện hành.", "error");
      return;
    }
    if(window.TKBAuth.setActiveSchedule) window.TKBAuth.setActiveSchedule(schoolId, created.number);
    entry = { sid: created.sid, number: created.number };
  }
  if(!entry || !entry.sid){
    showBottomPopup("Trường này chưa có mã TKB hiện hành.", "warning");
    return;
  }
  try{
    const label = `${school.name || schoolId} - ${_scheduleDisplayLabel(entry)}`;
    sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã mở ${label}.`);
  }catch(_){ }
  const u = new URL(window.location.href);
  _setSchoolUrlParams(u, entry.sid, school.name || schoolId);
  window.location.href = u.toString();
}

function showSuperAdminSchoolSwitcher(){
  closeSchoolSwitcher();
  const current = getSchoolId();
  const rows = _superAdminSchoolRows();
  let html = `<div class="modal" id="schoolModal" style="display:flex">
    <div class="modal-content" style="width:min(520px,calc(100vw - 32px))">
      <h3>Chọn TKB hiện hành</h3>
      <div style="margin-top:10px">`;

  if(rows.length){
    rows.forEach(({school, entry, isDefault}) => {
      const schoolId = String(school.id || "");
      const active = isDefault
        ? current === "default"
        : (entry && _sanitizeSchoolId(entry.sid) === current);
      const title = _prettySchoolLabel(school.name || school.ownerLoginId || schoolId);
      const scheduleText = isDefault ? "" : _scheduleDisplayLabel(entry);
      const date = entry && entry.effectiveDate ? ` - ${entry.effectiveDate}` : "";
      const click = isDefault
        ? "switchSchool('default')"
        : `switchManagedSchool('${_jsString(schoolId)}')`;
      const detail = scheduleText + date;
      html += `
      <div class="school-item ${active ? "active" : ""}" onclick="${click}">
        <div class="school-name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        ${detail ? `<div style="font-size:12px;color:#667">${escapeHtml(detail)}</div>` : ""}
      </div>`;
    });
  }

  html += `</div>
    <div style="text-align:right;margin-top:10px">
      <button class="btn" onclick="closeSchoolSwitcher()">Đóng</button>
    </div>
  </div></div>`;

  document.body.insertAdjacentHTML("beforeend", html);
}

function showSchoolSwitcher(){
  closeSchoolSwitcher();
  const isSuper = _isSuperAdmin();
  if(isSuper){
    showSuperAdminSchoolSwitcher();
    return;
  }
  const schools = getSchoolList();
  // Super admin luôn có 1 TKB "default" và không thể xóa
  if(isSuper && !schools.map(_sanitizeSchoolId).includes("default")){
    schools.unshift("default");
  }
  const current = getSchoolId();

  let html = `<div class="modal" id="schoolModal" style="display:flex">
    <div class="modal-content" style="width:320px">
      <h3>Chọn trường</h3>
      <div style="margin-top:10px">`;

  schools.forEach(s=>{
    const sid = _sanitizeSchoolId(s);
    const js = (sid||"").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
    const name = _prettySchoolLabel(_getSchoolName(sid) || sid);
    const isDefault = sid === "default";
    const delBtn = (isSuper && isDefault)
      ? ""
      : `<button class="school-del" onclick="event.stopPropagation();deleteSchool('${js}')">Xóa</button>`;
    html += `
      <div class="school-item ${sid===current?'active':''}" onclick="switchSchool('${js}')">
        <div class="school-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="school-edit" onclick="event.stopPropagation();renameSchool('${js}')">Sửa</button>
          ${delBtn}
        </div>
      </div>`;
  });

  html += `</div>
    <button class="btn primary" style="width:100%;margin-top:10px" onclick="addNewSchool()">Thêm trường</button>
    <div style="text-align:right;margin-top:10px">
      <button class="btn" onclick="closeSchoolSwitcher()">Đóng</button>
    </div>
  </div></div>`;

  document.body.insertAdjacentHTML("beforeend", html);
}
function closeSchoolSwitcher(){
  const m = document.getElementById("schoolModal");
  if(m) m.remove();
}
function switchSchool(sid){
  try{
    const label = _prettySchoolLabel(_getSchoolName(sid) || sid);
    sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã mở trường ${label}.`);
  }catch(e){ /* ignore */ }
  const u = new URL(window.location.href);
  const label = _prettySchoolLabel(_getSchoolName(sid) || sid);
  _setSchoolUrlParams(u, sid, label);
  window.location.href = u.toString();
}

// Sửa tên hiển thị (có dấu) của trường hiện tại trong danh sách
function renameSchool(sid){
  sid = _sanitizeSchoolId(sid);
  if(!sid) return;

  const cur = _getSchoolName(sid) || "";
  const next = prompt("Nhập tên hiển thị của trường (có dấu):", cur);
  if(next === null) return;
  const name = String(next||"").trim();
  if(!name){
    showBottomPopup("Nhập tên hiển thị của trường.", "warning");
    return;
  }

  _setSchoolName(sid, name);
  // nếu đang là trường hiện tại -> cập nhật badge
  if((CTX.schoolId||getSchoolId()) === sid){
    CTX.schoolLabel = _prettySchoolLabel(name) || name;
    try{ localStorage.setItem("TKB_LAST_SCHOOL_LABEL", CTX.schoolLabel); }catch(e){ /* ignore */ }
    updateSchoolBadge();
  }
  showSchoolSwitcher();
  showBottomPopup("Đã cập nhật tên trường.", "ok");
}

// Xóa trường khỏi danh sách + xóa dữ liệu lưu trên máy (localStorage + IndexedDB/sql.js)
async function deleteSchool(sid){
  sid = _sanitizeSchoolId(sid);
  if(!sid) return;

  if(_isSuperAdmin() && sid === "default"){
    showBottomPopup("Không thể xóa TKB mặc định. Bạn chỉ có thể đổi tên.", "warning");
    return;
  }

  const msg = `Xóa trường "${sid}"?\n\n- Sẽ xóa dữ liệu của trường này khỏi máy (localStorage/IndexedDB).\n- Thao tác này không thể hoàn tác.`;
  if(!confirm(msg)) return;

  // 1) Xóa khỏi danh sách trường
  try{
    const list = getSchoolList().filter(x=>_sanitizeSchoolId(x) !== sid);
    localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(list));
  }catch(e){ /* ignore */ }

  // 2) Xóa backup localStorage
  try{ localStorage.removeItem(_lsKey(sid)); }catch(e){ /* ignore */ }

  // 2b) Xóa tên hiển thị
  try{ _deleteSchoolName(sid); }catch(e){ /* ignore */ }

  // 3) Xóa DB trong IndexedDB (KVDB/sql.js lưu ở objectStore "files")
  try{ await _kvdbDeleteDbByName(`TKB::SCHOOL::${sid}`); }catch(e){ /* ignore */ }

  // 3b) Xóa cache server của trường này.
  try{
    if(window.TKBStorage && window.TKBStorage.saveRemoteSchoolData){
      await window.TKBStorage.saveRemoteSchoolData(sid, "{}");
    }
  }catch(e){ /* ignore */ }

  // 4) Nếu đang ở trường bị xóa -> chuyển sang trường khác / default
  const cur = getSchoolId();
  if (cur === sid){
    const nextList = getSchoolList();
    const next = _sanitizeSchoolId(nextList[0] || "default");
    const u = new URL(window.location.href);
    _setSchoolUrlParams(u, next, _getSchoolName(next) || next);
    try{ sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã xóa trường ${sid}.`); }catch(e){ /* ignore */ }
    window.location.href = u.toString();
    return;
  }

  // Refresh modal
  showSchoolSwitcher();
  showBottomPopup(`Đã xóa trường ${sid}.`, "ok");
}

function _kvdbDeleteDbByName(dbName){
  return new Promise((resolve)=>{
    try{
      const req = indexedDB.open("TKB_SQLJS_DB", 1);
      req.onupgradeneeded = ()=>{
        try{
          const db = req.result;
          if (db && !db.objectStoreNames.contains("files")) db.createObjectStore("files");
        }catch(e){ /* ignore */ }
      };
      req.onsuccess = ()=>{
        const db = req.result;
        try{
          const tx = db.transaction("files","readwrite");
          const st = tx.objectStore("files");
          st.delete(dbName);
          tx.oncomplete = ()=>{ try{ db.close(); }catch(_){ } resolve(true); };
          tx.onerror = ()=>{ try{ db.close(); }catch(_){ } resolve(false); };
        }catch(e){
          try{ db.close(); }catch(_){ }
          resolve(false);
        }
      };
      req.onerror = ()=> resolve(false);
    }catch(e){
      resolve(false);
    }
  });
}
function addNewSchool(){
  // Modal tạo trường mới + chọn cấp (Tiểu học/THCS/THPT GDTX)
  const old = document.getElementById("addSchoolModal");
  if (old) old.remove();

  const html = `
    <div class="modal" id="addSchoolModal" style="display:flex">
      <div class="modal-content" style="width:360px">
        <h3>Thêm trường</h3>
        <div style="margin-top:12px">
          <div style="font-weight:700;margin-bottom:6px">Mã trường</div>
          <input id="newSchoolId" placeholder="VD: THCS_NguyenTrai" style="width:100%;margin-bottom:12px">

          <div style="font-weight:700;margin-bottom:6px">Cấp trường</div>
          <select id="newSchoolLevel" style="width:100%;margin-bottom:12px">
            <option value="TH">Tiểu học</option>
            <option value="THCS" selected>THCS</option>
            <option value="THPT_GDTX">THPT (GDTX)</option>
          </select>

          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn" onclick="closeAddSchoolModal()">Hủy</button>
            <button class="btn primary" onclick="createNewSchoolFromModal()">Tạo & mở</button>
          </div>
          <div style="margin-top:10px;font-size:12px;color:#667;line-height:1.35">
            * Khi tạo trường mới, hệ thống sẽ tự tạo dữ liệu <b>Khối</b> theo cấp bạn chọn.
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", html);
}

function closeAddSchoolModal(){
  document.getElementById("addSchoolModal")?.remove();
}

function _seedKhoiByLevel(level){
  const preset = getKhoiLevelPreset(level) || QUICK_KHOI_LEVELS.THCS;
  const out = [];
  let idx = 1;
  for (const k of preset.numbers){
    out.push({
      id: "K" + String(idx).padStart(3,"0"),
      ten: `Khối ${k}`,
      makhoi: `K${k}`
    });
    idx++;
  }
  return out;
}

async function createNewSchoolFromModal(){
  const raw = document.getElementById("newSchoolId")?.value || "";
  const level = document.getElementById("newSchoolLevel")?.value || "THCS";
  if(!raw.trim()){
    showBottomPopup("Nhập mã trường.", "warning");
    return;
  }

  const sid = _sanitizeSchoolId(raw);
  addSchoolToList(sid);
  // lưu tên hiển thị theo input (có thể có dấu)
  try{ _setSchoolName(sid, String(raw).trim()); }catch(e){ /* ignore */ }

  // Nếu trường chưa có dữ liệu, seed khối theo cấp
  const key = _lsKey(sid);
  const existing = (window.TKBStorage && window.TKBStorage.remoteOnly && window.TKBStorage.loadRemoteSchoolData)
    ? await window.TKBStorage.loadRemoteSchoolData(sid)
    : _safeParseJSON(localStorage.getItem(key), null);
  const hasAny = existing && typeof existing === "object" && (
    Array.isArray(existing.khoi) && existing.khoi.length
  );

  if (!hasAny){
    const seeded = {
      khoi: _seedKhoiByLevel(level),
      lop: [],
      giaovien: [],
      monhoc: [],
      mon: [],
      phong: [],
      pccmMatrix: {},
      pccmRoomMatrix: {},
      tkb: {},
      tkbConfig: (existing && existing.tkbConfig) ? existing.tkbConfig : undefined
    };
    try{
      if(window.TKBStorage && window.TKBStorage.saveRemoteSchoolData){
        await window.TKBStorage.saveRemoteSchoolData(sid, JSON.stringify(seeded));
      }else{
        localStorage.setItem(key, JSON.stringify(seeded));
      }
    }catch(e){ console.warn("Seed remote store failed", e); }

    // seed KVDB nếu có (không bắt buộc)
    try{
      if (!(window.TKBStorage && window.TKBStorage.remoteOnly) && window.KVDB){
        const kv = await KVDB.open(`TKB::SCHOOL::${sid}`);
        await kv.set("DATA_JSON", JSON.stringify(seeded));
      }
    }catch(e){
      console.warn("Seed KVDB failed", e);
    }
  }

  closeAddSchoolModal();
  switchSchool(sid);
}

function renderPCCMMonHeader(monObj){
    const name = escapeHtml((monObj && (monObj.ten || monObj.key)) || "");
    const code = escapeHtml((monObj && (monObj.code || "")) || "");
    if (!code) return `<span class="pccm-th-inline"><span class="pccm-th-name" title="${name}">${name}</span></span>`;
    // inline: Tên + (Mã)
    const label = `${name} (${code})`;
    return `<span class="pccm-th-inline" title="${label}"><span class="pccm-th-name">${name}</span><span class="pccm-th-code">(${code})</span></span>`;
}
