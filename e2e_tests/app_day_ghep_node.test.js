// Dạy ghép (PCGD ghép, 28/08/2026; tách hẳn khỏi PCCM 29/08): mỗi dòng DATA.dayGhep là một
// môn ghép riêng, bản sắc = tên viết tắt, chiếu vào bảng phân công dưới khoá ảo
// "Lớp|Viết tắt" -> "GV1, GV2"; không đụng khoá môn thật; ô TKB đổi tên/gỡ theo dòng.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "web", "app.js");
const MODULE_PATH = path.join(__dirname, "..", "web", "modules", "day-ghep.js");
const APP_SOURCE = fs.readFileSync(APP_PATH, "utf8");
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, "utf8");

function storageStub(){
  return { length:0, getItem(){ return null; }, setItem(){}, removeItem(){}, key(){ return null; } };
}

function loadApp(){
  const localStorage = storageStub();
  const sessionStorage = storageStub();
  const sectionContent = {innerHTML:"", querySelector(){ return null; }};
  const document = {
    addEventListener(){},
    removeEventListener(){},
    getElementById(id){ return id === "section-content" ? sectionContent : null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(){ return {style:{}, classList:{add(){}, remove(){}, toggle(){}}, setAttribute(){}, appendChild(){}}; },
    documentElement:{appendChild(){}},
    body:{appendChild(){}, insertAdjacentHTML(){}}
  };
  const location = {href:"http://localhost/app.html?sid=default", protocol:"http:", hostname:"localhost"};
  const window = {
    document, localStorage, sessionStorage, location,
    history:{replaceState(){}},
    navigator:{},
    addEventListener(){}, removeEventListener(){},
    setTimeout, clearTimeout, setInterval, clearInterval,
    TKBAuth:null, TKBSchool:null
  };
  window.window = window;
  const alerts = [];
  const context = vm.createContext({
    window, document, localStorage, sessionStorage, location,
    history:window.history, navigator:window.navigator,
    URL, URLSearchParams, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm(){ return true; },
    alert(message){ alerts.push(String(message)); },
    prompt(){ return null; },
    indexedDB:{open(){ return {}; }},
    FileReader:function(){},
    Blob, TextEncoder, TextDecoder,
    requestAnimationFrame(fn){ fn(); }
  });
  vm.runInContext(APP_SOURCE, context, {filename:APP_PATH});
  vm.runInContext(MODULE_SOURCE, context, {filename:MODULE_PATH});
  context.__alerts = alerts;
  return context;
}

function baseData(extra){
  return Object.assign({
    khoi:[{id:"K001", ten:"Khối 6"}],
    lop:[
      {id:"L001", ten:"6A1", ten2:"6/1", khoi:"Khối 6"},
      {id:"L002", ten:"6A2", ten2:"6/2", khoi:"Khối 6"}
    ],
    giaovien:[
      {id:"GV001", magv:"AV.KCuong", hodem:"Nguyễn", ten:"Cương"},
      {id:"GV002", magv:"Gems1", hodem:"", ten:"Gems1"},
      {id:"GV003", magv:"NDiep", hodem:"Trần", ten:"Điệp"}
    ],
    monhoc:[
      {id:"MH001", ten:"Anh văn giao tiếp", ma:"AVGT"},
      {id:"MH002", ten:"Toán", ma:"TOAN"}
    ],
    mon:[
      {id:"M001", khoi:"Khối 6", ten:"AVGT", sotiet:"2", gioihan:"2"},
      {id:"M002", khoi:"Khối 6", ten:"TOAN", sotiet:"4", gioihan:"2"}
    ],
    pccmMatrix:{"6A1|TOAN":"NDiep"},
    pccmTietMatrix:{},
    pccmGioihanMatrix:{},
    tkb:{}
  }, extra || {});
}

function sync(context, data){
  const source = JSON.stringify(data);
  return JSON.parse(vm.runInContext(
    `(function(){ DATA=${source}; ensureDataShape(); const changed = syncDerivedDataIntegrity(); return JSON.stringify({data:DATA, changed}); })()`,
    context
  ));
}


test("mỗi dòng là môn ghép riêng: khoá 'Lớp|viết tắt', không đụng phân công chính của môn thật", () => {
  const context = loadApp();
  const first = sync(context, baseData({
    pccmMatrix:{"6A1|TOAN":"NDiep", "6A1|AVGT":"NDiep"},
    dayGhep:[{id:"DG001", lop:"6A1", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"1", gioihan:"1", viettat:"AV-GT"}]
  }));
  assert.equal(first.changed, true);
  assert.deepEqual(first.data.dayGhep[0].lop, ["6A1"]);
  assert.deepEqual(first.data.dayGhep[0].mon, ["AVGT"]);
  assert.equal(first.data.dayGhep[0].ten, "AV-GT", "tên viết tắt là bản sắc");
  assert.equal(first.data.pccmMatrix["6A1|AV-GT"], "AV.KCuong, Gems1", "khoá ảo riêng");
  assert.equal(first.data.pccmTietMatrix["6A1|AV-GT"], "1");
  assert.equal(first.data.pccmGioihanMatrix["6A1|AV-GT"], "1");
  assert.equal(first.data.pccmMatrix["6A1|AVGT"], "NDiep", "phân công chính của môn thật giữ nguyên");
  assert.equal(first.data.pccmMatrix["6A1|TOAN"], "NDiep");
  assert.deepEqual(first.data.dayGhepProjected, ["6A1|AV-GT"]);

  // Lần nạp sau: không có gì đổi (idempotent); khoá ảo không bị dọn như phân công mồ côi
  const second = sync(context, first.data);
  assert.equal(second.changed, false);
  assert.equal(second.data.pccmMatrix["6A1|AV-GT"], "AV.KCuong, Gems1");
  assert.equal(second.data.pccmTietMatrix["6A1|AV-GT"], "1");

  // Môn thật trong bảng Phân công KHÔNG còn bị coi là "do Dạy ghép sở hữu"
  const owned = JSON.parse(vm.runInContext(`JSON.stringify({
    a: pccmIsDayGhepRow("6A1", {key:"AVGT", ten:"Anh văn giao tiếp", ma:"AVGT"}),
    b: pccmIsDayGhepRow("6A1", {key:"AV-GT", ten:"AV-GT"})
  })`, context));
  assert.deepEqual(owned, {a:false, b:true});
});

test("di trú dòng cũ (còn hienthi): tên tự động thành viết tắt, khoá môn thật được trả về, ô TKB đổi tên", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    pccmMatrix:{"6A1|TOAN":"NDiep", "6A1|AVGT":"AV.KCuong, Gems1", "6A2|AVGT":"AV.KCuong, Gems1"},
    pccmTietMatrix:{"6A1|AVGT":"2", "6A2|AVGT":"2"},
    dayGhepProjected:["6A1|AVGT", "6A2|AVGT"],
    dayGhep:[
      {id:"DG001", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", hienthi:"auto", viettat:""},
      {id:"DG002", lop:["6A2"], mon:["AVGT"], gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", hienthi:"viettat", viettat:"AVGT"}
    ],
    tkb:{
      L001:{thu2:{sang:["Anh văn giao tiếp","TOAN","",{mon:"AVGT", fixed:true},""], chieu:["","","","",""]}},
      L002:{thu2:{sang:["AVGT","","","",""], chieu:["","","","",""]}}
    },
    tkbLessonTeachers:{"6A1|AVGT":"AV.KCuong, Gems1", "6A1|TOAN":"NDiep"}
  }));
  const rows = result.data.dayGhep;
  assert.equal(rows[0].viettat, "AVGT 6A1", "dòng 'tự động' lấy tên tự động làm viết tắt");
  assert.equal(rows[0].ten, "AVGT 6A1");
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], "hienthi"), false);
  assert.equal(rows[1].viettat, "AVGT", "nhãn người dùng đặt được giữ nguyên dù trùng mã môn");
  assert.equal(rows[1].ten, "AVGT (ghép)", "khoá nội bộ thêm hậu tố vì trùng mã môn");
  assert.equal(result.data.pccmMatrix["6A1|AVGT 6A1"], "AV.KCuong, Gems1");
  assert.equal(result.data.pccmMatrix["6A2|AVGT (ghép)"], "AV.KCuong, Gems1");
  assert.equal(result.data.pccmMatrix["6A1|AVGT"], undefined, "khoá môn thật do dạy ghép cũ chiếm được trả về trống");
  assert.equal(result.data.pccmMatrix["6A2|AVGT"], undefined);
  assert.equal(result.data.pccmTietMatrix["6A1|AVGT"], undefined);
  assert.deepEqual(result.data.dayGhepProjected, ["6A1|AVGT 6A1", "6A2|AVGT (ghép)"]);
  assert.deepEqual(result.data.tkb.L001.thu2.sang, ["AVGT 6A1","TOAN","",{mon:"AVGT 6A1", fixed:true},""], "ô TKB lưu môn thật đổi sang khoá của dòng");
  assert.deepEqual(result.data.tkb.L002.thu2.sang, ["AVGT (ghép)","","","",""]);
  assert.equal(result.data.tkbLessonTeachers["6A1|AVGT 6A1"], "AV.KCuong, Gems1");
  assert.equal(result.data.tkbLessonTeachers["6A1|AVGT"], undefined);
  assert.equal(result.data.tkbLessonTeachers["6A1|TOAN"], "NDiep");

  const again = sync(context, result.data);
  assert.equal(again.changed, false, "di trú xong thì ổn định");
});

test("nhãn đặt tùy ý; khoá nội bộ tự thêm hậu tố khi trùng môn học / gốc FET / dòng khác / phân công chính", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    monhoc:[
      {id:"MH001", ten:"Anh văn giao tiếp", ma:"AVGT"},
      {id:"MH002", ten:"Toán", ma:"TOAN"},
      {id:"MH003", ten:"Hoạt động trải nghiệm", ma:"HĐTN"}
    ],
    pccmMatrix:{"6A1|TOAN":"NDiep", "6A1|HĐTN":"NDiep"},
    dayGhep:[
      {id:"DG001", lop:["6A1"], mon:["TOAN"], gv:["AV.KCuong","Gems1"], sotiet:"1", gioihan:"1", viettat:"TOAN"},
      {id:"DG002", lop:["6A1"], mon:["HĐTN"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"HĐTN 1"},
      {id:"DG003", lop:["6A1"], mon:["AVGT"], gv:["Gems1"], sotiet:"1", gioihan:"1", viettat:"Ghép"},
      {id:"DG004", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"Ghép"},
      {id:"DG005", lop:["6A2"], mon:["AVGT"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"Ghép"},
      {id:"DG006", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"A|B"}
    ]
  }));
  const rows = result.data.dayGhep;
  assert.deepEqual(rows.map(r => [r.viettat, r.ten]), [
    ["TOAN", "TOAN (ghép)"],           // trùng mã môn -> nhãn giữ, khoá thêm hậu tố
    ["HĐTN 1", "HĐTN 1 (ghép)"],       // ▶ FET rút gọn "HĐTN 1" thành HĐTN -> tránh
    ["Ghép", "Ghép"],
    ["Ghép", "Ghép (ghép)"],           // cùng lớp cùng nhãn -> khoá khác nhau
    ["Ghép", "Ghép"],                  // lớp khác -> dùng lại khoá "Ghép"
    ["A|B", "A/B"]                     // "|" là dấu tách khoá
  ]);
  assert.equal(result.data.pccmMatrix["6A1|TOAN"], "NDiep", "phân công chính của TOAN không bị đụng");
  assert.equal(result.data.pccmMatrix["6A1|HĐTN"], "NDiep");
  assert.equal(result.data.pccmMatrix["6A1|TOAN (ghép)"], "AV.KCuong, Gems1");
  assert.equal(result.data.pccmMatrix["6A1|Ghép"], "Gems1");
  assert.equal(result.data.pccmMatrix["6A1|Ghép (ghép)"], "AV.KCuong");
  assert.equal(result.data.pccmMatrix["6A2|Ghép"], "AV.KCuong");

  const again = sync(context, result.data);
  assert.equal(again.changed, false, "khoá ổn định qua các lần nạp");
  assert.deepEqual(again.data.dayGhep.map(r => r.ten), ["TOAN (ghép)", "HĐTN 1 (ghép)", "Ghép", "Ghép (ghép)", "Ghép", "A/B"]);

  const checks = JSON.parse(vm.runInContext(`JSON.stringify({
    ok: dayGhepNameProblem({lop:["6A2"], mon:["TOAN"], viettat:"TOAN"}),
    noSubject: dayGhepNameProblem({lop:["6A1"], mon:[], viettat:"X"}),
    noClass: dayGhepNameProblem({lop:[], mon:["TOAN"], viettat:"X"}),
    autoWhenEmpty: dayGhepNameProblem({lop:["6A2"], mon:["AVGT"], viettat:""})
  })`, context));
  assert.equal(checks.ok, "", "trùng tên môn học không còn bị chặn");
  assert.match(checks.noSubject, /Chưa chọn môn/);
  assert.match(checks.noClass, /Chưa chọn lớp/);
  assert.equal(checks.autoWhenEmpty, "");
  assert.equal(typeof context.dayGhepMainAssignmentClashes, "undefined");
});

test("nhãn chứa ' - ' (vd 'AI - 1'): khoá thu thành 'AI-1' vì planner/FET đọc 'Môn - GV' dạng cũ; ô TKB đã xếp đổi theo", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    dayGhep:[{id:"DG003", lop:["6A1","6A2"], mon:["AVGT"], gv:["GV.AI"], sotiet:"1", gioihan:"1", viettat:"AI - 1", ten:"AI - 1"}],
    tkb:{L001:{thu2:{sang:["AI - 1","TOAN","",{mon:"AI - 1", fixed:true},""], chieu:["","","","",""]}}},
    tkbLessonTeachers:{"6A1|AI - 1":"GV.AI"}
  }));
  assert.equal(result.data.dayGhep[0].viettat, "AI - 1", "nhãn người dùng giữ nguyên");
  assert.equal(result.data.dayGhep[0].ten, "AI-1");
  assert.deepEqual(result.data.tkb.L001.thu2.sang, ["AI-1","TOAN","",{mon:"AI-1", fixed:true},""]);
  assert.equal(result.data.pccmMatrix["6A1|AI-1"], "GV.AI");
  assert.equal(result.data.pccmMatrix["6A2|AI-1"], "GV.AI");
  assert.equal(result.data.pccmMatrix["6A1|AI - 1"], undefined);
  assert.equal(result.data.tkbLessonTeachers["6A1|AI-1"], "GV.AI");
  const again = sync(context, result.data);
  assert.equal(again.changed, false);
  const bases = JSON.parse(vm.runInContext(`JSON.stringify([dgIdentityBase("AI - 1"), dgIdentityBase("AI -1"), dgIdentityBase("AI- 1"), dgIdentityBase("AI-1"), dgIdentityBase("A|B - C")])`, context));
  assert.deepEqual(bases, ["AI-1", "AI-1", "AI-1", "AI-1", "A/B-C"]);
});

test("đổi tên viết tắt đổi tên ô TKB đã xếp (giữ vị trí); xóa dòng gỡ ô và khoá đã chiếu", () => {
  const context = loadApp();
  sync(context, baseData({
    dayGhep:[{id:"DG001", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", viettat:"AV-GT"}],
    tkb:{L001:{thu2:{sang:["AV-GT","TOAN","",{mon:"AV-GT", fixed:true},""], chieu:["","","","",""]}}},
    tkbLessonTeachers:{"6A1|AV-GT":"AV.KCuong, Gems1", "6A1|TOAN":"NDiep"}
  }));

  const renamed = JSON.parse(vm.runInContext(`(function(){
    const prev = DATA.dayGhep[0];
    const oldNames = dayGhepCellNames(prev);
    const entry = {id: prev.id, lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", viettat:"AV GT"};
    const n = dayGhepRenameTkbCells("6A1", oldNames, dayGhepIdentity(entry));
    DATA.dayGhep[0] = entry;
    const changed = syncDayGhepProjection();
    return JSON.stringify({n, changed, oldNames, data:DATA});
  })()`, context));
  assert.deepEqual(renamed.oldNames, ["AV-GT"]);
  assert.equal(renamed.n, 2);
  assert.deepEqual(renamed.data.tkb.L001.thu2.sang, ["AV GT","TOAN","",{mon:"AV GT", fixed:true},""]);
  assert.equal(renamed.data.tkbLessonTeachers["6A1|AV GT"], "AV.KCuong, Gems1");
  assert.equal(renamed.data.tkbLessonTeachers["6A1|AV-GT"], undefined);
  assert.equal(renamed.data.pccmMatrix["6A1|AV GT"], "AV.KCuong, Gems1");
  assert.equal(renamed.data.pccmMatrix["6A1|AV-GT"], undefined);
  assert.equal(renamed.data.pccmMatrix["6A1|TOAN"], "NDiep");
  assert.deepEqual(renamed.data.dayGhepProjected, ["6A1|AV GT"]);

  const removed = JSON.parse(vm.runInContext(`(function(){
    const e = DATA.dayGhep[0];
    const n = dayGhepRemoveTkbCells("6A1", dayGhepCellNames(e));
    DATA.dayGhep = [];
    const changed = syncDayGhepProjection();
    return JSON.stringify({n, changed, data:DATA});
  })()`, context));
  assert.equal(removed.n, 2);
  assert.deepEqual(removed.data.tkb.L001.thu2.sang, ["","TOAN","","",""], "chỉ ô của dòng ghép bị gỡ, ô môn thật giữ nguyên");
  assert.equal(removed.data.pccmMatrix["6A1|AV GT"], undefined);
  assert.equal(removed.data.pccmMatrix["6A1|TOAN"], "NDiep");
  assert.deepEqual(removed.data.dayGhepProjected, []);
});

test("dòng dạy ghép mồ côi (lớp/môn không còn) bị dọn và ô TKB của nó bị gỡ; dòng KHÔNG GV (02/09) được giữ", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    dayGhep:[
      {id:"DG001", lop:"9A9", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", viettat:"X1"},
      {id:"DG002", lop:"6/1", mon:"XYZ", gv:["AV.KCuong"], sotiet:"2", gioihan:"2", viettat:"X2"},
      {id:"DG003", lop:"6A1", mon:"AVGT", gv:[], sotiet:"2", gioihan:"2", viettat:"X3"},
      {id:"DG004", lop:"6/1", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"", viettat:"AV-GT"}
    ],
    tkb:{L001:{thu2:{sang:["X2","X3","","",""], chieu:["","","","",""]}}}
  }));
  assert.deepEqual(result.data.dayGhep.map(r => r.id), ["DG003", "DG004"]);
  const noTeacher = result.data.dayGhep[0];
  assert.deepEqual(noTeacher.gv, [], "dòng không giáo viên là dòng hợp lệ (tiết không GV)");
  const kept = result.data.dayGhep[1];
  assert.deepEqual(kept.lop, ["6A1"], "bí danh lớp (6/1) được chuẩn hoá về tên lớp chuẩn, lưu dạng mảng");
  assert.equal(kept.gioihan, "1");
  assert.equal(result.data.pccmMatrix["6A1|AV-GT"], "AV.KCuong, Gems1");
  assert.deepEqual(result.data.tkb.L001.thu2.sang, ["","X3","","",""], "ô của dòng không GV giữ nguyên; ô của dòng mồ côi bị gỡ");
  assert.deepEqual(Object.keys(result.data.pccmMatrix).sort(), ["6A1|AV-GT", "6A1|TOAN"], "dòng không GV không có khoá trong bảng GV");
  assert.equal(result.data.pccmTietMatrix["6A1|X3"], "2", "nhưng vẫn chiếu Số tiết");
  assert.equal(result.data.pccmGioihanMatrix["6A1|X3"], "2");
  assert.deepEqual(result.data.dayGhepProjected, ["6A1|AV-GT", "6A1|X3"]);
});

test("02/09 dòng không giáo viên: chiếu Tiết/Giới hạn, ổn định qua nhiều lần nạp, bỏ hết GV thì gỡ khoá GV cũ", () => {
  const context = loadApp();
  const first = sync(context, baseData({
    dayGhep:[
      {id:"DG001", lop:["6A1","6A2"], mon:["AVGT"], gv:[], sotiet:"1", gioihan:"1", viettat:"Hội trường"}
    ]
  }));
  assert.equal(first.data.dayGhep.length, 1);
  assert.equal(first.data.dayGhep[0].ten, "Hội trường");
  assert.equal(first.data.pccmMatrix["6A1|Hội trường"], undefined);
  assert.equal(first.data.pccmMatrix["6A2|Hội trường"], undefined);
  assert.equal(first.data.pccmTietMatrix["6A1|Hội trường"], "1");
  assert.equal(first.data.pccmTietMatrix["6A2|Hội trường"], "1");
  assert.equal(first.data.pccmGioihanMatrix["6A1|Hội trường"], "1");
  assert.deepEqual(first.data.dayGhepProjected, ["6A1|Hội trường", "6A2|Hội trường"]);

  const second = sync(context, first.data);
  assert.equal(second.changed, false, "nạp lại không đổi gì (khoá Tiết không bị app.js dọn như phân công mồ côi)");
  assert.equal(second.data.pccmTietMatrix["6A1|Hội trường"], "1");

  const keys = JSON.parse(vm.runInContext(`JSON.stringify({
    no: Array.from(dayGhepNoTeacherKeySet()).sort(),
    owned: Array.from(dayGhepOwnedKeySet()).sort(),
    has: dayGhepHasNoTeacher(DATA.dayGhep[0])
  })`, context));
  assert.deepEqual(keys, {no:["6a1|hội trường", "6a2|hội trường"], owned:["6a1|hội trường", "6a2|hội trường"], has:true});

  // Dòng đang có GV -> bỏ hết GV: khoá GV và GV bộ giải ghi nhớ bị gỡ, Tiết/Giới hạn giữ
  const withTeacher = sync(context, baseData({
    dayGhep:[{id:"DG001", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong"], sotiet:"2", gioihan:"2", viettat:"CLB"}]
  }));
  assert.equal(withTeacher.data.pccmMatrix["6A1|CLB"], "AV.KCuong");
  withTeacher.data.dayGhep[0].gv = [];
  withTeacher.data.tkbLessonTeachers = {"6A1|CLB":"AV.KCuong", "6A1|TOAN":"NDiep"};
  const dropped = sync(context, withTeacher.data);
  assert.equal(dropped.data.pccmMatrix["6A1|CLB"], undefined);
  assert.equal(dropped.data.tkbLessonTeachers["6A1|CLB"], undefined);
  assert.equal(dropped.data.tkbLessonTeachers["6A1|TOAN"], "NDiep");
  assert.equal(dropped.data.pccmTietMatrix["6A1|CLB"], "2");
  assert.equal(dropped.data.pccmGioihanMatrix["6A1|CLB"], "2");
});

test("dòng nhiều môn: tên gợi ý nối '/'; dữ liệu cũ lưu môn dạng chuỗi được chuẩn hoá; tổng tiết cộng mọi dòng", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    monhoc:[
      {id:"MH001", ten:"Anh văn giao tiếp", ma:"AVGT"},
      {id:"MH002", ten:"Toán", ma:"TOAN"},
      {id:"MH003", ten:"Tin học", ma:"TIN"},
      {id:"MH004", ten:"Công nghệ", ma:"CN"}
    ],
    dayGhep:[
      {id:"DG001", lop:"6A1", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", viettat:"AV-GT"},
      {id:"DG002", lop:"6A1", mon:["CN","TIN","XYZ"], gv:["AV.KCuong","NDiep"], sotiet:"2", gioihan:"1", viettat:""}
    ]
  }));
  assert.deepEqual(result.data.dayGhep[0].mon, ["AVGT"]);
  assert.deepEqual(result.data.dayGhep[1].mon, ["CN","TIN"], "môn không còn trong danh mục bị loại, thứ tự giữ nguyên");
  assert.equal(result.data.dayGhep[1].viettat, "CN/TIN 6A1", "viết tắt trống -> tên gợi ý Mã môn/Mã môn + Lớp");
  assert.equal(result.data.pccmMatrix["6A1|AV-GT"], "AV.KCuong, Gems1");
  assert.equal(result.data.pccmMatrix["6A1|CN/TIN 6A1"], "AV.KCuong, NDiep");
  assert.equal(result.data.pccmTietMatrix["6A1|CN/TIN 6A1"], "2");
  const totals = JSON.parse(vm.runInContext(`JSON.stringify({
    all: dayGhepPeriodsWhere(null),
    kcuong: dayGhepPeriodsWhere(e => dayGhepTeachers(e).includes("AV.KCuong"))
  })`, context));
  assert.deepEqual(totals, { all:4, kcuong:4 }, "huy hiệu tổng của trang Dạy ghép");
  assert.equal(typeof context.dayGhepPeriodsForClass, "undefined", "Phân công không còn cộng tiết ghép");
});

test("dòng nhiều lớp = các lớp học chung: một khoá ảo cho mỗi lớp, một tên chung; bỏ lớp khỏi dòng thì gỡ khoá lớp đó", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    monhoc:[
      {id:"MH001", ten:"Anh văn giao tiếp", ma:"AVGT"},
      {id:"MH002", ten:"Toán", ma:"TOAN"},
      {id:"MH003", ten:"Câu lạc bộ thể thao", ma:"CLBTT"}
    ],
    dayGhep:[
      {id:"DG001", lop:["6A1","6A2"], mon:["CLBTT"], gv:["AV.KCuong","NDiep"], sotiet:"1", gioihan:"1", viettat:"CLB-TT"}
    ]
  }));
  assert.deepEqual(result.data.dayGhep[0].lop, ["6A1","6A2"]);
  assert.equal(result.data.dayGhep[0].ten, "CLB-TT");
  assert.equal(result.data.pccmMatrix["6A1|CLB-TT"], "AV.KCuong, NDiep");
  assert.equal(result.data.pccmMatrix["6A2|CLB-TT"], "AV.KCuong, NDiep");
  assert.equal(result.data.pccmTietMatrix["6A2|CLB-TT"], "1");
  assert.deepEqual(result.data.dayGhepProjected, ["6A1|CLB-TT", "6A2|CLB-TT"]);
  const auto = JSON.parse(vm.runInContext(`JSON.stringify(dayGhepAutoName({lop:["6A1","6A2"], mon:["CLBTT"]}))`, context));
  assert.equal(auto, "CLBTT (6A1, 6A2)");

  // lớp 6A2 bị xóa -> dòng còn 6A1; ô TKB (lưu tên viết tắt) giữ nguyên
  const shrunk = sync(context, Object.assign(result.data, {
    lop:[{id:"L001", ten:"6A1", ten2:"6/1", khoi:"Khối 6"}],
    tkb:{L001:{thu2:{sang:[{mon:"CLB-TT", fixed:true},"","","",""], chieu:["","","","",""]}}}
  }));
  assert.deepEqual(shrunk.data.dayGhep[0].lop, ["6A1"]);
  assert.deepEqual(shrunk.data.tkb.L001.thu2.sang[0], {mon:"CLB-TT", fixed:true});
  assert.equal(shrunk.data.pccmMatrix["6A1|CLB-TT"], "AV.KCuong, NDiep");
  assert.equal(shrunk.data.pccmMatrix["6A2|CLB-TT"], undefined);
  assert.deepEqual(shrunk.data.dayGhepProjected, ["6A1|CLB-TT"]);
});

test("trường codinh cũ bị dọn; sửa dòng: bỏ lớp -> gỡ ô lớp đó, đổi tên -> ô đổi tên", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    monhoc:[
      {id:"MH001", ten:"Anh văn giao tiếp", ma:"AVGT"},
      {id:"MH002", ten:"Toán", ma:"TOAN"},
      {id:"MH003", ten:"Hoạt động trải nghiệm 1", ma:"HĐTN 1"}
    ],
    dayGhep:[
      {id:"DG001", lop:["6A1","6A2"], mon:["HĐTN 1"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", hienthi:"auto", codinh:{thu:"thu2", buoi:"sang", tiet:0}}
    ],
    tkb:{
      L001:{thu2:{sang:[{mon:"HĐTN 1", fixed:true},"","","",""], chieu:["","","","",""]}},
      L002:{thu2:{sang:[{mon:"HĐTN 1", fixed:true},"","","",""], chieu:["","","","",""]}}
    }
  }));
  assert.equal(Object.prototype.hasOwnProperty.call(result.data.dayGhep[0], "codinh"), false, "trường codinh (phiên bản cũ) bị bỏ");
  assert.equal(result.data.dayGhep[0].ten, "HĐTN 1 (6A1, 6A2)");
  assert.deepEqual(result.data.tkb.L001.thu2.sang[0], {mon:"HĐTN 1 (6A1, 6A2)", fixed:true}, "ô môn thật của dòng cũ đổi sang tên ghép");

  const edited = JSON.parse(vm.runInContext(`(function(){
    const list = dayGhepList();
    const prev = list[0];
    const entry = {id: prev.id, lop:["6A1"], mon:["HĐTN 1"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"SHDC"};
    entry.ten = dayGhepResolveIdentity(entry, new Set());   // như dayGhepAccept
    dayGhepRemoveTkbCells("6A2", dayGhepCellNames(prev));
    dayGhepRenameTkbCells("6A1", dayGhepCellNames(prev), dayGhepIdentity(entry));
    list[0] = entry;
    syncDayGhepProjection();
    return JSON.stringify(DATA);
  })()`, context));
  assert.deepEqual(edited.tkb.L001.thu2.sang[0], {mon:"SHDC", fixed:true});
  assert.equal(edited.tkb.L002.thu2.sang[0], "");
  assert.equal(edited.pccmMatrix["6A1|SHDC"], "AV.KCuong");
  assert.equal(edited.pccmMatrix["6A1|HĐTN 1 (6A1, 6A2)"], undefined);
  assert.equal(edited.pccmMatrix["6A2|HĐTN 1 (6A1, 6A2)"], undefined);
  assert.equal(edited.dayGhep[0].ten, "SHDC");
});

test("xóa Môn/Lớp/GV cốt lõi thì Dạy ghép cũng trống như Phân công", () => {
  const context = loadApp();
  const result = sync(context, baseData({
    giaovien:[],
    dayGhep:[{id:"DG001", lop:"6A1", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", viettat:"AV-GT"}],
    dayGhepProjected:["6A1|AV-GT"]
  }));
  assert.deepEqual(result.data.dayGhep, []);
  assert.deepEqual(result.data.pccmMatrix, {});
  assert.deepEqual(result.data.dayGhepProjected, []);
});

test("đổi mã môn học chỉ đổi khoá môn tham chiếu của dòng; tên viết tắt, ô TKB và khoá ảo giữ nguyên", () => {
  const context = loadApp();
  sync(context, baseData({
    dayGhep:[
      {id:"DG001", lop:"6A1", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"2", gioihan:"2", viettat:"AV-GT"},
      {id:"DG002", lop:"6A2", mon:["AVGT","TOAN"], gv:["AV.KCuong","NDiep"], sotiet:"1", gioihan:"1", viettat:"AV+T"}
    ],
    tkb:{
      L001:{thu2:{sang:["AV-GT","","","",""], chieu:["","","","",""]}},
      L002:{thu2:{sang:["","AV+T","","",""], chieu:["","","","",""]}}
    }
  }));
  const result = JSON.parse(vm.runInContext(`(function(){
    const previous = {...DATA.monhoc[0]};
    DATA.monhoc[0] = {...DATA.monhoc[0], ma:"AVGT2"};
    propagateMonhocRename(previous, DATA.monhoc[0]);
    return JSON.stringify(DATA);
  })()`, context));
  assert.deepEqual(result.dayGhep[0].mon, ["AVGT2"]);
  assert.deepEqual(result.dayGhep[1].mon, ["AVGT2","TOAN"]);
  assert.equal(result.dayGhep[0].ten, "AV-GT");
  assert.equal(result.tkb.L001.thu2.sang[0], "AV-GT");
  assert.equal(result.tkb.L002.thu2.sang[1], "AV+T");
  assert.equal(result.pccmMatrix["6A1|AV-GT"], "AV.KCuong, Gems1");
  assert.equal(result.pccmMatrix["6A2|AV+T"], "AV.KCuong, NDiep");
});

test("tổng tiết Phân công chỉ đếm môn thật, không cộng tiết dạy ghép", () => {
  const context = loadApp();
  sync(context, baseData({
    pccmMatrix:{"6A1|TOAN":"NDiep", "6A1|AVGT":"NDiep"},
    dayGhep:[{id:"DG001", lop:"6A1", mon:"AVGT", gv:["AV.KCuong","Gems1"], sotiet:"1", gioihan:"1", viettat:"AV-GT"}]
  }));
  const totals = JSON.parse(vm.runInContext(`(function(){
    const monList = buildPCCMMonList().filter(m => monHasPositiveTietChuanAnyKhoi(m));
    return JSON.stringify({
      cls: pccmComputeTotalTietForClass("6A1", monList),
      gv: pccmComputeTotalTietForTeacher("Gems1", ["6A1","6A2"], monList),
      ndiep: pccmComputeTotalTietForTeacher("NDiep", ["6A1","6A2"], monList),
      mon: pccmComputeTotalTietForSubject("AVGT", ["6A1","6A2"], monList)
    });
  })()`, context));
  assert.equal(totals.cls.assigned, 6);   // TOAN 4 + AVGT 2 (phân công chính); ghép không tính
  assert.equal(totals.cls.ghep, undefined);
  assert.equal(totals.gv.assigned, 0);
  assert.equal(totals.ndiep.assigned, 6);
  assert.equal(totals.mon.assigned, 2);
});

test("ô Giáo viên trong Phân công là ô chọn MỘT người; giá trị nhiều GV cũ vẫn được giữ", () => {
  const context = loadApp();
  sync(context, baseData());
  const html = JSON.parse(vm.runInContext(`JSON.stringify({
    single: pccmRenderTeacherSelect("pccm_gv_0", "AV.KCuong", [{code:"AV.KCuong"},{code:"Gems1"}]),
    legacy: pccmRenderTeacherSelect("pccm_gv_1", "AV.KCuong, Gems1", [{code:"AV.KCuong"},{code:"Gems1"}]),
    empty: pccmRenderTeacherSelect("pccm_gv_2", "", [{code:"AV.KCuong"}])
  })`, context));
  assert.match(html.single, /<select id="pccm_gv_0"/);
  assert.doesNotMatch(html.single, /pccm-multi/);
  assert.match(html.single, /value="AV.KCuong" selected/);
  assert.match(html.legacy, /value="AV.KCuong, Gems1" selected/);
  assert.match(html.legacy, /dạy ghép cũ/);
  assert.match(html.empty, /\(Chưa phân\)/);
  assert.equal(typeof context.pccmRenderTeacherMulti, "undefined");

  const quick = JSON.parse(vm.runInContext(`JSON.stringify({
    teacher: pccmQuickSelectedValues("teacher", ["AV.KCuong","Gems1"], ["AV.KCuong","Gems1"]),
    subject: pccmQuickSelectedValues("subject", ["AVGT","TOAN"], ["AVGT","TOAN"]),
    cls: pccmQuickSelectedValues("class", ["6A1","6A2"], ["6A1","6A2"])
  })`, context));
  assert.deepEqual(quick.teacher, ["AV.KCuong"]);
  assert.deepEqual(quick.subject, ["AVGT"]);
  assert.deepEqual(quick.cls, ["6A1","6A2"]);
});
