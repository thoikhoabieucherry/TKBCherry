(function(){
  const FONT_NAME = 'Times New Roman';
  const INK = '1F2937';
  const MUTED = '475569';
  const BORDER = '94A3B8';
  const HEADER_FILL = 'D9EAF7';
  const TITLE_FILL = 'EAF4FF';
  const SECTION_FILL = 'EEF2F7';

  function clone(value){
    return JSON.parse(JSON.stringify(value || {}));
  }

  function merge(base, extra){
    const out = clone(base);
    Object.entries(extra || {}).forEach(([key, value])=>{
      if(value && typeof value === 'object' && !Array.isArray(value)){
        out[key] = merge(out[key] || {}, value);
      }else{
        out[key] = value;
      }
    });
    return out;
  }

  function border(color, style){
    const edge = { style: style || 'thin', color: { rgb: color || BORDER } };
    return { top: clone(edge), bottom: clone(edge), left: clone(edge), right: clone(edge) };
  }

  function fill(rgb){
    return { patternType: 'solid', fgColor: { rgb } };
  }

  function asArrayRows(rows){
    if(!Array.isArray(rows)) return [];
    if(!rows.length) return [];
    if(Array.isArray(rows[0])) return rows;
    const headers = Object.keys(rows[0] || {});
    return [headers, ...rows.map(row=>headers.map(key=>row?.[key] ?? ''))];
  }

  function colCount(rows, fallback){
    return Math.max(
      Number(fallback || 0),
      1,
      ...asArrayRows(rows).map(row=>Array.isArray(row) ? row.length : 0)
    );
  }

  function cell(ws, r, c){
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = ws[addr] || { t: 's', v: '' };
    return ws[addr];
  }

  function computeWidths(rows, widthHints, opts){
    const matrix = asArrayRows(rows);
    const count = colCount(matrix, Array.isArray(widthHints) ? widthHints.length : 0);
    const min = Number(opts?.minWidth || 8);
    const max = Number(opts?.maxWidth || 42);
    return Array.from({ length: count }, (_, c)=>{
      if(widthHints && widthHints[c] != null){
        const raw = typeof widthHints[c] === 'object' ? widthHints[c].wch : widthHints[c];
        return { wch: Math.max(min, Math.min(max, Number(raw || min))) };
      }
      let maxLen = 0;
      matrix.forEach(row=>{
        const value = row && c < row.length ? row[c] : '';
        String(value == null ? '' : value).split(/\r?\n/).forEach(part=>{
          maxLen = Math.max(maxLen, part.length);
        });
      });
      return { wch: Math.max(min, Math.min(max, maxLen + 2)) };
    });
  }

  function rowHeightFor(index, opts){
    if(opts?.rowHeights && opts.rowHeights[index] != null) return opts.rowHeights[index];
    const titleRows = new Set(opts?.titleRows || []);
    const headerRows = new Set(opts?.headerRows || []);
    const sectionRows = new Set(opts?.sectionRows || []);
    if(titleRows.has(index)) return Number(opts?.titleRowHeight || 30);
    if(headerRows.has(index)) return Number(opts?.headerRowHeight || 24);
    if(sectionRows.has(index)) return Number(opts?.sectionRowHeight || 24);
    return Number(opts?.bodyRowHeight || 22);
  }

  function baseStyle(value, c, opts){
    const isNumber = typeof value === 'number';
    const horizontal = opts?.centerAll ? 'center' : (c === 0 && String(value || '').length <= 8 ? 'center' : (isNumber ? 'right' : 'left'));
    return {
      font: { name: FONT_NAME, sz: Number(opts?.fontSize || 12), color: { rgb: INK } },
      alignment: { vertical: 'center', horizontal, wrapText: true },
      border: border(opts?.borderColor || BORDER, opts?.borderStyle || 'thin')
    };
  }

  function styleSheet(ws, rows, opts){
    const matrix = asArrayRows(rows);
    const rowCount = Math.max(1, matrix.length);
    const count = colCount(matrix, opts?.widths?.length);
    const titleRows = new Set(opts?.titleRows || []);
    const headerRows = new Set(opts?.headerRows == null ? [0] : opts.headerRows);
    const sectionRows = new Set(opts?.sectionRows || []);

    ws['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rowCount - 1, c: count - 1 }
    });
    ws['!cols'] = computeWidths(matrix, opts?.widths, opts);
    ws['!rows'] = Array.from({ length: rowCount }, (_, r)=>({ hpt: rowHeightFor(r, opts) }));

    for(let r = 0; r < rowCount; r++){
      const row = matrix[r] || [];
      for(let c = 0; c < count; c++){
        const target = cell(ws, r, c);
        const value = c < row.length ? row[c] : target.v;
        let next = baseStyle(value, c, opts);
        if(titleRows.has(r)){
          next = merge(next, {
            font: { name: FONT_NAME, bold: true, sz: Number(opts?.titleFontSize || 15), color: { rgb: opts?.titleFontColor || INK } },
            fill: fill(opts?.titleFill || TITLE_FILL),
            alignment: { horizontal: c === 0 ? 'left' : 'center', vertical: 'center', wrapText: true },
            border: border(opts?.titleBorderColor || BORDER, opts?.titleBorderStyle || 'thin')
          });
        }else if(headerRows.has(r)){
          next = merge(next, {
            font: { name: FONT_NAME, bold: true, sz: Number(opts?.headerFontSize || 12), color: { rgb: opts?.headerFontColor || INK } },
            fill: fill(opts?.headerFill || HEADER_FILL),
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: border(opts?.headerBorderColor || BORDER, opts?.headerBorderStyle || 'thin')
          });
        }else if(sectionRows.has(r)){
          next = merge(next, {
            font: { name: FONT_NAME, bold: true, sz: Number(opts?.sectionFontSize || 12), color: { rgb: MUTED } },
            fill: fill(opts?.sectionFill || SECTION_FILL),
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: border(opts?.sectionBorderColor || BORDER, opts?.sectionBorderStyle || 'thin')
          });
        }
        target.s = merge(target.s && typeof target.s === 'object' ? target.s : {}, next);
      }
    }

    if(opts?.freeze){
      ws['!freeze'] = opts.freeze;
      ws['!views'] = [Object.assign({ state: 'frozen' }, opts.freeze)];
    }
    if(opts?.filterRow != null && opts.filterRow !== false){
      const filterRow = Math.max(0, Number(opts.filterRow) || 0);
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({
        s: { r: filterRow, c: 0 },
        e: { r: Math.max(filterRow, rowCount - 1), c: Math.max(0, count - 1) }
      }) };
    }

    return ws;
  }

  function applyFontToSheet(ws, opts){
    const range = XLSX.utils.decode_range(opts?.range || ws['!ref'] || 'A1:A1');
    for(let r = range.s.r; r <= range.e.r; r++){
      for(let c = range.s.c; c <= range.e.c; c++){
        const target = cell(ws, r, c);
        const prev = target.s && typeof target.s === 'object' ? target.s : {};
        target.s = merge(prev, {
          font: merge(prev.font || {}, { name: FONT_NAME }),
          alignment: merge(prev.alignment || {}, { vertical: 'center', wrapText: true })
        });
      }
    }
  }

  function writeOptions(extra){
    return Object.assign({ compression: true, cellStyles: true }, extra || {});
  }

  function xmlEscape(value){
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function xmlText(value){
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function dataValidationXml(items){
    const validations = (items || []).filter(item=>item?.range && item?.formula1);
    if(!validations.length) return '';
    const body = validations.map(item=>{
      const allowBlank = item.allowBlank === false ? '0' : '1';
      const errorStyle = xmlEscape(item.errorStyle || 'warning');
      return `<dataValidation type="list" allowBlank="${allowBlank}" showErrorMessage="1" errorStyle="${errorStyle}" sqref="${xmlEscape(item.range)}"><formula1>${xmlText(item.formula1)}</formula1></dataValidation>`;
    }).join('');
    return `<dataValidations count="${validations.length}">${body}</dataValidations>`;
  }

  function injectDataValidationsXml(xml, items){
    const block = dataValidationXml(items);
    if(!block) return xml;
    let next = String(xml || '').replace(/<dataValidations[\s\S]*?<\/dataValidations>/g, '');
    const markers = [
      '<hyperlinks',
      '<printOptions',
      '<pageMargins',
      '<pageSetup',
      '<headerFooter',
      '<ignoredErrors',
      '<drawing',
      '<legacyDrawing',
      '<tableParts',
      '<extLst',
      '</worksheet>'
    ];
    let pos = -1;
    for(const marker of markers){
      pos = next.indexOf(marker);
      if(pos >= 0) break;
    }
    if(pos < 0) return `${next}${block}`;
    return `${next.slice(0, pos)}${block}${next.slice(pos)}`;
  }

  function downloadBlob(blob, fileName){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  async function writeFile(workbook, fileName, opts){
    const validations = Array.isArray(opts?.dataValidations) ? opts.dataValidations : [];
    if(!validations.length || !window.JSZip){
      XLSX.writeFile(workbook, fileName, writeOptions(opts?.writeOptions));
      return;
    }

    const bytes = XLSX.write(workbook, Object.assign(writeOptions(opts?.writeOptions), {
      bookType: 'xlsx',
      type: 'array'
    }));
    const zip = await window.JSZip.loadAsync(bytes);
    const grouped = new Map();
    validations.forEach(item=>{
      const sheetName = String(item?.sheetName || '');
      if(!sheetName) return;
      if(!grouped.has(sheetName)) grouped.set(sheetName, []);
      grouped.get(sheetName).push(item);
    });

    for(const [sheetName, items] of grouped.entries()){
      const index = (workbook.SheetNames || []).indexOf(sheetName);
      if(index < 0) continue;
      const path = `xl/worksheets/sheet${index + 1}.xml`;
      const file = zip.file(path);
      if(!file) continue;
      const xml = await file.async('string');
      zip.file(path, injectDataValidationsXml(xml, items));
    }

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    downloadBlob(blob, fileName);
    return blob;
  }

  window.TKBExcelStyle = {
    fontName: FONT_NAME,
    border,
    cell,
    styleSheet,
    applyFontToSheet,
    writeFile,
    writeOptions
  };
})();
