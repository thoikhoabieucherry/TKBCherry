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
const WORKER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-fet-worker.js"),
  "utf8"
);

function loadEngine(){
  const window = {};
  const context = vm.createContext({
    window,
    globalThis:window,
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
    setTimeout,
    clearTimeout
  });
  vm.runInContext(ENGINE_SOURCE, context, {filename:"tkb-fet-engine.js"});
  return window.FetTimetableEngine;
}

function makeData(){
  return {
    lop:[{id:"L1", ten:"10A1", ten2:"10A1", khoi:"10"}],
    mon:[{ten:"Toán", khoi:"10", sotiet:1, gioihan:2}],
    monhoc:[{ten:"Toán", ma:"TOAN"}],
    giaovien:[{ma:"GV01", ten:"Giáo viên 01"}],
    pccmMatrix:{"L1|Toán":"GV01"},
    pccmTietMatrix:{"L1|Toán":1},
    pccmRoomMatrix:{},
    pccmGioihanMatrix:{},
    tkb:{},
    tkbLessonTeachers:{},
    tkbLessonRooms:{},
    tkbConstraints:{}
  };
}

// Build small, deterministic fixtures for exercising one hard constraint at a
// time.  The production scheduler accepts several historical aliases for
// class/subject names; these fixtures intentionally use canonical IDs while
// still going through the same PCCM lookup path as the browser worker.
function makeConstraintData({subjects, constraints = {}, tkb = {}} = {}){
  const rows = Array.isArray(subjects) && subjects.length
    ? subjects
    : [{name:"Toán", teacher:"GV01", periods:1}];
  const teachers = Array.from(new Set(rows.map(row => String(row.teacher || "").trim()).filter(Boolean)));
  const data = {
    lop:[{id:"L1", ten:"10A1", ten2:"10A1", khoi:"10"}],
    mon:rows.map(row => ({ten:row.name, khoi:"10", sotiet:row.periods || 1, gioihan:row.limit || 2})),
    monhoc:rows.map(row => ({ten:row.name, ma:row.name})),
    giaovien:teachers.map(ma => ({ma, ten:ma})),
    pccmMatrix:{},
    pccmTietMatrix:{},
    pccmRoomMatrix:{},
    pccmGioihanMatrix:{},
    tkb,
    tkbLessonTeachers:{},
    tkbLessonRooms:{},
    tkbConstraints:constraints
  };
  rows.forEach(row => {
    data.pccmMatrix[`L1|${row.name}`] = row.teacher;
    data.pccmTietMatrix[`L1|${row.name}`] = row.periods || 1;
  });
  return data;
}

function setCell(data, classId, thu, buoi, period, value){
  data.tkb[classId] = data.tkb[classId] || {};
  data.tkb[classId][thu] = data.tkb[classId][thu] || {};
  data.tkb[classId][thu][buoi] = Array.isArray(data.tkb[classId][thu][buoi])
    ? data.tkb[classId][thu][buoi]
    : ["", "", "", "", ""];
  data.tkb[classId][thu][buoi][period] = value;
}

function prepareConstraintEngine(data, options = {}){
  const FetTimetableEngine = loadEngine();
  const engine = new FetTimetableEngine(data, {seed:17, ...options});
  engine.init();
  engine.compileConstraints();
  return engine;
}

function allClassSlotsOff(){
  const slots = {};
  for(const thu of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    for(const buoi of ["sang", "chieu"]){
      for(let period = 0; period < 5; period++) slots[`${thu}|${buoi}|${period}`] = true;
    }
  }
  return slots;
}

test("FET preflight fails closed for zero-domain activities and preserves the input timetable", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  data.tkb = {L1:{thu2:{sang:["OFF", "", "", "", ""]}}};
  data.tkbConstraints = {fixedOff:{class:{L1:allClassSlotsOff()}}};
  const before = JSON.stringify(data.tkb);

  const result = new FetTimetableEngine(data, {timeBudgetMs:1_000, seed:7}).solve();

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "fet_zero_domain");
  assert.equal(result.diagnostics.zeroDomainActivities.length, 1);
  assert.equal(JSON.stringify(data.tkb), before, "a partial FET candidate must never mutate DATA");
});

test("FET applies a complete hard-valid construction candidate only after preflight", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  const events = [];
  const result = new FetTimetableEngine(data, {timeBudgetMs:1_000, seed:5}).solve(event => events.push(event));

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.unassigned, 0);
  assert.equal(events[0].preflight.activityCount, 1);
  const assigned = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]
    .flatMap(thu => [data.tkb.L1[thu].sang, data.tkb.L1[thu].chieu])
    .flat()
    .filter(cell => cell === "Toán").length;
  assert.equal(assigned, 1);
});

test("Auto construction publishes immediately after all lessons are placed and never starts quality polish", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  const engine = new FetTimetableEngine(data, {timeBudgetMs:1_000, seed:5});
  let polishWasCalled = false;
  engine.obliterateAllTeacherSingletons = () => {
    polishWasCalled = true;
    throw new Error("Auto must not enter post-construction polish");
  };

  const result = engine.solve();

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.unassigned, 0);
  assert.equal(polishWasCalled, false);
});

test("FET reports a conservative unplaced floor for a proven capacity shortage", () => {
  const onlyOneSlot = allClassSlotsOff();
  delete onlyOneSlot["thu2|sang|0"];
  const data = makeConstraintData({
    subjects:[{name:"Toán", teacher:"GV01", periods:2}],
    constraints:{fixedOff:{class:{L1:onlyOneSlot}}}
  });
  const engine = prepareConstraintEngine(data);
  const preflight = engine.constraintPreflight;

  assert.equal(preflight.zeroDomainActivities.length, 0, "each individual lesson still has a legal slot");
  assert.equal(preflight.capacityShortages.length, 1);
  assert.equal(preflight.capacityShortages[0].shortage, 1);
  assert.equal(preflight.structuralFloor.provenInfeasible, true);
  assert.equal(preflight.structuralFloor.minimumUnplacedPeriods, 1);
});

test("FET exposes only fixed/domain-proven quality floors", () => {
  const data = makeConstraintData({subjects:[{name:"Toán", teacher:"GV01", periods:2}]});
  setCell(data, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  setCell(data, "L1", "thu2", "sang", 4, {mon:"Toán", gv:"GV01", fixed:true});
  const engine = prepareConstraintEngine(data);
  const floor = engine.constraintPreflight.structuralFloor;

  assert.deepEqual(
    JSON.parse(JSON.stringify(floor.metricLowerBounds)),
    {soBuoiDay1:0, tsBuoiDay:1, tsNgayDay:1, soBuoiTrong1:0, soBuoiTrong2:1}
  );
  assert.equal(floor.metricLowerBoundEvidence.length, 1);
  assert.equal(floor.metricLowerBoundEvidence[0].metric, "soBuoiTrong2");
  assert.equal(floor.metricLowerBoundEvidence[0].reason, "fixed_gap_cannot_be_reduced_by_compiled_domains");
});

test("FET stops optimization at a proven positive floor and exposes it", async () => {
  const data = makeConstraintData({subjects:[{name:"Toán", teacher:"GV01", periods:2}]});
  setCell(data, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  setCell(data, "L1", "thu2", "sang", 4, {mon:"Toán", gv:"GV01", fixed:true});

  const result = await new (loadEngine())(data, {
    seed:31,
    optimizeTimeBudgetMs:30_000
  }).optimize("optimize_gap2");

  assert.equal(result.ok, true);
  assert.equal(result.metrics.soBuoiTrong2, 1);
  assert.equal(result.targetMetricKey, "soBuoiTrong2");
  assert.equal(result.targetMetricLowerBound, 1);
  assert.equal(result.targetReached, true);
  assert.equal(result.floorReached, true);
  assert.equal(result.diagnostics.structuralFloor.metricLowerBounds.soBuoiTrong2, 1);
});

test("optimizer worker sends only complete improved checkpoints, never its live grid per progress frame", () => {
  const optimizeStart = WORKER_SOURCE.indexOf("if (taskType === 'optimize')");
  const solveStart = WORKER_SOURCE.indexOf("} else {", optimizeStart);
  assert.ok(optimizeStart >= 0 && solveStart > optimizeStart, "optimizer worker branch is present");
  const optimizeBranch = WORKER_SOURCE.slice(optimizeStart, solveStart);
  const progressStart = optimizeBranch.indexOf("const res = await currentEngine.optimize");
  const progressEnd = optimizeBranch.indexOf("self.postMessage({\n        type: 'done'", progressStart);
  assert.ok(progressStart >= 0 && progressEnd > progressStart, "optimizer progress callback is present");
  const progressCallback = optimizeBranch.slice(progressStart, progressEnd);

  assert.match(progressCallback, /bestCheckpoint/);
  assert.match(progressCallback, /checkpoint:\s*bestCheckpoint/);
  assert.match(progressCallback, /complete:\s*Number\(prog\?\.metrics\?\.unplacedCount/);
  assert.match(progressCallback, /currentEngine\.getSnapshotTKB\(\)/,
    "a complete improved checkpoint must contain a retained timetable snapshot");
  assert.match(progressCallback, /getRetainedOptimizationSnapshotTKB/,
    "a Stop checkpoint must use the retained best timetable rather than a transient ejection state");
  assert.match(optimizeBranch, /type: 'done',[\s\S]*?applied:\s*true/);
});

test("FET orders construction activities by MRV domain before degree tie-breakers", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  data.lop.push({id:"L2", ten:"10A2", ten2:"10A2", khoi:"10"});
  data.pccmMatrix["L2|Toán"] = "GV02";
  data.pccmTietMatrix["L2|Toán"] = 1;
  data.tkbConstraints = {fixedOff:{class:{L1:allClassSlotsOff()}}};
  delete data.tkbConstraints.fixedOff.class.L1["thu2|sang|0"];
  delete data.tkbConstraints.fixedOff.class.L1["thu2|sang|1"];

  const engine = new FetTimetableEngine(data, {seed:9});
  engine.init();
  const preflight = engine.compileConstraints();
  engine.computeDifficultiesAndSort();

  assert.equal(preflight.minDomainSize, 2);
  assert.equal(engine.activities[0].classId, "L1");
  assert.ok(engine.activities[0].baseDomainSize <= engine.activities[1].baseDomainSize);
});

test("FET does not split a required paired lesson merely to report success", () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  data.pccmTietMatrix["L1|Toán"] = 2;
  data.tkbConstraints = {
    fixedOff:{class:{L1:allClassSlotsOff()}},
    subject:{Toán:{byClass:{L1:{lessonBlocks:{"2":{min:1, max:1}}}}}}
  };
  delete data.tkbConstraints.fixedOff.class.L1["thu2|sang|0"];
  const result = new FetTimetableEngine(data, {timeBudgetMs:1_000, seed:11}).solve();

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "fet_zero_domain");
  assert.equal(result.diagnostics.zeroDomainActivities[0].duration, 2);
});

test("FET optimisation locks incumbent minimum lesson blocks before quality moves", () => {
  const data = makeData();
  data.mon[0].sotiet = 2;
  data.pccmTietMatrix["L1|Toán"] = 2;
  data.tkbConstraints = {
    subject:{Toán:{byClass:{L1:{lessonBlocks:{"2":{min:1}}}}}}
  };
  setCell(data, "L1", "thu2", "sang", 0, "Toán");
  setCell(data, "L1", "thu2", "sang", 1, "Toán");

  const engine = new (loadEngine())(data, {seed:29});
  engine.loadExistingSchedule();
  const pair = engine.activities.filter(activity => activity.mon === "Toán");

  assert.equal(pair.length, 2);
  assert.equal(pair.every(activity => activity.lockedByLessonBlock === true && activity.isFixed === true), true);
  const firstSlot = engine.actPlacement[pair[0].id];
  assert.equal(engine.unplaceActivity(pair[0].id), false, "a protected pair member cannot be ejected by a quality move");
  assert.equal(engine.actPlacement[pair[0].id], firstSlot);
  assert.equal(engine.placeActivityDirect(pair[0].id, firstSlot + 2), false, "a protected pair member cannot be relocated alone");
  assert.equal(engine.actPlacement[pair[0].id], firstSlot);
});

test("FET treats subject sessionAllowed as a hard domain restriction", () => {
  const data = makeConstraintData({
    constraints:{subject:{Toán:{sessionAllowed:{allowMorning:false, allowAfternoon:true}}}}
  });
  const engine = prepareConstraintEngine(data);
  const activity = engine.activities[0];
  const allowed = engine.allowedSlotsByActivity.get(activity);

  assert.ok(allowed.length > 0);
  assert.equal(allowed.some(slot => slot < 5), false, "morning slots must be removed from the domain");
  assert.equal(allowed.some(slot => slot >= 5), true, "an allowed afternoon domain must remain");
  assert.equal(engine.constraintConflictForSlot(activity, 0, new Set()), "subject_session_allowed");
  assert.equal(engine.getConflictsForSlot(activity, 0).possible, false);
});

test("FET binds teacher mustTeach anchors to a compatible activity", () => {
  const data = makeConstraintData({
    constraints:{teacher:{GV01:{mustTeach:{"thu3|sang|2":true}}}}
  });
  const engine = prepareConstraintEngine(data);
  const activity = engine.activities[0];
  const anchorSlot = 12; // thu3 / sang / period index 2
  const allowed = engine.allowedSlotsByActivity.get(activity);

  assert.deepEqual(Array.from(allowed), [anchorSlot]);
  assert.deepEqual(Array.from(engine.mustTeachTargetSlotsByActivity.get(activity.id)), [anchorSlot]);
  const result = engine.solve();
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.unassigned, 0);
  assert.equal(engine.actPlacement[activity.id], anchorSlot);
  assert.deepEqual(result.diagnostics.missingMustTeach || [], []);
});

test("FET preserves mustTeach anchor ownership after MRV reorders activities", () => {
  const classOff = allClassSlotsOff();
  delete classOff["thu2|sang|0"];
  delete classOff["thu2|sang|2"];
  delete classOff["thu2|sang|3"];
  const data = makeConstraintData({
    // The single-period B activity is created first and owns the anchor. Both
    // activities have a one-slot domain, so MRV's paired-lesson tie-breaker
    // moves A before B and therefore changes numeric IDs.
    subjects:[
      {name:"B", teacher:"GV01", periods:1},
      {name:"A", teacher:"GV01", periods:2}
    ],
    constraints:{
      fixedOff:{class:{L1:classOff}},
      teacher:{GV01:{mustTeach:{"thu2|sang|0":true}}},
      subject:{A:{byClass:{L1:{lessonBlocks:{"2":{min:1, max:1}}}}}}
    }
  });
  const FetTimetableEngine = loadEngine();
  const engine = new FetTimetableEngine(data, {seed:41, timeBudgetMs:1_000});
  const result = engine.solve();
  const anchored = engine.activities.find(activity => activity.mon === "B");

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(engine.actPlacement[anchored.id], 0, "the mustTeach anchor must stay on the original compatible activity");
  assert.equal(engine.missingMustTeachSlots().length, 0);
});

test("FET checks every period of a paired activity against subject/group OFF and keeps unplace transactional", () => {
  const data = makeConstraintData({
    subjects:[{name:"Toán", teacher:"GV01", periods:2}],
    constraints:{
      fixedOff:{subject:{Toán:{"thu2|sang|1":true}}},
      subject:{Toán:{byClass:{L1:{lessonBlocks:{"2":{min:1, max:1}}}}}}
    }
  });
  const engine = prepareConstraintEngine(data);
  const pair = engine.activities[0];

  assert.equal(pair.duration, 2);
  assert.equal(engine.getConflictsForSlot(pair, 0).possible, false, "a pair may not cross a subject OFF slot in its second period");
  assert.equal(engine.allowedSlotsByActivity.get(pair).includes(0), false);

  // Direct placement models a stale legacy candidate. Removing it must always
  // clean both cells even if it happened to occupy a now-prohibited slot.
  engine.placeActivityDirect(pair.id, 0);
  engine.unplaceActivity(pair.id);
  assert.equal(engine.actPlacement[pair.id], -1);
  assert.equal(engine.classGrid.get("L1")[0], -1);
  assert.equal(engine.classGrid.get("L1")[1], -1);
});

test("FET enforces subject noSameSession and noSameDay against fixed cells", () => {
  const noSameSessionData = makeConstraintData({
    subjects:[
      {name:"Toán", teacher:"GV01", periods:1},
      {name:"Văn", teacher:"GV02", periods:1}
    ],
    constraints:{subjectNoSameSession:{byClass:{L1:{sameSession:{groups:{G1:["Toán", "Văn"]}}}}}}
  });
  setCell(noSameSessionData, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const sameSessionEngine = prepareConstraintEngine(noSameSessionData);
  const van = sameSessionEngine.activities.find(act => act.mon === "Văn");
  assert.ok(van, "the movable subject must be represented as an activity");
  assert.equal(sameSessionEngine.constraintConflictForSlot(van, 1, new Set()), "no_same_session");
  assert.equal(sameSessionEngine.getConflictsForSlot(van, 1).possible, false);
  assert.equal(sameSessionEngine.getConflictsForSlot(van, 5).possible, true, "different session on same day is allowed by noSameSession");

  const noSameDayData = makeConstraintData({
    subjects:[
      {name:"Toán", teacher:"GV01", periods:1},
      {name:"Văn", teacher:"GV02", periods:1}
    ],
    constraints:{subjectNoSameSession:{byClass:{L1:{sameDay:{groups:{G1:["Toán", "Văn"]}}}}}}
  });
  setCell(noSameDayData, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const sameDayEngine = prepareConstraintEngine(noSameDayData);
  const vanDay = sameDayEngine.activities.find(act => act.mon === "Văn");
  assert.equal(sameDayEngine.constraintConflictForSlot(vanDay, 5, new Set()), "no_same_day");
  assert.equal(sameDayEngine.getConflictsForSlot(vanDay, 5).possible, false);
  assert.equal(sameDayEngine.getConflictsForSlot(vanDay, 10).possible, true, "a different day is allowed by noSameDay");
});

test("FET enforces subject spacingDays from already fixed occurrences", () => {
  const data = makeConstraintData({
    subjects:[{name:"Toán", teacher:"GV01", periods:2}],
    constraints:{subject:{Toán:{spacingDays:{days:2}}}}
  });
  setCell(data, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const engine = prepareConstraintEngine(data);
  const activity = engine.activities.find(act => act.mon === "Toán");
  assert.ok(activity);
  assert.equal(engine.constraintConflictForSlot(activity, 10, new Set()), "spacing_days", "one-day spacing is too short");
  assert.equal(engine.constraintConflictForSlot(activity, 20, new Set()), "spacing_days", "exactly two intervening day indexes is still below the strict gap");
  assert.equal(engine.getConflictsForSlot(activity, 30).possible, true, "three day indexes apart satisfies spacingDays=2");
});

test("FET enforces teacher maxDays and maxSessions as hard limits", () => {
  const maxDaysData = makeConstraintData({
    subjects:[
      {name:"Toán", teacher:"GV01", periods:1},
      {name:"Văn", teacher:"GV01", periods:1}
    ],
    constraints:{teacher:{GV01:{maxDaysSessions:{maxDays:1}}}}
  });
  setCell(maxDaysData, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const maxDaysEngine = prepareConstraintEngine(maxDaysData);
  const vanDays = maxDaysEngine.activities.find(act => act.mon === "Văn");
  assert.equal(maxDaysEngine.constraintConflictForSlot(vanDays, 10, new Set()), "teacher_max_days");
  assert.equal(maxDaysEngine.getConflictsForSlot(vanDays, 10).possible, false);
  assert.equal(maxDaysEngine.getConflictsForSlot(vanDays, 1).possible, true, "same day remains available under maxDays=1");

  const maxSessionsData = makeConstraintData({
    subjects:[
      {name:"Toán", teacher:"GV01", periods:1},
      {name:"Văn", teacher:"GV01", periods:1}
    ],
    constraints:{teacher:{GV01:{maxDaysSessions:{maxSessions:1}}}}
  });
  setCell(maxSessionsData, "L1", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const maxSessionsEngine = prepareConstraintEngine(maxSessionsData);
  const vanSessions = maxSessionsEngine.activities.find(act => act.mon === "Văn");
  assert.equal(maxSessionsEngine.constraintConflictForSlot(vanSessions, 5, new Set()), "teacher_max_sessions");
  assert.equal(maxSessionsEngine.getConflictsForSlot(vanSessions, 5).possible, false);
  assert.equal(maxSessionsEngine.getConflictsForSlot(vanSessions, 1).possible, true, "same session remains available under maxSessions=1");
});

test("FET compiles subject-group session, period, and distinct-subject limits as hard constraints", () => {
  const constraints = {
    groups:{subject:{G_STEM:{items:["Toán", "Văn"]}}},
    subjectGroup:{
      G_STEM:{
        byClass:{
          L1:{
            sessionAllowed:{allowMorning:false, allowAfternoon:true},
            maxPeriods:{chieu:2},
            maxSubjects:{chieu:1}
          }
        }
      }
    }
  };
  const morningOnly = makeConstraintData({constraints});
  const morningEngine = prepareConstraintEngine(morningOnly);
  const toan = morningEngine.activities.find(activity => activity.mon === "Toán");
  assert.equal(morningEngine.constraintConflictForSlot(toan, 0, new Set()), "subject_group_session_allowed");
  assert.equal(morningEngine.getConflictsForSlot(toan, 0).possible, false);
  assert.equal(morningEngine.getConflictsForSlot(toan, 5).possible, true);

  const maxPeriodData = makeConstraintData({
    subjects:[
      {name:"Toán", teacher:"GV01", periods:1},
      {name:"Văn", teacher:"GV02", periods:1}
    ],
    constraints:{
      groups:{subject:{G_STEM:{items:["Toán", "Văn"]}}},
      subjectGroup:{G_STEM:{byClass:{L1:{maxPeriods:{chieu:1}}}}}
    }
  });
  setCell(maxPeriodData, "L1", "thu2", "chieu", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const maxPeriodEngine = prepareConstraintEngine(maxPeriodData);
  const vanPeriod = maxPeriodEngine.activities.find(activity => activity.mon === "Văn");
  assert.equal(maxPeriodEngine.constraintConflictForSlot(vanPeriod, 6, new Set()), "subject_group_max_periods_session");
  assert.equal(maxPeriodEngine.getConflictsForSlot(vanPeriod, 6).possible, false);

  const maxSubjectData = makeConstraintData({
    subjects:[
      {name:"Toán", teacher:"GV01", periods:1},
      {name:"Văn", teacher:"GV02", periods:1}
    ],
    constraints:{
      groups:{subject:{G_STEM:{items:["Toán", "Văn"]}}},
      subjectGroup:{G_STEM:{byClass:{L1:{maxSubjects:{chieu:1}}}}}
    }
  });
  setCell(maxSubjectData, "L1", "thu2", "chieu", 0, {mon:"Toán", gv:"GV01", fixed:true});
  const maxSubjectEngine = prepareConstraintEngine(maxSubjectData);
  const van = maxSubjectEngine.activities.find(activity => activity.mon === "Văn");
  assert.equal(maxSubjectEngine.constraintConflictForSlot(van, 6, new Set()), "subject_group_max_subjects_session");
  assert.equal(maxSubjectEngine.getConflictsForSlot(van, 6).possible, false);
});

test("FET enforces subject-group groupLimit aliases as hard constraints", () => {
  const data = makeConstraintData({
    constraints:{
      groups:{subject:{G_STEM:{items:["Toán"]}}},
      subjectGroup:{G_STEM:{groupLimit:{perSlot:{classes:1}}}}
    }
  });
  data.lop.push({id:"L2", ten:"10A2", ten2:"10A2", khoi:"10"});
  data.giaovien.push({ma:"GV02", ten:"GV02"});
  data.pccmMatrix["L2|Toán"] = "GV02";
  data.pccmTietMatrix["L2|Toán"] = 1;
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Toán", gv:"GV02", fixed:true});

  const engine = prepareConstraintEngine(data);
  const l1Toan = engine.activities.find(activity => activity.classId === "L1" && activity.mon === "Toán");
  assert.equal(engine.constraintConflictForSlot(l1Toan, 0, new Set()), "subject_group_global_limit");
  assert.equal(engine.getConflictsForSlot(l1Toan, 0).possible, false);
});

test("FET enforces configured global and time-limit group ceilings before construction", () => {
  const data = makeConstraintData({
    constraints:{
      subject:{Toán:{globalLimit:{perSlot:{classes:1}}}},
      groups:{teacher:{G_TEACHERS:{items:["GV01", "GV02"]}}},
      timeLimit:[{
        targetType:"teacherGroup",
        targetId:"G_TEACHERS",
        perSlot:{teachers:1},
        perSession:{}
      }]
    }
  });
  data.lop.push({id:"L2", ten:"10A2", ten2:"10A2", khoi:"10"});
  data.giaovien.push({ma:"GV02", ten:"GV02"});
  data.pccmMatrix["L2|Toán"] = "GV02";
  data.pccmTietMatrix["L2|Toán"] = 1;
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Toán", gv:"GV02", fixed:true});

  const engine = prepareConstraintEngine(data);
  const l1Toan = engine.activities.find(activity => activity.classId === "L1" && activity.mon === "Toán");
  assert.equal(engine.constraintConflictForSlot(l1Toan, 0, new Set()), "subject_global_limit");
  assert.equal(engine.getConflictsForSlot(l1Toan, 0).possible, false);

  // Make the subject global ceiling permissive so the independent teacher
  // group time-limit is the next rejection reason.
  engine.data.tkbConstraints.subject.Toán.globalLimit.perSlot.classes = 2;
  engine.data.tkbConstraints.subject.Toán.groupLimit = {perSlot:{classes:1}};
  engine.buildConstraintIndex();
  assert.equal(engine.constraintConflictForSlot(l1Toan, 0, new Set()), "subject_global_limit");
  delete engine.data.tkbConstraints.subject.Toán.groupLimit;
  engine.buildConstraintIndex();
  assert.equal(engine.constraintConflictForSlot(l1Toan, 0, new Set()), "time_limit");
  assert.equal(engine.getConflictsForSlot(l1Toan, 0).possible, false);
});

test("FET limit compiler honors positive per-slot overrides, zero fallback, and skips disabled global rows", () => {
  const data = makeConstraintData({
    constraints:{
      subject:{Toán:{globalLimit:{perSlot:{classes:0}}}},
      groups:{class:{G_CLASSES:{items:["L1", "L2"]}}},
      timeLimit:[
        {
          targetType:"classGroup",
          targetId:"G_CLASSES",
          perSlot:{classes:2},
          perSlotBySession:{classes:{sang:{thu2:0, thu3:1}}}
        },
        {
          // A stale empty row must not trigger an all-school scan in the
          // construction hot path just because its target still matches.
          targetType:"classGroup",
          targetId:"G_CLASSES",
          perSlot:{classes:0},
          perSession:{classes:0}
        }
      ]
    }
  });
  data.lop.push({id:"L2", ten:"10A2", ten2:"10A2", khoi:"10"});
  data.giaovien.push({ma:"GV02", ten:"GV02"});
  data.pccmMatrix["L2|Toán"] = "GV02";
  data.pccmTietMatrix["L2|Toán"] = 1;
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Toán", gv:"GV02", fixed:true});
  setCell(data, "L2", "thu3", "sang", 0, {mon:"Toán", gv:"GV02", fixed:true});

  const engine = prepareConstraintEngine(data);
  const l1Toan = engine.activities.find(activity => activity.classId === "L1" && activity.mon === "Toán");
  const activeRule = engine.constraintIndex.timeLimit[0];

  assert.equal(
    engine.constraintLimitValue(activeRule, "perSlot", "classes", {buoi:"sang", thu:"thu2"}),
    2,
    "a zero session cell means unset and must fall back to the generic limit"
  );
  assert.equal(
    engine.constraintLimitValue(activeRule, "perSlot", "classes", {buoi:"sang", thu:"thu3"}),
    1,
    "a positive session-specific cell must override the generic limit"
  );
  assert.equal(engine.getConflictsForSlot(l1Toan, 0).possible, true, "fallback limit=2 admits two classes");
  assert.equal(engine.getConflictsForSlot(l1Toan, 10).possible, false, "override limit=1 rejects two classes");

  const disabled = makeConstraintData({
    constraints:{
      subject:{Toán:{globalLimit:{perSlot:{classes:0}}}},
      timeLimit:[{targetType:"subject", targetId:"Toán", perSlot:{classes:0}}]
    }
  });
  const disabledEngine = prepareConstraintEngine(disabled);
  const activity = disabledEngine.activities[0];
  const originalScan = disabledEngine.scheduleCellsForConstraintTarget.bind(disabledEngine);
  let scans = 0;
  disabledEngine.scheduleCellsForConstraintTarget = (...args) => {
    scans++;
    return originalScan(...args);
  };
  assert.equal(disabledEngine.getConflictsForSlot(activity, 0).possible, true);
  assert.equal(scans, 0, "disabled global/time-limit rows must not scan the whole timetable");
});

test("FET honors subject fixed/off slots before construction", () => {
  const data = makeConstraintData({
    constraints:{fixedOff:{subject:{Toán:{"thu2|sang|0":true}}}}
  });
  const engine = prepareConstraintEngine(data);
  const activity = engine.activities[0];
  assert.equal(engine.constraintConflictForSlot(activity, 0, new Set()), "subject_fixed_off");
  assert.equal(engine.getConflictsForSlot(activity, 0).possible, false);
  assert.equal(engine.getConflictsForSlot(activity, 1).possible, true);
  assert.equal(engine.constraintPreflight.zeroDomainActivities.length, 0);
});

test("FET mustTeach failure is fail-closed and leaves DATA.tkb untouched", () => {
  const data = makeConstraintData({
    constraints:{teacher:{GV_MISSING:{mustTeach:{"thu2|sang|0":true}}}},
    tkb:{L1:{thu2:{sang:["existing-user-cell", "", "", "", ""]}}}
  });
  const before = JSON.stringify(data.tkb);
  const result = new (loadEngine())(data, {timeBudgetMs:1_000, seed:23}).solve();

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "fet_must_teach_unmet");
  assert.equal(result.diagnostics.missingMustTeach.length, 1);
  assert.equal(JSON.stringify(data.tkb), before, "an unmet hard anchor must not publish a partial candidate");
});

test("FET optimization refuses to polish an incomplete schedule", async () => {
  const FetTimetableEngine = loadEngine();
  const data = makeData();
  data.tkbConstraints = {fixedOff:{class:{L1:allClassSlotsOff()}}};
  const result = await new FetTimetableEngine(data, {seed:13}).optimize("optimize_gap2");

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "fet_optimize_requires_complete_schedule");
  assert.ok(result.diagnostics.structuralFloor, "optimizer failures retain preflight lower-bound diagnostics");
});

test("FET shared comparator retains each optimizer's locked invariants", () => {
  const FetTimetableEngine = loadEngine();
  const engine = new FetTimetableEngine(makeData());
  const initial = {unplacedCount:0, soBuoiDay1:2, tsBuoiDay:10, tsNgayDay:7, soBuoiTrong2:4, soBuoiTrong1:5};

  assert.equal(
    engine.compareMetrics({...initial, soBuoiDay1:3, soBuoiTrong2:0}, initial, initial, "optimize_gap2") > 0,
    true,
    "gap2 may not buy an extra singleton"
  );
  assert.equal(
    engine.compareMetrics({...initial, soBuoiTrong2:3, tsBuoiDay:12}, initial, initial, "optimize_gap2") < 0,
    true,
    "gap2 may use a session expansion only when it really reduces gap2"
  );
  assert.equal(
    engine.compareMetrics({...initial, soBuoiTrong2:5, soBuoiTrong1:0}, initial, initial, "optimize_gap1") > 0,
    true,
    "gap1 may not create a gap2"
  );
  assert.equal(
    engine.compareMetrics({...initial, soBuoiDay1:1, soBuoiTrong2:5}, initial, initial, "optimize_gap2") > 0,
    true,
    "gap2 mode may not trade a worse gap2 score for a singleton improvement"
  );
  assert.equal(
    engine.compareMetrics({...initial, soBuoiDay1:1, soBuoiTrong1:6}, initial, initial, "optimize_gap1") > 0,
    true,
    "gap1 mode may not trade a worse gap1 score for a singleton improvement"
  );
});

test("FET construction backtracking clears root rollback state between activities", () => {
  const engine = prepareConstraintEngine(makeConstraintData());
  const activity = engine.activities[0];
  engine.limitCalls = 1_000;
  engine.deadlineAtMs = Date.now() + 1_000;

  assert.equal(engine.randomSwap(activity.id, 0), true);
  assert.equal(engine.restoreStack.length, 0, "successful root placement must not retain a rollback history");
  assert.equal(engine.swappedInBranch.size, 0);
});

function addLocationAssignedClass(data, {
  id,
  name = id,
  subject,
  teacher = "GV01",
  room = "",
  classLocation = ""
}){
  data.lop.push({id, ten:name, ten2:name, khoi:"10", diadiem:classLocation});
  data.mon.push({ten:subject, khoi:"10", sotiet:1, gioihan:2});
  data.monhoc.push({ten:subject, ma:subject});
  if(!data.giaovien.some(item => item.ma === teacher)) data.giaovien.push({ma:teacher, ten:teacher});
  data.pccmMatrix[`${id}|${subject}`] = teacher;
  data.pccmTietMatrix[`${id}|${subject}`] = 1;
  if(room) data.pccmRoomMatrix[`${id}|${subject}`] = room;
}

function makeTeacherLocationFixture(ruleName){
  const data = makeConstraintData({
    subjects:[{name:"Toán", teacher:"GV01", periods:1}],
    constraints:{teacher:{GV01:{[ruleName]:{sang:{thu2:true}}}}}
  });
  data.phong = [
    {ma:"A101", diaDiem:"Cơ sở A"},
    {ma:"B101", khu:"Cơ sở B"}
  ];
  data.pccmRoomMatrix["L1|Toán"] = "A101";
  return data;
}

test("FET domain-prunes oneLocationPerSession using the same room-location aliases as the UI validator", () => {
  const data = makeTeacherLocationFixture("oneLocationPerSession");
  addLocationAssignedClass(data, {id:"L2", subject:"Văn", room:"B101"});
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});

  const engine = prepareConstraintEngine(data);
  const candidate = engine.activities.find(activity => activity.classId === "L1" && activity.mon === "Toán");

  assert.equal(candidate.location, "Cơ sở A");
  assert.equal(engine.fixedSlots.get("L2|0").location, "Cơ sở B");
  assert.equal(
    engine.constraintConflictForSlot(candidate, 1, new Set()),
    "teacher_one_location_per_session"
  );
  assert.equal(engine.getConflictsForSlot(candidate, 1).possible, false);
  assert.equal(engine.allowedSlotsByActivity.get(candidate).includes(1), false);
});

test("FET matches the UI's gapBetweenLocations rule: only an actual free period permits a location change", () => {
  const data = makeTeacherLocationFixture("gapBetweenLocations");
  addLocationAssignedClass(data, {id:"L2", subject:"Văn", room:"B101"});
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});

  const engine = prepareConstraintEngine(data);
  const candidate = engine.activities.find(activity => activity.classId === "L1" && activity.mon === "Toán");

  assert.equal(
    engine.constraintConflictForSlot(candidate, 1, new Set()),
    "teacher_gap_between_locations"
  );
  assert.equal(engine.getConflictsForSlot(candidate, 1).possible, false, "adjacent different locations are forbidden");
  assert.equal(engine.getConflictsForSlot(candidate, 2).possible, true, "a blank period between locations is permitted");
});

test("FET domain-prunes maxOneMovePerSession after the UI-equivalent A → B → A location sequence", () => {
  const data = makeTeacherLocationFixture("maxOneMovePerSession");
  addLocationAssignedClass(data, {id:"L2", subject:"Văn", room:"A101"});
  addLocationAssignedClass(data, {id:"L3", subject:"Lý", room:"B101"});
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});
  setCell(data, "L3", "thu2", "sang", 2, {mon:"Lý", gv:"GV01", fixed:true});

  const engine = prepareConstraintEngine(data);
  const candidate = engine.activities.find(activity => activity.classId === "L1" && activity.mon === "Toán");

  assert.equal(
    engine.constraintConflictForSlot(candidate, 4, new Set()),
    "teacher_max_one_move_per_session"
  );
  assert.equal(engine.getConflictsForSlot(candidate, 4).possible, false);
});

test("FET follows the UI validator's class-location fallback and intentionally ignores unresolved locations", () => {
  const classFallback = makeConstraintData({
    subjects:[{name:"Toán", teacher:"GV01", periods:1}],
    constraints:{teacher:{GV01:{oneLocationPerSession:{sang:{thu2:true}}}}}
  });
  classFallback.lop[0].diadiem = "Cơ sở A";
  addLocationAssignedClass(classFallback, {
    id:"L2",
    subject:"Văn",
    room:"",
    classLocation:"Cơ sở B"
  });
  setCell(classFallback, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});

  const fallbackEngine = prepareConstraintEngine(classFallback);
  const fallbackCandidate = fallbackEngine.activities.find(activity => activity.classId === "L1");
  assert.equal(fallbackCandidate.location, "Cơ sở A");
  assert.equal(fallbackEngine.fixedSlots.get("L2|0").location, "Cơ sở B");
  assert.equal(fallbackEngine.getConflictsForSlot(fallbackCandidate, 1).possible, false);

  const unresolved = makeConstraintData({
    subjects:[{name:"Toán", teacher:"GV01", periods:1}],
    constraints:{teacher:{GV01:{oneLocationPerSession:{sang:{thu2:true}}}}}
  });
  addLocationAssignedClass(unresolved, {id:"L2", subject:"Văn"});
  setCell(unresolved, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});
  const unresolvedEngine = prepareConstraintEngine(unresolved);
  const unresolvedCandidate = unresolvedEngine.activities.find(activity => activity.classId === "L1");
  assert.equal(unresolvedCandidate.location, "");
  assert.equal(unresolvedEngine.fixedSlots.get("L2|0").location, "");
  assert.equal(
    unresolvedEngine.getConflictsForSlot(unresolvedCandidate, 1).possible,
    true,
    "blank locations are omitted by the production validator and must not be invented by FET"
  );
});

test("FET uses the validator's exact checkbox truthiness for teacher location rules", () => {
  const data = makeTeacherLocationFixture("oneLocationPerSession");
  data.tkbConstraints.teacher.GV01.oneLocationPerSession.sang.thu2 = "yes";
  addLocationAssignedClass(data, {id:"L2", subject:"Văn", room:"B101"});
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});

  const engine = prepareConstraintEngine(data);
  const candidate = engine.activities.find(activity => activity.classId === "L1");
  assert.equal(engine.getConflictsForSlot(candidate, 1).possible, true, "the UI does not treat arbitrary non-empty strings as a checked box");

  engine.data.tkbConstraints.teacher.GV01.oneLocationPerSession.sang.thu2 = "on";
  engine.buildConstraintIndex();
  assert.equal(engine.getConflictsForSlot(candidate, 1).possible, false, "the UI recognizes the legacy checked value 'on'");
});

test("FET fails closed without mutating DATA when fixed cells already violate a teacher location rule", () => {
  const data = makeTeacherLocationFixture("oneLocationPerSession");
  addLocationAssignedClass(data, {id:"L2", subject:"Văn", room:"A101"});
  addLocationAssignedClass(data, {id:"L3", subject:"Lý", room:"B101"});
  setCell(data, "L2", "thu2", "sang", 0, {mon:"Văn", gv:"GV01", fixed:true});
  setCell(data, "L3", "thu2", "sang", 2, {mon:"Lý", gv:"GV01", fixed:true});
  const before = JSON.stringify(data.tkb);

  const result = new (loadEngine())(data, {timeBudgetMs:1_000, seed:53}).solve();

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "fet_fixed_location_constraint_violation");
  assert.equal(result.diagnostics.fixedLocationViolations.length, 1);
  assert.equal(JSON.stringify(data.tkb), before, "fixed location conflicts must never be overwritten");
});

test("FET optimization fails closed when the loaded incumbent violates a teacher location rule", async () => {
  const data = makeTeacherLocationFixture("oneLocationPerSession");
  addLocationAssignedClass(data, {id:"L2", subject:"Văn", room:"B101"});
  setCell(data, "L1", "thu2", "sang", 0, "Toán");
  setCell(data, "L2", "thu2", "sang", 2, "Văn");
  const before = JSON.stringify(data.tkb);

  const result = await new (loadEngine())(data, {optimizeTimeBudgetMs:1_000, seed:59})
    .optimize("optimize_gap2");

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.failureKind, "fet_location_constraint_violation");
  assert.equal(result.diagnostics.locationConstraintViolations.length, 1);
  assert.equal(JSON.stringify(data.tkb), before, "an invalid incumbent must remain untouched on fail-closed optimize");
});
