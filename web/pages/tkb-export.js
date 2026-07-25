(function(){
  const TEMPLATE_SHEET_NAME = 'TKB_GV_SC';
  const TEMPLATE_CAPACITY = 42;

  function _pad2(n){
    return String(Number(n || 0)).padStart(2, '0');
  }

  function _safeText(v){
    return (v == null) ? '' : String(v).trim();
  }

  function _teacherCodes(raw){
    try{
      if(typeof teacherListFromValue === 'function') return teacherListFromValue(raw);
    }catch(_){ }
    return _safeText(raw)
      .replace(/\r?\n/g, ',')
      .replace(/[;；]+/g, ',')
      .replace(/\s*[+＋]\s*/g, ',')
      .split(',')
      .map(x => {
        const s = _safeText(x);
        try{ return resolveTeacherCode(s); }catch(_){ return s; }
      })
      .filter(Boolean);
  }

  function _schoolLabel(){
    try{
      const raw = _safeText(typeof rawSchoolParam !== 'undefined' ? rawSchoolParam : '');
      if(raw) return raw;
    }catch(_){ }
    try{
      const sid = _safeText(typeof schoolParam !== 'undefined' ? schoolParam : '');
      if(sid) return sid;
    }catch(_){ }
    return 'Trường';
  }

  function _academicMeta(){
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const startYear = (month >= 7) ? year : (year - 1);
    const semester = (month >= 1 && month <= 5) ? 2 : 1;
    return {
      schoolLabel: _schoolLabel(),
      schoolYear: `${startYear} - ${startYear + 1}`,
      semester,
      dateLine: `Thực hiện từ ngày ${_pad2(now.getDate())} tháng ${_pad2(month)} năm ${year}`
    };
  }

  function _suggestExportName(){
    try{
      const checked = document.querySelector('#tkbConfigOverlay input[name="optMode"]:checked');
      const raw = String(checked?.value || '').trim();
      if(raw === 'buoi1') return 'buoc1';
      if(raw === 'trong2') return 'buoc2';
      if(raw === 'trong1') return 'buoc3';
      const mode = Number(raw || 0);
      if(mode >= 1 && mode <= 5) return `buoc${mode}`;
    }catch(_){ }
    return 'coban';
  }

  function _askExportFileName(){
    const suggested = _suggestExportName();
    let name = window.prompt(
      'Nhập tên file xuất Excel (ví dụ: coban, buoc1, buoc2, buoc3, buoc4, buoc5)',
      suggested
    );
    if(name === null) return null;
    name = _safeText(name) || suggested;
    name = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ');
    if(!name) name = suggested;
    if(!/\.xlsx$/i.test(name)) name += '.xlsx';
    return name;
  }

  function _teacherListForExport(){
    const map = new Map();

    (DATA.giaovien || []).forEach(g => {
      const code = resolveTeacherCode(g?.magv || g?.ten || '');
      if(!code || map.has(code)) return;
      map.set(code, { code, name: getTeacherNameByCode(code) || code });
    });

    Object.values(DATA.pccmMatrix || {}).forEach(v => {
      _teacherCodes(v).forEach(code => {
        if(!code || map.has(code)) return;
        map.set(code, { code, name: getTeacherNameByCode(code) || code });
      });
    });

    return Array.from(map.values());
  }

  function _makeEmptyTeacherMatrix(teachers){
    const out = {};
    teachers.forEach(t => {
      out[t.code] = {};
      DAYS.forEach(d => {
        out[t.code][d] = {
          sang: Array.from({ length: SANG }, () => []),
          chieu: Array.from({ length: CHIEU }, () => [])
        };
      });
    });
    return out;
  }

  function _buildTeacherMatrix(teachers){
    const matrix = _makeEmptyTeacherMatrix(teachers);
    let missingTeacherCount = 0;

    (DATA.lop || []).forEach(lop => {
      const classId = lop?.id;
      const classDisplay = _safeText(lop?.ten2 || lop?.ten || lop?.id);
      const classCanon = getLopCanonById(classId);
      const tkb = DATA.tkb?.[classId];
      if(!tkb) return;

      DAYS.forEach(thu => {
        ['sang', 'chieu'].forEach(buoi => {
          const arr = tkb?.[thu]?.[buoi] || [];
          const limit = (buoi === 'sang') ? SANG : CHIEU;
          for(let ti = 0; ti < limit; ti++){
            const v = arr[ti];
            if(!v || v === 'OFF') continue;
            const mon = cellMon(v);
            if(!mon) continue;
            const gv = getTeacherForClassMon(classCanon, mon);
            const gvList = _teacherCodes(gv);
            if(!gvList.length){
              missingTeacherCount++;
              continue;
            }
            const label = `${getMonShort(mon)} - ${classDisplay}`;
            gvList.forEach(code => {
              if(!matrix[code]){
                teachers.push({ code, name: getTeacherNameByCode(code) || code });
                matrix[code] = {};
                DAYS.forEach(d => {
                  matrix[code][d] = {
                    sang: Array.from({ length: SANG }, () => []),
                    chieu: Array.from({ length: CHIEU }, () => [])
                  };
                });
              }
              matrix[code][thu][buoi][ti].push(label);
            });
          }
        });
      });
    });

    return { matrix, missingTeacherCount, teachers };
  }

  function _setSheetCellKeepStyle(ws, row0, col0, value){
    const addr = XLSX.utils.encode_cell({ r: row0, c: col0 });
    const cell = ws[addr] || {};
    cell.v = (value == null) ? '' : value;
    cell.t = (typeof value === 'number') ? 'n' : 's';
    delete cell.w;
    delete cell.r;
    delete cell.h;
    ws[addr] = cell;
  }

  function _clearTemplateBody(ws){
    for(let teacherIdx = 0; teacherIdx < TEMPLATE_CAPACITY; teacherIdx++){
      const colMorning = 2 + teacherIdx * 2;
      _setSheetCellKeepStyle(ws, 3, colMorning, '');
      for(let row0 = 5; row0 <= 34; row0++){
        _setSheetCellKeepStyle(ws, row0, colMorning, '');
        _setSheetCellKeepStyle(ws, row0, colMorning + 1, '');
      }
    }
  }

  function _fillTeacherSheet(ws, teachers, matrix, meta, capacity){
    _clearTemplateBody(ws);

    _setSheetCellKeepStyle(ws, 0, 0, `${meta.schoolLabel}\nNăm học ${meta.schoolYear}\nHọc kỳ ${meta.semester}`);
    _setSheetCellKeepStyle(ws, 0, 5, 'THỜI KHOÁ BIỂU số 1');
    _setSheetCellKeepStyle(ws, 1, 5, meta.dateLine);

    teachers.slice(0, capacity).forEach((teacher, idx) => {
      const colMorning = 2 + idx * 2;
      const colAfternoon = colMorning + 1;
      _setSheetCellKeepStyle(ws, 3, colMorning, teacher.code);

      DAYS.forEach((thu, dayIdx) => {
        for(let ti = 0; ti < SANG; ti++){
          const row0 = 5 + dayIdx * 5 + ti;
          const morningEntries = matrix?.[teacher.code]?.[thu]?.sang?.[ti] || [];
          const afternoonEntries = matrix?.[teacher.code]?.[thu]?.chieu?.[ti] || [];
          _setSheetCellKeepStyle(ws, row0, colMorning, morningEntries.join('\n'));
          _setSheetCellKeepStyle(ws, row0, colAfternoon, afternoonEntries.join('\n'));
        }
      });
    });
  }

  function _base64ToUint8Array(base64){
    const clean = String(base64 || '').replace(/\s+/g, '');
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function _loadTemplateWorkbook(){
    if(!window.TKB_GV_SC_TEMPLATE_BASE64) return null;
    try{
      const bytes = _base64ToUint8Array(window.TKB_GV_SC_TEMPLATE_BASE64);
      return XLSX.read(bytes, { type: 'array', cellStyles: true });
    }catch(err){
      console.warn('load template workbook failed', err);
      return null;
    }
  }

  function _buildPlainWorkbook(teachers, matrix, meta){
    const totalCols = Math.max(6, 2 + teachers.length * 2);
    const rows = Array.from({ length: 35 }, () => Array.from({ length: totalCols }, () => ''));

    rows[0][0] = `${meta.schoolLabel}\nNăm học ${meta.schoolYear}\nHọc kỳ ${meta.semester}`;
    rows[0][5] = 'THỜI KHOÁ BIỂU số 1';
    rows[1][5] = meta.dateLine;
    rows[3][0] = 'THỨ';
    rows[3][1] = 'TIẾT';

    const dayNumbers = [2, 3, 4, 5, 6, 7];
    dayNumbers.forEach((dayNo, dayIdx) => {
      const startRow = 5 + dayIdx * 5;
      rows[startRow][0] = dayNo;
      for(let ti = 0; ti < 5; ti++) rows[startRow + ti][1] = ti + 1;
    });

    teachers.forEach((teacher, idx) => {
      const colMorning = 2 + idx * 2;
      const colAfternoon = colMorning + 1;
      rows[3][colMorning] = teacher.code;
      rows[4][colMorning] = 'Sáng';
      rows[4][colAfternoon] = 'Chiều';

      DAYS.forEach((thu, dayIdx) => {
        for(let ti = 0; ti < SANG; ti++){
          const row0 = 5 + dayIdx * 5 + ti;
          rows[row0][colMorning] = (matrix?.[teacher.code]?.[thu]?.sang?.[ti] || []).join('\n');
          rows[row0][colAfternoon] = (matrix?.[teacher.code]?.[thu]?.chieu?.[ti] || []).join('\n');
        }
      });
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 1, c: 4 } },
      { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } },
      { s: { r: 3, c: 1 }, e: { r: 4, c: 1 } },
      { s: { r: 5, c: 0 }, e: { r: 9, c: 0 } },
      { s: { r: 10, c: 0 }, e: { r: 14, c: 0 } },
      { s: { r: 15, c: 0 }, e: { r: 19, c: 0 } },
      { s: { r: 20, c: 0 }, e: { r: 24, c: 0 } },
      { s: { r: 25, c: 0 }, e: { r: 29, c: 0 } },
      { s: { r: 30, c: 0 }, e: { r: 34, c: 0 } }
    ];

    const titleEnd = Math.max(5, totalCols - 3);
    merges.push({ s: { r: 0, c: 5 }, e: { r: 0, c: titleEnd } });
    merges.push({ s: { r: 1, c: 5 }, e: { r: 1, c: titleEnd } });

    teachers.forEach((_, idx) => {
      const colMorning = 2 + idx * 2;
      merges.push({ s: { r: 3, c: colMorning }, e: { r: 3, c: colMorning + 1 } });
    });

    ws['!merges'] = merges;
    const widths = [
      { wch: 4.7 },
      { wch: 13 },
      ...Array.from({ length: totalCols - 2 }, (_, i) => ({ wch: (i === 0 ? 12.2 : 13) }))
    ];
    ws['!cols'] = widths;
    ws['!rows'] = [
      { hpt: 30 },
      {},
      { hpt: 3.95 },
      { hpt: 16.7 },
      { hpt: 16.7 },
      ...Array.from({ length: 30 }, () => ({ hpt: 16.7 }))
    ];
    try{
      const rowHeights = { 0: 42, 1: 22, 2: 5, 3: 24, 4: 22 };
      for(let r = 5; r <= 34; r++) rowHeights[r] = 34;
      window.TKBExcelStyle?.styleSheet(ws, rows, {
        widths,
        titleRows: [0],
        headerRows: [3, 4],
        freeze: { xSplit: 2, ySplit: 5 },
        rowHeights,
        bodyRowHeight: 34,
        centerAll: true,
        minWidth: 4,
        maxWidth: 16
      });
    }catch(err){
      console.warn('style teacher schedule workbook failed', err);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, TEMPLATE_SHEET_NAME);
    return wb;
  }

  window.exportTeacherScheduleExcel = function(){
    if(!window.XLSX){
      alert('❌ Chưa tải được thư viện Excel.');
      return;
    }

    const fileName = _askExportFileName();
    if(!fileName) return;

    const teachers = _teacherListForExport();
    if(!teachers.length){
      alert('⚠ Chưa có giáo viên để xuất Excel.');
      return;
    }

    const built = _buildTeacherMatrix(teachers);
    const meta = _academicMeta();

    let wb = null;
    let usedTemplate = false;
    if(built.teachers.length <= TEMPLATE_CAPACITY){
      wb = _loadTemplateWorkbook();
      if(wb){
        const ws = wb.Sheets[TEMPLATE_SHEET_NAME] || wb.Sheets[wb.SheetNames[0]];
        _fillTeacherSheet(ws, built.teachers, built.matrix, meta, TEMPLATE_CAPACITY);
        try{ window.TKBExcelStyle?.applyFontToSheet(ws, { range: ws['!ref'] || 'A1:CF35' }); }catch(_){ }
        usedTemplate = true;
      }
    }

    if(!wb) wb = _buildPlainWorkbook(built.teachers, built.matrix, meta);

    try{
      XLSX.writeFile(wb, fileName, window.TKBExcelStyle?.writeOptions ? window.TKBExcelStyle.writeOptions() : { compression: true, cellStyles: true });
      const skipped = Number(built.missingTeacherCount || 0);
      if(skipped > 0){
        alert(`✔ Đã xuất ${fileName}. Có ${skipped} tiết chưa xác định được giáo viên nên không đưa vào bảng GV.`);
      }
    }catch(err){
      console.error('exportTeacherScheduleExcel failed', err);
      alert(`❌ Xuất Excel thất bại: ${err?.message || err}`);
    }
  };

  const INDUSTRY_EXPORT_VERSION = '20260725-v1100-industry-export-queue-v1';
  const INDUSTRY_DAYS = ['thu2', 'thu3', 'thu4', 'thu5', 'thu6', 'thu7'];
  const INDUSTRY_PERIODS = 5;
  const INDUSTRY_FONT = 'Times New Roman';
  const INDUSTRY_BLACK = 'FF000000';

  function _industryConstraintMeta(){
    try{
      const api = window.TKBConstraints || window.TKBConstraintsFull;
      const meta = api && typeof api.get === 'function' ? api.get()?.meta : null;
      if(meta && typeof meta === 'object') return meta;
    }catch(_){ }
    const meta = DATA?.tkbConstraints?.meta;
    return meta && typeof meta === 'object' ? meta : {};
  }

  function _industryDateParts(value){
    const raw = _safeText(value);
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(iso){
      return { year:Number(iso[1]), month:Number(iso[2]), day:Number(iso[3]) };
    }
    const vn = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
    if(vn){
      return { year:Number(vn[3]), month:Number(vn[2]), day:Number(vn[1]) };
    }
    const now = new Date();
    return { year:now.getFullYear(), month:now.getMonth() + 1, day:now.getDate() };
  }

  function _industryMeta(){
    const raw = _industryConstraintMeta();
    const date = _industryDateParts(raw.effectiveDate || raw.applyDate || raw.ngayApDung);
    const startYear = date.month >= 7 ? date.year : date.year - 1;
    const schoolName = _safeText(raw.schoolName || raw.schoolLabel || raw.tenTruong || raw.school || _schoolLabel()) || 'Trường';
    return {
      schoolLabel: schoolName.toLocaleUpperCase('vi-VN'),
      schoolYear: `${startYear} - ${startYear + 1}`,
      semester: date.month <= 6 ? 2 : 1,
      scheduleNumber: _safeText(raw.scheduleNumber || raw.scheduleNo || raw.tkbNumber) || '1',
      dateLine: `Thực hiện từ ngày ${_pad2(date.day)} tháng ${_pad2(date.month)} năm ${date.year}`
    };
  }

  function _industryClassName(lop){
    try{
      if(typeof classCanonFromLop === 'function'){
        const value = _safeText(classCanonFromLop(lop));
        if(value) return value;
      }
    }catch(_){ }
    return _safeText(lop?.ten2 || lop?.ten || lop?.id);
  }

  function _industryClasses(){
    const rows = Array.isArray(DATA?.lop) ? DATA.lop.slice() : [];
    try{
      if(typeof compareClassByDataOrder === 'function') rows.sort(compareClassByDataOrder);
    }catch(_){ }
    return rows.filter(lop => _industryClassName(lop));
  }

  function _industryClassTkb(lop){
    const candidates = [lop?.id, lop?.ten, lop?.ten2, _industryClassName(lop)]
      .map(_safeText)
      .filter(Boolean);
    for(const key of candidates){
      if(DATA?.tkb?.[key]) return DATA.tkb[key];
    }
    return null;
  }

  function _industryTeacherRecord(code){
    const raw = _safeText(code);
    let resolved = raw;
    try{ resolved = _safeText(resolveTeacherCode(raw)) || raw; }catch(_){ }
    const keys = new Set([raw, resolved].map(value => value.toLocaleLowerCase('vi-VN')).filter(Boolean));
    return (DATA?.giaovien || []).find(g => {
      const values = [g?.magv, g?.MaGV, g?.magv2, g?.MaGV2, g?.maGV2, g?.code, g?.id]
        .map(v => _safeText(v).toLocaleLowerCase('vi-VN'));
      return values.some(value => keys.has(value));
    }) || null;
  }

  function _industryTeacherIdentity(code, record){
    const teacher = record || _industryTeacherRecord(code);
    const primary = _safeText(teacher?.magv || teacher?.MaGV || teacher?.code || teacher?.id || code);
    return { code:primary, record:teacher || null };
  }

  function _industryTeacherShort(code){
    const record = _industryTeacherRecord(code);
    const maGV2 = _safeText(record?.magv2 || record?.MaGV2 || record?.maGV2);
    if(maGV2) return maGV2;
    const maGV = _safeText(record?.magv || record?.MaGV || record?.code || code);
    if(maGV) return maGV;
    try{ return _safeText(getTeacherShort(code)); }catch(_){ return _safeText(code); }
  }

  function _industryTeacherFullName(code, record){
    const teacher = record || _industryTeacherRecord(code);
    const localName = `${_safeText(teacher?.hodem)} ${_safeText(teacher?.ten)}`.trim();
    if(localName) return localName;
    try{
      const value = _safeText(getTeacherNameByCode(code));
      if(value) return value;
    }catch(_){ }
    return _safeText(code);
  }

  function _industryTeacherCodes(raw){
    const seen = new Set();
    return _teacherCodes(raw).map(code => {
      let resolved = _safeText(code);
      try{ resolved = _safeText(resolveTeacherCode(code)) || resolved; }catch(_){ }
      return _industryTeacherIdentity(resolved).code;
    }).filter(code => {
      const key = code.toLocaleLowerCase('vi-VN');
      if(!code || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function _industryLessonText(lop, raw){
    if(!raw || raw === 'OFF') return '';
    let mon = '';
    try{ mon = _safeText(cellMon(raw)); }catch(_){ mon = _safeText(raw?.mon || raw); }
    if(!mon) return '';
    let subject = mon;
    try{ subject = _safeText(getMonShort(mon)) || mon; }catch(_){ }
    let teacherValue = '';
    try{
      const classId = _safeText(lop?.id);
      const classCanon = typeof getLopCanonById === 'function'
        ? (_safeText(getLopCanonById(classId)) || _industryClassName(lop))
        : _industryClassName(lop);
      teacherValue = getTeacherForClassMon(classCanon, mon);
    }catch(_){ }
    const teachers = _industryTeacherCodes(teacherValue).map(_industryTeacherShort).filter(Boolean);
    return teachers.length ? `${subject} - ${teachers.join(', ')}` : subject;
  }

  function _industryBorder(style){
    const edge = { style:style || 'thin', color:{ rgb:INDUSTRY_BLACK } };
    return { top:edge, bottom:edge, left:edge, right:edge };
  }

  function _industryStyle(size, options){
    const opts = options || {};
    const alignment = {
      horizontal: opts.align || 'center',
      vertical: opts.vertical || 'center',
      wrapText: opts.wrap !== false
    };
    if(opts.shrink) alignment.shrinkToFit = true;
    return {
      font: {
        name: INDUSTRY_FONT,
        sz: Number(size || 9),
        bold: !!opts.bold,
        color: { rgb:INDUSTRY_BLACK }
      },
      alignment,
      fill: { patternType:'solid', fgColor:{ rgb:opts.fill || 'FFFFFFFF' } },
      border: opts.border === false ? undefined : _industryBorder(opts.borderStyle)
    };
  }

  const INDUSTRY_STYLES = {
    topBlank: _industryStyle(9, { border:false }),
    school: _industryStyle(11, { bold:true, align:'left', vertical:'top', border:false }),
    title: _industryStyle(24, { bold:true, border:false, wrap:false }),
    session: _industryStyle(11, { bold:true, border:false, wrap:false }),
    date: _industryStyle(9, { bold:true, border:false, wrap:false }),
    header: _industryStyle(8, { bold:true, fill:'FFD9D9D9' }),
    day: _industryStyle(8, { bold:true, wrap:false }),
    period: _industryStyle(8, { wrap:false }),
    lesson: _industryStyle(8, { shrink:true }),
    pcgdHeader: _industryStyle(10, { bold:true, fill:'FFD9D9D9', wrap:false }),
    pcgdText: _industryStyle(11, { align:'left' }),
    pcgdCenter: _industryStyle(11, { wrap:false }),
    pcgdAssignment: _industryStyle(8, { align:'left', wrap:false, shrink:true })
  };

  function _industryEnsureCell(ws, row, col){
    const addr = XLSX.utils.encode_cell({ r:row, c:col });
    ws[addr] = ws[addr] || { t:'s', v:'' };
    return ws[addr];
  }

  function _industryStyleCell(ws, row, col, style){
    _industryEnsureCell(ws, row, col).s = style;
  }

  function _industryMerge(ws, startRow, startCol, endRow, endCol){
    ws['!merges'] = ws['!merges'] || [];
    ws['!merges'].push({ s:{ r:startRow, c:startCol }, e:{ r:endRow, c:endCol } });
  }

  function _industryScheduleSheet(session, classes, meta){
    const totalRows = 5 + INDUSTRY_DAYS.length * INDUSTRY_PERIODS;
    const totalCols = Math.max(6, 2 + classes.length);
    const rows = Array.from({ length:totalRows }, () => Array.from({ length:totalCols }, () => ''));
    rows[0][0] = `${meta.schoolLabel}\nNăm học ${meta.schoolYear}\nHọc kỳ ${meta.semester}`;
    rows[0][5] = `THỜI KHOÁ BIỂU số ${meta.scheduleNumber}`;
    rows[1][5] = session === 'sang' ? 'BUỔI SÁNG' : 'BUỔI CHIỀU';
    rows[2][5] = meta.dateLine;
    rows[4][0] = 'THỨ';
    rows[4][1] = 'TIẾT';
    classes.forEach((lop, index) => { rows[4][2 + index] = _industryClassName(lop); });

    INDUSTRY_DAYS.forEach((day, dayIndex) => {
      const startRow = 5 + dayIndex * INDUSTRY_PERIODS;
      rows[startRow][0] = dayIndex + 2;
      for(let period = 0; period < INDUSTRY_PERIODS; period++){
        rows[startRow + period][1] = period + 1;
        classes.forEach((lop, classIndex) => {
          const tkb = _industryClassTkb(lop);
          rows[startRow + period][2 + classIndex] = _industryLessonText(lop, tkb?.[day]?.[session]?.[period]);
        });
      }
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!ref'] = XLSX.utils.encode_range({ s:{ r:0, c:0 }, e:{ r:totalRows - 1, c:totalCols - 1 } });
    ws['!cols'] = Array.from({ length:totalCols }, (_, index) => ({ width:index < 2 ? 4.625 : 12.125 }));
    ws['!rows'] = Array.from({ length:totalRows }, (_, row) => ({
      hpt: row === 0 ? 30.4 : row === 1 ? 17.25 : row === 3 ? 3.95 : row === 4 ? 30 : row >= 5 ? 15.95 : 15
    }));
    ws['!margins'] = { left:0.4, right:0, top:0, bottom:0, header:0.5, footer:0.5 };
    ws['!pageSetup'] = { paperSize:9, orientation:'landscape' };
    ws['!freeze'] = { xSplit:2, ySplit:5, topLeftCell:'C6', activePane:'bottomRight' };
    ws['!views'] = [{ state:'frozen', xSplit:2, ySplit:5, topLeftCell:'C6', activePane:'bottomRight' }];

    for(let row = 0; row < 4; row++){
      for(let col = 0; col < totalCols; col++) _industryStyleCell(ws, row, col, INDUSTRY_STYLES.topBlank);
    }
    for(let row = 4; row < totalRows; row++){
      for(let col = 0; col < totalCols; col++) _industryStyleCell(ws, row, col, row === 4 ? INDUSTRY_STYLES.header : INDUSTRY_STYLES.lesson);
    }
    _industryStyleCell(ws, 0, 0, INDUSTRY_STYLES.school);
    _industryStyleCell(ws, 0, 5, INDUSTRY_STYLES.title);
    _industryStyleCell(ws, 1, 5, INDUSTRY_STYLES.session);
    _industryStyleCell(ws, 2, 5, INDUSTRY_STYLES.date);
    INDUSTRY_DAYS.forEach((_day, dayIndex) => {
      const startRow = 5 + dayIndex * INDUSTRY_PERIODS;
      _industryStyleCell(ws, startRow, 0, INDUSTRY_STYLES.day);
      for(let period = 0; period < INDUSTRY_PERIODS; period++) _industryStyleCell(ws, startRow + period, 1, INDUSTRY_STYLES.period);
      _industryMerge(ws, startRow, 0, startRow + INDUSTRY_PERIODS - 1, 0);
    });

    const titleEnd = Math.max(5, totalCols - 4);
    _industryMerge(ws, 0, 0, 2, 4);
    _industryMerge(ws, 0, 5, 0, titleEnd);
    _industryMerge(ws, 1, 5, 1, titleEnd);
    _industryMerge(ws, 2, 5, 2, titleEnd);
    return ws;
  }

  function _industryRequiredSubjects(lop){
    try{
      if(typeof requiredSubjectsForClass === 'function'){
        const rows = requiredSubjectsForClass(lop);
        if(Array.isArray(rows)) return rows;
      }
    }catch(_){ }

    const classKeys = new Set([lop?.id, lop?.ten, lop?.ten2, _industryClassName(lop)].map(_safeText).filter(Boolean));
    const out = [];
    Object.entries(DATA?.pccmMatrix || {}).forEach(([rawKey, teacher]) => {
      const parts = String(rawKey).split('|');
      const classKey = _safeText(parts.shift());
      const mon = _safeText(parts.join('|'));
      if(!classKeys.has(classKey) || !mon) return;
      const required = Number(DATA?.pccmTietMatrix?.[rawKey] || 0);
      out.push({ mon, required:Number.isFinite(required) ? required : 0, gv:teacher });
    });
    return out;
  }

  function _industryTeacherDuty(record){
    const fields = ['kiemnhiem', 'kiemNhiem', 'kiêmNhiệm', 'nhiemvu', 'nhiemVu', 'duty', 'duties'];
    for(const field of fields){
      const value = record?.[field];
      if(Array.isArray(value) && value.length) return value.map(_safeText).filter(Boolean).join(', ');
      if(_safeText(value)) return _safeText(value);
    }
    return '';
  }

  function _industryTeacherHomerooms(code, classes){
    const fields = [
      'gvcn', 'GVCN', 'magvcn', 'maGVCN', 'chuNhiem', 'chunhiem', 'chu_nhiem',
      'giaoVienChuNhiem', 'giaovienchunhiem', 'homeroomTeacher', 'teacherHomeroom'
    ];
    const target = _safeText(code).toLocaleLowerCase('vi-VN');
    const result = [];
    classes.forEach(lop => {
      const matched = fields.some(field => _industryTeacherCodes(lop?.[field]).some(value => value.toLocaleLowerCase('vi-VN') === target));
      if(matched) result.push(_industryClassName(lop));
    });
    return Array.from(new Set(result)).join(', ');
  }

  function _industrySubjectCode(mon){
    const raw = _safeText(mon);
    const key = raw.toLocaleLowerCase('vi-VN');
    const rows = []
      .concat(Array.isArray(DATA?.monhoc) ? DATA.monhoc : [])
      .concat(Array.isArray(DATA?.mon) ? DATA.mon : []);
    const found = rows.find(row => [row?.ten, row?.mon, row?.mamon, row?.ma, row?.ma2, row?.id, row?.key]
      .some(value => _safeText(value).toLocaleLowerCase('vi-VN') === key));
    const code = _safeText(found?.ma || found?.ma2 || found?.mamon || found?.code || found?.id || found?.key);
    if(code) return code;
    try{ return _safeText(getMonShort(raw)) || raw; }catch(_){ return raw; }
  }

  function _industryPcgdRows(classes){
    const teachers = new Map();
    const order = [];
    const ensureTeacher = (code, record) => {
      const identity = _industryTeacherIdentity(code, record);
      const resolved = identity.code;
      if(!resolved) return null;
      const key = resolved.toLocaleLowerCase('vi-VN');
      if(!teachers.has(key)){
        teachers.set(key, { code:resolved, record:identity.record, total:0, subjects:new Map() });
        order.push(key);
      }else if(identity.record && !teachers.get(key).record){
        teachers.get(key).record = identity.record;
      }
      return teachers.get(key);
    };

    (DATA?.giaovien || []).forEach(record => ensureTeacher(record?.magv || record?.code || record?.id, record));

    classes.forEach(lop => {
      const className = _industryClassName(lop);
      _industryRequiredSubjects(lop).forEach(row => {
        const mon = _safeText(row?.mon || row?.ten || row?.subject);
        if(!mon) return;
        const subject = _industrySubjectCode(mon);
        const required = Math.max(0, Number(row?.required ?? row?.sotiet ?? row?.periods ?? 0) || 0);
        const classCanon = _industryClassName(lop);
        let teacherValue = row?.gv || row?.teacher || '';
        if(!teacherValue){
          try{ teacherValue = getTeacherForClassMon(classCanon, mon); }catch(_){ }
        }
        _industryTeacherCodes(teacherValue).forEach(code => {
          const teacher = ensureTeacher(code, _industryTeacherRecord(code));
          if(!teacher) return;
          teacher.total += required;
          const subjectKey = subject.toLocaleLowerCase('vi-VN');
          if(!teacher.subjects.has(subjectKey)) teacher.subjects.set(subjectKey, { label:subject, classes:[], seen:new Set() });
          const group = teacher.subjects.get(subjectKey);
          const classKey = className.toLocaleLowerCase('vi-VN');
          if(className && !group.seen.has(classKey)){
            group.seen.add(classKey);
            group.classes.push(className);
          }
        });
      });
    });

    const rows = [['TT', 'Giáo viên', 'Kiêm nhiệm', 'CN', 'Phân công chuyên môn', 'Số tiết']];
    order.forEach((key, index) => {
      const teacher = teachers.get(key);
      const assignment = Array.from(teacher.subjects.values())
        .map(subject => `${subject.label}(${subject.classes.join(', ')});`)
        .join('');
      rows.push([
        index + 1,
        _industryTeacherFullName(teacher.code, teacher.record),
        _industryTeacherDuty(teacher.record),
        _industryTeacherHomerooms(teacher.code, classes),
        assignment,
        teacher.total
      ]);
    });
    return rows;
  }

  function _industryPcgdSheet(classes){
    const rows = _industryPcgdRows(classes);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!ref'] = XLSX.utils.encode_range({ s:{ r:0, c:0 }, e:{ r:Math.max(0, rows.length - 1), c:5 } });
    ws['!cols'] = [4.625, 23.625, 17.625, 7.625, 73.625, 7].map(width => ({ width }));
    ws['!rows'] = rows.map(() => ({ hpt:17.45 }));
    ws['!margins'] = { left:0, right:0, top:0, bottom:0, header:0.25, footer:0.25 };
    ws['!pageSetup'] = { paperSize:9, orientation:'landscape' };
    ws['!freeze'] = { ySplit:1, topLeftCell:'A2', activePane:'bottomLeft' };
    ws['!views'] = [{ state:'frozen', ySplit:1, topLeftCell:'A2', activePane:'bottomLeft' }];
    for(let row = 0; row < rows.length; row++){
      for(let col = 0; col < 6; col++){
        const centered = col === 0 || col === 3 || col === 5;
        const bodyStyle = col === 4
          ? INDUSTRY_STYLES.pcgdAssignment
          : (centered ? INDUSTRY_STYLES.pcgdCenter : INDUSTRY_STYLES.pcgdText);
        _industryStyleCell(ws, row, col, row === 0 ? INDUSTRY_STYLES.pcgdHeader : bodyStyle);
      }
    }
    return ws;
  }

  function _buildIndustryDatabaseWorkbook(){
    if(!window.XLSX) throw new Error('Chưa tải được thư viện Excel XLSX.');
    const classes = _industryClasses();
    if(!classes.length) throw new Error('Chưa có lớp để xuất CSDL ngành.');
    const meta = _industryMeta();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, _industryScheduleSheet('sang', classes, meta), 'TKB_LOP_S');
    XLSX.utils.book_append_sheet(wb, _industryScheduleSheet('chieu', classes, meta), 'TKB_LOP_C');
    XLSX.utils.book_append_sheet(wb, _industryPcgdSheet(classes), 'PCGD');
    wb.Workbook = wb.Workbook || {};
    wb.Workbook.Names = [{ Name:'_xlnm.Print_Titles', Sheet:2, Ref:'PCGD!$1:$1' }];
    return { wb, meta, classes };
  }

  function _industrySetStatus(message, type){
    try{
      if(typeof _setStatus === 'function') return _setStatus(message, type || 'info');
      const el = document.getElementById('statusMsg');
      if(el) el.textContent = message;
    }catch(_){ }
  }

  function _industryCellStyleIds(xml){
    const ids = new Set();
    String(xml || '').replace(/<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>/g, (match, attrs, col, row) => {
      const style = attrs.match(/\bs="(\d+)"/);
      if(Number(row) >= 6 && Number(row) <= 35 && XLSX.utils.decode_col(col) >= 2 && style){
        ids.add(Number(style[1]));
      }
      return match;
    });
    return ids;
  }

  function _industryPcgdAssignmentStyleIds(xml){
    const ids = new Set();
    String(xml || '').replace(/<c\b([^>]*\br="E(\d+)"[^>]*)>/g, (match, attrs, row) => {
      const style = attrs.match(/\bs="(\d+)"/);
      if(Number(row) >= 2 && style) ids.add(Number(style[1]));
      return match;
    });
    return ids;
  }

  function _industryShrinkStyleXml(xf){
    let next = String(xf || '');
    const alignment = /<alignment\b([^>]*)\/>/;
    if(alignment.test(next)){
      next = next.replace(alignment, (_match, attrs) => {
        const clean = String(attrs || '')
          .replace(/\s+wrapText="(?:true|1)"/g, '')
          .replace(/\s+shrinkToFit="(?:true|1)"/g, '');
        return `<alignment${clean} shrinkToFit="1"/>`;
      });
      return next;
    }
    if(/<xf\b[^>]*\/>/.test(next)){
      return next.replace(
        /<xf\b([^>]*)\/>/,
        (_match, attrs) => `<xf${attrs} applyAlignment="1"><alignment shrinkToFit="1"/></xf>`
      );
    }
    return next.replace(/<\/xf>$/, '<alignment shrinkToFit="1"/></xf>');
  }

  function _industryLessonFont(stylesXml){
    const match = String(stylesXml || '').match(/<fonts\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
    if(!match) return { xml:stylesXml, fontId:0 };
    const fonts = match[2].match(/<font>[\s\S]*?<\/font>/g) || [];
    const existing = fonts.findIndex(font => (
      /<sz\s+val="8"\/>/.test(font)
      && /<name\s+val="Times New Roman"\/>/.test(font)
      && !/<b\/>/.test(font)
    ));
    if(existing >= 0) return { xml:stylesXml, fontId:existing };

    const font = `<font><sz val="8"/><name val="${INDUSTRY_FONT}"/><color rgb="${INDUSTRY_BLACK}"/></font>`;
    const replacement = match[0]
      .replace(/count="\d+"/, `count="${fonts.length + 1}"`)
      .replace('</fonts>', `${font}</fonts>`);
    return {
      xml:String(stylesXml).replace(match[0], replacement),
      fontId:fonts.length
    };
  }

  function _industryLessonStyleXml(xf, fontId){
    const withFont = String(xf || '').replace(/<xf\b([^>]*)/, (_match, attrs) => {
      let next = String(attrs || '');
      if(/\bfontId="\d+"/.test(next)) next = next.replace(/\bfontId="\d+"/, `fontId="${fontId}"`);
      else next += ` fontId="${fontId}"`;
      if(/\bapplyFont="\d+"/.test(next)) next = next.replace(/\bapplyFont="\d+"/, 'applyFont="1"');
      else next += ' applyFont="1"';
      return `<xf${next}`;
    });
    return _industryShrinkStyleXml(withFont);
  }

  function _industryAppendShrinkStyles(stylesXml, sourceIds){
    const lessonFont = _industryLessonFont(stylesXml);
    const match = String(lessonFont.xml || '').match(/<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
    if(!match) return { xml:lessonFont.xml, styleMap:new Map() };
    const styles = match[2].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
    const styleMap = new Map();
    const additions = [];
    Array.from(sourceIds).sort((a, b) => a - b).forEach(sourceId => {
      if(!styles[sourceId]) return;
      styleMap.set(sourceId, styles.length + additions.length);
      additions.push(_industryLessonStyleXml(styles[sourceId], lessonFont.fontId));
    });
    if(!additions.length) return { xml:lessonFont.xml, styleMap };
    const replacement = match[0]
      .replace(/count="\d+"/, `count="${styles.length + additions.length}"`)
      .replace('</cellXfs>', `${additions.join('')}</cellXfs>`);
    return { xml:String(lessonFont.xml).replace(match[0], replacement), styleMap };
  }

  function _industryPatchLessonStyles(xml, styleMap){
    return String(xml || '').replace(/<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>/g, (match, attrs, col, row) => {
      if(Number(row) < 6 || Number(row) > 35 || XLSX.utils.decode_col(col) < 2) return match;
      const style = attrs.match(/\bs="(\d+)"/);
      const replacement = style && styleMap.get(Number(style[1]));
      if(replacement == null) return match;
      return match.replace(/\bs="\d+"/, `s="${replacement}"`);
    });
  }

  function _industryPatchPcgdAssignmentStyles(xml, styleMap){
    return String(xml || '').replace(/<c\b([^>]*\br="E(\d+)"[^>]*)>/g, (match, attrs, row) => {
      if(Number(row) < 2) return match;
      const style = attrs.match(/\bs="(\d+)"/);
      const replacement = style && styleMap.get(Number(style[1]));
      if(replacement == null) return match;
      return match.replace(/\bs="\d+"/, `s="${replacement}"`);
    });
  }

  function _industryPatchWorksheetXml(xml, layout){
    const view = layout.schedule
      ? '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="5" topLeftCell="C6" activePane="bottomRight" state="frozen"/><selection pane="topRight" activeCell="C1" sqref="C1"/><selection pane="bottomLeft" activeCell="A6" sqref="A6"/><selection pane="bottomRight" activeCell="C6" sqref="C6"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
    let next = String(xml || '').replace(/<sheetViews[\s\S]*?<\/sheetViews>/, view);
    next = next.replace(/<pageSetup\b[^>]*\/>/g, '');
    const setup = '<pageSetup paperSize="9" orientation="landscape"/>';
    if(/<pageMargins\b[^>]*\/>/.test(next)){
      next = next.replace(/(<pageMargins\b[^>]*\/>)/, `$1${setup}`);
    }else{
      const marker = next.search(/<headerFooter\b|<ignoredErrors\b|<drawing\b|<extLst\b|<\/worksheet>/);
      next = marker >= 0 ? `${next.slice(0, marker)}${setup}${next.slice(marker)}` : `${next}${setup}`;
    }
    return next;
  }

  function _industryDownloadBytes(bytes, fileName){
    const blob = new Blob([bytes], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 0);
    return blob;
  }

  async function _industryWriteWorkbook(workbook, fileName){
    if(!window.JSZip) throw new Error('Chưa tải được thư viện đóng gói Excel JSZip.');
    const source = XLSX.write(workbook, {
      bookType:'xlsx',
      type:'array',
      compression:true,
      cellStyles:true
    });
    const zip = await window.JSZip.loadAsync(source);
    const schedulePaths = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'];
    const scheduleXml = [];
    const compactStyleIds = new Set();
    for(const path of schedulePaths){
      const file = zip.file(path);
      if(!file) throw new Error(`Thiếu bảng ${path} trong file CSDL ngành.`);
      const xml = await file.async('string');
      scheduleXml.push(xml);
      _industryCellStyleIds(xml).forEach(id => compactStyleIds.add(id));
    }

    const pcgdPath = 'xl/worksheets/sheet3.xml';
    const pcgdFile = zip.file(pcgdPath);
    if(!pcgdFile) throw new Error('Thiếu bảng PCGD trong file CSDL ngành.');
    const pcgdXml = await pcgdFile.async('string');
    _industryPcgdAssignmentStyleIds(pcgdXml).forEach(id => compactStyleIds.add(id));

    const stylesFile = zip.file('xl/styles.xml');
    if(!stylesFile) throw new Error('Thiếu định dạng Excel trong file CSDL ngành.');
    const patchedStyles = _industryAppendShrinkStyles(await stylesFile.async('string'), compactStyleIds);
    zip.file('xl/styles.xml', patchedStyles.xml);
    schedulePaths.forEach((path, index) => {
      const styled = _industryPatchLessonStyles(scheduleXml[index], patchedStyles.styleMap);
      zip.file(path, _industryPatchWorksheetXml(styled, { schedule:true }));
    });

    const styledPcgd = _industryPatchPcgdAssignmentStyles(pcgdXml, patchedStyles.styleMap);
    zip.file(pcgdPath, _industryPatchWorksheetXml(styledPcgd, { schedule:false }));

    const bytes = await zip.generateAsync({ type:'uint8array', compression:'DEFLATE' });
    _industryDownloadBytes(bytes, fileName);
    return bytes;
  }

  function _industryFileDateToday(){
    const now = new Date();
    return `${_pad2(now.getDate())}${_pad2(now.getMonth() + 1)}${now.getFullYear()}`;
  }

  function _industryNextFile(dateStamp){
    const key = `TKB_XLSX_EXPORT_SEQ::csdl::${dateStamp}`;
    let sequence = 1;
    try{
      const previous = Number(localStorage.getItem(key) || 0);
      sequence = Math.max(1, (Number.isFinite(previous) ? previous : 0) + 1);
    }catch(_){ }
    return { key, sequence, fileName:`csdl${_pad2(sequence)}${dateStamp}.xlsx` };
  }

  function _industryRememberFile(file){
    try{ localStorage.setItem(file.key, String(file.sequence)); }catch(_){ }
  }

  let industryExportQueue = Promise.resolve();

  async function _industryExportDatabaseExcel(){
    try{
      _industrySetStatus('Đang xuất CSDL ngành...', 'info');
      try{ if(typeof saveStore === 'function') saveStore({ force:true }); }catch(_){ }
      const built = _buildIndustryDatabaseWorkbook();
      const file = _industryNextFile(_industryFileDateToday());
      const outputBytes = await _industryWriteWorkbook(built.wb, file.fileName);
      _industryRememberFile(file);
      _industrySetStatus(`Đã xuất ${file.fileName} gồm ${built.classes.length} lớp và 3 bảng dữ liệu.`, 'ok');
      return { ok:true, fileName:file.fileName, workbook:built.wb, outputBytes };
    }catch(err){
      const message = err?.message || String(err || 'Không xuất được CSDL ngành.');
      console.error('exportIndustryDatabaseExcel failed', err);
      _industrySetStatus(message, 'error');
      alert(message);
      return null;
    }
  }

  window.exportIndustryDatabaseExcel = function(){
    const task = industryExportQueue.then(_industryExportDatabaseExcel, _industryExportDatabaseExcel);
    industryExportQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  window.__TKB_INDUSTRY_EXPORT_VERSION = INDUSTRY_EXPORT_VERSION;
})();
