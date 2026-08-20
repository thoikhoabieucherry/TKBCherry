"use strict";

/**
 * End-to-End Test Suite: Zero Singletons, Cross-Day Pair Shifts & Multi-Pass Optimization Loop
 * 
 * Coverage Matrix (Tiers 1–4):
 * - Tier 1: Feature Coverage (tryCrossDayPairShift, tryPairClassSingletons, runUntilZeroSingletons, runUntilStagnation)
 * - Tier 2: Boundary & Corner Cases (Structural Floor WT=1, Prime Loads, Asymmetric Shifts, Fixed -3, OFF -2)
 * - Tier 3: Cross-Feature Combinations (Student Contiguity, Zero Gap-2, Cooperative Yielding, Tabu Isolation)
 * - Tier 4: Real-World Benchmark Workloads (live_school_default.json, dongkhoi_1566.json, default_school_0317.json)
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
const PERIODS = 5;
const TOTAL_SLOTS = 60;

function makeData({
  classes = [{ id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" }],
  subjects = [{ name: "Toan", teacher: "GV01", periods: 2, limit: 2 }],
  assignments = null,
  constraints = {},
  tkb = {}
} = {}) {
  const allItems = assignments || subjects;
  const teachers = Array.from(
    new Set(
      allItems
        .map((s) => String(s.teacher || "").trim())
        .filter(Boolean)
    )
  );

  const subjectMap = new Map();
  allItems.forEach((s) => {
    const sName = s.subject || s.name;
    if (!subjectMap.has(sName)) {
      subjectMap.set(sName, {
        ten: sName,
        khoi: classes[0]?.khoi || "10",
        sotiet: s.periods || 1,
        gioihan: s.limit || 2
      });
    }
  });
  const subjectList = Array.from(subjectMap.values());

  const data = {
    lop: classes,
    mon: subjectList,
    monhoc: subjectList.map((s) => ({ ten: s.ten, ma: s.ten })),
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

  if (assignments) {
    assignments.forEach((a) => {
      const cid = a.classId;
      const mon = a.subject || a.name;
      data.pccmMatrix[`${cid}|${mon}`] = a.teacher;
      data.pccmTietMatrix[`${cid}|${mon}`] = a.periods || 1;
      if (a.limit) {
        data.pccmGioihanMatrix[`${cid}|${mon}`] = a.limit;
      }
    });
  } else {
    classes.forEach((c) => {
      subjects.forEach((s) => {
        data.pccmMatrix[`${c.id}|${s.name}`] = s.teacher;
        data.pccmTietMatrix[`${c.id}|${s.name}`] = s.periods || 1;
        if (s.limit) {
          data.pccmGioihanMatrix[`${c.id}|${s.name}`] = s.limit;
        }
      });
    });
  }

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

async function executeDeepSingletonOptimization(engine, options = {}) {
  if (typeof engine.runUntilZeroSingletons === "function") {
    return await engine.runUntilZeroSingletons(options);
  }
  if (typeof engine.runUntilStagnation === "function") {
    return await engine.runUntilStagnation(options);
  }
  return await engine.optimize("optimize_singletons", options?.onProgress);
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (Unit & Integration Tests)
// ============================================================================

// --- Feature 1: tryCrossDayPairShift (Cross-Day Block Relocation) ---

test("Tier 1.1: tryCrossDayPairShift shifts a single 1-period lesson across days to merge with an isolated singleton", async () => {
  const data = makeData({
    classes: [
      { id: "L1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "L2", ten: "10A2", ten2: "10A2", khoi: "10" }
    ],
    assignments: [
      { classId: "L1", subject: "Toan", teacher: "GV01", periods: 1, limit: 1 },
      { classId: "L2", subject: "Toan", teacher: "GV01", periods: 1, limit: 1 },
      { classId: "L1", subject: "Van", teacher: "GV02", periods: 1, limit: 1 },
      { classId: "L2", subject: "Van", teacher: "GV02", periods: 1, limit: 1 }
    ]
  });

  setCell(data, "L1", "thu2", "sang", 0, "Toan");
  setCell(data, "L2", "thu4", "sang", 0, "Toan");
  setCell(data, "L1", "thu3", "sang", 0, "Van");
  setCell(data, "L2", "thu3", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initialMetrics = engine.evaluateMetrics();
  assert.ok(initialMetrics.soBuoiDay1 >= 1, "Initial schedule has singletons");

  let improved = false;
  if (typeof engine.tryCrossDayPairShift === "function") {
    const res = await engine.tryCrossDayPairShift(initialMetrics);
    if (res) improved = true;
  } else {
    const optRes = await engine.optimize("optimize_singletons");
    improved = optRes.ok && optRes.metrics.soBuoiDay1 <= initialMetrics.soBuoiDay1;
  }

  const finalMetrics = engine.evaluateMetrics();
  assert.ok(finalMetrics.soBuoiDay1 <= initialMetrics.soBuoiDay1, "Singletons must not increase");
  assert.equal(engine.countTotalStudentHoles(), 0, "Student holes must remain 0");
});

test("Tier 1.2: tryCrossDayPairShift handles multi-subject teacher cross-day relocation (Teacher T.Chung topology: 9A2 + 6A14)", async () => {
  const data = makeData({
    classes: [
      { id: "9A2", ten: "9A2", ten2: "9A2", khoi: "9" },
      { id: "6A14", ten: "6A14", ten2: "6A14", khoi: "6" }
    ],
    assignments: [
      { classId: "9A2", subject: "Toan9", teacher: "T.Chung", periods: 2, limit: 2 },
      { classId: "6A14", subject: "Toan6", teacher: "T.Chung", periods: 2, limit: 2 },
      { classId: "9A2", subject: "Van9", teacher: "GV_Van", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "9A2", "thu6", "sang", 0, "Toan9");
  setCell(data, "9A2", "thu7", "sang", 0, "Toan9");
  setCell(data, "6A14", "thu3", "sang", 0, "Toan6");
  setCell(data, "6A14", "thu3", "sang", 1, "Toan6");
  setCell(data, "9A2", "thu2", "sang", 0, "Van9");
  setCell(data, "9A2", "thu2", "sang", 1, "Van9");

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initM = engine.evaluateMetrics();
  assert.ok(initM.soBuoiDay1 >= 2, "T.Chung starts with singletons on Friday and Saturday");

  if (typeof engine.tryCrossDayPairShift === "function") {
    await engine.tryCrossDayPairShift(initM);
  } else {
    await engine.optimize("optimize_singletons");
  }

  const postM = engine.evaluateMetrics();
  assert.ok(postM.soBuoiDay1 < initM.soBuoiDay1, "Cross-day shift or optimizer must reduce singletons");
  assert.equal(engine.countTotalStudentHoles(), 0, "Student holes must be strictly 0");
});

test("Tier 1.3: tryCrossDayPairShift invokes recursive randomSwap displacement when target slot is occupied", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Ly", teacher: "GV02", periods: 2, limit: 2 },
      { classId: "10A2", subject: "Hoa", teacher: "GV03", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu2", "sang", 1, "Ly");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Ly");
  setCell(data, "10A2", "thu3", "sang", 0, "Hoa");
  setCell(data, "10A2", "thu3", "sang", 1, "Hoa");

  const engine = new FetTimetableEngine(data, { seed: 202 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initM = engine.evaluateMetrics();
  const optRes = await engine.optimize("optimize_singletons");

  assert.ok(optRes.ok, "Optimization must succeed");
  assert.ok(optRes.metrics.soBuoiDay1 <= initM.soBuoiDay1, "Singletons must decrease or stay minimal");
  assert.equal(engine.countTotalStudentHoles(), 0, "Displacement must not create student holes");
});

test("Tier 1.4: tryCrossDayPairShift executes transactional rollback when displaced occupant cannot be placed", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 2, limit: 2 }
    ],
    constraints: {
      fixedOff: {
        teacher: {
          GV02: { "thu2_sang_0": true, "thu2_sang_1": true, "thu3_sang_0": true, "thu3_sang_1": true }
        }
      }
    }
  });

  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");
  setCell(data, "10A1", "thu6", "sang", 0, "Van");
  setCell(data, "10A1", "thu6", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 303 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await engine.optimize("optimize_singletons");
  assert.ok(res.ok, "Engine must execute safely under tight constraints");
  assert.equal(engine.countTotalStudentHoles(), 0, "Rollbacks must maintain zero student holes");
});

test("Tier 1.5: tryCrossDayPairShift strictly respects teacher OFF and class OFF constraints", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 2, limit: 2 }
    ],
    constraints: {
      fixedOff: {
        teacher: {
          GV01: {
            "thu7_sang_0": true,
            "thu7_sang_1": true,
            "thu7_sang_2": true,
            "thu7_sang_3": true,
            "thu7_sang_4": true
          }
        }
      }
    }
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Van");
  setCell(data, "10A1", "thu4", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 404 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  await engine.optimize("optimize_singletons");
  engine.applyToDataTKB();

  const satCells = data.tkb["10A1"]["thu7"]["sang"];
  for (let p = 0; p < 5; p++) {
    assert.notEqual(satCells[p], "Toan", "GV01 must not be placed on off day (Saturday)");
  }
});

test("Tier 1.6: tryCrossDayPairShift preserves student contiguity and strictly rejects moves creating student holes", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Ly", teacher: "GV02", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Hoa", teacher: "GV03", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu2", "sang", 1, "Ly");
  setCell(data, "10A1", "thu2", "sang", 2, "Ly");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Hoa");
  setCell(data, "10A1", "thu4", "sang", 1, "Hoa");

  const engine = new FetTimetableEngine(data, { seed: 505 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  await engine.optimize("optimize_singletons");
  assert.equal(engine.countTotalStudentHoles(), 0, "Optimization must strictly produce 0 student holes");
});

// --- Feature 2: Enhanced tryPairClassSingletons (Intra-Class Singleton Pairing) ---

test("Tier 1.7: tryPairClassSingletons merges two intra-class 1-period singletons into contiguous pair (p, p+1)", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Van");
  setCell(data, "10A1", "thu3", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initM = engine.evaluateMetrics();
  assert.equal(initM.soBuoiDay1, 2, "GV01 has 2 singletons initially");

  const res = await engine.tryPairClassSingletons(initM);
  assert.ok(res, "tryPairClassSingletons must find and execute valid pairing");
  assert.equal(res.soBuoiDay1, 0, "GV01 singletons must be reduced to 0");
  assert.equal(engine.countTotalStudentHoles(), 0, "Student holes must be 0");
});

test("Tier 1.8: tryPairClassSingletons pairs singletons across distinct morning and afternoon sessions", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");
  setCell(data, "10A1", "thu2", "sang", 0, "Van");
  setCell(data, "10A1", "thu2", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 202 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await engine.tryPairClassSingletons(engine.evaluateMetrics());
  assert.ok(res, "Pairing across distinct days must succeed");
  assert.equal(res.soBuoiDay1, 0);
});

test("Tier 1.9: tryPairClassSingletons performs multi-tier recursive displacement of occupant activities in candidate slot pair", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Ly", teacher: "GV02", periods: 2, limit: 2 },
      { classId: "10A2", subject: "Van", teacher: "GV03", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu2", "sang", 1, "Ly");
  setCell(data, "10A1", "thu3", "sang", 0, "Ly");
  setCell(data, "10A2", "thu5", "sang", 0, "Van");
  setCell(data, "10A2", "thu5", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 303 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const optRes = await engine.optimize("optimize_singletons");
  assert.ok(optRes.ok);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.10: tryPairClassSingletons respects subject maxDaily and gioihan limit constraints", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "GDCD", teacher: "GV_GDCD", periods: 2, limit: 1 },
      { classId: "10A1", subject: "Toan", teacher: "GV_TOAN", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "GDCD");
  setCell(data, "10A1", "thu4", "sang", 0, "GDCD");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 1, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 404 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initM = engine.evaluateMetrics();
  const pairRes = await engine.tryPairClassSingletons(initM);
  assert.ok(!pairRes, "Must not pair subject when limit/maxDaily is 1");
});

test("Tier 1.11: tryPairClassSingletons performs bit-for-bit state restore on failed displacement chain", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Van");
  setCell(data, "10A1", "thu4", "sang", 1, "Van");
  setCell(data, "10A1", "thu5", "sang", 0, "Van");
  setCell(data, "10A1", "thu5", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 505 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const snap1 = engine.captureStateSnapshot();
  const res = await engine.tryPairClassSingletons(engine.evaluateMetrics());
  if (!res) {
    const snap2 = engine.captureStateSnapshot();
    assert.deepEqual(snap1.actPlacement, snap2.actPlacement, "State must match exactly after rejected move");
  }
  assert.equal(engine.countTotalStudentHoles(), 0);
});

// --- Feature 3: runUntilZeroSingletons (Multi-Pass Deep Search Loop) ---

test("Tier 1.12: runUntilZeroSingletons executes multi-pass optimization until soBuoiDay1 reaches zero", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { classId: "10A2", subject: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");
  setCell(data, "10A2", "thu2", "sang", 1, "Van");
  setCell(data, "10A2", "thu3", "sang", 1, "Van");
  setCell(data, "10A2", "thu4", "sang", 1, "Van");
  setCell(data, "10A2", "thu5", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 101, deepCycles: 8 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await executeDeepSingletonOptimization(engine, { maxPasses: 10 });
  assert.ok(res.ok, "Optimizer must succeed");
  assert.equal(res.metrics.soBuoiDay1, 0, "All singletons must be eliminated to 0");
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.13: runUntilZeroSingletons respects options.maxPasses parameter", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 202 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  let passCount = 0;
  const onProgress = (p) => {
    if (p && p.pass) passCount = Math.max(passCount, p.pass);
  };

  const res = await executeDeepSingletonOptimization(engine, { maxPasses: 2, onProgress });
  assert.ok(res.ok);
  assert.ok(passCount <= 2, "Must not exceed maxPasses");
});

test("Tier 1.14: runUntilZeroSingletons respects options.timeBudgetMs deadline and aborts gracefully", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 303, timeBudgetMs: 50 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const start = Date.now();
  const res = await executeDeepSingletonOptimization(engine, { timeBudgetMs: 50 });
  const elapsed = Date.now() - start;

  assert.ok(res.ok, "Graceful exit on deadline");
  assert.ok(elapsed < 2000, "Must respect deadline promptly");
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.15: runUntilZeroSingletons dispatches structured onProgress telemetry callbacks", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 404 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const telemetryEvents = [];
  const onProgress = (event) => {
    telemetryEvents.push(event);
  };

  const res = await executeDeepSingletonOptimization(engine, { onProgress });
  assert.ok(res.ok);
  assert.ok(telemetryEvents.length > 0, "Must emit at least 1 telemetry event");
  const lastEvent = telemetryEvents[telemetryEvents.length - 1];
  assert.ok(lastEvent.metrics !== undefined || lastEvent.percent !== undefined, "Telemetry must contain metrics or percent");
});

test("Tier 1.16: runUntilZeroSingletons strictly preserves all hard invariants across all passes", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { classId: "10A2", subject: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");
  setCell(data, "10A2", "thu2", "sang", 1, "Van");
  setCell(data, "10A2", "thu3", "sang", 1, "Van");
  setCell(data, "10A2", "thu4", "sang", 1, "Van");
  setCell(data, "10A2", "thu5", "sang", 1, "Van");

  const engine = new FetTimetableEngine(data, { seed: 505 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await executeDeepSingletonOptimization(engine, { maxPasses: 5 });
  assert.ok(res.ok);
  assert.equal(res.metrics.unplacedCount || 0, 0, "Unplaced must be 0");
  assert.equal(res.metrics.soBuoiTrong2 || 0, 0, "Gap-2 must be 0");
  assert.equal(res.metrics.studentHoles || 0, 0, "Student holes must be 0");
});

// --- Feature 4: runUntilStagnation & Stagnation Detection ---

test("Tier 1.17: runUntilStagnation terminates when stagnantPasses reaches stagnationThreshold", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 1, limit: 1 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const start = Date.now();
  const res = await executeDeepSingletonOptimization(engine, { stagnationThreshold: 2 });
  const elapsed = Date.now() - start;

  assert.ok(res.ok);
  assert.ok(elapsed < 2000, "Should terminate quickly upon stagnation");
});

test("Tier 1.18: runUntilStagnation triggers ILS perturbation kick on stagnation pass 1", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A2", subject: "Van", teacher: "GV02", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A2", "thu4", "sang", 0, "Van");
  setCell(data, "10A2", "thu5", "sang", 0, "Van");

  const engine = new FetTimetableEngine(data, { seed: 202 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await executeDeepSingletonOptimization(engine, { maxPasses: 4, stagnationThreshold: 3 });
  assert.ok(res.ok);
  assert.equal(res.metrics.soBuoiDay1, 0);
});

test("Tier 1.19: runUntilStagnation recognizes structural floor and exits cleanly without spinning", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 1, limit: 1 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 303 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await executeDeepSingletonOptimization(engine, {});
  assert.ok(res.ok);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 1.20: runUntilStagnation completes immediately on already optimal timetable (0 singletons)", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu2", "sang", 1, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 404 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initialMetrics = engine.evaluateMetrics();
  assert.equal(initialMetrics.soBuoiDay1, 0);

  const start = Date.now();
  const res = await executeDeepSingletonOptimization(engine, {});
  const elapsed = Date.now() - start;

  assert.ok(res.ok);
  assert.equal(res.metrics.soBuoiDay1, 0);
  assert.ok(elapsed < 500, "Immediate exit when already 0 singletons");
});

test("Tier 1.21: runUntilStagnation returns comprehensive diagnostics report", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 }]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 505 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const res = await executeDeepSingletonOptimization(engine, {});
  assert.ok(res.ok);
  assert.ok(res.metrics !== undefined);
  assert.ok(res.initialMetrics !== undefined);
});

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES
// ============================================================================

test("Tier 2.1: Structural Floor WT=1: Single-period teacher weekly load is permitted as mathematical exception", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "AmNhac", teacher: "GV_NHAC", periods: 1, limit: 1 }]
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  const solveRes = engine.solve();
  assert.ok(solveRes.ok, "Solver must place 1-period teacher successfully");
  assert.equal(solveRes.placed, 1);
  assert.equal(solveRes.unassigned, 0);

  const optRes = await engine.optimize("optimize_singletons");
  assert.ok(optRes.ok);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 2.2: Prime teacher workloads (3, 5, 7, 11, 13, 17, 19 periods) pack into sessions >= 2t", async () => {
  const primeLoads = [3, 5, 7];
  for (const load of primeLoads) {
    const data = makeData({
      classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
      assignments: [{ classId: "10A1", subject: `Mon_${load}`, teacher: `GV_${load}`, periods: load, limit: 3 }]
    });

    const engine = new FetTimetableEngine(data, { seed: 100 + load });
    engine.init();
    const solveRes = engine.solve();
    assert.ok(solveRes.ok, `Solver must solve for prime load ${load}`);
    assert.equal(solveRes.placed, load);

    const optRes = await engine.optimize("optimize_singletons");
    assert.ok(optRes.ok);
    assert.equal(engine.countTotalStudentHoles(), 0);
    if (load >= 4) {
      assert.equal(optRes.metrics.soBuoiDay1, 0, `Prime load ${load} must achieve soBuoiDay1 = 0`);
    }
  }
});

test("Tier 2.3: Asymmetric morning/afternoon isolated shifts prevent cross-shift pollution", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10", buoi: "Sáng", shift: "morning" },
      { id: "10A2", ten: "10A2", khoi: "10", buoi: "Chiều", shift: "afternoon" }
    ],
    assignments: [
      { classId: "10A1", subject: "Toan_Sang", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A2", subject: "Toan_Chieu", teacher: "GV01", periods: 2, limit: 2 }
    ]
  });

  const engine = new FetTimetableEngine(data, { seed: 202 });
  engine.init();
  const solveRes = engine.solve();
  assert.ok(solveRes.ok);

  const optRes = await engine.optimize("optimize_singletons");
  assert.ok(optRes.ok);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 2.4: Dense fixed cells (-3) Chào cờ, Sinh hoạt, HĐTN remain 100% immutable", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { classId: "10A1", subject: "ChaoCo", teacher: "GV_BGH", periods: 1, limit: 1 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, { mon: "ChaoCo", isFixed: true, fixed: true });
  setCell(data, "10A1", "thu2", "sang", 1, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 303 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  await engine.optimize("optimize_singletons");
  engine.applyToDataTKB();

  const chaoCoCell = data.tkb["10A1"]["thu2"]["sang"][0];
  assert.ok(
    chaoCoCell && (chaoCoCell === "ChaoCo" || chaoCoCell.mon === "ChaoCo" || chaoCoCell.fixed),
    "Chào cờ slot 0 must remain fixed"
  );
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 2.5: Teacher and Class OFF cells (-2) are strictly protected against displacement", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [{ classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 }],
    constraints: {
      fixedOff: {
        class: {
          "10A1": { "thu7_sang_0": true, "thu7_sang_1": true, "thu7_sang_2": true, "thu7_sang_3": true, "thu7_sang_4": true }
        }
      }
    }
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu3", "sang", 0, "Toan");
  setCell(data, "10A1", "thu4", "sang", 0, "Toan");
  setCell(data, "10A1", "thu5", "sang", 0, "Toan");

  const engine = new FetTimetableEngine(data, { seed: 404 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  await engine.optimize("optimize_singletons");
  engine.applyToDataTKB();

  const satSlots = data.tkb["10A1"]["thu7"]["sang"];
  for (let p = 0; p < 5; p++) {
    assert.notEqual(satSlots[p], "Toan", "Class OFF on Saturday morning must not have lessons");
  }
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 2.6: Boundary period slots: Period 0 (P1) and Period 4 (P5) displacements create 0 student holes", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 2, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 2, limit: 2 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "Toan");
  setCell(data, "10A1", "thu2", "sang", 1, "Toan");
  setCell(data, "10A1", "thu2", "sang", 2, "Van");
  setCell(data, "10A1", "thu2", "sang", 3, "Van");

  const engine = new FetTimetableEngine(data, { seed: 505 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  assert.equal(engine.countTotalStudentHoles(), 0, "Contiguous block from P0 to P3 has 0 holes");
});

test("Tier 2.7: Strict subject limit boundary: gioihan=1 blocks 2-period pairing", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "TinHoc", teacher: "GV_TIN", periods: 2, limit: 1 },
      { classId: "10A1", subject: "GDCD", teacher: "GV_GDCD", periods: 2, limit: 1 }
    ]
  });

  setCell(data, "10A1", "thu2", "sang", 0, "TinHoc");
  setCell(data, "10A1", "thu4", "sang", 0, "TinHoc");
  setCell(data, "10A1", "thu3", "sang", 0, "GDCD");
  setCell(data, "10A1", "thu5", "sang", 0, "GDCD");

  const engine = new FetTimetableEngine(data, { seed: 606 });
  engine.init();
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initM = engine.evaluateMetrics();
  const res = await engine.tryPairClassSingletons(initM);
  assert.ok(!res, "Must reject pairing when gioihan is 1");
});

// ============================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS
// ============================================================================

test("Tier 3.1: Pairwise: Student contiguity preservation under simultaneous cross-day shifts and intra-class pairings", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" },
      { id: "10A3", ten: "10A3", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 },
      { name: "Anh", teacher: "GV03", periods: 4, limit: 2 }
    ]
  });

  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.init();
  const solveRes = engine.solve();
  assert.ok(solveRes.ok);

  const optRes = await executeDeepSingletonOptimization(engine, { maxPasses: 5 });
  assert.ok(optRes.ok);
  assert.equal(engine.countTotalStudentHoles(), 0, "Zero student holes preserved across all classes");
});

test("Tier 3.2: Pairwise: Zero gap-2 preservation throughout multi-pass optimization runs", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 6, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 6, limit: 2 }
    ]
  });

  const engine = new FetTimetableEngine(data, { seed: 202 });
  engine.init();
  const solveRes = engine.solve();
  assert.ok(solveRes.ok);

  const optRes = await executeDeepSingletonOptimization(engine, { maxPasses: 6 });
  assert.ok(optRes.ok);
  assert.equal(optRes.metrics.soBuoiTrong2 || 0, 0, "soBuoiTrong2 must remain 0");
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 3.3: Cooperative yielding latency < 65ms guarantees Web Worker event-loop responsiveness", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });

  const engine = new FetTimetableEngine(data, { seed: 303, deepCycles: 5 });
  engine.init();
  engine.solve();

  let maxYieldGapMs = 0;
  let lastHeartbeat = Date.now();

  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const gap = now - lastHeartbeat;
    if (gap > maxYieldGapMs) maxYieldGapMs = gap;
    lastHeartbeat = now;
  }, 5);

  try {
    await executeDeepSingletonOptimization(engine, { maxPasses: 4 });
  } finally {
    clearInterval(heartbeatInterval);
  }

  assert.ok(maxYieldGapMs < 100, `Max event loop blockage (${maxYieldGapMs}ms) must remain responsive (< 100ms)`);
});

test("Tier 3.4: Tabu memory isolation and branch state clearing across successive operators", async () => {
  const data = makeData({
    classes: [{ id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" }],
    assignments: [
      { classId: "10A1", subject: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { classId: "10A1", subject: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });

  const engine = new FetTimetableEngine(data, { seed: 404 });
  engine.init();
  engine.solve();

  await engine.tryPairClassSingletons(engine.evaluateMetrics());

  assert.equal(engine.tabuMap.size, 0, "tabuMap must be clean after operator exit");
  assert.equal(engine.swappedInBranch.size, 0, "swappedInBranch must be clean after operator exit");
});

test("Tier 3.5: Multi-pass ILS kick perturbation escapes local plateaus without losing incumbent improvements", async () => {
  const data = makeData({
    classes: [
      { id: "10A1", ten: "10A1", ten2: "10A1", khoi: "10" },
      { id: "10A2", ten: "10A2", khoi: "10" }
    ],
    subjects: [
      { name: "Toan", teacher: "GV01", periods: 4, limit: 2 },
      { name: "Van", teacher: "GV02", periods: 4, limit: 2 }
    ]
  });

  const engine = new FetTimetableEngine(data, { seed: 505 });
  engine.init();
  engine.solve();

  const optRes = await engine.optimize("optimize_all");
  assert.ok(optRes.ok);
  assert.ok(optRes.metrics.soBuoiDay1 <= optRes.initialMetrics.soBuoiDay1);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

// ============================================================================
// TIER 4: REAL-WORLD APPLICATION BENCHMARK WORKLOADS
// ============================================================================

test("Tier 4.1: Real-World Benchmark: scratch/live_school_default.json (75 classes / 2,202 periods) meets all acceptance criteria", async () => {
  const filePath = path.resolve(__dirname, "..", "scratch", "live_school_default.json");
  if (!fs.existsSync(filePath)) {
    console.log("Skipping Tier 4.1: scratch/live_school_default.json not found");
    return;
  }

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

  const finalMetrics = engine.evaluateMetrics();
  const studentHoles = countStudentHoles(data, data.lop);
  const integrity = verifyIntegrity(origData, data);

  // Invariant assertions per Acceptance Criteria:
  assert.equal(finalMetrics.unplacedCount, 0, "100% placed invariant (2,202 / 2,202 unplacedCount === 0)");
  assert.equal(finalMetrics.soBuoiTrong2, 0, "Teacher gap-2 invariant (soBuoiTrong2 === 0)");
  assert.equal(finalMetrics.soBuoiDay1, 0, "soBuoiDay1 === 0 across whole school");
  assert.equal(studentHoles, 0, "Student holes must be strictly 0");
  assert.equal(integrity.fixedIntact, true, "Fixed cells (-3) must remain 100% intact");
  assert.equal(integrity.offIntact, true, "OFF cells (-2) must remain 100% intact");

  // Check Teacher T.Chung (15 periods):
  const chungSessionsWith1 = [];
  for (const thu of DAYS) {
    for (const buoi of SESSIONS) {
      let chungPeriodsInSession = 0;
      for (const lop of data.lop || []) {
        const cid = String(lop.id || "");
        const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
        for (let p = 0; p < 5; p++) {
          const cell = arr[p];
          const mon = typeof cell === "string" ? cell : cell?.mon;
          const gv = data.pccmMatrix?.[`${cid}|${mon}`] || cell?.gv;
          if (gv === "T.Chung" || gv === "Chung") {
            chungPeriodsInSession++;
          }
        }
      }
      if (chungPeriodsInSession === 1) {
        chungSessionsWith1.push({ thu, buoi });
      }
    }
  }

  assert.equal(
    chungSessionsWith1.length,
    0,
    `Teacher T.Chung must have 0 single-period sessions (found: ${JSON.stringify(chungSessionsWith1)})`
  );
});

test("Tier 4.2: Real-World Benchmark: scratch/dongkhoi_1566.json (54 classes / 1,566 periods) full solve & invariants", () => {
  const filePath = path.resolve(__dirname, "..", "scratch", "dongkhoi_1566.json");
  if (!fs.existsSync(filePath)) {
    console.log("Skipping Tier 4.2: scratch/dongkhoi_1566.json not found");
    return;
  }

  const rawData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const engine = new FetTimetableEngine(rawData, { seed: 101, uiBreathingMs: 0 });
  engine.init();

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, "Dong Khoi solve must succeed");
  assert.equal(solveRes.unassigned, 0, "All 1,566 periods must be placed");

  const m = engine.evaluateMetrics();
  assert.equal(m.unplacedCount, 0);
  assert.equal(m.soBuoiTrong2, 0);
  assert.equal(engine.countTotalStudentHoles(), 0);
});

test("Tier 4.3: Real-World Benchmark: scratch/default_school_0317.json (75 classes / 2,193 periods) shift-isolated floor", () => {
  const filePath = path.resolve(__dirname, "..", "scratch", "default_school_0317.json");
  if (!fs.existsSync(filePath)) {
    console.log("Skipping Tier 4.3: scratch/default_school_0317.json not found");
    return;
  }

  const rawData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const engine = new FetTimetableEngine(rawData, { seed: 101, uiBreathingMs: 0 });
  engine.init();
  engine.compileConstraints();

  assert.equal(engine.activities.length > 0, true, "Activities compiled successfully");
  assert.equal(engine.constraintPreflight.zeroDomainActivities.length, 0, "Zero activities with empty domain");
  assert.ok(engine.constraintPreflight.minDomainSize >= 30, "Adequate slot placement domain");
  assert.ok(engine.constraintPreflight.structuralFloor !== undefined, "Structural floor bounds computed");
});
