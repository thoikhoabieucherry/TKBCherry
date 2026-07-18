const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "web", "app.js");
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
  const sectionContent = {innerHTML:""};
  const document = {
    addEventListener(){},
    removeEventListener(){},
    getElementById(id){ return id === "section-content" ? sectionContent : null; },
    querySelectorAll(){ return []; },
    documentElement:{appendChild(){}},
    body:{appendChild(){}, insertAdjacentHTML(){}}
  };
  const location = {
    href:"http://localhost/app.html?sid=default",
    protocol:"http:",
    hostname:"localhost"
  };
  const history = {replaceState(){}};
  const window = {
    document,
    localStorage,
    sessionStorage,
    location,
    history,
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
    history,
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

function syncData(context, data){
  const source = JSON.stringify(data);
  return JSON.parse(vm.runInContext(
    `DATA=${source}; ensureDataShape(); syncDerivedDataIntegrity(); JSON.stringify(DATA);`,
    context
  ));
}

test("integrity sync clears stale class availability when no classes remain", () => {
  const context = loadApp();
  const result = syncData(context, {
    lop:[],
    giaovien:[],
    monhoc:[],
    mon:[],
    pccmMatrix:{},
    tkbUserOff:{L001:["thu4|chieu|2"]},
    tkbConstraints:{
      fixedOff:{
        class:{L001:{"thu4|chieu|2":true}},
        teacher:{GV01:{"thu2|sang|0":true}}
      }
    }
  });

  assert.deepEqual(result.tkbUserOff, {});
  assert.deepEqual(result.tkbConstraints.fixedOff.class, {});
  assert.deepEqual(result.tkbConstraints.fixedOff.teacher, {GV01:{"thu2|sang|0":true}});
});

test("integrity sync keeps valid class aliases and prunes only removed classes", () => {
  const context = loadApp();
  const result = syncData(context, {
    lop:[{id:"L001", ten:"6/1", ten2:"", khoi:"Khối 6"}],
    giaovien:[],
    monhoc:[],
    mon:[],
    pccmMatrix:{},
    tkbUserOff:{
      L001:["thu2|sang|4"],
      "6A1":["thu3|sang|4"],
      "7/1":["thu4|sang|4"]
    },
    tkbConstraints:{
      fixedOff:{
        class:{
          L001:{"thu2|sang|4":true},
          "6A1":{"thu3|sang|4":true},
          "7/1":{"thu4|sang|4":true}
        }
      }
    }
  });

  assert.deepEqual(Object.keys(result.tkbUserOff).sort(), ["6A1", "L001"]);
  assert.deepEqual(Object.keys(result.tkbConstraints.fixedOff.class).sort(), ["6A1", "L001"]);
});

test("class import clears stale availability before reusing generated IDs", () => {
  const context = loadApp();
  const source = JSON.stringify({
    khoi:[],
    lop:[],
    giaovien:[],
    monhoc:[],
    mon:[],
    phong:[],
    pccmMatrix:{},
    tkbUserOff:{L001:["thu4|chieu|2"]},
    tkbConstraints:{fixedOff:{class:{L001:{"thu4|chieu|2":true}}}}
  });
  const rows = JSON.stringify([{"Tên lớp":"9/9", "Khối học":"Khối 9"}]);
  const result = JSON.parse(vm.runInContext(
    `DATA=${source}; ensureDataShape(); importExcel_Lop(${rows}); JSON.stringify(DATA);`,
    context
  ));

  assert.equal(result.lop[0].id, "L001");
  assert.equal(result.lop[0].ten, "9/9");
  assert.deepEqual(result.tkbUserOff, {});
  assert.deepEqual(result.tkbConstraints.fixedOff.class, {});
});

test("MaGV2 generator preserves Vietnamese diacritics and uses only the leading initial", () => {
  const context = loadApp();
  const teachers = [
    {hodem:"Bùi Thị Hồng", ten:"Thắm"},
    {hodem:"Bùi Ái", ten:"Quyên"},
    {hodem:"Huỳnh Gia", ten:"Lâm"},
    {hodem:"Huỳnh Phạm Ái", ten:"My"},
    {hodem:"Hà Thị Mai", ten:"Hương"},
    {hodem:"Lê Thị Ly", ten:"Khơ"},
    {hodem:"Đỗ Văn", ten:"Đức"}
  ];
  const result = JSON.parse(vm.runInContext(
    `DATA={giaovien:${JSON.stringify(teachers)}}; JSON.stringify(buildUniqueMaGV2Codes("holot_ten"));`,
    context
  ));

  assert.deepEqual(result, [
    "B.Thắm",
    "B.Quyên",
    "H.Lâm",
    "H.My",
    "H.Hương",
    "L.Khơ",
    "Đ.Đức"
  ]);
});

test("MaGV2 applies the exact duplicate sequence for all three naming rules", () => {
  const context = loadApp();
  const teachers = [
    {hodem:"Nguyễn Hoàng", ten:"Ân"},
    {hodem:"Nguyễn Hoàng", ten:"Ân"},
    {hodem:"Võ Hoàng", ten:"Ân"},
    {hodem:"Nguyễn Hoàng", ten:"Ân"}
  ];
  const result = JSON.parse(vm.runInContext(
    `DATA={giaovien:${JSON.stringify(teachers)}}; JSON.stringify({
      hoTen:buildUniqueMaGV2Codes("holot_ten"),
      tenHo:buildUniqueMaGV2Codes("ten_holot"),
      ten:buildUniqueMaGV2Codes("ten")
    });`,
    context
  ));

  assert.deepEqual(result.hoTen, ["N.Ân", "N.Ân1", "V.Ân", "N.Ân2"]);
  assert.deepEqual(result.tenHo, ["Ân.N", "Ân.N1", "Ân.V", "Ân.N2"]);
  assert.deepEqual(result.ten, ["Ân", "Ân1", "Ân2", "Ân3"]);
});

test("MaGV2 generation preserves Vietnamese diacritics for every naming rule", () => {
  const context = loadApp();
  const teacher = JSON.stringify({hodem:"Bùi Ái", ten:"Quyên"});
  const result = JSON.parse(vm.runInContext(
    `JSON.stringify({
      holotTen:buildMaGV2Base(${teacher}, "holot_ten"),
      tenHolot:buildMaGV2Base(${teacher}, "ten_holot"),
      ten:buildMaGV2Base(${teacher}, "ten")
    });`,
    context
  ));

  assert.deepEqual(result, {
    holotTen:"B.Quyên",
    tenHolot:"Quyên.B",
    ten:"Quyên"
  });
});

test("MaGV2 uniqueness suffixes only canonically identical accented codes", () => {
  const context = loadApp();
  const teachers = JSON.stringify([
    {hodem:"Nguyễn Văn", ten:"An"},
    {hodem:"Nguyễn Văn", ten:"Ân"},
    {hodem:"Nguyễn Văn", ten:"An"},
    {hodem:"Nguyễn Văn", ten:"A\u0302n"},
    {hodem:"Đặng Ái", ten:"Ỷ"},
    {hodem:"Đặng Ái", ten:"Ỷ"}
  ]);
  const result = JSON.parse(vm.runInContext(
    `DATA.giaovien=${teachers}; JSON.stringify(buildUniqueMaGV2Codes("holot_ten"));`,
    context
  ));

  assert.deepEqual(result, [
    "N.An",
    "N.Ân",
    "N.An1",
    "N.Ân1",
    "Đ.Ỷ",
    "Đ.Ỷ1"
  ]);
});
