"use strict";

// 31/08/2026: mục Dạy ghép có Xuất Excel / Nhập Excel như các mục khác (chủ dự án: "mục dạy ghép mình có
// thể tạo xuất excel và import excel như các mục khác ko"). File: STT | Viết tắt | Lớp học | Môn học |
// Giáo viên | Số tiết | Giới hạn. Nhập: kiểm tra lớp/môn/GV có trong danh mục (sai -> báo, không nhập gì);
// dòng trùng Viết tắt + cùng bộ Lớp -> cập nhật dòng đang có (nhập lại file vừa xuất không nhân đôi).

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
  const captured = {};
  const XLSX = {
    utils: {
      json_to_sheet(rows, opts){ return {rows, header: opts && opts.header}; },
      aoa_to_sheet(aoa){ return {aoa}; },
      book_new(){ return {SheetNames: [], Sheets: {}}; },
      book_append_sheet(wb, ws, name){ wb.SheetNames.push(name); wb.Sheets[name] = ws; },
      encode_range(){ return "A1"; },
      sheet_to_json(){ return []; }
    },
    writeFile(wb, name, opts){ captured.wb = wb; captured.name = name; captured.opts = opts; }
  };
  const window = {
    document, localStorage, sessionStorage, location,
    history:{replaceState(){}},
    navigator:{},
    addEventListener(){}, removeEventListener(){},
    setTimeout, clearTimeout, setInterval, clearInterval,
    TKBAuth:null, TKBSchool:null, XLSX
  };
  window.window = window;
  const alerts = [];
  const context = vm.createContext({
    window, document, localStorage, sessionStorage, location, XLSX,
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
  context.__captured = captured;
  context.__section = sectionContent;
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

function importRows(context, rows){
  const ok = vm.runInContext(`importExcel_DayGhep(${JSON.stringify(rows)})`, context);
  const data = JSON.parse(vm.runInContext(`JSON.stringify(DATA)`, context));
  return {ok, data};
}

test("trang Dạy ghép có nút Nhập Excel / Xuất Excel; app.js chuyển nhập mục 'dayghep' sang mô-đun", () => {
  const context = loadApp();
  sync(context, baseData({dayGhep:[]}));
  vm.runInContext(`renderDayGhepPage("section-content")`, context);
  const html = context.__section.innerHTML;
  assert.ok(html.includes(`onclick="triggerExcel('dayghep')"`), "nút Nhập Excel");
  assert.ok(html.includes(`onclick="dayGhepExportExcel()"`), "nút Xuất Excel");
  assert.ok(/IMPORT_SECTION==="dayghep"[\s\S]*importExcel_DayGhep\(rows\)/.test(APP_SOURCE), "importFromExcel phải rẽ nhánh sang importExcel_DayGhep");
});

test("Xuất Excel: một sheet 'dayghep', cột STT | Viết tắt | Lớp học | Môn học | Giáo viên | Số tiết | Giới hạn", () => {
  const context = loadApp();
  sync(context, baseData({
    dayGhep:[
      {id:"DG001", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong","Gems1"], sotiet:"1", gioihan:"1", viettat:"AV-GT"},
      {id:"DG002", lop:["6A1","6A2"], mon:["TOAN"], gv:["NDiep"], sotiet:"2", gioihan:"2", viettat:"CLB Toán"}
    ]
  }));
  vm.runInContext(`dayGhepExportExcel()`, context);
  const cap = context.__captured;
  assert.equal(cap.name, "dayghep.xlsx");
  assert.deepEqual(cap.wb.SheetNames, ["dayghep"]);
  const ws = cap.wb.Sheets.dayghep;
  // JSON round-trip: mảng/object sinh trong vm khác realm (khác prototype) nên deepStrictEqual trực tiếp sẽ lệch
  assert.deepEqual(JSON.parse(JSON.stringify(ws.header)), ["STT", "Viết tắt", "Lớp học", "Môn học", "Giáo viên", "Số tiết", "Giới hạn"]);
  assert.deepEqual(JSON.parse(JSON.stringify(ws.rows)), [
    {"STT":1, "Viết tắt":"AV-GT", "Lớp học":"6A1", "Môn học":"AVGT", "Giáo viên":"AV.KCuong, Gems1", "Số tiết":"1", "Giới hạn":"1"},
    {"STT":2, "Viết tắt":"CLB Toán", "Lớp học":"6A1, 6A2", "Môn học":"TOAN", "Giáo viên":"NDiep", "Số tiết":"2", "Giới hạn":"2"}
  ]);
  assert.ok(Array.isArray(ws["!cols"]) && ws["!cols"].length === 7, "độ rộng cột");
});

test("Nhập Excel thêm dòng: nhận bí danh lớp 6/1, tên môn, họ tên GV, Số tiết dạng số, Giới hạn trống = 1, Viết tắt trống = tên tự động", () => {
  const context = loadApp();
  sync(context, baseData({dayGhep:[]}));
  const {ok, data} = importRows(context, [
    {"STT":1, "Viết tắt":"AV-GT", "Lớp học":"6/1", "Môn học":"Anh văn giao tiếp", "Giáo viên":"Nguyễn Cương, gems1", "Số tiết":1, "Giới hạn":""},
    {"STT":2, "Viết tắt":"", "Lớp học":"6A1, 6A2", "Môn học":"TOAN", "Giáo viên":"NDiep", "Số tiết":2, "Giới hạn":2},
    {"STT":3, "Viết tắt":"Hội trường", "Lớp học":"6A1, 6A2", "Môn học":"AVGT", "Giáo viên":"", "Số tiết":1, "Giới hạn":1},   // 02/09: không GV
    {"STT":"", "Viết tắt":"", "Lớp học":"", "Môn học":"", "Giáo viên":"", "Số tiết":"", "Giới hạn":""}   // dòng trống: bỏ qua
  ]);
  assert.equal(ok, true);
  assert.equal(data.dayGhep.length, 3);
  const [a, b, c] = data.dayGhep;
  assert.deepEqual(c.gv, [], "cột Giáo viên trống = tiết không giáo viên");
  assert.equal(c.ten, "Hội trường");
  assert.equal(data.pccmMatrix["6A1|Hội trường"], undefined);
  assert.equal(data.pccmTietMatrix["6A1|Hội trường"], "1");
  assert.equal(data.pccmTietMatrix["6A2|Hội trường"], "1");
  assert.deepEqual(a.lop, ["6A1"]);
  assert.deepEqual(a.mon, ["AVGT"], "tên môn -> khoá môn (mã)");
  assert.deepEqual(a.gv, ["AV.KCuong", "Gems1"], "họ tên / mã viết thường -> mã GV chuẩn");
  assert.equal(a.sotiet, "1");
  assert.equal(a.gioihan, "1");
  assert.equal(a.viettat, "AV-GT");
  assert.equal(a.ten, "AV-GT");
  assert.equal(a.id, "DG001");
  assert.deepEqual(b.lop, ["6A1", "6A2"]);
  assert.equal(b.viettat, "TOAN (6A1, 6A2)", "viết tắt trống -> tên tự động");
  assert.equal(b.id, "DG002");
  // chiếu vào bảng phân công như khi thêm bằng hộp thoại
  assert.equal(data.pccmMatrix["6A1|AV-GT"], "AV.KCuong, Gems1");
  assert.equal(data.pccmTietMatrix["6A1|AV-GT"], "1");
  assert.equal(data.pccmMatrix["6A2|TOAN (6A1, 6A2)"], "NDiep");
  assert.equal(data.pccmMatrix["6A1|TOAN"], "NDiep", "phân công chính không đụng");
  const msg = context.__alerts.at(-1);
  assert.ok(/Thêm mới: 3 dòng/.test(msg), msg);
  assert.ok(!/Cập nhật/.test(msg));
});

test("Nhập Excel dòng sai (lớp / môn / GV không có, Số tiết sai): báo từng dòng và KHÔNG nhập gì", () => {
  const context = loadApp();
  const before = sync(context, baseData({
    dayGhep:[{id:"DG001", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong"], sotiet:"1", gioihan:"1", viettat:"AV-GT"}]
  })).data;
  const {ok, data} = importRows(context, [
    {"Viết tắt":"X1", "Lớp học":"6A1", "Môn học":"AVGT", "Giáo viên":"AV.KCuong", "Số tiết":1},          // hợp lệ
    {"Viết tắt":"X2", "Lớp học":"9A9", "Môn học":"AVGT", "Giáo viên":"AV.KCuong", "Số tiết":1},          // lớp lạ
    {"Viết tắt":"X3", "Lớp học":"6A1", "Môn học":"LÝ", "Giáo viên":"AV.KCuong", "Số tiết":1},            // môn lạ
    {"Viết tắt":"X4", "Lớp học":"6A1", "Môn học":"AVGT", "Giáo viên":"GV.La", "Số tiết":1},              // GV lạ
    {"Viết tắt":"X5", "Lớp học":"6A1", "Môn học":"AVGT", "Giáo viên":"AV.KCuong", "Số tiết":"hai"}       // số tiết sai
  ]);
  assert.equal(ok, false);
  assert.deepEqual(data.dayGhep, before.dayGhep, "không nhập dòng nào khi có lỗi");
  const msg = context.__alerts.at(-1);
  assert.ok(/Dòng 3: .*9A9/.test(msg), msg);
  assert.ok(/Dòng 4: .*LÝ/.test(msg), msg);
  assert.ok(/Dòng 5: .*GV\.La/.test(msg), msg);
  assert.ok(/Dòng 6: .*Số tiết/.test(msg), msg);
  assert.ok(!/Dòng 2:/.test(msg), "dòng hợp lệ không bị báo");
});

test("Nhập lại file vừa xuất: dòng trùng Viết tắt + Lớp được cập nhật, không nhân đôi, ô TKB giữ nguyên", () => {
  const context = loadApp();
  const tkb = {L001: {thu2: {sang: ["", {mon:"AV-GT", fixed:true}, "", "", ""], chieu: ["", "", "", "", ""]}}};
  sync(context, baseData({
    dayGhep:[
      {id:"DG001", lop:["6A1"], mon:["AVGT"], gv:["AV.KCuong","Gems1"], sotiet:"1", gioihan:"1", viettat:"AV-GT"},
      {id:"DG002", lop:["6A1","6A2"], mon:["TOAN"], gv:["NDiep"], sotiet:"2", gioihan:"2", viettat:"CLB Toán"}
    ],
    tkb
  }));
  vm.runInContext(`dayGhepExportExcel()`, context);
  const exported = context.__captured.wb.Sheets.dayghep.rows.map(r => { const o = Object.assign({}, r); delete o.STT; return o; });
  // sửa vài giá trị như người dùng sửa trong Excel: GV dòng 1 chỉ còn 1 người, số tiết dòng 2 thành 3
  exported[0]["Giáo viên"] = "AV.KCuong";
  exported[1]["Số tiết"] = 3;
  const {ok, data} = importRows(context, exported);
  assert.equal(ok, true);
  assert.equal(data.dayGhep.length, 2, "không nhân đôi");
  assert.deepEqual(data.dayGhep[0].gv, ["AV.KCuong"]);
  assert.equal(data.dayGhep[0].id, "DG001");
  assert.equal(data.dayGhep[0].ten, "AV-GT");
  assert.equal(data.dayGhep[1].sotiet, "3");
  assert.equal(data.dayGhep[1].id, "DG002");
  assert.equal(data.pccmMatrix["6A1|AV-GT"], "AV.KCuong");
  assert.equal(data.pccmTietMatrix["6A2|CLB Toán"], "3");
  assert.deepEqual(data.tkb.L001.thu2.sang[1], {mon:"AV-GT", fixed:true}, "tiết cố định của dòng vẫn còn");
  const msg = context.__alerts.at(-1);
  assert.ok(/Thêm mới: 0 dòng/.test(msg) && /Cập nhật \(trùng Viết tắt \+ Lớp học\): 2 dòng/.test(msg), msg);
});

test("thiếu danh mục (chưa có Giáo viên) -> báo, không nhập", () => {
  const context = loadApp();
  sync(context, baseData({giaovien:[], dayGhep:[]}));
  const {ok, data} = importRows(context, [{"Viết tắt":"X", "Lớp học":"6A1", "Môn học":"AVGT", "Giáo viên":"AV.KCuong", "Số tiết":1}]);
  assert.equal(ok, false);
  assert.equal((data.dayGhep || []).length, 0);
  assert.ok(/Cần có Lớp học, Môn học và Giáo viên/.test(context.__alerts.at(-1)));
});
