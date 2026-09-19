"use strict";

// 31/08: trường ow14iqw5cb1 — bấm Cherry nhận "Dữ liệu vừa thay đổi trong lúc chuẩn bị. Bạn bấm Xếp lại
// nhé." rồi 43 ô tiết chung nằm lại dạng cố định. bridgeSapXepTuDongAll chụp vân tay lưới TRƯỚC, sau
// đó solveWithRustApi mới ghim tạm tiết chung nhiều lớp (thêm ô) -> vân tay lệch -> huỷ lượt mà không
// bỏ ghim. Test khoá: (1) trong bridgeSapXepTuDongAll, ghim đứng trước lần chụp vân tay; (2) huỷ lượt
// lúc chuẩn bị và thả nút khi không còn lượt giải đều gọi tkbJointUnpin; đang giải thì không.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BRIDGE_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js");
const SRC = fs.readFileSync(BRIDGE_PATH, "utf8");

function sliceFn(name){
  const start = "  function " + name + "(";
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, "khong thay ham: " + name);
  const b = SRC.indexOf("\n  }\n", a);
  assert.ok(b > a, "khong thay ket thuc ham: " + name);
  return SRC.slice(a, b + 4);
}

test("bridgeSapXepTuDongAll: ghim tiết chung nhiều lớp TRƯỚC khi chụp vân tay lưới", () => {
  const a = SRC.indexOf("async function bridgeSapXepTuDongAll(options){");
  assert.ok(a >= 0);
  const body = SRC.slice(a, a + 60000);
  const pinAt = body.indexOf("window.tkbJointPinBeforeSolve(");
  const fpAt = body.indexOf("const scheduleFingerprintBefore = scheduleFingerprintFromData(data);");
  assert.ok(pinAt >= 0 && fpAt >= 0, "phải có cả lời gọi ghim lẫn lần chụp vân tay");
  assert.ok(pinAt < fpAt, "ghim phải đứng trước vân tay, nếu không lượt xếp bị huỷ vì 'dữ liệu vừa thay đổi'");
});

test("huỷ lượt lúc chuẩn bị / thả nút khi rảnh -> bỏ ghim; đang giải -> không đụng", () => {
  function load(flags){
    const calls = {unpin: 0, status: [], busy: []};
    const window = Object.assign({
      tkbJointUnpin(){ calls.unpin++; },
      setTimeout(fn){ fn(); }
    }, flags || {});
    const ctx = {
      window, console,
      document: {getElementById(){ return {textContent: "Đang sắp xếp."}; }},
      setStatus(msg, level){ calls.status.push([msg, level]); },
      stopProgressTicker(){},
      setAutoSortButtonBusy(v){ calls.busy.push(v); }
    };
    vm.createContext(ctx);
    vm.runInContext([sliceFn("releaseAutoSortButtonSoon"), sliceFn("reportAutoSortPreparationChanged")].join("\n"), ctx, {filename: "bridge-slice.js"});
    ctx.__calls = calls;
    return ctx;
  }
  const idle = load({});
  vm.runInContext("reportAutoSortPreparationChanged()", idle);
  assert.ok(idle.__calls.unpin >= 1, "huỷ lúc chuẩn bị phải bỏ ghim");
  assert.ok(idle.__calls.status.some(([m]) => /vừa thay đổi trong lúc chuẩn bị/.test(m)));
  assert.ok(idle.__calls.busy.includes(false), "nút được thả");

  const idle2 = load({});
  vm.runInContext("releaseAutoSortButtonSoon()", idle2);
  assert.ok(idle2.__calls.unpin >= 1, "thả nút khi không có lượt giải -> bỏ ghim");

  const busy = load({__TKB_RUST_SOLVER_RUNNING: true});
  vm.runInContext("releaseAutoSortButtonSoon()", busy);
  assert.equal(busy.__calls.unpin, 0, "đang giải: không bỏ ghim, không thả nút");
  assert.equal(busy.__calls.busy.length, 0);
});
