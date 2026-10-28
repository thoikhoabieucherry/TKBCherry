"use strict";

// 28/10: o thoi luong ⏱ cua ban web khong dang nhap (tools/netlify-local/overlay/pages/local-planner.js)
// chi con 1 / 2 / 3 phut (chu du an: "nen cho option tu 1 phut 2 phut 3 phut thoi"), mac dinh 2 phut;
// gia tri cu da luu lam tron ve mot trong ba; bridge doc __TKB_ENGINE_BUDGET_SECONDS.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "tools", "netlify-local", "overlay", "pages", "local-planner.js"), "utf8");

function load(saved){
  const values = new Map(saved == null ? [] : [["CHERRY_LOCAL_ENGINE_BUDGET_SECONDS", String(saved)]]);
  const localStorage = {
    getItem(k){ return values.has(k) ? values.get(k) : null; },
    setItem(k, v){ values.set(k, String(v)); },
    removeItem(k){ values.delete(k); }
  };
  const nodes = new Map();
  const make = (tag) => {
    const listeners = {};
    return {
      tagName:String(tag).toUpperCase(), id:"", children:[], value:"", title:"", textContent:"",
      setAttribute(){}, appendChild(c){ this.children.push(c); if(c.id) nodes.set(c.id, c); return c; },
      addEventListener(type, fn){ listeners[type] = fn; }, fire(type){ return listeners[type] && listeners[type](); },
      insertAdjacentElement(_where, el){ nodes.set(el.id, el); for(const c of el.children) if(c.id) nodes.set(c.id, c); return el; }
    };
  };
  const cherry = make("button");
  cherry.id = "btnEngineCherry";
  nodes.set(cherry.id, cherry);
  const document = {
    readyState:"complete",
    getElementById(id){ return nodes.get(id) || null; },
    querySelector(){ return {}; },
    createElement:make,
    addEventListener(){}
  };
  const statuses = [];
  const window = {_setStatus(msg){ statuses.push(msg); }};
  vm.runInContext(SRC, vm.createContext({window, document, localStorage, console}));
  return {window, document, values, statuses};
}

test("ô ⏱ chỉ có 1 / 2 / 3 phút, mặc định 2 phút", () => {
  const {window, document} = load(null);
  const select = document.getElementById("localEngineBudget");
  assert.deepEqual(select.children.map(o => o.textContent), ["1 phút", "2 phút", "3 phút"]);
  assert.deepEqual(select.children.map(o => o.value), ["60", "120", "180"]);
  assert.equal(select.value, "120");
  assert.equal(window.__TKB_ENGINE_BUDGET_SECONDS, 120, "nút Cherry chạy 2 phút");
  assert.equal(window.__TKB_ENGINE_FOCUS_BUDGET_SECONDS, 120, "Tối ưu theo cùng ô");
});

test("giá trị cũ đã lưu làm tròn về một trong ba lựa chọn", () => {
  for(const [saved, want] of [[30, 60], [45, 60], [60, 60], [180, 180], [300, 180], [1800, 180], [0, 120], ["abc", 120]]){
    const {window} = load(saved);
    assert.equal(window.__TKB_ENGINE_BUDGET_SECONDS, want, `đã lưu ${saved}`);
  }
});

test("đổi lựa chọn thì nhớ lại và báo thời lượng mới", () => {
  const {window, document, values, statuses} = load(null);
  const select = document.getElementById("localEngineBudget");
  select.value = "60";
  select.fire("change");
  assert.equal(window.__TKB_ENGINE_BUDGET_SECONDS, 60);
  assert.equal(values.get("CHERRY_LOCAL_ENGINE_BUDGET_SECONDS"), "60");
  assert.match(statuses.at(-1), /1 phút mỗi lượt/);
});
