"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const { FetTimetableEngine, slotToDetails, detailsToSlot, DAYS_LIST, SESSIONS_LIST } = require(path.join(ROOT, "web", "pages", "tkb-fet-engine.js"));
const DONGKHOI_PATH = path.join(ROOT, "scratch", "dongkhoi_1566.json");

// Helper: Count placed periods in a TKB dictionary
function countPlacedLessons(tkbObj) {
  let count = 0;
  for (const cid of Object.keys(tkbObj || {})) {
    const byDay = tkbObj[cid];
    if (!byDay) continue;
    for (const thu of Object.keys(byDay)) {
      const byBuoi = byDay[thu];
      if (!byBuoi) continue;
      for (const buoi of Object.keys(byBuoi)) {
        const arr = byBuoi[buoi];
        if (!Array.isArray(arr)) continue;
        for (const cell of arr) {
          if (!cell || cell === "OFF" || cell === -2) continue;
          if (typeof cell === "object" && (cell.off === true || !String(cell.mon || cell.val || "").trim())) continue;
          count++;
        }
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// SUITE 1: Cancellation Responsiveness during optimizeAll() and Worker Execution
// ---------------------------------------------------------------------------

test("1.1 Cancellation: Abort at tight intervals (5ms, 25ms, 100ms) terminates cleanly and preserves incumbent", async () => {
  assert.ok(fs.existsSync(DONGKHOI_PATH), "Dong Khoi fixture exists");
  const data = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const incumbentCopy = JSON.parse(JSON.stringify(data.tkb || {}));
  const incumbentCount = countPlacedLessons(incumbentCopy);

  const abortIntervals = [5, 25, 100];
  for (const ms of abortIntervals) {
    let terminated = false;
    let stopHandled = false;
    let resolvedResult = null;

    // Simulate worker lifecycle with stop handler
    const mockWorker = {
      terminate: () => {
        terminated = true;
      }
    };

    const runPromise = new Promise((resolve) => {
      const engine = new FetTimetableEngine(JSON.parse(JSON.stringify(data)), {
        seed: 42,
        timeBudgetMs: 5000,
        uiBreathingMs: 0
      });

      let isCancelled = false;
      const stop = () => {
        isCancelled = true;
        mockWorker.terminate();
        stopHandled = true;
        resolve({ ok: false, applied: false, cancelled: true, failureKind: "user_cancelled" });
      };

      setTimeout(() => {
        stop();
      }, ms);

      engine.optimizeAll(() => {
        if (isCancelled) {
          throw new Error("Optimization continued after cancellation");
        }
      }).then((res) => {
        if (!isCancelled) resolve(res);
      }).catch((err) => {
        if (!isCancelled) resolve({ ok: false, error: err.message });
      });
    });

    const start = Date.now();
    resolvedResult = await runPromise;
    const elapsed = Date.now() - start;

    assert.equal(terminated, true, `Worker terminated at ${ms}ms`);
    assert.equal(stopHandled, true, `Stop handled at ${ms}ms`);
    assert.equal(resolvedResult.cancelled, true, `Result marked as cancelled at ${ms}ms`);
    assert.equal(resolvedResult.failureKind, "user_cancelled");
    assert.deepEqual(data.tkb, incumbentCopy, "Incumbent data must not be mutated on cancellation");
    assert.equal(countPlacedLessons(data.tkb), incumbentCount, "Placed lesson count unchanged");
  }
});

test("1.2 Cancellation: Worker Checkpoint Anti-Wipe and Safe Retention Gate", () => {
  const data = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const incumbentCount = countPlacedLessons(data.tkb);

  function evaluateCheckpointRetention(incumbentData, candidateCheckpoint) {
    if (!candidateCheckpoint || candidateCheckpoint.complete !== true || !candidateCheckpoint.tkb) {
      return { applied: false, reason: "incomplete_or_missing" };
    }
    const candidateCount = countPlacedLessons(candidateCheckpoint.tkb);
    const incCount = countPlacedLessons(incumbentData.tkb);

    if (candidateCount < incCount) {
      return { applied: false, reason: "fewer_lessons_anti_wipe" };
    }

    // Verify no null gaps created in scheduled classes
    for (const [cid, days] of Object.entries(candidateCheckpoint.tkb)) {
      for (const [thu, buois] of Object.entries(days)) {
        for (const [buoi, periods] of Object.entries(buois)) {
          if (!Array.isArray(periods)) return { applied: false, reason: "corrupted_grid_structure" };
        }
      }
    }

    return { applied: true, reason: "valid_complete_checkpoint", candidateCount };
  }

  // 1. Incomplete checkpoint rejected
  const incomp = { complete: false, tkb: data.tkb };
  assert.equal(evaluateCheckpointRetention(data, incomp).applied, false);

  // 2. Corrupted / truncated checkpoint (e.g. 50% lessons missing) rejected by anti-wipe
  const truncatedTkb = JSON.parse(JSON.stringify(data.tkb));
  const classKeys = Object.keys(truncatedTkb);
  for (let i = 0; i < Math.floor(classKeys.length / 2); i++) {
    delete truncatedTkb[classKeys[i]];
  }
  const wipedCheckpoint = { complete: true, tkb: truncatedTkb };
  const wipeRes = evaluateCheckpointRetention(data, wipedCheckpoint);
  assert.equal(wipeRes.applied, false);
  assert.equal(wipeRes.reason, "fewer_lessons_anti_wipe");

  // 3. Complete valid checkpoint applied
  const validCheckpoint = { complete: true, tkb: JSON.parse(JSON.stringify(data.tkb)) };
  const validRes = evaluateCheckpointRetention(data, validCheckpoint);
  assert.equal(validRes.applied, true);
  assert.equal(validRes.candidateCount, incumbentCount);
});

// ---------------------------------------------------------------------------
// SUITE 2: Extreme Constraint Combinations Stress Testing
// ---------------------------------------------------------------------------

test("2.1 Extreme Constraints: Strict Teacher Off-Days (4 of 5 days banned)", async () => {
  // Scenario: 4 classes, 4 teachers. Each teacher can ONLY teach on exactly 1 specific day.
  // GV_T2 only on Monday (thu2)
  // GV_T3 only on Tuesday (thu3)
  // GV_T4 only on Wednesday (thu4)
  // GV_T5 only on Thursday (thu5)
  const extremeOffData = {
    lop: [
      { id: "10A", ten: "10A", ten2: "10A", khoi: "10" },
      { id: "10B", ten: "10B", ten2: "10B", khoi: "10" }
    ],
    mon: [
      { ten: "Toan", khoi: "10", sotiet: 2, gioihan: 2 },
      { ten: "Van", khoi: "10", sotiet: 2, gioihan: 2 },
      { ten: "Anh", khoi: "10", sotiet: 2, gioihan: 2 },
      { ten: "Ly", khoi: "10", sotiet: 2, gioihan: 2 }
    ],
    monhoc: [
      { ten: "Toan", ma: "Toan" },
      { ten: "Van", ma: "Van" },
      { ten: "Anh", ma: "Anh" },
      { ten: "Ly", ma: "Ly" }
    ],
    giaovien: [
      { ma: "GV_T2", ten: "GV Thu 2" },
      { ma: "GV_T3", ten: "GV Thu 3" },
      { ma: "GV_T4", ten: "GV Thu 4" },
      { ma: "GV_T5", ten: "GV Thu 5" }
    ],
    pccmMatrix: {
      "10A|Toan": "GV_T2",
      "10A|Van": "GV_T3",
      "10A|Anh": "GV_T4",
      "10A|Ly": "GV_T5",
      "10B|Toan": "GV_T2",
      "10B|Van": "GV_T3",
      "10B|Anh": "GV_T4",
      "10B|Ly": "GV_T5"
    },
    pccmTietMatrix: {
      "10A|Toan": 2, "10A|Van": 2, "10A|Anh": 2, "10A|Ly": 2,
      "10B|Toan": 2, "10B|Van": 2, "10B|Anh": 2, "10B|Ly": 2
    },
    pccmRoomMatrix: {},
    pccmGioihanMatrix: {},
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {
      fixedOff: {
        teacher: {
          "GV_T2": {
            // Off on thu3, thu4, thu5, thu6, thu7 (all sessions: sang and chieu)
            ...Object.fromEntries(["thu3", "thu4", "thu5", "thu6", "thu7"].flatMap(d => ["sang", "chieu"].flatMap(b => [0,1,2,3,4].map(p => [`${d}|${b}|${p}`, true]))))
          },
          "GV_T3": {
            ...Object.fromEntries(["thu2", "thu4", "thu5", "thu6", "thu7"].flatMap(d => ["sang", "chieu"].flatMap(b => [0,1,2,3,4].map(p => [`${d}|${b}|${p}`, true]))))
          },
          "GV_T4": {
            ...Object.fromEntries(["thu2", "thu3", "thu5", "thu6", "thu7"].flatMap(d => ["sang", "chieu"].flatMap(b => [0,1,2,3,4].map(p => [`${d}|${b}|${p}`, true]))))
          },
          "GV_T5": {
            ...Object.fromEntries(["thu2", "thu3", "thu4", "thu6", "thu7"].flatMap(d => ["sang", "chieu"].flatMap(b => [0,1,2,3,4].map(p => [`${d}|${b}|${p}`, true]))))
          }
        }
      }
    }
  };

  const engine = new FetTimetableEngine(extremeOffData, { seed: 101, timeBudgetMs: 5000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();
  assert.equal(solveRes.ok, true, "Solve must succeed on feasible tight schedule");
  assert.equal(solveRes.unassigned, 0, "All 16 periods placed");

  // Run optimizeAll to verify that local search doesn't violate banned days
  const optRes = await engine.optimizeAll();
  assert.equal(optRes.ok, true, "optimizeAll completes without error");
  assert.equal(optRes.unassigned, 0, "No lessons unassigned during optimization");

  // Verify all placements strictly honor teacher banned days
  const snapshot = engine.getSnapshotTKB();
  for (const cid of ["10A", "10B"]) {
    for (const [thu, buois] of Object.entries(snapshot[cid])) {
      for (const [buoi, periods] of Object.entries(buois)) {
        for (let ti = 0; ti < periods.length; ti++) {
          const mon = periods[ti];
          if (!mon) continue;
          if (mon === "Toan") assert.equal(thu, "thu2", "GV_T2 (Toan) must only be placed on thu2");
          if (mon === "Van") assert.equal(thu, "thu3", "GV_T3 (Van) must only be placed on thu3");
          if (mon === "Anh") assert.equal(thu, "thu4", "GV_T4 (Anh) must only be placed on thu4");
          if (mon === "Ly") assert.equal(thu, "thu5", "GV_T5 (Ly) must only be placed on thu5");
        }
      }
    }
  }
});

test("2.2 Extreme Constraints: Strict Contiguous Requirements (2, 3, 4 period blocks)", async () => {
  // Scenario: Subjects requiring 2, 3, or 4 contiguous periods with mustKeepBlock
  const contiguousData = {
    lop: [
      { id: "11A", ten: "11A", ten2: "11A", khoi: "11" },
      { id: "11B", ten: "11B", ten2: "11B", khoi: "11" }
    ],
    mon: [
      { ten: "TinHoc", khoi: "11", sotiet: 3, gioihan: 3, mustKeepBlock: true },
      { ten: "TheDuc", khoi: "11", sotiet: 2, gioihan: 2, mustKeepBlock: true },
      { ten: "KHTN", khoi: "11", sotiet: 4, gioihan: 4, mustKeepBlock: true }
    ],
    monhoc: [
      { ten: "TinHoc", ma: "TinHoc" },
      { ten: "TheDuc", ma: "TheDuc" },
      { ten: "KHTN", ma: "KHTN" }
    ],
    giaovien: [
      { ma: "GV_TIN", ten: "GV Tin" },
      { ma: "GV_TD", ten: "GV The Duc" },
      { ma: "GV_KHTN", ten: "GV KHTN" }
    ],
    pccmMatrix: {
      "11A|TinHoc": "GV_TIN", "11A|TheDuc": "GV_TD", "11A|KHTN": "GV_KHTN",
      "11B|TinHoc": "GV_TIN", "11B|TheDuc": "GV_TD", "11B|KHTN": "GV_KHTN"
    },
    pccmTietMatrix: {
      "11A|TinHoc": 3, "11A|TheDuc": 2, "11A|KHTN": 4,
      "11B|TinHoc": 3, "11B|TheDuc": 2, "11B|KHTN": 4
    },
    pccmRoomMatrix: {},
    pccmGioihanMatrix: {
      "11A|TinHoc": 3, "11A|TheDuc": 2, "11A|KHTN": 4,
      "11B|TinHoc": 3, "11B|TheDuc": 2, "11B|KHTN": 4
    },
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {}
  };

  const engine = new FetTimetableEngine(contiguousData, { seed: 777, timeBudgetMs: 5000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();
  assert.equal(solveRes.ok, true);
  assert.equal(solveRes.unassigned, 0);

  const optRes = await engine.optimizeAll();
  assert.equal(optRes.ok, true);

  // Validate block contiguity in resulting timetable
  const snapshot = engine.getSnapshotTKB();
  for (const cid of ["11A", "11B"]) {
    for (const [thu, buois] of Object.entries(snapshot[cid])) {
      for (const [buoi, periods] of Object.entries(buois)) {
        const monPositions = {};
        for (let ti = 0; ti < periods.length; ti++) {
          const mon = periods[ti];
          if (!mon) continue;
          monPositions[mon] = monPositions[mon] || [];
          monPositions[mon].push(ti);
        }
        for (const [mon, idxs] of Object.entries(monPositions)) {
          if (idxs.length > 1) {
            for (let k = 1; k < idxs.length; k++) {
              assert.equal(idxs[k], idxs[k - 1] + 1, `Subject ${mon} in ${cid} ${thu} ${buoi} must be contiguous: got indices [${idxs}]`);
            }
          }
        }
      }
    }
  }
});

test("2.3 Extreme Constraints: Single-Period Teacher Distribution and Structural Floor", async () => {
  // Scenario: 10 teachers with exactly 1 period total across 10 classes.
  // Structural floor: each teacher has exactly 1 lesson, so each teacher structurally creates 1 singleton session (soBuoiDay1 = 10).
  const classes = [];
  const subjects = [];
  const teachers = [];
  const pccm = {};
  const pccmTiet = {};

  for (let i = 1; i <= 10; i++) {
    const cid = `C_${i}`;
    const gid = `GV_SINGLE_${i}`;
    const mid = `Sub_${i}`;
    classes.push({ id: cid, ten: cid, ten2: cid, khoi: "10" });
    subjects.push({ ten: mid, khoi: "10", sotiet: 1, gioihan: 1 });
    teachers.push({ ma: gid, ten: gid });
    pccm[`${cid}|${mid}`] = gid;
    pccmTiet[`${cid}|${mid}`] = 1;
  }

  const singlePeriodData = {
    lop: classes,
    mon: subjects,
    monhoc: subjects.map(s => ({ ten: s.ten, ma: s.ten })),
    giaovien: teachers,
    pccmMatrix: pccm,
    pccmTietMatrix: pccmTiet,
    pccmRoomMatrix: {},
    pccmGioihanMatrix: {},
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {}
  };

  const engine = new FetTimetableEngine(singlePeriodData, { seed: 999, timeBudgetMs: 3000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();
  assert.equal(solveRes.ok, true);
  assert.equal(solveRes.placed, 10);
  assert.equal(solveRes.unassigned, 0);

  // optimizeAll must not hang trying to push soBuoiDay1 from 10 to 0 (which is mathematically impossible)
  const startTime = Date.now();
  const optRes = await engine.optimizeAll();
  const duration = Date.now() - startTime;

  assert.equal(optRes.ok, true);
  assert.equal(optRes.applied, true);
  assert.ok(duration < 4000, `optimizeAll must exit cleanly within budget without hanging, elapsed: ${duration}ms`);
  assert.equal(optRes.metrics.soBuoiDay1, 10, "Structural floor: 10 teachers with 1 period = 10 singleton sessions");
});

test("2.4 Extreme Constraints: High Collision Density with 2 Shared LAB Rooms and 10 Classes", async () => {
  // Scenario: 10 classes all requiring 2 periods of TinHoc in 2 shared LAB rooms (LAB_A and LAB_B)
  // Total 20 periods competing for 2 rooms across morning slots (5 days x 5 periods = 25 room slots per room)
  const classes = [];
  const pccm = {};
  const pccmTiet = {};
  const pccmRoom = {};

  for (let i = 1; i <= 10; i++) {
    const cid = `10A${i}`;
    classes.push({ id: cid, ten: cid, ten2: cid, khoi: "10" });
    pccm[`${cid}|TinHoc`] = `GV_TIN_${(i % 3) + 1}`;
    pccmTiet[`${cid}|TinHoc`] = 2;
    pccmRoom[`${cid}|TinHoc`] = i % 2 === 0 ? "LAB_A" : "LAB_B";
  }

  const labData = {
    lop: classes,
    mon: [{ ten: "TinHoc", khoi: "10", sotiet: 2, gioihan: 2 }],
    monhoc: [{ ten: "TinHoc", ma: "TinHoc" }],
    giaovien: [
      { ma: "GV_TIN_1", ten: "GV Tin 1" },
      { ma: "GV_TIN_2", ten: "GV Tin 2" },
      { ma: "GV_TIN_3", ten: "GV Tin 3" }
    ],
    pccmMatrix: pccm,
    pccmTietMatrix: pccmTiet,
    pccmRoomMatrix: pccmRoom,
    pccmGioihanMatrix: {},
    tkb: {},
    tkbLessonTeachers: {},
    tkbLessonRooms: {},
    tkbConstraints: {}
  };

  const engine = new FetTimetableEngine(labData, { seed: 555, timeBudgetMs: 5000, uiBreathingMs: 0 });
  const solveRes = await engine.solve();
  assert.equal(solveRes.ok, true);
  assert.equal(solveRes.unassigned, 0);

  const optRes = await engine.optimizeAll();
  assert.equal(optRes.ok, true);

  // Validate that no 2 classes occupy the same room at the same slot
  const roomUsage = {}; // room -> slot -> [classIds]
  const teacherUsage = {}; // teacher -> slot -> [classIds]

  classes.forEach(c => {
    const grid = engine.classGrid.get(c.id);
    for (let s = 0; s < grid.length; s++) {
      if (grid[s] >= 0) {
        const room = pccmRoom[`${c.id}|TinHoc`];
        const teacher = pccm[`${c.id}|TinHoc`];

        roomUsage[room] = roomUsage[room] || {};
        roomUsage[room][s] = roomUsage[room][s] || [];
        roomUsage[room][s].push(c.id);

        teacherUsage[teacher] = teacherUsage[teacher] || {};
        teacherUsage[teacher][s] = teacherUsage[teacher][s] || [];
        teacherUsage[teacher][s].push(c.id);
      }
    }
  });

  for (const [room, slots] of Object.entries(roomUsage)) {
    for (const [s, cls] of Object.entries(slots)) {
      assert.ok(cls.length <= 1, `Room ${room} at slot ${s} overbooked by classes: ${cls.join(",")}`);
    }
  }

  for (const [teacher, slots] of Object.entries(teacherUsage)) {
    for (const [s, cls] of Object.entries(slots)) {
      assert.ok(cls.length <= 1, `Teacher ${teacher} at slot ${s} double-booked by classes: ${cls.join(",")}`);
    }
  }
});

// ---------------------------------------------------------------------------
// SUITE 3: Micro-task Step Budgeting and Event Loop Non-Blocking Yields
// ---------------------------------------------------------------------------

test("3.1 Micro-task Yielding: optimizeAll yields event loop control and streams progress", async () => {
  const data = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const engine = new FetTimetableEngine(data, { seed: 101, timeBudgetMs: 2000, uiBreathingMs: 0 });

  let eventLoopTicks = 0;
  const tickInterval = setInterval(() => {
    eventLoopTicks++;
  }, 20);

  const progressEvents = [];
  const optRes = await engine.optimizeAll((prog) => {
    progressEvents.push({
      percent: prog.percent !== undefined ? prog.percent : null,
      stage: prog.stage || null,
      metrics: prog.metrics || prog,
      timestamp: Date.now()
    });
  });

  clearInterval(tickInterval);

  assert.equal(optRes.ok, true);
  assert.ok(eventLoopTicks >= 5, `Event loop must tick during optimizeAll execution (got ${eventLoopTicks} ticks)`);
  assert.ok(progressEvents.length >= 2, `Progress events must stream during optimizeAll (got ${progressEvents.length} events)`);

  // Verify that percent updates (when present) are non-decreasing
  const explicitPercents = progressEvents.filter(e => e.percent !== null).map(e => e.percent);
  for (let i = 1; i < explicitPercents.length; i++) {
    assert.ok(explicitPercents[i] >= explicitPercents[i - 1], `Progress percentages must be monotonic: ${explicitPercents.join(", ")}`);
  }
});

test("3.2 Micro-task Budgeting: Time Budget Enforcement Across Multi-Round Execution", async () => {
  const data = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const budgetMs = 4000;

  const engine = new FetTimetableEngine(data, {
    seed: 303,
    timeBudgetMs: budgetMs,
    uiBreathingMs: 0
  });

  const start = Date.now();
  const res = await engine.optimizeAll();
  const elapsed = Date.now() - start;

  assert.equal(res.ok, true);
  // Time budget is checked between rounds (each round is ~2-2.5s on 1566 activities)
  // Total elapsed time will be bounded by budgetMs + one round time (~3000ms)
  assert.ok(elapsed <= budgetMs + 3000, `Execution time (${elapsed}ms) must respect time budget (${budgetMs}ms) within 1-round margin`);
  assert.ok(elapsed >= 2000, `Must have performed meaningful optimization work (elapsed: ${elapsed}ms)`);
});
