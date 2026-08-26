"use strict";

// 25/08 (chi dao chu du an): "khi sap xep nut toi uu cung nen disable. con TKB
// minh van xem duoc chi la ko thao tac duoc o bang xep thoi".
//
// Nut "Toi uu" (btnOptimizeMenu) da bi khoa tu truoc, nhung nut "Toi uu v3"
// (btnTestMenu) thi khong: runPlannerV3Mode co chan bang testControlBusy() nen
// bam khong chay gi ca, the nhung nut van sang binh thuong -> nguoi dung tuong
// nut hong. Cac muc BEN TRONG hai menu cung phai bi khoa vi menu co the dang
// mo dung luc luot xep bat dau.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const plannerSource = fs.readFileSync(path.join(root, "web", "pages", "phanmon.js"), "utf8");
const plannerHtml = fs.readFileSync(path.join(root, "web", "pages", "sapxep.html"), "utf8");
const plannerCss = fs.readFileSync(path.join(root, "web", "pages", "phanmon.css"), "utf8");

function makeControl(disabled = false){
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden:false,
    disabled,
    dataset:{},
    classList:{
      add(name){ classes.add(String(name)); },
      remove(name){ classes.delete(String(name)); },
      toggle(name, force){
        const key = String(name);
        const on = force == null ? !classes.has(key) : !!force;
        if(on) classes.add(key);
        else classes.delete(key);
        return on;
      },
      contains(name){ return classes.has(String(name)); }
    },
    querySelector(){ return null; },
    setAttribute(name, value){ attributes.set(String(name), String(value)); },
    removeAttribute(name){ attributes.delete(String(name)); },
    getAttribute(name){ return attributes.get(String(name)) ?? null; }
  };
}

function loadBusyControls(){
  const controls = {
    btnHome:makeControl(false),
    btnAutoSort:makeControl(false),
    btnEngineCherry:makeControl(false),
    btnOptimizeMenu:makeControl(false),
    btnTestMenu:makeControl(false),
    plannerOptimizeMenu:makeControl(false),
    plannerTestMenu:makeControl(false),
    btnUndoTKB:makeControl(false),
    btnRedoTKB:makeControl(false),
    btnDeleteAll:makeControl(false),
    btnRangBuoc:makeControl(false),
    solveDurationSeconds:makeControl(false),
    tkb:makeControl(false)
  };
  // Muc menu: 4 muc "Toi uu" (FET) + 4 muc "Toi uu v3".
  const optimizeItems = [makeControl(), makeControl(), makeControl(), makeControl()];
  const v3Items = [makeControl(), makeControl(), makeControl(), makeControl()];
  const surfaces = {center:makeControl(false), left:makeControl(false)};

  const context = {
    navigator:{platform:"Win32", userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
    window:{
      __TKB_CLIENT_AGENT_LANES_ENABLED:false,
      __TKB_RUST_SOLVER_RUNNING:false,
      __TKB_SOLVE_UI_BUSY:false,
      __ACTIVE_TKB_FET_WORKER:null
    },
    document:{
      getElementById(id){ return controls[id] || null; },
      querySelector(selector){
        if(selector === ".center") return surfaces.center;
        if(selector === ".left") return surfaces.left;
        return null;
      },
      querySelectorAll(selector){
        const text = String(selector);
        if(text.includes("#plannerOptimizeMenu button")) return [...optimizeItems, ...v3Items];
        return [];
      }
    },
    __tkbUpdateHistoryButtons(){},
    syncAgentHelperVisibility(){ return false; }
  };
  vm.runInNewContext(`${plannerSource.slice(
    plannerSource.indexOf("function setAutoSortControlLocked"),
    plannerSource.indexOf("function setAutoSortStopVisible")
  )}\nthis.lockBusyControls = setAutoSortBusyControls;`, context);

  return {context, controls, optimizeItems, v3Items, surfaces};
}

test("dang xep thi khoa ca hai nut toi uu, khong chi nut Toi uu", () => {
  const {context, controls} = loadBusyControls();

  context.lockBusyControls(true);
  for(const id of ["btnOptimizeMenu", "btnTestMenu", "btnAutoSort", "btnEngineCherry"]){
    assert.equal(controls[id].disabled, true, `${id} phai bi khoa khi dang xep`);
    assert.equal(controls[id].getAttribute("aria-disabled"), "true", id);
    assert.equal(controls[id].classList.contains("is-auto-sort-disabled"), true, id);
  }

  context.lockBusyControls(false);
  for(const id of ["btnOptimizeMenu", "btnTestMenu", "btnAutoSort", "btnEngineCherry"]){
    assert.equal(controls[id].disabled, false, `${id} phai mo lai khi xep xong`);
    assert.equal(controls[id].getAttribute("aria-disabled"), null, id);
    assert.equal(controls[id].classList.contains("is-auto-sort-disabled"), false, id);
  }
});

test("ca hai menu toi uu bi dong va khoa tung muc khi dang xep", () => {
  const {context, controls, optimizeItems, v3Items} = loadBusyControls();
  // Menu dang mo dung luc luot xep bat dau.
  controls.plannerOptimizeMenu.hidden = false;
  controls.plannerTestMenu.hidden = false;

  context.lockBusyControls(true);
  assert.equal(controls.plannerOptimizeMenu.hidden, true);
  assert.equal(controls.plannerTestMenu.hidden, true);
  assert.equal(controls.btnOptimizeMenu.getAttribute("aria-expanded"), "false");
  assert.equal(controls.btnTestMenu.getAttribute("aria-expanded"), "false");
  [...optimizeItems, ...v3Items].forEach((item, index) => {
    assert.equal(item.disabled, true, `muc menu ${index} phai bi khoa`);
  });

  context.lockBusyControls(false);
  [...optimizeItems, ...v3Items].forEach((item, index) => {
    assert.equal(item.disabled, false, `muc menu ${index} phai mo lai`);
  });
});

test("luoi TKB chi doc khi dang xep: van xem duoc, khong thao tac duoc", () => {
  const {context, controls, surfaces} = loadBusyControls();

  context.lockBusyControls(true);
  assert.equal(controls.tkb.classList.contains("is-solving-readonly"), true);
  assert.equal(surfaces.center.classList.contains("is-solving-readonly"), true);
  assert.equal(surfaces.left.classList.contains("is-solving-readonly"), true);
  // Chi doc, KHONG duoc an di - chu du an muon van xem duoc thoi khoa bieu.
  assert.equal(controls.tkb.hidden, false);
  assert.equal(surfaces.center.hidden, false);

  context.lockBusyControls(false);
  assert.equal(controls.tkb.classList.contains("is-solving-readonly"), false);
  assert.equal(surfaces.center.classList.contains("is-solving-readonly"), false);
  assert.equal(surfaces.left.classList.contains("is-solving-readonly"), false);
});

test("trang thai khoa co kieu dang nhin thay duoc cho ca hai nut toi uu", () => {
  const disabledBlock = plannerHtml.slice(
    plannerHtml.indexOf("body.planner-shell .planner-optimize-wrap > #btnOptimizeMenu.is-auto-sort-disabled"),
    plannerHtml.indexOf("body.planner-shell .planner-mode-icon")
  );
  assert.ok(disabledBlock.length > 0, "khong tim thay khoi kieu dang is-auto-sort-disabled");
  assert.match(disabledBlock, /#btnTestMenu\.is-auto-sort-disabled/);
  assert.match(disabledBlock, /\.planner-optimize-menu > button\.is-auto-sort-disabled/);
  assert.match(disabledBlock, /opacity:\s*\.42\s*!important/);
  assert.match(disabledBlock, /pointer-events:\s*none\s*!important/);

  // Luoi chi doc van hien thi binh thuong, chi chan tuong tac.
  const readonlyBlock = plannerCss.slice(
    plannerCss.indexOf("#tkb.is-solving-readonly"),
    plannerCss.indexOf("DRAG & DROP HIGHLIGHT")
  );
  assert.match(readonlyBlock, /pointer-events:\s*none\s*!important/);
  assert.doesNotMatch(readonlyBlock, /display:\s*none/);
  assert.doesNotMatch(readonlyBlock, /visibility:\s*hidden/);
});
