"use strict";

// 25/08 (sau review): chi muc lich cua bo kiem tra (buildScheduleIndex,
// cellsFromLessons, teacherCellsAfterPlace, evalTeacherRule) tung khoa tiet
// day ghep theo ca chuoi "GV1, GV2" nen luat GV cua TUNG thanh vien (must-teach,
// gioi han tiet/buoi, ...) khong nhin thay tiet ghep — lech voi engine v3 va
// validate.py (dem cho tung thanh vien). Gio moi thanh vien deu co tiet ghep
// trong chi muc cua minh.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");

function blankSession(values = []){
  return Array.from({length:5}, (_, index) => values[index] || "");
}

function loadConstraints(data){
  const head = {appendChild(){}};
  const body = {appendChild(){}};
  const document = {
    head, body, readyState:"complete",
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    addEventListener(){},
    createElement(){ return {id:"", textContent:"", style:{}, classList:{add(){}, remove(){}, toggle(){}}}; }
  };
  const window = {
    DATA:data, document, location:{search:""}, __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout
  };
  window.window = window;
  const context = {
    window, document, DATA:data, DAYS:["thu2"], LABEL:{thu2:"Thu 2"}, SANG:5, CHIEU:5,
    console, Date, Math, JSON, Object, Array, Set, Map, WeakMap, URLSearchParams, setTimeout, clearTimeout
  };
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename:CONSTRAINTS_PATH});
  return window.TKBConstraints;
}

function schoolData(){
  return {
    lop:[{id:"L1", ten:"6A"}, {id:"L2", ten:"6B"}],
    giaovien:[{magv:"GV1", ten:"Trâm"}, {magv:"GV2", ten:"Vân"}],
    monhoc:[{id:"TNHN", ma:"TNHN", ten:"TNHN"}, {id:"KHTN", ma:"KHTN", ten:"KHTN"}],
    mon:[{id:"TNHN", khoi:"6", ten:"TNHN", sotiet:"2", gioihan:"2"}, {id:"KHTN", khoi:"6", ten:"KHTN", sotiet:"4", gioihan:"2"}],
    pccmMatrix:{"L1|TNHN":"GV1, GV2", "L2|KHTN":"GV1"},
    pccmTietMatrix:{"L1|TNHN":"2", "L2|KHTN":"4"},
    pccmGioihanMatrix:{"L1|TNHN":"2", "L2|KHTN":"2"},
    tkb:{
      L1:{thu2:{sang:blankSession(["TNHN"]), chieu:blankSession()}},
      L2:{thu2:{sang:blankSession(), chieu:blankSession()}}
    },
    tkbConstraints:{}
  };
}

test("must-teach cua mot thanh vien duoc thoa boi tiet day ghep", () => {
  const data = schoolData();
  data.tkbConstraints = {teacher:{GV1:{mustTeach:{"thu2|sang|0":true}}}};
  const api = loadConstraints(data);
  const items = api.validateAll(100);
  assert.equal(items.some(item => item.kind === "teacher.mustTeach.missing"), false, JSON.stringify(items));
});

test("gioi han tiet/buoi cua mot thanh vien dem ca tiet day ghep", () => {
  const data = schoolData();
  // GV1 toi da 1 tiet sang thu 2; da co tiet ghep TNHN tiet 1 -> KHTN cua 6B khong duoc them vao sang thu 2
  data.tkbConstraints = {teacher:{GV1:{maxPeriods:{sang:{thu2:1}}}}};
  const api = loadConstraints(data);
  const res = api.canPlaceLesson({lopId:"L2", mon:"KHTN", thu:"thu2", buoi:"sang", ti:2, mode:"drag"});
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match((res.messages || []).join("\n"), /vượt giới hạn/);
  const afternoon = api.canPlaceLesson({lopId:"L2", mon:"KHTN", thu:"thu2", buoi:"chieu", ti:0, mode:"drag"});
  assert.equal(afternoon.ok, true, JSON.stringify(afternoon.messages));
});

test("tha tiet ghep: luat cua thanh vien THU HAI (GV2) cung duoc kiem", () => {
  const data = schoolData();
  // GV2 toi da 1 tiet sang thu 2; tiet ghep TNHN tiet 1 da dem cho GV2 -> tiet ghep thu hai vao sang thu 2 bi chan
  data.tkbConstraints = {teacher:{GV2:{maxPeriods:{sang:{thu2:1}}}}};
  const api = loadConstraints(data);
  const res = api.canPlaceLesson({lopId:"L1", mon:"TNHN", thu:"thu2", buoi:"sang", ti:3, mode:"drag"});
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match((res.messages || []).join(" | "), /Vân.*vượt giới hạn/);
});
