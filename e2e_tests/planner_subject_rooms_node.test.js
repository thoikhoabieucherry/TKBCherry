"use strict";

// 09/10 (chủ dự án, THCS Tân Phú Trung — 3 phòng Tin học: Phòng 1 + 2 ở Địa điểm 1, Phòng 3 ở
// Địa điểm 2, thầy Ân luôn dạy Phòng 3, thầy Thuận trái buổi T2/T6 vẫn ở Địa điểm 1):
// ô TKB giáo viên có thêm vạch màu cạnh PHẢI theo phòng bộ môn (DATA.tkbSubjectRooms).
// Phòng không lưu theo từng tiết mà tự chia lại mỗi lần vẽ.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const CSS_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.css");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function slice(startMarker, endMarker){
  const a = SRC.indexOf(startMarker);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return SRC.slice(a, b);
}

const DAYS = ["thu2", "thu3"];
function grid(main){
  const g = {};
  DAYS.forEach(d => {
    g[d] = {
      sang: Array.from({length:5}, () => (main === "sang" ? "" : "OFF")),
      chieu: Array.from({length:5}, () => (main === "chieu" ? "" : "OFF"))
    };
  });
  return g;
}

const ROOMS = [{
  name: "Phòng Tin học",
  subjects: ["Tin", "THQT"],
  rooms: [
    {name: "Phòng 1", diadiem: "Địa điểm 1"},
    {name: "Phòng 2", diadiem: "Địa điểm 1"},
    {name: "Phòng 3", diadiem: "Địa điểm 2"}
  ],
  teacherRoom: {"Ti.Ân": "Phòng 3"},
  teacherLocation: [{teacher: "Ti.Thuận", days: ["thu2"], diadiem: "Địa điểm 1"}],
  offSessionPrefer: "Địa điểm 2"
}];

function school(withRooms = true){
  const data = {
    lop: [
      {id:"L1", ten:"9A1", diadiem:"Địa điểm 1"}, {id:"L2", ten:"9A2", diadiem:"Địa điểm 1"},
      {id:"L3", ten:"9A3", diadiem:"Địa điểm 1"}, {id:"L4", ten:"6A12", diadiem:"Địa điểm 2"},
      {id:"L5", ten:"7A1", diadiem:"Địa điểm 1"}, {id:"L6", ten:"9A4", diadiem:"Địa điểm 1"}
    ],
    phong: [],
    monhoc: [{ma:"Tin", ten:"Tin học"}, {ma:"THQT", ten:"Tin học quốc tế"}, {ma:"Toán", ten:"Toán"}],
    pccmMatrix: {
      "9A1|Tin":"Ti.Tập", "9A2|Tin":"Ti.Hào", "9A3|Tin":"Ti.Dương", "6A12|Tin":"Ti.Mai",
      "7A1|Tin":"Ti.Thuận", "7A1|THQT":"Ti.Thuận", "9A4|Tin":"Ti.Ân", "9A1|Toán":"T.An"
    },
    tkb: {L1:grid("sang"), L2:grid("sang"), L3:grid("sang"), L4:grid("sang"), L5:grid("chieu"), L6:grid("sang")}
  };
  if(withRooms) data.tkbSubjectRooms = JSON.parse(JSON.stringify(ROOMS));
  // thu2 sáng: t1 9A1 + 9A2; t2 9A1 (cùng GV, giữ phòng); t3 ba lớp Địa điểm 1 (thiếu phòng);
  //            t4 lớp Địa điểm 2 buổi chính; t5 thầy Thuận trái buổi (ngày T2 -> Địa điểm 1)
  data.tkb.L1.thu2.sang[0] = "Tin"; data.tkb.L2.thu2.sang[0] = "Tin học";
  data.tkb.L1.thu2.sang[1] = "Tin";
  data.tkb.L1.thu2.sang[2] = "Tin"; data.tkb.L2.thu2.sang[2] = "Tin"; data.tkb.L3.thu2.sang[2] = "Tin";
  data.tkb.L4.thu2.sang[3] = "Tin";
  data.tkb.L5.thu2.sang[4] = {mon:"Tin", fixed:true};
  // thu3 sáng: t1 thầy Ân (phòng riêng) + thầy Thuận trái buổi (không phải T2 -> ưu tiên Địa điểm 2 nhưng đã kín)
  //            t2 thầy Thuận trái buổi một mình -> Phòng 3; t3 môn không dùng phòng máy
  data.tkb.L6.thu3.sang[0] = "Tin"; data.tkb.L5.thu3.sang[0] = {mon:"THQT", fixed:true};
  data.tkb.L5.thu3.sang[1] = {mon:"THQT", fixed:true};
  data.tkb.L1.thu3.sang[2] = "Toán";
  return data;
}

function load(data){
  const timers = [];
  const context = {
    DATA: data, DAYS, console, JSON, Object, Array, Map, Set, String, Number, Math,
    setTimeout(fn){ timers.push(fn); return timers.length; },
    escapeHtml(s){ return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); },
    cellMon(v){ if(v === "OFF" || v == null || v === "") return ""; return typeof v === "string" ? v : String(v.mon || ""); },
    cellLegacyTeacher(){ return ""; },
    findMonHoc(mon){ const m = String(mon || "").trim(); return data.monhoc.find(x => x.ma === m || x.ten === m) || null; },
    getLopCanonById(id){ const l = data.lop.find(x => String(x.id) === String(id)); return l ? l.ten : String(id); },
    getTeacherForClassMon(lop, mon){
      const mh = context.findMonHoc(mon);
      return data.pccmMatrix[`${lop}|${mon}`] || (mh ? data.pccmMatrix[`${lop}|${mh.ma}`] : "") || "";
    }
  };
  vm.createContext(context);
  vm.runInContext(slice("function tkbLocationList(){", "function cellHTMLTeacher("), context);
  context.flush = () => { while(timers.length) timers.shift()(); };
  return context;
}

function entry(classId, thu, buoi, ti, mon = "Tin"){
  return {classId, classDisplay: classId, mon, room: "", fixed: false, thu, buoi, ti};
}

test("phòng bộ môn: lớp buổi chính lấy phòng cùng địa điểm, hai lớp cùng giờ khác phòng", () => {
  const ctx = load(school());
  const a = ctx.tkbLocationCellInfo([entry("L1", "thu2", "sang", 0)]);
  const b = ctx.tkbLocationCellInfo([entry("L2", "thu2", "sang", 0)]);
  assert.match(a.cls, /tkb-loc tkb-loc-1/);
  assert.match(a.cls, /tkb-room tkb-room-[12]\b/);
  assert.match(b.cls, /tkb-room tkb-room-[12]\b/);
  assert.notEqual(a.room, b.room);
  assert.deepEqual([a.room, b.room].sort(), ["Phòng 1", "Phòng 2"]);
  assert.equal(a.title, "Địa điểm 1");
  assert.equal(a.tip, `Địa điểm 1 · ${a.room}`);
});

test("phòng bộ môn: cùng GV dạy tiết liền nhau thì giữ nguyên phòng", () => {
  const ctx = load(school());
  const t1 = ctx.tkbLocationCellInfo([entry("L1", "thu2", "sang", 0)]);
  const t2 = ctx.tkbLocationCellInfo([entry("L1", "thu2", "sang", 1)]);
  assert.equal(t2.room, t1.room);
});

test("phòng bộ môn: quá số phòng của địa điểm -> đúng một ô báo thiếu phòng (vạch đỏ sọc)", () => {
  const ctx = load(school());
  const infos = ["L1", "L2", "L3"].map(id => ctx.tkbLocationCellInfo([entry(id, "thu2", "sang", 2)]));
  const bad = infos.filter(x => /tkb-room-x/.test(x.cls));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].room, "Phòng Tin học: thiếu phòng");
  assert.deepEqual(infos.filter(x => !/tkb-room-x/.test(x.cls)).map(x => x.room).sort(), ["Phòng 1", "Phòng 2"]);
});

test("phòng bộ môn: lớp Địa điểm 2 dùng Phòng 3; GV có phòng riêng luôn ở phòng đó và địa điểm theo phòng", () => {
  const ctx = load(school());
  const dd2 = ctx.tkbLocationCellInfo([entry("L4", "thu2", "sang", 3)]);
  assert.equal(dd2.room, "Phòng 3");
  assert.match(dd2.cls, /tkb-loc-2/);
  assert.match(dd2.cls, /tkb-room-3/);
  // thầy Ân dạy lớp 9A4 (Địa điểm 1) nhưng luôn ở Phòng 3 -> vạch địa điểm là Địa điểm 2
  const an = ctx.tkbLocationCellInfo([entry("L6", "thu3", "sang", 0)]);
  assert.equal(an.room, "Phòng 3");
  assert.equal(an.title, "Địa điểm 2");
  assert.match(an.cls, /tkb-loc-2/);
});

test("phòng bộ môn: tiết trái buổi lấy phòng còn trống, GV có địa điểm riêng theo ngày thì theo ngày đó", () => {
  const ctx = load(school());
  // T2: thầy Thuận trái buổi nhưng được khai ở Địa điểm 1
  const t2 = ctx.tkbLocationCellInfo([entry("L5", "thu2", "sang", 4)]);
  assert.equal(t2.title, "Địa điểm 1");
  assert.match(t2.room, /^Phòng [12]$/);
  // T3 tiết 1: Phòng 3 đã có thầy Ân -> trái buổi sang phòng Địa điểm 1; tiết 2 liền sau giữ phòng đó
  const t3a = ctx.tkbLocationCellInfo([entry("L5", "thu3", "sang", 0, "THQT")]);
  const t3b = ctx.tkbLocationCellInfo([entry("L5", "thu3", "sang", 1, "THQT")]);
  assert.match(t3a.room, /^Phòng [12]$/);
  assert.equal(t3b.room, t3a.room);
  // gỡ tiết của thầy Ân -> trái buổi ưu tiên Phòng 3 (offSessionPrefer)
  ctx.DATA.tkb.L6.thu3.sang[0] = "";
  ctx.flush();
  const free = ctx.tkbLocationCellInfo([entry("L5", "thu3", "sang", 0, "THQT")]);
  assert.equal(free.room, "Phòng 3");
  assert.equal(free.title, "Địa điểm 2");
});

test("phòng bộ môn: môn khác và trường không khai phòng bộ môn thì ô giữ nguyên như cũ", () => {
  const ctx = load(school());
  const toan = ctx.tkbLocationCellInfo([entry("L1", "thu3", "sang", 2, "Toán")]);
  assert.equal(toan.cls, "tkb-loc tkb-loc-1");
  assert.equal(toan.room, "");
  assert.equal(toan.tip, "Địa điểm 1");

  const plain = load(school(false));
  const tin = plain.tkbLocationCellInfo([entry("L1", "thu2", "sang", 0)]);
  assert.equal(tin.cls, "tkb-loc tkb-loc-1");
  assert.equal(tin.title, "Địa điểm 1");
  assert.equal(tin.room, "");
  // ô không mang vị trí (vd Excel) vẫn chạy như trước
  assert.equal(plain.tkbEntryLocation({classId: "L4"}), "Địa điểm 2");
  assert.equal(load(school()).tkbEntryLocation({classId: "L4"}), "Địa điểm 2");
});

test("phòng bộ môn: thuộc tính ô và CSS vạch cạnh phải", () => {
  const ctx = load(school());
  const info = ctx.tkbLocationCellInfo([entry("L4", "thu2", "sang", 3)]);
  const attrs = ctx.tkbLocationCellAttrs(info, true);
  assert.match(attrs, / data-location="Địa điểm 2"/);
  assert.match(attrs, / data-room="Phòng 3"/);
  assert.match(attrs, / title="Địa điểm 2 · Phòng 3"/);
  assert.doesNotMatch(ctx.tkbLocationCellAttrs(info, false), / title=/);
  assert.equal(ctx.tkbLocationCellAttrs({cls: "", title: "", room: "", tip: ""}, true), "");

  const css = fs.readFileSync(CSS_PATH, "utf8");
  assert.match(css, /\.table td\.tkb-room::after\{[^}]*right: 0;/);
  assert.match(css, /\.table td\.tkb-room-3\{/);
  assert.match(css, /\.table td\.tkb-room-x::after\{/);
  // ba chỗ vẽ ô TKB giáo viên đều đi qua tkbLocationCellInfo + mang vị trí ô
  assert.match(SRC, /arr\.forEach\(e => \{ e\.thu = thu; e\.buoi = buoi; e\.ti = ti; \}\)/);
  assert.ok((SRC.match(/tkbLocationCellAttrs\(locInfo/g) || []).length >= 2);
});
