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
})();
