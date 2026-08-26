"use strict";

// 23/08: TKBConstraints.teacherLocationRuleDebt() — dem cac buoi (GV, thu, buoi)
// vi pham yeu cau DIA DIEM (co tiet trong giua 2 dia diem / khong di chuyen 2
// lan/buoi / 1 dia diem/buoi), tren luoi dang hien thi hoac tren danh sach tiet
// cua ung vien engine (opts.lessons). Bridge dung so nay o cong Cherry va trong
// thong bao ket thuc; engine v3 coi cac yeu cau nay la rang buoc cung.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");
const DAY_KEYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];

function allSessions(){
  return Object.fromEntries(["sang", "chieu"].map(b => [b, Object.fromEntries(DAY_KEYS.map(d => [d, true]))]));
}

function emptyGrid(){
  return Object.fromEntries(DAY_KEYS.map(d => [d, {sang: ["", "", "", "", ""], chieu: ["", "", "", "", ""]}]));
}

function schoolData(){
  // L1, L2 o "Dia diem 1"; L3 o "Dia diem 2". GV_A day Toan ca 3 lop.
  const lop = [
    {id: "L1", ten: "6/1", khoi: "6", diadiem: "Địa điểm 1"},
    {id: "L2", ten: "6/2", khoi: "6", diadiem: "Địa điểm 1"},
    {id: "L3", ten: "6/3", khoi: "6", diadiem: "Địa điểm 2"}
  ];
  const pccmMatrix = {};
  lop.forEach(l => { pccmMatrix[`${l.ten}|Toan`] = "GV_A"; pccmMatrix[`${l.id}|Toan`] = "GV_A"; });
  return {
    lop,
    giaovien: [{magv: "GV_A", ten: "GV A"}],
    monhoc: [{ten: "Toan", ma: "TO"}],
    pccmMatrix,
    pccmTietMatrix: {},
    pccmRoomMatrix: {},
    phong: [],
    tkb: {L1: emptyGrid(), L2: emptyGrid(), L3: emptyGrid()},
    tkbConstraints: {
      teacher: {GV_A: {gapBetweenLocations: allSessions(), maxOneMovePerSession: allSessions()}}
    }
  };
}

function loadConstraints(data){
  const head = {appendChild(){}};
  const body = {appendChild(){}};
  const document = {
    head, body, readyState: "complete",
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    addEventListener(){},
    createElement(){ return {id: "", textContent: "", style: {}, classList: {add(){}, remove(){}, toggle(){}}}; }
  };
  const window = {
    DATA: data, document, location: {search: ""},
    __TKB_E2E_EXPOSE_TEST_HOOKS: true,
    addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout
  };
  window.window = window;
  const context = {
    window, document, DATA: data, DAYS: DAY_KEYS,
    LABEL: Object.fromEntries(DAY_KEYS.map((d, i) => [d, `Thứ ${i + 2}`])),
    SANG: 5, CHIEU: 5,
    console, Date, Math, JSON, Object, Array, Set, Map, WeakMap, URLSearchParams, setTimeout, clearTimeout
  };
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename: CONSTRAINTS_PATH});
  assert.ok(window.TKBConstraints, "constraints API must load");
  return window.TKBConstraints;
}

test("teacherLocationRuleDebt counts adjacent campus changes and double moves on the visible grid", () => {
  const data = schoolData();
  // Thu 2 sang: L1 tiet 1-2 (DD1) roi L3 tiet 3 (DD2) lien tiet -> vi pham "co tiet trong giua 2 dia diem"
  data.tkb.L1.thu2.sang[0] = "Toan"; data.tkb.L1.thu2.sang[1] = "Toan"; data.tkb.L3.thu2.sang[2] = "Toan";
  // Thu 3 sang: L1 tiet 1, L3 tiet 3, L2 tiet 5 -> co tiet trong moi lan doi nhung doi 2 lan -> vi pham "khong di chuyen 2 lan"
  data.tkb.L1.thu3.sang[0] = "Toan"; data.tkb.L3.thu3.sang[2] = "Toan"; data.tkb.L2.thu3.sang[4] = "Toan";
  // Thu 4 sang: L1 tiet 1-2, trong tiet 3, L3 tiet 4-5 -> hop le (1 lan doi, co tiet trong)
  data.tkb.L1.thu4.sang[0] = "Toan"; data.tkb.L1.thu4.sang[1] = "Toan"; data.tkb.L3.thu4.sang[3] = "Toan"; data.tkb.L3.thu4.sang[4] = "Toan";
  // Thu 5 sang: L1 tiet 1-2, L2 tiet 3 (cung dia diem) -> hop le
  data.tkb.L1.thu5.sang[0] = "Toan"; data.tkb.L1.thu5.sang[1] = "Toan"; data.tkb.L2.thu5.sang[2] = "Toan";
  const api = loadConstraints(data);
  assert.equal(typeof api.teacherLocationRuleDebt, "function");
  const debt = api.teacherLocationRuleDebt();
  assert.equal(debt.sessions, 2, JSON.stringify(debt));
  assert.equal(debt.teachers, 1);
  const kinds = Object.fromEntries(debt.cases.map(c => [c.thu, c.kinds]));
  assert.deepEqual(Array.from(kinds.thu2), ["gapBetweenLocations"]);
  assert.deepEqual(Array.from(kinds.thu3), ["maxOneMovePerSession"]);
});

test("teacherLocationRuleDebt ignores teachers without location rules and single-campus sessions", () => {
  const data = schoolData();
  data.tkbConstraints.teacher = {};
  data.tkb.L1.thu2.sang[0] = "Toan"; data.tkb.L1.thu2.sang[1] = "Toan"; data.tkb.L3.thu2.sang[2] = "Toan";
  const api = loadConstraints(data);
  assert.equal(api.teacherLocationRuleDebt().sessions, 0);
});

test("teacherLocationRuleDebt scores an engine lessons payload without touching the grid", () => {
  const data = schoolData();
  const api = loadConstraints(data);
  const bad = [
    {classId: "L1", className: "6/1", day: 2, session: "AM", period: 1, subject: "Toan", teacher: "GV_A", room: ""},
    {classId: "L1", className: "6/1", day: 2, session: "AM", period: 2, subject: "Toan", teacher: "GV_A", room: ""},
    {classId: "L3", className: "6/3", day: 2, session: "AM", period: 3, subject: "Toan", teacher: "GV_A", room: ""}
  ];
  assert.equal(api.teacherLocationRuleDebt({lessons: bad}).sessions, 1);
  const good = [
    {classId: "L1", className: "6/1", day: 2, session: "AM", period: 1, subject: "Toan", teacher: "GV_A", room: ""},
    {classId: "L1", className: "6/1", day: 2, session: "AM", period: 2, subject: "Toan", teacher: "GV_A", room: ""},
    {classId: "L3", className: "6/3", day: 2, session: "AM", period: 4, subject: "Toan", teacher: "GV_A", room: ""}
  ];
  assert.equal(api.teacherLocationRuleDebt({lessons: good}).sessions, 0);
  // Ten lop thay cho id (payload cu) van doi chieu duoc dia diem.
  const byName = good.map(l => Object.assign({}, l, {classId: undefined}));
  byName[2].period = 3;
  assert.equal(api.teacherLocationRuleDebt({lessons: byName}).sessions, 1);
  // Luoi hien thi van trong -> 0
  assert.equal(api.teacherLocationRuleDebt().sessions, 0);
});
