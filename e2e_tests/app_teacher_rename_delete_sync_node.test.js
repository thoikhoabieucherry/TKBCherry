// 30/08: Đồng bộ các bảng ở trang Dữ liệu (web/app.js)
//   1. Đổi MÃ GV (hoặc GV chưa có mã đổi tên) → Phân công, Dạy ghép, GV theo tiết,
//      ô TKB có gv, Yêu cầu (khoá theo mã) đổi theo.
//   2. Đổi tên GV (giữ mã) → bảng Phân công thấy tên mới ngay (bộ đệm tên GV so theo
//      tham chiếu mảng nên trước đây kẹt tên cũ tới khi tải lại trang).
//   3. Xoá môn ở Môn học / xoá dòng Tiết chuẩn → các tiết của môn đó trên TKB bị gỡ,
//      KỂ CẢ tiết cố định (trước đây nằm lại, phải sang Sắp xếp gỡ cố định rồi xoá tay).
//   4. saveStore ghi mốc _lastModified để trang Sắp xếp (tab khác) nhận ra bản mới.
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
    confirm(){ return true; }, alert(){}, prompt(){ return null; },
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
    giaovien:[
      {id:"GV1", magv:"GV01", hodem:"Nguyễn", ten:"An"},
      {id:"GV2", magv:"GV02", hodem:"Trần", ten:"Bình"},
      {id:"GV3", magv:"", hodem:"Lê", ten:"Cường"}
    ],
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
    pccmMatrix:{"6A1|Ngoại ngữ":"GV01", "6A1|Toán":"GV02", "7A1|Ngoại ngữ":"GV01, GV02", "7A1|Toán":"Lê Cường", "6A1|Văn":"GV01"},
    dayGhep:[{id:"DG1", lop:["6A1"], mon:["Toán"], gv:["GV01", "GV02"], sotiet:"1", gioihan:"1", viettat:"TG", ten:"TG"}],
    tkb:{
      "L001":{"thu2":{"sang":[{mon:"Toán", gv:"GV02"}, {mon:"Ngoại ngữ", fixed:true}, "Ngoại ngữ", "OFF", "Văn"], "chieu":["Toán","","","",""]}},
      "L002":{"thu2":{"sang":["Toán", {mon:"Toán", fixed:true}, "Ngoại ngữ", "", ""], "chieu":["","","","",""]}}
    },
    tkbLessonTeachers:{"L001|Toán":"GV02", "L001|Ngoại ngữ":"GV01"},
    tkbConstraints:{
      teacher:{"GV01":{maxPerDay:5}, "GV02":{maxPerDay:4}},
      fixedOff:{teacher:{"GV02":{"thu2|sang|0":true}}},
      groups:{teacher:{all:{name:"Tất cả", items:["GV01", "GV02"]}}}
    }
  };
}

function run(context, inputs, code){
  context.__elements.clear();
  context.__elements.set("section-content", {innerHTML:""});
  context.__elements.set("modal", {style:{}});
  context.__elements.set("modal-title", {innerText:""});
  context.__elements.set("modal-body", {innerHTML:""});
  Object.entries(inputs || {}).forEach(([id, value]) => context.__elements.set(id, {value}));
  return JSON.parse(vm.runInContext(code, context));
}

test("changing a teacher code moves every reference (Phân công lists, Dạy ghép, per-lesson teachers, TKB cell gv, rules)", () => {
  const context = loadApp();
  const r = run(context, {
    "edit_giaovien_1_hodem":"Trần",
    "edit_giaovien_1_ten":"Bình",
    "edit_giaovien_1_magv":"GV2B",
    "edit_giaovien_1_magv2":""
  }, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    tableSaveEdit("giaovien", 1);
    JSON.stringify({
      pccm:DATA.pccmMatrix,
      ghep:DATA.dayGhep[0].gv,
      lt:DATA.tkbLessonTeachers,
      cellGv:DATA.tkb.L001.thu2.sang[0].gv,
      teacherRuleKeys:Object.keys(DATA.tkbConstraints.teacher),
      fixedOffKeys:Object.keys(DATA.tkbConstraints.fixedOff.teacher),
      groupItems:DATA.tkbConstraints.groups.teacher.all.items,
      name:pccmTeacherName("GV2B")
    });
  `);
  assert.deepEqual(r.pccm, {"6A1|Ngoại ngữ":"GV01", "6A1|Toán":"GV2B", "7A1|Ngoại ngữ":"GV01, GV2B", "7A1|Toán":"Lê Cường", "6A1|Văn":"GV01"});
  assert.deepEqual(r.ghep, ["GV01", "GV2B"]);
  assert.deepEqual(r.lt, {"L001|Toán":"GV2B", "L001|Ngoại ngữ":"GV01"});
  assert.equal(r.cellGv, "GV2B");
  assert.deepEqual(r.teacherRuleKeys.sort(), ["GV01", "GV2B"]);
  assert.deepEqual(r.fixedOffKeys, ["GV2B"]);
  assert.deepEqual(r.groupItems, ["GV01", "GV2B"]);
  assert.equal(r.name, "Trần Bình");
});

test("renaming a teacher (same code) keeps Phân công keys and shows the new name immediately", () => {
  const context = loadApp();
  const r = run(context, {
    "edit_giaovien_0_hodem":"Nguyễn Văn",
    "edit_giaovien_0_ten":"An Khang",
    "edit_giaovien_0_magv":"GV01",
    "edit_giaovien_0_magv2":""
  }, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    const before = pccmTeacherName("GV01");   // làm nóng bộ đệm tên
    tableSaveEdit("giaovien", 0);
    JSON.stringify({before, after:pccmTeacherName("GV01"), hint:pccmTeacherHint("GV01"), pccm:DATA.pccmMatrix, stamp:typeof DATA._lastModified});
  `);
  assert.equal(r.before, "Nguyễn An");
  assert.equal(r.after, "Nguyễn Văn An Khang");
  assert.equal(r.hint, "GV01 - Nguyễn Văn An Khang");
  assert.deepEqual(r.pccm, fixture().pccmMatrix);
  assert.equal(r.stamp, "number");
});

test("a teacher stored by full name (no code) follows a rename and then an assigned code", () => {
  const context = loadApp();
  const r1 = run(context, {
    "edit_giaovien_2_hodem":"Lê",
    "edit_giaovien_2_ten":"Cường Em",
    "edit_giaovien_2_magv":"",
    "edit_giaovien_2_magv2":""
  }, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    tableSaveEdit("giaovien", 2);
    JSON.stringify({pccm:DATA.pccmMatrix["7A1|Toán"]});
  `);
  assert.equal(r1.pccm, "Lê Cường Em");
  const r2 = run(context, {
    "edit_giaovien_2_hodem":"Lê",
    "edit_giaovien_2_ten":"Cường Em",
    "edit_giaovien_2_magv":"CUONG",
    "edit_giaovien_2_magv2":""
  }, `
    tableSaveEdit("giaovien", 2);
    JSON.stringify({pccm:DATA.pccmMatrix["7A1|Toán"]});
  `);
  assert.equal(r2.pccm, "CUONG");
});

test("deleting a subject in Môn học removes its TKB cells in every class, fixed ones included", () => {
  const context = loadApp();
  const r = run(context, {}, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    deleteRow("monhoc", 1);   // Ngoại ngữ (confirm → OK cả hai lần)
    JSON.stringify({
      monhoc:DATA.monhoc.map(m=>m.ten),
      l1:DATA.tkb.L001.thu2.sang, l2:DATA.tkb.L002.thu2.sang,
      lt:DATA.tkbLessonTeachers,
      pccmKeys:Object.keys(DATA.pccmMatrix).sort()
    });
  `);
  assert.deepEqual(r.monhoc, ["Toán", "Văn"]);
  assert.deepEqual(r.l1, [{mon:"Toán", gv:"GV02"}, "", "", "OFF", "Văn"]);
  assert.deepEqual(r.l2, ["Toán", {mon:"Toán", fixed:true}, "", "", ""]);
  assert.deepEqual(r.lt, {"L001|Toán":"GV02"});
  assert.deepEqual(r.pccmKeys, ["6A1|Toán", "6A1|Văn", "7A1|Toán"]);
});

test("deleting a Tiết chuẩn row only clears that subject in classes of that grade", () => {
  const context = loadApp();
  const r = run(context, {}, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    tcDelete("Khối 7", "Toán");
    JSON.stringify({
      mon:DATA.mon.map(m=>m.khoi+"|"+m.ten),
      l1:DATA.tkb.L001.thu2.sang, l1c:DATA.tkb.L001.thu2.chieu, l2:DATA.tkb.L002.thu2.sang,
      pccmKeys:Object.keys(DATA.pccmMatrix).sort()
    });
  `);
  // (renderTietChuanPage → ensureTietChuanSyncedFromMonHoc tạo lại dòng 1/1 vì môn vẫn còn ở Môn học — hành vi sẵn có)
  assert.deepEqual(r.l1, [{mon:"Toán", gv:"GV02"}, {mon:"Ngoại ngữ", fixed:true}, "Ngoại ngữ", "OFF", "Văn"]);
  assert.deepEqual(r.l1c, ["Toán", "", "", "", ""]);
  assert.deepEqual(r.l2, ["", "", "Ngoại ngữ", "", ""]);
  assert.deepEqual(r.pccmKeys, ["6A1|Ngoại ngữ", "6A1|Toán", "6A1|Văn", "7A1|Ngoại ngữ"]);
});

test("deleting several selected subjects at once also clears their TKB cells", () => {
  const context = loadApp();
  const r = run(context, {}, `
    DATA=${JSON.stringify(fixture())};
    ensureDataShape();
    TABLE_SELECTION.monhoc = new Set([0, 2]);   // Toán + Văn
    deleteSelectedRows("monhoc");
    JSON.stringify({monhoc:DATA.monhoc.map(m=>m.ten), l1:DATA.tkb.L001.thu2.sang, l2:DATA.tkb.L002.thu2.sang, ghep:DATA.dayGhep.length});
  `);
  assert.deepEqual(r.monhoc, ["Ngoại ngữ"]);
  assert.deepEqual(r.l1, ["", {mon:"Ngoại ngữ", fixed:true}, "Ngoại ngữ", "OFF", ""]);
  assert.deepEqual(r.l2, ["", "", "Ngoại ngữ", "", ""]);
});
