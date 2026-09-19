// 11/09: Thêm nhanh Phân công — bộ chọn NHIỀU LỚP: bấm thường = bật/tắt từng lớp
// (không cần Ctrl), Shift = dải, menu giữ mở; nút Tất cả / Khối … / Bỏ chọn;
// Môn học (chọn một) vẫn thay thế và đóng menu.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = process.env.TKB_APP_PATH
  ? path.resolve(process.env.TKB_APP_PATH)
  : path.join(__dirname, "..", "web", "app.js");
const APP_SOURCE = fs.readFileSync(APP_PATH, "utf8");

function storageStub(){
  return { length:0, getItem(){ return null; }, setItem(){}, removeItem(){}, key(){ return null; } };
}

// DOM giả: các nút mục chọn (data-pccm-quick-*) + ô ẩn/nhãn/menu của hộp chọn lớp & môn.
function fakeDom(){
  const buttons = { class:[], subject:[] };
  const byId = {};
  const menus = {};
  function mkButton(type, value){
    const cls = new Set();
    return {
      attrs: { "data-pccm-quick-type": type, "data-pccm-quick-value": value, "data-pccm-quick-label": value },
      getAttribute(k){ return this.attrs[k] ?? null; },
      classList: { toggle(name, on){ if (on) cls.add(name); else cls.delete(name); }, contains(n){ return cls.has(n); } },
      get selected(){ return cls.has("selected"); }
    };
  }
  const closed = [];
  const boxes = {};
  function mkBox(id){
    const cls = new Set();
    boxes[id] = { classList: { contains(n){ return cls.has(n); }, add(n){ cls.add(n); }, remove(n){ cls.delete(n); closed.push(id); } } };
    return boxes[id];
  }
  byId.pccmQuickClass = { value:"" };
  byId.pccmQuickClassText = { textContent:"" };
  byId.pccmQuickClassMulti = mkBox("pccmQuickClassMulti");
  byId.pccmQuickClassMulti_menu = { innerHTML:"" };
  byId.pccmQuickMon = { value:"", tagName:"DIV" };
  byId.pccmQuickSubjectText = { textContent:"" };
  byId.pccmQuickSubjectMulti = mkBox("pccmQuickSubjectMulti");
  byId.pccmQuickSubjectMulti_menu = { innerHTML:"" };
  const document = {
    buttons, byId, closed, boxes,
    addEventListener(){}, removeEventListener(){},
    getElementById(id){ return byId[id] || null; },
    querySelectorAll(sel){
      const m = /data-pccm-quick-type="(\w+)"/.exec(sel);
      if (m) return buttons[m[1]] || [];
      if (sel === ".pccm-multi-select.open") return Object.keys(boxes).filter(k=>boxes[k].classList.contains("open")).map(k=>boxes[k]);
      return [];
    },
    querySelector(sel){
      if (/\.pccm-multi-button/.test(sel)) return { title:"" };
      if (/\.pccm-multi-menu/.test(sel)) return byId.pccmQuickSubjectMulti_menu;
      return null;
    },
    documentElement:{ appendChild(){} },
    body:{ appendChild(){}, insertAdjacentHTML(){} }
  };
  document.setItems = (type, values) => { buttons[type] = values.map(v=>mkButton(type, v)); };
  return document;
}

function loadApp(document){
  const localStorage = storageStub();
  const sessionStorage = storageStub();
  const location = { href:"http://localhost/app.html?sid=default", protocol:"http:", hostname:"localhost" };
  const window = {
    document, localStorage, sessionStorage, location,
    history:{ replaceState(){} }, navigator:{},
    addEventListener(){}, removeEventListener(){},
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  window.window = window;
  const context = vm.createContext({
    window, document, localStorage, sessionStorage, location,
    history:window.history, navigator:window.navigator,
    URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval,
    confirm(){ return false; }, alert(){}, prompt(){ return null; },
    indexedDB:{ open(){ return {}; } }, FileReader:function(){}, Blob, TextEncoder, TextDecoder
  });
  vm.runInContext(APP_SOURCE, context, { filename:APP_PATH });
  return context;
}

const FIXTURE = {
  lop:[
    { id:"L001", ten:"6/1", ten2:"6/1", khoi:"Khối 6" },
    { id:"L002", ten:"6/2", ten2:"6/2", khoi:"Khối 6" },
    { id:"L003", ten:"7/1", ten2:"7/1", khoi:"Khối 7" },
    { id:"L004", ten:"7/2", ten2:"7/2", khoi:"Khối 7" }
  ],
  giaovien:[{ magv:"GV01", hodem:"Nguyễn Văn", ten:"An" }],
  monhoc:[{ id:"MH1", ten:"Toán", ma:"TOAN" }],
  mon:[
    { id:"TC1", khoi:"Khối 6", ten:"Toán", sotiet:"4", gioihan:"2" },
    { id:"TC2", khoi:"Khối 7", ten:"Toán", sotiet:"4", gioihan:"2" }
  ],
  phong:[], pccmMatrix:{}, pccmTietMatrix:{}, pccmGioihanMatrix:{}, pccmRoomMatrix:{}
};

function setup(){
  const document = fakeDom();
  const context = loadApp(document);
  vm.runInContext(`DATA=${JSON.stringify(FIXTURE)}; ensureDataShape(); PCCM_TAB="giaovien";`, context);
  document.setItems("class", ["6/1", "6/2", "7/1", "7/2"]);
  document.setItems("subject", ["Toán", "Văn"]);
  document.boxes.pccmQuickClassMulti.classList.add("open");
  return { document, context };
}

function click(context, type, value, mods){
  const ev = Object.assign({ preventDefault(){}, stopPropagation(){}, shiftKey:false, ctrlKey:false, metaKey:false }, mods || {});
  context.__ev = ev;
  vm.runInContext(`pccmQuickMultiItemClick(__ev, ${JSON.stringify(type)}, ${JSON.stringify(value)})`, context);
}

function selectedClasses(document){
  return document.byId.pccmQuickClass.value;
}

test("bấm thường bật/tắt từng lớp, không xoá lớp đã chọn, menu giữ mở", () => {
  const { document, context } = setup();
  click(context, "class", "6/1");
  click(context, "class", "6/2");
  assert.equal(selectedClasses(document), "6/1, 6/2");
  assert.equal(document.byId.pccmQuickClassText.textContent, "6/1, 6/2");
  assert.deepEqual(document.buttons.class.map(b=>b.selected), [true, true, false, false]);
  click(context, "class", "6/1");
  assert.equal(selectedClasses(document), "6/2");
  assert.deepEqual(document.closed, [], "menu chọn lớp không được tự đóng");
  assert.ok(document.boxes.pccmQuickClassMulti.classList.contains("open"));
});

test("Shift = chọn dải từ mốc trước", () => {
  const { document, context } = setup();
  click(context, "class", "6/1");
  click(context, "class", "7/2", { shiftKey:true });
  assert.equal(selectedClasses(document), "6/1, 6/2, 7/1, 7/2");
});

test("nút Khối / Tất cả / Bỏ chọn", () => {
  const { document, context } = setup();
  vm.runInContext(`pccmQuickMultiSelectGroup(null, "class", "Khối 7")`, context);
  assert.equal(selectedClasses(document), "7/1, 7/2");
  vm.runInContext(`pccmQuickMultiSelectGroup(null, "class", "Khối 7")`, context);
  assert.equal(selectedClasses(document), "", "bấm lại khối đã đủ = bỏ cả khối");
  vm.runInContext(`pccmQuickMultiSelectAll(null, "class")`, context);
  assert.equal(selectedClasses(document), "6/1, 6/2, 7/1, 7/2");
  vm.runInContext(`pccmQuickMultiClear(null, "class")`, context);
  assert.equal(selectedClasses(document), "");
});

test("menu lớp có hàng nút trợ giúp, menu môn (chọn một) thì không", () => {
  const { document, context } = setup();
  const html = vm.runInContext(`
    pccmQuickRenderMulti("class", [{value:"6/1"},{value:"6/2"},{value:"7/1"}], [], "");
    pccmPopulateQuickMultiMenu("class");
    pccmQuickRenderMulti("subject", [{value:"Toán"},{value:"Văn"}], [], "");
    pccmPopulateQuickMultiMenu("subject");
    JSON.stringify({ cls: document.getElementById("pccmQuickClassMulti_menu").innerHTML, sub: document.getElementById("pccmQuickSubjectMulti_menu").innerHTML });
  `, context);
  const out = JSON.parse(html);
  assert.match(out.cls, /Tất cả/);
  assert.match(out.cls, /Khối 6/);
  assert.match(out.cls, /Khối 7/);
  assert.match(out.cls, /Bỏ chọn/);
  assert.doesNotMatch(out.sub, /pccm-multi-tools/);
});

test("Môn học (chọn một) vẫn thay thế và đóng menu", () => {
  const { document, context } = setup();
  document.boxes.pccmQuickSubjectMulti.classList.add("open");
  click(context, "subject", "Toán");
  click(context, "subject", "Văn");
  assert.equal(document.byId.pccmQuickMon.value, "Văn");
  assert.ok(document.closed.includes("pccmQuickSubjectMulti"));
});
