"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const RUNNER = path.join(ROOT, "solver_runtime", "scripts", "fet_trongoi_runner.cjs");
const PROGRESS_PREFIX = "@@TKB_PROGRESS@@";
const RUNNER_SOURCE = require("node:fs").readFileSync(RUNNER, "utf8");

function makeFixture(){
  const data = {
    lop: [1, 2, 3, 4].map(index => ({
      id:`L${index}`,
      ten:`10A${index}`,
      ten2:`10A${index}`,
      khoi:"10"
    })),
    mon:[{ten:"Toán", khoi:"10", sotiet:1, gioihan:1}],
    monhoc:[{ten:"Toán", ma:"TOAN"}],
    giaovien:[{ma:"GV01", ten:"GV01"}],
    pccmMatrix:{},
    pccmTietMatrix:{},
    pccmRoomMatrix:{},
    pccmGioihanMatrix:{},
    tkb:{},
    tkbLessonTeachers:{},
    tkbLessonRooms:{},
    tkbConstraints:{}
  };
  for(let index = 1; index <= 4; index++){
    const classId = `L${index}`;
    const day = ["thu2", "thu3", "thu4", "thu5"][index - 1];
    data.pccmMatrix[`${classId}|Toán`] = "GV01";
    data.pccmTietMatrix[`${classId}|Toán`] = 1;
    data.tkb[classId] = {
      [day]: {sang:["Toán", "", "", "", ""]}
    };
  }
  return data;
}

function runRunner(settings = {}){
  const request = {
    engine:"fet_trongoi",
    data:makeFixture(),
    settings:Object.assign({
      fet_backend_parallel_workers:2,
      fet_backend_total_state_budget:101,
      fet_backend_lane_budget_ms:12_000,
      session_first_time_budget_ms:1_000,
      initial_singleton_warmup_ms:0,
      seed:41
    }, settings)
  };
  const completed = spawnSync(process.execPath, [RUNNER], {
    cwd:ROOT,
    input:JSON.stringify(request),
    encoding:"utf8",
    timeout:20_000,
    env:Object.assign({}, process.env, {TKB_SOLVER_MAX_WORKERS:"2"})
  });
  assert.equal(completed.error, undefined, completed.error?.message);
  assert.equal(completed.status, 0, completed.stderr);
  const wrapper = JSON.parse(completed.stdout.trim());
  const frames = completed.stderr
    .split(/\r?\n/)
    .filter(line => line.startsWith(PROGRESS_PREFIX))
    .map(line => JSON.parse(line.slice(PROGRESS_PREFIX.length)));
  return {wrapper, frames};
}

test("backend FET runner keeps the shared state ceiling exact when split across lanes", () => {
  const {wrapper, frames} = runRunner();
  assert.equal(wrapper.protocol, "tkb-reference-solver-stdio-v1");
  assert.equal(wrapper.status, 200);
  const payload = wrapper.payload;
  assert.equal(payload.ok, true);
  assert.equal(payload.parallelWorkers, 2);
  assert.equal(payload.totalStateBudget, 101);
  const start = frames.find(frame => frame.stage === "backend_parallel");
  assert.deepEqual(start?.laneStateBudgets, [51, 50]);
  assert.ok(Number(payload.stateBudgetUsed) <= Number(payload.laneStateBudget));
});

test("backend FET runner emits the generic complete/hard-valid reference metrics", () => {
  const {wrapper, frames} = runRunner({
    fet_backend_parallel_workers:2,
    fet_backend_total_state_budget:1_000_000_000
  });
  const payload = wrapper.payload;
  const metrics = payload.metrics;
  assert.equal(payload.ok, true);
  assert.equal(metrics.unplacedCount, 0);
  assert.equal(metrics.unassigned_periods, 0);
  assert.equal(metrics.expected_periods, metrics.scheduled_periods);
  assert.equal(metrics.accounting_ok, true);
  assert.equal(metrics.hard_ok, true);
  assert.equal(metrics.core_hard_ok, true);
  assert.equal(metrics.app_constraint_violation_count, 0);
  assert.equal(metrics.soBuoiDay1, 0);
  assert.equal(metrics.soBuoiTrong2, 0);
  assert.equal(payload.validation.hard_ok, true);
  assert.equal(payload.unassignedLessons.length, 0);
  assert.equal(payload.lessons.length, metrics.expected_periods);
  const start = frames.find(frame => frame.stage === "backend_parallel");
  assert.deepEqual(start?.laneStateBudgets, [500_000_000, 500_000_000]);
});

test("complete-incumbent lanes reject quality regressions and expose stagnation", () => {
  assert.match(RUNNER_SOURCE, /completeIncumbent:\s*configured\.options\.__incumbentComplete === true/);
  assert.match(RUNNER_SOURCE, /candidate\.completeIncumbent && compareQuality\(candidate\.metrics, candidateBaseline\) > 0/);
  assert.match(RUNNER_SOURCE, /fet_backend_stall_ms/);
  assert.match(RUNNER_SOURCE, /backend_stagnated/);
});
