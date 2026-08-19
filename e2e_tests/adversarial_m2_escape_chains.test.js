"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ENGINE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-fet-engine.js"),
  "utf8"
);

function loadEngine() {
  const window = {};
  const context = vm.createContext({
    window,
    globalThis: window,
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
    setTimeout,
    clearTimeout,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array
  });
  vm.runInContext(ENGINE_SOURCE, context, { filename: "tkb-fet-engine.js" });
  return window.FetTimetableEngine;
}

const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const SESSIONS = ["sang", "chieu"];
const PERIODS = 5;

function makeData({
  classes = [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
  subjects = [{ name: "Toan", teacher: "GV01", periods: 2, limit: 2 }],
  constraints = {},
  tkb = {}
} = {}) {
  const teachers = Array.from(
    new Set(
      subjects
        .map((s) => String(s.teacher || "").trim())
        .filter(Boolean)
    )
  );

  const data = {
    lop: classes,
    mon: subjects.map((s) => ({
      ten: s.name,
      khoi: classes[0]?.khoi || "10",
      sotiet: s.periods || 1,
      gioihan: s.limit || 2
    })),
    monhoc: subjects.map((s) => ({ ten: s.name, ma: s.name })),
    giaovien: teachers.map((ma) => ({ ma, ten: ma, id: ma })),
    pccmMatrix: {},
    pccmTietMatrix: {},
    pccmRoomMatrix: {},
    pccmGioihanMatrix: {},
    tkb,
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: constraints
  };

  classes.forEach((c) => {
    subjects.forEach((s) => {
      if (s.classId && s.classId !== c.id) return;
      data.pccmMatrix[`${c.id}|${s.name}`] = s.teacher;
      data.pccmTietMatrix[`${c.id}|${s.name}`] = s.periods || 1;
      if (s.limit) {
        data.pccmGioihanMatrix[`${c.id}|${s.name}`] = s.limit;
      }
    });
  });

  return data;
}

// ============================================================================
// ADVERSARIAL CHALLENGES
// ============================================================================

test("CHALLENGE 1: Multi-Step 2-Period Displacement Chain under Contention", async () => {
  const FetEngine = loadEngine();
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10" },
    { id: "C2", ten: "10A2", khoi: "10" }
  ];

  const subjects = [
    { name: "Toan_T1", teacher: "T1", periods: 4, limit: 1, classId: "C1" },
    { name: "Ly_T2", teacher: "T2", periods: 6, limit: 2, classId: "C1" },
    { name: "Hoa_T3", teacher: "T3", periods: 6, limit: 2, classId: "C2" },
    { name: "Van_T4", teacher: "T4", periods: 4, limit: 2, classId: "C2" }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 42, minTwoGuardActive: true, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, "Initial solve must succeed");
  assert.equal(solveRes.unassigned, 0, "All activities placed");

  const initialMetrics = engine.evaluateMetrics();
  assert.equal(initialMetrics.unplacedCount, 0, "All activities placed");
  assert.equal(initialMetrics.soBuoiTrong2, 0, "No gap-2 initial");
  assert.equal(engine.countTotalStudentHoles(), 0, "No student holes initial");

  // Run singleton escape chains optimization
  await engine.optimize("optimize_singletons");

  const optMetrics = engine.evaluateMetrics();
  assert.equal(optMetrics.unplacedCount, 0, "All activities remain placed");
  assert.equal(optMetrics.soBuoiTrong2, 0, "No gap-2 introduced");
  assert.equal(engine.countTotalStudentHoles(), 0, "No student holes introduced");
  assert.ok(optMetrics.soBuoiDay1 <= initialMetrics.soBuoiDay1, "Singletons must decrease or stay minimal");
});

test("CHALLENGE 2: Tabu Memory and Branch Set Prevent Cyclic Infinite Loops in randomSwap", () => {
  const FetEngine = loadEngine();
  const classes = [{ id: "C1", ten: "10A1", khoi: "10" }];
  const subjects = [
    { name: "M1", teacher: "T1", periods: 3, limit: 1, classId: "C1" },
    { name: "M2", teacher: "T2", periods: 3, limit: 1, classId: "C1" }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Test randomSwap with Tabu map under finite call budget
  engine.tabuMap.clear();
  engine.swappedInBranch.clear();
  engine.triedRemovals.clear();
  engine.nCalls = 0;
  engine.limitCalls = 500;

  const ok = engine.randomSwap(0, 0);
  assert.ok(typeof ok === "boolean", "randomSwap returns boolean");
  assert.ok(engine.nCalls <= 500, "Calls strictly respect call limit");
  assert.equal(engine.swappedInBranch.size, 0, "swappedInBranch cleans up on exit");
});

test("CHALLENGE 3: Multi-Period Swaps under 100% Dense Slot Contention", async () => {
  const FetEngine = loadEngine();
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10" },
    { id: "C2", ten: "10A2", khoi: "10" }
  ];

  const subjects = [
    { name: "M1", teacher: "T1", periods: 4, limit: 2, classId: "C1" },
    { name: "M2", teacher: "T2", periods: 4, limit: 2, classId: "C1" },
    { name: "M3", teacher: "T3", periods: 4, limit: 2, classId: "C1" },
    { name: "M4", teacher: "T4", periods: 4, limit: 2, classId: "C1" },
    { name: "M5", teacher: "T5", periods: 4, limit: 2, classId: "C1" },
    { name: "N1", teacher: "T1", periods: 4, limit: 2, classId: "C2" },
    { name: "N2", teacher: "T2", periods: 4, limit: 2, classId: "C2" },
    { name: "N3", teacher: "T3", periods: 4, limit: 2, classId: "C2" },
    { name: "N4", teacher: "T4", periods: 4, limit: 2, classId: "C2" },
    { name: "N5", teacher: "T5", periods: 4, limit: 2, classId: "C2" }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 999, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, "Dense schedule must solve");
  assert.equal(solveRes.unassigned, 0);

  const mBefore = engine.evaluateMetrics();
  assert.equal(mBefore.unplacedCount, 0);

  // Test intra-class and cross-class swaps
  await engine.tryIntraClassSingletonSwap(mBefore);
  await engine.tryCrossClassSingletonKempeSwap(mBefore);
  await engine.trySingletonEjectionChains(mBefore);

  const mAfter = engine.evaluateMetrics();
  assert.equal(mAfter.unplacedCount, 0, "No unplaced activities");
  assert.equal(mAfter.soBuoiTrong2, 0, "No 2-period gaps");
  assert.equal(engine.countTotalStudentHoles(), 0, "No student holes");
});

test("CHALLENGE 4: Shift-Isolated Mathematical Exception Resistance", async () => {
  const FetEngine = loadEngine();
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10" }
  ];

  // Teacher T_Iso has 4 periods (2 x 2) + 1 period = 5 periods (odd load)
  const subjects = [
    { name: "MonSang", teacher: "T_Iso", periods: 4, limit: 2, classId: "C1" },
    { name: "MonLe", teacher: "T_Iso", periods: 1, limit: 1, classId: "C1" },
    { name: "Other1", teacher: "T_Other1", periods: 4, limit: 2, classId: "C1" }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 777, minTwoGuardActive: true, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, "Solver handles odd load");
  assert.equal(solveRes.unassigned, 0);

  // Run optimization pipeline
  await engine.optimize("optimize_singletons");

  const metrics = engine.evaluateMetrics();
  assert.equal(metrics.unplacedCount, 0, "Must be fully placed");
  assert.equal(metrics.soBuoiTrong2, 0, "Zero gap-2");
  assert.equal(engine.countTotalStudentHoles(), 0, "Zero student holes");
  assert.equal(metrics.soBuoiDay1, 0, "Odd load of 5 is packed into 2 sessions (2+3) with 0 singletons");
});

test("CHALLENGE 5: High-Pressure Randomized Stress Test (50 Iterations)", async () => {
  const FetEngine = loadEngine();
  const iterations = 50;
  let totalTimeMs = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const seed = 1000 + iter * 17;
    const numClasses = 2 + (iter % 3); // 2 to 4 classes
    const classes = [];
    for (let c = 0; c < numClasses; c++) {
      classes.push({ id: `L${c+1}`, ten: `10A${c+1}`, khoi: "10" });
    }

    const numTeachers = 3 + (iter % 4); // 3 to 6 teachers
    const subjects = [];
    for (let c = 0; c < numClasses; c++) {
      for (let s = 0; s < 3; s++) {
        const tIdx = (c * 2 + s) % numTeachers;
        const periods = 2 + ((s + iter) % 3); // 2, 3, or 4 periods
        subjects.push({
          name: `Sub_${c}_${s}`,
          teacher: `GV_${tIdx}`,
          periods,
          limit: 2,
          classId: `L${c+1}`
        });
      }
    }

    const data = makeData({ classes, subjects });
    const startTime = Date.now();
    const engine = new FetEngine(data, { seed, minTwoGuardActive: true, uiBreathingMs: 0 });
    const solved = engine.solve();
    assert.equal(solved.ok, true, `Iteration ${iter} must solve`);
    assert.equal(solved.unassigned, 0, `Iteration ${iter} unassigned === 0`);

    await engine.optimize("optimize_singletons");
    const elapsed = Date.now() - startTime;
    totalTimeMs += elapsed;

    const m = engine.evaluateMetrics();
    assert.equal(m.unplacedCount, 0, `Iter ${iter}: unplacedCount === 0`);
    assert.equal(m.soBuoiTrong2, 0, `Iter ${iter}: soBuoiTrong2 === 0`);
    assert.equal(engine.countTotalStudentHoles(), 0, `Iter ${iter}: studentHoles === 0`);
  }

  assert.ok(totalTimeMs > 0, `Stress test completed in ${totalTimeMs}ms`);
});

test("CHALLENGE 6: Full Real School Benchmark (live_school_default.json & dongkhoi_1566.json)", async () => {
  const FetEngine = loadEngine();

  // Test live_school_default.json (75 classes / 2,202 slots)
  const defaultPath = path.resolve(__dirname, "..", "scratch", "live_school_default.json");
  if (fs.existsSync(defaultPath)) {
    const rawData = JSON.parse(fs.readFileSync(defaultPath, "utf8"));
    const engine = new FetEngine(rawData, { seed: 2026, mode: "optimize_singletons", uiBreathingMs: 0 });
    engine.init();
    engine.loadExistingSchedule();

    const initialMetrics = engine.evaluateMetrics();
    assert.equal(initialMetrics.unplacedCount, 0, "live_school_default loaded 100% placed");

    await engine.optimize("optimize_singletons");
    const finalMetrics = engine.evaluateMetrics();

    assert.equal(finalMetrics.unplacedCount, 0, "live_school_default unplacedCount === 0");
    assert.equal(finalMetrics.soBuoiTrong2, 0, "live_school_default soBuoiTrong2 === 0");
    assert.equal(engine.countTotalStudentHoles(), 0, "live_school_default studentHoles === 0");
    assert.ok(finalMetrics.soBuoiDay1 <= 2, `live_school_default soBuoiDay1 <= 2 (actual: ${finalMetrics.soBuoiDay1})`);
  }

  // Test dongkhoi_1566.json (54 classes / 1,566 slots)
  const dongkhoiPath = path.resolve(__dirname, "..", "scratch", "dongkhoi_1566.json");
  if (fs.existsSync(dongkhoiPath)) {
    const rawData = JSON.parse(fs.readFileSync(dongkhoiPath, "utf8"));
    const engine = new FetEngine(rawData, { seed: 1566, minTwoGuardActive: true, uiBreathingMs: 0 });
    const solved = engine.solve();
    assert.equal(solved.ok, true, "dongkhoi solve must succeed");
    assert.equal(solved.unassigned, 0, "dongkhoi all 1,566 placed");

    await engine.optimize("optimize_singletons");
    const m = engine.evaluateMetrics();

    assert.equal(m.unplacedCount, 0, "dongkhoi unplacedCount === 0");
    assert.equal(m.soBuoiTrong2, 0, "dongkhoi soBuoiTrong2 === 0");
    assert.equal(engine.countTotalStudentHoles(), 0, "dongkhoi studentHoles === 0");
    assert.ok(m.soBuoiDay1 <= 4, `dongkhoi soBuoiDay1 <= 4 (actual: ${m.soBuoiDay1})`);
  }
});
