(function(){
  'use strict';

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const SHEET_NAME = 'DATASHEET';
  const PAGE_ROWS = 75;
  const PAGE_COLS = 21;
  const CARDS_PER_PAGE = 8;
  const CARD_START_ROWS = [0, 19, 38, 57];
  const CARD_START_COLS = [0, 11];
  const SAMPLE_COL_WIDTHS = [
    1.1328125, 2.73046875, 2.73046875, 7, 7, 7, 6.73046875, 7, 7, 3, 0.1328125,
    1.265625, 2.73046875, 2.73046875, 7, 7, 7, 6.73046875, 7, 7, 1.1328125
  ];
  const SCHOOL_CLASS_PAGE_ROWS = 62;
  const SCHOOL_CLASS_PAGE_COLS = 21;
  const SCHOOL_CLASS_CLASSES_PER_PAGE = 18;
  const SCHOOL_CLASS_SHEET_NAME = 'Sheet1';
  const SCHOOL_CLASS_TITLE_LAST_COL = 16;
  const SCHOOL_CLASS_META_COL_WIDTH = 4.59765625;
  const SCHOOL_CLASS_DATA_COL_WIDTH = 13.59765625;
  const SCHOOL_CLASS_ROW_HEIGHT = 12.75;
  const SCHOOL_CLASS_PRINT = {
    paperSize: 8,
    margins: {left:'0.2', right:'0.2', top:'0.25', bottom:'0.25', header:'0', footer:'0'},
    centered: false
  };
  const TEACHER1_PAGE_ROWS = 37;
  const TEACHER1_PAGE_COLS = 36;
  const TEACHER1_CARDS_PER_PAGE = 8;
  const TEACHER1_CARD_START_ROWS = [0, 19];
  const TEACHER1_CARD_START_COLS = [0, 9, 18, 27];
  const TEACHER1_COL_WIDTHS = [
    2.07, 2.07, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 2.07,
    2.07, 2.07, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 2.07,
    2.07, 2.07, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 2.07,
    2.07, 2.07, 3.8, 3.8, 3.8, 3.8, 3.8, 3.8, 2.07
  ];
  const TEACHER1_ROW_HEIGHTS = Array.from({length: TEACHER1_PAGE_ROWS}, () => 12.75);
  const FONT_NAME = 'Times New Roman';
  const THIN_BORDER_COLOR = 'FF000000';
  const PRINT_MARGIN = 0.08;
  const PRINT_MARGIN_XML = '0.08';

  function safe(v){
    return v == null ? '' : String(v).trim();
  }

  function pad2(n){
    return String(Number(n || 0)).padStart(2, '0');
  }

  function todayParts(){
    const d = new Date();
    return {
      day: pad2(d.getDate()),
      month: pad2(d.getMonth() + 1),
      year: String(d.getFullYear())
    };
  }

  function parseDateInput(value){
    const s = safe(value);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(m) return {day:m[3], month:m[2], year:m[1]};
    const vn = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if(vn) return {day:pad2(vn[1]), month:pad2(vn[2]), year:vn[3]};
    return todayParts();
  }

  function fileDateToday(){
    const d = todayParts();
    return `${d.day}${d.month}${d.year}`;
  }

  function displayDate(value){
    const d = parseDateInput(value);
    return `${d.day}/${d.month}/${d.year}`;
  }

  function parseJson(raw, fallback){
    try{ return raw ? JSON.parse(raw) : fallback; }catch(_){ return fallback; }
  }

  function getInfoMeta(){
    try{
      const api = window.TKBConstraints || window.TKBConstraintsFull;
      const meta = api && typeof api.get === 'function' ? api.get()?.meta : null;
      if(meta && typeof meta === 'object') return meta;
    }catch(_){ }
    try{
      const meta = DATA?.tkbConstraints?.meta;
      if(meta && typeof meta === 'object') return meta;
    }catch(_){ }
    return {};
  }

  function getStoredSchoolName(){
    const meta = getInfoMeta();
    const fromInfo = safe(meta.schoolName || meta.schoolLabel || meta.tenTruong || meta.school);
    if(fromInfo) return fromInfo;

    let sid = '';
    try{ sid = safe(window.__TKB_SCHOOL_CONTEXT?.sid); }catch(_){ }
    try{ if(!sid && typeof schoolParam !== 'undefined') sid = safe(schoolParam); }catch(_){ }

    const names = parseJson(localStorage.getItem('TKB_SCHOOL_NAMES'), {});
    const mapped = safe(names && sid ? names[sid] : '');
    if(mapped) return mapped;

    const lastSid = safe(localStorage.getItem('TKB_LAST_SCHOOL'));
    const lastLabel = safe(localStorage.getItem('TKB_LAST_SCHOOL_LABEL'));
    if(lastLabel && (!sid || lastSid === sid) && lastLabel !== sid) return lastLabel;

    try{
      const ctxLabel = safe(window.__TKB_SCHOOL_CONTEXT?.label);
      if(ctxLabel && ctxLabel !== sid) return ctxLabel;
    }catch(_){ }
    return 'Tên trường';
  }

  function schoolTitle(value){
    const name = safe(value);
    if(!name) return 'Trường';
    return /^trường\b/i.test(name) ? name : `Trường ${name}`;
  }

  function getScheduleNumber(){
    const meta = getInfoMeta();
    return safe(meta.scheduleNumber || meta.scheduleNo || meta.tkbNumber) || '1';
  }

  function getEffectiveDate(){
    const meta = getInfoMeta();
    return displayDate(meta.effectiveDate || meta.applyDate || meta.ngayApDung || '');
  }

  function classDisplay(lop){
    try{
      if(typeof classCanonFromLop === 'function') return safe(classCanonFromLop(lop));
    }catch(_){ }
    return safe(lop?.ten2 || lop?.ten || lop?.id);
  }

  function currentClassIdForExport(){
    try{ if(safe(currentLop)) return safe(currentLop); }catch(_){ }
    try{ return safe(getFilteredLops()?.[0]?.id); }catch(_){ }
    try{ return safe((DATA.lop || [])[0]?.id); }catch(_){ }
    return '';
  }

  function currentClassRecord(id){
    try{ return (DATA.lop || []).find(l => String(l?.id || '') === String(id || '')) || null; }catch(_){ }
    return null;
  }

  function allClassRecordsForExport(){
    const lops = Array.isArray(DATA?.lop) ? DATA.lop.slice() : [];
    if(typeof compareClassByDataOrder === 'function'){
      lops.sort(compareClassByDataOrder);
    }
    if(lops.length) return lops;
    return Object.keys(DATA?.tkb || {}).map(id => ({id, ten:id}));
  }

  function findClassTkb(lop){
    const tkbs = DATA?.tkb || {};
    const candidates = [
      lop?.id,
      lop?.ten,
      lop?.ten2,
      classDisplay(lop)
    ].map(v => safe(v)).filter(Boolean);
    for(const key of candidates){
      if(tkbs[key]) return tkbs[key];
    }
    return null;
  }

  function monShort(mon){
    try{ return safe(getMonShort(mon)); }catch(_){ return safe(mon); }
  }

  function lessonText(raw){
    if(!raw || raw === 'OFF') return '';
    let mon = '';
    try{ mon = safe(cellMon(raw)); }catch(_){ mon = safe(raw?.mon || raw); }
    return mon ? monShort(mon) : '';
  }

  function classCanonForTeacherLookup(lop){
    const classId = safe(lop?.id);
    const display = classDisplay(lop) || classId;
    try{
      if(typeof getLopCanonById === 'function') return safe(getLopCanonById(classId)) || display;
    }catch(_){ }
    return display;
  }

  function lessonTeacherText(lop, raw){
    if(!raw || raw === 'OFF') return '';
    let mon = '';
    try{ mon = safe(cellMon(raw)); }catch(_){ mon = safe(raw?.mon || raw); }
    if(!mon) return '';
    const subject = monShort(mon);
    let teachers = '';
    try{ teachers = getTeacherForClassMon(classCanonForTeacherLookup(lop), mon); }catch(_){ teachers = ''; }
    const teacherText = teacherCodesFromValue(teachers).map(code => teacherShort(code)).filter(Boolean).join('.');
    return teacherText ? `${subject}-${teacherText}` : subject;
  }

  function dayShortLabel(dayKey, fallback){
    const byKey = {
      thu2: 'T2', thu3: 'T3', thu4: 'T4', thu5: 'T5', thu6: 'T6', thu7: 'T7',
      cn: 'CN', sunday: 'CN'
    };
    if(byKey[dayKey]) return byKey[dayKey];
    const label = safe(fallback || dayKey).toUpperCase();
    const digit = label.match(/([2-7])/)?.[1];
    return digit ? `T${digit}` : label;
  }

  function dayNumberLabel(dayKey, fallback){
    const short = dayShortLabel(dayKey, fallback);
    const digit = safe(short).match(/([2-7])/)?.[1];
    return digit || safe(short || fallback || dayKey);
  }

  function classSchedulePayload(lop){
    const classId = safe(lop?.id);
    const tkb = findClassTkb(lop);
    const days = (typeof DAYS !== 'undefined' && Array.isArray(DAYS) && DAYS.length) ? DAYS.slice(0, 6) : ['thu2','thu3','thu4','thu5','thu6','thu7'];
    const dayLabels = days.map(d => {
      let label = d;
      try{ label = LABEL?.[d] || d; }catch(_){ }
      return dayShortLabel(d, label);
    });
    const rowFor = (session, count) => {
      const rows = [];
      const limit = Math.min(5, Math.max(0, Number(count || 0) || 5));
      for(let ti = 0; ti < limit; ti++){
        rows.push(days.map(d => lessonText(tkb?.[d]?.[session]?.[ti])));
      }
      while(rows.length < 5) rows.push(days.map(() => ''));
      return rows;
    };
    return {
      schoolName: getStoredSchoolName(),
      scheduleNumber: getScheduleNumber(),
      effectiveDate: getEffectiveDate(),
      className: classDisplay(lop) || classId,
      dayLabels,
      morning: rowFor('sang', typeof SANG !== 'undefined' ? SANG : 5),
      afternoon: rowFor('chieu', typeof CHIEU !== 'undefined' ? CHIEU : 5)
    };
  }

  function allClassSchedulePayloads(){
    const lops = allClassRecordsForExport();
    if(!lops.length) throw new Error('Chưa có lớp để xuất Excel.');
    return lops.map(lop => classSchedulePayload(lop));
  }

  function schoolClassSchedulePayload(lop){
    const classId = safe(lop?.id);
    const tkb = findClassTkb(lop);
    const days = (typeof DAYS !== 'undefined' && Array.isArray(DAYS) && DAYS.length) ? DAYS.slice(0, 6) : ['thu2','thu3','thu4','thu5','thu6','thu7'];
    const dayLabels = days.map(d => {
      let label = d;
      try{ label = LABEL?.[d] || d; }catch(_){ }
      return dayNumberLabel(d, label);
    });
    const rowFor = session => {
      const rows = [];
      for(let ti = 0; ti < 5; ti++){
        rows.push(days.map(d => lessonTeacherText(lop, tkb?.[d]?.[session]?.[ti])));
      }
      return rows;
    };
    return {
      schoolName: getStoredSchoolName(),
      scheduleNumber: getScheduleNumber(),
      effectiveDate: getEffectiveDate(),
      className: classDisplay(lop) || classId,
      dayLabels,
      morning: rowFor('sang'),
      afternoon: rowFor('chieu')
    };
  }

  function allSchoolClassSchedulePayloads(){
    const lops = allClassRecordsForExport();
    if(!lops.length) throw new Error('Chưa có lớp để xuất Excel toàn trường.');
    return lops.map(lop => schoolClassSchedulePayload(lop));
  }

  function teacherCode(input){
    try{
      if(typeof resolveTeacherCode === 'function') return safe(resolveTeacherCode(input));
    }catch(_){ }
    return safe(input);
  }

  function teacherCodesFromValue(raw){
    try{
      if(typeof teacherListFromValue === 'function') return teacherListFromValue(raw).map(teacherCode).filter(Boolean);
    }catch(_){ }
    const parts = Array.isArray(raw) ? raw : safe(raw).replace(/\r?\n/g, ',').replace(/[;+]/g, ',').split(',');
    const out = [];
    const seen = new Set();
    parts.forEach(item => {
      const code = teacherCode(item);
      const key = code.toLowerCase();
      if(!code || seen.has(key)) return;
      seen.add(key);
      out.push(code);
    });
    return out;
  }

  function teacherValueContains(raw, code){
    try{
      if(typeof teacherValueHas === 'function') return teacherValueHas(raw, code);
    }catch(_){ }
    const target = teacherCode(code).toLowerCase();
    return !!target && teacherCodesFromValue(raw).some(x => x.toLowerCase() === target);
  }

  function teacherShort(code){
    try{
      if(typeof getTeacherShort === 'function') return safe(getTeacherShort(code));
    }catch(_){ }
    return teacherCode(code);
  }

  function teacherFullName(code){
    try{
      if(typeof getTeacherNameByCode === 'function') return safe(getTeacherNameByCode(code));
    }catch(_){ }
    return '';
  }

  function teacherDisplayLabel(code, record){
    const short = teacherShort(code) || teacherCode(code);
    const full = safe(record?.name) || teacherFullName(code);
    if(full && short && full.toLowerCase() !== short.toLowerCase()) return `${full} (${short})`;
    return full || short || teacherCode(code);
  }

  function teacherNameOnly(code, record){
    return safe(record?.name) || teacherFullName(code) || teacherShort(code) || teacherCode(code);
  }

  function addTeacherRecord(map, code, name){
    const resolved = teacherCode(code);
    if(!resolved) return;
    const key = resolved.toLowerCase();
    if(map.has(key)) return;
    map.set(key, {code: resolved, name: safe(name) || teacherFullName(resolved)});
  }

  function allTeacherRecordsForExport(){
    const map = new Map();
    (Array.isArray(DATA?.giaovien) ? DATA.giaovien : []).forEach(g => {
      const code = teacherCode(g?.magv || g?.code || g?.id);
      addTeacherRecord(map, code, teacherFullName(code));
    });
    Object.values(DATA?.pccmMatrix || {}).forEach(value => {
      teacherCodesFromValue(value).forEach(code => addTeacherRecord(map, code));
    });
    allClassRecordsForExport().forEach(lop => {
      const classId = safe(lop?.id);
      const tkb = findClassTkb(lop);
      if(!tkb) return;
      let classCanon = classDisplay(lop) || classId;
      try{
        if(typeof getLopCanonById === 'function') classCanon = safe(getLopCanonById(classId)) || classCanon;
      }catch(_){ }
      const days = (typeof DAYS !== 'undefined' && Array.isArray(DAYS) && DAYS.length) ? DAYS.slice(0, 6) : ['thu2','thu3','thu4','thu5','thu6','thu7'];
      days.forEach(thu => {
        ['sang', 'chieu'].forEach(session => {
          (tkb?.[thu]?.[session] || []).forEach(raw => {
            if(!raw || raw === 'OFF') return;
            let mon = '';
            try{ mon = safe(cellMon(raw)); }catch(_){ mon = safe(raw?.mon || raw); }
            if(!mon) return;
            let teachers = '';
            try{ teachers = getTeacherForClassMon(classCanon, mon); }catch(_){ teachers = ''; }
            teacherCodesFromValue(teachers).forEach(code => addTeacherRecord(map, code));
          });
        });
      });
    });
    const arr = Array.from(map.values()).filter(x => x.code);
    if(typeof compareTeacherCodeByDataOrder === 'function'){
      arr.sort(compareTeacherCodeByDataOrder);
    }else{
      arr.sort((a,b) => String(a.code || '').localeCompare(String(b.code || ''), 'vi'));
    }
    return arr;
  }

  function buildTeacherScheduleForExport(gvCode){
    const code = teacherCode(gvCode);
    const days = (typeof DAYS !== 'undefined' && Array.isArray(DAYS) && DAYS.length) ? DAYS.slice(0, 6) : ['thu2','thu3','thu4','thu5','thu6','thu7'];
    const morningCount = Math.min(5, Math.max(0, Number(typeof SANG !== 'undefined' ? SANG : 5) || 5));
    const afternoonCount = Math.min(5, Math.max(0, Number(typeof CHIEU !== 'undefined' ? CHIEU : 5) || 5));
    const sched = {};
    days.forEach(d => {
      sched[d] = {
        sang: Array.from({length: 5}, () => []),
        chieu: Array.from({length: 5}, () => [])
      };
    });
    allClassRecordsForExport().forEach(lop => {
      const classId = safe(lop?.id);
      const tkb = findClassTkb(lop);
      if(!tkb) return;
      const display = classDisplay(lop) || classId;
      let classCanon = display;
      try{
        if(typeof getLopCanonById === 'function') classCanon = safe(getLopCanonById(classId)) || classCanon;
      }catch(_){ }
      days.forEach(thu => {
        for(let ti = 0; ti < morningCount; ti++){
          const raw = tkb?.[thu]?.sang?.[ti];
          if(!raw || raw === 'OFF') continue;
          let mon = '';
          try{ mon = safe(cellMon(raw)); }catch(_){ mon = safe(raw?.mon || raw); }
          if(!mon) continue;
          let teachers = '';
          try{ teachers = getTeacherForClassMon(classCanon, mon); }catch(_){ teachers = ''; }
          if(teacherValueContains(teachers, code)) sched[thu].sang[ti].push({classDisplay: display, mon});
        }
        for(let ti = 0; ti < afternoonCount; ti++){
          const raw = tkb?.[thu]?.chieu?.[ti];
          if(!raw || raw === 'OFF') continue;
          let mon = '';
          try{ mon = safe(cellMon(raw)); }catch(_){ mon = safe(raw?.mon || raw); }
          if(!mon) continue;
          let teachers = '';
          try{ teachers = getTeacherForClassMon(classCanon, mon); }catch(_){ teachers = ''; }
          if(teacherValueContains(teachers, code)) sched[thu].chieu[ti].push({classDisplay: display, mon});
        }
      });
    });
    return {days, sched};
  }

  function teacherLessonText(entries){
    const arr = Array.isArray(entries) ? entries : [];
    return arr.map(e => [safe(e.classDisplay), monShort(e.mon)].filter(Boolean).join(' - ')).filter(Boolean).join('; ');
  }

  function uniqueJoined(values){
    const out = [];
    const seen = new Set();
    values.forEach(value => {
      const text = safe(value);
      const key = text.toLowerCase();
      if(!text || seen.has(key)) return;
      seen.add(key);
      out.push(text);
    });
    return out.join('; ');
  }

  function teacherLessonClassText(entries){
    const arr = Array.isArray(entries) ? entries : [];
    return uniqueJoined(arr.map(e => e.classDisplay));
  }

  function teacherPeriodCount(sched, days){
    let total = 0;
    (days || []).forEach(day => {
      ['sang', 'chieu'].forEach(session => {
        (sched?.[day]?.[session] || []).forEach(entries => {
          total += Array.isArray(entries) ? entries.length : 0;
        });
      });
    });
    return total;
  }

  function teacherHomeroom(code){
    const fields = [
      'gvcn', 'GVCN', 'magvcn', 'maGVCN',
      'chuNhiem', 'chunhiem', 'chu_nhiem',
      'giaoVienChuNhiem', 'giaovienchunhiem',
      'homeroomTeacher', 'teacherHomeroom'
    ];
    const matches = [];
    (Array.isArray(DATA?.lop) ? DATA.lop : []).forEach(lop => {
      const hit = fields.some(field => {
        const value = lop && lop[field];
        return value && teacherValueContains(value, code);
      });
      if(hit) matches.push(classDisplay(lop) || safe(lop?.id));
    });
    return uniqueJoined(matches);
  }

  function teacherSchedulePayload(record){
    const code = teacherCode(record?.code || record);
    const {days, sched} = buildTeacherScheduleForExport(code);
    const dayLabels = days.map(d => {
      let label = d;
      try{ label = LABEL?.[d] || d; }catch(_){ }
      return dayShortLabel(d, label);
    });
    const rowFor = session => {
      const rows = [];
      for(let ti = 0; ti < 5; ti++){
        rows.push(days.map(d => teacherLessonText(sched?.[d]?.[session]?.[ti])));
      }
      return rows;
    };
    const label = teacherDisplayLabel(code, record);
    return {
      schoolName: getStoredSchoolName(),
      scheduleNumber: getScheduleNumber(),
      effectiveDate: getEffectiveDate(),
      className: label,
      infoLine: `  - Giáo viên : ${label}`,
      dayLabels,
      morning: rowFor('sang'),
      afternoon: rowFor('chieu')
    };
  }

  function allTeacherSchedulePayloads(){
    const teachers = allTeacherRecordsForExport();
    if(!teachers.length) throw new Error('Chưa có giáo viên để xuất Excel.');
    return teachers.map(teacherSchedulePayload);
  }

  function schoolTeacherSchedulePayload(record){
    const code = teacherCode(record?.code || record?.magv || record);
    const {days, sched} = buildTeacherScheduleForExport(code);
    const dayLabels = days.map(d => {
      let label = d;
      try{ label = LABEL?.[d] || d; }catch(_){ }
      return dayNumberLabel(d, label);
    });
    const rowFor = session => {
      const rows = [];
      for(let ti = 0; ti < 5; ti++){
        rows.push(days.map(d => teacherLessonText(sched?.[d]?.[session]?.[ti])));
      }
      return rows;
    };
    return {
      schoolName: getStoredSchoolName(),
      scheduleNumber: getScheduleNumber(),
      effectiveDate: getEffectiveDate(),
      className: teacherShort(code) || teacherCode(code),
      dayLabels,
      morning: rowFor('sang'),
      afternoon: rowFor('chieu')
    };
  }

  function allSchoolTeacherSchedulePayloads(){
    const teachers = allTeacherRecordsForExport();
    if(!teachers.length) throw new Error('Chưa có giáo viên để xuất Excel toàn trường theo giáo viên.');
    return teachers.map(teacher => schoolTeacherSchedulePayload(teacher));
  }

  function teacherTemplate1Payload(record){
    const code = teacherCode(record?.code || record);
    const {days, sched} = buildTeacherScheduleForExport(code);
    const dayLabels = days.map(d => {
      let label = d;
      try{ label = LABEL?.[d] || d; }catch(_){ }
      return dayShortLabel(d, label);
    });
    const rowFor = session => {
      const rows = [];
      for(let ti = 0; ti < 5; ti++){
        rows.push(days.map(d => teacherLessonClassText(sched?.[d]?.[session]?.[ti])));
      }
      return rows;
    };
    return {
      schoolName: getStoredSchoolName(),
      scheduleNumber: getScheduleNumber(),
      effectiveDate: getEffectiveDate(),
      teacherName: teacherDisplayLabel(code, record),
      periodCount: teacherPeriodCount(sched, days),
      dayLabels,
      morning: rowFor('sang'),
      afternoon: rowFor('chieu')
    };
  }

  function allTeacherTemplate1Payloads(){
    const teachers = allTeacherRecordsForExport();
    if(!teachers.length) throw new Error('Chưa có giáo viên để xuất Excel.');
    return teachers.map(teacherTemplate1Payload);
  }

  function cellAddr(r, c){
    return XLSX.utils.encode_cell({r, c});
  }

  function ensureCell(ws, r, c){
    const addr = cellAddr(r, c);
    ws[addr] = ws[addr] || {t:'s', v:''};
    return ws[addr];
  }

  function setCell(ws, r, c, value, style){
    const target = ensureCell(ws, r, c);
    target.v = value == null ? '' : value;
    target.t = typeof value === 'number' ? 'n' : 's';
    target.s = style;
    delete target.w;
    return target;
  }

  function merge(ws, sRow, sCol, eRow, eCol){
    ws['!merges'] = ws['!merges'] || [];
    ws['!merges'].push({s:{r:sRow, c:sCol}, e:{r:eRow, c:eCol}});
  }

  function border(style){
    const edge = {style: style || 'thin', color:{rgb:THIN_BORDER_COLOR}};
    return {top:edge, bottom:edge, left:edge, right:edge};
  }

  function bottomBorder(style){
    const edge = {style: style || 'thin', color:{rgb:THIN_BORDER_COLOR}};
    return {bottom:edge};
  }

  function style(fontSize, opts){
    opts = opts || {};
    const alignment = {
      horizontal: opts.align || 'center',
      vertical: 'center',
      wrapText: opts.wrap === false ? false : true
    };
    if(opts.shrink) alignment.shrinkToFit = true;
    if(opts.rotation != null) alignment.textRotation = Number(opts.rotation);
    return {
      font: {
        name: FONT_NAME,
        sz: Number(fontSize || 8),
        bold: !!opts.bold,
        italic: !!opts.italic,
        color: {rgb:'FF000000'}
      },
      alignment,
      fill: {patternType:'solid', fgColor:{rgb: opts.fill || 'FFFFFFFF'}},
      border: opts.border === false
        ? undefined
        : opts.border === 'bottom'
          ? bottomBorder(opts.borderStyle || 'thin')
          : border(opts.borderStyle || 'thin')
    };
  }

  const styles = {
    header: style(8, {bold:true, border:false}),
    classLine: style(8, {align:'left', border:false}),
    tableTiny: style(6, {wrap:false, shrink:true}),
    session: style(8, {wrap:false, shrink:true, rotation:90}),
    blankTable: style(6),
    schoolClassTitle: style(9, {bold:true, border:'bottom', wrap:false, shrink:true}),
    schoolClassHeader: style(8, {bold:true, wrap:false, shrink:true}),
    schoolClassLabel: style(8, {wrap:false, shrink:true}),
    schoolClassCell: style(8, {wrap:false, shrink:true}),
    teacher1Header: style(8, {bold:true, border:false, shrink:true}),
    teacher1Info: style(8, {align:'left', border:false, wrap:false, shrink:true}),
    teacher1Table: style(8, {wrap:false, shrink:true}),
    teacher1Session: style(8, {wrap:false, shrink:true, rotation:90}),
  };

  function schoolClassTitle(data){
    const number = safe(data?.scheduleNumber || getScheduleNumber()) || '1';
    const date = safe(data?.effectiveDate || getEffectiveDate()).replace(/[/.]/g, '-');
    return `THỜI KHÓA BIỂU SỐ ${number} ÁP DỤNG NGÀY ${date}`;
  }

  function schoolClassColumnCount(classCount){
    return Math.max(SCHOOL_CLASS_PAGE_COLS, 3 + Math.max(0, Number(classCount || 0)));
  }

  function schoolClassColumnWidths(colCount){
    return Array.from({length: Math.max(1, Number(colCount || SCHOOL_CLASS_PAGE_COLS))}, (_unused, index) => ({
      wch: index < 3 ? SCHOOL_CLASS_META_COL_WIDTH : SCHOOL_CLASS_DATA_COL_WIDTH
    }));
  }

  function applySchoolClassPage(ws, chunk, top, totalCols){
    const slotCount = Math.max(SCHOOL_CLASS_CLASSES_PER_PAGE, Array.isArray(chunk) ? chunk.length : 0);
    const lastCol = Math.max(Number(totalCols || 0), 3 + slotCount, SCHOOL_CLASS_PAGE_COLS) - 1;
    const titleLastCol = Math.min(SCHOOL_CLASS_TITLE_LAST_COL, lastCol);
    merge(ws, top, 0, top, titleLastCol);
    setCell(ws, top, 0, schoolClassTitle(chunk[0] || {}), styles.schoolClassTitle);
    for(let c = 1; c <= titleLastCol; c++){
      setCell(ws, top, c, '', styles.schoolClassTitle);
    }

    for(let r = top + 1; r < top + SCHOOL_CLASS_PAGE_ROWS; r++){
      for(let c = 0; c <= lastCol; c++){
        setCell(ws, r, c, '', styles.schoolClassCell);
      }
    }

    setCell(ws, top + 1, 0, 'Thứ', styles.schoolClassHeader);
    setCell(ws, top + 1, 1, 'Buổi', styles.schoolClassHeader);
    setCell(ws, top + 1, 2, 'Tiết', styles.schoolClassHeader);
    for(let i = 0; i < slotCount; i++){
      setCell(ws, top + 1, 3 + i, chunk[i]?.className || '', styles.schoolClassHeader);
    }

    const dayLabels = chunk[0]?.dayLabels?.length ? chunk[0].dayLabels.slice(0, 6) : ['2','3','4','5','6','7'];
    dayLabels.forEach((label, dayIndex) => {
      const dayTop = top + 2 + dayIndex * 10;
      merge(ws, dayTop, 0, dayTop + 9, 0);
      merge(ws, dayTop, 1, dayTop + 4, 1);
      merge(ws, dayTop + 5, 1, dayTop + 9, 1);
      setCell(ws, dayTop, 0, label, styles.schoolClassLabel);
      setCell(ws, dayTop, 1, 'Sáng', styles.schoolClassLabel);
      setCell(ws, dayTop + 5, 1, 'Chiều', styles.schoolClassLabel);
      for(let period = 0; period < 5; period++){
        setCell(ws, dayTop + period, 2, period + 1, styles.schoolClassLabel);
        setCell(ws, dayTop + 5 + period, 2, period + 1, styles.schoolClassLabel);
        for(let classIndex = 0; classIndex < slotCount; classIndex++){
          const payload = chunk[classIndex];
          setCell(ws, dayTop + period, 3 + classIndex, payload?.morning?.[period]?.[dayIndex] || '', styles.schoolClassCell);
          setCell(ws, dayTop + 5 + period, 3 + classIndex, payload?.afternoon?.[period]?.[dayIndex] || '', styles.schoolClassCell);
        }
      }
    });
  }

  function buildSchoolClassWorkbook(payloads){
    if(!window.XLSX) throw new Error('Chưa tải được thư viện Excel XLSX.');
    const data = Array.isArray(payloads) ? payloads : [payloads].filter(Boolean);
    const pageCount = 1;
    const totalRows = SCHOOL_CLASS_PAGE_ROWS;
    const totalCols = schoolClassColumnCount(data.length);
    const lastColName = XLSX.utils.encode_col(totalCols - 1);
    const printRange = `$A$1:$${lastColName}$${totalRows}`;
    const rows = Array.from({length: totalRows}, () => Array.from({length: totalCols}, () => ''));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:totalRows - 1, c:totalCols - 1}});
    ws['!cols'] = schoolClassColumnWidths(totalCols);
    ws['!rows'] = Array.from({length: totalRows}, () => ({hpt:SCHOOL_CLASS_ROW_HEIGHT}));
    ws['!margins'] = {left:0.2, right:0.2, top:0.25, bottom:0.25, header:0, footer:0};
    ws['!views'] = [{showGridLines:false}];
    ws['!pageSetup'] = {paperSize:8, orientation:'landscape', scale:100};

    applySchoolClassPage(ws, data, 0, totalCols);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SCHOOL_CLASS_SHEET_NAME);
    wb.Workbook = wb.Workbook || {};
    wb.Workbook.Names = [
      {Name:'_xlnm.Print_Area', Sheet:0, Ref:`'${SCHOOL_CLASS_SHEET_NAME}'!${printRange}`}
    ];
    return {
      wb,
      pageCount,
      pageRows: SCHOOL_CLASS_PAGE_ROWS,
      orientation: 'landscape',
      scale: 100,
      print: SCHOOL_CLASS_PRINT,
      printArea: {sheetName:SCHOOL_CLASS_SHEET_NAME, range:printRange}
    };
  }

  function applyCard(ws, data, top, left){
    const fullLeft = left;
    const fullRight = left + 9;
    [1, 2, 3, 4].forEach(offset => merge(ws, top + offset, fullLeft, top + offset, fullRight));
    merge(ws, top + 7, left + 1, top + 11, left + 1);
    merge(ws, top + 12, left + 1, top + 16, left + 1);

    setCell(ws, top + 1, left, schoolTitle(data.schoolName), styles.header);
    setCell(ws, top + 2, left, `TKB số: ${data.scheduleNumber}`, styles.header);
    setCell(ws, top + 3, left, `(Từ ${data.effectiveDate})`, styles.header);
    setCell(ws, top + 4, left, data.infoLine || `  - Tên lớp    : ${data.className}`, styles.classLine);

    for(let r = top + 6; r <= top + 16; r++){
      for(let c = left + 1; c <= left + 8; c++){
        setCell(ws, r, c, '', styles.blankTable);
      }
    }

    data.dayLabels.slice(0, 6).forEach((label, idx) => {
      setCell(ws, top + 6, left + 3 + idx, label, styles.tableTiny);
    });
    setCell(ws, top + 6, left + 1, 'Buổi', styles.tableTiny);
    setCell(ws, top + 6, left + 2, 'Tiết', styles.tableTiny);

    setCell(ws, top + 7, left + 1, 'SÁNG', styles.session);
    setCell(ws, top + 12, left + 1, 'CHIỀU', styles.session);
    for(let i = 0; i < 5; i++){
      setCell(ws, top + 7 + i, left + 2, `S${i + 1}`, styles.tableTiny);
      setCell(ws, top + 12 + i, left + 2, `C${i + 1}`, styles.tableTiny);
      for(let d = 0; d < 6; d++){
        setCell(ws, top + 7 + i, left + 3 + d, data.morning?.[i]?.[d] || '', styles.tableTiny);
        setCell(ws, top + 12 + i, left + 3 + d, data.afternoon?.[i]?.[d] || '', styles.tableTiny);
      }
    }
  }

  function cardPosition(index){
    const inPage = index % CARDS_PER_PAGE;
    const rowIndex = Math.floor(inPage / CARD_START_COLS.length);
    const colIndex = inPage % CARD_START_COLS.length;
    return {
      top: Math.floor(index / CARDS_PER_PAGE) * PAGE_ROWS + CARD_START_ROWS[rowIndex],
      left: CARD_START_COLS[colIndex]
    };
  }

  function buildWorkbook(payloads){
    if(!window.XLSX) throw new Error('Chưa tải được thư viện Excel XLSX.');
    const data = Array.isArray(payloads) ? payloads : [payloads].filter(Boolean);
    const pageCount = Math.max(1, Math.ceil(data.length / CARDS_PER_PAGE));
    const totalRows = pageCount * PAGE_ROWS;
    const rows = Array.from({length: totalRows}, () => Array.from({length: PAGE_COLS}, () => ''));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:totalRows - 1, c:PAGE_COLS - 1}});
    ws['!cols'] = SAMPLE_COL_WIDTHS.map(wch => ({wch}));

    const heights = Array.from({length: totalRows}, () => ({hpt:10.05}));
    const rowHeightMap = {
      0:10.05, 1:13.05, 2:13.05, 3:13.05, 4:12, 5:13.05, 6:9,
      7:10.05, 8:9, 9:9, 10:9, 11:9, 12:10.05, 13:9, 14:9, 15:9, 16:10.05,
      17:10.05, 18:2
    };
    for(let page = 0; page < pageCount; page++){
      const pageTop = page * PAGE_ROWS;
      CARD_START_ROWS.forEach(top => {
        Object.entries(rowHeightMap).forEach(([offset, hpt]) => {
          const index = pageTop + top + Number(offset);
          if(index < heights.length) heights[index] = {hpt};
        });
      });
    }
    ws['!rows'] = heights;
    ws['!margins'] = {left:PRINT_MARGIN, right:PRINT_MARGIN, top:PRINT_MARGIN, bottom:PRINT_MARGIN, header:0, footer:0};
    ws['!views'] = [{showGridLines:false}];
    ws['!pageSetup'] = {paperSize:9, orientation:'portrait', fitToWidth:1, fitToHeight:0};

    data.forEach((payload, index) => {
      const pos = cardPosition(index);
      applyCard(ws, payload, pos.top, pos.left);
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    return {wb, pageCount, pageRows: PAGE_ROWS};
  }

  function applyTeacher1Card(ws, data, top, left){
    const fullRight = left + 7;
    [0, 1, 2, 4, 5].forEach(offset => merge(ws, top + offset, left, top + offset, fullRight));
    merge(ws, top + 8, left, top + 12, left);
    merge(ws, top + 13, left, top + 17, left);

    setCell(ws, top, left, schoolTitle(data.schoolName), styles.teacher1Header);
    setCell(ws, top + 1, left, `TKB số: ${data.scheduleNumber}`, styles.teacher1Header);
    setCell(ws, top + 2, left, `(Từ ${data.effectiveDate})`, styles.teacher1Header);
    setCell(ws, top + 4, left, `- Giáo viên : ${data.teacherName || ''}`, styles.teacher1Info);
    setCell(ws, top + 5, left, `  - Số tiết dạy         : ${Number(data.periodCount || 0)}`, styles.teacher1Info);

    for(let r = top + 7; r <= top + 17; r++){
      for(let c = left; c <= left + 7; c++){
        setCell(ws, r, c, '', styles.teacher1Table);
      }
    }
    data.dayLabels.slice(0, 6).forEach((label, idx) => {
      setCell(ws, top + 7, left + 2 + idx, label, styles.teacher1Table);
    });
    setCell(ws, top + 8, left, 'SÁNG', styles.teacher1Session);
    setCell(ws, top + 13, left, 'CHIỀU', styles.teacher1Session);
    for(let i = 0; i < 5; i++){
      setCell(ws, top + 8 + i, left + 1, i + 1, styles.teacher1Table);
      setCell(ws, top + 13 + i, left + 1, i + 1, styles.teacher1Table);
      for(let d = 0; d < 6; d++){
        setCell(ws, top + 8 + i, left + 2 + d, data.morning?.[i]?.[d] || '', styles.teacher1Table);
        setCell(ws, top + 13 + i, left + 2 + d, data.afternoon?.[i]?.[d] || '', styles.teacher1Table);
      }
    }
  }

  function teacher1CardPosition(index){
    const inPage = index % TEACHER1_CARDS_PER_PAGE;
    const rowIndex = Math.floor(inPage / TEACHER1_CARD_START_COLS.length);
    const colIndex = inPage % TEACHER1_CARD_START_COLS.length;
    return {
      top: Math.floor(index / TEACHER1_CARDS_PER_PAGE) * TEACHER1_PAGE_ROWS + TEACHER1_CARD_START_ROWS[rowIndex],
      left: TEACHER1_CARD_START_COLS[colIndex]
    };
  }

  function buildTeacher1Workbook(payloads){
    if(!window.XLSX) throw new Error('Chưa tải được thư viện Excel XLSX.');
    const data = Array.isArray(payloads) ? payloads : [payloads].filter(Boolean);
    const pageCount = Math.max(1, Math.ceil(data.length / TEACHER1_CARDS_PER_PAGE));
    const totalRows = pageCount * TEACHER1_PAGE_ROWS;
    const ws = {};
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:totalRows - 1, c:TEACHER1_PAGE_COLS - 1}});
    ws['!cols'] = TEACHER1_COL_WIDTHS.map(wch => ({wch}));
    ws['!rows'] = Array.from({length: totalRows}, (_row, index) => ({hpt: TEACHER1_ROW_HEIGHTS[index % TEACHER1_PAGE_ROWS] || 12}));
    ws['!margins'] = {left:PRINT_MARGIN, right:PRINT_MARGIN, top:PRINT_MARGIN, bottom:PRINT_MARGIN, header:0, footer:0};
    ws['!views'] = [{showGridLines:false}];
    ws['!pageSetup'] = {paperSize:9, orientation:'landscape', scale:100};

    data.forEach((payload, index) => {
      const pos = teacher1CardPosition(index);
      applyTeacher1Card(ws, payload, pos.top, pos.left);
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    return {wb, pageCount, pageRows: TEACHER1_PAGE_ROWS, orientation:'landscape', scale:100};
  }

  function buildRowBreaksXml(pageCount, pageRows){
    const count = Math.max(1, Number(pageCount || 1));
    const rowsPerPage = Math.max(1, Number(pageRows || PAGE_ROWS));
    const breaks = [];
    for(let page = 1; page < count; page++){
      breaks.push(`<brk id="${page * rowsPerPage}" max="16383" man="1"/>`);
    }
    if(!breaks.length) return '';
    return `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.join('')}</rowBreaks>`;
  }

  function insertBeforeWorksheetEnd(xml, block){
    const clean = String(xml || '');
    const pos = clean.lastIndexOf('</worksheet>');
    if(pos < 0) return clean + block;
    return clean.slice(0, pos) + block + clean.slice(pos);
  }

  function upsertSheetPr(xml, fitToPage){
    if(/<sheetPr[\s\S]*?<\/sheetPr>/.test(xml)){
      return xml.replace(/<sheetPr([\s\S]*?)<\/sheetPr>/, value => {
        const without = value.replace(/<pageSetUpPr\b[^>]*\/>/g, '');
        if(!fitToPage) return without;
        return without.replace('</sheetPr>', '<pageSetUpPr fitToPage="1"/></sheetPr>');
      });
    }
    if(!fitToPage) return xml;
    const worksheetStart = xml.indexOf('<worksheet');
    const pos = worksheetStart >= 0 ? xml.indexOf('>', worksheetStart) + 1 : -1;
    if(pos <= 0) return xml;
    return `${xml.slice(0, pos)}<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${xml.slice(pos)}`;
  }

  function normalizeInlineStringCells(xml){
    return String(xml || '').replace(
      /<c\b([^>]*)\bt="str"([^>]*)>\s*<v([^>]*)>([\s\S]*?)<\/v>\s*<\/c>/g,
      (_match, beforeType, afterType, valueAttrs, valueText) => {
        let textAttrs = valueAttrs || '';
        if(!/\bxml:space=/.test(textAttrs) && (/^\s|\s$/.test(valueText || ''))){
          textAttrs += ' xml:space="preserve"';
        }
        return `<c${beforeType}t="inlineStr"${afterType}><is><t${textAttrs}>${valueText || ''}</t></is></c>`;
      }
    );
  }

  function patchWorksheetXml(xml, pageCount, pageRows, orientation, scale, print){
    const printConfig = print || {};
    const useFixedScale = Number(scale || 0) === 100;
    let next = upsertSheetPr(String(xml || ''), !useFixedScale);
    next = normalizeInlineStringCells(next);
    next = next.replace(/<sheetView\b(?![^>]*showGridLines=)/g, '<sheetView showGridLines="0"');
    next = next.replace(/<printOptions\b[^>]*\/>/g, '');
    next = next.replace(/<pageMargins\b[^>]*\/>/g, '');
    next = next.replace(/<pageSetup\b[^>]*\/>/g, '');
    next = next.replace(/<rowBreaks[\s\S]*?<\/rowBreaks>/g, '');
    next = next.replace(/<ignoredErrors\b[\s\S]*?<\/ignoredErrors>|<ignoredErrors\b[^>]*\/>/g, '');
    const margins = printConfig.margins || {
      left: PRINT_MARGIN_XML,
      right: PRINT_MARGIN_XML,
      top: PRINT_MARGIN_XML,
      bottom: PRINT_MARGIN_XML,
      header: '0',
      footer: '0'
    };
    const paperSize = String(printConfig.paperSize || 9);
    const centerBlock = printConfig.centered === false ? '' : '<printOptions horizontalCentered="1" verticalCentered="1"/>';
    const block = [
      centerBlock,
      `<pageMargins left="${margins.left}" right="${margins.right}" top="${margins.top}" bottom="${margins.bottom}" header="${margins.header}" footer="${margins.footer}"/>`,
      useFixedScale
        ? `<pageSetup paperSize="${paperSize}" orientation="${orientation === 'landscape' ? 'landscape' : 'portrait'}"/>`
        : `<pageSetup paperSize="${paperSize}" orientation="${orientation === 'landscape' ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`,
      buildRowBreaksXml(pageCount, pageRows)
    ].join('');
    const markers = ['<headerFooter', '<drawing', '<legacyDrawing', '<tableParts', '<extLst'];
    for(const marker of markers){
      const pos = next.indexOf(marker);
      if(pos >= 0) return `${next.slice(0, pos)}${block}${next.slice(pos)}`;
    }
    return insertBeforeWorksheetEnd(next, block);
  }

  function firstXmlElementName(xml){
    const clean = String(xml || '')
      .replace(/^\uFEFF/, '')
      .replace(/^\s*<\?xml[^>]*\?>\s*/i, '');
    return clean.match(/^<([A-Za-z_][\w:.-]*)\b/)?.[1] || '';
  }

  function assertWorksheetXml(xml){
    const text = String(xml || '');
    if(firstXmlElementName(text) !== 'worksheet'){
      throw new Error('File Excel vừa tạo có XML trang tính không hợp lệ, đã chặn lưu file lỗi.');
    }
    const worksheetIndex = text.indexOf('<worksheet');
    const sheetPrIndex = text.indexOf('<sheetPr');
    if(sheetPrIndex >= 0 && worksheetIndex >= 0 && sheetPrIndex < worksheetIndex){
      throw new Error('File Excel vừa tạo có sheetPr nằm sai vị trí, đã chặn lưu file lỗi.');
    }
  }

  function xmlText(value){
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function patchWorkbookPrintAreaXml(xml, printArea){
    if(!printArea) return xml;
    const sheetName = safe(printArea.sheetName || SCHOOL_CLASS_SHEET_NAME || SHEET_NAME).replace(/'/g, "''");
    const range = safe(printArea.range || '$A$1:$U$62');
    const ref = xmlText(`'${sheetName}'!${range}`);
    const node = `<definedName name="_xlnm.Print_Area" localSheetId="0">${ref}</definedName>`;
    let next = String(xml || '');
    const exactRe = /<definedName\b(?=[^>]*\bname="_xlnm\.Print_Area")[^>]*>[\s\S]*?<\/definedName>/;
    if(exactRe.test(next)) return next.replace(exactRe, node);
    if(/<definedNames\b[^>]*\/>/.test(next)){
      return next.replace(/<definedNames\b([^>]*)\/>/, `<definedNames$1>${node}</definedNames>`);
    }
    if(/<definedNames\b[^>]*>/.test(next)){
      return next.replace(/<definedNames\b[^>]*>/, match => `${match}${node}`);
    }
    const block = `<definedNames>${node}</definedNames>`;
    const calcPos = next.indexOf('<calcPr');
    if(calcPos >= 0) return `${next.slice(0, calcPos)}${block}${next.slice(calcPos)}`;
    const endPos = next.lastIndexOf('</workbook>');
    if(endPos >= 0) return `${next.slice(0, endPos)}${block}${next.slice(endPos)}`;
    return next + block;
  }

  function toUint8Array(value){
    if(value instanceof Uint8Array) return value;
    if(value instanceof ArrayBuffer) return new Uint8Array(value);
    if(Array.isArray(value)) return new Uint8Array(value);
    if(value && value.buffer instanceof ArrayBuffer){
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
    }
    return value;
  }

  async function buildXlsxBlob(data, options){
    const built = options?.template === 'teacher1'
      ? buildTeacher1Workbook(data)
      : options?.template === 'school-class'
        ? buildSchoolClassWorkbook(data)
        : buildWorkbook(data);
    const {wb, pageCount, pageRows, orientation, scale, print, printArea} = built;
    const writeOptions = window.TKBExcelStyle?.writeOptions
      ? window.TKBExcelStyle.writeOptions({bookSST:true})
      : {compression:true, cellStyles:true, bookSST:true};
    const bytes = toUint8Array(XLSX.write(wb, Object.assign(
      writeOptions,
      {bookType:'xlsx', type:'array'}
    )));
    if(!window.JSZip){
      return new Blob([bytes], {type:XLSX_MIME});
    }
    const zip = await JSZip.loadAsync(bytes);
    const path = 'xl/worksheets/sheet1.xml';
    const file = zip.file(path);
    if(file){
      const xml = await file.async('string');
      const patched = patchWorksheetXml(xml, pageCount, pageRows, orientation, scale, print);
      assertWorksheetXml(patched);
      zip.file(path, patched);
    }
    if(printArea){
      const workbookFile = zip.file('xl/workbook.xml');
      if(workbookFile){
        const workbookXml = await workbookFile.async('string');
        zip.file('xl/workbook.xml', patchWorkbookPrintAreaXml(workbookXml, printArea));
      }
    }
    return zip.generateAsync({type:'blob', compression:'DEFLATE', mimeType:XLSX_MIME});
  }

  function exportPrefix(value){
    return safe(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function fallbackSequence(dateStamp, prefix){
    const cleanPrefix = exportPrefix(prefix);
    const key = `TKB_XLSX_EXPORT_SEQ::${cleanPrefix}::${dateStamp}`;
    const next = Math.max(1, Number(localStorage.getItem(key) || 0) + 1);
    localStorage.setItem(key, String(next));
    return next;
  }

  function nextSequence(dateStamp, prefix){
    const cleanPrefix = exportPrefix(prefix);
    const key = `TKB_XLSX_EXPORT_SEQ::${cleanPrefix}::${dateStamp}`;
    return Math.max(1, Number(localStorage.getItem(key) || 0) + 1);
  }

  function rememberSequence(dateStamp, prefix, sequence){
    const cleanPrefix = exportPrefix(prefix);
    const key = `TKB_XLSX_EXPORT_SEQ::${cleanPrefix}::${dateStamp}`;
    localStorage.setItem(key, String(Math.max(1, Number(sequence || 1))));
  }

  function downloadBlob(blob, fileName){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
  }

  async function saveBlobWithPicker(blob, fileName, mimeType, extension, description){
    if(window.showSaveFilePicker){
      try{
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{
            description: description || 'File',
            accept: {[mimeType]: [`.${extension}`]}
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return {ok:true, picked:true, fileName, path:handle.name || fileName};
      }catch(err){
        if(err && err.name === 'AbortError') return {ok:false, canceled:true};
        console.warn('save picker unavailable, falling back to browser download', err);
      }
    }
    downloadBlob(blob, fileName);
    return {ok:true, fallback:true, fileName, path:'Thư mục tải xuống của trình duyệt'};
  }

  async function saveXlsx(blob, dateStamp, prefix){
    const cleanPrefix = exportPrefix(prefix);
    const seq = nextSequence(dateStamp, cleanPrefix);
    const fileName = `${cleanPrefix}${pad2(seq)}${dateStamp}.xlsx`;
    const result = await saveBlobWithPicker(blob, fileName, XLSX_MIME, 'xlsx', 'Excel Workbook');
    if(result?.ok) rememberSequence(dateStamp, cleanPrefix, seq);
    return result;
    try{
      const response = await fetch(`/api/export/tkb-class-xlsx?date=${encodeURIComponent(dateStamp)}&prefix=${encodeURIComponent(cleanPrefix)}`, {
        method: 'POST',
        headers: {'Content-Type': XLSX_MIME},
        body: blob
      });
      const payload = await response.json().catch(() => null);
      if(response.ok && payload?.ok) return payload;
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }catch(err){
      console.warn('save xlsx endpoint unavailable, falling back to browser download', err);
      const seq = fallbackSequence(dateStamp, cleanPrefix);
      const fileName = `${cleanPrefix}${pad2(seq)}${dateStamp}.xlsx`;
      downloadBlob(blob, fileName);
      return {ok:true, fallback:true, fileName, path:'Thư mục tải xuống của trình duyệt'};
    }
  }

  function setStatus(message, type){
    try{
      if(typeof _setStatus === 'function') _setStatus(message, type || 'info');
      else {
        const el = document.getElementById('statusMsg');
        if(el) el.textContent = message;
      }
    }catch(_){ }
  }

  window.exportCurrentClassTKBExcel = async function(){
    try{
      setStatus('Đang xuất file Excel...', 'info');
      try{ saveStore({force:true}); }catch(_){ }
      const payloads = allClassSchedulePayloads();
      const blob = await buildXlsxBlob(payloads);
      const result = await saveXlsx(blob, fileDateToday(), 'hs');
      if(result?.canceled){
        setStatus('Đã hủy lưu file Excel.', 'info');
        return result;
      }
      const where = result.path || result.fileName || '';
      setStatus(`Đã xuất Excel ${payloads.length} lớp: ${where}`, 'ok');
      return result;
    }catch(err){
      const msg = err && (err.message || String(err)) || 'Không xuất được file Excel.';
      setStatus(msg, 'error');
      alert(msg);
      return null;
    }
  };

  window.exportSchoolClassTKBExcel = async function(){
    try{
      setStatus('Đang xuất Excel toàn trường theo lớp học...', 'info');
      try{ saveStore({force:true}); }catch(_){ }
      const payloads = allSchoolClassSchedulePayloads();
      const blob = await buildXlsxBlob(payloads, {template:'school-class'});
      const result = await saveXlsx(blob, fileDateToday(), 'tonghs');
      if(result?.canceled){
        setStatus('Đã hủy lưu file Excel toàn trường.', 'info');
        return result;
      }
      const where = result.path || result.fileName || '';
      setStatus(`Đã xuất Excel toàn trường theo lớp học ${payloads.length} lớp: ${where}`, 'ok');
      return result;
    }catch(err){
      const msg = err && (err.message || String(err)) || 'Không xuất được Excel toàn trường theo lớp học.';
      setStatus(msg, 'error');
      alert(msg);
      return null;
    }
  };

  window.exportSchoolTeacherTKBExcel = async function(){
    try{
      setStatus('Đang xuất Excel toàn trường theo giáo viên...', 'info');
      try{ saveStore({force:true}); }catch(_){ }
      const payloads = allSchoolTeacherSchedulePayloads();
      const blob = await buildXlsxBlob(payloads, {template:'school-class'});
      const result = await saveXlsx(blob, fileDateToday(), 'tonggv');
      if(result?.canceled){
        setStatus('Đã hủy lưu file Excel toàn trường theo giáo viên.', 'info');
        return result;
      }
      const where = result.path || result.fileName || '';
      setStatus(`Đã xuất Excel toàn trường theo giáo viên ${payloads.length} giáo viên: ${where}`, 'ok');
      return result;
    }catch(err){
      const msg = err && (err.message || String(err)) || 'Không xuất được Excel toàn trường theo giáo viên.';
      setStatus(msg, 'error');
      alert(msg);
      return null;
    }
  };

  window.exportTeacherTKBExcelTemplate1 = async function(){
    try{
      setStatus('Đang xuất file Excel mẫu 1 giáo viên...', 'info');
      try{ saveStore({force:true}); }catch(_){ }
      const payloads = allTeacherTemplate1Payloads();
      const blob = await buildXlsxBlob(payloads, {template:'teacher1'});
      const result = await saveXlsx(blob, fileDateToday(), 'gv');
      if(result?.canceled){
        setStatus('Đã hủy lưu file Excel mẫu 1 giáo viên.', 'info');
        return result;
      }
      const where = result.path || result.fileName || '';
      setStatus(`Đã xuất Excel mẫu 1 ${payloads.length} giáo viên: ${where}`, 'ok');
      return result;
    }catch(err){
      const msg = err && (err.message || String(err)) || 'Không xuất được file Excel mẫu 1 giáo viên.';
      setStatus(msg, 'error');
      alert(msg);
      return null;
    }
  };

  window.exportTeacherTKBExcelTemplate2 = async function(){
    try{
      setStatus('Đang xuất file Excel mẫu 2 giáo viên...', 'info');
      try{ saveStore({force:true}); }catch(_){ }
      const payloads = allTeacherSchedulePayloads();
      const blob = await buildXlsxBlob(payloads);
      const result = await saveXlsx(blob, fileDateToday(), 'gv');
      if(result?.canceled){
        setStatus('Đã hủy lưu file Excel mẫu 2 giáo viên.', 'info');
        return result;
      }
      const where = result.path || result.fileName || '';
      setStatus(`Đã xuất Excel mẫu 2 ${payloads.length} giáo viên: ${where}`, 'ok');
      return result;
    }catch(err){
      const msg = err && (err.message || String(err)) || 'Không xuất được file Excel mẫu 2 giáo viên.';
      setStatus(msg, 'error');
      alert(msg);
      return null;
    }
  };
})();
