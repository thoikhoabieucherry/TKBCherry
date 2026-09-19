"use strict";

// 31/08: Trường 0l2vcan0xx1 cố định "Chào cờ" ở Thứ 2 / sáng / tiết 1 cho 59 lớp → F5 là mất sạch.
// Nguyên nhân: di sản v1.69 `migrateRemoveLegacyDefaultFixedEvents()` chạy trong DOMContentLoaded của
// planner, xóa ô "Chào cờ" (thu2/sang/0) và "SHL" (thu6/chieu/cuối) rồi saveStore() → kho bị ghi đè.
// Test khóa: (1) mã nguồn không còn hàm/lời gọi đó; (2) chạy khối khởi tạo DOMContentLoaded với DATA
// có Chào cờ + SHL cố định đúng hai ô "nhạy cảm" → ô giữ nguyên, không lưu gì.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

const INIT_START = 'document.addEventListener("DOMContentLoaded", () => {\n  // Dong bo theo du lieu index';
const INIT_END = 'document.addEventListener("DOMContentLoaded", () => {\n  try{\n    window.__TKB_PLANNER_DOM_READY = true;';

function initBlock(){
  const a = SRC.indexOf(INIT_START);
  assert.ok(a >= 0, "khong thay khoi khoi tao DOMContentLoaded cua planner");
  const b = SRC.indexOf(INIT_END, a + INIT_START.length);
  assert.ok(b > a, "khong thay khoi DOMContentLoaded thu hai (DOM_READY)");
  return SRC.slice(a, b);
}

function sampleData(){
  const CHIEU = 5;
  const mk = () => {
    const t = {};
    for(const thu of ["thu2","thu3","thu4","thu5","thu6","thu7"]){
      t[thu] = {sang: ["","","","",""], chieu: ["","","","",""]};
    }
    t.thu2.sang[0] = {mon: "Chào cờ", fixed: true};
    t.thu6.chieu[CHIEU - 1] = {mon: "SHL", fixed: true};
    t.thu3.sang[1] = {mon: "Toán", fixed: true};
    return t;
  };
  return {
    lop: [{id: "L001", ten: "6A1"}, {id: "L002", ten: "6A2"}],
    tkb: {L001: mk(), L002: mk()},
    tkbConfig: {fixed: [{ten: "Chào cờ", thu: "thu2", buoi: "sang", tiet: 0}], off: []},
    _lastModified: 100
  };
}

test("phanmon.js khong con hàm dọn 'Chào cờ'/'SHL' mặc định chạy lúc tải trang", () => {
  assert.equal(/function\s+migrateRemoveLegacyDefaultFixedEvents\s*\(/.test(SRC), false,
    "migrateRemoveLegacyDefaultFixedEvents() đã bị gỡ (xóa ô Chào cờ thu2/sang/0 mỗi lần F5) — không được thêm lại");
  assert.equal(/migrateRemoveLegacyDefaultFixedEvents\s*\(\s*\)\s*;/.test(SRC), false,
    "không được gọi lại migrateRemoveLegacyDefaultFixedEvents() ở bất kỳ đâu");
});

test("DOMContentLoaded của planner giữ nguyên ô Chào cờ (thu2/sang/1) và SHL (thu6/chiều/cuối) cố định, không lưu", () => {
  const calls = {save: 0, deferSave: 0};
  let onReady = null;
  const document = {
    addEventListener(type, fn){ if(type === "DOMContentLoaded") onReady = fn; },
    getElementById(){ return null; }
  };
  const window = {addEventListener(){}, requestIdleCallback: undefined};
  const ctx = {
    window, document, console, JSON, Object, Array, Map, Set, String, Number, Date,
    setTimeout, clearTimeout,
    DATA: sampleData(),
    CHIEU: 5, SANG: 5,
    cellMon(v){ if(v === "OFF" || v === "" || v == null) return ""; if(typeof v === "string") return v; return (v && v.mon) || ""; },
    saveStore(){ calls.save++; return true; },
    deferInitialSaveStore(){ calls.deferSave++; },
    sanitizePlannerDataFromIndex(){ return false; },
    migrateInvalidPartialSchedule(){ return false; },
    installTKBHotkeysOnce(){},
    initKhoiOptions(){},
    setViewMode(){},
    initRightPanelCollapse(){}
  };
  vm.createContext(ctx);
  vm.runInContext(initBlock(), ctx, {filename: "phanmon-init-slice.js"});
  assert.ok(typeof onReady === "function", "khối khởi tạo phải đăng ký DOMContentLoaded");
  onReady();

  for(const id of ["L001", "L002"]){
    const t = ctx.DATA.tkb[id];
    assert.deepEqual(t.thu2.sang[0], {mon: "Chào cờ", fixed: true}, `${id}: ô Chào cờ thứ 2 tiết 1 phải còn nguyên sau khi tải trang`);
    assert.deepEqual(t.thu6.chieu[4], {mon: "SHL", fixed: true}, `${id}: ô SHL thứ 6 chiều tiết cuối phải còn nguyên`);
    assert.deepEqual(t.thu3.sang[1], {mon: "Toán", fixed: true}, `${id}: ô cố định thường không bị đụng`);
  }
  assert.equal(ctx.DATA.tkbConfig.fixed.length, 1, "tkbConfig.fixed do người dùng đặt không bị lọc bỏ");
  assert.equal(calls.save, 0, "không được saveStore() ngay lúc tải trang khi dữ liệu không đổi");
  assert.equal(calls.deferSave, 0, "không có gì để dọn thì không hẹn lưu");
});
