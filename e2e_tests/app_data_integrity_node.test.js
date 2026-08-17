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

function loadApp(options = {}){
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
    clearInterval,
    TKBAuth:options.TKBAuth || null,
    TKBSchool:options.TKBSchool || null
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
    alert(message){ options.alerts?.push(String(message)); },
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

function planAuth(planId){
  const school = {
    id:"school1",
    shortId:"abc",
    plan:planId,
    schedules:[{number:1, sid:"default", original:true}]
  };
  const registry = {schools:{school1:school}};
  return {
    loadRegistry(){ return registry; },
    currentUser(){
      return {
        session:{schoolId:"school1"},
        user:{schoolId:"school1", role:"school_admin"},
        registry
      };
    },
    effectivePlan(value){ return {id:String(value?.plan || "free")}; }
  };
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

test("assignment numeric cells apply a typed digit without entering edit mode", () => {
  const context = loadApp();
  let focused = false;
  let prevented = false;
  let saved = 0;
  const input = {
    value:"2",
    focus(){ focused = true; },
    setSelectionRange(){}
  };
  const cell = {
    dataset:{r:"0", c:"2", kind:"periods"},
    classList:{toggle(){}},
    querySelector(selector){
      return selector === "input.inline-edit-input" ? input : null;
    }
  };
  context.document.querySelector = selector => {
    if(selector === ".pccm-copy-cell[data-r][data-c]") return cell;
    if(selector.includes('data-r="0"') && selector.includes('data-c="2"')) return cell;
    return null;
  };
  context.document.querySelectorAll = selector => selector.includes(".pccm-copy-cell") ? [cell] : [];
  context.pccmAutoSaveActive = ()=>{ saved += 1; return true; };
  vm.runInContext('PCCM_CELL_SELECTION=new Set(["0,2"]); PCCM_CELL_ANCHOR={r:0,c:2};', context);

  context.pccmGlobalKeyDown({
    key:"3",
    target:{tagName:"BODY"},
    ctrlKey:false,
    metaKey:false,
    altKey:false,
    preventDefault(){ prevented = true; }
  });

  assert.equal(input.value, "3");
  assert.equal(focused, false);
  assert.equal(saved, 1);
  assert.equal(prevented, true);
});

test("standard-period selected cell applies a typed digit without creating an editor", () => {
  const context = loadApp();
  let prevented = false;
  let saved = 0;
  let editor = null;
  const cell = {
    dataset:{r:"0", c:"0", rowid:"M1", field:"sotiet", val:"2"},
    classList:{toggle(){}},
    textContent:"2",
    querySelector(selector){
      return String(selector).startsWith("input") ? editor : null;
    }
  };
  Object.defineProperty(cell, "innerHTML", {
    configurable:true,
    get(){ return editor ? "<input>" : cell.textContent; },
    set(value){
      if(String(value).includes("<input")){
        editor = {
          value:"2",
          focus(){},
          select(){},
          setSelectionRange(){},
          onkeydown:null,
          onblur:null
        };
      }else{
        editor = null;
        cell.textContent = String(value);
      }
    }
  });
  context.document.querySelector = selector => {
    if(selector === ".tc-cell[data-r][data-c]") return cell;
    if(selector.includes('data-r="0"') && selector.includes('data-c="0"')) return cell;
    return null;
  };
  context.document.querySelectorAll = selector => selector.includes(".tc-cell") ? [cell] : [];
  context.tcAutoSaveEdits = ()=>{ saved += 1; return true; };
  vm.runInContext('TC_CELL_SELECTION=new Set(["0,0"]); TC_CELL_ANCHOR={r:0,c:0};', context);

  context.tcGlobalKeyDown({
    key:"4",
    target:{tagName:"BODY"},
    ctrlKey:false,
    metaKey:false,
    altKey:false,
    preventDefault(){ prevented = true; }
  });

  assert.equal(editor, null);
  assert.equal(cell.textContent, "4");
  assert.equal(cell.dataset.val, "4");
  assert.equal(saved, 1);
  assert.equal(prevented, true);
});

test("standard-period single click only selects the cell", () => {
  const context = loadApp();
  let editor = null;
  let prevented = false;
  const cell = {
    dataset:{r:"0", c:"1", rowid:"M1", field:"gioihan", val:"1"},
    classList:{toggle(){}},
    textContent:"1",
    querySelector(selector){
      return String(selector).startsWith("input") ? editor : null;
    }
  };
  Object.defineProperty(cell, "innerHTML", {
    configurable:true,
    get(){ return editor ? "<input>" : cell.textContent; },
    set(value){
      if(String(value).includes("<input")){
        editor = {
          value:"1",
          focus(){},
          select(){},
          setSelectionRange(){},
          onkeydown:null,
          onblur:null
        };
      }else{
        editor = null;
        cell.textContent = String(value);
      }
    }
  });
  context.document.querySelector = selector => {
    if(selector === ".tc-cell[data-r][data-c]") return cell;
    if(selector.includes('data-r="0"') && selector.includes('data-c="1"')) return cell;
    return null;
  };
  context.document.querySelectorAll = selector => selector.includes(".tc-cell") ? [cell] : [];
  vm.runInContext('TC_CELL_SELECTION=new Set(); TC_CELL_ANCHOR=null; TC_CELL_DRAG_MOVED=false;', context);

  const event = {
    button:0,
    target:cell,
    ctrlKey:false,
    metaKey:false,
    shiftKey:false,
    preventDefault(){ prevented = true; }
  };
  context.tcCellMouseDown(event, cell);
  context.tcCellClick(event, cell);

  assert.equal(editor, null);
  assert.equal(prevented, true);
});

test("assignment numeric cell tap selects without focusing its input", async () => {
  const context = loadApp();
  let focused = false;
  let selected = false;
  const input = {
    value:"2",
    focus(){ focused = true; context.document.activeElement = input; },
    select(){ selected = true; },
  };
  const cell = {
    dataset:{r:"0", c:"2", kind:"periods"},
    classList:{toggle(){}},
    querySelector(selector){ return selector === "input.inline-edit-input" ? input : null; }
  };
  context.document.activeElement = null;
  context.document.querySelector = selector => {
    if(selector === ".pccm-copy-cell[data-r][data-c]") return cell;
    if(selector.includes('data-r="0"') && selector.includes('data-c="2"')) return cell;
    return null;
  };
  context.document.querySelectorAll = selector => selector.includes(".pccm-copy-cell") ? [cell] : [];
  vm.runInContext('PCCM_CELL_SELECTION=new Set(); PCCM_CELL_ANCHOR=null;', context);

  context.pccmCellMouseDown({
    button:0,
    target:cell,
    ctrlKey:false,
    metaKey:false,
    shiftKey:false,
    preventDefault(){}
  }, cell);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(focused, false);
  assert.equal(selected, false);
});

test("standard-period click commits the previous editor and only selects the next cell", () => {
  const context = loadApp();
  const makeCell = (column, field, value) => {
    let editor = null;
    const cell = {
      dataset:{r:"0", c:String(column), rowid:"M1", field, val:value},
      classList:{toggle(){}},
      textContent:value,
      querySelector(selector){ return String(selector).startsWith("input") ? editor : null; }
    };
    Object.defineProperty(cell, "editor", {get(){ return editor; }});
    Object.defineProperty(cell, "innerHTML", {
      configurable:true,
      get(){ return editor ? "<input>" : cell.textContent; },
      set(next){
        if(String(next).includes("<input")){
          editor = {
            value,
            matches(selector){ return String(selector).includes("input"); },
            focus(){ context.document.activeElement = editor; },
            select(){},
            setSelectionRange(){},
            blur(){
              context.document.activeElement = null;
              editor.onblur?.();
            },
            onkeydown:null,
            onblur:null
          };
        }else{
          editor = null;
          cell.textContent = String(next);
        }
      }
    });
    return cell;
  };
  const first = makeCell(0, "sotiet", "2");
  const second = makeCell(1, "gioihan", "1");
  const cells = [first, second];
  context.document.activeElement = null;
  context.document.querySelector = selector => {
    if(selector.includes('data-c="0"')) return first;
    if(selector.includes('data-c="1"')) return second;
    if(selector.includes(".tc-cell input")) return first.editor || second.editor;
    return selector === ".tc-cell[data-r][data-c]" ? first : null;
  };
  context.document.querySelectorAll = selector => selector.includes(".tc-cell") ? cells : [];
  vm.runInContext('DATA.mon=[{id:"M1",khoi:"Khối 6",ten:"Toán",sotiet:"2",gioihan:"1"}];', context);

  context.tcBeginCellEdit(first);
  assert.equal(context.document.activeElement, first.editor);
  context.tcCellMouseDown({
    button:0, target:second, ctrlKey:false, metaKey:false, shiftKey:false, preventDefault(){}
  }, second);
  context.tcCellClick({
    target:second, ctrlKey:false, metaKey:false, shiftKey:false, preventDefault(){}
  }, second);

  assert.equal(first.editor, null);
  assert.equal(second.editor, null);
  assert.equal(context.document.activeElement, null);
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

test("Max 1 blocks the 40th imported class before mutating the timetable", () => {
  const alerts = [];
  const context = loadApp({TKBAuth:planAuth("max1"), alerts});
  const classes = Array.from({length:39}, (_, index) => ({
    id:`L${String(index + 1).padStart(3, "0")}`,
    ten:`${index + 1}A`,
    ten2:`${index + 1}A`,
    khoi:"Khối 6"
  }));
  const result = JSON.parse(vm.runInContext(
    `CTX.schoolId="default"; DATA={lop:${JSON.stringify(classes)}}; importExcel_Lop([{"Tên lớp":"40A","Khối học":"Khối 6"}]); JSON.stringify(DATA.lop);`,
    context
  ));

  assert.equal(result.length, 39);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Max 1/);
  assert.match(alerts[0], /Max 2/);
  assert.match(alerts[0], /39 lớp/);
});

test("Max 2 has no client-side class ceiling", () => {
  const alerts = [];
  const context = loadApp({TKBAuth:planAuth("max2"), alerts});
  const allowed = vm.runInContext(
    `CTX.schoolId="default"; DATA={lop:[]}; ensureClassCapacity(50000);`,
    context
  );

  assert.equal(allowed, true);
  assert.deepEqual(alerts, []);
});

test("all three class-creation paths enforce the shared Max 1 guard", () => {
  const quickAdd = APP_SOURCE.slice(
    APP_SOURCE.indexOf("function quickAddLopFromInputs"),
    APP_SOURCE.indexOf("function normalizeMaGV2Part")
  );
  const importClasses = APP_SOURCE.slice(
    APP_SOURCE.indexOf("function importExcel_Lop"),
    APP_SOURCE.indexOf("function importExcel_Mon")
  );
  const manualSave = APP_SOURCE.slice(
    APP_SOURCE.indexOf("function saveData"),
    APP_SOURCE.indexOf("function deleteRow")
  );

  assert.match(quickAdd, /ensureClassCapacity\(DATA\.lop\.length \+ candidates\.length\)/);
  assert.match(importClasses, /ensureClassCapacity\(DATA\.lop\.length/);
  assert.match(manualSave, /section === "lop" && !ensureClassCapacity/);
});

test("quick class batches assign a distinct ID after each accepted row", () => {
  const quickAdd = APP_SOURCE.slice(
    APP_SOURCE.indexOf("function quickAddLopFromInputs"),
    APP_SOURCE.indexOf("function normalizeMaGV2Part")
  );
  assert.doesNotMatch(quickAdd, /candidates\.push\(\{\s*id:\s*autoID\("lop"\)/);
  assert.match(quickAdd, /candidates\.forEach\(candidate => \{\s*candidate\.id = autoID\("lop"\);\s*DATA\.lop\.push\(candidate\);/);

  const context = loadApp();
  const ids = JSON.parse(vm.runInContext(
    `DATA={lop:[]}; [{ten:"6A1"},{ten:"6A2"},{ten:"6A3"}].forEach(candidate=>{ candidate.id=autoID("lop"); DATA.lop.push(candidate); }); JSON.stringify(DATA.lop.map(row=>row.id));`,
    context
  ));
  assert.deepEqual(ids, ["L001", "L002", "L003"]);
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

test("PCCM indexed lookups preserve class, teacher, and standard-period semantics", () => {
  const context = loadApp();
  const result = JSON.parse(vm.runInContext(`
    DATA={
      lop:[{id:"L001",ten:"6/1",ten2:"6A1",khoi:"Khối 6"}],
      giaovien:[{magv:"GV01",hodem:"Nguyễn Văn",ten:"An"}],
      mon:[{id:"TC1",khoi:"Khối 6",ten:"Toán",sotiet:"4",gioihan:"2"}]
    };
    PCCM_LOOKUP_CACHE=null;
    const legacy={
      aliases:classLookupCandidates("6A1"),
      teacher:resolveTeacherCode("Nguyễn Văn An"),
      standard:lookupTietChuan("Khối 6",{key:"TOAN",ten:"Toán",ma2:""})?.sotiet
    };
    PCCM_LOOKUP_CACHE=pccmBuildLookupCache();
    JSON.stringify({legacy, indexed:{
      aliases:classLookupCandidates("6A1"),
      teacher:resolveTeacherCode("Nguyễn Văn An"),
      standard:lookupTietChuan("Khối 6",{key:"TOAN",ten:"Toán",ma2:""})?.sotiet
    }});
  `, context));

  assert.deepEqual(result.indexed, result.legacy);
  assert.deepEqual(result.indexed, {
    aliases:["6A1", "6/1", "L001"],
    teacher:"GV01",
    standard:"4"
  });
});

test("PCCM teacher choices hydrate only when their row menu opens", () => {
  const context = loadApp();
  vm.runInContext(`
    DATA={giaovien:[
      {magv:"GV01",hodem:"Nguyễn Văn",ten:"An"},
      {magv:"GV02",hodem:"Trần Thị",ten:"Bình"}
    ]};
    PCCM_LOOKUP_CACHE=pccmBuildLookupCache();
  `, context);

  const initial = context.pccmRenderTeacherMulti(
    "pccm_test_gv",
    "GV01, GV-CU",
    [{code:"GV01"}, {code:"GV02"}]
  );
  assert.match(initial, /data-pccm-menu-lazy="1"/);
  assert.doesNotMatch(initial, /pccm-teacher-item/);
  assert.match(initial, /value="GV01, GV-CU"/);

  const attrs = new Map();
  const menu = {
    innerHTML:"",
    getAttribute(name){ return attrs.get(name) || null; },
    setAttribute(name, value){ attrs.set(name, String(value)); }
  };
  const box = {
    id:"pccm_test_gv_box",
    querySelector(selector){ return selector === ".pccm-multi-menu" ? menu : null; }
  };
  const hidden = {value:"GV01, GV-CU"};
  context.document.getElementById = id => id === "pccm_test_gv" ? hidden : null;

  const hydrated = context.pccmEnsureTeacherMultiMenu(box);
  assert.equal(hydrated, menu);
  assert.equal(attrs.get("data-pccm-menu-hydrated"), "1");
  assert.equal((menu.innerHTML.match(/pccm-teacher-item/g) || []).length, 3);
  assert.match(menu.innerHTML, /GV01/);
  assert.match(menu.innerHTML, /GV02/);
  assert.match(menu.innerHTML, /GV-CU/);
});
