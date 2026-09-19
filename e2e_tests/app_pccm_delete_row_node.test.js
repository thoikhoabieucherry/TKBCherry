// 13/09: Phân công — chọn ô ở 2 cột đầu của một dòng (Shift/Ctrl chọn nhiều dòng) rồi bấm
// Delete = xóa dòng phân công, sau khi xác nhận:
//   - tab Giáo viên (Môn học, Lớp): gỡ GV đang chọn khỏi ô Lớp|Môn;
//   - tab Lớp (Môn học, Giáo viên): bỏ phân công Lớp|Môn đó.
// Chỉ chọn ô Số tiết/Giới hạn thì Delete vẫn chỉ xóa giá trị ô như cũ; tab Môn học không đổi.
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
  const document = {
    addEventListener(){}, removeEventListener(){},
    getElementById(){ return null; },
    // pccmIsActive(): bảng phân công đang hiện
    querySelector(sel){ return sel === ".pccm-copy-cell[data-r][data-c]" ? {} : null; },
    querySelectorAll(){ return []; },
    documentElement:{ appendChild(){} },
    body:{ appendChild(){}, insertAdjacentHTML(){} }
  };
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
    confirm(){ return true; }, alert(){}, prompt(){ return null; },
    indexedDB:{ open(){ return {}; } }, FileReader:function(){}, Blob, TextEncoder, TextDecoder
  });
  vm.runInContext(APP_SOURCE, context, { filename:APP_PATH });
  context.__popups = [];
  vm.runInContext(`showBottomPopup = function(msg, type){ __popups.push({msg, type}); };`, context);
  return context;
}

const FIXTURE = {
  lop:[
    { id:"L001", ten:"6/1", ten2:"6/1", khoi:"Khối 6" },
    { id:"L002", ten:"6/2", ten2:"6/2", khoi:"Khối 6" },
    { id:"L003", ten:"7/1", ten2:"7/1", khoi:"Khối 7" }
  ],
  giaovien:[
    { magv:"GV01", hodem:"Nguyễn Văn", ten:"An" },
    { magv:"GV02", hodem:"Trần Thị", ten:"Bình" }
  ],
  monhoc:[{ id:"MH1", ten:"Toán", ma:"TOAN" }, { id:"MH2", ten:"Ngữ văn", ma:"VAN" }],
  mon:[
    { id:"TC1", khoi:"Khối 6", ten:"Toán", sotiet:"4", gioihan:"2" },
    { id:"TC2", khoi:"Khối 7", ten:"Toán", sotiet:"4", gioihan:"2" },
    { id:"TC3", khoi:"Khối 6", ten:"Ngữ văn", sotiet:"4", gioihan:"2" },
    { id:"TC4", khoi:"Khối 7", ten:"Ngữ văn", sotiet:"4", gioihan:"2" }
  ],
  phong:[], pccmMatrix:{}, pccmTietMatrix:{}, pccmGioihanMatrix:{}, pccmRoomMatrix:{}
};

// GV01: 6/1 Toán, 6/2 Toán, 7/1 Ngữ văn (dòng 0,1,2 ở tab Giáo viên); GV02: 6/1 Ngữ văn.
function setup(tab = "giaovien"){
  const context = loadApp();
  vm.runInContext(`
    DATA = ${JSON.stringify(FIXTURE)};
    ensureDataShape();
    var __saves = 0;
    saveStore = function(){ __saves += 1; return Promise.resolve(true); };
    var __mons = buildPCCMMonList();
    var __m = t => __mons.find(m => m.ten === t);
    pccmSetTeachersNoSave("6/1", __m("Toán"), ["GV01"]);
    pccmSetTeachersNoSave("6/2", __m("Toán"), ["GV01"]);
    pccmSetTeachersNoSave("7/1", __m("Ngữ văn"), ["GV01"]);
    pccmSetTeachersNoSave("6/1", __m("Ngữ văn"), ["GV02"]);
    var __base = __mons.filter(m => monHasPositiveTietChuanAnyKhoi(m));
    PCCM_TAB = "giaovien";
    PCCM_SELECTED_GV = "GV01";
    renderPCCM_ByTeacher(["GV01", "GV02"], __base, ["6/1", "6/2", "7/1"]);
    PCCM_TAB = "lop";
    PCCM_SELECTED_CLASS = "6/1";
    renderPCCM_ByClass(["6/1", "6/2", "7/1"], __base);
    PCCM_TAB = ${JSON.stringify(tab)};
  `, context);
  return context;
}

function teacherRows(context){
  return JSON.parse(vm.runInContext(`JSON.stringify(PCCM_TEACHER_EDIT_CACHE.rows.map(r => r.cls + " " + r.monObj.ten))`, context));
}

function classRows(context){
  return JSON.parse(vm.runInContext(`JSON.stringify(PCCM_CLASS_EDIT_CACHE.mons.map(m => PCCM_CLASS_EDIT_CACHE.cls + " " + m.ten))`, context));
}

function assignments(context){
  return JSON.parse(vm.runInContext(`JSON.stringify((() => {
    const out = {};
    ["6/1", "6/2", "7/1"].forEach(c => buildPCCMMonList().forEach(m => {
      const v = pccmGetTeacher(c, m);
      if (v) out[c + " " + m.ten] = v;
    }));
    return out;
  })())`, context));
}

function pressDelete(context, selection, target = { tagName:"BODY" }){
  vm.runInContext(`PCCM_CELL_SELECTION = new Set(${JSON.stringify(selection)}); PCCM_CELL_ANCHOR = {r:0, c:0};`, context);
  let prevented = false;
  context.pccmGlobalKeyDown({ key:"Delete", target, ctrlKey:false, metaKey:false, altKey:false, preventDefault(){ prevented = true; } });
  return prevented;
}

const ALL = { "6/1 Toán":"GV01", "6/2 Toán":"GV01", "7/1 Ngữ văn":"GV01", "6/1 Ngữ văn":"GV02" };

test("dựng bảng tab Giáo viên đúng các dòng của GV01", () => {
  const context = setup();
  assert.deepEqual(teacherRows(context), ["6/1 Toán", "6/2 Toán", "7/1 Ngữ văn"]);
  assert.deepEqual(assignments(context), ALL);
});

test("Shift chọn ô Môn học 2 dòng + Delete = xóa 2 phân công của GV, giữ phân công khác", () => {
  const context = setup();
  const asked = [];
  context.confirm = (msg) => { asked.push(msg); return true; };
  const prevented = pressDelete(context, ["0,0", "1,0"]);

  assert.equal(prevented, true);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Xóa 2 phân công đã chọn của GV GV01/);
  assert.match(asked[0], /6\/1 - /);
  assert.match(asked[0], /6\/2 - /);
  assert.deepEqual(assignments(context), { "7/1 Ngữ văn":"GV01", "6/1 Ngữ văn":"GV02" });
  assert.equal(vm.runInContext("__saves", context), 1, "lưu kho đúng 1 lần");
  assert.equal(vm.runInContext("PCCM_CELL_SELECTION.size", context), 0, "bỏ chọn sau khi xóa");
  assert.equal(context.__popups.at(-1).type, "ok");
});

test("chọn cả một dòng (ô Lớp..Giới hạn) -> hỏi đúng tên phân công rồi xóa", () => {
  const context = setup();
  const asked = [];
  context.confirm = (msg) => { asked.push(msg); return true; };
  pressDelete(context, ["2,1", "2,2", "2,3"]);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Xóa phân công 7\/1 - .* của GV GV01\?$/);
  assert.deepEqual(assignments(context), { "6/1 Toán":"GV01", "6/2 Toán":"GV01", "6/1 Ngữ văn":"GV02" });
});

test("bấm Hủy ở hộp xác nhận -> không đổi gì, không rơi xuống xóa giá trị ô", () => {
  const context = setup();
  context.confirm = () => false;
  let cleared = 0;
  context.pccmClearSelectedCells = () => { cleared += 1; };
  pressDelete(context, ["0,0"]);
  assert.deepEqual(assignments(context), ALL);
  assert.equal(vm.runInContext("__saves", context), 0);
  assert.equal(cleared, 0);
});

test("chỉ chọn ô Số tiết/Giới hạn -> Delete vẫn chỉ xóa giá trị ô (không xóa phân công)", () => {
  const context = setup();
  let asked = 0;
  context.confirm = () => { asked += 1; return true; };
  let cleared = 0;
  context.pccmClearSelectedCells = () => { cleared += 1; };
  pressDelete(context, ["0,2", "1,3"]);
  assert.equal(asked, 0);
  assert.equal(cleared, 1);
  assert.deepEqual(assignments(context), ALL);
});

test("Delete khi <select> Môn/Lớp còn giữ focus vẫn xóa phân công", () => {
  const context = setup();
  context.confirm = () => true;
  pressDelete(context, ["1,0"], { tagName:"SELECT" });
  assert.equal(assignments(context)["6/2 Toán"], undefined);
  assert.equal(assignments(context)["6/1 Toán"], "GV01");
});

test("tab Môn học không dùng luật xóa dòng", () => {
  const context = setup("monhoc");
  let asked = 0;
  context.confirm = () => { asked += 1; return true; };
  vm.runInContext(`PCCM_CELL_SELECTION = new Set(["0,0", "0,1"]);`, context);
  assert.equal(vm.runInContext("pccmDeleteSelectedAssignments()", context), false);
  assert.equal(asked, 0);
  assert.deepEqual(assignments(context), ALL);
});

test("tab Lớp: dựng bảng 6/1 đúng các môn đã phân công", () => {
  const context = setup("lop");
  assert.deepEqual(classRows(context), ["6/1 Toán", "6/1 Ngữ văn"]);
});

test("tab Lớp: chọn ô Môn học + Delete = bỏ phân công Lớp|Môn đó, giữ môn khác và lớp khác", () => {
  const context = setup("lop");
  const asked = [];
  context.confirm = (msg) => { asked.push(msg); return true; };
  const prevented = pressDelete(context, ["0,0"]);
  assert.equal(prevented, true);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Xóa phân công .*\(GV01\) của lớp 6\/1\?$/);
  assert.deepEqual(assignments(context), { "6/2 Toán":"GV01", "7/1 Ngữ văn":"GV01", "6/1 Ngữ văn":"GV02" });
  assert.equal(vm.runInContext("__saves", context), 1);
  assert.equal(vm.runInContext("PCCM_CELL_SELECTION.size", context), 0);
  assert.equal(context.__popups.at(-1).type, "ok");
});

test("tab Lớp: Shift chọn ô Giáo viên 2 dòng + Delete = bỏ cả 2 phân công của lớp", () => {
  const context = setup("lop");
  const asked = [];
  context.confirm = (msg) => { asked.push(msg); return true; };
  pressDelete(context, ["0,1", "1,1"], { tagName:"SELECT" });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Xóa 2 phân công đã chọn của lớp 6\/1/);
  assert.match(asked[0], /\(GV01\)/);
  assert.match(asked[0], /\(GV02\)/);
  assert.deepEqual(assignments(context), { "6/2 Toán":"GV01", "7/1 Ngữ văn":"GV01" });
});

test("tab Lớp: ô cũ nhiều GV (GV01, GV02) -> bỏ hết cả ô", () => {
  const context = setup("lop");
  vm.runInContext(`DATA.pccmMatrix[pccmTeacherPrimaryKey("6/1", PCCM_CLASS_EDIT_CACHE.mons[0])] = "GV01, GV02";`, context);
  context.confirm = () => true;
  pressDelete(context, ["0,1"]);
  assert.equal(assignments(context)["6/1 Toán"], undefined);
  assert.equal(assignments(context)["6/1 Ngữ văn"], "GV02");
});

test("tab Lớp: bấm Hủy -> không đổi; chỉ chọn Số tiết/Giới hạn -> xóa giá trị ô như cũ", () => {
  const context = setup("lop");
  let cleared = 0;
  context.pccmClearSelectedCells = () => { cleared += 1; };
  context.confirm = () => false;
  pressDelete(context, ["1,0"]);
  assert.deepEqual(assignments(context), ALL);
  assert.equal(cleared, 0);

  let asked = 0;
  context.confirm = () => { asked += 1; return true; };
  pressDelete(context, ["0,2", "1,3"]);
  assert.equal(asked, 0);
  assert.equal(cleared, 1);
  assert.deepEqual(assignments(context), ALL);
});

test("tab Lớp: dòng do Dạy ghép quản lý -> bỏ qua, cảnh báo", () => {
  const context = setup("lop");
  let asked = 0;
  context.confirm = () => { asked += 1; return true; };
  vm.runInContext(`dayGhepOwnedKeySet = () => new Set(["6/1|" + String(PCCM_CLASS_EDIT_CACHE.mons[0].key).toLowerCase()]);`, context);
  pressDelete(context, ["0,0"]);
  assert.equal(asked, 0);
  assert.equal(assignments(context)["6/1 Toán"], "GV01");
  assert.equal(context.__popups.at(-1).type, "warning");
});

test("dòng do Dạy ghép quản lý -> bỏ qua, cảnh báo, không hỏi xóa", () => {
  const context = setup();
  let asked = 0;
  context.confirm = () => { asked += 1; return true; };
  vm.runInContext(`dayGhepOwnedKeySet = () => new Set(["6/1|" + String(PCCM_TEACHER_EDIT_CACHE.rows[0].monObj.key).toLowerCase()]);`, context);
  pressDelete(context, ["0,0"]);
  assert.equal(asked, 0);
  assert.equal(assignments(context)["6/1 Toán"], "GV01");
  assert.equal(context.__popups.at(-1).type, "warning");
  assert.match(context.__popups.at(-1).msg, /Dạy ghép/);
});
