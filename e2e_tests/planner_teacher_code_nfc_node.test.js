"use strict";

// 31/08: Trường 0l2vcan0xx1 — GV "ĐP.Hà" hiện 2 lần ở danh sách GV của trang Sắp xếp: vị trí 53
// (dòng thật, mã lưu dạng NFD "Ha" + U+0300 vì dán từ Mac/Excel) không có tiết, còn một "người"
// trùng mã (chuỗi NFC từ phân công) nằm cuối danh sách. Test khoá: (1) chỉ mục mã GV so sánh sau
// NFC → NFD/NFC là một; (2) sanitizePlannerDataFromIndex chuẩn hoá DATA tại chỗ nhưng KHÔNG tính là
// thay đổi (không ép lưu lúc tải trang); (3) điểm nạp từ máy chủ cũng chuẩn hoá.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const STORAGE_PATH = path.resolve(__dirname, "..", "web", "shared", "storage.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");
const STORAGE_SRC = fs.readFileSync(STORAGE_PATH, "utf8");

function sliceBetween(src, startMarker, endMarker){
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return src.slice(a, b);
}
// Hàm top-level của phanmon.js kết thúc bằng "\n}\n" ở cột 0.
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
    window: {}, console, JSON, Object, Array, Map, Set, String, Number,
    DATA: data,
    // phụ thuộc của sanitizePlannerDataFromIndex — không liên quan tới NFC, stub trung tính
    plannerBuildCanonicalClassAliasMap(){ return new Map(); },
    remapPlannerClassObjectMap(){ return false; },
    normalizeClassSubjectMatrixByAliases(){ return false; },
    pruneRedundantPccmPeriodMatrices(){ return false; },
    pruneLessonTeacherConflicts(){ return 0; },
    invalidatePccmNumCaches(){},
    COMPUTE_MONS_CACHE: null, REQUIRED_SUBJECTS_CACHE: null, TEACHER_FOR_CLASS_MON_CACHE: null, ROOM_FOR_CLASS_MON_CACHE: null
  };
  vm.createContext(ctx);
  // hàm chuẩn hoá thật từ shared/storage.js
  vm.runInContext(sliceBetween(STORAGE_SRC, "  function normalizeUnicodeNFC(root){", "  function addUnique(list, value){")
    + "\nwindow.TKBStorage = { normalizeUnicodeNFC };", ctx, {filename: "storage-slice.js"});
  const code = [
    sliceBetween(SRC, "let TEACHER_CODE_INDEX = ", "\n") ,
    sliceFn("tkbNormalizeDataNFC"), sliceFn("tkbNFC"), sliceFn("sanitizePlannerDataFromIndex"),
    sliceFn("invalidateTeacherCodeIndex"), sliceFn("ensureTeacherCodeIndex"), sliceFn("resolveTeacherCode"),
    sliceFn("teacherOrderIndex"), sliceFn("teacherListFromValue")
  ].join("\n");
  vm.runInContext(code, ctx, {filename: "phanmon-slice.js"});
  return ctx;
}

test("tiền đề: hai dạng của cùng một mã khác byte", () => {
  assert.notEqual(NFD, NFC);
  assert.equal(NFD.normalize("NFC"), NFC);
});

test("chỉ mục mã GV: mã NFD trong bảng GV và chuỗi NFC trong phân công là MỘT giáo viên", () => {
  const ctx = load({
    lop: [{id: "L001"}],
    giaovien: [{magv: "Toán.An", hodem: "Lê", ten: "An"}, {magv: NFD, hodem: "Nguyễn Thị".normalize("NFD"), ten: "Hà".normalize("NFD")}],
    pccmMatrix: {"6A3|GDĐP": NFC, "6A4|GDĐP": NFC},
    tkb: {}
  });
  const run = (js) => vm.runInContext(js, ctx);
  const resolvedFromPccm = run(`resolveTeacherCode(${JSON.stringify(NFC)})`);
  const resolvedFromList = run(`resolveTeacherCode(${JSON.stringify(NFD)})`);
  assert.equal(resolvedFromPccm, resolvedFromList, "hai dạng phải quy về cùng một mã");
  assert.equal(resolvedFromPccm, NFC, "mã trả về ở dạng NFC");
  assert.equal(run(`teacherOrderIndex(${JSON.stringify(NFC)})`), 1, "giữ đúng vị trí trong bảng GV, không rơi xuống cuối (MAX_SAFE_INTEGER)");
  // [...] để mảng sinh trong vm (khác realm, khác Array.prototype) so được bằng deepStrictEqual
  assert.deepEqual([...run(`teacherListFromValue(${JSON.stringify(NFD + ", " + NFC)})`)], [NFC], "danh sách GV không nhân đôi");
  // tra theo họ tên cũng không phân biệt dạng
  assert.equal(run(`resolveTeacherCode("Nguyễn Thị Hà")`), NFC);
});

test("sanitizePlannerDataFromIndex chuẩn hoá DATA tại chỗ (mã, tên, khoá) nhưng không báo 'thay đổi'", () => {
  const giaovien = [{magv: NFD, hodem: "Nguyễn Thị".normalize("NFD"), ten: "Hà".normalize("NFD")}];
  const ctx = load({
    lop: [{id: "L001"}],
    giaovien,
    pccmMatrix: {"6A3|GDĐP": NFC},
    tkbConstraints: {fixedOff: {teacher: {[NFD]: {thu2: {sang: [true]}}}}},
    tkb: {}
  });
  const changed = vm.runInContext("sanitizePlannerDataFromIndex()", ctx);
  assert.equal(changed, false, "chuẩn hoá Unicode không được ép deferInitialSaveStore lúc tải trang");
  assert.equal(ctx.DATA.giaovien, giaovien, "giữ tham chiếu mảng");
  assert.equal(ctx.DATA.giaovien[0].magv, NFC);
  assert.equal(ctx.DATA.giaovien[0].ten, "Hà");
  assert.equal(ctx.DATA.giaovien[0].hodem, "Nguyễn Thị");
  assert.deepEqual(Object.keys(ctx.DATA.tkbConstraints.fixedOff.teacher), [NFC], "khoá nghỉ cố định đổi tên theo mã NFC");
});

test("điểm nạp dữ liệu từ máy chủ (DATA = remoteData) cũng chuẩn hoá NFC trước khi dùng", () => {
  const hydration = sliceBetween(SRC, "          DATA = remoteData;", "          try { renderCurrentView(); }");
  assert.ok(/tkbNormalizeDataNFC\(DATA\)/.test(hydration), "thiếu tkbNormalizeDataNFC ngay sau DATA = remoteData");
  const adopt = sliceFn("tkbAdoptRemoteData");
  assert.ok(/sanitizePlannerDataFromIndex\(\)/.test(adopt), "tkbAdoptRemoteData đi qua sanitize (có NFC)");
});
