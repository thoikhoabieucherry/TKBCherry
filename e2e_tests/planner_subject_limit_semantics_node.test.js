"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");

function blankSession(values = []){
  return Array.from({length:5}, (_, index) => values[index] || "");
}

function oneDayTkb(sang = [], chieu = []){
  return {
    thu2:{sang:blankSession(sang), chieu:blankSession(chieu)}
  };
}

function lessonValue(value){
  if(value === "OFF" || value === "" || value == null) return "";
  if(typeof value === "string") return value;
  return value && typeof value === "object" ? String(value.mon || "") : "";
}

function loadValidateDrop({tkb, gioihan = 1, dragData = {type:"mon", classId:"L1", mon:"Toan"}}){
  const start = PHANMON_SOURCE.indexOf("function validateDrop");
  const end = PHANMON_SOURCE.indexOf("function countMonInTKB", start);
  assert.ok(start >= 0 && end > start, "validateDrop source must be extractable");

  const context = {
    currentLop:"L1",
    dragData,
    DATA:{tkb:{L1:tkb}},
    getMonMeta(){ return {sotiet:10, gioihan}; },
    countMon(mon){
      let count = 0;
      Object.values(tkb).forEach(day => {
        ["sang", "chieu"].forEach(buoi => {
          (day[buoi] || []).forEach(value => {
            if(lessonValue(value) === mon) count += 1;
          });
        });
      });
      return count;
    },
    cellMon:lessonValue,
    getLopCanonById(id){ return String(id); },
    getTeacherForClassMon(){ return ""; },
    findTeacherConflictAtSlot(){ return null; },
    getRoomForClassMon(){ return ""; },
    findRoomConflictAtSlot(){ return null; },
    flashLopItemConflict(){},
    getMonShort(mon){ return mon; },
    buildReplaceConfirmText(){ return ""; }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(start, end), context, {filename:PHANMON_PATH});
  return context.validateDrop;
}

function targetCell(buoi, ti){
  return {
    dataset:{thu:"thu2", buoi, ti:String(ti)},
    classList:{contains(){ return false; }}
  };
}

function loadConstraints(data, runtime = {}){
  const scheduleTimeout = runtime.setTimeout || setTimeout;
  const head = {appendChild(){}};
  const body = {appendChild(){}};
  const document = {
    head,
    body,
    readyState:"complete",
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    addEventListener(){},
    createElement(){
      return {
        id:"",
        textContent:"",
        style:{},
        classList:{add(){}, remove(){}, toggle(){}}
      };
    }
  };
  const window = {
    DATA:data,
    document,
    location:{search:""},
    __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    addEventListener(){},
    removeEventListener(){},
    setTimeout:scheduleTimeout,
    clearTimeout
  };
  if(runtime.performance) window.performance = runtime.performance;
  if(runtime.requestAnimationFrame) window.requestAnimationFrame = runtime.requestAnimationFrame;
  window.window = window;
  const context = {
    window,
    document,
    DATA:data,
    DAYS:["thu2"],
    LABEL:{thu2:"Thu 2"},
    SANG:5,
    CHIEU:5,
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    WeakMap,
    URLSearchParams,
    setTimeout:scheduleTimeout,
    clearTimeout
  };
  if(runtime.performance) context.performance = runtime.performance;
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename:CONSTRAINTS_PATH});
  assert.equal(typeof window.TKBConstraints?.canPlaceLesson, "function");
  window.TKBConstraints.__testHooks = window.__TKB_CONSTRAINTS_TEST_HOOKS;
  return window.TKBConstraints;
}

test("async full validation preserves results and yields between short slices", async () => {
  const data = constraintData(null);
  data.tkbConstraints.subject.Toan.byClass.L1.lessonBlocks = {2:{min:1}};
  data.tkbConstraints.teacher = {
    GV1:{mustTeach:{"thu2|chieu|4":true}}
  };
  let clock = 0;
  let scheduledYields = 0;
  const api = loadConstraints(data, {
    performance:{now(){ clock += 5; return clock; }},
    setTimeout(callback){
      scheduledYields += 1;
      return setTimeout(callback, 0);
    }
  });

  const syncResult = api.validateAll(100);
  const yieldsBeforeAsync = scheduledYields;
  const asyncResult = await api.validateAllAsync(100, {sliceBudgetMs:4});

  assert.equal(JSON.stringify(asyncResult), JSON.stringify(syncResult));
  assert.ok(scheduledYields > yieldsBeforeAsync, "async validation must yield back to the UI");
  assert.match(asyncResult.map(item => item.message).join("\n"), /s\u1ed1 bu\u1ed5i\/c\u1ee5m/);
  assert.match(asyncResult.map(item => item.message).join("\n"), /v\u1ecb tr\u00ed ph\u1ea3i c\u00f3 ti\u1ebft d\u1ea1y/);

  const cancelledResult = await api.validateAllAsync(100, {shouldCancel(){ return true; }});
  assert.equal(cancelledResult.cancelled, true);
});

test("async full validation honors cancellation at entry", async () => {
  const data = constraintData(null);
  data.tkb = {};
  data.tkbConstraints = {};
  let cancellationChecks = 0;
  const api = loadConstraints(data);

  const result = await api.validateAllAsync(100, {
    shouldCancel(){
      cancellationChecks += 1;
      return true;
    }
  });

  assert.equal(result.cancelled, true);
  assert.equal(cancellationChecks, 1);
});

test("async full validation checks cancellation while visiting empty and OFF slots", async () => {
  const data = constraintData(null);
  data.tkb = {
    L1:oneDayTkb(["", "OFF", "", "OFF", ""], ["OFF", "", "OFF", "", "OFF"])
  };
  data.tkbConstraints = {};
  let cancellationChecks = 0;
  const api = loadConstraints(data);

  const result = await api.validateAllAsync(100, {
    shouldCancel(){
      cancellationChecks += 1;
      return cancellationChecks >= 5;
    }
  });

  assert.equal(result.cancelled, true);
  assert.equal(cancellationChecks, 5);
});

test("must-teach validation reuses the shared schedule index", () => {
  const start = CONSTRAINTS_SOURCE.indexOf("function buildMustTeachTeacherIndex");
  const end = CONSTRAINTS_SOURCE.indexOf("function isSameSlotCell", start);
  assert.ok(start >= 0 && end > start, "must-teach index source must be extractable");
  const source = CONSTRAINTS_SOURCE.slice(start, end);

  assert.match(source, /buildScheduleIndex\(\)\.byTeacher/);
  assert.doesNotMatch(source, /D\(\)\.tkb|Object\.keys\(tkbs\)/);
});

test("teacher requirement tables show one assigned-period total independent of a partial timetable", () => {
  const data = constraintData(null);
  const api = loadConstraints(data);
  const hooks = api.__testHooks;
  assert.ok(hooks);
  const stats = hooks.teacherStats("GV1");
  assert.equal(stats.TS, 4, "one scheduled cell must not replace the four assigned periods");
  assert.equal(stats.days, 1);
  assert.equal(stats.sessions, 1);

  const html = hooks.teacherRuleTable("maxDaysSessions", [{id:"GV1", name:"GV1"}]);
  assert.match(html, /<th>Số tiết<\/th>/);
  assert.match(html, /<td class="rb-total">4<\/td>/);
  assert.doesNotMatch(html, /rb-stat-head|>Sáng<|>Chiều<|>Tổng</);
});

function constraintData(dayLimit){
  const maxPeriods = dayLimit == null ? {} : {day:{thu2:dayLimit}};
  return {
    lop:[{id:"L1", ten:"L1"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toan"}],
    mon:[{id:"Toan", khoi:"1", ten:"Toan", sotiet:"4", gioihan:"1"}],
    pccmMatrix:{"L1|Toan":"GV1"},
    pccmTietMatrix:{"L1|Toan":"4"},
    pccmGioihanMatrix:{"L1|Toan":"1"},
    tkb:{L1:oneDayTkb(["Toan"], [])},
    tkbConstraints:{
      subject:{Toan:{byClass:{L1:{maxPeriods}}}}
    }
  };
}

test("Phan cong gioihan is enforced per session, not across the whole day", () => {
  const acrossSessions = loadValidateDrop({
    tkb:oneDayTkb(["Toan"], []),
    gioihan:1
  });
  assert.equal(
    acrossSessions(targetCell("chieu", 0), "Toan").ok,
    true,
    "one morning period plus one afternoon period must be allowed when each session respects gioihan=1"
  );

  const sameSession = loadValidateDrop({
    tkb:oneDayTkb(["Toan"], []),
    gioihan:1
  });
  const blocked = sameSession(targetCell("sang", 1), "Toan");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "exceed session limit");
  assert.equal(blocked.confirmable, true);
  assert.equal(blocked.canRaiseSessionLimit, true);
  assert.equal(blocked.classId, "L1");
  assert.equal(blocked.limit, 1);
  assert.equal(blocked.used, 2);
  assert.equal(blocked.requestedLimit, 2);
});

test("same-subject lessons still have to be consecutive inside each session", () => {
  const validateDrop = loadValidateDrop({
    tkb:oneDayTkb(["Toan", "", "", "", ""], []),
    gioihan:2
  });
  assert.equal(validateDrop(targetCell("sang", 1), "Toan").ok, true);
  assert.equal(validateDrop(targetCell("sang", 2), "Toan").reason, "split block");
});

test("moving a lesson between morning and afternoon does not count it twice", () => {
  const tkb = oneDayTkb(["Toan"], []);
  const source = {dataset:{thu:"thu2", buoi:"sang", ti:"0"}};
  const validateDrop = loadValidateDrop({
    tkb,
    gioihan:1,
    dragData:{type:"pairTeacherCell", classId:"L1", from:source, val:"Toan", mon:"Toan"}
  });
  assert.equal(validateDrop(targetCell("chieu", 0), "Toan").ok, true);
});

test("subject maxPeriods.day remains the independent whole-day constraint", () => {
  const constrained = loadConstraints(constraintData(1));
  const blocked = constrained.canPlaceLesson({
    lopId:"L1",
    mon:"Toan",
    thu:"thu2",
    buoi:"chieu",
    ti:0,
    mode:"drag"
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.messages.join("\n"), /c(?:ả|áº£) ng(?:à|Ã )y|whole day/i);

  const withoutDayRequirement = loadConstraints(constraintData(null));
  const allowed = withoutDayRequirement.canPlaceLesson({
    lopId:"L1",
    mon:"Toan",
    thu:"thu2",
    buoi:"chieu",
    ti:0,
    mode:"drag"
  });
  assert.equal(
    allowed.ok,
    true,
    "pccmGioihanMatrix=1 must not silently become a whole-day limit"
  );
});

test("legacy checker and drag wrapper preserve the separated semantics", () => {
  const checkerStart = PHANMON_SOURCE.indexOf("function showTKBError");
  const checkerEnd = PHANMON_SOURCE.indexOf("function exportExcel", checkerStart);
  const checker = PHANMON_SOURCE.slice(checkerStart, checkerEnd);
  assert.doesNotMatch(checker, /seenDay|dayPositions|giới hạn ngày/i);
  assert.match(checker, /\["sang","chieu"\][\s\S]*getMonMeta\(mon\)\.gioihan/);

  const hookStart = CONSTRAINTS_SOURCE.indexOf("function installHooks");
  const hookEnd = CONSTRAINTS_SOURCE.indexOf("function debugCanPlace", hookStart);
  const hook = CONSTRAINTS_SOURCE.slice(hookStart, hookEnd);
  assert.match(hook, /dragType==='cell'\|\|dragType==='pairTeacherCell'/);
  assert.match(CONSTRAINTS_SOURCE, /dayLimitValue\(r,'maxPeriods\.day',thu\)/);
});

test("class and teacher drops confirm then persist a class-subject session override", () => {
  const helperStart = PHANMON_SOURCE.indexOf("function maybeRaiseSessionLimitForDrop");
  const helperEnd = PHANMON_SOURCE.indexOf("function buildReplaceConfirmText", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const calls = [];
  const context = {
    currentLop:"OTHER",
    getLopCanonById(id){ return id === "L1" ? "10A1" : id; },
    getMonShort(){ return "T"; },
    getGioiHanForClassMon(){ return 1; },
    getMonMeta(){ return {gioihan:1}; },
    confirm(message){ calls.push({kind:"confirm", message}); return true; },
    setClassSubjectSessionLimit(lop, mon, limit){ calls.push({kind:"set", lop, mon, limit}); return true; },
    showDropToast(){},
    _setStatus(){}
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(helperStart, helperEnd), context, {filename:PHANMON_PATH});
  const raised = context.maybeRaiseSessionLimitForDrop(
    targetCell("sang", 1),
    "Toan",
    {
      ok:false,
      reason:"exceed session limit",
      canRaiseSessionLimit:true,
      classId:"L1",
      limit:1,
      used:2,
      requestedLimit:2
    }
  );
  assert.equal(raised, true);
  assert.match(calls[0].message, /Yêu cầu môn học không thay đổi/);
  assert.deepEqual(calls[1], {kind:"set", lop:"10A1", mon:"Toan", limit:2});

  const classDropStart = PHANMON_SOURCE.indexOf("td.ondrop = (e)=>", PHANMON_SOURCE.indexOf("function bindCells"));
  const classDropEnd = PHANMON_SOURCE.indexOf("td.oncontextmenu", classDropStart);
  const classDrop = PHANMON_SOURCE.slice(classDropStart, classDropEnd);
  assert.match(classDrop, /maybeRaiseSessionLimitForDrop\(td,\s*dragMon,\s*res\)[\s\S]*res\s*=\s*validateDrop/);

  const teacherDropStart = PHANMON_SOURCE.indexOf("function pvApplySupportDrop");
  const teacherDropEnd = PHANMON_SOURCE.indexOf("function pvBindTeacherSupportDrag", teacherDropStart);
  const teacherDrop = PHANMON_SOURCE.slice(teacherDropStart, teacherDropEnd);
  assert.match(teacherDrop, /maybeRaiseSessionLimitForDrop\(td,\s*info\.mon,\s*res\)[\s\S]*res\s*=\s*pvValidateSupportDrop/);
});

test("standalone pccmGioihanMatrix overrides survive redundant-period pruning", () => {
  const pruneStart = PHANMON_SOURCE.indexOf("function pruneRedundantPccmPeriodMatrices");
  const pruneEnd = PHANMON_SOURCE.indexOf("function remapPlannerClassObjectMap", pruneStart);
  assert.ok(pruneStart >= 0 && pruneEnd > pruneStart);
  const data = {
    lop:[{id:"10A1", ten:"10A1", khoi:"Khoi 10"}],
    pccmTietMatrix:{},
    pccmGioihanMatrix:{"10A1|Toan":"2"}
  };
  const context = {
    DATA:data,
    classCanonFromLop(lop){ return lop.id; },
    extractKhoiNumber(){ return "10"; },
    _findTietChuanRow(){ return {sotiet:"4", gioihan:"1"}; }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(pruneStart, pruneEnd), context, {filename:PHANMON_PATH});
  assert.equal(context.pruneRedundantPccmPeriodMatrices(), false);
  assert.equal(data.pccmGioihanMatrix["10A1|Toan"], "2");

  const appSource = fs.readFileSync(path.resolve(__dirname, "..", "web", "app.js"), "utf8");
  const appPruneStart = appSource.indexOf("const pruneRedundantPccmPeriods");
  const appPruneEnd = appSource.indexOf("const clearObjIfNotEmpty", appPruneStart);
  const appPrune = appSource.slice(appPruneStart, appPruneEnd);
  assert.doesNotMatch(
    appPrune,
    /!periodMatrix\s*\|\|\s*!Object\.prototype\.hasOwnProperty\.call\(periodMatrix,\s*key\)/
  );
});
