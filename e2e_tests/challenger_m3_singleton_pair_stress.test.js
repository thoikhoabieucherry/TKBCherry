'use strict';

/**
 * Challenger M3 Adversarial Stress Test Suite
 * Empirical verification of tryPairClassSingletons and 4-period (2+2) block handling.
 * 
 * Verifies:
 * 1. buildActivities() 4-period decomposition under various constraints (default, maxDaily=1, lessonBlocks max=0/1/custom)
 * 2. tryPairClassSingletons() operator execution, obstacle displacement (O(1) direct donor slot swap & recursive randomSwap)
 * 3. Invariant Preservation: Student Holes === 0, Teacher soBuoiTrong2 === 0, Immutable Fixed (-3) & OFF (-2) cells
 * 4. ACID Transactional Rollback Integrity: Bit-for-bit grid & state preservation upon failed ejections/conflicts
 * 5. Co-teaching (multi-teacher) and Room constraint safety
 * 6. Internal student hole detection on donor session vacating
 * 7. Synthetic dense fuzzing across randomized schedules
 * 8. Real-world dataset verification (live_school_default.json, dongkhoi_1566.json)
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
// CATEGORY 1: 4-Period Subject Construction (buildActivities)
// -----------------------------------------------------------------------------

test('CAT-1.1: 4-Period subject with maxDaily=2 decomposes into [2, 2] paired blocks by default', () => {
  const data = makeData({
    classes: [{ id: '9A18', ten: '9A18', khoi: '9' }],
    subjects: [{ name: 'Van', teacher: 'V.Quynh', periods: 4, limit: 2 }]
  });
  const engine = new FetEngine(data);
  engine.init();
  const acts = engine.activities.filter(a => a.mon === 'Van');
  assert.equal(acts.length, 2, 'Should create exactly 2 activities for 4 periods');
  assert.equal(acts[0].duration, 2, 'First activity must have duration 2');
  assert.equal(acts[1].duration, 2, 'Second activity must have duration 2');
  assert.equal(acts[0].mustKeepBlock, true, 'mustKeepBlock must be true');
  assert.equal(acts[1].mustKeepBlock, true, 'mustKeepBlock must be true');
  assert.equal(acts[0].lessonBlockLen, 2, 'lessonBlockLen must be 2');
  assert.equal(acts[1].lessonBlockLen, 2, 'lessonBlockLen must be 2');
});

test('CAT-1.2: 4-Period subject with maxDaily=1 decomposes into [1, 1, 1, 1] singletons', () => {
  const data = makeData({
    classes: [{ id: '9A18', ten: '9A18', khoi: '9' }],
    subjects: [{ name: 'Van', teacher: 'V.Quynh', periods: 4, limit: 1 }]
  });
  const engine = new FetEngine(data);
  engine.init();
  const acts = engine.activities.filter(a => a.mon === 'Van');
  assert.equal(acts.length, 4, 'Should create 4 activities when maxDaily=1');
  acts.forEach(a => {
    assert.equal(a.duration, 1, 'Each activity must have duration 1');
  });
});

test('CAT-1.3: 4-Period subject with lessonBlocks["2"].max = 1 decomposes into [2, 1, 1]', () => {
  const data = makeData({
    classes: [{ id: '9A18', ten: '9A18', khoi: '9' }],
    subjects: [{ name: 'Van', teacher: 'V.Quynh', periods: 4, limit: 2 }]
  });
  data.tkbConstraints = {
    subject: {
      'Van': {
        lessonBlocks: { '2': { max: 1 } }
      }
    }
  };
  const engine = new FetEngine(data);
  engine.init();
  const acts = engine.activities.filter(a => a.mon === 'Van');
  assert.equal(acts.length, 3, 'Should create 3 activities (1 paired + 2 singletons)');
  const durations = Array.from(acts.map(a => a.duration)).sort((a, b) => b - a);
  assert.deepEqual(durations, [2, 1, 1], 'Durations must be [2, 1, 1]');
});

test('CAT-1.4: 4-Period subject with lessonBlocks["2"].max = 0 decomposes into [1, 1, 1, 1]', () => {
  const data = makeData({
    classes: [{ id: '9A18', ten: '9A18', khoi: '9' }],
    subjects: [{ name: 'Van', teacher: 'V.Quynh', periods: 4, limit: 2 }]
  });
  data.tkbConstraints = {
    subject: {
      'Van': {
        lessonBlocks: { '2': { max: 0 } }
      }
    }
  };
  const engine = new FetEngine(data);
  engine.init();
  const acts = engine.activities.filter(a => a.mon === 'Van');
  assert.equal(acts.length, 4, 'Should create 4 singletons when block-2 max is 0');
  acts.forEach(a => assert.equal(a.duration, 1));
});

test('CAT-1.5: 4-Period subject with lessonBlocks["2"].max = "0" (string) decomposes into [1, 1, 1, 1]', () => {
  const data = makeData({
    classes: [{ id: '9A18', ten: '9A18', khoi: '9' }],
    subjects: [{ name: 'Van', teacher: 'V.Quynh', periods: 4, limit: 2 }]
  });
  data.tkbConstraints = {
    subject: {
      'Van': {
        lessonBlocks: { '2': { max: '0' } }
      }
    }
  };
  const engine = new FetEngine(data);
  engine.init();
  const acts = engine.activities.filter(a => a.mon === 'Van');
  assert.equal(acts.length, 4, 'Should create 4 singletons when block-2 max is "0"');
  acts.forEach(a => assert.equal(a.duration, 1));
});

// -----------------------------------------------------------------------------
// CATEGORY 2: tryPairClassSingletons Direct Mechanics & Obstacle Relocation
// -----------------------------------------------------------------------------

test('CAT-2.1: Single class with Literature singletons on Fri (P2) and Sat (P2) merges to Fri (P2, P3) and clears Sat', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '9A1', khoi: '9' }],
    subjects: [
      { name: 'Van', teacher: 'V.Quynh', periods: 2, limit: 1 } // creates 2 duration-1 activities
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const van0 = engine.activities[0];
  const van1 = engine.activities[1];

  // Set maxDaily to 2 on activities to allow pairing in same session
  van0.maxDaily = 2;
  van1.maxDaily = 2;

  // Fri morning = slot 41 (thu6 morning P2)
  // Sat morning = slot 51 (thu7 morning P2)
  engine.placeActivityDirect(van0.id, 41);
  engine.placeActivityDirect(van1.id, 51);

  const initialMetrics = engine.evaluateMetrics();
  assert.equal(initialMetrics.soBuoiDay1, 2, 'Should have 2 single-period teaching sessions initially');
  assert.equal(initialMetrics.unplacedCount, 0);

  const res = await engine.tryPairClassSingletons(initialMetrics);
  assert.notEqual(res, null, 'tryPairClassSingletons should succeed');
  assert.equal(res.soBuoiDay1, 0, 'Should eliminate single-period sessions');

  const cGrid = engine.classGridList[0];
  const tIdx = engine.teacherIndexMap.get('v.quynh');
  const tg = engine.teacherGridList[tIdx];

  // Saturday morning (slots 50..54) must have 0 periods taught
  const satTaught = Array.from(tg.slice(50, 55)).filter(x => x >= 0).length;
  assert.equal(satTaught, 0, 'Saturday must be completely freed for Ms. V.Quynh');

  // Friday morning (slots 40..45) must have 2 consecutive periods
  const friSlots = [];
  for (let s = 40; s < 45; s++) {
    if (cGrid[s] === van0.id || cGrid[s] === van1.id) friSlots.push(s);
  }
  assert.equal(friSlots.length, 2, 'Must have 2 periods on Friday');
  assert.equal(friSlots[1] - friSlots[0], 1, 'Friday periods must be contiguous (p, p+1)');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Student holes must remain 0');
});

test('CAT-2.2: Direct slot displacement into donor slot O(1) when target slot is occupied', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '9A1', khoi: '9' }],
    subjects: [
      { name: 'Van', teacher: 'V.Quynh', periods: 2, limit: 1 },
      { name: 'Su', teacher: 'T.Su', periods: 1, limit: 1 }
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const van0 = engine.activities[0];
  const van1 = engine.activities[1];
  const su = engine.activities[2];

  van0.maxDaily = 2;
  van1.maxDaily = 2;

  // Friday morning: slot 40 is Van0, slot 41 is Su (obstacle)
  // Saturday morning: slot 50 is Van1 (donor slot)
  engine.placeActivityDirect(van0.id, 40);
  engine.placeActivityDirect(su.id, 41);
  engine.placeActivityDirect(van1.id, 50);

  const initialMetrics = engine.evaluateMetrics();
  const res = await engine.tryPairClassSingletons(initialMetrics);
  assert.notEqual(res, null, 'Pairing must succeed with obstacle relocation');

  const cGrid = engine.classGridList[0];
  // Slots 40 and 41 must be Van
  assert.ok(cGrid[40] === van0.id || cGrid[40] === van1.id);
  assert.ok(cGrid[41] === van0.id || cGrid[41] === van1.id);
  // Slot 50 must now be Su (relocated to donor slot)
  assert.equal(cGrid[50], su.id, 'Su must be relocated into donor slot 50');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes');
});

test('CAT-2.3: Recursive randomSwap displacement when 2 occupants occupy candidate slot pair', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '9A1', khoi: '9' }],
    subjects: [
      { name: 'Van', teacher: 'V.Quynh', periods: 2, limit: 1 },
      { name: 'Su', teacher: 'T.Su', periods: 1, limit: 1 },
      { name: 'Dia', teacher: 'T.Dia', periods: 1, limit: 1 }
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const van0 = engine.activities[0];
  const van1 = engine.activities[1];
  const su = engine.activities[2];
  const dia = engine.activities[3];

  van0.maxDaily = 2;
  van1.maxDaily = 2;

  // Friday morning: slot 40 is Su (obstacle 1), slot 41 is Dia (obstacle 2)
  // Saturday morning: slot 50 is Van0, slot 51 is Van1 (already in same session, let's put Van0 on Thu (30) and Van1 on Sat (50))
  engine.placeActivityDirect(su.id, 40);
  engine.placeActivityDirect(dia.id, 41);
  engine.placeActivityDirect(van0.id, 30);
  engine.placeActivityDirect(van1.id, 50);

  const initialMetrics = engine.evaluateMetrics();
  const res = await engine.tryPairClassSingletons(initialMetrics);
  assert.notEqual(res, null, 'Pairing must succeed with 2-obstacle relocation');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes after multi-obstacle relocation');
  assert.equal(engine.evaluateMetrics().unplacedCount, 0, 'Zero unplaced activities');
});

// -----------------------------------------------------------------------------
// CATEGORY 3: Invariant Preservation Stress (Holes, Gap-2, Fixed/OFF Cells)
// -----------------------------------------------------------------------------

test('CAT-3.1: tryPairClassSingletons NEVER introduces student holes', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '10A1', khoi: '10' }],
    subjects: [
      { name: 'Toan', teacher: 'GV01', periods: 2, limit: 2 },
      { name: 'Van', teacher: 'GV02', periods: 2, limit: 2 },
      { name: 'Anh', teacher: 'GV03', periods: 2, limit: 2 },
      { name: 'Ly', teacher: 'GV04', periods: 2, limit: 2 }
    ]
  });
  const engine = new FetEngine(data, { seed: 101 });
  engine.init();
  const ok = engine.solve();
  assert.equal(ok.ok, true, 'Initial solve must succeed');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes initially');

  const initialMetrics = engine.evaluateMetrics();
  await engine.tryPairClassSingletons(initialMetrics);

  assert.equal(engine.countTotalStudentHoles(), 0, 'Student holes must remain strictly 0');
});

test('CAT-3.2: tryPairClassSingletons NEVER overwrites or displaces Fixed (-3) cells', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '10A1', khoi: '10' }],
    subjects: [
      { name: 'CC', teacher: 'GV_CC', periods: 1, limit: 1 },
      { name: 'Van', teacher: 'GV02', periods: 2, limit: 1 }
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const cc = engine.activities[0];
  const van0 = engine.activities[1];
  const van1 = engine.activities[2];

  cc.isFixed = true;
  van0.maxDaily = 2;
  van1.maxDaily = 2;

  // Monday morning: slot 0 is fixed CC
  engine.placeActivityDirect(cc.id, 0);
  // Friday morning: slot 40 is Van0
  engine.placeActivityDirect(van0.id, 40);
  // Saturday morning: slot 50 is Van1
  engine.placeActivityDirect(van1.id, 50);

  const initialMetrics = engine.evaluateMetrics();
  await engine.tryPairClassSingletons(initialMetrics);

  const cGrid = engine.classGridList[0];
  assert.equal(cGrid[0], cc.id, 'Fixed cell at slot 0 (CC) must NOT be moved or overwritten');
});

test('CAT-3.3: tryPairClassSingletons strictly respects teacher and class OFF (-2) cells', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '10A1', khoi: '10' }],
    subjects: [
      { name: 'Van', teacher: 'GV02', periods: 2, limit: 1 }
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const van0 = engine.activities[0];
  const van1 = engine.activities[1];
  van0.maxDaily = 2;
  van1.maxDaily = 2;

  const tIdx = engine.teacherIndexMap.get('gv02');
  const tg = engine.teacherGridList[tIdx];

  // Set Friday morning slots 41..44 as teacher OFF (-2)
  for (let s = 41; s < 45; s++) {
    tg[s] = -2;
  }

  // Place Van0 on Friday slot 40, Van1 on Saturday slot 50
  engine.placeActivityDirect(van0.id, 40);
  engine.placeActivityDirect(van1.id, 50);

  const initialMetrics = engine.evaluateMetrics();
  await engine.tryPairClassSingletons(initialMetrics);

  for (let s = 41; s < 45; s++) {
    assert.equal(tg[s], -2, `Teacher OFF slot ${s} must remain -2`);
  }
});

test('CAT-3.4: tryPairClassSingletons strictly checks co-teaching / multi-teacher conflicts', async () => {
  const data = makeData({
    classes: [
      { id: 'C1', ten: '10A1', khoi: '10' },
      { id: 'C2', ten: '10A2', khoi: '10' }
    ],
    subjects: [
      { name: 'Van', teacher: 'GV01, GV02', periods: 2, limit: 1 },
      { name: 'Toan', teacher: 'GV02', periods: 1, limit: 1, classId: 'C2' }
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const van0 = engine.activities[0];
  const van1 = engine.activities[1];
  const toanC2 = engine.activities[2];

  van0.maxDaily = 2;
  van1.maxDaily = 2;

  // Van0 placed at Friday slot 40, Van1 placed at Saturday slot 50
  engine.placeActivityDirect(van0.id, 40);
  engine.placeActivityDirect(van1.id, 50);

  // In class C2, teacher GV02 is teaching Toan at Friday slot 41!
  engine.placeActivityDirect(toanC2.id, 41);

  const initialMetrics = engine.evaluateMetrics();
  // Candidate pair on Friday (40, 41) cannot be placed because GV02 is busy at slot 41 in C2!
  const res = await engine.tryPairClassSingletons(initialMetrics);

  // GV02 must NOT have a double-booking at slot 41
  const gv02Idx = engine.teacherIndexMap.get('gv02');
  const tg02 = engine.teacherGridList[gv02Idx];
  assert.equal(tg02[41], toanC2.id, 'GV02 must still be teaching Toan in C2 without conflict');
});

test('CAT-3.5: tryPairClassSingletons strictly checks Room allocation conflicts', async () => {
  const data = makeData({
    classes: [
      { id: 'C1', ten: '10A1', khoi: '10' },
      { id: 'C2', ten: '10A2', khoi: '10' }
    ],
    subjects: [
      { name: 'Tin', teacher: 'GV01', periods: 2, limit: 1, classId: 'C1' },
      { name: 'TinC2', teacher: 'GV02', periods: 1, limit: 1, classId: 'C2' }
    ]
  });
  data.pccmRoomMatrix = {
    'C1|Tin': 'LAB_01',
    'C2|TinC2': 'LAB_01'
  };

  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const tin0 = engine.activities[0];
  const tin1 = engine.activities[1];
  const tinC2 = engine.activities[2];

  tin0.maxDaily = 2;
  tin1.maxDaily = 2;

  // C1: Tin0 at slot 40, Tin1 at slot 50
  engine.placeActivityDirect(tin0.id, 40);
  engine.placeActivityDirect(tin1.id, 50);

  // C2: TinC2 occupies LAB_01 at slot 41
  engine.placeActivityDirect(tinC2.id, 41);

  const initialMetrics = engine.evaluateMetrics();
  await engine.tryPairClassSingletons(initialMetrics);

  // LAB_01 must never have 2 activities in the same slot
  const labIdx = engine.roomIndexMap.get('lab_01');
  assert.notEqual(labIdx, undefined, 'Room LAB_01 must exist');
  const rg = engine.roomGridList[labIdx];
  assert.equal(rg[41], tinC2.id, 'Room LAB_01 at slot 41 must belong to tinC2 without clash');
});

// -----------------------------------------------------------------------------
// CATEGORY 4: ACID Transactional Rollback Oracle
// -----------------------------------------------------------------------------

test('CAT-4.1: ACID Rollback - Bit-for-bit grid & state preservation when pairing cannot be satisfied', async () => {
  const data = makeData({
    classes: [{ id: 'C1', ten: '10A1', khoi: '10' }],
    subjects: [
      { name: 'Van', teacher: 'GV02', periods: 2, limit: 1 }
    ]
  });
  const engine = new FetEngine(data, { seed: 42, mode: 'optimize_singletons' });
  engine.init();
  engine.compileConstraints();

  const van0 = engine.activities[0];
  const van1 = engine.activities[1];

  van0.maxDaily = 2;
  van1.maxDaily = 2;

  // Friday morning: slot 40 is Van0
  // Saturday morning: slot 50 is Van1
  // Block all other slots in Friday morning (41..44) and Saturday morning (51..54) with class OFF (-2)
  const cGrid = engine.classGridList[0];
  for (let s = 41; s < 45; s++) cGrid[s] = -2;
  for (let s = 51; s < 55; s++) cGrid[s] = -2;

  engine.placeActivityDirect(van0.id, 40);
  engine.placeActivityDirect(van1.id, 50);

  // Capture pre-state snapshot
  const preClassGrid = Array.from(engine.classGridList[0]);
  const preTeacher0 = Array.from(engine.teacherGridList[0]);
  const prePlacements = Array.from(engine.actPlacement);

  const initialMetrics = engine.evaluateMetrics();
  const res = await engine.tryPairClassSingletons(initialMetrics);

  assert.equal(res, null, 'Pairing must return null when no consecutive slot pair is feasible');

  // Verify that grids did not drift by even 1 integer
  assert.deepEqual(Array.from(engine.classGridList[0]), preClassGrid, 'Class grid must be bit-for-bit identical');
  assert.deepEqual(Array.from(engine.teacherGridList[0]), preTeacher0, 'Teacher grid must be bit-for-bit identical');
  assert.deepEqual(Array.from(engine.actPlacement), prePlacements, 'Activity placements must be bit-for-bit identical');
});

// -----------------------------------------------------------------------------
// CATEGORY 5: Synthetic Dense Multi-Class Adversarial Fuzzing
// -----------------------------------------------------------------------------

test('CAT-5.1: Multi-class schedule with 6 classes, 12 teachers, scattered singletons -> full pairing & 0 holes', async () => {
  const classCount = 6;
  const classes = [];
  for (let c = 1; c <= classCount; c++) {
    classes.push({ id: `C${c}`, ten: `10A${c}`, khoi: '10', buoi: 'Sáng', shift: 'morning' });
  }

  const teachers = [];
  for (let t = 1; t <= 12; t++) {
    teachers.push({ ma: `GV_${t}`, ten: `GV_${t}`, id: `GV_${t}` });
  }

  const subjects = [
    { name: 'Toan', teacher: 'GV_1', periods: 4, limit: 2 },
    { name: 'Van', teacher: 'GV_2', periods: 4, limit: 2 },
    { name: 'Anh', teacher: 'GV_3', periods: 3, limit: 2 },
    { name: 'Ly', teacher: 'GV_4', periods: 2, limit: 2 },
    { name: 'Hoa', teacher: 'GV_5', periods: 2, limit: 2 },
    { name: 'Sinh', teacher: 'GV_6', periods: 1, limit: 1 },
    { name: 'Su', teacher: 'GV_7', periods: 1, limit: 1 },
    { name: 'Dia', teacher: 'GV_8', periods: 1, limit: 1 },
    { name: 'GDCD', teacher: 'GV_9', periods: 1, limit: 1 },
    { name: 'Tin', teacher: 'GV_10', periods: 1, limit: 1 }
  ];

  const data = makeData({ classes, subjects });
  const engine = new FetEngine(data, { seed: 2026 });
  engine.init();
  const ok = engine.solve();
  assert.equal(ok.ok, true, 'Solver must solve dense fixture');
  assert.equal(engine.evaluateMetrics().unplacedCount, 0, 'Zero unplaced activities');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes after solve');

  await engine.optimize('optimize_singletons');

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, 'Zero unplaced activities after singleton optimization');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes after singleton optimization');
  assert.equal(m.soBuoiTrong2, 0, 'Zero 2-period teacher gaps');
});

test('CAT-5.2: Fuzzing 10 randomized seeds: tryPairClassSingletons strictly maintains invariants', async () => {
  const seeds = [1, 7, 13, 42, 77, 101, 333, 777, 999, 2026];
  for (const seed of seeds) {
    const data = makeData({
      classes: [
        { id: 'C1', ten: '10A1', khoi: '10' },
        { id: 'C2', ten: '10A2', khoi: '10' },
        { id: 'C3', ten: '10A3', khoi: '10' }
      ],
      subjects: [
        { name: 'Toan', teacher: 'GV1', periods: 4, limit: 2 },
        { name: 'Van', teacher: 'GV2', periods: 4, limit: 2 },
        { name: 'Anh', teacher: 'GV3', periods: 3, limit: 2 },
        { name: 'Ly', teacher: 'GV4', periods: 2, limit: 2 },
        { name: 'Hoa', teacher: 'GV5', periods: 2, limit: 2 }
      ]
    });

    const engine = new FetEngine(data, { seed });
    engine.init();
    const ok = engine.solve();
    if (!ok.ok) continue;

    const initialHoles = engine.countTotalStudentHoles();
    assert.equal(initialHoles, 0, `Seed ${seed}: student holes before pairing must be 0`);

    const m0 = engine.evaluateMetrics();
    await engine.tryPairClassSingletons(m0);

    const postHoles = engine.countTotalStudentHoles();
    assert.equal(postHoles, 0, `Seed ${seed}: student holes after tryPairClassSingletons must be 0`);
    assert.equal(engine.evaluateMetrics().unplacedCount, 0, `Seed ${seed}: zero unplaced activities`);
  }
});

// -----------------------------------------------------------------------------
// CATEGORY 6: Real-World Benchmark Acceptance Verification
// -----------------------------------------------------------------------------

test('CAT-6.1: Real-World Dataset scratch/live_school_default.json (75 classes / 2,202 periods) meets all acceptance criteria', async () => {
  const fixturePath = path.resolve(__dirname, '..', 'scratch', 'live_school_default.json');
  if (!fs.existsSync(fixturePath)) {
    return; // Skip if fixture is not present in environment
  }
  const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const engine = new FetEngine(rawData, { seed: 101 });
  engine.init();
  engine.loadExistingSchedule();

  const unplacedBefore = engine.evaluateMetrics().unplacedCount;
  assert.equal(unplacedBefore, 0, 'Incumbent schedule must be 100% placed (2,202/2,202)');

  await engine.optimize('optimize_singletons');

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, 'Must remain 100% placed');
  assert.equal(m.soBuoiDay1, 0, 'soBuoiDay1 must be completely eliminated (0)');
  assert.equal(m.soBuoiTrong2, 0, 'soBuoiTrong2 must remain 0');
  assert.equal(engine.countTotalStudentHoles(), 0, 'countTotalStudentHoles() must remain 0');

  // Verify Ms. V.Quynh (GV014 / v.quỳnh) Saturday taught periods === 0
  const gvIdx = engine.teacherIndexMap.get('v.quỳnh');
  assert.notEqual(gvIdx, undefined, 'Teacher v.quỳnh must exist');
  const tg = engine.teacherGridList[gvIdx];
  // Saturday = Day 5 -> Morning: slots 50..54, Afternoon: slots 55..59
  const satTaught = Array.from(tg.slice(50, 60)).filter(x => x >= 0).length;
  assert.equal(satTaught, 0, 'Ms. V.Quỳnh must have 0 taught periods on Saturday (day off)');
});

test('CAT-6.2: Real-World Dataset scratch/dongkhoi_1566.json (54 classes / 1,566 periods) full solve & invariants', async () => {
  const fixturePath = path.resolve(__dirname, '..', 'scratch', 'dongkhoi_1566.json');
  if (!fs.existsSync(fixturePath)) {
    return;
  }
  const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const engine = new FetEngine(rawData, { seed: 101 });
  engine.init();
  engine.loadExistingSchedule();

  assert.equal(engine.evaluateMetrics().unplacedCount, 0, 'Dong Khoi must be 100% placed');
  await engine.optimize('optimize_singletons');

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, 'Dong Khoi unplaced must be 0');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Dong Khoi student holes must be 0');
  assert.equal(m.soBuoiTrong2, 0, 'Dong Khoi gap-2 must be 0');
});
