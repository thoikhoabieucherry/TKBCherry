"use strict";

// 30/08: Hai tab Dữ liệu + Sắp xếp cùng mở. Trước đây planner ghi đè kho bằng bản nó
// đang giữ mỗi khi ẩn tab / tải lại (flushDeferredSaveStore luôn saveStore force) → mọi
// sửa đổi vừa lưu ở trang Dữ liệu (đổi tên môn/GV, xoá môn, xoá phân công…) bị xoá sạch.
// Test khoá: (1) flush chỉ ghi khi CÓ thay đổi chưa lưu; (2) quay lại tab mà không có thay
// đổi chưa lưu → nạp bản mới hơn từ kho; có thay đổi / đang giải → giữ nguyên.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function slice(startMarker, endMarker){
  const a = SRC.indexOf(startMarker);
  assert.ok(a >= 0, "khong thay: " + startMarker);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, "khong thay ket thuc: " + endMarker);
  return SRC.slice(a, b);
}

const BLOCK = slice("let __tkbDeferredSaveTimer = null;", "function saveStoreDeferred(){");

function load(opts = {}){
  const calls = {save:0, render:0, monList:0, status:[]};
  const listeners = {doc:[], win:[]};
  const document = {
    visibilityState: "visible",
    addEventListener(type, fn){ listeners.doc.push({type, fn}); }
  };
  const window = {
    addEventListener(type, fn){ listeners.win.push({type, fn}); },
    TKBStorage: {
      loadRemoteSchoolData: async () => opts.remote === undefined ? null : opts.remote,
      hasMeaningfulData: (d) => !!(d && (d.lop?.length || d.tkb))
    },
    TKBConstraints: { invalidateConstraintCache(){} }
  };
  const ctx = {
    window, document, console, JSON, Object, Array, Map, Set, String, Number, Date, Promise,
    setTimeout, clearTimeout,
    DATA: opts.data || {lop:[{id:"L1"}], tkb:{}, _lastModified: 100},
    __tkbLastSavedPayload: "", __tkbPendingSavePayload: "",
    schoolParam: "truongtest", dragData: null, VIEW_MODE: "lop",
    TKB_HISTORY_CURRENT: "", TKB_UNDO_STACK: ["x"], TKB_REDO_STACK: ["y"],
    COMPUTE_MONS_CACHE: null, REQUIRED_SUBJECTS_CACHE: null, TEACHER_FOR_CLASS_MON_CACHE: null, ROOM_FOR_CLASS_MON_CACHE: null,
    saveStore(o){ calls.save++; calls.lastOpts = o; return true; },
    isPlannerBusySolving(){ return !!opts.busy; },
    __tkbAlgorithmRunning(){ return !!opts.running; },
    sanitizePlannerDataFromIndex(){ return false; }, tkbJointTakeSnapshot(){},
    invalidateTeacherCodeIndex(){}, invalidateClassKeyCandidatesCache(){}, invalidatePccmNumCaches(){},
    __tkbRememberStablePayload(){}, __tkbCurrentSaveStats(){ return {total:0, assigned:0, missing:0}; },
    __tkbUpdateHistoryButtons(){}, initKhoiOptions(){}, showAllGV(){}, showAllLop(){},
    renderCurrentView(){ calls.render++; }, scheduleLoadMonList(){ calls.monList++; }, loadMonList(){ calls.monList++; },
    _setStatus(msg, type){ calls.status.push([msg, type]); }
  };
  Object.defineProperty(window, "DATA", { get(){ return ctx.DATA; }, set(v){ ctx.DATA = v; } });
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx, {filename: "phanmon-slice.js"});
  ctx.__calls = calls;
  ctx.__listeners = listeners;
  return ctx;
}

test("flushDeferredSaveStore does NOT write when the planner has nothing unsaved", () => {
  const ctx = load();
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA);`, ctx);
  vm.runInContext(`flushDeferredSaveStore();`, ctx);
  assert.equal(ctx.__calls.save, 0, "bản đang giữ = bản đã lưu -> không ghi đè kho");
  // chưa có mốc so sánh (vừa mở trang, chưa sửa gì) -> cũng không ghi
  const ctx2 = load();
  vm.runInContext(`flushDeferredSaveStore();`, ctx2);
  assert.equal(ctx2.__calls.save, 0);
});

test("flushDeferredSaveStore still writes when DATA changed or a deferred save is pending", () => {
  const ctx = load();
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA); DATA.tkb.L1 = {thu2:{sang:["Toán"]}};`, ctx);
  vm.runInContext(`flushDeferredSaveStore();`, ctx);
  assert.equal(ctx.__calls.save, 1);
  assert.equal(ctx.__calls.lastOpts.beforeUnload, true);

  const ctx2 = load();
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA); __tkbDeferredSaveTimer = setTimeout(()=>{}, 60000);`, ctx2);
  vm.runInContext(`flushDeferredSaveStore();`, ctx2);
  assert.equal(ctx2.__calls.save, 1, "còn hẹn lưu -> phải đẩy ngay");
  assert.equal(vm.runInContext(`__tkbDeferredSaveTimer`, ctx2), null);
});

test("tkbRemoteDataDiffers compares timestamps first, then key-order-insensitive JSON", () => {
  const ctx = load();
  assert.equal(vm.runInContext(`tkbRemoteDataDiffers({lop:[{id:"L1"}], tkb:{}, _lastModified:100})`, ctx), false);
  assert.equal(vm.runInContext(`tkbRemoteDataDiffers({lop:[{id:"L1"}], tkb:{}, _lastModified:101})`, ctx), true);
  const ctx2 = load({data:{lop:[{id:"L1", ten:"6A1"}], tkb:{}}});
  // máy chủ trả khoá đã sắp thứ tự -> vẫn coi là cùng bản
  assert.equal(vm.runInContext(`tkbRemoteDataDiffers({tkb:{}, lop:[{ten:"6A1", id:"L1"}]})`, ctx2), false);
  assert.equal(vm.runInContext(`tkbRemoteDataDiffers({tkb:{}, lop:[{ten:"6A2", id:"L1"}]})`, ctx2), true);
});

test("returning to the tab with nothing unsaved adopts the newer store copy and re-renders", async () => {
  const remote = {lop:[{id:"L1"}], tkb:{L1:{thu2:{sang:["Văn"]}}}, monhoc:[{ten:"Văn"}], _lastModified: 200};
  const ctx = load({remote});
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA);`, ctx);
  const adopted = await vm.runInContext(`tkbRefreshFromRemoteIfIdle("visible")`, ctx);
  assert.equal(adopted, true);
  assert.equal(ctx.DATA._lastModified, 200);
  assert.equal(JSON.stringify(ctx.DATA.tkb.L1.thu2.sang), JSON.stringify(["Văn"]));
  assert.equal(ctx.__calls.render, 1);
  assert.equal(ctx.__calls.monList, 1);
  assert.equal(ctx.__calls.save, 0, "nạp bản mới không được ghi ngược lên kho");
  assert.equal(vm.runInContext(`__tkbLastSavedPayload === JSON.stringify(DATA)`, ctx), true, "mốc so sánh phải trỏ vào bản vừa nạp");
  assert.equal(ctx.TKB_UNDO_STACK.length, 0, "lịch sử Undo của bản cũ phải bỏ");
  assert.equal(ctx.__calls.status.length, 1);
  // cùng mốc -> lần sau không nạp lại (và chống nảy 1.5 s)
  const again = await vm.runInContext(`__tkbRemoteRefreshLastAt = 0; tkbRefreshFromRemoteIfIdle("focus")`, ctx);
  assert.equal(again, false);
  assert.equal(ctx.__calls.render, 1);
});

test("returning to the tab with local unsaved changes, or while solving, keeps the planner copy", async () => {
  const remote = {lop:[{id:"L1"}], tkb:{L1:{thu2:{sang:["Văn"]}}}, _lastModified: 200};
  const ctx = load({remote});
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA); DATA.tkb.L1 = {thu2:{sang:["Toán"]}};`, ctx);
  assert.equal(await vm.runInContext(`tkbRefreshFromRemoteIfIdle("visible")`, ctx), false);
  assert.equal(JSON.stringify(ctx.DATA.tkb.L1.thu2.sang), JSON.stringify(["Toán"]));
  assert.equal(ctx.__calls.render, 0);

  const busy = load({remote, busy:true});
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA);`, busy);
  assert.equal(await vm.runInContext(`tkbRefreshFromRemoteIfIdle("visible")`, busy), false);
  assert.equal(busy.DATA._lastModified, 100);

  const hidden = load({remote});
  hidden.document.visibilityState = "hidden";
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA);`, hidden);
  assert.equal(await vm.runInContext(`tkbRefreshFromRemoteIfIdle("visible")`, hidden), false);

  // kho trả rỗng (mất mạng / chưa đăng nhập) -> không được thay bằng rỗng
  const empty = load({remote:{}});
  vm.runInContext(`__tkbLastSavedPayload = JSON.stringify(DATA);`, empty);
  assert.equal(await vm.runInContext(`tkbRefreshFromRemoteIfIdle("visible")`, empty), false);
  assert.equal(empty.DATA._lastModified, 100);
});

test("the planner listens for visibilitychange/focus to trigger the refresh", () => {
  const ctx = load();
  assert.ok(ctx.__listeners.doc.some(l => l.type === "visibilitychange"));
  assert.ok(ctx.__listeners.win.some(l => l.type === "focus"));
});
