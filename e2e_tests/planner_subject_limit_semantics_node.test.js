"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = process.env.TKB_PHANMON_PATH
  ? path.resolve(process.env.TKB_PHANMON_PATH)
  : path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
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
  assert.ok(
    asyncResult.some(item => item.kind === "subject.lessonBlocks.min"),
    "lesson-block Min debt needs a stable machine-readable kind"
  );
  const missingMustTeach = asyncResult.find(item => item.kind === "teacher.mustTeach.missing");
  assert.ok(missingMustTeach, "missing must-teach slots need a stable machine-readable kind");
  assert.equal(missingMustTeach.teacherId, "GV1");

  const cancelledResult = await api.validateAllAsync(100, {shouldCancel(){ return true; }});
  assert.equal(cancelledResult.cancelled, true);
});

test("full validation ignores only mathematically impossible lesson-block minima", async () => {
  const data = constraintData(null);
  data.tkbConstraints.subject.Toan.byClass.L1.lessonBlocks = {
    2:{min:1},
    3:{min:21}
  };
  const api = loadConstraints(data);

  const syncDebt = api.validateAll(100).filter(item => item.kind === "subject.lessonBlocks.min");
  const asyncDebt = (await api.validateAllAsync(100)).filter(item => item.kind === "subject.lessonBlocks.min");

  assert.equal(syncDebt.length, 1, "the feasible 2-period minimum must remain enforced");
  assert.equal(asyncDebt.length, 1, "sync and async validation must use the same feasibility guard");
  assert.match(syncDebt[0].message, /2 ti(?:ết|áº¿t|ÃƒÂ¡Ã‚ÂºÃ‚Â¿t)/i);
  assert.doesNotMatch(syncDebt[0].message, /Min 21/);
  assert.equal(JSON.stringify(asyncDebt), JSON.stringify(syncDebt));
});

test("lesson-block minima use assigned PCCM periods, not standard periods", async () => {
  const data = constraintData(null);
  data.monhoc.push({id:"Van", ma:"Van", ten:"Van"});
  data.mon.push({id:"Van", khoi:"1", ten:"Van", sotiet:"59", gioihan:"1"});
  data.pccmMatrix["L1|Van"] = "   ";
  data.pccmTietMatrix["L1|Van"] = "59";
  data.tkbConstraints.subject.Van = {byClass:{L1:{lessonBlocks:{3:{min:1}}}}};
  const api = loadConstraints(data);

  assert.equal(
    api.validateAll(100).filter(item => item.kind === "subject.lessonBlocks.min").length,
    0,
    "an unassigned subject must not create a false lesson-block violation"
  );
  assert.equal(
    (await api.validateAllAsync(100)).filter(item => item.kind === "subject.lessonBlocks.min").length,
    0,
    "sync and async guards must agree for an unassigned subject"
  );
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

test("lesson-block headers hold compact bulk inputs and fill only the currently rendered classes", () => {
  const api = loadConstraints(constraintData(null));
  const hooks = api.__testHooks;
  assert.ok(hooks);

  const html = hooks.renderSubjectRule("lessonBlocks");
  assert.doesNotMatch(html, /rb-lesson-block-fill-row|>Nhập nhanh</);
  assert.equal(
    (html.match(/class="rb-lesson-block-head"/g) || []).length,
    8,
    "each Min/Max heading needs one inline quick-fill control"
  );
  assert.match(
    html,
    /class="rb-lesson-block-head"><input[^>]*data-rb-lesson-block-fill="lessonBlocks\.2\.min"[^>]*><span>Min<\/span>/
  );
  assert.match(html, /class="rb-subject-compact-table rb-lesson-block-table"/);
  assert.match(
    html,
    /<colgroup><col class="rb-lesson-class-col"><col class="rb-lesson-period-col">/
  );
  assert.equal(
    (html.match(/class="rb-lesson-bound-col"/g) || []).length,
    8,
    "each Min/Max field needs one compact numeric column"
  );
  assert.equal(
    (html.match(/data-rb-lesson-block-fill=/g) || []).length,
    8,
    "Min and Max for 2, 3, 4, and 5 consecutive periods need bulk inputs"
  );

  const grade8 = {dataset:{cid:"8/1", path:"lessonBlocks.2.min"}, value:"7"};
  const grade9a = {dataset:{cid:"9/1", path:"lessonBlocks.2.min"}, value:""};
  const grade9b = {dataset:{cid:"9/2", path:"lessonBlocks.2.min"}, value:""};
  const otherColumn = {dataset:{cid:"9/1", path:"lessonBlocks.2.max"}, value:"4"};
  const grade9Root = {
    querySelectorAll(selector){
      assert.equal(selector, "[data-cid][data-path]");
      return [grade9a, grade9b, otherColumn];
    }
  };

  assert.equal(hooks.applyLessonBlockBulkFill(grade9Root, "lessonBlocks.2.min", "1"), 2);
  assert.equal(grade9a.value, "1");
  assert.equal(grade9b.value, "1");
  assert.equal(otherColumn.value, "4");
  assert.equal(grade8.value, "7", "a class outside the selected grade must remain untouched");
});

test("two-session and other subject requirement tables fill their wrapper", () => {
  const api = loadConstraints(constraintData(null));
  const hooks = api.__testHooks;
  assert.ok(hooks);

  [
    "sessionAllowed",
    "weeklySessionPeriods",
    "maxPeriods",
    "maxPeriodsDay",
    "maxSessions",
    "maxSubjects",
    "spacingDays"
  ].forEach(rule => {
    const html = hooks.renderSubjectRule(rule);
    assert.match(html, /<table class="rb-subject-full-table"/, `${rule} should fill its wrapper`);
    assert.doesNotMatch(html, /rb-subject-compact-table/);
  });

  ["globalLimit", "lessonBlocks"].forEach(rule => {
    assert.match(hooks.renderSubjectRule(rule), /<table class="[^"]*rb-subject-compact-table/);
  });
  ["noSameSession", "noSameDay"].forEach(rule => {
    assert.match(hooks.renderSubjectRule(rule), /class="table-wrap rb-nss-table"/);
  });

  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-subject-full-table\{width:100%;min-width:720px\}/,
    "full-width subject tables need a mobile scroll floor"
  );
  assert.match(CONSTRAINTS_SOURCE, /\.rb-subject-compact-table\{min-width:0\}/);
  assert.match(CONSTRAINTS_SOURCE, /\.rb-lesson-block-table\{table-layout:fixed;width:100%;min-width:820px\}/);
  assert.match(CONSTRAINTS_SOURCE, /\.rb-lesson-block-table col\.rb-lesson-class-col\{width:84px\}/);
  assert.match(CONSTRAINTS_SOURCE, /\.rb-lesson-block-table col\.rb-lesson-period-col\{width:64px\}/);
  assert.match(CONSTRAINTS_SOURCE, /\.rb-lesson-block-table col\.rb-lesson-bound-col\{width:auto\}/);
  assert.match(
    CONSTRAINTS_SOURCE,
    /tbody td:first-child,#\$\{PANEL_ID\} thead tr:first-child>th:first-child\{position:sticky;left:0;/
  );
  assert.doesNotMatch(
    CONSTRAINTS_SOURCE,
    /td:first-child,#\$\{PANEL_ID\} th:first-child\{position:sticky;/,
    "a Min/Max cell in the second header row must not be mistaken for the sticky class column"
  );
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-linked-days thead tr:first-child>th:nth-child\(2\),#\$\{PANEL_ID\} \.rb-linked-days tbody td:nth-child\(2\)/
  );
});

test("subject numeric cells reuse spreadsheet-style range copy and paste", () => {
  const start = CONSTRAINTS_SOURCE.indexOf("function rbNumKey");
  const end = CONSTRAINTS_SOURCE.indexOf("function bindBodyEvents", start);
  assert.ok(start >= 0 && end > start, "numeric-cell spreadsheet helpers must be extractable");

  let commits = 0;
  const makeCell = () => ({
    classList:{add(){},toggle(){}},
  });
  const makeInput = (r,c,value) => {
    const td = makeCell();
    const input = {
      value:String(value),
      dataset:{rbNumCell:"1",rbNumTable:"t0",rbNumR:String(r),rbNumC:String(c)},
      classList:{toggle(){}},
      matches(selector){ return selector === "input.rb-num-cell-input[data-rb-num-cell]"; },
      closest(selector){
        if(selector === "td") return td;
        return selector === "input.rb-num-cell-input[data-rb-num-cell]" ? input : null;
      }
    };
    return input;
  };
  const inputs = [
    makeInput(1,2,"1"),
    makeInput(1,3,"2"),
    makeInput(2,2,"3"),
    makeInput(2,3,"4")
  ];
  const root = {
    querySelectorAll(selector){
      return selector === "input.rb-num-cell-input[data-rb-num-cell]" ? inputs : [];
    },
    querySelector(){ return inputs[0]; },
    contains(){ return true; }
  };
  const context = {
    window:{getSelection(){ return {removeAllRanges(){}}; }},
    document:{getElementById(){ return root; },activeElement:inputs[0],addEventListener(){}},
    PANEL_ID:"panel",
    Set,
    Array,
    String,
    Number,
    Math,
    Object,
    saveCurrentFromUI(){ commits += 1; },
    scheduleRememberCurrentFormSignature(){}
  };
  vm.runInNewContext(`
    let rbNumSelection = new Set();
    let rbNumAnchor = null;
    let rbNumDragStart = null;
    let rbNumDragging = false;
    let rbNumBound = false;
    ${CONSTRAINTS_SOURCE.slice(start, end)}
    this.setSelection = infos => { rbNumSelection = new Set(infos.map(rbNumKey)); };
    this.buildCopyText = rbNumBuildCopyText;
    this.pasteMatrix = rbNumPasteMatrix;
    this.parseClipboard = rbNumParseClipboard;
    this.copySelection = rbNumGlobalCopy;
  `, context, {filename:CONSTRAINTS_PATH});

  const all = [
    {table:"t0",r:1,c:2},
    {table:"t0",r:1,c:3},
    {table:"t0",r:2,c:2},
    {table:"t0",r:2,c:3}
  ];
  context.setSelection(all);
  assert.equal(context.buildCopyText(), "1\t2\n3\t4");
  let copied = "";
  const gridCopyEvent = {
    target:inputs[0],
    clipboardData:{setData(type,value){ assert.equal(type,"text/plain"); copied=value; }},
    preventDefault(){ this.prevented=true; }
  };
  context.copySelection(gridCopyEvent);
  assert.equal(copied, "1\t2\n3\t4");
  assert.equal(gridCopyEvent.prevented, true);

  const quickInput = {matches(){return false;},closest(){return null;}};
  const nativeCopyEvent = {
    target:quickInput,
    clipboardData:{setData(){ throw new Error("quick-fill input copy must stay native"); }},
    preventDefault(){ this.prevented=true; }
  };
  context.document.activeElement=quickInput;
  context.copySelection(nativeCopyEvent);
  assert.equal(nativeCopyEvent.prevented, undefined);
  context.document.activeElement=inputs[0];

  context.pasteMatrix([["7"]]);
  assert.deepEqual(inputs.map(input => input.value), ["7","7","7","7"]);
  assert.equal(commits, 1);

  context.setSelection([{table:"t0",r:1,c:2}]);
  context.pasteMatrix(context.parseClipboard("8\t9\n10\t11\n"));
  assert.deepEqual(inputs.map(input => input.value), ["8","9","10","11"]);
  assert.equal(commits, 2);
});

test("mobile constraint pages reserve the portrait safe area and give subject tables real scroll space", () => {
  assert.match(
    CONSTRAINTS_SOURCE,
    /@media \(max-width:860px\) and \(orientation:portrait\)\{[\s\S]*?padding-top:env\(safe-area-inset-top,0px\);[\s\S]*?padding-bottom:env\(safe-area-inset-bottom,0px\)/
  );
  assert.match(CONSTRAINTS_SOURCE, /body\.dataset\.rbSection=state\.section \|\| 'dashboard'/);
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-content\[data-rb-section="subject"\][\s\S]*?display:flex;flex-direction:column;min-height:0;overflow:hidden/
  );
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-content\[data-rb-section="subject"\] > \.table-wrap[\s\S]*?flex:1 1 auto;min-height:0;max-height:none;overflow:auto;[\s\S]*?touch-action:pan-x pan-y/
  );
});

test("coarse-pointer requirement grids support swipe, long-press, and double-tap actions", () => {
  const start = CONSTRAINTS_SOURCE.indexOf("function isConstraintGridTouchPointer");
  const end = CONSTRAINTS_SOURCE.indexOf("function teacherMustTeachTopTable", start);
  assert.ok(start >= 0 && end > start, "shared constraint-grid gesture controller must be extractable");
  const gestureSource = CONSTRAINTS_SOURCE.slice(start, end);

  assert.match(CONSTRAINTS_SOURCE, /CONSTRAINT_GRID_LONG_PRESS_MS\s*=\s*550/);
  assert.match(CONSTRAINTS_SOURCE, /CONSTRAINT_GRID_DOUBLE_TAP_MS\s*=\s*380/);
  assert.match(gestureSource, /pointerType==='touch'\s*\|\|\s*pointerType==='pen'/);
  assert.match(gestureSource, /document\.elementFromPoint/);
  assert.match(gestureSource, /selectMustTeachRange\(meta\.slot,false\)/);
  assert.match(gestureSource, /selectFixedOffRange\(meta\.slot,false\)/);
  assert.match(gestureSource, /applyMustTeachSelectedSlots\(true\)/);
  assert.match(gestureSource, /applyMustTeachSelectedSlots\(\)/);
  assert.match(gestureSource, /applyFixedOffSelectedSlots\(meta\.type,meta\.id,true\)/);
  assert.match(gestureSource, /handleMobileFixedRequirementDoubleTap\(gesture\.captureCell,gesture\)/);
  assert.match(gestureSource, /scheduleConstraintGridLongPress\(gesture\)/);
  assert.match(CONSTRAINTS_SOURCE, /bindConstraintGridTouchGestures\(root\);/);
  assert.match(
    CONSTRAINTS_SOURCE,
    /@media \(any-pointer:coarse\)\{[\s\S]*?td\[data-fo-toggle\],[\s\S]*?td\[data-mt-toggle\]\{touch-action:none;-webkit-touch-callout:none\}/
  );
});

function loadConstraintGridGestureHarness(){
  const start = CONSTRAINTS_SOURCE.indexOf("function isConstraintGridTouchPointer");
  const end = CONSTRAINTS_SOURCE.indexOf("function teacherMustTeachTopTable", start);
  assert.ok(start >= 0 && end > start, "shared constraint-grid gesture controller must be extractable");

  const listeners = new Map();
  const timers = new Map();
  const calls = {
    mustSingle:[],
    fixedSingle:[],
    mustRange:[],
    fixedRange:[],
    mustApply:[],
    fixedApply:[],
    fixedDouble:[]
  };
  let now = 1000;
  let nextTimerId = 1;
  let pointTarget = null;
  let mustSlots = [];
  let fixedSlots = [];
  let mustAnchor = "";
  let fixedAnchor = "";
  const root = {querySelectorAll(){ return []; }};
  const document = {
    getElementById(){ return root; },
    elementFromPoint(){ return pointTarget; },
    addEventListener(type, handler){
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    }
  };
  const context = {
    window:{matchMedia(){ return {matches:true}; }},
    document,
    Date:{now(){ return now; }},
    Math,
    Object,
    String,
    Number,
    clearTimeout(id){ timers.delete(id); },
    setTimeout(handler, delay){
      const id = nextTimerId++;
      timers.set(id, {handler,delay});
      return id;
    },
    PANEL_ID:"panel",
    mustTeachSelectedSlots(){ return mustSlots; },
    fixedOffSelectedSlots(){ return fixedSlots; },
    setMustTeachSingleSlot(slot){
      mustSlots = slot ? [String(slot)] : [];
      mustAnchor = String(slot || "");
      calls.mustSingle.push(String(slot || ""));
    },
    setFixedOffSingleSlot(slot){
      fixedSlots = slot ? [String(slot)] : [];
      fixedAnchor = String(slot || "");
      calls.fixedSingle.push(String(slot || ""));
    },
    selectMustTeachRange(slot){
      calls.mustRange.push(String(slot || ""));
      mustSlots = Array.from(new Set([mustAnchor,String(slot || "")].filter(Boolean)));
    },
    selectFixedOffRange(slot){
      calls.fixedRange.push(String(slot || ""));
      fixedSlots = Array.from(new Set([fixedAnchor,String(slot || "")].filter(Boolean)));
    },
    refreshMustTeachSelection(){},
    refreshFixedOffSelection(){},
    applyMustTeachSelectedSlots(checked){ calls.mustApply.push(checked); return true; },
    applyFixedOffSelectedSlots(type,id,checked){ calls.fixedApply.push({type,id,checked}); return true; },
    handleMobileFixedRequirementDoubleTap(cell,meta){ calls.fixedDouble.push({cell,slot:meta.slot,type:meta.type,id:meta.id}); return true; }
  };
  const gestureSource = CONSTRAINTS_SOURCE.slice(start, end);
  vm.runInNewContext(`
    const CONSTRAINT_GRID_LONG_PRESS_MS = 550;
    const CONSTRAINT_GRID_DOUBLE_TAP_MS = 380;
    let constraintGridTouchGesture = null;
    let constraintGridLastTap = null;
    let constraintGridTouchBound = false;
    let constraintGridSuppressClickUntil = 0;
    let constraintGridSuppressContextUntil = 0;
    ${gestureSource}
  `, context, {filename:CONSTRAINTS_PATH});

  function cell(kind, slot, options = {}){
    const isMust = kind === "mustTeach";
    const dataset = isMust
      ? {mtToggle:"1", mtId:String(options.id || "GV1"), slot:String(slot)}
      : {foToggle:"1", offType:String(options.type || "class"), offId:String(options.id || "L1"), slot:String(slot)};
    return {
      dataset,
      captures:[],
      releases:[],
      matches(selector){ return isMust ? selector.includes("[data-mt-toggle]") : selector.includes("[data-fo-toggle]"); },
      closest(selector){
        const matches = isMust ? selector.includes("[data-mt-toggle]") : selector.includes("[data-fo-toggle]");
        return matches ? this : null;
      },
      setPointerCapture(pointerId){ this.captures.push(pointerId); },
      releasePointerCapture(pointerId){ this.releases.push(pointerId); }
    };
  }
  function pointer(cellTarget, options = {}){
    return {
      currentTarget:cellTarget,
      target:cellTarget,
      pointerType:options.pointerType || "touch",
      pointerId:options.pointerId == null ? 1 : options.pointerId,
      isPrimary:options.isPrimary == null ? true : options.isPrimary,
      button:options.button == null ? 0 : options.button,
      clientX:options.clientX || 0,
      clientY:options.clientY || 0,
      type:options.type || '',
      cancelable:true,
      prevented:false,
      preventDefault(){ this.prevented = true; },
      stopImmediatePropagation(){ this.stopped = true; }
    };
  }
  return {
    context,
    calls,
    cell,
    pointer,
    setPointTarget(target){ pointTarget = target; },
    advanceTime(ms){ now += Number(ms || 0); },
    setMustSlots(slots){ mustSlots = slots.slice(); mustAnchor = mustSlots[0] || ""; },
    setFixedSlots(slots){ fixedSlots = slots.slice(); fixedAnchor = fixedSlots[0] || ""; },
    getMustSlots(){ return mustSlots.slice(); },
    getFixedSlots(){ return fixedSlots.slice(); },
    timerCount(){ return timers.size; },
    runLastTimer(){
      const entry = Array.from(timers.entries()).at(-1);
      assert.ok(entry, "a long-press timer must be pending");
      const [id,timer] = entry;
      timers.delete(id);
      timer.handler();
      return timer.delay;
    },
    dispatch(type,event){ (listeners.get(type) || []).forEach(handler=>handler(event)); }
  };
}

test("touch swipe selects a range, hold applies must-teach, and a regular tap stays a click", () => {
  const harness = loadConstraintGridGestureHarness();
  const slotA = "thu2|sang|0";
  const slotB = "thu3|sang|1";
  const cellA = harness.cell("mustTeach", slotA);
  const cellB = harness.cell("mustTeach", slotB);
  harness.context.ensureConstraintGridTouchHandlers();

  harness.context.beginConstraintGridTouch(harness.pointer(cellA, {pointerType:"mouse"}));
  assert.deepEqual(harness.getMustSlots(), [], "a fine mouse pointer must keep the desktop click path untouched");
  assert.equal(harness.timerCount(), 0);

  const tapDown = harness.pointer(cellA, {pointerId:2});
  harness.context.beginConstraintGridTouch(tapDown);
  assert.equal(tapDown.prevented, false, "pointerdown must not suppress the regular tap/click sequence");
  assert.deepEqual(harness.getMustSlots(), [slotA]);
  harness.context.endConstraintGridTouch(harness.pointer(cellA, {pointerId:2}));
  assert.equal(harness.timerCount(), 0);
  assert.deepEqual(harness.calls.mustApply, [], "lifting before the threshold must not apply X");
  const tapClick = harness.pointer(cellA, {pointerId:2});
  harness.dispatch("click", tapClick);
  assert.equal(tapClick.prevented, false, "the click following a regular tap must reach the existing handler");

  harness.context.beginConstraintGridTouch(harness.pointer(cellA, {pointerId:3}));
  harness.setPointTarget(cellB);
  const move = harness.pointer(cellA, {pointerId:3,clientX:24,clientY:12});
  harness.context.moveConstraintGridTouch(move);
  assert.equal(move.prevented, true, "an active swipe owns movement inside the grid");
  assert.equal(harness.calls.mustRange.at(-1), slotB);
  assert.deepEqual(harness.getMustSlots(), [slotA,slotB]);
  assert.equal(harness.runLastTimer(), 550, "holding after the swipe uses the documented long-press threshold");
  assert.deepEqual(harness.calls.mustApply, [true]);
});

test("mobile double-tap toggles must-teach and routes fixed requirements to the mobile action", () => {
  const harness = loadConstraintGridGestureHarness();
  const mustSlot = "thu2|sang|0";
  const mustCell = harness.cell("mustTeach", mustSlot);
  harness.context.ensureConstraintGridTouchHandlers();

  const tap = (cell, pointerId, gapBefore = 0) => {
    harness.advanceTime(gapBefore);
    harness.context.beginConstraintGridTouch(harness.pointer(cell, {pointerId}));
    harness.advanceTime(30);
    harness.context.endConstraintGridTouch(harness.pointer(cell, {pointerId,type:"pointerup"}));
    const click = harness.pointer(cell, {pointerId});
    harness.dispatch("click", click);
    return click;
  };

  const firstClick = tap(mustCell, 10);
  assert.equal(firstClick.prevented, false, "one tap must keep the normal single-cell selection path");
  assert.deepEqual(harness.calls.mustApply, []);
  const secondClick = tap(mustCell, 11, 120);
  assert.equal(secondClick.prevented, true, "the synthetic click after a handled double-tap must be suppressed");
  assert.deepEqual(harness.calls.mustApply, [undefined], "the first double-tap uses must-teach toggle semantics");

  tap(mustCell, 12, 120);
  tap(mustCell, 13, 120);
  assert.deepEqual(harness.calls.mustApply, [undefined,undefined], "the next double-tap toggles the same cell again");

  const expired = loadConstraintGridGestureHarness();
  const expiredCell = expired.cell("mustTeach", mustSlot);
  expired.context.beginConstraintGridTouch(expired.pointer(expiredCell, {pointerId:20}));
  expired.context.endConstraintGridTouch(expired.pointer(expiredCell, {pointerId:20,type:"pointerup"}));
  expired.advanceTime(381);
  expired.context.beginConstraintGridTouch(expired.pointer(expiredCell, {pointerId:21}));
  expired.context.endConstraintGridTouch(expired.pointer(expiredCell, {pointerId:21,type:"pointerup"}));
  assert.deepEqual(expired.calls.mustApply, [], "two taps outside the threshold must not toggle the requirement");

  const fixed = loadConstraintGridGestureHarness();
  const fixedCell = fixed.cell("fixedOff", "thu3|sang|1", {type:"class",id:"L1"});
  fixed.context.beginConstraintGridTouch(fixed.pointer(fixedCell, {pointerId:30}));
  fixed.context.endConstraintGridTouch(fixed.pointer(fixedCell, {pointerId:30,type:"pointerup"}));
  fixed.advanceTime(120);
  fixed.context.beginConstraintGridTouch(fixed.pointer(fixedCell, {pointerId:31}));
  fixed.context.endConstraintGridTouch(fixed.pointer(fixedCell, {pointerId:31,type:"pointerup"}));
  assert.equal(fixed.calls.fixedDouble.length, 1);
  assert.equal(fixed.calls.fixedDouble[0].slot, "thu3|sang|1");
  assert.deepEqual(fixed.calls.fixedApply, [], "fixed double-tap must use its menu/delete action, not long-press X");

  const fixedMenuStart = CONSTRAINTS_SOURCE.indexOf("function openClassFixedLessonSubjectMenu");
  const fixedMenuEnd = CONSTRAINTS_SOURCE.indexOf("function openFixedLessonMenuFromCell", fixedMenuStart);
  const fixedMenuSource = CONSTRAINTS_SOURCE.slice(fixedMenuStart, fixedMenuEnd);
  assert.ok(fixedMenuStart >= 0 && fixedMenuEnd > fixedMenuStart);
  assert.ok(
    fixedMenuSource.indexOf("items.push({label:'Nghỉ'") < fixedMenuSource.indexOf("items.push(...subjects.map"),
    "Nghỉ must be the first mobile option before fixed subjects"
  );
  assert.match(fixedMenuSource, /fixedRequirementCellHasValue[\s\S]*?clearFixedOffSelectedSlots/);
  assert.match(fixedMenuSource, /includeOffFirst:true/);

  const visibleStateStart = CONSTRAINTS_SOURCE.indexOf("function fixedRequirementCellHasValue");
  const visibleStateEnd = CONSTRAINTS_SOURCE.indexOf("function openClassFixedLessonSubjectMenu", visibleStateStart);
  const visibleStateSource = CONSTRAINTS_SOURCE.slice(visibleStateStart, visibleStateEnd);
  assert.match(visibleStateSource, /fixedOffSlotChecked\(type,id,/);
  assert.doesNotMatch(
    visibleStateSource,
    /fixedOffApplyIds/,
    "double-tap intent must follow the visible primary cell, not a hidden selected row"
  );
});

test("fixed requirement popup stays inside the visual viewport", () => {
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-menu-pop\{[^}]*max-width:calc\(100vw - 8px\);max-height:calc\(100vh - 8px\);overflow:auto;overscroll-behavior:contain/
  );
  const start = CONSTRAINTS_SOURCE.indexOf("function positionRbMenuPopup");
  const end = CONSTRAINTS_SOURCE.indexOf("function buildMenuPopup", start);
  assert.ok(start >= 0 && end > start, "popup positioning helper must be extractable");
  const context = {
    window:{visualViewport:{offsetLeft:0,offsetTop:0,width:320,height:480},innerWidth:320,innerHeight:480},
    Math,
    Number
  };
  vm.runInNewContext(
    `${CONSTRAINTS_SOURCE.slice(start, end)}\nthis.positionPopup = positionRbMenuPopup;`,
    context
  );
  const popup = {
    style:{},
    getBoundingClientRect(){ return {width:260,height:300}; }
  };
  context.positionPopup(popup,300,460);
  assert.equal(popup.style.left,"56px");
  assert.equal(popup.style.top,"176px");
  assert.equal(popup.style.maxWidth,"312px");
  assert.equal(popup.style.maxHeight,"472px");
});

function fixedLessonMultiplicityData({filled = false} = {}){
  const subject = "HDTN";
  const schedule = () => oneDayTkb(filled ? [subject,subject,subject] : [], []);
  return {
    lop:[
      {id:"L1", ten:"7/1", khoi:"7"},
      {id:"L2", ten:"7/2", khoi:"7"}
    ],
    monhoc:[{id:subject, ma:subject, ten:"Hoat dong trai nghiem huong nghiep"}],
    mon:[{id:subject, ma:subject, ten:"Hoat dong trai nghiem huong nghiep", khoi:"7", sotiet:"3"}],
    pccmMatrix:{"L1|HDTN":"GV1", "L2|HDTN":"GV2"},
    // Redundant per-class overrides are intentionally pruned in production
    // when they equal the grade's standard-period value.
    pccmTietMatrix:{},
    tkb:{L1:schedule(), L2:schedule()},
    tkbConstraints:{}
  };
}

function fixedSubjectSlots(data, classId, subject = "HDTN"){
  const out=[];
  Object.entries(data.tkb[classId] || {}).forEach(([thu,day])=>{
    ["sang","chieu"].forEach(buoi=>{
      (day?.[buoi] || []).forEach((cell,ti)=>{
        if(cell && typeof cell === "object" && cell.fixed === true && cell.mon === subject){
          out.push(`${thu}|${buoi}|${ti}`);
        }
      });
    });
  });
  return out.sort();
}

test("three fixed slots of one subject survive when redundant PCCM period overrides are absent", () => {
  const data = fixedLessonMultiplicityData();
  const hooks = loadConstraints(data).__testHooks;

  assert.equal(hooks.classSubjectRequiredCount("L1","HDTN"), 3);
  assert.equal(hooks.classSubjectRequiredCount("L2","HDTN"), 3);
  for(const classId of ["L1","L2"]){
    assert.equal(hooks.setClassFixedLesson(classId,"thu2","sang",0,"HDTN"), true);
    assert.equal(hooks.setClassFixedLesson(classId,"thu2","sang",1,"HDTN"), true);
    assert.equal(hooks.setClassFixedLesson(classId,"thu2","sang",2,"HDTN"), true);
    assert.deepEqual(
      fixedSubjectSlots(data,classId),
      ["thu2|sang|0","thu2|sang|1","thu2|sang|2"],
      "placing the next fixed lesson must not erase an earlier fixed slot"
    );
  }
});

test("fixed placement moves only ordinary lessons and refuses a fourth fixed anchor", () => {
  const data = fixedLessonMultiplicityData({filled:true});
  const hooks = loadConstraints(data).__testHooks;

  assert.equal(hooks.setClassFixedLesson("L1","thu2","chieu",0,"HDTN"), true);
  assert.equal(hooks.setClassFixedLesson("L1","thu2","chieu",1,"HDTN"), true);
  assert.equal(hooks.setClassFixedLesson("L1","thu2","chieu",2,"HDTN"), true);
  assert.equal(hooks.countClassSubjectPlaced("L1","HDTN"), 3, "moving ordinary lessons must preserve demand");
  assert.deepEqual(
    fixedSubjectSlots(data,"L1"),
    ["thu2|chieu|0","thu2|chieu|1","thu2|chieu|2"]
  );

  assert.equal(hooks.setClassFixedLesson("L1","thu2","chieu",3,"HDTN"), false);
  assert.equal(hooks.countClassSubjectPlaced("L1","HDTN"), 3);
  assert.deepEqual(
    fixedSubjectSlots(data,"L1"),
    ["thu2|chieu|0","thu2|chieu|1","thu2|chieu|2"],
    "a rejected fourth anchor must leave all three existing fixed lessons intact"
  );
  assert.equal(data.tkb.L1.thu2.chieu[3], "");
});

test("fixed placement never overwrites another lesson or hard anchor", () => {
  const data = fixedLessonMultiplicityData({filled:true});
  data.tkb.L1.thu2.chieu[0] = "TOAN";
  data.tkb.L1.thu2.chieu[1] = {mon:"VAN", fixed:true};
  const hooks = loadConstraints(data).__testHooks;

  assert.equal(hooks.setClassFixedLesson("L1","thu2","chieu",0,"HDTN"), false);
  assert.equal(hooks.setClassFixedLesson("L1","thu2","chieu",1,"HDTN"), false);
  assert.equal(data.tkb.L1.thu2.chieu[0], "TOAN");
  assert.deepEqual(data.tkb.L1.thu2.chieu[1], {mon:"VAN", fixed:true});
  assert.equal(hooks.countClassSubjectPlaced("L1","HDTN"), 3);
});

test("unknown subject demand cannot create unbounded fixed lessons", () => {
  const data = fixedLessonMultiplicityData();
  data.mon = [];
  const hooks = loadConstraints(data).__testHooks;

  assert.equal(hooks.classSubjectRequiredCount("L1","HDTN"), 0);
  for(let ti=0; ti<5; ti++){
    assert.equal(hooks.setClassFixedLesson("L1","thu2","sang",ti,"HDTN"), false);
  }
  assert.deepEqual(fixedSubjectSlots(data,"L1"), []);
});

test("fixed-class header total stays on assigned periods after lessons are fixed", () => {
  const data = fixedLessonMultiplicityData();
  data.monhoc.push({id:"TOAN", ma:"TOAN", ten:"Toan"});
  data.mon.push({id:"TOAN", ma:"TOAN", ten:"Toan", khoi:"7", sotiet:"4"});
  data.pccmMatrix["L1|TOAN"] = "GV3";
  const hooks = loadConstraints(data).__testHooks;

  assert.equal(hooks.fixedOffTopRows("class","L1").total, 7);
  assert.equal(hooks.setClassFixedLesson("L1","thu2","sang",0,"HDTN"), true);
  assert.equal(hooks.setClassFixedLesson("L1","thu2","sang",1,"HDTN"), true);
  assert.equal(fixedSubjectSlots(data,"L1").length, 2);
  assert.equal(
    hooks.fixedOffTopRows("class","L1").total,
    7,
    "the title must show PCCM demand rather than the two currently fixed cells"
  );
});

test("fixed teacher requirements preserve the teacher order used by assignments", () => {
  const data = fixedLessonMultiplicityData();
  data.giaovien = [
    {magv:"GV-Z", ten:"Teacher Z"},
    {magv:"GV-A", ten:"Teacher A"},
    {magv:"GV-M", ten:"Teacher M"}
  ];
  data.pccmMatrix = {
    "L1|HDTN":"GV-A",
    "L2|HDTN":"GV-LEGACY"
  };
  const hooks = loadConstraints(data).__testHooks;

  assert.deepEqual(
    hooks.getTeacherList().map(item=>item.id),
    ["GV-Z","GV-A","GV-M","GV-LEGACY"],
    "fixed teacher requirements must follow Phan cong order before legacy-only teachers"
  );
});

test("fixed-off long press preserves a multi-selection, applies X, and suppresses the touch menu", () => {
  const harness = loadConstraintGridGestureHarness();
  const slotA = "thu2|sang|0";
  const slotB = "thu3|sang|1";
  const cellA = harness.cell("fixedOff", slotA, {type:"teacher",id:"GV1"});
  harness.setFixedSlots([slotA,slotB]);
  harness.context.ensureConstraintGridTouchHandlers();
  harness.context.beginConstraintGridTouch(harness.pointer(cellA, {pointerId:4}));

  assert.deepEqual(harness.getFixedSlots(), [slotA,slotB], "pressing inside the selected range must not collapse it");
  assert.deepEqual(harness.calls.fixedSingle, []);
  const menuWhilePressed = harness.pointer(cellA, {pointerId:4});
  harness.dispatch("contextmenu", menuWhilePressed);
  assert.equal(menuWhilePressed.prevented, true, "the native context menu must stay closed during a long press");

  assert.equal(harness.runLastTimer(), 550);
  assert.deepEqual(harness.calls.fixedApply, [{type:"teacher",id:"GV1",checked:true}]);
  assert.deepEqual(harness.getFixedSlots(), [slotA,slotB]);
  const menuAfterApply = harness.pointer(cellA, {pointerId:4});
  harness.dispatch("contextmenu", menuAfterApply);
  assert.equal(menuAfterApply.prevented, true, "the delayed context menu must also be suppressed after X is applied");
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

test("class capacity ignores period metadata for subjects without an assigned teacher", () => {
  const data = constraintData(null);
  data.monhoc.push({id:"Van", ma:"Van", ten:"Van"});
  data.mon.push({id:"Van", khoi:"1", ten:"Van", sotiet:"59", gioihan:"1"});
  data.pccmMatrix["L1|Van"] = "   ";
  data.pccmTietMatrix["L1|Van"] = "59";

  const api = loadConstraints(data);

  assert.equal(
    api.classFixedOffCapacityWarnings().length,
    0,
    "an unassigned subject must not create a false class-capacity shortage"
  );
});

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

test("planner sanitizer preserves authored PCCM periods even when they equal standards", () => {
  const pruneStart = PHANMON_SOURCE.indexOf("function pruneRedundantPccmPeriodMatrices");
  const pruneEnd = PHANMON_SOURCE.indexOf("function remapPlannerClassObjectMap", pruneStart);
  assert.ok(pruneStart >= 0 && pruneEnd > pruneStart);
  const data = {
    lop:[{id:"10A1", ten:"10A1", khoi:"Khoi 10"}],
    pccmTietMatrix:{"10A1|Toan":"4"},
    pccmGioihanMatrix:{"10A1|Toan":"1"}
  };
  const context = {
    DATA:data,
    classCanonFromLop(lop){ return lop.id; },
    extractKhoiNumber(){ return "10"; },
    _findTietChuanRow(){ return {sotiet:"4", gioihan:"1"}; }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(pruneStart, pruneEnd), context, {filename:PHANMON_PATH});
  assert.equal(context.pruneRedundantPccmPeriodMatrices(), false);
  assert.equal(data.pccmTietMatrix["10A1|Toan"], "4");
  assert.equal(data.pccmGioihanMatrix["10A1|Toan"], "1");

  const appSource = fs.readFileSync(path.resolve(__dirname, "..", "web", "app.js"), "utf8");
  assert.doesNotMatch(appSource, /const pruneRedundantPccmPeriods/);
  assert.match(appSource, /const initializeAssignedPccmPeriods/);
});
