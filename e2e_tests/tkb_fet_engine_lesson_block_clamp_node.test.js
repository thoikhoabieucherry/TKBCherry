"use strict";

// 25/08: nut ▶ (FET thuan). Mon 1 tiet/tuan (Tin) nhung quick-fill "all" dat
// lessonBlocks[2].min = 1 -> yeu cau bat kha thi. Truoc day FET giu nguyen
// min=1: isLessonBlockSafe() tra false cho MOI nuoc di cham vao lop do,
// evaluateLessonBlockViolations() bao vi pham ao, va buildActivities() ghi
// "tiet doi vuot Gioi han tiet/buoi" cho mon chi co 1 tiet. Gio min duoc ha
// ve floor(soTiet/len) (0 -> bo luat).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ENGINE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-fet-engine.js"),
  "utf8"
);

function loadEngine(){
  const window = {};
  const context = vm.createContext({
    window, globalThis:window, console, Date, Math, JSON, Map, Set, Array, String, Number, Object, RegExp,
    setTimeout, clearTimeout
  });
  vm.runInContext(ENGINE_SOURCE, context, {filename:"tkb-fet-engine.js"});
  return window.FetTimetableEngine;
}

function makeData(rows){
  const teachers = Array.from(new Set(rows.map(r => r.teacher)));
  const data = {
    lop:[{id:"L1", ten:"10A1", ten2:"10A1", khoi:"10"}],
    mon:rows.map(r => ({ten:r.name, khoi:"10", sotiet:r.periods, gioihan:r.limit || 2})),
    monhoc:rows.map(r => ({ten:r.name, ma:r.name})),
    giaovien:teachers.map(ma => ({ma, ten:ma})),
    pccmMatrix:{}, pccmTietMatrix:{}, pccmRoomMatrix:{}, pccmGioihanMatrix:{},
    tkb:{}, tkbLessonTeachers:{}, tkbLessonRooms:{},
    tkbConstraints:{subject:{}}
  };
  rows.forEach(r => {
    data.pccmMatrix[`L1|${r.name}`] = r.teacher;
    data.pccmTietMatrix[`L1|${r.name}`] = r.periods;
    if(r.limit) data.pccmGioihanMatrix[`L1|${r.name}`] = r.limit;
    if(r.min) data.tkbConstraints.subject[r.name] = {byClass:{L1:{lessonBlocks:{2:{min:r.min}}}}};
  });
  return data;
}

function prepare(data){
  const FetTimetableEngine = loadEngine();
  const engine = new FetTimetableEngine(data, {seed:17});
  engine.init();
  return engine;
}

test("mon 1 tiet/tuan voi min=1 cum doi: luat bi bo, khong bao xung dot gioi han", () => {
  const engine = prepare(makeData([
    {name:"Tin", teacher:"GV01", periods:1, limit:1, min:1}
  ]));
  assert.equal(engine.classSubjectLessonBlocks.size, 0, "luat Tin (1 tiet, min 1 cum doi) phai bi bo");
  // (mang tu vm context khac realm -> so do dai, khong deepEqual)
  assert.equal((engine.__blockLimitConflicts || []).length, 0, "khong duoc bao 'tiet doi vuot gioi han' cho mon 1 tiet");
  assert.equal(engine.isLessonBlockSafe(), true, "luoi trong khong con bi coi la vi pham tiet doi cua Tin");
});

test("luat kha thi cua mon khac trong cung lop van duoc giu", () => {
  const engine = prepare(makeData([
    {name:"Tin", teacher:"GV01", periods:1, limit:1, min:1},
    {name:"Toán", teacher:"GV02", periods:4, limit:2, min:1}
  ]));
  const keys = Array.from(engine.classSubjectLessonBlocks.keys());
  assert.equal(keys.some(k => /\|tin\|2$/i.test(k)), false, `luat Tin phai bi bo: ${keys.join(", ")}`);
  assert.equal(keys.length, 1, `chi con luat Toan: ${keys.join(", ")}`);
  const toan = engine.classSubjectLessonBlocks.get(keys[0]);
  assert.equal(toan.min, 1);
});

test("min lon hon floor(soTiet/2) duoc ha ve muc dat duoc (3 tiet, min 2 -> 1)", () => {
  const engine = prepare(makeData([
    {name:"Sử", teacher:"GV03", periods:3, limit:2, min:2}
  ]));
  const entry = Array.from(engine.classSubjectLessonBlocks.values()).find(e => e.len === 2);
  assert.ok(entry, "luat Su van ton tai");
  assert.equal(entry.min, 1);
});
