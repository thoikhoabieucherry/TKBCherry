"use strict";

// 10/10/2026 (chủ dự án, THCS Tân Phú Trung — 3 phòng Tin học): "thêm 1 mục xuất phòng ở phần In TKB
// thể hiện từng phòng". Mục "TKB phòng" xuất một file Excel, mỗi phòng một bảng Thứ x Tiết ghi
// "Lớp - Môn - GV". Phòng lấy từ phòng bộ môn dùng chung (DATA.tkbSubjectRooms, chia như vạch màu
// cạnh phải trên web) và phòng gắn theo Lớp|Môn (getRoomForClassMon). Tiết hết phòng không bị giấu.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const EXPORT_PATH = path.join(ROOT, "web", "pages", "tkb-student-excel-export.js");
const PHANMON_SOURCE = fs.readFileSync(path.join(ROOT, "web", "pages", "phanmon.js"), "utf8");
const MENU_SOURCE = fs.readFileSync(path.join(ROOT, "web", "pages", "tkb-constraints-menu.js"), "utf8");

function slice(startMarker, endMarker){
  const a = PHANMON_SOURCE.indexOf(startMarker);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = PHANMON_SOURCE.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return PHANMON_SOURCE.slice(a, b);
}

const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const PINK = {edge: "FFEB2F96", fill: "FFFFD6E7"};
const BROWN = {edge: "FF5B3A29", fill: "FFE8D9CF"};
const RED = {edge: "FFF5222D", fill: "FFFFCCC7"};

function grid(){
  const g = {};
  DAYS.forEach(d => { g[d] = {sang: ["", "", "", "", ""], chieu: ["OFF", "OFF", "OFF", "OFF", "OFF"]}; });
  return g;
}

function school(opts = {}){
  const data = {
    lop: [
      {id: "L1", ten: "9A1", diadiem: "Địa điểm 1"}, {id: "L2", ten: "9A2", diadiem: "Địa điểm 1"},
      {id: "L3", ten: "9A3", diadiem: "Địa điểm 1"}, {id: "L4", ten: "6A12", diadiem: "Địa điểm 2"},
      {id: "L5", ten: "6A13", diadiem: "Địa điểm 2"}
    ],
    phong: opts.assigned ? [{id: "P1", ten: "Phòng Lab", diadiem: "Địa điểm 1"}] : [],
    giaovien: [],
    monhoc: [{ma: "Tin", ten: "Tin học"}, {ma: "THQT", ten: "Tin học quốc tế"}, {ma: "Lý", ten: "Vật lí"}, {ma: "Toán", ten: "Toán"}],
    pccmMatrix: {
      "9A1|Tin": "Ti.Tập", "9A2|Tin": "Ti.Hào", "9A3|Tin": "Ti.Dương", "6A12|Tin": "Ti.Ân",
      "6A12|THQT": "Ti.Hào", "6A13|THQT": "Ti.Hào",
      "9A1|Lý": "L.An", "9A2|Lý": "L.Bình", "9A1|Toán": "T.An"
    },
    tkb: {L1: grid(), L2: grid(), L3: grid(), L4: grid(), L5: grid()}
  };
  if(opts.subjectRooms !== false){
    data.tkbSubjectRooms = [{
      name: "Phòng Tin học",
      subjects: ["Tin", "Tin học", "THQT"],
      rooms: [
        {name: "Phòng 1", diadiem: "Địa điểm 1"},
        {name: "Phòng 2", diadiem: "Địa điểm 1"},
        {name: "Phòng 3", diadiem: "Địa điểm 2"}
      ],
      teacherRoom: {"Ti.Ân": "Phòng 3"}
    }];
  }
  // T2 sáng t1: hai lớp Địa điểm 1 -> Phòng 1 + Phòng 2; t3: ba lớp Địa điểm 1 -> một lớp hết phòng.
  data.tkb.L1.thu2.sang[0] = "Tin"; data.tkb.L2.thu2.sang[0] = "Tin";
  data.tkb.L1.thu2.sang[2] = "Tin"; data.tkb.L2.thu2.sang[2] = "Tin"; data.tkb.L3.thu2.sang[2] = "Tin";
  // T3 sáng t1: thầy Ân (phòng riêng); t2: tiết học chung 6A12 + 6A13 cùng thầy Hào.
  data.tkb.L4.thu3.sang[0] = {mon: "Tin", fixed: true};
  data.tkb.L4.thu3.sang[1] = "THQT"; data.tkb.L5.thu3.sang[1] = "THQT";
  // T4 sáng t1: hai lớp cùng vào Phòng Lab (phòng gắn theo Lớp|Môn) -> trùng phòng; t2: môn không có phòng.
  data.tkb.L1.thu4.sang[0] = "Lý"; data.tkb.L2.thu4.sang[0] = "Lý";
  data.tkb.L1.thu4.sang[1] = "Toán";
  return data;
}

function load(opts = {}){
  const DATA = school(opts);
  const alerts = [];
  const context = {
    DATA, console, DAYS, Blob, TextEncoder, TextDecoder, setTimeout, clearTimeout, setImmediate,
    LABEL: {thu2: "Thứ 2", thu3: "Thứ 3", thu4: "Thứ 4", thu5: "Thứ 5", thu6: "Thứ 6", thu7: "Thứ 7"},
    SANG: 5, CHIEU: 5,
    alert: msg => alerts.push(String(msg)),
    localStorage: {getItem(){ return null; }, setItem(){}, removeItem(){}},
    sessionStorage: {getItem(){ return null; }, setItem(){}, removeItem(){}},
    escapeHtml: s => String(s),
    cellMon: v => (v && typeof v === "object") ? v.mon : v,
    cellLegacyTeacher: () => "",
    findMonHoc: mon => DATA.monhoc.find(m => m.ma === mon || m.ten === mon) || null,
    getMonShort: mon => { const m = DATA.monhoc.find(x => x.ma === mon || x.ten === mon); return m ? m.ma : String(mon); },
    getLopCanonById: id => (DATA.lop.find(l => l.id === id) || {}).ten || id,
    getTeacherForClassMon: (cls, mon) => DATA.pccmMatrix[`${cls}|${mon}`] || "",
    getTeacherShort: code => code,
    getTeacherNameByCode: () => "",
    getRoomForClassMon: (cls, mon) => (opts.assigned && mon === "Lý") ? "Phòng Lab" : "",
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web", "vendor", "xlsx.min.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web", "vendor", "jszip.min.js"), "utf8"), context);
  vm.runInContext(slice("function tkbLocationList(){", "function cellHTMLTeacher("), context);
  vm.runInContext(fs.readFileSync(EXPORT_PATH, "utf8"), context, {filename: EXPORT_PATH});
  return {api: context.window.__tkbExcelRoomInternals, context, XLSX: context.XLSX, DATA, alerts};
}

function cellAt(ws, XLSX, r, c){ return ws[XLSX.utils.encode_cell({r, c})] || {}; }
function fillOf(cell){ return cell?.s?.fill?.fgColor?.rgb; }
const DAY = d => DAYS.indexOf(d);

test("mỗi phòng một bảng: phòng bộ môn theo thứ tự khai báo, rồi bảng tiết chưa có phòng, rồi phòng gắn theo Lớp|Môn", () => {
  const {api} = load({assigned: true});
  const rooms = api.allRoomSchedulePayloads();
  assert.deepEqual(Array.from(rooms, r => [r.roomName, r.groupName, r.location, r.colorIndex, r.missing]), [
    ["Phòng 1", "Phòng Tin học", "Địa điểm 1", 0, false],
    ["Phòng 2", "Phòng Tin học", "Địa điểm 1", 1, false],
    ["Phòng 3", "Phòng Tin học", "Địa điểm 2", 2, false],
    ["Chưa có phòng", "Phòng Tin học", "", -1, true],
    ["Phòng Lab", "", "Địa điểm 1", -1, false],
  ]);
  assert.deepEqual(Array.from(rooms[0].dayLabels), ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"]);
});

test("ô ghi Lớp - Môn - GV đúng phòng đã chia (như vạch màu trên web); GV có phòng riêng vào đúng phòng đó", () => {
  const {api} = load();
  const [p1, p2, p3] = api.allRoomSchedulePayloads();
  const t2s1 = [p1.morning[0][DAY("thu2")], p2.morning[0][DAY("thu2")]].sort();
  assert.deepEqual(t2s1, ["9A1 - Tin - Ti.Tập", "9A2 - Tin - Ti.Hào"]);
  assert.equal(p3.morning[0][DAY("thu2")], "", "lớp Địa điểm 1 buổi chính không vào phòng Địa điểm 2");
  assert.equal(p3.morning[0][DAY("thu3")], "6A12 - Tin - Ti.Ân");
  assert.equal(p1.afternoon[0][DAY("thu2")], "", "ô nghỉ để trống");
  assert.equal(p1.periodCount + p2.periodCount, 4, "T2 tiết 1 + tiết 3, mỗi phòng một lớp");
  assert.equal(p3.periodCount, 2);
});

test("tiết học chung (nhiều lớp cùng GV) gộp một mục; mục dài tách danh sách lớp và Môn - GV thành hai dòng", () => {
  const {api} = load();
  const p3 = api.allRoomSchedulePayloads()[2];
  assert.equal(p3.morning[1][DAY("thu3")], "6A12, 6A13\nTHQT - Ti.Hào");
  assert.equal(p3.morningClash[1][DAY("thu3")], false, "cùng một GV thì không phải trùng phòng");
});

test("tiết hết phòng nằm ở bảng riêng của nhóm phòng, không bị giấu", () => {
  const {api} = load();
  const rooms = api.allRoomSchedulePayloads();
  assert.equal(rooms.length, 4);
  const missing = rooms[3];
  assert.equal(missing.missing, true);
  assert.equal(missing.periodCount, 1);
  const seated = [rooms[0].morning[2][0], rooms[1].morning[2][0]];
  const all = ["9A1 - Tin - Ti.Tập", "9A2 - Tin - Ti.Hào", "9A3 - Tin - Ti.Dương"];
  assert.deepEqual(seated.concat(missing.morning[2][0]).sort(), all, "ba lớp: hai lớp có phòng, một lớp chưa có");
});

test("phòng gắn theo Lớp|Môn: hai GV cùng giờ một phòng = trùng phòng, mỗi mục một dòng", () => {
  const {api} = load({assigned: true});
  const lab = api.allRoomSchedulePayloads().find(r => r.roomName === "Phòng Lab");
  assert.equal(lab.morning[0][DAY("thu4")], "9A1 - Lý - L.An\n9A2 - Lý - L.Bình");
  assert.equal(lab.morningClash[0][DAY("thu4")], true);
  assert.equal(lab.periodCount, 1);
  assert.equal(lab.morning[1][DAY("thu4")], "", "môn không có phòng không xuất hiện");
});

test("trường chưa khai phòng: báo rõ, không xuất file rỗng", async () => {
  const {api, context, alerts} = load({subjectRooms: false});
  assert.throws(() => api.allRoomSchedulePayloads(), /chưa khai phòng/);
  const result = await context.window.exportRoomTKBExcel();
  assert.equal(result, null);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /chưa khai phòng/);
});

test("trang Excel: tiêu đề, tên phòng tô màu như web, ô có tiết nền nhạt, ô dài xuống dòng và hàng cao lên", () => {
  const {api, XLSX} = load();
  const payloads = api.allRoomSchedulePayloads();
  const built = api.buildRoomWorkbook(payloads);
  const ws = built.wb.Sheets[built.wb.SheetNames[0]];
  assert.equal(built.wb.SheetNames[0], "PHONG");
  assert.equal(cellAt(ws, XLSX, 1, 0).v, "THỜI KHÓA BIỂU THEO PHÒNG");
  // Trang đầu: 4 hàng tiêu đề, mỗi bảng phòng 13 hàng (tên, tiêu đề cột, 5 sáng, 5 chiều, dòng cách).
  const name1 = cellAt(ws, XLSX, 4, 0);
  assert.match(name1.v, /^Phòng 1 {2}· {2}Phòng Tin học {2}· {2}Địa điểm 1 {2}· {2}\d+ tiết$/);
  assert.equal(fillOf(name1), PINK.fill);
  assert.equal(name1.s.border.left.style, "thick");
  assert.equal(name1.s.border.left.color.rgb, PINK.edge);
  assert.deepEqual([0, 1, 2, 7].map(c => cellAt(ws, XLSX, 5, c).v), ["Buổi", "Tiết", "Thứ 2", "Thứ 7"]);
  assert.equal(cellAt(ws, XLSX, 6, 0).v, "Sáng");
  assert.equal(cellAt(ws, XLSX, 11, 0).v, "Chiều");
  assert.equal(cellAt(ws, XLSX, 6, 1).v, 1);
  const lesson = cellAt(ws, XLSX, 6, 2);
  assert.match(lesson.v, /^9A[12] - Tin - Ti\.(Tập|Hào)$/);
  assert.equal(fillOf(lesson), PINK.fill);
  assert.equal(fillOf(cellAt(ws, XLSX, 7, 2)), "FFFFFFFF", "ô trống nền trắng");
  // Phòng 3 là bảng thứ ba: hàng tên = 4 + 2*13.
  const top3 = 4 + 2 * 13;
  assert.equal(fillOf(cellAt(ws, XLSX, top3, 0)), BROWN.fill);
  const joint = cellAt(ws, XLSX, top3 + 2 + 1, 2 + DAY("thu3"));
  assert.equal(joint.v, "6A12, 6A13\nTHQT - Ti.Hào");
  assert.equal(joint.s.alignment.wrapText, true);
  assert.ok(ws["!rows"][top3 + 2 + 1].hpt >= 24, "hàng có ô hai dòng phải cao lên");
  assert.equal(ws["!rows"][top3 + 2].hpt, 13.5, "hàng một dòng giữ chiều cao thường");
  // Bảng "chưa có phòng": tên đỏ.
  const topMissing = 4 + 3 * 13;
  assert.match(cellAt(ws, XLSX, topMissing, 0).v, /^Phòng Tin học: tiết chưa có phòng/);
  assert.equal(fillOf(cellAt(ws, XLSX, topMissing, 0)), RED.fill);
  assert.equal(built.pageCount, 1);
  assert.deepEqual(Array.from(built.print.rowBreaks), []);
});

test("quá 4 phòng thì sang trang: trang sau có lại tiêu đề, ô trùng phòng tô đỏ", () => {
  const {api, XLSX} = load({assigned: true});
  const payloads = api.allRoomSchedulePayloads();
  assert.equal(payloads.length, 5);
  const built = api.buildRoomWorkbook(payloads);
  const ws = built.wb.Sheets[built.wb.SheetNames[0]];
  const pageTwo = 4 + 4 * 13;
  assert.deepEqual(Array.from(built.print.rowBreaks), [pageTwo]);
  assert.equal(built.pageCount, 2);
  assert.equal(cellAt(ws, XLSX, pageTwo + 1, 0).v, "THỜI KHÓA BIỂU THEO PHÒNG");
  assert.match(cellAt(ws, XLSX, pageTwo + 4, 0).v, /^Phòng Lab {2}· {2}Địa điểm 1 {2}· {2}1 tiết$/);
  const clash = cellAt(ws, XLSX, pageTwo + 4 + 2, 2 + DAY("thu4"));
  assert.equal(clash.v, "9A1 - Lý - L.An\n9A2 - Lý - L.Bình");
  assert.equal(fillOf(clash), RED.fill);
});

test("file .xlsx thật: ngắt trang đúng hàng, canh giữa ngang, ô một dòng có co chữ cho vừa", async () => {
  const {api, context} = load({assigned: true});
  const blob = await api.buildXlsxBlob(api.allRoomSchedulePayloads(), {template: "rooms"});
  context.__bytes = await blob.arrayBuffer();
  const parts = await vm.runInContext(`(async () => {
    const zip = await JSZip.loadAsync(new Uint8Array(__bytes));
    return JSON.stringify({
      sheet: await zip.file("xl/worksheets/sheet1.xml").async("string"),
      styles: await zip.file("xl/styles.xml").async("string"),
      strings: await zip.file("xl/sharedStrings.xml").async("string")
    });
  })()`, context);
  const {sheet, styles, strings} = JSON.parse(parts);
  assert.match(sheet, /<rowBreaks count="1" manualBreakCount="1"><brk id="56" max="16383" man="1"\/><\/rowBreaks>/);
  assert.match(sheet, /<printOptions horizontalCentered="1"\/>/);
  assert.doesNotMatch(sheet, /verticalCentered/);
  assert.match(sheet, /<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"\/>/);
  assert.match(styles, /<alignment horizontal="center" vertical="center" shrinkToFit="1"\/>/);
  assert.doesNotMatch(styles, /wrapText="[^"]*"[^>]*shrinkToFit|shrinkToFit="1"[^>]*wrapText/, "ô xuống dòng không kèm co chữ");
  assert.match(strings, /6A12, 6A13\nTHQT - Ti\.Hào/);
});

test("các mẫu Excel khác không đổi: vẫn canh giữa cả hai chiều, không thêm co chữ", async () => {
  const {context} = load();
  const loc = context.window.__tkbExcelLocationInternals;
  const blob = await context.window.__tkbExcelRoomInternals.buildXlsxBlob([loc.teacherTemplate1Payload({code: "Ti.Tập"})], {template: "teacher1"});
  context.__bytes = await blob.arrayBuffer();
  const parts = await vm.runInContext(`(async () => {
    const zip = await JSZip.loadAsync(new Uint8Array(__bytes));
    return JSON.stringify({
      sheet: await zip.file("xl/worksheets/sheet1.xml").async("string"),
      styles: await zip.file("xl/styles.xml").async("string")
    });
  })()`, context);
  const {sheet, styles} = JSON.parse(parts);
  assert.match(sheet, /<printOptions horizontalCentered="1" verticalCentered="1"\/>/);
  assert.doesNotMatch(sheet, /<rowBreaks/);
  assert.doesNotMatch(styles, /shrinkToFit/);
});

test("menu In TKB có mục TKB phòng (trước Xuất CSDL ngành) và trang Sắp xếp gọi đúng hàm xuất", () => {
  const start = MENU_SOURCE.indexOf("function printRows()");
  const end = MENU_SOURCE.indexOf("function statisticsRows()", start);
  const rows = MENU_SOURCE.slice(start, end);
  const roomIndex = rows.indexOf('<button type="button" data-rb-print="rooms">TKB phòng</button>');
  assert.ok(roomIndex > rows.indexOf('data-rb-print="teacher-template-2"'), "nằm sau TKB giáo viên");
  assert.ok(roomIndex < rows.indexOf('data-rb-print="school-class"'), "nằm trước TKB toàn trường");
  assert.ok(roomIndex < rows.indexOf('data-rb-print="industry-database"'));
  assert.match(PHANMON_SOURCE, /if\(key === "rooms"\) return runPrintExport\("exportRoomTKBExcel", "xuất Excel TKB phòng"\);/);
  assert.match(fs.readFileSync(EXPORT_PATH, "utf8"), /window\.exportRoomTKBExcel = async function\(\)/);
});
