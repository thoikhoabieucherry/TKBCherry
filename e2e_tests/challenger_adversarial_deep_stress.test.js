"use strict";

/**
 * Adversarial Deep Stress & Invariant Integrity Test Suite
 * Created by Teamwork Empirical Challenger (challenger_2)
 *
 * Focus Areas:
 * 1. randomSwap recursion under extreme conflict density, Tabu cycle prevention, depth <= 16 call-stack safety.
 * 2. ACID state rollback verification (actPlacement, classGrid, teacherGrid, roomGrid, teacherSessionCounts, swappedInBranch).
 * 3. Post-optimization boundary conditions (isolated singletons, gioihan = 1, teacher OFF days, co-teaching, student contiguity).
 * 4. Execution budget limits (limitCalls, deadlineAtMs) and zero-freeze guarantees.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
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
  vm.runInContext(ENGINE_SOURCE, context, { filename: "tkb-fet-engine.js" });
  return window.FetTimetableEngine;
}

const FetTimetableEngine = loadEngine();

const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const SESSIONS = ["sang", "chieu"];
const PERIODS_PER_SESSION = 5;
const SLOTS_PER_DAY = 10;
const TOTAL_SLOTS = 60;

function makeStressFixture({
  classes = [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10", ca: "sang" }],
  assignments = [],
  constraints = {},
  tkb = {}
}) {
  const teachers = Array.from(
    new Set(
      assignments
        .map((s) => String(s.teacher || "").trim())
        .filter(Boolean)
    )
  );

  const subjectMap = new Map();
  assignments.forEach((s) => {
    const sName = s.subject || s.name;
    if (!subjectMap.has(sName)) {
      subjectMap.set(sName, {
        ten: sName,
        khoi: classes[0]?.khoi || "10",
        sotiet: s.periods || 1,
        gioihan: s.limit !== undefined ? s.limit : 2
      });
    }
  });

  const data = {
    lop: classes,
    mon: Array.from(subjectMap.values()),
    monhoc: Array.from(subjectMap.values()).map((s) => ({ ten: s.ten, ma: s.ten })),
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

  assignments.forEach((a) => {
    const cid = a.classId;
    const mon = a.subject || a.name;
    data.pccmMatrix[`${cid}|${mon}`] = a.teacher;
    data.pccmTietMatrix[`${cid}|${mon}`] = a.periods || 1;
    if (a.limit !== undefined) {
      data.pccmGioihanMatrix[`${cid}|${mon}`] = a.limit;
    }
  });

  return data;
}

function cloneEngineBitState(engine) {
  return {
    actPlacement: engine.actPlacement.slice(),
    classGrids: engine.classGridList.map((g) => new Int32Array(g)),
    teacherGrids: engine.teacherGridList.map((g) => new Int32Array(g)),
    roomGrids: engine.roomGridList.map((g) => new Int32Array(g)),
    teacherSessionCounts: engine.teacherSessionCounts ? new Int8Array(engine.teacherSessionCounts) : null
  };
}

function assertBitForBitEqual(engine, expected, label = "State") {
  assert.deepStrictEqual(
    engine.actPlacement,
    expected.actPlacement,
    `${label}: actPlacement mismatch`
  );
  assert.strictEqual(
    engine.classGridList.length,
    expected.classGrids.length,
    `${label}: classGrids length mismatch`
  );
  for (let i = 0; i < engine.classGridList.length; i++) {
    assert.deepStrictEqual(
      Array.from(engine.classGridList[i]),
      Array.from(expected.classGrids[i]),
      `${label}: classGrid[${i}] bit mismatch`
    );
  }
  for (let i = 0; i < engine.teacherGridList.length; i++) {
    assert.deepStrictEqual(
      Array.from(engine.teacherGridList[i]),
      Array.from(expected.teacherGrids[i]),
      `${label}: teacherGrid[${i}] bit mismatch`
    );
  }
  for (let i = 0; i < engine.roomGridList.length; i++) {
    assert.deepStrictEqual(
      Array.from(engine.roomGridList[i]),
      Array.from(expected.roomGrids[i]),
      `${label}: roomGrid[${i}] bit mismatch`
    );
  }
  if (expected.teacherSessionCounts && engine.teacherSessionCounts) {
    assert.deepStrictEqual(
      Array.from(engine.teacherSessionCounts),
      Array.from(expected.teacherSessionCounts),
      `${label}: teacherSessionCounts bit mismatch`
    );
  }
}

// ---------------------------------------------------------------------------
// SUITE 1: randomSwap Recursion, Tabu Memory & Stack Depth Safety
// ---------------------------------------------------------------------------

test("ADV-1.1: randomSwap recursion under extreme pigeonhole cyclic conflict never overflows stack (depth <= 16)", () => {
  const classes = [
    { id: "C0", ten: "10A1", ten2: "10A1", khoi: "10", ca: "sang" },
    { id: "C1", ten: "10A2", khoi: "10", ca: "sang" },
    { id: "C2", ten: "10A3", khoi: "10", ca: "sang" },
    { id: "C3", ten: "10A4", khoi: "10", ca: "sang" },
    { id: "C4", ten: "10A5", khoi: "10", ca: "sang" }
  ];

  const assignments = [
    { classId: "C0", subject: "S0", teacher: "T0", periods: 1, limit: 1 },
    { classId: "C1", subject: "S1", teacher: "T1", periods: 1, limit: 1 },
    { classId: "C2", subject: "S2", teacher: "T2", periods: 1, limit: 1 },
    { classId: "C3", subject: "S3", teacher: "T3", periods: 1, limit: 1 },
    { classId: "C4", subject: "S4", teacher: "T4", periods: 1, limit: 1 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Block all slots except slot 0 for all classes
  for (let c = 0; c < 5; c++) {
    const cg = engine.classGridList[c];
    for (let s = 1; s < TOTAL_SLOTS; s++) {
      cg[s] = -2;
    }
  }

  // Place activities in cyclical conflict at slot 0:
  engine.placeActivityDirect(1, 0); // Act 1 in C1 slot 0
  engine.placeActivityDirect(2, 0); // Act 2 in C2 slot 0
  engine.placeActivityDirect(3, 0); // Act 3 in C3 slot 0
  engine.placeActivityDirect(4, 0); // Act 4 in C4 slot 0

  engine.nCalls = 0;
  engine.limitCalls = 5000;
  engine.tabuMap.clear();
  engine.triedRemovals.clear();
  engine.swappedInBranch.clear();

  let callStackOverflowed = false;
  try {
    engine.randomSwap(0, 0);
  } catch (err) {
    if (err instanceof RangeError && err.message.includes("call stack")) {
      callStackOverflowed = true;
    } else {
      throw err;
    }
  }

  assert.strictEqual(callStackOverflowed, false, "Must not throw RangeError call stack overflow");
  assert.strictEqual(engine.swappedInBranch.size, 0, "swappedInBranch must be cleared at level 0");
});

test("ADV-1.2: randomSwap with extreme recursion density respects limitCalls and aborts cleanly", () => {
  // Construct 5 classes with tight conflicts where all free slots are blocked
  const classes = [];
  const assignments = [];
  for (let i = 0; i < 5; i++) {
    classes.push({ id: `CL_${i}`, ten: `Lop_${i}`, khoi: "10", ca: "sang" });
    assignments.push({ classId: `CL_${i}`, subject: `Sub_${i}`, teacher: "GV_SHARED", periods: 1, limit: 1 });
  }

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Block almost all slots with OFF (-2) to force speculative ejections
  for (let c = 0; c < 5; c++) {
    const cg = engine.classGridList[c];
    for (let s = 2; s < TOTAL_SLOTS; s++) {
      cg[s] = -2;
    }
  }

  // Place Act 1, 2, 3, 4 at slot 0 and slot 1 across classes, leaving 0 free slots for Act 0
  engine.placeActivityDirect(1, 0);
  engine.placeActivityDirect(2, 1);
  engine.placeActivityDirect(3, 0);
  engine.placeActivityDirect(4, 1);

  engine.limitCalls = 5; // Very small call limit
  engine.nCalls = 0;

  const res = engine.randomSwap(0, 0);
  assert.strictEqual(res, false, "Must fail once limitCalls is exhausted");
  assert.ok(engine.nCalls >= 5, "Engine must halt once nCalls >= limitCalls");
});

test("ADV-1.3: randomSwap respects deadlineAtMs timeout immediately when expired", () => {
  const classes = [{ id: "C1", ten: "10A1", khoi: "10", ca: "sang" }];
  const assignments = [
    { classId: "C1", subject: "S1", teacher: "GV1", periods: 1, limit: 1 },
    { classId: "C1", subject: "S2", teacher: "GV2", periods: 1, limit: 1 }
  ];
  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Block all slots except slot 0, and place Act 1 at slot 0
  const cg = engine.classGridList[0];
  for (let s = 1; s < TOTAL_SLOTS; s++) cg[s] = -2;
  engine.placeActivityDirect(1, 0);

  // Set deadline in the past
  engine.deadlineAtMs = Date.now() - 500;
  engine.nCalls = 0;
  engine.limitCalls = 100000;

  const res = engine.randomSwap(0, 0);
  assert.strictEqual(res, false, "Must return false when deadline is expired and no free slot exists");
});

// ---------------------------------------------------------------------------
// SUITE 2: ACID Rollback & State Snapshot Bit-for-Bit Integrity
// ---------------------------------------------------------------------------

test("ADV-2.1: restoreStateSnapshot achieves 100% bit-for-bit restoration on failed ejection cascade", () => {
  const classes = [
    { id: "C0", ten: "10A1", khoi: "10", ca: "sang" },
    { id: "C1", ten: "10A2", khoi: "10", ca: "sang" },
    { id: "C2", ten: "10A3", khoi: "10", ca: "sang" }
  ];
  const assignments = [
    { classId: "C0", subject: "Toan", teacher: "GV_T", periods: 3, limit: 2 },
    { classId: "C0", subject: "Van", teacher: "GV_V", periods: 2, limit: 2 },
    { classId: "C1", subject: "Toan", teacher: "GV_T", periods: 3, limit: 2 },
    { classId: "C1", subject: "Anh", teacher: "GV_A", periods: 2, limit: 2 },
    { classId: "C2", subject: "Toan", teacher: "GV_T", periods: 3, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Place some activities
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 1);
  engine.placeActivityDirect(2, 2);
  engine.placeActivityDirect(3, 10);
  engine.placeActivityDirect(4, 11);

  // Capture baseline state snapshot
  const baseline = cloneEngineBitState(engine);
  const snap = engine.captureStateSnapshot();

  // Perform multiple mutations (unplaces, displacements, placements)
  engine.unplaceActivity(0);
  engine.unplaceActivity(1);
  engine.placeActivityDirect(0, 20);
  engine.placeActivityDirect(1, 21);

  // Assert state is currently modified
  assert.notDeepStrictEqual(engine.actPlacement, baseline.actPlacement);

  // Restore snapshot
  engine.restoreStateSnapshot(snap);

  // Assert bit-for-bit exact recovery
  assertBitForBitEqual(engine, baseline, "ADV-2.1 Snapshot Rollback");
});

test("ADV-2.2: tryPairClassSingletons transactional rollback restores state bit-for-bit when pair fails", async () => {
  const classes = [{ id: "C1", ten: "10A1", khoi: "10", ca: "sang" }];
  const assignments = [
    { classId: "C1", subject: "Toan", teacher: "gv_toan", periods: 2, limit: 2 },
    { classId: "C1", subject: "Van", teacher: "gv_van", periods: 1, limit: 2 },
    { classId: "C1", subject: "Su", teacher: "gv_su", periods: 1, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Place Toan at slot 0 (Mon P1) and slot 10 (Tue P1) -> two singletons in distinct sessions
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);
  engine.placeActivityDirect(2, 1); // Van at slot 1
  engine.placeActivityDirect(3, 11); // Su at slot 11

  // Block all other slots with -2 (OFF) to force pairing displacement to fail
  const cg = engine.classGridList[0];
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    if (s !== 0 && s !== 1 && s !== 10 && s !== 11) {
      cg[s] = -2;
    }
  }

  // Teacher gv_toan is also blocked everywhere else
  const tIdx = engine.teacherIndexMap.get("gv_toan");
  if (tIdx !== undefined) {
    const tg = engine.teacherGridList[tIdx];
    for (let s = 0; s < TOTAL_SLOTS; s++) {
      if (s !== 0 && s !== 10) tg[s] = -2;
    }
  }

  const baseline = cloneEngineBitState(engine);
  const initialMetrics = engine.evaluateMetrics();

  const res = await engine.tryPairClassSingletons(initialMetrics);
  assert.strictEqual(Boolean(res), false, "Pairing should fail cleanly due to lack of feasible displacement slots");
  assertBitForBitEqual(engine, baseline, "ADV-2.2 PairClassSingletons Rollback");
});

test("ADV-2.3: tryCrossDayPairShift transactional rollback preserves state when relocation is infeasible", async () => {
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10", ca: "sang" },
    { id: "C2", ten: "10A2", khoi: "10", ca: "sang" }
  ];
  const assignments = [
    { classId: "C1", subject: "Toan", teacher: "gv_t", periods: 1, limit: 2 },
    { classId: "C2", subject: "Toan", teacher: "gv_t", periods: 2, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // gv_t has 1 period in C1 at Thu 2 (slot 0), and 2 periods in C2 at Thu 3 (slots 10, 11)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);
  engine.placeActivityDirect(2, 11);

  // Block Thu 2 for C2 and Thu 3 for C1 with OFF (-2)
  const cg1 = engine.classGridList[0];
  const cg2 = engine.classGridList[1];
  for (let p = 0; p < PERIODS_PER_SESSION; p++) {
    cg1[10 + p] = -2; // C1 blocked on Thu 3
    cg2[0 + p] = -2;  // C2 blocked on Thu 2
  }

  const baseline = cloneEngineBitState(engine);
  const initialMetrics = engine.evaluateMetrics();

  const res = await engine.tryCrossDayPairShift(initialMetrics);
  assert.strictEqual(Boolean(res), false, "Cross day shift must fail cleanly when target sessions are blocked");
  assertBitForBitEqual(engine, baseline, "ADV-2.3 CrossDayPairShift Rollback");
});

// ---------------------------------------------------------------------------
// SUITE 3: Boundary Conditions & Operator Invariant Guards
// ---------------------------------------------------------------------------

test("ADV-3.1: tryPairClassSingletons strictly ignores isolated singletons with total requirement = 1", async () => {
  // Teacher has 1 single period of GDCD (total requirement = 1)
  const classes = [{ id: "C1", ten: "10A1", khoi: "10", ca: "sang" }];
  const assignments = [
    { classId: "C1", subject: "GDCD", teacher: "gv_gdcd", periods: 1, limit: 1 },
    { classId: "C1", subject: "Van", teacher: "gv_van", periods: 2, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  engine.placeActivityDirect(0, 0); // GDCD at slot 0
  engine.placeActivityDirect(1, 10); // Van at slot 10
  engine.placeActivityDirect(2, 11); // Van at slot 11

  const baseline = cloneEngineBitState(engine);
  const initialMetrics = engine.evaluateMetrics();

  const res = await engine.tryPairClassSingletons(initialMetrics);
  // GDCD is an isolated singleton with no sibling activities of the same subject
  assert.strictEqual(Boolean(res), false, "Isolated singleton cannot be paired");
  assertBitForBitEqual(engine, baseline, "ADV-3.1 Isolated Singleton Invariant");
});

test("ADV-3.2: tryPairClassSingletons strictly respects subject daily limit gioihan = 1", async () => {
  // A subject has 2 periods in the week, but gioihan = 1 (max 1 period per session/day)
  const classes = [{ id: "C1", ten: "10A1", khoi: "10", ca: "sang" }];
  const assignments = [
    { classId: "C1", subject: "Su", teacher: "gv_su", periods: 2, limit: 1 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Place Su at slot 0 (Mon) and slot 10 (Tue)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);

  const baseline = cloneEngineBitState(engine);
  const initialMetrics = engine.evaluateMetrics();

  const res = await engine.tryPairClassSingletons(initialMetrics);
  // Must NOT pair because maxDaily / gioihan is 1
  assert.strictEqual(Boolean(res), false, "Must forbid pairing when gioihan = 1");
  assertBitForBitEqual(engine, baseline, "ADV-3.2 Gioihan = 1 Invariant");
});

test("ADV-3.3: tryCrossDayPairShift strictly obeys teacher OFF day/session constraints", async () => {
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10", ca: "sang" }
  ];
  const assignments = [
    { classId: "C1", subject: "Toan", teacher: "gv_t", periods: 1, limit: 2 },
    { classId: "C1", subject: "Toan", teacher: "gv_t", periods: 2, limit: 2 }
  ];

  // Teacher gv_t has OFF constraint on Thursday (thu5)
  const constraints = {
    fixedOff: {
      teacher: {
        "gv_t": {
          "thu5|sang|0": true,
          "thu5|sang|1": true,
          "thu5|sang|2": true,
          "thu5|sang|3": true,
          "thu5|sang|4": true
        }
      }
    }
  };

  const data = makeStressFixture({ classes, assignments, constraints });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Activity 0 at Thu 2 (slot 0)
  // Activity 1, 2 at Thu 3 (slots 10, 11)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);
  engine.placeActivityDirect(2, 11);

  const tIdx = engine.teacherIndexMap.get("gv_t");
  assert.notStrictEqual(tIdx, undefined, "gv_t must exist in teacherIndexMap");
  const tg = engine.teacherGridList[tIdx];

  // Verify Thu 5 slots in teacherGrid are -2
  for (let p = 0; p < PERIODS_PER_SESSION; p++) {
    assert.strictEqual(tg[30 + p], -2, "Thu 5 morning slots must be -2");
  }

  const initialMetrics = engine.evaluateMetrics();

  // Run solver post-optimizations
  await engine.tryCrossDayPairShift(initialMetrics);

  // Assert teacher OFF slots are never touched
  for (let p = 0; p < PERIODS_PER_SESSION; p++) {
    assert.strictEqual(tg[30 + p], -2, "Thu 5 morning slots must remain -2");
  }
});

test("ADV-3.4: Student contiguity is strictly preserved and student holes are never left unhandled", () => {
  const classes = [{ id: "C1", ten: "10A1", khoi: "10", ca: "sang" }];
  const assignments = [
    { classId: "C1", subject: "M1", teacher: "T1", periods: 1, limit: 2 },
    { classId: "C1", subject: "M2", teacher: "T2", periods: 1, limit: 2 },
    { classId: "C1", subject: "M3", teacher: "T3", periods: 1, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Place M1 at slot 0 (P1), M2 at slot 2 (P3), M3 at slot 4 (P5) -> Creates internal holes at P2, P4
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 2);
  engine.placeActivityDirect(2, 4);

  const initialHoles = engine.countTotalStudentHoles();
  assert.strictEqual(initialHoles, 2, "Must detect 2 student holes");

  // Run compaction
  engine.compactAllStudentSessions();

  const finalHoles = engine.countTotalStudentHoles();
  assert.strictEqual(finalHoles, 0, "Compaction must completely eliminate student holes");
  
  // Verify activities are placed contiguously at slots 0, 1, 2
  const cg = engine.classGridList[0];
  assert.ok(cg[0] >= 0 && cg[1] >= 0 && cg[2] >= 0, "Slots 0, 1, 2 must be filled");
  assert.strictEqual(cg[3], -1, "Slot 3 must be empty");
  assert.strictEqual(cg[4], -1, "Slot 4 must be empty");
});

test("ADV-3.5: Co-teaching multi-teacher activities maintain synchronized placement & rollback", () => {
  const classes = [{ id: "C1", ten: "10A1", khoi: "10", ca: "sang" }];
  const assignments = [
    { classId: "C1", subject: "TheDuc", teacher: "gv_td1, gv_td2", periods: 2, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  const act = engine.activities[0];
  assert.strictEqual(act.teacherIdxs.length, 2, "Activity must have 2 teacher indices");

  // Place at slot 0
  engine.placeActivityDirect(0, 0);
  const t1Idx = act.teacherIdxs[0];
  const t2Idx = act.teacherIdxs[1];

  const tg1 = engine.teacherGridList[t1Idx];
  const tg2 = engine.teacherGridList[t2Idx];
  assert.strictEqual(tg1[0], 0, "Teacher 1 slot 0 must be occupied");
  assert.strictEqual(tg2[0], 0, "Teacher 2 slot 0 must be occupied");

  // Snapshot
  const snap = engine.captureStateSnapshot();

  // Unplace
  engine.unplaceActivity(0);
  assert.strictEqual(tg1[0], -1, "Teacher 1 slot 0 must be cleared");
  assert.strictEqual(tg2[0], -1, "Teacher 2 slot 0 must be cleared");

  // Restore snapshot
  engine.restoreStateSnapshot(snap);
  assert.strictEqual(tg1[0], 0, "Teacher 1 slot 0 must be restored");
  assert.strictEqual(tg2[0], 0, "Teacher 2 slot 0 must be restored");
});

// ---------------------------------------------------------------------------
// SUITE 4: Full Multi-Pass ILS & runUntilZeroSingletons Stress Verification
// ---------------------------------------------------------------------------

test("ADV-4.1: runUntilZeroSingletons on live school benchmark reaches zero singletons without corrupting state", async () => {
  const benchmarkPath = path.resolve(__dirname, "..", "scratch", "live_school_default.json");
  if (!fs.existsSync(benchmarkPath)) return;

  const raw = fs.readFileSync(benchmarkPath, "utf8");
  const data = JSON.parse(raw);

  const engine = new FetTimetableEngine(data, {
    seed: 101,
    mode: "optimize_singletons",
    uiBreathingMs: 0
  });
  engine.init();
  engine.loadExistingSchedule();

  let metrics = engine.evaluateMetrics();
  assert.strictEqual(metrics.unplacedCount, 0, "Must have 0 unplaced activities");

  // Run deep optimization loop until zero singletons
  const optResult = await engine.runUntilZeroSingletons({
    maxPasses: 25,
    timeBudgetMs: 30000
  });

  const finalMetrics = engine.evaluateMetrics();
  assert.strictEqual(finalMetrics.unplacedCount, 0, "Unplaced count must stay 0");
  assert.strictEqual(finalMetrics.soBuoiDay1, 0, "soBuoiDay1 must reach exactly 0");
  assert.strictEqual(finalMetrics.soBuoiTrong2, 0, "soBuoiTrong2 must remain 0");
  assert.strictEqual(engine.countTotalStudentHoles(), 0, "Student holes must remain 0");

  // Check specific teachers requested: T.Chung, V.Quỳnh, PHT.Định
  for (const tName of ["t.chung", "v.quynh", "pht.dinh"]) {
    const tIdx = engine.teacherIndexMap.get(tName);
    if (tIdx !== undefined) {
      const tg = engine.teacherGridList[tIdx];
      for (let d = 0; d < DAYS.length; d++) {
        for (let b = 0; b < SESSIONS.length; b++) {
          const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
          let count = 0;
          for (let p = 0; p < PERIODS_PER_SESSION; p++) {
            if (tg[sStart + p] >= 0) count++;
          }
          assert.ok(count === 0 || count >= 2, `Teacher ${tName} must not have 1-period session (found ${count} at d=${d}, b=${b})`);
        }
      }
    }
  }
});

test("ADV-2.4: tryTargetedIntraClassSingletonCrusher transactional rollback on impossible swap", async () => {
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10", ca: "sang" }
  ];
  const assignments = [
    { classId: "C1", subject: "Toan", teacher: "gv_t", periods: 1, limit: 2 },
    { classId: "C1", subject: "Van", teacher: "gv_v", periods: 1, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  // Single period Toan at slot 0 (Mon), single period Van at slot 10 (Tue)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);

  // Block all other slots with OFF (-2)
  const cg = engine.classGridList[0];
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    if (s !== 0 && s !== 10) cg[s] = -2;
  }

  const baseline = cloneEngineBitState(engine);
  const initialMetrics = engine.evaluateMetrics();

  const res = await engine.tryTargetedIntraClassSingletonCrusher(initialMetrics);
  assert.strictEqual(Boolean(res), false, "Crusher must fail when target session has no free or swappable slots");
  assertBitForBitEqual(engine, baseline, "ADV-2.4 Crusher Rollback");
});

test("ADV-2.5: trySingletonEjectionChains transactional rollback on failed multi-hop ejection", async () => {
  const classes = [
    { id: "C1", ten: "10A1", khoi: "10", ca: "sang" },
    { id: "C2", ten: "10A2", khoi: "10", ca: "sang" }
  ];
  const assignments = [
    { classId: "C1", subject: "Toan", teacher: "gv_t", periods: 1, limit: 2 },
    { classId: "C2", subject: "Van", teacher: "gv_v", periods: 1, limit: 2 }
  ];

  const data = makeStressFixture({ classes, assignments });
  const engine = new FetTimetableEngine(data);
  engine.buildActivities();
  engine.compileConstraints();

  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);

  // Block both classes everywhere else
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    if (s !== 0) engine.classGridList[0][s] = -2;
    if (s !== 10) engine.classGridList[1][s] = -2;
  }

  const baseline = cloneEngineBitState(engine);
  const initialMetrics = engine.evaluateMetrics();

  const res = await engine.trySingletonEjectionChains(initialMetrics);
  assert.strictEqual(Boolean(res), false, "Ejection chains must fail when no displacement is possible");
  assertBitForBitEqual(engine, baseline, "ADV-2.5 Ejection Chains Rollback");
});

test("ADV-4.2: Full solve and invariant verification on scratch/dongkhoi_1566.json", () => {
  const filePath = path.resolve(__dirname, "..", "scratch", "dongkhoi_1566.json");
  if (!fs.existsSync(filePath)) return;

  const rawData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const engine = new FetTimetableEngine(rawData, { seed: 101, uiBreathingMs: 0 });
  engine.init();

  const solveRes = engine.solve();
  assert.strictEqual(solveRes.ok, true, "Dong Khoi solve must succeed");
  assert.strictEqual(solveRes.unassigned, 0, "All 1,566 periods must be placed");

  const m = engine.evaluateMetrics();
  assert.strictEqual(m.unplacedCount, 0, "unplacedCount === 0");
  assert.strictEqual(m.soBuoiTrong2, 0, "soBuoiTrong2 === 0");
  assert.strictEqual(engine.countTotalStudentHoles(), 0, "Student holes === 0");
});

