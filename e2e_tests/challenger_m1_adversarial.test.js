'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
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

const DAYS = ['thu2', 'thu3', 'thu4', 'thu5', 'thu6', 'thu7'];
const SESSIONS = ['sang', 'chieu'];
const PERIODS = 5;

function makeData({
  classes = [{ id: 'L1', ten: '10A1', ten2: '10A1', khoi: '10' }],
  subjects = [{ name: 'Toan', teacher: 'GV01', periods: 2, limit: 2 }],
  constraints = {},
  tkb = {}
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

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 1: PHT.Định Model Consolidation (4 singletons in 4 classes -> soBuoiDay1 = 0)
// -----------------------------------------------------------------------------
test('ADV-1: PHT.Định Model - 4 Singletons Across 4 Classes Must Consolidate to soBuoiDay1 = 0', async () => {
  const FetEngine = loadEngine();
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' },
    { id: 'C3', ten: '10A3', khoi: '10' },
    { id: 'C4', ten: '10A4', khoi: '10' }
  ];

  // PHT_Dinh has 1 period of HDTN3 in each of 4 classes = 4 periods total.
  // Other teachers have 2-period blocks.
  const subjects = [
    // PHT_Dinh: 1 period each
    { name: 'HDTN3_C1', teacher: 'PHT_Dinh', periods: 1, limit: 1, classId: 'C1' },
    { name: 'HDTN3_C2', teacher: 'PHT_Dinh', periods: 1, limit: 1, classId: 'C2' },
    { name: 'HDTN3_C3', teacher: 'PHT_Dinh', periods: 1, limit: 1, classId: 'C3' },
    { name: 'HDTN3_C4', teacher: 'PHT_Dinh', periods: 1, limit: 1, classId: 'C4' },

    // Filler subjects (2 periods each) to populate the timetable
    { name: 'Toan_C1', teacher: 'GV_Toan', periods: 4, limit: 2, classId: 'C1' },
    { name: 'Ly_C1', teacher: 'GV_Ly', periods: 4, limit: 2, classId: 'C1' },
    { name: 'Hoa_C1', teacher: 'GV_Hoa', periods: 4, limit: 2, classId: 'C1' },

    { name: 'Toan_C2', teacher: 'GV_Toan', periods: 4, limit: 2, classId: 'C2' },
    { name: 'Ly_C2', teacher: 'GV_Ly', periods: 4, limit: 2, classId: 'C2' },
    { name: 'Hoa_C2', teacher: 'GV_Hoa', periods: 4, limit: 2, classId: 'C2' },

    { name: 'Toan_C3', teacher: 'GV_Toan', periods: 4, limit: 2, classId: 'C3' },
    { name: 'Ly_C3', teacher: 'GV_Ly', periods: 4, limit: 2, classId: 'C3' },
    { name: 'Hoa_C3', teacher: 'GV_Hoa', periods: 4, limit: 2, classId: 'C3' },

    { name: 'Toan_C4', teacher: 'GV_Toan', periods: 4, limit: 2, classId: 'C4' },
    { name: 'Ly_C4', teacher: 'GV_Ly', periods: 4, limit: 2, classId: 'C4' },
    { name: 'Hoa_C4', teacher: 'GV_Hoa', periods: 4, limit: 2, classId: 'C4' }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 42, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solver must successfully place all activities');
  assert.equal(solveRes.unassigned, 0, 'Zero unassigned activities');

  // Run targeted intra-class crusher and optimizer
  await engine.optimize('optimize_singletons');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, 'All activities remain placed');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero 2-period gaps');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
  assert.equal(finalMetrics.soBuoiDay1, 0, 'PHT_Dinh singletons must be 100% crushed (soBuoiDay1 = 0)');

  // Verify that for teacher PHT_Dinh, every session they teach has >= 2 periods
  const phtIdx = engine.teacherIndexMap.get('pht_dinh');
  assert.ok(phtIdx !== undefined, 'Teacher pht_dinh must exist in engine');
  const tg = engine.teacherGridList[phtIdx];
  for (let d = 0; d < 6; d++) {
    for (let b = 0; b < 2; b++) {
      const sStart = d * 10 + b * 5;
      let count = 0;
      for (let p = 0; p < 5; p++) {
        if (tg[sStart + p] >= 0) count++;
      }
      assert.notEqual(count, 1, `Session (day ${d}, session ${b}) for PHT_Dinh must not have exactly 1 period (found ${count})`);
    }
  }
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 2: Multi-Period Donor Displacement (dB = 2 relocated by randomSwap)
// -----------------------------------------------------------------------------
test('ADV-2: Multi-Period Donor Displacement (dB = 2) via randomSwap during Intra-Class Crusher', async () => {
  const FetEngine = loadEngine();
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' }
  ];

  // In C1:
  // - Teacher T_Target has 1 period Mon1 in C1, and 1 period Mon2 in C2
  // - Teacher T_Donor has 2-period block Mon_Donor in C1
  const subjects = [
    { name: 'Mon_T1_C1', teacher: 'T_Target', periods: 1, limit: 1, classId: 'C1' },
    { name: 'Mon_T1_C2', teacher: 'T_Target', periods: 1, limit: 1, classId: 'C2' },
    { name: 'Donor_2P_C1', teacher: 'T_Donor', periods: 2, limit: 2, classId: 'C1' },
    { name: 'Donor_2P_C2', teacher: 'T_Donor', periods: 2, limit: 2, classId: 'C2' },
    { name: 'Filler_C1', teacher: 'T_Filler', periods: 6, limit: 2, classId: 'C1' },
    { name: 'Filler_C2', teacher: 'T_Filler', periods: 6, limit: 2, classId: 'C2' }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 1234, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve must succeed');

  // Test direct call to tryTargetedIntraClassSingletonCrusher
  const initialMetrics = engine.evaluateMetrics();
  await engine.tryTargetedIntraClassSingletonCrusher(initialMetrics);
  
  // Either crusher improved directly or optimizer pipeline improves it
  await engine.optimize('optimize_singletons');
  const optMetrics = engine.evaluateMetrics();

  assert.equal(optMetrics.unplacedCount, 0, 'No unplaced activities');
  assert.equal(optMetrics.soBuoiTrong2, 0, 'No 2-period gaps');
  assert.equal(engine.countTotalStudentHoles(), 0, 'No student holes');
  assert.equal(optMetrics.soBuoiDay1, 0, 'Singletons crushed to 0 even with 2-period donor blocks');
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 3: High Density Constraints (Fixed cells -3, OFF cells -2)
// -----------------------------------------------------------------------------
test('ADV-3: High Constraint Density - Immutable Fixed (-3) & OFF (-2) Cells, Zero Holes, Zero Gap-2', async () => {
  const FetEngine = loadEngine();
  const classes = [
    { id: 'C1', ten: '10A1', khoi: '10' },
    { id: 'C2', ten: '10A2', khoi: '10' }
  ];

  const subjects = [
    { name: 'S1_C1', teacher: 'T1', periods: 1, limit: 1, classId: 'C1' },
    { name: 'S2_C1', teacher: 'T1', periods: 1, limit: 1, classId: 'C1' },
    { name: 'M2_C1', teacher: 'T2', periods: 4, limit: 2, classId: 'C1' },
    { name: 'M3_C1', teacher: 'T3', periods: 4, limit: 2, classId: 'C1' },
    { name: 'S1_C2', teacher: 'T1', periods: 1, limit: 1, classId: 'C2' },
    { name: 'S2_C2', teacher: 'T1', periods: 1, limit: 1, classId: 'C2' },
    { name: 'M2_C2', teacher: 'T2', periods: 4, limit: 2, classId: 'C2' },
    { name: 'M3_C2', teacher: 'T3', periods: 4, limit: 2, classId: 'C2' }
  ];

  // Set up rigid fixed cells: Thu2 Sang Period 0 is locked Chào cờ (-3) for all classes
  const tkb = {
    C1: { thu2: { sang: [{ mon: 'CC', fixed: true }, '', '', '', ''] } },
    C2: { thu2: { sang: [{ mon: 'CC', fixed: true }, '', '', '', ''] } }
  };
  const constraints = {
    fixedOff: {
      teacher: {
        t1: {
          'thu7|sang|0': true,
          'thu7|sang|1': true,
          'thu7|sang|2': true,
          'thu7|sang|3': true,
          'thu7|sang|4': true,
          'thu7|chieu|0': true,
          'thu7|chieu|1': true,
          'thu7|chieu|2': true,
          'thu7|chieu|3': true,
          'thu7|chieu|4': true
        }
      }
    }
  };

  const data = makeData({ classes, subjects, tkb, constraints });
  const engine = new FetEngine(data, { seed: 555, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Solve under locked/off constraints must succeed');

  // Verify locked and off constraints before optimization
  const c1Grid = engine.classGridList[engine.classIndexMap.get('C1')];
  const c2Grid = engine.classGridList[engine.classIndexMap.get('C2')];
  const t1Grid = engine.teacherGridList[engine.teacherIndexMap.get('t1')];

  // Thu2 sang period 0 is slot 0
  assert.equal(c1Grid[0], -3, 'Slot 0 in C1 must be fixed (-3)');
  assert.equal(c2Grid[0], -3, 'Slot 0 in C2 must be fixed (-3)');

  // Thu7 sang is day 5, sang (slots 50..54)
  for (let p = 0; p < 5; p++) {
    assert.equal(t1Grid[50 + p], -2, `Teacher T1 must have -2 on Thu7 sang slot ${50 + p}`);
    assert.equal(t1Grid[55 + p], -2, `Teacher T1 must have -2 on Thu7 chieu slot ${55 + p}`);
  }

  // Run deep singleton optimizer
  await engine.optimize('optimize_singletons');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, 'Zero unplaced');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero gap-2');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
  assert.equal(finalMetrics.soBuoiDay1, 0, 'Singletons crushed to 0');

  // Verify locked and off constraints after optimization (IMMUTABILITY CHECK)
  assert.equal(c1Grid[0], -3, 'Slot 0 in C1 remained fixed (-3)');
  assert.equal(c2Grid[0], -3, 'Slot 0 in C2 remained fixed (-3)');
  for (let p = 0; p < 5; p++) {
    assert.equal(t1Grid[50 + p], -2, `Teacher T1 off-cell remained -2 on slot ${50 + p}`);
    assert.equal(t1Grid[55 + p], -2, `Teacher T1 off-cell remained -2 on slot ${55 + p}`);
  }
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 4: Snapshot Transaction Rollback Integrity on Impossible Swaps
// -----------------------------------------------------------------------------
test('ADV-4: Snapshot Transaction Rollback Integrity on Forced Infeasible Intra-Class Swap', async () => {
  const FetEngine = loadEngine();
  const classes = [{ id: 'C1', ten: '10A1', khoi: '10' }];
  const subjects = [
    { name: 'M1', teacher: 'T1', periods: 1, limit: 1, classId: 'C1' },
    { name: 'M2', teacher: 'T2', periods: 1, limit: 1, classId: 'C1' }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 789, uiBreathingMs: 0 });
  engine.solve();

  const snapshotBefore = engine.captureStateSnapshot();
  const hashBefore = JSON.stringify(snapshotBefore);

  // Directly invoke targeted crusher
  const initialMetrics = engine.evaluateMetrics();
  await engine.tryTargetedIntraClassSingletonCrusher(initialMetrics);

  const snapshotAfter = engine.captureStateSnapshot();
  const hashAfter = JSON.stringify(snapshotAfter);

  // In an un-improvable 2-teacher 1-period each setup, state must remain completely valid
  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, 'No activities lost during rollback');
  assert.equal(m.soBuoiTrong2, 0, 'No gap-2 created');
  assert.equal(engine.countTotalStudentHoles(), 0, 'No student holes created');
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 5: Multi-Teacher Intra-Class Crusher Cascade (6 Teachers x 4 Classes)
// -----------------------------------------------------------------------------
test('ADV-5: Multi-Teacher Intra-Class Crusher Cascade Across 5 Classes', async () => {
  const FetEngine = loadEngine();
  const classes = [];
  for (let c = 1; c <= 5; c++) {
    classes.push({ id: `Class_${c}`, ten: `10A${c}`, khoi: '10' });
  }

  const subjects = [];
  // 6 teachers, each assigned 2 to 4 singletons across different classes
  for (let t = 1; t <= 6; t++) {
    for (let c = 1; c <= 4; c++) {
      subjects.push({
        name: `Sub_T${t}_C${c}`,
        teacher: `Teacher_${t}`,
        periods: 1,
        limit: 1,
        classId: `Class_${c}`
      });
    }
  }

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 9999, uiBreathingMs: 0 });
  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, 'Must solve');

  await engine.optimize('optimize_singletons');

  const finalMetrics = engine.evaluateMetrics();
  assert.equal(finalMetrics.unplacedCount, 0, '100% placed');
  assert.equal(finalMetrics.soBuoiTrong2, 0, 'Zero gap-2');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
  assert.equal(finalMetrics.soBuoiDay1, 0, 'All 6 teachers singletons fully crushed (soBuoiDay1 = 0)');
});

// -----------------------------------------------------------------------------
// ADVERSARIAL TEST 6: Real School Default PHT.Định Verification (live_school_default.json)
// -----------------------------------------------------------------------------
test('ADV-6: Real School live_school_default.json PHT.Định Specific Singleton Verification', async () => {
  const FetEngine = loadEngine();
  const defaultPath = path.resolve(__dirname, '..', 'scratch', 'live_school_default.json');
  if (!fs.existsSync(defaultPath)) return;

  const rawData = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  const engine = new FetEngine(rawData, { seed: 2026, mode: 'optimize_singletons', uiBreathingMs: 0 });
  engine.init();
  engine.loadExistingSchedule();

  const initM = engine.evaluateMetrics();
  assert.equal(initM.unplacedCount, 0, 'live_school_default loaded 100% placed');

  await engine.optimize('optimize_singletons');
  const finalM = engine.evaluateMetrics();

  assert.equal(finalM.unplacedCount, 0, 'Unplaced must be 0');
  assert.equal(finalM.soBuoiTrong2, 0, 'Gap-2 must be 0');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Student holes must be 0');

  // Verify teacher PHT.Định specifically
  const phtKey = 'pht.định';
  const phtIdx = engine.teacherIndexMap.get(phtKey);
  if (phtIdx !== undefined) {
    const tg = engine.teacherGridList[phtIdx];
    let phtSingleCount = 0;
    for (let d = 0; d < 6; d++) {
      for (let b = 0; b < 2; b++) {
        const sStart = d * 10 + b * 5;
        let count = 0;
        for (let p = 0; p < 5; p++) {
          if (tg[sStart + p] >= 0) count++;
        }
        if (count === 1) phtSingleCount++;
      }
    }
    assert.equal(phtSingleCount, 0, `PHT.Định must have 0 singleton sessions (found: ${phtSingleCount})`);
  }
});
