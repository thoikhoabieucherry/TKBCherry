// File .cherry (02/09/2026, web/modules/cherry-file.js): nút cạnh "Dạy ghép" xuất / nhập trọn bộ kho
// của trường đang mở (Khối/Lớp/GV/Môn/Tiết chuẩn/Phân công/Dạy ghép/Yêu cầu/TKB đã xếp) dưới tên
// <mã trường>.cherry; nhập = thay toàn bộ kho sau khi xác nhận, đi qua appAdoptRemoteData + saveStore.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "web", "app.js");
const MODULE_PATH = path.join(__dirname, "..", "web", "modules", "cherry-file.js");
const DAY_GHEP_PATH = path.join(__dirname, "..", "web", "modules", "day-ghep.js");
const HTML_PATH = path.join(__dirname, "..", "web", "app.html");
const APP_SOURCE = fs.readFileSync(APP_PATH, "utf8");
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const DAY_GHEP_SOURCE = fs.readFileSync(DAY_GHEP_PATH, "utf8");
const HTML_SOURCE = fs.readFileSync(HTML_PATH, "utf8");

function storageStub(){
  return { length:0, getItem(){ return null; }, setItem(){}, removeItem(){}, key(){ return null; } };
}

function loadApp(){
  const localStorage = storageStub();
  const sessionStorage = storageStub();
  const sectionContent = {innerHTML:"", querySelector(){ return null; }, querySelectorAll(){ return []; }};
  const created = [];
  const elements = {"section-content": sectionContent};
  const makeEl = tag => {
    const el = {
      tagName:String(tag || "").toUpperCase(), style:{}, dataset:{}, children:[], listeners:{},
      classList:{add(){}, remove(){}, toggle(){}, contains(){ return false; }},
      setAttribute(){}, getAttribute(){ return null; }, querySelector(){ return null; }, querySelectorAll(){ return []; },
      appendChild(child){ this.children.push(child); return child; },
      addEventListener(type, fn){ (this.listeners[type] = this.listeners[type] || []).push(fn); },
      click(){ this.clicked = (this.clicked || 0) + 1; },
      remove(){ this.removed = true; }
    };
    created.push(el);
    return el;
  };
  const document = {
    addEventListener(){},
    removeEventListener(){},
    getElementById(id){ return elements[id] || null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(tag){ return makeEl(tag); },
    documentElement:{appendChild(){}},
    body:{appendChild(el){ if (el && el.id) elements[el.id] = el; }, insertAdjacentHTML(){}}
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
  const confirms = [];
  const state = {confirmAnswer:true};
  const context = vm.createContext({
    window, document, localStorage, sessionStorage, location,
    history:window.history, navigator:window.navigator,
    URL:{createObjectURL(){ return "blob:test"; }, revokeObjectURL(){}},
    URLSearchParams, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm(message){ confirms.push(String(message)); return state.confirmAnswer; },
    alert(message){ alerts.push(String(message)); },
    prompt(){ return null; },
    indexedDB:{open(){ return {}; }},
    FileReader:function(){},
    Blob:class Blob { constructor(parts, opts){ this.parts = parts; this.type = opts && opts.type; } },
    TextEncoder, TextDecoder,
    requestAnimationFrame(fn){ fn(); }
  });
  vm.runInContext(APP_SOURCE, context, {filename:APP_PATH});
  vm.runInContext(DAY_GHEP_SOURCE, context, {filename:DAY_GHEP_PATH});
  vm.runInContext(MODULE_SOURCE, context, {filename:MODULE_PATH});
  // saveStore: ghi nhận lời gọi, vẫn trả Promise như bản thật (không có TKBStorage -> localStorage stub)
  vm.runInContext(`
    __saves = [];
    (function(){ const real = saveStore; saveStore = function(o){ __saves.push(o || {}); return real(o); }; })();
  `, context);
  context.__alerts = alerts;
  context.__confirms = confirms;
  context.__state = state;
  context.__created = created;
  context.__elements = elements;
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
      {id:"GV002", magv:"NDiep", hodem:"Trần", ten:"Điệp"}
    ],
    monhoc:[
      {id:"MH001", ten:"Anh văn giao tiếp", ma:"AVGT"},
      {id:"MH002", ten:"Toán", ma:"TOAN"}
    ],
    mon:[
      {id:"M001", khoi:"Khối 6", ten:"AVGT", sotiet:"2", gioihan:"2"},
      {id:"M002", khoi:"Khối 6", ten:"TOAN", sotiet:"4", gioihan:"2"}
    ],
    pccmMatrix:{"6A1|TOAN":"NDiep", "6A2|TOAN":"NDiep", "6A1|AVGT":"AV.KCuong"},
    pccmTietMatrix:{},
    pccmGioihanMatrix:{},
    dayGhep:[{id:"DG001", lop:["6A1","6A2"], mon:["AVGT"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"CLB AV", ten:"CLB AV"}],
    tkbUserOff:{L001:["thu7|chieu|0"]},
    tkbConstraints:{
      fixedOff:{class:{L001:{"thu7|chieu|0":true}}, teacher:{"NDiep":{"thu2|sang|0":true, "thu2|sang|1":true}}, subject:{}, room:{}, subjectGroup:{}},
      teacher:{"NDiep":{oneSessionPerDay:true}},
      subject:{TOAN:{byClass:{L001:{lessonBlocks:{2:{min:1}}, sessionAllowed:{allowMorning:true, allowAfternoon:false}}}}}
    },
    tkb:{
      L001:{thu2:{sang:["", {mon:"TOAN", fixed:true}, "TOAN", "", ""], chieu:["", "", "", "", ""]}, thu7:{sang:["", "", "", "", ""], chieu:["OFF", "", "", "", ""]}},
      L002:{thu3:{sang:["AVGT", "", "", "", ""], chieu:["", "", "", "", ""]}}
    }
  }, extra || {});
}

function sync(context, data){
  const source = JSON.stringify(data);
  return JSON.parse(vm.runInContext(
    `(function(){ DATA=${source}; ensureDataShape(); const changed = syncDerivedDataIntegrity(); return JSON.stringify({data:DATA, changed}); })()`,
    context
  ));
}

function dataOf(context){
  return JSON.parse(vm.runInContext(`JSON.stringify(DATA)`, context));
}

test("app.html: nút 'File .cherry' đứng ngay sau 'Dạy ghép' và nạp modules/cherry-file.js", () => {
  const navIdx = HTML_SOURCE.indexOf(`data-page="dayghep"`);
  const btnIdx = HTML_SOURCE.indexOf(`onclick="cherryFileOpen()"`);
  assert.ok(navIdx > 0 && btnIdx > navIdx, "nút .cherry phải nằm sau nút Dạy ghép");
  const between = HTML_SOURCE.slice(navIdx, btnIdx);
  assert.ok(!/data-page=/.test(between.slice(20)), "không có nút trang nào chen giữa Dạy ghép và File .cherry");
  assert.ok(/<script[^>]*src="modules\/cherry-file\.js\?v=[^"]+"/.test(HTML_SOURCE), "thẻ script mô-đun cherry-file");
});

test("Xuất: tên <mã trường>.cherry, bọc format/version/schoolId, data là toàn bộ DATA (kể cả Yêu cầu, TKB, Dạy ghép)", () => {
  const context = loadApp();
  sync(context, baseData());
  const out = JSON.parse(vm.runInContext(`JSON.stringify(cherryFileBuildExport())`, context));
  assert.equal(out.name, "default.cherry");
  const payload = JSON.parse(out.text);
  assert.equal(payload.format, "tkbcherry");
  assert.equal(payload.version, 1);
  assert.equal(payload.schoolId, "default");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(payload.exportedAt));
  assert.deepEqual(payload.data, dataOf(context), "data trong file = DATA đang giữ");
  assert.equal(payload.data.tkbConstraints.teacher.NDiep.oneSessionPerDay, true);
  assert.equal(payload.data.tkb.L001.thu2.sang[1].fixed, true);
  assert.equal(payload.data.dayGhep.length, 1);
  assert.deepEqual(payload.summary, {khoi:1, lop:2, giaovien:2, monhoc:2, tietchuan:2, phancong:5, dayGhep:1, tkbCells:3, yeuCau:6});
});

test("cherryFileExport() tải file qua thẻ <a download>", () => {
  const context = loadApp();
  sync(context, baseData());
  const name = vm.runInContext(`cherryFileExport()`, context);
  assert.equal(name, "default.cherry");
  const anchor = context.__created.find(el => el.tagName === "A");
  assert.ok(anchor, "phải tạo thẻ a");
  assert.equal(anchor.download, "default.cherry");
  assert.equal(anchor.href, "blob:test");
  assert.equal(anchor.clicked, 1);
});

test("Nhập (round-trip): xuất rồi nhập lại vào kho khác -> DATA = nội dung file, saveStore được gọi, hộp xác nhận nêu số liệu hai bên", async () => {
  const context = loadApp();
  sync(context, baseData());
  const out = JSON.parse(vm.runInContext(`JSON.stringify(cherryFileBuildExport())`, context));
  const exported = JSON.parse(out.text).data;

  // Kho hiện tại khác hẳn (1 lớp, không TKB, không luật)
  sync(context, {
    khoi:[{id:"K001", ten:"Khối 7"}],
    lop:[{id:"L009", ten:"7A9", ten2:"7/9", khoi:"Khối 7"}],
    giaovien:[{id:"GV009", magv:"X.Y", hodem:"", ten:"Y"}],
    monhoc:[{id:"MH009", ten:"Sử", ma:"SU"}],
    mon:[], pccmMatrix:{}, pccmTietMatrix:{}, pccmGioihanMatrix:{}, tkb:{}
  });
  vm.runInContext(`__saves.length = 0`, context);
  const ok = await vm.runInContext(`cherryFileImportText(${JSON.stringify(out.text)}, "default.cherry")`, context);
  assert.equal(ok, true);
  const after = dataOf(context);
  assert.deepEqual(after.lop.map(l => l.ten), ["6A1", "6A2"]);
  assert.deepEqual(after.giaovien.map(g => g.magv), ["AV.KCuong", "NDiep"]);
  assert.deepEqual(after.tkbConstraints, exported.tkbConstraints, "Yêu cầu giữ nguyên");
  assert.deepEqual(after.tkb, exported.tkb, "TKB đã xếp (kể cả ô cố định) giữ nguyên");
  assert.deepEqual(after.tkbUserOff, exported.tkbUserOff);
  assert.equal(after.dayGhep.length, 1);
  assert.equal(after.pccmMatrix["6A1|TOAN"], "NDiep");
  assert.ok(Number(after._lastModified) > 0, "saveStore đóng dấu thời gian mới");
  const saves = JSON.parse(vm.runInContext(`JSON.stringify(__saves)`, context));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].force, true);
  const confirmMsg = context.__confirms.at(-1);
  assert.ok(/Nội dung file: 2 lớp · 2 giáo viên/.test(confirmMsg), confirmMsg);
  assert.ok(/HIỆN TẠI của "[^"]+": 1 lớp · 1 giáo viên/.test(confirmMsg), confirmMsg);
  assert.ok(/THAY THẾ/.test(confirmMsg));
  assert.ok(/✔ Đã nhập file \.cherry/.test(context.__alerts.at(-1)), context.__alerts.at(-1));
});

test("Nhập: bấm Hủy ở hộp xác nhận -> không đổi DATA, không lưu", async () => {
  const context = loadApp();
  const before = sync(context, baseData()).data;
  context.__state.confirmAnswer = false;
  const foreign = JSON.stringify({format:"tkbcherry", version:1, schoolId:"abc123", schoolName:"THCS Khác", exportedAt:"2026-09-02T01:02:03.000Z",
    data:{lop:[{id:"L1", ten:"9A1", ten2:"9A1", khoi:"Khối 9"}], giaovien:[], monhoc:[], mon:[], tkb:{}}});
  vm.runInContext(`__saves.length = 0`, context);
  const ok = await vm.runInContext(`cherryFileImportText(${JSON.stringify(foreign)}, "abc123.cherry")`, context);
  assert.equal(ok, false);
  assert.deepEqual(dataOf(context), before, "DATA giữ nguyên");
  assert.equal(vm.runInContext(`__saves.length`, context), 0);
  const confirmMsg = context.__confirms.at(-1);
  assert.ok(/mã trường "abc123", còn trường đang mở là "default"/.test(confirmMsg), "cảnh báo file thuộc trường khác: " + confirmMsg);
  assert.ok(/THCS Khác/.test(confirmMsg));
});

test("cherryFileParse: từ chối JSON hỏng / sai format / file rỗng; nhận kho thô không bọc; cảnh báo version mới hơn", () => {
  const context = loadApp();
  sync(context, baseData());
  const parse = text => JSON.parse(vm.runInContext(`JSON.stringify(cherryFileParse(${JSON.stringify(text)}))`, context));
  assert.equal(parse("{oops").ok, false);
  assert.equal(parse("[1,2]").ok, false);
  assert.equal(parse(JSON.stringify({hello:"world"})).ok, false);
  assert.equal(parse(JSON.stringify({format:"tkbcherry", version:1})).ok, false, "thiếu data");
  const empty = parse(JSON.stringify({format:"tkbcherry", version:1, data:{lop:[], giaovien:[], tkb:{}}}));
  assert.equal(empty.ok, false);
  assert.ok(/không có dữ liệu/i.test(empty.error), empty.error);
  const raw = parse(JSON.stringify({lop:[{id:"L1", ten:"6A1"}], giaovien:[], pccmMatrix:{"6A1|TOAN":"GV"}}));
  assert.equal(raw.ok, true, "kho thô (dump kvstore) được nhận");
  assert.equal(raw.meta.wrapped, false);
  assert.equal(raw.summary.lop, 1);
  const newer = parse(JSON.stringify({format:"tkbcherry", version:9, schoolId:"x", data:{lop:[{id:"L1", ten:"6A1"}]}}));
  assert.equal(newer.ok, true);
  assert.equal(newer.warnings.length, 1);
  assert.ok(/phiên bản mới hơn/.test(newer.warnings[0]));
});

test("Nhập file sai định dạng: báo lỗi, DATA giữ nguyên", async () => {
  const context = loadApp();
  const before = sync(context, baseData()).data;
  const ok = await vm.runInContext(`cherryFileImportText("not json at all", "x.cherry")`, context);
  assert.equal(ok, false);
  assert.deepEqual(dataOf(context), before);
  assert.ok(/❌ Không đọc được file/.test(context.__alerts.at(-1)), context.__alerts.at(-1));
  assert.equal(context.__confirms.length, 0, "không hỏi xác nhận khi file hỏng");
});
