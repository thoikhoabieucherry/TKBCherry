"use strict";

// 01/10/2026 (chủ dự án, THCS Tăng Bạt Hổ — 2 cơ sở): "khi xuất ra, trên TKB của giáo viên và TKB tổng
// trên file Excel cần thể hiện các màu ở Địa điểm để người ta phân biệt như trên web". Web tô vạch màu
// cạnh trái ô TKB giáo viên theo địa điểm (tkbLocationCellInfo, 23/09). File Excel (mẫu 1, mẫu 2, tổng
// theo lớp, tổng theo GV) nay tô ô cùng màu: nền nhạt + cạnh trái đậm, kèm chú thích tên địa điểm.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const EXPORT_PATH = path.join(ROOT, "web", "pages", "tkb-student-excel-export.js");
const PHANMON_SOURCE = fs.readFileSync(path.join(ROOT, "web", "pages", "phanmon.js"), "utf8");

function extract(name){
  const start = PHANMON_SOURCE.indexOf(`function ${name}(`);
  const end = PHANMON_SOURCE.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, `${name} must be extractable from phanmon.js`);
  return PHANMON_SOURCE.slice(start, end);
}

const BLUE = {edge: "FF1677FF", fill: "FFBAE0FF"};
const ORANGE = {edge: "FFFA8C16", fill: "FFFFE7BA"};

function emptyDay(){
  return {sang: ["", "", "", "", "OFF"], chieu: ["", "", "", "OFF", "OFF"]};
}

function makeData(twoLocations){
  const tkb = {};
  ["L1", "L2", "L3"].forEach(id => {
    tkb[id] = {};
    ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"].forEach(d => { tkb[id][d] = emptyDay(); });
  });
  tkb.L1.thu2.sang[2] = "Toán";     // GV T: 6A1A (Địa điểm 1) T2 sáng tiết 3
  tkb.L2.thu3.sang[0] = "Toán";     // GV T: 6A1B (Địa điểm 2) T3 sáng tiết 1
  tkb.L1.thu4.sang[0] = "Văn";      // GV V: 6A1A ...
  tkb.L3.thu4.sang[0] = "Văn";      // ... và 6A2B cùng tiết, khác địa điểm -> trùng lịch, không tô
  tkb.L1.thu5.chieu[1] = "Anh";     // GV A: lớp ở Địa điểm 1 nhưng học PHÒNG thuộc Địa điểm 2
  return {
    lop: [
      {id: "L1", ten: "6A1A", diadiem: "Địa điểm 1"},
      {id: "L2", ten: "6A1B", diadiem: twoLocations ? "Địa điểm 2" : "Địa điểm 1"},
      {id: "L3", ten: "6A2B", diadiem: twoLocations ? "Địa điểm 2" : "Địa điểm 1"},
    ],
    phong: [{id: "P1", ten: "Phòng Lab", diadiem: twoLocations ? "Địa điểm 2" : "Địa điểm 1"}],
    giaovien: [{magv: "T", hodem: "Nguyễn", ten: "Toán"}, {magv: "V", hodem: "Lê", ten: "Văn"}, {magv: "A", hodem: "Trần", ten: "Anh"}],
    pccmMatrix: {
      "6A1A|Toán": "T", "6A1B|Toán": "T",
      "6A1A|Văn": "V", "6A2B|Văn": "V",
      "6A1A|Anh": "A",
    },
    tkb,
  };
}

function load(twoLocations){
  const DATA = makeData(twoLocations);
  const context = {
    DATA, console,
    DAYS: ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"],
    LABEL: {thu2: "Thứ 2", thu3: "Thứ 3", thu4: "Thứ 4", thu5: "Thứ 5", thu6: "Thứ 6", thu7: "Thứ 7"},
    SANG: 5, CHIEU: 5,
    localStorage: {getItem(){ return null; }, setItem(){}, removeItem(){}},
    sessionStorage: {getItem(){ return null; }, setItem(){}, removeItem(){}},
    cellMon: v => (v && typeof v === "object") ? v.mon : v,
    getMonShort: mon => String(mon),
    getLopCanonById: id => (DATA.lop.find(l => l.id === id) || {}).ten || id,
    getTeacherForClassMon: (cls, mon) => DATA.pccmMatrix[`${cls}|${mon}`] || "",
    getTeacherShort: code => code,
    getTeacherNameByCode: code => { const g = DATA.giaovien.find(x => x.magv === code); return g ? `${g.hodem} ${g.ten}` : ""; },
    getRoomForClassMon: (cls, mon) => (cls === "6A1A" && mon === "Anh") ? "Phòng Lab" : "",
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web", "vendor", "xlsx.min.js"), "utf8"), context);
  vm.runInContext([extract("tkbLocationList"), extract("tkbEntryLocation")].join("\n"), context);
  vm.runInContext(fs.readFileSync(EXPORT_PATH, "utf8"), context, {filename: EXPORT_PATH});
  return {api: context.window.__tkbExcelLocationInternals, XLSX: context.XLSX, DATA};
}

function styleAt(ws, XLSX, r, c){
  return ws[XLSX.utils.encode_cell({r, c})]?.s || {};
}
function fillOf(st){ return st?.fill?.fgColor?.rgb; }
function leftOf(st){ return st?.border?.left; }

test("trường 2 địa điểm: payload GV có màu theo địa điểm của từng ô (như vạch màu trên web)", () => {
  const {api} = load(true);
  assert.deepEqual(Array.from(api.exportLocations()), ["Địa điểm 1", "Địa điểm 2"]);
  const p = api.teacherTemplate1Payload({code: "T"});
  assert.equal(p.morningLoc[2][0], 0, "T2 sáng tiết 3 ở 6A1A -> Địa điểm 1");
  assert.equal(p.morningLoc[0][1], 1, "T3 sáng tiết 1 ở 6A1B -> Địa điểm 2");
  assert.equal(p.morningLoc[0][0], -1, "ô trống không tô");
});

test("ô có lớp ở 2 địa điểm khác nhau (trùng lịch) không tô; phòng thuộc địa điểm khác thì theo phòng", () => {
  const {api} = load(true);
  const v = api.teacherSchedulePayload({code: "V"});
  assert.equal(v.morningLoc[0][2], -1);
  const a = api.schoolTeacherSchedulePayload({code: "A"});
  assert.equal(a.afternoonLoc[1][3], 1, "6A1A học Phòng Lab (Địa điểm 2) -> màu Địa điểm 2");
});

test("Excel mẫu 1 GV: ô có tiết tô nền nhạt + cạnh trái đậm đúng màu web, có chú thích địa điểm", () => {
  const {api, XLSX} = load(true);
  const {wb} = api.buildTeacher1Workbook([api.teacherTemplate1Payload({code: "T"})]);
  const ws = wb.Sheets[wb.SheetNames[0]];
  // thẻ đầu: top=0, left=0; bảng tiết sáng ở hàng 8.., cột ngày ở 2..
  const blue = styleAt(ws, XLSX, 8 + 2, 2 + 0);
  assert.equal(fillOf(blue), BLUE.fill);
  assert.equal(leftOf(blue)?.style, "thick");
  assert.equal(leftOf(blue)?.color?.rgb, BLUE.edge);
  const orange = styleAt(ws, XLSX, 8 + 0, 2 + 1);
  assert.equal(fillOf(orange), ORANGE.fill);
  assert.equal(leftOf(orange)?.color?.rgb, ORANGE.edge);
  const empty = styleAt(ws, XLSX, 8 + 0, 2 + 0);
  assert.equal(fillOf(empty), "FFFFFFFF", "ô trống giữ nền trắng");
  assert.equal(ws[XLSX.utils.encode_cell({r: 6, c: 2})]?.v, "Địa điểm 1");
  assert.equal(fillOf(styleAt(ws, XLSX, 6, 2)), BLUE.fill);
  assert.equal(ws[XLSX.utils.encode_cell({r: 6, c: 5})]?.v, "Địa điểm 2");
  assert.equal(fillOf(styleAt(ws, XLSX, 6, 5)), ORANGE.fill);
});

test("Excel mẫu 2 GV: tô màu ô tiết + chú thích ở dòng trống trên bảng", () => {
  const {api, XLSX} = load(true);
  const {wb} = api.buildWorkbook([api.teacherSchedulePayload({code: "T"})]);
  const ws = wb.Sheets[wb.SheetNames[0]];
  assert.equal(fillOf(styleAt(ws, XLSX, 7 + 2, 3 + 0)), BLUE.fill);
  assert.equal(fillOf(styleAt(ws, XLSX, 7 + 0, 3 + 1)), ORANGE.fill);
  assert.equal(ws[XLSX.utils.encode_cell({r: 5, c: 3})]?.v, "Địa điểm 1");
});

test("TKB tổng theo lớp: tiêu đề lớp + ô tiết theo địa điểm của lớp, chú thích ở dòng tiêu đề", () => {
  const {api, XLSX, DATA} = load(true);
  const payloads = DATA.lop.map(l => api.schoolClassSchedulePayload(l));
  const {wb} = api.buildSchoolClassWorkbook(payloads);
  const ws = wb.Sheets[wb.SheetNames[0]];
  assert.equal(fillOf(styleAt(ws, XLSX, 1, 3)), BLUE.fill, "tiêu đề 6A1A");
  assert.equal(fillOf(styleAt(ws, XLSX, 1, 4)), ORANGE.fill, "tiêu đề 6A1B");
  // T2 (ngày 0) sáng tiết 3 của 6A1A: hàng 2 + 0*10 + 2, cột 3
  assert.equal(fillOf(styleAt(ws, XLSX, 2 + 2, 3)), BLUE.fill);
  // T3 (ngày 1) sáng tiết 1 của 6A1B: hàng 2 + 10 + 0, cột 4
  assert.equal(fillOf(styleAt(ws, XLSX, 2 + 10, 4)), ORANGE.fill);
  assert.equal(ws[XLSX.utils.encode_cell({r: 0, c: 17})]?.v, "Địa điểm 1");
  assert.equal(ws[XLSX.utils.encode_cell({r: 0, c: 18})]?.v, "Địa điểm 2");
});

test("trường 1 địa điểm: không tô màu, không chú thích (file như cũ)", () => {
  const {api, XLSX} = load(false);
  assert.equal(api.exportLocations(), null);
  const p = api.teacherTemplate1Payload({code: "T"});
  const {wb} = api.buildTeacher1Workbook([p]);
  const ws = wb.Sheets[wb.SheetNames[0]];
  assert.equal(fillOf(styleAt(ws, XLSX, 8 + 2, 2)), "FFFFFFFF");
  assert.equal(leftOf(styleAt(ws, XLSX, 8 + 2, 2))?.style, "thin");
  assert.equal(ws[XLSX.utils.encode_cell({r: 6, c: 2})], undefined);
});

test("file .xlsx ghi ra thật sự chứa màu nền và cạnh trái đậm", () => {
  const {api, XLSX} = load(true);
  const {wb} = api.buildTeacher1Workbook([api.teacherTemplate1Payload({code: "T"})]);
  const buf = XLSX.write(wb, {bookType: "xlsx", type: "buffer", cellStyles: true});
  const cfb = XLSX.CFB.read(buf, {type: "buffer"});
  const entry = XLSX.CFB.find(cfb, "xl/styles.xml") || XLSX.CFB.find(cfb, "/xl/styles.xml");
  assert.ok(entry, "có xl/styles.xml");
  const xml = Buffer.from(entry.content).toString("utf8");
  assert.match(xml, /FFBAE0FF/);
  assert.match(xml, /FFFFE7BA/);
  assert.match(xml, /<left style="thick"><color rgb="FF1677FF"\/><\/left>/);
});
