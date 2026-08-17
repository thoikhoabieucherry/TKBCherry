"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");

/**
 * Load the production Hybrid normalizer and its two local helpers without
 * booting the whole planner DOM.  Keeping this as an executable source slice
 * means the tests exercise the exact implementation used by the page while
 * avoiding unrelated browser initialization and network dependencies.
 */
function loadHybridContract(){
  const start = PHANMON_SOURCE.indexOf("function cloneHybridScheduleState(");
  const end = PHANMON_SOURCE.indexOf("async function offerHybridFailureChoice(", start);
  assert.ok(start >= 0 && end > start, "Hybrid contract helpers must remain extractable");
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
    `${PHANMON_SOURCE.slice(start, end)}\nthis.hybridContract = {\n` +
      "  cloneHybridScheduleState,\n" +
      "  restoreHybridScheduleState,\n" +
      "  hybridCandidateTkbFromResponse,\n" +
      "  hybridStableJson,\n" +
      "  hybridCandidateScheduledCellCount,\n" +
      "  hybridMetricSnapshot,\n" +
      "  hybridParetoAcceptance,\n" +
      "  normalizeHybridCloudRunResult\n" +
      "};",
    context,
    {filename:PHANMON_PATH}
  );
  assert.ok(context.hybridContract, "Hybrid contract helpers must load");
  return context.hybridContract;
}

function incumbentData(){
  return {
    tkb:{
      L1:{
        thu2:{sang:["Toán", "", "", "", ""], chieu:["", "", "", "", ""]}
      }
    },
    tkbLessonTeachers:{L1:{Toán:"GV1"}},
    tkbLessonRooms:{},
    tkbSolverResult:{revision:"incumbent"}
  };
}

function validResponse(candidateTkb, overrides = {}){
  return {
    ok:true,
    candidateTkb,
    candidate:Object.assign({
      lessons:[{
        classId:"L1",
        className:"10A1",
        subject:"Toán",
        teacher:"GV1",
        room:"",
        day:2,
        session:"AM",
        period:1
      }],
      metrics:{
        expected_periods:1,
        scheduled_periods:1,
        unassigned_periods:0,
        hard_ok:true,
        core_hard_ok:true
      },
      validation:{hard_ok:true, violations:[]}
    }, overrides)
  };
}

test("Hybrid rejects ok responses without an explicit candidate timetable", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const response = validResponse(undefined);
  delete response.candidateTkb;

  const result = contract.normalizeHybridCloudRunResult(response, data);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.executor, "cloud_run");
  assert.equal(result.failureKind, "cloud_run_candidate_rejected");
  assert.equal(result.tkb, undefined);
  assert.deepEqual(data.tkb, incumbentData().tkb, "normalization must not mutate incumbent data");
});

test("Hybrid accepts a complete hard-valid response with a new explicit candidate", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const incumbentFingerprint = contract.hybridStableJson(data.tkb);
  const candidateTkb = {
    L1:{
      thu2:{sang:["", "Toán", "", "", ""], chieu:["", "", "", "", ""]}
    }
  };

  const result = contract.normalizeHybridCloudRunResult(
    validResponse(candidateTkb),
    data,
    incumbentFingerprint
  );

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.executor, "cloud_run");
  assert.deepEqual(result.tkb, candidateTkb);
  assert.equal(result.failureKind, "");
  assert.equal(
    contract.hybridCandidateScheduledCellCount({
      L1:{thu2:{sang:[{mon:"Toán", fixed:true}], chieu:[""]}}
    }),
    1,
    "legacy object lesson cells must count as scheduled"
  );
});

test("Hybrid rejects an empty candidate even when stale metrics claim completion", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const response = validResponse({});

  const result = contract.normalizeHybridCloudRunResult(
    response,
    data,
    contract.hybridStableJson(data.tkb)
  );

  assert.equal(contract.hybridCandidateScheduledCellCount({}), 0);
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "cloud_run_candidate_rejected");
  assert.deepEqual(data.tkb, incumbentData().tkb, "an empty candidate must not erase the incumbent");
});

test("Hybrid does not treat stale data.tkb as Cloud Run success evidence", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  // Metrics/lessons alone describe a valid-looking result, but there is no
  // candidate payload.  The old timetable in data.tkb must be ignored.
  const response = validResponse(undefined);
  delete response.candidateTkb;
  delete response.candidate;
  response.metrics = {
    expected_periods:1,
    scheduled_periods:1,
    unassigned_periods:0,
    hard_ok:true,
    core_hard_ok:true
  };
  response.validation = {hard_ok:true, violations:[]};
  response.lessons = [{classId:"L1", subject:"Toán"}];

  const result = contract.normalizeHybridCloudRunResult(response, data);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.tkb, undefined);
  assert.deepEqual(data.tkb, incumbentData().tkb);
});

test("Hybrid reports a valid incumbent-equivalent candidate as a no-op", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const incumbentFingerprint = contract.hybridStableJson(data.tkb);

  const result = contract.normalizeHybridCloudRunResult(
    validResponse(data.tkb),
    data,
    incumbentFingerprint
  );

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.executor, "cloud_run");
  assert.equal(result.failureKind, "cloud_run_no_pareto_improvement");
  assert.deepEqual(result.tkb, data.tkb);
});

test("Hybrid accepts only a mode-specific Pareto improvement", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const incumbentFingerprint = contract.hybridStableJson(data.tkb);
  const incumbentMetrics = {
    soBuoiDay1:3,
    tsBuoiDay:12,
    soBuoiTrong1:4,
    soBuoiTrong2:2
  };
  const candidateTkb = {
    L1:{
      thu2:{sang:["", "Toán", "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  const response = validResponse(candidateTkb, {
    metrics:{
      expected_periods:1,
      scheduled_periods:1,
      unassigned_periods:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:3,
      teacher_sessions:12,
      teacher_gap1_sessions:3,
      teacher_gap2_sessions:1,
      gap_distribution:{"1":3,"2":1}
    }
  });
  response.hybridMode = "optimize_gap2";
  response.hybridIncumbentMetrics = incumbentMetrics;

  const accepted = contract.normalizeHybridCloudRunResult(response, data, incumbentFingerprint);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.applied, true);
  assert.equal(accepted.pareto.enforced, true);

  const worseSingleton = validResponse(candidateTkb, {
    metrics:Object.assign({}, response.candidate.metrics, {
      one_period_teacher_sessions:4,
      teacher_gap2_sessions:0,
      gap_distribution:{"1":3,"2":0}
    })
  });
  worseSingleton.hybridMode = "optimize_gap2";
  worseSingleton.hybridIncumbentMetrics = incumbentMetrics;
  const rejected = contract.normalizeHybridCloudRunResult(worseSingleton, data, incumbentFingerprint);
  assert.equal(rejected.ok, true, "a complete but non-Pareto candidate is a safe no-op");
  assert.equal(rejected.applied, false);
  assert.equal(rejected.failureKind, "cloud_run_no_pareto_improvement");
});

test("Hybrid fails closed when a focused response omits Pareto evidence", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const response = validResponse({
    L1:{thu2:{sang:["", "Toán", "", "", ""], chieu:["", "", "", "", ""]}}
  });
  response.hybridMode = "optimize_sessions";
  response.hybridIncumbentMetrics = {
    soBuoiDay1:1,
    tsBuoiDay:3,
    soBuoiTrong1:0,
    soBuoiTrong2:0
  };

  const result = contract.normalizeHybridCloudRunResult(
    response,
    data,
    contract.hybridStableJson(data.tkb)
  );
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "cloud_run_pareto_metrics_missing");
});

test("Hybrid accepts a candidate captured from a legacy bridge-applied snapshot", () => {
  const contract = loadHybridContract();
  const data = incumbentData();
  const candidateTkb = {
    L1:{
      thu2:{sang:["", "", "Toán", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  // This is the shape produced by executeDirectFastSchedule after a legacy
  // bridge applied DATA.tkb before resolving: the bridge adds candidateTkb to
  // the original top-level result, without wrapping it in `candidate`.
  const response = validResponse(candidateTkb);
  const payload = response.candidate;
  delete response.candidate;
  response.metrics = payload.metrics;
  response.validation = payload.validation;
  response.lessons = payload.lessons;
  response.candidateSource = "bridge_applied_snapshot";

  const result = contract.normalizeHybridCloudRunResult(
    response,
    data,
    contract.hybridStableJson(data.tkb)
  );

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.deepEqual(result.tkb, candidateTkb);
});

test("Hybrid timeout and 422 failures keep the incumbent untouched", () => {
  const contract = loadHybridContract();
  for(const [status, failureKind] of [[504, "cloud_run_candidate_rejected"], [422, "cloud_run_candidate_rejected"]]){
    const data = incumbentData();
    const before = JSON.parse(JSON.stringify(data.tkb));
    const response = {
      ok:false,
      status,
      error:status === 504 ? "Cloud Run timeout" : "Dữ liệu không hợp lệ"
    };
    const result = contract.normalizeHybridCloudRunResult(response, data);

    assert.equal(result.ok, false, `${status} must fail closed`);
    assert.equal(result.applied, false, `${status} must not apply a candidate`);
    assert.equal(result.executor, "cloud_run");
    assert.equal(result.failureKind, failureKind);
    assert.deepEqual(data.tkb, before, `${status} must preserve incumbent timetable`);
  }
});
