"use strict";

// 30/09 (chủ dự án, THCS An Phú — GV bản ngữ TABN): tiết chung (Dạy ghép) ghép theo khối
// -> ô TKB giáo viên ghi KHỐI trước tên ("Khối 6 - T.Anh BN"), danh sách lớp vẫn ở tooltip;
// bấm ô tiết chung ở bảng TKB GV phụ -> nhảy tới lớp đầu của tiết chung (trước đây coi là
// trùng lịch nên không nhảy).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function slice(startMarker, endMarker, from = 0){
  const a = SRC.indexOf(startMarker, from);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return SRC.slice(a, b);
}

const DAYS = ["thu2", "thu3"];
function blank(){ return Array.from({length:5}, () => ""); }
function grid(){ const g = {}; DAYS.forEach(d => { g[d] = {sang: blank(), chieu: blank()}; }); return g; }

function school(withKhoi = true){
  const k = (v) => (withKhoi ? v : undefined);
  return {
    lop:[
      {id:"L1", ten:"6A1", khoi:k("Khối 6")}, {id:"L2", ten:"6A2", khoi:k("Khối 6")},
      {id:"L5", ten:"7B1", khoi:k("Khối 7")}, {id:"L9", ten:"9B1", khoi:k("Khối 9")}
    ],
    monhoc:[{id:"BN", ma:"T.Anh BN", ten:"Tiếng Anh bản ngữ"}],
    dayGhep:[
      {id:"DG1", lop:["6A1", "6A2"], mon:["T.Anh BN"], gv:["TA.P", "TABN"], sotiet:"1", gioihan:"1", viettat:"T.Anh BN", ten:"T.Anh BN (ghép)"},
      {id:"DG2", lop:["6A1", "7B1"], mon:["T.Anh BN"], gv:["TA.H", "TABN"], sotiet:"1", gioihan:"1", viettat:"CLB", ten:"CLB (ghép)"}
    ],
    pccmMatrix:{"6A1|T.Anh BN (ghép)":"TA.P, TABN", "6A2|T.Anh BN (ghép)":"TA.P, TABN",
      "6A1|CLB (ghép)":"TA.H, TABN", "7B1|CLB (ghép)":"TA.H, TABN", "9B1|T.Anh BN":"TA.T"},
    tkb:{L1:grid(), L2:grid(), L5:grid(), L9:grid()},
    tkbConstraints:{}
  };
}

function load(data){
  const window = {};
  const context = {
    window, DATA:data, DAYS, SANG:5, CHIEU:5, console, JSON, Object, Array, Map, Set, String, Number,
    cellMon(v){ if(v === "OFF" || v == null || v === "") return ""; return typeof v === "string" ? v : String(v.mon || ""); },
    isFixed(v){ return !!(v && typeof v === "object" && v.fixed); },
    getLopCanonById(id){ const l = data.lop.find(x => String(x.id) === String(id)); return l ? l.ten : String(id); },
    getTeacherForClassMon(lop, mon){ return data.pccmMatrix[`${lop}|${mon}`] || ""; },
    teacherValueFromRaw(raw){ return String(raw || "").split(",").map(x => x.trim()).filter(Boolean).join(", "); },
    teacherValuesIntersect(a, b){
      const sp = x => String(x || "").split(",").map(y => y.trim().toLowerCase()).filter(Boolean);
      const bb = new Set(sp(b)); return sp(a).some(x => bb.has(x));
    },
    isTeacherFixedOff(){ return false; },
    getMonShort(m){ return m; },
    tkbMonLabel(_c, m){ return m; },
    isPlannerBusySolving(){ return false; }
  };
  window.window = window;
  const src = [
    slice("function tkbGhepRowFor(", "function tkbMonLabel("),
    slice("// ======================= TIẾT HỌC CHUNG NHIỀU LỚP (Dạy ghép)", "// jointMon: môn đang đặt vào lớp ignoreLopId"),
    slice("function tkbTeacherCellView(", "\nfunction ")
  ].join("\n");
  vm.runInNewContext(src, context, {filename:PHANMON_PATH});
  return context;
}

test("ô tiết chung trong TKB GV mang nhãn khối; danh sách lớp vẫn ở tooltip, classDisplay rỗng (xuất Excel không đổi)", () => {
  const c = load(school());
  const v = c.tkbTeacherCellView([
    {classId:"L1", classDisplay:"6A1", mon:"T.Anh BN (ghép)"},
    {classId:"L2", classDisplay:"6A2", mon:"T.Anh BN (ghép)"}
  ]);
  assert.equal(v.conflict, false);
  assert.equal(v.entries.length, 1);
  assert.equal(v.entries[0].jointGradeLabel, "Khối 6");
  assert.equal(v.entries[0].classDisplay, "");
  assert.equal(v.entries[0].jointClassLabel, "6A1, 6A2");
});

test("tiết chung nhiều khối -> 'Khối 6, 7'; lớp không có khối -> nhãn rỗng (giữ hành vi cũ)", () => {
  const c = load(school());
  const v = c.tkbTeacherCellView([
    {classId:"L1", classDisplay:"6A1", mon:"CLB (ghép)"},
    {classId:"L5", classDisplay:"7B1", mon:"CLB (ghép)"}
  ]);
  assert.equal(v.entries[0].jointGradeLabel, "Khối 6, 7");
  assert.equal(c.tkbJointGradeLabel([{classId:"L1"}, {classId:"L5"}, {classId:"L9"}]), "Khối 6, 7, 9");

  const bare = load(school(false));
  const w = bare.tkbTeacherCellView([
    {classId:"L1", classDisplay:"6A1", mon:"T.Anh BN (ghép)"},
    {classId:"L2", classDisplay:"6A2", mon:"T.Anh BN (ghép)"}
  ]);
  assert.equal(w.entries[0].jointGradeLabel, "");
});

test("nhãn khối dạng 'K6'/'K7' ghép gọn thành 'K6, 7'; khối không số -> nối nguyên văn", () => {
  const data = school();
  data.lop[0].khoi = "K6"; data.lop[2].khoi = "K7";
  const c = load(data);
  assert.equal(c.tkbJointGradeLabel([{classId:"L1"}, {classId:"L5"}]), "K6, 7");
  data.lop[0].khoi = "Khối Sáu"; data.lop[2].khoi = "Khối Bảy";
  assert.equal(c.tkbJointGradeLabel([{classId:"L1"}, {classId:"L5"}]), "Khối Sáu, Khối Bảy");
});

test("ô thường một lớp và ô trùng lịch thật không có nhãn khối", () => {
  const c = load(school());
  const one = c.tkbTeacherCellView([{classId:"L9", classDisplay:"9B1", mon:"T.Anh BN"}]);
  assert.equal(one.entries[0].classDisplay, "9B1");
  assert.equal(one.entries[0].jointGradeLabel, undefined);
  const clash = c.tkbTeacherCellView([{classId:"L1", classDisplay:"6A1", mon:"T.Anh BN (ghép)"}, {classId:"L9", classDisplay:"9B1", mon:"T.Anh BN"}]);
  assert.equal(clash.conflict, true);
  assert.equal(clash.entries.length, 2);
});

test("bấm ô TKB GV phụ: một lớp -> lớp đó; tiết chung gộp -> lớp đầu; trùng lịch -> không nhảy", () => {
  const c = load(school());
  assert.equal(c.tkbSupportCellTargetClass(["L9"], "L9", false), "L9");
  assert.equal(c.tkbSupportCellTargetClass(["L1", "L2"], "L1", false), "L1");
  assert.equal(c.tkbSupportCellTargetClass([" L1 ", "L2"], " L1 ", false), "L1");
  assert.equal(c.tkbSupportCellTargetClass(["L1", "L9"], "", true), "");
  assert.equal(c.tkbSupportCellTargetClass(["L1", "L2"], "L1", true), "");
  assert.equal(c.tkbSupportCellTargetClass([], "L1", false), "");
});

test("mọi bộ vẽ ô TKB GV dùng nhãn khối; bảng GV phụ nhảy lớp qua tkbSupportCellTargetClass", () => {
  const renderers = SRC.split("mobileStackCellLineHTML(e.jointGradeLabel || e.classDisplay, monShort,").length - 1;
  assert.equal(renderers, 3, "cellHTMLTeacher, renderTKBTeacher (cập nhật tại chỗ), pvTeacherCellHTML");
  assert.equal(SRC.includes("mobileStackCellLineHTML(e.classDisplay, monShort,"), false);
  const nav = slice("function pvBindSupportNav(", "function pvPairDragInfo(");
  assert.ok(nav.includes("tkbSupportCellTargetClass(ids, td.dataset.classid"), "nhảy lớp dùng lớp đầu của tiết chung");
  assert.ok(!nav.includes("if(ids.length !== 1) return;"), "không còn bỏ qua ô nhiều lớp");
});
