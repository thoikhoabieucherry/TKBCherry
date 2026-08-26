// 23/08: Đồng bộ Môn học -> Tiết chuẩn / Phân công khi đổi tên, đổi mã, tạo mới.
//   1. Đổi tên/mã một môn ở bảng Môn học: Tiết chuẩn giữ nguyên dòng (số tiết,
//      giới hạn, vị trí) chỉ đổi khoá; Phân công/phòng/TKB đổi khoá theo.
//   2. Dòng Tiết chuẩn luôn theo thứ tự Khối rồi thứ tự Môn học (môn mới nằm
//      cuối MỖI khối, không rơi xuống cuối cả bảng).
//   3. Môn vừa tạo có Tiết chuẩn mặc định ngay và Phân công hiển thị được
//      (cache tra cứu không còn dính dữ liệu cũ).
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

function fixture(){
  return {
    khoi:[{id:"K6", ten:"Khối 6"}, {id:"K7", ten:"Khối 7"}],
    lop:[
      {id:"L001", ten:"6A1", ten2:"6A1", khoi:"Khối 6"},
      {id:"L002", ten:"7A1", ten2:"7A1", khoi:"Khối 7"}
    ],
    giaovien:[{magv:"GV01", hodem:"Nguyễn", ten:"An"}, {magv:"GV02", hodem:"Trần", ten:"Bình"}],
    monhoc:[
      {id:"MH1", ten:"Toán", ma:"Toán", caphoc:"THCS"},
      {id:"MH2", ten:"Ngoại ngữ", ma:"", caphoc:"THCS"},
      {id:"MH3", ten:"Văn", ma:"Văn", caphoc:"THCS"}
    ],
    mon:[
      {id:"TC1", khoi:"Khối 6", ten:"Toán", sotiet:"4", gioihan:"2"},
      {id:"TC2", khoi:"Khối 6", ten:"Ngoại ngữ", sotiet:"3", gioihan:"2"},
      {id:"TC3", khoi:"Khối 6", ten:"Văn", sotiet:"4", gioihan:"2"},
      {id:"TC4", khoi:"Khối 7", ten:"Toán", sotiet:"4", gioihan:"2"},
      {id:"TC5", khoi:"Khối 7", ten:"Ngoại ngữ", sotiet:"3", gioihan:"2"},
      {id:"TC6", khoi:"Khối 7", ten:"Văn", sotiet:"4", gioihan:"2"}
    ],
    phong:[{id:"P1", ten:"Phòng LAB", tinhtrang:"Ngoại ngữ"}],
    pccmMatrix:{"6A1|Ngoại ngữ":"GV01", "6A1|Toán":"GV02", "7A1|Ngoại ngữ":"GV01"},
    pccmTietMatrix:{"6A1|Ngoại ngữ":"5"},
    pccmGioihanMatrix:{},
    pccmRoomMatrix:{"6A1|Ngoại ngữ":"Phòng LAB"},
    tkb:{"L001":{"thu2":{"sang":["Ngoại ngữ", {mon:"Ngoại ngữ", fixed:true}, "Toán", "", ""], "chieu":["","","","",""]}}},
    tkbLessonTeachers:{"L001|Ngoại ngữ":"GV01"},
    tkbConstraints:{subject:{"Ngoại ngữ":{byClass:{"L001":{lessonBlocks:{"2":{min:1}}}}}}}
  };
}

function runWithInputs(context, inputs, code){
  context.__elements.clear();
  // khung DOM tối thiểu cho renderSectionInto / closeModal
  context.__elements.set("section-content", {innerHTML:""});
  context.__elements.set("modal", {style:{}});
  context.__elements.set("modal-title", {innerText:""});
  context.__elements.set("modal-body", {innerHTML:""});
  Object.entries(inputs).forEach(([id, value]) => context.__elements.set(id, {value}));
  return JSON.parse(vm.runInContext(code, context));
}

test("renaming a subject in Môn học keeps its Tiết chuẩn rows and moves every reference to the new key", () => {
  const context = loadApp();
  const result = runWithInputs(context, {
    "edit_monhoc_1_caphoc":"THCS",
    "edit_monhoc_1_ten":"Tiếng Anh",
    "edit_monhoc_1_ma":"",
    "edit_monhoc_1_ma2":""
  }, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    // ensureDataShape luôn reset pccmRoomMatrix → gán lại sau đó như người dùng chọn phòng
    DATA.pccmRoomMatrix = {"6A1|Ngoại ngữ":"Phòng LAB"};
    tableSaveEdit("monhoc", 1);
    JSON.stringify({
      monhoc:DATA.monhoc.map(m=>m.ten),
      mon:DATA.mon.map(m=>[m.khoi, m.ten, m.sotiet, m.gioihan]),
      pccm:DATA.pccmMatrix, tiet:DATA.pccmTietMatrix, room:DATA.pccmRoomMatrix,
      phong:DATA.phong.map(p=>p.tinhtrang),
      tkb:DATA.tkb.L001.thu2.sang,
      lt:DATA.tkbLessonTeachers,
      constraintKeys:Object.keys(DATA.tkbConstraints.subject)
    });
  `);
  assert.deepEqual(result.monhoc, ["Toán", "Tiếng Anh", "Văn"]);
  // dòng cũ giữ nguyên số tiết/giới hạn và vị trí (không có dòng "1/1" mới)
  assert.deepEqual(result.mon, [
    ["Khối 6", "Toán", "4", "2"], ["Khối 6", "Tiếng Anh", "3", "2"], ["Khối 6", "Văn", "4", "2"],
    ["Khối 7", "Toán", "4", "2"], ["Khối 7", "Tiếng Anh", "3", "2"], ["Khối 7", "Văn", "4", "2"]
  ]);
  assert.deepEqual(result.pccm, {"6A1|Tiếng Anh":"GV01", "6A1|Toán":"GV02", "7A1|Tiếng Anh":"GV01"});
  assert.deepEqual(result.tiet, {"6A1|Tiếng Anh":"5"});
  assert.deepEqual(result.room, {"6A1|Tiếng Anh":"Phòng LAB"});
  assert.deepEqual(result.phong, ["Tiếng Anh"]);
  assert.deepEqual(result.tkb, ["Tiếng Anh", {mon:"Tiếng Anh", fixed:true}, "Toán", "", ""]);
  assert.deepEqual(result.lt, {"L001|Tiếng Anh":"GV01"});
  assert.deepEqual(result.constraintKeys, ["Tiếng Anh"]);
});

test("changing a subject code re-keys Tiết chuẩn and Phân công without touching other subjects", () => {
  const context = loadApp();
  const result = runWithInputs(context, {
    "edit_monhoc_0_caphoc":"THCS",
    "edit_monhoc_0_ten":"Toán",
    "edit_monhoc_0_ma":"TO",
    "edit_monhoc_0_ma2":""
  }, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    tableSaveEdit("monhoc", 0);
    JSON.stringify({
      mon:DATA.mon.map(m=>[m.khoi, m.ten, m.sotiet]),
      pccm:DATA.pccmMatrix,
      tkb:DATA.tkb.L001.thu2.sang
    });
  `);
  assert.deepEqual(result.mon, [
    ["Khối 6", "TO", "4"], ["Khối 6", "Ngoại ngữ", "3"], ["Khối 6", "Văn", "4"],
    ["Khối 7", "TO", "4"], ["Khối 7", "Ngoại ngữ", "3"], ["Khối 7", "Văn", "4"]
  ]);
  assert.deepEqual(result.pccm, {"6A1|Ngoại ngữ":"GV01", "6A1|TO":"GV02", "7A1|Ngoại ngữ":"GV01"});
  assert.deepEqual(result.tkb, ["Ngoại ngữ", {mon:"Ngoại ngữ", fixed:true}, "Toán", "", ""]);
});

test("a new subject gets default Tiết chuẩn at the end of EACH grade and shows up in Phân công", () => {
  const context = loadApp();
  const result = runWithInputs(context, {
    "f_caphoc":"THCS",
    "f_ten":"Bản ngữ",
    "f_ma":"BNgữ",
    "f_ma2":""
  }, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    // tab "Môn học" của Phân công liệt kê mọi môn có Tiết chuẩn > 0 ở cột trái
    PCCM_TAB="monhoc";
    PCCM_SELECTED_CLASS="6A1";
    const beforeHtml = renderPCCM();
    CURRENT_SECTION="monhoc"; EDIT_INDEX=-1;
    saveData();
    const afterHtml = renderPCCM();
    JSON.stringify({
      mon:DATA.mon.map(m=>[m.khoi, m.ten, m.sotiet, m.gioihan]),
      beforeHasNew:beforeHtml.includes("setPCCMSelectedSubject('BNgữ')"),
      afterHasNew:afterHtml.includes("setPCCMSelectedSubject('BNgữ')"),
      positive:monHasPositiveTietChuanAnyKhoi({key:"BNgữ", ten:"Bản ngữ", ma2:""})
    });
  `);
  assert.deepEqual(result.mon, [
    ["Khối 6", "Toán", "4", "2"], ["Khối 6", "Ngoại ngữ", "3", "2"], ["Khối 6", "Văn", "4", "2"], ["Khối 6", "BNgữ", "1", "1"],
    ["Khối 7", "Toán", "4", "2"], ["Khối 7", "Ngoại ngữ", "3", "2"], ["Khối 7", "Văn", "4", "2"], ["Khối 7", "BNgữ", "1", "1"]
  ]);
  assert.equal(result.beforeHasNew, false);
  assert.equal(result.afterHasNew, true);
  assert.equal(result.positive, true);
});

test("Tiết chuẩn sync orders rows by grade then Môn học order even when rows were appended at the end", () => {
  const context = loadApp();
  const data = fixture();
  // dòng Khối 6 của "Văn" bị đẩy xuống cuối cả bảng (như hành vi cũ)
  data.mon = [data.mon[0], data.mon[1], data.mon[3], data.mon[4], data.mon[5], data.mon[2]];
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(data)};
    ensureDataShape();
    ensureTietChuanSyncedFromMonHoc();
    JSON.stringify(DATA.mon.map(m=>m.khoi + "|" + m.ten));
  `, context));
  assert.deepEqual(result, [
    "Khối 6|Toán", "Khối 6|Ngoại ngữ", "Khối 6|Văn",
    "Khối 7|Toán", "Khối 7|Ngoại ngữ", "Khối 7|Văn"
  ]);
});
