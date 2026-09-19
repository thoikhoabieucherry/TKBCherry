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
  return {
    length:0,
    getItem(){ return null; },
    setItem(){},
    removeItem(){},
    key(){ return null; }
  };
}

function loadApp(){
  const localStorage = storageStub();
  const sessionStorage = storageStub();
  const document = {
    addEventListener(){},
    removeEventListener(){},
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    documentElement:{appendChild(){}},
    body:{appendChild(){}, insertAdjacentHTML(){}}
  };
  const location = {
    href:"http://localhost/app.html?sid=default",
    protocol:"http:",
    hostname:"localhost"
  };
  const window = {
    document,
    localStorage,
    sessionStorage,
    location,
    history:{replaceState(){}},
    navigator:{},
    addEventListener(){},
    removeEventListener(){},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  window.window = window;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    sessionStorage,
    location,
    history:window.history,
    navigator:window.navigator,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    confirm(){ return false; },
    alert(){},
    prompt(){ return null; },
    indexedDB:{open(){ return {}; }},
    FileReader:function(){},
    Blob,
    TextEncoder,
    TextDecoder
  });
  vm.runInContext(APP_SOURCE, context, {filename:APP_PATH});
  return context;
}

function assignmentFixture(pccmMatrix){
  return {
    lop:[
      {id:"L001", ten:"6/1", ten2:"6/1", khoi:"Khối 6"},
      {id:"L002", ten:"6/2", ten2:"6/2", khoi:"Khối 6"}
    ],
    giaovien:[{magv:"GV01", hodem:"Nguyễn Văn", ten:"An"}],
    monhoc:[
      {id:"MH1", ten:"Toán", ma:"TOAN"},
      {id:"MH2", ten:"Giáo dục quốc phòng", ma:"GDQP"}
    ],
    mon:[
      {id:"TC1", khoi:"Khối 6", ten:"Toán", sotiet:"4", gioihan:"2"},
      {id:"TC2", khoi:"Khối 6", ten:"Giáo dục quốc phòng", sotiet:"1", gioihan:"1"}
    ],
    phong:[],
    pccmMatrix,
    pccmTietMatrix:{},
    pccmGioihanMatrix:{},
    pccmRoomMatrix:{}
  };
}

test("subject assignment tab keeps unassigned subjects available and labels them without mutating data", () => {
  const context = loadApp();
  const fixture = assignmentFixture({"L001|Toán":"GV01"});
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    PCCM_TAB="monhoc";
    PCCM_SUBJ="GDQP";
    const before=JSON.stringify(DATA);
    const subjectHtml=renderPCCM();
    PCCM_TAB="lop";
    PCCM_SELECTED_CLASS="6/1";
    const classHtml=renderPCCM();
    JSON.stringify({before,after:JSON.stringify(DATA),subjectHtml,classHtml,selected:PCCM_SUBJ});
  `, context));

  assert.match(result.subjectHtml, /setPCCMSelectedSubject\('TOAN'\)/);
  assert.match(result.subjectHtml, /setPCCMSelectedSubject\('GDQP'\)/);
  assert.match(result.subjectHtml, /pccm-side-item-unassigned/);
  assert.match(result.subjectHtml, /Chưa phân công/);
  assert.equal(result.selected, "GDQP");
  assert.match(result.classHtml, /value="GDQP"/);
  assert.equal(result.after, result.before);
});

test("subject assignment tab keeps every subject selectable when none is assigned", () => {
  const context = loadApp();
  const fixture = assignmentFixture({});
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    PCCM_TAB="monhoc";
    PCCM_SUBJ="GDQP";
    const before=JSON.stringify(DATA);
    const html=renderPCCM();
    JSON.stringify({before,after:JSON.stringify(DATA),html,selected:PCCM_SUBJ});
  `, context));

  assert.match(result.html, /setPCCMSelectedSubject\('TOAN'\)/);
  assert.match(result.html, /setPCCMSelectedSubject\('GDQP'\)/);
  assert.equal((result.html.match(/pccm-side-item-status/g) || []).length, 2);
  assert.equal(result.selected, "GDQP");
  assert.equal(result.after, result.before);
});

test("assigned PCCM snapshots standard periods once and ignores later standard edits", () => {
  const context = loadApp();
  const fixture = assignmentFixture({"6/1|TOAN":"GV01"});
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    syncDerivedDataIntegrity();
    const monObj=buildPCCMMonList().find(m=>String(m.ma||m.key)==="TOAN" || String(m.ten)==="ToÃ¡n");
    const first={
      tiet:pccmGetTietDisplay("6/1",monObj,"Khá»‘i 6"),
      gioihan:pccmGetGioihanDisplay("6/1",monObj,"Khá»‘i 6"),
      teacherMatrix:{...DATA.pccmMatrix},
      periodMatrix:{...DATA.pccmTietMatrix},
      limitMatrix:{...DATA.pccmGioihanMatrix}
    };
    DATA.mon[0].sotiet="5";
    DATA.mon[0].gioihan="3";
    syncDerivedDataIntegrity();
    const second={
      tiet:pccmGetTietDisplay("6/1",monObj,"Khá»‘i 6"),
      gioihan:pccmGetGioihanDisplay("6/1",monObj,"Khá»‘i 6"),
      periodMatrix:{...DATA.pccmTietMatrix},
      limitMatrix:{...DATA.pccmGioihanMatrix}
    };
    JSON.stringify({first,second});
  `, context));

  assert.equal(String(result.first.tiet), "4");
  assert.equal(String(result.first.gioihan), "2");
  assert.deepEqual(result.first.teacherMatrix, {"6/1|TOAN":"GV01"});
  assert.deepEqual(result.first.periodMatrix, {"6/1|TOAN":"4"});
  assert.deepEqual(result.first.limitMatrix, {"6/1|TOAN":"2"});
  assert.equal(String(result.second.tiet), "4");
  assert.equal(String(result.second.gioihan), "2");
  assert.deepEqual(result.second.periodMatrix, result.first.periodMatrix);
  assert.deepEqual(result.second.limitMatrix, result.first.limitMatrix);
});

test("authored PCCM periods and limits stay independent from standard edits", () => {
  const context = loadApp();
  const fixture = assignmentFixture({"6/1|TOAN":"GV01"});
  fixture.pccmTietMatrix = {"6/1|TOAN":"7"};
  fixture.pccmGioihanMatrix = {"6/1|TOAN":"4"};
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    syncDerivedDataIntegrity();
    const monObj=buildPCCMMonList().find(m=>String(m.ma||m.key)==="TOAN");
    DATA.mon[0].sotiet="5";
    DATA.mon[0].gioihan="3";
    syncDerivedDataIntegrity();
    JSON.stringify({
      tiet:pccmGetTietDisplay("6/1",monObj,"Khá»‘i 6"),
      gioihan:pccmGetGioihanDisplay("6/1",monObj,"Khá»‘i 6"),
      periodMatrix:{...DATA.pccmTietMatrix},
      limitMatrix:{...DATA.pccmGioihanMatrix}
    });
  `, context));

  assert.equal(String(result.tiet), "7");
  assert.equal(String(result.gioihan), "4");
  assert.deepEqual(result.periodMatrix, {"6/1|TOAN":"7"});
  assert.deepEqual(result.limitMatrix, {"6/1|TOAN":"4"});
});

test("a live teacher assignment snapshots standards before any later standard edit", () => {
  const context = loadApp();
  const fixture = assignmentFixture({});
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    const monObj=buildPCCMMonList().find(m=>String(m.ma||m.key)==="TOAN");
    pccmSetTeachersNoSave("6/1",monObj,"GV01");
    const seeded={
      periods:{...DATA.pccmTietMatrix},
      limits:{...DATA.pccmGioihanMatrix}
    };
    DATA.mon[0].sotiet="5";
    DATA.mon[0].gioihan="3";
    JSON.stringify({
      seeded,
      tiet:pccmGetTietDisplay("6/1",monObj,"Khá»‘i 6"),
      gioihan:pccmGetGioihanDisplay("6/1",monObj,"Khá»‘i 6")
    });
  `, context));

  assert.deepEqual(result.seeded.periods, {"6/1|TOAN":"4"});
  assert.deepEqual(result.seeded.limits, {"6/1|TOAN":"2"});
  assert.equal(String(result.tiet), "4");
  assert.equal(String(result.gioihan), "2");
});

test("blank quick assignment fields preserve finalized PCCM numbers", () => {
  const context = loadApp();
  const fixture = assignmentFixture({"6/1|TOAN":"GV01"});
  fixture.pccmTietMatrix = {"6/1|TOAN":"7"};
  fixture.pccmGioihanMatrix = {"6/1|TOAN":"4"};
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    const monObj=buildPCCMMonList().find(m=>String(m.ma||m.key)==="TOAN");
    pccmQuickUpdateTietChuanForClass("6/1",monObj,"","");
    JSON.stringify({periods:DATA.pccmTietMatrix,limits:DATA.pccmGioihanMatrix});
  `, context));

  assert.deepEqual(result.periods, {"6/1|TOAN":"7"});
  assert.deepEqual(result.limits, {"6/1|TOAN":"4"});
});

test("unassigned subjects keep standards as defaults without creating PCCM values", () => {
  const context = loadApp();
  const fixture = assignmentFixture({});
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    syncDerivedDataIntegrity();
    JSON.stringify({periods:DATA.pccmTietMatrix,limits:DATA.pccmGioihanMatrix});
  `, context));

  assert.deepEqual(result.periods, {});
  assert.deepEqual(result.limits, {});
});

// 02/09: trường 792ad448361 khai 3 dòng Môn học cùng TÊN "Khoa học tự nhiên" nhưng khác MÃ
// (KHTN-Lí / KHTN-Hóa / KHTN-Sinh). Tiết chuẩn + PCCM lưu theo mã, bảng Phân công hiển thị mã,
// nhưng buildPCCMMonList khử trùng theo TÊN nên chỉ còn 1 dòng → 2 môn (và phân công của chúng)
// biến mất khỏi mọi tab Phân công dù vẫn nằm trong kho.
test("subjects sharing a display name but with distinct codes all stay visible in assignment", () => {
  const context = loadApp();
  const fixture = {
    khoi:[{id:"K001", makhoi:"K6", ten:"Khối 6"}],
    lop:[{id:"L001", ten:"6/1", ten2:"6/1", khoi:"Khối 6"}],
    giaovien:[
      {magv:"TTâm", hodem:"Nguyễn", ten:"Tâm"},
      {magv:"L.Thảo", hodem:"Lê", ten:"Thảo"},
      {magv:"Thủy", hodem:"Trần", ten:"Thủy"},
      {magv:"Hiền", hodem:"Phạm", ten:"Hiền"}
    ],
    monhoc:[
      {id:"MH005", ten:"Lịch sử và Địa lý", ma:"LSĐL-Sử", caphoc:"THCS"},
      {id:"MH006", ten:"Lịch sử và Địa lý", ma:"LSĐL-Địa", caphoc:"THCS"},
      {id:"MH007", ten:"Khoa học tự nhiên", ma:"KHTN-Lí", caphoc:"THCS"},
      {id:"MH008", ten:"Khoa học tự nhiên", ma:"KHTN-Hóa", caphoc:"THCS"},
      {id:"MH009", ten:"Khoa học tự nhiên", ma:"KHTN-Sinh", caphoc:"THCS"}
    ],
    mon:[
      {khoi:"Khối 6", ten:"LSĐL-Sử", sotiet:"1", gioihan:"1"},
      {khoi:"Khối 6", ten:"LSĐL-Địa", sotiet:"2", gioihan:"1"},
      {khoi:"Khối 6", ten:"KHTN-Lí", sotiet:"1", gioihan:"1"},
      {khoi:"Khối 6", ten:"KHTN-Hóa", sotiet:"1", gioihan:"1"},
      {khoi:"Khối 6", ten:"KHTN-Sinh", sotiet:"2", gioihan:"1"}
    ],
    phong:[],
    pccmMatrix:{
      "6/1|LSĐL-Sử":"Thủy", "6/1|LSĐL-Địa":"Hiền",
      "6/1|KHTN-Lí":"TTâm", "6/1|KHTN-Hóa":"TTâm", "6/1|KHTN-Sinh":"L.Thảo"
    },
    pccmTietMatrix:{}, pccmGioihanMatrix:{}, pccmRoomMatrix:{}
  };
  const result = JSON.parse(vm.runInContext(`
    DATA=${JSON.stringify(fixture)};
    ensureDataShape();
    const before=JSON.stringify(DATA);
    const all=buildPCCMMonList();
    const visible=all.filter(m=>monHasPositiveTietChuanAnyKhoi(m));
    PCCM_TAB="lop"; PCCM_SELECTED_CLASS="6/1";
    const classHtml=renderPCCM();
    PCCM_TAB="monhoc"; PCCM_SUBJ="KHTN-Hóa";
    const subjectHtml=renderPCCM();
    JSON.stringify({
      keys: visible.map(m=>m.key),
      teachers: visible.map(m=>pccmGetTeacher("6/1", m)),
      classHtml, subjectHtml,
      after: JSON.stringify(DATA), before
    });
  `, context));

  assert.deepEqual(result.keys, ["LSĐL-Sử", "LSĐL-Địa", "KHTN-Lí", "KHTN-Hóa", "KHTN-Sinh"]);
  assert.deepEqual(result.teachers, ["Thủy", "Hiền", "TTâm", "TTâm", "L.Thảo"]);
  for (const code of ["LSĐL-Địa", "KHTN-Hóa", "KHTN-Sinh"]){
    assert.ok(result.classHtml.includes(`>${code}</option>`), `class tab lists ${code}`);
    assert.ok(result.subjectHtml.includes(`setPCCMSelectedSubject('${code}')`), `subject tab lists ${code}`);
  }
  assert.equal(result.after, result.before);
});
