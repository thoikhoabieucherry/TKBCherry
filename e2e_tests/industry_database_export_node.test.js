"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const xlsxSource = fs.readFileSync(path.join(root, "web", "vendor", "xlsx.min.js"), "utf8");
const jszipSource = fs.readFileSync(path.join(root, "web", "vendor", "jszip.min.js"), "utf8");
const exportSource = fs.readFileSync(path.join(root, "web", "pages", "tkb-export.js"), "utf8");
const menuSource = fs.readFileSync(path.join(root, "web", "pages", "tkb-constraints-menu.js"), "utf8");
const plannerSource = fs.readFileSync(path.join(root, "web", "pages", "phanmon.js"), "utf8");
const plannerHtml = fs.readFileSync(path.join(root, "web", "pages", "sapxep.html"), "utf8");

function teacherList(raw){
  return String(raw || "")
    .split(/[,+;]/)
    .map(value => value.trim())
    .filter(Boolean);
}

function makeContext(){
  const classes = [
    {id:"L1", ten:"6A1", gvcn:"GV1"},
    {id:"L2", ten:"6A2"}
  ];
  const teachers = [
    {hodem:"Nguyễn Văn", ten:"An", magv:"GV1", magv2:"T.An", tenTat:"SAI"},
    {hodem:"Trần Thị", ten:"Bình", magv:"GV2", magv2:"V.Bình"}
  ];
  const emptySession = () => ["", "", "", "", ""];
  const emptyDay = () => ({sang:emptySession(), chieu:emptySession()});
  const tkb = {L1:{}, L2:{}};
  for(const classId of Object.keys(tkb)){
    for(const day of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
      tkb[classId][day] = emptyDay();
    }
  }
  tkb.L1.thu2.sang[0] = "Toán";
  tkb.L1.thu2.chieu[0] = "Văn";
  tkb.L2.thu2.sang[0] = "Toán";

  const teacherByClassSubject = {
    "6A1|Toán":"GV1",
    "6A1|Văn":"GV2",
    "6A2|Toán":"GV1"
  };
  const names = {GV1:"Nguyễn Văn An", GV2:"Trần Thị Bình"};
  const required = {
    L1:[{mon:"Toán", required:4, gv:"GV1"}, {mon:"Văn", required:3, gv:"GV2"}],
    L2:[{mon:"Toán", required:4, gv:"GV1"}]
  };
  const alerts = [];
  const written = [];
  const downloads = [];
  const context = {
    console,
    Uint8Array,
    ArrayBuffer,
    Blob,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    alert(message){ alerts.push(String(message)); },
    URL:{
      createObjectURL(){ return "blob:industry-export"; },
      revokeObjectURL(){}
    },
    document:{
      querySelector(){ return null; },
      getElementById(){ return null; },
      createElement(){
        return {
          style:{},
          href:"",
          download:"",
          click(){ downloads.push({href:this.href, download:this.download}); },
          remove(){}
        };
      },
      body:{appendChild(){}}
    },
    DATA:{
      lop:classes,
      giaovien:teachers,
      tkb,
      pccmMatrix:teacherByClassSubject,
      pccmTietMatrix:{},
      tkbConstraints:{meta:{schoolName:"Trường THCS Cherry", scheduleNumber:"7", effectiveDate:"2026-03-02"}}
    },
    DAYS:["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"],
    SANG:5,
    CHIEU:5,
    classCanonFromLop(lop){ return lop.ten; },
    compareClassByDataOrder(a, b){ return classes.indexOf(a) - classes.indexOf(b); },
    getLopCanonById(id){ return classes.find(lop => lop.id === id)?.ten || id; },
    cellMon(value){ return value || ""; },
    getMonShort(mon){ return mon === "Văn" ? "Văn" : mon; },
    getTeacherForClassMon(className, mon){ return teacherByClassSubject[`${className}|${mon}`] || ""; },
    getTeacherNameByCode(code){ return names[code] || code; },
    getTeacherShort(code){ return `fallback-${code}`; },
    resolveTeacherCode(code){ return String(code || "").trim(); },
    teacherListFromValue:teacherList,
    requiredSubjectsForClass(lop){ return required[lop.id] || []; },
    saveStore(){},
    alerts,
    written,
    downloads
  };
  context.window = context;
  context.self = context;
  context.global = context;
  vm.createContext(context);
  vm.runInContext(xlsxSource, context);
  vm.runInContext(jszipSource, context);
  vm.runInContext(exportSource, context);
  return context;
}

async function savedWorkbookXml(context, bytes){
  const zip = await context.JSZip.loadAsync(bytes);
  return {
    morning:await zip.file("xl/worksheets/sheet1.xml").async("string"),
    afternoon:await zip.file("xl/worksheets/sheet2.xml").async("string"),
    pcgd:await zip.file("xl/worksheets/sheet3.xml").async("string"),
    styles:await zip.file("xl/styles.xml").async("string")
  };
}

function cellXfXmlList(stylesXml){
  const block = stylesXml.match(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/)?.[0] || "";
  return block.match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
}

function styleXmlAt(stylesXml, styleId){
  return cellXfXmlList(stylesXml)[Number(styleId)] || "";
}

function fontXmlAt(stylesXml, fontId){
  const block = stylesXml.match(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/)?.[0] || "";
  const fonts = block.match(/<font>[\s\S]*?<\/font>/g) || [];
  return fonts[Number(fontId)] || "";
}

function cellStyleId(sheetXml, address){
  return String(sheetXml || "").match(new RegExp(`<c\\s+[^>]*r="${address}"[^>]*\\bs="(\\d+)"`))?.[1] || "";
}

function assertCellFont(saved, sheetXml, address, size, bold){
  const styleId = cellStyleId(sheetXml, address);
  assert.ok(styleId, `${address} style is missing`);
  const style = styleXmlAt(saved.styles, styleId);
  const fontId = style.match(/\bfontId="(\d+)"/)?.[1];
  assert.ok(fontId, `${address} font is missing`);
  const font = fontXmlAt(saved.styles, fontId);
  assert.match(font, new RegExp(`<sz val="${size}"\\/>`));
  assert.match(font, /<name val="Times New Roman"\/>/);
  if(bold) assert.match(font, /<b\/>/);
  else assert.doesNotMatch(font, /<b\/>/);
}

test("requirements menu exposes the industry conversion directly below Print TKB", () => {
  const printIndex = menuSource.indexOf(">In TKB <");
  const industryIndex = menuSource.indexOf('data-rb-print="industry-database"');
  assert.ok(printIndex >= 0 && industryIndex > printIndex);
  assert.match(menuSource, /Chuyển CSDL ngành/);
  assert.match(plannerSource, /key === "industry-database"[\s\S]*?exportIndustryDatabaseExcel/);
  assert.match(plannerHtml, /tkb-export\.js\?v=20260725-v197-industry-font8-v1/);
  assert.match(plannerHtml, /tkb-constraints-menu\.js\?v=20260725-v194-industry-export-v2/);
});

test("industry export matches the three-sheet sample and uses MaGV2 in timetable cells", async () => {
  const context = makeContext();
  const result = await context.exportIndustryDatabaseExcel();

  assert.equal(result.ok, true);
  assert.equal(result.fileName, "CSDL_nganh_TKB_7.xlsx");
  assert.equal(context.downloads.length, 1);
  assert.equal(context.downloads[0].download, result.fileName);
  assert.ok(result.outputBytes instanceof Uint8Array);
  assert.deepEqual(Array.from(result.workbook.SheetNames), ["TKB_LOP_S", "TKB_LOP_C", "PCGD"]);
  assert.equal(context.alerts.length, 0);

  const morning = result.workbook.Sheets.TKB_LOP_S;
  const afternoon = result.workbook.Sheets.TKB_LOP_C;
  assert.equal(morning.A1.v, "TRƯỜNG THCS CHERRY\nNăm học 2025 - 2026\nHọc kỳ 2");
  assert.equal(morning.F1.v, "THỜI KHOÁ BIỂU số 7");
  assert.equal(morning.F2.v, "BUỔI SÁNG");
  assert.equal(morning.F3.v, "Thực hiện từ ngày 02 tháng 03 năm 2026");
  assert.equal(morning.C5.v, "6A1");
  assert.equal(morning.D5.v, "6A2");
  assert.equal(morning.C6.v, "Toán - T.An");
  assert.equal(morning.D6.v, "Toán - T.An");
  assert.equal(afternoon.C6.v, "Văn - V.Bình");
  assert.equal(morning.C6.v.includes("SAI"), false, "legacy short-name fields must not override MaGV2");
  assert.equal(morning["!cols"][0].width, 4.625);
  assert.equal(morning["!cols"][2].width, 12.125);
  assert.equal(morning.E4.s.fill.fgColor.rgb, "FFFFFFFF");
  assert.ok(morning["!merges"].some(merge => merge.s.r === 0 && merge.s.c === 0 && merge.e.r === 2 && merge.e.c === 4));

  const pcgd = result.workbook.Sheets.PCGD;
  assert.equal(pcgd.A1.v, "TT");
  assert.equal(pcgd.B1.v, "Giáo viên");
  assert.equal(pcgd.B2.v, "Nguyễn Văn An");
  assert.equal(pcgd.D2.v, "6A1");
  assert.equal(pcgd.E2.v, "Toán (6A1, 6A2)");
  assert.equal(pcgd.F2.v, 8);
  assert.equal(pcgd.B3.v, "Trần Thị Bình");
  assert.equal(pcgd.E3.v, "Văn (6A1)");
  assert.equal(pcgd.F3.v, 3);
  assert.equal(result.workbook.Workbook.Names[0].Ref, "PCGD!$1:$1");

  const saved = await savedWorkbookXml(context, result.outputBytes);
  const roundTrip = context.XLSX.read(result.outputBytes, {type:"array", cellStyles:true});
  assert.deepEqual(Array.from(roundTrip.SheetNames), ["TKB_LOP_S", "TKB_LOP_C", "PCGD"]);
  assert.equal(roundTrip.Sheets.TKB_LOP_S.C6.v, "Toán - T.An");
  assert.equal(roundTrip.Sheets.PCGD.F2.v, 8);
  assert.match(saved.morning, /<pane xSplit="2" ySplit="5" topLeftCell="C6"[^>]*state="frozen"\/>/);
  assert.match(saved.afternoon, /<pane xSplit="2" ySplit="5" topLeftCell="C6"[^>]*state="frozen"\/>/);
  assert.match(saved.pcgd, /<pane ySplit="1" topLeftCell="A2"[^>]*state="frozen"\/>/);
  assert.match(saved.morning, /<pageSetup paperSize="9" orientation="landscape"\/>/);
  assert.match(saved.pcgd, /<pageSetup paperSize="9" orientation="landscape"\/>/);
  assert.match(saved.morning, /<col min="1" max="1"[^>]*width="4\.625"/);
  assert.match(saved.morning, /<col min="3" max="3"[^>]*width="12\.125"/);
  const declaredStyleCount = Number(saved.styles.match(/<cellXfs\b[^>]*count="(\d+)"/)?.[1] || -1);
  const cellStyles = cellXfXmlList(saved.styles);
  assert.equal(declaredStyleCount, cellStyles.length, "cellXfs count must match the actual style list");
  for(const sheetXml of [saved.morning, saved.afternoon, saved.pcgd]){
    for(const match of sheetXml.matchAll(/<c\b[^>]*\bs="(\d+)"[^>]*>/g)){
      assert.ok(Number(match[1]) < declaredStyleCount, `cell style ${match[1]} must be inside cellXfs`);
    }
  }
  const c6Style = cellStyleId(saved.morning, "C6");
  assert.ok(c6Style, "saved C6 style is missing");
  const c6StyleXml = styleXmlAt(saved.styles, c6Style);
  const c6FontId = c6StyleXml.match(/\bfontId="(\d+)"/)?.[1];
  assert.ok(c6FontId, "saved C6 font is missing");
  assert.match(c6StyleXml, /<alignment[^>]*shrinkToFit="1"/);
  assert.doesNotMatch(c6StyleXml, /wrapText=/);
  assert.match(fontXmlAt(saved.styles, c6FontId), /<sz val="8"\/>/);
  assert.match(fontXmlAt(saved.styles, c6FontId), /<name val="Times New Roman"\/>/);
  assert.doesNotMatch(fontXmlAt(saved.styles, c6FontId), /<b\/>/);
  const lessonStyleIds = new Set();
  for(const sheetXml of [saved.morning, saved.afternoon]){
    for(const match of sheetXml.matchAll(/<c\s+[^>]*r="([A-Z]+)([6-9]|[12]\d|3[0-5])"[^>]*\bs="(\d+)"/g)){
      if(context.XLSX.utils.decode_col(match[1]) >= 2) lessonStyleIds.add(match[3]);
    }
  }
  assert.ok(lessonStyleIds.size > 0);
  lessonStyleIds.forEach(styleId => {
    const styleXml = styleXmlAt(saved.styles, styleId);
    const fontId = styleXml.match(/\bfontId="(\d+)"/)?.[1];
    assert.ok(fontId, `lesson style ${styleId} font is missing`);
    assert.match(styleXml, /<alignment[^>]*shrinkToFit="1"/);
    assert.doesNotMatch(styleXml, /wrapText=/);
    assert.match(fontXmlAt(saved.styles, fontId), /<sz val="8"\/>/);
    assert.match(fontXmlAt(saved.styles, fontId), /<name val="Times New Roman"\/>/);
    assert.doesNotMatch(fontXmlAt(saved.styles, fontId), /<b\/>/);
  });
  assertCellFont(saved, saved.morning, "C5", 9, true);
  assertCellFont(saved, saved.pcgd, "A1", 10, true);
  assertCellFont(saved, saved.pcgd, "B2", 11, false);
  assert.match(saved.styles, /<font><sz val="24"\/><name val="Times New Roman"\/><b\/>/);
  assert.match(saved.styles, /<font><sz val="26"\/><name val="Times New Roman"\/><b\/>/);
  assert.match(saved.styles, /<font><sz val="10"\/><name val="Times New Roman"\/><b\/>/);
});

test("industry export canonicalizes MaGV2 aliases without duplicate teachers or totals", async () => {
  const context = makeContext();
  context.DATA.pccmMatrix["6A1|Toán"] = "GV1, T.An";
  context.DATA.lop[0].gvcn = "T.An";
  context.requiredSubjectsForClass = lop => lop.id === "L1"
    ? [{mon:"Toán", required:4, gv:"GV1, T.An"}, {mon:"Văn", required:3, gv:"GV2"}]
    : [{mon:"Toán", required:4, gv:"GV1"}];

  const result = await context.exportIndustryDatabaseExcel();
  const morning = result.workbook.Sheets.TKB_LOP_S;
  const pcgd = result.workbook.Sheets.PCGD;

  assert.equal(morning.C6.v, "Toán - T.An");
  assert.equal(pcgd["!ref"], "A1:F3");
  assert.equal(pcgd.B2.v, "Nguyễn Văn An");
  assert.equal(pcgd.D2.v, "6A1");
  assert.equal(pcgd.F2.v, 8);
});

test("industry export keeps genuine co-teachers distinct with an unambiguous separator", async () => {
  const context = makeContext();
  context.DATA.pccmMatrix["6A1|Toán"] = "GV1, GV2";
  context.requiredSubjectsForClass = lop => lop.id === "L1"
    ? [{mon:"Toán", required:4, gv:"GV1, GV2"}, {mon:"Văn", required:3, gv:"GV2"}]
    : [{mon:"Toán", required:4, gv:"GV1"}];

  const result = await context.exportIndustryDatabaseExcel();
  const morning = result.workbook.Sheets.TKB_LOP_S;
  const pcgd = result.workbook.Sheets.PCGD;

  assert.equal(morning.C6.v, "Toán - T.An, V.Bình");
  assert.equal(pcgd.F2.v, 8);
  assert.equal(pcgd.F3.v, 7);
});

test("industry export sanitizes imported schedule numbers in the download name", async () => {
  const context = makeContext();
  context.DATA.tkbConstraints.meta.scheduleNumber = "7/2:*";

  const result = await context.exportIndustryDatabaseExcel();

  assert.equal(result.fileName, "CSDL_nganh_TKB_7_2_.xlsx");
  assert.equal(context.downloads[0].download, result.fileName);
});
