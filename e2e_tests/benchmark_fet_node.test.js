"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createFixture,
  createPressureFixture,
  createMediumFixture,
  createStressFixture,
  loadEngine,
  runOne,
  validateSchedule
} = require("../tools/benchmarks/benchmark-fet.js");

test("anonymized benchmark fixtures cover smoke, pressure, medium and stress sizes", () => {
  const smoke = createFixture().__benchmark;
  const pressure = createPressureFixture().__benchmark;
  const medium = createMediumFixture().__benchmark;
  const stress = createStressFixture().__benchmark;

  assert.equal(smoke.anonymized, true);
  assert.ok(pressure.structuralFloors.soBuoiTrong2 >= 1);
  assert.ok(medium.requiredPeriods >= 300 && medium.requiredPeriods < 700);
  assert.ok(stress.requiredPeriods >= 1500);
  assert.equal(medium.synthetic, true);
  assert.equal(stress.synthetic, true);
  assert.ok(medium.activeConstraintCounts.classSession > 0);
  assert.equal(stress.activeConstraintCounts.classSession, 0, "stress keeps both half-days available for feasibility");
});

test("smoke FET auto benchmark is complete and independently hard-valid", async () => {
  const loaded = loadEngine();
  const row = await runOne(loaded, "auto", 101, {
    fixture:"smoke",
    autoBudgetMs:1_000,
    optimizerTimeoutMs:2_000
  });
  assert.equal(row.completeValid, true);
  assert.equal(row.validationViolationCount, 0);
  assert.equal(row.unassigned, 0);
  assert.equal(row.lessonCount, row.expectedLessonCount);
  assert.ok(row.phaseRuntimeMs.construction >= 0);
  assert.equal(row.phaseRuntimeMs.optimization, 0);
});

test("medium FET fixture is structurally feasible and completes inside the quick profile", async () => {
  const loaded = loadEngine();
  const row = await runOne(loaded, "auto", 101, {
    fixture:"medium",
    autoBudgetMs:6_000,
    optimizerTimeoutMs:8_000
  });
  assert.equal(row.completeValid, true);
  assert.equal(row.unassigned, 0);
  assert.equal(row.validationViolationCount, 0);
  assert.ok(row.phaseRuntimeMs.construction < 6_000);
});

test("construction preflight rejects an over-capacity room without spending the search budget", () => {
  const {Engine} = loadEngine();
  const data = createMediumFixture();
  for(const key of Object.keys(data.pccmRoomMatrix)) data.pccmRoomMatrix[key] = "P001";
  const engine = new Engine(data, {seed:101, timeBudgetMs:6_000});
  const startedAt = Date.now();
  const result = engine.solve();

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "fet_capacity_shortage");
  assert.ok(result.diagnostics.capacityShortages.some(item => item.kind === "room" && item.entity === "p001"));
  assert.ok(Date.now() - startedAt < 1_000);
});

test("pressure fixture reports a fixed structural gap floor instead of claiming zero", async () => {
  const loaded = loadEngine();
  const row = await runOne(loaded, "optimize_gap2", 101, {
    fixture:"pressure",
    autoBudgetMs:1_000,
    optimizerTimeoutMs:2_000
  });
  assert.equal(row.completeValid, true);
  assert.equal(row.initialTarget, 1);
  assert.equal(row.finalTarget, 1);
  assert.equal(row.targetReached, false);
  assert.equal(row.knownLowerBound, 1);
  assert.equal(row.floorReached, true);
});

test("benchmark validator covers class session, subject max, block, spacing and no-same rules", () => {
  const data = createFixture();
  const c = data.tkb.C01;
  // Deliberately place an extra Toán in an afternoon cell for a morning-only
  // class, and put more than the configured two periods in one session.
  c.thu2.chieu[0] = "Toán";
  c.thu2.chieu[1] = "Toán";
  c.thu2.chieu[2] = "Toán";
  c.thu2.sang[3] = "Văn";
  c.thu3.sang[3] = "Văn";
  c.thu2.chieu[3] = "Văn";
  // Add optional representative rules; the production engine is not allowed
  // to claim them as satisfied unless this independent validator agrees.
  data.__benchmark.rules.spacingDays.push({classId:"C01", subject:"Văn", days:2});
  data.__benchmark.rules.noSameSession.push({classId:"C01", subjects:["Toán", "Văn"]});
  data.__benchmark.rules.noSameDay.push({classId:"C01", subjects:["Toán", "Văn"]});
  const report = validateSchedule(data, null);
  assert.equal(report.valid, false);
  assert.ok(report.violations.some(item => item.startsWith("class_session_violation:")));
  assert.ok(report.violations.some(item => item.startsWith("subject_session_limit:")));
  assert.ok(report.violations.some(item => item.startsWith("lesson_block_min:")));
  assert.ok(report.violations.some(item => item.startsWith("spacing_days:")));
  assert.ok(report.violations.some(item => item.startsWith("no_same_session:")));
  assert.ok(report.violations.some(item => item.startsWith("no_same_day:")));
});
