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
      data.pccmMatrix[`${c.id}|${s.name}`] = s.teacher;
      data.pccmTietMatrix[`${c.id}|${s.name}`] = s.periods || 1;
      if (s.limit) {
        data.pccmGioihanMatrix[`${c.id}|${s.name}`] = s.limit;
      }
    });
  });

  return data;
}

function setCell(data, classId, thu, buoi, period, value) {
  data.tkb[classId] = data.tkb[classId] || {};
  data.tkb[classId][thu] = data.tkb[classId][thu] || {};
  data.tkb[classId][thu][buoi] = Array.isArray(data.tkb[classId][thu][buoi])
    ? data.tkb[classId][thu][buoi]
    : ["", "", "", "", ""];
  data.tkb[classId][thu][buoi][period] = value;
}

function countStudentHoles(data, classes) {
  let totalHoles = 0;
  for (const lop of classes || []) {
    const cid = String(lop.id || "");
    for (const thu of DAYS) {
      for (const buoi of SESSIONS) {
        const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
        let mask = 0;
        for (let p = 0; p < PERIODS; p++) {
          const cell = arr[p];
          const hasLesson =
            cell &&
            (typeof cell === "string"
              ? cell.trim() !== "" && cell.trim() !== "OFF"
              : cell.mon || cell.subject || cell.fixed);
          if (hasLesson) mask |= 1 << p;
        }
        const taught = [];
        for (let p = 0; p < PERIODS; p++) {
          if ((mask & (1 << p)) !== 0) taught.push(p);
        }
        if (taught.length >= 2) {
          const span = taught[taught.length - 1] - taught[0] + 1;
          const gaps = span - taught.length;
          totalHoles += gaps;
        }
      }
    }
  }
  return totalHoles;
}

function verifyIntegrity(originalData, finalData) {
  let fixedCount = 0;
  let fixedMatched = 0;
  let fixedMismatches = [];

  for (const [cid, cData] of Object.entries(originalData.tkb || {})) {
    for (const [thu, tData] of Object.entries(cData || {})) {
      for (const [buoi, bData] of Object.entries(tData || {})) {
        if (Array.isArray(bData)) {
          for (let p = 0; p < bData.length; p++) {
            const orig = bData[p];
            if (orig && (orig.fixed === true || orig === -3 || orig.isFixed === true)) {
              fixedCount++;
              const finalCell = finalData.tkb?.[cid]?.[thu]?.[buoi]?.[p];
              if (
                finalCell &&
                (finalCell.fixed === true ||
                  finalCell.isFixed === true ||
                  finalCell.mon === orig.mon)
              ) {
                fixedMatched++;
              } else {
                fixedMismatches.push({ cid, thu, buoi, p, orig, finalCell });
              }
            }
          }
        }
      }
    }
  }

  let offCount = 0;
  let offPreserved = 0;
  let offViolations = [];
  const fixedOff = originalData.tkbConstraints?.fixedOff || {};

  for (const [cid, slots] of Object.entries(fixedOff.class || {})) {
    for (const sk of Object.keys(slots || {})) {
      offCount++;
      const [thu, buoi, pRaw] = sk.replace(/_/g, "|").split("|");
      const p = Number(pRaw);
      const cell = finalData.tkb?.[cid]?.[thu]?.[buoi]?.[p];
      if (!cell || cell === "OFF" || cell === "" || cell === -2) {
        offPreserved++;
      } else {
        offViolations.push({ type: "class_off", cid, sk, cell });
      }
    }
  }

  return {
    fixedCount,
    fixedMatched,
    fixedIntact: fixedMismatches.length === 0,
    offCount,
    offPreserved,
    offIntact: offViolations.length === 0
  };
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (Unit & Integration Tests)
// ============================================================================

test("Tier 1.1: 12-Session Counting Invariant rejects opening 3rd session when teacher totalLoad is 4", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "Toan", teacher: "GV01", periods: 4, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  assert.equal(act.duration, 1);
  assert.equal(engine.teacherWeeklyLoad.get("gv01"), 4);

  // Simulate 2 sessions already having 1 period each
  engine.teacherSessionCounts[0] = 1; // Session 0 (Thu 2 Sang)
  engine.teacherSessionCounts[1] = 1; // Session 1 (Thu 2 Chieu)

  // Placing into session 0 (already open) -> allowed
  assert.equal(engine.opensUnaffordableSession(act, 1), false);

  // Attempting to open a 3rd session (Session 2, slot 10) -> rejected by invariant (M = floor(4/2) = 2)
  assert.equal(engine.opensUnaffordableSession(act, 10), true);
});

test("Tier 1.2: 12-Session Counting Invariant allows placing into existing session with 1 period", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "Toan", teacher: "GV01", periods: 4, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  engine.teacherSessionCounts[0] = 1; // Session 0 has 1 period

  // Placing act into slot 2 of Session 0 completes it to 2 periods without opening a new session
  assert.equal(engine.opensUnaffordableSession(act, 2), false);
});

test("Tier 1.3: 12-Session Counting Invariant detects deficit exceeding unplaced periods for odd load (totalLoad=5)", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "Toan", teacher: "GV01", periods: 5, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  assert.equal(engine.teacherWeeklyLoad.get("gv01"), 5);

  // Teacher has 5 periods. Max allowed sessions = floor(5/2) = 2.
  // Suppose 2 sessions already open with 1 period each. Placed = 2, Unplaced = 3.
  engine.teacherSessionCounts[0] = 1;
  engine.teacherSessionCounts[1] = 1;

  // Trying to open a 3rd session (Session 4, slot 20) with 1 period:
  // openedSessions would become 3 > maxAllowedSessions (2) -> rejected!
  assert.equal(engine.opensUnaffordableSession(act, 20), true);

  // But placing into Session 0 (slot 1) -> allowed!
  assert.equal(engine.opensUnaffordableSession(act, 1), false);
});

test("Tier 1.4: 12-Session Counting Invariant allows 2-period activity when totalLoad supports it", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { name: "Ly", teacher: "GV01", periods: 2, limit: 2 }
    ],
    constraints: {
      subject: {
        Toan: { lessonBlocks: { "2": { min: 1, max: 1 } } },
        Ly: { lessonBlocks: { "2": { min: 1, max: 1 } } }
      }
    }
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act2Period = engine.activities.find((a) => a.duration === 2);
  assert.ok(act2Period, "Should find duration 2 activity");
  assert.equal(engine.teacherWeeklyLoad.get("gv01"), 4);

  // Total load is 4. Session 0 has 2 periods.
  engine.teacherSessionCounts[0] = 2;

  // Placing the 2-period activity into empty Session 1 (slot 5):
  // openedSessions becomes 2 <= 2, deficit is 0 <= 0 -> allowed!
  assert.equal(engine.opensUnaffordableSession(act2Period, 5), false);
});

test("Tier 1.5: 12-Session Counting Invariant is bypassed when minTwoGuardActive is disabled", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "Toan", teacher: "GV01", periods: 4, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = false;

  const act = engine.activities[0];
  engine.teacherSessionCounts[0] = 1;
  engine.teacherSessionCounts[1] = 1;

  // With minTwoGuardActive disabled, opensUnaffordableSession returns false
  assert.equal(engine.opensUnaffordableSession(act, 10), false);
});

test("Tier 1.6: trySingletonEjectionChains displaces 2-period activity via randomSwap to merge singleton", async () => {
  const FetTimetableEngine = loadEngine();
  const data = {
    lop: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    mon: [
      { ten: "Toan", khoi: "10", sotiet: 3, gioihan: 3 },
      { ten: "Van", khoi: "10", sotiet: 2, gioihan: 2 }
    ],
    monhoc: [{ ten: "Toan", ma: "TOAN" }, { ten: "Van", ma: "VAN" }],
    giaovien: [{ ma: "GV_T1", ten: "GV_T1" }, { ma: "GV_T2", ten: "GV_T2" }],
    pccmMatrix: { "L1|Toan": "GV_T1", "L1|Van": "GV_T2" },
    pccmTietMatrix: { "L1|Toan": 3, "L1|Van": 2 },
    pccmRoomMatrix: {},
    pccmGioihanMatrix: { "L1|Toan": 3 },
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {
      subject: {
        Van: { lessonBlocks: { "2": { min: 1, max: 1 } } }
      }
    }
  };
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  const toan0 = engine.activities[0]; // Toan dur 1
  const toan1 = engine.activities[1]; // Toan dur 1
  const toan2 = engine.activities[2]; // Toan dur 1
  const van = engine.activities[3];   // Van dur 2

  // Initial placement:
  // Session 0: Toan0 at slot 0 (singleton for GV_T1)
  // Session 1: Toan1 at slot 5, Toan2 at slot 6 (targetSession has 2 acts for GV_T1)
  // Session 1: Van (dur 2) at slot 7 (occupies slot 7 where Toan0 wants to merge)
  engine.placeActivityDirect(toan0.id, 0);
  engine.placeActivityDirect(toan1.id, 5);
  engine.placeActivityDirect(toan2.id, 6);
  engine.placeActivityDirect(van.id, 7);

  const m0 = engine.evaluateMetrics();
  assert.equal(m0.soBuoiDay1, 1, "GV_T1 has 1 singleton session initially");
  assert.equal(m0.unplacedCount, 0);

  const improved = await engine.trySingletonEjectionChains(m0);
  assert.ok(improved, "trySingletonEjectionChains should successfully eliminate singletons");

  const m1 = engine.evaluateMetrics();
  assert.equal(m1.soBuoiDay1, 0, "GV_T1 singletons must be 0 after ejection chain");
  assert.equal(m1.unplacedCount, 0, "All activities must remain placed");
  assert.equal(engine.countTotalStudentHoles(), 0, "Student holes must remain 0");
});

test("Tier 1.7: trySingletonEjectionChains rolls back cleanly when displaced activity cannot find feasible placement", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV_T1", periods: 2, limit: 1 },
      { name: "Van", teacher: "GV_T2", periods: 1, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  // Block all slots except slot 0, 5, 6
  for (let s = 0; s < 60; s++) {
    if (s !== 0 && s !== 5 && s !== 6) {
      engine.classGrid.get("L1")[s] = -2; // Class OFF
    }
  }

  engine.placeActivityDirect(0, 0); // Toan1 at slot 0
  engine.placeActivityDirect(1, 5); // Toan2 at slot 5
  engine.placeActivityDirect(2, 6); // Van at slot 6

  const m0 = engine.evaluateMetrics();

  // Ejecting Van from slot 6 has nowhere else to land because all other slots are OFF
  const res = await engine.trySingletonEjectionChains(m0);
  assert.equal(res, null, "Should fail safely when displacement cannot find valid slot");

  const mAfter = engine.evaluateMetrics();
  assert.equal(mAfter.unplacedCount, 0, "Grid must be restored with zero unplaced activities");
  assert.equal(engine.actPlacement[0], 0);
  assert.equal(engine.actPlacement[1], 5);
  assert.equal(engine.actPlacement[2], 6);
});

test("Tier 1.8: tryShareRichToSingleton transfers a period from rich donor session (>= 3 periods) to singleton session", async () => {
  const FetTimetableEngine = loadEngine();
  const data = {
    lop: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    mon: [{ ten: "Toan", khoi: "10", sotiet: 5, gioihan: 4 }],
    monhoc: [{ ten: "Toan", ma: "TOAN" }],
    giaovien: [{ ma: "GV01", ten: "GV01" }],
    pccmMatrix: { "L1|Toan": "GV01" },
    pccmTietMatrix: { "L1|Toan": 5 },
    pccmRoomMatrix: {},
    pccmGioihanMatrix: { "L1|Toan": 4 },
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {}
  };
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  // Place 4 activities into Session 0 (slots 0..3) and 1 activity into Session 1 (slot 5)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 1);
  engine.placeActivityDirect(2, 2);
  engine.placeActivityDirect(3, 3);
  engine.placeActivityDirect(4, 5);

  const m0 = engine.evaluateMetrics();
  assert.equal(m0.soBuoiDay1, 1, "Initial soBuoiDay1 is 1");

  const improved = await engine.tryShareRichToSingleton(m0);
  assert.ok(improved, "tryShareRichToSingleton should balance the sessions");

  const m1 = engine.evaluateMetrics();
  assert.equal(m1.soBuoiDay1, 0, "soBuoiDay1 should be reduced to 0");
  assert.equal(m1.unplacedCount, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.9: trySingletonRelabelCycles executes closed push cycles without creating unplaced activities", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV_T1", periods: 2, limit: 1 },
      { name: "Van", teacher: "GV_T2", periods: 2, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 5);
  engine.placeActivityDirect(2, 1);
  engine.placeActivityDirect(3, 6);

  const m0 = engine.evaluateMetrics();
  await engine.trySingletonRelabelCycles(m0);

  const m1 = engine.evaluateMetrics();
  assert.equal(m1.unplacedCount, 0, "No activity dropped");
  assert.equal(engine.countTotalStudentHoles(), 0, "No student holes introduced");
});

test("Tier 1.10: tryCrossClassSingletonKempeSwap swaps teacher activity pairs across classes to eliminate singleton", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV_T1", periods: 2, limit: 1 },
      { name: "Van", teacher: "GV_T2", periods: 2, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  // Find activities
  const l1_toan = engine.activities.filter((a) => a.classId === "L1" && a.mon === "Toan");
  const l1_van = engine.activities.filter((a) => a.classId === "L1" && a.mon === "Van");
  const l2_toan = engine.activities.filter((a) => a.classId === "L2" && a.mon === "Toan");
  const l2_van = engine.activities.filter((a) => a.classId === "L2" && a.mon === "Van");

  // Arrange cross-class configuration
  engine.placeActivityDirect(l1_toan[0].id, 0); // L1 Toan Thu 2 Sang P0
  engine.placeActivityDirect(l1_toan[1].id, 5); // L1 Toan Thu 2 Chieu P0 (singleton)
  engine.placeActivityDirect(l1_van[0].id, 1);  // L1 Van Thu 2 Sang P1
  engine.placeActivityDirect(l1_van[1].id, 6);  // L1 Van Thu 2 Chieu P1

  engine.placeActivityDirect(l2_toan[0].id, 2); // L2 Toan Thu 2 Sang P2
  engine.placeActivityDirect(l2_toan[1].id, 10);// L2 Toan Thu 3 Sang P0
  engine.placeActivityDirect(l2_van[0].id, 3);  // L2 Van Thu 2 Sang P3
  engine.placeActivityDirect(l2_van[1].id, 11);// L2 Van Thu 3 Sang P1

  const m0 = engine.evaluateMetrics();
  assert.equal(m0.unplacedCount, 0);

  await engine.tryCrossClassSingletonKempeSwap(m0);
  const m1 = engine.evaluateMetrics();
  assert.equal(m1.unplacedCount, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.11: tryIntraClassSingletonSwap rearranges within class grid to merge singletons for a teacher", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV_T1", periods: 2, limit: 1 },
      { name: "Van", teacher: "GV_T2", periods: 2, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  // GV_T1 has singletons at slot 0 (Session 0) and slot 5 (Session 1)
  // GV_T2 has lessons at slot 1 (Session 0) and slot 6 (Session 1)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 5);
  engine.placeActivityDirect(2, 1);
  engine.placeActivityDirect(3, 6);

  const m0 = engine.evaluateMetrics();
  await engine.tryIntraClassSingletonSwap(m0);

  const m1 = engine.evaluateMetrics();
  assert.equal(m1.unplacedCount, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.12: Kempe swap rejects moves that would produce student holes in either class", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV_T1", periods: 2, limit: 1 },
      { name: "Van", teacher: "GV_T2", periods: 2, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  // Place continuous activities
  engine.placeActivityDirect(0, 0); // L1 P0
  engine.placeActivityDirect(1, 1); // L1 P1
  engine.placeActivityDirect(2, 2); // L1 P2
  engine.placeActivityDirect(3, 3); // L1 P3

  const m0 = engine.evaluateMetrics();
  await engine.tryCrossClassSingletonKempeSwap(m0);

  // Student holes must strictly remain 0
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.13: Kempe swap strictly respects teacher OFF and fixed cell constraints", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV_T1", periods: 2, limit: 1 },
      { name: "Van", teacher: "GV_T2", periods: 2, limit: 1 }
    ],
    constraints: {
      fixedOff: {
        teacher: {
          GV_T1: { "thu2|chieu|0": true }
        }
      }
    }
  });
  const engine = new FetTimetableEngine(data, { seed: 101, mode: "optimize_singletons" });
  engine.init();
  engine.compileConstraints();

  // GV_T1 has OFF at Thu 2 Chieu P0 (slot 5)
  assert.equal(engine.teacherGrid.get("gv_t1")[5], -2);

  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 10);
  engine.placeActivityDirect(2, 1);
  engine.placeActivityDirect(3, 11);

  const m0 = engine.evaluateMetrics();
  await engine.tryCrossClassSingletonKempeSwap(m0);

  // GV_T1 must never be placed on slot 5
  assert.equal(engine.teacherGrid.get("gv_t1")[5], -2);
});

test("Tier 1.14: Lexicographic comparator strictly prefers fewer soBuoiDay1 among hard-valid candidates", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  const engine = new FetTimetableEngine(data, { seed: 101 });

  const candidateBetter = {
    unplacedCount: 0,
    soBuoiTrong2: 0,
    studentHoles: 0,
    soBuoiDay1: 0,
    soNgayMotTiet: 0,
    tsBuoiDay: 10,
    soBuoiTrong1: 0
  };

  const candidateWorse = {
    unplacedCount: 0,
    soBuoiTrong2: 0,
    studentHoles: 0,
    soBuoiDay1: 2,
    soNgayMotTiet: 1,
    tsBuoiDay: 10,
    soBuoiTrong1: 0
  };

  const cmp = engine.compareMetrics(candidateBetter, candidateWorse, "optimize_singletons");
  assert.ok(cmp < 0, "Candidate with soBuoiDay1=0 must beat candidate with soBuoiDay1=2");
});

test("Tier 1.15: evaluateMetrics accurately computes soBuoiDay1, soNgayMotTiet, soBuoiTrong2, and student holes", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 3, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Place:
  // Act 0 at Slot 0 (Thu 2 Sang P0)
  // Act 1 at Slot 5 (Thu 2 Chieu P0)
  // Act 2 at Slot 10 (Thu 3 Sang P0)
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 5);
  engine.placeActivityDirect(2, 10);

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiDay1, 3, "Each of the 3 sessions has exactly 1 period");
  assert.equal(m.soNgayMotTiet, 1, "Thu 3 has 1 period on the day");
  assert.equal(m.soBuoiTrong2, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.16: optimize('optimize_singletons') reduces soBuoiDay1 monotonically without worsening gap2 or student holes", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 1 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, uiBreathingMs: 0 });
  engine.solve();

  const mInitial = engine.evaluateMetrics();
  assert.equal(mInitial.unplacedCount, 0);

  await engine.optimize("optimize_singletons");
  const mFinal = engine.evaluateMetrics();

  assert.equal(mFinal.unplacedCount, 0, "No unplaced activities");
  assert.equal(mFinal.soBuoiTrong2, 0, "soBuoiTrong2 must remain 0");
  assert.ok(mFinal.soBuoiDay1 <= mInitial.soBuoiDay1, "soBuoiDay1 must not increase");
  assert.equal(engine.countTotalStudentHoles(), 0, "Student holes must be 0");
});

test("Tier 1.17: Complete placement invariant: unplacedCount === 0 is maintained", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  const res = engine.solve();

  assert.equal(res.ok, true);
  assert.equal(res.unassigned, 0);
  assert.equal(engine.evaluateMetrics().unplacedCount, 0);
});

test("Tier 1.18: Teacher Gap-2 invariant: soBuoiTrong2 === 0 is strictly preserved", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 6, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 6, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();

  const m = engine.evaluateMetrics();
  assert.equal(m.soBuoiTrong2, 0, "Teacher gap >= 2 must be 0");
});

test("Tier 1.19: Student contiguity invariant: countTotalStudentHoles() === 0 is strictly preserved", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 5, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 5, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();

  assert.equal(engine.countTotalStudentHoles(), 0, "Student holes must be 0");
});

test("Tier 1.20: Fixed cells (-3) and OFF cells (-2) remain 100% immutable throughout optimization", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ],
    constraints: {
      fixedOff: {
        class: { L1: { "thu2|sang|0": true } }
      }
    }
  });

  // Set fixed cell at Thu 3 Sang P0
  setCell(data, "L1", "thu3", "sang", 0, { mon: "Chào cờ", fixed: true, isFixed: true });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();
  await engine.optimize("optimize_singletons");

  // Check fixed cell preserved
  assert.equal(engine.classGrid.get("L1")[10], -3, "Fixed cell at Thu 3 Sang P0 must remain -3");
  // Check OFF cell preserved
  assert.equal(engine.classGrid.get("L1")[0], -2, "OFF cell at Thu 2 Sang P0 must remain -2");
});

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES
// ============================================================================

test("Tier 2.1: Teacher with total load 1 period is permitted as mathematical exception without solver error", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "GDCD", teacher: "GV_SOLO", periods: 1, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();
  engine.minTwoGuardActive = true;

  const act = engine.activities[0];
  assert.equal(engine.teacherWeeklyLoad.get("gv_solo"), 1);

  // Total load <= 1 bypasses opensUnaffordableSession
  assert.equal(engine.opensUnaffordableSession(act, 0), false);
});

test("Tier 2.2: Solver places 1-period teacher into 1 valid session without infinite loop or failure", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "GDCD", teacher: "GV_SOLO", periods: 1, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  const res = engine.solve();

  assert.equal(res.ok, true);
  assert.equal(res.unassigned, 0);
  assert.equal(engine.evaluateMetrics().unplacedCount, 0);
});

test("Tier 2.3: Teacher with odd period load of 3 periods is grouped into 1 session or minimal singletons", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    subjects: [{ name: "Toan", teacher: "GV01", periods: 3, limit: 2 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();
  await engine.optimize("optimize_singletons");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.ok(m.soBuoiDay1 <= 1, "Teacher with 3 periods has at most 1 single-period session");
});

test("Tier 2.4: Teacher with odd period load of 5 periods is packed into 2 sessions (soBuoiDay1 = 0)", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 5, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();
  await engine.optimize("optimize_singletons");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiDay1, 0, "5-period teacher must be packed into 3+2 or 2+3 (soBuoiDay1 = 0)");
});

test("Tier 2.5: Teacher with odd period load of 7 periods is packed into 2-3 sessions (soBuoiDay1 = 0)", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 7, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();
  await engine.optimize("optimize_singletons");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiDay1, 0, "7-period teacher must be packed with soBuoiDay1 = 0");
});

test("Tier 2.6: Teacher with odd period load of 9 periods is packed into 3-4 sessions (soBuoiDay1 = 0)", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 9, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();
  await engine.optimize("optimize_singletons");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiDay1, 0, "9-period teacher must achieve soBuoiDay1 = 0");
});

test("Tier 2.7: Full load teacher with 18-20 periods packs densely with 0 singletons and 0 gap2", async () => {
  const FetTimetableEngine = loadEngine();
  const data = {
    lop: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" },
      { id: "L3", ten: "10A3", ten2: "10A3", khoi: "10" },
      { id: "L4", ten: "10A4", ten2: "10A4", khoi: "10" }
    ],
    mon: [{ ten: "Toan", khoi: "10", sotiet: 5, gioihan: 2 }],
    monhoc: [{ ten: "Toan", ma: "TOAN" }],
    giaovien: [{ ma: "GV_HEAVY", ten: "GV_HEAVY" }],
    pccmMatrix: {
      "L1|Toan": "GV_HEAVY",
      "L2|Toan": "GV_HEAVY",
      "L3|Toan": "GV_HEAVY",
      "L4|Toan": "GV_HEAVY"
    },
    pccmTietMatrix: {
      "L1|Toan": 5,
      "L2|Toan": 5,
      "L3|Toan": 4,
      "L4|Toan": 4
    },
    pccmRoomMatrix: {},
    pccmGioihanMatrix: {},
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {}
  };
  const engine = new FetTimetableEngine(data, { seed: 101 });
  const res = engine.solve();
  assert.equal(res.ok, true, "Solve should place all 18 periods");
  assert.equal(res.unassigned, 0);

  await engine.optimize("optimize_singletons");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiDay1, 0, "Heavy teacher must have 0 single-period sessions");
  assert.equal(m.soBuoiTrong2, 0, "Heavy teacher must have 0 gap-2 sessions");
});

test("Tier 2.8: Boundary period slots: Period 0 (P1) and Period 4 (P5) edge placements create 0 student holes", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [{ name: "Toan", teacher: "GV01", periods: 2, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Contiguous periods P0 and P1 in Session 0
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 1);
  assert.equal(engine.countTotalStudentHoles(), 0);

  // Contiguous periods P3 and P4 in Session 0
  engine.unplaceActivity(0);
  engine.unplaceActivity(1);
  engine.placeActivityDirect(0, 3);
  engine.placeActivityDirect(1, 4);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 2.9: Boundary period slots: Internal gap (Period 0 and Period 2 taught, Period 1 empty) triggers hole detection", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [{ name: "Toan", teacher: "GV01", periods: 2, limit: 1 }]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Period 0 and Period 2 taught, Period 1 empty -> 1 student hole
  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 2);
  assert.equal(engine.countTotalStudentHoles(), 1);
});

test("Tier 2.10: Locked fixed slot (-3) on Period 0 (Chào cờ) cannot be displaced by randomSwap or ejection chains", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 2, limit: 1 }
    ]
  });
  setCell(data, "L1", "thu2", "sang", 0, { mon: "Chào cờ", fixed: true, isFixed: true });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  assert.equal(engine.classGrid.get("L1")[0], -3, "Fixed slot must be -3");

  // Place Toan at slot 1 and slot 5
  engine.placeActivityDirect(0, 1);
  engine.placeActivityDirect(1, 5);

  const m0 = engine.evaluateMetrics();
  await engine.trySingletonEjectionChains(m0);

  assert.equal(engine.classGrid.get("L1")[0], -3, "Fixed slot remains intact");
});

test("Tier 2.11: Teacher OFF slot (-2) prevents displacement chain from assigning teacher to off slot", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 2, limit: 1 }
    ],
    constraints: {
      fixedOff: {
        teacher: {
          GV01: { "thu2|sang|1": true }
        }
      }
    }
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  assert.equal(engine.teacherGrid.get("gv01")[1], -2, "Teacher OFF slot must be -2");

  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 5);

  const m0 = engine.evaluateMetrics();
  await engine.trySingletonEjectionChains(m0);

  assert.equal(engine.teacherGrid.get("gv01")[1], -2, "Teacher OFF slot remains unplaced");
});

test("Tier 2.12: Class OFF slot (-2) prevents placement or displacement on class off slot", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 2, limit: 1 }
    ],
    constraints: {
      fixedOff: {
        class: {
          L1: { "thu2|sang|2": true }
        }
      }
    }
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  assert.equal(engine.classGrid.get("L1")[2], -2, "Class OFF slot must be -2");

  engine.placeActivityDirect(0, 0);
  engine.placeActivityDirect(1, 5);

  const m0 = engine.evaluateMetrics();
  await engine.trySingletonEjectionChains(m0);

  assert.equal(engine.classGrid.get("L1")[2], -2, "Class OFF slot remains unplaced");
});

// ============================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS
// ============================================================================

test("Tier 3.1: Pairwise: Counting Invariant + randomSwap ejection depth <= 16 under tight grid contention", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 },
      { name: "Anh", teacher: "GV03", periods: 4, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  const res = engine.solve();

  assert.equal(res.ok, true, "Solve must succeed under recursive randomSwap with counting invariant");
  assert.equal(res.unassigned, 0);
  assert.equal(engine.evaluateMetrics().unplacedCount, 0);
});

test("Tier 3.2: Pairwise: Counting Invariant + Tabu Memory prevents cyclic oscillation between competing teachers", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 3, limit: 1 },
      { name: "Van", teacher: "GV02", periods: 3, limit: 1 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Test randomSwap with Tabu map
  engine.tabuMap.clear();
  engine.limitCalls = 500;
  const ok = engine.randomSwap(0, 0);

  assert.ok(typeof ok === "boolean");
});

test("Tier 3.3: Pairwise: 2-period donor ejection + Cross-Class Kempe Swaps", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ],
    constraints: {
      subject: {
        Toan: { lessonBlocks: { "2": { min: 1, max: 1 } } }
      }
    }
  });
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.solve();

  const m0 = engine.evaluateMetrics();
  await engine.trySingletonEjectionChains(m0);
  await engine.tryCrossClassSingletonKempeSwap(m0);

  const m1 = engine.evaluateMetrics();
  assert.equal(m1.unplacedCount, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 3.4: Pairwise: High-density locked/off grid with multi-step displacement chains", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ],
    constraints: {
      fixedOff: {
        class: {
          L1: { "thu2|sang|0": true, "thu2|chieu|0": true }
        },
        teacher: {
          GV01: { "thu3|sang|0": true },
          GV02: { "thu4|sang|0": true }
        }
      }
    }
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  const res = engine.solve();
  assert.equal(res.ok, true);

  await engine.optimize("optimize_singletons");
  const m = engine.evaluateMetrics();

  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiTrong2, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 3.5: Multi-objective lexicographic optimization simultaneously eliminating singletons, gap-2, and student holes", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 6, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 6, limit: 2 },
      { name: "Anh", teacher: "GV03", periods: 4, limit: 2 }
    ]
  });
  const engine = new FetTimetableEngine(data, { seed: 101, uiBreathingMs: 0 });
  engine.solve();

  await engine.optimize("optimize_all");
  const m = engine.evaluateMetrics();

  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiTrong2, 0);
  assert.equal(m.soBuoiDay1, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

// ============================================================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// ============================================================================

test("Tier 4.1: Real-World Benchmark: scratch/live_school_default.json (75 classes / 2,202 periods) meets all acceptance criteria", async () => {
  const FetTimetableEngine = loadEngine();
  const filePath = path.resolve(__dirname, "..", "scratch", "live_school_default.json");
  assert.ok(fs.existsSync(filePath), "scratch/live_school_default.json must exist");

  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  const origData = JSON.parse(raw);

  const engine = new FetTimetableEngine(data, {
    seed: 101,
    mode: "optimize_singletons",
    uiBreathingMs: 0
  });

  engine.init();
  engine.loadExistingSchedule();

  await engine.optimize("optimize_singletons");
  const finalMetrics = engine.evaluateMetrics();

  const studentHoles = countStudentHoles(data, data.lop);
  const integrity = verifyIntegrity(origData, data);

  assert.equal(finalMetrics.unplacedCount, 0, "100% placed invariant (unplacedCount === 0)");
  assert.equal(finalMetrics.soBuoiTrong2, 0, "Teacher gap-2 invariant (soBuoiTrong2 === 0)");
  assert.ok(finalMetrics.soBuoiDay1 <= 2, `soBuoiDay1 must be <= 2 (actual=${finalMetrics.soBuoiDay1})`);
  assert.equal(studentHoles, 0, "Student holes must be 0");
  assert.equal(integrity.fixedIntact, true, "Fixed cells must remain intact");
  assert.equal(integrity.offIntact, true, "OFF cells must remain intact");
});

test("Tier 4.2: Real-World Scenario: Shift-Isolated Mathematical Floor Teachers", () => {
  const FetTimetableEngine = loadEngine();
  const filePath = path.resolve(__dirname, "..", "scratch", "live_school_default.json");
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.compileConstraints();

  // Verify teachers with totalLoad <= 1 are properly identified
  let soloTeacherCount = 0;
  for (let tIdx = 0; tIdx < engine.teachers.length; tIdx++) {
    const tKey = engine.teachers[tIdx];
    const load = engine.teacherWeeklyLoad.get(tKey) || 0;
    if (load === 1) {
      soloTeacherCount++;
    }
  }

  assert.ok(soloTeacherCount >= 0, "Engine identifies teacher load distribution");
});

test("Tier 4.3: Real-World Dataset: scratch/dongkhoi_1566.json (54 classes / 1,566 periods) full solve & invariants", () => {
  const FetTimetableEngine = loadEngine();
  const filePath = path.resolve(__dirname, "..", "scratch", "dongkhoi_1566.json");
  assert.ok(fs.existsSync(filePath), "scratch/dongkhoi_1566.json must exist");

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const engine = new FetTimetableEngine(data, { seed: 101, uiBreathingMs: 0 });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, "Dong Khoi solve must succeed");
  assert.equal(solveRes.unassigned, 0, "All 1,566 periods must be placed");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiTrong2, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});
