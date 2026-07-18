"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");

function loadPairSelectToggle(roots){
  const start = PHANMON_SOURCE.indexOf("function pairScrollActiveOptionToTop");
  const end = PHANMON_SOURCE.indexOf("window.pairChooseSelectOption", start);
  assert.ok(start >= 0, "pair select active-option scroll helper must exist");
  assert.ok(end > start, "pair select toggle source must be extractable");

  const context = {
    window: {},
    document: {
      querySelectorAll(selector){
        return selector === ".tkb-pair-select" ? roots : [];
      }
    }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(start, end), context, {filename:PHANMON_PATH});
  assert.equal(typeof context.window.pairToggleSelectMenu, "function");
  return context.window.pairToggleSelectMenu;
}

function makeClassList(initial = []){
  const values = new Set(initial);
  return {
    contains(value){ return values.has(String(value)); },
    remove(...items){ items.forEach(item => values.delete(String(item))); },
    toggle(value, force){
      const key = String(value);
      const enabled = force == null ? !values.has(key) : !!force;
      if(enabled) values.add(key);
      else values.delete(key);
      return enabled;
    }
  };
}

function makePairSelect(id, values, current, rowHeight = 30){
  const options = values.map((value, index) => ({
    dataset:{pairOption:String(value)},
    classList:makeClassList(String(value) === String(current) ? ["active"] : []),
    offsetTop:index * rowHeight
  }));
  const menu = {
    hidden:true,
    scrollTop:0,
    querySelectorAll(selector){
      return selector === "[data-pair-option]" ? options : [];
    }
  };
  const root = {
    id,
    dataset:{value:String(current)},
    classList:makeClassList(),
    querySelector(selector){
      return selector === ".tkb-pair-select-menu" ? menu : null;
    }
  };
  return {root, menu};
}

test("paired class and teacher menus reopen with the active option at the top", () => {
  const classes = makePairSelect(
    "pairMainClassSelect",
    ["10A1", "10A2", "10A3", "10A4", "10A5", "10A6"],
    "10A5"
  );
  const teachers = makePairSelect(
    "pairTeacherSelect",
    ["GV01", "GV02", "GV03", "GV04", "GV05", "GV06"],
    "GV04",
    28
  );
  const toggle = loadPairSelectToggle([classes.root, teachers.root]);
  const event = {
    prevented:0,
    stopped:0,
    preventDefault(){ this.prevented += 1; },
    stopPropagation(){ this.stopped += 1; }
  };

  toggle(classes.root, event);
  assert.equal(classes.menu.hidden, false);
  assert.equal(classes.menu.scrollTop, 4 * 30);
  assert.equal(event.prevented, 1);
  assert.equal(event.stopped, 1);

  toggle(teachers.root, event);
  assert.equal(classes.menu.hidden, true, "opening another menu still closes the first one");
  assert.equal(teachers.menu.hidden, false);
  assert.equal(teachers.menu.scrollTop, 3 * 28);

  toggle(teachers.root, event);
  assert.equal(teachers.menu.hidden, true, "the existing close behavior is preserved");
  teachers.menu.scrollTop = 0;
  toggle(teachers.root, event);
  assert.equal(teachers.menu.scrollTop, 3 * 28, "every reopen restores the selected row to the top");
});
