"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const plannerSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "phanmon.js"),
  "utf8"
);
const plannerCss = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "phanmon.css"),
  "utf8"
);

function fakeClassList(){
  const values = new Set();
  return {
    add(name){ values.add(name); },
    remove(name){ values.delete(name); },
    toggle(name, force){
      if(force === true) values.add(name);
      else if(force === false) values.delete(name);
      else if(values.has(name)) values.delete(name);
      else values.add(name);
    },
    contains(name){ return values.has(name); }
  };
}

test("statistics popover becomes visible before expensive statistics render", () => {
  const start = plannerSource.indexOf("let STATS_BOX_RENDER_REQUEST");
  const end = plannerSource.indexOf("if(!window.__TKB_STATS_POPOVER_BOUND", start);
  assert.ok(start >= 0 && end > start, "statistics popover source block is missing");

  const frames = [];
  const timers = [];
  let renderCalls = 0;
  const pop = {
    hidden:true,
    attrs:{},
    classList:fakeClassList(),
    setAttribute(name, value){ this.attrs[name] = String(value); },
    removeAttribute(name){ delete this.attrs[name]; }
  };
  const button = {
    attrs:{},
    classList:fakeClassList(),
    setAttribute(name, value){ this.attrs[name] = String(value); }
  };
  const box = {
    innerHTML:"",
    dataset:{},
    attrs:{},
    classList:fakeClassList(),
    setAttribute(name, value){ this.attrs[name] = String(value); },
    removeAttribute(name){ delete this.attrs[name]; }
  };
  const context = {
    console:{warn(){}},
    document:{
      getElementById(id){
        if(id === "statsPopover") return pop;
        if(id === "statsToggle") return button;
        if(id === "statsBox") return box;
        return null;
      }
    },
    requestAnimationFrame(callback){ frames.push(callback); return frames.length; },
    cancelAnimationFrame(){},
    setTimeout(callback){ timers.push(callback); return timers.length; },
    clearTimeout(){},
    positionStatsPopover(){},
    renderStatsBox(){ renderCalls += 1; }
  };
  context.window = context;
  vm.runInNewContext(plannerSource.slice(start, end), context);

  context.setStatsPopoverOpen(true);
  assert.equal(pop.hidden, false);
  assert.equal(button.attrs["aria-expanded"], "true");
  assert.equal(pop.attrs["aria-busy"], "true");
  assert.match(box.innerHTML, /Đang cập nhật thống kê/);
  assert.equal(renderCalls, 0, "the click handler must not synchronously scan the timetable");

  frames.splice(0).forEach(callback=>callback());
  assert.equal(renderCalls, 0, "render remains deferred until after the first paint");
  timers.splice(0).forEach(callback=>callback());
  assert.equal(renderCalls, 1);
  assert.equal(pop.attrs["aria-busy"], undefined);
});

test("statistics button cannot show a text caret or select its label", () => {
  assert.match(
    plannerCss,
    /\.toolbar button\.stats-toggle,[\s\S]*?\.toolbar button\.stats-toggle \*\s*\{[\s\S]*?-webkit-user-select:\s*none;[\s\S]*?user-select:\s*none;[\s\S]*?caret-color:\s*transparent;/
  );
});
