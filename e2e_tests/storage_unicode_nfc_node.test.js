"use strict";

// 31/08: TKBStorage.normalizeUnicodeNFC — chuẩn hoá Unicode NFC tại chỗ cho toàn bộ DATA trường.
// Bối cảnh: trường 0l2vcan0xx1 có dòng GV "ĐP.Hà" dán từ Mac/Excel ở dạng NFD ("Ha" + U+0300)
// trong khi phân công lưu NFC (U+00E0) → planner thấy 2 giáo viên. Hàm này chạy ở mọi điểm nạp/lưu.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STORAGE_PATH = path.resolve(__dirname, "..", "web", "shared", "storage.js");
const SRC = fs.readFileSync(STORAGE_PATH, "utf8");

function sliceBetween(startMarker, endMarker){
  const a = SRC.indexOf(startMarker);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return SRC.slice(a, b);
}

function loadNormalizer(){
  const ctx = { Set, Object, String, Array };
  vm.createContext(ctx);
  vm.runInContext(sliceBetween("  function normalizeUnicodeNFC(root){", "  function addUnique(list, value){"), ctx, {filename: "storage-nfc-slice.js"});
  return vm.runInContext("normalizeUnicodeNFC", ctx);
}

// Sinh dạng NFD bằng normalize("NFD") để không phụ thuộc trình soạn thảo/công cụ có tự chuẩn hoá chuỗi hay không.
const NFC = "ĐP.Hà".normalize("NFC");            // "à" dựng sẵn U+00E0
const NFD = NFC.normalize("NFD");                 // "à" = a + U+0300 (dấu huyền tách rời)
const NAME_NFD = "Nguyễn Thị".normalize("NFD");   // ê + ngã, i + nặng tách rời

test("normalizeUnicodeNFC được xuất trong window.TKBStorage", () => {
  const exportBlock = sliceBetween("  window.TKBStorage = {", "  };");
  assert.ok(/\bnormalizeUnicodeNFC,/.test(exportBlock), "phải có trong object xuất để app.js/phanmon.js gọi được");
});

test("chuỗi NFD trong giá trị, phần tử mảng và KHOÁ đều về NFC; giữ nguyên tham chiếu object", () => {
  const normalize = loadNormalizer();
  assert.notEqual(NFD, NFC, "tiền đề: hai chuỗi khác byte");
  const giaovien = [{magv: NFD, hodem: NAME_NFD, ten: "Hà", id: 53}];
  const pccm = {["6A3|GDĐP"]: NFD, ["6A4|GDĐP"]: NFC};
  const constraints = {fixedOff: {teacher: {[NFD]: {thu2: {sang: [true]}}}}};
  const data = {giaovien, pccmMatrix: pccm, tkbConstraints: constraints, _lastModified: 123, flag: true, nothing: null};
  const changed = normalize(data);
  assert.equal(changed, true);
  assert.equal(data.giaovien, giaovien, "mảng giaovien vẫn là cùng tham chiếu");
  assert.equal(data.giaovien[0].magv, NFC);
  assert.equal(data.giaovien[0].ten, "Hà");
  assert.equal(data.giaovien[0].hodem, "Nguyễn Thị");
  assert.equal(data.giaovien[0].id, 53);
  assert.equal(data.pccmMatrix["6A3|GDĐP"], NFC);
  assert.equal(data.pccmMatrix["6A4|GDĐP"], NFC);
  assert.deepEqual(Object.keys(data.tkbConstraints.fixedOff.teacher), [NFC], "khoá NFD được đổi tên sang NFC");
  assert.deepEqual(data.tkbConstraints.fixedOff.teacher[NFC], {thu2: {sang: [true]}});
  assert.equal(data._lastModified, 123);
  assert.equal(data.flag, true);
  assert.equal(data.nothing, null);
  // idempotent
  assert.equal(normalize(data), false, "lần hai không còn gì để đổi");
});

test("khoá trùng nhau sau chuẩn hoá: giữ giá trị của khoá NFC sẵn có, bỏ bản NFD", () => {
  const normalize = loadNormalizer();
  const a = {[NFC]: "giữ", [NFD]: "bỏ"};
  normalize(a);
  assert.deepEqual(a, {[NFC]: "giữ"});
  const b = {[NFD]: "bỏ", [NFC]: "giữ"};   // thứ tự ngược lại
  normalize(b);
  assert.deepEqual(b, {[NFC]: "giữ"});
});

test("dữ liệu đã NFC / không phải object: trả false và không đụng gì", () => {
  const normalize = loadNormalizer();
  const data = {giaovien: [{magv: NFC}], tkb: {L001: {thu2: {sang: ["Toán", {mon: "Chào cờ", fixed: true}, "OFF", ""]}}}};
  const before = JSON.stringify(data);
  assert.equal(normalize(data), false);
  assert.equal(JSON.stringify(data), before);
  assert.equal(normalize(null), false);
  assert.equal(normalize("x"), false);
  assert.equal(normalize(42), false);
});
