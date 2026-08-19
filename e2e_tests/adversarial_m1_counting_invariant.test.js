"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_PATH = path.join(ROOT, "web", "pages", "tkb-fet-engine.js");
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, "utf8");
const DONGKHOI_PATH = path.join(ROOT, "scratch", "dongkhoi_1566.json");
const DEFAULT_SCHOOL_PATH = path.join(ROOT, "scratch", "live_school_default.json");

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

const FetTimetableEngine = loadEngine();

function makeStressData({
  classes = [],
  subjects = [],
  teachers = [],
  pccm = {},
  pccmTiet = {},
  pccmGioihan = {},
  constraints = {},
  tkb = {}
}) {
  return {
    lop: classes.map(c => typeof c === "string" ? { id: c, ten: c, ten2: c, khoi: "10" } : c),
    mon: subjects.map(s => typeof s === "string" ? { ten: s, khoi: "10", sotiet: 2, gioihan: 2 } : s),
    monhoc: subjects.map(s => typeof s === "string" ? { ten: s, ma: s } : { ten: s.ten, ma: s.ten }),
    giaovien: teachers.map(t => typeof t === "string" ? { ma: t, ten: t, id: t } : t),
    pccmMatrix: pccm,
    pccmTietMatrix: pccmTiet,
    pccmRoomMatrix: {},
    pccmGioihanMatrix: pccmGioihan,
    tkb,
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: constraints
  };
}

// ============================================================================
// ADVERSARIAL SUITE 1: 12-Session Mathematical Counting Invariant Boundary Unit Tests
// ============================================================================

test("M1-ADV-1.1: 12-Session Shift Independence vs Legacy 6-Day Aggregation", () => {
  const data = makeStressData({
    classes: ["10A1"],
    subjects: [{ ten: "Toan", khoi: "10", sotiet: 4, gioihan: 1 }],
    teachers: ["GV01"],
    pccm: { "10A1|Toan": "GV01" },
    pccmTiet: { "10A1|Toan": 4 }
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  assert.equal(engine.teacherWeeklyLoad.get("gv01"), 4);

  // In legacy 6-day aggregation: Morning (slot 0) + Afternoon (slot 5) on Thu 2 was treated as 1 day of 2 periods.
  // In 12-session invariant: Morning (session 0) and Afternoon (session 1) are 2 SEPARATE sessions.
  // When GV01 has 1 period in session 0 and 1 period in session 1, openedSessions = 2 = Math.floor(4/2).
  engine.teacherSessionCounts[0] = 1; // Mon Sang
  engine.teacherSessionCounts[1] = 1; // Mon Chieu

  // Attempting to open a 3rd session on Tue Sang (session 2, slot 10) must be REJECTED
  assert.equal(engine.opensUnaffordableSession(act, 10), true, "Opening 3rd session exceeds maxAllowedSessions (2)");

  // But placing into Mon Sang (session 0, slot 1) or Mon Chieu (session 1, slot 6) is ALLOWED
  assert.equal(engine.opensUnaffordableSession(act, 1), false, "Placing in open session 0 is allowed");
  assert.equal(engine.opensUnaffordableSession(act, 6), false, "Placing in open session 1 is allowed");
});

test("M1-ADV-1.2: Deficit Calculation for Multi-Odd Load Distribution", () => {
  // Total load = 7 periods. Max sessions = floor(7/2) = 3.
  const data = makeStressData({
    classes: ["10A1"],
    subjects: [{ ten: "Toan", khoi: "10", sotiet: 7, gioihan: 1 }],
    teachers: ["GV01"],
    pccm: { "10A1|Toan": "GV01" },
    pccmTiet: { "10A1|Toan": 7 }
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  assert.equal(engine.teacherWeeklyLoad.get("gv01"), 7);

  // Suppose 3 sessions are open with 1 period each:
  // Session 0: 1, Session 1: 1, Session 2: 1. Total placed = 3. Unplaced = 4.
  // Deficit in open sessions = (2-1) + (2-1) + (2-1) = 3 <= unplaced (4).
  engine.teacherSessionCounts[0] = 1;
  engine.teacherSessionCounts[1] = 1;
  engine.teacherSessionCounts[2] = 1;

  // Opening a 4th session (Session 3, slot 15):
  // openedSessions becomes 4 > maxAllowedSessions (3) -> REJECTED
  assert.equal(engine.opensUnaffordableSession(act, 15), true);

  // Placing into Session 0 (slot 1):
  // Placed becomes 4, unplaced becomes 3. Session 0 has 2, Session 1 has 1, Session 2 has 1.
  // Total deficit = 0 + 1 + 1 = 2 <= remaining unplaced (3) -> ALLOWED
  assert.equal(engine.opensUnaffordableSession(act, 1), false);
});

test("M1-ADV-1.3: Co-Teaching Multi-Teacher Activity Invariant Verification", () => {
  // Activity has TWO teachers: GV_LEAN (load 2) and GV_RICH (load 10)
  const data = makeStressData({
    classes: ["10A1"],
    subjects: [
      { ten: "ChuyenDe", khoi: "10", sotiet: 2, gioihan: 2 }
    ],
    teachers: ["GV_LEAN", "GV_RICH"],
    pccm: { "10A1|ChuyenDe": "GV_LEAN, GV_RICH" },
    pccmTiet: { "10A1|ChuyenDe": 2 }
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  assert.equal(act.teacherIdxs.length, 2, "Activity must have 2 teacher indices");

  const leanIdx = engine.teachers.indexOf("gv_lean");

  // GV_LEAN already has 1 session open with 2 periods (Session 0: 2) -> maxAllowedSessions = floor(2/2) = 1
  engine.teacherSessionCounts[leanIdx * 12 + 0] = 2;

  // GV_RICH has 0 sessions open -> can open session 1
  // But GV_LEAN CANNOT open session 1 because maxAllowedSessions = 1 is already reached!
  assert.equal(engine.opensUnaffordableSession(act, 5), true, "Must reject if ANY teacher violates counting invariant");
});

// ============================================================================
// ADVERSARIAL SUITE 2: Extreme Constraint Density & Teacher Off Days
// ============================================================================

test("M1-ADV-2.1: Extreme Teacher Off-Days (80% sessions blocked) Hard Invariants Preserved", async () => {
  // Scenario: 4 classes, 4 teachers. 8 of 10 available sessions are blocked for each teacher.
  const classes = ["10A1", "10A2", "10A3", "10A4"];
  const teachers = ["GV_T1", "GV_T2", "GV_T3", "GV_T4"];
  const pccm = {};
  const pccmTiet = {};
  const teacherOff = {};

  classes.forEach((c, ci) => {
    teachers.forEach((t, ti) => {
      pccm[`${c}|Mon_${ti}`] = t;
      pccmTiet[`${c}|Mon_${ti}`] = 2; // 2 periods per subject per class -> 8 periods total per teacher
    });
  });

  // Each teacher has 8 periods = 4 sessions of 2.
  // Mark 3 full days OFF for each teacher in staggered pattern
  const offPatterns = [
    ["thu2", "thu3", "thu4"], // GV_T1 only available thu5, thu6, thu7
    ["thu3", "thu4", "thu5"], // GV_T2 only available thu2, thu6, thu7
    ["thu4", "thu5", "thu6"], // GV_T3 only available thu2, thu3, thu7
    ["thu5", "thu6", "thu7"]  // GV_T4 only available thu2, thu3, thu4
  ];

  teachers.forEach((t, ti) => {
    teacherOff[t] = {};
    offPatterns[ti].forEach(thu => {
      for (let p = 0; p < 5; p++) {
        teacherOff[t][`${thu}|sang|${p}`] = true;
        teacherOff[t][`${thu}|chieu|${p}`] = true;
      }
    });
  });

  const data = makeStressData({
    classes,
    subjects: [
      { ten: "Mon_0", khoi: "10", sotiet: 2, gioihan: 2 },
      { ten: "Mon_1", khoi: "10", sotiet: 2, gioihan: 2 },
      { ten: "Mon_2", khoi: "10", sotiet: 2, gioihan: 2 },
      { ten: "Mon_3", khoi: "10", sotiet: 2, gioihan: 2 }
    ],
    teachers,
    pccm,
    pccmTiet,
    constraints: { fixedOff: { teacher: teacherOff } }
  });

  const engine = new FetTimetableEngine(data, { seed: 42, timeBudgetMs: 5000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();

  assert.equal(solveRes.ok, true, "Solve must succeed under tight teacher availability");
  assert.equal(solveRes.unassigned, 0, "Hard invariant: unplacedCount === 0");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, "Empirical check: unplacedCount === 0");
  assert.equal(m.soBuoiTrong2, 0, "Empirical check: soBuoiTrong2 === 0");
  assert.equal(engine.countTotalStudentHoles(), 0, "Empirical check: countTotalStudentHoles === 0");
});

test("M1-ADV-2.2: High Slot Density Schedule (25 periods/class zero slack) Invariant Verification", async () => {
  // 2 classes with 25 periods each across 5 days (Mon-Fri morning, Sat OFF)
  // 5 teachers with 10 periods each (5 per class). Max sessions = floor(10/2) = 5 = exact match with 5 days.
  const classes = ["10A1", "10A2"];
  const teachers = ["GV_A", "GV_B", "GV_C", "GV_D", "GV_E"];
  const subjects = [
    { ten: "Toan", khoi: "10", sotiet: 5, gioihan: 2 },
    { ten: "Van", khoi: "10", sotiet: 5, gioihan: 2 },
    { ten: "Anh", khoi: "10", sotiet: 5, gioihan: 2 },
    { ten: "Ly", khoi: "10", sotiet: 5, gioihan: 2 },
    { ten: "Hoa", khoi: "10", sotiet: 5, gioihan: 2 }
  ];

  const pccm = {};
  const pccmTiet = {};
  classes.forEach(c => {
    subjects.forEach((s, i) => {
      pccm[`${c}|${s.ten}`] = teachers[i];
      pccmTiet[`${c}|${s.ten}`] = 5;
    });
  });

  const data = makeStressData({
    classes,
    subjects,
    teachers,
    pccm,
    pccmTiet,
    constraints: {
      fixedOff: {
        class: {
          "10A1": { "thu7|sang|0": true, "thu7|sang|1": true, "thu7|sang|2": true, "thu7|sang|3": true, "thu7|sang|4": true },
          "10A2": { "thu7|sang|0": true, "thu7|sang|1": true, "thu7|sang|2": true, "thu7|sang|3": true, "thu7|sang|4": true }
        }
      }
    }
  });

  const engine = new FetTimetableEngine(data, { seed: 101, timeBudgetMs: 5000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();

  assert.equal(solveRes.ok, true, "Solve must succeed at full 25-period density");
  assert.equal(solveRes.unassigned, 0, "All 50 periods placed (unassigned === 0)");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, "unplacedCount === 0");
  assert.equal(m.soBuoiTrong2, 0, "soBuoiTrong2 === 0");
  assert.equal(m.soBuoiDay1, 0, "soBuoiDay1 === 0 (eliminated by invariant)");
  assert.equal(engine.countTotalStudentHoles(), 0, "countTotalStudentHoles === 0");
});

test("M1-ADV-2.3: Invariant Fallback Pass Relaxation Under Rigid Overconstrained Scenarios", () => {
  // If an artificial problem forces teachers to open more than floor(load/2) sessions,
  // minTwoGuardActive must be gracefully relaxed in multi-pass fallback (pass >= 0).
  const data = makeStressData({
    classes: ["10A1"],
    subjects: [{ ten: "Toan", khoi: "10", sotiet: 4, gioihan: 1 }],
    teachers: ["GV01"],
    pccm: { "10A1|Toan": "GV01" },
    pccmTiet: { "10A1|Toan": 4 }
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Guard active in Pass 0
  engine.minTwoGuardActive = true;
  engine.teacherSessionCounts[0] = 1;
  engine.teacherSessionCounts[1] = 1;
  const act = engine.activities[0];
  assert.equal(engine.opensUnaffordableSession(act, 10), true, "Guard blocks opening 3rd session in Pass 0");

  // Fallback in Pass 1 disables guard to guarantee solver completeness
  engine.minTwoGuardActive = false;
  assert.equal(engine.opensUnaffordableSession(act, 10), false, "Fallback pass relaxes guard to prevent unassigned deadlock");
});

// ============================================================================
// ADVERSARIAL SUITE 3: Tight Time Budgets & Deadlines
// ============================================================================

test("M1-ADV-3.1: Strict Deadline Enforcement (50ms, 100ms, 200ms) on Real-World Benchmark", async () => {
  assert.ok(fs.existsSync(DONGKHOI_PATH), "Dong Khoi dataset exists");
  const raw = fs.readFileSync(DONGKHOI_PATH, "utf8");

  const budgets = [50, 100, 200];
  for (const budgetMs of budgets) {
    const data = JSON.parse(raw);
    const engine = new FetTimetableEngine(data, { seed: 12345, timeBudgetMs: budgetMs, uiBreathingMs: 0 });

    const startTime = Date.now();
    const solveRes = await engine.solve();
    const elapsed = Date.now() - startTime;

    // Solver must never throw unhandled exception or leave corrupted state
    assert.ok(solveRes !== null && typeof solveRes === "object", "Solve returns a valid result object");
    assert.ok(typeof solveRes.placed === "number", "Placed count is a valid number");
    assert.ok(elapsed <= budgetMs + 250, `Elapsed time (${elapsed}ms) must respect deadline budget (${budgetMs}ms + grace margin)`);
  }
});

// ============================================================================
// ADVERSARIAL SUITE 4: Multi-Seed Monte Carlo Stress Invariant Verification
// ============================================================================

test("M1-ADV-4.1: Monte Carlo 15-Seed Empirical Hard Invariant Preservation", async () => {
  // Run 15 distinct seeds on a multi-class configuration to stress randomized branch exploration
  const classes = ["10A1", "10A2", "10A3"];
  const teachers = ["GV_1", "GV_2", "GV_3", "GV_4", "GV_5"];
  const subjects = [
    { ten: "M1", khoi: "10", sotiet: 4, gioihan: 2 },
    { ten: "M2", khoi: "10", sotiet: 4, gioihan: 2 },
    { ten: "M3", khoi: "10", sotiet: 4, gioihan: 2 },
    { ten: "M4", khoi: "10", sotiet: 4, gioihan: 2 },
    { ten: "M5", khoi: "10", sotiet: 4, gioihan: 2 }
  ];

  const pccm = {};
  const pccmTiet = {};
  classes.forEach(c => {
    subjects.forEach((s, i) => {
      pccm[`${c}|${s.ten}`] = teachers[i];
      pccmTiet[`${c}|${s.ten}`] = 4;
    });
  });

  const baseData = makeStressData({ classes, subjects, teachers, pccm, pccmTiet });

  for (let seed = 1; seed <= 15; seed++) {
    const engine = new FetTimetableEngine(JSON.parse(JSON.stringify(baseData)), {
      seed: seed * 1000 + 7,
      timeBudgetMs: 3000,
      uiBreathingMs: 0
    });

    const res = await engine.solve();
    assert.equal(res.ok, true, `Seed ${seed}: Solve must succeed`);
    assert.equal(res.unassigned, 0, `Seed ${seed}: unassigned === 0`);

    const m = engine.evaluateMetrics();
    assert.equal(m.unplacedCount, 0, `Seed ${seed}: unplacedCount === 0`);
    assert.equal(m.soBuoiTrong2, 0, `Seed ${seed}: soBuoiTrong2 === 0`);
    assert.equal(engine.countTotalStudentHoles(), 0, `Seed ${seed}: countTotalStudentHoles === 0`);
  }
});

// ============================================================================
// ADVERSARIAL SUITE 5: Full School Scale Verification (75 classes / 2,202 slots)
// ============================================================================

test("M1-ADV-5.1: Real-World 75-Class Full School Hard Invariant Verification", async () => {
  assert.ok(fs.existsSync(DEFAULT_SCHOOL_PATH), "Default school fixture exists");
  const data = JSON.parse(fs.readFileSync(DEFAULT_SCHOOL_PATH, "utf8"));

  const engine = new FetTimetableEngine(data, { seed: 28183, timeBudgetMs: 25000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();

  assert.equal(solveRes.ok, true, "75-class solve must succeed");
  assert.equal(solveRes.unassigned, 0, "All 1,650 activities placed (unassigned === 0)");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0, "Hard invariant: unplacedCount === 0");
  assert.equal(m.soBuoiTrong2, 0, "Hard invariant: soBuoiTrong2 === 0");
  assert.equal(engine.countTotalStudentHoles(), 0, "Hard invariant: countTotalStudentHoles === 0");
});
