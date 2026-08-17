"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const benchmark = require("../tools/benchmarks/benchmark-fet.js");

test("FET benchmark fixture is deterministic and anonymized", () => {
  const first = benchmark.createFixture();
  const second = benchmark.createFixture();
  assert.deepEqual(first, second);
  assert.equal(first.__benchmark.name, "fet-anonymized-contention-v1");
  assert.equal(first.__benchmark.requiredPeriods, 49);
  assert.equal(first.giaovien.some(row => /Phạm|Trần|Vũ|Nguyễn/i.test(String(row.ten))), false);
});

test("FET benchmark records complete-valid Auto and focused runs", async () => {
  const loaded = benchmark.loadEngine();
  const options = {autoBudgetMs:1_000, optimizerTimeoutMs:1_000};
  const auto = await benchmark.runOne(loaded, "auto", 101, options);
  const gap2 = await benchmark.runOne(loaded, "optimize_gap2", 101, options);

  assert.equal(auto.completeValid, true);
  assert.equal(auto.valid, true);
  assert.equal(auto.failureKind, null);
  assert.equal(gap2.completeValid, true);
  assert.equal(gap2.valid, true);
  assert.equal(gap2.targetMetric, "soBuoiTrong2");
  assert.equal(gap2.validationViolationCount, 0);
});

test("FET benchmark aggregate exposes rates and p50/p95 runtime", () => {
  const summary = benchmark.aggregate([
    {mode:"auto", completeValid:true, valid:true, targetReached:null, runtimeMs:10, metrics:{soBuoiDay1:1, tsBuoiDay:2, tsNgayDay:1, soBuoiTrong1:0, soBuoiTrong2:0, unplacedCount:0}, validationViolationCount:0, failureKind:null},
    {mode:"auto", completeValid:true, valid:true, targetReached:null, runtimeMs:20, metrics:{soBuoiDay1:0, tsBuoiDay:2, tsNgayDay:1, soBuoiTrong1:0, soBuoiTrong2:0, unplacedCount:0}, validationViolationCount:0, failureKind:null},
    {mode:"optimize_gap2", completeValid:false, valid:false, targetReached:false, runtimeMs:30, metrics:null, validationViolationCount:1, failureKind:"candidate_rejected"}
  ]);

  assert.equal(summary.auto.completeValidRate, 1);
  assert.equal(summary.auto.hardValidRate, 1);
  assert.equal(summary.auto.runtimeMs.p50, 10);
  assert.equal(summary.auto.runtimeMs.p95, 20);
  assert.equal(summary.optimize_gap2.completeValidRate, 0);
  assert.equal(summary.optimize_gap2.validationRejections, 1);
});
