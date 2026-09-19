"use strict";

// 29/08 chiều (chủ dự án): dòng Dạy ghép NHIỀU LỚP = MỘT TIẾT HỌC CHUNG — các lớp học
// cùng lúc ở hội trường, mọi GV của dòng cùng dạy. Test khoá khối "TIẾT HỌC CHUNG NHIỀU
// LỚP" trong pages/phanmon.js: đồng bộ ô giữa các lớp tại điểm chốt lưu, chặn/đẩy khi
// kéo, gộp ô TKB GV, miễn trùng GV trong cùng dòng, ghim tạm trước khi giải và bỏ ghim
// khi cờ bận tắt.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function same(a, b, msg){ assert.equal(JSON.stringify(a), JSON.stringify(b), msg); }

function slice(startMarker, endMarker, from = 0){
  const a = SRC.indexOf(startMarker, from);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return SRC.slice(a, b);
}

const DAYS = ["thu2", "thu3", "thu4"];
function blank(values = []){ return Array.from({length:5}, (_, i) => values[i] || ""); }
function grid(spec = {}){
  const g = {};
  DAYS.forEach(d => { g[d] = {sang: blank((spec[d] || {}).sang), chieu: blank((spec[d] || {}).chieu)}; });
  return g;
}

function school(){
  return {
    lop:[{id:"L1", ten:"6.1"}, {id:"L2", ten:"6.2"}, {id:"L3", ten:"6.3"}, {id:"L9", ten:"9.1"}],
    giaovien:[{magv:"GV.A", ten:"A"}, {magv:"GV.B", ten:"B"}, {magv:"GV.C", ten:"C"}],
    monhoc:[{id:"TOAN", ma:"TOAN", ten:"Toán"}],
    dayGhep:[
      {id:"DG1", lop:["6.1", "6.2", "6.3"], mon:["TOAN"], gv:["GV.A", "GV.B"], sotiet:"1", gioihan:"1", viettat:"CLB", ten:"CLB"},
      {id:"DG2", lop:["9.1"], mon:["TOAN"], gv:["GV.A"], sotiet:"1", gioihan:"1", viettat:"AI", ten:"AI"}
    ],
    pccmMatrix:{"6.1|CLB":"GV.A, GV.B", "6.2|CLB":"GV.A, GV.B", "6.3|CLB":"GV.A, GV.B", "9.1|AI":"GV.A",
      "6.1|TOAN":"GV.C", "6.2|TOAN":"GV.C", "6.3|TOAN":"GV.C", "9.1|TOAN":"GV.A"},
    tkb:{L1:grid(), L2:grid(), L3:grid(), L9:grid()},
    tkbConstraints:{}
  };
}

function load(data, extra = {}){
  const window = {};
  const context = {
    window, DATA:data, DAYS, SANG:5, CHIEU:5, console, setTimeout, clearTimeout, JSON, Object, Array, Map, Set, String, Number,
    busy:false,
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
    _setStatus(msg){ context.lastStatus = msg; },
    flashLopItemConflict(){},
    saveStoreDeferred(){ context.saved = (context.saved || 0) + 1; },
    renderCurrentView(){ context.rendered = (context.rendered || 0) + 1; },
    loadMonList(){},
    isPlannerBusySolving(){ return context.busy; },
    lastStatus:"", saved:0, rendered:0
  };
  Object.assign(context, extra);
  window.window = window;
  const src = [
    slice("function tkbGhepRowFor(", "function tkbMonLabel("),
    slice("// ======================= TIẾT HỌC CHUNG NHIỀU LỚP (Dạy ghép)", "// jointMon: môn đang đặt vào lớp ignoreLopId"),
    slice("function findTeacherConflictAtSlot(", "\nfunction "),
    slice("function tkbTeacherCellView(", "\nfunction ")
  ].join("\n");
  vm.runInNewContext(src, context, {filename:PHANMON_PATH});
  return context;
}

test("đặt tiết chung ở MỘT lớp -> đồng bộ sang các lớp còn lại của dòng; xóa ở lớp khác -> gỡ hết", () => {
  const data = school();
  const c = load(data);
  c.tkbJointTakeSnapshot();
  data.tkb.L1.thu2.sang[2] = "CLB";
  const r1 = c.tkbJointReconcile();
  assert.equal(r1.changed, true);
  assert.equal(r1.rows[0].truthId, "L1");
  same([data.tkb.L2.thu2.sang[2], data.tkb.L3.thu2.sang[2], data.tkb.L9.thu2.sang[2]], ["CLB", "CLB", ""], "lớp 9.1 không thuộc dòng");
  // lần lưu kế tiếp: ổn định, không đổi
  assert.equal(c.tkbJointReconcile().changed, false);

  data.tkb.L2.thu2.sang[2] = "";
  const r2 = c.tkbJointReconcile();
  assert.equal(r2.rows[0].truthId, "L2");
  same([data.tkb.L1.thu2.sang[2], data.tkb.L3.thu2.sang[2]], ["", ""]);
});

test("dời / khóa / bỏ khóa ở một lớp -> các lớp còn lại theo; đang giải thì không đụng", () => {
  const data = school();
  data.tkb.L1.thu2.sang[0] = "CLB"; data.tkb.L2.thu2.sang[0] = "CLB"; data.tkb.L3.thu2.sang[0] = "CLB";
  const c = load(data);
  c.tkbJointTakeSnapshot();
  // dời trong lớp 6.3: thứ 2 tiết 1 -> thứ 3 tiết 4
  data.tkb.L3.thu2.sang[0] = ""; data.tkb.L3.thu3.sang[3] = "CLB";
  c.tkbJointReconcile();
  same([data.tkb.L1.thu2.sang[0], data.tkb.L1.thu3.sang[3], data.tkb.L2.thu3.sang[3]], ["", "CLB", "CLB"]);
  // khóa ở 6.1
  data.tkb.L1.thu3.sang[3] = {mon:"CLB", fixed:true};
  c.tkbJointReconcile();
  same([data.tkb.L2.thu3.sang[3], data.tkb.L3.thu3.sang[3]], [{mon:"CLB", fixed:true}, {mon:"CLB", fixed:true}]);
  // bỏ khóa ở 6.2
  data.tkb.L2.thu3.sang[3] = "CLB";
  c.tkbJointReconcile();
  same([data.tkb.L1.thu3.sang[3], data.tkb.L3.thu3.sang[3]], ["CLB", "CLB"]);
  // đang giải: bỏ qua (không force)
  c.busy = true;
  data.tkb.L1.thu3.sang[3] = "";
  assert.equal(c.tkbJointReconcile().changed, false);
  assert.equal(data.tkb.L2.thu3.sang[3], "CLB");
  c.busy = false;
  assert.equal(c.tkbJointReconcile().changed, true);
  assert.equal(data.tkb.L2.thu3.sang[3], "");
});

test("lớp khác đang có tiết thường ở ô đó -> đưa về Chưa phân; ô nghỉ / ô cố định môn khác -> không đặt được, báo", () => {
  const data = school();
  data.tkb.L2.thu2.sang[1] = "TOAN";
  data.tkb.L3.thu2.sang[1] = "OFF";
  const c = load(data);
  c.tkbJointTakeSnapshot();
  data.tkb.L1.thu2.sang[1] = "CLB";
  const r = c.tkbJointReconcile();
  assert.equal(data.tkb.L2.thu2.sang[1], "CLB");
  same(r.displaced.map(d => [d.classId, d.mon]), [["L2", "TOAN"]]);
  assert.equal(data.tkb.L3.thu2.sang[1], "OFF");
  same(r.blocked.map(b => [b.classId, b.why]), [["L3", "ô nghỉ"]]);
  const msg = c.tkbJointReconcileMessage(r);
  assert.match(msg, /đồng bộ theo lớp 6\.1/);
  assert.match(msg, /Chưa phân: TOAN-6\.2/);
  assert.match(msg, /6\.3 \(ô nghỉ\)/);

  // kiểm trước khi kéo (validateDrop)
  data.tkb.L2.thu3.chieu[0] = {mon:"TOAN", fixed:true};
  data.tkb.L3.thu3.chieu[0] = "TOAN";
  const jb = c.tkbJointSiblingBlockers("L1", "CLB", "thu3", "chieu", 0);
  same(jb.blocked.map(b => b.classId), ["L2"]);
  same(jb.displace.map(d => [d.type, d.lopId, d.mon]), [["joint", "L3", "TOAN"]]);
  assert.equal(c.tkbJointSiblingBlockers("L1", "TOAN", "thu3", "chieu", 0), null, "môn thường không có nhóm");
  assert.equal(c.tkbJointSiblingBlockers("L9", "AI", "thu3", "chieu", 0), null, "dòng một lớp không phải tiết chung");
});

test("nhiều lớp cùng đổi (bộ giải / nạp lại): lấy trạng thái phổ biến nhất, hòa thì giữ trạng thái có tiết", () => {
  const data = school();
  const c = load(data);
  c.tkbJointTakeSnapshot();
  data.tkb.L1.thu2.sang[0] = "CLB"; data.tkb.L2.thu2.sang[0] = "CLB"; data.tkb.L3.thu4.chieu[1] = "CLB";
  c.tkbJointReconcile();
  same([data.tkb.L3.thu2.sang[0], data.tkb.L3.thu4.chieu[1]], ["CLB", ""], "2 lớp cùng ô thắng lớp lẻ");
  // hòa 1-1 (sau khi bỏ 6.3 khỏi dòng): lớp có tiết thắng lớp trống
  data.dayGhep[0].lop = ["6.1", "6.2"];
  c.tkbJointTakeSnapshot();
  data.tkb.L1.thu2.sang[0] = ""; data.tkb.L2.thu2.sang[0] = ""; data.tkb.L2.thu3.sang[2] = "CLB";
  data.tkb.L1.thu4.sang[0] = "CLB";
  // cả hai lớp đổi khác nhau -> mode hòa 1-1, đều 1 tiết -> lớp đầu (6.1) thắng
  c.tkbJointReconcile();
  same([data.tkb.L1.thu4.sang[0], data.tkb.L2.thu4.sang[0], data.tkb.L2.thu3.sang[2]], ["CLB", "CLB", ""]);
});

test("cặp ô cùng dòng ở hai lớp = cùng MỘT tiết: không trùng GV; tiết khác của GV cùng giờ vẫn trùng", () => {
  const data = school();
  data.tkb.L1.thu2.sang[0] = "CLB"; data.tkb.L2.thu2.sang[0] = "CLB";
  data.tkb.L9.thu2.sang[1] = "TOAN";   // GV.A dạy Toán 9.1 thứ 2 tiết 2
  const c = load(data);
  assert.equal(c.tkbIsJointGhepPair("CLB", "L1", "CLB", "L2"), true);
  assert.equal(c.tkbIsJointGhepPair("CLB", "L1", "CLB", "L1"), false);
  assert.equal(c.tkbIsJointGhepPair("CLB", "L1", "AI", "L9"), false);
  assert.equal(c.tkbIsJointGhepPair("TOAN", "L1", "TOAN", "L2"), false);
  // đặt CLB vào 6.3 thứ 2 tiết 1: GV.A/GV.B đang ở CLB 6.1/6.2 -> không trùng
  assert.equal(c.findTeacherConflictAtSlot("GV.A, GV.B", "thu2", "sang", 0, "L3", "CLB"), null);
  // đặt CLB vào 6.3 thứ 2 tiết 2: GV.A đang dạy Toán 9.1 -> trùng
  same(c.findTeacherConflictAtSlot("GV.A, GV.B", "thu2", "sang", 1, "L3", "CLB"), {lopId:"L9", mon:"TOAN"});
  // đặt Toán (GV.C) không liên quan
  assert.equal(c.findTeacherConflictAtSlot("GV.C", "thu2", "sang", 0, "L3", "TOAN"), null);
  // không truyền jointMon (đường cũ) -> vẫn coi là trùng
  same(c.findTeacherConflictAtSlot("GV.A, GV.B", "thu2", "sang", 0, "L3"), {lopId:"L1", mon:"CLB"});
});

test("ô TKB giáo viên: các lớp của tiết chung gộp thành MỘT ô chỉ ghi tên viết tắt (lớp ở tooltip), không tô trùng; khác dòng vẫn trùng", () => {
  const data = school();
  const c = load(data);
  const v = c.tkbTeacherCellView([
    {classId:"L1", classDisplay:"6.1", mon:"CLB"}, {classId:"L2", classDisplay:"6.2", mon:"CLB"}, {classId:"L3", classDisplay:"6.3", mon:"CLB", fixed:true}
  ]);
  assert.equal(v.conflict, false);
  assert.equal(v.entries.length, 1);
  assert.equal(v.entries[0].classDisplay, "", "GV chỉ cần biết nội dung: ô không in danh sách lớp");
  assert.equal(v.entries[0].jointClassLabel, "6.1, 6.2, 6.3", "danh sách lớp chỉ ở tooltip");
  assert.equal(v.entries[0].classId, "L1");
  assert.equal(v.entries[0].fixed, true);
  const w = c.tkbTeacherCellView([{classId:"L1", classDisplay:"6.1", mon:"CLB"}, {classId:"L9", classDisplay:"9.1", mon:"TOAN"}]);
  assert.equal(w.conflict, true);
  assert.equal(w.entries.length, 2);
  const one = c.tkbTeacherCellView([{classId:"L1", classDisplay:"6.1", mon:"CLB"}]);
  assert.equal(one.conflict, false);
  assert.equal(one.entries[0].classDisplay, "6.1");
});

test("ghim trước khi giải: chọn ô mọi lớp cùng trống & GV rảnh ngoài nhóm; bỏ ghim khi cờ bận tắt; ô người dùng tự khóa giữ nguyên", async () => {
  const data = school();
  data.tkb.L9.thu2.sang[0] = "TOAN";        // GV.A bận thứ 2 tiết 1 ở 9.1 (ngoài nhóm)
  data.tkb.L2.thu2.sang[1] = "OFF";         // 6.2 nghỉ thứ 2 tiết 2
  data.tkb.L3.thu2.sang[2] = {mon:"TOAN", fixed:true};   // 6.3 cố định Toán thứ 2 tiết 3
  const c = load(data);
  c.tkbJointTakeSnapshot();
  const pin = c.tkbJointPinForSolve({allowDisplace:false});
  assert.equal(pin.changed, true);
  same(pin.pinned.map(p => [p.row, p.classes, p.slots]), [["CLB", 3, ["thu2/sang/4"]]], "ô đầu tiên thoả: thứ 2 tiết 4");
  ["L1", "L2", "L3"].forEach(id => same(data.tkb[id].thu2.sang[3], {mon:"CLB", fixed:true, jointPin:true}));
  assert.equal(c.tkbJointPinnedCount(), 3);
  // cờ bận bật rồi tắt -> bỏ ghim
  c.window.__TKB_RUST_SOLVER_RUNNING = true;
  c.busy = true;
  c.window.__TKB_RUST_SOLVER_RUNNING = false;
  c.busy = false;
  c.window.__TKB_SOLVE_UI_BUSY = false;
  await new Promise(r => setTimeout(r, 10));
  ["L1", "L2", "L3"].forEach(id => assert.equal(data.tkb[id].thu2.sang[3], "CLB"));
  assert.ok(c.saved >= 1 && c.rendered >= 1, "bỏ ghim thì lưu + vẽ lại");
  // bridge áp kết quả SAU khi cờ bận tắt: ô quay lại fixed:true từ payload -> gỡ lần nữa (saveStore trustedSolverApply)
  ["L1", "L2", "L3"].forEach(id => { data.tkb[id].thu2.sang[3] = {mon:"CLB", fixed:true}; });
  assert.equal(c.tkbJointUnpinQuiet(), true);
  ["L1", "L2", "L3"].forEach(id => assert.equal(data.tkb[id].thu2.sang[3], "CLB"));
  // lượt ghim mới xóa sổ cũ
  c.tkbJointPinForSolve({allowDisplace:false});
  assert.equal(c.tkbJointPinnedCount(), 3);
  c.tkbJointUnpin();

  // người dùng tự khóa ở 6.1 -> đồng bộ khóa cả nhóm -> không có gì để ghim; bỏ ghim không đụng ô người dùng khóa
  data.tkb.L1.thu2.sang[3] = {mon:"CLB", fixed:true};
  c.tkbJointReconcile({force:true});
  same([data.tkb.L2.thu2.sang[3], data.tkb.L3.thu2.sang[3]], [{mon:"CLB", fixed:true}, {mon:"CLB", fixed:true}], "khóa đồng bộ cả nhóm");
  const pin2 = c.tkbJointPinForSolve({allowDisplace:false});
  assert.equal(pin2.changed, false, "đã khóa cả nhóm -> không có gì để ghim thêm");
  assert.equal(c.tkbJointPinnedCount(), 0, "lượt ghim mới xóa sổ cũ, không ghi ô người dùng khóa");
  c.tkbJointUnpin();
  same([data.tkb.L1.thu2.sang[3], data.tkb.L2.thu2.sang[3], data.tkb.L3.thu2.sang[3]], [{mon:"CLB", fixed:true}, {mon:"CLB", fixed:true}, {mon:"CLB", fixed:true}]);
});

test("chưa có ảnh chụp (dữ liệu vừa nạp): lần đồng bộ đầu chỉ chụp ảnh, KHÔNG đoán mò sửa lưới", () => {
  const data = school();
  data.tkb.L1.thu2.sang[0] = "CLB";   // lưới nạp về đang lệch (chỉ 6.1 có tiết)
  const c = load(data);
  const r = c.tkbJointReconcile();
  assert.equal(r.changed, false);
  same([data.tkb.L1.thu2.sang[0], data.tkb.L2.thu2.sang[0]], ["CLB", ""], "không đụng dữ liệu");
  // thao tác đầu tiên sau đó: 6.2 đặt tiết -> 6.2 là sự thật
  data.tkb.L2.thu3.sang[1] = "CLB";
  const r2 = c.tkbJointReconcile();
  assert.equal(r2.rows[0].truthId, "L2");
  same([data.tkb.L1.thu2.sang[0], data.tkb.L1.thu3.sang[1], data.tkb.L3.thu3.sang[1]], ["", "CLB", "CLB"]);
});

function loadRequired(data){
  // 02/09: kèm khối tkbGhepRowFor/tkbIsNoTeacherGhep (dòng không GV chỉ có khoá trong bảng Tiết)
  const src = [
    slice("function tkbGhepRowFor(", "function tkbMonLabel("),
    slice("function requiredSubjectsForClass(", "\nfunction ")
  ].join("\n");
  const context = {
    DATA:data, Map, Set, Number, String, Object, Array, Math, JSON,
    ensureRequiredSubjectsCache(){ return new Map(); },
    getLopCanonById(id){ const l = data.lop.find(x => String(x.id) === String(id)); return l ? l.ten : String(id); },
    extractKhoiNumber(x){ const m = String(x || "").match(/\d+/); return m ? m[0] : ""; },
    monCanonicalKey(m){ return String(m || "").trim().toLowerCase(); },
    computeMonsForClass(){ return [{ten:"Toán", sotiet:4}]; },
    getTeacherForClassMon(lop, mon){ return data.pccmMatrix[`${lop}|${mon}`] || ""; },
    getRoomForClassMon(){ return ""; },
    classKeyCandidates(canon){ const l = data.lop.find(x => x.ten === canon); return l ? [l.ten, l.id] : [canon]; }
  };
  vm.runInNewContext(src, context, {filename:PHANMON_PATH});
  return context.requiredSubjectsForClass;
}

test("môn cần xếp của lớp nhận khoá phân công theo TÊN lớp ('6.1|AI-1') lẫn mã lớp -> môn ghép vào danh sách Chưa phân", () => {
  const data = school();
  data.pccmMatrix["L1|GDĐP"] = "GV.C";
  data.pccmTietMatrix = {"6.1|CLB":"1", "L1|GDĐP":"1", "9.1|AI":"1"};
  const required = loadRequired(data);
  const rows = required(data.lop[0]);
  same(rows.map(r => [r.mon, r.required, r.gv]), [["Toán", 4, ""], ["CLB", 1, "GV.A, GV.B"], ["GDĐP", 1, "GV.C"]]);
  const other = required(data.lop[3]);   // 9.1: chỉ AI + Toán
  same(other.map(r => r.mon).sort(), ["AI", "Toán"]);
});

test("ghim với allowDisplace: hết ô cùng trống thì đưa tiết khác về Chưa phân; không có allowDisplace thì báo chưa ghim được", () => {
  const data = school();
  // 6.1 kín Toán (không khóa) mọi ô
  DAYS.forEach(d => ["sang", "chieu"].forEach(b => { for(let i = 0; i < 5; i++) data.tkb.L1[d][b][i] = "TOAN"; }));
  const c = load(data);
  c.tkbJointTakeSnapshot();
  const noDisp = c.tkbJointPinForSolve({allowDisplace:false});
  same(noDisp.skipped.map(s => s.row), ["CLB"]);
  assert.equal(noDisp.changed, false);
  const disp = c.tkbJointPinForSolve({allowDisplace:true});
  assert.equal(disp.changed, true);
  assert.equal(disp.displaced, 1);
  same(data.tkb.L1.thu2.sang[0], {mon:"CLB", fixed:true, jointPin:true});
  assert.equal(data.tkb.L2.thu2.sang[0].mon, "CLB");
  assert.match(c.tkbJointPinMessage(disp), /1 tiết khác được đưa về Chưa phân/);
});

// 02/09: dòng Dạy ghép KHÔNG giáo viên (gv:[]) — tiết chung của các lớp nhưng không chiếm ai.
test("02/09 dòng không GV: ghim trước khi giải không xét GV bận ngoài nhóm; tkbIsNoTeacherGhep nhận đúng dòng", () => {
  const data = school();
  data.dayGhep[0].gv = [];                    // CLB (6.1, 6.2, 6.3) không giáo viên
  ["6.1", "6.2", "6.3"].forEach(c => { delete data.pccmMatrix[`${c}|CLB`]; });
  data.pccmTietMatrix = {"6.1|CLB":"1", "6.2|CLB":"1", "6.3|CLB":"1"};
  data.tkb.L9.thu2.sang[0] = "TOAN";          // GV.A bận thứ 2 tiết 1 ở 9.1 — không liên quan vì CLB không có GV
  const c = load(data);
  assert.equal(c.tkbIsNoTeacherGhep("L1", "CLB"), true);
  assert.equal(c.tkbIsNoTeacherGhep("6.2", "CLB"), true, "nhận cả tên lớp");
  assert.equal(c.tkbIsNoTeacherGhep("L9", "AI"), false, "dòng AI có GV.A");
  assert.equal(c.tkbIsNoTeacherGhep("L9", "CLB"), false, "9.1 không thuộc dòng");
  assert.equal(c.tkbGhepRowHasNoTeacher(data.dayGhep[0]), true);
  assert.equal(c.tkbGhepRowHasNoTeacher({gv:"GV.A, GV.B"}), false);
  assert.equal(c.tkbGhepRowHasNoTeacher({gv:" , "}), true, "chuỗi rỗng sau khi tách = không GV");

  c.tkbJointTakeSnapshot();
  const pin = c.tkbJointPinForSolve({allowDisplace:false});
  assert.equal(pin.changed, true);
  same(pin.pinned.map(p => [p.row, p.classes, p.slots]), [["CLB", 3, ["thu2/sang/1"]]], "ô đầu tiên (thứ 2 tiết 1) dùng được dù GV.A đang dạy 9.1 ở đó");
  ["L1", "L2", "L3"].forEach(id => same(data.tkb[id].thu2.sang[0], {mon:"CLB", fixed:true, jointPin:true}));
  assert.equal(c.tkbGhepTeachersBusyOutside(data.dayGhep[0], ["L1", "L2", "L3"], "thu2", "sang", 0), false);
});

test("02/09 dòng không GV vào danh sách môn cần xếp của lớp (requiredSubjectsForClass) với gv rỗng", () => {
  const data = school();
  data.dayGhep[0].gv = [];
  ["6.1", "6.2", "6.3"].forEach(c => { delete data.pccmMatrix[`${c}|CLB`]; });
  data.pccmTietMatrix = {"6.1|CLB":"1", "6.2|CLB":"1", "6.3|CLB":"1", "9.1|AI":"1"};
  const required = loadRequired(data);
  const rows = required(data.lop[0]);
  same(rows.map(r => [r.mon, r.required, r.gv]), [["Toán", 4, ""], ["CLB", 1, ""]], "khoá chỉ có trong bảng Tiết vẫn là môn cần xếp");
});
