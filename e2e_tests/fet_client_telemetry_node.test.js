"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web", "pages", "phanmon.js"), "utf8");

function telemetryHelpers(){
  const start = source.indexOf("function fetTelemetryNowMs(){");
  const end = source.indexOf("\nasync function executeDirectFastSchedule", start);
  assert.ok(start >= 0 && end > start, "FET telemetry helpers must remain a standalone safe slice");
  return source.slice(start, end);
}

test("FET terminal telemetry posts only the strict aggregate event schema", async () => {
  const fetchCalls = [];
  const window = {
    fetch(url, options){
      fetchCalls.push({url, options});
      return Promise.resolve({ok:true});
    },
    TKBAuthApi:{
      getAuthHeaders(){ return {Authorization:"Bearer current-session"}; }
    }
  };
  const context = {
    window,
    performance:{now(){ return 1_432.8; }},
    crypto:{randomUUID(){ return "12345678-1234-1234-1234-123456789abc"; }},
    Date:{now(){ return 99; }},
    Math,
    Number,
    String,
    Object,
    JSON,
    Promise,
    console
  };
  vm.runInNewContext(telemetryHelpers(), context, {filename:"fet-client-telemetry.js"});
  const payload = context.postFetTerminalTelemetry(
    {mode:"optimize_gap2", fallbackFromCloudRun:true, localFetBudgetSeconds:12},
    1_000,
    {ok:true, applied:true, executor:"fet_worker"},
    {
      hardValid:true,
      targetReached:false,
      floorReached:false,
      targetMetric:0,
      floorMetric:1,
      initialMetrics:{soBuoiTrong2:5},
      metrics:{soBuoiTrong2:2}
    }
  );
  await Promise.resolve();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/solver-telemetry/fet");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer current-session");
  assert.equal(fetchCalls[0].options.keepalive, true);
  assert.deepEqual(Object.keys(payload).sort(), [
    "applied", "budgetKind", "budgetSeconds", "eventId", "executor", "fallback", "floorMetric", "floorReached",
    "focus", "gapTarget", "hardValid", "metricAfter", "metricBefore", "metricDelta", "metricKey", "outcome",
    "resultKind", "runtimeMs", "targetMetric", "targetReached"
  ].sort());
  assert.equal(payload.executor, "fet_web_worker");
  assert.equal(payload.focus, "gaps");
  assert.equal(payload.gapTarget, "gap2");
  assert.equal(payload.budgetKind, "local");
  assert.equal(payload.budgetSeconds, 12);
  assert.equal(payload.runtimeMs, 433);
  assert.equal(payload.outcome, "completed");
  assert.equal(payload.resultKind, "completed");
  assert.equal(payload.fallback, "cloud_run_failed");
  assert.equal(payload.metricKey, "gap2");
  assert.equal(payload.metricBefore, 5);
  assert.equal(payload.metricAfter, 2);
  assert.equal(payload.metricDelta, 3);
  assert.equal(payload.floorMetric, 1);
  assert.doesNotMatch(JSON.stringify(payload), /tkb|teacher|class|school|error|diagnostic/i);
});

test("FET telemetry maps invalid candidates to a sanitized result code", async () => {
  const window = {
    fetch(){ return Promise.resolve({ok:true}); },
    TKBAuthApi:{getAuthHeaders(){ return {Authorization:"Bearer current-session"}; }}
  };
  const context = {
    window,
    performance:{now(){ return 10; }},
    crypto:{randomUUID(){ return "abcdef12-3456-7890-abcd-ef1234567890"; }},
    Date:{now(){ return 10; }},
    Math,
    Number,
    String,
    Object,
    JSON,
    Promise,
    console
  };
  vm.runInNewContext(telemetryHelpers(), context, {filename:"fet-client-telemetry-failure.js"});
  const payload = context.postFetTerminalTelemetry(
    {mode:"optimize_singletons"},
    0,
    {ok:false, applied:false, failureKind:"fet_candidate_hard_validation_failed"},
    {hardValid:false, initialMetrics:{soBuoiDay1:4}, metrics:{soBuoiDay1:4}}
  );
  assert.equal(payload.outcome, "failed");
  assert.equal(payload.resultKind, "hard_constraint_violation");
  assert.equal(payload.focus, "singletons");
  assert.equal(payload.metricKey, "singletons");
});

test("FET worker-posted error frames settle fail-closed instead of leaving the planner busy", () => {
  assert.match(source, /else if\(msg\.type === "error"\)\{[\s\S]{0,1500}failureKind:"fet_worker_error"/);
  assert.match(source, /msg\.type === "error"[\s\S]{0,900}worker\.terminate\(\)/);
  assert.match(source, /msg\.type === "error"[\s\S]{0,1200}settleWorker\(/);
});
