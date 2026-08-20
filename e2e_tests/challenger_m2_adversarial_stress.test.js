'use strict';

/**
 * Challenger M2 Adversarial Stress Test Suite
 * Milestone: M2 (Deep Compute Budget & Deep Cycles)
 * 
 * Verifies:
 * 1. Memory stability and zero heap exhaustion under sustained deep compute (deepCycles=12, limitCalls=4000, deepLocalFet=true)
 * 2. Recursion stack safety: zero RangeError / stack overflow under deep recursive displacement chains
 * 3. Smooth non-blocking cooperative event loop yielding (timer latency < 65ms)
 * 4. Full optimizeAll() pipeline execution under deep compute parameters
 * 5. Dynamic early cancellation / abort safety under deep compute
 * 6. Extreme parameter boundary resilience (deepCycles=20, limitCalls=10000)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ENGINE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '..', 'web', 'pages', 'tkb-fet-engine.js'),
  'utf8'
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
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
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
  vm.runInContext(ENGINE_SOURCE, context, { filename: 'tkb-fet-engine.js' });
  return window.FetTimetableEngine;
}

const FetEngine = loadEngine();

/**
 * Generates a synthetic multi-class schedule with known singletons and full placement.
 */
function createSyntheticDenseFixture(classCount = 6) {
  const classes = [];
  for (let c = 1; c <= classCount; c++) {
    classes.push({ id: `C${c}`, ten: `10A${c}`, khoi: '10', buoi: 'Sáng', shift: 'morning' });
  }

  const teachers = [];
  for (let t = 1; t <= 12; t++) {
    teachers.push({ ma: `GV_${t}`, ten: `GV_${t}`, id: `GV_${t}` });
  }

  const subjects = [
    { ten: 'Toán', khoi: '10', sotiet: 4, gioihan: 2 },
    { ten: 'Văn', khoi: '10', sotiet: 4, gioihan: 2 },
    { ten: 'Anh', khoi: '10', sotiet: 3, gioihan: 2 },
    { ten: 'Lý', khoi: '10', sotiet: 2, gioihan: 2 },
    { ten: 'Hóa', khoi: '10', sotiet: 2, gioihan: 2 },
    { ten: 'Sinh', khoi: '10', sotiet: 1, gioihan: 1 },
    { ten: 'Sử', khoi: '10', sotiet: 1, gioihan: 1 },
    { ten: 'Địa', khoi: '10', sotiet: 1, gioihan: 1 },
    { ten: 'GDCD', khoi: '10', sotiet: 1, gioihan: 1 },
    { ten: 'Tin', khoi: '10', sotiet: 1, gioihan: 1 }
  ];

  const pccmMatrix = {};
  const pccmTietMatrix = {};
  const pccmGioihanMatrix = {};

  classes.forEach((c, cIdx) => {
    subjects.forEach((s, sIdx) => {
      const tIdx = (cIdx + sIdx) % teachers.length;
      const t = teachers[tIdx].id;
      const key = `${c.id}|${s.ten}`;
      pccmMatrix[key] = t;
      pccmTietMatrix[key] = s.sotiet;
      pccmGioihanMatrix[key] = s.gioihan;
    });
  });

  const data = {
    lop: classes,
    mon: subjects,
    monhoc: subjects.map(s => ({ ten: s.ten, ma: s.ten })),
    giaovien: teachers,
    pccmMatrix,
    pccmTietMatrix,
    pccmGioihanMatrix,
    pccmRoomMatrix: {},
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {}
  };

  return data;
}

// -----------------------------------------------------------------------------
// ADV-M2-1: Memory Stability & Heap Leakage Under Sustained Deep Cycles
// -----------------------------------------------------------------------------
test('ADV-M2-1: Memory Stability & Zero Heap Exhaustion under deepCycles=12, limitCalls=4000, deepLocalFet=true', async () => {
  const data = createSyntheticDenseFixture(8);

  const engine = new FetEngine(data, {
    seed: 202608,
    deepCycles: 12,
    deepLocalFet: true,
    limitCalls: 4000,
    timeBudgetMs: 15000,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must place all activities');
  assert.equal(solveRes.unassigned, 0, 'Zero unassigned');

  if (global.gc) {
    global.gc();
  }
  const initialHeap = process.memoryUsage().heapUsed;

  // Run deep singleton optimization
  const res = await engine.optimize('optimize_singletons');
  assert.equal(res.ok, true, 'optimize_singletons must return ok=true');
  assert.equal(res.applied, true, 'Result must be applied');

  const metricsAfter = engine.evaluateMetrics();
  assert.equal(metricsAfter.unplacedCount, 0, 'No activities unplaced after deep cycles');
  assert.equal(metricsAfter.soBuoiTrong2, 0, 'Gap-2 must remain 0');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Student holes must remain 0');

  // Verify memory stability: heap growth must be strictly bounded (< 40MB delta)
  if (global.gc) {
    global.gc();
  }
  const postHeap = process.memoryUsage().heapUsed;
  const heapDeltaMB = (postHeap - initialHeap) / (1024 * 1024);

  assert.ok(heapDeltaMB < 40, `Heap growth after deep cycles must be < 40MB (actual: ${heapDeltaMB.toFixed(2)} MB)`);
});

// -----------------------------------------------------------------------------
// ADV-M2-2: Deep Call Stack & Recursion Safety
// -----------------------------------------------------------------------------
test('ADV-M2-2: Deep Call Stack & Recursion Safety (no stack overflow with limitCalls=5000)', async () => {
  const data = createSyntheticDenseFixture(6);

  const engine = new FetEngine(data, {
    seed: 7777,
    deepCycles: 12,
    deepLocalFet: true,
    limitCalls: 5000,
    timeBudgetMs: 10000,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');

  let stackError = null;
  try {
    const currentMetrics = engine.evaluateMetrics();
    await engine.tryTargetedIntraClassSingletonCrusher(currentMetrics);
    await engine.trySingletonEjectionChains(currentMetrics);
    await engine.tryClosedPushCycles(currentMetrics, null, 4);
    await engine.optimize('optimize_singletons');
  } catch (err) {
    stackError = err;
  }

  assert.equal(stackError, null, `Displacement chains must never throw RangeError / stack overflow: ${stackError?.message}`);
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes must be maintained after stress calls');
});

// -----------------------------------------------------------------------------
// ADV-M2-3: Smooth Non-Blocking Event Loop Heartbeat & Responsiveness
// -----------------------------------------------------------------------------
test('ADV-M2-3: Smooth Cooperative Event Loop Yielding (< 65ms interval latency)', async () => {
  const data = createSyntheticDenseFixture(8);

  const engine = new FetEngine(data, {
    seed: 9999,
    deepCycles: 12,
    deepLocalFet: true,
    limitCalls: 4000,
    timeBudgetMs: 10000,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');

  let maxHeartbeatDelay = 0;
  let heartbeatTicks = 0;
  let lastTick = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const delay = now - lastTick;
    if (delay > maxHeartbeatDelay) {
      maxHeartbeatDelay = delay;
    }
    heartbeatTicks++;
    lastTick = now;
  }, 10);

  const progressEvents = [];
  try {
    await engine.optimize('optimize_singletons', (p) => {
      progressEvents.push(p);
    });
  } finally {
    clearInterval(timer);
  }

  assert.ok(heartbeatTicks >= 1, `Event loop heartbeat must tick during optimization (actual ticks: ${heartbeatTicks})`);
  assert.ok(maxHeartbeatDelay < 65, `Max event loop blocking duration must be < 65ms (actual: ${maxHeartbeatDelay}ms)`);
});

// -----------------------------------------------------------------------------
// ADV-M2-4: optimizeAll() Full Pipeline Execution with Deep Parameters
// -----------------------------------------------------------------------------
test('ADV-M2-4: optimizeAll() Full Multi-Stage Pipeline under deepCycles=12, limitCalls=4000', async () => {
  const data = createSyntheticDenseFixture(6);

  const engine = new FetEngine(data, {
    seed: 42,
    deepCycles: 12,
    deepLocalFet: true,
    limitCalls: 4000,
    timeBudgetMs: 15000,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');

  const progressSnapshots = [];
  const res = await engine.optimizeAll((p) => {
    progressSnapshots.push({ percent: p.percent, stage: p.stage });
  });

  assert.equal(res.ok, true, 'optimizeAll must return ok=true');
  assert.equal(res.applied, true, 'optimizeAll result must be applied');
  assert.ok(progressSnapshots.length > 0, 'Progress callbacks must be received during optimizeAll');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, 'Zero unplaced activities');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero 2-period gaps');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
});

// -----------------------------------------------------------------------------
// ADV-M2-5: Dynamic Early Abort / Timeout Safety under Deep Compute
// -----------------------------------------------------------------------------
test('ADV-M2-5: Dynamic Early Abort under Deep Compute preserves schedule validity', async () => {
  const data = createSyntheticDenseFixture(8);

  const engine = new FetEngine(data, {
    seed: 1234,
    deepCycles: 12,
    deepLocalFet: true,
    limitCalls: 4000,
    timeBudgetMs: 30000,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');

  // Trigger stop after 50ms
  setTimeout(() => {
    engine.deadlineAtMs = Date.now() - 1;
  }, 50);

  const startTime = Date.now();
  const res = await engine.optimize('optimize_singletons');
  const elapsed = Date.now() - startTime;

  assert.equal(res.ok, true, 'Aborted optimization must cleanly return ok=true');
  assert.ok(elapsed < 2000, `Optimization must halt promptly after deadline trigger (elapsed: ${elapsed}ms)`);

  const metrics = engine.evaluateMetrics();
  assert.equal(metrics.unplacedCount, 0, 'Zero unplaced after early abort');
  assert.equal(metrics.soBuoiTrong2, 0, 'Zero gap-2 after early abort');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes after early abort');
});

// -----------------------------------------------------------------------------
// ADV-M2-6: Extreme Parameter Boundary Resilience (deepCycles=20, limitCalls=10000)
// -----------------------------------------------------------------------------
test('ADV-M2-6: Extreme Parameter Boundary Resilience (deepCycles=20, limitCalls=10000)', async () => {
  const data = createSyntheticDenseFixture(6);

  const engine = new FetEngine(data, {
    seed: 5555,
    deepCycles: 20,
    deepLocalFet: true,
    limitCalls: 10000,
    timeBudgetMs: 5000,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');
  assert.equal(engine.getAdaptiveLimitCalls(2000, 3500), 10000, 'Adaptive limit calls honors explicit limitCalls=10000');

  const res = await engine.optimize('optimize_singletons');
  assert.equal(res.ok, true, 'Engine must handle extreme parameters without error');

  const metrics = engine.evaluateMetrics();
  assert.equal(metrics.unplacedCount, 0, 'Unplaced remains 0');
  assert.equal(metrics.soBuoiTrong2, 0, 'Gap-2 remains 0');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Student holes remain 0');
});
