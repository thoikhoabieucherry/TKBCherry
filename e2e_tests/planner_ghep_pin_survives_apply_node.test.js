"use strict";

// 06/10: THCS An Phú (kkhg52etp92) — "bấm Cherry nó lại khóa 2 tiết KNS/STEM". Trước lượt giải app ghim
// tạm tiết chung nhiều lớp thành {mon, fixed:true, jointPin:true}; applyPayload dựng lại ô cố định thành
// {mon, fixed:true} trần (mất jointPin). Đường gỡ ghim nào lỡ (tải lại trang, khôi phục lịch cũ) thì ô
// đó thành "người dùng cố định" vĩnh viễn: lượt ghim sau coi là ô người dùng khoá (wasFixed) và không
// bao giờ bỏ ghim. Test khoá: (1) áp kết quả giữ cờ jointPin cho ô ghim tạm, không thêm cho ô người dùng;
// (2) lưới không vẽ khoá cho ô ghim tạm.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = name => fs.readFileSync(path.resolve(__dirname, "..", "web", "pages", name), "utf8").replace(/\r\n/g, "\n");
const BRIDGE = read("tkb-rust-bridge.js");
const PHANMON = read("phanmon.js");

function sliceFn(src, name, indent){
  const start = indent + "function " + name + "(";
  const a = src.indexOf(start);
  assert.ok(a >= 0, "khong thay ham: " + name);
  const b = src.indexOf("\n" + indent + "}\n", a);
  assert.ok(b > a, "khong thay ket thuc ham: " + name);
  return src.slice(a, b + indent.length + 3);
}

test("áp kết quả: ô ghim tạm giữ jointPin, ô người dùng cố định thì không", () => {
  const ctx = {
    isScheduledCell(v){ return !!v && v !== "OFF"; },
    isFixedScheduledCell(v){ return !!(v && typeof v === "object" && v.fixed); },
    cellSubjectText(v){ return typeof v === "string" ? v : String(v?.mon || ""); },
    fixedLessonLockKey(c, thu, buoi, ti){ return [c, thu, buoi, ti].join("|"); },
    fixedLessonCanonicalSubjectKey(s){ return String(s || "").trim().toLowerCase(); },
    makeEmptyTKB(){
      const out = {};
      ["thu2","thu3","thu4","thu5","thu6","thu7"].forEach(d => { out[d] = {sang: ["", "", "", ""], chieu: ["", "", "", ""]}; });
      return out;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(["collectFixedLessonLocks", "fixedLessonLockSubject", "fixedLessonLockCell", "applyFixedLessonLocks"]
    .map(n => sliceFn(BRIDGE, n, "  ")).join("\n"), ctx, {filename: "bridge-slice.js"});
  const tkb = ctx.makeEmptyTKB();
  tkb.thu2.sang[0] = {mon: "HĐTN 1-SHTT", fixed: true};
  tkb.thu2.sang[2] = {mon: "KNS (ghép)", fixed: true, jointPin: true};
  tkb.thu2.sang[3] = "Toán";
  ctx.DATA = {tkb: {"6A2": tkb}};
  const out = vm.runInContext("(() => { const locks = collectFixedLessonLocks(DATA); const next = {}; applyFixedLessonLocks(next, locks); return {n: locks.size, next}; })()", ctx);
  assert.equal(out.n, 2);
  const sang = out.next["6A2"].thu2.sang;
  assert.deepEqual(JSON.parse(JSON.stringify(sang[2])), {mon: "KNS (ghép)", fixed: true, jointPin: true});
  assert.deepEqual(JSON.parse(JSON.stringify(sang[0])), {mon: "HĐTN 1-SHTT", fixed: true});
});

test("applyPayload dựng ô cố định bằng fixedLessonLockCell (không còn {mon, fixed} trần)", () => {
  const a = BRIDGE.indexOf("  async function applyPayload(payload, solveSettings){");
  assert.ok(a >= 0);
  const body = BRIDGE.slice(a, a + 20000);
  assert.ok(body.includes("keepFixed ? fixedLessonLockCell(fixedLock, subject) : subject"));
  assert.ok(!/keepFixed \? \{mon: fixedLessonLockSubject/.test(body));
});

test("lưới không vẽ khoá cho ô ghim tạm tiết chung", () => {
  const ctx = {};
  vm.createContext(ctx);
  const oneLine = name => {
    const m = PHANMON.match(new RegExp("^function " + name + "\\(.*$", "m"));
    assert.ok(m, "khong thay ham: " + name);
    return m[0];
  };
  vm.runInContext([oneLine("isFixed"), oneLine("isShownFixed")].join("\n"), ctx);
  assert.equal(vm.runInContext("isShownFixed({mon:'KNS (ghép)', fixed:true, jointPin:true})", ctx), false);
  assert.equal(vm.runInContext("isShownFixed({mon:'HĐTN 1-SHTT', fixed:true})", ctx), true);
  assert.equal(vm.runInContext("isShownFixed('Toán')", ctx), false);
  // cả lưới lớp (cellHTML + vẽ lại tại chỗ) lẫn TKB GV dùng isShownFixed cho lớp tkb-fixed
  assert.ok(PHANMON.includes("${isShownFixed(v)?'tkb-fixed':''}"));
  assert.ok(PHANMON.includes("sched[thu].sang[ti].push({classId, classDisplay, mon, room, fixed: isShownFixed(v)});"));
  assert.ok(PHANMON.includes("sched[thu].chieu[ti].push({classId, classDisplay, mon, room, fixed: isShownFixed(v)});"));
});

// 07/10: engine được dời tiết chung (tkb_engine_v3/joint.py) — bridge gửi khoá ghim tạm và khi áp
// thì NHẬN vị trí engine trả về cho các khoá engine báo trong solver.engine_v3.joint_free.keys.
test("áp kết quả: khoá engine báo joint_free thì bỏ khoá ô ghim tạm, ô người dùng cố định vẫn khoá", () => {
  const ctx = {
    fixedLessonCanonicalSubjectKey(s){ return String(s || "").trim().toLowerCase(); },
  };
  vm.createContext(ctx);
  vm.runInContext(["fixedLessonLockSubject", "jointFreeKeysFromPayload", "releaseJointFreeLocks", "fixedLessonLockSubjectKey"]
    .map(n => sliceFn(BRIDGE, n, "  ")).join("\n"), ctx, {filename: "bridge-slice.js"});
  const out = vm.runInContext(`(() => {
    const mk = () => new Map([
      ["L2|thu2|sang|2", {subject: "KNS (ghép)", key: "kns (ghép)", jointPin: true}],
      ["L2|thu2|sang|0", {subject: "HĐTN 1-SHTT", key: "hđtn 1-shtt", jointPin: false}],
      ["L9|thu5|sang|0", {subject: "KNS (ghép)", key: "kns (ghép)", jointPin: false}]
    ]);
    const a = mk();
    const released = releaseJointFreeLocks(a, {solver: {engine_v3: {joint_free: {keys: ["KNS (ghép)"], moved: []}}}});
    const b = mk();
    const none = releaseJointFreeLocks(b, {solver: {engine_v3: {}}});
    return {released, left: Array.from(a.keys()), none, leftB: b.size};
  })()`, ctx);
  assert.equal(out.released, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(out.left)), ["L2|thu2|sang|0", "L9|thu5|sang|0"]);
  assert.equal(out.none, 0);
  assert.equal(out.leftB, 3);
  const a = BRIDGE.indexOf("  async function applyPayload(payload, solveSettings){");
  const body = BRIDGE.slice(a, a + 6000);
  assert.ok(body.includes("releaseJointFreeLocks(fixedLessonLocks, payload)"), "applyPayload phải bỏ khoá ghim tạm theo joint_free");
});

test("lượt Cherry gửi khoá ghim tạm (cherry_joint_movable) và planner có tkbJointPinnedKeys", () => {
  assert.ok(BRIDGE.includes("effectiveSettings.cherry_joint_movable = jointKeys.slice();"));
  const start = PHANMON.indexOf("function tkbJointPinnedKeys(){");
  assert.ok(start >= 0);
  const end = PHANMON.indexOf("\n}\n", start);
  const ctx = {__TKB_JOINT_PINNED: [{key: "KNS (ghép)"}, {key: "KNS (ghép)"}, {key: " TANN (ghép) "}, {key: ""}]};
  vm.createContext(ctx);
  vm.runInContext(PHANMON.slice(start, end + 3), ctx);
  assert.deepEqual(Array.from(vm.runInContext("tkbJointPinnedKeys()", ctx)), ["KNS (ghép)", "TANN (ghép)"]);
});
