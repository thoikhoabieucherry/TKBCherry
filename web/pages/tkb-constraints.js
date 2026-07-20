/* =========================================================
   tkb-constraints.js — CLEAN FULL CONSTRAINTS 2026-04-30
   - Model sạch theo hướng VietSchool
   - Có nhóm dữ liệu dùng chung: lớp / giáo viên / môn / phòng
   - Hoàn thiện giao diện + dữ liệu + engine cho:
     1) Yêu cầu giáo viên
     2) Yêu cầu môn học
     3) Yêu cầu cố định
     4) Giới hạn số tiết / 1 thời điểm
     5) Xóa yêu cầu
   - Không mô phỏng nguyên xi giao diện desktop; ảnh SmartScheduler chỉ dùng để đối chiếu cấu trúc mục/cột.
   ========================================================= */
(function(){
  'use strict';

  const VERSION = 'constraints-ui-v33-mobile-safe-area-bulk-fill';
  const PANEL_ID = 'tkbConstraintsFullPanel';
  const STYLE_ID = 'tkbConstraintsFullStyle';
  const DAY_KEYS_DEFAULT = ['thu2','thu3','thu4','thu5','thu6','thu7'];
  const DAY_LABEL_DEFAULT = {thu2:'Thứ 2',thu3:'Thứ 3',thu4:'Thứ 4',thu5:'Thứ 5',thu6:'Thứ 6',thu7:'Thứ 7'};
  const SESSION_KEYS = ['sang','chieu'];
  const SESSION_LABEL = {sang:'Sáng', chieu:'Chiều'};
  const TIME_LIMIT_GROUP_COUNT = 10;

  const META = window.TKBConstraintsMeta || {};
  const TEACHER_RULES = META.TEACHER_RULES || [
    ['maxDaysSessions', 'Giới hạn số ngày dạy & buổi dạy/1 tuần'],
    ['maxPeriods', 'Giới hạn số tiết dạy/1 buổi'],
    ['maxMorningAfternoon', 'Giới hạn số buổi dạy sáng & chiều'],
    ['oneSessionPerDay', 'Chỉ dạy 1 buổi/1 ngày'],
    ['noMorningP5AfternoonP1', 'Không dạy tiết 5 buổi sáng & tiết 1 buổi chiều'],
    ['oneLocationPerSession', 'Chỉ dạy 1 địa điểm/1 buổi'],
    ['gapBetweenLocations', 'Có tiết trống giữa 2 địa điểm'],
    ['maxOneMovePerSession', 'Không di chuyển 2 lần/1 buổi giữa các địa điểm'],
    ['mustTeach', 'Vị trí phải có tiết dạy']
  ];

  const SUBJECT_RULES = META.SUBJECT_RULES || [
    ['lessonBlocks', 'Số buổi học có tiết học xếp liền'],
    ['avoidBreakPair23', 'Tránh xếp 2 tiết liền qua tiết 2-3'],
    ['avoidBreakPair34', 'Tránh xếp 2 tiết liền qua tiết 3-4'],
    ['linkedDays', 'Tránh xếp tiết học xếp liền vào các thứ trong tuần'],
    ['sessionAllowed', 'Giới hạn buổi của môn học'],
    ['weeklySessionPeriods', 'Giới hạn số tiết của môn học/1 buổi/1 tuần'],
    ['spacingDays', 'Học cách ngày'],
    ['maxPeriods', 'Giới hạn số tiết/1 buổi'],
    ['maxPeriodsDay', 'Giới hạn số tiết/1 ngày'],
    ['noSameSession', 'Môn học không cùng buổi'],
    ['noSameDay', 'Môn học không cùng ngày'],
    ['maxSessions', 'Giới hạn số buổi học']
  ];

  const FIXED_OFF_GROUP_LABEL = META.FIXED_OFF_GROUP_LABEL || 'Yêu cầu cố định';
  const FIXED_OFF_TYPES = META.FIXED_OFF_TYPES || [
    ['class', 'Yêu cầu cố định lớp học'],
    ['teacher', 'Yêu cầu cố định giáo viên'],
    ['subject', 'Yêu cầu cố định môn học']
  ];
  function fixedOffTitle(type){
    return (FIXED_OFF_TYPES.find(x => x[0] === type) || [])[1] || FIXED_OFF_GROUP_LABEL;
  }

  const state = {
    section: 'dashboard',
    teacherRule: 'maxDaysSessions',
    subjectRule: 'lessonBlocks',
    subjectGroupRule: 'sessionAllowed',
    fixedType: 'class',
    groupType: 'class',
    groupId: '',
    teacherGroup: '',
    classGroup: '',
    noSameClassId: '',
    noSameClassIds: [],
    mustTeachTeacherIds: [],
    mustTeachSlots: [],
    mustTeachAnchorSlot: '',
    subjectId: '',
    subjectGroupId: '',
    search: '',
    fixedSelected: { class:'', teacher:'', subject:'', room:'', subjectGroup:'' },
    fixedSelectedIds: { class: [] },
    fixedSelectionAnchor: { class: '' },
    fixedOffSlots: [],
    fixedOffAnchorSlot: '',
    fixedOffListScroll: {},
    timeLimitView: 'limits',
    timeLimitLimitType: 'teacher',
    timeLimitLimitGroupId: '',
    formSignature: '',
    formSignatureTimer: null,
    mustTeachKeyBound: false,
    fixedOffKeyBound: false
  };

  let rbNumSelection = new Set();
  let rbNumAnchor = null;
  let rbNumDragStart = null;
  let rbNumDragging = false;
  let rbNumBound = false;

  /* ===================== BASICS ===================== */
  function D(){
    try{
      if(typeof DATA !== 'undefined'){
        if(!DATA || typeof DATA !== 'object') DATA = {};
        return DATA;
      }
    }catch(_){ }
    window.DATA = window.DATA || {};
    return window.DATA;
  }
  function days(){ try{ if(typeof DAYS !== 'undefined' && Array.isArray(DAYS) && DAYS.length) return DAYS; }catch(_){ } return DAY_KEYS_DEFAULT; }
  function dayLabel(k){ try{ if(typeof LABEL !== 'undefined' && LABEL && LABEL[k]) return LABEL[k]; }catch(_){ } return DAY_LABEL_DEFAULT[k] || k; }
  function sessionLen(buoi){ try{ if(buoi === 'sang') return Number(typeof SANG !== 'undefined' ? SANG : 5) || 5; if(buoi === 'chieu') return Number(typeof CHIEU !== 'undefined' ? CHIEU : 5) || 5; }catch(_){ } return 5; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
  function norm(s){ return String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase(); }
  function cleanId(s, prefix){
    let x = String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D')
      .trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    if(!x) x = (prefix || 'group') + '_' + Date.now();
    return x;
  }
  function toInt(v, def){ if(v === '' || v == null) return def; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : def; }
  function truthy(v){ return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }
  function arrUnique(a){ return Array.from(new Set((a||[]).map(x => String(x == null ? '' : x).trim()).filter(Boolean))); }
  function slotKey(thu, buoi, ti){ return String(thu)+'|'+String(buoi)+'|'+String(Number(ti)); }
  function parseSlotKey(k){ const p = String(k||'').split('|'); return {thu:p[0]||'', buoi:p[1]||'', ti:Number(p[2]||0)}; }
  function getPath(obj, path, def){ let cur = obj; for(const p of String(path||'').split('.')){ if(!p) continue; if(cur == null || typeof cur !== 'object' || !(p in cur)) return def; cur = cur[p]; } return cur == null ? def : cur; }
  function setPath(obj, path, val){ const parts = String(path||'').split('.').filter(Boolean); let cur = obj; for(let i=0;i<parts.length-1;i++){ const p=parts[i]; if(!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur=cur[p]; } if(parts.length) cur[parts[parts.length-1]] = val; }
  function dayLimitValue(rule, path, thu){ const raw=getPath(rule,path,0); if(raw && typeof raw==='object') return toInt(raw[thu],0); return toInt(raw,0); }
  function dayLimitInputValue(rule, path, thu){ const raw=getPath(rule,path,''); if(raw && typeof raw==='object') return raw[thu] == null ? '' : raw[thu]; return raw == null ? '' : raw; }
  function own(obj, key){ return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
  function linkedDayAvoided(linked, buoi, thu){
    if(!linked || typeof linked !== 'object') return false;
    const checked = truthy(getPath(linked, `${buoi}.${thu}`, false));
    if(String(linked.mode || '').toLowerCase() === 'avoid') return checked;
    if(own(linked, 'enabled')) return truthy(linked.enabled) && !checked;
    return checked;
  }
  function linkedDaysCellChecked(rowRule, buoi, thu){
    return linkedDayAvoided(rowRule?.linkedDays, buoi, thu);
  }
  function normalizeLinkedDaysRow(row){
    if(!row || typeof row !== 'object' || !row.linkedDays || typeof row.linkedDays !== 'object') return;
    const next = { mode:'avoid', sang:{}, chieu:{} };
    days().forEach(d=>{
      if(linkedDayAvoided(row.linkedDays, 'sang', d)) next.sang[d]=true;
      if(linkedDayAvoided(row.linkedDays, 'chieu', d)) next.chieu[d]=true;
    });
    if(!Object.keys(next.sang).length) delete next.sang;
    if(!Object.keys(next.chieu).length) delete next.chieu;
    if(next.sang || next.chieu) row.linkedDays = next;
    else delete row.linkedDays;
  }
  function normalizeSessionAllowedRow(row){
    if(!row || typeof row !== 'object' || !row.sessionAllowed || typeof row.sessionAllowed !== 'object') return;
    const conf = row.sessionAllowed;
    const allowMorning = conf.allowMorning !== false;
    const allowAfternoon = conf.allowAfternoon !== false;
    const oneSession = truthy(conf.oneSessionPerDay);
    if(oneSession){
      delete conf.allowMorning;
      delete conf.allowAfternoon;
      conf.oneSessionPerDay = true;
      return;
    }
    if(!allowMorning && !allowAfternoon){
      delete conf.allowMorning;
      delete conf.allowAfternoon;
    }else{
      if(allowMorning) delete conf.allowMorning; else conf.allowMorning = false;
      if(allowAfternoon) delete conf.allowAfternoon; else conf.allowAfternoon = false;
    }
    if(oneSession) conf.oneSessionPerDay = true;
    else delete conf.oneSessionPerDay;
    delEmpty(conf);
    if(!Object.keys(conf).length) delete row.sessionAllowed;
  }
  function sessionAllowedPreferredPath(source){
    const path = String(source?.dataset?.path || '');
    const filter = String(source?.dataset?.rbCheckFilter || '');
    if(path === 'sessionAllowed.allowMorning' || filter === 'morning') return 'sessionAllowed.allowMorning';
    if(path === 'sessionAllowed.allowAfternoon' || filter === 'afternoon') return 'sessionAllowed.allowAfternoon';
    return '';
  }
  function enforceSessionAllowedInputs(root, source){
    const scope = root || document.getElementById(PANEL_ID) || document;
    const preferred = sessionAllowedPreferredPath(source);
    let corrected = false;
    scope.querySelectorAll('input[type="checkbox"][data-cid][data-path="sessionAllowed.allowMorning"]').forEach(morning=>{
      const row = morning.closest('tr');
      const afternoon = row?.querySelector('input[type="checkbox"][data-cid][data-path="sessionAllowed.allowAfternoon"]');
      const oneSession = row?.querySelector('input[type="checkbox"][data-cid][data-path="sessionAllowed.oneSessionPerDay"]');
      if(!afternoon) return;
      if(oneSession?.checked){
        if(!morning.checked) morning.checked = true;
        if(!afternoon.checked) afternoon.checked = true;
        return;
      }
      if(morning.checked || afternoon.checked) return;
      if(preferred === 'sessionAllowed.allowAfternoon') afternoon.checked = true;
      else morning.checked = true;
      corrected = true;
    });
    return corrected;
  }
  function delEmpty(obj){
    if(!obj || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(k=>{
      const v = obj[k];
      if(v && typeof v === 'object' && !Array.isArray(v)) delEmpty(v);
      if(v === '' || v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) delete obj[k];
    });
    return obj;
  }
  function saveStoreSafe(opts){ try{ if(typeof saveStore === 'function') saveStore(opts); else if(typeof window.saveStore === 'function') window.saveStore(opts); }catch(e){ console.warn('[tkb-constraints] saveStore failed', e); } }
  function rerenderSafe(){ try{ if(typeof renderCurrentView === 'function') renderCurrentView(); }catch(_){ } try{ if(typeof loadMonList === 'function') loadMonList(); }catch(_){ } }
  function releaseExistingViolationsAfterSave(){
    try{
      const bridge = window.TKBRustAPI;
      if(bridge && typeof bridge.releaseConstraintViolatingLessons === 'function') return Number(bridge.releaseConstraintViolatingLessons(D()) || 0);
    }catch(e){
      console.warn('[tkb-constraints] release violating lessons failed', e);
    }
    return 0;
  }
  function cellMonSafe(v){
    try{ if(typeof cellMon === 'function') return String(cellMon(v) || '').trim(); }catch(_){ }
    try{ if(typeof window.cellMon === 'function') return String(window.cellMon(v) || '').trim(); }catch(_){ }
    if(v === 'OFF' || v === '' || v == null) return '';
    if(typeof v === 'string') return v.trim();
    if(v && typeof v === 'object' && v.mon) return String(v.mon || '').trim();
    return '';
  }
  function isFixedSafe(v){ try{ if(typeof isFixed === 'function') return !!isFixed(v); }catch(_){ } try{ if(typeof window.isFixed === 'function') return !!window.isFixed(v); }catch(_){ } return !!(v && typeof v === 'object' && v.fixed); }
  function classCanon(lopId){
    try{ if(typeof getLopCanonById === 'function') return String(getLopCanonById(lopId)||'').trim(); }catch(_){ }
    try{ if(typeof window.getLopCanonById === 'function') return String(window.getLopCanonById(lopId)||'').trim(); }catch(_){ }
    const lop = (D().lop || []).find(l => String(l.id) === String(lopId));
    return String((lop && (lop.ten || lop.ten2 || lop.id)) || lopId || '').trim();
  }
  function teacherOf(lopId, mon){
    try{ if(typeof getTeacherForClassMon === 'function') return String(getTeacherForClassMon(classCanon(lopId), mon) || '').trim(); }catch(_){ }
    try{ if(typeof window.getTeacherForClassMon === 'function') return String(window.getTeacherForClassMon(classCanon(lopId), mon) || '').trim(); }catch(_){ }
    const key1 = classCanon(lopId) + '|' + String(mon||'').trim();
    const key2 = String(lopId||'') + '|' + String(mon||'').trim();
    return String(D().pccmMatrix?.[key1] || D().pccmMatrix?.[key2] || '').trim();
  }
  function roomOf(lopId, mon){
    try{ if(typeof getRoomForClassMon === 'function') return String(getRoomForClassMon(classCanon(lopId), mon) || '').trim(); }catch(_){ }
    try{ if(typeof window.getRoomForClassMon === 'function') return String(window.getRoomForClassMon(classCanon(lopId), mon) || '').trim(); }catch(_){ }
    const key1 = classCanon(lopId) + '|' + String(mon||'').trim();
    const key2 = String(lopId||'') + '|' + String(mon||'').trim();
    return String(D().pccmRoomMatrix?.[key1] || D().pccmRoomMatrix?.[key2] || '').trim();
  }
  function teacherName(code){
    const c = String(code||'').trim(); if(!c) return '';
    try{ if(typeof getTeacherNameByCode === 'function') return String(getTeacherNameByCode(c) || c).trim(); }catch(_){ }
    try{ if(typeof window.getTeacherNameByCode === 'function') return String(window.getTeacherNameByCode(c) || c).trim(); }catch(_){ }
    const g = (D().giaovien || []).find(x => String(x.magv || x.ma || x.code || x.id || '').trim() === c);
    if(!g) return c;
    const full = `${g.hodem||''} ${g.ten||''}`.trim();
    return full ? `${c} - ${full}` : c;
  }
  function teacherRecord(code){
    const c = String(code||'').trim();
    if(!c) return null;
    return (D().giaovien || []).find(x => String(x.magv || x.ma || x.code || x.id || '').trim() === c) || null;
  }
  function teacherShortName(code, fullName){
    const c = String(code||'').trim();
    const g = teacherRecord(c);
    const short = String(
      g?.tenTat || g?.tentat || g?.ten_tat || g?.vietTat || g?.viettat ||
      g?.tenVietTat || g?.tenviettat || g?.shortName || g?.short || ''
    ).trim();
    if(short) return short;
    const fallback = String(g?.ma || g?.magv || g?.code || g?.id || c || fullName || '').trim();
    return fallback || String(fullName || '').trim();
  }
  function classNameOf(id){ const l = (D().lop || []).find(x => String(x.id) === String(id)); return String((l && (l.ten || l.ten2 || l.id)) || id || '').trim(); }
  function roomLocation(roomName, lopId){
    const r = String(roomName||'').trim();
    if(r){
      const p = (D().phong || []).find(x => [x.id,x.ma,x.ten,x.name].some(v => norm(v) === norm(r)));
      if(p){ const d = String(p.diadiem || p.diaDiem || p.khu || p.location || '').trim(); if(d) return d; }
      return r;
    }
    const l = (D().lop || []).find(x => String(x.id) === String(lopId));
    return String((l && (l.diadiem || l.diaDiem || l.khu || l.location)) || '').trim();
  }

  /* ===================== MODEL ===================== */
  function emptyModel(){
    return {
      version: VERSION,
      groups: { class:{}, teacher:{}, subject:{}, room:{} },
      teacher: {},
      subject: {},       // subject[subjectId].byClass[classId].rule...
      subjectGroup: {},  // subjectGroup[groupId].byClass[classId].rule...
      subjectNoSameSession: { byClass:{} },
      fixedOff: { class:{}, teacher:{}, subject:{}, room:{}, subjectGroup:{} },
      timeLimit: [],
      meta: { updatedAt: '', schoolName: '', scheduleNumber: '', effectiveDate: '' }
    };
  }
  function normalizeGroup(g){ if(Array.isArray(g)) return {name:'', items: arrUnique(g)}; if(!g || typeof g !== 'object') return {name:'', items:[]}; return { name:String(g.name || g.label || '').trim(), items: arrUnique(g.items || g.members || g.list || []) }; }
  function normalizeModel(c){
    const d = emptyModel();
    c.version = c.version || VERSION;
    c.groups = Object.assign({}, d.groups, c.groups || {});
    ['class','teacher','subject','room'].forEach(t=>{ c.groups[t] = c.groups[t] || {}; Object.keys(c.groups[t]).forEach(id=>{ c.groups[t][id] = normalizeGroup(c.groups[t][id]); if(!c.groups[t][id].name) c.groups[t][id].name = id; }); });
    c.teacher = c.teacher || {};
    c.subject = c.subject || {};
    c.subjectGroup = c.subjectGroup || {};
    c.subjectNoSameSession = c.subjectNoSameSession && typeof c.subjectNoSameSession === 'object' ? c.subjectNoSameSession : {};
    c.subjectNoSameSession.byClass = c.subjectNoSameSession.byClass && typeof c.subjectNoSameSession.byClass === 'object' ? c.subjectNoSameSession.byClass : {};
    c.fixedOff = Object.assign({}, d.fixedOff, c.fixedOff || {});
    ['class','teacher','subject','room','subjectGroup'].forEach(t=>{ c.fixedOff[t] = c.fixedOff[t] || {}; });
    c.timeLimit = Array.isArray(c.timeLimit) ? c.timeLimit : [];
    c.meta = c.meta || {};
    c.meta.schoolName = String(c.meta.schoolName || c.meta.schoolLabel || c.meta.tenTruong || c.meta.school || '').trim();
    c.meta.scheduleNumber = String(c.meta.scheduleNumber || c.meta.scheduleNo || c.meta.tkbNumber || '').trim();
    c.meta.effectiveDate = String(c.meta.effectiveDate || c.meta.applyDate || c.meta.ngayApDung || '').trim();
    // migrate từ các bản tạm cũ nếu có
    try{ if(c.teacherFinal && c.teacherFinal.rules && !Object.keys(c.teacher).length) c.teacher = JSON.parse(JSON.stringify(c.teacherFinal.rules || {})); }catch(_){ }
    try{ if(c.subjectFinal && c.subjectFinal.rules && !Object.keys(c.subject).length) c.subject = JSON.parse(JSON.stringify(c.subjectFinal.rules || {})); }catch(_){ }
    try{ if(c.subjectGroupFinal && c.subjectGroupFinal.rules && !Object.keys(c.subjectGroup).length) c.subjectGroup = JSON.parse(JSON.stringify(c.subjectGroupFinal.rules || {})); }catch(_){ }
    Object.keys(c.teacher || {}).forEach(id=>{
      const rule = c.teacher[id];
      if(!rule || typeof rule !== 'object') return;
      delete rule.lessonPlans;
      delete rule.maxPeriodsClass;
      delEmpty(rule);
      if(!Object.keys(rule).length) delete c.teacher[id];
    });
    return c;
  }
  function model(){
    const data = D();
    if(!data.tkbConstraints || typeof data.tkbConstraints !== 'object' || data.tkbConstraints.__normalizedBy !== VERSION){
      data.tkbConstraints = normalizeModel(data.tkbConstraints || emptyModel());
      try{ Object.defineProperty(data.tkbConstraints, '__normalizedBy', {value: VERSION, writable: true, enumerable: false}); }
      catch(_){ data.tkbConstraints.__normalizedBy = VERSION; }
    }
    return data.tkbConstraints;
  }
  let pendingStoreSaveTimer = null;
  function touchSave(opts){ const c = model(); c.version = VERSION; c.meta.updatedAt = new Date().toISOString(); invalidateConstraintCache(); saveStoreSafe(Object.assign({force:true}, opts && opts.critical ? {syncRemote:true} : {})); }
  function touchSaveDeferred(){
    const c = model();
    c.version = VERSION;
    c.meta.updatedAt = new Date().toISOString();
    invalidateConstraintCache();
    if(pendingStoreSaveTimer) clearTimeout(pendingStoreSaveTimer);
    pendingStoreSaveTimer = setTimeout(()=>{
      pendingStoreSaveTimer = null;
      saveStoreSafe({force:true});
    }, 120);
  }
  function isE2EMode(){
    try{ if(new URLSearchParams(window.location.search || '').get('e2e') === '1') return true; }catch(_){ }
    try{ return sessionStorage.getItem('TKB_E2E_AUTO_CONFIRM') === '1'; }catch(_){ }
    return false;
  }
  function notifySaved(message){
    if(isE2EMode()){ try{ console.log('[tkb-constraints] ' + message); }catch(_){ } return; }
    alert(message);
  }

  function pccmDataMatrices(){
    const d = D();
    return [d.pccmMatrix || {}, d.pccmTietMatrix || {}, d.pccmGioihanMatrix || {}, d.pccmRoomMatrix || {}];
  }
  function objectQuickSignature(obj){ return Object.keys(obj || {}).sort().map(k=>`${k}:${obj[k]}`).join('~'); }
  function objectKeySignature(obj){ return Object.keys(obj || {}).sort().join('~'); }
  function listQuickSignature(arr){
    return (arr || []).map((item, idx)=>{
      if(!item || typeof item !== 'object') return `${idx}:${String(item || '')}`;
      return `${idx}:` + Object.keys(item).sort().map(k=>`${k}:${item[k]}`).join(',');
    }).join('~');
  }
  function forEachPccmKey(fn){
    const seen = new Set();
    pccmDataMatrices().forEach(matrix=>{
      Object.keys(matrix || {}).forEach(key=>{
        if(seen.has(key)) return;
        seen.add(key);
        fn(key);
      });
    });
  }
  function splitPccmKey(key){
    const parts = String(key || '').split('|');
    return { cls:String(parts.shift() || '').trim(), mon:String(parts.join('|') || '').trim() };
  }
  function splitTeacherValues(value){
    try{ if(typeof teacherListFromValue === 'function') return teacherListFromValue(value); }catch(_){ }
    try{ if(typeof window.teacherListFromValue === 'function') return window.teacherListFromValue(value); }catch(_){ }
    if(Array.isArray(value)) return value.map(x=>String(x||'').trim()).filter(Boolean);
    return String(value || '').replace(/\r?\n/g, ',').replace(/[;+]+/g, ',').split(',').map(x=>x.trim()).filter(Boolean);
  }

  /* ===================== DATA LISTS ===================== */
  function getClassList(){
    const sig = dataListSignature('class');
    if(__cache.classList && __cache.classListSig === sig) return __cache.classList;
    const map = new Map();
    const names = new Set();
    const add=(id,name)=>{
      const cid=String(id || '').trim();
      const cname=String(name || cid || '').trim();
      if(!cid) return;
      if(!map.has(cid)) map.set(cid,{id:cid,name:cname});
      names.add(norm(cid));
      names.add(norm(cname));
    };
    (D().lop || []).forEach(l=>add(l.id || l.ten || l.ten2, l.ten || l.ten2 || l.id));
    Object.keys(D().tkb || {}).forEach(id=>{ if(!map.has(id)) add(id,classNameOf(id)); });
    forEachPccmKey(k=>{
      const cls=splitPccmKey(k).cls;
      if(!cls) return;
      const lop=findClassObject(cls);
      const realId=String(lop?.id || '').trim();
      if(realId){
        if(!map.has(realId)) add(realId,classNameOf(realId));
        return;
      }
      if(!names.has(norm(cls))) add(cls,cls);
    });
    __cache.classList = Array.from(map.values());
    __cache.classListSig = sig;
    return __cache.classList;
  }
  function getTeacherList(){
    const sig = dataListSignature('teacher');
    if(__cache.teacherList && __cache.teacherListSig === sig) return __cache.teacherList;
    const map = new Map();
    (D().giaovien || []).forEach(g=>{ const id=String(g.magv || g.ma || g.code || g.id || g.ten || '').trim(); if(id) map.set(id,{id,name:teacherName(id)}); });
    Object.values(D().pccmMatrix || {}).forEach(v=>{ splitTeacherValues(v).forEach(id=>{ if(id && !map.has(id)) map.set(id,{id,name:teacherName(id)}); }); });
    __cache.teacherList = Array.from(map.values()).sort(teacherItemCompare);
    __cache.teacherListSig = sig;
    return __cache.teacherList;
  }
  function subjectDisplayName(subjectId){
    const s=String(subjectId||'').trim();
    if(!s) return '';
    try{ if(typeof resolveMonDisplay === 'function') return String(resolveMonDisplay(s) || s).trim(); }catch(_){ }
    try{ if(typeof window.resolveMonDisplay === 'function') return String(window.resolveMonDisplay(s) || s).trim(); }catch(_){ }
    const k=norm(s);
    const mh=(D().monhoc || []).find(m=>[m.ten,m.ma,m.ma2,m.id].some(v=>norm(v)===k));
    if(mh) return String(mh.ten || mh.ma || mh.ma2 || mh.id || s).trim();
    return s;
  }
  function subjectSortCode(subjectId){
    const s=String(subjectId||'').trim();
    if(!s) return '';
    const k=norm(s);
    const found=(D().monhoc || []).find(m=>[m?.ten,m?.mon,m?.mamon,m?.ma,m?.ma2,m?.id,m?.key].some(v=>norm(v)===k))
      || (D().mon || []).find(m=>[m?.ten,m?.mon,m?.mamon,m?.ma,m?.ma2,m?.id,m?.key].some(v=>norm(v)===k));
    return String(found?.ma || found?.ma2 || found?.mamon || found?.id || found?.key || found?.ten || found?.mon || s).trim();
  }
  function subjectRecordRank(subjectId){
    const s=String(subjectId||'').trim();
    if(!s) return Number.POSITIVE_INFINITY;
    const k=norm(s);
    const aliases=m=>[m?.ten,m?.mon,m?.mamon,m?.ma,m?.ma2,m?.id,m?.key].some(v=>norm(v)===k);
    const numericRank=m=>{
      for(const key of ['stt','tt','soThuTu','sothutu','thuTu','thutu','order','sort','index']){
        const n=Number(m?.[key]);
        if(Number.isFinite(n) && n > 0) return n;
      }
      return 0;
    };
    const mh=(D().monhoc || []).findIndex(aliases);
    if(mh >= 0){
      const n=numericRank((D().monhoc || [])[mh]);
      return n > 0 ? n : mh + 1;
    }
    const mon=(D().mon || []).findIndex(aliases);
    if(mon >= 0){
      const n=numericRank((D().mon || [])[mon]);
      return 10000 + (n > 0 ? n : mon + 1);
    }
    return Number.POSITIVE_INFINITY;
  }
  function subjectItemCompare(a,b){
    const ar=subjectRecordRank(a?.id || a?.name || a);
    const br=subjectRecordRank(b?.id || b?.name || b);
    if(ar !== br) return ar - br;
    const ak=subjectSortCode(a?.id || a?.name || a);
    const bk=subjectSortCode(b?.id || b?.name || b);
    const code=ak.localeCompare(bk,'vi',{sensitivity:'base', numeric:true});
    if(code) return code;
    return String(a?.name || a?.id || a || '').localeCompare(String(b?.name || b?.id || b || ''),'vi');
  }
  function teacherSubjectRank(teacherId){
    const teacher=String(teacherId||'').trim();
    if(!teacher) return Number.POSITIVE_INFINITY;
    const map=teacherSubjectRankMap();
    return map.has(norm(teacher)) ? map.get(norm(teacher)) : Number.POSITIVE_INFINITY;
  }
  function teacherSubjectRankMap(){
    const sig=dataListSignature('teacherSubjectRank');
    if(__cache.teacherSubjectRankMap && __cache.teacherSubjectRankSig===sig) return __cache.teacherSubjectRankMap;
    const map=new Map();
    Object.entries(D().pccmMatrix || {}).forEach(([key,value])=>{
      const mon=splitPccmKey(key).mon;
      const rank=subjectRecordRank(mon);
      splitTeacherValues(value).forEach(id=>{
        const k=norm(id);
        if(!k) return;
        map.set(k, Math.min(Number(map.get(k) || Number.POSITIVE_INFINITY), rank));
      });
    });
    __cache.teacherSubjectRankSig=sig;
    __cache.teacherSubjectRankMap=map;
    return map;
  }
  function teacherInputRank(teacherId){
    const teacher=String(teacherId||'').trim();
    const idx=(D().giaovien || []).findIndex(g=>String(g.magv || g.ma || g.code || g.id || g.ten || '').trim()===teacher);
    return idx >= 0 ? idx + 1 : Number.POSITIVE_INFINITY;
  }
  function teacherItemCompare(a,b){
    const ar=teacherSubjectRank(a?.id || a?.name || a);
    const br=teacherSubjectRank(b?.id || b?.name || b);
    if(ar !== br) return ar - br;
    const ai=teacherInputRank(a?.id || a?.name || a);
    const bi=teacherInputRank(b?.id || b?.name || b);
    if(ai !== bi) return ai - bi;
    return String(a?.name || a?.id || a || '').localeCompare(String(b?.name || b?.id || b || ''),'vi',{numeric:true});
  }
  function addSubjectOption(map, id, name, source){
    const sid=String(id||'').trim();
    if(!sid) return;
    const display=String(name || subjectDisplayName(sid) || sid).trim();
    const displayKey=norm(display);
    const item={id:sid,name:display,source:source||''};
    const old=map.get(displayKey);
    if(!old || (old.source!=='pccm' && item.source==='pccm')) map.set(displayKey,item);
  }
  function subjectFromPccmKey(key){
    const parts=String(key||'').split('|');
    if(parts.length < 2) return '';
    return String(parts.slice(1).join('|') || '').trim();
  }
  function assignedSubjectList(){
    const map=new Map();
    forEachPccmKey(key=>{
      const subject=subjectFromPccmKey(key);
      addSubjectOption(map, subject, subjectDisplayName(subject), 'pccm');
    });
    return Array.from(map.values()).sort(subjectItemCompare);
  }
  function getSubjectList(){
    // Cache danh sách môn: hàm này trước đây quét toàn bộ DATA.tkb mỗi lần canPlaceLesson, gây đơ khi tối ưu.
    try{
      const sig = dataListSignature('subject');
      if(__cache.subjectList && __cache.subjectListSig === sig) return __cache.subjectList;
      const map = new Map();
      const assigned=assignedSubjectList();
      if(assigned.length){
        __cache.subjectList = assigned;
        __cache.subjectListSig = sig;
        __cache.subjectKeyMap.clear();
        return __cache.subjectList;
      }
      (D().monhoc || []).forEach(m=>{
        const id=String(m.ma || m.ma2 || m.ten || m.id || '').trim();
        addSubjectOption(map, id, subjectDisplayName(id), 'catalog');
      });
      (D().mon || []).forEach(m=>{
        const id=String(m.ten || m.mon || m.ma || m.mamon || m.id || '').trim();
        addSubjectOption(map, id, subjectDisplayName(id), 'period');
      });
      if(!map.size) Object.values(D().tkb || {}).forEach(tkb=>{ days().forEach(thu=>SESSION_KEYS.forEach(buoi=>(tkb?.[thu]?.[buoi]||[]).forEach(v=>{ const mon=cellMonSafe(v); addSubjectOption(map, mon, subjectDisplayName(mon), 'tkb'); }))); });
      __cache.subjectList = Array.from(map.values()).sort(subjectItemCompare);
      __cache.subjectListSig = sig;
      __cache.subjectKeyMap.clear();
      return __cache.subjectList;
    }catch(_){ return []; }
  }
  function getRoomList(){
    const sig = dataListSignature('room');
    if(__cache.roomList && __cache.roomListSig === sig) return __cache.roomList;
    const map = new Map(); function add(x){ const id=String(x||'').trim(); if(id && !map.has(norm(id))) map.set(norm(id),{id,name:id}); }
    (D().phong || []).forEach(p=>add(p.ten || p.ma || p.id || p.name)); Object.values(D().pccmRoomMatrix || {}).forEach(add);
    __cache.roomList = Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name,'vi'));
    __cache.roomListSig = sig;
    return __cache.roomList;
  }
  function listByType(type){ if(type==='class') return getClassList(); if(type==='teacher') return getTeacherList(); if(type==='subject') return getSubjectList(); if(type==='room') return getRoomList(); return []; }
  function itemName(type, id){ const x=listByType(type).find(i=>String(i.id)===String(id)); return x ? x.name : String(id||''); }
  function groupOptions(type, selected, opts){
    opts = opts || {};
    const c=model();
    return Object.entries(c.groups[type] || {})
      .filter(([id])=>!(opts.skipAll && String(id)==='all'))
      .map(([id,g])=>`<option value="${esc(id)}" ${String(id)===String(selected)?'selected':''}>${esc(g.name || id)}</option>`)
      .join('');
  }
  function defaultGroupsSignature(){
    const d = D();
    const len = arr => Array.isArray(arr) ? arr.length : 0;
    const keys = obj => obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
    return [
      __cacheRev,
      len(d.lop),
      len(d.giaovien),
      len(d.monhoc),
      len(d.mon),
      len(d.phong),
      keys(d.tkb),
      keys(d.pccmMatrix),
      keys(d.pccmTietMatrix),
      keys(d.pccmGioihanMatrix),
      keys(d.pccmRoomMatrix)
    ].join('|');
  }
  function syncDefaultGroups(force){
    const c = model();
    const sig = defaultGroupsSignature();
    if(!force && c.meta?.defaultGroupsSig === sig && c.groups?.class?.all && c.groups?.teacher?.all && c.groups?.subject?.all && c.groups?.room?.all) return c;
    const cls=getClassList(), teachers=getTeacherList(), subjects=getSubjectList(), rooms=getRoomList();
    c.groups.class.all = {name:'Tất cả lớp', items: cls.map(x=>x.id)};
    c.groups.teacher.all = {name:'Tất cả giáo viên', items: teachers.map(x=>x.id)};
    c.groups.subject.all = {name:'Tất cả môn học', items: subjects.map(x=>x.id)};
    c.groups.room.all = {name:'Tất cả phòng học', items: rooms.map(x=>x.id)};
    const byKhoi = {};
    cls.forEach(x=>{
      const m=String(x.name||x.id).match(/\d+/);
      if(!m) return;
      const id='khoi_'+m[0];
      byKhoi[id] = byKhoi[id] || {name:'Khối '+m[0],items:[]};
      if(!byKhoi[id].items.includes(x.id)) byKhoi[id].items.push(x.id);
    });
    Object.entries(byKhoi).forEach(([id, group])=>{ c.groups.class[id]=group; });
    c.meta.defaultGroupsSig = sig;
    return c;
  }
  function groupItems(type, groupId){ const g=model().groups[type]?.[groupId]; return g && Array.isArray(g.items) ? g.items : []; }
  function classFilterRows(){ const all=getClassList(); const gid=state.classGroup || 'all'; const items = new Set(groupItems('class', gid)); if(gid && items.size) return all.filter(x=>items.has(x.id)); return all; }

  /* ===================== MATCHING HELPERS ===================== */
  function subjectAliasLookup(){
    const sig = String(__cacheRev);
    if(__cache.subjectAliasLookup && __cache.subjectAliasSig === sig) return __cache.subjectAliasLookup;
    const map = new Map();
    const addRecord = vals => {
      const aliases = Array.from(new Set((vals || []).map(v=>norm(v)).filter(Boolean)));
      if(!aliases.length) return;
      aliases.forEach(alias=>{
        let set = map.get(alias);
        if(!set){ set = new Set(); map.set(alias,set); }
        aliases.forEach(x=>set.add(x));
      });
    };
    try{ (D().monhoc || []).forEach(m=>addRecord([m?.ten,m?.mon,m?.mamon,m?.ma,m?.ma2,m?.id,m?.key])); }catch(_){ }
    try{ (D().mon || []).forEach(m=>addRecord([m?.ten,m?.mon,m?.ma,m?.ma2,m?.mamon,m?.id,m?.key])); }catch(_){ }
    __cache.subjectAliasLookup = map;
    __cache.subjectAliasSig = sig;
    return map;
  }
  function subjectAliases(mon){
    const s=String(mon||'').trim();
    const k=norm(s);
    if(!k) return new Set();
    return subjectAliasLookup().get(k) || new Set([k]);
  }
  function subjectMatches(a,b){ const A=subjectAliases(a); const B=subjectAliases(b); for(const x of A) if(B.has(x)) return true; return false; }
  function subjectKey(mon){
    const raw=String(mon||'').trim(); const key=norm(raw); if(__cache.subjectKeyMap.has(key)) return __cache.subjectKeyMap.get(key);
    const found=getSubjectList().find(x=>subjectMatches(x.id, raw)); const out=found ? found.id : raw;
    __cache.subjectKeyMap.set(key,out); return out;
  }
  function subjectInGroup(mon, groupId){ const g=model().groups.subject?.[groupId]; if(!g || !Array.isArray(g.items) || !g.items.length) return false; return g.items.some(it=>subjectMatches(it, mon)); }
  function subjectGroupsOf(mon){ const c=model(); return Object.keys(c.groups.subject || {}).filter(gid=>subjectInGroup(mon, gid)); }
  function noSameKindKey(rule){ return rule === 'noSameDay' ? 'sameDay' : 'sameSession'; }
  function noSameRuleClassId(){
    const classes=getClassList();
    const valid=new Set(classes.map(cls=>String(cls.id)));
    const id=String(state.noSameClassId || classes[0]?.id || '');
    if(id && valid.has(id)){
      if(!Array.isArray(state.noSameClassIds) || !state.noSameClassIds.map(String).some(x=>x===id)) state.noSameClassIds=[id];
      return id;
    }
    state.noSameClassId=String(classes[0]?.id || '');
    state.noSameClassIds=state.noSameClassId ? [state.noSameClassId] : [];
    return state.noSameClassId;
  }
  function noSameSelectedClassIds(){
    const classes=getClassList();
    const valid=new Set(classes.map(cls=>String(cls.id)));
    const primary=String(noSameRuleClassId() || '');
    let ids=Array.isArray(state.noSameClassIds) ? state.noSameClassIds.map(String).filter(id=>valid.has(id)) : [];
    if(primary && !ids.includes(primary)) ids.unshift(primary);
    ids=arrUnique(ids);
    state.noSameClassIds=ids.length ? ids : (primary ? [primary] : []);
    return state.noSameClassIds;
  }
  function setNoSameSingleClass(classId){
    const id=String(classId || '');
    state.noSameClassId=id;
    state.noSameClassIds=id ? [id] : [];
  }
  function toggleNoSameClass(classId){
    const id=String(classId || '');
    if(!id) return;
    const primary=String(noSameRuleClassId() || '');
    let ids=noSameSelectedClassIds().map(String);
    if(ids.includes(id)){
      if(ids.length <= 1) return;
      ids=ids.filter(x=>x!==id);
      if(primary===id) state.noSameClassId=ids[0] || '';
    }else{
      ids.push(id);
    }
    state.noSameClassIds=arrUnique(ids);
    if(!state.noSameClassId && state.noSameClassIds.length) state.noSameClassId=state.noSameClassIds[0];
  }
  function noSameRawItems(raw){
    return arrUnique(Array.isArray(raw) ? raw : (raw && typeof raw==='object' ? (raw.items || raw.subjects || []) : []));
  }
  function noSameRuleRow(classId, create){
    const c=model();
    c.subjectNoSameSession=c.subjectNoSameSession && typeof c.subjectNoSameSession==='object' ? c.subjectNoSameSession : {byClass:{}};
    c.subjectNoSameSession.byClass=c.subjectNoSameSession.byClass && typeof c.subjectNoSameSession.byClass==='object' ? c.subjectNoSameSession.byClass : {};
    if(create && classId && !c.subjectNoSameSession.byClass[classId]) c.subjectNoSameSession.byClass[classId]={sameSession:{groups:{}},sameDay:{groups:{}}};
    return c.subjectNoSameSession.byClass[classId] || {};
  }
  function noSameGroupsFor(rule, classId){
    const row=noSameRuleRow(classId,false);
    const key=noSameKindKey(rule);
    const raw=row?.[key]?.groups || row?.[key] || {};
    if(raw && typeof raw==='object' && Object.keys(raw).length) return raw;
    if(rule==='noSameSession') return model().subjectNoSameSession?.groups || {};
    return {};
  }
  function noSameGroupItems(rule, classId, gid){
    return noSameRawItems(noSameGroupsFor(rule,classId)?.[gid]);
  }
  function noSameGroupIdsForSubject(rule, classId, mon){
    const groups=noSameGroupsFor(rule,classId);
    const out=[];
    Object.entries(groups||{}).forEach(([gid,raw])=>{ if(noSameRawItems(raw).some(it=>subjectMatches(it,mon))) out.push(String(gid)); });
    return out;
  }
  function noSameActiveGroupCount(){
    const root=model().subjectNoSameSession || {};
    let count=0;
    Object.values(root.byClass || {}).forEach(row=>{
      ['sameSession','sameDay'].forEach(key=>{
        Object.values(row?.[key]?.groups || {}).forEach(raw=>{ if(noSameRawItems(raw).length > 1) count++; });
      });
    });
    Object.values(root.groups || {}).forEach(raw=>{ if(noSameRawItems(raw).length > 1) count++; });
    return count;
  }


  /* ===================== PERFORMANCE CACHE ===================== */
  let __cacheRev = 1;
  const __cache = { signature: '', allCells: null, byTeacher: null, classCells: null, classListSig: '', classList: null, roomListSig: '', roomList: null, subjectListSig: '', subjectList: null, teacherListSig: '', teacherList: null, teacherSubjectRankSig: '', teacherSubjectRankMap: null, teacherStatsSig: '', teacherStats: null, assignmentRowsSig: '', assignmentRows: null, subjectPeriodValuesSig: '', subjectPeriodValues: null, subjectAliasSig: '', subjectAliasLookup: null, fixedLessonRowsSig: '', fixedLessonRows: null, fixedLessonsBySlotSig: '', fixedLessonsBySlot: null, teacherFixedLessonSlotIndexSig: '', teacherFixedLessonSlotIndex: null, teacherDemandRowsSig: '', teacherDemandRows: null, classDemandRowsSig: '', classDemandRows: null, teacherGenericCapacitySig: '', teacherGenericCapacity: null, teacherDashboardCountsSig: '', teacherDashboardCounts: null, dashboardCapacityWarningsSig: '', dashboardCapacityWarnings: null, computeMonsSig: '', computeMonsRows: new Map(), subjectKeyMap: new Map(), lastWarnAt: 0 };
  function invalidateConstraintCache(){ __cacheRev++; __cache.signature=''; __cache.allCells=null; __cache.byTeacher=null; __cache.classCells=null; __cache.classListSig=''; __cache.classList=null; __cache.roomListSig=''; __cache.roomList=null; __cache.subjectListSig=''; __cache.subjectList=null; __cache.teacherListSig=''; __cache.teacherList=null; __cache.teacherSubjectRankSig=''; __cache.teacherSubjectRankMap=null; __cache.teacherStatsSig=''; __cache.teacherStats=null; __cache.assignmentRowsSig=''; __cache.assignmentRows=null; __cache.subjectPeriodValuesSig=''; __cache.subjectPeriodValues=null; __cache.subjectAliasSig=''; __cache.subjectAliasLookup=null; __cache.fixedLessonRowsSig=''; __cache.fixedLessonRows=null; __cache.fixedLessonsBySlotSig=''; __cache.fixedLessonsBySlot=null; __cache.teacherFixedLessonSlotIndexSig=''; __cache.teacherFixedLessonSlotIndex=null; __cache.teacherDemandRowsSig=''; __cache.teacherDemandRows=null; __cache.classDemandRowsSig=''; __cache.classDemandRows=null; __cache.teacherGenericCapacitySig=''; __cache.teacherGenericCapacity=null; __cache.teacherDashboardCountsSig=''; __cache.teacherDashboardCounts=null; __cache.dashboardCapacityWarningsSig=''; __cache.dashboardCapacityWarnings=null; __cache.computeMonsSig=''; __cache.computeMonsRows.clear(); __cache.subjectKeyMap.clear(); }
  function dataListSignature(type){
    try{
      const d = D();
      if(type === 'class') return [
        __cacheRev,
        listQuickSignature(d.lop || []),
        objectKeySignature(d.tkb || {}),
        objectKeySignature(d.pccmMatrix || {}),
        objectKeySignature(d.pccmTietMatrix || {}),
        objectKeySignature(d.pccmGioihanMatrix || {}),
        objectKeySignature(d.pccmRoomMatrix || {})
      ].join('|');
      if(type === 'room') return [
        __cacheRev,
        listQuickSignature(d.phong || []),
        objectQuickSignature(d.pccmRoomMatrix || {})
      ].join('|');
      if(type === 'teacher') return [
        __cacheRev,
        listQuickSignature(d.giaovien || []),
        objectQuickSignature(d.pccmMatrix || {})
      ].join('|');
      if(type === 'teacherSubjectRank') return [
        __cacheRev,
        listQuickSignature(d.monhoc || []),
        listQuickSignature(d.mon || []),
        objectQuickSignature(d.pccmMatrix || {})
      ].join('|');
      if(type === 'subject') return [
        __cacheRev,
        listQuickSignature(d.monhoc || []),
        listQuickSignature(d.mon || []),
        objectQuickSignature(d.pccmMatrix || {}),
        objectQuickSignature(d.pccmTietMatrix || {}),
        objectQuickSignature(d.pccmGioihanMatrix || {}),
        objectQuickSignature(d.pccmRoomMatrix || {}),
        Object.keys(d.tkb || {}).length
      ].join('|');
      if(type === 'teacherStats') return [
        __cacheRev,
        listQuickSignature(d.lop || []),
        listQuickSignature(d.mon || []),
        listQuickSignature(d.monhoc || []),
        objectQuickSignature(d.pccmMatrix || {}),
        objectQuickSignature(d.pccmTietMatrix || {}),
        objectQuickSignature(d.pccmGioihanMatrix || {}),
        objectQuickSignature(d.pccmRoomMatrix || {}),
        Object.keys(d.tkb || {}).length
      ].join('|');
      if(type === 'assignmentRows') return [
        __cacheRev,
        listQuickSignature(d.lop || []),
        listQuickSignature(d.mon || []),
        listQuickSignature(d.monhoc || []),
        objectQuickSignature(d.pccmMatrix || {}),
        objectQuickSignature(d.pccmTietMatrix || {}),
        objectQuickSignature(d.pccmGioihanMatrix || {}),
        objectQuickSignature(d.pccmRoomMatrix || {})
      ].join('|');
    }catch(_){ }
    return String(__cacheRev);
  }
  function quickTkbSignature(){
    // RẤT QUAN TRỌNG: hàm này nằm trong hot path khi kéo-thả/xếp tự động.
    // Không được quét toàn bộ DATA.tkb ở đây, nếu không trang sẽ đứng khi quay lại sắp xếp.
    try{
      const m = model();
      return String(__cacheRev) + '|' + String(m.meta?.updatedAt || '') + '|' +
        Object.keys(m.teacher || {}).length + '|' + Object.keys(m.subject || {}).length + '|' +
        Object.keys(m.subjectGroup || {}).length + '|' + (m.timeLimit || []).length;
    }catch(_){ return String(__cacheRev); }
  }
  function buildScheduleIndex(){
    const sig=quickTkbSignature(); if(__cache.allCells && __cache.signature===sig) return __cache;
    __cache.signature=sig; __cache.allCells=[]; __cache.byTeacher=new Map(); __cache.classCells=new Map();
    const tkbs=D().tkb||{};
    for(const lopId of Object.keys(tkbs)){
      const classArr=[]; const tkb=tkbs[lopId]; if(!tkb) continue;
      for(const thu of days()) for(const buoi of SESSION_KEYS){ const arr=tkb?.[thu]?.[buoi]||[]; for(let ti=0; ti<arr.length; ti++){
        const v=arr[ti]; if(v==='OFF'||!v) continue; const mon=cellMonSafe(v); if(!mon) continue;
        const teacher=teacherOf(lopId,mon); const room=roomOf(lopId,mon); const cell={lopId:String(lopId),mon,thu,buoi,ti:Number(ti),teacher,room,location:roomLocation(room,lopId),fixed:isFixedSafe(v)};
        __cache.allCells.push(cell); classArr.push(cell);
        if(teacher){ const k=String(teacher).trim(); if(!__cache.byTeacher.has(k)) __cache.byTeacher.set(k,[]); __cache.byTeacher.get(k).push(cell); }
      }}
      __cache.classCells.set(String(lopId), classArr);
    }
    return __cache;
  }
  function buildMustTeachTeacherIndex(){
    // buildScheduleIndex uses the same lesson/teacher inclusion rules and its
    // cells contain every field required by the must-teach post-validation.
    // Reuse it so validation does not perform another unsliced timetable scan.
    return buildScheduleIndex().byTeacher || new Map();
  }
  function isSameSlotCell(cell, slot){ return !!slot && String(cell.lopId)===String(slot.lopId) && String(cell.thu)===String(slot.thu) && String(cell.buoi)===String(slot.buoi) && Number(cell.ti)===Number(slot.ti); }
  function targetSlotFromCtx(ctx){ return ctx ? {lopId:String(ctx.lopId||currentClassId()||''),thu:String(ctx.thu||''),buoi:String(ctx.buoi||''),ti:Number(ctx.ti)} : null; }
  function candidateCellFromCtx(ctx){ if(!ctx||!ctx.mon) return null; const t=targetSlotFromCtx(ctx); if(!t||!t.lopId) return null; const mon=String(ctx.mon||'').trim(); const teacher=teacherOf(t.lopId,mon); const room=roomOf(t.lopId,mon); return {lopId:t.lopId,mon,thu:t.thu,buoi:t.buoi,ti:t.ti,teacher,room,location:roomLocation(room,t.lopId),candidate:true}; }
  function scanClassCellsFromTkb(lopId, tkb){
    const out=[]; if(!tkb) return out;
    for(const thu of days()) for(const buoi of SESSION_KEYS){ const arr=tkb?.[thu]?.[buoi]||[]; for(let ti=0; ti<arr.length; ti++){
      const v=arr[ti]; if(v==='OFF'||!v) continue; const mon=cellMonSafe(v); if(!mon) continue; const teacher=teacherOf(lopId,mon); const room=roomOf(lopId,mon); out.push({lopId:String(lopId),mon,thu,buoi,ti:Number(ti),teacher,room,location:roomLocation(room,lopId),fixed:isFixedSafe(v)});
    }}
    return out;
  }
  function sourceSlotFromCtx(ctx){ return sourceFromCtx(ctx||{}); }
  function classCellsAfterPlace(lopId, ctx, pred){
    const target=targetSlotFromCtx(Object.assign({},ctx||{},{lopId})); const src=sourceSlotFromCtx(ctx||{});
    let base;
    if(ctx && ctx.localTkb && String(lopId)===String(ctx.lopId||currentClassId())) base=scanClassCellsFromTkb(lopId,ctx.localTkb);
    else base=buildScheduleIndex().classCells.get(String(lopId))||[];
    const cand=candidateCellFromCtx(Object.assign({},ctx||{},{lopId})); const out=[];
    for(const cell of base){ if(isSameSlotCell(cell,src)||isSameSlotCell(cell,target)) continue; if(!pred||pred(cell)) out.push(cell); }
    if(cand && (!pred||pred(cand))) out.push(cand);
    return out;
  }
  /* ===================== SCHEDULE SCAN ===================== */
  function currentClassId(){ try{ if(typeof currentLop !== 'undefined' && currentLop != null) return String(currentLop); }catch(_){ } return String(window.currentLop || ''); }
  function inferClassIdFromTkb(ref){
    // Khi sapXepTuDongAll() chạy toàn trường, currentLop thường vẫn là lớp đang xem,
    // không phải lớp đang được engine xếp. Phải suy ngược classId từ object TKB truyền vào.
    try{
      if(!ref || !D().tkb) return '';
      for(const id of Object.keys(D().tkb || {})){
        if(D().tkb[id] === ref) return String(id);
      }
    }catch(_){ }
    return '';
  }
  function sourceFromCtx(ctx){ const s=ctx && ctx.src; if(!s) return null; return {lopId:String(ctx.lopId||currentClassId()||''), thu:String(s.thu||''), buoi:String(s.buoi||''), ti:Number(s.ti)}; }
  function getTkbForClass(lopId, ctx){ if(ctx && ctx.localTkb && String(lopId)===String(ctx.lopId || currentClassId())) return ctx.localTkb; return D().tkb?.[lopId]; }
  function allCellsAfterPlace(ctx, filterFn){
    const target=targetSlotFromCtx(ctx||{}); const src=sourceSlotFromCtx(ctx||{}); const cand=candidateCellFromCtx(ctx||{});
    let base=buildScheduleIndex().allCells || []; let local=[];
    if(ctx && ctx.localTkb && target && target.lopId){ base=base.filter(x=>String(x.lopId)!==String(target.lopId)); local=scanClassCellsFromTkb(target.lopId,ctx.localTkb); }
    const out=[];
    for(const cell of base.concat(local)){
      if(isSameSlotCell(cell,src)||isSameSlotCell(cell,target)) continue;
      if(!filterFn||filterFn(cell)) out.push(cell);
    }
    if(cand && (!filterFn||filterFn(cand))) out.push(cand);
    return out;
  }
  function countBy(cells,pred){ let n=0; cells.forEach(x=>{ if(pred(x)) n++; }); return n; }
  function uniqueCount(cells,fn){ const s=new Set(); cells.forEach(x=>{ const v=fn(x); if(v) s.add(v); }); return s.size; }
  function sessionCells(cells, thu, buoi){ return cells.filter(x=>x.thu===thu && x.buoi===buoi); }
  function indexesInSession(cells, thu, buoi, pred){ return cells.filter(x=>x.thu===thu && x.buoi===buoi && (!pred || pred(x))).map(x=>Number(x.ti)).sort((a,b)=>a-b); }
  function countConsecutiveBlocks(indexes, len){ let c=0; const s=new Set(indexes); for(const i of indexes){ let ok=true; for(let k=0;k<len;k++) if(!s.has(i+k)) ok=false; if(ok && !s.has(i-1)) c++; } return c; }
  function hasConsecutivePair(indexes){ const s=new Set(indexes); for(const i of indexes) if(s.has(i+1)) return true; return false; }
  function dayIndex(thu){ const i=days().indexOf(thu); return i>=0 ? i : 0; }

  /* ===================== FIXED OFF ===================== */
  function isFixedOff(type, id, thu, buoi, ti){ const obj=model().fixedOff?.[type]?.[id] || {}; return !!obj[slotKey(thu,buoi,ti)]; }
  function evalFixedOff(ctx){
    const msgs=[]; if(!ctx || !ctx.mon || !ctx.thu || !ctx.buoi || ctx.ti == null) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); const mon=String(ctx.mon||'').trim(); const thu=String(ctx.thu), buoi=String(ctx.buoi), ti=Number(ctx.ti);
    const gv=teacherOf(lopId,mon); const room=roomOf(lopId,mon);
    if(isFixedOff('class',lopId,thu,buoi,ti)) msgs.push(`Lớp ${classNameOf(lopId)} đã cố định ${dayLabel(thu)} ${SESSION_LABEL[buoi]} tiết ${ti+1}.`);
    if(gv && isFixedOff('teacher',gv,thu,buoi,ti)) msgs.push(`${teacherName(gv)} đã cố định ${dayLabel(thu)} ${SESSION_LABEL[buoi]} tiết ${ti+1}.`);
    const sk=subjectKey(mon); if(sk && isFixedOff('subject',sk,thu,buoi,ti)) msgs.push(`Môn ${mon} đã cố định ${dayLabel(thu)} ${SESSION_LABEL[buoi]} tiết ${ti+1}.`);
    subjectGroupsOf(mon).forEach(gid=>{
      if(isFixedOff('subjectGroup',gid,thu,buoi,ti)){
        const g=model().groups.subject?.[gid];
        msgs.push(`Nhóm môn ${g?.name || gid} đã cố định ${dayLabel(thu)} ${SESSION_LABEL[buoi]} tiết ${ti+1}.`);
      }
    });
    if(room && isFixedOff('room',room,thu,buoi,ti)) msgs.push(`Phòng ${room} đã cố định ${dayLabel(thu)} ${SESSION_LABEL[buoi]} tiết ${ti+1}.`);
    return msgs;
  }

  /* ===================== TEACHER ENGINE ===================== */
  function teacherCellsAfterPlace(teacher, ctx){
    const gv=String(teacher||'').trim(); if(!gv) return [];
    const idx=buildScheduleIndex(); const target=targetSlotFromCtx(ctx||{}); const src=sourceSlotFromCtx(ctx||{});
    let base=idx.byTeacher.get(gv)||[]; let local=[];
    if(ctx && ctx.localTkb && target && target.lopId){ base=base.filter(x=>String(x.lopId)!==String(target.lopId)); local=scanClassCellsFromTkb(target.lopId,ctx.localTkb).filter(x=>String(x.teacher||'').trim()===gv); }
    const cand=candidateCellFromCtx(ctx||{}); const out=[];
    for(const cell of base.concat(local)){ if(isSameSlotCell(cell,src)||isSameSlotCell(cell,target)) continue; out.push(cell); }
    if(cand && String(cand.teacher||'').trim()===gv) out.push(cand);
    return out;
  }
  function evalTeacherRule(ctx){
    const msgs=[]; if(!ctx || !ctx.mon || !ctx.thu || !ctx.buoi || ctx.ti == null) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); if(!lopId) return msgs; const mon=String(ctx.mon||'').trim(); const gv=teacherOf(lopId,mon); if(!gv) return msgs;
    const r=model().teacher?.[gv]; if(!r || typeof r!=='object') return msgs;
    const cells=teacherCellsAfterPlace(gv,Object.assign({},ctx,{lopId,mon})); const thu=String(ctx.thu), buoi=String(ctx.buoi); const label=teacherName(gv); const add=m=>{ if(m && !msgs.includes(m)) msgs.push(m); };
    const maxDays=toInt(r.maxDaysSessions?.maxDays,0), maxSessions=toInt(r.maxDaysSessions?.maxSessions,0);
    if(maxDays>0){ const n=uniqueCount(cells,x=>x.thu); if(n>maxDays) add(`${label}: vượt giới hạn số ngày dạy/tuần (${n}/${maxDays}).`); }
    if(maxSessions>0){ const n=uniqueCount(cells,x=>x.thu+'|'+x.buoi); if(n>maxSessions) add(`${label}: vượt giới hạn số buổi dạy/tuần (${n}/${maxSessions}).`); }
    const limSess=toInt(getPath(r,`maxPeriods.${buoi}.${thu}`,0),0); if(limSess>0){ const n=countBy(cells,x=>x.thu===thu&&x.buoi===buoi); if(n>limSess) add(`${label}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} có ${n} tiết, vượt giới hạn ${limSess}.`); }
    const limDay=toInt(getPath(r,`maxPeriods.day.${thu}`,0),0); if(limDay>0){ const n=countBy(cells,x=>x.thu===thu); if(n>limDay) add(`${label}: ${dayLabel(thu)} có ${n} tiết, vượt giới hạn cả ngày ${limDay}.`); }
    const maxMorning=toInt(r.maxMorningAfternoon?.morning,0), maxAfternoon=toInt(r.maxMorningAfternoon?.afternoon,0);
    if(maxMorning>0){ const n=uniqueCount(cells.filter(x=>x.buoi==='sang'),x=>x.thu+'|'+x.buoi); if(n>maxMorning) add(`${label}: dạy ${n} buổi sáng/tuần, vượt giới hạn ${maxMorning}.`); }
    if(maxAfternoon>0){ const n=uniqueCount(cells.filter(x=>x.buoi==='chieu'),x=>x.thu+'|'+x.buoi); if(n>maxAfternoon) add(`${label}: dạy ${n} buổi chiều/tuần, vượt giới hạn ${maxAfternoon}.`); }
    if(truthy(r.oneSessionPerDay?.[thu])){ const hasS=cells.some(x=>x.thu===thu&&x.buoi==='sang'), hasC=cells.some(x=>x.thu===thu&&x.buoi==='chieu'); if(hasS&&hasC) add(`${label}: ${dayLabel(thu)} đang bật chỉ dạy 1 buổi/ngày nhưng có cả sáng và chiều.`); }
    if(truthy(r.noMorningP5AfternoonP1?.[thu]) || truthy(r.noMorningP5AfternoonP1?.sang?.[thu]) || truthy(r.noMorningP5AfternoonP1?.chieu?.[thu])){ const hasP5=cells.some(x=>x.thu===thu&&x.buoi==='sang'&&Number(x.ti)===4), hasP1C=cells.some(x=>x.thu===thu&&x.buoi==='chieu'&&Number(x.ti)===0); if(hasP5&&hasP1C) add(`${label}: ${dayLabel(thu)} vi phạm không dạy tiết 5 sáng và tiết 1 chiều.`); }
    for(const ruleName of ['oneLocationPerSession','gapBetweenLocations','maxOneMovePerSession']){
      if(!truthy(getPath(r,`${ruleName}.${buoi}.${thu}`,false))) continue;
      const ss=sessionCells(cells,thu,buoi).slice().sort((a,b)=>a.ti-b.ti); const withLoc=ss.map(x=>Object.assign({},x,{loc:String(x.location||x.room||'').trim()})).filter(x=>x.loc); if(withLoc.length<=1) continue;
      if(ruleName==='oneLocationPerSession'){ const n=uniqueCount(withLoc,x=>norm(x.loc)); if(n>1) add(`${label}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} vi phạm chỉ dạy 1 địa điểm/1 buổi.`); }
      if(ruleName==='gapBetweenLocations'){ for(let i=1;i<withLoc.length;i++){ if(norm(withLoc[i].loc)!==norm(withLoc[i-1].loc)&&(Number(withLoc[i].ti)-Number(withLoc[i-1].ti)<=1)){ add(`${label}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} đổi địa điểm nhưng không có tiết trống để di chuyển.`); break; } } }
      if(ruleName==='maxOneMovePerSession'){ const seq=[]; withLoc.forEach(x=>{ const v=norm(x.loc); if(v && seq[seq.length-1]!==v) seq.push(v); }); if(seq.length>2) add(`${label}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} vi phạm không di chuyển 2 lần/1 buổi giữa các địa điểm.`); }
    }
    return msgs;
  }

  /* ===================== SUBJECT ENGINE ===================== */
  function subjectRuleObj(mon){ return model().subject?.[subjectKey(mon)] || {}; }
  function byClassRule(obj, lopId){ return obj?.byClass?.[lopId] || {}; }
  function byClassRuleAny(obj, ids){
    const byClass = obj?.byClass;
    if(!byClass || typeof byClass !== 'object') return {};
    const candidates = arrUnique(ids || []).map(x=>String(x || '').trim()).filter(Boolean);
    for(const id of candidates){
      const direct = byClass[id];
      if(direct && typeof direct === 'object') return direct;
    }
    const wanted = new Set(candidates.flatMap(id=>[norm(id), norm(normalizeClassLike(id))]));
    for(const [id, rule] of Object.entries(byClass)){
      if(!rule || typeof rule !== 'object') continue;
      if(wanted.has(norm(id)) || wanted.has(norm(normalizeClassLike(id)))) return rule;
    }
    return {};
  }
  function subjectCellsAfterPlace(lopId, mon, ctx){ return classCellsAfterPlace(lopId, ctx, x=>subjectMatches(x.mon, mon)); }
  function evalSubjectRule(ctx){
    const msgs=[]; if(!ctx || !ctx.mon || !ctx.thu || !ctx.buoi || ctx.ti == null) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); if(!lopId) return msgs; const mon=String(ctx.mon||'').trim(); const thu=String(ctx.thu), buoi=String(ctx.buoi), ti=Number(ctx.ti);
    const sobj=subjectRuleObj(mon); const r=byClassRule(sobj, lopId); if(!r || !Object.keys(r).length) return msgs;
    const cells=subjectCellsAfterPlace(lopId, mon, Object.assign({},ctx,{lopId,mon})); const add=m=>{ if(m && !msgs.includes(m)) msgs.push(m); };
    const name=`${classNameOf(lopId)} - ${mon}`;
    // giới hạn buổi học
    if(r.sessionAllowed){
      const allowS = r.sessionAllowed.allowMorning !== false;
      const allowC = r.sessionAllowed.allowAfternoon !== false;
      if(buoi==='sang' && !allowS) add(`${name}: môn học không được học buổi sáng.`);
      if(buoi==='chieu' && !allowC) add(`${name}: môn học không được học buổi chiều.`);
      if(truthy(r.sessionAllowed.oneSessionPerDay)){ const hasS=cells.some(x=>x.thu===thu&&x.buoi==='sang'), hasC=cells.some(x=>x.thu===thu&&x.buoi==='chieu'); if(hasS&&hasC) add(`${name}: chỉ học 1 buổi/ngày nhưng có cả sáng và chiều.`); }
    }
    // giới hạn số tiết sáng/chiều/tuần
    const wS=toInt(r.weeklySessionPeriods?.morning,0), wC=toInt(r.weeklySessionPeriods?.afternoon,0);
    if(wS>0){ const n=countBy(cells,x=>x.buoi==='sang'); if(n>wS) add(`${name}: số tiết buổi sáng/tuần ${n} vượt giới hạn ${wS}.`); }
    if(wC>0){ const n=countBy(cells,x=>x.buoi==='chieu'); if(n>wC) add(`${name}: số tiết buổi chiều/tuần ${n} vượt giới hạn ${wC}.`); }
    // học cách ngày
    const spacing=toInt(r.spacingDays?.days,0); if(spacing>0){
      const ds=Array.from(new Set(cells.map(x=>x.thu))).map(dayIndex).sort((a,b)=>a-b);
      for(let i=1;i<ds.length;i++){ if(ds[i]-ds[i-1] <= spacing){ add(`${name}: vi phạm học cách ${spacing} ngày.`); break; } }
    }
    // số tiết / buổi và ngày
    const limSess=toInt(getPath(r,`maxPeriods.${buoi}`,0),0); if(limSess>0){ const n=countBy(cells,x=>x.thu===thu&&x.buoi===buoi); if(n>limSess) add(`${name}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} có ${n} tiết, vượt giới hạn ${limSess}.`); }
    const limDay=dayLimitValue(r,'maxPeriods.day',thu); if(limDay>0){ const n=countBy(cells,x=>x.thu===thu); if(n>limDay) add(`${name}: ${dayLabel(thu)} có ${n} tiết, vượt giới hạn cả ngày ${limDay}.`); }
    // số buổi học
    const maxS=toInt(r.maxSessions?.morning,0), maxC=toInt(r.maxSessions?.afternoon,0), maxAll=toInt(r.maxSessions?.day,0);
    if(maxS>0){ const n=uniqueCount(cells.filter(x=>x.buoi==='sang'),x=>x.thu+'|'+x.buoi); if(n>maxS) add(`${name}: số buổi sáng học môn ${n} vượt giới hạn ${maxS}.`); }
    if(maxC>0){ const n=uniqueCount(cells.filter(x=>x.buoi==='chieu'),x=>x.thu+'|'+x.buoi); if(n>maxC) add(`${name}: số buổi chiều học môn ${n} vượt giới hạn ${maxC}.`); }
    if(maxAll>0){ const n=uniqueCount(cells,x=>x.thu+'|'+x.buoi); if(n>maxAll) add(`${name}: số buổi học trong tuần ${n} vượt giới hạn ${maxAll}.`); }
    // tránh xếp liền qua giờ ra chơi 2-3 hoặc 3-4
    { const idx=indexesInSession(cells,thu,buoi); const s=new Set(idx); const legacy=!!r.avoidBreakPairs; const oldOn=legacy && ((buoi==='sang' && truthy(r.avoidBreakPairs.morning)) || (buoi==='chieu' && truthy(r.avoidBreakPairs.afternoon))); const on23=oldOn || truthy(getPath(r,`avoidBreakPair23.${buoi==='sang'?'morning':'afternoon'}`,false)); const on34=oldOn || truthy(getPath(r,`avoidBreakPair34.${buoi==='sang'?'morning':'afternoon'}`,false)); if(on23 && s.has(1)&&s.has(2)) add(`${name}: tránh xếp liền tiết 2-3 ${SESSION_LABEL[buoi].toLowerCase()}.`); if(on34 && s.has(2)&&s.has(3)) add(`${name}: tránh xếp liền tiết 3-4 ${SESSION_LABEL[buoi].toLowerCase()}.`); }
    // linkedDays: checked day/session means avoid consecutive lessons there.
    if(r.linkedDays){ const idx=indexesInSession(cells,thu,buoi); if(hasConsecutivePair(idx) && linkedDayAvoided(r.linkedDays,buoi,thu)) add(`${name}: tránh xếp tiết liền vào ${dayLabel(thu)} ${SESSION_LABEL[buoi]}.`); }
    // tiết học xếp liền min/max: kiểm max khi đặt, min để validateAll báo sau
    if(r.lessonBlocks){ for(const len of [2,3,4,5]){ const max=toInt(r.lessonBlocks?.[len]?.max,0); if(max>0){ let blocks=0; for(const d of days()) for(const b of SESSION_KEYS){ const idx=indexesInSession(cells,d,b); blocks += countConsecutiveBlocks(idx,len); } if(blocks>max) add(`${name}: số buổi/cụm có ${len} tiết xếp liền vượt Max ${max}.`); } } }
    return msgs;
  }

  /* ===================== SUBJECT GROUP ENGINE ===================== */
  function groupCellsAfterPlace(lopId, groupId, ctx){ return classCellsAfterPlace(lopId, ctx, x=>subjectInGroup(x.mon, groupId)); }
  function evalSubjectGroupRule(ctx){
    const msgs=[]; if(!ctx || !ctx.mon || !ctx.thu || !ctx.buoi || ctx.ti == null) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); if(!lopId) return msgs; const mon=String(ctx.mon||'').trim(); const thu=String(ctx.thu), buoi=String(ctx.buoi);
    for(const gid of subjectGroupsOf(mon)){
      const obj=model().subjectGroup?.[gid]; const r=byClassRule(obj, lopId); if(!r || !Object.keys(r).length) continue;
      const gname=model().groups.subject?.[gid]?.name || gid; const cells=groupCellsAfterPlace(lopId,gid,Object.assign({},ctx,{lopId,mon})); const name=`${classNameOf(lopId)} - nhóm ${gname}`; const add=m=>{ if(m && !msgs.includes(m)) msgs.push(m); };
      if(r.sessionAllowed){ const allowS=r.sessionAllowed.allowMorning!==false, allowC=r.sessionAllowed.allowAfternoon!==false; if(buoi==='sang'&&!allowS) add(`${name}: không được học buổi sáng.`); if(buoi==='chieu'&&!allowC) add(`${name}: không được học buổi chiều.`); if(truthy(r.sessionAllowed.oneSessionPerDay)){ const hasS=cells.some(x=>x.thu===thu&&x.buoi==='sang'), hasC=cells.some(x=>x.thu===thu&&x.buoi==='chieu'); if(hasS&&hasC) add(`${name}: chỉ học 1 buổi/ngày nhưng có cả sáng và chiều.`); } }
      const wS=toInt(r.weeklySessionPeriods?.morning,0), wC=toInt(r.weeklySessionPeriods?.afternoon,0); if(wS>0){ const n=countBy(cells,x=>x.buoi==='sang'); if(n>wS) add(`${name}: số tiết sáng/tuần ${n} vượt ${wS}.`); } if(wC>0){ const n=countBy(cells,x=>x.buoi==='chieu'); if(n>wC) add(`${name}: số tiết chiều/tuần ${n} vượt ${wC}.`); }
      const limSess=toInt(getPath(r,`maxPeriods.${buoi}`,0),0); if(limSess>0){ const n=countBy(cells,x=>x.thu===thu&&x.buoi===buoi); if(n>limSess) add(`${name}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} có ${n} tiết, vượt giới hạn ${limSess}.`); }
      const limDay=dayLimitValue(r,'maxPeriods.day',thu); if(limDay>0){ const n=countBy(cells,x=>x.thu===thu); if(n>limDay) add(`${name}: ${dayLabel(thu)} có ${n} tiết, vượt giới hạn cả ngày ${limDay}.`); }
      const subSess=toInt(getPath(r,`maxSubjects.${buoi}`,0),0); if(subSess>0){ const n=uniqueCount(cells.filter(x=>x.thu===thu&&x.buoi===buoi),x=>norm(x.mon)); if(n>subSess) add(`${name}: ${dayLabel(thu)} ${SESSION_LABEL[buoi]} có ${n} môn khác nhau, vượt ${subSess}.`); }
      const subDay=toInt(getPath(r,'maxSubjects.day',0),0); if(subDay>0){ const n=uniqueCount(cells.filter(x=>x.thu===thu),x=>norm(x.mon)); if(n>subDay) add(`${name}: ${dayLabel(thu)} có ${n} môn khác nhau, vượt ${subDay}.`); }
      const maxS=toInt(r.maxSessions?.morning,0), maxC=toInt(r.maxSessions?.afternoon,0), maxAll=toInt(r.maxSessions?.day,0); if(maxS>0){ const n=uniqueCount(cells.filter(x=>x.buoi==='sang'),x=>x.thu+'|'+x.buoi); if(n>maxS) add(`${name}: số buổi sáng ${n} vượt ${maxS}.`); } if(maxC>0){ const n=uniqueCount(cells.filter(x=>x.buoi==='chieu'),x=>x.thu+'|'+x.buoi); if(n>maxC) add(`${name}: số buổi chiều ${n} vượt ${maxC}.`); } if(maxAll>0){ const n=uniqueCount(cells,x=>x.thu+'|'+x.buoi); if(n>maxAll) add(`${name}: số buổi học ${n} vượt ${maxAll}.`); }
    }
    return msgs;
  }

  /* ===================== GLOBAL LIMIT ENGINE ===================== */
  function matchLimitRule(cell, rule){
    if(!rule || !rule.targetType) return false;
    if(rule.targetType === 'subject') return subjectMatches(cell.mon, rule.targetId);
    if(rule.targetType === 'subjectGroup') return subjectInGroup(cell.mon, rule.targetId);
    if(rule.targetType === 'teacherGroup') return groupItems('teacher', rule.targetId).includes(String(cell.teacher||''));
    if(rule.targetType === 'classGroup') return groupItems('class', rule.targetId).includes(String(cell.lopId||''));
    if(rule.targetType === 'roomGroup') return groupItems('room', rule.targetId).includes(String(cell.room||''));
    return false;
  }
  function timeLimitSlotLimit(rule, field, buoi, thu){
    let val=getPath(rule, `perSlotBySession.${field}.${buoi}.${thu}`, null);
    if(val != null && val !== ''){
      const n=toInt(val,0);
      if(n>0) return n;
    }
    val=getPath(rule, `perSlotBySession.${buoi}.${thu}`, null);
    if(val != null && val !== ''){
      const n=toInt(val,0);
      if(n>0) return n;
    }
    return toInt(rule?.perSlot?.[field],0);
  }
  function evalTimeLimit(ctx){
    const msgs=[]; const rules=model().timeLimit || []; if(!rules.length || !ctx || !ctx.mon) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); const mon=String(ctx.mon||'').trim(); const thu=String(ctx.thu), buoi=String(ctx.buoi), ti=Number(ctx.ti);
    const all=allCellsAfterPlace(Object.assign({},ctx,{lopId,mon}));
    rules.forEach(rule=>{
      if(!matchLimitRule({lopId,mon,teacher:teacherOf(lopId,mon),room:roomOf(lopId,mon)}, rule)) return;
      const label=rule.name || 'Giới hạn số tiết/1 thời điểm';
      const cellsSlot=all.filter(x=>x.thu===thu&&x.buoi===buoi&&Number(x.ti)===ti&&matchLimitRule(x,rule));
      const cellsSess=all.filter(x=>x.thu===thu&&x.buoi===buoi&&matchLimitRule(x,rule));
      function chk(scope, cells){
        const conf=rule[scope] || {}; const suffix=scope==='perSlot'?'1 tiết':'1 buổi';
        const maxClass=scope==='perSlot'?timeLimitSlotLimit(rule,'classes',buoi,thu):toInt(conf.classes,0); if(maxClass>0){ const n=uniqueCount(cells,x=>x.lopId); if(n>maxClass) msgs.push(`${label}: số lớp/${suffix} = ${n}, vượt ${maxClass}.`); }
        const maxTeacher=scope==='perSlot'?timeLimitSlotLimit(rule,'teachers',buoi,thu):toInt(conf.teachers,0); if(maxTeacher>0){ const n=uniqueCount(cells,x=>x.teacher); if(n>maxTeacher) msgs.push(`${label}: số giáo viên/${suffix} = ${n}, vượt ${maxTeacher}.`); }
        const maxRoom=scope==='perSlot'?timeLimitSlotLimit(rule,'rooms',buoi,thu):toInt(conf.rooms,0); if(maxRoom>0){ const n=uniqueCount(cells,x=>x.room); if(n>maxRoom) msgs.push(`${label}: số phòng/${suffix} = ${n}, vượt ${maxRoom}.`); }
        const maxSubject=scope==='perSlot'?timeLimitSlotLimit(rule,'subjects',buoi,thu):toInt(conf.subjects,0); if(maxSubject>0){ const n=uniqueCount(cells,x=>subjectKey(x.mon)); if(n>maxSubject) msgs.push(`${label}: số môn/${suffix} = ${n}, vượt ${maxSubject}.`); }
      }
      chk('perSlot', cellsSlot); chk('perSession', cellsSess);
    });
    return msgs;
  }
  function hasGlobalLimit(conf){
    if(!conf || typeof conf !== 'object') return false;
    const ps=conf.perSlot||{}, pe=conf.perSession||{};
    return toInt(ps.classes,0)>0 || toInt(ps.teachers,0)>0 || toInt(ps.rooms,0)>0 || toInt(pe.classes,0)>0 || toInt(pe.teachers,0)>0 || toInt(pe.rooms,0)>0;
  }
  function evalGlobalLimitFromSubject(ctx){
    const msgs=[]; if(!ctx || !ctx.mon) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); const mon=String(ctx.mon||'').trim(); const thu=String(ctx.thu), buoi=String(ctx.buoi), ti=Number(ctx.ti);
    const sk=subjectKey(mon); const sr=model().subject?.[sk]?.globalLimit || {};
    const activeGroups=subjectGroupsOf(mon).map(gid=>({gid,conf:model().subjectGroup?.[gid]?.globalLimit||{}})).filter(x=>hasGlobalLimit(x.conf));
    if(!hasGlobalLimit(sr) && !activeGroups.length) return msgs;
    const all=allCellsAfterPlace(Object.assign({},ctx,{lopId,mon}));
    function check(conf,label,matcher){
      if(!hasGlobalLimit(conf)) return;
      const slot=all.filter(x=>x.thu===thu&&x.buoi===buoi&&Number(x.ti)===ti&&matcher(x));
      const sess=all.filter(x=>x.thu===thu&&x.buoi===buoi&&matcher(x));
      for(const [scope,cells] of [['perSlot',slot],['perSession',sess]]){ const c=conf[scope]||{}; const suffix=scope==='perSlot'?'1 tiết':'1 buổi'; const mc=toInt(c.classes,0); if(mc>0 && uniqueCount(cells,x=>x.lopId)>mc) msgs.push(`${label}: vượt giới hạn số lớp học/${suffix}.`); const mt=toInt(c.teachers,0); if(mt>0 && uniqueCount(cells,x=>x.teacher)>mt) msgs.push(`${label}: vượt giới hạn số giáo viên/${suffix}.`); const mr=toInt(c.rooms,0); if(mr>0 && uniqueCount(cells,x=>x.room)>mr) msgs.push(`${label}: vượt giới hạn số phòng học/${suffix}.`); }
    }
    check(sr, `Môn ${mon}`, x=>subjectMatches(x.mon,mon));
    for(const it of activeGroups){ const gname=model().groups.subject?.[it.gid]?.name || it.gid; check(it.conf, `Nhóm môn ${gname}`, x=>subjectInGroup(x.mon,it.gid)); }
    return msgs;
  }
  function evalSubjectNoSameRule(ctx, rule){
    const msgs=[]; if(!ctx || !ctx.mon || !ctx.thu || !ctx.buoi) return msgs;
    const lopId=String(ctx.lopId||currentClassId()||''); if(!lopId) return msgs;
    const mon=String(ctx.mon||'').trim();
    const gids=noSameGroupIdsForSubject(rule, lopId, mon);
    if(!gids.length) return msgs;
    const cells=classCellsAfterPlace(lopId, Object.assign({},ctx,{lopId,mon}));
    gids.forEach(gid=>{
      const items=noSameGroupItems(rule, lopId, gid);
      if(items.length < 2) return;
      const subjects=Array.from(new Set(cells.filter(x=>String(x.thu)===String(ctx.thu)&&(rule==='noSameDay'||String(x.buoi)===String(ctx.buoi))&&items.some(it=>subjectMatches(it,x.mon))).map(x=>subjectKey(x.mon))));
      if(subjects.length > 1){
        const names=subjects.map(subjectDisplayName).join(', ');
        const scope=rule==='noSameDay' ? dayLabel(ctx.thu) : `${dayLabel(ctx.thu)} ${SESSION_LABEL[ctx.buoi]}`;
        msgs.push(`${classNameOf(lopId)} ${scope}: các môn ${names} không được học ${rule==='noSameDay'?'cùng ngày':'cùng buổi'}.`);
      }
    });
    return msgs;
  }

  /* ===================== PUBLIC ENGINE ===================== */
  function _hotPathMode(ctx){
    const m = String(ctx?.mode || '').trim();
    return !(ctx && ctx.full === true) && (m === 'drag' || m === 'auto' || m === 'move' || !m);
  }
  function _hasAnyConstraint(){
    const c = model();
    return Object.keys(c.teacher || {}).length || Object.keys(c.subject || {}).length ||
      Object.keys(c.subjectGroup || {}).length || Object.keys(c.fixedOff?.class || {}).length ||
      Object.keys(c.fixedOff?.teacher || {}).length || Object.keys(c.fixedOff?.subject || {}).length ||
      Object.keys(c.fixedOff?.room || {}).length || (c.timeLimit || []).length ||
      noSameActiveGroupCount() > 0;
  }
  function canPlaceLesson(ctx){
    const messages=[]; function addAll(arr){ (arr||[]).forEach(m=>{ if(m && !messages.includes(m)) messages.push(m); }); }
    if(!ctx || !ctx.mon || !_hasAnyConstraint()) return {ok:true, messages};
    const hot = _hotPathMode(ctx);
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    function tooSlow(){
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      return hot && (now - t0 > 24);
    }
    try{ addAll(evalFixedOff(ctx)); }catch(e){ console.warn('[tkb-constraints] fixed off eval failed', e); }
    if(tooSlow()) return {ok:messages.length===0, messages};
    try{ addAll(evalTeacherRule(ctx)); }catch(e){ console.warn('[tkb-constraints] teacher eval failed', e); }
    if(tooSlow()) return {ok:messages.length===0, messages};
    try{ addAll(evalSubjectRule(ctx)); }catch(e){ console.warn('[tkb-constraints] subject eval failed', e); }
    if(tooSlow()) return {ok:messages.length===0, messages};
    try{ addAll(evalSubjectNoSameRule(ctx,'noSameSession')); }catch(e){ console.warn('[tkb-constraints] subject no-same-session eval failed', e); }
    if(tooSlow()) return {ok:messages.length===0, messages};
    try{ addAll(evalSubjectNoSameRule(ctx,'noSameDay')); }catch(e){ console.warn('[tkb-constraints] subject no-same-day eval failed', e); }
    if(tooSlow()) return {ok:messages.length===0, messages};
    try{ addAll(evalSubjectGroupRule(ctx)); }catch(e){ console.warn('[tkb-constraints] subject group eval failed', e); }
    // Các yêu cầu global/timeLimit quét toàn trường. Không chạy trong hot path để tránh đứng khi quay lại sắp xếp.
    // Chúng vẫn được kiểm tra đầy đủ bằng nút Kiểm tra yêu cầu / validateAll(full=true).
    if(!hot){
      try{ addAll(evalGlobalLimitFromSubject(ctx)); }catch(e){ console.warn('[tkb-constraints] global subject limit eval failed', e); }
      try{ addAll(evalTimeLimit(ctx)); }catch(e){ console.warn('[tkb-constraints] time limit eval failed', e); }
    }
    return {ok:messages.length===0, messages};
  }
  function canPlaceCell(lopId, mon, thu, buoi, ti, opts){ return canPlaceLesson(Object.assign({}, opts || {}, {lopId, mon, thu, buoi, ti:Number(ti)})); }
  function validateAll(maxItems){
    invalidateConstraintCache();
    const max=Number(maxItems||1000); const out=[]; const seen=new Set();
    function add(item){ if(!item || out.length>=max) return; const key=[item.lopId||'',item.mon||'',item.thu||'',item.buoi||'',item.ti,item.message||''].join('|'); if(seen.has(key)) return; seen.add(key); out.push(item); }
    const tkbs=D().tkb || {};
    for(const lopId of Object.keys(tkbs)){ const tkb=tkbs[lopId]; for(const thu of days()) for(const buoi of SESSION_KEYS){ const arr=tkb?.[thu]?.[buoi]||[]; for(let ti=0;ti<arr.length;ti++){ const v=arr[ti]; if(v==='OFF'||!v) continue; const mon=cellMonSafe(v); if(!mon) continue; const res=canPlaceLesson({lopId,mon,thu,buoi,ti,full:true,mode:'validate'}); (res.messages||[]).forEach(message=>add({lopId,className:classNameOf(lopId),mon,thu,buoi,ti,message})); if(out.length>=max) return out; } } }
    // hậu kiểm vị trí bắt buộc phải có tiết dạy của giáo viên
    try{
      const byTeacher=buildMustTeachTeacherIndex();
      Object.entries(model().teacher || {}).forEach(([tid,rule])=>{
        const slots=rule?.mustTeach || {};
        const cells=byTeacher.get(String(tid)) || [];
        Object.entries(slots).forEach(([sk,on])=>{
          if(!on) return;
          const p=parseSlotKey(sk);
          const ok=cells.some(x=>String(x.thu)===String(p.thu)&&String(x.buoi)===String(p.buoi)&&Number(x.ti)===Number(p.ti));
          if(!ok) add({lopId:'',className:'',mon:'',thu:p.thu,buoi:p.buoi,ti:p.ti,message:`${teacherName(tid)||tid}: vị trí phải có tiết dạy nhưng chưa được xếp.`});
        });
      });
    }catch(e){ console.warn('[tkb-constraints] teacher must-teach validate failed', e); }
    // hậu kiểm Min số buổi/cụm xếp liền cho môn học
    try{
      const c=model();
      Object.keys(c.subject||{}).forEach(sk=>{ const sobj=c.subject[sk]; Object.keys(sobj.byClass||{}).forEach(lopId=>{ const r=sobj.byClass[lopId]; if(!r.lessonBlocks) return; const cells=subjectCellsAfterPlace(lopId,sk,{lopId,mon:sk}); for(const len of [2,3,4,5]){ const min=toInt(r.lessonBlocks?.[len]?.min,0); if(min>0){ let blocks=0; for(const d of days()) for(const b of SESSION_KEYS) blocks += countConsecutiveBlocks(indexesInSession(cells,d,b),len); if(blocks<min) add({kind:'subject.lessonBlocks.min',lopId,className:classNameOf(lopId),mon:sk,message:`${classNameOf(lopId)} - ${sk}: số buổi/cụm có ${len} tiết xếp liền ${blocks}, chưa đạt Min ${min}.`}); } } }); });
    }catch(e){ console.warn('[tkb-constraints] post validate failed', e); }
    return out;
  }

  function constraintValidationNow(){
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  function yieldConstraintValidation(){
    return new Promise(resolve=>{
      let done=false;
      const resolveOnce=()=>{
        if(done) return;
        done=true;
        resolve();
      };
      try{
        if(typeof window.requestAnimationFrame==='function'){
          window.requestAnimationFrame(()=>{
            try{ window.setTimeout(resolveOnce,0); }
            catch(_){ resolveOnce(); }
          });
          window.setTimeout(resolveOnce,50);
          return;
        }
      }catch(_){ }
      try{ window.setTimeout(resolveOnce,0); }
      catch(_){ resolveOnce(); }
    });
  }

  // The automatic-sort preflight can touch every scheduled cell. Keep the
  // exact validation semantics while yielding between short slices so a large
  // school does not monopolize the main thread immediately after Play.
  async function validateAllAsync(maxItems, options){
    invalidateConstraintCache();
    const max=Number(maxItems||1000); const out=[]; const seen=new Set();
    const dataRef=D();
    const shouldCancel=typeof options?.shouldCancel==='function' ? options.shouldCancel : null;
    const requestedBudget=Number(options?.sliceBudgetMs||8);
    const sliceBudgetMs=Math.max(4,Math.min(16,Number.isFinite(requestedBudget)?requestedBudget:8));
    let sliceStarted=constraintValidationNow();
    function add(item){ if(!item || out.length>=max) return; const key=[item.lopId||'',item.mon||'',item.thu||'',item.buoi||'',item.ti,item.message||''].join('|'); if(seen.has(key)) return; seen.add(key); out.push(item); }
    function interruptionReason(){
      try{ if(shouldCancel && shouldCancel()) return 'cancelled'; }
      catch(_){ }
      try{ if(D()!==dataRef) return 'stale'; }
      catch(_){ }
      return '';
    }
    function interrupted(reason){
      if(reason) out[reason]=true;
      return out;
    }
    async function maybeYield(){
      const before=interruptionReason();
      if(before) return before;
      if(constraintValidationNow()-sliceStarted<sliceBudgetMs) return '';
      await yieldConstraintValidation();
      sliceStarted=constraintValidationNow();
      return interruptionReason();
    }

    const entryInterruption=interruptionReason();
    if(entryInterruption) return interrupted(entryInterruption);

    const tkbs=dataRef.tkb || {};
    for(const lopId of Object.keys(tkbs)){
      const tkb=tkbs[lopId];
      for(const thu of days()) for(const buoi of SESSION_KEYS){
        const arr=tkb?.[thu]?.[buoi]||[];
        for(let ti=0;ti<arr.length;ti++){
          const v=arr[ti];
          if(v==='OFF'||!v){
            const interruption=await maybeYield();
            if(interruption) return interrupted(interruption);
            continue;
          }
          const mon=cellMonSafe(v);
          if(!mon){
            const interruption=await maybeYield();
            if(interruption) return interrupted(interruption);
            continue;
          }
          const res=canPlaceLesson({lopId,mon,thu,buoi,ti,full:true,mode:'validate'});
          (res.messages||[]).forEach(message=>add({lopId,className:classNameOf(lopId),mon,thu,buoi,ti,message}));
          if(out.length>=max) return out;
          const interruption=await maybeYield();
          if(interruption) return interrupted(interruption);
        }
      }
    }

    try{
      const byTeacher=buildMustTeachTeacherIndex();
      for(const [tid,rule] of Object.entries(model().teacher || {})){
        const slots=rule?.mustTeach || {};
        const cells=byTeacher.get(String(tid)) || [];
        for(const [sk,on] of Object.entries(slots)){
          if(!on) continue;
          const p=parseSlotKey(sk);
          const ok=cells.some(x=>String(x.thu)===String(p.thu)&&String(x.buoi)===String(p.buoi)&&Number(x.ti)===Number(p.ti));
          if(!ok) add({lopId:'',className:'',mon:'',thu:p.thu,buoi:p.buoi,ti:p.ti,message:`${teacherName(tid)||tid}: v\u1ecb tr\u00ed ph\u1ea3i c\u00f3 ti\u1ebft d\u1ea1y nh\u01b0ng ch\u01b0a \u0111\u01b0\u1ee3c x\u1ebfp.`});
          if(out.length>=max) return out;
        }
        const interruption=await maybeYield();
        if(interruption) return interrupted(interruption);
      }
    }catch(e){ console.warn('[tkb-constraints] teacher must-teach validate failed', e); }

    try{
      const c=model();
      for(const sk of Object.keys(c.subject||{})){
        const sobj=c.subject[sk];
        for(const lopId of Object.keys(sobj.byClass||{})){
          const r=sobj.byClass[lopId];
          if(!r.lessonBlocks) continue;
          const cells=subjectCellsAfterPlace(lopId,sk,{lopId,mon:sk});
          for(const len of [2,3,4,5]){
            const min=toInt(r.lessonBlocks?.[len]?.min,0);
            if(min<=0) continue;
            let blocks=0;
            for(const d of days()) for(const b of SESSION_KEYS) blocks += countConsecutiveBlocks(indexesInSession(cells,d,b),len);
            if(blocks<min) add({kind:'subject.lessonBlocks.min',lopId,className:classNameOf(lopId),mon:sk,message:`${classNameOf(lopId)} - ${sk}: s\u1ed1 bu\u1ed5i/c\u1ee5m c\u00f3 ${len} ti\u1ebft x\u1ebfp li\u1ec1n ${blocks}, ch\u01b0a \u0111\u1ea1t Min ${min}.`});
            if(out.length>=max) return out;
          }
          const interruption=await maybeYield();
          if(interruption) return interrupted(interruption);
        }
      }
    }catch(e){ console.warn('[tkb-constraints] post validate failed', e); }
    return out;
  }

  /* ===================== UI STYLE ===================== */
  function injectStyle(){
    if(document.getElementById(STYLE_ID)) return;
    const css=document.createElement('style'); css.id=STYLE_ID; css.textContent = `
      #${PANEL_ID}{position:fixed;inset:4vh 3vw;z-index:1000000;background:#fff;border:1px solid #d8dfef;border-radius:10px;box-shadow:0 18px 54px rgba(22,34,66,.24);display:grid;grid-template-rows:auto 1fr;overflow:hidden;font-family:Arial,sans-serif!important;color:#172033}
      #${PANEL_ID},#${PANEL_ID} *{font-family:Arial,sans-serif!important;font-stretch:normal;letter-spacing:0}
      #${PANEL_ID}.rb-page-panel{inset:0;border:0;border-radius:0;box-shadow:none;grid-template-rows:auto minmax(0,1fr)}
      #${PANEL_ID} .rb-top{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #dbe4f2;background:#f5f8fc} #${PANEL_ID} .rb-title{font-weight:700;font-size:16px;flex:1;color:#172033}
      #${PANEL_ID}.rb-page-panel .rb-top{padding:6px 10px;background:#f6f8fb;border-bottom:1px solid #d7deea}
      #${PANEL_ID}.rb-page-panel .rb-title{font-size:14px}
      #${PANEL_ID} .rb-ribbon{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #d7deea;background:#f8fafc;min-height:0;flex-wrap:wrap}
      #${PANEL_ID} .rb-tool{height:32px;min-height:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #ccd7ea;border-radius:6px;background:#fff;color:#26324a;font-size:13px;font-weight:400;line-height:1.2;padding:0 10px;white-space:nowrap}
      #${PANEL_ID} .rb-tool svg,#${PANEL_ID} .rb-action svg{width:16px;height:16px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
      #${PANEL_ID} .rb-tool:hover{background:#eef4ff}
      #${PANEL_ID} .rb-tool.danger{background:#fff;border-color:#ffd6d6;color:#d73a49}
      #${PANEL_ID} .rb-tool.primary{background:#2458d8;color:#fff;border-color:#2458d8}
      #${PANEL_ID} .rb-tool-sep{width:1px;height:24px;background:#d8d8d8;margin:0 3px}
      #${PANEL_ID} .rb-page-title{min-width:0;flex:1;font-size:17px;font-weight:700;color:#172033;line-height:1.25;padding:0 4px;overflow-wrap:anywhere}
      #${PANEL_ID} button{min-height:32px;border:1px solid #c9d4ea;background:#fff;border-radius:6px;padding:0 10px;cursor:pointer;font-size:13px;font-weight:400;line-height:1.2;font-family:Arial,sans-serif!important} #${PANEL_ID} button:hover{background:#eef4ff} #${PANEL_ID} .primary{background:#2458d8;color:white;border-color:#2458d8} #${PANEL_ID} .danger{background:#fff1f0;color:#a8071a;border-color:#ffccc7}
      #${PANEL_ID}.rb-page-panel .rb-tool{box-shadow:0 1px 0 rgba(0,0,0,.04)}
      #${PANEL_ID}.rb-page-panel .rb-tool.primary{background:#2458d8;color:#fff;border-color:#2458d8}
      #${PANEL_ID}.rb-page-panel .rb-tool.danger{background:#fff5f5;color:#d73a49;border-color:#ffc9c9}
      #${PANEL_ID}.rb-page-panel .rb-page-toolbar{padding:8px 12px;background:#f6f8fb;flex-wrap:wrap;overflow-x:visible}
      #${PANEL_ID}.rb-page-panel .rb-page-toolbar .rb-tool{min-height:34px}
      #${PANEL_ID} .rb-main{min-height:0;display:grid;grid-template-columns:292px 1fr;overflow:hidden} #${PANEL_ID} .rb-nav{border-right:1px solid #e3e8f5;background:#f8fafc;overflow:auto;padding:10px} #${PANEL_ID} .rb-nav h4{font-size:11px;color:#66758d;text-transform:uppercase;margin:12px 6px 6px;letter-spacing:0}
      #${PANEL_ID} .rb-main-page{grid-template-columns:1fr}
      #${PANEL_ID}.rb-page-panel .rb-content{padding:8px 12px}
      #${PANEL_ID}.rb-page-panel .rb-teacher-screen h3{display:none}
      #${PANEL_ID}.rb-page-panel .rb-desktop-wrap{max-height:calc(100vh - 132px)}
      #${PANEL_ID}.rb-page-panel .table-wrap{max-height:calc(100vh - 132px)}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page{grid-template-rows:auto minmax(0,1fr)}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-main-page,
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-content,
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-teacher-screen{height:100%;min-height:0;box-sizing:border-box}
      #${PANEL_ID}.rb-page-panel.rb-subject-page .rb-main-page,
      #${PANEL_ID}.rb-page-panel.rb-subject-page .rb-content{height:100%;min-height:0;box-sizing:border-box}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-content{display:flex;flex-direction:column;overflow:hidden;padding:8px 12px 12px}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-teacher-screen{display:flex;flex-direction:column;gap:8px;overflow:hidden}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-teacher-toolbar{flex:0 0 auto;margin:0}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-teacher-screen > [data-rb-check-scope]{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-teacher-screen > [data-rb-check-scope] > .rb-desktop-wrap{flex:1 1 auto;min-height:0;max-height:none;overflow:auto}
      #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-desktop-wrap{flex:1 1 auto;min-height:0;max-height:none;overflow:auto}
      #${PANEL_ID}.rb-page-panel .rb-nss-table{max-height:calc(100vh - 92px)}
      #${PANEL_ID} .rb-nav button{display:block;width:100%;text-align:left;margin:3px 0;border:0;background:transparent;padding:9px 10px;border-radius:7px;line-height:1.25;color:#24324a} #${PANEL_ID} .rb-nav button:hover{background:#eef4fb} #${PANEL_ID} .rb-nav button.active{background:#dfeafa;color:#173b7a;font-weight:700}
      #${PANEL_ID} .rb-content{min-width:0;overflow:auto;padding:14px;background:#fff} #${PANEL_ID} .hint{font-size:12px;color:#596b82;background:#f6f9fc;border:1px solid #dfe8f4;padding:9px 10px;border-radius:8px;margin:8px 0 12px;line-height:1.45}
      #${PANEL_ID} .toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 12px;background:#f8faff;border:1px solid #e7ecf7;padding:8px;border-radius:10px} #${PANEL_ID} select,#${PANEL_ID} input[type=text],#${PANEL_ID} input[type=number]{border:1px solid #c9d4ea;border-radius:7px;padding:6px 8px;background:#fff;font-size:13px} #${PANEL_ID} input[type=number]{width:68px;text-align:center}
      #${PANEL_ID} .rb-check-all-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:6px 0 8px}
      #${PANEL_ID} .rb-grid-check-row{justify-content:flex-start;flex-wrap:wrap;background:#f8faff;border:1px solid #e7ecf7;border-radius:8px;padding:6px 8px}
      #${PANEL_ID} .rb-check-all{display:inline-flex;align-items:center;gap:6px;border:1px solid #d9e2f2;background:#fbfdff;border-radius:7px;padding:5px 8px;font-size:12px;color:#26324a;white-space:nowrap}
      #${PANEL_ID} .rb-fixedoff-tools{justify-content:flex-start;gap:6px}
      #${PANEL_ID} .rb-fixedoff-tools button{height:30px;min-height:30px;padding:0 9px;font-size:12px}
      #${PANEL_ID} .rb-fixedoff-selected-count{margin-left:auto;color:#506078;font-size:12px;line-height:30px;white-space:nowrap}
      #${PANEL_ID} input[type=checkbox]{appearance:none;-webkit-appearance:none;box-sizing:border-box;display:inline-block;width:28px!important;min-width:28px!important;max-width:28px;height:16px!important;min-height:16px!important;max-height:16px;padding:0!important;margin:0;border:0;border-radius:999px;background:#cfd8e3;position:relative;vertical-align:middle;cursor:pointer;line-height:0;flex:0 0 28px;transition:background .16s ease,box-shadow .16s ease;box-shadow:inset 0 0 0 1px rgba(15,23,42,.10)}
      #${PANEL_ID} input[type=checkbox]::before{content:"";position:absolute;width:12px;height:12px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.26);transition:transform .16s ease}
      #${PANEL_ID} input[type=checkbox]:checked{background:#34c759;box-shadow:inset 0 0 0 1px rgba(15,23,42,.06)}
      #${PANEL_ID} input[type=checkbox]:checked::before{transform:translateX(12px)}
      #${PANEL_ID} input[type=checkbox]:indeterminate{background:#8e8e93}
      #${PANEL_ID} input[type=checkbox]:indeterminate::before{transform:translateX(6px)}
      #${PANEL_ID} input[type=checkbox]:focus-visible{outline:2px solid rgba(52,199,89,.35);outline-offset:2px}
      #${PANEL_ID} input[type=checkbox]:disabled{opacity:.55;cursor:not-allowed}
      #${PANEL_ID} .rb-check-all input{margin:0;flex:0 0 auto}
      #${PANEL_ID} .rb-th-check-all{display:inline-flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap}
      #${PANEL_ID} .rb-th-check-all input{margin:0;transform:none;flex:0 0 auto}
      #${PANEL_ID} td.rb-check input[type=checkbox]{margin:0 auto}
      #${PANEL_ID} .rb-dashboard{display:grid;gap:12px;max-width:1180px}
      #${PANEL_ID} .rb-warning-box{border-color:#f5c66b;background:#fffaf0;color:#172033}
      #${PANEL_ID} .rb-warning-box b{color:#8a4b00}
      #${PANEL_ID} .rb-warning-box table{background:#fff}
      #${PANEL_ID} .rb-warning-box th{background:#fff4d6;color:#5f3800}
      #${PANEL_ID} .rb-warning-box td.rb-shortage{font-weight:700;color:#a8071a}
      #${PANEL_ID} .rb-dashboard-head{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #e3e8f5;padding-bottom:10px}
      #${PANEL_ID} .rb-dashboard-head h3{margin:0;font-size:20px;color:#172033}
      #${PANEL_ID} .rb-dashboard-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      #${PANEL_ID} .rb-action{display:inline-flex;align-items:center;gap:6px}
      #${PANEL_ID}.rb-page-panel .rb-dashboard{max-width:none;gap:10px}
      #${PANEL_ID}.rb-page-panel .rb-dashboard-head{align-items:center;padding:0 0 8px;border-bottom:1px solid #e6ebf4}
      #${PANEL_ID} .rb-dashboard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px;align-items:start}
      #${PANEL_ID} .rb-dashboard-card{border:1px solid #dfe6f4;border-radius:8px;background:#fff;padding:10px;display:flex;flex-direction:column;gap:8px;min-height:0}
      #${PANEL_ID} .rb-dashboard-card h4{margin:0;font-size:15px;color:#172033}
      #${PANEL_ID} .rb-dashboard-list{display:grid;grid-template-columns:1fr;gap:6px}
      #${PANEL_ID} .rb-dashboard-list .rb-action{width:100%;min-height:34px;height:auto;justify-content:flex-start;text-align:left;padding:6px 9px;white-space:normal;line-height:1.25}
      #${PANEL_ID} .rb-dashboard-list .rb-action span{min-width:0;overflow-wrap:anywhere}
      #${PANEL_ID} .rb-dashboard-list .rb-count{margin-left:auto;flex:0 0 auto;min-width:24px;text-align:center;border-radius:999px;background:#eef3ff;color:#173b7a;padding:1px 7px;font-size:12px;font-variant-numeric:tabular-nums}
      #${PANEL_ID} .rb-dashboard-empty{border:1px dashed #cbd5e1;border-radius:8px;background:#fbfdff;color:#475569;padding:14px;font-size:13px;line-height:1.35}
      #${PANEL_ID} .rb-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto}
      #${PANEL_ID} .rb-card-actions button{padding:6px 9px;font-size:12px;border-radius:6px}
      #${PANEL_ID} .rb-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
      #${PANEL_ID} .rb-overview-item{border:1px solid #dfe6f4;border-radius:8px;background:#fbfdff;padding:10px}
      #${PANEL_ID} .rb-overview-item b{display:block;font-size:18px;color:#173b7a;margin-bottom:2px}
      #${PANEL_ID} .rb-overview-item span{font-size:12px;color:#5c6d84}
      #${PANEL_ID} .rb-info-screen{max-width:720px;display:grid;gap:12px}
      #${PANEL_ID} .rb-info-form{border:1px solid #dfe6f4;border-radius:8px;background:#fff;padding:14px;display:grid;grid-template-columns:190px minmax(220px,1fr);gap:12px 14px;align-items:center}
      #${PANEL_ID} .rb-info-form label{font-weight:700;color:#26324a;text-align:right}
      #${PANEL_ID} .rb-info-form input{height:34px;min-height:34px;border:1px solid #c9d4ea;border-radius:6px;padding:6px 9px;font-size:14px;box-sizing:border-box}
      #${PANEL_ID} .rb-info-form input[type=date]{max-width:240px}
      #${PANEL_ID} .rb-info-value{font-weight:600;color:#1f2937;padding:6px 2px}
      #${PANEL_ID} .rb-group-editor{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:12px;align-items:start}
      #${PANEL_ID} .rb-group-side{display:grid;gap:10px}
      #${PANEL_ID} .rb-group-side label{display:grid;gap:5px;font-size:12px;color:#34435a}
      #${PANEL_ID} .rb-group-items{max-height:calc(84vh - 250px);overflow:auto;border:1px solid #e1e7f2;border-radius:8px;padding:8px;background:#fff}
      #${PANEL_ID} .rb-group-items label{display:flex;align-items:center;gap:7px;padding:5px 4px;font-size:12px;border-radius:5px}
      #${PANEL_ID} .rb-group-items label:hover{background:#f5f8fc}
      #${PANEL_ID} .table-wrap{overflow:auto;border:1px solid #dfe6f4;border-radius:8px;max-height:calc(84vh - 210px)} #${PANEL_ID} table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:12px} #${PANEL_ID} th,#${PANEL_ID} td{border:0;border-right:1px solid #e2e7f2;border-bottom:1px solid #e2e7f2;padding:6px 7px;text-align:center;vertical-align:middle;background:#fff} #${PANEL_ID} th{position:sticky;top:0;z-index:1;background:#edf3fb;font-weight:700;color:#26324a} #${PANEL_ID} tbody tr:nth-child(even) td{background:#fbfdff} #${PANEL_ID} td:first-child,#${PANEL_ID} th:first-child{position:sticky;left:0;z-index:2;text-align:left;background:#fff} #${PANEL_ID} th:first-child{z-index:3;background:#edf3fb}
      #${PANEL_ID} .rb-nss-layout{display:grid;grid-template-columns:145px minmax(0,1fr);gap:10px;min-height:0}
      #${PANEL_ID} .rb-nss-classes{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:calc(84vh - 155px);border:1px solid #dfe6f4;border-radius:8px;padding:6px;background:#fbfdff}
      #${PANEL_ID}.rb-page-panel .rb-nss-classes{max-height:calc(100vh - 92px)}
      #${PANEL_ID} .rb-nss-classes button{width:100%;text-align:center;background:#fff;border:1px solid #d8e0ee;border-radius:6px;padding:5px 6px}
      #${PANEL_ID} .rb-nss-classes button.active{background:#e8f0ff;border-color:#6d8cff;color:#163f9f;font-weight:700}
      #${PANEL_ID} .rb-nss-classes button.primary{box-shadow:inset 3px 0 0 #2458d8}
      #${PANEL_ID} .rb-nss-table table{table-layout:fixed}
      #${PANEL_ID} .rb-nss-table th,#${PANEL_ID} .rb-nss-table td{padding:4px 5px}
      #${PANEL_ID} .rb-nss-table th:first-child,#${PANEL_ID} .rb-nss-table td:first-child{min-width:150px;width:150px}
      #${PANEL_ID} .rb-nss-table th:not(:first-child),#${PANEL_ID} .rb-nss-table td:not(:first-child){min-width:52px;width:52px}
      #${PANEL_ID} .rb-time-tabs button.active{background:#1f5bd6;color:#fff;border-color:#1f5bd6}
      #${PANEL_ID} .rb-time-group-table th:first-child,#${PANEL_ID} .rb-time-group-table td:first-child{min-width:180px;width:180px}
      #${PANEL_ID} .rb-time-limit-editor{display:grid;grid-template-columns:210px minmax(0,1fr);gap:10px;min-height:0}
      #${PANEL_ID} .rb-time-limit-list{display:flex;flex-direction:column;gap:5px;overflow:auto;max-height:calc(84vh - 170px);border:1px solid #dfe6f4;border-radius:8px;padding:6px;background:#fbfdff}
      #${PANEL_ID} .rb-time-limit-list button{width:100%;display:grid;gap:2px;text-align:left;background:#fff;border:1px solid #d8e0ee;border-radius:6px;padding:7px 8px}
      #${PANEL_ID} .rb-time-limit-list button.active{background:#e8f0ff;border-color:#6d8cff;color:#163f9f}
      #${PANEL_ID} .rb-time-limit-list button span{font-size:11px;color:#64728a}
      #${PANEL_ID} .rb-time-limit-main{min-width:0}
      #${PANEL_ID} .muted{color:#778399;font-size:12px} #${PANEL_ID} .grid2{display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:12px;align-items:start} #${PANEL_ID} .box{border:1px solid #dfe6f4;border-radius:12px;padding:12px;background:#fff} #${PANEL_ID} .check-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:5px 10px;max-height:390px;overflow:auto;padding:6px;border:1px solid #eef2fb;border-radius:10px} #${PANEL_ID} .check-list label{display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap} #${PANEL_ID} pre{white-space:pre-wrap;line-height:1.4;background:#fbfcff;border:1px solid #e0e6f3;border-radius:10px;padding:10px;max-height:520px;overflow:auto}
      #${PANEL_ID} .rb-teacher-screen h3{margin:0 0 8px}
      #${PANEL_ID} .rb-teacher-toolbar{gap:10px;background:#f8f8fb;border-color:#d8ddec;padding:8px 10px}
      #${PANEL_ID} .rb-teacher-toolbar label{display:flex;align-items:center;gap:6px}
      #${PANEL_ID} .rb-toolbar-spacer{flex:1 1 auto}
      #${PANEL_ID} .rb-desktop-wrap{border-radius:0;max-height:calc(84vh - 170px)}
      #${PANEL_ID} .rb-desktop-table{font-size:12px}
      #${PANEL_ID} .rb-desktop-table th,#${PANEL_ID} .rb-desktop-table td{padding:4px 6px;min-width:42px}
      #${PANEL_ID} .rb-desktop-table td input[type=number]{width:82px;min-width:82px;height:30px;padding:4px 8px;box-sizing:border-box;text-align:center}
      #${PANEL_ID} .rb-desktop-table td select{height:24px}
      #${PANEL_ID} .rb-desktop-table .rb-tt{min-width:34px;width:34px;text-align:center}
      #${PANEL_ID} .rb-desktop-table .rb-name{min-width:130px;text-align:left}
      #${PANEL_ID} .rb-desktop-table .rb-teacher-short{display:inline-block;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
      #${PANEL_ID} .rb-desktop-table .rb-stat-head{text-align:center;left:auto}
      #${PANEL_ID} .rb-desktop-table .rb-total{color:#d10000;font-weight:700}
      #${PANEL_ID} .rb-desktop-table .rb-check input{transform:none}
      #${PANEL_ID} .rb-desktop-table thead th{background:#f7f7fb}
      #${PANEL_ID} .rb-teacher-period-wrap{overflow-y:auto;overflow-x:hidden}
      #${PANEL_ID} .rb-teacher-period-table{table-layout:fixed;width:100%;min-width:0}
      #${PANEL_ID} .rb-teacher-period-table col.rb-period-tt-col{width:42px}
      #${PANEL_ID} .rb-teacher-period-table col.rb-period-teacher-col{width:180px}
      #${PANEL_ID} .rb-teacher-period-table col.rb-period-stat-col{width:42px}
      #${PANEL_ID} .rb-teacher-period-table col.rb-period-day-col{width:auto}
      #${PANEL_ID} .rb-teacher-period-table th,
      #${PANEL_ID} .rb-teacher-period-table td{min-width:0;padding:3px 2px;box-sizing:border-box}
      #${PANEL_ID} .rb-teacher-period-table .rb-name{min-width:0;width:auto;text-align:center}
      #${PANEL_ID} .rb-teacher-period-table .rb-teacher-short{max-width:100%}
      #${PANEL_ID} .rb-teacher-period-table td input[type=number]{width:18px;min-width:18px;max-width:100%;height:26px;padding:2px 1px;font-size:12px}
      #${PANEL_ID} td.rb-num-cell-host{padding:0!important;cursor:cell;user-select:none;background:#fff}
      #${PANEL_ID} td.rb-num-cell-host.rb-num-selected{background:#fff1b8!important;box-shadow:inset 0 0 0 1px #ffd666}
      #${PANEL_ID} td.rb-num-cell-host.rb-num-anchor{box-shadow:inset 0 0 0 2px #2458d8}
      #${PANEL_ID} td.rb-num-cell-host.rb-num-selected .rb-num-cell-input{background:transparent!important}
      #${PANEL_ID} input.rb-num-cell-input[type=number]{width:100%!important;min-width:0!important;max-width:none!important;height:30px!important;min-height:30px!important;padding:3px 6px!important;box-sizing:border-box!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;text-align:center!important;font-size:13px!important;line-height:1.2!important;outline:0!important;appearance:textfield;-moz-appearance:textfield;cursor:cell}
      #${PANEL_ID} input.rb-num-cell-input[type=number]:focus{background:transparent!important;outline:0!important}
      #${PANEL_ID} input.rb-num-cell-input[type=number]::-webkit-outer-spin-button,
      #${PANEL_ID} input.rb-num-cell-input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      #${PANEL_ID} .rb-linked-days{width:100%}
      #${PANEL_ID} .rb-linked-days table{table-layout:fixed;width:100%;min-width:980px}
      #${PANEL_ID} .rb-linked-days col.rb-linked-tt-col{width:54px}
      #${PANEL_ID} .rb-linked-days col.rb-linked-class-col{width:140px}
      #${PANEL_ID} .rb-linked-days col.rb-linked-check-col{width:auto}
      #${PANEL_ID} .rb-linked-days th,#${PANEL_ID} .rb-linked-days td{box-sizing:border-box;padding:6px 7px;min-width:54px;text-align:center}
      #${PANEL_ID} .rb-linked-days th.rb-linked-session-head{font-size:13px;text-transform:uppercase;background:#edf3fb}
      #${PANEL_ID} .rb-linked-days th:first-child,#${PANEL_ID} .rb-linked-days td:first-child{width:54px;min-width:54px;max-width:54px;text-align:center}
      #${PANEL_ID} .rb-linked-days th:nth-child(2),#${PANEL_ID} .rb-linked-days td:nth-child(2){width:140px;min-width:140px;max-width:140px;text-align:center}
      #${PANEL_ID} .rb-linked-days td.rb-check input,#${PANEL_ID} .rb-linked-days .rb-th-check-all input{margin:0;width:28px!important;height:16px!important;min-height:16px!important;padding:0!important;transform:none}
      #${PANEL_ID} .rb-linked-days .rb-th-check-all{gap:7px;font-size:12px;font-weight:700;color:#555}
      #${PANEL_ID} .rb-avoid-wrap table{table-layout:fixed;width:100%;min-width:720px}
      #${PANEL_ID} .rb-avoid-wrap col.rb-avoid-tt-col{width:54px}
      #${PANEL_ID} .rb-avoid-wrap col.rb-avoid-class-col{width:260px}
      #${PANEL_ID} .rb-avoid-wrap col.rb-avoid-period-col{width:96px}
      #${PANEL_ID} .rb-avoid-wrap col.rb-avoid-check-col{width:160px}
      #${PANEL_ID} .rb-avoid-table th{background:#edf3fb}
      #${PANEL_ID} .rb-avoid-table td.rb-check,#${PANEL_ID} .rb-avoid-table td.rb-row-index{text-align:center}
      #${PANEL_ID} .rb-avoid-table td.rb-class-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${PANEL_ID} .rb-fixedoff-screen{display:grid;grid-template-columns:168px 1fr;gap:10px;align-items:start}
      #${PANEL_ID} .rb-fixedoff-excelbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:0 0 8px;flex-wrap:wrap}
      #${PANEL_ID} .rb-fixedoff-excelbar .rb-action{height:30px;min-height:30px;padding:0 9px;border-radius:6px}
      #${PANEL_ID} .rb-fixedoff-list{border:1px solid #d7deea;background:#fff;max-height:calc(100vh - 188px);overflow:auto;border-radius:8px}
      #${PANEL_ID} .rb-fixedoff-item{display:block;width:100%;padding:7px 9px;border:0;border-bottom:1px solid #edf1f6;background:#fff;text-align:left;border-radius:0;font-size:12px}
      #${PANEL_ID} .rb-fixedoff-item:hover{background:#f6f9ff}
      #${PANEL_ID} .rb-fixedoff-item.active{background:#dfeafa;color:#173b7a;font-weight:700}
      #${PANEL_ID} .rb-fixedoff-item.primary{box-shadow:inset 3px 0 0 #2458d8}
      #${PANEL_ID} .rb-fixedoff-item .rb-teacher-short{display:inline-block;max-width:136px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
      #${PANEL_ID} .rb-fixedoff-item .rb-fixedoff-short{display:inline-block;max-width:136px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
      #${PANEL_ID} .rb-fixedoff-main{min-width:0}
      #${PANEL_ID} .rb-fixedoff-titlebar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;min-height:30px}
      #${PANEL_ID} .rb-fixedoff-titlebar h3{margin:0;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${PANEL_ID} .rb-fixedoff-titlebar .rb-teacher-short{display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
      #${PANEL_ID} .rb-fixedoff-total{font-style:italic;font-weight:700;color:#444;white-space:nowrap;font-size:12px}
      #${PANEL_ID} .rb-fixedoff-top{border:1px solid #d7deea;max-height:190px;overflow:auto;background:#fff;border-radius:8px}
      #${PANEL_ID} .rb-fixedoff-top table{width:100%;min-width:100%;font-size:12px}
      #${PANEL_ID} .rb-fixedoff-top th,#${PANEL_ID} .rb-fixedoff-top td{padding:5px 6px;border:1px solid #d9d9d9}
      #${PANEL_ID} .rb-fixedoff-grid{border:1px solid #d7deea;margin-top:6px;background:#fff;border-radius:8px;overflow:hidden;user-select:none;-webkit-user-select:none;-ms-user-select:none}
      #${PANEL_ID} .rb-fixedoff-grid *{user-select:none;-webkit-user-select:none;-ms-user-select:none}
      #${PANEL_ID} .rb-fixedoff-grid table{width:100%;min-width:100%;table-layout:fixed;font-size:12px}
      #${PANEL_ID} .rb-fixedoff-grid th,#${PANEL_ID} .rb-fixedoff-grid td{border:1px solid #d9d9d9;padding:0;height:26px;text-align:center;vertical-align:middle}
      #${PANEL_ID} .rb-fixedoff-grid thead th{background:#fff;font-size:12px;font-weight:700}
      #${PANEL_ID} .rb-fixedoff-grid td{cursor:pointer;background:#fff;color:#333;position:relative;overflow:hidden}
      #${PANEL_ID} .rb-fixedoff-grid td:focus{outline:none}
      #${PANEL_ID} .rb-fixedoff-grid td.off{background:#fff4e5;color:#8a4b08;font-weight:700}
      #${PANEL_ID} .rb-fixedoff-grid td.off .rb-off-text{display:flex}
      #${PANEL_ID} .rb-fixedoff-grid .rb-off-text{display:none;align-items:center;justify-content:center;width:100%;height:100%;line-height:1;font-size:12px;white-space:nowrap}
      #${PANEL_ID} .rb-fixedoff-grid td.lesson{background:#e9f7ef;color:#0f6b3f;font-weight:700}
      #${PANEL_ID} .rb-fixedoff-grid td.lesson .rb-fixed-lesson-text{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px;box-sizing:border-box;vertical-align:middle}
      #${PANEL_ID} .rb-fixedoff-grid .rb-fixed-lesson-text{display:none}
      #${PANEL_ID} .rb-fixedoff-grid td.must{background:#e9f7ef;color:#0f6b3f;font-weight:700}
      #${PANEL_ID} .rb-fixedoff-grid td.must .rb-must-text{display:inline-block}
      #${PANEL_ID} .rb-fixedoff-grid .rb-must-text{display:none}
      #${PANEL_ID} .rb-fixedoff-grid td.selected{box-shadow:inset 0 0 0 2px #2458d8}
      #${PANEL_ID} .rb-fixedoff-grid td.off.selected{box-shadow:inset 0 0 0 2px #2458d8;background:#ffedcf}
      #${PANEL_ID} .rb-fixedoff-grid td.lesson.selected{box-shadow:inset 0 0 0 2px #2458d8;background:#dff2e8}
      #${PANEL_ID} .rb-fixedoff-grid tr.sep td{border-top:2px solid #5876d3}
      #${PANEL_ID}.rb-page-panel .rb-main-page,
      #${PANEL_ID}.rb-page-panel .rb-content{min-height:0;height:100%;box-sizing:border-box}
      #${PANEL_ID}.rb-page-panel .rb-content{overflow:hidden}
      #${PANEL_ID}.rb-page-panel .rb-content[data-rb-section="subject"],
      #${PANEL_ID}.rb-page-panel .rb-content[data-rb-section="subjectGroup"]{display:flex;flex-direction:column;min-height:0;overflow:hidden}
      #${PANEL_ID}.rb-page-panel .rb-content[data-rb-section="subject"] > .toolbar,
      #${PANEL_ID}.rb-page-panel .rb-content[data-rb-section="subjectGroup"] > .toolbar{flex:0 0 auto}
      #${PANEL_ID}.rb-page-panel .rb-content[data-rb-section="subject"] > .table-wrap,
      #${PANEL_ID}.rb-page-panel .rb-content[data-rb-section="subjectGroup"] > .table-wrap{flex:1 1 auto;min-height:0;max-height:none;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y;-webkit-overflow-scrolling:touch}
      #${PANEL_ID} .rb-lesson-block-fill-row td{background:#f3f7ff;font-weight:700}
      #${PANEL_ID} .rb-lesson-block-fill-row td:first-child{background:#f3f7ff}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-screen{height:100%;min-height:0;align-items:stretch}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-list{max-height:none}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-main{height:100%;min-height:0;display:flex;flex-direction:column}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-top{display:none}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid{flex:1 1 auto;min-height:0;display:block;overflow:hidden}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid table{height:100%;display:grid;grid-template-columns:repeat(var(--rb-grid-cols,6),minmax(0,1fr));grid-template-rows:34px repeat(var(--rb-grid-rows,10),minmax(0,1fr))}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid thead,
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid tbody,
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid tr{display:contents}
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid th,
      #${PANEL_ID}.rb-page-panel .rb-fixedoff-grid td{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:auto;min-width:0;height:auto;min-height:0;max-height:none}
      @media (min-width:861px){
        #${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-desktop-wrap{height:auto;max-height:none}
        #${PANEL_ID}.rb-page-panel .rb-fixedoff-list{height:100%;max-height:none}
      }

.rb-menu-pop{position:fixed;z-index:1000002;min-width:232px;background:#fff;border:1px solid #d2d9e6;border-radius:8px;box-shadow:0 10px 28px rgba(22,34,66,.18);padding:5px}
.rb-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap}
.rb-menu-item:hover{background:#eef4fb}
.rb-menu-item.sep{height:1px;padding:0;margin:4px 0;background:#d9d9d9;cursor:default}
.rb-menu-item.head{font-weight:700;color:#333;background:transparent;cursor:default}
.rb-menu-arrow{opacity:.7}
#${PANEL_ID} .rb-clear-screen{display:grid;gap:10px;max-width:920px}
#${PANEL_ID} .rb-clear-grid{display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:10px}
#${PANEL_ID} .rb-clear-card{display:flex;flex-direction:column;align-items:flex-start;gap:4px;border:1px solid #d8e0ec;border-radius:8px;padding:10px;background:#fbfdff}
#${PANEL_ID} .rb-clear-card b{font-size:13px}
#${PANEL_ID} .rb-clear-card span{font-size:11px;color:#666;line-height:1.4}
#${PANEL_ID} .rb-clear-card button{margin-top:4px;border-radius:6px;padding:5px 10px;font-size:12px}
#${PANEL_ID}.rb-page-panel .rb-tool{font-size:14px}
@media (max-width:860px){
  #${PANEL_ID}{inset:0; border-radius:0}
  #${PANEL_ID}.rb-page-panel .rb-page-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:8px;gap:8px;overflow:visible}
#${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-page-toolbar{display:flex;align-items:center}
#${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-page-toolbar .rb-tool{width:auto;flex:0 0 auto}
#${PANEL_ID}.rb-page-panel.rb-teacher-page .rb-page-title{font-size:15px;flex:1 1 auto}
#${PANEL_ID}.rb-page-panel.rb-subject-page .rb-page-toolbar{display:flex;align-items:center}
#${PANEL_ID}.rb-page-panel.rb-subject-page .rb-page-toolbar .rb-tool{width:auto;flex:0 0 auto}
#${PANEL_ID}.rb-page-panel.rb-subject-page .rb-page-title{font-size:15px;flex:1 1 auto}
#${PANEL_ID}.rb-page-panel.rb-info-page .rb-page-toolbar{display:flex;align-items:center}
#${PANEL_ID}.rb-page-panel.rb-info-page .rb-page-toolbar .rb-tool{width:auto;flex:0 0 auto}
#${PANEL_ID}.rb-page-panel.rb-info-page .rb-page-title{font-size:15px;flex:1 1 auto}
  #${PANEL_ID}.rb-page-panel .rb-tool-sep{display:none}
  #${PANEL_ID}.rb-page-panel .rb-tool{width:100%;min-width:0;padding:0 8px;white-space:normal}
  #${PANEL_ID}.rb-page-panel .rb-tool span{min-width:0;overflow-wrap:anywhere}
  #${PANEL_ID}.rb-page-panel .rb-tool,
  #${PANEL_ID} button{height:42px;min-height:42px}
  #${PANEL_ID} .rb-fixedoff-tools button{height:42px;min-height:42px}
  #${PANEL_ID} .rb-fixedoff-selected-count{width:100%;margin-left:0;line-height:1.3}
  #${PANEL_ID} .rb-dashboard-list .rb-action{height:auto;min-height:42px;padding:7px 10px}
  #${PANEL_ID} .rb-dashboard-head{display:grid}
  #${PANEL_ID} .rb-dashboard-actions{justify-content:flex-start}
  #${PANEL_ID} .rb-info-form{grid-template-columns:1fr}
  #${PANEL_ID} .rb-info-form label{text-align:left}
  #${PANEL_ID} .rb-group-editor{grid-template-columns:1fr}
  #${PANEL_ID} .rb-time-limit-editor{grid-template-columns:1fr}
  #${PANEL_ID} .rb-time-limit-list{max-height:170px}
  #${PANEL_ID} .rb-fixedoff-screen{grid-template-columns:1fr}
  #${PANEL_ID}.rb-page-panel .rb-fixedoff-screen{grid-template-rows:minmax(60px,max-content) minmax(0,1fr)}
  #${PANEL_ID}.rb-page-panel .rb-fixedoff-list{max-height:104px}
  #${PANEL_ID}:not(.rb-page-panel) .rb-fixedoff-list{max-height:160px}
}
@media (max-width:860px) and (orientation:portrait){
  #${PANEL_ID}.rb-page-panel{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
}
    `; document.head.appendChild(css);
  }

  /* ===================== UI COMMON ===================== */
  function closePanel(){
    const panel=document.getElementById(PANEL_ID);
    if(!panel) return;
    panel.remove();
    try{ setTimeout(()=>{ try{ if(typeof renderCurrentView==='function') renderCurrentView(); if(typeof loadMonList==='function') loadMonList(); }catch(_){} },0); }catch(_){}
  }
  function currentStoreKeys(){
    const out=[];
    try{ if(typeof STORE_KEY !== 'undefined' && STORE_KEY) out.push(String(STORE_KEY)); }catch(_){ }
    try{ if(typeof PRIMARY_STORE_KEY !== 'undefined' && PRIMARY_STORE_KEY) out.push(String(PRIMARY_STORE_KEY)); }catch(_){ }
    out.push('TKB_STORE');
    return Array.from(new Set(out.filter(Boolean)));
  }
  function isCurrentStoreKey(key){
    const k=String(key || '');
    if(!k) return false;
    return currentStoreKeys().includes(k) || /^TKB_STORE::/.test(k);
  }
  function applyExternalStorePayload(raw){
    if(!raw) return false;
    try{
      const next=JSON.parse(raw);
      if(!next || typeof next !== 'object') return false;
      window.DATA=next;
      invalidateConstraintCache();
      syncDefaultGroups();
      if(document.getElementById(PANEL_ID)) render();
      return true;
    }catch(err){
      console.warn('[tkb-constraints] ignore external store update', err);
      return false;
    }
  }
  try{
    window.addEventListener('storage', ev=>{
      if(!isCurrentStoreKey(ev?.key)) return;
      applyExternalStorePayload(ev.newValue || '');
    });
  }catch(_){ }
  function rbIcon(name){
    const paths = {
      menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
      close: '<path d="M18 6 6 18M6 6l12 12"/>',
      save: '<path d="M5 5h11l3 3v11H5z"/><path d="M8 5v6h8"/><path d="M8 19v-5h8v5"/>',
      clear: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
      groups: '<path d="M16 11a4 4 0 1 0-8 0"/><path d="M3 20a7 7 0 0 1 18 0"/><path d="M17 4a3 3 0 0 1 0 6M7 4a3 3 0 0 0 0 6"/>',
      download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
      upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.menu}</svg>`;
  }
  function setPanelRoute(opts){
    opts = opts || {};
    if(opts.section) state.section = opts.section;
    if(state.section === 'subjectGroup') state.section = 'dashboard';
    const r = opts.rule || opts.teacherRule || opts.subjectRule || opts.subjectGroupRule || opts.fixedType || '';
    if(state.section==='teacher' && r) state.teacherRule = r;
    if(state.section==='teacher' && !TEACHER_RULES.some(x=>x[0]===state.teacherRule)) state.teacherRule = TEACHER_RULES[0][0];
    if(state.section==='subject' && r) state.subjectRule = r;
    if(state.section==='subjectGroup' && r) state.subjectGroupRule = r;
    if(state.section==='fixedOff' && r) state.fixedType = r;
    if(state.section==='fixedOff' && state.fixedType === 'subjectGroup') state.fixedType = 'subject';
    if(state.section==='timeLimit' && r) state.timeLimitView = r;
  }
  function clipboardActionsAllowed(){
    return false;
  }
  function clearCurrentRuleAllowed(){
    return ['teacher','subject'].includes(state.section);
  }
  function updateClipboardRibbon(){
    const allowed=clipboardActionsAllowed();
    const clearBtn=document.querySelector(`#${PANEL_ID} [data-rb-clear-current]`);
    const copyBtn=document.querySelector(`#${PANEL_ID} [data-rb-copy]`);
    const sep=document.querySelector(`#${PANEL_ID} [data-rb-clipboard-sep]`);
    if(clearBtn) clearBtn.hidden=!clearCurrentRuleAllowed();
    if(copyBtn) copyBtn.hidden=!allowed;
    if(sep) sep.hidden=!allowed;
  }
  function saveCurrentBeforeNavigation(){
    const root=document.getElementById(PANEL_ID);
    if(!root) return true;
    if(!['info','teacher','subject','fixedOff','timeLimit'].includes(state.section)) return true;
    if(state.formSignature && currentFormSignature() === state.formSignature) return true;
    return saveCurrentFromUI(false) !== false;
  }

function menuRoute(label, section, rule){ return {label, section, rule, title:label, action:()=>{ if(!saveCurrentBeforeNavigation()) return; openPanel({page:true,title:label,section,rule}); }}; }
function buildMenuTree(){
  return [
    menuRoute('Thông tin','info',''),
    {label:'Tổng quan yêu cầu', section:'dashboard', title:'Yêu cầu thời khóa biểu', action:()=>{ if(!saveCurrentBeforeNavigation()) return; openPanel({page:true,title:'Yêu cầu thời khóa biểu',section:'dashboard'}); }},
    {label:'Yêu cầu của giáo viên', children:[
      menuRoute('Giới hạn số ngày dạy & buổi dạy/1 tuần','teacher','maxDaysSessions'),
      menuRoute('Giới hạn số tiết dạy/1 buổi','teacher','maxPeriods'),
      menuRoute('Giới hạn số buổi dạy sáng & chiều','teacher','maxMorningAfternoon'),
      menuRoute('Chỉ dạy 1 buổi/1 ngày','teacher','oneSessionPerDay'),
      menuRoute('Không dạy tiết 5 sáng & tiết 1 chiều/1 ngày','teacher','noMorningP5AfternoonP1'),
      menuRoute('Chỉ dạy 1 địa điểm/1 buổi','teacher','oneLocationPerSession'),
      menuRoute('Có tiết trống giữa 2 địa điểm','teacher','gapBetweenLocations'),
      menuRoute('Không di chuyển 2 lần/1 buổi giữa các địa điểm','teacher','maxOneMovePerSession'),
      menuRoute('Vị trí phải có tiết dạy','teacher','mustTeach')
    ]},
    {label:'Yêu cầu của môn học', children:[
      {label:'Yêu cầu tiết học xếp liền', heading:true},
      menuRoute('Số buổi học có tiết học xếp liền','subject','lessonBlocks'),
      menuRoute('Tránh xếp tiết 2-3','subject','avoidBreakPair23'),
      menuRoute('Tránh xếp tiết 3-4','subject','avoidBreakPair34'),
      menuRoute('Tránh xếp tiết học liền vào các thứ trong tuần','subject','linkedDays'),
      {label:'Yêu cầu đối với lớp học 2 ca', heading:true},
      menuRoute('Giới hạn buổi của môn học','subject','sessionAllowed'),
      menuRoute('Giới hạn số tiết của môn học/1 buổi/1 tuần','subject','weeklySessionPeriods'),
      menuRoute('Học cách ngày','subject','spacingDays'),
      menuRoute('Giới hạn số tiết/1 buổi','subject','maxPeriods'),
      menuRoute('Giới hạn số tiết/1 ngày','subject','maxPeriodsDay'),
      {label:'Yêu cầu khác', heading:true},
      menuRoute('Môn học không cùng buổi','subject','noSameSession'),
      menuRoute('Môn học không cùng ngày','subject','noSameDay'),
      menuRoute('Giới hạn số buổi học','subject','maxSessions')
    ]},
    {label: FIXED_OFF_GROUP_LABEL, children:[
      menuRoute(fixedOffTitle('class'),'fixedOff','class'),
      menuRoute(fixedOffTitle('teacher'),'fixedOff','teacher'),
      menuRoute(fixedOffTitle('subject'),'fixedOff','subject'),
    ]},
    {label:'Giới hạn số tiết/1 thời điểm', children:[
      menuRoute('Tạo nhóm lớp','timeLimit','groups-class'),
      menuRoute('Tạo nhóm môn học','timeLimit','groups-subject'),
      menuRoute('Giới hạn','timeLimit','limits')
    ]},
    {label:'Xóa yêu cầu TKB ...', section:'clear', title:'Xóa yêu cầu TKB', action:()=>{ if(!saveCurrentBeforeNavigation()) return; openPanel({page:true,title:'Xóa yêu cầu TKB',section:'clear'}); }}
  ];
}
function closeRbMenus(){ document.querySelectorAll('.rb-menu-pop').forEach(x=>x.remove()); }
function buildMenuPopup(items, left, top, level){
  const pop=document.createElement('div'); pop.className='rb-menu-pop'; pop.dataset.level=String(level||0); pop.style.left=Math.round(left)+'px'; pop.style.top=Math.round(top)+'px';
  items.forEach(it=>{
    if(it.sep){ const d=document.createElement('div'); d.className='rb-menu-item sep'; pop.appendChild(d); return; }
    const row=document.createElement('div'); row.className='rb-menu-item'+(it.heading?' head':''); row.innerHTML=`<span>${esc(it.label||'')}</span>${it.children?'<span class="rb-menu-arrow">▶</span>':''}`;
    if(it.section){
      row.dataset.rbOpen = it.section;
      if(it.rule) row.dataset.rbRule = it.rule;
      row.dataset.rbTitle = it.title || it.label || '';
    }
    if(!it.heading){
      row.addEventListener('mouseenter',()=>{
        document.querySelectorAll(`.rb-menu-pop`).forEach(p=>{ if(Number(p.dataset.level||0) > (level||0)) p.remove(); });
        if(it.children){ const r=row.getBoundingClientRect(); const next=buildMenuPopup(it.children, r.right-2, r.top-4, (level||0)+1); document.body.appendChild(next); }
      });
      row.addEventListener('click',(e)=>{ e.stopPropagation(); if(it.children) return; closeRbMenus(); try{ it.action && it.action(); }catch(_){} });
    }
    pop.appendChild(row);
  });
  return pop;
}

  function openPanel(opts){
    opts = opts || {};
    document.getElementById(PANEL_ID)?.remove();
    injectStyle(); syncDefaultGroups(); setPanelRoute(opts);
    const pageMode = opts.page === true;
    const pageTitle = opts.title || (state.section === 'teacher' ? (TEACHER_RULES.find(x=>x[0]===state.teacherRule)||[])[1] : '') || 'Yêu cầu TKB';
    const teacherPage = pageMode && state.section === 'teacher';
    const subjectPage = pageMode && state.section === 'subject';
    const timeLimitPage = pageMode && state.section === 'timeLimit';
    const infoPage = pageMode && state.section === 'info';
    const showClearTool = !['fixedOff','fixedLesson','timeLimit','info'].includes(state.section);
    const ribbonHtml = pageMode ? ((teacherPage || subjectPage)
      ? `<div class="rb-ribbon rb-page-toolbar rb-title-page-toolbar ${teacherPage ? 'rb-teacher-page-toolbar' : 'rb-subject-page-toolbar'}" role="toolbar" aria-label="Công cụ yêu cầu">
        <button type="button" class="rb-tool" data-rb-menu title="Danh mục yêu cầu">${rbIcon('menu')}<span>Yêu cầu</span></button>
        <span class="rb-tool-sep"></span>
        <div class="rb-page-title">${esc(pageTitle)}</div>
        <span class="rb-tool-sep"></span>
        <button type="button" class="rb-tool danger" data-rb-close title="Đóng">${rbIcon('close')}<span>Đóng</span></button>
      </div>`
      : timeLimitPage
      ? `<div class="rb-ribbon rb-page-toolbar rb-time-limit-toolbar" role="toolbar" aria-label="Công cụ giới hạn">
        <button type="button" class="rb-tool" data-rb-menu title="Danh mục yêu cầu">${rbIcon('menu')}<span>Yêu cầu</span></button>
        <span class="rb-tool-sep"></span>
        ${timeLimitToolbarTabs(state.timeLimitView || 'limits')}
        <span class="rb-tool-sep"></span>
        <button type="button" class="rb-tool danger" data-rb-close title="Đóng">${rbIcon('close')}<span>Đóng</span></button>
      </div>`
      : infoPage
      ? `<div class="rb-ribbon rb-page-toolbar rb-info-page-toolbar" role="toolbar" aria-label="Công cụ thông tin">
        <button type="button" class="rb-tool" data-rb-menu title="Danh mục yêu cầu">${rbIcon('menu')}<span>Yêu cầu</span></button>
        <span class="rb-tool-sep"></span>
        <div class="rb-page-title">${esc(pageTitle || 'Thông tin')}</div>
        <span class="rb-tool-sep"></span>
        <button type="button" class="rb-tool danger" data-rb-close title="Đóng">${rbIcon('close')}<span>Đóng</span></button>
      </div>`
      : `<div class="rb-ribbon rb-page-toolbar" role="toolbar" aria-label="Công cụ yêu cầu">
        <button type="button" class="rb-tool" data-rb-menu title="Danh mục yêu cầu">${rbIcon('menu')}<span>Yêu cầu</span></button>
        <span class="rb-tool-sep"></span>
        ${showClearTool ? `<button type="button" class="rb-tool" data-rb-clear-current title="Xóa">${rbIcon('clear')}<span>Xóa</span></button>` : ``}
        <button type="button" class="rb-tool" data-rb-export-all title="Xuất toàn bộ yêu cầu ra Excel">${rbIcon('download')}<span>Xuất Excel</span></button>
        <button type="button" class="rb-tool" data-rb-import-all title="Nhập toàn bộ yêu cầu từ Excel">${rbIcon('upload')}<span>Nhập Excel</span></button>
        <span class="rb-tool-sep"></span>
        <button type="button" class="rb-tool danger" data-rb-close title="Đóng">${rbIcon('close')}<span>Đóng</span></button>
        <input type="file" hidden data-rb-import-all-file accept=".xlsx,.xls,.csv">
      </div>`) : ``;
    const mainHtml = pageMode
      ? `<div class="rb-main rb-main-page"><div class="rb-content" data-rb-body></div></div>`
      : `<div class="rb-main"><div class="rb-nav" data-rb-nav></div><div class="rb-content" data-rb-body></div></div>`;
    const topActions = pageMode ? `` : `<button type="button" data-rb-check>Kiểm tra yêu cầu</button><button type="button" data-rb-close>Đóng</button>`;
    const topHtml = pageMode ? `` : `<div class="rb-top"><div class="rb-title">${esc(opts.title || 'Yêu cầu TKB')}</div>${topActions}</div>`;
    const w=document.createElement('div'); w.id=PANEL_ID; if(pageMode) w.className=teacherPage?'rb-page-panel rb-teacher-page':(subjectPage?'rb-page-panel rb-subject-page':(timeLimitPage?'rb-page-panel rb-time-limit-page':(infoPage?'rb-page-panel rb-info-page':'rb-page-panel'))); w.innerHTML=`${topHtml}${ribbonHtml}${mainHtml}`;
    document.body.appendChild(w);
    w.querySelectorAll('[data-rb-close]').forEach(b=>b.onclick=closePanel);
    const checkBtn = w.querySelector('[data-rb-check]');
    if(checkBtn) checkBtn.onclick=()=>{ saveCurrentFromUI(false); state.section='check'; render(); };
    const menuBtn = w.querySelector('[data-rb-menu]');
    if(menuBtn) menuBtn.onclick=()=>{ if(typeof window.openRangBuocMenu === 'function') window.openRangBuocMenu(menuBtn); };
    const clearBtn = w.querySelector('[data-rb-clear-current]');
    if(clearBtn) clearBtn.onclick=clearCurrentRule;
    const copyBtn = w.querySelector('[data-rb-copy]');
    if(copyBtn){ copyBtn.onclick=copyCurrentRule; window.__rbCopyBtn = copyBtn; }
    render();
  }
  function navButton(label, section, rule){ const active=state.section===section && (!rule || state.teacherRule===rule || state.subjectRule===rule || state.subjectGroupRule===rule || state.fixedType===rule); return `<button type="button" class="${active?'active':''}" data-section="${esc(section)}" data-rule="${esc(rule||'')}">${esc(label)}</button>`; }
  function updateFixedOffRibbon(){
    updateClipboardRibbon();
  }
  function dashboardStat(label, value){ return `<div class="rb-overview-item"><b>${esc(value)}</b><span>${esc(label)}</span></div>`; }
  function countObjectKeys(obj){ return obj && typeof obj==='object' ? Object.keys(obj).length : 0; }
  function countFixedOffSlots(type){
    const fixed=model().fixedOff?.[type] || {};
    return Object.values(fixed).reduce((sum,slots)=>sum+countObjectKeys(slots),0);
  }
  function fixedOffSlotMapHas(raw, key){
    if(!raw) return false;
    const sk=String(key || '');
    if(Array.isArray(raw)) return raw.map(String).includes(sk);
    if(typeof raw === 'object') return !!raw[sk];
    return false;
  }
  function fixedOffAnyIdHas(type, ids, key){
    const fixed=model().fixedOff?.[type] || {};
    return arrUnique(ids || []).some(id=>fixedOffSlotMapHas(fixed[id], key));
  }
  function classUserOffAnyIdHas(ids, key){
    const userOff=D().tkbUserOff || {};
    return arrUnique(ids || []).some(id=>fixedOffSlotMapHas(userOff[id], key));
  }
  function sumNumbers(list){ return (list || []).reduce((sum,n)=>sum+Math.max(0, Number(n || 0)),0); }
  function sumTopNumbers(list, limit){
    const n=toInt(limit,0);
    const values=(list || []).map(x=>Math.max(0, Number(x || 0))).sort((a,b)=>b-a);
    return n > 0 ? sumNumbers(values.slice(0,n)) : sumNumbers(values);
  }
  function teacherOffSlotCount(teacherId){
    const slots=model().fixedOff?.teacher?.[teacherId] || {};
    const cols=teacherFixedOffExcelColumns();
    return cols.reduce((sum,c)=>sum+(fixedOffSlotMapHas(slots,c.key)?1:0),0);
  }
  function sameNormId(a,b){ return norm(String(a || '')) === norm(String(b || '')); }
  function teacherHasFixedLessonAtSlot(teacherId, info){
    const teacher=String(teacherId || '').trim();
    if(!teacher || !info) return false;
    const key=String(info.key || slotKey(info.thu, info.buoi, info.ti));
    return teacherFixedLessonSlotIndex().has(norm(teacher) + '|' + key);
  }
  function teacherFixedLessonSlotIndex(){
    const sig=quickTkbSignature()+'|teacherFixedLessonSlotIndex|'+String(__cacheRev);
    if(__cache.teacherFixedLessonSlotIndex && __cache.teacherFixedLessonSlotIndexSig===sig) return __cache.teacherFixedLessonSlotIndex;
    const index=new Set();
    fixedLessonRows().forEach(row=>{
      const key=slotKey(row.thu,row.buoi,row.ti);
      splitTeacherValues(row.teacher).forEach(id=>{
        const teacher=String(id || '').trim();
        if(!teacher) return;
        index.add(norm(teacher) + '|' + key);
      });
    });
    __cache.teacherFixedLessonSlotIndexSig=sig;
    __cache.teacherFixedLessonSlotIndex=index;
    return index;
  }
  function fixedLessonsBySlotIndex(){
    const sig=quickTkbSignature()+'|fixedLessonsBySlot|'+String(__cacheRev);
    if(__cache.fixedLessonsBySlot && __cache.fixedLessonsBySlotSig===sig) return __cache.fixedLessonsBySlot;
    const map=new Map();
    fixedLessonRows().forEach(row=>{
      const key=slotKey(row.thu,row.buoi,row.ti);
      if(!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    __cache.fixedLessonsBySlotSig=sig;
    __cache.fixedLessonsBySlot=map;
    return map;
  }
  function assignmentRowHasFixedLessonAtSlot(row, info){
    if(!row || !info) return false;
    const key=String(info.key || slotKey(info.thu, info.buoi, info.ti));
    const candidates=fixedLessonsBySlotIndex().get(key) || [];
    if(!candidates.length) return false;
    const classIds=assignmentRowClassIds(row).map(String);
    const subjectIds=assignmentRowSubjectIds(row);
    const teachers=splitTeacherValues(row?.teacher || row?.gv || row?.giaovien || row?.teacherCode || '');
    const room=String(row.room || '').trim();
    return candidates.some(fixed=>{
      const fixedClassIds=classKeyCandidates(fixed.lopId || fixed.className || '', findClassObject(fixed.lopId || fixed.className || '')).map(String);
      const classOk=classIds.some(id=>fixedClassIds.some(fid=>sameNormId(id,fid)));
      if(!classOk) return false;
      const fixedSubjectIds=subjectKeyCandidates(fixed.mon || '').map(subjectKey).filter(Boolean);
      const subjectOk=subjectIds.some(id=>fixedSubjectIds.some(fid=>sameNormId(id,fid)));
      if(!subjectOk) return false;
      if(teachers.length && !teachers.some(id=>splitTeacherValues(fixed.teacher).some(fid=>sameNormId(id,fid)))) return false;
      if(room && fixed.room && !sameNormId(room, fixed.room)) return false;
      return true;
    });
  }
  function teacherGenericCapacity(teacherId){
    const teacher=String(teacherId || '').trim();
    const rule=model().teacher?.[teacher] || {};
    const sessionCaps=[];
    const dayCaps=[];
    days().forEach(thu=>{
      const perDay=[];
      SESSION_KEYS.forEach(buoi=>{
        let available=0;
        for(let ti=0; ti<sessionLen(buoi); ti++){
          const info={thu,buoi,ti,key:slotKey(thu,buoi,ti)};
          if(!fixedOffAnyIdHas('teacher',[teacher],info.key) || teacherHasFixedLessonAtSlot(teacher,info)) available++;
        }
        const sessionLimit=toInt(getPath(rule,`maxPeriods.${buoi}.${thu}`,0),0);
        const cap=sessionLimit > 0 ? Math.min(available, sessionLimit) : available;
        sessionCaps.push({thu,buoi,cap});
        perDay.push({buoi,cap});
      });
      let dayCap=sumNumbers(perDay.map(x=>x.cap));
      const dayLimit=toInt(getPath(rule,`maxPeriods.day.${thu}`,0),0);
      if(dayLimit > 0) dayCap=Math.min(dayCap, dayLimit);
      if(truthy(rule.oneSessionPerDay?.[thu])) dayCap=Math.min(dayCap, Math.max(0, ...perDay.map(x=>x.cap)));
      dayCaps.push({thu,cap:dayCap});
    });
    let cap=sumNumbers(dayCaps.map(x=>x.cap));
    const maxDays=toInt(rule.maxDaysSessions?.maxDays,0);
    if(maxDays > 0) cap=Math.min(cap, sumTopNumbers(dayCaps.map(x=>x.cap), maxDays));
    const maxSessions=toInt(rule.maxDaysSessions?.maxSessions,0);
    if(maxSessions > 0) cap=Math.min(cap, sumTopNumbers(sessionCaps.map(x=>x.cap), maxSessions));
    const morningLimit=toInt(rule.maxMorningAfternoon?.morning,0);
    if(morningLimit > 0){
      cap=Math.min(
        cap,
        sumTopNumbers(sessionCaps.filter(x=>x.buoi==='sang').map(x=>x.cap), morningLimit) +
        sumNumbers(sessionCaps.filter(x=>x.buoi==='chieu').map(x=>x.cap))
      );
    }
    const afternoonLimit=toInt(rule.maxMorningAfternoon?.afternoon,0);
    if(afternoonLimit > 0){
      cap=Math.min(
        cap,
        sumNumbers(sessionCaps.filter(x=>x.buoi==='sang').map(x=>x.cap)) +
        sumTopNumbers(sessionCaps.filter(x=>x.buoi==='chieu').map(x=>x.cap), afternoonLimit)
      );
    }
    return Math.max(0, Math.floor(cap));
  }
  function teacherGenericCapacityCached(teacherId){
    const sig=quickTkbSignature()+'|teacherGenericCapacity|'+String(__cacheRev);
    if(__cache.teacherGenericCapacitySig !== sig){
      __cache.teacherGenericCapacitySig=sig;
      __cache.teacherGenericCapacity=new Map();
    }
    const id=String(teacherId || '').trim();
    if(__cache.teacherGenericCapacity.has(id)) return __cache.teacherGenericCapacity.get(id);
    const value=teacherGenericCapacity(id);
    __cache.teacherGenericCapacity.set(id, value);
    return value;
  }
  function assignmentRowClassIds(row){
    const ids=classKeyCandidates(row?.classId || row?.cls || '', row?.lop || findClassObject(row?.classId || row?.cls || ''));
    return ids.length ? ids : [row?.classId || row?.cls].filter(Boolean);
  }
  function assignmentRowSubjectIds(row){
    return subjectKeyCandidates(row?.mon || row?.rawMon || '').map(subjectKey).filter(Boolean);
  }
  function sessionAllowedBlocks(allowed, buoi){
    if(!allowed || typeof allowed !== 'object') return false;
    if(String(buoi) === 'sang' && allowed.allowMorning === false) return true;
    if(String(buoi) === 'chieu' && allowed.allowAfternoon === false) return true;
    return false;
  }
  function assignmentRowSessionAllowed(row, buoi){
    if(!row || !buoi) return true;
    const classIds=assignmentRowClassIds(row);
    const subjects=assignmentRowSubjectIds(row);
    for(const subject of subjects){
      const rule=byClassRuleAny(subjectRuleObj(subject), classIds);
      if(sessionAllowedBlocks(rule?.sessionAllowed, buoi)) return false;
    }
    const rawSubject=row?.mon || row?.rawMon || '';
    for(const gid of subjectGroupsOf(rawSubject)){
      const rule=byClassRuleAny(model().subjectGroup?.[gid], classIds);
      if(sessionAllowedBlocks(rule?.sessionAllowed, buoi)) return false;
    }
    return true;
  }
  function assignmentRowAllowedInSlot(row, info){
    if(!row || !info) return false;
    const key=String(info.key || '');
    if(assignmentRowHasFixedLessonAtSlot(row, info)) return true;
    const classIds=assignmentRowClassIds(row);
    if(fixedOffAnyIdHas('class',classIds,key) || classUserOffAnyIdHas(classIds,key)) return false;
    if(!assignmentRowSessionAllowed(row, info.buoi)) return false;
    const subjects=assignmentRowSubjectIds(row);
    if(subjects.length && fixedOffAnyIdHas('subject',subjects,key)) return false;
    const teachers=splitTeacherValues(row?.teacher || row?.gv || row?.giaovien || row?.teacherCode || '');
    if(teachers.length && fixedOffAnyIdHas('teacher',teachers,key)) return false;
    for(const gid of subjectGroupsOf(row.mon || row.rawMon || '')){
      if(fixedOffAnyIdHas('subjectGroup',[gid],key)) return false;
    }
    const room=String(row.room || '').trim();
    if(room && fixedOffAnyIdHas('room',[room],key)) return false;
    return true;
  }
  function teacherDemandRows(){
    const sig=dataListSignature('assignmentRows')+'|teacherDemandRows';
    if(__cache.teacherDemandRows && __cache.teacherDemandRowsSig===sig) return __cache.teacherDemandRows;
    const map=new Map();
    pccmAssignmentRows().forEach(row=>{
      const count=Number(row?.count || 0);
      if(!(count > 0)) return;
      splitTeacherValues(row.teacher).forEach(teacher=>{
        const id=String(teacher || '').trim();
        if(!id) return;
        if(!map.has(id)) map.set(id,{teacherId:id, required:0, rows:[]});
        const entry=map.get(id);
        entry.required += count;
        entry.rows.push(row);
      });
    });
    const rows=Array.from(map.values());
    __cache.teacherDemandRowsSig=sig;
    __cache.teacherDemandRows=rows;
    return rows;
  }
  function teacherFeasibleSlotCapacity(teacherId, rows){
    const teacher=String(teacherId || '').trim();
    const cols=teacherFixedOffExcelColumns();
    let count=0;
    cols.forEach(info=>{
      if(fixedOffAnyIdHas('teacher',[teacher],info.key)) return;
      if((rows || []).some(row=>assignmentRowAllowedInSlot(row,info))) count++;
    });
    return count;
  }
  function teacherFixedOffCapacityWarnings(maxItems){
    const warnings=[];
    teacherDemandRows().forEach(entry=>{
      const required=Math.round(Number(entry.required || 0));
      if(required <= 0) return;
      const genericCapacity=teacherGenericCapacityCached(entry.teacherId);
      const feasibleSlotCapacity=teacherFeasibleSlotCapacity(entry.teacherId, entry.rows);
      const capacity=Math.max(0, Math.min(genericCapacity, feasibleSlotCapacity));
      const shortage=required - capacity;
      if(shortage <= 0) return;
      const name=teacherName(entry.teacherId) || entry.teacherId;
      const fixedTeacherOffCount=teacherOffSlotCount(entry.teacherId);
      warnings.push({
        kind:'teacher.fixedOff.capacity',
        teacherId:entry.teacherId,
        teacherName:name,
        required,
        capacity,
        genericCapacity,
        feasibleSlotCapacity,
        fixedTeacherOffCount,
        shortage,
        message:`${name}: cần ${required} tiết theo PCCM nhưng chỉ còn tối đa ${capacity} ô xếp hợp lệ, thiếu ${shortage} tiết.`
      });
    });
    warnings.sort((a,b)=>
      Number(b.shortage||0)-Number(a.shortage||0) ||
      Number(b.required||0)-Number(a.required||0) ||
      String(a.teacherName||a.teacherId).localeCompare(String(b.teacherName||b.teacherId),'vi')
    );
    const max=toInt(maxItems,0);
    return max > 0 ? warnings.slice(0,max) : warnings;
  }
  function fixedLessonSlotSetByClass(){
    const map=new Map();
    fixedLessonRows().forEach(row=>{
      const classIds=classKeyCandidates(row.lopId || row.className || '', findClassObject(row.lopId || row.className || ''));
      const key=slotKey(row.thu,row.buoi,row.ti);
      classIds.forEach(id=>{
        const text=String(id || '').trim();
        if(!text) return;
        if(!map.has(text)) map.set(text,new Set());
        map.get(text).add(key);
      });
    });
    return map;
  }
  function classDemandRows(){
    const sig=dataListSignature('assignmentRows')+'|classDemandRows';
    if(__cache.classDemandRows && __cache.classDemandRowsSig===sig) return __cache.classDemandRows;
    const map=new Map();
    pccmAssignmentRows().forEach(row=>{
      const count=Number(row?.count || 0);
      if(!(count > 0)) return;
      const classId=String(row?.classId || row?.cls || '').trim();
      if(!classId) return;
      const lop=row?.lop || findClassObject(classId);
      const name=String(row?.className || lop?.ten || lop?.ten2 || classId).trim();
      if(!map.has(classId)) map.set(classId,{classId,className:name,required:0,rows:[]});
      const entry=map.get(classId);
      entry.required += count;
      entry.rows.push(row);
    });
    const rows=Array.from(map.values());
    __cache.classDemandRowsSig=sig;
    __cache.classDemandRows=rows;
    return rows;
  }
  function classFixedOffSlotCount(classId){
    const ids=classKeyCandidates(classId, findClassObject(classId));
    const cols=teacherFixedOffExcelColumns();
    return cols.reduce((sum,c)=>sum+((fixedOffAnyIdHas('class',ids,c.key) || classUserOffAnyIdHas(ids,c.key)) ? 1 : 0),0);
  }
  function classFeasibleSlotCapacity(classId, fixedByClass){
    const ids=classKeyCandidates(classId, findClassObject(classId));
    const fixedMap=fixedByClass || fixedLessonSlotSetByClass();
    const fixedSlots=new Set();
    ids.forEach(id=>{
      const set=fixedMap.get(String(id || '').trim());
      if(set) set.forEach(key=>fixedSlots.add(key));
    });
    const cols=teacherFixedOffExcelColumns();
    let count=0;
    cols.forEach(info=>{
      if(fixedSlots.has(info.key)){ count++; return; }
      if(fixedOffAnyIdHas('class',ids,info.key) || classUserOffAnyIdHas(ids,info.key)) return;
      count++;
    });
    return count;
  }
  function classFixedOffCapacityWarnings(maxItems){
    const warnings=[];
    const fixedByClass=fixedLessonSlotSetByClass();
    classDemandRows().forEach(entry=>{
      const required=Math.round(Number(entry.required || 0));
      if(required <= 0) return;
      const capacity=classFeasibleSlotCapacity(entry.classId, fixedByClass);
      const shortage=required - capacity;
      if(shortage <= 0) return;
      const fixedClassOffCount=classFixedOffSlotCount(entry.classId);
      warnings.push({
        kind:'class.fixedOff.capacity',
        classId:entry.classId,
        className:entry.className || entry.classId,
        required,
        capacity,
        fixedClassOffCount,
        shortage,
        message:`${entry.className || entry.classId}: cần ${required} tiết nhưng chỉ còn tối đa ${capacity} ô xếp hợp lệ, thiếu tối thiểu ${shortage} tiết.`
      });
    });
    warnings.sort((a,b)=>
      Number(b.shortage||0)-Number(a.shortage||0) ||
      Number(b.required||0)-Number(a.required||0) ||
      String(a.className||a.classId).localeCompare(String(b.className||b.classId),'vi')
    );
    const max=toInt(maxItems,0);
    return max > 0 ? warnings.slice(0,max) : warnings;
  }
  function teacherCapacityWarningSuffix(limit){
    const warnings=[...teacherFixedOffCapacityWarnings(), ...classFixedOffCapacityWarnings()];
    if(!warnings.length) return '';
    const max=Math.max(1, Number(limit || 3));
    const parts=warnings.slice(0,max).map(w=>{
      if(w.kind === 'class.fixedOff.capacity') return `${w.className || w.classId} thiếu tối thiểu ${w.shortage} tiết (cần ${w.required}, còn tối đa ${w.capacity})`;
      return `${teacherShortName(w.teacherId,w.teacherName)} thiếu tối thiểu ${w.shortage} tiết (cần ${w.required}, còn tối đa ${w.capacity})`;
    });
    return `\n\nCảnh báo thiếu ô xếp: ${parts.join('; ')}${warnings.length>max?`; còn ${warnings.length-max} mục khác`:''}. Solver vẫn có thể chạy, các tiết dư sẽ nằm ở Chưa phân.`;
  }
  function withTeacherCapacityWarning(message){
    return String(message || '') + teacherCapacityWarningSuffix(3);
  }
  function teacherCapacityWarningsHtml(warnings, opts){
    const list=Array.isArray(warnings) ? warnings : [];
    if(!list.length) return '';
    const limit=Math.max(1, Number(opts?.limit || 6));
    const shown=list.slice(0,limit);
    const rows=shown.map(w=>{
      const isClass=w.kind === 'class.fixedOff.capacity';
      const name=isClass ? (w.className || w.classId) : teacherShortName(w.teacherId,w.teacherName);
      const sub=isClass ? 'Lớp học' : (w.teacherName || w.teacherId);
      const detail=isClass
        ? `Nghỉ lớp: ${esc(w.fixedClassOffCount)} ô; tiết cố định vẫn được giữ.`
        : `Nghỉ GV: ${esc(w.fixedTeacherOffCount)} ô; ô hợp lệ theo lớp/môn/phòng: ${esc(w.feasibleSlotCapacity)}; giới hạn GV: ${esc(w.genericCapacity)}`;
      return `<tr>
      <td><b>${esc(name)}</b><div class="muted">${esc(sub)}</div></td>
      <td>${esc(w.required)}</td>
      <td>${esc(w.capacity)}</td>
      <td class="rb-shortage">${esc(w.shortage)}</td>
      <td class="muted">${detail}</td>
    </tr>`;
    }).join('');
    return `<div class="box rb-warning-box">
      <b>Cảnh báo thiếu ô xếp</b>
      <div class="muted">Có ${list.length} mục cần nhiều tiết hơn số ô còn có thể xếp theo PCCM và yêu cầu hiện tại. App không chặn sắp xếp; tiết dư sẽ được đưa vào Chưa phân để bạn tự điều chỉnh.</div>
      <div class="table-wrap" style="margin-top:8px;max-height:${opts?.tall?'420':'220'}px"><table><thead><tr><th>Đối tượng</th><th>Cần</th><th>Còn tối đa</th><th>Thiếu</th><th>Chi tiết</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${list.length>shown.length?`<div class="muted" style="margin-top:6px">Còn ${esc(list.length-shown.length)} mục khác.</div>`:''}
    </div>`;
  }
  function fixedLessonRows(){
    const sig=quickTkbSignature()+'|fixedLessonRows|'+Object.keys(D().tkb || {}).length;
    if(__cache.fixedLessonRows && __cache.fixedLessonRowsSig===sig) return __cache.fixedLessonRows;
    const rows=[];
    const d=D();
    const tkbs=d.tkb || {};
    const dayKeys=days();
    const dayOrder=new Map(dayKeys.map((key,idx)=>[String(key),idx]));
    const sessionOrder=new Map(SESSION_KEYS.map((key,idx)=>[String(key),idx]));
    const classMeta=new Map();
    (d.lop || []).forEach((l,idx)=>{
      const id=String(l?.id || l?.ten || l?.ten2 || '').trim();
      if(!id) return;
      classMeta.set(id,{
        name:String((l && (l.ten || l.ten2 || l.id)) || id).trim(),
        canon:String((l && (l.ten || l.ten2 || l.id)) || id).trim(),
        order:idx
      });
    });
    const classNameFast=lopId=>String(classMeta.get(String(lopId))?.name || lopId || '').trim();
    const classCanonFast=lopId=>String(classMeta.get(String(lopId))?.canon || lopId || '').trim();
    const assignmentValue=(matrix, lopId, mon, fallback)=>{
      const subject=String(mon || '').trim();
      const id=String(lopId || '').trim();
      const canon=classCanonFast(id);
      const direct=String(matrix?.[canon+'|'+subject] || matrix?.[id+'|'+subject] || '').trim();
      if(direct) return direct;
      return typeof fallback === 'function' ? fallback() : '';
    };
    const teacherFast=(lopId,mon)=>assignmentValue(d.pccmMatrix || {}, lopId, mon, ()=>teacherOf(lopId,mon));
    const roomFast=(lopId,mon)=>assignmentValue(d.pccmRoomMatrix || {}, lopId, mon, ()=>roomOf(lopId,mon));
    Object.keys(tkbs).forEach(lopId=>{
      const tkb=tkbs[lopId] || {};
      dayKeys.forEach(thu=>SESSION_KEYS.forEach(buoi=>{
        const arr=tkb?.[thu]?.[buoi] || [];
        for(let ti=0; ti<arr.length; ti++){
          const v=arr[ti];
          if(!isFixedSafe(v)) continue;
          const mon=cellMonSafe(v);
          if(!mon) continue;
          rows.push({
            lopId:String(lopId),
            className:classNameFast(lopId),
            classOrder:Number(classMeta.get(String(lopId))?.order ?? Number.POSITIVE_INFINITY),
            mon,
            teacher:teacherFast(lopId,mon),
            room:roomFast(lopId,mon),
            thu,
            buoi,
            ti:Number(ti)
          });
        }
      }));
    });
    rows.sort((a,b)=>
      Number(a.classOrder)-Number(b.classOrder) ||
      String(a.className||a.lopId).localeCompare(String(b.className||b.lopId),'vi',{numeric:true}) ||
      Number(dayOrder.get(String(a.thu)) ?? 999)-Number(dayOrder.get(String(b.thu)) ?? 999) ||
      Number(sessionOrder.get(String(a.buoi)) ?? 999)-Number(sessionOrder.get(String(b.buoi)) ?? 999) ||
      Number(a.ti)-Number(b.ti) ||
      String(a.mon||'').localeCompare(String(b.mon||''),'vi')
    );
    __cache.fixedLessonRowsSig=sig;
    __cache.fixedLessonRows=rows;
    return rows;
  }
  function fixedLessonCount(){ return fixedLessonRows().length; }
  function dashboardMeaningful(v){
    if(v == null || v === '') return false;
    if(typeof v === 'boolean') return v === true;
    if(typeof v === 'number') return Number.isFinite(v) && v > 0;
    if(typeof v === 'string'){
      const s=v.trim();
      if(!s) return false;
      const n=Number(s);
      return Number.isFinite(n) ? n > 0 : true;
    }
    if(Array.isArray(v)) return v.some(dashboardMeaningful);
    if(typeof v === 'object') return Object.values(v).some(dashboardMeaningful);
    return false;
  }
  function teacherDashboardRuleCount(rule){
    return buildTeacherDashboardCounts()[rule] || 0;
  }
  function buildTeacherDashboardCounts(){
    const sig=String(__cacheRev);
    if(__cache.teacherDashboardCounts && __cache.teacherDashboardCountsSig===sig) return __cache.teacherDashboardCounts;
    const counts={};
    TEACHER_RULES.forEach(([rule])=>{ counts[rule]=0; });
    Object.values(model().teacher || {}).forEach(row=>{
      TEACHER_RULES.forEach(([rule])=>{
        if(dashboardMeaningful(row?.[rule])) counts[rule]++;
      });
    });
    __cache.teacherDashboardCountsSig=sig;
    __cache.teacherDashboardCounts=counts;
    return counts;
  }
  function buildSubjectDashboardCounts(){
    const counts={};
    SUBJECT_RULES.forEach(([rule])=>{ counts[rule]=subjectDashboardRuleCount(rule); });
    return counts;
  }
  function dashboardCapacityWarningsCached(limit){
    const max=Math.max(1, Number(limit || 5));
    const sig=quickTkbSignature()+'|dashboardCapacityWarnings|'+String(__cacheRev)+'|'+max;
    if(__cache.dashboardCapacityWarnings && __cache.dashboardCapacityWarningsSig===sig) return __cache.dashboardCapacityWarnings;
    const warnings=[...teacherFixedOffCapacityWarnings(max), ...classFixedOffCapacityWarnings(max)];
    __cache.dashboardCapacityWarningsSig=sig;
    __cache.dashboardCapacityWarnings=warnings;
    return warnings;
  }
  let __dashboardCapacityToken=0;
  function scheduleDashboardCapacityWarnings(){
    const token=++__dashboardCapacityToken;
    const run=()=>{
      if(token !== __dashboardCapacityToken || state.section !== 'dashboard') return;
      const host=document.querySelector(`#${PANEL_ID} [data-rb-dashboard-capacity]`);
      if(!host) return;
      try{
        host.innerHTML=teacherCapacityWarningsHtml(dashboardCapacityWarningsCached(5), {limit:5});
      }catch(err){
        console.warn('[tkb-constraints] dashboard capacity warnings failed', err);
        host.innerHTML='';
      }
    };
    try{
      if(typeof window.requestAnimationFrame === 'function'){
        window.requestAnimationFrame(()=>{ window.setTimeout(run, 0); });
      }else{
        window.setTimeout(run, 0);
      }
    }catch(_){
      window.setTimeout(run, 0);
    }
  }
  function subjectDashboardRuleValue(row, rule){
    if(!row || typeof row !== 'object') return null;
    if(rule === 'maxPeriodsDay') return getPath(row,'maxPeriods.day',null);
    if(rule === 'avoidBreakPair23' && dashboardMeaningful(row.avoidBreakPairs)) return row.avoidBreakPairs;
    if(rule === 'avoidBreakPair34' && dashboardMeaningful(row.avoidBreakPairs)) return row.avoidBreakPairs;
    if(rule === 'sessionAllowed'){
      const conf = row.sessionAllowed;
      if(!conf || typeof conf !== 'object') return null;
      const blockedMorning = Object.prototype.hasOwnProperty.call(conf,'allowMorning') && conf.allowMorning === false;
      const blockedAfternoon = Object.prototype.hasOwnProperty.call(conf,'allowAfternoon') && conf.allowAfternoon === false;
      return blockedMorning || blockedAfternoon || truthy(conf.oneSessionPerDay) ? true : null;
    }
    return row[rule];
  }
  function subjectDashboardRuleCount(rule){
    if(rule === 'noSameSession' || rule === 'noSameDay') return noSameActiveGroupCountFor(rule);
    const c=model();
    let count=0;
    [c.subject || {}, c.subjectGroup || {}].forEach(root=>{
      Object.values(root).forEach(obj=>{
        Object.values(obj?.byClass || {}).forEach(row=>{
          if(dashboardMeaningful(subjectDashboardRuleValue(row, rule))) count++;
        });
      });
    });
    return count;
  }
  function noSameActiveGroupCountFor(rule){
    const root=model().subjectNoSameSession || {};
    const key=noSameKindKey(rule);
    let count=0;
    Object.values(root.byClass || {}).forEach(row=>{
      Object.values(row?.[key]?.groups || {}).forEach(raw=>{ if(noSameRawItems(raw).length > 1) count++; });
    });
    if(rule === 'noSameSession'){
      Object.values(root.groups || {}).forEach(raw=>{ if(noSameRawItems(raw).length > 1) count++; });
    }
    return count;
  }
  function dashboardTimeLimitGroupCount(type){
    try{ return timeLimitGroupsForType(type).length; }catch(_){ return 0; }
  }
  function dashboardTimeLimitRuleCount(){
    return (model().timeLimit || []).filter(r=>timeLimitRuleHasPositiveLimit(r)).length;
  }
  function dashboardAction(label, section, rule, title, primary, icon, count){
    const cls=`rb-action${primary?' primary':''}`;
    const countHtml=count == null ? '' : `<span class="rb-count">${esc(count)}</span>`;
    const body=`${icon ? rbIcon(icon) : ''}<span>${esc(label)}</span>${countHtml}`;
    return `<button type="button" class="${cls}" data-rb-dashboard-open="${esc(section)}" data-rule="${esc(rule||'')}" data-title="${esc(title||label)}" title="${esc(title||label)}">${body}</button>`;
  }
  function dashboardRuleList(items){
    return `<div class="rb-dashboard-list">${items.map(item=>dashboardAction(item.label,item.section,item.rule,item.title,item.primary,item.icon,item.count)).join('')}</div>`;
  }
  function renderDashboard(){
    const pageMode=isPagePanel();
    const teacherCounts=buildTeacherDashboardCounts();
    const subjectCounts=buildSubjectDashboardCounts();
    const teacherRules=Object.values(teacherCounts).reduce((sum,n)=>sum+Number(n || 0),0);
    const subjectRules=Object.values(subjectCounts).reduce((sum,n)=>sum+Number(n || 0),0);
    const fixedSlots=['class','teacher','subject','subjectGroup','room'].reduce((sum,type)=>sum+countFixedOffSlots(type),0);
    const groups=['class','subject'].reduce((sum,type)=>sum+dashboardTimeLimitGroupCount(type),0);
    const limitRules=dashboardTimeLimitRuleCount();
    const teacherDashLabel={
      maxDaysSessions:'Ngày dạy & buổi/tuần',
      maxPeriods:'Số tiết dạy/buổi',
      maxMorningAfternoon:'Buổi sáng & chiều',
      oneSessionPerDay:'1 buổi/ngày',
      noMorningP5AfternoonP1:'Tránh tiết 5 sáng + tiết 1 chiều',
      oneLocationPerSession:'1 địa điểm/buổi',
      gapBetweenLocations:'Tiết trống giữa địa điểm',
      maxOneMovePerSession:'Tối đa 1 lần di chuyển/buổi',
      mustTeach:'Vị trí bắt buộc có tiết dạy'
    };
    const subjectDashLabel={
      lessonBlocks:'Buổi có tiết liền',
      avoidBreakPair23:'Tránh cặp tiết 2-3',
      avoidBreakPair34:'Tránh cặp tiết 3-4',
      linkedDays:'Tránh tiết liền theo thứ',
      sessionAllowed:'Giới hạn buổi',
      weeklySessionPeriods:'Số tiết môn/buổi/tuần',
      spacingDays:'Học cách ngày',
      maxPeriods:'Số tiết/1 buổi',
      maxPeriodsDay:'Số tiết/1 ngày',
      noSameSession:'Không cùng buổi',
      noSameDay:'Không cùng ngày',
      maxSessions:'Số buổi học'
    };
    const withCount = items => items.filter(item=>Number(item.count || 0) > 0);
    const teacherItems=withCount([
      ...TEACHER_RULES.map(([rule,title])=>({label:teacherDashLabel[rule] || title,section:'teacher',rule,title,primary:rule==='maxDaysSessions',count:teacherCounts[rule] || 0})),
      {label:fixedOffTitle('teacher'),section:'fixedOff',rule:'teacher',title:fixedOffTitle('teacher'),count:countFixedOffSlots('teacher')}
    ]);
    const classItems=withCount([
      {label:fixedOffTitle('class'),section:'fixedOff',rule:'class',title:fixedOffTitle('class'),primary:true,count:countFixedOffSlots('class')}
    ]);
    const subjectItems=withCount([
      ...SUBJECT_RULES.map(([rule,title])=>({label:subjectDashLabel[rule] || title,section:'subject',rule,title,primary:rule==='lessonBlocks',count:subjectCounts[rule] || 0})),
      {label:fixedOffTitle('subject'),section:'fixedOff',rule:'subject',title:fixedOffTitle('subject'),count:countFixedOffSlots('subject')}
    ]);
    const limitItems=withCount([
      {label:'Nhóm lớp',section:'timeLimit',rule:'groups-class',title:'Tạo nhóm lớp',primary:true,count:dashboardTimeLimitGroupCount('class')},
      {label:'Nhóm môn học',section:'timeLimit',rule:'groups-subject',title:'Tạo nhóm môn học',count:dashboardTimeLimitGroupCount('subject')},
      {label:'Giới hạn thời điểm',section:'timeLimit',rule:'limits',title:'Giới hạn số tiết/1 thời điểm',count:limitRules}
    ]);
    const cards=[
      {title:'Giáo viên', items:teacherItems},
      {title:'Lớp', items:classItems},
      {title:'Môn học', items:subjectItems},
      {title:'Giới hạn', items:limitItems}
    ].filter(card=>card.items.length);
    const overviewItems=[
      ['Yêu cầu giáo viên', teacherRules],
      ['Yêu cầu môn/lớp', subjectRules],
      [FIXED_OFF_GROUP_LABEL + ' đã đặt', fixedSlots],
      ['Nhóm giới hạn', groups],
      ['Giới hạn thời điểm', limitRules]
    ].filter(([,value])=>Number(value || 0) > 0);
    const overviewHtml=overviewItems.length
      ? `<div class="rb-overview">${overviewItems.map(([label,value])=>dashboardStat(label,value)).join('')}</div>`
      : '';
    const cardsHtml=cards.length
      ? `<div class="rb-dashboard-grid">${cards.map(card=>`<section class="rb-dashboard-card"><h4>${esc(card.title)}</h4>${dashboardRuleList(card.items)}</section>`).join('')}</div>`
      : `<div class="rb-dashboard-empty">Chưa có yêu cầu nào đang được thiết lập.</div>`;
    return `<div class="rb-dashboard">
      ${pageMode ? '' : `<div class="rb-dashboard-head">
        <h3>Yêu cầu thời khóa biểu</h3>
      </div>`}
      ${overviewHtml}
      <div data-rb-dashboard-capacity></div>
      ${cardsHtml}
    </div>`;
  }
  function groupTypeLabel(type){
    return ({class:'Nhóm lớp', subject:'Nhóm môn', room:'Nhóm phòng'})[type] || 'Nhóm';
  }
  function renderGroupTypeOptions(selected){
    return [['class','Nhóm lớp'],['subject','Nhóm môn'],['room','Nhóm phòng']]
      .map(([id,label])=>`<option value="${esc(id)}" ${String(id)===String(selected)?'selected':''}>${esc(label)}</option>`).join('');
  }
  function renderGroups(){
    const type=['class','subject','room'].includes(state.groupType) ? state.groupType : 'class';
    state.groupType=type;
    const c=model();
    const groups=c.groups[type] || {};
    if(state.groupId && !groups[state.groupId]) state.groupId='';
    const selected=state.groupId || '';
    const current=selected ? normalizeGroup(groups[selected]) : {name:'',items:[]};
    const checked=new Set(current.items || []);
    const list=listByType(type);
    const groupRows=Object.entries(groups).map(([id,g])=>`<tr><td><b>${esc(g.name || id)}</b><div class="muted">${esc(id)}</div></td><td>${esc((g.items||[]).length)}</td></tr>`).join('');
    return `<div class="rb-group-screen">
      <h3>Nhóm lớp / môn / phòng</h3>
      <div class="hint">Nhóm dùng cho yêu cầu theo cụm: nhóm lớp, nhóm môn và nhóm phòng. Dữ liệu lưu trực tiếp trong DATA.tkbConstraints.groups.</div>
      <div class="rb-group-editor">
        <div class="rb-group-side box">
          <label>Loại nhóm
            <select data-rb-group-type>${renderGroupTypeOptions(type)}</select>
          </label>
          <label>Nhóm đang sửa
            <select data-rb-group-id>
              <option value="" ${selected?'':'selected'}>Tạo nhóm mới</option>
              ${Object.entries(groups).map(([id,g])=>`<option value="${esc(id)}" ${String(id)===String(selected)?'selected':''}>${esc(g.name || id)}</option>`).join('')}
            </select>
          </label>
          <label>Tên nhóm
            <input type="text" data-rb-group-name value="${esc(current.name || '')}" placeholder="${esc(groupTypeLabel(type))}">
          </label>
          <div class="rb-card-actions">
            <button type="button" data-rb-new-group>Nhóm mới</button>
            <button type="button" class="danger" data-rb-delete-group ${selected?'':'disabled'}">Xóa nhóm</button>
          </div>
          <div class="table-wrap" style="max-height:260px">
            <table><thead><tr><th>${esc(groupTypeLabel(type))}</th><th>Số mục</th></tr></thead><tbody>${groupRows || '<tr><td colspan="2" class="muted">Chưa có nhóm.</td></tr>'}</tbody></table>
          </div>
        </div>
        <div class="box">
          <b>Bảng chi tiết</b>
          <div class="muted" style="margin:4px 0 8px">Tích các mục thuộc nhóm này.</div>
          ${checkAllBox('groupItems')}
          <div class="rb-group-items" data-rb-group-items>
            ${list.map(item=>`<label><input type="checkbox" value="${esc(item.id)}" ${checked.has(item.id)?'checked':''}> <span>${esc(item.name || item.id)}</span></label>`).join('') || '<div class="muted">Chưa có dữ liệu nền.</div>'}
          </div>
        </div>
      </div>
    </div>`;
  }
  function renderInfo(){
    const meta=model().meta || {};
    const dateText = meta.effectiveDate
      ? (function(){ try{ return new Date(meta.effectiveDate).toLocaleDateString('vi-VN'); }catch(_){ return esc(meta.effectiveDate); } })()
      : 'Chưa đặt';
    return `<div class="rb-info-screen">
      <div class="hint" style="margin:0 0 12px">Thông tin trường, TKB số và ngày áp dụng được thiết lập tại trang <b>Quản lý</b>. Tại đây chỉ hiển thị.</div>
      <div class="rb-info-form">
        <label>Trường:</label>
        <div class="rb-info-value">${esc(meta.schoolName || '—')}</div>
        <label>Thời khóa biểu số:</label>
        <div class="rb-info-value">${esc(meta.scheduleNumber || '—')}</div>
        <label>Ngày áp dụng:</label>
        <div class="rb-info-value">${dateText}</div>
      </div>
    </div>`;
  }
  function renderNav(){
    const nav=document.querySelector(`#${PANEL_ID} [data-rb-nav]`);
    if(!nav) return;
    nav.innerHTML=`<h4>Tổng quan</h4>${navButton('Yêu cầu thời khóa biểu','dashboard')}<h4>Giáo viên</h4>${TEACHER_RULES.map(r=>navButton(r[1],'teacher',r[0])).join('')}<h4>Lớp / Môn học</h4>${SUBJECT_RULES.map(r=>navButton(r[1],'subject',r[0])).join('')}<h4>${FIXED_OFF_GROUP_LABEL}</h4>${FIXED_OFF_TYPES.map(r=>navButton(r[1],'fixedOff',r[0])).join('')}<h4>Khác</h4>${navButton('Giới hạn số tiết/1 thời điểm','timeLimit')}${navButton('Xóa yêu cầu TKB','clear')}`;
    nav.querySelectorAll('button[data-section]').forEach(b=>{ b.onclick=()=>{ if(!saveCurrentBeforeNavigation()) return; state.section=b.dataset.section; const r=b.dataset.rule; if(state.section==='teacher'&&r) state.teacherRule=r; if(state.section==='subject'&&r) state.subjectRule=r; if(state.section==='subjectGroup'&&r) state.subjectGroupRule=r; if(state.section==='fixedOff'&&r) state.fixedType=r; render(); }; });
  }
  function render(){ renderNav(); updateFixedOffRibbon(); const body=document.querySelector(`#${PANEL_ID} [data-rb-body]`); if(!body) return; body.dataset.rbSection=state.section || 'dashboard'; if(state.section==='info') body.innerHTML=renderInfo(); else if(state.section==='dashboard') body.innerHTML=renderDashboard(); else if(state.section==='groups') body.innerHTML=renderGroups(); else if(state.section==='teacher') body.innerHTML=renderTeacherRule(state.teacherRule); else if(state.section==='subject') body.innerHTML=renderSubjectRule(state.subjectRule); else if(state.section==='subjectGroup') body.innerHTML=renderSubjectGroupRule(state.subjectGroupRule); else if(state.section==='fixedOff') body.innerHTML=renderFixedOff(state.fixedType); else if(state.section==='fixedLesson') body.innerHTML=renderFixedLessons(); else if(state.section==='timeLimit') body.innerHTML=renderTimeLimit(); else if(state.section==='check') body.innerHTML=renderCheck(); else if(state.section==='clear') body.innerHTML=renderClear(); else body.innerHTML=renderDashboard(); updateFixedOffRibbon(); bindBodyEvents(); rememberCurrentFormSignature(); if(state.section==='dashboard') scheduleDashboardCapacityWarnings(); }
  function fixedOffListScrollKey(){
    if(state.section==='teacher' && state.teacherRule==='mustTeach') return 'teacher:mustTeach';
    if(state.section==='fixedOff') return `fixedOff:${state.fixedType || ''}`;
    return '';
  }
  function rememberFixedOffListScroll(list,key){
    const k=key || fixedOffListScrollKey();
    if(!k || !list) return null;
    state.fixedOffListScroll=state.fixedOffListScroll || {};
    state.fixedOffListScroll[k]={top:Number(list.scrollTop || 0),left:Number(list.scrollLeft || 0)};
    return state.fixedOffListScroll[k];
  }
  function fixedOffListScrollSnapshot(){
    const key=fixedOffListScrollKey();
    const list=document.querySelector(`#${PANEL_ID} .rb-fixedoff-list`);
    return list ? rememberFixedOffListScroll(list,key) : (state.fixedOffListScroll?.[key] || null);
  }
  function restoreFixedOffListScroll(snapshot,key){
    if(!snapshot) return;
    const k=key || fixedOffListScrollKey();
    if(k){
      state.fixedOffListScroll=state.fixedOffListScroll || {};
      state.fixedOffListScroll[k]=snapshot;
    }
    const run=()=>{
      const list=document.querySelector(`#${PANEL_ID} .rb-fixedoff-list`);
      if(!list) return;
      list.scrollTop=Number(snapshot.top || 0);
      list.scrollLeft=Number(snapshot.left || 0);
    };
    run();
    if(typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    setTimeout(run,0);
    setTimeout(run,40);
    setTimeout(run,140);
  }
  function renderKeepingFixedOffListScroll(){
    const key=fixedOffListScrollKey();
    const snapshot=fixedOffListScrollSnapshot();
    render();
    restoreFixedOffListScroll(snapshot,key);
  }
  function isPagePanel(){ return !!document.getElementById(PANEL_ID)?.classList.contains('rb-page-panel'); }
  function localActionButtons(){ return (isPagePanel() || ['fixedOff','fixedLesson','timeLimit'].includes(state.section)) ? '' : `<button type="button" class="danger" data-rb-clear-current>Xóa</button>`; }
  function selectSubjectToolbar(){ const list=getSubjectList(); if(!state.subjectId && list.length) state.subjectId=list[0].id; return `<div class="toolbar"><label>Môn học <select data-subject-id>${list.map(x=>`<option value="${esc(x.id)}" ${x.id===state.subjectId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><label>Nhóm lớp học <select data-class-group-filter><option value="">(Chọn tất cả)</option>${groupOptions('class',state.classGroup,{skipAll:true})}</select></label>${localActionButtons()}</div>`; }
  function selectSubjectGroupToolbar(){ const opts=Object.entries(model().groups.subject||{}); if(!state.subjectGroupId && opts.length) state.subjectGroupId=opts[0][0]; return `<div class="toolbar"><label>Nhóm môn học <select data-subject-group-id>${opts.map(([id,g])=>`<option value="${esc(id)}" ${id===state.subjectGroupId?'selected':''}>${esc(g.name||id)}</option>`).join('')}</select></label><label>Nhóm lớp <select data-class-group-filter><option value="">(Chọn tất cả)</option>${groupOptions('class',state.classGroup,{skipAll:true})}</select></label>${localActionButtons()}</div>`; }

  function teacherFilterToolbar(){
    const filters = ``;
    const actions = localActionButtons();
    if(!filters && !actions) return '';
    return `<div class="toolbar rb-teacher-toolbar">`+
      filters+
      `<span class="rb-toolbar-spacer"></span>`+
      actions+
    `</div>`;
  }
  function filteredTeachers(){ let arr=getTeacherList(); const q=norm(state.search); if(q) arr=arr.filter(x=>norm(x.id).includes(q)||norm(x.name).includes(q)); return arr; }
  function numberInputClass(){ return `class="rb-num-cell-input" data-rb-num-cell="1" inputmode="numeric"`; }
  function inputNum(tid,path,val){ return `<input type="number" ${numberInputClass()} data-tid="${esc(tid)}" data-path="${esc(path)}" min="0" value="${esc(val == null ? '' : val)}">`; }
  function inputCheck(tid,path,val){ return `<input type="checkbox" data-tid="${esc(tid)}" data-path="${esc(path)}" ${truthy(val)?'checked':''}>`; }
  function inputSelect(tid,path,val,options){ return `<select data-tid="${esc(tid)}" data-path="${esc(path)}">${options.map(o=>`<option value="${esc(o[0])}" ${String(o[0])===String(val)?'selected':''}>${esc(o[1])}</option>`).join('')}</select>`; }
  function thDaysGrouped(colspan){ return days().map(d=>`<th colspan="${colspan}">${esc(dayLabel(d))}</th>`).join(''); }
  function tableEmpty(msg){ return `<div class="hint">${esc(msg || 'Chưa có dữ liệu.')}</div>`; }
  function checkAllInput(scope, label, filter){
    const filterAttr = filter ? ` data-rb-check-filter="${esc(filter)}"` : '';
    return `<label class="rb-check-all"><input type="checkbox" data-rb-check-all="${esc(scope)}"${filterAttr}><span>${esc(label || 'Chọn tất cả')}</span></label>`;
  }
  function checkAllBox(scope, label, filter){
    return `<div class="rb-check-all-row">${checkAllInput(scope,label,filter)}</div>`;
  }
  function checkAllRow(scope, items){
    return `<div class="rb-check-all-row">${(items || []).map(item=>checkAllInput(scope,item.label,item.filter)).join('')}</div>`;
  }
  function withFilteredCheckAll(html, items, className){
    const cls=className ? ` class="${esc(className)}"` : '';
    return `<div${cls} data-rb-check-scope="fields">${checkAllRow('fields',items)}${html}</div>`;
  }
  function tableCheckAllHeader(label, filter){
    const filterAttr = filter ? ` data-rb-check-filter="${esc(filter)}"` : '';
    return `<label class="rb-th-check-all" title="Chọn tất cả"><input type="checkbox" data-rb-check-all="fields"${filterAttr}><span>${esc(label || '')}</span></label>`;
  }
  function gridCheckAllBox(kind, attrs, label){
    const extra = attrs || '';
    return `<div class="rb-check-all-row rb-grid-check-row">`+
      `<label class="rb-check-all"><input type="checkbox" data-rb-grid-all="${esc(kind)}" ${extra}><span>${esc(label || 'Chọn tất cả')}</span></label>`+
      `<label class="rb-check-all"><input type="checkbox" data-rb-grid-session="${esc(kind)}" data-buoi="sang" ${extra}><span>Chọn sáng</span></label>`+
      `<label class="rb-check-all"><input type="checkbox" data-rb-grid-session="${esc(kind)}" data-buoi="chieu" ${extra}><span>Chọn chiều</span></label>`+
    `</div>`;
  }
  function withCheckAll(scope, html, label){
    return `<div data-rb-check-scope="${esc(scope)}">${checkAllBox(scope,label)}${html}</div>`;
  }
  function slotKeysForGrid(onlyBuoi){
    const keys=[];
    const sessions = onlyBuoi ? [onlyBuoi] : SESSION_KEYS;
    days().forEach(thu=>sessions.forEach(buoi=>{
      const len=sessionLen(buoi);
      for(let ti=0; ti<len; ti++) keys.push(slotKey(thu,buoi,ti));
    }));
    return keys;
  }
  function allSlotKeysForGrid(){ return slotKeysForGrid(); }

  /* ===================== UI TEACHER ===================== */
  function teacherRuleObj(id){ return model().teacher?.[id] || {}; }
  function shortDayLabel(d){
    const map={thu2:'T2',thu3:'T3',thu4:'T4',thu5:'T5',thu6:'T6',thu7:'T7'};
    return map[d] || dayLabel(d);
  }
  function normalizeClassLike(name){
    let s=String(name || '').trim();
    if(!s) return '';
    if(/^\d+A\d+$/i.test(s)) return s.toUpperCase();
    const m=s.match(/^(\d+)[\.\-_/ ]+(\d+)$/);
    if(m) return `${m[1]}A${m[2]}`.toUpperCase();
    const m2=s.match(/^(\d+)A0?(\d+)$/i);
    if(m2) return `${m2[1]}A${m2[2]}`.toUpperCase();
    return s.toUpperCase();
  }
  function classShiftCode(lop){
    const raw=[lop?.buoi,lop?.buoihoc,lop?.session,lop?.shift,lop?.ca,lop?.caHoc,lop?.loaiBuoi].map(v=>String(v||'').trim()).filter(Boolean).join(' ');
    const s=norm(raw).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d');
    if(!s) return '';
    if(/\b(sc|full|all)\b/.test(s) || s.includes('ca ngay') || s.includes('2 buoi') || s.includes('hai buoi') || s.includes('sang chieu')) return 'SC';
    if(s.includes('chieu') || /\b(pm|c)\b/.test(s)) return 'C';
    if(s.includes('sang') || /\b(am|s)\b/.test(s)) return 'S';
    return '';
  }
  function classKeyCandidates(cls, lop){
    const out=new Set();
    [cls,normalizeClassLike(cls),lop?.id,lop?.ten,lop?.ten2,lop?.ma,classCanon(lop?.id)].forEach(v=>{
      const s=String(v || '').trim();
      if(!s) return;
      out.add(s);
      out.add(normalizeClassLike(s));
    });
    return Array.from(out).filter(Boolean);
  }
  function classAliasSet(cls, lop){
    const out=new Set();
    classKeyCandidates(cls, lop).forEach(v=>{
      const s=String(v || '').trim();
      if(!s) return;
      out.add(norm(s));
      out.add(norm(normalizeClassLike(s)));
    });
    return out;
  }
  function classAliasSetHas(aliases, rawCls){
    const s=String(rawCls || '').trim();
    if(!s || !aliases) return false;
    return aliases.has(norm(s)) || aliases.has(norm(normalizeClassLike(s)));
  }
  function subjectKeyCandidates(mon){
    const out=new Set();
    const add=v=>{ const s=String(v || '').trim(); if(s) out.add(s); };
    add(mon);
    add(subjectKey(mon));
    (D().monhoc || []).forEach(m=>{
      const vals=[m?.ten,m?.mon,m?.ma,m?.ma2,m?.mamon,m?.id];
      if(vals.some(v=>v && subjectMatches(v, mon))) vals.forEach(add);
    });
    (D().mon || []).forEach(m=>{
      const vals=[m?.ten,m?.mon,m?.ma,m?.ma2,m?.mamon,m?.id];
      if(vals.some(v=>v && subjectMatches(v, mon))) vals.forEach(add);
    });
    return Array.from(out).filter(Boolean);
  }
  function matrixNumberForClassSubject(matrix, cls, mon, lop){
    if(!matrix || typeof matrix !== 'object') return null;
    const classes=classKeyCandidates(cls, lop);
    const subjects=subjectKeyCandidates(mon);
    for(const c of classes){
      for(const s of subjects){
        const raw=matrix[`${c}|${s}`];
        if(raw == null || String(raw).trim()==='') continue;
        const n=periodNumber(raw);
        if(n > 0) return n;
      }
    }
    return null;
  }
  function periodNumber(v){
    if(v == null) return 0;
    const s=String(v).trim().replace(',', '.');
    if(!s) return 0;
    const n=Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function periodValueFromRecord(m){
    if(!m || typeof m !== 'object') return 0;
    const keys=['sotiet','soTiet','tiet','so_tiet','soTietTuan','sotietTuan','periods','periodsPerWeek','total','tongTiet'];
    for(const k of keys){
      const n=periodNumber(m[k]);
      if(n > 0) return n;
    }
    return 0;
  }
  function classGradeNumber(cls, lop){
    const vals=[lop?.khoi,lop?.grade,lop?.khoiHoc,lop?.ten2,lop?.ten,cls];
    for(const v of vals){
      const m=String(v || '').match(/\d+/);
      if(m) return m[0];
    }
    return '';
  }
  function subjectRecordCandidates(mon){
    const out=[];
    const seen=new Set();
    const add=m=>{
      if(!m || typeof m !== 'object') return;
      const key=[m.id,m.key,m.ma,m.ma2,m.mamon,m.ten,m.mon].map(x=>String(x || '')).join('|');
      if(seen.has(key)) return;
      seen.add(key);
      out.push(m);
    };
    (D().monhoc || []).forEach(m=>{
      const vals=[m?.ten,m?.mon,m?.mamon,m?.ma,m?.ma2,m?.id,m?.key];
      if(vals.some(v=>v && subjectMatches(v, mon))) add(m);
    });
    (D().mon || []).forEach(m=>{
      const vals=[m?.ten,m?.mon,m?.ma,m?.ma2,m?.mamon,m?.id,m?.key];
      if(vals.some(v=>v && subjectMatches(v, mon))) add(m);
    });
    if(!out.length) out.push({key:mon,ten:mon,ma:mon,ma2:mon,id:mon});
    return out;
  }
  function computeMonsForClassCached(grade, classKey){
    if(__cache.computeMonsSig !== String(__cacheRev)){
      __cache.computeMonsSig = String(__cacheRev);
      __cache.computeMonsRows.clear();
    }
    const key=String(grade || '')+'|'+String(classKey || '');
    if(__cache.computeMonsRows.has(key)) return __cache.computeMonsRows.get(key);
    let rows=[];
    try{
      rows = (typeof computeMonsForClass === 'function') ? (computeMonsForClass(grade, classKey) || []) : [];
    }catch(_){
      rows = [];
    }
    __cache.computeMonsRows.set(key, rows);
    return rows;
  }
  function assignmentPeriodsFromPccmHelpers(cls, mon, lop){
    const classKeys=classKeyCandidates(cls, lop);
    const subjectKeys=subjectKeyCandidates(mon);
    try{
      if(typeof computeMonsForClass === 'function'){
        const grade=classGradeNumber(cls, lop);
        for(const c of classKeys){
          const rows=computeMonsForClassCached(grade, c);
          const found=rows.find(r=>subjectMatches(r?.ten || r?.key || r?.ma || r?.id, mon));
          const n=periodValueFromRecord(found);
          if(n > 0) return n;
        }
      }
    }catch(_){ }
    try{
      if(typeof getSoTietForClassMon === 'function'){
        for(const c of classKeys){
          for(const s of subjectKeys){
            const n=periodNumber(getSoTietForClassMon(c, s));
            if(n > 0) return n;
          }
        }
      }
    }catch(_){ }
    try{
      if(typeof pccmGetTiet === 'function'){
        for(const c of classKeys){
          for(const m of subjectRecordCandidates(mon)){
            const n=periodNumber(pccmGetTiet(c, m));
            if(n > 0) return n;
          }
        }
      }
    }catch(_){ }
    try{
      if(typeof pccmGetTietDisplay === 'function'){
        const grade=classGradeNumber(cls, lop);
        const khoiName=grade ? `Khối ${grade}` : String(lop?.khoi || '');
        for(const c of classKeys){
          for(const m of subjectRecordCandidates(mon)){
            const n=periodNumber(pccmGetTietDisplay(c, m, khoiName));
            if(n > 0) return n;
          }
        }
      }
    }catch(_){ }
    return 0;
  }
  function gradeTokensForClass(cls, lop){
    const out=new Set();
    [lop?.khoi,lop?.grade,lop?.khoiHoc,lop?.ten2,lop?.ten,cls].forEach(v=>{
      const s=String(v || '').trim();
      if(!s) return;
      out.add(norm(s));
      const m=s.match(/\d+/);
      if(m) out.add(m[0]);
    });
    return out;
  }
  function standardPeriodsForClassSubject(cls, mon, lop){
    const grades=gradeTokensForClass(cls, lop);
    let best=0;
    (D().mon || []).forEach(m=>{
      const ten=String(m?.ten || m?.mon || m?.mamon || m?.ma || m?.id || '').trim();
      if(!ten || !subjectMatches(ten, mon)) return;
      const rowGrade=String(m?.khoi || m?.grade || m?.khoiHoc || '').trim();
      const rowTokens=gradeTokensForClass(rowGrade, {khoi:rowGrade});
      let sameGrade=!grades.size || !rowTokens.size;
      rowTokens.forEach(t=>{ if(grades.has(t)) sameGrade=true; });
      if(!sameGrade) return;
      const n=periodValueFromRecord(m);
      if(Number.isFinite(n) && n > best) best=n;
    });
    return best;
  }
  function assignmentPeriodsFor(cls, mon, lop, periodBySubject){
    const override=matrixNumberForClassSubject(D().pccmTietMatrix || {}, cls, mon, lop);
    if(override != null) return override;
    const fromAssignment=assignmentPeriodsFromPccmHelpers(cls, mon, lop);
    if(fromAssignment > 0) return fromAssignment;
    const byGrade=standardPeriodsForClassSubject(cls, mon, lop);
    if(Number.isFinite(byGrade) && byGrade > 0) return byGrade;
    const candidates=subjectKeyCandidates(mon).map(x=>norm(x));
    for(const k of candidates){
      const n=Number(periodBySubject.get(k) || 0);
      if(Number.isFinite(n) && n > 0) return n;
    }
    return monWeeklyPeriods(mon);
  }
  function assignmentPeriodsForFast(cls, mon, lop, periodBySubject){
    const override=matrixNumberForClassSubject(D().pccmTietMatrix || {}, cls, mon, lop);
    if(override != null) return override;
    const fromAssignment=assignmentPeriodsFromPccmHelpers(cls, mon, lop);
    if(fromAssignment > 0) return fromAssignment;
    const byGrade=standardPeriodsForClassSubject(cls, mon, lop);
    if(Number.isFinite(byGrade) && byGrade > 0) return byGrade;
    const candidates=subjectKeyCandidates(mon).map(x=>norm(x));
    for(const k of candidates){
      const n=Number(periodBySubject.get(k) || 0);
      if(Number.isFinite(n) && n > 0) return n;
    }
    return monWeeklyPeriods(mon);
  }
  function findClassObject(cls){
    const raw=String(cls || '').trim();
    if(!raw) return null;
    const rawNorm=norm(raw);
    const rawLike=norm(normalizeClassLike(raw));
    return (D().lop || []).find(l=>{
      const vals=[l?.id,l?.ten,l?.ten2,l?.ma,classCanon(l?.id),normalizeClassLike(l?.id),normalizeClassLike(l?.ten),normalizeClassLike(l?.ten2)];
      return vals.some(v=>norm(v)===rawNorm || norm(normalizeClassLike(v))===rawLike);
    }) || null;
  }
  function classMatchesAssignment(targetCls, rawCls, targetLop, rawLop){
    const targetSet=new Set(classKeyCandidates(targetCls, targetLop || findClassObject(targetCls)).map(x=>norm(x)));
    return classKeyCandidates(rawCls, rawLop || findClassObject(rawCls)).some(x=>targetSet.has(norm(x)));
  }
  function pccmAssignmentRows(){
    const sig=dataListSignature('assignmentRows');
    if(__cache.assignmentRows && __cache.assignmentRowsSig===sig) return __cache.assignmentRows;
    const rows=[];
    const seen=new Set();
    const periodBySubject=subjectPeriodMap();
    const keys=[];
    forEachPccmKey(k=>keys.push(k));
    for(const k of keys){
      const parsed=splitPccmKey(k);
      const cls=parsed.cls;
      const mon=parsed.mon;
      if(!cls || !mon) continue;
      const lop=findClassObject(cls);
      const subject=subjectKey(mon);
      const classId=String(lop?.id || cls).trim();
      const uniq=normalizeClassLike(classId || cls)+'|'+norm(subject);
      if(seen.has(uniq)) continue;
      seen.add(uniq);
      const teacher=teacherOf(cls, mon);
      rows.push({
        classId,
        className:String((lop && (lop.ten || lop.ten2 || lop.id)) || cls).trim(),
        cls,
        lop,
        mon:subject || mon,
        rawMon:mon,
        teacher,
        room:roomOf(cls, mon),
        count:Number(assignmentPeriodsForFast(cls, mon, lop, periodBySubject) || 0)
      });
    }
    __cache.assignmentRows=rows;
    __cache.assignmentRowsSig=sig;
    return rows;
  }
  function assignmentRowsForClass(cls){
    const id=String(cls?.id || cls?.name || cls || '').trim();
    const lop=findClassObject(id);
    return pccmAssignmentRows().filter(r=>classMatchesAssignment(id, r.cls, lop, r.lop));
  }
  function subjectPeriodValueMap(isGroup){
    const target=isGroup ? ('group:'+String(state.subjectGroupId || '')) : ('subject:'+String(state.subjectId || ''));
    const sig=[__cacheRev,target].join('|');
    if(__cache.subjectPeriodValues && __cache.subjectPeriodValuesSig===sig) return __cache.subjectPeriodValues;
    const map=new Map();
    const periodBySubject=subjectPeriodMap();
    forEachPccmKey(key=>{
      const parsed=splitPccmKey(key);
      const cls=parsed.cls;
      const mon=parsed.mon;
      if(!cls || !mon) return;
      const ok=isGroup ? subjectInGroup(mon, state.subjectGroupId) : subjectMatches(mon, state.subjectId);
      if(!ok) return;
      const lop=findClassObject(cls);
      const count=Number(assignmentPeriodsForFast(cls, mon, lop, periodBySubject) || 0);
      const keys=classKeyCandidates(String(lop?.id || cls).trim(), lop);
      keys.forEach(k=>{
        const key=norm(k);
        if(key) map.set(key, Number(map.get(key) || 0) + count);
      });
    });
    __cache.subjectPeriodValues=map;
    __cache.subjectPeriodValuesSig=sig;
    return map;
  }
  function subjectPeriodValueForClass(cls, isGroup){
    const id=String(cls?.id || cls?.name || '').trim();
    const lop=findClassObject(id);
    const map=subjectPeriodValueMap(isGroup);
    for(const key of classKeyCandidates(id, lop)){
      const val=map.get(norm(key));
      if(Number(val || 0)>0) return Number(val || 0);
    }
    const periodBySubject=subjectPeriodMap();
    if(isGroup){
      const items=model().groups.subject?.[state.subjectGroupId]?.items || [];
      return items.reduce((sum,mon)=>sum+Number(assignmentPeriodsFor(id, mon, lop, periodBySubject) || 0),0);
    }
    return Number(assignmentPeriodsFor(id, state.subjectId, lop, periodBySubject) || 0);
  }
  function subjectPeriodsCell(cls,isGroup){
    const n=subjectPeriodValueForClass(cls,isGroup);
    return `<td class="rb-total">${statText(n)}</td>`;
  }
  function monWeeklyPeriods(monName){
    const key = subjectKey(monName);
    let best = 0;
    (D().mon || []).forEach(m=>{
      const ten = String(m.ten || m.mon || m.mamon || m.ma || m.id || '').trim();
      if(ten && subjectMatches(ten, key)){
        const n = periodValueFromRecord(m);
        if(Number.isFinite(n) && n > best) best = n;
      }
    });
    (D().monhoc || []).forEach(m=>{
      const ten = String(m.ten || m.mon || m.ma || m.ma2 || m.id || '').trim();
      if(ten && subjectMatches(ten, key)){
        const n = periodValueFromRecord(m);
        if(Number.isFinite(n) && n > best) best = n;
      }
    });
    return best;
  }
  function subjectPeriodMap(){
    const map = new Map();
    function addAlias(alias, n){
      const k = norm(alias);
      const val = Number(n || 0);
      if(!k || !Number.isFinite(val)) return;
      if(val > Number(map.get(k) || 0)) map.set(k, val);
    }
    function addRecord(m){
      const n = periodValueFromRecord(m);
      [m?.ten,m?.mon,m?.mamon,m?.ma,m?.ma2,m?.id].forEach(v=>addAlias(v,n));
    }
    (D().mon || []).forEach(addRecord);
    (D().monhoc || []).forEach(addRecord);
    return map;
  }
  function buildTeacherStatsCache(){
    const sig = dataListSignature('teacherStats') + '|' + quickTkbSignature();
    if(__cache.teacherStats && __cache.teacherStatsSig === sig) return __cache.teacherStats;
    const out = new Map();
    const ensure = id => {
      const code = String(id || '').trim();
      if(!out.has(code)) out.set(code, { S:0, C:0, SC:0, TS:0, days:0, sessions:0, _aS:0, _aC:0, _aSC:0, _aTS:0, _sS:0, _sC:0, _sSC:0, _sTS:0, _daySet:new Set(), _sesSet:new Set() });
      return out.get(code);
    };
    const periodBySubject = subjectPeriodMap();
    const lopById = new Map((D().lop || []).map(l => [String(l.id), l]));
    const lopByCanon = new Map((D().lop || []).map(l => [norm(classCanon(l.id)), l]));
    const seen = new Set();
    for(const [k, v] of Object.entries(D().pccmMatrix || {})){
      const code = String(v || '').trim();
      if(!code) continue;
      const parts = String(k).split('|');
      const cls = String(parts[0] || '').trim();
      const mon = String(parts.slice(1).join('|') || '').trim();
      if(!cls || !mon) continue;
      const uniq = code + '|' + normalizeClassLike(cls) + '|' + norm(subjectKey(mon));
      if(seen.has(uniq)) continue;
      seen.add(uniq);
      const stat = ensure(code);
      const lop = lopByCanon.get(norm(cls)) || lopById.get(cls) || null;
      const shift = classShiftCode(lop);
      const n = Number(assignmentPeriodsForFast(cls, mon, lop, periodBySubject) || 0);
      if(shift === 'S') stat._aS += n;
      else if(shift === 'C') stat._aC += n;
      else if(shift === 'SC') stat._aSC += n;
      else stat._aSC += n;
      stat._aTS += n;
    }
    const idx = buildScheduleIndex();
    if(idx.byTeacher && typeof idx.byTeacher.forEach === 'function'){
      idx.byTeacher.forEach((cells, code)=>{
        const stat = ensure(code);
        cells.forEach(cell=>{
          if(cell.buoi === 'sang') stat._sS += 1;
          else if(cell.buoi === 'chieu') stat._sC += 1;
          stat._sTS += 1;
          stat._daySet.add(String(cell.thu));
          stat._sesSet.add(String(cell.thu) + '|' + String(cell.buoi));
        });
      });
    }
    out.forEach(stat=>{
      // Requirement screens describe the teacher's assigned workload. A
      // partial or failed timetable must never replace it with scheduled cells.
      stat.S = Number(stat._aS || 0);
      stat.C = Number(stat._aC || 0);
      stat.SC = Number(stat._aSC || 0);
      stat.TS = Number(stat._aTS || 0);
      stat.days = stat._daySet.size;
      stat.sessions = stat._sesSet.size;
      delete stat._aS;
      delete stat._aC;
      delete stat._aSC;
      delete stat._aTS;
      delete stat._sS;
      delete stat._sC;
      delete stat._sSC;
      delete stat._sTS;
      delete stat._daySet;
      delete stat._sesSet;
    });
    __cache.teacherStats = out;
    __cache.teacherStatsSig = sig;
    return out;
  }
  function teacherStatsFromAssignments(teacherId){
    const code = String(teacherId || '').trim();
    const stats = { S:0, C:0, SC:0, TS:0, days:0, sessions:0 };
    if(!code) return stats;
    const lopById = new Map((D().lop || []).map(l => [String(l.id), l]));
    const lopByCanon = new Map((D().lop || []).map(l => [norm(classCanon(l.id)), l]));
    const pccm = D().pccmMatrix || {};
    const periodBySubject = subjectPeriodMap();
    const seen = new Set();
    for(const [k, v] of Object.entries(pccm)){
      if(String(v || '').trim() !== code) continue;
      const parts = String(k).split('|');
      const cls = String(parts[0] || '').trim();
      const mon = String(parts.slice(1).join('|') || '').trim();
      if(!cls || !mon) continue;
      const uniq = normalizeClassLike(cls) + '|' + norm(subjectKey(mon));
      if(seen.has(uniq)) continue;
      seen.add(uniq);
      const lop = lopByCanon.get(norm(cls)) || lopById.get(cls) || null;
      const shift = classShiftCode(lop);
      const n = Number(assignmentPeriodsForFast(cls, mon, lop, periodBySubject) || 0);
      if(shift === 'S') stats.S += n;
      else if(shift === 'C') stats.C += n;
      else if(shift === 'SC') stats.SC += n;
      else stats.SC += n;
      stats.TS += n;
    }
    return stats;
  }
  function teacherStatsFromSchedule(teacherId){
    const code = String(teacherId || '').trim();
    const stats = { S:0, C:0, SC:0, TS:0, days:0, sessions:0 };
    if(!code) return stats;
    const idx = buildScheduleIndex();
    const cells = idx.byTeacher?.get(code) || [];
    const daySet = new Set();
    const sesSet = new Set();
    cells.forEach(cell=>{
      if(cell.buoi === 'sang') stats.S += 1;
      else if(cell.buoi === 'chieu') stats.C += 1;
      stats.TS += 1;
      daySet.add(String(cell.thu));
      sesSet.add(String(cell.thu) + '|' + String(cell.buoi));
    });
    stats.days = daySet.size;
    stats.sessions = sesSet.size;
    return stats;
  }
  function teacherStats(id){
    const cached = buildTeacherStatsCache().get(String(id || '').trim());
    if(cached){
      return {
        S: Number(cached.S || 0),
        C: Number(cached.C || 0),
        SC: Number(cached.SC || 0),
        TS: Number(cached.TS || 0),
        days: Number(cached.days || 0),
        sessions: Number(cached.sessions || 0)
      };
    }
    const a = teacherStatsFromAssignments(id);
    const s = teacherStatsFromSchedule(id);
    const out = {
      S: Number(a.S || 0),
      C: Number(a.C || 0),
      SC: Number(a.SC || 0),
      TS: Number(a.TS || 0),
      days: Number(s.days || 0),
      sessions: Number(s.sessions || 0)
    };
    return out;
  }
  function statText(v){ return Number(v || 0) > 0 ? String(Number(v || 0)) : ''; }
  function teacherIndexCell(i){ return `<td class="rb-tt">${i+1}</td>`; }
  function teacherNameCell(t){
    const full=String(t?.name || teacherName(t?.id) || t?.id || '').trim();
    const short=teacherShortName(t?.id, full);
    return `<td class="rb-name"><span class="rb-teacher-short" title="${esc(full)}">${esc(short)}</span></td>`;
  }
  function teacherStatsCells(t){
    const s = teacherStats(t.id);
    return `<td class="rb-total">${statText(s.TS)}</td>`;
  }
  function teacherDaySessionCells(t){
    const s = teacherStats(t.id);
    return `<td>${statText(s.days)}</td><td>${statText(s.sessions)}</td>`;
  }
  function teacherHeaderStats(rowspan){ return rowspan ? `<th rowspan="2">Số tiết</th>` : `<th>Số tiết</th>`; }
  function teacherPeriodColgroup(){
    return `<colgroup><col class="rb-period-tt-col"><col class="rb-period-teacher-col"><col class="rb-period-stat-col">${days().map(()=>'<col class="rb-period-day-col">').join('')}${days().map(()=>'<col class="rb-period-day-col">').join('')}${days().map(()=>'<col class="rb-period-day-col">').join('')}</colgroup>`;
  }
  function renderTeacherRule(rule){
    const title=(TEACHER_RULES.find(x=>x[0]===rule)||[])[1]||'Yêu cầu giáo viên';
    if(rule==='mustTeach') return renderTeacherMustTeach(title);
    const rows=filteredTeachers();
    return `<div class="rb-teacher-screen">${teacherFilterToolbar(rule)}${rows.length?teacherRuleTable(rule,rows):tableEmpty('Chưa có giáo viên.')}</div>`;
  }
  function teacherRuleTable(rule,rows){
    if(rule==='maxDaysSessions'){
      return `<div class="table-wrap rb-desktop-wrap"><table class="rb-desktop-table"><thead><tr><th>TT</th><th>Giáo viên</th>${teacherHeaderStats()}<th>Giới hạn số ngày dạy/1 tuần</th><th>Giới hạn số buổi dạy/1 tuần</th></tr></thead><tbody>${rows.map((t,i)=>{const r=teacherRuleObj(t.id);return `<tr>${teacherIndexCell(i)}${teacherNameCell(t)}${teacherStatsCells(t)}<td>${inputNum(t.id,'maxDaysSessions.maxDays',getPath(r,'maxDaysSessions.maxDays',''))}</td><td>${inputNum(t.id,'maxDaysSessions.maxSessions',getPath(r,'maxDaysSessions.maxSessions',''))}</td></tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='maxPeriods') return teacherDaySessionNumberTable(rows,'maxPeriods');
    if(rule==='maxMorningAfternoon'){
      return `<div class="table-wrap rb-desktop-wrap"><table class="rb-desktop-table"><thead><tr><th>TT</th><th>Giáo viên</th>${teacherHeaderStats()}<th>Giới hạn số buổi dạy sáng</th><th>Giới hạn số buổi dạy chiều</th></tr></thead><tbody>${rows.map((t,i)=>{const r=teacherRuleObj(t.id);return `<tr>${teacherIndexCell(i)}${teacherNameCell(t)}${teacherStatsCells(t)}<td>${inputNum(t.id,'maxMorningAfternoon.morning',getPath(r,'maxMorningAfternoon.morning',''))}</td><td>${inputNum(t.id,'maxMorningAfternoon.afternoon',getPath(r,'maxMorningAfternoon.afternoon',''))}</td></tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='oneSessionPerDay') return teacherDayCheckTable(rows,rule,{mode:'day'});
    if(rule==='noMorningP5AfternoonP1') return teacherDayCheckTable(rows,rule,{mode:'sessionNoMorning'});
    if(['oneLocationPerSession','gapBetweenLocations','maxOneMovePerSession'].includes(rule)) return teacherDayCheckTable(rows,rule,{mode:'session'});
    return '';
  }
  function teacherDaySessionNumberTable(rows,base){
    return `<div class="table-wrap rb-desktop-wrap rb-teacher-period-wrap"><table class="rb-desktop-table rb-teacher-period-table">${teacherPeriodColgroup()}<thead><tr><th rowspan="2">TT</th><th rowspan="2">Giáo viên</th>${teacherHeaderStats(true)}<th colspan="${days().length}">Buổi sáng</th><th colspan="${days().length}">Buổi chiều</th><th colspan="${days().length}">Cả ngày (sáng & chiều)</th></tr><tr>${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}</tr></thead><tbody>${rows.map((t,i)=>{const r=teacherRuleObj(t.id);return `<tr>${teacherIndexCell(i)}${teacherNameCell(t)}${teacherStatsCells(t)}${days().map(d=>`<td>${inputNum(t.id,base+'.sang.'+d,getPath(r,base+'.sang.'+d,''))}</td>`).join('')}${days().map(d=>`<td>${inputNum(t.id,base+'.chieu.'+d,getPath(r,base+'.chieu.'+d,''))}</td>`).join('')}${days().map(d=>`<td>${inputNum(t.id,base+'.day.'+d,getPath(r,base+'.day.'+d,''))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
  }
  function teacherDayCheckTable(rows,base,opts){
    const mode = opts?.mode || 'day';
    if(mode === 'day'){
      const html = `<div class="table-wrap rb-desktop-wrap"><table class="rb-desktop-table"><thead><tr><th>TT</th><th>${tableCheckAllHeader('Giáo viên')}</th>${days().map(d=>`<th>${esc(dayLabel(d))}</th>`).join('')}</tr></thead><tbody>${rows.map((t,i)=>{const r=teacherRuleObj(t.id);return `<tr>${teacherIndexCell(i)}${teacherNameCell(t)}${days().map(d=>`<td class="rb-check">${inputCheck(t.id,base+'.'+d,getPath(r,base+'.'+d,false))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
      return `<div data-rb-check-scope="fields">${html}</div>`;
    }
    if(mode === 'sessionNoMorning'){
      const html = `<div class="table-wrap rb-desktop-wrap"><table class="rb-desktop-table"><thead><tr><th rowspan="2">TT</th><th rowspan="2">Giáo viên</th><th colspan="${days().length}">${tableCheckAllHeader('Buổi sáng','morning')}</th><th colspan="${days().length}">${tableCheckAllHeader('Buổi chiều','afternoon')}</th></tr><tr>${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}</tr></thead><tbody>${rows.map((t,i)=>{const r=teacherRuleObj(t.id);return `<tr>${teacherIndexCell(i)}${teacherNameCell(t)}${days().map(d=>`<td class="rb-check">${inputCheck(t.id,base+'.sang.'+d,getPath(r,base+'.sang.'+d,getPath(r,base+'.'+d,false)))}</td>`).join('')}${days().map(d=>`<td class="rb-check">${inputCheck(t.id,base+'.chieu.'+d,getPath(r,base+'.chieu.'+d,getPath(r,base+'.'+d,false)))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
      return `<div data-rb-check-scope="fields">${html}</div>`;
    }
    const html = `<div class="table-wrap rb-desktop-wrap"><table class="rb-desktop-table"><thead><tr><th rowspan="2">TT</th><th rowspan="2">Giáo viên</th><th colspan="${days().length}">${tableCheckAllHeader('Buổi sáng','morning')}</th><th colspan="${days().length}">${tableCheckAllHeader('Buổi chiều','afternoon')}</th></tr><tr>${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}</tr></thead><tbody>${rows.map((t,i)=>{const r=teacherRuleObj(t.id);return `<tr>${teacherIndexCell(i)}${teacherNameCell(t)}${days().map(d=>`<td class="rb-check">${inputCheck(t.id,base+'.sang.'+d,getPath(r,base+'.sang.'+d,false))}</td>`).join('')}${days().map(d=>`<td class="rb-check">${inputCheck(t.id,base+'.chieu.'+d,getPath(r,base+'.chieu.'+d,false))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
    return `<div data-rb-check-scope="fields">${html}</div>`;
  }

  /* ===================== UI SUBJECT/SUBJECT GROUP ===================== */
  function subjectRuleHasCellChecks(rule){ return ['sessionAllowed','avoidBreakPair23','avoidBreakPair34','linkedDays'].includes(rule); }
  function subjectCheckAllItems(rule){
    return [];
  }
  function wrapSubjectCheckAll(rule, table){
    if(rule==='linkedDays'||rule==='sessionAllowed'||rule==='avoidBreakPair23'||rule==='avoidBreakPair34') return table;
    const items=subjectCheckAllItems(rule);
    if(items.length) return withFilteredCheckAll(table,items);
    return subjectRuleHasCellChecks(rule)?withCheckAll('fields',table):table;
  }
  function renderSubjectRule(rule){
    const table=subjectTable(rule,false);
    if(rule==='noSameSession'||rule==='noSameDay') return subjectTable(rule,false);
    return `${selectSubjectToolbar()}${wrapSubjectCheckAll(rule,table)}`;
  }
  function renderSubjectGroupRule(rule){ const table=subjectTable(rule,true); return `${selectSubjectGroupToolbar()}${wrapSubjectCheckAll(rule,table)}`; }
  function getRuleContainer(isGroup){ const c=model(); if(isGroup){ const gid=state.subjectGroupId || Object.keys(c.groups.subject||{})[0] || ''; state.subjectGroupId=gid; c.subjectGroup[gid]=c.subjectGroup[gid]||{byClass:{}}; return c.subjectGroup[gid]; } const sid=state.subjectId || (getSubjectList()[0]?.id || ''); state.subjectId=sid; c.subject[sid]=c.subject[sid]||{byClass:{}}; return c.subject[sid]; }
  function inputC(prefix,id,path,val){ return `<input type="number" ${numberInputClass()} data-cid="${esc(id)}" data-path="${esc(path)}" min="0" value="${esc(val == null ? '' : val)}">`; }
  function lessonBlockFillInput(path,label){ return `<input type="number" inputmode="numeric" data-rb-lesson-block-fill="${esc(path)}" min="0" value="" aria-label="${esc(label)}" title="${esc(label)}">`; }
  function checkC(prefix,id,path,val){ return `<input type="checkbox" data-cid="${esc(id)}" data-path="${esc(path)}" ${truthy(val)?'checked':''}>`; }
  function renderGlobalLimitTable(scope, rule){ const rootKey=scope==='subjectGroup'?state.subjectGroupId:state.subjectId; const obj=scope==='subjectGroup'?(model().subjectGroup[rootKey]=model().subjectGroup[rootKey]||{}):(model().subject[rootKey]=model().subject[rootKey]||{}); const base=rule==='groupLimit'?'groupLimit':'globalLimit'; const conf=obj[base]||{}; const fake='global'; function cell(path){ return `<input type="number" ${numberInputClass()} data-global-scope="${esc(scope)}" data-global-root="${esc(rootKey)}" data-global-base="${esc(base)}" data-path="${esc(path)}" min="0" value="${esc(getPath(conf,path,''))}">`; } return `<div class="table-wrap"><table><thead><tr><th>Phạm vi</th><th>Lớp học</th><th>Giáo viên</th><th>Phòng học</th></tr></thead><tbody><tr><td><b>/1 tiết</b></td><td>${cell('perSlot.classes')}</td><td>${cell('perSlot.teachers')}</td><td>${cell('perSlot.rooms')}</td></tr><tr><td><b>/1 buổi</b></td><td>${cell('perSession.classes')}</td><td>${cell('perSession.teachers')}</td><td>${cell('perSession.rooms')}</td></tr></tbody></table></div>`; }

  function simpleClassNumberTable(rows,rowRule,cols,isGroup){
    return `<div class="table-wrap"><table><thead><tr><th>Lớp</th><th>Số tiết</th>${cols.map(c=>`<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows.map(cls=>{const r=rowRule(cls);return `<tr><td><b>${esc(cls.name)}</b></td>${subjectPeriodsCell(cls,!!isGroup)}${cols.map(c=>`<td>${inputC('',cls.id,c[0],getPath(r,c[0],''))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
  }
  function renderSubjectNoSameRuleTable(rule){
    const subjects=getSubjectList();
    if(!subjects.length) return tableEmpty('Chưa có môn học.');
    const classes=getClassList();
    if(!classes.length) return tableEmpty('Chưa có lớp.');
    const classId=noSameRuleClassId();
    const selectedClasses=new Set(noSameSelectedClassIds().map(String));
    const groupIds=Array.from({length:10},(_,i)=>'g'+(i+1));
    const classList=`<div class="rb-nss-layout"><aside class="rb-nss-classes">${classes.map(cls=>{const id=String(cls.id); const active=selectedClasses.has(id); const primary=id===String(classId); return `<button type="button" class="${active?'active':''} ${primary?'primary':''}" data-nss-class-select="${esc(id)}">${esc(cls.name || cls.id)}</button>`;}).join('')}</aside>`;
    const table=`<div class="table-wrap rb-nss-table"><table><thead><tr><th>Môn học</th>${groupIds.map((gid,i)=>`<th>${esc('Nhóm '+(i+1))}</th>`).join('')}</tr></thead><tbody>${subjects.map(subject=>`<tr><td><b>${esc(subject.name || subject.id)}</b></td>${groupIds.map(gid=>`<td class="rb-check"><input type="checkbox" data-nss-rule="${esc(rule)}" data-nss-class="${esc(classId)}" data-nss-subject="${esc(subject.id)}" data-nss-group="${esc(gid)}" ${noSameGroupItems(rule,classId,gid).some(it=>subjectMatches(it,subject.id))?'checked':''}></td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
    return classList + table;
  }
  function subjectTable(rule,isGroup){
    if(rule==='fixedOff') return renderFixedOff(isGroup?'subjectGroup':'subject');
    if(!isGroup && (rule==='noSameSession'||rule==='noSameDay')) return renderSubjectNoSameRuleTable(rule);
    const rows=classFilterRows();
    const container=getRuleContainer(isGroup);
    if(!rows.length) return tableEmpty('Chưa có lớp.');
    const rowRule=cls=>container.byClass?.[cls.id]||{};
    const periodHead='<th>Số tiết</th>';
    const classPeriodCells=cls=>`<td><b>${esc(cls.name)}</b></td>${subjectPeriodsCell(cls,isGroup)}`;

    if(rule==='sessionAllowed'){
      return `<div class="table-wrap"><table><thead><tr><th>Lớp</th>${periodHead}<th>${tableCheckAllHeader('Học buổi sáng','morning')}</th><th>${tableCheckAllHeader('Học buổi chiều','afternoon')}</th><th>${tableCheckAllHeader('Chỉ học một buổi (sáng hoặc chiều)/1 ngày','oneSession')}</th></tr></thead><tbody>${rows.map(cls=>{const r=rowRule(cls);return `<tr>${classPeriodCells(cls)}<td>${checkC('',cls.id,'sessionAllowed.allowMorning',getPath(r,'sessionAllowed.allowMorning',true))}</td><td>${checkC('',cls.id,'sessionAllowed.allowAfternoon',getPath(r,'sessionAllowed.allowAfternoon',true))}</td><td>${checkC('',cls.id,'sessionAllowed.oneSessionPerDay',getPath(r,'sessionAllowed.oneSessionPerDay',false))}</td></tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='weeklySessionPeriods'){
      return `<div class="table-wrap"><table><thead><tr><th>Lớp</th>${periodHead}<th>Giới hạn tiết sáng/tuần</th><th>Giới hạn tiết chiều/tuần</th></tr></thead><tbody>${rows.map(cls=>{const r=rowRule(cls);return `<tr>${classPeriodCells(cls)}<td>${inputC('',cls.id,'weeklySessionPeriods.morning',getPath(r,'weeklySessionPeriods.morning',''))}</td><td>${inputC('',cls.id,'weeklySessionPeriods.afternoon',getPath(r,'weeklySessionPeriods.afternoon',''))}</td></tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='maxPeriods') return simpleClassNumberTable(rows,rowRule,[['maxPeriods.sang','Buổi sáng'],['maxPeriods.chieu','Buổi chiều']],isGroup);
    if(rule==='maxPeriodsDay'){
      const cols=days().map(d=>['maxPeriods.day.'+d,dayLabel(d),d]);
      return `<div class="table-wrap"><table><thead><tr><th>Lớp</th><th>Số tiết</th>${cols.map(c=>`<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows.map(cls=>{const r=rowRule(cls);return `<tr><td><b>${esc(cls.name)}</b></td>${subjectPeriodsCell(cls,!!isGroup)}${cols.map(c=>`<td>${inputC('',cls.id,c[0],dayLimitInputValue(r,'maxPeriods.day',c[2]))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='maxSessions') return simpleClassNumberTable(rows,rowRule,[['maxSessions.morning','Buổi sáng'],['maxSessions.afternoon','Buổi chiều'],['maxSessions.day','Cả ngày']],isGroup);
    if(rule==='maxSubjects') return simpleClassNumberTable(rows,rowRule,[['maxSubjects.sang','Buổi sáng'],['maxSubjects.chieu','Buổi chiều'],['maxSubjects.day','Cả ngày']],isGroup);
    if(rule==='spacingDays') return simpleClassNumberTable(rows,rowRule,[['spacingDays.days','Học cách ngày']],isGroup);
    if(rule==='avoidBreakPair23'||rule==='avoidBreakPair34'){
      return `<div class="table-wrap rb-avoid-wrap"><table class="rb-avoid-table"><colgroup><col class="rb-avoid-tt-col"><col class="rb-avoid-class-col"><col class="rb-avoid-period-col"><col class="rb-avoid-check-col"><col class="rb-avoid-check-col"></colgroup><thead><tr><th>TT</th><th>Lớp học</th>${periodHead}<th>${tableCheckAllHeader('BUỔI SÁNG','morning')}</th><th>${tableCheckAllHeader('BUỔI CHIỀU','afternoon')}</th></tr></thead><tbody>${rows.map((cls,i)=>{const r=rowRule(cls);return `<tr><td class="rb-row-index">${i+1}</td><td class="rb-class-name"><b>${esc(cls.name)}</b></td>${subjectPeriodsCell(cls,isGroup)}<td class="rb-check">${checkC('',cls.id,rule+'.morning',getPath(r,rule+'.morning',getPath(r,'avoidBreakPairs.morning',false)))}</td><td class="rb-check">${checkC('',cls.id,rule+'.afternoon',getPath(r,rule+'.afternoon',getPath(r,'avoidBreakPairs.afternoon',false)))}</td></tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='linkedDays'){
      const cols=`<colgroup><col class="rb-linked-tt-col"><col class="rb-linked-class-col">${days().map(()=>'<col class="rb-linked-check-col">').join('')}${days().map(()=>'<col class="rb-linked-check-col">').join('')}</colgroup>`;
      const dayHead=buoi=>days().map(d=>`<th>${tableCheckAllHeader(String(dayLabel(d)).toUpperCase(),'path:linkedDays.'+buoi+'.'+d)}</th>`).join('');
      return `<div class="table-wrap rb-linked-days"><table>${cols}<thead><tr><th rowspan="2">TT</th><th rowspan="2">Lớp học</th><th class="rb-linked-session-head" colspan="${days().length}">BUỔI SÁNG</th><th class="rb-linked-session-head" colspan="${days().length}">BUỔI CHIỀU</th></tr><tr>${dayHead('sang')}${dayHead('chieu')}</tr></thead><tbody>${rows.map((cls,i)=>{const r=rowRule(cls);return `<tr><td>${i+1}</td><td><b>${esc(cls.name)}</b></td>${days().map(d=>`<td class="rb-check">${checkC('',cls.id,'linkedDays.sang.'+d,linkedDaysCellChecked(r,'sang',d))}</td>`).join('')}${days().map(d=>`<td class="rb-check">${checkC('',cls.id,'linkedDays.chieu.'+d,linkedDaysCellChecked(r,'chieu',d))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='lessonBlocks'){
      const fillRow=`<tr class="rb-lesson-block-fill-row"><td>Nhập nhanh</td><td>—</td>${[2,3,4,5].map(n=>`<td>${lessonBlockFillInput('lessonBlocks.'+n+'.min','Nhập nhanh Min cho '+n+' tiết xếp liền')}</td><td>${lessonBlockFillInput('lessonBlocks.'+n+'.max','Nhập nhanh Max cho '+n+' tiết xếp liền')}</td>`).join('')}</tr>`;
      return `<div class="table-wrap"><table><thead><tr><th rowspan="2">Lớp</th><th rowspan="2">Số tiết</th>${[2,3,4,5].map(n=>`<th colspan="2">${n} tiết xếp liền</th>`).join('')}</tr><tr>${[2,3,4,5].map(()=>`<th>Min</th><th>Max</th>`).join('')}</tr></thead><tbody>${fillRow}${rows.map(cls=>{const r=rowRule(cls);return `<tr>${classPeriodCells(cls)}${[2,3,4,5].map(n=>`<td>${inputC('',cls.id,'lessonBlocks.'+n+'.min',getPath(r,'lessonBlocks.'+n+'.min',''))}</td><td>${inputC('',cls.id,'lessonBlocks.'+n+'.max',getPath(r,'lessonBlocks.'+n+'.max',''))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
    }
    if(rule==='globalLimit'||rule==='groupLimit') return renderGlobalLimitTable(isGroup?'subjectGroup':'subject', rule);
    return '';
  }

  /* ===================== UI FIXED OFF / TIME LIMIT ===================== */
  

function getClassGroupIdFromClassName(name){ const m=String(name||'').match(/\d+/); return m ? ('khoi_'+m[0]) : ''; }
function classGradeValue(classId){
  const raw=String(classId||'').trim();
  const cls=(D().lop || []).find(l=>[l.id,l.ten,l.ten2,classCanon(l.id)].some(v=>norm(v)===norm(raw)));
  const text=String(cls?.khoi || cls?.grade || cls?.ten || cls?.ten2 || cls?.id || raw || '').trim();
  const m=text.match(/\d+/);
  return m ? m[0] : '';
}
function assignedGradesForSubject(subjectId){
  const grades=new Set();
  Object.keys(D().pccmMatrix || {}).forEach(key=>{
    const parts=String(key).split('|');
    const cls=String(parts.shift() || '').trim();
    const subject=String(parts.join('|') || '').trim();
    if(!cls || !subject || !subjectMatches(subject, subjectId)) return;
    const grade=classGradeValue(cls);
    if(grade) grades.add(grade);
  });
  return grades;
}
function subjectAssignedInGrades(subjectId, grades){
  if(!grades || !grades.size) return false;
  for(const key of Object.keys(D().pccmMatrix || {})){
    const parts=String(key).split('|');
    const cls=String(parts.shift() || '').trim();
    const subject=String(parts.join('|') || '').trim();
    if(!cls || !subject || !subjectMatches(subject, subjectId)) continue;
    if(grades.has(classGradeValue(cls))) return true;
  }
  return false;
}
function gradeListText(grades){
  return Array.from(grades || []).sort((a,b)=>Number(a)-Number(b)).map(x=>'Khối '+x).join(', ');
}
  function fixedLessonSlotLabel(row){
    return `${dayLabel(row.thu)} ${SESSION_LABEL[row.buoi] || row.buoi} tiết ${Number(row.ti)+1}`;
  }
  function clearFixedLessonCell(lopId, thu, buoi, ti){
    const arr=D().tkb?.[lopId]?.[thu]?.[buoi];
    const idx=Number(ti);
    if(!arr || !Number.isFinite(idx) || idx < 0 || idx >= arr.length) return false;
    const v=arr[idx];
    if(!isFixedSafe(v)) return false;
    const mon=cellMonSafe(v);
    arr[idx]=mon || '';
    return true;
  }
  function clearAllFixedLessons(){
    let changed=0;
    fixedLessonRows().forEach(row=>{
      if(clearFixedLessonCell(row.lopId,row.thu,row.buoi,row.ti)) changed++;
    });
    if(!changed) return false;
    touchSave({critical:true});
    rerenderSafe();
    render();
    return true;
  }
  function renderFixedLessons(){
    const rows=fixedLessonRows();
    if(!rows.length){
      return `<div class="rb-fixedlesson-screen"><h3>Tiết học cố định</h3><div class="rb-dashboard-empty">Chưa có tiết học cố định.</div></div>`;
    }
    const body=rows.map((r,i)=>`<tr>
      <td>${i+1}</td>
      <td>${esc(r.className || r.lopId)}</td>
      <td>${esc(fixedLessonSlotLabel(r))}</td>
      <td>${esc(r.mon)}</td>
      <td>${esc(teacherName(r.teacher)||r.teacher||'')}</td>
      <td>${esc(r.room||'')}</td>
    </tr>`).join('');
    return `<div class="rb-fixedlesson-screen"><div class="rb-fixedoff-titlebar"><h3>Tiết học cố định</h3><div class="rb-fixedoff-total">Tổng số tiết: ${rows.length}</div></div><div class="table-wrap rb-fixedlesson-table"><table><thead><tr><th>TT</th><th>Lớp</th><th>Vị trí</th><th>Môn học</th><th>Giáo viên</th><th>Phòng học</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
  }
  function fixedOffTitleItemName(type,id){
    if(type==='teacher'){
      const full=teacherName(id) || String(id || '');
      return teacherShortName(id, full) || full || String(id || '');
    }
    if(type==='subject'){
      return subjectSortCode(id) || subjectDisplayName(id) || itemName(type,id);
    }
    return itemName(type,id);
  }
  function fixedOffDisplayName(type,id){
    if(type==='class') return 'Lớp ' + itemName(type,id);
    if(type==='teacher') return 'Giáo viên ' + fixedOffTitleItemName(type,id);
    if(type==='subject') return 'Môn ' + fixedOffTitleItemName(type,id);
    if(type==='room') return 'Phòng ' + itemName(type,id);
    if(type==='subjectGroup') return 'Nhóm môn ' + (model().groups.subject?.[id]?.name || id);
    return itemName(type,id);
  }
  function fixedOffListForType(type){
    if(type==='subjectGroup') return Object.entries(model().groups.subject||{}).map(([id,g])=>({id,name:g.name||id}));
    return listByType(type);
  }
  function fixedOffMultiSelectEnabled(type){
    return ['class','teacher','subject'].includes(String(type || ''));
  }
  function ensureFixedSelected(type,list){
    state.fixedSelected = state.fixedSelected || { class:'', teacher:'', subject:'', room:'', subjectGroup:'' };
    let id = state.fixedSelected[type] || '';
    if(!list.some(x=>String(x.id)===String(id))) id = list[0]?.id || '';
    state.fixedSelected[type] = id;
    if(fixedOffMultiSelectEnabled(type)) ensureFixedSelection(type, list, id);
    return id;
  }
  function ensureFixedSelection(type, list, primary){
    const key=String(type || 'class');
    const valid=new Set((list || []).map(it=>String(it.id)));
    const current=String(primary || state.fixedSelected?.[key] || list?.[0]?.id || '');
    state.fixedSelected=state.fixedSelected || {};
    state.fixedSelectedIds=state.fixedSelectedIds || {};
    state.fixedSelectionAnchor=state.fixedSelectionAnchor || {};
    let ids=Array.isArray(state.fixedSelectedIds[key])
      ? state.fixedSelectedIds[key].map(String).filter(id=>valid.has(id))
      : [];
    if(current && valid.has(current) && !ids.includes(current)) ids=[current];
    if(!ids.length && current && valid.has(current)) ids=[current];
    if(!ids.length && list?.[0]?.id != null) ids=[String(list[0].id)];
    const nextPrimary=(current && valid.has(current)) ? current : (ids[0] || '');
    state.fixedSelected[key]=nextPrimary;
    state.fixedSelectedIds[key]=ids;
    if(!state.fixedSelectionAnchor[key] || !valid.has(String(state.fixedSelectionAnchor[key]))){
      state.fixedSelectionAnchor[key]=nextPrimary;
    }
    return ids;
  }
  function ensureFixedClassSelection(list, primary){
    return ensureFixedSelection('class', list, primary);
  }
  function fixedOffSelectedIds(type, list){
    const key=String(type || '');
    return ensureFixedSelection(key, list || fixedOffListForType(key), state.fixedSelected?.[key]);
  }
  function fixedOffSelectedClassIds(list){
    return fixedOffSelectedIds('class', list || fixedOffListForType('class'));
  }
  function setFixedOffSingleItem(type,id){
    const key=String(type || 'class');
    const value=String(id || '');
    state.fixedSelected=state.fixedSelected || {};
    state.fixedSelectedIds=state.fixedSelectedIds || {};
    state.fixedSelectionAnchor=state.fixedSelectionAnchor || {};
    state.fixedSelected[key]=value;
    state.fixedSelectedIds[key]=value ? [value] : [];
    state.fixedSelectionAnchor[key]=value;
  }
  function setFixedOffSingleClass(id){
    setFixedOffSingleItem('class', id);
  }
  function toggleFixedOffItem(type, id, list){
    const key=String(type || 'class');
    const value=String(id || '');
    if(!value) return;
    const valid=new Set((list || []).map(it=>String(it.id)));
    let ids=fixedOffSelectedIds(key, list).filter(x=>valid.has(x));
    if(ids.includes(value)){
      ids=ids.filter(x=>x!==value);
      if(!ids.length) ids=[value];
    }else{
      ids.push(value);
    }
    state.fixedSelected=state.fixedSelected || {};
    state.fixedSelectedIds=state.fixedSelectedIds || {};
    state.fixedSelectionAnchor=state.fixedSelectionAnchor || {};
    state.fixedSelected[key]=value;
    state.fixedSelectedIds[key]=arrUnique(ids);
    state.fixedSelectionAnchor[key]=value;
  }
  function toggleFixedOffClass(id, list){
    toggleFixedOffItem('class', id, list);
  }
  function selectFixedOffRangeForType(type, id, list, additive){
    const key=String(type || 'class');
    const value=String(id || '');
    if(!value) return;
    const rows=list || [];
    const ids=rows.map(it=>String(it.id));
    const anchor=String(state.fixedSelectionAnchor?.[key] || state.fixedSelected?.[key] || value);
    const a=ids.indexOf(anchor);
    const b=ids.indexOf(value);
    const range=(a >= 0 && b >= 0)
      ? ids.slice(Math.min(a,b), Math.max(a,b)+1)
      : [value];
    const base=additive ? fixedOffSelectedIds(key, rows) : [];
    state.fixedSelected=state.fixedSelected || {};
    state.fixedSelectedIds=state.fixedSelectedIds || {};
    state.fixedSelectionAnchor=state.fixedSelectionAnchor || {};
    state.fixedSelected[key]=value;
    state.fixedSelectedIds[key]=arrUnique([...base, ...range]);
  }
  function selectFixedOffClassRange(id, list, additive){
    selectFixedOffRangeForType('class', id, list, additive);
  }
  function fixedOffApplyIds(type,id){
    if(!fixedOffMultiSelectEnabled(type)) return [String(id || '')].filter(Boolean);
    const list=fixedOffListForType(type);
    const ids=fixedOffSelectedIds(type, list);
    return ids.length ? ids : [String(id || '')].filter(Boolean);
  }
  function subjectOptionsForClass(lopId){
    const lop=findClassObject(lopId);
    const aliases=classAliasSet(lopId, lop);
    const map=new Map();
    const addSubject=(rawMon)=>{
      const mon=String(rawMon || '').trim();
      if(!mon) return;
      const sk=subjectKey(mon);
      if(sk && !map.has(sk)) map.set(sk,{id:mon,name:subjectDisplayName(mon),key:sk});
    };
    Object.entries(D().pccmMatrix || {}).forEach(([key,value])=>{
      if(!String(value || '').trim()) return;
      const parts=splitPccmKey(key);
      if(!parts.cls || !parts.mon || !classAliasSetHas(aliases, parts.cls)) return;
      addSubject(parts.mon);
    });
    if(!map.size){
      assignmentRowsForClass(lopId).forEach(row=>{
        if(Number(row?.count || 0) > 0 || String(row?.teacher || '').trim()) addSubject(row?.mon || row?.rawMon);
      });
    }
    return Array.from(map.values()).sort(subjectItemCompare);
  }
  function subjectOptionsForClasses(classIds){
    const ids=arrUnique((classIds || []).map(String).filter(Boolean));
    if(!ids.length) return [];
    const counts=new Map();
    const first=new Map();
    ids.forEach(lopId=>{
      const list=subjectOptionsForClass(lopId);
      const seen=new Set();
      list.forEach(item=>{
        const key=String(item.key || subjectKey(item.id));
        if(!key || seen.has(key)) return;
        seen.add(key);
        counts.set(key,(counts.get(key)||0)+1);
        if(!first.has(key)){
          first.set(key,Object.assign({},item,{classCount:0,totalClassCount:ids.length}));
        }
        const stored=first.get(key);
        stored.classCount=counts.get(key) || 0;
        stored.totalClassCount=ids.length;
      });
    });
    const all=Array.from(first.entries()).map(([,item])=>item);
    const common=all.filter(item=>Number(item.classCount || 0)===ids.length);
    const list=common.length ? common : all;
    return list.sort((a,b)=>{
      const ac=Number(a?.classCount || 0), bc=Number(b?.classCount || 0);
      if(ac !== bc) return bc - ac;
      return subjectItemCompare(a,b);
    });
  }
  function classHasSubjectOption(lopId, mon){
    const subject=String(mon || '').trim();
    if(!lopId || !subject) return false;
    return subjectOptionsForClass(lopId).some(item=>
      subjectMatches(item?.id, subject) ||
      subjectMatches(item?.key, subject) ||
      subjectMatches(item?.name, subject)
    );
  }
  function getTkbCellRaw(lopId, thu, buoi, ti){ return D().tkb?.[lopId]?.[thu]?.[buoi]?.[ti]; }
  function ensureTkbSession(lopId, thu, buoi){
    const d=D(); d.tkb=d.tkb||{}; d.tkb[lopId]=d.tkb[lopId]||{}; d.tkb[lopId][thu]=d.tkb[lopId][thu]||{};
    let arr=d.tkb[lopId][thu][buoi];
    if(!Array.isArray(arr)) arr=d.tkb[lopId][thu][buoi]=[];
    const len=sessionLen(buoi);
    while(arr.length<len) arr.push('');
    return arr;
  }
  function setFixedOffFlag(type,id,thu,buoi,ti,checked){
    const c=model(); c.fixedOff[type]=c.fixedOff[type]||{}; c.fixedOff[type][id]=c.fixedOff[type][id]||{};
    const sk=slotKey(thu,buoi,ti);
    if(checked) c.fixedOff[type][id][sk]=true; else delete c.fixedOff[type][id][sk];
    delEmpty(c.fixedOff[type][id]); if(Object.keys(c.fixedOff[type][id]||{}).length===0) delete c.fixedOff[type][id];
  }
  function fixedOffAllChecked(type,id){
    const keys=allSlotKeysForGrid();
    return keys.length > 0 && keys.every(key=>{
      const p=parseSlotKey(key);
      return fixedOffSlotChecked(type,id,p.thu,p.buoi,p.ti);
    });
  }
  function setFixedOffKeysFlag(type,id,keys,checked){
    (keys || []).forEach(key=>{
      const p=parseSlotKey(key);
      setFixedOffFlag(type,id,p.thu,p.buoi,p.ti,checked);
      if(type==='class') syncClassFixedOffCell(id,p.thu,p.buoi,p.ti,checked);
    });
    if(type==='class') syncClassFixedOffUserOffFromModel(id);
  }
  function fixedOffSelectedSlots(){
    const valid=new Set(allSlotKeysForGrid().map(String));
    state.fixedOffSlots=arrUnique(state.fixedOffSlots || []).filter(k=>valid.has(String(k)));
    return state.fixedOffSlots;
  }
  function setFixedOffSingleSlot(slot){
    const key=String(slot || '');
    state.fixedOffSlots=key ? [key] : [];
    state.fixedOffAnchorSlot=key;
  }
  function toggleFixedOffSlot(slot){
    const key=String(slot || '');
    const list=fixedOffSelectedSlots().map(String);
    state.fixedOffSlots=list.includes(key) ? list.filter(x=>x!==key) : [...list,key];
    if(!state.fixedOffAnchorSlot) state.fixedOffAnchorSlot=key;
  }
  function fixedOffGridRows(){
    const rows=[];
    for(let i=0;i<sessionLen('sang');i++) rows.push({buoi:'sang',ti:i});
    for(let i=0;i<sessionLen('chieu');i++) rows.push({buoi:'chieu',ti:i});
    return rows;
  }
  function fixedOffSlotRect(anchorKey,targetKey){
    const dayList=days();
    const rowList=fixedOffGridRows();
    const pos=(key)=>{
      const p=parseSlotKey(key);
      const col=dayList.indexOf(p.thu);
      const row=rowList.findIndex(r=>String(r.buoi)===String(p.buoi) && Number(r.ti)===Number(p.ti));
      return {row,col};
    };
    const a=pos(anchorKey);
    const b=pos(targetKey);
    if(a.row<0 || a.col<0 || b.row<0 || b.col<0) return [String(targetKey || '')].filter(Boolean);
    const out=[];
    for(let row=Math.min(a.row,b.row); row<=Math.max(a.row,b.row); row++){
      for(let col=Math.min(a.col,b.col); col<=Math.max(a.col,b.col); col++){
        out.push(slotKey(dayList[col], rowList[row].buoi, rowList[row].ti));
      }
    }
    return out;
  }
  function selectFixedOffRange(slot, additive){
    const key=String(slot || '');
    const anchor=String(state.fixedOffAnchorSlot || fixedOffSelectedSlots()[0] || key);
    if(!state.fixedOffAnchorSlot) state.fixedOffAnchorSlot=anchor;
    const range=fixedOffSlotRect(anchor,key);
    state.fixedOffSlots=additive ? arrUnique([...fixedOffSelectedSlots(), ...range]) : arrUnique(range);
  }
  function selectFixedOffPreset(keys, additive){
    const list=arrUnique((keys || []).map(String));
    state.fixedOffSlots=additive ? arrUnique([...fixedOffSelectedSlots(), ...list]) : list;
    state.fixedOffAnchorSlot=list[0] || '';
  }
  function clearFixedOffSlotSelection(){
    state.fixedOffSlots=[];
    state.fixedOffAnchorSlot='';
  }
  function refreshFixedOffSelection(root){
    const selected=new Set(fixedOffSelectedSlots().map(String));
    (root || document).querySelectorAll('[data-fo-toggle][data-slot]').forEach(el=>{
      el.classList.toggle('selected', selected.has(String(el.dataset.slot || '')));
    });
    (root || document).querySelectorAll('[data-fo-selected-count]').forEach(el=>{
      el.textContent=`Đã chọn: ${selected.size} ô`;
    });
  }
  function applyFixedOffSelectedSlots(type,id,checked){
    const keys=fixedOffSelectedSlots();
    if(!keys.length) return false;
    fixedOffApplyIds(type,id).forEach(targetId=>setFixedOffKeysFlag(type,targetId,keys,!!checked));
    touchSave({critical:type==='class'});
    if(checked) releaseExistingViolationsAfterSave();
    if(type==='class') scheduleRerenderSafe();
    render();
    return true;
  }
  function clearFixedOffSelectedSlots(type,id){
    const keys=fixedOffSelectedSlots();
    if(!keys.length) return false;
    const targets=fixedOffApplyIds(type,id);
    let lessonChanged=0;
    targets.forEach(targetId=>{
      setFixedOffKeysFlag(type,targetId,keys,false);
      if(type==='class'){
        keys.forEach(key=>{
          const p=parseSlotKey(key);
          if(clearClassFixedLessonAt(targetId,p.thu,p.buoi,p.ti)) lessonChanged++;
        });
      }
    });
    touchSave({critical:lessonChanged>0});
    if(type==='class'){
      scheduleRerenderSafe();
      render();
    }else{
      const root=document.getElementById(PANEL_ID);
      refreshFixedOffGridCells(root || document,type,id,keys);
      refreshFixedOffGridMasters(root || document,type,id);
    }
    return true;
  }
  function setFixedOffAllFlag(type,id,checked){
    setFixedOffKeysFlag(type,id,allSlotKeysForGrid(),checked);
  }
  function refreshFixedOffGridCells(root,type,id,keys){
    const keySet=new Set((keys || allSlotKeysForGrid()).map(String));
    const selectedSlots=new Set(fixedOffSelectedSlots().map(String));
    (root || document).querySelectorAll('[data-fo-toggle][data-off-type][data-off-id][data-slot]').forEach(el=>{
      if(String(el.dataset.offType||'')!==String(type) || String(el.dataset.offId||'')!==String(id)) return;
      const sk=String(el.dataset.slot||'');
      if(!keySet.has(sk)) return;
      const p=parseSlotKey(sk);
      el.classList.toggle('off', fixedOffSlotChecked(type,id,p.thu,p.buoi,p.ti));
      el.classList.toggle('selected', selectedSlots.has(sk));
    });
    refreshFixedOffSelection(root);
  }
  function refreshFixedOffGridMasters(root,type,id){
    (root || document).querySelectorAll('[data-rb-grid-all="fixedOff"][data-off-type][data-off-id]').forEach(master=>{
      if(String(master.dataset.offType||'')!==String(type) || String(master.dataset.offId||'')!==String(id)) return;
      const keys=allSlotKeysForGrid();
      const selected=keys.filter(key=>{ const p=parseSlotKey(key); return fixedOffSlotChecked(type,id,p.thu,p.buoi,p.ti); }).length;
      master.checked=keys.length > 0 && selected === keys.length;
      master.indeterminate=selected > 0 && selected < keys.length;
    });
    (root || document).querySelectorAll('[data-rb-grid-session="fixedOff"][data-off-type][data-off-id][data-buoi]').forEach(master=>{
      if(String(master.dataset.offType||'')!==String(type) || String(master.dataset.offId||'')!==String(id)) return;
      const keys=slotKeysForGrid(master.dataset.buoi || '');
      const selected=keys.filter(key=>{ const p=parseSlotKey(key); return fixedOffSlotChecked(type,id,p.thu,p.buoi,p.ti); }).length;
      master.checked=keys.length > 0 && selected === keys.length;
      master.indeterminate=selected > 0 && selected < keys.length;
    });
  }
  function scheduleRerenderSafe(){
    setTimeout(()=>{ try{ rerenderSafe(); }catch(e){ console.warn('[tkb-constraints] deferred rerender failed', e); } },0);
  }
  function syncClassFixedOffCell(lopId, thu, buoi, ti, checked){
    const arr=ensureTkbSession(lopId,thu,buoi); const cur=arr[ti];
    if(checked){
      if(cur==null || cur==='' || cur==='OFF' || !isFixedSafe(cur)) arr[ti]='OFF';
    }else{
      if(cur==='OFF') arr[ti]='';
    }
  }
  function fixedLessonAt(lopId, thu, buoi, ti){
    const v=getTkbCellRaw(lopId,thu,buoi,ti);
    return isFixedSafe(v) ? cellMonSafe(v) : '';
  }
  function forEachClassTkbCell(lopId, fn){
    const tkb=D().tkb?.[lopId];
    if(!tkb || typeof fn!=='function') return;
    days().forEach(thu=>SESSION_KEYS.forEach(buoi=>{
      const arr=tkb?.[thu]?.[buoi];
      if(!Array.isArray(arr)) return;
      for(let i=0;i<arr.length;i++) fn({arr,thu,buoi,ti:i,value:arr[i],mon:cellMonSafe(arr[i]),fixed:isFixedSafe(arr[i])});
    }));
  }
  function classSubjectRequiredCount(lopId, mon){
    const subject=String(mon || '').trim();
    if(!lopId || !subject) return 0;
    try{
      const direct=matrixNumberForClassSubject(D().pccmTietMatrix || {}, lopId, subject, findClassObject(lopId));
      if(direct != null) return Math.max(0, Number(direct || 0));
    }catch(_){ }
    const lop=findClassObject(lopId);
    const classKeys=arrUnique(classKeyCandidates(lopId, lop).map(x=>String(x || '').trim()).filter(Boolean));
    const subjectKeys=arrUnique([subject, subjectKey(subject)].map(x=>String(x || '').trim()).filter(Boolean));
    try{
      if(typeof getSoTietForClassMon === 'function'){
        for(const cls of classKeys){
          for(const sub of subjectKeys){
            const n=Number(getSoTietForClassMon(cls, sub) || 0);
            if(Number.isFinite(n) && n>0) return Math.max(0,n);
          }
        }
      }
    }catch(_){ }
    try{
      if(typeof window.getSoTietForClassMon === 'function'){
        for(const cls of classKeys){
          for(const sub of subjectKeys){
            const n=Number(window.getSoTietForClassMon(cls, sub) || 0);
            if(Number.isFinite(n) && n>0) return Math.max(0,n);
          }
        }
      }
    }catch(_){ }
    const aliases=classAliasSet(lopId, lop);
    let best=0;
    Object.entries(D().pccmTietMatrix || {}).forEach(([key,value])=>{
      const parts=splitPccmKey(key);
      if(!parts.cls || !parts.mon || !classAliasSetHas(aliases, parts.cls) || !subjectMatches(parts.mon, subject)) return;
      const n=Number(value);
      if(Number.isFinite(n) && n>best) best=n;
    });
    return Math.max(0,best);
  }
  function countClassSubjectPlaced(lopId, mon){
    let count=0;
    forEachClassTkbCell(lopId, cell=>{
      if(cell.mon && subjectMatches(cell.mon, mon)) count++;
    });
    return count;
  }
  function findClassSubjectPlacedSlot(lopId, mon, except){
    const candidates=[];
    forEachClassTkbCell(lopId, cell=>{
      if(!cell.mon || !subjectMatches(cell.mon, mon)) return;
      if(except && String(cell.thu)===String(except.thu) && String(cell.buoi)===String(except.buoi) && Number(cell.ti)===Number(except.ti)) return;
      candidates.push(cell);
    });
    candidates.sort((a,b)=>Number(!!a.fixed)-Number(!!b.fixed));
    return candidates[0] || null;
  }
  function setClassFixedLesson(lopId, thu, buoi, ti, mon){
    const subject=String(mon || '').trim();
    if(!lopId || !thu || !buoi || !Number.isFinite(Number(ti)) || !subject) return false;
    const idx=Number(ti);
    const arr=ensureTkbSession(lopId,thu,buoi);
    const currentMon=cellMonSafe(arr[idx]);
    const fixedSubject=currentMon && subjectMatches(currentMon, subject) ? currentMon : subject;
    if(!currentMon || !subjectMatches(currentMon, subject)){
      const required=classSubjectRequiredCount(lopId, subject);
      const placed=countClassSubjectPlaced(lopId, subject);
      const source=findClassSubjectPlacedSlot(lopId, subject, {thu,buoi,ti:idx});
      if(source && (!required || placed >= required)) source.arr[source.ti]='';
    }
    arr[idx]={mon:fixedSubject,fixed:true};
    setFixedOffFlag('class',lopId,thu,buoi,idx,false);
    syncClassFixedOffUserOffFromModel(lopId);
    return true;
  }
  function clearClassFixedLessonAt(lopId, thu, buoi, ti){
    const arr=D().tkb?.[lopId]?.[thu]?.[buoi];
    const idx=Number(ti);
    if(!arr || !Number.isFinite(idx) || idx<0 || idx>=arr.length || !isFixedSafe(arr[idx])) return false;
    arr[idx]=cellMonSafe(arr[idx]) || '';
    return true;
  }
  function applyClassFixedLessonToSelection(type,id,slot,mon){
    if(type!=='class') return false;
    const p=parseSlotKey(slot);
    const targets=fixedOffApplyIds('class',id).filter(lopId=>classHasSubjectOption(lopId, mon));
    let changed=0;
    targets.forEach(lopId=>{ if(setClassFixedLesson(lopId,p.thu,p.buoi,p.ti,mon)) changed++; });
    if(!changed){
      notifySaved('Môn này chưa có trong phân công của các lớp đang chọn.');
      return false;
    }
    touchSave({critical:true});
    scheduleRerenderSafe();
    render();
    return true;
  }
  function clearClassFixedLessonForSelection(type,id,slot){
    if(type!=='class') return false;
    const p=parseSlotKey(slot);
    const targets=fixedOffApplyIds('class',id);
    let changed=0;
    targets.forEach(lopId=>{ if(clearClassFixedLessonAt(lopId,p.thu,p.buoi,p.ti)) changed++; });
    if(!changed) return false;
    touchSave({critical:true});
    scheduleRerenderSafe();
    render();
    return true;
  }
  function openClassFixedLessonSubjectMenu(el,type,id,slot){
    if(type!=='class') return false;
    const targets=fixedOffApplyIds('class',id);
    const subjects=subjectOptionsForClasses(targets);
    if(!subjects.length){
      notifySaved('Các lớp đang chọn chưa có môn phân công để cố định tại ô này.');
      return true;
    }
    const p=parseSlotKey(slot);
    const hasFixed=targets.some(lopId=>!!fixedLessonAt(lopId,p.thu,p.buoi,p.ti));
    const items=subjects.map(subject=>({
      label: (()=>{ const base=subject.name || subjectDisplayName(subject.id) || subject.id; const count=Number(subject.classCount || 0); const total=Number(subject.totalClassCount || targets.length || 0); return total > 1 && count > 0 && count < total ? `${base} (${count}/${total} lớp)` : base; })(),
      action:()=>applyClassFixedLessonToSelection(type,id,slot,subject.id)
    }));
    if(hasFixed){
      items.push({sep:true});
      items.push({label:'Bỏ tiết cố định', action:()=>clearClassFixedLessonForSelection(type,id,slot)});
    }
    closeRbMenus();
    const rect=el.getBoundingClientRect();
    const pop=buildMenuPopup(items, rect.left, rect.bottom+2, 0);
    document.body.appendChild(pop);
    const closer=ev=>{
      if(!ev.target.closest('.rb-menu-pop') && ev.target!==el){
        closeRbMenus();
        document.removeEventListener('mousedown', closer, true);
      }
    };
    document.addEventListener('mousedown', closer, true);
    return true;
  }
  function openFixedLessonMenuFromCell(el, ev, opts){
    if(!el) return false;
    if(ev){
      ev.preventDefault();
      ev.stopPropagation();
    }
    if(!opts || opts.source !== 'dblclick') return false;
    const slot=el.dataset.slot || '';
    setFixedOffSingleSlot(slot);
    const root=document.getElementById(PANEL_ID);
    refreshFixedOffSelection(root || document);
    return openClassFixedLessonSubjectMenu(el, el.dataset.offType || '', el.dataset.offId || '', slot);
  }
  function excelHeaderKey(v){
    return String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
  }
  function fixedOffDayNumber(thu){
    const m=String(thu||'').match(/\d+/);
    return m ? Number(m[0]) : thu;
  }
  function teacherFixedOffExcelColumns(){
    const cols=[];
    days().forEach(thu=>SESSION_KEYS.forEach(buoi=>{
      const short = buoi === 'sang' ? 'S' : 'C';
      const len = sessionLen(buoi);
      for(let ti=0; ti<len; ti++){
        const header = `T${fixedOffDayNumber(thu)}_${short}${ti+1}`;
        cols.push({header, key:slotKey(thu,buoi,ti), thu, buoi, ti});
      }
    }));
    return cols;
  }
  function classFixedOffExcelColumns(){ return teacherFixedOffExcelColumns(); }
  function subjectFixedOffExcelColumns(){ return teacherFixedOffExcelColumns(); }
  function teacherFixedOffExcelRows(){
    const cols=teacherFixedOffExcelColumns();
    const teachers=getTeacherList();
    const fixed=model().fixedOff?.teacher || {};
    const rows=[['MaGV','TenGV','SoTietCoDinh',...cols.map(c=>c.header)]];
    teachers.forEach(t=>{
      const slots=fixed[t.id] || {};
      const count=cols.reduce((sum,c)=>sum+(slots[c.key]?1:0),0);
      rows.push([t.id,t.name,count,...cols.map(c=>slots[c.key]?'1':'')]);
    });
    return rows;
  }
  function classFixedOffExcelRows(){
    const cols=classFixedOffExcelColumns();
    const classes=getClassList();
    const fixed=classFixedOffSlotsSnapshot();
    const rows=[['MaLop','TenLop','SoTietCoDinh',...cols.map(c=>c.header)]];
    classes.forEach(cls=>{
      const slots=fixed[cls.id] || {};
      const flags=cols.map(c=>!!slots[c.key]);
      const count=flags.reduce((sum,v)=>sum+(v?1:0),0);
      rows.push([cls.id,cls.name,count,...flags.map(v=>v?'1':'')]);
    });
    return rows;
  }
  function subjectFixedOffExcelRows(){
    const cols=subjectFixedOffExcelColumns();
    const subjects=getSubjectList();
    const fixed=model().fixedOff?.subject || {};
    const rows=[['MaMon','TenMon','SoTietCoDinh',...cols.map(c=>c.header)]];
    subjects.forEach(subject=>{
      const id=String(subject.id || subject.name || '').trim();
      const subjectId=subjectKey(id);
      const slots=fixed[subjectId] || {};
      const count=cols.reduce((sum,c)=>sum+(slots[c.key]?1:0),0);
      rows.push([id,subject.name || subjectDisplayName(id),count,...cols.map(c=>slots[c.key]?'1':'')]);
    });
    return rows;
  }
  function teacherFixedOffHelpRows(){
    return [
      ['Hướng dẫn nhập cố định tiết giáo viên'],
      ['Mỗi dòng là một giáo viên. Giữ nguyên cột MaGV để nhập chính xác.'],
      ['Các cột slot có dạng T2_S1 = Thứ 2 sáng tiết 1, T2_C1 = Thứ 2 chiều tiết 1.'],
      ['Nhập 1, x, X, OFF, true vào ô slot để đánh dấu cố định; để trống để mở tiết đó.'],
      ['Khi nhập, phần mềm thay thế ô cố định của các giáo viên có trong file; giáo viên không có trong file được giữ nguyên.']
    ];
  }
  function classFixedOffHelpRows(){
    return [
      ['Hướng dẫn nhập cố định tiết lớp học'],
      ['Mỗi dòng là một lớp. Giữ nguyên cột MaLop để nhập chính xác.'],
      ['Các cột slot có dạng T2_S1 = Thứ 2 sáng tiết 1, T2_C1 = Thứ 2 chiều tiết 1.'],
      ['Nhập 1, x, X, OFF, true vào ô slot để đánh dấu cố định; để trống để mở tiết đó.'],
      ['Khi nhập, phần mềm thay thế ô cố định của các lớp có trong file; lớp không có trong file được giữ nguyên.'],
      ['Với lớp, nhập sẽ cập nhật trực tiếp các ô OFF trên thời khóa biểu để bộ xếp lịch nhận đúng ràng buộc.']
    ];
  }
  function subjectFixedOffHelpRows(){
    return [
      ['Hướng dẫn nhập cố định tiết môn học'],
      ['Mỗi dòng là một môn học. Giữ nguyên cột MaMon để nhập chính xác.'],
      ['Các cột slot có dạng T2_S1 = Thứ 2 sáng tiết 1, T2_C1 = Thứ 2 chiều tiết 1.'],
      ['Nhập 1, x, X, OFF, true vào ô slot để đánh dấu cố định; để trống để mở tiết đó.'],
      ['Khi nhập, phần mềm thay thế ô cố định của các môn có trong file; môn không có trong file được giữ nguyên.']
    ];
  }
  function excelRangeForRows(rows){
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    const colCount = Math.max(1, ...(rows || []).map(row=>Array.isArray(row) ? row.length : 0));
    return XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,rowCount-1),c:Math.max(0,colCount-1)}});
  }
  function excelCell(ws, r, c){
    const addr = XLSX.utils.encode_cell({r,c});
    ws[addr] = ws[addr] || {t:'s', v:''};
    return ws[addr];
  }
  function excelDecorateSheet(ws, rows, widths, opts){
    const colCount = Math.max(1, ...(rows || []).map(row=>Array.isArray(row) ? row.length : 0), (widths || []).length);
    ws['!cols']=Array.from({length:colCount},(_,i)=>({wch:Number(widths?.[i] || (i < 3 ? 18 : 12)) || 12}));
    ws['!rows']=(rows || []).map((_,i)=>({hpt:i===0 ? 24 : 20}));
    const freeze = opts?.freeze === false ? null : (opts?.freeze || {xSplit:0,ySplit:1});
    if(freeze){
      ws['!freeze']=freeze;
      ws['!views']=[Object.assign({state:'frozen'}, freeze)];
    }
    if(opts?.filter !== false && rows.length > 1){
      const filterRow = Math.max(0, Number(opts?.filterRow || 0) || 0);
      const header = rows[filterRow] || rows[0] || [];
      if(header.length){
        ws['!autofilter']={ref:opts?.filterRef || XLSX.utils.encode_range({
          s:{r:filterRow,c:0},
          e:{r:Math.max(filterRow, rows.length-1),c:Math.max(0,header.length-1)}
        })};
      }
    }
    const titleRows = Array.isArray(opts?.titleRows) ? opts.titleRows : [];
    const headerRows = Array.isArray(opts?.headerRows) ? opts.headerRows : [0];
    if(window.TKBExcelStyle){
      try{
        const maxWidth = Math.max(42, ...(widths || []).map(w=>Number((w && typeof w === 'object') ? w.wch : w) || 0));
        window.TKBExcelStyle.styleSheet(ws, rows, {
          widths,
          titleRows,
          headerRows,
          freeze: freeze || undefined,
          filterRow: opts?.filter === false ? false : Math.max(0, Number(opts?.filterRow || 0) || 0),
          bodyRowHeight: 22,
          titleRowHeight: 30,
          maxWidth
        });
        return ws;
      }catch(e){
        console.warn('excelDecorateSheet style helper failed', e);
      }
    }
    const border = {top:{style:'thin',color:{rgb:'D7DFEA'}},bottom:{style:'thin',color:{rgb:'D7DFEA'}},left:{style:'thin',color:{rgb:'D7DFEA'}},right:{style:'thin',color:{rgb:'D7DFEA'}}};
    headerRows.forEach(r=>{
      const len = Array.isArray(rows?.[r]) ? rows[r].length : colCount;
      for(let c=0;c<len;c++){
        excelCell(ws,r,c).s={
          font:{bold:true,color:{rgb:'FFFFFF'}},
          fill:{fgColor:{rgb:'244C7A'}},
          alignment:{horizontal:'center',vertical:'center',wrapText:true},
          border
        };
      }
    });
    titleRows.forEach(r=>{
      const len = Array.isArray(rows?.[r]) ? Math.max(1, rows[r].length) : colCount;
      for(let c=0;c<len;c++){
        excelCell(ws,r,c).s={
          font:{bold:true,color:{rgb:'16324F'},sz:c===0?16:12},
          fill:{fgColor:{rgb:'EAF2FB'}},
          alignment:{vertical:'center',wrapText:true},
          border
        };
      }
      if(ws['!rows']?.[r]) ws['!rows'][r].hpt = 28;
    });
    return ws;
  }
  function excelTitledRows(title, subtitle, rows){
    const safeRows = Array.isArray(rows) ? rows : [];
    return [[title || ''], [subtitle || ''], ...safeRows];
  }
  function writeFixedOffWorkbook(sheetName, rows, cols, widths, helpRows, filePrefix){
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    const wb=XLSX.utils.book_new();
    const titleMap={CoDinhGV:fixedOffTitle('teacher'),CoDinhLop:fixedOffTitle('class'),CoDinhMon:fixedOffTitle('subject')};
    const displayRows=excelTitledRows(titleMap[sheetName] || sheetName, 'Nhập 1 hoặc x tại các cột T2_S1... để đánh dấu tiết nghỉ; để trống để mở ô đó.', rows);
    const ws=XLSX.utils.aoa_to_sheet(displayRows);
    excelDecorateSheet(ws, displayRows, [...widths, ...cols.map(()=>8)], {freeze:{xSplit:3,ySplit:3}, titleRows:[0], headerRows:[2], filterRow:2});
    XLSX.utils.book_append_sheet(wb,ws,sheetName);
    const help=XLSX.utils.aoa_to_sheet(helpRows);
    excelDecorateSheet(help, helpRows, [112], {filter:false, freeze:false, titleRows:[0], headerRows:[]});
    XLSX.utils.book_append_sheet(wb,help,'HuongDan');
    const d=new Date();
    const stamp=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    XLSX.writeFile(wb,`${filePrefix}_${stamp}.xlsx`,{compression:true, cellStyles:true});
  }
  function fixedOffMatrixItems(type){
    if(type==='teacher'){
      return getTeacherList().map(t=>({
        id:String(t.id || ''),
        fixedId:String(t.id || ''),
        label:teacherShortName(t.id, t.name) || t.name || t.id
      })).filter(x=>x.id);
    }
    if(type==='subject'){
      return getSubjectList().map(subject=>{
        const rawId=String(subject.id || subject.name || '').trim();
        const fixedId=subjectKey(rawId);
        return {
          id:rawId,
          fixedId,
          label:subjectSortCode(rawId) || subject.name || subjectDisplayName(rawId) || rawId
        };
      }).filter(x=>x.id && x.fixedId);
    }
    return getClassList().map(cls=>({
      id:String(cls.id || ''),
      fixedId:String(cls.id || ''),
      label:cls.name || cls.id
    })).filter(x=>x.id);
  }
  function fixedOffMatrixSlots(type){
    if(type==='class') return classFixedOffSlotsSnapshot();
    if(type==='teacher') return model().fixedOff?.teacher || {};
    if(type==='subject') return model().fixedOff?.subject || {};
    return {};
  }
  function fixedOffMatrixSheetName(type){
    return ({class:'CoDinhLop',teacher:'CoDinhGV',subject:'CoDinhMon'})[type] || 'CoDinh';
  }
  function fixedOffMatrixFilePrefix(type){
    return ({class:'co_dinh_tiet_lop',teacher:'co_dinh_tiet_giao_vien',subject:'co_dinh_tiet_mon'})[type] || 'co_dinh_tiet';
  }
  function fixedOffMatrixDataRows(type){
    if(type==='teacher') return teacherFixedOffExcelRows();
    if(type==='subject') return subjectFixedOffExcelRows();
    return classFixedOffExcelRows();
  }
  function fixedOffMatrixColumns(type){
    if(type==='teacher') return teacherFixedOffExcelColumns();
    if(type==='subject') return subjectFixedOffExcelColumns();
    return classFixedOffExcelColumns();
  }
  function fixedOffMatrixTitle(type){
    return ({class:'cố định tiết lớp học',teacher:'cố định tiết giáo viên',subject:'cố định tiết môn học'})[type] || 'cố định tiết';
  }
  function fixedOffMatrixColumnLabel(type){
    return ({class:'lớp',teacher:'giáo viên',subject:'môn học'})[type] || 'đối tượng';
  }
  function fixedOffMatrixData(type){
    const items=fixedOffMatrixItems(type);
    const fixed=fixedOffMatrixSlots(type);
    const rows=[['THỨ','BUỔI','TIẾT',...items.map(item=>item.label || item.id)]];
    const merges=[];
    let rowIndex=1;
    days().forEach(thu=>{
      const dayStart=rowIndex;
      SESSION_KEYS.forEach(buoi=>{
        const len=sessionLen(buoi);
        const sessionStart=rowIndex;
        for(let ti=0;ti<len;ti++){
          rows.push([
            rowIndex===dayStart ? String(dayLabel(thu) || thu).toUpperCase() : '',
            ti===0 ? (SESSION_LABEL[buoi] || buoi) : '',
            ti+1,
            ...items.map(item=>fixed?.[item.fixedId || item.id]?.[slotKey(thu,buoi,ti)] ? 'Nghỉ' : '')
          ]);
          rowIndex++;
        }
        if(len>1) merges.push({s:{r:sessionStart,c:1},e:{r:sessionStart+len-1,c:1}});
      });
      if(rowIndex-dayStart>1) merges.push({s:{r:dayStart,c:0},e:{r:rowIndex-1,c:0}});
    });
    return {rows,items,merges,type};
  }
  function decorateFixedOffMatrixSheet(ws, data){
    const rows=data?.rows || [];
    const items=data?.items || [];
    const colCount=Math.max(1,...rows.map(row=>Array.isArray(row)?row.length:0));
    const border={top:{style:'thin',color:{rgb:'7EA56E'}},bottom:{style:'thin',color:{rgb:'7EA56E'}},left:{style:'thin',color:{rgb:'7EA56E'}},right:{style:'thin',color:{rgb:'7EA56E'}}};
    ws['!ref']=excelRangeForRows(rows);
    ws['!cols']=[{wch:13},{wch:12},{wch:8},...items.map(()=>({wch:12}))];
    ws['!rows']=rows.map((_,i)=>({hpt:i===0?30:24}));
    ws['!merges']=data?.merges || [];
    ws['!freeze']={xSplit:3,ySplit:1};
    ws['!views']=[{state:'frozen',xSplit:3,ySplit:1}];
    for(let r=0;r<rows.length;r++){
      const row=rows[r] || [];
      for(let c=0;c<colCount;c++){
        const target=excelCell(ws,r,c);
        const value=c<row.length ? row[c] : '';
        const isHeader=r===0;
        const isLeft=c<3 && r>0;
        const isOff=norm(value)==='nghi';
        const style={
          font:{name:'Times New Roman',sz:isLeft&&c===0?13:12,bold:isHeader||isLeft||isOff,color:{rgb:isOff?'C00000':'1F2937'}},
          alignment:{horizontal:'center',vertical:'center',wrapText:true},
          border
        };
        if(isHeader || isLeft) style.fill={patternType:'solid',fgColor:{rgb:isHeader?'A9D18E':'C6EFCE'}};
        else if(isOff) style.fill={patternType:'solid',fgColor:{rgb:'FCE4D6'}};
        target.s=style;
      }
    }
    return ws;
  }
  function hideWorkbookSheet(wb, sheetName){
    const idx=(wb.SheetNames || []).indexOf(sheetName);
    if(idx<0) return;
    wb.Workbook=wb.Workbook || {};
    wb.Workbook.Sheets=wb.Workbook.Sheets || [];
    for(let i=0;i<(wb.SheetNames || []).length;i++){
      wb.Workbook.Sheets[i]=wb.Workbook.Sheets[i] || {};
      wb.Workbook.Sheets[i].name=wb.Workbook.Sheets[i].name || wb.SheetNames[i];
    }
    wb.Workbook.Sheets[idx].Hidden=1;
  }
  function writeFixedOffMatrixWorkbook(type){
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    const wb=XLSX.utils.book_new();
    const matrix=fixedOffMatrixData(type);
    const ws=XLSX.utils.aoa_to_sheet(matrix.rows);
    decorateFixedOffMatrixSheet(ws,matrix);
    const sheetName=fixedOffMatrixSheetName(type);
    XLSX.utils.book_append_sheet(wb,ws,sheetName);

    const cols=fixedOffMatrixColumns(type);
    const title=fixedOffMatrixTitle(type);
    const dataRows=excelTitledRows(`Dữ liệu import ${title}`, 'Sheet này giữ định dạng cũ để phần mềm nhập lại chính xác.', fixedOffMatrixDataRows(type));
    const dataWs=XLSX.utils.aoa_to_sheet(dataRows);
    excelDecorateSheet(dataWs,dataRows,[16,24,12,...cols.map(()=>8)],{freeze:{xSplit:3,ySplit:3},titleRows:[0],headerRows:[2],filterRow:2});
    XLSX.utils.book_append_sheet(wb,dataWs,'DuLieuImport');
    hideWorkbookSheet(wb,'DuLieuImport');

    const label=fixedOffMatrixColumnLabel(type);
    const helpRows=[
      [`Hướng dẫn nhập ${title}`],
      [`Sheet ${sheetName} hiển thị dạng ma trận: cột THU, BUOI, TIET và các cột ${label}.`],
      [`Nhập chữ Nghỉ, x, 1 hoặc OFF vào ô của ${label} để đánh dấu tiết nghỉ; để trống để mở tiết đó.`],
      ['Sheet DuLieuImport được ẩn để giữ tương thích với định dạng slot cũ T2_S1/T2_C1.']
    ];
    const help=XLSX.utils.aoa_to_sheet(helpRows);
    excelDecorateSheet(help, helpRows, [116], {filter:false, freeze:false, titleRows:[0], headerRows:[]});
    XLSX.utils.book_append_sheet(wb,help,'HuongDan');

    const d=new Date();
    const stamp=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    XLSX.writeFile(wb,`${fixedOffMatrixFilePrefix(type)}_${stamp}.xlsx`,{compression:true, cellStyles:true});
  }
  function exportTeacherFixedOffExcel(){
    writeFixedOffMatrixWorkbook('teacher');
  }
  function exportClassFixedOffExcel(){
    writeFixedOffMatrixWorkbook('class');
  }
  function exportSubjectFixedOffExcel(){
    writeFixedOffMatrixWorkbook('subject');
  }
  function resolveTeacherImportId(rawId, rawName){
    const id=String(rawId==null?'':rawId).trim();
    const name=String(rawName==null?'':rawName).trim();
    const list=getTeacherList();
    const alias=new Map();
    function add(k,v){ const key=excelHeaderKey(k); if(key && !alias.has(key)) alias.set(key,v); }
    list.forEach(t=>{
      add(t.id,t.id);
      add(t.name,t.id);
      add(teacherName(t.id),t.id);
      add(teacherShortName(t.id,t.name),t.id);
    });
    if(alias.has(excelHeaderKey(id))) return alias.get(excelHeaderKey(id));
    if(alias.has(excelHeaderKey(name))) return alias.get(excelHeaderKey(name));
    return '';
  }
  function classImportCanonical(value){
    const text=String(value==null?'':value).trim();
    const compact=text.replace(/\s+/g,'');
    let m=compact.match(/^(\d+)[aA](\d+)$/);
    if(m) return `${Number(m[1])}/${Number(m[2])}`;
    m=text.match(/^(\d+)\s*\/\s*(\d+)$/);
    if(m) return `${Number(m[1])}/${Number(m[2])}`;
    return text;
  }
  function classImportKey(value){ return excelHeaderKey(classImportCanonical(value)); }
  function resolveClassImportId(rawId, rawName){
    const id=String(rawId==null?'':rawId).trim();
    const name=String(rawName==null?'':rawName).trim();
    const list=getClassList();
    const alias=new Map();
    function add(k,v){ const key=classImportKey(k); if(key && !alias.has(key)) alias.set(key,v); }
    list.forEach((cls,idx)=>{
      add(cls.id,cls.id);
      add(cls.name,cls.id);
      add(`L${String(idx+1).padStart(3,'0')}`,cls.id);
    });
    if(alias.has(classImportKey(id))) return alias.get(classImportKey(id));
    if(alias.has(classImportKey(name))) return alias.get(classImportKey(name));
    return '';
  }
  function resolveSubjectImportId(rawId, rawName){
    const id=String(rawId==null?'':rawId).trim();
    const name=String(rawName==null?'':rawName).trim();
    const list=getSubjectList();
    const alias=new Map();
    function add(k,v){
      const key=excelHeaderKey(k);
      if(key && !alias.has(key)) alias.set(key,subjectKey(v));
    }
    list.forEach(subject=>{
      const sid=String(subject.id || subject.name || '').trim();
      add(sid,sid);
      add(subject.name || subjectDisplayName(sid),sid);
      add(subjectDisplayName(sid),sid);
      add(subjectSortCode(sid),sid);
    });
    if(alias.has(excelHeaderKey(id))) return alias.get(excelHeaderKey(id));
    if(alias.has(excelHeaderKey(name))) return alias.get(excelHeaderKey(name));
    const fallback=subjectKey(id || name);
    return fallback && list.some(subject=>subjectMatches(subject.id, fallback) || subjectMatches(subject.name, fallback) || subjectKey(subject.id)===fallback) ? fallback : '';
  }
  function fixedOffImportTruthy(value){
    if(value === true) return true;
    if(typeof value === 'number') return Number(value) !== 0;
    const s=norm(value);
    return ['1','x','xx','nghi','off','true','yes','y','co','có'].includes(s);
  }
  function importTeacherFixedOffRows(rows, opts){
    opts=opts||{};
    if(!Array.isArray(rows) || !rows.length) throw new Error('File Excel không có dữ liệu.');
    const cols=teacherFixedOffExcelColumns();
    const slotByHeader=new Map(cols.map(c=>[excelHeaderKey(c.header),c.key]));
    const headerIndex=rows.findIndex(row=>Array.isArray(row) && row.some(cell=>slotByHeader.has(excelHeaderKey(cell))));
    if(headerIndex<0){
      const matrixResult=importFixedOffMatrixRows('teacher', rows, opts);
      if(matrixResult) return matrixResult;
      throw new Error('Không tìm thấy dòng tiêu đề slot T2_S1/T2_C1 hoặc bảng THU/BUOI/TIET trong Excel.');
    }
    const header=rows[headerIndex] || [];
    const teacherCol=header.findIndex(h=>['magv','teacherid','teacher','id','ma'].includes(excelHeaderKey(h)));
    const nameCol=header.findIndex(h=>['tengv','tengiaovien','hoten','name','teachername'].includes(excelHeaderKey(h)));
    if(teacherCol<0) throw new Error('Thiếu cột MaGV trong Excel.');
    const slotIndexes=[];
    header.forEach((h,i)=>{
      const key=slotByHeader.get(excelHeaderKey(h));
      if(key) slotIndexes.push({index:i,key});
    });
    if(!slotIndexes.length) throw new Error('Không có cột slot cố định hợp lệ.');
    const c=model();
    c.fixedOff.teacher=c.fixedOff.teacher||{};
    let imported=0, skipped=0, offTotal=0;
    for(let r=headerIndex+1;r<rows.length;r++){
      const row=rows[r] || [];
      const rawId=row[teacherCol];
      if(String(rawId==null?'':rawId).trim()==='' && (nameCol<0 || String(row[nameCol]==null?'':row[nameCol]).trim()==='')) continue;
      const teacherId=resolveTeacherImportId(rawId, nameCol>=0 ? row[nameCol] : '');
      if(!teacherId){ skipped++; continue; }
      const slots={};
      slotIndexes.forEach(info=>{ if(fixedOffImportTruthy(row[info.index])) slots[info.key]=true; });
      if(Object.keys(slots).length) c.fixedOff.teacher[teacherId]=slots;
      else delete c.fixedOff.teacher[teacherId];
      imported++;
      offTotal += Object.keys(slots).length;
    }
    touchSave();
    const released=releaseExistingViolationsAfterSave();
    rerenderSafe();
    if(opts.render !== false) render();
    if(opts.notify !== false){
      notifySaved(withTeacherCapacityWarning(`Đã nhập cố định tiết cho ${imported} giáo viên (${offTotal} ô cố định).${skipped?` Bỏ qua ${skipped} dòng không khớp MaGV.`:''}${released>0?` Đã đưa ${released} tiết đang vi phạm về Tiết chưa phân.`:''}`));
    }
    return {imported, skipped, offTotal};
  }
  function syncClassFixedOffRowToTkb(classId, slots, cols){
    cols.forEach(info=>{
      const checked=!!slots[info.key];
      syncClassFixedOffCell(classId, info.thu, info.buoi, info.ti, checked);
    });
  }
  function syncClassFixedOffUserOff(classId, slots){
    const data=D();
    data.tkbUserOff=data.tkbUserOff && typeof data.tkbUserOff==='object' ? data.tkbUserOff : {};
    const keys=Object.keys(slots || {}).filter(k=>slots[k]);
    if(keys.length) data.tkbUserOff[classId]=keys;
    else delete data.tkbUserOff[classId];
  }
  function syncClassFixedOffUserOffFromModel(classId){
    syncClassFixedOffUserOff(classId, model().fixedOff?.class?.[classId] || {});
  }
  function classUserOffHas(classId, key){
    const raw=D().tkbUserOff?.[classId];
    if(Array.isArray(raw)) return raw.includes(key);
    return !!(raw && typeof raw==='object' && raw[key]);
  }
  function classFixedOffSlotsSnapshot(){
    const out={};
    const add=(classId,key)=>{
      if(!classId || !key) return;
      out[classId]=out[classId] || {};
      out[classId][key]=true;
    };
    Object.entries(model().fixedOff?.class || {}).forEach(([classId,slots])=>{
      Object.keys(slots || {}).forEach(key=>{ if(slots[key]) add(classId,key); });
    });
    Object.entries(D().tkbUserOff || {}).forEach(([classId,raw])=>{
      if(Array.isArray(raw)) raw.forEach(key=>add(classId,key));
      else if(raw && typeof raw==='object') Object.keys(raw).forEach(key=>{ if(raw[key]) add(classId,key); });
    });
    return out;
  }
  function clearClassFixedOffCells(snapshot){
    Object.entries(snapshot || {}).forEach(([classId,slots])=>{
      Object.keys(slots || {}).forEach(key=>{
        const p=parseSlotKey(key);
        if(p.thu && p.buoi) syncClassFixedOffCell(classId,p.thu,p.buoi,p.ti,false);
      });
    });
  }
  function fixedOffRowsHaveSlotHeaders(rows, cols){
    const slotByHeader=new Set((cols || []).map(c=>excelHeaderKey(c.header)));
    return (rows || []).some(row=>Array.isArray(row) && row.some(cell=>slotByHeader.has(excelHeaderKey(cell))));
  }
  function resolveFixedOffMatrixImportId(type, value){
    if(type==='teacher') return resolveTeacherImportId(value,value);
    if(type==='subject') return resolveSubjectImportId(value,value);
    return resolveClassImportId(value,value);
  }
  function fixedOffMatrixHeaderInfo(rows,type){
    if(!Array.isArray(rows)) return null;
    const limit=Math.min(rows.length,10);
    for(let r=0;r<limit;r++){
      const row=rows[r] || [];
      const dayCol=row.findIndex(h=>['thu','ngay'].includes(excelHeaderKey(h)));
      const sessionCol=row.findIndex(h=>['buoi','session'].includes(excelHeaderKey(h)));
      const periodCol=row.findIndex(h=>['tiet','period'].includes(excelHeaderKey(h)));
      if(dayCol<0 || sessionCol<0 || periodCol<0) continue;
      const itemCols=[];
      const seen=new Set();
      row.forEach((h,c)=>{
        if(c===dayCol || c===sessionCol || c===periodCol) return;
        const text=String(h==null?'':h).trim();
        if(!text || ['ghichu','note','notes'].includes(excelHeaderKey(text))) return;
        const id=resolveFixedOffMatrixImportId(type,text);
        if(id && !seen.has(id)){
          seen.add(id);
          itemCols.push({index:c,id});
        }
      });
      if(itemCols.length) return {headerIndex:r,dayCol,sessionCol,periodCol,itemCols,classCols:itemCols};
    }
    return null;
  }
  function classFixedOffMatrixHeaderInfo(rows){ return fixedOffMatrixHeaderInfo(rows,'class'); }
  function fixedOffDayKeyFromExcel(value){
    const text=String(value==null?'':value).trim();
    if(!text) return '';
    const n=Number((text.match(/\d+/) || [])[0] || text);
    if(!Number.isFinite(n)) return '';
    return days().find(thu=>Number(fixedOffDayNumber(thu))===n) || '';
  }
  function fixedOffSessionKeyFromExcel(value){
    const k=norm(value);
    if(!k) return '';
    if(k==='s' || k.startsWith('sang') || k.includes('morning')) return 'sang';
    if(k==='c' || k.startsWith('chieu') || k.includes('afternoon')) return 'chieu';
    return SESSION_KEYS.find(b=>norm(SESSION_LABEL[b] || b)===k || norm(b)===k) || '';
  }
  function fixedOffPeriodIndexFromExcel(value){
    if(value==null || value==='') return NaN;
    const text=String(value).trim();
    const n=Number((text.match(/\d+/) || [])[0] || text);
    return Number.isFinite(n) ? n-1 : NaN;
  }
  function fixedOffMatrixImportLabel(type){
    return ({class:'lớp',teacher:'giáo viên',subject:'môn'})[type] || 'đối tượng';
  }
  function importFixedOffMatrixRows(type, rows, opts){
    opts=opts||{};
    const info=fixedOffMatrixHeaderInfo(rows,type);
    if(!info) return null;
    const slotsById={};
    info.itemCols.forEach(col=>{ slotsById[col.id]={}; });
    let currentDay='', currentSession='';
    for(let r=info.headerIndex+1;r<rows.length;r++){
      const row=rows[r] || [];
      const parsedDay=fixedOffDayKeyFromExcel(row[info.dayCol]);
      const parsedSession=fixedOffSessionKeyFromExcel(row[info.sessionCol]);
      if(parsedDay) currentDay=parsedDay;
      if(parsedSession) currentSession=parsedSession;
      const ti=fixedOffPeriodIndexFromExcel(row[info.periodCol]);
      if(!currentDay || !currentSession || !Number.isFinite(ti) || ti<0 || ti>=sessionLen(currentSession)) continue;
      const key=slotKey(currentDay,currentSession,ti);
      info.itemCols.forEach(col=>{
        if(fixedOffImportTruthy(row[col.index])) slotsById[col.id][key]=true;
      });
    }
    const c=model();
    c.fixedOff[type]=c.fixedOff[type]||{};
    const cols=fixedOffMatrixColumns(type);
    let imported=0, offTotal=0;
    Object.entries(slotsById).forEach(([id,slots])=>{
      if(Object.keys(slots).length) c.fixedOff[type][id]=slots;
      else delete c.fixedOff[type][id];
      if(type==='class'){
        syncClassFixedOffRowToTkb(id, slots, cols);
        syncClassFixedOffUserOff(id, slots);
      }
      imported++;
      offTotal += Object.keys(slots).length;
    });
    touchSave();
    const released=releaseExistingViolationsAfterSave();
    rerenderSafe();
    if(opts.render !== false) render();
    if(opts.notify !== false){
      notifySaved(withTeacherCapacityWarning(`Đã nhập cố định tiết cho ${imported} ${fixedOffMatrixImportLabel(type)} (${offTotal} ô cố định).${released>0?` Đã đưa ${released} tiết đang vi phạm về Tiết chưa phân.`:''}`));
    }
    return {imported, skipped:0, offTotal, format:'matrix'};
  }
  function importClassFixedOffMatrixRows(rows, opts){ return importFixedOffMatrixRows('class', rows, opts); }
  function importClassFixedOffRows(rows, opts){
    opts=opts||{};
    if(!Array.isArray(rows) || !rows.length) throw new Error('File Excel không có dữ liệu.');
    const cols=classFixedOffExcelColumns();
    const slotByHeader=new Map(cols.map(c=>[excelHeaderKey(c.header),c.key]));
    const headerIndex=rows.findIndex(row=>Array.isArray(row) && row.some(cell=>slotByHeader.has(excelHeaderKey(cell))));
    if(headerIndex<0){
      const matrixResult=importClassFixedOffMatrixRows(rows, opts);
      if(matrixResult) return matrixResult;
      throw new Error('Không tìm thấy dòng tiêu đề slot T2_S1/T2_C1 hoặc bảng THU/BUOI/TIET trong Excel.');
    }
    const header=rows[headerIndex] || [];
    const classCol=header.findIndex(h=>['malop','lop','classid','class','id','ma'].includes(excelHeaderKey(h)));
    const nameCol=header.findIndex(h=>['tenlop','tenlophoc','lopname','classname','name'].includes(excelHeaderKey(h)));
    if(classCol<0) throw new Error('Thiếu cột MaLop trong Excel.');
    const slotIndexes=[];
    header.forEach((h,i)=>{
      const key=slotByHeader.get(excelHeaderKey(h));
      if(key) slotIndexes.push({index:i,key});
    });
    if(!slotIndexes.length) throw new Error('Không có cột slot cố định hợp lệ.');
    const c=model();
    c.fixedOff.class=c.fixedOff.class||{};
    let imported=0, skipped=0, offTotal=0;
    for(let r=headerIndex+1;r<rows.length;r++){
      const row=rows[r] || [];
      const rawId=row[classCol];
      if(String(rawId==null?'':rawId).trim()==='' && (nameCol<0 || String(row[nameCol]==null?'':row[nameCol]).trim()==='')) continue;
      const classId=resolveClassImportId(rawId, nameCol>=0 ? row[nameCol] : '');
      if(!classId){ skipped++; continue; }
      const slots={};
      slotIndexes.forEach(info=>{ if(fixedOffImportTruthy(row[info.index])) slots[info.key]=true; });
      if(Object.keys(slots).length) c.fixedOff.class[classId]=slots;
      else delete c.fixedOff.class[classId];
      syncClassFixedOffRowToTkb(classId, slots, cols);
      syncClassFixedOffUserOff(classId, slots);
      imported++;
      offTotal += Object.keys(slots).length;
    }
    touchSave();
    const released=releaseExistingViolationsAfterSave();
    rerenderSafe();
    if(opts.render !== false) render();
    if(opts.notify !== false){
      notifySaved(withTeacherCapacityWarning(`Đã nhập cố định tiết cho ${imported} lớp (${offTotal} ô cố định).${skipped?` Bỏ qua ${skipped} dòng không khớp MaLop.`:''}${released>0?` Đã đưa ${released} tiết đang vi phạm về Tiết chưa phân.`:''}`));
    }
    return {imported, skipped, offTotal};
  }
  function importSubjectFixedOffRows(rows, opts){
    opts=opts||{};
    if(!Array.isArray(rows) || !rows.length) throw new Error('File Excel không có dữ liệu.');
    const cols=subjectFixedOffExcelColumns();
    const slotByHeader=new Map(cols.map(c=>[excelHeaderKey(c.header),c.key]));
    const headerIndex=rows.findIndex(row=>Array.isArray(row) && row.some(cell=>slotByHeader.has(excelHeaderKey(cell))));
    if(headerIndex<0){
      const matrixResult=importFixedOffMatrixRows('subject', rows, opts);
      if(matrixResult) return matrixResult;
      throw new Error('Không tìm thấy dòng tiêu đề slot T2_S1/T2_C1 hoặc bảng THU/BUOI/TIET trong Excel.');
    }
    const header=rows[headerIndex] || [];
    const subjectCol=header.findIndex(h=>['mamon','mon','subjectid','subject','id','ma'].includes(excelHeaderKey(h)));
    const nameCol=header.findIndex(h=>['tenmon','tenmonhoc','monhoc','subjectname','name'].includes(excelHeaderKey(h)));
    if(subjectCol<0) throw new Error('Thiếu cột MaMon trong Excel.');
    const slotIndexes=[];
    header.forEach((h,i)=>{
      const key=slotByHeader.get(excelHeaderKey(h));
      if(key) slotIndexes.push({index:i,key});
    });
    if(!slotIndexes.length) throw new Error('Không có cột slot cố định hợp lệ.');
    const c=model();
    c.fixedOff.subject=c.fixedOff.subject||{};
    let imported=0, skipped=0, offTotal=0;
    for(let r=headerIndex+1;r<rows.length;r++){
      const row=rows[r] || [];
      const rawId=row[subjectCol];
      if(String(rawId==null?'':rawId).trim()==='' && (nameCol<0 || String(row[nameCol]==null?'':row[nameCol]).trim()==='')) continue;
      const subjectId=resolveSubjectImportId(rawId, nameCol>=0 ? row[nameCol] : '');
      if(!subjectId){ skipped++; continue; }
      const slots={};
      slotIndexes.forEach(info=>{ if(fixedOffImportTruthy(row[info.index])) slots[info.key]=true; });
      if(Object.keys(slots).length) c.fixedOff.subject[subjectId]=slots;
      else delete c.fixedOff.subject[subjectId];
      imported++;
      offTotal += Object.keys(slots).length;
    }
    touchSave();
    const released=releaseExistingViolationsAfterSave();
    rerenderSafe();
    if(opts.render !== false) render();
    if(opts.notify !== false){
      notifySaved(withTeacherCapacityWarning(`Đã nhập cố định tiết cho ${imported} môn (${offTotal} ô cố định).${skipped?` Bỏ qua ${skipped} dòng không khớp MaMon.`:''}${released>0?` Đã đưa ${released} tiết đang vi phạm về Tiết chưa phân.`:''}`));
    }
    return {imported, skipped, offTotal};
  }
  function importTeacherFixedOffExcelFile(file){
    if(!file) return;
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    const reader=new FileReader();
    reader.onload=function(){
      try{
        const wb=XLSX.read(new Uint8Array(reader.result),{type:'array'});
        const rows=fixedOffWorkbookRows(wb,['CoDinhGV','TietNghiGV','DuLieuImport'],teacherFixedOffExcelColumns(),r=>fixedOffMatrixHeaderInfo(r,'teacher'));
        importTeacherFixedOffRows(rows);
      }catch(err){
        console.error('[tkb-constraints] import teacher fixed-off failed',err);
        alert(`Nhập Excel cố định tiết giáo viên thất bại: ${err?.message || err}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }
  function fixedOffWorkbookRows(wb, preferredNames, cols, matrixHeaderFn){
    const ordered=arrUnique([...(preferredNames || []), ...(wb?.SheetNames || [])]);
    let fallback=null;
    for(const sheetName of ordered){
      const ws=wb?.Sheets?.[sheetName];
      if(!ws) continue;
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      if(!fallback) fallback=rows;
      if(fixedOffRowsHaveSlotHeaders(rows, cols) || (typeof matrixHeaderFn==='function' && matrixHeaderFn(rows))) return rows;
    }
    return fallback || [];
  }
  function importClassFixedOffExcelFile(file){
    if(!file) return;
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    const reader=new FileReader();
    reader.onload=function(){
      try{
        const wb=XLSX.read(new Uint8Array(reader.result),{type:'array'});
        const rows=fixedOffWorkbookRows(wb,['CoDinhLop','TietNghiLop','DuLieuImport'],classFixedOffExcelColumns(),classFixedOffMatrixHeaderInfo);
        importClassFixedOffRows(rows);
      }catch(err){
        console.error('[tkb-constraints] import class fixed-off failed',err);
        alert(`Nhập Excel cố định tiết lớp thất bại: ${err?.message || err}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }
  function importSubjectFixedOffExcelFile(file){
    if(!file) return;
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    const reader=new FileReader();
    reader.onload=function(){
      try{
        const wb=XLSX.read(new Uint8Array(reader.result),{type:'array'});
        const rows=fixedOffWorkbookRows(wb,['CoDinhMon','TietNghiMon','DuLieuImport'],subjectFixedOffExcelColumns(),r=>fixedOffMatrixHeaderInfo(r,'subject'));
        importSubjectFixedOffRows(rows);
      }catch(err){
        console.error('[tkb-constraints] import subject fixed-off failed',err);
        alert(`Nhập Excel cố định tiết môn thất bại: ${err?.message || err}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }
  function fixedOffExcelTypeSupported(type){
    return ['class','teacher','subject'].includes(String(type || ''));
  }
  function fixedOffExcelLabel(type){
    return ({class:'lớp học',teacher:'giáo viên',subject:'môn học'})[type] || 'ô cố định';
  }
  function exportFixedOffExcelForType(type){
    if(type==='class') return exportClassFixedOffExcel();
    if(type==='teacher') return exportTeacherFixedOffExcel();
    if(type==='subject') return exportSubjectFixedOffExcel();
    return exportAllConstraintsExcel();
  }
  function importFixedOffExcelFileForType(type,file){
    if(type==='class') return importClassFixedOffExcelFile(file);
    if(type==='teacher') return importTeacherFixedOffExcelFile(file);
    if(type==='subject') return importSubjectFixedOffExcelFile(file);
    return importAllConstraintsExcelFile(file);
  }
  function currentFixedOffExcelType(){
    const type=String(state.section==='fixedOff' ? state.fixedType || '' : '');
    return fixedOffExcelTypeSupported(type) ? type : '';
  }
  function exportConstraintsForCurrentContext(){
    const type=currentFixedOffExcelType();
    if(type) return exportFixedOffExcelForType(type);
    return exportAllConstraintsExcel();
  }
  function importConstraintsForCurrentContext(file){
    const type=currentFixedOffExcelType();
    if(type) return importFixedOffExcelFileForType(type,file);
    return importAllConstraintsExcelFile(file);
  }
  function clonePlain(value){
    try{ return JSON.parse(JSON.stringify(value || {})); }
    catch(_){ return {}; }
  }
  function constraintsForExport(){
    const constraints=clonePlain(model());
    constraints.fixedOff=constraints.fixedOff || {};
    constraints.fixedOff.class=classFixedOffSlotsSnapshot();
    constraints.fixedOff.teacher=constraints.fixedOff.teacher || {};
    constraints.fixedOff.subject=constraints.fixedOff.subject || {};
    constraints.fixedOff.room=constraints.fixedOff.room || {};
    constraints.fixedOff.subjectGroup=constraints.fixedOff.subjectGroup || {};
    return constraints;
  }
  function fullConstraintsSummaryRows(payload){
    const c=payload?.constraints || model();
    const fixedSlots=['class','teacher','subject','subjectGroup','room'].reduce((sum,type)=>{
      const fixed=c.fixedOff?.[type] || {};
      return sum + Object.values(fixed).reduce((s,slots)=>s+countObjectKeys(slots),0);
    },0);
    const groups=['class','subject','room'].reduce((sum,type)=>sum+countObjectKeys(c.groups?.[type]),0);
    const noSameSessionGroups=noSameActiveGroupCount();
    return [
      ['Yêu cầu thời khóa biểu'],
      [''],
      ['Mục', 'Số lượng'],
      ['Giáo viên có thiết lập', countObjectKeys(c.teacher)],
      ['Môn/lớp có thiết lập', countObjectKeys(c.subject)],
      ['Nhóm môn không cùng buổi/ngày', noSameSessionGroups],
      ['Nhóm dữ liệu', groups],
      ['Ô cố định đã đặt', fixedSlots],
      ['Giới hạn thời điểm', Array.isArray(c.timeLimit) ? c.timeLimit.length : 0],
      [''],
      ['Thông tin', 'Giá trị'],
      ['Phiên bản', payload?.version || VERSION],
      ['Xuất lúc', payload?.exportedAt || ''],
      ['Import nhanh', 'Giữ nguyên file này và bấm Nhập Excel trong phần Yêu cầu.']
    ];
  }
  function fullConstraintsHelpRows(){
    return [
      ['Hướng dẫn'],
      ['File này dùng để xuất/nhập toàn bộ yêu cầu TKB một lần.'],
      ['Các sheet TongQuan, CoDinh, GiaoVien, LopMon, Nhom, GioiHan dùng để xem nhanh và đối chiếu.'],
      ['Sheet dữ liệu import RangBuocJSON được ẩn để file gọn hơn; không xóa sheet này nếu muốn nhập lại nguyên trạng.'],
      ['Khi nhập, toàn bộ yêu cầu hiện tại sẽ được thay bằng dữ liệu trong file.'],
      ['Ô cố định lớp trong yêu cầu sẽ được cập nhật lại thành ô OFF trên thời khóa biểu.'],
      ['Quy ước: Bật = có áp dụng; Tắt = tắt rõ ràng; các ô trống nghĩa là chưa thiết lập.']
    ];
  }
  function fullConstraintsExportPayload(){
    return {
      kind:'TKB_CONSTRAINTS_FULL',
      app:'tkb_new',
      version:VERSION,
      exportedAt:new Date().toISOString(),
      constraints:constraintsForExport()
    };
  }
  function fullConstraintsJsonRows(payload){
    const text=JSON.stringify(payload);
    const size=20000;
    const rows=[
      ['TKB_CONSTRAINTS_EXPORT','1'],
      ['type','index','jsonChunk']
    ];
    for(let i=0;i<text.length;i+=size){
      rows.push(['TKB_CONSTRAINTS_JSON', Math.floor(i/size), text.slice(i,i+size)]);
    }
    return rows;
  }
  function excelRuleLabel(kind, rule){
    const src = kind === 'teacher' ? TEACHER_RULES : SUBJECT_RULES;
    return (src.find(x=>String(x[0])===String(rule)) || [rule, rule])[1] || rule || '';
  }
  function excelFixedTypeLabel(type){
    return ({
      class:'Lớp học',
      teacher:'Giáo viên',
      subject:'Môn học',
      subjectGroup:'Nhóm môn học',
      room:'Phòng học'
    })[type] || type || '';
  }
  function excelTargetTypeLabel(type){
    return ({
      class:'Lớp',
      teacher:'Giáo viên',
      subject:'Môn',
      room:'Phòng',
      classGroup:'Nhóm lớp',
      teacherGroup:'Giáo viên',
      subjectGroup:'Nhóm môn'
    })[type] || type || '';
  }
  function excelTargetName(type, id, constraints){
    const c=constraints || model();
    if(type==='class' || type==='classGroup') return type==='classGroup' ? (c.groups?.class?.[id]?.name || id) : classNameOf(id);
    if(type==='teacher' || type==='teacherGroup') return type==='teacherGroup' ? (c.groups?.teacher?.[id]?.name || id) : (teacherName(id) || id);
    if(type==='subject' || type==='subjectGroup') return type==='subjectGroup' ? (c.groups?.subject?.[id]?.name || id) : subjectDisplayName(id);
    if(type==='room') return itemName('room', id);
    return String(id || '');
  }
  function excelValue(v){
    if(v === true) return 'Bật';
    if(v === false) return 'Tắt';
    if(v == null) return '';
    if(Array.isArray(v)) return v.map(x=>String(x == null ? '' : x)).filter(Boolean).join(', ');
    if(typeof v === 'object') return JSON.stringify(v);
    return v;
  }
  function excelWalkValues(obj, visit, path){
    const base=path || '';
    if(obj == null || obj === '') return;
    if(typeof obj !== 'object' || Array.isArray(obj)){
      visit(base, excelValue(obj));
      return;
    }
    Object.entries(obj || {}).forEach(([key,val])=>{
      const next=base ? `${base}.${key}` : key;
      if(val && typeof val === 'object' && !Array.isArray(val)) excelWalkValues(val, visit, next);
      else if(val !== '' && val != null) visit(next, excelValue(val));
    });
  }
  function excelTeacherRows(payload){
    const c=payload?.constraints || model();
    const rows=[['Mã GV','Giáo viên','Yêu cầu','Đường dẫn','Giá trị']];
    Object.entries(c.teacher || {}).forEach(([teacherId,ruleObj])=>{
      Object.entries(ruleObj || {}).forEach(([rule,ruleVal])=>{
        excelWalkValues(ruleVal, (path,val)=>{
          rows.push([teacherId, teacherName(teacherId) || teacherId, excelRuleLabel('teacher', rule), path || rule, val]);
        });
      });
    });
    if(rows.length===1) rows.push(['','','Chưa có yêu cầu giáo viên','','']);
    return rows;
  }
  function excelSubjectRows(payload){
    const c=payload?.constraints || model();
    const rows=[['Loại','Mã môn/nhóm','Tên môn/nhóm','Mã lớp','Lớp','Yêu cầu','Đường dẫn','Giá trị']];
    Object.entries(c.subject || {}).forEach(([subjectId,subjectObj])=>{
      Object.entries(subjectObj || {}).forEach(([key,val])=>{
        if(key==='byClass' && val && typeof val==='object'){
          Object.entries(val).forEach(([classId,classRule])=>{
            Object.entries(classRule || {}).forEach(([rule,ruleVal])=>{
              excelWalkValues(ruleVal, (path,cellVal)=>{
                rows.push(['Môn học', subjectId, subjectDisplayName(subjectId), classId, classNameOf(classId), excelRuleLabel('subject', rule), path || rule, cellVal]);
              });
            });
          });
        }else{
          excelWalkValues(val, (path,cellVal)=>{
            rows.push(['Môn học', subjectId, subjectDisplayName(subjectId), '', '', excelRuleLabel('subject', key), path || key, cellVal]);
          });
        }
      });
    });
    Object.entries(c.subjectGroup || {}).forEach(([groupId,groupObj])=>{
      Object.entries(groupObj || {}).forEach(([key,val])=>{
        excelWalkValues(val, (path,cellVal)=>{
          rows.push(['Nhóm môn', groupId, c.groups?.subject?.[groupId]?.name || groupId, '', '', excelRuleLabel('subject', key), path || key, cellVal]);
        });
      });
    });
    Object.entries(c.subjectNoSameSession?.byClass || {}).forEach(([classId,row])=>{
      excelWalkValues(row, (path,val)=>{
        rows.push(['Không cùng buổi/ngày', '', '', classId, classNameOf(classId), 'Môn học không cùng buổi/ngày', path, val]);
      });
    });
    if(rows.length===1) rows.push(['','','','','','Chưa có yêu cầu lớp/môn','','']);
    return rows;
  }
  function excelFixedOffRows(payload){
    const c=payload?.constraints || model();
    const rows=[['Loại','Mã','Tên','Thứ','Buổi','Tiết','Mã slot']];
    ['class','teacher','subject','subjectGroup','room'].forEach(type=>{
      Object.entries(c.fixedOff?.[type] || {}).forEach(([id,slots])=>{
        Object.keys(slots || {}).filter(key=>slots[key]).sort().forEach(key=>{
          const p=parseSlotKey(key);
          rows.push([excelFixedTypeLabel(type), id, excelTargetName(type,id,c), dayLabel(p.thu), SESSION_LABEL[p.buoi] || p.buoi, Number(p.ti)+1, key]);
        });
      });
    });
    if(rows.length===1) rows.push(['','','Chưa có ô cố định','','','','']);
    return rows;
  }
  function excelGroupRows(payload){
    const c=payload?.constraints || model();
    const rows=[['Loại nhóm','Mã nhóm','Tên nhóm','Số mục','Danh sách mã','Danh sách tên']];
    const groupTypeLabel={class:'Nhóm lớp',subject:'Nhóm môn',room:'Nhóm phòng'};
    ['class','subject','room'].forEach(type=>{
      Object.entries(c.groups?.[type] || {}).forEach(([id,g])=>{
        const items=Array.isArray(g?.items) ? g.items.map(String) : [];
        rows.push([groupTypeLabel[type] || excelTargetTypeLabel(type), id, g?.name || id, items.length, items.join(', '), items.map(item=>excelTargetName(type,item,c)).join(', ')]);
      });
    });
    if(rows.length===1) rows.push(['','','Chưa có nhóm dữ liệu','','','']);
    return rows;
  }
  function excelTimeLimitRows(payload){
    const c=payload?.constraints || model();
    const rows=[['STT','Loại đối tượng','Mã đối tượng','Tên đối tượng','Đường dẫn','Giá trị']];
    (Array.isArray(c.timeLimit) ? c.timeLimit : []).forEach((rule,index)=>{
      const targetType=String(rule?.targetType || '');
      const targetId=String(rule?.targetId || '');
      Object.entries(rule || {}).forEach(([key,val])=>{
        if(['targetType','targetId'].includes(key)) return;
        excelWalkValues(val, (path,cellVal)=>{
          rows.push([index+1, excelTargetTypeLabel(targetType), targetId, excelTargetName(targetType,targetId,c), path ? `${key}.${path}` : key, cellVal]);
        });
      });
    });
    if(rows.length===1) rows.push(['','','','Chưa có giới hạn thời điểm','','']);
    return rows;
  }
  function excelAppendSheet(wb, name, rows, widths, opts){
    const ws=XLSX.utils.aoa_to_sheet(rows);
    excelDecorateSheet(ws, rows, widths, opts || {});
    if(opts?.merges) ws['!merges']=opts.merges;
    XLSX.utils.book_append_sheet(wb,ws,name);
    return ws;
  }
  function excelHideSheet(wb, name){
    const idx=(wb.SheetNames || []).indexOf(name);
    if(idx < 0) return;
    wb.Workbook=wb.Workbook || {};
    wb.Workbook.Sheets=wb.Workbook.Sheets || wb.SheetNames.map(n=>({name:n}));
    wb.Workbook.Sheets[idx]=wb.Workbook.Sheets[idx] || {name};
    wb.Workbook.Sheets[idx].Hidden=1;
  }
  function exportAllConstraintsExcel(){
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    try{ saveCurrentFromUI(false,{releaseExisting:false}); }catch(_){}
    const payload=fullConstraintsExportPayload();
    const wb=XLSX.utils.book_new();
    excelAppendSheet(wb,'TongQuan',fullConstraintsSummaryRows(payload),[34,72],{filter:false,freeze:false,titleRows:[0,10],headerRows:[2],merges:[{s:{r:0,c:0},e:{r:0,c:1}}]});
    excelAppendSheet(wb,'HuongDan',fullConstraintsHelpRows(),[118],{filter:false,freeze:false,titleRows:[0],headerRows:[]});
    excelAppendSheet(wb,'CoDinh',excelTitledRows('Ô cố định', 'Tổng hợp các ô nghỉ/cố định theo lớp, giáo viên, môn, nhóm môn và phòng.', excelFixedOffRows(payload)),[16,18,32,12,10,8,20],{freeze:{xSplit:3,ySplit:3},titleRows:[0],headerRows:[2],filterRow:2});
    excelAppendSheet(wb,'GiaoVien',excelTitledRows('Yêu cầu giáo viên', 'Mỗi dòng là một thiết lập đang bật hoặc có giá trị của giáo viên.', excelTeacherRows(payload)),[16,30,34,34,22],{freeze:{xSplit:2,ySplit:3},titleRows:[0],headerRows:[2],filterRow:2});
    excelAppendSheet(wb,'LopMon',excelTitledRows('Yêu cầu lớp / môn học', 'Mỗi dòng là một thiết lập theo môn, nhóm môn hoặc nhóm không cùng buổi/ngày.', excelSubjectRows(payload)),[20,18,28,14,18,34,34,22],{freeze:{xSplit:5,ySplit:3},titleRows:[0],headerRows:[2],filterRow:2});
    excelAppendSheet(wb,'Nhom',excelTitledRows('Nhóm dữ liệu', 'Các nhóm lớp, giáo viên, môn và phòng dùng chung cho yêu cầu.', excelGroupRows(payload)),[16,20,28,10,56,72],{freeze:{xSplit:3,ySplit:3},titleRows:[0],headerRows:[2],filterRow:2});
    excelAppendSheet(wb,'GioiHan',excelTitledRows('Giới hạn số tiết / 1 thời điểm', 'Các giới hạn theo nhóm tại từng thời điểm hoặc từng buổi.', excelTimeLimitRows(payload)),[8,18,18,28,38,22],{freeze:{xSplit:4,ySplit:3},titleRows:[0],headerRows:[2],filterRow:2});
    excelAppendSheet(wb,'RangBuocJSON',fullConstraintsJsonRows(payload),[24,8,96],{filter:false,freeze:false,headerRows:[0]});
    excelHideSheet(wb,'RangBuocJSON');
    const d=new Date();
    const stamp=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    XLSX.writeFile(wb,`yeu_cau_tkb_toan_bo_${stamp}.xlsx`,{compression:true, cellStyles:true});
  }
  function readAllConstraintsPayloadFromWorkbook(wb){
    const sheetName=(wb.SheetNames || []).find(name=>name === 'RangBuocJSON') || (wb.SheetNames || [])[0];
    if(!sheetName) throw new Error('File Excel không có sheet dữ liệu.');
    const ws=wb.Sheets[sheetName];
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
    const chunks=[];
    rows.forEach(row=>{
      if(!Array.isArray(row)) return;
      if(String(row[0] || '').trim() === 'TKB_CONSTRAINTS_JSON'){
        const index=toInt(row[1], chunks.length);
        chunks.push({index, text:String(row[2] || '')});
      }
    });
    let raw='';
    if(chunks.length){
      raw=chunks.sort((a,b)=>a.index-b.index).map(item=>item.text).join('');
    }else{
      const jsonRow=rows.find(row=>Array.isArray(row) && ['json','constraints','tkbconstraints'].includes(excelHeaderKey(row[0])));
      raw=String(jsonRow?.[1] || jsonRow?.[2] || '').trim();
    }
    if(!raw) throw new Error('Không tìm thấy dữ liệu yêu cầu trong file Excel.');
    const payload=JSON.parse(raw);
    if(!payload || typeof payload !== 'object') throw new Error('Dữ liệu yêu cầu không hợp lệ.');
    const constraints=payload.constraints || payload.tkbConstraints || payload;
    if(!constraints || typeof constraints !== 'object') throw new Error('File không chứa tkbConstraints hợp lệ.');
    return payload.kind ? payload : {kind:'TKB_CONSTRAINTS_FULL', constraints};
  }
  function applyImportedConstraintsPayload(payload){
    const next=payload?.constraints || payload?.tkbConstraints || payload;
    if(!next || typeof next !== 'object') throw new Error('Dữ liệu yêu cầu không hợp lệ.');
    const before=classFixedOffSlotsSnapshot();
    const data=D();
    data.tkbConstraints=normalizeModel(clonePlain(next));
    try{ Object.defineProperty(data.tkbConstraints, '__normalizedBy', {value: VERSION, writable: true, enumerable: false}); }
    catch(_){ data.tkbConstraints.__normalizedBy = VERSION; }
    clearClassFixedOffCells(before);
    data.tkbUserOff={};
    const cols=classFixedOffExcelColumns();
    Object.entries(data.tkbConstraints.fixedOff?.class || {}).forEach(([classId,slots])=>{
      syncClassFixedOffRowToTkb(classId, slots || {}, cols);
      syncClassFixedOffUserOff(classId, slots || {});
    });
    touchSave();
    releaseExistingViolationsAfterSave();
    rerenderSafe();
    render();
    return fullConstraintsSummaryRows({constraints:data.tkbConstraints});
  }
  function importAllConstraintsExcelFile(file){
    if(!file) return;
    if(!window.XLSX){
      alert('Chưa tải được thư viện Excel XLSX.');
      return;
    }
    const reader=new FileReader();
    reader.onload=function(){
      try{
        const wb=XLSX.read(new Uint8Array(reader.result),{type:'array'});
        const payload=readAllConstraintsPayloadFromWorkbook(wb);
        if(!confirm('Nhập file này sẽ thay thế toàn bộ yêu cầu hiện tại. Tiếp tục?')) return;
        applyImportedConstraintsPayload(payload);
        notifySaved(withTeacherCapacityWarning('Đã nhập toàn bộ yêu cầu từ Excel.'));
      }catch(err){
        console.error('[tkb-constraints] import all constraints failed',err);
        alert(`Nhập Excel yêu cầu thất bại: ${err?.message || err}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }
  function teacherTotalPeriodsForLimit(id){
    const a=teacherStatsFromAssignments(id);
    const s=teacherStatsFromSchedule(id);
    const c=teacherStats(id);
    return Math.max(Number(a.TS||0), Number(s.TS||0), Number(c.TS||0));
  }
  function teacherMustTeachObj(id){
    const c=model();
    c.teacher[id]=c.teacher[id]||{};
    c.teacher[id].mustTeach=c.teacher[id].mustTeach||{};
    return c.teacher[id].mustTeach;
  }
  function teacherMustTeachCount(id, slots){
    const obj=slots || model().teacher?.[id]?.mustTeach || {};
    return Object.values(obj || {}).filter(Boolean).length;
  }
  function mustTeachPrimaryTeacherId(list){
    const teachers=list || fixedOffListForType('teacher');
    const valid=new Set((teachers || []).map(it=>String(it.id)));
    let id=String(state.fixedSelected?.teacher || teachers?.[0]?.id || '');
    if(id && valid.has(id)){
      if(!Array.isArray(state.mustTeachTeacherIds) || !state.mustTeachTeacherIds.map(String).includes(id)) state.mustTeachTeacherIds=[id];
      return id;
    }
    id=String(teachers?.[0]?.id || '');
    state.fixedSelected=state.fixedSelected || {};
    state.fixedSelected.teacher=id;
    state.mustTeachTeacherIds=id ? [id] : [];
    return id;
  }
  function mustTeachSelectedTeacherIds(list){
    const teachers=list || fixedOffListForType('teacher');
    const valid=new Set((teachers || []).map(it=>String(it.id)));
    const primary=String(mustTeachPrimaryTeacherId(teachers) || '');
    let ids=Array.isArray(state.mustTeachTeacherIds) ? state.mustTeachTeacherIds.map(String).filter(id=>valid.has(id)) : [];
    if(primary && !ids.includes(primary)) ids.unshift(primary);
    ids=arrUnique(ids);
    state.mustTeachTeacherIds=ids.length ? ids : (primary ? [primary] : []);
    return state.mustTeachTeacherIds;
  }
  function setMustTeachSingleTeacher(id){
    const tid=String(id || '');
    state.fixedSelected=state.fixedSelected || {};
    state.fixedSelected.teacher=tid;
    state.mustTeachTeacherIds=tid ? [tid] : [];
  }
  function toggleMustTeachTeacher(id, list){
    const tid=String(id || '');
    if(!tid) return;
    const primary=String(mustTeachPrimaryTeacherId(list) || '');
    let ids=mustTeachSelectedTeacherIds(list).map(String);
    if(ids.includes(tid)){
      if(ids.length <= 1) return;
      ids=ids.filter(x=>x!==tid);
      if(primary===tid){
        state.fixedSelected=state.fixedSelected || {};
        state.fixedSelected.teacher=ids[0] || '';
      }
    }else{
      ids.push(tid);
    }
    state.mustTeachTeacherIds=arrUnique(ids);
    if(!state.fixedSelected?.teacher && state.mustTeachTeacherIds.length){
      state.fixedSelected=state.fixedSelected || {};
      state.fixedSelected.teacher=state.mustTeachTeacherIds[0];
    }
  }
  function mustTeachSelectedSlots(){
    state.mustTeachSlots=arrUnique(state.mustTeachSlots || []);
    return state.mustTeachSlots;
  }
  function setMustTeachAnchorSlot(slot){
    state.mustTeachAnchorSlot=String(slot || '');
  }
  function setMustTeachSingleSlot(slot){
    const key=String(slot || '');
    state.mustTeachSlots=key ? [key] : [];
    setMustTeachAnchorSlot(key);
  }
  function toggleMustTeachSlot(slot){
    const key=String(slot || '');
    if(!key) return;
    const ids=mustTeachSelectedSlots();
    state.mustTeachSlots=ids.includes(key) ? ids.filter(x=>x!==key) : [...ids,key];
    setMustTeachAnchorSlot(key);
  }
  function mustTeachGridRows(){
    const rows=[];
    for(let i=0;i<sessionLen('sang');i++) rows.push({buoi:'sang',ti:i});
    for(let i=0;i<sessionLen('chieu');i++) rows.push({buoi:'chieu',ti:i});
    return rows;
  }
  function mustTeachSlotPoint(slot){
    const p=parseSlotKey(slot);
    const col=days().indexOf(p.thu);
    const rows=mustTeachGridRows();
    const row=rows.findIndex(r=>String(r.buoi)===String(p.buoi) && Number(r.ti)===Number(p.ti));
    if(col<0 || row<0) return null;
    return {row,col};
  }
  function mustTeachRangeSlots(a,b){
    const pa=mustTeachSlotPoint(a), pb=mustTeachSlotPoint(b);
    if(!pa || !pb) return b ? [String(b)] : [];
    const rows=mustTeachGridRows();
    const ds=days();
    const r1=Math.min(pa.row,pb.row), r2=Math.max(pa.row,pb.row);
    const c1=Math.min(pa.col,pb.col), c2=Math.max(pa.col,pb.col);
    const out=[];
    for(let r=r1;r<=r2;r++){
      for(let c=c1;c<=c2;c++){
        const row=rows[r], thu=ds[c];
        if(row && thu) out.push(slotKey(thu,row.buoi,row.ti));
      }
    }
    return out;
  }
  function selectMustTeachRange(slot, additive){
    const key=String(slot || '');
    if(!key) return;
    const anchor=String(state.mustTeachAnchorSlot || mustTeachSelectedSlots()[0] || key);
    const range=mustTeachRangeSlots(anchor,key);
    state.mustTeachSlots=additive ? arrUnique([...mustTeachSelectedSlots(),...range]) : arrUnique(range);
    setMustTeachAnchorSlot(anchor);
  }
  function refreshMustTeachSelection(root){
    const selected=new Set(mustTeachSelectedSlots().map(String));
    (root || document).querySelectorAll('[data-mt-toggle][data-slot]').forEach(el=>{
      el.classList.toggle('selected', selected.has(String(el.dataset.slot || '')));
    });
  }
  function refreshMustTeachGridCells(root, teacherIds, keys){
    const ids=new Set((teacherIds || []).map(id=>String(id || '')).filter(Boolean));
    const keySet=new Set((keys || allSlotKeysForGrid()).map(String));
    const selected=new Set(mustTeachSelectedSlots().map(String));
    (root || document).querySelectorAll('[data-mt-toggle][data-mt-id][data-slot]').forEach(el=>{
      const id=String(el.dataset.mtId || '');
      const sk=String(el.dataset.slot || '');
      if(ids.size && !ids.has(id)) return;
      if(!keySet.has(sk)) return;
      const slots=model().teacher?.[id]?.mustTeach || {};
      el.classList.toggle('must', !!slots[sk]);
      el.classList.toggle('selected', selected.has(sk));
    });
  }
  function teacherShortHtml(id){
    const full=teacherName(id)||id||'';
    const short=teacherShortName(id, full);
    return `<span class="rb-teacher-short" title="${esc(full)}">${esc(short)}</span>`;
  }
  function validateTeacherMustTeachLimit(id, slots, opts){
    const count=teacherMustTeachCount(id, slots);
    const total=teacherTotalPeriodsForLimit(id);
    if(count>total){
      if(!opts || opts.alert !== false) alert(`${teacherName(id)||id}: số vị trí phải có tiết dạy (${count}) lớn hơn tổng số tiết của giáo viên (${total}). Không lưu yêu cầu này.`);
      return false;
    }
    return true;
  }
  function setTeacherMustTeachFlag(id, thu, buoi, ti, checked){
    const sk=slotKey(thu,buoi,ti);
    const current=Object.assign({}, model().teacher?.[id]?.mustTeach || {});
    if(checked) current[sk]=true; else delete current[sk];
    if(!validateTeacherMustTeachLimit(id, current)) return false;
    const c=model(); c.teacher[id]=c.teacher[id]||{};
    if(checked) teacherMustTeachObj(id)[sk]=true;
    else if(c.teacher[id].mustTeach) delete c.teacher[id].mustTeach[sk];
    delEmpty(c.teacher[id]);
    if(Object.keys(c.teacher[id]||{}).length===0) delete c.teacher[id];
    return true;
  }
  function teacherMustTeachAllChecked(id){
    const slots=model().teacher?.[id]?.mustTeach || {};
    const keys=allSlotKeysForGrid();
    return keys.length > 0 && keys.every(key=>!!slots[key]);
  }
  function setTeacherMustTeachKeys(id, keys, checked){
    const next=Object.assign({}, model().teacher?.[id]?.mustTeach || {});
    (keys || []).forEach(key=>{ if(checked) next[key]=true; else delete next[key]; });
    if(!validateTeacherMustTeachLimit(id, next)) return false;
    const c=model();
    c.teacher[id]=c.teacher[id]||{};
    if(Object.keys(next).length) c.teacher[id].mustTeach=next;
    else delete c.teacher[id].mustTeach;
    delEmpty(c.teacher[id]);
    if(Object.keys(c.teacher[id]||{}).length===0) delete c.teacher[id];
    return true;
  }
  function setTeacherMustTeachAll(id, checked){
    return setTeacherMustTeachKeys(id, allSlotKeysForGrid(), checked);
  }
  function applyMustTeachSelectedSlots(forceChecked){
    const list=fixedOffListForType('teacher');
    const teacherIds=mustTeachSelectedTeacherIds(list);
    const keys=mustTeachSelectedSlots();
    if(!teacherIds.length || !keys.length) return false;
    const primary=String(mustTeachPrimaryTeacherId(list) || teacherIds[0] || '');
    const primarySlots=model().teacher?.[primary]?.mustTeach || {};
    const checked=forceChecked == null ? !keys.every(key=>!!primarySlots[key]) : !!forceChecked;
    const updates=[];
    for(const id of teacherIds){
      const next=Object.assign({}, model().teacher?.[id]?.mustTeach || {});
      keys.forEach(key=>{ if(checked) next[key]=true; else delete next[key]; });
      if(!validateTeacherMustTeachLimit(id,next)) return false;
      updates.push({id,next});
    }
    const c=model();
    updates.forEach(({id,next})=>{
      c.teacher[id]=c.teacher[id]||{};
      if(Object.keys(next).length) c.teacher[id].mustTeach=next;
      else delete c.teacher[id].mustTeach;
      delEmpty(c.teacher[id]);
      if(Object.keys(c.teacher[id]||{}).length===0) delete c.teacher[id];
    });
    touchSaveDeferred();
    scheduleRememberCurrentFormSignature();
    refreshMustTeachGridCells(document.getElementById(PANEL_ID), teacherIds, keys);
    return true;
  }
  function handleMustTeachKeydown(ev){
    if(!ev || ev.repeat) return;
    const key=String(ev.key || '').toLowerCase();
    const applyMust=key==='x' && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    const code=String(ev.code || '').toLowerCase();
    const clearMust=key==='delete' || key==='del' || key==='backspace' || code==='delete' || code==='backspace';
    if(!applyMust && !clearMust) return;
    const target=ev.target;
    const tag=String(target?.tagName || '').toLowerCase();
    if(tag==='input' || tag==='textarea' || tag==='select' || target?.isContentEditable) return;
    if(state.section!=='teacher' || state.teacherRule!=='mustTeach') return;
    if(!document.getElementById(PANEL_ID)) return;
    if(!mustTeachSelectedSlots().length){
      const focused=target?.closest?.('[data-mt-toggle][data-slot]') || document.activeElement?.closest?.('[data-mt-toggle][data-slot]');
      const slot=String(focused?.dataset?.slot || '');
      if(slot) setMustTeachSingleSlot(slot);
    }
    if(!mustTeachSelectedSlots().length) return;
    ev.preventDefault();
    applyMustTeachSelectedSlots(applyMust);
  }
  function handleFixedOffKeydown(ev){
    if(!ev || ev.repeat) return;
    const key=String(ev.key || '').toLowerCase();
    const applyOff=key==='x' && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    const code=String(ev.code || '').toLowerCase();
    const clearOff=key==='delete' || key==='del' || key==='backspace' || code==='delete' || code==='backspace';
    if(!applyOff && !clearOff) return;
    const target=ev.target;
    const tag=String(target?.tagName || '').toLowerCase();
    if(tag==='input' || tag==='textarea' || tag==='select' || target?.isContentEditable) return;
    if(state.section!=='fixedOff') return;
    if(!document.getElementById(PANEL_ID)) return;
    if(!fixedOffSelectedSlots().length){
      const focused=target?.closest?.('[data-fo-toggle][data-slot]') || document.activeElement?.closest?.('[data-fo-toggle][data-slot]');
      const slot=String(focused?.dataset?.slot || '');
      if(slot) setFixedOffSingleSlot(slot);
    }
    if(!fixedOffSelectedSlots().length) return;
    const type=state.fixedType || 'class';
    const id=String(state.fixedSelected?.[type] || '');
    if(!id) return;
    ev.preventDefault();
    if(clearOff) clearFixedOffSelectedSlots(type,id);
    else applyFixedOffSelectedSlots(type,id,true);
  }
  function teacherMustTeachTopTable(id){
    const total=teacherTotalPeriodsForLimit(id);
    return `<div class="rb-fixedoff-titlebar"><h3>Giáo viên ${teacherShortHtml(id)}</h3><div class="rb-fixedoff-total">Tổng số tiết: ${total}</div></div>`;
  }
  function teacherMustTeachGrid(id){
    const rows=[];
    for(let i=0;i<sessionLen('sang');i++) rows.push({buoi:'sang',ti:i,sep:false});
    for(let i=0;i<sessionLen('chieu');i++) rows.push({buoi:'chieu',ti:i,sep:i===0});
    const slots=model().teacher?.[id]?.mustTeach || {};
    const selected=new Set(mustTeachSelectedSlots());
    return `<div class="rb-fixedoff-grid" style="--rb-grid-rows:${rows.length};--rb-grid-cols:${days().length}"><table><thead><tr>${days().map(d=>`<th>${esc(dayLabel(d)).toUpperCase()}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr class="${r.sep?'sep':''}">${days().map(d=>{ const sk=slotKey(d,r.buoi,r.ti); const checked=!!slots[sk]; const cls=[checked?'must':'',selected.has(sk)?'selected':''].filter(Boolean).join(' '); return `<td class="${cls}" data-mt-toggle="1" data-mt-id="${esc(id)}" data-slot="${esc(sk)}" tabindex="0"><span class="rb-must-text">X</span></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function renderTeacherMustTeach(title){
    const list=fixedOffListForType('teacher');
    if(!list.length) return `<h3>${esc(title||'Vị trí phải có tiết dạy')}</h3>${tableEmpty('Chưa có giáo viên.')}`;
    const selected=mustTeachPrimaryTeacherId(list);
    const selectedIds=new Set(mustTeachSelectedTeacherIds(list).map(String));
    return `<div class="rb-fixedoff-screen"><div class="rb-fixedoff-list">${list.map(it=>{ const id=String(it.id); return `<button type="button" class="rb-fixedoff-item ${selectedIds.has(id)?'active':''} ${id===String(selected)?'primary':''}" data-mt-select="${esc(id)}">${teacherShortHtml(id)}</button>`; }).join('')}</div><div class="rb-fixedoff-main">${teacherMustTeachTopTable(selected)}${teacherMustTeachGrid(selected)}</div></div>`;
  }
  function validateTeacherMustTeachBeforeSave(){
    const c=model();
    for(const [id,rule] of Object.entries(c.teacher || {})){
      if(rule && typeof rule === 'object' && rule.mustTeach && !validateTeacherMustTeachLimit(id, rule.mustTeach)) return false;
    }
    return true;
  }
  function fixedOffSlotChecked(type,id,thu,buoi,ti){
    if(type==='class'){
      const sk=slotKey(thu,buoi,ti);
      if(classUserOffHas(id,sk)) return true;
    }
    return isFixedOff(type,id,thu,buoi,ti);
  }
  function fixedOffTopRows(type,id){
    const idx=buildScheduleIndex();
    let cells=[];
    if(type==='class') cells=(idx.classCells.get(String(id))||[]).slice();
    else if(type==='teacher') cells=(idx.byTeacher.get(String(id))||[]).slice();
    else if(type==='subject') cells=(idx.allCells||[]).filter(c=>subjectMatches(c.mon,id));
    else if(type==='room') cells=(idx.allCells||[]).filter(c=>norm(c.room)===norm(id));
    else if(type==='subjectGroup'){
      const items=model().groups.subject?.[id]?.items||[];
      cells=(idx.allCells||[]).filter(c=>items.some(it=>subjectMatches(c.mon,it)));
    }
    const map=new Map();
    const keyOf = type==='class' ? (c=>norm(c.mon)) : type==='teacher' ? (c=>norm(c.mon)+'|'+String(c.lopId)) : type==='subject' ? (c=>String(c.lopId)) : type==='room' ? (c=>norm(c.mon)+'|'+String(c.lopId)) : (c=>norm(c.mon)+'|'+String(c.lopId));
    cells.forEach(c=>{
      const k=keyOf(c); if(!map.has(k)) map.set(k,{mon:c.mon, lopId:c.lopId, teacher:c.teacher, room:c.room, count:0});
      map.get(k).count += 1;
    });
    const rows=Array.from(map.values()).sort((a,b)=>String(a.mon||a.lopId).localeCompare(String(b.mon||b.lopId),'vi'));
    const s=cells.filter(c=>c.buoi==='sang').length, ch=cells.filter(c=>c.buoi==='chieu').length;
    return {rows,total:cells.length,s,c:ch,sc:0};
  }
  function summarizeFixedOffCells(type,cells){
    const map=new Map();
    const keyOf = type==='class' ? (c=>norm(c.mon)) : type==='teacher' ? (c=>norm(c.mon)+'|'+String(c.lopId)) : type==='subject' ? (c=>String(c.lopId)) : type==='room' ? (c=>norm(c.mon)+'|'+String(c.lopId)) : (c=>norm(c.mon)+'|'+String(c.lopId));
    (cells || []).forEach(c=>{
      const k=keyOf(c);
      if(!map.has(k)) map.set(k,{mon:c.mon, lopId:c.lopId, teacher:c.teacher, room:c.room, count:0});
      map.get(k).count += 1;
    });
    const rows=Array.from(map.values()).sort((a,b)=>String(a.mon||a.lopId).localeCompare(String(b.mon||b.lopId),'vi'));
    const s=(cells || []).filter(c=>c.buoi==='sang').length, ch=(cells || []).filter(c=>c.buoi==='chieu').length;
    return {rows,total:(cells || []).length,s,c:ch,sc:0};
  }
  function assignmentTopRowsForType(type,id){
    const targetLop=findClassObject(id);
    let source=pccmAssignmentRows().filter(r=>{
      if(type==='class') return classMatchesAssignment(id, r.cls, targetLop, r.lop);
      if(type==='teacher') return String(r.teacher || '').trim()===String(id || '').trim();
      if(type==='subject') return subjectMatches(r.rawMon || r.mon, id);
      if(type==='room') return norm(r.room)===norm(id);
      if(type==='subjectGroup'){
        const items=model().groups.subject?.[id]?.items || [];
        return items.some(it=>subjectMatches(r.rawMon || r.mon, it));
      }
      return false;
    });
    const map=new Map();
    const keyOf = type==='class' ? (r=>norm(r.rawMon || r.mon)) : type==='teacher' ? (r=>norm(r.rawMon || r.mon)+'|'+String(r.classId)) : type==='subject' ? (r=>String(r.classId)) : type==='room' ? (r=>norm(r.rawMon || r.mon)+'|'+String(r.classId)) : (r=>norm(r.rawMon || r.mon)+'|'+String(r.classId));
    source.forEach(r=>{
      const k=keyOf(r);
      if(!map.has(k)) map.set(k,{mon:r.mon, lopId:r.classId, teacher:r.teacher, room:r.room, count:0, lop:r.lop});
      map.get(k).count += Number(r.count || 0);
    });
    const rows=Array.from(map.values()).sort((a,b)=>String(a.mon||a.lopId).localeCompare(String(b.mon||b.lopId),'vi'));
    let s=0, ch=0, sc=0;
    rows.forEach(r=>{
      const n=Number(r.count || 0);
      const shift=classShiftCode(r.lop || findClassObject(r.lopId));
      if(shift==='S') s+=n;
      else if(shift==='C') ch+=n;
      else sc+=n;
    });
    return {rows,total:rows.reduce((sum,r)=>sum+Number(r.count || 0),0),s,c:ch,sc};
  }
  function fixedOffTopRows(type,id){
    const idx=buildScheduleIndex();
    let cells=[];
    if(type==='class') cells=(idx.classCells.get(String(id))||[]).slice();
    else if(type==='teacher') cells=(idx.byTeacher.get(String(id))||[]).slice();
    else if(type==='subject') cells=(idx.allCells||[]).filter(c=>subjectMatches(c.mon,id));
    else if(type==='room') cells=(idx.allCells||[]).filter(c=>norm(c.room)===norm(id));
    else if(type==='subjectGroup'){
      const items=model().groups.subject?.[id]?.items||[];
      cells=(idx.allCells||[]).filter(c=>items.some(it=>subjectMatches(c.mon,it)));
    }
    if(cells.length) return summarizeFixedOffCells(type,cells);
    return assignmentTopRowsForType(type,id);
  }
  function fixedOffTopTable(type,id){
    const meta=fixedOffTopRows(type,id);
    return `<div class="rb-fixedoff-titlebar"><h3>${esc(fixedOffDisplayName(type,id))}</h3><div class="rb-fixedoff-total">Tổng số tiết: ${Number(meta.total || 0)}</div></div>`;
  }
  function fixedOffGrid(type,id){
    const rows=fixedOffGridRows().map((r,i)=>Object.assign({sep:i===sessionLen('sang')},r));
    const selected=new Set(fixedOffSelectedSlots().map(String));
    return `<div class="rb-fixedoff-grid" style="--rb-grid-rows:${rows.length};--rb-grid-cols:${days().length}"><table><thead><tr>${days().map(d=>`<th>${esc(dayLabel(d)).toUpperCase()}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr class="${r.sep?'sep':''}">${days().map(d=>{ const sk=slotKey(d,r.buoi,r.ti); const checked=fixedOffSlotChecked(type,id,d,r.buoi,r.ti); const fixedMon=type==='class' ? fixedLessonAt(id,d,r.buoi,r.ti) : ''; const cls=[checked?'off':'',fixedMon?'lesson':'',selected.has(sk)?'selected':''].filter(Boolean).join(' '); const title=fixedMon ? `Tiết cố định: ${subjectDisplayName(fixedMon)}` : ''; return `<td class="${cls}" data-fo-toggle="1" data-off-type="${esc(type)}" data-off-id="${esc(id)}" data-slot="${esc(sk)}" tabindex="0" title="${esc(title)}"><span class="rb-off-text">Nghỉ</span><span class="rb-fixed-lesson-text">${esc(subjectSortCode(fixedMon) || fixedMon)}</span></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function fixedOffListLabel(type, item){
    const id=String(item?.id || '');
    if(type==='teacher') return teacherShortHtml(id);
    if(type==='subject'){
      const full=String(subjectDisplayName(id) || item?.name || id).trim();
      const short=String(subjectSortCode(id) || item?.name || id).trim();
      return `<span class="rb-fixedoff-short" title="${esc(full)}">${esc(short || full)}</span>`;
    }
    return esc(item?.name || id);
  }
  function fixedOffExcelToolbar(type){
    return '';
  }
  function renderFixedOff(type){
    const list=fixedOffListForType(type);
    if(!list.length) return `<h3>${esc(fixedOffTitle(type))}</h3>${tableEmpty('Chưa có dữ liệu nền.')}`;
    const selected=ensureFixedSelected(type,list);
    const selectedIds = fixedOffMultiSelectEnabled(type) ? new Set(fixedOffSelectedIds(type,list).map(String)) : null;
    const items=list.map(it=>{
      const id=String(it.id);
      const isActive=selectedIds ? selectedIds.has(id) : id===String(selected);
      const isPrimary=fixedOffMultiSelectEnabled(type) && id===String(selected);
      return `<button type="button" class="rb-fixedoff-item ${isActive?'active':''} ${isPrimary?'primary':''}" data-fo-select="${esc(it.id)}">${fixedOffListLabel(type,it)}</button>`;
    }).join('');
    return `<div class="rb-fixedoff-screen"><div class="rb-fixedoff-list">${items}</div><div class="rb-fixedoff-main">${fixedOffExcelToolbar(type)}${fixedOffTopTable(type,selected)}${fixedOffGrid(type,selected)}</div></div>`;
  }
  function renderFixedOffGroupSubject(){ return renderFixedOff('subjectGroup'); }
  function timeLimitGroupId(type, index){ return `tl_${type}_g${index}`; }
  function timeLimitGroupIds(type){ return Array.from({length:TIME_LIMIT_GROUP_COUNT},(_,i)=>timeLimitGroupId(type,i+1)); }
  function timeLimitGroupIndex(type, id){ const m=String(id||'').match(new RegExp('^tl_'+type+'_g(\\d+)$')); return m ? Number(m[1]) : 0; }
  function timeLimitGroupName(type, index){ return `Nhóm ${index}`; }
  function timeLimitGroupTypeLabel(type){ return ({class:'Nhóm lớp', subject:'Nhóm môn học'})[type] || 'Nhóm'; }
  function timeLimitItemLabel(type){ return ({class:'Lớp học', teacher:'Giáo viên', subject:'Môn học'})[type] || 'Dữ liệu'; }
  function timeLimitTargetType(type){ return ({class:'classGroup', teacher:'teacherGroup', subject:'subjectGroup'})[type] || 'teacherGroup'; }
  function timeLimitField(type){ return ({class:'classes', teacher:'teachers', subject:'subjects'})[type] || 'teachers'; }
  function timeLimitFieldLabel(type){ return ({class:'Lớp/1 thời điểm', teacher:'GV/1 thời điểm', subject:'Môn/1 thời điểm'})[type] || 'Giới hạn'; }
  function timeLimitTypeFromTarget(targetType){ return ({classGroup:'class', teacherGroup:'teacher', subjectGroup:'subject'})[targetType] || ''; }
  function timeLimitTypeFromView(view){
    const v=String(view || '');
    if(v==='groups-class') return 'class';
    if(v==='groups-subject') return 'subject';
    return '';
  }
  function timeLimitTabDefs(){
    return [['groups-class','Tạo nhóm lớp'],['groups-subject','Tạo nhóm môn học'],['limits','Giới hạn']];
  }
  function timeLimitToolbarTabs(active){
    const current=String(active || 'limits');
    return timeLimitTabDefs().map(([view,label])=>`<button type="button" class="rb-tool ${current===view?'primary active':''}" data-tl-view="${esc(view)}"><span>${esc(label)}</span></button>`).join('');
  }
  function timeLimitViewTabs(active){
    const panel=document.getElementById(PANEL_ID);
    if(panel?.classList?.contains('rb-time-limit-page')) return '';
    const tabs=timeLimitTabDefs();
    return `<div class="toolbar rb-time-tabs">${tabs.map(([view,label])=>`<button type="button" class="${String(active)===view?'active':''}" data-tl-view="${esc(view)}">${esc(label)}</button>`).join('')}</div>`;
  }
  function timeLimitGroupsForType(type){
    const groups=model().groups[type] || {};
    return Object.entries(groups).map(([id,g])=>({
      type,
      id,
      index: timeLimitGroupIndex(type,id),
      name: String(g?.name || ''),
      items: Array.isArray(g?.items) ? g.items : []
    })).filter(g=>g.index > 0 && g.items.length > 0).sort((a,b)=>a.index-b.index);
  }
  function timeLimitAllGroups(){
    return ['class','subject'].flatMap(type=>timeLimitGroupsForType(type));
  }
  function timeLimitRuleIndex(targetType, targetId){
    const c=model();
    return (c.timeLimit || []).findIndex(r=>String(r?.targetType || '')===String(targetType) && String(r?.targetId || '')===String(targetId));
  }
  function timeLimitRuleFor(type, groupId, create){
    const c=model();
    c.timeLimit = Array.isArray(c.timeLimit) ? c.timeLimit : [];
    const targetType=timeLimitTargetType(type);
    let idx=timeLimitRuleIndex(targetType, groupId);
    if(idx < 0 && create){
      const group=model().groups[type]?.[groupId] || {};
      c.timeLimit.push({name:String(group.name || groupId), targetType, targetId:groupId, perSlot:{}, perSlotBySession:{}});
      idx=c.timeLimit.length-1;
    }
    return idx >= 0 ? c.timeLimit[idx] : null;
  }
  function timeLimitRuleHasPositiveLimit(rule){
    function walk(v){
      if(v == null || v === '') return false;
      if(typeof v === 'number') return Number(v) > 0;
      if(typeof v === 'string') return Number(v) > 0;
      if(Array.isArray(v)) return v.some(walk);
      if(typeof v === 'object') return Object.values(v).some(walk);
      return false;
    }
    return walk(rule?.perSlot) || walk(rule?.perSession) || walk(rule?.perSlotBySession);
  }
  function pruneEmptyTimeLimitRules(){
    const c=model();
    c.timeLimit=(c.timeLimit || []).filter(r=>timeLimitRuleHasPositiveLimit(r));
  }
  function timeLimitCellValue(rule, type, buoi, thu){
    const field=timeLimitField(type);
    let val=getPath(rule, `perSlotBySession.${field}.${buoi}.${thu}`, null);
    if(val != null && val !== '') return val;
    val=getPath(rule, `perSlotBySession.${buoi}.${thu}`, null);
    if(val != null && val !== '') return val;
    val=getPath(rule, `perSlot.${field}`, '');
    if((val == null || val === '') && field==='subjects') val=getPath(rule, 'perSlot.classes', '');
    return val == null ? '' : val;
  }
  function renderTimeLimitGroupBuilder(type){
    const items=listByType(type);
    const groupIds=timeLimitGroupIds(type);
    const groups=model().groups[type] || {};
    const itemLabel=timeLimitItemLabel(type);
    return `${timeLimitViewTabs('groups-'+type)}
      <div class="table-wrap rb-nss-table rb-time-group-table">
        <table>
          <thead><tr><th>${esc(itemLabel)}</th>${groupIds.map((gid,i)=>`<th>${esc(timeLimitGroupName(type,i+1))}</th>`).join('')}</tr></thead>
          <tbody>${items.map(item=>`<tr><td><b>${esc(item.name || item.id)}</b></td>${groupIds.map(gid=>`<td class="rb-check"><input type="checkbox" data-tlg-type="${esc(type)}" data-tlg-group="${esc(gid)}" data-tlg-item="${esc(item.id)}" ${(groups[gid]?.items || []).map(String).includes(String(item.id))?'checked':''}></td>`).join('')}</tr>`).join('') || `<tr><td colspan="${groupIds.length+1}" class="muted">Chưa có ${esc(itemLabel.toLowerCase())}.</td></tr>`}</tbody>
        </table>
      </div>`;
  }
  function renderTimeLimitLimits(){
    const groups=timeLimitAllGroups();
    if(!groups.length) return `${timeLimitViewTabs('limits')}<div class="hint">Chưa có nhóm giới hạn.</div>`;
    const validKey=new Set(groups.map(g=>g.type+'|'+g.id));
    let selectedType=state.timeLimitLimitType || groups[0].type;
    let selectedId=state.timeLimitLimitGroupId || groups[0].id;
    if(!validKey.has(selectedType+'|'+selectedId)){
      selectedType=groups[0].type;
      selectedId=groups[0].id;
      state.timeLimitLimitType=selectedType;
      state.timeLimitLimitGroupId=selectedId;
    }
    const selected=groups.find(g=>g.type===selectedType && g.id===selectedId) || groups[0];
    const rule=timeLimitRuleFor(selected.type, selected.id, false) || {};
    const field=timeLimitField(selected.type);
    const list=groups.map(g=>`<button type="button" class="${g.type===selected.type&&g.id===selected.id?'active':''}" data-tll-select-type="${esc(g.type)}" data-tll-select-id="${esc(g.id)}"><b>${esc(g.name || timeLimitGroupName(g.type,g.index))}</b><span>${esc(timeLimitGroupTypeLabel(g.type))} · ${esc(String(g.items.length))}</span></button>`).join('');
    const cells=buoi=>days().map(d=>`<td><input type="number" ${numberInputClass()} min="0" data-tll-type="${esc(selected.type)}" data-tll-target-id="${esc(selected.id)}" data-tll-field="${esc(field)}" data-tll-buoi="${esc(buoi)}" data-tll-day="${esc(d)}" value="${esc(timeLimitCellValue(rule, selected.type, buoi, d))}"></td>`).join('');
    return `${timeLimitViewTabs('limits')}
      <div class="rb-time-limit-editor">
        <aside class="rb-time-limit-list">${list}</aside>
        <div class="rb-time-limit-main">
          <div class="table-wrap rb-desktop-wrap">
            <table class="rb-desktop-table">
              <thead><tr><th rowspan="2">Nhóm</th><th rowspan="2">${esc(timeLimitFieldLabel(selected.type))}</th><th colspan="${days().length}">Buổi sáng</th><th colspan="${days().length}">Buổi chiều</th></tr><tr>${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}${days().map(d=>`<th>${shortDayLabel(d)}</th>`).join('')}</tr></thead>
              <tbody><tr><td class="rb-name"><b>${esc(selected.name || timeLimitGroupName(selected.type, selected.index))}</b><div class="muted">${esc(timeLimitGroupTypeLabel(selected.type))} · ${esc(String(selected.items.length))}</div></td><td>${esc(timeLimitFieldLabel(selected.type))}</td>${cells('sang')}${cells('chieu')}</tr></tbody>
            </table>
          </div>
        </div>
      </div>`;
  }
  function renderTimeLimit(){
    const view=String(state.timeLimitView || 'limits');
    const type=timeLimitTypeFromView(view);
    if(type) return renderTimeLimitGroupBuilder(type);
    state.timeLimitView='limits';
    return renderTimeLimitLimits();
  }

  /* ===================== SAVE UI ===================== */
  function checkboxMatchesFilter(box, filter){
    const f=String(filter||'');
    if(!f) return true;
    const path=String(box?.dataset?.path || '');
    if(f.startsWith('path:')) return path === f.slice(5);
    if(f==='morning') return /\.morning(?:\.|$)/.test(path) || /\.allowMorning(?:\.|$)/.test(path) || /\.sang(?:\.|$)/.test(path);
    if(f==='afternoon') return /\.afternoon(?:\.|$)/.test(path) || /\.allowAfternoon(?:\.|$)/.test(path) || /\.chieu(?:\.|$)/.test(path);
    if(f==='enabled') return /\.enabled$/.test(path);
    if(f==='oneSession') return /\.oneSessionPerDay$/.test(path);
    return true;
  }
  function checkboxTargetsForMaster(master){
    const scope=master?.dataset?.rbCheckAll || '';
    const container=master.closest('[data-rb-check-scope]') || document.getElementById(PANEL_ID);
    const filter=master?.dataset?.rbCheckFilter || '';
    let boxes;
    if(scope === 'groupItems') boxes = Array.from((document.getElementById(PANEL_ID) || document).querySelectorAll('[data-rb-group-items] input[type="checkbox"]'));
    else boxes = Array.from((container || document).querySelectorAll('input[type="checkbox"][data-tid][data-path], input[type="checkbox"][data-cid][data-path]'));
    return boxes.filter(box=>checkboxMatchesFilter(box,filter));
  }
  function fastSaveCheckboxTargets(boxes){
    const c=model();
    const container=(state.section==='subject')?getRuleContainer(false):(state.section==='subjectGroup'?getRuleContainer(true):null);
    let changed=false;
    (boxes || []).forEach(el=>{
      if(!el) return;
      if(el.matches('input[type="checkbox"][data-tid][data-path]')){
        const tid=el.dataset.tid, path=el.dataset.path;
        c.teacher[tid]=c.teacher[tid]||{};
        setPath(c.teacher[tid],path,!!el.checked);
        delEmpty(c.teacher[tid]);
        if(Object.keys(c.teacher[tid]).length===0) delete c.teacher[tid];
        changed=true;
        return;
      }
      if(el.matches('input[type="checkbox"][data-cid][data-path]') && container){
        const cid=el.dataset.cid, path=el.dataset.path;
        container.byClass=container.byClass||{};
        container.byClass[cid]=container.byClass[cid]||{};
        setPath(container.byClass[cid],path,!!el.checked);
        if(path.startsWith('avoidBreakPair23.')||path.startsWith('avoidBreakPair34.')) delete container.byClass[cid].avoidBreakPairs;
        if(path.startsWith('linkedDays.')) normalizeLinkedDaysRow(container.byClass[cid]);
        if(path.startsWith('sessionAllowed.')) normalizeSessionAllowedRow(container.byClass[cid]);
        delEmpty(container.byClass[cid]);
        if(Object.keys(container.byClass[cid]).length===0) delete container.byClass[cid];
        changed=true;
      }
    });
    if(!changed) return false;
    touchSave();
    scheduleRememberCurrentFormSignature();
    return true;
  }
  function autoSaveGroupFromUI(){
    if(state.section !== 'groups') return false;
    const root=document.getElementById(PANEL_ID);
    const name=String(root?.querySelector('[data-rb-group-name]')?.value || '').trim();
    if(!name) return false;
    return saveGroupFromUI(false,{releaseExisting:false}) !== false;
  }
  function updateCheckAllMaster(master){
    const boxes=checkboxTargetsForMaster(master);
    const checked=boxes.filter(box=>box.checked).length;
    master.checked = boxes.length > 0 && checked === boxes.length;
    master.indeterminate = checked > 0 && checked < boxes.length;
    master.disabled = boxes.length === 0;
  }
  function refreshCheckAllMasters(root){
    (root || document).querySelectorAll('[data-rb-check-all]').forEach(updateCheckAllMaster);
  }
  function bindCheckAllControls(root){
    root.querySelectorAll('[data-rb-check-all]').forEach(master=>{
      updateCheckAllMaster(master);
      master.onchange=()=>{
        const boxes=checkboxTargetsForMaster(master);
        const checked=!!master.checked;
        boxes.forEach(box=>{ box.checked=checked; });
        enforceSessionAllowedInputs(root, master);
        if((master.dataset.rbCheckAll || '') === 'fields'){
          if(!fastSaveCheckboxTargets(boxes)) saveCurrentFromUI(false, {releaseExisting:false});
        }else if((master.dataset.rbCheckAll || '') === 'groupItems'){
          autoSaveGroupFromUI();
        }
        refreshCheckAllMasters(root);
      };
    });
    root.querySelectorAll('input[type="checkbox"][data-tid][data-path], input[type="checkbox"][data-cid][data-path], [data-rb-group-items] input[type="checkbox"]').forEach(box=>{
      box.addEventListener('change',()=>{
        enforceSessionAllowedInputs(root, box);
        if(box.closest?.('[data-rb-group-items]')) autoSaveGroupFromUI();
        refreshCheckAllMasters(root);
      });
    });
    root.querySelectorAll('[data-rb-grid-all="mustTeach"][data-mt-id]').forEach(master=>{
      const id=master.dataset.mtId || '';
      const selected=teacherMustTeachCount(id);
      const total=allSlotKeysForGrid().length;
      master.checked=total > 0 && selected === total;
      master.indeterminate=selected > 0 && selected < total;
      master.onchange=()=>{
        const checked=!!master.checked;
        if(!setTeacherMustTeachAll(id,checked)){
          const nextSelected=teacherMustTeachCount(id);
          const nextTotal=allSlotKeysForGrid().length;
          master.checked=nextTotal > 0 && nextSelected === nextTotal;
          master.indeterminate=nextSelected > 0 && nextSelected < nextTotal;
          return;
        }
        touchSave();
        render();
      };
    });
    root.querySelectorAll('[data-rb-grid-session="mustTeach"][data-mt-id][data-buoi]').forEach(master=>{
      const id=master.dataset.mtId || '';
      const keys=slotKeysForGrid(master.dataset.buoi || '');
      const slots=model().teacher?.[id]?.mustTeach || {};
      const selected=keys.filter(key=>!!slots[key]).length;
      master.checked=keys.length > 0 && selected === keys.length;
      master.indeterminate=selected > 0 && selected < keys.length;
      master.onchange=()=>{
        const checked=!!master.checked;
        if(!setTeacherMustTeachKeys(id,keys,checked)){
          const nextSlots=model().teacher?.[id]?.mustTeach || {};
          const nextSelected=keys.filter(key=>!!nextSlots[key]).length;
          master.checked=keys.length > 0 && nextSelected === keys.length;
          master.indeterminate=nextSelected > 0 && nextSelected < keys.length;
          return;
        }
        touchSave();
        render();
      };
    });
    root.querySelectorAll('[data-rb-grid-all="fixedOff"][data-off-type][data-off-id]').forEach(master=>{
      const type=master.dataset.offType || '';
      const id=master.dataset.offId || '';
      const keys=allSlotKeysForGrid();
      const selected=keys.filter(key=>{ const p=parseSlotKey(key); return fixedOffSlotChecked(type,id,p.thu,p.buoi,p.ti); }).length;
      master.checked=keys.length > 0 && selected === keys.length;
      master.indeterminate=selected > 0 && selected < keys.length;
      master.onchange=()=>{
        const checked=!!master.checked;
        const keys=allSlotKeysForGrid();
        fixedOffApplyIds(type,id).forEach(targetId=>setFixedOffKeysFlag(type,targetId,keys,checked));
        touchSave();
        if(checked) releaseExistingViolationsAfterSave();
        if(type==='class'){
          scheduleRerenderSafe();
          render();
        }else{
          refreshFixedOffGridCells(root,type,id,keys);
          refreshFixedOffGridMasters(root,type,id);
        }
      };
    });
    root.querySelectorAll('[data-rb-grid-session="fixedOff"][data-off-type][data-off-id][data-buoi]').forEach(master=>{
      const type=master.dataset.offType || '';
      const id=master.dataset.offId || '';
      const keys=slotKeysForGrid(master.dataset.buoi || '');
      const selected=keys.filter(key=>{ const p=parseSlotKey(key); return fixedOffSlotChecked(type,id,p.thu,p.buoi,p.ti); }).length;
      master.checked=keys.length > 0 && selected === keys.length;
      master.indeterminate=selected > 0 && selected < keys.length;
      master.onchange=()=>{
        const checked=!!master.checked;
        fixedOffApplyIds(type,id).forEach(targetId=>setFixedOffKeysFlag(type,targetId,keys,checked));
        touchSave();
        if(checked) releaseExistingViolationsAfterSave();
        if(type==='class'){
          scheduleRerenderSafe();
          render();
        }else{
          refreshFixedOffGridCells(root,type,id,keys);
          refreshFixedOffGridMasters(root,type,id);
        }
      };
    });
  }
  function rbNumKey(info){
    if(!info) return '';
    return `${info.table}|${Number(info.r)}|${Number(info.c)}`;
  }
  function rbNumInfo(input){
    if(!input) return null;
    const table=String(input.dataset.rbNumTable || '');
    const r=Number(input.dataset.rbNumR);
    const c=Number(input.dataset.rbNumC);
    if(!table || !Number.isFinite(r) || !Number.isFinite(c)) return null;
    return {table,r,c};
  }
  function rbNumPanelRoot(){
    return document.getElementById(PANEL_ID);
  }
  function rbNumInputs(root){
    return Array.from((root || rbNumPanelRoot() || document).querySelectorAll('input.rb-num-cell-input[data-rb-num-cell]'));
  }
  function rbNumGetInput(info){
    const root=rbNumPanelRoot();
    if(!root || !info) return null;
    return rbNumInputs(root).find(input=>{
      const cur=rbNumInfo(input);
      return cur && cur.table===info.table && cur.r===Number(info.r) && cur.c===Number(info.c);
    }) || null;
  }
  function rbNumUpdateSelectionUI(root){
    rbNumInputs(root).forEach(input=>{
      const info=rbNumInfo(input);
      const key=rbNumKey(info);
      const td=input.closest('td');
      if(td) td.classList.add('rb-num-cell-host');
      const selected=!!key && rbNumSelection.has(key);
      const anchor=!!(info && rbNumAnchor && info.table===rbNumAnchor.table && info.r===rbNumAnchor.r && info.c===rbNumAnchor.c);
      input.classList.toggle('rb-num-selected-input', selected);
      if(td){
        td.classList.toggle('rb-num-selected', selected);
        td.classList.toggle('rb-num-anchor', anchor);
      }
    });
  }
  function rbNumClearSelection(root){
    rbNumSelection=new Set();
    rbNumAnchor=null;
    rbNumDragStart=null;
    rbNumDragging=false;
    rbNumUpdateSelectionUI(root);
  }
  function rbNumSetSingle(info, focusInput){
    if(!info) return;
    rbNumSelection=new Set([rbNumKey(info)]);
    rbNumAnchor={table:info.table,r:Number(info.r),c:Number(info.c)};
    rbNumUpdateSelectionUI();
    if(focusInput){
      const input=rbNumGetInput(info);
      try{ input?.focus({preventScroll:true}); }catch(_){ try{ input?.focus(); }catch(__){} }
      try{ input?.select(); }catch(_){}
    }
  }
  function rbNumToggle(info){
    if(!info) return;
    if(rbNumAnchor && rbNumAnchor.table !== info.table){
      rbNumSetSingle(info,true);
      return;
    }
    const key=rbNumKey(info);
    if(rbNumSelection.has(key)) rbNumSelection.delete(key);
    else rbNumSelection.add(key);
    rbNumAnchor={table:info.table,r:Number(info.r),c:Number(info.c)};
    rbNumUpdateSelectionUI();
  }
  function rbNumSelectRange(a,b,keepAnchor){
    if(!a || !b || a.table !== b.table){
      rbNumSetSingle(b,true);
      return;
    }
    const r1=Math.min(Number(a.r),Number(b.r));
    const r2=Math.max(Number(a.r),Number(b.r));
    const c1=Math.min(Number(a.c),Number(b.c));
    const c2=Math.max(Number(a.c),Number(b.c));
    const next=new Set();
    for(let r=r1;r<=r2;r++){
      for(let c=c1;c<=c2;c++){
        const info={table:a.table,r,c};
        if(rbNumGetInput(info)) next.add(rbNumKey(info));
      }
    }
    rbNumSelection=next;
    if(!keepAnchor) rbNumAnchor={table:b.table,r:Number(b.r),c:Number(b.c)};
    rbNumUpdateSelectionUI();
  }
  function rbNumSelectionRect(){
    if(!rbNumSelection || !rbNumSelection.size) return null;
    let table='', minR=1e9, maxR=-1e9, minC=1e9, maxC=-1e9;
    rbNumSelection.forEach(key=>{
      const parts=String(key || '').split('|');
      const t=parts[0] || '';
      const r=Number(parts[1]);
      const c=Number(parts[2]);
      if(!t || !Number.isFinite(r) || !Number.isFinite(c)) return;
      if(table && table !== t) return;
      table=t;
      minR=Math.min(minR,r); maxR=Math.max(maxR,r);
      minC=Math.min(minC,c); maxC=Math.max(maxC,c);
    });
    if(!table || minR>maxR || minC>maxC) return null;
    return {table,minR,maxR,minC,maxC};
  }
  function rbNumCellValue(input){
    return input ? String(input.value ?? '') : '';
  }
  function rbNumBuildCopyText(){
    const rect=rbNumSelectionRect();
    if(!rect) return '';
    const lines=[];
    for(let r=rect.minR;r<=rect.maxR;r++){
      const row=[];
      for(let c=rect.minC;c<=rect.maxC;c++){
        const info={table:rect.table,r,c};
        const key=rbNumKey(info);
        const input=rbNumGetInput(info);
        row.push(input && rbNumSelection.has(key) ? rbNumCellValue(input) : '');
      }
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  }
  function rbNumNormalizePasteValue(value){
    const raw=String(value ?? '').trim();
    if(!raw) return '';
    const n=Number(raw.replace(',', '.'));
    return Number.isFinite(n) ? String(Math.max(0, Math.round(n))) : '';
  }
  function rbNumSetInputValue(input,value){
    if(!input) return false;
    input.value=rbNumNormalizePasteValue(value);
    return true;
  }
  function applyLessonBlockBulkFill(root,path,value){
    const scope=root || rbNumPanelRoot();
    const targetPath=String(path || '');
    if(!scope || !targetPath) return 0;
    const normalized=rbNumNormalizePasteValue(value);
    let changed=0;
    scope.querySelectorAll('[data-cid][data-path]').forEach(input=>{
      if(String(input.dataset.path || '') !== targetPath) return;
      input.value=normalized;
      changed+=1;
    });
    return changed;
  }
  function rbNumParseClipboard(text){
    const raw=String(text ?? '').replace(/\r/g,'');
    if(!raw) return [];
    const lines=raw.split('\n');
    if(lines.length && lines[lines.length-1] === '') lines.pop();
    return lines.map(line=>line.split('\t'));
  }
  function rbNumCommitGridEdit(){
    try{ saveCurrentFromUI(false,{releaseExisting:false}); }catch(_){}
    try{ scheduleRememberCurrentFormSignature(); }catch(_){}
  }
  function rbNumPasteMatrix(matrix){
    const rect=rbNumSelectionRect();
    if(!rect || !Array.isArray(matrix) || !matrix.length) return;
    if(matrix.length === 1 && (matrix[0] || []).length === 1 && rbNumSelection.size > 1){
      const value=matrix[0][0];
      rbNumSelection.forEach(key=>{
        const parts=String(key || '').split('|');
        rbNumSetInputValue(rbNumGetInput({table:parts[0],r:Number(parts[1]),c:Number(parts[2])}), value);
      });
      rbNumCommitGridEdit();
      rbNumUpdateSelectionUI();
      return;
    }
    for(let i=0;i<matrix.length;i++){
      const row=matrix[i] || [];
      for(let j=0;j<row.length;j++){
        rbNumSetInputValue(rbNumGetInput({table:rect.table,r:rect.minR+i,c:rect.minC+j}), row[j]);
      }
    }
    rbNumCommitGridEdit();
    rbNumUpdateSelectionUI();
  }
  function rbNumClearSelectedCells(){
    if(!rbNumSelection.size) return;
    rbNumSelection.forEach(key=>{
      const parts=String(key || '').split('|');
      rbNumSetInputValue(rbNumGetInput({table:parts[0],r:Number(parts[1]),c:Number(parts[2])}), '');
    });
    rbNumCommitGridEdit();
    rbNumUpdateSelectionUI();
  }
  function rbNumMouseDown(ev,input){
    try{
      if(!ev || !input || ev.button !== 0) return;
      const info=rbNumInfo(input);
      if(!info) return;
      if(ev.shiftKey && rbNumAnchor) rbNumSelectRange(rbNumAnchor, info);
      else if(ev.ctrlKey || ev.metaKey) rbNumToggle(info);
      else rbNumSetSingle(info,false);
      rbNumDragging=true;
      rbNumDragStart=info;
      try{ ev.preventDefault(); }catch(_){}
      try{ window.getSelection?.()?.removeAllRanges?.(); }catch(_){}
      try{ input.focus({preventScroll:true}); }catch(_){ try{ input.focus(); }catch(__){} }
      try{ input.select(); }catch(_){}
    }catch(_){}
  }
  function rbNumMouseOver(ev,input){
    try{
      if(!rbNumDragging || !rbNumDragStart || !input) return;
      const info=rbNumInfo(input);
      if(!info) return;
      rbNumSelectRange(rbNumDragStart, info, true);
      try{ ev?.preventDefault?.(); }catch(_){}
    }catch(_){}
  }
  function rbNumIsActive(){
    const root=rbNumPanelRoot();
    return !!(root && rbNumSelection && rbNumSelection.size && root.querySelector('input.rb-num-cell-input[data-rb-num-cell]'));
  }
  function rbNumEventInsidePanel(ev){
    const root=rbNumPanelRoot();
    if(!root) return false;
    const target=ev?.target;
    const active=document.activeElement;
    return (!!target && root.contains(target)) || (!!active && root.contains(active));
  }
  function rbNumGlobalCopy(ev){
    try{
      if(!rbNumIsActive()) return;
      if(!rbNumEventInsidePanel(ev)) return;
      const text=rbNumBuildCopyText();
      if(!text) return;
      ev.clipboardData?.setData('text/plain', text);
      ev.preventDefault();
    }catch(_){}
  }
  function rbNumGlobalPaste(ev){
    try{
      if(!rbNumIsActive()) return;
      if(!rbNumEventInsidePanel(ev)) return;
      const text=(ev.clipboardData || window.clipboardData)?.getData('text');
      if(typeof text !== 'string') return;
      const matrix=rbNumParseClipboard(text);
      if(!matrix.length) return;
      ev.preventDefault();
      rbNumPasteMatrix(matrix);
    }catch(_){}
  }
  function rbNumGlobalKeydown(ev){
    try{
      if(!rbNumIsActive()) return;
      if(!rbNumEventInsidePanel(ev)) return;
      const key=String(ev.key || '').toLowerCase();
      if(key === 'escape'){
        ev.preventDefault();
        rbNumClearSelection();
        return;
      }
      if((key === 'delete' || key === 'backspace') && rbNumSelection.size > 1){
        ev.preventDefault();
        rbNumClearSelectedCells();
      }
    }catch(_){}
  }
  function rbNumEnsureGlobalHandlers(){
    if(rbNumBound) return;
    rbNumBound=true;
    document.addEventListener('mouseup',()=>{ rbNumDragging=false; rbNumDragStart=null; },true);
    document.addEventListener('copy',rbNumGlobalCopy,true);
    document.addEventListener('paste',rbNumGlobalPaste,true);
    document.addEventListener('keydown',rbNumGlobalKeydown,true);
  }
  function bindNumberCellGrid(root){
    const inputs=rbNumInputs(root);
    if(!inputs.length) return;
    rbNumEnsureGlobalHandlers();
    rbNumSelection=new Set();
    rbNumAnchor=null;
    rbNumDragStart=null;
    rbNumDragging=false;
    const tables=Array.from(new Set(inputs.map(input=>input.closest('table')).filter(Boolean)));
    tables.forEach((table,tableIndex)=>{
      const tableId=`t${tableIndex}`;
      rbNumInputs(table).forEach(input=>{
        const td=input.closest('td');
        const tr=input.closest('tr');
        if(!td || !tr) return;
        td.classList.add('rb-num-cell-host');
        input.dataset.rbNumTable=tableId;
        input.dataset.rbNumR=String(tr.rowIndex);
        input.dataset.rbNumC=String(td.cellIndex);
        input.onmousedown=ev=>rbNumMouseDown(ev,input);
        input.onmouseover=ev=>rbNumMouseOver(ev,input);
        input.ondblclick=()=>{ try{ input.focus({preventScroll:true}); }catch(_){ try{ input.focus(); }catch(__){} } try{ input.select(); }catch(_){} };
        input.onfocus=()=>{ const info=rbNumInfo(input); if(info && !rbNumSelection.has(rbNumKey(info))) rbNumSetSingle(info,false); };
        input.onchange=()=>rbNumCommitGridEdit();
      });
    });
    rbNumUpdateSelectionUI(root);
  }
  function bindBodyEvents(){ const root=document.getElementById(PANEL_ID); if(!root) return;
    bindCheckAllControls(root);
    root.querySelectorAll('[data-rb-lesson-block-fill]').forEach(master=>{
      master.oninput=()=>{
        const count=applyLessonBlockBulkFill(root,master.dataset.rbLessonBlockFill,master.value);
        if(!count) return;
        rbNumCommitGridEdit();
        rbNumUpdateSelectionUI(root);
      };
    });
    const fixedList=root.querySelector('.rb-fixedoff-list');
    if(fixedList){
      const key=fixedOffListScrollKey();
      const stored=state.fixedOffListScroll?.[key];
      if(stored) restoreFixedOffListScroll(stored,key);
      fixedList.onscroll=()=>rememberFixedOffListScroll(fixedList,key);
      fixedList.querySelectorAll('[data-mt-select],[data-fo-select]').forEach(b=>{
        b.onpointerdown=()=>rememberFixedOffListScroll(fixedList,key);
        b.onmousedown=()=>rememberFixedOffListScroll(fixedList,key);
      });
    }
    root.querySelectorAll('[data-rb-dashboard-open]').forEach(b=>b.onclick=()=>{ if(!saveCurrentBeforeNavigation()) return; state.section=b.dataset.rbDashboardOpen || 'dashboard'; const r=b.dataset.rule || ''; if(state.section==='teacher'&&r) state.teacherRule=r; if(state.section==='subject'&&r) state.subjectRule=r; if(state.section==='subjectGroup'&&r) state.subjectGroupRule=r; if(state.section==='fixedOff'&&r) state.fixedType=r; if(state.section==='timeLimit'&&r) state.timeLimitView=r; render(); });
    root.querySelectorAll('[data-fl-clear]').forEach(b=>b.onclick=()=>{
      if(clearFixedLessonCell(b.dataset.lop||'', b.dataset.thu||'', b.dataset.buoi||'', Number(b.dataset.ti))){
        touchSave({critical:true});
        rerenderSafe();
        render();
      }
    });
    const clearFixedLessons=root.querySelector('[data-fl-clear-all]');
    if(clearFixedLessons) clearFixedLessons.onclick=()=>{ if(confirm('Bỏ cố định tất cả tiết học?')) clearAllFixedLessons(); };
    const exportAll=root.querySelector('[data-rb-export-all]'); if(exportAll) exportAll.onclick=exportConstraintsForCurrentContext;
    const importAll=root.querySelector('[data-rb-import-all]'); const importAllFile=root.querySelector('[data-rb-import-all-file]');
    if(importAll && importAllFile) importAll.onclick=()=>importAllFile.click();
    if(importAllFile) importAllFile.onchange=()=>{ const file=importAllFile.files && importAllFile.files[0]; importConstraintsForCurrentContext(file); importAllFile.value=''; };
    root.querySelectorAll('[data-fixedoff-export]').forEach(b=>{ b.onclick=()=>exportFixedOffExcelForType(b.dataset.fixedoffExport || ''); });
    root.querySelectorAll('[data-fixedoff-import]').forEach(b=>{
      b.onclick=()=>{
        const type=b.dataset.fixedoffImport || '';
        const input=root.querySelector(`[data-fixedoff-import-file="${type}"]`);
        if(input) input.click();
      };
    });
    root.querySelectorAll('[data-fixedoff-import-file]').forEach(input=>{
      input.onchange=()=>{
        const file=input.files && input.files[0];
        importFixedOffExcelFileForType(input.dataset.fixedoffImportFile || '', file);
        input.value='';
      };
    });
    root.querySelectorAll('[data-rb-info-field]').forEach(el=>{
      const save=()=>saveInfoFromUI(false,{defer:true});
      el.oninput=save;
      el.onchange=save;
    });
    const gt=root.querySelector('[data-rb-group-type]'); if(gt) gt.onchange=()=>{state.groupType=gt.value;state.groupId='';render();}; const gid=root.querySelector('[data-rb-group-id]'); if(gid) gid.onchange=()=>{state.groupId=gid.value;render();}; const groupName=root.querySelector('[data-rb-group-name]'); if(groupName) groupName.onchange=()=>autoSaveGroupFromUI(); const newG=root.querySelector('[data-rb-new-group]'); if(newG) newG.onclick=()=>{state.groupId=''; const n=root.querySelector('[data-rb-group-name]'); if(n)n.value=''; root.querySelectorAll('[data-rb-group-items] input').forEach(x=>x.checked=false); refreshCheckAllMasters(root);}; const delG=root.querySelector('[data-rb-delete-group]'); if(delG) delG.onclick=deleteGroupFromUI;
    const ts=root.querySelector('[data-teacher-search]'); if(ts) ts.oninput=()=>{state.search=ts.value;render();}; const cg=root.querySelector('[data-class-group-filter]'); if(cg) cg.onchange=()=>{ if(!saveCurrentBeforeNavigation()) return; state.classGroup=cg.value;render();}; const sid=root.querySelector('[data-subject-id]'); if(sid) sid.onchange=()=>{ if(!saveCurrentBeforeNavigation()) return; state.subjectId=sid.value;render();}; const sgid=root.querySelector('[data-subject-group-id]'); if(sgid) sgid.onchange=()=>{ if(!saveCurrentBeforeNavigation()) return; state.subjectGroupId=sgid.value;render();}; const clearCur=root.querySelector('[data-rb-clear-current]'); if(clearCur) clearCur.onclick=clearCurrentRule;
    root.querySelectorAll('[data-tid][data-path]').forEach(el=>{ el.onchange=()=>saveCurrentFromUI(false); });
    root.querySelectorAll('[data-nss-class-select]').forEach(b=>b.onclick=ev=>{
      const id=b.dataset.nssClassSelect||'';
      if(ev && (ev.ctrlKey || ev.metaKey)){
        const wasSelected=noSameSelectedClassIds().map(String).includes(String(id));
        if(wasSelected){
          if(saveCurrentFromUI(false,{releaseExisting:false})===false) return;
          toggleNoSameClass(id);
          render();
          return;
        }
        toggleNoSameClass(id);
        if(saveCurrentFromUI(false,{releaseExisting:false})===false) return;
        render();
        return;
      }
      if(!saveCurrentBeforeNavigation()) return;
      setNoSameSingleClass(id);
      render();
    });
    root.querySelectorAll('[data-nss-subject][data-nss-group]').forEach(el=>{ el.onchange=()=>saveCurrentFromUI(false); });
    root.querySelectorAll('[data-tl-view]').forEach(b=>b.onclick=()=>{ if(!saveCurrentBeforeNavigation()) return; state.timeLimitView=b.dataset.tlView||'limits'; render(); });
    root.querySelectorAll('[data-tlg-type][data-tlg-group][data-tlg-item]').forEach(el=>{ el.onchange=()=>saveTimeLimitGroupsFromUI(false); });
    root.querySelectorAll('[data-tll-select-type][data-tll-select-id]').forEach(b=>b.onclick=()=>{ if(!saveCurrentBeforeNavigation()) return; state.timeLimitLimitType=b.dataset.tllSelectType||'teacher'; state.timeLimitLimitGroupId=b.dataset.tllSelectId||''; render(); });
    root.querySelectorAll('[data-tll-type][data-tll-target-id][data-tll-field][data-tll-buoi][data-tll-day]').forEach(el=>{ el.onchange=()=>saveTimeLimitLimitsFromUI(false); });
    root.querySelectorAll('[data-tll-clear][data-tll-clear-type]').forEach(b=>b.onclick=()=>{ clearTimeLimitForGroup(b.dataset.tllClearType||'', b.dataset.tllClear||''); });
    root.querySelectorAll('[data-fo-select]').forEach(b=>b.onclick=ev=>{
      const id=b.dataset.foSelect||'';
      const type=state.fixedType || 'class';
      if(fixedOffMultiSelectEnabled(type)){
        const list=fixedOffListForType(type);
        if(ev && ev.shiftKey) selectFixedOffRangeForType(type,id,list,!!(ev.ctrlKey || ev.metaKey));
        else if(ev && (ev.ctrlKey || ev.metaKey)) toggleFixedOffItem(type,id,list);
        else setFixedOffSingleItem(type,id);
      }else{
        state.fixedSelected = state.fixedSelected || {};
        state.fixedSelected[type]=id;
      }
      renderKeepingFixedOffListScroll();
    });
    root.querySelectorAll('[data-mt-select]').forEach(b=>b.onclick=ev=>{ const id=b.dataset.mtSelect||''; if(ev && (ev.ctrlKey || ev.metaKey)) toggleMustTeachTeacher(id,fixedOffListForType('teacher')); else setMustTeachSingleTeacher(id); renderKeepingFixedOffListScroll(); });
    root.querySelectorAll('[data-mt-toggle][data-mt-id][data-slot]').forEach(el=>el.onclick=ev=>{ const slot=el.dataset.slot||''; if(ev && ev.shiftKey) selectMustTeachRange(slot, !!(ev.ctrlKey || ev.metaKey)); else if(ev && (ev.ctrlKey || ev.metaKey)) toggleMustTeachSlot(slot); else setMustTeachSingleSlot(slot); refreshMustTeachSelection(root); });
    if(!state.mustTeachKeyBound){ document.addEventListener('keydown',handleMustTeachKeydown); state.mustTeachKeyBound=true; }
    if(!state.fixedOffKeyBound){ document.addEventListener('keydown',handleFixedOffKeydown); state.fixedOffKeyBound=true; }
    root.querySelectorAll('[data-fo-toggle][data-off-type][data-off-id][data-slot]').forEach(el=>{
      el.onselectstart=ev=>{ ev.preventDefault(); return false; };
      el.ondragstart=ev=>{ ev.preventDefault(); return false; };
      el.onmousedown=ev=>{
        if(ev && ev.button === 0){
          ev.preventDefault();
          try{ window.getSelection?.()?.removeAllRanges?.(); }catch(_){}
        }
      };
      el.onclick=ev=>{
        closeRbMenus();
        try{ el.focus({preventScroll:true}); }catch(_){ try{ el.focus(); }catch(__){} }
        const slot=el.dataset.slot || '';
        if(ev && ev.shiftKey) selectFixedOffRange(slot, false);
        else if(ev && (ev.ctrlKey || ev.metaKey)) toggleFixedOffSlot(slot);
        else setFixedOffSingleSlot(slot);
        refreshFixedOffSelection(root);
      };
      el.ondblclick=ev=>{
        openFixedLessonMenuFromCell(el, ev, {source:'dblclick'});
      };
      el.onkeydown=ev=>{
        const key=String(ev.key || '');
        if(key!=='Enter' && key!==' ') return;
        ev.preventDefault();
        setFixedOffSingleSlot(el.dataset.slot || '');
        refreshFixedOffSelection(root);
      };
    });
    const clearAll=root.querySelector('[data-rb-clear-all]'); if(clearAll) clearAll.onclick=clearAllConstraints; ['teacher','subject','fixedOff','timeLimit'].forEach(k=>{ const b=root.querySelector(`[data-clear-${k}]`); if(b) b.onclick=()=>clearSection(k); });
    bindNumberCellGrid(root);
  }
  function saveGroupFromUI(showMsg, opts){ opts=opts||{}; const root=document.getElementById(PANEL_ID); if(!root)return; const type=state.groupType||'subject'; const name=String(root.querySelector('[data-rb-group-name]')?.value||'').trim(); if(!name){ if(showMsg!==false) alert('Nhập tên nhóm.'); return false; } const id=state.groupId||cleanId(name,type); const items=Array.from(root.querySelectorAll('[data-rb-group-items] input:checked')).map(x=>x.value); model().groups[type][id]={name,items}; state.groupId=id; touchSave(); const released=opts.releaseExisting===false?0:releaseExistingViolationsAfterSave(); render(); if(showMsg!==false && released>0) notifySaved(`Đã lưu nhóm. Đã đưa ${released} tiết đang vi phạm về Chưa phân.`); return true; }
  function deleteGroupFromUI(){ const type=state.groupType||'subject', id=state.groupId; if(!id)return; if(!confirm('Xóa nhóm này?'))return; delete model().groups[type][id]; state.groupId=''; touchSave(); render(); }
  function removeTimeLimitRuleForGroup(type, groupId){
    const targetType=timeLimitTargetType(type);
    const c=model();
    c.timeLimit=(c.timeLimit || []).filter(r=>!(String(r?.targetType || '')===String(targetType) && String(r?.targetId || '')===String(groupId)));
  }
  function clearTimeLimitGroupsAndRules(){
    const c=model();
    c.timeLimit=[];
    ['class','teacher','subject'].forEach(type=>{
      c.groups[type]=c.groups[type] || {};
      timeLimitGroupIds(type).forEach(gid=>{ delete c.groups[type][gid]; });
    });
    state.timeLimitLimitGroupId='';
  }
  function saveTimeLimitGroupsFromUI(showMsg){
    const root=document.getElementById(PANEL_ID);
    if(!root) return false;
    const boxes=Array.from(root.querySelectorAll('[data-tlg-type][data-tlg-group][data-tlg-item]'));
    if(!boxes.length) return true;
    const c=model();
    const types=arrUnique(boxes.map(el=>el.dataset.tlgType || '').filter(Boolean));
    types.forEach(type=>{
      c.groups[type]=c.groups[type] || {};
      const checkedByGroup={};
      boxes.filter(el=>String(el.dataset.tlgType||'')===String(type)).forEach(el=>{
        const gid=String(el.dataset.tlgGroup || '');
        if(!gid) return;
        checkedByGroup[gid]=checkedByGroup[gid] || [];
        if(el.checked) checkedByGroup[gid].push(String(el.dataset.tlgItem || ''));
      });
      timeLimitGroupIds(type).forEach((gid,i)=>{
        const items=arrUnique(checkedByGroup[gid] || []);
        if(items.length){
          c.groups[type][gid]={name:timeLimitGroupName(type,i+1),items};
        }else{
          delete c.groups[type][gid];
          removeTimeLimitRuleForGroup(type,gid);
          if(String(state.timeLimitLimitGroupId||'')===String(gid)) state.timeLimitLimitGroupId='';
        }
      });
    });
    touchSave();
    scheduleRememberCurrentFormSignature();
    if(showMsg) alert('Đã lưu nhóm giới hạn.');
    return true;
  }
  function saveTimeLimitLimitsFromUI(showMsg){
    const root=document.getElementById(PANEL_ID);
    if(!root) return false;
    const inputs=Array.from(root.querySelectorAll('[data-tll-type][data-tll-target-id][data-tll-field][data-tll-buoi][data-tll-day]'));
    if(!inputs.length) return true;
    const touched=new Map();
    inputs.forEach(el=>{
      const type=String(el.dataset.tllType || '');
      const groupId=String(el.dataset.tllTargetId || '');
      const field=String(el.dataset.tllField || timeLimitField(type));
      if(!type || !groupId || !field) return;
      touched.set(type+'|'+groupId+'|'+field,{type,groupId,field});
    });
    touched.forEach(info=>{
      const rule=timeLimitRuleFor(info.type, info.groupId, true);
      if(!rule) return;
      const group=model().groups[info.type]?.[info.groupId] || {};
      rule.name=String(group.name || info.groupId);
      rule.targetType=timeLimitTargetType(info.type);
      rule.targetId=info.groupId;
      rule.perSlotBySession=rule.perSlotBySession || {};
      delete rule.perSlotBySession[info.field];
      if(rule.perSlot && typeof rule.perSlot==='object'){
        delete rule.perSlot[info.field];
        if(info.field==='subjects') delete rule.perSlot.classes;
        delEmpty(rule.perSlot);
      }
      if(rule.perSession && typeof rule.perSession==='object'){
        delete rule.perSession[info.field];
        delEmpty(rule.perSession);
      }
    });
    inputs.forEach(el=>{
      const type=String(el.dataset.tllType || '');
      const groupId=String(el.dataset.tllTargetId || '');
      const field=String(el.dataset.tllField || timeLimitField(type));
      const buoi=String(el.dataset.tllBuoi || '');
      const thu=String(el.dataset.tllDay || '');
      const val=toInt(el.value,'');
      if(!type || !groupId || !field || !buoi || !thu || val === '' || val <= 0) return;
      const rule=timeLimitRuleFor(type,groupId,true);
      if(!rule) return;
      setPath(rule, `perSlotBySession.${field}.${buoi}.${thu}`, val);
    });
    (model().timeLimit || []).forEach(r=>{ delEmpty(r.perSlotBySession); delEmpty(r.perSlot); delEmpty(r.perSession); delEmpty(r); });
    pruneEmptyTimeLimitRules();
    touchSave();
    scheduleRememberCurrentFormSignature();
    if(showMsg) alert('Đã lưu giới hạn.');
    return true;
  }
  function clearTimeLimitForGroup(type, groupId){
    if(!type || !groupId) return;
    if(!confirm('Xóa giới hạn của nhóm này?')) return;
    removeTimeLimitRuleForGroup(type,groupId);
    touchSave();
    render();
  }
  function saveInfoFromUI(showMsg, opts){
    opts=opts||{};
    const root=document.getElementById(PANEL_ID);
    if(!root) return false;
    const c=model();
    c.meta=c.meta || {};
    const schedField=root.querySelector('[data-rb-info-field="scheduleNumber"]');
    const dateField=root.querySelector('[data-rb-info-field="effectiveDate"]');
    if(schedField) c.meta.scheduleNumber=String(schedField.value || '').trim();
    if(dateField) c.meta.effectiveDate=String(dateField.value || '').trim();
    if(opts.defer) touchSaveDeferred();
    else touchSave();
    scheduleRememberCurrentFormSignature();
    if(showMsg) notifySaved('Đã lưu thông tin.');
    return true;
  }
  function saveSubjectNoSameRuleFromUI(showMsg, opts){
    opts=opts||{};
    const root=document.getElementById(PANEL_ID);
    const c=model();
    const rule=state.subjectRule==='noSameDay' ? 'noSameDay' : 'noSameSession';
    const key=noSameKindKey(rule);
    const classId=noSameRuleClassId();
    const targetClassIds=noSameSelectedClassIds();
    const groups={};
    root.querySelectorAll('[data-nss-subject][data-nss-group]').forEach(el=>{
      if(!el.checked) return;
      if(String(el.dataset.nssRule||rule)!==String(rule)) return;
      if(String(el.dataset.nssClass||classId)!==String(classId)) return;
      const gid=String(el.dataset.nssGroup||'').trim();
      const subject=String(el.dataset.nssSubject||'').trim();
      if(!gid || !subject) return;
      groups[gid]=groups[gid]||[];
      if(!groups[gid].includes(subject)) groups[gid].push(subject);
    });
    targetClassIds.forEach(targetClassId=>{
      const row=noSameRuleRow(targetClassId,true);
      row[key]={groups: JSON.parse(JSON.stringify(groups))};
      c.subjectNoSameSession.byClass[targetClassId]=row;
      if(!Object.keys(groups).length){
        delete row[key];
        delEmpty(row);
        if(!Object.keys(row).length) delete c.subjectNoSameSession.byClass[targetClassId];
      }
    });
    touchSave();
    const released=opts.releaseExisting===false?0:releaseExistingViolationsAfterSave();
    rememberCurrentFormSignature();
    const classCount=targetClassIds.length;
    if(showMsg!==false) notifySaved(released>0 ? `Đã lưu yêu cầu cho ${classCount} lớp. Đã đưa ${released} tiết đang vi phạm về Chưa phân.` : `Đã lưu yêu cầu cho ${classCount} lớp.`);
    return true;
  }
  function saveCurrentFromUI(showMsg, opts){ opts=opts||{}; const root=document.getElementById(PANEL_ID); if(!root)return; if(state.section==='groups') return saveGroupFromUI(showMsg, opts); if(state.section==='teacher' && state.teacherRule==='mustTeach' && !validateTeacherMustTeachBeforeSave()) return false; const c=model();
    if(state.section==='info') return saveInfoFromUI(showMsg, opts);
    if(state.section==='subject' && (state.subjectRule==='noSameSession'||state.subjectRule==='noSameDay')) return saveSubjectNoSameRuleFromUI(showMsg, opts);
    if(state.section==='timeLimit' && root.querySelector('[data-tlg-type][data-tlg-group][data-tlg-item]')) return saveTimeLimitGroupsFromUI(showMsg);
    if(state.section==='timeLimit' && root.querySelector('[data-tll-type][data-tll-target-id][data-tll-field][data-tll-buoi][data-tll-day]')) return saveTimeLimitLimitsFromUI(showMsg);
    // teacher
    root.querySelectorAll('[data-tid][data-path]').forEach(el=>{ const tid=el.dataset.tid, path=el.dataset.path; c.teacher[tid]=c.teacher[tid]||{}; let val=el.type==='checkbox'?!!el.checked:(el.tagName==='SELECT'?String(el.value||'').trim():(el.value===''?'':toInt(el.value,''))); setPath(c.teacher[tid],path,val); delEmpty(c.teacher[tid]); if(Object.keys(c.teacher[tid]).length===0) delete c.teacher[tid]; });
    // subject / subjectGroup by class
    const isSG=state.section==='subjectGroup'; const container=(state.section==='subject')?getRuleContainer(false):(state.section==='subjectGroup'?getRuleContainer(true):null); if(container){ container.byClass=container.byClass||{}; root.querySelectorAll('[data-cid][data-path]').forEach(el=>{ const cid=el.dataset.cid, path=el.dataset.path; container.byClass[cid]=container.byClass[cid]||{}; let val=el.type==='checkbox'?!!el.checked:(el.value===''?'':toInt(el.value,'')); setPath(container.byClass[cid],path,val); if(path.startsWith('avoidBreakPair23.')||path.startsWith('avoidBreakPair34.')) delete container.byClass[cid].avoidBreakPairs; if(path.startsWith('linkedDays.')) normalizeLinkedDaysRow(container.byClass[cid]); if(path.startsWith('sessionAllowed.')) normalizeSessionAllowedRow(container.byClass[cid]); delEmpty(container.byClass[cid]); if(Object.keys(container.byClass[cid]).length===0) delete container.byClass[cid]; }); Object.keys(container.byClass||{}).forEach(cid=>{ normalizeSessionAllowedRow(container.byClass[cid]); delEmpty(container.byClass[cid]); if(Object.keys(container.byClass[cid]||{}).length===0) delete container.byClass[cid]; }); }
    // global limits embedded in subject / subjectGroup
    root.querySelectorAll('[data-global-scope][data-path]').forEach(el=>{ const scope=el.dataset.globalScope, rootId=el.dataset.globalRoot, base=el.dataset.globalBase, path=el.dataset.path; const obj=scope==='subjectGroup'?(c.subjectGroup[rootId]=c.subjectGroup[rootId]||{}):(c.subject[rootId]=c.subject[rootId]||{}); obj[base]=obj[base]||{}; setPath(obj[base],path,el.value===''?'':toInt(el.value,'')); delEmpty(obj[base]); });
    // fixed off
    const classFixedOffTouched=new Set();
    root.querySelectorAll('[data-off-type][data-off-id][data-slot]').forEach(el=>{ const type=el.dataset.offType, id=el.dataset.offId, sk=el.dataset.slot; c.fixedOff[type]=c.fixedOff[type]||{}; c.fixedOff[type][id]=c.fixedOff[type][id]||{}; const checked=el.type==='checkbox'?!!el.checked:el.classList.contains('off'); if(checked) c.fixedOff[type][id][sk]=true; else delete c.fixedOff[type][id][sk]; if(type==='class'){ const p=parseSlotKey(sk); syncClassFixedOffCell(id,p.thu,p.buoi,p.ti,checked); classFixedOffTouched.add(id); } delEmpty(c.fixedOff[type][id]); if(Object.keys(c.fixedOff[type][id]).length===0) delete c.fixedOff[type][id]; });
    classFixedOffTouched.forEach(id=>syncClassFixedOffUserOffFromModel(id));
    // time limit
    root.querySelectorAll('[data-tl][data-field]').forEach(el=>{ const i=Number(el.dataset.tl), f=el.dataset.field; c.timeLimit[i]=c.timeLimit[i]||{}; let val=el.tagName==='SELECT'||el.type==='text'?String(el.value||'').trim():(el.value===''?'':toInt(el.value,'')); setPath(c.timeLimit[i],f,val); }); c.timeLimit.forEach(r=>delEmpty(r));
    touchSave();
    const released=opts.releaseExisting===false?0:releaseExistingViolationsAfterSave();
    rememberCurrentFormSignature();
    if(showMsg!==false) notifySaved(withTeacherCapacityWarning(released>0 ? `Đã lưu yêu cầu. Đã đưa ${released} tiết đang vi phạm về Chưa phân.` : 'Đã lưu yêu cầu.'));
    return true; }
  function currentFormSignature(){
    try{ return JSON.stringify(currentRulePayload()); }catch(_){ return ''; }
  }
  function rememberCurrentFormSignature(){
    state.formSignature = currentFormSignature();
  }
  function scheduleRememberCurrentFormSignature(){
    if(state.formSignatureTimer) clearTimeout(state.formSignatureTimer);
    state.formSignatureTimer=setTimeout(()=>{
      state.formSignatureTimer=null;
      if(document.getElementById(PANEL_ID)) rememberCurrentFormSignature();
    },180);
  }
  function currentRulePayload(){
    const root=document.getElementById(PANEL_ID);
    const fields=[];
    if(root){
      root.querySelectorAll('[data-rb-info-field],[data-tid][data-path],[data-cid][data-path],[data-nss-subject][data-nss-group],[data-off-type][data-off-id][data-slot],[data-mt-toggle][data-mt-id][data-slot],[data-tl][data-field],[data-tlg-type][data-tlg-group][data-tlg-item],[data-tll-type][data-tll-target-id][data-tll-field][data-tll-buoi][data-tll-day],[data-global-scope][data-path]').forEach(el=>{
        const item={};
        Array.from(el.attributes).forEach(a=>{ if(a.name.indexOf('data-')===0) item[a.name.replace(/^data-/,'')]=a.value; });
        item.value = el.matches('[data-off-type][data-off-id][data-slot]') && el.type !== 'checkbox' ? el.classList.contains('off') : (el.type === 'checkbox' ? !!el.checked : String(el.value || ''));
        fields.push(item);
      });
    }
    return {section:state.section,teacherRule:state.teacherRule,subjectRule:state.subjectRule,subjectGroupRule:state.subjectGroupRule,fixedType:state.fixedType,timeLimitView:state.timeLimitView,timeLimitLimitType:state.timeLimitLimitType,timeLimitLimitGroupId:state.timeLimitLimitGroupId,fields};
  }
  function copyCurrentRule(showMsg){
    const text=JSON.stringify(currentRulePayload(),null,2);
    const done=()=>{ if(showMsg!==false) alert('Đã copy dữ liệu mục hiện tại.'); };
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done).catch(()=>{ window.prompt('Copy dữ liệu yêu cầu:', text); done(); });
      }else{
        window.prompt('Copy dữ liệu yêu cầu:', text); done();
      }
    }catch(_){
      window.prompt('Copy dữ liệu yêu cầu:', text); done();
    }
  }
  function clearRuleFromByClass(container, rule){
    if(!container || typeof container!=='object') return;
    Object.keys(container.byClass || {}).forEach(cid=>{
      const row=container.byClass[cid];
      if(!row || typeof row!=='object') return;
      if(rule==='maxPeriodsDay'){
        const mp=row.maxPeriods;
        if(mp && typeof mp==='object') delete mp.day;
        delEmpty(mp);
      }else{
        delete row[rule];
      }
      if(rule==='avoidBreakPair23'||rule==='avoidBreakPair34') delete row.avoidBreakPairs;
      delEmpty(row);
      if(!Object.keys(row).length) delete container.byClass[cid];
    });
    delEmpty(container.byClass);
    delEmpty(container);
  }
  function clearSubjectNoSameRule(rule){
    const c=model();
    const key=noSameKindKey(rule);
    const root=c.subjectNoSameSession && typeof c.subjectNoSameSession==='object' ? c.subjectNoSameSession : {};
    Object.keys(root.byClass || {}).forEach(classId=>{
      const row=root.byClass[classId];
      if(!row || typeof row!=='object') return;
      delete row[key];
      delEmpty(row);
      if(!Object.keys(row).length) delete root.byClass[classId];
    });
    if(rule==='noSameSession') delete root.groups;
    if(rule==='noSameDay') delete c.subjectNoSameDay;
    delEmpty(root.byClass);
    c.subjectNoSameSession={byClass:root.byClass || {}};
  }
  function clearAllSubjectRule(rule){
    const c=model();
    if(rule==='noSameSession'||rule==='noSameDay'){
      clearSubjectNoSameRule(rule);
      return;
    }
    Object.keys(c.subject || {}).forEach(subjectId=>{
      const obj=c.subject[subjectId];
      if(!obj || typeof obj!=='object') return;
      if(rule==='globalLimit'||rule==='groupLimit') delete obj[rule];
      else clearRuleFromByClass(obj, rule);
      delEmpty(obj);
      if(!Object.keys(obj).length) delete c.subject[subjectId];
    });
  }
  function clearAllSubjectGroupRule(rule){
    const c=model();
    Object.keys(c.subjectGroup || {}).forEach(groupId=>{
      const obj=c.subjectGroup[groupId];
      if(!obj || typeof obj!=='object') return;
      if(rule==='globalLimit'||rule==='groupLimit') delete obj[rule];
      else clearRuleFromByClass(obj, rule);
      delEmpty(obj);
      if(!Object.keys(obj).length) delete c.subjectGroup[groupId];
    });
  }
  function clearAllTeacherRule(rule){
    const c=model();
    Object.keys(c.teacher || {}).forEach(teacherId=>{
      const row=c.teacher[teacherId];
      if(!row || typeof row!=='object') return;
      delete row[rule];
      delEmpty(row);
      if(!Object.keys(row).length) delete c.teacher[teacherId];
    });
  }
  function clearAllFixedOffType(type){
    if(!type) return;
    const c=model();
    if(type==='class'){
      const snapshot=classFixedOffSlotsSnapshot();
      clearClassFixedOffCells(snapshot);
      Object.keys(snapshot).forEach(id=>syncClassFixedOffUserOff(id,{}));
      rerenderSafe();
    }
    c.fixedOff[type]={};
  }
  function currentFixedOffTargetIds(type){
    if(fixedOffMultiSelectEnabled(type)) return fixedOffSelectedIds(type,fixedOffListForType(type)).map(String);
    const id=String(state.fixedSelected?.[type] || '');
    return id ? [id] : [];
  }
  function clearFixedOffTypeIds(type,ids){
    const targets=arrUnique((ids || []).map(String).filter(Boolean));
    if(!type || !targets.length) return false;
    const c=model();
    c.fixedOff[type]=c.fixedOff[type] || {};
    if(type==='class'){
      const snapshot=classFixedOffSlotsSnapshot();
      const selectedSnapshot={};
      targets.forEach(id=>{ if(snapshot[id]) selectedSnapshot[id]=snapshot[id]; });
      clearClassFixedOffCells(selectedSnapshot);
      targets.forEach(id=>{
        delete c.fixedOff.class[id];
        syncClassFixedOffUserOff(id,{});
      });
      rerenderSafe();
    }else{
      targets.forEach(id=>{ delete c.fixedOff[type][id]; });
    }
    delEmpty(c.fixedOff[type]);
    return true;
  }
  function clearCurrentFixedOffRule(){
    const type=state.fixedType || 'class';
    const ids=currentFixedOffTargetIds(type);
    if(!ids.length) return false;
    const label=type==='class'
      ? `${ids.length} lớp đang chọn`
      : fixedOffDisplayName(type, ids[0]);
    if(!confirm(`Xóa ô cố định của ${label}?`)) return false;
    clearFixedOffTypeIds(type,ids);
    touchSave();
    render();
    return true;
  }
  function clearCurrentRule(){
    if(state.section==='fixedOff'){
      clearCurrentFixedOffRule();
      return;
    }
    if(!confirm('Xóa dữ liệu mục này?')) return;
    const c=model();
    if(state.section==='teacher'){
      clearAllTeacherRule(state.teacherRule);
    } else if(state.section==='subject'){
      clearAllSubjectRule(state.subjectRule);
    } else if(state.section==='subjectGroup'){
      clearAllSubjectGroupRule(state.subjectGroupRule);
    } else if(state.section==='fixedOff'){
      clearAllFixedOffType(state.fixedType);
    } else if(state.section==='timeLimit'){
      clearTimeLimitGroupsAndRules();
    }
    touchSave();
    render();
  }
  function renderCheck(){
    const arr=validateAll(300);
    const capacityWarnings=[...teacherFixedOffCapacityWarnings(), ...classFixedOffCapacityWarnings()];
    const capacityHtml=teacherCapacityWarningsHtml(capacityWarnings,{limit:20,tall:true});
    return `<h3>Kiểm tra yêu cầu</h3><div class="hint">Chỉ khi bấm kiểm tra mới quét toàn bộ TKB. Kéo-thả/xếp tự động chỉ kiểm tra nhanh ô đang đặt.</div>${capacityHtml}<div class="box"><b>Kết quả: ${arr.length} vi phạm${arr.length>=300?' (hiển thị 300 lỗi đầu để tránh đứng trang)':''}</b><pre>${esc(arr.length?arr.map((x,i)=>`${i+1}. ${x.className||x.lopId||''} ${x.mon?('['+x.mon+'] '):''}${x.thu?dayLabel(x.thu)+' '+SESSION_LABEL[x.buoi]+' tiết '+(Number(x.ti)+1)+': ':''}${x.message||''}`).join('\n'):'Không phát hiện vi phạm yêu cầu.')}</pre></div>`;
  }
  function renderClear(){ return `<div class="rb-clear-screen"><h3>Xóa yêu cầu TKB</h3><div class="hint">Chỉ xóa dữ liệu yêu cầu. Không xóa TKB đã xếp, PCCM và danh mục.</div><div class="rb-clear-grid"><div class="rb-clear-card"><b>Yêu cầu của giáo viên</b><span>Xóa toàn bộ dữ liệu trong nhóm yêu cầu giáo viên.</span><button type="button" class="danger" data-clear-teacher>Xóa</button></div><div class="rb-clear-card"><b>Yêu cầu của môn học</b><span>Xóa toàn bộ dữ liệu trong nhóm yêu cầu môn học.</span><button type="button" class="danger" data-clear-subject>Xóa</button></div><div class="rb-clear-card"><b>${FIXED_OFF_GROUP_LABEL}</b><span>Xóa yêu cầu cố định lớp, giáo viên, môn và phòng.</span><button type="button" class="danger" data-clear-fixedOff>Xóa</button></div><div class="rb-clear-card"><b>Giới hạn số tiết/1 thời điểm</b><span>Xóa toàn bộ nhóm giới hạn và giới hạn theo lớp, giáo viên, môn.</span><button type="button" class="danger" data-clear-timeLimit>Xóa</button></div><div class="rb-clear-card"><b>Toàn bộ yêu cầu TKB</b><span>Khôi phục toàn bộ dữ liệu yêu cầu về trạng thái trống.</span><button type="button" class="danger" data-rb-clear-all>Xóa toàn bộ</button></div></div></div>`; }
  function clearSection(k){ if(!confirm('Xóa mục này?'))return; const c=model(); const classSnapshot=k==='fixedOff' ? classFixedOffSlotsSnapshot() : null; if(k==='teacher') c.teacher={}; if(k==='subject'){ c.subject={}; c.subjectNoSameSession={byClass:{}}; } if(k==='subjectGroup') c.subjectGroup={}; if(k==='fixedOff'){ c.fixedOff={class:{},teacher:{},subject:{},room:{},subjectGroup:{}}; clearClassFixedOffCells(classSnapshot); D().tkbUserOff={}; } if(k==='timeLimit') clearTimeLimitGroupsAndRules(); touchSave(); rerenderSafe(); render(); }
  function clearAllConstraints(){ if(!confirm('Xóa toàn bộ yêu cầu TKB?'))return; const classSnapshot=classFixedOffSlotsSnapshot(); D().tkbConstraints=emptyModel(); D().tkbUserOff={}; clearClassFixedOffCells(classSnapshot); syncDefaultGroups(); touchSave(); rerenderSafe(); render(); }

  /* ===================== HOOKS ===================== */
  function installHooks(){
    window.toggleRangBuoc=openPanel; window.openRangBuocTKB=openPanel;
    try{
      if(typeof window.saveStore === 'function' && !window.saveStore.__tkbConstraintsInvalidateWrapped){
        const oldSave = window.saveStore;
        window.saveStore = function(){ invalidateConstraintCache(); return oldSave.apply(this, arguments); };
        window.saveStore.__tkbConstraintsInvalidateWrapped = true;
      }
    }catch(e){ console.warn('[tkb-constraints] saveStore hook failed', e); }
    try{ if(typeof validateDrop==='function' && !validateDrop.__tkbConstraintsFullWrapped){ const old=validateDrop; const wrapped=function(targetTd,mon){ const base=old.apply(this,arguments); if(base && base.ok===false) return base; try{ const thu=targetTd?.dataset?.thu, buoi=targetTd?.dataset?.buoi, ti=Number(targetTd?.dataset?.ti); const dragType=(typeof dragData!=='undefined' && dragData) ? String(dragData.type||'') : ''; const src=(dragType==='cell'||dragType==='pairTeacherCell') ? dragData.from?.dataset : null; const res=canPlaceLesson({lopId:currentClassId(),mon,thu,buoi,ti,src,mode:'drag'}); if(!res.ok) return {ok:false,reason:'tkb-constraints',msg:(res.messages||[]).join('\n')}; }catch(e){ console.warn('[tkb-constraints] validateDrop hook failed',e); } return base; }; wrapped.__tkbConstraintsFullWrapped=true; window.validateDrop=wrapped; } }catch(e){ console.warn('[tkb-constraints] install validateDrop hook failed',e); }
    try{ if(typeof taoTKBBoSungTheoConfig==='function' && !taoTKBBoSungTheoConfig.__tkbConstraintsFullWrapped){ const old=taoTKBBoSungTheoConfig; const wrapped=function(existingTkb,mons,config,extraCanPlaceCell,extraScoreBlock){ const lopId=inferClassIdFromTkb(existingTkb) || currentClassId(); invalidateConstraintCache(); const combined=function(thu,buoi,ti,mon){ if(typeof extraCanPlaceCell==='function' && !extraCanPlaceCell(thu,buoi,ti,mon)) return false; if(!lopId){ return true; } const res=canPlaceLesson({lopId,mon,thu,buoi,ti,localTkb:existingTkb,mode:'auto'}); return !!res.ok; }; const ret=old.call(this,existingTkb,mons,config,combined,extraScoreBlock); invalidateConstraintCache(); return ret; }; wrapped.__tkbConstraintsFullWrapped=true; window.taoTKBBoSungTheoConfig=wrapped; } }catch(e){ console.warn('[tkb-constraints] install auto schedule hook failed',e); }
  }

  function debugCanPlace(lopId, mon, thu, buoi, ti){
    const res = canPlaceLesson({lopId, mon, thu, buoi, ti:Number(ti), full:true, mode:'debug'});
    try{ console.log('[TKBConstraints debugCanPlace]', {lopId, mon, thu, buoi, ti, result:res}); }catch(_){ }
    return res;
  }
  function openPage(opts){ return openPanel(Object.assign({page:true}, opts || {})); }
  try{
    if(window.__TKB_E2E_EXPOSE_TEST_HOOKS === true){
      window.__TKB_CONSTRAINTS_TEST_HOOKS = {
        getTeacherList,
        getSubjectList,
        subjectOptionsForClasses,
        applyClassFixedLessonToSelection,
        fixedLessonAt,
        fixedOffSelectedClassIds,
        setFixedOffSingleClass,
        toggleFixedOffClass,
        teacherStats,
        teacherRuleTable,
        renderSubjectRule,
        applyLessonBlockBulkFill
      };
    }
  }catch(_){ }
  const API={version:VERSION,get:model,save:touchSave,open:openPanel,openPage,close:closePanel,render,syncDefaultGroups,canPlaceLesson,canPlaceCell,validateAll,validateAllAsync,explain:validateAll,score:function(){return validateAll(1000).length;},teacherFixedOffCapacityWarnings,classFixedOffCapacityWarnings,teacherCellsAfterPlace,inferClassIdFromTkb,debugCanPlace,teacherFixedOffExcelRows,exportTeacherFixedOffExcel,importTeacherFixedOffRows,importTeacherFixedOffExcelFile,classFixedOffExcelRows,exportClassFixedOffExcel,importClassFixedOffRows,importClassFixedOffExcelFile,subjectFixedOffExcelRows,exportSubjectFixedOffExcel,importSubjectFixedOffRows,importSubjectFixedOffExcelFile,fullConstraintsExportPayload,exportAllConstraintsExcel,readAllConstraintsPayloadFromWorkbook,applyImportedConstraintsPayload,importAllConstraintsExcelFile};
  window.TKBConstraints=API; window.TKBConstraintsFull=API;
  try{ injectStyle(); model(); installHooks(); console.log('[tkb-constraints] loaded', VERSION); }catch(e){ console.warn('[tkb-constraints] init failed',e); }
})();
