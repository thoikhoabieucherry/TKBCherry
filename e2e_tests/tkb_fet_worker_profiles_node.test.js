"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const benchmark = require("../tools/benchmarks/benchmark-fet.js");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SOURCE = fs.readFileSync(path.join(ROOT, "web", "pages", "tkb-fet-engine.js"), "utf8");
const WORKER_SOURCE = fs.readFileSync(path.join(ROOT, "web", "pages", "tkb-fet-worker.js"), "utf8");

function createWorkerHarness(){
  const messages = [];
  const self = { postMessage(message){ messages.push(message); } };
  const context = vm.createContext({
    self,
    globalThis:self,
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    Object,
    RegExp,
    Promise,
    Int8Array,
    Int16Array,
    Int32Array,
    Float64Array,
    Uint8Array,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    importScripts(){ }
  });
  vm.runInContext(ENGINE_SOURCE, context, {filename:"tkb-fet-engine.js"});
  vm.runInContext(WORKER_SOURCE, context, {filename:"tkb-fet-worker.js"});
  return {
    messages,
    async send(data){
      messages.length = 0;
      await self.onmessage({data});
      return messages.filter(message => message.type === "done").slice(-1)[0];
    }
  };
}

test("legacy automatic requests now return after quick construction", async () => {
  const harness = createWorkerHarness();
  const fixture = benchmark.createMediumFixture();
  const startedAt = Date.now();
  const result = await harness.send({
    action:"solve",
    mode:"solve_optimize_all",
    data:fixture,
    options:{seed:101, constructionTimeBudgetMs:6_000}
  });

  assert.equal(result.ok, true);
  assert.equal(result.unassigned, 0);
  assert.equal(result.timing.phase, "construction");
  assert.equal(result.timing.attempts, 1);
  assert.ok(Date.now() - startedAt < 6_000);

  fixture.tkb = result.tkb;
  const validation = benchmark.validateSchedule(fixture, null);
  assert.equal(validation.valid, true);
  assert.equal(validation.lessonCount, validation.expectedLessonCount);
});

test("focused worker profiles improve only on an explicit optimize action", async () => {
  const harness = createWorkerHarness();
  const fixture = benchmark.createMediumFixture();
  const construction = await harness.send({
    action:"construct",
    mode:"solve_fast",
    data:fixture,
    options:{seed:101, constructionTimeBudgetMs:6_000}
  });
  assert.equal(construction.ok, true);
  fixture.tkb = construction.tkb;

  const singleton = await harness.send({
    action:"optimize",
    mode:"optimize_singletons",
    data:fixture,
    options:{seed:101, singletonRush:true, optimizeTimeBudgetMs:8_000}
  });
  assert.equal(singleton.ok, true);
  assert.equal(singleton.timing.phase, "optimization");
  assert.equal(singleton.timing.mode, "optimize_singletons");
  assert.ok(singleton.metrics.soBuoiDay1 < singleton.initialMetrics.soBuoiDay1);
  assert.equal(singleton.metrics.unplacedCount, 0);
  assert.ok(harness.messages.every(message => message.heartbeat !== true || message.checkpoint == null));

  const sessions = await harness.send({
    action:"optimize",
    mode:"optimize_sessions",
    data:fixture,
    options:{seed:101, optimizeTimeBudgetMs:8_000}
  });
  assert.ok(sessions.metrics.tsBuoiDay < sessions.initialMetrics.tsBuoiDay);
  assert.equal(sessions.metrics.soBuoiDay1 <= sessions.initialMetrics.soBuoiDay1, true);

  const gap1 = await harness.send({
    action:"optimize",
    mode:"optimize_gap1",
    data:fixture,
    options:{seed:101, optimizeTimeBudgetMs:8_000}
  });
  assert.ok(gap1.metrics.soBuoiTrong1 < gap1.initialMetrics.soBuoiTrong1);
  assert.equal(gap1.metrics.soBuoiTrong2, gap1.initialMetrics.soBuoiTrong2);

  const gap2 = await harness.send({
    action:"optimize",
    mode:"optimize_gap2",
    data:fixture,
    options:{seed:101, optimizeTimeBudgetMs:8_000}
  });
  assert.equal(gap2.metrics.soBuoiTrong2, 0);
  assert.equal(gap2.targetReached, true);
});
