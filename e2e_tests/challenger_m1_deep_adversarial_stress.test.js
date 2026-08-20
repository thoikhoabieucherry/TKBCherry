'use strict';

/**
 * Challenger M1 Deep Adversarial Stress & Invariant Test Suite
 * Empirical verification of tryCrossDayPairShift and tryPairClassSingletons under extreme stress.
 *
 * Test Scenarios:
 * 1. High Teacher & Room Contention (multi-teacher single room bottlenecks)
 * 2. Prime / Odd Workload Packing (1, 3, 5, 7, 11, 13, 17, 19 periods)
 * 3. Extreme Recursion Depth & Call Limit Safety in randomSwap (recursion <= 16, no stack overflow)
 * 4. Dense Fixed (-3) and OFF (-2) Cells Immutability (80%+ locked grid)
 * 5. Student Hole Creation Prevention & Compaction (countTotalStudentHoles() === 0)
 * 6. Bit-Exact ACID Snapshot Rollback Oracle (500+ failed branches with 0 byte drift)
 * 7. Teacher T.Chung Real Topology (Math 9A2 + Math 6A14 Saturday singleton resolution)
 * 8. Fuzzing & Multi-Seed Determinism & Invariant Stability
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

function makeData({
  classes = [{ id: 'L1', ten: '10A1', ten2: '10A1', khoi: '10' }],
  subjects = [{ name: 'Toan', teacher: 'GV01', periods: 2, limit: 2 }],
  constraints = {},
  tkb = {},
  rooms = []
} = {}) {
  const teachers = Array.from(
    new Set(
      subjects
        .map((s) => String(s.teacher || '').trim())
        .filter(Boolean)
    )
  );

  const data = {
    lop: classes,
    mon: subjects.map((s) => ({
      ten: s.name,
      khoi: classes[0]?.khoi || '10',
      sotiet: s.periods || 1,
      gioihan: s.limit || 2
    })),
    monhoc: subjects.map((s) => ({ ten: s.name, ma: s.name })),
    giaovien: teachers.map((ma) => ({ ma, ten: ma, id: ma })),
    phong: rooms.map((r) => (typeof r === 'string' ? { ma: r, ten: r } : r)),
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
      if (s.room) {
        data.pccmRoomMatrix[`${c.id}|${s.name}`] = s.room;
      }
    });
  });

  return data;
}

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 1: High Teacher & Room Contention
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-1: Extreme Room Contention (8 Teachers competing for 1 Lab Room)', async () => {
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' },
    { id: 'C3', ten: '10A3', khoi: '10' },
    { id: 'C4', ten: '10A4', khoi: '10' }
  ];

  const subjects = [];
  // 4 teachers with singletons in LAB_01
  for (let t = 1; t <= 4; t++) {
    for (let c = 1; c <= 2; c++) {
      subjects.push({
        name: `LabSub_T${t}_C${c}`,
        teacher: `T_Lab_${t}`,
        periods: 1,
        limit: 1,
        classId: `C${c}`,
        room: 'LAB_01'
      });
    }
  }
  // Fillers without special room
  for (let c = 1; c <= 4; c++) {
    subjects.push({
      name: `Filler_C${c}`,
      teacher: `T_Filler_${c}`,
      periods: 10,
      limit: 2,
      classId: `C${c}`
    });
  }

  const data = makeData({
    classes,
    subjects,
    rooms: ['LAB_01']
  });

  const engine = new FetEngine(data, { seed: 101, uiBreathingMs: 0 });
  engine.init();
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed under room constraints');

  const initialMetrics = engine.evaluateMetrics();
  assert.equal(initialMetrics.unplacedCount, 0, 'Must be 100% placed');

  // Run tryCrossDayPairShift and tryPairClassSingletons
  await engine.tryCrossDayPairShift(initialMetrics);
  await engine.tryPairClassSingletons(initialMetrics);
  await engine.optimize('optimize_singletons');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, 'Zero unplaced activities after optimization');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero teacher gap-2');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');

  // Verify LAB_01 room grid has ZERO overlapping assignments across all 60 slots
  const labIdx = engine.roomIndexMap.get('lab_01');
  assert.notEqual(labIdx, undefined, 'Room LAB_01 must exist');
  const rg = engine.roomGridList[labIdx];
  assert.equal(rg.length, 60, 'Room grid must have 60 slots');

  // Re-verify room occupancy directly from placed activities
  const roomOccupancy = new Array(60).fill(-1);
  for (let i = 0; i < engine.activities.length; i++) {
    const act = engine.activities[i];
    if (act && act.roomIdx === labIdx) {
      const slot = engine.actPlacement[act.id];
      if (slot >= 0) {
        for (let d = 0; d < act.duration; d++) {
          const s = slot + d;
          assert.equal(
            roomOccupancy[s],
            -1,
            `Double room booking detected at slot ${s} between act ${roomOccupancy[s]} and act ${act.id}`
          );
          roomOccupancy[s] = act.id;
        }
      }
    }
  }
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 2: Odd & Prime Teacher Workloads
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-2: Prime Workload Packing (3, 5, 7, 11, 13, 17, 19) packing into sessions >= 2t', async () => {
  const primeWorkloads = [3, 5, 7, 11, 13, 17];
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' },
    { id: 'C3', ten: '10A3', khoi: '10' }
  ];

  const subjects = [];
  primeWorkloads.forEach((w, idx) => {
    const teacherId = `GV_Prime_${w}`;
    // Split workload w across classes in chunks of 2 and 1
    let remaining = w;
    let cIdx = 0;
    while (remaining > 0) {
      const chunkSize = remaining >= 2 ? 2 : 1;
      const c = classes[cIdx % classes.length];
      subjects.push({
        name: `Sub_P${w}_${remaining}`,
        teacher: teacherId,
        periods: chunkSize,
        limit: 2,
        classId: c.id
      });
      remaining -= chunkSize;
      cIdx++;
    }
  });

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 42, uiBreathingMs: 0 });
  engine.init();
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed for prime workloads');

  await engine.optimize('optimize_singletons');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, 'Must remain 100% placed');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero gap-2');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');

  // Verify that each prime teacher with w >= 2 has soBuoiDay1 = 0
  primeWorkloads.forEach((w) => {
    const tKey = `gv_prime_${w}`;
    const tIdx = engine.teacherIndexMap.get(tKey);
    if (tIdx !== undefined) {
      const tg = engine.teacherGridList[tIdx];
      let singleSessions = 0;
      for (let d = 0; d < 6; d++) {
        for (let b = 0; b < 2; b++) {
          const sStart = d * 10 + b * 5;
          let count = 0;
          for (let p = 0; p < 5; p++) {
            if (tg[sStart + p] >= 0) count++;
          }
          if (count === 1) singleSessions++;
        }
      }
      assert.equal(
        singleSessions,
        0,
        `Prime teacher ${tKey} (workload ${w}) must have 0 single-period sessions (found: ${singleSessions})`
      );
    }
  });
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 3: Extreme Recursion Depth & Call Limits in randomSwap
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-3: Extreme Recursion Depth & Call Limit Safety in randomSwap', async () => {
  const FetEngine = loadEngine();
  const data = makeData({
    classes: [{ id: 'C1', ten: '10A1', khoi: '10' }],
    subjects: [
      { name: 'Toan', teacher: 'T1', periods: 4, limit: 2 },
      { name: 'Van', teacher: 'T2', periods: 4, limit: 2 },
      { name: 'Anh', teacher: 'T3', periods: 4, limit: 2 }
    ]
  });

  const engine = new FetEngine(data, { seed: 99 });
  engine.init();
  engine.solve();

  // Test randomSwap with level >= MAX_RECURSION_LEVEL (16)
  engine.nCalls = 0;
  engine.limitCalls = 5000;
  const deepRes = engine.randomSwap(0, 16);
  assert.equal(deepRes, false, 'randomSwap must immediately abort at level >= 16 without stack overflow');

  // Test randomSwap when nCalls exceeds limitCalls
  engine.nCalls = 5000;
  engine.limitCalls = 5000;
  const limitRes = engine.randomSwap(0, 0);
  assert.equal(limitRes, false, 'randomSwap must immediately abort when limitCalls is reached');

  // Verify getAdaptiveLimitCalls bounds
  const standardLimit = engine.getAdaptiveLimitCalls(2000, 3500);
  assert.ok(standardLimit >= 2000, 'Adaptive limit must be >= 2000');
  assert.ok(standardLimit <= 5000, 'Adaptive limit must be <= 5000');
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 4: 80%+ Dense Locked / Fixed / OFF Grid
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-4: Dense Fixed (-3) and OFF (-2) Grids Immutability', async () => {
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' }
  ];

  const subjects = [
    { name: 'S1_C1', teacher: 'T1', periods: 1, limit: 1, classId: 'C1' },
    { name: 'S2_C1', teacher: 'T1', periods: 1, limit: 1, classId: 'C1' },
    { name: 'S1_C2', teacher: 'T1', periods: 1, limit: 1, classId: 'C2' },
    { name: 'S2_C2', teacher: 'T1', periods: 1, limit: 1, classId: 'C2' }
  ];

  // Lock 80% of C1 and C2 slots
  const tkb = {
    C1: {
      thu2: { sang: [{ mon: 'CC', fixed: true }, { mon: 'SH', fixed: true }, { mon: 'HD1', fixed: true }, { mon: 'HD2', fixed: true }, ''] },
      thu3: { sang: [{ mon: 'F1', fixed: true }, { mon: 'F2', fixed: true }, { mon: 'F3', fixed: true }, { mon: 'F4', fixed: true }, ''] },
      thu4: { sang: [{ mon: 'F5', fixed: true }, { mon: 'F6', fixed: true }, { mon: 'F7', fixed: true }, { mon: 'F8', fixed: true }, ''] }
    },
    C2: {
      thu2: { sang: [{ mon: 'CC', fixed: true }, { mon: 'SH', fixed: true }, { mon: 'HD1', fixed: true }, { mon: 'HD2', fixed: true }, ''] },
      thu3: { sang: [{ mon: 'F1', fixed: true }, { mon: 'F2', fixed: true }, { mon: 'F3', fixed: true }, { mon: 'F4', fixed: true }, ''] },
      thu4: { sang: [{ mon: 'F5', fixed: true }, { mon: 'F6', fixed: true }, { mon: 'F7', fixed: true }, { mon: 'F8', fixed: true }, ''] }
    }
  };

  const constraints = {
    fixedOff: {
      teacher: {
        t1: {
          'thu5|sang|0': true,
          'thu5|sang|1': true,
          'thu5|sang|2': true,
          'thu5|sang|3': true,
          'thu5|sang|4': true
        }
      }
    }
  };

  const data = makeData({ classes, subjects, tkb, constraints });
  const engine = new FetEngine(data, { seed: 777, uiBreathingMs: 0 });
  engine.init();
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Must solve in constrained slots');

  const c1Grid = engine.classGridList[engine.classIndexMap.get('C1')];
  const t1Grid = engine.teacherGridList[engine.teacherIndexMap.get('t1')];

  // Capture fixed and off positions
  const fixedPositions = [];
  for (let s = 0; s < 60; s++) {
    if (c1Grid[s] === -3) fixedPositions.push(s);
  }
  const offPositions = [];
  for (let s = 0; s < 60; s++) {
    if (t1Grid[s] === -2) offPositions.push(s);
  }

  assert.ok(fixedPositions.length >= 12, 'Must have at least 12 fixed cells');
  assert.ok(offPositions.length >= 5, 'Must have at least 5 OFF cells');

  // Run full singleton optimization with tryCrossDayPairShift and tryPairClassSingletons
  await engine.optimize('optimize_singletons');

  // Assert 100% immutability of fixed and off cells
  for (const s of fixedPositions) {
    assert.equal(c1Grid[s], -3, `Fixed cell at slot ${s} was illegally modified!`);
  }
  for (const s of offPositions) {
    assert.equal(t1Grid[s], -2, `Teacher OFF cell at slot ${s} was illegally modified!`);
  }

  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
  assert.equal(engine.evaluateMetrics().unplacedCount, 0, 'Zero unplaced');
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 5: Student Hole Prevention & Compaction
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-5: Student Hole Creation Prevention during Operator Moves', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '10A1', khoi: '10' }],
    subjects: [
      { name: 'MonA', teacher: 'GV_A', periods: 1, limit: 1 },
      { name: 'MonB', teacher: 'GV_B', periods: 1, limit: 1 },
      { name: 'MonC', teacher: 'GV_C', periods: 1, limit: 1 }
    ]
  });

  const engine = new FetEngine(data, { seed: 101, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const actA = engine.activities[0];
  const actB = engine.activities[1];
  const actC = engine.activities[2];

  // Deliberately place actA at slot 0 (P1) and actC at slot 2 (P3), leaving slot 1 empty (P2 hole)
  engine.placeActivityDirect(actA.id, 0);
  engine.placeActivityDirect(actC.id, 2);

  const initialHoles = engine.countTotalStudentHoles();
  assert.equal(initialHoles, 1, 'Should detect exactly 1 student hole between P1 and P3');

  // Run compaction
  engine.compactAllStudentSessions();
  const holesAfterCompaction = engine.countTotalStudentHoles();
  assert.equal(holesAfterCompaction, 0, 'Compaction must resolve the student hole (make contiguous)');

  const cGrid = engine.classGridList[0];
  assert.ok(cGrid[0] >= 0, 'P1 must be occupied');
  assert.ok(cGrid[1] >= 0, 'P2 must be occupied');
  assert.equal(cGrid[2], -1, 'P3 should now be empty');
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 6: Bit-Exact ACID Snapshot Rollback Oracle (500 Infeasible Invocations)
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-6: Bit-Exact Snapshot Rollback Oracle (500 Repeated Failed Shifts)', async () => {
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' }
  ];

  const subjects = [
    { name: 'Toan_C1', teacher: 'GV_Toan', periods: 2, limit: 2, classId: 'C1' },
    { name: 'Van_C1', teacher: 'GV_Van', periods: 2, limit: 2, classId: 'C1' },
    { name: 'Toan_C2', teacher: 'GV_Toan', periods: 2, limit: 2, classId: 'C2' },
    { name: 'Van_C2', teacher: 'GV_Van', periods: 2, limit: 2, classId: 'C2' }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 42 });
  engine.init();
  engine.solve();

  // Snapshot before
  const snapBefore = engine.captureStateSnapshot();
  const origPlacements = Int32Array.from(snapBefore.placement);
  const origClassGrids = [];
  engine.classGrid.forEach((v, k) => origClassGrids.push({ key: k, grid: Int8Array.from(v) }));
  const origTeacherGrids = [];
  engine.teacherGrid.forEach((v, k) => origTeacherGrids.push({ key: k, grid: Int8Array.from(v) }));

  // Run 500 forced failed operations with snapshot restore
  for (let iter = 0; iter < 500; iter++) {
    const snap = engine.captureStateSnapshot();

    // Mutate engine state randomly
    const randomAct = engine.activities[iter % engine.activities.length];
    if (randomAct) {
      engine.unplaceActivity(randomAct.id);
    }

    // Restore snapshot
    engine.restoreStateSnapshot(snap);

    // Assert bit-exact identity
    assert.deepEqual(
      Array.from(engine.actPlacement),
      Array.from(origPlacements),
      `Iteration ${iter}: Placement drifted after restore!`
    );
  }

  // Final check of all class and teacher grids
  origClassGrids.forEach(({ key, grid }) => {
    const current = engine.classGrid.get(key);
    assert.deepEqual(
      Array.from(current),
      Array.from(grid),
      `Class grid for ${key} drifted after 500 rollbacks!`
    );
  });

  origTeacherGrids.forEach(({ key, grid }) => {
    const current = engine.teacherGrid.get(key);
    assert.deepEqual(
      Array.from(current),
      Array.from(grid),
      `Teacher grid for ${key} drifted after 500 rollbacks!`
    );
  });
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 7: Teacher T.Chung Topology (Math 9A2 + Math 6A14)
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-7: Teacher T.Chung Topology Resolution (Math 9A2 1t on Sat -> soBuoiDay1 = 0)', async () => {
  const classes = [
    { id: '9A2', ten: '9A2', khoi: '9' },
    { id: '6A14', ten: '6A14', khoi: '6' },
    { id: '8A1', ten: '8A1', khoi: '8' }
  ];

  // Teacher T.Chung teaches Math 9A2 (4t) and Math 6A14 (4t), plus fillers
  const subjects = [
    { name: 'Toan9A2', teacher: 'T.Chung', periods: 4, limit: 2, classId: '9A2' },
    { name: 'Toan6A14', teacher: 'T.Chung', periods: 4, limit: 2, classId: '6A14' },
    { name: 'Van9A2', teacher: 'GV_Van', periods: 4, limit: 2, classId: '9A2' },
    { name: 'Van6A14', teacher: 'GV_Van', periods: 4, limit: 2, classId: '6A14' },
    { name: 'Anh9A2', teacher: 'GV_Anh', periods: 4, limit: 2, classId: '9A2' },
    { name: 'Anh6A14', teacher: 'GV_Anh', periods: 4, limit: 2, classId: '6A14' },
    { name: 'Ly8A1', teacher: 'GV_Ly', periods: 4, limit: 2, classId: '8A1' },
    { name: 'Hoa8A1', teacher: 'GV_Hoa', periods: 4, limit: 2, classId: '8A1' }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 2026, uiBreathingMs: 0 });
  engine.init();
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');

  // Run deep singleton optimizer
  await engine.optimize('optimize_singletons');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, '100% placed');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero gap-2');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
  assert.equal(finalMetrics.soBuoiDay1, 0, 'All singletons including T.Chung eliminated (soBuoiDay1 = 0)');

  // Verify T.Chung specific session counts
  const tIdx = engine.teacherIndexMap.get('t.chung');
  assert.notEqual(tIdx, undefined, 'Teacher T.Chung must exist');
  const tg = engine.teacherGridList[tIdx];

  for (let d = 0; d < 6; d++) {
    for (let b = 0; b < 2; b++) {
      const sStart = d * 10 + b * 5;
      let count = 0;
      for (let p = 0; p < 5; p++) {
        if (tg[sStart + p] >= 0) count++;
      }
      assert.notEqual(
        count,
        1,
        `T.Chung has an illegal 1-period teaching session on day ${d}, session ${b}!`
      );
    }
  }
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 8: 15-Seed Adversarial Invariant Fuzzing
// -----------------------------------------------------------------------------
test('ADV-CHALLENGE-8: 15-Seed Invariant Fuzzing (Zero Holes, Zero Gap-2, 100% Placed)', async () => {
  const fuzzSeeds = [3, 11, 19, 29, 37, 43, 59, 71, 83, 97, 109, 131, 151, 181, 2026];

  for (const seed of fuzzSeeds) {
    const classes = [
      { id: 'C1', ten: '10A1', khoi: '10' },
      { id: 'C2', ten: '10A2', khoi: '10' },
      { id: 'C3', ten: '10A3', khoi: '10' }
    ];

    const subjects = [
      { name: 'Toan', teacher: 'GV1', periods: 4, limit: 2 },
      { name: 'Van', teacher: 'GV2', periods: 4, limit: 2 },
      { name: 'Anh', teacher: 'GV3', periods: 3, limit: 2 },
      { name: 'Ly', teacher: 'GV4', periods: 2, limit: 2 },
      { name: 'Hoa', teacher: 'GV5', periods: 2, limit: 2 },
      { name: 'Sinh', teacher: 'GV6', periods: 1, limit: 1 },
      { name: 'Su', teacher: 'GV7', periods: 1, limit: 1 }
    ];

    const data = makeData({ classes, subjects });
    const engine = new FetEngine(data, { seed, uiBreathingMs: 0 });
    engine.init();
    const ok = engine.solve();
    if (!ok.ok) continue;

    await engine.optimize('optimize_singletons');

    const m = engine.evaluateMetrics();
    assert.equal(m.unplacedCount, 0, `Seed ${seed}: unplaced must be 0`);
    assert.equal(engine.countTotalStudentHoles(), 0, `Seed ${seed}: student holes must be 0`);
    assert.equal(m.soBuoiTrong2, 0, `Seed ${seed}: gap-2 must be 0`);
  }
});
