"use strict";

// 31/08: Trang Dữ liệu (app.js) là nơi chuỗi NFD lọt vào kho (dán tên GV từ Mac/Excel → mã tự sinh
// "ĐP.Hà" cũng NFD, trong khi phân công lưu NFC từ chỉ mục) → trang Sắp xếp thấy 2 giáo viên.
// Test khoá: (1) appNormalizeDataNFC chuẩn hoá DATA tại chỗ qua TKBStorage.normalizeUnicodeNFC;
// (2) syncDerivedDataIntegrity (nạp) và saveStore (lưu) đều gọi nó; (3) chỉ mục mã GV của app
// so sánh sau NFC.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const APP_PATH = path.resolve(__dirname, "..", "web", "app.js");
const STORAGE_PATH = path.resolve(__dirname, "..", "web", "shared", "storage.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");
const STORAGE_SRC = fs.readFileSync(STORAGE_PATH, "utf8");

function sliceBetween(src, startMarker, endMarker){
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return src.slice(a, b);
}
// Hàm top-level của app.js kết thúc bằng "\n}\n" ở cột 0.
function sliceFn(name){
  const start = "function " + name + "(";
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, "khong thay ham: " + name);
  const b = SRC.indexOf("\n}\n", a);
  assert.ok(b > a, "khong thay ket thuc ham: " + name);
  return SRC.slice(a, b + 3);
}

const NFC = "ĐP.Hà".normalize("NFC");
const NFD = NFC.normalize("NFD");

function load(data){
  const ctx = {
    window: {}, console, JSON, Object, Array, Map, Set, String, Number, DATA: data,
    _NORM_TEXT_CACHE: new Map(), _NORM_TEXT_CACHE_MAX: 20000   // bộ đệm của _normText (khai báo ở nơi khác trong app.js)
  };
  vm.createContext(ctx);
  vm.runInContext(sliceBetween(STORAGE_SRC, "  function normalizeUnicodeNFC(root){", "  function addUnique(list, value){")
    + "\nwindow.TKBStorage = { normalizeUnicodeNFC };", ctx, {filename: "storage-slice.js"});
  const code = [
    sliceFn("_normTextRaw"), sliceFn("_normText"), sliceFn("appNormalizeDataNFC"),
    sliceBetween(SRC, "let _TEACHER_CODE_INDEX = null;", "function invalidateTeacherCodeIndex(){"),
    sliceFn("invalidateTeacherCodeIndex"), sliceFn("teacherCodeIndex"), sliceFn("resolveTeacherCode")
  ].join("\n");
  vm.runInContext(code, ctx, {filename: "app-slice.js"});
  return ctx;
}

test("appNormalizeDataNFC chuẩn hoá DATA tại chỗ và báo có thay đổi; lần hai không đổi", () => {
  const giaovien = [{magv: NFD, hodem: "Nguyễn Thị".normalize("NFD"), ten: "Hà".normalize("NFD")}];
  const ctx = load({giaovien, pccmMatrix: {"6A3|GDĐP": NFC}, tkbConstraints: {fixedOff: {teacher: {[NFD]: {}}}}});
  assert.equal(vm.runInContext("appNormalizeDataNFC()", ctx), true);
  assert.equal(ctx.DATA.giaovien, giaovien);
  assert.equal(ctx.DATA.giaovien[0].magv, NFC);
  assert.equal(ctx.DATA.giaovien[0].hodem, "Nguyễn Thị");
  assert.deepEqual(Object.keys(ctx.DATA.tkbConstraints.fixedOff.teacher), [NFC]);
  assert.equal(vm.runInContext("appNormalizeDataNFC()", ctx), false);
  // thiếu TKBStorage (cache cũ) -> không ném lỗi, trả false
  vm.runInContext("window.TKBStorage = null", ctx);
  assert.equal(vm.runInContext("appNormalizeDataNFC()", ctx), false);
});

test("syncDerivedDataIntegrity (nạp) và saveStore (lưu) đều đi qua appNormalizeDataNFC", () => {
  const integrity = sliceFn("syncDerivedDataIntegrity");
  assert.ok(/changed = appNormalizeDataNFC\(\) \|\| changed/.test(integrity), "nạp: chuẩn hoá và tính là thay đổi để lưu lại kho");
  const save = sliceFn("saveStore");
  const call = save.indexOf("appNormalizeDataNFC()");
  const stringify = save.indexOf("JSON.stringify(DATA)");
  assert.ok(call >= 0, "saveStore phải gọi appNormalizeDataNFC");
  assert.ok(stringify > call, "chuẩn hoá phải xảy ra TRƯỚC khi JSON.stringify(DATA) để bản lưu là NFC");
});

test("chỉ mục mã GV của app: mã NFD trong bảng và chuỗi NFC ở phân công là một; tra theo tên cũng vậy", () => {
  const ctx = load({giaovien: [{magv: NFD, hodem: "Nguyễn Thị".normalize("NFD"), ten: "Hà".normalize("NFD")}]});
  const run = (js) => vm.runInContext(js, ctx);
  assert.equal(run(`resolveTeacherCode(${JSON.stringify(NFC)})`), NFC);
  assert.equal(run(`resolveTeacherCode(${JSON.stringify(NFD)})`), NFC);
  assert.equal(run(`resolveTeacherCode(${JSON.stringify("Nguyễn Thị Hà".normalize("NFD"))})`), NFC, "họ tên NFD vẫn tra ra mã");
  assert.equal(run(`resolveTeacherCode("")`), "");
  assert.equal(run(`resolveTeacherCode(null)`), "");
  assert.equal(run(`resolveTeacherCode("GV.La")`), "GV.La", "mã lạ giữ nguyên (nhập tự do)");
});
