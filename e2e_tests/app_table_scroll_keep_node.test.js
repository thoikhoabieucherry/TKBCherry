// 24/08: Kích đúp một dòng ở bảng dữ liệu (Khối/Lớp/Giáo viên/Môn học) để sửa
// tại chỗ không được kéo bảng về đầu. renderSectionInto vẽ lại cả
// #section-content nên khung cuộn .data-table-wrap bị dựng mới với
// scrollTop = 0; phải nhớ và trả lại chỗ đang cuộn của đúng mục đó.
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

function loadApp(){
  const localStorage = storageStub();
  const sessionStorage = storageStub();
  const elements = new Map();
  const document = {
    addEventListener(){},
    removeEventListener(){},
    getElementById(id){ return elements.get(id) || null; },
    querySelectorAll(){ return []; },
    querySelector(){ return null; },
    documentElement:{appendChild(){}},
    body:{appendChild(){}, insertAdjacentHTML(){}}
  };
  const location = { href:"http://localhost/app.html?sid=default", protocol:"http:", hostname:"localhost" };
  const window = {
    document, localStorage, sessionStorage, location,
    history:{replaceState(){}}, navigator:{},
    addEventListener(){}, removeEventListener(){},
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  window.window = window;
  const context = vm.createContext({
    window, document, localStorage, sessionStorage, location,
    history:window.history, navigator:window.navigator,
    URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval,
    confirm(){ return false; }, alert(){}, prompt(){ return null; },
    indexedDB:{open(){ return {}; }}, FileReader:function(){}, Blob, TextEncoder, TextDecoder
  });
  vm.runInContext(APP_SOURCE, context, {filename:APP_PATH});
  context.__elements = elements;
  return context;
}

// Khung cuộn giả lập đúng hành vi trình duyệt: gán innerHTML là dựng lại phần
// tử con, nên khung cuộn mới luôn bắt đầu ở scrollTop = 0.
function containerStub(){
  const calls = { scrollIntoView: 0 };
  let html = "";
  let wrap = null;
  const makeWrap = () => ({
    scrollTop: 0,
    scrollLeft: 0,
    querySelector(selector){
      if(selector !== "tr.row-editing" || !html.includes("row-editing")) return null;
      return { scrollIntoView(){ calls.scrollIntoView += 1; } };
    }
  });
  return {
    calls,
    get html(){ return html; },
    get wrap(){ return wrap; },
    get innerHTML(){ return html; },
    set innerHTML(value){
      html = String(value);
      wrap = makeWrap();
    },
    querySelector(selector){
      const className = String(selector || "").replace(/^\./, "");
      if(!wrap || !html.includes(className)) return null;
      return wrap;
    }
  };
}

function fixture(rows){
  return {
    khoi:[{id:"K6", ten:"Khối 6"}],
    lop:Array.from({length:rows}, (_, i) => ({
      id:`L${String(i + 1).padStart(3, "0")}`,
      ten:`6/${i + 1}`,
      ten2:`6/${i + 1}`,
      khoi:"Khối 6",
      diadiem:"Địa điểm 1"
    })),
    giaovien:[{magv:"GV01", hodem:"Nguyễn", ten:"An"}],
    monhoc:[], mon:[], phong:[],
    pccmMatrix:{}, pccmTietMatrix:{}, pccmGioihanMatrix:{}, pccmRoomMatrix:{},
    tkb:{}, tkbConstraints:{}
  };
}

function setup(rows = 54){
  const context = loadApp();
  const container = containerStub();
  context.__elements.set("section-content", container);
  vm.runInContext(`DATA=${JSON.stringify(fixture(rows))}; ensureDataShape();`, context);
  return { context, container };
}

test("double-clicking a row deep in the class table keeps the table where it was scrolled", () => {
  const { context, container } = setup();
  vm.runInContext(`renderSectionInto("lop", "section-content", document);`, context);
  container.wrap.scrollTop = 1180;
  container.wrap.scrollLeft = 24;

  vm.runInContext(`tableBeginEdit("lop", 41);`, context);

  assert.ok(container.html.includes("row-editing"), "dòng 42 phải vào chế độ sửa");
  assert.equal(container.wrap.scrollTop, 1180);
  assert.equal(container.wrap.scrollLeft, 24);
  assert.equal(container.calls.scrollIntoView, 1);
});

test("selecting a row with a single click keeps the scroll position too", () => {
  const { context, container } = setup();
  vm.runInContext(`renderSectionInto("lop", "section-content", document);`, context);
  container.wrap.scrollTop = 640;

  vm.runInContext(`tableRowClick({detail:1, target:null}, "lop", 30);`, context);

  assert.ok(container.html.includes("row-selected"), "dòng 31 phải được chọn");
  assert.equal(container.wrap.scrollTop, 640);
  assert.equal(container.calls.scrollIntoView, 0);
});

test("switching to another section starts that table at the top", () => {
  const { context, container } = setup();
  vm.runInContext(`renderSectionInto("lop", "section-content", document);`, context);
  container.wrap.scrollTop = 1180;

  vm.runInContext(`renderSectionInto("giaovien", "section-content", document);`, context);

  assert.ok(container.html.includes("data-table-wrap-giaovien"));
  assert.equal(container.wrap.scrollTop, 0);
});
