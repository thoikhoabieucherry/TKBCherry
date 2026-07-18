(function(){
  'use strict';

  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const A4_PORTRAIT = { w: 11906, h: 16838 };
  const PAGE_MARGIN = 220;
  const PAGE_INNER_W = A4_PORTRAIT.w - PAGE_MARGIN * 2;
  const PAGE_INNER_H = A4_PORTRAIT.h - PAGE_MARGIN * 2;
  const CARD_COL_W = Math.floor(PAGE_INNER_W / 2);
  const CARD_ROW_H = Math.floor(PAGE_INNER_H / 4);
  const CARD_INNER_W = CARD_COL_W - 180;
  const DAY_COUNT = 6;
  const PERIOD_COL_W = 285;
  const DAY_COL_W = Math.floor((CARD_INNER_W - PERIOD_COL_W) / DAY_COUNT);
  const SCHEDULE_TABLE_W = PERIOD_COL_W + DAY_COL_W * DAY_COUNT;

  function safe(v){
    return v == null ? '' : String(v).trim();
  }

  function xml(v){
    return safe(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
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
    if(m) return { day: m[3], month: m[2], year: m[1] };
    return todayParts();
  }

  function fileDateToday(){
    const d = todayParts();
    return `${d.day}${d.month}${d.year}`;
  }

  function dateLineFromInfo(value){
    const d = parseDateInput(value);
    return `Thực hiện từ ngày ${d.day} tháng ${d.month} năm ${d.year}`;
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

  function parseJson(raw, fallback){
    try{ return raw ? JSON.parse(raw) : fallback; }catch(_){ return fallback; }
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

  function getScheduleNumber(){
    const meta = getInfoMeta();
    return safe(meta.scheduleNumber || meta.scheduleNo || meta.tkbNumber) || '1';
  }

  function getEffectiveDateLine(){
    const meta = getInfoMeta();
    return dateLineFromInfo(meta.effectiveDate || meta.applyDate || meta.ngayApDung || '');
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

  function monShort(mon){
    try{ return safe(getMonShort(mon)); }catch(_){ return safe(mon); }
  }

  function lessonText(lopCanon, raw){
    if(!raw || raw === 'OFF') return '';
    let mon = '';
    try{ mon = safe(cellMon(raw)); }catch(_){ mon = safe(raw?.mon || raw); }
    return mon ? monShort(mon) : '';
  }

  function classSchedulePayload(){
    const classId = currentClassIdForExport();
    if(!classId) throw new Error('Chưa có lớp để xuất Word.');
    const lop = currentClassRecord(classId);
    const tkb = DATA?.tkb?.[classId];
    if(!tkb) throw new Error('Lớp hiện tại chưa có thời khóa biểu.');
    const lopCanon = classDisplay(lop) || classId;
    const days = (typeof DAYS !== 'undefined' && Array.isArray(DAYS) && DAYS.length) ? DAYS : ['thu2','thu3','thu4','thu5','thu6','thu7'];
    const labels = days.map(d => {
      try{ return LABEL?.[d] || d; }catch(_){ return d; }
    }).map(x => safe(x).toUpperCase());
    const sangCount = Number(typeof SANG !== 'undefined' ? SANG : 5) || 5;
    const chieuCount = Number(typeof CHIEU !== 'undefined' ? CHIEU : 5) || 5;
    const sessionRows = (session, count) => {
      const rows = [];
      for(let ti = 0; ti < count; ti++){
        rows.push(days.map(d => lessonText(lopCanon, tkb?.[d]?.[session]?.[ti])));
      }
      return rows;
    };
    return {
      schoolName: getStoredSchoolName(),
      scheduleNumber: getScheduleNumber(),
      effectiveDateLine: getEffectiveDateLine(),
      className: lopCanon,
      dayLabels: labels,
      morning: sessionRows('sang', sangCount),
      afternoon: sessionRows('chieu', chieuCount)
    };
  }

  function r(text, opt){
    opt = opt || {};
    const size = Math.max(1, Math.round(Number(opt.size || 10) * 2));
    const bold = opt.bold ? '<w:b/>' : '';
    const italic = opt.italic ? '<w:i/>' : '';
    return `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${bold}${italic}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  }

  function p(text, opt){
    opt = opt || {};
    const align = opt.align || 'left';
    const line = Number(opt.line || 150);
    const before = Number(opt.before || 0);
    const after = Number(opt.after || 0);
    return `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="exact"/></w:pPr>${r(text, opt)}</w:p>`;
  }

  function emptyP(){
    return '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>';
  }

  function borders(type){
    if(type === 'none'){
      return '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
    }
    return '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="444444"/><w:left w:val="single" w:sz="4" w:color="444444"/><w:bottom w:val="single" w:sz="4" w:color="444444"/><w:right w:val="single" w:sz="4" w:color="444444"/><w:insideH w:val="single" w:sz="4" w:color="666666"/><w:insideV w:val="single" w:sz="4" w:color="666666"/></w:tblBorders>';
  }

  function tbl(width, columns, rows, opt){
    opt = opt || {};
    const grid = columns.map(w => `<w:gridCol w:w="${w}"/>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/>${borders(opt.borders || 'single')}<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
  }

  function tr(cells, height){
    const trPr = height ? `<w:trPr><w:trHeight w:val="${height}" w:hRule="exact"/></w:trPr>` : '';
    return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
  }

  function tc(content, width, opt){
    opt = opt || {};
    const margin = opt.margin == null ? 22 : Number(opt.margin);
    const valign = opt.valign || 'center';
    const shade = opt.shade ? `<w:shd w:fill="${opt.shade}"/>` : '';
    const tcBorders = opt.noBorders ? '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="${valign}"/>${shade}${tcBorders}<w:tcMar><w:top w:w="${margin}" w:type="dxa"/><w:left w:w="${margin}" w:type="dxa"/><w:bottom w:w="${margin}" w:type="dxa"/><w:right w:w="${margin}" w:type="dxa"/></w:tcMar></w:tcPr>${content || emptyP()}</w:tc>`;
  }

  function headerTable(data){
    const leftW = Math.floor(SCHEDULE_TABLE_W * 0.31);
    const rightW = Math.floor(SCHEDULE_TABLE_W * 0.17);
    const centerW = SCHEDULE_TABLE_W - leftW - rightW;
    const center =
      p('THỜI KHOÁ BIỂU', {align:'center', size:13.5, bold:true, line:175}) +
      p(`Lớp ${data.className}`, {align:'center', size:10.8, bold:true, line:190}) +
      p(`(${data.effectiveDateLine})`, {align:'center', size:6.6, italic:true, line:122});
    return tbl(SCHEDULE_TABLE_W, [leftW, centerW, rightW], [
      tr([
        tc(p(data.schoolName, {size:7.2, line:112}), leftW, {valign:'top', margin:22}),
        tc(center, centerW, {margin:16}),
        tc(p(`Số ${data.scheduleNumber}`, {align:'right', size:9.6, bold:true, line:150}), rightW, {valign:'top', margin:18})
      ], 540)
    ]);
  }

  function sectionTitle(text){
    return p(text, {size:8.6, bold:true, line:128, before:22, after:4});
  }

  function scheduleTable(data, rows){
    const cols = [PERIOD_COL_W, ...Array.from({length: DAY_COUNT}, () => DAY_COL_W)];
    const fixedRows = rows.slice(0, 5);
    while(fixedRows.length < 5) fixedRows.push(Array.from({length: DAY_COUNT}, () => ''));
    const body = [
      tr([
        tc(p('Tiết', {align:'center', size:6.4, bold:true, line:112}), PERIOD_COL_W, {margin:8, shade:'F2F2F2'}),
        ...data.dayLabels.map(label => tc(p(label, {align:'center', size:6.4, bold:true, line:112}), DAY_COL_W, {margin:8, shade:'F2F2F2'}))
      ], 160),
      ...fixedRows.map((row, rowIndex) => tr([
        tc(p(String(rowIndex + 1), {align:'center', size:6.4, bold:true, line:118}), PERIOD_COL_W, {margin:8, shade:'FAFAFA'}),
        ...Array.from({length: DAY_COUNT}, (_, idx) => tc(p(row[idx] || '', {align:'center', size:7.2, bold:true, line:132}), DAY_COL_W, {margin:8}))
      ], 225))
    ];
    return tbl(SCHEDULE_TABLE_W, cols, body);
  }

  function cardXml(data){
    const content =
      headerTable(data) +
      p('', {size:2, line:34}) +
      sectionTitle('Buổi sáng') +
      scheduleTable(data, data.morning) +
      sectionTitle('Buổi chiều') +
      scheduleTable(data, data.afternoon) +
      emptyP();
    return tbl(CARD_INNER_W, [CARD_INNER_W], [
      tr([tc(content, CARD_INNER_W, {margin:44, valign:'top'})], CARD_ROW_H - 90)
    ]);
  }

  function documentXml(data){
    const card = cardXml(data);
    const rows = [];
    for(let rIdx = 0; rIdx < 4; rIdx++){
      rows.push(tr([
        tc(card + emptyP(), CARD_COL_W, {noBorders:true, valign:'top', margin:38}),
        tc(card + emptyP(), CARD_COL_W, {noBorders:true, valign:'top', margin:38})
      ], CARD_ROW_H));
    }
    const pageTable = tbl(PAGE_INNER_W, [CARD_COL_W, CARD_COL_W], rows, {borders:'none'});
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${pageTable}
    <w:sectPr>
      <w:pgSz w:w="${A4_PORTRAIT.w}" w:h="${A4_PORTRAIT.h}"/>
      <w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="0" w:footer="0" w:gutter="0"/>
      <w:cols w:space="0"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  function stylesXml(){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman"/></w:rPr></w:style>
</w:styles>`;
  }

  function contentTypesXml(){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  }

  function relsXml(){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  function coreXml(){
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Thời khoá biểu lớp học</dc:title>
  <dc:creator>SmartScheduler</dc:creator>
  <cp:lastModifiedBy>SmartScheduler</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  function appXml(){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>SmartScheduler</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company></Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0</AppVersion>
</Properties>`;
  }

  async function buildDocxBlob(data){
    if(!window.JSZip) throw new Error('Chưa tải được thư viện tạo file Word.');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypesXml());
    zip.folder('_rels').file('.rels', relsXml());
    zip.folder('docProps').file('core.xml', coreXml());
    zip.folder('docProps').file('app.xml', appXml());
    const word = zip.folder('word');
    word.file('document.xml', documentXml(data));
    word.file('styles.xml', stylesXml());
    word.folder('_rels').file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    return zip.generateAsync({type:'blob', mimeType:DOCX_MIME, compression:'DEFLATE'});
  }

  function fallbackSequence(dateStamp){
    const key = `TKB_DOCX_EXPORT_SEQ::${dateStamp}`;
    const next = Math.max(1, Number(localStorage.getItem(key) || 0) + 1);
    localStorage.setItem(key, String(next));
    return next;
  }

  function nextSequence(dateStamp){
    const key = `TKB_DOCX_EXPORT_SEQ::${dateStamp}`;
    return Math.max(1, Number(localStorage.getItem(key) || 0) + 1);
  }

  function rememberSequence(dateStamp, sequence){
    const key = `TKB_DOCX_EXPORT_SEQ::${dateStamp}`;
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

  async function saveDocx(blob, dateStamp){
    const seq = nextSequence(dateStamp);
    const fileName = `${pad2(seq)}${dateStamp}.docx`;
    const result = await saveBlobWithPicker(blob, fileName, DOCX_MIME, 'docx', 'Word Document');
    if(result?.ok) rememberSequence(dateStamp, seq);
    return result;
    try{
      const response = await fetch(`/api/export/tkb-class-docx?date=${encodeURIComponent(dateStamp)}`, {
        method: 'POST',
        headers: {'Content-Type': DOCX_MIME},
        body: blob
      });
      const payload = await response.json().catch(() => null);
      if(response.ok && payload?.ok) return payload;
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }catch(err){
      console.warn('save docx endpoint unavailable, falling back to browser download', err);
      const seq = fallbackSequence(dateStamp);
      const fileName = `${pad2(seq)}${dateStamp}.docx`;
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

  window.exportCurrentClassTKBDocx = async function(){
    try{
      setStatus('Đang xuất file Word...', 'info');
      try{ saveStore({force:true}); }catch(_){ }
      const payload = classSchedulePayload();
      const blob = await buildDocxBlob(payload);
      const result = await saveDocx(blob, fileDateToday());
      if(result?.canceled){
        setStatus('Đã hủy lưu file Word.', 'info');
        return result;
      }
      const where = result.path || result.fileName || '';
      setStatus(`Đã xuất Word: ${where}`, 'ok');
      return result;
    }catch(err){
      const msg = err && (err.message || String(err)) || 'Không xuất được file Word.';
      setStatus(msg, 'error');
      alert(msg);
      return null;
    }
  };
})();
