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

function buttonMarkup(source, id){
  return (source.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find(markup => markup.includes(`id="${id}"`)) || "";
}

function schedulerModeScript(){
  const marker = "(function(){\n  const desktopModeQuery";
  const start = plannerHtml.indexOf(marker);
  const end = plannerHtml.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "scheduler-mode script is missing");
  return plannerHtml.slice(start, end);
}

test("automatic Play remains available while focused commands are desktop-only", () => {
  const play = buttonMarkup(plannerHtml, "btnAutoSort");
  assert.ok(play, "automatic Play button is missing");
  assert.match(play, /onclick="sapXepTuDongAll\(\)"/);
  assert.doesNotMatch(play, /\shidden(?:\s|>)/);

  assert.match(
    plannerHtml,
    /\.desktop-solve-controls\s*\{[^}]*display:\s*none;/s,
    "focused commands must default to hidden"
  );
  assert.match(
    plannerHtml,
    /@media \(min-width:\s*901px\) and \(hover:\s*hover\) and \(pointer:\s*fine\)\s*\{[\s\S]*?\.desktop-solve-controls\s*\{[^}]*display:\s*inline-flex;/s,
    "only a wide fine-pointer desktop may reveal focused commands"
  );
  assert.equal(
    (plannerHtml.match(/\.desktop-solve-controls\s*\{[^}]*display:\s*inline-flex;/gs) || []).length,
    1,
    "no phone, tablet, or coarse-pointer override may reveal focused commands"
  );

  assert.match(
    plannerHtml,
    /@media \(max-width:\s*900px\)[\s\S]*?grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/,
    "portrait touch geometry must retain eight slots"
  );
  assert.match(
    plannerHtml,
    /@media \(orientation:\s*landscape\) and \(max-height:\s*540px\)[\s\S]*?grid-template-columns:\s*repeat\(9, minmax\(0, 1fr\)\);/,
    "landscape touch geometry must retain nine slots"
  );
});

test("desktop commands expose exactly the requested four scheduler hooks", () => {
  const controlsStart = plannerHtml.indexOf('<div id="desktopSolveControls"');
  const controlsEnd = plannerHtml.indexOf("\n    </div>", controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart, "desktop solve controls are missing");
  const controls = plannerHtml.slice(controlsStart, controlsEnd);

  const quick = buttonMarkup(controls, "btnQuickComplete");
  const optimizeToggle = buttonMarkup(controls, "btnOptimizeMenu");
  assert.match(quick, /onclick="runPlannerSchedulerMode\('quick_complete', event\)"/);
  assert.match(quick, /<span>Xếp nhanh<\/span>/);
  assert.match(optimizeToggle, /onclick="togglePlannerOptimizeMenu\(event\)"/);
  assert.match(optimizeToggle, /aria-haspopup="menu"/);
  assert.match(optimizeToggle, /aria-expanded="false"/);
  assert.match(optimizeToggle, /<span>Tối ưu<\/span>/);

  const menuStart = controls.indexOf('<div id="plannerOptimizeMenu"');
  assert.ok(menuStart >= 0, "optimize menu is missing");
  const menu = controls.slice(menuStart);
  const menuItems = menu.match(/<button\b[^>]*role="menuitem"[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(menuItems.length, 3, "optimize menu must contain exactly three actions");
  assert.deepEqual(
    menuItems.map(item => item.match(/data-scheduler-mode="([^"]+)"/)?.[1]),
    ["optimize_singletons", "optimize_sessions", "optimize_gaps"]
  );
  assert.deepEqual(
    menuItems.map(item => item.replace(/<[^>]+>/g, "").trim()),
    ["Buổi 1 tiết", "Buổi", "Tiết trống"]
  );
  assert.match(menuItems[0], /runPlannerSchedulerMode\('optimize_singletons', event\)/);
  assert.match(menuItems[1], /runPlannerSchedulerMode\('optimize_sessions', event\)/);
  assert.match(menuItems[2], /runPlannerSchedulerMode\('optimize_gaps', event\)/);
  assert.doesNotMatch(controls, /on(?:mouse|pointer)(?:enter|over|move)=/i);
});

test("optimize menu actions share stable left-aligned geometry", () => {
  const menuRule = plannerHtml.match(
    /body\.planner-shell \.planner-optimize-menu > button\s*\{([^}]*)\}/s
  );
  assert.ok(menuRule, "optimize menu item CSS is missing");
  const css = menuRule[1];

  assert.match(css, /display:\s*flex;/);
  assert.match(css, /align-items:\s*center;/);
  assert.match(css, /justify-content:\s*flex-start;/);
  assert.match(css, /box-sizing:\s*border-box;/);
  assert.match(css, /width:\s*100%;/);
  assert.match(css, /min-width:\s*0;/);
  assert.match(css, /height:\s*34px;/);
  assert.match(css, /padding:\s*0 10px;/);
  assert.match(css, /text-align:\s*left;/);
  assert.match(css, /white-space:\s*nowrap;/);
});

test("optimize menu toggles by click and forwards only supported modes", () => {
  const documentListeners = new Map();
  const mediaListeners = new Map();
  const media = {
    matches:true,
    addEventListener(type, listener){ mediaListeners.set(type, listener); }
  };
  const elements = {};
  const document = {
    activeElement:null,
    getElementById(id){ return elements[id] || null; },
    addEventListener(type, listener){ documentListeners.set(type, listener); }
  };
  function element(extra = {}){
    const attributes = {};
    const listeners = new Map();
    return Object.assign({
      hidden:false,
      attributes,
      setAttribute(name, value){ attributes[name] = String(value); },
      addEventListener(type, listener){ listeners.set(type, listener); },
      contains(){ return false; },
      focus(){ document.activeElement = this; },
      listeners
    }, extra);
  }
  const menuItems = [element(), element(), element()];
  elements.desktopSolveControls = element({contains(target){ return target === this; }});
  elements.btnOptimizeMenu = element();
  elements.plannerOptimizeMenu = element({
    hidden:true,
    querySelector(selector){ return selector === '[role="menuitem"]' ? menuItems[0] : null; },
    querySelectorAll(selector){ return selector === '[role="menuitem"]' ? menuItems : []; }
  });

  const receivedModes = [];
  const window = {
    matchMedia(query){
      assert.equal(query, "(min-width: 901px) and (hover: hover) and (pointer: fine)");
      return media;
    },
    sapXepTheoCheDo(mode){ receivedModes.push(mode); return `started:${mode}`; }
  };
  vm.runInNewContext(schedulerModeScript(), {window, document});

  const clickEvent = {
    prevented:0,
    stopped:0,
    preventDefault(){ this.prevented += 1; },
    stopPropagation(){ this.stopped += 1; }
  };
  assert.equal(window.togglePlannerOptimizeMenu(clickEvent), true);
  assert.equal(elements.plannerOptimizeMenu.hidden, false);
  assert.equal(elements.btnOptimizeMenu.attributes["aria-expanded"], "true");
  assert.equal(window.togglePlannerOptimizeMenu(clickEvent), false);
  assert.equal(elements.plannerOptimizeMenu.hidden, true);
  assert.equal(elements.btnOptimizeMenu.attributes["aria-expanded"], "false");

  assert.equal(
    window.runPlannerSchedulerMode("optimize_sessions", clickEvent),
    "started:optimize_sessions"
  );
  assert.deepEqual(receivedModes, ["optimize_sessions"]);
  assert.equal(window.runPlannerSchedulerMode("unknown_mode", clickEvent), false);
  assert.deepEqual(receivedModes, ["optimize_sessions"], "unsupported modes must not reach the solver hook");

  media.matches = false;
  assert.equal(window.togglePlannerOptimizeMenu(clickEvent), false);
  assert.equal(elements.plannerOptimizeMenu.hidden, true, "touch/tablet mode cannot open the desktop menu");
  assert.equal(typeof documentListeners.get("click"), "function");
  assert.equal(typeof documentListeners.get("keydown"), "function");
  assert.equal(typeof mediaListeners.get("change"), "function");
});
