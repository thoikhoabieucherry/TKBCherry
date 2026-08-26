"use strict";

// 25/08: danh sach lop o "Mon hoc khong cung buoi / khong cung ngay" chi ho
// tro Ctrl+Click tung lop; chu du an muon chon nhieu lop nhu o "Yeu cau co
// dinh lop hoc" (Shift+Click chon dai, Ctrl+Shift cong don) va co nut "Chon
// tat ca". Test kiem tra phan trang thai (hooks) va HTML cua bang.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");

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
  return window.__TKB_CONSTRAINTS_TEST_HOOKS;
}

function schoolData(){
  return {
    lop:[{id:"L1", ten:"6A"}, {id:"L2", ten:"6B"}, {id:"L3", ten:"6C"}, {id:"L4", ten:"6D"}, {id:"L5", ten:"6E"}],
    giaovien:[{magv:"GV1", ten:"A"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toán"}, {id:"Van", ma:"Van", ten:"Văn"}],
    mon:[{id:"Toan", khoi:"6", ten:"Toán", sotiet:"4", gioihan:"2"}, {id:"Van", khoi:"6", ten:"Văn", sotiet:"4", gioihan:"2"}],
    pccmMatrix:{"L1|Toan":"GV1", "L1|Van":"GV1"},
    pccmTietMatrix:{}, pccmGioihanMatrix:{},
    tkb:{},
    tkbConstraints:{}
  };
}

test("Shift+Click chon dai lop, Ctrl+Shift cong don, Ctrl+Click bo bot", () => {
  const h = loadConstraints(schoolData());
  h.setNoSameSingleClass("L1");
  h.selectNoSameClassRange("L3", false);
  assert.deepEqual(h.noSameSelectedClassIds(), ["L1", "L2", "L3"]);
  h.toggleNoSameClass("L2");
  assert.deepEqual(h.noSameSelectedClassIds(), ["L1", "L3"]);
  // neo la lop vua bam (L2): Ctrl+Shift tu L2 toi L4 cong don
  h.selectNoSameClassRange("L4", true);
  assert.deepEqual([...h.noSameSelectedClassIds()].sort(), ["L1", "L2", "L3", "L4"]);
  // Shift khong cong don: dai tu neo (L2, lop bam gan nhat khong kem Shift) toi L5; lop chinh L1 van giu
  h.selectNoSameClassRange("L5", false);
  assert.deepEqual([...h.noSameSelectedClassIds()].sort(), ["L1", "L2", "L3", "L4", "L5"]);
  h.setNoSameSingleClass("L4");
  h.selectNoSameClassRange("L5", false);
  assert.deepEqual(h.noSameSelectedClassIds(), ["L4", "L5"]);
  h.selectAllNoSameClasses();
  assert.deepEqual([...h.noSameSelectedClassIds()].sort(), ["L1", "L2", "L3", "L4", "L5"]);
  h.setNoSameSingleClass("L3");
  assert.deepEqual(h.noSameSelectedClassIds(), ["L3"]);
});

test("bang 'khong cung buoi' co nut Chon tat ca va goi y phim", () => {
  const h = loadConstraints(schoolData());
  h.setNoSameSingleClass("L1");
  const html = String(h.renderSubjectRule("noSameSession"));
  assert.match(html, /data-nss-select-all/);
  assert.match(html, /data-nss-select-one/);
  assert.match(html, /Shift\+Click/);
  assert.equal((html.match(/data-nss-class-select=/g) || []).length, 5);
  // cung cach the hien voi danh sach "Yeu cau co dinh giao vien"
  assert.match(html, /class="rb-fixedoff-screen rb-nss-screen"/);
  assert.match(html, /<div class="rb-fixedoff-list">/);
  assert.equal((html.match(/class="rb-fixedoff-item /g) || []).length, 5);
  assert.doesNotMatch(html, /rb-nss-layout|rb-nss-classes/);
});
