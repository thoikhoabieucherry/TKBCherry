"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");

function loadPlannerStateContract(){
  const start = PHANMON_SOURCE.indexOf("function clonePlannerScheduleState(");
  const end = PHANMON_SOURCE.indexOf("function clearFetDiagnosticPanel(", start);
  assert.ok(start >= 0 && end > start, "Planner schedule state helpers must remain extractable");
  const context = {
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Date,
    Math,
    Set,
    Map,
    console
  };
  vm.runInNewContext(
    `${PHANMON_SOURCE.slice(start, end)}\nthis.contract = {\n` +
      "  clonePlannerScheduleState,\n" +
      "  restorePlannerScheduleState,\n" +
      "  cloneHybridScheduleState,\n" +
      "  restoreHybridScheduleState\n" +
      "};",
    context,
    {filename:PHANMON_PATH}
  );
  assert.ok(context.contract, "Planner schedule state helpers must load");
  return context.contract;
}

function sampleData(){
  return {
    tkb:{
      L1:{
        thu2:{sang:["Toán", "", "", "", ""], chieu:["", "", "", "", ""]}
      }
    },
    tkbLessonTeachers:{L1:{Toán:"GV1"}},
    tkbLessonRooms:{L1:{Toán:"P101"}}
  };
}

test("clonePlannerScheduleState produces an isolated snapshot without legacy solver residue", () => {
  const contract = loadPlannerStateContract();
  const data = sampleData();
  const snapshot = contract.clonePlannerScheduleState(data);

  assert.deepEqual(snapshot.tkb, data.tkb);
  assert.deepEqual(snapshot.tkbLessonTeachers, data.tkbLessonTeachers);
  assert.deepEqual(snapshot.tkbLessonRooms, data.tkbLessonRooms);
  assert.equal(snapshot.tkbSolverResult, undefined);
  assert.equal(snapshot.tkbRustSolverResult, undefined);

  // Mutations to original do not affect snapshot
  data.tkb.L1.thu2.sang[0] = "Văn";
  assert.equal(snapshot.tkb.L1.thu2.sang[0], "Toán");
});

test("restorePlannerScheduleState cleanly restores schedule state", () => {
  const contract = loadPlannerStateContract();
  const data = sampleData();
  const snapshot = contract.clonePlannerScheduleState(data);

  data.tkb.L1.thu2.sang[0] = "Lý";
  data.tkbLessonTeachers["L1"] = {Lý:"GV2"};
  data.tkbLessonRooms["L1"] = {Lý:"P102"};

  contract.restorePlannerScheduleState(data, snapshot);

  assert.equal(data.tkb.L1.thu2.sang[0], "Toán");
  assert.deepEqual(data.tkbLessonTeachers, {L1:{Toán:"GV1"}});
  assert.deepEqual(data.tkbLessonRooms, {L1:{Toán:"P101"}});
});

test("phanmon.js contains no legacy CP-SAT, Cloud Run fallback, or modal dialogs", () => {
  assert.doesNotMatch(PHANMON_SOURCE, /useHybridOptimization/);
  assert.doesNotMatch(PHANMON_SOURCE, /offerHybridFailureChoice/);
  assert.doesNotMatch(PHANMON_SOURCE, /hybridFailureChoice/);
  assert.doesNotMatch(PHANMON_SOURCE, /\/api\/admin\/solver-infrastructure/);
  assert.doesNotMatch(PHANMON_SOURCE, /normalizeHybridCloudRunResult/);
});
