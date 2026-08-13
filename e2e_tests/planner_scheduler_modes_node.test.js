"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const plannerHtml = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "sapxep.html"),
  "utf8"
);
const bridgeSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js"),
  "utf8"
);

function buttonMarkup(source, id){
  return (source.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find(markup => markup.includes(`id="${id}"`)) || "";
}

function optimizeScript(){
  const marker = '  const optimizeWrap = document.getElementById("plannerOptimizeWrap");';
  const start = plannerHtml.indexOf(marker);
  const scriptStart = plannerHtml.lastIndexOf("<script>", start);
  const end = plannerHtml.indexOf("</script>", start);
  assert.ok(scriptStart >= 0 && end > start, "optimize menu script is missing");
  return plannerHtml.slice(scriptStart + "<script>".length, end);
}

test("ordinary Optimize exposes exactly singleton, Gap1, and Gap2 actions", () => {
  const play = buttonMarkup(plannerHtml, "btnAutoSort");
  assert.ok(play, "automatic Play button is missing");
  assert.match(play, /onclick="sapXepTuDongAll\(\)"/);

  const optimize = buttonMarkup(plannerHtml, "btnOptimizeMenu");
  assert.ok(optimize, "optimize button is missing");
  assert.match(optimize, /onclick="togglePlannerOptimizeMenu\(event\)"/);
  assert.match(optimize, /aria-haspopup="menu"/);
  assert.match(optimize, /aria-expanded="false"/);
  assert.match(optimize, />[\s\S]*<span class="planner-mode-label">Tối ưu<\/span>/);

  const menuStart = plannerHtml.indexOf('<div id="plannerOptimizeMenu"');
  const menuEnd = plannerHtml.indexOf("</div>", menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart, "optimize menu is missing");
  const menu = plannerHtml.slice(menuStart, menuEnd);
  const items = menu.match(/<button\b[^>]*role="menuitem"[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map(item => item.match(/data-scheduler-mode="([^"]+)"/)?.[1]),
    ["optimize_singletons", "optimize_gap1", "optimize_gap2", "optimize_sessions"]
  );
  assert.deepEqual(
    items.map(item => item.replace(/<[^>]+>/g, "").trim()),
    ["1 tiết/buổi", "1 tiết trống", "2 tiết trống", "Buổi"]
  );
  assert.match(items[0], /runPlannerSchedulerMode\('optimize_singletons', event\)/);
  assert.match(items[1], /runPlannerSchedulerMode\('optimize_gap1', event\)/);
  assert.match(items[2], /runPlannerSchedulerMode\('optimize_gap2', event\)/);
  assert.match(items[3], /runPlannerSchedulerMode\('optimize_sessions', event\)/);
  for(const ordinary of items.slice(0, 3)){
    assert.doesNotMatch(ordinary, /data-superadmin-only|\shidden(?:\s|>)/);
  }
  assert.match(items[3], /data-superadmin-only="true"/);
  assert.match(items[3], /aria-hidden="true"/);
  assert.match(items[3], /\shidden(?:\s|>)/);
  assert.match(
    plannerHtml,
    /\.planner-optimize-menu\s*>\s*button\[hidden\]\s*\{[^}]*display:\s*none !important;/s
  );
});

test("optimization menu opens, forwards supported modes, and refuses busy state", () => {
  const documentListeners = new Map();
  const elements = {};
  const document = {
    activeElement:null,
    getElementById(id){ return elements[id] || null; },
    addEventListener(type, listener){ documentListeners.set(type, listener); }
  };
  function element(extra = {}){
    const attributes = new Map();
    const listeners = new Map();
    return Object.assign({
      hidden:false,
      disabled:false,
      setAttribute(name, value){ attributes.set(String(name), String(value)); },
      getAttribute(name){ return attributes.get(String(name)) ?? null; },
      removeAttribute(name){ attributes.delete(String(name)); },
      addEventListener(type, listener){ listeners.set(type, listener); },
      contains(){ return false; },
      focus(){ document.activeElement = this; },
      querySelector(){ return null; },
      querySelectorAll(){ return []; },
      listeners
    }, extra);
  }
  const menuItems = [element(), element(), element(), element()];
  const advancedItems = menuItems.slice(3);
  elements.plannerOptimizeWrap = element({contains(){ return false; }});
  elements.btnOptimizeMenu = element();
  elements.plannerOptimizeMenu = element({
    hidden:true,
    querySelectorAll(selector){
      if(selector === '[role="menuitem"]') return menuItems;
      if(selector === '[data-superadmin-only="true"]') return advancedItems;
      return [];
    }
  });

  const receivedModes = [];
  let role = "school_user";
  const windowListeners = new Map();
  const window = {
    __TKB_RUST_SOLVER_RUNNING:false,
    __TKB_SOLVE_UI_BUSY:false,
    TKBAuth:{currentUser(){ return {user:{role}}; }},
    addEventListener(type, listener){ windowListeners.set(type, listener); },
    sapXepTheoCheDo(mode){ receivedModes.push(mode); return `started:${mode}`; }
  };
  vm.runInNewContext(optimizeScript(), {window, document});

  const event = {
    preventDefault(){},
    stopPropagation(){}
  };
  assert.equal(window.togglePlannerOptimizeMenu(event), true);
  assert.equal(elements.plannerOptimizeMenu.hidden, false);
  assert.equal(elements.btnOptimizeMenu.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, null);

  const keyEvent = {
    key:"ArrowDown",
    preventDefault(){},
    stopPropagation(){}
  };
  elements.btnOptimizeMenu.listeners.get("keydown")(keyEvent);
  assert.equal(document.activeElement, menuItems[0]);
  elements.plannerOptimizeMenu.listeners.get("keydown")(keyEvent);
  assert.equal(document.activeElement, menuItems[1]);
  elements.plannerOptimizeMenu.listeners.get("keydown")(keyEvent);
  assert.equal(document.activeElement, menuItems[2]);
  elements.plannerOptimizeMenu.listeners.get("keydown")(keyEvent);
  assert.equal(document.activeElement, menuItems[0], "hidden Buổi must be skipped");

  assert.equal(window.runPlannerSchedulerMode("optimize_sessions", event), false);
  assert.deepEqual(receivedModes, []);
  assert.equal(elements.plannerOptimizeMenu.hidden, true);

  assert.equal(window.runPlannerSchedulerMode("unknown_mode", event), false);
  assert.deepEqual(receivedModes, []);

  for(const mode of ["optimize_singletons", "optimize_gap1", "optimize_gap2"]){
    assert.equal(window.runPlannerSchedulerMode(mode, event), `started:${mode}`);
  }
  assert.deepEqual(receivedModes, ["optimize_singletons", "optimize_gap1", "optimize_gap2"]);
  assert.ok(advancedItems.every(item => item.hidden === true));

  role = "superadmin";
  assert.equal(window.syncPlannerOptimizeRoleAccess(), true);
  assert.ok(advancedItems.every(item => item.hidden === false));
  assert.equal(advancedItems[0].getAttribute("aria-hidden"), "false");
  assert.equal(advancedItems[0].getAttribute("tabindex"), null);
  assert.equal(window.runPlannerSchedulerMode("optimize_sessions", event), "started:optimize_sessions");
  assert.deepEqual(receivedModes, ["optimize_singletons", "optimize_gap1", "optimize_gap2", "optimize_sessions"]);

  elements.btnOptimizeMenu.disabled = true;
  assert.equal(window.togglePlannerOptimizeMenu(event), false);
  assert.equal(window.runPlannerSchedulerMode("optimize_gap2", event), false);
  assert.deepEqual(receivedModes, ["optimize_singletons", "optimize_gap1", "optimize_gap2", "optimize_sessions"]);

  elements.btnOptimizeMenu.disabled = false;
  window.__TKB_RUST_SOLVER_RUNNING = true;
  assert.equal(window.togglePlannerOptimizeMenu(event), false);
  assert.equal(window.runPlannerSchedulerMode("optimize_gap1", event), false);
  assert.deepEqual(receivedModes, ["optimize_singletons", "optimize_gap1", "optimize_gap2", "optimize_sessions"]);
  assert.equal(typeof documentListeners.get("click"), "function");
  assert.equal(typeof documentListeners.get("keydown"), "function");
  assert.equal(typeof windowListeners.get("tkb:auth-ready"), "function");
});

test("portrait and landscape retain responsive toolbar slots for the optimize control", () => {
  assert.match(
    plannerHtml,
    /grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/,
    "portrait touch geometry must include Optimize"
  );
  assert.match(
    plannerHtml,
    /grid-template-columns:\s*repeat\(9, minmax\(0, 1fr\)\);/,
    "landscape touch geometry must include Optimize"
  );
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*\.planner-optimize-wrap\s*\{[^}]*grid-column:\s*4;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*\.planner-optimize-wrap\s*\{[^}]*grid-column:\s*5;/s);
});

test("one-click Automatic still carries the internal quality-optimization contract", () => {
  assert.match(bridgeSource, /settings\.optimization_focus\s*=\s*"automatic"/);
  assert.match(bridgeSource, /settings\.optimization_continue_quality_search\s*=\s*true/);
  assert.match(bridgeSource, /settings\.optimization_first_click_strict_quality_gate\s*=\s*true/);
  assert.match(bridgeSource, /settings\.optimization_accept_gap1_sessions/);
});
