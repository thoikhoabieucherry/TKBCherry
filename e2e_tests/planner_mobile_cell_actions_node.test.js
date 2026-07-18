"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const plannerSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "phanmon.js"),
  "utf8"
);
const plannerCss = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "phanmon.css"),
  "utf8"
);

function sourceBetween(startText, endText, from = 0){
  const start = plannerSource.indexOf(startText, from);
  assert.ok(start >= 0, `missing source marker: ${startText}`);
  const end = plannerSource.indexOf(endText, start + startText.length);
  assert.ok(end > start, `missing source marker: ${endText}`);
  return plannerSource.slice(start, end);
}

test("class, teacher, and unassigned drags all publish a WebKit payload", () => {
  const transferHelper = sourceBetween(
    "function setNativeDragTransfer",
    "function bindCells"
  );
  assert.match(transferHelper, /dataTransfer\.effectAllowed\s*=\s*"move"/);
  assert.match(transferHelper, /dataTransfer\.setData\("text\/plain",\s*String\(value \|\| ""\)\)/);

  const bindCellsStart = plannerSource.indexOf("function bindCells");
  const classDrag = sourceBetween("td.ondragstart = (e)=>", "td.ondragend", bindCellsStart);
  assert.match(classDrag, /setNativeDragTransfer\(e,\s*val\)/);

  const unassignedStart = plannerSource.indexOf("d.draggable =", bindCellsStart);
  const unassignedDrag = sourceBetween("d.ondragstart = (e)=>", "d.ondragend", unassignedStart);
  assert.match(unassignedDrag, /setNativeDragTransfer\(e,\s*t\.mon\)/);

  const teacherStart = plannerSource.indexOf("function pvBindTeacherSupportDrag");
  const teacherDrag = sourceBetween("td.ondragstart = (e)=>", "td.ondragend", teacherStart);
  assert.match(teacherDrag, /setNativeDragTransfer\(e,\s*mon\)/);
});

test("coarse-pointer double tap offers fixed, off, and delete actions", () => {
  const menu = sourceBetween("function ensureCellMenu", "function showCellMenuForTd");
  assert.match(menu, /data-cell-action="fixed"/);
  assert.match(menu, /data-cell-action="off"/);
  assert.match(menu, /data-cell-action="delete"/);
  assert.match(menu, /if\(action === "fixed"\)[\s\S]*toggleFixedByKey\(fixedKey\)/);
  assert.match(menu, /if\(action === "off"\)[\s\S]*setOffByKey\(cellKeyValue, !isOff\)/);
  assert.match(menu, /if\(action === "delete"\)[\s\S]*selectSingleCell\(td\)[\s\S]*deleteSelectedCells\(\)/);

  const doubleAction = sourceBetween("function handleCellDoubleAction", "function setOffByKey");
  assert.match(doubleAction, /usesCoarseCellActions\(\)/);
  assert.match(doubleAction, /cellKeyForTd\(td\)/, "blank and OFF cells must still open the touch menu");
  assert.match(doubleAction, /showCellMenuForTd\(td,/);
  assert.match(doubleAction, /toggleFixedByKey\(key\)/);
  assert.ok(
    (plannerSource.match(/handleCellDoubleAction\(td, e\)/g) || []).length >= 5,
    "every class/teacher render path should share the same double-tap behavior"
  );

  assert.match(plannerCss, /\.tkb-cell-action-menu\s*\{[^}]*position:\s*fixed;[^}]*grid-template-columns:\s*repeat\(3,/s);
  assert.match(plannerCss, /\.tkb-cell-action\s*\{[^}]*min-height:\s*42px;/s);
  assert.match(plannerCss, /@media \(any-pointer:\s*coarse\)[\s\S]*-webkit-user-drag:\s*element;/s);
});

test("replacement keeps the displaced lesson in the computed unassigned list", () => {
  const drop = sourceBetween("function onDrop", "function setDropHint");
  assert.match(drop, /tkb\[t\.thu\]\[t\.buoi\]\[ti\]\s*=\s*""/);
  assert.match(drop, /tkb\[s\.thu\]\[s\.buoi\]\[Number\(s\.ti\)\]\s*=\s*""/);
  assert.match(drop, /renderCurrentView\(\)[\s\S]*loadMonList\(\)/);

  const conflicts = sourceBetween("function clearConflictSlots", "function onDrop");
  assert.match(conflicts, /tkbOther\[thu\]\[buoi\]\[ti\]\s*=\s*""/);
  assert.match(
    plannerSource,
    /clearConflictSlots\(res\.conflicts\)[\s\S]*onDrop\(td\)/
  );
});
