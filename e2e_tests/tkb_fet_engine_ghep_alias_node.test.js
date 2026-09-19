"use strict";

// 31/08: nút ▶ (FET thuần). Khoá dòng DẠY GHÉP ("AV-GT", row.ten) là bí danh của môn gốc (row.mon[0])
// khi tra luật: getCanonMonKey("AV-GT") === getCanonMonKey("AVGT"), nhờ đó luật tiết đôi / nghỉ cố định
// môn / giới hạn tiết/buổi của môn gốc áp cho hoạt động ghép. act.mon vẫn là "AV-GT" (ô TKB, GV, số tiết).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ENGINE_SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "web", "pages", "tkb-fet-engine.js"), "utf8");

function loadEngine(){
  const window = {};
  const context = vm.createContext({
    window, globalThis:window, console, Date, Math, JSON, Map, Set, Array, String, Number, Object, RegExp,
    setTimeout, clearTimeout
  });
  vm.runInContext(ENGINE_SOURCE, context, {filename:"tkb-fet-engine.js"});
  return window.FetTimetableEngine;
}

function makeData(withGhep){
  const data = {
    lop:[{id:"L1", ten:"10A1", ten2:"10A1", khoi:"10"}],
    mon:[{ten:"AVGT", khoi:"10", sotiet:2, gioihan:2}, {ten:"TOAN", khoi:"10", sotiet:4, gioihan:2}],
    monhoc:[{ten:"Anh văn giao tiếp", ma:"AVGT"}, {ten:"Toán", ma:"TOAN"}],
    giaovien:[{magv:"GV1", ten:"GV1"}, {magv:"GV2", ten:"GV2"}, {magv:"GV3", ten:"GV3"}],
    pccmMatrix:{"L1|AVGT":"GV1", "L1|TOAN":"GV3"},
    pccmTietMatrix:{"L1|AVGT":2, "L1|TOAN":4},
    pccmRoomMatrix:{}, pccmGioihanMatrix:{"L1|AVGT":2, "L1|TOAN":2},
    tkb:{}, tkbLessonTeachers:{}, tkbLessonRooms:{},
    tkbConstraints:{subject:{}}
  };
  if(withGhep){
    data.dayGhep = [{id:"DG001", ten:"AV-GT", viettat:"AV-GT", lop:["10A1"], mon:["AVGT"], gv:["GV1", "GV2"], sotiet:"1", gioihan:"1"}];
    data.pccmMatrix["L1|AV-GT"] = "GV1, GV2";
    data.pccmTietMatrix["L1|AV-GT"] = 1;
    data.pccmGioihanMatrix["L1|AV-GT"] = 1;
  }
  return data;
}

test("khoá ghép quy về cùng canon với môn gốc; không có dòng ghép thì là môn riêng", () => {
  const FetTimetableEngine = loadEngine();
  const withGhep = new FetTimetableEngine(makeData(true), {seed:1});
  assert.equal(withGhep.getCanonMonKey("AV-GT"), withGhep.getCanonMonKey("AVGT"));
  assert.equal(withGhep.getCanonMonKey("AV-GT"), withGhep.getCanonMonKey("Anh văn giao tiếp"), "mọi bí danh môn gốc cùng canon");
  assert.notEqual(withGhep.getCanonMonKey("AV-GT"), withGhep.getCanonMonKey("TOAN"));

  const without = new FetTimetableEngine(makeData(false), {seed:1});
  assert.notEqual(without.getCanonMonKey("AV-GT"), without.getCanonMonKey("AVGT"), "chưa có dòng ghép: khoá lạ là môn riêng");
});

test("chỉ mục bí danh làm mới khi DATA.dayGhep đổi (mảng mới)", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData(true);
  const engine = new FetTimetableEngine(data, {seed:1});
  assert.equal(engine.getCanonMonKey("AV-GT"), engine.getCanonMonKey("AVGT"));
  data.dayGhep = [];   // dòng ghép bị xoá
  assert.notEqual(engine.getCanonMonKey("AV-GT"), engine.getCanonMonKey("AVGT"));
});

test("luật tiết đôi của môn gốc áp cho hoạt động ghép; act.mon vẫn là khoá ghép", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData(true);
  data.tkbConstraints.subject.AVGT = {byClass:{L1:{lessonBlocks:{2:{min:1}}}}};
  const engine = new FetTimetableEngine(data, {seed:3});
  engine.init();
  const acts = (engine.activities || []).filter(a => a.classId === "L1" || String(a.lop?.id || a.lop) === "L1");
  const ghepActs = acts.filter(a => a.mon === "AV-GT");
  assert.ok(ghepActs.length >= 1, "phải có hoạt động của dòng ghép với mon = 'AV-GT': " + JSON.stringify(acts.map(a => a.mon)));
  const canonAVGT = engine.getCanonMonKey("AVGT");
  ghepActs.forEach(a => assert.equal(a.canonKey, canonAVGT, "canonKey của hoạt động ghép = canon môn gốc"));
  // luật tiết đôi được nạp theo canon môn gốc -> hoạt động ghép nằm trong phạm vi luật
  const rules = engine.classSubjectLessonBlocks || engine.lessonBlockRules || null;
  if(rules && typeof rules.get === "function"){
    assert.ok(rules.get(`L1|${canonAVGT}|2`), "luật tiết đôi nạp theo canon môn gốc");
  }
});

// 02/09: dòng Dạy ghép KHÔNG giáo viên (gv:[]) — không có khoá pccmMatrix, chỉ pccmTietMatrix.
// ▶ FET vẫn phải xếp tiết đó cho lớp (act.gv = "" -> không ghi teacherGrid, không trùng giờ ai).
test("02/09 dòng ghép không giáo viên: FET tạo hoạt động gv='' và xếp đủ tiết cho từng lớp", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData(false);
  data.lop.push({id:"L2", ten:"10A2", ten2:"10A2", khoi:"10"});
  data.pccmMatrix["L2|TOAN"] = "GV3";
  data.pccmTietMatrix["L2|TOAN"] = 4;
  data.pccmGioihanMatrix["L2|TOAN"] = 2;
  data.dayGhep = [
    {id:"DG001", ten:"Hội trường", viettat:"Hội trường", lop:["10A1", "10A2"], mon:["AVGT"], gv:[], sotiet:"1", gioihan:"1"},
    {id:"DG002", ten:"Tự học", viettat:"Tự học", lop:["10A1"], mon:["TOAN"], gv:[], sotiet:"2", gioihan:"1"}
  ];
  data.pccmTietMatrix["10A1|Hội trường"] = 1;
  data.pccmTietMatrix["10A2|Hội trường"] = 1;
  data.pccmTietMatrix["10A1|Tự học"] = 2;
  data.pccmGioihanMatrix["10A1|Tự học"] = 1;

  const engine = new FetTimetableEngine(data, {seed:5, solveBudgetMs:5000});
  assert.equal(engine.isNoTeacherGhepSubject(data.lop[0], "Hội trường"), true);
  assert.equal(engine.isNoTeacherGhepSubject(data.lop[1], "Tự học"), false, "dòng chỉ có 10A1");
  assert.equal(engine.isNoTeacherGhepSubject(data.lop[0], "AVGT"), false, "môn thường có GV không phải tiết không GV");

  engine.init();
  const acts = engine.activities || [];
  const hall = acts.filter(a => a.mon === "Hội trường");
  const self = acts.filter(a => a.mon === "Tự học");
  assert.equal(hall.length, 2, "mỗi lớp một hoạt động Hội trường: " + JSON.stringify(acts.map(a => [a.classId, a.mon])));
  assert.equal(self.length, 2, "10A1 có 2 tiết Tự học (giới hạn 1/buổi -> 2 hoạt động đơn)");
  hall.concat(self).forEach(a => assert.equal(a.gv, "", "hoạt động không GV"));

  const result = await engine.solve();
  assert.ok(result && result.ok, JSON.stringify(result && {ok:result.ok, unassigned:result.unassigned, error:result.error}));
  assert.equal(Number(result.unassigned || 0), 0, "xếp đủ mọi tiết (kể cả tiết không GV)");
  const count = (cid, mon) => {
    let n = 0;
    Object.values(data.tkb[cid] || {}).forEach(day => ["sang", "chieu"].forEach(b => (day?.[b] || []).forEach(v => {
      const m = typeof v === "object" && v ? v.mon : v;
      if(String(m || "") === mon) n += 1;
    })));
    return n;
  };
  assert.equal(count("L1", "Hội trường"), 1);
  assert.equal(count("L2", "Hội trường"), 1);
  assert.equal(count("L1", "Tự học"), 2);
  assert.equal(count("L1", "TOAN"), 4);
  assert.equal(count("L2", "TOAN"), 4);
  assert.ok(!data.tkbLessonTeachers["L1|Hội trường"], "không ghi GV cho tiết không GV");
});
