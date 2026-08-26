"use strict";

// 25/08: tiet DAY GHEP (1 mon, 1 lop, 2 giao vien "GV1, GV2"). Bo kiem tra
// keo-tha / validateAll (tkb-constraints.js) tung tra o nghi co dinh cua
// giao vien bang ca chuoi "GV1, GV2" -> khong khop ai -> cho phep tha tiet
// ghep len o nghi cua GV1 hoac GV2. Gio tung thanh vien deu duoc kiem tra.

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
  assert.equal(typeof window.TKBConstraints?.canPlaceLesson, "function");
  return window.TKBConstraints;
}

function schoolData(){
  return {
    lop:[{id:"L1", ten:"6A"}],
    giaovien:[{magv:"GV1", ten:"Trâm"}, {magv:"GV2", ten:"Vân"}],
    monhoc:[{id:"TNHN", ma:"TNHN", ten:"TNHN"}],
    mon:[{id:"TNHN", khoi:"6", ten:"TNHN", sotiet:"2", gioihan:"2"}],
    pccmMatrix:{"L1|TNHN":"GV1, GV2"},
    pccmTietMatrix:{"L1|TNHN":"2"},
    pccmGioihanMatrix:{"L1|TNHN":"2"},
    tkb:{L1:{thu2:{sang:blankSession(), chieu:blankSession()}}},
    tkbConstraints:{
      fixedOff:{
        teacher:{
          GV2:{"thu2|sang|0":true},   // Van nghi tiet 1 sang thu 2
          GV1:{"thu2|chieu|4":true}   // Tram nghi tiet 5 chieu thu 2
        }
      }
    }
  };
}

test("tiet ghep khong duoc tha len o nghi co dinh cua BAT KY giao vien thanh vien", () => {
  const api = loadConstraints(schoolData());
  const onVanOff = api.canPlaceLesson({lopId:"L1", mon:"TNHN", thu:"thu2", buoi:"sang", ti:0, mode:"drag"});
  assert.equal(onVanOff.ok, false, "GV2 nghi tiet 1 sang thu 2");
  assert.match((onVanOff.messages || []).join("\n"), /đã cố định/);

  const onTramOff = api.canPlaceLesson({lopId:"L1", mon:"TNHN", thu:"thu2", buoi:"chieu", ti:4, mode:"drag"});
  assert.equal(onTramOff.ok, false, "GV1 nghi tiet 5 chieu thu 2");

  const free = api.canPlaceLesson({lopId:"L1", mon:"TNHN", thu:"thu2", buoi:"sang", ti:2, mode:"drag"});
  assert.equal(free.ok, true, JSON.stringify(free.messages));
});

test("validateAll bao tiet ghep dang nam tren o nghi cua mot thanh vien", () => {
  const data = schoolData();
  data.tkb.L1.thu2.sang[0] = "TNHN";
  const api = loadConstraints(data);
  const items = api.validateAll(100);
  assert.ok(items.some(item => /đã cố định/.test(item.message)), JSON.stringify(items));
});
