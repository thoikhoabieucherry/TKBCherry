"use strict";

// 31/08: trường ow14iqw5cb1 — "bấm ▶ FET, các tiết tôi ghép nó tự xếp vào TKB và cố định luôn".
// Ghim tạm (tkbJointPinForSolve: {mon, fixed:true, jointPin:true} ở mọi lớp của dòng ghép nhiều lớp)
// chỉ có nghĩa TRONG lượt giải và được gỡ khi cờ bận tắt; nhưng pin có saveStoreDeferred nên nếu trang
// bị tải lại / đóng giữa lượt thì ô ghim nằm lại trong kho và không còn cờ bận nào để gỡ. Test khoá:
// tkbJointClearStalePins() trả ô ghim về ô thường khi KHÔNG giải, giữ ô người dùng tự cố định, không
// đụng gì khi đang giải; và được gọi ở mọi điểm nạp dữ liệu.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function sliceFn(name){
  const start = "function " + name + "(";
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, "khong thay ham: " + name);
  const b = SRC.indexOf("\n}\n", a);
  assert.ok(b > a, "khong thay ket thuc ham: " + name);
  return SRC.slice(a, b + 3);
}

function grid(cells){
  const t = {};
  for(const thu of ["thu2", "thu3"]) t[thu] = {sang: ["", "", "", "", ""], chieu: ["", "", "", "", ""]};
  Object.entries(cells || {}).forEach(([key, v]) => { const [thu, buoi, ti] = key.split("|"); t[thu][buoi][Number(ti)] = v; });
  return t;
}

function load(opts = {}){
  const calls = {snapshot: 0};
  const ctx = {
    window: {}, console, JSON, Object, Array, Map, Set, String, Number,
    DAYS: ["thu2", "thu3"],
    DATA: opts.data,
    __TKB_JOINT_PINNED: opts.pinned || [{classId: "L1", thu: "thu2", buoi: "sang", ti: 0, key: "Chào cờ (ghép)"}],
    isPlannerBusySolving(){ return !!opts.busy; },
    tkbJointTakeSnapshot(){ calls.snapshot++; }
  };
  vm.createContext(ctx);
  vm.runInContext([sliceFn("cellMon"), sliceFn("isFixed"), sliceFn("tkbJointClearStalePins")].join("\n"), ctx, {filename: "phanmon-slice.js"});
  ctx.__calls = calls;
  return ctx;
}

test("ô ghim tạm còn sót -> ô thường; ô người dùng tự cố định và ô thường giữ nguyên", () => {
  const data = {tkb: {
    L1: grid({"thu2|sang|0": {mon: "Chào cờ (ghép)", fixed: true, jointPin: true}, "thu2|sang|1": {mon: "Toán", fixed: true}, "thu2|sang|2": "Văn"}),
    L2: grid({"thu2|sang|0": {mon: "Chào cờ (ghép)", fixed: true, jointPin: true}, "thu3|sang|0": "OFF"})
  }};
  const ctx = load({data});
  const n = vm.runInContext("tkbJointClearStalePins()", ctx);
  assert.equal(n, 2);
  assert.equal(ctx.DATA.tkb.L1.thu2.sang[0], "Chào cờ (ghép)");
  assert.equal(ctx.DATA.tkb.L2.thu2.sang[0], "Chào cờ (ghép)");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.DATA.tkb.L1.thu2.sang[1])), {mon: "Toán", fixed: true}, "ô người dùng tự cố định giữ nguyên");
  assert.equal(ctx.DATA.tkb.L1.thu2.sang[2], "Văn");
  assert.equal(ctx.DATA.tkb.L2.thu3.sang[0], "OFF");
  assert.equal(ctx.__TKB_JOINT_PINNED.length, 0, "sổ ghim cũ được xoá");
  assert.equal(ctx.__calls.snapshot, 1);
  assert.equal(vm.runInContext("tkbJointClearStalePins()", ctx), 0, "lần hai không còn gì");
});

test("đang giải thì không đụng ô ghim", () => {
  const data = {tkb: {L1: grid({"thu2|sang|0": {mon: "Chào cờ (ghép)", fixed: true, jointPin: true}})}};
  const ctx = load({data, busy: true});
  assert.equal(vm.runInContext("tkbJointClearStalePins()", ctx), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.DATA.tkb.L1.thu2.sang[0])), {mon: "Chào cờ (ghép)", fixed: true, jointPin: true});
});

test("được gọi ở mọi điểm nạp dữ liệu: DOMContentLoaded, nạp từ máy chủ, tkbAdoptRemoteData", () => {
  const init = SRC.slice(SRC.indexOf('document.addEventListener("DOMContentLoaded", () => {\n  // Dong bo theo du lieu index'), SRC.indexOf('document.addEventListener("DOMContentLoaded", () => {\n  try{\n    window.__TKB_PLANNER_DOM_READY = true;'));
  assert.ok(/tkbJointClearStalePins\(\)/.test(init), "DOMContentLoaded");
  assert.ok(!/deferInitialSaveStore\("stale-joint-pins"\)/.test(init), "không ép lưu lúc tải trang");
  const hydration = SRC.slice(SRC.indexOf("          DATA = remoteData;"), SRC.indexOf("          try { renderCurrentView(); }"));
  assert.ok(/tkbJointClearStalePins\(\)/.test(hydration), "hydration");
  assert.ok(/tkbJointClearStalePins\(\)/.test(sliceFn("tkbAdoptRemoteData")), "tkbAdoptRemoteData");
});
